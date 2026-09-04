use reqwest::Url;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::tauri_api::TauriDesktopState;

pub const DESKTOP_LAUNCH_EVENT: &str = "desktop://launch";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLaunch {
    pub room_id: String,
}

/// Accepts only the public room identifier. Secrets, paths and URL metadata are rejected.
pub fn parse_room_deep_link(raw: &str) -> Option<DesktopLaunch> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "watchparty"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().is_empty()
    {
        return None;
    }

    let room_id = url.host_str()?;
    let mut characters = room_id.chars();
    if !(3..=81).contains(&room_id.len())
        || !characters
            .next()
            .is_some_and(|value| value.is_ascii_alphabetic())
        || !characters.all(|value| value.is_ascii_alphanumeric() || value == '-')
    {
        return None;
    }

    Some(DesktopLaunch {
        room_id: room_id.to_owned(),
    })
}

pub fn handle_open_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<Url>) {
    let Some(launch) = (urls.len() == 1)
        .then(|| parse_room_deep_link(urls[0].as_str()))
        .flatten()
    else {
        return;
    };

    // Record before emitting: the renderer replays this via `currentDesktopLaunch`
    // because cold-start deep links fire before its listeners exist.
    if let Some(state) = app.try_state::<TauriDesktopState>() {
        state.record_launch(launch.clone());
    }
    let _ = app.emit(DESKTOP_LAUNCH_EVENT, &launch);
    focus_main_window(app);
}

pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_room_id_deep_links() {
        assert_eq!(
            parse_room_deep_link("watchparty://room-46d67a7cf5a6700b"),
            Some(DesktopLaunch {
                room_id: "room-46d67a7cf5a6700b".into()
            })
        );

        for invalid in [
            "https://room-46d67a7cf5a6700b",
            "watchparty://ab",
            "watchparty://1-room",
            "watchparty://room/id",
            "watchparty://room/?ticket=secret",
            "watchparty://room/#secret",
            "watchparty://user:secret@room",
            "watchparty://room:8080",
            "watchparty://room%2Fother",
        ] {
            assert_eq!(parse_room_deep_link(invalid), None, "accepted {invalid}");
        }
    }

    #[test]
    fn launch_payload_contains_only_the_room_id() {
        let value = serde_json::to_value(
            parse_room_deep_link("watchparty://room-abc").expect("valid deep link"),
        )
        .expect("serialize launch payload");
        assert_eq!(value, serde_json::json!({ "roomId": "room-abc" }));
    }
}
