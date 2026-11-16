//! Parser for DroneDeploy Flight Recorder logs.
//!
//! DroneDeploy exports a metadata preamble followed by a tab-separated
//! telemetry table. Files are normally named with `.log` or `.tsv`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::Value;

use crate::database::Database;
use crate::models::{FlightMessage, FlightMetadata, FlightStats, TelemetryPoint};
use crate::parser::{LogParser, ParseResult, ParserError};

const FEET_TO_METERS: f64 = 0.3048;
const MPH_TO_METERS_PER_SECOND: f64 = 0.44704;
const KPH_TO_METERS_PER_SECOND: f64 = 1.0 / 3.6;
const MILLIVOLTS_TO_VOLTS: f64 = 0.001;
const AMPS_TO_MILLIAMPS: f64 = 1000.0;
const DJI_RC_STICK_LIMIT: f64 = 660.0;

const HEADER_MARKERS: [&str; 4] = [
    "Date/Time (GMT)",
    "Elapsed Time (sec)",
    "Aircraft Latitude (Degrees)",
    "Aircraft Longitude (Degrees)",
];

struct ColumnMap {
    indices: HashMap<String, usize>,
}

impl ColumnMap {
    fn new(headers: &[&str]) -> Self {
        let indices = headers
            .iter()
            .enumerate()
            .map(|(index, header)| (header.trim().to_ascii_lowercase(), index))
            .collect();
        Self { indices }
    }

    fn get_str<'r>(&self, row: &'r [&str], field: &str) -> Option<&'r str> {
        let value = row
            .get(*self.indices.get(&field.trim().to_ascii_lowercase())?)?
            .trim();
        if value.is_empty() || value.eq_ignore_ascii_case("null") || value == "N/A" {
            None
        } else {
            Some(value)
        }
    }

    fn get_owned(&self, row: &[&str], field: &str) -> Option<String> {
        self.get_str(row, field).map(str::to_string)
    }

    fn get_f64(&self, row: &[&str], field: &str) -> Option<f64> {
        self.get_str(row, field)?
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
    }

    fn get_scaled(&self, row: &[&str], field: &str, scale: f64) -> Option<f64> {
        self.get_f64(row, field).map(|value| value * scale)
    }

    fn get_scaled_any(&self, row: &[&str], fields: &[(&str, f64)]) -> Option<f64> {
        fields
            .iter()
            .find_map(|(field, scale)| self.get_scaled(row, field, *scale))
    }

    fn get_i32(&self, row: &[&str], field: &str) -> Option<i32> {
        self.get_str(row, field)?
            .parse::<i32>()
            .ok()
            .or_else(|| self.get_f64(row, field).map(|value| value.round() as i32))
    }

    fn get_bool(&self, row: &[&str], field: &str) -> Option<bool> {
        let value = self.get_str(row, field)?;
        match value.to_ascii_lowercase().as_str() {
            "true" | "yes" => Some(true),
            "false" | "no" => Some(false),
            _ => value.parse::<f64>().ok().map(|number| number != 0.0),
        }
    }
}

pub struct DroneDeployParser<'a> {
    db: &'a Database,
}

