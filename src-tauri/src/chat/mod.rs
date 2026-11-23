//! Chat orchestration over the shared chat/MCP analytics contract.
pub mod analytics;
mod features;
mod investigation;
pub mod pricing;
pub mod provider;
mod result_metadata;
pub(crate) mod scheduler;
pub mod storage;
pub mod tools;
pub mod types;
#[cfg(feature = "web")]
pub mod web;
use crate::database::Database;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::watch;
use types::*;

struct Job {
    id: String,
    cancel: watch::Sender<bool>,
}
static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn job_key(root: &Path, profile: &str) -> String {
    format!("{}\0{}", root.display(), profile)
}
struct JobGuard {
    key: String,
    id: String,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut j) = jobs().lock() {
            if j.get(&self.key).is_some_and(|v| v.id == self.id) {
                j.remove(&self.key);
            }
        }
    }
}
pub fn cancel(root: &Path, profile: &str, id: &str) -> Result<(), String> {
    if let Some(job) = jobs()
        .lock()
        .map_err(|_| "Chat runtime unavailable")?
        .get(&job_key(root, profile))
    {
        if job.id == id {
            let _ = job.cancel.send(true);
        }
    }
    Ok(())
}
pub fn cancel_profile(root: &Path, profile: &str) {
    if let Ok(j) = jobs().lock() {
        if let Some(job) = j.get(&job_key(root, profile)) {
            let _ = job.cancel.send(true);
        }
    }
}
pub fn connection(root: &Path, profile: &str) -> Result<ConnectionView, String> {
    Ok(ConnectionView::from(
        &storage::read::<Vault>(root, profile)?.connection,
    ))
}
pub fn save_connection(
    root: &Path,
    profile: &str,
    c: ConnectionSettings,
) -> Result<ConnectionView, String> {
    let c = provider::normalize(c)?;
    storage::update::<Vault, _>(root, profile, |v| {
        let mut c = c;
        if c.api_key.is_none() {
            if c.base_url != v.connection.base_url && v.connection.api_key.is_some() {
                return Err(
                    "Enter an API key for the new provider URL, or explicitly clear the key."
                        .into(),
                );
            }
            c.api_key = v.connection.api_key.clone();
        }
        v.connection = c;
        Ok(ConnectionView::from(&v.connection))
    })
}
pub fn remove_connection(root: &Path, profile: &str) -> Result<(), String> {
    storage::update::<Vault, _>(root, profile, |v| {
        v.connection = ConnectionSettings::default();
        Ok(())
    })
}
pub fn saved_connection(root: &Path, profile: &str) -> Result<ConnectionSettings, String> {
    let c = storage::read::<Vault>(root, profile)?.connection;
    provider::normalize(c)
}
pub fn list(root: &Path, profile: &str) -> Result<Vec<ConversationSummary>, String> {
    let mut threads: Vec<_> = storage::read::<Vault>(root, profile)?
        .conversations
        .iter()
        .map(ConversationSummary::from)
        .collect();
    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(threads)
}
pub fn conversation(root: &Path, profile: &str, id: &str) -> Result<Conversation, String> {
    let mut c = storage::read::<Vault>(root, profile)?
        .conversations
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("Conversation not found in this profile")?;
    c.history.clear();
    Ok(c)
}
pub fn delete(root: &Path, profile: &str, id: &str) -> Result<(), String> {
    let active = jobs().lock().map_err(|_| "Chat runtime unavailable")?;
    if active.contains_key(&job_key(root, profile)) {
        return Err("Stop the active response before deleting a conversation".into());
    }
    storage::update::<Vault, _>(root, profile, |v| {
        v.conversations.retain(|c| c.id != id);
        Ok(())
    })
}
pub struct Context {
    pub root: PathBuf,
    pub profile: String,
    pub db: Arc<Database>,
    pub authorize: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
}
// Multi-section investigations must obey the same provider-context budget as ordinary tables.
fn provider_preview(output: &Value) -> Value {
    fn trim(value: &Value, row_limit: usize) -> Value {
        let Some(object) = value.as_object() else {
            return json!({"provider_preview_only":true});
        };
        let mut map = object.clone();
        if let Some(rows) = object.get("rows").and_then(Value::as_array) {
            map.insert("total_visible_rows".into(), json!(rows.len()));
            map.insert(
                "rows".into(),
                json!(rows.iter().take(row_limit).collect::<Vec<_>>()),
            );
        }
        if let Some(ids) = object.get("row_flight_ids").and_then(Value::as_array) {
            map.insert(
                "row_flight_ids".into(),
                json!(ids.iter().take(row_limit).collect::<Vec<_>>()),
            );
        }
        if let Some(sections) = object.get("sections").and_then(Value::as_array) {
            map.insert(
                "sections".into(),
                json!(sections
                    .iter()
                    .map(|s| trim(s, row_limit))
                    .collect::<Vec<_>>()),
            );
        }
        if let Some(previous) = object.get("previous_result").filter(|v| v.is_object()) {
            map.insert("previous_result".into(), trim(previous, row_limit));
        }
        map.remove("request");
        map.insert("provider_preview_only".into(), json!(true));
        map.insert("preview_note".into(),json!("Full evidence, filters and charts are visible in the app. Only preview rows are included here; use exact aggregates for totals."));
        Value::Object(map)
    }
    for count in [12, 3, 0] {
        let preview = trim(output, count);
        if serde_json::to_vec(&preview).is_ok_and(|v| v.len() <= 70_000) {
            return preview;
        }
    }
    json!({"provider_preview_only":true,"title":output["title"],"note":"Evidence is rendered in the app. Tool output exceeded the model-context budget; query a narrower aggregate to summarize it."})
}
fn plain_history(c: &Conversation) -> Vec<Value> {
    c.messages.iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().map(|m|{
        let mut text=m.text.clone();
        for r in &m.results {let preview=json!({"title":r.title,"columns":r.columns,"rows":r.rows.iter().take(12).collect::<Vec<_>>(),"request":r.request,"preview_only":true});text.push_str(&format!("\nPrior result preview; requery for full data: {preview}"));}
        json!({"role":m.role,"content":text})
    }).collect()
}
fn persist(root: &Path, profile: &str, c: &Conversation) -> Result<(), String> {
    storage::update::<Vault, _>(root, profile, |v| {
        if let Some(old) = v.conversations.iter_mut().find(|x| x.id == c.id) {
            *old = c.clone();
        } else {
            if v.conversations.len() >= 50 {
                return Err("Conversation limit reached. Delete older conversations first.".into());
            }
            v.conversations.push(c.clone());
        }
        Ok(())
    })
}

