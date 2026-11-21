/**
 * Flight statistics bar component
 * Displays key metrics for the selected flight
 */

import type { FlightDataResponse } from '@/types';
import { useTranslation } from 'react-i18next';
import { isWebMode, downloadFile, getFlightData, saveTextWithDialog } from '@/lib/api';
import { buildCsv, buildJson, buildGpx, buildKml, buildKmlRelative } from '@/lib/exportUtils';
import { useMemo, useState, useRef, useEffect } from 'react';
import { WeatherModal } from './WeatherModal';
import { HtmlReportModal } from './HtmlReportModal';
import weatherIcon from '@/assets/weather-icon.svg';
import {
  formatDuration,
  formatDistance,
  formatSpeed,
  formatAltitude,
  formatDateTime,
  isDecommissioned,
} from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';
import { getPairedBatteryDisplayName, useBatteryPairIndex } from '@/lib/batteryPairs';
import { buildHtmlReport, type HtmlReportFieldConfig, type FlightReportData } from '@/lib/htmlReportBuilder';
import { fetchFlightWeather } from '@/lib/weather';

interface FlightStatsProps {
  data: FlightDataResponse;
}

export function FlightStats({ data }: FlightStatsProps) {
  const { t } = useTranslation();
  const { flight, telemetry } = data;
  const { unitPrefs, locale, dateLocale, appLanguage, getBatteryDisplayName, getDroneDisplayName, addTag, removeTag, allTags, getDisplaySerial, timeFormat } = useFlightStore();
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showHtmlReportModal, setShowHtmlReportModal] = useState(false);
  const [isWeatherOpen, setIsWeatherOpen] = useState(false);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagValue, setNewTagValue] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const addTagContainerRef = useRef<HTMLDivElement>(null);
  const batteryPairIndex = useBatteryPairIndex();

  const flightTags = flight.tags ?? [];

  // Filter suggestions based on input
  useEffect(() => {
    if (newTagValue.trim()) {
      const search = newTagValue.toLowerCase();
      const existing = new Set(flightTags.map(t => (typeof t === 'string' ? t : t.tag).toLowerCase()));
      setTagSuggestions(
        allTags
          .filter(t => t.toLowerCase().includes(search) && !existing.has(t.toLowerCase()))
          .slice(0, 6)
      );
    } else {
      // Show all unused tags when input is empty and focused
      const existing = new Set(flightTags.map(t => (typeof t === 'string' ? t : t.tag).toLowerCase()));
      setTagSuggestions(
        allTags
          .filter(t => !existing.has(t.toLowerCase()))
          .slice(0, 6)
      );
    }
  }, [newTagValue, allTags, flightTags]);

  // Focus input when adding tag
  useEffect(() => {
    if (isAddingTag && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [isAddingTag]);

  // Close tag input on outside click
  useEffect(() => {
    if (!isAddingTag) return;
    const handler = (e: MouseEvent) => {
      if (addTagContainerRef.current && !addTagContainerRef.current.contains(e.target as Node)) {
        setIsAddingTag(false);
        setNewTagValue('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isAddingTag]);

  const handleAddTag = (tag: string) => {
    const trimmed = tag.trim();
    const existingNames = flightTags.map(t => typeof t === 'string' ? t : t.tag);
    if (trimmed && !existingNames.includes(trimmed)) {
      addTag(flight.id, trimmed);
    }
    setNewTagValue('');
    setIsAddingTag(false);
  };

  // Calculate battery levels from telemetry, ignoring null/0 placeholders
  const nonZeroBatteryValues = telemetry.battery.filter(
    (val): val is number => val !== null && val > 0
  );
  const minBattery = nonZeroBatteryValues.length ? Math.min(...nonZeroBatteryValues) : null;
  const maxBattery = nonZeroBatteryValues.length ? Math.max(...nonZeroBatteryValues) : null;

  const exportOptions = useMemo(
    () => [
      { id: 'csv', label: 'flightList.csv', extension: 'csv' },
      { id: 'json', label: 'flightList.json', extension: 'json' },
      { id: 'gpx', label: 'flightList.gpx', extension: 'gpx' },
      { id: 'kml', label: 'flightList.kml', extension: 'kml' },
      { id: 'kml_relative', label: 'flightList.kmlRelative', extension: 'kml' },
      { id: 'html_report', label: 'flightList.htmlReport', extension: 'html' },
    ],
    []
  );

  const handleExport = async (format: string, extension: string) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const baseName = (flight.displayName || flight.fileName || 'flight')
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);

      // Fetch full-resolution data for export (display data is downsampled to ~5000 points)
      const fullData = await getFlightData(flight.id);

      let content = '';
      switch (format) {
        case 'csv':
          content = buildCsv(fullData, unitPrefs);
          break;
        case 'json':
          content = buildJson(fullData, unitPrefs);
          break;
        case 'gpx':
          content = buildGpx(fullData);
          break;
        case 'kml':
          content = buildKml(fullData);
          break;
        case 'kml_relative':
          content = buildKmlRelative(fullData);
          break;
        default:
          return;
      }

      const filename = `${baseName || 'flight'}.${extension}`;

      if (isWebMode()) {
        downloadFile(filename, content);
      } else {
        const saved = await saveTextWithDialog(filename, content, [
          { name: format.toUpperCase(), extensions: [extension] },
        ]);
        if (!saved) return;
      }
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleHtmlReportExport = async (config: {
    documentTitle: string;
    pilotName: string;
    fieldConfig: HtmlReportFieldConfig;
  }) => {
    setShowHtmlReportModal(false);
    setIsExporting(true);
    try {
      const baseName = (flight.displayName || flight.fileName || 'flight')
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const defaultFileName = `${baseName || 'flight'}_Report_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.html`;

      // Fetch full-resolution data for the report
      const fullData: FlightDataResponse = await getFlightData(flight.id, 999999999);

      // Check if any weather fields are enabled
      const weatherFields: (keyof HtmlReportFieldConfig)[] = [
        'temperature', 'windSpeed', 'windGusts', 'humidity',
        'cloudCover', 'precipitation', 'pressure', 'weatherCondition',
      ];
      const needsWeather = weatherFields.some((f) => config.fieldConfig[f]);

      let weather = null;
      if (needsWeather) {
        const lat = flight.homeLat ?? fullData.telemetry.latitude?.find((v) => v !== null) ?? null;
        const lon = flight.homeLon ?? fullData.telemetry.longitude?.find((v) => v !== null) ?? null;
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
        data: fullData,
        weather,
        getDroneDisplayName,
        getBatteryDisplayName,
        getDisplaySerial,
      }];

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
        await saveTextWithDialog(defaultFileName, htmlContent, [
          { name: 'HTML', extensions: ['html'] },
        ]);
      }
    } catch (error) {
      console.error('HTML report export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const batteryCapsuleLabel = flight.batterySerial
    ? getPairedBatteryDisplayName(flight.batterySerial, batteryPairIndex, getBatteryDisplayName)
    : null;
  const batteryCapsuleIsDecommissioned = batteryCapsuleLabel ? isDecommissioned(batteryCapsuleLabel) : false;

  return (
    <div className="bg-drone-secondary border-b border-gray-700 px-4 py-3">
      {/* Flight Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-3 gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {flight.displayName || flight.fileName}
          </h2>
          {flight.notes && (
            <p className="text-sm text-amber-400/80 mt-1 flex items-start gap-1.5">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="italic">{flight.notes}</span>
            </p>
          )}
          {flight.droneModel && !flight.droneModel.startsWith('Unknown') && (
            <p className="text-xs text-gray-500 mt-2">
              {flight.droneModel}
            </p>
          )}
          <div className="text-sm text-gray-400 flex flex-wrap items-center gap-2 mt-2">
            {formatDateTime(flight.startTime, dateLocale, appLanguage, timeFormat === '24h' ? false : true)}
            {flight.aircraftName && (
              <span className={`px-2 py-0.5 rounded-full text-xs border ${flight.droneSerial && isDecommissioned(getDroneDisplayName(flight.droneSerial, flight.aircraftName || flight.droneModel || ''))
                ? 'border-gray-500/40 text-gray-400 bg-gray-500/15'
                : 'border-drone-primary/40 text-drone-primary bg-drone-primary/10'
                }`}>
                {t('flightStats.device')} {flight.aircraftName}
              </span>
            )}
            {flight.droneSerial && (
              <span className={`px-2 py-0.5 rounded-full text-xs border ${isDecommissioned(getDroneDisplayName(flight.droneSerial, flight.aircraftName || flight.droneModel || ''))
                ? 'border-gray-500/40 text-gray-400 bg-gray-500/15'
                : 'border-gray-600/60 text-gray-400 bg-drone-surface/60'
                }`}>
                {t('flightStats.sn')} {getDisplaySerial(flight.droneSerial)}
              </span>
            )}
            {flight.batterySerial && (
              <span className={`px-2 py-0.5 rounded-full text-xs border ${batteryCapsuleIsDecommissioned
                ? 'border-gray-500/40 text-gray-400 bg-gray-500/15'
                : 'border-drone-accent/40 text-drone-accent bg-drone-accent/10'
                }`}>
                {t('flightStats.battery')} {batteryCapsuleLabel}
              </span>
            )}
            {flight.rcSerial && (
              <span className="px-2 py-0.5 rounded-full text-xs border border-purple-500/40 text-purple-400 bg-purple-500/10">
                {t('flightStats.controller')} {getDisplaySerial(flight.rcSerial)}
              </span>
            )}
            {/* Flight Tags */}
            {flightTags.map((tagObj) => {
              const tagName = typeof tagObj === 'string' ? tagObj : tagObj.tag;
              const tagType = typeof tagObj === 'string' ? 'auto' : tagObj.tagType;
              const isAuto = tagType === 'auto';
              return (
                <span
                  key={tagName}
                  className={`group relative px-2 py-0.5 rounded-full text-xs border cursor-default ${isAuto
                    ? 'border-teal-500/40 text-teal-300 bg-teal-500/10'
                    : 'border-violet-500/40 text-violet-300 bg-violet-500/10'
                    }`}
                >
                  {tagName}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTag(flight.id, tagName);
                    }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-red-400"
                    title={t('flightStats.removeTag', { name: tagName })}
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </span>
              );
            })}
            {/* Add tag button */}
            <div ref={addTagContainerRef} className="relative inline-flex">
              {isAddingTag ? (
                <div className="flex items-center gap-1">
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={newTagValue}
                    onChange={(e) => setNewTagValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTagValue.trim()) {
                        handleAddTag(newTagValue);
                      } else if (e.key === 'Escape') {
                        setIsAddingTag(false);
                        setNewTagValue('');
                      }
                    }}
                    placeholder={t('flightStats.tagName')}
                    className="h-6 w-28 text-xs px-2 rounded-full bg-drone-surface border border-gray-600 text-gray-200 focus:outline-none focus:border-violet-500"
                  />
                  {tagSuggestions.length > 0 && (
                    <div className="absolute left-0 top-full mt-1 z-50 w-40 rounded-lg border border-gray-700 bg-drone-surface shadow-xl max-h-40 overflow-auto">
                      {tagSuggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => handleAddTag(suggestion)}
                          className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-violet-500/20 hover:text-violet-200 transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsAddingTag(true)}
                  className="w-5 h-5 rounded-full border border-dashed border-gray-500 text-gray-400 flex items-center justify-center hover:border-violet-400 hover:text-violet-400 transition-colors"
                  title={t('flightStats.addTag')}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="text-left md:text-right self-start md:self-auto">
          <p className="text-xs text-gray-500">
            {flight.pointCount?.toLocaleString(locale) || 0} {t('flightStats.dataPoints')}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="flex flex-wrap xl:grid xl:grid-cols-[repeat(5,minmax(0,1fr))_0.8fr_0.8fr_auto_auto] gap-2">
        <div className="flex-1 min-w-[120px] xl:min-w-0">
          <StatCard
            label={t('flightStats.duration')}
            value={formatDuration(flight.durationSecs)}
            icon={<ClockIcon />}
          />
        </div>
        <div className="flex-1 min-w-[120px] xl:min-w-0">
          <StatCard
            label={t('flightStats.distance')}
            value={formatDistance(flight.totalDistance, unitPrefs.distance, locale)}
            icon={<DistanceIcon />}
          />
        </div>
        <div className="flex-1 min-w-[120px] xl:min-w-0">
          <StatCard
            label={t('flightStats.maxHeight')}
            value={formatAltitude(flight.maxAltitude, unitPrefs.altitude, locale)}
            icon={<AltitudeIcon />}
          />
        </div>
        <div className="flex-1 min-w-[120px] xl:min-w-0">
          <StatCard
            label={t('flightStats.maxSpeed')}
            value={formatSpeed(flight.maxSpeed, unitPrefs.speed, locale)}
            icon={<SpeedIcon />}
          />
        </div>
        <div className="flex-1 min-w-[120px] xl:min-w-0">
          <StatCard
            label={t('flightStats.minBattery')}
            value={
              maxBattery !== null && minBattery !== null ? (
                <span className="whitespace-nowrap">
                  <span className={getBatteryLevelColorClass(maxBattery)}>{maxBattery}%</span>
                  <span className="mx-1 text-gray-400">—</span>
                  <span className={getBatteryLevelColorClass(minBattery)}>{minBattery}%</span>
                </span>
              ) : (
                '--'
              )
            }
            icon={<BatteryIcon />}
          />
        </div>
        <div className="flex-1 min-w-[100px] xl:min-w-0">
          <StatCard
            label={t('flightStats.photos')}
            value={(flight.photoCount ?? 0).toLocaleString(locale)}
            icon={<CameraIcon />}
          />
        </div>
        <div className="flex-1 min-w-[100px] xl:min-w-0">
          <StatCard
            label={t('flightStats.videos')}
            value={(flight.videoCount ?? 0).toLocaleString(locale)}
            icon={<VideoIcon />}
          />
        </div>
        {/* Weather button */}
        <div className="flex justify-center xl:block">
          <button
            type="button"
            onClick={() => setIsWeatherOpen(true)}
            disabled={!flight.homeLat || !flight.homeLon || !flight.startTime}
            title={t('flightStats.flightWeather')}
            className="h-full min-h-[52px] w-[62px] flex items-center justify-center rounded-lg border-2 border-drone-primary/70 text-drone-primary transition-all duration-200 hover:bg-drone-primary hover:text-white hover:shadow-md disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-drone-primary"
          >
            <WeatherBtnIcon />
          </button>
        </div>
        <div className="relative flex-1 xl:flex-none justify-self-stretch xl:justify-self-end">
          <button
            type="button"
            onClick={() => setIsExportOpen((open) => !open)}
            className="w-full xl:w-[126px] h-full min-h-[52px] flex items-center justify-center gap-2 rounded-lg border-2 border-drone-accent/70 text-drone-accent text-sm font-semibold px-2 transition-all duration-200 hover:bg-drone-accent hover:text-white hover:shadow-md"
          >
            <ExportIcon />
            {isExporting ? t('flightStats.exporting') : t('flightStats.export')}
            <ChevronIcon />
          </button>
          {isExportOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setIsExportOpen(false)}
              />
              <div className="themed-select-dropdown absolute right-0 top-full z-50 mt-2 w-40 rounded-xl border border-gray-700 p-1 shadow-xl">
                {exportOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setIsExportOpen(false);
                      if (option.id === 'html_report') {
                        setShowHtmlReportModal(true);
                      } else {
                        handleExport(option.id, option.extension);
                      }
                    }}
                    className="themed-select-option w-full text-left px-3 py-2 text-xs rounded-lg transition-colors"
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Weather Modal */}
      {flight.homeLat != null && flight.homeLon != null && flight.startTime && (
        <WeatherModal
          isOpen={isWeatherOpen}
          onClose={() => setIsWeatherOpen(false)}
          lat={flight.homeLat}
          lon={flight.homeLon}
          startTime={flight.startTime}
          temperatureUnit={unitPrefs.temperature}
          speedUnit={unitPrefs.speed}
        />
      )}

      {/* HTML Report Modal */}
      <HtmlReportModal
        isOpen={showHtmlReportModal}
        onClose={() => setShowHtmlReportModal(false)}
        onGenerate={handleHtmlReportExport}
        flightCount={1}
      />
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  alert?: boolean;
}

function StatCard({ label, value, icon, alert }: StatCardProps) {
  return (
    <div className="bg-drone-surface/50 rounded-lg px-3 py-2 border border-gray-700/50 text-center">
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center justify-center gap-2">
          <div className={`${alert ? 'text-red-400' : 'text-drone-primary'}`}>
            {icon}
          </div>
          <p
            className={`ui-data text-lg ${alert ? 'text-red-400' : 'text-white'
              }`}
          >
            {value}
          </p>
        </div>
        <p className="ui-stat-label text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function ClockIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function DistanceIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
      />
    </svg>
  );
}

function AltitudeIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M7 11l5-5m0 0l5 5m-5-5v12"
      />
    </svg>
  );
}

function SpeedIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 4h-3V2h-4v2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V6a2 2 0 00-2-2zM7 22V6h10v16H7z" />
      <rect x="8" y="10" width="8" height="10" rx="1" />
    </svg>
  );
}

function getBatteryLevelColorClass(level: number): string {
  if (level <= 15) return 'text-red-400';
  if (level <= 30) return 'text-orange-400';
  if (level <= 50) return 'text-yellow-400';
  return 'text-green-400';
}

function ExportIcon() {
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
        d="M12 5v10m0 0l-4-4m4 4l4-4M4 19h16"
      />
    </svg>
  );
}

function ChevronIcon() {
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
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );
}

function WeatherBtnIcon() {
  return <img src={weatherIcon} alt="Weather" className="w-[25px] h-[25px]" />;
}

function CameraIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
      />
      <circle cx="12" cy="13" r="3" strokeWidth={2} />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

