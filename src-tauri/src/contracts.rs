use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

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
pub struct Track {
    pub id: i64,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub time: f64,
    pub duration: f64,
    pub buffering: bool,
    pub loaded: bool,
    pub paused: bool,
    pub rate: f64,
    pub volume: f64,
    pub audio_tracks: Vec<Track>,
    pub subtitle_tracks: Vec<Track>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapabilityReport {
    pub libmpv_ready: bool,
    pub vo: Option<String>,
    pub hwdec_configured: Option<String>,
    pub hwdec: Option<String>,
    pub video_codec: Option<String>,
    pub video_profile: Option<String>,
    pub audio_codec: Option<String>,
    pub pixel_format: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
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
#[serde(rename_all = "camelCase")]
pub struct DesktopUiState {
    pub connection: ConnectionState,
    /// The room the native session actually joined. This is the single source of
    /// truth for the UI; deep-link hints must never override it.
    #[serde(default)]
    pub room_id: Option<String>,
    pub room: Option<RoomSnapshot>,
    pub members: Vec<RoomMember>,
    #[serde(default)]
    pub can_control_shared_playback: bool,
    /// Whether this client owns the room (`client_id == snapshot.ownerClientId`).
    #[serde(default)]
    pub is_owner: bool,
    /// This client's own room member id. Non-sensitive; lets the UI identify
    /// itself for rename and ownership transfer targets.
    #[serde(default)]
    pub client_id: Option<String>,
    pub player: PlayerState,
    #[serde(default)]
    pub player_window_visible: bool,
    pub capability: NativeCapabilityReport,
    pub error: Option<UiError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct UiError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DesktopCommand {
    Play,
    Pause,
    /// Local-only correction to the room's authoritative playback position.
    Resync,
    Seek {
        #[serde(rename = "positionSeconds")]
        position_seconds: f64,
    },
    Rate {
        rate: f64,
    },
    /// Local-only player volume. It is intercepted before the room transport.
    Volume {
        volume: f64,
    },
    /// Local-only audio track selection.
    SelectAudioTrack {
        #[serde(rename = "trackId")]
        track_id: i64,
    },
    /// Local-only subtitle selection. `None` disables subtitles.
    SelectSubtitleTrack {
        #[serde(rename = "trackId")]
        track_id: Option<i64>,
    },
    /// Native window visibility. It is handled before the room transport.
    PlayerVisibility {
        visible: bool,
    },
    /// Native player fullscreen state. It is handled before the room transport.
    Fullscreen {
        enabled: bool,
    },
    PlaylistPlay {
        #[serde(rename = "itemId")]
        item_id: String,
    },
    PlaylistNext {
        #[serde(rename = "expectedCurrentPlaylistItemId")]
        expected_current_playlist_item_id: Option<String>,
    },
    /// Owner-only room lock. The server rejects it without a valid owner token.
    Lock {
        locked: bool,
    },
    /// Renames the caller. The wire name stays `name` to match the browser protocol.
    #[serde(rename = "name")]
    Rename {
        #[serde(rename = "name")]
        nickname: String,
    },
    /// Owner-only ownership transfer across browser and desktop clients.
    TransferOwner {
        #[serde(rename = "targetClientId")]
        target_client_id: String,
    },
}

impl<'de> Deserialize<'de> for DesktopCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "camelCase")]
        enum WireCommand {
            Play,
            Pause,
            Resync,
            Seek {
                #[serde(rename = "positionSeconds")]
                position_seconds: f64,
            },
            Rate {
                rate: f64,
            },
            Volume {
                volume: f64,
            },
            SelectAudioTrack {
                #[serde(rename = "trackId")]
                track_id: i64,
            },
            SelectSubtitleTrack {
                #[serde(rename = "trackId")]
                track_id: Option<i64>,
            },
            PlayerVisibility {
                visible: bool,
            },
            Fullscreen {
                enabled: bool,
            },
            PlaylistPlay {
                #[serde(rename = "itemId")]
                item_id: String,
            },
            PlaylistNext {
                #[serde(rename = "expectedCurrentPlaylistItemId")]
                expected_current_playlist_item_id: Option<String>,
            },
            Lock {
                locked: bool,
            },
            Rename {
                nickname: String,
            },
            TransferOwner {
                #[serde(rename = "targetClientId")]
                target_client_id: String,
            },
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        let fields = value
            .as_object()
            .ok_or_else(|| D::Error::custom("desktop command must be an object"))?;
        let command_type = fields
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| D::Error::custom("desktop command type is required"))?;
        let allowed_fields: &[&str] = match command_type {
            "play" | "pause" | "resync" => &["type"],
            "seek" => &["type", "positionSeconds"],
            "rate" => &["type", "rate"],
            "volume" => &["type", "volume"],
            "selectAudioTrack" | "selectSubtitleTrack" => &["type", "trackId"],
            "playerVisibility" => &["type", "visible"],
            "fullscreen" => &["type", "enabled"],
            "playlistPlay" => &["type", "itemId"],
            "playlistNext" => &["type", "expectedCurrentPlaylistItemId"],
            "lock" => &["type", "locked"],
            "name" => &["type", "name"],
            "transferOwner" => &["type", "targetClientId"],
            _ => return Err(D::Error::custom("unknown desktop command")),
        };
        if fields
            .keys()
            .any(|field| !allowed_fields.contains(&field.as_str()))
        {
            return Err(D::Error::custom("unknown desktop command field"));
        }

