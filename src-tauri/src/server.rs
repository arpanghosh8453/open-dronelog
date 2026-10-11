//! Axum REST API server for the web/Docker deployment.
//!
//! This module mirrors all 11 Tauri commands as HTTP endpoints,
//! allowing the frontend to communicate via fetch() instead of invoke().

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, FromRequestParts, Multipart, Path, Query, State as AxumState},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};
use tokio_cron_scheduler::{Job, JobScheduler};

use crate::api::DjiApi;
use crate::database::{self, Database};
use crate::models::{FlightDataResponse, FlightTag, ImportResult, OverviewStats, TelemetryData};
use crate::parser::LogParser;
use crate::profile_auth;
use crate::session_store::SessionStore;

/// Shared application state for Axum handlers.
///
/// Maintains a connection pool keyed by profile name so that multiple
/// browser tabs / users can work on different profiles concurrently.
#[derive(Clone)]
pub struct WebAppState {
    databases: Arc<std::sync::RwLock<HashMap<String, Arc<Database>>>>,
    pub data_dir: PathBuf,
    pub sessions: Arc<SessionStore>,
    /// Argon2id hash of PROFILE_CREATION_PASS (None if env var not set).
    pub master_password_hash: Option<String>,
}

impl WebAppState {
    /// Get (or lazily open) a database connection for a given profile.
    pub fn db_for_profile(&self, profile: &str) -> Result<Arc<Database>, String> {
        // Fast path — already cached
        {
            let dbs = self.databases.read().unwrap();
            if let Some(db) = dbs.get(profile) {
                return Ok(db.clone());
            }
        }
        // Slow path — open the database and cache it
        let new_db = Database::new(self.data_dir.clone(), profile)
            .map_err(|e| format!("Failed to open profile '{}': {}", profile, e))?;
        let db = Arc::new(new_db);
        let mut dbs = self.databases.write().unwrap();
        // Double-check: another thread might have opened it in the meantime
        if let Some(existing) = dbs.get(profile) {
            return Ok(existing.clone());
        }
        dbs.insert(profile.to_string(), db.clone());
        Ok(db)
    }

    /// Remove a cached connection (used after profile deletion).
    pub fn evict_profile(&self, profile: &str) {
        self.databases.write().unwrap().remove(profile);
    }

    /// Convenience: get the *server-default* active profile's DB.
    /// Used only by non-request code (e.g. scheduled sync).
    #[allow(dead_code)]
    pub fn db(&self) -> Arc<Database> {
        let profile = database::get_active_profile(&self.data_dir);
        self.db_for_profile(&profile)
            .expect("Failed to open active profile database")
    }
}

// ---------------------------------------------------------------------------
// Custom Axum extractor — resolves the caller's profile DB per-request
// by reading the `X-Profile` header (falls back to the server default).
// ---------------------------------------------------------------------------

/// Wraps an `Arc<Database>` resolved from the request's `X-Profile` header,
/// along with the resolved profile name and data directory.
pub struct ProfileDb {
    pub db: Arc<Database>,
    pub profile: String,
    pub data_dir: PathBuf,
}

impl ProfileDb {
    /// Return the per-profile config file path.
    pub fn config_path(&self) -> PathBuf {
        database::config_path_for_profile(&self.data_dir, &self.profile)
    }

    /// Return the default uploaded-files folder for this profile.
    pub fn default_upload_folder(&self) -> PathBuf {
        database::default_upload_folder(&self.data_dir, &self.profile)
    }

    /// Return the sync folder for this profile (env-var based, profile-aware).
    pub fn sync_path(&self) -> Option<PathBuf> {
        database::sync_path_for_profile(&self.profile)
    }
}

#[axum::async_trait]
impl FromRequestParts<WebAppState> for ProfileDb {
    type Rejection = (StatusCode, Json<ErrorResponse>);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &WebAppState,
    ) -> Result<Self, Self::Rejection> {
        // 1. If X-Session is present, validate it — this takes priority
        let profile = if let Some(token) = parts
            .headers
            .get("X-Session")
            .and_then(|v| v.to_str().ok())
        {
            match state.sessions.validate(token) {
                Some(p) => p,
                None => {
                    return Err(err_response(
                        StatusCode::UNAUTHORIZED,
                        "Session expired or invalid — please re-authenticate",
                    ))
                }
            }
        } else {
            // 2. Fall back to X-Profile header (or server default)
            let p = parts
                .headers
                .get("X-Profile")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .unwrap_or_else(|| database::get_active_profile(&state.data_dir));

            // 3. If this profile is password-protected, reject unauthenticated access
            if profile_auth::profile_is_protected(&state.data_dir, &p) {
                return Err(err_response(
                    StatusCode::UNAUTHORIZED,
                    "This profile is password-protected — please authenticate first",
                ));
            }
            p
        };

        let db = state
            .db_for_profile(&profile)
            .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, e))?;

        Ok(ProfileDb {
            db,
            profile,
            data_dir: state.data_dir.clone(),
        })
    }
}

/// Standard error response
#[derive(Serialize)]
pub struct ErrorResponse {
    error: String,
}

fn err_response(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        status,
        Json(ErrorResponse {
            error: msg.into(),
        }),
    )
}

/// Compute SHA256 hash of a file
fn compute_file_hash(path: &std::path::Path) -> Result<String, String> {
    LogParser::calculate_file_hash(path)
        .map_err(|e| format!("Failed to compute hash: {}", e))
}

fn should_apply_sync_cooldown(config_path: &std::path::Path) -> bool {
    let app_data_dir = config_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let key_type = DjiApi::with_app_data_dir(app_data_dir).get_api_key_type();
    key_type != "personal"
}

fn has_allowed_extension(file_name: &str, allowed_extensions: &std::collections::HashSet<String>) -> bool {
    let ext = file_name
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase());
    match ext {
        Some(e) if e != file_name.to_ascii_lowercase() => allowed_extensions.contains(&e),
        _ => false,
    }
}

/// Copy uploaded file to the keep folder with hash-based deduplication (web mode)
fn copy_uploaded_file_web(
    src_path: &std::path::PathBuf,
    dest_folder: &std::path::PathBuf,
    file_name: &str,
    file_hash: Option<&str>,
) -> Result<(), String> {
    // Create the destination folder if it doesn't exist
    std::fs::create_dir_all(dest_folder)
        .map_err(|e| format!("Failed to create uploaded files folder: {}", e))?;
    
    let dest_path = dest_folder.join(file_name);
    
    // Compute source file hash if not provided
    let computed_hash: String;
    let src_hash = match file_hash {
        Some(h) => h,
        None => {
            computed_hash = compute_file_hash(src_path)?;
            &computed_hash
        }
    };
    
    // If file with same name exists, check hash
    if dest_path.exists() {
        let existing_hash = compute_file_hash(&dest_path)?;
        
        // If hashes match, skip (file already exists)
        if existing_hash == src_hash {
            log::info!("File already exists with same hash, skipping: {}", file_name);
            return Ok(());
        }
        
        // Hashes don't match - save with hash suffix
        let stem = Path::new(file_name).file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let extension = Path::new(file_name).extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        
        let hash_suffix = &src_hash[..8.min(src_hash.len())];
        let new_name = if extension.is_empty() {
            format!("{}_{}", stem, hash_suffix)
        } else {
            format!("{}_{}.{}", stem, hash_suffix, extension)
        };
        
        let new_dest_path = dest_folder.join(&new_name);
        std::fs::copy(src_path, &new_dest_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
        log::info!("Copied uploaded file (renamed due to hash mismatch): {} -> {}", file_name, new_name);
    } else {
        // No existing file, just copy
        std::fs::copy(src_path, &dest_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
        log::info!("Copied uploaded file: {}", file_name);
    }
    
    Ok(())
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/// POST /api/import — Upload and import a DJI flight log file
async fn import_log(
    AxumState(_state): AxumState<WebAppState>,
    pdb: ProfileDb,
    mut multipart: Multipart,
) -> Result<Json<ImportResult>, (StatusCode, Json<ErrorResponse>)> {
    // Read the uploaded file from multipart form data
    let field = multipart
        .next_field()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
        .ok_or_else(|| err_response(StatusCode::BAD_REQUEST, "No file uploaded"))?;

    let file_name = field
        .file_name()
        .unwrap_or("unknown.txt")
        .to_string();
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or("upload.log")
        .to_string();
    let data = field
        .bytes()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Failed to read file: {}", e)))?;

    // Write to a temp file so the parser can read it
    let temp_dir = std::env::temp_dir().join("drone-logbook-uploads");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create temp dir: {}", e)))?;

    let temp_path = temp_dir.join(format!("{}-{}", uuid::Uuid::new_v4(), safe_name));
    std::fs::write(&temp_path, &data)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write temp file: {}", e)))?;
    // Release multipart payload bytes before parse/import work starts.
    drop(data);

    let import_start = std::time::Instant::now();
    log::info!("Importing uploaded log file: {}", file_name);

    // Check if we should keep uploaded files (via env var or config) - check early for all code paths
    let upload_config_path = pdb.config_path();
    let upload_config: serde_json::Value = if upload_config_path.exists() {
        std::fs::read_to_string(&upload_config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let keep_enabled = std::env::var("KEEP_UPLOADED_FILES")
        .map(|v| v.to_lowercase() == "true" || v == "1")
        .unwrap_or_else(|_| {
            upload_config.get("keep_uploaded_files").and_then(|v| v.as_bool()).unwrap_or(false)
        });
    let default_upload_folder = pdb.default_upload_folder();
    let upload_folder = upload_config.get("uploaded_files_path")
        .and_then(|v| v.as_str())
        .map(|s| std::path::PathBuf::from(s))
        .unwrap_or(default_upload_folder);

    // Helper to copy uploaded file if setting is enabled
    let try_copy_file = |file_hash: Option<&str>| {
        if keep_enabled {
            if let Err(e) = copy_uploaded_file_web(&temp_path, &upload_folder, &safe_name, file_hash) {
                log::warn!("Failed to copy uploaded file: {}", e);
            }
        }
    };

    let parser = LogParser::new(&pdb.db);

    let parse_result = match parser.parse_log(&temp_path).await {
        Ok(result) => result,
        Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
            // Compute file hash so copy_uploaded_file_web can properly deduplicate
            let file_hash = compute_file_hash(&temp_path).ok();
            // Copy the file even though flight is already imported
            try_copy_file(file_hash.as_deref());
            // Clean up temp file
            let _ = std::fs::remove_file(&temp_path);
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: format!("This flight log has already been imported (matches: {})", matching_flight),
                point_count: 0,
                file_hash,
            }));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            log::error!("Failed to parse log {}: {}", file_name, e);
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: format!("Failed to parse log: {}", e),
                point_count: 0,
                file_hash: None,
            }));
        }
    };

    // Copy uploaded file before cleanup if enabled
    try_copy_file(parse_result.metadata.file_hash.as_deref());

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

    // Check for duplicate flight based on signature (drone_serial + battery_serial + start_time)
    if let Some(matching_flight) = pdb.db.is_duplicate_flight(
        parse_result.metadata.drone_serial.as_deref(),
        parse_result.metadata.battery_serial.as_deref(),
        parse_result.metadata.start_time,
    ).unwrap_or(None) {
        log::info!("Skipping duplicate flight (signature match): {} - matches flight '{}' in database", file_name, matching_flight);
        return Ok(Json(ImportResult {
            success: false,
            flight_id: None,
            message: format!("Duplicate flight: matches '{}' (same drone, battery, and start time)", matching_flight),
            point_count: 0,
            file_hash: parse_result.metadata.file_hash.clone(),
        }));
    }

    // Insert flight metadata
    let flight_id = pdb.db
        .insert_flight(&parse_result.metadata)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to insert flight: {}", e)))?;

    // Bulk insert telemetry data
    let point_count = match pdb.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
        Ok(count) => count,
        Err(e) => {
            log::error!("Failed to insert telemetry for flight {}: {}. Cleaning up.", flight_id, e);
            if let Err(cleanup_err) = pdb.db.delete_flight(flight_id) {
                log::error!("Failed to clean up flight {}: {}", flight_id, cleanup_err);
            }
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: format!("Failed to insert telemetry data: {}", e),
                point_count: 0,
                file_hash: parse_result.metadata.file_hash.clone(),
            }));
        }
    };

    // Run all post-import steps (smart tags, manual tags, profile tags,
    // notes, color, messages, and customization restore)
    let config = crate::models::load_profile_config(&pdb.config_path());
    crate::parser::run_post_import_steps(&pdb.db, flight_id, &parse_result, &config, &pdb.profile);

    log::info!(
        "Successfully imported flight {} with {} points in {:.1}s",
        flight_id,
        point_count,
        import_start.elapsed().as_secs_f64()
    );

    Ok(Json(ImportResult {
        success: true,
        flight_id: Some(flight_id),
        message: format!("Successfully imported {} telemetry points", point_count),
        point_count,
        file_hash: parse_result.metadata.file_hash.clone(),
    }))
}

