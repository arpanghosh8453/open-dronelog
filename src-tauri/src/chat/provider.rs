//! Provider adapters normalize Responses and Chat Completions into shared events.
use super::types::{ChatEvent, ConnectionSettings, ModelInfo};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

pub fn normalize(mut c: ConnectionSettings) -> Result<ConnectionSettings, String> {
    if c.provider != "openai" && c.provider != "custom" {
        return Err("Select OpenAI or a custom provider".into());
    }
    if c.provider == "openai" {
        c.base_url = "https://api.openai.com/v1".into();
        c.api_format = "responses".into();
    }
    c.base_url = c.base_url.trim().trim_end_matches('/').to_string();
    let url = reqwest::Url::parse(&c.base_url).map_err(|_| "Enter a valid provider base URL")?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(
            "Provider URL must be HTTP(S), without credentials, query parameters or fragments"
                .into(),
        );
    }
    if !["responses", "chat_completions"].contains(&c.api_format.as_str()) {
        return Err("Unsupported provider API format".into());
    }
    if c.model.len() > 160 || c.model.contains(['\r', '\n']) {
        return Err("Invalid model ID".into());
    }
    if c.api_key
        .as_ref()
        .is_some_and(|s| s.len() > 4096 || s.contains(['\r', '\n']))
    {
        return Err("Invalid API key".into());
    }
    if let Some(pricing) = &c.pricing {
        pricing.validate()?;
    }
    Ok(c)
}
fn private_allowed() -> bool {
    cfg!(test)
        || cfg!(not(feature = "web"))
        || std::env::var("CHAT_ALLOW_PRIVATE_PROVIDERS").is_ok_and(|s| s == "true" || s == "1")
}
fn prohibited(ip: IpAddr, allow_private: bool) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_link_local()
                || v.is_multicast()
                || v.is_unspecified()
                || v.is_broadcast()
                || (!allow_private
                    && (v.is_private()
                        || v.is_loopback()
                        || v.octets()[0] == 0
                        || v.octets()[0] >= 240
                        || (v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                prohibited(IpAddr::V4(v4), allow_private)
            } else {
                v.is_multicast()
                    || v.is_unspecified()
                    || (v.segments()[0] & 0xffc0) == 0xfe80
                    || (!allow_private && (v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00))
            }
        }
    }
}
pub async fn client(c: &ConnectionSettings) -> Result<reqwest::Client, String> {
    let url = reqwest::Url::parse(&c.base_url).map_err(|_| "Invalid provider URL")?;
    let host = url
        .host_str()
        .ok_or("Provider host missing")?
        .trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or("Invalid provider port")?;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(8),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "Provider DNS lookup timed out")?
    .map_err(|_| "Provider host could not be resolved")?
    .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|a| prohibited(a.ip(), private_allowed()))
    {
        return Err("Provider address is not allowed. For a trusted local model in Docker, the operator can enable CHAT_ALLOW_PRIVATE_PROVIDERS=true. Metadata/link-local addresses are always blocked.".into());
    }
    if url.scheme() == "http"
        && addresses.iter().any(|a| {
            !a.ip().is_loopback()
                && !match a.ip() {
                    IpAddr::V4(v) => v.is_private(),
                    IpAddr::V6(v) => (v.segments()[0] & 0xfe00) == 0xfc00,
                }
        })
    {
        return Err("Remote providers require HTTPS".into());
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| "Cannot initialize provider client".into())
}
fn auth(request: reqwest::RequestBuilder, c: &ConnectionSettings) -> reqwest::RequestBuilder {
    if let Some(key) = c.api_key.as_ref().filter(|s| !s.is_empty()) {
        request.bearer_auth(key)
    } else {
        request
    }
}
pub async fn checked(mut response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > 16_384 {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    // Only classify known conditions; never reflect provider messages in user-visible errors.
    if status.as_u16() == 429
        && body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("free-models-per-day"))
    {
        return Err("OpenRouter's daily free-model request quota is exhausted. Try again after the quota resets or select a model covered by your plan. This is a provider quota limit, not a database query failure.".into());
    }
    Err(match status.as_u16(){401|403=>"Provider rejected the credentials or access to this model. Check the API key and model permissions.".into(),429=>"Provider rate limit or quota reached. Check billing/quota and try again later.".into(),400|404|422=>"Provider rejected the model, API format, or tools. Check the model ID, base URL and API format.".into(),_=>format!("Provider request failed (HTTP {}). Try again later.",status.as_u16())})
}
async fn bounded_json(response: reqwest::Response) -> Result<Value, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Provider connection interrupted")?;
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err("Provider response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON".into())
}
pub async fn models(c: &ConnectionSettings) -> Result<Vec<ModelInfo>, String> {
    let c = normalize(c.clone())?;
    let http = client(&c).await?;
    let r = auth(http.get(format!("{}/models", c.base_url)), &c)
        .send()
        .await
        .map_err(|_| "Could not connect to the provider. Check the URL and network access.")?;
    let v = bounded_json(checked(r).await?).await?;
    let list = v["data"].as_array().ok_or(
        "Provider does not expose an OpenAI-compatible model list. Enter a model ID manually.",
    )?;
    let mut models: Vec<_> = list
        .iter()
        .filter_map(|m| m["id"].as_str())
        .filter(|id| id.len() <= 160)
        .take(1000)
        .map(|id| ModelInfo { id: id.into() })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}
