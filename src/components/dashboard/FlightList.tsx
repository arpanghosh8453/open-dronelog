/**
 * Flight list component for the sidebar
 * Displays all imported flights with selection
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as api from '@/lib/api';
import { isWebMode, downloadFile, downloadBlob } from '@/lib/api';
import { buildCsv, buildJson, buildGpx, buildKml, buildKmlRelative } from '@/lib/exportUtils';
import { useFlightStore } from '@/stores/flightStore';
import { formatDuration, formatDateTime, formatDistance, formatAltitude, normalizeSerial, formatDateDisplay } from '@/lib/utils';
import { type DateRange } from 'react-day-picker';
import type { FlightDataResponse, Flight, TelemetryData } from '@/types';
import { useTranslation } from 'react-i18next';
import { addToBlacklist } from './FlightImporter';
import { FlyCardGenerator } from './FlyCardGenerator';
import { HtmlReportModal } from './HtmlReportModal';
import ColorPickerModal from './ColorPickerModal';
import { DatePickerPopover } from '@/components/ui/DatePickerPopover';
import { buildHtmlReport, type HtmlReportFieldConfig, type FlightReportData } from '@/lib/htmlReportBuilder';
import { fetchFlightWeather } from '@/lib/weather';
import {
  getBatteryGroupKey,
  getBatteryGroupMembers,
  getPairedBatteryDisplayName,
  useBatteryPairIndex,
} from '@/lib/batteryPairs';
import { useIsMobileRuntime } from '@/hooks/platform/useIsMobileRuntime';
import 'react-day-picker/dist/style.css';

function getSafeAreaInsetPx(variableName: string): number {
  if (typeof window === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
  const parsed = Number.parseFloat(raw.replace('px', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Check if element is mostly visible in the viewport
 */
function isElementInView(element: HTMLElement, threshold: number = 0.6): boolean {
  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight;

  // Calculate how much of the element is visible
  const visibleTop = Math.max(0, rect.top);
  const visibleBottom = Math.min(windowHeight, rect.bottom);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleRatio = visibleHeight / rect.height;

  return visibleRatio >= threshold;
}

/**
 * Custom smooth scroll with easing for a more polished feel
 * Skips animation if element is already mostly visible
 */
function smoothScrollToElement(
  element: HTMLElement,
  duration: number = 800,
  offset: number = 0
): Promise<void> {
  return new Promise((resolve) => {
    // If element is already mostly in view, resolve immediately
    if (isElementInView(element, 0.5)) {
      resolve();
      return;
    }

    const scrollContainer = element.closest('.overflow-auto') || document.documentElement;
    const isDocScroll = scrollContainer === document.documentElement;

    const elementRect = element.getBoundingClientRect();
    const containerRect = isDocScroll
      ? { top: 0, height: window.innerHeight }
      : (scrollContainer as HTMLElement).getBoundingClientRect();

    // Calculate target position to center the element
    const elementCenter = elementRect.top + elementRect.height / 2;
    const containerCenter = containerRect.top + containerRect.height / 2;
    const scrollOffset = elementCenter - containerCenter + offset;

    const startScroll = isDocScroll
      ? window.scrollY
      : (scrollContainer as HTMLElement).scrollTop;
    const targetScroll = startScroll + scrollOffset;

    const startTime = performance.now();

    // Ease-in-out cubic for smooth acceleration and deceleration
    const easeInOutCubic = (t: number): number => {
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };

    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeInOutCubic(progress);

      const currentScroll = startScroll + (targetScroll - startScroll) * easedProgress;

      if (isDocScroll) {
        window.scrollTo(0, currentScroll);
      } else {
        (scrollContainer as HTMLElement).scrollTop = currentScroll;
      }

      if (progress < 1) {
        requestAnimationFrame(animateScroll);
      } else {
        resolve();
      }
    };

    requestAnimationFrame(animateScroll);
  });
}

const FILTER_PROFILES_SETTING_KEY = 'flight_list_filter_profiles_v1';
const TAG_FILTER_MODE_STORAGE_KEY = 'flight_list_tag_filter_mode_v1';

interface SavedFilterSnapshot {
  selectedDrones: string[];
  selectedBatteries: string[];
  selectedControllers: string[];
  selectedTags: string[];
  tagFilterMode: 'and' | 'or';
  selectedColors: string[];
  photoFilterMin: number;
  videoFilterMin: number;
  durationFilterMin: number | null;
  durationFilterMax: number | null;
  altitudeFilterMin: number | null;
  altitudeFilterMax: number | null;
  distanceFilterMin: number | null;
  distanceFilterMax: number | null;
  dateFrom: string | null;
  dateTo: string | null;
}

interface SavedFilterProfile {
  name: string;
  filters: SavedFilterSnapshot;
  updatedAt: string;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNonNegativeInteger(value: unknown, fallback: number = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

function normalizeSavedFilterSnapshot(value: unknown): SavedFilterSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const tagFilterMode = obj.tagFilterMode === 'and' ? 'and' : 'or';
  return {
    selectedDrones: asStringArray(obj.selectedDrones),
    selectedBatteries: asStringArray(obj.selectedBatteries),
    selectedControllers: asStringArray(obj.selectedControllers),
    selectedTags: asStringArray(obj.selectedTags),
    tagFilterMode,
    selectedColors: asStringArray(obj.selectedColors),
    photoFilterMin: asNonNegativeInteger(obj.photoFilterMin),
    videoFilterMin: asNonNegativeInteger(obj.videoFilterMin),
    durationFilterMin: asNumberOrNull(obj.durationFilterMin),
    durationFilterMax: asNumberOrNull(obj.durationFilterMax),
    altitudeFilterMin: asNumberOrNull(obj.altitudeFilterMin),
    altitudeFilterMax: asNumberOrNull(obj.altitudeFilterMax),
    distanceFilterMin: asNumberOrNull(obj.distanceFilterMin),
    distanceFilterMax: asNumberOrNull(obj.distanceFilterMax),
    dateFrom: typeof obj.dateFrom === 'string' ? obj.dateFrom : null,
    dateTo: typeof obj.dateTo === 'string' ? obj.dateTo : null,
  };
}

function normalizeSavedFilterProfiles(value: unknown): SavedFilterProfile[] {
  if (!Array.isArray(value)) return [];
  const normalized: SavedFilterProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const filters = normalizeSavedFilterSnapshot(obj.filters);
    if (!name || !filters) continue;
    normalized.push({
      name,
      filters,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date(0).toISOString(),
    });
  }
  return normalized;
}

