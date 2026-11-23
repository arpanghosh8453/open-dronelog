//! Synthetic protocol and authorization regressions; no saved credentials or real logs.
use super::*;
use axum::http::StatusCode;
use serde_json::json;
use std::sync::atomic::AtomicBool;

struct Fixture {
    root: tempfile::TempDir,
    server: Arc<Server>,
    databases: Arc<HashMap<String, Arc<Database>>>,
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut databases = HashMap::new();
        for (profile, name) in [
            ("default", "Default flight"),
            ("other", "Other private flight"),
        ] {
            let db = Arc::new(Database::new(root.path().into(), profile).unwrap());
            db.analytics_connection().unwrap().execute("INSERT INTO flights(id,file_name,display_name,start_time,duration_secs,total_distance,drone_model,drone_serial,battery_serial,max_speed,max_altitude) VALUES (1,'synthetic',?,TIMESTAMPTZ '2026-01-01 23:30:00+00',60,1000,'Mini','AIRCRAFT','BATTERY',10,30)",duckdb::params![name]).unwrap();
            db.analytics_connection().unwrap().execute_batch("INSERT INTO telemetry(flight_id,timestamp_ms,battery_percent,battery_temp,battery_voltage,altitude) VALUES(1,0,90,30,12,0),(1,30000,85,31,11.5,20),(1,60000,80,32,11,0); INSERT INTO flight_messages VALUES(1,30000,'warning','Low battery warning'); INSERT INTO settings(key,value) VALUES('private_marker','synthetic-private-setting')").unwrap();
            databases.insert(profile.into(), db);
        }
        let databases = Arc::new(databases);
        let lookup = databases.clone();
        let server = Server::new(
            root.path().into(),
            Mode::Web,
            true,
            None,
            Arc::new(move |p| lookup.get(p).cloned().ok_or("Profile unavailable".into())),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let router = server.router();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            root,
            server,
            databases,
            url,
            task,
        }
    }
    fn token(&self, profile: &str) -> String {
        storage::generate(
            self.root.path(),
            profile,
            "Synthetic client",
            "Europe/Budapest",
        )
        .unwrap()
        .0
    }
    async fn request(&self, token: &str, method: &str, params: Value) -> (StatusCode, Value) {
        rpc(&self.url, token, method, params).await
    }
}
async fn rpc(url: &str, token: &str, method: &str, params: Value) -> (StatusCode, Value) {
    let response = reqwest::Client::new().post(url).bearer_auth(token).header("accept","application/json, text/event-stream").header("mcp-protocol-version","2025-11-25").json(&json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":method,"params":params})).send().await.unwrap();
    let status = response.status();
    let sse = response
        .headers()
        .get("content-type")
        .is_some_and(|v| v.to_str().unwrap_or_default().contains("text/event-stream"));
    let body = response.text().await.unwrap();
    let value = if sse {
        body.lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .find_map(|data| serde_json::from_str(data).ok())
            .unwrap()
    } else {
        serde_json::from_str(&body).unwrap_or(Value::Null)
    };
    (status, value)
}

#[test]
fn grants_are_hashed_scoped_expiring_and_never_recoverable_from_status() {
    let dir = tempfile::tempdir().unwrap();
    let _db = Database::new(dir.path().into(), "default").unwrap();
    let (token, grant) = storage::generate(dir.path(), "default", "Laptop", "UTC").unwrap();
    assert_eq!(token.len(), 72);
    assert_eq!(
        storage::validate(dir.path(), &token).unwrap().profile,
        "default"
    );
    let bytes = std::fs::read_to_string(dir.path().join("mcp/access.json")).unwrap();
    assert!(!bytes.contains(&token));
    assert!(!grant.public().to_string().contains("hash"));
    assert!(!grant.public().to_string().contains("auth_fingerprint"));
    assert!(storage::generate(dir.path(), "missing", "Client", "UTC").is_err());
    assert!(storage::generate(dir.path(), "default", "Client", "not-a-timezone").is_err());
    assert!(storage::generate(dir.path(), "default", "\n", "UTC").is_err());
    // Another profile cannot revoke this profile's grant.
    storage::revoke(dir.path(), "other", Some(&grant.id)).unwrap();
    assert!(storage::validate(dir.path(), &token).is_ok());
    let mut stored: Value = serde_json::from_str(&bytes).unwrap();
    stored["grants"][0]["expires_at"] = json!("2000-01-01T00:00:00+00:00");
    std::fs::write(dir.path().join("mcp/access.json"), stored.to_string()).unwrap();
    assert!(storage::validate(dir.path(), &token).is_err());
}

#[test]
fn password_changes_and_deletion_invalidate_grants() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path().into(), "work").unwrap();
    let (token, _) = storage::generate(dir.path(), "work", "Client", "UTC").unwrap();
    crate::profile_auth::set_password(dir.path(), "work", "synthetic-password", None).unwrap();
    assert!(storage::validate(dir.path(), &token).is_err());
    let (replacement, _) = storage::generate(dir.path(), "work", "Replacement", "UTC").unwrap();
    assert!(storage::validate(dir.path(), &replacement).is_ok());
    drop(db);
    crate::database::delete_profile(dir.path(), "work").unwrap();
    let _new = Database::new(dir.path().into(), "work").unwrap();
    assert!(storage::validate(dir.path(), &replacement).is_err());
}

