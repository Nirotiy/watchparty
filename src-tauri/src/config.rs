use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    net::IpAddr,
    path::{Path, PathBuf},
};
use zeroize::Zeroize;
use sha2::{Digest, Sha256};

const SETTINGS_FILE: &str = "settings.json";
const CREDENTIAL_TARGET_PREFIX: &str = "WatchParty/site-basic/";
const ROOM_CREDENTIAL_TARGET_PREFIX: &str = "WatchParty/room-session/";
const TRUST_FILE: &str = "trust.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all="camelCase")]
pub struct OriginTrustRecord { pub origin: String, pub fingerprint: String, pub pem: String }

pub struct OriginTrustStore { path: PathBuf }
#[derive(Clone, Debug, PartialEq)]
pub struct OriginTlsPolicy {
    pub origin: String,
    pub extra_pem: Option<String>,
}

impl OriginTlsPolicy {
    pub fn for_origin(store: &OriginTrustStore, origin: &str) -> Result<Self, ConfigError> {
        let origin = validate_backend_origin(origin)?;
        Ok(Self { extra_pem: store.pem_for(&origin)?, origin })
    }
    pub fn uses_extra_certificate(&self) -> bool { self.extra_pem.is_some() }
}

impl OriginTrustStore {
    pub fn new(dir: PathBuf) -> Self { Self { path: dir.join(TRUST_FILE) } }
    pub fn list(&self) -> Result<Vec<OriginTrustRecord>, ConfigError> { match fs::read(&self.path) { Ok(b)=>Ok(serde_json::from_slice(&b)?), Err(e) if e.kind()==io::ErrorKind::NotFound=>Ok(Vec::new()), Err(e)=>Err(e.into()) } }
    pub fn import(&self, origin: &str, pem: &str) -> Result<OriginTrustRecord, ConfigError> {
        let origin=validate_backend_origin(origin)?; let pem=pem.trim(); if pem.len()>200_000 || !pem.contains("-----BEGIN CERTIFICATE-----") || !pem.contains("-----END CERTIFICATE-----") { return Err(ConfigError::Invalid); }
        let mut h=Sha256::new(); h.update(pem.as_bytes()); let fingerprint=h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let rec=OriginTrustRecord{origin:origin.clone(), fingerprint, pem:pem.to_string()}; let mut all=self.list()?; all.retain(|r|r.origin!=origin); all.push(rec.clone()); self.write(&all)?; let _ = self.ca_file_for(&origin)?; Ok(rec)
    }
    pub fn delete(&self, origin: &str) -> Result<(), ConfigError> { let origin=validate_backend_origin(origin)?; let mut all=self.list()?; all.retain(|r|r.origin!=origin); self.write(&all)?; self.remove_ca_file(&origin) }
    pub fn pem_for(&self, origin: &str) -> Result<Option<String>, ConfigError> { let origin=validate_backend_origin(origin)?; Ok(self.list()?.into_iter().find(|r|r.origin==origin).map(|r|r.pem)) }
    pub fn ca_file_for(&self, origin: &str) -> Result<Option<PathBuf>, ConfigError> {
        let origin = validate_backend_origin(origin)?;
        let Some(pem) = self.pem_for(&origin)? else { return Ok(None) };
        let mut hash = Sha256::new(); hash.update(origin.as_bytes());
        let name = hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        let path = self.path.parent().unwrap_or_else(|| Path::new(".")).join("tls-trust").join(format!("{name}.pem"));
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        fs::write(&path, pem.as_bytes())?;
        Ok(Some(path))
    }
    pub fn remove_ca_file(&self, origin: &str) -> Result<(), ConfigError> {
        let origin = validate_backend_origin(origin)?;
        let mut hash = Sha256::new(); hash.update(origin.as_bytes());
        let name = hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        let path = self.path.parent().unwrap_or_else(|| Path::new(".")).join("tls-trust").join(format!("{name}.pem"));
        match fs::remove_file(path) { Ok(()) => Ok(()), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.into()) }
    }
    fn write(&self, all:&Vec<OriginTrustRecord>) -> Result<(), ConfigError> { if let Some(d)=self.path.parent(){fs::create_dir_all(d)?;} fs::write(&self.path, serde_json::to_vec(all)?)?; Ok(()) }
}

