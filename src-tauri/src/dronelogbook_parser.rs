//! Parser module for Open DroneLog CSV export files.
//!
//! Re-imports CSV files previously exported from this application.
//! Detects the format by checking for characteristic headers like
//! `time_s`, `lat`, `lng`, `alt_m`, `distance_to_home_m`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};

use crate::database::Database;
use crate::models::{FlightMessage, FlightMetadata, FlightStats, TelemetryPoint};
use crate::parser::{LogParser, ParseResult, ParserError};

/// Parse a timestamp string flexibly, handling multiple formats:
/// - RFC3339: "2026-02-01T14:35:52+00:00" or "2026-02-01T14:35:52Z"
/// - DuckDB VARCHAR cast: "2026-02-01 14:35:52+00"
/// - ISO without timezone: "2026-02-01T14:35:52" or "2026-02-01 14:35:52" (assumed UTC)
fn parse_timestamp_flexible(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();

    // Try RFC3339 first (includes timezone)
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        log::debug!("Parsed timestamp as RFC3339: {} -> {}", s, dt);
        return Some(dt.with_timezone(&Utc));
    }

    // Try DuckDB format: "2026-02-01 14:35:52+00" (short timezone offset)
    // Normalize to RFC3339 by adding :00 to timezone if needed
    if s.len() > 3 {
        let normalized = if s.ends_with("+00") || s.ends_with("-00") {
            format!("{}:00", s).replace(' ', "T")
        } else if let Some(pos) = s.rfind('+').or_else(|| s.rfind('-')) {
            // Check if it's a short timezone like +01 or -05
            let tz_part = &s[pos..];
            if tz_part.len() == 3 && tz_part[1..].chars().all(|c| c.is_ascii_digit()) {
                format!("{}:00", s).replace(' ', "T")
            } else {
                s.replace(' ', "T")
            }
        } else {
            s.replace(' ', "T")
        };

        if let Ok(dt) = DateTime::parse_from_rfc3339(&normalized) {
            log::debug!(
                "Parsed timestamp after normalization: {} -> {} -> {}",
                s,
                normalized,
                dt
            );
            return Some(dt.with_timezone(&Utc));
        }
    }

    // Try parsing as naive datetime (no timezone) and assume UTC
    let formats = [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
    ];

    for fmt in &formats {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
            log::debug!("Parsed timestamp as naive (assuming UTC): {} -> {}", s, ndt);
            return Some(Utc.from_utc_datetime(&ndt));
        }
    }

    log::warn!("Failed to parse timestamp: {}", s);
    None
}

/// Column mapping for Open DroneLog CSV
struct ColumnMap {
    /// Column name -> index
    indices: HashMap<String, usize>,
}

impl ColumnMap {
    fn new(headers: &[String]) -> Self {
        let mut indices = HashMap::new();
        for (i, header) in headers.iter().enumerate() {
            indices.insert(header.to_lowercase(), i);
        }
        Self { indices }
    }

    /// Get a float value by column name
    fn get_f64(&self, row: &[&str], field: &str) -> Option<f64> {
        let idx = *self.indices.get(&field.to_lowercase())?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        val_str.parse().ok()
    }

    /// Get an integer value by column name
    fn get_i32(&self, row: &[&str], field: &str) -> Option<i32> {
        let idx = *self.indices.get(&field.to_lowercase())?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        val_str.parse().ok()
    }

    /// Get a boolean value (0/1) by column name
    fn get_bool(&self, row: &[&str], field: &str) -> Option<bool> {
        let idx = *self.indices.get(&field.to_lowercase())?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        match val_str {
            "1" | "true" | "True" | "TRUE" => Some(true),
            "0" | "false" | "False" | "FALSE" => Some(false),
            _ => None,
        }
    }

    /// Get a string value by column name
    fn get_str(&self, row: &[&str], field: &str) -> Option<String> {
        let idx = *self.indices.get(&field.to_lowercase())?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        Some(val_str.to_string())
    }

    /// Get a JSON array of f64 values by column name
    fn get_f64_vec(&self, row: &[&str], field: &str) -> Option<Vec<f64>> {
        let idx = *self.indices.get(&field.to_lowercase())?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        serde_json::from_str(val_str).ok()
    }
}

