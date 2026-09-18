//! Parser module for DJI flight log files.
//!
//! Handles:
//! - Parsing various DJI log formats using dji-log-parser
//! - Extracting telemetry data points
//! - File hash calculation for duplicate detection
//! - V13+ encrypted log handling with API key fetching
//! - Panic/timeout protection for untrusted file parsing

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::panic;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc, Timelike};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::time::timeout;

use dji_log_parser::frame::{records_to_frames, Frame};
use dji_log_parser::layout::auxiliary::Department;
use dji_log_parser::layout::details::ProductType;
use dji_log_parser::record::component_serial::ComponentType;
use dji_log_parser::record::smart_battery_group::SmartBatteryGroup;
use dji_log_parser::record::Record;
use dji_log_parser::DJILog;

use crate::api::DjiApi;
use crate::database::Database;
use crate::airdata_parser::AirdataParser;
use crate::dronelogbook_parser::DroneLogbookParser;
use crate::litchi_parser::LitchiParser;
use crate::models::{FlightMessage, FlightMetadata, FlightStats, TelemetryPoint};

/// Maximum time allowed for parsing a single log file (seconds)
const PARSE_TIMEOUT_SECS: u64 = 40;

/// Reject GPS points that imply impossible jumps.
const MAX_GPS_JUMP_DISTANCE_M: f64 = 1_500.0;
const MAX_GPS_JUMP_SPEED_MPS: f64 = 120.0;
/// Hard cap for plausible distance from home for DJI log telemetry points.
const MAX_DISTANCE_FROM_HOME_M: f64 = 50_000.0;
/// Hard cap for plausible jump distance between consecutive accepted GPS points.
const MAX_GPS_STEP_DISTANCE_M: f64 = 50000.0;
/// Pack battery voltage above this is considered invalid for these DJI logs.
const MAX_BATTERY_VOLTAGE_V: f64 = 30.0;

/// Full-length serial numbers extracted from ComponentSerial records.
/// The details header in DJI logs truncates serials to 16 bytes, but
/// Enterprise drones (e.g. Mavic 3 Enterprise) have 20-character SNs.
/// ComponentSerial records store the complete serial with a length prefix.
#[derive(Debug, Default, Clone)]
struct ComponentSerials {
    aircraft: Option<String>,
    battery: Option<String>,
    rc: Option<String>,
    /// Battery cycle count extracted from SmartBatteryStatic.loop_times (divided by 256)
    cycle_count: Option<i32>,
    /// Battery life percentage from SmartBatteryStatic
    battery_life: Option<i32>,
}

/// Scan raw records for ComponentSerial entries and return full-length serials.
fn extract_component_serials(records: &[Record]) -> ComponentSerials {
    let mut result = ComponentSerials::default();
    for record in records {
        if let Record::ComponentSerial(ref cs) = record {
            let sn = cs.serial.trim().to_uppercase();
            if sn.is_empty() {
                continue;
            }
            match cs.component_type {
                ComponentType::Aircraft => {
                    log::debug!("ComponentSerial: Aircraft SN = {} ({} chars)", sn, sn.len());
                    result.aircraft = Some(sn);
                }
                ComponentType::Battery => {
                    log::debug!("ComponentSerial: Battery SN = {} ({} chars)", sn, sn.len());
                    result.battery = Some(sn);
                }
                ComponentType::RC => {
                    log::debug!("ComponentSerial: RC SN = {} ({} chars)", sn, sn.len());
                    result.rc = Some(sn);
                }
                _ => {}
            }
        }
        // Extract cycle count from SmartBatteryStatic records
        if let Record::SmartBatteryGroup(SmartBatteryGroup::SmartBatteryStatic(ref sbs)) = record {
            let raw = sbs.loop_times as i32;
            let normalized = raw / 256;
            if normalized > 0 {
                log::debug!("SmartBatteryStatic: loop_times={} -> cycle_count={}", raw, normalized);
                // Keep the maximum cycle count seen across all SmartBatteryStatic records
                result.cycle_count = Some(
                    result.cycle_count.map_or(normalized, |prev| prev.max(normalized))
                );
            }
            // Extract battery life from SmartBatteryStatic
            let battery_life_val = sbs.battery_life as i32;
            if battery_life_val > 0 {
                log::debug!("SmartBatteryStatic: battery_life={}", battery_life_val);
                result.battery_life = Some(
                    result.battery_life.map_or(battery_life_val, |prev| prev.min(battery_life_val))
                );
            }
        }
    }
    result
}

#[derive(Error, Debug)]
pub enum ParserError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("File already imported (matches: {0})")]
    AlreadyImported(String),

    #[error("No valid telemetry data found")]
    NoTelemetryData,

    #[error("Encryption key required for V13+ logs")]
    EncryptionKeyRequired,

    #[error("API error: {0}")]
    Api(String),

    #[error("Parser crashed on this file (internal panic)")]
    Panic(String),

    #[error("Parsing timed out after {0} seconds — file may be corrupt or unsupported")]
    Timeout(u64),

    #[error("Incompatible file format — only DJI flight logs (.txt), Litchi CSV exports, Airdata CSV exports, and Open DroneLog CSV exports are supported")]
    IncompatibleFile,
}

/// Result of parsing a DJI log file
pub struct ParseResult {
    pub metadata: FlightMetadata,
    pub points: Vec<TelemetryPoint>,
    pub tags: Vec<String>,
    /// Manual tags to preserve from re-imported CSV exports (inserted with 'manual' type)
    pub manual_tags: Vec<String>,
    /// Notes to preserve from re-imported CSV exports
    pub notes: Option<String>,
    /// Color label to preserve from re-imported CSV exports
    pub color: Option<String>,
    /// App messages (tips and warnings) from the flight log
    pub messages: Vec<FlightMessage>,
}

/// DJI Log Parser wrapper
pub struct LogParser<'a> {
    db: &'a Database,
    api: DjiApi,
}