/// Whitelisted player preferences. Every field is bounded and falls back to a
/// documented default; secrets never live here. Fields absent from an older
/// settings.json deserialize to their defaults via the struct-level serde
/// default.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerPreferences {
    /// Hardware decoding: `auto-safe` | `auto` | `no`. Applies when the player
    /// is (re)created.
    pub hardware_decoding: String,
    /// Deinterlacing: `auto` | `on` | `off`. Applies immediately.
    pub deinterlace: String,
    /// HDR output handling: `auto` (mpv default) | `sdr` (deterministic
    /// tone-mapping) | `passthrough` (hint the target colorspace). Applies
    /// immediately.
    pub hdr: String,
    /// WASAPI output device. `None` means the system default; a device that
    /// disappeared falls back to the default on the next apply.
    pub audio_device: Option<String>,
    /// Channel layout: `auto` | `stereo`. No bitstream passthrough. Applies
    /// immediately.
    pub channel_layout: String,
    /// Volume applied when a player is created. 0-100.
    pub default_volume: u8,
    /// Preferred audio languages (mpv `alang`, comma separated). Applies on
    /// the next media load.
    pub audio_language: String,
    /// Preferred subtitle languages (mpv `slang`). Applies on the next load.
    pub subtitle_language: String,
    /// Subtitle font family (non-ASS text subs). Empty = mpv default.
    pub subtitle_font: String,
    /// Relative subtitle scale. 0.5-3.0, default 1.0. Applies immediately.
    pub subtitle_scale: f64,
    /// Allow our font/scale choices to override embedded ASS styles.
    pub subtitle_ass_override: bool,
    /// Subtitle delay for the current media, seconds. -30.0-30.0.
    pub subtitle_delay: f64,
    /// Cache preset: `auto` | `low-latency` | `stable`. Applies when the
    /// player is (re)created.
    pub cache_profile: String,
    /// Network timeout for media loads, seconds. 5-120, default 30. Applies
    /// on the next media load.
    pub network_timeout: u16,
}

