use std::{
    env,
    io::{Read, Write},
    net::TcpListener,
    thread,
};
use watchparty_desktop::{
    contracts::{ClientType, DesktopCommand, MediaSource},
    http::DesktopHttpTransport,
    transport::RoomTransport,
};

fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("missing {name}"))
}

#[test]
fn site_basic_auth_and_room_token_use_separate_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind auth test server");
    let address = listener.local_addr().expect("read auth test address");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept auth test request");
        let mut request = [0_u8; 4096];
        let size = stream.read(&mut request).expect("read auth test request");
        let request = String::from_utf8_lossy(&request[..size]);
        let request_lowercase = request.to_ascii_lowercase();
        let authorization_headers = request_lowercase
            .lines()
            .filter(|line| line.starts_with("authorization:"))
            .collect::<Vec<_>>();
        let room_token_headers = request_lowercase
            .lines()
            .filter(|line| line.starts_with("x-watchparty-token:"))
            .collect::<Vec<_>>();
        assert_eq!(authorization_headers.len(), 1);
        assert!(authorization_headers[0].starts_with("authorization: basic "));
        assert_eq!(room_token_headers, vec!["x-watchparty-token: token"]);
        assert!(!request_lowercase.contains("authorization: bearer "));
        assert!(request.contains("YWxpY2U6c2VjcmV0"));
        let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream
            .write_all(response.as_bytes())
            .expect("write auth test response");
    });
    let mut transport =
        DesktopHttpTransport::with_site_basic_auth(format!("http://{address}"), "alice", "secret")
            .expect("transport should build");
    assert!(transport.has_site_basic_auth());
    assert!(transport
        .snapshot("room", "token", 1, None)
        .expect("204 should decode")
        .snapshot
        .is_none());
    server.join().expect("auth test server should finish");
    transport.clear_site_basic_auth();
    assert!(!transport.has_site_basic_auth());
}

#[test]
#[ignore = "requires the isolated Node backend; run npm run test:desktop-http"]
fn desktop_http_transport_matches_live_node_protocol() {
    let base_url = required("DESKTOP_HTTP_BASE_URL");
    let ticket = required("DESKTOP_HTTP_TICKET");
    let expected_room_id = required("DESKTOP_HTTP_ROOM_ID");
    let media_id = required("DESKTOP_HTTP_MEDIA_ID");
    let openlist_port: u16 = required("DESKTOP_HTTP_OPENLIST_PORT")
        .parse()
        .expect("valid OpenList port");
    let mut transport =
        DesktopHttpTransport::with_site_basic_auth(base_url, "alice", "test-password")
            .expect("transport should build");
    assert!(transport.has_site_basic_auth());

    let handoff = transport
        .redeem_desktop(&ticket)
        .expect("desktop handoff should decode");
    assert_eq!(handoff.room_id, expected_room_id);
    assert!(!handoff.access_token.is_empty());
    assert_eq!(
        handoff.snapshot.source.as_ref().map(MediaSource::key),
        Some(format!("openlist:{media_id}"))
    );

    let generation = transport
        .claim_session(&handoff.room_id, &handoff.access_token)
        .expect("desktop session claim should decode");
    assert!(generation > 0);
    let members = transport
        .members(&handoff.room_id, &handoff.access_token, generation)
        .expect("members should decode");
    assert_eq!(members.len(), 2);
    assert!(members
        .iter()
        .any(|member| member.client_type == ClientType::Desktop));

    match transport.snapshot(
        &handoff.room_id,
        &handoff.access_token,
        generation + 1,
        None,
    ) {
        Err(watchparty_desktop::transport::TransportError::Http(status, body)) => {
            assert_eq!(status, 409);
            assert!(body.contains("SESSION_GENERATION_STALE"));
        }
        other => panic!("expected stale generation response, got {other:?}"),
    }

    let unchanged = transport
        .snapshot(
            &handoff.room_id,
            &handoff.access_token,
            generation,
            Some(handoff.snapshot.revision),
        )
        .expect("204 snapshot should be accepted");
    assert!(unchanged.snapshot.is_none());

    let snapshot = transport
        .snapshot(&handoff.room_id, &handoff.access_token, generation, None)
        .expect("snapshot should decode")
        .snapshot
        .expect("uncached snapshot should have a body");
    assert_eq!(snapshot.revision, handoff.snapshot.revision);
    assert!(!snapshot.loop_enabled);

    let ack = transport
        .command(
            &handoff.room_id,
            &handoff.access_token,
            generation,
            &DesktopCommand::Play,
            snapshot.revision,
        )
        .expect("command ACK should decode");
    assert!(ack.ok);
    assert!(ack.revision > snapshot.revision);

    let source = snapshot.source.expect("test room should have media");
    let resolved = transport
        .resolve(&handoff.room_id, &handoff.access_token, generation, &source)
        .expect("resolve response should decode");
    let direct_url = format!("http://127.0.0.1:{openlist_port}/d/direct.mp4");
    let fallback_url = format!("http://127.0.0.1:{openlist_port}/p/clip.mp4");
    assert_eq!(resolved.direct_url.as_deref(), Some(direct_url.as_str()));
    assert_eq!(
        resolved.fallback_url.as_deref(),
        Some(fallback_url.as_str())
    );
    assert_eq!(resolved.user_agent, "pan.baidu.com");

    transport
        .leave(&handoff.room_id, &handoff.access_token, generation)
        .expect("session cleanup should return 204");
    transport.clear_site_basic_auth();
    assert!(!transport.has_site_basic_auth());
    assert!(transport
        .snapshot(&handoff.room_id, &handoff.access_token, generation, None)
        .is_err());
}
