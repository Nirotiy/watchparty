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
    ) -> Result<CommandAck, TransportError>;
    fn resolve(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
        source: &MediaSource,
    ) -> Result<ResolvedMedia, TransportError>;
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
