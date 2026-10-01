use crate::{
    contracts::{CommandAck, DesktopCommand, MediaDirectoryPage, MediaSource, RoomMember},
    transport::{
        DesktopCapabilities, DesktopProbeReport, DesktopReadinessReport, Handoff, RequestTiming,
        ResolvedMedia, RoomTransport, SnapshotResponse, SubtitleTrackInfo, TransportError,
    },
};
use reqwest::{
    blocking::{Client, RequestBuilder},
    header::HeaderValue,
};
use serde::de::DeserializeOwned;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroize;

const WATCHPARTY_TOKEN_HEADER: &str = "X-WatchParty-Token";
const MUSICPARTY_CSRF_HEADER: &str = "X-CSRF-Token";
const WATCHPARTY_PROTOCOL_VERSION: u32 = 2;
/// The library route caps artwork at 2 MiB; keep headroom for a wrapper's own padding.
const ARTWORK_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHealthResponse {
    status: String,
    protocol_version: u32,
    service_version: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCapabilitiesResponse {
    protocol_version: u32,
    service_version: String,
    capabilities: DesktopCapabilities,
}

fn classify_probe_network_error(error: reqwest::Error) -> TransportError {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    classify_probe_network_message(&message)
}

fn classify_probe_network_message(message: &str) -> TransportError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("dns") || lower.contains("name or service not known") || lower.contains("no such host") || lower.contains("host not found") {
        TransportError::DnsFailed
    } else if lower.contains("refused") {
        TransportError::ConnectionRefused
    } else if lower.contains("certificate") || lower.contains("certificat") || lower.contains("tls") || lower.contains("unknownissuer") {
        TransportError::TlsTrustRequired
    } else {
        TransportError::Network(message.to_owned())
    }
}

fn probe_http_error(
    status: reqwest::StatusCode,
    body: &str,
    credentials_configured: bool,
) -> TransportError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED if credentials_configured => TransportError::AuthRejected,
        reqwest::StatusCode::UNAUTHORIZED => TransportError::AuthRequired,
        reqwest::StatusCode::FORBIDDEN => TransportError::AuthRejected,
        reqwest::StatusCode::UPGRADE_REQUIRED => TransportError::ProtocolVersionMismatch,
        _ if body.contains("PROTOCOL_VERSION_MISMATCH") => TransportError::ProtocolVersionMismatch,
        _ if body.contains("AUTH_REQUIRED") => TransportError::AuthRequired,
        _ if body.contains("AUTH_REJECTED") => TransportError::AuthRejected,
        _ => TransportError::Http(status.as_u16(), body.to_owned()),
    }
}

fn unauthorized_error(body: String) -> TransportError {
    let code = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("code").and_then(serde_json::Value::as_str).map(str::to_owned));
    match code {
        Some(code) if code == "ROOM_PIN_REQUIRED" || code == "ROOM_PIN_REJECTED" => {
            TransportError::Http(reqwest::StatusCode::UNAUTHORIZED.as_u16(), body)
        }
        _ => TransportError::Unauthorized,
    }
}

/// Native MusicParty session credentials. Cookie values never leave Rust.
pub struct MusicPartySession {
    pub(crate) session: String,
    pub(crate) csrf: String,
    pub(crate) room_access: Option<String>,
}

impl MusicPartySession {
    pub fn new(session: impl Into<String>, csrf: impl Into<String>) -> Self {
        Self { session: session.into(), csrf: csrf.into(), room_access: None }
    }

    pub fn with_room_access(mut self, value: impl Into<String>) -> Self {
        self.room_access = Some(value.into());
        self
    }

    pub fn apply(&self, request: RequestBuilder, state_changing: bool) -> Result<RequestBuilder, TransportError> {
        let mut cookie_value = format!("MP_SESSION={}; MP_CSRF={}", self.session, self.csrf);
        if let Some(room_access) = &self.room_access { cookie_value.push_str("; MP_ROOM_ACCESS="); cookie_value.push_str(room_access); }
        let cookie = zeroize::Zeroizing::new(cookie_value);
        let mut cookie_header = HeaderValue::from_bytes(cookie.as_bytes())
            .map_err(|_| TransportError::Protocol("invalid MusicParty cookie".into()))?;
        cookie_header.set_sensitive(true);
        let request = request.header(reqwest::header::COOKIE, cookie_header);
        if !state_changing { return Ok(request); }
        let mut csrf = HeaderValue::from_bytes(self.csrf.as_bytes())
            .map_err(|_| TransportError::Protocol("invalid MusicParty CSRF token".into()))?;
        csrf.set_sensitive(true);
        Ok(request.header(MUSICPARTY_CSRF_HEADER, csrf))
    }
}

impl Drop for MusicPartySession {
    fn drop(&mut self) { self.session.zeroize(); self.csrf.zeroize(); if let Some(value) = &mut self.room_access { value.zeroize(); } }
}

fn room_token_header(token: &str) -> Result<HeaderValue, TransportError> {
    let mut value = HeaderValue::from_bytes(token.as_bytes())
        .map_err(|_| TransportError::Protocol("invalid room token".into()))?;
    value.set_sensitive(true);
    Ok(value)
}

fn owner_token_header(token: &str) -> Result<HeaderValue, TransportError> {
    let mut value = HeaderValue::from_bytes(token.as_bytes())
        .map_err(|_| TransportError::Protocol("invalid owner token".into()))?;
    value.set_sensitive(true);
    Ok(value)
}

