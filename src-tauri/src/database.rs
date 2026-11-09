//! Database module for DuckDB connection and schema management.
//!
//! This module handles:
//! - DuckDB connection initialization in the app data directory
//! - Schema creation for flights and telemetry tables
//! - Optimized bulk inserts using Appender
//! - Downsampled query retrieval for large datasets

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{Duration, NaiveDate, Utc};
use duckdb::{params, Connection, OptionalExt, Result as DuckResult};
use thiserror::Error;

use crate::models::{BatteryHealthPoint, BatteryUsage, DroneUsage, Flight, FlightDateCount, FlightMessage, FlightMetadata, FlightTag, OverviewStats, TelemetryPoint, TelemetryRecord, TopDistanceFlight, TopFlight};

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("DuckDB error: {0}")]
    DuckDb(#[from] duckdb::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Flight not found: {0}")]
    FlightNotFound(i64),
}

/// Thread-safe database manager
pub struct Database {
    conn: Mutex<Connection>,
    pub data_dir: PathBuf,
}

impl Drop for Database {
    fn drop(&mut self) {
        log::info!("Dropping Database instance. DuckDB will now gracefully close and flush remaining WAL data to disk...");
        let drop_start = std::time::Instant::now();
        // The actual DuckDB connection drop happens automatically right after this, 
        // which triggers any implicit final checkpoints.
        log::info!("Database drop initiated (drop handler took {:.3}s)", drop_start.elapsed().as_secs_f64());
    }
}

impl Database {
    /// Initialize the database in the app data directory for a given profile.
    ///
    /// Profile "default" uses `flights.db`, any other profile uses `flights_{name}.db`.
    ///
    /// Creates the following directory structure:
    /// ```text
    /// {app_data_dir}/
    /// ├── flights.db              # DuckDB database file (default profile)
    /// ├── flights_{profile}.db    # DuckDB database file (named profile)
    /// └── keychains/              # Cached decryption keys
    /// ```
    pub fn new(app_data_dir: PathBuf, profile: &str) -> Result<Self, DatabaseError> {
        // Ensure directory structure exists
        fs::create_dir_all(&app_data_dir)?;
        fs::create_dir_all(app_data_dir.join("keychains"))?;

        let db_path = if profile == "default" {
            app_data_dir.join("flights.db")
        } else {
            app_data_dir.join(format!("flights_{}.db", profile))
        };

        log::info!("Initializing DuckDB at: {:?}", db_path);

        // Open or create the database (with WAL recovery)
        let conn = Self::open_with_recovery(&db_path)?;

        // Configure DuckDB for optimal performance
        Self::configure_connection(&conn, &app_data_dir)?;

        // Checkpoint WAL to main database file for faster subsequent startups
        if let Err(e) = conn.execute_batch("CHECKPOINT;") {
            log::warn!("WAL checkpoint failed (non-fatal): {}", e);
        }

        let db = Self {
            conn: Mutex::new(conn),
            data_dir: app_data_dir,
        };

        // Initialize schema
        db.init_schema()?;

        // Run one-time startup deduplication for existing data
        db.run_startup_deduplication();

        // Backfill flight_customizations for existing user-edited flights
        db.backfill_flight_customizations();

        // Perform a checkpoint right after startup, as migrations (especially those touching thousands of rows)
        // create large WAL files. This ensures the 100+ MB WAL isn't held in memory until the user
        // closes the app window, which prevents process locking issues.
        log::info!("Starting post-startup WAL checkpoint to clear large migration logs...");
        let checkpoint_start = std::time::Instant::now();
        if let Err(e) = db.conn.lock().unwrap().execute_batch("CHECKPOINT; VACUUM;") {
            log::warn!("Post-startup WAL checkpoint & vacuum failed (non-fatal): {} (took {:.1}s)", e, checkpoint_start.elapsed().as_secs_f64());
        } else {
            log::info!("Post-startup WAL checkpoint & vacuum completed successfully in {:.1}s", checkpoint_start.elapsed().as_secs_f64());
        }

        Ok(db)
    }

    fn open_with_recovery(db_path: &PathBuf) -> Result<Connection, DatabaseError> {
        match Connection::open(db_path) {
            Ok(conn) => Ok(conn),
            Err(err) => {
                log::warn!("DuckDB open failed: {}. Attempting WAL recovery...", err);

                let wal_path = db_path.with_extension("db.wal");
                if wal_path.exists() {
                    if let Err(wal_err) = fs::remove_file(&wal_path) {
                        log::warn!("Failed to remove WAL file {:?}: {}", wal_path, wal_err);
                    } else {
                        log::info!("Removed WAL file {:?}", wal_path);
                    }
                }

                match Connection::open(db_path) {
                    Ok(conn) => Ok(conn),
                    Err(second_err) => {
                        log::warn!("WAL recovery failed: {}. Backing up DB and recreating...", second_err);

                        let backup_path = Self::backup_db(db_path)?;
                        log::warn!("Database backed up to {:?}", backup_path);

                        Connection::open(db_path).map_err(DatabaseError::from)
                    }
                }
            }
        }
    }

    /// Backup the database before WAL recovery or rebuilds
    fn backup_db(db_path: &PathBuf) -> Result<PathBuf, DatabaseError> {
        if !db_path.exists() {
            return Ok(db_path.clone());
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_path = db_path.with_extension(format!("db.bak.{}", timestamp));
        fs::rename(db_path, &backup_path)?;

        let wal_path = db_path.with_extension("db.wal");
        if wal_path.exists() {
            let wal_backup = wal_path.with_extension(format!("db.wal.bak.{}", timestamp));
            let _ = fs::rename(&wal_path, wal_backup);
        }

        Ok(backup_path)
    }

    /// Explicitly forces a WAL checkpoint. Useful for flushing the WAL before shutdown.
    #[cfg(feature = "tauri-app")]
    pub fn checkpoint(&self) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("CHECKPOINT;")?;
        Ok(())
    }

    /// Configure DuckDB connection for optimal analytical performance
    fn configure_connection(conn: &Connection, app_data_dir: &PathBuf) -> DuckResult<()> {
        // Memory settings for better performance with large datasets
        conn.execute_batch(
            r#"
            SET memory_limit = '2GB';
            SET threads = 4;
            SET enable_progress_bar = false;
            PRAGMA wal_autocheckpoint='25MB';
            "#,
        )?;

        // Android uses a sandboxed filesystem. Setting a writable DuckDB home directory
        // prevents extension/runtime code paths from probing invalid default locations.
        let escaped_home = app_data_dir.to_string_lossy().replace('\'', "''");
        let home_sql = format!("SET home_directory='{}';", escaped_home);
        if let Err(e) = conn.execute_batch(&home_sql) {
            log::warn!("Failed to set DuckDB home_directory (non-fatal): {}", e);
        }

        // Best-effort toggles: on some builds these settings are unavailable.
        for stmt in [
            "SET autoinstall_known_extensions=false;",
            "SET autoload_known_extensions=false;",
        ] {
            if let Err(e) = conn.execute_batch(stmt) {
                log::debug!("DuckDB setting not applied '{}': {}", stmt.trim_end_matches(';'), e);
            }
        }
        Ok(())
    }

