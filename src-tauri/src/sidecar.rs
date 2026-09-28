//! Private stdio transport. Only the owning desktop main process has these pipes.
use crate::{
    config,
    config::{DesktopSettingsInput, OriginTrustStore},
    contracts::DesktopCommand,
    launch::parse_room_deep_link,
    libmpv::LibMpvConfig,
    musicparty::{MusicPartyBridge, MusicPartyRequest},
    musicparty_player::{AudioCommand, AudioRequest, MusicPartyPlayerState},
    musicparty_ws::{MusicPartyWsState, WsConnectInput},
    native_api::{self as api, DesktopHost, Host, NativeDesktopState},
    runtime::RuntimeError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::{self, BufRead, Read, Write}, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}}};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_IN_FLIGHT: usize = 32;

#[derive(Deserialize)]
struct Request {
    id: u64,
    #[serde(flatten)]
    command: Command,
}

// Native DTO validation remains authoritative, including commands nested under executeRoomCommand.
#[derive(Deserialize)]
#[serde(tag = "method", content = "args")]
enum Command {
    #[serde(rename = "musicPartyRequest")]
    MusicRequest { input: MusicPartyRequest },
    #[serde(rename = "clearMusicPartySession")]
    ClearMusic { origin: String },
    #[serde(rename = "musicPartyWsConnect")]
    WsConnect { input: WsConnectInput },
    #[serde(rename = "musicPartyWsSend")]
    WsSend { event: String },
    #[serde(rename = "musicPartyWsReceive")]
    WsReceive {},
    #[serde(rename = "musicPartyWsDisconnect")]
    WsDisconnect {},
    #[serde(rename = "musicPartyAudio")]
    Audio { input: AudioRequest },
    #[serde(rename = "getDesktopSettings")]
    Settings {},
    #[serde(rename = "listAudioOutputDevices")]
    AudioOutputDevices {},
    #[serde(rename = "updateDesktopSettings")]
    UpdateSettings { input: DesktopSettingsInput },
    #[serde(rename = "listOriginTrust")]
    Trust {},
    #[serde(rename = "importOriginTrust")]
    ImportTrust { origin: String, pem: String },
    #[serde(rename = "deleteOriginTrust")]
    DeleteTrust { origin: String },
    #[serde(rename = "promptSiteCredentials")]
    PromptCredentials {},
    #[serde(rename = "clearSiteCredentials")]
    ClearCredentials {},
    #[serde(rename = "verifyBackend")]
    Verify {},
    #[serde(rename = "probeDesktopBackend")]
    ProbeDesktopBackend {},
    #[serde(rename = "probeDesktopReadiness")]
    ProbeDesktopReadiness {},
    #[serde(rename = "createDesktopRoom")]
    Create { input: api::DesktopRoomInput },
    #[serde(rename = "accessDesktopRoom")]
    Access { input: api::DesktopAccessInput },
    #[serde(rename = "startDesktopSession")]
    Start { ticket: String, #[serde(rename = "expectedRoomId")] expected_room_id: Option<String> },
    #[serde(rename = "restoreDesktopSession")]
    Restore {},
    #[serde(rename = "stopDesktopSession")]
    Stop {},
    #[serde(rename = "checkpointDesktopSession")]
    Checkpoint {},
    #[serde(rename = "suspendDesktopSession")]
    Suspend {},
    #[serde(rename = "rollbackDesktopSession")]
    Rollback { #[serde(rename = "checkpointId")] checkpoint_id: String },
    #[serde(rename = "discardDesktopSessionCheckpoint")]
    DiscardCheckpoint { #[serde(rename = "checkpointId")] checkpoint_id: String },
    #[serde(rename = "executeRoomCommand")]
    Execute { command: DesktopCommand },
    #[serde(rename = "currentDesktopLaunch")]
    Launch {},
    #[serde(rename = "mediaRoots")]
    Roots {},
    #[serde(rename = "mediaList")]
    List { root: String, path: Option<String>, cursor: Option<String> },
    #[serde(rename = "mediaSearch")]
    Search { query: String, cursor: Option<String> },
    #[serde(rename = "mediaRequest")]
    MediaRequest {
        method: String,
        path: String,
        query: Option<String>,
        body: Option<Value>,
    },
    #[serde(rename = "mediaImage", rename_all = "camelCase")]
    MediaImage { kind: String, id: String },
    #[serde(rename = "__launch")]
    OpenUrl { url: String },
    #[serde(rename = "__shutdown")]
    Shutdown {},
}

#[derive(Clone)]
struct Output(Arc<Mutex<io::Stdout>>);
impl Output {
    fn send(&self, value: Value) {
        if let Ok(mut out) = self.0.lock() {
            let _ = serde_json::to_writer(&mut *out, &value);
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
    }
}
struct ElectronHost { directory: PathBuf, hwnd: isize, output: Output }
impl DesktopHost for ElectronHost {
    fn data_dir(&self) -> Result<PathBuf, RuntimeError> { Ok(self.directory.clone()) }
    fn window_handle(&self) -> Result<isize, RuntimeError> { Ok(self.hwnd) }
    fn emit_value(&self, event: &str, payload: Value) { self.output.send(json!({"event":event,"payload":payload})); }
    fn set_fullscreen(&self, enabled: bool) -> Result<(), RuntimeError> {
        self.emit_value("__fullscreen", json!(enabled));
        Ok(())
    }
}
struct State {
    desktop: NativeDesktopState,
    http: MusicPartyBridge,
    ws: MusicPartyWsState,
    audio: MusicPartyPlayerState,
    // Serialize both products' focus-changing commands, including asynchronous IPC requests.
    music_focus: Mutex<Option<String>>,
}

fn encode<T: Serialize, E: Serialize>(result: Result<T, E>) -> Result<Value, Value> {
    result.map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
        .map_err(|e| serde_json::to_value(e).unwrap_or(json!("desktop_request_failed")))
}
impl State {
    fn release_music_focus(&self, owner: &mut Option<String>) -> Result<(), Value> {
        if let Some(player_id) = owner.as_ref() {
            encode(self.audio.execute(AudioRequest {
                player_id: player_id.clone(), command: AudioCommand::Focus { active: false },
            }))?;
        }
        *owner = None;
        Ok(())
    }

    fn dispatch(&self, command: Command) -> Result<Value, Value> {
        let s = &self.desktop;
        // Receive/HTTP do not take this lock: a waiting socket must never block playback.
        let changes_focus = matches!(&command,
            Command::Audio { .. } | Command::Create { .. } | Command::Access { .. }
            | Command::Start { .. } | Command::Restore { .. } | Command::Execute { .. }
            | Command::UpdateSettings { .. } | Command::Stop { .. });
        let mut focus = changes_focus.then(|| self.music_focus.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        let claims_watchparty = matches!(&command,
            Command::Create { .. } | Command::Access { .. } | Command::Start { .. } | Command::Restore { .. }
            | Command::Execute { command: DesktopCommand::Play | DesktopCommand::PlayerVisibility { visible: true } | DesktopCommand::Fullscreen { .. } });
        if claims_watchparty {
            self.release_music_focus(focus.as_mut().unwrap())?;
            if matches!(&command, Command::Execute { command: DesktopCommand::Play }) {
                encode(s.runtime().and_then(|runtime| runtime.set_local_suspended(false)))?;
            }
        }
        match command {
            Command::MusicRequest { input } => {
                let origin = input.origin.clone();
                let result = self.http.request_with_clear(input);
                // Credentials gone means the room is gone: cancel the socket here instead
                // of trusting the renderer to remember a separate disconnect call.
                if matches!(result, Ok((_, true))) { let _ = self.ws.disconnect_origin(&origin); }
                encode(result.map(|(response, _)| response))
            }
            Command::ClearMusic { origin } => {
                let result = self.http.clear(&origin);
                if result.is_ok() { let _ = self.ws.disconnect_origin(&origin); }
                encode(result)
            }
            Command::WsConnect { input } => encode(self.ws.connect(input)),
            Command::WsSend { event } => encode(self.ws.send(event)),
            Command::WsReceive {} => encode(self.ws.receive()),
            Command::WsDisconnect {} => encode(self.ws.disconnect()),
            Command::Audio { input } => {
                let owner = focus.as_mut().unwrap();
                if matches!(&input.command, AudioCommand::Focus { active: true }) {
                    if let Some(runtime) = s.runtime_for_shutdown() {
                        if let Err(error) = runtime.set_local_suspended(true) {
                            if error.code != "DESKTOP_SESSION_NOT_STARTED" { return Err(json!(error)); }
                        }
                    }
                    let id = input.player_id.clone();
                    let result = encode(self.audio.execute(input))?;
                    **owner = Some(id);
                    Ok(result)
                } else {
                    let releases = matches!(&input.command, AudioCommand::Focus { active: false } | AudioCommand::Dispose);
                    let is_owner = owner.as_deref() == Some(input.player_id.as_str());
                    let result = encode(self.audio.execute(input))?;
                    if releases && is_owner { **owner = None; }
                    Ok(result)
                }
            },
            Command::Settings {} => encode(api::get_desktop_settings(s)),
            Command::AudioOutputDevices {} => encode(api::list_audio_output_devices(s)),
            Command::UpdateSettings { input } => encode(api::update_desktop_settings(input, s)),
            Command::Trust {} => encode(api::listOriginTrust(s)),
            Command::ImportTrust { origin, pem } => encode(api::importOriginTrust(s, origin, pem)),
            Command::DeleteTrust { origin } => encode(api::deleteOriginTrust(s, origin)),
            Command::PromptCredentials {} => encode(api::prompt_site_credentials(s)),
            Command::ClearCredentials {} => encode(api::clear_site_credentials(s)),
            Command::Verify {} => encode(api::verify_backend(s)),
            Command::ProbeDesktopBackend {} => encode(api::probe_desktop_backend(s)),
            Command::ProbeDesktopReadiness {} => encode(api::probe_desktop_readiness(s)),
            Command::Create { input } => encode(api::create_desktop_room(input, s)),
            Command::Access { input } => encode(api::access_desktop_room(input, s)),
            Command::Start { ticket, expected_room_id } => encode(api::start_desktop_session(ticket, expected_room_id, s)),
            Command::Restore {} => encode(api::restore_desktop_session(s)),
            Command::Stop {} => encode(api::stop_desktop_session(s)),
            Command::Checkpoint {} => encode(api::checkpoint_desktop_session(s)),
            Command::Suspend {} => encode(api::suspend_desktop_session(s)),
            Command::Rollback { checkpoint_id } => encode(api::rollback_desktop_session(s, checkpoint_id)),
            Command::DiscardCheckpoint { checkpoint_id } => encode(api::discard_desktop_session_checkpoint(s, checkpoint_id)),
            Command::Execute { command } => encode(api::execute_room_command(s, command)),
            Command::Launch {} => Ok(serde_json::to_value(s.current_launch()).unwrap_or(Value::Null)),
            Command::Roots {} => encode(api::media_roots(s)),
            Command::List { root, path, cursor } => encode(api::media_list(s, root, path, cursor)),
            Command::Search { query, cursor } => encode(api::media_search(s, query, cursor)),
            Command::MediaRequest { method, path, query, body } => encode(api::media_request(s, method, path, query, body)),
            Command::MediaImage { kind, id } => encode(api::media_image(s, kind, id)),
            Command::OpenUrl { url } => {
                let launch = parse_room_deep_link(&url).ok_or(json!("invalid_deep_link"))?;
                s.record_launch(launch.clone());
                Ok(json!(launch))
            }
            Command::Shutdown {} => { self.shutdown(); Ok(Value::Null) }
        }
    }
    fn shutdown(&self) {
        let _ = self.ws.disconnect();
        self.audio.shutdown();
        if let Some(runtime) = self.desktop.runtime_for_shutdown() { runtime.shutdown(); }
    }
}

/// Starts without a listening port. Data paths and HWND come only from the parent process.
pub fn run(directory: PathBuf, hwnd: isize) -> Result<(), Box<dyn std::error::Error>> {
    if !directory.is_absolute() || hwnd == 0 { return Err("invalid_sidecar_configuration".into()); }
    api::configure_native_surface(hwnd).map_err(|_| "desktop_surface_unavailable")?;
    let output = Output(Arc::new(Mutex::new(io::stdout())));
    let host = Host(Arc::new(ElectronHost { directory: directory.clone(), hwnd, output: output.clone() }));
    let player = LibMpvConfig::from_env(hwnd as usize)?;
    let desktop = NativeDesktopState::initialize(host, player.clone()).map_err(|_| "desktop_initialization_failed")?;
    let settings = desktop.settings_status().map_err(|_| "desktop_initialization_failed")?;
    let trust = Arc::new(OriginTrustStore::new(directory));
    let audio_output = output.clone();
    let state = Arc::new(State {
        desktop,
        music_focus: Mutex::new(None),
        http: MusicPartyBridge::with_trust_store(trust.clone()),
        ws: MusicPartyWsState::with_trust_store(trust.clone()),
        audio: MusicPartyPlayerState::spawn(player.with_preferences(settings.player_preferences), trust, move |event| {
            audio_output.send(json!({"event":"musicparty://audio-error", "payload":event}));
        }, Arc::new(move |origin| config::MusicPartyCredentialStore.read(origin).ok().flatten().map(|session| format!("MP_SESSION={}; MP_CSRF={}", session.session, session.csrf))))?,
    });
    output.send(json!({"event":"__ready", "payload":{"protocol":1}}));
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let active = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    loop {
        let mut line = Vec::new();
        let size = (&mut reader).take((MAX_FRAME + 1) as u64).read_until(b'\n', &mut line)?;
        if size == 0 || size > MAX_FRAME { break; }
        let request: Request = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(_) => { output.send(json!({"id": serde_json::from_slice::<Value>(&line).ok().and_then(|v| v.get("id")?.as_u64()), "error":"invalid_desktop_request"})); continue; }
        };
        if matches!(request.command, Command::Shutdown {}) {
            state.shutdown();
            output.send(json!({"id":request.id,"result":null}));
            break;
        }
        if active.load(Ordering::Acquire) >= MAX_IN_FLIGHT {
            output.send(json!({"id":request.id,"error":"desktop_busy"})); continue;
        }
        // Reap completed workers; receive can wait without blocking sends or shutdown.
        let mut i = 0;
        while i < workers.len() {
            if std::thread::JoinHandle::is_finished(&workers[i]) { let _ = workers.swap_remove(i).join(); } else { i += 1; }
        }
        active.fetch_add(1, Ordering::AcqRel);
        let state = state.clone(); let output = output.clone(); let active = active.clone();
        workers.push(std::thread::spawn(move || {
            let response = match state.dispatch(request.command) {
                Ok(result) => json!({"id":request.id,"result":result}),
                Err(error) => json!({"id":request.id,"error":error}),
            };
            output.send(response);
            active.fetch_sub(1, Ordering::AcqRel);
        }));
    }
    state.shutdown();
    for worker in workers { let _ = worker.join(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_rejects_arbitrary_commands_and_native_injection() {
        for method in ["exec", "readFile", "spawn", "mpvCommand"] {
            assert!(serde_json::from_value::<Request>(json!({"id":1,"method":method,"args":{}})).is_err());
        }
        assert!(serde_json::from_value::<Request>(json!({"id":1,"method":"musicPartyAudio","args":{"input":{"playerId":"test","command":{"action":"load","url":"https://example.org/a","itemId":"a","headers":{"Cookie":"secret"}}}}})).is_err());
    }
}
