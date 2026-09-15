use crate::{
    commands::validate_command,
    config::{
        DesktopConfigStore, DesktopSettingsInput, DesktopSettingsStatus, RoomSessionStore,
        SiteCredentialStore, StoredRoomSession,
    },
    contracts::{CommandAck, DesktopCommand, MediaDirectoryPage, MediaSource},
    http::DesktopHttpTransport,
    launch::DesktopLaunch,
    libmpv::LibMpvConfig,
    runtime::{DesktopRuntime, NativeRuntimeConfig, NativeSiteCredentials, RuntimeError},
    transport::RoomTransport,
};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[allow(non_snake_case)]
#[tauri::command]
pub fn listOriginTrust(app: AppHandle) -> Result<Vec<crate::config::OriginTrustRecord>, String> {
    crate::config::OriginTrustStore::new(app.path().app_data_dir().map_err(|_|"Trust storage unavailable")?).list().map_err(|_|"Trust storage unavailable".into())
}
#[allow(non_snake_case)]
#[tauri::command]
pub fn importOriginTrust(app: AppHandle, origin: String, pem: String) -> Result<crate::config::OriginTrustRecord, String> {
    crate::config::OriginTrustStore::new(app.path().app_data_dir().map_err(|_|"Trust storage unavailable")?).import(&origin, &pem).map_err(|_|"Certificate trust could not be saved".into())
}
#[allow(non_snake_case)]
#[tauri::command]
pub fn deleteOriginTrust(app: AppHandle, origin: String) -> Result<(), String> {
    crate::config::OriginTrustStore::new(app.path().app_data_dir().map_err(|_|"Trust storage unavailable")?).delete(&origin).map_err(|_|"Certificate trust could not be deleted".into())
}

/// Managed Tauri state. The renderer receives neither the runtime config nor its credentials.
pub struct TauriDesktopState {
    runtime: Mutex<Option<Arc<DesktopRuntime>>>,
    configuration_change: Mutex<()>,
    configured: AtomicBool,
    app_handle: AppHandle,
    player: LibMpvConfig,
    config_store: DesktopConfigStore,
    credential_store: SiteCredentialStore,
    room_store: RoomSessionStore,
    shutdown_started: AtomicBool,
    /// Latest accepted deep-link launch. Persisted here so the renderer can
    /// replay it after its event listeners register (cold-start deep links are
    /// emitted before React mounts).
    launch: Mutex<Option<DesktopLaunch>>,
}

impl TauriDesktopState {
    pub fn new(
        runtime: Option<DesktopRuntime>,
        configured: bool,
        config_store: DesktopConfigStore,
        credential_store: SiteCredentialStore,
        room_store: RoomSessionStore,
        app_handle: AppHandle,
        player: LibMpvConfig,
    ) -> Self {
        Self {
            runtime: Mutex::new(runtime.map(Arc::new)),
            configuration_change: Mutex::new(()),
            configured: AtomicBool::new(configured),
            app_handle,
            player,
            config_store,
            credential_store,
            room_store,
            shutdown_started: AtomicBool::new(false),
            launch: Mutex::new(None),
        }
    }

    pub fn runtime(&self) -> Result<Arc<DesktopRuntime>, RuntimeError> {
        if !self.configured.load(Ordering::Acquire) {
            return Err(RuntimeError::not_configured());
        }
        self.runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(RuntimeError::runtime_unavailable)
    }

