use crate::{
    config::{validate_backend_origin, StoredSiteCredentials},
    contracts::{
        CommandAck, ConnectionState, DesktopCommand, DesktopEvent, DesktopUiState,
        NativeCapabilityReport, PlayerState, UiError,
    },
    http::DesktopHttpTransport,
    libmpv::{LibMpvConfig, LibMpvPlayer},
    playback::PlayerEngine,
    session::DesktopSession,
    transport::{RoomTransport, TransportError},
};
use serde::Serialize;
use std::{
    fmt,
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender},
        Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroize;

/// Retire the old worker before clearing renderer state or publishing its replacement.
pub(crate) fn replace_runtime_slot(
    slot: &Mutex<Option<std::sync::Arc<DesktopRuntime>>>,
    replacement: Option<DesktopRuntime>,
    clear_renderer: impl FnOnce(),
) {
    let old = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(old) = old {
        old.shutdown();
    }
    clear_renderer();
    *slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = replacement.map(std::sync::Arc::new);
}

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const PLAYER_EVENT_INTERVAL: Duration = Duration::from_millis(50);
const MAX_HANDOFF_TICKET_BYTES: usize = 4096;

/// Native-only site credentials. This type is deliberately neither serializable nor debuggable.
pub struct NativeSiteCredentials {
    username: String,
    password: String,
}

impl NativeSiteCredentials {
    pub fn from_stored(credentials: StoredSiteCredentials) -> Result<Self, RuntimeError> {
        let (username, password) = credentials.into_parts();
        Self::new(username, password)
    }

    pub fn new(username: String, password: String) -> Result<Self, RuntimeError> {
        if username.is_empty() || password.is_empty() {
            return Err(RuntimeError::configuration_error());
        }
        Ok(Self { username, password })
    }
}

impl Drop for NativeSiteCredentials {
    fn drop(&mut self) {
        self.username.zeroize();
        self.password.zeroize();
    }
}

/// Native runtime configuration. It can only be loaded by Rust and never crosses IPC.
pub struct NativeRuntimeConfig {
    backend_origin: String,
    site_credentials: Option<NativeSiteCredentials>,
    player: Option<LibMpvConfig>,
}

impl NativeRuntimeConfig {
    pub fn new(
        backend_origin: String,
        site_credentials: Option<NativeSiteCredentials>,
    ) -> Result<Self, RuntimeError> {
        let backend_origin = validate_backend_origin(&backend_origin)
            .map_err(|_| RuntimeError::configuration_error())?;
        Ok(Self {
            backend_origin,
            site_credentials,
            player: None,
        })
    }

    pub fn with_player(
        backend_origin: String,
        site_credentials: Option<NativeSiteCredentials>,
        player: LibMpvConfig,
    ) -> Result<Self, RuntimeError> {
        let mut config = Self::new(backend_origin, site_credentials)?;
        config.player = Some(player);
        Ok(config)
    }

    fn create_session(&self) -> Result<Box<dyn ManagedSession>, RuntimeError> {
        let transport = match &self.site_credentials {
            Some(credentials) => DesktopHttpTransport::with_site_basic_auth(
                self.backend_origin.clone(),
                credentials.username.clone(),
                credentials.password.clone(),
            ),
            None => DesktopHttpTransport::new(self.backend_origin.clone()),
        }
        .map_err(|error| RuntimeError::from_transport(&error))?;

        let player = self
            .player
            .as_ref()
            .ok_or_else(RuntimeError::player_unavailable)
            .and_then(|config| {
                LibMpvPlayer::open(config).map_err(|_| RuntimeError::player_unavailable())
            })?;

        Ok(Box::new(DesktopSession::new(transport, player)))
    }
}

/// Safe error returned over Tauri IPC. Transport bodies and native secrets are never included.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    pub code: &'static str,
    pub message: &'static str,
}

impl RuntimeError {
    pub(crate) fn credential_error() -> Self {
        Self {
            code: "DESKTOP_CREDENTIAL_UNAVAILABLE",
            message: "无法访问系统凭据库，请稍后重试",
        }
    }

    pub(crate) fn not_configured() -> Self {
        Self {
            code: "DESKTOP_SITE_NOT_CONFIGURED",
            message: "请先在设置中配置 WatchParty 站点",
        }
    }

