use crate::{
    contracts::{CommandAck, DesktopCommand, MediaSource, RoomMember, RoomSnapshot},
    transport::{Handoff, ResolvedMedia, RoomTransport, TransportError},
};
use reqwest::blocking::{Client, RequestBuilder};
use serde::de::DeserializeOwned;

fn command_body(command: &DesktopCommand, expected_revision: u64) -> serde_json::Value {
    let mut value = serde_json::to_value(command).expect("desktop commands are serializable");
    value
        .as_object_mut()
        .expect("desktop command must be an object")
        .insert(
            "expectedRevision".into(),
            serde_json::json!(expected_revision),
        );
    value
}

/// Site-level Basic Auth stays in the native process and is never serialized.
pub struct SiteBasicAuth {
    username: String,
    password: String,
}

impl SiteBasicAuth {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            password: password.into(),
        }
    }
}

impl Drop for SiteBasicAuth {
    fn drop(&mut self) {
        self.username.clear();
        self.password.clear();
    }
}

/// Real HTTP implementation for the Gate 1 desktop protocol. Sensitive values stay in this type.
pub struct DesktopHttpTransport {
    base_url: String,
    client: Client,
    site_basic_auth: Option<SiteBasicAuth>,
}

impl DesktopHttpTransport {
    pub fn new(base_url: impl Into<String>) -> Result<Self, TransportError> {
        Self::with_auth(base_url, None)
    }

    pub fn with_site_basic_auth(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Result<Self, TransportError> {
        Self::with_auth(base_url, Some(SiteBasicAuth::new(username, password)))
    }

    fn with_auth(
        base_url: impl Into<String>,
        site_basic_auth: Option<SiteBasicAuth>,
    ) -> Result<Self, TransportError> {
        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').into(),
            client: Client::builder()
                .build()
                .map_err(|error| TransportError::Network(error.to_string()))?,
            site_basic_auth,
        })
    }

    pub fn clear_site_basic_auth(&mut self) {
        self.site_basic_auth = None;
    }

    pub fn has_site_basic_auth(&self) -> bool {
        self.site_basic_auth.is_some()
    }

    fn apply_site_auth(&self, builder: RequestBuilder) -> RequestBuilder {
        match &self.site_basic_auth {
            Some(auth) => builder.basic_auth(&auth.username, Some(&auth.password)),
            None => builder,
        }
    }

    fn request<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder,
    ) -> Result<Option<T>, TransportError> {
        let response = builder
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TransportError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        if !status.is_success() {
            return Err(TransportError::Http(
                status.as_u16(),
                response.text().unwrap_or_default(),
            ));
        }
        response
            .json()
            .map(Some)
            .map_err(|error| TransportError::Protocol(error.to_string()))
    }

    fn command_request(&self, builder: RequestBuilder) -> Result<CommandAck, TransportError> {
        let response = builder
            .send()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .map_err(|error| TransportError::Network(error.to_string()))?;
        if let Ok(ack) = serde_json::from_str::<CommandAck>(&body) {
            return Ok(ack);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TransportError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(TransportError::NotFound);
        }
        Err(TransportError::Http(status.as_u16(), body))
    }

    fn headers(&self, builder: RequestBuilder, generation: Option<u64>) -> RequestBuilder {
        let builder = self
            .apply_site_auth(builder)
            .header("X-WatchParty-Protocol", "2")
            .header("X-WatchParty-Client-Type", "desktop");
        match generation {
            Some(value) => builder.header("X-WatchParty-Session-Generation", value.to_string()),
            None => builder,
        }
    }

    fn get_with_auth(&self, path: &str, token: &str, generation: u64) -> RequestBuilder {
        self.headers(
            self.client
                .get(format!("{}{path}", self.base_url))
                .bearer_auth(token),
            Some(generation),
        )
    }
}

