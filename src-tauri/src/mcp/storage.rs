//! Application-owned pairing grants. Raw bearer tokens are never persisted.
use chrono::{Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{Mutex, OnceLock},
};

static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Store {
    #[serde(default)]
    pub desktop_enabled: bool,
    #[serde(default)]
    pub grants: Vec<Grant>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    pub name: String,
    pub profile: String,
    pub timezone: String,
    pub created_at: String,
    pub expires_at: String,
    hash: String,
    auth_fingerprint: String,
}
impl Grant {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"name":self.name,"profile":self.profile,
            "timezone":self.timezone,"created_at":self.created_at,"expires_at":self.expires_at})
    }
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn read(root: &Path) -> Result<Store, String> {
    let path = root.join("mcp/access.json");
    if !path.exists() {
        return Ok(Store::default());
    }
    let data = fs::read(path).map_err(|_| "Cannot read MCP access settings")?;
    if data.len() > 1024 * 1024 {
        return Err("MCP access settings exceed their size limit".into());
    }
    serde_json::from_slice(&data)
        .map_err(|_| "Invalid MCP access settings; access is disabled".into())
}
fn write(root: &Path, store: &Store) -> Result<(), String> {
    let dir = root.join("mcp");
    fs::create_dir_all(&dir).map_err(|_| "Cannot create MCP access directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot secure MCP access directory")?;
    }
    let path = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "Cannot create MCP access settings")?;
        file.write_all(
            &serde_json::to_vec(store).map_err(|_| "Cannot encode MCP access settings")?,
        )
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist MCP access settings")?;
        fs::rename(&path, dir.join("access.json")).map_err(|_| "Cannot replace MCP access settings")
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result.map_err(str::to_string)
}
fn fingerprint(root: &Path, profile: &str) -> Result<String, String> {
    let path = root.join("profile_auth.json");
    let auth: serde_json::Value = if path.exists() {
        serde_json::from_slice(
            &fs::read(path).map_err(|_| "Cannot validate profile authorization")?,
        )
        .map_err(|_| "Cannot validate profile authorization")?
    } else {
        serde_json::json!({})
    };
    if !auth.is_object() || (!auth[profile].is_null() && !auth[profile].is_string()) {
        return Err("Cannot validate profile authorization".into());
    }
    Ok(digest(
        serde_json::to_vec(&auth[profile]).map_err(|_| "Cannot validate profile authorization")?,
    ))
}
pub fn inspect(root: &Path) -> Result<Store, String> {
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "MCP access unavailable")?;
    read(root)
}
pub fn set_enabled(root: &Path, enabled: bool) -> Result<(), String> {
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "MCP access unavailable")?;
    let mut store = read(root)?;
    store.desktop_enabled = enabled;
    write(root, &store)
}
pub fn generate(
    root: &Path,
    profile: &str,
    name: &str,
    timezone: &str,
) -> Result<(String, Grant), String> {
    if name.trim().is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Connection name must contain 1–80 characters".into());
    }
    timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| "Unknown IANA timezone")?;
    if profile != "default" {
        crate::database::validate_profile_name(profile)?;
    }
    if !crate::database::profile_exists(root, profile) {
        return Err("Profile no longer exists".into());
    }
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "MCP access unavailable")?;
    let mut store = read(root)?;
    // Use the same parsed expiry and authorization checks as validation/status.
    // Invalid grants must not consume invisible quota after a password change.
    store
        .grants
        .retain(|g| is_current(root, g).unwrap_or(false));
    if store.grants.len() >= 1000
        || store.grants.iter().filter(|g| g.profile == profile).count() >= 10
    {
        return Err(
            "Revoke an existing connection before creating another (maximum 10 per profile)".into(),
        );
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = format!(
        "odl_mcp_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let grant = Grant {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().into(),
        profile: profile.into(),
        timezone: timezone.into(),
        created_at: Utc::now().to_rfc3339(),
        expires_at: (Utc::now() + Duration::days(90)).to_rfc3339(),
        hash: digest(&token),
        auth_fingerprint: fingerprint(root, profile)?,
    };
    store.grants.push(grant.clone());
    write(root, &store)?;
    Ok((token, grant))
}
pub fn validate(root: &Path, token: &str) -> Result<Grant, String> {
    if !token.starts_with("odl_mcp_") || token.len() != 72 {
        return Err("Invalid MCP token".into());
    }
    let store = inspect(root)?;
    let hash = digest(token);
    let grant = store
        .grants
        .into_iter()
        .find(|g| g.hash == hash)
        .ok_or("Invalid or revoked MCP token")?;
    if !is_current(root, &grant)? {
        return Err("MCP token expired or profile authorization changed".into());
    }
    Ok(grant)
}
pub fn revoke(root: &Path, profile: &str, id: Option<&str>) -> Result<(), String> {
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "MCP access unavailable")?;
    let mut store = read(root)?;
    store
        .grants
        .retain(|g| g.profile != profile || id.is_some_and(|id| g.id != id));
    if root.join("mcp/access.json").exists() {
        write(root, &store)?;
    }
    Ok(())
}

/// Serialize password changes with token generation. Persist revocation first,
/// so a failed access-store write cannot leave resurrectable grants behind.
pub fn change_authorization(
    root: &Path,
    profile: &str,
    change: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "MCP access unavailable")?;
    let mut store = read(root)?;
    store.grants.retain(|grant| grant.profile != profile);
    if root.join("mcp/access.json").exists() {
        write(root, &store)?;
    }
    change()
}

pub fn is_current(root: &Path, grant: &Grant) -> Result<bool, String> {
    if grant.profile != "default" {
        crate::database::validate_profile_name(&grant.profile)?;
    }
    let expiry = chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
        .map_err(|_| "Invalid MCP token expiry")?;
    Ok(expiry > Utc::now()
        && crate::database::profile_exists(root, &grant.profile)
        && grant.auth_fingerprint == fingerprint(root, &grant.profile)?)
}
