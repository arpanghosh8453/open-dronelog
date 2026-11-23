//! Data models for the Open DroneLog application.
//!
//! These structs are shared between Rust backend and TypeScript frontend
//! via Tauri's IPC system with serde serialization.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Flight metadata stored in the flights table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightMetadata {
    pub id: i64,
    pub file_name: String,
    pub display_name: String,
    pub file_hash: Option<String>,
    pub drone_model: Option<String>,
    pub drone_serial: Option<String>,
    pub aircraft_name: Option<String>,
    pub battery_serial: Option<String>,
    pub cycle_count: Option<i32>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub duration_secs: Option<f64>,
    pub total_distance: Option<f64>,
    pub max_altitude: Option<f64>,
    pub max_speed: Option<f64>,
    pub home_lat: Option<f64>,
    pub home_lon: Option<f64>,
    pub point_count: i32,
    pub photo_count: i32,
    pub video_count: i32,
    pub rc_serial: Option<String>,
    pub battery_life: Option<i32>,
}

/// Flight summary for list display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flight {
    pub id: i64,
    pub file_name: String,
    pub display_name: String,
    pub file_hash: Option<String>,
    pub drone_model: Option<String>,
    pub drone_serial: Option<String>,
    pub aircraft_name: Option<String>,
    pub battery_serial: Option<String>,
    pub cycle_count: Option<i32>,
    pub start_time: Option<String>,
    pub duration_secs: Option<f64>,
    pub total_distance: Option<f64>,
    pub max_altitude: Option<f64>,
    pub max_speed: Option<f64>,
    pub home_lat: Option<f64>,
    pub home_lon: Option<f64>,
    pub point_count: Option<i32>,
    pub photo_count: Option<i32>,
    pub video_count: Option<i32>,
    pub rc_serial: Option<String>,
    pub battery_life: Option<i32>,
    #[serde(default)]
    pub tags: Vec<FlightTag>,
    pub notes: Option<String>,
    #[serde(default = "default_flight_color")]
    pub color: Option<String>,
}

fn default_flight_color() -> Option<String> {
    Some("#7dd3fc".to_string())
}

/// A tag attached to a flight, with a type indicator
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightTag {
    pub tag: String,
    pub tag_type: String, // "auto" or "manual"
}

/// Raw telemetry point from parser (for bulk insert)
#[derive(Debug, Clone, Default)]
pub struct TelemetryPoint {
    pub timestamp_ms: i64,

    // Position
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub height: Option<f64>,
    pub vps_height: Option<f64>,
    pub altitude_abs: Option<f64>,

    // Velocity
    pub speed: Option<f64>,
    pub velocity_x: Option<f64>,
    pub velocity_y: Option<f64>,
    pub velocity_z: Option<f64>,

    // Orientation
    pub pitch: Option<f64>,
    pub roll: Option<f64>,
    pub yaw: Option<f64>,

    // Gimbal
    pub gimbal_pitch: Option<f64>,
    pub gimbal_roll: Option<f64>,
    pub gimbal_yaw: Option<f64>,

    // Power
    pub battery_percent: Option<i32>,
    pub battery_voltage: Option<f64>,
    pub battery_current: Option<f64>,
    pub battery_temp: Option<f64>,
    pub battery_full_capacity: Option<f64>,
    pub battery_remained_capacity: Option<f64>,
    pub cell_voltages: Option<Vec<f64>>,

    // Status
    pub flight_mode: Option<String>,
    pub gps_signal: Option<i32>,
    pub satellites: Option<i32>,
    pub rc_signal: Option<i32>,
    pub rc_uplink: Option<i32>,
    pub rc_downlink: Option<i32>,

    // RC stick inputs (normalized to -100..+100 percentage)
    pub rc_aileron: Option<f64>,
    pub rc_elevator: Option<f64>,
    pub rc_throttle: Option<f64>,
    pub rc_rudder: Option<f64>,

    // Camera state
    pub is_photo: Option<bool>,
    pub is_video: Option<bool>,
}

