use crate::contracts::{CommandAck, DesktopCommand, MediaSource};

/// Mirrors the server's media URL rules for user-pasted links: HTTPS only, no
/// embedded credentials, and HLS must point at a .m3u8 playlist.
fn validate_pasted_media(media: &MediaSource) -> Result<(), String> {
    match media {
        MediaSource::Openlist {
            media_id,
            title,
            container,
            ..
        } => {
            if media_id.is_empty()
                || media_id.contains('/')
                || media_id.contains('\\')
                || title.trim().is_empty()
                || !matches!(
                    container.to_lowercase().as_str(),
                    "mp4" | "webm" | "mkv" | "mov" | "m4v" | "ogv" | "m3u8"
                )
            {
                Err("unsupported OpenList media entry".into())
            } else {
                Ok(())
            }
        }
        MediaSource::Http { url, .. } => validate_http_media_url(url, false),
        MediaSource::Hls { url, .. } => validate_http_media_url(url, true),
        // YouTube is out of the desktop V1 scope.
        MediaSource::Youtube { .. } => Err("YouTube is not supported in the desktop client".into()),
    }
}

fn validate_http_media_url(value: &str, hls: bool) -> Result<(), String> {
    if value.len() > 4000 {
        return Err("media URL must not exceed 4000 characters".into());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| "invalid media URL".to_owned())?;
    if parsed.scheme() != "https" {
        return Err("media URL must use HTTPS".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("media URL must not contain credentials".into());
    }
    if hls && !parsed.path().to_lowercase().ends_with(".m3u8") {
        return Err("HLS media URL must point at a .m3u8 playlist".into());
    }
    Ok(())
}

/// Stable Tauri-facing command names. No generic invoke or player command is exposed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TauriCommand {
    StartDesktopSession,
    ExecuteRoomCommand,
    StopDesktopSession,
}

pub const DESKTOP_STATE_EVENT: &str = "desktop://state";

pub fn validate_command(command: &DesktopCommand) -> Result<(), String> {
    match command {
        DesktopCommand::Play | DesktopCommand::Pause | DesktopCommand::Resync => Ok(()),
        DesktopCommand::Seek { position_seconds }
            if position_seconds.is_finite() && *position_seconds >= 0.0 =>
        {
            Ok(())
        }
        DesktopCommand::Rate { rate } if rate.is_finite() && (0.25..=2.0).contains(rate) => Ok(()),
        DesktopCommand::Volume { volume }
            if volume.is_finite() && (0.0..=100.0).contains(volume) =>
        {
            Ok(())
        }
        DesktopCommand::SelectAudioTrack { track_id } if *track_id > 0 => Ok(()),
        DesktopCommand::SelectSubtitleTrack { track_id }
            if track_id.is_none_or(|track_id| track_id > 0) =>
        {
            Ok(())
        }
        DesktopCommand::PlayerVisibility { .. } | DesktopCommand::Fullscreen { .. } => Ok(()),
        DesktopCommand::PlaylistPlay { item_id } if !item_id.is_empty() => Ok(()),
        DesktopCommand::PlaylistNext {
            expected_current_playlist_item_id,
        } => {
            if expected_current_playlist_item_id
                .as_ref()
                .is_some_and(|id| id.is_empty())
            {
                Err("playlist item id must not be empty".into())
            } else {
                Ok(())
            }
        }
        DesktopCommand::Lock { .. } => Ok(()),
        DesktopCommand::Rename { nickname } => {
            let nickname = nickname.trim();
            if nickname.is_empty()
                || nickname.chars().count() > 48
                || nickname.contains(['\r', '\n', '\0'])
            {
                Err("nickname must be 1-48 printable characters".into())
            } else {
                Ok(())
            }
        }
        DesktopCommand::TransferOwner { target_client_id } if !target_client_id.is_empty() => {
            Ok(())
        }
        DesktopCommand::MediaSet { media } | DesktopCommand::PlaylistAdd { media } => {
            validate_pasted_media(media)
        }
        DesktopCommand::PlaylistRemove { item_id } if !item_id.is_empty() => Ok(()),
        DesktopCommand::PlaylistMove {
            item_id,
            target_index,
        } if !item_id.is_empty() && *target_index < 200 => Ok(()),
        _ => Err("invalid desktop command".into()),
    }
}

