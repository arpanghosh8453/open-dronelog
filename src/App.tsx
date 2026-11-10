import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { useFlightStore } from '@/stores/flightStore';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { PhotoRecountPrompt } from '@/components/dashboard/PhotoRecountPrompt';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { isWebMode, unlockProfile } from '@/lib/api';
import { useIsMobileRuntime } from '@/hooks/platform/useIsMobileRuntime';

/** Loading overlay shown during database initialization/migration */
function InitializationOverlay() {
  const { t } = useTranslation();
  const { needsAuth, activeProfile, profiles, profilePasswords, loadProfiles, loadFlights, loadOverview } = useFlightStore();
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(activeProfile);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load profile list so the dropdown is populated
  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Keep selectedProfile in sync with activeProfile
  useEffect(() => {
    setSelectedProfile(activeProfile);
  }, [activeProfile]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /** Lock icon SVG for protected profiles */
  const LockIcon = useCallback(({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  ), []);

  const handleAuth = async () => {
    if (profilePasswords[selectedProfile] && !authPassword.trim()) {
      setAuthError(t('profile.passwordRequired'));
      return;
    }
    setAuthError(null);
    setAuthBusy(true);
    try {
      if (profilePasswords[selectedProfile]) {
        if (!isWebMode() && selectedProfile === activeProfile) {
          // Tauri desktop: same-profile unlock (auto-logout scenario).
          // Uses dedicated unlock command — no page reload needed.
          await unlockProfile(authPassword);
          useFlightStore.setState({ needsAuth: false });
          await Promise.all([loadFlights(), loadOverview()]);
        } else {
          // Different profile or web mode — full switch (verifies password + swaps DB)
          const { switchProfile } = useFlightStore.getState();
          await switchProfile(selectedProfile, { password: authPassword });
          // switchProfile reloads the page, so we won't reach here normally.
          await Promise.all([loadFlights(), loadOverview()]);
        }
      } else {
        // Unprotected profile — just reload flights directly
        await Promise.all([loadFlights(), loadOverview()]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Show localised "wrong password" when the backend says so
      if (/incorrect password/i.test(msg)) {
        setAuthError(t('app.wrongPassword'));
      } else {
        setAuthError(msg);
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSwitchToUnprotected = async (profile: string) => {
    try {
      const { switchProfile } = useFlightStore.getState();
      await switchProfile(profile);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-drone-dark">
      <div className="flex flex-col items-center gap-6">
        {/* App icon/logo placeholder */}
        <div className="w-16 h-16 rounded-2xl bg-drone-primary/20 flex items-center justify-center">
          <svg
            className="w-10 h-10 text-drone-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
            />
          </svg>
        </div>

        {!needsAuth ? (
          <>
            <div className="text-center">
              <h2 className="text-lg font-medium text-white mb-2">{t('app.initializing')}</h2>
              <p className="text-sm text-gray-400">{t('app.initProgress')}</p>
            </div>

            {/* Animated progress bar */}
            <div className="w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full w-1/2 bg-drone-primary rounded-full init-progress-bar" />
            </div>
          </>
        ) : (
          /* Auth prompt for locked profile */
          <div className="w-80 text-center">
            <div className="flex items-center justify-center gap-2 mb-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <h2 className="text-lg font-medium text-white">{t('app.profileLocked')}</h2>
            </div>
            <p className="text-sm text-gray-400 mb-4">{t('app.profileLockedDesc')}</p>

            {/* Profile selector dropdown (custom, so we can show SVG lock icons) */}
            <div ref={dropdownRef} className="relative w-full mb-2">
              <button
                type="button"
                onClick={() => setDropdownOpen((o) => !o)}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white flex items-center justify-between focus:outline-none focus:border-drone-primary cursor-pointer"
              >
                <span className="flex items-center gap-1.5 truncate">
                  {selectedProfile === 'default' ? t('profile.default') : selectedProfile}
                  {profilePasswords[selectedProfile] && <LockIcon className="w-3.5 h-3.5 text-amber-400" />}
                </span>
                <svg className={`w-3.5 h-3.5 ml-1 flex-shrink-0 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <polyline points="6 9 12 15 18 9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {dropdownOpen && (
                <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 shadow-xl max-h-48 overflow-y-auto">
                  {profiles.map((name) => (
                    <div
                      key={name}
                      onClick={() => {
                        setSelectedProfile(name);
                        setAuthPassword('');
                        setAuthError(null);
                        setDropdownOpen(false);
                        if (!profilePasswords[name]) {
                          handleSwitchToUnprotected(name);
                        }
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer hover:bg-drone-primary/20 ${
                        name === selectedProfile ? 'text-white font-medium bg-drone-primary/10' : 'text-gray-300'
                      }`}
                    >
                      {name === 'default' ? t('profile.default') : name}
                      {profilePasswords[name] && <LockIcon className="w-3.5 h-3.5 text-amber-400" />}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {profilePasswords[selectedProfile] ? (
              <>
                <PasswordInput
                  wrapperClassName="mb-2"
                  value={authPassword}
                  onChange={(e) => { setAuthPassword(e.target.value); setAuthError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAuth(); }}
                  placeholder={t('profile.passwordPlaceholder')}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
                  autoFocus
                />
                {authError && (
                  <p className="text-xs text-red-400 mb-2">{authError}</p>
                )}
                <button
                  onClick={handleAuth}
                  disabled={authBusy || !authPassword.trim()}
                  className="w-full py-2 rounded-lg bg-drone-primary text-white text-sm font-medium hover:bg-drone-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {authBusy && (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {t('profile.unlock')}
                </button>
              </>
            ) : (
              <>
                {authError && (
                  <p className="text-xs text-red-400 mb-2">{authError}</p>
                )}
                <button
                  onClick={handleAuth}
                  disabled={authBusy}
                  className="w-full py-2 rounded-lg bg-drone-primary text-white text-sm font-medium hover:bg-drone-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {authBusy && (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {t('profile.login')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error; componentStack?: string; copied: boolean }
> {
  state = { hasError: false, error: undefined as Error | undefined, componentStack: undefined as string | undefined, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('App crashed:', error, info);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  /** Build a full, copy-friendly error report string */
  buildReport(): string {
    const { error, componentStack } = this.state;
    const sections: string[] = [];
    sections.push(`=== Open DroneLog – Error Report ===`);
    sections.push(`Timestamp: ${new Date().toISOString()}`);
    sections.push(`User Agent: ${navigator.userAgent}`);
    if (error) {
      sections.push(`\n--- Error ---`);
      sections.push(`${error.name}: ${error.message}`);
      if (error.stack) {
        sections.push(`\n--- Stack Trace ---`);
        sections.push(error.stack);
      }
    }
    if (componentStack) {
      sections.push(`\n--- Component Stack ---`);
      sections.push(componentStack.trim());
    }
    return sections.join('\n');
  }

  handleCopy = () => {
    const report = this.buildReport();
    navigator.clipboard.writeText(report).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    }).catch(() => {
      // Fallback: select text for manual copy
      const el = document.getElementById('error-report-pre');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  };

  render() {
    if (this.state.hasError) {
      const report = this.buildReport();
      return (
        <div className="w-full h-full bg-drone-dark text-gray-200 flex items-center justify-center p-6">
          <div className="max-w-2xl w-full text-center space-y-4">
            {/* Error icon */}
            <div className="flex justify-center">
              <svg className="w-12 h-12 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>

            <h2 className="text-xl font-semibold text-white">{i18n.t('app.errorTitle')}</h2>
            <p className="text-sm text-gray-400">
              {i18n.t('app.errorDescription')}
            </p>
            <p className="text-sm text-amber-400/90">
              {i18n.t('app.errorContactDev')}
            </p>

            {/* Scrollable error report */}
            <div className="relative text-left bg-black/40 border border-gray-700 rounded-lg">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                <span className="text-xs font-medium text-gray-400">{i18n.t('app.errorReportLabel')}</span>
                <button
                  onClick={this.handleCopy}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white"
                >
                  {this.state.copied ? (
                    <>
                      <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" /></svg>
                      {i18n.t('app.errorCopied')}
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                      {i18n.t('app.errorCopyReport')}
                    </>
                  )}
                </button>
              </div>
              <pre
                id="error-report-pre"
                className="text-[11px] leading-relaxed text-gray-400 whitespace-pre-wrap break-words p-3 max-h-[40vh] overflow-y-auto select-text"
              >
                {report}
              </pre>
            </div>

            {/* Restart button */}
            <button
              onClick={() => window.location.reload()}
              className="mt-2 px-4 py-2 text-sm font-medium rounded-lg bg-drone-primary hover:bg-drone-primary/80 text-white transition-colors"
            >
              {i18n.t('app.errorRestart')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  const { t } = useTranslation();
  const { loadFlights, error, clearError, donationAcknowledged, themeMode, isFlightsInitialized, needsAuth, loadSupporterStatus } = useFlightStore();
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false;
    return sessionStorage.getItem('donationBannerDismissed') === 'true';
  });
  const [isSmallScreen, setIsSmallScreen] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  const isMobileRuntime = useIsMobileRuntime();

  // Load flights on mount
  useEffect(() => {
    loadFlights();
  }, [loadFlights]);

  // Load supporter/donation status from backend on mount
  useEffect(() => {
    loadSupporterStatus();
  }, [loadSupporterStatus]);

  // Ctrl+Q to close window (Tauri desktop only)
  useEffect(() => {
    if (isWebMode()) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().close();
        } catch (err) {
          console.error('Failed to close window:', err);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('Window error:', event.error || event.message);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled rejection:', event.reason);
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const showDonationBanner = useMemo(
    () => !donationAcknowledged && !bannerDismissed,
    [donationAcknowledged, bannerDismissed]
  );

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
      }
      return 'dark';
    }
    return themeMode;
  }, [themeMode]);

  const handleDismissBanner = () => {
    setBannerDismissed(true);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('donationBannerDismissed', 'true');
    }
  };

  useEffect(() => {
    const onResize = () => {
      setIsSmallScreen(window.innerWidth < 768);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (isWebMode() || !isMobileRuntime) return;

    const originalWindowOpen = window.open.bind(window);

    const openExternalUrl = async (href: string) => {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(href);
        return;
      } catch {
        // Fall through to shell/open fallback.
      }

      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(href);
      } catch {
        // Final fallback if native plugins are unavailable.
        originalWindowOpen(href, '_blank', 'noopener,noreferrer');
      }
    };
    const patchedWindowOpen: typeof window.open = ((url?: string | URL, target?: string, features?: string) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        void openExternalUrl(url);
        return null;
      }
      return originalWindowOpen(url as string | URL, target, features);
    }) as typeof window.open;
    window.open = patchedWindowOpen;

    const handleExternalLink = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(href)) return;

      event.preventDefault();
      event.stopPropagation();
      void openExternalUrl(href);
    };

    document.addEventListener('click', handleExternalLink, true);
    return () => {
      window.open = originalWindowOpen;
      document.removeEventListener('click', handleExternalLink, true);
    };
  }, [isMobileRuntime]);

  const useCompactBanner = isMobileRuntime || isSmallScreen;
  return (
    <div className="w-full h-full flex flex-col bg-drone-dark overflow-hidden mobile-safe-container">
      {/* Initialization overlay - shown during DB migration or auth required */}
      {(!isFlightsInitialized || needsAuth) && <InitializationOverlay />}

      {showDonationBanner && (
        <div
          className={`w-full border-b border-drone-primary/40 text-gray-100 overflow-hidden ${resolvedTheme === 'light'
              ? 'bg-gradient-to-r from-violet-200 via-fuchsia-200 to-orange-200 text-gray-900'
              : 'bg-gradient-to-r from-violet-900 via-purple-900 to-orange-900'
            }`}
        >
          <div className="relative flex items-center w-full py-2.5 md:py-[17px]">
            {/* Scrolling marquee for mobile, centered static for desktop */}
            {useCompactBanner ? (
              <div className="flex-1 text-center px-10 text-[0.9rem] font-medium">
                <span>Support Open-DroneLog on </span>
                <a
                  href="https://ko-fi.com/arpandesign"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={
                    resolvedTheme === 'light'
                      ? 'text-indigo-700 hover:underline font-semibold'
                      : 'text-amber-300 hover:text-amber-200 hover:underline font-semibold'
                  }
                >
                  Ko-Fi
                </a>
              </div>
            ) : (
              <div className="marquee-container flex-1 overflow-hidden mx-8 md:mx-0">
                <div className="marquee-content md:marquee-paused flex items-center gap-2 whitespace-nowrap text-[0.85rem] md:text-[1rem] md:justify-center md:whitespace-normal md:flex-wrap">
                  <span>
                    {t('app.bannerText')}
                  </span>
                  <a
                    href="https://github.com/arpanghosh8453/open-dronelog"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={
                      resolvedTheme === 'light'
                        ? 'text-indigo-700 hover:underline font-semibold'
                        : 'text-drone-primary hover:underline font-semibold'
                    }
                  >
                    GitHub
                  </a> {t('app.bannerBy')}
                  <span className={resolvedTheme === 'light' ? 'text-gray-500' : 'text-gray-400'}>
                    •
                  </span>
                  <span>
                    {t('app.bannerSupport')}
                  </span>
                  <a
                    href="https://ko-fi.com/arpandesign"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={
                      resolvedTheme === 'light'
                        ? 'text-indigo-700 hover:underline font-semibold'
                        : 'text-amber-300 hover:text-amber-200 hover:underline font-semibold'
                    }
                  >
                    Ko-fi
                  </a>
                </div>
              </div>
            )}
            <button
              onClick={handleDismissBanner}
              className={`absolute right-2 md:right-4 rounded-md px-2 py-1.5 transition-colors flex-shrink-0 z-10 ${resolvedTheme === 'light'
                  ? 'text-gray-600 hover:text-gray-900'
                  : 'text-gray-300 hover:text-white'
                }`}
              aria-label={t('app.dismissBanner')}
              title={t('app.dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-500/90 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 max-w-md">
          <span className="text-sm">{error}</span>
          <button
            onClick={clearError}
            className="text-white/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* One-time offer to recount photos for flights imported before the photo-count fix */}
      <PhotoRecountPrompt />

      {/* Main Dashboard */}
      <AppErrorBoundary>
        <div className="flex-1 min-h-0">
          <Dashboard />
        </div>
      </AppErrorBoundary>
    </div>
  );
}

export default App;