fn command_body(command: &DesktopCommand, expected_revision: u64) -> serde_json::Value {
    let mut value = serde_json::to_value(command).expect("desktop commands are serializable");
    value
        .as_object_mut()
        .expect("desktop command must be an object")
        .insert(
            "expectedRevision".into(),
            serde_json::json!(expected_revision),
        );
    value
}

/// Site-level Basic Auth stays in the native process and is never serialized.
pub struct SiteBasicAuth {
    username: String,
    password: String,
}

impl SiteBasicAuth {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            password: password.into(),
        }
    }
}

impl Drop for SiteBasicAuth {
    fn drop(&mut self) {
        self.username.zeroize();
        self.password.zeroize();
    }
}

/// Real HTTP implementation for the Gate 1 desktop protocol. Sensitive values stay in this type.
pub struct DesktopHttpTransport {
    base_url: String,
    client: Client,
    approval_client: Client,
    site_basic_auth: Option<SiteBasicAuth>,
}

impl DesktopHttpTransport {
    pub fn new(base_url: impl Into<String>) -> Result<Self, TransportError> {
        Self::new_with_policy(base_url, false)
    }

    pub fn new_with_policy(base_url: impl Into<String>, allow_remote_http: bool) -> Result<Self, TransportError> {
        Self::with_auth(base_url, None, allow_remote_http)
    }

