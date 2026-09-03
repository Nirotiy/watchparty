use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientType {
    Browser,
    Mpv,
    Desktop,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMember {
    pub client_id: String,
    pub name: String,
    pub is_owner: bool,
    pub client_type: ClientType,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MediaSource {
    #[serde(rename_all = "camelCase")]
    Openlist {
        media_id: String,
        title: String,
        container: String,
        display_path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Http { url: String, title: Option<String> },
    #[serde(rename_all = "camelCase")]
    Hls { url: String, title: Option<String> },
    #[serde(rename_all = "camelCase")]
    Youtube {
        video_id: String,
        title: Option<String>,
    },
}

impl MediaSource {
    pub fn key(&self) -> String {
        match self {
            Self::Openlist { media_id, .. } => format!("openlist:{media_id}"),
            Self::Http { url, .. } => format!("http:{url}"),
            Self::Hls { url, .. } => format!("hls:{url}"),
            Self::Youtube { video_id, .. } => format!("youtube:{video_id}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    pub id: String,
    pub media: MediaSource,
    pub added_by_client_id: String,
    pub added_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub revision: u64,
    pub source: Option<MediaSource>,
    pub current_playlist_item_id: Option<String>,
    pub position_seconds: f64,
    pub server_time_ms: i64,
    pub paused: bool,
    pub playback_rate: f64,
    #[serde(rename = "loop")]
    pub loop_enabled: bool,
    pub locked: bool,
    pub owner_client_id: String,
    pub playlist: Vec<PlaylistItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SanitizedRoomSnapshot {
    pub revision: u64,
    pub source: Option<MediaSource>,
    pub current_playlist_item_id: Option<String>,
    pub position_seconds: f64,
    pub server_time_ms: i64,
    pub paused: bool,
    pub playback_rate: f64,
    #[serde(rename = "loop")]
    pub loop_enabled: bool,
    pub locked: bool,
    pub owner_client_id: String,
    pub playlist: Vec<PlaylistItem>,
}

impl From<&RoomSnapshot> for SanitizedRoomSnapshot {
    fn from(value: &RoomSnapshot) -> Self {
        Self {
            revision: value.revision,
            source: value.source.clone(),
            current_playlist_item_id: value.current_playlist_item_id.clone(),
            position_seconds: value.position_seconds,
            server_time_ms: value.server_time_ms,
            paused: value.paused,
            playback_rate: value.playback_rate,
            loop_enabled: value.loop_enabled,
            locked: value.locked,
            owner_client_id: value.owner_client_id.clone(),
            playlist: value.playlist.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Track {
    pub id: i64,
    pub label: String,
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct PlayerState {
    pub time: f64,
    pub duration: f64,
    pub buffering: bool,
    pub loaded: bool,
    pub audio_tracks: Vec<Track>,
    pub subtitle_tracks: Vec<Track>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct NativeCapabilityReport {
    pub libmpv_ready: bool,
    pub hwdec: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub hdr: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connecting,
    Ready,
    Backoff,
    Expired,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DesktopUiState {
    pub connection: ConnectionState,
    pub room: Option<SanitizedRoomSnapshot>,
    pub members: Vec<RoomMember>,
    pub player: PlayerState,
    pub capability: NativeCapabilityReport,
    pub error: Option<UiError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct UiError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DesktopCommand {
    Play,
    Pause,
    Seek {
        position_seconds: f64,
    },
    Rate {
        rate: f64,
    },
    PlaylistNext {
        expected_current_playlist_item_id: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CommandAck {
    pub ok: bool,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub error: Option<UiError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DesktopEvent {
    State { state: DesktopUiState },
}
