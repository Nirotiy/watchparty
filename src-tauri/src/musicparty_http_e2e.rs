//! Opt-in cross-process acceptance against a newly bootstrapped MusicParty binary.
use super::*;
use crate::musicparty_ws::{MusicPartyWsState, WsConnectInput};
use serde_json::{json, Value};
use std::sync::Arc;

#[test]
#[ignore = "run npm run http:musicparty in dev/mpv-e2e"]
fn private_room_cookie_logout_against_real_server() {
    let origin = std::env::var("MP_E2E_ORIGIN").expect("run npm run http:musicparty");
    let parsed = url::Url::parse(&origin).unwrap();
    assert_eq!(parsed.scheme(), "http");
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert!(parsed.port().is_some());
    assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) { let _ = MusicPartyCredentialStore.clear(&self.0); }
    }
    let _cleanup = Cleanup(origin.clone());
    let client = Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap();
    let admin_response = client.post(format!("{origin}/api/account/login"))
        .json(&json!({"username":"e2e-admin", "password":std::env::var("MP_E2E_ADMIN_PASSWORD").unwrap()}))
        .send().unwrap();
    assert_eq!(admin_response.status().as_u16(), 200, "fresh test administrator login");
    let admin_cookie = |name| admin_response.cookies().find(|c| c.name() == name).unwrap().value().to_owned();
    let admin = MusicPartySession::new(admin_cookie("MP_SESSION"), admin_cookie("MP_CSRF"));
    let admin_request = |method: Method, path: &str, body: Value| {
        admin.apply(client.request(method, format!("{origin}{path}")).json(&body), true).unwrap().send().unwrap()
    };
    let password = "local-private-room-password";
    assert_eq!(admin_request(Method::PUT, "/api/rooms/lounge", json!({
        "name":"D1 private fixture", "isPrivate":true, "password":password
    })).status().as_u16(), 200);
    let bridge = MusicPartyBridge::default();
    let request = |method: &str, path: &str, body: Option<Value>| MusicPartyRequest {
        origin: origin.clone(), method: method.into(), path: path.into(), body, client_version: "0.2.0".into()
    };
    let redeem = || {
        let reply = admin_request(Method::POST, "/api/dev/rooms/lounge/invites", json!({"label":"Rust HTTP acceptance"}));
        assert_eq!(reply.status().as_u16(), 200);
        let invite: Value = reply.json().unwrap();
        let result = bridge.request(request("POST", "/api/desktop/v1/invites/redeem",
            Some(json!({"code":invite["code"], "displayName":"D1 fixture member"})))).unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(serde_json::from_str::<Value>(&result.body).unwrap()["roomId"], "lounge");
        let session = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
        assert!(!session.session.is_empty() && !session.csrf.is_empty());
        assert!(!result.body.contains(&session.session) && !result.body.contains(&session.csrf));
        session
    };
    let verify = |password: &str| bridge.request(request("POST", "/api/rooms/lounge/verify", Some(json!({"password":password})))).unwrap();
    let ws_input = || WsConnectInput { origin: origin.clone(), room_id: "lounge".into(), client_version: "0.2.0".into() };
    let first = redeem();
    assert!(first.room_access.is_none());
    assert!(MusicPartyWsState::default().connect(ws_input()).is_err(), "invite must not bypass private-room proof");
    for path in ["/api/rooms/lounge/verify", "/api/account/logout"] {
        let response = first.apply(client.post(format!("{origin}{path}")).json(&json!({"password":password})), false)
            .unwrap().send().unwrap();
        assert_eq!(response.status().as_u16(), 403, "missing CSRF must fail");
    }
    assert_eq!(verify("wrong").status, 403);
    assert!(MusicPartyCredentialStore.read(&origin).unwrap().unwrap().room_access.is_none());
    let proof = verify(password);
    assert_eq!(proof.status, 200);
    let first_authorized = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
    assert!(first_authorized.room_access.is_some());
    assert!(!proof.body.contains(first_authorized.room_access.as_ref().unwrap()));
    let socket = MusicPartyWsState::default();
    assert!(socket.connect(ws_input()).is_ok());
    socket.disconnect().unwrap();
    println!("MP_HTTP_PRIVATE_ROOM_AND_CSRF_OK");

    // Recreate the bridge: subsequent calls must load the real persisted cookies.
    let search = "/api/desktop/v1/search/local?q=fixture&offset=0&limit=1";
    assert_eq!(MusicPartyBridge::default().request(request("GET", search, None)).unwrap().status, 200);
    let other = origin.replace("127.0.0.1", "localhost");
    assert!(MusicPartyCredentialStore.read(&other).unwrap().is_none());
    let mut isolated = request("GET", search, None);
    isolated.origin = other;
    assert_eq!(bridge.request(isolated).unwrap().status, 401, "same server, different origin must not receive cookies");
    let second = redeem();
    assert!(first.session != second.session && first.csrf != second.csrf, "new invite must replace both cookies");
    assert!(second.room_access.is_none(), "new session must not retain another user's room proof");
    assert!(MusicPartyWsState::default().connect(ws_input()).is_err());
    println!("MP_HTTP_COOKIE_PERSISTENCE_ROTATION_ISOLATION_OK");

    let verified = verify(password);
    assert_eq!(verified.status, 200);
    let expires = serde_json::from_str::<Value>(&verified.body).unwrap()["expiresAt"].as_u64().unwrap();
    let now_ms = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    assert!((290_000..=310_000).contains(&expires.saturating_sub(now_ms())), "server's real five-minute lifetime");
    let before_expiry = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
    while now_ms() <= expires + 50 {
        let remaining = expires.saturating_add(51).saturating_sub(now_ms());
        println!("MP_HTTP_WAITING_FOR_REAL_ROOM_COOKIE_EXPIRY seconds={}", remaining.div_ceil(1000));
        std::thread::sleep(Duration::from_millis(remaining.min(30_000)));
    }
    assert!(MusicPartyWsState::default().connect(ws_input()).is_err(), "expired proof must fail at the real server");
    assert_eq!(verify(password).status, 200);
    let active = MusicPartyCredentialStore.read(&origin).unwrap().unwrap();
    assert!(active.room_access != before_expiry.room_access, "reverification must replace expired proof");
    println!("MP_HTTP_REAL_EXPIRY_AND_REVERIFY_OK");

    let socket = Arc::new(MusicPartyWsState::default());
    assert!(socket.connect(ws_input()).is_ok());
    let (tx, rx) = std::sync::mpsc::channel();
    let reader_socket = socket.clone();
    let reader = std::thread::spawn(move || {
        loop {
            if let Err(error) = reader_socket.receive() { let _ = tx.send(error); break; }
        }
    });
    assert_eq!(bridge.request(request("POST", "/api/account/logout", None)).unwrap().status, 204);
    assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none(), "logout must remove all native cookies");
    let closed = rx.recv_timeout(Duration::from_secs(5));
    socket.disconnect().unwrap();
    reader.join().unwrap();
    assert!(matches!(closed.as_deref(), Ok("musicparty_ws_closed" | "musicparty_ws_read_failed")), "server must close the active socket before local disconnect");
    let replay = active.apply(client.get(format!("{origin}/api/account/me")), false).unwrap().send().unwrap();
    assert_eq!(replay.status().as_u16(), 401, "old cookie must be revoked at the server");
    MusicPartyCredentialStore.write(&origin, &active).unwrap();
    assert!(MusicPartyWsState::default().connect(ws_input()).is_err(), "revoked cookie must not reconnect");
    bridge.clear(&origin).unwrap();
    assert_eq!(bridge.request(request("GET", search, None)).unwrap().status, 401);
    println!("MP_HTTP_SERVER_LOGOUT_REVOKES_HTTP_AND_WS_OK");

    let fresh = redeem();
    assert!(fresh.session != active.session && fresh.room_access.is_none());
    assert_eq!(verify(password).status, 200);
    assert!(socket.connect(ws_input()).is_ok());
    socket.disconnect().unwrap();
    assert_eq!(bridge.request(request("POST", "/api/account/logout", None)).unwrap().status, 204);
    // Explicitly revoke the displaced first identity as well, using only in-memory test cookies.
    assert_eq!(first.apply(client.post(format!("{origin}/api/account/logout")), true).unwrap().send().unwrap().status().as_u16(), 204);
    assert_eq!(admin_request(Method::POST, "/api/account/logout", Value::Null).status().as_u16(), 204);
    assert!(MusicPartyCredentialStore.read(&origin).unwrap().is_none());
    println!("MP_HTTP_RUST_REAL_SERVER_E2E_OK");
}