    pub(crate) fn configuration_error() -> Self {
        Self {
            code: "DESKTOP_CONFIGURATION_INVALID",
            message: "桌面端网络配置无效",
        }
    }

    fn invalid_ticket() -> Self {
        Self {
            code: "DESKTOP_TICKET_INVALID",
            message: "桌面启动票据无效",
        }
    }

    fn not_started() -> Self {
        Self {
            code: "DESKTOP_SESSION_NOT_STARTED",
            message: "桌面会话尚未启动",
        }
    }

    fn room_mismatch() -> Self {
        Self {
            code: "DESKTOP_ROOM_MISMATCH",
            message: "深链房间与实际加入的房间不一致",
        }
    }

    fn stopped() -> Self {
        Self {
            code: "DESKTOP_RUNTIME_STOPPED",
            message: "桌面运行时已停止",
        }
    }

    fn worker_failed() -> Self {
        Self {
            code: "DESKTOP_RUNTIME_FAILED",
            message: "桌面运行时不可用",
        }
    }

    fn player_unavailable() -> Self {
        Self {
            code: "LIBMPV_UNAVAILABLE",
            message: "原生播放器运行时不可用",
        }
    }

    pub(crate) fn runtime_unavailable() -> Self {
        Self::worker_failed()
    }

    pub(crate) fn invalid_command() -> Self {
        Self {
            code: "DESKTOP_COMMAND_INVALID",
            message: "桌面命令参数无效",
        }
    }

    #[cfg(test)]
    pub(crate) fn from_untrusted_transport_for_test(body: &str) -> Self {
        Self::from_transport(&TransportError::Http(500, body.into()))
    }