pub async fn run(
    ctx: Context,
    request: SendRequest,
    emit: Arc<dyn Fn(ChatEvent) + Send + Sync>,
) -> Result<(), String> {
    (ctx.authorize)()?;
    if ctx.db.profile != ctx.profile {
        return Err("Database does not belong to the authorized profile".into());
    }
    uuid::Uuid::parse_str(&request.request_id).map_err(|_| "Invalid request ID")?;
    if request.message.trim().is_empty() || request.message.len() > 12_000 {
        return Err("Enter a message of up to 12,000 bytes".into());
    }
    if request.timezone.len() > 80 || request.unit_system.len() > 512 {
        return Err("Invalid chat context".into());
    }
    let key = job_key(&ctx.root, &ctx.profile);
    let (tx, mut rx) = watch::channel(false);
    {
        let mut j = jobs().lock().map_err(|_| "Chat runtime unavailable")?;
        if j.contains_key(&key) {
            return Err(
                "This profile already has an active response. Stop it or wait for it to finish."
                    .into(),
            );
        }
        if j.len() >= 8 {
            return Err("Chat is busy. Try again shortly.".into());
        }
        j.insert(
            key.clone(),
            Job {
                id: request.request_id.clone(),
                cancel: tx,
            },
        );
    }
    let _guard = JobGuard {
        key,
        id: request.request_id.clone(),
    };
    let vault = storage::read::<Vault>(&ctx.root, &ctx.profile)?;
    let config = provider::normalize(vault.connection)?;
    if config.model.trim().is_empty() {
        return Err("Configure a provider and select a model first".into());
    }
    let mut c = if let Some(id) = &request.conversation_id {
        vault
            .conversations
            .into_iter()
            .find(|c| &c.id == id)
            .ok_or("Conversation not found in this profile")?
    } else {
        Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            title: request.message.chars().take(70).collect(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            messages: vec![],
            history: vec![],
            api_format: config.api_format.clone(),
            model: config.model.clone(),
            base_url: config.base_url.clone(),
        }
    };
    if c.messages.len() >= 100 {
        return Err("This conversation is full. Start a new conversation.".into());
    }
    if c.api_format != config.api_format
        || c.model != config.model
        || c.base_url != config.base_url
        || serde_json::to_vec(&c.history)
            .map_err(|_| "Invalid history")?
            .len()
            > 180_000
    {
        c.history = plain_history(&c);
    }
    c.api_format = config.api_format.clone();
    c.model = config.model.clone();
    c.base_url = config.base_url.clone();
    c.messages.push(Message {
        role: "user".into(),
        text: request.message.clone(),
        results: vec![],
        usage: None,
    });
    c.updated_at = chrono::Utc::now().to_rfc3339();
    persist(&ctx.root, &ctx.profile, &c)?;
    emit(ChatEvent::Conversation {
        id: c.id.clone(),
        title: c.title.clone(),
    });
    let mut history = c.history.clone();
    history.push(json!({"role":"user","content":request.message}));
    let mut answer = String::new();
    let mut results = Vec::new();
    let mut total_usage = Vec::new();
    let mut tool_calls = 0;
    let mut seen_tools: HashMap<String, Value> = HashMap::new();
    let mut stalled_calls = 0;
    let mut tool_errors = 0;
    let mut format_repairs = 0;
    let mut routed_config = config.clone();
    let mut route_fallback_used = false;
    let mut tool_session = tools::Session::default();
    let mut system = format!("{} Current time: {}. User timezone: {}. Display preferences: {}. Use native API tool calls and keep answers concise. Follow responseLanguage in display preferences unless the user requests another language.", tools::INSTRUCTIONS, chrono::Utc::now().to_rfc3339(), request.timezone, request.unit_system);
    let future = async {
        let schema = analytics::schema_context(ctx.db.clone()).await?;
        system.push_str(" Database reference and tool catalog are supplied below from this profile's schema metadata. They contain no table rows. Use the tool catalog directly; describe_data is optional when clarification is needed. Physical schema does not expand tool permissions.\n");
        system
            .push_str(&serde_json::to_string(&schema).map_err(|_| "Cannot encode schema context")?);
        for round in 0..10 {
            (ctx.authorize)()?;
            let finishing =
                round == 9 || tool_calls >= 20 || stalled_calls >= 2 || tool_errors >= 4;
            let tools = if finishing {
                vec![]
            } else {
                tools::definitions()
            };
            let mut round_system = if finishing {
                format!("{system} Tool budget is now closed. Answer using the evidence already returned. Clearly state unresolved constraints or failed analysis; do not invent missing results or claim a complete answer without evidence.")
            } else {
                system.clone()
            };
            if format_repairs > 0 {
                round_system.push_str(" A previous response printed an invalid tool invocation. Use the API's native structured function-call channel. Never print tool-call syntax as answer text. For per-flight derived metrics such as battery_max_temperature, select op=value and sort descending; the field is already aggregated per flight. If native tools are unavailable, explain that limitation without claiming database facts.");
            }
            let answer_offset = answer.len();
            let mut forward = |event| {
                if (ctx.authorize)().is_err() {
                    return;
                }
                if let ChatEvent::TextDelta { text } = &event {
                    answer.push_str(text);
                }
                emit(event)
            };
            let mut generated = provider::generate(
                &routed_config,
                &history,
                &round_system,
                &tools,
                &mut forward,
            )
            .await;
            if generated.as_ref().err().is_some_and(|error| {
                provider::free_router_capacity_fallback(
                    &config,
                    &routed_config,
                    error,
                    route_fallback_used,
                )
            }) {
                routed_config = config.clone();
                route_fallback_used = true;
                generated = provider::generate(
                    &routed_config,
                    &history,
                    &round_system,
                    &tools,
                    &mut forward,
                )
                .await;
            }
            let reply = generated?;
            (ctx.authorize)()?;
            let usage = pricing::account(&config, reply.usage.clone());
            total_usage.push(usage.clone());
            emit(ChatEvent::Usage { usage });
            // A free router may select a different model on every HTTP request. Once it
            // produces a native call, keep that free model for this turn's tool continuation.
            if let Some(model) = provider::free_continuation_model(&config, &reply) {
                routed_config.model = model;
            }
            history.extend(reply.continuation);
            if reply.malformed_tool_text && reply.tools.is_empty() {
                format_repairs += 1;
                routed_config = config.clone();
                if format_repairs > 1 || finishing {
                    return Err("The model printed a tool request instead of calling the API tool. No query was executed for that request. Select a model with reliable native tool calling and try again.".into());
                }
                continue;
            }
            if reply.tools.is_empty() {
                if answer[answer_offset..].trim().is_empty() {
                    return Err(
                        "The model returned no answer. Try another model or rephrase the question."
                            .to_string(),
                    );
                }
                return Ok(());
            }
            if round == 9 {
                return Err(
                    "Analysis reached its tool-round limit. Try a narrower question.".into(),
                );
            }
            tool_calls += reply.tools.len();
            if tool_calls > 24 {
                return Err(
                    "Analysis reached its tool-call limit. Try a narrower question.".into(),
                );
            }
            for tool in reply.tools {
                (ctx.authorize)()?;
                emit(ChatEvent::ToolStarted {
                    name: tool.name.clone(),
                });
                let parsed = serde_json::from_str::<Value>(&tool.args)
                    .map_err(|_| "Invalid JSON tool arguments".to_string())
                    .and_then(analytics::normalize_arguments);
                let cache_key = format!(
                    "{}:{}",
                    tool.name,
                    parsed.as_ref().unwrap_or(&Value::String(tool.args.clone()))
                );
                let repeated = seen_tools.get(&cache_key).cloned();
                let outcome = if let Some(output) = repeated {
                    stalled_calls += 1;
                    Ok((
                        json!({"repeated_call":true,"instruction":"This exact call was already executed. Use its evidence or correct the reported error; do not repeat it.","previous_result":output}),
                        None,
                    ))
                } else {
                    match parsed {
                        Ok(args) => {
                            tool_session
                                .execute(ctx.db.clone(), &tool.name, args, &request.timezone)
                                .await
                        }
                        Err(error) => Err(tools::ToolError::from(error)),
                    }
                };
                (ctx.authorize)()?;
                let output = match outcome {
                    Ok((data, result)) => {
                        if let Some(result) = result {
                            if results.len() >= 16 {
                                return Err("Too many result tables. Narrow the question.".into());
                            }
                            emit(ChatEvent::Result {
                                result: result.clone(),
                            });
                            results.push(result);
                        }
                        data
                    }
                    Err(error) => {
                        tool_errors += 1;
                        error.output()
                    }
                };
                // Busy/rate-limit failures can recover without changing arguments.
                // They must reach the executor again rather than the duplicate cache.
                if output["retryable"] != true {
                    seen_tools
                        .entry(cache_key)
                        .or_insert_with(|| output.clone());
                }
                let serialized =
                    serde_json::to_string(&output).map_err(|_| "Cannot encode tool result")?;
                // UI retains the full result; provider context is bounded explicitly.
                let serialized = if serialized.len() > 70_000 {
                    serde_json::to_string(&provider_preview(&output))
                        .map_err(|_| "Cannot encode result preview")?
                } else {
                    serialized
                };
                history.push(if config.api_format == "responses" {
                    json!({"type":"function_call_output","call_id":tool.id,"output":serialized})
                } else {
                    json!({"role":"tool","tool_call_id":tool.id,"content":serialized})
                });
            }
        }
        Err("Analysis limit reached".into())
    };
    let outcome = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(300),future)=>result.unwrap_or_else(|_|Err("Response timed out. Try a narrower question.".into())),
        _=rx.changed()=>Err("Response stopped.".into()),
    };
    // Recheck before persisting or sending a final event after auth changes.
    (ctx.authorize)()?;
    match outcome {
        Ok(()) => {
            c.history = history;
        }
        Err(ref message) => {
            let unknown = pricing::account(&config, Value::Null);
            total_usage.push(unknown.clone());
            emit(ChatEvent::Usage { usage: unknown });
            if answer.is_empty() {
                answer = message.clone();
            } else {
                answer.push_str(&format!("\n\n{message}"));
            }
        }
    }
    c.messages.push(Message {
        role: "assistant".into(),
        text: answer,
        results,
        usage: Some(json!(total_usage)),
    });
    if outcome.is_err() {
        c.history = plain_history(&c);
    }
    c.updated_at = chrono::Utc::now().to_rfc3339();
    persist(&ctx.root, &ctx.profile, &c)?;
    outcome?;
    emit(ChatEvent::Completed);
    Ok(())
}