impl<'a> DroneDeployParser<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { db }
    }

    /// Check both the extension and the DroneDeploy Flight Recorder signature.
    pub fn is_dronedeploy_log(path: &Path) -> bool {
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !extension.eq_ignore_ascii_case("log") && !extension.eq_ignore_ascii_case("tsv") {
            return false;
        }

        let Ok(file) = File::open(path) else {
            return false;
        };

        let mut has_signature = false;
        let mut has_header = false;
        for line in BufReader::new(file).lines().take(256).flatten() {
            let line = line.trim_end_matches('\r');
            if line.starts_with("#DroneDeploy\t") || line == "#DroneDeploy" {
                has_signature = true;
            }
            if is_telemetry_header(line) {
                has_header = true;
                break;
            }
        }

        has_signature && has_header
    }

    pub fn parse(&self, file_path: &Path, file_hash: &str) -> Result<ParseResult, ParserError> {
        if !Self::is_dronedeploy_log(file_path) {
            return Err(ParserError::IncompatibleFile);
        }

        let parse_start = std::time::Instant::now();
        log::info!("Parsing DroneDeploy Flight Recorder log: {:?}", file_path);

        let file = File::open(file_path)?;
        let reader = BufReader::new(file);
        let mut metadata_values = HashMap::<String, String>::new();
        let mut column_map: Option<ColumnMap> = None;
        let mut header_len = 0usize;
        let mut in_footer = false;
        let mut footer_end_time = None;
        let mut footer_elapsed_secs = None;
        let mut first_row_time = None;
        let mut last_row_time = None;
        let mut first_elapsed_secs = None;
        let mut last_elapsed_secs = None;
        let mut home_location = None;
        let mut points = Vec::new();
        let mut messages = Vec::new();

        for line_result in reader.lines() {
            let line = line_result?;
            let line = line.trim_end_matches('\r');

            if column_map.is_none() {
                if is_telemetry_header(line) {
                    let headers: Vec<&str> = line.split('\t').collect();
                    header_len = headers.len();
                    column_map = Some(ColumnMap::new(&headers));
                } else if !line.starts_with('#') {
                    if let Some((key, value)) = line.split_once('\t') {
                        metadata_values.insert(key.trim().to_string(), value.trim().to_string());
                    }
                }
                continue;
            }

            if line.starts_with("#Flight Recorder Session End") {
                in_footer = true;
                continue;
            }
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if in_footer {
                if let Some((key, value)) = line.split_once('\t') {
                    match key.trim() {
                        "Date/Time (UTC)" => footer_end_time = parse_dronedeploy_datetime(value),
                        "Elapsed Time (sec)" => footer_elapsed_secs = parse_f64(value),
                        _ => {}
                    }
                }
                continue;
            }

            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() < header_len / 2 {
                continue;
            }
            let columns = column_map.as_ref().expect("header was initialized");
            let Some(elapsed_secs) = columns.get_f64(&fields, "Elapsed Time (sec)") else {
                continue;
            };
            if elapsed_secs < 0.0 {
                continue;
            }

            first_elapsed_secs.get_or_insert(elapsed_secs);
            last_elapsed_secs = Some(elapsed_secs);

            if let Some(row_time) = columns
                .get_str(&fields, "Date/Time (GMT)")
                .and_then(parse_dronedeploy_datetime)
            {
                first_row_time.get_or_insert(row_time);
                last_row_time = Some(row_time);
            }

            let timestamp_ms = (elapsed_secs * 1000.0).round() as i64;
            if let Some(info) = columns.get_str(&fields, "Info") {
                extract_messages(info, timestamp_ms, &mut messages);
            }

            if let (Some(home_lat), Some(home_lon)) = (
                columns.get_f64(&fields, "Home Latitude (Degrees)"),
                columns.get_f64(&fields, "Home Longitude (Degrees)"),
            ) {
                if valid_coordinate(home_lat, home_lon) {
                    home_location = Some([home_lon, home_lat]);
                }
            }

            let (Some(latitude), Some(longitude)) = (
                columns.get_f64(&fields, "Aircraft Latitude (Degrees)"),
                columns.get_f64(&fields, "Aircraft Longitude (Degrees)"),
            ) else {
                continue;
            };
            if !valid_coordinate(latitude, longitude) {
                continue;
            }

            let vps_height = metric_distance(columns, &fields, "Aircraft Ultrasonic Altitude");
            let rc_signal = columns
                .get_i32(&fields, "RC Signal 1 (%)")
                .or_else(|| columns.get_i32(&fields, "RC Signal 2 (%)"));

            points.push(TelemetryPoint {
                timestamp_ms,
                latitude: Some(latitude),
                longitude: Some(longitude),
                altitude: metric_distance(columns, &fields, "Aircraft Barometric Altitude"),
                height: vps_height,
                vps_height,
                altitude_abs: None,
                speed: metric_speed(columns, &fields, "Aircraft Speed"),
                velocity_x: metric_speed(columns, &fields, "Aircraft Vel - X"),
                velocity_y: metric_speed(columns, &fields, "Aircraft Vel - Y"),
                velocity_z: metric_speed(columns, &fields, "Aircraft Vel - Z"),
                pitch: columns.get_f64(&fields, "Aircraft Pitch (Degrees)"),
                roll: columns.get_f64(&fields, "Aircraft Roll (Degrees)"),
                yaw: columns.get_f64(&fields, "Aircraft Heading (Degrees)"),
                gimbal_pitch: columns.get_f64(&fields, "Gimbal Pitch (Degrees)"),
                gimbal_roll: columns.get_f64(&fields, "Gimbal Roll (Degrees)"),
                gimbal_yaw: columns.get_f64(&fields, "Gimbal Yaw (Degrees)"),
                battery_percent: columns.get_i32(&fields, "Aircraft Battery Power (%)"),
                battery_voltage: columns.get_scaled_any(
                    &fields,
                    &[
                        ("Aircraft Battery Voltage (mV)", MILLIVOLTS_TO_VOLTS),
                        ("Aircraft Battery Voltage (V)", 1.0),
                        ("Aircraft Battery Voltage (Volts)", 1.0),
                    ],
                ),
                // Open DroneLog stores battery current in mA.
                battery_current: columns.get_scaled_any(
                    &fields,
                    &[
                        ("Aircraft Battery Current (mA)", 1.0),
                        ("Aircraft Battery Current (A)", AMPS_TO_MILLIAMPS),
                        ("Aircraft Battery Current (Amps)", AMPS_TO_MILLIAMPS),
                    ],
                ),
                battery_temp: metric_temperature(columns, &fields),
                battery_full_capacity: metadata_f64(&metadata_values, "Full Charge Volume (mAh)"),
                battery_remained_capacity: columns
                    .get_f64(&fields, "Aircraft Battery Charge (mAh)"),
                cell_voltages: None,
                flight_mode: columns.get_owned(&fields, "Aircraft Flight Mode"),
                gps_signal: columns.get_i32(&fields, "Aircraft GPS Signal Value"),
                satellites: columns.get_i32(&fields, "Aircraft Satellites"),
                rc_signal,
                rc_uplink: None,
                rc_downlink: None,
                rc_aileron: normalized_rc_stick(columns.get_f64(&fields, "RC Right Horizontal")),
                rc_elevator: normalized_rc_stick(columns.get_f64(&fields, "RC Right Vertical")),
                rc_throttle: normalized_rc_stick(columns.get_f64(&fields, "RC Left Vertical")),
                rc_rudder: normalized_rc_stick(columns.get_f64(&fields, "RC Left Horizontal")),
                is_photo: columns.get_bool(&fields, "Aircraft Camera Storing Photo"),
                is_video: columns.get_bool(&fields, "Aircraft Camera Recording"),
            });
        }

        if points.is_empty() {
            log::warn!("DroneDeploy signature found, but no valid telemetry rows were parsed");
            return Err(ParserError::IncompatibleFile);
        }

        points.sort_by_key(|point| point.timestamp_ms);
        points.dedup_by_key(|point| point.timestamp_ms);

        let start_time = metadata_values
            .get("Session Start")
            .and_then(|value| parse_dronedeploy_datetime(value))
            .or(first_row_time);
        let duration_secs =
            footer_elapsed_secs.or_else(|| match (first_elapsed_secs, last_elapsed_secs) {
                (Some(first), Some(last)) if last >= first => Some(last - first),
                _ => None,
            });
        let end_time = footer_end_time.or(last_row_time).or_else(|| {
            start_time
                .as_ref()
                .zip(duration_secs)
                .map(|(start, duration)| {
                    start.clone() + Duration::milliseconds((duration * 1000.0).round() as i64)
                })
        });

        let home_location = home_location.or_else(|| {
            points
                .first()
                .and_then(|point| Some([point.longitude?, point.latitude?]))
        });
        let stats = calculate_stats(&points, home_location, duration_secs.unwrap_or(0.0));
        let (photo_count, video_count) = crate::models::count_media_events(&points);
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();
        let display_name = file_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.trim().is_empty())
            .unwrap_or(&file_name)
            .to_string();

        let metadata = FlightMetadata {
            id: self.db.generate_flight_id(),
            file_name,
            display_name,
            file_hash: Some(file_hash.to_string()),
            drone_model: metadata_string(&metadata_values, "Aircraft Model"),
            drone_serial: metadata_serial(&metadata_values, "Flight Controller Serial Number"),
            aircraft_name: metadata_string(&metadata_values, "Aircraft Name"),
            battery_serial: metadata_serial(&metadata_values, "Battery Serial Number"),
            cycle_count: metadata_i32(&metadata_values, "Discharges"),
            rc_serial: metadata_serial(&metadata_values, "Remote Control Serial Number"),
            battery_life: metadata_i32(&metadata_values, "Remaining Life (%)"),
            start_time,
            end_time,
            duration_secs,
            total_distance: Some(stats.total_distance_m),
            max_altitude: Some(stats.max_altitude_m),
            max_speed: Some(stats.max_speed_ms),
            home_lat: home_location.map(|home| home[1]),
            home_lon: home_location.map(|home| home[0]),
            point_count: points.len() as i32,
            photo_count,
            video_count,
        };

        let mut tags = LogParser::generate_smart_tags(&metadata, &stats);
        tags.insert(0, "DroneDeploy".to_string());

        log::info!(
            "DroneDeploy parse complete in {:.1}s: duration={:.1}s, distance={:.0}m, max_alt={:.1}m, points={}",
            parse_start.elapsed().as_secs_f64(),
            metadata.duration_secs.unwrap_or(0.0),
            stats.total_distance_m,
            stats.max_altitude_m,
            points.len()
        );

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
}