/// Telemetry record for frontend consumption (optimized for ECharts)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRecord {
    pub timestamp_ms: i64,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub height: Option<f64>,
    pub vps_height: Option<f64>,
    pub speed: Option<f64>,
    pub velocity_x: Option<f64>,
    pub velocity_y: Option<f64>,
    pub velocity_z: Option<f64>,
    pub battery_percent: Option<i32>,
    pub battery_voltage: Option<f64>,
    pub battery_temp: Option<f64>,
    pub battery_current: Option<f64>,
    pub battery_full_capacity: Option<f64>,
    pub battery_remained_capacity: Option<f64>,
    pub cell_voltages: Option<Vec<f64>>,
    pub pitch: Option<f64>,
    pub roll: Option<f64>,
    pub yaw: Option<f64>,
    pub gimbal_pitch: Option<f64>,
    pub gimbal_roll: Option<f64>,
    pub gimbal_yaw: Option<f64>,
    pub satellites: Option<i32>,
    pub flight_mode: Option<String>,
    pub rc_signal: Option<i32>,
    pub rc_uplink: Option<i32>,
    pub rc_downlink: Option<i32>,
    pub rc_aileron: Option<f64>,
    pub rc_elevator: Option<f64>,
    pub rc_throttle: Option<f64>,
    pub rc_rudder: Option<f64>,
    pub is_photo: Option<bool>,
    pub is_video: Option<bool>,
}

/// Flight message (tip or warning from DJI app)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightMessage {
    pub timestamp_ms: i64,
    pub message_type: String, // "tip", "warn", or "caution"
    pub message: String,
}

/// Response format optimized for ECharts rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDataResponse {
    pub flight: Flight,
    pub telemetry: TelemetryData,
    pub track: Vec<[f64; 3]>, // [lng, lat, height] for map
    pub messages: Vec<FlightMessage>,
}

/// Overview statistics across all flights
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewStats {
    pub total_flights: i64,
    pub total_distance_m: f64,
    pub total_duration_secs: f64,
    pub total_points: i64,
    pub total_photos: i64,
    pub total_videos: i64,
    pub max_altitude_m: f64,
    pub max_distance_from_home_m: f64,
    pub batteries_used: Vec<BatteryUsage>,
    pub drones_used: Vec<DroneUsage>,
    pub flights_by_date: Vec<FlightDateCount>,
    pub top_flights: Vec<TopFlight>,
    pub top_distance_flights: Vec<TopDistanceFlight>,
    pub battery_health_points: Vec<BatteryHealthPoint>,
}

/// Battery usage summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryUsage {
    pub battery_serial: String,
    pub flight_count: i64,
    /// Total flight duration for this battery in seconds
    pub total_duration_secs: f64,
    /// Max battery cycle count observed for this battery (from SmartBatteryStatic)
    pub max_cycle_count: Option<i32>,
}

/// Drone usage summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneUsage {
    pub drone_model: String,
    pub drone_serial: Option<String>,
    pub aircraft_name: Option<String>,
    pub flight_count: i64,
}

/// Flight count per date for activity heatmap
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDateCount {
    pub date: String,
    pub count: i64,
}

/// Top flight summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopFlight {
    pub id: i64,
    pub display_name: String,
    pub duration_secs: f64,
    pub start_time: Option<String>,
}

/// Top flight by max distance from home
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopDistanceFlight {
    pub id: i64,
    pub display_name: String,
    pub max_distance_from_home_m: f64,
    pub start_time: Option<String>,
}

/// Battery health scatter/line point per flight
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryHealthPoint {
    pub flight_id: i64,
    pub battery_serial: String,
    pub start_time: Option<String>,
    pub duration_mins: f64,
    pub delta_percent: f64,
    pub rate_per_min: f64,
}