impl Default for PlayerPreferences {
    fn default() -> Self {
        Self {
            hardware_decoding: "auto-safe".into(),
            deinterlace: "auto".into(),
            hdr: "auto".into(),
            audio_device: None,
            channel_layout: "auto".into(),
            default_volume: 100,
            audio_language: String::new(),
            subtitle_language: String::new(),
            subtitle_font: String::new(),
            subtitle_scale: 1.0,
            subtitle_ass_override: false,
            subtitle_delay: 0.0,
            cache_profile: "auto".into(),
            network_timeout: 30,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsStatus {
    pub backend_origin: Option<String>,
    pub nickname: String,
    pub theme: String,
    pub player_preferences: PlayerPreferences,
    pub credentials_configured: bool,
    /// Whitelisted properties that failed to apply to the live player; their
    /// persisted values remain in effect for the next player rebuild.
    #[serde(default)]
    pub player_preference_failures: Vec<String>,
}

impl DesktopSettingsStatus {
    pub fn from_settings(settings: DesktopSettings, credentials_configured: bool) -> Self {
        Self {
            backend_origin: settings.backend_origin,
            nickname: settings.nickname,
            theme: settings.theme,
            player_preferences: settings.player_preferences,
            credentials_configured,
            player_preference_failures: Vec::new(),
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
    let valid = matches!(
        value.hardware_decoding.as_str(),
        "auto-safe" | "auto" | "no"
    ) && matches!(value.deinterlace.as_str(), "auto" | "on" | "off")
        && matches!(value.hdr.as_str(), "auto" | "sdr" | "passthrough")
        && matches!(value.channel_layout.as_str(), "auto" | "stereo")
        && value.default_volume <= 100
        && (0.5..=3.0).contains(&value.subtitle_scale)
        && (-30.0..=30.0).contains(&value.subtitle_delay)
        && matches!(
            value.cache_profile.as_str(),
            "auto" | "low-latency" | "stable"
        )
        && (5..=120).contains(&value.network_timeout)
        && value.audio_device.as_ref().is_none_or(|device| {
            !device.is_empty() && device.chars().count() <= 256 && !device.contains('\0')
        })
        && [
            value.audio_language.as_str(),
            value.subtitle_language.as_str(),
            value.subtitle_font.as_str(),
        ]
        .iter()
        .all(|field| field.chars().count() <= 128 && !field.contains(['\r', '\n', '\0']));
    if !valid {
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

/// One origin-scoped generic credential containing UTF-8 JSON with MP_SESSION and MP_CSRF.
/// Login provisioning is native-only; there is deliberately no credential-writing IPC.
pub struct MusicPartyCredentialStore;

#[cfg(all(test, windows))]
#[test]
fn musicparty_credential_read_and_clear_are_origin_scoped() {
    use std::{io::{BufRead, BufReader, Write}, net::TcpListener};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let target = MusicPartyCredentialStore::target(&origin).unwrap();
    struct Cleanup(String);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = platform::clear(&self.0); } }
    let _cleanup = Cleanup(target.clone());
    platform::write_blob(&target, "MusicParty", br#"{"MP_SESSION":"test-session-secret","MP_CSRF":"test-csrf-secret"}"#).unwrap();
    let session = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
    assert_eq!(session.session, "test-session-secret");
    assert_eq!(session.csrf, "test-csrf-secret");
    drop(session);
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(&stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
                headers.push_str(&line);
            }
            requests.push(headers.to_ascii_lowercase());
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\nSet-Cookie: MP_SESSION=stale\r\n\r\n{}").unwrap();
        }
        requests
    });
    let bridge = crate::musicparty::MusicPartyBridge::default();
    let input = || crate::musicparty::MusicPartyRequest {
        origin: origin.clone(), path: "/api/desktop/v1/invites/redeem".into(),
        method: "POST".into(), body: None, client_version: "0.2.0".into(),
    };
    assert_eq!(bridge.request(input()).unwrap().status, 200);
    bridge.clear(&origin).unwrap();
    assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
    assert!(matches!(bridge.request(input()), Err(error) if error == "musicparty_credentials_failed"));
    let requests = server.join().unwrap();
    assert!(requests[0].contains("cookie: mp_session=test-session-secret"));
    assert!(requests[0].contains("x-csrf-token: test-csrf-secret"));
    assert!(!requests[1].contains("cookie:"));
    assert!(!requests[1].contains("x-csrf-token:"));
    MusicPartyCredentialStore.clear(&origin).unwrap();
}

impl MusicPartyCredentialStore {
    pub fn write(&self, origin: &str, session: &crate::http::MusicPartySession) -> Result<(), ConfigError> {
        if session.session.is_empty() || session.csrf.is_empty() { return Err(ConfigError::CredentialOperation); }
        #[derive(Serialize)] struct Blob<'a> { #[serde(rename="MP_SESSION")] session: &'a str, #[serde(rename="MP_CSRF")] csrf: &'a str, #[serde(rename="MP_ROOM_ACCESS", skip_serializing_if="Option::is_none")] room_access: Option<&'a str> }
        let blob = Blob { session: &session.session, csrf: &session.csrf, room_access: session.room_access.as_deref() };
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&blob).map_err(|_| ConfigError::CredentialOperation)?);
        platform::write_blob(&Self::target(origin)?, "MusicParty", &bytes)
    }
    fn target(origin: &str) -> Result<String, ConfigError> {
        Ok(format!("MusicParty Desktop/session/{}", validate_backend_origin(origin)?))
    }

    pub fn read(&self, origin: &str) -> Result<Option<crate::http::MusicPartySession>, ConfigError> {
        let Some((mut username, bytes)) = platform::read_blob(&Self::target(origin)?)? else { return Ok(None) };
        username.zeroize();
        let bytes = zeroize::Zeroizing::new(bytes);
        #[derive(Deserialize)]
        struct SessionBlob {
            #[serde(rename = "MP_SESSION")]
            session: String,
            #[serde(rename = "MP_CSRF")]
            csrf: String,
            #[serde(rename = "MP_ROOM_ACCESS", default)]
            room_access: Option<String>,
        }
        impl Drop for SessionBlob {
            fn drop(&mut self) { self.session.zeroize(); self.csrf.zeroize(); if let Some(value) = &mut self.room_access { value.zeroize(); } }
        }
        let mut blob: SessionBlob = serde_json::from_slice(&bytes).map_err(|_| ConfigError::CredentialOperation)?;
        let mut session = crate::http::MusicPartySession::new(std::mem::take(&mut blob.session), std::mem::take(&mut blob.csrf));
        if let Some(room_access) = blob.room_access.take() { session = session.with_room_access(room_access); }
        Ok(Some(session))
    }

    pub fn clear(&self, origin: &str) -> Result<(), ConfigError> {
        platform::clear(&Self::target(origin)?)
    }
}

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

