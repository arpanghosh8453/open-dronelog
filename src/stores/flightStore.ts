/**
 * Zustand store for flight state management
 * Manages the currently selected flight and flight list
 */

import { create } from 'zustand';
import * as api from '@/lib/api';
import type { Flight, FlightDataResponse, FlightMessage, ImportResult, OverviewStats } from '@/types';
import {
  normalizeSerial,
  LEGACY_DATE_LOCALE_MAP,
  type UnitPreferences,
  type UnitSystem,
  type SpeedUnit,
  DEFAULT_UNIT_PREFS,
  normalizeSpeedUnit,
} from '@/lib/utils';
import i18n from '@/i18n';

/**
 * Scan battery telemetry and generate warning/caution messages
 * when battery level first crosses 20% and 10% thresholds.
 */
function generateBatteryMessages(flightData: FlightDataResponse): FlightMessage[] {
  const { telemetry } = flightData;
  if (!telemetry?.battery || !telemetry?.time || telemetry.battery.length === 0) return [];

  const msgs: FlightMessage[] = [];
  let warned20 = false;
  let warned10 = false;

  for (let i = 0; i < telemetry.battery.length; i++) {
    const batt = telemetry.battery[i];
    if (batt == null) continue;

    if (!warned20 && batt <= 20 && batt > 10) {
      warned20 = true;
      msgs.push({
        timestampMs: Math.round(telemetry.time[i] * 1000),
        messageType: 'warn',
        message: `Battery low: ${batt}%`,
      });
    }
    if (!warned10 && batt <= 10) {
      warned20 = true; // skip 20% if we hit 10% first
      warned10 = true;
      msgs.push({
        timestampMs: Math.round(telemetry.time[i] * 1000),
        messageType: 'caution',
        message: `Battery critical: ${batt}%`,
      });
    }
    if (warned20 && warned10) break;
  }
  return msgs;
}

/** Append battery warnings into flight data messages (sorted by timestamp). */
function injectBatteryMessages(flightData: FlightDataResponse): FlightDataResponse {
  const battMsgs = generateBatteryMessages(flightData);
  if (battMsgs.length === 0) return flightData;

  const existing = flightData.messages ?? [];
  const merged = [...existing, ...battMsgs].sort((a, b) => a.timestampMs - b.timestampMs);
  return { ...flightData, messages: merged };
}

interface FlightState {
  // State
  flights: Flight[];
  isFlightsInitialized: boolean;  // true after first loadFlights completes
  needsAuth: boolean;  // true when loadFlights fails due to auth (locked profile)
  selectedFlightId: number | null;
  currentFlightData: FlightDataResponse | null;
  overviewStats: OverviewStats | null;
  isLoading: boolean;
  isImporting: boolean;
  isBatchProcessing: boolean;  // true during any batch import (manual, sync, background)
  setIsBatchProcessing: (value: boolean) => void;
  isRegenerating: boolean;
  isRemovingAutoTags: boolean;
  regenerationProgress: { processed: number; total: number } | null;
  error: string | null;
  unitPrefs: UnitPreferences;
  themeMode: 'system' | 'dark' | 'light';
  donationAcknowledged: boolean;
  supporterBadgeActive: boolean;
  allTags: string[];
  smartTagsEnabled: boolean;

  // API key type for cooldown bypass (personal keys skip cooldown)
  apiKeyType: 'none' | 'default' | 'personal';

  // Update check
  updateStatus: 'idle' | 'checking' | 'latest' | 'outdated' | 'failed';
  latestVersion: string | null;

  // Flight data cache (keyed by flight ID)
  _flightDataCache: Map<number, FlightDataResponse>;

  // Actions
  loadFlights: () => Promise<void>;
  loadOverview: () => Promise<void>;
  selectFlight: (flightId: number) => Promise<void>;
  importLog: (fileOrPath: string | File, skipRefresh?: boolean) => Promise<ImportResult>;
  importLogBatch: (filesOrPaths: (string | File)[]) => Promise<{ processed: number; skipped: number; lastFlightId: number | null }>;
  loadApiKeyType: () => Promise<void>;
  deleteFlight: (flightId: number) => Promise<void>;
  updateFlightName: (flightId: number, displayName: string) => Promise<void>;
  updateFlightNotes: (flightId: number, notes: string | null) => Promise<void>;
  updateFlightColor: (flightId: number, color: string) => Promise<void>;
  addTag: (flightId: number, tag: string) => Promise<void>;
  removeTag: (flightId: number, tag: string) => Promise<void>;
  loadAllTags: () => Promise<void>;
  setSmartTagsEnabled: (enabled: boolean) => Promise<void>;
  loadSmartTagsEnabled: () => Promise<void>;
  regenerateSmartTags: () => Promise<string>;
  removeAllAutoTags: () => Promise<string>;
  locale: string;
  setLocale: (locale: string) => void;
  dateLocale: string;
  setDateLocale: (dateLocale: string) => void;
  appLanguage: string;
  setAppLanguage: (lang: string) => void;
  timeFormat: '12h' | '24h';
  setTimeFormat: (format: '12h' | '24h') => void;
  setUnitPref: (key: keyof UnitPreferences, value: UnitSystem | SpeedUnit) => void;
  setThemeMode: (themeMode: 'system' | 'dark' | 'light') => void;
  setDonationAcknowledged: (value: boolean) => void;
  setSupporterBadge: (active: boolean) => void;
  loadSupporterStatus: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  clearSelection: () => void;
  clearError: () => void;
  clearFlightDataCache: () => void;

