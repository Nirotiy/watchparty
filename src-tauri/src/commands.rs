use crate::contracts::{CommandAck, DesktopCommand};

/// Stable Tauri-facing command names. The runtime wiring is intentionally deferred to Gate 4.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TauriCommand {
    StartDesktopSession,
    ExecuteRoomCommand,
    SetLocalPlayerPreference,
    StopDesktopSession,
}

pub const DESKTOP_STATE_EVENT: &str = "desktop://state";

pub fn validate_command(command: &DesktopCommand) -> Result<(), String> {
    match command {
        DesktopCommand::Play | DesktopCommand::Pause => Ok(()),
        DesktopCommand::Seek { position_seconds }
            if position_seconds.is_finite() && *position_seconds >= 0.0 =>
        {
            Ok(())
        }
        DesktopCommand::Rate { rate } if rate.is_finite() && (0.25..=2.0).contains(rate) => Ok(()),
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
        assert!(validate_command(&DesktopCommand::Seek {
            position_seconds: 1.0
        })
        .is_ok());
        assert!(validate_command(&DesktopCommand::Seek {
            position_seconds: -1.0
        })
        .is_err());
        assert!(validate_command(&DesktopCommand::Rate { rate: 9.0 }).is_err());
    }
}
