//! Origin-scoped HTTP bridge. No credential or response-header DTO crosses IPC.
#[cfg(all(test, windows))]
#[path = "musicparty_http_e2e.rs"]
mod real_http_tests;

use crate::{
    config::{validate_backend_origin, MusicPartyCredentialStore, OriginTrustStore},
    http::MusicPartySession,
};
use reqwest::{blocking::Client, Method};
use serde::{Deserialize, Serialize};
use std::{io::Read, sync::Mutex, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MusicPartyRequest {
    pub origin: String,
    pub path: String,
    pub method: String,
    pub body: Option<serde_json::Value>,
    pub client_version: String,
}

#[derive(Serialize)]
pub struct MusicPartyResponse {
    pub status: u16,
    pub body: String,
}

/// Serializes credential reads, requests and deletion. Each call drops its session
/// and client before releasing the lock, so clear cannot leave a cached cookie.
pub struct MusicPartyBridge(Mutex<()>, Option<std::sync::Arc<OriginTrustStore>>);
impl Default for MusicPartyBridge { fn default() -> Self { Self(Mutex::new(()), None) } }
impl MusicPartyBridge { pub fn with_trust_store(store: std::sync::Arc<OriginTrustStore>) -> Self { Self(Mutex::new(()), Some(store)) } }

impl MusicPartyBridge {
    /// Also reports whether this call emptied the origin's stored credentials, so the
    /// host can drop a live socket: a session the server no longer honours must not
    /// keep streaming room events just because the renderer forgot to disconnect.
    pub fn request_with_clear(&self, input: MusicPartyRequest) -> Result<(MusicPartyResponse, bool), String> {
        let _guard = self.0.lock().map_err(|_| "musicparty_unavailable")?;
        let origin =
            validate_backend_origin(&input.origin).map_err(|_| "invalid_musicparty_origin")?;
        let session = MusicPartyCredentialStore
            .read(&origin)
            .map_err(|_| "musicparty_credentials_failed")?;
        let result = request_result(&origin, &input, session.as_ref(), self.1.as_deref())?;
        let response = result.response;
        let logged_out = input.method == "POST" && input.path == "/api/account/logout" && (200..300).contains(&response.status);
        if result.clear || logged_out {
            MusicPartyCredentialStore.clear(&origin).map_err(|_| "musicparty_credentials_failed")?;
            return Ok((response, true));
        }
        if let Some(updated) = result.updated {
            MusicPartyCredentialStore.write(&origin, &updated).map_err(|_| "musicparty_credentials_failed")?;
        }
        Ok((response, false))
    }

    pub fn request(&self, input: MusicPartyRequest) -> Result<MusicPartyResponse, String> {
        self.request_with_clear(input).map(|(response, _)| response)
    }

    pub fn clear(&self, origin: &str) -> Result<(), String> {
        let _guard = self.0.lock().map_err(|_| "musicparty_unavailable")?;
        MusicPartyCredentialStore
            .clear(origin)
            .map_err(|_| "musicparty_credentials_failed".into())
    }
}

struct NativeResult {
    response: MusicPartyResponse,
    updated: Option<MusicPartySession>,
    clear: bool,
}

/// The one room path a management verb may address: `/api/rooms/{id}`, where the id cannot slip
/// into another segment or carry a query.
fn room_path_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/api/rooms/")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_graphic() && !b"?#\\/.".contains(&b)) {
        return None;
    }
    Some(id)
}

/// The two album browsing shapes the shell may read: `/api/desktop/v1/albums/{platform}` and
/// `/api/desktop/v1/albums/{platform}/{albumId}/songs`. Anything deeper is refused here rather than
/// forwarded, so a mistyped URL cannot turn this into a general-purpose GET proxy.
fn album_path_allowed(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/desktop/v1/albums/") else { return false };
    // Each segment is checked on its own: unlike a room id, the album shape has two segments, so
    // the separator itself must stay legal while traversal and query characters do not.
    let segment_ok = |segment: &str| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|b| b.is_ascii_graphic() && !b"?#\\/".contains(&b))
    };
    match rest.split('/').collect::<Vec<_>>().as_slice() {
        [platform] => segment_ok(platform),
        [platform, album_id, "songs"] => segment_ok(platform) && segment_ok(album_id),
        _ => false,
    }
}

