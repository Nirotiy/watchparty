//! Exercises the real Tauri player window without requiring a room or media source.

use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{window::WindowBuilder, LogicalSize, Manager, Window};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowReport {
    resize: bool,
    maximize: bool,
    fullscreen: bool,
    hide_show: bool,
    focus_requested: bool,
    focus_observed: bool,
    scale_factor: f64,
    monitor_count: usize,
    current_monitor: bool,
}

fn main() {
    let outcome = Arc::new(Mutex::new(None::<Result<WindowReport, String>>));
    let setup_outcome = Arc::clone(&outcome);
    let app = tauri::Builder::default()
        .setup(move |app| {
            if let Some(main) = app.get_webview_window("main") {
                main.hide()?;
            }
            let window = WindowBuilder::new(app, "desktop-window-smoke")
                .title("WatchParty window smoke")
                .inner_size(960.0, 540.0)
                .min_inner_size(640.0, 360.0)
                .visible(true)
                .build()?;
            let handle = app.handle().clone();
            let worker_outcome = Arc::clone(&setup_outcome);
            thread::Builder::new()
                .name("watchparty-desktop-window-smoke".into())
                .spawn(move || {
                    let result = exercise_window(&window);
                    let exit_code = i32::from(result.is_err());
                    *worker_outcome
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
                    let _ = window.destroy();
                    handle.exit(exit_code);
                })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build desktop window smoke application");

    let _ = app.run_return(|_, _| {});
    let result = outcome
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .unwrap_or_else(|| Err("window smoke did not report a result".into()));
    let exit_code = match result {
        Ok(report) => {
            println!(
                "WATCHPARTY_WINDOW_PASS {}",
                serde_json::to_string(&report).expect("serialize window report")
            );
            0
        }
        Err(error) => {
            eprintln!("WATCHPARTY_WINDOW_FAIL {error}");
            1
        }
    };
    std::process::exit(exit_code);
}

fn exercise_window(window: &Window) -> Result<WindowReport, String> {
    let scale_factor = window.scale_factor().map_err(display_error)?;
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("window reported an invalid scale factor".into());
    }
    let monitor_count = window.available_monitors().map_err(display_error)?.len();
    let current_monitor = window.current_monitor().map_err(display_error)?.is_some();
    if monitor_count == 0 || !current_monitor {
        return Err("window is not attached to a Windows monitor".into());
    }

    window
        .set_size(LogicalSize::new(840.0, 472.0))
        .map_err(display_error)?;
    let resize = wait_until(|| {
        window.inner_size().is_ok_and(|size| {
            is_close(size.width as f64, 840.0 * scale_factor, scale_factor * 3.0)
                && is_close(size.height as f64, 472.0 * scale_factor, scale_factor * 3.0)
        })
    });

    window.maximize().map_err(display_error)?;
    let maximize = wait_until(|| window.is_maximized().unwrap_or(false));
    window.unmaximize().map_err(display_error)?;
    if !wait_until(|| !window.is_maximized().unwrap_or(true)) {
        return Err("player window did not leave maximized state".into());
    }

    window.set_fullscreen(true).map_err(display_error)?;
    let fullscreen = wait_until(|| window.is_fullscreen().unwrap_or(false));
    window.set_fullscreen(false).map_err(display_error)?;
    if !wait_until(|| !window.is_fullscreen().unwrap_or(true)) {
        return Err("player window did not leave fullscreen state".into());
    }

    window.hide().map_err(display_error)?;
    let hidden = wait_until(|| !window.is_visible().unwrap_or(true));
    window.show().map_err(display_error)?;
    let visible = wait_until(|| window.is_visible().unwrap_or(false));
    window.set_focus().map_err(display_error)?;
    let focus_observed = wait_until(|| window.is_focused().unwrap_or(false));

    let report = WindowReport {
        resize,
        maximize,
        fullscreen,
        hide_show: hidden && visible,
        focus_requested: true,
        focus_observed,
        scale_factor,
        monitor_count,
        current_monitor,
    };
    if !report.resize || !report.maximize || !report.fullscreen || !report.hide_show {
        return Err(format!(
            "transitions incomplete: resize={}, maximize={}, fullscreen={}, hideShow={}",
            report.resize, report.maximize, report.fullscreen, report.hide_show
        ));
    }
    Ok(report)
}

fn wait_until(predicate: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

fn is_close(value: f64, expected: f64, tolerance: f64) -> bool {
    (value - expected).abs() <= tolerance
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
