//! Profile password management — argon2id hashing & verification.
//!
//! Passwords are stored as argon2id hashes in `profile_auth.json` inside
//! the data directory.  The file maps profile names to their hash strings.
//! Profiles without an entry are considered unprotected.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

/// In-memory representation of `profile_auth.json`.
type AuthMap = HashMap<String, String>;

/// Return the path to the auth file inside `data_dir`.
fn auth_file(data_dir: &Path) -> PathBuf {
    data_dir.join("profile_auth.json")
}

/// Load the auth map from disk (empty map if the file doesn't exist).
fn load_auth(data_dir: &Path) -> AuthMap {
    let path = auth_file(data_dir);
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the auth map to disk.
fn save_auth(data_dir: &Path, map: &AuthMap) -> Result<(), String> {
    let path = auth_file(data_dir);
    let json = serde_json::to_string_pretty(map)
        .map_err(|e| format!("Failed to serialize auth data: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Hash a plaintext password with argon2id.
pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| format!("Password hashing failed: {}", e))
}

/// Verify a plaintext password against an argon2id hash.
pub fn verify_password(password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

// ────────────────────────────── public API ──────────────────────────────

/// Check whether a profile has a password set.
pub fn has_password(data_dir: &Path, profile: &str) -> bool {
    load_auth(data_dir).contains_key(profile)
}

/// Set (or change) the password for a profile.
/// If `current_password` is `Some`, the existing password must match first.
pub fn set_password(
    data_dir: &Path,
    profile: &str,
    new_password: &str,
    current_password: Option<&str>,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }
    let mut map = load_auth(data_dir);

    // If there's already a password, require the current one
    if let Some(existing_hash) = map.get(profile) {
        match current_password {
            Some(cur) if verify_password(cur, existing_hash) => { /* ok */ }
            Some(_) => return Err("Current password is incorrect".to_string()),
            None => return Err("Current password is required".to_string()),
        }
    }

    let hashed = hash_password(new_password)?;
    map.insert(profile.to_string(), hashed);
    save_auth(data_dir, &map)?;
    log::info!("Password set for profile '{}'", profile);
    Ok(())
}

/// Remove the password for a profile (requires current password).
pub fn remove_password(data_dir: &Path, profile: &str, current_password: &str) -> Result<(), String> {
    let mut map = load_auth(data_dir);
    match map.get(profile) {
        Some(hash) if verify_password(current_password, hash) => {
            map.remove(profile);
            save_auth(data_dir, &map)?;
            log::info!("Password removed for profile '{}'", profile);
            Ok(())
        }
        Some(_) => Err("Current password is incorrect".to_string()),
        None => {
            // No password set — nothing to remove
            Ok(())
        }
    }
}

/// Verify that `password` is correct for `profile`.
/// Returns `Ok(())` on success, `Err` with a user-facing message otherwise.
pub fn verify_profile_password(data_dir: &Path, profile: &str, password: &str) -> Result<(), String> {
    let map = load_auth(data_dir);
    match map.get(profile) {
        Some(hash) => {
            if verify_password(password, hash) {
                Ok(())
            } else {
                log::warn!("Failed password attempt for profile '{}'", profile);
                Err("Incorrect password".to_string())
            }
        }
        None => Ok(()), // no password — always allowed
    }
}

/// Returns true if the profile requires a password to access.
pub fn profile_is_protected(data_dir: &Path, profile: &str) -> bool {
    has_password(data_dir, profile)
}

/// Move a profile's password entry to its new name when the profile is renamed.
pub fn rename_auth_entry(data_dir: &Path, old: &str, new: &str) -> Result<(), String> {
    let mut map = load_auth(data_dir);
    if let Some(hash) = map.remove(old) {
        map.insert(new.to_string(), hash);
        save_auth(data_dir, &map)?;
        log::info!("Moved auth entry from profile '{}' to '{}'", old, new);
    }
    Ok(())
}

/// Clean up auth entry when a profile is deleted.
pub fn remove_auth_entry(data_dir: &Path, profile: &str) {
    let mut map = load_auth(data_dir);
    if map.remove(profile).is_some() {
        let _ = save_auth(data_dir, &map);
        log::info!("Removed auth entry for deleted profile '{}'", profile);
    }
}
