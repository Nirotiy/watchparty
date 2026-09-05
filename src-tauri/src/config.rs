use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    net::IpAddr,
    path::{Path, PathBuf},
};
use zeroize::Zeroize;

const SETTINGS_FILE: &str = "settings.json";
const CREDENTIAL_TARGET_PREFIX: &str = "WatchParty/site-basic/";
const ROOM_CREDENTIAL_TARGET_PREFIX: &str = "WatchParty/room-session/";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPreferences {
    pub hardware_decoding: String,
    pub cache_profile: String,
}

impl Default for PlayerPreferences {
    fn default() -> Self {
        Self {
            hardware_decoding: "auto-safe".into(),
            cache_profile: "auto".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub backend_origin: Option<String>,
    pub nickname: String,
    pub theme: String,
    pub player_preferences: PlayerPreferences,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            backend_origin: None,
            nickname: String::new(),
            theme: "dark".into(),
            player_preferences: PlayerPreferences::default(),
        }
    }
}

/// The sole renderer-writable input. It deliberately excludes every secret.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsInput {
    pub backend_origin: Option<String>,
    pub nickname: String,
    pub theme: String,
    pub player_preferences: PlayerPreferences,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsStatus {
    pub backend_origin: Option<String>,
    pub nickname: String,
    pub theme: String,
    pub player_preferences: PlayerPreferences,
    pub credentials_configured: bool,
}

