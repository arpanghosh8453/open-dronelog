//! Profile-scoped, read-only MCP transport. Pairing administration is never an MCP tool.
mod http;
pub mod storage;
#[cfg(test)]
mod tests;

use crate::{chat::tools, database::Database};
use axum::Router;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

pub type Resolver = Arc<dyn Fn(&str) -> Result<Arc<Database>, String> + Send + Sync>;
pub const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Desktop,
    Web,
}
pub struct Server {
    pub root: PathBuf,
    pub mode: Mode,
    pub resolver: Resolver,
    enabled: AtomicBool,
    endpoint: Mutex<Option<String>>,
    shutdown: tokio::sync::Mutex<Option<watch::Sender<bool>>>,
    control: tokio::sync::Mutex<()>,
    slots: Mutex<HashMap<String, Arc<Semaphore>>>,
    global_slots: Arc<Semaphore>,
    rates: Mutex<HashMap<String, (Instant, u32)>>,
    jobs: Mutex<HashMap<String, watch::Sender<bool>>>,
}
#[cfg(feature = "web")]
pub fn web_enabled() -> bool {
    std::env::var("ODL_MCP_ENABLED").is_ok_and(|s| s == "true" || s == "1")
}
#[cfg(feature = "web")]
pub fn public_endpoint() -> Result<Option<String>, String> {
    let Some(value) = std::env::var("ODL_MCP_PUBLIC_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "ODL_MCP_PUBLIC_URL must be an absolute HTTP(S) URL ending in /mcp")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with("/mcp")
    {
        return Err("ODL_MCP_PUBLIC_URL must be an absolute HTTP(S) URL ending in /mcp, without credentials, query or fragment".into());
    }
    Ok(Some(url.to_string()))
}
impl Server {
    pub fn new(
        root: PathBuf,
        mode: Mode,
        enabled: bool,
        endpoint: Option<String>,
        resolver: Resolver,
    ) -> Arc<Self> {
        Arc::new(Self {
            root,
            mode,
            resolver,
            enabled: AtomicBool::new(enabled),
            endpoint: Mutex::new(endpoint),
            shutdown: tokio::sync::Mutex::new(None),
            control: tokio::sync::Mutex::new(()),
            slots: Mutex::new(HashMap::new()),
            global_slots: Arc::new(Semaphore::new(4)),
            rates: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        })
    }
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }
    pub fn router(self: &Arc<Self>) -> Router {
        http::router(self.clone())
    }
    pub async fn start_desktop(self: &Arc<Self>, enabled: bool) -> Result<(), String> {
        self.start_desktop_on(enabled, None).await
    }
    async fn start_desktop_on(
        self: &Arc<Self>,
        enabled: bool,
        port_override: Option<u16>,
    ) -> Result<(), String> {
        let _control = self.control.lock().await;
        if self.mode != Mode::Desktop {
            return Err("Docker MCP enablement is controlled by ODL_MCP_ENABLED".into());
        }
        if self.enabled() == enabled {
            return Ok(());
        }
        if !enabled {
            storage::set_enabled(&self.root, false)?;
            self.enabled.store(false, Ordering::SeqCst);
            if let Some(stop) = self.shutdown.lock().await.take() {
                let _ = stop.send(true);
            }
            for stop in self.jobs.lock().unwrap().values() {
                let _ = stop.send(true);
            }
            *self.endpoint.lock().unwrap() = None;
            return Ok(());
        }
        let port = match port_override {
            Some(port) => port,
            None => std::env::var("ODL_MCP_PORT")
                .unwrap_or_else(|_| "48765".into())
                .parse::<u16>()
                .map_err(|_| "ODL_MCP_PORT must be a valid port")?,
        };
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await.map_err(|_| "Cannot start local MCP listener; the port may be in use. Set ODL_MCP_PORT to another port and restart.")?;
        let endpoint = format!(
            "http://127.0.0.1:{}/mcp",
            listener
                .local_addr()
                .map_err(|_| "Cannot determine MCP port")?
                .port()
        );
        storage::set_enabled(&self.root, true)?;
        let (stop, mut stopped) = watch::channel(false);
        *self.endpoint.lock().unwrap() = Some(endpoint);
        *self.shutdown.lock().await = Some(stop);
        self.enabled.store(true, Ordering::SeqCst);
        let server = self.clone();
        let router = self.router();
        tokio::spawn(async move {
            if axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.changed().await;
                })
                .await
                .is_err()
            {
                server.enabled.store(false, Ordering::SeqCst);
                log::error!("Local MCP listener stopped unexpectedly");
            }
        });
        Ok(())
    }
    pub fn authorize(&self, token: &str) -> Result<storage::Grant, String> {
        if !self.enabled() {
            return Err("MCP is disabled".into());
        }
        storage::validate(&self.root, token)
    }
    pub fn status(&self, profile: &str) -> Result<Value, String> {
        let store = storage::inspect(&self.root)?;
        let tokens: Vec<Value> = store
            .grants
            .iter()
            .filter(|g| g.profile == profile && storage::is_current(&self.root, g).unwrap_or(false))
            .map(storage::Grant::public)
            .collect();
        Ok(
            json!({"enabled":self.enabled(),"mode":if self.mode==Mode::Web{"web"}else{"desktop"},"profile":profile,
            "endpoint":self.endpoint.lock().unwrap().clone(),"read_only":true,"tokens":tokens,"protocol_versions":VERSIONS}),
        )
    }
    /// Called only by authenticated app administration, never by /mcp.
    pub async fn operation(
        self: &Arc<Self>,
        profile: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value, String> {
        match operation {
            "status" => self.status(profile),
            "enable" => {
                self.start_desktop(payload.as_bool().ok_or("enabled must be a boolean")?)
                    .await?;
                self.status(profile)
            }
            "generate" => {
                if !self.enabled() {
                    return Err("Enable MCP before creating a connection".into());
                }
                let input: Generate = serde_json::from_value(payload)
                    .map_err(|_| "Provide name and timezone only")?;
                let (token, grant) =
                    storage::generate(&self.root, profile, &input.name, &input.timezone)?;
                Ok(json!({"token":token,"connection":grant.public()}))
            }
            "revoke" => {
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("Connection id required")?;
                storage::revoke(&self.root, profile, Some(id))?;
                self.status(profile)
            }
            _ => Err("Unknown MCP administration operation".into()),
        }
    }
    fn take_rate(&self, id: &str) -> Result<(), String> {
        let mut rates = self
            .rates
            .lock()
            .map_err(|_| "MCP rate limiter unavailable")?;
        rates.retain(|_, (started, _)| started.elapsed() < Duration::from_secs(60));
        let entry = rates.entry(id.into()).or_insert((Instant::now(), 0));
        if entry.1 >= 30 {
            return Err("MCP request rate limit reached; wait one minute".into());
        }
        entry.1 += 1;
        Ok(())
    }
    fn profile_slots(&self, profile: &str) -> Arc<Semaphore> {
        self.slots
            .lock()
            .unwrap()
            .entry(profile.into())
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }
    pub fn instructions(grant: &storage::Grant) -> String {
        format!("{} Authorized profile: {}. All date filters and buckets use {}. Each database query is limited to 20 seconds, 500 rows and 512 KB; an MCP tool call has a 60-second deadline. Up to 30 tool calls/minute per connection; one concurrent call per profile. Tables and chart specifications are returned as data; interactive rendering depends on the client. No model-provider credentials are needed. MCP does not persist chat history or analysis results.", tools::INSTRUCTIONS, grant.profile, grant.timezone)
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Generate {
    name: String,
    timezone: String,
}