impl RoomTransport for DesktopHttpTransport {
    fn redeem_desktop(&mut self, ticket: &str) -> Result<Handoff, TransportError> {
        self.request(
            self.headers(
                self.client
                    .post(format!("{}/api/desktop/handoff", self.base_url))
                    .json(&serde_json::json!({ "ticket": ticket })),
                None,
            ),
        )?
        .ok_or_else(|| TransportError::Protocol("empty handoff response".into()))
    }

    fn claim_session(&mut self, room: &str, token: &str) -> Result<u64, TransportError> {
        let value: serde_json::Value = self
            .request(
                self.headers(
                    self.client
                        .post(format!(
                            "{}/api/rooms/{room}/desktop/session",
                            self.base_url
                        ))
                        .bearer_auth(token),
                    None,
                ),
            )?
            .ok_or_else(|| TransportError::Protocol("empty session response".into()))?;
        value
            .get("sessionGeneration")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| TransportError::Protocol("missing sessionGeneration".into()))
    }

    fn snapshot(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        since: Option<u64>,
    ) -> Result<Option<RoomSnapshot>, TransportError> {
        let mut request = self.get_with_auth(
            &format!("/api/rooms/{room}/desktop/snapshot"),
            token,
            generation,
        );
        if let Some(value) = since {
            request = request.query(&[("since", value)]);
        }
        self.request(request)
    }

    fn members(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
    ) -> Result<Vec<RoomMember>, TransportError> {
        self.request(self.get_with_auth(
            &format!("/api/rooms/{room}/desktop/members"),
            token,
            generation,
        ))?
        .ok_or_else(|| TransportError::Protocol("empty members response".into()))
    }

    fn command(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        command: &DesktopCommand,
        expected_revision: u64,
    ) -> Result<CommandAck, TransportError> {
        self.command_request(
            self.headers(
                self.client
                    .post(format!(
                        "{}/api/rooms/{room}/desktop/command",
                        self.base_url
                    ))
                    .bearer_auth(token)
                    .json(&command_body(command, expected_revision)),
                Some(generation),
            ),
        )
    }

    fn resolve(
        &mut self,
        room: &str,
        token: &str,
        generation: u64,
        source: &MediaSource,
    ) -> Result<ResolvedMedia, TransportError> {
        let media_id = match source {
            MediaSource::Openlist { media_id, .. } => media_id,
            _ => {
                return Err(TransportError::Protocol(
                    "desktop resolve requires an OpenList media id".into(),
                ))
            }
        };
        let value: serde_json::Value = self
            .request(
                self.headers(
                    self.client
                        .post(format!(
                            "{}/api/rooms/{room}/desktop/media/resolve",
                            self.base_url
                        ))
                        .bearer_auth(token)
                        .json(&serde_json::json!({ "mediaId": media_id })),
                    Some(generation),
                ),
            )?
            .ok_or_else(|| TransportError::Protocol("empty resolve response".into()))?;
        Ok(ResolvedMedia {
            direct_url: value
                .get("directUrl")
                .and_then(serde_json::Value::as_str)
                .map(String::from),
            fallback_url: value
                .get("fallbackUrl")
                .and_then(serde_json::Value::as_str)
                .map(String::from),
            user_agent: value
                .get("headers")
                .and_then(|headers| {
                    headers
                        .get("User-Agent")
                        .or_else(|| headers.get("user-agent"))
                })
                .and_then(serde_json::Value::as_str)
                .unwrap_or("pan.baidu.com")
                .into(),
        })
    }

    fn leave(&mut self, room: &str, token: &str, generation: u64) -> Result<(), TransportError> {
        self.request::<serde_json::Value>(
            self.headers(
                self.client
                    .delete(format!(
                        "{}/api/rooms/{room}/desktop/session",
                        self.base_url
                    ))
                    .bearer_auth(token),
                Some(generation),
            ),
        )?;
        Ok(())
    }

    fn clear_site_basic_auth(&mut self) {
        self.clear_site_basic_auth();
    }
}