/// Request payload for manual flight creation
#[derive(Deserialize)]
struct CreateManualFlightPayload {
    flight_title: Option<String>,
    aircraft_name: String,
    drone_serial: String,
    battery_serial: String,
    start_time: String, // ISO 8601 format
    duration_secs: f64,
    total_distance: Option<f64>,
    max_altitude: Option<f64>,
    home_lat: f64,
    home_lon: f64,
    notes: Option<String>,
}

/// POST /api/manual_flight — Create a manual flight entry without log file
async fn create_manual_flight(
    pdb: ProfileDb,
    Json(payload): Json<CreateManualFlightPayload>,
) -> Result<Json<ImportResult>, (StatusCode, Json<ErrorResponse>)> {
    use chrono::DateTime;

    log::info!("Creating manual flight entry: {} @ {}", payload.aircraft_name, payload.start_time);

    // Validate required fields
    if payload.aircraft_name.trim().is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Aircraft name is required"));
    }
    if payload.drone_serial.trim().is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Drone serial is required"));
    }
    if payload.battery_serial.trim().is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Battery serial is required"));
    }

    // Parse the start time
    let parsed_start_time = DateTime::parse_from_rfc3339(&payload.start_time)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Invalid start time format: {}", e)))?;

    // Calculate end time
    let end_time = parsed_start_time + chrono::Duration::seconds(payload.duration_secs as i64);

    // Create flight metadata
    // Use flight_title if provided, otherwise fallback to aircraft_name
    let display_name = payload.flight_title
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| payload.aircraft_name.clone());
    
    let flight_id = pdb.db.generate_flight_id();
    let metadata = crate::models::FlightMetadata {
        id: flight_id,
        file_name: format!("manual_entry_{}.log", flight_id),
        display_name,
        file_hash: None,
        drone_model: Some(format!("Manual Entry ({})", payload.aircraft_name)),
        drone_serial: Some(payload.drone_serial.trim().to_uppercase()),
        aircraft_name: Some(payload.aircraft_name.clone()),
        battery_serial: Some(payload.battery_serial.trim().to_uppercase()),
        start_time: Some(parsed_start_time),
        end_time: Some(end_time),
        duration_secs: Some(payload.duration_secs),
        total_distance: payload.total_distance,
        max_altitude: payload.max_altitude,
        max_speed: None,
        home_lat: Some(payload.home_lat),
        home_lon: Some(payload.home_lon),
        point_count: 0,
        photo_count: 0,
        video_count: 0,
        cycle_count: None,
        rc_serial: None,
        battery_life: None,
    };
    pdb.db
        .insert_flight(&metadata)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to insert flight: {}", e)))?;

    // Update notes if provided
    if let Some(notes_text) = &payload.notes {
        if !notes_text.trim().is_empty() {
            pdb.db
                .update_flight_notes(flight_id, Some(notes_text))
                .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to add notes: {}", e)))?;
        }
    }

    // Add "Manual Entry" tag
    let tags = vec!["Manual Entry".to_string()];
    if let Err(e) = pdb.db.insert_flight_tags(flight_id, &tags) {
        log::warn!("Failed to add tags: {}", e);
    }

    // Generate smart tags based on location
    let stats = crate::models::FlightStats {
        duration_secs: payload.duration_secs,
        total_distance_m: payload.total_distance.unwrap_or(0.0),
        max_altitude_m: payload.max_altitude.unwrap_or(0.0),
        max_speed_ms: 0.0,
        avg_speed_ms: 0.0,
        min_battery: 100,
        home_location: Some([payload.home_lon, payload.home_lat]),
        max_distance_from_home_m: 0.0,
        start_battery_percent: None,
        end_battery_percent: None,
        start_battery_temp: None,
    };
    
    let smart_tags = crate::parser::LogParser::generate_smart_tags(&metadata, &stats);
    if !smart_tags.is_empty() {
        if let Err(e) = pdb.db.insert_flight_tags(flight_id, &smart_tags) {
            log::warn!("Failed to add smart tags: {}", e);
        }
    }

    log::info!("Successfully created manual flight entry with ID: {}", flight_id);

    Ok(Json(ImportResult {
        success: true,
        flight_id: Some(flight_id),
        message: "Manual flight entry created successfully".to_string(),
        point_count: 0,
        file_hash: None,
    }))
}

/// GET /api/flights — List all flights
async fn get_flights(
    pdb: ProfileDb,
) -> Result<Json<Vec<crate::models::Flight>>, (StatusCode, Json<ErrorResponse>)> {
    let flights = pdb.db
        .get_all_flights()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get flights: {}", e)))?;
    Ok(Json(flights))
}

/// GET /api/flights/:id — Get flight data for visualization
#[derive(Deserialize)]
struct FlightDataQuery {
    flight_id: i64,
    max_points: Option<usize>,
}

async fn get_flight_data(
    pdb: ProfileDb,
    Query(params): Query<FlightDataQuery>,
) -> Result<Json<FlightDataResponse>, (StatusCode, Json<ErrorResponse>)> {
    let flight = pdb.db
        .get_flight_by_id(params.flight_id)
        .map_err(|e| err_response(StatusCode::NOT_FOUND, format!("Flight not found: {}", e)))?;

    let known_point_count = flight.point_count.map(|c| c as i64);

    let telemetry_records = pdb.db
        .get_flight_telemetry(params.flight_id, params.max_points, known_point_count)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get telemetry: {}", e)))?;

    let telemetry = TelemetryData::from_records(&telemetry_records);
    let track = telemetry.extract_track(2000);

    // Get flight messages (tips and warnings)
    let messages = pdb.db
        .get_flight_messages(params.flight_id)
        .unwrap_or_else(|e| {
            log::warn!("Failed to get messages for flight {}: {}", params.flight_id, e);
            Vec::new()
        });

    Ok(Json(FlightDataResponse {
        flight,
        telemetry,
        track,
        messages,
    }))
}

/// GET /api/overview — Get overview statistics
async fn get_overview_stats(
    pdb: ProfileDb,
) -> Result<Json<OverviewStats>, (StatusCode, Json<ErrorResponse>)> {
    let stats = pdb.db
        .get_overview_stats()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get overview stats: {}", e)))?;
    Ok(Json(stats))
}

/// GET /api/battery_capacity_history — Get battery full capacity history for a battery serial
#[derive(Deserialize)]
struct BatteryCapacityHistoryQuery {
    battery_serial: String,
}

async fn get_battery_full_capacity_history(
    pdb: ProfileDb,
    Query(params): Query<BatteryCapacityHistoryQuery>,
) -> Result<Json<Vec<(i64, String, f64)>>, (StatusCode, Json<ErrorResponse>)> {
    let history = pdb.db
        .get_battery_full_capacity_history(&params.battery_serial)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get battery capacity history: {}", e)))?;
    Ok(Json(history))
}

/// DELETE /api/flights/:id — Delete a flight
#[derive(Deserialize)]
struct DeleteFlightQuery {
    flight_id: i64,
}

async fn delete_flight(
    pdb: ProfileDb,
    Query(params): Query<DeleteFlightQuery>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    log::info!("Deleting flight: {}", params.flight_id);
    pdb.db
        .delete_flight(params.flight_id)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to delete flight: {}", e)))
}

