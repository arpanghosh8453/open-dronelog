/**
 * Weather modal - shows historical weather conditions at flight takeoff location & time.
 * Data sourced from Open-Meteo Archive API (no API key required).
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { fetchFlightWeather, fetchReverseGeocodeLocation } from '@/lib/weather';
import type { WeatherData } from '@/lib/weather';
import type { SpeedUnit, UnitSystem } from '@/lib/utils';
import { fmtNum, isImperialSpeedUnit, speedMultiplierFromMs, speedUnitLabel } from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';
import weatherIcon from '@/assets/weather-icon.svg';

interface WeatherModalProps {
  isOpen: boolean;
  onClose: () => void;
  lat: number;
  lon: number;
  /** ISO-8601 date-time string of flight start */
  startTime: string;
  /** Unit system for temperature display */
  temperatureUnit: UnitSystem;
  /** Unit system for wind speed / precipitation / pressure display */
  speedUnit: SpeedUnit;
}

export function WeatherModal({ isOpen, onClose, lat, lon, startTime, temperatureUnit, speedUnit }: WeatherModalProps) {
  const { t } = useTranslation();
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setWeather(null);
    setLocationLabel(null);
    setLocationLoading(true);

    fetchFlightWeather(lat, lon, startTime)
      .then(setWeather)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));

    fetchReverseGeocodeLocation(lat, lon, useFlightStore.getState().locale, 'detailed')
      .then(setLocationLabel)
      .catch(() => setLocationLabel(null))
      .finally(() => setLocationLoading(false));
  }, [isOpen, lat, lon, startTime]);

  // Lock body scroll and hide all nested scrollbars while open
  useEffect(() => {
    if (!isOpen) return;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
      document.body.classList.remove('modal-open');
    };
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col items-center p-4 overflow-y-auto mobile-safe-container">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-drone-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-sm mx-4 overflow-hidden modal-mobile-max flex flex-col my-auto">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <img src={weatherIcon} alt="Weather" className="w-5 h-5" />
            <h2 className="text-lg font-semibold text-white">{t('weather.title')}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 p-5 min-h-0 overflow-y-auto">
          {loading && (
            <div className="flex flex-col items-center justify-center py-10">
              <svg className="w-8 h-8 text-drone-primary animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
              </svg>
              <p className="mt-3 text-sm text-gray-400">{t('weather.fetching')}</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <ErrorIcon className="w-8 h-8 text-red-400 mb-3" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {weather && !loading && !error && (() => {
            const isTempImperial = temperatureUnit === 'imperial';
            const isSpeedImperial = isImperialSpeedUnit(speedUnit);
            const locale = useFlightStore.getState().locale;
            const fmtTemp = (c: number) =>
              isTempImperial ? `${fmtNum((c * 9) / 5 + 32, 1, locale)}\u00B0F` : `${fmtNum(c, 1, locale)}\u00B0C`;
            const fmtSpeed = (kmh: number) =>
              `${fmtNum((kmh / 3.6) * speedMultiplierFromMs(speedUnit), 1, locale)} ${speedUnitLabel(speedUnit)}`;
            const fmtPrecip = (mm: number) =>
              isSpeedImperial ? `${fmtNum(mm * 0.03937, 2, locale)} in` : `${fmtNum(mm, 1, locale)} mm`;
            const fmtPressure = (hPa: number) =>
              isSpeedImperial ? `${fmtNum(hPa * 0.02953, 2, locale)} inHg` : `${fmtNum(hPa, 0, locale)} hPa`;

            return (
              <>
                {/* Condition summary */}
                <div className="text-center mb-5">
                  <p className="text-3xl font-bold text-white">{fmtTemp(weather.temperature)}</p>
                  <p className="text-sm text-gray-400 mt-1">{weather.conditionLabel}</p>
                </div>

                {/* Reverse-geocoded home-point location */}
                <div className="mb-4 rounded-lg bg-drone-surface/40 border border-gray-700/50 px-3 py-2.5">
                  <div className="flex items-start gap-2.5">
                    <LocationPinIcon className="w-4 h-4 text-drone-primary mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500">{t('weather.location')}</p>
                      <p className="text-sm text-gray-200 leading-snug break-words">
                        {locationLoading
                          ? t('weather.locationFetching')
                          : (locationLabel ?? `${fmtNum(lat, 4, locale)}, ${fmtNum(lon, 4, locale)}`)}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 gap-3">
                  <WeatherStat
                    icon={<ThermometerIcon className="w-5 h-5 text-orange-400" />}
                    label={t('weather.feelsLike')}
                    value={fmtTemp(weather.apparentTemperature)}
                  />
                  <WeatherStat
                    icon={<WindIcon className="w-5 h-5 text-drone-primary" />}
                    label={t('weather.windSpeed')}
                    value={fmtSpeed(weather.windSpeed)}
                  />
                  <WeatherStat
                    icon={<WindSockIcon className="w-5 h-5 text-teal-400" />}
                    label={t('weather.windGusts')}
                    value={fmtSpeed(weather.windGusts)}
                  />
                  <WeatherStat
                    icon={<DropletIcon className="w-5 h-5 text-blue-400" />}
                    label={t('weather.humidity')}
                    value={`${weather.humidity}%`}
                  />
                  <WeatherStat
                    icon={<CloudIcon className="w-5 h-5 text-gray-400" />}
                    label={t('weather.cloudCover')}
                    value={`${weather.cloudCover}%`}
                  />
                  <WeatherStat
                    icon={<RainIcon className="w-5 h-5 text-indigo-400" />}
                    label={t('weather.precipitation')}
                    value={fmtPrecip(weather.precipitation)}
                  />
                </div>

                {/* Wind direction + pressure row */}
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <WeatherStat
                    icon={<CompassIcon className="w-5 h-5 text-emerald-400" />}
                    label={t('weather.windDirection')}
                    value={`${weather.windDirection}\u00B0 ${degToCardinal(weather.windDirection)}`}
                  />
                  <WeatherStat
                    icon={<GaugeIcon className="w-5 h-5 text-purple-400" />}
                    label={t('weather.pressure')}
                    value={fmtPressure(weather.pressure)}
                  />
                </div>

                {/* Footer */}
                <p className="text-[10px] text-gray-600 text-center mt-4">
                  {t('weather.attribution')}
                </p>
                <p className="text-[10px] text-gray-600 text-center mt-1">
                  {t('weather.locationAttribution')}
                </p>
              </>
            );
          })()}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WeatherStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-drone-surface/50 border border-gray-700/50 px-3 py-2.5">
      {icon}
      <div className="min-w-0">
        <p className="text-xs text-gray-500 truncate">{label}</p>
        <p className="text-sm font-semibold text-white truncate">{value}</p>
      </div>
    </div>
  );
}

function degToCardinal(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ---------------------------------------------------------------------------
// Icons (inline SVGs, theme-responsive via className)
// ---------------------------------------------------------------------------

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  );
}

function ThermometerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9V3m0 6a3 3 0 100 6 3 3 0 000-6zm0 6v6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0" />
    </svg>
  );
}

function WindIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12h8.5a3.5 3.5 0 10-3.5-3.5M6 8h4.5a2.5 2.5 0 10-2.5-2.5M6 16h6.5a2.5 2.5 0 110 5H6" />
    </svg>
  );
}

function WindSockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18M3 6h13l-2 3 2 3H3" />
    </svg>
  );
}

function DropletIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21.5c-3.5 0-6.5-2.8-6.5-6.5 0-4.5 6.5-12 6.5-12s6.5 7.5 6.5 12c0 3.7-3 6.5-6.5 6.5z" />
    </svg>
  );
}

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
    </svg>
  );
}

function RainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 19v2m4-2v2m4-2v2" />
    </svg>
  );
}

function CompassIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
    </svg>
  );
}

function GaugeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 110-18 9 9 0 010 18z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12l3.5-3.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function LocationPinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s6-5.062 6-11a6 6 0 10-12 0c0 5.938 6 11 6 11z" />
      <circle cx="12" cy="10" r="2" />
    </svg>
  );
}
