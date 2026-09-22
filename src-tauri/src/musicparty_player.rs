//! Native audio IPC. DLL paths, window handles and certificate paths never enter renderer DTOs.
use crate::{
    config::OriginTrustStore,
    libmpv::{LibMpvConfig, LibMpvPlayer},
    playback::{is_trusted_media_url, PlaybackLoad, PlayerEngine, PlayerEvent},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum AudioCommand {
    Load {
        url: String,
        #[serde(rename = "itemId")]
        item_id: String,
    },
    Snapshot {
        #[serde(rename = "itemId")]
        item_id: Option<String>,
        position: f64,
        playing: bool,
    },
    Pause,
    Resume,
    Stop,
    Volume {
        volume: f64,
    },
    Focus {
        active: bool,
    },
    Dispose,
    Status,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioRequest {
    pub player_id: String,
    pub command: AudioCommand,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub loaded: bool,
    pub position: f64,
    pub paused: bool,
    pub volume: f64,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioError {
    pub player_id: String,
    pub code: &'static str,
}
type Reply = mpsc::Sender<Result<AudioStatus, String>>;
type Work = Option<(AudioRequest, Reply)>;

pub struct MusicPartyPlayerState {
    sender: mpsc::Sender<Work>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}
impl MusicPartyPlayerState {
    /// Creates the command thread. libmpv itself is opened lazily, on the first load.
    pub fn spawn(
        mut config: LibMpvConfig,
        trust: Arc<OriginTrustStore>,
        error: impl Fn(AudioError) + Send + 'static,
        cookie_for_origin: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    ) -> Result<Self, std::io::Error> {
        config.audio_only = true;
        let (sender, receiver) = mpsc::channel::<Work>();
        let worker = thread::Builder::new().name("musicparty-libmpv".into()).spawn(move || {
            let mut audio = AudioWorker { config, trust, cookie_for_origin, player: None, owner: None, item: None, focused: false, wants_play: false, desired_volume: None, generation: 0 };
            loop {
                match receiver.recv_timeout(Duration::from_millis(25)) {
                    Ok(Some((request, reply))) => { let _ = reply.send(audio.execute(request)); }
                    Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if let Some(player) = audio.player.as_mut() {
                    if player.drain_events().iter().any(|e| matches!(e, PlayerEvent::Error { generation, .. } if *generation == audio.generation)) {
                        let _ = player.stop_playback();
                        audio.wants_play = false;
                        if let Some(id) = &audio.owner { error(AudioError { player_id: id.clone(), code: "musicparty_playback_failed" }); }
                    }
                }
            }
            // The player is destroyed on its owning thread, including application shutdown.
        })?;
        Ok(Self {
            sender,
            worker: Mutex::new(Some(worker)),
        })
    }
    pub fn execute(&self, request: AudioRequest) -> Result<AudioStatus, String> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Some((request, tx)))
            .map_err(|_| "musicparty_player_unavailable")?;
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|_| "musicparty_player_unavailable")?
    }
    pub fn shutdown(&self) {
        let _ = self.sender.send(None);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = worker.join();
        }
    }
}
impl Drop for MusicPartyPlayerState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct AudioWorker {
    config: LibMpvConfig,
    trust: Arc<OriginTrustStore>,
    cookie_for_origin: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    player: Option<LibMpvPlayer>,
    owner: Option<String>,
    item: Option<String>,
    focused: bool,
    wants_play: bool,
    desired_volume: Option<f64>,
    generation: u64,
}
impl AudioWorker {
    fn status(&self) -> AudioStatus {
        self.player.as_ref().map_or(
            AudioStatus {
                loaded: false,
                position: 0.0,
                paused: true,
                volume: self.desired_volume.unwrap_or(100.0),
            },
            |p| {
                let s = p.state();
                AudioStatus {
                    loaded: s.loaded,
                    position: s.time,
                    paused: s.paused,
                    volume: s.volume,
                }
            },
        )
    }
    fn execute(&mut self, request: AudioRequest) -> Result<AudioStatus, String> {
        if uuid::Uuid::parse_str(&request.player_id).is_err() {
            return Err("invalid_player_id".into());
        }
        // Volume is remembered before the first load, so it is handled ahead of
        // ownership; once a player is owned only that player may change it.
        if let AudioCommand::Volume { volume } = &request.command {
            let volume = *volume;
            if !volume.is_finite() || !(0.0..=100.0).contains(&volume) {
                return Err("invalid_volume".into());
            }
            if self.owner.is_some() && self.owner.as_deref() != Some(request.player_id.as_str()) {
                return Err("musicparty_player_not_active".into());
            }
            self.desired_volume = Some(volume);
            if let Some(player) = self.player.as_mut() {
                player.set_volume(volume);
            }
            return Ok(self.status());
        }
        if let AudioCommand::Load { url, item_id } = request.command {
            let parsed = url::Url::parse(&url).map_err(|_| "invalid_media_url")?;
            if !is_trusted_media_url(&url)
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || url.len() > 16384
                || item_id.is_empty()
                || item_id.len() > 512
            {
                return Err("invalid_media_url".into());
            }
            if let Some(player) = self.player.as_mut() {
                player
                    .stop_playback()
                    .map_err(|_| "musicparty_playback_failed")?;
            }
            if self.player.is_none() {
                self.player = Some(
                    LibMpvPlayer::open(&self.config)
                        .map_err(|_| "musicparty_player_unavailable")?,
                );
                if let Some(volume) = self.desired_volume {
                    self.player.as_mut().unwrap().set_volume(volume);
                }
            }
            if self.owner.as_deref() != Some(&request.player_id) {
                self.focused = false;
            }
            self.owner = Some(request.player_id);
            self.item = Some(item_id);
            self.wants_play = false;
            let ca = self
                .trust
                .ca_file_for(&parsed.origin().ascii_serialization())
                .map_err(|_| "musicparty_tls_unavailable")?;
            let cookie = (self.cookie_for_origin)(&parsed.origin().ascii_serialization());
            self.generation += 1;
            let player = self.player.as_mut().unwrap();
            player
                .set_paused(true)
                .map_err(|_| "musicparty_playback_failed")?;
            player.load(PlaybackLoad {
                url: &url,
                user_agent: "MusicParty Desktop",
                fallback: false,
                generation: self.generation,
                playlist_item_id: self.item.as_deref(),
                basic_auth: None,
                cookie_header: cookie.as_deref(),
                tls_ca_file: ca.as_deref(),
                subtitles: Vec::new(),
            });
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let events = player.drain_events();
                if events.iter().any(|e| matches!(e, PlayerEvent::Error { generation, .. } if *generation == self.generation)) { break; }
                if events.iter().any(|e| matches!(e, PlayerEvent::Loaded { generation } if *generation == self.generation)) { return Ok(self.status()); }
                thread::sleep(Duration::from_millis(20));
            }
            let _ = player.stop_playback();
            self.item = None;
            return Err("musicparty_playback_failed".into());
        }
        if self.owner.as_deref() != Some(&request.player_id) {
            return match request.command {
                AudioCommand::Dispose
                | AudioCommand::Stop
                | AudioCommand::Focus { active: false } => Ok(self.status()),
                _ => Err("musicparty_player_not_active".into()),
            };
        }
        if matches!(request.command, AudioCommand::Dispose) {
            self.player.take();
            self.owner = None;
            self.item = None;
            self.focused = false;
            self.wants_play = false;
            return Ok(self.status());
        }
        let player = self
            .player
            .as_mut()
            .ok_or("musicparty_player_unavailable")?;
        let result = match request.command {
            AudioCommand::Snapshot {
                item_id,
                position,
                playing,
            } => {
                if !position.is_finite() || position < 0.0 {
                    return Err("invalid_playback_position".into());
                }
                if item_id.is_none() {
                    self.wants_play = false;
                    self.item = None;
                    player.stop_playback()
                } else if item_id != self.item {
                    self.wants_play = false;
                    player.set_paused(true)
                } else {
                    if (player.state().time - position).abs() > 0.75 {
                        player
                            .seek_absolute(position)
                            .map_err(|_| "musicparty_playback_failed")?;
                    }
                    self.wants_play = playing;
                    player.set_paused(!playing || !self.focused)
                }
            }
            AudioCommand::Pause => {
                self.wants_play = false;
                player.set_paused(true)
            }
            AudioCommand::Resume => {
                self.wants_play = true;
                player.set_paused(!self.focused)
            }
            AudioCommand::Focus { active } => {
                self.focused = active;
                player.set_paused(!active || !self.wants_play)
            }
            AudioCommand::Stop => {
                self.wants_play = false;
                self.item = None;
                player.stop_playback()
            }
            AudioCommand::Status => Ok(()),
            AudioCommand::Load { .. } | AudioCommand::Dispose | AudioCommand::Volume { .. } => unreachable!(),
        };
        result.map_err(|_| "musicparty_playback_failed")?;
        Ok(self.status())
    }
}

