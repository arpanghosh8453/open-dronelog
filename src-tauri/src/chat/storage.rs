//! Profile-scoped authenticated encryption. Never part of flight backup/export.
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

static STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORAGE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Chat storage unavailable".into())
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}
fn directory(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("chat");
    fs::create_dir_all(&dir).map_err(|_| "Cannot create chat storage".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot secure chat storage")?;
    }
    Ok(dir)
}
fn key(dir: &Path) -> Result<aead::LessSafeKey, String> {
    let path = dir.join("master.key");
    let bytes = if path.exists() {
        fs::read(&path).map_err(|_| "Cannot read chat encryption key".to_string())?
    } else {
        if fs::read_dir(dir)
            .map_err(|_| "Cannot inspect chat storage")?
            .filter_map(Result::ok)
            .any(|entry| entry.path().extension().is_some_and(|ext| ext == "enc"))
        {
            return Err(
                "Chat encryption key missing; restore chat/master.key before saving any profile"
                    .into(),
            );
        }
        let mut bytes = vec![0u8; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "Secure random generator unavailable")?;
        let mut file = private_options()
            .open(&path)
            .map_err(|_| "Cannot create chat encryption key".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist chat encryption key".to_string())?;
        bytes
    };
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes).map_err(|_| {
        "Invalid chat encryption key; restore the original chat/master.key".to_string()
    })?;
    Ok(aead::LessSafeKey::new(unbound))
}
fn profile_path(dir: &Path, profile: &str) -> PathBuf {
    dir.join(format!("{:x}.enc", Sha256::digest(profile.as_bytes())))
}
pub fn read<T: DeserializeOwned + Default>(root: &Path, profile: &str) -> Result<T, String> {
    let _lock = lock()?;
    read_unlocked(root, profile)
}
fn read_unlocked<T: DeserializeOwned + Default>(root: &Path, profile: &str) -> Result<T, String> {
    let dir = directory(root)?;
    let path = profile_path(&dir, profile);
    if !path.exists() {
        return Ok(T::default());
    }
    let mut data = fs::read(path).map_err(|_| "Cannot read encrypted chat storage".to_string())?;
    if data.len() < 29 || data[0] != 1 {
        return Err("Invalid encrypted chat storage".into());
    }
    // Never generate a replacement key when ciphertext already exists.
    if !dir.join("master.key").exists() {
        return Err("Chat encryption key missing; restore chat/master.key".into());
    }
    let nonce: [u8; 12] = data[1..13].try_into().map_err(|_| "Invalid chat nonce")?;
    let plaintext = key(&dir)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(profile.as_bytes()),
            &mut data[13..],
        )
        .map_err(|_| {
            "Unable to decrypt chat storage; check the server encryption key".to_string()
        })?;
    serde_json::from_slice(plaintext).map_err(|_| "Invalid chat storage format".into())
}
pub fn update<T: DeserializeOwned + Serialize + Default, R>(
    root: &Path,
    profile: &str,
    change: impl FnOnce(&mut T) -> Result<R, String>,
) -> Result<R, String> {
    let _lock = lock()?;
    let mut value: T = read_unlocked(root, profile)?;
    let result = change(&mut value)?;
    let dir = directory(root)?;
    let mut nonce = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "Secure random generator unavailable")?;
    let mut data = serde_json::to_vec(&value).map_err(|_| "Cannot encode chat storage")?;
    if data.len() > 16 * 1024 * 1024 {
        return Err("Chat storage full. Delete older conversations to continue.".into());
    }
    key(&dir)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(profile.as_bytes()),
            &mut data,
        )
        .map_err(|_| "Cannot encrypt chat storage")?;
    let tmp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = private_options()
        .open(&tmp)
        .map_err(|_| "Cannot write chat storage")?;
    let write_result = (|| {
        file.write_all(&[1])?;
        file.write_all(&nonce)?;
        file.write_all(&data)?;
        file.sync_all()?;
        replace_file(&tmp, &profile_path(&dir, profile))
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result.map_err(|_| "Cannot persist encrypted chat storage".to_string())?;
    Ok(result)
}
pub fn remove(root: &Path, profile: &str) -> Result<(), String> {
    let _lock = lock()?;
    let path = profile_path(&root.join("chat"), profile);
    if path.exists() {
        fs::remove_file(path).map_err(|_| "Cannot remove profile chat storage")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[test]
    fn encrypted_round_trip_profile_binding_and_tamper_detection() {
        let dir = tempfile::tempdir().unwrap();
        update::<Value, _>(dir.path(), "pilot", |v| {
            *v = json!({"api_key":"secret-example"});
            Ok(())
        })
        .unwrap();
        let path = profile_path(&dir.path().join("chat"), "pilot");
        let bytes = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("secret-example"));
        assert_eq!(
            read::<Value>(dir.path(), "pilot").unwrap()["api_key"],
            "secret-example"
        );
        fs::copy(&path, profile_path(&dir.path().join("chat"), "other")).unwrap();
        assert!(read::<Value>(dir.path(), "other").is_err());
        let mut corrupt = bytes;
        *corrupt.last_mut().unwrap() ^= 1;
        fs::write(path, corrupt).unwrap();
        assert!(read::<Value>(dir.path(), "pilot").is_err());
    }
    #[test]
    fn missing_key_does_not_replace_existing_ciphertext_key() {
        let dir = tempfile::tempdir().unwrap();
        update::<Value, _>(dir.path(), "a", |v| {
            *v = json!({"secret": 1});
            Ok(())
        })
        .unwrap();
        fs::remove_file(dir.path().join("chat/master.key")).unwrap();
        assert!(read::<Value>(dir.path(), "a").is_err());
        assert!(update::<Value, _>(dir.path(), "new-profile", |v| {
            *v = json!({"secret":2});
            Ok(())
        })
        .is_err());
        assert!(!dir.path().join("chat/master.key").exists());
    }
}

// Replace existing vaults atomically on Windows too (std::fs::rename does not).
#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}