impl DesktopSettingsStatus {
    pub fn from_settings(settings: DesktopSettings, credentials_configured: bool) -> Self {
        Self {
            backend_origin: settings.backend_origin,
            nickname: settings.nickname,
            theme: settings.theme,
            player_preferences: settings.player_preferences,
            credentials_configured,
        }
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Invalid,
    Io(io::Error),
    Decode(serde_json::Error),
    CredentialUnavailable,
    CredentialOperation,
}

impl From<io::Error> for ConfigError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ConfigError {
    fn from(error: serde_json::Error) -> Self {
        Self::Decode(error)
    }
}

/// Stores only non-sensitive desktop preferences in the app data directory.
pub struct DesktopConfigStore {
    path: PathBuf,
}

impl DesktopConfigStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            path: app_data_dir.join(SETTINGS_FILE),
        }
    }

    pub fn load(&self) -> Result<DesktopSettings, ConfigError> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DesktopSettings::default()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save(&self, input: DesktopSettingsInput) -> Result<DesktopSettings, ConfigError> {
        let settings = Self::validate(input)?;
        self.write_atomically(&settings)?;
        Ok(settings)
    }

    pub fn validate(input: DesktopSettingsInput) -> Result<DesktopSettings, ConfigError> {
        Ok(DesktopSettings {
            backend_origin: input
                .backend_origin
                .as_deref()
                .map(validate_backend_origin)
                .transpose()?,
            nickname: validate_nickname(input.nickname)?,
            theme: validate_theme(input.theme)?,
            player_preferences: validate_player_preferences(input.player_preferences)?,
        })
    }

    pub(crate) fn write_atomically(&self, settings: &DesktopSettings) -> Result<(), ConfigError> {
        let directory = self.path.parent().ok_or(ConfigError::Invalid)?;
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec(settings)?;
        let temporary = self.path.with_extension("json.tmp");
        {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(temporary, &self.path)?;
        sync_directory(directory);
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(unix)]
fn sync_directory(directory: &Path) {
    let _ = std::fs::File::open(directory).and_then(|file| file.sync_all());
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) {}

pub fn validate_backend_origin(value: &str) -> Result<String, ConfigError> {
    let parsed = reqwest::Url::parse(value.trim()).map_err(|_| ConfigError::Invalid)?;
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(ConfigError::Invalid);
    }

    let is_loopback_http = parsed.scheme() == "http"
        && parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
    if parsed.scheme() != "https" && !is_loopback_http {
        return Err(ConfigError::Invalid);
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

fn validate_nickname(value: String) -> Result<String, ConfigError> {
    let value = value.trim().to_owned();
    if value.chars().count() > 48 || value.contains(['\r', '\n', '\0']) {
        return Err(ConfigError::Invalid);
    }
    Ok(value)
}

fn validate_theme(value: String) -> Result<String, ConfigError> {
    match value.as_str() {
        "dark" | "light" => Ok(value),
        _ => Err(ConfigError::Invalid),
    }
}

fn validate_player_preferences(value: PlayerPreferences) -> Result<PlayerPreferences, ConfigError> {
    if !matches!(value.hardware_decoding.as_str(), "auto-safe" | "no")
        || !matches!(
            value.cache_profile.as_str(),
            "auto" | "low-latency" | "stable"
        )
    {
        return Err(ConfigError::Invalid);
    }
    Ok(value)
}

/// Native-only values copied from Windows Credential Manager into the runtime.
/// This type is never serializable or printable and zeroizes both strings on drop.
pub struct StoredSiteCredentials {
    pub(crate) username: String,
    pub(crate) password: String,
}

impl StoredSiteCredentials {
    pub(crate) fn into_parts(mut self) -> (String, String) {
        (
            std::mem::take(&mut self.username),
            std::mem::take(&mut self.password),
        )
    }
}

impl Drop for StoredSiteCredentials {
    fn drop(&mut self) {
        self.username.zeroize();
        self.password.zeroize();
    }
}

pub struct SiteCredentialStore;

impl SiteCredentialStore {
    pub fn has(&self, backend_origin: &str) -> Result<bool, ConfigError> {
        platform::has(credential_target(backend_origin)?.as_str())
    }

    pub fn read(&self, backend_origin: &str) -> Result<Option<StoredSiteCredentials>, ConfigError> {
        platform::read(credential_target(backend_origin)?.as_str())
    }

    /// Opens a Windows-owned password dialog. Renderer code never receives its values.
    pub fn prompt_and_store(
        &self,
        backend_origin: &str,
        owner_hwnd: isize,
    ) -> Result<bool, ConfigError> {
        platform::prompt_and_store(credential_target(backend_origin)?.as_str(), owner_hwnd)
    }

    pub fn clear(&self, backend_origin: &str) -> Result<(), ConfigError> {
        platform::clear(credential_target(backend_origin)?.as_str())
    }
}

/// Native room identity kept in Windows Credential Manager. It is never sent
/// over IPC; the renderer only observes the resulting session state.
pub struct StoredRoomSession {
    pub(crate) room_id: String,
    pub(crate) client_id: String,
    pub(crate) access_token: String,
    pub(crate) owner_token: Option<String>,
    pub(crate) generation: u64,
}

impl StoredRoomSession {
    pub(crate) fn new(
        room_id: String,
        client_id: String,
        access_token: String,
        owner_token: Option<String>,
        generation: u64,
    ) -> Result<Self, ConfigError> {
        if room_id.is_empty() || client_id.is_empty() || access_token.is_empty() || generation == 0
        {
            return Err(ConfigError::Invalid);
        }
        Ok(Self {
            room_id,
            client_id,
            access_token,
            owner_token,
            generation,
        })
    }
    pub(crate) fn parts(&self) -> (&str, &str, &str, Option<&str>, u64) {
        (
            self.room_id.as_str(),
            self.client_id.as_str(),
            self.access_token.as_str(),
            self.owner_token.as_deref(),
            self.generation,
        )
    }

    /// Replaces the persisted owner token after a cross-client transfer.
    /// Ownership is server-authoritative; this only keeps restore in sync.
    pub(crate) fn set_owner_token(&mut self, owner_token: Option<String>) {
        self.owner_token = owner_token;
    }
}

impl Drop for StoredRoomSession {
    fn drop(&mut self) {
        self.room_id.zeroize();
        self.client_id.zeroize();
        self.access_token.zeroize();
        if let Some(owner) = self.owner_token.as_mut() {
            owner.zeroize();
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomSessionBlob {
    room_id: String,
    client_id: String,
    access_token: String,
    owner_token: Option<String>,
    generation: u64,
}

#[derive(Clone, Copy)]
pub struct RoomSessionStore;

impl RoomSessionStore {
    pub fn read(&self, backend_origin: &str) -> Result<Option<StoredRoomSession>, ConfigError> {
        let blob = platform::read_blob(room_credential_target(backend_origin)?.as_str())?;
        let Some((_username, bytes)) = blob else {
            return Ok(None);
        };
        let decoded: RoomSessionBlob =
            serde_json::from_slice(&bytes).map_err(|_| ConfigError::CredentialOperation)?;
        StoredRoomSession::new(
            decoded.room_id,
            decoded.client_id,
            decoded.access_token,
            decoded.owner_token,
            decoded.generation,
        )
        .map(Some)
    }

    pub fn write(
        &self,
        backend_origin: &str,
        session: &StoredRoomSession,
    ) -> Result<(), ConfigError> {
        let (room_id, client_id, access_token, owner_token, generation) = session.parts();
        let blob = serde_json::to_vec(&RoomSessionBlob {
            room_id: room_id.into(),
            client_id: client_id.into(),
            access_token: access_token.into(),
            owner_token: owner_token.map(str::to_owned),
            generation,
        })?;
        platform::write_blob(
            room_credential_target(backend_origin)?.as_str(),
            "WatchParty Desktop",
            &blob,
        )
    }

    pub fn clear(&self, backend_origin: &str) -> Result<(), ConfigError> {
        platform::clear(room_credential_target(backend_origin)?.as_str())
    }
}

fn credential_target(backend_origin: &str) -> Result<String, ConfigError> {
    Ok(format!(
        "{CREDENTIAL_TARGET_PREFIX}{}",
        validate_backend_origin(backend_origin)?
    ))
}

fn room_credential_target(backend_origin: &str) -> Result<String, ConfigError> {
    Ok(format!(
        "{ROOM_CREDENTIAL_TARGET_PREFIX}{}",
        validate_backend_origin(backend_origin)?
    ))
}

#[cfg(windows)]
mod platform {
    use super::{ConfigError, StoredSiteCredentials};
    use std::{mem::size_of, ptr};
    use windows_sys::{
        core::PWSTR,
        Win32::{
            Foundation::GetLastError,
            Security::Credentials::{
                CredDeleteW, CredFree, CredReadW, CredUIPromptForCredentialsW, CredWriteW,
                CREDENTIALW, CREDUI_FLAGS_DO_NOT_PERSIST, CREDUI_FLAGS_GENERIC_CREDENTIALS,
                CREDUI_INFOW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            },
        },
    };
    use zeroize::Zeroize;

    const ERROR_CANCELLED: u32 = 1223;
    const ERROR_NOT_FOUND: u32 = 1168;
    const USERNAME_CAPACITY: usize = 513;
    const PASSWORD_CAPACITY: usize = 256;

    pub fn has(target: &str) -> Result<bool, ConfigError> {
        let target = wide(target);
        let mut credential = ptr::null_mut();
        let found =
            unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } != 0;
        if found {
            unsafe { CredFree(credential.cast()) };
            return Ok(true);
        }
        match unsafe { GetLastError() } {
            ERROR_NOT_FOUND => Ok(false),
            _ => Err(ConfigError::CredentialOperation),
        }
    }

    pub fn read(target: &str) -> Result<Option<StoredSiteCredentials>, ConfigError> {
        let Some((username, bytes)) = read_blob(target)? else {
            return Ok(None);
        };
        let password = String::from_utf8(bytes).map_err(|_| ConfigError::CredentialOperation)?;
        Ok(Some(StoredSiteCredentials { username, password }))
    }

    pub fn read_blob(target: &str) -> Result<Option<(String, Vec<u8>)>, ConfigError> {
        let target = wide(target);
        let mut credential = ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            return match unsafe { GetLastError() } {
                ERROR_NOT_FOUND => Ok(None),
                _ => Err(ConfigError::CredentialOperation),
            };
        }
        let result = (|| unsafe {
            let credential = &*credential;
            if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
                return Err(ConfigError::CredentialOperation);
            }
            let username = string_from_wide(credential.UserName)?;
            let bytes = std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
            .to_vec();
            Ok(Some((username, bytes)))
        })();
        unsafe { CredFree(credential.cast()) };
        result
    }

    pub fn prompt_and_store(target: &str, owner_hwnd: isize) -> Result<bool, ConfigError> {
        let target_wide = wide(target);
        let caption = wide("WatchParty 站点凭据");
        let message = wide("输入此 WatchParty 站点的 Caddy Basic Auth 凭据。");
        let mut username = vec![0u16; USERNAME_CAPACITY];
        let mut password = vec![0u16; PASSWORD_CAPACITY];
        let mut save = 0;
        let info = CREDUI_INFOW {
            cbSize: size_of::<CREDUI_INFOW>() as u32,
            hwndParent: owner_hwnd as windows_sys::Win32::Foundation::HWND,
            pszMessageText: message.as_ptr(),
            pszCaptionText: caption.as_ptr(),
            hbmBanner: ptr::null_mut(),
        };
        let status = unsafe {
            CredUIPromptForCredentialsW(
                &info,
                target_wide.as_ptr(),
                ptr::null(),
                0,
                username.as_mut_ptr(),
                username.len() as u32,
                password.as_mut_ptr(),
                password.len() as u32,
                &mut save,
                CREDUI_FLAGS_GENERIC_CREDENTIALS | CREDUI_FLAGS_DO_NOT_PERSIST,
            )
        };
        if status == ERROR_CANCELLED {
            username.zeroize();
            password.zeroize();
            return Ok(false);
        }
        if status != 0 {
            username.zeroize();
            password.zeroize();
            return Err(ConfigError::CredentialOperation);
        }
        let result = (|| {
            let mut user = string_from_buffer(&username)?;
            let mut secret = string_from_buffer(&password)?;
            if user.is_empty() || secret.is_empty() {
                user.zeroize();
                secret.zeroize();
                return Err(ConfigError::Invalid);
            }
            let result = write_blob(target, &user, secret.as_bytes());
            user.zeroize();
            secret.zeroize();
            result
        })();
        username.zeroize();
        password.zeroize();
        result.map(|()| true)
    }

    pub fn clear(target: &str) -> Result<(), ConfigError> {
        let target = wide(target);
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
            return Ok(());
        }
        match unsafe { GetLastError() } {
            ERROR_NOT_FOUND => Ok(()),
            _ => Err(ConfigError::CredentialOperation),
        }
    }

    pub fn write_blob(target: &str, username: &str, blob: &[u8]) -> Result<(), ConfigError> {
        let mut target = wide(target);
        let mut username = wide(username);
        let mut password = blob.to_vec();
        if password.len() > 16 * 1024 {
            password.zeroize();
            return Err(ConfigError::Invalid);
        }
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: password.len() as u32,
            CredentialBlob: password.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };
        let wrote = unsafe { CredWriteW(&credential, 0) } != 0;
        target.zeroize();
        username.zeroize();
        password.zeroize();
        if wrote {
            Ok(())
        } else {
            Err(ConfigError::CredentialOperation)
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn string_from_wide(value: PWSTR) -> Result<String, ConfigError> {
        if value.is_null() {
            return Err(ConfigError::CredentialOperation);
        }
        let mut length = 0usize;
        unsafe {
            while *value.add(length) != 0 {
                length += 1;
            }
            String::from_utf16(std::slice::from_raw_parts(value, length))
                .map_err(|_| ConfigError::CredentialOperation)
        }
    }

    fn string_from_buffer(value: &[u16]) -> Result<String, ConfigError> {
        let length = value
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(value.len());
        String::from_utf16(&value[..length]).map_err(|_| ConfigError::CredentialOperation)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{ConfigError, StoredSiteCredentials};

    pub fn has(_target: &str) -> Result<bool, ConfigError> {
        Err(ConfigError::CredentialUnavailable)
    }

    pub fn read(_target: &str) -> Result<Option<StoredSiteCredentials>, ConfigError> {
        Err(ConfigError::CredentialUnavailable)
    }
    pub fn read_blob(_target: &str) -> Result<Option<(String, Vec<u8>)>, ConfigError> {
        Err(ConfigError::CredentialUnavailable)
    }
    pub fn write_blob(_target: &str, _username: &str, _blob: &[u8]) -> Result<(), ConfigError> {
        Err(ConfigError::CredentialUnavailable)
    }

    pub fn prompt_and_store(_target: &str, _owner_hwnd: isize) -> Result<bool, ConfigError> {
        Err(ConfigError::CredentialUnavailable)
    }

    pub fn clear(_target: &str) -> Result<(), ConfigError> {
        Err(ConfigError::CredentialUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn store() -> DesktopConfigStore {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        DesktopConfigStore::new(std::env::temp_dir().join(format!("watchparty-config-{unique}")))
    }

    fn input(origin: &str) -> DesktopSettingsInput {
        DesktopSettingsInput {
            backend_origin: Some(origin.into()),
            nickname: "Nirotiy".into(),
            theme: "dark".into(),
            player_preferences: PlayerPreferences::default(),
        }
    }

    #[test]
    fn backend_origin_only_accepts_https_or_loopback_http() {
        for origin in [
            "https://watch.example",
            "https://watch.example:8443",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
        ] {
            assert!(validate_backend_origin(origin).is_ok(), "{origin}");
        }
        for origin in [
            "http://watch.example",
            "ftp://watch.example",
            "file:///tmp/video.mkv",
            "https://user:password@watch.example",
            "https://watch.example/path",
            "https://watch.example/?query=1",
            "https://watch.example/#fragment",
        ] {
            assert!(validate_backend_origin(origin).is_err(), "{origin}");
        }
    }

    #[test]
    fn settings_are_written_and_reloaded_without_secrets() {
        let store = store();
        let expected = store.save(input("https://watch.example")).expect("save");
        assert_eq!(store.load().expect("reload"), expected);
        let contents = fs::read_to_string(store.path()).expect("settings file");
        assert!(!contents.contains("password"));
        assert!(!contents.contains("accessToken"));
        assert!(!contents.contains("ownerToken"));
        let _ = fs::remove_dir_all(store.path().parent().expect("parent"));
    }

    #[test]
    fn preferences_can_be_saved_before_a_site_is_configured() {
        let store = store();
        let mut settings = input("https://watch.example");
        settings.backend_origin = None;
        settings.theme = "light".into();
        let saved = store.save(settings).expect("save preferences");
        assert_eq!(saved.backend_origin, None);
        assert_eq!(saved.theme, "light");
        let _ = fs::remove_dir_all(store.path().parent().expect("parent"));
    }

    #[test]
    fn settings_status_is_safe_to_serialize_over_ipc() {
        let status = DesktopSettingsStatus::from_settings(DesktopSettings::default(), true);
        let contents = serde_json::to_string(&status).expect("serialize settings status");
        for secret in [
            "password",
            "username",
            "accessToken",
            "ownerToken",
            "directUrl",
        ] {
            assert!(!contents.contains(secret), "secret field leaked: {secret}");
        }
        assert!(contents.contains("credentialsConfigured"));
    }

    #[test]
    fn invalid_settings_never_replace_the_last_known_good_file() {
        let store = store();
        let expected = store.save(input("https://watch.example")).expect("save");
        let mut invalid = input("https://watch.example");
        invalid.theme = "neon".into();
        assert!(store.save(invalid).is_err());
        assert_eq!(store.load().expect("reload"), expected);
        let _ = fs::remove_dir_all(store.path().parent().expect("parent"));
    }
}
