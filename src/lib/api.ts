/**
 * Backend API adapter
 *
 * Provides a unified interface that works with both:
 * - Tauri desktop: uses invoke() IPC
 * - Web/Docker:    uses fetch() REST calls
 *
 * The mode is selected by the VITE_BACKEND env var:
 * - "tauri" (default when built with Tauri)
 * - "web"  (set when building for Docker/web deployment)
 */

import type { DroneUsage, Flight, FlightDataResponse, FlightTag, ImportResult, OverviewStats } from '@/types';

const isWeb = import.meta.env.VITE_BACKEND === 'web';

// Base URL for web mode API calls (relative in production, configurable in dev)
const API_BASE = import.meta.env.VITE_API_URL || '/api';
const DEFAULT_ALLOWED_LOG_EXTENSIONS = ['txt', 'csv'];

// ============================================================================
// Tauri invoke wrapper (lazy-loaded to avoid import errors in web mode)
// ============================================================================

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getTauriInvoke() {
  if (!_invoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    _invoke = invoke;
  }
  return _invoke;
}

// ============================================================================
// Web fetch helpers
// ============================================================================

// ============================================================================
// Session-expired callback (avoids circular import with the store)
// ============================================================================

let _onSessionExpired: (() => void) | null = null;

/** Register a callback invoked when a 401 indicates the session is stale. */
export function onSessionExpired(cb: () => void): void {
  _onSessionExpired = cb;
}

/**
 * Read a profile-related key, preferring the tab-scoped sessionStorage
 * (so each tab can be on a different profile) and falling back to
 * localStorage (so a freshly-opened tab inherits the last-used profile).
 */
export function getProfileKey(key: string): string | null {
  if (typeof sessionStorage !== 'undefined') {
    const v = sessionStorage.getItem(key);
    if (v !== null) return v;
  }
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(key);
    // Seed sessionStorage so subsequent reads stay tab-local
    if (v !== null && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, v);
    }
    return v;
  }
  return null;
}

/** Write a profile-related key to both storages (tab-scope + persistence). */
export function setProfileKey(key: string, value: string): void {
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value);
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

/** Remove a profile-related key from both storages. */
export function removeProfileKey(key: string): void {
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
  if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
}

/**
 * Build the per-request headers that identify the caller's active profile.
 * In web mode every request includes `X-Profile` so the server can route
 * the request to the correct database — enabling independent multi-tab usage.
 * When a session token is available (password-protected profile), it is
 * sent via `X-Session` so the server can authenticate the request.
 */
function profileHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  headers['X-Profile'] = getProfileKey('activeProfile') || 'default';
  const session = getProfileKey('profileSession');
  if (session) {
    headers['X-Session'] = session;
  }
  return headers;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const { headers: optionHeaders, ...restOptions } = options || {};
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...profileHeaders(), ...optionHeaders },
    ...restOptions,
  });
  if (!response.ok) {
    const body = await response.text();
    let errorMsg: string;
    try {
      const parsed = JSON.parse(body);
      errorMsg = parsed.error || body;
    } catch {
      errorMsg = body;
    }
    // On 401 the session token is expired or invalid — clear it and
    // notify the store so the login overlay is shown.
    if (response.status === 401) {
      removeProfileKey('profileSession');
      _onSessionExpired?.();
    }
    throw new Error(errorMsg);
  }
  return response.json();
}

// ============================================================================
// API Functions
// ============================================================================

