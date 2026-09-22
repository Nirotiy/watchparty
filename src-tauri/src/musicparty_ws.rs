use crate::{config::{validate_backend_origin, MusicPartyCredentialStore, OriginTrustStore}, http::MusicPartySession};
use std::net::TcpStream;
use std::io::ErrorKind;
use tungstenite::{client::IntoClientRequest, stream::MaybeTlsStream, WebSocket};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};

pub type MusicPartySocket = WebSocket<MaybeTlsStream<TcpStream>>;

const MUSICPARTY_WS_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub struct MusicPartyWsState(Mutex<Option<MusicPartySocket>>, AtomicU64, Option<std::sync::Arc<OriginTrustStore>>);

impl Default for MusicPartyWsState {
    fn default() -> Self { Self(Mutex::new(None), AtomicU64::new(0), None) }
}

impl MusicPartyWsState {
    pub fn with_trust_store(store: std::sync::Arc<OriginTrustStore>) -> Self {
        Self(Mutex::new(None), AtomicU64::new(0), Some(store))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsConnectInput { pub origin: String, pub room_id: String, pub client_version: String }

#[derive(Serialize)]
pub struct WsEvent { pub event: String }

impl MusicPartyWsState {
    pub fn connect(&self, input: WsConnectInput) -> Result<WsEvent, String> {
        let generation = self.1.load(Ordering::Acquire);
        parse_version(&input.client_version).ok_or("version-incompatible")?;
        let socket = connect_with_store(self.2.as_deref(), &input.origin, &input.room_id, &input.client_version)?;
        self.negotiate(socket, &input.client_version, generation)
    }

    /// Publishes a socket only after the desktop version handshake succeeds.
    fn negotiate(&self, mut socket: MusicPartySocket, client_version: &str, generation: u64) -> Result<WsEvent, String> {
        let client = parse_version(client_version).ok_or("version-incompatible")?;
        socket.send(tungstenite::Message::Text(serde_json::json!({"type":"client.hello","payload":{"apiVersion":"2026-01","clientVersion":client_version}}).to_string())).map_err(|_| "musicparty_ws_send_failed")?;
        let hello = socket.read().map_err(|_| "musicparty_ws_read_failed")?;
        let text = hello.into_text().map_err(|_| "musicparty_ws_protocol_failed")?;
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "musicparty_ws_protocol_failed")?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some("server.hello") { return Err("musicparty_ws_hello_required".into()); }
        let payload = value.get("payload").ok_or("version-incompatible")?;
        if payload.get("apiVersion").and_then(serde_json::Value::as_str) != Some("2026-01") { return Err("version-incompatible".into()); }
        let minimum = payload.get("minimumClientVersion").and_then(serde_json::Value::as_str)
            .and_then(parse_version).ok_or("version-incompatible")?;
        if client < minimum { return Err("version-incompatible".into()); }
        let mut slot = self.0.lock().map_err(|_| "musicparty_ws_unavailable")?;
        if self.1.load(Ordering::Acquire) != generation { return Err("musicparty_ws_disconnected".into()); }
        *slot = Some(socket);
        Ok(WsEvent { event: text })
    }
    pub fn send(&self, event: String) -> Result<(), String> {
        let value: serde_json::Value = serde_json::from_str(&event).map_err(|_| "invalid_musicparty_event")?;
        let mut guard = self.0.lock().map_err(|_| "musicparty_ws_unavailable")?;
        guard.as_mut().ok_or("musicparty_ws_not_connected")?.send(tungstenite::Message::Text(value.to_string())).map_err(|_| "musicparty_ws_send_failed".into())
    }
    pub fn receive(&self) -> Result<WsEvent, String> {
        self.receive_with_idle_timeout(MUSICPARTY_WS_IDLE_TIMEOUT)
    }

    fn receive_with_idle_timeout(&self, idle_timeout: std::time::Duration) -> Result<WsEvent, String> {
        let generation = self.1.load(Ordering::Acquire);
        let idle_since = std::time::Instant::now();
        loop {
            if self.1.load(Ordering::Acquire) != generation { return Err("musicparty_ws_disconnected".into()); }
            let result = {
                let mut guard = self.0.lock().map_err(|_| "musicparty_ws_unavailable")?;
                let socket = guard.as_mut().ok_or("musicparty_ws_not_connected")?;
                set_read_timeout(socket);
                socket.read()
            };
            match result {
                Ok(message) if message.is_close() => return Err("musicparty_ws_closed".into()),
                Ok(message) if message.is_text() => {
                    if self.1.load(Ordering::Acquire) != generation { return Err("musicparty_ws_disconnected".into()); }
                    return Ok(WsEvent { event: message.into_text().map_err(|_| "musicparty_ws_protocol_failed")? });
                }
                Ok(_) => {},
                Err(tungstenite::Error::Io(ref error)) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                    if idle_since.elapsed() >= idle_timeout { return Err("musicparty_ws_idle_timeout".into()); }
                },
                Err(_) => return Err("musicparty_ws_read_failed".into()),
            }
            // Release the socket between bounded reads so sends and cancellation can proceed.
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    pub fn disconnect(&self) -> Result<(), String> { self.1.fetch_add(1, Ordering::AcqRel); self.0.lock().map_err(|_| "musicparty_ws_unavailable")?.take(); Ok(()) }
}

fn set_read_timeout(socket: &mut MusicPartySocket) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => { let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(50))); }
        MaybeTlsStream::Rustls(stream) => { let _ = stream.get_mut().set_read_timeout(Some(std::time::Duration::from_millis(50))); }
        _ => {}
    }
}

