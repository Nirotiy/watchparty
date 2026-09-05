use crate::contracts::{CommandAck, DesktopCommand, MediaSource, RoomMember, RoomSnapshot};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportError {
    Network(String),
    Unauthorized,
    NotFound,
    Protocol(String),
    Http(u16, String),
}

#[derive(PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub room_id: String,
    pub client_id: String,
    pub access_token: String,
    pub nickname: String,
    #[serde(default, alias = "sessionGeneration")]
    pub generation: u64,
    pub snapshot: RoomSnapshot,
    #[serde(default)]
    pub members: Vec<RoomMember>,
    #[serde(default)]
    pub owner_token: Option<String>,
}

#[derive(PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMedia {
    pub direct_url: Option<String>,
    pub fallback_url: Option<String>,
    pub user_agent: String,
}

/// A discovered external subtitle file for the current OpenList media.
/// `media_id` is the opaque server token used to download the content; it is
/// never a path or a direct URL.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrackInfo {
    #[serde(rename = "mediaId")]
    pub media_id: String,
    pub label: String,
    #[serde(default)]
    pub language: Option<String>,
    pub format: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestTiming {
    pub sent_ms: i64,
    pub received_ms: i64,
}

#[derive(Debug)]
pub struct SnapshotResponse {
    pub snapshot: Option<RoomSnapshot>,
    pub timing: Option<RequestTiming>,
}

pub trait RoomTransport {
    fn redeem_desktop(&mut self, ticket: &str) -> Result<Handoff, TransportError>;
    fn create_desktop(
        &mut self,
        client_id: &str,
        nickname: &str,
        pin: Option<&str>,
        initial_media: Option<&MediaSource>,
    ) -> Result<Handoff, TransportError> {
        let _ = (client_id, nickname, pin, initial_media);
        Err(TransportError::Protocol(
            "desktop create is unavailable".into(),
        ))
    }
    fn access_desktop(
        &mut self,
        room_id: &str,
        client_id: &str,
        nickname: &str,
        pin: Option<&str>,
    ) -> Result<String, TransportError> {
        let _ = (room_id, client_id, nickname, pin);
        Err(TransportError::Protocol(
            "desktop access is unavailable".into(),
        ))
    }
    fn claim_session(&mut self, room_id: &str, token: &str) -> Result<u64, TransportError>;
    fn snapshot(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
        since: Option<u64>,
    ) -> Result<SnapshotResponse, TransportError>;
    fn members(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
    ) -> Result<Vec<RoomMember>, TransportError>;
    fn command(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
        command: &DesktopCommand,
        expected_revision: u64,
        owner_token: Option<&str>,
    ) -> Result<CommandAck, TransportError>;
    /// Claims a pending one-time owner grant queued for this desktop client by
    /// a transferring owner. `Ok(None)` means no grant is waiting.
    fn claim_owner_grant(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
    ) -> Result<Option<String>, TransportError> {
        let _ = (room_id, token, generation);
        Err(TransportError::Protocol(
            "owner grant claim is unavailable".into(),
        ))
    }
    fn resolve(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
        source: &MediaSource,
    ) -> Result<ResolvedMedia, TransportError>;
    /// External subtitle discovery for an OpenList source. Empty = no matches.
    fn discover_subtitles(
        &mut self,
        _room_id: &str,
        _token: &str,
        _generation: u64,
        _source: &MediaSource,
    ) -> Result<Vec<SubtitleTrackInfo>, TransportError> {
        Ok(Vec::new())
    }
    /// Downloads one external subtitle into a native byte buffer. The content
    /// never crosses into the WebView or the room transport.
    fn download_subtitle(
        &mut self,
        _room_id: &str,
        _token: &str,
        _generation: u64,
        _subtitle_media_id: &str,
    ) -> Result<Vec<u8>, TransportError> {
        Err(TransportError::Protocol(
            "subtitle download is unavailable".into(),
        ))
    }
    fn leave(&mut self, room_id: &str, token: &str, generation: u64) -> Result<(), TransportError>;
    fn site_basic_auth(&self) -> Option<(&str, &str)> {
        None
    }
    /// Site credentials for a media URL. Only URLs sharing the backend's origin
    /// (scheme + host + port, i.e. the `/p/` fallback) may carry them.
    fn site_basic_auth_for(&self, _media_url: &str) -> Option<(&str, &str)> {
        None
    }
    fn supports_clock_sync(&self) -> bool {
        false
    }
    fn clear_site_basic_auth(&mut self) {}
}