#[tokio::test]
async fn protocol_discovery_and_every_tool_remain_read_only() {
    let f = Fixture::new().await;
    let token = f.token("default");
    assert!(f.server.enabled());
    let access_before = std::fs::read(f.root.path().join("mcp/access.json")).unwrap();
    let (status,init) = f.request(&token,"initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"synthetic-client","version":"1"}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert!(init["result"]["instructions"]
        .as_str()
        .unwrap()
        .contains("read-only"));
    let (_, list) = f.request(&token, "tools/list", json!({})).await;
    let definitions = list["result"]["tools"].as_array().unwrap();
    assert_eq!(definitions.len(), 11);
    for definition in definitions {
        assert_eq!(definition["annotations"]["readOnlyHint"], true);
        assert_eq!(definition["annotations"]["destructiveHint"], false);
        assert!(definition["inputSchema"].is_object());
        assert!(definition.get("parameters").is_none());
    }
    let cmp =
        |field: &str, value: Value| json!({"kind":"compare","field":field,"op":"eq","value":value});
    let query = json!({"select":[{"field":"display_name","alias":"flight"},{"field":"distance_km","alias":"distance_km"}],"limit":5});
    let calls = [
        ("describe_data", json!({})),
        ("query_flights", query.clone()),
        (
            "search_flight_messages",
            json!({"category":"low_battery","start_date":"2026-01-02","end_date":"2026-01-03"}),
        ),
        (
            "compare_cohorts",
            json!({"cohorts":[{"name":"All","filter":cmp("id",json!(1))},{"name":"Empty","filter":cmp("id",json!(2))}],"metrics":[{"field":"distance_km","op":"sum"}]}),
        ),
        (
            "analyze_flight_timeline",
            json!({"flight_id":1,"metrics":["telemetry_battery_temp"],"start_ms":0,"end_ms":60000}),
        ),
        (
            "detect_anomalies",
            json!({"flight_id":1,"metrics":["max_altitude"],"telemetry_metric":"telemetry_altitude"}),
        ),
        (
            "analyze_battery_health",
            json!({"limit":5,"battery_limit":1}),
        ),
        ("assess_data_quality", json!({"limit":5})),
        ("explain_metric", json!({"metric":"distance_km"})),
        (
            "build_investigation_report",
            json!({"title":"Synthetic report","sections":[{"query":query}]}),
        ),
        ("find_features", json!({"search":"export profile settings"})),
    ];
    for (name, args) in calls {
        let (status, value) = f
            .request(&token, "tools/call", json!({"name":name,"arguments":args}))
            .await;
        assert_eq!(status, StatusCode::OK, "{name}: {value}");
        assert_eq!(value["result"]["isError"], false, "{name}: {value}");
        let data = &value["result"]["structuredContent"];
        assert_eq!(data["context"]["profile"], "default");
        assert_eq!(data["context"]["read_only"], true);
        assert_eq!(data["context"]["timezone"], "Europe/Budapest");
        assert!(!data.to_string().contains("synthetic-private-setting"));
    }
    let (_, schema) = f
        .request(&token, "resources/read", json!({"uri":"odl://schema"}))
        .await;
    assert!(schema["result"]["contents"][0]["text"]
        .as_str()
        .unwrap()
        .contains("metric_definitions"));
    for name in [
        "delete_profile",
        "change_password",
        "set_setting",
        "save_connection",
        "import_log",
        "operation",
    ] {
        let (_, value) = f
            .request(&token, "tools/call", json!({"name":name,"arguments":{}}))
            .await;
        assert!(value.get("error").is_some(), "{name}: {value}");
    }
    let db = &f.databases["default"];
    let conn = db.analytics_connection().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM flights", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "SELECT value FROM settings WHERE key='private_marker'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "synthetic-private-setting"
    );
    assert_eq!(
        std::fs::read(f.root.path().join("mcp/access.json")).unwrap(),
        access_before
    );
    assert!(!f.root.path().join("chat").exists());
    assert!(!f.root.path().join("profile_auth.json").exists());
}