export async function getFlights(): Promise<Flight[]> {
  if (isWeb) {
    return fetchJson<Flight[]>('/flights');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_flights') as Promise<Flight[]>;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  if (isWeb) {
    return fetchJson<OverviewStats>('/overview');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_overview_stats') as Promise<OverviewStats>;
}

export async function getBatteryFullCapacityHistory(
  batterySerial: string,
): Promise<[number, string, number][]> {
  if (isWeb) {
    const params = new URLSearchParams({ battery_serial: batterySerial });
    return fetchJson<[number, string, number][]>(`/battery_capacity_history?${params}`);
  }
  const invoke = await getTauriInvoke();
  return invoke('get_battery_full_capacity_history', { batterySerial }) as Promise<[number, string, number][]>;
}

export async function getFlightData(
  flightId: number,
  maxPoints?: number,
): Promise<FlightDataResponse> {
  if (isWeb) {
    const params = new URLSearchParams({ flight_id: String(flightId) });
    if (maxPoints != null) params.set('max_points', String(maxPoints));
    return fetchJson<FlightDataResponse>(`/flight_data?${params}`);
  }
  const invoke = await getTauriInvoke();
  return invoke('get_flight_data', {
    flightId,
    maxPoints: maxPoints ?? null,
  }) as Promise<FlightDataResponse>;
}

/**
 * Import a flight log.
 * - Tauri: passes a file path string
 * - Web: uploads the file via multipart/form-data
 */
export async function importLog(
  fileOrPath: string | File,
): Promise<ImportResult> {
  if (isWeb) {
    const formData = new FormData();
    if (typeof fileOrPath === 'string') {
      throw new Error('File path import is not supported in web mode. Please provide a File object.');
    }
    formData.append('file', fileOrPath, fileOrPath.name);
    const response = await fetch(`${API_BASE}/import`, {
      method: 'POST',
      body: formData,
      headers: profileHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }
    return response.json();
  }
  const invoke = await getTauriInvoke();
  if (typeof fileOrPath === 'string') {
    return invoke('import_log', { filePath: fileOrPath }) as Promise<ImportResult>;
  }

  // Android file pickers return File objects from content URIs, not stable filesystem paths.
  // Send raw bytes to the backend so import works regardless of URI scheme.
  const bytes = Array.from(new Uint8Array(await fileOrPath.arrayBuffer()));
  return invoke('import_log_bytes', {
    fileName: fileOrPath.name,
    fileBytes: bytes,
  }) as Promise<ImportResult>;
}

/**
 * Create a manual flight entry without a log file.
 * Used for flights that don't have telemetry data available.
 */
export interface CreateManualFlightParams {
  flightTitle?: string; // Optional custom display name
  aircraftName: string;
  droneSerial: string;
  batterySerial: string;
  startTime: string; // ISO 8601 format
  durationSecs: number;
  totalDistance?: number; // in meters
  maxAltitude?: number; // in meters
  homeLat: number;
  homeLon: number;
  notes?: string;
}

export async function createManualFlight(
  params: CreateManualFlightParams,
): Promise<ImportResult> {
  if (isWeb) {
    return fetchJson<ImportResult>('/manual_flight', {
      method: 'POST',
      body: JSON.stringify({
        flight_title: params.flightTitle ?? null,
        aircraft_name: params.aircraftName,
        drone_serial: params.droneSerial,
        battery_serial: params.batterySerial,
        start_time: params.startTime,
        duration_secs: params.durationSecs,
        total_distance: params.totalDistance ?? null,
        max_altitude: params.maxAltitude ?? null,
        home_lat: params.homeLat,
        home_lon: params.homeLon,
        notes: params.notes ?? null,
      }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('create_manual_flight', {
    flightTitle: params.flightTitle ?? null,
    aircraftName: params.aircraftName,
    droneSerial: params.droneSerial,
    batterySerial: params.batterySerial,
    startTime: params.startTime,
    durationSecs: params.durationSecs,
    totalDistance: params.totalDistance ?? null,
    maxAltitude: params.maxAltitude ?? null,
    homeLat: params.homeLat,
    homeLon: params.homeLon,
    notes: params.notes ?? null,
  }) as Promise<ImportResult>;
}

/**
 * Compute file hash without importing.
 * Tauri-only: used to check blacklist before importing.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  if (isWeb) {
    throw new Error('File hash computation is not supported in web mode.');
  }
  const invoke = await getTauriInvoke();
  return invoke('compute_file_hash', { filePath }) as Promise<string>;
}

/**
 * Get all allowed import extensions.
 * - Tauri: built-in + parsers.json mappings from app data directory.
 * - Web: fixed defaults (no local parsers.json support in browser mode).
 */
export async function getAllowedLogExtensions(): Promise<string[]> {
  if (isWeb) {
    try {
      const result = await fetchJson<{ extensions: string[] }>('/allowed_log_extensions');
      if (Array.isArray(result.extensions) && result.extensions.length > 0) {
        return result.extensions;
      }
    } catch {
      // Fall back to defaults when endpoint is unavailable.
    }
    return DEFAULT_ALLOWED_LOG_EXTENSIONS;
  }
  const invoke = await getTauriInvoke();
  const extensions = await invoke('get_allowed_log_extensions') as string[];
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return DEFAULT_ALLOWED_LOG_EXTENSIONS;
  }
  return extensions;
}

export async function deleteFlight(flightId: number): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>(`/flights/delete?flight_id=${flightId}`, {
      method: 'DELETE',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('delete_flight', { flightId }) as Promise<boolean>;
}

export async function deleteAllFlights(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/flights/delete_all', { method: 'DELETE' });
  }
  const invoke = await getTauriInvoke();
  return invoke('delete_all_flights') as Promise<boolean>;
}

/**
 * Remove duplicate flights from the database.
 * Duplicates are identified by matching (drone_serial, battery_serial, start_time within 60s).
 * Keeps the flight with the most telemetry points.
 * @returns Number of duplicate flights removed
 */
export async function deduplicateFlights(): Promise<number> {
  if (isWeb) {
    return fetchJson<number>('/flights/deduplicate', { method: 'POST' });
  }
  const invoke = await getTauriInvoke();
  return invoke('deduplicate_flights') as Promise<number>;
}

export async function updateFlightName(
  flightId: number,
  displayName: string,
): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/flights/name', {
      method: 'PUT',
      body: JSON.stringify({ flight_id: flightId, display_name: displayName }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('update_flight_name', { flightId, displayName }) as Promise<boolean>;
}

export async function updateFlightNotes(
  flightId: number,
  notes: string | null,
): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/flights/notes', {
      method: 'PUT',
      body: JSON.stringify({ flight_id: flightId, notes }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('update_flight_notes', { flightId, notes }) as Promise<boolean>;
}

export async function updateFlightColor(
  flightId: number,
  color: string,
): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/flights/color', {
      method: 'PUT',
      body: JSON.stringify({ flight_id: flightId, color }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('update_flight_color', { flightId, color }) as Promise<boolean>;
}

export async function hasApiKey(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/has_api_key');
  }
  const invoke = await getTauriInvoke();
  return invoke('has_api_key') as Promise<boolean>;
}

export async function getApiKeyType(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/api_key_type');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_api_key_type') as Promise<string>;
}

export async function setApiKey(apiKey: string): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/set_api_key', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_api_key', { apiKey }) as Promise<boolean>;
}

export async function removeApiKey(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/remove_api_key', {
      method: 'DELETE',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_api_key') as Promise<boolean>;
}

export async function getAppDataDir(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/app_data_dir');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_app_data_dir') as Promise<string>;
}

