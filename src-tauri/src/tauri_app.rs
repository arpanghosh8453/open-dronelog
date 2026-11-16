    use std::path::{Path, PathBuf};
    use std::sync::{Arc, RwLock};

    use tauri::{AppHandle, Emitter, Manager, State};
    use tauri_plugin_log::{Target, TargetKind};
    use log::LevelFilter;
    use serde::Serialize;

    use crate::database::{self, Database, DatabaseError};
    use crate::models::{
        BatteryHealthPoint, BatteryUsage, Flight, FlightDataResponse, FlightDateCount, FlightTag,
        ImportResult, OverviewStats, TelemetryData, TopDistanceFlight, TopFlight, DroneUsage,
    };
    use crate::parser::LogParser;
    use crate::api::DjiApi;
    use crate::profile_auth;

    /// Application state containing the database connection (swappable for profile switching)
    pub struct AppState {
        active_db: RwLock<Arc<Database>>,
        pub data_dir: PathBuf,
        /// When true, data commands are blocked until the user authenticates.
        locked: RwLock<bool>,
    }

    #[derive(Serialize, Clone)]
    struct BackupProgressPayload {
        operation: String,
        percent: u8,
        stage: String,
    }

    fn emit_backup_progress(app: &AppHandle, operation: &str, percent: u8, stage: &str) {
        let payload = BackupProgressPayload {
            operation: operation.to_string(),
            percent,
            stage: stage.to_string(),
        };
        let _ = app.emit("backup-progress", payload);
    }

    impl AppState {
        /// Get a reference-counted handle to the current database (unchecked — for internal/close-hook use).
        pub fn db(&self) -> Arc<Database> {
            self.active_db.read().unwrap().clone()
        }

        /// Get the database only if the app is not locked.  All data-access commands should use this.
        pub fn db_authenticated(&self) -> Result<Arc<Database>, String> {
            if *self.locked.read().unwrap() {
                return Err("Profile is locked — please authenticate first".to_string());
            }
            Ok(self.active_db.read().unwrap().clone())
        }

        /// Swap the active database (used for profile switching).
        pub fn swap_db(&self, new_db: Database) {
            *self.active_db.write().unwrap() = Arc::new(new_db);
        }

        /// Lock the app (block data access until authentication).
        #[allow(dead_code)]
        pub fn lock(&self) {
            *self.locked.write().unwrap() = true;
        }

        /// Unlock the app after successful authentication.
        pub fn unlock(&self) {
            *self.locked.write().unwrap() = false;
        }

        /// Check if the app is locked.
        #[allow(dead_code)]
        pub fn is_locked(&self) -> bool {
            *self.locked.read().unwrap()
        }

        /// Get the config file path for the currently active profile.
        pub fn config_path(&self) -> PathBuf {
            let profile = database::get_active_profile(&self.data_dir);
            database::config_path_for_profile(&self.data_dir, &profile)
        }

        /// Get the default upload folder for the currently active profile.
        pub fn default_upload_folder(&self) -> PathBuf {
            let profile = database::get_active_profile(&self.data_dir);
            database::default_upload_folder(&self.data_dir, &profile)
        }
    }

    /// Get the app data directory for storing the database and logs
    fn app_data_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))
    }

    /// Migrate data from old app identifier (com.dji-logviewer) to new one (com.drone-logbook)
    /// This preserves user data when upgrading from older versions
    fn migrate_old_data(new_data_dir: &PathBuf) -> Result<(), String> {
        // Determine the old data directory path based on platform
        let old_data_dir = if cfg!(target_os = "macos") {
            dirs::data_dir().map(|d| d.join("com.dji-logviewer.app"))
        } else if cfg!(target_os = "windows") {
            dirs::data_local_dir().map(|d| d.join("com.dji-logviewer.app"))
        } else {
            // Linux: ~/.local/share/com.dji-logviewer.app
            dirs::data_dir().map(|d| d.join("com.dji-logviewer.app"))
        };

        let old_data_dir = match old_data_dir {
            Some(dir) => dir,
            None => {
                log::debug!("Could not determine old data directory path");
                return Ok(());
            }
        };

        // Check if old directory exists and new one doesn't have data yet
        if !old_data_dir.exists() {
            log::debug!("No old data directory found at {:?}", old_data_dir);
            return Ok(());
        }

        let old_db_path = old_data_dir.join("flights.db");
        let new_db_path = new_data_dir.join("flights.db");

        // Only migrate if old DB exists and new DB doesn't
        if !old_db_path.exists() {
            log::debug!("No old database found at {:?}", old_db_path);
            return Ok(());
        }

        if new_db_path.exists() {
            log::info!("New database already exists, skipping migration");
            return Ok(());
        }

        log::info!("Migrating data from {:?} to {:?}", old_data_dir, new_data_dir);

        // Create new data directory if it doesn't exist
        std::fs::create_dir_all(new_data_dir)
            .map_err(|e| format!("Failed to create new data directory: {}", e))?;

        // Copy all files from old directory to new directory
        for entry in std::fs::read_dir(&old_data_dir)
            .map_err(|e| format!("Failed to read old data directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let file_name = entry.file_name();
            let old_path = entry.path();
            let new_path = new_data_dir.join(&file_name);

            if old_path.is_dir() {
                // Recursively copy directories (e.g., keychains/)
                copy_dir_recursive(&old_path, &new_path)?;
            } else {
                // Copy files
                std::fs::copy(&old_path, &new_path)
                    .map_err(|e| format!("Failed to copy {:?}: {}", file_name, e))?;
            }
            log::debug!("Migrated: {:?}", file_name);
        }

        log::info!("Successfully migrated all data from old location");
        Ok(())
    }

    /// Recursively copy a directory
    fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create directory {:?}: {}", dst, e))?;

        for entry in std::fs::read_dir(src)
            .map_err(|e| format!("Failed to read directory {:?}: {}", src, e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());

            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dst_path)?;
            } else {
                std::fs::copy(&src_path, &dst_path)
                    .map_err(|e| format!("Failed to copy {:?}: {}", src_path, e))?;
            }
        }
        Ok(())
    }

    /// Initialize the database in the app data directory
    fn init_database(app: &AppHandle) -> Result<Database, String> {
        let data_dir = app_data_dir_path(app)?;
        log::info!("Initializing database in: {:?}", data_dir);

        if let Err(e) = crate::battery_pairs::ensure_battery_pair_file(&data_dir) {
            log::warn!("Failed to initialize battery-pair.json: {}", e);
        } else {
            let pairs = crate::battery_pairs::load_battery_pairs(&data_dir);
            log::info!("Loaded {} battery pair definitions", pairs.len());
        }

        // Attempt to migrate data from old app identifier
        if let Err(e) = migrate_old_data(&data_dir) {
            log::warn!("Migration from old data directory failed: {}", e);
            // Continue anyway - this is not fatal
        }

        // Read persisted active profile
        let profile = database::get_active_profile(&data_dir);
        log::info!("Active profile: {}", profile);

        Database::new(data_dir, &profile).map_err(|e| format!("Failed to initialize database: {}", e))
    }

    #[tauri::command]
    pub async fn import_log(file_path: String, state: State<'_, AppState>) -> Result<ImportResult, String> {
        let import_start = std::time::Instant::now();
        log::info!("Importing log file: {}", file_path);

        let path = PathBuf::from(&file_path);

        if !path.exists() {
            log::warn!("File not found: {}", file_path);
            return Ok(ImportResult {
                success: false,
                flight_id: None,
                message: "File not found".to_string(),
                point_count: 0,
                file_hash: None,
            });
        }

        // Load config early for keep_uploaded_files setting
        let config_path = state.config_path();
        let config = crate::models::load_profile_config(&config_path);
        let keep_enabled = config.get("keep_uploaded_files").and_then(|v| v.as_bool()).unwrap_or(true);
        let default_folder = state.default_upload_folder();
        let upload_folder = config.get("uploaded_files_path")
            .and_then(|v| v.as_str())
            .map(|s| PathBuf::from(s))
            .unwrap_or(default_folder);

        // Helper to copy uploaded file if setting is enabled
        let try_copy_file = |file_hash: Option<&str>| {
            if keep_enabled {
                if let Err(e) = copy_uploaded_file(&path, &upload_folder, file_hash) {
                    log::warn!("Failed to copy uploaded file: {}", e);
                }
            }
        };

        let db = state.db_authenticated()?;
        let parser = LogParser::new(&db);

        let parse_result = match parser.parse_log(&path).await {
            Ok(result) => result,
            Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
                log::info!("Skipping already-imported file: {} — matches flight '{}' in database", file_path, matching_flight);
                // Compute file hash so copy_uploaded_file can properly deduplicate
                let file_hash = LogParser::calculate_file_hash(&path).ok();
                try_copy_file(file_hash.as_deref());
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("This flight log has already been imported (matches: {})", matching_flight),
                    point_count: 0,
                    file_hash,
                });
            }
            Err(e) => {
                log::error!("Failed to parse log {}: {}", file_path, e);
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("Failed to parse log: {}", e),
                    point_count: 0,
                    file_hash: None,
                });
            }
        };

        // Check for duplicate flight based on signature (drone_serial + battery_serial + start_time)
        if let Some(matching_flight) = db.is_duplicate_flight(
            parse_result.metadata.drone_serial.as_deref(),
            parse_result.metadata.battery_serial.as_deref(),
            parse_result.metadata.start_time,
        ).unwrap_or(None) {
            log::info!("Skipping duplicate flight (signature match): {} - matches flight '{}' in database", file_path, matching_flight);
            // Still copy the file even though flight is a duplicate
            try_copy_file(parse_result.metadata.file_hash.as_deref());
            return Ok(ImportResult {
                success: false,
                flight_id: None,
                message: format!("Duplicate flight: matches '{}' (same drone, battery, and start time)", matching_flight),
                point_count: 0,
                file_hash: parse_result.metadata.file_hash.clone(),
            });
        }

        log::debug!("Inserting flight metadata: id={}", parse_result.metadata.id);
        let flight_id = db
            .insert_flight(&parse_result.metadata)
            .map_err(|e| format!("Failed to insert flight: {}", e))?;

        let point_count = match db
            .bulk_insert_telemetry(flight_id, &parse_result.points)
        {
            Ok(count) => count,
            Err(e) => {
                log::error!("Failed to insert telemetry for flight {}: {}. Cleaning up.", flight_id, e);
                if let Err(cleanup_err) = db.delete_flight(flight_id) {
                    log::error!("Failed to clean up flight {}: {}", flight_id, cleanup_err);
                }
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("Failed to insert telemetry data: {}", e),
                    point_count: 0,
                    file_hash: parse_result.metadata.file_hash.clone(),
                });
            }
        };

        // Run all post-import steps (smart tags, manual tags, profile tags,
        // notes, color, messages, and customization restore)
        let config_path = state.config_path();
        let config = crate::models::load_profile_config(&config_path);
        let profile = database::get_active_profile(&state.data_dir);
        crate::parser::run_post_import_steps(&db, flight_id, &parse_result, &config, &profile);

        log::info!(
            "Successfully imported flight {} with {} points in {:.1}s",
            flight_id,
            point_count,
            import_start.elapsed().as_secs_f64()
        );

        // Copy uploaded file if setting is enabled
        try_copy_file(parse_result.metadata.file_hash.as_deref());

        Ok(ImportResult {
            success: true,
            flight_id: Some(flight_id),
            message: format!("Successfully imported {} telemetry points", point_count),
            point_count,
            file_hash: parse_result.metadata.file_hash.clone(),
        })
    }

    #[tauri::command]
    pub async fn import_log_bytes(
        file_name: String,
        file_bytes: Vec<u8>,
        state: State<'_, AppState>,
    ) -> Result<ImportResult, String> {
        let safe_name = Path::new(&file_name)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("import.log");

        // Keep the original file name so default flight names are preserved.
        // Use a unique temp subdirectory within the app's data directory to avoid collisions
        // and bypass OS restrictions on the global temp folder on customized Android devices like DJI RC Pro.
        let temp_dir = state.data_dir.join("temp").join(format!("odl_mobile_import_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create import staging directory: {}", e))?;
        let temp_path = temp_dir.join(safe_name);

        std::fs::write(&temp_path, &file_bytes)
            .map_err(|e| format!("Failed to stage imported file: {}", e))?;
        // Release uploaded bytes before parse/import work starts.
        drop(file_bytes);

        let result = import_log(temp_path.to_string_lossy().to_string(), state).await;

        if let Err(e) = std::fs::remove_file(&temp_path) {
            log::debug!("Failed to clean up temporary import file {:?}: {}", temp_path, e);
        }
        if let Err(e) = std::fs::remove_dir(&temp_dir) {
            log::debug!("Failed to clean up temporary import directory {:?}: {}", temp_dir, e);
        }

        result
    }

    fn empty_overview_stats() -> OverviewStats {
        OverviewStats {
            total_flights: 0,
            total_distance_m: 0.0,
            total_duration_secs: 0.0,
            total_points: 0,
            total_photos: 0,
            total_videos: 0,
            max_altitude_m: 0.0,
            max_distance_from_home_m: 0.0,
            batteries_used: Vec::<BatteryUsage>::new(),
            drones_used: Vec::<DroneUsage>::new(),
            flights_by_date: Vec::<FlightDateCount>::new(),
            top_flights: Vec::<TopFlight>::new(),
            top_distance_flights: Vec::<TopDistanceFlight>::new(),
            battery_health_points: Vec::<BatteryHealthPoint>::new(),
        }
    }

    /// Create a manual flight entry without importing a log file
    /// Used for flights where no log file is available
    #[tauri::command]
    pub async fn create_manual_flight(
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
        state: State<'_, AppState>,
    ) -> Result<ImportResult, String> {
        use chrono::DateTime;
        
        log::info!("Creating manual flight entry: {} @ {}", aircraft_name, start_time);

        // Parse the start time
        let parsed_start_time = DateTime::parse_from_rfc3339(&start_time)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .map_err(|e| format!("Invalid start time format: {}", e))?;

        // Calculate end time
        let end_time = parsed_start_time + chrono::Duration::seconds(duration_secs as i64);

        // Create flight metadata
        // Use flight_title if provided, otherwise fallback to aircraft_name
        let display_name = flight_title
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.clone())
            .unwrap_or_else(|| aircraft_name.clone());
        
        let flight_id = state.db_authenticated()?.generate_flight_id();
        let metadata = crate::models::FlightMetadata {
            id: flight_id,
            file_name: format!("manual_entry_{}.log", flight_id),
            display_name,
            file_hash: None, // Manual entries have no file hash
            drone_model: Some(format!("Manual Entry ({})", aircraft_name)),
            drone_serial: Some(drone_serial.trim().to_uppercase()),
            aircraft_name: Some(aircraft_name),
            battery_serial: Some(battery_serial.trim().to_uppercase()),
            cycle_count: None,
            rc_serial: None,
            battery_life: None,
            start_time: Some(parsed_start_time),
            end_time: Some(end_time),
            duration_secs: Some(duration_secs),
            total_distance,
            max_altitude,
            max_speed: None,
            home_lat: Some(home_lat),
            home_lon: Some(home_lon),
            point_count: 0, // No telemetry points for manual entries
            photo_count: 0,
            video_count: 0,
        };

        // Insert flight
        state
            .db_authenticated()?
            .insert_flight(&metadata)
            .map_err(|e| format!("Failed to insert flight: {}", e))?;

        // Update notes if provided
        if let Some(notes_text) = notes {
            if !notes_text.trim().is_empty() {
                state
                    .db_authenticated()?
                    .update_flight_notes(flight_id, Some(&notes_text))
                    .map_err(|e| format!("Failed to add notes: {}", e))?;
            }
        }

        // Add "Manual Entry" tag
        let tags = vec!["Manual Entry".to_string()];
        if let Err(e) = state.db_authenticated()?.insert_flight_tags(flight_id, &tags) {
            log::warn!("Failed to add tags: {}", e);
        }

        // Generate smart tags based on location
        let stats = crate::models::FlightStats {
            duration_secs,
            total_distance_m: total_distance.unwrap_or(0.0),
            max_altitude_m: max_altitude.unwrap_or(0.0),
            max_speed_ms: 0.0,
            avg_speed_ms: 0.0,
            min_battery: 100,
            home_location: Some([home_lon, home_lat]),
            max_distance_from_home_m: 0.0,
            start_battery_percent: None,
            end_battery_percent: None,
            start_battery_temp: None,
        };
        
        let smart_tags = crate::parser::LogParser::generate_smart_tags(&metadata, &stats);
        if !smart_tags.is_empty() {
            if let Err(e) = state.db_authenticated()?.insert_flight_tags(flight_id, &smart_tags) {
                log::warn!("Failed to add smart tags: {}", e);
            }
        }

        log::info!("Successfully created manual flight entry with ID: {}", flight_id);

        Ok(ImportResult {
            success: true,
            flight_id: Some(flight_id),
            message: "Manual flight entry created successfully".to_string(),
            point_count: 0,
            file_hash: None,
        })
    }

    /// Compute SHA256 hash of a file without importing it
    /// Used to check if a file is blacklisted before importing
    #[tauri::command]
    pub fn compute_file_hash(file_path: String) -> Result<String, String> {
        let path = PathBuf::from(&file_path);
        if !path.exists() {
            return Err("File not found".to_string());
        }
        LogParser::calculate_file_hash(&path)
            .map_err(|e| format!("Failed to compute hash: {}", e))
    }

    #[tauri::command]
    pub async fn get_allowed_log_extensions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        Ok(crate::plugins::get_allowed_extensions(&state.data_dir))
    }

    #[tauri::command]
    pub async fn get_sync_blacklist(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        state
            .db_authenticated()?
            .get_sync_blacklist_hashes()
            .map_err(|e| format!("Failed to get sync blacklist: {}", e))
    }

    #[tauri::command]
    pub async fn add_to_sync_blacklist(file_hash: String, state: State<'_, AppState>) -> Result<bool, String> {
        state
            .db_authenticated()?
            .add_to_sync_blacklist(&file_hash)
            .map(|_| true)
            .map_err(|e| format!("Failed to add to sync blacklist: {}", e))
    }

    #[tauri::command]
    pub async fn remove_from_sync_blacklist(file_hash: String, state: State<'_, AppState>) -> Result<bool, String> {
        state
            .db_authenticated()?
            .remove_from_sync_blacklist(&file_hash)
            .map(|_| true)
            .map_err(|e| format!("Failed to remove from sync blacklist: {}", e))
    }

    #[tauri::command]
    pub async fn clear_sync_blacklist(state: State<'_, AppState>) -> Result<bool, String> {
        state
            .db_authenticated()?
            .clear_sync_blacklist()
            .map(|_| true)
            .map_err(|e| format!("Failed to clear sync blacklist: {}", e))
    }

    #[tauri::command]
    pub async fn get_flights(state: State<'_, AppState>) -> Result<Vec<Flight>, String> {
        let start = std::time::Instant::now();
        let flights = state
            .db_authenticated()?
            .get_all_flights()
            .map_err(|e| format!("Failed to get flights: {}", e))?;
        log::debug!("get_flights returned {} flights in {:.1}ms", flights.len(), start.elapsed().as_secs_f64() * 1000.0);
        Ok(flights)
    }

    #[tauri::command]
    pub async fn get_flight_data(
        flight_id: i64,
        max_points: Option<usize>,
        state: State<'_, AppState>,
    ) -> Result<FlightDataResponse, String> {
        let start = std::time::Instant::now();
        log::debug!("Fetching flight data for ID: {} (max_points: {:?})", flight_id, max_points);

        let db = state.db_authenticated()?;
        let flight = db
            .get_flight_by_id(flight_id)
            .map_err(|e| match e {
                DatabaseError::FlightNotFound(id) => format!("Flight {} not found", id),
                _ => format!("Failed to get flight: {}", e),
            })?;

        let known_point_count = flight.point_count.map(|c| c as i64);

        let telemetry_records = db
            .get_flight_telemetry(flight_id, max_points, known_point_count)
            .map_err(|e| match e {
                DatabaseError::FlightNotFound(id) => format!("Flight {} not found", id),
                _ => format!("Failed to get telemetry: {}", e),
            })?;

        let telemetry = TelemetryData::from_records(&telemetry_records);
        let track = telemetry.extract_track(2000);

        // Get flight messages (tips and warnings)
        let messages = db
            .get_flight_messages(flight_id)
            .unwrap_or_else(|e| {
                log::warn!("Failed to get messages for flight {}: {}", flight_id, e);
                Vec::new()
            });

        log::debug!(
            "get_flight_data for flight {} complete in {:.1}ms: {} telemetry series, {} track points, {} messages",
            flight_id,
            start.elapsed().as_secs_f64() * 1000.0,
            telemetry_records.len(),
            track.len(),
            messages.len()
        );

        Ok(FlightDataResponse {
            flight,
            telemetry,
            track,
            messages,
        })
    }

    #[tauri::command]
    pub async fn get_overview_stats(state: State<'_, AppState>) -> Result<OverviewStats, String> {
        let start = std::time::Instant::now();
        let stats = match state.db_authenticated()?.get_overview_stats() {
            Ok(stats) => stats,
            Err(e) => {
                let err_msg = e.to_string().to_lowercase();
                if cfg!(target_os = "android")
                    && (err_msg.contains("icu") || err_msg.contains("home_directory"))
                {
                    log::warn!(
                        "Overview query hit DuckDB Android runtime limitation ({}). Returning empty overview.",
                        e
                    );
                    empty_overview_stats()
                } else {
                    return Err(format!("Failed to get overview stats: {}", e));
                }
            }
        };
        log::debug!(
            "get_overview_stats complete in {:.1}ms: {} flights, {:.0}m total distance",
            start.elapsed().as_secs_f64() * 1000.0,
            stats.total_flights,
            stats.total_distance_m
        );
        Ok(stats)
    }

    #[tauri::command]
    pub async fn get_battery_full_capacity_history(
        battery_serial: String,
        state: State<'_, AppState>,
    ) -> Result<Vec<(i64, String, f64)>, String> {
        state
            .db_authenticated()?
            .get_battery_full_capacity_history(&battery_serial)
            .map_err(|e| format!("Failed to get battery capacity history: {}", e))
    }

    #[tauri::command]
    pub async fn delete_flight(flight_id: i64, state: State<'_, AppState>) -> Result<bool, String> {
        log::info!("Deleting flight: {}", flight_id);
        state
            .db_authenticated()?
            .delete_flight(flight_id)
            .map(|_| true)
            .map_err(|e| format!("Failed to delete flight: {}", e))
    }

    #[tauri::command]
    pub async fn delete_all_flights(state: State<'_, AppState>) -> Result<bool, String> {
        log::warn!("Deleting ALL flights and telemetry");
        state
            .db_authenticated()?
            .delete_all_flights()
            .map(|_| true)
            .map_err(|e| format!("Failed to delete all flights: {}", e))
    }

    #[tauri::command]
    pub async fn deduplicate_flights(state: State<'_, AppState>) -> Result<usize, String> {
        log::info!("Running flight deduplication");
        state
            .db_authenticated()?
            .deduplicate_flights()
            .map_err(|e| format!("Failed to deduplicate flights: {}", e))
    }

    #[tauri::command]
    pub async fn update_flight_name(
        flight_id: i64,
        display_name: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let trimmed = display_name.trim();
        if trimmed.is_empty() {
            return Err("Display name cannot be empty".to_string());
        }

        log::info!("Renaming flight {} to '{}'", flight_id, trimmed);

        state
            .db_authenticated()?
            .update_flight_name(flight_id, trimmed)
            .map(|_| true)
            .map_err(|e| format!("Failed to update flight name: {}", e))
    }

    #[tauri::command]
    pub async fn update_flight_notes(
        flight_id: i64,
        notes: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let notes_ref = notes.as_ref().map(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }).flatten();

        log::info!("Updating notes for flight {}", flight_id);

        state
            .db_authenticated()?
            .update_flight_notes(flight_id, notes_ref)
            .map(|_| true)
            .map_err(|e| format!("Failed to update flight notes: {}", e))
    }

    #[tauri::command]
    pub async fn update_flight_color(
        flight_id: i64,
        color: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let trimmed = color.trim();
        if trimmed.is_empty() {
            return Err("Color cannot be empty".to_string());
        }

        log::info!("Updating color for flight {} to '{}'", flight_id, trimmed);

        state
            .db_authenticated()?
            .update_flight_color(flight_id, trimmed)
            .map(|_| true)
            .map_err(|e| format!("Failed to update flight color: {}", e))
    }

    #[tauri::command]
    pub async fn has_api_key(state: State<'_, AppState>) -> Result<bool, String> {
        let api = DjiApi::with_app_data_dir(state.data_dir.clone());
        Ok(api.has_api_key())
    }

    #[tauri::command]
    pub async fn get_api_key_type(state: State<'_, AppState>) -> Result<String, String> {
        let api = DjiApi::with_app_data_dir(state.data_dir.clone());
        Ok(api.get_api_key_type())
    }

    #[tauri::command]
    pub async fn set_api_key(api_key: String, state: State<'_, AppState>) -> Result<bool, String> {
        let active_profile = database::get_active_profile(&state.data_dir);
        if active_profile != "default" {
            return Err("Changing DJI API key is only allowed from the default profile".to_string());
        }

        let api = DjiApi::with_app_data_dir(state.data_dir.clone());
        api.save_api_key(&api_key)
            .map(|_| true)
            .map_err(|e| format!("Failed to save API key: {}", e))
    }

    #[tauri::command]
    pub async fn remove_api_key(state: State<'_, AppState>) -> Result<bool, String> {
        let active_profile = database::get_active_profile(&state.data_dir);
        if active_profile != "default" {
            return Err("Changing DJI API key is only allowed from the default profile".to_string());
        }

        let api = DjiApi::with_app_data_dir(state.data_dir.clone());
        api.remove_api_key()
            .map(|_| true)
            .map_err(|e| format!("Failed to remove API key: {}", e))
    }

    #[tauri::command]
    pub async fn get_app_data_dir(state: State<'_, AppState>) -> Result<String, String> {
        Ok(state.data_dir.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub async fn get_battery_pairs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        Ok(crate::battery_pairs::load_battery_pairs(&state.data_dir))
    }

    #[tauri::command]
    pub async fn get_app_log_dir(app: AppHandle) -> Result<String, String> {
        app.path()
            .app_log_dir()
            .map_err(|e| format!("Failed to get app log directory: {}", e))
            .map(|dir| dir.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub async fn log_sync_event(
        level: String,
        message: String,
        metadata: Option<String>,
    ) -> Result<bool, String> {
        let level_lc = level.trim().to_ascii_lowercase();
        let payload = if let Some(meta) = metadata {
            format!("[SYNC][UI] {} | {}", message, meta)
        } else {
            format!("[SYNC][UI] {}", message)
        };

        match level_lc.as_str() {
            "debug" => log::debug!("{}", payload),
            "warn" | "warning" => log::warn!("{}", payload),
            "error" => log::error!("{}", payload),
            _ => log::info!("{}", payload),
        }

        Ok(true)
    }

    #[tauri::command]
    pub async fn get_equipment_names(state: State<'_, AppState>) -> Result<(Vec<(String, String)>, Vec<(String, String)>), String> {
        state.db_authenticated()?.get_all_equipment_names()
            .map_err(|e| format!("Failed to get equipment names: {}", e))
    }

    #[tauri::command]
    pub async fn set_equipment_name(
        serial: String,
        equipment_type: String,
        display_name: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        state.db_authenticated()?.set_equipment_name(&serial, &equipment_type, &display_name)
            .map(|_| true)
            .map_err(|e| format!("Failed to set equipment name: {}", e))
    }

    #[tauri::command]
    pub async fn export_backup(dest_path: String, app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
        let path = std::path::PathBuf::from(&dest_path);
        log::info!("Exporting database backup to: {}", dest_path);
        emit_backup_progress(&app, "export", 0, "Starting backup");
        state
            .db_authenticated()?
            .export_backup_with_progress(&path, |percent, stage| {
                emit_backup_progress(&app, "export", percent, stage);
            })
            .map(|_| true)
            .map_err(|e| format!("Failed to export backup: {}", e))
    }

    #[tauri::command]
    pub async fn export_backup_bytes(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<u8>, String> {
        let temp_dir = state.data_dir.join("temp");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp directory: {}", e))?;
        let temp_path = temp_dir.join(format!(
            "open-dronelog-backup-{}.backup",
            uuid::Uuid::new_v4()
        ));

        emit_backup_progress(&app, "export", 0, "Starting backup");

        state
            .db_authenticated()?
            .export_backup_with_progress(&temp_path, |percent, stage| {
                emit_backup_progress(&app, "export", percent, stage);
            })
            .map_err(|e| format!("Failed to export backup: {}", e))?;

        emit_backup_progress(&app, "export", 96, "Reading backup bytes");

        let bytes = std::fs::read(&temp_path)
            .map_err(|e| format!("Failed to read temporary backup file: {}", e))?;

        let _ = std::fs::remove_file(&temp_path);
        emit_backup_progress(&app, "export", 100, "Backup complete");
        Ok(bytes)
    }

    #[tauri::command]
    pub async fn import_backup(src_path: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
        let path = std::path::PathBuf::from(&src_path);
        log::info!("Importing database backup from: {}", src_path);
        emit_backup_progress(&app, "import", 0, "Starting restore");
        state
            .db_authenticated()?
            .import_backup_with_progress(&path, |percent, stage| {
                emit_backup_progress(&app, "import", percent, stage);
            })
            .map_err(|e| format!("Failed to import backup: {}", e))
    }

    #[tauri::command]
    pub async fn import_backup_bytes(data: Vec<u8>, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
        let temp_dir = state.data_dir.join("temp");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp directory: {}", e))?;
        let temp_path = temp_dir.join(format!(
            "open-dronelog-restore-{}.backup",
            uuid::Uuid::new_v4()
        ));

        emit_backup_progress(&app, "import", 0, "Preparing restore file");

        std::fs::write(&temp_path, data)
            .map_err(|e| format!("Failed to write temporary restore file: {}", e))?;

        let result = state
            .db_authenticated()?
            .import_backup_with_progress(&temp_path, |percent, stage| {
                emit_backup_progress(&app, "import", percent, stage);
            })
            .map_err(|e| format!("Failed to import backup: {}", e));

        let _ = std::fs::remove_file(&temp_path);
        if result.is_ok() {
            emit_backup_progress(&app, "import", 100, "Restore complete");
        }
        result
    }

    #[tauri::command]
    pub async fn add_flight_tag(flight_id: i64, tag: String, state: State<'_, AppState>) -> Result<Vec<FlightTag>, String> {
        let db = state.db_authenticated()?;
        db
            .add_flight_tag(flight_id, &tag)
            .map_err(|e| format!("Failed to add tag: {}", e))?;
        db
            .get_flight_tags(flight_id)
            .map_err(|e| format!("Failed to get tags: {}", e))
    }

    #[tauri::command]
    pub async fn remove_flight_tag(flight_id: i64, tag: String, state: State<'_, AppState>) -> Result<Vec<FlightTag>, String> {
        let db = state.db_authenticated()?;
        db
            .remove_flight_tag(flight_id, &tag)
            .map_err(|e| format!("Failed to remove tag: {}", e))?;
        db
            .get_flight_tags(flight_id)
            .map_err(|e| format!("Failed to get tags: {}", e))
    }

    #[tauri::command]
    pub async fn get_all_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        state
            .db_authenticated()?
            .get_all_unique_tags()
            .map_err(|e| format!("Failed to get tags: {}", e))
    }

    #[tauri::command]
    pub async fn remove_all_auto_tags(state: State<'_, AppState>) -> Result<usize, String> {
        state
            .db_authenticated()?
            .remove_all_auto_tags()
            .map_err(|e| format!("Failed to remove auto tags: {}", e))
    }

    #[tauri::command]
    pub async fn get_smart_tags_enabled(state: State<'_, AppState>) -> Result<bool, String> {
        let config = crate::models::load_profile_config(&state.config_path());
        Ok(config.get("smart_tags_enabled").and_then(|v| v.as_bool()).unwrap_or(true))
    }

    #[tauri::command]
    pub async fn set_smart_tags_enabled(enabled: bool, state: State<'_, AppState>) -> Result<bool, String> {
        let config_path = state.config_path();
        let mut config = crate::models::load_profile_config(&config_path);
        config["smart_tags_enabled"] = serde_json::json!(enabled);
        crate::models::save_profile_config(&config_path, &config)?;
        Ok(enabled)
    }

    #[tauri::command]
    pub async fn get_enabled_tag_types(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        let config = crate::models::load_profile_config(&state.config_path());
        if let Some(types) = config.get("enabled_tag_types").and_then(|v| v.as_array()) {
            return Ok(types.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect());
        }
        // Default: return all tag types
        Ok(vec![
            "night_flight".to_string(), "high_speed".to_string(), "cold_battery".to_string(),
            "heavy_load".to_string(), "low_battery".to_string(), "high_altitude".to_string(),
            "long_distance".to_string(), "long_flight".to_string(), "short_flight".to_string(),
            "aggressive_flying".to_string(), "no_gps".to_string(), "country".to_string(),
            "continent".to_string(),
        ])
    }

    #[tauri::command]
    pub async fn set_enabled_tag_types(types: Vec<String>, state: State<'_, AppState>) -> Result<Vec<String>, String> {
        let config_path = state.config_path();
        let mut config = crate::models::load_profile_config(&config_path);
        config["enabled_tag_types"] = serde_json::json!(types.clone());
        crate::models::save_profile_config(&config_path, &config)?;
        Ok(types)
    }

    /// Settings for keeping uploaded files
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct KeepUploadSettings {
        pub enabled: bool,
        pub folder_path: String,
    }

    fn validate_upload_folder_writable(folder: &PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(folder)
            .map_err(|e| format!("Failed to create/access folder: {}", e))?;

        if !folder.is_dir() {
            return Err("Selected path is not a directory".to_string());
        }

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let test_file = folder.join(format!(
            ".open-dronelog-write-test-{}-{}.tmp",
            std::process::id(),
            nonce
        ));

        let payload = b"open-dronelog-write-check";

        std::fs::write(&test_file, payload)
            .map_err(|e| format!("Failed to write test file: {}", e))?;

        let read_back = std::fs::read(&test_file)
            .map_err(|e| format!("Failed to read back test file: {}", e))?;

        let _ = std::fs::remove_file(&test_file);

        if read_back != payload {
            return Err("Write verification failed (written content mismatch)".to_string());
        }

        Ok(())
    }

    #[tauri::command]
    pub async fn get_keep_upload_settings(state: State<'_, AppState>) -> Result<KeepUploadSettings, String> {
        let default_folder = state.default_upload_folder().to_string_lossy().to_string();
        let config = crate::models::load_profile_config(&state.config_path());
        let enabled = config.get("keep_uploaded_files").and_then(|v| v.as_bool()).unwrap_or(true);
        let folder_path = config.get("uploaded_files_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or(default_folder);
        Ok(KeepUploadSettings { enabled, folder_path })
    }

    #[tauri::command]
    pub async fn set_keep_upload_settings(enabled: bool, folder_path: Option<String>, state: State<'_, AppState>) -> Result<KeepUploadSettings, String> {
        let config_path = state.config_path();
        let default_folder = state.default_upload_folder().to_string_lossy().to_string();
        let actual_folder = folder_path.unwrap_or(default_folder);

        if enabled {
            let candidate = PathBuf::from(&actual_folder);
            validate_upload_folder_writable(&candidate).map_err(|e| {
                format!(
                    "Access denied to selected location '{}': {}. Please select a different location.",
                    actual_folder, e
                )
            })?;
        }
        
        let mut config = crate::models::load_profile_config(&config_path);
        config["keep_uploaded_files"] = serde_json::json!(enabled);
        config["uploaded_files_path"] = serde_json::json!(actual_folder.clone());
        crate::models::save_profile_config(&config_path, &config)?;
        Ok(KeepUploadSettings { enabled, folder_path: actual_folder })
    }

    #[tauri::command]
    pub async fn get_auto_logout(state: State<'_, AppState>) -> Result<bool, String> {
        let config = crate::models::load_profile_config(&state.config_path());
        Ok(config.get("auto_logout").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    #[tauri::command]
    pub async fn set_auto_logout(enabled: bool, state: State<'_, AppState>) -> Result<bool, String> {
        let config_path = state.config_path();
        let mut config = crate::models::load_profile_config(&config_path);
        config["auto_logout"] = serde_json::json!(enabled);
        crate::models::save_profile_config(&config_path, &config)?;
        Ok(enabled)
    }

    /// Copy uploaded file to the keep folder with hash-based deduplication
    fn copy_uploaded_file(src_path: &PathBuf, dest_folder: &PathBuf, file_hash: Option<&str>) -> Result<(), String> {
        // Create the destination folder if it doesn't exist
        std::fs::create_dir_all(dest_folder)
            .map_err(|e| format!("Failed to create uploaded files folder: {}", e))?;
        
        let file_name = src_path.file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid file name")?;
        
        let dest_path = dest_folder.join(file_name);
        
        // Compute source file hash if not provided
        let computed_hash: String;
        let src_hash = match file_hash {
            Some(h) => h,
            None => {
                computed_hash = LogParser::calculate_file_hash(src_path)
                    .map_err(|e| format!("Failed to hash source file: {}", e))?;
                &computed_hash
            }
        };
        
        // If file with same name exists, check hash
        if dest_path.exists() {
            let existing_hash = LogParser::calculate_file_hash(&dest_path)
                .map_err(|e| format!("Failed to hash existing file: {}", e))?;
            
            // If hashes match, skip (file already exists)
            if existing_hash == src_hash {
                log::info!("File already exists with same hash, skipping: {}", file_name);
                return Ok(());
            }
            
            // Hashes don't match - save with hash suffix
            let stem = src_path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let extension = src_path.extension()
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

    #[tauri::command]
    pub async fn regenerate_flight_smart_tags(
        state: State<'_, AppState>,
        flight_id: i64,
        enabled_tag_types: Option<Vec<String>>,
    ) -> Result<String, String> {
        use crate::parser::{LogParser, calculate_stats_from_records};

        let db = state.db_authenticated()?;
        let flight = db.get_flight_by_id(flight_id)
            .map_err(|e| format!("Failed to get flight {}: {}", flight_id, e))?;

        let metadata = crate::models::FlightMetadata::from(&flight);

        match db.get_flight_telemetry(flight_id, Some(50000), None) {
            Ok(records) if !records.is_empty() => {
                let stats = calculate_stats_from_records(&records);
                let mut tags = LogParser::generate_smart_tags(&metadata, &stats);
                // Filter tags if enabled_tag_types is provided
                if let Some(ref types) = enabled_tag_types {
                    tags = LogParser::filter_smart_tags(tags, types);
                }
                db.replace_auto_tags(flight_id, &tags)
                    .map_err(|e| format!("Failed to replace tags for flight {}: {}", flight_id, e))?;
            }
            Ok(_) => {
                let _ = db.replace_auto_tags(flight_id, &[]);
            }
            Err(e) => {
                return Err(format!("Failed to get telemetry for flight {}: {}", flight_id, e));
            }
        }

        Ok("ok".to_string())
    }

    #[tauri::command]
    pub async fn regenerate_all_smart_tags(state: State<'_, AppState>) -> Result<String, String> {
        use crate::parser::{LogParser, calculate_stats_from_records};

        log::info!("Starting smart tag regeneration for all flights");
        let start = std::time::Instant::now();

        let db = state.db_authenticated()?;
        let flight_ids = db.get_all_flight_ids()
            .map_err(|e| format!("Failed to get flight IDs: {}", e))?;

        let _total = flight_ids.len();
        let mut processed = 0usize;
        let mut errors = 0usize;

        for flight_id in &flight_ids {
            match db.get_flight_by_id(*flight_id) {
                Ok(flight) => {
                    let metadata = crate::models::FlightMetadata::from(&flight);

                    // Get raw telemetry to compute stats
                    match db.get_flight_telemetry(*flight_id, Some(50000), None) {
                        Ok(records) if !records.is_empty() => {
                            let stats = calculate_stats_from_records(&records);
                            let tags = LogParser::generate_smart_tags(&metadata, &stats);
                            if let Err(e) = db.replace_auto_tags(*flight_id, &tags) {
                                log::warn!("Failed to replace tags for flight {}: {}", flight_id, e);
                                errors += 1;
                            }
                        }
                        Ok(_) => {
                            // No telemetry — just clear auto tags
                            let _ = db.replace_auto_tags(*flight_id, &[]);
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
        Ok(msg)
    }

    // ========================================================================
    // PROFILE MANAGEMENT COMMANDS
    // ========================================================================

    #[derive(serde::Serialize)]
    pub struct ProfileInfo {
        name: String,
        #[serde(rename = "hasPassword")]
        has_password: bool,
    }

    #[tauri::command]
    pub async fn list_profiles(state: State<'_, AppState>) -> Result<Vec<ProfileInfo>, String> {
        let names = database::list_profiles(&state.data_dir);
        Ok(names.into_iter().map(|name| {
            let has_pw = profile_auth::has_password(&state.data_dir, &name);
            ProfileInfo { name, has_password: has_pw }
        }).collect())
    }

    #[tauri::command]
    pub async fn get_active_profile(state: State<'_, AppState>) -> Result<String, String> {
        Ok(database::get_active_profile(&state.data_dir))
    }

    /// Check whether the app is currently locked (requires authentication).
    #[tauri::command]
    pub async fn is_app_locked(state: State<'_, AppState>) -> Result<bool, String> {
        Ok(*state.locked.read().unwrap())
    }

    /// Authenticate the current profile to unlock the app.
    /// This does NOT switch profiles — it only verifies the password and lifts the lock.
    #[tauri::command]
    pub async fn unlock_profile(password: String, state: State<'_, AppState>) -> Result<bool, String> {
        let profile = database::get_active_profile(&state.data_dir);
        if !profile_auth::profile_is_protected(&state.data_dir, &profile) {
            // Not protected — just unlock
            state.unlock();
            return Ok(true);
        }
        profile_auth::verify_profile_password(&state.data_dir, &profile, &password)?;
        state.unlock();
        log::info!("Profile '{}' unlocked via password", profile);
        Ok(true)
    }

    #[tauri::command]
    pub async fn switch_profile(
        name: String,
        create: bool,
        password: Option<String>,
        new_password: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let profile = name.trim().to_string();

        // Validate (unless default)
        if profile != "default" {
            database::validate_profile_name(&profile)?;
        }

        // If this is a create request, reject if profile already exists
        if create && database::profile_exists(&state.data_dir, &profile) {
            return Err(format!("Profile '{}' already exists", profile));
        }

        // Password verification for existing protected profiles
        if !create && profile_auth::profile_is_protected(&state.data_dir, &profile) {
            match &password {
                Some(pw) => {
                    profile_auth::verify_profile_password(&state.data_dir, &profile, pw)?;
                }
                None => {
                    return Err("Password is required for this profile".to_string());
                }
            }
        }

        let current = database::get_active_profile(&state.data_dir);
        if current == profile {
            // Same profile — password was already verified above, just unlock and return
            state.unlock();
            return Ok(profile);
        }

        log::info!("Switching profile from '{}' to '{}'", current, profile);

        // Checkpoint current database before switching
        if let Err(e) = state.db().checkpoint() {
            log::warn!("Checkpoint before profile switch failed (non-fatal): {}", e);
        }

        // Create / open the target database
        let new_db = Database::new(state.data_dir.clone(), &profile)
            .map_err(|e| format!("Failed to open profile '{}': {}", profile, e))?;

        // Swap the active database
        state.swap_db(new_db);

        // Unlock — the user has authenticated or the profile is unprotected
        state.unlock();

        // Persist the active profile
        database::set_active_profile(&state.data_dir, &profile)
            .map_err(|e| format!("Failed to persist profile: {}", e))?;

        // Set password on newly created profile (if provided)
        if create {
            if let Some(ref new_pw) = new_password {
                if !new_pw.is_empty() {
                    profile_auth::set_password(&state.data_dir, &profile, new_pw, None)?;
                }
            }
        }

        log::info!("Switched to profile '{}'", profile);
        Ok(profile)
    }

    #[tauri::command]
    pub async fn delete_profile(name: String, password: Option<String>, state: State<'_, AppState>) -> Result<bool, String> {
        let profile = name.trim().to_string();

        if profile == "default" {
            return Err("Cannot delete the default profile".to_string());
        }

        // Password verification for protected profiles
        if profile_auth::profile_is_protected(&state.data_dir, &profile) {
            match &password {
                Some(pw) => {
                    profile_auth::verify_profile_password(&state.data_dir, &profile, pw)?;
                }
                None => {
                    return Err("Password is required to delete this profile".to_string());
                }
            }
        }

        let active = database::get_active_profile(&state.data_dir);
        if active == profile {
            return Err("Cannot delete the currently active profile. Switch to a different profile first.".to_string());
        }

        // Remove auth entry
        profile_auth::remove_auth_entry(&state.data_dir, &profile);

        database::delete_profile(&state.data_dir, &profile)?;
        Ok(true)
    }

    /// Rename a profile (not the active one, whose database is open). Requires the
    /// profile's own password when it has one; the desktop app has no admin password.
    #[tauri::command]
    pub async fn rename_profile(
        name: String,
        new_name: String,
        password: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let profile = database::existing_profile_name(&state.data_dir, name.trim())?;
        let new_name = new_name.trim().to_string();

        if profile_auth::profile_is_protected(&state.data_dir, &profile) {
            match &password {
                Some(pw) => profile_auth::verify_profile_password(&state.data_dir, &profile, pw)?,
                None => return Err("Password is required to rename this profile".to_string()),
            }
        }

        if database::get_active_profile(&state.data_dir) == profile {
            return Err("Cannot rename the currently active profile. Switch to a different profile first.".to_string());
        }

        database::rename_profile(&state.data_dir, &profile, &new_name)?;
        Ok(new_name)
    }

    #[tauri::command]
    pub async fn set_profile_password(
        profile: String,
        new_password: String,
        current_password: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        profile_auth::set_password(
            &state.data_dir,
            &profile,
            &new_password,
            current_password.as_deref(),
        )?;
        Ok(true)
    }

    #[tauri::command]
    pub async fn remove_profile_password(
        profile: String,
        current_password: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        profile_auth::remove_password(&state.data_dir, &profile, &current_password)?;
        Ok(true)
    }

    // ========================================================================
    // Supporter Badge (server-side verification)
    // ========================================================================

    /// The SHA-256 hash of the valid supporter code.
    const SUPPORTER_HASH: &str =
        "5978f3e898c83b40c90017c88b8048f80a5acfd020bbd073af794e710603067d";

    /// Verify a plaintext supporter code.
    /// On success the verified state is persisted in the database.
    #[tauri::command]
    pub async fn verify_supporter_code(
        code: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        use sha2::{Sha256, Digest};

        let trimmed = code.trim().to_string();
        if trimmed.is_empty() {
            return Err("Code must not be empty".to_string());
        }

        let mut hasher = Sha256::new();
        hasher.update(trimmed.as_bytes());
        let hash_bytes = hasher.finalize();
        let hash_hex: String = hash_bytes.iter().map(|b| format!("{:02x}", b)).collect();

        if hash_hex != SUPPORTER_HASH {
            return Ok(false);
        }

        // Persist verified state in the database
        let db = state.db_authenticated()?;
        db.set_setting("supporter_badge_active", "true")
            .map_err(|e| format!("Failed to save supporter state: {}", e))?;
        db.set_setting("donation_acknowledged", "true")
            .map_err(|e| format!("Failed to save donation state: {}", e))?;

        Ok(true)
    }

    /// Read the supporter badge state from the database.
    #[tauri::command]
    pub async fn get_supporter_status(
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let db = state.db_authenticated()?;
        let val = db
            .get_setting("supporter_badge_active")
            .map_err(|e| format!("Failed to read supporter state: {}", e))?;
        Ok(val.as_deref() == Some("true"))
    }

    /// Remove the supporter badge.
    #[tauri::command]
    pub async fn remove_supporter_badge(
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let db = state.db_authenticated()?;
        db.set_setting("supporter_badge_active", "false")
            .map_err(|e| format!("Failed to remove supporter state: {}", e))?;
        Ok(true)
    }

    /// Read the donation-acknowledged flag from the database.
    #[tauri::command]
    pub async fn get_donation_acknowledged(
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let db = state.db_authenticated()?;
        let val = db
            .get_setting("donation_acknowledged")
            .map_err(|e| format!("Failed to read donation state: {}", e))?;
        Ok(val.as_deref() == Some("true"))
    }

    /// Persist the donation-acknowledged flag in the database.
    #[tauri::command]
    pub async fn set_donation_acknowledged(
        acknowledged: bool,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let db = state.db_authenticated()?;
        db.set_setting("donation_acknowledged", if acknowledged { "true" } else { "false" })
            .map_err(|e| format!("Failed to save donation state: {}", e))?;
        Ok(acknowledged)
    }

    /// Generic setting read helper for profile-scoped database settings.
    #[tauri::command]
    pub async fn get_setting_value(
        key: String,
        state: State<'_, AppState>,
    ) -> Result<Option<String>, String> {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            return Err("Setting key cannot be empty".to_string());
        }
        state
            .db_authenticated()?
            .get_setting(trimmed)
            .map_err(|e| format!("Failed to read setting: {}", e))
    }

    /// Generic setting write helper for profile-scoped database settings.
    #[tauri::command]
    pub async fn set_setting_value(
        key: String,
        value: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            return Err("Setting key cannot be empty".to_string());
        }
        state
            .db_authenticated()?
            .set_setting(trimmed, &value)
            .map_err(|e| format!("Failed to save setting: {}", e))?;
        Ok(true)
    }

    pub fn run() {
        let builder = tauri::Builder::default();

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // Focus the existing window when a second instance is launched.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    log::info!("Second instance blocked — focused existing window");
                }
            }))
            .plugin(tauri_plugin_window_state::Builder::new().build())
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    log::info!("Window close requested. Intercepting to cleanly teardown database...");

                    // Prevent immediate close.
                    api.prevent_close();

                    // Hide window to give immediate feedback to user.
                    let _ = window.hide();

                    let app_handle = window.app_handle().clone();

                    // Spawn task to handle the actual teardown.
                    tauri::async_runtime::spawn(async move {
                        // To actually drop the inner value from the Arc, we'd need strong count=1.
                        // Since the process is shutting down anyway, issue a final checkpoint.
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            if let Err(e) = state.db().checkpoint() {
                                log::warn!("Final shutdown WAL checkpoint failed: {}", e);
                            } else {
                                log::info!("Final shutdown WAL checkpoint completed successfully.");
                            }
                        }

                        std::thread::sleep(std::time::Duration::from_millis(150));
                        app_handle.exit(0);
                    });
                }
            });

        #[cfg(any(target_os = "android", target_os = "ios"))]
        let builder = builder;

        builder
            .plugin(
                tauri_plugin_log::Builder::new()
                    .targets([
                        Target::new(TargetKind::LogDir { file_name: None }),
                        Target::new(TargetKind::Stdout),
                    ])
                    .level(LevelFilter::Debug)
                    .build(),
            )
                    .plugin(tauri_plugin_fs::init())
                    .plugin(tauri_plugin_android_fs::init())
                    .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_http::init())
                    .plugin(tauri_plugin_persisted_scope::init())
            .setup(|app| {
                let data_dir = app_data_dir_path(app.handle())?;
                let db = init_database(app.handle())?;

                // Determine if the app should start locked.
                // Lock when the active profile has a password AND auto_logout is enabled.
                let profile = database::get_active_profile(&data_dir);
                let has_password = profile_auth::has_password(&data_dir, &profile);
                let auto_logout = if has_password {
                    let config_path = database::config_path_for_profile(&data_dir, &profile);
                    let config = crate::models::load_profile_config(&config_path);
                    config.get("auto_logout").and_then(|b| b.as_bool()).unwrap_or(false)
                } else {
                    false
                };
                let start_locked = has_password && auto_logout;
                if start_locked {
                    log::info!("Profile '{}' is password-protected with auto-logout — starting locked", profile);
                }

                app.manage(AppState {
                    active_db: RwLock::new(Arc::new(db)),
                    data_dir,
                    locked: RwLock::new(start_locked),
                });

                if let Some(state) = app.try_state::<AppState>() {
                    crate::plugins::log_plugin_registration(&state.data_dir);
                    let allowed_extensions = crate::plugins::get_allowed_extensions(&state.data_dir);
                    log::info!("Allowed import extensions at startup: {:?}", allowed_extensions);
                }

                log::info!("Open DroneLog initialized successfully");
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                import_log,
                import_log_bytes,
                create_manual_flight,
                compute_file_hash,
                get_allowed_log_extensions,
                get_sync_blacklist,
                add_to_sync_blacklist,
                remove_from_sync_blacklist,
                clear_sync_blacklist,
                get_flights,
                get_flight_data,
                get_overview_stats,
                get_battery_full_capacity_history,
                delete_flight,
                delete_all_flights,
                deduplicate_flights,
                update_flight_name,
                update_flight_notes,
                update_flight_color,
                has_api_key,
                get_api_key_type,
                set_api_key,
                remove_api_key,
                get_app_data_dir,
                get_battery_pairs,
                get_app_log_dir,
                log_sync_event,
                get_equipment_names,
                set_equipment_name,
                export_backup,
                export_backup_bytes,
                import_backup,
                import_backup_bytes,
                add_flight_tag,
                remove_flight_tag,
                get_all_tags,
                remove_all_auto_tags,
                get_smart_tags_enabled,
                set_smart_tags_enabled,
                get_enabled_tag_types,
                set_enabled_tag_types,
                get_keep_upload_settings,
                set_keep_upload_settings,
                get_auto_logout,
                set_auto_logout,
                unlock_profile,
                is_app_locked,
                regenerate_flight_smart_tags,
                regenerate_all_smart_tags,
                list_profiles,
                get_active_profile,
                switch_profile,
                delete_profile,
                rename_profile,
                set_profile_password,
                remove_profile_password,
                verify_supporter_code,
                get_supporter_status,
                remove_supporter_badge,
                get_donation_acknowledged,
                set_donation_acknowledged,
                get_setting_value,
                set_setting_value,
            ])
            .run(tauri::generate_context!())
            .expect("Failed to run Open DroneLog");
    }