/// DELETE /api/flights — Delete all flights
async fn delete_all_flights(
    pdb: ProfileDb,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    log::warn!("Deleting ALL flights and telemetry");
    pdb.db
        .delete_all_flights()
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to delete all flights: {}", e)))
}

/// POST /api/flights/deduplicate — Remove duplicate flights
async fn deduplicate_flights(
    pdb: ProfileDb,
) -> Result<Json<usize>, (StatusCode, Json<ErrorResponse>)> {
    log::info!("Running flight deduplication");
    pdb.db
        .deduplicate_flights()
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to deduplicate flights: {}", e)))
}

/// PUT /api/flights/name — Update flight display name
#[derive(Deserialize)]
struct UpdateNamePayload {
    flight_id: i64,
    display_name: String,
}

async fn update_flight_name(
    pdb: ProfileDb,
    Json(payload): Json<UpdateNamePayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let trimmed = payload.display_name.trim();
    if trimmed.is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Display name cannot be empty"));
    }

    log::info!("Renaming flight {} to '{}'", payload.flight_id, trimmed);

    pdb.db
        .update_flight_name(payload.flight_id, trimmed)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update flight name: {}", e)))
}

#[derive(Deserialize)]
struct UpdateNotesPayload {
    flight_id: i64,
    notes: Option<String>,
}

async fn update_flight_notes(
    pdb: ProfileDb,
    Json(payload): Json<UpdateNotesPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let notes_ref = payload.notes.as_ref().map(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    }).flatten();

    log::info!("Updating notes for flight {}", payload.flight_id);

    pdb.db
        .update_flight_notes(payload.flight_id, notes_ref)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update flight notes: {}", e)))
}

/// PUT /api/flights/color — Update flight color label
#[derive(Deserialize)]
struct UpdateColorPayload {
    flight_id: i64,
    color: String,
}

async fn update_flight_color(
    pdb: ProfileDb,
    Json(payload): Json<UpdateColorPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let trimmed = payload.color.trim();
    if trimmed.is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Color cannot be empty"));
    }

    log::info!("Updating color for flight {} to '{}'", payload.flight_id, trimmed);

    pdb.db
        .update_flight_color(payload.flight_id, trimmed)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update flight color: {}", e)))
}

/// GET /api/has_api_key — Check if DJI API key is configured
async fn has_api_key(
    AxumState(state): AxumState<WebAppState>,
    _pdb: ProfileDb,
) -> Json<bool> {
    let api = DjiApi::with_app_data_dir(state.data_dir.clone());
    Json(api.has_api_key())
}

/// GET /api/api_key_type — Get the type of the configured API key
async fn get_api_key_type(
    AxumState(state): AxumState<WebAppState>,
    _pdb: ProfileDb,
) -> Json<String> {
    let api = DjiApi::with_app_data_dir(state.data_dir.clone());
    Json(api.get_api_key_type())
}

/// POST /api/set_api_key — Set the DJI API key
#[derive(Deserialize)]
struct SetApiKeyPayload {
    api_key: String,
}

async fn set_api_key(
    AxumState(state): AxumState<WebAppState>,
    pdb: ProfileDb,
    Json(payload): Json<SetApiKeyPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    if pdb.profile != "default" {
        return Err(err_response(
            StatusCode::FORBIDDEN,
            "Changing DJI API key is only allowed from the default profile",
        ));
    }

    let api = DjiApi::with_app_data_dir(state.data_dir.clone());
    api.save_api_key(&payload.api_key)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save API key: {}", e)))
}

/// DELETE /api/remove_api_key — Remove the custom API key (fall back to default)
async fn remove_api_key(
    AxumState(state): AxumState<WebAppState>,
    pdb: ProfileDb,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    if pdb.profile != "default" {
        return Err(err_response(
            StatusCode::FORBIDDEN,
            "Changing DJI API key is only allowed from the default profile",
        ));
    }

    let api = DjiApi::with_app_data_dir(state.data_dir.clone());
    api.remove_api_key()
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove API key: {}", e)))
}

/// GET /api/app_data_dir — Get the app data directory path
async fn get_app_data_dir(
    AxumState(state): AxumState<WebAppState>,
    _pdb: ProfileDb,
) -> Json<String> {
    Json(state.data_dir.to_string_lossy().to_string())
}

/// GET /api/battery_pairs — Read battery pair definitions from battery-pair.json
async fn get_battery_pairs(
    AxumState(state): AxumState<WebAppState>,
    _pdb: ProfileDb,
) -> Json<Vec<String>> {
    Json(crate::battery_pairs::load_battery_pairs(&state.data_dir))
}

/// GET /api/app_log_dir — Get the app log directory path
async fn get_app_log_dir(
    AxumState(state): AxumState<WebAppState>,
    _pdb: ProfileDb,
) -> Json<String> {
    // In web mode, logs go to stdout/the data dir
    Json(state.data_dir.to_string_lossy().to_string())
}

/// GET /api/backup — Download a compressed database backup
async fn export_backup(
    pdb: ProfileDb,
) -> Result<axum::response::Response, (StatusCode, Json<ErrorResponse>)> {
    use axum::body::Body;
    use axum::response::IntoResponse;

    let temp_path = std::env::temp_dir().join(format!("dji-logbook-dl-{}.db.backup", uuid::Uuid::new_v4()));

    pdb.db
        .export_backup(&temp_path)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Backup failed: {}", e)))?;

    let file_bytes = tokio::fs::read(&temp_path)
        .await
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read backup file: {}", e)))?;

    let _ = tokio::fs::remove_file(&temp_path).await;

    // Generate timestamped filename
    let now = chrono::Local::now();
    let filename = format!("{}_Open_Dronelog.db.backup", now.format("%Y-%m-%d_%H-%M-%S"));

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", filename).leak()),
        ],
        Body::from(file_bytes),
    ).into_response())
}

/// POST /api/backup/restore — Upload and restore a backup file
async fn import_backup(
    AxumState(_state): AxumState<WebAppState>,
    pdb: ProfileDb,
    mut multipart: Multipart,
) -> Result<Json<String>, (StatusCode, Json<ErrorResponse>)> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
        .ok_or_else(|| err_response(StatusCode::BAD_REQUEST, "No file uploaded"))?;

    let data = field
        .bytes()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Failed to read file: {}", e)))?;

    let temp_path = std::env::temp_dir().join(format!("dji-logbook-restore-{}.db.backup", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, &data)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write temp file: {}", e)))?;

    let msg = pdb.db
        .import_backup(&temp_path)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Restore failed: {}", e)))?;

    let _ = std::fs::remove_file(&temp_path);

    Ok(Json(msg))
}

// ============================================================================
// TAG MANAGEMENT ENDPOINTS
// ============================================================================

/// POST /api/flights/tags/add — Add a tag to a flight
#[derive(Deserialize)]
struct AddTagPayload {
    flight_id: i64,
    tag: String,
}

async fn add_flight_tag(
    pdb: ProfileDb,
    Json(payload): Json<AddTagPayload>,
) -> Result<Json<Vec<FlightTag>>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .add_flight_tag(payload.flight_id, &payload.tag)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to add tag: {}", e)))?;
    pdb.db
        .get_flight_tags(payload.flight_id)
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get tags: {}", e)))
}

/// POST /api/flights/tags/remove — Remove a tag from a flight
#[derive(Deserialize)]
struct RemoveTagPayload {
    flight_id: i64,
    tag: String,
}

async fn remove_flight_tag(
    pdb: ProfileDb,
    Json(payload): Json<RemoveTagPayload>,
) -> Result<Json<Vec<FlightTag>>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .remove_flight_tag(payload.flight_id, &payload.tag)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove tag: {}", e)))?;
    pdb.db
        .get_flight_tags(payload.flight_id)
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get tags: {}", e)))
}

/// GET /api/tags — Get all unique tags
async fn get_all_tags(
    pdb: ProfileDb,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .get_all_unique_tags()
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get tags: {}", e)))
}

/// POST /api/tags/remove_auto — Remove all auto-generated tags from all flights
async fn remove_all_auto_tags(
    pdb: ProfileDb,
) -> Result<Json<usize>, (StatusCode, Json<ErrorResponse>)> {
    log::info!("Removing all auto-generated tags");
    pdb.db
        .remove_all_auto_tags()
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove auto tags: {}", e)))
}

/// GET /api/settings/smart_tags — Check if smart tags are enabled
async fn get_smart_tags_enabled(
    pdb: ProfileDb,
) -> Json<bool> {
    let config = crate::models::load_profile_config(&pdb.config_path());
    Json(config.get("smart_tags_enabled").and_then(|v| v.as_bool()).unwrap_or(true))
}

/// POST /api/settings/smart_tags — Set smart tags enabled
#[derive(Deserialize)]
struct SmartTagsPayload {
    enabled: bool,
}

async fn set_smart_tags_enabled(
    pdb: ProfileDb,
    Json(payload): Json<SmartTagsPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let config_path = pdb.config_path();
    let mut config = crate::models::load_profile_config(&config_path);
    config["smart_tags_enabled"] = serde_json::json!(payload.enabled);
    crate::models::save_profile_config(&config_path, &config)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(payload.enabled))
}

/// GET /api/settings/enabled_tag_types — Get enabled smart tag types
async fn get_enabled_tag_types(
    pdb: ProfileDb,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let config = crate::models::load_profile_config(&pdb.config_path());
    if let Some(types) = config.get("enabled_tag_types").and_then(|v| v.as_array()) {
        return Ok(Json(types.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()));
    }
    // Default: return all tag types
    Ok(Json(vec![
        "night_flight".to_string(), "high_speed".to_string(), "cold_battery".to_string(),
        "heavy_load".to_string(), "low_battery".to_string(), "high_altitude".to_string(),
        "long_distance".to_string(), "long_flight".to_string(), "short_flight".to_string(),
        "aggressive_flying".to_string(), "no_gps".to_string(), "country".to_string(),
        "continent".to_string(),
    ]))
}

/// Request body for setting enabled tag types
#[derive(Deserialize)]
struct EnabledTagTypesPayload {
    types: Vec<String>,
}

