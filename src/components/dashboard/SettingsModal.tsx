/**
 * Settings modal for API key configuration
 */

import { useState, useEffect, useRef, useTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { sha256 } from 'js-sha256';
import * as api from '@/lib/api';
import { isWebMode, getKeepUploadSettings, setKeepUploadSettings, KeepUploadSettings } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';
import { Select } from '@/components/ui/Select';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { getBlacklist, getSyncFolderPath, removeFromBlacklist } from './FlightImporter';
import { SMART_TAG_TYPES, getEnabledSmartTagTypes, setEnabledSmartTagTypes, SmartTagTypeId } from '@/lib/api';
import { FaComments, FaDiscord, FaGithub } from 'react-icons/fa';
import { FiBookOpen, FiGlobe, FiMail } from 'react-icons/fi';
import { McpSettings } from './McpSettings';
import { useIsMobileRuntime } from '@/hooks/platform/useIsMobileRuntime';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface BackupProgressEvent {
  operation: 'export' | 'import';
  percent: number;
  stage: string;
}

interface SyncBlacklistEntryUi {
  hash: string;
  currentFilename: string | null;
  isPresentInSyncFolder: boolean;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { t } = useTranslation();
  const webMode = isWebMode();
  const isMobileRuntime = useIsMobileRuntime();
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [apiKeyType, setApiKeyType] = useState<'none' | 'default' | 'personal'>('none');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [appLogDir, setAppLogDir] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [blacklistCount, setBlacklistCount] = useState(0);
  const [isBlacklistModalOpen, setIsBlacklistModalOpen] = useState(false);
  const [isBlacklistScanning, setIsBlacklistScanning] = useState(false);
  const [blacklistEntries, setBlacklistEntries] = useState<SyncBlacklistEntryUi[]>([]);
  const [selectedBlacklistHashes, setSelectedBlacklistHashes] = useState<Set<string>>(new Set());
  const [isClearingSelectedBlacklist, setIsClearingSelectedBlacklist] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgressEvent | null>(null);
  const [fallbackProgress, setFallbackProgress] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmRemoveAutoTags, setConfirmRemoveAutoTags] = useState(false);
  const [enabledTagTypes, setEnabledTagTypes] = useState<SmartTagTypeId[]>(() => getEnabledSmartTagTypes());
  const [isTagTypeDropdownOpen, setIsTagTypeDropdownOpen] = useState(false);
  const [tagTypeSearch, setTagTypeSearch] = useState('');
  const tagTypeDropdownRef = useRef<HTMLDivElement>(null);
  const [keepUploadSettings, setKeepUploadSettingsState] = useState<KeepUploadSettings | null>(null);

  // Profile password management state
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwMessage, setPwMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [autoLogout, setAutoLogout] = useState(false);

  const {
    unitPrefs,
    setUnitPref,
    locale,
    setLocale,
    dateLocale,
    setDateLocale,
    appLanguage,
    setAppLanguage,
    themeMode,
    setThemeMode,
    timeFormat,
    setTimeFormat,
    loadFlights,
    loadOverview,
    clearSelection,
    smartTagsEnabled,
    setSmartTagsEnabled,
    loadSmartTagsEnabled,
    regenerateSmartTags,
    removeAllAutoTags,
    isRegenerating,
    isRemovingAutoTags,
    regenerationProgress,
    supporterBadgeActive,
    setSupporterBadge,
    updateStatus,
    latestVersion,
    loadApiKeyType,
    hideSerialNumbers,
    setHideSerialNumbers,
    activeProfile,
    profilePasswords,
    loadProfiles,
  } = useFlightStore();

  // Local state so the dropdown responds instantly; store update is deferred via startTransition
  const [localTimeFormat, setLocalTimeFormat] = useState<'12h' | '24h'>(timeFormat);
  const [isTimeFormatPending, startTimeFormatTransition] = useTransition();

  const [showBadgeModal, setShowBadgeModal] = useState(false);
  const [badgeCode, setBadgeCode] = useState('');
  const [badgeMessage, setBadgeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [unitsDropdownOpen, setUnitsDropdownOpen] = useState(false);
  const canEditApiKey = activeProfile === 'default';

  useEffect(() => {
    if (webMode) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (disposed) return;
        unlisten = await listen<BackupProgressEvent>('backup-progress', (event) => {
          const payload = event.payload;
          setBackupProgress({
            operation: payload.operation,
            percent: Math.max(0, Math.min(100, Math.round(payload.percent))),
            stage: payload.stage || '',
          });
        });
      } catch (err) {
        console.warn('Failed to subscribe to backup progress events', err);
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [webMode]);

  useEffect(() => {
    const needsFallback = isDeleting;
    if (!needsFallback) {
      setFallbackProgress(0);
      return;
    }

    setFallbackProgress((prev) => (prev > 0 ? prev : 8));
    const timer = setInterval(() => {
      setFallbackProgress((prev) => {
        if (prev >= 92) return 92;
        const delta = Math.max(1, Math.round((92 - prev) * 0.18));
        return Math.min(92, prev + delta);
      });
    }, 300);

    return () => clearInterval(timer);
  }, [isDeleting]);

  // Derive light/dark for theme-aware styling
  const isLight = themeMode === 'light' || (themeMode === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches);

  const handleActivateBadge = async () => {
    setBadgeMessage(null);
    const trimmed = badgeCode.trim();
    if (!trimmed) {
      setBadgeMessage({ type: 'error', text: t('settings.enterCodeValidation') });
      return;
    }
    try {
      const valid = await api.verifySupporterCode(trimmed);
      if (valid) {
        setSupporterBadge(true);
        setBadgeMessage({ type: 'success', text: '🎉 Supporter badge activated! Thank you for your support!' });
        setBadgeCode('');
      } else {
        setBadgeMessage({ type: 'error', text: 'Error: Invalid code. Please check and try again.' });
      }
    } catch {
      setBadgeMessage({ type: 'error', text: 'Error: Could not verify code.' });
    }
  };

  const handleRemoveBadge = async () => {
    try {
      await api.removeSupporterBadge();
    } catch (err) {
      console.warn('Failed to remove supporter badge on backend:', err);
    }
    setSupporterBadge(false);
    setBadgeMessage(null);
    setShowBadgeModal(false);
  };

  // True when any long-running destructive/IO operation is in progress
  const isBusy = isBackingUp || isRestoring || isDeleting || isRegenerating || isRemovingAutoTags;

  // Check if API key exists on mount
  useEffect(() => {
    if (isOpen) {
      void (async () => {
        checkApiKey();
        if (!webMode) {
          getAppLogDir();
        }
        loadSmartTagsEnabled();
        fetchAppVersion();
        setBlacklistCount((await getBlacklist()).size);
        // Load enabled tag types from backend
        api.loadEnabledSmartTagTypes().then(setEnabledTagTypes);
        // Load keep upload settings (Tauri desktop only)
        if (!isWebMode()) {
          getKeepUploadSettings().then(setKeepUploadSettingsState);
          api.getAutoLogout().then(setAutoLogout);
        }
      })();
    }
  }, [isOpen]);

  // Auto-dismiss messages after 5 seconds
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!isOpen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const hadModalClass = document.body.classList.contains('modal-open');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      if (!hadModalClass) {
        document.body.classList.remove('modal-open');
      }
    };
  }, [isOpen]);

  // Close on Escape key (unless busy)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isBusy, onClose]);

  const checkApiKey = async () => {
    try {
      const exists = await api.hasApiKey();
      setHasKey(exists);
      const keyType = await api.getApiKeyType();
      setApiKeyType(keyType as 'none' | 'default' | 'personal');
    } catch (err) {
      console.error('Failed to check API key:', err);
    }
  };

  const fetchAppVersion = async () => {
    try {
      // Try Tauri API first (desktop mode)
      const { getVersion } = await import('@tauri-apps/api/app');
      const version = await getVersion();
      setAppVersion(version);
    } catch {
      // Fallback to package.json version injected by Vite
      setAppVersion(__APP_VERSION__);
    }
  };

  const getAppLogDir = async () => {
    try {
      const dir = await api.getAppLogDir();
      setAppLogDir(dir);
    } catch (err) {
      console.error('Failed to get app log dir:', err);
    }
  };

  const shortenHash = (hash: string): string => {
    if (hash.length <= 18) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
  };

  const loadBlacklistEntriesForModal = async () => {
    setIsBlacklistScanning(true);
    setSelectedBlacklistHashes(new Set());

    try {
      const baseEntries = await api.getSyncBlacklistDetails();

      if (webMode) {
        setBlacklistEntries(baseEntries);
        setBlacklistCount(baseEntries.length);
        return;
      }

      const syncFolderPath = getSyncFolderPath();
      if (!syncFolderPath) {
        setBlacklistEntries(baseEntries);
        setBlacklistCount(baseEntries.length);
        return;
      }

      let allowedExtensionSet = new Set<string>();
      try {
        const allowedExtensions = await api.getAllowedLogExtensions();
        allowedExtensionSet = new Set(
          allowedExtensions.map((ext) => ext.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
        );
      } catch {
        // Keep an empty set and skip extension filtering if extension discovery fails.
      }

      const normalizeExt = (fileName: string): string | null => {
        const idx = fileName.lastIndexOf('.');
        if (idx < 0 || idx === fileName.length - 1) return null;
        return fileName.slice(idx + 1).toLowerCase();
      };

      const isAllowedByExtension = (fileName: string): boolean => {
        if (allowedExtensionSet.size === 0) return true;
        const ext = normalizeExt(fileName);
        if (!ext) return false;
        return allowedExtensionSet.has(ext);
      };

      const joinFolderPath = (folderPath: string, fileName: string): string => {
        const trimmed = folderPath.replace(/[\\/]+$/, '');
        return `${trimmed}/${fileName}`;
      };

      const baseHashSet = new Set(baseEntries.map((entry) => entry.hash));
      const resolvedByHash = new Map<string, string>();

      // Android mobile build uses persisted SAF URI permissions; resolve filenames via AndroidFs.
      if (isMobileRuntime) {
        try {
          const savedUriRaw = typeof localStorage !== 'undefined' ? localStorage.getItem('mobileSyncFolderUri') : null;
          const savedUri = savedUriRaw ? JSON.parse(savedUriRaw) as { uri?: string; documentTopTreeUri?: string | null } : null;

          if (savedUri?.uri) {
            const androidFsModule = await import('tauri-plugin-android-fs-api') as unknown as {
              AndroidFs: {
                readDir: (uri: { uri: string; documentTopTreeUri: string | null }) => Promise<Array<{ type: 'Dir' | 'File'; name: string; uri: { uri: string; documentTopTreeUri: string | null } }>>;
                readFile: (uri: { uri: string; documentTopTreeUri: string | null }) => Promise<Uint8Array>;
                checkPersistedPickerUriPermission: (uri: { uri: string; documentTopTreeUri: string | null }, state: string) => Promise<boolean>;
              };
              AndroidUriPermissionState: {
                ReadOrWrite: string;
              };
            };

            const hasPermission = await androidFsModule.AndroidFs
              .checkPersistedPickerUriPermission(savedUri as { uri: string; documentTopTreeUri: string | null }, androidFsModule.AndroidUriPermissionState.ReadOrWrite)
              .catch(() => false);

            if (hasPermission) {
              const files: Array<{ name: string; uri: { uri: string; documentTopTreeUri: string | null } }> = [];

              const normalizeExt = (fileName: string): string | null => {
                const idx = fileName.lastIndexOf('.');
                if (idx < 0 || idx === fileName.length - 1) return null;
                return fileName.slice(idx + 1).toLowerCase();
              };

              const isAllowedByExtension = (fileName: string): boolean => {
                if (allowedExtensionSet.size === 0) return true;
                const ext = normalizeExt(fileName);
                if (!ext) return false;
                return allowedExtensionSet.has(ext);
              };

              const walk = async (uri: { uri: string; documentTopTreeUri: string | null }) => {
                const dirEntries = await androidFsModule.AndroidFs.readDir(uri);
                for (const entry of dirEntries) {
                  if (entry.type === 'Dir') {
                    await walk(entry.uri);
                    continue;
                  }
                  if (entry.type === 'File' && isAllowedByExtension(entry.name)) {
                    files.push({ name: entry.name, uri: entry.uri });
                  }
                }
              };

              await walk(savedUri as { uri: string; documentTopTreeUri: string | null });
              files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

              for (const file of files) {
                try {
                  const content = await androidFsModule.AndroidFs.readFile(file.uri);
                  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
                  const hash = sha256(bytes);
                  if (!baseHashSet.has(hash)) continue;
                  if (!resolvedByHash.has(hash)) {
                    resolvedByHash.set(hash, file.name);
                  }
                } catch {
                  continue;
                }
              }
            }
          }
        } catch {
          // Fall back to hash-only view if Android SAF access is unavailable.
        }

        const mergedEntries = baseEntries.map((entry) => {
          const resolvedName = resolvedByHash.get(entry.hash) ?? null;
          return {
            ...entry,
            currentFilename: resolvedName,
            isPresentInSyncFolder: resolvedName !== null,
          };
        });

        setBlacklistEntries(mergedEntries);
        setBlacklistCount(mergedEntries.length);
        return;
      }

      const { readDir } = await import('@tauri-apps/plugin-fs');
      const entries = await readDir(syncFolderPath);

      const candidateFiles = entries
        .filter((entry) => entry.isFile && entry.name && isAllowedByExtension(entry.name))
        .map((entry) => entry.name as string)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      for (const name of candidateFiles) {
        const filePath = joinFolderPath(syncFolderPath, name);
        let hash: string;
        try {
          hash = await api.computeFileHash(filePath);
        } catch {
          continue;
        }

        if (!baseHashSet.has(hash)) continue;
        if (!resolvedByHash.has(hash)) {
          resolvedByHash.set(hash, name);
        }
      }

      const mergedEntries = baseEntries.map((entry) => {
        const resolvedName = resolvedByHash.get(entry.hash) ?? null;
        return {
          ...entry,
          currentFilename: resolvedName,
          isPresentInSyncFolder: resolvedName !== null,
        };
      });

      setBlacklistEntries(mergedEntries);
      setBlacklistCount(mergedEntries.length);
    } catch {
      // Keep modal functional even if scanning fails.
      const baseEntries = await api.getSyncBlacklistDetails().catch(() => []);
      setBlacklistEntries(baseEntries);
      setBlacklistCount(baseEntries.length);
    } finally {
      setIsBlacklistScanning(false);
    }
  };

  const openBlacklistModal = async () => {
    setIsBlacklistModalOpen(true);
    await loadBlacklistEntriesForModal();
  };

  const handleSelectAllBlacklist = () => {
    setSelectedBlacklistHashes(new Set(blacklistEntries.map((entry) => entry.hash)));
  };

  const handleDeselectAllBlacklist = () => {
    setSelectedBlacklistHashes(new Set());
  };

  const toggleBlacklistSelection = (hash: string) => {
    setSelectedBlacklistHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  };

  const handleClearSelectedBlacklist = async () => {
    if (selectedBlacklistHashes.size === 0) return;

    setIsClearingSelectedBlacklist(true);
    try {
      const selected = Array.from(selectedBlacklistHashes);
      await Promise.all(selected.map((hash) => removeFromBlacklist(hash)));

      const nextEntries = blacklistEntries.filter((entry) => !selectedBlacklistHashes.has(entry.hash));
      setBlacklistEntries(nextEntries);
      setSelectedBlacklistHashes(new Set());
      setBlacklistCount(nextEntries.length);
      setMessage({ type: 'success', text: t('settings.blacklistSelectedCleared') });
    } catch (err) {
      setMessage({ type: 'error', text: t('settings.blacklistSelectedClearFailed', { error: String(err) }) });
    } finally {
      setIsClearingSelectedBlacklist(false);
    }
  };

  const handleSave = async () => {
    if (!canEditApiKey) {
      setMessage({ type: 'error', text: t('settings.apiKeyDefaultProfileOnlyTitle') });
      return;
    }

    if (!apiKey.trim()) {
      setMessage({ type: 'error', text: t('settings.enterApiKey') });
      return;
    }

    setIsSaving(true);
    setMessage(null);

    try {
      await api.setApiKey(apiKey.trim());
      setMessage({ type: 'success', text: 'API key saved successfully!' });
      setHasKey(true);
      setApiKey(''); // Clear the input for security
      await checkApiKey(); // Refresh key type to update badge
      await loadApiKeyType(); // Update global store for FlightImporter cooldown bypass
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to save: ${err}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAll = async () => {
    setIsDeleting(true);
    setMessage(null);
    try {
      await api.deleteAllFlights();
      clearSelection();
      await loadFlights();
      await loadOverview();
      setMessage({ type: 'success', text: 'All logs deleted.' });
      setConfirmDeleteAll(false);
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to delete: ${err}` });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBackup = async () => {
    setIsBackingUp(true);
    setMessage(null);
    if (!webMode) {
      setBackupProgress({ operation: 'export', percent: 0, stage: 'Starting backup' });
    }
    try {
      const success = await api.backupDatabase();
      if (success) {
        setMessage({ type: 'success', text: 'Database backup exported successfully!' });
      }
      // If not success, user cancelled - no message needed
    } catch (err) {
      setMessage({ type: 'error', text: `Backup failed: ${err}` });
    } finally {
      setIsBackingUp(false);
      setBackupProgress(null);
    }
  };

  const handleRestore = async () => {
    setIsRestoring(true);
    setMessage(null);
    if (!webMode) {
      setBackupProgress({ operation: 'import', percent: 0, stage: 'Starting restore' });
    }
    try {
      if (api.isWebMode()) {
        // Web mode: pick file via browser dialog
        const files = await api.pickFiles('.backup', false);
        if (files.length === 0) {
          setIsRestoring(false);
          return;
        }
        const msg = await api.restoreDatabase(files[0]);
        setMessage({ type: 'success', text: msg || 'Backup restored successfully!' });
      } else {
        // Tauri mode: native dialog handled inside restoreDatabase
        const msg = await api.restoreDatabase();
        if (!msg) {
          setIsRestoring(false);
          return; // user cancelled
        }
        setMessage({ type: 'success', text: msg });
      }
      // Refresh data after restore
      clearSelection();
      await loadFlights();
      await loadOverview();
    } catch (err) {
      setMessage({ type: 'error', text: `Restore failed: ${err}` });
    } finally {
      setIsRestoring(false);
      setBackupProgress(null);
    }
  };

  const sortedBlacklistEntries = [...blacklistEntries].sort((a, b) => {
    const aSelected = selectedBlacklistHashes.has(a.hash);
    const bSelected = selectedBlacklistHashes.has(b.hash);

    if (aSelected && !bSelected) return -1;
    if (!aSelected && bSelected) return 1;

    const aName = (a.currentFilename ?? '').toLowerCase();
    const bName = (b.currentFilename ?? '').toLowerCase();

    if (aName && bName) return aName.localeCompare(bName);
    if (aName) return -1;
    if (bName) return 1;
    return a.hash.localeCompare(b.hash);
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center p-4 overflow-y-auto mobile-safe-container">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isBusy ? undefined : onClose}
      />

      {/* Modal - use flex-col and my-auto to handle overflow properly */}
      <div className="relative bg-drone-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-[845px] max-h-[calc(100vh-2rem)] modal-mobile-max flex flex-col my-auto">
        {/* Blocking overlay while a long-running operation is in progress */}
        {isBusy && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/90 dark:bg-black/60 backdrop-blur-[2px] rounded-xl">
            <svg className="w-10 h-10 text-drone-primary animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <p className="mt-3 text-sm font-semibold text-gray-800 dark:font-normal dark:text-gray-300">
              {isBackingUp && t('settings.exportingBackup')}
              {isRestoring && t('settings.restoringBackup')}
              {isDeleting && t('settings.deletingAllLogs')}
              {isRemovingAutoTags && t('settings.removingAutoTags')}
              {isRegenerating && (
                <>
                  {t('settings.regeneratingSmartTags')}
                  {regenerationProgress && (
                    <span className="block text-xs font-normal text-gray-600 dark:text-gray-400 mt-1">
                      {t('settings.processedFlights', { x: regenerationProgress.processed, y: regenerationProgress.total })}
                    </span>
                  )}
                </>
              )}
            </p>
            {!webMode && (isBackingUp || isRestoring) && backupProgress && (
              <div className="mt-3 w-72 max-w-[80vw]">
                <div className="h-2 rounded-full bg-gray-300/70 dark:bg-gray-700/70 overflow-hidden">
                  <div
                    className="h-full bg-drone-primary transition-all duration-200"
                    style={{ width: `${backupProgress.percent}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-700 dark:text-gray-400 text-center">
                  {backupProgress.stage || (isBackingUp ? t('settings.exportingBackup') : t('settings.restoringBackup'))} ({backupProgress.percent}%)
                </p>
              </div>
            )}
            {isDeleting && (
              <div className="mt-3 w-72 max-w-[80vw]">
                <div className="h-2 rounded-full bg-gray-300/70 dark:bg-gray-700/70 overflow-hidden">
                  <div
                    className="h-full bg-drone-primary transition-all duration-300"
                    style={{ width: `${fallbackProgress}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-700 dark:text-gray-400 text-center">
                  {t('settings.deletingAllLogs')} ({fallbackProgress}%)
                </p>
              </div>
            )}
          </div>
        )}

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content — two columns - scrollable area */}
        <div className="flex-1 p-4 overflow-y-auto min-h-0 settings-scroll">
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-0">
            {/* Left Column: Preferences, Profile & External Agents */}
            <div className="lg:w-1/2 space-y-4 lg:pr-5">
              {/* Units + Theme + Time Format — stack on mobile */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {/* Units — custom dropdown with per-dimension toggles inside */}
                {(() => {
                  const allMetric = unitPrefs.distance === 'metric' && unitPrefs.altitude === 'metric' && unitPrefs.temperature === 'metric' && unitPrefs.speed === 'kmh';
                  const allImperial = unitPrefs.distance === 'imperial' && unitPrefs.altitude === 'imperial' && unitPrefs.temperature === 'imperial' && unitPrefs.speed === 'mph';
                  const summaryLabel = allMetric
                    ? `${t('settings.metric')} (m, km/h)`
                    : allImperial
                      ? `${t('settings.imperial')} (ft, mph)`
                      : t('settings.mixed', 'Mixed');
                  const unitRows: { key: 'distance' | 'altitude' | 'temperature'; label: string; metricLabel: string; imperialLabel: string }[] = [
                    { key: 'distance', label: t('settings.unitDistance', 'Distance'), metricLabel: 'km', imperialLabel: 'mi' },
                    { key: 'altitude', label: t('settings.unitAltitude', 'Altitude'), metricLabel: 'm', imperialLabel: 'ft' },
                    { key: 'temperature', label: t('settings.unitTemperature', 'Temperature'), metricLabel: '°C', imperialLabel: '°F' },
                  ];
                  return (
                    <div className="flex flex-col gap-1 col-span-2 sm:col-span-1 relative">
                      <label className="text-xs font-medium text-gray-400">{t('settings.units')}</label>
                      {/* Trigger button styled like Select */}
                      <button
                        type="button"
                        onClick={() => setUnitsDropdownOpen(v => !v)}
                        className={`flex items-center justify-between w-full h-[34px] px-2.5 rounded-lg border text-[13px] transition-colors ${isLight
                          ? 'bg-white border-gray-300 text-gray-800 hover:border-gray-400'
                          : 'bg-drone-dark border-gray-600 text-gray-200 hover:border-gray-500'
                          }`}
                      >
                        <span className="truncate">{summaryLabel}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 ml-1 opacity-50">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      {/* Dropdown popover */}
                      {unitsDropdownOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setUnitsDropdownOpen(false)} />
                          <div className={`absolute left-0 top-full mt-1 z-50 w-56 rounded-lg border shadow-xl overflow-hidden ${isLight
                            ? 'bg-white border-gray-300'
                            : 'bg-drone-surface border-gray-600'
                            }`}>
                            {/* Bulk set buttons */}
                            <div className={`flex gap-1 p-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                              <button
                                type="button"
                                onClick={() => {
                                  for (const k of ['distance', 'altitude', 'temperature'] as const) setUnitPref(k, 'metric');
                                  setUnitPref('speed', 'kmh');
                                }}
                                className={`flex-1 text-[11px] font-medium py-1 rounded-md transition-colors ${allMetric
                                  ? 'bg-drone-primary text-white'
                                  : isLight ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
                                  }`}
                              >{t('settings.allMetric', 'All Metric')}</button>
                              <button
                                type="button"
                                onClick={() => {
                                  for (const k of ['distance', 'altitude', 'temperature'] as const) setUnitPref(k, 'imperial');
                                  setUnitPref('speed', 'mph');
                                }}
                                className={`flex-1 text-[11px] font-medium py-1 rounded-md transition-colors ${allImperial
                                  ? 'bg-drone-primary text-white'
                                  : isLight ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-gray-700/50 text-gray-300 hover:bg-gray-700'
                                  }`}
                              >{t('settings.allImperial', 'All Imperial')}</button>
                            </div>
                            {/* Per-dimension toggles */}
                            {unitRows.map(({ key, label, metricLabel, imperialLabel }) => (
                              <div key={key} className={`flex items-center justify-between px-3 py-[6px] border-b last:border-b-0 ${isLight ? 'border-gray-100' : 'border-gray-700/40'}`}>
                                <span className={`text-[11px] ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>{label}</span>
                                <div className={`flex rounded-md overflow-hidden border ${isLight ? 'border-gray-300' : 'border-gray-600'}`}>
                                  <button
                                    type="button"
                                    onClick={() => setUnitPref(key, 'metric')}
                                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${unitPrefs[key] === 'metric'
                                      ? 'bg-drone-primary text-white'
                                      : isLight ? 'bg-transparent text-gray-500 hover:text-gray-700' : 'bg-transparent text-gray-400 hover:text-gray-200'
                                      }`}
                                  >{metricLabel}</button>
                                  <button
                                    type="button"
                                    onClick={() => setUnitPref(key, 'imperial')}
                                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors border-l ${isLight ? 'border-gray-300' : 'border-gray-600'} ${unitPrefs[key] === 'imperial'
                                      ? 'bg-drone-primary text-white'
                                      : isLight ? 'bg-transparent text-gray-500 hover:text-gray-700' : 'bg-transparent text-gray-400 hover:text-gray-200'
                                      }`}
                                  >{imperialLabel}</button>
                                </div>
                              </div>
                            ))}
                            <div className={`flex items-center justify-between px-3 py-[6px] ${isLight ? 'border-gray-100' : 'border-gray-700/40'}`}>
                              <span className={`text-[11px] ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>{t('settings.unitSpeed', 'Speed')}</span>
                              <div className={`flex rounded-md overflow-hidden border ${isLight ? 'border-gray-300' : 'border-gray-600'}`}>
                                {([
                                  { key: 'kmh', label: 'km/h' },
                                  { key: 'mph', label: 'mph' },
                                  { key: 'ms', label: 'm/s' },
                                  { key: 'fts', label: 'ft/s' },
                                ] as const).map((option, idx) => (
                                  <button
                                    key={option.key}
                                    type="button"
                                    onClick={() => setUnitPref('speed', option.key)}
                                    className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${idx > 0 ? (isLight ? 'border-l border-gray-300' : 'border-l border-gray-600') : ''} ${unitPrefs.speed === option.key
                                      ? 'bg-drone-primary text-white'
                                      : isLight ? 'bg-transparent text-gray-500 hover:text-gray-700' : 'bg-transparent text-gray-400 hover:text-gray-200'
                                      }`}
                                  >{option.label}</button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.theme')}
                  </label>
                  <Select
                    value={themeMode}
                    onChange={(v) => setThemeMode(v as 'system' | 'dark' | 'light')}
                    options={[
                      { value: 'system', label: t('settings.system') },
                      { value: 'dark', label: t('settings.dark') },
                      { value: 'light', label: t('settings.light') },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
                    {t('settings.timeFormat', 'Time Format')}
                    {isTimeFormatPending && (
                      <svg className="w-3 h-3 animate-spin text-drone-primary" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                      </svg>
                    )}
                  </label>
                  <Select
                    value={localTimeFormat}
                    onChange={(v) => {
                      const fmt = v as '12h' | '24h';
                      setLocalTimeFormat(fmt);
                      // Yield the paint thread first, then commit to store
                      setTimeout(() => {
                        startTimeFormatTransition(() => setTimeFormat(fmt));
                      }, 0);
                    }}
                    options={[
                      { value: '12h', label: t('settings.timeFormat12h', '12-hour') },
                      { value: '24h', label: t('settings.timeFormat24h', '24-hour') },
                    ]}
                  />
                </div>
              </div>

              {/* Language + Number & Date Format — stack on mobile */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {/* App Language */}
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.language')}
                  </label>
                  <Select
                    value={appLanguage}
                    onChange={(v) => setAppLanguage(v)}
                    listMaxHeight="max-h-[230px]"
                    options={[
                      { value: 'de', label: 'Deutsch' },
                      { value: 'en', label: 'English' },
                      { value: 'es', label: 'Español' },
                      { value: 'fr', label: 'Français' },
                      { value: 'hu', label: 'Magyar' },
                      { value: 'it', label: 'Italiano' },
                      { value: 'nl', label: 'Nederlands' },
                      { value: 'pl', label: 'Polski' },
                      { value: 'pt', label: 'Português BR' },
                      { value: 'ru', label: 'Русский' },
                      { value: 'tr', label: 'Turkce' },
                      { value: 'zh', label: '中文' },
                      { value: 'ja', label: '日本語' },
                      { value: 'ko', label: '한국어' },
                    ]}
                  />
                </div>
                {/* Number Format */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.numbers')}
                  </label>
                  <Select
                    value={locale}
                    onChange={(v) => setLocale(v)}
                    options={[
                      { value: 'en-GB', label: '1,234.56' },
                      { value: 'de-DE', label: '1.234,56' },
                      { value: 'fr-FR', label: '1 234,56' },
                    ]}
                  />
                </div>
                {/* Date Format */}
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.dates')}
                  </label>
                  <Select
                    value={dateLocale}
                    onChange={(v) => setDateLocale(v)}
                    options={[
                      { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
                      { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
                      { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY' },
                      { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY' },
                      { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
                      { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD' },
                      { value: 'YYYY/M/D', label: 'YYYY/M/D' },
                      { value: 'YYYY. M. D.', label: 'YYYY. M. D.' },
                    ]}
                  />
                </div>
              </div>

              {/* Hide Serial Numbers */}
              <div>
                <button
                  type="button"
                  onClick={() => setHideSerialNumbers(!hideSerialNumbers)}
                  className="flex items-center justify-between gap-3 w-full text-[0.85rem] text-gray-300"
                  aria-pressed={hideSerialNumbers}
                >
                  <span>{t('settings.hideSerials')}</span>
                  <span
                    className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${hideSerialNumbers
                      ? 'bg-drone-primary/90 border-drone-primary'
                      : 'bg-drone-surface border-gray-600 toggle-track-off'
                      }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${hideSerialNumbers ? 'translate-x-4' : 'translate-x-1'
                        }`}
                    />
                  </span>
                </button>
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.hideSerialDesc')}
                </p>
              </div>

              {/* Smart Tags */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-300">{t('settings.smartTags')}</p>
                    <p className="text-xs text-gray-500">{t('settings.smartTagsDesc')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSmartTagsEnabled(!smartTagsEnabled)}
                    className="flex-shrink-0"
                    aria-pressed={smartTagsEnabled}
                  >
                    <span
                      className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${smartTagsEnabled
                        ? 'bg-drone-primary/90 border-drone-primary'
                        : 'bg-drone-surface border-gray-600 toggle-track-off'
                        }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${smartTagsEnabled ? 'translate-x-4' : 'translate-x-1'
                          }`}
                      />
                    </span>
                  </button>
                </div>

                {/* Smart Tag Types Selector */}
                {smartTagsEnabled && (
                  <div>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setIsTagTypeDropdownOpen((v) => !v)}
                        className="w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2 rounded-lg border border-gray-600 bg-drone-surface hover:border-gray-500 transition-colors"
                      >
                        <span className={`truncate ${enabledTagTypes.length < SMART_TAG_TYPES.length ? 'text-gray-100' : 'text-gray-400'}`}>
                          {enabledTagTypes.length === SMART_TAG_TYPES.length
                            ? t('settings.allTagTypes')
                            : enabledTagTypes.length === 0
                              ? t('settings.noneSelected')
                              : t('settings.tagTypesSelected', { count: enabledTagTypes.length, total: SMART_TAG_TYPES.length })}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                      </button>
                      {isTagTypeDropdownOpen && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => { setIsTagTypeDropdownOpen(false); setTagTypeSearch(''); }}
                          />
                          <div
                            ref={tagTypeDropdownRef}
                            className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                          >
                            {/* Search input */}
                            <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                              <input
                                type="text"
                                value={tagTypeSearch}
                                onChange={(e) => setTagTypeSearch(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setIsTagTypeDropdownOpen(false);
                                    setTagTypeSearch('');
                                  }
                                }}
                                placeholder={t('settings.searchTagTypes')}
                                autoFocus
                                className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                              />
                            </div>
                            <div className="overflow-y-scroll flex-1">
                              {(() => {
                                const filtered = SMART_TAG_TYPES.filter((t) =>
                                  t.label.toLowerCase().includes(tagTypeSearch.toLowerCase()) ||
                                  t.description.toLowerCase().includes(tagTypeSearch.toLowerCase())
                                );
                                if (filtered.length === 0) {
                                  return <p className="text-xs text-gray-500 px-3 py-2">{t('settings.noMatchingTagTypes')}</p>;
                                }
                                // Sort: selected first, then unselected
                                const sorted = [...filtered].sort((a, b) => {
                                  const aSelected = enabledTagTypes.includes(a.id);
                                  const bSelected = enabledTagTypes.includes(b.id);
                                  if (aSelected && !bSelected) return -1;
                                  if (!aSelected && bSelected) return 1;
                                  return 0;
                                });
                                return sorted.map((tagType) => {
                                  const isSelected = enabledTagTypes.includes(tagType.id);
                                  return (
                                    <button
                                      key={tagType.id}
                                      type="button"
                                      onClick={() => {
                                        const newTypes = isSelected
                                          ? enabledTagTypes.filter((t) => t !== tagType.id)
                                          : [...enabledTagTypes, tagType.id];
                                        setEnabledTagTypes(newTypes);
                                        setEnabledSmartTagTypes(newTypes);
                                      }}
                                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isSelected
                                        ? 'bg-drone-primary/20 text-gray-800 dark:text-drone-primary'
                                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                        }`}
                                    >
                                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-drone-primary bg-drone-primary' : 'border-gray-400 dark:border-gray-600'
                                        }`}>
                                        {isSelected && (
                                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                        )}
                                      </span>
                                      <span className="truncate">{tagType.label}</span>
                                    </button>
                                  );
                                });
                              })()}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const msg = await regenerateSmartTags();
                      setMessage({ type: 'success', text: msg });
                    }}
                    disabled={isBusy}
                    className="flex-1 py-[7px] px-3 rounded-lg border border-drone-primary text-drone-primary hover:bg-drone-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                  >
                    <span className="flex items-center justify-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {t('settings.regenerateBtn')}
                    </span>
                  </button>

                  {/* Remove Auto Tags */}
                  {confirmRemoveAutoTags ? (
                    <div className="flex-1 rounded-lg border border-orange-600/60 bg-orange-500/10 p-2.5">
                      <p className="text-xs text-orange-200">
                        {t('settings.removeAutoTagsConfirm')}
                      </p>
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          onClick={async () => {
                            try {
                              const msg = await removeAllAutoTags();
                              setMessage({ type: 'success', text: msg });
                            } catch (err) {
                              setMessage({ type: 'error', text: `Failed to remove auto tags: ${err}` });
                            }
                            setConfirmRemoveAutoTags(false);
                          }}
                          className="text-xs text-orange-300 hover:text-orange-200"
                        >
                          {t('flightList.yes')}
                        </button>
                        <button
                          onClick={() => setConfirmRemoveAutoTags(false)}
                          className="text-xs text-gray-400 hover:text-gray-200"
                        >
                          {t('flightList.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveAutoTags(true)}
                      disabled={isBusy}
                      className="flex-1 py-[7px] px-3 rounded-lg border border-orange-600 text-orange-400 hover:bg-orange-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                    >
                      <span className="flex items-center justify-center gap-1.5">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        {t('settings.removeBtn')}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* Profile Password Section */}
              <div className="pt-4 border-t border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <label className="text-sm font-medium text-gray-300">
                    {t('settings.profilePassword')}
                  </label>
                  <span className="text-xs text-gray-500">
                    {profilePasswords[activeProfile]
                      ? t('settings.passwordEnabled')
                      : t('settings.passwordDisabled')}
                  </span>
                  {profilePasswords[activeProfile] && (
                    <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  )}
                </div>

                {pwMessage && (
                  <div className={`text-xs mb-2 ${pwMessage.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
                    {pwMessage.text}
                  </div>
                )}

                {profilePasswords[activeProfile] ? (
                  /* Profile has a password — change or remove */
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <PasswordInput
                        wrapperClassName="flex-1 min-w-0"
                        placeholder={t('settings.currentPassword')}
                        value={pwCurrent}
                        onChange={e => setPwCurrent(e.target.value)}
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-drone-primary"
                      />
                      <button
                        type="button"
                        disabled={pwBusy || !pwCurrent}
                        onClick={async () => {
                          setPwBusy(true);
                          setPwMessage(null);
                          try {
                            await api.removeProfilePassword(activeProfile, pwCurrent);
                            setPwMessage({ type: 'success', text: t('settings.passwordRemoved') });
                            setPwCurrent(''); setPwNew(''); setPwConfirm('');
                            await loadProfiles();
                          } catch (err) {
                            setPwMessage({ type: 'error', text: String(err) });
                          } finally { setPwBusy(false); }
                        }}
                        className="py-1.5 px-3 rounded-lg border border-red-600 text-red-400 text-xs hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                      >
                        {t('settings.removePassword')}
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <PasswordInput
                        wrapperClassName="flex-1 min-w-0"
                        placeholder={t('settings.newPasswordOpt')}
                        value={pwNew}
                        onChange={e => setPwNew(e.target.value)}
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-drone-primary"
                      />
                      {pwNew && (
                        <PasswordInput
                          wrapperClassName="flex-1 min-w-0"
                          placeholder={t('settings.confirmPassword')}
                          value={pwConfirm}
                          onChange={e => setPwConfirm(e.target.value)}
                          className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-drone-primary"
                        />
                      )}
                      {pwNew && (
                        <button
                          type="button"
                          disabled={pwBusy || !pwCurrent || !pwNew || pwNew.length < 4 || pwNew !== pwConfirm}
                          onClick={async () => {
                            setPwBusy(true);
                            setPwMessage(null);
                            try {
                              await api.setProfilePassword(activeProfile, pwNew, pwCurrent);
                              setPwMessage({ type: 'success', text: t('settings.passwordChanged') });
                              setPwCurrent(''); setPwNew(''); setPwConfirm('');
                            } catch (err) {
                              setPwMessage({ type: 'error', text: String(err) });
                            } finally { setPwBusy(false); }
                          }}
                          className="py-1.5 px-3 rounded-lg bg-drone-primary text-white text-xs hover:bg-drone-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                        >
                          {t('settings.changePassword')}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Profile has no password — set one */
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <PasswordInput
                        wrapperClassName="flex-1 min-w-0"
                        placeholder={t('settings.newPasswordLabel')}
                        value={pwNew}
                        onChange={e => setPwNew(e.target.value)}
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-drone-primary"
                      />
                      <PasswordInput
                        wrapperClassName="flex-1 min-w-0"
                        placeholder={t('settings.confirmPassword')}
                        value={pwConfirm}
                        onChange={e => setPwConfirm(e.target.value)}
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-drone-primary"
                      />
                      <button
                        type="button"
                        disabled={pwBusy || !pwNew || pwNew.length < 4 || pwNew !== pwConfirm}
                        onClick={async () => {
                          setPwBusy(true);
                          setPwMessage(null);
                          try {
                            await api.setProfilePassword(activeProfile, pwNew);
                            setPwMessage({ type: 'success', text: t('settings.passwordSet') });
                            setPwNew(''); setPwConfirm('');
                            await loadProfiles();
                          } catch (err) {
                            setPwMessage({ type: 'error', text: String(err) });
                          } finally { setPwBusy(false); }
                        }}
                        className="py-1.5 px-3 rounded-lg bg-drone-primary text-white text-xs hover:bg-drone-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                      >
                        {t('settings.setPassword')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Auto-logout toggle — Tauri desktop only, visible when profile has a password */}
                {!isWebMode() && profilePasswords[activeProfile] && (
                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-700/50">
                    <label className="text-xs font-medium text-gray-300 cursor-pointer" htmlFor="auto-logout-toggle">
                      {t('settings.autoLogout')}
                    </label>
                    <button
                      id="auto-logout-toggle"
                      type="button"
                      role="switch"
                      aria-checked={autoLogout}
                      onClick={async () => {
                        const next = !autoLogout;
                        setAutoLogout(next);
                        try {
                          await api.setAutoLogout(next);
                        } catch {
                          setAutoLogout(!next); // revert on failure
                        }
                      }}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-drone-primary focus:ring-offset-2 focus:ring-offset-gray-900 ${autoLogout ? 'bg-drone-primary' : 'bg-gray-600'
                        }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200 ${autoLogout ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                      />
                    </button>
                  </div>
                )}
              </div>

              {!isMobileRuntime && <McpSettings key={activeProfile} profile={activeProfile} />}
            </div>

            {/* Vertical Divider */}
            <div className="hidden lg:block w-px bg-gray-700 shrink-0" />
            {/* Horizontal Divider for mobile */}
            <div className="lg:hidden h-px w-full bg-gray-700 shrink-0" />

            {/* Right Column: DJI API Key, Support, Info & Data */}
            <div className="lg:w-1/2 space-y-4 lg:pl-5">
              {/* API Key Section */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.djiApiKey')}
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  {t('settings.djiApiKeyDesc')}{' '}
                  <a
                    href="https://github.com/arpanghosh8453/open-dronelog#how-to-obtain-your-own-dji-developer-api-key"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-drone-primary hover:underline"
                  >
                    {t('settings.thisGuide')}
                  </a>
                </p>

                {/* Status indicator */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-sm text-gray-400">
                    {hasKey ? t('settings.apiKeyConfigured') : t('settings.noApiKey')}
                  </span>
                  {apiKeyType === 'none' && (
                    <span className="api-key-badge api-key-badge-none inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-.5 3v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                      {t('settings.invalid')}
                    </span>
                  )}
                  {apiKeyType === 'default' && (
                    <span className="api-key-badge api-key-badge-default inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" /></svg>
                      {t('settings.default')}
                    </span>
                  )}
                  {apiKeyType === 'personal' && canEditApiKey && (
                    <button
                      onClick={async () => {
                        try {
                          await api.removeApiKey();
                          await checkApiKey();
                          await loadApiKeyType(); // Update global store
                          setMessage({ type: 'success', text: t('settings.customApiKeyRemoved') });
                        } catch (err) {
                          setMessage({ type: 'error', text: `${t('settings.failedToRemoveKey')}: ${err}` });
                        }
                      }}
                      className="api-key-badge api-key-badge-personal group inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full cursor-pointer transition-all duration-150 hover:api-key-badge-remove"
                      title={t('settings.apiKeyRemoveTitle')}
                    >
                      <svg className="w-3 h-3 group-hover:hidden" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z" /></svg>
                      <svg className="w-3 h-3 hidden group-hover:block" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm2.854 4.146a.5.5 0 010 .708L8.707 8l2.147 2.146a.5.5 0 01-.708.708L8 8.707l-2.146 2.147a.5.5 0 01-.708-.708L7.293 8 5.146 5.854a.5.5 0 11.708-.708L8 7.293l2.146-2.147a.5.5 0 01.708 0z" /></svg>
                      <span className="group-hover:hidden">{t('settings.personal')}</span>
                      <span className="hidden group-hover:inline">{t('settings.apiKeyRemove')}</span>
                    </button>
                  )}
                  {apiKeyType === 'personal' && !canEditApiKey && (
                    <span className="api-key-badge api-key-badge-personal inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z" /></svg>
                      {t('settings.personal')}
                    </span>
                  )}
                </div>

                {canEditApiKey ? (
                  <div className="flex gap-2">
                    <PasswordInput
                      wrapperClassName="flex-1 min-w-0"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={hasKey ? '••••••••••••••••' : t('settings.enterYourApiKey')}
                      className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-drone-primary"
                    />
                    <button
                      onClick={handleSave}
                      disabled={isSaving || !apiKey.trim()}
                      className="py-1.5 px-3 rounded-lg bg-drone-primary text-white text-xs hover:bg-drone-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      {isSaving ? t('settings.savingApiKey') : hasKey ? t('settings.updateApiKey') : t('settings.saveApiKey')}
                    </button>
                  </div>
                ) : (
                  <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
                    <p className="text-xs font-medium text-yellow-200">
                      {t('settings.apiKeyDefaultProfileOnlyTitle')}
                    </p>
                    <p className="mt-1 text-xs text-yellow-100/85">
                      {t('settings.apiKeyDefaultProfileOnlyDesc', { profile: activeProfile })}
                    </p>
                  </div>
                )}

                {/* Message (auto-dismisses after 5s) */}
                {message && (
                  <p
                    className={`mt-2 text-sm text-center ${message.type === 'success' ? 'text-green-400' : 'text-red-400'
                      }`}
                  >
                    {message.text}
                  </p>
                )}
              </div>

              {/* Donation Status */}
              <div className="pt-4 border-t border-gray-700">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  {t('settings.supporterBadge')}
                </p>
                {/* Supporter Badge and Shop Buttons (Side-by-side) */}

                <p className="mt-3 text-xs text-gray-500 leading-relaxed">
                  {t('settings.supporterDescription', 'Show your love by supporting this project - your donation keeps development running and new features coming.')}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowBadgeModal(true); setBadgeMessage(null); setBadgeCode(''); }}
                    className={`flex-1 py-2 px-3 rounded-lg border text-sm transition-colors ${supporterBadgeActive
                      ? 'border-amber-500/50 text-amber-400 hover:bg-amber-500/10'
                      : 'border-drone-primary/50 text-drone-primary hover:bg-drone-primary/10'
                      }`}
                  >
                    <span className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                      {supporterBadgeActive ? t('settings.manageBadge', 'Manage badge') : t('settings.getBadge', 'Get badge')}
                    </span>
                  </button>

                  <a
                    href="https://ko-fi.com/arpandesign/shop"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2 px-3 rounded-lg border border-drone-primary/50 text-drone-primary hover:bg-drone-primary/10 transition-colors text-sm flex items-center justify-center gap-1.5 no-underline whitespace-nowrap"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                      <line x1="3" y1="6" x2="21" y2="6"></line>
                      <path d="M16 10a4 4 0 0 1-8 0"></path>
                    </svg>
                    {t('settings.exploreMore', 'Explore more')}
                  </a>
                </div>

                <div className="mt-4 pt-4 border-t border-gray-700">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {t('settings.needHelp', 'Need Help?')}
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <a
                      href="https://github.com/arpanghosh8453/open-dronelog/blob/main/docs/manual.md"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group px-3 py-2 rounded-lg border border-gray-700 text-gray-200 bg-drone-dark/60 hover:bg-drone-primary/10 hover:border-drone-primary/50 focus:outline-none focus:ring-2 focus:ring-drone-primary/40 transition-all text-sm font-medium flex items-center justify-center gap-2 no-underline"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-drone-primary/15 text-drone-primary group-hover:bg-drone-primary/20 transition-colors">
                        <FiBookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </span>
                      {t('settings.docs', 'Docs')}
                    </a>

                    <a
                      href="https://opendronelog.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group px-3 py-2 rounded-lg border border-gray-700 text-gray-200 bg-drone-dark/60 hover:bg-emerald-500/10 hover:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all text-sm font-medium flex items-center justify-center gap-2 no-underline"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-emerald-500/15 text-emerald-400 group-hover:bg-emerald-500/20 transition-colors">
                        <FiGlobe className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </span>
                      {t('settings.website', 'Website')}
                    </a>

                    <a
                      href="https://opendronelog.com/#about"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group px-3 py-2 rounded-lg border border-gray-700 text-gray-200 bg-drone-dark/60 hover:bg-drone-primary/10 hover:border-drone-primary/50 focus:outline-none focus:ring-2 focus:ring-drone-primary/40 transition-all text-sm font-medium flex items-center justify-center gap-2 no-underline"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-drone-primary/15 text-drone-primary group-hover:bg-drone-primary/20 transition-colors">
                        <FiMail className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </span>
                      {t('settings.contact', 'Contact')}
                    </a>

                    <a
                      href="https://github.com/arpanghosh8453/open-dronelog/issues/new/choose"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group px-3 py-2 rounded-lg border border-gray-700 text-gray-200 bg-drone-dark/60 hover:bg-rose-500/10 hover:border-rose-500/50 focus:outline-none focus:ring-2 focus:ring-rose-500/40 transition-all text-sm font-medium flex items-center justify-center gap-2 no-underline"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-rose-500/15 text-rose-400 group-hover:bg-rose-500/20 transition-colors">
                        <FaGithub className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </span>
                      {t('settings.reportBug', 'Issues')}
                    </a>

                    <a
                      href="https://github.com/arpanghosh8453/open-dronelog/discussions"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group px-3 py-2 rounded-lg border border-gray-700 text-gray-200 bg-drone-dark/60 hover:bg-amber-500/10 hover:border-amber-500/50 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition-all text-sm font-medium flex items-center justify-center gap-2 no-underline"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-amber-500/15 text-amber-400 group-hover:bg-amber-500/20 transition-colors">
                        <FaComments className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </span>
                      {t('settings.discussion', 'Discussion')}
                    </a>

                    <a
                      href="https://discord.gg/YKgKTmSm7B"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group px-3 py-2 rounded-lg border border-gray-700 text-gray-200 bg-drone-dark/60 hover:bg-indigo-500/10 hover:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-all text-sm font-medium flex items-center justify-center gap-2 no-underline"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-indigo-500/15 text-indigo-400 group-hover:bg-indigo-500/20 transition-colors">
                        <FaDiscord className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      </span>
                      {t('settings.discord', 'Discord')}
                    </a>
                  </div>
                </div>
              </div>

              {/* Info Section */}
              <div className="pt-4 border-t border-gray-700">
                <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                  <strong className="text-gray-400">{t('settings.appVersion')}</strong>{' '}
                  <span className="text-gray-400">{appVersion || '...'}</span>
                  {updateStatus === 'checking' && (
                    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 border border-gray-600/50">
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" /></svg>
                      {t('settings.checking')}
                    </span>
                  )}
                  {updateStatus === 'latest' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z" /></svg>
                      {t('settings.latest')}
                    </span>
                  )}
                  {updateStatus === 'outdated' && latestVersion && (
                    <a
                      href="https://github.com/arpanghosh8453/open-dronelog/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer no-underline"
                      title="Click to open release page"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zM7.5 4v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                      {t('settings.updateToVersion', { version: latestVersion })}
                    </a>
                  )}
                  {updateStatus === 'failed' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-.5 3v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                      {t('settings.checkFailed')}
                    </span>
                  )}
                </p>
                {!webMode && (
                  <p className="text-xs text-gray-500 mt-2">
                    <strong className="text-gray-400">{t('settings.logLocation')}</strong>
                    <br />
                    <code className="text-xs text-gray-400 bg-drone-dark px-1 py-0.5 rounded break-all">
                      {appLogDir || t('settings.loading')}
                    </code>
                  </p>
                )}

                {/* Keep Uploaded Files - Only show in Tauri desktop mode */}
                {!isWebMode() && keepUploadSettings && (
                  <div className="mt-4 pt-4 border-t border-gray-700">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const newEnabled = !keepUploadSettings.enabled;
                            const result = await setKeepUploadSettings(newEnabled, keepUploadSettings.folder_path);
                            if (result) setKeepUploadSettingsState(result);
                          } catch (e) {
                            const details = e instanceof Error ? e.message : String(e);
                            setMessage({
                              type: 'error',
                              text: t('settings.uploadFolderAccessDenied', { error: details }),
                            });
                          }
                        }}
                        className="flex items-center gap-3 text-[0.85rem] text-gray-300"
                        aria-pressed={keepUploadSettings.enabled}
                      >
                        <span
                          className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${keepUploadSettings.enabled
                            ? 'bg-drone-primary/90 border-drone-primary'
                            : 'bg-drone-surface border-gray-600 toggle-track-off'
                            }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${keepUploadSettings.enabled ? 'translate-x-4' : 'translate-x-1'
                              }`}
                          />
                        </span>
                        <span>{t('settings.keepUploadedFiles')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const { open } = await import('@tauri-apps/plugin-dialog');
                            const selected = await open({
                              directory: true,
                              multiple: false,
                              title: 'Select folder for uploaded files',
                              defaultPath: keepUploadSettings.folder_path,
                            });
                            if (selected && typeof selected === 'string') {
                              try {
                                const result = await setKeepUploadSettings(keepUploadSettings.enabled, selected);
                                if (result) setKeepUploadSettingsState(result);
                              } catch (e) {
                                const details = e instanceof Error ? e.message : String(e);
                                setMessage({
                                  type: 'error',
                                  text: t('settings.uploadFolderAccessDenied', { error: details }),
                                });
                              }
                            }
                          } catch (e) {
                            console.error('Failed to select folder:', e);
                          }
                        }}
                        disabled={!keepUploadSettings.enabled}
                        className={`p-1.5 rounded transition-colors ${keepUploadSettings.enabled
                          ? 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                          : 'text-gray-600 cursor-not-allowed'
                          }`}
                        title="Select folder"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {t('settings.keepUploadedDesc')}
                    </p>
                    {keepUploadSettings.enabled && (
                      <p className="text-xs text-gray-500 mt-1">
                        <strong className="text-gray-400">{t('settings.folder')}</strong>
                        <br />
                        <code className="text-xs text-gray-400 bg-drone-dark px-1 py-0.5 rounded break-all">
                          {keepUploadSettings.folder_path}
                        </code>
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Backup & Restore */}
              <div className="pt-4 border-t border-gray-700">
                <div className="flex gap-3">
                  <button
                    onClick={handleBackup}
                    disabled={isBusy}
                    className="flex-1 py-2 px-3 rounded-lg border border-drone-primary text-drone-primary hover:bg-drone-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                  >
                    {isBackingUp ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                          <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                        </svg>
                        {t('settings.exporting')}
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
                        </svg>
                        {t('settings.backupDatabase')}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={handleRestore}
                    disabled={isBusy}
                    className="flex-1 py-2 px-3 rounded-lg border border-amber-600 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                  >
                    {isRestoring ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                          <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                        </svg>
                        {t('settings.restoring')}
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 6l-4-4m0 0L8 6m4-4v13" />
                        </svg>
                        {t('settings.importBackup')}
                      </span>
                    )}
                  </button>
                </div>

                {confirmDeleteAll ? (
                  <div className="mt-4 rounded-lg border border-red-600/60 bg-red-500/10 p-3">
                    <p className={`text-xs ${isLight ? 'text-red-800' : 'text-red-200'}`}>
                      {t('settings.deleteAllWarning')}
                    </p>
                    <p className={`text-xs mt-1.5 ${isLight ? 'text-green-800' : 'text-green-300'}`}>
                      {t('settings.deleteAllPreserveNote')}
                    </p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        onClick={handleDeleteAll}
                        className={`text-xs ${isLight ? 'text-red-700 hover:text-red-800' : 'text-red-300 hover:text-red-200'}`}
                      >
                        {t('flightList.yes')}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteAll(false)}
                        className="text-xs text-gray-400 hover:text-gray-200"
                      >
                        {t('flightList.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteAll(true)}
                    disabled={isBusy}
                    className="mt-4 w-full py-2 px-3 rounded-lg border border-red-600 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('settings.deleteAllLogs')}
                  </button>
                )}

                <button
                  onClick={openBlacklistModal}
                  disabled={isBusy}
                  className="mt-3 w-full py-2 px-3 rounded-lg border border-amber-600 text-amber-500 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {t('settings.manageBlacklistedLogs', { count: blacklistCount })}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
      </div>

      {/* Manage Sync Blacklist Modal */}
      {isBlacklistModalOpen && (
        <div className="fixed inset-0 z-[70] flex flex-col items-center p-4 overflow-y-auto">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => {
              if (!isBlacklistScanning && !isClearingSelectedBlacklist) {
                setIsBlacklistModalOpen(false);
              }
            }}
          />
          <div className={`relative w-full max-w-3xl rounded-xl border shadow-2xl h-[min(88vh,760px)] max-h-[min(88vh,760px)] grid grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden my-auto ${isLight ? 'bg-white border-gray-300' : 'bg-drone-secondary border-gray-700'}`}>
            <div className={`flex items-center justify-between px-4 py-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
              <div>
                <h3 className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-white'}`}>
                  {t('settings.manageBlacklistedLogs', { count: blacklistCount })}
                </h3>
                <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                  {t('settings.blacklistManagerDescription')}
                </p>
                <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                  {t('settings.blacklistManagerFunctionality')}
                </p>
              </div>
              <button
                onClick={() => setIsBlacklistModalOpen(false)}
                disabled={isBlacklistScanning || isClearingSelectedBlacklist}
                className={`transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${isLight ? 'text-gray-500 hover:text-gray-800' : 'text-gray-400 hover:text-white'}`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className={`flex items-center justify-between px-4 py-2 border-b ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-drone-dark/50'}`}>
              <div className="flex items-center gap-4 text-xs">
                <button
                  onClick={handleSelectAllBlacklist}
                  disabled={isBlacklistScanning || blacklistEntries.length === 0}
                  className={`${isLight ? 'text-drone-primary hover:text-drone-primary' : 'text-drone-primary hover:text-drone-primary'} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {t('settings.selectAll')}
                </button>
                <button
                  onClick={handleDeselectAllBlacklist}
                  disabled={isBlacklistScanning || selectedBlacklistHashes.size === 0}
                  className={`${isLight ? 'text-gray-600 hover:text-gray-800' : 'text-gray-400 hover:text-gray-200'} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {t('settings.deselectAll')}
                </button>
              </div>
              <div className={`text-xs ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
                {t('settings.blacklistSelectedCount', { count: selectedBlacklistHashes.size })}
              </div>
            </div>

            <div className={`settings-scroll min-h-0 overflow-y-auto p-3 ${isLight ? 'bg-white' : 'bg-drone-secondary'}`}>
              {isBlacklistScanning ? (
                <div className={`h-full min-h-[220px] flex flex-col items-center justify-center rounded-lg border ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-drone-dark/50'}`}>
                  <svg className="w-8 h-8 text-drone-primary animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                  </svg>
                  <p className={`mt-3 text-sm ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                    {t('settings.scanningSyncFolderForBlacklistedFiles')}
                  </p>
                </div>
              ) : sortedBlacklistEntries.length === 0 ? (
                <div className={`h-full min-h-[220px] flex items-center justify-center rounded-lg border text-sm ${isLight ? 'border-gray-200 bg-gray-50 text-gray-500' : 'border-gray-700 bg-drone-dark/50 text-gray-400'}`}>
                  {t('settings.noBlacklistedLogsFound')}
                </div>
              ) : (
                <div className="space-y-2">
                  {sortedBlacklistEntries.map((entry) => {
                    const checked = selectedBlacklistHashes.has(entry.hash);
                    return (
                      <label
                        key={entry.hash}
                        className={`w-full rounded-lg border px-3 py-2.5 grid grid-cols-[auto_1fr] gap-3 cursor-pointer transition-colors ${checked
                          ? isLight
                            ? 'border-drone-primary bg-sky-50'
                            : 'border-drone-primary/60 bg-drone-primary/10'
                          : isLight
                            ? 'border-gray-200 bg-white hover:bg-gray-50'
                            : 'border-gray-700 bg-drone-dark/40 hover:bg-drone-dark/60'
                          }`}
                      >
                        <div className="pt-1">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleBlacklistSelection(entry.hash)}
                            className="w-4 h-4 accent-sky-500"
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className={`text-xs px-1.5 py-0.5 rounded ${isLight ? 'bg-gray-100 text-gray-700' : 'bg-gray-900 text-gray-300'}`}>
                              {shortenHash(entry.hash)}
                            </code>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${entry.isPresentInSyncFolder
                              ? isLight
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : isLight
                                ? 'bg-gray-100 text-gray-600 border-gray-200'
                                : 'bg-gray-700/30 text-gray-300 border-gray-600'
                              }`}>
                              {entry.isPresentInSyncFolder ? t('settings.blacklistPresentInSyncFolder') : t('settings.blacklistNotPresentInSyncFolder')}
                            </span>
                          </div>
                          <div className={`mt-1 text-sm truncate ${isLight ? 'text-gray-800' : 'text-gray-200'}`} title={entry.currentFilename ?? ''}>
                            {entry.currentFilename ?? t('settings.blacklistUnresolvedFilename')}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={`px-4 py-3 border-t ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-drone-dark/50'}`}>
              <button
                onClick={handleClearSelectedBlacklist}
                disabled={isBlacklistScanning || isClearingSelectedBlacklist || selectedBlacklistHashes.size === 0}
                className="w-full py-2 px-3 rounded-lg border border-amber-600 text-amber-500 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {isClearingSelectedBlacklist ? t('settings.clearingSelectedLogs') : t('settings.clearSelectedFromBlacklist')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Supporter Badge Activation Modal */}
      {showBadgeModal && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center p-4 overflow-y-auto">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowBadgeModal(false)}
          />
          <div className="relative bg-drone-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-sm mx-4 overflow-hidden my-auto">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {t('settings.supporterBadge')}
              </h3>
              <button
                onClick={() => setShowBadgeModal(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 space-y-4">
              {supporterBadgeActive ? (
                <>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <svg className="w-5 h-5 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    <p className="text-sm text-amber-300">Your supporter badge is active. Thank you for supporting this project!</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveBadge}
                    className="w-full py-2 px-3 rounded-lg border border-red-600 text-red-500 hover:bg-red-500/10 transition-colors text-sm"
                  >
                    {t('settings.removeBadge')}
                  </button>
                </>
              ) : (
                <>
                  <div className="space-y-2 text-sm text-gray-300">
                    <p className="flex gap-2">
                      <span className="text-drone-primary font-semibold shrink-0">1.</span>
                      <span>
                        Visit{' '}
                        <a
                          href="https://ko-fi.com/s/e06c1d4359"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-drone-primary hover:underline font-medium"
                        >
                          this page
                        </a>
                        {' '}to get your supporter code.
                      </span>
                    </p>
                    <p className="flex gap-2">
                      <span className="text-drone-primary font-semibold shrink-0">2.</span>
                      <span>Enter the code below to activate your Supporter Badge.</span>
                    </p>
                  </div>
                  <div>
                    <input
                      type="text"
                      value={badgeCode}
                      onChange={(e) => setBadgeCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleActivateBadge(); }}
                      placeholder={t('settings.enterSupporterCode')}
                      className="input w-full"
                    />
                    <button
                      type="button"
                      onClick={handleActivateBadge}
                      disabled={!badgeCode.trim()}
                      className="btn-primary w-full mt-3"
                    >
                      {t('settings.activateBadge')}
                    </button>
                  </div>
                </>
              )}

              {badgeMessage && (
                <p className={`text-sm text-center ${badgeMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                  {badgeMessage.text}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
