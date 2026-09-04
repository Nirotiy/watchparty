use crate::{
    commands::validate_command,
    contracts::{CommandAck, DesktopCommand},
    launch::DesktopLaunch,
    runtime::{DesktopRuntime, RuntimeError},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, State};

/// Managed Tauri state. The renderer receives neither the runtime config nor its credentials.
pub struct TauriDesktopState {
    runtime: Arc<DesktopRuntime>,
    shutdown_started: AtomicBool,
    /// Latest accepted deep-link launch. Persisted here so the renderer can
    /// replay it after its event listeners register (cold-start deep links are
    /// emitted before React mounts).
    launch: Mutex<Option<DesktopLaunch>>,
}

impl TauriDesktopState {
    pub fn new(runtime: DesktopRuntime) -> Self {
        Self {
            runtime: Arc::new(runtime),
            shutdown_started: AtomicBool::new(false),
            launch: Mutex::new(None),
        }
    }

    pub fn runtime(&self) -> Arc<DesktopRuntime> {
        Arc::clone(&self.runtime)
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

#[tauri::command(rename = "startDesktopSession")]
pub async fn start_desktop_session(
    ticket: String,
    expected_room_id: Option<String>,
    state: State<'_, TauriDesktopState>,
) -> Result<(), RuntimeError> {
    let runtime = state.runtime();
    tauri::async_runtime::spawn_blocking(move || runtime.start(ticket, expected_room_id))
        .await
        .map_err(|_| RuntimeError::runtime_unavailable())?
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
    let runtime = state.runtime();
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
    let runtime = state.runtime();
    let result = tauri::async_runtime::spawn_blocking(move || runtime.stop_session())
        .await
        .map_err(|_| RuntimeError::runtime_unavailable())?;
    result
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
