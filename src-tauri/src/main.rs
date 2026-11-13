//! Open DroneLog - Backend
//!
//! A high-performance application for analyzing DJI drone flight logs.
//! Supports two build modes:
//! - `tauri-app` (default): Desktop app with Tauri v2
//! - `web`: REST API server with Axum for Docker/web deployment
//!
//! Licensed under the GNU Affero General Public License v3.0. See the LICENSE file for details.

#![cfg_attr(
    all(not(debug_assertions), feature = "tauri-app"),
    windows_subsystem = "windows"
)]

mod airdata_parser;
mod api;
mod battery_pairs;
mod database;
mod dronelogbook_parser;
mod litchi_parser;
mod models;
mod parser;
mod plugins;
mod profile_auth;
mod recount;

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
mod server;

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
mod session_store;

// ============================================================================
// TAURI DESKTOP MODE
// ============================================================================

#[cfg(feature = "tauri-app")]
mod tauri_app;

// ============================================================================
// WEB SERVER MODE
// ============================================================================

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
async fn run_web() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug"))
        .init();

    let data_dir = std::env::var("DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("/data"))
                .join("drone-logbook")
        });

    log::info!("Data directory: {:?}", data_dir);

    if let Err(e) = crate::battery_pairs::ensure_battery_pair_file(&data_dir) {
        log::warn!("Failed to initialize battery-pair.json: {}", e);
    } else {
        let pairs = crate::battery_pairs::load_battery_pairs(&data_dir);
        log::info!("Loaded {} battery pair definitions", pairs.len());
    }

    if let Err(e) = server::start_server(data_dir).await {
        log::error!("Server failed: {}", e);
        std::process::exit(1);
    }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

fn main() {
    #[cfg(feature = "tauri-app")]
    {
        tauri_app::run();
    }

    #[cfg(all(feature = "web", not(feature = "tauri-app")))]
    {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_web());
    }

    #[cfg(not(any(feature = "tauri-app", feature = "web")))]
    {
        eprintln!("Error: No feature flag enabled. Build with --features tauri-app or --features web");
        std::process::exit(1);
    }
}