  // Sidebar-filtered flight IDs (used by Overview to share sidebar filters)
  sidebarFilteredFlightIds: Set<number> | null;
  setSidebarFilteredFlightIds: (ids: Set<number> | null) => void;

  // Heatmap date filter (set from Overview heatmap double-click, consumed by FlightList)
  heatmapDateFilter: Date | null;
  setHeatmapDateFilter: (date: Date | null) => void;

  // Overview map area filter
  mapAreaFilterEnabled: boolean;
  mapVisibleBounds: { west: number; south: number; east: number; north: number } | null;
  setMapAreaFilterEnabled: (enabled: boolean) => void;
  setMapVisibleBounds: (bounds: { west: number; south: number; east: number; north: number } | null) => void;

  // Battery name mapping (serial -> custom display name)
  batteryNameMap: Record<string, string>;
  renameBattery: (serial: string, displayName: string) => Promise<void>;
  getBatteryDisplayName: (serial: string) => string;

  // Drone name mapping (serial -> custom display name)
  droneNameMap: Record<string, string>;
  renameDrone: (serial: string, displayName: string) => Promise<void>;
  getDroneDisplayName: (serial: string, fallbackName: string) => string;

  // Load equipment names from server (for cross-device sync in web mode)
  loadEquipmentNames: () => Promise<void>;

  // Hide serial numbers (privacy mode)
  hideSerialNumbers: boolean;
  setHideSerialNumbers: (hide: boolean) => void;
  getDisplaySerial: (serial: string) => string;

  // Map-Chart sync state (session only, default off)
  mapSyncEnabled: boolean;
  setMapSyncEnabled: (enabled: boolean) => void;
  mapReplayProgress: number;  // Replay progress from map (0 to 1)
  setMapReplayProgress: (progress: number) => void;

  // Map snapshot for FlyCard (captured from current map view)
  mapSnapshotData: string | null;  // data URL of map canvas
  setMapSnapshotData: (data: string | null) => void;

  // Overview map highlighted flight (single-click preview in overview mode)
  overviewHighlightedFlightId: number | null;
  setOverviewHighlightedFlightId: (flightId: number | null) => void;

  // Overview map viewport persistence (session state)
  overviewMapViewport: { longitude: number; latitude: number; zoom: number } | null;
  setOverviewMapViewport: (viewport: { longitude: number; latitude: number; zoom: number } | null) => void;

  // Maintenance tracking state
  maintenanceThresholds: {
    battery: { flights: number; airtime: number; days: number };  // airtime in hours, days = overdue threshold
    aircraft: { flights: number; airtime: number; days: number }; // airtime in hours, days = overdue threshold
  };
  maintenanceLastReset: {
    battery: Record<string, string>;  // batterySerial -> ISO timestamp
    aircraft: Record<string, string>; // droneSerial -> ISO timestamp
  };
  setMaintenanceThreshold: (type: 'battery' | 'aircraft', field: 'flights' | 'airtime' | 'days', value: number) => void;
  performMaintenance: (type: 'battery' | 'aircraft', serial: string, date?: Date) => void;
  getMaintenanceLastReset: (type: 'battery' | 'aircraft', serial: string) => string | null;

  // Telemetry chart color overrides (fieldId -> hex color)
  telemetryColors: Record<string, string>;
  setTelemetryColor: (fieldId: string, color: string) => void;
  resetTelemetryColor: (fieldId: string) => void;
  resetAllTelemetryColors: () => void;

  // Profile management
  activeProfile: string;
  profiles: string[];
  profilePasswords: Record<string, boolean>; // name -> hasPassword
  loadProfiles: () => Promise<void>;
  switchProfile: (name: string, opts?: { create?: boolean; password?: string; newPassword?: string; masterPassword?: string }) => Promise<void>;
  deleteProfile: (name: string, opts?: { password?: string; masterPassword?: string }) => Promise<void>;
  renameProfile: (name: string, newName: string, opts?: { password?: string; masterPassword?: string }) => Promise<void>;
  logout: () => void;
}

/** Per-profile settings this browser keeps under `${prefix}:${profileName}`. */
const PROFILE_SCOPED_STORAGE_PREFIXES = ['profileSettings', 'flight_list_tag_filter_mode_v1'];