impl<'a> LogParser<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self {
            db,
            api: DjiApi::with_app_data_dir(db.data_dir.clone()),
        }
    }

    /// Calculate SHA256 hash of a file for duplicate detection
    pub fn calculate_file_hash(path: &Path) -> Result<String, ParserError> {
        let file = File::open(path)?;
        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];

        loop {
            let bytes_read = reader.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
        }

        Ok(format!("{:x}", hasher.finalize()))
    }

    /// Parse a flight log file (DJI .txt or Litchi .csv) and extract all telemetry data
    pub async fn parse_log(&self, file_path: &Path) -> Result<ParseResult, ParserError> {
        let parse_start = std::time::Instant::now();
        let file_size = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
        log::info!(
            "Parsing log file: {:?} (size: {:.1} KB)",
            file_path,
            file_size as f64 / 1024.0
        );

        // Calculate file hash to check for duplicates
        let file_hash = Self::calculate_file_hash(file_path)?;
        log::debug!("File hash: {}", file_hash);

        if let Some(matching_flight) = self
            .db
            .is_file_imported(&file_hash)
            .map_err(|e| ParserError::Parse(e.to_string()))?
        {
            log::info!("File already imported (hash match), skipping — matches flight: {}", matching_flight);
            return Err(ParserError::AlreadyImported(matching_flight));
        }

        // Detect file format and route to appropriate parser
        let builtin_err;

        // Try built-in CSV parsers first
        if DroneLogbookParser::is_dronelogbook_csv(file_path) {
            log::info!("Detected Open DroneLog CSV format, using DroneLogbookParser");
            match DroneLogbookParser::new(self.db).parse(file_path, &file_hash) {
                Ok(res) => return Ok(res),
                Err(e) => builtin_err = e,
            }
        } else if AirdataParser::is_airdata_csv(file_path) {
            log::info!("Detected Airdata CSV format, using AirdataParser");
            match AirdataParser::new(self.db).parse(file_path, &file_hash) {
                Ok(res) => return Ok(res),
                Err(e) => builtin_err = e,
            }
        } else if LitchiParser::is_litchi_csv(file_path) {
            log::info!("Detected Litchi CSV format, using LitchiParser");
            match LitchiParser::new(self.db).parse(file_path, &file_hash) {
                Ok(res) => return Ok(res),
                Err(e) => builtin_err = e,
            }
        } else {
            let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext.eq_ignore_ascii_case("txt") {
                // Try DJI log parser
                match self.parse_dji_txt(file_path, &file_hash, parse_start).await {
                    Ok(res) => return Ok(res),
                    Err(e) => builtin_err = e,
                }
            } else {
                builtin_err = ParserError::IncompatibleFile;
            }
        }

        // Custom Plugin Fallback
        let err = builtin_err;
        log::info!("Built-in parser failed or incompatible: {}. Trying custom plugins...", err);
        let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        log::debug!("Custom plugin lookup for extension: '.{}'", ext);

        if let Some(config) = crate::plugins::get_plugin_config(&self.db.data_dir) {
            let available_mappings: Vec<String> = config
                .mappings
                .keys()
                .map(|k| k.trim().trim_start_matches('.').to_ascii_lowercase())
                .collect();
            log::debug!("Custom parser mappings available: {:?}", available_mappings);

            let matched = config
                .mappings
                .iter()
                .find(|(key, _)| key.trim().trim_start_matches('.').eq_ignore_ascii_case(&ext));

            if let Some((matched_key, mapping)) = matched {
                log::info!(
                    "Found custom parser mapping for '.{}' (key '{}'): command='{}' args={:?}",
                    ext,
                    matched_key,
                    mapping.command,
                    mapping.args
                );

                let temp_dir = std::env::temp_dir();
                let output_csv = temp_dir.join(format!("{}_plugin_out.csv", uuid::Uuid::new_v4()));
                log::debug!("Custom parser output temp path: {:?}", output_csv);

                if let Err(plugin_err) = crate::plugins::run_plugin(mapping, file_path, &output_csv).await {
                    log::error!(
                        "Custom parser subprocess failed for extension '.{}': {}",
                        ext,
                        plugin_err
                    );
                    return Err(err); // Return original built-in error
                }

                if !output_csv.exists() {
                    log::error!(
                        "Custom parser reported success but no output CSV was found at {:?}",
                        output_csv
                    );
                    return Err(err);
                }

                let output_size = fs::metadata(&output_csv).map(|m| m.len()).unwrap_or(0);
                log::info!(
                    "Custom parser produced output CSV: {:?} (size: {} bytes)",
                    output_csv,
                    output_size
                );

                // On success, parse the resulting CSV using DroneLogbookParser
                let drone_parser = DroneLogbookParser::new(self.db);
                let result = drone_parser.parse(&output_csv, &file_hash);
                let _ = fs::remove_file(&output_csv); // Clean up temp file

                match result {
                    Ok(res) => {
                        log::info!("Custom parser fallback succeeded for '.{}'", ext);
                        return Ok(res);
                    }
                    Err(e) => {
                        log::error!("Failed to parse custom plugin output CSV: {}", e);
                        return Err(err); // Return original built-in error
                    }
                }
            } else {
                log::info!(
                    "No custom parser mapping matched extension '.{}' (available mappings: {:?})",
                    ext,
                    available_mappings
                );
            }
        } else {
            log::info!(
                "No valid custom parser config available while handling extension '.{}'",
                ext
            );
        }
        Err(err)
    }

    /// Parse a DJI TXT log file
    async fn parse_dji_txt(&self, file_path: &Path, file_hash: &str, parse_start: std::time::Instant) -> Result<ParseResult, ParserError> {
        // Read the file
        let file_data = fs::read(file_path)?;

        // Parse with dji-log-parser inside spawn_blocking + catch_unwind
        // This prevents a panicking/hanging parser from killing the app
        let parser = {
            let data = file_data;
            let result = timeout(
                Duration::from_secs(PARSE_TIMEOUT_SECS),
                tokio::task::spawn_blocking(move || {
                    panic::catch_unwind(panic::AssertUnwindSafe(|| {
                        DJILog::from_bytes(data)
                    }))
                }),
            )
            .await;

            match result {
                Err(_) => return Err(ParserError::Timeout(PARSE_TIMEOUT_SECS)),
                Ok(Err(join_err)) => return Err(ParserError::Panic(format!("Task join error: {}", join_err))),
                Ok(Ok(Err(panic_val))) => {
                    let msg = panic_val
                        .downcast_ref::<String>()
                        .map(|s| s.clone())
                        .or_else(|| panic_val.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "unknown panic".to_string());
                    return Err(ParserError::Panic(msg));
                }
                Ok(Ok(Ok(parse_result))) => {
                    parse_result.map_err(|e| ParserError::Parse(e.to_string()))?
                }
            }
        };

        log::debug!(
            "DJI Parser: version={}, product={:?}, aircraft_sn={}, aircraft_name={}",
            parser.version,
            parser.details.product_type,
            parser.details.aircraft_sn,
            parser.details.aircraft_name,
        );

        // Check if we need an encryption key for V13+ logs
        let (frames, used_djifly_fallback, component_serials) = self.get_frames(&parser, file_hash).await?;
        log::info!("Extracted {} frames from log", frames.len());

        // Log when ComponentSerial provides a longer serial than the header
        if let Some(ref full_sn) = component_serials.aircraft {
            if full_sn.len() > parser.details.aircraft_sn.trim().len() {
                log::info!(
                    "ComponentSerial override: aircraft_sn '{}' ({} chars) -> '{}' ({} chars)",
                    parser.details.aircraft_sn.trim(), parser.details.aircraft_sn.trim().len(),
                    full_sn, full_sn.len()
                );
            }
        }
        if let Some(ref full_sn) = component_serials.battery {
            if full_sn.len() > parser.details.battery_sn.trim().len() {
                log::info!(
                    "ComponentSerial override: battery_sn '{}' ({} chars) -> '{}' ({} chars)",
                    parser.details.battery_sn.trim(), parser.details.battery_sn.trim().len(),
                    full_sn, full_sn.len()
                );
            }
        }

        if frames.is_empty() {
            log::warn!("No frames extracted from log file — file may be empty or corrupt");
            return Err(ParserError::NoTelemetryData);
        }

        // Extract telemetry points
        let details_total_time_secs = parser.details.total_time as f64;
        let points = self.extract_telemetry(&frames, details_total_time_secs);
        log::info!(
            "Extracted {} valid telemetry points from {} frames ({} skipped)",
            points.len(),
            frames.len(),
            frames.len() - points.len()
        );

        // Extract app messages (tips and warnings)
        let messages = self.extract_messages(&frames, details_total_time_secs);
        log::info!("Extracted {} app messages from log", messages.len());

        if points.is_empty() {
            log::warn!("No valid telemetry points after filtering — all frames had corrupt/missing data");
            return Err(ParserError::NoTelemetryData);
        }

        // Calculate statistics
        let stats = self.calculate_stats(&points);

        // Build metadata
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

        // Count photo and video capture events from telemetry transitions
        let (photo_count, video_count) = crate::models::count_media_events(&points);

        let metadata = FlightMetadata {
            id: self.db.generate_flight_id(),
            file_name,
            display_name,
            file_hash: Some(file_hash.to_string()),
            drone_model: self.extract_drone_model(&parser),
            drone_serial: component_serials.aircraft.clone()
                .or_else(|| self.extract_serial(&parser)),
            aircraft_name: self.extract_aircraft_name(&parser),
            battery_serial: component_serials.battery.clone()
                .or_else(|| self.extract_battery_serial(&parser)),
            cycle_count: component_serials.cycle_count,
            start_time: self.extract_start_time(&parser),
            end_time: self.extract_end_time(&parser),
            duration_secs: Some(
                if details_total_time_secs > 0.0 {
                    details_total_time_secs
                } else {
                    stats.duration_secs
                }
            ),
            total_distance: Some(stats.total_distance_m),
            max_altitude: Some(stats.max_altitude_m),
            max_speed: Some(stats.max_speed_ms),
            home_lat: stats.home_location.map(|h| h[1]),
            home_lon: stats.home_location.map(|h| h[0]),
            point_count: points.len() as i32,
            photo_count,
            video_count,
            rc_serial: component_serials.rc.clone()
                .or_else(|| {
                    let sn = parser.details.rc_sn.trim().to_uppercase();
                    if sn.is_empty() { None } else { Some(sn) }
                }),
            battery_life: component_serials.battery_life,
        };

        log::info!(
            "Parse complete in {:.1}s: duration={:.1}s, distance={:.0}m, max_alt={:.1}m, max_speed={:.1}m/s, home={:?}, points={}",
            parse_start.elapsed().as_secs_f64(),
            stats.duration_secs,
            stats.total_distance_m,
            stats.max_altitude_m,
            stats.max_speed_ms,
            stats.home_location,
            points.len()
        );

        // Generate smart tags based on flight characteristics
        let mut tags = Self::generate_smart_tags(&metadata, &stats);
        
        // Add M-SDK tag if DJIFly department override was used (third-party app like Dronelink/DroneDeploy)
        if used_djifly_fallback {
            tags.push("M-SDK".to_string());
            log::info!("Added M-SDK tag (third-party app detected via DJIFly fallback)");
        }
        
        log::info!("Generated smart tags: {:?}", tags);

        Ok(ParseResult { metadata, points, tags, manual_tags: Vec::new(), notes: None, color: None, messages })

    }

    /// Generate smart tags based on flight metadata and statistics
    pub fn generate_smart_tags(metadata: &FlightMetadata, stats: &FlightStats) -> Vec<String> {
        let mut tags = Vec::new();

        // Night Flight: if local flying time is after 7 PM (19:00) or before 6 AM
        if let Some(start_time) = metadata.start_time {
            // Use home location to estimate timezone offset (rough: 1 hour per 15° longitude)
            let utc_hour = start_time.hour();
            let tz_offset_hours = if let Some(home) = stats.home_location {
                (home[0] / 15.0).round() as i32 // lon / 15 = approx TZ offset
            } else {
                0
            };
            let local_hour = ((utc_hour as i32 + tz_offset_hours) % 24 + 24) % 24;
            if local_hour >= 19 || local_hour < 6 {
                tags.push("Night Flight".to_string());
            }
        }

        // High Speed: max speed exceeds 15 m/s
        if stats.max_speed_ms > 15.0 {
            tags.push("High Speed".to_string());
        }

        // Cold Battery: start temperature below 15°C
        if let Some(temp) = stats.start_battery_temp {
            if temp < 15.0 {
                tags.push("Cold Battery".to_string());
            }
        }

        // Heavy Load: battery consumption > 75% but flight time < 20 minutes
        if let (Some(start_pct), Some(end_pct)) = (stats.start_battery_percent, stats.end_battery_percent) {
            let consumption = start_pct - end_pct;
            if consumption > 75 && stats.duration_secs < 1200.0 {
                tags.push("Heavy Load".to_string());
            }
        }

        // Low Battery: battery level dropped below 15% at end of flight
        if let Some(end_pct) = stats.end_battery_percent {
            if end_pct < 15 {
                tags.push("Low Battery".to_string());
            }
        }

        // High Altitude: max height above 120 meters
        if stats.max_altitude_m > 120.0 {
            tags.push("High Altitude".to_string());
        }

        // Long Distance: max distance from home > 1 km
        if stats.max_distance_from_home_m > 1000.0 {
            tags.push("Long Distance".to_string());
        }

        // Long Flight: duration > 25 minutes
        if stats.duration_secs > 1500.0 {
            tags.push("Long Flight".to_string());
        }

        // Short Flight: duration < 2 minutes (likely test/calibration)
        if stats.duration_secs > 0.0 && stats.duration_secs < 120.0 {
            tags.push("Short Flight".to_string());
        }

        // Aggressive Flying: high average speed (> 8 m/s)
        if stats.avg_speed_ms > 8.0 {
            tags.push("Aggressive Flying".to_string());
        }

        // Minimal GPS: very few GPS points relative to total points
        // (Detected from home location absence)
        if stats.home_location.is_none() {
            tags.push("No GPS".to_string());
        }

        // Reverse geocoding: derive city, country, and continent from home coordinates
        if let Some(home) = stats.home_location {
            let lat = home[1];
            let lon = home[0];
            let location_tags = Self::reverse_geocode(lat, lon);
            for tag in location_tags {
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }

        tags
    }

    /// Filter smart tags based on enabled tag type IDs.
    /// Tag type IDs map to specific generated tag names.
    pub fn filter_smart_tags(tags: Vec<String>, enabled_types: &[String]) -> Vec<String> {
        // If no filter provided or empty, return all tags
        if enabled_types.is_empty() {
            return tags;
        }

        // Map of tag type IDs to the actual tag name patterns
        let type_to_tag: std::collections::HashMap<&str, &str> = [
            ("night_flight", "Night Flight"),
            ("high_speed", "High Speed"),
            ("cold_battery", "Cold Battery"),
            ("heavy_load", "Heavy Load"),
            ("low_battery", "Low Battery"),
            ("high_altitude", "High Altitude"),
            ("long_distance", "Long Distance"),
            ("long_flight", "Long Flight"),
            ("short_flight", "Short Flight"),
            ("aggressive_flying", "Aggressive Flying"),
            ("no_gps", "No GPS"),
        ].into_iter().collect();

        // Collect enabled tag names and check if location tags are enabled
        let enabled_tag_names: std::collections::HashSet<&str> = enabled_types
            .iter()
            .filter_map(|t| type_to_tag.get(t.as_str()).copied())
            .collect();
        let country_enabled = enabled_types.iter().any(|t| t == "country");
        let continent_enabled = enabled_types.iter().any(|t| t == "continent");

        // List of all continents for filtering
        let continents: std::collections::HashSet<&str> = [
            "Africa", "Antarctica", "Asia", "Europe", 
            "North America", "Oceania", "South America"
        ].into_iter().collect();

        tags.into_iter()
            .filter(|tag| {
                // Check if it's a standard tag type
                if enabled_tag_names.contains(tag.as_str()) {
                    return true;
                }
                // Check if it's a continent tag
                if continents.contains(tag.as_str()) {
                    return continent_enabled;
                }
                // Otherwise it's a country tag (any tag not matching above patterns)
                // Note: Standard tags we know about are already handled above
                let is_standard_tag = type_to_tag.values().any(|&v| v == tag.as_str());
                if !is_standard_tag && !continents.contains(tag.as_str()) {
                    return country_enabled;
                }
                false
            })
            .collect()
    }

    /// Offline reverse geocoding using the `reverse_geocoder` crate.
    /// Returns location tags for country and continent only.
    /// Note: We skip the city/name field as GeoNames data often returns small towns,
    /// suburbs, or other local names that may not be meaningful or accurate.
    pub fn reverse_geocode(lat: f64, lon: f64) -> Vec<String> {
        // Skip invalid coordinates
        if lat.abs() < 0.001 && lon.abs() < 0.001 {
            return Vec::new();
        }

        let geocoder = reverse_geocoder::ReverseGeocoder::new();
        let result = geocoder.search((lat, lon));
        let record = result.record;

        let mut tags = Vec::new();

        // Country from 2-letter country code
        if let Some(country) = Self::country_from_cc(&record.cc) {
            tags.push(country.to_string());
        }

        // Continent from country code
        if let Some(continent) = Self::continent_from_cc(&record.cc) {
            tags.push(continent.to_string());
        }

        tags
    }

    /// Map ISO 3166-1 alpha-2 country code to country name.
    fn country_from_cc(cc: &str) -> Option<&'static str> {
        match cc {
            "AD" => Some("Andorra"), "AE" => Some("UAE"), "AF" => Some("Afghanistan"),
            "AG" => Some("Antigua and Barbuda"), "AI" => Some("Anguilla"), "AL" => Some("Albania"),
            "AM" => Some("Armenia"), "AO" => Some("Angola"), "AQ" => Some("Antarctica"),
            "AR" => Some("Argentina"), "AS" => Some("American Samoa"), "AT" => Some("Austria"),
            "AU" => Some("Australia"), "AW" => Some("Aruba"), "AZ" => Some("Azerbaijan"),
            "BA" => Some("Bosnia and Herzegovina"), "BB" => Some("Barbados"), "BD" => Some("Bangladesh"),
            "BE" => Some("Belgium"), "BF" => Some("Burkina Faso"), "BG" => Some("Bulgaria"),
            "BH" => Some("Bahrain"), "BI" => Some("Burundi"), "BJ" => Some("Benin"),
            "BM" => Some("Bermuda"), "BN" => Some("Brunei"), "BO" => Some("Bolivia"),
            "BR" => Some("Brazil"), "BS" => Some("Bahamas"), "BT" => Some("Bhutan"),
            "BW" => Some("Botswana"), "BY" => Some("Belarus"), "BZ" => Some("Belize"),
            "CA" => Some("Canada"), "CD" => Some("DR Congo"), "CF" => Some("Central African Republic"),
            "CG" => Some("Congo"), "CH" => Some("Switzerland"), "CI" => Some("Ivory Coast"),
            "CL" => Some("Chile"), "CM" => Some("Cameroon"), "CN" => Some("China"),
            "CO" => Some("Colombia"), "CR" => Some("Costa Rica"), "CU" => Some("Cuba"),
            "CV" => Some("Cape Verde"), "CW" => Some("Curaçao"), "CY" => Some("Cyprus"),
            "CZ" => Some("Czech Republic"), "DE" => Some("Germany"), "DJ" => Some("Djibouti"),
            "DK" => Some("Denmark"), "DM" => Some("Dominica"), "DO" => Some("Dominican Republic"),
            "DZ" => Some("Algeria"), "EC" => Some("Ecuador"), "EE" => Some("Estonia"),
            "EG" => Some("Egypt"), "ER" => Some("Eritrea"), "ES" => Some("Spain"),
            "ET" => Some("Ethiopia"), "FI" => Some("Finland"), "FJ" => Some("Fiji"),
            "FK" => Some("Falkland Islands"), "FM" => Some("Micronesia"), "FO" => Some("Faroe Islands"),
            "FR" => Some("France"), "GA" => Some("Gabon"), "GB" => Some("United Kingdom"),
            "GD" => Some("Grenada"), "GE" => Some("Georgia"), "GF" => Some("French Guiana"),
            "GG" => Some("Guernsey"), "GH" => Some("Ghana"), "GI" => Some("Gibraltar"),
            "GL" => Some("Greenland"), "GM" => Some("Gambia"), "GN" => Some("Guinea"),
            "GP" => Some("Guadeloupe"), "GQ" => Some("Equatorial Guinea"), "GR" => Some("Greece"),
            "GT" => Some("Guatemala"), "GU" => Some("Guam"), "GW" => Some("Guinea-Bissau"),
            "GY" => Some("Guyana"), "HK" => Some("Hong Kong"), "HN" => Some("Honduras"),
            "HR" => Some("Croatia"), "HT" => Some("Haiti"), "HU" => Some("Hungary"),
            "ID" => Some("Indonesia"), "IE" => Some("Ireland"), "IL" => Some("Israel"),
            "IM" => Some("Isle of Man"), "IN" => Some("India"), "IQ" => Some("Iraq"),
            "IR" => Some("Iran"), "IS" => Some("Iceland"), "IT" => Some("Italy"),
            "JE" => Some("Jersey"), "JM" => Some("Jamaica"), "JO" => Some("Jordan"),
            "JP" => Some("Japan"), "KE" => Some("Kenya"), "KG" => Some("Kyrgyzstan"),
            "KH" => Some("Cambodia"), "KI" => Some("Kiribati"), "KM" => Some("Comoros"),
            "KN" => Some("Saint Kitts and Nevis"), "KP" => Some("North Korea"), "KR" => Some("South Korea"),
            "KW" => Some("Kuwait"), "KY" => Some("Cayman Islands"), "KZ" => Some("Kazakhstan"),
            "LA" => Some("Laos"), "LB" => Some("Lebanon"), "LC" => Some("Saint Lucia"),
            "LI" => Some("Liechtenstein"), "LK" => Some("Sri Lanka"), "LR" => Some("Liberia"),
            "LS" => Some("Lesotho"), "LT" => Some("Lithuania"), "LU" => Some("Luxembourg"),
            "LV" => Some("Latvia"), "LY" => Some("Libya"), "MA" => Some("Morocco"),
            "MC" => Some("Monaco"), "MD" => Some("Moldova"), "ME" => Some("Montenegro"),
            "MG" => Some("Madagascar"), "MH" => Some("Marshall Islands"), "MK" => Some("North Macedonia"),
            "ML" => Some("Mali"), "MM" => Some("Myanmar"), "MN" => Some("Mongolia"),
            "MO" => Some("Macau"), "MQ" => Some("Martinique"), "MR" => Some("Mauritania"),
            "MS" => Some("Montserrat"), "MT" => Some("Malta"), "MU" => Some("Mauritius"),
            "MV" => Some("Maldives"), "MW" => Some("Malawi"), "MX" => Some("Mexico"),
            "MY" => Some("Malaysia"), "MZ" => Some("Mozambique"), "NA" => Some("Namibia"),
            "NC" => Some("New Caledonia"), "NE" => Some("Niger"), "NF" => Some("Norfolk Island"),
            "NG" => Some("Nigeria"), "NI" => Some("Nicaragua"), "NL" => Some("Netherlands"),
            "NO" => Some("Norway"), "NP" => Some("Nepal"), "NR" => Some("Nauru"),
            "NU" => Some("Niue"), "NZ" => Some("New Zealand"), "OM" => Some("Oman"),
            "PA" => Some("Panama"), "PE" => Some("Peru"), "PF" => Some("French Polynesia"),
            "PG" => Some("Papua New Guinea"), "PH" => Some("Philippines"), "PK" => Some("Pakistan"),
            "PL" => Some("Poland"), "PM" => Some("Saint Pierre and Miquelon"), "PR" => Some("Puerto Rico"),
            "PS" => Some("Palestine"), "PT" => Some("Portugal"), "PW" => Some("Palau"),
            "PY" => Some("Paraguay"), "QA" => Some("Qatar"), "RE" => Some("Réunion"),
            "RO" => Some("Romania"), "RS" => Some("Serbia"), "RU" => Some("Russia"),
            "RW" => Some("Rwanda"), "SA" => Some("Saudi Arabia"), "SB" => Some("Solomon Islands"),
            "SC" => Some("Seychelles"), "SD" => Some("Sudan"), "SE" => Some("Sweden"),
            "SG" => Some("Singapore"), "SH" => Some("Saint Helena"), "SI" => Some("Slovenia"),
            "SK" => Some("Slovakia"), "SL" => Some("Sierra Leone"), "SM" => Some("San Marino"),
            "SN" => Some("Senegal"), "SO" => Some("Somalia"), "SR" => Some("Suriname"),
            "SS" => Some("South Sudan"), "ST" => Some("São Tomé and Príncipe"), "SV" => Some("El Salvador"),
            "SX" => Some("Sint Maarten"), "SY" => Some("Syria"), "SZ" => Some("Eswatini"),
            "TC" => Some("Turks and Caicos"), "TD" => Some("Chad"), "TG" => Some("Togo"),
            "TH" => Some("Thailand"), "TJ" => Some("Tajikistan"), "TK" => Some("Tokelau"),
            "TL" => Some("Timor-Leste"), "TM" => Some("Turkmenistan"), "TN" => Some("Tunisia"),
            "TO" => Some("Tonga"), "TR" => Some("Turkey"), "TT" => Some("Trinidad and Tobago"),
            "TV" => Some("Tuvalu"), "TW" => Some("Taiwan"), "TZ" => Some("Tanzania"),
            "UA" => Some("Ukraine"), "UG" => Some("Uganda"), "US" => Some("United States"),
            "UY" => Some("Uruguay"), "UZ" => Some("Uzbekistan"), "VA" => Some("Vatican City"),
            "VC" => Some("Saint Vincent"), "VE" => Some("Venezuela"), "VG" => Some("British Virgin Islands"),
            "VI" => Some("US Virgin Islands"), "VN" => Some("Vietnam"), "VU" => Some("Vanuatu"),
            "WF" => Some("Wallis and Futuna"), "WS" => Some("Samoa"), "XK" => Some("Kosovo"),
            "YE" => Some("Yemen"), "YT" => Some("Mayotte"), "ZA" => Some("South Africa"),
            "ZM" => Some("Zambia"), "ZW" => Some("Zimbabwe"),
            _ => None,
        }
    }

    /// Map ISO 3166-1 alpha-2 country code to continent name.
    fn continent_from_cc(cc: &str) -> Option<&'static str> {
        match cc {
            // Europe
            "AD"|"AL"|"AT"|"BA"|"BE"|"BG"|"BY"|"CH"|"CY"|"CZ"|"DE"|"DK"|"EE"|"ES"|"FI"|
            "FO"|"FR"|"GB"|"GE"|"GG"|"GI"|"GR"|"HR"|"HU"|"IE"|"IM"|"IS"|"IT"|"JE"|"LI"|
            "LT"|"LU"|"LV"|"MC"|"MD"|"ME"|"MK"|"MT"|"NL"|"NO"|"PL"|"PT"|"RO"|"RS"|"SE"|
            "SI"|"SK"|"SM"|"UA"|"VA"|"XK" => Some("Europe"),
            // North America
            "AG"|"AI"|"AW"|"BB"|"BM"|"BS"|"BZ"|"CA"|"CR"|"CU"|"CW"|"DM"|"DO"|"GD"|"GL"|
            "GP"|"GT"|"GU"|"HN"|"HT"|"JM"|"KN"|"KY"|"LC"|"MQ"|"MS"|"MX"|"NI"|"PA"|"PM"|
            "PR"|"SV"|"SX"|"TC"|"TT"|"US"|"VC"|"VG"|"VI" => Some("North America"),
            // South America
            "AR"|"BO"|"BR"|"CL"|"CO"|"EC"|"FK"|"GF"|"GY"|"PE"|"PY"|"SR"|"UY"|"VE"
                => Some("South America"),
            // Africa
            "AO"|"BF"|"BI"|"BJ"|"BW"|"CD"|"CF"|"CG"|"CI"|"CM"|"CV"|"DJ"|"DZ"|"EG"|"ER"|
            "ET"|"GA"|"GH"|"GM"|"GN"|"GQ"|"GW"|"KE"|"KM"|"LR"|"LS"|"LY"|"MA"|"MG"|"ML"|
            "MR"|"MU"|"MW"|"MZ"|"NA"|"NE"|"NG"|"RE"|"RW"|"SC"|"SD"|"SH"|"SL"|"SN"|"SO"|
            "SS"|"ST"|"SZ"|"TD"|"TG"|"TN"|"TZ"|"UG"|"YT"|"ZA"|"ZM"|"ZW"
                => Some("Africa"),
            // Asia
            "AE"|"AF"|"AM"|"AZ"|"BD"|"BH"|"BN"|"CN"|"HK"|"ID"|"IL"|"IN"|"IQ"|"IR"|"JO"|
            "JP"|"KG"|"KH"|"KP"|"KR"|"KW"|"KZ"|"LA"|"LB"|"LK"|"MM"|"MN"|"MO"|"MV"|"MY"|
            "NP"|"OM"|"PH"|"PK"|"PS"|"QA"|"RU"|"SA"|"SG"|"SY"|"TH"|"TJ"|"TL"|"TM"|"TR"|
            "TW"|"UZ"|"VN"|"YE" => Some("Asia"),
            // Oceania
            "AS"|"AU"|"FJ"|"FM"|"KI"|"MH"|"NC"|"NF"|"NR"|"NU"|"NZ"|"PF"|"PG"|"PW"|"SB"|
            "TK"|"TO"|"TV"|"VU"|"WF"|"WS" => Some("Oceania"),
            // Antarctica
            "AQ" => Some("Antarctica"),
            _ => None,
        }
    }

    async fn fetch_keychains_reqwest(&self, parser: &DJILog, api_key: &str, department_override: Option<Department>) -> Result<Vec<Vec<dji_log_parser::keychain::KeychainFeaturePoint>>, ParserError> {
        let request = if let Some(dept) = department_override {
            log::debug!("Creating keychain request with department override: {:?}", dept);
            parser.keychains_request_with_custom_params(Some(dept), None)
                .map_err(|e| ParserError::Api(format!("Failed to create keychain request: {}", e)))?
        } else {
            log::debug!("Creating standard keychain request");
            parser.keychains_request()
                .map_err(|e| ParserError::Api(format!("Failed to create keychain request: {}", e)))?
        };

        // reqwest::Client automatically honors HTTP_PROXY and HTTPS_PROXY environment variables
        log::debug!("Building reqwest client for keychain fetch (honors HTTP_PROXY/HTTPS_PROXY)");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| ParserError::Api(format!("Failed to build HTTP client: {}", e)))?;

        let endpoint = "https://dev.dji.com/openapi/v1/flight-records/keychains";

        log::debug!("Connecting to keychain API endpoint: {}", endpoint);
        let response = client.post(endpoint)
            .header("Content-Type", "application/json")
            .header("Api-Key", api_key)
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                log::debug!("Keychain API network request failed: {}", e);
                ParserError::Api(format!("Network request failed: {}", e))
            })?;

        log::debug!("Received response from keychain API: HTTP {}", response.status());

        if !response.status().is_success() {
            if response.status() == 403 {
                log::debug!("Keychain API rejected request: Invalid API Key");
                return Err(ParserError::Api("Invalid API Key".to_string()));
            }
            log::debug!("Keychain API rejected request: HTTP {}", response.status());
            return Err(ParserError::Api(format!("API returned status {}", response.status())));
        }

        log::debug!("Parsing keychain response JSON");
        let keychains_response: dji_log_parser::keychain::KeychainsResponse = response.json().await
            .map_err(|e| {
                log::debug!("Failed to parse keychain response JSON: {}", e);
                ParserError::Api(format!("Failed to parse response: {}", e))
            })?;

        log::debug!("Keychain API result code: {}", keychains_response.result.code);

        if keychains_response.result.code != 0 {
            Err(ParserError::Api(keychains_response.result.msg))
        } else {
            match keychains_response.data {
                Some(data) => {
                    log::debug!("Successfully parsed keychain payload");
                    Ok(data)
                },
                None => {
                    log::debug!("Keychain response was OK but missing data payload");
                    Err(ParserError::Api("Missing keychain data".to_owned()))
                },
            }
        }
    }

    /// Get frames from the parser, handling encryption if needed.
    /// Runs the CPU-bound parsing in spawn_blocking with catch_unwind
    /// to prevent panics from crashing the application.
    /// Returns (frames, used_djifly_fallback) where used_djifly_fallback indicates
    /// if the DJIFly department override was needed (third-party app like Dronelink).
    async fn get_frames(&self, parser: &DJILog, file_hash: &str) -> Result<(Vec<Frame>, bool, ComponentSerials), ParserError> {
        // Version 13+ requires keychains for decryption
        let (keychains, used_djifly_fallback) = if parser.version >= 13 {
            // First check database cache
            match self.db.get_cached_keychain(file_hash) {
                Ok(Some(cached_kc)) => {
                    log::info!("Using cached keychain for log file {}", file_hash);
                    (Some(cached_kc), false)
                }
                _ => {
                    let api_key = self.api.get_api_key().ok_or(ParserError::EncryptionKeyRequired)?;
                    
                    // Try standard keychain fetch first
                    let (kc, used_fallback) = match self.fetch_keychains_reqwest(parser, &api_key, None).await {
                        Ok(kc) => (kc, false),
                        Err(e) => {
                            // Standard fetch failed — try fallback for third-party apps
                            log::warn!("Standard keychain fetch failed: {}. Retrying with DJIFly department override...", e);
                            
                            let fallback_kc = self.fetch_keychains_reqwest(parser, &api_key, Some(Department::DJIFly)).await.map_err(|e| {
                                ParserError::Api(format!("Keychain fetch failed (both standard and DJIFly fallback): {}", e))
                            })?;
                            
                            log::info!("Successfully fetched keychains using DJIFly department override");
                            (fallback_kc, true)
                        }
                    };
                    
                    // Save the successfully fetched keychain to cache
                    if let Err(e) = self.db.save_cached_keychain(file_hash, &kc) {
                        log::warn!("Failed to save fetched keychain to cache: {}", e);
                    }
                    
                    (Some(kc), used_fallback)
                }
            }
        } else {
            (None, false)
        };

        // Clone what we need to move into spawn_blocking
        // DJILog doesn't implement Clone, so we need to use a raw pointer trick
        // Instead, we'll re-read the data inside the blocking task
        // Actually, frames() borrows self, so we need an unsafe approach or restructure.
        // The simplest safe approach: since parser is on the stack, use a scoped approach.
        // We use `unsafe` pointer cast to send the parser ref into spawn_blocking.
        // This is safe because we await the result immediately (parser outlives the task).
        let parser_ptr = parser as *const DJILog as usize;
        let result = timeout(
            Duration::from_secs(PARSE_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || {
                let parser_ref = unsafe { &*(parser_ptr as *const DJILog) };
                panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    // Use records() instead of frames() so we can extract
                    // full-length ComponentSerial data before converting to frames.
                    // The details header truncates serials to 16 bytes, but Enterprise
                    // drones have 20-char serials stored in ComponentSerial records.
                    let mut records = parser_ref.records(keychains)?;
                    let comp_serials = extract_component_serials(&records);
                    
                    // Filter out corrupt SmartBatteryGroup payloads for DJI Mini 2 & Mini 2 SE
                    // which would otherwise overwrite valid SmartBattery (magic byte 8) data
                    match parser_ref.details.product_type {
                        ProductType::Mini2 | ProductType::Mini2SE => {
                            records.retain(|r| !matches!(r, dji_log_parser::record::Record::SmartBatteryGroup(_)));
                        }
                        _ => {}
                    }
                    
                    // Camera records arrive less often than OSD ticks. Preserve their latest
                    // state across frames, including photo state which the library resets.
                    let mut persistent_camera_states = Vec::new();
                    let mut current_is_photo = false;
                    let mut current_is_video = false;
                    let mut osd_count = 0;

                    for record in &records {
                        match record {
                            dji_log_parser::record::Record::Camera(camera) => {
                                current_is_photo = camera.is_shooting_single_photo;
                                current_is_video = camera.is_recording;
                            }
                            dji_log_parser::record::Record::OSD(_) => {
                                if osd_count > 0 {
                                    persistent_camera_states.push((current_is_photo, current_is_video));
                                }
                                osd_count += 1;
                            }
                            _ => {}
                        }
                    }

                    let mut frames = records_to_frames(records, parser_ref.details.clone());
                    
                    // Override the artificially false values injected by the library with our persistent trackers
                    for (frame, &(is_photo, is_video)) in frames.iter_mut().zip(persistent_camera_states.iter()) {
                        frame.camera.is_photo = is_photo;
                        frame.camera.is_video = is_video;
                    }

                    Ok((frames, comp_serials))
                }))
            }),
        )
        .await;

        match result {
            Err(_) => Err(ParserError::Timeout(PARSE_TIMEOUT_SECS)),
            Ok(Err(join_err)) => Err(ParserError::Panic(format!("Task join error: {}", join_err))),
            Ok(Ok(Err(panic_val))) => {
                let msg = panic_val
                    .downcast_ref::<String>()
                    .map(|s| s.clone())
                    .or_else(|| panic_val.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown panic".to_string());
                Err(ParserError::Panic(msg))
            }
            Ok(Ok(Ok(frames_result))) => {
                frames_result
                    .map(|(frames, comp_serials)| (frames, used_djifly_fallback, comp_serials))
                    .map_err(|e: dji_log_parser::Error| ParserError::Parse(e.to_string()))
            }
        }
    }

    /// Extract telemetry points from parsed frames
    fn extract_telemetry(&self, frames: &[Frame], details_total_time_secs: f64) -> Vec<TelemetryPoint> {
        let mut points = Vec::with_capacity(frames.len());
        let mut home_gps: Option<(f64, f64)> = None;
        let mut prev_valid_gps: Option<(f64, f64, i64)> = None;

        // Counters for logging
        let mut nearest_too_far_count: usize = 0;
        let mut nearest_reused_frame_count: usize = 0;
        let mut skipped_corrupt: usize = 0;
        let mut skipped_no_gps: usize = 0;
        let mut skipped_out_of_range: usize = 0;
        let mut skipped_jump: usize = 0;
        let mut skipped_far_from_home: usize = 0;
        let mut skipped_alt_clamp: usize = 0;
        let mut skipped_speed_clamp: usize = 0;
        let mut skipped_battery_voltage_clamp: usize = 0;

        // Derive frame cadence from parser-reported total duration when available.
        // This keeps timestamp progression aligned with real frame rate even when
        // fly_time is coarse (repeated) and prevents timeline inflation on >10Hz logs.
        let fallback_interval_ms: i64 = if details_total_time_secs > 0.0 && frames.len() > 1 {
            (((details_total_time_secs * 1000.0) / (frames.len() - 1) as f64).round() as i64).max(1)
        } else {
            100 // conservative fallback when cadence cannot be estimated
        };

        let sampling_plan = build_fly_time_sampling_plan(frames, fallback_interval_ms);
        log::debug!("fly_time available: {}", sampling_plan.has_fly_time);
        let mut nearest_cursor: usize = 0;
        let mut prev_selected_idx: Option<usize> = None;

        let mut prev_is_photo = false;

        for tick_idx in 0..frames.len() {
            let current_timestamp_ms = (tick_idx as i64) * fallback_interval_ms;

            let selected_idx = select_nearest_frame_index(
                frames.len(),
                tick_idx,
                current_timestamp_ms,
                sampling_plan.has_candidates,
                &sampling_plan.candidates,
                sampling_plan.max_nearest_gap_ms,
                &mut nearest_cursor,
                &mut prev_selected_idx,
                &mut nearest_too_far_count,
                &mut nearest_reused_frame_count,
            );
            let Some(selected_idx) = selected_idx else {
                // No sufficiently close fly_time frame for this synthetic tick.
                // Preserve timeline cadence with an empty placeholder row.
                points.push(TelemetryPoint {
                    timestamp_ms: current_timestamp_ms,
                    ..Default::default()
                });
                continue;
            };
            let frame = &frames[selected_idx];
            let osd = &frame.osd;
            let gimbal = &frame.gimbal;
            let battery = &frame.battery;
            let rc = &frame.rc;

            // Validate core numeric fields — skip entire frame if data is corrupt
            // (e.g. the parser produced garbage like lat=-6.6e-136, lon=5.7e+139)
            if !is_finite_f64(osd.latitude)
                || !is_finite_f64(osd.longitude)
                || !is_finite_f32(osd.altitude)
                || !is_finite_f32(osd.height)
                || !is_finite_f32(osd.x_speed)
                || !is_finite_f32(osd.y_speed)
                || !is_finite_f32(osd.z_speed)
            {
                // Increment timestamp and skip this corrupt frame
                if skipped_corrupt < 5 {
                    log::debug!(
                        "Skipping corrupt frame at {}ms: lat={}, lon={}, alt={}, height={}, vx={}, vy={}, vz={}",
                        current_timestamp_ms,
                        osd.latitude, osd.longitude, osd.altitude, osd.height,
                        osd.x_speed, osd.y_speed, osd.z_speed
                    );
                }
                skipped_corrupt += 1;
                // Preserve periodic timeline by inserting an empty placeholder row
                // for corrupt frames.
                points.push(TelemetryPoint {
                    timestamp_ms: current_timestamp_ms,
                    ..Default::default()
                });
                continue;
            }

            let mut point = TelemetryPoint {
                timestamp_ms: current_timestamp_ms,
                ..Default::default()
            };

            // Filter out invalid GPS coordinates:
            //  - values outside physical range (lat ±90, lon ±180) are corrupt
            //  - sudden huge jumps, >50km step jumps, and far-from-home outliers are rejected
            let has_gps_lock = !(osd.latitude.abs() < 1e-6 && osd.longitude.abs() < 1e-6);
            let gps_in_range = osd.latitude.abs() <= 90.0 && osd.longitude.abs() <= 180.0;
            let mut has_valid_gps = false;
            if has_gps_lock && gps_in_range {
                let lat = osd.latitude;
                let lon = osd.longitude;
                let mut rejected = false;

                // Reject impossible position jumps compared to previous accepted GPS point.
                if let Some((prev_lat, prev_lon, prev_ts)) = prev_valid_gps {
                    let jump_m = haversine_distance(prev_lat, prev_lon, lat, lon);
                    let dt_s = ((current_timestamp_ms - prev_ts).max(1) as f64) / 1000.0;
                    let jump_speed_mps = jump_m / dt_s;

                    // Hard sequence boundary: single-step jumps >50km are invalid.
                    if jump_m > MAX_GPS_STEP_DISTANCE_M {
                        skipped_jump += 1;
                        rejected = true;
                    }

                    // Speed-aware jump rejection for shorter but still impossible jumps.
                    if !rejected && jump_m > MAX_GPS_JUMP_DISTANCE_M && jump_speed_mps > MAX_GPS_JUMP_SPEED_MPS {
                        skipped_jump += 1;
                        rejected = true;
                    }
                }

                // Reject points that are unrealistically far from established home.
                if !rejected {
                    if let Some((home_lat, home_lon)) = home_gps {
                        let dist_from_home_m = haversine_distance(home_lat, home_lon, lat, lon);
                        if dist_from_home_m > MAX_DISTANCE_FROM_HOME_M {
                            skipped_far_from_home += 1;
                            rejected = true;
                        }
                    }
                }

                if !rejected {
                    point.latitude = Some(lat);
                    point.longitude = Some(lon);
                    has_valid_gps = true;

                    if home_gps.is_none() {
                        home_gps = Some((lat, lon));
                    }
                    prev_valid_gps = Some((lat, lon, current_timestamp_ms));
                }
            } else if has_gps_lock && !gps_in_range {
                skipped_out_of_range += 1;
            } else {
                skipped_no_gps += 1;
            }
            // else: latitude/longitude remain None (from Default)

            // Clamp altitude/height to physically plausible range (reject garbage)
            let alt = osd.altitude as f64;
            let height = osd.height as f64;
            point.altitude = if alt.abs() < 10_000.0 { Some(alt) } else { skipped_alt_clamp += 1; None };
            point.height = if height.abs() < 10_000.0 { Some(height) } else { skipped_alt_clamp += 1; None };
            point.vps_height = Some(osd.vps_height as f64);

            point.speed = if has_valid_gps {
                let spd = (osd.x_speed.powi(2) + osd.y_speed.powi(2)).sqrt() as f64;
                if spd < 100.0 { Some(spd) } else { skipped_speed_clamp += 1; None } // >100 m/s is clearly garbage
            } else {
                None // Speed from 0,0 origin is meaningless
            };
            point.velocity_x = if has_valid_gps { Some(osd.x_speed as f64) } else { None };
            point.velocity_y = if has_valid_gps { Some(osd.y_speed as f64) } else { None };
            point.velocity_z = if has_valid_gps { Some(osd.z_speed as f64) } else { None };
            point.pitch = Some(osd.pitch as f64);
            point.roll = Some(osd.roll as f64);
            point.yaw = Some(osd.yaw as f64);
            point.satellites = Some(osd.gps_num as i32);
            point.gps_signal = Some(osd.gps_level as i32);
            point.flight_mode = osd.flyc_state.map(|state| format!("{:?}", state));

            point.gimbal_pitch = Some(gimbal.pitch as f64);
            point.gimbal_roll = Some(gimbal.roll as f64);
            point.gimbal_yaw = Some(gimbal.yaw as f64);

            point.battery_percent = if battery.charge_level <= 100 {
                Some(battery.charge_level as i32)
            } else {
                None
            };
            let batt_v = battery.voltage as f64;
            point.battery_voltage = if batt_v.is_finite() && batt_v > 0.0 && batt_v <= MAX_BATTERY_VOLTAGE_V {
                Some(batt_v)
            } else {
                skipped_battery_voltage_clamp += 1;
                None
            };
            point.battery_current = Some(battery.current as f64);
            point.battery_temp = Some(battery.temperature as f64);
            // Extract battery capacity telemetry
            let full_cap = battery.full_capacity as f64;
            if full_cap > 0.0 {
                point.battery_full_capacity = Some(full_cap);
            }
            let remained_cap = battery.current_capacity as f64;
            if remained_cap > 0.0 {
                point.battery_remained_capacity = Some(remained_cap);
            }
            // Extract individual cell voltages if available
            point.cell_voltages = if !battery.cell_voltages.is_empty() {
                let volts: Vec<f64> = battery.cell_voltages.iter().map(|v| *v as f64).collect();
                if volts.iter().any(|v| *v > 30.0) {
                    None
                } else {
                    Some(volts)
                }
            } else {
                None
            };

            point.rc_uplink = rc.uplink_signal.map(i32::from);
            point.rc_downlink = rc.downlink_signal.map(i32::from);
            point.rc_signal = rc.downlink_signal.or(rc.uplink_signal).map(i32::from);

            // RC stick inputs: raw u16 centered at 1024 (range 0..2048) → normalized to -100..+100
            point.rc_aileron = Some(((rc.aileron as f64) - 1024.0) / 1024.0 * 100.0);
            point.rc_elevator = Some(((rc.elevator as f64) - 1024.0) / 1024.0 * 100.0);
            point.rc_throttle = Some(((rc.throttle as f64) - 1024.0) / 1024.0 * 100.0);
            point.rc_rudder = Some(((rc.rudder as f64) - 1024.0) / 1024.0 * 100.0);

            // Photos are capture events; video stays true throughout recording so
            // consumers can detect both start and stop transitions.
            let camera = &frame.camera;
            
            let is_photo_now = camera.is_photo;
            let is_video_now = camera.is_video;

            point.is_photo = Some(is_photo_now && !prev_is_photo);
            point.is_video = Some(is_video_now);

            prev_is_photo = is_photo_now;

            points.push(point);
        }

        // Log extraction summary
        if skipped_corrupt > 0
            || skipped_out_of_range > 0
            || skipped_jump > 0
            || skipped_far_from_home > 0
            || skipped_alt_clamp > 0
            || skipped_speed_clamp > 0
            || skipped_battery_voltage_clamp > 0
        {
            log::warn!(
                "Telemetry filtering: {} corrupt frames skipped, {} GPS out-of-range, {} jump outliers skipped, {} >50km-home skipped, {} no-GPS-lock, {} altitude clamped, {} speed clamped, {} battery_voltage clamped",
                skipped_corrupt,
                skipped_out_of_range,
                skipped_jump,
                skipped_far_from_home,
                skipped_no_gps,
                skipped_alt_clamp,
                skipped_speed_clamp,
                skipped_battery_voltage_clamp
            );
            if sampling_plan.has_candidates {
                log::debug!(
                    "Nearest fly_time sampling: {} candidates, {} synthetic ticks had no nearby candidate, {} ticks reused the same source frame",
                    sampling_plan.candidates.len(),
                    nearest_too_far_count,
                    nearest_reused_frame_count
                );
            }
        } else {
            log::debug!(
                "Telemetry extraction clean: {} points, {} frames without GPS lock",
                points.len(), skipped_no_gps
            );
        }

        points
    }

    /// Calculate flight statistics from telemetry points
    pub fn calculate_stats(&self, points: &[TelemetryPoint]) -> FlightStats {
        let duration_secs = points.last().map(|p| p.timestamp_ms as f64 / 1000.0).unwrap_or(0.0);

        let max_altitude = points
            .iter()
            .filter_map(|p| p.height.or(p.altitude))
            .fold(f64::NEG_INFINITY, f64::max);

        let max_speed = points
            .iter()
            .filter_map(|p| p.speed)
            .fold(f64::NEG_INFINITY, f64::max);

        let avg_speed: f64 = {
            let speeds: Vec<f64> = points.iter().filter_map(|p| p.speed).collect();
            if speeds.is_empty() {
                0.0
            } else {
                speeds.iter().sum::<f64>() / speeds.len() as f64
            }
        };

        let min_battery = points
            .iter()
            .filter_map(|p| p.battery_percent)
            .filter(|&v| v > 0)
            .min()
            .unwrap_or(0);

        // Calculate total distance using haversine formula
        let total_distance = self.calculate_total_distance(points);

        // Home location is the first valid GPS point
        let home_location = points
            .iter()
            .find_map(|p| match (p.longitude, p.latitude) {
                (Some(lon), Some(lat)) => Some([lon, lat]),
                _ => None,
            });

        // Max distance from home
        let max_distance_from_home = if let Some(home) = home_location {
            points
                .iter()
                .filter_map(|p| match (p.latitude, p.longitude) {
                    (Some(lat), Some(lon)) => Some(haversine_distance(home[1], home[0], lat, lon)),
                    _ => None,
                })
                .fold(0.0_f64, f64::max)
        } else {
            0.0
        };

        // Start and end battery percent
        let start_battery_percent = points.iter().find_map(|p| p.battery_percent);
        let end_battery_percent = points.iter().rev().find_map(|p| p.battery_percent);

        // Start battery temperature
        let start_battery_temp = points.iter().find_map(|p| p.battery_temp);

        FlightStats {
            duration_secs,
            total_distance_m: total_distance,
            max_altitude_m: if max_altitude.is_finite() {
                max_altitude
            } else {
                0.0
            },
            max_speed_ms: if max_speed.is_finite() { max_speed } else { 0.0 },
            avg_speed_ms: avg_speed,
            min_battery,
            home_location,
            max_distance_from_home_m: max_distance_from_home,
            start_battery_percent,
            end_battery_percent,
            start_battery_temp,
        }
    }

    /// Calculate total distance traveled using haversine formula
    fn calculate_total_distance(&self, points: &[TelemetryPoint]) -> f64 {
        let mut total = 0.0;
        let mut prev_lat: Option<f64> = None;
        let mut prev_lon: Option<f64> = None;

        for point in points {
            if let (Some(lat), Some(lon)) = (point.latitude, point.longitude) {
                if let (Some(p_lat), Some(p_lon)) = (prev_lat, prev_lon) {
                    total += haversine_distance(p_lat, p_lon, lat, lon);
                }
                prev_lat = Some(lat);
                prev_lon = Some(lon);
            }
        }

        total
    }

    /// Extract app messages (tips and warnings) from parsed frames
    fn extract_messages(&self, frames: &[Frame], details_total_time_secs: f64) -> Vec<FlightMessage> {
        let mut messages = Vec::new();

        // Keep message timestamps on the same cadence as telemetry so exports and
        // annotations stay aligned on high-rate logs.
        let fallback_interval_ms: i64 = if details_total_time_secs > 0.0 && frames.len() > 1 {
            (((details_total_time_secs * 1000.0) / (frames.len() - 1) as f64).round() as i64).max(1)
        } else {
            100 // conservative fallback when cadence cannot be estimated
        };

        let mut nearest_too_far_count: usize = 0;
        let mut nearest_reused_frame_count: usize = 0;

        let sampling_plan = build_fly_time_sampling_plan(frames, fallback_interval_ms);
        let mut nearest_cursor: usize = 0;
        let mut prev_selected_idx: Option<usize> = None;

        // ----------------------------------------------------------------
        // OSD + Gimbal state change tracking
        // Track all OSD status fields and gimbal.is_stuck. When a value
        // changes between consecutive frames, emit a message:
        //   "XXX changed from YYY to ZZZ"
        // Severity mapping:
        //   caution — hardware/sensor errors (compass, motor, barometer, IMU, …)
        //   warn    — operational warnings (voltage, vibration, limits, RTH, …)
        //   tip     — informational (vision, IOC, …)
        // ----------------------------------------------------------------

        // Helper formatting closures
        fn fmt_bool(v: bool) -> &'static str { if v { "Yes" } else { "No" } }
        fn fmt_voltage_warning(v: u8) -> String {
            match v {
                0 => "Normal".to_string(),
                1 => "Low".to_string(),
                2 => "Severe Low".to_string(),
                3 => "Smart Low".to_string(),
                n => format!("Level {}", n),
            }
        }
        fn fmt_opt_enum<T: std::fmt::Debug>(v: &Option<T>) -> String {
            match v {
                Some(val) => format!("{:?}", val),
                None => "None".to_string(),
            }
        }

        // Previous-state trackers (Option<_> = None means first frame, skip)
        // --- Caution-level (hardware / sensor errors) ---
        let mut prev_is_compass_error: Option<bool> = None;
        let mut prev_is_motor_blocked: Option<bool> = None;
        let mut prev_is_barometer_dead_in_air: Option<bool> = None;
        let mut prev_is_acceletor_over_range: Option<bool> = None;
        let mut prev_is_not_enough_force: Option<bool> = None;
        let mut prev_is_propeller_catapult: Option<bool> = None;
        let mut prev_motor_start_failed_cause: Option<String> = None;
        let mut prev_imu_init_fail_reason: Option<String> = None;
        let mut prev_gimbal_is_stuck: Option<bool> = None;

        // --- Warning-level (operational) ---
        let mut prev_voltage_warning: Option<u8> = None;
        let mut prev_wave_error: Option<bool> = None;
        let mut prev_is_out_of_limit: Option<bool> = None;
        let mut prev_go_home_status: Option<String> = None;
        let mut prev_is_vibrating: Option<bool> = None;
        let mut prev_is_go_home_height_modified: Option<bool> = None;
        let mut prev_non_gps_cause: Option<String> = None;

        // --- Info-level (informational) ---
        let mut prev_is_vision_used: Option<bool> = None;
        let mut prev_is_imu_preheated: Option<bool> = None;
        let mut prev_can_ioc_work: Option<bool> = None;

        // Flight action still tracked separately for descriptive event messages
        let mut prev_flight_action_msg = std::option::Option::<&str>::None;

        /// Macro: check a boolean field for change and emit a message
        macro_rules! track_bool {
            ($cur:expr, $prev:ident, $name:expr, $severity:expr, $ts:expr, $msgs:ident) => {
                let cur_val = $cur;
                if let Some(prev_val) = $prev {
                    if cur_val != prev_val {
                        $msgs.push(FlightMessage {
                            timestamp_ms: $ts,
                            message_type: $severity.to_string(),
                            message: format!("{} changed from {} to {}", $name, fmt_bool(prev_val), fmt_bool(cur_val)),
                        });
                    }
                }
                $prev = Some(cur_val);
            };
        }

        /// Macro: check a string-formatted enum/numeric field for change
        macro_rules! track_string {
            ($cur:expr, $prev:ident, $name:expr, $severity:expr, $ts:expr, $msgs:ident) => {
                let cur_str: String = $cur;
                if let Some(ref prev_str) = $prev {
                    if cur_str != *prev_str {
                        $msgs.push(FlightMessage {
                            timestamp_ms: $ts,
                            message_type: $severity.to_string(),
                            message: format!("{} changed from {} to {}", $name, prev_str, cur_str),
                        });
                    }
                }
                $prev = Some(cur_str);
            };
        }

        for tick_idx in 0..frames.len() {
            // Keep message timestamps aligned to telemetry's periodic cadence.
            // This avoids drift when raw fly_time is sparse or corrupted.
            let current_timestamp_ms = (tick_idx as i64) * fallback_interval_ms;

            let selected_idx = select_nearest_frame_index(
                frames.len(),
                tick_idx,
                current_timestamp_ms,
                sampling_plan.has_candidates,
                &sampling_plan.candidates,
                sampling_plan.max_nearest_gap_ms,
                &mut nearest_cursor,
                &mut prev_selected_idx,
                &mut nearest_too_far_count,
                &mut nearest_reused_frame_count,
            );
            let Some(selected_idx) = selected_idx else {
                // Skip message extraction for ticks with no nearby source frame.
                continue;
            };
            let frame = &frames[selected_idx];

            // Extract tip message if present
            if !frame.app.tip.is_empty() {
                messages.push(FlightMessage {
                    timestamp_ms: current_timestamp_ms,
                    message_type: "tip".to_string(),
                    message: frame.app.tip.clone(),
                });
            }

            // Extract warning message if present
            if !frame.app.warn.is_empty() {
                messages.push(FlightMessage {
                    timestamp_ms: current_timestamp_ms,
                    message_type: "warn".to_string(),
                    message: frame.app.warn.clone(),
                });
            }

            // ============================================================
            //  Caution-level state changes (hardware / sensor errors)
            // ============================================================
            track_bool!(frame.osd.is_compass_error, prev_is_compass_error,
                "Compass Error", "caution", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_motor_blocked, prev_is_motor_blocked,
                "Motor Blocked", "caution", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_barometer_dead_in_air, prev_is_barometer_dead_in_air,
                "Barometer Dead In Air", "caution", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_acceletor_over_range, prev_is_acceletor_over_range,
                "Accelerometer Over Range", "caution", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_not_enough_force, prev_is_not_enough_force,
                "Not Enough Force", "caution", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_propeller_catapult, prev_is_propeller_catapult,
                "Propeller Catapult", "caution", current_timestamp_ms, messages);
            track_string!(fmt_opt_enum(&frame.osd.motor_start_failed_cause), prev_motor_start_failed_cause,
                "Motor Start Failed Cause", "caution", current_timestamp_ms, messages);
            track_string!(fmt_opt_enum(&frame.osd.imu_init_fail_reason), prev_imu_init_fail_reason,
                "IMU Init Fail Reason", "caution", current_timestamp_ms, messages);
            track_bool!(frame.gimbal.is_stuck, prev_gimbal_is_stuck,
                "Gimbal Stuck", "caution", current_timestamp_ms, messages);

            // ============================================================
            //  Warning-level state changes (operational)
            // ============================================================
            {
                let cur_vw = frame.osd.voltage_warning;
                if let Some(prev_vw) = prev_voltage_warning {
                    if cur_vw != prev_vw {
                        messages.push(FlightMessage {
                            timestamp_ms: current_timestamp_ms,
                            message_type: "warn".to_string(),
                            message: format!("Voltage Warning changed from {} to {}",
                                fmt_voltage_warning(prev_vw), fmt_voltage_warning(cur_vw)),
                        });
                    }
                }
                prev_voltage_warning = Some(cur_vw);
            }
            track_bool!(frame.osd.wave_error, prev_wave_error,
                "Wave Error", "warn", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_out_of_limit, prev_is_out_of_limit,
                "Out Of Limit", "warn", current_timestamp_ms, messages);
            track_string!(fmt_opt_enum(&frame.osd.go_home_status), prev_go_home_status,
                "Go Home Status", "warn", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_vibrating, prev_is_vibrating,
                "Vibrating", "warn", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_go_home_height_modified, prev_is_go_home_height_modified,
                "Go Home Height Modified", "warn", current_timestamp_ms, messages);
            track_string!(fmt_opt_enum(&frame.osd.non_gps_cause), prev_non_gps_cause,
                "Non-GPS Cause", "warn", current_timestamp_ms, messages);

            // ============================================================
            //  Info-level state changes (informational)
            // ============================================================
            track_bool!(frame.osd.is_vision_used, prev_is_vision_used,
                "Vision Positioning", "tip", current_timestamp_ms, messages);
            track_bool!(frame.osd.is_imu_preheated, prev_is_imu_preheated,
                "IMU Preheated", "tip", current_timestamp_ms, messages);
            track_bool!(frame.osd.can_ioc_work, prev_can_ioc_work,
                "IOC Available", "tip", current_timestamp_ms, messages);

            // ============================================================
            //  Flight Action transitions (descriptive event messages)
            // ============================================================
            let current_flight_action_msg = frame.osd.flight_action.and_then(|action| {
                use dji_log_parser::record::osd::FlightAction;
                match action {
                    FlightAction::WarningPowerGoHome => Some("Low Battery RTH Triggered"),
                    FlightAction::WarningPowerLanding => Some("Low Battery Auto Landing"),
                    FlightAction::SmartPowerGoHome => Some("Smart RTH Triggered"),
                    FlightAction::SmartPowerLanding => Some("Smart Auto Landing"),
                    FlightAction::LowVoltageLanding => Some("Critical Low Voltage Landing"),
                    FlightAction::LowVoltageGoHome => Some("Low Voltage RTH"),
                    FlightAction::SeriousLowVoltageLanding => Some("Severe Low Voltage Landing"),
                    FlightAction::BatteryForceLanding => Some("Battery Forced Landing"),
                    FlightAction::MotorblockLanding => Some("Motor Blocked Forced Landing"),
                    FlightAction::AppRequestForceLanding => Some("App Requested Forced Landing"),
                    FlightAction::FakeBatteryLanding => Some("Non-intelligent Battery Landing"),
                    FlightAction::GoHomeAvoid => Some("Obstacle Avoidance during RTH"),
                    _ => std::option::Option::None,
                }
            });
            
            if current_flight_action_msg != prev_flight_action_msg {
                if let Some(msg) = current_flight_action_msg {
                    messages.push(FlightMessage {
                        timestamp_ms: current_timestamp_ms,
                        message_type: "warn".to_string(),
                        message: msg.to_string(),
                    });
                }
            }
            prev_flight_action_msg = current_flight_action_msg;

        }

        if sampling_plan.has_candidates {
            log::debug!(
                "Nearest fly_time message sampling: {} candidates, {} synthetic ticks had no nearby candidate, {} ticks reused the same source frame",
                sampling_plan.candidates.len(),
                nearest_too_far_count,
                nearest_reused_frame_count
            );
        }

        // Deduplicate consecutive identical messages (some messages repeat across frames)
        messages.dedup_by(|a, b| a.message_type == b.message_type && a.message == b.message);

        messages
    }

    /// Extract drone model from parser metadata
    fn extract_drone_model(&self, parser: &DJILog) -> Option<String> {
        let model = format!("{:?}", parser.details.product_type);
        if model.starts_with("Unknown") {
            None
        } else {
            Some(model)
        }
    }

    /// Extract serial number from parser
    fn extract_serial(&self, parser: &DJILog) -> Option<String> {
        let sn = parser.details.aircraft_sn.trim().to_uppercase();
        if sn.is_empty() {
            None
        } else {
            Some(sn)
        }
    }

    /// Extract aircraft name from parser
    fn extract_aircraft_name(&self, parser: &DJILog) -> Option<String> {
        let name = parser.details.aircraft_name.clone();
        if name.trim().is_empty() {
            None
        } else {
            Some(name)
        }
    }

    /// Extract battery serial from parser
    fn extract_battery_serial(&self, parser: &DJILog) -> Option<String> {
        let sn = parser.details.battery_sn.trim().to_uppercase();
        if sn.is_empty() {
            None
        } else {
            Some(sn)
        }
    }

    /// Extract flight start time
    fn extract_start_time(&self, parser: &DJILog) -> Option<DateTime<Utc>> {
        Some(parser.details.start_time)
    }

    /// Extract flight end time
    fn extract_end_time(&self, parser: &DJILog) -> Option<DateTime<Utc>> {
        let start = self.extract_start_time(parser)?;
        let duration_ms = (parser.details.total_time * 1000.0) as i64;
        Some(start + chrono::Duration::milliseconds(duration_ms))
    }
}

