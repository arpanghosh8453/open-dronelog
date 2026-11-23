//! Parser module for Litchi flight log CSV files.
//!
//! Supports both metric and imperial unit exports by detecting units from column headers.
//! Column names contain unit suffixes like `altitude(feet)` or `altitude(m)`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, Utc};

use crate::database::Database;
use crate::models::{FlightMetadata, FlightStats, TelemetryPoint};
use crate::parser::{LogParser, ParseResult, ParserError};

/// Unit type detected from column headers
#[derive(Debug, Clone, Copy, PartialEq)]
enum Unit {
    Feet,
    Meters,
    Mph,
    MetersPerSec,
    Fahrenheit,
    Celsius,
    None,
}

impl Unit {
    /// Parse unit from column header suffix like "altitude(feet)" or "speed(m/s)"
    fn from_header(header: &str) -> Self {
        if let Some(start) = header.find('(') {
            if let Some(end) = header.find(')') {
                let unit_str = &header[start + 1..end].to_lowercase();
                return match unit_str.as_str() {
                    "feet" | "ft" => Unit::Feet,
                    "m" | "meters" => Unit::Meters,
                    "mph" => Unit::Mph,
                    "m/s" => Unit::MetersPerSec,
                    "f" => Unit::Fahrenheit,
                    "c" => Unit::Celsius,
                    _ => Unit::None,
                };
            }
        }
        Unit::None
    }

    /// Convert value to metric units
    fn to_metric(&self, value: f64) -> f64 {
        match self {
            Unit::Feet => value * 0.3048,
            Unit::Mph => value * 0.44704,
            Unit::Fahrenheit => (value - 32.0) * 5.0 / 9.0,
            // Already metric or unitless
            _ => value,
        }
    }
}

/// Column mapping for Litchi CSV
struct ColumnMap {
    /// Column index -> field name (without unit suffix)
    indices: HashMap<String, usize>,
    /// Field name -> unit type
    units: HashMap<String, Unit>,
}

impl ColumnMap {
    fn new(headers: &[String]) -> Self {
        let mut indices = HashMap::new();
        let mut units = HashMap::new();

        for (i, header) in headers.iter().enumerate() {
            // Extract base name (before parenthesis) for mapping
            let base_name = if let Some(paren_pos) = header.find('(') {
                header[..paren_pos].to_string()
            } else {
                header.clone()
            };

            let unit = Unit::from_header(header);
            indices.insert(base_name.clone(), i);
            units.insert(base_name, unit);
        }

        Self { indices, units }
    }

    /// Get a value by field name, converting to metric if needed
    fn get_f64(&self, row: &[&str], field: &str) -> Option<f64> {
        let idx = *self.indices.get(field)?;
        let val_str = row.get(idx)?;
        let val: f64 = val_str.parse().ok()?;
        let unit = self.units.get(field).copied().unwrap_or(Unit::None);
        Some(unit.to_metric(val))
    }

    /// Get a raw string value by field name
    fn get_str(&self, row: &[&str], field: &str) -> Option<String> {
        let idx = *self.indices.get(field)?;
        row.get(idx).map(|s| s.to_string())
    }

    /// Get an integer value by field name
    fn get_i32(&self, row: &[&str], field: &str) -> Option<i32> {
        let idx = *self.indices.get(field)?;
        let val_str = row.get(idx)?;
        val_str.parse().ok()
    }

    /// Get a boolean value (0/1) by field name
    fn get_bool(&self, row: &[&str], field: &str) -> Option<bool> {
        self.get_i32(row, field).map(|v| v != 0)
    }

    /// Check if a column exists in the header
    fn has_column(&self, field: &str) -> bool {
        self.indices.contains_key(field)
    }
}

/// Litchi CSV Parser
pub struct LitchiParser<'a> {
    db: &'a Database,
}