#[derive(Default)]
struct ToolDelta {
    id: String,
    name: String,
    args: String,
}
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: String,
}
pub struct ModelReply {
    pub continuation: Vec<Value>,
    pub tools: Vec<ToolCall>,
    pub usage: Value,
    pub malformed_tool_text: bool,
    pub resolved_model: Option<String>,
}

#[derive(Default)]
struct SseDecoder {
    buffer: String,
    data: Vec<String>,
}
impl SseDecoder {
    fn push(&mut self, s: &str) -> Result<Vec<String>, String> {
        self.buffer.push_str(s);
        if self.buffer.len() > 2_000_000 {
            return Err("Provider event exceeded the size limit".into());
        }
        let mut events = Vec::new();
        while let Some(n) = self.buffer.find('\n') {
            let line = self.buffer[..n].trim_end_matches('\r').to_string();
            self.buffer.drain(..=n);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_string());
                if self.data.iter().map(String::len).sum::<usize>() > 2_000_000 {
                    return Err("Provider event exceeded the size limit".into());
                }
            }
        }
        Ok(events)
    }
}
/// Hold possible protocol prefixes across SSE chunks so malformed calls never reach the UI.
#[derive(Default)]
struct TextGuard {
    pending: String,
    malformed: bool,
}
impl TextGuard {
    const MARKERS: &'static [&'static str] = &[
        "<tool_call",
        "<function=",
        "<parameter=",
        "<|tool_call",
        "[tool_calls]",
        "<function_call",
        "<invoke",
        "<｜tool▁calls",
        "query_flights(",
        "search_flight_messages(",
        "describe_data(",
        "find_features(",
        "compare_cohorts(",
        "analyze_flight_timeline(",
        "detect_anomalies(",
        "analyze_battery_health(",
        "assess_data_quality(",
        "explain_metric(",
        "build_investigation_report(",
    ];
    fn push(&mut self, delta: &str) -> String {
        if self.malformed {
            return String::new();
        }
        self.pending.push_str(delta);
        let lower = self.pending.to_ascii_lowercase();
        if let Some(index) = Self::MARKERS
            .iter()
            .filter_map(|marker| lower.find(marker))
            .min()
        {
            // ASCII case folding preserves UTF-8 byte offsets; marker boundaries remain valid UTF-8 boundaries.
            let safe = self.pending[..index].to_string();
            self.pending.clear();
            self.malformed = true;
            return safe;
        }
        let hold = self
            .pending
            .char_indices()
            .rev()
            .take(
                Self::MARKERS
                    .iter()
                    .map(|marker| marker.chars().count())
                    .max()
                    .unwrap_or(0),
            )
            .filter_map(|(index, _)| {
                let suffix = self.pending[index..].to_ascii_lowercase();
                Self::MARKERS
                    .iter()
                    .any(|marker| marker.starts_with(&suffix))
                    .then_some(index)
            })
            .min()
            .unwrap_or(self.pending.len());
        let safe = self.pending[..hold].to_string();
        self.pending.drain(..hold);
        safe
    }
    fn finish(&mut self) -> String {
        if self.malformed {
            return String::new();
        }
        // An incomplete protocol prefix is malformed too, rather than answer text.
        if self.pending.starts_with('<') || self.pending.starts_with('[') {
            self.malformed = true;
            self.pending.clear();
        }
        std::mem::take(&mut self.pending)
    }
}