#[derive(Debug)]
struct FlyTimeSamplingPlan {
    has_fly_time: bool,
    has_candidates: bool,
    candidates: Vec<(i64, usize)>,
    max_nearest_gap_ms: i64,
}

fn build_fly_time_sampling_plan(frames: &[Frame], fallback_interval_ms: i64) -> FlyTimeSamplingPlan {
    let has_fly_time = frames.iter().any(|f| f.osd.fly_time > 0.0);
    let first_fly_time_ms = frames
        .iter()
        .find_map(|f| {
            if f.osd.fly_time.is_finite() && f.osd.fly_time >= 0.0 {
                Some((f.osd.fly_time * 1000.0) as i64)
            } else {
                None
            }
        })
        .unwrap_or(0);
    let mut candidates: Vec<(i64, usize)> = Vec::with_capacity(frames.len());

    for (idx, frame) in frames.iter().enumerate() {
        let osd = &frame.osd;
        let raw_fly_time_ms = if osd.fly_time.is_finite() && osd.fly_time > 0.0 {
            (osd.fly_time * 1000.0) as i64
        } else {
            0
        };
        let fly_time_ms = if first_fly_time_ms > 0 && raw_fly_time_ms > 0 {
            raw_fly_time_ms.saturating_sub(first_fly_time_ms)
        } else {
            raw_fly_time_ms
        };

        candidates.push((fly_time_ms, idx));
    }

    candidates.sort_by_key(|(t, idx)| (*t, *idx));

    FlyTimeSamplingPlan {
        has_fly_time,
        has_candidates: !candidates.is_empty() && has_fly_time,
        candidates,
        max_nearest_gap_ms: (fallback_interval_ms * 3).max(500),
    }
}