/// Telemetry data formatted for ECharts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryData {
    /// Time axis in seconds from flight start
    pub time: Vec<f64>,
    /// Latitude series
    pub latitude: Vec<Option<f64>>,
    /// Longitude series
    pub longitude: Vec<Option<f64>>,
    /// Altitude series (legacy fallback)
    pub altitude: Vec<Option<f64>>,
    /// Height series
    pub height: Vec<Option<f64>>,
    /// VPS height series
    pub vps_height: Vec<Option<f64>>,
    /// Speed series
    pub speed: Vec<Option<f64>>,
    /// Velocity X series (north)
    pub velocity_x: Vec<Option<f64>>,
    /// Velocity Y series (east)
    pub velocity_y: Vec<Option<f64>>,
    /// Velocity Z series (down)
    pub velocity_z: Vec<Option<f64>>,
    /// Battery percent series
    pub battery: Vec<Option<i32>>,
    /// Battery voltage series
    pub battery_voltage: Vec<Option<f64>>,
    /// Battery temperature series
    pub battery_temp: Vec<Option<f64>>,
    /// Battery current series
    pub battery_current: Vec<Option<f64>>,
    /// Battery full capacity series (mAh)
    pub battery_full_capacity: Vec<Option<f64>>,
    /// Battery remaining capacity series (mAh)
    pub battery_remained_capacity: Vec<Option<f64>>,
    /// Individual cell voltages series (JSON arrays stored as Vec)
    pub cell_voltages: Vec<Option<Vec<f64>>>,
    /// Number of GPS satellites
    pub satellites: Vec<Option<i32>>,
    /// RC signal strength
    pub rc_signal: Vec<Option<i32>>,
    /// RC uplink signal strength
    pub rc_uplink: Vec<Option<i32>>,
    /// RC downlink signal strength
    pub rc_downlink: Vec<Option<i32>>,
    /// Pitch angle
    pub pitch: Vec<Option<f64>>,
    /// Roll angle
    pub roll: Vec<Option<f64>>,
    /// Yaw/Heading
    pub yaw: Vec<Option<f64>>,
    /// Gimbal pitch angle
    pub gimbal_pitch: Vec<Option<f64>>,
    /// Gimbal roll angle
    pub gimbal_roll: Vec<Option<f64>>,
    /// Gimbal yaw/heading
    pub gimbal_yaw: Vec<Option<f64>>,
    /// RC aileron stick input (normalized -100..+100)
    pub rc_aileron: Vec<Option<f64>>,
    /// RC elevator stick input (normalized -100..+100)
    pub rc_elevator: Vec<Option<f64>>,
    /// RC throttle stick input (normalized -100..+100)
    pub rc_throttle: Vec<Option<f64>>,
    /// RC rudder stick input (normalized -100..+100)
    pub rc_rudder: Vec<Option<f64>>,
    /// Photo capture indicator (true when taking photo)
    pub is_photo: Vec<Option<bool>>,
    /// Video recording indicator (true when recording)
    pub is_video: Vec<Option<bool>>,
    /// Flight mode (e.g., "GPS", "ATTI", "Sport")
    pub flight_mode: Vec<Option<String>>,
}

