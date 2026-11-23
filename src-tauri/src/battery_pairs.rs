use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const BATTERY_PAIR_FILE: &str = "battery-pair.json";

fn battery_pair_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BATTERY_PAIR_FILE)
}

/// Ensure battery-pair.json exists in the app data directory.
///
/// The initial content is an empty JSON object, so users can start editing
/// the file manually without extra setup.
pub fn ensure_battery_pair_file(data_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    let file_path = battery_pair_path(data_dir);
    if !file_path.exists() {
        std::fs::write(&file_path, "{}\n")
            .map_err(|e| format!("Failed to create {}: {}", BATTERY_PAIR_FILE, e))?;
        log::info!(
            "Created default {} at {}",
            BATTERY_PAIR_FILE,
            file_path.display()
        );
    } else {
        log::debug!(
            "Found existing {} at {}",
            BATTERY_PAIR_FILE,
            file_path.display()
        );
    }

    Ok(file_path)
}

fn normalize_pair_token(raw: &str) -> Option<String> {
    let mut parts = raw.split(':').map(|p| p.trim()).filter(|p| !p.is_empty());
    let left = parts.next()?;
    let right = parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    let a = left.to_uppercase();
    let b = right.to_uppercase();
    if !is_serial_like(&a) || !is_serial_like(&b) {
        return None;
    }
    if a == b {
        return None;
    }

    if a < b {
        Some(format!("{}:{}", a, b))
    } else {
        Some(format!("{}:{}", b, a))
    }
}

fn is_serial_like(value: &str) -> bool {
    if value.len() < 4 {
        return false;
    }
    let mut has_digit = false;
    for c in value.chars() {
        let ok = c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.';
        if !ok {
            return false;
        }
        if c.is_ascii_digit() {
            has_digit = true;
        }
    }
    has_digit
}

/// Load normalized battery pair definitions from battery-pair.json.
///
/// Supported JSON formats:
/// - ["SN1:SN2", "SN3:SN4"]
/// - {"pairs": ["SN1:SN2"]}
/// - {"SN1": "SN2", "SN3": "SN4"}
pub fn load_battery_pairs(data_dir: &Path) -> Vec<String> {
    let path = match ensure_battery_pair_file(data_dir) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Failed to ensure battery pair file: {}", e);
            return Vec::new();
        }
    };

    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to read {}: {}", path.display(), e);
            return Vec::new();
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("Failed to parse {}: {}", path.display(), e);
            return Vec::new();
        }
    };

    let mut out = BTreeSet::<String>::new();

    match parsed {
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    if let Some(token) = normalize_pair_token(s) {
                        out.insert(token);
                    }
                }
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Array(items)) = map.get("pairs") {
                for item in items {
                    if let Some(s) = item.as_str() {
                        if let Some(token) = normalize_pair_token(s) {
                            out.insert(token);
                        }
                    }
                }
            }

            for (k, v) in map {
                if k == "pairs" {
                    continue;
                }
                if let Some(rhs) = v.as_str() {
                    let candidate = format!("{}:{}", k, rhs);
                    if let Some(token) = normalize_pair_token(&candidate) {
                        out.insert(token);
                    }
                }
                if let Some(candidate) = v.as_str().and_then(normalize_pair_token) {
                    out.insert(candidate);
                }
            }
        }
        _ => {}
    }

    let pairs: Vec<String> = out.into_iter().collect();
    log::debug!(
        "Loaded {} battery pair definitions from {}",
        pairs.len(),
        path.display()
    );
    pairs
}