    fn from_transport(error: &TransportError) -> Self {
        match error {
            TransportError::Unauthorized => Self {
                code: "SESSION_EXPIRED",
                message: "桌面会话已过期，请从网页重新启动",
            },
            TransportError::NotFound => Self {
                code: "ROOM_NOT_FOUND",
                message: "房间不存在或已解散",
            },
            TransportError::Network(_) => Self {
                code: "NETWORK_ERROR",
                message: "网络暂时不可用",
            },
            TransportError::Protocol(_) | TransportError::Http(_, _) => Self {
                code: "DESKTOP_REQUEST_FAILED",
                message: "桌面请求失败",
            },
        }
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for RuntimeError {}

trait ManagedSession: Send {
    fn start(&mut self, ticket: &str, now_ms: i64) -> Result<Vec<DesktopEvent>, TransportError>;
    /// The room this session actually joined once started; `None` before that.
    fn room_id(&self) -> Option<&str> {
        None
    }
    fn poll(&mut self, now_ms: i64) -> Vec<DesktopEvent>;
    fn execute(
        &mut self,
        command: DesktopCommand,
        now_ms: i64,
    ) -> Result<CommandAck, TransportError>;
    fn handle_player_events(&mut self, now_ms: i64) -> Vec<DesktopEvent>;
    fn set_local_suspended(
        &mut self,
        suspended: bool,
        now_ms: i64,
    ) -> Result<Vec<DesktopEvent>, TransportError>;
    fn stop(&mut self) -> Result<(), TransportError>;
    fn event(&self) -> DesktopEvent;
}

impl<T, P> ManagedSession for DesktopSession<T, P>
where
    T: RoomTransport + Send + 'static,
    P: PlayerEngine + Send + 'static,
{
    fn start(&mut self, ticket: &str, now_ms: i64) -> Result<Vec<DesktopEvent>, TransportError> {
        DesktopSession::start(self, ticket, now_ms)
    }

    fn room_id(&self) -> Option<&str> {
        DesktopSession::room_id(self)
    }

    fn poll(&mut self, now_ms: i64) -> Vec<DesktopEvent> {
        DesktopSession::poll(self, now_ms)
    }

    fn execute(
        &mut self,
        command: DesktopCommand,
        now_ms: i64,
    ) -> Result<CommandAck, TransportError> {
        DesktopSession::execute(self, command, now_ms)
    }

    fn handle_player_events(&mut self, now_ms: i64) -> Vec<DesktopEvent> {
        DesktopSession::handle_player_events(self, now_ms)
    }

    fn set_local_suspended(
        &mut self,
        suspended: bool,
        now_ms: i64,
    ) -> Result<Vec<DesktopEvent>, TransportError> {
        DesktopSession::set_local_suspended(self, suspended, now_ms)
    }

    fn stop(&mut self) -> Result<(), TransportError> {
        DesktopSession::stop(self)
    }

    fn event(&self) -> DesktopEvent {
        DesktopSession::event(self)
    }
}

type SessionFactory = Box<dyn FnMut() -> Result<Box<dyn ManagedSession>, RuntimeError> + Send>;
type EventSink = Box<dyn Fn(DesktopEvent) + Send>;

enum RuntimeRequest {
    Start {
        ticket: String,
        expected_room_id: Option<String>,
        reply: SyncSender<Result<(), RuntimeError>>,
    },
    Execute {
        command: DesktopCommand,
        reply: SyncSender<Result<CommandAck, RuntimeError>>,
    },
    SetLocalSuspended {
        suspended: bool,
        reply: SyncSender<Result<(), RuntimeError>>,
    },
    Stop {
        reply: SyncSender<Result<(), RuntimeError>>,
    },
    Shutdown,
}

struct RuntimeControl {
    sender: Option<Sender<RuntimeRequest>>,
    worker: Option<JoinHandle<()>>,
}

/// Owns the single native session worker. All blocking network/player work stays on that thread.
pub struct DesktopRuntime {
    control: Mutex<RuntimeControl>,
}

impl DesktopRuntime {
    pub fn spawn<E>(config: NativeRuntimeConfig, event_sink: E) -> Result<Self, RuntimeError>
    where
        E: Fn(DesktopEvent) + Send + 'static,
    {
        Self::spawn_inner(
            Box::new(move || config.create_session()),
            Box::new(event_sink),
            DEFAULT_POLL_INTERVAL,
        )
    }

    fn spawn_inner(
        factory: SessionFactory,
        event_sink: EventSink,
        poll_interval: Duration,
    ) -> Result<Self, RuntimeError> {
        let (sender, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("watchparty-desktop-session".into())
            .spawn(move || run_worker(receiver, factory, event_sink, poll_interval))
            .map_err(|_| RuntimeError::worker_failed())?;
        Ok(Self {
            control: Mutex::new(RuntimeControl {
                sender: Some(sender),
                worker: Some(worker),
            }),
        })
    }

    /// Joins a room with a one-time handoff ticket.
    ///
    /// Two libmpv instances cannot share the window surface, so the previous
    /// session is retired first; the renderer immediately receives a cleared
    /// "connecting" state so a stale room is never shown while the new ticket
    /// is validated, and a failed join surfaces as an explicit failed state.
    /// Session events are only emitted after `start` has fully succeeded.
    /// When `expected_room_id` is provided (deep-link hint), a session that
    /// joined a different room is rejected and torn down.
    pub fn start(
        &self,
        ticket: String,
        expected_room_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        if ticket.is_empty() || ticket.len() > MAX_HANDOFF_TICKET_BYTES {
            return Err(RuntimeError::invalid_ticket());
        }
        let (reply, response) = mpsc::sync_channel(1);
        self.sender()?
            .send(RuntimeRequest::Start {
                ticket,
                expected_room_id,
                reply,
            })
            .map_err(|_| RuntimeError::stopped())?;
        response.recv().map_err(|_| RuntimeError::worker_failed())?
    }

    pub fn execute(&self, command: DesktopCommand) -> Result<CommandAck, RuntimeError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender()?
            .send(RuntimeRequest::Execute { command, reply })
            .map_err(|_| RuntimeError::stopped())?;
        response.recv().map_err(|_| RuntimeError::worker_failed())?
    }

    pub fn set_local_suspended(&self, suspended: bool) -> Result<(), RuntimeError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender()?
            .send(RuntimeRequest::SetLocalSuspended { suspended, reply })
            .map_err(|_| RuntimeError::stopped())?;
        response.recv().map_err(|_| RuntimeError::worker_failed())?
    }

    pub fn stop_session(&self) -> Result<(), RuntimeError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.sender()?
            .send(RuntimeRequest::Stop { reply })
            .map_err(|_| RuntimeError::stopped())?;
        response.recv().map_err(|_| RuntimeError::worker_failed())?
    }

