//! One-time photo-count recount for flights imported before the parser read the DJI app's
//! own photo count from the log header.
//!
//! Older imports counted photos only from the camera's "shooting" flag, which is sampled a few
//! times a second: fast interval shooting (mapping at ~0.7 s per photo) was badly undercounted
//! and some aircraft (Matrice 4E) always showed 0. The header count needs no decryption, so a
//! recount only has to read the header of each flight's original log, when the server kept it.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::database::Database;
use crate::parser::LogParser;

/// Settings key recording whether this profile finished ("done") or declined ("dismissed")
/// the recount. Bump the version if a later fix needs another recount.
pub const PHOTO_RECOUNT_SETTING: &str = "maintenance_photo_recount_v1";

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecountStatus {
    /// "pending", "done" or "dismissed".
    pub state: String,
    /// DJI flight logs in this profile.
    pub dji_flights: usize,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecountChunk {
    /// Flights looked at in this chunk.
    pub processed: usize,
    /// Flights whose photo count went up.
    pub updated: usize,
    /// Flights whose original log file could not be found.
    pub missing: usize,
    /// DJI flight logs in the profile (the full job size).
    pub total: usize,
    /// Offset to pass for the next chunk; equals `total` when finished.
    pub next_offset: usize,
    pub done: bool,
}

/// Uploaded copies are stored under the original name; server imports record the flight under
/// a temporary `"{uuid}-{name}"`. Strip that prefix to get the name the kept copy uses.
fn original_name(file_name: &str) -> &str {
    let bytes = file_name.as_bytes();
    if bytes.len() > 37 && bytes[36] == b'-' && uuid::Uuid::parse_str(&file_name[..36]).is_ok() {
        &file_name[37..]
    } else {
        file_name
    }
}

/// True when `name` is a bare file name: no folders, drive letters or "..".
/// Stored names come from uploads, so never let one point outside the folders we search.
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
}

fn is_dji_log(file_name: &str) -> bool {
    file_name.to_ascii_lowercase().ends_with(".txt")
}

/// Find the kept original for a flight: same name, or the `{stem}_{hash8}.{ext}` name used when
/// two different files shared a name. Only a file with the matching hash counts.
fn find_original(folders: &[PathBuf], file_name: &str, file_hash: &str) -> Option<PathBuf> {
    let name = original_name(file_name);
    if !is_plain_file_name(name) {
        return None;
    }
    let path = Path::new(name);
    let stem = path.file_stem()?.to_str()?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let suffixed = format!("{}_{}.{}", stem, &file_hash[..8.min(file_hash.len())], ext);
    for folder in folders {
        for candidate in [folder.join(name), folder.join(&suffixed)] {
            if candidate.is_file()
                && LogParser::calculate_file_hash(&candidate).ok().as_deref() == Some(file_hash)
            {
                return Some(candidate);
            }
        }
    }
    None
}

/// The photo count the DJI app wrote into the log header, if the file is a readable DJI log.
fn header_photo_count(path: &Path) -> Option<i32> {
    let bytes = std::fs::read(path).ok()?;
    std::panic::catch_unwind(move || {
        dji_log_parser::DJILog::from_bytes(bytes).ok().map(|log| log.details.capture_num)
    })
    .ok()
    .flatten()
    .filter(|n| *n > 0)
}

pub fn status(db: &Database) -> Result<RecountStatus, String> {
    let state = db
        .get_setting(PHOTO_RECOUNT_SETTING)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "pending".to_string());
    let dji_flights = db
        .get_all_flights()
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|f| is_dji_log(&f.file_name))
        .count();
    Ok(RecountStatus { state, dji_flights })
}

/// Record that the user declined the recount, so the prompt stops appearing.
pub fn dismiss(db: &Database) -> Result<(), String> {
    db.set_setting(PHOTO_RECOUNT_SETTING, "dismissed").map_err(|e| e.to_string())
}

/// Recount one chunk of DJI flights (oldest first, so offsets stay stable while new flights
/// arrive). Counts only ever go up: the header number replaces the old count when higher.
/// Marks the recount done after the last chunk.
pub fn run_chunk(db: &Database, folders: &[PathBuf], offset: usize, limit: usize) -> Result<RecountChunk, String> {
    let mut flights: Vec<_> = db
        .get_all_flights()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|f| is_dji_log(&f.file_name))
        .collect();
    flights.sort_by_key(|f| f.id);

    let total = flights.len();
    let end = (offset + limit.max(1)).min(total);
    let mut chunk = RecountChunk { total, ..Default::default() };

    for flight in flights.get(offset..end).unwrap_or(&[]) {
        chunk.processed += 1;
        let Some(hash) = flight.file_hash.as_deref() else {
            chunk.missing += 1;
            continue;
        };
        let Some(path) = find_original(folders, &flight.file_name, hash) else {
            chunk.missing += 1;
            continue;
        };
        if let Some(header) = header_photo_count(&path) {
            if header > flight.photo_count.unwrap_or(0) {
                db.set_photo_count(flight.id, header).map_err(|e| e.to_string())?;
                chunk.updated += 1;
            }
        }
    }

    chunk.next_offset = end;
    chunk.done = end >= total;
    if chunk.done {
        db.set_setting(PHOTO_RECOUNT_SETTING, "done").map_err(|e| e.to_string())?;
    }
    Ok(chunk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_server_upload_prefix() {
        assert_eq!(
            original_name("882b1359-b224-4b7a-9d0a-ab7c3c7da640-DJIFlightRecord_2026-11-08_[18-54-42].txt"),
            "DJIFlightRecord_2026-11-08_[18-54-42].txt"
        );
        assert_eq!(original_name("DJIFlightRecord_2026-11-08_[18-54-42].txt"), "DJIFlightRecord_2026-11-08_[18-54-42].txt");
        assert_eq!(original_name("not-a-uuid-at-all-but-long-enough-to-check-x.txt"), "not-a-uuid-at-all-but-long-enough-to-check-x.txt");
    }

    #[test]
    fn only_plain_file_names_are_looked_up() {
        assert!(is_plain_file_name("DJIFlightRecord_2026-11-08_[18-54-42].txt"));
        for bad in ["../secret.txt", r"..\secret.txt", "/etc/passwd", r"C:\Windows\win.ini", r"\\server\share\x.txt", "a/b.txt", "..", ".", ""] {
            assert!(!is_plain_file_name(bad), "{} was accepted", bad);
        }
        let folder = std::env::temp_dir();
        assert!(find_original(&[folder], "../secret.txt", "00000000").is_none());
    }
}
