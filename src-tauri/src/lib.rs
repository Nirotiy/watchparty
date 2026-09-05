pub mod clock;
pub mod commands;
pub mod config;
pub mod contracts;
pub mod http;
pub mod launch;
pub mod libmpv;
pub mod playback;
pub mod runtime;
pub mod session;
mod tauri_api;
pub mod transport;

use crate::{
    commands::DESKTOP_STATE_EVENT,
    config::{DesktopConfigStore, SiteCredentialStore},
    libmpv::LibMpvConfig,
    runtime::{DesktopRuntime, NativeRuntimeConfig, NativeSiteCredentials},
    tauri_api::{
        configure_main_window_for_native_surface, current_desktop_launch, execute_room_command,
        start_desktop_session, stop_desktop_session, TauriDesktopState,
    },
};
pub use session::DesktopSession;
use tauri::{Emitter, Manager};
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

/// Starts the desktop shell and its isolated native session worker.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                launch::focus_main_window(app);
            },
        ));
        builder = builder.plugin(tauri_plugin_deep_link::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            start_desktop_session,
            execute_room_command,
            stop_desktop_session,
            current_desktop_launch,
            tauri_api::get_desktop_settings,
            tauri_api::update_desktop_settings,
            tauri_api::clear_site_credentials,
            tauri_api::prompt_site_credentials,
            tauri_api::verify_backend
        ])
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .ok_or("main desktop window was not created")?;
            configure_main_window_for_native_surface(&main_window)?;
            #[cfg(windows)]
            let surface_handle = main_window.hwnd()?.0 as usize;
            #[cfg(not(windows))]
            let surface_handle = 0;
            let player = LibMpvConfig::from_env(surface_handle)?;
            let config_store = DesktopConfigStore::new(app.path().app_data_dir()?);
            let settings = config_store
                .load()
                .map_err(|_| "desktop settings could not be loaded")?;
            let credential_store = SiteCredentialStore;
            let configured = settings.backend_origin.is_some();
            let app_handle = app.handle().clone();
            let runtime = if let Some(origin) = settings.backend_origin.clone() {
                let credentials = settings
                    .backend_origin
                    .as_deref()
                    .map(|origin| credential_store.read(origin))
                    .transpose().map_err(|_| "system credential store unavailable")?
                    .flatten()
                    .map(NativeSiteCredentials::from_stored)
                    .transpose()?;
                let config = NativeRuntimeConfig::with_player(origin, credentials, player.clone())?;
                let event_app_handle = app_handle.clone();
                Some(DesktopRuntime::spawn(config, move |event| {
                    let _ = event_app_handle.emit(DESKTOP_STATE_EVENT, event);
                })?)
            } else {
                None
            };
            app.manage(TauriDesktopState::new(
                runtime,
                configured,
                config_store,
                credential_store,
                app_handle,
                player,
            ));

            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            {
                #[cfg(all(debug_assertions, windows))]
                app.deep_link().register_all()?;

                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    launch::handle_open_urls(&app_handle, event.urls());
                });
                if let Some(urls) = app.deep_link().get_current()? {
                    launch::handle_open_urls(app.handle(), urls);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<TauriDesktopState>();
                api.prevent_close();
                if state.begin_shutdown() {
                    let _ = window.hide();
                    let runtime = state.runtime_for_shutdown();
                    let app_handle = window.app_handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Some(runtime) = runtime {
                            runtime.shutdown();
                        }
                        app_handle.exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run WatchParty desktop shell");
}
