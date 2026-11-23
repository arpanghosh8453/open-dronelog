//! Parser module for Airdata CSV export files.
//!
//! Airdata (airdata.com) allows users to export flight telemetry as CSV.
//! Users can choose different unit systems when downloading:
//! - Distance: Miles, Feet, Kilometers, Meters
//! - Altitude: Feet, Meters
//! - Speed: Miles Per Hour, Kilometers Per Hour, Meters Per Second, Knots
//! - Temperature: Fahrenheit, Celsius
//!
//! The parser detects units from column header suffixes (e.g., `speed(m/s)`,
//! `altitude(feet)`) and converts all values to metric (meters, m/s, °C).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, Utc};

use crate::database::Database;
use crate::models::{FlightMessage, FlightMetadata, FlightStats, TelemetryPoint};
use crate::parser::{LogParser, ParseResult, ParserError};

// ---------------------------------------------------------------------------
// Unit detection & conversion
// ---------------------------------------------------------------------------

/// Unit type detected from column header parentheses
#[derive(Debug, Clone, Copy, PartialEq)]
enum Unit {
    // Distance / altitude
    Meters,
    Feet,
    Kilometers,
    Miles,
    // Speed
    MetersPerSec,
    Kmh,
    Mph,
    Knots,
    // Temperature
    Celsius,
    Fahrenheit,
    // Misc / unitless
    None,
}

impl Unit {
    /// Parse unit string from inside the parentheses of a header.
    fn from_header_unit(unit_str: &str) -> Self {
        match unit_str.to_lowercase().trim() {
            "meters" | "m" => Unit::Meters,
            "feet" | "ft" => Unit::Feet,
            "kilometers" | "km" => Unit::Kilometers,
            "miles" | "mi" => Unit::Miles,
            "m/s" => Unit::MetersPerSec,
            "km/h" | "kph" | "kilometers per hour" => Unit::Kmh,
            "mph" | "miles per hour" => Unit::Mph,
            "knots" | "kn" | "kt" => Unit::Knots,
            "c" | "celsius" | "°c" => Unit::Celsius,
            "f" | "fahrenheit" | "°f" => Unit::Fahrenheit,
            "millisecond" | "milliseconds" | "ms" => Unit::None, // time – no conversion
            "degrees" | "deg" | "°" => Unit::None,
            "v" | "volts" => Unit::None,
            "a" | "amps" => Unit::None,
            "percent" | "%" => Unit::None,
            _ => Unit::None,
        }
    }

    /// Convert a value expressed in this unit to the canonical metric unit:
    ///   distance/altitude → meters, speed → m/s, temperature → °C.
    fn to_metric(self, value: f64) -> f64 {
        match self {
            Unit::Feet => value * 0.3048,
            Unit::Kilometers => value * 1000.0,
            Unit::Miles => value * 1609.344,
            Unit::Kmh => value / 3.6,
            Unit::Mph => value * 0.44704,
            Unit::Knots => value * 0.514444,
            Unit::Fahrenheit => (value - 32.0) * 5.0 / 9.0,
            // Already metric or unitless
            _ => value,
        }
    }
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/// Keeps header metadata: base name → (column index, unit).
struct ColumnMap {
    /// base column name (lowercase, without unit suffix) → column index
    indices: HashMap<String, usize>,
    /// base column name → unit parsed from header
    units: HashMap<String, Unit>,
}

impl ColumnMap {
    /// Build the column map from the raw header strings.
    fn new(headers: &[String]) -> Self {
        let mut indices = HashMap::new();
        let mut units = HashMap::new();

        for (i, raw) in headers.iter().enumerate() {
            let header = raw.trim().to_lowercase();
            let (base, unit) = if let Some(paren_start) = header.find('(') {
                let base_name = header[..paren_start].trim().to_string();
                let unit_str = header[paren_start + 1..]
                    .trim_end_matches(')')
                    .trim()
                    .to_string();
                (base_name, Unit::from_header_unit(&unit_str))
            } else {
                (header.clone(), Unit::None)
            };

            indices.insert(base.clone(), i);
            units.insert(base, unit);
        }

        Self { indices, units }
    }