fn select_nearest_frame_index(
    frames_len: usize,
    tick_idx: usize,
    target_ms: i64,
    has_candidates: bool,
    candidates: &[(i64, usize)],
    max_nearest_gap_ms: i64,
    nearest_cursor: &mut usize,
    prev_selected_idx: &mut Option<usize>,
    nearest_too_far_count: &mut usize,
    nearest_reused_frame_count: &mut usize,
) -> Option<usize> {
    let selected_idx = if has_candidates {
        while *nearest_cursor + 1 < candidates.len() {
            let cur_dist = (candidates[*nearest_cursor].0 - target_ms).abs();
            let next_dist = (candidates[*nearest_cursor + 1].0 - target_ms).abs();
            if next_dist <= cur_dist {
                *nearest_cursor += 1;
            } else {
                break;
            }
        }

        let nearest = candidates[*nearest_cursor];
        let nearest_dist = (nearest.0 - target_ms).abs();
        if nearest_dist > max_nearest_gap_ms {
            *nearest_too_far_count += 1;
            None
        } else {
            if let Some(prev_idx) = *prev_selected_idx {
                if prev_idx == nearest.1 {
                    *nearest_reused_frame_count += 1;
                }
            }
            Some(nearest.1)
        }
    } else {
        Some(tick_idx.min(frames_len - 1))
    };

    *prev_selected_idx = selected_idx;
    selected_idx
}

