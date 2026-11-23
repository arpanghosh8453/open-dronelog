//! Offline end-to-end checks against a synthetic OpenAI-compatible provider.
use super::*;
use axum::{
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn timeline_repair_preserves_window_and_rejects_truncated_fallback() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let app=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
        let count=count.clone();async move {
            let step=count.fetch_add(1,Ordering::SeqCst);
            let filters=json!({"kind":"all","filters":[{"kind":"compare","field":"flight_id","op":"eq","value":1},{"kind":"compare","field":"telemetry_timestamp_ms","op":"gte","value":1000},{"kind":"compare","field":"telemetry_timestamp_ms","op":"lte","value":61000}]});
            let (name,args)=match step {
                0=>("analyze_flight_timeline",json!({"flight_id":1,"metrics":["telemetry_battery_voltage"],"start_ms":1000.0,"end_ms":61000.0,"annotations":[]})),
                1=>("query_flights",json!({"source":"telemetry","select":[{"field":"telemetry_timestamp_ms","alias":"ms"},{"field":"telemetry_battery_voltage","alias":"voltage"}],"filter":{"kind":"compare","field":"flight_id","op":"eq","value":1},"chart":{"kind":"timeline","x":"ms","y":["voltage"]}})),
                2=>("query_flights",json!({"source":"telemetry","select":[{"field":"telemetry_timestamp_ms","alias":"ms"},{"field":"telemetry_battery_voltage","alias":"voltage"}],"filter":filters,"chart":{"kind":"timeline","x":"ms","y":["voltage"]},"limit":5})),
                _=>("analyze_flight_timeline",json!({"flight_id":1,"metrics":["telemetry_battery_voltage"],"start_ms":1000,"end_ms":61000}))
            };
            if step>0 {
                let output=body["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="tool").unwrap()["content"].as_str().unwrap();
                assert!(output.contains(match step {1=>"annotates actual recorded messages",2=>"dropped its flight",3=>"truncated before covering",_=>"Flight timeline"}));
            }
            let event=if step<4 {json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":format!("call{step}"),"function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":"tool_calls"}]})}else{json!({"choices":[{"delta":{"content":"The full requested interval is plotted."},"finish_reason":"stop"}]})};
            ([("content-type","text/event-stream")],format!("data: {event}\n\n")).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
    db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name,duration_secs) VALUES(1,'a','A',70); INSERT INTO telemetry(flight_id,timestamp_ms,battery_voltage) SELECT 1,i*100,12.0 FROM range(701) AS t(i)").unwrap();
    save_connection(
        dir.path(),
        "default",
        ConnectionSettings {
            provider: "custom".into(),
            base_url: format!("http://{address}/v1"),
            api_format: "chat_completions".into(),
            model: "synthetic-model".into(),
            ..Default::default()
        },
    )
    .unwrap();
    run(
        Context {
            root: dir.path().into(),
            profile: "default".into(),
            db,
            authorize: Arc::new(|| Ok(())),
        },
        SendRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            conversation_id: None,
            message: "Plot voltage from 1000 through 61000 elapsed ms".into(),
            timezone: "UTC".into(),
            unit_system: "metric".into(),
        },
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let vault = storage::read::<Vault>(dir.path(), "default").unwrap();
    let answer = vault.conversations[0].messages.last().unwrap();
    assert_eq!(
        answer.results.len(),
        1,
        "no unbounded or truncated fallback table may be published"
    );
    assert_eq!(answer.results[0].rows[0]["start_ms"], 1000.0);
    assert_eq!(answer.results[0].rows[0]["end_ms"], 61000.0);
    assert!(
        answer.results[0].sections[0].rows.last().unwrap()["elapsed_ms"]
            .as_f64()
            .unwrap()
            > 60900.0
    );
    assert_eq!(calls.load(Ordering::SeqCst), 5);
    server.abort();
}

async fn mock_provider(format: &str) -> (String, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let responses = format == "responses";
    let app=Router::new().route("/v1/models",get(||async{Json(json!({"data":[{"id":"synthetic-model"}]}))}))
        .route(if responses{"/v1/responses"}else{"/v1/chat/completions"},post(move |Json(body):Json<Value>|{
            let count=count.clone();async move {
                assert_eq!(body["model"],"synthetic-model");
                assert_eq!(body["stream"],true);
                let context=body[if responses {"input"} else {"messages"}][0]["content"].as_str().unwrap();
                assert!(context.contains("physical_database_schema") && context.contains("declared_keys") && context.contains("relationships") && context.contains("tool_catalog"));
                assert!(context.contains("flight_messages") && context.contains("telemetry_battery_temp") && context.contains("duration_minutes"));
                assert!(!context.contains("schema-private-setting-value"));
                assert!(body.get("reasoning").is_none(), "must use model-default reasoning");
                assert!(body.get("reasoning_effort").is_none(), "must not send an effort override");
                let n=count.fetch_add(1,Ordering::SeqCst);
                let args=json!({"source":"flights","select":[{"field":"duration_minutes","op":"sum","alias":"minutes"},{"field":"*","op":"count","alias":"flights"}],"title":"Synthetic totals","chart":{"kind":"bar","x":"flights","y":["minutes"]}}).to_string();
                let events=if responses {
                    if n==0 {vec![json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_one","name":"query_flights","arguments":args}],"usage":{"input_tokens":10,"output_tokens":5}}})]}
                    else{assert!(body["input"].as_array().unwrap().iter().any(|v|v["type"]=="function_call_output"));vec![json!({"type":"response.output_text.delta","delta":"Total flight time: 30 minutes — two flights."}),json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Total flight time: 30 minutes — two flights."}]}],"usage":{"input_tokens":20,"output_tokens":8}}})]}
                } else if n==0 {
                    vec![json!({"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"opaque-first","index":0}],"tool_calls":[{"index":0,"id":"call_one","function":{"name":"query_flights","arguments":args}}]},"finish_reason":null}]}),json!({"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"opaque-second","index":1}]},"finish_reason":"tool_calls"}]})]
                }else{
                    assert!(body["messages"].as_array().unwrap().iter().any(|v|v["role"]=="tool"));
                    let assistant=body["messages"].as_array().unwrap().iter().find(|v|v["tool_calls"].is_array()).unwrap();
                    assert_eq!(assistant["reasoning_details"],json!([{"type":"reasoning.encrypted","data":"opaque-first","index":0},{"type":"reasoning.encrypted","data":"opaque-second","index":1}]));
                    vec![json!({"choices":[{"delta":{"content":"Total flight time: 30 minutes — two flights."},"finish_reason":null}]}),json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":8}})]
                };
                let text=events.into_iter().map(|v|format!("data: {v}\r\n\r\n")).collect::<String>();
                ([("content-type","text/event-stream")],text).into_response()
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1"), task, calls)
}
#[tokio::test]
async fn both_provider_adapters_query_persist_and_isolate_profiles() {
    for format in ["chat_completions", "responses"] {
        let (url, server, calls) = mock_provider(format).await;
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
        db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name,duration_secs) VALUES(1,'a','A',600),(2,'b','B',1200); INSERT INTO settings(key,value) VALUES('schema-test','schema-private-setting-value');").unwrap();
        let c = ConnectionSettings {
            provider: "custom".into(),
            base_url: url,
            api_format: format.into(),
            model: "synthetic-model".into(),
            pricing: None,
            api_key: Some("synthetic-secret".into()),
        };
        save_connection(dir.path(), "default", c.clone()).unwrap();
        assert_eq!(provider::models(&c).await.unwrap()[0].id, "synthetic-model");
        assert!(
            serde_json::to_string(&connection(dir.path(), "default").unwrap())
                .unwrap()
                .find("synthetic-secret")
                .is_none()
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        run(
            Context {
                root: dir.path().into(),
                profile: "default".into(),
                db,
                authorize: Arc::new(|| Ok(())),
            },
            SendRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                conversation_id: None,
                message: "Synthetic total time".into(),
                timezone: "UTC".into(),
                unit_system: "metric".into(),
            },
            Arc::new(move |event| collected.lock().unwrap().push(event)),
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let summaries = list(dir.path(), "default").unwrap();
        assert_eq!(summaries.len(), 1);
        let c = conversation(dir.path(), "default", &summaries[0].id).unwrap();
        assert!(c.messages[1].text.contains("30 minutes"));
        assert!(!c.messages[1].text.contains("opaque-first"));
        assert_eq!(c.messages[1].results[0].rows[0]["minutes"], 30.0);
        assert!(c.history.is_empty());
        assert!(conversation(dir.path(), "other", &summaries[0].id).is_err());
        assert!(list(dir.path(), "other").unwrap().is_empty());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, ChatEvent::Completed)));
        delete(dir.path(), "default", &summaries[0].id).unwrap();
        assert!(list(dir.path(), "default").unwrap().is_empty());
        server.abort();
    }
}
#[test]
fn changing_provider_cannot_reuse_a_saved_key() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = ConnectionSettings {
        provider: "custom".into(),
        base_url: "https://first.example/v1".into(),
        api_format: "chat_completions".into(),
        api_key: Some("synthetic-secret".into()),
        ..Default::default()
    };
    save_connection(dir.path(), "a", c.clone()).unwrap();
    c.base_url = "https://second.example/v1".into();
    c.api_key = None;
    assert!(save_connection(dir.path(), "a", c.clone()).is_err());
    c.api_key = Some("".into());
    assert!(save_connection(dir.path(), "a", c).is_ok());
}
#[tokio::test]
async fn denied_profile_never_starts_a_provider_request() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
    let result = run(
        Context {
            root: dir.path().into(),
            profile: "default".into(),
            db,
            authorize: Arc::new(|| Err("Profile locked".into())),
        },
        SendRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            conversation_id: None,
            message: "Anything".into(),
            timezone: "UTC".into(),
            unit_system: "metric".into(),
        },
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(result.unwrap_err(), "Profile locked");
    assert!(list(dir.path(), "default").unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_releases_profile_and_cannot_cancel_another_request() {
    let started = Arc::new(tokio::sync::Notify::new());
    let notify = started.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let notify = notify.clone();
            async move {
                notify.notify_one();
                tokio::time::sleep(Duration::from_secs(30)).await;
                Json(json!({}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let db = Arc::new(Database::new(root.clone(), "default").unwrap());
    save_connection(
        &root,
        "default",
        ConnectionSettings {
            provider: "custom".into(),
            base_url: format!("http://{address}/v1"),
            api_format: "chat_completions".into(),
            model: "slow-model".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request = SendRequest {
        request_id: id.clone(),
        conversation_id: None,
        message: "Synthetic cancellation check".into(),
        timezone: "UTC".into(),
        unit_system: "metric".into(),
    };
    let context = Context {
        root: root.clone(),
        profile: "default".into(),
        db: db.clone(),
        authorize: Arc::new(|| Ok(())),
    };
    let task = tokio::spawn(run(context, request, Arc::new(|_| {})));
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    cancel(&root, "default", "another-request").unwrap();
    assert!(!*jobs()
        .lock()
        .unwrap()
        .get(&job_key(&root, "default"))
        .unwrap()
        .cancel
        .borrow());
    cancel(&root, "default", &id).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        "Response stopped."
    );
    assert!(!jobs()
        .lock()
        .unwrap()
        .contains_key(&job_key(&root, "default")));
    let summary = list(&root, "default").unwrap();
    let c = conversation(&root, "default", &summary[0].id).unwrap();
    assert_eq!(c.messages[1].text, "Response stopped.");
    server.abort();
}

#[tokio::test]
async fn web_transport_authenticates_scopes_and_streams_results() {
    let (provider_url, provider_task, calls) = mock_provider("chat_completions").await;
    let dir = tempfile::tempdir().unwrap();
    let state = crate::server::WebAppState::chat_test_state(dir.path().into());
    let pilot = state.db_for_profile("pilot").unwrap();
    pilot.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name,duration_secs) VALUES(1,'a','A',600),(2,'b','B',1200)").unwrap();
    crate::profile_auth::set_password(dir.path(), "pilot", "synthetic-password", None).unwrap();
    save_connection(
        dir.path(),
        "pilot",
        ConnectionSettings {
            provider: "custom".into(),
            base_url: provider_url,
            api_format: "chat_completions".into(),
            model: "synthetic-model".into(),
            api_key: Some("synthetic-key".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let token = state.sessions.create_session("pilot");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::server::build_router(state))
            .await
            .unwrap()
    });
    let http = reqwest::Client::new();
    let url = format!("http://{address}/api/chat");
    let denied = http
        .post(format!("{url}/operation"))
        .header("X-Profile", "pilot")
        .json(&json!({"operation":"connection"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    let invalid = http
        .post(format!("{url}/operation"))
        .header("X-Session", "not-a-session")
        .json(&json!({"operation":"connection"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 401);
    // The token's identity wins over a conflicting profile header.
    let connection = http
        .post(format!("{url}/operation"))
        .header("X-Session", &token)
        .header("X-Profile", "default")
        .json(&json!({"operation":"connection"}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(connection.contains("synthetic-model"));
    assert!(!connection.contains("synthetic-key"));
    let response=http.post(format!("{url}/send")).header("X-Session",&token).header("X-Profile","default").json(&json!({"request_id":uuid::Uuid::new_v4(),"message":"Synthetic totals","timezone":"UTC","unit_system":"metric"})).send().await.unwrap();
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let text = response.text().await.unwrap();
    assert!(text.contains("\"type\":\"completed\""), "{text}");
    assert!(text.contains("\"minutes\":30.0"), "{text}");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(list(dir.path(), "pilot").unwrap().len(), 1);
    assert!(list(dir.path(), "default").unwrap().is_empty());
    let too_large = http
        .post(format!("{url}/operation"))
        .header("X-Session", &token)
        .json(&json!({"operation":"test","payload":{"extra":"x".repeat(70_000)}}))
        .send()
        .await
        .unwrap();
    assert_eq!(too_large.status(), 413);
    server.abort();
    provider_task.abort();
}

#[test]
fn retired_effort_is_discarded_without_losing_the_encrypted_connection() {
    let dir = tempfile::tempdir().unwrap();
    let legacy = json!({"connection":{"provider":"openai","base_url":"https://api.openai.com/v1","api_format":"responses","model":"synthetic-model","api_key":"synthetic-secret","effort":"high"},"conversations":[]});
    storage::update::<Value, _>(dir.path(), "default", |stored| {
        *stored = legacy;
        Ok(())
    })
    .unwrap();
    let saved = saved_connection(dir.path(), "default").unwrap();
    assert_eq!(saved.api_key.as_deref(), Some("synthetic-secret"));
    assert!(serde_json::to_value(&saved)
        .unwrap()
        .get("effort")
        .is_none());
    assert!(
        serde_json::to_value(connection(dir.path(), "default").unwrap())
            .unwrap()
            .get("effort")
            .is_none()
    );
    save_connection(dir.path(), "default", saved).unwrap();
    let rewritten = storage::read::<Value>(dir.path(), "default").unwrap();
    assert!(rewritten["connection"].get("effort").is_none());
    assert_eq!(rewritten["connection"]["api_key"], "synthetic-secret");
    assert!(
        serde_json::from_value::<ConnectionSettings>(json!({"unrecognized_setting":true})).is_err()
    );
}

#[tokio::test]
async fn repeated_calls_are_reused_and_finish_without_tools() {
    for (valid, unique, expected_tool_rounds) in [
        (false, false, 3),
        (true, false, 3),
        (false, true, 4),
        (true, true, 9),
    ] {
        let count = Arc::new(AtomicUsize::new(0));
        let captured = count.clone();
        let app=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
            let count=captured.clone(); async move {
                let n=count.fetch_add(1,Ordering::SeqCst);
                let event=if body.get("tools").is_none() {
                    assert_eq!(n,expected_tool_rounds,"repeats, error budget or reserved final round must close tools");
                    json!({"choices":[{"delta":{"content":"Finished using the available evidence."},"finish_reason":"stop"}]})
                } else {
                    let field=if valid {"*".to_string()} else if unique {format!("not_a_field_{n}")} else {"not_a_field".to_string()};
                    let alias=if unique {format!("flights_{n}")} else {"flights".into()};
                    let args=json!({"select":[{"field":field,"op":"count","alias":alias}]}).to_string();
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":format!("call_{n}"),"function":{"name":"query_flights","arguments":args}}]},"finish_reason":"tool_calls"}]})
                };
                ([("content-type","text/event-stream")],format!("data: {event}\n\ndata: [DONE]\n\n")).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
        save_connection(
            dir.path(),
            "default",
            ConnectionSettings {
                provider: "custom".into(),
                base_url: format!("http://{address}/v1"),
                api_format: "chat_completions".into(),
                model: "synthetic-model".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let result = run(
            Context {
                root: dir.path().into(),
                profile: "default".into(),
                db,
                authorize: Arc::new(|| Ok(())),
            },
            SendRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                conversation_id: None,
                message: "Count my flights".into(),
                timezone: "UTC".into(),
                unit_system: "metric".into(),
            },
            Arc::new(|_| {}),
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        let vault = storage::read::<Vault>(dir.path(), "default").unwrap();
        assert_eq!(
            vault.conversations[0]
                .messages
                .last()
                .unwrap()
                .results
                .len(),
            if valid {
                if unique {
                    expected_tool_rounds
                } else {
                    1
                }
            } else {
                0
            }
        );
        assert_eq!(count.load(Ordering::SeqCst), expected_tool_rounds + 1);
        assert_eq!(
            vault.conversations[0]
                .history
                .iter()
                .filter(|v| v["role"] == "tool"
                    && v["content"]
                        .as_str()
                        .is_some_and(|s| s.contains("repeated_call")))
                .count(),
            if unique { 0 } else { 2 }
        );
        server.abort();
    }
}

#[tokio::test]
async fn daily_quota_failure_is_not_retried_and_followup_context_is_retained() {
    let count = Arc::new(AtomicUsize::new(0));
    let captured = count.clone();
    let app=Router::new().route("/v1/chat/completions",post(move || {
        let count=captured.clone();async move {
            count.fetch_add(1,Ordering::SeqCst);
            (axum::http::StatusCode::TOO_MANY_REQUESTS,Json(json!({"error":{"message":"Rate limit exceeded: free-models-per-day reflected-secret-must-not-escape"}})))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
    save_connection(
        dir.path(),
        "default",
        ConnectionSettings {
            provider: "custom".into(),
            base_url: format!("http://{address}/v1"),
            api_format: "chat_completions".into(),
            model: "synthetic-model".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let result = run(
        Context {
            root: dir.path().into(),
            profile: "default".into(),
            db,
            authorize: Arc::new(|| Ok(())),
        },
        SendRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            conversation_id: None,
            message: "Find low battery warnings".into(),
            timezone: "UTC".into(),
            unit_system: "metric".into(),
        },
        Arc::new(|_| {}),
    )
    .await;
    let error = result.unwrap_err();
    assert!(error.contains("daily free-model"));
    assert!(!error.contains("reflected-secret"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let vault = storage::read::<Vault>(dir.path(), "default").unwrap();
    let history = &vault.conversations[0].history;
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["role"], "user");
    assert!(history[0]["content"]
        .as_str()
        .unwrap()
        .contains("low battery"));
    assert_eq!(history[1]["role"], "assistant");
    server.abort();
}

#[tokio::test]
async fn printed_tool_markup_is_hidden_repaired_and_never_executed_as_text() {
    for responses in [false, true] {
        for recover in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let captured = calls.clone();
            let app=Router::new().route(if responses {"/v1/responses"} else {"/v1/chat/completions"},post(move |Json(body):Json<Value>| {
                let count=captured.clone(); async move {
                    let n=count.fetch_add(1,Ordering::SeqCst);
                    if n>0 {assert!(!body.to_string().contains("<tool_call>"),"malformed text must not be fed back to the provider");}
                    let args=json!({"select":[{"field":"display_name","alias":"flight"},{"field":"battery_max_temperature","alias":"temperature"}],"order_by":[{"field":"temperature","descending":true}],"limit":10}).to_string();
                    let malformed=n==0 || !recover;
                    let events=if responses {
                        if malformed {vec![json!({"type":"response.output_text.delta","delta":"<tool_"}),json!({"type":"response.output_text.delta","delta":"call><function=query_flights>invalid protocol</tool_call>"}),json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<tool_call>invalid protocol</tool_call>"}]}]}})]}
                        else if n==1 {vec![json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"native_one","name":"query_flights","arguments":args}]}})]}
                        else {vec![json!({"type":"response.output_text.delta","delta":"Warmest flight: B at 60 °C."}),json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Warmest flight: B at 60 °C."}]}]}})]}
                    } else if malformed {vec![json!({"choices":[{"delta":{"content":"<tool_"}}]}),json!({"choices":[{"delta":{"content":"call><function=query_flights>invalid protocol</tool_call>"},"finish_reason":"stop"}]})]}
                    else if n==1 {vec![json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"native_one","function":{"name":"query_flights","arguments":args}}]},"finish_reason":"tool_calls"}]})]}
                    else {vec![json!({"choices":[{"delta":{"content":"Warmest flight: B at 60 °C."},"finish_reason":"stop"}]})]};
                    ([("content-type","text/event-stream")],events.iter().map(|v|format!("data: {v}\n\n")).collect::<String>()).into_response()
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let dir = tempfile::tempdir().unwrap();
            let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
            db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name) VALUES(1,'a','A'),(2,'b','B'); INSERT INTO telemetry(flight_id,timestamp_ms,battery_temp) VALUES(1,0,45),(2,0,60),(2,1000,55);").unwrap();
            save_connection(
                dir.path(),
                "default",
                ConnectionSettings {
                    provider: "custom".into(),
                    base_url: format!("http://{address}/v1"),
                    api_format: if responses {
                        "responses"
                    } else {
                        "chat_completions"
                    }
                    .into(),
                    model: "synthetic-model".into(),
                    ..Default::default()
                },
            )
            .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let captured = events.clone();
            let result = run(
                Context {
                    root: dir.path().into(),
                    profile: "default".into(),
                    db,
                    authorize: Arc::new(|| Ok(())),
                },
                SendRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    conversation_id: None,
                    message: "Top 10 flights by highest recorded battery temperature".into(),
                    timezone: "UTC".into(),
                    unit_system: "metric".into(),
                },
                Arc::new(move |event| captured.lock().unwrap().push(event)),
            )
            .await;
            let vault = storage::read::<Vault>(dir.path(), "default").unwrap();
            let answer = vault.conversations[0].messages.last().unwrap();
            assert!(!serde_json::to_string(&vault)
                .unwrap()
                .contains("<tool_call>"));
            assert!(events
                .lock()
                .unwrap()
                .iter()
                .all(|event| !matches!(event,ChatEvent::TextDelta{text} if text.contains('<'))));
            if recover {
                assert!(result.is_ok(), "{result:?}");
                assert_eq!(calls.load(Ordering::SeqCst), 3);
                assert_eq!(answer.results.len(), 1);
                assert_eq!(answer.results[0].rows[0]["temperature"], 60.0);
                assert!(answer.text.contains("60 °C"));
            } else {
                assert!(result.unwrap_err().contains("native tool calling"));
                assert_eq!(calls.load(Ordering::SeqCst), 2);
                assert!(answer.results.is_empty());
                assert!(!answer.text.contains("invalid protocol"));
            }
            server.abort();
        }
    }
}

#[tokio::test]
async fn failed_query_repairs_cannot_drop_date_or_altitude_predicates() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let app=Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>|{
        let count=count.clone();async move{
            let n=count.fetch_add(1,Ordering::SeqCst);
            if n==2 {assert!(body.to_string().contains("dropped previously supplied filter conditions"));}
            let event=if n<3 {
                let mut predicates=vec![json!({"kind":"compare","field":"start_time","op":"gte","value":"2026-01-01"}),json!({"kind":"compare","field":"start_time","op":"lt","value":"2027-01-01"})];
                if n!=1 {predicates.push(json!({"kind":"compare","field":"max_altitude","op":"gt","value":100}));}
                let args=json!({"select":[{"field":if n==0 {"bad_field"} else {"display_name"},"alias":"flight"}],"filter":{"kind":"all","filters":predicates}}).to_string();
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":format!("call_{n}"),"function":{"name":"query_flights","arguments":args}}]},"finish_reason":"tool_calls"}]})
            }else{json!({"choices":[{"delta":{"content":"One matching flight."},"finish_reason":"stop"}]})};
            ([("content-type","text/event-stream")],format!("data: {event}\n\n")).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(dir.path().into(), "default").unwrap());
    db.analytics_connection().unwrap().execute_batch("INSERT INTO flights(id,file_name,display_name,start_time,max_altitude) VALUES(1,'a','A','2026-01-02',150),(2,'b','B','2026-01-02',40),(3,'c','C','2025-01-02',150)").unwrap();
    save_connection(
        dir.path(),
        "default",
        ConnectionSettings {
            provider: "custom".into(),
            base_url: format!("http://{address}/v1"),
            api_format: "chat_completions".into(),
            model: "synthetic-model".into(),
            ..Default::default()
        },
    )
    .unwrap();
    run(
        Context {
            root: dir.path().into(),
            profile: "default".into(),
            db,
            authorize: Arc::new(|| Ok(())),
        },
        SendRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            conversation_id: None,
            message: "Flights above 100 m in 2026".into(),
            timezone: "UTC".into(),
            unit_system: "metric".into(),
        },
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let vault = storage::read::<Vault>(dir.path(), "default").unwrap();
    let answer = vault.conversations[0].messages.last().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert_eq!(answer.results.len(), 1);
    assert_eq!(answer.results[0].rows.len(), 1);
    assert_eq!(answer.results[0].rows[0]["flight"], "A");
    server.abort();
}
