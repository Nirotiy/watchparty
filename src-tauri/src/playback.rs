use crate::contracts::PlayerState;
use crate::transport::ResolvedMedia;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlaybackState {
    Direct,
    DirectRetry,
    Fallback,
    Failed,
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

#[derive(Clone, Debug)]
pub struct PlaybackPolicy {
    pub state: PlaybackState,
    pub generation: u64,
    pub resolve_retried: bool,
}
impl PlaybackPolicy {
    pub fn new() -> Self {
        Self {
            state: PlaybackState::Direct,
            generation: 0,
            resolve_retried: false,
        }
    }
    pub fn begin(&mut self, generation: u64) {
        self.state = PlaybackState::Direct;
        self.generation = generation;
        self.resolve_retried = false;
    }
    pub fn resolved(&mut self, media: ResolvedMedia) -> PlaybackAction {
        if let Some(url) = media.direct_url {
            self.state = PlaybackState::Direct;
            return PlaybackAction::Load {
                url,
                user_agent: media.user_agent,
                fallback: false,
            };
        }
        if let Some(url) = media.fallback_url {
            self.state = PlaybackState::Fallback;
            return PlaybackAction::Load {
                url,
                user_agent: media.user_agent,
                fallback: true,
            };
        }
        self.state = PlaybackState::Failed;
        PlaybackAction::Fail
    }
    pub fn player_error(&mut self, media: ResolvedMedia) -> PlaybackAction {
        if self.state == PlaybackState::Direct && !self.resolve_retried {
            self.resolve_retried = true;
            self.state = PlaybackState::DirectRetry;
            PlaybackAction::ResolveAgain
        } else if let Some(url) = media.fallback_url {
            self.state = PlaybackState::Fallback;
            PlaybackAction::Load {
                url,
                user_agent: media.user_agent,
                fallback: true,
            }
        } else {
            self.state = PlaybackState::Failed;
            PlaybackAction::Fail
        }
    }
}

pub trait PlayerEngine {
    fn load(&mut self, url: &str, user_agent: &str, fallback: bool, generation: u64);
    fn apply_shared_state(&mut self, snapshot: &crate::contracts::RoomSnapshot);
    fn state(&self) -> PlayerState;
    fn drain_events(&mut self) -> Vec<PlayerEvent>;
    fn dispose(&mut self);
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlayerEvent {
    Loaded { generation: u64 },
    Ended { generation: u64 },
    Error { generation: u64, retryable: bool },
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
            p.resolved(media(Some("https://direct"), Some("https://fallback"))),
            PlaybackAction::Load {
                fallback: false,
                ..
            }
        ));
        assert_eq!(
            p.player_error(media(None, Some("https://fallback"))),
            PlaybackAction::ResolveAgain
        );
        assert!(matches!(
            p.resolved(media(None, Some("https://fallback"))),
            PlaybackAction::Load { fallback: true, .. }
        ));
        assert_eq!(p.state, PlaybackState::Fallback);
    }
}
