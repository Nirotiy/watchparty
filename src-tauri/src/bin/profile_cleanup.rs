#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 || args[0] != "--purge-installed-profile" {
        eprintln!("explicit_installed_profile_purge_required");
        std::process::exit(2);
    }
    #[cfg(windows)]
    match watchparty_desktop::installed_profile::purge() {
        Ok(()) => println!("BANGURU_INSTALLED_PROFILE_REMOVED"),
        Err(error) => {
            let code = if error.raw_os_error() == Some(32) {
                "installed_profile_in_use"
            } else { "installed_profile_cleanup_failed" };
            eprintln!("{code}");
            std::process::exit(1);
        }
    }
    #[cfg(not(windows))]
    std::process::exit(2);
}