fn parse_version(value: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || (p.len() > 1 && p.starts_with('0')) || !p.bytes().all(|b| b.is_ascii_digit())) { return None; }
    Some([parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?])
}

/// Opens the desktop MusicParty endpoint. Credentials are read in Rust and
/// attached to the handshake; callers receive only the socket and no secrets.
pub fn connect(origin: &str, room_id: &str, client_version: &str) -> Result<MusicPartySocket, String> {
    connect_with_store(None, origin, room_id, client_version)
}

fn connect_with_store(trust: Option<&OriginTrustStore>, origin: &str, room_id: &str, client_version: &str) -> Result<MusicPartySocket, String> {
    let origin = validate_backend_origin(origin).map_err(|_| "invalid_musicparty_origin")?;
    if room_id.is_empty() || room_id.len() > 128 || !room_id.bytes().all(|b| b.is_ascii_graphic() && !b"?#\\".contains(&b)) {
        return Err("invalid_musicparty_room".into());
    }
    let session = MusicPartyCredentialStore.read(&origin).map_err(|_| "musicparty_credentials_failed")?;
    let session = session.ok_or("musicparty_credentials_missing")?;
    connect_with_session(trust, &origin, room_id, client_version, &session)
}

fn connect_with_session(trust: Option<&OriginTrustStore>, origin: &str, room_id: &str, client_version: &str, session: &MusicPartySession) -> Result<MusicPartySocket, String> {
    let ws_origin = origin.replacen("http://", "ws://", 1).replacen("https://", "wss://", 1);
    let url = format!("{ws_origin}/api/desktop/v1/ws?roomId={}", urlencoding::encode(room_id));
    let mut request = url.into_client_request().map_err(|_| "musicparty_ws_request_failed")?;
    request.headers_mut().insert("Origin", origin.parse().map_err(|_| "musicparty_ws_request_failed")?);
    request.headers_mut().insert("X-Desktop-API-Version", "2026-01".parse().unwrap());
    request.headers_mut().insert("X-Desktop-Client-Version", client_version.parse().map_err(|_| "invalid_musicparty_version")?);
    request.headers_mut().insert("Cookie", cookie_header(&session).parse().map_err(|_| "musicparty_credentials_failed")?);
    let parsed = url::Url::parse(origin).map_err(|_| "invalid_musicparty_origin")?;
    let host = parsed.host_str().ok_or("invalid_musicparty_origin")?;
    let tcp = TcpStream::connect((host, parsed.port_or_known_default().ok_or("invalid_musicparty_origin")?))
        .map_err(|_| "musicparty_ws_connect_failed")?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(15))).map_err(|_| "musicparty_ws_connect_failed")?;
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(15))).map_err(|_| "musicparty_ws_connect_failed")?;
    let stream = if parsed.scheme() == "https" {
        let mut roots = rustls::RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            roots.add(certificate).map_err(|_| "musicparty_tls_invalid")?;
        }
        if let Some(pem) = trust.and_then(|store| store.pem_for(origin).ok().flatten()) {
            let mut reader = std::io::BufReader::new(pem.as_bytes());
            for certificate in rustls_pemfile::certs(&mut reader) {
                roots.add(certificate.map_err(|_| "musicparty_tls_invalid")?).map_err(|_| "musicparty_tls_invalid")?;
            }
        }
        let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|_| "invalid_musicparty_origin")?;
        let connection = rustls::ClientConnection::new(std::sync::Arc::new(config), name).map_err(|_| "musicparty_tls_invalid")?;
        MaybeTlsStream::Rustls(rustls::StreamOwned::new(connection, tcp))
    } else { MaybeTlsStream::Plain(tcp) };
    tungstenite::client(request, stream)
        .map(|(socket, _)| socket)
        .map_err(|_| "musicparty_ws_connect_failed".into())
}