fn is_telemetry_header(line: &str) -> bool {
    let headers: Vec<&str> = line.split('\t').map(str::trim).collect();
    HEADER_MARKERS
        .iter()
        .all(|marker| headers.iter().any(|header| header == marker))
}

fn parse_f64(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

fn parse_dronedeploy_datetime(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    for format in ["%m/%d/%Y %H:%M:%S%.f", "%m/%d/%Y %H:%M:%S"] {
        if let Ok(datetime) = NaiveDateTime::parse_from_str(value, format) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(datetime, Utc));
        }
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|datetime| datetime.with_timezone(&Utc))
}

fn fahrenheit_to_celsius(value: f64) -> f64 {
    (value - 32.0) * 5.0 / 9.0
}

fn metric_distance(columns: &ColumnMap, row: &[&str], base: &str) -> Option<f64> {
    [
        ("ft", FEET_TO_METERS),
        ("feet", FEET_TO_METERS),
        ("m", 1.0),
        ("meter", 1.0),
        ("meters", 1.0),
    ]
    .iter()
    .find_map(|(unit, scale)| {
        let field = format!("{} ({})", base, unit);
        columns.get_scaled(row, &field, *scale)
    })
}

fn metric_speed(columns: &ColumnMap, row: &[&str], base: &str) -> Option<f64> {
    [
        ("mph", MPH_TO_METERS_PER_SECOND),
        ("km/h", KPH_TO_METERS_PER_SECOND),
        ("kph", KPH_TO_METERS_PER_SECOND),
        ("kmph", KPH_TO_METERS_PER_SECOND),
        ("kilometers per hour", KPH_TO_METERS_PER_SECOND),
        ("m/s", 1.0),
        ("meters per second", 1.0),
    ]
    .iter()
    .find_map(|(unit, scale)| {
        let field = format!("{} ({})", base, unit);
        columns.get_scaled(row, &field, *scale)
    })
}