/// Shared authenticated operations for both transports. Secrets never leave this boundary.
pub async fn operation(
    root: &Path,
    profile: &str,
    op: &str,
    payload: Value,
) -> Result<Value, String> {
    match op {
        "connection" => serde_json::to_value(connection(root, profile)?).map_err(|e| e.to_string()),
        "save_connection" => {
            let c = serde_json::from_value(payload).map_err(|_| "Invalid connection settings")?;
            serde_json::to_value(save_connection(root, profile, c)?).map_err(|e| e.to_string())
        }
        "remove_connection" => {
            remove_connection(root, profile)?;
            Ok(json!({"ok":true}))
        }
        "models" | "test" => {
            let c = if payload.is_null() {
                saved_connection(root, profile)?
            } else {
                let mut c = provider::normalize(
                    serde_json::from_value(payload).map_err(|_| "Invalid connection settings")?,
                )?;
                if c.api_key.is_none() {
                    let old = storage::read::<Vault>(root, profile)?.connection;
                    if c.base_url == old.base_url {
                        c.api_key = old.api_key;
                    } else if old.api_key.is_some() {
                        return Err("Enter a key for the new provider URL".into());
                    }
                }
                c
            };
            if op == "models" {
                serde_json::to_value(provider::models(&c).await?).map_err(|e| e.to_string())
            } else {
                provider::test(&c).await
            }
        }
        "list" => serde_json::to_value(list(root, profile)?).map_err(|e| e.to_string()),
        "conversation" => serde_json::to_value(conversation(
            root,
            profile,
            payload["id"].as_str().ok_or("Conversation ID required")?,
        )?)
        .map_err(|e| e.to_string()),
        "delete" => {
            delete(
                root,
                profile,
                payload["id"].as_str().ok_or("Conversation ID required")?,
            )?;
            Ok(json!({"ok":true}))
        }
        _ => Err("Unknown chat operation".into()),
    }
}