/// Calculate FlightStats from stored TelemetryRecords (for tag regeneration without re-parsing files)
pub fn calculate_stats_from_records(records: &[crate::models::TelemetryRecord]) -> FlightStats {
    let duration_secs = records.last().map(|r| r.timestamp_ms as f64 / 1000.0).unwrap_or(0.0)
        - records.first().map(|r| r.timestamp_ms as f64 / 1000.0).unwrap_or(0.0);

    let max_altitude = records.iter()
        .filter_map(|r| r.height.or(r.altitude))
        .fold(0.0_f64, f64::max);

    let max_speed = records.iter()
        .filter_map(|r| r.speed)
        .fold(0.0_f64, f64::max);

    let avg_speed: f64 = {
        let speeds: Vec<f64> = records.iter().filter_map(|r| r.speed).collect();
        if speeds.is_empty() { 0.0 } else { speeds.iter().sum::<f64>() / speeds.len() as f64 }
    };

    let min_battery = records.iter()
        .filter_map(|r| r.battery_percent)
        .filter(|&v| v > 0)
        .min()
        .unwrap_or(0);

    // Total distance using haversine
    let mut total_distance = 0.0;
    let mut prev_lat: Option<f64> = None;
    let mut prev_lon: Option<f64> = None;
    for r in records {
        if let (Some(lat), Some(lon)) = (r.latitude, r.longitude) {
            if lat.abs() < 0.0001 && lon.abs() < 0.0001 { continue; }
            if let (Some(plat), Some(plon)) = (prev_lat, prev_lon) {
                total_distance += haversine_distance(plat, plon, lat, lon);
            }
            prev_lat = Some(lat);
            prev_lon = Some(lon);
        }
    }

    let home_location = records.iter()
        .find_map(|r| match (r.longitude, r.latitude) {
            (Some(lon), Some(lat)) if lat.abs() > 0.0001 || lon.abs() > 0.0001 => Some([lon, lat]),
            _ => None,
        });

    let max_distance_from_home = if let Some(home) = home_location {
        records.iter()
            .filter_map(|r| match (r.latitude, r.longitude) {
                (Some(lat), Some(lon)) => Some(haversine_distance(home[1], home[0], lat, lon)),
                _ => None,
            })
            .fold(0.0_f64, f64::max)
    } else {
        0.0
    };

    let start_battery_percent = records.iter().find_map(|r| r.battery_percent);
    let end_battery_percent = records.iter().rev().find_map(|r| r.battery_percent);
    let start_battery_temp = records.iter().find_map(|r| r.battery_temp);

    FlightStats {
        duration_secs,
        total_distance_m: total_distance,
        max_altitude_m: if max_altitude.is_finite() { max_altitude } else { 0.0 },
        max_speed_ms: if max_speed.is_finite() { max_speed } else { 0.0 },
        avg_speed_ms: avg_speed,
        min_battery,
        home_location,
        max_distance_from_home_m: max_distance_from_home,
        start_battery_percent,
        end_battery_percent,
        start_battery_temp,
    }
}

