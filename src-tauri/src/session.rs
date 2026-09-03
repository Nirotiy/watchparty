use crate::{
    commands::validate_command,
    contracts::*,
    playback::{PlaybackAction, PlaybackPolicy, PlayerEngine, PlayerEvent},
    transport::{RoomTransport, TransportError},
};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionStatus {
    New,
    Connecting,
    Ready,
    Backoff,
    Expired,
    Failed,
    Stopped,
}

pub struct DesktopSession<T: RoomTransport, P: PlayerEngine> {
    pub transport: T,
    pub player: P,
    pub status: SessionStatus,
    room_id: Option<String>,
    token: Option<String>,
    client_id: Option<String>,
    generation: u64,
    revision: Option<u64>,
    snapshot: Option<RoomSnapshot>,
    members: Vec<RoomMember>,
    policy: PlaybackPolicy,
    attempt: u32,
    retry_at: i64,
    command_retry_used: bool,
    capability: NativeCapabilityReport,
    last_error: Option<UiError>,
}

impl<T: RoomTransport, P: PlayerEngine> DesktopSession<T, P> {
    pub fn new(transport: T, player: P) -> Self {
        Self {
            transport,
            player,
            status: SessionStatus::New,
            room_id: None,
            token: None,
            client_id: None,
            generation: 0,
            revision: None,
            snapshot: None,
            members: Vec::new(),
            policy: PlaybackPolicy::new(),
            attempt: 0,
            retry_at: 0,
            command_retry_used: false,
            capability: NativeCapabilityReport::default(),
            last_error: None,
        }
    }

    pub fn start(&mut self, ticket: &str, now: i64) -> Result<Vec<DesktopEvent>, TransportError> {
        self.status = SessionStatus::Connecting;
        self.last_error = None;
        let handoff = match self.transport.redeem_desktop(ticket) {
            Ok(value) => value,
            Err(error) => {
                self.handle_transport_error(&error, now);
                return Err(error);
            }
        };
        let generation = match self
            .transport
            .claim_session(&handoff.room_id, &handoff.access_token)
        {
            Ok(value) => value,
            Err(error) => {
                self.handle_transport_error(&error, now);
                return Err(error);
            }
        };
        self.room_id = Some(handoff.room_id);
        self.token = Some(handoff.access_token);
        self.client_id = Some(handoff.client_id);
        self.generation = generation;
        self.revision = Some(handoff.snapshot.revision);
        self.snapshot = None;
        self.members = handoff.members;
        self.policy.begin(generation);
        self.status = SessionStatus::Ready;
        self.attempt = 0;
        self.retry_at = now;
        if let Err(error) = self.refresh_members() {
            self.handle_transport_error(&error, now);
            return Err(error);
        }
        if let Err(error) = self.apply_snapshot(handoff.snapshot, now) {
            self.handle_transport_error(&error, now);
            return Err(error);
        }
        Ok(vec![self.event()])
    }

