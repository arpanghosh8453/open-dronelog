use super::{types::*, Context};
use crate::server::{ProfileDb, WebAppState};
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
type ApiError = (StatusCode, Json<Value>);
fn err(message: String) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({"error":message})))
}
#[derive(Deserialize)]
struct Operation {
    operation: String,
    #[serde(default)]
    payload: Value,
}
async fn operation(pdb: ProfileDb, Json(op): Json<Operation>) -> Result<Json<Value>, ApiError> {
    super::operation(&pdb.data_dir, &pdb.profile, &op.operation, op.payload)
        .await
        .map(Json)
        .map_err(err)
}
#[derive(Deserialize)]
struct Cancel {
    request_id: String,
}
async fn cancel(pdb: ProfileDb, Json(payload): Json<Cancel>) -> Result<Json<Value>, ApiError> {
    super::cancel(&pdb.data_dir, &pdb.profile, &payload.request_id).map_err(err)?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct Id {
    id: Option<String>,
}
async fn conversations(pdb: ProfileDb, Query(q): Query<Id>) -> Result<Json<Value>, ApiError> {
    super::operation(
        &pdb.data_dir,
        &pdb.profile,
        if q.id.is_some() {
            "conversation"
        } else {
            "list"
        },
        json!({"id":q.id}),
    )
    .await
    .map(Json)
    .map_err(err)
}
struct Disconnect {
    root: std::path::PathBuf,
    profile: String,
    id: String,
    closed: Arc<AtomicBool>,
}
impl Drop for Disconnect {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = super::cancel(&self.root, &self.profile, &self.id);
    }
}
async fn send(
    State(state): State<WebAppState>,
    pdb: ProfileDb,
    headers: HeaderMap,
    Json(request): Json<SendRequest>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let (tx, rx) = tokio::sync::mpsc::channel::<ChatEvent>(512);
    let closed = Arc::new(AtomicBool::new(false));
    let check_closed = closed.clone();
    let profile = pdb.profile.clone();
    let expected = profile.clone();
    let root = pdb.data_dir.clone();
    let auth_root = root.clone();
    let token = headers
        .get("X-Session")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let authorize = Arc::new(move || {
        if check_closed.load(Ordering::SeqCst) {
            return Err("Client disconnected".into());
        }
        if let Some(t) = &token {
            if state.sessions.validate(t).as_deref() != Some(expected.as_str()) {
                return Err("Profile session expired. Sign in again.".into());
            }
        } else if crate::profile_auth::profile_is_protected(&auth_root, &expected) {
            return Err("Profile is locked. Sign in again.".into());
        }
        if !crate::database::profile_exists(&auth_root, &expected) {
            return Err("Profile no longer exists".into());
        }
        Ok(())
    });
    let guard = Disconnect {
        root: root.clone(),
        profile: profile.clone(),
        id: request.request_id.clone(),
        closed,
    };
    let emit_root = root.clone();
    let emit_profile = profile.clone();
    let emit_id = request.request_id.clone();
    let events = tx.clone();
    let emit = Arc::new(move |e| {
        if events.try_send(e).is_err() {
            let _ = super::cancel(&emit_root, &emit_profile, &emit_id);
        }
    });
    tokio::spawn(async move {
        if let Err(message) = super::run(
            Context {
                root,
                profile,
                db: pdb.db,
                authorize,
            },
            request,
            emit,
        )
        .await
        {
            let _ = tx.send(ChatEvent::Error { message }).await;
        }
    });
    let stream = futures_util::stream::unfold((rx, guard), |(mut rx, guard)| async move {
        rx.recv().await.map(|event| {
            let e = Event::default().json_data(event).unwrap_or_else(|_| {
                Event::default().data("{\"type\":\"error\",\"message\":\"Cannot encode response\"}")
            });
            (Ok(e), (rx, guard))
        })
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
pub fn router() -> Router<WebAppState> {
    Router::new()
        .route("/api/chat/operation", post(operation))
        .route("/api/chat/conversations", get(conversations))
        .route("/api/chat/send", post(send))
        .route("/api/chat/cancel", post(cancel))
        .layer(DefaultBodyLimit::max(64 * 1024))
}
