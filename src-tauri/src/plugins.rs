//! Plugin execution module to run custom external parsers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub const BUILTIN_ALLOWED_EXTENSIONS: [&str; 4] = ["txt", "csv", "log", "tsv"];

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PluginConfig {
    pub mappings: HashMap<String, PluginMapping>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PluginMapping {
    pub command: String,
    pub args: Vec<String>,
}

fn normalize_extension(ext: &str) -> Option<String> {
    let trimmed = ext.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// Helper to load the plugins config (`parsers.json`)
pub fn get_plugin_config(data_dir: &Path) -> Option<PluginConfig> {
    let config_candidates: Vec<PathBuf> = {
        #[cfg(all(feature = "web", not(feature = "tauri-app")))]
        {
            vec![
                PathBuf::from("/app/plugins/parsers.json"),
                // Backward-compatible fallback for older Docker setups.
                data_dir.join("parsers.json"),
            ]
        }

        #[cfg(not(all(feature = "web", not(feature = "tauri-app"))))]
        {
            vec![data_dir.join("parsers.json")]
        }
    };

    for config_path in config_candidates {
        log::debug!("Looking for custom parser config at {:?}", config_path);
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                match serde_json::from_str::<PluginConfig>(&content) {
                    Ok(conf) => return Some(conf),
                    Err(e) => {
                        log::warn!("Failed to parse parsers.json at {:?}: {}", config_path, e);
                    }
                }
            }
        } else {
            log::debug!("No parsers.json found at {:?}", config_path);
        }
    }

    None
}

/// Return all allowed log extensions from built-ins and parsers.json mappings.
pub fn get_allowed_extensions(data_dir: &Path) -> Vec<String> {
    let mut all: Vec<String> = BUILTIN_ALLOWED_EXTENSIONS
        .iter()
        .map(|e| (*e).to_string())
        .collect();

    if let Some(config) = get_plugin_config(data_dir) {
        for ext in config.mappings.keys() {
            if let Some(normalized) = normalize_extension(ext) {
                if !all.contains(&normalized) {
                    all.push(normalized);
                }
            }
        }
    }

    all.sort();
    all
}

/// Log all custom parser mappings discovered at startup.
pub fn log_plugin_registration(data_dir: &Path) {
    match get_plugin_config(data_dir) {
        Some(config) => {
            if config.mappings.is_empty() {
                log::info!("Custom parser config loaded, but no mappings were found");
                return;
            }

            log::info!(
                "Custom parser mappings discovered: {}",
                config.mappings.len()
            );
            for (raw_ext, mapping) in &config.mappings {
                let ext =
                    normalize_extension(raw_ext).unwrap_or_else(|| raw_ext.to_ascii_lowercase());
                log::info!(
                    "Registered custom parser: .{} -> command='{}' args={:?}",
                    ext,
                    mapping.command,
                    mapping.args
                );
            }
        }
        None => {
            log::info!("No custom parser mappings registered (parsers.json not found or invalid)");
        }
    }
}

/// Helper to execute the external parser plugin
/// Returns `Ok(())` if the script executed and returned a 0 exit status.
pub async fn run_plugin(
    mapping: &PluginMapping,
    input_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(&mapping.command);

    for arg in &mapping.args {
        let arg_str = arg
            .replace("$INPUT", input_path.to_str().unwrap_or(""))
            .replace("$OUTPUT", output_path.to_str().unwrap_or(""));
        cmd.arg(arg_str);
    }

    log::info!("Executing custom parser plugin subprocess: {:?}", cmd);

    let status = cmd
        .status()
        .await
        .map_err(|e| format!("Failed to spawn plugin subprocess: {}", e))?;

    if !status.success() {
        return Err(format!("Plugin exited with status: {}", status));
    }

    Ok(())
}
