#![windows_subsystem = "windows"]

use std::{env, io, os::windows::process::CommandExt, process::Command};

fn run() -> io::Result<i32> {
    let executable = env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("launcher_directory_missing"))?;
    // These settings must reach Chromium before Electron loads the main module.
    let status = Command::new(directory.join("watchparty-runtime.exe"))
        .args(env::args_os().skip(1))
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("WATCHPARTY_LOCAL_LAUNCH")
        .env("WATCHPARTY_PORTABLE_LAUNCHER", &executable)
        .current_dir(directory)
        .creation_flags(0x08000000)
        .status()?;
    Ok(status.code().unwrap_or(1))
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(_) => {
            eprintln!("watchparty_runtime_launch_failed");
            // A double-click has no terminal in which to display a missing runtime.
            if env::args_os().len() == 1 {
                #[link(name = "user32")]
                unsafe extern "system" {
                    fn MessageBoxW(
                        window: isize,
                        text: *const u16,
                        caption: *const u16,
                        kind: u32,
                    ) -> i32;
                }
                let text: Vec<u16> =
                    "Unable to start Banguru. Extract the complete ZIP before launching.\0"
                        .encode_utf16()
                        .collect();
                let caption: Vec<u16> = "Banguru\0".encode_utf16().collect();
                unsafe {
                    MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10);
                }
            }
            std::process::exit(1);
        }
    }
}
