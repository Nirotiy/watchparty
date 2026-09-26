use std::{
    env,
    io::{Read, Write},
    net::TcpListener,
    thread,
};
use watchparty_desktop::{
    contracts::{ClientType, DesktopCommand, MediaSource},
    http::DesktopHttpTransport,
    transport::{RoomTransport, TransportError},
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
            None,
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

#[test]
#[ignore = "requires the isolated Node backend; run npm run test:desktop-http"]
fn desktop_native_entry_matches_live_node_protocol() {
    let base_url = required("DESKTOP_HTTP_BASE_URL");
    let media_id = required("DESKTOP_HTTP_MEDIA_ID");
    let mut transport = DesktopHttpTransport::new(base_url).expect("transport should build");
    let probe = transport.probe_desktop_backend().expect("probe should decode");
    assert_eq!(probe.status, "ok");
    assert_eq!(probe.protocol_version, 2);
    assert!(probe.capabilities.create_room && probe.capabilities.join_room);
    assert!(probe.capabilities.restore_session && probe.capabilities.media_search);
    assert!(probe.capabilities.media_queue && probe.capabilities.handoff_code);
    assert!(
        probe.capabilities.readiness,
        "the live backend must advertise the readiness capability"
    );

    // Readiness is an optional probe: an advertised backend must answer it, and the payload has to
    // decode into the shared shape the completion banner reads (component status is up|down).
    let readiness = transport
        .probe_desktop_readiness(true)
        .expect("readiness probe should not hard-fail")
        .expect("an advertised readiness capability must yield a payload");
    assert!(
        readiness.status == "ready" || readiness.status == "degraded",
        "unexpected readiness status: {}",
        readiness.status
    );
    assert_eq!(readiness.readiness_version, 1);
    assert_eq!(readiness.service, "watchparty");
    let core = readiness
        .components
        .core
        .as_ref()
        .expect("core component is mandatory");
    assert!(core.status == "up" || core.status == "down");
    // A backend that does not advertise it must be asked nothing at all.
    assert!(transport
        .probe_desktop_readiness(false)
        .expect("a declined probe is not an error")
        .is_none());

    let public = transport
        .create_desktop(&uuid::Uuid::new_v4().to_string(), "Public owner", None, None)
        .expect("public room creation should decode");
    assert_eq!(public.generation, 1);
    let public_generation = transport
        .claim_session(&public.room_id, &public.access_token)
        .expect("public room should restore from its token");
    assert!(transport.snapshot(&public.room_id, &public.access_token, public_generation, None)
        .expect("restored snapshot should decode").snapshot.is_some());

    let protected = transport
        .create_desktop(&uuid::Uuid::new_v4().to_string(), "PIN owner", Some("1234"), None)
        .expect("PIN room creation should decode");
    let guest_id = uuid::Uuid::new_v4().to_string();
    for (pin, expected) in [(None, "ROOM_PIN_REQUIRED"), (Some("9999"), "ROOM_PIN_REJECTED")] {
        match transport.access_desktop(&protected.room_id, &guest_id, "Guest", pin) {
            Err(TransportError::Http(401, body)) => assert!(body.contains(expected), "{body}"),
            other => panic!("expected {expected}, got {other:?}"),
        }
    }
    assert_eq!(
        transport.access_desktop("missing-room", &guest_id, "Guest", None),
        Err(TransportError::NotFound)
    );
    let guest_token = transport
        .access_desktop(&protected.room_id, &guest_id, "Guest", Some("1234"))
        .expect("correct PIN should grant access");
    let guest_generation = transport
        .claim_session(&protected.room_id, &guest_token)
        .expect("guest session should restore");
    assert!(transport.snapshot(&protected.room_id, &guest_token, guest_generation, None)
        .expect("guest snapshot should decode").snapshot.is_some());

    let search = transport.media_search("Show", None).expect("media search should decode");
    assert!(search.items.iter().any(|item| item.id == media_id));
    let owner_generation = transport
        .claim_session(&protected.room_id, &protected.access_token)
        .expect("owner session should restore");
    let snapshot = transport.snapshot(&protected.room_id, &protected.access_token, owner_generation, None)
        .expect("owner snapshot should decode").snapshot.expect("snapshot body");
    let owner_token = protected.owner_token.as_deref().expect("owner token");
    let unlocked = transport.command(&protected.room_id, &protected.access_token, owner_generation,
        &DesktopCommand::Lock { locked: false }, snapshot.revision, Some(owner_token))
        .expect("unlock should decode");
    assert!(unlocked.ok);
    let media = MediaSource::Http { url: "https://example.com/clip.mp4".into(), title: Some("Clip".into()) };
    let added = transport.command(&protected.room_id, &protected.access_token, owner_generation,
        &DesktopCommand::PlaylistAdd { media: media.clone() }, unlocked.revision, Some(owner_token))
        .expect("URL queue command should decode");
    assert!(added.ok);
    let queued = transport.snapshot(&protected.room_id, &protected.access_token, owner_generation, None)
        .expect("queue snapshot should decode").snapshot.expect("queue snapshot body");
    assert!(queued.playlist.iter().any(|item| item.media == media));
    let item_id = queued.playlist[0].id.clone();
    let played = transport.command(&protected.room_id, &protected.access_token, owner_generation,
        &DesktopCommand::PlaylistPlay { item_id }, queued.revision, Some(owner_token))
        .expect("playlist play should decode");
    assert!(played.ok);

    transport.leave(&protected.room_id, &guest_token, guest_generation).expect("guest cleanup");
    transport.leave(&protected.room_id, &protected.access_token, owner_generation).expect("owner cleanup");
    transport.leave(&public.room_id, &public.access_token, public_generation).expect("public cleanup");
    println!("WATCHPARTY_NATIVE_ENTRY_E2E_OK");
}
