use crate::contracts::{CommandAck, DesktopCommand};

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