/// POST /api/settings/enabled_tag_types — Set enabled smart tag types
async fn set_enabled_tag_types(
    pdb: ProfileDb,
    Json(payload): Json<EnabledTagTypesPayload>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let config_path = pdb.config_path();
    let mut config = crate::models::load_profile_config(&config_path);
    config["enabled_tag_types"] = serde_json::json!(payload.types.clone());
    crate::models::save_profile_config(&config_path, &config)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(payload.types))
}

#[derive(Deserialize)]
struct SettingQuery {
    key: String,
}

#[derive(Serialize)]
struct SettingValuePayload {
    value: Option<String>,
}

#[derive(Deserialize)]
struct SetSettingPayload {
    key: String,
    value: String,
}

/// GET /api/settings/value?key=... — Get a value from profile-scoped DB settings table
async fn get_setting_value(
    pdb: ProfileDb,
    Query(query): Query<SettingQuery>,
) -> Result<Json<SettingValuePayload>, (StatusCode, Json<ErrorResponse>)> {
    let key = query.key.trim();
    if key.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "Setting key is required".to_string(),
        ));
    }

    let value = pdb
        .db
        .get_setting(key)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read setting: {}", e)))?;

    Ok(Json(SettingValuePayload { value }))
}

/// POST /api/settings/value — Set a value in profile-scoped DB settings table
async fn set_setting_value(
    pdb: ProfileDb,
    Json(payload): Json<SetSettingPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let key = payload.key.trim();
    if key.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "Setting key is required".to_string(),
        ));
    }

    pdb.db
        .set_setting(key, &payload.value)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save setting: {}", e)))?;

    Ok(Json(true))
}

/// Request body for regenerating smart tags with optional filter
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegenerateTagsPayload {
    enabled_tag_types: Option<Vec<String>>,
}

/// POST /api/regenerate_flight_smart_tags/:id — Regenerate auto tags for a single flight
async fn regenerate_flight_smart_tags(
    pdb: ProfileDb,
    Path(flight_id): Path<i64>,
    Json(payload): Json<RegenerateTagsPayload>,
) -> Result<Json<String>, (StatusCode, Json<ErrorResponse>)> {
    use crate::parser::{LogParser, calculate_stats_from_records};

    let flight = pdb.db.get_flight_by_id(flight_id)
        .map_err(|e| err_response(StatusCode::NOT_FOUND, format!("Failed to get flight {}: {}", flight_id, e)))?;

    let metadata = crate::models::FlightMetadata::from(&flight);

    match pdb.db.get_flight_telemetry(flight_id, Some(50000), None) {
        Ok(records) if !records.is_empty() => {
            let stats = calculate_stats_from_records(&records);
            let mut tags = LogParser::generate_smart_tags(&metadata, &stats);
            // Filter tags if enabled_tag_types is provided
            if let Some(ref types) = payload.enabled_tag_types {
                tags = LogParser::filter_smart_tags(tags, types);
            }
            pdb.db.replace_auto_tags(flight_id, &tags)
                .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to replace tags: {}", e)))?;
        }
        Ok(_) => {
            let _ = pdb.db.replace_auto_tags(flight_id, &[]);
        }
        Err(e) => {
            return Err(err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get telemetry: {}", e)));
        }
    }

    Ok(Json("ok".to_string()))
}

/// POST /api/regenerate_smart_tags — Regenerate auto tags for all flights
async fn regenerate_smart_tags(
    pdb: ProfileDb,
) -> Result<Json<String>, (StatusCode, Json<ErrorResponse>)> {
    use crate::parser::{LogParser, calculate_stats_from_records};

    log::info!("Starting smart tag regeneration for all flights");
    let start = std::time::Instant::now();

    let flight_ids = pdb.db.get_all_flight_ids()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get flight IDs: {}", e)))?;

    let _total = flight_ids.len();
    let mut processed = 0usize;
    let mut errors = 0usize;

    for flight_id in &flight_ids {
        match pdb.db.get_flight_by_id(*flight_id) {
            Ok(flight) => {
                let metadata = crate::models::FlightMetadata::from(&flight);

                match pdb.db.get_flight_telemetry(*flight_id, Some(50000), None) {
                    Ok(records) if !records.is_empty() => {
                        let stats = calculate_stats_from_records(&records);
                        let tags = LogParser::generate_smart_tags(&metadata, &stats);
                        if let Err(e) = pdb.db.replace_auto_tags(*flight_id, &tags) {
                            log::warn!("Failed to replace tags for flight {}: {}", flight_id, e);
                            errors += 1;
                        }
                    }
                    Ok(_) => {
                        let _ = pdb.db.replace_auto_tags(*flight_id, &[]);
                    }
                    Err(e) => {
                        log::warn!("Failed to get telemetry for flight {}: {}", flight_id, e);
                        errors += 1;
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to get flight {}: {}", flight_id, e);
                errors += 1;
            }
        }
        processed += 1;
    }

    let elapsed = start.elapsed().as_secs_f64();
    let msg = format!(
        "Regenerated smart tags for {} flights ({} errors) in {:.1}s",
        processed, errors, elapsed
    );
    log::info!("{}", msg);
    Ok(Json(msg))
}

// ============================================================================
// SYNC FROM FOLDER (for Docker/web deployment)
// ============================================================================

/// Response for sync operation
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    processed: usize,
    skipped: usize,
    errors: usize,
    message: String,
    sync_path: Option<String>,
    /// Whether automatic scheduled sync is enabled (SYNC_INTERVAL is set)
    auto_sync: bool,
}

/// Response for listing sync folder files
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFilesResponse {
    files: Vec<String>,
    sync_path: Option<String>,
    message: String,
}

/// Response for single file sync
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFileResponse {
    success: bool,
    message: String,
    file_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSingleFilePayload {
    filename: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncBlacklistResponse {
    hashes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncBlacklistEntry {
    hash: String,
    current_filename: Option<String>,
    is_present_in_sync_folder: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncBlacklistDetailsResponse {
    entries: Vec<SyncBlacklistEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AllowedExtensionsResponse {
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncBlacklistPayload {
    file_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncLogPayload {
    level: String,
    message: String,
    metadata: Option<String>,
}

#[derive(Deserialize)]
struct RemoveSyncBlacklistParams {
    file_hash: String,
}

/// GET /api/sync/config — Get the sync folder path configuration
async fn get_sync_config(
    _pdb: ProfileDb,
) -> Json<SyncResponse> {
    let sync_path = std::env::var("SYNC_LOGS_PATH").ok();
    let auto_sync = std::env::var("SYNC_INTERVAL").is_ok();
    Json(SyncResponse {
        processed: 0,
        skipped: 0,
        errors: 0,
        message: if sync_path.is_some() { "Sync folder configured".to_string() } else { "No sync folder configured".to_string() },
        sync_path,
        auto_sync,
    })
}

/// GET /api/allowed_log_extensions — Get built-in + custom parser extensions
async fn get_allowed_log_extensions(
    pdb: ProfileDb,
) -> Json<AllowedExtensionsResponse> {
    let mut extensions = crate::plugins::get_allowed_extensions(&pdb.data_dir);
    extensions.sort();
    Json(AllowedExtensionsResponse { extensions })
}

/// GET /api/sync/blacklist — List blacklisted file hashes
async fn get_sync_blacklist(
    pdb: ProfileDb,
) -> Result<Json<SyncBlacklistResponse>, (StatusCode, Json<ErrorResponse>)> {
    let hashes = pdb.db
        .get_sync_blacklist_hashes()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get sync blacklist: {}", e)))?;
    Ok(Json(SyncBlacklistResponse { hashes }))
}

/// GET /api/sync/blacklist/details — List blacklisted hashes with optional current filename resolution
async fn get_sync_blacklist_details(
    pdb: ProfileDb,
) -> Result<Json<SyncBlacklistDetailsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let hashes = pdb
        .db
        .get_sync_blacklist_hashes()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get sync blacklist: {}", e)))?;

    if hashes.is_empty() {
        return Ok(Json(SyncBlacklistDetailsResponse { entries: vec![] }));
    }

    let hash_set: std::collections::HashSet<String> = hashes.iter().cloned().collect();
    let mut resolved_by_hash: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if let Some(sync_dir) = pdb.sync_path() {
        if sync_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&sync_dir) {
                let allowed_extensions: std::collections::HashSet<String> = crate::plugins::get_allowed_extensions(&pdb.data_dir)
                    .into_iter()
                    .collect();

                // Deterministic filename choice if multiple files happen to share one hash.
                let mut candidates: Vec<(String, std::path::PathBuf)> = Vec::new();
                for entry in entries.filter_map(|entry| entry.ok()) {
                    let is_allowed_file = entry
                        .file_type()
                        .ok()
                        .map(|file_type| {
                            if !file_type.is_file() {
                                return false;
                            }
                            let name = entry.file_name().to_string_lossy().to_string();
                            has_allowed_extension(&name.to_ascii_lowercase(), &allowed_extensions)
                        })
                        .unwrap_or(false);

                    if !is_allowed_file {
                        continue;
                    }

                    candidates.push((entry.file_name().to_string_lossy().to_string(), entry.path()));
                }

                candidates.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));

                for (filename, path) in candidates {
                    let hash = match compute_file_hash(&path) {
                        Ok(hash) => hash,
                        Err(_) => continue,
                    };

                    if !hash_set.contains(&hash) {
                        continue;
                    }

                    resolved_by_hash.entry(hash).or_insert(filename);
                }
            }
        }
    }

    let entries = hashes
        .into_iter()
        .map(|hash| {
            let current_filename = resolved_by_hash.get(&hash).cloned();
            SyncBlacklistEntry {
                hash,
                is_present_in_sync_folder: current_filename.is_some(),
                current_filename,
            }
        })
        .collect();

    Ok(Json(SyncBlacklistDetailsResponse { entries }))
}

/// POST /api/sync/blacklist — Add file hash to sync blacklist
async fn add_sync_blacklist(
    pdb: ProfileDb,
    Json(payload): Json<SyncBlacklistPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .add_to_sync_blacklist(&payload.file_hash)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to add sync blacklist hash: {}", e)))?;
    Ok(Json(true))
}

/// DELETE /api/sync/blacklist?file_hash=... — Remove hash from sync blacklist
async fn remove_sync_blacklist(
    pdb: ProfileDb,
    Query(params): Query<RemoveSyncBlacklistParams>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .remove_from_sync_blacklist(&params.file_hash)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove sync blacklist hash: {}", e)))?;
    Ok(Json(true))
}

/// DELETE /api/sync/blacklist/all — Clear sync blacklist
async fn clear_sync_blacklist(
    pdb: ProfileDb,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .clear_sync_blacklist()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to clear sync blacklist: {}", e)))?;
    Ok(Json(true))
}

/// POST /api/sync/log_event — Write sync UI event into backend log stream
async fn sync_log_event(
    pdb: ProfileDb,
    Json(payload): Json<SyncLogPayload>,
) -> Json<bool> {
    let level = payload.level.trim().to_ascii_lowercase();
    let body = if let Some(meta) = payload.metadata {
        format!("[SYNC][UI][{}] {} | {}", pdb.profile, payload.message, meta)
    } else {
        format!("[SYNC][UI][{}] {}", pdb.profile, payload.message)
    };

    match level.as_str() {
        "debug" => log::debug!("{}", body),
        "warn" | "warning" => log::warn!("{}", body),
        "error" => log::error!("{}", body),
        _ => log::info!("{}", body),
    }

    Json(true)
}

/// GET /api/sync/files — List all log files in the sync folder
async fn get_sync_files(
    pdb: ProfileDb,
) -> Result<Json<SyncFilesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let sync_dir = match pdb.sync_path() {
        Some(p) => p,
        None => {
            return Ok(Json(SyncFilesResponse {
                files: vec![],
                sync_path: None,
                message: "SYNC_LOGS_PATH not configured".to_string(),
            }));
        }
    };

    let sync_path_str = sync_dir.to_string_lossy().to_string();

    // Auto-create the profile subfolder if it doesn't exist yet
    if !sync_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&sync_dir) {
            log::warn!("Failed to create sync folder {}: {}", sync_path_str, e);
        }
    }

    if !sync_dir.exists() {
        return Ok(Json(SyncFilesResponse {
            files: vec![],
            sync_path: Some(sync_path_str),
            message: "Sync folder does not exist".to_string(),
        }));
    }

    let entries = match std::fs::read_dir(&sync_dir) {
        Ok(entries) => entries,
        Err(e) => {
            return Err(err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read sync folder: {}", e),
            ));
        }
    };

    // Get existing file hashes to filter out already-imported files
    let existing_hashes: std::collections::HashSet<String> = pdb.db.get_all_file_hashes()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let blacklisted_hashes: std::collections::HashSet<String> = pdb.db
        .get_sync_blacklist_hashes()
        .unwrap_or_default()
        .into_iter()
        .collect();

    let allowed_extensions: std::collections::HashSet<String> = crate::plugins::get_allowed_extensions(&pdb.data_dir)
        .into_iter()
        .collect();

    let mut candidate_count = 0usize;
    let mut skipped_existing = 0usize;
    let mut skipped_blacklisted = 0usize;
    let mut hash_errors = 0usize;
    let mut files: Vec<String> = Vec::new();

    for entry in entries.filter_map(|entry| entry.ok()) {
        let is_allowed_file = entry
            .file_type()
            .ok()
            .map(|file_type| {
                if !file_type.is_file() {
                    return false;
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                has_allowed_extension(&name, &allowed_extensions)
            })
            .unwrap_or(false);

        if !is_allowed_file {
            continue;
        }

        candidate_count += 1;
        let path = entry.path();
        match compute_file_hash(&path) {
            Ok(hash) => {
                if existing_hashes.contains(&hash) {
                    skipped_existing += 1;
                    continue;
                }
                if blacklisted_hashes.contains(&hash) {
                    skipped_blacklisted += 1;
                    continue;
                }
                files.push(entry.file_name().to_string_lossy().to_string());
            }
            Err(e) => {
                hash_errors += 1;
                log::warn!(
                    "[SYNC][FILES][{}] hash failed for {}: {}",
                    pdb.profile,
                    path.display(),
                    e
                );
            }
        }
    }

    log::debug!(
        "[SYNC][FILES][{}] candidates={}, new={}, skipped_existing={}, skipped_blacklisted={}, hash_errors={}",
        pdb.profile,
        candidate_count,
        files.len(),
        skipped_existing,
        skipped_blacklisted,
        hash_errors
    );

    Ok(Json(SyncFilesResponse {
        files,
        sync_path: Some(sync_path_str),
        message: "OK".to_string(),
    }))
}

/// POST /api/sync/file — Import a single file from the sync folder
async fn sync_single_file(
    AxumState(_state): AxumState<WebAppState>,
    pdb: ProfileDb,
    Json(payload): Json<SyncSingleFilePayload>,
) -> Result<Json<SyncFileResponse>, (StatusCode, Json<ErrorResponse>)> {
    let filename = payload.filename.trim();
    if filename.is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Missing filename".to_string()));
    }

    let sync_dir = match pdb.sync_path() {
        Some(p) => p,
        None => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: "SYNC_LOGS_PATH not configured".to_string(),
                file_hash: None,
            }));
        }
    };

    let file_path = sync_dir.join(filename);

    // Path traversal protection: ensure resolved path stays inside the sync directory
    let canonical_sync = sync_dir.canonicalize().unwrap_or_else(|_| sync_dir.clone());
    let canonical_file = file_path.canonicalize().unwrap_or_else(|_| file_path.clone());
    if !canonical_file.starts_with(&canonical_sync) {
        return Err(err_response(StatusCode::BAD_REQUEST, "Invalid filename — path traversal detected"));
    }

    if !file_path.exists() {
        return Ok(Json(SyncFileResponse {
            success: false,
            message: format!("File not found: {}", filename),
            file_hash: None,
        }));
    }

    // Respect persistent DB-backed sync blacklist before any parse/import work.
    let file_hash = compute_file_hash(&file_path).ok();
    if let Some(hash) = file_hash.as_deref() {
        if pdb.db.is_sync_blacklisted(hash).unwrap_or(false) {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: "Blacklisted (previously deleted)".to_string(),
                file_hash: Some(hash.to_string()),
            }));
        }
    }

    let parser = LogParser::new(&pdb.db);

    let parse_result = match parser.parse_log(&file_path).await {
        Ok(result) => result,
        Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: format!("Already imported (matches '{}')", matching_flight),
                file_hash,
            }));
        }
        Err(e) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: format!("Parse error: {}", e),
                file_hash,
            }));
        }
    };

    // Check for duplicate flight
    if let Some(matching_flight) = pdb.db.is_duplicate_flight(
        parse_result.metadata.drone_serial.as_deref(),
        parse_result.metadata.battery_serial.as_deref(),
        parse_result.metadata.start_time,
    ).unwrap_or(None) {
        return Ok(Json(SyncFileResponse {
            success: false,
            message: format!("Duplicate flight (matches '{}')", matching_flight),
            file_hash: parse_result.metadata.file_hash.clone(),
        }));
    }

    // Insert flight
    let flight_id = match pdb.db.insert_flight(&parse_result.metadata) {
        Ok(id) => id,
        Err(e) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: format!("Failed to insert flight: {}", e),
                file_hash: None,
            }));
        }
    };

    // Insert telemetry
    if let Err(e) = pdb.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
        let _ = pdb.db.delete_flight(flight_id);
        return Ok(Json(SyncFileResponse {
            success: false,
            message: format!("Failed to insert telemetry: {}", e),
            file_hash: None,
        }));
    }

    // Run all post-import steps (smart tags, manual tags, profile tags,
    // notes, color, messages, and customization restore)
    let config = crate::models::load_profile_config(&pdb.config_path());
    crate::parser::run_post_import_steps(&pdb.db, flight_id, &parse_result, &config, &pdb.profile);

    Ok(Json(SyncFileResponse {
        success: true,
        message: "OK".to_string(),
        file_hash: parse_result.metadata.file_hash,
    }))
}