fn cookie_header(session: &MusicPartySession) -> String {
    let mut value = format!("MP_SESSION={}; MP_CSRF={}", session.session, session.csrf);
    if let Some(room_access) = &session.room_access { value.push_str("; MP_ROOM_ACCESS="); value.push_str(room_access); }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};

    #[cfg(windows)]
    #[test]
    #[ignore = "run npm run wss:rust in dev/mpv-e2e"]
    fn connects_to_external_wss_fixture() {
        let origin = std::env::var("WSS_E2E_ORIGIN").expect("run npm run wss:rust");
        let url = url::Url::parse(&origin).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert!(url.port().is_some());
        let cert = std::fs::read_to_string(std::env::var("WSS_E2E_CERT").unwrap()).unwrap();
        let dir = std::path::PathBuf::from(std::env::var("WSS_E2E_DIR").unwrap());
        let store = std::sync::Arc::new(OriginTrustStore::new(dir));

        // Never replace an existing origin's credential. Drop also runs on assertion failure.
        assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
        struct FixtureCredential(String);
        impl Drop for FixtureCredential {
            fn drop(&mut self) { let _ = MusicPartyCredentialStore.clear(&self.0); }
        }
        let _credential = FixtureCredential(origin.clone());
        MusicPartyCredentialStore.write(&origin, &MusicPartySession::new("fixture-session", "fixture-csrf")
            .with_room_access("fixture-room")).unwrap();
        let input = || WsConnectInput { origin: origin.clone(), room_id: "fixture".into(), client_version: "0.2.0".into() };
        let state = MusicPartyWsState::with_trust_store(store.clone());
        assert_eq!(state.connect(input()).err().as_deref(), Some("musicparty_ws_connect_failed"));
        assert!(state.0.lock().unwrap().is_none());
        println!("RUST_WSS_UNTRUSTED_REJECTED");

        let other_origin = origin.replace("127.0.0.1", "localhost");
        store.import(&other_origin, &cert).unwrap();
        assert_eq!(state.connect(input()).err().as_deref(), Some("musicparty_ws_connect_failed"));
        println!("RUST_WSS_OTHER_ORIGIN_REJECTED");
        store.import(&origin, &cert).unwrap();
        let event = state.connect(input()).expect("trusted cross-process connection");
        let hello: serde_json::Value = serde_json::from_str(&event.event).unwrap();
        assert_eq!(hello["type"], "server.hello");
        assert_eq!(hello["payload"]["apiVersion"], "2026-01");
        assert_eq!(hello["payload"]["minimumClientVersion"], "0.2.0");
        let received = thread::scope(|scope| {
            let receiver = scope.spawn(|| state.receive().unwrap());
            thread::sleep(std::time::Duration::from_millis(150));
            state.send(r#"{"type":"fixture.echo","payload":{"nonce":"rust-roundtrip"}}"#.into()).unwrap();
            receiver.join().unwrap()
        });
        let reply: serde_json::Value = serde_json::from_str(&received.event).unwrap();
        assert_eq!(reply, serde_json::json!({"type":"fixture.echo","payload":{"nonce":"rust-roundtrip"}}));
        state.disconnect().unwrap();
        assert_eq!(state.receive().err().as_deref(), Some("musicparty_ws_not_connected"));
        store.delete(&origin).unwrap();
        assert_eq!(state.connect(input()).err().as_deref(), Some("musicparty_ws_connect_failed"));
        println!("RUST_WSS_REMOVED_TRUST_REJECTED");
        store.delete(&other_origin).unwrap();
        MusicPartyCredentialStore.clear(&origin).unwrap();
        assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
        println!("RUST_WSS_CROSS_PROCESS_OK");
    }

    #[test]
    fn cookie_header_contains_all_origin_scoped_credentials() {
        let session = MusicPartySession::new("session-secret", "csrf-secret")
            .with_room_access("room-secret");
        assert_eq!(cookie_header(&session), "MP_SESSION=session-secret; MP_CSRF=csrf-secret; MP_ROOM_ACCESS=room-secret");
    }

    #[test]
    fn cookie_header_without_private_room_access_is_minimal() {
        let session = MusicPartySession::new("session-secret", "csrf-secret");
        assert_eq!(cookie_header(&session), "MP_SESSION=session-secret; MP_CSRF=csrf-secret");
    }

    #[test]
    fn room_validation_rejects_url_injection() {
        assert!(connect("http://127.0.0.1:1", "room?evil", "0.2.0").is_err());
        assert!(connect("http://127.0.0.1:1", "room\\evil", "0.2.0").is_err());
    }

    #[test]
    fn strict_version_parser_handles_numeric_versions() {
        assert!(parse_version("0.10.0").unwrap() > parse_version("0.2.0").unwrap());
        assert!(parse_version("0.2").is_none());
        assert!(parse_version("0.02.0").is_none());
        assert!(parse_version("0.2.0-beta").is_none());
    }

    #[test]
    fn local_server_versions_gate_socket_storage() {
        for (api, minimum, client, accepted) in [
            ("wrong", "0.2.0", "0.2.0", false),
            ("2026-01", "0.2.0", "0.1.9", false),
            ("2026-01", "0.2.0", "0.10.0", true),
            ("2026-01", "0.02.0", "0.2.0", false),
            ("2026-01", "0.2.0-beta", "0.2.0", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut socket = tungstenite::accept(stream).unwrap();
                assert!(socket.read().unwrap().into_text().unwrap().contains("client.hello"));
                socket.send(tungstenite::Message::Text(serde_json::json!({
                    "type": "server.hello", "payload": {"apiVersion": api, "minimumClientVersion": minimum}
                }).to_string())).unwrap();
            });
            let socket = connect_with_session(None, &origin, "lounge", client, &MusicPartySession::new("fixture", "fixture")).unwrap();
            let state = MusicPartyWsState::default();
            let result = state.negotiate(socket, client, state.1.load(Ordering::Acquire));
            if accepted {
                assert!(result.is_ok());
                assert!(state.0.lock().unwrap().is_some());
            } else {
                assert_eq!(result.err().as_deref(), Some("version-incompatible"));
                assert!(state.0.lock().unwrap().is_none());
                assert_eq!(state.receive().err().as_deref(), Some("musicparty_ws_not_connected"));
            }
            state.disconnect().unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn invalid_client_versions_are_rejected_before_opening_a_socket() {
        for client_version in ["0.2", "00.2.0", "0.2.0-beta", "-1.2.0", "0.2.0.1", "0. 2.0"] {
            let state = MusicPartyWsState::default();
            let result = state.connect(WsConnectInput { origin: "http://127.0.0.1:1".into(), room_id: "lounge".into(), client_version: client_version.into() });
            assert_eq!(result.err().as_deref(), Some("version-incompatible"));
            assert!(state.0.lock().unwrap().is_none());
        }
    }

    #[test]
    fn websocket_handshake_sends_cookie_origin_and_hello_negotiates() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected_origin = format!("http://{address}");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept_hdr(stream, |request: &tungstenite::handshake::server::Request, response: tungstenite::handshake::server::Response| {
                assert_eq!(request.headers().get("origin").unwrap().to_str().unwrap(), expected_origin);
                assert!(request.headers().get("cookie").unwrap().to_str().unwrap().contains("MP_SESSION=session-secret"));
                assert!(request.headers().get("cookie").unwrap().to_str().unwrap().contains("MP_ROOM_ACCESS=room-secret"));
                Ok(response)
            }).unwrap();
            let hello = socket.read().unwrap().into_text().unwrap();
            let value: serde_json::Value = serde_json::from_str(&hello).unwrap();
            assert_eq!(value["type"], "client.hello");
            assert_eq!(value["payload"]["apiVersion"], "2026-01");
            socket.send(tungstenite::Message::Text(r#"{"type":"server.hello","payload":{"apiVersion":"2026-01","minimumClientVersion":"0.2.0"}}"#.into())).unwrap();
        });
        let origin = format!("http://{address}");
        let session = MusicPartySession::new("session-secret", "csrf-secret").with_room_access("room-secret");
        let mut socket = connect_with_session(None, &origin, "lounge", "0.2.0", &session).unwrap();
        socket.send(tungstenite::Message::Text(r#"{"type":"client.hello","payload":{"apiVersion":"2026-01","clientVersion":"0.2.0"}}"#.into())).unwrap();
        let event = socket.read().unwrap().into_text().unwrap();
        assert!(event.contains("server.hello"));
        server.join().unwrap();
    }

    #[test]
    fn receive_does_not_hold_state_mutex_while_blocking() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _socket = tungstenite::accept(stream).unwrap();
            thread::sleep(std::time::Duration::from_millis(300));
        });
        let raw = connect_with_session(None, &format!("http://{address}"), "lounge", "0.2.0", &MusicPartySession::new("s", "c")).unwrap();
        let state = std::sync::Arc::new(MusicPartyWsState::default());
        *state.0.lock().unwrap() = Some(raw);
        let replacement_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let replacement_address = replacement_listener.local_addr().unwrap();
        let replacement_server = thread::spawn(move || {
            let (stream, _) = replacement_listener.accept().unwrap();
            let _socket = tungstenite::accept(stream).unwrap();
            thread::sleep(std::time::Duration::from_millis(200));
        });
        let replacement = connect_with_session(None, &format!("http://{replacement_address}"), "lounge", "0.2.0", &MusicPartySession::new("s", "c")).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = { let state = state.clone(); thread::spawn(move || tx.send(state.receive()).unwrap()) };
        std::thread::sleep(std::time::Duration::from_millis(10));
        state.disconnect().unwrap();
        *state.0.lock().unwrap() = Some(replacement);
        let result = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(result.as_ref().err().map(String::as_str), Some("musicparty_ws_disconnected"));
        worker.join().unwrap();
        assert!(state.0.lock().unwrap().is_some());
        server.join().unwrap();
        replacement_server.join().unwrap();
    }

    #[test]
    fn receive_reports_idle_timeout_for_a_half_open_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let _socket = tungstenite::accept(stream).unwrap();
            thread::sleep(std::time::Duration::from_millis(300));
        });
        let raw = connect_with_session(None, &format!("http://{address}"), "lounge", "0.2.0", &MusicPartySession::new("s", "c")).unwrap();
        let state = MusicPartyWsState::default();
        *state.0.lock().unwrap() = Some(raw);
        let started = std::time::Instant::now();
        assert_eq!(state.receive_with_idle_timeout(std::time::Duration::from_millis(125)).err().as_deref(), Some("musicparty_ws_idle_timeout"));
        assert!(started.elapsed() < std::time::Duration::from_millis(250));
        state.disconnect().unwrap();
        server.join().unwrap();
    }
}



