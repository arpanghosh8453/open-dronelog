/**
 * Flight importer with drag-and-drop support
 * Handles file selection and invokes the Rust import command.
 * Supports both Tauri (native dialog) and web (HTML file input) modes.
 * 
 * Features:
 * - Batch imports defer flight list refresh until all files complete
 * - Personal API keys bypass cooldown entirely
 * - Progressive UI updates show import progress without expensive refreshes
 * - Sync folder support for automatic imports from a configured directory
 * - Blacklist support for deleted files (skipped during sync)
 */

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropzone } from 'react-dropzone';
import { sha256 } from 'js-sha256';
import {
  isWebMode,
  pickFiles,
  computeFileHash,
  getFlights,
  getSyncConfig,
  getSyncFiles,
  syncSingleFile,
  getSyncBlacklist,
  addToSyncBlacklist,
  removeFromSyncBlacklist,
  clearSyncBlacklist,
  getAllowedLogExtensions,
  logSyncEvent,
} from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';
import { ManualEntryModal } from './ManualEntryModal';
import { useIsMobileRuntime } from '@/hooks/platform/useIsMobileRuntime';

// Storage keys for sync folder and autoscan
const SYNC_FOLDER_KEY = 'syncFolderPath';
const AUTOSCAN_KEY = 'autoscanEnabled';
const MOBILE_SYNC_URI_KEY = 'mobileSyncFolderUri';
const DEFAULT_ALLOWED_EXTENSIONS = ['txt', 'csv', 'log', 'tsv'];
const REFRESH_INTERVAL = 10;
const STARTUP_SYNC_GUARD_PREFIX = 'startupSyncDone:';

// Guard startup auto-sync across component remounts within the same app session.
// Keyed by profile so each profile can auto-sync once per app startup.
const startupAutoSyncProfilesTriggered = new Set<string>();

function hasStartupSyncTriggered(profileKey: string): boolean {
  if (startupAutoSyncProfilesTriggered.has(profileKey)) return true;
  if (typeof sessionStorage === 'undefined') return false;
  return sessionStorage.getItem(`${STARTUP_SYNC_GUARD_PREFIX}${profileKey}`) === '1';
}

function markStartupSyncTriggered(profileKey: string): void {
  startupAutoSyncProfilesTriggered.add(profileKey);
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(`${STARTUP_SYNC_GUARD_PREFIX}${profileKey}`, '1');
}

type AndroidFsUri = {
  uri: string;
  documentTopTreeUri: string | null;
};

type AndroidFsEntry = {
  type: 'Dir' | 'File';
  name: string;
  uri: AndroidFsUri;
  mimeType?: string;
};

type AndroidFsModule = {
  AndroidFs: {
    showOpenDirPicker: (options?: { localOnly?: boolean }) => Promise<AndroidFsUri | null>;
    persistPickerUriPermission: (uri: AndroidFsUri) => Promise<void>;
    checkPersistedPickerUriPermission: (uri: AndroidFsUri, state: string) => Promise<boolean>;
    readDir: (uri: AndroidFsUri, options?: { offset?: number; limit?: number }) => Promise<AndroidFsEntry[]>;
    readFile: (uri: AndroidFsUri) => Promise<Uint8Array>;
  };
  AndroidUriPermissionState: {
    ReadOrWrite: string;
  };
  isAndroid: () => boolean;
};

function decodeFileUri(pathOrUri: string): string {
  try {
    if (pathOrUri.startsWith('file://')) {
      return decodeURIComponent(new URL(pathOrUri).pathname);
    }
  } catch {
    // Ignore parse errors and return raw value.
  }
  return pathOrUri;
}

export function normalizeSyncFolderPath(pathOrUri: string): string {
  const raw = decodeFileUri(pathOrUri.trim());
  if (raw.startsWith('content://')) {
    return raw;
  }
  if (raw.length <= 1) return raw;
  return raw.replace(/[\\/]+$/, '');
}

function isSyncFolderReadable(pathOrUri: string | null): boolean {
  return Boolean(pathOrUri);
}

function getMobileSyncFolderUri(): AndroidFsUri | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(MOBILE_SYNC_URI_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as AndroidFsUri;
    if (!parsed?.uri || typeof parsed.uri !== 'string') return null;
    return {
      uri: parsed.uri,
      documentTopTreeUri:
        parsed.documentTopTreeUri === null || typeof parsed.documentTopTreeUri === 'string'
          ? parsed.documentTopTreeUri
          : null,
    };
  } catch {
    return null;
  }
}

function setMobileSyncFolderUri(uri: AndroidFsUri | null): void {
  if (typeof localStorage === 'undefined') return;
  if (!uri) {
    localStorage.removeItem(MOBILE_SYNC_URI_KEY);
    return;
  }
  localStorage.setItem(MOBILE_SYNC_URI_KEY, JSON.stringify(uri));
}

function joinFolderPath(folderPath: string, fileName: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/, '');
  return `${trimmed}/${fileName}`;
}

function normalizeExtension(ext: string): string {
  return ext.trim().replace(/^\./, '').toLowerCase();
}

function hasAllowedExtension(fileName: string, allowed: Set<string>): boolean {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return false;
  return allowed.has(normalizeExtension(fileName.slice(dotIndex + 1)));
}

async function pickFolderFiles(accept?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;

    // Prefer folder selection where supported (webkit-based engines on Android).
    const folderInput = input as HTMLInputElement & {
      webkitdirectory?: boolean;
      directory?: boolean;
    };
    folderInput.webkitdirectory = true;
    folderInput.directory = true;

    input.onchange = () => {
      const files = Array.from(input.files || []);
      resolve(files);
    };
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

async function loadAndroidFsModule(): Promise<AndroidFsModule | null> {
  try {
    const mod = await import('tauri-plugin-android-fs-api');
    return mod as unknown as AndroidFsModule;
  } catch {
    return null;
  }
}

async function listFilesFromAndroidUri(
  androidFs: AndroidFsModule['AndroidFs'],
  dirUri: AndroidFsUri,
  allowed: Set<string>,
): Promise<File[]> {
  const files: File[] = [];

  const walk = async (uri: AndroidFsUri) => {
    const entries = await androidFs.readDir(uri);
    for (const entry of entries) {
      if (entry.type === 'Dir') {
        await walk(entry.uri);
        continue;
      }

      if (entry.type === 'File' && hasAllowedExtension(entry.name, allowed)) {
        const content = await androidFs.readFile(entry.uri);
        const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
        const normalizedBytes = new Uint8Array(bytes.byteLength);
        normalizedBytes.set(bytes);
        files.push(new File([normalizedBytes], entry.name, { type: entry.mimeType || 'application/octet-stream' }));
      }
    }
  };

  await walk(dirUri);
  return files;
}

// Get autoscan enabled setting from localStorage
export function getAutoscanEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true; // Default to enabled
  const stored = localStorage.getItem(AUTOSCAN_KEY);
  return stored !== 'false'; // Default to true if not set
}

