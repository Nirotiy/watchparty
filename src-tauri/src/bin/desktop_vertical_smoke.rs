//! Product-chain smoke: isolated backend handoff -> DesktopRuntime -> real libmpv surface.

use serde::Serialize;
use std::{
    env,
    io::{self, Write},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{window::WindowBuilder, Manager};
use watchparty_desktop::{
    contracts::{ConnectionState, DesktopCommand, DesktopEvent, DesktopUiState},
    libmpv::LibMpvConfig,
    runtime::{DesktopRuntime, NativeRuntimeConfig},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerticalReport {
    room_id: String,
    initial_item_id: String,
    final_item_id: String,
    file_loaded: bool,
    remote_pause: bool,
    remote_seek: bool,
    remote_rate: bool,
    local_suspend: bool,
    resume_caught_up: bool,
    local_volume: bool,
    eof_advanced_playlist: bool,
    desktop_member_visible: bool,
}

fn main() {
    let outcome = Arc::new(Mutex::new(None::<Result<VerticalReport, String>>));
    let setup_outcome = Arc::clone(&outcome);
    let app = tauri::Builder::default()
        .setup(move |app| {
            if let Some(main) = app.get_webview_window("main") {
                main.hide()?;
            }
            let window = WindowBuilder::new(app, "desktop-vertical-smoke")
                .title("WatchParty desktop vertical smoke")
                .inner_size(960.0, 540.0)
                .visible(true)
                .build()?;
            #[cfg(windows)]
            let window_handle = window.hwnd()?.0 as usize;
            #[cfg(not(windows))]
            let window_handle = 0;

            let player = LibMpvConfig::from_env(window_handle)?;
            let config =
                NativeRuntimeConfig::with_player(required("WATCHPARTY_BACKEND_ORIGIN")?, None, player)?;
            let ticket = required("DESKTOP_VERTICAL_TICKET")?;
            let expected_room_id = required("DESKTOP_VERTICAL_ROOM_ID")?;
            let handle = app.handle().clone();
            let worker_outcome = Arc::clone(&setup_outcome);
            thread::Builder::new()
                .name("watchparty-desktop-vertical-smoke".into())
                .spawn(move || {
                    let result = run_vertical(config, ticket, expected_room_id);
                    let exit_code = i32::from(result.is_err());
                    *worker_outcome
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
                    handle.exit(exit_code);
                })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build desktop vertical smoke application");

    let exit_code = app.run_return(|_, _| {});
    let result = outcome
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .unwrap_or_else(|| Err("vertical smoke worker did not report a result".into()));
    match result {
        Ok(report) => println!(
            "WATCHPARTY_VERTICAL_PASS {}",
            serde_json::to_string(&report).expect("serialize vertical report")
        ),
        Err(error) => eprintln!("WATCHPARTY_VERTICAL_FAIL {error}"),
    }
    std::process::exit(exit_code);
}

fn run_vertical(
    config: NativeRuntimeConfig,
    ticket: String,
    expected_room_id: String,
) -> Result<VerticalReport, String> {
    let (event_sender, event_receiver) = mpsc::channel();
    let runtime = DesktopRuntime::spawn(config, move |event| {
        let _ = event_sender.send(event);
    })
    .map_err(|error| error.code.to_owned())?;

    runtime
        .start(ticket, Some(expected_room_id.clone()))
        .map_err(|error| error.code.to_owned())?;
    let initial = wait_for_state(&event_receiver, Duration::from_secs(30), |state| {
        state.connection == ConnectionState::Ready && state.player.loaded
    })?;
    if initial.room_id.as_deref() != Some(expected_room_id.as_str()) {
        return Err("desktop session joined an unexpected room".into());
    }
    let room = initial
        .room
        .as_ref()
        .ok_or_else(|| "initial room snapshot missing".to_owned())?;
    if room.owner_client_id.is_empty() || room.playlist.len() < 2 {
        return Err("test room does not contain the expected playlist".into());
    }
    let room_id = expected_room_id;
    let initial_item_id = room
        .current_playlist_item_id
        .clone()
        .ok_or_else(|| "initial playlist item missing".to_owned())?;
    let desktop_member_visible = initial.members.iter().any(|member| {
        matches!(
            member.client_type,
            watchparty_desktop::contracts::ClientType::Desktop
        )
    });

    runtime
        .set_local_suspended(true)
        .map_err(|error| error.code.to_owned())?;
    let suspended = wait_for_state(&event_receiver, Duration::from_secs(5), |state| {
        state.player.paused
    })?;

    marker("READY_FOR_REMOTE");
    let remote_snapshot = wait_for_state(&event_receiver, Duration::from_secs(20), |state| {
        state.room.as_ref().is_some_and(|room| {
            room.paused
                && (room.position_seconds - 1.0).abs() < 0.1
                && (room.playback_rate - 1.25).abs() < 0.02
        })
    })?;
    runtime
        .set_local_suspended(false)
        .map_err(|error| error.code.to_owned())?;
    let remote = wait_for_state(&event_receiver, Duration::from_secs(5), |state| {
        state.player.paused
            && (state.player.time - 1.0).abs() < 1.5
            && (state.player.rate - 1.25).abs() < 0.02
    })?;

    runtime
        .execute(DesktopCommand::Volume { volume: 37.0 })
        .map_err(|error| error.code.to_owned())?;
    let volume = wait_for_state(&event_receiver, Duration::from_secs(5), |state| {
        (state.player.volume - 37.0).abs() < 0.2
    })?;

    let duration = volume.player.duration;
    if duration <= 1.0 {
        return Err("fixture duration is too short".into());
    }
    runtime
        .execute(DesktopCommand::Seek {
            position_seconds: (duration - 0.65).max(0.0),
        })
        .map_err(|error| error.code.to_owned())?;
    runtime
        .execute(DesktopCommand::Rate { rate: 2.0 })
        .map_err(|error| error.code.to_owned())?;
    runtime
        .execute(DesktopCommand::Play)
        .map_err(|error| error.code.to_owned())?;

    let advanced = wait_for_state(&event_receiver, Duration::from_secs(30), |state| {
        state
            .room
            .as_ref()
            .and_then(|snapshot| snapshot.current_playlist_item_id.as_ref())
            .is_some_and(|item_id| item_id != &initial_item_id)
    })?;
    let final_item_id = advanced
        .room
        .as_ref()
        .and_then(|snapshot| snapshot.current_playlist_item_id.clone())
        .ok_or_else(|| "advanced playlist item missing".to_owned())?;

    runtime.shutdown();
    Ok(VerticalReport {
        room_id,
        initial_item_id: initial_item_id.clone(),
        final_item_id,
        file_loaded: initial.player.loaded,
        remote_pause: remote.player.paused,
        remote_seek: (remote.player.time - 1.0).abs() < 1.5,
        remote_rate: (remote.player.rate - 1.25).abs() < 0.02,
        local_suspend: suspended.player.paused,
        resume_caught_up: remote_snapshot.room.is_some() && remote.player.paused,
        local_volume: (volume.player.volume - 37.0).abs() < 0.2,
        eof_advanced_playlist: true,
        desktop_member_visible,
    })
}

fn wait_for_state<F>(
    receiver: &mpsc::Receiver<DesktopEvent>,
    timeout: Duration,
    predicate: F,
) -> Result<DesktopUiState, String>
where
    F: Fn(&DesktopUiState) -> bool,
{
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(DesktopEvent::State { state }) if predicate(&state) => return Ok(state),
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("desktop event channel closed".into())
            }
        }
    }
    Err("vertical smoke timed out waiting for desktop state".into())
}

fn required(name: &str) -> Result<String, io::Error> {
    env::var(name).map_err(|_| io::Error::other(format!("{name} is required")))
}

fn marker(value: &str) {
    println!("WATCHPARTY_VERTICAL_{value}");
    let _ = io::stdout().flush();
}