        let command = serde_json::from_value::<WireCommand>(value).map_err(D::Error::custom)?;
        Ok(match command {
            WireCommand::Play => Self::Play,
            WireCommand::Pause => Self::Pause,
            WireCommand::Resync => Self::Resync,
            WireCommand::Seek { position_seconds } => Self::Seek { position_seconds },
            WireCommand::Rate { rate } => Self::Rate { rate },
            WireCommand::Volume { volume } => Self::Volume { volume },
            WireCommand::SelectAudioTrack { track_id } => Self::SelectAudioTrack { track_id },
            WireCommand::SelectSubtitleTrack { track_id } => Self::SelectSubtitleTrack { track_id },
            WireCommand::PlayerVisibility { visible } => Self::PlayerVisibility { visible },
            WireCommand::Fullscreen { enabled } => Self::Fullscreen { enabled },
            WireCommand::PlaylistPlay { item_id } => Self::PlaylistPlay { item_id },
            WireCommand::PlaylistNext {
                expected_current_playlist_item_id,
            } => Self::PlaylistNext {
                expected_current_playlist_item_id,
            },
            WireCommand::Lock { locked } => Self::Lock { locked },
            WireCommand::Rename { nickname } => Self::Rename { nickname },
            WireCommand::TransferOwner { target_client_id } => {
                Self::TransferOwner { target_client_id }
            }
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_commands_use_the_server_wire_names() {
        let seek = serde_json::to_value(DesktopCommand::Seek {
            position_seconds: 12.5,
        })
        .expect("serialize seek command");
        assert_eq!(seek["type"], "seek");
        assert_eq!(seek["positionSeconds"], 12.5);
        assert!(seek.get("position_seconds").is_none());

        let next = serde_json::to_value(DesktopCommand::PlaylistNext {
            expected_current_playlist_item_id: Some("item-1".into()),
        })
        .expect("serialize playlist-next command");
        assert_eq!(next["type"], "playlistNext");
        assert_eq!(next["expectedCurrentPlaylistItemId"], "item-1");

        let play = serde_json::to_value(DesktopCommand::PlaylistPlay {
            item_id: "item-2".into(),
        })
        .expect("serialize playlist-play command");
        assert_eq!(play["type"], "playlistPlay");
        assert_eq!(play["itemId"], "item-2");

        let subtitle = serde_json::to_value(DesktopCommand::SelectSubtitleTrack { track_id: None })
            .expect("serialize subtitle command");
        assert_eq!(subtitle["type"], "selectSubtitleTrack");
        assert!(subtitle["trackId"].is_null());

        let resync =
            serde_json::to_value(DesktopCommand::Resync).expect("serialize resync command");
        assert_eq!(resync, serde_json::json!({ "type": "resync" }));
    }

    #[test]
    fn renderer_state_uses_camel_case_without_a_second_snapshot_type() {
        let state = PlayerState {
            audio_tracks: vec![Track {
                id: 1,
                label: "Main".into(),
                kind: "audio".into(),
                language: Some("jpn".into()),
                codec: Some("flac".into()),
                selected: true,
            }],
            ..PlayerState::default()
        };
        let value = serde_json::to_value(state).expect("serialize player state");
        assert!(value.get("audioTracks").is_some());
        assert!(value.get("audio_tracks").is_none());

        let capability = serde_json::to_value(NativeCapabilityReport::default())
            .expect("serialize capability report");
        assert!(capability.get("libmpvReady").is_some());
        assert!(capability.get("libmpv_ready").is_none());

        let ui_state = DesktopUiState {
            connection: ConnectionState::Connecting,
            room_id: Some("room-abc".into()),
            room: None,
            members: Vec::new(),
            can_control_shared_playback: false,
            is_owner: false,
            client_id: None,
            player: PlayerState::default(),
            player_window_visible: true,
            capability: NativeCapabilityReport::default(),
            error: None,
        };
        let ui_value = serde_json::to_value(ui_state).expect("serialize desktop UI state");
        assert_eq!(ui_value["playerWindowVisible"], true);
        assert_eq!(ui_value["canControlSharedPlayback"], false);
        assert_eq!(ui_value["roomId"], "room-abc");
        assert_eq!(ui_value["isOwner"], false);
        assert!(ui_value.get("player_window_visible").is_none());
        assert!(ui_value.get("room_id").is_none());

        // Older event payloads without the new fields still deserialize.
        let legacy = serde_json::from_str::<DesktopUiState>(
            r#"{"connection":"ready","room":null,"members":[],"player":{"time":0,"duration":0,"buffering":false,"loaded":false,"paused":false,"rate":1,"volume":100,"audioTracks":[],"subtitleTracks":[]},"playerWindowVisible":false,"capability":{"libmpvReady":false},"error":null}"#,
        )
        .expect("deserialize legacy state");
        assert_eq!(legacy.room_id, None);
        assert!(!legacy.is_owner);
    }
}