/// POST /api/sync — Trigger sync from SYNC_LOGS_PATH folder
async fn sync_from_folder(
    AxumState(_state): AxumState<WebAppState>,
    pdb: ProfileDb,
) -> Result<Json<SyncResponse>, (StatusCode, Json<ErrorResponse>)> {
    let sync_dir = match pdb.sync_path() {
        Some(p) => p,
        None => {
            return Ok(Json(SyncResponse {
                processed: 0,
                skipped: 0,
                errors: 0,
                message: "SYNC_LOGS_PATH environment variable not configured".to_string(),
                sync_path: None,
                auto_sync: false,
            }));
        }
    };

    let sync_path_str = sync_dir.to_string_lossy().to_string();

    // Auto-create the profile subfolder if it doesn't exist yet
    if !sync_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&sync_dir) {
            log::warn!("Failed to create sync folder {}: {}", sync_path_str, e);
        }
    }

    if !sync_dir.exists() {
        return Ok(Json(SyncResponse {
            processed: 0,
            skipped: 0,
            errors: 0,
            message: format!("Sync folder does not exist: {}", sync_path_str),
            sync_path: Some(sync_path_str),
            auto_sync: false,
        }));
    }

    log::info!("Starting sync from folder: {}", sync_path_str);
    let start = std::time::Instant::now();

    // Read all log files from the sync folder
    let entries = match std::fs::read_dir(&sync_dir) {
        Ok(entries) => entries,
        Err(e) => {
            return Err(err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read sync folder: {}", e),
            ));
        }
    };

    let allowed_extensions: std::collections::HashSet<String> = crate::plugins::get_allowed_extensions(&pdb.data_dir)
        .into_iter()
        .collect();

    let log_files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    return has_allowed_extension(&name, &allowed_extensions);
                }
            }
            false
        })
        .map(|entry| entry.path())
        .collect();

    if log_files.is_empty() {
        return Ok(Json(SyncResponse {
            processed: 0,
            skipped: 0,
            errors: 0,
            message: "No log files found in sync folder".to_string(),
            sync_path: Some(sync_path_str),
            auto_sync: false,
        }));
    }

    let parser = LogParser::new(&pdb.db);
    let mut processed = 0usize;
    let mut skipped = 0usize;
    let mut errors = 0usize;

    // Check smart tags setting
    let config_path = pdb.config_path();
    let config = crate::models::load_profile_config(&config_path);
    let apply_cooldown = should_apply_sync_cooldown(&config_path);

    for (index, file_path) in log_files.iter().enumerate() {
        let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

        if let Ok(hash) = compute_file_hash(&file_path) {
            if pdb.db.is_sync_blacklisted(&hash).unwrap_or(false) {
                skipped += 1;
                continue;
            }
        }
        
        let parse_result = match parser.parse_log(&file_path).await {
            Ok(result) => result,
            Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
                log::debug!("Skipping already-imported file: {} — matches flight '{}'", file_name, matching_flight);
                skipped += 1;
                continue;
            }
            Err(e) => {
                log::warn!("Failed to parse {}: {}", file_name, e);
                errors += 1;
                continue;
            }
        };

        // Check for duplicate flight
        if let Some(matching_flight) = pdb.db.is_duplicate_flight(
            parse_result.metadata.drone_serial.as_deref(),
            parse_result.metadata.battery_serial.as_deref(),
            parse_result.metadata.start_time,
        ).unwrap_or(None) {
            log::debug!("Skipping duplicate flight: {} — matches flight '{}'", file_name, matching_flight);
            skipped += 1;
            continue;
        }

        // Insert flight
        let flight_id = match pdb.db.insert_flight(&parse_result.metadata) {
            Ok(id) => id,
            Err(e) => {
                log::warn!("Failed to insert flight from {}: {}", file_name, e);
                errors += 1;
                continue;
            }
        };

        // Insert telemetry
        if let Err(e) = pdb.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
            log::warn!("Failed to insert telemetry for {}: {}", file_name, e);
            let _ = pdb.db.delete_flight(flight_id);
            errors += 1;
            continue;
        }

        // Run all post-import steps (smart tags, manual tags, profile tags,
        // notes, color, messages, and customization restore)
        crate::parser::run_post_import_steps(&pdb.db, flight_id, &parse_result, &config, &pdb.profile);

        processed += 1;
        log::debug!("Synced: {}", file_name);

        // Match browse-import policy for shared/default key usage.
        if apply_cooldown && index < log_files.len().saturating_sub(1) {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    let elapsed = start.elapsed().as_secs_f64();
    let msg = format!(
        "Sync complete: {} imported, {} skipped, {} errors in {:.1}s",
        processed, skipped, errors, elapsed
    );
    log::info!("{}", msg);

    Ok(Json(SyncResponse {
        processed,
        skipped,
        errors,
        message: msg,
        sync_path: Some(sync_path_str),
        auto_sync: false,
    }))
}