    #[test]
    fn origin_tls_policy_is_scoped_and_defaults_to_system_chain() {
        let dir = std::env::temp_dir().join(format!("watchparty-tls-policy-{}", uuid::Uuid::new_v4()));
        let store = OriginTrustStore::new(dir.clone());
        assert!(!OriginTlsPolicy::for_origin(&store, "https://a.example").unwrap().uses_extra_certificate());
        store.import("https://a.example", "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----").unwrap();
        assert!(OriginTlsPolicy::for_origin(&store, "https://a.example").unwrap().uses_extra_certificate());
        assert!(!OriginTlsPolicy::for_origin(&store, "https://b.example").unwrap().uses_extra_certificate());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn origin_trust_ca_file_lifecycle_is_replaceable_and_removable() {
        let dir = std::env::temp_dir().join(format!("watchparty-tls-ca-{}", uuid::Uuid::new_v4()));
        let store = OriginTrustStore::new(dir.clone());
        store.import("https://a.example", "-----BEGIN CERTIFICATE-----\na\n-----END CERTIFICATE-----").unwrap();
        let first = store.ca_file_for("https://a.example").unwrap().unwrap();
        assert_eq!(fs::read_to_string(&first).unwrap(), "-----BEGIN CERTIFICATE-----\na\n-----END CERTIFICATE-----");
        store.import("https://a.example", "-----BEGIN CERTIFICATE-----\nb\n-----END CERTIFICATE-----").unwrap();
        assert_eq!(fs::read_to_string(store.ca_file_for("https://a.example").unwrap().unwrap()).unwrap(), "-----BEGIN CERTIFICATE-----\nb\n-----END CERTIFICATE-----");
        store.delete("https://a.example").unwrap();
        assert!(!first.exists());
        let _ = fs::remove_dir_all(dir);
    }

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
    fn player_preferences_enforce_whitelists_ranges_and_defaults() {
        let base = PlayerPreferences::default();
        // Defaults always validate.
        assert!(validate_player_preferences(base.clone()).is_ok());
        // Hardware decoding gained `auto` in Gate 6.
        let mut value = base.clone();
        value.hardware_decoding = "auto".into();
        assert!(validate_player_preferences(value.clone()).is_ok());
        value.hardware_decoding = "force".into();
        assert!(validate_player_preferences(value).is_err());
        for field in ["deinterlace", "hdr", "channel_layout", "cache_profile"] {
            let mut value = base.clone();
            match field {
                "deinterlace" => value.deinterlace = "sometimes".into(),
                "hdr" => value.hdr = "none".into(),
                "channel_layout" => value.channel_layout = "7.1".into(),
                _ => value.cache_profile = "aggressive".into(),
            }
            assert!(validate_player_preferences(value).is_err(), "{field}");
        }
        let mut value = base.clone();
        value.default_volume = 101;
        assert!(validate_player_preferences(value).is_err());
        let mut value = base.clone();
        value.subtitle_scale = 5.0;
        assert!(validate_player_preferences(value).is_err());
        let mut value = base.clone();
        value.subtitle_delay = 31.0;
        assert!(validate_player_preferences(value).is_err());
        let mut value = base.clone();
        value.network_timeout = 4;
        assert!(validate_player_preferences(value).is_err());
        let mut value = base.clone();
        value.audio_device = Some("wasapi\0inject".into());
        assert!(validate_player_preferences(value).is_err());
        let mut value = base.clone();
        value.subtitle_font = "line
break"
            .into();
        assert!(validate_player_preferences(value).is_err());
        // Older settings.json files without the new fields deserialize to defaults.
        let legacy: DesktopSettings = serde_json::from_str(
            r#"{"backendOrigin":null,"nickname":"","theme":"dark","playerPreferences":{"hardwareDecoding":"no","cacheProfile":"stable"}}"#,
        )
        .expect("legacy settings parse");
        assert_eq!(legacy.player_preferences.deinterlace, "auto");
        assert_eq!(legacy.player_preferences.network_timeout, 30);
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