    /// Stops polling, leaves the room, disposes the player, and joins the worker.
    /// Call this from a blocking executor, never from the Tauri main thread.
    pub fn shutdown(&self) {
        let (sender, worker) = {
            let mut control = self
                .control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (control.sender.take(), control.worker.take())
        };
        if let Some(sender) = sender {
            let _ = sender.send(RuntimeRequest::Shutdown);
        }
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    fn sender(&self) -> Result<Sender<RuntimeRequest>, RuntimeError> {
        self.control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sender
            .clone()
            .ok_or_else(RuntimeError::stopped)
    }
}

impl Drop for DesktopRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_worker(
    receiver: Receiver<RuntimeRequest>,
    mut factory: SessionFactory,
    event_sink: EventSink,
    poll_interval: Duration,
) {
    let mut active: Option<Box<dyn ManagedSession>> = None;
    let wake_interval = poll_interval.min(PLAYER_EVENT_INTERVAL);
    let mut next_network_poll = Instant::now() + poll_interval;
    loop {
        match receiver.recv_timeout(wake_interval) {
            Ok(RuntimeRequest::Start {
                ticket,
                expected_room_id,
                reply,
            }) => {
                // Retire the previous session before creating the new player
                // (two libmpv instances cannot share the HWND), then push a
                // cleared connecting state so the UI never keeps showing the
                // old room while the new ticket is validated.
                stop_active(&mut active);
                emit_all(&event_sink, vec![cleared_connecting_event()]);
                let result = match factory() {
                    Ok(mut session) => match session.start(&ticket, unix_time_ms()) {
                        Ok(events) => {
                            if let Some(expected) = expected_room_id.as_deref() {
                                if session.room_id() != Some(expected) {
                                    let _ = session.stop();
                                    emit_all(&event_sink, vec![room_mismatch_event()]);
                                    Err(RuntimeError::room_mismatch())
                                } else {
                                    active = Some(session);
                                    emit_all(&event_sink, events);
                                    next_network_poll = Instant::now() + poll_interval;
                                    Ok(())
                                }
                            } else {
                                active = Some(session);
                                emit_all(&event_sink, events);
                                next_network_poll = Instant::now() + poll_interval;
                                Ok(())
                            }
                        }
                        Err(error) => {
                            // Surface the failure instead of leaving the stale
                            // pre-start state on screen.
                            emit_all(&event_sink, vec![session.event()]);
                            let _ = session.stop();
                            Err(RuntimeError::from_transport(&error))
                        }
                    },
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }
            Ok(RuntimeRequest::Execute { command, reply }) => {
                let result = match active.as_mut() {
                    Some(session) => {
                        let result = session
                            .execute(command, unix_time_ms())
                            .map(sanitize_command_ack)
                            .map_err(|error| RuntimeError::from_transport(&error));
                        emit_all(&event_sink, vec![session.event()]);
                        result
                    }
                    None => Err(RuntimeError::not_started()),
                };
                let _ = reply.send(result);
            }
            Ok(RuntimeRequest::SetLocalSuspended { suspended, reply }) => {
                let result = match active.as_mut() {
                    Some(session) => session
                        .set_local_suspended(suspended, unix_time_ms())
                        .map(|events| emit_all(&event_sink, events))
                        .map_err(|error| RuntimeError::from_transport(&error)),
                    None => Err(RuntimeError::not_started()),
                };
                let _ = reply.send(result);
            }
            Ok(RuntimeRequest::Stop { reply }) => {
                let result = active
                    .take()
                    .map(|mut session| {
                        session
                            .stop()
                            .map_err(|error| RuntimeError::from_transport(&error))
                    })
                    .unwrap_or(Ok(()));
                let _ = reply.send(result);
            }
            Ok(RuntimeRequest::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                stop_active(&mut active);
                break;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(session) = active.as_mut() {
                    let now_ms = unix_time_ms();
                    emit_all(&event_sink, session.handle_player_events(now_ms));
                    if Instant::now() >= next_network_poll {
                        emit_all(&event_sink, session.poll(now_ms));
                        next_network_poll = Instant::now() + poll_interval;
                    }
                }
            }
        }
    }
}

fn stop_active(active: &mut Option<Box<dyn ManagedSession>>) {
    if let Some(mut session) = active.take() {
        let _ = session.stop();
    }
}

/// Wipes any previous room from the renderer while a new session is validated.
fn cleared_connecting_event() -> DesktopEvent {
    DesktopEvent::State {
        state: DesktopUiState {
            connection: ConnectionState::Connecting,
            room_id: None,
            room: None,
            members: Vec::new(),
            can_control_shared_playback: false,
            is_owner: false,
            player: PlayerState::default(),
            player_window_visible: false,
            capability: NativeCapabilityReport::default(),
            error: None,
        },
    }
}

/// Terminal state for a session that joined a room other than the deep-linked one.
fn room_mismatch_event() -> DesktopEvent {
    DesktopEvent::State {
        state: DesktopUiState {
            connection: ConnectionState::Failed,
            room_id: None,
            room: None,
            members: Vec::new(),
            can_control_shared_playback: false,
            is_owner: false,
            player: PlayerState::default(),
            player_window_visible: false,
            capability: NativeCapabilityReport::default(),
            error: Some(UiError {
                code: "DESKTOP_ROOM_MISMATCH".into(),
                message: "深链房间与实际加入的房间不一致".into(),
            }),
        },
    }
}

fn emit_all(event_sink: &EventSink, events: Vec<DesktopEvent>) {
    for event in events {
        event_sink(sanitize_event(event));
    }
}

fn sanitize_event(event: DesktopEvent) -> DesktopEvent {
    match event {
        DesktopEvent::State { mut state } => {
            state.error = state.error.map(sanitize_ui_error);
            DesktopEvent::State { state }
        }
    }
}

fn sanitize_ui_error(error: UiError) -> UiError {
    let (code, message) = match error.code.as_str() {
        "SESSION_EXPIRED" => ("SESSION_EXPIRED", "桌面会话已过期，请从网页重新启动"),
        "ROOM_NOT_FOUND" => ("ROOM_NOT_FOUND", "房间不存在或已解散"),
        "NETWORK_BACKOFF" => ("NETWORK_BACKOFF", "网络暂时不可用，正在重试"),
        "PLAYBACK_FAILED" => ("PLAYBACK_FAILED", "原生播放器无法播放当前媒体"),
        "DESKTOP_ROOM_MISMATCH" => ("DESKTOP_ROOM_MISMATCH", "深链房间与实际加入的房间不一致"),
        _ => ("DESKTOP_SESSION_ERROR", "桌面会话发生错误"),
    };
    UiError {
        code: code.into(),
        message: message.into(),
    }
}

fn sanitize_command_ack(mut ack: CommandAck) -> CommandAck {
    ack.error = ack.error.map(|error| {
        let (code, message) = match error.code.as_str() {
            "INVALID_REQUEST" => ("INVALID_REQUEST", "命令参数无效"),
            "FORBIDDEN" => ("FORBIDDEN", "当前操作不允许"),
            "MEDIA_NOT_FOUND" => ("MEDIA_NOT_FOUND", "媒体不存在"),
            "MEDIA_UNSUPPORTED" => ("MEDIA_UNSUPPORTED", "当前媒体不受支持"),
            "PLAYLIST_FULL" => ("PLAYLIST_FULL", "播放清单已满"),
            "REVISION_CONFLICT" => ("REVISION_CONFLICT", "房间状态已更新，请重试"),
            "SESSION_GENERATION_STALE" => (
                "SESSION_GENERATION_STALE",
                "桌面会话已被新的连接替换，请重新启动",
            ),
            _ => ("COMMAND_FAILED", "房间命令执行失败"),
        };
        UiError {
            code: code.into(),
            message: message.into(),
        }
    });
    ack
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{ConnectionState, DesktopUiState, NativeCapabilityReport, PlayerState};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct FakeSession {
        polls: Arc<AtomicUsize>,
        stops: Arc<AtomicUsize>,
        worker_thread: Arc<Mutex<Option<thread::ThreadId>>>,
        room_id: Option<String>,
        start_error: Option<TransportError>,
        failed: bool,
    }

    impl FakeSession {
        fn record_thread(&self) {
            *self
                .worker_thread
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(thread::current().id());
        }

        fn state_event(&self) -> DesktopEvent {
            DesktopEvent::State {
                state: DesktopUiState {
                    connection: ConnectionState::Ready,
                    room_id: self.room_id.clone(),
                    room: None,
                    members: Vec::new(),
                    can_control_shared_playback: false,
                    is_owner: false,
                    player: PlayerState::default(),
                    player_window_visible: false,
                    capability: NativeCapabilityReport::default(),
                    error: None,
                },
            }
        }

        fn failure_event(&self) -> DesktopEvent {
            DesktopEvent::State {
                state: DesktopUiState {
                    connection: ConnectionState::Expired,
                    room_id: None,
                    room: None,
                    members: Vec::new(),
                    can_control_shared_playback: false,
                    is_owner: false,
                    player: PlayerState::default(),
                    player_window_visible: false,
                    capability: NativeCapabilityReport::default(),
                    error: Some(UiError {
                        code: "ACCESS_TOKEN_INVALID".into(),
                        message: "桌面凭据已失效，请重新连接".into(),
                    }),
                },
            }
        }
    }

    impl ManagedSession for FakeSession {
        fn start(
            &mut self,
            _ticket: &str,
            _now_ms: i64,
        ) -> Result<Vec<DesktopEvent>, TransportError> {
            self.record_thread();
            if let Some(error) = self.start_error.clone() {
                self.failed = true;
                return Err(error);
            }
            Ok(vec![self.state_event()])
        }

        fn room_id(&self) -> Option<&str> {
            self.room_id.as_deref()
        }

        fn poll(&mut self, _now_ms: i64) -> Vec<DesktopEvent> {
            self.record_thread();
            self.polls.fetch_add(1, Ordering::SeqCst);
            vec![self.state_event()]
        }

        fn execute(
            &mut self,
            _command: DesktopCommand,
            _now_ms: i64,
        ) -> Result<CommandAck, TransportError> {
            self.record_thread();
            Ok(CommandAck {
                ok: true,
                revision: 1,
                error: None,
            })
        }

        fn handle_player_events(&mut self, _now_ms: i64) -> Vec<DesktopEvent> {
            Vec::new()
        }

        fn set_local_suspended(
            &mut self,
            _suspended: bool,
            _now_ms: i64,
        ) -> Result<Vec<DesktopEvent>, TransportError> {
            self.record_thread();
            Ok(vec![self.state_event()])
        }

        fn stop(&mut self) -> Result<(), TransportError> {
            self.record_thread();
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn event(&self) -> DesktopEvent {
            if self.failed {
                self.failure_event()
            } else {
                self.state_event()
            }
        }
    }

    fn test_runtime(
        polls: Arc<AtomicUsize>,
        stops: Arc<AtomicUsize>,
        worker_thread: Arc<Mutex<Option<thread::ThreadId>>>,
        events: Arc<Mutex<Vec<DesktopEvent>>>,
    ) -> DesktopRuntime {
        test_runtime_with_factory(
            Box::new(move || {
                Ok(Box::new(FakeSession {
                    polls: Arc::clone(&polls),
                    stops: Arc::clone(&stops),
                    worker_thread: Arc::clone(&worker_thread),
                    room_id: Some("room-fake".into()),
                    start_error: None,
                    failed: false,
                }))
            }),
            events,
        )
    }

    fn test_runtime_with_factory(
        factory: SessionFactory,
        events: Arc<Mutex<Vec<DesktopEvent>>>,
    ) -> DesktopRuntime {
        DesktopRuntime::spawn_inner(
            factory,
            Box::new(move |event| {
                events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(event);
            }),
            Duration::from_millis(10),
        )
        .expect("spawn test runtime")
    }

    #[test]
    fn session_work_polling_and_cleanup_run_off_the_caller_thread() {
        let caller_thread = thread::current().id();
        let polls = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let worker_thread = Arc::new(Mutex::new(None));
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime = test_runtime(
            Arc::clone(&polls),
            Arc::clone(&stops),
            Arc::clone(&worker_thread),
            Arc::clone(&events),
        );

        runtime
            .start("one-time-ticket".into(), None)
            .expect("start");
        runtime.execute(DesktopCommand::Play).expect("execute");
        runtime
            .set_local_suspended(true)
            .expect("locally suspend player");
        for _ in 0..50 {
            if polls.load(Ordering::SeqCst) > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        runtime.stop_session().expect("stop");
        runtime.shutdown();

        assert!(polls.load(Ordering::SeqCst) > 0);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert_ne!(
            *worker_thread
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            Some(caller_thread)
        );
        assert!(!events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty());
    }

    #[test]
    fn shutdown_is_idempotent_and_stops_an_active_session() {
        let polls = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let runtime = test_runtime(
            polls,
            Arc::clone(&stops),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(Vec::new())),
        );
        runtime
            .start("one-time-ticket".into(), None)
            .expect("start");
        runtime.shutdown();
        runtime.shutdown();
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert_eq!(
            runtime.execute(DesktopCommand::Pause),
            Err(RuntimeError::stopped())
        );
    }

    #[test]
    fn replacing_runtime_retires_active_session_before_renderer_reset() {
        let stops = Arc::new(AtomicUsize::new(0));
        let old = Arc::new(test_runtime(
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&stops),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(Vec::new())),
        ));
        old.start("test-ticket".into(), None)
            .expect("active session");
        let slot = Mutex::new(Some(Arc::clone(&old)));
        let replacement = test_runtime(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(Vec::new())),
        );
        replace_runtime_slot(&slot, Some(replacement), || {
            assert_eq!(stops.load(Ordering::SeqCst), 1);
            assert!(slot.lock().unwrap().is_none());
            assert_eq!(
                old.execute(DesktopCommand::Pause),
                Err(RuntimeError::stopped())
            );
        });
        let next = slot.lock().unwrap().clone().expect("replacement");
        assert_eq!(
            next.execute(DesktopCommand::Pause),
            Err(RuntimeError::not_started())
        );
        next.start("new-ticket".into(), None).expect("new session");
        replace_runtime_slot(&slot, None, || {});
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn dropping_runtime_cancels_polling_and_stops_the_session() {
        let stops = Arc::new(AtomicUsize::new(0));
        let runtime = test_runtime(
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&stops),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(Vec::new())),
        );
        runtime
            .start("one-time-ticket".into(), None)
            .expect("start");
        drop(runtime);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn execute_requires_an_active_session() {
        let runtime = test_runtime(
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(Vec::new())),
        );
        assert_eq!(
            runtime.execute(DesktopCommand::Play),
            Err(RuntimeError::not_started())
        );
    }

    #[test]
    fn backend_origin_is_native_only_and_rejects_unsafe_values() {
        assert!(NativeRuntimeConfig::new("https://watch.example".into(), None).is_ok());
        assert!(NativeRuntimeConfig::new("http://127.0.0.1:8080".into(), None).is_ok());
        for invalid in [
            "http://watch.example",
            "https://user:pass@watch.example",
            "https://watch.example/api",
            "https://watch.example?target=other",
        ] {
            assert!(NativeRuntimeConfig::new(invalid.into(), None).is_err());
        }
    }

    #[test]
    fn emitted_errors_are_allowlisted_instead_of_forwarded() {
        let event = DesktopEvent::State {
            state: DesktopUiState {
                connection: ConnectionState::Failed,
                room_id: Some("room-fake".into()),
                room: None,
                members: Vec::new(),
                can_control_shared_playback: false,
                is_owner: false,
                player: PlayerState::default(),
                player_window_visible: false,
                capability: NativeCapabilityReport::default(),
                error: Some(UiError {
                    code: "secret-code".into(),
                    message: "access-token direct-url basic-password".into(),
                }),
            },
        };
        let serialized = serde_json::to_string(&sanitize_event(event)).expect("serialize event");
        for secret in [
            "secret-code",
            "access-token",
            "direct-url",
            "basic-password",
        ] {
            assert!(!serialized.contains(secret));
        }
    }

    #[test]
    fn command_ack_errors_are_allowlisted_instead_of_forwarded() {
        let ack = sanitize_command_ack(CommandAck {
            ok: false,
            revision: 7,
            error: Some(UiError {
                code: "access-token".into(),
                message: "https://direct.invalid basic-password".into(),
            }),
        });
        let serialized = serde_json::to_string(&ack).expect("serialize ack");
        assert!(serialized.contains("COMMAND_FAILED"));
        for secret in ["access-token", "direct.invalid", "basic-password"] {
            assert!(!serialized.contains(secret));
        }
    }

    fn room_id_of(event: &DesktopEvent) -> Option<String> {
        match event {
            DesktopEvent::State { state } => state.room_id.clone(),
        }
    }

    fn connection_of(event: &DesktopEvent) -> ConnectionState {
        match event {
            DesktopEvent::State { state } => state.connection.clone(),
        }
    }

    #[test]
    fn failed_start_replaces_the_stale_room_with_an_explicit_failure() {
        let calls = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime = test_runtime_with_factory(
            {
                let calls = Arc::clone(&calls);
                Box::new(move || {
                    let call = calls.fetch_add(1, Ordering::SeqCst);
                    Ok(Box::new(FakeSession {
                        polls: Arc::new(AtomicUsize::new(0)),
                        stops: Arc::new(AtomicUsize::new(0)),
                        worker_thread: Arc::new(Mutex::new(None)),
                        room_id: Some("room-a".into()),
                        // The second join attempt fails with an expired ticket.
                        start_error: (call > 0).then_some(TransportError::Unauthorized),
                        failed: false,
                    }))
                })
            },
            Arc::clone(&events),
        );

        runtime
            .start("first-ticket".into(), None)
            .expect("first start");
        runtime
            .start("second-ticket".into(), None)
            .expect_err("second start must fail");

        let emitted = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        // After the failed attempt, the last emitted state must be a terminal
        // failure without any room — never the stale room of the old session.
        let last = emitted.last().expect("events were emitted");
        assert_eq!(connection_of(last), ConnectionState::Expired);
        assert_eq!(room_id_of(last), None);
        // From the second attempt's cleared connecting state onward, no stale
        // room-a state may reappear.
        let cleared_position = emitted
            .iter()
            .rposition(|event| connection_of(event) == ConnectionState::Connecting)
            .expect("cleared connecting state was emitted");
        assert!(emitted[cleared_position..]
            .iter()
            .all(|event| room_id_of(event).is_none()));
        runtime.shutdown();
    }

    #[test]
    fn start_rejects_a_session_for_a_room_other_than_the_launch_hint() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime = test_runtime_with_factory(
            Box::new(move || {
                Ok(Box::new(FakeSession {
                    polls: Arc::new(AtomicUsize::new(0)),
                    stops: Arc::new(AtomicUsize::new(0)),
                    worker_thread: Arc::new(Mutex::new(None)),
                    room_id: Some("room-b".into()),
                    start_error: None,
                    failed: false,
                }))
            }),
            Arc::clone(&events),
        );

        let result = runtime.start("ticket".into(), Some("room-a".into()));
        assert_eq!(result, Err(RuntimeError::room_mismatch()));

        let emitted = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        // The wrong-room session's ready state is never emitted; the renderer
        // only sees the cleared connecting state and the mismatch failure.
        assert_eq!(emitted.len(), 2);
        assert_eq!(connection_of(&emitted[0]), ConnectionState::Connecting);
        let last = emitted.last().expect("mismatch event");
        assert_eq!(connection_of(last), ConnectionState::Failed);
        match last {
            DesktopEvent::State { state } => {
                assert_eq!(state.room_id, None);
                assert_eq!(
                    state.error.as_ref().map(|error| error.code.as_str()),
                    Some("DESKTOP_ROOM_MISMATCH")
                );
            }
        }
    }

    #[test]
    fn matching_launch_hint_keeps_the_session() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime = test_runtime_with_factory(
            Box::new(move || {
                Ok(Box::new(FakeSession {
                    polls: Arc::new(AtomicUsize::new(0)),
                    stops: Arc::new(AtomicUsize::new(0)),
                    worker_thread: Arc::new(Mutex::new(None)),
                    room_id: Some("room-ok".into()),
                    start_error: None,
                    failed: false,
                }))
            }),
            Arc::clone(&events),
        );

        runtime
            .start("ticket".into(), Some("room-ok".into()))
            .expect("matching room must start");
        let emitted = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let last = emitted.last().expect("ready event");
        assert_eq!(connection_of(last), ConnectionState::Ready);
        assert_eq!(room_id_of(last).as_deref(), Some("room-ok"));
    }
}