    pub fn runtime_for_shutdown(&self) -> Option<Arc<DesktopRuntime>> {
        self.runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn runtime_from_settings(
        &self,
        settings: &crate::config::DesktopSettings,
    ) -> Result<DesktopRuntime, RuntimeError> {
        let origin = settings
            .backend_origin
            .clone()
            .ok_or_else(RuntimeError::not_configured)?;
        let credentials = settings
            .backend_origin
            .as_deref()
            .map(|origin| self.credential_store.read(origin))
            .transpose()
            .map_err(|_| RuntimeError::credential_error())?
            .flatten()
            .map(NativeSiteCredentials::from_stored)
            .transpose()?;
        let trust_store = crate::config::OriginTrustStore::new(
            self.app_handle.path().app_data_dir().map_err(|_| RuntimeError::configuration_error())?,
        );
        let tls_ca_file = trust_store.ca_file_for(&origin).map_err(|_| RuntimeError::configuration_error())?;
        let config = NativeRuntimeConfig::with_player(
            origin,
            credentials,
            self.player
                .clone()
                .with_preferences(settings.player_preferences.clone())
                .with_tls_ca_file(tls_ca_file),
        )?
        .with_owner_token_persistence(owner_token_persist_hook(
            self.room_store,
            settings.backend_origin.clone(),
        ));
        let app_handle = self.app_handle.clone();
        let room_store = self.room_store;
        let room_origin = settings.backend_origin.clone();
        DesktopRuntime::spawn(config, move |event| {
            clear_expired_room(&room_store, room_origin.as_deref(), &event);
            let _ = app_handle.emit(crate::commands::DESKTOP_STATE_EVENT, event);
        })
    }

    fn rebuild_runtime(
        &self,
        settings: &crate::config::DesktopSettings,
    ) -> Result<(), RuntimeError> {
        let new_runtime = settings
            .backend_origin
            .as_ref()
            .map(|_| self.runtime_from_settings(settings))
            .transpose();
        // Credential changes cannot keep a transport containing the old secret on failure.
        match new_runtime {
            Ok(runtime) => {
                self.replace_runtime(runtime, settings.backend_origin.is_some());
                Ok(())
            }
            Err(error) => {
                self.replace_runtime(None, settings.backend_origin.is_some());
                Err(error)
            }
        }
    }

    fn replace_runtime(&self, new_runtime: Option<DesktopRuntime>, configured: bool) {
        crate::runtime::replace_runtime_slot(&self.runtime, new_runtime, || {
            *self
                .launch
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            let _ = self.app_handle.emit("desktop://session-reset", ());
        });
        self.configured.store(configured, Ordering::Release);
    }

    pub fn settings_status(&self) -> Result<DesktopSettingsStatus, RuntimeError> {
        let settings = self
            .config_store
            .load()
            .map_err(|_| RuntimeError::configuration_error())?;
        let credentials_configured = settings
            .backend_origin
            .as_deref()
            .map(|origin| self.credential_store.has(origin))
            .transpose()
            .map_err(|_| RuntimeError::credential_error())?
            .unwrap_or(false);
        Ok(DesktopSettingsStatus::from_settings(
            settings,
            credentials_configured,
        ))
    }

    pub fn record_launch(&self, launch: DesktopLaunch) {
        *self
            .launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(launch);
    }

    pub fn current_launch(&self) -> Option<DesktopLaunch> {
        self.launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn begin_shutdown(&self) -> bool {
        self.shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

pub(crate) fn clear_expired_room(
    store: &RoomSessionStore,
    origin: Option<&str>,
    event: &crate::contracts::DesktopEvent,
) {
    let expired = matches!(event, crate::contracts::DesktopEvent::State { state } if state.error.as_ref().is_some_and(|error| error.code == "SESSION_EXPIRED" || error.code == "ROOM_NOT_FOUND"));
    if expired {
        if let Some(origin) = origin {
            let _ = store.clear(origin);
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRoomInput {
    pub nickname: String,
    pub pin: Option<String>,
    pub initial_media: Option<MediaSource>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRoomResult {
    pub room_id: String,
}

#[tauri::command(rename = "startDesktopSession")]
pub async fn start_desktop_session(
    ticket: String,
    expected_room_id: Option<String>,
    state: State<'_, TauriDesktopState>,
) -> Result<(), RuntimeError> {
    let runtime = state.runtime()?;
    tauri::async_runtime::spawn_blocking(move || runtime.start(ticket, expected_room_id))
        .await
        .map_err(|_| RuntimeError::runtime_unavailable())?
}

fn transport_for_settings(
    state: &TauriDesktopState,
    settings: &crate::config::DesktopSettings,
) -> Result<DesktopHttpTransport, RuntimeError> {
    let origin = settings
        .backend_origin
        .clone()
        .ok_or_else(RuntimeError::not_configured)?;
    match state.credential_store.read(&origin) {
        Ok(Some(credentials)) => {
            let (username, password) = credentials.into_parts();
            DesktopHttpTransport::with_site_basic_auth(origin, username, password)
                .map_err(|_| RuntimeError::configuration_error())
        }
        Ok(None) => {
            DesktopHttpTransport::new(origin).map_err(|_| RuntimeError::configuration_error())
        }
        Err(_) => Err(RuntimeError::credential_error()),
    }
}

fn settings_for_state(
    state: &TauriDesktopState,
) -> Result<crate::config::DesktopSettings, RuntimeError> {
    state
        .config_store
        .load()
        .map_err(|_| RuntimeError::configuration_error())
}

/// Native-only owner-token persistence. The session reports claim/clear
/// transitions; the hook rewrites the Credential Manager blob so a restart
/// restores (or drops) ownership exactly as the server sees it.
pub(crate) fn owner_token_persist_hook(
    room_store: RoomSessionStore,
    origin: Option<String>,
) -> std::sync::Arc<dyn Fn(Option<String>) + Send + Sync> {
    std::sync::Arc::new(move |owner_token| {
        let Some(origin) = origin.as_deref() else {
            return;
        };
        if let Ok(Some(mut session)) = room_store.read(origin) {
            session.set_owner_token(owner_token);
            let _ = room_store.write(origin, &session);
        }
    })
}

fn persist_and_start(
    state: &TauriDesktopState,
    settings: &crate::config::DesktopSettings,
    session: StoredRoomSession,
) -> Result<DesktopRoomResult, RuntimeError> {
    let origin = settings
        .backend_origin
        .as_deref()
        .ok_or_else(RuntimeError::not_configured)?;
    let (room_id, client_id, token, owner_token, _generation) = session.parts();
    state
        .room_store
        .write(origin, &session)
        .map_err(|_| RuntimeError::credential_error())?;
    let runtime = state.runtime()?;
    let start_result = runtime.start_persisted(
        room_id.to_owned(),
        client_id.to_owned(),
        token.to_owned(),
        owner_token.map(str::to_owned),
    );
    if start_result.is_err() {
        let _ = state.room_store.clear(origin);
    }
    start_result.map(|()| DesktopRoomResult {
        room_id: room_id.to_owned(),
    })
}

#[tauri::command(rename = "createDesktopRoom")]
pub async fn create_desktop_room(
    input: DesktopRoomInput,
    app: AppHandle,
) -> Result<DesktopRoomResult, RuntimeError> {
    configuration_task(app, move |state| {
        let settings = settings_for_state(state)?;
        let origin = settings
            .backend_origin
            .as_deref()
            .ok_or_else(RuntimeError::not_configured)?;
        let client_id = uuid::Uuid::new_v4().to_string();
        let mut transport = transport_for_settings(state, &settings)?;
        let handoff = transport
            .create_desktop(
                &client_id,
                &input.nickname,
                input.pin.as_deref(),
                input.initial_media.as_ref(),
            )
            .map_err(|error| RuntimeError::from_transport(&error))?;
        let session = StoredRoomSession::new(
            handoff.room_id,
            handoff.client_id,
            handoff.access_token,
            handoff.owner_token,
            handoff.generation,
        )
        .map_err(|_| RuntimeError::configuration_error())?;
        let _ = origin;
        persist_and_start(state, &settings, session)
    })
    .await
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccessInput {
    pub room_id: String,
    pub nickname: String,
    pub pin: Option<String>,
}

#[tauri::command(rename = "accessDesktopRoom")]
pub async fn access_desktop_room(
    input: DesktopAccessInput,
    app: AppHandle,
) -> Result<DesktopRoomResult, RuntimeError> {
    configuration_task(app, move |state| {
        let settings = settings_for_state(state)?;
        let origin = settings
            .backend_origin
            .as_deref()
            .ok_or_else(RuntimeError::not_configured)?;
        let existing = state
            .room_store
            .read(origin)
            .map_err(|_| RuntimeError::credential_error())?;
        let client_id = existing
            .as_ref()
            .map(|session| session.parts().1.to_owned())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut transport = transport_for_settings(state, &settings)?;
        let token = transport
            .access_desktop(
                &input.room_id,
                &client_id,
                &input.nickname,
                input.pin.as_deref(),
            )
            .map_err(|error| RuntimeError::from_transport(&error))?;
        let session = StoredRoomSession::new(input.room_id, client_id, token, None, 1)
            .map_err(|_| RuntimeError::configuration_error())?;
        persist_and_start(state, &settings, session)
    })
    .await
}

#[tauri::command(rename = "restoreDesktopSession")]
pub async fn restore_desktop_session(app: AppHandle) -> Result<bool, RuntimeError> {
    configuration_task(app, move |state| {
        let settings = settings_for_state(state)?;
        let Some(origin) = settings.backend_origin.as_deref() else {
            return Ok(false);
        };
        let session = match state.room_store.read(origin) {
            Ok(session) => session,
            Err(_) => {
                let _ = state.room_store.clear(origin);
                return Ok(false);
            }
        };
        let Some(session) = session else {
            return Ok(false);
        };
        let (room_id, client_id, token, owner_token, _generation) = session.parts();
        state.runtime()?.start_persisted(
            room_id.to_owned(),
            client_id.to_owned(),
            token.to_owned(),
            owner_token.map(str::to_owned),
        )?;
        Ok(true)
    })
    .await
}

/// Replays the latest deep-link launch. The renderer calls this right after
/// registering its event listeners so a cold-start deep link is never lost.
#[tauri::command(rename = "currentDesktopLaunch")]
pub fn current_desktop_launch(state: State<'_, TauriDesktopState>) -> Option<DesktopLaunch> {
    state.current_launch()
}

#[tauri::command(rename = "executeRoomCommand")]
pub async fn execute_room_command(
    app: AppHandle,
    command: DesktopCommand,
    state: State<'_, TauriDesktopState>,
) -> Result<CommandAck, RuntimeError> {
    validate_command(&command).map_err(|_| RuntimeError::invalid_command())?;
    let runtime = state.runtime()?;
    match command {
        DesktopCommand::PlayerVisibility { visible } => {
            set_player_visibility(runtime, visible).await?;
            Ok(local_ack())
        }
        DesktopCommand::Fullscreen { enabled } => {
            set_player_fullscreen(&app, runtime, enabled).await?;
            Ok(local_ack())
        }
        command => tauri::async_runtime::spawn_blocking(move || runtime.execute(command))
            .await
            .map_err(|_| RuntimeError::runtime_unavailable())?,
    }
}

/// Lets the transparent WebView reveal libmpv output rendered into the host
/// HWND instead of clipping native drawing out of the window's paint region.
#[cfg(windows)]
pub(crate) fn configure_main_window_for_native_surface<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), RuntimeError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, WS_CLIPCHILDREN,
    };

    let hwnd = window
        .hwnd()
        .map_err(|_| RuntimeError::runtime_unavailable())?
        .0 as windows_sys::Win32::Foundation::HWND;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    let updated = style & !(WS_CLIPCHILDREN as isize);
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, updated) };
    if unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } & (WS_CLIPCHILDREN as isize) != 0 {
        return Err(RuntimeError::runtime_unavailable());
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn configure_main_window_for_native_surface<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<(), RuntimeError> {
    Ok(())
}

async fn set_player_visibility(
    runtime: Arc<DesktopRuntime>,
    visible: bool,
) -> Result<(), RuntimeError> {
    tauri::async_runtime::spawn_blocking(move || runtime.set_local_suspended(!visible))
        .await
        .map_err(|_| RuntimeError::runtime_unavailable())?
}

async fn set_player_fullscreen(
    app: &AppHandle,
    runtime: Arc<DesktopRuntime>,
    enabled: bool,
) -> Result<(), RuntimeError> {
    tauri::async_runtime::spawn_blocking(move || runtime.set_local_suspended(false))
        .await
        .map_err(|_| RuntimeError::runtime_unavailable())??;
    let main_window = app
        .get_window("main")
        .ok_or_else(RuntimeError::runtime_unavailable)?;
    main_window
        .set_fullscreen(enabled)
        .map_err(|_| RuntimeError::runtime_unavailable())
}

fn local_ack() -> CommandAck {
    CommandAck {
        ok: true,
        revision: 0,
        error: None,
    }
}

#[tauri::command(rename = "stopDesktopSession")]
pub async fn stop_desktop_session(state: State<'_, TauriDesktopState>) -> Result<(), RuntimeError> {
    let runtime = state.runtime()?;
    let result = tauri::async_runtime::spawn_blocking(move || runtime.stop_session())
        .await
        .map_err(|_| RuntimeError::runtime_unavailable())?;
    if result.is_ok() {
        if let Ok(settings) = state.config_store.load() {
            if let Some(origin) = settings.backend_origin.as_deref() {
                let _ = state.room_store.clear(origin);
            }
        }
    }
    result
}

#[tauri::command(rename = "getDesktopSettings")]
pub async fn get_desktop_settings(app: AppHandle) -> Result<DesktopSettingsStatus, RuntimeError> {
    configuration_task(app, |state| state.settings_status()).await
}

/// Serializes settings and credential changes off the Tauri UI thread.
async fn configuration_task<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&TauriDesktopState) -> Result<T, RuntimeError> + Send + 'static,
) -> Result<T, RuntimeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TauriDesktopState>();
        let _guard = state
            .configuration_change
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        action(&state)
    })
    .await
    .map_err(|_| RuntimeError::runtime_unavailable())?
}

