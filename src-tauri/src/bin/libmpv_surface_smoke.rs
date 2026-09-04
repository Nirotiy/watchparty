//! Manual Gate 3 verifier: a real Tauri native window backed by libmpv.

use serde::Serialize;
use std::{
    env, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{window::WindowBuilder, Manager};
use watchparty_desktop::{
    contracts::{NativeCapabilityReport, PlayerState},
    libmpv::{LibMpvConfig, LibMpvPlayer},
    playback::{PlaybackLoad, PlayerEndReason, PlayerEngine, PlayerEvent},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    file_name: String,
    file_loaded: bool,
    play_advanced: bool,
    pause_applied: bool,
    seek_applied: bool,
    rate_applied: bool,
    volume_applied: bool,
    subtitle_selection_verified: Vec<String>,
    end_file: Option<String>,
    state: PlayerState,
    capability: NativeCapabilityReport,
}

fn main() {
    let outcome = Arc::new(Mutex::new(None::<Result<SmokeReport, String>>));
    let setup_outcome = Arc::clone(&outcome);
    let app = tauri::Builder::default()
        .setup(move |app| {
            if let Some(main) = app.get_webview_window("main") {
                main.hide()?;
            }
            let window = WindowBuilder::new(app, "libmpv-surface-smoke")
                .title("WatchParty libmpv surface smoke")
                .inner_size(1280.0, 720.0)
                .min_inner_size(640.0, 360.0)
                .visible(true)
                .build()?;
            #[cfg(windows)]
            let window_handle = window.hwnd()?.0 as usize;
            #[cfg(not(windows))]
            let window_handle = 0;

            let media = env::var_os("WATCHPARTY_MEDIA_TEST_FILE")
                .map(PathBuf::from)
                .ok_or_else(|| io::Error::other("WATCHPARTY_MEDIA_TEST_FILE is required"))?;
            let config = LibMpvConfig::from_env(window_handle)?;
            let test_end_file = env::var_os("WATCHPARTY_SMOKE_END_FILE").as_deref()
                == Some(std::ffi::OsStr::new("1"));
            let handle = app.handle().clone();
            let worker_outcome = Arc::clone(&setup_outcome);
            thread::Builder::new()
                .name("watchparty-libmpv-surface-smoke".into())
                .spawn(move || {
                    let result = run_smoke(&config, &media, test_end_file);
                    let exit_code = i32::from(result.is_err());
                    *worker_outcome
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
                    handle.exit(exit_code);
                })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build libmpv surface smoke application");

    let exit_code = app.run_return(|_, _| {});
    let result = outcome
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .unwrap_or_else(|| Err("smoke worker did not report a result".into()));
    match result {
        Ok(report) => println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("serialize smoke report")
        ),
        Err(error) => eprintln!("libmpv surface smoke failed: {error}"),
    }
    std::process::exit(exit_code);
}

fn run_smoke(
    config: &LibMpvConfig,
    media: &Path,
    test_end_file: bool,
) -> Result<SmokeReport, String> {
    let mut player = LibMpvPlayer::open(config).map_err(|error| error.code.to_owned())?;
    let media_value = media.to_string_lossy();
    player.load(PlaybackLoad {
        url: &media_value,
        user_agent: "pan.baidu.com",
        fallback: false,
        generation: 1,
        playlist_item_id: Some("surface-smoke"),
        basic_auth: None,
    });

    wait_for(&mut player, Duration::from_secs(30), |events, _| {
        events
            .iter()
            .any(|event| matches!(event, PlayerEvent::Loaded { generation: 1 }))
    })?;
    let loaded_state = player.state();
    let mut subtitle_selection_verified = loaded_state
        .subtitle_tracks
        .iter()
        .filter(|track| track.selected)
        .filter_map(|track| track.codec.clone())
        .collect::<Vec<_>>();
    if let Some(pgs_track) = loaded_state
        .subtitle_tracks
        .iter()
        .find(|track| track.codec.as_deref() == Some("hdmv_pgs_subtitle"))
    {
        player
            .select_subtitle(pgs_track.id)
            .map_err(|_| "SUBTITLE_SELECT_FAILED")?;
        if player
            .state()
            .subtitle_tracks
            .iter()
            .any(|track| track.selected && track.codec.as_deref() == Some("hdmv_pgs_subtitle"))
        {
            subtitle_selection_verified.push("hdmv_pgs_subtitle".into());
        }
    }
    subtitle_selection_verified.sort();
    subtitle_selection_verified.dedup();

    player.set_paused(false).map_err(|_| "PLAY_FAILED")?;
    let play_start = player.state().time;
    wait_for(&mut player, Duration::from_secs(20), |_, state| {
        state.time >= play_start + 0.25
    })?;
    let play_advanced = true;

    player.set_paused(true).map_err(|_| "PAUSE_FAILED")?;
    pump(&mut player, Duration::from_millis(150));
    let pause_applied = player.state().paused;

    let seek_target = if loaded_state.duration > 10.0 {
        10.0_f64.min(loaded_state.duration / 2.0)
    } else {
        0.0
    };
    player
        .seek_absolute(seek_target)
        .map_err(|_| "SEEK_FAILED")?;
    wait_for(&mut player, Duration::from_secs(20), |_, state| {
        (state.time - seek_target).abs() < 2.0
    })?;
    let seek_applied = true;

    player.set_rate(1.25).map_err(|_| "RATE_FAILED")?;
    pump(&mut player, Duration::from_millis(100));
    let rate_applied = (player.state().rate - 1.25).abs() < 0.01;

    player.set_volume(35.0);
    pump(&mut player, Duration::from_millis(100));
    let volume_applied = (player.state().volume - 35.0).abs() < 0.1;
    let verified_state = player.state();
    let verified_capability = player.capability();
    player.set_volume(0.0);

    let end_file = if test_end_file && loaded_state.duration > 1.0 {
        player.set_rate(2.0).map_err(|_| "RATE_FAILED")?;
        player
            .seek_absolute((loaded_state.duration - 0.75).max(0.0))
            .map_err(|_| "END_SEEK_FAILED")?;
        player.set_paused(false).map_err(|_| "PLAY_FAILED")?;
        let mut reason = None;
        wait_for(&mut player, Duration::from_secs(30), |events, _| {
            for event in events {
                if let PlayerEvent::Ended { reason: value, .. } = event {
                    reason = Some(match value {
                        PlayerEndReason::Eof => "eof",
                        PlayerEndReason::Stopped => "stopped",
                        PlayerEndReason::Error => "error",
                    });
                    return true;
                }
            }
            false
        })?;
        reason.map(String::from)
    } else {
        player.stop_playback().map_err(|_| "STOP_FAILED")?;
        let mut reason = None;
        wait_for(&mut player, Duration::from_secs(10), |events, _| {
            for event in events {
                if let PlayerEvent::Ended { reason: value, .. } = event {
                    reason = Some(match value {
                        PlayerEndReason::Eof => "eof",
                        PlayerEndReason::Stopped => "stopped",
                        PlayerEndReason::Error => "error",
                    });
                    return true;
                }
            }
            false
        })?;
        reason.map(String::from)
    };

    Ok(SmokeReport {
        file_name: media
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<non-utf8>")
            .to_owned(),
        file_loaded: true,
        play_advanced,
        pause_applied,
        seek_applied,
        rate_applied,
        volume_applied,
        subtitle_selection_verified,
        end_file,
        state: verified_state,
        capability: verified_capability,
    })
}

fn wait_for<F>(player: &mut LibMpvPlayer, timeout: Duration, mut predicate: F) -> Result<(), String>
where
    F: FnMut(&[PlayerEvent], &PlayerState) -> bool,
{
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let events = player.drain_events();
        let state = player.state();
        if events
            .iter()
            .any(|event| matches!(event, PlayerEvent::Error { .. }))
        {
            return Err("PLAYBACK_ERROR".into());
        }
        if predicate(&events, &state) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("SMOKE_TIMEOUT".into())
}

fn pump(player: &mut LibMpvPlayer, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        player.drain_events();
        thread::sleep(Duration::from_millis(25));
    }
}
