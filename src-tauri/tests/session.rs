use std::collections::VecDeque;
use watchparty_desktop::{
    contracts::*,
    playback::{PlayerControlError, PlayerEngine, PlayerEvent},
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
    owned_snapshot(revision, item, "browser-1")
}

fn owned_snapshot(revision: u64, item: &str, owner: &str) -> RoomSnapshot {
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
        owner_client_id: owner.into(),
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
    snapshot_timings: VecDeque<Option<RequestTiming>>,
    resolves: VecDeque<Result<ResolvedMedia, TransportError>>,
    commands: VecDeque<Result<CommandAck, TransportError>>,
    command_revisions: Vec<u64>,
    command_owner_tokens: Vec<Option<String>>,
    claim_grants: VecDeque<Result<Option<String>, TransportError>>,
    resolve_count: usize,
    member_requests: usize,
    left: bool,
    clock_sync: bool,
    site_auth: Option<(String, String)>,
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
            owner_token: None,
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
    ) -> Result<SnapshotResponse, TransportError> {
        let snapshot = self.snapshots.pop_front().unwrap_or(Ok(None))?;
        Ok(SnapshotResponse {
            snapshot,
            timing: self.snapshot_timings.pop_front().flatten(),
        })
    }
    fn members(&mut self, _: &str, _: &str, _: u64) -> Result<Vec<RoomMember>, TransportError> {
        self.member_requests += 1;
        Ok(vec![])
    }
    fn command(
        &mut self,
        _: &str,
        _: &str,
        _: u64,
        _: &DesktopCommand,
        revision: u64,
        owner_token: Option<&str>,
    ) -> Result<CommandAck, TransportError> {
        self.command_revisions.push(revision);
        self.command_owner_tokens
            .push(owner_token.map(str::to_owned));
        self.commands.pop_front().unwrap_or(Ok(ack(revision + 1)))
    }
    fn claim_owner_grant(
        &mut self,
        _: &str,
        _: &str,
        _: u64,
    ) -> Result<Option<String>, TransportError> {
        self.claim_grants.pop_front().unwrap_or(Ok(None))
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
    fn site_basic_auth(&self) -> Option<(&str, &str)> {
        self.site_auth
            .as_ref()
            .map(|(username, password)| (username.as_str(), password.as_str()))
    }
    /// Mirrors the real transport: credentials only ride on same-origin
    /// (`https://fallback`, the fake backend's) URLs.
    fn site_basic_auth_for(&self, media_url: &str) -> Option<(&str, &str)> {
        let same_origin = reqwest::Url::parse(media_url)
            .ok()
            .zip(reqwest::Url::parse("https://fallback").ok())
            .is_some_and(|(target, backend)| target.origin() == backend.origin());
        if same_origin {
            self.site_basic_auth()
        } else {
            None
        }
    }
    fn supports_clock_sync(&self) -> bool {
        self.clock_sync
    }
}
#[derive(Default)]
struct FakePlayer {
    loads: Vec<(String, String, bool, u64, Option<String>, bool)>,
    events: VecDeque<PlayerEvent>,
    applied: usize,
    estimated_server_times: Vec<i64>,
    volumes: Vec<f64>,
    local_pauses: Vec<bool>,
    local_seeks: Vec<f64>,
    audio_tracks: Vec<i64>,
    subtitle_tracks: Vec<Option<i64>>,
    state: PlayerState,
    disposed: bool,
}
impl PlayerEngine for FakePlayer {
    fn load(&mut self, request: watchparty_desktop::playback::PlaybackLoad<'_>) {
        self.loads.push((
            request.url.into(),
            request.user_agent.into(),
            request.fallback,
            request.generation,
            request.playlist_item_id.map(String::from),
            request.basic_auth.is_some(),
        ));
    }
    fn apply_shared_state(&mut self, _: &RoomSnapshot, estimated_server_time_ms: i64) {
        self.applied += 1;
        self.estimated_server_times.push(estimated_server_time_ms);
    }
    fn set_volume(&mut self, volume: f64) {
        self.volumes.push(volume);
    }
    fn set_local_paused(&mut self, paused: bool) -> Result<(), PlayerControlError> {
        self.local_pauses.push(paused);
        Ok(())
    }
    fn seek_local_absolute(&mut self, position_seconds: f64) -> Result<(), PlayerControlError> {
        self.local_seeks.push(position_seconds);
        Ok(())
    }
    fn select_audio_track(&mut self, track_id: i64) -> Result<(), PlayerControlError> {
        self.audio_tracks.push(track_id);
        Ok(())
    }
    fn select_subtitle_track(&mut self, track_id: Option<i64>) -> Result<(), PlayerControlError> {
        self.subtitle_tracks.push(track_id);
        Ok(())
    }
    fn state(&self) -> PlayerState {
        self.state.clone()
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
    t.site_auth = Some(("viewer".into(), "secret".into()));
    let mut p = FakePlayer::default();
    p.events.push_back(PlayerEvent::Error {
        generation: 1,
        retryable: true,
    });
    p.events.push_back(PlayerEvent::Ended {
        generation: 1,
        reason: watchparty_desktop::playback::PlayerEndReason::Eof,
        playlist_item_id: Some("i1".into()),
    });
    let mut s = DesktopSession::new(t, p);
    let events = s.start("TICKET_SECRET", 0).unwrap();
    s.handle_player_events(1);
    s.handle_player_events(2);
    assert_eq!(s.transport.resolve_count, 3);
    assert!(s.player.loads.iter().any(|x| x.2));
    assert_eq!(s.revision(), Some(2));
    assert_eq!(s.player.loads.last().unwrap().3, 2);
    assert_eq!(s.player.loads.last().unwrap().4.as_deref(), Some("i2"));
    assert!(s.player.loads.last().unwrap().5);
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
    s.player.events.push_back(PlayerEvent::Ended {
        generation: 0,
        reason: watchparty_desktop::playback::PlayerEndReason::Eof,
        playlist_item_id: Some("i1".into()),
    });
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

#[test]
fn successful_command_refreshes_the_authoritative_snapshot() {
    let mut transport = FakeTransport::default();
    let mut updated = snapshot(2, "i1");
    updated.paused = false;
    updated.position_seconds = 12.5;
    transport.commands.push_back(Ok(ack(2)));
    transport.snapshots.push_back(Ok(Some(updated)));

    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();
    let applied_before = session.player.applied;

    let result = session.execute(DesktopCommand::Play, 100).unwrap();

    assert!(result.ok);
    assert_eq!(session.revision(), Some(2));
    assert_eq!(session.transport.command_revisions, vec![1]);
    assert_eq!(session.player.applied, applied_before + 1);
    let event = serde_json::to_value(session.event()).unwrap();
    assert_eq!(event["state"]["room"]["paused"], false);
    assert_eq!(event["state"]["room"]["positionSeconds"], 12.5);
}

#[test]
fn volume_is_local_and_never_reaches_the_room_transport() {
    let mut session = DesktopSession::new(FakeTransport::default(), FakePlayer::default());
    session.start("ticket", 0).unwrap();

    let result = session
        .execute(DesktopCommand::Volume { volume: 35.0 }, 10)
        .unwrap();

    assert!(result.ok);
    assert_eq!(session.player.volumes, vec![35.0]);
    assert!(session.transport.command_revisions.is_empty());
}

#[test]
fn track_selection_is_local_and_never_reaches_the_room_transport() {
    let mut session = DesktopSession::new(FakeTransport::default(), FakePlayer::default());
    session.start("ticket", 0).unwrap();

    session
        .execute(DesktopCommand::SelectAudioTrack { track_id: 2 }, 10)
        .unwrap();
    session
        .execute(
            DesktopCommand::SelectSubtitleTrack { track_id: Some(4) },
            10,
        )
        .unwrap();
    session
        .execute(DesktopCommand::SelectSubtitleTrack { track_id: None }, 10)
        .unwrap();

    assert_eq!(session.player.audio_tracks, vec![2]);
    assert_eq!(session.player.subtitle_tracks, vec![Some(4), None]);
    assert!(session.transport.command_revisions.is_empty());
}

#[test]
fn resync_is_local_and_projects_the_live_authoritative_position() {
    let mut transport = FakeTransport::default();
    let mut playing = snapshot(2, "i1");
    playing.paused = false;
    playing.position_seconds = 10.0;
    playing.server_time_ms = 1_000;
    playing.playback_rate = 2.0;
    transport.snapshots.push_back(Ok(Some(playing)));
    let player = FakePlayer {
        state: PlayerState {
            loaded: true,
            ..PlayerState::default()
        },
        ..FakePlayer::default()
    };
    let mut session = DesktopSession::new(transport, player);
    session.start("ticket", 0).unwrap();
    session.refresh_snapshot(2_000).unwrap();

    let result = session.execute(DesktopCommand::Resync, 2_500).unwrap();

    assert!(result.ok);
    assert_eq!(session.player.local_seeks, vec![13.0]);
    assert!(session.transport.command_revisions.is_empty());
}

#[test]
fn hidden_player_stays_locally_paused_and_resumes_from_room_snapshot() {
    let mut transport = FakeTransport::default();
    let mut playing = snapshot(2, "i1");
    playing.paused = false;
    playing.position_seconds = 24.0;
    transport.snapshots.push_back(Ok(Some(playing)));
    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();

    session.set_local_suspended(true, 10).unwrap();
    session.poll(2_000);
    session.set_local_suspended(false, 2_100).unwrap();

    assert_eq!(session.player.local_pauses, vec![true, true]);
    assert_eq!(session.player.applied, 1);
    assert!(session.transport.command_revisions.is_empty());
}

#[test]
fn retry_resolves_once_then_uses_the_cached_fallback() {
    let mut transport = FakeTransport::default();
    transport.resolves.push_back(Ok(ResolvedMedia {
        direct_url: Some("https://direct-1".into()),
        fallback_url: Some("https://fallback".into()),
        user_agent: "pan.baidu.com".into(),
    }));
    transport.resolves.push_back(Ok(ResolvedMedia {
        direct_url: Some("https://direct-2".into()),
        fallback_url: Some("https://fallback".into()),
        user_agent: "pan.baidu.com".into(),
    }));
    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();
    session.player.events.push_back(PlayerEvent::Error {
        generation: 1,
        retryable: true,
    });
    assert_eq!(session.handle_player_events(1).len(), 1);
    assert_eq!(session.transport.resolve_count, 2);
    assert_eq!(session.player.loads.last().unwrap().0, "https://direct-2");

    session.player.events.push_back(PlayerEvent::Error {
        generation: 1,
        retryable: true,
    });
    assert_eq!(session.handle_player_events(2).len(), 1);
    assert_eq!(session.transport.resolve_count, 2);
    assert_eq!(session.player.loads.last().unwrap().0, "https://fallback");
    assert!(session.player.loads.last().unwrap().2);
}

#[test]
fn exhausted_playback_recovery_emits_a_failed_state() {
    let mut transport = FakeTransport::default();
    transport.resolves.push_back(Ok(ResolvedMedia {
        direct_url: Some("https://direct-1".into()),
        fallback_url: None,
        user_agent: "pan.baidu.com".into(),
    }));
    transport.resolves.push_back(Ok(ResolvedMedia {
        direct_url: None,
        fallback_url: None,
        user_agent: "pan.baidu.com".into(),
    }));
    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();
    session.player.events.push_back(PlayerEvent::Error {
        generation: 1,
        retryable: true,
    });

    let events = session.handle_player_events(1);

    assert_eq!(session.transport.resolve_count, 2);
    assert_eq!(session.status, SessionStatus::Failed);
    assert_eq!(events.len(), 1);
    let event = serde_json::to_string(&events[0]).unwrap();
    assert!(event.contains("MEDIA_RESOLVE_FAILED"));
}

#[test]
fn old_or_non_eof_end_events_cannot_advance_the_current_item() {
    let mut transport = FakeTransport::default();
    transport.snapshots.push_back(Ok(Some(snapshot(2, "i2"))));
    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();
    session.refresh_snapshot(1).unwrap();
    assert_eq!(session.player.loads.last().unwrap().3, 2);

    session.player.events.push_back(PlayerEvent::Ended {
        generation: 1,
        reason: watchparty_desktop::playback::PlayerEndReason::Eof,
        playlist_item_id: Some("i1".into()),
    });
    session.player.events.push_back(PlayerEvent::Ended {
        generation: 2,
        reason: watchparty_desktop::playback::PlayerEndReason::Stopped,
        playlist_item_id: Some("i2".into()),
    });
    assert!(session.handle_player_events(2).is_empty());
    assert!(session.transport.command_revisions.is_empty());
}

#[test]
fn clock_is_calibrated_before_player_state_is_applied() {
    let mut transport = FakeTransport {
        clock_sync: true,
        ..FakeTransport::default()
    };
    for (sent, received, server) in [(0, 100, 60), (100, 200, 155), (200, 300, 245)] {
        let mut value = snapshot(1, "i1");
        value.server_time_ms = server;
        transport.snapshots.push_back(Ok(Some(value)));
        transport.snapshot_timings.push_back(Some(RequestTiming {
            sent_ms: sent,
            received_ms: received,
        }));
    }
    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 300).unwrap();
    session
        .player
        .events
        .push_back(PlayerEvent::Loaded { generation: 1 });
    session.handle_player_events(400);
    assert_eq!(session.player.estimated_server_times, vec![405]);
}

#[test]
fn frequent_snapshot_polls_keep_member_refreshes_throttled() {
    let mut session = DesktopSession::new(FakeTransport::default(), FakePlayer::default());
    session.start("ticket", 0).unwrap();
    assert_eq!(session.transport.member_requests, 1);

    for now in [250, 500, 1_000, 1_999] {
        session.poll(now);
    }
    assert_eq!(session.transport.member_requests, 1);

    session.poll(2_000);
    assert_eq!(session.transport.member_requests, 2);
}

#[test]
fn renderer_receives_the_effective_shared_control_permission() {
    let mut transport = FakeTransport::default();
    let mut locked = snapshot(2, "i1");
    locked.locked = true;
    transport.snapshots.push_back(Ok(Some(locked)));

    let mut session = DesktopSession::new(transport, FakePlayer::default());
    session.start("ticket", 0).unwrap();
    let initial = serde_json::to_value(session.event()).unwrap();
    assert_eq!(initial["state"]["canControlSharedPlayback"], true);

    session.poll(250);
    let locked = serde_json::to_value(session.event()).unwrap();
    assert_eq!(locked["state"]["canControlSharedPlayback"], false);
}

#[test]
fn owner_commands_gate_on_ownership_and_persist_transitions() {
    let ownership_events: std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

    let mut transport = FakeTransport::default();
    transport
        .snapshots
        .push_back(Ok(Some(owned_snapshot(1, "i1", "d1"))));

    let sink = std::sync::Arc::clone(&ownership_events);
    let mut session = DesktopSession::new(transport, FakePlayer::default())
        .with_owner_token_persist(Box::new(move |token| {
            sink.lock().unwrap().push(token);
        }));

    // Restoring a session that owns the room starts with the persisted token.
    session
        .start_persisted(
            "r1".into(),
            "d1".into(),
            "tok".into(),
            Some("ot-1".into()),
            0,
        )
        .unwrap();
    session.poll(250);
    assert!(ownership_events.lock().unwrap().is_empty());

    // Owner command rides with the owner token.
    session
        .execute(DesktopCommand::Lock { locked: true }, 300)
        .unwrap();
    assert_eq!(
        session.transport.command_owner_tokens.pop(),
        Some(Some("ot-1".into()))
    );

    // Ownership moving away clears the token and persists the drop.
    session
        .transport
        .snapshots
        .push_back(Ok(Some(owned_snapshot(2, "i1", "browser-1"))));
    session.poll(500);
    assert_eq!(
        ownership_events.lock().unwrap().last().map(Option::is_none),
        Some(true)
    );
    let rejected = session
        .execute(DesktopCommand::Lock { locked: false }, 600)
        .unwrap();
    assert_eq!(
        rejected.error.as_ref().map(|error| error.code.as_str()),
        Some("FORBIDDEN")
    );
    assert!(session.transport.command_owner_tokens.last().is_none());

    // A queued grant from an incoming transfer is claimed exactly once and the
    // new token rides on the next owner command.
    session
        .transport
        .snapshots
        .push_back(Ok(Some(owned_snapshot(3, "i1", "d1"))));
    session
        .transport
        .claim_grants
        .push_back(Ok(Some("ot-2".into())));
    session.poll(750);
    assert_eq!(
        ownership_events.lock().unwrap().last().cloned(),
        Some(Some("ot-2".into()))
    );
    session
        .execute(
            DesktopCommand::TransferOwner {
                target_client_id: "browser-1".into(),
            },
            800,
        )
        .unwrap();
    assert_eq!(
        session.transport.command_owner_tokens.pop(),
        Some(Some("ot-2".into()))
    );

    // Non-owner commands never carry the owner token.
    session.execute(DesktopCommand::Pause, 900).unwrap();
    assert_eq!(session.transport.command_owner_tokens.pop(), Some(None));
}