    /// Initialize the database schema with optimized tables
    fn init_schema(&self) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        // Create base tables (without migrations in the batch)
        conn.execute_batch(
            r#"
            -- ============================================================
            -- FLIGHTS TABLE: Stores metadata for each imported flight log
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flights (
                id              BIGINT PRIMARY KEY,
                file_name       VARCHAR NOT NULL,
                display_name    VARCHAR NOT NULL,
                file_hash       VARCHAR UNIQUE,          -- SHA256 to prevent duplicates
                drone_model     VARCHAR,
                drone_serial    VARCHAR,
                aircraft_name   VARCHAR,
                battery_serial  VARCHAR,
                start_time      TIMESTAMP WITH TIME ZONE,
                end_time        TIMESTAMP WITH TIME ZONE,
                duration_secs   DOUBLE,
                total_distance  DOUBLE,                  -- Total distance in meters
                max_altitude    DOUBLE,                  -- Max altitude in meters
                max_speed       DOUBLE,                  -- Max speed in m/s
                home_lat        DOUBLE,
                home_lon        DOUBLE,
                point_count     INTEGER,                 -- Number of telemetry points
                photo_count     INTEGER,                 -- Number of photos taken
                video_count     INTEGER,                 -- Number of video recordings
                cycle_count     INTEGER,                 -- Battery cycle count (from SmartBatteryStatic)
                imported_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                notes           VARCHAR,
                color           VARCHAR DEFAULT '#7dd3fc'  -- Flight color label (hex, default light blue)
            );

            -- Index for sorting by flight date
            CREATE INDEX IF NOT EXISTS idx_flights_start_time 
                ON flights(start_time DESC);

            -- ============================================================
            -- TELEMETRY TABLE: Time-series data for each flight
            -- Optimized for range queries on timestamp
            -- Note: lat/lon use DOUBLE for precision, other metrics use FLOAT to save space
            -- ============================================================
            CREATE TABLE IF NOT EXISTS telemetry (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,         -- Milliseconds since flight start
                
                -- Position (DOUBLE for lat/lon precision, FLOAT for altitude)
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        FLOAT,                   -- Relative altitude in meters
                height          FLOAT,                   -- Height above takeoff in meters
                vps_height      FLOAT,                   -- VPS height in meters
                altitude_abs    FLOAT,                   -- Absolute altitude (MSL)
                
                -- Velocity
                speed           FLOAT,                   -- Ground speed in m/s
                velocity_x      FLOAT,                   -- North velocity
                velocity_y      FLOAT,                   -- East velocity  
                velocity_z      FLOAT,                   -- Down velocity
                
                -- Orientation (Euler angles in degrees)
                pitch           FLOAT,
                roll            FLOAT,
                yaw             FLOAT,
                
                -- Gimbal
                gimbal_pitch    FLOAT,
                gimbal_roll     FLOAT,
                gimbal_yaw      FLOAT,
                
                -- Power
                battery_percent INTEGER,
                battery_voltage FLOAT,
                battery_current FLOAT,
                battery_temp    FLOAT,
                cell_voltages   VARCHAR,                 -- JSON array of individual cell voltages
                
                -- Flight status
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                
                -- RC
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,

                -- RC stick inputs (normalized -100..+100)
                rc_aileron      FLOAT,
                rc_elevator     FLOAT,
                rc_throttle     FLOAT,
                rc_rudder       FLOAT,

                -- Camera state
                is_photo        BOOLEAN,
                is_video        BOOLEAN
            );

            -- Index for time-range queries within a flight
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time 
                ON telemetry(flight_id, timestamp_ms);

            -- ============================================================
            -- KEYCHAIN TABLE: Store cached decryption keys for V13+ logs
            -- ============================================================
            CREATE TABLE IF NOT EXISTS keychains (
                file_hash       VARCHAR PRIMARY KEY,
                encryption_key  VARCHAR NOT NULL,
                fetched_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================================
            -- FLIGHT_TAGS TABLE: Tags associated with each flight
            -- Separate table for backward compatibility with old backups
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flight_tags (
                flight_id       BIGINT NOT NULL,
                tag             VARCHAR NOT NULL,
                tag_type        VARCHAR NOT NULL DEFAULT 'auto',
                PRIMARY KEY (flight_id, tag)
            );

            CREATE INDEX IF NOT EXISTS idx_flight_tags_flight 
                ON flight_tags(flight_id);
            CREATE INDEX IF NOT EXISTS idx_flight_tags_tag 
                ON flight_tags(tag);

            -- ============================================================
            -- SETTINGS TABLE: Key-value store for app settings/flags
            -- ============================================================
            CREATE TABLE IF NOT EXISTS settings (
                key             VARCHAR PRIMARY KEY,
                value           VARCHAR NOT NULL,
                updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================================
            -- EQUIPMENT_NAMES TABLE: Custom display names for batteries/aircraft
            -- ============================================================
            CREATE TABLE IF NOT EXISTS equipment_names (
                serial          VARCHAR NOT NULL,        -- battery or aircraft serial number
                equipment_type  VARCHAR NOT NULL,        -- 'battery' or 'aircraft'
                display_name    VARCHAR NOT NULL,
                updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (serial, equipment_type)
            );

            -- ============================================================
            -- FLIGHT_MESSAGES TABLE: App messages (tips/warnings/cautions) per flight
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flight_messages (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                message_type    VARCHAR NOT NULL,        -- 'tip', 'warn', or 'caution'
                message         VARCHAR NOT NULL,
                PRIMARY KEY (flight_id, timestamp_ms, message_type, message)
            );

            CREATE INDEX IF NOT EXISTS idx_flight_messages_flight 
                ON flight_messages(flight_id);

            -- ============================================================
            -- FLIGHT_CUSTOMIZATIONS TABLE: Persistent user edits keyed by file_hash
            -- Survives delete-all / individual delete + reimport cycles
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flight_customizations (
                file_hash       VARCHAR PRIMARY KEY,
                display_name    VARCHAR,
                notes           VARCHAR,
                color           VARCHAR,
                manual_tags     VARCHAR,                 -- JSON array of manual tag strings
                updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================================
            -- SYNC_BLACKLIST TABLE: File hashes excluded from sync import
            -- ============================================================
            CREATE TABLE IF NOT EXISTS sync_blacklist (
                file_hash       VARCHAR PRIMARY KEY,
                created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;

        // Run selective migrations only for missing columns
        Self::migrate_flights_table(&conn)?;
        Self::migrate_telemetry_table(&conn)?;
        Self::migrate_flight_tags_table(&conn)?;
        Self::migrate_flight_messages_table(&conn)?;
        Self::migrate_keychains_table(&conn)?;

        // Run type optimization migration (DOUBLE -> FLOAT for non-critical metrics)
        // Must run before column order check since it recreates the table
        Self::migrate_telemetry_types(&conn)?;

        Self::ensure_telemetry_column_order(&conn)?;

        log::info!("Database schema initialized successfully");
        Ok(())
    }

    /// Get existing column names for a table (single query)
    fn get_table_columns(conn: &Connection, table_name: &str) -> Result<HashSet<String>, DatabaseError> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info('{}')", table_name))?;
        let columns: HashSet<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(columns)
    }

    /// Migrate flights table - only add missing columns
    fn migrate_flights_table(conn: &Connection) -> Result<(), DatabaseError> {
        let columns = Self::get_table_columns(conn, "flights")?;
        
        let migrations: &[(&str, &str)] = &[
            ("display_name", "ALTER TABLE flights ADD COLUMN display_name VARCHAR"),
            ("aircraft_name", "ALTER TABLE flights ADD COLUMN aircraft_name VARCHAR"),
            ("battery_serial", "ALTER TABLE flights ADD COLUMN battery_serial VARCHAR"),
            ("photo_count", "ALTER TABLE flights ADD COLUMN photo_count INTEGER"),
            ("video_count", "ALTER TABLE flights ADD COLUMN video_count INTEGER"),
            ("color", "ALTER TABLE flights ADD COLUMN color VARCHAR DEFAULT '#7dd3fc'"),
            ("cycle_count", "ALTER TABLE flights ADD COLUMN cycle_count INTEGER"),
            ("rc_serial", "ALTER TABLE flights ADD COLUMN rc_serial VARCHAR"),
            ("battery_life", "ALTER TABLE flights ADD COLUMN battery_life INTEGER"),
        ];

        let need_backfill = !columns.contains("photo_count");

        for (col_name, sql) in migrations {
            if !columns.contains(*col_name) {
                log::info!("Migrating flights table: adding {} column", col_name);
                conn.execute_batch(sql)?;
            }
        }

        // Backfill photo/video counts from telemetry for existing flights
        if need_backfill {
            log::info!("Backfilling photo_count and video_count from telemetry data...");
            let backfill_sql = r#"
                UPDATE flights SET
                    photo_count = COALESCE((
                        SELECT COUNT(*) FROM (
                            SELECT is_photo, LAG(is_photo) OVER (ORDER BY timestamp_ms) AS prev_photo
                            FROM telemetry WHERE flight_id = flights.id
                        ) sub WHERE is_photo = true AND (prev_photo IS NULL OR prev_photo = false)
                    ), 0),
                    video_count = COALESCE((
                        SELECT COUNT(*) FROM (
                            SELECT is_video, LAG(is_video) OVER (ORDER BY timestamp_ms) AS prev_video
                            FROM telemetry WHERE flight_id = flights.id
                        ) sub WHERE is_video = true AND (prev_video IS NULL OR prev_video = false)
                    ), 0)
                WHERE photo_count IS NULL OR video_count IS NULL
            "#;
            match conn.execute_batch(backfill_sql) {
                Ok(()) => log::info!("Backfilled photo/video counts successfully"),
                Err(e) => log::warn!("Failed to backfill photo/video counts: {}", e),
            }
        }

        Ok(())
    }

    /// Migrate telemetry table - only add missing columns
    fn migrate_telemetry_table(conn: &Connection) -> Result<(), DatabaseError> {
        let columns = Self::get_table_columns(conn, "telemetry")?;
        
        let migrations: &[(&str, &str)] = &[
            ("height", "ALTER TABLE telemetry ADD COLUMN height FLOAT"),
            ("vps_height", "ALTER TABLE telemetry ADD COLUMN vps_height FLOAT"),
            ("rc_uplink", "ALTER TABLE telemetry ADD COLUMN rc_uplink INTEGER"),
            ("rc_downlink", "ALTER TABLE telemetry ADD COLUMN rc_downlink INTEGER"),
            ("rc_aileron", "ALTER TABLE telemetry ADD COLUMN rc_aileron FLOAT"),
            ("rc_elevator", "ALTER TABLE telemetry ADD COLUMN rc_elevator FLOAT"),
            ("rc_throttle", "ALTER TABLE telemetry ADD COLUMN rc_throttle FLOAT"),
            ("rc_rudder", "ALTER TABLE telemetry ADD COLUMN rc_rudder FLOAT"),
            ("is_photo", "ALTER TABLE telemetry ADD COLUMN is_photo BOOLEAN"),
            ("is_video", "ALTER TABLE telemetry ADD COLUMN is_video BOOLEAN"),
            ("cell_voltages", "ALTER TABLE telemetry ADD COLUMN cell_voltages VARCHAR"),
            ("battery_full_capacity", "ALTER TABLE telemetry ADD COLUMN battery_full_capacity FLOAT"),
            ("battery_remained_capacity", "ALTER TABLE telemetry ADD COLUMN battery_remained_capacity FLOAT"),
        ];

        for (col_name, sql) in migrations {
            if !columns.contains(*col_name) {
                log::info!("Migrating telemetry table: adding {} column", col_name);
                conn.execute_batch(sql)?;
            }
        }
        Ok(())
    }

    /// Migrate flight_tags table - only add missing columns
    fn migrate_flight_tags_table(conn: &Connection) -> Result<(), DatabaseError> {
        let columns = Self::get_table_columns(conn, "flight_tags")?;
        
        if !columns.contains("tag_type") {
            log::info!("Migrating flight_tags table: adding tag_type column");
            conn.execute_batch(
                "ALTER TABLE flight_tags ADD COLUMN tag_type VARCHAR DEFAULT 'auto';",
            )?;
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_flight_tags_type ON flight_tags(tag_type);",
            )?;
        }
        
        // Update existing tags with NULL tag_type to 'auto' (migration backfill)
        // This handles rows created before the tag_type column existed
        conn.execute_batch(
            "UPDATE flight_tags SET tag_type = 'auto' WHERE tag_type IS NULL;",
        )?;
        
        Ok(())
    }

    /// Migrate flight_messages table — expand PK to include message text.
    /// Old PK was (flight_id, timestamp_ms, message_type) which silently dropped
    /// multiple messages at the same timestamp+type. State-change tracking can
    /// produce several messages per frame, so we need the wider key.
    fn migrate_flight_messages_table(conn: &Connection) -> Result<(), DatabaseError> {
        const MIGRATION_KEY: &str = "flight_messages_pk_expanded";

        let already_migrated: bool = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?",
                params![MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .map(|v| v == "true")
            .unwrap_or(false);

        if already_migrated {
            return Ok(());
        }

        // Check if the table exists at all
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM information_schema.tables WHERE table_name = 'flight_messages'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !table_exists {
            // Table will be created by the main schema; just mark done
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                params![MIGRATION_KEY, "true"],
            )?;
            return Ok(());
        }

        log::info!("Migrating flight_messages table: expanding primary key to include message text");

        conn.execute_batch(
            r#"
            CREATE TABLE flight_messages_new (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                message_type    VARCHAR NOT NULL,
                message         VARCHAR NOT NULL,
                PRIMARY KEY (flight_id, timestamp_ms, message_type, message)
            );
            INSERT INTO flight_messages_new SELECT * FROM flight_messages;
            DROP TABLE flight_messages;
            ALTER TABLE flight_messages_new RENAME TO flight_messages;
            CREATE INDEX IF NOT EXISTS idx_flight_messages_flight ON flight_messages(flight_id);
            "#,
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![MIGRATION_KEY, "true"],
        )?;

        log::info!("flight_messages PK migration complete");
        Ok(())
    }

    /// Migrate keychains table - change PK from serial_number to file_hash
    fn migrate_keychains_table(conn: &Connection) -> Result<(), DatabaseError> {
        let has_serial_number: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM information_schema.columns WHERE table_name = 'keychains' AND column_name = 'serial_number'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
            
        if has_serial_number {
            log::info!("Migrating keychains table: replacing serial_number with file_hash PK");
            conn.execute_batch(
                r#"
                DROP TABLE keychains;
                CREATE TABLE keychains (
                    file_hash       VARCHAR PRIMARY KEY,
                    encryption_key  VARCHAR NOT NULL,
                    fetched_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
                "#,
            )?;
        }
        Ok(())
    }

    /// Migrate telemetry table column types from DOUBLE to FLOAT for non-critical metrics.
    /// This reduces storage by ~50% for numeric columns while preserving full precision
    /// for latitude/longitude coordinates. Only runs once.
    fn migrate_telemetry_types(conn: &Connection) -> Result<(), DatabaseError> {
        const MIGRATION_KEY: &str = "telemetry_float_migrated";
        
        // Check if migration already completed using a marker in the settings table
        let already_migrated: bool = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?",
                params![MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .map(|v| v == "true")
            .unwrap_or(false);
        
        if already_migrated {
            log::debug!("Telemetry type migration already completed, skipping");
            return Ok(());
        }
        
        // Check if telemetry table exists and has data
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry", [], |row| row.get(0))
            .unwrap_or(0);
        
        if row_count == 0 {
            // Empty table or new install - just mark as done
            log::debug!("Telemetry table empty, marking float migration as complete");
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                params![MIGRATION_KEY, "true"],
            )?;
            return Ok(());
        }
        
        // Check if any DOUBLE columns exist (need migration)
        // Query column types from DuckDB's information schema
        let needs_migration: bool = conn
            .query_row(
                r#"
                SELECT COUNT(*) > 0 
                FROM information_schema.columns 
                WHERE table_name = 'telemetry' 
                  AND column_name = 'altitude' 
                  AND data_type = 'DOUBLE'
                "#,
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        
        if !needs_migration {
            log::debug!("Telemetry columns already using FLOAT types");
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                params![MIGRATION_KEY, "true"],
            )?;
            return Ok(());
        }
        
        log::info!(
            "Migrating telemetry table types: DOUBLE -> FLOAT for {} rows (this may take a moment)...",
            row_count
        );
        let start = std::time::Instant::now();
        
        // Recreate table with optimized types:
        // - DOUBLE preserved for latitude, longitude (need ~15 decimal precision for GPS)
        // - FLOAT for everything else (7 decimal precision is plenty for altitude, speed, etc.)
        conn.execute_batch(
            r#"
            BEGIN TRANSACTION;
            
            CREATE TABLE telemetry_optimized (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        FLOAT,
                height          FLOAT,
                vps_height      FLOAT,
                altitude_abs    FLOAT,
                speed           FLOAT,
                velocity_x      FLOAT,
                velocity_y      FLOAT,
                velocity_z      FLOAT,
                pitch           FLOAT,
                roll            FLOAT,
                yaw             FLOAT,
                gimbal_pitch    FLOAT,
                gimbal_roll     FLOAT,
                gimbal_yaw      FLOAT,
                battery_percent INTEGER,
                battery_voltage FLOAT,
                battery_current FLOAT,
                battery_temp    FLOAT,
                cell_voltages   VARCHAR,
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,
                rc_aileron      FLOAT,
                rc_elevator     FLOAT,
                rc_throttle     FLOAT,
                rc_rudder       FLOAT,
                is_photo        BOOLEAN,
                is_video        BOOLEAN,
                battery_full_capacity FLOAT,
                battery_remained_capacity FLOAT,
                PRIMARY KEY (flight_id, timestamp_ms)
            );
            
            INSERT INTO telemetry_optimized 
            SELECT 
                flight_id,
                timestamp_ms,
                latitude,
                longitude,
                CAST(altitude AS FLOAT),
                CAST(height AS FLOAT),
                CAST(vps_height AS FLOAT),
                CAST(altitude_abs AS FLOAT),
                CAST(speed AS FLOAT),
                CAST(velocity_x AS FLOAT),
                CAST(velocity_y AS FLOAT),
                CAST(velocity_z AS FLOAT),
                CAST(pitch AS FLOAT),
                CAST(roll AS FLOAT),
                CAST(yaw AS FLOAT),
                CAST(gimbal_pitch AS FLOAT),
                CAST(gimbal_roll AS FLOAT),
                CAST(gimbal_yaw AS FLOAT),
                battery_percent,
                CAST(battery_voltage AS FLOAT),
                CAST(battery_current AS FLOAT),
                CAST(battery_temp AS FLOAT),
                cell_voltages,
                flight_mode,
                gps_signal,
                satellites,
                rc_signal,
                rc_uplink,
                rc_downlink,
                CAST(rc_aileron AS FLOAT),
                CAST(rc_elevator AS FLOAT),
                CAST(rc_throttle AS FLOAT),
                CAST(rc_rudder AS FLOAT),
                is_photo,
                is_video,
                CAST(battery_full_capacity AS FLOAT),
                CAST(battery_remained_capacity AS FLOAT)
            FROM telemetry;
            
            DROP TABLE telemetry;
            ALTER TABLE telemetry_optimized RENAME TO telemetry;
            
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time 
                ON telemetry(flight_id, timestamp_ms);
            
            COMMIT;
            "#,
        )?;
        
        log::info!(
            "Telemetry type migration completed in {:.1}s for {} rows",
            start.elapsed().as_secs_f64(),
            row_count
        );
        
        // Run VACUUM to reclaim space (must be outside transaction)
        log::info!("Running VACUUM to reclaim disk space...");
        let vacuum_start = std::time::Instant::now();
        if let Err(e) = conn.execute_batch("VACUUM;") {
            log::warn!("VACUUM failed (non-fatal): {}", e);
        } else {
            log::info!("VACUUM completed in {:.1}s", vacuum_start.elapsed().as_secs_f64());
        }
        
        // Mark migration as complete
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![MIGRATION_KEY, "true"],
        )?;
        
        log::info!("Telemetry type migration marked as complete");
        Ok(())
    }

    fn ensure_telemetry_column_order(conn: &Connection) -> Result<(), DatabaseError> {
        let expected = vec![
            "flight_id",
            "timestamp_ms",
            "latitude",
            "longitude",
            "altitude",
            "height",
            "vps_height",
            "altitude_abs",
            "speed",
            "velocity_x",
            "velocity_y",
            "velocity_z",
            "pitch",
            "roll",
            "yaw",
            "gimbal_pitch",
            "gimbal_roll",
            "gimbal_yaw",
            "battery_percent",
            "battery_voltage",
            "battery_current",
            "battery_temp",
            "cell_voltages",
            "flight_mode",
            "gps_signal",
            "satellites",
            "rc_signal",
            "rc_uplink",
            "rc_downlink",
            "rc_aileron",
            "rc_elevator",
            "rc_throttle",
            "rc_rudder",
            "is_photo",
            "is_video",
            "battery_full_capacity",
            "battery_remained_capacity",
        ];

        let mut stmt = conn.prepare("PRAGMA table_info('telemetry')")?;
        let actual: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;

        if actual.iter().map(String::as_str).eq(expected.iter().copied()) {
            return Ok(());
        }

        log::warn!("Telemetry column order mismatch detected. Rebuilding table with correct schema.");

        let existing: std::collections::HashSet<&str> =
            actual.iter().map(|s| s.as_str()).collect();

        let select_list = expected
            .iter()
            .map(|col| {
                if existing.contains(col) {
                    col.to_string()
                } else {
                    format!("NULL AS {}", col)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        // Use explicit schema to preserve PRIMARY KEY and correct column types
        // (DOUBLE for lat/lon precision, FLOAT for everything else to save space)
        conn.execute_batch(&format!(
            r#"
            BEGIN TRANSACTION;
            
            CREATE TABLE telemetry_reordered (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        FLOAT,
                height          FLOAT,
                vps_height      FLOAT,
                altitude_abs    FLOAT,
                speed           FLOAT,
                velocity_x      FLOAT,
                velocity_y      FLOAT,
                velocity_z      FLOAT,
                pitch           FLOAT,
                roll            FLOAT,
                yaw             FLOAT,
                gimbal_pitch    FLOAT,
                gimbal_roll     FLOAT,
                gimbal_yaw      FLOAT,
                battery_percent INTEGER,
                battery_voltage FLOAT,
                battery_current FLOAT,
                battery_temp    FLOAT,
                cell_voltages   VARCHAR,
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,
                rc_aileron      FLOAT,
                rc_elevator     FLOAT,
                rc_throttle     FLOAT,
                rc_rudder       FLOAT,
                is_photo        BOOLEAN,
                is_video        BOOLEAN,
                battery_full_capacity FLOAT,
                battery_remained_capacity FLOAT
            );
            
            INSERT INTO telemetry_reordered SELECT {} FROM telemetry;
            DROP TABLE telemetry;
            ALTER TABLE telemetry_reordered RENAME TO telemetry;
            
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time
                ON telemetry(flight_id, timestamp_ms);
            
            COMMIT;
            "#,
            select_list
        ))?;

        Ok(())
    }

    /// Generate a new unique flight ID using timestamp + random
    pub fn generate_flight_id(&self) -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        // Use lower bits for uniqueness
        timestamp % 1_000_000_000_000
    }

    /// Insert flight metadata and return the flight ID
    pub fn insert_flight(&self, flight: &FlightMetadata) -> Result<i64, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            r#"
            INSERT INTO flights (
                id, file_name, display_name, file_hash, drone_model, drone_serial,
                aircraft_name, battery_serial, cycle_count,
                start_time, end_time, duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count,
                photo_count, video_count, rc_serial, battery_life
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                flight.id,
                flight.file_name,
                flight.display_name,
                flight.file_hash,
                flight.drone_model,
                flight.drone_serial,
                flight.aircraft_name,
                flight.battery_serial,
                flight.cycle_count,
                flight.start_time.map(|t| t.to_rfc3339()),
                flight.end_time.map(|t| t.to_rfc3339()),
                flight.duration_secs,
                flight.total_distance,
                flight.max_altitude,
                flight.max_speed,
                flight.home_lat,
                flight.home_lon,
                flight.point_count,
                flight.photo_count,
                flight.video_count,
                flight.rc_serial,
                flight.battery_life,
            ],
        )?;

        log::info!("Inserted flight with ID: {}", flight.id);
        Ok(flight.id)
    }

    /// Bulk insert telemetry data using DuckDB's Appender for maximum performance
    ///
    /// This is significantly faster than individual INSERT statements for large datasets.
    pub fn bulk_insert_telemetry(
        &self,
        flight_id: i64,
        points: &[TelemetryPoint],
    ) -> Result<usize, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        // Use DuckDB Appender for high-performance bulk inserts
        let mut appender = conn.appender("telemetry")?;

        let mut inserted = 0usize;
        let mut skipped = 0usize;

        for point in points {
            // Serialize cell_voltages to JSON string for storage
            let cell_voltages_json: Option<String> = point.cell_voltages.as_ref().map(|v| {
                serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
            });
            match appender.append_row(params![
                flight_id,
                point.timestamp_ms,
                point.latitude,
                point.longitude,
                point.altitude,
                point.height,
                point.vps_height,
                point.altitude_abs,
                point.speed,
                point.velocity_x,
                point.velocity_y,
                point.velocity_z,
                point.pitch,
                point.roll,
                point.yaw,
                point.gimbal_pitch,
                point.gimbal_roll,
                point.gimbal_yaw,
                point.battery_percent,
                point.battery_voltage,
                point.battery_current,
                point.battery_temp,
                cell_voltages_json.as_deref(),
                point.flight_mode.as_deref(),
                point.gps_signal,
                point.satellites,
                point.rc_signal,
                point.rc_uplink,
                point.rc_downlink,
                point.rc_aileron,
                point.rc_elevator,
                point.rc_throttle,
                point.rc_rudder,
                point.is_photo,
                point.is_video,
                point.battery_full_capacity,
                point.battery_remained_capacity,
            ]) {
                Ok(()) => inserted += 1,
                Err(err) => {
                    let message = err.to_string().to_lowercase();
                    if message.contains("primary key")
                        || message.contains("unique key")
                        || message.contains("duplicate key")
                    {
                        skipped += 1;
                        continue;
                    }
                    return Err(DatabaseError::from(err));
                }
            }
        }

        appender.flush()?;

        log::info!(
            "Bulk inserted {} telemetry points for flight {} ({} skipped)",
            inserted,
            flight_id,
            skipped
        );
        Ok(inserted)
    }

    /// Get all flights metadata (for the flight list sidebar)
    pub fn get_all_flights(&self) -> Result<Vec<Flight>, DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            r#"
            SELECT 
                id, file_name, COALESCE(display_name, file_name) AS display_name,
                file_hash,
                drone_model, drone_serial, aircraft_name, battery_serial,
                CAST(start_time AS VARCHAR) AS start_time,
                duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count,
                photo_count, video_count, notes, COALESCE(color, '#7dd3fc') AS color,
                cycle_count, rc_serial, battery_life
            FROM flights
            ORDER BY start_time DESC
            "#,
        )?;

