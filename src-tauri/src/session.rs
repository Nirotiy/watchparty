use crate::{
    clock::ClockSync,
    commands::validate_command,
    contracts::*,
    playback::{
        is_trusted_media_url, PlaybackAction, PlaybackLoad, PlaybackPolicy, PlayerControlError,
        PlayerEndReason, PlayerEngine, PlayerEvent,
    },
    transport::{RoomTransport, TransportError},
};
use serde::Deserialize;

const MEMBERS_REFRESH_INTERVAL_MS: i64 = 2_000;

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
    owner_token: Option<String>,
    client_id: Option<String>,
    generation: u64,
    load_generation: u64,
    revision: Option<u64>,
    snapshot: Option<RoomSnapshot>,
    members: Vec<RoomMember>,
    last_members_refresh_at: i64,
    policy: PlaybackPolicy,
    attempt: u32,
    retry_at: i64,
    command_retry_used: bool,
    clock: ClockSync,
    last_clock_sample_at: i64,
    locally_suspended: bool,
    capability: NativeCapabilityReport,
    last_error: Option<UiError>,
    /// Native-only persistence for owner token changes (claim/clear). The
    /// token itself never crosses this boundary, only the fact it changed.
    owner_token_persist: Option<Box<dyn Fn(Option<String>) + Send>>,
}

