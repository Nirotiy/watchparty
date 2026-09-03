use crate::contracts::{CommandAck, DesktopCommand, MediaSource, RoomMember, RoomSnapshot};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportError {
    Network(String),
    Unauthorized,
    NotFound,
    Protocol(String),
    Http(u16, String),
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
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
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMedia {
    pub direct_url: Option<String>,
    pub fallback_url: Option<String>,
    pub user_agent: String,
}

pub trait RoomTransport {
    fn redeem_desktop(&mut self, ticket: &str) -> Result<Handoff, TransportError>;
    fn claim_session(&mut self, room_id: &str, token: &str) -> Result<u64, TransportError>;
    fn snapshot(
        &mut self,
        room_id: &str,
        token: &str,
        generation: u64,
        since: Option<u64>,
    ) -> Result<Option<RoomSnapshot>, TransportError>;
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
    fn clear_site_basic_auth(&mut self) {}
}