        let mut flights: Vec<Flight> = stmt
            .query_map([], |row| {
                Ok(Flight {
                    id: row.get(0)?,
                    file_name: row.get(1)?,
                    display_name: row.get(2)?,
                    file_hash: row.get(3)?,
                    drone_model: row.get(4)?,
                    drone_serial: row.get(5)?,
                    aircraft_name: row.get(6)?,
                    battery_serial: row.get(7)?,
                    cycle_count: row.get(20)?,
                    start_time: row.get(8)?,
                    duration_secs: row.get(9)?,
                    total_distance: row.get(10)?,
                    max_altitude: row.get(11)?,
                    max_speed: row.get(12)?,
                    home_lat: row.get(13)?,
                    home_lon: row.get(14)?,
                    point_count: row.get(15)?,
                    photo_count: row.get(16)?,
                    video_count: row.get(17)?,
                    tags: Vec::new(),
                    notes: row.get(18)?,
                    color: row.get(19)?,
                    rc_serial: row.get(21)?,
                    battery_life: row.get(22)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Load all tags and attach to flights
        // Use a separate query to avoid breaking if flight_tags table doesn't exist yet
        let tag_map = self.get_all_flight_tags_with_conn(&conn);
        if let Ok(tags) = tag_map {
            for flight in &mut flights {
                if let Some(flight_tags) = tags.get(&flight.id) {
                    flight.tags = flight_tags.clone();
                }
            }
        }

        log::debug!("get_all_flights: {} rows in {:.1}ms", flights.len(), start.elapsed().as_secs_f64() * 1000.0);
        Ok(flights)
    }

    /// Helper: get all flight tags using an existing connection lock
    fn get_all_flight_tags_with_conn(&self, conn: &Connection) -> Result<std::collections::HashMap<i64, Vec<FlightTag>>, DatabaseError> {
        let mut stmt = conn.prepare(
            "SELECT flight_id, tag, tag_type FROM flight_tags ORDER BY flight_id, tag",
        )?;
        let mut map: std::collections::HashMap<i64, Vec<FlightTag>> = std::collections::HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (flight_id, tag, tag_type) = row?;
            map.entry(flight_id).or_default().push(FlightTag { tag, tag_type });
        }
        Ok(map)
    }

    /// Get a single flight by ID (avoids loading all flights)
    pub fn get_flight_by_id(&self, flight_id: i64) -> Result<Flight, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        let mut flight = conn.query_row(
            r#"
            SELECT 
                id, file_name, COALESCE(display_name, file_name) AS display_name,
                file_hash, drone_model, drone_serial, aircraft_name, battery_serial,
                CAST(start_time AS VARCHAR) AS start_time,
                duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count,
                photo_count, video_count, notes, COALESCE(color, '#7dd3fc') AS color,
                cycle_count, rc_serial, battery_life
            FROM flights
            WHERE id = ?
            "#,
            params![flight_id],
            |row| {
                Ok(Flight {
                    id: row.get(0)?,
                    file_name: row.get(1)?,
                    display_name: row.get(2)?,
                    file_hash: row.get(3)?,
                    drone_model: row.get(4)?,
                    drone_serial: row.get(5)?,
                    aircraft_name: row.get(6)?,
                    battery_serial: row.get(7)?,
                    cycle_count: row.get(20)?,
                    start_time: row.get(8)?,
                    duration_secs: row.get(9)?,
                    total_distance: row.get(10)?,
                    max_altitude: row.get(11)?,
                    max_speed: row.get(12)?,
                    home_lat: row.get(13)?,
                    home_lon: row.get(14)?,
                    point_count: row.get(15)?,
                    photo_count: row.get(16)?,
                    video_count: row.get(17)?,
                    tags: Vec::new(),
                    notes: row.get(18)?,
                    color: row.get(19)?,
                    rc_serial: row.get(21)?,
                    battery_life: row.get(22)?,
                })
            },
        )
        .map_err(|e| match e {
            duckdb::Error::QueryReturnedNoRows => DatabaseError::FlightNotFound(flight_id),
            other => DatabaseError::DuckDb(other),
        })?;

        // Load tags for this flight
        if let Ok(mut stmt) = conn.prepare("SELECT tag, tag_type FROM flight_tags WHERE flight_id = ? ORDER BY tag") {
            if let Ok(tags) = stmt
                .query_map(params![flight_id], |row| {
                    Ok(FlightTag {
                        tag: row.get::<_, String>(0)?,
                        tag_type: row.get::<_, String>(1)?,
                    })
                })
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            {
                flight.tags = tags;
            }
        }

        Ok(flight)
    }

    /// Get flight telemetry with automatic downsampling for large datasets.
    ///
    /// Strategy:
    /// - If max_points is None: return all raw data (for export)
    /// - If points <= max_points: return raw data
    /// - If points > max_points: group by time-bucket intervals, averaging values
    /// - This keeps the frontend responsive while preserving data trends
    ///
    /// `known_point_count` avoids an extra COUNT query when the flight metadata
    /// already provides the point count.
    pub fn get_flight_telemetry(
        &self,
        flight_id: i64,
        max_points: Option<usize>,
        known_point_count: Option<i64>,
    ) -> Result<Vec<TelemetryRecord>, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        // None = return all raw data (for export); Some(n) = downsample for display
        if max_points.is_none() {
            log::debug!("Returning all raw telemetry points for flight {} (export mode)", flight_id);
            return self.query_raw_telemetry(&conn, flight_id);
        }

        let max_points = max_points.unwrap();

        // Guard against invalid API input that would cause divide-by-zero in downsampling.
        if max_points == 0 {
            log::warn!(
                "max_points=0 for flight {}, returning raw telemetry instead",
                flight_id
            );
            return self.query_raw_telemetry(&conn, flight_id);
        }

        // Use known count or fall back to a COUNT query
        let point_count = match known_point_count {
            Some(c) if c > 0 => {
                // When a flight is expected to be downsampled, verify persisted metadata against
                // actual telemetry rows. This avoids NULL MIN/MAX aggregates when metadata is stale.
                if c as usize > max_points {
                    let actual: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM telemetry WHERE flight_id = ?",
                        params![flight_id],
                        |row| row.get(0),
                    )?;

                    if actual != c {
                        log::warn!(
                            "Telemetry point count mismatch for flight {}: metadata={}, actual={}",
                            flight_id,
                            c,
                            actual
                        );
                    }

                    if actual == 0 {
                        return Ok(Vec::new());
                    }

                    actual
                } else {
                    c
                }
            }
            _ => {
                let c: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM telemetry WHERE flight_id = ?",
                    params![flight_id],
                    |row| row.get(0),
                )?;
                // Return empty vec for flights with no telemetry (e.g., manual entries)
                if c == 0 {
                    return Ok(Vec::new());
                }
                c
            }
        };

        let records = if point_count as usize <= max_points {
            // Return raw data - no downsampling needed
            log::debug!(
                "Returning {} raw telemetry points for flight {}",
                point_count,
                flight_id
            );
            self.query_raw_telemetry(&conn, flight_id)?
        } else {
            // Downsample using 1-second interval averaging
            log::debug!(
                "Downsampling {} points to ~{} for flight {}",
                point_count,
                max_points,
                flight_id
            );
            self.query_downsampled_telemetry(&conn, flight_id, max_points)?
        };

        Ok(records)
    }

    /// Query raw telemetry without any downsampling
    fn query_raw_telemetry(
        &self,
        conn: &Connection,
        flight_id: i64,
    ) -> Result<Vec<TelemetryRecord>, DatabaseError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                timestamp_ms,
                latitude,
                longitude, 
                altitude,
                height,
                vps_height,
                speed,
                velocity_x,
                velocity_y,
                velocity_z,
                battery_percent,
                battery_voltage,
                battery_temp,
                cell_voltages,
                pitch,
                roll,
                yaw,
                gimbal_pitch,
                gimbal_roll,
                gimbal_yaw,
                satellites,
                flight_mode,
                rc_signal,
                rc_uplink,
                rc_downlink,
                rc_aileron,
                rc_elevator,
                rc_throttle,
                rc_rudder,
                is_photo,
                is_video,
                battery_full_capacity,
                battery_remained_capacity
            FROM telemetry
            WHERE flight_id = ?
            ORDER BY timestamp_ms ASC
            "#,
        )?;

        let records = stmt
            .query_map(params![flight_id], |row| {
                // Parse cell_voltages from JSON string
                let cell_voltages_json: Option<String> = row.get(13)?;
                let cell_voltages = cell_voltages_json.and_then(|s| {
                    serde_json::from_str::<Vec<f64>>(&s).ok()
                });
                
                Ok(TelemetryRecord {
                    timestamp_ms: row.get(0)?,
                    latitude: row.get(1)?,
                    longitude: row.get(2)?,
                    altitude: row.get(3)?,
                    height: row.get(4)?,
                    vps_height: row.get(5)?,
                    speed: row.get(6)?,
                    velocity_x: row.get(7)?,
                    velocity_y: row.get(8)?,
                    velocity_z: row.get(9)?,
                    battery_percent: row.get(10)?,
                    battery_voltage: row.get(11)?,
                    battery_temp: row.get(12)?,
                    cell_voltages,
                    pitch: row.get(14)?,
                    roll: row.get(15)?,
                    yaw: row.get(16)?,
                    gimbal_pitch: row.get(17)?,
                    gimbal_roll: row.get(18)?,
                    gimbal_yaw: row.get(19)?,
                    satellites: row.get(20)?,
                    flight_mode: row.get(21)?,
                    rc_signal: row.get(22)?,
                    rc_uplink: row.get(23)?,
                    rc_downlink: row.get(24)?,
                    rc_aileron: row.get(25)?,
                    rc_elevator: row.get(26)?,
                    rc_throttle: row.get(27)?,
                    rc_rudder: row.get(28)?,
                    is_photo: row.get(29)?,
                    is_video: row.get(30)?,
                    battery_current: None,
                    battery_full_capacity: row.get(31)?,
                    battery_remained_capacity: row.get(32)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Query telemetry with downsampling using DuckDB's analytical capabilities
    ///
    /// Groups data into time buckets and averages values for smooth visualization
    fn query_downsampled_telemetry(
        &self,
        conn: &Connection,
        flight_id: i64,
        target_points: usize,
    ) -> Result<Vec<TelemetryRecord>, DatabaseError> {
        // Calculate the bucket size in milliseconds based on flight duration and target points
        let (min_ts, max_ts): (Option<i64>, Option<i64>) = conn.query_row(
            "SELECT MIN(timestamp_ms), MAX(timestamp_ms) FROM telemetry WHERE flight_id = ?",
            params![flight_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let (min_ts, max_ts) = match (min_ts, max_ts) {
            (Some(min_ts), Some(max_ts)) => (min_ts, max_ts),
            _ => {
                log::warn!(
                    "No telemetry rows found while downsampling flight {}. Returning empty result.",
                    flight_id
                );
                return Ok(Vec::new());
            }
        };

        let duration_ms = max_ts - min_ts;
        let bucket_size_ms = (duration_ms / target_points as i64).max(1000); // At least 1 second

        let mut stmt = conn.prepare(
            r#"
            WITH bucketed AS (
                SELECT 
                    (timestamp_ms / ?) * ? AS bucket_ts,
                    AVG(latitude) AS latitude,
                    AVG(longitude) AS longitude,
                    AVG(altitude) AS altitude,
                    AVG(height) AS height,
                    AVG(vps_height) AS vps_height,
                    AVG(speed) AS speed,
                    AVG(velocity_x) AS velocity_x,
                    AVG(velocity_y) AS velocity_y,
                    AVG(velocity_z) AS velocity_z,
                    AVG(battery_percent)::INTEGER AS battery_percent,
                    AVG(battery_voltage) AS battery_voltage,
                    AVG(battery_temp) AS battery_temp,
                    FIRST(cell_voltages ORDER BY timestamp_ms) AS cell_voltages,
                    AVG(pitch) AS pitch,
                    AVG(roll) AS roll,
                    AVG(yaw) AS yaw,
                    AVG(gimbal_pitch) AS gimbal_pitch,
                    AVG(gimbal_roll) AS gimbal_roll,
                    AVG(gimbal_yaw) AS gimbal_yaw,
                    ROUND(AVG(satellites))::INTEGER AS satellites,
                    FIRST(flight_mode ORDER BY timestamp_ms) AS flight_mode,
                    AVG(rc_signal)::INTEGER AS rc_signal,
                    AVG(rc_uplink)::INTEGER AS rc_uplink,
                    AVG(rc_downlink)::INTEGER AS rc_downlink,
                    AVG(rc_aileron) AS rc_aileron,
                    AVG(rc_elevator) AS rc_elevator,
                    AVG(rc_throttle) AS rc_throttle,
                    AVG(rc_rudder) AS rc_rudder,
                    BOOL_OR(is_photo) AS is_photo,
                    BOOL_OR(is_video) AS is_video,
                    AVG(battery_full_capacity) AS battery_full_capacity,
                    AVG(battery_remained_capacity) AS battery_remained_capacity
                FROM telemetry
                WHERE flight_id = ?
                GROUP BY bucket_ts
                ORDER BY bucket_ts ASC
            )
            SELECT * FROM bucketed
            "#,
        )?;

        let records = stmt
            .query_map(params![bucket_size_ms, bucket_size_ms, flight_id], |row| {
                // Parse cell_voltages from JSON string
                let cell_voltages_json: Option<String> = row.get(13)?;
                let cell_voltages = cell_voltages_json.and_then(|s| {
                    serde_json::from_str::<Vec<f64>>(&s).ok()
                });
                
                Ok(TelemetryRecord {
                    timestamp_ms: row.get(0)?,
                    latitude: row.get(1)?,
                    longitude: row.get(2)?,
                    altitude: row.get(3)?,
                    height: row.get(4)?,
                    vps_height: row.get(5)?,
                    speed: row.get(6)?,
                    velocity_x: row.get(7)?,
                    velocity_y: row.get(8)?,
                    velocity_z: row.get(9)?,
                    battery_percent: row.get(10)?,
                    battery_voltage: row.get(11)?,
                    battery_temp: row.get(12)?,
                    cell_voltages,
                    pitch: row.get(14)?,
                    roll: row.get(15)?,
                    yaw: row.get(16)?,
                    gimbal_pitch: row.get(17)?,
                    gimbal_roll: row.get(18)?,
                    gimbal_yaw: row.get(19)?,
                    satellites: row.get(20)?,
                    flight_mode: row.get(21)?,
                    rc_signal: row.get(22)?,
                    rc_uplink: row.get(23)?,
                    rc_downlink: row.get(24)?,
                    rc_aileron: row.get(25)?,
                    rc_elevator: row.get(26)?,
                    rc_throttle: row.get(27)?,
                    rc_rudder: row.get(28)?,
                    is_photo: row.get(29)?,
                    is_video: row.get(30)?,
                    battery_current: None,
                    battery_full_capacity: row.get(31)?,
                    battery_remained_capacity: row.get(32)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Delete a flight and all associated telemetry data
    pub fn delete_flight(&self, flight_id: i64) -> Result<(), DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "DELETE FROM telemetry WHERE flight_id = ?",
            params![flight_id],
        )?;
        // Clean up tags (ignore errors if table doesn't exist in old DBs)
        let _ = conn.execute(
            "DELETE FROM flight_tags WHERE flight_id = ?",
            params![flight_id],
        );
        // Clean up messages (ignore errors if table doesn't exist in old DBs)
        let _ = conn.execute(
            "DELETE FROM flight_messages WHERE flight_id = ?",
            params![flight_id],
        );
        conn.execute("DELETE FROM flights WHERE id = ?", params![flight_id])?;

        log::info!("Deleted flight {} in {:.1}ms", flight_id, start.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }

    /// Delete all flights and associated telemetry
    pub fn delete_all_flights(&self) -> Result<(), DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        conn.execute("DELETE FROM telemetry", params![])?;
        let _ = conn.execute("DELETE FROM flight_tags", params![]);
        let _ = conn.execute("DELETE FROM flight_messages", params![]);
        conn.execute("DELETE FROM flights", params![])?;

        log::info!("Deleted all flights and telemetry in {:.1}ms", start.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }

    /// Get battery full capacity history across flights for a given battery serial
    /// Returns (flight_id, start_time, max_full_capacity) tuples
    pub fn get_battery_full_capacity_history(
        &self,
        battery_serial: &str,
    ) -> Result<Vec<(i64, String, f64)>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT f.id, CAST(f.start_time AS VARCHAR), MAX(t.battery_full_capacity)
            FROM flights f
            JOIN telemetry t ON t.flight_id = f.id
            WHERE f.battery_serial = ?
              AND t.battery_full_capacity IS NOT NULL
              AND t.battery_full_capacity > 0
            GROUP BY f.id, f.start_time
            ORDER BY f.start_time ASC
            "#,
        )?;
        let rows = stmt
            .query_map(params![battery_serial], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Get overview stats across all flights
    pub fn get_overview_stats(&self) -> Result<OverviewStats, DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        // Basic aggregate stats
        let (total_flights, total_distance, total_duration, total_points, total_photos, total_videos, max_altitude): (i64, f64, f64, i64, i64, i64, f64) =
            conn.query_row(
                r#"
                SELECT
                    COUNT(*)::BIGINT,
                    COALESCE(SUM(total_distance), 0)::DOUBLE,
                    COALESCE(SUM(duration_secs), 0)::DOUBLE,
                    COALESCE(SUM(point_count), 0)::BIGINT,
                    COALESCE(SUM(photo_count), 0)::BIGINT,
                    COALESCE(SUM(video_count), 0)::BIGINT,
                    COALESCE(MAX(max_altitude), 0)::DOUBLE
                FROM flights
                "#,
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )?;

        // Battery usage with total duration and max cycle count
        let mut stmt = conn.prepare(
            r#"
            SELECT battery_serial, COUNT(*)::BIGINT AS flight_count, COALESCE(SUM(duration_secs), 0)::DOUBLE AS total_duration,
                   MAX(cycle_count)::INTEGER AS max_cycle_count
            FROM flights
            WHERE battery_serial IS NOT NULL AND battery_serial <> ''
            GROUP BY battery_serial
            ORDER BY flight_count DESC
            "#,
        )?;

        let batteries_used = stmt
            .query_map([], |row| {
                Ok(BatteryUsage {
                    battery_serial: row.get(0)?,
                    flight_count: row.get(1)?,
                    total_duration_secs: row.get(2)?,
                    max_cycle_count: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Drone usage stats - group by serial when available, otherwise by model
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                COALESCE(MAX(drone_model), 'Unknown') AS drone_model, 
                drone_serial,
                MAX(aircraft_name) AS aircraft_name,
                COUNT(*)::BIGINT AS flight_count
            FROM flights
            WHERE drone_serial IS NOT NULL AND drone_serial != ''
            GROUP BY drone_serial
            UNION ALL
            SELECT 
                COALESCE(drone_model, 'Unknown') AS drone_model, 
                NULL AS drone_serial,
                MAX(aircraft_name) AS aircraft_name,
                COUNT(*)::BIGINT AS flight_count
            FROM flights
            WHERE drone_serial IS NULL OR drone_serial = ''
            GROUP BY drone_model
            ORDER BY flight_count DESC
            "#,
        )?;

        let drones_used = stmt
            .query_map([], |row| {
                Ok(DroneUsage {
                    drone_model: row.get(0)?,
                    drone_serial: row.get(1)?,
                    aircraft_name: row.get(2)?,
                    flight_count: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Flights by date for activity heatmap (last 365 days).
        // Grouping in Rust avoids DATE_TRUNC/TZ function paths that can require ICU.
        let mut stmt = conn.prepare(
            r#"
            SELECT CAST(start_time AS VARCHAR) AS start_time
            FROM flights
            WHERE start_time IS NOT NULL
            "#,
        )?;

        let cutoff_date = Utc::now().date_naive() - Duration::days(365);
        let mut date_counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();

        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            let ts = row?;
            if ts.len() < 10 {
                continue;
            }

            let date_part = &ts[..10];
            let Ok(parsed_date) = NaiveDate::parse_from_str(date_part, "%Y-%m-%d") else {
                continue;
            };

            if parsed_date < cutoff_date {
                continue;
            }

            *date_counts.entry(date_part.to_string()).or_insert(0) += 1;
        }

        let flights_by_date = date_counts
            .into_iter()
            .map(|(date, count)| FlightDateCount { date, count })
            .collect::<Vec<_>>();

        // Top 3 longest flights
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                id,
                COALESCE(display_name, file_name) AS display_name,
                COALESCE(duration_secs, 0)::DOUBLE AS duration_secs,
                CAST(start_time AS VARCHAR) AS start_time
            FROM flights
            WHERE duration_secs IS NOT NULL
            ORDER BY duration_secs DESC
            LIMIT 3
            "#,
        )?;

        let top_flights = stmt
            .query_map([], |row| {
                Ok(TopFlight {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    duration_secs: row.get(2)?,
                    start_time: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Max distance from home per flight (for top furthest calculation)
        let mut stmt = conn.prepare(
            r#"
            SELECT
                f.id,
                COALESCE(f.display_name, f.file_name) AS display_name,
                COALESCE(MAX(
                    CASE WHEN f.home_lat IS NOT NULL AND f.home_lon IS NOT NULL
                         AND t.latitude IS NOT NULL AND t.longitude IS NOT NULL
                         AND NOT (ABS(t.latitude) < 0.000001 AND ABS(t.longitude) < 0.000001)
                    THEN
                        6371000 * 2 * ASIN(SQRT(
                            POWER(SIN(RADIANS(t.latitude - f.home_lat) / 2), 2) +
                            COS(RADIANS(f.home_lat)) * COS(RADIANS(t.latitude)) *
                            POWER(SIN(RADIANS(t.longitude - f.home_lon) / 2), 2)
                        ))
                    ELSE 0 END
                ), 0)::DOUBLE AS max_distance_from_home_m,
                CAST(f.start_time AS VARCHAR) AS start_time
            FROM flights f
            LEFT JOIN telemetry t ON f.id = t.flight_id
            WHERE NOT (ABS(f.home_lat) < 0.000001 AND ABS(f.home_lon) < 0.000001)
               OR f.home_lat IS NULL
            GROUP BY f.id, f.display_name, f.file_name, f.start_time
            ORDER BY max_distance_from_home_m DESC
            "#,
        )?;

        let top_distance_flights = stmt
            .query_map([], |row| {
                Ok(TopDistanceFlight {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    max_distance_from_home_m: row.get(2)?,
                    start_time: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Battery health points (delta % / minute) per flight
        let mut stmt = conn.prepare(
            r#"
            SELECT
                f.id,
                f.battery_serial,
                CAST(f.start_time AS VARCHAR) AS start_time,
                COALESCE(f.duration_secs, 0)::DOUBLE AS duration_secs,
                (MAX(t.battery_percent) - MIN(t.battery_percent))::DOUBLE AS delta_percent
            FROM flights f
            JOIN telemetry t ON f.id = t.flight_id
            WHERE f.battery_serial IS NOT NULL AND f.battery_serial <> ''
              AND t.battery_percent IS NOT NULL
            GROUP BY f.id, f.battery_serial, f.start_time, f.duration_secs
            ORDER BY f.start_time ASC
            "#,
        )?;

        let battery_health_points = stmt
            .query_map([], |row| {
                let duration_secs: f64 = row.get(3)?;
                let duration_mins = if duration_secs > 0.0 { duration_secs / 60.0 } else { 0.0 };
                let delta_percent: f64 = row.get(4)?;
                let rate_per_min = if duration_mins > 0.0 { delta_percent / duration_mins } else { 0.0 };

                Ok(BatteryHealthPoint {
                    flight_id: row.get(0)?,
                    battery_serial: row.get(1)?,
                    start_time: row.get(2)?,
                    duration_mins,
                    delta_percent,
                    rate_per_min,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Derive global max distance from the per-flight results (no extra query needed)
        let max_distance_from_home = top_distance_flights
            .first()
            .map(|f| f.max_distance_from_home_m)
            .unwrap_or(0.0);

        log::debug!(
            "get_overview_stats: {} flights, {} batteries, {} drones in {:.1}ms",
            total_flights, batteries_used.len(), drones_used.len(),
            start.elapsed().as_secs_f64() * 1000.0
        );

        Ok(OverviewStats {
            total_flights,
            total_distance_m: total_distance,
            total_duration_secs: total_duration,
            total_points,
            total_photos,
            total_videos,
            max_altitude_m: max_altitude,
            max_distance_from_home_m: max_distance_from_home,
            batteries_used,
            drones_used,
            flights_by_date,
            top_flights,
            top_distance_flights,
            battery_health_points,
        })
    }

    /// Update the display name for a flight and persist to customizations overlay
    pub fn update_flight_name(&self, flight_id: i64, display_name: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE flights SET display_name = ? WHERE id = ?",
            params![display_name, flight_id],
        )?;
        // Write-through to customizations overlay (keyed by file_hash)
        Self::save_customization_field(&conn, flight_id, "display_name", Some(display_name))?;

        log::debug!("Updated flight {} display name to '{}'", flight_id, display_name);
        Ok(())
    }

    /// Update the notes for a flight and persist to customizations overlay
    pub fn update_flight_notes(&self, flight_id: i64, notes: Option<&str>) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE flights SET notes = ? WHERE id = ?",
            params![notes, flight_id],
        )?;
        // Write-through to customizations overlay (keyed by file_hash)
        Self::save_customization_field(&conn, flight_id, "notes", notes)?;

        log::debug!("Updated flight {} notes", flight_id);
        Ok(())
    }

    /// Update the color label for a flight and persist to customizations overlay
    pub fn update_flight_color(&self, flight_id: i64, color: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE flights SET color = ? WHERE id = ?",
            params![color, flight_id],
        )?;
        // Write-through to customizations overlay (keyed by file_hash)
        Self::save_customization_field(&conn, flight_id, "color", Some(color))?;

        log::debug!("Updated flight {} color to '{}'", flight_id, color);
        Ok(())
    }

    // ================================================================
    // TAG MANAGEMENT
    // ================================================================

    /// Insert multiple tags for a flight (used during import, always type 'auto')
    pub fn insert_flight_tags(&self, flight_id: i64, tags: &[String]) -> Result<(), DatabaseError> {
        if tags.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for tag in tags {
            let trimmed = tag.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Use INSERT OR IGNORE to avoid duplicate key errors
            conn.execute(
                "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'auto')",
                params![flight_id, trimmed],
            )?;
        }
        log::debug!("Inserted {} tags for flight {}", tags.len(), flight_id);
        Ok(())
    }

    /// Get all tags for a specific flight
    pub fn get_flight_tags(&self, flight_id: i64) -> Result<Vec<FlightTag>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tag, tag_type FROM flight_tags WHERE flight_id = ? ORDER BY tag",
        )?;
        let tags = stmt
            .query_map(params![flight_id], |row| {
                Ok(FlightTag {
                    tag: row.get::<_, String>(0)?,
                    tag_type: row.get::<_, String>(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    /// Add a single tag to a flight (manual user-added tag) and sync to customizations overlay
    pub fn add_flight_tag(&self, flight_id: i64, tag: &str) -> Result<(), DatabaseError> {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'manual')",
            params![flight_id, trimmed],
        )?;
        // Sync manual tags to customizations overlay
        Self::sync_manual_tags_to_customizations(&conn, flight_id)?;
        log::debug!("Added manual tag '{}' to flight {}", trimmed, flight_id);
        Ok(())
    }

    /// Remove a single tag from a flight and sync to customizations overlay
    pub fn remove_flight_tag(&self, flight_id: i64, tag: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM flight_tags WHERE flight_id = ? AND tag = ?",
            params![flight_id, tag.trim()],
        )?;
        // Sync manual tags to customizations overlay
        Self::sync_manual_tags_to_customizations(&conn, flight_id)?;
        log::debug!("Removed tag '{}' from flight {}", tag, flight_id);
        Ok(())
    }

    /// Get all unique tags across all flights
    pub fn get_all_unique_tags(&self) -> Result<Vec<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT tag FROM flight_tags ORDER BY tag",
        )?;
        let tags = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    /// Replace all auto tags for a flight with new ones (keeps manual tags)
    pub fn replace_auto_tags(&self, flight_id: i64, new_tags: &[String]) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        // Delete existing auto tags
        conn.execute(
            "DELETE FROM flight_tags WHERE flight_id = ? AND tag_type = 'auto'",
            params![flight_id],
        )?;
        // Insert new auto tags
        for tag in new_tags {
            let trimmed = tag.trim();
            if trimmed.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'auto')",
                params![flight_id, trimmed],
            )?;
        }
        Ok(())
    }

    /// Remove all auto-generated tags from all flights (keeps manual tags)
    /// Returns the number of auto tags removed
    pub fn remove_all_auto_tags(&self) -> Result<usize, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let removed = conn.execute(
            "DELETE FROM flight_tags WHERE tag_type = 'auto'",
            [],
        )?;
        Ok(removed)
    }

    /// Get all flight IDs (for bulk operations like tag regeneration)
    pub fn get_all_flight_ids(&self) -> Result<Vec<i64>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM flights ORDER BY id")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    // ================================================================
    // MESSAGE MANAGEMENT
    // ================================================================

    /// Insert flight messages (tips and warnings) for a flight
    pub fn insert_flight_messages(&self, flight_id: i64, messages: &[FlightMessage]) -> Result<(), DatabaseError> {
        if messages.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        // Some logs carry 10,000+ app messages. Inserting them row by row took minutes while
        // holding the profile's connection, stalling every other request for that profile.
        // Append them to a constraint-free staging table instead, then copy them over in one
        // statement; INSERT OR IGNORE still skips rows that would break the primary key.
        conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS flight_messages_staging (
                flight_id BIGINT, timestamp_ms BIGINT, message_type VARCHAR, message VARCHAR
            );
            DELETE FROM flight_messages_staging;",
        )?;
        let result = (|| -> Result<(), DatabaseError> {
            {
                let mut appender = conn.appender("flight_messages_staging")?;
                for msg in messages {
                    appender.append_row(params![flight_id, msg.timestamp_ms, msg.message_type, msg.message])?;
                }
                appender.flush()?;
            }
            conn.execute(
                "INSERT OR IGNORE INTO flight_messages (flight_id, timestamp_ms, message_type, message)
                 SELECT DISTINCT flight_id, timestamp_ms, message_type, message FROM flight_messages_staging",
                params![],
            )?;
            Ok(())
        })();
        let _ = conn.execute("DELETE FROM flight_messages_staging", params![]);
        result?;
        log::debug!("Inserted {} messages for flight {}", messages.len(), flight_id);
        Ok(())
    }

    /// Get all messages for a flight
    pub fn get_flight_messages(&self, flight_id: i64) -> Result<Vec<FlightMessage>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT timestamp_ms, message_type, message FROM flight_messages WHERE flight_id = ? ORDER BY timestamp_ms",
        )?;
        let messages = stmt
            .query_map(params![flight_id], |row| {
                Ok(FlightMessage {
                    timestamp_ms: row.get(0)?,
                    message_type: row.get(1)?,
                    message: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(messages)
    }

    /// Delete all messages for a flight
    #[allow(dead_code)]
    pub fn delete_flight_messages(&self, flight_id: i64) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM flight_messages WHERE flight_id = ?",
            params![flight_id],
        )?;
        Ok(())
    }

    // ========================================================================
    // FLIGHT CUSTOMIZATIONS OVERLAY
    // Persists user-edited metadata (display_name, notes, color, manual_tags)
    // keyed by file_hash so they survive delete + reimport cycles.
    // ========================================================================

    /// Save a single customization field for a flight (looked up by file_hash).
    /// Skips flights without a file_hash (e.g. manual entries).
    fn save_customization_field(
        conn: &Connection,
        flight_id: i64,
        field: &str,
        value: Option<&str>,
    ) -> Result<(), DatabaseError> {
        // Look up the file_hash for this flight
        let file_hash: Option<String> = conn
            .query_row(
                "SELECT file_hash FROM flights WHERE id = ?",
                params![flight_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let hash = match file_hash {
            Some(h) if !h.is_empty() => h,
            _ => return Ok(()), // Manual entry — skip
        };

        // Ensure a row exists for this file_hash
        conn.execute(
            "INSERT OR IGNORE INTO flight_customizations (file_hash) VALUES (?)",
            params![hash],
        )?;
        // Update the specific field
        let sql = format!(
            "UPDATE flight_customizations SET {} = ?, updated_at = CURRENT_TIMESTAMP WHERE file_hash = ?",
            field
        );
        conn.execute(&sql, params![value, hash])?;
        Ok(())
    }

    /// Sync the current set of manual tags for a flight into the customizations overlay.
    fn sync_manual_tags_to_customizations(
        conn: &Connection,
        flight_id: i64,
    ) -> Result<(), DatabaseError> {
        // Look up the file_hash for this flight
        let file_hash: Option<String> = conn
            .query_row(
                "SELECT file_hash FROM flights WHERE id = ?",
                params![flight_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let hash = match file_hash {
            Some(h) if !h.is_empty() => h,
            _ => return Ok(()), // Manual entry — skip
        };

        // Collect current manual tags
        let mut stmt = conn.prepare(
            "SELECT tag FROM flight_tags WHERE flight_id = ? AND tag_type = 'manual' ORDER BY tag",
        )?;
        let tags: Vec<String> = stmt
            .query_map(params![flight_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());

        conn.execute(
            "INSERT OR IGNORE INTO flight_customizations (file_hash) VALUES (?)",
            params![hash],
        )?;
        conn.execute(
            "UPDATE flight_customizations SET manual_tags = ?, updated_at = CURRENT_TIMESTAMP WHERE file_hash = ?",
            params![tags_json, hash],
        )?;
        Ok(())
    }

    /// Look up saved customizations for a file_hash.
    /// Returns (display_name, notes, color, manual_tags_json) if found.
    pub fn get_flight_customizations(
        &self,
        file_hash: &str,
    ) -> Result<Option<(Option<String>, Option<String>, Option<String>, Option<String>)>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let result = conn
            .query_row(
                "SELECT display_name, notes, color, manual_tags FROM flight_customizations WHERE file_hash = ?",
                params![file_hash],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        Ok(result)
    }

    /// Apply any previously saved customizations to a newly imported flight.
    /// Restores display_name, notes, color, and manual tags from the overlay table.
    /// Returns true if customizations were applied, false otherwise.
    pub fn apply_saved_customizations(&self, flight_id: i64, file_hash: &str) -> Result<bool, DatabaseError> {
        let customizations = self.get_flight_customizations(file_hash)?;
        let (display_name, notes, color, manual_tags_json) = match customizations {
            Some(c) => c,
            None => return Ok(false),
        };

        let conn = self.conn.lock().unwrap();

        if let Some(ref name) = display_name {
            conn.execute(
                "UPDATE flights SET display_name = ? WHERE id = ?",
                params![name, flight_id],
            )?;
        }
        if let Some(ref n) = notes {
            conn.execute(
                "UPDATE flights SET notes = ? WHERE id = ?",
                params![n, flight_id],
            )?;
        }
        if let Some(ref c) = color {
            conn.execute(
                "UPDATE flights SET color = ? WHERE id = ?",
                params![c, flight_id],
            )?;
        }
        if let Some(ref tags_json) = manual_tags_json {
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(tags_json) {
                for tag in &tags {
                    let trimmed = tag.trim();
                    if !trimmed.is_empty() {
                        conn.execute(
                            "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'manual')",
                            params![flight_id, trimmed],
                        )?;
                    }
                }
            }
        }

        let had_customizations = display_name.is_some()
            || notes.is_some()
            || color.is_some()
            || manual_tags_json.is_some();

        if had_customizations {
            log::info!("Restored saved customizations for flight {} (file_hash: {})", flight_id, file_hash);
        }
        Ok(had_customizations)
    }

    // ========================================================================
    // EQUIPMENT NAMES
    // ========================================================================

    /// Set a custom display name for a battery or aircraft
    pub fn set_equipment_name(&self, serial: &str, equipment_type: &str, display_name: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let serial_upper = serial.trim().to_uppercase();
        
        if display_name.trim().is_empty() {
            // Empty name = delete the mapping
            conn.execute(
                "DELETE FROM equipment_names WHERE serial = ? AND equipment_type = ?",
                params![serial_upper, equipment_type],
            )?;
            log::info!("Removed {} name for serial {}", equipment_type, serial_upper);
        } else {
            conn.execute(
                "INSERT OR REPLACE INTO equipment_names (serial, equipment_type, display_name, updated_at) 
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
                params![serial_upper, equipment_type, display_name.trim()],
            )?;
            log::info!("Set {} name for serial {}: {}", equipment_type, serial_upper, display_name.trim());
        }
        Ok(())
    }

    /// Get all equipment names of a given type (battery or aircraft)
    pub fn get_equipment_names(&self, equipment_type: &str) -> Result<Vec<(String, String)>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT serial, display_name FROM equipment_names WHERE equipment_type = ? ORDER BY serial"
        )?;
        let names = stmt
            .query_map(params![equipment_type], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    }

    /// Get all equipment names (both batteries and aircraft) as a map
    pub fn get_all_equipment_names(&self) -> Result<(Vec<(String, String)>, Vec<(String, String)>), DatabaseError> {
        let battery_names = self.get_equipment_names("battery")?;
        let aircraft_names = self.get_equipment_names("aircraft")?;
        Ok((battery_names, aircraft_names))
    }

    /// Check if a file has already been imported (by hash)
    /// Returns the display_name of the matching flight if found, None otherwise
    pub fn is_file_imported(&self, file_hash: &str) -> Result<Option<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        let result: Option<String> = conn.query_row(
            "SELECT COALESCE(display_name, file_name) FROM flights WHERE file_hash = ? LIMIT 1",
            params![file_hash],
            |row| row.get(0),
        ).optional()?;

        Ok(result)
    }

    /// Get all file hashes from existing flights
    /// Used by sync to filter out already-imported files (web feature only)
    #[allow(dead_code)]
    pub fn get_all_file_hashes(&self) -> Result<Vec<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT file_hash FROM flights WHERE file_hash IS NOT NULL AND file_hash != ''"
        )?;
        let hashes = stmt.query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(hashes)
    }

    /// Add a file hash to sync blacklist (idempotent).
    pub fn add_to_sync_blacklist(&self, file_hash: &str) -> Result<(), DatabaseError> {
        let hash = file_hash.trim();
        if hash.is_empty() {
            return Ok(());
        }

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO sync_blacklist (file_hash, created_at) VALUES (?, CURRENT_TIMESTAMP)",
            params![hash],
        )?;
        Ok(())
    }

    /// Remove a file hash from sync blacklist.
    pub fn remove_from_sync_blacklist(&self, file_hash: &str) -> Result<(), DatabaseError> {
        let hash = file_hash.trim();
        if hash.is_empty() {
            return Ok(());
        }

        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sync_blacklist WHERE file_hash = ?", params![hash])?;
        Ok(())
    }

    /// Clear all sync blacklist entries.
    pub fn clear_sync_blacklist(&self) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sync_blacklist", [])?;
        Ok(())
    }

    /// Get all blacklisted file hashes.
    pub fn get_sync_blacklist_hashes(&self) -> Result<Vec<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT file_hash FROM sync_blacklist ORDER BY created_at DESC")?;
        let hashes = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(hashes)
    }

    /// Check whether a file hash is blacklisted.
    #[allow(dead_code)]
    pub fn is_sync_blacklisted(&self, file_hash: &str) -> Result<bool, DatabaseError> {
        let hash = file_hash.trim();
        if hash.is_empty() {
            return Ok(false);
        }

        let conn = self.conn.lock().unwrap();
        let exists: Option<i32> = conn
            .query_row(
                "SELECT 1 FROM sync_blacklist WHERE file_hash = ? LIMIT 1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        Ok(exists.is_some())
    }

    /// Check if a duplicate flight exists based on exact signature match (drone_serial + battery_serial + start_time).
    /// Returns the display_name of the matching flight if found, None otherwise.
    /// If any of the signature fields are None, returns None (can't reliably deduplicate).
    pub fn is_duplicate_flight(
        &self,
        drone_serial: Option<&str>,
        battery_serial: Option<&str>,
        start_time: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<Option<String>, DatabaseError> {
        // We need at least drone_serial and start_time to check for duplicates
        let drone = match drone_serial {
            Some(d) if !d.is_empty() => d,
            _ => return Ok(None),
        };
        let time = match start_time {
            Some(t) => t,
            None => return Ok(None),
        };

        let conn = self.conn.lock().unwrap();

        // Build query based on whether battery_serial is available
        let result: Option<String> = match battery_serial {
            Some(b) if !b.is_empty() => {
                // Full check: drone + battery + start_time
                conn.query_row(
                    r#"
                    SELECT COALESCE(display_name, file_name) FROM flights 
                    WHERE drone_serial = ?
                      AND battery_serial = ?
                      AND start_time IS NOT NULL
                      AND start_time = ?::TIMESTAMPTZ
                    LIMIT 1
                    "#,
                    params![drone, b, time.to_rfc3339()],
                    |row| row.get(0),
                ).optional()?
            }
            _ => {
                // Partial check: drone + start_time only (battery unknown)
                // Also match flights that have NULL battery_serial
                conn.query_row(
                    r#"
                    SELECT COALESCE(display_name, file_name) FROM flights 
                    WHERE drone_serial = ?
                      AND (battery_serial IS NULL OR battery_serial = '')
                      AND start_time IS NOT NULL
                      AND start_time = ?::TIMESTAMPTZ
                    LIMIT 1
                    "#,
                    params![drone, time.to_rfc3339()],
                    |row| row.get(0),
                ).optional()?
            }
        };

        Ok(result)
    }

    /// Remove duplicate flights from the database based on exact signature match (drone_serial + battery_serial + start_time).
    /// Keeps the flight with the most telemetry points for each duplicate group.
    /// Returns the number of duplicates removed.
    pub fn deduplicate_flights(&self) -> Result<usize, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let start = std::time::Instant::now();
        log::info!("Starting flight deduplication...");

        let mut total_removed = 0;

        // Method 1: Remove exact file_hash duplicates (keep the one with most telemetry points)
        let hash_duplicates = conn.execute(
            r#"
            WITH hash_duplicates AS (
                SELECT file_hash, COUNT(*) as cnt
                FROM flights
                WHERE file_hash IS NOT NULL AND file_hash != ''
                GROUP BY file_hash
                HAVING COUNT(*) > 1
            ),
            ranked_flights AS (
                SELECT f.id, f.file_hash, f.point_count,
                       ROW_NUMBER() OVER (PARTITION BY f.file_hash ORDER BY f.point_count DESC, f.id ASC) as rn
                FROM flights f
                WHERE f.file_hash IN (SELECT file_hash FROM hash_duplicates)
            )
            DELETE FROM flights WHERE id IN (
                SELECT id FROM ranked_flights WHERE rn > 1
            )
            "#,
            [],
        )?;
        total_removed += hash_duplicates;
        log::info!("Removed {} file_hash duplicates", hash_duplicates);

        // Method 2: Remove signature-based duplicates (same drone + battery + exact same start_time)
        // This catches re-imports of the same flight from different sources
        let signature_duplicates = conn.execute(
            r#"
            WITH flight_pairs AS (
                SELECT 
                    f1.id as id1,
                    f2.id as id2,
                    f1.point_count as points1,
                    f2.point_count as points2
                FROM flights f1
                JOIN flights f2 ON f1.drone_serial = f2.drone_serial
                    AND f1.battery_serial = f2.battery_serial
                    AND f1.id < f2.id
                    AND f1.start_time = f2.start_time
                WHERE f1.drone_serial IS NOT NULL AND f1.drone_serial != ''
                  AND f1.battery_serial IS NOT NULL AND f1.battery_serial != ''
                  AND f1.start_time IS NOT NULL
                  AND f2.start_time IS NOT NULL
            ),
            ids_to_delete AS (
                SELECT CASE 
                    WHEN points1 >= points2 THEN id2
                    ELSE id1
                END as id
                FROM flight_pairs
            )
            DELETE FROM flights WHERE id IN (SELECT DISTINCT id FROM ids_to_delete)
            "#,
            [],
        )?;
        total_removed += signature_duplicates;
        log::info!("Removed {} signature-based duplicates", signature_duplicates);

        // Clean up orphaned telemetry data
        let orphaned_telemetry = conn.execute(
            "DELETE FROM telemetry WHERE flight_id NOT IN (SELECT id FROM flights)",
            [],
        )?;
        log::info!("Cleaned up {} orphaned telemetry records", orphaned_telemetry);

        // Clean up orphaned tags
        let orphaned_tags = conn.execute(
            "DELETE FROM flight_tags WHERE flight_id NOT IN (SELECT id FROM flights)",
            [],
        )?;
        log::info!("Cleaned up {} orphaned tags", orphaned_tags);

        log::info!(
            "Deduplication complete in {:.1}s: {} total duplicate flights removed",
            start.elapsed().as_secs_f64(),
            total_removed
        );

        Ok(total_removed)
    }

    /// Retrieve cached keychain for a log file by its SHA-256 hash.
    /// Returns the deserialized keychain data if found, or `None` if not cached
    /// or if deserialization fails (corrupt cache row is treated as a miss).
    pub fn get_cached_keychain(&self, file_hash: &str) -> Result<Option<Vec<Vec<dji_log_parser::keychain::KeychainFeaturePoint>>>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT encryption_key FROM keychains WHERE file_hash = ?")?;
        
        let mut rows = stmt.query(params![file_hash])?;
        if let Some(row) = rows.next()? {
            let json_str: String = row.get(0)?;
            match serde_json::from_str(&json_str) {
                Ok(keychains) => {
                    log::debug!("Found cached keychain for file_hash: {}", file_hash);
                    Ok(Some(keychains))
                }
                Err(e) => {
                    log::warn!("Failed to deserialize cached keychain for file_hash: {}: {}", file_hash, e);
                    Ok(None)
                }
            }
        } else {
            Ok(None)
        }
    }

    /// Save fetched keychain data to the local cache, keyed by the log file's SHA-256 hash.
    /// The keychain is serialized as JSON. Overwrites any existing entry for the same hash.
    pub fn save_cached_keychain(&self, file_hash: &str, keychains: &[Vec<dji_log_parser::keychain::KeychainFeaturePoint>]) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let json_str = serde_json::to_string(keychains).map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())))?;
        
        conn.execute(
            "INSERT OR REPLACE INTO keychains (file_hash, encryption_key) VALUES (?, ?)",
            params![file_hash, json_str],
        )?;
        
        log::debug!("Saved keychain to cache for file_hash: {}", file_hash);
        Ok(())
    }

    /// Get a setting value by key
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        
        let result: Result<String, _> = conn.query_row(
            "SELECT value FROM settings WHERE key = ?",
            params![key],
            |row| row.get(0),
        );
        
        match result {
            Ok(value) => Ok(Some(value)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DatabaseError::from(e)),
        }
    }

    /// Set a setting value (insert or update)
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        
        // DuckDB doesn't support CURRENT_TIMESTAMP in ON CONFLICT, so use INSERT OR REPLACE
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
        
        Ok(())
    }

    /// Run one-time startup deduplication for existing data.
    /// This only runs once - on first startup after the dedup feature is added.
    /// After running, it sets a flag so it won't run again.
    fn run_startup_deduplication(&self) {
        const SETTING_KEY: &str = "duplicate_checked";
        
        // Check if we've already run deduplication
        match self.get_setting(SETTING_KEY) {
            Ok(Some(value)) if value == "true" => {
                log::debug!("Startup deduplication already completed, skipping");
                return;
            }
            Ok(_) => {
                // Not set or not "true", run deduplication
            }
            Err(e) => {
                log::warn!("Failed to check dedup setting: {}, proceeding with deduplication", e);
            }
        }

        log::info!("Running one-time startup deduplication for existing flights...");
        
        match self.deduplicate_flights() {
            Ok(count) => {
                if count > 0 {
                    log::info!("Startup deduplication removed {} duplicate flights", count);
                } else {
                    log::info!("Startup deduplication complete, no duplicates found");
                }
            }
            Err(e) => {
                log::error!("Startup deduplication failed: {}", e);
                // Don't set the flag if dedup failed - try again next startup
                return;
            }
        }

        // Mark deduplication as complete
        if let Err(e) = self.set_setting(SETTING_KEY, "true") {
            log::error!("Failed to save dedup completion flag: {}", e);
        }
    }

    /// One-time migration: backfill the `flight_customizations` table with
    /// existing user-modified data (display_name, notes, color, manual tags)
    /// so that flights customized before this feature was added are also
    /// preserved across delete + reimport cycles.
    fn backfill_flight_customizations(&self) {
        const SETTING_KEY: &str = "customizations_backfilled";

        match self.get_setting(SETTING_KEY) {
            Ok(Some(value)) if value == "true" => {
                log::debug!("Flight customizations backfill already completed, skipping");
                return;
            }
            Ok(_) => {}
            Err(e) => {
                log::warn!("Failed to check customizations backfill setting: {}, proceeding", e);
            }
        }

        log::info!("Backfilling flight_customizations from existing flights...");

        let conn = self.conn.lock().unwrap();

        // Backfill flights that have user-modified display_name, notes, or non-default color.
        // A flight has a modified display_name if it differs from the file stem (file_name without extension).
        // We only consider flights that have a file_hash (skip manual entries).
        let result = conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO flight_customizations (file_hash, display_name, notes, color, updated_at)
            SELECT
                f.file_hash,
                CASE WHEN f.display_name != regexp_replace(f.file_name, '\.[^.]+$', '') THEN f.display_name ELSE NULL END,
                f.notes,
                CASE WHEN f.color != '#7dd3fc' THEN f.color ELSE NULL END,
                CURRENT_TIMESTAMP
            FROM flights f
            WHERE f.file_hash IS NOT NULL
              AND f.file_hash != ''
              AND (
                  f.display_name != regexp_replace(f.file_name, '\.[^.]+$', '')
                  OR f.notes IS NOT NULL
                  OR (f.color IS NOT NULL AND f.color != '#7dd3fc')
              );
            "#,
        );

        if let Err(e) = result {
            log::error!("Failed to backfill flight customizations (display_name/notes/color): {}", e);
            return;
        }

        // Backfill manual tags: for each flight with manual tags and a file_hash,
        // collect the tags as a JSON array and update the customizations row.
        // First ensure rows exist, then update.
        let tag_result = conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO flight_customizations (file_hash)
            SELECT DISTINCT f.file_hash
            FROM flight_tags ft
            JOIN flights f ON f.id = ft.flight_id
            WHERE ft.tag_type = 'manual'
              AND f.file_hash IS NOT NULL
              AND f.file_hash != '';

            UPDATE flight_customizations SET
                manual_tags = sub.tags_json,
                updated_at = CURRENT_TIMESTAMP
            FROM (
                SELECT
                    f.file_hash AS fh,
                    '["' || string_agg(ft.tag, '","' ORDER BY ft.tag) || '"]' AS tags_json
                FROM flight_tags ft
                JOIN flights f ON f.id = ft.flight_id
                WHERE ft.tag_type = 'manual'
                  AND f.file_hash IS NOT NULL
                  AND f.file_hash != ''
                GROUP BY f.file_hash
            ) AS sub
            WHERE flight_customizations.file_hash = sub.fh;
            "#,
        );

        if let Err(e) = tag_result {
            log::error!("Failed to backfill flight customizations (manual_tags): {}", e);
            return;
        }

        // Remove rows where all customization fields are NULL (no actual changes)
        let _ = conn.execute_batch(
            r#"
            DELETE FROM flight_customizations
            WHERE display_name IS NULL
              AND notes IS NULL
              AND color IS NULL
              AND manual_tags IS NULL;
            "#,
        );

        drop(conn);

        // Count how many were backfilled
        if let Ok(conn) = self.conn.lock() {
            if let Ok(count) = conn.query_row(
                "SELECT COUNT(*) FROM flight_customizations",
                [],
                |row| row.get::<_, i64>(0),
            ) {
                log::info!("Flight customizations backfill complete: {} entries", count);
            }
        }

        if let Err(e) = self.set_setting(SETTING_KEY, "true") {
            log::error!("Failed to save customizations backfill flag: {}", e);
        }
    }

    /// Export the entire database to a compressed backup file.
    ///
    /// Uses DuckDB's Parquet COPY for each table, then packs them into a single
    /// gzip-compressed tar archive.  The resulting `.db.backup` file is portable
    /// and can be restored with `import_backup`.
    #[allow(dead_code)]
    pub fn export_backup(&self, dest_path: &std::path::Path) -> Result<(), DatabaseError> {
        self.export_backup_with_progress(dest_path, |_, _| {})
    }

    /// Export backup with staged progress callbacks (0-100).
    pub fn export_backup_with_progress<F>(
        &self,
        dest_path: &std::path::Path,
        mut on_progress: F,
    ) -> Result<(), DatabaseError>
    where
        F: FnMut(u8, &str),
    {
        let start = std::time::Instant::now();
        log::info!("Starting database backup to {:?}", dest_path);
        on_progress(5, "Preparing backup workspace");

        // Create a temp directory for the Parquet exports
        let temp_dir = std::env::temp_dir().join(format!("dji-logbook-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;

        let conn = self.conn.lock().unwrap();

        // Export each table to Parquet (fast, compressed, columnar)
        let flights_path = temp_dir.join("flights.parquet");
        let telemetry_path = temp_dir.join("telemetry.parquet");
        let keychains_path = temp_dir.join("keychains.parquet");
        let tags_path = temp_dir.join("flight_tags.parquet");
        let messages_path = temp_dir.join("flight_messages.parquet");
        let equipment_names_path = temp_dir.join("equipment_names.parquet");
        let customizations_path = temp_dir.join("flight_customizations.parquet");
        let settings_path = temp_dir.join("settings.parquet");

        on_progress(10, "Exporting flights table");
        conn.execute_batch(&format!(
            "COPY flights    TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            flights_path.to_string_lossy()
        ))?;
        on_progress(25, "Exporting telemetry table");
        conn.execute_batch(&format!(
            "COPY telemetry  TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            telemetry_path.to_string_lossy()
        ))?;
        on_progress(35, "Exporting keychains table");
        conn.execute_batch(&format!(
            "COPY keychains  TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            keychains_path.to_string_lossy()
        ))?;
        on_progress(45, "Exporting optional tables");
        // Export tags table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY flight_tags TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            tags_path.to_string_lossy()
        ));
        // Export messages table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY flight_messages TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            messages_path.to_string_lossy()
        ));
        // Export equipment_names table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY equipment_names TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            equipment_names_path.to_string_lossy()
        ));
        // Export flight_customizations table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY flight_customizations TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            customizations_path.to_string_lossy()
        ));
        // Export settings table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY settings TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            settings_path.to_string_lossy()
        ));

        drop(conn); // release the lock while we tar

        // Pack the Parquet files into a gzip-compressed tar archive
    on_progress(65, "Packaging backup archive");
        let dest_file = fs::File::create(dest_path)?;
        let gz = flate2::write::GzEncoder::new(dest_file, flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);

        for name in &["flights.parquet", "telemetry.parquet", "keychains.parquet", "flight_tags.parquet", "flight_messages.parquet", "equipment_names.parquet", "flight_customizations.parquet", "settings.parquet"] {
            let file_path = temp_dir.join(name);
            if file_path.exists() {
                tar.append_path_with_name(&file_path, name)
                    .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            }
        }

        tar.into_inner()
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
            .finish()
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        // Clean up temp dir
        on_progress(90, "Cleaning up temporary files");
        let _ = fs::remove_dir_all(&temp_dir);

        on_progress(100, "Backup complete");

        log::info!(
            "Database backup completed in {:.1}s → {:?}",
            start.elapsed().as_secs_f64(),
            dest_path
        );
        Ok(())
    }

    /// Import a backup file, restoring all flight data.
    ///
    /// Existing records are kept.  If a flight with the same ID already exists
    /// it is overwritten (its telemetry is replaced as well).
    #[allow(dead_code)]
    pub fn import_backup(&self, src_path: &std::path::Path) -> Result<String, DatabaseError> {
        self.import_backup_with_progress(src_path, |_, _| {})
    }

    /// Import backup with staged progress callbacks (0-100).
    pub fn import_backup_with_progress<F>(
        &self,
        src_path: &std::path::Path,
        mut on_progress: F,
    ) -> Result<String, DatabaseError>
    where
        F: FnMut(u8, &str),
    {
        let start = std::time::Instant::now();
        log::info!("Starting database restore from {:?}", src_path);
        on_progress(5, "Preparing restore workspace");

        // Extract the tar.gz archive to a temp directory
        let temp_dir = std::env::temp_dir().join(format!("dji-logbook-restore-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;

        let file = fs::File::open(src_path)?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        on_progress(15, "Extracting backup archive");
        archive.unpack(&temp_dir)
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, format!("Failed to extract backup archive: {}", e))))?;

        let flights_path = temp_dir.join("flights.parquet");
        let telemetry_path = temp_dir.join("telemetry.parquet");
        let keychains_path = temp_dir.join("keychains.parquet");

        if !flights_path.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(DatabaseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid backup file: missing flights.parquet",
            )));
        }

        let conn = self.conn.lock().unwrap();

        // --- Restore flights ---
        on_progress(30, "Restoring flights");
        // The flights table has multiple UNIQUE/PRIMARY KEY constraints (id + file_hash),
        // so INSERT OR REPLACE is not supported.  Delete matching rows first, then insert.
        conn.execute_batch(&format!(
            r#"
            DELETE FROM flights
            WHERE id IN (SELECT id FROM read_parquet('{}'))
               OR file_hash IN (SELECT file_hash FROM read_parquet('{}') WHERE file_hash IS NOT NULL);
            "#,
            flights_path.to_string_lossy(),
            flights_path.to_string_lossy(),
        ))?;

        // Use BY NAME so backups remain compatible across schema changes and column-order drift.
        let restore_flights_sql = format!(
            r#"
            INSERT INTO flights BY NAME
            SELECT * FROM read_parquet('{}');
            "#,
            flights_path.to_string_lossy()
        );

        match conn.execute_batch(&restore_flights_sql) {
            Ok(()) => {}
            Err(err) => {
                let err_msg = err.to_string();
                // Backward-compat: older backups may lack display_name.
                if err_msg.contains("display_name") {
                    log::warn!(
                        "Backup flights.parquet is missing display_name ({}). Retrying with display_name synthesized from file_name.",
                        err_msg
                    );
                    conn.execute_batch(&format!(
                        r#"
                        INSERT INTO flights BY NAME
                        SELECT * REPLACE (COALESCE(display_name, file_name) AS display_name)
                        FROM read_parquet('{}');
                        "#,
                        flights_path.to_string_lossy()
                    ))?;
                } else {
                    return Err(DatabaseError::DuckDb(err));
                }
            }
        }

        let flights_restored: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM read_parquet('{}')", flights_path.to_string_lossy()),
            [],
            |row| row.get(0),
        )?;

        // --- Restore telemetry ---
        on_progress(45, "Restoring telemetry");
        if telemetry_path.exists() {
            // Get the set of flight IDs being restored so we can remove their
            // existing telemetry first (to handle overwrites cleanly).
            conn.execute_batch(&format!(
                r#"
                DELETE FROM telemetry
                WHERE flight_id IN (
                    SELECT DISTINCT flight_id FROM read_parquet('{}')
                );
                INSERT INTO telemetry BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                telemetry_path.to_string_lossy(),
                telemetry_path.to_string_lossy()
            ))?;
        }

        // --- Restore keychains ---
        on_progress(58, "Restoring keychains");
        if keychains_path.exists() {
            conn.execute_batch(&format!(
                r#"
                INSERT OR REPLACE INTO keychains BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                keychains_path.to_string_lossy()
            ))?;
        }

        // --- Restore flight tags (backward compatible — may not exist in old backups) ---
        on_progress(70, "Restoring tags and messages");
        let tags_path = temp_dir.join("flight_tags.parquet");
        if tags_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                DELETE FROM flight_tags
                WHERE flight_id IN (
                    SELECT DISTINCT flight_id FROM read_parquet('{}')
                );
                INSERT INTO flight_tags BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                tags_path.to_string_lossy(),
                tags_path.to_string_lossy()
            ));
        }

        // --- Restore flight messages (backward compatible — may not exist in old backups) ---
        let messages_path = temp_dir.join("flight_messages.parquet");
        if messages_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                DELETE FROM flight_messages
                WHERE flight_id IN (
                    SELECT DISTINCT flight_id FROM read_parquet('{}')
                );
                INSERT INTO flight_messages BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                messages_path.to_string_lossy(),
                messages_path.to_string_lossy()
            ));
        }

        // --- Restore equipment names (backward compatible — may not exist in old backups) ---
        on_progress(82, "Restoring settings and customizations");
        let equipment_names_path = temp_dir.join("equipment_names.parquet");
        if equipment_names_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                INSERT OR REPLACE INTO equipment_names BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                equipment_names_path.to_string_lossy()
            ));
        }

        // --- Restore flight customizations (backward compatible — may not exist in old backups) ---
        let customizations_path = temp_dir.join("flight_customizations.parquet");
        if customizations_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                INSERT OR REPLACE INTO flight_customizations BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                customizations_path.to_string_lossy()
            ));
        }

        // --- Restore settings (backward compatible — may not exist in old backups) ---
        let settings_path = temp_dir.join("settings.parquet");
        if settings_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                INSERT OR REPLACE INTO settings BY NAME
                SELECT * FROM read_parquet('{}');
                "#,
                settings_path.to_string_lossy()
            ));
        }

        drop(conn);

        // Clean up temp dir
        on_progress(94, "Cleaning up temporary files");
        let _ = fs::remove_dir_all(&temp_dir);

        let elapsed = start.elapsed().as_secs_f64();
        let msg = format!(
            "Restored {} flights in {:.1}s",
            flights_restored, elapsed
        );
        on_progress(100, "Restore complete");
        log::info!("{}", msg);
        Ok(msg)
    }
}