export const useFlightStore = create<FlightState>((set, get) => ({
  // Initial state
  flights: [],
  isFlightsInitialized: false,
  needsAuth: false,
  selectedFlightId: null,
  currentFlightData: null,
  overviewStats: null,
  isLoading: false,
  isImporting: false,
  isBatchProcessing: false,
  setIsBatchProcessing: (value: boolean) => set({ isBatchProcessing: value }),
  isRegenerating: false,
  isRemovingAutoTags: false,
  regenerationProgress: null,
  error: null,
  locale:
    (typeof localStorage !== 'undefined' &&
      localStorage.getItem('locale')) ||
    'en-GB',
  dateLocale: (() => {
    if (typeof localStorage === 'undefined') return 'DD/MM/YYYY';
    const stored = localStorage.getItem('dateLocale') || 'en-GB';
    const migrated = LEGACY_DATE_LOCALE_MAP[stored] || stored;
    if (migrated !== stored) localStorage.setItem('dateLocale', migrated);
    return migrated;
  })(),
  appLanguage:
    (typeof localStorage !== 'undefined' &&
      localStorage.getItem('appLanguage')) ||
    'en',
  timeFormat: (() => {
    if (typeof localStorage === 'undefined') return '12h';
    const stored = localStorage.getItem('timeFormat');
    return stored === '12h' || stored === '24h' ? stored : '12h';
  })() as '12h' | '24h',
  unitPrefs: (() => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_UNIT_PREFS };
    // Try new granular key first
    const stored = localStorage.getItem('unitPrefs');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return {
          ...DEFAULT_UNIT_PREFS,
          ...parsed,
          speed: normalizeSpeedUnit(parsed?.speed),
        };
      } catch {
        /* fall through */
      }
    }
    // Migrate from legacy unitSystem key
    const legacy = localStorage.getItem('unitSystem') as 'metric' | 'imperial' | null;
    if (legacy) {
      const migrated: UnitPreferences = {
        distance: legacy,
        speed: legacy === 'imperial' ? 'mph' : 'kmh',
        altitude: legacy,
        temperature: legacy,
      };
      localStorage.setItem('unitPrefs', JSON.stringify(migrated));
      localStorage.removeItem('unitSystem');
      return migrated;
    }
    return { ...DEFAULT_UNIT_PREFS };
  })(),
  themeMode: (() => {
    if (typeof localStorage === 'undefined') return 'system';
    const stored = localStorage.getItem('themeMode');
    return stored === 'dark' || stored === 'light' || stored === 'system'
      ? stored
      : 'system';
  })(),
  donationAcknowledged: false,
  supporterBadgeActive: false,
  _flightDataCache: new Map(),
  allTags: [],
  smartTagsEnabled: true,
  apiKeyType: 'none',
  updateStatus: 'idle',
  latestVersion: null,
  batteryNameMap: (() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const stored = localStorage.getItem('batteryNameMap');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  })(),
  droneNameMap: (() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const stored = localStorage.getItem('droneNameMap');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  })(),
  hideSerialNumbers:
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('hideSerialNumbers') === 'true'
      : false,

  // Telemetry chart color overrides
  telemetryColors: (() => {
    if (typeof localStorage === 'undefined') return {};
    try {
      const stored = localStorage.getItem('telemetryColors');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  })(),
  setTelemetryColor: (fieldId: string, color: string) => {
    const updated = { ...get().telemetryColors, [fieldId]: color };
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('telemetryColors', JSON.stringify(updated));
    }
    set({ telemetryColors: updated });
  },
  resetTelemetryColor: (fieldId: string) => {
    const updated = { ...get().telemetryColors };
    delete updated[fieldId];
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('telemetryColors', JSON.stringify(updated));
    }
    set({ telemetryColors: updated });
  },
  resetAllTelemetryColors: () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('telemetryColors');
    }
    set({ telemetryColors: {} });
  },

  // Map-Chart sync state (session only, default off)
  mapSyncEnabled: false,
  mapReplayProgress: 0,
  setMapSyncEnabled: (enabled: boolean) => set({ mapSyncEnabled: enabled }),
  setMapReplayProgress: (progress: number) => set({ mapReplayProgress: progress }),

  // Map snapshot for FlyCard
  mapSnapshotData: null,
  setMapSnapshotData: (data) => set({ mapSnapshotData: data }),

  // Overview map highlighted flight (single-click preview in overview mode)
  overviewHighlightedFlightId: null,
  setOverviewHighlightedFlightId: (flightId) => set({ overviewHighlightedFlightId: flightId }),

  // Overview map viewport persistence (session state)
  overviewMapViewport: null,
  setOverviewMapViewport: (viewport) => set({ overviewMapViewport: viewport }),

  // Maintenance tracking state
  maintenanceThresholds: (() => {
    const defaults = { battery: { flights: 100, airtime: 50, days: 120 }, aircraft: { flights: 100, airtime: 50, days: 120 } };
    if (typeof localStorage === 'undefined') return defaults;
    try {
      const stored = localStorage.getItem('maintenanceThresholds');
      if (!stored) return defaults;
      const parsed = JSON.parse(stored);
      // Migrate: add days field if missing from older stored data
      if (parsed.battery && parsed.battery.days === undefined) parsed.battery.days = 120;
      if (parsed.aircraft && parsed.aircraft.days === undefined) parsed.aircraft.days = 120;
      return parsed;
    } catch {
      return defaults;
    }
  })(),
  maintenanceLastReset: (() => {
    if (typeof localStorage === 'undefined') return { battery: {}, aircraft: {} };
    try {
      const stored = localStorage.getItem('maintenanceLastReset');
      return stored ? JSON.parse(stored) : { battery: {}, aircraft: {} };
    } catch {
      return { battery: {}, aircraft: {} };
    }
  })(),

  // Profile management
  activeProfile: api.getProfileKey('activeProfile') || 'default',
  profiles: ['default'],
  profilePasswords: {},

  setMaintenanceThreshold: (type, field, value) => {
    const thresholds = { ...get().maintenanceThresholds };
    thresholds[type] = { ...thresholds[type], [field]: value };
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('maintenanceThresholds', JSON.stringify(thresholds));
    }
    set({ maintenanceThresholds: thresholds });
  },
  performMaintenance: (type, serial, date) => {
    const normalizedSerial = normalizeSerial(serial);
    const lastReset = { ...get().maintenanceLastReset };
    // Use provided date or default to now
    const maintenanceDate = date ? date.toISOString() : new Date().toISOString();
    lastReset[type] = { ...lastReset[type], [normalizedSerial]: maintenanceDate };
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('maintenanceLastReset', JSON.stringify(lastReset));
    }
    set({ maintenanceLastReset: lastReset });
  },
  getMaintenanceLastReset: (type, serial) => {
    const normalizedSerial = normalizeSerial(serial);
    return get().maintenanceLastReset[type][normalizedSerial] || null;
  },

  // Load all flights from database
  loadFlights: async () => {
    set({ isLoading: true, error: null, needsAuth: false });
    try {
      const flights = await api.getFlights();
      set({ flights, isLoading: false, isFlightsInitialized: true, needsAuth: false });

      // Load all tags in background
      get().loadAllTags();

      // Load equipment names from server (for cross-device sync)
      get().loadEquipmentNames();

      // Auto-select last used flight if available (avoid heavy load on fresh startup)
      const selectedFlightId = get().selectedFlightId;
      if (flights.length > 0 && selectedFlightId === null) {
        const lastSelectedRaw =
          typeof localStorage !== 'undefined'
            ? localStorage.getItem('lastSelectedFlightId')
            : null;
        const lastSelectedId = lastSelectedRaw ? Number(lastSelectedRaw) : null;
        if (lastSelectedId && flights.some((flight) => flight.id === lastSelectedId)) {
          try {
            await get().selectFlight(lastSelectedId);
          } catch {
            // If auto-select fails on startup, clear the persisted ID so we don't crash-loop
            console.warn('Auto-select of last flight failed, clearing lastSelectedFlightId');
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem('lastSelectedFlightId');
            }
            set({ selectedFlightId: null, currentFlightData: null, isLoading: false, error: null });
          }
        }
      }
    } catch (err) {
      const errMsg = String(err);
      const isAuthError = /password.protected|Session expired|re-authenticate|UNAUTHORIZED|Profile is locked/i.test(errMsg);
      set({
        isLoading: false,
        needsAuth: isAuthError,
        error: isAuthError ? null : `Failed to load flights: ${err}`
      });
    }
  },

  loadOverview: async () => {
    set({ isLoading: true, error: null });
    try {
      const stats = await api.getOverviewStats();
      set({ overviewStats: stats, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: `Failed to load overview stats: ${err}`,
      });
    }
  },

  // Select a flight and load its data (with cache)
  selectFlight: async (flightId: number) => {
    // Skip if already selected
    if (get().selectedFlightId === flightId && get().currentFlightData) {
      return;
    }

    // Always show loading briefly so user sees click feedback
    set({ isLoading: true, error: null, selectedFlightId: flightId, currentFlightData: null });

    // Check cache first
    const cached = get()._flightDataCache.get(flightId);
    if (cached) {
      // Brief delay so spinner is visible even on cache hit
      await new Promise((resolve) => setTimeout(resolve, 120));
      set({ currentFlightData: cached, isLoading: false, error: null });
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lastSelectedFlightId', String(flightId));
      }
      return;
    }
    try {
      const rawFlightData = await api.getFlightData(flightId, 5000);
      const flightData = injectBatteryMessages(rawFlightData);

      // Store in cache (limit cache size to 10 entries)
      const cache = new Map(get()._flightDataCache);
      if (cache.size >= 10) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      cache.set(flightId, flightData);

      set({ currentFlightData: flightData, isLoading: false, _flightDataCache: cache });
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lastSelectedFlightId', String(flightId));
      }
    } catch (err) {
      // Clear the persisted flight ID on error so we don't crash-loop on restart
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('lastSelectedFlightId');
      }
      set({
        isLoading: false,
        selectedFlightId: null,
        currentFlightData: null,
        error: `Failed to load flight data: ${err}`
      });
    }
  },

  // Import a new log file
  // skipRefresh: when true, doesn't reload flights/select (used by batch import)
  importLog: async (fileOrPath: string | File, skipRefresh = false) => {
    set({ isImporting: true, error: null });
    try {
      const result = await api.importLog(fileOrPath);

      if (result.success && result.flightId && !skipRefresh) {
        // Reload flights and select the new one (only for single imports)
        await get().loadFlights();
        await get().selectFlight(result.flightId);
        // Refresh all tags since import may have added new smart tags
        get().loadAllTags();
      }

      set({ isImporting: false });
      return result;
    } catch (err) {
      const errorMessage = `Import failed: ${err}`;
      set({ isImporting: false, error: errorMessage });
      return {
        success: false,
        flightId: null,
        message: errorMessage,
        pointCount: 0,
        fileHash: null,
      };
    }
  },

  // Batch import multiple files efficiently (defers refresh until all complete)
  importLogBatch: async (filesOrPaths: (string | File)[]) => {
    if (filesOrPaths.length === 0) {
      return { processed: 0, skipped: 0, lastFlightId: null };
    }

    set({ isImporting: true, error: null });
    let processed = 0;
    let skipped = 0;
    let lastFlightId: number | null = null;

    for (const item of filesOrPaths) {
      try {
        const result = await api.importLog(item);
        if (result.success && result.flightId) {
          processed += 1;
          lastFlightId = result.flightId;
        } else if (result.message.toLowerCase().includes('already been imported')) {
          skipped += 1;
        }
      } catch {
        // Skip failed imports in batch mode (errors handled by caller)
      }
    }

    // Refresh flight list and tags only once after all imports complete
    if (processed > 0) {
      await get().loadFlights();
      get().loadAllTags();
      // Select the last successfully imported flight
      if (lastFlightId !== null) {
        await get().selectFlight(lastFlightId);
      }
    }

    set({ isImporting: false });
    return { processed, skipped, lastFlightId };
  },

  // Load API key type (for cooldown bypass decisions)
  loadApiKeyType: async () => {
    try {
      const keyType = await api.getApiKeyType();
      set({ apiKeyType: keyType as 'none' | 'default' | 'personal' });
    } catch {
      set({ apiKeyType: 'none' });
    }
  },

  // Delete a flight
  deleteFlight: async (flightId: number) => {
    try {
      await api.deleteFlight(flightId);

      // Remove from cache
      const cache = new Map(get()._flightDataCache);
      cache.delete(flightId);

      // Clear selection if deleted flight was selected
      if (get().selectedFlightId === flightId) {
        set({ selectedFlightId: null, currentFlightData: null, _flightDataCache: cache });
      } else {
        set({ _flightDataCache: cache });
      }

      // Reload flights
      await get().loadFlights();
    } catch (err) {
      set({ error: `Failed to delete flight: ${err}` });
    }
  },

  // Update flight display name
  updateFlightName: async (flightId: number, displayName: string) => {
    try {
      await api.updateFlightName(flightId, displayName);

      // Update local list
      const flights = get().flights.map((flight) =>
        flight.id === flightId
          ? { ...flight, displayName }
          : flight
      );
      set({ flights });

      // If selected, update current flight data too
      const current = get().currentFlightData;
      if (current && current.flight.id === flightId) {
        const updated = {
          ...current,
          flight: { ...current.flight, displayName },
        };
        // Update cache too
        const cache = new Map(get()._flightDataCache);
        cache.set(flightId, updated);
        set({
          currentFlightData: updated,
          _flightDataCache: cache,
        });
      }
    } catch (err) {
      set({ error: `Failed to update flight name: ${err}` });
    }
  },

  // Update flight notes
  updateFlightNotes: async (flightId: number, notes: string | null) => {
    try {
      await api.updateFlightNotes(flightId, notes);

      // Update local list
      const flights = get().flights.map((flight) =>
        flight.id === flightId
          ? { ...flight, notes }
          : flight
      );
      set({ flights });

      // If selected, update current flight data too
      const current = get().currentFlightData;
      if (current && current.flight.id === flightId) {
        const updated = {
          ...current,
          flight: { ...current.flight, notes },
        };
        // Update cache too
        const cache = new Map(get()._flightDataCache);
        cache.set(flightId, updated);
        set({
          currentFlightData: updated,
          _flightDataCache: cache,
        });
      }
    } catch (err) {
      set({ error: `Failed to update flight notes: ${err}` });
    }
  },

  // Update flight color
  updateFlightColor: async (flightId: number, color: string) => {
    try {
      await api.updateFlightColor(flightId, color);

      // Update local list
      const flights = get().flights.map((flight) =>
        flight.id === flightId
          ? { ...flight, color }
          : flight
      );
      set({ flights });

      // If selected, update current flight data too
      const current = get().currentFlightData;
      if (current && current.flight.id === flightId) {
        const updated = {
          ...current,
          flight: { ...current.flight, color },
        };
        // Update cache too
        const cache = new Map(get()._flightDataCache);
        cache.set(flightId, updated);
        set({
          currentFlightData: updated,
          _flightDataCache: cache,
        });
      }
    } catch (err) {
      set({ error: `Failed to update flight color: ${err}` });
    }
  },

  // Add a tag to a flight
  addTag: async (flightId: number, tag: string) => {
    try {
      const tags = await api.addFlightTag(flightId, tag);
      // Update local flight list
      const flights = get().flights.map((f) =>
        f.id === flightId ? { ...f, tags } : f
      );
      set({ flights });
      // Update current flight data if selected
      const current = get().currentFlightData;
      if (current && current.flight.id === flightId) {
        const updated = {
          ...current,
          flight: { ...current.flight, tags },
        };
        const cache = new Map(get()._flightDataCache);
        cache.set(flightId, updated);
        set({ currentFlightData: updated, _flightDataCache: cache });
      }
      // Refresh all tags
      get().loadAllTags();
    } catch (err) {
      set({ error: `Failed to add tag: ${err}` });
    }
  },

  // Remove a tag from a flight
  removeTag: async (flightId: number, tag: string) => {
    try {
      const tags = await api.removeFlightTag(flightId, tag);
      const flights = get().flights.map((f) =>
        f.id === flightId ? { ...f, tags } : f
      );
      set({ flights });
      const current = get().currentFlightData;
      if (current && current.flight.id === flightId) {
        const updated = {
          ...current,
          flight: { ...current.flight, tags },
        };
        const cache = new Map(get()._flightDataCache);
        cache.set(flightId, updated);
        set({ currentFlightData: updated, _flightDataCache: cache });
      }
      get().loadAllTags();
    } catch (err) {
      set({ error: `Failed to remove tag: ${err}` });
    }
  },

  // Load all unique tags
  loadAllTags: async () => {
    try {
      const tags = await api.getAllTags();
      set({ allTags: tags });
    } catch {
      // Silently ignore — tags are optional
    }
  },

  // Load smart tags enabled setting from backend
  loadSmartTagsEnabled: async () => {
    try {
      const enabled = await api.getSmartTagsEnabled();
      set({ smartTagsEnabled: enabled });
    } catch {
      // Default to true
      set({ smartTagsEnabled: true });
    }
  },

  // Set smart tags enabled setting
  setSmartTagsEnabled: async (enabled: boolean) => {
    try {
      await api.setSmartTagsEnabled(enabled);
      set({ smartTagsEnabled: enabled });
    } catch (err) {
      set({ error: `Failed to update smart tags setting: ${err}` });
    }
  },

  // Regenerate smart tags for all flights
  regenerateSmartTags: async () => {
    const flights = get().flights;
    const total = flights.length;
    set({ isRegenerating: true, regenerationProgress: { processed: 0, total }, error: null });
    let errors = 0;
    const start = Date.now();

    // Get enabled tag types from localStorage
    const enabledTagTypes = api.getEnabledSmartTagTypes();

    for (let i = 0; i < flights.length; i++) {
      try {
        await api.regenerateFlightSmartTags(flights[i].id, enabledTagTypes);
      } catch {
        errors += 1;
      }
      set({ regenerationProgress: { processed: i + 1, total } });
    }

    // Reload flights to get updated tags
    await get().loadFlights();
    await get().loadAllTags();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const msg = `Regenerated smart tags for ${total} flights (${errors} errors) in ${elapsed}s`;
    set({ isRegenerating: false, regenerationProgress: null });
    return msg;
  },

  // Remove all auto-generated tags from all flights
  removeAllAutoTags: async () => {
    set({ isRemovingAutoTags: true, error: null });
    const start = Date.now();

    try {
      const removed = await api.removeAllAutoTags();
      // Clear the flight data cache so tags are refreshed from the server
      set({ _flightDataCache: new Map() });
      // Reload flights to get updated tags
      await get().loadFlights();
      await get().loadAllTags();
      // Also reload current flight data if one is selected to refresh displayed tags
      const selectedId = get().selectedFlightId;
      if (selectedId) {
        // Clear current selection first to force a fresh load
        set({ currentFlightData: null });
        await get().selectFlight(selectedId);
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const msg = `Removed ${removed} auto-generated tag${removed === 1 ? '' : 's'} in ${elapsed}s`;
      set({ isRemovingAutoTags: false });
      return msg;
    } catch (err) {
      set({ isRemovingAutoTags: false, error: `Failed to remove auto tags: ${err}` });
      throw err;
    }
  },

  setLocale: (locale) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('locale', locale);
    }
    set({ locale });
  },

  setDateLocale: (dateLocale) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('dateLocale', dateLocale);
    }
    set({ dateLocale });
  },

  setAppLanguage: (lang) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('appLanguage', lang);
    }
    i18n.changeLanguage(lang);
    set({ appLanguage: lang });
  },

  setTimeFormat: (format) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('timeFormat', format);
    }
    set({ timeFormat: format });
  },

  setUnitPref: (key, value) => {
    const updated = {
      ...get().unitPrefs,
      [key]: key === 'speed' ? normalizeSpeedUnit(value) : value,
    } as UnitPreferences;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('unitPrefs', JSON.stringify(updated));
    }
    set({ unitPrefs: updated });
  },

  setThemeMode: (themeMode) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('themeMode', themeMode);
    }
    // Apply body class synchronously for instant visual feedback
    if (typeof document !== 'undefined') {
      const prefersDark =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : true;
      const resolved = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode;
      document.body.classList.remove('theme-dark', 'theme-light');
      document.body.classList.add(resolved === 'dark' ? 'theme-dark' : 'theme-light');
    }
    set({ themeMode });
  },

  setDonationAcknowledged: (value) => {
    set({ donationAcknowledged: value });
    // Persist to backend (fire-and-forget)
    api.setDonationAcknowledgedApi(value).catch((err) =>
      console.warn('Failed to persist donation acknowledged state:', err),
    );
  },

  setSupporterBadge: (active) => {
    set({ supporterBadgeActive: active });
    if (active) {
      // Activating badge also acknowledges donation
      get().setDonationAcknowledged(true);
    }
    // Note: activation is done via verifySupporterCode; removal via removeSupporterBadge.
    // This setter is kept for local state updates after the API call succeeds.
  },

  loadSupporterStatus: async () => {
    try {
      const [badgeActive, donationAck] = await Promise.all([
        api.getSupporterStatus(),
        api.getDonationAcknowledged(),
      ]);
      set({ supporterBadgeActive: badgeActive, donationAcknowledged: donationAck });
    } catch (err) {
      console.warn('Failed to load supporter status from backend:', err);
    }
  },

  renameBattery: async (serial: string, displayName: string) => {
    const normalizedSerial = normalizeSerial(serial);
    const map = { ...get().batteryNameMap };
    const trimmedName = displayName.trim();
    const shouldDelete = trimmedName === '' || trimmedName === normalizedSerial;

    if (shouldDelete) {
      // Reset to original serial name
      delete map[normalizedSerial];
    } else {
      map[normalizedSerial] = trimmedName;
    }

    // Optimistically update local state first
    set({ batteryNameMap: map });

    // Cache in localStorage for quick retrieval on page load
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('batteryNameMap', JSON.stringify(map));
    }

    // Persist to server for cross-device sync
    try {
      await api.setEquipmentName(normalizedSerial, 'battery', shouldDelete ? '' : trimmedName);
    } catch (err) {
      console.error('Failed to save battery name to server:', err);
    }
  },

  getBatteryDisplayName: (serial: string) => {
    const normalizedSerial = normalizeSerial(serial);
    const customName = get().batteryNameMap[normalizedSerial];
    if (customName) return customName;
    return get().hideSerialNumbers ? '*****' : normalizedSerial;
  },

  renameDrone: async (serial: string, displayName: string) => {
    const normalizedSerial = normalizeSerial(serial);
    const map = { ...get().droneNameMap };
    const trimmedName = displayName.trim();
    const shouldDelete = trimmedName === '';

    if (shouldDelete) {
      // Reset to original name
      delete map[normalizedSerial];
    } else {
      map[normalizedSerial] = trimmedName;
    }

    // Optimistically update local state first
    set({ droneNameMap: map });

    // Cache in localStorage for quick retrieval on page load
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('droneNameMap', JSON.stringify(map));
    }

    // Persist to server for cross-device sync
    try {
      await api.setEquipmentName(normalizedSerial, 'aircraft', shouldDelete ? '' : trimmedName);
    } catch (err) {
      console.error('Failed to save aircraft name to server:', err);
    }
  },

  getDroneDisplayName: (serial: string, fallbackName: string) => {
    const normalizedSerial = normalizeSerial(serial);
    return get().droneNameMap[normalizedSerial] || fallbackName;
  },

  loadEquipmentNames: async () => {
    try {
      const response = await api.getEquipmentNames();

      // Merge server data with local state (server wins for conflicts)
      const batteryNameMap = { ...response.battery_names };
      const droneNameMap = { ...response.aircraft_names };

      // Update state
      set({ batteryNameMap, droneNameMap });

      // Update localStorage cache
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('batteryNameMap', JSON.stringify(batteryNameMap));
        localStorage.setItem('droneNameMap', JSON.stringify(droneNameMap));
      }
    } catch (err) {
      console.error('Failed to load equipment names from server:', err);
      // Keep using localStorage fallback values set at initialization
    }
  },

  setHideSerialNumbers: (hide: boolean) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('hideSerialNumbers', String(hide));
    }
    set({ hideSerialNumbers: hide });
  },

  getDisplaySerial: (serial: string) => {
    return get().hideSerialNumbers ? '*****' : serial;
  },

  // Sidebar filtered flight IDs
  sidebarFilteredFlightIds: null,
  setSidebarFilteredFlightIds: (ids) => set({ sidebarFilteredFlightIds: ids }),

  // Heatmap date filter (set from Overview heatmap double-click)
  heatmapDateFilter: null,
  setHeatmapDateFilter: (date) => set({ heatmapDateFilter: date }),

  // Overview map area filter
  mapAreaFilterEnabled: false,
  mapVisibleBounds: null,
  setMapAreaFilterEnabled: (enabled) => set({ mapAreaFilterEnabled: enabled }),
  setMapVisibleBounds: (bounds) => set({ mapVisibleBounds: bounds }),

  checkForUpdates: async () => {
    set({ updateStatus: 'checking' });
    try {
      const res = await fetch(
        'https://api.github.com/repos/arpanghosh8453/dji-logbook/releases/latest',
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const tagName: string = data.tag_name ?? '';
      // Strip leading 'v' for comparison (e.g. "v2.1.0" → "2.1.0")
      const latest = tagName.replace(/^v/i, '');

      // Get current app version
      let current = '';
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        current = await getVersion();
      } catch {
        current = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '').replace(/^v/i, '');
      }

      if (!latest || !current) {
        set({ updateStatus: 'failed', latestVersion: null });
        return;
      }

      const isLatest = latest === current;
      set({ updateStatus: isLatest ? 'latest' : 'outdated', latestVersion: latest });
    } catch (err) {
      console.warn('[UpdateCheck] Failed:', err);
      set({ updateStatus: 'failed', latestVersion: null });
    }
  },

  clearSelection: () =>
    set({
      selectedFlightId: null,
      currentFlightData: null,
      // Note: Don't clear overviewStats here - it should persist until explicitly reloaded
    }),

  // Clear error
  clearError: () => set({ error: null }),

  // Clear flight data cache (forces refresh when viewing flights after bulk operations)
  clearFlightDataCache: () => set({ _flightDataCache: new Map() }),

  // Profile management actions
  loadProfiles: async () => {
    try {
      const profileInfos = await api.listProfiles();
      const profiles = profileInfos.map(p => p.name);
      const profilePasswords: Record<string, boolean> = {};
      for (const p of profileInfos) {
        profilePasswords[p.name] = p.hasPassword;
      }
      // Use the client-side active profile from localStorage (persists across
      // tab/browser closes), falling back to the server-default on first visit.
      // sessionStorage is checked first for per-tab isolation.
      // In Tauri desktop mode, always trust the backend (handles auto-logout on close).
      let active: string;
      if (api.isWebMode()) {
        active = api.getProfileKey('activeProfile') || '';
        if (!active || !profiles.includes(active)) {
          active = await api.getActiveProfile();
          api.setProfileKey('activeProfile', active);
        }
      } else {
        active = await api.getActiveProfile();
        api.setProfileKey('activeProfile', active);
      }
      set({ profiles, activeProfile: active, profilePasswords });

      // Tauri desktop: check if the backend is locked (requires re-auth)
      if (!api.isWebMode()) {
        try {
          const locked = await api.isAppLocked();
          if (locked) {
            set({ needsAuth: true, isFlightsInitialized: false });
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      console.warn('Failed to load profiles:', err);
    }
  },

  switchProfile: async (name: string, opts?: { create?: boolean; password?: string; newPassword?: string; masterPassword?: string }) => {
    const currentProfile = get().activeProfile;
    // Skip early return if a password is provided (re-authenticating the same profile)
    if (currentProfile === name && !opts?.password) return;

    // ── Save current profile's localStorage settings ──
    const perProfileKeys = [
      'unitPrefs', 'themeMode', 'appLanguage', 'locale', 'dateLocale',
      'timeFormat', 'hideSerialNumbers', 'batteryNameMap', 'droneNameMap',
      'maintenanceThresholds', 'maintenanceLastReset',
      'lastSelectedFlightId', 'sidebarWidth', 'chartFieldSelections',
      'syncFolderPath', 'htmlReportPilotName', 'htmlReportDocTitle',
      'enabledSmartTagTypes', 'telemetryColors',
    ];
    if (typeof localStorage !== 'undefined') {
      const snapshot: Record<string, string> = {};
      for (const key of perProfileKeys) {
        const val = localStorage.getItem(key);
        if (val !== null) snapshot[key] = val;
      }
      localStorage.setItem(`profileSettings:${currentProfile}`, JSON.stringify(snapshot));
    }

    // ── Switch database on the backend ──
    const result = await api.switchProfile({
      name,
      create: opts?.create,
      password: opts?.password,
      new_password: opts?.newPassword,
      master_password: opts?.masterPassword,
    });

    // ── Store session token if provided (web mode, protected profile) ──
    if (result.session) {
      api.setProfileKey('profileSession', result.session);
    } else {
      api.removeProfileKey('profileSession');
    }

    // ── Load target profile's settings ──
    if (typeof localStorage !== 'undefined') {
      // Clear per-profile keys first
      for (const key of perProfileKeys) {
        localStorage.removeItem(key);
      }
      // Restore from saved snapshot (if exists)
      const savedSnapshot = localStorage.getItem(`profileSettings:${name}`);
      if (savedSnapshot) {
        try {
          const restored: Record<string, string> = JSON.parse(savedSnapshot);
          for (const [key, val] of Object.entries(restored)) {
            localStorage.setItem(key, val);
          }
        } catch {
          // ignore corrupt snapshot
        }
      }
      api.setProfileKey('activeProfile', name);
    }

    // Reload the page so all state re-initializes from localStorage
    window.location.reload();
  },

  deleteProfile: async (name: string, opts?: { password?: string; masterPassword?: string }) => {
    await api.deleteProfile({
      name,
      password: opts?.password,
      master_password: opts?.masterPassword,
    });
    // Remove session if this was the deleted profile
    api.removeProfileKey('profileSession');
    // Refresh the profile list
    await get().loadProfiles();
  },

  renameProfile: async (name: string, newName: string, opts?: { password?: string; masterPassword?: string }) => {
    const renamed = await api.renameProfile({
      name,
      new_name: newName,
      password: opts?.password,
      master_password: opts?.masterPassword,
    });
    // Carry this browser's saved settings for the profile over to its new name.
    if (typeof localStorage !== 'undefined') {
      for (const prefix of PROFILE_SCOPED_STORAGE_PREFIXES) {
        const value = localStorage.getItem(`${prefix}:${name}`);
        if (value !== null) {
          localStorage.setItem(`${prefix}:${renamed}`, value);
          localStorage.removeItem(`${prefix}:${name}`);
        }
      }
    }
    await get().loadProfiles();
  },

  logout: () => {
    // Clear session token (web mode)
    api.removeProfileKey('profileSession');
    // Reset initialised flag + trigger auth overlay
    set({ needsAuth: true, isFlightsInitialized: false });
  },
}));

// Register automatic logout when the server returns 401 (expired / invalid token).
api.onSessionExpired(() => {
  useFlightStore.getState().logout();
});
