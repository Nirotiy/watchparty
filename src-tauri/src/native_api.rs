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
use std::path::PathBuf;

pub trait DesktopHost: Send + Sync {
    fn data_dir(&self) -> Result<PathBuf, RuntimeError>;
    fn emit_value(&self, event: &str, payload: serde_json::Value);
    fn window_handle(&self) -> Result<isize, RuntimeError>;
    fn set_fullscreen(&self, enabled: bool) -> Result<(), RuntimeError>;
}

/// Keeps the native libmpv surface visible behind a transparent desktop renderer.
#[cfg(windows)]
pub fn configure_native_surface(handle: isize) -> Result<(), RuntimeError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, WS_CLIPCHILDREN};
    let hwnd = handle as windows_sys::Win32::Foundation::HWND;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_CLIPCHILDREN as isize)); }
    if unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } & (WS_CLIPCHILDREN as isize) != 0 {
        return Err(RuntimeError::runtime_unavailable());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn configure_native_surface(_handle: isize) -> Result<(), RuntimeError> { Ok(()) }

#[derive(Clone)]
pub struct Host(pub Arc<dyn DesktopHost>);
impl Host {
    fn emit(&self, event: &str, payload: impl serde::Serialize) -> Result<(), serde_json::Error> {
        self.0.emit_value(event, serde_json::to_value(payload)?);
        Ok(())
    }
}

#[allow(non_snake_case)]
pub fn listOriginTrust(state: &NativeDesktopState) -> Result<Vec<crate::config::OriginTrustRecord>, String> {
    crate::config::OriginTrustStore::new(state.app_handle.0.data_dir().map_err(|_|"Trust storage unavailable")?).list().map_err(|_|"Trust storage unavailable".into())
}
#[allow(non_snake_case)]
pub fn importOriginTrust(state: &NativeDesktopState, origin: String, pem: String) -> Result<crate::config::OriginTrustRecord, String> {
    crate::config::OriginTrustStore::new(state.app_handle.0.data_dir().map_err(|_|"Trust storage unavailable")?).import(&origin, &pem).map_err(|_|"Certificate trust could not be saved".into())
}
#[allow(non_snake_case)]
pub fn deleteOriginTrust(state: &NativeDesktopState, origin: String) -> Result<(), String> {
    crate::config::OriginTrustStore::new(state.app_handle.0.data_dir().map_err(|_|"Trust storage unavailable")?).delete(&origin).map_err(|_|"Certificate trust could not be deleted".into())
}

/// Shared native state. The renderer receives neither the runtime config nor its credentials.
pub struct NativeDesktopState {
    runtime: Mutex<Option<Arc<DesktopRuntime>>>,
    configuration_change: Mutex<()>,
    configured: AtomicBool,
    app_handle: Host,
    player: LibMpvConfig,
    config_store: DesktopConfigStore,
    credential_store: SiteCredentialStore,
    room_store: RoomSessionStore,
    shutdown_started: AtomicBool,
    /// Latest accepted deep-link launch. Persisted here so the renderer can
    /// replay it after its event listeners register (cold-start deep links are
    /// emitted before React mounts).
    launch: Mutex<Option<DesktopLaunch>>,
    checkpoint: Mutex<Option<(String, String, StoredRoomSession)>>,
}

impl NativeDesktopState {
    /// Initializes either shell from the same settings and credential stores.
    pub fn initialize(host: Host, player: LibMpvConfig) -> Result<Self, RuntimeError> {
        let store = DesktopConfigStore::new(host.0.data_dir()?);
        let settings = store.load().map_err(|_| RuntimeError::configuration_error())?;
        let state = Self::new(None, false, store, SiteCredentialStore, RoomSessionStore, host, player);
        state.rebuild_runtime(&settings)?;
        Ok(state)
    }

    pub fn new(
        runtime: Option<DesktopRuntime>,
        configured: bool,
        config_store: DesktopConfigStore,
        credential_store: SiteCredentialStore,
        room_store: RoomSessionStore,
        app_handle: Host,
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
            checkpoint: Mutex::new(None),
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
            self.app_handle.0.data_dir().map_err(|_| RuntimeError::configuration_error())?,
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
        .with_trust_store(std::sync::Arc::new(trust_store))
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

pub fn start_desktop_session(
    ticket: String,
    expected_room_id: Option<String>,
    state: &NativeDesktopState,
) -> Result<(), RuntimeError> {
    let runtime = state.runtime()?;
    runtime.start(ticket, expected_room_id)
}

fn transport_for_settings(
    state: &NativeDesktopState,
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
    state: &NativeDesktopState,
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
    state: &NativeDesktopState,
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

pub fn create_desktop_room(
    input: DesktopRoomInput,
    state: &NativeDesktopState,
) -> Result<DesktopRoomResult, RuntimeError> {
    configuration_task(state, move |state| {
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

}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccessInput {
    pub room_id: String,
    pub nickname: String,
    pub pin: Option<String>,
}

pub fn access_desktop_room(
    input: DesktopAccessInput,
    state: &NativeDesktopState,
) -> Result<DesktopRoomResult, RuntimeError> {
    configuration_task(state, move |state| {
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

}

pub fn restore_desktop_session(state: &NativeDesktopState) -> Result<bool, RuntimeError> {
    configuration_task(state, move |state| {
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

}

/// Replays the latest deep-link launch. The renderer calls this right after
/// registering its event listeners so a cold-start deep link is never lost.
pub fn current_desktop_launch(state: &NativeDesktopState) -> Option<DesktopLaunch> {
    state.current_launch()
}

pub fn execute_room_command(
    state: &NativeDesktopState,
    command: DesktopCommand,
) -> Result<CommandAck, RuntimeError> {
    validate_command(&command).map_err(|_| RuntimeError::invalid_command())?;
    let runtime = state.runtime()?;
    match command {
        DesktopCommand::PlayerVisibility { visible } => {
            set_player_visibility(runtime, visible)?;
            Ok(local_ack())
        }
        DesktopCommand::Fullscreen { enabled } => {
            set_player_fullscreen(&state.app_handle, runtime, enabled)?;
            Ok(local_ack())
        }
        command => runtime.execute(command),
    }
}

fn set_player_visibility(runtime: Arc<DesktopRuntime>, visible: bool) -> Result<(), RuntimeError> {
    runtime.set_local_suspended(!visible)
}

fn set_player_fullscreen(app: &Host, runtime: Arc<DesktopRuntime>, enabled: bool) -> Result<(), RuntimeError> {
    runtime.set_local_suspended(false)?;
    app.0.set_fullscreen(enabled)
}

fn local_ack() -> CommandAck {
    CommandAck {
        ok: true,
        revision: 0,
        error: None,
    }
}

#[derive(serde::Serialize)]
pub struct DesktopSessionCheckpoint { pub id: String }

/// Credentials stay native; only one bounded, opaque recovery handle is retained.
pub fn checkpoint_desktop_session(state: &NativeDesktopState) -> Result<Option<DesktopSessionCheckpoint>, RuntimeError> {
    configuration_task(state, |state| {
        let settings = settings_for_state(state)?;
        let Some(origin) = settings.backend_origin else { return Ok(None) };
        let session = state.room_store.read(&origin).map_err(|_| RuntimeError::credential_error())?;
        let Some(session) = session else { return Ok(None) };
        let id = uuid::Uuid::new_v4().to_string();
        *state.checkpoint.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((id.clone(), origin, session));
        Ok(Some(DesktopSessionCheckpoint { id }))
    })
}

pub fn suspend_desktop_session(state: &NativeDesktopState) -> Result<(), RuntimeError> {
    configuration_task(state, |state| state.runtime()?.stop_session())
}

pub fn rollback_desktop_session(state: &NativeDesktopState, id: String) -> Result<(), RuntimeError> {
    configuration_task(state, |state| {
        let settings = settings_for_state(state)?;
        let mut checkpoint = state.checkpoint.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((stored_id, origin, session)) = checkpoint.as_ref() else { return Err(RuntimeError::configuration_error()) };
        if stored_id != &id || settings.backend_origin.as_ref() != Some(origin) { return Err(RuntimeError::configuration_error()) }
        let (room_id, client_id, token, owner_token, _) = session.parts();
        let runtime = state.runtime()?;
        runtime.stop_session()?;
        state.room_store.write(origin, session).map_err(|_| RuntimeError::credential_error())?;
        runtime.start_persisted(room_id.to_owned(), client_id.to_owned(), token.to_owned(), owner_token.map(str::to_owned))?;
        *checkpoint = None;
        Ok(())
    })
}

pub fn discard_desktop_session_checkpoint(state: &NativeDesktopState, id: String) -> Result<(), RuntimeError> {
    let mut checkpoint = state.checkpoint.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if checkpoint.as_ref().is_some_and(|entry| entry.0 == id) { *checkpoint = None; }
    Ok(())
}

pub fn stop_desktop_session(state: &NativeDesktopState) -> Result<(), RuntimeError> {
    *state.checkpoint.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    let runtime = state.runtime()?;
    let result = runtime.stop_session();
    if result.is_ok() {
        if let Ok(settings) = state.config_store.load() {
            if let Some(origin) = settings.backend_origin.as_deref() {
                let _ = state.room_store.clear(origin);
            }
        }
    }
    result
}

pub fn get_desktop_settings(state: &NativeDesktopState) -> Result<DesktopSettingsStatus, RuntimeError> {
    configuration_task(state, |state| state.settings_status())
}

pub fn list_audio_output_devices(state: &NativeDesktopState) -> Result<Vec<crate::libmpv::AudioOutputDevice>, String> {
    crate::libmpv::list_audio_output_devices(&state.player).map_err(|error| error.message.to_owned())
}

/// Serializes settings and credential changes across shell request workers.
fn configuration_task<T>(state: &NativeDesktopState, action: impl FnOnce(&NativeDesktopState) -> Result<T, RuntimeError>) -> Result<T, RuntimeError> {
    let _guard = state.configuration_change.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    action(state)
}

pub fn update_desktop_settings(
    input: DesktopSettingsInput,
    state: &NativeDesktopState,
) -> Result<DesktopSettingsStatus, RuntimeError> {
    configuration_task(state, move |state| {
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

}

pub fn clear_site_credentials(state: &NativeDesktopState) -> Result<DesktopSettingsStatus, RuntimeError> {
    configuration_task(state, |state| {
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

}

pub fn prompt_site_credentials(
    state: &NativeDesktopState,
) -> Result<Option<DesktopSettingsStatus>, RuntimeError> {
    let owner_hwnd = state.app_handle.0.window_handle()?;
    configuration_task(state, move |state| {
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

}

impl NativeDesktopState {
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

pub fn media_roots(state: &NativeDesktopState) -> Result<Vec<String>, RuntimeError> {
    configuration_task(state, |state| {
        let _ = state.runtime()?;
        state
            .media_transport()?
            .media_roots()
            .map_err(|_| RuntimeError::runtime_unavailable())
    })

}

pub fn media_list(
    state: &NativeDesktopState,
    root: String,
    path: Option<String>,
    cursor: Option<String>,
) -> Result<MediaDirectoryPage, RuntimeError> {
    configuration_task(state, move |state| {
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

}

pub fn media_search(
    state: &NativeDesktopState,
    query: String,
    cursor: Option<String>,
) -> Result<MediaDirectoryPage, RuntimeError> {
    configuration_task(state, move |state| {
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

}

/// Rejects traversal attempts before they reach the backend; the server still
/// validates the path authoritatively.
fn is_safe_media_path(path: &str) -> bool {
    path.len() <= 1000 && !path.contains('\\') && !path.split('/').any(|segment| segment == "..")
}

pub fn verify_backend(state: &NativeDesktopState) -> Result<(), RuntimeError> {
    configuration_task(state, |state| {
        let _ = state.runtime()?;
        state
            .media_transport()?
            .verify_backend()
            .map_err(|_| RuntimeError::runtime_unavailable())
    })

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