/// Haversine distance calculation in meters
pub fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0; // Earth's radius in meters

    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let delta_lat = (lat2 - lat1).to_radians();
    let delta_lon = (lon2 - lon1).to_radians();

    let a = (delta_lat / 2.0).sin().powi(2)
        + lat1_rad.cos() * lat2_rad.cos() * (delta_lon / 2.0).sin().powi(2);

    let c = 2.0 * a.sqrt().asin();

    R * c
}

/// Check if an f64 value is finite (not NaN, not Inf)
#[inline]
fn is_finite_f64(v: f64) -> bool {
    v.is_finite()
}

/// Check if an f32 value is finite (not NaN, not Inf)
#[inline]
fn is_finite_f32(v: f32) -> bool {
    v.is_finite()
}

// ============================================================================
// Shared post-import pipeline
// ============================================================================

/// Run all post-import steps after a flight and its telemetry have been
/// inserted into the database.  This is the single canonical location for
/// the logic that was previously duplicated across `tauri_app::import_log`,
/// `server::import_log`, `server::sync_single_file`, `server::sync_from_folder`,
/// and `server::run_scheduled_sync`.
///
/// Steps performed:
///  1. Insert smart tags (filtered by enabled_tag_types if configured)
///  2. Insert manual tags from re-imported CSV exports
///  3. Auto-tag with profile name for non-default profiles
///  4. Insert notes from re-imported CSV exports
///  5. Apply color from re-imported CSV exports
///  6. Insert app messages (tips and warnings) from DJI logs
///  7. Restore previously saved user customizations (display_name, notes, color, manual tags)
pub fn run_post_import_steps(
    db: &Database,
    flight_id: i64,
    parse_result: &ParseResult,
    config: &serde_json::Value,
    profile: &str,
) {
    let tags_enabled = config.get("smart_tags_enabled").and_then(|v| v.as_bool()).unwrap_or(true);

    // 1. Insert smart tags if enabled
    if tags_enabled {
        let tags = if let Some(types) = config.get("enabled_tag_types").and_then(|v| v.as_array()) {
            let enabled_types: Vec<String> = types.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            LogParser::filter_smart_tags(parse_result.tags.clone(), &enabled_types)
        } else {
            parse_result.tags.clone()
        };
        if let Err(e) = db.insert_flight_tags(flight_id, &tags) {
            log::warn!("Failed to insert tags for flight {}: {}", flight_id, e);
        }
    }

    // 2. Insert manual tags from re-imported CSV exports (always, regardless of smart_tags_enabled)
    for manual_tag in &parse_result.manual_tags {
        if let Err(e) = db.add_flight_tag(flight_id, manual_tag) {
            log::warn!("Failed to insert manual tag '{}' for flight {}: {}", manual_tag, flight_id, e);
        }
    }

    // 3. Auto-tag with profile name for non-default profiles
    if profile != "default" {
        if let Err(e) = db.add_flight_tag(flight_id, profile) {
            log::warn!("Failed to insert profile tag '{}' for flight {}: {}", profile, flight_id, e);
        }
    }

    // 4. Insert notes from re-imported CSV exports
    if let Some(ref notes) = parse_result.notes {
        if let Err(e) = db.update_flight_notes(flight_id, Some(notes.as_str())) {
            log::warn!("Failed to insert notes for flight {}: {}", flight_id, e);
        }
    }

    // 5. Apply color from re-imported CSV exports
    if let Some(ref color) = parse_result.color {
        if let Err(e) = db.update_flight_color(flight_id, color) {
            log::warn!("Failed to set color for flight {}: {}", flight_id, e);
        }
    }

    // 6. Insert app messages (tips and warnings) from DJI logs
    if !parse_result.messages.is_empty() {
        if let Err(e) = db.insert_flight_messages(flight_id, &parse_result.messages) {
            log::warn!("Failed to insert messages for flight {}: {}", flight_id, e);
        }
    }

    // 7. Restore previously saved user customizations (display_name, notes, color, manual tags)
    if let Some(ref hash) = parse_result.metadata.file_hash {
        if let Err(e) = db.apply_saved_customizations(flight_id, hash) {
            log::warn!("Failed to restore customizations for flight {}: {}", flight_id, e);
        }
    }
}