#[cfg(all(test, feature = "web"))]
mod tests;

#[cfg(test)]
mod preview_tests {
    use super::*;
    #[test]
    fn cached_message_evidence_retains_exact_total_in_bounded_context() {
        let evidence = json!({"rows":(0..100).map(|_|json!({"message":"x".repeat(2000)})).collect::<Vec<_>>()});
        let result = json!({"matching_flights":606,"rows":[],"sections":[evidence]});
        let preview = provider_preview(&json!({"repeated_call":true,"previous_result":result}));
        assert!(serde_json::to_vec(&preview).unwrap().len() <= 70_000);
        assert_eq!(preview["previous_result"]["matching_flights"], 606);
        assert!(
            preview["previous_result"]["sections"][0]["rows"]
                .as_array()
                .unwrap()
                .len()
                <= 12
        );
    }
    #[test]
    fn nested_investigations_keep_provider_context_bounded_and_identity_aligned() {
        let rows: Vec<_> = (0..500)
            .map(|i| json!({"value":i,"message":"x".repeat(2000)}))
            .collect();
        let section = json!({"title":"Evidence","rows":rows,"row_flight_ids":(1..=500).collect::<Vec<_>>(),"request":{"select":["large query"]}});
        let result = json!({"title":"Report","rows":[],"sections":vec![section;6]});
        let preview = provider_preview(&result);
        assert!(serde_json::to_vec(&preview).unwrap().len() <= 70_000);
        for section in preview["sections"].as_array().unwrap() {
            assert!(section["rows"].as_array().unwrap().len() <= 3);
            assert_eq!(
                section["rows"].as_array().unwrap().len(),
                section["row_flight_ids"].as_array().unwrap().len()
            );
            assert_eq!(section["total_visible_rows"], 500);
            assert_eq!(section["provider_preview_only"], true);
        }
    }
}
