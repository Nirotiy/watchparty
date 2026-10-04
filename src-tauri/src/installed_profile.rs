use std::{fs, io, path::PathBuf};

pub const CREDENTIAL_PREFIX: &str = "Banguru/installed/";

pub fn is_installed() -> bool {
    std::env::var("WATCHPARTY_INSTALLED_PROFILE").as_deref() == Ok("1")
}

pub fn credential_prefix(legacy: &str, installed_suffix: &str) -> String {
    if is_installed() {
        format!("{CREDENTIAL_PREFIX}{installed_suffix}")
    } else {
        legacy.to_owned()
    }
}

pub fn data_directory() -> io::Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| io::Error::other("installed_profile_path_missing"))?;
    Ok(local.join("Banguru").join("User Data"))
}

#[cfg(windows)]
fn reject_reparse_point(path: &std::path::Path) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => {
            Err(io::Error::other("installed_profile_reparse_point"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn lock_at(parent: &std::path::Path) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    reject_reparse_point(parent)?;
    fs::create_dir_all(parent)?;
    // Exclusive sharing and delete-on-close avoid both concurrent purges and stale crash locks.
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .truncate(false)
        .access_mode(0x80000000 | 0x40000000 | 0x00010000)
        .share_mode(0)
        .custom_flags(0x04000000)
        .create(true)
        .open(parent.join("installed-profile.lock"))
}

/// Hold this guard throughout the installed sidecar's lifetime or an uninstall purge.
#[cfg(windows)]
pub fn lock() -> io::Result<fs::File> {
    let directory = data_directory()?;
    lock_at(directory.parent().unwrap())
}

/// Called only by the uninstall helper after the user selects complete removal.
#[cfg(windows)]
pub fn purge() -> io::Result<()> {
    let directory = data_directory()?;
    let _guard = lock()?;
    reject_reparse_point(&directory)?;
    crate::config::clear_installed_credentials()
        .map_err(|_| io::Error::other("installed_credentials_cleanup_failed"))?;
    remove_data(&directory)
}

#[cfg(any(windows, test))]
fn remove_data(directory: &std::path::Path) -> io::Result<()> {
    match fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn installed_profile_lock_blocks_cleanup_until_client_exits() {
        let parent = std::env::temp_dir().join(format!("banguru-lock-{}", uuid::Uuid::new_v4()));
        let guard = lock_at(&parent).unwrap();
        assert!(lock_at(&parent).is_err());
        drop(guard);
        let next = lock_at(&parent).unwrap();
        drop(next);
        assert!(!parent.join("installed-profile.lock").exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn complete_removal_leaves_other_profiles_and_installation_intact() {
        let parent = std::env::temp_dir().join(format!("banguru-purge-{}", uuid::Uuid::new_v4()));
        let directory = parent.join("User Data");
        fs::create_dir_all(directory.join("Cache")).unwrap();
        fs::write(directory.join("settings.json"), b"{}").unwrap();
        fs::write(directory.join("Cache").join("cached"), b"data").unwrap();
        fs::write(parent.join("other-profile"), b"retain").unwrap();
        remove_data(&directory).unwrap();
        remove_data(&directory).unwrap();
        assert!(parent.join("other-profile").exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
