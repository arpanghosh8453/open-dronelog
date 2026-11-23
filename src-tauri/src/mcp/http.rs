//! Stateless Streamable HTTP. JSON metadata responses and request-scoped SSE tool results.
use super::{storage, Mode, Server, VERSIONS};
use crate::{chat::tools, database::Database};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::{oneshot, watch};

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn result(id: Value, data: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":data})
}
fn reply(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    if status == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert("retry-after", "5".parse().unwrap());
    }
    response
}
fn failure(status: StatusCode, message: &str) -> Response {
    let mut response = reply(status, rpc_error(Value::Null, -32000, message));
    if status == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            "www-authenticate",
            "Bearer realm=\"Open DroneLog MCP\"".parse().unwrap(),
        );
    }
    response
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}
fn check_origin(server: &Server, headers: &HeaderMap) -> Result<(), &'static str> {
    let host = header(headers, "host").ok_or("Host header required")?;
    if headers.contains_key("origin") && header(headers, "origin").is_none() {
        return Err("Invalid Origin");
    }
    if server.mode == Mode::Desktop {
        let endpoint = server
            .endpoint
            .lock()
            .unwrap()
            .clone()
            .ok_or("MCP is disabled")?;
        let port = reqwest::Url::parse(&endpoint)
            .ok()
            .and_then(|u| u.port())
            .ok_or("Invalid local endpoint")?;
        if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
            return Err("Invalid local MCP host");
        }
    }
    if let Some(origin) = header(headers, "origin") {
        let origin = reqwest::Url::parse(origin).map_err(|_| "Invalid Origin")?;
        if origin.origin().ascii_serialization() != header(headers, "origin").unwrap_or_default() {
            return Err("Invalid Origin");
        }
        let endpoint = server.endpoint.lock().unwrap().clone();
        let expected = endpoint
            .as_deref()
            .and_then(|e| reqwest::Url::parse(e).ok());
        let permitted = if let Some(endpoint) = expected {
            origin.origin() == endpoint.origin()
        } else {
            ["http", "https"].contains(&origin.scheme())
                && origin.host_str().is_some()
                && origin
                    .host_str()
                    .map(|name| match origin.port() {
                        Some(port) => format!("{name}:{port}"),
                        None => name.to_string(),
                    })
                    .as_deref()
                    == Some(host)
        };
        if !permitted {
            return Err("Origin is not allowed for MCP");
        }
    }
    Ok(())
}
fn authenticate(
    server: &Server,
    headers: &HeaderMap,
) -> Result<(String, storage::Grant, Arc<Database>), Response> {
    if !server.enabled() {
        return Err(failure(StatusCode::NOT_FOUND, "MCP is disabled"));
    }
    check_origin(server, headers).map_err(|message| failure(StatusCode::FORBIDDEN, message))?;
    let token = header(headers, "authorization")
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token.trim())
        .ok_or_else(|| {
            failure(
                StatusCode::UNAUTHORIZED,
                "A profile-specific MCP bearer token is required",
            )
        })?;
    let grant = server.authorize(token).map_err(|_| {
        failure(
            StatusCode::UNAUTHORIZED,
            "MCP token is invalid, expired, revoked, or profile authorization changed",
        )
    })?;
    if headers.contains_key("x-session")
        || header(headers, "x-profile").is_some_and(|profile| profile != grant.profile)
    {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "MCP tokens cannot switch profiles or use application sessions",
        ));
    }
    let db = (server.resolver)(&grant.profile)
        .map_err(|message| failure(StatusCode::FORBIDDEN, &message))?;
    if db.profile != grant.profile {
        return Err(failure(StatusCode::FORBIDDEN, "Profile scope mismatch"));
    }
    Ok((token.into(), grant, db))
}
fn tool_definitions() -> Value {
    Value::Array(tools::definitions().into_iter().map(|tool| json!({"name":tool["name"],"description":tool["description"],"inputSchema":tool["parameters"],"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})).collect())
}
fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}
fn execution_error(id: Value, message: &str, resource: bool) -> Value {
    if resource {
        rpc_error(id, -32603, message)
    } else {
        result(id, tool_error(message))
    }
}
fn job_key(grant: &storage::Grant, id: &Value) -> String {
    format!("{}:{id}", grant.id)
}

async fn rpc(State(server): State<Arc<Server>>, headers: HeaderMap, body: Bytes) -> Response {
    let (token, grant, db) = match authenticate(&server, &headers) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    if !header(&headers, "content-type").is_some_and(|s| {
        s.split(';')
            .next()
            .is_some_and(|s| s.trim() == "application/json")
    }) {
        return failure(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Use application/json");
    }
    let accept = header(&headers, "accept").unwrap_or_default();
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return failure(
            StatusCode::NOT_ACCEPTABLE,
            "Accept must include application/json and text/event-stream",
        );
    }
    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return reply(
                StatusCode::BAD_REQUEST,
                rpc_error(Value::Null, -32700, "Invalid JSON"),
            )
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = request["method"].as_str() else {
        return reply(
            StatusCode::BAD_REQUEST,
            rpc_error(id, -32600, "JSON-RPC method required"),
        );
    };
    if request["jsonrpc"] != "2.0"
        || !request.is_object()
        || (request.get("id").is_some() && !(id.is_string() || id.is_i64() || id.is_u64()))
        || request.get("params").is_some_and(|v| !v.is_object())
    {
        return reply(
            StatusCode::BAD_REQUEST,
            rpc_error(id, -32600, "Invalid JSON-RPC request"),
        );
    }
    if header(&headers, "mcp-method").is_some_and(|m| m != method)
        || header(&headers, "mcp-name").is_some_and(|n| {
            Some(n)
                != request["params"]["name"]
                    .as_str()
                    .or_else(|| request["params"]["uri"].as_str())
        })
    {
        return reply(
            StatusCode::BAD_REQUEST,
            rpc_error(id, -32600, "Request metadata headers do not match the body"),
        );
    }
    let params = &request["params"];
    let body_version = params["_meta"]["io.modelcontextprotocol/protocolVersion"]
        .as_str()
        .or_else(|| {
            if method == "initialize" {
                params["protocolVersion"].as_str()
            } else {
                None
            }
        });
    if header(&headers, "mcp-protocol-version")
        .zip(body_version)
        .is_some_and(|(header, body)| header != body)
    {
        return reply(
            StatusCode::BAD_REQUEST,
            rpc_error(
                id,
                -32600,
                "Protocol version header does not match the body",
            ),
        );
    }
    if request.get("id").is_none() {
        if method == "notifications/cancelled" {
            if let Some(cancel_id) = params.get("requestId") {
                if let Some(stop) = server.jobs.lock().unwrap().get(&job_key(&grant, cancel_id)) {
                    let _ = stop.send(true);
                }
            }
        }
        return StatusCode::ACCEPTED.into_response();
    }
    let version = header(&headers, "mcp-protocol-version")
        .or_else(|| params["_meta"]["io.modelcontextprotocol/protocolVersion"].as_str())
        .unwrap_or("2025-03-26");
    if method != "initialize" && !VERSIONS.contains(&version) {
        return reply(
            StatusCode::BAD_REQUEST,
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32022,"message":"Unsupported protocol version","data":{"supported":VERSIONS,"requested":version}}}),
        );
    }
    let capabilities =
        json!({"tools":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false}});
    let info = json!({"name":"open-dronelog","version":env!("CARGO_PKG_VERSION")});
    let data = match method {
        "initialize" => {
            if !params["protocolVersion"].is_string()
                || !params["capabilities"].is_object()
                || !params["clientInfo"]["name"].is_string()
                || !params["clientInfo"]["version"].is_string()
            {
                return reply(
                    StatusCode::BAD_REQUEST,
                    rpc_error(
                        id,
                        -32602,
                        "Initialization requires protocolVersion, capabilities and clientInfo",
                    ),
                );
            }
            let requested = params["protocolVersion"].as_str().unwrap();
            let selected = if VERSIONS.contains(&requested) {
                requested
            } else {
                VERSIONS[0]
            };
            json!({"protocolVersion":selected,"capabilities":capabilities,"serverInfo":info,"instructions":Server::instructions(&grant)})
        }
        "server/discover" => {
            json!({"resultType":"complete","supportedVersions":VERSIONS,"capabilities":capabilities,"_meta":{"io.modelcontextprotocol/serverInfo":info},"instructions":Server::instructions(&grant)})
        }
        "ping" => json!({}),
        "tools/list" => {
            if params.get("cursor").is_some_and(|v| !v.is_null()) {
                return reply(
                    StatusCode::OK,
                    rpc_error(id, -32602, "This tool list has no pagination cursor"),
                );
            }
            json!({"tools":tool_definitions()})
        }
        "resources/list" => {
            json!({"resources":[{"uri":"odl://schema","name":"Profile schema and analytics catalog","mimeType":"application/json"},{"uri":"odl://instructions","name":"Read-only analysis rules","mimeType":"text/plain"}]})
        }
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        "resources/read" if params["uri"] == "odl://instructions" => {
            json!({"contents":[{"uri":"odl://instructions","mimeType":"text/plain","text":Server::instructions(&grant)}]})
        }
        "tools/call" | "resources/read" => {
            let resource = method == "resources/read";
            if resource && params["uri"] != "odl://schema" {
                return reply(StatusCode::OK, rpc_error(id, -32602, "Unknown resource"));
            }
            let name = if resource {
                "describe_data"
            } else {
                match params["name"].as_str() {
                    Some(name) => name,
                    None => {
                        return reply(StatusCode::OK, rpc_error(id, -32602, "Tool name required"))
                    }
                }
            };
            if !tools::definitions().iter().any(|tool| tool["name"] == name) {
                return reply(
                    StatusCode::OK,
                    rpc_error(id, -32602, "Unknown read-only tool"),
                );
            }
            let args = if resource {
                json!({})
            } else {
                params.get("arguments").cloned().unwrap_or(json!({}))
            };
            return call(server, token, grant, db, id, name.into(), args, resource).await;
        }
        _ => {
            return reply(
                StatusCode::NOT_FOUND,
                rpc_error(id, -32601, "Method not found"),
            )
        }
    };
    reply(StatusCode::OK, result(id, data))
}
struct StreamGuard(watch::Sender<bool>);
impl Drop for StreamGuard {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}
struct JobGuard {
    server: Arc<Server>,
    key: String,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        self.server.jobs.lock().unwrap().remove(&self.key);
    }
}
async fn call(
    server: Arc<Server>,
    token: String,
    grant: storage::Grant,
    db: Arc<Database>,
    id: Value,
    name: String,
    args: Value,
    resource: bool,
) -> Response {
    if let Err(error) = server.take_rate(&grant.id) {
        return reply(
            StatusCode::TOO_MANY_REQUESTS,
            execution_error(id, &error, resource),
        );
    }
    let Ok(_global) = server.global_slots.clone().try_acquire_owned() else {
        return reply(
            StatusCode::TOO_MANY_REQUESTS,
            execution_error(id, "MCP is busy; retry shortly", resource),
        );
    };
    let Ok(_profile) = server.profile_slots(&grant.profile).try_acquire_owned() else {
        return reply(
            StatusCode::TOO_MANY_REQUESTS,
            execution_error(
                id,
                "Another MCP analysis is running for this profile; retry after it finishes",
                resource,
            ),
        );
    };
    let (stop, mut stopped) = watch::channel(false);
    let key = job_key(&grant, &id);
    {
        let mut jobs = server.jobs.lock().unwrap();
        if jobs.contains_key(&key) {
            return reply(
                StatusCode::BAD_REQUEST,
                rpc_error(id, -32600, "Request id is already running"),
            );
        }
        jobs.insert(key.clone(), stop.clone());
    }
    let job = JobGuard {
        server: server.clone(),
        key,
    };
    let (sender, receiver) = oneshot::channel::<Value>();
    tokio::spawn(async move {
        let _job = job;
        let _slots = (_global, _profile);
        let authorization = || -> Result<(), String> {
            let current = server.authorize(&token)?;
            if current.id != grant.id {
                return Err("MCP authorization changed".into());
            }
            let current_db = (server.resolver)(&grant.profile)?;
            if !Arc::ptr_eq(&db, &current_db) {
                return Err("Profile database changed; retry after reopening the profile".into());
            }
            Ok(())
        };
        let mut poll = tokio::time::interval(Duration::from_secs(1));
        let execution = tools::execute(db.clone(), &name, args, &grant.timezone);
        tokio::pin!(execution);
        let deadline = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(deadline);
        let outcome = loop {
            tokio::select! {
                value = &mut execution => break value.map(|(value,_)|value),
                _ = stopped.changed() => break Err("MCP request cancelled".into()),
                _ = &mut deadline => break Err("MCP tool call timed out; narrow the query".into()),
                _ = poll.tick() => if let Err(error) = authorization() { break Err(error); },
            }
        };
        // No data leaves the process after revocation, profile switching, or locking.
        let outcome = authorization().and(outcome);
        let value = match outcome {
            Ok(data) => {
                let text = data.to_string();
                if text.len() > 900_000 {
                    tool_error("Result exceeds the MCP output limit; narrow the query or request fewer sections")
                } else if resource {
                    json!({"contents":[{"uri":"odl://schema","mimeType":"application/json","text":text}]})
                } else {
                    json!({"structuredContent":data,"content":[{"type":"text","text":text}],"isError":false})
                }
            }
            Err(error) => tool_error(&error),
        };
        let response = if resource && value["isError"] == true {
            rpc_error(
                id,
                -32603,
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or("Resource could not be read"),
            )
        } else {
            result(id, value)
        };
        let _ = sender.send(response);
    });
    let stream = futures_util::stream::unfold(
        (Some(receiver), StreamGuard(stop)),
        |(receiver, guard)| async move {
            let receiver = receiver?;
            let value = receiver.await.ok()?;
            let event = Event::default()
                .event("message")
                .json_data(value)
                .unwrap_or_else(|_| Event::default().data("{}"));
            Some((Ok::<_, Infallible>(event), (None, guard)))
        },
    );
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}
async fn unsupported(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    match authenticate(&server, &headers) {
        Ok(_) => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        Err(response) => response,
    }
}
pub fn router(server: Arc<Server>) -> Router {
    Router::new()
        .route("/mcp", post(rpc).get(unsupported).delete(unsupported))
        .layer(DefaultBodyLimit::max(65536))
        .with_state(server)
}
