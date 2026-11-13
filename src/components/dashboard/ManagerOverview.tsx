/**
 * Manager overview — read-only totals across every profile on the server.
 *
 * Opt-in for teams: the server only offers it when MANAGER_OVERVIEW=true and
 * PROFILE_CREATION_PASS are both set, and the master password unlocks it.
 * Combined totals sit on top; each profile is listed underneath and expands
 * to show its drones.
 */

import { Fragment, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFlightStore } from '@/stores/flightStore';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { getManagerOverview, type ManagerProfileSummary } from '@/lib/api';
import { formatDistance, formatDuration } from '@/lib/utils';

interface Props {
  onClose: () => void;
}

function droneKey(d: { droneSerial: string | null; droneModel: string; aircraftName: string | null }) {
  return d.droneSerial || `${d.droneModel}|${d.aircraftName ?? ''}`;
}

export function ManagerOverview({ onClose }: Props) {
  const { t, i18n } = useTranslation();
  const unitPrefs = useFlightStore((s) => s.unitPrefs);
  const locale = i18n.language;

  // Kept in memory only, so Refresh works without asking again.
  const [masterPassword, setMasterPassword] = useState('');
  const [profiles, setProfiles] = useState<ManagerProfileSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    if (!masterPassword) {
      setError(t('manager.passwordRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setProfiles(await getManagerOverview(masterPassword));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const totals = useMemo(() => {
    if (!profiles) return null;
    const drones = new Set<string>();
    let lastFlight: string | null = null;
    const sum = profiles.reduce(
      (acc, p) => {
        acc.flights += p.totalFlights;
        acc.duration += p.totalDurationSecs;
        acc.distance += p.totalDistanceM;
        acc.photos += p.totalPhotos;
        acc.videos += p.totalVideos;
        p.drones.forEach((d) => drones.add(droneKey(d)));
        if (p.lastFlightDate && (!lastFlight || p.lastFlightDate > lastFlight)) lastFlight = p.lastFlightDate;
        return acc;
      },
      { flights: 0, duration: 0, distance: 0, photos: 0, videos: 0 },
    );
    return { ...sum, drones: drones.size, lastFlight, profiles: profiles.length };
  }, [profiles]);

  const num = (n: number) => n.toLocaleString(locale);
  const profileLabel = (name: string) => (name === 'default' ? t('profile.default') : name);

  const primary =
    'px-3 py-1.5 text-xs rounded bg-drone-primary/20 border border-drone-primary text-white hover:bg-drone-primary/30 transition-colors disabled:opacity-50';
  const secondary =
    'px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:text-white transition-colors disabled:opacity-50';

  // Portal to <body> so a blurred or transformed header can't clip the overlay.
  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-start sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto mobile-safe-container">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manager-overview-title"
        className="w-full max-w-4xl bg-drone-secondary border border-gray-700 rounded-xl shadow-2xl p-5 text-gray-200"
      >
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id="manager-overview-title" className="text-base font-semibold text-white">
            {t('manager.title')}
          </h2>
          <div className="flex gap-2">
            {profiles && (
              <button className={secondary} onClick={() => void load()} disabled={loading}>
                {loading ? t('manager.loading') : t('manager.refresh')}
              </button>
            )}
            <button className={secondary} onClick={onClose}>
              {t('manager.close')}
            </button>
          </div>
        </div>

        {!profiles && (
          <div className="max-w-sm">
            <p className="text-sm leading-relaxed mb-3">{t('manager.intro')}</p>
            <PasswordInput
              value={masterPassword}
              autoFocus
              onChange={(e) => {
                setMasterPassword(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load();
                if (e.key === 'Escape') onClose();
              }}
              placeholder={t('profile.masterPasswordPlaceholder')}
              className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
            />
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
            <div className="flex justify-end mt-3">
              <button className={primary} onClick={() => void load()} disabled={loading}>
                {loading ? t('manager.loading') : t('manager.open')}
              </button>
            </div>
          </div>
        )}

        {profiles && totals && (
          <>
            {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4">
              {[
                [t('manager.profiles'), num(totals.profiles)],
                [t('manager.flights'), num(totals.flights)],
                [t('manager.flightTime'), formatDuration(totals.duration)],
                [t('manager.distance'), formatDistance(totals.distance, unitPrefs.distance, locale)],
                [t('manager.photos'), num(totals.photos)],
                [t('manager.videos'), num(totals.videos)],
                [t('manager.drones'), num(totals.drones)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-gray-700 bg-gray-800/40 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
                  <div className="text-sm font-semibold text-white">{value}</div>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="py-1.5 pr-2 font-medium">{t('manager.profile')}</th>
                    <th className="py-1.5 px-2 font-medium text-right">{t('manager.flights')}</th>
                    <th className="py-1.5 px-2 font-medium text-right">{t('manager.flightTime')}</th>
                    <th className="py-1.5 px-2 font-medium text-right">{t('manager.distance')}</th>
                    <th className="py-1.5 px-2 font-medium text-right">{t('manager.photos')}</th>
                    <th className="py-1.5 px-2 font-medium text-right">{t('manager.drones')}</th>
                    <th className="py-1.5 pl-2 font-medium text-right">{t('manager.lastFlight')}</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => {
                    const open = expanded === p.name;
                    return (
                      <Fragment key={p.name}>
                        <tr
                          className="border-b border-gray-700/50 hover:bg-gray-700/30 cursor-pointer"
                          onClick={() => setExpanded(open ? null : p.name)}
                          aria-expanded={open}
                        >
                          <td className="py-1.5 pr-2 text-white">
                            <span className="inline-block w-3 text-gray-500">{open ? '▾' : '▸'}</span>
                            {profileLabel(p.name)}
                            {p.hasPassword && (
                              <span className="ml-1 text-gray-500" title={t('manager.protected')}>🔒</span>
                            )}
                          </td>
                          {p.error ? (
                            <td colSpan={6} className="py-1.5 px-2 text-red-400">
                              {t('manager.readError')}
                            </td>
                          ) : (
                            <>
                              <td className="py-1.5 px-2 text-right">{num(p.totalFlights)}</td>
                              <td className="py-1.5 px-2 text-right">{formatDuration(p.totalDurationSecs)}</td>
                              <td className="py-1.5 px-2 text-right">
                                {formatDistance(p.totalDistanceM, unitPrefs.distance, locale)}
                              </td>
                              <td className="py-1.5 px-2 text-right">{num(p.totalPhotos)}</td>
                              <td className="py-1.5 px-2 text-right">{num(p.drones.length)}</td>
                              <td className="py-1.5 pl-2 text-right">{p.lastFlightDate ?? '—'}</td>
                            </>
                          )}
                        </tr>
                        {open && (
                          <tr className="border-b border-gray-700/50 bg-gray-800/30">
                            <td colSpan={7} className="py-2 px-3">
                              {p.error ? (
                                <p className="text-red-400">{p.error}</p>
                              ) : p.drones.length === 0 ? (
                                <p className="text-gray-400">{t('manager.noFlights')}</p>
                              ) : (
                                <>
                                  <p className="text-gray-400 mb-1">
                                    {t('manager.detail', {
                                      videos: num(p.totalVideos),
                                      batteries: num(p.batteryCount),
                                      first: p.firstFlightDate ?? '—',
                                    })}
                                  </p>
                                  <ul className="space-y-0.5">
                                    {p.drones.map((d) => (
                                      <li key={droneKey(d)} className="flex justify-between gap-3">
                                        <span className="text-gray-200">
                                          {d.aircraftName ? `${d.aircraftName} · ` : ''}
                                          {d.droneModel}
                                          {d.droneSerial ? <span className="text-gray-500"> ({d.droneSerial})</span> : null}
                                        </span>
                                        <span className="text-gray-400 whitespace-nowrap">
                                          {t('manager.droneFlights', { count: d.flightCount })}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-gray-500 mt-3">{t('manager.readOnlyNote')}</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