fn request_result(origin: &str, input: &MusicPartyRequest, session: Option<&MusicPartySession>, trust: Option<&OriginTrustStore>) -> Result<NativeResult, String> {
    let path = input.path.split('?').next().unwrap_or_default();
    let allowed = match input.method.as_str() {
        "GET" => {
            matches!(
                path,
                "/api/desktop/v1/health" | "/api/desktop/v1/capabilities" | "/api/desktop/v1/readiness" | "/api/platforms" | "/api/rooms" | "/api/account/me"
            ) || path.starts_with("/api/desktop/v1/search/")
                || album_path_allowed(path)
                || (path.starts_with("/api/desktop/v1/music/") && path.ends_with("/lyrics"))
                || (path.starts_with("/api/desktop/v1/media/") && (path.ends_with("/resolve") || path.ends_with("/lyrics")))
        }
        "POST" => path == "/api/desktop/v1/invites/redeem"
            || path == "/api/desktop/v1/rooms"
            || path == "/api/account/logout"
            || path.starts_with("/api/rooms/") && path.ends_with("/verify"),
        // Renaming and deleting belong to whoever owns the room; the server decides that. The
        // bridge only promises these two verbs never point anywhere but one room path.
        "PUT" | "DELETE" => room_path_id(path).is_some(),
        _ => false,
    };
    let state_changing = input.method != "GET";
    if !allowed
        || (state_changing && path != input.path)
        || input.path.contains(['\\', '#', '\r', '\n'])
        || path
            .split('/')
            .any(|s| s == "." || s == ".." || s.to_ascii_lowercase().contains("%2e"))
    {
        return Err("invalid_musicparty_request".into());
    }
    if state_changing && path != "/api/desktop/v1/invites/redeem" && session.is_none() {
        return Err("musicparty_credentials_missing".into());
    }
    if path.starts_with("/api/rooms/") {
        let id = path
            .strip_prefix("/api/rooms/")
            .map(|rest| rest.strip_suffix("/verify").unwrap_or(rest))
            .unwrap_or_default();
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_graphic() && !b"?#\\/.".contains(&b)) {
            return Err("invalid_musicparty_request".into());
        }
    }
    if input.client_version.len() > 64
        || !input
            .client_version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    {
        return Err("invalid_musicparty_version".into());
    }
    let mut client_builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15));
    if let Some(pem) = trust.and_then(|t| t.pem_for(origin).ok().flatten()) { if let Ok(cert)=reqwest::Certificate::from_pem(pem.as_bytes()) { client_builder = client_builder.add_root_certificate(cert); } }
    let client = client_builder.build()
        .map_err(|_| "musicparty_network_failed")?;
    let method = match input.method.as_str() {
        "GET" => Method::GET,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        _ => Method::POST,
    };
    let mut builder = client
        .request(method.clone(), format!("{origin}{}", input.path))
        .header("Accept", "application/json")
        .header("X-Desktop-API-Version", "2026-01")
        .header("X-Desktop-Client-Version", &input.client_version);
    if let Some(session) = session {
        if session.session.is_empty()
            || session.csrf.is_empty()
            || !session
                .session
                .bytes()
                .all(|b| b.is_ascii_graphic() && !b";\"\\,".contains(&b))
        {
            return Err("musicparty_credentials_failed".into());
        }
        builder = session
            .apply(builder, state_changing)
            .map_err(|_| "musicparty_credentials_failed")?;
    }
    if let Some(body) = &input.body {
        builder = builder.json(body);
    }
    let response = builder.send().map_err(|_| "musicparty_network_failed")?;
    let status = response.status();
    // Preserve bounded, non-sensitive JSON diagnostics so the desktop can explain
    // invite failures. Redirects remain body-less, and credential checks below
    // apply equally to error responses.
    if !status.is_success() {
        let error_cookies = cookie_mutations(response.headers(), origin);
        let mut body = String::new();
        response
            .take(64 * 1024 + 1)
            .read_to_string(&mut body)
            .map_err(|_| "musicparty_response_failed")?;
        if body.len() > 64 * 1024 {
            return Err("musicparty_response_too_large".into());
        }
        if status.is_redirection()
            || session.is_some_and(|s| [&s.session, &s.csrf].into_iter().chain(s.room_access.iter()).any(|v| !v.is_empty() && body.contains(v)))
            || error_cookies.iter().any(|(_, value)| value.as_ref().is_some_and(|v| !v.is_empty() && body.contains(v)))
        {
            body.clear();
        }
        return Ok(NativeResult { response: MusicPartyResponse {
            status: status.as_u16(),
            body,
        }, updated: None, clear: false });
    }
    let mutations = cookie_mutations(response.headers(), origin);
    let mut body = String::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut body)
        .map_err(|_| "musicparty_response_failed")?;
    if body.len() > 2 * 1024 * 1024 {
        return Err("musicparty_response_too_large".into());
    }
    if session.is_some_and(|s| [&s.session, &s.csrf].into_iter().chain(s.room_access.iter()).any(|v| !v.is_empty() && body.contains(v)))
        || mutations.iter().any(|(_, value)| value.as_ref().is_some_and(|v| !v.is_empty() && body.contains(v))) {
        return Err("musicparty_sensitive_response".into());
    }
    let clear = mutations.iter().any(|(name, value)| *name != "MP_ROOM_ACCESS" && value.is_none());
    let updated = if mutations.is_empty() || clear { None } else {
        let mut value = MusicPartySession::new(session.map_or("", |s| s.session.as_str()), session.map_or("", |s| s.csrf.as_str()));
        // Invite redemption establishes a new member session. Never carry a
        // room proof from the previous session into that identity.
        value.room_access = if path == "/api/desktop/v1/invites/redeem" {
            None
        } else {
            session.and_then(|s| s.room_access.clone())
        };
        for (name, cookie) in mutations { match name {
            "MP_SESSION" => value.session = cookie.unwrap_or_default(),
            "MP_CSRF" => value.csrf = cookie.unwrap_or_default(),
            _ => value.room_access = cookie,
        } }
        // A successful invite must establish both session and CSRF credentials.
        if path == "/api/desktop/v1/invites/redeem"
            && (value.session.is_empty() || value.csrf.is_empty())
        {
            return Err("musicparty_credentials_failed".into());
        }
        Some(value)
    };
    Ok(NativeResult { response: MusicPartyResponse {
        status: status.as_u16(),
        body,
    }, updated, clear })
}