// ============================================================================
// EQUIPMENT NAMES
// ============================================================================

/// Response for equipment names
#[derive(Serialize)]
struct EquipmentNamesResponse {
    battery_names: std::collections::HashMap<String, String>,
    aircraft_names: std::collections::HashMap<String, String>,
}

/// GET /api/equipment_names — Get all custom equipment names
async fn get_equipment_names(
    pdb: ProfileDb,
) -> Result<Json<EquipmentNamesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let (battery_list, aircraft_list) = pdb.db.get_all_equipment_names()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get equipment names: {}", e)))?;
    
    let battery_names: std::collections::HashMap<String, String> = battery_list.into_iter().collect();
    let aircraft_names: std::collections::HashMap<String, String> = aircraft_list.into_iter().collect();
    
    Ok(Json(EquipmentNamesResponse { battery_names, aircraft_names }))
}

/// Payload for setting an equipment name
#[derive(Deserialize)]
struct SetEquipmentNamePayload {
    serial: String,
    equipment_type: String,  // "battery" or "aircraft"
    display_name: String,
}

/// POST /api/equipment_names — Set a custom equipment name
async fn set_equipment_name(
    pdb: ProfileDb,
    Json(payload): Json<SetEquipmentNamePayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db.set_equipment_name(&payload.serial, &payload.equipment_type, &payload.display_name)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to set equipment name: {}", e)))?;
    Ok(Json(true))
}

// ============================================================================
// PROFILE MANAGEMENT
// ============================================================================

/// Response for listing profiles — includes protection status.
#[derive(Serialize)]
struct ProfileInfo {
    name: String,
    #[serde(rename = "hasPassword")]
    has_password: bool,
}

async fn list_profiles(
    AxumState(state): AxumState<WebAppState>,
) -> Json<Vec<ProfileInfo>> {
    let names = database::list_profiles(&state.data_dir);
    let infos: Vec<ProfileInfo> = names
        .into_iter()
        .map(|name| {
            let has_pw = profile_auth::has_password(&state.data_dir, &name);
            ProfileInfo { name, has_password: has_pw }
        })
        .collect();
    Json(infos)
}

async fn get_active_profile(
    AxumState(state): AxumState<WebAppState>,
) -> Json<String> {
    Json(database::get_active_profile(&state.data_dir))
}

#[derive(Deserialize)]
struct SwitchProfilePayload {
    name: String,
    #[serde(default)]
    create: bool,
    /// Password for the profile being switched TO (required if protected).
    password: Option<String>,
    /// New password to set when creating a profile (optional).
    new_password: Option<String>,
    /// Master password required for creation/deletion when PROFILE_CREATION_PASS is set.
    master_password: Option<String>,
}

/// Response from switch_profile when authentication succeeds.
#[derive(Serialize)]
struct SwitchProfileResponse {
    name: String,
    /// Session token — present only when the profile is password-protected.
    session: Option<String>,
}

async fn switch_profile(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<SwitchProfilePayload>,
) -> Result<Json<SwitchProfileResponse>, (StatusCode, Json<ErrorResponse>)> {
    let profile = payload.name.trim().to_string();

    // Validate (unless default)
    if profile != "default" {
        database::validate_profile_name(&profile)
            .map_err(|e| err_response(StatusCode::BAD_REQUEST, e))?;
    }

    // ── Master password gate (create only) ──
    if payload.create {
        if let Some(ref hash) = state.master_password_hash {
            match &payload.master_password {
                Some(mp) if profile_auth::verify_password(mp, hash) => { /* ok */ }
                Some(_) => {
                    log::warn!("Failed master password attempt for profile creation '{}'", profile);
                    return Err(err_response(StatusCode::FORBIDDEN, "Invalid master password"));
                }
                None => {
                    return Err(err_response(StatusCode::FORBIDDEN, "Master password is required to create profiles"));
                }
            }
        }
    }

    // If this is a create request, reject if profile already exists
    if payload.create && database::profile_exists(&state.data_dir, &profile) {
        return Err(err_response(StatusCode::CONFLICT, format!("Profile '{}' already exists", profile)));
    }

    // ── Lockout check ──
    if state.sessions.is_locked_out(&profile) {
        return Err(err_response(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many failed attempts — please wait 60 seconds",
        ));
    }

    // ── Password verification for existing protected profiles ──
    if !payload.create && profile_auth::profile_is_protected(&state.data_dir, &profile) {
        match &payload.password {
            Some(pw) => {
                if let Err(msg) = profile_auth::verify_profile_password(&state.data_dir, &profile, pw) {
                    let locked = state.sessions.record_failure(&profile);
                    if locked {
                        log::warn!("Profile '{}' locked out after too many failed attempts", profile);
                    }
                    return Err(err_response(StatusCode::UNAUTHORIZED, msg));
                }
            }
            None => {
                return Err(err_response(StatusCode::UNAUTHORIZED, "Password is required for this profile"));
            }
        }
    }

    log::info!("Ensuring profile '{}' exists", profile);

    // Open (or create) the target database — this caches it in the pool
    state.db_for_profile(&profile)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to open profile '{}': {}", profile, e)))?;

    // Persist as the server-default active profile
    database::set_active_profile(&state.data_dir, &profile)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to persist profile: {}", e)))?;

    // ── Set password on newly created profile (if provided) ──
    if payload.create {
        if let Some(ref new_pw) = payload.new_password {
            if !new_pw.is_empty() {
                profile_auth::set_password(&state.data_dir, &profile, new_pw, None)
                    .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            }
        }
    }

    // ── Issue session token if profile is protected ──
    let session = if profile_auth::profile_is_protected(&state.data_dir, &profile) {
        Some(state.sessions.create_session(&profile))
    } else {
        None
    };

    log::info!("Profile '{}' ready", profile);
    Ok(Json(SwitchProfileResponse { name: profile, session }))
}

#[derive(Deserialize)]
struct DeleteProfileParams {
    name: String,
    password: Option<String>,
    master_password: Option<String>,
}

async fn delete_profile_endpoint(
    AxumState(state): AxumState<WebAppState>,
    Json(params): Json<DeleteProfileParams>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let profile = params.name.trim().to_string();

    if profile == "default" {
        return Err(err_response(StatusCode::BAD_REQUEST, "Cannot delete the default profile"));
    }

    // ── Master password gate ──
    if let Some(ref hash) = state.master_password_hash {
        match &params.master_password {
            Some(mp) if profile_auth::verify_password(mp, hash) => { /* ok */ }
            Some(_) => {
                log::warn!("Failed master password attempt for profile deletion '{}'", profile);
                return Err(err_response(StatusCode::FORBIDDEN, "Invalid master password"));
            }
            None => {
                return Err(err_response(StatusCode::FORBIDDEN, "Master password is required to delete profiles"));
            }
        }
    }

    // ── Profile password gate ──
    if profile_auth::profile_is_protected(&state.data_dir, &profile) {
        match &params.password {
            Some(pw) => {
                profile_auth::verify_profile_password(&state.data_dir, &profile, pw)
                    .map_err(|e| err_response(StatusCode::UNAUTHORIZED, e))?;
            }
            None => {
                return Err(err_response(StatusCode::UNAUTHORIZED, "Password is required to delete this profile"));
            }
        }
    }

    let active = database::get_active_profile(&state.data_dir);
    if active == profile {
        return Err(err_response(StatusCode::BAD_REQUEST, "Cannot delete the currently active profile. Switch to a different profile first."));
    }

    // Evict cached connection before deleting the file
    state.evict_profile(&profile);

    // Revoke any sessions for this profile
    state.sessions.revoke_profile(&profile);

    // Remove auth entry
    profile_auth::remove_auth_entry(&state.data_dir, &profile);

    database::delete_profile(&state.data_dir, &profile)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(true))
}

