/**
 * Main Dashboard layout component
 * Orchestrates the flight list sidebar, charts, and map
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFlightStore } from '@/stores/flightStore';
import { FlightList } from './FlightList';
import {
  FlightImporter,
  getSyncFolderPath,
  normalizeSyncFolderPath,
  setSyncFolderPath,
} from './FlightImporter';
import { FlightStats } from './FlightStats';
import { SettingsModal } from './SettingsModal';
import { TelemetryCharts } from '@/components/charts/TelemetryCharts';
import { FlightMap } from '@/components/map/FlightMap';
import { FlightMessagesModal } from './FlightMessagesModal';
import { Overview } from './Overview';
import { ProfileSelector } from './ProfileSelector';
import { isWebMode } from '@/lib/api';
import { useIsMobileRuntime } from '@/hooks/platform/useIsMobileRuntime';

export function Dashboard() {
  const isMobileRuntime = useIsMobileRuntime();
  const {
    currentFlightData,
    overviewStats,
    isLoading,
    flights,
    isFlightsInitialized,
    selectedFlightId,
    unitPrefs,
    themeMode,
    loadOverview,
    supporterBadgeActive,
    checkForUpdates,
    updateStatus,
    latestVersion,
    isImporting,
    isBatchProcessing,
  } = useFlightStore();
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const [showMessagesModal, setShowMessagesModal] = useState(false);
  const [activeView, setActiveView] = useState<'flights' | 'overview'>('overview');
  const [topSidebarFlightId, setTopSidebarFlightId] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('sidebarWidth');
      if (stored) {
        const parsed = Number(stored);
        if (parsed >= 340 && parsed <= 420) return parsed;
      }
    }
    return 340;
  });
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  // Start with null, determine collapsed state after flights are loaded from DB
  const [isImporterCollapsed, setIsImporterCollapsed] = useState<boolean | null>(null);
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('filtersCollapsed');
      if (stored !== null) return stored === 'true';
    }
    return true;
  });
  const [mainSplit, setMainSplit] = useState(50);
  const [mainPanelsWidth, setMainPanelsWidth] = useState(0);
  // Track if telemetry panel is collapsed (slider pulled past minimum width)
  const [isTelemetryCollapsed, setIsTelemetryCollapsed] = useState(false);
  const [preCollapseSplit, setPreCollapseSplit] = useState<number | null>(null);
  const [isImporterExternallyBusy, setIsImporterExternallyBusy] = useState(false);
  // Width of telemetry panel when collapsed (minimum visible width)
  const TELEMETRY_MIN_VISIBLE_WIDTH = 40;
  const TELEMETRY_MIN_NORMAL_WIDTH = 560;
  const TELEMETRY_SCROLL_MIN_WIDTH = 560;
  const TELEMETRY_CARD_MIN_WIDTH = 520;
  const MAP_MIN_WIDTH = 320;
  const MAP_STACK_TRIGGER_WIDTH = 420;
  const SIDE_BY_SIDE_MIN_WIDTH = TELEMETRY_MIN_NORMAL_WIDTH + MAP_STACK_TRIGGER_WIDTH + 48;
  const resizingRef = useRef<null | 'sidebar' | 'main'>(null);

  // On initial load, collapse importer if there are flights, expand if empty
  // Wait until isFlightsInitialized is true (flights have been loaded from DB)
  useEffect(() => {
    if (isFlightsInitialized && isImporterCollapsed === null) {
      // Flights have been loaded from DB: collapse if flights exist, expand if empty
      setIsImporterCollapsed(flights.length > 0);
    }
  }, [isFlightsInitialized, flights.length, isImporterCollapsed]);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sidebarWidth', String(sidebarWidth));
    }
  }, [sidebarWidth]);

  // Check for app updates on mount.
  // In web mode, also re-check on browser refresh (no dependency array change needed
  // since the component remounts on page reload). Using a timestamp ensures fresh check.
  useEffect(() => {
    // For web/Docker mode, we want to check on every page load (browser refresh),
    // not just on initial mount. The component remounts on refresh anyway.
    checkForUpdates();
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (resizingRef.current === 'sidebar') {
        const nextWidth = Math.min(Math.max(event.clientX, 340), 420);
        setSidebarWidth(nextWidth);
      }
      if (resizingRef.current === 'main') {
        const container = document.getElementById('main-panels');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const percentage = ((event.clientX - rect.left) / rect.width) * 100;
        const minLeftPercent = (TELEMETRY_MIN_VISIBLE_WIDTH / rect.width) * 100;
        const maxLeftPercent = 100 - (MAP_MIN_WIDTH / rect.width) * 100;

        // Calculate the actual pixel width the telemetry panel would be
        const telemetryPixelWidth = (percentage / 100) * rect.width;

        // If dragging below normal minimum, collapse the telemetry panel
        if (telemetryPixelWidth < TELEMETRY_MIN_NORMAL_WIDTH) {
          setIsTelemetryCollapsed(true);
        } else {
          setIsTelemetryCollapsed(false);
        }

        setMainSplit(
          Math.min(Math.max(percentage, minLeftPercent), maxLeftPercent)
        );
      }
    };

    const handleMouseUp = () => {
      resizingRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    const container = document.getElementById('main-panels');
    if (!container) {
      setMainPanelsWidth(0);
      return;
    }

    const updateWidth = () => {
      const host = container.parentElement;
      const availableWidth = host
        ? host.getBoundingClientRect().width
        : container.getBoundingClientRect().width;
      setMainPanelsWidth(availableWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(container);

    window.addEventListener('resize', updateWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [activeView, currentFlightData?.flight.id, isSidebarHidden, sidebarWidth]);

  const isDesktopLayout = typeof window !== 'undefined' && window.innerWidth >= 768;
  const shouldStackPanels = isDesktopLayout && mainPanelsWidth > 0
    ? mainPanelsWidth < SIDE_BY_SIDE_MIN_WIDTH
    : !isDesktopLayout;
  const splitCardsViewportHeight = isDesktopLayout && !shouldStackPanels
    ? 'calc(100dvh - 200px)'
    : undefined;

  // Apply theme class on mount and listen for system preference changes.
  // The store's setThemeMode already applies classes synchronously for instant switching;
  // this effect only handles initial mount + OS-level dark/light changes.
  useEffect(() => {
    const applyTheme = (mode: 'system' | 'dark' | 'light') => {
      const prefersDark =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : true;
      const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
      document.body.classList.remove('theme-dark', 'theme-light');
      document.body.classList.add(resolved === 'dark' ? 'theme-dark' : 'theme-light');
    };

    // Ensure correct class on initial mount
    applyTheme(themeMode);

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        // Only react to OS changes when in 'system' mode
        const current = useFlightStore.getState().themeMode;
        if (current === 'system') applyTheme('system');
      };
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
    return undefined;
  }, []);  // Run once on mount — store setter handles subsequent changes synchronously

  useEffect(() => {
    const handleImporterBusyChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ busy?: boolean }>;
      setIsImporterExternallyBusy(Boolean(customEvent.detail?.busy));
    };
    window.addEventListener('importerBusyStateChanged', handleImporterBusyChange as EventListener);
    return () => {
      window.removeEventListener('importerBusyStateChanged', handleImporterBusyChange as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleFiltersCollapsedChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ collapsed?: boolean }>;
      if (typeof customEvent.detail?.collapsed === 'boolean') {
        setIsFiltersCollapsed(customEvent.detail.collapsed);
      }
    };

    window.addEventListener('sidebarFiltersCollapsedChanged', handleFiltersCollapsedChange as EventListener);
    return () => {
      window.removeEventListener('sidebarFiltersCollapsedChanged', handleFiltersCollapsedChange as EventListener);
    };
  }, []);

  useEffect(() => {
    if (activeView === 'overview') {
      loadOverview();
    }
  }, [activeView, loadOverview]);

  const appIcon = new URL('../../assets/icon.png', import.meta.url).href;
  const isImporterBusy = isImporting || isBatchProcessing || isImporterExternallyBusy;
  const sidebarMinHeight = 620
    + (isImporterCollapsed === false ? 120 : 0)
    + (!isFiltersCollapsed ? 180 : 0);

  return (
    <div className={`flex h-full ${showSettings ? 'modal-open' : ''}`}>
      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Left Sidebar - Flight List */}
      <aside
        className={`bg-drone-secondary md:border-r border-gray-700 flex flex-col z-50 fixed inset-0 md:relative md:inset-auto mobile-safe-container h-full overflow-y-auto overflow-x-hidden transition-[width,min-width,opacity,transform] duration-300 ease-in-out ${isSidebarHidden ? 'opacity-0 pointer-events-none md:overflow-hidden' : 'opacity-100'
          }`}
        style={{
          // In desktop layout, avoid safe-area padding so width:0 truly collapses.
          paddingTop: isDesktopLayout ? 0 : undefined,
          paddingRight: isDesktopLayout ? 0 : undefined,
          paddingBottom: isDesktopLayout ? 0 : undefined,
          paddingLeft: isDesktopLayout ? 0 : undefined,
          width: typeof window !== 'undefined' && window.innerWidth < 768
            ? '100%'
            : (isSidebarHidden ? 0 : sidebarWidth),
          minWidth: typeof window !== 'undefined' && window.innerWidth < 768
            ? '100%'
            : (isSidebarHidden ? 0 : 340),
          transform: isSidebarHidden
            ? (typeof window !== 'undefined' && window.innerWidth < 768
              ? 'translateX(-100%)'
              : `translateX(-${sidebarWidth}px)`)
            : 'translateX(0)',
        }}
      >
          <div className={`flex h-full flex-col md:transition-opacity md:duration-150 ${isSidebarHidden ? 'md:opacity-0' : 'md:opacity-100'}`} style={{ minHeight: sidebarMinHeight }}>
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                <img
                  src={appIcon}
                  alt={t('app.title')}
                  className="w-6 h-6 rounded-md"
                  loading="lazy"
                  decoding="async"
                />
                {t('app.title')}
              </h1>
              <p className="text-xs text-gray-400 mt-1">
                {t('app.subtitle')}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Supporter Badge */}
              {supporterBadgeActive && (
                <div className="supporter-badge hidden md:block" title={t('dashboard.verifiedSupporter')}>
                  <div className="flex items-center justify-center w-9 h-9 rounded-md">
                    <svg className="w-8 h-8 supporter-star" viewBox="0 0 100 120" fill="none">
                      {/* Chevron body */}
                      <path d="M50 115L5 65L20 45L50 70L80 45L95 65Z" fill="url(#badge-grad)" />
                      {/* Wings */}
                      <path d="M15 55L50 85L85 55L75 40L50 60L25 40Z" fill="url(#badge-grad)" opacity="0.7" />
                      {/* Star */}
                      <path d="M50 2L56.5 18L74 18L60 28L65 45L50 35L35 45L40 28L26 18L43.5 18Z" fill="url(#star-grad)" />
                      <defs>
                        <linearGradient id="badge-grad" x1="50" y1="40" x2="50" y2="115" gradientUnits="userSpaceOnUse">
                          <stop offset="0%" stopColor="#f59e0b" />
                          <stop offset="100%" stopColor="#d97706" />
                        </linearGradient>
                        <linearGradient id="star-grad" x1="50" y1="2" x2="50" y2="45" gradientUnits="userSpaceOnUse">
                          <stop offset="0%" stopColor="#fbbf24" />
                          <stop offset="100%" stopColor="#f59e0b" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                </div>
              )}
              {/* Settings Button */}
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                title={t('dashboard.settings')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <button
                onClick={() => setIsSidebarHidden(true)}
                className="ml-1 bg-drone-secondary border border-gray-700 rounded-full w-6 h-6 flex items-center justify-center text-gray-300 hover:text-white hidden md:flex"
                title={t('dashboard.hideSidebar')}
              >
                <span className="leading-none pb-[2px] text-lg">‹</span>
              </button>
            </div>
          </div>

          {/* View Toggle */}
          <div className="px-4 py-2 border-b border-gray-700">
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (activeView === 'overview' && selectedFlightId === null && topSidebarFlightId !== null) {
                    useFlightStore.getState().selectFlight(topSidebarFlightId);
                  }
                  setActiveView('flights');
                  // Clear highlighted flight when switching to flights view
                  useFlightStore.getState().setOverviewHighlightedFlightId(null);
                  if (typeof window !== 'undefined' && window.innerWidth < 768) {
                    setIsSidebarHidden(true);
                  }
                }}
                className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${activeView === 'flights'
                  ? 'bg-drone-primary/20 border-drone-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
                  }`}
              >
                {t('dashboard.individual')}
              </button>
              <button
                onClick={() => {
                  setActiveView('overview');
                  if (typeof window !== 'undefined' && window.innerWidth < 768) {
                    setIsSidebarHidden(true);
                  }
                }}
                className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${activeView === 'overview'
                  ? 'bg-drone-primary/20 border-drone-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
                  }`}
              >
                {t('dashboard.overview')}
              </button>
              <ProfileSelector />
            </div>
          </div>

          {/* Flight Importer */}
          <div className="border-b border-gray-700 flex-shrink-0">
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsImporterCollapsed((v) => {
                    const next = !v;
                    if (!next) window.dispatchEvent(new CustomEvent('collapseFilters'));
                    return next;
                  })}
                  className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors"
                >
                  <span className={`font-medium ${isImporterBusy ? 'text-emerald-400' : ''}`}>
                    {isImporterBusy
                      ? (isImporterCollapsed !== false ? t('dashboard.importingExpand') : t('dashboard.importing'))
                      : (isImporterCollapsed !== false ? t('dashboard.importExpand') : t('dashboard.import'))}
                  </span>
                </button>
                {isImporterBusy && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.dispatchEvent(new CustomEvent('cancelImporterAction'));
                    }}
                    className="w-4 h-4 rounded-full text-red-400 hover:text-red-300 hover:bg-red-500/10 flex items-center justify-center"
                    title="Cancel import/sync"
                    aria-label="Cancel import/sync"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Sync Folder Config Button (desktop only) */}
                {!isWebMode() && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (isMobileRuntime) {
                        window.dispatchEvent(new CustomEvent('requestMobileSyncFolderSelection'));
                        return;
                      }
                      try {
                        const { open } = await import('@tauri-apps/plugin-dialog');
                        const selected = await open({
                          directory: true,
                          multiple: false,
                          title: t('dashboard.selectSyncFolder'),
                        });
                        const selectedFolder =
                          typeof selected === 'string'
                            ? selected
                            : Array.isArray(selected) && typeof selected[0] === 'string'
                            ? selected[0]
                            : null;
                        if (selectedFolder) {
                          setSyncFolderPath(normalizeSyncFolderPath(selectedFolder));
                          // Force re-render by triggering a state update
                          window.dispatchEvent(new CustomEvent('syncFolderChanged'));
                        }
                      } catch (e) {
                        console.error('Failed to select sync folder:', e);
                      }
                    }}
                    className={`p-1.5 rounded transition-colors ${getSyncFolderPath()
                      ? 'text-emerald-500 hover:text-emerald-400 dark:text-emerald-400 dark:hover:text-emerald-300 hover:bg-emerald-500/10'
                      : 'text-red-400 hover:text-red-300 dark:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10'
                      }`}
                    title={getSyncFolderPath() ? `Sync folder: ${getSyncFolderPath()}` : t('dashboard.configureSyncFolder')}
                  >
                    {getSyncFolderPath() ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    )}
                  </button>
                )}
                {/* Collapse/Expand Button */}
                <span
                  onClick={() => setIsImporterCollapsed((v) => {
                    const next = !v;
                    if (!next) window.dispatchEvent(new CustomEvent('collapseFilters'));
                    return next;
                  })}
                  className={`w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center transition-transform duration-200 cursor-pointer hover:border-gray-500 ${isImporterCollapsed !== false ? 'rotate-180' : ''
                    }`}
                  title={isImporterCollapsed !== false ? 'Expand' : 'Collapse'}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                </span>
              </div>
            </div>
            <div
              className={`transition-all duration-200 ease-in-out ${isImporterCollapsed !== false ? 'max-h-0 overflow-hidden opacity-0' : 'max-h-[300px] overflow-visible opacity-100'
                }`}
            >
              <div className="px-3 pb-3">
                <FlightImporter />
              </div>
            </div>
          </div>

          {/* Flight List */}
          <div className="flex-1 min-h-0 flex flex-col">
            <FlightList
              activeView={activeView}
              onTopFlightChange={setTopSidebarFlightId}
              onFiltersExpanded={() => setIsImporterCollapsed(true)}
              onSelectFlight={(flightId) => {
                // Clear the overview highlight when navigating to a flight
                useFlightStore.getState().setOverviewHighlightedFlightId(null);
                setActiveView('flights');
                useFlightStore.getState().selectFlight(flightId);
                if (typeof window !== 'undefined' && window.innerWidth < 768) {
                  setIsSidebarHidden(true);
                }
              }}
              onHighlightFlight={() => {
                if (typeof window !== 'undefined' && window.innerWidth < 768) {
                  setIsSidebarHidden(true);
                }
              }}
            />
          </div>

          {/* Flight Count */}
          <div className="p-3 border-t border-gray-700 flex items-center justify-center gap-3">
            <span className="text-xs text-gray-400">
              {t('dashboard.flightsImported', { count: flights.length })}
            </span>
            <a
              href="https://github.com/arpanghosh8453/open-dronelog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-white transition-colors"
              title={t('dashboard.starOnGithub')}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            {/* Update available badge */}
            {updateStatus === 'outdated' && latestVersion && (
              <a
                href="https://opendronelog.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer no-underline"
                title={t('dashboard.clickToUpdate')}
              >
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zM7.5 4v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                {t('dashboard.updateTo', { version: latestVersion })}
              </a>
            )}
          </div>

          {/* Mobile close + settings buttons for sidebar */}
          <div className="absolute right-4 mobile-safe-fixed-top flex items-center gap-2 z-50 md:hidden">
            {supporterBadgeActive && (
              <div className="supporter-badge" title={t('dashboard.verifiedSupporter')}>
                <div className="flex items-center justify-center w-9 h-9 rounded-md">
                  <svg className="w-8 h-8 supporter-star" viewBox="0 0 100 120" fill="none">
                    <path d="M50 115L5 65L20 45L50 70L80 45L95 65Z" fill="url(#badge-grad-mobile)" />
                    <path d="M15 55L50 85L85 55L75 40L50 60L25 40Z" fill="url(#badge-grad-mobile)" opacity="0.7" />
                    <path d="M50 2L56.5 18L74 18L60 28L65 45L50 35L35 45L40 28L26 18L43.5 18Z" fill="url(#star-grad-mobile)" />
                    <defs>
                      <linearGradient id="badge-grad-mobile" x1="50" y1="40" x2="50" y2="115" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#f59e0b" />
                        <stop offset="100%" stopColor="#d97706" />
                      </linearGradient>
                      <linearGradient id="star-grad-mobile" x1="50" y1="2" x2="50" y2="45" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stopColor="#fbbf24" />
                        <stop offset="100%" stopColor="#f59e0b" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            )}
            <button
              onClick={() => { setIsSidebarHidden(true); setShowSettings(true); }}
              className="sidebar-mobile-btn border rounded-lg p-2 transition-colors"
              title={t('dashboard.settings')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={() => setIsSidebarHidden(true)}
              className="sidebar-mobile-btn border rounded-lg p-2 transition-colors"
              title={t('dashboard.hideSidebar')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div
            onMouseDown={() => {
              resizingRef.current = 'sidebar';
            }}
            className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hidden md:block"
          />
          </div>
        </aside>

      <aside
        className={`bg-drone-secondary border-r border-gray-700 items-start justify-center relative z-40 overflow-visible hidden md:flex md:transition-[width,min-width,opacity] md:duration-250 md:ease-in-out ${isSidebarHidden ? 'md:opacity-100 md:pointer-events-auto' : 'md:opacity-0 md:pointer-events-none'
          }`}
        style={{ width: isSidebarHidden ? '1.8rem' : 0, minWidth: isSidebarHidden ? '1.8rem' : 0 }}
      >
        <button
          onClick={() => setIsSidebarHidden(false)}
          className="sidebar-collapsed-toggle-btn relative z-50 mt-4 translate-x-1/2 border rounded-full w-[4rem] h-[3rem] text-lg leading-none flex items-center justify-center"
          title={t('dashboard.showSidebar')}
        >
          ›
        </button>
      </aside>

      {/* Mobile Show Sidebar Button */}
      {isSidebarHidden && (
        <div className="fixed right-6 mobile-safe-fixed-bottom z-40 md:hidden">
          <button
            onClick={() => setIsSidebarHidden(false)}
            className="p-4 bg-drone-primary text-white rounded-full shadow-lg flex items-center justify-center hover:bg-sky-400 transition-colors"
            title={t('dashboard.showSidebar')}
            style={{ boxShadow: '0 4px 14px 0 rgba(14, 165, 233, 0.39)' }}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>
      )}

      {/* Main Content */}
      <main
        className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
        onClick={() => {
          // Clear overview highlight when clicking outside the flight list
          if (activeView === 'overview') {
            useFlightStore.getState().setOverviewHighlightedFlightId(null);
          }
        }}
      >
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div
                className="w-12 h-12 rounded-full spinner"
                style={{ border: '4px solid #38bdf8', borderTopColor: 'transparent' }}
              />
              <p className="text-sm" style={{ color: '#64748b' }}>{t('dashboard.loadingFlightData')}</p>
            </div>
          </div>
        ) : activeView === 'overview' ? (
          <div className="w-full h-full overflow-auto">
            {overviewStats ? (
              <Overview
                stats={overviewStats}
                flights={flights}
                unitPrefs={unitPrefs}
                onSelectFlight={(flightId) => {
                  setActiveView('flights');
                  useFlightStore.getState().selectFlight(flightId);
                  if (typeof window !== 'undefined' && window.innerWidth < 768) {
                    setIsSidebarHidden(true);
                  }
                }}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center h-full">
                <p className="text-gray-500">{t('dashboard.noOverviewData')}</p>
              </div>
            )}
          </div>
        ) : currentFlightData ? (
          <>
              <div className="w-full h-full min-h-0 overflow-y-auto overflow-x-hidden">
                <div className="w-full min-h-full md:min-h-[780px] flex flex-col">
                {/* Stats Bar */}
                <FlightStats data={currentFlightData} />

                {/* Charts and Map Grid */}
                <div id="main-panels" className={`${shouldStackPanels ? 'flex-none' : 'flex-1'} md:min-h-[620px] flex flex-col ${shouldStackPanels ? '' : 'md:flex-row'} gap-4 p-4 overflow-visible ${shouldStackPanels ? '' : 'md:overflow-hidden'}`}>
                  {/* Telemetry Charts - when collapsed, content clips instead of squeezing */}
                  <div
                    className={`card flex flex-col min-h-[400px] md:min-h-[520px] relative ${isTelemetryCollapsed ? 'overflow-hidden' : 'overflow-hidden'}`}
                    style={{
                      flexBasis: isDesktopLayout && !shouldStackPanels ? `${mainSplit}%` : 'auto',
                      flexGrow: isDesktopLayout && !shouldStackPanels ? 0 : 1,
                      minWidth: isDesktopLayout && !shouldStackPanels ? (isTelemetryCollapsed ? TELEMETRY_MIN_VISIBLE_WIDTH : TELEMETRY_CARD_MIN_WIDTH) : '100%',
                      flexShrink: 0,
                      height: splitCardsViewportHeight,
                      maxHeight: splitCardsViewportHeight ?? '720px',
                    }}
                  >
                    <div className={`border-b border-gray-700 flex items-center ${isTelemetryCollapsed ? 'justify-center p-2' : 'justify-between p-3'}`}>
                      {!isTelemetryCollapsed && (
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-white">
                            {t('dashboard.telemetryData')}
                          </h2>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const container = document.getElementById('main-panels');
                          if (!container) return;
                          const rect = container.getBoundingClientRect();

                          if (!isTelemetryCollapsed) {
                            // Collapse it
                            setPreCollapseSplit(mainSplit);
                            setIsTelemetryCollapsed(true);
                            // Set to minimum visible width percentage
                            const minLeftPercent = (TELEMETRY_MIN_VISIBLE_WIDTH / rect.width) * 100;
                            setMainSplit(minLeftPercent);
                          } else {
                            // Expand it
                            setIsTelemetryCollapsed(false);
                            // Restore previous split or default to 50%
                            const minNormalPercent = (TELEMETRY_MIN_NORMAL_WIDTH / rect.width) * 100;
                            if (preCollapseSplit !== null && preCollapseSplit > minNormalPercent) {
                              setMainSplit(preCollapseSplit);
                            } else {
                              setMainSplit(50);
                            }
                          }
                        }}
                        className={`rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors ${isTelemetryCollapsed ? 'p-1' : 'p-1.5'}`}
                        title={isTelemetryCollapsed ? t('dashboard.expandPanel') : t('dashboard.collapsePanel')}
                        aria-label={isTelemetryCollapsed ? t('dashboard.expandPanel') : t('dashboard.collapsePanel')}
                      >
                        <svg
                          className={`transition-transform duration-200 ${isTelemetryCollapsed ? 'w-4 h-4' : 'w-5 h-5'} ${isTelemetryCollapsed ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                    </div>
                    {/* Inner container that maintains minimum width for content */}
                    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto p-2">
                      <div
                        className="min-h-full"
                        style={{
                          minWidth: isDesktopLayout && !shouldStackPanels ? TELEMETRY_MIN_NORMAL_WIDTH : `${TELEMETRY_SCROLL_MIN_WIDTH}px`,
                          width: isDesktopLayout && !shouldStackPanels ? (isTelemetryCollapsed ? TELEMETRY_MIN_NORMAL_WIDTH : '100%') : '100%',
                        }}
                      >
                        <TelemetryCharts
                          data={currentFlightData!.telemetry}
                          unitPrefs={unitPrefs}
                          startTime={currentFlightData!.flight.startTime}
                        />
                      </div>
                    </div>
                  </div>

                  <div
                    onMouseDown={() => {
                      resizingRef.current = 'main';
                    }}
                    className={`${shouldStackPanels ? 'hidden' : 'block'} w-2 shrink-0 self-stretch cursor-col-resize bg-gray-500/50 rounded hover:bg-drone-primary/80 transition-colors`}
                    title={t('dashboard.dragToResize')}
                  />

                  {/* Flight Map */}
                  <div
                    className={`card flex flex-col ${isDesktopLayout && !shouldStackPanels ? '' : 'h-[648px]'} md:min-h-[520px] overflow-hidden`}
                    style={{
                      flexBasis: isDesktopLayout && !shouldStackPanels ? 'auto' : 'auto',
                      flexGrow: isDesktopLayout && !shouldStackPanels ? 1 : 0,
                      minWidth: isDesktopLayout && !shouldStackPanels ? MAP_MIN_WIDTH : '100%',
                      flexShrink: isDesktopLayout && !shouldStackPanels ? 1 : 0,
                      height: splitCardsViewportHeight,
                      maxHeight: splitCardsViewportHeight ?? '720px',
                    }}
                  >
                    <div className="px-3 py-2.5 border-b border-gray-700 flex items-center justify-between">
                      <h2 className="font-semibold text-white">{t('dashboard.flightPath')}</h2>
                      {currentFlightData?.messages && currentFlightData.messages.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowMessagesModal(true)}
                          className="relative p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
                          title={t('dashboard.viewFlightMessages')}
                          aria-label={t('dashboard.viewFlightMessages')}
                        >
                          {/* Chat-bubble icon */}
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M8 10h.01M12 10h.01M16 10h.01M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"
                            />
                          </svg>
                          {/* Red badge with count */}
                          <span className="absolute -top-1 -right-1 min-w-[19px] h-[19px] px-0.5 flex items-center justify-center rounded-full bg-red-600 text-white msg-badge-count text-[11px] font-bold leading-none border border-drone-dark">
                            {currentFlightData.messages.length > 99 ? '99+' : currentFlightData.messages.length}
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="flex-1 min-h-[420px] relative">
                      <FlightMap
                        flightId={currentFlightData!.flight.id}
                        track={currentFlightData!.track}
                        homeLat={currentFlightData!.flight.homeLat}
                        homeLon={currentFlightData!.flight.homeLon}
                        durationSecs={currentFlightData!.flight.durationSecs}
                        telemetry={currentFlightData!.telemetry}
                        themeMode={themeMode}
                        messages={currentFlightData!.messages}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {/* Flight Messages Modal */}
            {showMessagesModal && currentFlightData?.messages && currentFlightData.messages.length > 0 && (
              <FlightMessagesModal
                isOpen={showMessagesModal}
                onClose={() => setShowMessagesModal(false)}
                messages={currentFlightData.messages}
                flightStartTime={currentFlightData.flight.startTime ?? null}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="w-24 h-24 mx-auto mb-6 text-gray-600">
                <svg
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-300 mb-2">
                {t('dashboard.noFlightSelected')}
              </h2>
              <p className="text-gray-500">
                {t('dashboard.noFlightDescription')}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
