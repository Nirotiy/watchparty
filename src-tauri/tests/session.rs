use std::collections::VecDeque;
use watchparty_desktop::{
    contracts::*,
    playback::{PlayerEngine, PlayerEvent},
    session::{DesktopSession, SessionStatus},
    transport::*,
};

fn source() -> MediaSource {
    MediaSource::Openlist {
        media_id: "m1".into(),
        title: "clip.mp4".into(),
        container: "mp4".into(),
        display_path: None,
    }
}
fn snapshot(revision: u64, item: &str) -> RoomSnapshot {
    RoomSnapshot {
        revision,
        source: Some(source()),
        current_playlist_item_id: Some(item.into()),
        position_seconds: 0.0,
        server_time_ms: 1000,
        paused: true,
        playback_rate: 1.0,
        loop_enabled: true,
        locked: false,
        owner_client_id: "browser-1".into(),
        playlist: vec![],
    }
}
fn ack(revision: u64) -> CommandAck {
    CommandAck {
        ok: true,
        revision,
        error: None,
    }
}

#[derive(Default)]
struct FakeTransport {
    snapshots: VecDeque<Result<Option<RoomSnapshot>, TransportError>>,
    resolves: VecDeque<Result<ResolvedMedia, TransportError>>,
    commands: VecDeque<Result<CommandAck, TransportError>>,
    command_revisions: Vec<u64>,
    resolve_count: usize,
    left: bool,
}
impl RoomTransport for FakeTransport {
    fn redeem_desktop(&mut self, _: &str) -> Result<Handoff, TransportError> {
        Ok(Handoff {
            room_id: "r1".into(),
            client_id: "d1".into(),
            access_token: "SECRET_TOKEN".into(),
            nickname: "Desktop".into(),
            generation: 1,
            snapshot: snapshot(1, "i1"),
            members: vec![],
        })
    }
    fn claim_session(&mut self, _: &str, _: &str) -> Result<u64, TransportError> {
        Ok(1)
    }
    fn snapshot(
        &mut self,
        _: &str,
        _: &str,
        _: u64,
        _: Option<u64>,
    ) -> Result<Option<RoomSnapshot>, TransportError> {
        self.snapshots.pop_front().unwrap_or(Ok(None))
    }
    fn members(&mut self, _: &str, _: &str, _: u64) -> Result<Vec<RoomMember>, TransportError> {
        Ok(vec![])
    }
    fn command(
        &mut self,
        _: &str,
        _: &str,
        _: u64,
        _: &DesktopCommand,
        revision: u64,
    ) -> Result<CommandAck, TransportError> {
        self.command_revisions.push(revision);
        self.commands.pop_front().unwrap_or(Ok(ack(revision + 1)))
    }
    fn resolve(
        &mut self,
        _: &str,
        _: &str,
        _: u64,
        _: &MediaSource,
    ) -> Result<ResolvedMedia, TransportError> {
        self.resolve_count += 1;
        self.resolves.pop_front().unwrap_or(Ok(ResolvedMedia {
            direct_url: Some("https://direct/SECRET_DIRECT".into()),
            fallback_url: Some("https://fallback/SECRET_DIRECT".into()),
            user_agent: "pan.baidu.com".into(),
        }))
    }
    fn leave(&mut self, _: &str, _: &str, _: u64) -> Result<(), TransportError> {
        self.left = true;
        Ok(())
    }
}
#[derive(Default)]
struct FakePlayer {
    loads: Vec<(String, String, bool, u64)>,
    events: VecDeque<PlayerEvent>,
    applied: usize,
    disposed: bool,
}
impl PlayerEngine for FakePlayer {
    fn load(&mut self, url: &str, ua: &str, fallback: bool, g: u64) {
        self.loads.push((url.into(), ua.into(), fallback, g));
    }
    fn apply_shared_state(&mut self, _: &RoomSnapshot) {
        self.applied += 1;
    }
    fn state(&self) -> PlayerState {
        PlayerState::default()
    }
    fn drain_events(&mut self) -> Vec<PlayerEvent> {
        self.events.drain(..).collect()
    }
    fn dispose(&mut self) {
        self.disposed = true;
    }
}