    /// Retrieve a float value by base column name, converting to metric.
    fn get_f64(&self, row: &[&str], field: &str) -> Option<f64> {
        let idx = *self.indices.get(field)?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        let val: f64 = val_str.parse().ok()?;
        let unit = self.units.get(field).copied().unwrap_or(Unit::None);
        Some(unit.to_metric(val))
    }

    /// Retrieve a float value **without** unit conversion.
    fn get_f64_raw(&self, row: &[&str], field: &str) -> Option<f64> {
        let idx = *self.indices.get(field)?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        val_str.parse().ok()
    }

    /// Retrieve an integer value by base column name.
    fn get_i32(&self, row: &[&str], field: &str) -> Option<i32> {
        let idx = *self.indices.get(field)?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        // Handle floats stored as "38.0"
        if let Ok(v) = val_str.parse::<i32>() {
            return Some(v);
        }
        val_str.parse::<f64>().ok().map(|v| v as i32)
    }

    /// Retrieve a boolean from 0/1 columns.
    fn get_bool(&self, row: &[&str], field: &str) -> Option<bool> {
        self.get_i32(row, field).map(|v| v != 0)
    }

    /// Retrieve a raw string value.
    fn get_str(&self, row: &[&str], field: &str) -> Option<String> {
        let idx = *self.indices.get(field)?;
        let val_str = row.get(idx)?.trim();
        if val_str.is_empty() {
            return None;
        }
        Some(val_str.to_string())
    }
}

// ---------------------------------------------------------------------------
// CSV line parser with quote handling
// ---------------------------------------------------------------------------

/// Parse a CSV line respecting quoted fields (Airdata message column uses quotes).
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes {
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
                fields.push(current.clone());
                current.clear();
            }
            _ => {
                current.push(c);
            }
        }
    }
    fields.push(current);
    fields
}

// ---------------------------------------------------------------------------
// AirdataParser
// ---------------------------------------------------------------------------

/// Airdata CSV Parser
pub struct AirdataParser<'a> {
    db: &'a Database,
}