    pub fn poll(&mut self, now: i64) -> Vec<DesktopEvent> {
        if !matches!(self.status, SessionStatus::Ready | SessionStatus::Backoff)
            || now < self.retry_at
        {
            return Vec::new();
        }
        let (room, token) = match (&self.room_id, &self.token) {
            (Some(room), Some(token)) => (room.clone(), token.clone()),
            _ => return Vec::new(),
        };
        let snapshot = match self
            .transport
            .snapshot(&room, &token, self.generation, self.revision)
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.handle_transport_error(&error, now);
                return vec![self.event()];
            }
        };
        self.attempt = 0;
        self.status = SessionStatus::Ready;
        self.last_error = None;
        if let Some(snapshot) = snapshot {
            self.revision = Some(snapshot.revision);
            if let Err(error) = self.apply_snapshot(snapshot, now) {
                self.handle_transport_error(&error, now);
                return vec![self.event()];
            }
        }
        if let Err(error) = self.refresh_members() {
            self.handle_transport_error(&error, now);
            return vec![self.event()];
        }
        vec![self.event()]
    }

    pub fn execute(
        &mut self,
        command: DesktopCommand,
        now: i64,
    ) -> Result<CommandAck, TransportError> {
        validate_command(&command).map_err(|message| {
            let error = TransportError::Protocol(message);
            self.last_error = Some(ui_error(&error));
            error
        })?;
        let (room, token) = self.credentials()?;
        let revision = self.revision.unwrap_or(0);
        self.command_retry_used = false;
        loop {
            match self.transport.command(
                &room,
                &token,
                self.generation,
                &command,
                self.revision.unwrap_or(revision),
            ) {
                Ok(ack) if ack.ok => {
                    self.revision = Some(ack.revision);
                    self.last_error = None;
                    return Ok(ack);
                }
                Ok(ack)
                    if ack
                        .error
                        .as_ref()
                        .is_some_and(|error| error.code == "REVISION_CONFLICT")
                        && !self.command_retry_used =>
                {
                    self.command_retry_used = true;
                    let fresh =
                        self.transport
                            .snapshot(&room, &token, self.generation, self.revision)?;
                    if let Some(snapshot) = fresh {
                        self.revision = Some(snapshot.revision);
                        self.snapshot = Some(snapshot);
                        continue;
                    }
                    self.last_error = ack.error.clone();
                    return Ok(ack);
                }
                Ok(ack) => {
                    self.last_error = ack.error.clone();
                    return Ok(ack);
                }
                Err(error) => {
                    self.handle_transport_error(&error, now);
                    return Err(error);
                }
            }
        }
    }

    pub fn handle_player_events(&mut self, now: i64) -> Vec<DesktopEvent> {
        let events = self.player.drain_events();
        let mut changed = false;
        for event in events {
            let event_generation = match event {
                PlayerEvent::Loaded { generation }
                | PlayerEvent::Ended { generation }
                | PlayerEvent::Error { generation, .. } => generation,
            };
            if event_generation != self.policy.generation {
                continue;
            }
            match event {
                PlayerEvent::Loaded { .. } => changed = true,
                PlayerEvent::Ended { .. } => {
                    if let Some(item) = self
                        .snapshot
                        .as_ref()
                        .and_then(|snapshot| snapshot.current_playlist_item_id.clone())
                    {
                        match self.execute(
                            DesktopCommand::PlaylistNext {
                                expected_current_playlist_item_id: Some(item),
                            },
                            now,
                        ) {
                            Ok(ack) if ack.ok => {
                                // ACK advances revision but does not include the new room state.
                                if self.refresh_snapshot(now).is_err() {
                                    changed = true;
                                }
                            }
                            Ok(_) => changed = true,
                            Err(_) => changed = true,
                        }
                    }
                }
                PlayerEvent::Error {
                    retryable: true, ..
                } => {
                    if let Some(source) = self.snapshot.as_ref().and_then(|s| s.source.clone()) {
                        if self.resolve_and_load(source, now, true).is_err() {
                            changed = true;
                        }
                    }
                }
                PlayerEvent::Error {
                    retryable: false, ..
                } => {
                    self.status = SessionStatus::Failed;
                    self.last_error = Some(UiError {
                        code: "PLAYBACK_FAILED".into(),
                        message: "原生播放器无法播放当前媒体".into(),
                    });
                    changed = true;
                }
            }
        }
        if changed {
            vec![self.event()]
        } else {
            Vec::new()
        }
    }

    pub fn refresh_snapshot(&mut self, now: i64) -> Result<bool, TransportError> {
        let (room, token) = self.credentials()?;
        match self
            .transport
            .snapshot(&room, &token, self.generation, None)?
        {
            Some(snapshot) => {
                self.revision = Some(snapshot.revision);
                self.apply_snapshot(snapshot, now)?;
                self.refresh_members()?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub fn refresh_members(&mut self) -> Result<bool, TransportError> {
        let (room, token) = self.credentials()?;
        self.members = self.transport.members(&room, &token, self.generation)?;
        Ok(true)
    }

    pub fn stop(&mut self) -> Result<(), TransportError> {
        let leave_result = if let (Some(room), Some(token)) = (&self.room_id, &self.token) {
            self.transport.leave(room, token, self.generation)
        } else {
            Ok(())
        };
        self.player.dispose();
        self.transport.clear_site_basic_auth();
        self.status = SessionStatus::Stopped;
        self.token = None;
        self.room_id = None;
        self.client_id = None;
        self.snapshot = None;
        self.members.clear();
        if let Err(error) = leave_result {
            self.status = SessionStatus::Failed;
            self.last_error = Some(ui_error(&error));
            return Err(error);
        }
        self.last_error = None;
        Ok(())
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }
    pub fn event(&self) -> DesktopEvent {
        DesktopEvent::State {
            state: DesktopUiState {
                connection: match self.status {
                    SessionStatus::Connecting => ConnectionState::Connecting,
                    SessionStatus::Backoff => ConnectionState::Backoff,
                    SessionStatus::Expired => ConnectionState::Expired,
                    SessionStatus::Failed => ConnectionState::Failed,
                    _ => ConnectionState::Ready,
                },
                room: self.snapshot.as_ref().map(SanitizedRoomSnapshot::from),
                members: self.members.clone(),
                player: self.player.state(),
                capability: self.capability.clone(),
                error: self.last_error.clone(),
            },
        }
    }

    fn credentials(&self) -> Result<(String, String), TransportError> {
        match (&self.room_id, &self.token) {
            (Some(room), Some(token)) => Ok((room.clone(), token.clone())),
            _ => Err(TransportError::Unauthorized),
        }
    }

    fn apply_snapshot(&mut self, snapshot: RoomSnapshot, now: i64) -> Result<(), TransportError> {
        let changed = self
            .snapshot
            .as_ref()
            .and_then(|current| current.source.as_ref())
            .map(MediaSource::key)
            != snapshot.source.as_ref().map(MediaSource::key);
        self.snapshot = Some(snapshot.clone());
        if changed {
            if let Some(source) = snapshot.source.clone() {
                self.policy.begin(self.generation);
                self.resolve_and_load(source, now, false)?;
            }
        } else {
            self.player.apply_shared_state(&snapshot);
        }
        Ok(())
    }

    fn resolve_and_load(
        &mut self,
        source: MediaSource,
        _now: i64,
        retry: bool,
    ) -> Result<(), TransportError> {
        let (room, token) = self.credentials()?;
        let resolved = self
            .transport
            .resolve(&room, &token, self.generation, &source)?;
        let action = if retry {
            self.policy.player_error(resolved.clone())
        } else {
            self.policy.resolved(resolved.clone())
        };
        match action {
            PlaybackAction::Load {
                url,
                user_agent,
                fallback,
            } => self
                .player
                .load(&url, &user_agent, fallback, self.generation),
            PlaybackAction::ResolveAgain => {
                let second = self
                    .transport
                    .resolve(&room, &token, self.generation, &source)?;
                if let PlaybackAction::Load {
                    url,
                    user_agent,
                    fallback,
                } = self.policy.resolved(second)
                {
                    self.player
                        .load(&url, &user_agent, fallback, self.generation);
                }
            }
            PlaybackAction::Fail => {
                self.status = SessionStatus::Failed;
                self.last_error = Some(UiError {
                    code: "MEDIA_RESOLVE_FAILED".into(),
                    message: "媒体解析失败，无法开始播放".into(),
                });
            }
        }
        Ok(())
    }

    fn handle_transport_error(&mut self, error: &TransportError, now: i64) {
        self.last_error = Some(ui_error(error));
        match error {
            TransportError::Unauthorized | TransportError::NotFound => {
                self.status = SessionStatus::Expired;
            }
            _ => {
                self.attempt = self.attempt.saturating_add(1);
                self.status = SessionStatus::Backoff;
                self.retry_at = now + (2_i64.pow(self.attempt.min(3))).min(16) * 1000;
            }
        }
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    code: Option<String>,
    message: Option<String>,
}

fn ui_error(error: &TransportError) -> UiError {
    match error {
        TransportError::Unauthorized => UiError {
            code: "ACCESS_TOKEN_INVALID".into(),
            message: "桌面凭据已失效，请重新连接".into(),
        },
        TransportError::NotFound => UiError {
            code: "ROOM_NOT_FOUND".into(),
            message: "房间不存在或已解散".into(),
        },
        TransportError::Network(_) => UiError {
            code: "NETWORK_BACKOFF".into(),
            message: "网络暂时不可用，正在重试".into(),
        },
        TransportError::Protocol(message) => UiError {
            code: "PROTOCOL_ERROR".into(),
            message: message.clone(),
        },
        TransportError::Http(_, body) => serde_json::from_str::<ErrorBody>(body)
            .ok()
            .and_then(|value| value.code.map(|code| (code, value.message)))
            .map(|(code, message)| UiError {
                code,
                message: message.unwrap_or_else(|| "桌面请求失败".into()),
            })
            .unwrap_or_else(|| UiError {
                code: "HTTP_ERROR".into(),
                message: "桌面请求失败".into(),
            }),
    }
}