/// Only host-scoped root cookies are eligible for the native credential blob.
fn cookie_mutations(headers: &reqwest::header::HeaderMap, origin: &str) -> Vec<(&'static str, Option<String>)> {
    let Ok(url) = reqwest::Url::parse(origin) else { return Vec::new() };
    headers.get_all(reqwest::header::SET_COOKIE).iter().filter_map(|header| {
        let text = header.to_str().ok()?;
        let mut parts = text.split(';');
        let (name, value) = parts.next()?.split_once('=')?;
        let name = match name.trim() { "MP_SESSION" => "MP_SESSION", "MP_CSRF" => "MP_CSRF", "MP_ROOM_ACCESS" => "MP_ROOM_ACCESS", _ => return None };
        if !value.bytes().all(|b| b.is_ascii_graphic() && !b";\"\\,".contains(&b)) { return None; }
        let mut delete = false;
        for part in parts {
            let (key, attribute) = part.trim().split_once('=').unwrap_or((part.trim(), ""));
            if key.eq_ignore_ascii_case("domain") && !attribute.eq_ignore_ascii_case(url.host_str()?) { return None; }
            if key.eq_ignore_ascii_case("path") && attribute != "/" { return None; }
            if key.eq_ignore_ascii_case("max-age") && attribute == "0" { delete = true; }
        }
        Some((name, if delete || value.is_empty() { None } else { Some(value.into()) }))
    }).collect()
}