/// Open DroneLog CSV Parser
pub struct DroneLogbookParser<'a> {
    db: &'a Database,
}

impl<'a> DroneLogbookParser<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }

    /// Check if a file is a valid Open DroneLog CSV export format
    pub fn is_dronelogbook_csv(path: &Path) -> bool {
        // Must be a CSV file
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("csv") {
            return false;
        }

        // Check header line for Open DroneLog-specific columns
        if let Ok(file) = File::open(path) {
            let reader = BufReader::new(file);
            for line in reader.lines() {
                if let Ok(line_content) = line {
                    let trimmed = line_content.trim();
                    // Skip empty lines
                    if trimmed.is_empty() {
                        continue;
                    }
                    // First non-empty line is the header - check for our characteristic columns
                    let lower = trimmed.to_lowercase();
                    // The combination of time_s, lat, lng, alt_m, distance_to_home_m is characteristic of our export
                    // Metadata column is optional (for backwards compatibility)
                    // Add imperial variants to basic and extended columns
                    let has_basic_cols = lower.contains("time_s")
                        && lower.contains("lat")
                        && lower.contains("lng")
                        && (lower.contains("alt_m") || lower.contains("alt_ft"))
                        && (lower.contains("distance_to_home_m")
                            || lower.contains("distance_to_home_ft")
                            || lower.contains("height_m")
                            || lower.contains("height_ft"));
                    let has_extended_cols = lower.contains("vps_height_m")
                        || lower.contains("vps_height_ft")
                        || lower.contains("rc_aileron")
                        || lower.contains("metadata");
                    return has_basic_cols && has_extended_cols;
                }
            }
        }
        false
    }

    /// Parse CSV field with proper quote handling
    fn parse_csv_line(line: &str) -> Vec<String> {
        let mut fields = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        let mut chars = line.chars().peekable();

        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    if in_quotes {
                        // Check for escaped quote
                        if chars.peek() == Some(&'"') {
                            current.push('"');
                            chars.next();
                        } else {
                            in_quotes = false;
                        }
                    } else {
                        in_quotes = true;
                    }
                }
                ',' if !in_quotes => {
                    fields.push(current.trim().to_string());
                    current = String::new();
                }
                _ => {
                    current.push(c);
                }
            }
        }
        fields.push(current.trim().to_string());
        fields
    }

    /// Parse an Open DroneLog CSV file
    pub fn parse(&self, file_path: &Path, file_hash: &str) -> Result<ParseResult, ParserError> {
        let parse_start = std::time::Instant::now();
        log::info!("Parsing Open DroneLog CSV file: {:?}", file_path);

        let file = File::open(file_path)?;
        let reader = BufReader::new(file);
        let mut lines = reader.lines();

        // Find header line (first non-empty line)
        let mut header_line: Option<String> = None;

        for line_result in lines.by_ref() {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => continue,
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // First non-empty line is the header
            header_line = Some(line);
            break;
        }

        let header_line = header_line
            .ok_or_else(|| ParserError::Parse("No header line found in CSV file".to_string()))?;

        let headers: Vec<String> = header_line
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();
        let col_map = ColumnMap::new(&headers);

        // Find metadata and messages column indices
        let metadata_col_idx = headers.iter().position(|h| h.to_lowercase() == "metadata");
        let messages_col_idx = headers.iter().position(|h| h.to_lowercase() == "messages");

        // Detect units from headers
        let mut _is_dist_imp = headers
            .iter()
            .any(|h| h.to_lowercase() == "distance_to_home_ft");
        let mut is_alt_imp = headers.iter().any(|h| h.to_lowercase() == "alt_ft");
        let mut speed_col = "speed_ms";
        let mut velocity_x_col = "velocity_x_ms";
        let mut velocity_y_col = "velocity_y_ms";
        let mut velocity_z_col = "velocity_z_ms";
        let mut speed_to_ms = 1.0_f64;
        if headers.iter().any(|h| h.to_lowercase() == "speed_mph") {
            speed_col = "speed_mph";
            velocity_x_col = "velocity_x_mph";
            velocity_y_col = "velocity_y_mph";
            velocity_z_col = "velocity_z_mph";
            speed_to_ms = 1.0 / 2.236936;
        } else if headers.iter().any(|h| h.to_lowercase() == "speed_kmh") {
            speed_col = "speed_kmh";
            velocity_x_col = "velocity_x_kmh";
            velocity_y_col = "velocity_y_kmh";
            velocity_z_col = "velocity_z_kmh";
            speed_to_ms = 1.0 / 3.6;
        } else if headers.iter().any(|h| h.to_lowercase() == "speed_fts") {
            speed_col = "speed_fts";
            velocity_x_col = "velocity_x_fts";
            velocity_y_col = "velocity_y_fts";
            velocity_z_col = "velocity_z_fts";
            speed_to_ms = 1.0 / 3.28084;
        }
        let mut is_temp_imp = headers.iter().any(|h| h.to_lowercase() == "battery_temp_f");

        // Parse first data row to extract metadata JSON and messages from their columns
        let mut metadata_map: HashMap<String, String> = HashMap::new();
        let mut first_row_line: Option<String> = None;
        let mut imported_auto_tags: Vec<String> = Vec::new();
        let mut imported_manual_tags: Vec<String> = Vec::new();
        let mut imported_messages: Vec<FlightMessage> = Vec::new();

        for line_result in lines.by_ref() {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => continue,
            };

            if line.trim().is_empty() {
                continue;
            }

            // Parse the first data row to extract metadata
            if let Some(meta_idx) = metadata_col_idx {
                let fields = Self::parse_csv_line(&line);
                log::debug!(
                    "Parsed {} fields from first row, metadata column index: {}",
                    fields.len(),
                    meta_idx
                );
                if let Some(meta_json) = fields.get(meta_idx) {
                    log::debug!(
                        "Metadata JSON field (len={}): {:?}",
                        meta_json.len(),
                        if meta_json.len() > 200 {
                            &meta_json[..200]
                        } else {
                            meta_json
                        }
                    );
                    if !meta_json.is_empty() {
                        // Parse JSON metadata
                        match serde_json::from_str::<serde_json::Value>(meta_json) {
                            Ok(json_val) => {
                                if let Some(obj) = json_val.as_object() {
                                    for (key, val) in obj {
                                        // Handle tags array separately
                                        if key == "tags" {
                                            if let Some(tags_arr) = val.as_array() {
                                                for tag_obj in tags_arr {
                                                    if let Some(tag_map) = tag_obj.as_object() {
                                                        let tag_name = tag_map
                                                            .get("tag")
                                                            .and_then(|v| v.as_str())
                                                            .unwrap_or("");
                                                        let tag_type = tag_map
                                                            .get("tag_type")
                                                            .and_then(|v| v.as_str())
                                                            .unwrap_or("auto");
                                                        if !tag_name.is_empty() {
                                                            if tag_type == "manual" {
                                                                imported_manual_tags
                                                                    .push(tag_name.to_string());
                                                            } else {
                                                                imported_auto_tags
                                                                    .push(tag_name.to_string());
                                                            }
                                                        }
                                                    }
                                                }
                                                log::info!("Parsed {} auto tags and {} manual tags from metadata", 
                                                    imported_auto_tags.len(), imported_manual_tags.len());
                                            }
                                            continue;
                                        } else if key == "units" {
                                            if let Some(units_obj) = val.as_object() {
                                                if let Some(dist) = units_obj
                                                    .get("distance")
                                                    .and_then(|v| v.as_str())
                                                {
                                                    _is_dist_imp = dist == "imperial";
                                                }
                                                if let Some(alt) = units_obj
                                                    .get("altitude")
                                                    .and_then(|v| v.as_str())
                                                {
                                                    is_alt_imp = alt == "imperial";
                                                }
                                                if let Some(speed) =
                                                    units_obj.get("speed").and_then(|v| v.as_str())
                                                {
                                                    let normalized = match speed {
                                                        "imperial" => "mph",
                                                        "metric" => "kmh",
                                                        _ => speed,
                                                    };
                                                    match normalized {
                                                        "mph" => {
                                                            speed_col = "speed_mph";
                                                            velocity_x_col = "velocity_x_mph";
                                                            velocity_y_col = "velocity_y_mph";
                                                            velocity_z_col = "velocity_z_mph";
                                                            speed_to_ms = 1.0 / 2.236936;
                                                        }
                                                        "kmh" => {
                                                            speed_col = "speed_kmh";
                                                            velocity_x_col = "velocity_x_kmh";
                                                            velocity_y_col = "velocity_y_kmh";
                                                            velocity_z_col = "velocity_z_kmh";
                                                            speed_to_ms = 1.0 / 3.6;
                                                        }
                                                        "fts" => {
                                                            speed_col = "speed_fts";
                                                            velocity_x_col = "velocity_x_fts";
                                                            velocity_y_col = "velocity_y_fts";
                                                            velocity_z_col = "velocity_z_fts";
                                                            speed_to_ms = 1.0 / 3.28084;
                                                        }
                                                        _ => {
                                                            speed_col = "speed_ms";
                                                            velocity_x_col = "velocity_x_ms";
                                                            velocity_y_col = "velocity_y_ms";
                                                            velocity_z_col = "velocity_z_ms";
                                                            speed_to_ms = 1.0;
                                                        }
                                                    }
                                                }
                                                if let Some(temp) = units_obj
                                                    .get("temperature")
                                                    .and_then(|v| v.as_str())
                                                {
                                                    is_temp_imp = temp == "imperial";
                                                }
                                            }
                                            continue;
                                        }
                                        let val_str = match val {
                                            serde_json::Value::String(s) => s.clone(),
                                            serde_json::Value::Number(n) => n.to_string(),
                                            serde_json::Value::Bool(b) => b.to_string(),
                                            _ => continue,
                                        };
                                        metadata_map.insert(key.to_lowercase(), val_str);
                                    }
                                    log::info!(
                                        "Successfully parsed {} metadata fields from JSON",
                                        metadata_map.len()
                                    );
                                }
                            }
                            Err(e) => {
                                log::warn!("Failed to parse metadata JSON: {}", e);
                            }
                        }
                    } else {
                        log::debug!("Metadata field is empty");
                    }
                } else {
                    log::warn!(
                        "Metadata column index {} out of bounds (fields: {})",
                        meta_idx,
                        fields.len()
                    );
                }

                // Parse messages from the messages column (same row)
                if let Some(msg_idx) = messages_col_idx {
                    if let Some(msg_json) = fields.get(msg_idx) {
                        if !msg_json.is_empty() {
                            // Parse JSON array of messages: [{timestamp_ms, type, message}, ...]
                            match serde_json::from_str::<serde_json::Value>(msg_json) {
                                Ok(json_val) => {
                                    if let Some(arr) = json_val.as_array() {
                                        for msg_obj in arr {
                                            if let Some(obj) = msg_obj.as_object() {
                                                let timestamp_ms = obj
                                                    .get("timestamp_ms")
                                                    .and_then(|v| v.as_i64())
                                                    .unwrap_or(0);
                                                let message_type = obj
                                                    .get("type")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("tip")
                                                    .to_string();
                                                let message = obj
                                                    .get("message")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("")
                                                    .to_string();
                                                if !message.is_empty() {
                                                    imported_messages.push(FlightMessage {
                                                        timestamp_ms,
                                                        message_type,
                                                        message,
                                                    });
                                                }
                                            }
                                        }
                                        log::info!(
                                            "Parsed {} messages from CSV",
                                            imported_messages.len()
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Failed to parse messages JSON: {}", e);
                                }
                            }
                        }
                    }
                }
            } else {
                log::info!("No metadata column found in CSV headers");
            }
            first_row_line = Some(line);
            break;
        }

        // Extract metadata from parsed JSON
        let meta_display_name = metadata_map.get("display_name").cloned();
        let meta_drone_model = metadata_map.get("drone_model").cloned();
        let meta_drone_serial = metadata_map.get("drone_serial").cloned();
        let meta_aircraft_name = metadata_map.get("aircraft_name").cloned();
        let meta_battery_serial = metadata_map.get("battery_serial").cloned();
        let meta_cycle_count = metadata_map
            .get("cycle_count")
            .and_then(|s| s.parse::<i32>().ok());
        let meta_rc_serial = metadata_map
            .get("rc_serial")
            .cloned()
            .filter(|s| !s.is_empty());
        let meta_battery_life = metadata_map
            .get("battery_life")
            .and_then(|s| s.parse::<i32>().ok());
        let meta_start_time = metadata_map
            .get("start_time")
            .and_then(|s| parse_timestamp_flexible(s));
        let meta_home_lat = metadata_map
            .get("home_lat")
            .and_then(|s| s.parse::<f64>().ok());
        let meta_home_lon = metadata_map
            .get("home_lon")
            .and_then(|s| s.parse::<f64>().ok());
        let meta_duration_secs = metadata_map
            .get("duration_secs")
            .and_then(|s| s.parse::<f64>().ok());
        let meta_notes = metadata_map.get("notes").cloned().filter(|s| !s.is_empty());
        let meta_color = metadata_map.get("color").cloned().filter(|s| !s.is_empty());

        log::info!("Parsed metadata from CSV metadata column: display_name={:?}, drone_serial={:?}, battery_serial={:?}, start_time={:?}",
            meta_display_name, meta_drone_serial, meta_battery_serial, meta_start_time);

        // Parse data rows
        let mut points = Vec::new();
        let mut first_valid_time_s: Option<f64> = None;
        let mut last_valid_time_s: Option<f64> = None;

        // Track min/max for stats
        let mut max_speed: f64 = 0.0;
        let mut max_altitude: f64 = 0.0;
        let mut total_distance: f64 = 0.0;
        let mut prev_lat: Option<f64> = None;
        let mut prev_lon: Option<f64> = None;
        let mut home_lat: Option<f64> = meta_home_lat;
        let mut home_lon: Option<f64> = meta_home_lon;

        // Helper to parse a row into a TelemetryPoint
        let parse_row = |fields: &[&str],
                         col_map: &ColumnMap,
                         first_valid_time_s: &mut Option<f64>,
                         last_valid_time_s: &mut Option<f64>,
                         prev_lat: &mut Option<f64>,
                         prev_lon: &mut Option<f64>,
                         home_lat: &mut Option<f64>,
                         home_lon: &mut Option<f64>,
                         max_speed: &mut f64,
                         max_altitude: &mut f64,
                         total_distance: &mut f64|
         -> Option<TelemetryPoint> {
            // Get time in seconds and convert to milliseconds
            let time_s = col_map.get_f64(fields, "time_s");
            let timestamp_ms = time_s.map(|t| (t * 1000.0) as i64).unwrap_or(0);

            // Track first/last valid time
            if let Some(t) = time_s {
                if first_valid_time_s.is_none() {
                    *first_valid_time_s = Some(t);
                }
                *last_valid_time_s = Some(t);
            }

            // Parse telemetry point
            let lat = col_map.get_f64(fields, "lat");
            let lon = col_map.get_f64(fields, "lng");

            // Set home position from first valid GPS point
            if home_lat.is_none() && lat.is_some() && lon.is_some() {
                *home_lat = lat;
                *home_lon = lon;
            }

            // Calculate distance traveled
            if let (Some(curr_lat), Some(curr_lon), Some(p_lat), Some(p_lon)) =
                (lat, lon, *prev_lat, *prev_lon)
            {
                let dist = haversine_distance(p_lat, p_lon, curr_lat, curr_lon);
                *total_distance += dist;
            }
            if lat.is_some() && lon.is_some() {
                *prev_lat = lat;
                *prev_lon = lon;
            }

            // Track max speed and altitude
            if let Some(speed_raw) = col_map.get_f64(fields, speed_col) {
                let speed = speed_raw * speed_to_ms;
                if speed > *max_speed {
                    *max_speed = speed;
                }
            }
            if let Some(alt_raw) =
                col_map.get_f64(fields, if is_alt_imp { "alt_ft" } else { "alt_m" })
            {
                let alt = if is_alt_imp {
                    alt_raw / 3.28084
                } else {
                    alt_raw
                };
                if alt > *max_altitude {
                    *max_altitude = alt;
                }
            }

            let point = TelemetryPoint {
                timestamp_ms,

                // Position
                latitude: lat,
                longitude: lon,
                altitude: {
                    let alt = col_map.get_f64(fields, if is_alt_imp { "alt_ft" } else { "alt_m" });
                    if is_alt_imp {
                        alt.map(|v| v / 3.28084)
                    } else {
                        alt
                    }
                },
                height: {
                    let h =
                        col_map.get_f64(fields, if is_alt_imp { "height_ft" } else { "height_m" });
                    if is_alt_imp {
                        h.map(|v| v / 3.28084)
                    } else {
                        h
                    }
                },
                vps_height: {
                    let vps = col_map.get_f64(
                        fields,
                        if is_alt_imp {
                            "vps_height_ft"
                        } else {
                            "vps_height_m"
                        },
                    );
                    if is_alt_imp {
                        vps.map(|v| v / 3.28084)
                    } else {
                        vps
                    }
                },
                altitude_abs: {
                    let alt_abs = col_map.get_f64(
                        fields,
                        if is_alt_imp {
                            "altitude_ft"
                        } else {
                            "altitude_m"
                        },
                    );
                    if is_alt_imp {
                        alt_abs.map(|v| v / 3.28084)
                    } else {
                        alt_abs
                    }
                },

                // Velocity
                speed: {
                    let s = col_map.get_f64(fields, speed_col);
                    s.map(|v| v * speed_to_ms)
                },
                velocity_x: {
                    let vx = col_map.get_f64(fields, velocity_x_col);
                    vx.map(|v| v * speed_to_ms)
                },
                velocity_y: {
                    let vy = col_map.get_f64(fields, velocity_y_col);
                    vy.map(|v| v * speed_to_ms)
                },
                velocity_z: {
                    let vz = col_map.get_f64(fields, velocity_z_col);
                    vz.map(|v| v * speed_to_ms)
                },

                // Orientation
                pitch: col_map.get_f64(fields, "pitch_deg"),
                roll: col_map.get_f64(fields, "roll_deg"),
                yaw: col_map.get_f64(fields, "yaw_deg"),

                // Gimbal
                gimbal_pitch: col_map.get_f64(fields, "gimbal_pitch_deg"),
                gimbal_roll: col_map.get_f64(fields, "gimbal_roll_deg"),
                gimbal_yaw: col_map.get_f64(fields, "gimbal_yaw_deg"),

                // Power
                battery_percent: col_map.get_i32(fields, "battery_percent"),
                battery_voltage: col_map.get_f64(fields, "battery_voltage_v"),
                battery_current: None, // Not in our CSV export
                battery_temp: {
                    let temp = col_map.get_f64(
                        fields,
                        if is_temp_imp {
                            "battery_temp_f"
                        } else {
                            "battery_temp_c"
                        },
                    );
                    if is_temp_imp {
                        temp.map(|v| (v - 32.0) * 5.0 / 9.0)
                    } else {
                        temp
                    }
                },
                cell_voltages: col_map.get_f64_vec(fields, "cell_voltages"),

                // Status
                flight_mode: col_map.get_str(fields, "flight_mode"),
                gps_signal: None,
                satellites: col_map.get_i32(fields, "satellites"),
                rc_signal: col_map.get_i32(fields, "rc_signal"),
                rc_uplink: col_map.get_i32(fields, "rc_uplink"),
                rc_downlink: col_map.get_i32(fields, "rc_downlink"),

                // RC stick inputs
                rc_aileron: col_map.get_f64(fields, "rc_aileron"),
                rc_elevator: col_map.get_f64(fields, "rc_elevator"),
                rc_throttle: col_map.get_f64(fields, "rc_throttle"),
                rc_rudder: col_map.get_f64(fields, "rc_rudder"),

                // Camera state
                is_photo: col_map.get_bool(fields, "is_photo"),
                is_video: col_map.get_bool(fields, "is_video"),

                // Battery capacity
                battery_full_capacity: col_map.get_f64(fields, "battery_full_capacity_mah"),
                battery_remained_capacity: col_map.get_f64(fields, "battery_remained_capacity_mah"),
            };

            if point.latitude.is_some() && point.longitude.is_some() {
                Some(point)
            } else {
                None
            }
        };

        // Process the first row (which we already read for metadata)
        if let Some(ref first_line) = first_row_line {
            let fields_owned = Self::parse_csv_line(first_line);
            let fields: Vec<&str> = fields_owned.iter().map(String::as_str).collect();
            if fields.len() >= headers.len() / 2 {
                if let Some(point) = parse_row(
                    &fields,
                    &col_map,
                    &mut first_valid_time_s,
                    &mut last_valid_time_s,
                    &mut prev_lat,
                    &mut prev_lon,
                    &mut home_lat,
                    &mut home_lon,
                    &mut max_speed,
                    &mut max_altitude,
                    &mut total_distance,
                ) {
                    points.push(point);
                }
            }
        }

        // Process remaining lines
        for line_result in lines {
            let line = match line_result {
                Ok(l) => l,
                Err(e) => {
                    log::warn!("Skipping malformed line: {}", e);
                    continue;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            let fields_owned = Self::parse_csv_line(&line);
            let fields: Vec<&str> = fields_owned.iter().map(String::as_str).collect();
            if fields.len() < headers.len() / 2 {
                // Skip rows with too few fields
                continue;
            }

            if let Some(point) = parse_row(
                &fields,
                &col_map,
                &mut first_valid_time_s,
                &mut last_valid_time_s,
                &mut prev_lat,
                &mut prev_lon,
                &mut home_lat,
                &mut home_lon,
                &mut max_speed,
                &mut max_altitude,
                &mut total_distance,
            ) {
                points.push(point);
            }
        }

        if points.is_empty() {
            return Err(ParserError::NoTelemetryData);
        }

        // Calculate duration from time values, fallback to metadata duration for manual entries
        let duration_secs = match (first_valid_time_s, last_valid_time_s) {
            (Some(first), Some(last)) if last > first => Some(last - first),
            _ => meta_duration_secs,
        };

        // Extract metadata from file name
        // Format: FlightName.csv or DJIFlightRecord_YYYY-MM-DD_HH-MM-SS.csv
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        // Use metadata display_name if available, otherwise extract from file name
        let display_name = meta_display_name.unwrap_or_else(|| {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&file_name)
                .to_string()
        });

        // Use metadata start_time if available, otherwise try to extract from file name
        let start_time = meta_start_time.or_else(|| extract_datetime_from_filename(&file_name));

        // Count photo and video capture events from telemetry transitions
        let (photo_count, video_count) = crate::models::count_media_events(&points);

        let metadata = FlightMetadata {
            id: self.db.generate_flight_id(),
            file_name,
            display_name,
            file_hash: Some(file_hash.to_string()),
            drone_model: meta_drone_model,
            drone_serial: meta_drone_serial
                .map(|s| s.trim().to_uppercase())
                .filter(|s| !s.is_empty()),
            aircraft_name: meta_aircraft_name,
            battery_serial: meta_battery_serial
                .map(|s| s.trim().to_uppercase())
                .filter(|s| !s.is_empty()),
            cycle_count: meta_cycle_count,
            rc_serial: meta_rc_serial
                .map(|s| s.trim().to_uppercase())
                .filter(|s| !s.is_empty()),
            battery_life: meta_battery_life,
            start_time,
            end_time: start_time
                .map(|st| st + chrono::Duration::seconds(duration_secs.unwrap_or(0.0) as i64)),
            duration_secs,
            total_distance: Some(total_distance),
            max_altitude: Some(max_altitude),
            max_speed: Some(max_speed),
            home_lat,
            home_lon,
            point_count: points.len() as i32,
            photo_count,
            video_count,
        };

        log::info!(
            "Open DroneLog CSV parse complete in {:.1}s: duration={:.1}s, distance={:.0}m, max_alt={:.1}m, points={}",
            parse_start.elapsed().as_secs_f64(),
            metadata.duration_secs.unwrap_or(0.0),
            metadata.total_distance.unwrap_or(0.0),
            metadata.max_altitude.unwrap_or(0.0),
            points.len()
        );

        // Generate smart tags and add "Re-imported" source tag
        let stats = FlightStats {
            duration_secs: duration_secs.unwrap_or(0.0),
            total_distance_m: total_distance,
            max_altitude_m: max_altitude,
            max_speed_ms: max_speed,
            avg_speed_ms: if duration_secs.unwrap_or(0.0) > 0.0 {
                total_distance / duration_secs.unwrap_or(1.0)
            } else {
                0.0
            },
            min_battery: points
                .iter()
                .filter_map(|p| p.battery_percent)
                .filter(|&v| v > 0)
                .min()
                .unwrap_or(0),
            home_location: home_lat.zip(home_lon).map(|(lat, lon)| [lon, lat]),
            max_distance_from_home_m: 0.0, // Not calculated during re-import
            start_battery_percent: points.first().and_then(|p| p.battery_percent),
            end_battery_percent: points.last().and_then(|p| p.battery_percent),
            start_battery_temp: points.first().and_then(|p| p.battery_temp),
        };

        // Start with "Re-imported" tag and merge with imported auto tags
        let mut tags = vec!["Re-imported".to_string()];

        // Add imported auto tags (from the original export) - skip "Re-imported" to avoid duplicate
        for tag in &imported_auto_tags {
            if tag != "Re-imported" && !tags.contains(tag) {
                tags.push(tag.clone());
            }
        }

        // Generate fresh smart tags and add any new ones not already present
        let generated_tags = LogParser::generate_smart_tags(&metadata, &stats);
        for tag in generated_tags {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }

        log::info!(
            "Final auto tags: {:?}, manual tags: {:?}, notes: {:?}, messages: {}",
            tags,
            imported_manual_tags,
            meta_notes.is_some(),
            imported_messages.len()
        );

        Ok(ParseResult {
            metadata,
            points,
            tags,
            manual_tags: imported_manual_tags,
            notes: meta_notes,
            color: meta_color,
            messages: imported_messages,
        })
    }
}

/// Calculate haversine distance between two GPS coordinates in meters
fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6371000.0; // Earth radius in meters
    let phi1 = lat1.to_radians();
    let phi2 = lat2.to_radians();
    let delta_phi = (lat2 - lat1).to_radians();
    let delta_lambda = (lon2 - lon1).to_radians();

    let a = (delta_phi / 2.0).sin().powi(2)
        + phi1.cos() * phi2.cos() * (delta_lambda / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

    r * c
}

/// Try to extract a datetime from a filename like "DJIFlightRecord_2026-01-27_10-56-42"
fn extract_datetime_from_filename(filename: &str) -> Option<DateTime<Utc>> {
    // Try various patterns
    // Pattern 1: DJIFlightRecord_YYYY-MM-DD_HH-MM-SS
    if filename.contains("_") {
        let parts: Vec<&str> = filename.split('_').collect();
        if parts.len() >= 3 {
            // Try to find date and time parts
            for i in 0..parts.len().saturating_sub(1) {
                let date_part = parts[i];
                let time_part = parts.get(i + 1).copied().unwrap_or("");

                // Check if date_part looks like YYYY-MM-DD
                if date_part.len() == 10 && date_part.chars().filter(|c| *c == '-').count() == 2 {
                    // Check if time_part looks like HH-MM-SS
                    let time_clean = time_part.replace(".csv", "").replace(".CSV", "");
                    if time_clean.len() >= 8
                        && time_clean.chars().filter(|c| *c == '-').count() == 2
                    {
                        let datetime_str =
                            format!("{} {}", date_part, time_clean.replace('-', ":"));
                        if let Ok(ndt) =
                            NaiveDateTime::parse_from_str(&datetime_str, "%Y-%m-%d %H:%M:%S")
                        {
                            return Some(DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc));
                        }
                    }
                }
            }
        }
    }
    None
}