impl<'a> LitchiParser<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }

    /// Check if a file is a valid Litchi CSV format
    pub fn is_litchi_csv(path: &Path) -> bool {
        // Must be a CSV file
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("csv") {
            return false;
        }

        // Check header line for Litchi-specific columns
        if let Ok(file) = File::open(path) {
            let reader = BufReader::new(file);
            if let Some(Ok(first_line)) = reader.lines().next() {
                let lower = first_line.to_lowercase();
                // Litchi CSVs have these characteristic columns
                return lower.contains("latitude")
                    && lower.contains("longitude")
                    && (lower.contains("datetime(utc)") || lower.contains("datetime(local)"))
                    && (lower.contains("dronetype")
                        || lower.contains("planename")
                        || lower.contains("isflying"));
            }
        }
        false
    }

    /// Parse a Litchi CSV file
    pub fn parse(&self, file_path: &Path, file_hash: &str) -> Result<ParseResult, ParserError> {
        let parse_start = std::time::Instant::now();
        log::info!("Parsing Litchi CSV file: {:?}", file_path);

        let file = File::open(file_path)?;
        let reader = BufReader::new(file);
        let mut lines = reader.lines();

        // Parse header line
        let header_line = lines
            .next()
            .ok_or_else(|| ParserError::Parse("Empty CSV file".to_string()))?
            .map_err(|e| ParserError::Parse(format!("Failed to read header: {}", e)))?;

        let headers: Vec<String> = header_line
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();
        let col_map = ColumnMap::new(&headers);

        // Parse data rows
        let mut points = Vec::new();
        let mut first_row_data: Option<Vec<String>> = None;
        let mut last_row_data: Option<Vec<String>> = None;
        let mut battery_full_capacity: Option<f64> = None;

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

            let fields: Vec<&str> = line.split(',').collect();
            if fields.len() < headers.len() / 2 {
                // Skip rows with too few fields
                continue;
            }

            // Store first and last row for metadata extraction
            if first_row_data.is_none() {
                first_row_data = Some(fields.iter().map(|s| s.to_string()).collect());

                // Extract battery full capacity from first row only (later rows report 0)
                battery_full_capacity = col_map
                    .get_f64(&fields, "CENTER_BATTERY.fullCapacity")
                    .filter(|&v| v > 0.0);
            }
            last_row_data = Some(fields.iter().map(|s| s.to_string()).collect());

            // Parse telemetry point
            let point = self.parse_row(&col_map, &fields, battery_full_capacity);
            if point.latitude.is_some() && point.longitude.is_some() {
                points.push(point);
            }
        }

        // Normalize timestamps to relative ms from flight start
        // This handles the case where datetime was used (epoch ms) instead of time(millisecond)
        if !points.is_empty() {
            let min_timestamp = points.iter().map(|p| p.timestamp_ms).min().unwrap_or(0);
            if min_timestamp > 0 {
                // Timestamps are epoch-based, normalize to relative
                for point in &mut points {
                    point.timestamp_ms -= min_timestamp;
                }
                log::debug!("Normalized timestamps by subtracting {} ms", min_timestamp);
            }
        }

        if points.is_empty() {
            return Err(ParserError::NoTelemetryData);
        }

        // Extract metadata from first/last rows
        let first_row: Vec<&str> = first_row_data
            .as_ref()
            .map(|v| v.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();
        let last_row: Vec<&str> = last_row_data
            .as_ref()
            .map(|v| v.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();

        let metadata = self.extract_metadata(
            file_path, file_hash, &col_map, &first_row, &last_row, &points,
        )?;
        let stats = self.calculate_stats(&points, &col_map, &first_row, &last_row);

        log::info!(
            "Litchi parse complete in {:.1}s: duration={:.1}s, distance={:.0}m, max_alt={:.1}m, points={}",
            parse_start.elapsed().as_secs_f64(),
            metadata.duration_secs.unwrap_or(0.0),
            metadata.total_distance.unwrap_or(0.0),
            metadata.max_altitude.unwrap_or(0.0),
            points.len()
        );

        // Generate smart tags and add "Litchi" source tag
        let mut tags = LogParser::generate_smart_tags(&metadata, &stats);
        tags.insert(0, "Litchi".to_string()); // Add Litchi tag at the beginning
        log::info!("Generated smart tags: {:?}", tags);

        Ok(ParseResult {
            metadata,
            points,
            tags,
            manual_tags: Vec::new(),
            notes: None,
            color: None,
            messages: Vec::new(),
        })
    }

    /// Parse a single CSV row into a TelemetryPoint
    fn parse_row(
        &self,
        col_map: &ColumnMap,
        row: &[&str],
        battery_full_capacity: Option<f64>,
    ) -> TelemetryPoint {
        let get_any_f64 = |fields: &[&str]| fields.iter().find_map(|f| col_map.get_f64(row, f));

        // Parse timestamp - prefer time(millisecond) as relative ms from flight start
        // If time column exists, use it (with 0 for empty values)
        // Otherwise use datetime as epoch ms (will be normalized later)
        let timestamp_ms = if col_map.has_column("time") {
            // time(millisecond) column exists - use it, default to 0 if empty
            col_map
                .get_str(row, "time")
                .and_then(|s| {
                    if s.trim().is_empty() {
                        None
                    } else {
                        s.parse::<i64>().ok()
                    }
                })
                .unwrap_or(0)
        } else {
            // No time column - use datetime as epoch ms (will be normalized to relative later)
            col_map
                .get_str(row, "datetime")
                .and_then(|dt| {
                    NaiveDateTime::parse_from_str(&dt, "%Y-%m-%d %H:%M:%S%.f")
                        .ok()
                        .map(|ndt| ndt.and_utc().timestamp_millis())
                })
                .unwrap_or(0)
        };

        TelemetryPoint {
            timestamp_ms,

            // Position
            latitude: col_map.get_f64(row, "latitude"),
            longitude: col_map.get_f64(row, "longitude"),
            altitude: col_map.get_f64(row, "altitude"),
            height: col_map.get_f64(row, "ultrasonicHeight"),
            vps_height: col_map.get_f64(row, "ultrasonicHeight"),
            altitude_abs: None, // Not in Litchi CSV

            // Velocity
            speed: col_map.get_f64(row, "speed"),
            velocity_x: col_map.get_f64(row, "velocityX"),
            velocity_y: col_map.get_f64(row, "velocityY"),
            velocity_z: col_map.get_f64(row, "velocityZ"),

            // Orientation
            pitch: col_map.get_f64(row, "pitch"),
            roll: col_map.get_f64(row, "roll"),
            yaw: col_map.get_f64(row, "yaw"),

            // Gimbal - Raw values are in tenths of degrees, converted columns are already in degrees
            gimbal_pitch: get_any_f64(&["gimbalPitchRaw", "gimbal_pitch_raw"])
                .map(|v| v / 10.0)
                .or_else(|| get_any_f64(&["gimbalPitch", "gimbal_pitch"])),
            gimbal_roll: get_any_f64(&["gimbalRollRaw", "gimbal_roll_raw"])
                .map(|v| v / 10.0)
                .or_else(|| get_any_f64(&["gimbalRoll", "gimbal_roll"])),
            gimbal_yaw: get_any_f64(&["gimbalYawRaw", "gimbal_yaw_raw"])
                .map(|v| v / 10.0)
                .or_else(|| get_any_f64(&["gimbalYaw", "gimbal_yaw"])),

            // Power
            battery_percent: col_map.get_i32(row, "remainPowerPercent"),
            battery_voltage: col_map.get_f64(row, "voltage").or(
                col_map
                    .get_f64(row, "currentVoltage")
                    .map(|v| if v > 1000.0 { v / 1000.0 } else { v }), // currentVoltage is in mV
            ),
            battery_current: col_map.get_f64(row, "currentCurrent"),
            battery_temp: col_map
                .get_f64(row, "batteryTemperature")
                .map(|v| if v > 200.0 { v / 10.0 - 273.15 } else { v }) // Convert tenths-of-Kelvin to Celsius
                .or(col_map.get_f64(row, "temperature")), // temperature(F) is auto-converted by unit system
            cell_voltages: {
                // Parse Battery_Cell1..6 columns (values in millivolts, convert to volts)
                let cells: Vec<f64> = (1..=6)
                    .filter_map(|i| {
                        col_map
                            .get_f64(row, &format!("Battery_Cell{}", i))
                            .filter(|&v| v > 0.0)
                            .map(|v| if v > 100.0 { v / 1000.0 } else { v }) // mV to V
                    })
                    .collect();
                if cells.is_empty() {
                    None
                } else {
                    Some(cells)
                }
            },

            // Status
            flight_mode: col_map.get_str(row, "flightmode"),
            gps_signal: None, // Not directly available
            satellites: col_map.get_i32(row, "satellites"),
            rc_signal: None,
            rc_uplink: col_map.get_i32(row, "uplinkSignalQuality"),
            rc_downlink: col_map.get_i32(row, "downlinkSignalQuality"),

            // RC stick inputs
            rc_aileron: col_map.get_f64(row, "Rc_aileron"),
            rc_elevator: col_map.get_f64(row, "Rc_elevator"),
            rc_throttle: col_map.get_f64(row, "Rc_throttle"),
            rc_rudder: col_map.get_f64(row, "Rc_rudder"),

            // Camera state
            is_photo: col_map.get_bool(row, "istakingphoto"),
            is_video: col_map.get_bool(row, "isTakingVideo"),

            // Battery capacity
            battery_full_capacity,
            battery_remained_capacity: col_map
                .get_f64(row, "CENTER_BATTERY.remainedCapacity")
                .or(col_map.get_f64(row, "currentElectricity"))
                .filter(|&v| v > 0.0),
        }
    }

    /// Extract flight metadata from parsed data
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

        // Extract start time from first row
        let start_time = col_map.get_str(first_row, "datetime").and_then(|dt| {
            NaiveDateTime::parse_from_str(&dt, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|ndt| DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc))
        });

        // Extract end time from last row
        let end_time = col_map.get_str(last_row, "datetime").and_then(|dt| {
            NaiveDateTime::parse_from_str(&dt, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|ndt| DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc))
        });

        // Calculate duration
        let duration_secs = match (start_time, end_time) {
            (Some(s), Some(e)) => Some((e - s).num_milliseconds() as f64 / 1000.0),
            _ => {
                // Fallback: use timestamps from points
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

        // Calculate total distance (sum of haversine distances between consecutive points)
        let total_distance = self.calculate_total_distance(points);

        // Find max altitude and speed
        let max_altitude = points
            .iter()
            .filter_map(|p| p.altitude)
            .fold(0.0f64, f64::max);
        let max_speed = points.iter().filter_map(|p| p.speed).fold(0.0f64, f64::max);

        // Extract home location
        let home_lat = col_map.get_f64(first_row, "home_latitude");
        let home_lon = col_map.get_f64(first_row, "home_longitude");

        // Map Litchi drone type to model name
        let drone_model = col_map
            .get_str(first_row, "Dronetype")
            .map(|dt| self.map_drone_type(&dt));

        // Count photo and video capture events
        let (photo_count, video_count) = crate::models::count_media_events(points);

        Ok(FlightMetadata {
            id: self.db.generate_flight_id(),
            file_name,
            display_name,
            file_hash: Some(file_hash.to_string()),
            drone_model,
            drone_serial: col_map
                .get_str(first_row, "FlyControllerSerialNumber")
                .map(|s| s.trim().to_uppercase())
                .filter(|s| !s.is_empty()),
            aircraft_name: col_map
                .get_str(first_row, "Planename")
                .filter(|s| !s.is_empty()),
            battery_serial: col_map
                .get_str(first_row, "BatterySerialNumber")
                .map(|s| s.trim().to_uppercase())
                .filter(|s| !s.is_empty()),
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

    /// Calculate statistics for smart tag generation
    fn calculate_stats(
        &self,
        points: &[TelemetryPoint],
        col_map: &ColumnMap,
        first_row: &[&str],
        last_row: &[&str],
    ) -> FlightStats {
        let duration_secs = if points.len() >= 2 {
            (points.last().unwrap().timestamp_ms - points.first().unwrap().timestamp_ms) as f64
                / 1000.0
        } else {
            0.0
        };

        let total_distance_m = self.calculate_total_distance(points);
        let max_altitude_m = points
            .iter()
            .filter_map(|p| p.altitude)
            .fold(0.0f64, f64::max);
        let max_speed_ms = points.iter().filter_map(|p| p.speed).fold(0.0f64, f64::max);

        // Average speed (excluding zero speeds)
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

        // Home location
        let home_lat = col_map.get_f64(first_row, "home_latitude");
        let home_lon = col_map.get_f64(first_row, "home_longitude");
        let home_location = match (home_lon, home_lat) {
            (Some(lon), Some(lat)) if lat.abs() > 0.001 || lon.abs() > 0.001 => Some([lon, lat]),
            _ => None,
        };

        // Max distance from home
        let max_distance_from_home_m = if let Some([home_lon, home_lat]) = home_location {
            points
                .iter()
                .filter_map(|p| match (p.latitude, p.longitude) {
                    (Some(lat), Some(lon)) => {
                        Some(self.haversine_distance(home_lat, home_lon, lat, lon))
                    }
                    _ => None,
                })
                .fold(0.0f64, f64::max)
        } else {
            0.0
        };

        // Battery stats
        let start_battery_percent = col_map.get_i32(first_row, "remainPowerPercent");
        let end_battery_percent = col_map.get_i32(last_row, "remainPowerPercent");
        let start_battery_temp = col_map
            .get_f64(first_row, "batteryTemperature")
            .or(col_map.get_f64(first_row, "temperature"));

        // Min battery is the lowest battery percentage during flight
        let min_battery = points
            .iter()
            .filter_map(|p| p.battery_percent)
            .filter(|&v| v > 0)
            .min()
            .unwrap_or(end_battery_percent.unwrap_or(0));

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

    /// Calculate total distance traveled using haversine formula
    fn calculate_total_distance(&self, points: &[TelemetryPoint]) -> f64 {
        let mut total = 0.0;
        for i in 1..points.len() {
            if let (Some(lat1), Some(lon1), Some(lat2), Some(lon2)) = (
                points[i - 1].latitude,
                points[i - 1].longitude,
                points[i].latitude,
                points[i].longitude,
            ) {
                total += self.haversine_distance(lat1, lon1, lat2, lon2);
            }
        }
        total
    }

    /// Haversine distance between two coordinates in meters
    fn haversine_distance(&self, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        const R: f64 = 6371000.0; // Earth radius in meters

        let lat1_rad = lat1.to_radians();
        let lat2_rad = lat2.to_radians();
        let delta_lat = (lat2 - lat1).to_radians();
        let delta_lon = (lon2 - lon1).to_radians();

        let a = (delta_lat / 2.0).sin().powi(2)
            + lat1_rad.cos() * lat2_rad.cos() * (delta_lon / 2.0).sin().powi(2);
        let c = 2.0 * a.sqrt().asin();

        R * c
    }

    /// Map Litchi drone type code to model name
    fn map_drone_type(&self, type_code: &str) -> String {
        // Litchi uses numeric codes for drone types
        match type_code.trim() {
            "0" => "Unknown".to_string(),
            "1" => "Inspire 1".to_string(),
            "2" => "Phantom 3 Standard".to_string(),
            "3" => "Phantom 3 Advanced".to_string(),
            "4" => "Phantom 3 Professional".to_string(),
            "5" => "Phantom 3 4K".to_string(),
            "6" => "Mavic Pro".to_string(),
            "7" => "Inspire 2".to_string(),
            "8" => "Phantom 4".to_string(),
            "9" => "Phantom 4 Pro".to_string(),
            "10" => "Phantom 4 Advanced".to_string(),
            "11" => "Mavic Air".to_string(),
            "14" => "Mavic 2 Pro".to_string(),
            "15" => "Mavic 2 Zoom".to_string(),
            "16" => "Mavic 2 Enterprise".to_string(),
            "17" => "Mavic Mini".to_string(),
            "18" => "Mavic Air 2".to_string(),
            "19" => "DJI FPV".to_string(),
            "20" => "Mini 2".to_string(),
            "21" => "Spark".to_string(),
            "23" => "Air 2S".to_string(),
            "58" => "Mini SE".to_string(),
            _ => format!("DJI Drone ({})", type_code),
        }
    }
}