fn metric_temperature(columns: &ColumnMap, row: &[&str]) -> Option<f64> {
    columns
        .get_f64(row, "Aircraft Battery Temperature (Celsius)")
        .or_else(|| columns.get_f64(row, "Aircraft Battery Temperature (C)"))
        .or_else(|| {
            columns
                .get_f64(row, "Aircraft Battery Temperature (Fahrenheit)")
                .or_else(|| columns.get_f64(row, "Aircraft Battery Temperature (F)"))
                .map(fahrenheit_to_celsius)
        })
}

fn normalized_rc_stick(value: Option<f64>) -> Option<f64> {
    value.map(|raw| (raw / DJI_RC_STICK_LIMIT * 100.0).clamp(-100.0, 100.0))
}

fn valid_coordinate(latitude: f64, longitude: f64) -> bool {
    latitude.is_finite()
        && longitude.is_finite()
        && latitude.abs() <= 90.0
        && longitude.abs() <= 180.0
        && (latitude.abs() > 1e-8 || longitude.abs() > 1e-8)
}

fn metadata_string(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("null"))
}

fn metadata_serial(values: &HashMap<String, String>, key: &str) -> Option<String> {
    metadata_string(values, key).map(|value| value.to_uppercase())
}

fn metadata_f64(values: &HashMap<String, String>, key: &str) -> Option<f64> {
    metadata_string(values, key).and_then(|value| parse_f64(&value))
}