// Set autoscan enabled setting
export function setAutoscanEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUTOSCAN_KEY, String(enabled));
}

// Get sync folder path from localStorage
export function getSyncFolderPath(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SYNC_FOLDER_KEY);
}

// Set sync folder path in localStorage
export function setSyncFolderPath(path: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (path) {
    localStorage.setItem(SYNC_FOLDER_KEY, normalizeSyncFolderPath(path));
  } else {
    localStorage.removeItem(SYNC_FOLDER_KEY);
    localStorage.removeItem(MOBILE_SYNC_URI_KEY);
  }
}

// Get blacklisted file hashes (used when deleting flights)
export async function getBlacklist(): Promise<Set<string>> {
  try {
    const hashes = await getSyncBlacklist();
    return new Set(hashes);
  } catch {
    return new Set();
  }
}

// Add hash to blacklist (called when deleting a flight)
export async function addToBlacklist(hash: string): Promise<void> {
  if (!hash) return;
  try {
    await addToSyncBlacklist(hash);
  } catch {
    // Best-effort: deletion still proceeds even if blacklist write fails.
  }
}

// Remove hash from blacklist (when manually importing)
export async function removeFromBlacklist(hash: string): Promise<void> {
  if (!hash) return;
  try {
    await removeFromSyncBlacklist(hash);
  } catch {
    // Best-effort: import still succeeds even if blacklist cleanup fails.
  }
}

// Clear entire blacklist (e.g., when user wants to reset)
export async function clearBlacklist(): Promise<void> {
  try {
    await clearSyncBlacklist();
  } catch {
    // Best-effort: caller controls UI messaging.
  }
}