impl<T: RoomTransport, P: PlayerEngine> DesktopSession<T, P> {
    pub fn new(transport: T, player: P) -> Self {
        let capability = player.capability();
        Self {
            transport,
            player,
            status: SessionStatus::New,
            room_id: None,
            token: None,
            owner_token: None,
            client_id: None,
            generation: 0,
            load_generation: 0,
            revision: None,
            snapshot: None,
            members: Vec::new(),
            last_members_refresh_at: i64::MIN,
            policy: PlaybackPolicy::new(),
            attempt: 0,
            retry_at: 0,
            command_retry_used: false,
            clock: ClockSync::default(),
            last_clock_sample_at: i64::MIN,
            locally_suspended: false,
            capability,
            last_error: None,
            owner_token_persist: None,
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
        if handoff.generation == 0 {
            let error = TransportError::Protocol("missing desktop session generation".into());
            self.handle_transport_error(&error, now);
            return Err(error);
        }
        self.room_id = Some(handoff.room_id);
        self.token = Some(handoff.access_token);
        self.owner_token = handoff.owner_token;
        self.client_id = Some(handoff.client_id);
        self.generation = handoff.generation;
        self.revision = None;
        self.snapshot = None;
        self.members = handoff.members;
        self.status = SessionStatus::Ready;
        self.attempt = 0;
        self.retry_at = now;

        let mut initial_snapshot = handoff.snapshot;
        if self.transport.supports_clock_sync() {
            let (room, token) = self.credentials()?;
            for _ in 0..3 {
                let response = match self
                    .transport
                    .snapshot(&room, &token, self.generation, None)
                {
                    Ok(value) => value,
                    Err(error) => {
                        self.handle_transport_error(&error, now);
                        return Err(error);
                    }
                };
                if let Some(snapshot) = response.snapshot.as_ref() {
                    self.update_clock(snapshot, response.timing, now);
                }
                if let Some(snapshot) = response.snapshot {
                    initial_snapshot = snapshot;
                }
            }
        }
        if let Err(error) = self.refresh_members() {
            self.handle_transport_error(&error, now);
            return Err(error);
        }
        self.last_members_refresh_at = now;
        if let Err(error) = self.apply_snapshot(initial_snapshot, now) {
            self.handle_transport_error(&error, now);
            return Err(error);
        }
        Ok(vec![self.event()])
    }

    /// Restores a persisted desktop identity. The server claims a fresh
    /// generation so delayed requests from the previous process are stale.
    pub fn start_persisted(
        &mut self,
        room_id: String,
        client_id: String,
        token: String,
        owner_token: Option<String>,
        now: i64,
    ) -> Result<Vec<DesktopEvent>, TransportError> {
        self.status = SessionStatus::Connecting;
        self.last_error = None;
        let generation = match self.transport.claim_session(&room_id, &token) {
            Ok(value) => value,
            Err(error) => {
                self.handle_transport_error(&error, now);
                return Err(error);
            }
        };
        let response = match self.transport.snapshot(&room_id, &token, generation, None) {
            Ok(value) => value,
            Err(error) => {
                self.handle_transport_error(&error, now);
                return Err(error);
            }
        };
        let snapshot = response
            .snapshot
            .ok_or_else(|| TransportError::Protocol("room snapshot is unavailable".into()))?;
        self.room_id = Some(room_id);
        self.client_id = Some(client_id);
        self.token = Some(token);
        self.owner_token = owner_token;
        self.generation = generation;
        self.revision = None;
        self.snapshot = None;
        self.members.clear();
        self.status = SessionStatus::Ready;
        self.attempt = 0;
        self.retry_at = now;
        self.update_clock(&snapshot, response.timing, now);
        self.refresh_members().map_err(|error| {
            self.handle_transport_error(&error, now);
            error
        })?;
        self.last_members_refresh_at = now;
        self.apply_snapshot(snapshot, now).map_err(|error| {
            self.handle_transport_error(&error, now);
            error
        })?;
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
        let force_clock_sample = self.clock.sample_count() < 3
            || now.saturating_sub(self.last_clock_sample_at) >= 30_000;
        let response = match self.transport.snapshot(
            &room,
            &token,
            self.generation,
            if force_clock_sample {
                None
            } else {
                self.revision
            },
        ) {
            Ok(response) => response,
            Err(error) => {
                self.handle_transport_error(&error, now);
                return vec![self.event()];
            }
        };
        self.attempt = 0;
        self.status = SessionStatus::Ready;
        self.last_error = None;
        if let Some(snapshot) = response.snapshot {
            self.update_clock(&snapshot, response.timing, now);
            self.revision = Some(snapshot.revision);
            if let Err(error) = self.apply_snapshot(snapshot, now) {
                self.handle_transport_error(&error, now);
                return vec![self.event()];
            }
        }
        self.sync_ownership(&room, &token);
        if now.saturating_sub(self.last_members_refresh_at) >= MEMBERS_REFRESH_INTERVAL_MS {
            if let Err(error) = self.refresh_members() {
                self.handle_transport_error(&error, now);
                return vec![self.event()];
            }
            self.last_members_refresh_at = now;
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
        match &command {
            DesktopCommand::Resync => {
                let snapshot = self.snapshot.as_ref().ok_or_else(|| {
                    TransportError::Protocol("room snapshot is unavailable".into())
                })?;
                if self.locally_suspended || !self.player.state().loaded {
                    return Err(TransportError::Protocol(
                        "local player is not ready for resync".into(),
                    ));
                }
                let target = crate::playback::authoritative_position(
                    snapshot,
                    self.clock.estimate_server_time(now),
                );
                self.player
                    .seek_local_absolute(target)
                    .map_err(|error| player_control_error(error, "resync"))?;
                return Ok(self.local_command_ack());
            }
            DesktopCommand::Volume { volume } => {
                self.player.set_volume(*volume);
                return Ok(self.local_command_ack());
            }
            DesktopCommand::SelectAudioTrack { track_id } => {
                self.player
                    .select_audio_track(*track_id)
                    .map_err(|error| player_control_error(error, "audio track"))?;
                return Ok(self.local_command_ack());
            }
            DesktopCommand::SelectSubtitleTrack { track_id } => {
                self.player
                    .select_subtitle_track(*track_id)
                    .map_err(|error| player_control_error(error, "subtitle track"))?;
                return Ok(self.local_command_ack());
            }
            DesktopCommand::PlayerVisibility { .. } | DesktopCommand::Fullscreen { .. } => {
                return Err(TransportError::Protocol(
                    "window command reached the room session".into(),
                ));
            }
            _ => {}
        }
        // Owner-gated commands stay local when this client is not the room
        // owner; the owner token only rides on commands that require it.
        let owner_token: Option<String> = match &command {
            DesktopCommand::Lock { .. } | DesktopCommand::TransferOwner { .. } => {
                let is_owner = self.owner_token.is_some()
                    && self.snapshot.as_ref().is_some_and(|snapshot| {
                        self.client_id.as_deref() == Some(snapshot.owner_client_id.as_str())
                    });
                if !is_owner {
                    return Ok(rejected_owner_ack());
                }
                self.owner_token.clone()
            }
            _ => None,
        };
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
                owner_token.as_deref(),
            ) {
                Ok(ack) if ack.ok => {
                    self.last_error = None;
                    if let Err(error) = self.refresh_snapshot(now) {
                        self.handle_transport_error(&error, now);
                    }
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
                    if let Some(snapshot) = fresh.snapshot {
                        self.update_clock(&snapshot, fresh.timing, now);
                        self.revision = Some(snapshot.revision);
                        self.apply_snapshot(snapshot, now)?;
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

    /// Installs a native-only persistence hook invoked when the owner token is
    /// claimed or dropped. The token value crosses only inside the Rust process.
    pub fn with_owner_token_persist(mut self, persist: Box<dyn Fn(Option<String>) + Send>) -> Self {
        self.owner_token_persist = Some(persist);
        self
    }

    /// Keeps the owner token aligned with the authoritative snapshot: claims a
    /// queued grant after an incoming transfer and drops the token as soon as
    /// ownership moves away. Best effort; the server remains authoritative.
    fn sync_ownership(&mut self, room: &str, token: &str) {
        let owned = match (self.client_id.as_deref(), self.snapshot.as_ref()) {
            (Some(client_id), Some(snapshot)) => client_id == snapshot.owner_client_id,
            _ => return,
        };
        if owned && self.owner_token.is_none() {
            match self
                .transport
                .claim_owner_grant(room, token, self.generation)
            {
                Ok(Some(granted)) => {
                    self.owner_token = Some(granted.clone());
                    if let Some(persist) = &self.owner_token_persist {
                        persist(Some(granted));
                    }
                }
                Ok(None) | Err(_) => {}
            }
        } else if !owned && self.owner_token.is_some() {
            self.owner_token = None;
            if let Some(persist) = &self.owner_token_persist {
                persist(None);
            }
        }
    }

    pub fn handle_player_events(&mut self, now: i64) -> Vec<DesktopEvent> {
        let events = self.player.drain_events();
        self.capability = self.player.capability();
        let mut changed = false;
        for event in events {
            let event_generation = match event {
                PlayerEvent::Loaded { generation }
                | PlayerEvent::Ended { generation, .. }
                | PlayerEvent::Error { generation, .. } => generation,
            };
            if event_generation != self.load_generation {
                continue;
            }
            match event {
                PlayerEvent::Loaded { .. } => {
                    if let Err(error) = self.apply_authoritative_player_state(now) {
                        self.status = SessionStatus::Failed;
                        self.last_error = Some(ui_error(&error));
                    }
                    changed = true;
                }
                PlayerEvent::Ended {
                    reason: PlayerEndReason::Eof,
                    playlist_item_id: Some(ended_item),
                    ..
                } => {
                    let current_item = self
                        .snapshot
                        .as_ref()
                        .and_then(|snapshot| snapshot.current_playlist_item_id.as_ref());
                    if current_item == Some(&ended_item) {
                        match self.execute(
                            DesktopCommand::PlaylistNext {
                                expected_current_playlist_item_id: Some(ended_item),
                            },
                            now,
                        ) {
                            Ok(ack) if ack.ok => {
                                changed = true;
                            }
                            Ok(_) => changed = true,
                            Err(_) => changed = true,
                        }
                    }
                }
                PlayerEvent::Ended { .. } => {}
                PlayerEvent::Error {
                    retryable: true, ..
                } => {
                    if let Some(source) = self.snapshot.as_ref().and_then(|s| s.source.clone()) {
                        match self.retry_or_fallback(source) {
                            Ok(()) => changed = true,
                            Err(error) => {
                                self.handle_transport_error(&error, now);
                                changed = true;
                            }
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
        let response = self
            .transport
            .snapshot(&room, &token, self.generation, None)?;
        match response.snapshot {
            Some(snapshot) => {
                self.update_clock(&snapshot, response.timing, now);
                self.revision = Some(snapshot.revision);
                self.apply_snapshot(snapshot, now)?;
                self.refresh_members()?;
                self.last_members_refresh_at = now;
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
        self.owner_token = None;
        self.room_id = None;
        self.client_id = None;
        self.snapshot = None;
        self.locally_suspended = false;
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
    pub fn room_id(&self) -> Option<&str> {
        self.room_id.as_deref()
    }
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }

    /// Pauses only the local decoder while its window is hidden. Resuming reapplies
    /// the latest authoritative room snapshot so the player catches up immediately.
    pub fn set_local_suspended(
        &mut self,
        suspended: bool,
        now: i64,
    ) -> Result<Vec<DesktopEvent>, TransportError> {
        self.locally_suspended = suspended;
        if suspended {
            self.player
                .set_local_paused(true)
                .map_err(|error| player_control_error(error, "local pause"))?;
        } else {
            self.apply_authoritative_player_state(now)?;
        }
        self.capability = self.player.capability();
        self.last_error = None;
        Ok(vec![self.event()])
    }

    pub fn event(&self) -> DesktopEvent {
        let player = self.player.state();
        let is_owner = self.snapshot.as_ref().is_some_and(|snapshot| {
            self.client_id.as_deref() == Some(snapshot.owner_client_id.as_str())
        });
        DesktopEvent::State {
            state: DesktopUiState {
                connection: match self.status {
                    SessionStatus::Connecting => ConnectionState::Connecting,
                    SessionStatus::Backoff => ConnectionState::Backoff,
                    SessionStatus::Expired => ConnectionState::Expired,
                    SessionStatus::Failed => ConnectionState::Failed,
                    _ => ConnectionState::Ready,
                },
                room_id: self.room_id.clone(),
                room: self.snapshot.clone(),
                members: self.members.clone(),
                can_control_shared_playback: self
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| !snapshot.locked || is_owner),
                is_owner,
                client_id: self.client_id.clone(),
                player_window_visible: player.loaded && !self.locally_suspended,
                player,
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
        self.revision = Some(snapshot.revision);
        let changed = self.snapshot.as_ref().map(|current| {
            (
                current.source.as_ref().map(MediaSource::key),
                current.current_playlist_item_id.as_deref(),
            )
        }) != Some((
            snapshot.source.as_ref().map(MediaSource::key),
            snapshot.current_playlist_item_id.as_deref(),
        ));
        self.snapshot = Some(snapshot.clone());
        if changed {
            if let Some(source) = snapshot.source.clone() {
                self.load_generation = self.load_generation.saturating_add(1);
                self.policy.begin(self.load_generation);
                self.resolve_and_load(source)?;
            }
        } else {
            self.apply_authoritative_player_state(now)?;
        }
        Ok(())
    }

    fn apply_authoritative_player_state(&mut self, now: i64) -> Result<(), TransportError> {
        if let Some(snapshot) = self.snapshot.as_ref() {
            if self.locally_suspended {
                self.player
                    .set_local_paused(true)
                    .map_err(|error| player_control_error(error, "local pause"))?;
            } else {
                self.player
                    .apply_shared_state(snapshot, self.clock.estimate_server_time(now));
            }
        }
        Ok(())
    }

    fn local_command_ack(&mut self) -> CommandAck {
        self.capability = self.player.capability();
        self.last_error = None;
        CommandAck {
            ok: true,
            revision: self.revision.unwrap_or(0),
            error: None,
        }
    }

    fn resolve_and_load(&mut self, source: MediaSource) -> Result<(), TransportError> {
        let (room, token) = self.credentials()?;
        let resolved = self
            .transport
            .resolve(&room, &token, self.generation, &source)?;
        let action = self.policy.resolved(&resolved);
        self.apply_playback_action(action);
        Ok(())
    }

    fn retry_or_fallback(&mut self, source: MediaSource) -> Result<(), TransportError> {
        let action = self.policy.player_error();
        let action = if action == PlaybackAction::ResolveAgain {
            let (room, token) = self.credentials()?;
            let resolved = self
                .transport
                .resolve(&room, &token, self.generation, &source)?;
            self.policy.resolved_retry(&resolved)
        } else {
            action
        };
        self.apply_playback_action(action);
        Ok(())
    }

    fn apply_playback_action(&mut self, action: PlaybackAction) {
        match action {
            PlaybackAction::Load {
                url,
                user_agent,
                fallback,
            } => {
                // Untrusted resolve targets never reach the player (spec 10.5).
                if !is_trusted_media_url(&url) {
                    self.status = SessionStatus::Failed;
                    self.last_error = Some(UiError {
                        code: "MEDIA_RESOLVE_FAILED".into(),
                        message: "媒体解析失败，无法开始播放".into(),
                    });
                    return;
                }
                // Site credentials may only ride on same-origin fallback requests.
                let basic_auth = if fallback {
                    self.transport.site_basic_auth_for(&url)
                } else {
                    None
                };
                let playlist_item_id = self
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.current_playlist_item_id.as_deref());
                self.player.load(PlaybackLoad {
                    url: &url,
                    user_agent: &user_agent,
                    fallback,
                    generation: self.load_generation,
                    playlist_item_id,
                    basic_auth,
                });
            }
            PlaybackAction::ResolveAgain => {}
            PlaybackAction::Fail => {
                self.status = SessionStatus::Failed;
                self.last_error = Some(UiError {
                    code: "MEDIA_RESOLVE_FAILED".into(),
                    message: "媒体解析失败，无法开始播放".into(),
                });
            }
        }
    }

    fn update_clock(
        &mut self,
        snapshot: &RoomSnapshot,
        timing: Option<crate::transport::RequestTiming>,
        now: i64,
    ) {
        if let Some(timing) = timing {
            if self
                .clock
                .update(snapshot.server_time_ms, timing.sent_ms, timing.received_ms)
            {
                self.last_clock_sample_at = now;
            }
        }
    }

    fn handle_transport_error(&mut self, error: &TransportError, now: i64) {
        self.last_error = Some(ui_error(error));
        match error {
            TransportError::Unauthorized | TransportError::NotFound => {
                self.status = SessionStatus::Expired;
            }
            TransportError::Http(status, body)
                if *status == 426
                    || (*status == 409 && body.contains("SESSION_GENERATION_STALE")) =>
            {
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

/// Local rejection for owner commands issued without ownership. The server
/// would reject them anyway; refusing locally avoids exposing the owner token.
fn rejected_owner_ack() -> CommandAck {
    CommandAck {
        ok: false,
        revision: 0,
        error: Some(UiError {
            code: "FORBIDDEN".into(),
            message: "只有房主可以执行此操作".into(),
        }),
    }
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

fn player_control_error(error: PlayerControlError, control: &str) -> TransportError {
    let reason = match error {
        PlayerControlError::Unsupported => "is unsupported",
        PlayerControlError::Rejected => "was rejected",
    };
    TransportError::Protocol(format!("local player {control} {reason}"))
}
