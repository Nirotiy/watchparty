use crate::contracts::{NativeCapabilityReport, PlayerState, RoomSnapshot};
use crate::transport::ResolvedMedia;
use std::net::IpAddr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlaybackState {
    Direct,
    DirectRetry,
    Fallback,
    Failed,
}

/// Only https targets (or loopback http) may ever be handed to the player.
/// Resolve responses are untrusted input: a compromised backend or OpenList must
/// not be able to point the native player (or its credentials) elsewhere.
pub fn is_trusted_media_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.username() != "" || parsed.password().is_some() {
        return false;
    }
    if parsed.host_str().is_none() {
        return false;
    }
    if parsed.scheme() == "https" {
        return true;
    }
    if parsed.scheme() != "http" {
        return false;
    }
    // IPv6 hosts arrive bracketed (`[::1]`); strip before the loopback check.
    let raw_host = parsed.host_str().unwrap_or_default();
    let host = raw_host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(raw_host);
    host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlaybackAction {
    Load {
        url: String,
        user_agent: String,
        fallback: bool,
    },
    ResolveAgain,
    Fail,
}

pub struct PlaybackPolicy {
    pub state: PlaybackState,
    pub generation: u64,
    pub resolve_retried: bool,
    fallback: Option<(String, String)>,
}

impl Default for PlaybackPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl PlaybackPolicy {
    pub fn new() -> Self {
        Self {
            state: PlaybackState::Direct,
            generation: 0,
            resolve_retried: false,
            fallback: None,
        }
    }
    pub fn begin(&mut self, generation: u64) {
        self.state = PlaybackState::Direct;
        self.generation = generation;
        self.resolve_retried = false;
        self.fallback = None;
    }
    pub fn resolved(&mut self, media: &ResolvedMedia) -> PlaybackAction {
        self.remember_fallback(media);
        if let Some(url) = media
            .direct_url
            .as_deref()
            .filter(|url| is_trusted_media_url(url))
        {
            self.state = PlaybackState::Direct;
            return PlaybackAction::Load {
                url: url.to_owned(),
                user_agent: media.user_agent.clone(),
                fallback: false,
            };
        }
        if self.fallback.is_some() {
            return self.load_fallback();
        }
        self.state = PlaybackState::Failed;
        PlaybackAction::Fail
    }

    pub fn player_error(&mut self) -> PlaybackAction {
        if self.state == PlaybackState::Direct && !self.resolve_retried {
            self.resolve_retried = true;
            self.state = PlaybackState::DirectRetry;
            PlaybackAction::ResolveAgain
        } else if self.fallback.is_some() && self.state == PlaybackState::DirectRetry {
            self.load_fallback()
        } else {
            self.state = PlaybackState::Failed;
            PlaybackAction::Fail
        }
    }

    pub fn resolved_retry(&mut self, media: &ResolvedMedia) -> PlaybackAction {
        self.remember_fallback(media);
        if let Some(url) = media
            .direct_url
            .as_deref()
            .filter(|url| is_trusted_media_url(url))
        {
            self.state = PlaybackState::DirectRetry;
            return PlaybackAction::Load {
                url: url.to_owned(),
                user_agent: media.user_agent.clone(),
                fallback: false,
            };
        }
        if self.fallback.is_some() {
            return self.load_fallback();
        }
        self.state = PlaybackState::Failed;
        PlaybackAction::Fail
    }

    fn remember_fallback(&mut self, media: &ResolvedMedia) {
        if let Some(url) = media
            .fallback_url
            .as_deref()
            .filter(|url| is_trusted_media_url(url))
        {
            self.fallback = Some((url.to_owned(), media.user_agent.clone()));
        }
    }

    fn load_fallback(&mut self) -> PlaybackAction {
        let Some((url, user_agent)) = &self.fallback else {
            self.state = PlaybackState::Failed;
            return PlaybackAction::Fail;
        };
        self.state = PlaybackState::Fallback;
        PlaybackAction::Load {
            url: url.clone(),
            user_agent: user_agent.clone(),
            fallback: true,
        }
    }
}

pub struct PlaybackLoad<'a> {
    pub url: &'a str,
    pub user_agent: &'a str,
    pub fallback: bool,
    pub generation: u64,
    pub playlist_item_id: Option<&'a str>,
    pub basic_auth: Option<(&'a str, &'a str)>,
    /// External subtitles already downloaded into the controlled temp store.
    /// The player attaches them after the media finishes loading; these are
    /// local-only and never broadcast.
    pub subtitles: Vec<crate::subtitles::PreparedSubtitle>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlayerControlError {
    Unsupported,
    Rejected,
}

/// Projects a room snapshot onto the server clock so all native correction paths
/// use the same authoritative target while playback is running.
pub fn authoritative_position(snapshot: &RoomSnapshot, estimated_server_time_ms: i64) -> f64 {
    let elapsed = if snapshot.paused {
        0.0
    } else {
        (estimated_server_time_ms.saturating_sub(snapshot.server_time_ms) as f64 / 1000.0)
            * snapshot.playback_rate
    };
    (snapshot.position_seconds + elapsed).max(0.0)
}

