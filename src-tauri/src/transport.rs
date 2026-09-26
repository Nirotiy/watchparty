use crate::contracts::{CommandAck, DesktopCommand, MediaSource, RoomMember, RoomSnapshot};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportError {
    Network(String),
    DnsFailed,
    ConnectionRefused,
    TlsTrustRequired,
    Unauthorized,
    AuthRequired,
    AuthRejected,
    NotFound,
    ProtocolVersionMismatch,
    CapabilityUnavailable,
    Protocol(String),
    Http(u16, String),
}

#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapabilities {
    pub create_room: bool,
    pub join_room: bool,
    pub restore_session: bool,
    pub media_search: bool,
    pub media_queue: bool,
    pub handoff_code: bool,
    /// Whether the backend serves the readiness endpoint. Absent on older
    /// backends; absence means "no readiness information", never "degraded".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub readiness: bool,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProbeReport {
    pub status: String,
    pub protocol_version: u32,
    pub service_version: String,
    pub capabilities: DesktopCapabilities,
}

/// One dependency probe inside the readiness payload. Component status uses the
/// `up|down` vocabulary (distinct from the report's top-level `ready|degraded`);
/// rendering keys off `status`/`code`, never a localized `message`.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessComponent {
    pub status: String,
    #[serde(default)]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

/// One media-root probe inside `components.mediaRoots.roots[]`.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessMediaRoot {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub code: String,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessComponents {
    #[serde(default)]
    pub core: Option<ReadinessComponent>,
    #[serde(default)]
    pub openlist: Option<ReadinessComponent>,
    #[serde(default)]
    pub media_roots: Option<ReadinessComponent>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessDiagnostic {
    #[serde(default)]
    pub severity: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

/// Readiness payload as served by Node (`GET /api/desktop/readiness`); unknown
/// fields are tolerated so a Go dialect can be projected onto the same shape.
/// `startedAt`/`checkedAt` are epoch **milliseconds** (numbers, not ISO strings)
/// and `listener`/`cache`/`config` are carried through as opaque JSON: the
/// banner only reads `status`/`service`/`components`/`diagnostics`, and pinning
/// the rest down here would reject payloads for fields nobody renders.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopReadinessReport {
    pub status: String,
    #[serde(default)]
    pub service: String,
    #[serde(default = "default_readiness_version")]
    pub readiness_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(default)]
    pub components: ReadinessComponents,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<ReadinessDiagnostic>,
}

fn default_readiness_version() -> u32 {
    1
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