// ============================================================================
// Profile management (standalone functions operating on the data directory)
// ============================================================================

/// Validate a profile name. Returns Ok(()) if valid, Err with message otherwise.
pub fn validate_profile_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Profile name cannot be empty".to_string());
    }
    if name == "default" {
        return Err("Cannot use reserved name 'default'".to_string());
    }
    if name.len() > 50 {
        return Err("Profile name too long (max 50 characters)".to_string());
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("Profile name can only contain letters, numbers, hyphens, and underscores".to_string());
    }
    Ok(())
}

/// List all available profiles by scanning the data directory for flights*.db files.
pub fn list_profiles(data_dir: &std::path::Path) -> Vec<String> {
    let mut profiles = vec!["default".to_string()];

    if let Ok(entries) = fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Match flights_{profile}.db but not .db.wal, .db.bak, etc.
            if name.starts_with("flights_") && name.ends_with(".db") && !name.contains(".db.") {
                if let Some(profile) = name.strip_prefix("flights_").and_then(|s| s.strip_suffix(".db")) {
                    if !profile.is_empty() && !profiles.contains(&profile.to_string()) {
                        profiles.push(profile.to_string());
                    }
                }
            }
        }
    }

    profiles.sort();
    // Ensure "default" is always first
    if let Some(pos) = profiles.iter().position(|p| p == "default") {
        if pos != 0 {
            profiles.remove(pos);
            profiles.insert(0, "default".to_string());
        }
    }

    profiles
}