export function FlightImporter() {
  const { t } = useTranslation();
  const isMobileRuntime = useIsMobileRuntime();
  const { importLog, isImporting, apiKeyType, loadApiKeyType, isBatchProcessing, setIsBatchProcessing, activeProfile } = useFlightStore();
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [syncFolderPath, setSyncFolderPathState] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [backgroundSyncResult, setBackgroundSyncResult] = useState<string | null>(null);
  const [autoscanEnabled, setAutoscanEnabledState] = useState(() => getAutoscanEnabled());
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>(DEFAULT_ALLOWED_EXTENSIONS);
  const backgroundSyncTriggeredRef = useRef(false);
  const backgroundSyncAbortRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const allowedExtensionSetRef = useRef<Set<string>>(new Set(DEFAULT_ALLOWED_EXTENSIONS.map(normalizeExtension)));
  const startupBusyStateRef = useRef({
    isImporting: false,
    isBatchProcessing: false,
    isSyncing: false,
  });
  const startupTimersRef = useRef<number[]>([]);
  const mobileSyncFilesRef = useRef<File[]>([]);
  const allowedExtensionSet = useMemo(
    () => new Set(allowedExtensions.map(normalizeExtension)),
    [allowedExtensions]
  );
  const allowedExtensionsWithDot = useMemo(
    () => allowedExtensions.map((ext) => `.${normalizeExtension(ext)}`),
    [allowedExtensions]
  );
  const browseAcceptString = useMemo(
    () => allowedExtensionsWithDot.join(','),
    [allowedExtensionsWithDot]
  );

  // Load sync folder path on mount and listen for changes from Dashboard
  useEffect(() => {
    setSyncFolderPathState(getSyncFolderPath());
    
    const handleSyncFolderChanged = () => {
      setSyncFolderPathState(getSyncFolderPath());
    };
    window.addEventListener('syncFolderChanged', handleSyncFolderChanged);
    return () => window.removeEventListener('syncFolderChanged', handleSyncFolderChanged);
  }, []);

  // Load API key type on mount to determine cooldown behavior
  useEffect(() => {
    loadApiKeyType();
  }, [loadApiKeyType]);

  // Load dynamic allowed extensions (built-in + parsers.json mappings)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const ext = await getAllowedLogExtensions();
        if (cancelled || ext.length === 0) return;
        const normalized = Array.from(new Set(ext.map(normalizeExtension)));
        if (normalized.length > 0) {
          setAllowedExtensions(normalized);
        }
      } catch (error) {
        console.warn('Failed to load dynamic allowed log extensions, using defaults:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const logImporterEvent = useCallback((message: string, meta?: Record<string, unknown>) => {
    void logSyncEvent('info', message, meta).catch(() => {
      // Best-effort logging only; never block sync/import actions.
    });
  }, []);

  const cancelCurrentImporterAction = useCallback(() => {
    const hadActiveQueue = isImporting || isBatchProcessing || isSyncing || isBackgroundSyncing;
    if (hadActiveQueue) {
      logImporterEvent('Import queue cancellation requested by user.', {
        isImporting,
        isBatchProcessing,
        isSyncing,
        isBackgroundSyncing,
      });
    }
    cancelRequestedRef.current = true;
    backgroundSyncAbortRef.current = true;
    setIsBackgroundSyncing(false);
    setBackgroundSyncResult(null);
    setIsSyncing(false);
    setIsBatchProcessing(false);
    setCurrentFileName(null);
    setBatchTotal(0);
    setBatchIndex(0);
  }, [isBackgroundSyncing, isBatchProcessing, isImporting, isSyncing, logImporterEvent, setIsBatchProcessing]);

  useEffect(() => {
    const handleCancelRequest = () => {
      cancelCurrentImporterAction();
    };
    window.addEventListener('cancelImporterAction', handleCancelRequest as EventListener);
    return () => {
      window.removeEventListener('cancelImporterAction', handleCancelRequest as EventListener);
    };
  }, [cancelCurrentImporterAction]);

  useEffect(() => {
    const busy = isImporting || isBatchProcessing || isSyncing || isBackgroundSyncing;
    window.dispatchEvent(
      new CustomEvent('importerBusyStateChanged', {
        detail: { busy },
      })
    );
  }, [isImporting, isBatchProcessing, isSyncing, isBackgroundSyncing]);

  const runCooldown = async (seconds: number) => {
    setCooldownRemaining(seconds);
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (cancelRequestedRef.current) {
        setCooldownRemaining(0);
        return;
      }
      await sleep(1000);
      setCooldownRemaining(remaining - 1);
    }
  };

  /** 
   * Process a batch of files efficiently
   * - Personal API keys: no cooldown, optimized batch import
   * - Default API key: cooldown between files, sequential import
   * - Flight list refreshes periodically so user sees progress
   * - isManualImport: if true, removes files from blacklist (allows re-importing deleted files)
   *                   if false (sync), checks blacklist BEFORE importing and skips blacklisted files
   */
  const processBatch = async (items: (string | File)[], isManualImport = true) => {
    if (items.length === 0) return;

    cancelRequestedRef.current = false;

    logImporterEvent('Batch processing started.', {
      queueSize: items.length,
      mode: isManualImport ? 'manual-import' : 'sync-import',
    });

    setBatchMessage(null);
    setIsBatchProcessing(true);
    setBatchTotal(items.length);
    setBatchIndex(0);

    // Fetch fresh API key type right before processing to ensure it's up to date
    await loadApiKeyType();
    const currentApiKeyType = useFlightStore.getState().apiKeyType;
    const hasPersonalKey = currentApiKeyType === 'personal';
    
    // Helper to refresh flight list in background (non-blocking)
    const refreshFlightListBackground = () => {
      const { loadFlights, loadOverview, loadAllTags } = useFlightStore.getState();
      // Don't await - let it run in background
      Promise.allSettled([loadFlights(), loadOverview()]).then(() => loadAllTags());
    };

    // Get existing hashes + blacklist for sync mode, so we can skip duplicates before import.
    const existingHashes = !isManualImport
      ? new Set(
          (await getFlights())
            .map((flight) => flight.fileHash)
            .filter((hash): hash is string => Boolean(hash))
        )
      : new Set<string>();
    const blacklist = !isManualImport ? await getBlacklist() : new Set<string>();

    const computeItemHash = async (item: string | File): Promise<string | null> => {
      try {
        if (typeof item === 'string') {
          return await computeFileHash(item);
        }
        const bytes = new Uint8Array(await item.arrayBuffer());
        return sha256(bytes);
      } catch {
        // If hashing fails, proceed with import and rely on backend duplicate checks.
        return null;
      }
    };

    // For sync mode: pre-check existing + blacklist before import.
    const checkSyncSkipReason = async (
      item: string | File
    ): Promise<'existing' | 'blacklisted' | null> => {
      if (isManualImport) return null;
      if (existingHashes.size === 0 && blacklist.size === 0) return null;

      const hash = await computeItemHash(item);
      if (!hash) return null;
      if (existingHashes.has(hash)) return 'existing';
      if (blacklist.has(hash)) return 'blacklisted';
      return null;
    };

    const finalizeCancelledBatch = () => {
      setIsBatchProcessing(false);
      setCurrentFileName(null);
      setBatchTotal(0);
      setBatchIndex(0);
      setCooldownRemaining(0);
      setBatchMessage('Import canceled.');
      logImporterEvent('Batch processing canceled by user.', {
        mode: isManualImport ? 'manual-import' : 'sync-import',
      });
    };
    
    if (hasPersonalKey) {
      // Optimized path: batch import without cooldown
      // Refresh flight list every 10 files to show progress
      let processed = 0;
      let skipped = 0;
      let duplicates = 0;
      let invalidFiles = 0;
      let blacklisted = 0;
      for (let index = 0; index < items.length; index += 1) {
        if (cancelRequestedRef.current) break;
        const item = items[index];
        setBatchIndex(index + 1);
        const name =
          typeof item === 'string'
            ? getShortFileName(item)
            : item.name.length <= 50
            ? item.name
            : `${item.name.slice(0, 50)}…`;
        setCurrentFileName(name);

        // For sync mode: check existing and blacklist BEFORE importing.
        const skipReason = await checkSyncSkipReason(item);
        if (cancelRequestedRef.current) break;
        if (skipReason === 'existing') {
          skipped += 1;
          continue;
        }
        if (skipReason === 'blacklisted') {
          blacklisted += 1;
          continue;
        }

        // Import without refreshing flight list (skipRefresh = true)
        const result = await importLog(item, true);
        if (cancelRequestedRef.current) {
          finalizeCancelledBatch();
          return;
        }
        if (!result.success) {
          if (result.message.toLowerCase().includes('already been imported')) {
            skipped += 1;
          } else if (result.message.toLowerCase().includes('duplicate flight')) {
            duplicates += 1;
          } else {
            // Parse errors, corrupt files, incompatible formats, timeouts, etc.
            invalidFiles += 1;
          }
        } else {
          processed += 1;
          // For manual import, remove from blacklist (allows re-importing)
          if (isManualImport && result.fileHash) {
            await removeFromBlacklist(result.fileHash);
          }
          // Refresh flight list periodically so user sees progress
          if (processed % REFRESH_INTERVAL === 0) {
            refreshFlightListBackground();
          }
        }
      }

      if (cancelRequestedRef.current) {
        finalizeCancelledBatch();
        return;
      }

      // Final refresh at the end
      if (processed > 0) {
        setCurrentFileName(t('importer.refreshingList'));
        const { loadFlights, loadOverview, loadAllTags } = useFlightStore.getState();
        await Promise.all([loadFlights(), loadOverview()]);
        loadAllTags();
      }

      setIsBatchProcessing(false);
      setCurrentFileName(null);
      setBatchTotal(0);
      setBatchIndex(0);

      // Build completion message
      const parts: string[] = [];
      if (processed > 0) parts.push(t('importer.filesProcessed', { n: processed }));
      if (skipped > 0) parts.push(`${skipped} ${t('importer.skippedAlready')}`);
      if (duplicates > 0) parts.push(`${duplicates} ${t('importer.skippedDuplicate')}`);
      if (blacklisted > 0) parts.push(`${blacklisted} ${t('importer.skippedBlacklisted')}`);
      if (invalidFiles > 0) parts.push(`${invalidFiles} ${t('importer.skippedIncompatible')}`);
      setBatchMessage(`${t('importer.importFinished')} ${parts.join(', ')}.`);
    } else {
      // Standard path with cooldown (default API key)
      // Refresh flight list after each successful import (during cooldown)
      let skipped = 0;
      let processed = 0;
      let blacklisted = 0;
      let invalidFiles = 0;
      let duplicates = 0;

      for (let index = 0; index < items.length; index += 1) {
        if (cancelRequestedRef.current) break;
        const item = items[index];
        const isLast = index === items.length - 1;
        setBatchIndex(index + 1);
        const name =
          typeof item === 'string'
            ? getShortFileName(item)
            : item.name.length <= 50
            ? item.name
            : `${item.name.slice(0, 50)}…`;
        setCurrentFileName(name);
        
        // For sync mode: check existing and blacklist BEFORE importing.
        const skipReason = await checkSyncSkipReason(item);
        if (cancelRequestedRef.current) break;
        if (skipReason === 'existing') {
          skipped += 1;
          continue;
        }
        if (skipReason === 'blacklisted') {
          blacklisted += 1;
          continue;
        }
        
        // Use skipRefresh=true to defer refresh until batch completes
        const result = await importLog(item, true);
        if (cancelRequestedRef.current) {
          finalizeCancelledBatch();
          return;
        }
        if (!result.success) {
          if (result.message.toLowerCase().includes('already been imported')) {
            skipped += 1;
          } else if (result.message.toLowerCase().includes('duplicate flight')) {
            duplicates += 1;
          } else {
            // Parse errors, corrupt files, incompatible formats, timeouts, etc.
            // Only show alert for manual imports, silently skip for sync
            invalidFiles += 1;
            if (isManualImport) {
              console.warn(`Failed to import: ${result.message}`);
            }
          }
        } else {
          processed += 1;
          // For manual import, remove from blacklist (allows re-importing)
          if (isManualImport && result.fileHash) {
            await removeFromBlacklist(result.fileHash);
          }
          // Refresh flight list periodically during batch processing.
          // Keep cadence consistent across runtimes.
          if (processed % REFRESH_INTERVAL === 0) {
            refreshFlightListBackground();
          }
          
          // Only apply cooldown between successful imports (not on last)
          if (!isLast) {
            await runCooldown(5);
            if (cancelRequestedRef.current) {
              finalizeCancelledBatch();
              return;
            }
          }
        }
      }

      if (cancelRequestedRef.current) {
        finalizeCancelledBatch();
        return;
      }

      // Final refresh to ensure everything is up to date
      if (processed > 0) {
        setCurrentFileName(t('importer.refreshingList'));
        const { loadFlights, loadOverview, loadAllTags } = useFlightStore.getState();
        await Promise.all([loadFlights(), loadOverview()]);
        loadAllTags();
      }

      setIsBatchProcessing(false);
      setCurrentFileName(null);
      setBatchTotal(0);
      setBatchIndex(0);
      setCooldownRemaining(0);
      
      // Build completion message
      const parts: string[] = [];
      if (processed > 0) parts.push(t('importer.filesProcessed', { n: processed }));
      if (skipped > 0) parts.push(`${skipped} ${t('importer.skippedAlready')}`);
      if (duplicates > 0) parts.push(`${duplicates} ${t('importer.skippedDuplicate')}`);
      if (blacklisted > 0) parts.push(`${blacklisted} ${t('importer.skippedBlacklisted')}`);
      if (invalidFiles > 0) parts.push(`${invalidFiles} ${t('importer.skippedIncompatible')}`);
      setBatchMessage(`${t('importer.importFinished')} ${parts.join(', ')}.`);
    }
  };

  // Handle file selection via dialog
  const handleBrowse = async () => {
    // Use browser-style File objects on web and mobile runtimes.
    // On Android this avoids path-only imports from content URIs.
    if (isWebMode() || isMobileRuntime) {
      const files = await pickFiles(browseAcceptString, true);
      await processBatch(files);
    } else {
      // Tauri mode: use native dialog
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: 'Drone Log Files',
            extensions: allowedExtensions,
          },
        ],
      });

      const files =
        typeof selected === 'string'
          ? [selected]
          : Array.isArray(selected)
          ? selected
          : [];

      await processBatch(files);
    }
  };

  const loadFilesFromSavedMobileDirectory = useCallback(async (): Promise<boolean> => {
    const androidFsModule = await loadAndroidFsModule();
    if (!androidFsModule || !androidFsModule.isAndroid()) return false;

    const savedUri = getMobileSyncFolderUri();
    if (!savedUri) return false;

    const hasPersistedPermission = await androidFsModule.AndroidFs.checkPersistedPickerUriPermission(
      savedUri,
      androidFsModule.AndroidUriPermissionState.ReadOrWrite,
    );
    if (!hasPersistedPermission) return false;

    const files = await listFilesFromAndroidUri(
      androidFsModule.AndroidFs,
      savedUri,
      allowedExtensionSetRef.current,
    );
    if (files.length === 0) return false;

    mobileSyncFilesRef.current = files;
    setSyncFolderPath(savedUri.uri);
    window.dispatchEvent(new CustomEvent('syncFolderChanged'));
    return true;
  }, []);

  const selectMobileSyncFolder = useCallback(async (): Promise<boolean> => {
    const androidFsModule = await loadAndroidFsModule();
    if (androidFsModule && androidFsModule.isAndroid()) {
      try {
        const selectedUri = await androidFsModule.AndroidFs.showOpenDirPicker();
        if (!selectedUri) return false;

        await androidFsModule.AndroidFs.persistPickerUriPermission(selectedUri);

        const files = await listFilesFromAndroidUri(
          androidFsModule.AndroidFs,
          selectedUri,
          allowedExtensionSetRef.current,
        );
        if (files.length === 0) {
          setBatchMessage(t('importer.noFlightLogs'));
          return false;
        }

        setMobileSyncFolderUri(selectedUri);
        mobileSyncFilesRef.current = files;
        setSyncFolderPath(selectedUri.uri);
        window.dispatchEvent(new CustomEvent('syncFolderChanged'));
        return true;
      } catch (error) {
        console.warn('Android SAF folder picker failed, falling back to file selection:', error);
      }
    }

    const selectedFiles = await pickFolderFiles(browseAcceptString);
    const filteredFiles = selectedFiles.filter((file) => hasAllowedExtension(file.name, allowedExtensionSetRef.current));

    if (filteredFiles.length === 0) {
      if (selectedFiles.length > 0) {
        setBatchMessage(t('importer.noFlightLogs'));
      }
      return false;
    }

    mobileSyncFilesRef.current = filteredFiles;

    const relativePath = filteredFiles[0].webkitRelativePath || '';
    const folderName = relativePath.includes('/')
      ? relativePath.split('/')[0]
      : 'selected-files';

    setSyncFolderPath(`mobile://${folderName}`);
    window.dispatchEvent(new CustomEvent('syncFolderChanged'));
    return true;
  }, [browseAcceptString, t]);

  // Handle drag and drop (web mode via react-dropzone)
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0 && isWebMode()) {
        await processBatch(acceptedFiles);
      }
    },
    [importLog, apiKeyType]
  );

  const { getRootProps, getInputProps, isDragActive: webDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/octet-stream': allowedExtensionsWithDot,
    },
    multiple: true,
    noClick: true,
    disabled: !isWebMode(), // Disable react-dropzone in Tauri mode
  });

  // Handle drag and drop (Tauri mode via onDragDropEvent)
  const [tauriDragActive, setTauriDragActive] = useState(false);
  const processBatchRef = useRef(processBatch);
  processBatchRef.current = processBatch;

  // Cancel background sync when user initiates manual import/sync
  const cancelBackgroundSync = () => {
    if (isBackgroundSyncing) {
      backgroundSyncAbortRef.current = true;
      setIsBackgroundSyncing(false);
      setBackgroundSyncResult(null);
    }
  };

  useEffect(() => {
    if (isWebMode()) return;

    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            setTauriDragActive(true);
          } else if (event.payload.type === 'drop') {
            setTauriDragActive(false);
            const paths = event.payload.paths;
            // Filter to supported extensions
            const supported = paths.filter((p: string) => hasAllowedExtension(p, allowedExtensionSet));
            if (supported.length > 0) {
              // Cancel background sync - user action takes priority
              cancelBackgroundSync();
              processBatchRef.current(supported);
            }
          } else if (event.payload.type === 'leave') {
            setTauriDragActive(false);
          }
        });
      } catch (e) {
        console.warn('Tauri drag-drop listener not available:', e);
      }
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, [allowedExtensionSet]);

  useEffect(() => {
    const handleMobileSyncFolderRequest = async () => {
      if (!isMobileRuntime || isWebMode()) return;
      await selectMobileSyncFolder();
    };

    window.addEventListener('requestMobileSyncFolderSelection', handleMobileSyncFolderRequest as EventListener);
    return () => {
      window.removeEventListener('requestMobileSyncFolderSelection', handleMobileSyncFolderRequest as EventListener);
    };
  }, [isMobileRuntime, selectMobileSyncFolder]);

  useEffect(() => {
    if (!isMobileRuntime || isWebMode()) return;

    void loadFilesFromSavedMobileDirectory();
  }, [isMobileRuntime, loadFilesFromSavedMobileDirectory]);

  useEffect(() => {
    allowedExtensionSetRef.current = allowedExtensionSet;
  }, [allowedExtensionSet]);

  useEffect(() => {
    startupBusyStateRef.current = { isImporting, isBatchProcessing, isSyncing };
  }, [isImporting, isBatchProcessing, isSyncing]);

  // Background automatic sync on startup (one-shot, lazy loaded, non-blocking)
  useEffect(() => {
    const STARTUP_DELAY_MS = 3000;
    const BUSY_RETRY_DELAY_MS = 3000;
    const BUSY_RETRY_MAX_ATTEMPTS = 3;

    const trackTimer = (timerId: number) => {
      startupTimersRef.current.push(timerId);
      return timerId;
    };

    const isBusy = () => {
      const { isImporting: busyImporting, isBatchProcessing: busyBatch, isSyncing: busySync } = startupBusyStateRef.current;
      return busyImporting || busyBatch || busySync;
    };

    const scheduleBusyRetry = async (
      attempt: number,
      runner: (nextAttempt: number) => Promise<void>,
    ) => {
      if (backgroundSyncAbortRef.current) return;
      if (!isBusy()) {
        await runner(attempt);
        return;
      }
      if (attempt >= BUSY_RETRY_MAX_ATTEMPTS) {
        console.debug('Startup auto-sync skipped after max busy retries.');
        return;
      }
      const retryTimer = window.setTimeout(() => {
        void scheduleBusyRetry(attempt + 1, runner);
      }, BUSY_RETRY_DELAY_MS);
      trackTimer(retryTimer);
    };

    const profileKey = (activeProfile || 'default').trim() || 'default';

    // Only run once per profile per app session, even if importer remounts.
    if (hasStartupSyncTriggered(profileKey) || backgroundSyncTriggeredRef.current) return;

    // Web mode relies on server-side cron scheduling only.
    if (isWebMode()) {
      markStartupSyncTriggered(profileKey);
      backgroundSyncTriggeredRef.current = true;
      return;
    }

    markStartupSyncTriggered(profileKey);
    
    if (isMobileRuntime && !isWebMode()) {
      if (!getAutoscanEnabled()) return;

      backgroundSyncTriggeredRef.current = true;
      backgroundSyncAbortRef.current = false;

      const runMobileStartupSync = async () => {
        if (!getAutoscanEnabled()) return;

        const hasSavedFolder = await loadFilesFromSavedMobileDirectory();
        if (!hasSavedFolder) return;

        if (backgroundSyncAbortRef.current) return;

        logImporterEvent('Auto-scan on startup started (mobile mode).', {
          syncFolderPath: getSyncFolderPath(),
        });

        await processBatchRef.current([...mobileSyncFilesRef.current], false);
        mobileSyncFilesRef.current = [];
      };

      const timeoutId = window.setTimeout(() => {
        void scheduleBusyRetry(0, async () => {
          await runMobileStartupSync();
        });
      }, STARTUP_DELAY_MS);
      trackTimer(timeoutId);

      return () => {
        for (const timerId of startupTimersRef.current) {
          clearTimeout(timerId);
        }
        startupTimersRef.current = [];
      };
    }

    // Desktop mode: only if sync folder is configured and autoscan enabled
    if (!getAutoscanEnabled()) return;
    
    // Mark as triggered to prevent re-running
    backgroundSyncTriggeredRef.current = true;
    // Reset abort flag for this run
    backgroundSyncAbortRef.current = false;

    const runDesktopStartupSync = async () => {
      if (!getAutoscanEnabled()) return;

      const folderPath = getSyncFolderPath();
      if (!folderPath || !isSyncFolderReadable(folderPath)) return;

      logImporterEvent('Auto-scan on startup started (desktop mode).', {
        folderPath,
      });
      
      setIsBackgroundSyncing(true);
      setBackgroundSyncResult(null);
      
      try {
        // Check abort before each async operation
        if (backgroundSyncAbortRef.current) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        const { readDir } = await import('@tauri-apps/plugin-fs');
        const entries = await readDir(folderPath);
        
        // Check abort after directory read
        if (backgroundSyncAbortRef.current) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        // Filter only files with allowed log extensions
        const logFiles = entries
          .filter((entry) => {
            if (!entry.isFile || !entry.name) return false;
            return hasAllowedExtension(entry.name, allowedExtensionSetRef.current);
          })
          .map((entry) => joinFolderPath(folderPath, entry.name!));
        
        if (logFiles.length === 0) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        // Get existing file hashes to check for new files
        const existingFlights = await getFlights();
        const existingHashes = new Set(existingFlights.map(f => f.fileHash).filter(Boolean));
        const blacklist = await getBlacklist();
        
        // Find truly new files (not already imported, not blacklisted)
        const newFiles: string[] = [];
        let skippedExisting = 0;
        let skippedBlacklisted = 0;
        let hashErrors = 0;
        for (const filePath of logFiles) {
          // Check abort during hash computation loop
          if (backgroundSyncAbortRef.current) {
            setIsBackgroundSyncing(false);
            return;
          }
          try {
            const hash = await computeFileHash(filePath);
            if (existingHashes.has(hash)) {
              skippedExisting += 1;
              continue;
            }
            if (blacklist.has(hash)) {
              skippedBlacklisted += 1;
              continue;
            }
            if (!existingHashes.has(hash) && !blacklist.has(hash)) {
              newFiles.push(filePath);
            }
          } catch {
            // If hash fails, skip silently
            hashErrors += 1;
          }
        }

        logImporterEvent('Desktop auto-sync prefilter summary.', {
          profile: activeProfile,
          candidates: logFiles.length,
          newFiles: newFiles.length,
          skippedExisting,
          skippedBlacklisted,
          hashErrors,
        });
        
        // Final abort check before importing
        if (backgroundSyncAbortRef.current) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        setIsBackgroundSyncing(false);
        
        if (newFiles.length > 0) {
          // Show hint about new files found, then auto-import them
          setBackgroundSyncResult(t('importer.foundNewFiles', { n: newFiles.length }));
          
          // Small delay to show the message, then start import
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Check abort before starting import
          if (backgroundSyncAbortRef.current) {
            setBackgroundSyncResult(null);
            return;
          }
          
          setBackgroundSyncResult(null);
          
          // Process the new files (non-blocking, will show normal import progress)
          await processBatchRef.current(newFiles, false);
        }
      } catch (e) {
        console.error('Background sync check failed:', e);
        setIsBackgroundSyncing(false);
      }
    };

    // Lazy load: wait before startup autosync to not block initial render
    const timeoutId = window.setTimeout(() => {
      void scheduleBusyRetry(0, async () => {
        await runDesktopStartupSync();
      });
    }, STARTUP_DELAY_MS);
    trackTimer(timeoutId);
    
    return () => {
      for (const timerId of startupTimersRef.current) {
        clearTimeout(timerId);
      }
      startupTimersRef.current = [];
    };
  }, [activeProfile, isMobileRuntime, loadFilesFromSavedMobileDirectory]);

  const isDragActive = webDragActive || tauriDragActive;

  // State for web mode sync configuration
  const [webSyncPath, setWebSyncPath] = useState<string | null>(null);

  // Check if web sync is configured on mount
  useEffect(() => {
    if (!isWebMode()) return;
    
    getSyncConfig().then(config => {
      setWebSyncPath(config.syncPath);
    }).catch(() => {
      // Silently ignore
    });
  }, []);

  // Handle sync button click
  const handleSync = async () => {
    // Cancel background sync - user action takes priority
    cancelBackgroundSync();
    cancelRequestedRef.current = false;

    logImporterEvent('Sync started from importer action.', {
      mode: isWebMode() ? 'web' : 'desktop',
      autoscanEnabled,
      syncFolderPath: getSyncFolderPath(),
    });

    // Web mode: use server-side sync with file-by-file progress
    if (isWebMode()) {
      setIsSyncing(true);
      setBatchMessage(null);
      
      try {
        // Ensure API key type is fresh before deciding cooldown behavior.
        await loadApiKeyType();
        const currentApiKeyType = useFlightStore.getState().apiKeyType;
        const hasPersonalKey = currentApiKeyType === 'personal';

        // First get the list of files to sync
        const filesResponse = await getSyncFiles();
        
        if (!filesResponse.syncPath) {
          setIsSyncing(false);
          setBatchMessage('NO_SYNC_FOLDER_WEB');
          return;
        }
        
        if (filesResponse.files.length === 0) {
          setIsSyncing(false);
          setBatchMessage(t('importer.noNewFiles'));
          return;
        }
        
        // Switch to batch processing mode for progress tracking
        setIsSyncing(false);
        setIsBatchProcessing(true);
        setBatchTotal(filesResponse.files.length);
        setBatchIndex(0);

        logImporterEvent('Web manual sync prefilter summary.', {
          profile: activeProfile,
          candidatesFromServer: filesResponse.files.length,
        });
        
        let processed = 0;
        let skipped = 0;
        let errors = 0;
        for (let i = 0; i < filesResponse.files.length; i++) {
          if (cancelRequestedRef.current) break;
          const isLast = i === filesResponse.files.length - 1;
          const filename = filesResponse.files[i];
          setBatchIndex(i + 1);
          setCurrentFileName(filename.length > 50 ? `${filename.slice(0, 50)}…` : filename);
          
          try {
            const result = await syncSingleFile(filename);
            if (result.success) {
              processed++;
              // Refresh flight list every 10 files to show progress
              if (processed % REFRESH_INTERVAL === 0) {
                const { loadFlights, loadOverview, loadAllTags } = useFlightStore.getState();
                Promise.allSettled([loadFlights(), loadOverview()]).then(() => loadAllTags());
              }

              // Match browse import behavior: cooldown only for default/shared key.
              if (!hasPersonalKey && !isLast) {
                await runCooldown(5);
                if (cancelRequestedRef.current) break;
              }
            } else if (
              result.message.toLowerCase().includes('already') ||
              result.message.toLowerCase().includes('duplicate') ||
              result.message.toLowerCase().includes('blacklisted')
            ) {
              skipped++;
            } else {
              errors++;
            }
          } catch (e) {
            console.error(`Failed to sync ${filename}:`, e);
            errors++;
          }
        }

        if (cancelRequestedRef.current) {
          setIsBatchProcessing(false);
          setCurrentFileName(null);
          setBatchTotal(0);
          setBatchIndex(0);
          setBatchMessage('Sync canceled.');
          return;
        }
        
        setIsBatchProcessing(false);
        setCurrentFileName(null);
        setBatchTotal(0);
        setBatchIndex(0);
        
        // Final refresh
        if (processed > 0) {
          const { loadFlights, loadOverview, loadAllTags } = useFlightStore.getState();
          await Promise.all([loadFlights(), loadOverview()]);
          loadAllTags();
        }
        
        // Show result
        if (processed > 0 || skipped > 0 || errors > 0) {
          logImporterEvent('Web manual sync execution summary.', {
            profile: activeProfile,
            imported: processed,
            skipped,
            errors,
          });
          const parts: string[] = [];
          if (processed > 0) parts.push(`${processed} imported`);
          if (skipped > 0) parts.push(`${skipped} skipped`);
          if (errors > 0) parts.push(`${errors} errors`);
          setBatchMessage(t('importer.syncComplete', { parts: parts.join(', ') }));
        } else {
          setBatchMessage(t('importer.noFilesToSync'));
        }
      } catch (e) {
        console.error('Sync failed:', e);
        setBatchMessage(`Sync failed: ${e}`);
        setIsSyncing(false);
        setIsBatchProcessing(false);
      }
      return;
    }

    if (isMobileRuntime) {
      if (mobileSyncFilesRef.current.length === 0) {
        const restored = await loadFilesFromSavedMobileDirectory();
        if (!restored) {
          const selected = await selectMobileSyncFolder();
          if (!selected || mobileSyncFilesRef.current.length === 0) {
            setBatchMessage('NO_SYNC_FOLDER');
            return;
          }
        }

        if (mobileSyncFilesRef.current.length === 0) {
          setBatchMessage('NO_SYNC_FOLDER');
          return;
        }
      }

      await processBatch([...mobileSyncFilesRef.current], false);
      mobileSyncFilesRef.current = [];
      return;
    }

    // Desktop mode: use local sync folder
    const folderPath = getSyncFolderPath();
    if (!folderPath) {
      setBatchMessage('NO_SYNC_FOLDER');
      return;
    }
    setIsSyncing(true);
    setBatchMessage(null);

    try {
      // Read directory contents using Tauri
      const { readDir } = await import('@tauri-apps/plugin-fs');
      const entries = await readDir(folderPath);
      if (cancelRequestedRef.current) {
        setIsSyncing(false);
        return;
      }
      
      // Filter only files with allowed log extensions
      const logFiles = entries
        .filter((entry) => {
          if (!entry.isFile || !entry.name) return false;
          return hasAllowedExtension(entry.name, allowedExtensionSet);
        })
        .map((entry) => joinFolderPath(folderPath, entry.name!));

      if (cancelRequestedRef.current) {
        setIsSyncing(false);
        return;
      }

      if (logFiles.length === 0) {
        setBatchMessage(t('importer.noFlightLogs'));
        setIsSyncing(false);
        return;
      }

      // Pre-filter to only truly new files (not already imported and not blacklisted)
      // before entering batch processing. This mirrors startup autoscan behavior.
      const existingFlights = await getFlights();
      const existingHashes = new Set(existingFlights.map((f) => f.fileHash).filter(Boolean));
      const blacklist = await getBlacklist();

      const newFiles: string[] = [];
      let skippedExisting = 0;
      let skippedBlacklisted = 0;
      let hashErrors = 0;
      for (const filePath of logFiles) {
        if (cancelRequestedRef.current) {
          setIsSyncing(false);
          return;
        }
        try {
          const hash = await computeFileHash(filePath);
          if (existingHashes.has(hash)) {
            skippedExisting += 1;
            continue;
          }
          if (blacklist.has(hash)) {
            skippedBlacklisted += 1;
            continue;
          }
          if (!existingHashes.has(hash) && !blacklist.has(hash)) {
            newFiles.push(filePath);
          }
        } catch {
          // If hash computation fails, skip this file for safety.
          hashErrors += 1;
        }
      }

      logImporterEvent('Desktop manual sync prefilter summary.', {
        profile: activeProfile,
        candidates: logFiles.length,
        newFiles: newFiles.length,
        skippedExisting,
        skippedBlacklisted,
        hashErrors,
      });

      if (newFiles.length === 0) {
        setBatchMessage(t('importer.noNewFiles'));
        setIsSyncing(false);
        return;
      }

      // For sync, pass isManualImport=false and only new files to batch processing.
      setIsSyncing(false);
      await processBatch(newFiles, false); // isManualImport = false for sync
    } catch (e) {
      console.error('Sync failed:', e);
      setBatchMessage(`Sync failed: ${e}`);
      setIsSyncing(false);
    }
  };

  // Get short folder name for display
  const getSyncFolderDisplayName = () => {
    if (!syncFolderPath) return null;
    const parts = syncFolderPath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || syncFolderPath;
  };

  const litchiHubBridgeUrl = `https://flylitchi.com/hub-bridge?action=open&folder=${encodeURIComponent(syncFolderPath ?? '')}&sync=true`;

  return (
    <div
      {...(isWebMode() ? getRootProps() : {})}
      className={`drop-zone p-4 text-center overflow-hidden ${isDragActive ? 'active' : ''}`}
    >
      {isWebMode() && <input {...getInputProps()} />}

      {isImporting || isBatchProcessing || isSyncing ? (
        <div className="flex flex-col items-center gap-2">
          <div className="w-6 h-6 border-2 border-drone-primary border-t-transparent rounded-full spinner" />
          <span className="text-xs text-gray-400 break-all text-center w-full px-2">
            {cooldownRemaining > 0
              ? t('importer.coolingDown', { n: cooldownRemaining })
              : isSyncing
              ? t('importer.scanningSync')
              : currentFileName
              ? t('importer.importingName', { name: currentFileName })
              : t('importer.importingGeneric')}
          </span>
          {batchTotal > 0 && (
            <span className="text-xs text-drone-primary font-medium">
              {t('importer.filesProgress', { n: batchIndex, total: batchTotal })}
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="mb-2">
            <svg
              className="w-8 h-8 mx-auto text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            {isDragActive
              ? t('importer.dropFileHere')
              : t('importer.importFlightLog')}
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleBrowse}
              className="btn-primary text-sm py-1.5 px-5 force-white"
              disabled={isImporting || isBatchProcessing || isSyncing}
            >
              {t('importer.browse')}
            </button>
            {(!isWebMode() || webSyncPath) && (
              <button
                onClick={handleSync}
                className="btn-primary text-sm py-1.5 px-5 force-white"
                disabled={isImporting || isBatchProcessing || isSyncing}
                title={isWebMode() 
                  ? (webSyncPath ? `Sync from server: ${webSyncPath}` : 'Sync not configured on server')
                  : isMobileRuntime
                  ? 'Select files to sync from your device'
                  : (syncFolderPath ? `Sync from: ${getSyncFolderDisplayName()}` : 'Configure sync folder first')}
              >
                <div className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {t('importer.sync')}
                </div>
              </button>
            )}
          </div>
          <div className="mt-2 flex justify-center">
            <button
              onClick={() => setIsManualEntryOpen(true)}
              className="btn-primary text-sm py-1.5 px-5 force-white"
              disabled={isImporting || isBatchProcessing || isSyncing}
              title="Add a flight manually without a log file"
            >
              <div className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                {t('importer.manualEntry')}
              </div>
            </button>
          </div>
          
          {/* Sync folder status */}
          {!isWebMode() && syncFolderPath && (
            <p className="mt-2 text-[10px] text-gray-500 truncate max-w-full" title={syncFolderPath}>
              Sync: {getSyncFolderDisplayName()}
            </p>
          )}
          {isWebMode() && webSyncPath && (
            <p className="mt-2 text-[10px] text-gray-500 truncate max-w-full" title={webSyncPath}>
              Sync: {webSyncPath} (auto-sync on cron)
            </p>
          )}
          
          {/* Autoscan toggle */}
          {!isWebMode() && syncFolderPath && (
            <label className="mt-2 flex items-center justify-center gap-1.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={autoscanEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setAutoscanEnabledState(enabled);
                  setAutoscanEnabled(enabled);
                }}
                className="w-3 h-3 rounded border-gray-500 bg-drone-dark text-drone-primary focus:ring-1 focus:ring-drone-primary focus:ring-offset-0 cursor-pointer"
              />
              <span className="text-[10px] text-gray-500 group-hover:text-gray-400 transition-colors">{t('importer.autoscanOnStartup')}</span>
            </label>
          )}
          
          {/* Background sync indicator (passive, non-blocking) */}
          {isBackgroundSyncing && (
            <div className="mt-2 flex items-center justify-center gap-2 text-[10px] text-gray-500">
              <div className="w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin" />
              <span>{t('importer.autoSyncChecking')}</span>
            </div>
          )}
          
          {/* Background sync result hint */}
          {backgroundSyncResult && !isBackgroundSyncing && (
            <p className="mt-2 text-[10px] text-emerald-400">{backgroundSyncResult}</p>
          )}
          
          {batchMessage && (
            batchMessage === 'NO_SYNC_FOLDER' ? (
              <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <div className="flex items-center gap-2 text-amber-400">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="text-xs font-medium">{t('importer.noSyncFolder')}</span>
                </div>
                <p className="mt-1 text-[10px] text-amber-300">
                  {t('importer.clickFolderIcon')}
                </p>
              </div>
            ) : batchMessage === 'NO_SYNC_FOLDER_WEB' ? (
              <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <div className="flex items-center gap-2 text-amber-400">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="text-xs font-medium">{t('importer.syncNotConfigured')}</span>
                </div>
                <p className="mt-1 text-[10px] text-amber-300">
                  {t('importer.setSyncPath')}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-gray-400">{batchMessage}</p>
            )
          )}

          {/* Desktop tip for quick ODL sync via Litchi Hub Bridge */}
          {!isWebMode() && !isMobileRuntime && (
            <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-gray-400">
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-amber-400/80" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3a6 6 0 00-3.6 10.8c.4.3.6.8.6 1.3V16a1 1 0 001 1h4a1 1 0 001-1v-.9c0-.5.2-1 .6-1.3A6 6 0 0012 3zm-2 16h4m-3 2h2" />
              </svg>
              <span className="font-medium text-amber-300/90">Tip:</span>
              <span>
                {' '}
                <a
                  href={litchiHubBridgeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-300/90 underline underline-offset-2 decoration-amber-300/60 hover:text-amber-200"
                >
                  Litchi Hub Bridge
                </a>{' '}
                 sync logs automatically.
              </span>
            </div>
          )}
        </>
      )}

      {/* Manual Entry Modal */}
      <ManualEntryModal
        isOpen={isManualEntryOpen}
        onClose={() => setIsManualEntryOpen(false)}
      />
    </div>
  );
}

function getShortFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').pop() || filePath;
  if (name.length <= 50) return name;
  return `${name.slice(0, 50)}…`;
}