#[cfg(test)]
mod tests {
    use super::*;
    fn request(origin: &str, input: &MusicPartyRequest, session: Option<&MusicPartySession>) -> Result<MusicPartyResponse, String> {
        Ok(request_result(origin, input, session, None)?.response)
    }
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
    };

    fn fixture(status: &str, body: &str, headers: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        fixture_on(listener, status, body, headers)
    }

    fn fixture_on(listener: TcpListener, status: &str, body: &str, headers: &str) -> (String, thread::JoinHandle<String>) {
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                request.push_str(&line);
            }
            stream.write_all(reply.as_bytes()).unwrap();
            request.to_ascii_lowercase()
        });
        (origin, worker)
    }

    fn input(method: &str) -> MusicPartyRequest {
        MusicPartyRequest {
            origin: String::new(),
            path: if method == "POST" {
                "/api/desktop/v1/invites/redeem"
            } else {
                "/api/desktop/v1/health"
            }
            .into(),
            method: method.into(),
            body: None,
            client_version: "0.2.0".into(),
        }
    }

    #[test]
    fn native_cookie_csrf_and_header_isolation() {
        for method in ["GET", "POST"] {
            let (origin, server) = fixture(
                "200 OK",
                "{}",
                "Set-Cookie: MP_SESSION=rotated-secret; HttpOnly\r\nX-CSRF-Token: hidden\r\n",
            );
            let session = MusicPartySession::new("session-secret", "csrf-secret");
            let reply = request(&origin, &input(method), Some(&session)).unwrap();
            let received = server.join().unwrap();
            assert!(received.contains("cookie: mp_session=session-secret"));
            assert_eq!(
                received.contains("x-csrf-token: csrf-secret"),
                method == "POST"
            );
            assert!(received.contains("x-desktop-api-version: 2026-01"));
            assert_eq!(
                serde_json::to_value(reply).unwrap(),
                serde_json::json!({"status": 200, "body": "{}"})
            );
        }
    }

    #[test]
    fn redirects_and_error_bodies_do_not_escape_to_webview() {
        for status in ["302 Found", "403 Forbidden"] {
            let (origin, server) = fixture(
                status,
                "session-secret",
                "Location: http://127.0.0.1:1/stolen\r\n",
            );
            let session = MusicPartySession::new("session-secret", "csrf-secret");
            let reply = request(&origin, &input("GET"), Some(&session)).unwrap();
            assert_eq!(
                reply.status,
                if status.starts_with("302") { 302 } else { 403 }
            );
            assert_eq!(reply.body, "");
            server.join().unwrap();
        }
        let (origin, server) = fixture("200 OK", "csrf-secret", "");
        let session = MusicPartySession::new("session-secret", "csrf-secret");
        assert_eq!(
            request(&origin, &input("GET"), Some(&session))
                .err()
                .as_deref(),
            Some("musicparty_sensitive_response")
        );
        server.join().unwrap();
    }

    #[test]
    fn no_cookie_survives_a_request() {
        let (origin, server) = fixture("200 OK", "{}", "Set-Cookie: MP_SESSION=stale\r\n");
        request(
            &origin,
            &input("GET"),
            Some(&MusicPartySession::new("session-secret", "csrf-secret")),
        )
        .unwrap();
        server.join().unwrap();
        let (origin, server) = fixture("200 OK", "{}", "");
        request(&origin, &input("GET"), None).unwrap();
        assert!(!server.join().unwrap().contains("cookie:"));
    }

    #[test]
    fn rejects_paths_outside_api_before_network() {
        for path in [
            "https://evil.test",
            "//evil.test",
            "/api/search/../logout",
            "/api/search/%2e%2e/logout",
            "/api/search/a\\b",
            "/api/logout",
        ] {
            let mut input = input("GET");
            input.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &input, None).err().as_deref(),
                Some("invalid_musicparty_request")
            );
        }
    }

    // The readiness endpoint is a public, version-gate-free desktop probe (backend handoff §6.5),
    // so it must reach the Go service like health/capabilities do — and nothing may smuggle a
    // neighbouring path through the same match arm.
    #[test]
    fn allows_desktop_readiness_probe_and_still_refuses_its_neighbours() {
        let (origin, server) = fixture("200 OK", "{\"status\":\"ready\",\"readinessVersion\":1}", "");
        let mut allowed = input("GET");
        allowed.path = "/api/desktop/v1/readiness".into();
        let reply = request(&origin, &allowed, None).unwrap();
        assert_eq!(reply.status, 200);
        assert!(server.join().unwrap().contains("get /api/desktop/v1/readiness http/1.1"));

        for path in [
            "/api/desktop/v1/readiness/extra",
            "/api/desktop/readiness",
            "/api/readiness",
        ] {
            let mut rejected = input("GET");
            rejected.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &rejected, None).err().as_deref(),
                Some("invalid_musicparty_request"),
                "{path}"
            );
        }
    }

    #[test]
    fn allows_room_list_but_rejects_unapproved_room_reads() {
        let (origin, server) = fixture("200 OK", "[]", "");
        let mut allowed = input("GET");
        allowed.path = "/api/rooms".into();
        let reply = request(&origin, &allowed, None).unwrap();
        assert_eq!(reply.status, 200);
        assert!(server.join().unwrap().contains("get /api/rooms http/1.1"));

        for path in ["/api/rooms/room-1", "/api/rooms/room-1/members"] {
            let mut rejected = input("GET");
            rejected.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &rejected, None).err().as_deref(),
                Some("invalid_musicparty_request")
            );
        }
    }

    // Album browsing is read-only and must stay inside the two desktop shapes, so the bridge does
    // not become a general GET proxy for whatever URL the page happens to build.
    #[test]
    fn album_reads_reach_only_the_two_desktop_album_shapes() {
        // One fixture answers one request, so each shape gets its own.
        for path in [
            "/api/desktop/v1/albums/netease?q=zhou",
            "/api/desktop/v1/albums/netease/12345/songs",
        ] {
            let (origin, server) = fixture("200 OK", "{\"items\":[],\"total\":0,\"offset\":0,\"limit\":20}", "");
            let mut call = input("GET");
            call.path = path.into();
            let reply = request(&origin, &call, None).unwrap();
            assert_eq!(reply.status, 200, "{path}");
            assert!(
                server.join().unwrap().contains("get /api/desktop/v1/albums/"),
                "{path} must actually reach the network"
            );
        }

        for path in [
            "/api/desktop/v1/albums",
            "/api/desktop/v1/albums/",
            "/api/desktop/v1/albums/netease/12345",
            "/api/desktop/v1/albums/netease/12345/songs/extra",
            "/api/desktop/v1/albums/netease/12345/cover",
            "/api/desktop/v1/albums/netease/12345/../../rooms",
            "/api/desktop/v1/albums/netease/12 34/songs",
            "/api/desktop/v1/albums//12345/songs",
        ] {
            let mut call = input("GET");
            call.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &call, None).err().as_deref(),
                Some("invalid_musicparty_request"),
                "{path}"
            );
        }
    }

    #[test]
    fn desktop_reads_own_identity_but_no_other_account_route() {
        let (origin, server) = fixture("200 OK", "{\"publicId\":\"u1\",\"displayName\":\"Friend\",\"guest\":false}", "");
        let mut allowed = input("GET");
        allowed.path = "/api/account/me".into();
        let reply = request(
            &origin,
            &allowed,
            Some(&MusicPartySession::new("session-secret", "csrf-secret")),
        )
        .unwrap();
        assert_eq!(reply.status, 200);
        server.join().unwrap();
        for path in ["/api/account/sessions", "/api/admin/users", "/api/account/me/tokens"] {
            let mut rejected = input("GET");
            rejected.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &rejected, None).err().as_deref(),
                Some("invalid_musicparty_request"),
                "{path}"
            );
        }
    }

    #[test]
    fn allows_desktop_room_create_and_keeps_its_access_proof() {
        let (origin, server) = fixture(
            "200 OK",
            "{\"roomId\":\"r1\",\"name\":\"Quiet\",\"privateRoom\":true,\"accessGranted\":true,\"onlineCount\":1}",
            "Set-Cookie: MP_ROOM_ACCESS=room-proof; Path=/\r\n",
        );
        let mut create = input("POST");
        create.path = "/api/desktop/v1/rooms".into();
        let reply = request(
            &origin,
            &create,
            Some(&MusicPartySession::new("session-secret", "csrf-secret")),
        )
        .unwrap();
        assert_eq!(reply.status, 200);
        let sent = server.join().unwrap();
        assert!(sent.contains("post /api/desktop/v1/rooms http/1.1"));
        assert!(sent.contains("x-csrf-token: csrf-secret"));

        for path in [
            "/api/desktop/v1/rooms/",
            "/api/desktop/v1/rooms/room-1",
            "/api/desktop/v1/rooms/room-1/delete",
            "/api/rooms",
        ] {
            let mut rejected = input("POST");
            rejected.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &rejected, None).err().as_deref(),
                Some("invalid_musicparty_request"),
                "{path}"
            );
        }

        let mut create = input("POST");
        create.path = "/api/desktop/v1/rooms".into();
        assert_eq!(
            request("http://127.0.0.1:1", &create, None).err().as_deref(),
            Some("musicparty_credentials_missing"),
            "an anonymous caller must not be able to open rooms"
        );
    }

    #[test]
    fn management_verbs_reach_only_one_room_path() {
        let session = MusicPartySession::new("session-secret", "csrf-secret");
        for (method, path) in [
            ("PUT", "/api/rooms"),
            ("PUT", "/api/rooms/"),
            ("PUT", "/api/rooms/room-1/members"),
            ("PUT", "/api/rooms/room-1/verify"),
            ("PUT", "/api/rooms/../lounge"),
            ("PUT", "/api/rooms/room-1?name=x"),
            ("DELETE", "/api/rooms"),
            ("DELETE", "/api/rooms/room-1/members/u1"),
            ("DELETE", "/api/desktop/v1/rooms"),
            ("PATCH", "/api/rooms/room-1"),
        ] {
            let mut call = input(method);
            call.path = path.into();
            assert_eq!(
                request("http://127.0.0.1:1", &call, Some(&session)).err().as_deref(),
                Some("invalid_musicparty_request"),
                "{method} {path}"
            );
        }
        for method in ["PUT", "DELETE"] {
            let mut call = input(method);
            call.path = "/api/rooms/room-1".into();
            assert_eq!(
                request("http://127.0.0.1:1", &call, None).err().as_deref(),
                Some("musicparty_credentials_missing"),
                "{method} without a session must not reach the network"
            );
        }
        for method in ["PUT", "DELETE"] {
            let (origin, server) = fixture("200 OK", "{\"roomId\":\"room-1\"}", "");
            let mut call = input(method);
            call.path = "/api/rooms/room-1".into();
            call.body = (method == "PUT").then(|| serde_json::json!({"name": "Renamed", "isPrivate": false}));
            assert_eq!(request(&origin, &call, Some(&session)).unwrap().status, 200);
            let sent = server.join().unwrap().to_lowercase();
            let verb = method.to_lowercase();
            assert!(sent.contains(&format!("{verb} /api/rooms/room-1 http/1.1")), "{method}");
            assert!(sent.contains("x-csrf-token: csrf-secret"), "{method} must double-submit CSRF");
        }
    }

    #[test]
    fn cookie_parser_ignores_unrelated_or_out_of_scope_cookies() {
        let mut headers = reqwest::header::HeaderMap::new();
        for cookie in ["OTHER=unknown; Path=/", "MP_SESSION=wrong-host; Domain=evil.test; Path=/", "MP_CSRF=wrong-path; Path=/api", "MP_ROOM_ACCESS=removed; Max-Age=0; Path=/", "MP_SESSION=session-new; Path=/", "MP_CSRF=csrf-new; Path=/"] {
            headers.append(reqwest::header::SET_COOKIE, cookie.parse().unwrap());
        }
        assert_eq!(cookie_mutations(&headers, "http://127.0.0.1:8080"), vec![("MP_ROOM_ACCESS", None), ("MP_SESSION", Some("session-new".into())), ("MP_CSRF", Some("csrf-new".into()))]);
    }

    #[cfg(windows)]
    struct CredentialCleanup(String);

    #[cfg(windows)]
    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            MusicPartyCredentialStore.clear(&self.0).expect("clean credential target");
        }
    }

    #[cfg(windows)]
    #[test]
    fn bridge_persists_rotates_and_deletes_origin_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        MusicPartyCredentialStore.clear(&origin).unwrap();
        let _cleanup = CredentialCleanup(origin.clone());
        let bridge = MusicPartyBridge::default();
        let run = |path: &str, status: &str, cookies: &str| {
            let (_, server) = fixture_on(listener.try_clone().unwrap(), status, "", cookies);
            let mut request = input("POST");
            request.origin = origin.clone();
            request.path = path.into();
            let response = bridge.request(request);
            (response, server.join().unwrap())
        };
        let invite = "/api/desktop/v1/invites/redeem";
        assert_eq!(run(invite, "200 OK", "Set-Cookie: MP_SESSION=incomplete; Path=/\r\n").0.err().as_deref(), Some("musicparty_credentials_failed"));
        assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
        let (response, _) = run(invite, "200 OK", "Set-Cookie: MP_SESSION=session-first; Path=/\r\nSet-Cookie: MP_CSRF=csrf-first; Path=/\r\nSet-Cookie: MP_ROOM_ACCESS=room-first; Path=/\r\n");
        assert_eq!(serde_json::to_value(response.unwrap()).unwrap(), serde_json::json!({"status":200,"body":""}));
        let stored = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
        assert_eq!((&*stored.session, &*stored.csrf, stored.room_access.as_deref()), ("session-first", "csrf-first", Some("room-first")));
        let other_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let other = format!("http://{}", other_listener.local_addr().unwrap());
        MusicPartyCredentialStore.clear(&other).unwrap();
        let _other_cleanup = CredentialCleanup(other.clone());
        assert!(MusicPartyCredentialStore.read(&other).unwrap().is_none());
        let (response, sent) = run("/api/rooms/room-1/verify", "200 OK", "Set-Cookie: MP_SESSION=session-second; Path=/\r\n");
        response.unwrap();
        assert!(sent.contains("cookie: mp_session=session-first; mp_csrf=csrf-first; mp_room_access=room-first"));
        assert!(sent.contains("x-csrf-token: csrf-first"));
        let stored = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
        assert_eq!((&*stored.session, &*stored.csrf), ("session-second", "csrf-first"));
        run(invite, "200 OK", "Set-Cookie: MP_CSRF=csrf-second; Path=/\r\nSet-Cookie: MP_ROOM_ACCESS=expired; Max-Age=0; Path=/\r\nSet-Cookie: UNKNOWN=ignored\r\nSet-Cookie: MP_SESSION=wrong; Domain=evil.test\r\nSet-Cookie: MP_CSRF=wrong; Path=/api\r\n").0.unwrap();
        let stored = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
        assert_eq!((&*stored.session, &*stored.csrf, stored.room_access.as_deref()), ("session-second", "csrf-second", None));
        // A created private room hands back its own access proof; the bridge stores it
        // in the same origin-scoped blob so the very next read joins without a password.
        let (response, sent) = run("/api/desktop/v1/rooms", "200 OK", "Set-Cookie: MP_ROOM_ACCESS=room-created; Path=/\r\n");
        response.unwrap();
        assert!(sent.contains("x-csrf-token: csrf-second"));
        assert_eq!(MusicPartyCredentialStore.read(&origin).unwrap().unwrap().room_access.as_deref(), Some("room-created"));
        for path in ["/api/rooms/../verify", "/api/rooms/%2e%2e/verify", "/api/rooms/a/b/verify"] {
            let mut request = input("POST");
            request.origin = origin.clone();
            request.path = path.into();
            assert_eq!(bridge.request(request).err().as_deref(), Some("invalid_musicparty_request"));
        }
        // request_with_clear is what tells the host to cancel this origin's room socket.
        let logout = |status: &str, cookies: &str| {
            let (_, server) = fixture_on(listener.try_clone().unwrap(), status, "", cookies);
            let mut request = input("POST");
            request.origin = origin.clone();
            request.path = "/api/account/logout".into();
            let cleared = bridge.request_with_clear(request).map(|(_, cleared)| cleared);
            server.join().unwrap();
            cleared
        };
        assert_eq!(logout("403 Forbidden", "Set-Cookie: MP_SESSION=; Max-Age=0\r\n").unwrap(), false, "a failed logout keeps the session");
        assert_eq!(MusicPartyCredentialStore.read(&origin).unwrap().unwrap().session, "session-second");
        assert_eq!(logout("204 No Content", "").unwrap(), true);
        assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
        for cookie in ["MP_SESSION", "MP_CSRF"] {
            run(invite, "200 OK", "Set-Cookie: MP_SESSION=session-next; Path=/\r\nSet-Cookie: MP_CSRF=csrf-next; Path=/\r\n").0.unwrap();
            run("/api/rooms/room-1/verify", "200 OK", &format!("Set-Cookie: {cookie}=deleted; Max-Age=0; Path=/\r\n")).0.unwrap();
            assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
        }
    }
}