export function FlightList({
  onSelectFlight,
  onHighlightFlight,
  onTopFlightChange,
  activeView = 'flights',
  onFiltersExpanded,
}: {
  onSelectFlight?: (flightId: number) => void;
  onHighlightFlight?: (flightId: number | null) => void;
  onTopFlightChange?: (flightId: number | null) => void;
  activeView?: 'flights' | 'overview';
  onFiltersExpanded?: () => void;
} = {}) {
  const renderGlobalOverlay = (content: React.ReactNode) => {
    if (typeof document === 'undefined') return null;
    return createPortal(content, document.body);
  };

  const isMobileRuntime = useIsMobileRuntime();
  const {
    flights,
    selectedFlightId,
    selectFlight,
    deleteFlight,
    updateFlightName,
    updateFlightNotes,
    updateFlightColor,
    unitPrefs,
    locale,
    dateLocale,
    appLanguage,
    themeMode,
    timeFormat,
    getBatteryDisplayName,
    getDroneDisplayName,
    droneNameMap,
    allTags,
    mapAreaFilterEnabled,
    mapVisibleBounds,
    setMapAreaFilterEnabled,
    clearSelection,
    hideSerialNumbers,
    getDisplaySerial,
    overviewHighlightedFlightId,
    setOverviewHighlightedFlightId,
    loadAllTags,
    clearFlightDataCache,
    activeProfile,
  } =
    useFlightStore();

  const { t } = useTranslation();
  const batteryPairIndex = useBatteryPairIndex();

  // Resolve theme mode for styling
  const resolvedTheme = themeMode === 'system'
    ? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : themeMode;
  const isLight = resolvedTheme === 'light';
  const hour12 = timeFormat !== '24h';
  const heatmapDateFilter = useFlightStore((s) => s.heatmapDateFilter);
  const setHeatmapDateFilter = useFlightStore((s) => s.setHeatmapDateFilter);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [dateAnchor, setDateAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [selectedDrones, setSelectedDrones] = useState<string[]>([]);
  const [selectedBatteries, setSelectedBatteries] = useState<string[]>([]);
  const [selectedControllers, setSelectedControllers] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagFilterMode, setTagFilterMode] = useState<'and' | 'or'>(() => {
    if (typeof localStorage === 'undefined') return 'or';
    const stored = localStorage.getItem(TAG_FILTER_MODE_STORAGE_KEY);
    return stored === 'and' ? 'and' : 'or';
  });

  // For keyboard navigation: preview ID for visual highlighting before Enter confirms selection
  const [previewFlightId, setPreviewFlightId] = useState<number | null>(null);
  const [isFilterInverted, setIsFilterInverted] = useState(false);
  const [isTagDropdownOpen, setIsTagDropdownOpen] = useState(false);
  const [isDroneDropdownOpen, setIsDroneDropdownOpen] = useState(false);
  const [isBatteryDropdownOpen, setIsBatteryDropdownOpen] = useState(false);
  const [isControllerDropdownOpen, setIsControllerDropdownOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [droneSearch, setDroneSearch] = useState('');
  const [batterySearch, setBatterySearch] = useState('');
  const [controllerSearch, setControllerSearch] = useState('');
  const [durationFilterMin, setDurationFilterMin] = useState<number | null>(null);
  const [durationFilterMax, setDurationFilterMax] = useState<number | null>(null);
  const [altitudeFilterMin, setAltitudeFilterMin] = useState<number | null>(null);
  const [altitudeFilterMax, setAltitudeFilterMax] = useState<number | null>(null);
  const [distanceFilterMin, setDistanceFilterMin] = useState<number | null>(null);
  const [distanceFilterMax, setDistanceFilterMax] = useState<number | null>(null);
  const [photoFilterMin, setPhotoFilterMin] = useState(0);
  const [videoFilterMin, setVideoFilterMin] = useState(0);
  const [savedFilterProfiles, setSavedFilterProfiles] = useState<SavedFilterProfile[]>([]);
  const [selectedFilterProfileName, setSelectedFilterProfileName] = useState('none');
  const [isFilterProfileDropdownOpen, setIsFilterProfileDropdownOpen] = useState(false);
  const [pendingDeleteFilterProfile, setPendingDeleteFilterProfile] = useState<string | null>(null);
  const [showCreateFilterProfileInline, setShowCreateFilterProfileInline] = useState(false);
  const [newFilterProfileName, setNewFilterProfileName] = useState('');
  const [newFilterProfileError, setNewFilterProfileError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<
    'name' | 'date' | 'duration' | 'distance' | 'altitude' | 'speed' | 'color'
  >('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [isSortOpen, setIsSortOpen] = useState(false);
  const [sortHighlightedIndex, setSortHighlightedIndex] = useState(0);
  // Listen for collapseFilters event (accordion: importer expanded -> collapse filters)
  useEffect(() => {
    const handleCollapseFilters = () => {
      setIsFiltersCollapsed(true);
      localStorage.setItem('filtersCollapsed', 'true');
    };
    window.addEventListener('collapseFilters', handleCollapseFilters);
    return () => window.removeEventListener('collapseFilters', handleCollapseFilters);
  }, []);

  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('filtersCollapsed');
      if (stored !== null) return stored === 'true';
    }
    return true;
  });

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('sidebarFiltersCollapsedChanged', {
      detail: { collapsed: isFiltersCollapsed },
    }));
  }, [isFiltersCollapsed]);
  const [isExportDropdownOpen, setIsExportDropdownOpen] = useState(false);
  const [exportHighlightedIndex, setExportHighlightedIndex] = useState(0);
  const [tagHighlightedIndex, setTagHighlightedIndex] = useState(0);
  const [droneHighlightedIndex, setDroneHighlightedIndex] = useState(0);
  const [batteryHighlightedIndex, setBatteryHighlightedIndex] = useState(0);
  const [controllerHighlightedIndex, setControllerHighlightedIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0, currentFile: '' });
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, total: 0, currentFile: '' });
  const [confirmUntag, setConfirmUntag] = useState(false);
  const [isUntagging, setIsUntagging] = useState(false);
  const [untagProgress, setUntagProgress] = useState({ done: 0, total: 0 });
  const [showBulkTagInput, setShowBulkTagInput] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [isBulkTagging, setIsBulkTagging] = useState(false);
  const [bulkTagProgress, setBulkTagProgress] = useState({ done: 0, total: 0 });
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    flightId: number;
    boundsLeft: number;
    boundsRight: number;
  } | null>(null);
  const [contextExportSubmenuOpen, setContextExportSubmenuOpen] = useState(false);
  const [isRegeneratingTags, setIsRegeneratingTags] = useState(false);
  // Color picker state
  const [colorPickerFlightId, setColorPickerFlightId] = useState<number | null>(null);
  const [colorPickerPosition, setColorPickerPosition] = useState<{
    x: number;
    y: number;
    boundsLeft?: number;
    boundsRight?: number;
    centerHorizontally?: boolean;
  } | undefined>();
  // Color filter state
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [isColorDropdownOpen, setIsColorDropdownOpen] = useState(false);
  const [colorHighlightedIndex, setColorHighlightedIndex] = useState(0);
  const colorBtnRef = useRef<HTMLButtonElement | null>(null);
  const colorDropdownRef = useRef<HTMLDivElement | null>(null);
  // FlyCard generator state
  const [flyCardFlightId, setFlyCardFlightId] = useState<number | null>(null);
  const [flyCardPending, setFlyCardPending] = useState<number | null>(null); // Flight ID waiting for map load
  // Notes modal state
  const [notesModalFlightId, setNotesModalFlightId] = useState<number | null>(null);
  const [notesInput, setNotesInput] = useState('');
  // HTML Report modal state
  const [showHtmlReportModal, setShowHtmlReportModal] = useState(false);
  // HTML Report modal state for context menu (single flight)
  const [contextHtmlReportFlightId, setContextHtmlReportFlightId] = useState<number | null>(null);
  const dateButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortDropdownRef = useRef<HTMLDivElement | null>(null);
  const exportDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagDropdownRef = useRef<HTMLDivElement | null>(null);
  const droneDropdownRef = useRef<HTMLDivElement | null>(null);
  const batteryDropdownRef = useRef<HTMLDivElement | null>(null);
  const controllerDropdownRef = useRef<HTMLDivElement | null>(null);
  const droneBtnRef = useRef<HTMLButtonElement | null>(null);
  const batteryBtnRef = useRef<HTMLButtonElement | null>(null);
  const controllerBtnRef = useRef<HTMLButtonElement | null>(null);
  const tagBtnRef = useRef<HTMLButtonElement | null>(null);
  const filterProfileBtnRef = useRef<HTMLButtonElement | null>(null);
  const filterProfileDropdownRef = useRef<HTMLDivElement | null>(null);
  const isApplyingFilterProfileRef = useRef(false);

  const dateFormatter = useMemo(
    () => ({
      format: (date: Date) => formatDateDisplay(date, dateLocale, appLanguage),
    }),
    [dateLocale, appLanguage]
  );
  const today = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }, []);

  const hasScrollboxFilter = !!(
    durationFilterMin !== null ||
    durationFilterMax !== null ||
    altitudeFilterMin !== null ||
    altitudeFilterMax !== null ||
    distanceFilterMin !== null ||
    distanceFilterMax !== null ||
    dateRange?.from ||
    dateRange?.to ||
    selectedDrones.length > 0 ||
    selectedBatteries.length > 0 ||
    selectedControllers.length > 0 ||
    selectedTags.length > 0 ||
    selectedColors.length > 0 ||
    photoFilterMin > 0 ||
    videoFilterMin > 0
  );

  const hasAnySidebarFilter = hasScrollboxFilter || mapAreaFilterEnabled || searchQuery.trim().length > 0;

  const clearAllFilters = useCallback(() => {
    setDateRange(undefined);
    setSelectedDrones([]);
    setSelectedBatteries([]);
    setSelectedControllers([]);
    setDurationFilterMin(null);
    setDurationFilterMax(null);
    setAltitudeFilterMin(null);
    setAltitudeFilterMax(null);
    setDistanceFilterMin(null);
    setDistanceFilterMax(null);
    setPhotoFilterMin(0);
    setVideoFilterMin(0);
    setSelectedTags([]);
    setSelectedColors([]);
    setSelectedFilterProfileName('none');
    setShowCreateFilterProfileInline(false);
    setNewFilterProfileName('');
    setNewFilterProfileError(null);
    setIsFilterProfileDropdownOpen(false);
    setPendingDeleteFilterProfile(null);
    setIsFilterInverted(false);
    setMapAreaFilterEnabled(false);
    setSearchQuery('');
  }, [setMapAreaFilterEnabled]);

  const applySavedFilterSnapshot = useCallback((snapshot: SavedFilterSnapshot) => {
    isApplyingFilterProfileRef.current = true;
    setSelectedDrones(snapshot.selectedDrones);
    setSelectedBatteries(snapshot.selectedBatteries);
    setSelectedControllers(snapshot.selectedControllers);
    setSelectedTags(snapshot.selectedTags);
    setTagFilterMode(snapshot.tagFilterMode);
    setSelectedColors(snapshot.selectedColors);
    setPhotoFilterMin(snapshot.photoFilterMin);
    setVideoFilterMin(snapshot.videoFilterMin);
    setDurationFilterMin(snapshot.durationFilterMin);
    setDurationFilterMax(snapshot.durationFilterMax);
    setAltitudeFilterMin(snapshot.altitudeFilterMin);
    setAltitudeFilterMax(snapshot.altitudeFilterMax);
    setDistanceFilterMin(snapshot.distanceFilterMin);
    setDistanceFilterMax(snapshot.distanceFilterMax);

    const from = snapshot.dateFrom ? new Date(snapshot.dateFrom) : undefined;
    const to = snapshot.dateTo ? new Date(snapshot.dateTo) : undefined;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      setDateRange(undefined);
    } else if (from || to) {
      setDateRange({ from, to });
    } else {
      setDateRange(undefined);
    }
  }, []);

  const currentFilterSnapshot = useMemo<SavedFilterSnapshot>(() => ({
    selectedDrones,
    selectedBatteries,
    selectedControllers,
    selectedTags,
    tagFilterMode,
    selectedColors,
    photoFilterMin,
    videoFilterMin,
    durationFilterMin,
    durationFilterMax,
    altitudeFilterMin,
    altitudeFilterMax,
    distanceFilterMin,
    distanceFilterMax,
    dateFrom: dateRange?.from ? dateRange.from.toISOString() : null,
    dateTo: dateRange?.to ? dateRange.to.toISOString() : null,
  }), [
    selectedDrones,
    selectedBatteries,
    selectedControllers,
    selectedTags,
    tagFilterMode,
    selectedColors,
    photoFilterMin,
    videoFilterMin,
    durationFilterMin,
    durationFilterMax,
    altitudeFilterMin,
    altitudeFilterMax,
    distanceFilterMin,
    distanceFilterMax,
    dateRange,
  ]);

  const persistSavedFilterProfiles = useCallback(async (profiles: SavedFilterProfile[]) => {
    setSavedFilterProfiles(profiles);
    try {
      await api.setSettingValue(FILTER_PROFILES_SETTING_KEY, JSON.stringify(profiles));
    } catch (error) {
      console.error('Failed to save filter profiles:', error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadSavedFilterProfiles = async () => {
      try {
        const raw = await api.getSettingValue(FILTER_PROFILES_SETTING_KEY);
        if (cancelled) return;
        if (!raw) {
          setSavedFilterProfiles([]);
          setSelectedFilterProfileName('none');
          return;
        }
        const parsed = JSON.parse(raw) as unknown;
        const normalized = normalizeSavedFilterProfiles(parsed);
        setSavedFilterProfiles(normalized);
        setSelectedFilterProfileName('none');
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load filter profiles:', error);
          setSavedFilterProfiles([]);
          setSelectedFilterProfileName('none');
        }
      }
    };

    setPendingDeleteFilterProfile(null);
    setShowCreateFilterProfileInline(false);
    setNewFilterProfileName('');
    setNewFilterProfileError(null);
    setIsFilterProfileDropdownOpen(false);
    loadSavedFilterProfiles();

    return () => {
      cancelled = true;
    };
  }, [activeProfile]);

  // Persist current tag matching mode and restore it when profile changes.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const key = `${TAG_FILTER_MODE_STORAGE_KEY}:${activeProfile}`;
    const stored = localStorage.getItem(key) ?? localStorage.getItem(TAG_FILTER_MODE_STORAGE_KEY);
    setTagFilterMode(stored === 'and' ? 'and' : 'or');
  }, [activeProfile]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const key = `${TAG_FILTER_MODE_STORAGE_KEY}:${activeProfile}`;
    localStorage.setItem(key, tagFilterMode);
    // Backward-compatible fallback key for users upgrading from old builds.
    localStorage.setItem(TAG_FILTER_MODE_STORAGE_KEY, tagFilterMode);
  }, [activeProfile, tagFilterMode]);

  const handleSelectFilterProfile = useCallback((profileName: string) => {
    if (profileName === 'none') {
      setSelectedFilterProfileName('none');
      setIsFilterProfileDropdownOpen(false);
      return;
    }

    const profile = savedFilterProfiles.find((item) => item.name === profileName);
    if (!profile) return;

    applySavedFilterSnapshot(profile.filters);
    setSelectedFilterProfileName(profile.name);
    setIsFilterProfileDropdownOpen(false);
    setShowCreateFilterProfileInline(false);
    setNewFilterProfileError(null);
  }, [savedFilterProfiles, applySavedFilterSnapshot]);

  const handleCreateOrOverwriteFilterProfile = useCallback(async () => {
    const trimmedName = newFilterProfileName.trim();
    if (!trimmedName) {
      setNewFilterProfileError(t('profile.errorEmpty'));
      return;
    }
    if (trimmedName.toLowerCase() === 'none') {
      setNewFilterProfileError(t('flightList.filterProfiles.errorReservedNone'));
      return;
    }

    const nextProfile: SavedFilterProfile = {
      name: trimmedName,
      filters: currentFilterSnapshot,
      updatedAt: new Date().toISOString(),
    };

    const existingIndex = savedFilterProfiles.findIndex(
      (profile) => profile.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    const nextProfiles = [...savedFilterProfiles];
    const isNewProfile = existingIndex === -1;
    if (existingIndex >= 0) {
      nextProfiles[existingIndex] = nextProfile;
    } else {
      nextProfiles.push(nextProfile);
    }

    await persistSavedFilterProfiles(nextProfiles);
    isApplyingFilterProfileRef.current = true;
    // Newly created profiles should become the active selection immediately.
    // For overwrite, keep selecting the provided name so UI reflects latest intent.
    setSelectedFilterProfileName(isNewProfile ? nextProfile.name : trimmedName);
    setShowCreateFilterProfileInline(false);
    setNewFilterProfileName('');
    setNewFilterProfileError(null);
  }, [newFilterProfileName, currentFilterSnapshot, savedFilterProfiles, persistSavedFilterProfiles, t]);

  const handleDeleteFilterProfile = useCallback(async (profileName: string) => {
    if (profileName === 'none' || profileName === selectedFilterProfileName) {
      return;
    }
    const nextProfiles = savedFilterProfiles.filter((profile) => profile.name !== profileName);
    await persistSavedFilterProfiles(nextProfiles);
    if (selectedFilterProfileName === profileName) {
      setSelectedFilterProfileName('none');
    }
    setPendingDeleteFilterProfile(null);
  }, [savedFilterProfiles, persistSavedFilterProfiles, selectedFilterProfileName]);

  // If user manually changes any scroll-box filter while a saved profile is selected,
  // switch selection back to "none" to reflect a custom (unsaved) filter state.
  useEffect(() => {
    if (selectedFilterProfileName === 'none') return;
    if (isApplyingFilterProfileRef.current) {
      isApplyingFilterProfileRef.current = false;
      return;
    }
    setSelectedFilterProfileName('none');
  }, [
    selectedFilterProfileName,
    selectedDrones,
    selectedBatteries,
    selectedControllers,
    selectedTags,
    tagFilterMode,
    selectedColors,
    photoFilterMin,
    videoFilterMin,
    durationFilterMin,
    durationFilterMax,
    altitudeFilterMin,
    altitudeFilterMax,
    distanceFilterMin,
    distanceFilterMax,
    dateRange,
  ]);

  // Prevent all scrolling when overlay is active
  useEffect(() => {
    if (isExporting || isDeleting || isUntagging || isBulkTagging) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      // Add class to hide all scrollbars
      document.body.classList.add('overlay-active');
      return () => {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
        document.body.classList.remove('overlay-active');
      };
    }
  }, [isExporting, isDeleting, isUntagging, isBulkTagging]);

  // Close context menu on click outside or scroll
  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = () => {
      setContextMenu(null);
      setContextExportSubmenuOpen(false);
    };
    document.addEventListener('click', handleClose);
    document.addEventListener('scroll', handleClose, true);
    return () => {
      document.removeEventListener('click', handleClose);
      document.removeEventListener('scroll', handleClose, true);
    };
  }, [contextMenu]);

  // Sync filtered flight IDs to the store so Overview can use them
  // Only sync after flights have loaded to avoid setting an empty Set prematurely
  const setSidebarFilteredFlightIds = useFlightStore((s) => s.setSidebarFilteredFlightIds);

  // Apply heatmap date filter when set from Overview (double-click on heatmap day)
  // This effect must run BEFORE the general sync effect to avoid race conditions
  useEffect(() => {
    if (heatmapDateFilter) {
      // Set date range to the single selected day (from and to are the same day)
      // Use separate Date objects to avoid mutation issues
      const fromDate = new Date(heatmapDateFilter);
      fromDate.setHours(0, 0, 0, 0);
      const toDate = new Date(heatmapDateFilter);
      toDate.setHours(0, 0, 0, 0);
      setDateRange({ from: fromDate, to: toDate });
      // Expand filters section if collapsed so user can see the applied filter
      setIsFiltersCollapsed(false);
      // Clear the heatmap filter after applying (one-time action)
      setHeatmapDateFilter(null);
    }
  }, [heatmapDateFilter, setHeatmapDateFilter]);

  const dateRangeLabel = useMemo(() => {
    if (!dateRange?.from && !dateRange?.to) return t('flightList.anyDate');
    if (dateRange?.from && !dateRange?.to) {
      return `From ${dateFormatter.format(dateRange.from)}`;
    }
    if (dateRange?.from && dateRange?.to) {
      return `${dateFormatter.format(dateRange.from)} – ${dateFormatter.format(
        dateRange.to
      )}`;
    }
    return t('flightList.anyDate');
  }, [dateFormatter, dateRange]);

  const updateDateAnchor = useCallback(() => {
    const trigger = dateButtonRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;

    const sidebarRect = trigger?.closest('aside')?.getBoundingClientRect();
    const horizontalInset = 8;
    const sidebarMinWidth = 340;
    const maxAllowedWidth = Math.max(
      280,
      Math.min(
        sidebarMinWidth - horizontalInset * 2,
        (sidebarRect?.width ?? window.innerWidth) - horizontalInset * 2,
      ),
    );
    const popoverWidth = Math.min(Math.max(320, rect.width), maxAllowedWidth);
    const minLeft = (sidebarRect?.left ?? 0) + horizontalInset;
    const maxLeft = (sidebarRect?.right ?? window.innerWidth) - horizontalInset - popoverWidth;
    const left = Math.max(minLeft, Math.min(rect.left, maxLeft));

    setDateAnchor({ top: rect.bottom + 8, left, width: popoverWidth });
  }, []);

  useEffect(() => {
    if (!isDateOpen) return;
    updateDateAnchor();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDateOpen(false);
      }
    };

    window.addEventListener('resize', updateDateAnchor);
    window.addEventListener('scroll', updateDateAnchor, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('resize', updateDateAnchor);
      window.removeEventListener('scroll', updateDateAnchor, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDateOpen, updateDateAnchor]);

  // Sort dropdown keyboard navigation
  useEffect(() => {
    if (!isSortOpen) {
      setSortHighlightedIndex(0);
      return;
    }
    sortDropdownRef.current?.focus();
  }, [isSortOpen]);

  // Export dropdown keyboard navigation
  useEffect(() => {
    if (!isExportDropdownOpen) {
      setExportHighlightedIndex(0);
      return;
    }
    exportDropdownRef.current?.focus();
  }, [isExportDropdownOpen]);

  // Tag dropdown keyboard navigation
  useEffect(() => {
    if (!isTagDropdownOpen) {
      setTagHighlightedIndex(0);
      return;
    }
  }, [isTagDropdownOpen]);

  // --- Cross-filter helper: apply all filters EXCEPT the excluded dimension ---
  // This lets each filter's available options reflect the other active filters.
  const crossFiltered = useMemo(() => {
    type Dimension = 'drone' | 'battery' | 'controller' | 'duration' | 'altitude' | 'distance' | 'date' | 'tags' | 'color' | 'photo' | 'video';

    const applyFilters = (exclude: Dimension) => {
      const start = dateRange?.from ?? null;
      const end = dateRange?.to ? new Date(dateRange.to) : null;
      if (end) end.setHours(23, 59, 59, 999);

      return flights.filter((flight) => {
        // Date filter
        if (exclude !== 'date' && (start || end)) {
          if (!flight.startTime) return false;
          const d = new Date(flight.startTime);
          if (start && d < start) return false;
          if (end && d > end) return false;
        }
        // Drone filter
        if (exclude !== 'drone' && selectedDrones.length > 0) {
          const serial = normalizeSerial(flight.droneSerial);
          const key = serial || `model:${flight.droneModel ?? 'Unknown'}`;
          if (!selectedDrones.includes(key)) return false;
        }
        // Battery filter
        if (exclude !== 'battery' && selectedBatteries.length > 0) {
          if (!flight.batterySerial) return false;
          const serial = normalizeSerial(flight.batterySerial);
          const groupKey = getBatteryGroupKey(serial, batteryPairIndex);
          if (!selectedBatteries.includes(groupKey)) return false;
        }
        // Controller filter
        if (exclude !== 'controller' && selectedControllers.length > 0) {
          if (!flight.rcSerial || !selectedControllers.includes(flight.rcSerial)) return false;
        }
        // Duration filter
        if (exclude !== 'duration' && (durationFilterMin !== null || durationFilterMax !== null)) {
          const mins = (flight.durationSecs ?? 0) / 60;
          if (durationFilterMin !== null && mins < durationFilterMin) return false;
          if (durationFilterMax !== null && mins > durationFilterMax) return false;
        }
        // Altitude filter
        if (exclude !== 'altitude' && (altitudeFilterMin !== null || altitudeFilterMax !== null)) {
          const alt = flight.maxAltitude ?? 0;
          if (altitudeFilterMin !== null && alt < altitudeFilterMin) return false;
          if (altitudeFilterMax !== null && alt > altitudeFilterMax) return false;
        }
        // Distance filter
        if (exclude !== 'distance' && (distanceFilterMin !== null || distanceFilterMax !== null)) {
          const dist = flight.totalDistance ?? 0;
          if (distanceFilterMin !== null && dist < distanceFilterMin) return false;
          if (distanceFilterMax !== null && dist > distanceFilterMax) return false;
        }
        // Tags filter
        if (exclude !== 'tags' && selectedTags.length > 0) {
          const flightTagNames = (flight.tags ?? []).map(t => typeof t === 'string' ? t : t.tag);
          const matchesTags = tagFilterMode === 'and'
            ? selectedTags.every((tag) => flightTagNames.includes(tag))
            : selectedTags.some((tag) => flightTagNames.includes(tag));
          if (!matchesTags) return false;
        }
        // Color filter
        if (exclude !== 'color' && selectedColors.length > 0) {
          const flightColor = (flight.color ?? '#7dd3fc').toLowerCase();
          if (!selectedColors.includes(flightColor)) return false;
        }
        // Minimum photo count filter
        if (exclude !== 'photo' && photoFilterMin > 0) {
          const photos = Math.max(0, flight.photoCount ?? 0);
          if (photos < photoFilterMin) return false;
        }
        // Minimum video count filter
        if (exclude !== 'video' && videoFilterMin > 0) {
          const videos = Math.max(0, flight.videoCount ?? 0);
          if (videos < videoFilterMin) return false;
        }
        // Map area filter (always applied, never excluded)
        if (mapAreaFilterEnabled && mapVisibleBounds) {
          if (flight.homeLat == null || flight.homeLon == null) return false;
          const { west, south, east, north } = mapVisibleBounds;
          if (!(flight.homeLon >= west && flight.homeLon <= east && flight.homeLat >= south && flight.homeLat <= north)) return false;
        }
        return true;
      });
    };

    return {
      forDrone: applyFilters('drone'),
      forBattery: applyFilters('battery'),
      forController: applyFilters('controller'),
      forDuration: applyFilters('duration'),
      forAltitude: applyFilters('altitude'),
      forDistance: applyFilters('distance'),
      forDate: applyFilters('date'),
      forTags: applyFilters('tags'),
      forColor: applyFilters('color'),
      forPhoto: applyFilters('photo'),
      forVideo: applyFilters('video'),
    };
  }, [flights, dateRange, selectedDrones, selectedBatteries, selectedControllers, durationFilterMin, durationFilterMax, altitudeFilterMin, altitudeFilterMax, distanceFilterMin, distanceFilterMax, selectedTags, tagFilterMode, selectedColors, photoFilterMin, videoFilterMin, mapAreaFilterEnabled, mapVisibleBounds, batteryPairIndex]);

  const mediaMaxima = useMemo(() => {
    let maxPhotos = 0;
    let maxVideos = 0;

    for (const flight of crossFiltered.forPhoto) {
      const photos = Math.max(0, flight.photoCount ?? 0);
      if (photos > maxPhotos) maxPhotos = photos;
    }

    for (const flight of crossFiltered.forVideo) {
      const videos = Math.max(0, flight.videoCount ?? 0);
      if (videos > maxVideos) maxVideos = videos;
    }

    return { maxPhotos, maxVideos };
  }, [crossFiltered.forPhoto, crossFiltered.forVideo]);

  const droneOptions = useMemo(() => {
    const entries = crossFiltered.forDrone
      .map((flight) => {
        const serial = normalizeSerial(flight.droneSerial);
        // Use serial as unique key if available, otherwise fall back to model
        const key = serial || `model:${flight.droneModel ?? 'Unknown'}`;
        const fallback = flight.aircraftName || flight.droneModel || 'Unknown';
        const displayName = flight.droneSerial
          ? getDroneDisplayName(flight.droneSerial, fallback)
          : fallback;
        const label = `${displayName}${flight.droneSerial ? ` : ${getDisplaySerial(flight.droneSerial)}` : ''}`;
        return { key, label };
      })
      .filter((entry) => entry.label.trim().length > 0);

    const unique = new Map<string, string>();
    entries.forEach((entry) => {
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry.label);
      }
    });

    return Array.from(unique.entries()).map(([key, label]) => ({ key, label }));
  }, [flights, getDroneDisplayName, droneNameMap, getDisplaySerial, hideSerialNumbers]);

  const batteryOptions = useMemo(() => {
    const grouped = new Map<string, { value: string; label: string; members: string[] }>();
    flights.forEach((flight) => {
      const serial = normalizeSerial(flight.batterySerial);
      if (!serial) return;
      const groupKey = getBatteryGroupKey(serial, batteryPairIndex);
      if (grouped.has(groupKey)) return;

      grouped.set(groupKey, {
        value: groupKey,
        label: getPairedBatteryDisplayName(serial, batteryPairIndex, getBatteryDisplayName),
        members: getBatteryGroupMembers(serial, batteryPairIndex),
      });
    });
    return Array.from(grouped.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [flights, batteryPairIndex, getBatteryDisplayName]);

  const controllerOptions = useMemo(() => {
    const unique = new Set<string>();
    flights.forEach((flight) => {
      if (flight.rcSerial) {
        unique.add(flight.rcSerial);
      }
    });
    return Array.from(unique);
  }, [flights]);

  // Cross-filtered availability sets: which options are reachable given other active filters
  const availableDroneKeys = useMemo(() => {
    const keys = new Set<string>();
    crossFiltered.forDrone.forEach((f) => {
      const serial = normalizeSerial(f.droneSerial);
      keys.add(serial || `model:${f.droneModel ?? 'Unknown'}`);
    });
    return keys;
  }, [crossFiltered.forDrone]);

  const availableBatteryGroups = useMemo(() => {
    const groups = new Set<string>();
    crossFiltered.forBattery.forEach((f) => {
      const serial = normalizeSerial(f.batterySerial);
      if (!serial) return;
      groups.add(getBatteryGroupKey(serial, batteryPairIndex));
    });
    return groups;
  }, [crossFiltered.forBattery, batteryPairIndex]);

  const availableControllerSerials = useMemo(() => {
    const serials = new Set<string>();
    crossFiltered.forController.forEach((f) => {
      if (f.rcSerial) serials.add(f.rcSerial);
    });
    return serials;
  }, [crossFiltered.forController]);

  const availableTagNames = useMemo(() => {
    const tags = new Set<string>();
    crossFiltered.forTags.forEach((f) => {
      (f.tags ?? []).forEach((t) => {
        tags.add(typeof t === 'string' ? t : t.tag);
      });
    });
    return tags;
  }, [crossFiltered.forTags]);

  // All unique colors across all flights (for the color filter dropdown)
  const allFlightColors = useMemo(() => {
    const colorSet = new Set<string>();
    flights.forEach((f) => {
      colorSet.add((f.color ?? '#7dd3fc').toLowerCase());
    });
    return Array.from(colorSet).sort();
  }, [flights]);

  // Colors that are available given current cross-filter state
  const availableColors = useMemo(() => {
    const colors = new Set<string>();
    crossFiltered.forColor.forEach((f) => {
      colors.add((f.color ?? '#7dd3fc').toLowerCase());
    });
    return colors;
  }, [crossFiltered.forColor]);

  // Helper: filtered & sorted drone list for multi-select dropdown
  // Order: selected first, then available, then unavailable (greyed out) at bottom
  const getDroneSorted = useCallback(() => {
    const filtered = droneOptions
      .filter((d) => d.label.toLowerCase().includes(droneSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const aSelected = selectedDrones.includes(a.key);
      const bSelected = selectedDrones.includes(b.key);
      const aAvail = availableDroneKeys.has(a.key);
      const bAvail = availableDroneKeys.has(b.key);
      // Selected first
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      // Then available before unavailable
      if (aAvail && !bAvail) return -1;
      if (!aAvail && bAvail) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [droneOptions, droneSearch, selectedDrones, availableDroneKeys]);

  // Helper: filtered & sorted battery list for multi-select dropdown
  // Order: selected first, then available, then unavailable (greyed out) at bottom
  const getBatterySorted = useCallback(() => {
    const filtered = batteryOptions.filter((b) => b.label.toLowerCase().includes(batterySearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const aSelected = selectedBatteries.includes(a.value);
      const bSelected = selectedBatteries.includes(b.value);
      const aAvail = availableBatteryGroups.has(a.value);
      const bAvail = availableBatteryGroups.has(b.value);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      if (aAvail && !bAvail) return -1;
      if (!aAvail && bAvail) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [batteryOptions, batterySearch, selectedBatteries, availableBatteryGroups]);

  // Helper: filtered & sorted controller list for multi-select dropdown
  const getControllerSorted = useCallback(() => {
    const all = controllerOptions.map((serial) => ({ value: serial, label: getDisplaySerial(serial) }));
    const filtered = all.filter((c) => c.label.toLowerCase().includes(controllerSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const aSelected = selectedControllers.includes(a.value);
      const bSelected = selectedControllers.includes(b.value);
      const aAvail = availableControllerSerials.has(a.value);
      const bAvail = availableControllerSerials.has(b.value);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      if (aAvail && !bAvail) return -1;
      if (!aAvail && bAvail) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [controllerOptions, controllerSearch, selectedControllers, availableControllerSerials, getDisplaySerial]);

  const durationRange = useMemo(() => {
    const durations = crossFiltered.forDuration
      .map((f) => f.durationSecs ?? 0)
      .filter((d) => d > 0);
    if (durations.length === 0) return { minMins: 0, maxMins: 60 };
    let minD = durations[0];
    let maxD = durations[0];
    for (let i = 1; i < durations.length; i++) {
      if (durations[i] < minD) minD = durations[i];
      if (durations[i] > maxD) maxD = durations[i];
    }
    return {
      minMins: Math.floor(minD / 60),
      maxMins: Math.ceil(maxD / 60),
    };
  }, [crossFiltered.forDuration]);

  const altitudeRange = useMemo(() => {
    const altitudes = crossFiltered.forAltitude
      .map((f) => f.maxAltitude ?? 0)
      .filter((a) => a > 0);
    if (altitudes.length === 0) return { min: 0, max: 500 };
    let minA = altitudes[0];
    let maxA = altitudes[0];
    for (let i = 1; i < altitudes.length; i++) {
      if (altitudes[i] < minA) minA = altitudes[i];
      if (altitudes[i] > maxA) maxA = altitudes[i];
    }
    return {
      min: Math.floor(minA),
      max: Math.ceil(maxA),
    };
  }, [crossFiltered.forAltitude]);

  const distanceRange = useMemo(() => {
    const distances = crossFiltered.forDistance
      .map((f) => f.totalDistance ?? 0)
      .filter((d) => d > 0);
    if (distances.length === 0) return { min: 0, max: 10000 };
    let minDist = distances[0];
    let maxDist = distances[0];
    for (let i = 1; i < distances.length; i++) {
      if (distances[i] < minDist) minDist = distances[i];
      if (distances[i] > maxDist) maxDist = distances[i];
    }
    return {
      min: Math.floor(minDist),
      max: Math.ceil(maxDist),
    };
  }, [crossFiltered.forDistance]);

  // Clamp filter slider values when ranges change (e.g. after flight deletion)
  // This prevents filters from getting "stuck" with values outside the new data range
  useEffect(() => {
    if (durationFilterMin !== null && durationFilterMin >= durationRange.maxMins) setDurationFilterMin(null);
    if (durationFilterMax !== null && durationFilterMax <= durationRange.minMins) setDurationFilterMax(null);
    if (durationFilterMin !== null && durationFilterMin <= durationRange.minMins) setDurationFilterMin(null);
    if (durationFilterMax !== null && durationFilterMax >= durationRange.maxMins) setDurationFilterMax(null);
  }, [durationRange]);

  useEffect(() => {
    if (altitudeFilterMin !== null && altitudeFilterMin >= altitudeRange.max) setAltitudeFilterMin(null);
    if (altitudeFilterMax !== null && altitudeFilterMax <= altitudeRange.min) setAltitudeFilterMax(null);
    if (altitudeFilterMin !== null && altitudeFilterMin <= altitudeRange.min) setAltitudeFilterMin(null);
    if (altitudeFilterMax !== null && altitudeFilterMax >= altitudeRange.max) setAltitudeFilterMax(null);
  }, [altitudeRange]);

  useEffect(() => {
    if (distanceFilterMin !== null && distanceFilterMin >= distanceRange.max) setDistanceFilterMin(null);
    if (distanceFilterMax !== null && distanceFilterMax <= distanceRange.min) setDistanceFilterMax(null);
    if (distanceFilterMin !== null && distanceFilterMin <= distanceRange.min) setDistanceFilterMin(null);
    if (distanceFilterMax !== null && distanceFilterMax >= distanceRange.max) setDistanceFilterMax(null);
  }, [distanceRange]);

  useEffect(() => {
    setPhotoFilterMin((prev) => Math.min(Math.max(0, prev), mediaMaxima.maxPhotos));
  }, [mediaMaxima.maxPhotos]);

  useEffect(() => {
    setVideoFilterMin((prev) => Math.min(Math.max(0, prev), mediaMaxima.maxVideos));
  }, [mediaMaxima.maxVideos]);

  // Prune stale dropdown selections when available options shrink (e.g. after flight deletion)
  useEffect(() => {
    const validKeys = new Set(droneOptions.map((d) => d.key));
    setSelectedDrones((prev) => {
      const pruned = prev.filter((k) => validKeys.has(k));
      return pruned.length !== prev.length ? pruned : prev;
    });
  }, [droneOptions]);

  useEffect(() => {
    const validSerials = new Set(batteryOptions.map((option) => option.value));
    const serialToGroup = new Map<string, string>();
    batteryOptions.forEach((option) => {
      option.members.forEach((member) => {
        serialToGroup.set(member, option.value);
      });
    });

    setSelectedBatteries((prev) => {
      const migrated = prev
        .map((value) => {
          if (validSerials.has(value)) return value;
          const raw = value.startsWith('solo:') ? value.slice(5) : value;
          const normalized = normalizeSerial(raw);
          return serialToGroup.get(normalized) ?? getBatteryGroupKey(normalized, batteryPairIndex);
        })
        .filter((value) => validSerials.has(value));

      const deduped = Array.from(new Set(migrated));
      const unchanged = deduped.length === prev.length && deduped.every((value, index) => value === prev[index]);
      return unchanged ? prev : deduped;
    });
  }, [batteryOptions, batteryPairIndex]);

  useEffect(() => {
    const validControllers = new Set(controllerOptions);
    setSelectedControllers((prev) => {
      const pruned = prev.filter((s) => validControllers.has(s));
      return pruned.length !== prev.length ? pruned : prev;
    });
  }, [controllerOptions]);

  useEffect(() => {
    const validTags = new Set(allTags);
    setSelectedTags((prev) => {
      const pruned = prev.filter((t) => validTags.has(t));
      return pruned.length !== prev.length ? pruned : prev;
    });
  }, [allTags]);

  // Reset date range filter if no flights fall within the selected range after deletion
  useEffect(() => {
    if (!dateRange?.from && !dateRange?.to) return;
    const start = dateRange.from ?? null;
    const end = dateRange.to ? new Date(dateRange.to) : null;
    if (end) end.setHours(23, 59, 59, 999);

    const anyMatch = flights.some((f) => {
      if (!f.startTime) return false;
      const d = new Date(f.startTime);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });

    if (!anyMatch) {
      setDateRange(undefined);
    }
  }, [flights]);

  const filteredFlights = useMemo(() => {
    // Always apply filters
    const start = dateRange?.from ?? null;
    const end = dateRange?.to ? new Date(dateRange.to) : null;
    if (end) end.setHours(23, 59, 59, 999);
    const normalizedSearch = searchQuery.trim().toLowerCase();

    const hasAnyFilter = !!(start || end || selectedDrones.length > 0 || selectedBatteries.length > 0 || selectedControllers.length > 0 || durationFilterMin !== null || durationFilterMax !== null || altitudeFilterMin !== null || altitudeFilterMax !== null || distanceFilterMin !== null || distanceFilterMax !== null || selectedTags.length > 0 || selectedColors.length > 0 || photoFilterMin > 0 || videoFilterMin > 0 || (mapAreaFilterEnabled && mapVisibleBounds) || normalizedSearch);

    return flights.filter((flight) => {
      // When no filters are active, show all
      if (!hasAnyFilter) return true;

      // Each filter check returns true if the flight matches that filter.
      // Normal mode: AND all filters (must match ALL).
      // Inverted mode: negate each individual filter, then AND (must fail ALL).
      //   i.e. NOT A AND NOT B AND NOT C — exclude flights that match any active filter.

      if (start || end) {
        let matchesDate = true;
        if (!flight.startTime) {
          matchesDate = false;
        } else {
          const flightDate = new Date(flight.startTime);
          if (start && flightDate < start) matchesDate = false;
          if (end && flightDate > end) matchesDate = false;
        }
        if (isFilterInverted ? matchesDate : !matchesDate) return false;
      }

      if (selectedDrones.length > 0) {
        const serial = normalizeSerial(flight.droneSerial);
        const key = serial || `model:${flight.droneModel ?? 'Unknown'}`;
        const matchesDrone = selectedDrones.includes(key);
        if (isFilterInverted ? matchesDrone : !matchesDrone) return false;
      }

      if (selectedBatteries.length > 0) {
        const matchesBattery = (() => {
          const serial = normalizeSerial(flight.batterySerial);
          if (!serial) return false;
          const groupKey = getBatteryGroupKey(serial, batteryPairIndex);
          return selectedBatteries.includes(groupKey);
        })();
        if (isFilterInverted ? matchesBattery : !matchesBattery) return false;
      }

      if (selectedControllers.length > 0) {
        const matchesController = flight.rcSerial ? selectedControllers.includes(flight.rcSerial) : false;
        if (isFilterInverted ? matchesController : !matchesController) return false;
      }

      if (durationFilterMin !== null || durationFilterMax !== null) {
        const durationMins = (flight.durationSecs ?? 0) / 60;
        let matchesDuration = true;
        if (durationFilterMin !== null && durationMins < durationFilterMin) matchesDuration = false;
        if (durationFilterMax !== null && durationMins > durationFilterMax) matchesDuration = false;
        if (isFilterInverted ? matchesDuration : !matchesDuration) return false;
      }

      if (altitudeFilterMin !== null || altitudeFilterMax !== null) {
        const altitude = flight.maxAltitude ?? 0;
        let matchesAltitude = true;
        if (altitudeFilterMin !== null && altitude < altitudeFilterMin) matchesAltitude = false;
        if (altitudeFilterMax !== null && altitude > altitudeFilterMax) matchesAltitude = false;
        if (isFilterInverted ? matchesAltitude : !matchesAltitude) return false;
      }

      if (distanceFilterMin !== null || distanceFilterMax !== null) {
        const distance = flight.totalDistance ?? 0;
        let matchesDistance = true;
        if (distanceFilterMin !== null && distance < distanceFilterMin) matchesDistance = false;
        if (distanceFilterMax !== null && distance > distanceFilterMax) matchesDistance = false;
        if (isFilterInverted ? matchesDistance : !matchesDistance) return false;
      }

      // Tag filter: normal = flight must satisfy selected tag mode (AND/OR);
      // inverted = flight must fail selected tag mode.
      if (selectedTags.length > 0) {
        const flightTagNames = (flight.tags ?? []).map(t => typeof t === 'string' ? t : t.tag);
        const matchesTags = tagFilterMode === 'and'
          ? selectedTags.every((tag) => flightTagNames.includes(tag))
          : selectedTags.some((tag) => flightTagNames.includes(tag));
        if (isFilterInverted ? matchesTags : !matchesTags) return false;
      }

      // Color filter
      if (selectedColors.length > 0) {
        const flightColor = (flight.color ?? '#7dd3fc').toLowerCase();
        const matchesColor = selectedColors.includes(flightColor);
        if (isFilterInverted ? matchesColor : !matchesColor) return false;
      }

      if (photoFilterMin > 0) {
        const photoCount = Math.max(0, flight.photoCount ?? 0);
        const matchesPhotos = photoCount >= photoFilterMin;
        if (isFilterInverted ? matchesPhotos : !matchesPhotos) return false;
      }

      if (videoFilterMin > 0) {
        const videoCount = Math.max(0, flight.videoCount ?? 0);
        const matchesVideos = videoCount >= videoFilterMin;
        if (isFilterInverted ? matchesVideos : !matchesVideos) return false;
      }

      // Map area filter (not affected by inversion - always AND)
      if (mapAreaFilterEnabled && mapVisibleBounds) {
        if (flight.homeLat == null || flight.homeLon == null) return false;
        const { west, south, east, north } = mapVisibleBounds;
        const inBounds = flight.homeLon >= west && flight.homeLon <= east &&
          flight.homeLat >= south && flight.homeLat <= north;
        if (!inBounds) return false;
      }

      // Search filter (not affected by inversion - always AND)
      if (normalizedSearch) {
        const title = (flight.displayName || flight.fileName || '').toString().toLowerCase();
        if (!title.includes(normalizedSearch)) return false;
      }

      return true;
    });
  }, [dateRange, flights, selectedBatteries, selectedControllers, selectedDrones, durationFilterMin, durationFilterMax, altitudeFilterMin, altitudeFilterMax, distanceFilterMin, distanceFilterMax, selectedTags, tagFilterMode, selectedColors, photoFilterMin, videoFilterMin, isFilterInverted, mapAreaFilterEnabled, mapVisibleBounds, searchQuery, batteryPairIndex]);

  const batteryLabelByKey = useMemo(() => {
    const map = new Map<string, string>();
    batteryOptions.forEach((option) => {
      map.set(option.value, option.label);
    });
    return map;
  }, [batteryOptions]);

  // Sync filtered flight IDs to the store so Overview can use them
  // Use useLayoutEffect to ensure sync happens synchronously before browser paint
  // This prevents Overview from seeing stale/intermediate filter states
  useLayoutEffect(() => {
    // Don't sync if flights haven't loaded yet - this prevents setting an empty Set
    // which would cause Overview to show "no flights" incorrectly
    if (flights.length === 0) return;
    setSidebarFilteredFlightIds(new Set(filteredFlights.map((f) => f.id)));
  }, [flights.length, filteredFlights, setSidebarFilteredFlightIds]);

  // Clear selection if the currently selected flight is not in the filtered results
  useEffect(() => {
    if (selectedFlightId !== null && filteredFlights.length > 0) {
      const isSelectedInFiltered = filteredFlights.some((f) => f.id === selectedFlightId);
      if (!isSelectedInFiltered) {
        clearSelection();
      }
    } else if (selectedFlightId !== null && filteredFlights.length === 0) {
      // No flights match the filter - clear selection
      clearSelection();
    }
  }, [filteredFlights, selectedFlightId, clearSelection]);

  // Auto-scroll the flight list when an inline confirmation or rename input appears
  // so the expanded row stays visible instead of being cut off at the bottom.
  // Uses a short timeout to ensure React has committed the new DOM before measuring.
  useEffect(() => {
    const targetId = confirmDeleteId ?? editingId;
    if (targetId === null) return;
    // Wait for React to commit and the browser to layout the expanded row
    const timer = setTimeout(() => {
      const row = document.querySelector(`[data-flight-id="${targetId}"]`) as HTMLElement | null;
      if (!row) return;
      // The flight list container uses overflow-y-auto (not overflow-auto)
      const scrollContainer = row.closest('.overflow-y-auto, .overflow-auto') as HTMLElement | null;
      if (!scrollContainer) return;
      const rowRect = row.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      // If the bottom of the row is below the container's visible area, scroll down
      const overflow = rowRect.bottom - containerRect.bottom;
      if (overflow > 0) {
        scrollContainer.scrollBy({ top: overflow + 8, behavior: 'smooth' });
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [confirmDeleteId, editingId]);

  const getFlightTitle = useCallback((flight: { displayName?: string | null; fileName?: string | null }) => {
    return (flight.displayName || flight.fileName || '').toString();
  }, []);

  const sortedFlights = useMemo(() => {
    const list = [...filteredFlights];
    list.sort((a, b) => {
      if (sortOption === 'name') {
        const nameA = getFlightTitle(a).toLowerCase();
        const nameB = getFlightTitle(b).toLowerCase();
        const cmp = nameA.localeCompare(nameB);
        return sortDirection === 'asc' ? cmp : -cmp;
      }
      if (sortOption === 'duration') {
        const aDuration = a.durationSecs ?? 0;
        const bDuration = b.durationSecs ?? 0;
        return sortDirection === 'asc'
          ? aDuration - bDuration
          : bDuration - aDuration;
      }
      if (sortOption === 'distance') {
        const aDistance = a.totalDistance ?? 0;
        const bDistance = b.totalDistance ?? 0;
        return sortDirection === 'asc'
          ? aDistance - bDistance
          : bDistance - aDistance;
      }
      if (sortOption === 'altitude') {
        const aAltitude = a.maxAltitude ?? 0;
        const bAltitude = b.maxAltitude ?? 0;
        return sortDirection === 'asc'
          ? aAltitude - bAltitude
          : bAltitude - aAltitude;
      }
      if (sortOption === 'speed') {
        const aSpeed = a.maxSpeed ?? 0;
        const bSpeed = b.maxSpeed ?? 0;
        return sortDirection === 'asc'
          ? aSpeed - bSpeed
          : bSpeed - aSpeed;
      }
      if (sortOption === 'color') {
        const colorA = (a.color ?? '#7dd3fc').toLowerCase();
        const colorB = (b.color ?? '#7dd3fc').toLowerCase();
        const cmp = colorA.localeCompare(colorB);
        return sortDirection === 'asc' ? cmp : -cmp;
      }
      const aDate = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bDate = b.startTime ? new Date(b.startTime).getTime() : 0;
      return sortDirection === 'asc' ? aDate - bDate : bDate - aDate;
    });
    return list;
  }, [getFlightTitle, filteredFlights, sortDirection, sortOption]);

  // Keep parent aware of the first visible flight in the current sidebar ordering.
  useEffect(() => {
    onTopFlightChange?.(sortedFlights[0]?.id ?? null);
  }, [sortedFlights, onTopFlightChange]);

  // Keyboard navigation: Up/Down arrows to navigate flights
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle if typing in an input field
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Don't handle if a modal/dropdown is open
      if (isDateOpen || isSortOpen || isTagDropdownOpen || isColorDropdownOpen || isExportDropdownOpen || editingId !== null) {
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();

        if (sortedFlights.length === 0) return;

        // Use previewFlightId if set (during navigation), otherwise use selectedFlightId
        const currentId = previewFlightId ?? (activeView === 'overview' ? overviewHighlightedFlightId : selectedFlightId);
        const currentIndex = currentId
          ? sortedFlights.findIndex(f => f.id === currentId)
          : -1;

        let nextIndex: number;
        if (event.key === 'ArrowDown') {
          nextIndex = currentIndex < sortedFlights.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : sortedFlights.length - 1;
        }

        const nextFlight = sortedFlights[nextIndex];
        if (nextFlight) {
          if (activeView === 'overview') {
            // In overview mode, arrow keys only highlight in the list (no map scroll yet)
            setOverviewHighlightedFlightId(nextFlight.id);
          } else {
            // In flights mode, arrow keys update preview
            setPreviewFlightId(nextFlight.id);
          }

          // Scroll the item into view in the flight list
          const flightElement = document.querySelector(`[data-flight-id="${nextFlight.id}"]`);
          flightElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }

      // Enter key selects and loads the previewed/highlighted flight
      if (event.key === 'Enter') {
        event.preventDefault();
        const targetFlightId = previewFlightId ?? (activeView === 'overview' ? overviewHighlightedFlightId : null);
        if (targetFlightId !== null) {
          if (activeView === 'overview') {
            // In overview mode, Enter scrolls to map and shows the flight
            const mapElement = document.getElementById('overview-cluster-map');
            if (mapElement) {
              smoothScrollToElement(mapElement, 800).then(() => {
                onHighlightFlight?.(targetFlightId);
              });
            } else {
              onHighlightFlight?.(targetFlightId);
            }
          } else {
            // In flights mode, Enter loads the flight
            selectFlight(targetFlightId);
            onSelectFlight?.(targetFlightId);
            setPreviewFlightId(null);
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sortedFlights, selectedFlightId, previewFlightId, overviewHighlightedFlightId, activeView, selectFlight, onSelectFlight, onHighlightFlight, setOverviewHighlightedFlightId, isDateOpen, isSortOpen, isTagDropdownOpen, isColorDropdownOpen, isExportDropdownOpen, editingId]);

  const sortOptions = useMemo(
    () => [
      { value: 'name', label: t('flightList.sortName') },
      { value: 'date', label: t('flightList.sortDate') },
      { value: 'duration', label: t('flightList.sortDuration') },
      { value: 'distance', label: t('flightList.sortDistance') },
      { value: 'altitude', label: t('flightList.sortAltitude') },
      { value: 'speed', label: t('flightList.sortSpeed') },
      { value: 'color', label: t('flightList.sortColor', 'Color') },
    ],
    [t]
  );

  const activeSortLabel = useMemo(() => {
    return sortOptions.find((option) => option.value === sortOption)?.label ?? 'Sort';
  }, [sortOption, sortOptions]);

  const htmlReportExportLimit = 250;
  const isHtmlReportExportDisabled = filteredFlights.length > htmlReportExportLimit;
  const htmlReportDisabledTooltip = t(
    'flightList.htmlReportLimitTooltip',
    `HTML report export is limited to ${htmlReportExportLimit} logs`,
  );

  const sanitizeFileName = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_{2,}/g, '_');
  };


  const summaryCsvHeaders = () => [
      t('flightList.csvHeaderAircraftName'),
      t('flightList.csvHeaderAircraftSN'),
      t('flightList.csvHeaderBatterySN'),
      t('flightList.csvHeaderDate'),
      t('flightList.csvHeaderTakeoffTime'),
      t('flightList.csvHeaderDuration'),
      t('flightList.csvHeaderLandingTime'),
      t('flightList.csvHeaderDistance'),
      t('flightList.csvHeaderMaxAlt'),
      t('flightList.csvHeaderMaxDist'),
      t('flightList.csvHeaderMaxVel'),
      t('flightList.csvHeaderTakeoffLat'),
      t('flightList.csvHeaderTakeoffLon'),
      t('flightList.csvHeaderTakeoffBatteryPercent', 'takeoff_battery_percent'),
      t('flightList.csvHeaderLandingBatteryPercent', 'landing_battery_percent'),
      t('flightList.csvHeaderTakeoffBatteryTemp', 'takeoff_battery_temp'),
      t('flightList.csvHeaderLandingBatteryTemp', 'landing_battery_temp'),
      t('flightList.csvHeaderTakeoffBatteryVoltage', 'takeoff_battery_voltage'),
      t('flightList.csvHeaderLandingBatteryVoltage', 'landing_battery_voltage'),
      t('flightList.csvHeaderPhotoCount', 'photo_count'),
      t('flightList.csvHeaderVideoCount', 'video_count'),
      t('flightList.csvHeaderTags'),
      t('flightList.csvHeaderNotes'),
    ];

  const summaryEscapeCsv = (value: string) => {
    if (value.includes('"')) value = value.replace(/"/g, '""');
    if (value.includes(',') || value.includes('\n') || value.includes('\r')) {
      return `"${value}"`;
    }
    return value;
  };

  const summaryFormatDuration = (seconds: number | null): string => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  const summaryFormatTime = (isoString: string | null): string => {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toTimeString().slice(0, 5); // HH:MM
  };

  const summaryFormatDate = (isoString: string | null): string => {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
  };

  const summaryCalculateLandingTime = (takeoffTime: string | null, durationSecs: number | null): string => {
    if (!takeoffTime || !durationSecs) return '';
    const takeoff = new Date(takeoffTime);
    const landing = new Date(takeoff.getTime() + durationSecs * 1000);
    return landing.toTimeString().slice(0, 5); // HH:MM
  };

  const summaryCalculateMaxDistanceFromHome = (telemetry: TelemetryData): number | null => {
    const lats = telemetry.latitude ?? [];
    const lngs = telemetry.longitude ?? [];

    let homeLat: number | null = null;
    let homeLng: number | null = null;
    for (let i = 0; i < lats.length; i++) {
      const lat = lats[i];
      const lng = lngs[i];
      if (typeof lat === 'number' && typeof lng === 'number') {
        homeLat = lat;
        homeLng = lng;
        break;
      }
    }

    if (homeLat === null || homeLng === null) return null;

    let maxDistance = 0;
    for (let i = 0; i < lats.length; i++) {
      const lat = lats[i];
      const lng = lngs[i];
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;

      const toRad = (value: number) => (value * Math.PI) / 180;
      const r = 6371000;
      const dLat = toRad(lat - homeLat);
      const dLon = toRad(lng - homeLng);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(homeLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = r * c;

      if (distance > maxDistance) maxDistance = distance;
    }

    return maxDistance;
  };

  const buildSummaryCsvRow = (
    flight: Flight,
    data: FlightDataResponse,
    getDroneDisplayNameFn: (serial: string, fallbackName: string) => string,
  ): string => {
    const maxDistanceFromHome = summaryCalculateMaxDistanceFromHome(data.telemetry);
    const takeoffLat = flight.homeLat ?? (data.telemetry.latitude?.[0] || null);
    const takeoffLon = flight.homeLon ?? (data.telemetry.longitude?.[0] || null);

    // Get aircraft name - use edited name if available, otherwise fall back to aircraftName or droneModel
    const fallbackName = flight.aircraftName || flight.droneModel || '';
    const aircraftName = flight.droneSerial
      ? getDroneDisplayNameFn(flight.droneSerial, fallbackName)
      : fallbackName;

    // Format tags as semicolon-separated string
    const tagsStr = flight.tags?.map(t => t.tag).join('; ') || '';

    const batterySeries = data.telemetry.battery ?? [];
    const voltageSeries = data.telemetry.batteryVoltage ?? [];
    const tempSeries = data.telemetry.batteryTemp ?? [];

    const indexedBattery = batterySeries
      .map((pct, idx) => ({ pct, idx }))
      .filter((sample): sample is { pct: number; idx: number } => typeof sample.pct === 'number' && Number.isFinite(sample.pct));

    const nonZeroBattery = indexedBattery.filter((sample) => sample.pct > 0);

    let takeoffSample: { pct: number; idx: number } | null = null;
    for (const sample of nonZeroBattery) {
      if (!takeoffSample || sample.pct > takeoffSample.pct) {
        takeoffSample = sample;
      }
    }

    let landingSample: { pct: number; idx: number } | null = null;
    for (let i = indexedBattery.length - 1; i >= 0; i--) {
      const sample = indexedBattery[i];
      if (sample.pct > 0) {
        landingSample = sample;
        break;
      }
    }

    const getVoltageAt = (idx: number | null): number | null => {
      if (idx == null || idx < 0 || idx >= voltageSeries.length) return null;
      const value = voltageSeries[idx];
      return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : null;
    };

    const getTempAt = (idx: number | null): number | null => {
      if (idx == null || idx < 0 || idx >= tempSeries.length) return null;
      const value = tempSeries[idx];
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 1e-6) return null;
      if (unitPrefs.temperature === 'imperial') return (value * 9 / 5) + 32;
      return value;
    };

    const takeoffBatteryPercent = takeoffSample?.pct ?? null;
    const landingBatteryPercent = landingSample?.pct ?? null;
    const takeoffBatteryVoltage = getVoltageAt(takeoffSample?.idx ?? null);
    const landingBatteryVoltage = getVoltageAt(landingSample?.idx ?? null);
    const takeoffBatteryTemp = getTempAt(takeoffSample?.idx ?? null);
    const landingBatteryTemp = getTempAt(landingSample?.idx ?? null);

    return [
      summaryEscapeCsv(aircraftName),
      summaryEscapeCsv(flight.droneSerial || ''),
      summaryEscapeCsv(flight.batterySerial || ''),
      summaryEscapeCsv(summaryFormatDate(flight.startTime)),
      summaryEscapeCsv(summaryFormatTime(flight.startTime)),
      summaryEscapeCsv(summaryFormatDuration(flight.durationSecs)),
      summaryEscapeCsv(summaryCalculateLandingTime(flight.startTime, flight.durationSecs)),
      summaryEscapeCsv(flight.totalDistance != null ? flight.totalDistance.toFixed(2) : ''),
      summaryEscapeCsv(flight.maxAltitude != null ? flight.maxAltitude.toFixed(2) : ''),
      summaryEscapeCsv(maxDistanceFromHome != null ? maxDistanceFromHome.toFixed(2) : ''),
      summaryEscapeCsv(flight.maxSpeed != null ? flight.maxSpeed.toFixed(2) : ''),
      summaryEscapeCsv(takeoffLat != null ? takeoffLat.toFixed(7) : ''),
      summaryEscapeCsv(takeoffLon != null ? takeoffLon.toFixed(7) : ''),
      summaryEscapeCsv(takeoffBatteryPercent != null ? String(Math.round(takeoffBatteryPercent)) : ''),
      summaryEscapeCsv(landingBatteryPercent != null ? String(Math.round(landingBatteryPercent)) : ''),
      summaryEscapeCsv(takeoffBatteryTemp != null ? takeoffBatteryTemp.toFixed(1) : ''),
      summaryEscapeCsv(landingBatteryTemp != null ? landingBatteryTemp.toFixed(1) : ''),
      summaryEscapeCsv(takeoffBatteryVoltage != null ? takeoffBatteryVoltage.toFixed(2) : ''),
      summaryEscapeCsv(landingBatteryVoltage != null ? landingBatteryVoltage.toFixed(2) : ''),
      summaryEscapeCsv(flight.photoCount != null ? String(flight.photoCount) : ''),
      summaryEscapeCsv(flight.videoCount != null ? String(flight.videoCount) : ''),
      summaryEscapeCsv(tagsStr),
      summaryEscapeCsv(flight.notes || ''),
    ].join(',');
  };

  const buildSummaryCsvHeader = (): string => summaryCsvHeaders().join(',');

  const showExportFolderAccessDenied = (error: unknown) => {
    const details = error instanceof Error ? error.message : String(error);
    window.alert(t('flightList.exportFolderAccessDenied', { error: details }));
  };

  const validateDesktopExportDirectoryWritable = async (dirPath: string) => {
    const { writeTextFile, readTextFile, remove } = await import('@tauri-apps/plugin-fs');
    const marker = `open-dronelog-export-write-check-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    const tempPath = `${dirPath}/${marker}`;
    const payload = 'open-dronelog-export-write-check';

    await writeTextFile(tempPath, payload);
    const readBack = await readTextFile(tempPath);
    await remove(tempPath);

    if (readBack !== payload) {
      throw new Error('Write verification failed (content mismatch).');
    }
  };

  const validateWebExportDirectoryWritable = async (dirHandle: any) => {
    const marker = `open-dronelog-export-write-check-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    const payload = 'open-dronelog-export-write-check';
    const fileHandle = await dirHandle.getFileHandle(marker, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
    const file = await fileHandle.getFile();
    const readBack = await file.text();

    if (readBack !== payload) {
      throw new Error('Write verification failed (content mismatch).');
    }

    if (typeof dirHandle.removeEntry !== 'function') {
      throw new Error('Unable to delete temporary validation file.');
    }
    await dirHandle.removeEntry(marker);
  };

  const validateMobileExportDirectoryWritable = async (androidFs: any, dirUri: any) => {
    const marker = `open-dronelog-export-write-check-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    const payload = 'open-dronelog-export-write-check';
    const fileUri = await androidFs.AndroidFs.createNewFile(dirUri, marker, 'text/plain');
    await androidFs.AndroidFs.writeTextFile(fileUri, payload);
    const readBack = await androidFs.AndroidFs.readTextFile(fileUri);
    await androidFs.AndroidFs.removeFile(fileUri);

    if (readBack !== payload) {
      throw new Error('Write verification failed (content mismatch).');
    }
  };

  const handleBulkExport = async (format: string, extension: string) => {
    try {
      setIsExporting(true);
      setExportProgress({ done: 0, total: filteredFlights.length, currentFile: '' });

      if (isWebMode()) {
        const webWindow = window as Window & {
          showDirectoryPicker?: (options?: unknown) => Promise<any>;
        };

        let selectedDirHandle: any = null;

        let useBrowserDownloads = false;
        const confirmDownloadFallback = (): boolean => window.confirm(
          'Directory write access is unavailable. The app can download multiple individual files to your browser\'s default download location.\n\nPress OK to continue with multiple downloads, or Cancel to stop export.'
        );

        if (typeof webWindow.showDirectoryPicker === 'function') {
          try {
            selectedDirHandle = await webWindow.showDirectoryPicker({ mode: 'readwrite' });
          } catch (err) {
            const name = (err as { name?: string } | null)?.name;
            if (name === 'AbortError') {
              setIsExporting(false);
              return;
            }
            if (!confirmDownloadFallback()) {
              setIsExporting(false);
              return;
            }
            useBrowserDownloads = true;
          }
        } else {
          if (!confirmDownloadFallback()) {
            setIsExporting(false);
            return;
          }
          useBrowserDownloads = true;
        }

        if (!useBrowserDownloads && selectedDirHandle) {
          try {
            await validateWebExportDirectoryWritable(selectedDirHandle);
          } catch (error) {
            showExportFolderAccessDenied(error);
            setIsExporting(false);
            return;
          }
        }

        for (let i = 0; i < filteredFlights.length; i++) {
          const flight = filteredFlights[i];
          const baseName = flight.displayName || flight.fileName || 'flight';
          const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
          const targetName = `${safeName}.${extension}`;
          setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });

          try {
            const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);

            let content = '';
            if (format === 'csv') content = buildCsv(data, unitPrefs);
            else if (format === 'json') content = buildJson(data, unitPrefs);
            else if (format === 'gpx') content = buildGpx(data);
            else if (format === 'kml') content = buildKml(data);
            else if (format === 'kml_relative') content = buildKmlRelative(data);

            if (!useBrowserDownloads && selectedDirHandle) {
              try {
                const fileHandle = await selectedDirHandle.getFileHandle(targetName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(content);
                await writable.close();
              } catch (err) {
                console.warn(`Directory write failed for ${targetName}:`, err);
                if (!confirmDownloadFallback()) {
                  setIsExporting(false);
                  return;
                }
                useBrowserDownloads = true;
                downloadFile(targetName, content);
              }
            } else {
              downloadFile(targetName, content);
            }
          } catch (err) {
            console.error(`Failed to export flight ${flight.id}:`, err);
          }
        }

        setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
        setTimeout(() => setIsExporting(false), 1000);
        return;
      }

      // In desktop Tauri mode, pick a directory first.
      let dirPath: string | null = null;
      if (isMobileRuntime) {
        const androidFs = await import('tauri-plugin-android-fs-api');
        const dirUri = await androidFs.AndroidFs.showOpenDirPicker();
        if (!dirUri) {
          setIsExporting(false);
          return;
        }
        await androidFs.AndroidFs.persistPickerUriPermission(dirUri).catch((err) => {
          console.warn('Failed to persist Android folder permission:', err);
        });

        try {
          await validateMobileExportDirectoryWritable(androidFs, dirUri);
        } catch (error) {
          showExportFolderAccessDenied(error);
          setIsExporting(false);
          return;
        }

        const mimeTypeByExt = (ext: string): string => {
          if (ext === 'csv') return 'text/csv';
          if (ext === 'json') return 'application/json';
          if (ext === 'gpx') return 'application/gpx+xml';
          if (ext === 'kml') return 'application/vnd.google-earth.kml+xml';
          return 'text/plain';
        };

        for (let i = 0; i < filteredFlights.length; i++) {
          const flight = filteredFlights[i];
          const baseName = flight.displayName || flight.fileName || 'flight';
          const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
          setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });

          try {
            const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);
            let content = '';
            if (format === 'csv') content = buildCsv(data, unitPrefs);
            else if (format === 'json') content = buildJson(data, unitPrefs);
            else if (format === 'gpx') content = buildGpx(data);
            else if (format === 'kml') content = buildKml(data);
            else if (format === 'kml_relative') content = buildKmlRelative(data);

            const fileUri = await androidFs.AndroidFs.createNewFile(dirUri, `${safeName}.${extension}`, mimeTypeByExt(extension));
            await androidFs.AndroidFs.writeTextFile(fileUri, content);
          } catch (err) {
            console.error(`Failed to export flight ${flight.id}:`, err);
          }
        }

        setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
        setTimeout(() => setIsExporting(false), 1000);
        return;
      }

      const { open } = await import('@tauri-apps/plugin-dialog');
      dirPath = await open({ directory: true, multiple: false }) as string | null;
      if (!dirPath) {
        setIsExporting(false);
        return;
      }

      try {
        await validateDesktopExportDirectoryWritable(dirPath);
      } catch (error) {
        showExportFolderAccessDenied(error);
        setIsExporting(false);
        return;
      }

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        const baseName = flight.displayName || flight.fileName || `flight`;
        const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
        setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });

        try {
          const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);

          let content = '';
          if (format === 'csv') content = buildCsv(data, unitPrefs);
          else if (format === 'json') content = buildJson(data, unitPrefs);
          else if (format === 'gpx') content = buildGpx(data);
          else if (format === 'kml') content = buildKml(data);
          else if (format === 'kml_relative') content = buildKmlRelative(data);

          const { writeTextFile } = await import('@tauri-apps/plugin-fs');
          await writeTextFile(`${dirPath}/${safeName}.${extension}`, content);
        } catch (err) {
          console.error(`Failed to export flight ${flight.id}:`, err);
        }
      }

      setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
      setTimeout(() => setIsExporting(false), 1000);
    } catch (err) {
      console.error('Export failed:', err);
      setIsExporting(false);
    }
  };

  const handleSummaryExport = async () => {
    if (filteredFlights.length <= 1) return;

    try {
      setIsExporting(true);
      setExportProgress({ done: 0, total: filteredFlights.length, currentFile: 'Building summary...' });

      const headerLine = buildSummaryCsvHeader();

      if (isWebMode()) {
        const webWindow = window as Window & {
          showSaveFilePicker?: (options?: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }>;
        };

        let writable: { write: (data: string) => Promise<void>; close: () => Promise<void> } | null = null;
        let chunks: string[] | null = null;

        // Ask destination first when the browser supports native save pickers.
        if (typeof webWindow.showSaveFilePicker === 'function') {
          try {
            const fileHandle = await webWindow.showSaveFilePicker({
              suggestedName: 'filtered_flights_summary.csv',
              types: [{
                description: 'CSV',
                accept: { 'text/csv': ['.csv'] },
              }],
            });
            writable = await fileHandle.createWritable();
            await writable.write(`${headerLine}\n`);
          } catch (err) {
            const name = (err as { name?: string } | null)?.name;
            if (name === 'AbortError') {
              setIsExporting(false);
              return;
            }
            throw err;
          }
        } else {
          // Fallback for browsers without File System Access API.
          chunks = [headerLine, '\n'];
        }

        for (let i = 0; i < filteredFlights.length; i++) {
          const flight = filteredFlights[i];
          const baseName = flight.displayName || flight.fileName || `flight`;
          const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
          setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });

          try {
            const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);
            const line = `${buildSummaryCsvRow(flight, data, getDroneDisplayName)}\n`;
            if (writable) {
              await writable.write(line);
            } else {
              chunks?.push(line);
            }
          } catch (err) {
            console.error(`Failed to fetch flight ${flight.id} for summary:`, err);
          }
        }

        if (writable) {
          await writable.close();
        } else if (chunks) {
          const summaryBlob = new Blob(chunks, { type: 'text/csv;charset=utf-8' });
          downloadBlob('filtered_flights_summary.csv', summaryBlob);
        }
      } else {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        const saveResult = await save({
          defaultPath: 'filtered_flights_summary.csv',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });

        const resolvePath = (value: unknown): string | null => {
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
        };

        const filePath = resolvePath(saveResult);
        if (!filePath) {
          setIsExporting(false);
          return;
        }

        await writeTextFile(filePath, `${headerLine}\n`);

        for (let i = 0; i < filteredFlights.length; i++) {
          const flight = filteredFlights[i];
          const baseName = flight.displayName || flight.fileName || `flight`;
          const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
          setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });

          try {
            const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);
            const line = `${buildSummaryCsvRow(flight, data, getDroneDisplayName)}\n`;
            await writeTextFile(filePath, line, { append: true });
          } catch (err) {
            console.error(`Failed to fetch flight ${flight.id} for summary:`, err);
          }
        }
      }

      setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
      setTimeout(() => setIsExporting(false), 1000);
    } catch (err) {
      console.error('Summary export failed:', err);
      setIsExporting(false);
    }
  };

  const handleHtmlReportExport = async (config: {
    documentTitle: string;
    pilotName: string;
    fieldConfig: HtmlReportFieldConfig;
  }) => {
    setShowHtmlReportModal(false);

    // Build default filename: Flight_Regulation_Report_YYYY-MM-DD_HH-MM-SS.html
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const defaultFileName = `Flight_Regulation_Report_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.html`;

    try {
      setIsExporting(true);
      setExportProgress({ done: 0, total: filteredFlights.length, currentFile: 'Preparing report...' });

      // Check if any weather fields are enabled
      const weatherFields: (keyof HtmlReportFieldConfig)[] = [
        'temperature', 'windSpeed', 'windGusts', 'humidity',
        'cloudCover', 'precipitation', 'pressure', 'weatherCondition',
      ];
      const needsWeather = weatherFields.some((f) => config.fieldConfig[f]);

      const reportData: FlightReportData[] = [];

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        const baseName = flight.displayName || flight.fileName || 'flight';
        setExportProgress({ done: i, total: filteredFlights.length, currentFile: `Processing ${baseName}` });

        try {
          const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);

          // Fetch weather data if any weather field is enabled
          let weather = null;
          if (needsWeather) {
            const lat = flight.homeLat ?? data.telemetry.latitude?.find((v) => v !== null) ?? null;
            const lon = flight.homeLon ?? data.telemetry.longitude?.find((v) => v !== null) ?? null;
            if (lat != null && lon != null && flight.startTime) {
              try {
                weather = await fetchFlightWeather(lat as number, lon as number, flight.startTime);
              } catch {
                // Weather fetch failed; leave as null
              }
            }
          }

          reportData.push({
            flight,
            data,
            weather,
            getDroneDisplayName,
            getBatteryDisplayName,
            getDisplaySerial,
          });
        } catch (err) {
          console.error(`Failed to fetch flight ${flight.id} for HTML report:`, err);
        }
      }

      setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: 'Building report...' });

      const htmlContent = buildHtmlReport(reportData, {
        documentTitle: config.documentTitle,
        pilotName: config.pilotName,
        fieldConfig: config.fieldConfig,
        unitPrefs,
        locale,
        dateLocale,
        appLanguage,
        timeFormat,
        t,
      });

      if (isWebMode()) {
        downloadFile(defaultFileName, htmlContent, 'text/html');
      } else {
        const saved = await api.saveTextWithDialog(defaultFileName, htmlContent, [
          { name: 'HTML', extensions: ['html'] },
        ]);
        if (!saved) {
          setIsExporting(false);
          return;
        }
      }

      setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
      setTimeout(() => setIsExporting(false), 1000);
    } catch (err) {
      console.error('HTML report export failed:', err);
      setIsExporting(false);
    }
  };

  const handleBulkDelete = async () => {
    try {
      setIsDeleting(true);
      setConfirmBulkDelete(false);
      setDeleteProgress({ done: 0, total: filteredFlights.length, currentFile: '' });

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        setDeleteProgress({ done: i, total: filteredFlights.length, currentFile: flight.fileName || '' });

        // Add to blacklist before deleting (so sync won't re-import)
        if (flight.fileHash) {
          await addToBlacklist(flight.fileHash);
        }

        await api.deleteFlight(flight.id);
      }

      setDeleteProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });

      clearSelection();
      clearFlightDataCache();
      await useFlightStore.getState().loadFlights();
      await useFlightStore.getState().loadOverview();
      await loadAllTags();
      setIsDeleting(false);
    } catch (err) {
      console.error('Delete failed:', err);
      setIsDeleting(false);
    }
  };

  // Handle bulk untag (remove selected tags from filtered flights)
  const handleBulkUntag = async () => {
    if (selectedTags.length === 0 || filteredFlights.length === 0) return;

    try {
      setIsUntagging(true);
      setConfirmUntag(false);
      const tagsToRemove = [...selectedTags];
      const flightsToProcess = filteredFlights.filter(f =>
        f.tags?.some(t => tagsToRemove.includes(t.tag))
      );

      if (flightsToProcess.length === 0) {
        setIsUntagging(false);
        return;
      }

      setUntagProgress({ done: 0, total: flightsToProcess.length });

      for (let i = 0; i < flightsToProcess.length; i++) {
        const flight = flightsToProcess[i];
        setUntagProgress({ done: i, total: flightsToProcess.length });

        // Remove each selected tag from this flight
        for (const tag of tagsToRemove) {
          if (flight.tags?.some(t => t.tag === tag)) {
            await api.removeFlightTag(flight.id, tag);
          }
        }
      }

      setUntagProgress({ done: flightsToProcess.length, total: flightsToProcess.length });
      // Clear the tag filter since those tags may no longer exist
      setSelectedTags([]);
      // Refresh once at the end so the UI updates in one step.
      await useFlightStore.getState().loadFlights();
      await loadAllTags();
      clearFlightDataCache();
      setIsUntagging(false);
    } catch (err) {
      console.error('Untag failed:', err);
      setIsUntagging(false);
    }
  };

  // Handle bulk tag (add a tag to all filtered flights)
  const handleBulkTag = async () => {
    const tagToAdd = bulkTagInput.trim();
    if (!tagToAdd || filteredFlights.length === 0) {
      setShowBulkTagInput(false);
      setBulkTagInput('');
      return;
    }

    try {
      setIsBulkTagging(true);
      setShowBulkTagInput(false);
      setBulkTagProgress({ done: 0, total: filteredFlights.length });

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        setBulkTagProgress({ done: i, total: filteredFlights.length });

        // Only add if flight doesn't already have this tag
        if (!flight.tags?.some(t => t.tag === tagToAdd)) {
          await api.addFlightTag(flight.id, tagToAdd);
        }
      }

      setBulkTagProgress({ done: filteredFlights.length, total: filteredFlights.length });
      setBulkTagInput('');
      // Refresh once at the end so the UI updates in one step.
      await useFlightStore.getState().loadFlights();
      await loadAllTags();
      clearFlightDataCache();
      setIsBulkTagging(false);
    } catch (err) {
      console.error('Bulk tag failed:', err);
      setIsBulkTagging(false);
    }
  };

  // Context menu handler for right-click on flight items
  const handleContextMenu = (e: React.MouseEvent, flightId: number) => {
    e.preventDefault();
    e.stopPropagation();

    const menuWidth = 200;
    const menuHeight = 290;
    const safeTop = getSafeAreaInsetPx('--mobile-safe-top');
    const safeBottom = getSafeAreaInsetPx('--mobile-safe-bottom');
    const safeLeft = getSafeAreaInsetPx('--mobile-safe-left');
    const safeRight = getSafeAreaInsetPx('--mobile-safe-right');
    const topReserve = (isMobileRuntime ? 56 : 8) + safeTop;
    const bottomReserve = (isMobileRuntime ? 72 : 8) + safeBottom;
    const leftReserve = 8 + safeLeft;
    const rightReserve = 8 + safeRight;

    // Constrain menu to the sidebar area to avoid clipping under transformed/overflowed containers.
    const sidebarRect = (e.currentTarget as HTMLElement).closest('aside')?.getBoundingClientRect();
    const boundsLeft = sidebarRect?.left ?? 0;
    const boundsRight = sidebarRect?.right ?? window.innerWidth;
    const boundsTop = sidebarRect?.top ?? 0;
    const boundsBottom = sidebarRect?.bottom ?? window.innerHeight;

    const minX = boundsLeft + leftReserve;
    const maxX = Math.max(minX, boundsRight - menuWidth - rightReserve);
    const minY = boundsTop + topReserve;
    const maxY = Math.max(minY, boundsBottom - menuHeight - bottomReserve);
    const x = Math.min(Math.max(e.clientX, minX), maxX);
    const y = Math.min(Math.max(e.clientY, minY), maxY);

    setContextMenu({ x, y, flightId, boundsLeft, boundsRight });
    setContextExportSubmenuOpen(false);
  };

  // Handle single flight export from context menu
  const handleContextExport = async (flightId: number, format: 'csv' | 'json' | 'gpx' | 'kml' | 'kml_relative') => {
    setContextMenu(null);
    setContextExportSubmenuOpen(false);

    const flight = flights.find(f => f.id === flightId);
    if (!flight) return;

    try {
      const data = await api.getFlightData(flightId);
      if (!data) return;

      let content = '';
      const extension = format === 'kml_relative' ? 'kml' : format;

      if (format === 'csv') content = buildCsv(data, unitPrefs);
      else if (format === 'json') content = buildJson(data, unitPrefs);
      else if (format === 'gpx') content = buildGpx(data);
      else if (format === 'kml') content = buildKml(data);
      else if (format === 'kml_relative') content = buildKmlRelative(data);

      if (!content) return;

      const baseName = sanitizeFileName(flight.displayName || flight.fileName || 'flight');
      const filenameBase = format === 'kml_relative' ? `${baseName}_relative` : baseName;
      const filename = `${filenameBase}.${extension}`;

      if (isWebMode()) {
        downloadFile(filename, content);
      } else {
        const saved = await api.saveTextWithDialog(filename, content, [
          { name: extension.toUpperCase(), extensions: [extension] },
        ]);
        if (!saved) return;
      }
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  // Handle single flight HTML report export from context menu
  const handleContextHtmlReportExport = async (config: {
    documentTitle: string;
    pilotName: string;
    fieldConfig: HtmlReportFieldConfig;
  }) => {
    const flightId = contextHtmlReportFlightId;
    setContextHtmlReportFlightId(null);
    if (flightId === null) return;

    const flight = flights.find(f => f.id === flightId);
    if (!flight) return;

    const baseName = sanitizeFileName(flight.displayName || flight.fileName || 'flight');
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const defaultFileName = `${baseName || 'flight'}_Report_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.html`;

    try {
      setIsExporting(true);
      setExportProgress({ done: 0, total: 1, currentFile: `Processing ${baseName}` });

      const data: FlightDataResponse = await api.getFlightData(flightId, 999999999);

      // Check if any weather fields are enabled
      const weatherFields: (keyof HtmlReportFieldConfig)[] = [
        'temperature', 'windSpeed', 'windGusts', 'humidity',
        'cloudCover', 'precipitation', 'pressure', 'weatherCondition',
      ];
      const needsWeather = weatherFields.some((f) => config.fieldConfig[f]);

      let weather = null;
      if (needsWeather) {
        const lat = flight.homeLat ?? data.telemetry.latitude?.find((v) => v !== null) ?? null;
        const lon = flight.homeLon ?? data.telemetry.longitude?.find((v) => v !== null) ?? null;
        if (lat != null && lon != null && flight.startTime) {
          try {
            weather = await fetchFlightWeather(lat as number, lon as number, flight.startTime);
          } catch {
            // Weather fetch failed; leave as null
          }
        }
      }

      const reportData: FlightReportData[] = [{
        flight,
        data,
        weather,
        getDroneDisplayName,
        getBatteryDisplayName,
        getDisplaySerial,
      }];

      setExportProgress({ done: 1, total: 1, currentFile: 'Building report...' });

      const htmlContent = buildHtmlReport(reportData, {
        documentTitle: config.documentTitle,
        pilotName: config.pilotName,
        fieldConfig: config.fieldConfig,
        unitPrefs,
        locale,
        dateLocale,
        appLanguage,
        timeFormat,
        t,
      });

      if (isWebMode()) {
        downloadFile(defaultFileName, htmlContent, 'text/html');
      } else {
        const saved = await api.saveTextWithDialog(defaultFileName, htmlContent, [
          { name: 'HTML', extensions: ['html'] },
        ]);
        if (!saved) {
          setIsExporting(false);
          return;
        }
      }

      setExportProgress({ done: 1, total: 1, currentFile: '' });
      setTimeout(() => setIsExporting(false), 1000);
    } catch (err) {
      console.error('HTML report export failed:', err);
      setIsExporting(false);
    }
  };

  // Handle regenerate smart tags for a single flight from context menu
  const handleContextRegenerateTags = async (flightId: number) => {
    setContextMenu(null);
    setIsRegeneratingTags(true);
    try {
      const enabledTagTypes = api.getEnabledSmartTagTypes();
      await api.regenerateFlightSmartTags(flightId, enabledTagTypes);
      // Refresh flights and tags
      await useFlightStore.getState().loadFlights();
      await loadAllTags();
      clearFlightDataCache();
    } catch (err) {
      console.error('Regenerate smart tags failed:', err);
    } finally {
      setIsRegeneratingTags(false);
    }
  };

  // Handle rename from context menu
  const handleContextRename = (flightId: number) => {
    setContextMenu(null);
    const flight = flights.find(f => f.id === flightId);
    if (flight) {
      setEditingId(flightId);
      setDraftName(flight.displayName || flight.fileName);
      setConfirmDeleteId(null);
    }
  };

  // Handle delete from context menu
  const handleContextDelete = (flightId: number) => {
    setContextMenu(null);
    setConfirmDeleteId(flightId);
  };

  // Handle generate FlyCard from context menu
  const handleContextGenerateFlyCard = async (flightId: number) => {
    setContextMenu(null);

    // If this flight is not currently selected, select it first
    if (selectedFlightId !== flightId) {
      // Mark map as not loaded yet
      (window as any).__flightMapLoaded = false;

      // Set pending state to show we're waiting
      setFlyCardPending(flightId);

      // Select the flight (this will trigger map reload)
      await selectFlight(flightId);
      onSelectFlight?.(flightId);

      // Wait for map to load (poll for up to 5 seconds)
      let attempts = 0;
      while (!(window as any).__flightMapLoaded && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      // Extra delay to ensure map tiles are rendered
      await new Promise(r => setTimeout(r, 500));

      setFlyCardPending(null);
    }

    // Now open the FlyCard generator
    setFlyCardFlightId(flightId);
  };

  // Handle add/edit notes from context menu
  const handleContextAddNotes = (flightId: number) => {
    setContextMenu(null);
    const flight = flights.find(f => f.id === flightId);
    setNotesInput(flight?.notes || '');
    setNotesModalFlightId(flightId);
  };

  // Save notes
  const handleSaveNotes = async () => {
    if (notesModalFlightId === null) return;
    const trimmed = notesInput.trim();
    await updateFlightNotes(notesModalFlightId, trimmed.length > 0 ? trimmed : null);
    setNotesModalFlightId(null);
    setNotesInput('');
  };

  if (flights.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        <p className="text-sm">{t('flightList.noFlightsImported')}</p>
        <p className="text-xs mt-1">
          {t('flightList.dragAndDrop')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" onClick={() => {
      setConfirmDeleteId(null);
      setConfirmBulkDelete(false);
    }}>
      <div className="border-b border-gray-700 flex-shrink-0">
        {/* Collapsible filter header */}
        <button
          type="button"
          onClick={() => setIsFiltersCollapsed((v) => {
            const next = !v;
            localStorage.setItem('filtersCollapsed', String(next));
            if (!next) onFiltersExpanded?.();
            return next;
          })}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <span className={`font-medium ${hasAnySidebarFilter ? (isFilterInverted ? 'text-red-400' : 'text-emerald-400') : ''}`}>
              {hasAnySidebarFilter
                ? isFilterInverted ? t('flightList.filtersActiveInverted') : t('flightList.filtersActive')
                : isFiltersCollapsed ? t('flightList.filtersExpand') : t('flightList.filters')}
            </span>
            {hasAnySidebarFilter && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFilterInverted((v) => !v);
                }}
                title={isFilterInverted ? t('flightList.switchToNormal') : t('flightList.invertFilter')}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${isFilterInverted
                  ? 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
                  : 'text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10'
                  }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1-.25 1.94-.68 2.77l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1 .25-1.94.68-2.77L5.22 7.77C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                </svg>
              </button>
            )}
            {hasAnySidebarFilter && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  clearAllFilters();
                }}
                title={t('flightList.clearFilters')}
                aria-label={t('flightList.clearFilters')}
                className="w-5 h-5 rounded flex items-center justify-center text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </span>
          <span
            className={`w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center transition-transform duration-200 ${isFiltersCollapsed ? 'rotate-180' : ''
              }`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
          </span>
        </button>

        {/* Collapsible filter body */}
        <div
          className={`transition-all duration-200 ease-in-out ${isFiltersCollapsed ? 'max-h-0 overflow-hidden opacity-0' : 'max-h-[600px] overflow-visible opacity-100'
            }`}
        >
          <div className="px-3 pb-3 space-y-3">
            {/* Map area filter toggle */}
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-400">{t('flightList.overviewMapFilter')}</label>
              <button
                type="button"
                onClick={() => setMapAreaFilterEnabled(!mapAreaFilterEnabled)}
                className="flex items-center gap-2"
                aria-pressed={mapAreaFilterEnabled}
              >
                <span
                  className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${mapAreaFilterEnabled
                    ? 'bg-drone-primary/90 border-drone-primary'
                    : 'bg-drone-surface border-gray-600 toggle-track-off'
                    }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${mapAreaFilterEnabled ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                  />
                </span>
              </button>
            </div>

            {/* Scrollable filter fields container */}
            <div className={`relative rounded-lg border-2 transition-all duration-200 ${hasScrollboxFilter ? 'border-drone-primary/70' : 'border-drone-muted/50'}`}>
              <div className="max-h-[190px] overflow-y-auto overflow-x-hidden space-y-3 py-2.5 pl-2.5 pr-4 filter-scroll-area">

                    {/* Filter profile row */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.savedFilterLabel')}</label>
                        <div className="relative flex-1 min-w-0">
                          <button
                            ref={filterProfileBtnRef}
                            type="button"
                            onClick={() => {
                              setIsFilterProfileDropdownOpen((v) => !v);
                              setPendingDeleteFilterProfile(null);
                            }}
                            className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                          >
                            <span className={`truncate ${selectedFilterProfileName !== 'none' ? 'text-gray-100' : 'text-gray-400'}`}>
                              {selectedFilterProfileName === 'none' ? t('none') : selectedFilterProfileName}
                            </span>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                          </button>
                          {isFilterProfileDropdownOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-40"
                                onClick={() => {
                                  setIsFilterProfileDropdownOpen(false);
                                  setPendingDeleteFilterProfile(null);
                                }}
                              />
                              <div
                                ref={filterProfileDropdownRef}
                                className="fixed z-50 h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                                style={(() => { const r = filterProfileBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: r.left, width: r.width } : {}; })()}
                              >
                                <div className="overflow-y-auto overflow-x-hidden flex-1">
                                  <button
                                    type="button"
                                    onClick={() => handleSelectFilterProfile('none')}
                                    className={`w-full text-left px-3 py-2 text-xs transition-colors ${selectedFilterProfileName === 'none' ? 'bg-drone-primary/20 text-drone-primary' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'}`}
                                  >
                                    {t('none')}
                                  </button>
                                  {savedFilterProfiles.length === 0 && (
                                    <p className="px-3 py-2 text-xs text-gray-500">{t('flightList.filterProfiles.noneSaved')}</p>
                                  )}
                                  {savedFilterProfiles.map((profile) => {
                                    const isPendingDelete = pendingDeleteFilterProfile === profile.name;
                                    const isProtectedProfile = profile.name === selectedFilterProfileName || profile.name.toLowerCase() === 'none';
                                    return (
                                      <div key={profile.name} className="border-t border-gray-700/60">
                                        {isPendingDelete ? (
                                          <div className="px-3 py-2 text-xs text-gray-300 space-y-1">
                                            <p>{t('flightList.filterProfiles.deletePrompt', { name: profile.name })}</p>
                                            <div className="flex items-center gap-2">
                                              <button
                                                type="button"
                                                onClick={() => handleDeleteFilterProfile(profile.name)}
                                                className="text-xs text-red-400 hover:text-red-300"
                                              >
                                                {t('flightList.delete')}
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => setPendingDeleteFilterProfile(null)}
                                                className="text-xs text-gray-400 hover:text-gray-200"
                                              >
                                                {t('profile.cancel')}
                                              </button>
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="flex items-center">
                                            <button
                                              type="button"
                                              onClick={() => handleSelectFilterProfile(profile.name)}
                                              className={`flex-1 text-left px-3 py-2 text-xs transition-colors ${selectedFilterProfileName === profile.name ? 'bg-drone-primary/20 text-drone-primary' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'}`}
                                            >
                                              {profile.name}
                                            </button>
                                            {isProtectedProfile ? (
                                              <span className="px-2 py-2 text-xs text-gray-600">-</span>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={() => setPendingDeleteFilterProfile(profile.name)}
                                                className="px-2 py-2 text-xs text-gray-400 hover:text-red-300"
                                                aria-label={t('flightList.filterProfiles.deleteAria', { name: profile.name })}
                                              >
                                                x
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={!hasScrollboxFilter}
                          onClick={() => {
                            setShowCreateFilterProfileInline(true);
                            setNewFilterProfileName(selectedFilterProfileName !== 'none' ? selectedFilterProfileName : '');
                            setNewFilterProfileError(null);
                            setIsFilterProfileDropdownOpen(false);
                            setPendingDeleteFilterProfile(null);
                          }}
                          className={`h-8 px-2.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${hasScrollboxFilter
                            ? 'border-drone-primary/50 text-drone-primary hover:bg-drone-primary/15'
                            : 'border-gray-700 text-gray-500 cursor-not-allowed'}`}
                        >
                          {t('flightList.filterProfiles.saveSelectionButton')}
                        </button>
                      </div>

                      {showCreateFilterProfileInline && (
                        <div className="grid grid-cols-[52px_minmax(0,1fr)] items-start gap-2">
                          <div />
                          <div className="rounded-md border border-gray-700 bg-black/20 p-2 space-y-1.5">
                            <p className="text-[11px] text-gray-400">{t('flightList.filterProfiles.createDescription')}</p>
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={newFilterProfileName}
                                onChange={(e) => {
                                  setNewFilterProfileName(e.target.value);
                                  if (newFilterProfileError) setNewFilterProfileError(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handleCreateOrOverwriteFilterProfile();
                                  }
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setShowCreateFilterProfileInline(false);
                                    setNewFilterProfileError(null);
                                  }
                                }}
                                placeholder={t('profile.namePlaceholder')}
                                className="input flex-1 text-xs h-7 px-2"
                                autoFocus
                              />
                            </div>
                            <div className="flex items-center justify-end gap-3">
                              <button
                                type="button"
                                onClick={handleCreateOrOverwriteFilterProfile}
                                className="text-xs text-drone-primary hover:text-drone-primary"
                              >
                                {t('profile.create')}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowCreateFilterProfileInline(false);
                                  setNewFilterProfileError(null);
                                }}
                                className="text-xs text-gray-400 hover:text-gray-200"
                              >
                                {t('profile.cancel')}
                              </button>
                            </div>
                            {newFilterProfileError && <p className="text-[11px] text-red-400">{newFilterProfileError}</p>}
                          </div>
                        </div>
                      )}

                      <div className="border-b border-gray-700/70" />
                    </div>

                    {/* Duration range slider */}
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0 text-center">{t('flightList.duration')}</label>
                      <div className="flex-1 flex items-center gap-2 min-w-0">
                        <div className="flex-1 min-w-0">
                          {(() => {
                            const lo = durationFilterMin ?? durationRange.minMins;
                            const hi = durationFilterMax ?? durationRange.maxMins;
                            const span = Math.max(durationRange.maxMins - durationRange.minMins, 1);
                            const loPct = ((lo - durationRange.minMins) / span) * 100;
                            const hiPct = ((hi - durationRange.minMins) / span) * 100;
                            return (
                              <div className="dual-range-wrap" style={{ '--lo-pct': `${loPct}%`, '--hi-pct': `${hiPct}%` } as React.CSSProperties}>
                                <div className="dual-range-track" />
                                <div className="dual-range-fill" />
                                <input
                                  type="range"
                                  min={durationRange.minMins}
                                  max={durationRange.maxMins}
                                  step={1}
                                  value={lo}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const clamped = Math.min(val, hi - 1);
                                    setDurationFilterMin(clamped <= durationRange.minMins ? null : clamped);
                                  }}
                                  className="dual-range-input"
                                />
                                <input
                                  type="range"
                                  min={durationRange.minMins}
                                  max={durationRange.maxMins}
                                  step={1}
                                  value={hi}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const clamped = Math.max(val, lo + 1);
                                    setDurationFilterMax(clamped >= durationRange.maxMins ? null : clamped);
                                  }}
                                  className="dual-range-input"
                                />
                              </div>
                            );
                          })()}
                        </div>
                        <span className={`text-xs font-medium whitespace-nowrap min-w-[60px] flex items-center justify-center flex-shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                          {(() => {
                            const lo = durationFilterMin ?? durationRange.minMins;
                            const hi = durationFilterMax ?? durationRange.maxMins;
                            const fmt = (m: number) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 > 0 ? m % 60 : ''}` : `${m}m`;
                            if (durationFilterMin === null && durationFilterMax === null) return t('flightList.any');
                            return `${fmt(lo)}–${fmt(hi)}`;
                          })()}
                        </span>
                      </div>
                    </div>

                    {/* Max Altitude range slider */}
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0 text-center">{t('flightList.altitude')}</label>
                      <div className="flex-1 flex items-center gap-2 min-w-0">
                        <div className="flex-1 min-w-0">
                          {(() => {
                            const lo = altitudeFilterMin ?? altitudeRange.min;
                            const hi = altitudeFilterMax ?? altitudeRange.max;
                            const span = Math.max(altitudeRange.max - altitudeRange.min, 1);
                            const loPct = ((lo - altitudeRange.min) / span) * 100;
                            const hiPct = ((hi - altitudeRange.min) / span) * 100;
                            return (
                              <div className="dual-range-wrap" style={{ '--lo-pct': `${loPct}%`, '--hi-pct': `${hiPct}%` } as React.CSSProperties}>
                                <div className="dual-range-track" />
                                <div className="dual-range-fill" />
                                <input
                                  type="range"
                                  min={altitudeRange.min}
                                  max={altitudeRange.max}
                                  step={1}
                                  value={lo}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const clamped = Math.min(val, hi - 1);
                                    setAltitudeFilterMin(clamped <= altitudeRange.min ? null : clamped);
                                  }}
                                  className="dual-range-input"
                                />
                                <input
                                  type="range"
                                  min={altitudeRange.min}
                                  max={altitudeRange.max}
                                  step={1}
                                  value={hi}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const clamped = Math.max(val, lo + 1);
                                    setAltitudeFilterMax(clamped >= altitudeRange.max ? null : clamped);
                                  }}
                                  className="dual-range-input"
                                />
                              </div>
                            );
                          })()}
                        </div>
                        <span className={`text-xs font-medium whitespace-nowrap min-w-[60px] flex items-center justify-center flex-shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                          {(() => {
                            const lo = altitudeFilterMin ?? altitudeRange.min;
                            const hi = altitudeFilterMax ?? altitudeRange.max;
                            const fmt = (m: number) => unitPrefs.altitude === 'imperial' ? `${Math.round(m * 3.28084)}ft` : `${m}m`;
                            if (altitudeFilterMin === null && altitudeFilterMax === null) return t('flightList.any');
                            return `${fmt(lo)}–${fmt(hi)}`;
                          })()}
                        </span>
                      </div>
                    </div>

                    {/* Total Distance range slider */}
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0 text-center">{t('flightList.distance')}</label>
                      <div className="flex-1 flex items-center gap-2 min-w-0">
                        <div className="flex-1 min-w-0">
                          {(() => {
                            const lo = distanceFilterMin ?? distanceRange.min;
                            const hi = distanceFilterMax ?? distanceRange.max;
                            const span = Math.max(distanceRange.max - distanceRange.min, 1);
                            const loPct = ((lo - distanceRange.min) / span) * 100;
                            const hiPct = ((hi - distanceRange.min) / span) * 100;
                            return (
                              <div className="dual-range-wrap" style={{ '--lo-pct': `${loPct}%`, '--hi-pct': `${hiPct}%` } as React.CSSProperties}>
                                <div className="dual-range-track" />
                                <div className="dual-range-fill" />
                                <input
                                  type="range"
                                  min={distanceRange.min}
                                  max={distanceRange.max}
                                  step={1}
                                  value={lo}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const clamped = Math.min(val, hi - 1);
                                    setDistanceFilterMin(clamped <= distanceRange.min ? null : clamped);
                                  }}
                                  className="dual-range-input"
                                />
                                <input
                                  type="range"
                                  min={distanceRange.min}
                                  max={distanceRange.max}
                                  step={1}
                                  value={hi}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const clamped = Math.max(val, lo + 1);
                                    setDistanceFilterMax(clamped >= distanceRange.max ? null : clamped);
                                  }}
                                  className="dual-range-input"
                                />
                              </div>
                            );
                          })()}
                        </div>
                        <span className={`text-xs font-medium whitespace-nowrap min-w-[60px] flex items-center justify-center flex-shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                          {(() => {
                            const lo = distanceFilterMin ?? distanceRange.min;
                            const hi = distanceFilterMax ?? distanceRange.max;
                            const fmt = (m: number) => {
                              if (unitPrefs.distance === 'imperial') {
                                const miles = m * 0.000621371;
                                return miles >= 1 ? `${miles.toFixed(1)}mi` : `${Math.round(m * 3.28084)}ft`;
                              }
                              return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
                            };
                            if (distanceFilterMin === null && distanceFilterMax === null) return t('flightList.any');
                            return `${fmt(lo)}–${fmt(hi)}`;
                          })()}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.date')}</label>
                      <button
                        ref={dateButtonRef}
                        type="button"
                        onClick={() => setIsDateOpen((open) => !open)}
                        className="input flex-1 text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                      >
                        <span
                          className={
                            dateRange?.from || dateRange?.to ? 'text-gray-100' : 'text-gray-400'
                          }
                        >
                          {dateRangeLabel}
                        </span>
                        <CalendarIcon />
                      </button>
                      <DatePickerPopover
                        isOpen={isDateOpen && !!dateAnchor}
                        onClose={() => setIsDateOpen(false)}
                        mode="range"
                        selected={dateRange}
                        onSelect={(range) => {
                          setDateRange(range);
                          if (range?.from && range?.to) {
                            setIsDateOpen(false);
                          }
                        }}
                        disabled={{ after: today }}
                        jumpMaxDate={today}
                        onJumpRange={(range) => {
                          setDateRange(range);
                          setIsDateOpen(false);
                        }}
                        dayPickerClassName="rdp-theme"
                        style={dateAnchor ? {
                          top: dateAnchor.top,
                          left: dateAnchor.left,
                          width: dateAnchor.width,
                        } : undefined}
                        footer={(
                          <div className="mt-2 flex items-center justify-between">
                            <button
                              type="button"
                              onClick={() => setDateRange(undefined)}
                              className="text-xs text-gray-400 hover:text-white"
                            >
                              {t('flightList.clearRange')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setIsDateOpen(false)}
                              className="text-xs text-gray-200 hover:text-white"
                            >
                              {t('flightList.done')}
                            </button>
                          </div>
                        )}
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.drone')}</label>
                      <div className="relative flex-1 min-w-0">
                        <button
                          ref={droneBtnRef}
                          type="button"
                          onClick={() => setIsDroneDropdownOpen((v) => !v)}
                          className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                        >
                          <span className={`truncate ${selectedDrones.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                            {selectedDrones.length > 0
                              ? selectedDrones.map((k) => droneOptions.find((d) => d.key === k)?.label ?? k).join(', ')
                              : t('flightList.allDrones')}
                          </span>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                        </button>
                        {isDroneDropdownOpen && (
                          <>
                            <div
                              className="fixed inset-0 z-40"
                              onClick={() => { setIsDroneDropdownOpen(false); setDroneSearch(''); }}
                            />
                            <div
                              ref={droneDropdownRef}
                              className="fixed z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                              style={(() => { const r = droneBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: r.left, width: r.width } : {}; })()}
                            >
                              {droneOptions.length > 4 && (
                                <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                                  <input
                                    type="text"
                                    value={droneSearch}
                                    onChange={(e) => { setDroneSearch(e.target.value); setDroneHighlightedIndex(0); }}
                                    onKeyDown={(e) => {
                                      const sorted = getDroneSorted();
                                      if (e.key === 'ArrowDown') { e.preventDefault(); setDroneHighlightedIndex((prev) => prev < sorted.length - 1 ? prev + 1 : 0); }
                                      else if (e.key === 'ArrowUp') { e.preventDefault(); setDroneHighlightedIndex((prev) => prev > 0 ? prev - 1 : sorted.length - 1); }
                                      else if (e.key === 'Enter' && sorted.length > 0) {
                                        e.preventDefault();
                                        const item = sorted[droneHighlightedIndex];
                                        if (item && (availableDroneKeys.has(item.key) || selectedDrones.includes(item.key))) setSelectedDrones((prev) => prev.includes(item.key) ? prev.filter((k) => k !== item.key) : [...prev, item.key]);
                                      } else if (e.key === 'Escape') { e.preventDefault(); setIsDroneDropdownOpen(false); setDroneSearch(''); }
                                    }}
                                    placeholder={t('flightList.searchDrones')}
                                    autoFocus
                                    className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                                  />
                                </div>
                              )}
                              <div className="overflow-auto flex-1">
                                {(() => {
                                  const sorted = getDroneSorted();
                                  if (sorted.length === 0) return <p className="text-xs text-gray-500 px-3 py-2">{t('flightList.noMatchingDrones')}</p>;
                                  return sorted.map((drone, index) => {
                                    const isSelected = selectedDrones.includes(drone.key);
                                    const isAvailable = availableDroneKeys.has(drone.key);
                                    const isDisabled = !isSelected && !isAvailable;
                                    return (
                                      <button
                                        key={drone.key}
                                        type="button"
                                        onClick={() => !isDisabled && setSelectedDrones((prev) => isSelected ? prev.filter((k) => k !== drone.key) : [...prev, drone.key])}
                                        onMouseEnter={() => !isDisabled && setDroneHighlightedIndex(index)}
                                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isDisabled ? 'opacity-35 cursor-default' : isSelected ? 'bg-drone-primary/20 text-gray-800 dark:text-drone-primary' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                          } ${!isDisabled && index === droneHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                                      >
                                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-drone-primary bg-drone-primary' : 'border-gray-400 dark:border-gray-600'
                                          }`}>
                                          {isSelected && (
                                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                          )}
                                        </span>
                                        <span className="truncate">{drone.label}</span>
                                      </button>
                                    );
                                  });
                                })()}
                                {selectedDrones.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => { setSelectedDrones([]); setDroneSearch(''); setIsDroneDropdownOpen(false); }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                                  >
                                    {t('flightList.clearDroneFilter')}
                                  </button>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.battery')}</label>
                      <div className="relative flex-1 min-w-0">
                        <button
                          ref={batteryBtnRef}
                          type="button"
                          onClick={() => setIsBatteryDropdownOpen((v) => !v)}
                          className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                        >
                          <span className={`truncate ${selectedBatteries.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                            {selectedBatteries.length > 0
                              ? selectedBatteries.map((key) => batteryLabelByKey.get(key) ?? key).join(', ')
                              : t('flightList.allBatteries')}
                          </span>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                        </button>
                        {isBatteryDropdownOpen && (
                          <>
                            <div
                              className="fixed inset-0 z-40"
                              onClick={() => { setIsBatteryDropdownOpen(false); setBatterySearch(''); }}
                            />
                            <div
                              ref={batteryDropdownRef}
                              className="fixed z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                              style={(() => { const r = batteryBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: r.left, width: r.width } : {}; })()}
                            >
                              {batteryOptions.length > 4 && (
                                <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                                  <input
                                    type="text"
                                    value={batterySearch}
                                    onChange={(e) => { setBatterySearch(e.target.value); setBatteryHighlightedIndex(0); }}
                                    onKeyDown={(e) => {
                                      const sorted = getBatterySorted();
                                      if (e.key === 'ArrowDown') { e.preventDefault(); setBatteryHighlightedIndex((prev) => prev < sorted.length - 1 ? prev + 1 : 0); }
                                      else if (e.key === 'ArrowUp') { e.preventDefault(); setBatteryHighlightedIndex((prev) => prev > 0 ? prev - 1 : sorted.length - 1); }
                                      else if (e.key === 'Enter' && sorted.length > 0) {
                                        e.preventDefault();
                                        const item = sorted[batteryHighlightedIndex];
                                        if (item && (availableBatteryGroups.has(item.value) || selectedBatteries.includes(item.value))) setSelectedBatteries((prev) => prev.includes(item.value) ? prev.filter((k) => k !== item.value) : [...prev, item.value]);
                                      } else if (e.key === 'Escape') { e.preventDefault(); setIsBatteryDropdownOpen(false); setBatterySearch(''); }
                                    }}
                                    placeholder={t('flightList.searchBatteries')}
                                    autoFocus
                                    className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                                  />
                                </div>
                              )}
                              <div className="overflow-auto flex-1">
                                {(() => {
                                  const sorted = getBatterySorted();
                                  if (sorted.length === 0) return <p className="text-xs text-gray-500 px-3 py-2">{t('flightList.noMatchingBatteries')}</p>;
                                  return sorted.map((bat, index) => {
                                    const isSelected = selectedBatteries.includes(bat.value);
                                    const isAvailable = availableBatteryGroups.has(bat.value);
                                    const isDisabled = !isSelected && !isAvailable;
                                    return (
                                      <button
                                        key={bat.value}
                                        type="button"
                                        onClick={() => !isDisabled && setSelectedBatteries((prev) => isSelected ? prev.filter((k) => k !== bat.value) : [...prev, bat.value])}
                                        onMouseEnter={() => !isDisabled && setBatteryHighlightedIndex(index)}
                                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isDisabled ? 'opacity-35 cursor-default' : isSelected ? 'bg-amber-500/20 text-gray-800 dark:text-amber-200' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                          } ${!isDisabled && index === batteryHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                                      >
                                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-amber-500 bg-amber-500' : 'border-gray-400 dark:border-gray-600'
                                          }`}>
                                          {isSelected && (
                                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                          )}
                                        </span>
                                        <span className="truncate">{bat.label}</span>
                                      </button>
                                    );
                                  });
                                })()}
                                {selectedBatteries.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => { setSelectedBatteries([]); setBatterySearch(''); setIsBatteryDropdownOpen(false); }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                                  >
                                    {t('flightList.clearBatteryFilter')}
                                  </button>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Controller filter */}
                    {controllerOptions.length > 0 && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.controller')}</label>
                        <div className="relative flex-1 min-w-0">
                          <button
                            ref={controllerBtnRef}
                            type="button"
                            onClick={() => setIsControllerDropdownOpen((v) => !v)}
                            className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                          >
                            <span className={`truncate ${selectedControllers.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                              {selectedControllers.length > 0
                                ? selectedControllers.map((s) => getDisplaySerial(s)).join(', ')
                                : t('flightList.allControllers')}
                            </span>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                          </button>
                          {isControllerDropdownOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-40"
                                onClick={() => { setIsControllerDropdownOpen(false); setControllerSearch(''); }}
                              />
                              <div
                                ref={controllerDropdownRef}
                                className="fixed z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                                style={(() => { const r = controllerBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: r.left, width: r.width } : {}; })()}
                              >
                                {controllerOptions.length > 4 && (
                                  <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                                    <input
                                      type="text"
                                      value={controllerSearch}
                                      onChange={(e) => { setControllerSearch(e.target.value); setControllerHighlightedIndex(0); }}
                                      onKeyDown={(e) => {
                                        const sorted = getControllerSorted();
                                        if (e.key === 'ArrowDown') { e.preventDefault(); setControllerHighlightedIndex((prev) => prev < sorted.length - 1 ? prev + 1 : 0); }
                                        else if (e.key === 'ArrowUp') { e.preventDefault(); setControllerHighlightedIndex((prev) => prev > 0 ? prev - 1 : sorted.length - 1); }
                                        else if (e.key === 'Enter' && sorted.length > 0) {
                                          e.preventDefault();
                                          const item = sorted[controllerHighlightedIndex];
                                          if (item && (availableControllerSerials.has(item.value) || selectedControllers.includes(item.value))) setSelectedControllers((prev) => prev.includes(item.value) ? prev.filter((k) => k !== item.value) : [...prev, item.value]);
                                        } else if (e.key === 'Escape') { e.preventDefault(); setIsControllerDropdownOpen(false); setControllerSearch(''); }
                                      }}
                                      placeholder={t('flightList.searchControllers')}
                                      autoFocus
                                      className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                                    />
                                  </div>
                                )}
                                <div className="overflow-auto flex-1">
                                  {(() => {
                                    const sorted = getControllerSorted();
                                    if (sorted.length === 0) return <p className="text-xs text-gray-500 px-3 py-2">{t('flightList.noMatchingControllers')}</p>;
                                    return sorted.map((ctrl, index) => {
                                      const isSelected = selectedControllers.includes(ctrl.value);
                                      const isAvailable = availableControllerSerials.has(ctrl.value);
                                      const isDisabled = !isSelected && !isAvailable;
                                      return (
                                        <button
                                          key={ctrl.value}
                                          type="button"
                                          onClick={() => !isDisabled && setSelectedControllers((prev) => isSelected ? prev.filter((k) => k !== ctrl.value) : [...prev, ctrl.value])}
                                          onMouseEnter={() => !isDisabled && setControllerHighlightedIndex(index)}
                                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isDisabled ? 'opacity-35 cursor-default' : isSelected ? 'bg-purple-500/20 text-gray-800 dark:text-purple-200' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                            } ${!isDisabled && index === controllerHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                                        >
                                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-purple-500 bg-purple-500' : 'border-gray-400 dark:border-gray-600'
                                            }`}>
                                            {isSelected && (
                                              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                            )}
                                          </span>
                                          <span className="truncate">{ctrl.label}</span>
                                        </button>
                                      );
                                    });
                                  })()}
                                  {selectedControllers.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => { setSelectedControllers([]); setControllerSearch(''); setIsControllerDropdownOpen(false); }}
                                      className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                                    >
                                      {t('flightList.clearControllerFilter')}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Tag filter */}
                    {allTags.length > 0 && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.tags')}</label>
                        <div className="relative flex-1 min-w-0">
                          <button
                            ref={tagBtnRef}
                            type="button"
                            onClick={() => setIsTagDropdownOpen((v) => !v)}
                            className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                          >
                            <span className={`truncate ${selectedTags.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                              {selectedTags.length > 0 ? selectedTags.join(', ') : t('flightList.allTags')}
                            </span>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                          </button>
                            {isTagDropdownOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-40"
                                onClick={() => { setIsTagDropdownOpen(false); setTagSearch(''); }}
                              />
                              <div
                                ref={tagDropdownRef}
                                className="fixed z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                                style={(() => { const r = tagBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: r.left, width: r.width } : {}; })()}
                              >
                                {/* Search input */}
                                <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                                  <input
                                    type="text"
                                    value={tagSearch}
                                    onChange={(e) => { setTagSearch(e.target.value); setTagHighlightedIndex(0); }}
                                    onKeyDown={(e) => {
                                      const filtered = allTags.filter((tag) => tag.toLowerCase().includes(tagSearch.toLowerCase()));
                                      const sorted = [...filtered].sort((a, b) => {
                                        const aSelected = selectedTags.includes(a);
                                        const bSelected = selectedTags.includes(b);
                                        const aAvail = availableTagNames.has(a);
                                        const bAvail = availableTagNames.has(b);
                                        if (aSelected && !bSelected) return -1;
                                        if (!aSelected && bSelected) return 1;
                                        if (aAvail && !bAvail) return -1;
                                        if (!aAvail && bAvail) return 1;
                                        return a.localeCompare(b);
                                      });
                                      if (e.key === 'ArrowDown') {
                                        e.preventDefault();
                                        setTagHighlightedIndex(prev => prev < sorted.length - 1 ? prev + 1 : 0);
                                      } else if (e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        setTagHighlightedIndex(prev => prev > 0 ? prev - 1 : sorted.length - 1);
                                      } else if (e.key === 'Enter' && sorted.length > 0) {
                                        e.preventDefault();
                                        const tag = sorted[tagHighlightedIndex];
                                        if (tag && (availableTagNames.has(tag) || selectedTags.includes(tag))) {
                                          setSelectedTags((prev) =>
                                            prev.includes(tag)
                                              ? prev.filter((t) => t !== tag)
                                              : [...prev, tag]
                                          );
                                        }
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setIsTagDropdownOpen(false);
                                        setTagSearch('');
                                      }
                                    }}
                                    placeholder={t('flightList.searchTags')}
                                    autoFocus
                                    className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                                  />
                                </div>
                                <div className="overflow-auto flex-1">
                                  {(() => {
                                    const filtered = allTags.filter((tag) => tag.toLowerCase().includes(tagSearch.toLowerCase()));
                                    if (filtered.length === 0) {
                                      return <p className="text-xs text-gray-500 px-3 py-2">{t('flightList.noMatchingTags')}</p>;
                                    }
                                    // Sort: selected first, then available, then unavailable at bottom
                                    const sorted = [...filtered].sort((a, b) => {
                                      const aSelected = selectedTags.includes(a);
                                      const bSelected = selectedTags.includes(b);
                                      const aAvail = availableTagNames.has(a);
                                      const bAvail = availableTagNames.has(b);
                                      if (aSelected && !bSelected) return -1;
                                      if (!aSelected && bSelected) return 1;
                                      if (aAvail && !bAvail) return -1;
                                      if (!aAvail && bAvail) return 1;
                                      return a.localeCompare(b);
                                    });
                                    return sorted.map((tag, index) => {
                                      const isSelected = selectedTags.includes(tag);
                                      const isAvailable = availableTagNames.has(tag);
                                      const isDisabled = !isSelected && !isAvailable;
                                      return (
                                        <button
                                          key={tag}
                                          type="button"
                                          onClick={() => {
                                            if (isDisabled) return;
                                            setSelectedTags((prev) =>
                                              isSelected
                                                ? prev.filter((t) => t !== tag)
                                                : [...prev, tag]
                                            );
                                          }}
                                          onMouseEnter={() => !isDisabled && setTagHighlightedIndex(index)}
                                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isDisabled ? 'opacity-35 cursor-default' : isSelected
                                            ? 'bg-violet-500/20 text-gray-800 dark:text-violet-200'
                                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                            } ${!isDisabled && index === tagHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                                        >
                                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-violet-500 bg-violet-500' : 'border-gray-400 dark:border-gray-600'
                                            }`}>
                                            {isSelected && (
                                              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                            )}
                                          </span>
                                          {tag}
                                        </button>
                                      );
                                    });
                                  })()}
                                  {selectedTags.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedTags([]);
                                        setTagSearch('');
                                        setIsTagDropdownOpen(false);
                                      }}
                                      className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                                    >
                                      {t('flightList.clearTagFilter')}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </>
                            )}
                          </div>

                          <div
                            className={`h-8 rounded-lg border p-0.5 flex items-center gap-0.5 flex-shrink-0 ${isLight
                              ? 'border-gray-300 bg-transparent'
                              : 'border-gray-600/80 bg-gray-900/60'
                              }`}
                            role="group"
                            aria-label={t('flightList.tagMatchMode', 'Tag match mode')}
                          >
                            <button
                              type="button"
                              onClick={() => setTagFilterMode('and')}
                              className={`h-full min-w-[2.25rem] px-2 rounded-md text-[10px] font-semibold transition-colors ${tagFilterMode === 'and'
                                ? 'bg-drone-primary text-white'
                                : isLight
                                  ? 'text-gray-700 hover:bg-gray-200/70'
                                  : 'text-gray-300 hover:bg-gray-700/70'
                                }`}
                              title={t('flightList.tagMatchAll', 'Require all selected tags')}
                              aria-pressed={tagFilterMode === 'and'}
                            >
                              AND
                            </button>
                            <button
                              type="button"
                              onClick={() => setTagFilterMode('or')}
                              className={`h-full min-w-[2.25rem] px-2 rounded-md text-[10px] font-semibold transition-colors ${tagFilterMode === 'or'
                                ? 'bg-drone-primary text-white'
                                : isLight
                                  ? 'text-gray-700 hover:bg-gray-200/70'
                                  : 'text-gray-300 hover:bg-gray-700/70'
                                }`}
                              title={t('flightList.tagMatchAny', 'Match any selected tag')}
                              aria-pressed={tagFilterMode === 'or'}
                            >
                              OR
                            </button>
                          </div>
                      </div>
                    )}

                    <div className={`rounded-md border px-2 py-2 space-y-2 ${isLight
                      ? 'border-gray-300 bg-transparent'
                      : 'border-gray-700/70 bg-black/15'
                      }`}>
                      <p className="text-[11px] uppercase tracking-wide text-gray-400">{t('flightList.mediaGroup', 'Media')}</p>
                      <div className="grid grid-cols-[minmax(0,1fr)_82px_auto] items-center gap-2">
                        <label className="text-xs text-gray-300" htmlFor="photo-filter-min">{t('flightList.photos', 'Photos')}</label>
                        <input
                          id="photo-filter-min"
                          type="number"
                          min={0}
                          max={mediaMaxima.maxPhotos}
                          step={1}
                          value={photoFilterMin}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            const next = Number.isFinite(raw) ? Math.round(raw) : 0;
                            setPhotoFilterMin(Math.min(mediaMaxima.maxPhotos, Math.max(0, next)));
                          }}
                          className="input text-xs h-7 px-2"
                        />
                        <span className="text-xs text-gray-400 whitespace-nowrap">{t('flightList.orMore', 'or more')}</span>
                      </div>
                      <div className="grid grid-cols-[minmax(0,1fr)_82px_auto] items-center gap-2">
                        <label className="text-xs text-gray-300" htmlFor="video-filter-min">{t('flightList.videos', 'Videos')}</label>
                        <input
                          id="video-filter-min"
                          type="number"
                          min={0}
                          max={mediaMaxima.maxVideos}
                          step={1}
                          value={videoFilterMin}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            const next = Number.isFinite(raw) ? Math.round(raw) : 0;
                            setVideoFilterMin(Math.min(mediaMaxima.maxVideos, Math.max(0, next)));
                          }}
                          className="input text-xs h-7 px-2"
                        />
                        <span className="text-xs text-gray-400 whitespace-nowrap">{t('flightList.orMore', 'or more')}</span>
                      </div>
                    </div>

                    {/* Color filter */}
                    {allFlightColors.length > 1 && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.color', 'Color')}</label>
                        <div className="relative flex-1 min-w-0">
                          <button
                            ref={colorBtnRef}
                            type="button"
                            onClick={() => setIsColorDropdownOpen((v) => !v)}
                            className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
                          >
                            <span className={`truncate flex items-center gap-1 ${selectedColors.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                              {selectedColors.length > 0 ? (
                                <>
                                  {selectedColors.map((c) => (
                                    <span key={c} className="inline-block w-3 h-3 rounded-sm border border-gray-600 flex-shrink-0" style={{ backgroundColor: c }} />
                                  ))}
                                  <span className="ml-1">{selectedColors.length} {t('flightList.selected', 'selected')}</span>
                                </>
                              ) : t('flightList.allColors', 'All Colors')}
                            </span>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                          </button>
                          {isColorDropdownOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-40"
                                onClick={() => setIsColorDropdownOpen(false)}
                              />
                              <div
                                ref={colorDropdownRef}
                                className="fixed z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                                style={(() => { const r = colorBtnRef.current?.getBoundingClientRect(); return r ? { top: r.bottom + 4, left: r.left, width: r.width } : {}; })()}
                              >
                                <div className="overflow-auto flex-1">
                                  {(() => {
                                    // Sort: selected first, then available, then unavailable
                                    const sorted = [...allFlightColors].sort((a, b) => {
                                      const aSelected = selectedColors.includes(a);
                                      const bSelected = selectedColors.includes(b);
                                      const aAvail = availableColors.has(a);
                                      const bAvail = availableColors.has(b);
                                      if (aSelected && !bSelected) return -1;
                                      if (!aSelected && bSelected) return 1;
                                      if (aAvail && !bAvail) return -1;
                                      if (!aAvail && bAvail) return 1;
                                      return a.localeCompare(b);
                                    });
                                    return sorted.map((color, index) => {
                                      const isSelected = selectedColors.includes(color);
                                      const isAvailable = availableColors.has(color);
                                      const isDisabled = !isSelected && !isAvailable;
                                      return (
                                        <button
                                          key={color}
                                          type="button"
                                          onClick={() => {
                                            if (isDisabled) return;
                                            setSelectedColors((prev) =>
                                              isSelected
                                                ? prev.filter((c) => c !== color)
                                                : [...prev, color]
                                            );
                                          }}
                                          onMouseEnter={() => !isDisabled && setColorHighlightedIndex(index)}
                                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isDisabled ? 'opacity-35 cursor-default' : isSelected
                                            ? 'bg-drone-primary/20 text-gray-800 dark:text-drone-primary'
                                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                            } ${!isDisabled && index === colorHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                                        >
                                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-drone-primary bg-drone-primary' : 'border-gray-400 dark:border-gray-600'
                                            }`}>
                                            {isSelected && (
                                              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                            )}
                                          </span>
                                          <span className="w-4 h-4 rounded-sm border border-gray-600 flex-shrink-0" style={{ backgroundColor: color }} />
                                          <span className="font-mono">{color.toUpperCase()}</span>
                                        </button>
                                      );
                                    });
                                  })()}
                                  {selectedColors.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedColors([]);
                                        setIsColorDropdownOpen(false);
                                      }}
                                      className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                                    >
                                      {t('flightList.clearColorFilter', 'Clear color filter')}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}

              </div>
            </div>{/* End scrollable filter fields container */}

            {/* Separator */}
            <div className="border-t border-gray-700/40 -mx-1" />

            {/* Search filter and Sort */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">{t('flightList.search')}</label>
              <div className="relative flex-1 min-w-0">
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t('flightList.searchByName')}
                  className="input w-full text-xs h-8 px-3"
                  aria-label={t('flightList.searchFlights')}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                    aria-label={t('flightList.clearSearch')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                )}
              </div>
              {/* Sort buttons */}
              <div className="relative flex items-center flex-shrink-0">
                <button
                  ref={sortButtonRef}
                  type="button"
                  onClick={() => setIsSortOpen((open) => !open)}
                  className="h-8 w-8 rounded-l-md border border-gray-700/70 bg-drone-dark text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center"
                  aria-label={`Sort flights: ${activeSortLabel}`}
                >
                  <SortIcon />
                </button>
                <button
                  type="button"
                  onClick={() => setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'))}
                  className="h-8 w-7 rounded-r-md border border-l-0 border-gray-700/70 bg-drone-dark text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center"
                  aria-label={`Toggle sort direction: ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
                >
                  <SortDirectionIcon direction={sortDirection} />
                </button>
                {isSortOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setIsSortOpen(false)}
                    />
                    <div
                      ref={sortDropdownRef}
                      tabIndex={-1}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setSortHighlightedIndex(prev => prev < sortOptions.length - 1 ? prev + 1 : 0);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSortHighlightedIndex(prev => prev > 0 ? prev - 1 : sortOptions.length - 1);
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          setSortOption(sortOptions[sortHighlightedIndex].value as typeof sortOption);
                          setIsSortOpen(false);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setIsSortOpen(false);
                        }
                      }}
                      className="themed-select-dropdown absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-gray-700 p-1 shadow-xl outline-none"
                    >
                      {sortOptions.map((option, index) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setSortOption(option.value as typeof sortOption);
                            setIsSortOpen(false);
                          }}
                          onMouseEnter={() => setSortHighlightedIndex(index)}
                          className={`themed-select-option w-full text-left px-3 py-2 text-xs rounded-lg transition-colors ${sortOption === option.value ? 'font-medium' : ''
                            } ${index === sortHighlightedIndex ? 'bg-drone-primary/20' : ''}`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Filtered count and Clear filters on same line */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">
                {t('flightList.logsSelected', { n: filteredFlights.length, total: flights.length })}
              </span>
              <button
                onClick={clearAllFilters}
                className="text-xs text-gray-400 hover:text-white"
              >
                {t('flightList.clearFilters')}
              </button>
            </div>

            {/* Export and Delete Filtered Buttons */}
            <div className="flex items-center gap-2">
              {/* Export Dropdown */}
              <div className="relative flex-1">
                <button
                  onClick={() => setIsExportDropdownOpen(!isExportDropdownOpen)}
                  disabled={filteredFlights.length === 0}
                  className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors w-full ${filteredFlights.length > 0
                    ? 'bg-drone-primary/20 text-drone-primary hover:bg-drone-primary/30'
                    : 'bg-gray-800 text-gray-500 cursor-not-allowed'
                    }`}
                >
                  {t('flightList.exportFiltered')}
                </button>

                {isExportDropdownOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setIsExportDropdownOpen(false)}
                    />
                    <div
                      ref={exportDropdownRef}
                      tabIndex={-1}
                      onKeyDown={(e) => {
                        const exportOptions = [
                          { id: 'csv', label: t('flightList.csv'), ext: 'csv', disabled: false },
                          { id: 'json', label: t('flightList.json'), ext: 'json', disabled: false },
                          { id: 'gpx', label: t('flightList.gpx'), ext: 'gpx', disabled: false },
                          { id: 'kml', label: t('flightList.kml'), ext: 'kml', disabled: false },
                          { id: 'kml_relative', label: t('flightList.kmlRelative'), ext: 'kml', disabled: false },
                          { id: 'summary', label: t('flightList.summaryCSV'), ext: 'csv', disabled: filteredFlights.length <= 1 },
                          {
                            id: 'html_report',
                            label: t('flightList.htmlReport'),
                            ext: 'html',
                            disabled: isHtmlReportExportDisabled,
                            tooltip: isHtmlReportExportDisabled ? htmlReportDisabledTooltip : undefined,
                          },
                        ];
                        const enabledOptions = exportOptions.filter(o => !o.disabled);
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setExportHighlightedIndex(prev => {
                            let next = prev + 1;
                            while (next < exportOptions.length && exportOptions[next].disabled) next++;
                            return next >= exportOptions.length ? enabledOptions.length > 0 ? exportOptions.findIndex(o => !o.disabled) : 0 : next;
                          });
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setExportHighlightedIndex(prev => {
                            let next = prev - 1;
                            while (next >= 0 && exportOptions[next].disabled) next--;
                            if (next < 0) {
                              // Find last enabled option
                              for (let i = exportOptions.length - 1; i >= 0; i--) {
                                if (!exportOptions[i].disabled) return i;
                              }
                              return 0;
                            }
                            return next;
                          });
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          const opt = exportOptions[exportHighlightedIndex];
                          if (!opt.disabled) {
                            setIsExportDropdownOpen(false);
                            if (opt.id === 'html_report') {
                              setShowHtmlReportModal(true);
                            } else if (opt.id === 'summary') {
                              handleSummaryExport();
                            } else {
                              handleBulkExport(opt.id, opt.ext);
                            }
                          }
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setIsExportDropdownOpen(false);
                        }
                      }}
                      className={`themed-select-dropdown absolute left-0 ${isMobileRuntime ? 'bottom-full mb-2' : 'top-full mt-2'} w-full border border-gray-700 rounded-lg shadow-xl z-50 outline-none`}
                    >
                      <div className="p-2">
                        {[
                          { id: 'csv', label: t('flightList.csv'), ext: 'csv', disabled: false },
                          { id: 'json', label: t('flightList.json'), ext: 'json', disabled: false },
                          { id: 'gpx', label: t('flightList.gpx'), ext: 'gpx', disabled: false },
                          { id: 'kml', label: t('flightList.kml'), ext: 'kml', disabled: false },
                          { id: 'kml_relative', label: t('flightList.kmlRelative'), ext: 'kml', disabled: false },
                          { id: 'summary', label: t('flightList.summaryCSV'), ext: 'csv', disabled: filteredFlights.length <= 1 },
                          {
                            id: 'html_report',
                            label: t('flightList.htmlReport'),
                            ext: 'html',
                            disabled: isHtmlReportExportDisabled,
                            tooltip: isHtmlReportExportDisabled ? htmlReportDisabledTooltip : undefined,
                          },
                        ].map((opt, index) => (
                          <button
                            key={opt.id}
                            onClick={() => {
                              if (opt.disabled) return;
                              setIsExportDropdownOpen(false);
                              if (opt.id === 'html_report') {
                                setShowHtmlReportModal(true);
                              } else if (opt.id === 'summary') {
                                handleSummaryExport();
                              } else {
                                handleBulkExport(opt.id, opt.ext);
                              }
                            }}
                            onMouseEnter={() => !opt.disabled && setExportHighlightedIndex(index)}
                            disabled={opt.disabled}
                            title={opt.tooltip}
                            className={`themed-select-option w-full text-left px-3 py-2 text-sm rounded transition-colors ${opt.disabled
                              ? 'text-gray-500 cursor-not-allowed'
                              : index === exportHighlightedIndex ? 'bg-drone-primary/20' : ''
                              }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Delete Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmBulkDelete(true);
                }}
                disabled={filteredFlights.length === 0}
                className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex-1 ${filteredFlights.length > 0
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
                  }`}
              >
                {t('flightList.deleteFiltered')}
              </button>
            </div>

            {/* Bulk Delete Confirmation */}
            {confirmBulkDelete && filteredFlights.length > 0 && (
              <div
                className="flex items-center gap-2 text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-gray-400">
                  {t('flightList.deleteFilteredConfirm', { n: filteredFlights.length })}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBulkDelete();
                  }}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  {t('flightList.yes')}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmBulkDelete(false);
                  }}
                  className="text-xs text-gray-400 hover:text-gray-200"
                >
                  {t('flightList.cancel')}
                </button>
              </div>
            )}

            {/* Untag and Bulk Tag Buttons */}
            <div className="flex items-center gap-2">
              {/* Untag Filtered Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmUntag(true);
                }}
                disabled={filteredFlights.length === 0 || selectedTags.length === 0}
                className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex-1 ${filteredFlights.length > 0 && selectedTags.length > 0
                  ? 'bg-orange-500/20 text-orange-600 hover:bg-orange-500/30'
                  : 'bg-gray-500/10 text-gray-400 cursor-not-allowed'
                  }`}
              >
                {t('flightList.untagFiltered')}
              </button>

              {/* Bulk Tag Filtered Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowBulkTagInput(true);
                }}
                disabled={filteredFlights.length === 0}
                className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex-1 ${filteredFlights.length > 0
                  ? 'bg-violet-500/20 text-violet-600 hover:bg-violet-500/30'
                  : 'bg-gray-500/10 text-gray-400 cursor-not-allowed'
                  }`}
              >
                {t('flightList.bulkTagFiltered')}
              </button>
            </div>

            {/* Untag Confirmation */}
            {confirmUntag && filteredFlights.length > 0 && selectedTags.length > 0 && (
              <div
                className="flex items-center gap-2 text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-gray-400">
                  {t('flightList.removeTagConfirm', { tags: selectedTags.join(', ') })}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBulkUntag();
                  }}
                  className="text-xs text-orange-400 hover:text-orange-300"
                >
                  {t('flightList.yes')}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmUntag(false);
                  }}
                  className="text-xs text-gray-400 hover:text-gray-200"
                >
                  {t('flightList.cancel')}
                </button>
              </div>
            )}

            {/* Bulk Tag Input */}
            {showBulkTagInput && filteredFlights.length > 0 && (
              <div
                className="flex items-center gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={bulkTagInput}
                  onChange={(e) => setBulkTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleBulkTag();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowBulkTagInput(false);
                      setBulkTagInput('');
                    }
                  }}
                  placeholder={t('flightList.enterTagName')}
                  autoFocus
                  className="input flex-1 text-xs h-7 px-2"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBulkTag();
                  }}
                  className="text-xs text-violet-400 hover:text-violet-300"
                >
                  {t('flightList.ok')}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowBulkTagInput(false);
                    setBulkTagInput('');
                  }}
                  className="text-xs text-gray-400 hover:text-gray-200"
                >
                  {t('flightList.cancel')}
                </button>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Scrollable flight list */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-700/50">
        {sortedFlights.map((flight) => (
          <div
            key={flight.id}
            data-flight-id={flight.id}
            onContextMenu={(e) => handleContextMenu(e, flight.id)}
            onClick={(e) => {
              setPreviewFlightId(null);
              // CTRL+click (or Cmd+click on Mac) always navigates to flight details
              if (e.ctrlKey || e.metaKey) {
                setOverviewHighlightedFlightId(null);
                selectFlight(flight.id);
                onSelectFlight?.(flight.id);
                return;
              }
              if (activeView === 'overview') {
                // Single click in overview mode: scroll to map then highlight
                const mapElement = document.getElementById('overview-cluster-map');
                if (mapElement) {
                  smoothScrollToElement(mapElement, 800).then(() => {
                    setOverviewHighlightedFlightId(flight.id);
                    onHighlightFlight?.(flight.id);
                  });
                } else {
                  setOverviewHighlightedFlightId(flight.id);
                  onHighlightFlight?.(flight.id);
                }
              } else {
                // Single click in flights mode: select and load flight
                selectFlight(flight.id);
                onSelectFlight?.(flight.id);
              }
            }}
            onDoubleClick={() => {
              if (activeView === 'overview') {
                // Double click in overview mode: navigate to flight details
                setOverviewHighlightedFlightId(null);
                selectFlight(flight.id);
                onSelectFlight?.(flight.id);
              }
              // In flights mode, double-click does nothing extra (single click already loads)
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                if (activeView === 'overview') {
                  // Enter in overview mode: navigate to flight details
                  setOverviewHighlightedFlightId(null);
                }
                selectFlight(flight.id);
                onSelectFlight?.(flight.id);
              }
            }}
            className={`w-full text-left cursor-pointer transition-colors duration-150 flex select-none ${(activeView === 'overview'
              ? overviewHighlightedFlightId === flight.id
              : (selectedFlightId === flight.id || previewFlightId === flight.id))
              ? 'bg-drone-primary/20'
              : 'hover:bg-gray-700/30'
              }`}
          >
            {/* Color bar */}
            <div
              className={`w-1 flex-shrink-0 rounded-r-sm transition-colors ${(activeView === 'overview'
                ? overviewHighlightedFlightId === flight.id
                : (selectedFlightId === flight.id || previewFlightId === flight.id))
                ? '' : ''}`}
              style={{ backgroundColor: flight.color ?? '#7dd3fc' }}
            />
            <div className="flex-1 min-w-0 px-2.5 py-2">
              {/* Rename mode */}
              {editingId === flight.id ? (
                <div>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="input h-7 text-sm px-2 w-full"
                    placeholder={t('flightList.flightName')}
                  />
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const name = draftName.trim();
                        if (name.length > 0) {
                          updateFlightName(flight.id, name);
                        }
                        setEditingId(null);
                      }}
                      className="text-xs text-drone-primary"
                    >
                      {t('flightList.save')}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(null);
                      }}
                      className="text-xs text-gray-400"
                    >
                      {t('flightList.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-1">
                  <p
                    className="text-sm text-gray-300 truncate flex-1 min-w-0"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingId(flight.id);
                      setDraftName(flight.displayName || flight.fileName);
                      setConfirmDeleteId(null);
                    }}
                    title={[
                      flight.displayName || flight.fileName,
                      `Start: ${formatDateTime(flight.startTime, dateLocale, appLanguage, hour12)}`,
                      `Duration: ${formatDuration(flight.durationSecs)}`,
                      `Distance: ${formatDistance(flight.totalDistance, unitPrefs.distance, locale)}`,
                      `Max Altitude: ${formatAltitude(flight.maxAltitude, unitPrefs.altitude, locale)}`,
                      flight.notes ? `Notes: ${flight.notes}` : null
                    ].filter(Boolean).join('\n')}
                  >
                    {flight.displayName || flight.fileName}
                  </p>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(flight.id);
                        setDraftName(flight.displayName || flight.fileName);
                        setConfirmDeleteId(null);
                      }}
                      className="p-0.5 text-drone-primary hover:text-drone-primary"
                      title={t('flightList.renameFlight')}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(flight.id);
                      }}
                      className="p-0.5 text-red-400 hover:text-red-300"
                      title={t('flightList.deleteFlight')}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              )}

              {/* Subtitle: date + duration */}
              {editingId !== flight.id && (
                <p className="ui-metadata text-xs text-gray-500 mt-0.5 truncate">
                  {formatDateTime(flight.startTime, dateLocale, appLanguage, hour12)}
                  {flight.durationSecs ? ` · ${formatDuration(flight.durationSecs)}` : ''}
                  {flight.totalDistance ? ` · ${formatDistance(flight.totalDistance, unitPrefs.distance, locale)}` : ''}
                </p>
              )}

              {/* Delete confirmation */}
              {confirmDeleteId === flight.id && editingId !== flight.id && (
                <div className="flex items-center gap-2 mt-1 text-xs">
                  <span className="text-gray-400">{t('flightList.deleteConfirm')}</span>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      // Add to blacklist before deleting (so sync won't re-import)
                      if (flight.fileHash) {
                        await addToBlacklist(flight.fileHash);
                      }
                      await deleteFlight(flight.id);
                      setConfirmDeleteId(null);
                    }}
                    className="text-red-400"
                  >
                    {t('flightList.yes')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                    }}
                    className="text-gray-400"
                  >
                    {t('flightList.no')}
                  </button>
                </div>
              )}
            </div>{/* end of flex-1 inner content */}
          </div>
        ))}
        {sortedFlights.length === 0 && (
          <div className="p-4 text-center text-gray-500 text-xs">
            {t('flightList.noFlightsMatch')}
          </div>
        )}
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[9999] min-w-[180px] py-1 rounded-lg border border-gray-700 bg-drone-surface shadow-xl"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Rename */}
          <button
            type="button"
            onClick={() => handleContextRename(contextMenu.flightId)}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700/50 flex items-center gap-2"
          >
            <svg className="w-4 h-4 text-drone-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            {t('flightList.rename')}
          </button>

          {/* Add/Edit Notes */}
          <button
            type="button"
            onClick={() => handleContextAddNotes(contextMenu.flightId)}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700/50 flex items-center gap-2"
          >
            <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {flights.find(f => f.id === contextMenu.flightId)?.notes ? t('flightList.editNotes') : t('flightList.addNotes')}
          </button>

          {/* Edit Color */}
          <button
            type="button"
            onClick={() => {
              setColorPickerFlightId(contextMenu.flightId);
              setColorPickerPosition({
                x: contextMenu.x,
                y: contextMenu.y,
                boundsLeft: contextMenu.boundsLeft,
                boundsRight: contextMenu.boundsRight,
                centerHorizontally: true,
              });
              setContextMenu(null);
            }}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700/50 flex items-center gap-2"
          >
            <svg className="w-4 h-4 text-drone-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
            </svg>
            {t('flightList.editColor', 'Edit Color')}
          </button>

          {/* Delete */}
          <button
            type="button"
            onClick={() => handleContextDelete(contextMenu.flightId)}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700/50 flex items-center gap-2"
          >
            <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {t('flightList.delete')}
          </button>

          {/* Divider */}
          <div className="my-1 border-t border-gray-700" />

          {/* Regenerate Smart Tags */}
          <button
            type="button"
            onClick={() => handleContextRegenerateTags(contextMenu.flightId)}
            disabled={isRegeneratingTags}
            className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700/50 flex items-center gap-2 disabled:opacity-50"
          >
            <svg className="w-4 h-4 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {t('flightList.regenerateSmartTags')}
          </button>

          {/* Generate FlyCard */}
          <button
            type="button"
            onClick={() => activeView !== 'overview' && handleContextGenerateFlyCard(contextMenu.flightId)}
            disabled={activeView === 'overview'}
            className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 ${activeView === 'overview'
              ? 'text-gray-500 cursor-not-allowed'
              : 'text-gray-300 hover:bg-gray-700/50'
              }`}
            title={activeView === 'overview' ? 'Select a flight first to generate FlyCard' : undefined}
          >
            <svg className={`w-4 h-4 ${activeView === 'overview' ? 'text-gray-600' : 'text-orange-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {t('flightList.generateFlyCard')}
          </button>

          {/* Divider */}
          <div className="my-1 border-t border-gray-700" />

          {/* Export submenu */}
          <div className="relative">
            {contextExportSubmenuOpen && (
              <div className="absolute left-2 right-2 bottom-full mb-1 py-1 rounded-lg border border-gray-700 bg-drone-surface/95 backdrop-blur-sm shadow-xl z-10">
                <button
                  type="button"
                  onClick={() => handleContextExport(contextMenu.flightId, 'csv')}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700/50"
                >
                  {t('flightList.csv')}
                </button>
                <button
                  type="button"
                  onClick={() => handleContextExport(contextMenu.flightId, 'json')}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700/50"
                >
                  {t('flightList.json')}
                </button>
                <button
                  type="button"
                  onClick={() => handleContextExport(contextMenu.flightId, 'gpx')}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700/50"
                >
                  {t('flightList.gpx')}
                </button>
                <button
                  type="button"
                  onClick={() => handleContextExport(contextMenu.flightId, 'kml')}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700/50"
                >
                  {t('flightList.kml')}
                </button>
                <button
                  type="button"
                  onClick={() => handleContextExport(contextMenu.flightId, 'kml_relative')}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700/50"
                >
                  {t('flightList.kmlRelative')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setContextMenu(null);
                    setContextExportSubmenuOpen(false);
                    setContextHtmlReportFlightId(contextMenu.flightId);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700/50"
                >
                  {t('flightList.htmlReport')}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setContextExportSubmenuOpen((open) => !open)}
              className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700/50 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {t('flightList.export')}
              </span>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {contextExportSubmenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 15l6-6 6 6" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
                )}
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Color Picker Modal */}
      <ColorPickerModal
        isOpen={colorPickerFlightId !== null}
        currentColor={flights.find(f => f.id === colorPickerFlightId)?.color ?? '#7dd3fc'}
        position={colorPickerPosition}
        onSelect={(color) => {
          if (colorPickerFlightId !== null) {
            updateFlightColor(colorPickerFlightId, color);
          }
        }}
        onClose={() => {
          setColorPickerFlightId(null);
          setColorPickerPosition(undefined);
        }}
      />

      {/* Regenerating Tags Overlay */}
      {isRegeneratingTags && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[280px] shadow-2xl text-center">
            <svg className="w-8 h-8 text-teal-400 animate-spin mx-auto mb-3" fill="none" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <p className="text-sm text-gray-300">{t('flightList.regeneratingSmartTags')}</p>
          </div>
        </div>
      )}

      {/* Export Progress Overlay */}
      {isExporting && renderGlobalOverlay(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">{t('flightList.exportingFlights')}</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>{t('flightList.progress')}</span>
                <span>{exportProgress.done} / {exportProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-drone-primary transition-all duration-300"
                  style={{ width: `${(exportProgress.done / exportProgress.total) * 100}%` }}
                />
              </div>
              {exportProgress.currentFile && (
                <div className="text-xs text-gray-500 truncate">
                  {t('flightList.current')} {exportProgress.currentFile}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Progress Overlay */}
      {isDeleting && renderGlobalOverlay(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">{t('flightList.deletingFlights')}</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>{t('flightList.progress')}</span>
                <span>{deleteProgress.done} / {deleteProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-red-500 transition-all duration-300"
                  style={{ width: `${(deleteProgress.done / deleteProgress.total) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Untag Progress Overlay */}
      {isUntagging && renderGlobalOverlay(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">{t('flightList.removingTags')}</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>{t('flightList.progress')}</span>
                <span>{untagProgress.done} / {untagProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-orange-500 transition-all duration-300"
                  style={{ width: `${untagProgress.total > 0 ? (untagProgress.done / untagProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Tag Progress Overlay */}
      {isBulkTagging && renderGlobalOverlay(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">{t('flightList.addingTags')}</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>{t('flightList.progress')}</span>
                <span>{bulkTagProgress.done} / {bulkTagProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-violet-500 transition-all duration-300"
                  style={{ width: `${bulkTagProgress.total > 0 ? (bulkTagProgress.done / bulkTagProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FlyCard Generator Modal */}
      {flyCardFlightId && (() => {
        const flyCardFlight = flights.find(f => f.id === flyCardFlightId);
        if (!flyCardFlight) return null;
        return (
          <FlyCardGenerator
            flight={flyCardFlight}
            unitPrefs={unitPrefs}
            onClose={() => setFlyCardFlightId(null)}
          />
        );
      })()}

      {/* FlyCard Pending Overlay - shown while waiting for flight to load */}
      {flyCardPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-dark rounded-xl p-6 shadow-xl border border-gray-700 text-center">
            <svg className="w-10 h-10 text-drone-primary animate-spin mx-auto mb-3" fill="none" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <p className="text-white font-medium">{t('flightList.loadingFlightMap')}</p>
            <p className="text-gray-400 text-sm mt-1">{t('flightList.preparingFlyCard')}</p>
          </div>
        </div>
      )}

      {/* Notes Modal */}
      {notesModalFlightId !== null && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center p-4 overflow-y-auto bg-black/50 backdrop-blur-sm"
          onClick={() => {
            setNotesModalFlightId(null);
            setNotesInput('');
          }}
        >
          <div
            className="bg-drone-dark rounded-xl p-5 shadow-xl border border-gray-700 w-[400px] max-w-[90vw] my-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-white font-medium mb-3 flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {flights.find(f => f.id === notesModalFlightId)?.notes ? t('flightList.editNotesHeading') : t('flightList.addNotesHeading')}
            </h3>
            <textarea
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value.slice(0, 500))}
              placeholder={t('flightList.addNotePlaceholder')}
              className={`w-full h-32 px-3 py-2 rounded-lg bg-drone-surface border border-gray-700 text-sm placeholder-gray-500 resize-none focus:outline-none focus:border-drone-primary ${isLight ? 'text-gray-800' : 'text-gray-200'}`}
              autoFocus
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-gray-500">{notesInput.length}/500</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setNotesModalFlightId(null);
                    setNotesInput('');
                  }}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  {t('flightList.cancel')}
                </button>
                <button
                  onClick={handleSaveNotes}
                  className="px-4 py-1.5 text-sm bg-drone-primary text-white rounded-lg hover:bg-drone-primary/80 transition-colors"
                >
                  {t('flightList.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* HTML Report Modal (bulk / export filtered) */}
      <HtmlReportModal
        isOpen={showHtmlReportModal}
        onClose={() => setShowHtmlReportModal(false)}
        onGenerate={handleHtmlReportExport}
        flightCount={filteredFlights.length}
      />

      {/* HTML Report Modal (context menu single flight) */}
      <HtmlReportModal
        isOpen={contextHtmlReportFlightId !== null}
        onClose={() => setContextHtmlReportFlightId(null)}
        onGenerate={handleContextHtmlReportExport}
        flightCount={1}
      />
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 6h10M3 12h14M3 18h18"
      />
    </svg>
  );
}

function SortDirectionIcon({ direction }: { direction: 'asc' | 'desc' }) {
  const rotation = direction === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      style={{ transform: rotation }}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );
}