impl TelemetryData {
    /// Create TelemetryData from a vector of TelemetryRecords
    ///
    /// Uses a single pass over the records to build all column vectors
    /// simultaneously, avoiding 20 separate iterator traversals.
    pub fn from_records(records: &[TelemetryRecord]) -> Self {
        let n = records.len();
        let base_time = records.first().map(|r| r.timestamp_ms).unwrap_or(0);

        let mut time = Vec::with_capacity(n);
        let mut latitude = Vec::with_capacity(n);
        let mut longitude = Vec::with_capacity(n);
        let mut altitude = Vec::with_capacity(n);
        let mut height = Vec::with_capacity(n);
        let mut vps_height = Vec::with_capacity(n);
        let mut speed = Vec::with_capacity(n);
        let mut velocity_x = Vec::with_capacity(n);
        let mut velocity_y = Vec::with_capacity(n);
        let mut velocity_z = Vec::with_capacity(n);
        let mut battery = Vec::with_capacity(n);
        let mut battery_voltage = Vec::with_capacity(n);
        let mut battery_temp = Vec::with_capacity(n);
        let mut battery_current = Vec::with_capacity(n);
        let mut battery_full_capacity = Vec::with_capacity(n);
        let mut battery_remained_capacity = Vec::with_capacity(n);
        let mut cell_voltages = Vec::with_capacity(n);
        let mut satellites = Vec::with_capacity(n);
        let mut rc_signal = Vec::with_capacity(n);
        let mut rc_uplink = Vec::with_capacity(n);
        let mut rc_downlink = Vec::with_capacity(n);
        let mut pitch = Vec::with_capacity(n);
        let mut roll = Vec::with_capacity(n);
        let mut yaw = Vec::with_capacity(n);
        let mut gimbal_pitch = Vec::with_capacity(n);
        let mut gimbal_roll = Vec::with_capacity(n);
        let mut gimbal_yaw = Vec::with_capacity(n);
        let mut rc_aileron = Vec::with_capacity(n);
        let mut rc_elevator = Vec::with_capacity(n);
        let mut rc_throttle = Vec::with_capacity(n);
        let mut rc_rudder = Vec::with_capacity(n);
        let mut is_photo = Vec::with_capacity(n);
        let mut is_video = Vec::with_capacity(n);
        let mut flight_mode = Vec::with_capacity(n);

        for r in records {
            time.push((r.timestamp_ms - base_time) as f64 / 1000.0);
            latitude.push(r.latitude);
            longitude.push(r.longitude);
            altitude.push(r.altitude);
            height.push(r.height);
            vps_height.push(r.vps_height);
            speed.push(r.speed);
            velocity_x.push(r.velocity_x);
            velocity_y.push(r.velocity_y);
            velocity_z.push(r.velocity_z);
            battery.push(r.battery_percent);
            battery_voltage.push(r.battery_voltage);
            battery_temp.push(r.battery_temp);
            battery_current.push(r.battery_current);
            battery_full_capacity.push(r.battery_full_capacity);
            battery_remained_capacity.push(r.battery_remained_capacity);
            cell_voltages.push(r.cell_voltages.clone());
            satellites.push(r.satellites);
            rc_signal.push(r.rc_signal);
            rc_uplink.push(r.rc_uplink);
            rc_downlink.push(r.rc_downlink);
            pitch.push(r.pitch);
            roll.push(r.roll);
            yaw.push(r.yaw);
            gimbal_pitch.push(r.gimbal_pitch);
            gimbal_roll.push(r.gimbal_roll);
            gimbal_yaw.push(r.gimbal_yaw);
            rc_aileron.push(r.rc_aileron);
            rc_elevator.push(r.rc_elevator);
            rc_throttle.push(r.rc_throttle);
            rc_rudder.push(r.rc_rudder);
            is_photo.push(r.is_photo);
            is_video.push(r.is_video);
            flight_mode.push(r.flight_mode.clone());
        }

        Self {
            time,
            latitude,
            longitude,
            altitude,
            height,
            vps_height,
            speed,
            velocity_x,
            velocity_y,
            velocity_z,
            battery,
            battery_voltage,
            battery_temp,
            battery_current,
            battery_full_capacity,
            battery_remained_capacity,
            cell_voltages,
            satellites,
            rc_signal,
            rc_uplink,
            rc_downlink,
            pitch,
            roll,
            yaw,
            gimbal_pitch,
            gimbal_roll,
            gimbal_yaw,
            rc_aileron,
            rc_elevator,
            rc_throttle,
            rc_rudder,
            is_photo,
            is_video,
            flight_mode,
        }
    }

    /// Extract a GPS track from the telemetry data for map visualization.
    ///
    /// Filters out null/zero coordinates and downsamples to `max_points`
    /// using uniform stride. Returns `[lng, lat, height]` triples.
    pub fn extract_track(&self, max_points: usize) -> Vec<[f64; 3]> {
        // Collect valid GPS points
        let valid: Vec<[f64; 3]> = self
            .latitude
            .iter()
            .zip(self.longitude.iter())
            .zip(
                self.height
                    .iter()
                    .zip(self.vps_height.iter().zip(self.altitude.iter())),
            )
            .filter_map(|((lat, lng), (h, (vps, alt)))| {
                let lat_v = (*lat)?;
                let lng_v = (*lng)?;
                // Skip 0,0 points
                if lat_v.abs() < 0.000001 && lng_v.abs() < 0.000001 {
                    return None;
                }
                let height_v = h.or(*vps).or(*alt).unwrap_or(0.0);
                Some([lng_v, lat_v, height_v])
            })
            .collect();

        if valid.len() <= max_points {
            return valid;
        }

        // Downsample with uniform stride
        let stride = valid.len() / max_points;
        valid.into_iter().step_by(stride.max(1)).collect()
    }
}

