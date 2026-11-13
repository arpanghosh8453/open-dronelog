# API Reference

This document lists all API endpoints available in the Open DroneLog application. The application supports two modes:

- **Desktop (Tauri)**: Uses Tauri IPC commands via `@tauri-apps/api`
- **Web/Docker (Axum)**: Uses REST API endpoints via HTTP

The frontend automatically routes to the appropriate backend based on the deployment mode.

---

## Table of Contents

- [Flight Management](#flight-management)
- [Telemetry and Data](#telemetry-and-data)
- [Tags](#tags)
- [Settings](#settings)
- [Profiles and Authentication](#profiles-and-authentication)
- [Backup and Restore](#backup-and-restore)
- [Sync (Web Mode Only)](#sync-web-mode-only)
- [Equipment Names](#equipment-names)
- [Utility Endpoints](#utility-endpoints)

---

## Flight Management

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| POST | `/api/import` | Upload and import a flight log file (multipart/form-data). Returns `ImportResult` with success status, flight ID, message, and point count. |
| POST | `/api/manual_flight` | Create a manual flight entry without a log file. Requires aircraft name, serials, coordinates, and duration. |
| GET | `/api/flights` | List all flights in the database. Returns array of `Flight` objects with metadata. |
| DELETE | `/api/flights/delete?flight_id={id}` | Delete a single flight by ID. Removes flight metadata, telemetry, tags, and messages. |
| DELETE | `/api/flights/delete_all` | Delete all flights from the database. Requires confirmation in UI. |
| POST | `/api/flights/deduplicate` | Remove duplicate flights based on drone serial + battery serial + start time. Returns count of removed duplicates. |
| PUT | `/api/flights/name` | Update flight display name. Body: `{ flight_id, display_name }` |
| PUT | `/api/flights/notes` | Update flight notes. Body: `{ flight_id, notes }` |
| PUT | `/api/flights/color` | Update custom color for a flight. Body: `{ flight_id, color }` |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `import_log` | `file_path: String` | Import a local flight log file |
| `create_manual_flight` | `flight_title?, aircraft_name, drone_serial, battery_serial, start_time, duration_secs, total_distance?, max_altitude?, home_lat, home_lon, notes?` | Create manual entry |
| `get_flights` | - | Get all flights |
| `delete_flight` | `flight_id: i64` | Delete single flight |
| `delete_all_flights` | - | Delete all flights |
| `deduplicate_flights` | - | Remove duplicates |
| `update_flight_name` | `flight_id: i64, display_name: String` | Rename flight |
| `update_flight_notes` | `flight_id: i64, notes: Option<String>` | Update notes |
| `update_flight_color` | `flight_id: i64, color: String` | Update flight color |
| `compute_file_hash` | `file_path: String` | Compute SHA256 hash of a file |

### Note on Exports
File exports (CSV, JSON, GPX, KML, HTML Report) are generated entirely on the frontend (client-side) using `src/lib/exportUtils.ts` and `src/lib/htmlReportBuilder.ts`. There are no dedicated backend API endpoints for exports; the frontend requests data via `GET /api/flight_data` and packages the files locally.

---

## Telemetry and Data

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| GET | `/api/flight_data?flight_id={id}&max_points={n}` | Get flight details with telemetry data. Returns `FlightDataResponse` containing flight metadata, telemetry arrays, track coordinates, and messages. `max_points` limits downsampling (default ~5000). |
| GET | `/api/overview` | Get aggregate statistics across all flights. Returns `OverviewStats` with totals for flights, distance, time, and max values. |
| GET | `/api/battery_capacity_history?battery_serial={serial}` | Get full-charge capacity history for a specific battery. Returns array of `[flight_id, start_time, max_capacity]` tuples across all flights using that battery. |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `get_flight_data` | `flight_id: i64, max_points: Option<usize>` | Get flight telemetry |
| `get_overview_stats` | - | Get aggregate statistics |
| `get_battery_full_capacity_history` | `battery_serial: String` | Get capacity history for a battery |

### Telemetry Data Structure

The telemetry response includes these arrays (all keyed by index):

| Field | Type | Description |
|-------|------|-------------|
| `time` | `i64[]` | Timestamp in milliseconds since flight start |
| `latitude` | `f64[]` | GPS latitude |
| `longitude` | `f64[]` | GPS longitude |
| `height` | `f64[]` | Height above takeoff (meters) |
| `vpsHeight` | `f64[]` | Visual Positioning System height |
| `altitude` | `f64[]` | Absolute altitude (GPS) |
| `speed` | `f64[]` | Ground speed (m/s) |
| `velocityX/Y/Z` | `f64[]` | Velocity components |
| `battery` | `i32[]` | Battery percentage |
| `batteryVoltage` | `f64[]` | Battery voltage (V) |
| `batteryTemp` | `f64[]` | Battery temperature (°C) |
| `cellVoltages` | `f64[][]` | Per-cell voltages (array per frame) |
| `pitch/roll/yaw` | `f64[]` | Aircraft attitude (degrees) |
| `gimbalPitch/gimbalRoll/gimbalYaw` | `f64[]` | Gimbal attitude (degrees) |
| `rcSignal` | `i32[]` | Remote controller signal strength |
| `rcUplink/rcDownlink` | `i32[]` | Signal quality metrics |
| `satellites` | `i32[]` | GPS satellite count |
| `distanceToHome` | `f64[]` | Distance from takeoff (meters) |
| `isPhoto` | `bool[]` | Photo capture state per frame |
| `isVideo` | `bool[]` | Video recording state per frame |
| `batteryFullCapacity` | `f64[]` | Battery design/full capacity (mAh) |
| `batteryRemainedCapacity` | `f64[]` | Remaining usable capacity (mAh) |

---

## Tags

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| POST | `/api/flights/tags/add` | Add a manual tag to a flight. Body: `{ flight_id, tag }`. Returns updated tag list. |
| POST | `/api/flights/tags/remove` | Remove a tag from a flight. Body: `{ flight_id, tag }`. Returns updated tag list. |
| GET | `/api/tags` | Get all unique tags across all flights (both auto and manual). |
| POST | `/api/tags/remove_auto` | Remove all auto-generated tags from all flights. Preserves manual tags. |
| POST | `/api/regenerate_smart_tags` | Regenerate auto tags for all flights based on current settings. |
| POST | `/api/regenerate_flight_smart_tags/{id}` | Regenerate auto tags for a single flight. |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `add_flight_tag` | `flight_id: i64, tag: String` | Add manual tag |
| `remove_flight_tag` | `flight_id: i64, tag: String` | Remove tag |
| `get_all_tags` | - | Get all unique tags |
| `remove_all_auto_tags` | - | Remove auto tags from all flights |
| `regenerate_all_smart_tags` | - | Regenerate all auto tags |
| `regenerate_flight_smart_tags` | `flight_id: i64, enabled_tag_types: Option<Vec<String>>` | Regenerate for one flight |

### Tag Types

- **Auto tags** (teal): Generated on import based on flight characteristics
  - Night Flight, High Speed, Cold Battery, Heavy Load, Low Battery
  - High Altitude, Long Distance, Long Flight, Short Flight
  - Aggressive Flying, No GPS, M-SDK
  - Location tags: city, country, continent
- **Manual tags** (violet): User-created tags

---

## Settings

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| GET | `/api/settings/smart_tags` | Check if smart tags are enabled. Returns boolean. |
| POST | `/api/settings/smart_tags` | Set smart tags enabled. Body: `{ enabled: boolean }` |
| GET | `/api/settings/enabled_tag_types` | Get list of enabled smart tag types. |
| POST | `/api/settings/enabled_tag_types` | Set enabled tag types. Body: `{ types: string[] }` |
| GET | `/api/settings/value?key={key}` | Get a profile-scoped value from the DB `settings` table. Returns `{ value: string \| null }`. |
| POST | `/api/settings/value` | Set a profile-scoped value in the DB `settings` table. Body: `{ key, value }` |
| GET | `/api/has_api_key` | Check if DJI API key is configured. |
| GET | `/api/api_key_type` | Get API key type: "None", "Default", or "Personal". |
| POST | `/api/set_api_key` | Save DJI API key. Body: `{ api_key: string }` |
| DELETE | `/api/remove_api_key` | Remove saved API key (reverts to default). |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `get_smart_tags_enabled` | - | Check smart tags setting |
| `set_smart_tags_enabled` | `enabled: bool` | Toggle smart tags |
| `get_enabled_tag_types` | - | Get enabled tag types |
| `set_enabled_tag_types` | `types: Vec<String>` | Set enabled tag types |
| `get_setting_value` | `key: String` | Get profile-scoped setting value from DB |
| `set_setting_value` | `key: String, value: String` | Set profile-scoped setting value in DB |
| `has_api_key` | - | Check API key presence |
| `get_api_key_type` | - | Get API key type |
| `set_api_key` | `api_key: String` | Save API key |
| `remove_api_key` | - | Remove API key |
| `get_keep_upload_settings` | - | Get keep uploaded files settings |
| `set_keep_upload_settings` | `enabled: bool, folder_path: Option<String>` | Set keep files settings |

---

## Profiles and Authentication

All data operations use the active profile. In web/Docker mode, the active profile is determined by the `X-Profile` and `X-Session` headers. In desktop mode, profiles are managed via Tauri IPC commands.

### Profile Management

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| GET | `/api/profiles` | List all profiles. Returns array of `ProfileInfo` objects with `name` and `hasPassword` fields. |
| POST | `/api/profiles/switch` | Create or switch to a profile. Body: `{ name, create?, password?, new_password?, master_password? }`. Returns `{ name, session? }`. |
| DELETE | `/api/profiles/delete?name={name}&password={pw}&master_password={mp}` | Delete a profile. Requires profile password (if set) and master password (if configured). |
| GET | `/api/profiles/active` | Get the name of the currently active profile. |

### Password Management

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| POST | `/api/profiles/set_password` | Set or change profile password. Body: `{ profile, new_password, current_password?, session? }` |
| POST | `/api/profiles/remove_password` | Remove profile password. Body: `{ profile, current_password }` |
| GET | `/api/profiles/has_master_password` | Check if `PROFILE_CREATION_PASS` env var is configured. Returns boolean. |
| GET | `/api/manager/enabled` | Whether the all-profiles overview is available (`MANAGER_OVERVIEW=true` and `PROFILE_CREATION_PASS` set). Returns boolean. |
| POST | `/api/manager/overview` | Flight totals for every profile. Body: `{ master_password }`. Returns 404 when disabled, 403 for a wrong password, 429 during lockout. |

### Profile Security Environment Variables (Web/Docker)

| Variable | Description |
|----------|-------------|
| `PROFILE_CREATION_PASS` | Requires a master password to create/delete profiles. |
| `MANAGER_OVERVIEW` | Set to `true` to enable the read-only all-profiles overview, unlocked with the master password. Needs `PROFILE_CREATION_PASS`. |
| `DEFAULT_PROFILE_PASSWORD` | Optional one-time initializer for the `default` profile password at startup. If `default` already has a password, initialization is skipped and the existing password is preserved. If unset or empty (and no existing password), `default` remains unprotected. |
| `SESSION_TTL_HOURS` | Session lifetime after successful profile authentication. |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `list_profiles` | - | List profiles with password status |
| `switch_profile` | `name: String, create: Option<bool>, password: Option<String>, new_password: Option<String>` | Switch or create profile |
| `delete_profile` | `name: String, password: Option<String>` | Delete profile |
| `get_active_profile` | - | Get active profile name |
| `set_profile_password` | `profile: String, new_password: String, current_password: Option<String>` | Set/change password |
| `remove_profile_password` | `profile: String, current_password: String` | Remove password |
| `lock_profile` | - | Lock the active profile (desktop auto-logout on close) |
| `unlock_profile` | `password: String` | Unlock a locked profile with the correct password |
| `is_app_locked` | - | Check if the current profile is locked (returns boolean) |

### Authentication Flow (Web/Docker)

1. Client sends `X-Profile: <name>` header with every request
2. If the profile is password-protected, the client must first authenticate via `POST /api/profiles/switch` with the correct `password`
3. On success, the server returns a session token in `{ session: "<token>" }`
4. Client stores the token using a hybrid strategy: `sessionStorage` for per-tab isolation, plus `localStorage` as a persistent fallback so sessions survive browser restarts. Each tab reads its own `sessionStorage` first, falling back to `localStorage` for freshly opened tabs.
5. The token is sent as `X-Session: <token>` with all subsequent requests
6. The `ProfileDb` extractor validates the session token and routes the request to the correct profile database
7. Sessions expire after **24 hours** (configurable via `SESSION_TTL_HOURS` env var); a new login is required after expiry
8. On a **401 response** (expired or invalid token), the client automatically clears the stored token and displays the login overlay

### Lockout Policy

- **5 consecutive failed** password attempts lock the profile for **60 seconds**
- During lockout, all authentication attempts are rejected with a `429 Too Many Requests` status

### Response Types

```typescript
interface ProfileInfo {
  name: string;
  hasPassword: boolean;
}

interface SwitchProfileResponse {
  name: string;
  session?: string;  // Present when profile is password-protected
}
```

---

## Backup and Restore

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| GET | `/api/backup` | Download database backup as `.backup` file (gzip-compressed tar of Parquet files). |
| POST | `/api/backup/restore` | Upload and restore a backup file (multipart/form-data). Returns status message. |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `export_backup` | `dest_path: String` | Export backup to file path |
| `import_backup` | `src_path: String` | Import backup from file path |

### Backup Contents

The backup archive includes:
- `flights.parquet` - Flight metadata
- `telemetry.parquet` - All telemetry data
- `flight_tags.parquet` - Tags (auto and manual)
- `keychains.parquet` - Cached DJI encryption keys
- `flight_messages.parquet` - Flight tips and warnings
- `equipment_names.parquet` - Custom drone/battery names
- `flight_customizations.parquet` - Persistent renamed titles, notes, colors, and manual tags keyed by file hash
- `settings.parquet` - Profile-scoped key-value settings (includes saved filter profiles and app flags)

---

## Sync (Web Mode Only)

These endpoints are only available in Docker/web deployment mode.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sync/config` | Get sync folder configuration. Returns `{ syncPath: string \| null }` |
| GET | `/api/sync/blacklist` | Get persisted sync blacklist hashes for active profile. |
| POST | `/api/sync/blacklist` | Add hash to sync blacklist. Body: `{ fileHash: string }` |
| DELETE | `/api/sync/blacklist?file_hash=...` | Remove one hash from sync blacklist. |
| DELETE | `/api/sync/blacklist/all` | Clear sync blacklist. |
| GET | `/api/sync/files` | List files in sync folder that haven't been imported yet. |
| POST | `/api/sync/file` | Import a single file from the sync folder. Body: `{ filename: string }` |
| POST | `/api/sync` | Import all pending files from the sync folder. |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SYNC_LOGS_PATH` | Path to folder containing flight logs to sync |
| `SYNC_INTERVAL` | Cron expression for automatic sync (e.g., `0 0 */8 * * *`) |
| `DEFAULT_PROFILE_PASSWORD` | Optional one-time initializer for the `default` profile password in web/Docker startup; does not overwrite an existing password |

---

## Equipment Names

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| GET | `/api/equipment_names` | Get all custom drone and battery names. Returns tuple of `(batteries, drones)`. |
| POST | `/api/equipment_names` | Set custom name for equipment. Body: `{ serial, equipment_type, display_name }` |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `get_equipment_names` | - | Get all custom names |
| `set_equipment_name` | `serial: String, equipment_type: String, display_name: String` | Set custom name |

---

## Utility Endpoints

| Method | Endpoint / Command | Description |
|--------|-------------------|-------------|
| GET | `/api/app_data_dir` | Get the application data directory path. |
| GET | `/api/battery_pairs` | Get normalized battery serial pair definitions from `battery-pair.json` (web mode). |
| GET | `/api/app_log_dir` | Get the application log directory path. |

### Tauri Commands (Desktop)

| Command | Parameters | Description |
|---------|------------|-------------|
| `get_app_data_dir` | - | Get data directory |
| `get_battery_pairs` | - | Get normalized battery serial pair definitions from `battery-pair.json` |
| `get_app_log_dir` | - | Get log directory |

---

## Response Types

### ImportResult

```typescript
interface ImportResult {
  success: boolean;
  flight_id: number | null;
  message: string;
  point_count: number;
  file_hash: string | null;
}
```

### Flight

```typescript
interface Flight {
  id: number;
  fileName: string;
  displayName: string;
  droneModel?: string;
  droneSerial?: string;
  aircraftName?: string;
  batterySerial?: string;
  startTime?: string;
  durationSecs?: number;
  totalDistance?: number;
  maxAltitude?: number;
  maxSpeed?: number;
  homeLat?: number;
  homeLon?: number;
  pointCount?: number;
  photoCount?: number;
  videoCount?: number;
  tags?: FlightTag[];
  color?: string;
  notes?: string;
  cycleCount?: number;
  rcSerial?: string;      // Remote controller serial number
  batteryLife?: number;   // Battery capacity/life percentage
}
```

### FlightTag

```typescript
interface FlightTag {
  tag: string;
  tagType: 'auto' | 'manual';
}
```

### OverviewStats

```typescript
interface OverviewStats {
  totalFlights: number;
  totalDistanceM: number;
  totalDurationSecs: number;
  maxAltitudeM: number;
  maxDistanceM: number;
  maxSpeedMs: number;
  avgDistanceM: number;
  avgDurationSecs: number;
  totalDataPoints: number;
  totalPhotos: number;
  totalVideos: number;
  batteriesUsed: BatteryUsage[];
  dronesUsed: DroneUsage[];
  flightsByDate: FlightDateCount[];
  topFlights: TopFlight[];
  topDistanceFlights: TopDistanceFlight[];
  batteryHealthPoints: BatteryHealthPoint[];
}

interface BatteryUsage {
  batterySerial: string;
  flightCount: number;
  totalDurationSecs: number;
  maxCycleCount: number | null; // From DJI SmartBatteryStatic loop_times
}
```

### FlightMessage

```typescript
interface FlightMessage {
  timestampMs: number;       // Milliseconds from flight start
  messageType: 'tip' | 'warn' | 'caution';
  message: string;
}
```

### FlightDataResponse

Returned by `GET /api/flight_data` and the `get_flight_data` Tauri command.

```typescript
interface FlightDataResponse {
  flight: Flight;
  telemetry: TelemetryData;        // Arrays of values per telemetry field, same length
  track: [number, number, number][]; // [longitude, latitude, altitude] tuples
  messages?: FlightMessage[];
}
```

`TelemetryData` contains parallel arrays (one value per telemetry frame) for fields such as `time`, `latitude`, `longitude`, `height`, `speed`, `battery`, `batteryVoltage`, `batteryTemp`, `cellVoltages`, `pitch`, `roll`, `yaw`, `rcSignal`, `satellites`, `distanceToHome`, and others. All arrays share the same length as `time`.

---

## Error Handling

All endpoints return errors in this format:

- **Tauri**: Errors thrown as strings via `Result<T, String>`
- **HTTP**: Status codes with JSON error body `{ "error": "message" }`

Common error scenarios:
- `404` - Flight not found
- `400` - Invalid parameters
- `500` - Database or parsing error

---

## Rate Limits

- DJI API key fetch: Subject to DJI API rate limits
- Local operations: No limits (all processing is local)

---

## Authentication

The application supports optional per-profile password protection:

- **Desktop**: Passwords are verified locally via Tauri IPC commands. No session tokens are used.
- **Docker/Web**: Password-protected profiles require authentication via `POST /api/profiles/switch`. A session token is issued and must be sent as `X-Session` header. Unprotected profiles work without authentication.

### Headers (Web/Docker)

| Header | Required | Description |
|--------|----------|-------------|
| `X-Profile` | Always | The active profile name (defaults to `default`) |
| `X-Session` | When profile is protected | Session token from successful authentication |

### Data Storage

All data is stored locally:
- **Desktop**: `~/.local/share/com.drone-logbook.app/`
- **Docker**: `/data/drone-logbook/` (persistent volume)
- **Password hashes**: Stored in `profile_auth.json` (argon2id)
- **Sessions**: In-memory only (lost on server restart)

The DJI API key (for log decryption) is stored in `config.json` and never sent anywhere except the official DJI API.

### Security Limitations

> [!WARNING]
> Open DroneLog does **not** include built-in TLS. For internet-facing deployments, always use a reverse proxy with TLS termination.

| Area | Limitation |
|------|------------|
| **Transport** | No TLS — passwords and tokens are plaintext over HTTP |
| **Sessions** | In-memory; server restart invalidates all sessions |
| **Rate limiting** | Per-profile lockout only (5 attempts / 60s); no global IP-based limiting |
| **CSRF** | No CSRF tokens; relies on same-origin policy |
| **Multi-instance** | Session store not shared across backend instances |