pub fn rejected_command(code: &str, message: &str) -> CommandAck {
    CommandAck {
        ok: false,
        revision: 0,
        error: Some(crate::contracts::UiError {
            code: code.into(),
            message: message.into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_commands_are_accepted() {
        assert!(validate_command(&DesktopCommand::Play).is_ok());
        assert!(validate_command(&DesktopCommand::Resync).is_ok());
        assert!(validate_command(&DesktopCommand::Seek {
            position_seconds: 1.0
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::Seek {
            position_seconds: -1.0
        })
        .is_err());
        assert!(validate_command(&DesktopCommand::Rate { rate: 9.0 }).is_err());
        assert!(validate_command(&DesktopCommand::Volume { volume: 35.0 }).is_ok());
        assert!(validate_command(&DesktopCommand::Volume { volume: 101.0 }).is_err());
        assert!(validate_command(&DesktopCommand::SelectAudioTrack { track_id: 1 }).is_ok());
        assert!(validate_command(&DesktopCommand::SelectAudioTrack { track_id: 0 }).is_err());
        assert!(validate_command(&DesktopCommand::SelectSubtitleTrack { track_id: None }).is_ok());
        assert!(validate_command(&DesktopCommand::PlaylistPlay {
            item_id: "item-1".into()
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::PlaylistPlay {
            item_id: String::new()
        })
        .is_err());
        assert!(validate_command(&DesktopCommand::Lock { locked: true }).is_ok());
        assert!(validate_command(&DesktopCommand::Rename {
            nickname: " 新昵称 ".into()
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::Rename {
            nickname: "   ".into()
        })
        .is_err());
        assert!(validate_command(&DesktopCommand::TransferOwner {
            target_client_id: "2f0d7f4e-6f2c-4a2f-9f2e-4b1c2d3e4f5a".into()
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::TransferOwner {
            target_client_id: String::new()
        })
        .is_err());
        let openlist = MediaSource::Openlist {
            media_id: "signed-id".into(),
            title: "Episode 1.mkv".into(),
            container: "mkv".into(),
            display_path: None,
        };
        assert!(validate_command(&DesktopCommand::PlaylistAdd {
            media: openlist.clone()
        })
        .is_ok());
        let https_media = MediaSource::Http {
            url: "https://example.com/video.mp4".into(),
            title: None,
        };
        assert!(validate_command(&DesktopCommand::MediaSet { media: https_media }).is_ok());
        for bad in [
            MediaSource::Http {
                url: "http://example.com/video.mp4".into(),
                title: None,
            },
            MediaSource::Http {
                url: "https://user:pass@example.com/v.mp4".into(),
                title: None,
            },
            MediaSource::Youtube {
                video_id: "dQw4w9WgXcQ".into(),
                title: None,
            },
        ] {
            assert!(validate_command(&DesktopCommand::PlaylistAdd { media: bad }).is_err());
        }
        assert!(validate_command(&DesktopCommand::PlaylistRemove {
            item_id: "item-1".into()
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::PlaylistRemove {
            item_id: String::new()
        })
        .is_err());
        assert!(validate_command(&DesktopCommand::PlaylistMove {
            item_id: "item-1".into(),
            target_index: 3
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::PlaylistMove {
            item_id: "item-1".into(),
            target_index: 500
        })
        .is_err());
    }

    #[test]
    fn command_payloads_reject_url_header_and_mpv_injection() {
        for payload in [
            r#"{"type":"play","url":"https://attacker.invalid/video"}"#,
            r#"{"type":"pause","headers":{"Authorization":"secret"}}"#,
            r#"{"type":"seek","positionSeconds":1,"mpvCommand":["quit"]}"#,
            r#"{"type":"selectAudioTrack","trackId":1,"url":"https://attacker.invalid"}"#,
            r#"{"type":"playerVisibility","visible":true,"mpvCommand":["quit"]}"#,
            r#"{"type":"resync","positionSeconds":99}"#,
        ] {
            assert!(serde_json::from_str::<DesktopCommand>(payload).is_err());
        }
    }
}