#[tauri::command(rename = "updateDesktopSettings")]
pub async fn update_desktop_settings(
    input: DesktopSettingsInput,
    app: AppHandle,
) -> Result<DesktopSettingsStatus, RuntimeError> {
    configuration_task(app, move |state| {
        let previous = state
            .config_store
            .load()
            .map_err(|_| RuntimeError::configuration_error())?;
        let settings =
            DesktopConfigStore::validate(input).map_err(|_| RuntimeError::configuration_error())?;
        let changed = previous.backend_origin != settings.backend_origin;
        let preferences_changed = previous.player_preferences != settings.player_preferences;
        let replacement = if changed {
            settings
                .backend_origin
                .as_ref()
                .map(|_| state.runtime_from_settings(&settings))
                .transpose()?
        } else {
            None
        };
        // Validation and replacement preparation precede the atomic disk write.
        state
            .config_store
            .write_atomically(&settings)
            .map_err(|_| RuntimeError::configuration_error())?;
        if changed {
            if let Some(origin) = previous.backend_origin.as_deref() {
                let _ = state.room_store.clear(origin);
            }
            if let Some(origin) = settings.backend_origin.as_deref() {
                let _ = state.room_store.clear(origin);
            }
            state.replace_runtime(replacement, settings.backend_origin.is_some());
        }
        // Live preference application never rebuilds the runtime. Failures are
        // surfaced through the status so the UI can show the effective values.
        let preference_failures = if preferences_changed {
            state
                .runtime()
                .ok()
                .map(|runtime| {
                    runtime
                        .apply_player_preferences(settings.player_preferences.clone())
                        .unwrap_or_default()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut result = state.settings_status()?;
        result.player_preference_failures = preference_failures;
        let _ = state.app_handle.emit("desktop://settings", &result);
        Ok(result)
    })
    .await
}

#[tauri::command(rename = "clearSiteCredentials")]
pub async fn clear_site_credentials(app: AppHandle) -> Result<DesktopSettingsStatus, RuntimeError> {
    configuration_task(app, |state| {
        let settings = state
            .config_store
            .load()
            .map_err(|_| RuntimeError::configuration_error())?;
        if let Some(origin) = settings.backend_origin.as_deref() {
            state
                .credential_store
                .clear(origin)
                .map_err(|_| RuntimeError::credential_error())?;
            let _ = state.room_store.clear(origin);
        }
        state.rebuild_runtime(&settings)?;
        state.settings_status()
    })
    .await
}

#[tauri::command(rename = "promptSiteCredentials")]
pub async fn prompt_site_credentials(
    app: AppHandle,
) -> Result<Option<DesktopSettingsStatus>, RuntimeError> {
    #[cfg(windows)]
    let owner_hwnd = app
        .get_webview_window("main")
        .ok_or_else(RuntimeError::runtime_unavailable)?
        .hwnd()
        .map_err(|_| RuntimeError::runtime_unavailable())?
        .0 as isize;
    #[cfg(not(windows))]
    let owner_hwnd = 0isize;
    configuration_task(app, move |state| {
        let settings = state
            .config_store
            .load()
            .map_err(|_| RuntimeError::configuration_error())?;
        let origin = settings
            .backend_origin
            .as_deref()
            .ok_or_else(RuntimeError::not_configured)?;
        let stored = state
            .credential_store
            .prompt_and_store(origin, owner_hwnd)
            .map_err(|_| RuntimeError::credential_error())?;
        if !stored {
            return Ok(None);
        }
        let _ = state.room_store.clear(origin);
        state.rebuild_runtime(&settings)?;
        state.settings_status().map(Some)
    })
    .await
}

impl TauriDesktopState {
    /// Builds a same-origin transport for media browsing with site Basic Auth
    /// attached. Resolved media URLs never flow through this path over IPC.
    fn media_transport(&self) -> Result<DesktopHttpTransport, RuntimeError> {
        let settings = self
            .config_store
            .load()
            .map_err(|_| RuntimeError::configuration_error())?;
        let origin = settings
            .backend_origin
            .as_deref()
            .ok_or_else(RuntimeError::not_configured)?;
        let transport = match self.credential_store.read(origin) {
            Ok(Some(credentials)) => {
                let (username, password) = credentials.into_parts();
                DesktopHttpTransport::with_site_basic_auth(origin, username, password)
                    .map_err(|_| RuntimeError::configuration_error())
            }
            Ok(None) => {
                DesktopHttpTransport::new(origin).map_err(|_| RuntimeError::configuration_error())
            }
            Err(_) => return Err(RuntimeError::credential_error()),
        };
        transport
    }
}

#[tauri::command(rename = "mediaRoots")]
pub async fn media_roots(app: AppHandle) -> Result<Vec<String>, RuntimeError> {
    configuration_task(app, |state| {
        let _ = state.runtime()?;
        state
            .media_transport()?
            .media_roots()
            .map_err(|_| RuntimeError::runtime_unavailable())
    })
    .await
}

#[tauri::command(rename = "mediaList")]
pub async fn media_list(
    app: AppHandle,
    root: String,
    path: Option<String>,
    cursor: Option<String>,
) -> Result<MediaDirectoryPage, RuntimeError> {
    configuration_task(app, move |state| {
        let _ = state.runtime()?;
        let path = path.unwrap_or_else(|| "/".into());
        if !is_safe_media_path(&path) {
            return Err(RuntimeError::invalid_command());
        }
        state
            .media_transport()?
            .media_list(&root, &path, cursor.as_deref())
            .map_err(|_| RuntimeError::runtime_unavailable())
    })
    .await
}

#[tauri::command(rename = "mediaSearch")]
pub async fn media_search(
    app: AppHandle,
    query: String,
    cursor: Option<String>,
) -> Result<MediaDirectoryPage, RuntimeError> {
    configuration_task(app, move |state| {
        let _ = state.runtime()?;
        let query = query.trim().to_owned();
        if query.is_empty() || query.chars().count() > 200 {
            return Err(RuntimeError::invalid_command());
        }
        state
            .media_transport()?
            .media_search(&query, cursor.as_deref())
            .map_err(|_| RuntimeError::runtime_unavailable())
    })
    .await
}

/// Rejects traversal attempts before they reach the backend; the server still
/// validates the path authoritatively.
fn is_safe_media_path(path: &str) -> bool {
    path.len() <= 1000 && !path.contains('\\') && !path.split('/').any(|segment| segment == "..")
}

#[tauri::command(rename = "verifyBackend")]
pub async fn verify_backend(app: AppHandle) -> Result<(), RuntimeError> {
    configuration_task(app, |state| {
        let _ = state.runtime()?;
        state
            .media_transport()?
            .verify_backend()
            .map_err(|_| RuntimeError::runtime_unavailable())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        ConnectionState, DesktopEvent, DesktopUiState, NativeCapabilityReport, PlayerState,
    };
    use serde_json::Value;

    fn assert_no_forbidden_keys(value: &Value) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    assert!(
                        !matches!(
                            key.as_str(),
                            "accessToken"
                                | "directUrl"
                                | "fallbackUrl"
                                | "authorization"
                                | "headers"
                                | "basicAuth"
                                | "mpvCommand"
                        ),
                        "forbidden IPC field serialized: {key}"
                    );
                    assert_no_forbidden_keys(value);
                }
            }
            Value::Array(values) => values.iter().for_each(assert_no_forbidden_keys),
            _ => {}
        }
    }

    #[test]
    fn desktop_state_event_schema_has_no_native_secret_fields() {
        let event = DesktopEvent::State {
            state: DesktopUiState {
                connection: ConnectionState::Ready,
                room_id: Some("room-fake".into()),
                room: None,
                members: Vec::new(),
                can_control_shared_playback: false,
                is_owner: false,
                client_id: None,
                player: PlayerState::default(),
                player_window_visible: false,
                capability: NativeCapabilityReport::default(),
                error: None,
            },
        };
        let value = serde_json::to_value(event).expect("serialize desktop event");
        assert_no_forbidden_keys(&value);
    }

    #[test]
    fn transport_error_details_are_not_serialized_to_the_renderer() {
        let error = RuntimeError::from_untrusted_transport_for_test(
            "https://direct.invalid/video access-token basic-password",
        );
        let serialized = serde_json::to_string(&error).expect("serialize runtime error");
        assert_eq!(error.code, "DESKTOP_REQUEST_FAILED");
        for secret in ["direct.invalid", "access-token", "basic-password"] {
            assert!(!serialized.contains(secret));
        }
    }
}