// ============================================================================
// PASSWORD MANAGEMENT
// ============================================================================

#[derive(Deserialize)]
struct SetPasswordPayload {
    profile: String,
    new_password: String,
    current_password: Option<String>,
    /// Session token for authenticated callers (used when changing password).
    session: Option<String>,
}

/// POST /api/profiles/set_password — Set or change a profile password.
/// Requires either a valid session token or the current password.
async fn set_profile_password(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<SetPasswordPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let profile = payload.profile.trim().to_string();

    // Verify caller identity: either session token or current password
    let authenticated = if let Some(ref token) = payload.session {
        state.sessions.validate(token).map(|p| p == profile).unwrap_or(false)
    } else {
        false
    };

    let cur_pw = if authenticated {
        // Already authenticated via session — allow change without re-entering current password
        // (unless one was explicitly provided, in which case verify it too)
        payload.current_password.as_deref()
    } else if profile_auth::has_password(&state.data_dir, &profile) {
        // Not authenticated via session — must provide current password
        match &payload.current_password {
            Some(pw) => Some(pw.as_str()),
            None => return Err(err_response(StatusCode::UNAUTHORIZED, "Current password is required")),
        }
    } else {
        None
    };

    profile_auth::set_password(&state.data_dir, &profile, &payload.new_password, cur_pw)
        .map_err(|e| err_response(StatusCode::UNAUTHORIZED, e))?;

    // Revoke existing sessions so the user must re-authenticate with the new password
    state.sessions.revoke_profile(&profile);

    Ok(Json(true))
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct RemovePasswordPayload {
    profile: String,
    current_password: String,
    session: Option<String>,
}

/// POST /api/profiles/remove_password — Remove a profile password.
async fn remove_profile_password(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<RemovePasswordPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let profile = payload.profile.trim().to_string();

    profile_auth::remove_password(&state.data_dir, &profile, &payload.current_password)
        .map_err(|e| err_response(StatusCode::UNAUTHORIZED, e))?;

    // Revoke sessions — profile is now unprotected, no session needed
    state.sessions.revoke_profile(&profile);

    Ok(Json(true))
}

/// GET /api/profiles/has_master_password — Check if PROFILE_CREATION_PASS is set.
/// The frontend uses this to decide whether to show the master password input.
async fn has_master_password(
    AxumState(state): AxumState<WebAppState>,
) -> Json<bool> {
    Json(state.master_password_hash.is_some())
}

// ============================================================================
// SUPPORTER BADGE (server-side verification)
// ============================================================================

/// The SHA-256 hash of the valid supporter code.
const SUPPORTER_HASH: &str =
    "5978f3e898c83b40c90017c88b8048f80a5acfd020bbd073af794e710603067d";

#[derive(Deserialize)]
struct VerifySupporterPayload {
    code: String,
}

/// POST /api/supporter/verify — Verify supporter code and persist state.
async fn verify_supporter_code(
    pdb: ProfileDb,
    Json(payload): Json<VerifySupporterPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    use sha2::{Sha256, Digest};

    let trimmed = payload.code.trim().to_string();
    if trimmed.is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Code must not be empty"));
    }

    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    let hash_bytes = hasher.finalize();
    let hash_hex: String = hash_bytes.iter().map(|b| format!("{:02x}", b)).collect();

    if hash_hex != SUPPORTER_HASH {
        return Ok(Json(false));
    }

    pdb.db
        .set_setting("supporter_badge_active", "true")
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save supporter state: {}", e)))?;
    pdb.db
        .set_setting("donation_acknowledged", "true")
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save donation state: {}", e)))?;

    Ok(Json(true))
}

/// GET /api/supporter/status — Read the supporter badge state.
async fn get_supporter_status(
    pdb: ProfileDb,
) -> Json<bool> {
    let active = pdb.db
        .get_setting("supporter_badge_active")
        .ok()
        .flatten()
        .as_deref() == Some("true");
    Json(active)
}

/// POST /api/supporter/remove — Remove the supporter badge.
async fn remove_supporter_badge(
    pdb: ProfileDb,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .set_setting("supporter_badge_active", "false")
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove supporter state: {}", e)))?;
    Ok(Json(true))
}

/// GET /api/supporter/donation — Read the donation-acknowledged flag.
async fn get_donation_acknowledged(
    pdb: ProfileDb,
) -> Json<bool> {
    let ack = pdb.db
        .get_setting("donation_acknowledged")
        .ok()
        .flatten()
        .as_deref() == Some("true");
    Json(ack)
}

#[derive(Deserialize)]
struct DonationAckPayload {
    acknowledged: bool,
}

/// POST /api/supporter/donation — Set the donation-acknowledged flag.
async fn set_donation_acknowledged(
    pdb: ProfileDb,
    Json(payload): Json<DonationAckPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    pdb.db
        .set_setting("donation_acknowledged", if payload.acknowledged { "true" } else { "false" })
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save donation state: {}", e)))?;
    Ok(Json(payload.acknowledged))
}

// ============================================================================
// SERVER SETUP
// ============================================================================

/// Build the Axum router with all API routes
pub fn build_router(state: WebAppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/import", post(import_log))
        .route("/api/manual_flight", post(create_manual_flight))
        .route("/api/flights", get(get_flights))
        .route("/api/flight_data", get(get_flight_data))
        .route("/api/overview", get(get_overview_stats))
        .route("/api/battery_capacity_history", get(get_battery_full_capacity_history))
        .route("/api/flights/delete", delete(delete_flight))
        .route("/api/flights/delete_all", delete(delete_all_flights))
        .route("/api/flights/deduplicate", post(deduplicate_flights))
        .route("/api/flights/name", put(update_flight_name))
        .route("/api/flights/notes", put(update_flight_notes))
        .route("/api/flights/color", put(update_flight_color))
        .route("/api/flights/tags/add", post(add_flight_tag))
        .route("/api/flights/tags/remove", post(remove_flight_tag))
        .route("/api/tags", get(get_all_tags))
        .route("/api/tags/remove_auto", post(remove_all_auto_tags))
        .route("/api/settings/smart_tags", get(get_smart_tags_enabled))
        .route("/api/settings/smart_tags", post(set_smart_tags_enabled))
        .route("/api/settings/enabled_tag_types", get(get_enabled_tag_types))
        .route("/api/settings/enabled_tag_types", post(set_enabled_tag_types))
        .route("/api/settings/value", get(get_setting_value))
        .route("/api/settings/value", post(set_setting_value))
        .route("/api/regenerate_smart_tags", post(regenerate_smart_tags))
        .route("/api/regenerate_flight_smart_tags/:id", post(regenerate_flight_smart_tags))
        .route("/api/has_api_key", get(has_api_key))
        .route("/api/api_key_type", get(get_api_key_type))
        .route("/api/set_api_key", post(set_api_key))
        .route("/api/remove_api_key", delete(remove_api_key))
        .route("/api/app_data_dir", get(get_app_data_dir))
        .route("/api/battery_pairs", get(get_battery_pairs))
        .route("/api/app_log_dir", get(get_app_log_dir))
        .route("/api/allowed_log_extensions", get(get_allowed_log_extensions))
        .route("/api/backup", get(export_backup))
        .route("/api/backup/restore", post(import_backup))
        .route("/api/sync/config", get(get_sync_config))
        .route("/api/sync/blacklist", get(get_sync_blacklist).post(add_sync_blacklist).delete(remove_sync_blacklist))
        .route("/api/sync/blacklist/details", get(get_sync_blacklist_details))
        .route("/api/sync/blacklist/all", delete(clear_sync_blacklist))
        .route("/api/sync/log_event", post(sync_log_event))
        .route("/api/sync/files", get(get_sync_files))
        .route("/api/sync/file", post(sync_single_file))
        .route("/api/sync", post(sync_from_folder))
        .route("/api/equipment_names", get(get_equipment_names))
        .route("/api/equipment_names", post(set_equipment_name))
        .route("/api/profiles", get(list_profiles))
        .route("/api/profiles/active", get(get_active_profile))
        .route("/api/profiles/switch", post(switch_profile))
        .route("/api/profiles/delete", post(delete_profile_endpoint))
        .route("/api/profiles/set_password", post(set_profile_password))
        .route("/api/profiles/remove_password", post(remove_profile_password))
        .route("/api/profiles/has_master_password", get(has_master_password))
        .route("/api/supporter/verify", post(verify_supporter_code))
        .route("/api/supporter/status", get(get_supporter_status))
        .route("/api/supporter/remove", post(remove_supporter_badge))
        .route("/api/supporter/donation", get(get_donation_acknowledged))
        .route("/api/supporter/donation", post(set_donation_acknowledged))
        .layer(cors)
        .layer(DefaultBodyLimit::max(250 * 1024 * 1024)) // 250 MB
        .with_state(state)
}