fn require_tool_support(c: &ConnectionSettings, body: &mut Value) {
    if body.get("tools").is_some()
        && reqwest::Url::parse(&c.base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .as_deref()
            == Some("openrouter.ai")
    {
        body["provider"] = json!({"require_parameters":true});
    }
}

pub async fn generate(
    c: &ConnectionSettings,
    history: &[Value],
    system: &str,
    tools: &[Value],
    mut emit: impl FnMut(ChatEvent),
) -> Result<ModelReply, String> {
    let http = client(c).await?;
    let responses = c.api_format == "responses";
    let mut messages =
        vec![json!({"role":if responses{"developer"}else{"system"},"content":system})];
    messages.extend_from_slice(history);
    let mut body = if responses {
        json!({"model":c.model,"input":messages,"tools":tools.iter().map(|t|{let mut t=t.clone();t["type"]=json!("function");t["strict"]=json!(false);t}).collect::<Vec<_>>(),"stream":true,"store":false,"include":["reasoning.encrypted_content"],"max_output_tokens":8192})
    } else {
        json!({"model":c.model,"messages":messages,"tools":tools.iter().map(|t|json!({"type":"function","function":t})).collect::<Vec<_>>(),"stream":true})
    };
    if tools.is_empty() {
        body.as_object_mut().unwrap().remove("tools");
    }
    if responses && c.provider != "openai" {
        body.as_object_mut().unwrap().remove("include");
    }
    if !responses {
        body["stream_options"] = json!({"include_usage":true});
        body[if c.provider == "openai" {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }] = json!(8192);
    }
    require_tool_support(c, &mut body);
    let response = auth(
        http.post(format!(
            "{}/{}",
            c.base_url,
            if responses {
                "responses"
            } else {
                "chat/completions"
            }
        )),
        c,
    )
    .json(&body)
    .send()
    .await
    .map_err(|_| "Provider request failed or timed out. Check the connection and retry.")?;
    let response = checked(response).await?;
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"))
    {
        return Err("Provider did not return an event stream. This integration requires streaming tool calls.".into());
    }
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut utf8 = Vec::new();
    let mut received = 0;
    let mut text = String::new();
    let mut text_guard = TextGuard::default();
    let mut resolved_model = None;
    let mut reasoning_details = Vec::new();
    let mut reasoning = String::new();
    let mut pending: BTreeMap<usize, ToolDelta> = BTreeMap::new();
    let mut continuation = Vec::new();
    let mut usage = Value::Null;
    let mut complete = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Provider stream interrupted. Retry the message.")?;
        received += chunk.len();
        if received > 8_000_000 {
            return Err("Provider output limit exceeded".into());
        }
        utf8.extend_from_slice(&chunk);
        let valid = match std::str::from_utf8(&utf8) {
            Ok(s) => s.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => return Err("Invalid UTF-8 from provider".into()),
        };
        let s = std::str::from_utf8(&utf8[..valid])
            .map_err(|_| "Invalid provider encoding")?
            .to_string();
        utf8.drain(..valid);
        for data in decoder.push(&s)? {
            if data == "[DONE]" {
                continue;
            }
            let v: Value = serde_json::from_str(&data)
                .map_err(|_| "Provider returned an invalid stream event")?;
            if resolved_model.is_none() {
                resolved_model = v["model"].as_str().map(String::from);
            }
            if v.get("error").is_some()
                || matches!(
                    v["type"].as_str(),
                    Some("error" | "response.failed" | "response.incomplete")
                )
            {
                return Err("Provider could not complete the response. Try a smaller question or another model.".into());
            }
            if responses {
                if v["type"] == "response.output_text.delta"
                    || v["type"] == "response.refusal.delta"
                {
                    if let Some(delta) = v["delta"].as_str() {
                        text.push_str(delta);
                        let safe = text_guard.push(delta);
                        if !safe.is_empty() {
                            emit(ChatEvent::TextDelta { text: safe });
                        }
                    }
                }
                if v["type"] == "response.completed" {
                    let r = &v["response"];
                    if resolved_model.is_none() {
                        resolved_model = r["model"].as_str().map(String::from);
                    }
                    if r["status"].as_str().is_some_and(|s| s != "completed") {
                        return Err("Provider response was incomplete".into());
                    }
                    continuation = r["output"].as_array().cloned().unwrap_or_default();
                    usage = r["usage"].clone();
                    if usage.is_object() && r["service_tier"].is_string() {
                        usage["service_tier"] = r["service_tier"].clone();
                    }
                    complete = true;
                }
            } else {
                if !v["usage"].is_null() {
                    usage = v["usage"].clone();
                }
                if let Some(choice) = v["choices"].as_array().and_then(|a| a.first()) {
                    let delta = &choice["delta"];
                    // Round-trip opaque provider context in order; never emit it as visible text.
                    if let Some(details) = delta["reasoning_details"].as_array() {
                        reasoning_details.extend(details.iter().cloned());
                    }
                    if let Some(fragment) = delta["reasoning"]
                        .as_str()
                        .or_else(|| delta["reasoning_content"].as_str())
                    {
                        reasoning.push_str(fragment);
                    }
                    if let Some(s) = delta["content"].as_str() {
                        text.push_str(s);
                        let safe = text_guard.push(s);
                        if !safe.is_empty() {
                            emit(ChatEvent::TextDelta { text: safe });
                        }
                    }
                    if let Some(s) = delta["refusal"].as_str() {
                        text.push_str(s);
                        let safe = text_guard.push(s);
                        if !safe.is_empty() {
                            emit(ChatEvent::TextDelta { text: safe });
                        }
                    }
                    if let Some(calls) = delta["tool_calls"].as_array() {
                        for call in calls {
                            let index = call["index"]
                                .as_u64()
                                .ok_or("Provider tool-call index missing")?
                                as usize;
                            if index > 15 {
                                return Err("Too many tool calls".into());
                            }
                            let t = pending.entry(index).or_default();
                            if let Some(s) = call["id"].as_str() {
                                t.id.push_str(s);
                            }
                            if let Some(s) = call["function"]["name"].as_str() {
                                t.name.push_str(s);
                            }
                            if let Some(s) = call["function"]["arguments"].as_str() {
                                t.args.push_str(s);
                            }
                            if t.args.len() > 48_000 || t.name.len() > 100 || t.id.len() > 256 {
                                return Err("Tool call exceeded input limits".into());
                            }
                        }
                    }
                    if let Some(reason) = choice["finish_reason"].as_str() {
                        if reason == "length" {
                            return Err("The model reached its response token limit before finishing. Try another model or a smaller question.".into());
                        }
                        if !["stop", "tool_calls"].contains(&reason) {
                            return Err("Model response was cut short. Try a smaller question or another model.".into());
                        }
                        complete = true;
                    }
                }
            }
        }
    }
    if !complete {
        return Err("Provider disconnected before completing the response".into());
    }
    let tail = text_guard.finish();
    if !tail.is_empty() {
        emit(ChatEvent::TextDelta { text: tail });
    }
    let malformed_tool_text = text_guard.malformed;
    if malformed_tool_text {
        text = "The model did not return a valid structured tool invocation.".into();
        // Preserve valid native calls/reasoning, but never feed malformed protocol text back.
        if responses {
            for item in &mut continuation {
                if item["type"] == "message" {
                    item["content"] = json!([{"type":"output_text","text":text}]);
                }
            }
        }
    }
    let calls: Vec<ToolCall> = if responses {
        continuation
            .iter()
            .filter(|v| v["type"] == "function_call")
            .map(|v| ToolCall {
                id: v["call_id"].as_str().unwrap_or_default().into(),
                name: v["name"].as_str().unwrap_or_default().into(),
                args: v["arguments"].as_str().unwrap_or_default().into(),
            })
            .collect()
    } else {
        pending
            .into_values()
            .map(|v| ToolCall {
                id: v.id,
                name: v.name,
                args: v.args,
            })
            .collect()
    };
    if calls.len() > 16
        || calls
            .iter()
            .any(|c| c.id.is_empty() || c.args.len() > 48_000)
    {
        return Err("Invalid or oversized provider tool call".into());
    }
    if !responses {
        let mut msg =
            json!({"role":"assistant","content":if text.is_empty(){Value::Null}else{json!(text)}});
        if !reasoning_details.is_empty() {
            msg["reasoning_details"] = json!(reasoning_details);
        } else if !reasoning.is_empty() {
            msg["reasoning"] = json!(reasoning);
        }
        if !calls.is_empty() {
            msg["tool_calls"]=json!(calls.iter().map(|t|json!({"id":t.id,"type":"function","function":{"name":t.name,"arguments":t.args}})).collect::<Vec<_>>());
        }
        continuation.push(msg);
    }
    Ok(ModelReply {
        continuation,
        tools: calls,
        usage,
        malformed_tool_text,
        resolved_model,
    })
}
/// Keep a verified free tool-calling model stable only for the current turn.
/// Never replace an explicitly chosen model or turn a free route into a paid request.
pub(super) fn free_continuation_model(
    c: &ConnectionSettings,
    reply: &ModelReply,
) -> Option<String> {
    if c.model != "openrouter/free"
        || reply.tools.is_empty()
        || reply.malformed_tool_text
        || reqwest::Url::parse(&c.base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .as_deref()
            != Some("openrouter.ai")
    {
        return None;
    }
    reply
        .resolved_model
        .as_ref()
        .filter(|model| model.ends_with(":free"))
        .cloned()
}

pub(super) fn free_router_capacity_fallback(
    original: &ConnectionSettings,
    active: &ConnectionSettings,
    error: &str,
    used: bool,
) -> bool {
    !used
        && original.model == "openrouter/free"
        && active.model != original.model
        && active.model.ends_with(":free")
        && original.base_url == active.base_url
        && reqwest::Url::parse(&original.base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .as_deref()
            == Some("openrouter.ai")
        && matches!(
            error,
            "Provider rate limit or quota reached. Check billing/quota and try again later."
                | "Provider request failed (HTTP 503). Try again later."
        )
}

pub async fn test(c: &ConnectionSettings) -> Result<Value, String> {
    let c = normalize(c.clone())?;
    if c.model.trim().is_empty() {
        return Err("Select a model first".into());
    }
    let tool = json!({"name":"connection_check","description":"Verify tool support. Call with value=ready.","parameters":{"type":"object","properties":{"value":{"type":"string","enum":["ready"]}},"required":["value"],"additionalProperties":false}});
    let reply=generate(&c,&[json!({"role":"user","content":"Call connection_check with value ready. Do not answer in text."})],"You are testing tool calling with synthetic data only.",&[tool],|_|{}).await?;
    if !reply.tools.iter().any(|t| {
        t.name == "connection_check"
            && serde_json::from_str::<Value>(&t.args).is_ok_and(|v| v["value"] == "ready")
    }) {
        return Err(
            "This model did not produce the required tool call. Try another model or API format."
                .into(),
        );
    }
    Ok(json!({"ok":true,"message":"Connection and tool calling verified","usage":reply.usage}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_markup_is_suppressed_at_every_stream_split() {
        for marker in [
            "<tool_call>",
            "<FUNCTION=query_flights>",
            "<parameter=source>",
            "[TOOL_CALLS]",
            "<｜tool▁calls▁begin｜>",
            "query_flights({",
            "search_flight_messages({",
        ] {
            let raw = format!("Überprüfung: {marker}secret protocol payload");
            for split in raw.char_indices().map(|(i, _)| i) {
                let mut guard = TextGuard::default();
                let output = format!(
                    "{}{}{}",
                    guard.push(&raw[..split]),
                    guard.push(&raw[split..]),
                    guard.finish()
                );
                assert_eq!(output, "Überprüfung: ", "{marker} at {split}");
                assert!(guard.malformed);
            }
        }
        for raw in [
            "Temperature < 50 °C. [View flight](flight:12)",
            "日本語の回答。",
            "A normal answer with **bold** text.",
        ] {
            let mut guard = TextGuard::default();
            let mut output = String::new();
            for ch in raw.chars() {
                output.push_str(&guard.push(&ch.to_string()));
            }
            output.push_str(&guard.finish());
            assert_eq!(output, raw);
            assert!(!guard.malformed);
        }
    }
    #[test]
    fn free_router_pinning_requires_a_native_call_and_a_free_resolved_model() {
        let mut c = ConnectionSettings {
            provider: "custom".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            model: "openrouter/free".into(),
            ..Default::default()
        };
        let mut reply = ModelReply {
            continuation: vec![],
            tools: vec![ToolCall {
                id: "one".into(),
                name: "describe_data".into(),
                args: "{}".into(),
            }],
            usage: Value::Null,
            malformed_tool_text: false,
            resolved_model: Some("vendor/model:free".into()),
        };
        assert_eq!(
            free_continuation_model(&c, &reply).as_deref(),
            Some("vendor/model:free")
        );
        reply.resolved_model = Some("vendor/paid-model".into());
        assert!(free_continuation_model(&c, &reply).is_none());
        reply.resolved_model = Some("vendor/model:free".into());
        reply.malformed_tool_text = true;
        assert!(free_continuation_model(&c, &reply).is_none());
        reply.malformed_tool_text = false;
        c.model = "user-selected:free".into();
        assert!(free_continuation_model(&c, &reply).is_none());
        c.model = "openrouter/free".into();
        c.base_url = "https://another.example/v1".into();
        assert!(free_continuation_model(&c, &reply).is_none());
    }
    #[test]
    fn native_tool_requirements_are_only_sent_to_openrouter() {
        let mut c = ConnectionSettings {
            provider: "custom".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            ..Default::default()
        };
        let mut body = json!({"tools":[{"type":"function"}]});
        require_tool_support(&c, &mut body);
        assert_eq!(body["provider"]["require_parameters"], true);
        let mut final_answer = json!({"model":"openrouter/free"});
        require_tool_support(&c, &mut final_answer);
        assert!(final_answer.get("provider").is_none());
        for host in [
            "https://another.example/v1",
            "https://openrouter.ai.example/v1",
        ] {
            c.base_url = host.into();
            let mut body = json!({"tools":[{"type":"function"}]});
            require_tool_support(&c, &mut body);
            assert!(body.get("provider").is_none());
        }
    }
    #[test]
    fn capacity_fallback_is_once_only_and_never_retries_daily_quota_or_paid_models() {
        let original = ConnectionSettings {
            provider: "custom".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            model: "openrouter/free".into(),
            ..Default::default()
        };
        let mut active = original.clone();
        active.model = "vendor/model:free".into();
        let limited =
            "Provider rate limit or quota reached. Check billing/quota and try again later.";
        assert!(free_router_capacity_fallback(
            &original, &active, limited, false
        ));
        assert!(!free_router_capacity_fallback(
            &original, &active, limited, true
        ));
        assert!(!free_router_capacity_fallback(
            &original,
            &active,
            "OpenRouter's daily free-model request quota is exhausted.",
            false
        ));
        assert!(!free_router_capacity_fallback(&original,&active,"Provider rejected the model, API format, or tools. Check the model ID, base URL and API format.",false));
        active.model = "vendor/paid".into();
        assert!(!free_router_capacity_fallback(
            &original, &active, limited, false
        ));
    }
    #[test]
    fn network_policy_blocks_metadata_and_rebinding_targets() {
        for ip in [
            "169.254.169.254",
            "fe80::1",
            "::ffff:169.254.169.254",
            "0.0.0.0",
        ] {
            assert!(prohibited(ip.parse().unwrap(), true));
        }
        assert!(prohibited("127.0.0.1".parse().unwrap(), false));
        assert!(!prohibited("127.0.0.1".parse().unwrap(), true));
    }
    #[test]
    fn normalizes_openai_and_rejects_credential_urls() {
        let c = ConnectionSettings {
            provider: "openai".into(),
            base_url: "http://evil.example".into(),
            ..Default::default()
        };
        assert_eq!(normalize(c).unwrap().base_url, "https://api.openai.com/v1");
        let c = ConnectionSettings {
            provider: "custom".into(),
            base_url: "https://user:secret@example.com".into(),
            api_format: "responses".into(),
            ..Default::default()
        };
        assert!(normalize(c).is_err());
    }
    #[test]
    fn stream_decoder_handles_chunk_boundaries_and_crlf() {
        let mut d = SseDecoder::default();
        assert!(d.push("data: {\"type\":").unwrap().is_empty());
        assert_eq!(
            d.push("\"x\"}\r\n\r\ndata: [DONE]\n\n").unwrap(),
            vec!["{\"type\":\"x\"}", "[DONE]"]
        );
    }
}