/// Get the currently active profile name from the persisted file.
pub fn get_active_profile(data_dir: &std::path::Path) -> String {
    let path = data_dir.join("active_profile.txt");
    fs::read_to_string(path)
        .unwrap_or_else(|_| "default".to_string())
        .trim()
        .to_string()
}

/// Persist the active profile name to a file.
pub fn set_active_profile(data_dir: &std::path::Path, profile: &str) -> Result<(), std::io::Error> {
    fs::write(data_dir.join("active_profile.txt"), profile)
}

/// Return the config file path for a given profile.
/// "default" → `config.json`, anything else → `config_{profile}.json`.
pub fn config_path_for_profile(data_dir: &std::path::Path, profile: &str) -> std::path::PathBuf {
    if profile == "default" {
        data_dir.join("config.json")
    } else {
        data_dir.join(format!("config_{}.json", profile))
    }
}

/// Return the default uploaded-files folder for a given profile.
/// "default" → `uploaded`, anything else → `uploaded/{profile}`.
pub fn default_upload_folder(data_dir: &std::path::Path, profile: &str) -> std::path::PathBuf {
    if profile == "default" {
        data_dir.join("uploaded")
    } else {
        data_dir.join("uploaded").join(profile)
    }
}

/// Return the sync folder path for a given profile.
/// When `SYNC_LOGS_PATH` provides a base path:
///   "default" → `{base}`, anything else → `{base}/{profile}`.
/// Returns `None` when the env-var is not set.
#[allow(dead_code)]
pub fn sync_path_for_profile(profile: &str) -> Option<std::path::PathBuf> {
    let base = std::env::var("SYNC_LOGS_PATH").ok()?;
    let base_path = std::path::PathBuf::from(base);
    if profile == "default" {
        Some(base_path)
    } else {
        Some(base_path.join(profile))
    }
}

