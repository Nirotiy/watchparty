use crate::config::{validate_backend_origin_with_policy, ConfigError};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::{self, Write}, path::PathBuf};
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalSecretStatus {
    pub configured: bool,
    pub mask: Option<&'static str>,
}

#[derive(Default, Deserialize, Serialize)]
struct Secrets { secrets: BTreeMap<String, String> }
impl Drop for Secrets {
    fn drop(&mut self) { for secret in self.secrets.values_mut() { secret.zeroize(); } }
}

/// Native-only, origin-scoped storage. It is never loaded into process environment or renderer settings.
pub struct ApprovalSecretStore { path: PathBuf }
impl ApprovalSecretStore {
    pub fn new(directory: PathBuf) -> Self { Self { path: directory.join("catalog-approval-secrets.json") } }

    fn load(&self) -> Result<Secrets, ConfigError> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&Zeroizing::new(bytes)).map_err(|_| ConfigError::CredentialOperation),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Secrets::default()),
            Err(_) => Err(ConfigError::CredentialOperation),
        }
    }

    pub fn read(&self, origin: &str, allow_http: bool) -> Result<Option<Zeroizing<String>>, ConfigError> {
        let origin = validate_backend_origin_with_policy(origin, allow_http)?;
        Ok(self.load()?.secrets.get(&origin).map(|secret| Zeroizing::new(secret.clone())))
    }

    pub fn status(&self, origin: &str, allow_http: bool) -> Result<ApprovalSecretStatus, ConfigError> {
        let configured = self.read(origin, allow_http)?.is_some();
        Ok(ApprovalSecretStatus { configured, mask: configured.then_some("••••••••") })
    }

    pub fn write(&self, origin: &str, allow_http: bool, secret: Zeroizing<String>) -> Result<ApprovalSecretStatus, ConfigError> {
        let origin = validate_backend_origin_with_policy(origin, allow_http)?;
        if secret.is_empty() || secret.len() > 4096 || !secret.bytes().all(|byte| (33..=126).contains(&byte)) {
            return Err(ConfigError::Invalid);
        }
        let mut all = self.load()?;
        if let Some(mut old) = all.secrets.insert(origin.clone(), secret.to_string()) { old.zeroize(); }
        let bytes = Zeroizing::new(serde_json::to_vec(&all).map_err(|_| ConfigError::CredentialOperation)?);
        let parent = self.path.parent().ok_or(ConfigError::CredentialOperation)?;
        fs::create_dir_all(parent).map_err(|_| ConfigError::CredentialOperation)?;
        let temporary = parent.join(format!(".approval-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result.map_err(|_| ConfigError::CredentialOperation)?;
        self.status(&origin, allow_http)
    }
}

pub fn is_approval_route(method: &str, path: &str) -> bool {
    matches!((method, path.split('/').collect::<Vec<_>>().as_slice()),
        ("POST", ["", "api", "admin", "media-libraries", id, "approval"])
        if !id.is_empty() && *id != "." && *id != ".." && !id.contains(['?', '#', '\\']))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secret_is_scoped_and_readback_is_only_a_fixed_mask() {
        let dir = std::env::temp_dir().join(format!("approval-test-{}", uuid::Uuid::new_v4()));
        let store = ApprovalSecretStore::new(dir.clone());
        let origin = "http://127.0.0.1:18080";
        let status = store.write(origin, false, Zeroizing::new("test-only-key".into())).unwrap();
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("test-only-key"));
        assert!(status.configured);
        assert!(store.read("http://127.0.0.1:18081", false).unwrap().is_none());
        store.write(origin, false, Zeroizing::new("replacement-test-key".into())).unwrap();
        assert!(store.read(origin, false).unwrap().is_some_and(|key| key.as_str() == "replacement-test-key"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_exact_approval_post_can_receive_secret() {
        assert!(is_approval_route("POST", "/api/admin/media-libraries/lib_x/approval"));
        for path in ["/api/admin/media-libraries/lib_x/approval/revoke", "/api/admin/media-libraries/lib_x/apply-approved", "/api/admin/media-libraries/lib_x/scan", "/api/admin/media-libraries/../approval", "/api/admin/media-libraries/lib_x/approval?x=1"] {
            assert!(!is_approval_route("POST", path));
        }
        assert!(!is_approval_route("GET", "/api/admin/media-libraries/lib_x/approval"));
    }
}