impl<'a> AirdataParser<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }

    // ------------------------------------------------------------------
    // Format detection
    // ------------------------------------------------------------------

    /// Heuristic check: is this file an Airdata CSV export?
    ///
    /// Looks for characteristic Airdata columns that don't appear in Litchi
    /// or DroneLogbook exports: `time(millisecond)`, `datetime(utc)`,
    /// `flycstate`, `height_above_takeoff`.
    pub fn is_airdata_csv(path: &Path) -> bool {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("csv") {
            return false;
        }

        if let Ok(file) = File::open(path) {
            let reader = BufReader::new(file);
            if let Some(Ok(first_line)) = reader.lines().next() {
                let lower = first_line.to_lowercase();
                // Airdata-specific markers
                return lower.contains("time(millisecond)")
                    && lower.contains("datetime(utc)")
                    && lower.contains("flycstate");
            }
        }
        false
    }

    // ------------------------------------------------------------------
    // Main parse entry point
    // ------------------------------------------------------------------

    pub fn parse(&self, file_path: &Path, file_hash: &str) -> Result<ParseResult, ParserError> {
        let parse_start = std::time::Instant::now();
        log::info!("Parsing Airdata CSV file: {:?}", file_path);

        let file = File::open(file_path)?;
        let reader = BufReader::new(file);
        let mut lines_iter = reader.lines();

        // --- header ---------------------------------------------------------
        let header_line = lines_iter
            .next()
            .ok_or_else(|| ParserError::Parse("Empty CSV file".to_string()))?
            .map_err(|e| ParserError::Parse(format!("Failed to read header: {}", e)))?;

        let headers: Vec<String> = parse_csv_line(&header_line);
        let col_map = ColumnMap::new(&headers);

        // --- data rows ------------------------------------------------------
        let mut points = Vec::new();
        let mut first_row_data: Option<Vec<String>> = None;
        let mut last_row_data: Option<Vec<String>> = None;
        let mut messages: Vec<FlightMessage> = Vec::new();

        for line_result in lines_iter {
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

            let fields_owned = parse_csv_line(&line);
            if fields_owned.len() < headers.len() / 2 {
                continue;
            }

            // Store first / last rows for metadata
            if first_row_data.is_none() {
                first_row_data = Some(fields_owned.iter().map(|s| s.to_string()).collect());
            }
            last_row_data = Some(fields_owned.iter().map(|s| s.to_string()).collect());

            let fields: Vec<&str> = fields_owned.iter().map(String::as_str).collect();

            // Collect messages from the "message" column
            if let Some(msg) = col_map.get_str(&fields, "message") {
                if !msg.is_empty() {
                    let ts = col_map
                        .get_f64_raw(&fields, "time")
                        .map(|v| v as i64)
                        .unwrap_or(0);
                    messages.push(FlightMessage {
                        timestamp_ms: ts,
                        message_type: "tip".to_string(),
                        message: msg,
                    });
                }
            }

            // Parse telemetry
            let point = Self::parse_row(&col_map, &fields);
            if point.latitude.is_some() && point.longitude.is_some() {
                points.push(point);
            }
        }

        if points.is_empty() {
            return Err(ParserError::NoTelemetryData);
        }

        // Deduplicate points with the same timestamp_ms (Airdata CSVs can
        // contain duplicate timestamps at the end of a flight).  Keep the
        // last occurrence for each timestamp so the most-recent sample wins.
        let pre_dedup = points.len();
        {
            let mut seen = std::collections::HashSet::new();
            // Iterate in reverse so the *last* row for a given ts is kept.
            points.reverse();
            points.retain(|p| seen.insert(p.timestamp_ms));
            points.reverse();
        }
        if points.len() < pre_dedup {
            log::info!(
                "Deduplicated {} duplicate-timestamp points ({} -> {})",
                pre_dedup - points.len(),
                pre_dedup,
                points.len()
            );
        }

        // --- metadata -------------------------------------------------------
        let first_row: Vec<&str> = first_row_data
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let last_row: Vec<&str> = last_row_data
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();

        let metadata = self.extract_metadata(
            file_path, file_hash, &col_map, &first_row, &last_row, &points,
        )?;
        let stats = self.calculate_stats(&points, &col_map, &first_row, &last_row);

        log::info!(
            "Airdata parse complete in {:.1}s: duration={:.1}s, distance={:.0}m, max_alt={:.1}m, points={}",
            parse_start.elapsed().as_secs_f64(),
            metadata.duration_secs.unwrap_or(0.0),
            metadata.total_distance.unwrap_or(0.0),
            metadata.max_altitude.unwrap_or(0.0),
            points.len()
        );

        // Smart tags
        let mut tags = LogParser::generate_smart_tags(&metadata, &stats);
        tags.insert(0, "Airdata".to_string());
        log::info!("Generated smart tags: {:?}", tags);

        Ok(ParseResult {
            metadata,
            points,
            tags,
            manual_tags: Vec::new(),
            notes: None,
            color: None,
            messages,
        })
    }

    // ------------------------------------------------------------------
    // Row parsing
    // ------------------------------------------------------------------

    fn parse_row(col_map: &ColumnMap, row: &[&str]) -> TelemetryPoint {
        let get_any_f64_raw =
            |fields: &[&str]| fields.iter().find_map(|f| col_map.get_f64_raw(row, f));

        // Timestamp: use time(millisecond) column directly (no unit conversion)
        let timestamp_ms = col_map
            .get_f64_raw(row, "time")
            .map(|v| v as i64)
            .unwrap_or(0);

        // Altitude: prefer height_above_takeoff for the "altitude" field
        //           (relative altitude above takeoff point, like DJI logs).
        //           altitude_above_sealevel goes into altitude_abs.
        let alt_above_takeoff = col_map.get_f64(row, "height_above_takeoff");
        let alt_above_sea = col_map
            .get_f64(row, "altitude_above_sealevel")
            .or_else(|| col_map.get_f64(row, "altitude"));
        let height_sonar = col_map.get_f64(row, "height_sonar");

        // RC inputs – Airdata provides both raw (0-2048 center 1024) and
        // percent (-100 to +100) columns. Prefer percent.
        let rc_elevator = col_map
            .get_f64_raw(row, "rc_elevator") // try "rc_elevator(percent)" first
            .or_else(|| {
                // Fallback: normalize raw 0-2048 range with 1024 center
                col_map
                    .get_f64_raw(row, "rc_elevator")
                    .map(|v| ((v - 1024.0) / 1024.0) * 100.0)
            });
        let rc_aileron = col_map.get_f64_raw(row, "rc_aileron").or_else(|| {
            col_map
                .get_f64_raw(row, "rc_aileron")
                .map(|v| ((v - 1024.0) / 1024.0) * 100.0)
        });
        let rc_throttle = col_map.get_f64_raw(row, "rc_throttle").or_else(|| {
            col_map
                .get_f64_raw(row, "rc_throttle")
                .map(|v| ((v - 1024.0) / 1024.0) * 100.0)
        });
        let rc_rudder = col_map.get_f64_raw(row, "rc_rudder").or_else(|| {
            col_map
                .get_f64_raw(row, "rc_rudder")
                .map(|v| ((v - 1024.0) / 1024.0) * 100.0)
        });

        // Cell voltages – Airdata names them voltageCell1 .. voltageCell6
        let mut cells: Vec<f64> = Vec::new();
        for i in 1..=6 {
            let key = format!("voltagecell{}", i);
            if let Some(v) = col_map.get_f64_raw(row, &key) {
                if v > 0.0 {
                    cells.push(v);
                }
            }
        }
        let cell_voltages = if cells.is_empty() { None } else { Some(cells) };

        TelemetryPoint {
            timestamp_ms,

            // Position
            latitude: col_map.get_f64_raw(row, "latitude"),
            longitude: col_map.get_f64_raw(row, "longitude"),
            altitude: alt_above_takeoff,
            height: col_map
                .get_f64(row, "height_above_ground_at_drone_location")
                .or(height_sonar),
            vps_height: height_sonar,
            altitude_abs: alt_above_sea,

            // Velocity – speed and per-axis speeds
            speed: col_map.get_f64(row, "speed"),
            velocity_x: col_map
                .get_f64(row, "xspeed")
                .or_else(|| col_map.get_f64(row, " xspeed")),
            velocity_y: col_map
                .get_f64(row, "yspeed")
                .or_else(|| col_map.get_f64(row, " yspeed")),
            velocity_z: col_map
                .get_f64(row, "zspeed")
                .or_else(|| col_map.get_f64(row, " zspeed")),

            // Orientation
            pitch: col_map
                .get_f64_raw(row, "pitch")
                .or_else(|| col_map.get_f64_raw(row, " pitch")),
            roll: col_map
                .get_f64_raw(row, "roll")
                .or_else(|| col_map.get_f64_raw(row, " roll")),
            yaw: col_map
                .get_f64_raw(row, "compass_heading")
                .or_else(|| col_map.get_f64_raw(row, " compass_heading")),

            // Gimbal
            gimbal_pitch: get_any_f64_raw(&[
                "gimbal_pitch",
                " gimbal_pitch",
                "gimbal pitch",
                "gimbalpitch",
            ]),
            gimbal_roll: get_any_f64_raw(&[
                "gimbal_roll",
                " gimbal_roll",
                "gimbal roll",
                "gimbalroll",
            ]),
            gimbal_yaw: get_any_f64_raw(&[
                "gimbal_heading",
                " gimbal_heading",
                "gimbal_yaw",
                " gimbal_yaw",
                "gimbal yaw",
                "gimbalyaw",
            ]),

            // Power
            battery_percent: col_map.get_i32(row, "battery_percent"),
            battery_voltage: col_map.get_f64_raw(row, "voltage"),
            battery_current: col_map.get_f64_raw(row, "current"),
            battery_temp: col_map.get_f64(row, "battery_temperature"),
            cell_voltages,

            // Status
            flight_mode: col_map.get_str(row, "flycstate"),
            gps_signal: col_map.get_i32(row, "gpslevel"),
            satellites: col_map.get_i32(row, "satellites"),
            rc_signal: None,
            rc_uplink: None,
            rc_downlink: None,

            // RC stick inputs (percent columns)
            rc_aileron,
            rc_elevator,
            rc_throttle,
            rc_rudder,

            // Camera state
            is_photo: col_map.get_bool(row, "isphoto"),
            is_video: col_map.get_bool(row, "isvideo"),

            // Battery capacity (not available in Airdata CSV)
            battery_full_capacity: None,
            battery_remained_capacity: None,
        }
    }

    // ------------------------------------------------------------------
    // Metadata extraction
    // ------------------------------------------------------------------

    fn extract_metadata(
        &self,
        file_path: &Path,
        file_hash: &str,
        col_map: &ColumnMap,
        first_row: &[&str],
        last_row: &[&str],
        points: &[TelemetryPoint],
    ) -> Result<FlightMetadata, ParserError> {
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let display_name = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&file_name)
            .to_string();

        // Start / end times from datetime(utc) column
        let start_time = col_map
            .get_str(first_row, "datetime")
            .and_then(|dt| parse_airdata_datetime(&dt));

        let end_time = col_map
            .get_str(last_row, "datetime")
            .and_then(|dt| parse_airdata_datetime(&dt));

        let duration_secs = match (start_time, end_time) {
            (Some(s), Some(e)) => Some((e - s).num_milliseconds() as f64 / 1000.0),
            _ => {
                if points.len() >= 2 {
                    Some(
                        (points.last().unwrap().timestamp_ms - points.first().unwrap().timestamp_ms)
                            as f64
                            / 1000.0,
                    )
                } else {
                    None
                }
            }
        };

        // Distance & extremes (already metric after ColumnMap conversion)
        let total_distance = Self::calculate_total_distance(points);
        let max_altitude = points
            .iter()
            .filter_map(|p| p.altitude)
            .fold(0.0f64, f64::max);
        let max_speed = points.iter().filter_map(|p| p.speed).fold(0.0f64, f64::max);

        // Home location: first valid GPS point
        let home_lat = points.iter().find_map(|p| p.latitude);
        let home_lon = points.iter().find_map(|p| p.longitude);

        // Photo / video counts
        let (photo_count, video_count) = crate::models::count_media_events(points);

        Ok(FlightMetadata {
            id: self.db.generate_flight_id(),
            file_name,
            display_name,
            file_hash: Some(file_hash.to_string()),
            drone_model: None,    // Airdata CSV doesn't include drone model
            drone_serial: None,   // not in CSV
            aircraft_name: None,  // not in CSV
            battery_serial: None, // not in CSV
            cycle_count: None,
            rc_serial: None,
            battery_life: None,
            start_time,
            end_time,
            duration_secs,
            total_distance: Some(total_distance),
            max_altitude: Some(max_altitude),
            max_speed: Some(max_speed),
            home_lat,
            home_lon,
            point_count: points.len() as i32,
            photo_count,
            video_count,
        })
    }

    // ------------------------------------------------------------------
    // Statistics (for smart tag generation)
    // ------------------------------------------------------------------

    fn calculate_stats(
        &self,
        points: &[TelemetryPoint],
        _col_map: &ColumnMap,
        _first_row: &[&str],
        _last_row: &[&str],
    ) -> FlightStats {
        let duration_secs = if points.len() >= 2 {
            (points.last().unwrap().timestamp_ms - points.first().unwrap().timestamp_ms) as f64
                / 1000.0
        } else {
            0.0
        };

        let total_distance_m = Self::calculate_total_distance(points);
        let max_altitude_m = points
            .iter()
            .filter_map(|p| p.altitude)
            .fold(0.0f64, f64::max);
        let max_speed_ms = points.iter().filter_map(|p| p.speed).fold(0.0f64, f64::max);

        let speeds: Vec<f64> = points
            .iter()
            .filter_map(|p| p.speed)
            .filter(|&s| s > 0.1)
            .collect();
        let avg_speed_ms = if !speeds.is_empty() {
            speeds.iter().sum::<f64>() / speeds.len() as f64
        } else {
            0.0
        };

        let home_lat = points.iter().find_map(|p| p.latitude);
        let home_lon = points.iter().find_map(|p| p.longitude);
        let home_location = match (home_lon, home_lat) {
            (Some(lon), Some(lat)) if lat.abs() > 0.001 || lon.abs() > 0.001 => Some([lon, lat]),
            _ => None,
        };

        let max_distance_from_home_m = if let Some([home_lon, home_lat]) = home_location {
            points
                .iter()
                .filter_map(|p| match (p.latitude, p.longitude) {
                    (Some(lat), Some(lon)) => {
                        Some(haversine_distance(home_lat, home_lon, lat, lon))
                    }
                    _ => None,
                })
                .fold(0.0f64, f64::max)
        } else {
            0.0
        };

        let start_battery_percent = points.first().and_then(|p| p.battery_percent);
        let end_battery_percent = points.last().and_then(|p| p.battery_percent);
        let start_battery_temp = points.first().and_then(|p| p.battery_temp);
        let min_battery = points
            .iter()
            .filter_map(|p| p.battery_percent)
            .filter(|&v| v > 0)
            .min()
            .unwrap_or(0);

        FlightStats {
            duration_secs,
            total_distance_m,
            max_altitude_m,
            max_speed_ms,
            avg_speed_ms,
            min_battery,
            home_location,
            max_distance_from_home_m,
            start_battery_percent,
            end_battery_percent,
            start_battery_temp,
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    fn calculate_total_distance(points: &[TelemetryPoint]) -> f64 {
        let mut total = 0.0;
        for i in 1..points.len() {
            if let (Some(lat1), Some(lon1), Some(lat2), Some(lon2)) = (
                points[i - 1].latitude,
                points[i - 1].longitude,
                points[i].latitude,
                points[i].longitude,
            ) {
                total += haversine_distance(lat1, lon1, lat2, lon2);
            }
        }
        total
    }
}

// ---------------------------------------------------------------------------
// Free-standing helpers
// ---------------------------------------------------------------------------

/// Parse Airdata datetime string. Common format: `2026-01-25 09:16:57`
fn parse_airdata_datetime(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    // Try several common formats
    let formats = [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
    ];
    for fmt in &formats {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc));
        }
    }
    // Try RFC3339
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    log::warn!("Failed to parse Airdata datetime: {}", s);
    None
}

/// Haversine distance between two GPS coordinates in meters.
fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371000.0;
    let phi1 = lat1.to_radians();
    let phi2 = lat2.to_radians();
    let delta_phi = (lat2 - lat1).to_radians();
    let delta_lambda = (lon2 - lon1).to_radians();

    let a = (delta_phi / 2.0).sin().powi(2)
        + phi1.cos() * phi2.cos() * (delta_lambda / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();

    R * c
}