#[tokio::test]
async fn tokens_cannot_switch_profiles_read_secrets_or_bypass_revocation() {
    let f = Fixture::new().await;
    let token = f.token("default");
    let other = f.token("other");
    let query = json!({"name":"query_flights","arguments":{"select":[{"field":"display_name","alias":"flight"}]}});
    let (_, value) = f.request(&token, "tools/call", query.clone()).await;
    assert_eq!(
        value["result"]["structuredContent"]["rows"][0]["flight"],
        "Default flight"
    );
    let (_, value) = f.request(&other, "tools/call", query.clone()).await;
    assert_eq!(
        value["result"]["structuredContent"]["rows"][0]["flight"],
        "Other private flight"
    );
    let response = reqwest::Client::new()
        .post(&f.url)
        .bearer_auth(&token)
        .header("x-profile", "other")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for arguments in [
        json!({"source":"settings","select":[{"field":"value","alias":"secret"}]}),
        json!({"profile":"other","select":[{"field":"display_name","alias":"flight"}]}),
        json!({"sql":"DELETE FROM flights"}),
    ] {
        let (_, value) = f
            .request(
                &token,
                "tools/call",
                json!({"name":"query_flights","arguments":arguments}),
            )
            .await;
        assert_eq!(value["result"]["isError"], true);
    }
    let grant = storage::validate(f.root.path(), &token).unwrap();
    storage::revoke(f.root.path(), "default", Some(&grant.id)).unwrap();
    assert_eq!(
        f.request(&token, "tools/list", json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request(&other, "tools/list", json!({})).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn transport_rejects_hostile_origins_unsupported_versions_and_missing_auth() {
    let f = Fixture::new().await;
    let token = f.token("default");
    let client = reqwest::Client::new();
    for method in [
        reqwest::Method::POST,
        reqwest::Method::GET,
        reqwest::Method::DELETE,
    ] {
        let response = client.request(method, &f.url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = client
        .post(&f.url)
        .bearer_auth(&token)
        .header("origin", "https://evil.example")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = client
        .post(&f.url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2099-01-01")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"]["code"],
        -32022
    );
    let response = client
        .post(&f.url)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(
        client
            .get(&f.url)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[tokio::test]
async fn desktop_listener_is_loopback_only_and_locking_or_switching_denies_access() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
    let allowed = Arc::new(AtomicBool::new(true));
    let gate = allowed.clone();
    let database = db.clone();
    let server = Server::new(
        dir.path().into(),
        Mode::Desktop,
        false,
        None,
        Arc::new(move |profile| {
            if profile != "default" || !gate.load(Ordering::SeqCst) {
                return Err("Profile is locked or inactive".into());
            }
            Ok(database.clone())
        }),
    );
    server.start_desktop_on(true, Some(0)).await.unwrap();
    let url = server.status("default").unwrap()["endpoint"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(url.starts_with("http://127.0.0.1:"));
    let (token, _) = storage::generate(dir.path(), "default", "Desktop client", "UTC").unwrap();
    assert_eq!(
        rpc(&url, &token, "tools/list", json!({})).await.0,
        StatusCode::OK
    );
    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&token)
        .header("host", "evil.example")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    allowed.store(false, Ordering::SeqCst);
    assert_eq!(
        rpc(&url, &token, "tools/list", json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    allowed.store(true, Ordering::SeqCst);
    assert_eq!(
        rpc(&url, &token, "tools/list", json!({})).await.0,
        StatusCode::OK
    );
    server.start_desktop_on(false, None).await.unwrap();
    assert!(!server.enabled());
    assert!(!storage::inspect(dir.path()).unwrap().desktop_enabled);
}

#[cfg(feature = "web")]
#[tokio::test]
async fn docker_gate_and_application_api_do_not_accept_mcp_credentials() {
    let root = tempfile::tempdir().unwrap();
    let state = crate::server::WebAppState::chat_test_state(root.path().into());
    let db = state.db_for_profile("default").unwrap();
    db.analytics_connection()
        .unwrap()
        .execute_batch("INSERT INTO flights(id,file_name,display_name) VALUES(1,'a','A')")
        .unwrap();
    let (token, _) = storage::generate(root.path(), "default", "Agent", "UTC").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes = crate::server::build_router_with_mcp(state.clone(), true, Ok(None));
    let task = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    let client = reqwest::Client::new();
    for (method, path, body) in [
        (
            reqwest::Method::DELETE,
            "/api/flights/delete_all",
            json!({}),
        ),
        (
            reqwest::Method::POST,
            "/api/profiles/set_password",
            json!({"profile":"default","new_password":"attack"}),
        ),
        (
            reqwest::Method::POST,
            "/api/profiles/delete",
            json!({"profile":"default"}),
        ),
        (
            reqwest::Method::POST,
            "/api/mcp/operation",
            json!({"profile":"default","operation":"generate","payload":{"name":"Attack","timezone":"UTC"}}),
        ),
    ] {
        assert_eq!(
            client
                .request(method, format!("{base}{path}"))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        rpc(&format!("{base}/mcp"), &token, "tools/list", json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert!(!crate::profile_auth::has_password(root.path(), "default"));
    assert_eq!(
        db.analytics_connection()
            .unwrap()
            .query_row("SELECT count(*) FROM flights", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    // App management uses a normal session and cannot override its profile.
    crate::profile_auth::set_password(root.path(), "default", "synthetic-password", None).unwrap();
    let session = state.sessions.create_session("default");
    let response = client
        .post(format!("{base}/api/mcp/operation"))
        .header("x-session", &session)
        .json(&json!({"profile":"other","operation":"status"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = client.post(format!("{base}/api/mcp/operation")).header("x-session",&session).json(&json!({"profile":"default","operation":"generate","payload":{"name":"Allowed client","timezone":"UTC"}})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let granted = response.json::<Value>().await.unwrap();
    assert_eq!(granted["connection"]["profile"], "default");
    let response = client
        .post(format!("{base}/api/mcp/operation"))
        .header("x-session", &session)
        .json(&json!({"profile":"default","operation":"enable","payload":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    task.abort();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let disabled_url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let routes = crate::server::build_router_with_mcp(state, false, Ok(None));
    let task = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    assert_eq!(
        client
            .post(disabled_url)
            .bearer_auth(granted["token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    task.abort();
}

#[tokio::test]
async fn rate_limits_are_per_connection_and_resource_failures_use_rpc_errors() {
    let f = Fixture::new().await;
    let token = f.token("default");
    let grant = storage::validate(f.root.path(), &token).unwrap();
    for _ in 0..30 {
        f.server.take_rate(&grant.id).unwrap();
    }
    let (status, error) = f
        .request(&token, "resources/read", json!({"uri":"odl://schema"}))
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(error.get("error").is_some());
    let (status, error) = f
        .request(
            &token,
            "tools/call",
            json!({"name":"find_features","arguments":{"search":"import"}}),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error["result"]["isError"], true);
    let other = f.token("other");
    assert_eq!(
        f.request(
            &other,
            "tools/call",
            json!({"name":"find_features","arguments":{"search":"import"}})
        )
        .await
        .0,
        StatusCode::OK
    );
}