pub trait PlayerEngine {
    fn load(&mut self, request: PlaybackLoad<'_>);
    fn apply_shared_state(
        &mut self,
        snapshot: &crate::contracts::RoomSnapshot,
        estimated_server_time_ms: i64,
    );
    fn set_volume(&mut self, _volume: f64) {}
    fn set_local_paused(&mut self, _paused: bool) -> Result<(), PlayerControlError> {
        Err(PlayerControlError::Unsupported)
    }
    fn seek_local_absolute(&mut self, _position_seconds: f64) -> Result<(), PlayerControlError> {
        Err(PlayerControlError::Unsupported)
    }
    fn select_audio_track(&mut self, _track_id: i64) -> Result<(), PlayerControlError> {
        Err(PlayerControlError::Unsupported)
    }
    fn select_subtitle_track(&mut self, _track_id: Option<i64>) -> Result<(), PlayerControlError> {
        Err(PlayerControlError::Unsupported)
    }
    fn state(&self) -> PlayerState;
    fn capability(&self) -> NativeCapabilityReport {
        NativeCapabilityReport::default()
    }
    fn drain_events(&mut self) -> Vec<PlayerEvent>;
    fn dispose(&mut self);
    /// Applies whitelisted player preferences to the live player. Returns the
    /// names of properties that failed to apply so the UI can surface them;
    /// persisted values remain in effect for the next application.
    fn apply_preferences(&mut self, _prefs: &crate::config::PlayerPreferences) -> Vec<String> {
        Vec::new()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlayerEvent {
    Loaded {
        generation: u64,
    },
    Ended {
        generation: u64,
        reason: PlayerEndReason,
        playlist_item_id: Option<String>,
    },
    Error {
        generation: u64,
        retryable: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlayerEndReason {
    Eof,
    Stopped,
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn media(direct: Option<&str>, fallback: Option<&str>) -> ResolvedMedia {
        ResolvedMedia {
            direct_url: direct.map(String::from),
            fallback_url: fallback.map(String::from),
            user_agent: "pan.baidu.com".into(),
        }
    }
    #[test]
    fn retries_direct_once_then_falls_back() {
        let mut p = PlaybackPolicy::new();
        p.begin(7);
        assert!(matches!(
            p.resolved(&media(Some("https://direct"), Some("https://fallback"))),
            PlaybackAction::Load {
                fallback: false,
                ..
            }
        ));
        assert_eq!(p.player_error(), PlaybackAction::ResolveAgain);
        assert!(matches!(
            p.resolved_retry(&media(Some("https://direct-2"), Some("https://fallback"))),
            PlaybackAction::Load {
                fallback: false,
                ..
            }
        ));
        assert!(matches!(
            p.player_error(),
            PlaybackAction::Load { fallback: true, .. }
        ));
        assert_eq!(p.state, PlaybackState::Fallback);
    }

    #[test]
    fn only_https_or_loopback_http_urls_are_trusted() {
        assert!(is_trusted_media_url("https://cdn.example/video.m3u8"));
        assert!(is_trusted_media_url("https://127.0.0.1:8080/p/video"));
        assert!(is_trusted_media_url("http://127.0.0.1:8080/p/video"));
        assert!(is_trusted_media_url("http://localhost:8080/p/video"));
        assert!(is_trusted_media_url("http://[::1]:8080/p/video"));
        for untrusted in [
            "http://cdn.example/video.m3u8",
            "file:///C:/video.mkv",
            "ftp://cdn.example/video.mkv",
            "data:text/plain,video",
            "https://user:pass@cdn.example/video",
            "not a url",
            "",
        ] {
            assert!(!is_trusted_media_url(untrusted), "trusted {untrusted}");
        }
    }

    #[test]
    fn untrusted_direct_urls_are_dropped_in_favor_of_the_fallback() {
        let mut p = PlaybackPolicy::new();
        p.begin(3);
        assert!(matches!(
            p.resolved(&media(Some("file:///etc/passwd"), Some("https://fallback"))),
            PlaybackAction::Load { fallback: true, .. }
        ));
    }

    #[test]
    fn untrusted_fallback_urls_are_never_remembered() {
        let mut p = PlaybackPolicy::new();
        p.begin(3);
        assert_eq!(
            p.resolved(&media(
                Some("http://lan-server/video"),
                Some("file:///etc/passwd")
            )),
            PlaybackAction::Fail
        );
        // A later player error must not resurrect the untrusted fallback.
        assert_eq!(p.player_error(), PlaybackAction::Fail);
    }

    #[test]
    fn untrusted_direct_with_no_fallback_fails_closed() {
        let mut p = PlaybackPolicy::new();
        p.begin(3);
        assert_eq!(
            p.resolved(&media(Some("ftp://cdn.example/video"), None)),
            PlaybackAction::Fail
        );
    }
}