/// Check whether a profile with the given name already exists (has a database file).
/// The check is case-insensitive so that e.g. "Work" and "work" are considered the same.
pub fn profile_exists(data_dir: &std::path::Path, profile: &str) -> bool {
    if profile.eq_ignore_ascii_case("default") {
        return true; // default always exists
    }
    // Exact match
    let db_path = data_dir.join(format!("flights_{}.db", profile));
    if db_path.exists() {
        return true;
    }
    // Case-insensitive scan
    let lower = profile.to_lowercase();
    if let Ok(entries) = std::fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if let Some(existing) = name.strip_prefix("flights_").and_then(|s| s.strip_suffix(".db")) {
                if !existing.contains('.') && existing == lower {
                    return true;
                }
            }
        }
    }
    false
}

/// Delete a profile's database file. Cannot delete "default".
pub fn delete_profile(data_dir: &std::path::Path, profile: &str) -> Result<(), String> {
    if profile == "default" {
        return Err("Cannot delete the default profile".to_string());
    }

    let db_path = data_dir.join(format!("flights_{}.db", profile));
    if db_path.exists() {
        fs::remove_file(&db_path)
            .map_err(|e| format!("Failed to delete profile database: {}", e))?;
    }

    // Clean up WAL file if it exists
    let wal_path = data_dir.join(format!("flights_{}.db.wal", profile));
    if wal_path.exists() {
        let _ = fs::remove_file(&wal_path);
    }

    // Clean up per-profile config file
    let cfg = config_path_for_profile(data_dir, profile);
    if cfg.exists() {
        let _ = fs::remove_file(&cfg);
    }

    // Clean up per-profile uploaded folder (only if it's the default location)
    let upload_dir = default_upload_folder(data_dir, profile);
    if upload_dir.exists() {
        let _ = fs::remove_dir_all(&upload_dir);
    }

    // If this was the active profile, switch back to default
    if get_active_profile(data_dir) == profile {
        let _ = set_active_profile(data_dir, "default");
    }

    log::info!("Deleted profile '{}' and its database", profile);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_database_initialization() {
        let temp_dir = tempdir().unwrap();
        let db = Database::new(temp_dir.path().to_path_buf(), "default").unwrap();

        // Verify directories were created
        assert!(temp_dir.path().join("keychains").exists());
        assert!(temp_dir.path().join("flights.db").exists());

        // Verify we can get flights (empty)
        let flights = db.get_all_flights().unwrap();
        assert!(flights.is_empty());
    }
}