#[test]
fn full_chain_redacts_secret_and_refreshes_after_eof() {
    let mut t = FakeTransport::default();
    t.resolves.push_back(Ok(ResolvedMedia {
        direct_url: Some("https://direct/SECRET_DIRECT".into()),
        fallback_url: Some("https://fallback/SECRET_DIRECT".into()),
        user_agent: "pan.baidu.com".into(),
    }));
    t.resolves.push_back(Ok(ResolvedMedia {
        direct_url: Some("https://direct/SECRET_DIRECT".into()),
        fallback_url: Some("https://fallback/SECRET_DIRECT".into()),
        user_agent: "pan.baidu.com".into(),
    }));
    t.resolves.push_back(Ok(ResolvedMedia {
        direct_url: None,
        fallback_url: Some("https://fallback/SECRET_DIRECT".into()),
        user_agent: "pan.baidu.com".into(),
    }));
    t.snapshots.push_back(Ok(Some(snapshot(2, "i2"))));
    t.commands.push_back(Ok(ack(2)));
    let mut p = FakePlayer::default();
    p.events.push_back(PlayerEvent::Error {
        generation: 1,
        retryable: true,
    });
    p.events.push_back(PlayerEvent::Ended { generation: 1 });
    let mut s = DesktopSession::new(t, p);
    let events = s.start("TICKET_SECRET", 0).unwrap();
    s.handle_player_events(1);
    s.handle_player_events(2);
    assert_eq!(s.transport.resolve_count, 3);
    assert!(s.player.loads.iter().any(|x| x.2));
    assert_eq!(s.revision(), Some(2));
    assert_eq!(s.player.loads.last().unwrap().3, 1);
    for event in events {
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("SECRET_TOKEN"));
        assert!(!json.contains("SECRET_DIRECT"));
        assert!(!json.contains("TICKET_SECRET"));
    }
    s.stop().unwrap();
    assert!(s.player.disposed);
    assert!(s.transport.left);
}

#[test]
fn stale_generation_is_ignored_and_expiry_is_terminal() {
    let mut t = FakeTransport::default();
    t.snapshots.push_back(Err(TransportError::Unauthorized));
    let mut s = DesktopSession::new(t, FakePlayer::default());
    s.start("ticket", 0).unwrap();
    s.player
        .events
        .push_back(PlayerEvent::Ended { generation: 0 });
    assert!(s.handle_player_events(0).is_empty());
    assert!(s.poll(0).is_empty() || s.status == SessionStatus::Expired);
    assert_eq!(s.status, SessionStatus::Expired);
    assert!(s.poll(10_000).is_empty());
}

#[test]
fn network_errors_back_off() {
    let mut t = FakeTransport::default();
    t.snapshots
        .push_back(Err(TransportError::Network("down".into())));
    t.snapshots
        .push_back(Err(TransportError::Network("down".into())));
    let mut s = DesktopSession::new(t, FakePlayer::default());
    s.start("ticket", 0).unwrap();
    s.poll(0);
    assert_eq!(s.status, SessionStatus::Backoff);
    let event = serde_json::to_string(&s.event()).unwrap();
    assert!(event.contains("NETWORK_BACKOFF"));
    assert!(s.poll(1000).is_empty());
    s.poll(2000);
    assert_eq!(s.status, SessionStatus::Backoff);
}

#[test]
fn command_and_http_errors_are_exposed_as_sanitized_ui_errors() {
    let mut transport = FakeTransport::default();
    transport.commands.push_back(Ok(CommandAck {
        ok: false,
        revision: 0,
        error: Some(UiError {
            code: "FORBIDDEN".into(),
            message: "room is locked".into(),
        }),
    }));
    transport.snapshots.push_back(Err(TransportError::Http(
        409,
        r#"{"code":"SESSION_GENERATION_STALE","message":"session replaced"}"#.into(),
    )));
    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();
    let ack = session.execute(DesktopCommand::Play, 0).unwrap();
    assert!(!ack.ok);
    let command_event = serde_json::to_string(&session.event()).unwrap();
    assert!(command_event.contains("FORBIDDEN"));
    assert!(!command_event.contains("ticket"));

    let events = session.poll(0);
    assert_eq!(events.len(), 1);
    let http_event = serde_json::to_string(&events[0]).unwrap();
    assert!(http_event.contains("SESSION_GENERATION_STALE"));
    assert!(!http_event.contains("directUrl"));
}