fn metadata_i32(values: &HashMap<String, String>, key: &str) -> Option<i32> {
    metadata_string(values, key).and_then(|value| {
        value
            .parse::<i32>()
            .ok()
            .or_else(|| parse_f64(&value).map(|number| number.round() as i32))
    })
}

fn extract_messages(info: &str, timestamp_ms: i64, messages: &mut Vec<FlightMessage>) {
    let Ok(value) = serde_json::from_str::<Value>(info) else {
        return;
    };

    fn visit(value: &Value, timestamp_ms: i64, messages: &mut Vec<FlightMessage>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    visit(value, timestamp_ms, messages);
                }
            }
            Value::Object(object) => {
                if let Some(message) = object.get("message").and_then(Value::as_str) {
                    let message = message.trim();
                    if !message.is_empty()
                        && !messages.iter().any(|existing| {
                            existing.timestamp_ms == timestamp_ms && existing.message == message
                        })
                    {
                        let lower = message.to_ascii_lowercase();
                        let message_type = if lower.contains("warn") || lower.contains("error") {
                            "warn"
                        } else if lower.contains("caution") {
                            "caution"
                        } else {
                            "tip"
                        };
                        messages.push(FlightMessage {
                            timestamp_ms,
                            message_type: message_type.to_string(),
                            message: message.to_string(),
                        });
                    }
                }
                for nested in object.values() {
                    if !nested.is_string() {
                        visit(nested, timestamp_ms, messages);
                    }
                }
            }
            _ => {}
        }
    }

    visit(&value, timestamp_ms, messages);
}

fn calculate_stats(
    points: &[TelemetryPoint],
    home_location: Option<[f64; 2]>,
    duration_secs: f64,
) -> FlightStats {
    let total_distance_m = points
        .windows(2)
        .filter_map(|pair| {
            Some(haversine_distance(
                pair[0].latitude?,
                pair[0].longitude?,
                pair[1].latitude?,
                pair[1].longitude?,
            ))
        })
        .sum();
    let max_altitude_m = points
        .iter()
        .filter_map(|point| point.altitude)
        .fold(0.0f64, f64::max);
    let max_speed_ms = points
        .iter()
        .filter_map(|point| point.speed)
        .fold(0.0f64, f64::max);
    let speeds: Vec<f64> = points
        .iter()
        .filter_map(|point| point.speed)
        .filter(|speed| *speed > 0.1)
        .collect();
    let avg_speed_ms = if speeds.is_empty() {
        0.0
    } else {
        speeds.iter().sum::<f64>() / speeds.len() as f64
    };
    let max_distance_from_home_m = home_location
        .map(|[home_lon, home_lat]| {
            points
                .iter()
                .filter_map(|point| {
                    Some(haversine_distance(
                        home_lat,
                        home_lon,
                        point.latitude?,
                        point.longitude?,
                    ))
                })
                .fold(0.0f64, f64::max)
        })
        .unwrap_or(0.0);

    FlightStats {
        duration_secs,
        total_distance_m,
        max_altitude_m,
        max_speed_ms,
        avg_speed_ms,
        min_battery: points
            .iter()
            .filter_map(|point| point.battery_percent)
            .min()
            .unwrap_or(0),
        home_location,
        max_distance_from_home_m,
        start_battery_percent: points.first().and_then(|point| point.battery_percent),
        end_battery_percent: points.last().and_then(|point| point.battery_percent),
        start_battery_temp: points.first().and_then(|point| point.battery_temp),
    }
}

fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_METERS: f64 = 6_371_000.0;
    let lat1_radians = lat1.to_radians();
    let lat2_radians = lat2.to_radians();
    let delta_latitude = (lat2 - lat1).to_radians();
    let delta_longitude = (lon2 - lon1).to_radians();
    let a = (delta_latitude / 2.0).sin().powi(2)
        + lat1_radians.cos() * lat2_radians.cos() * (delta_longitude / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_METERS * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const FIXTURE: &str = "#DroneDeploy\t5.142.1\n\
#Flight Recorder\n\
Session Start\t07/22/2026 13:07:14\n\
Aircraft Model\tDJI_MAVIC_3_ENTERPRISE_SERIES\n\
Aircraft Name\tSurveyor\n\
Full Charge Volume (mAh)\t5000\n\
Remaining Life (%)\t98\n\
Discharges\t12\n\
Battery Serial Number\tbat123\n\
Flight Controller Serial Number\tfc123\n\
Remote Control Serial Number\trc123\n\
Date/Time (GMT)\tElapsed Time (sec)\tInfo\tAircraft Battery Power (%)\tAircraft Battery Charge (mAh)\tAircraft Battery Current (mA)\tAircraft Battery Voltage (mV)\tAircraft Battery Temperature (Fahrenheit)\tAircraft Latitude (Degrees)\tAircraft Longitude (Degrees)\tAircraft Barometric Altitude (ft)\tAircraft Heading (Degrees)\tAircraft Pitch (Degrees)\tAircraft Roll (Degrees)\tAircraft Satellites\tAircraft Flight Mode\tAircraft Ultrasonic Altitude (ft)\tAircraft GPS Signal Value\tHome Latitude (Degrees)\tHome Longitude (Degrees)\tGimbal Pitch (Degrees)\tGimbal Roll (Degrees)\tGimbal Yaw (Degrees)\tRC Left Horizontal\tRC Left Vertical\tRC Right Horizontal\tRC Right Vertical\tRC Signal 1 (%)\tAircraft Camera Recording\tAircraft Camera Storing Photo\tAircraft Vel - X (mph)\tAircraft Vel - Y (mph)\tAircraft Vel - Z (mph)\tAircraft Speed (mph)\n\
07/22/2026 13:07:14\t0.000\t[{\"message\":\"Mission did take off\"}]\t90\t4500\t-1000\t16000\t50\t47.0000\t19.0000\t10\t180\t1\t-2\t20\tP-GPS\t5\t4\t47.0000\t19.0000\t-45\t0\t180\t-660\t330\t660\t-330\t75\t0\t0\t10\t0\t-5\t10\n\
07/22/2026 13:07:16\t2.000\t\t85\t4250\t-1500\t15800\t51.8\t47.0001\t19.0001\t20\t181\t2\t-1\t21\tP-GPS\t6\t5\t47.0000\t19.0000\t-46\t1\t181\t0\t0\t0\t0\t70\t1\t1\t0\t10\t0\t10\n\
#Flight Recorder Session End\n\
Date/Time (UTC)\t07/22/2026 13:07:16\n\
Elapsed Time (sec)\t2.000\n";

    #[test]
    fn detects_supported_extensions_and_signature() {
        let temp_dir = tempdir().unwrap();
        let log_path = temp_dir.path().join("flight.log");
        let tsv_path = temp_dir.path().join("flight.TSV");
        let csv_path = temp_dir.path().join("flight.csv");
        std::fs::write(&log_path, FIXTURE).unwrap();
        std::fs::write(&tsv_path, FIXTURE).unwrap();
        std::fs::write(&csv_path, FIXTURE).unwrap();

        assert!(DroneDeployParser::is_dronedeploy_log(&log_path));
        assert!(DroneDeployParser::is_dronedeploy_log(&tsv_path));
        assert!(!DroneDeployParser::is_dronedeploy_log(&csv_path));
    }

    #[test]
    fn parses_metadata_telemetry_messages_and_units() {
        let temp_dir = tempdir().unwrap();
        let log_path = temp_dir.path().join("flight.log");
        std::fs::write(&log_path, FIXTURE).unwrap();
        let db = Database::new(temp_dir.path().join("db"), "default").unwrap();

        let result = DroneDeployParser::new(&db)
            .parse(&log_path, "fixture-hash")
            .unwrap();

        assert_eq!(
            result.metadata.drone_model.as_deref(),
            Some("DJI_MAVIC_3_ENTERPRISE_SERIES")
        );
        assert_eq!(result.metadata.drone_serial.as_deref(), Some("FC123"));
        assert_eq!(result.metadata.battery_serial.as_deref(), Some("BAT123"));
        assert_eq!(result.metadata.rc_serial.as_deref(), Some("RC123"));
        assert_eq!(result.metadata.cycle_count, Some(12));
        assert_eq!(result.metadata.battery_life, Some(98));
        assert_eq!(result.metadata.photo_count, 1);
        assert_eq!(result.metadata.video_count, 1);
        assert_eq!(result.points.len(), 2);
        assert_eq!(result.tags.first().map(String::as_str), Some("DroneDeploy"));
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].message, "Mission did take off");

        let first = &result.points[0];
        assert!((first.altitude.unwrap() - 3.048).abs() < 1e-9);
        assert!((first.vps_height.unwrap() - 1.524).abs() < 1e-9);
        assert!((first.speed.unwrap() - 4.4704).abs() < 1e-9);
        assert!((first.battery_voltage.unwrap() - 16.0).abs() < 1e-9);
        assert!((first.battery_temp.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!(first.battery_current, Some(-1000.0));
        assert_eq!(first.battery_full_capacity, Some(5000.0));
        assert_eq!(first.battery_remained_capacity, Some(4500.0));
        assert_eq!(first.rc_aileron, Some(100.0));
        assert_eq!(first.rc_elevator, Some(-50.0));
        assert_eq!(first.rc_throttle, Some(50.0));
        assert_eq!(first.rc_rudder, Some(-100.0));
    }

    #[test]
    fn parses_metric_header_variants() {
        let metric_fixture = FIXTURE
            .replace("Altitude (ft)", "Altitude (m)")
            .replace("(mph)", "(km/h)")
            .replace("Temperature (Fahrenheit)", "Temperature (Celsius)")
            .replace("Voltage (mV)", "Voltage (V)")
            .replace("Current (mA)", "Current (A)")
            .replace("\t-1000\t16000\t50\t", "\t-1\t16\t10\t")
            .replace("\t-1500\t15800\t51.8\t", "\t-1.5\t15.8\t11\t");
        let temp_dir = tempdir().unwrap();
        let log_path = temp_dir.path().join("metric.tsv");
        std::fs::write(&log_path, metric_fixture).unwrap();
        let db = Database::new(temp_dir.path().join("db"), "default").unwrap();

        let result = DroneDeployParser::new(&db)
            .parse(&log_path, "metric-fixture-hash")
            .unwrap();
        let first = &result.points[0];

        assert!((first.altitude.unwrap() - 10.0).abs() < 1e-9);
        assert!((first.vps_height.unwrap() - 5.0).abs() < 1e-9);
        assert!((first.speed.unwrap() - (10.0 / 3.6)).abs() < 1e-9);
        assert!((first.battery_voltage.unwrap() - 16.0).abs() < 1e-9);
        assert!((first.battery_temp.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!(first.battery_current, Some(-1000.0));
    }

    #[test]
    fn rejects_an_unrelated_log_as_incompatible() {
        let temp_dir = tempdir().unwrap();
        let log_path = temp_dir.path().join("not-drone-deploy.log");
        std::fs::write(&log_path, "ordinary application log\n").unwrap();
        let db = Database::new(temp_dir.path().join("db"), "default").unwrap();

        let error = DroneDeployParser::new(&db)
            .parse(&log_path, "fixture-hash")
            .err()
            .expect("unrelated log should be rejected");
        assert!(matches!(error, ParserError::IncompatibleFile));
    }
}
