//! In-memory session store for authenticated profile access (web mode).
//!
//! When a profile is password-protected, the user must authenticate via
//! `POST /api/profiles/switch` with the correct password.  On success a
//! 256-bit random session token is issued and stored here.  Subsequent
//! requests to profile-scoped API endpoints include the token in the
//! `X-Session` header; the `ProfileDb` extractor validates it before
//! granting access.
//!
//! Sessions expire after 24 hours.  A per-profile lockout engages after
//! 5 consecutive failed password attempts, blocking further attempts for
//! 60 seconds.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use rand::Rng;

// ────────────────────────────── Constants ──────────────────────────────

const DEFAULT_SESSION_TTL_HOURS: u64 = 24;
const MAX_FAILURES: u32 = 5;
const LOCKOUT_DURATION: Duration = Duration::from_secs(60);

/// Read `SESSION_TTL_HOURS` from the environment (once) and return the
/// configured TTL.  Falls back to 24 h when the var is absent or invalid.
fn session_ttl() -> Duration {
    use std::sync::OnceLock;
    static TTL: OnceLock<Duration> = OnceLock::new();
    *TTL.get_or_init(|| {
        let hours = std::env::var("SESSION_TTL_HOURS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_SESSION_TTL_HOURS);
        log::info!("Session TTL configured to {} hour(s)", hours);
        Duration::from_secs(hours * 3600)
    })
}

// ────────────────────────────── Types ──────────────────────────────────

struct Session {
    profile: String,
    created: Instant,
}

struct FailureRecord {
    count: u32,
    last_attempt: Instant,
}

// ────────────────────────────── Store ─────────────────────────────────

pub struct SessionStore {
    /// token → session
    sessions: RwLock<HashMap<String, Session>>,
    /// profile → failure record
    failures: RwLock<HashMap<String, FailureRecord>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            failures: RwLock::new(HashMap::new()),
        }
    }

    // ── Token lifecycle ──

    /// Create a session for `profile` and return the opaque token.
    pub fn create_session(&self, profile: &str) -> String {
        let token = generate_token();
        let session = Session {
            profile: profile.to_string(),
            created: Instant::now(),
        };
        self.sessions
            .write()
            .unwrap()
            .insert(token.clone(), session);
        // Clear failure count on successful login
        self.failures.write().unwrap().remove(profile);
        token
    }

    /// Validate a token.  Returns `Some(profile)` if valid & not expired.
    pub fn validate(&self, token: &str) -> Option<String> {
        let sessions = self.sessions.read().unwrap();
        sessions.get(token).and_then(|s| {
            if s.created.elapsed() < session_ttl() {
                Some(s.profile.clone())
            } else {
                None
            }
        })
    }

    /// Revoke all sessions for a given profile (e.g. on password change).
    pub fn revoke_profile(&self, profile: &str) {
        let mut sessions = self.sessions.write().unwrap();
        sessions.retain(|_, s| s.profile != profile);
    }

    /// Revoke a specific session token.
    #[allow(dead_code)]
    pub fn revoke_token(&self, token: &str) {
        self.sessions.write().unwrap().remove(token);
    }

    /// Periodically purge expired sessions (call from a background task).
    #[allow(dead_code)]
    pub fn purge_expired(&self) {
        let mut sessions = self.sessions.write().unwrap();
        sessions.retain(|_, s| s.created.elapsed() < session_ttl());
    }

    // ── Lockout ──

    /// Record a failed password attempt.  Returns `true` if the profile
    /// is now locked out.
    pub fn record_failure(&self, profile: &str) -> bool {
        let mut failures = self.failures.write().unwrap();
        let rec = failures
            .entry(profile.to_string())
            .or_insert(FailureRecord {
                count: 0,
                last_attempt: Instant::now(),
            });
        // If the lockout window has passed, reset the counter
        if rec.last_attempt.elapsed() > LOCKOUT_DURATION {
            rec.count = 0;
        }
        rec.count += 1;
        rec.last_attempt = Instant::now();
        rec.count >= MAX_FAILURES
    }

    /// Check whether a profile is currently locked out.
    pub fn is_locked_out(&self, profile: &str) -> bool {
        let failures = self.failures.read().unwrap();
        match failures.get(profile) {
            Some(rec) if rec.count >= MAX_FAILURES => rec.last_attempt.elapsed() < LOCKOUT_DURATION,
            _ => false,
        }
    }
}

// ────────────────────────────── Helpers ───────────────────────────────

/// Generate a cryptographically random 256-bit token (base64url-encoded).
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64_url_encode(&bytes)
}

/// Minimal base64url encoding (no padding, URL-safe alphabet).
fn base64_url_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() * 4 + 2) / 3);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(triple & 0x3F) as usize] as char);
        }
    }
    out
}
