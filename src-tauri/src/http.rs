use crate::{
    contracts::{CommandAck, DesktopCommand, MediaDirectoryPage, MediaSource, RoomMember},
    transport::{
        Handoff, RequestTiming, ResolvedMedia, RoomTransport, SnapshotResponse, SubtitleTrackInfo,
        TransportError,
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
    site_basic_auth: Option<SiteBasicAuth>,
}

impl DesktopHttpTransport {
    pub fn new(base_url: impl Into<String>) -> Result<Self, TransportError> {
        Self::with_auth(base_url, None)
    }

    pub fn with_site_basic_auth(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Result<Self, TransportError> {
        Self::with_auth(base_url, Some(SiteBasicAuth::new(username, password)))
    }

    fn with_auth(
        base_url: impl Into<String>,
        site_basic_auth: Option<SiteBasicAuth>,
    ) -> Result<Self, TransportError> {
        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').into(),
            client: Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|error| TransportError::Network(error.to_string()))?,
            site_basic_auth,
        })
    }

    pub fn clear_site_basic_auth(&mut self) {
        self.site_basic_auth = None;
    }

    pub fn has_site_basic_auth(&self) -> bool {
        self.site_basic_auth.is_some()
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
            return Err(TransportError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        if !status.is_success() {
            return Err(TransportError::Http(
                status.as_u16(),
                response.text().unwrap_or_default(),
            ));
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
            return Err(TransportError::Http(
                status.as_u16(),
                response.text().unwrap_or_default(),
            ));
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
    use super::room_token_header;
    use crate::transport::RoomTransport;

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