export async function getBatteryPairs(): Promise<string[]> {
  if (isWeb) {
    return fetchJson<string[]>('/battery_pairs');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_battery_pairs') as Promise<string[]>;
}

export async function getAppLogDir(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/app_log_dir');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_app_log_dir') as Promise<string>;
}

export async function logSyncEvent(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/sync/log_event', {
      method: 'POST',
      body: JSON.stringify({
        level,
        message,
        metadata: metadata ? JSON.stringify(metadata) : null,
      }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('log_sync_event', {
    level,
    message,
    metadata: metadata ? JSON.stringify(metadata) : null,
  }) as Promise<boolean>;
}

// ============================================================================
// Equipment Names (Battery/Aircraft custom display names)
// ============================================================================

export interface EquipmentNamesResponse {
  battery_names: Record<string, string>;
  aircraft_names: Record<string, string>;
}

export async function getEquipmentNames(): Promise<EquipmentNamesResponse> {
  if (isWeb) {
    return fetchJson<EquipmentNamesResponse>('/equipment_names');
  }
  const invoke = await getTauriInvoke();
  const result = await invoke('get_equipment_names') as [Array<[string, string]>, Array<[string, string]>];
  // Convert from [[serial, name], ...] to {serial: name, ...}
  const battery_names: Record<string, string> = {};
  const aircraft_names: Record<string, string> = {};
  for (const [serial, name] of result[0]) {
    battery_names[serial] = name;
  }
  for (const [serial, name] of result[1]) {
    aircraft_names[serial] = name;
  }
  return { battery_names, aircraft_names };
}

export async function setEquipmentName(serial: string, equipmentType: 'battery' | 'aircraft', displayName: string): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/equipment_names', {
      method: 'POST',
      body: JSON.stringify({ serial, equipment_type: equipmentType, display_name: displayName }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_equipment_name', { serial, equipmentType, displayName }) as Promise<boolean>;
}

// ============================================================================
// Tag Management
// ============================================================================

export async function addFlightTag(flightId: number, tag: string): Promise<FlightTag[]> {
  if (isWeb) {
    return fetchJson<FlightTag[]>('/flights/tags/add', {
      method: 'POST',
      body: JSON.stringify({ flight_id: flightId, tag }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('add_flight_tag', { flightId, tag }) as Promise<FlightTag[]>;
}

export async function removeFlightTag(flightId: number, tag: string): Promise<FlightTag[]> {
  if (isWeb) {
    return fetchJson<FlightTag[]>('/flights/tags/remove', {
      method: 'POST',
      body: JSON.stringify({ flight_id: flightId, tag }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_flight_tag', { flightId, tag }) as Promise<FlightTag[]>;
}

export async function getAllTags(): Promise<string[]> {
  if (isWeb) {
    return fetchJson<string[]>('/tags');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_all_tags') as Promise<string[]>;
}

export async function getSmartTagsEnabled(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/settings/smart_tags');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_smart_tags_enabled') as Promise<boolean>;
}

export async function setSmartTagsEnabled(enabled: boolean): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/settings/smart_tags', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_smart_tags_enabled', { enabled }) as Promise<boolean>;
}

interface SettingValueResponse {
  value: string | null;
}

/** Read a profile-scoped setting from the backend database settings table. */
export async function getSettingValue(key: string): Promise<string | null> {
  if (isWeb) {
    const params = new URLSearchParams({ key });
    const result = await fetchJson<SettingValueResponse>(`/settings/value?${params.toString()}`);
    return result.value;
  }
  const invoke = await getTauriInvoke();
  return invoke('get_setting_value', { key }) as Promise<string | null>;
}

/** Persist a profile-scoped setting in the backend database settings table. */
export async function setSettingValue(key: string, value: string): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/settings/value', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_setting_value', { key, value }) as Promise<boolean>;
}

export async function regenerateSmartTags(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/regenerate_smart_tags', {
      method: 'POST',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('regenerate_all_smart_tags') as Promise<string>;
}

export async function removeAllAutoTags(): Promise<number> {
  if (isWeb) {
    return fetchJson<number>('/tags/remove_auto', {
      method: 'POST',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_all_auto_tags') as Promise<number>;
}

export async function regenerateFlightSmartTags(flightId: number, enabledTagTypes?: string[]): Promise<string> {
  if (isWeb) {
    return fetchJson<string>(`/regenerate_flight_smart_tags/${flightId}`, {
      method: 'POST',
      body: JSON.stringify({ enabledTagTypes }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('regenerate_flight_smart_tags', { flightId, enabledTagTypes }) as Promise<string>;
}

// ============================================================================
// Smart Tag Types
// ============================================================================

/** All available smart tag types that can be enabled/disabled */
export const SMART_TAG_TYPES = [
  { id: 'night_flight', label: 'Night Flight', description: 'Flights starting after 7 PM or before 6 AM' },
  { id: 'high_speed', label: 'High Speed', description: 'Max speed exceeds 15 m/s' },
  { id: 'cold_battery', label: 'Cold Battery', description: 'Battery temp below 15°C at start' },
  { id: 'heavy_load', label: 'Heavy Load', description: 'Battery consumption >75% in <20 min' },
  { id: 'low_battery', label: 'Low Battery', description: 'Battery dropped below 15% at landing' },
  { id: 'high_altitude', label: 'High Altitude', description: 'Max height above 120 meters' },
  { id: 'long_distance', label: 'Long Distance', description: 'Max distance from home >1 km' },
  { id: 'long_flight', label: 'Long Flight', description: 'Duration over 25 minutes' },
  { id: 'short_flight', label: 'Short Flight', description: 'Duration under 2 minutes' },
  { id: 'aggressive_flying', label: 'Aggressive Flying', description: 'Average speed over 8 m/s' },
  { id: 'no_gps', label: 'No GPS', description: 'No GPS data available' },
  { id: 'country', label: 'Country', description: 'Country based on takeoff location' },
  { id: 'continent', label: 'Continent', description: 'Continent based on takeoff location' },
] as const;

export type SmartTagTypeId = typeof SMART_TAG_TYPES[number]['id'];

/** Get all enabled smart tag types from localStorage */
export function getEnabledSmartTagTypes(): SmartTagTypeId[] {
  if (typeof localStorage === 'undefined') return SMART_TAG_TYPES.map(t => t.id);
  const stored = localStorage.getItem('enabledSmartTagTypes');
  if (!stored) return SMART_TAG_TYPES.map(t => t.id); // Default: all enabled
  try {
    const parsed = JSON.parse(stored);
    // Validate that all stored values are valid tag type IDs
    const validIds = SMART_TAG_TYPES.map(t => t.id);
    return parsed.filter((id: string) => validIds.includes(id as SmartTagTypeId));
  } catch {
    return SMART_TAG_TYPES.map(t => t.id);
  }
}

/** Set enabled smart tag types in localStorage and sync to backend */
export async function setEnabledSmartTagTypes(types: SmartTagTypeId[]): Promise<void> {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('enabledSmartTagTypes', JSON.stringify(types));
  }
  // Also sync to backend config for import filtering
  try {
    if (isWeb) {
      await fetchJson('/settings/enabled_tag_types', {
        method: 'POST',
        body: JSON.stringify({ types }),
      });
    } else {
      const invoke = await getTauriInvoke();
      await invoke('set_enabled_tag_types', { types });
    }
  } catch (e) {
    console.warn('Failed to sync enabled tag types to backend:', e);
  }
}

/** Load enabled smart tag types from backend (called on init) */
export async function loadEnabledSmartTagTypes(): Promise<SmartTagTypeId[]> {
  try {
    let types: string[];
    if (isWeb) {
      types = await fetchJson<string[]>('/settings/enabled_tag_types');
    } else {
      const invoke = await getTauriInvoke();
      types = await invoke('get_enabled_tag_types') as string[];
    }
    // Validate and store in localStorage
    const validIds = SMART_TAG_TYPES.map(t => t.id);
    const validTypes = types.filter((id) => validIds.includes(id as SmartTagTypeId)) as SmartTagTypeId[];
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('enabledSmartTagTypes', JSON.stringify(validTypes));
    }
    return validTypes;
  } catch {
    // If backend doesn't have the setting, use localStorage or default
    return getEnabledSmartTagTypes();
  }
}

// ============================================================================
// Keep Uploaded Files Settings (Tauri only)
// ============================================================================

export interface KeepUploadSettings {
  enabled: boolean;
  folder_path: string;
}

/** Get keep uploaded files settings (Tauri desktop only) */
export async function getKeepUploadSettings(): Promise<KeepUploadSettings | null> {
  if (isWeb) {
    // Not available in web mode
    return null;
  }
  const invoke = await getTauriInvoke();
  return invoke('get_keep_upload_settings') as Promise<KeepUploadSettings>;
}

/** Set keep uploaded files settings (Tauri desktop only) */
export async function setKeepUploadSettings(enabled: boolean, folderPath?: string | null): Promise<KeepUploadSettings | null> {
  if (isWeb) {
    // Not available in web mode
    return null;
  }
  const invoke = await getTauriInvoke();
  return invoke('set_keep_upload_settings', { 
    enabled, 
    folderPath: folderPath ?? null 
  }) as Promise<KeepUploadSettings>;
}

// ============================================================================
// File helpers for web mode (replacing Tauri dialog/fs plugins)
// ============================================================================

/** Trigger a browser file-open dialog and return selected Files */
export function pickFiles(accept?: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      resolve(files);
    };
    // If user cancels, resolve with empty
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Trigger a browser download for the given content */
export function downloadFile(filename: string, content: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download for a Blob */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Check if running in web mode */
export function isWebMode(): boolean {
  return isWeb;
}

// ============================================================================
// Sync from folder (Web/Docker mode only)
// ============================================================================

export interface SyncConfig {
  processed: number;
  skipped: number;
  errors: number;
  message: string;
  syncPath: string | null;
  /** Whether automatic scheduled sync is enabled (SYNC_INTERVAL is set on server) */
  autoSync: boolean;
}

export interface SyncFilesResponse {
  files: string[];
  syncPath: string | null;
  message: string;
}

export interface SyncFileResponse {
  success: boolean;
  message: string;
  fileHash: string | null;
}

export interface SyncBlacklistResponse {
  hashes: string[];
}

export interface SyncBlacklistEntry {
  hash: string;
  currentFilename: string | null;
  isPresentInSyncFolder: boolean;
}

export interface SyncBlacklistDetailsResponse {
  entries: SyncBlacklistEntry[];
}

/**
 * Get the sync folder configuration (web mode only).
 * Returns the configured SYNC_LOGS_PATH if set on the server.
 */
export async function getSyncConfig(): Promise<SyncConfig> {
  if (!isWeb) {
    return { processed: 0, skipped: 0, errors: 0, message: 'Not in web mode', syncPath: null, autoSync: false };
  }
  return fetchJson<SyncConfig>('/sync/config');
}

/**
 * List files available for sync in the server's SYNC_LOGS_PATH folder.
 * Returns only files that haven't been imported yet (checked by hash).
 */
export async function getSyncFiles(): Promise<SyncFilesResponse> {
  if (!isWeb) {
    return { files: [], syncPath: null, message: 'Not in web mode' };
  }
  return fetchJson<SyncFilesResponse>('/sync/files');
}

/** Get all persisted sync blacklist hashes for the active profile. */
export async function getSyncBlacklist(): Promise<string[]> {
  if (isWeb) {
    const result = await fetchJson<SyncBlacklistResponse>('/sync/blacklist');
    return result.hashes;
  }
  const invoke = await getTauriInvoke();
  return invoke('get_sync_blacklist') as Promise<string[]>;
}

/**
 * Get blacklist entries with optional sync-folder filename resolution.
 * Existing hash-only endpoints remain unchanged; this is additive.
 */
export async function getSyncBlacklistDetails(): Promise<SyncBlacklistEntry[]> {
  if (isWeb) {
    const result = await fetchJson<SyncBlacklistDetailsResponse>('/sync/blacklist/details');
    return result.entries;
  }

  const hashes = await getSyncBlacklist();
  return hashes.map((hash) => ({
    hash,
    currentFilename: null,
    isPresentInSyncFolder: false,
  }));
}

/** Add a hash to the persisted sync blacklist. */
export async function addToSyncBlacklist(fileHash: string): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/sync/blacklist', {
      method: 'POST',
      body: JSON.stringify({ fileHash }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('add_to_sync_blacklist', { fileHash }) as Promise<boolean>;
}

/** Remove a hash from the persisted sync blacklist. */
export async function removeFromSyncBlacklist(fileHash: string): Promise<boolean> {
  if (isWeb) {
    const params = new URLSearchParams({ file_hash: fileHash });
    return fetchJson<boolean>(`/sync/blacklist?${params}`, { method: 'DELETE' });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_from_sync_blacklist', { fileHash }) as Promise<boolean>;
}

/** Clear all persisted sync blacklist hashes. */
export async function clearSyncBlacklist(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/sync/blacklist/all', { method: 'DELETE' });
  }
  const invoke = await getTauriInvoke();
  return invoke('clear_sync_blacklist') as Promise<boolean>;
}

/**
 * Import a single file from the server's SYNC_LOGS_PATH folder.
 */
export async function syncSingleFile(filename: string): Promise<SyncFileResponse> {
  if (!isWeb) {
    return { success: false, message: 'Not in web mode', fileHash: null };
  }
  return fetchJson<SyncFileResponse>('/sync/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
  });
}

/**
 * Trigger sync from the server's SYNC_LOGS_PATH folder (web mode only).
 * This imports any new log files from the mounted sync folder.
 */
export async function triggerSync(): Promise<SyncConfig> {
  if (!isWeb) {
    return { processed: 0, skipped: 0, errors: 0, message: 'Not in web mode', syncPath: null, autoSync: false };
  }
  return fetchJson<SyncConfig>('/sync', { method: 'POST' });
}

// ============================================================================
// Database backup & restore
// ============================================================================

/**
 * Export the database as a compressed backup file.
 * - Tauri: prompts user with a save dialog, backend writes the file directly.
 * - Web: downloads the backup file via the browser.
 */
function getBackupFilename(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${timestamp}_Open_Dronelog.db.backup`;
}

function isLikelyMobileTauriRuntime(): boolean {
  if (isWeb || typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function resolveDialogPath(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    'path' in value &&
    typeof (value as { path?: unknown }).path === 'string'
  ) {
    return (value as { path: string }).path;
  }
  return null;
}

export interface SaveDialogFilter {
  name: string;
  extensions: string[];
}

/**
 * Save plain text content through the native Tauri save dialog.
 * Uses binary write under the hood for consistent behavior on desktop and mobile.
 */
export async function saveTextWithDialog(
  defaultPath: string,
  content: string,
  filters: SaveDialogFilter[],
): Promise<boolean> {
  if (isWeb) {
    throw new Error('saveTextWithDialog is only available in Tauri mode');
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const saveResult = await save({ defaultPath, filters });
  const filePath = resolveDialogPath(saveResult);
  if (!filePath) return false;

  const bytes = new TextEncoder().encode(content);
  await writeFile(filePath, bytes);
  return true;
}

/**
 * Save blob content through the native Tauri save dialog.
 * Works for PNG/ZIP and other binary exports.
 */
export async function saveBlobWithDialog(
  defaultPath: string,
  blob: Blob,
  filters: SaveDialogFilter[],
): Promise<boolean> {
  if (isWeb) {
    throw new Error('saveBlobWithDialog is only available in Tauri mode');
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const saveResult = await save({ defaultPath, filters });
  const filePath = resolveDialogPath(saveResult);
  if (!filePath) return false;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(filePath, bytes);
  return true;
}

export async function backupDatabase(): Promise<boolean> {
  if (isWeb) {
    // Web mode: download via fetch
    const response = await fetch(`${API_BASE}/backup`, { headers: profileHeaders() });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }
    const blob = await response.blob();
    downloadBlob(getBackupFilename(), blob);
    return true;
  }

  if (isLikelyMobileTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const saveResult = await save({
      defaultPath: getBackupFilename(),
      filters: [{ name: 'Open DroneLog Backup', extensions: ['backup'] }],
    });
    const destPath = resolveDialogPath(saveResult);
    if (!destPath) return false;

    const invoke = await getTauriInvoke();
    const raw = await invoke('export_backup_bytes');
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as number[]);
    await writeFile(destPath, bytes);
    return true;
  }

  // Tauri mode: use native save dialog
  const { save } = await import('@tauri-apps/plugin-dialog');
  const saveResult = await save({
    defaultPath: getBackupFilename(),
    filters: [{ name: 'Open DroneLog Backup', extensions: ['backup'] }],
  });
  const destPath = resolveDialogPath(saveResult);
  if (!destPath) return false; // user cancelled
  const invoke = await getTauriInvoke();
  await invoke('export_backup', { destPath });
  return true;
}

/**
 * Import a backup file to restore flight data.
 * - Tauri: prompts user with an open dialog, backend reads the file directly.
 * - Web: uploads the file via multipart/form-data.
 * Returns a status message string.
 */
export async function restoreDatabase(file?: File): Promise<string> {
  if (isWeb) {
    if (!file) throw new Error('No file provided');
    const formData = new FormData();
    formData.append('file', file, file.name);
    const response = await fetch(`${API_BASE}/backup/restore`, {
      method: 'POST',
      body: formData,
      headers: profileHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }
    return response.json();
  }

  if (isLikelyMobileTauriRuntime()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const openResult = await open({
      multiple: false,
      filters: [{ name: 'Open DroneLog Backup', extensions: ['backup'] }],
    });
    const srcPath = resolveDialogPath(openResult);
    if (!srcPath) return '';

    const bytes = await readFile(srcPath);
    const invoke = await getTauriInvoke();
    return invoke('import_backup_bytes', { data: Array.from(bytes) }) as Promise<string>;
  }

  // Tauri mode: use native open dialog
  const { open } = await import('@tauri-apps/plugin-dialog');
  const openResult = await open({
    multiple: false,
    filters: [{ name: 'Open DroneLog Backup', extensions: ['backup'] }],
  });
  const srcPath = resolveDialogPath(openResult);
  if (!srcPath) return ''; // user cancelled
  const invoke = await getTauriInvoke();
  return invoke('import_backup', { srcPath }) as Promise<string>;
}

// ============================================================================
// Profile Management
// ============================================================================

export interface ProfileInfo {
  name: string;
  hasPassword: boolean;
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  if (isWeb) {
    return fetchJson<ProfileInfo[]>('/profiles');
  }
  const invoke = await getTauriInvoke();
  return invoke('list_profiles') as Promise<ProfileInfo[]>;
}

export async function getActiveProfile(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/profiles/active');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_active_profile') as Promise<string>;
}

export interface SwitchProfileOptions {
  name: string;
  create?: boolean;
  password?: string;
  new_password?: string;
  master_password?: string;
}

export interface SwitchProfileResponse {
  name: string;
  session: string | null;
}

export async function switchProfile(opts: SwitchProfileOptions): Promise<SwitchProfileResponse> {
  if (isWeb) {
    return fetchJson<SwitchProfileResponse>('/profiles/switch', {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        create: !!opts.create,
        password: opts.password || null,
        new_password: opts.new_password || null,
        master_password: opts.master_password || null,
      }),
    });
  }
  const invoke = await getTauriInvoke();
  // Tauri desktop — no session token, returns just the profile name string
  const result = await invoke('switch_profile', {
    name: opts.name,
    create: !!opts.create,
    password: opts.password || null,
    newPassword: opts.new_password || null,
  }) as string;
  return { name: result, session: null };
}

export interface DeleteProfileOptions {
  name: string;
  password?: string;
  master_password?: string;
}

export async function deleteProfile(opts: DeleteProfileOptions): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/profiles/delete', {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        password: opts.password || null,
        master_password: opts.master_password || null,
      }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('delete_profile', { name: opts.name, password: opts.password || null }) as Promise<boolean>;
}

export interface RenameProfileOptions {
  name: string;
  new_name: string;
  password?: string;
  master_password?: string;
}

/** Rename a (non-active) profile. Resolves to the new name. */
export async function renameProfile(opts: RenameProfileOptions): Promise<string> {
  if (isWeb) {
    const result = await fetchJson<SwitchProfileResponse>('/profiles/rename', {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        new_name: opts.new_name,
        password: opts.password || null,
        master_password: opts.master_password || null,
      }),
    });
    return result.name;
  }
  const invoke = await getTauriInvoke();
  return invoke('rename_profile', {
    name: opts.name,
    newName: opts.new_name,
    password: opts.password || null,
  }) as Promise<string>;
}

// ── Password management ──

export async function setProfilePassword(
  profile: string,
  newPassword: string,
  currentPassword?: string,
): Promise<boolean> {
  if (isWeb) {
    const session = getProfileKey('profileSession') || undefined;
    return fetchJson<boolean>('/profiles/set_password', {
      method: 'POST',
      body: JSON.stringify({
        profile,
        new_password: newPassword,
        current_password: currentPassword || null,
        session: session || null,
      }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_profile_password', {
    profile,
    newPassword,
    currentPassword: currentPassword || null,
  }) as Promise<boolean>;
}

export async function removeProfilePassword(
  profile: string,
  currentPassword: string,
): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/profiles/remove_password', {
      method: 'POST',
      body: JSON.stringify({
        profile,
        current_password: currentPassword,
      }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_profile_password', {
    profile,
    currentPassword,
  }) as Promise<boolean>;
}

export async function hasMasterPassword(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/profiles/has_master_password');
  }
  // Tauri desktop doesn't use master password
  return false;
}

// ── Manager overview (Web/Docker only, opt-in via MANAGER_OVERVIEW) ──

export interface ManagerProfileSummary {
  name: string;
  hasPassword: boolean;
  /** Set when the server could not read this profile's database. */
  error: string | null;
  totalFlights: number;
  totalDurationSecs: number;
  totalDistanceM: number;
  totalPhotos: number;
  totalVideos: number;
  maxAltitudeM: number;
  batteryCount: number;
  firstFlightDate: string | null;
  lastFlightDate: string | null;
  drones: DroneUsage[];
}

/** Whether this server offers the all-profiles manager overview. */
export async function isManagerOverviewEnabled(): Promise<boolean> {
  if (!isWeb) return false;
  try {
    return await fetchJson<boolean>('/manager/enabled');
  } catch {
    return false;
  }
}

/** Totals for every profile on the server. Needs the master password. */
export async function getManagerOverview(masterPassword: string): Promise<ManagerProfileSummary[]> {
  return fetchJson<ManagerProfileSummary[]>('/manager/overview', {
    method: 'POST',
    body: JSON.stringify({ master_password: masterPassword }),
  });
}

// ── Auto-logout (Tauri desktop only) ──

export async function getAutoLogout(): Promise<boolean> {
  if (isWeb) return false;
  const invoke = await getTauriInvoke();
  return invoke('get_auto_logout') as Promise<boolean>;
}

export async function setAutoLogout(enabled: boolean): Promise<boolean> {
  if (isWeb) return false;
  const invoke = await getTauriInvoke();
  return invoke('set_auto_logout', { enabled }) as Promise<boolean>;
}

// ── App lock (Tauri desktop only) ──

export async function isAppLocked(): Promise<boolean> {
  if (isWeb) return false;
  const invoke = await getTauriInvoke();
  return invoke('is_app_locked') as Promise<boolean>;
}

export async function unlockProfile(password: string): Promise<boolean> {
  if (isWeb) return false;
  const invoke = await getTauriInvoke();
  return invoke('unlock_profile', { password }) as Promise<boolean>;
}

// ============================================================================
// Supporter Badge (server-side verification)
// ============================================================================

/** Verify a supporter code on the backend. Returns true if the code is valid. */
export async function verifySupporterCode(code: string): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/supporter/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('verify_supporter_code', { code }) as Promise<boolean>;
}

/** Get the supporter badge status from the database. */
export async function getSupporterStatus(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/supporter/status');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_supporter_status') as Promise<boolean>;
}

/** Remove the supporter badge in the database. */
export async function removeSupporterBadge(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/supporter/remove', { method: 'POST' });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_supporter_badge') as Promise<boolean>;
}

/** Get the donation-acknowledged flag from the database. */
export async function getDonationAcknowledged(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/supporter/donation');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_donation_acknowledged') as Promise<boolean>;
}

/** Set the donation-acknowledged flag in the database. */
export async function setDonationAcknowledgedApi(acknowledged: boolean): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/supporter/donation', {
      method: 'POST',
      body: JSON.stringify({ acknowledged }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_donation_acknowledged', { acknowledged }) as Promise<boolean>;
}