    pub fn with_site_basic_auth(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Result<Self, TransportError> {
        Self::with_site_basic_auth_with_policy(base_url, username, password, false)
    }

    pub fn with_site_basic_auth_with_policy(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
        allow_remote_http: bool,
    ) -> Result<Self, TransportError> {
        Self::with_auth(base_url, Some(SiteBasicAuth::new(username, password)), allow_remote_http)
    }

    fn with_auth(
        base_url: impl Into<String>,
        site_basic_auth: Option<SiteBasicAuth>,
        allow_remote_http: bool,
    ) -> Result<Self, TransportError> {
        let base_url = base_url.into();
        crate::config::validate_backend_origin_with_policy(&base_url, allow_remote_http)
            .map_err(|_| TransportError::Protocol("invalid backend origin".into()))?;
        let client = Self::build_client(&base_url, None, false)?;
        let approval_client = Self::build_client(&base_url, None, true)?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').into(),
            client,
            approval_client,
            site_basic_auth,
        })
    }

    fn build_client(base_url: &str, extra_pem: Option<&str>, no_redirect: bool) -> Result<Client, TransportError> {
        let mut builder = Client::builder()
            .cookie_store(true)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15));
        if let Some(pem) = extra_pem {
            let certificates = reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|_| TransportError::Protocol("invalid origin certificate".into()))?;
            if certificates.is_empty() {
                return Err(TransportError::Protocol("empty origin certificate".into()));
            }
            for certificate in certificates { builder = builder.add_root_certificate(certificate); }
            let origin = reqwest::Url::parse(base_url)
                .map_err(|_| TransportError::Protocol("invalid backend origin".into()))?.origin();
            // A private root is trusted only for this origin, including redirects.
            builder = builder.redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.url().origin() != origin { attempt.stop() }
                else if attempt.previous().len() >= 10 { attempt.error("too many redirects") }
                else { attempt.follow() }
            }));
        }
        if no_redirect { builder = builder.redirect(reqwest::redirect::Policy::none()); }
        builder.build().map_err(|error| TransportError::Network(error.to_string()))
    }

    pub fn with_origin_trust(mut self, store: &crate::config::OriginTrustStore) -> Result<Self, TransportError> {
        let pem = if self.base_url.starts_with("https://") {
            store.pem_for(&self.base_url)
                .map_err(|_| TransportError::Protocol("origin trust unavailable".into()))?
        } else { None };
        self.client = Self::build_client(&self.base_url, pem.as_deref(), false)?;
        self.approval_client = Self::build_client(&self.base_url, pem.as_deref(), true)?;
        Ok(self)
    }

    pub fn clear_site_basic_auth(&mut self) {
        self.site_basic_auth = None;
    }

    pub fn has_site_basic_auth(&self) -> bool {
        self.site_basic_auth.is_some()
    }

    pub fn probe_desktop_backend(&self) -> Result<DesktopProbeReport, TransportError> {
        let health_response = self
            .headers(
                self.client
                    .get(format!("{}/api/desktop/health", self.base_url)),
                None,
            )
            .send()
            .map_err(classify_probe_network_error)?;
        let health_status = health_response.status();
        if !health_status.is_success() {
            // A body that cannot be read is a transport failure. Swallowing it here used to turn a
            // hiccup into AuthRequired, i.e. the shell blamed the user's credentials.
            let body = health_response
                .text()
                .map_err(classify_probe_network_error)?;
            return Err(probe_http_error(
                health_status,
                &body,
                self.site_basic_auth.is_some(),
            ));
        }
        let health: DesktopHealthResponse = health_response
            .json()
            .map_err(|error| TransportError::Protocol(error.to_string()))?;
        if health.protocol_version != WATCHPARTY_PROTOCOL_VERSION {
            return Err(TransportError::ProtocolVersionMismatch);
        }
        if health.status != "ok" || health.service_version.is_empty() {
            return Err(TransportError::Protocol(
                "invalid desktop health response".into(),
            ));
        }

        let capabilities_response = self
            .headers(
                self.client
                    .get(format!("{}/api/desktop/capabilities", self.base_url)),
                None,
            )
            .send()
            .map_err(classify_probe_network_error)?;
        let capabilities_status = capabilities_response.status();
        if !capabilities_status.is_success() {
            let body = capabilities_response
                .text()
                .map_err(classify_probe_network_error)?;
            return Err(probe_http_error(
                capabilities_status,
                &body,
                self.site_basic_auth.is_some(),
            ));
        }
        let capabilities: DesktopCapabilitiesResponse = capabilities_response
            .json()
            .map_err(|error| TransportError::Protocol(error.to_string()))?;
        if capabilities.protocol_version != WATCHPARTY_PROTOCOL_VERSION {
            return Err(TransportError::ProtocolVersionMismatch);
        }
        if capabilities.service_version.is_empty() || capabilities.service_version != health.service_version {
            return Err(TransportError::Protocol(
                "desktop health and capabilities service versions differ".into(),
            ));
        }
        Ok(DesktopProbeReport {
            status: health.status,
            protocol_version: health.protocol_version,
            service_version: capabilities.service_version,
            capabilities: capabilities.capabilities,
        })
    }

    /// Fetches the readiness payload when the backend advertises it. A backend
    /// without the capability bit, or any transport hiccup on this optional
    /// probe, yields `Ok(None)`: absent readiness is not a degraded backend.
    pub fn probe_desktop_readiness(
        &self,
        advertised: bool,
    ) -> Result<Option<DesktopReadinessReport>, TransportError> {
        if !advertised {
            return Ok(None);
        }
        let response = match self
            .headers(
                self.client
                    .get(format!("{}/api/desktop/readiness", self.base_url)),
                None,
            )
            .send()
        {
            Ok(response) => response,
            Err(_) => return Ok(None),
        };
        if !response.status().is_success() {
            return Ok(None);
        }
        match response.json::<DesktopReadinessReport>() {
            Ok(report) => Ok(Some(report)),
            Err(_) => Ok(None),
        }
    }

    /// Browse helpers for the media library. They reuse the site Basic Auth
    /// attachment so production Caddy requests authenticate transparently.
    pub fn media_roots(&self) -> Result<Vec<String>, TransportError> {
        self.request::<Vec<String>>(
            self.headers(
                self.client
                    .get(format!("{}/api/media/roots", self.base_url)),
                None,
            ),
        )?
        .ok_or_else(|| TransportError::Protocol("empty media roots".into()))
    }

    pub fn media_list(
        &self,
        root: &str,
        path: &str,
        cursor: Option<&str>,
    ) -> Result<MediaDirectoryPage, TransportError> {
        self.media_directory(
            format!("{}/api/media/list", self.base_url),
            &[("root", root), ("path", path)],
            cursor,
        )
    }

    pub fn media_search(
        &self,
        query: &str,
        cursor: Option<&str>,
    ) -> Result<MediaDirectoryPage, TransportError> {
        self.media_directory(
            format!("{}/api/media/search", self.base_url),
            &[("q", query)],
            cursor,
        )
    }

    fn media_directory(
        &self,
        url: String,
        params: &[(&str, &str)],
        cursor: Option<&str>,
    ) -> Result<MediaDirectoryPage, TransportError> {
        let mut builder = self.client.get(url).query(params);
        if let Some(cursor) = cursor {
            builder = builder.query(&[("cursor", cursor)]);
        }
        self.request(self.headers(builder, None))?
            .ok_or_else(|| TransportError::Protocol("empty media page".into()))
    }

    /// Generic call for the media library surface (handoff §1, decided 2026-09-26).
    /// The sidecar's allow-list already decided the route; this only carries
    /// method/path/query/body and hands the raw status and body back. The JSON-only
    /// helpers above would collapse every failure into a DESKTOP_* code, and the
    /// media routes answer with their own codes (SOURCE_UNREACHABLE,
    /// LIBRARY_ROOT_NOT_FOUND, ADMIN_FORBIDDEN …) that the UI has to map itself.
    pub fn media_request(
        &self,
        method: &str,
        path: &str,
        query: Option<&str>,
        body: Option<&serde_json::Value>,
    ) -> Result<(u16, String), TransportError> {
        self.media_request_with_approval(method, path, query, body, None)
    }

    pub fn media_request_with_approval(
        &self, method: &str, path: &str, query: Option<&str>,
        body: Option<&serde_json::Value>, approval_secret: Option<&str>,
    ) -> Result<(u16, String), TransportError> {
        // Redirects could carry this custom header onto a different route or origin.
        let client = if approval_secret.is_some() { &self.approval_client } else { &self.client };
        let url = match query {
            Some(query) if !query.is_empty() => format!("{}{}?{}", self.base_url, path, query),
            _ => format!("{}{}", self.base_url, path),
        };
        let builder = match method {
            "GET" => client.get(url),
            "POST" => client.post(url),
            "PATCH" => client.patch(url),
            "DELETE" => client.delete(url),
            _ => return Err(TransportError::Protocol("unsupported media method".into())),
        };
        let builder = match body {
            Some(body) => builder.json(body),
            None => builder,
        };
        let builder = if let Some(secret) = approval_secret {
            if !crate::approval::is_approval_route(method, path) {
                return Err(TransportError::Protocol("approval header route denied".into()));
            }
            let mut header = HeaderValue::from_str(secret)
                .map_err(|_| TransportError::Protocol("invalid approval configuration".into()))?;
            header.set_sensitive(true);
            builder.header("x-watchparty-approval", header)
        } else { builder };
        let response = self
            .headers(builder, None)
            .send()
            .map_err(classify_probe_network_error)?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        Ok((status, text))
    }

    /// Image bytes for one library entry or one catalog item (phase 2 artwork / phase 3
    /// posters). Same transport as `media_request`, so it carries the site Basic Auth and
    /// the TLS policy; the caller only ever hands the bytes to the shell's asset server,
    /// never to the renderer.
    pub fn media_image(&self, kind: &str, id: &str) -> Result<(String, Vec<u8>), TransportError> {
        let route = match kind {
            "media" => "artwork",
            "poster" => "posters",
            _ => return Err(TransportError::Protocol("unsupported media image kind".into())),
        };
        let response = self
            .headers(
                self.client
                    .get(format!("{}/api/media/{}/{}", self.base_url, route, id)),
                None,
            )
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TransportError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        if !status.is_success() {
            return Err(TransportError::Http(status.as_u16(), String::new()));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(
            content_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp"
        ) {
            return Err(TransportError::Protocol("artwork is not an image".into()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > ARTWORK_MAX_BYTES)
        {
            return Err(TransportError::Protocol("artwork exceeds size guard".into()));
        }
        let bytes = response
            .bytes()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        if bytes.len() as u64 > ARTWORK_MAX_BYTES {
            return Err(TransportError::Protocol("artwork exceeds size guard".into()));
        }
        Ok((content_type, bytes.to_vec()))
    }

    pub fn verify_backend(&self) -> Result<(), TransportError> {
        let response = self
            .headers(self.client.get(format!("{}/ping", self.base_url)), None)
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        match response.status() {
            status if status.is_success() => Ok(()),
            reqwest::StatusCode::UNAUTHORIZED => Err(TransportError::Unauthorized),
            status => Err(TransportError::Http(status.as_u16(), String::new())),
        }
    }

    fn apply_site_auth(&self, builder: RequestBuilder) -> RequestBuilder {
        match &self.site_basic_auth {
            Some(auth) => builder.basic_auth(&auth.username, Some(&auth.password)),
            None => builder,
        }
    }

    fn request<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder,
    ) -> Result<Option<T>, TransportError> {
        let response = builder
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            // Reading the body can fail on its own; only a body that really says "unauthorized"
            // may classify as such.
            let body = response
                .text()
                .map_err(|error| TransportError::Network(error.to_string()))?;
            return Err(unauthorized_error(body));
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        if !status.is_success() {
            let body = response
                .text()
                .map_err(|error| TransportError::Network(error.to_string()))?;
            return Err(TransportError::Http(status.as_u16(), body));
        }
        response
            .json()
            .map(Some)
            .map_err(|error| TransportError::Protocol(error.to_string()))
    }

    /// Raw-body variant for subtitle downloads. Enforces the server's 5 MiB
    /// guard with headroom so a hostile response cannot balloon memory.
    fn request_bytes(&self, builder: RequestBuilder) -> Result<Vec<u8>, TransportError> {
        let response = builder
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TransportError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        if !status.is_success() {
            let body = response
                .text()
                .map_err(|error| TransportError::Network(error.to_string()))?;
            return Err(TransportError::Http(status.as_u16(), body));
        }
        let bytes = response
            .bytes()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        if bytes.len() > crate::subtitles::MAX_SUBTITLE_BYTES {
            return Err(TransportError::Protocol(
                "subtitle exceeds size guard".into(),
            ));
        }
        Ok(bytes.to_vec())
    }

    fn command_request(&self, builder: RequestBuilder) -> Result<CommandAck, TransportError> {
        let response = builder
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        if let Ok(ack) = serde_json::from_str::<CommandAck>(&body) {
            return Ok(ack);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TransportError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        Err(TransportError::Http(status.as_u16(), body))
    }

    fn headers(&self, builder: RequestBuilder, generation: Option<u64>) -> RequestBuilder {
        let builder = self
            .apply_site_auth(builder)
            .header("X-WatchParty-Protocol", "2")
            .header("X-WatchParty-Client-Type", "desktop");
        match generation {
            Some(value) => builder.header("X-WatchParty-Session-Generation", value.to_string()),
            None => builder,
        }
    }

    fn with_room_token(
        &self,
        builder: RequestBuilder,
        token: &str,
    ) -> Result<RequestBuilder, TransportError> {
        Ok(builder.header(WATCHPARTY_TOKEN_HEADER, room_token_header(token)?))
    }

    fn get_with_auth(
        &self,
        path: &str,
        token: &str,
        generation: u64,
    ) -> Result<RequestBuilder, TransportError> {
        self.with_room_token(
            self.headers(
                self.client.get(format!("{}{path}", self.base_url)),
                Some(generation),
            ),
            token,
        )
    }
}

impl RoomTransport for DesktopHttpTransport {
    fn redeem_desktop(&mut self, ticket: &str) -> Result<Handoff, TransportError> {
        self.request(
            self.headers(
                self.client
                    .post(format!("{}/api/desktop/handoff", self.base_url))
                    .json(&serde_json::json!({ "ticket": ticket })),
                None,
            ),
        )?
        .ok_or_else(|| TransportError::Protocol("empty handoff response".into()))
    }

    fn create_desktop(
        &mut self,
        client_id: &str,
        nickname: &str,
        pin: Option<&str>,
        initial_media: Option<&MediaSource>,
    ) -> Result<Handoff, TransportError> {
        let mut body = serde_json::json!({ "clientId": client_id, "nickname": nickname });
        if let Some(pin) = pin {
            body["pin"] = serde_json::Value::String(pin.into());
        }
        if let Some(media) = initial_media {
            body["initialMedia"] = serde_json::to_value(media)
                .map_err(|_| TransportError::Protocol("invalid initial media".into()))?;
        }
        self.request(
            self.headers(
                self.client
                    .post(format!("{}/api/desktop/rooms", self.base_url))
                    .json(&body),
                None,
            ),
        )?
        .ok_or_else(|| TransportError::Protocol("empty desktop create response".into()))
    }

    fn access_desktop(
        &mut self,
        room_id: &str,
        client_id: &str,
        nickname: &str,
        pin: Option<&str>,
    ) -> Result<String, TransportError> {
        let mut body = serde_json::json!({ "clientId": client_id, "nickname": nickname });
        if let Some(pin) = pin {
            body["pin"] = serde_json::Value::String(pin.into());
        }
        let value: serde_json::Value = self
            .request(
                self.headers(
                    self.client
                        .post(format!(
                            "{}/api/desktop/rooms/{room_id}/access",
                            self.base_url
                        ))
                        .json(&body),
                    None,
                ),
            )?
            .ok_or_else(|| TransportError::Protocol("empty desktop access response".into()))?;
        value
            .get("accessToken")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| TransportError::Protocol("missing desktop access token".into()))
    }

    fn claim_session(&mut self, room: &str, token: &str) -> Result<u64, TransportError> {
        let request = self.headers(
            self.client.post(format!(
                "{}/api/rooms/{room}/desktop/session",
                self.base_url
            )),
            None,
        );
        let value: serde_json::Value = self
            .request(self.with_room_token(request, token)?)?
            .ok_or_else(|| TransportError::Protocol("empty session response".into()))?;
        value
            .get("sessionGeneration")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| TransportError::Protocol("missing sessionGeneration".into()))
    }

    fn snapshot(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        since: Option<u64>,
    ) -> Result<SnapshotResponse, TransportError> {
        let sent_ms = unix_time_ms();
        let mut request = self.get_with_auth(
            &format!("/api/rooms/{room}/desktop/snapshot"),
            token,
            generation,
        )?;
        if let Some(value) = since {
            request = request.query(&[("since", value)]);
        }
        let snapshot = self.request(request)?;
        Ok(SnapshotResponse {
            snapshot,
            timing: Some(RequestTiming {
                sent_ms,
                received_ms: unix_time_ms(),
            }),
        })
    }

    fn members(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
    ) -> Result<Vec<RoomMember>, TransportError> {
        let request = self.get_with_auth(
            &format!("/api/rooms/{room}/desktop/members"),
            token,
            generation,
        )?;
        self.request(request)?
            .ok_or_else(|| TransportError::Protocol("empty members response".into()))
    }

    fn command(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        command: &DesktopCommand,
        expected_revision: u64,
        owner_token: Option<&str>,
    ) -> Result<CommandAck, TransportError> {
        let request = self.headers(
            self.client
                .post(format!(
                    "{}/api/rooms/{room}/desktop/command",
                    self.base_url
                ))
                .json(&command_body(command, expected_revision)),
            Some(generation),
        );
        let request = match owner_token {
            Some(token) => request.header("X-WatchParty-Owner-Token", owner_token_header(token)?),
            None => request,
        };
        self.command_request(self.with_room_token(request, token)?)
    }

    fn claim_owner_grant(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
    ) -> Result<Option<String>, TransportError> {
        let request = self.headers(
            self.client.post(format!(
                "{}/api/rooms/{room}/desktop/owner-grant/claim",
                self.base_url
            )),
            Some(generation),
        );
        let value: Option<serde_json::Value> =
            self.request(self.with_room_token(request, token)?)?;
        Ok(value.and_then(|value| {
            value
                .get("ownerToken")
                .and_then(serde_json::Value::as_str)
                .map(String::from)
        }))
    }

    fn resolve(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        source: &MediaSource,
    ) -> Result<ResolvedMedia, TransportError> {
        let media_id = match source {
            MediaSource::Openlist { media_id, .. } => media_id,
            _ => {
                return Err(TransportError::Protocol(
                    "desktop resolve requires an OpenList media id".into(),
                ))
            }
        };
        let request = self.headers(
            self.client
                .post(format!(
                    "{}/api/rooms/{room}/desktop/media/resolve",
                    self.base_url
                ))
                .json(&serde_json::json!({ "mediaId": media_id })),
            Some(generation),
        );
        let value: serde_json::Value = self
            .request(self.with_room_token(request, token)?)?
            .ok_or_else(|| TransportError::Protocol("empty resolve response".into()))?;
        Ok(ResolvedMedia {
            direct_url: value
                .get("directUrl")
                .and_then(serde_json::Value::as_str)
                .map(String::from),
            fallback_url: value
                .get("fallbackUrl")
                .and_then(serde_json::Value::as_str)
                .map(String::from),
            user_agent: value
                .get("headers")
                .and_then(|headers| {
                    headers
                        .get("User-Agent")
                        .or_else(|| headers.get("user-agent"))
                })
                .and_then(serde_json::Value::as_str)
                .unwrap_or("pan.baidu.com")
                .into(),
        })
    }

    fn discover_subtitles(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        source: &MediaSource,
    ) -> Result<Vec<SubtitleTrackInfo>, TransportError> {
        let media_id = match source {
            MediaSource::Openlist { media_id, .. } => media_id,
            _ => return Ok(Vec::new()),
        };
        let request = self.headers(
            self.client
                .get(format!(
                    "{}/api/rooms/{room}/media/subtitles",
                    self.base_url
                ))
                .query(&[("mediaId", media_id.as_str())]),
            Some(generation),
        );
        self.request(self.with_room_token(request, token)?)?
            .ok_or_else(|| TransportError::Protocol("empty subtitle discovery response".into()))
    }

    fn download_subtitle(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        subtitle_media_id: &str,
    ) -> Result<Vec<u8>, TransportError> {
        let request = self.headers(
            self.client
                .get(format!("{}/api/rooms/{room}/media/subtitle", self.base_url))
                .query(&[("mediaId", subtitle_media_id)]),
            Some(generation),
        );
        self.request_bytes(self.with_room_token(request, token)?)
    }

    fn leave(&mut self, room: &str, token: &str, generation: u64) -> Result<(), TransportError> {
        let request = self.headers(
            self.client.delete(format!(
                "{}/api/rooms/{room}/desktop/session",
                self.base_url
            )),
            Some(generation),
        );
        self.request::<serde_json::Value>(self.with_room_token(request, token)?)?;
        Ok(())
    }

    fn site_basic_auth(&self) -> Option<(&str, &str)> {
        self.site_basic_auth
            .as_ref()
            .map(|auth| (auth.username.as_str(), auth.password.as_str()))
    }

    /// Credentials ride only on same-origin fallback URLs. A resolve response
    /// pointing at another origin must never receive site Basic Auth.
    fn site_basic_auth_for(&self, media_url: &str) -> Option<(&str, &str)> {
        let target = reqwest::Url::parse(media_url).ok()?;
        let backend = reqwest::Url::parse(&self.base_url).ok()?;
        if target.origin() == backend.origin() {
            self.site_basic_auth()
        } else {
            None
        }
    }

    fn supports_clock_sync(&self) -> bool {
        true
    }

    fn clear_site_basic_auth(&mut self) {
        self.clear_site_basic_auth();
    }
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{room_token_header, DesktopHttpTransport};
    use crate::transport::RoomTransport;

    fn serve_probe(responses: &[(&str, &str)]) -> (String, std::thread::JoinHandle<()>) {
        use std::{
            io::{Read, Write},
            net::{Shutdown, TcpListener},
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected = responses
            .iter()
            .map(|(path, body)| (path.to_string(), body.to_string()))
            .collect::<Vec<_>>();
        let server = thread::spawn(move || {
            for (expected_path, body) in expected {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let headers = String::from_utf8(request).unwrap();
                assert!(
                    headers.starts_with(&format!("GET {expected_path} HTTP/1.1"))
                        || headers.starts_with(&format!("POST {expected_path} HTTP/1.1"))
                );
                // Consume the request body before answering. Closing with bytes still queued in
                // the receive buffer makes Windows send RST instead of FIN, and that RST discards
                // the response we just wrote - which is how this fixture became a coin flip.
                let pending: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("Content-Length: "))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                if pending > 0 {
                    let mut body_bytes = vec![0u8; pending];
                    stream.read_exact(&mut body_bytes).unwrap();
                }
                let (status, payload) = body.split_once('\n').unwrap_or(("200 OK", body.as_str()));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
                let _ = stream.shutdown(Shutdown::Write);
            }
        });
        (origin, server)
    }

    #[test]
    fn desktop_probe_parses_health_and_capabilities() {
        let (origin, server) = serve_probe(&[
            ("/api/desktop/health", r#"{"status":"ok","protocolVersion":2,"serviceVersion":"0.1.0"}"#),
            ("/api/desktop/capabilities", r#"{"protocolVersion":2,"serviceVersion":"0.1.0","capabilities":{"createRoom":true,"joinRoom":true,"restoreSession":true,"mediaSearch":true,"mediaQueue":true,"handoffCode":true}}"#),
        ]);
        let report = DesktopHttpTransport::new(origin).unwrap().probe_desktop_backend().unwrap();
        assert_eq!(report.status, "ok");
        assert_eq!(report.protocol_version, 2);
        assert_eq!(report.service_version, "0.1.0");
        assert!(report.capabilities.create_room && report.capabilities.join_room);
        assert!(report.capabilities.media_search && report.capabilities.media_queue);
        server.join().unwrap();
    }

    #[test]
    fn approval_header_is_request_scoped_on_the_wire() {
        use std::{io::{BufRead, BufReader, Write}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut present = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(&stream);
                let mut has_approval = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() { break; }
                    if line.to_ascii_lowercase().starts_with("x-watchparty-approval:") { has_approval = true; }
                }
                present.push(has_approval);
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
            }
            present
        });
        let transport = DesktopHttpTransport::new(origin).unwrap();
        transport.media_request_with_approval("POST", "/api/admin/media-libraries/lib_x/approval", None, None, Some("test-only-key")).unwrap();
        transport.media_request("POST", "/api/admin/media-libraries/lib_x/apply-approved", None, None).unwrap();
        transport.media_request("GET", "/api/media/capabilities", None, None).unwrap();
        assert!(transport.media_request_with_approval("POST", "/api/admin/media-libraries/lib_x/approval/revoke", None, None, Some("test-only-key")).is_err());
        assert_eq!(server.join().unwrap(), vec![true, false, false]);
    }

    #[test]
    fn approval_request_does_not_follow_redirects() {
        use std::{io::{BufRead, BufReader, Write}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&stream);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
            }
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /api/admin/media-libraries/lib_x/scan\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let transport = DesktopHttpTransport::new(origin).unwrap();
        let (status, _) = transport.media_request_with_approval("POST", "/api/admin/media-libraries/lib_x/approval", None, None, Some("test-only-key")).unwrap();
        assert_eq!(status, 302);
        server.join().unwrap();
    }

    #[test]
    fn desktop_probe_classifies_protocol_and_capability_failures() {
        let (origin, server) = serve_probe(&[
            ("/api/desktop/health", r#"{"status":"ok","protocolVersion":3,"serviceVersion":"0.1.0"}"#),
        ]);
        assert_eq!(
            DesktopHttpTransport::new(origin).unwrap().probe_desktop_backend().unwrap_err(),
            crate::transport::TransportError::ProtocolVersionMismatch,
        );
        server.join().unwrap();

        let (origin, server) = serve_probe(&[
            ("/api/desktop/health", r#"{"status":"ok","protocolVersion":2,"serviceVersion":"0.1.0"}"#),
            ("/api/desktop/capabilities", r#"{"protocolVersion":2,"serviceVersion":"0.1.0","capabilities":{"createRoom":false,"joinRoom":true,"restoreSession":true,"mediaSearch":true,"mediaQueue":true,"handoffCode":true}}"#),
        ]);
        let report = DesktopHttpTransport::new(origin).unwrap().probe_desktop_backend().unwrap();
        assert!(!report.capabilities.create_room);
        assert!(report.capabilities.join_room);
        server.join().unwrap();
    }

    #[test]
    fn desktop_probe_classifies_auth_and_network_errors() {
        let (origin, server) = serve_probe(&[
            ("/api/desktop/health", "401 Unauthorized\n{\"code\":\"AUTH_REQUIRED\"}"),
        ]);
        assert_eq!(
            DesktopHttpTransport::new(origin).unwrap().probe_desktop_backend().unwrap_err(),
            crate::transport::TransportError::AuthRequired,
        );
        server.join().unwrap();
        assert_eq!(super::classify_probe_network_message("dns error: no such host"), crate::transport::TransportError::DnsFailed);
        assert_eq!(super::classify_probe_network_message("tcp connect error: connection refused"), crate::transport::TransportError::ConnectionRefused);
        assert_eq!(super::classify_probe_network_message("invalid peer certificate: UnknownIssuer"), crate::transport::TransportError::TlsTrustRequired);
    }

    // The classification is a pure mapping, so it is tested as one. Keeping it off the socket is
    // what stops a fixture's timing from being reported as a logic failure.
    #[test]
    fn unauthorized_classification_keeps_pin_codes_and_hides_other_bodies() {
        for (body, expected) in [
            (
                r#"{"code":"ROOM_PIN_REQUIRED","message":"PIN required"}"#,
                crate::transport::TransportError::Http(401, r#"{"code":"ROOM_PIN_REQUIRED","message":"PIN required"}"#.into()),
            ),
            (
                r#"{"code":"ROOM_PIN_REJECTED","message":"Wrong PIN"}"#,
                crate::transport::TransportError::Http(401, r#"{"code":"ROOM_PIN_REJECTED","message":"Wrong PIN"}"#.into()),
            ),
            (
                r#"{"code":"ACCESS_TOKEN_INVALID","message":"secret"}"#,
                crate::transport::TransportError::Unauthorized,
            ),
            ("not json at all", crate::transport::TransportError::Unauthorized),
            ("", crate::transport::TransportError::Unauthorized),
        ] {
            assert_eq!(
                super::unauthorized_error(body.to_string()),
                expected,
                "classifying {body}"
            );
        }
    }

    #[test]
    fn desktop_access_preserves_pin_errors_without_exposing_other_unauthorized_bodies() {
        for (body, expected) in [
            (r#"{"code":"ROOM_PIN_REQUIRED","message":"PIN required"}"#, Some("ROOM_PIN_REQUIRED")),
            (r#"{"code":"ROOM_PIN_REJECTED","message":"Wrong PIN"}"#, Some("ROOM_PIN_REJECTED")),
            (r#"{"code":"ACCESS_TOKEN_INVALID","message":"secret"}"#, None),
        ] {
            let response = format!("401 Unauthorized\n{body}");
            let (origin, server) = serve_probe(&[("/api/desktop/rooms/room-123/access", &response)]);
            let mut transport = DesktopHttpTransport::new(origin).unwrap();
            let error = transport.access_desktop("room-123", "client-1", "Guest", None).unwrap_err();
            match expected {
                Some(code) => assert!(matches!(error, crate::transport::TransportError::Http(401, body) if body.contains(code))),
                None => assert_eq!(error, crate::transport::TransportError::Unauthorized),
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn local_basic_auth_accepts_only_current_credentials() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for expected in [true, false, false, true] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 8192);
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.starts_with("get /ping "));
                let valid =
                    request.contains("authorization: basic dGVzdDpwYXNz".to_lowercase().as_str());
                assert_eq!(valid, expected);
                let status = if valid { "200 OK" } else { "401 Unauthorized" };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        let correct =
            || super::DesktopHttpTransport::with_site_basic_auth(&origin, "test", "pass").unwrap();
        assert!(correct().verify_backend().is_ok());
        assert!(matches!(
            super::DesktopHttpTransport::with_site_basic_auth(&origin, "test", "wrong")
                .unwrap()
                .verify_backend(),
            Err(crate::transport::TransportError::Unauthorized)
        ));
        assert!(matches!(
            super::DesktopHttpTransport::new(&origin)
                .unwrap()
                .verify_backend(),
            Err(crate::transport::TransportError::Unauthorized)
        ));
        assert!(correct().verify_backend().is_ok());
        server.join().unwrap();
    }

    #[test]
    fn room_token_header_is_marked_sensitive() {
        let value = room_token_header("room-secret").expect("valid header value");
        assert!(value.is_sensitive());
    }

    #[test]
    fn site_basic_auth_only_attaches_to_same_origin_media_urls() {
        let transport = crate::http::DesktopHttpTransport::with_site_basic_auth(
            "https://watch.example",
            "site-user",
            "site-pass",
        )
        .expect("transport");
        assert!(transport
            .site_basic_auth_for("https://watch.example/p/video")
            .is_some());
        assert!(transport
            .site_basic_auth_for("https://watch.example:8443/p/video")
            .is_none());
        assert!(transport
            .site_basic_auth_for("http://watch.example/p/video")
            .is_none());
        assert!(transport
            .site_basic_auth_for("https://cdn.example/video")
            .is_none());
        assert!(transport
            .site_basic_auth_for("file:///C:/video.mkv")
            .is_none());
        assert!(transport.site_basic_auth_for("not a url").is_none());
    }

    #[test]
    fn site_basic_auth_for_without_credentials_is_none() {
        let transport =
            crate::http::DesktopHttpTransport::new("https://watch.example").expect("transport");
        assert!(transport
            .site_basic_auth_for("https://watch.example/p/video")
            .is_none());
    }

    #[test]
    fn subtitle_discovery_and_download_hit_the_room_media_endpoints() {
        use crate::contracts::MediaSource;
        use crate::transport::{RoomTransport, TransportError};
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let responses = [
                (
                    "/api/rooms/r1/media/subtitles?mediaId=video-signed",
                    200,
                    r#"[{"id":"sig1","mediaId":"sub-signed","label":"Show 01.chs.ass","format":"ass","language":"chs"}]"#,
                ),
                (
                    "/api/rooms/r1/media/subtitle?mediaId=sub-signed",
                    200,
                    "[Script Info]",
                ),
                (
                    "/api/rooms/r1/media/subtitle?mediaId=missing",
                    404,
                    "{\"code\":\"MEDIA_NOT_FOUND\"}",
                ),
            ];
            for (path, status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 8192);
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                let target = request.split_whitespace().nth(1).unwrap_or_default();
                let target = urldecode_target(target);
                assert_eq!(target, path, "unexpected request target {target}");
                let authorized = request
                    .to_lowercase()
                    .contains("x-watchparty-token: room-secret");
                let status_line = if authorized { status } else { 401 };
                write!(
                    stream,
                    "HTTP/1.1 {status_line} OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });

        let mut transport = crate::http::DesktopHttpTransport::new(&origin).unwrap();
        let source = MediaSource::Openlist {
            media_id: "video-signed".into(),
            title: "Show 01.mp4".into(),
            container: "mp4".into(),
            display_path: None,
        };
        let tracks = transport
            .discover_subtitles("r1", "room-secret", 4, &source)
            .unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].media_id, "sub-signed");
        assert_eq!(tracks[0].label, "Show 01.chs.ass");
        assert_eq!(tracks[0].format, "ass");
        assert_eq!(tracks[0].language.as_deref(), Some("chs"));

        let content = transport
            .download_subtitle("r1", "room-secret", 4, "sub-signed")
            .unwrap();
        assert_eq!(content, b"[Script Info]");

        assert!(matches!(
            transport.download_subtitle("r1", "room-secret", 4, "missing"),
            Err(TransportError::NotFound)
        ));
        server.join().unwrap();
    }

    /// The fixture compares raw request targets; mediaId values are opaque
    /// tokens that may contain percent-escapes in transit.
    fn urldecode_target(target: &str) -> String {
        let path = target.split('?').next().unwrap_or_default().to_owned();
        let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
        let decoded = query
            .split('&')
            .map(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                let value = value
                    .replace("%2F", "/")
                    .replace("%2f", "/")
                    .replace("%3D", "=")
                    .replace("%3d", "=")
                    .replace("%2B", "+")
                    .replace("%2b", "+");
                format!("{key}={value}")
            })
            .collect::<Vec<_>>()
            .join("&");
        if decoded.is_empty() {
            path
        } else {
            format!("{path}?{decoded}")
        }
    }
}