/// Count photo and video capture events from telemetry points.
/// Photos are counted as false→true transitions in `is_photo`.
/// Videos are counted as false→true transitions in `is_video`.
/// Returns (photo_count, video_count).
pub fn count_media_events(points: &[TelemetryPoint]) -> (i32, i32) {
    let mut photo_count = 0i32;
    let mut video_count = 0i32;
    let mut was_photo = false;
    let mut was_video = false;

    for p in points {
        let is_photo = p.is_photo.unwrap_or(false);
        let is_video = p.is_video.unwrap_or(false);

        if is_photo && !was_photo {
            photo_count += 1;
        }
        if is_video && !was_video {
            video_count += 1;
        }

        was_photo = is_photo;
        was_video = is_video;
    }

    (photo_count, video_count)
}

/// Import result returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    pub flight_id: Option<i64>,
    pub message: String,
    pub point_count: usize,
    pub file_hash: Option<String>,
}

/// Statistics for a flight
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightStats {
    pub duration_secs: f64,
    pub total_distance_m: f64,
    pub max_altitude_m: f64,
    pub max_speed_ms: f64,
    pub avg_speed_ms: f64,
    pub min_battery: i32,
    pub home_location: Option<[f64; 2]>,
    pub max_distance_from_home_m: f64,
    pub start_battery_percent: Option<i32>,
    pub end_battery_percent: Option<i32>,
    pub start_battery_temp: Option<f64>,
}

// ============================================================================
// Conversion helpers
// ============================================================================

/// Parse a start_time string (as stored in the Flight DB record) into a
/// `DateTime<Utc>`.  Tries RFC 3339 first, then falls back to common
/// NaiveDateTime formats.
pub fn parse_flight_start_time(s: Option<&str>) -> Option<DateTime<Utc>> {
    let s = s?;
    // Try RFC 3339 (e.g. "2024-06-15T14:30:00Z")
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // Try NaiveDateTime formats coming from the database
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(ndt.and_utc());
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f") {
        return Some(ndt.and_utc());
    }
    None
}

/// Build a `FlightMetadata` from a persisted `Flight` record.
/// Used by smart-tag regeneration endpoints to avoid duplicating the
/// conversion logic.
impl From<&Flight> for FlightMetadata {
    fn from(flight: &Flight) -> Self {
        FlightMetadata {
            id: flight.id,
            file_name: flight.file_name.clone(),
            display_name: flight.display_name.clone(),
            file_hash: None,
            drone_model: flight.drone_model.clone(),
            drone_serial: flight.drone_serial.clone(),
            aircraft_name: flight.aircraft_name.clone(),
            battery_serial: flight.battery_serial.clone(),
            cycle_count: flight.cycle_count,
            rc_serial: flight.rc_serial.clone(),
            battery_life: flight.battery_life,
            start_time: parse_flight_start_time(flight.start_time.as_deref()),
            end_time: None,
            duration_secs: flight.duration_secs,
            total_distance: flight.total_distance,
            max_altitude: flight.max_altitude,
            max_speed: flight.max_speed,
            home_lat: flight.home_lat,
            home_lon: flight.home_lon,
            point_count: flight.point_count.unwrap_or(0),
            photo_count: flight.photo_count.unwrap_or(0),
            video_count: flight.video_count.unwrap_or(0),
        }
    }
}

// ============================================================================
// Profile config helpers
// ============================================================================

/// Load a profile's JSON config file, returning an empty object if the file
/// does not exist or cannot be parsed.
pub fn load_profile_config(config_path: &std::path::Path) -> serde_json::Value {
    if config_path.exists() {
        match std::fs::read_to_string(config_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(config) => config,
                Err(e) => {
                    log::warn!(
                        "Malformed profile config at {}: {}. Falling back to empty config.",
                        config_path.display(),
                        e
                    );
                    serde_json::json!({})
                }
            },
            Err(_) => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    }
}

/// Persist a profile's JSON config, creating parent directories if needed.
pub fn save_profile_config(
    config_path: &std::path::Path,
    config: &serde_json::Value,
) -> Result<(), String> {
    std::fs::write(config_path, serde_json::to_string_pretty(config).unwrap())
        .map_err(|e| format!("Failed to write config: {}", e))
}
