fn main() {
    let mut args = std::env::args_os().skip(1);
    let directory = args.next().map(std::path::PathBuf::from);
    let hwnd = args.next().and_then(|v| v.to_str()?.parse::<isize>().ok());
    if args.next().is_some() || directory.is_none() || hwnd.is_none() {
        eprintln!("invalid_sidecar_configuration");
        std::process::exit(2);
    }
    if watchparty_desktop::sidecar::run(directory.unwrap(), hwnd.unwrap()).is_err() {
        // Never log request payloads, origins, credentials or upstream errors.
        eprintln!("desktop_sidecar_failed");
        std::process::exit(1);
    }
}