/// Start the Axum web server
pub async fn start_server(data_dir: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(e) = crate::battery_pairs::ensure_battery_pair_file(&data_dir) {
        log::warn!("Failed to initialize battery-pair.json: {}", e);
    }

    // Optionally initialize the default profile password from env on first startup.
    // This is one-time and non-destructive: existing passwords are never overwritten.
    match std::env::var("DEFAULT_PROFILE_PASSWORD") {
        Ok(default_pw) => {
            if profile_auth::has_password(&data_dir, "default") {
                log::info!(
                    "Skipped DEFAULT_PROFILE_PASSWORD: default profile already has a password set"
                );
            } else if default_pw.is_empty() {
                log::info!(
                    "DEFAULT_PROFILE_PASSWORD is empty and no existing default profile password was found; default profile remains without a password"
                );
            } else if let Err(e) = profile_auth::set_password(&data_dir, "default", &default_pw, None) {
                log::warn!(
                    "Failed to set default profile password from DEFAULT_PROFILE_PASSWORD: {}",
                    e
                );
            } else {
                log::info!(
                    "Set default profile password from DEFAULT_PROFILE_PASSWORD (first-time initialization)"
                );
            }
            // Remove plaintext from process environment after startup handling.
            std::env::remove_var("DEFAULT_PROFILE_PASSWORD");
        }
        Err(_) => {
            log::debug!("DEFAULT_PROFILE_PASSWORD not set; leaving default profile password unchanged");
        }
    }

    // Read persisted active profile
    let profile = database::get_active_profile(&data_dir);
    log::info!("Active profile: {}", profile);

    let db = Database::new(data_dir.clone(), &profile)?;

    crate::plugins::log_plugin_registration(&data_dir);
    let allowed_extensions = crate::plugins::get_allowed_extensions(&data_dir);
    log::info!("Allowed import extensions at startup: {:?}", allowed_extensions);

    let mut initial_pool = HashMap::new();
    initial_pool.insert(profile, Arc::new(db));
    // ── Hash the master password at startup, then clear the env var ──
    let master_password_hash = match std::env::var("PROFILE_CREATION_PASS") {
        Ok(val) if !val.is_empty() => {
            let hash = profile_auth::hash_password(&val)
                .expect("Failed to hash PROFILE_CREATION_PASS");
            // Remove plaintext from process environment
            std::env::remove_var("PROFILE_CREATION_PASS");
            log::info!("Master password (PROFILE_CREATION_PASS) hashed and env var cleared");
            Some(hash)
        }
        _ => None,
    };

    let state = WebAppState {
        databases: Arc::new(std::sync::RwLock::new(initial_pool)),
        data_dir,
        sessions: Arc::new(SessionStore::new()),
        master_password_hash,
    };

    // Start the scheduled sync if SYNC_INTERVAL and SYNC_LOGS_PATH are configured
    if let (Ok(sync_path), Ok(sync_interval)) = (
        std::env::var("SYNC_LOGS_PATH"),
        std::env::var("SYNC_INTERVAL"),
    ) {
        log::info!("Scheduled sync enabled: path={}, interval={}", sync_path, sync_interval);
        let scheduler_state = state.clone();
        
        tokio::spawn(async move {
            if let Err(e) = start_sync_scheduler(scheduler_state, &sync_interval).await {
                log::error!("Failed to start sync scheduler: {}", e);
            }
        });
    } else if std::env::var("SYNC_LOGS_PATH").is_ok() {
        log::info!("SYNC_LOGS_PATH configured but SYNC_INTERVAL not set. Sync is manual-only (via Sync button in web interface).");
    }

    let router = build_router(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let addr = format!("{}:{}", host, port);

    log::info!("Starting Open DroneLog web server on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

/// Start the cron scheduler for automatic folder sync
async fn start_sync_scheduler(state: WebAppState, cron_expr: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sched = JobScheduler::new().await?;
    
    // Validate cron expression
    let cron_schedule = cron_expr.parse::<cron::Schedule>()
        .map_err(|e| format!("Invalid cron expression '{}': {}", cron_expr, e))?;
    
    // Log next few scheduled times for debugging
    let upcoming: Vec<_> = cron_schedule.upcoming(chrono::Utc).take(3).collect();
    log::info!("Next scheduled sync times: {:?}", upcoming);
    
    let state_clone = state.clone();
    let cron_expr_owned = cron_expr.to_string();
    
    let job = Job::new_async(cron_expr_owned.as_str(), move |_uuid, _lock| {
        let state = state_clone.clone();
        Box::pin(async move {
            log::info!("[SYNC][SCHEDULED] Starting scheduled folder sync...");
            match run_scheduled_sync(&state).await {
                Ok((processed, skipped, errors)) => {
                    log::info!(
                        "[SYNC][SCHEDULED] Scheduled sync complete: {} imported, {} skipped, {} errors",
                        processed, skipped, errors
                    );
                }
                Err(e) => {
                    log::error!("[SYNC][SCHEDULED] Scheduled sync failed: {}", e);
                }
            }
        })
    })?;
    
    sched.add(job).await?;
    sched.start().await?;
    
    log::info!("Sync scheduler started with cron expression: {}", cron_expr);
    
    // Keep the scheduler running
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}

/// Run the folder sync operation for ALL profiles (called by scheduler).
/// Each profile syncs from its own subfolder: base for "default", base/{profile} for others.
async fn run_scheduled_sync(state: &WebAppState) -> Result<(usize, usize, usize), String> {
    let _base_sync = std::env::var("SYNC_LOGS_PATH")
        .map_err(|_| "SYNC_LOGS_PATH not configured".to_string())?;

    let profiles = database::list_profiles(&state.data_dir);
    log::info!("[SYNC][SCHEDULED] Scheduled sync run started: profiles={}.", profiles.len());
    let allowed_extensions: std::collections::HashSet<String> = crate::plugins::get_allowed_extensions(&state.data_dir)
        .into_iter()
        .collect();
    let mut total_processed = 0usize;
    let mut total_skipped = 0usize;
    let mut total_errors = 0usize;

    for profile in &profiles {
        let sync_dir = match database::sync_path_for_profile(profile) {
            Some(p) => p,
            None => continue,
        };

        // Skip profiles whose sync folder doesn't exist (don't auto-create for scheduled sync)
        if !sync_dir.exists() {
            continue;
        }

        let entries = match std::fs::read_dir(&sync_dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Scheduled sync: Failed to read {} for profile '{}': {}", sync_dir.display(), profile, e);
                total_errors += 1;
                continue;
            }
        };

        let log_files: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        let name = entry.file_name().to_string_lossy().to_lowercase();
                        return has_allowed_extension(&name, &allowed_extensions);
                    }
                }
                false
            })
            .map(|entry| entry.path())
            .collect();

        if log_files.is_empty() {
            log::debug!("[SYNC][SCHEDULED][{}] no files with allowed extensions in {}", profile, sync_dir.display());
            continue;
        }

        // Get (or create) the DB for this profile
        let db = match state.db_for_profile(profile) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("Scheduled sync: Failed to open DB for profile '{}': {}", profile, e);
                total_errors += 1;
                continue;
            }
        };

        // Pre-filter to only new files by hash: skip already-imported and blacklisted files.
        let existing_hashes: std::collections::HashSet<String> = db
            .get_all_file_hashes()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let blacklisted_hashes: std::collections::HashSet<String> = db
            .get_sync_blacklist_hashes()
            .unwrap_or_default()
            .into_iter()
            .collect();

        let mut new_log_files: Vec<PathBuf> = Vec::new();
        let mut skipped_existing = 0usize;
        let mut skipped_blacklisted = 0usize;
        let mut skipped_hash_error = 0usize;

        for file_path in &log_files {
            match compute_file_hash(file_path) {
                Ok(hash) => {
                    if existing_hashes.contains(&hash) {
                        skipped_existing += 1;
                        total_skipped += 1;
                        continue;
                    }
                    if blacklisted_hashes.contains(&hash) {
                        skipped_blacklisted += 1;
                        total_skipped += 1;
                        continue;
                    }
                    new_log_files.push(file_path.clone());
                }
                Err(e) => {
                    skipped_hash_error += 1;
                    total_errors += 1;
                    log::warn!(
                        "[SYNC][SCHEDULED][{}] hash failed for {}: {}",
                        profile,
                        file_path.display(),
                        e
                    );
                }
            }
        }

        log::debug!(
            "[SYNC][SCHEDULED][{}] candidates={}, new={}, skipped_existing={}, skipped_blacklisted={}, hash_errors={}",
            profile,
            log_files.len(),
            new_log_files.len(),
            skipped_existing,
            skipped_blacklisted,
            skipped_hash_error
        );

        if new_log_files.is_empty() {
            continue;
        }

        let parser = LogParser::new(&db);

        // Load per-profile smart tags config
        let config_path = database::config_path_for_profile(&state.data_dir, profile);
        let config = crate::models::load_profile_config(&config_path);
        let apply_cooldown = should_apply_sync_cooldown(&config_path);

        for (index, file_path) in new_log_files.iter().enumerate() {
            let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

            let parse_result = match parser.parse_log(file_path).await {
                Ok(result) => result,
                Err(crate::parser::ParserError::AlreadyImported(_)) => {
                    total_skipped += 1;
                    continue;
                }
                Err(e) => {
                    log::warn!("[SYNC][SCHEDULED][{}] Failed to parse {}: {}", profile, file_name, e);
                    total_errors += 1;
                    continue;
                }
            };

            // Check for duplicate flight
            if db.is_duplicate_flight(
                parse_result.metadata.drone_serial.as_deref(),
                parse_result.metadata.battery_serial.as_deref(),
                parse_result.metadata.start_time,
            ).unwrap_or(None).is_some() {
                total_skipped += 1;
                continue;
            }

            // Insert flight
            let flight_id = match db.insert_flight(&parse_result.metadata) {
                Ok(id) => id,
                Err(e) => {
                    log::warn!("[SYNC][SCHEDULED][{}] Failed to insert flight from {}: {}", profile, file_name, e);
                    total_errors += 1;
                    continue;
                }
            };

            // Insert telemetry
            if let Err(e) = db.bulk_insert_telemetry(flight_id, &parse_result.points) {
                log::warn!("[SYNC][SCHEDULED][{}] Failed to insert telemetry for {}: {}", profile, file_name, e);
                let _ = db.delete_flight(flight_id);
                total_errors += 1;
                continue;
            }

            // Run all post-import steps (smart tags, manual tags, profile tags,
            // notes, color, messages, and customization restore)
            crate::parser::run_post_import_steps(&db, flight_id, &parse_result, &config, profile);

            total_processed += 1;
            log::debug!("[SYNC][SCHEDULED][{}] Imported {}", profile, file_name);

            // Apply default-key cooldown between successful imports.
            if apply_cooldown && index < new_log_files.len().saturating_sub(1) {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        }
    }

    log::info!(
        "[SYNC][SCHEDULED] Scheduled sync run finished: imported={}, skipped={}, errors={}",
        total_processed,
        total_skipped,
        total_errors
    );

    Ok((total_processed, total_skipped, total_errors))
}
