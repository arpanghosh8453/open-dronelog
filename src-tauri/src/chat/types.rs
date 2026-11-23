use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Default, Serialize)]
pub struct ConnectionSettings {
    pub provider: String,
    pub base_url: String,
    pub api_format: String,
    pub model: String,
    #[serde(default)]
    pub pricing: Option<super::pricing::TokenPricing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}
// Accept and discard the retired setting when reading existing encrypted vaults.
// It is absent from live settings, API responses, new writes and provider requests.
impl<'de> Deserialize<'de> for ConnectionSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Default, Deserialize)]
        #[serde(default, deny_unknown_fields)]
        struct Stored {
            provider: String,
            base_url: String,
            api_format: String,
            model: String,
            pricing: Option<super::pricing::TokenPricing>,
            api_key: Option<String>,
            #[serde(rename = "effort")]
            _retired: Option<serde::de::IgnoredAny>,
        }
        let stored = Stored::deserialize(deserializer)?;
        Ok(Self {
            provider: stored.provider,
            base_url: stored.base_url,
            api_format: stored.api_format,
            model: stored.model,
            pricing: stored.pricing,
            api_key: stored.api_key,
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ConnectionView {
    pub provider: String,
    pub base_url: String,
    pub api_format: String,
    pub model: String,
    #[serde(default)]
    pub pricing: Option<super::pricing::TokenPricing>,
    pub has_api_key: bool,
}
impl From<&ConnectionSettings> for ConnectionView {
    fn from(c: &ConnectionSettings) -> Self {
        Self {
            provider: c.provider.clone(),
            base_url: c.base_url.clone(),
            api_format: c.api_format.clone(),
            model: c.model.clone(),
            pricing: c.pricing.clone(),
            has_api_key: c.api_key.as_ref().is_some_and(|s| !s.is_empty()),
        }
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Vault {
    pub connection: ConnectionSettings,
    pub conversations: Vec<Conversation>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub history: Vec<Value>,
    #[serde(default)]
    pub api_format: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub results: Vec<super::analytics::QueryResult>,
    #[serde(default)]
    pub usage: Option<Value>,
}
#[derive(Serialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}
impl From<&Conversation> for ConversationSummary {
    fn from(c: &Conversation) -> Self {
        Self {
            id: c.id.clone(),
            title: c.title.clone(),
            updated_at: c.updated_at.clone(),
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SendRequest {
    pub request_id: String,
    pub conversation_id: Option<String>,
    pub message: String,
    pub timezone: String,
    pub unit_system: String,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Conversation {
        id: String,
        title: String,
    },
    TextDelta {
        text: String,
    },
    ToolStarted {
        name: String,
    },
    Result {
        result: super::analytics::QueryResult,
    },
    Usage {
        usage: Value,
    },
    Completed,
    Error {
        message: String,
    },
}
#[derive(Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
}
