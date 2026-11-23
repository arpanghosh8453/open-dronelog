/**
 * Overview panel with comprehensive flight statistics
 * Features: activity heatmap, donut charts, battery health, top flights
 * Uses sidebar filters from the flight list for all calculations
 */

import { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ReactECharts from 'echarts-for-react';
import { type DateRange } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import type { Flight, OverviewStats } from '@/types';
import {
  downloadFile,
  getBatteryFullCapacityHistory,
  getFlightData,
  isWebMode,
  saveTextWithDialog,
} from '@/lib/api';
import {
  buildBatterySummaryCsv,
  getBatterySummaryFilename,
  summarizeBatteryFlight,
} from '@/lib/exportUtils';
import type { BatteryFlightSummary } from '@/lib/exportUtils';
import {
  getBatteryGroupKey,
  getBatteryGroupMembers,
  getPairedBatteryDisplayName,
  useBatteryPairIndex,
} from '@/lib/batteryPairs';
import type { BatteryPairIndex } from '@/lib/batteryPairs';
import {
  formatDistance,
  formatDuration,
  formatSpeed,
  formatAltitude,
  formatDateTime,
  formatDateDisplay as fmtDateDisplay,
  formatDateNumeric,
  normalizeSerial,
  isDecommissioned,
  type UnitPreferences,
} from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';
import { chartFontFamily, chartSeriesColors, getChartTheme } from '@/lib/chartTheme';
import { FlightClusterMap } from './FlightClusterMap';
import { EmailSignatureModal } from './EmailSignatureModal';
import { DatePickerPopover } from '@/components/ui/DatePickerPopover';

function resolveThemeMode(mode: 'system' | 'dark' | 'light'): 'dark' | 'light' {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return 'dark';
  }
  return mode;
}

interface OverviewProps {
  stats: OverviewStats;
  flights: Flight[];
  unitPrefs: UnitPreferences;
  onSelectFlight?: (flightId: number) => void;
}

export function Overview({ stats, flights, unitPrefs, onSelectFlight }: OverviewProps) {
  const { t } = useTranslation();
  const locale = useFlightStore((state) => state.locale);
  const dateLocale = useFlightStore((state) => state.dateLocale);
  const appLanguage = useFlightStore((state) => state.appLanguage);
  const timeFormat = useFlightStore((state) => state.timeFormat);
  const themeMode = useFlightStore((state) => state.themeMode);
  const getBatteryDisplayName = useFlightStore((state) => state.getBatteryDisplayName);
  const renameBattery = useFlightStore((state) => state.renameBattery);
  const getDroneDisplayName = useFlightStore((state) => state.getDroneDisplayName);
  const renameDrone = useFlightStore((state) => state.renameDrone);
  const droneNameMap = useFlightStore((state) => state.droneNameMap);
  const batteryNameMap = useFlightStore((state) => state.batteryNameMap);
  const sidebarFilteredFlightIds = useFlightStore((state) => state.sidebarFilteredFlightIds);
  const getDisplaySerial = useFlightStore((state) => state.getDisplaySerial);
  const hideSerialNumbers = useFlightStore((state) => state.hideSerialNumbers);
  const overviewHighlightedFlightId = useFlightStore((state) => state.overviewHighlightedFlightId);
  const setHeatmapDateFilter = useFlightStore((state) => state.setHeatmapDateFilter);
  const maintenanceThresholds = useFlightStore((state) => state.maintenanceThresholds);
  const maintenanceLastReset = useFlightStore((state) => state.maintenanceLastReset);
  const setMaintenanceThreshold = useFlightStore((state) => state.setMaintenanceThreshold);
  const performMaintenance = useFlightStore((state) => state.performMaintenance);
  const supporterBadgeActive = useFlightStore((state) => state.supporterBadgeActive);
  const batteryPairIndex = useBatteryPairIndex();
  const resolvedTheme = useMemo(() => resolveThemeMode(themeMode), [themeMode]);
  const [showSignatureModal, setShowSignatureModal] = useState(false);

  // Use sidebar-filtered flights (fall back to all flights if no filter set yet)
  const filteredFlights = useMemo(() => {
    if (!sidebarFilteredFlightIds) return flights;
    return flights.filter((f) => sidebarFilteredFlightIds.has(f.id));
  }, [flights, sidebarFilteredFlightIds]);

  // Compute filtered stats
  const filteredStats = useMemo(() => {
    const totalFlights = filteredFlights.length;
    const totalDistanceM = filteredFlights.reduce((sum, f) => sum + (f.totalDistance ?? 0), 0);
    const totalDurationSecs = filteredFlights.reduce((sum, f) => sum + (f.durationSecs ?? 0), 0);
    const totalPhotos = filteredFlights.reduce((sum, f) => sum + (f.photoCount ?? 0), 0);
    const totalVideos = filteredFlights.reduce((sum, f) => sum + (f.videoCount ?? 0), 0);
    let maxAltitudeM = 0;
    let maxSpeedMs = 0;
    for (const f of filteredFlights) {
      if ((f.maxAltitude ?? 0) > maxAltitudeM) maxAltitudeM = f.maxAltitude!;
      if ((f.maxSpeed ?? 0) > maxSpeedMs) maxSpeedMs = f.maxSpeed!;
    }

    // Battery usage (normalize serials for consistent aggregation)
    const batteryMap = new Map<string, { count: number; duration: number; maxCycleCount: number | null }>();
    filteredFlights.forEach((f) => {
      const serial = normalizeSerial(f.batterySerial);
      if (serial) {
        const existing = batteryMap.get(serial) || { count: 0, duration: 0, maxCycleCount: null as number | null };
        const newMaxCycle = f.cycleCount != null
          ? (existing.maxCycleCount != null ? Math.max(existing.maxCycleCount, f.cycleCount) : f.cycleCount)
          : existing.maxCycleCount;
        batteryMap.set(serial, {
          count: existing.count + 1,
          duration: existing.duration + (f.durationSecs ?? 0),
          maxCycleCount: newMaxCycle,
        });
      }
    });

    // Pair-aware aggregation: each serial keeps its own row, but values include its paired battery.
    const mergedBySerial = new Map<string, { count: number; duration: number; maxCycleCount: number | null }>();
    for (const serial of batteryMap.keys()) {
      const members = getBatteryGroupMembers(serial, batteryPairIndex);
      const relevant = members.length > 0 ? members : [serial];
      let count = 0;
      let duration = 0;
      let maxCycleCount: number | null = null;
      for (const member of relevant) {
        const usage = batteryMap.get(member);
        if (!usage) continue;
        count += usage.count;
        duration += usage.duration;
        if (usage.maxCycleCount != null) {
          maxCycleCount = maxCycleCount != null ? Math.max(maxCycleCount, usage.maxCycleCount) : usage.maxCycleCount;
        }
      }
      mergedBySerial.set(serial, { count, duration, maxCycleCount });
    }

    const batteriesUsed = Array.from(mergedBySerial.entries())
      .map(([serial, data]) => ({
        batterySerial: serial,
        flightCount: data.count,
        totalDurationSecs: data.duration,
        maxCycleCount: data.maxCycleCount,
      }))
      .sort((a, b) => {
        // Decommissioned batteries go to the bottom
        const aDisplay = getPairedBatteryDisplayName(a.batterySerial, batteryPairIndex, getBatteryDisplayName);
        const bDisplay = getPairedBatteryDisplayName(b.batterySerial, batteryPairIndex, getBatteryDisplayName);
        const aDecom = isDecommissioned(aDisplay);
        const bDecom = isDecommissioned(bDisplay);
        if (aDecom !== bDecom) return aDecom ? 1 : -1;
        // Sort by health percentage (lowest first = needs attention first)
        const maxCycles = 400;
        const healthA = a.maxCycleCount != null
          ? Math.max(0, 100 - (a.maxCycleCount / maxCycles) * 100)
          : Math.max(0, 100 - (a.flightCount / maxCycles) * 100);
        const healthB = b.maxCycleCount != null
          ? Math.max(0, 100 - (b.maxCycleCount / maxCycles) * 100)
          : Math.max(0, 100 - (b.flightCount / maxCycles) * 100);
        return healthA - healthB;
      });

    // Drone usage with disambiguation for same model names (normalize serials)
    const droneMap = new Map<string, { model: string; serial: string | null; name: string | null; count: number; totalDurationSecs: number }>();
    filteredFlights.forEach((f) => {
      const serial = normalizeSerial(f.droneSerial);
      // Use serial as the unique key if available, otherwise fall back to model
      const key = serial || `model:${f.droneModel ?? 'Unknown'}`;
      const existing = droneMap.get(key);
      if (existing) {
        existing.count++;
        existing.totalDurationSecs += f.durationSecs ?? 0;
        // Keep the first non-null aircraft name encountered
        if (!existing.name && f.aircraftName) {
          existing.name = f.aircraftName;
        }
        // Prefer a more specific model name if available
        if (f.droneModel && existing.model === 'Unknown') {
          existing.model = f.droneModel;
        }
      } else {
        droneMap.set(key, {
          model: f.droneModel ?? 'Unknown',
          serial: serial || null,
          name: f.aircraftName ?? null,
          count: 1,
          totalDurationSecs: f.durationSecs ?? 0,
        });
      }
    });

    // Check if any display names are duplicated (using renamed names)
    const modelCounts = new Map<string, number>();
    droneMap.forEach((d) => {
      const fallback = d.name || d.model;
      const displayName = d.serial ? getDroneDisplayName(d.serial, fallback) : fallback;
      modelCounts.set(displayName, (modelCounts.get(displayName) || 0) + 1);
    });

    const dronesUsed = Array.from(droneMap.entries())
      .map(([_, data]) => {
        const fallback = data.name || data.model;
        const displayName = data.serial ? getDroneDisplayName(data.serial, fallback) : fallback;
        const needsSerial = (modelCounts.get(displayName) || 0) > 1 && data.serial;
        return {
          droneModel: data.model,
          droneSerial: data.serial,
          aircraftName: data.name,
          flightCount: data.count,
          totalDurationSecs: data.totalDurationSecs,
          displayLabel: needsSerial ? `${displayName} (${getDisplaySerial(data.serial!)})` : displayName,
        };
      })
      .sort((a, b) => {
        const aDecom = isDecommissioned(a.displayLabel);
        const bDecom = isDecommissioned(b.displayLabel);
        if (aDecom !== bDecom) return aDecom ? 1 : -1;
        return b.totalDurationSecs - a.totalDurationSecs;
      });

    // Flights by date (from filtered)
    const dateMap = new Map<string, number>();
    const pad = (value: number) => String(value).padStart(2, '0');
    const toDateKey = (value: string) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value.split('T')[0];
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    filteredFlights.forEach((f) => {
      if (f.startTime) {
        const date = toDateKey(f.startTime);
        dateMap.set(date, (dateMap.get(date) || 0) + 1);
      }
    });
    const flightsByDate = Array.from(dateMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const filteredIdSet = new Set(filteredFlights.map((f) => f.id));

    // Top 3 longest flights
    const topFlights = [...filteredFlights]
      .filter((f) => f.durationSecs !== null)
      .sort((a, b) => (b.durationSecs ?? 0) - (a.durationSecs ?? 0))
      .slice(0, 3)
      .map((f) => ({
        id: f.id,
        displayName: f.displayName || f.fileName,
        durationSecs: f.durationSecs ?? 0,
        startTime: f.startTime,
      }));


    // For max distance from home, compute from per-flight data (works with filters)
    const maxDistanceFromHomeM = stats.topDistanceFlights
      ? stats.topDistanceFlights
        .filter((df) => filteredIdSet.has(df.id))
        .reduce((max, df) => Math.max(max, df.maxDistanceFromHomeM), 0)
      : stats.maxDistanceFromHomeM;

    return {
      totalFlights,
      totalDistanceM,
      totalDurationSecs,
      totalPhotos,
      totalVideos,
      maxAltitudeM,
      maxSpeedMs,
      maxDistanceFromHomeM,
      batteriesUsed,
      dronesUsed,
      flightsByDate,
      topFlights,
    };
  }, [filteredFlights, stats.maxDistanceFromHomeM, stats.topDistanceFlights, getDroneDisplayName, droneNameMap, getBatteryDisplayName, batteryNameMap, getDisplaySerial, hideSerialNumbers, batteryPairIndex]);

  const droneDonutData = useMemo(() => {
    const ranked = filteredStats.dronesUsed.map(d => ({
      name: d.droneSerial ? `drone:${d.droneSerial}` : `drone-model:${d.droneModel}:${d.displayLabel}`,
      displayName: d.displayLabel,
      value: d.flightCount,
      decommissioned: isDecommissioned(d.displayLabel),
    })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    const topDrones = ranked.slice(0, 15);
    const remaining = ranked.slice(15);
    if (remaining.length) topDrones.push({
      name: 'drone-other',
      displayName: t('overview.otherDrones'),
      value: remaining.reduce((sum, drone) => sum + drone.value, 0),
      decommissioned: false,
    });
    return topDrones;
  }, [filteredStats.dronesUsed, t]);

  const batteryDonutData = useMemo(() => {
    const grouped = new Map<string, { value: number; displayName: string; decommissioned: boolean }>();
    for (const battery of filteredStats.batteriesUsed) {
      const groupKey = getBatteryGroupKey(battery.batterySerial, batteryPairIndex);
      if (grouped.has(groupKey)) continue;
      const label = getPairedBatteryDisplayName(battery.batterySerial, batteryPairIndex, getBatteryDisplayName);
      grouped.set(groupKey, {
        value: battery.flightCount,
        displayName: label,
        decommissioned: isDecommissioned(label),
      });
    }
    const ranked = Array.from(grouped.entries()).map(([groupKey, item]) => ({
      name: `battery-group:${groupKey}`,
      displayName: item.displayName,
      value: item.value,
      decommissioned: item.decommissioned,
    })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    const topBatteries = ranked.slice(0, 15);
    const remaining = ranked.slice(15);
    if (remaining.length > 0) {
      topBatteries.push({
        name: 'battery-other',
        displayName: t('overview.otherBatteries'),
        value: remaining.reduce((sum, battery) => sum + battery.value, 0),
        decommissioned: false,
      });
    }
    return topBatteries;
  }, [filteredStats.batteriesUsed, batteryPairIndex, getBatteryDisplayName, t]);

  const filteredTopDistanceFlights = useMemo(() => {
    if (!stats.topDistanceFlights?.length) return [] as typeof stats.topDistanceFlights;
    const idSet = new Set(filteredFlights.map((flight) => flight.id));
    return stats.topDistanceFlights
      .filter((flight) => idSet.has(flight.id))
      .sort((a, b) => b.maxDistanceFromHomeM - a.maxDistanceFromHomeM)
      .slice(0, 3);
  }, [filteredFlights, stats.topDistanceFlights]);

  const avgDistancePerFlight =
    filteredStats.totalFlights > 0
      ? filteredStats.totalDistanceM / filteredStats.totalFlights
      : 0;
  const avgDurationPerFlight =
    filteredStats.totalFlights > 0
      ? filteredStats.totalDurationSecs / filteredStats.totalFlights
      : 0;
  const avgSpeed =
    filteredStats.totalDurationSecs > 0
      ? filteredStats.totalDistanceM / filteredStats.totalDurationSecs
      : 0;

  return (
    <div className="w-full min-w-0 md:min-w-[700px] lg:min-w-[1100px] px-4 pt-4 pb-24 space-y-5">
      {/* Pilot Milestone Timeline */}
      <PilotMilestoneTimeline totalHours={filteredStats.totalDurationSecs / 3600} onGetSignature={() => setShowSignatureModal(true)} />

      {/* Primary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        <StatCard label={t('overview.totalFlights')} value={filteredStats.totalFlights.toLocaleString(locale)} icon={<FlightIcon />} />
        <StatCard label={t('overview.totalDistance')} value={formatDistance(filteredStats.totalDistanceM, unitPrefs.distance, locale)} icon={<DistanceIcon />} />
        <StatCard label={t('overview.totalTime')} value={formatDuration(filteredStats.totalDurationSecs)} icon={<ClockIcon />} />
        <StatCard label={t('overview.totalPhotos')} value={filteredStats.totalPhotos.toLocaleString(locale)} icon={<CameraIcon />} />
        <StatCard className="col-span-2 sm:col-span-1 md:col-span-1" label={t('overview.totalVideos')} value={filteredStats.totalVideos.toLocaleString(locale)} icon={<VideoIcon />} />
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
        <StatCard label={t('overview.maxAltitude')} value={formatAltitude(filteredStats.maxAltitudeM, unitPrefs.altitude, locale)} icon={<AltitudeIcon />} small />
        <StatCard label={t('overview.maxSpeedAchieved')} value={formatSpeed(filteredStats.maxSpeedMs, unitPrefs.speed, locale)} icon={<LightningIcon />} small />
        <StatCard
          label={t('overview.maxDistFromHome')}
          value={formatDistance(filteredStats.maxDistanceFromHomeM, unitPrefs.distance, locale)}
          icon={<HomeDistanceIcon />}
          small
        />
        <StatCard label={t('overview.avgDistPerFlight')} value={formatDistance(avgDistancePerFlight, unitPrefs.distance, locale)} icon={<RouteIcon />} small />
        <StatCard label={t('overview.avgDurationPerFlight')} value={formatDuration(avgDurationPerFlight)} icon={<TimerIcon />} small />
        <StatCard label={t('overview.avgSpeed')} value={formatSpeed(avgSpeed, unitPrefs.speed, locale)} icon={<SpeedometerIcon />} small />
      </div>

      {/* Activity Heatmap + Drone Flight Time Row */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-[60%_minmax(0,1fr)] min-h-[240px]">
        {/* Activity Heatmap */}
        <ActivityHeatmapCard
          flightsByDate={filteredStats.flightsByDate}
          isLight={resolvedTheme === 'light'}
          onDateDoubleClick={setHeatmapDateFilter}
        />

        {/* Drone Flight Time */}
        <DroneFlightTimeList
          drones={filteredStats.dronesUsed}
          isLight={resolvedTheme === 'light'}
          getDroneDisplayName={getDroneDisplayName}
          renameDrone={renameDrone}
          getDisplaySerial={getDisplaySerial}
          hideSerialNumbers={hideSerialNumbers}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Drone Model Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">{t('overview.flightsByDrone')}</h3>
          <DonutChart
            data={droneDonutData}
            emptyMessage={t('overview.noDroneData')}
          />
        </div>

        {/* Battery Usage Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">{t('overview.flightsByBattery')}</h3>
          <DonutChart
            data={batteryDonutData}
            emptyMessage={t('overview.noBatteryData')}
          />
        </div>

        {/* Flights by Duration Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">{t('overview.flightsByDuration')}</h3>
          <DonutChart
            data={(() => {
              let short = 0, mid = 0, long = 0;
              filteredFlights.forEach((f) => {
                const dur = f.durationSecs ?? 0;
                if (dur < 600) short++;
                else if (dur < 1200) mid++;
                else long++;
              });
              return [
                { name: t('overview.shortDuration'), value: short },
                { name: t('overview.midDuration'), value: mid },
                { name: t('overview.longDuration'), value: long },
              ].filter((d) => d.value > 0);
            })()}
            emptyMessage={t('overview.noFlightData')}
          />
        </div>

        {/* Time of Day Radial Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">{t('overview.flightsByTimeOfDay')}</h3>
          <FlightTimeRadialChart
            flights={filteredFlights}
            emptyMessage={t('overview.noFlightData')}
          />
        </div>
      </div>

      {/* Flight Locations Cluster Map */}
      <div id="overview-cluster-map">
        <FlightClusterMap
          flights={filteredFlights}
          allFlights={flights}
          unitPrefs={unitPrefs}
          themeMode={themeMode}
          onSelectFlight={onSelectFlight}
          highlightedFlightId={overviewHighlightedFlightId}
        />
      </div>

      {/* Battery Health & Top Flights Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Battery Health Indicators */}
        <div className="card p-4">
          <BatteryHealthList
            batteries={filteredStats.batteriesUsed}
            filteredFlights={filteredFlights}
            isLight={resolvedTheme === 'light'}
            getBatteryDisplayName={getBatteryDisplayName}
            batteryNameMap={batteryNameMap}
            renameBattery={renameBattery}
            hideSerialNumbers={hideSerialNumbers}
          />
        </div>

        {/* Top 3 Longest Flights */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">{t('overview.top3Longest')}</h3>
          {filteredStats.topFlights.length === 0 ? (
            <p className="text-sm text-gray-400">{t('overview.noFlightsAvailable')}</p>
          ) : (
            <div className="space-y-2">
              {filteredStats.topFlights.map((flight, index) => (
                <div
                  key={flight.id}
                  onClick={() => onSelectFlight?.(flight.id)}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-700/30 cursor-pointer transition-colors"
                >
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${index === 0
                      ? 'bg-yellow-500/20 text-yellow-400'
                      : index === 1
                        ? 'bg-gray-400/20 text-gray-300'
                        : 'bg-amber-700/20 text-amber-600'
                      }`}
                  >
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{flight.displayName}</p>
                    <p className="text-xs text-gray-400">{formatDateTime(flight.startTime, dateLocale, appLanguage, timeFormat !== '24h')}</p>
                  </div>
                  <div className="text-sm font-medium text-drone-accent">
                    {formatDuration(flight.durationSecs)}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-white mb-3">{t('overview.top3Furthest')}</h3>
            {filteredTopDistanceFlights.length === 0 ? (
              <p className="text-sm text-gray-400">{t('overview.noFlightsAvailable')}</p>
            ) : (
              <div className="space-y-2">
                {filteredTopDistanceFlights.map((flight, index) => (
                  <div
                    key={flight.id}
                    onClick={() => onSelectFlight?.(flight.id)}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-700/30 cursor-pointer transition-colors"
                  >
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${index === 0
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : index === 1
                          ? 'bg-gray-400/20 text-gray-300'
                          : 'bg-amber-700/20 text-amber-600'
                        }`}
                    >
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{flight.displayName}</p>
                      <p className="text-xs text-gray-400">{formatDateTime(flight.startTime, dateLocale, appLanguage, timeFormat !== '24h')}</p>
                    </div>
                    <div className="text-sm font-medium text-drone-accent">
                      {formatDistance(flight.maxDistanceFromHomeM, unitPrefs.distance, locale)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Maintenance Section */}
      <MaintenanceSection
        batteries={filteredStats.batteriesUsed}
        drones={filteredStats.dronesUsed}
        flights={filteredFlights}
        isLight={resolvedTheme === 'light'}
        getBatteryDisplayName={getBatteryDisplayName}
        getDroneDisplayName={getDroneDisplayName}
        batteryPairIndex={batteryPairIndex}
        maintenanceThresholds={maintenanceThresholds}
        maintenanceLastReset={maintenanceLastReset}
        setMaintenanceThreshold={setMaintenanceThreshold}
        performMaintenance={performMaintenance}
      />

      {/* Donation Note */}
      {/* Email Signature Modal */}
      {showSignatureModal && (
        <EmailSignatureModal
          totalFlights={filteredStats.totalFlights}
          totalDurationSecs={filteredStats.totalDurationSecs}
          totalPhotos={filteredStats.totalPhotos}
          totalVideos={filteredStats.totalVideos}
          currentRank={(() => {
            const hrs = filteredStats.totalDurationSecs / 3600;
            const RANKS = [
              { hours: 0, label: 'Beginner' },
              { hours: 5, label: 'Novice' },
              { hours: 20, label: 'Intermediate' },
              { hours: 50, label: 'Advanced' },
              { hours: 100, label: 'Expert' },
              { hours: 200, label: 'Legendary' },
            ];
            for (let i = RANKS.length - 1; i >= 0; i--) {
              if (hrs >= RANKS[i].hours) return t(`overview.${RANKS[i].label.toLowerCase()}`);
            }
            return t('overview.beginner');
          })()}
          onClose={() => setShowSignatureModal(false)}
        />
      )}

      {!supporterBadgeActive && (
        <div className="mt-6 mb-2 mx-auto max-w-4xl rounded-lg border border-gray-200 dark:border-gray-700/50 bg-gray-50 dark:bg-white/[0.03] px-5 py-4 sm:px-8">
          <p className="text-center text-xs leading-relaxed text-gray-500 dark:text-gray-500 sm:text-sm">
            {t('overview.donationNote')}{' '}
            <a
              href="https://ko-fi.com/arpandesign"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-amber-500 hover:text-amber-400 underline underline-offset-2"
            >
              Ko-fi
            </a>
            {' '}{t('overview.donationNoteSuffix')}
          </p>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function StatCard({
  label,
  value,
  icon,
  small,
  className = '',
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  small?: boolean;
  className?: string;
}) {
  return (
    <div className={`stat-card ${small ? 'py-3' : ''} ${className}`}>
      {icon && <div className="text-drone-primary mb-1">{icon}</div>}
      <span className={small ? 'ui-data text-lg text-white' : 'stat-value'}>{value}</span>
      <span className={small ? 'text-xs text-gray-400' : 'stat-label'}>{label}</span>
    </div>
  );
}

// Milestone icon components
function MilestoneIconBeginner() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

function MilestoneIconNovice() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" strokeWidth={1.5} />
      <circle cx="12" cy="12" r="8" strokeWidth={1.5} strokeDasharray="4 2" />
    </svg>
  );
}

function MilestoneIconIntermediate() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}

function MilestoneIconAdvanced() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  );
}

function MilestoneIconExpert() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  );
}

function MilestoneIconLegendary() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3l3.5 3L12 3l3.5 3L19 3v13a2 2 0 01-2 2H7a2 2 0 01-2-2V3z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 22v-4" />
      <circle cx="12" cy="10" r="2" strokeWidth={1.5} />
    </svg>
  );
}

// Pilot milestone data
const MILESTONES = [
  { hours: 0, label: 'Beginner', icon: MilestoneIconBeginner, description: 'First flight awaits!' },
  { hours: 5, label: 'Novice', icon: MilestoneIconNovice, description: 'Learning the basics' },
  { hours: 20, label: 'Intermediate', icon: MilestoneIconIntermediate, description: 'Building confidence' },
  { hours: 50, label: 'Advanced', icon: MilestoneIconAdvanced, description: 'Skilled aviator' },
  { hours: 100, label: 'Expert', icon: MilestoneIconExpert, description: 'Seasoned pilot' },
  { hours: 200, label: 'Legendary', icon: MilestoneIconLegendary, description: 'Master of the skies' },
];

function PilotMilestoneTimeline({ totalHours, onGetSignature }: { totalHours: number; onGetSignature?: () => void }) {
  const { t } = useTranslation();
  // Calculate current milestone index and progress within segment
  const currentMilestoneIndex = useMemo(() => {
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
      if (totalHours >= MILESTONES[i].hours) return i;
    }
    return 0;
  }, [totalHours]);

  const currentMilestone = MILESTONES[currentMilestoneIndex];
  const nextMilestone = MILESTONES[currentMilestoneIndex + 1];

  // Calculate segment progress (0-100) for each segment
  const getSegmentProgress = (segmentIndex: number) => {
    const segmentStart = MILESTONES[segmentIndex].hours;
    const segmentEnd = MILESTONES[segmentIndex + 1]?.hours ?? segmentStart;

    if (totalHours <= segmentStart) return 0;
    if (totalHours >= segmentEnd) return 100;

    return ((totalHours - segmentStart) / (segmentEnd - segmentStart)) * 100;
  };

  // Format hours display
  const formatHours = (hours: number) => {
    if (hours >= 1) return `${hours.toFixed(1)}h`;
    const mins = Math.round(hours * 60);
    return `${mins}m`;
  };

  return (
    <div className="milestone-timeline milestone-card rounded-xl px-6 py-3 mb-5">
      {/* Single-line timeline with labels */}
      <div className="flex items-center gap-4">
        {/* Current rank icon */}
        <div className="text-drone-primary flex-shrink-0">
          <currentMilestone.icon />
        </div>

        {/* Timeline Track */}
        <div className="relative flex-1 h-10">
          {/* Background track - centered vertically */}
          <div className="milestone-track absolute left-0 right-0 h-1.5 rounded-full top-1" />

          {/* Filled segments - centered vertically */}
          <div className="absolute left-0 right-0 h-1.5 flex top-1">
            {MILESTONES.slice(0, -1).map((_, idx) => {
              const progress = getSegmentProgress(idx);
              const segmentWidth = 100 / (MILESTONES.length - 1);
              return (
                <div
                  key={idx}
                  className="relative h-full"
                  style={{ width: `${segmentWidth}%` }}
                >
                  {progress > 0 && (
                    <div
                      className="milestone-fill absolute left-0 top-0 h-full rounded-full"
                      style={{ width: `${progress}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Milestone nodes with labels */}
          <div className="absolute left-0 right-0 top-0 flex justify-between">
            {MILESTONES.map((milestone, idx) => {
              const isCompleted = totalHours >= milestone.hours;
              const isActive = idx === currentMilestoneIndex;
              const isFuture = idx > currentMilestoneIndex;
              const isFirst = idx === 0;
              const isLast = idx === MILESTONES.length - 1;

              return (
                <div
                  key={idx}
                  className={`flex flex-col items-center ${isFirst ? 'items-start' : isLast ? 'items-end' : ''}`}
                  style={{ width: 0 }}
                >
                  {/* Node - positioned to center on track */}
                  <div
                    className={`milestone-node rounded-full border-2 border-drone-dark z-10 ${isActive ? 'active w-4 h-4' : 'w-3 h-3'
                      } ${isCompleted ? 'completed' : ''}`}
                    style={{ marginTop: isActive ? '-2px' : '0' }}
                  />

                  {/* Combined label - pushed down more */}
                  <div className={`mt-3 text-[10px] whitespace-nowrap ${isFuture ? 'text-gray-500' : isActive ? 'text-white font-semibold' : 'text-gray-400'
                    }`}>
                    {milestone.hours === 0 ? t('overview.start') : milestone.hours === 200 ? t('overview.hours200plus') : `${milestone.hours}h`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Next milestone info + Get Signature button */}
        <div className="flex-shrink-0 text-right hidden sm:flex sm:items-center sm:gap-3">
          <div>
            {nextMilestone ? (
              <div className="text-xs">
                <span className="text-white font-medium">{t('overview.nextRank', { label: t(`overview.${nextMilestone.label.toLowerCase()}`), time: formatHours(nextMilestone.hours - totalHours) })}</span>
              </div>
            ) : (
              <div className="text-xs text-amber-400 font-medium">{t('overview.maxRank')}</div>
            )}
            <div className="text-sm font-bold text-white">{t('overview.hoursFlown', { hours: formatHours(totalHours) })}</div>
          </div>
          {onGetSignature && (
            <button
              type="button"
              onClick={onGetSignature}
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-drone-primary/15 text-drone-primary hover:bg-drone-primary/25 border border-drone-primary/30 hover:border-drone-primary/50 transition-all"
              title={t('signature.title')}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {t('signature.getSignature')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityHeatmapCard({
  flightsByDate,
  isLight,
  onDateDoubleClick,
}: {
  flightsByDate: { date: string; count: number }[];
  isLight: boolean;
  onDateDoubleClick?: (date: Date) => void;
}) {
  const { t } = useTranslation();
  const dateLocale = useFlightStore((state) => state.dateLocale);
  const appLanguage = useFlightStore((state) => state.appLanguage);
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  oneYearAgo.setDate(oneYearAgo.getDate() + 1);

  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: oneYearAgo,
    to: today,
  });
  // Track which date is being picked: 'from' or 'to'
  const [pickingDate, setPickingDate] = useState<'from' | 'to' | null>(null);
  const fromButtonRef = useRef<HTMLButtonElement>(null);
  const toButtonRef = useRef<HTMLButtonElement>(null);
  const [dateAnchor, setDateAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    const ref = pickingDate === 'from' ? fromButtonRef.current : toButtonRef.current;
    if (pickingDate && ref) {
      const rect = ref.getBoundingClientRect();
      setDateAnchor({
        top: rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - 330), // Keep within viewport
        width: 320,
      });
    }
  }, [pickingDate]);

  const formatDate = (d: Date | undefined) => {
    if (!d) return '—';
    return fmtDateDisplay(d, dateLocale, appLanguage);
  };

  // Filter flights by date range
  const filteredByDate = useMemo(() => {
    if (!dateRange?.from || !dateRange?.to) return flightsByDate;
    const fromStr = dateRange.from.toISOString().split('T')[0];
    const toStr = dateRange.to.toISOString().split('T')[0];
    return flightsByDate.filter((f) => f.date >= fromStr && f.date <= toStr);
  }, [flightsByDate, dateRange]);

  const handleDateSelect = (date: Date | undefined) => {
    if (!date) return;

    if (pickingDate === 'from') {
      // If picking 'from' and it's after current 'to', adjust 'to'
      const newTo = dateRange?.to && date > dateRange.to ? date : dateRange?.to;
      setDateRange({ from: date, to: newTo });
    } else if (pickingDate === 'to') {
      // If picking 'to' and it's before current 'from', adjust 'from'
      const newFrom = dateRange?.from && date < dateRange.from ? date : dateRange?.from;
      setDateRange({ from: newFrom, to: date });
    }
    setPickingDate(null);
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{t('overview.flightActivity')}</h3>
        <div className="flex items-center gap-1 text-xs">
          <CalendarIcon />
          <button
            ref={fromButtonRef}
            type="button"
            onClick={() => setPickingDate(pickingDate === 'from' ? null : 'from')}
            className={`px-1.5 py-0.5 rounded transition-colors ${pickingDate === 'from'
              ? 'bg-drone-primary/20 text-drone-primary'
              : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
              }`}
            title={t('overview.selectStartDate')}
          >
            {formatDate(dateRange?.from)}
          </button>
          <span className="text-gray-500">–</span>
          <button
            ref={toButtonRef}
            type="button"
            onClick={() => setPickingDate(pickingDate === 'to' ? null : 'to')}
            className={`px-1.5 py-0.5 rounded transition-colors ${pickingDate === 'to'
              ? 'bg-drone-primary/20 text-drone-primary'
              : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
              }`}
            title={t('overview.selectEndDate')}
          >
            {formatDate(dateRange?.to)}
          </button>
        </div>
      </div>

      <DatePickerPopover
        isOpen={!!(pickingDate && dateAnchor)}
        onClose={() => setPickingDate(null)}
        isLight={isLight}
        mode="single"
        selected={pickingDate === 'from' ? dateRange?.from : dateRange?.to}
        onSelect={handleDateSelect}
        disabled={{ after: today }}
        defaultMonth={pickingDate === 'from' ? dateRange?.from : dateRange?.to}
        jumpMaxDate={today}
        onJumpDate={(date) => handleDateSelect(date)}
        title={pickingDate === 'from' ? t('overview.selectStartDate') : t('overview.selectEndDate')}
        style={dateAnchor ? {
          top: dateAnchor.top,
          left: dateAnchor.left,
          width: dateAnchor.width,
        } : undefined}
        footer={(
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setDateRange({ from: oneYearAgo, to: today });
                setPickingDate(null);
              }}
              className={`text-xs ${isLight ? 'text-gray-500 hover:text-gray-900' : 'text-gray-400 hover:text-white'}`}
            >
              {t('overview.resetTo365')}
            </button>
            <button
              type="button"
              onClick={() => setPickingDate(null)}
              className={`text-xs ${isLight ? 'text-gray-700 hover:text-gray-900' : 'text-gray-200 hover:text-white'}`}
            >
              {t('overview.done')}
            </button>
          </div>
        )}
      />

      <ActivityHeatmap
        flightsByDate={filteredByDate}
        isLight={isLight}
        dateRange={dateRange}
        onDateDoubleClick={onDateDoubleClick}
      />
    </div>
  );
}

function ActivityHeatmap({
  flightsByDate,
  isLight,
  dateRange,
  onDateDoubleClick,
}: {
  flightsByDate: { date: string; count: number }[];
  isLight: boolean;
  dateRange?: DateRange;
  onDateDoubleClick?: (date: Date) => void;
}) {
  const { t } = useTranslation();
  const dateLocale = useFlightStore((state) => state.dateLocale);
  const appLanguage = useFlightStore((state) => state.appLanguage);
  const maxWidth = 1170;
  const labelWidth = 28;
  const gapSize = 2;
  const cellSize = 13;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { grid, months, maxCount, weekCount } = useMemo(() => {
    const pad = (value: number) => String(value).padStart(2, '0');
    const toDateKey = (date: Date) => {
      const year = date.getFullYear();
      const month = pad(date.getMonth() + 1);
      const day = pad(date.getDate());
      return `${year}-${month}-${day}`;
    };

    // Build map of date -> count
    const dateMap = new Map<string, number>();
    flightsByDate.forEach((f) => dateMap.set(f.date, f.count));

    // Use date range or default to last 365 days
    const endDate = dateRange?.to ?? new Date();
    const startDateRaw = dateRange?.from ?? (() => {
      const d = new Date(endDate);
      d.setFullYear(d.getFullYear() - 1);
      d.setDate(d.getDate() + 1);
      return d;
    })();

    // Find the first Sunday on or before startDate
    const startDate = new Date(startDateRaw);
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const weeks: { date: Date; count: number }[][] = [];
    const currentDate = new Date(startDate);
    let maxCount = 0;

    while (currentDate <= endDate) {
      const week: { date: Date; count: number }[] = [];
      for (let day = 0; day < 7; day++) {
        if (currentDate <= endDate && currentDate >= startDateRaw) {
          const dateStr = toDateKey(currentDate);
          const count = dateMap.get(dateStr) || 0;
          maxCount = Math.max(maxCount, count);
          week.push({ date: new Date(currentDate), count });
        } else {
          week.push({ date: new Date(currentDate), count: -1 });
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
      weeks.push(week);
    }

    // Keep natural chronology: older weeks on the left, newer on the right.
    const displayedWeeks = weeks;

    // Extract month labels and skip labels that would collide visually.
    const months: { label: string; col: number }[] = [];
    let lastMonth = -1;
    let lastShownCol = -999;
    const minLabelGapCols = 3;
    displayedWeeks.forEach((week, weekIdx) => {
      const firstValidDay = week.find((d) => d.count >= 0);
      if (firstValidDay) {
        const month = firstValidDay.date.getMonth();
        if (month !== lastMonth) {
          if (weekIdx - lastShownCol >= minLabelGapCols) {
            months.push({
              label: firstValidDay.date.toLocaleDateString(appLanguage || 'en', { month: 'short' }),
              col: weekIdx,
            });
            lastShownCol = weekIdx;
          }
          lastMonth = month;
        }
      }
    });

    return { grid: displayedWeeks, months, maxCount, weekCount: displayedWeeks.length };
  }, [flightsByDate, dateRange]);

  useEffect(() => {
    if (!scrollRef.current) return;
    // Keep initial viewport at the leftmost edge.
    scrollRef.current.scrollLeft = 0;
  }, [weekCount, dateRange?.from?.getTime(), dateRange?.to?.getTime()]);

  const getColor = (count: number) => {
    if (count < 0) return 'transparent';
    if (count === 0) return isLight ? '#e3e7ec' : '#353d47';
    const intensity = Math.min(count / Math.max(maxCount, 1), 1);
    const from = isLight ? [178, 199, 222] : [57, 78, 103];
    const to = isLight ? [52, 94, 144] : [146, 182, 224];
    const channels = from.map((channel, i) => Math.round(channel + (to[i] - channel) * intensity));
    return `rgb(${channels.join(', ')})`;
  };

  const dayLabels = [t('overview.sun'), t('overview.mon'), t('overview.tue'), t('overview.wed'), t('overview.thu'), t('overview.fri'), t('overview.sat')];

  const contentWidth = weekCount * cellSize + Math.max(weekCount - 1, 0) * gapSize + labelWidth * 2;

  return (
    <div className="w-full overflow-x-auto" ref={scrollRef}>
      <div className="flex flex-col min-w-max" style={{ width: `${Math.min(maxWidth, contentWidth)}px`, minWidth: `${contentWidth}px` }}>
          {/* Month labels */}
          <div
            className="grid text-[10px] text-gray-500 mb-1"
            style={{
              gridTemplateColumns: `repeat(${weekCount}, ${cellSize}px)`,
              marginLeft: `${labelWidth}px`,
              columnGap: `${gapSize}px`,
              paddingRight: `${labelWidth}px`,
            }}
          >
            {months.map((m, i) => (
              <div key={i} style={{ gridColumnStart: m.col + 1 }}>
                {m.label}
              </div>
            ))}
          </div>

          {/* Grid */}
          <div className="flex" style={{ columnGap: `${gapSize}px` }}>
            {/* Day labels */}
            <div
              className="flex flex-col text-[10px] text-gray-500"
              style={{ rowGap: `${gapSize}px`, width: `${labelWidth}px` }}
            >
              {dayLabels.map((d, i) => (
                <div key={i} style={{ height: cellSize }} className="flex items-center">
                  {i % 2 === 1 ? d : ''}
                </div>
              ))}
            </div>

            {/* Weeks */}
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${weekCount}, ${cellSize}px)`,
                gridTemplateRows: `repeat(7, ${cellSize}px)`,
                columnGap: `${gapSize}px`,
                rowGap: `${gapSize}px`,
              }}
            >
              {grid.map((week, weekIdx) =>
                week.map((day, dayIdx) => (
                  <div
                    key={`${weekIdx}-${dayIdx}`}
                    className={`rounded-[2px] transition-colors ${day.count >= 0 ? 'cursor-pointer hover:ring-1 hover:ring-drone-primary' : ''}`}
                    style={{
                      width: cellSize,
                      height: cellSize,
                      gridColumnStart: weekIdx + 1,
                      gridRowStart: dayIdx + 1,
                      backgroundColor: getColor(day.count),
                    }}
                    title={
                      day.count >= 0
                        ? t('overview.heatmapTooltip', { date: formatDateNumeric(day.date, dateLocale), count: day.count })
                        : ''
                    }
                    onDoubleClick={() => {
                      if (day.count >= 0 && onDateDoubleClick) {
                        onDateDoubleClick(day.date);
                      }
                    }}
                  />
                ))
              )}
            </div>

            <div style={{ width: `${labelWidth}px` }} />
          </div>

          {/* Legend */}
          <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-500">
            <span>{t('overview.less')}</span>
            <div className="flex gap-0.5">
              {[0, 0.25, 0.5, 0.75, 1].map((intensity, i) => (
                <div
                  key={i}
                  className="w-[10px] h-[10px] rounded-[2px]"
                  style={{
                    backgroundColor: getColor(i === 0 ? 0 : intensity * Math.max(maxCount, 1)),
                  }}
                />
              ))}
            </div>
            <span>{t('overview.more')}</span>
          </div>
        </div>
      </div>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
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

type SortMode = 'progress' | 'name';

function DroneFlightTimeList({
  drones,
  isLight,
  getDroneDisplayName,
  renameDrone,
  getDisplaySerial,
  hideSerialNumbers,
}: {
  drones: { droneModel: string; droneSerial: string | null; aircraftName: string | null; flightCount: number; totalDurationSecs: number; displayLabel: string }[];
  isLight: boolean;
  getDroneDisplayName: (serial: string, fallbackName: string) => string;
  renameDrone: (serial: string, displayName: string) => void;
  getDisplaySerial: (serial: string) => string;
  hideSerialNumbers: boolean;
}) {
  const { t } = useTranslation();
  const [editingSerial, setEditingSerial] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('progress');

  if (drones.length === 0) {
    return (
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">{t('overview.droneFlightTime')}</h3>
        </div>
        <p className="text-sm text-gray-400">{t('overview.noDroneData')}</p>
      </div>
    );
  }

  // Find max duration for progress bar scaling
  let maxDuration = 0;
  for (const d of drones) {
    if (d.totalDurationSecs > maxDuration) maxDuration = d.totalDurationSecs;
  }

  // Sort drones: decommissioned always at bottom, then by selected criterion
  const sortedDrones = [...drones].sort((a, b) => {
    const aDecom = isDecommissioned(a.displayLabel);
    const bDecom = isDecommissioned(b.displayLabel);
    if (aDecom !== bDecom) return aDecom ? 1 : -1;
    if (sortMode === 'name') {
      const aName = a.droneSerial
        ? getDroneDisplayName(a.droneSerial, a.aircraftName || a.droneModel)
        : (a.aircraftName || a.droneModel);
      const bName = b.droneSerial
        ? getDroneDisplayName(b.droneSerial, b.aircraftName || b.droneModel)
        : (b.aircraftName || b.droneModel);
      return aName.localeCompare(bName);
    }
    // progress = by duration descending (default)
    return b.totalDurationSecs - a.totalDurationSecs;
  });

  const handleStartRename = (serial: string, fallbackName: string) => {
    setEditingSerial(serial);
    setDraftName(getDroneDisplayName(serial, fallbackName));
    setRenameError(null);
  };

  const handleSaveRename = (serial: string) => {
    const name = draftName.trim();
    if (name.length === 0) {
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    // If name equals the serial itself, just clear the mapping
    if (name === serial) {
      renameDrone(serial, '');
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    renameDrone(serial, name);
    setEditingSerial(null);
    setRenameError(null);
  };

  const handleCancelRename = () => {
    setEditingSerial(null);
    setDraftName('');
    setRenameError(null);
  };

  // Check for duplicate display names to show serial
  const displayNameCounts = new Map<string, number>();
  drones.forEach((d) => {
    const fallback = d.aircraftName || d.droneModel;
    const displayName = d.droneSerial ? getDroneDisplayName(d.droneSerial, fallback) : fallback;
    displayNameCounts.set(displayName, (displayNameCounts.get(displayName) || 0) + 1);
  });

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">{t('overview.droneFlightTime')}</h3>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="sort-select text-[10px] px-1.5 py-0.5 rounded border cursor-pointer outline-none"
        >
          <option value="progress">{t('overview.sortByProgress')}</option>
          <option value="name">{t('overview.sortByName')}</option>
        </select>
      </div>
      <div className="space-y-2 max-h-[200px] overflow-y-auto" style={{ padding: '0 8px 0 4px' }}>
        {sortedDrones.map((drone) => {
          const fallbackName = drone.aircraftName || drone.droneModel;
          const displayName = drone.droneSerial ? getDroneDisplayName(drone.droneSerial, fallbackName) : fallbackName;
          const hasDuplicate = (displayNameCounts.get(displayName) || 0) > 1;
          const isEditing = drone.droneSerial && editingSerial === drone.droneSerial;
          const progressPercent = (drone.totalDurationSecs / maxDuration) * 100;
          const decomm = isDecommissioned(drone.displayLabel);

          // Format duration as Xh Ym
          const hours = Math.floor(drone.totalDurationSecs / 3600);
          const minutes = Math.floor((drone.totalDurationSecs % 3600) / 60);
          const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

          return (
            <div key={drone.droneSerial || drone.droneModel}>
              {isEditing ? (
                <div className="mb-1">
                  <input
                    value={draftName}
                    onChange={(e) => {
                      setDraftName(e.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveRename(drone.droneSerial!);
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    className="input h-6 text-xs px-2 w-full"
                    placeholder={t('overview.droneName')}
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-0.5">
                    <button
                      onClick={() => handleSaveRename(drone.droneSerial!)}
                      className="text-[10px] text-drone-primary hover:text-drone-primary/80"
                    >
                      {t('overview.save')}
                    </button>
                    <button
                      onClick={handleCancelRename}
                      className="text-[10px] text-gray-400 hover:text-gray-300"
                    >
                      {t('overview.cancel')}
                    </button>
                    {renameError && (
                      <span className="text-[10px] text-red-400">{renameError}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  className="grid items-center gap-1.5 text-xs"
                  style={{ gridTemplateColumns: '140px 1fr 120px' }}
                  title={!hideSerialNumbers && drone.droneSerial ? (displayName !== drone.droneSerial ? `${displayName} (${drone.droneSerial})` : drone.droneSerial) : undefined}
                >
                  <span
                    className={`text-gray-300 font-medium truncate flex items-center justify-end gap-1 ${drone.droneSerial ? 'group cursor-pointer' : ''}`}
                    onDoubleClick={() => drone.droneSerial && handleStartRename(drone.droneSerial, fallbackName)}
                  >
                    <span className="truncate">
                      {displayName}
                      {hasDuplicate && drone.droneSerial && (
                        <span className="text-gray-500 text-[10px] ml-1">({getDisplaySerial(drone.droneSerial)})</span>
                      )}
                    </span>
                    {drone.droneSerial && (
                      <button
                        onClick={() => handleStartRename(drone.droneSerial!, fallbackName)}
                        className="p-0.5 text-sky-400 flex-shrink-0"
                        title={t('overview.renameDrone')}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                    )}
                  </span>
                  <div className="relative h-2 bg-gray-700/50 rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                      style={{
                        width: `${progressPercent}%`,
                        backgroundColor: decomm ? '#6b7280' : (isLight ? '#537bab' : '#78a1d3'),
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-400 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {durationLabel} · {t('overview.flightCount', { count: drone.flightCount })}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DonutChart({
  data,
  emptyMessage,
}: {
  data: { name: string; displayName?: string; value: number; decommissioned?: boolean }[];
  emptyMessage: string;
}) {
  const { t } = useTranslation();
  const themeMode = useFlightStore((state) => state.themeMode);
  const chartTheme = getChartTheme(resolveThemeMode(themeMode) === 'light');
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);

  useEffect(() => {
    if (!chartRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setChartWidth(entry.contentRect.width);
      }
    });
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);

  if (data.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-8">{emptyMessage}</p>;
  }

  const colors = chartSeriesColors;

  // Fixed chart height
  const chartHeight = 200;
  // Pie chart uses a square area based on height (with some padding)
  const pieSquareSize = chartHeight - 20; // 180px
  const pieCenter = pieSquareSize / 2 + 10; // Center in the square area (100px)
  // 15% larger than original (0.75 -> 0.8625, 0.5 -> 0.575)
  const pieOuterRadius = (pieSquareSize / 2) * 0.8625; // ~77.6px
  const pieInnerRadius = (pieSquareSize / 2) * 0.575; // ~51.75px
  // Gap between pie chart and legend
  const pieToLegendGap = 30;
  // Legend width is remaining space minus gap and padding
  const remainingSpace = chartWidth > 0 ? chartWidth - pieSquareSize - pieToLegendGap : 140;
  const legendWidth = Math.max(60, remainingSpace - 12); // 12px right padding
  // Position legend after pie + gap
  const legendLeft = pieSquareSize + pieToLegendGap;
  const labelByName = new Map(data.map((item) => [item.name, item.displayName ?? item.name]));
  const decommissionedByName = new Map(data.map((item) => [item.name, !!item.decommissioned]));

  const option = {
    textStyle: { fontFamily: chartFontFamily },
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: chartTheme.background,
      borderColor: chartTheme.border,
      textStyle: { color: chartTheme.text },
      formatter: (params: { name: string; value: number; percent: number }) => {
        const label = labelByName.get(params.name) || params.name;
        return `<strong>${label}</strong><br/>${t('overview.donutTooltip', { value: params.value, percent: params.percent.toFixed(1) })}`;
      },
    },
    legend: {
      type: 'scroll' as const,
      orient: 'vertical' as const,
      left: legendLeft,
      top: 'center',
      width: legendWidth,
      pageTextStyle: { color: chartTheme.label },
      tooltip: { show: true },
      formatter: (name: string) => {
        const label = labelByName.get(name) || name;
        if (decommissionedByName.get(name)) {
          return `{decom|${label}}`;
        }
        return label;
      },
      textStyle: {
        color: chartTheme.label,
        fontSize: 11,
        overflow: 'truncate' as const,
        width: legendWidth - 24,
        rich: {
          decom: {
            color: chartTheme.label,
            fontSize: 11,
          },
        },
      },
    },
    series: [
      {
        type: 'pie' as const,
        radius: [pieInnerRadius, pieOuterRadius],
        center: [pieCenter, '50%'],
        avoidLabelOverlap: true,
        padAngle: 2,
        itemStyle: {
          borderRadius: 4,
          borderColor: 'transparent',
          borderWidth: 0,
        },
        label: { show: false },
        emphasis: {
          label: {
            show: false,
          },
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
          },
        },
        labelLine: { show: false },
        data: (() => {
          let colorIdx = 0;
          return data.map((item) => {
            const color = item.decommissioned ? '#6b7280' : colors[colorIdx++ % colors.length];
            return {
              name: item.name,
              value: item.value,
              itemStyle: { color },
            };
          });
        })(),
      },
    ],
  };

  return (
    <div ref={chartRef}>
      <ReactECharts option={option} style={{ height: chartHeight }} />
    </div>
  );
}

/**
 * Estimate the local hour of a flight from its UTC start time and takeoff coordinates.
 * Uses longitude / 15 approximation for timezone offset (same as Rust parser).
 */
function estimateLocalHour(startTime: string, homeLon: number | null | undefined): number {
  const dt = new Date(startTime);
  const utcHour = dt.getUTCHours();
  const tzOffsetHours = homeLon != null ? Math.round(homeLon / 15) : 0;
  return ((utcHour + tzOffsetHours) % 24 + 24) % 24;
}

/**
 * Polar area chart showing flight distribution across 24 hours of the day.
 * Each segment represents one hour; the radius encodes number of flights.
 */
function FlightTimeRadialChart({
  flights,
  emptyMessage,
}: {
  flights: Flight[];
  emptyMessage: string;
}) {
  const { t } = useTranslation();
  const themeMode = useFlightStore((state) => state.themeMode);
  const chartTheme = getChartTheme(resolveThemeMode(themeMode) === 'light');

  // Bucket flights into 24 hours
  const hourCounts = useMemo(() => {
    const counts = new Array(24).fill(0);
    flights.forEach((f) => {
      if (!f.startTime) return;
      const hour = estimateLocalHour(f.startTime, f.homeLon);
      counts[hour]++;
    });
    return counts;
  }, [flights]);

  const maxCount = Math.max(...hourCounts, 1);
  const hasData = hourCounts.some((c) => c > 0);

  if (!hasData) {
    return <p className="text-sm text-gray-400 text-center py-8">{emptyMessage}</p>;
  }

  // Hour labels for the angle axis (24h clock)
  const hourLabels = Array.from({ length: 24 }, (_, i) => {
    if (i === 0) return '12a';
    if (i === 6) return '6a';
    if (i === 12) return '12p';
    if (i === 18) return '6p';
    return '';
  });

  // Color gradient: cooler (night) -> warmer (day)
  const getBarColor = (hour: number) => {
    if (hour >= 6 && hour < 10) return '#b18c50';   // Morning - amber
    if (hour >= 10 && hour < 14) return '#739b91';   // Midday - teal
    if (hour >= 14 && hour < 18) return '#537bab';   // Afternoon - blue
    if (hour >= 18 && hour < 21) return '#8c84a6';   // Evening - purple
    return '#7b91ac';                                  // Night - indigo
  };

  const option = {
    textStyle: { fontFamily: chartFontFamily },
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: chartTheme.background,
      borderColor: chartTheme.border,
      textStyle: { color: chartTheme.text },
      formatter: (params: { dataIndex: number; value: number }) => {
        const hour = params.dataIndex;
        const from = hour.toString().padStart(2, '0') + ':00';
        const to = ((hour + 1) % 24).toString().padStart(2, '0') + ':00';
        return `<strong>${from} - ${to}</strong><br/>${t('overview.radialTooltip', { count: params.value })}`;
      },
    },
    polar: {
      radius: ['15%', '85%'],
    },
    angleAxis: {
      type: 'category' as const,
      data: hourLabels,
      boundaryGap: true,
      axisTick: { show: false },
      axisLabel: {
        color: chartTheme.label,
        fontSize: 10,
        formatter: (value: string) => value,
      },
      axisLine: { lineStyle: { color: chartTheme.grid } },
      splitLine: { show: false },
      startAngle: 90,
    },
    radiusAxis: {
      type: 'value' as const,
      max: maxCount,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: {
        lineStyle: { color: chartTheme.grid, type: 'dashed' as const },
      },
    },
    series: [
      {
        type: 'bar' as const,
        coordinateSystem: 'polar' as const,
        data: hourCounts.map((count, i) => ({
          value: count,
          itemStyle: {
            color: getBarColor(i),
            borderRadius: 2,
          },
        })),
        barWidth: '65%',
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowColor: 'rgba(0, 0, 0, 0.4)',
          },
        },
      },
    ],
  };

  return (
    <ReactECharts option={option} style={{ height: 200 }} />
  );
}

function BatteryHealthList({
  batteries,
  filteredFlights,
  isLight,
  getBatteryDisplayName,
  batteryNameMap,
  renameBattery,
  hideSerialNumbers,
}: {
  batteries: { batterySerial: string; flightCount: number; totalDurationSecs: number; maxCycleCount: number | null }[];
  filteredFlights: Flight[];
  isLight: boolean;
  getBatteryDisplayName: (serial: string) => string;
  batteryNameMap: Record<string, string>;
  renameBattery: (serial: string, displayName: string) => void;
  hideSerialNumbers: boolean;
}) {
  const { t } = useTranslation();
  const dateLocale = useFlightStore((state) => state.dateLocale);
  const [editingSerial, setEditingSerial] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('progress');
  const [isExportingSummary, setIsExportingSummary] = useState(false);
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0, currentFile: '' });

  // Battery selection for capacity chart
  const [selectedCapBatteries, setSelectedCapBatteries] = useState<string[]>([]);
  const [capBatteryDropdownOpen, setCapBatteryDropdownOpen] = useState(false);
  const [capBatterySearch, setCapBatterySearch] = useState('');
  const capBatteryDropdownRef = useRef<HTMLDivElement>(null);
  const [defaultCapBatteryInitialized, setDefaultCapBatteryInitialized] = useState(false);

  // Determine the most recently used battery serial
  const mostRecentBatterySerial = useMemo(() => {
    let latest: string | null = null;
    let latestTime = -Infinity;
    for (const f of filteredFlights) {
      const serial = normalizeSerial(f.batterySerial);
      if (serial && f.startTime) {
        const t = Date.parse(f.startTime);
        if (Number.isFinite(t) && t > latestTime) {
          latestTime = t;
          latest = serial;
        }
      }
    }
    return latest;
  }, [filteredFlights]);

  // Fetch battery full capacity history for all batteries
  const [capacityHistory, setCapacityHistory] = useState<Map<string, [number, string, number][]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      const result = new Map<string, [number, string, number][]>();
      for (const bat of batteries) {
        try {
          const history = await getBatteryFullCapacityHistory(bat.batterySerial);
          if (!cancelled && history.length > 0) {
            result.set(bat.batterySerial, history);
          }
        } catch {
          // ignore failures for individual batteries
        }
      }
      if (!cancelled) {
        setCapacityHistory(result);
        // Initialize default selection to most recently used battery once data is available
        if (!defaultCapBatteryInitialized && mostRecentBatterySerial && result.has(mostRecentBatterySerial)) {
          setSelectedCapBatteries([mostRecentBatterySerial]);
          setDefaultCapBatteryInitialized(true);
        } else if (!defaultCapBatteryInitialized && result.size > 0) {
          // Fallback: pick the first battery with data
          const firstSerial = Array.from(result.keys())[0];
          setSelectedCapBatteries([firstSerial]);
          setDefaultCapBatteryInitialized(true);
        }
      }
    };
    if (batteries.length > 0) {
      fetchAll();
    } else {
      setCapacityHistory(new Map());
    }
    return () => { cancelled = true; };
  }, [batteries, mostRecentBatterySerial, defaultCapBatteryInitialized]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (capBatteryDropdownRef.current && !capBatteryDropdownRef.current.contains(e.target as Node)) {
        setCapBatteryDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Batteries that have capacity data (for the dropdown)
  const batteriesWithCapData = useMemo(() => {
    return batteries.filter((b) => capacityHistory.has(b.batterySerial));
  }, [batteries, capacityHistory]);

  const filteredCapBatteryOptions = useMemo(() => {
    let list = batteriesWithCapData;
    if (capBatterySearch.trim()) {
      const q = capBatterySearch.toLowerCase();
      list = list.filter((b) => {
        const name = getBatteryDisplayName(b.batterySerial).toLowerCase();
        return name.includes(q) || b.batterySerial.toLowerCase().includes(q);
      });
    }
    // Sort selected batteries to the top
    return [...list].sort((a, b) => {
      const aSelected = selectedCapBatteries.includes(a.batterySerial);
      const bSelected = selectedCapBatteries.includes(b.batterySerial);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return 0;
    });
  }, [batteriesWithCapData, capBatterySearch, getBatteryDisplayName, selectedCapBatteries]);

  const toggleCapBattery = (serial: string) => {
    setSelectedCapBatteries((prev) =>
      prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial],
    );
  };

  const capacitySeries = useMemo(() => {
    if (selectedCapBatteries.length === 0) return [];
    return selectedCapBatteries
      .filter((serial) => capacityHistory.has(serial))
      .flatMap((serial) => {
        const items = capacityHistory.get(serial)!;
        const data = items
          .map(([, startTime, maxCap]) => {
            const time = Date.parse(startTime);
            if (!Number.isFinite(time)) return null;
            return [time, Math.round(maxCap)] as [number, number];
          })
          .filter((p): p is [number, number] => p !== null);

        const displayName = getBatteryDisplayName(serial);
        const series: Array<{
          name: string;
          type: 'line' | 'scatter';
          smooth?: boolean;
          showSymbol?: boolean;
          symbolSize?: number;
          connectNulls?: boolean;
          data: [number, number][];
        }> = [];

        // Add line series only when there are at least 2 points
        if (data.length > 1) {
          series.push({
            name: displayName,
            type: 'line',
            smooth: true,
            showSymbol: false,
            connectNulls: true,
            data,
          });
        }

        // Always add scatter series
        series.push({
          name: displayName,
          type: 'scatter',
          symbolSize: 7,
          data,
        });

        return series;
      });
  }, [capacityHistory, getBatteryDisplayName, selectedCapBatteries]);

  if (batteries.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">{t('overview.batteryHealth')}</h3>
        </div>
        <p className="text-sm text-gray-400">{t('overview.noBatteryDataAvailable')}</p>
      </div>
    );
  }

  // Estimate health based on flight count (assuming 400 cycles = end of life)
  const maxCycles = 400;

  // Sort batteries: decommissioned always at bottom, then by selected criterion
  const sortedBatteries = [...batteries].sort((a, b) => {
    const aDecom = isDecommissioned(getBatteryDisplayName(a.batterySerial));
    const bDecom = isDecommissioned(getBatteryDisplayName(b.batterySerial));
    if (aDecom !== bDecom) return aDecom ? 1 : -1;
    if (sortMode === 'name') {
      const aName = getBatteryDisplayName(a.batterySerial);
      const bName = getBatteryDisplayName(b.batterySerial);
      return aName.localeCompare(bName);
    }
    // progress = by health percentage ascending (lowest first = needs attention first)
    const healthA = a.maxCycleCount != null
      ? Math.max(0, 100 - (a.maxCycleCount / maxCycles) * 100)
      : Math.max(0, 100 - (a.flightCount / maxCycles) * 100);
    const healthB = b.maxCycleCount != null
      ? Math.max(0, 100 - (b.maxCycleCount / maxCycles) * 100)
      : Math.max(0, 100 - (b.flightCount / maxCycles) * 100);
    return healthA - healthB;
  });

  const handleStartRename = (serial: string) => {
    setEditingSerial(serial);
    setDraftName(getBatteryDisplayName(serial));
    setRenameError(null);
  };

  const handleSaveRename = (serial: string) => {
    const name = draftName.trim();
    if (name.length === 0) {
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    // If name equals the serial itself, just clear the mapping
    if (name === serial) {
      renameBattery(serial, '');
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    // Check uniqueness: name must not match any other battery's custom name or serial
    const otherSerials = batteries
      .map((b) => b.batterySerial)
      .filter((s) => s !== serial);
    const otherNames = otherSerials.map((s) => getBatteryDisplayName(s));
    if (otherNames.includes(name) || otherSerials.includes(name)) {
      setRenameError('Name must be unique across all batteries');
      return;
    }
    renameBattery(serial, name);
    setEditingSerial(null);
    setRenameError(null);
  };

  const handleCancelRename = () => {
    setEditingSerial(null);
    setDraftName('');
    setRenameError(null);
  };

  const handleDownloadSummary = async () => {
    if (isExportingSummary || filteredFlights.length === 0) return;

    const batteryFlights = filteredFlights.filter((flight) => normalizeSerial(flight.batterySerial));
    setIsExportingSummary(true);
    setExportProgress({ done: 0, total: batteryFlights.length, currentFile: '' });
    try {
      const flightSummaries: BatteryFlightSummary[] = [];
      for (let index = 0; index < batteryFlights.length; index += 1) {
        const flight = batteryFlights[index];
        setExportProgress({
          done: index,
          total: batteryFlights.length,
          currentFile: flight.displayName || flight.fileName || `#${flight.id}`,
        });
        try {
          const data = await getFlightData(flight.id, 999999999);
          const summary = summarizeBatteryFlight(data);
          if (summary) flightSummaries.push(summary);
        } catch (error) {
          console.error(`Failed to process flight ${flight.id} for battery summary:`, error);
        }
      }

      setExportProgress({ done: batteryFlights.length, total: batteryFlights.length, currentFile: '' });
      const csv = buildBatterySummaryCsv(flightSummaries, batteryNameMap);
      const filename = getBatterySummaryFilename();
      if (isWebMode()) {
        downloadFile(filename, csv, 'text/csv;charset=utf-8');
      } else {
        await saveTextWithDialog(filename, csv, [{ name: 'CSV', extensions: ['csv'] }]);
      }
    } catch (error) {
      console.error('Battery summary export failed:', error);
    } finally {
      setIsExportingSummary(false);
    }
  };

  const allCapY = capacitySeries.flatMap((s) => s.data.map((p: [number, number]) => p[1]));
  let capYMax = 5000;
  for (let i = 0; i < allCapY.length; i++) {
    if (allCapY[i] > capYMax) capYMax = allCapY[i];
  }

  const titleColor = getChartTheme(isLight).text;
  const axisLineColor = isLight ? '#d6dce3' : '#374151';
  const splitLineColor = isLight ? '#e3e7ec' : '#1f2937';
  const axisLabelColor = getChartTheme(isLight).label;
  const tooltipStyle = getChartTheme(isLight);

  const chartOption = {
    textStyle: { fontFamily: chartFontFamily },
    title: {
      text: t('overview.batteryCapacityHistory'),
      left: 'center',
      textStyle: { color: titleColor, fontSize: 12, fontWeight: 'normal' as const },
    },
    toolbox: {
      feature: {
        dataZoom: {
          yAxisIndex: 'none',
          title: { zoom: t('overview.dragToZoom'), back: t('overview.resetZoom') },
        },
      },
      right: 16,
      top: -4,
      itemSize: 13,
      iconStyle: {
        borderColor: isLight ? '#94a3b8' : '#6b7280',
      },
      emphasis: {
        iconStyle: {
          borderColor: isLight ? '#345e90' : '#537bab',
        },
      },
    },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: tooltipStyle.background,
      borderColor: tooltipStyle.border,
      textStyle: { color: tooltipStyle.text },
      formatter: (params: Array<{ seriesName: string; value: [string, number] }>) => {
        if (!params?.length) return '';
        const dateLabel = params[0].value?.[0]
          ? formatDateNumeric(new Date(params[0].value[0]), dateLocale)
          : t('overview.unknownDate');
        // Deduplicate entries (line + scatter share the same name)
        const seen = new Set<string>();
        const lines = params
          .filter((item) => {
            if (seen.has(item.seriesName)) return false;
            seen.add(item.seriesName);
            return true;
          })
          .map((item) => `${item.seriesName}: ${item.value[1]} mAh`)
          .join('<br/>');
        return `<strong>${dateLabel}</strong><br/>${lines}`;
      },
    },
    legend: {
      type: 'scroll' as const,
      bottom: 0,
      data: [...new Set(capacitySeries.map((s) => s.name))],
      textStyle: { color: axisLabelColor, fontSize: 11 },
    },
    grid: { left: 16, right: 16, top: 46, bottom: 72, containLabel: true },
    xAxis: {
      type: 'time' as const,
      axisLine: { lineStyle: { color: axisLineColor } },
      axisLabel: { color: axisLabelColor, fontSize: 10 },
      splitLine: { lineStyle: { color: splitLineColor } },
    },
    yAxis: {
      type: 'value' as const,
      min: 250,
      max: capYMax,
      name: 'mAh',
      nameTextStyle: { color: axisLabelColor, fontSize: 10 },
      axisLine: { lineStyle: { color: axisLineColor } },
      axisLabel: { color: axisLabelColor, fontSize: 10 },
      splitLine: { lineStyle: { color: splitLineColor } },
    },
    dataZoom: [
      {
        type: 'inside' as const,
        xAxisIndex: 0,
        filterMode: 'filter' as const,
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: false,
      },
      {
        type: 'slider' as const,
        xAxisIndex: 0,
        height: 18,
        bottom: 28,
        brushSelect: false,
        borderColor: isLight ? '#d6dce3' : '#374151',
        backgroundColor: isLight ? '#f1f3f5' : '#28313b',
        fillerColor: isLight ? 'rgba(52, 94, 144, 0.15)' : 'rgba(120, 161, 211, 0.2)',
        handleStyle: {
          color: isLight ? '#345e90' : '#537bab',
        },
        textStyle: {
          color: axisLabelColor,
        },
        dataBackground: {
          lineStyle: { color: isLight ? '#94a3b8' : '#4f5b6a' },
          areaStyle: { color: isLight ? '#d6dce3' : '#353d47' },
        },
        selectedDataBackground: {
          lineStyle: { color: isLight ? '#345e90' : '#537bab' },
          areaStyle: { color: isLight ? 'rgba(52, 94, 144, 0.1)' : 'rgba(120, 161, 211, 0.15)' },
        },
      },
    ],
    series: capacitySeries,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-0">
        <h3 className="text-sm font-semibold text-white">{t('overview.batteryHealth')}</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadSummary}
            disabled={isExportingSummary}
            className="text-[10px] px-2 py-1 rounded border border-drone-primary/60 text-drone-primary hover:bg-drone-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('overview.downloadSummary')}
          </button>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="sort-select text-[10px] px-1.5 py-0.5 rounded border cursor-pointer outline-none"
          >
            <option value="progress">{t('overview.sortByProgress')}</option>
            <option value="name">{t('overview.sortByName')}</option>
          </select>
        </div>
      </div>
      <div className="space-y-2 max-h-[200px] overflow-y-auto" style={{ padding: '0 16px 0 10px' }}>
        {sortedBatteries.map((battery) => {
          const cycleCount = battery.maxCycleCount;
          const healthPercent = cycleCount != null
            ? Math.max(0, 100 - (cycleCount / maxCycles) * 100)
            : Math.max(0, 100 - (battery.flightCount / maxCycles) * 100);
          const displayName = getBatteryDisplayName(battery.batterySerial);
          const decomm = isDecommissioned(displayName);
          const healthColor = decomm
            ? '#6b7280'
            : healthPercent > 70 ? '#10b981' : healthPercent > 40 ? '#b18c50' : '#ef4444';
          const isEditing = editingSerial === battery.batterySerial;

          return (
            <div key={battery.batterySerial}>
              {isEditing ? (
                <div className="mb-1">
                  <input
                    value={draftName}
                    onChange={(e) => {
                      setDraftName(e.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveRename(battery.batterySerial);
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    className="input h-6 text-xs px-2 w-full"
                    placeholder={t('overview.batteryName')}
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-0.5">
                    <button
                      onClick={() => handleSaveRename(battery.batterySerial)}
                      className="text-[10px] text-drone-primary hover:text-drone-primary/80"
                    >
                      {t('overview.save')}
                    </button>
                    <button
                      onClick={handleCancelRename}
                      className="text-[10px] text-gray-400 hover:text-gray-300"
                    >
                      {t('overview.cancel')}
                    </button>
                    {renameError && (
                      <span className="text-[10px] text-red-400">{renameError}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  className="flex items-center gap-1 md:gap-1.5 text-[10px] md:text-xs w-full overflow-hidden"
                  title={!hideSerialNumbers ? (displayName !== battery.batterySerial ? `${displayName} (${battery.batterySerial})` : battery.batterySerial) : undefined}
                >
                  <span
                    className="w-[85px] md:w-[160px] flex-shrink-0 text-gray-300 font-medium truncate flex items-center justify-start md:justify-end gap-1 group cursor-pointer"
                    onDoubleClick={() => handleStartRename(battery.batterySerial)}
                  >
                    <span className="truncate">{displayName}</span>
                    <button
                      onClick={() => handleStartRename(battery.batterySerial)}
                      className="p-0.5 text-sky-400 flex-shrink-0"
                      title={t('overview.renameBattery')}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                  </span>
                  <div className="flex-1 min-w-[25px] relative h-2 bg-gray-700/50 rounded-full overflow-hidden mx-1">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                      style={{
                        width: `${healthPercent}%`,
                        backgroundColor: healthColor,
                      }}
                    />
                  </div>
                  <span className="w-[28px] md:w-[32px] flex-shrink-0 text-[10px] text-gray-500 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {healthPercent.toFixed(0)}%
                  </span>
                  <span className="hidden md:inline-block w-[110px] md:w-[200px] flex-shrink-0 text-gray-400 text-[9px] md:text-[10px] text-right md:text-left truncate">
                    {cycleCount != null
                      ? t('overview.cycleCountAndFlightsAndDuration', { cycles: cycleCount, flights: battery.flightCount, duration: formatDuration(battery.totalDurationSecs) })
                      : t('overview.flightsAndDuration', { n: battery.flightCount, duration: formatDuration(battery.totalDurationSecs) })}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Battery selector for capacity chart */}
      {batteriesWithCapData.length > 0 && (
        <div className="relative" ref={capBatteryDropdownRef}>
          <button
            onClick={() => setCapBatteryDropdownOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors"
            style={{
              borderColor: isLight ? '#d6dce3' : '#374151',
              background: isLight ? '#f8f9fa' : '#28313b',
              color: selectedCapBatteries.length > 0 ? (isLight ? '#0f172a' : '#e5e7eb') : (isLight ? '#94a3b8' : '#6b7280'),
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="16" height="10" rx="2" />
              <line x1="22" y1="11" x2="22" y2="13" />
            </svg>
            <span className="truncate max-w-[200px]">
              {selectedCapBatteries.length > 0
                ? selectedCapBatteries.map((s) => getBatteryDisplayName(s)).join(', ')
                : t('overview.selectBatteries')}
            </span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {capBatteryDropdownOpen && (
            <div
              className="absolute z-50 mt-1 w-56 rounded-lg shadow-lg border overflow-hidden"
              style={{
                borderColor: isLight ? '#e3e7ec' : '#374151',
                background: isLight ? '#ffffff' : '#28313b',
              }}
            >
              <div className="p-1.5">
                <input
                  type="text"
                  value={capBatterySearch}
                  onChange={(e) => setCapBatterySearch(e.target.value)}
                  placeholder={t('overview.searchBatteries')}
                  className="w-full px-2 py-1 text-xs rounded border outline-none"
                  style={{
                    borderColor: isLight ? '#e3e7ec' : '#374151',
                    background: isLight ? '#f8f9fa' : '#0f172a',
                    color: isLight ? '#0f172a' : '#e5e7eb',
                  }}
                  autoFocus
                />
              </div>
              <div className="max-h-[160px] overflow-y-auto">
                {filteredCapBatteryOptions.length === 0 ? (
                  <p className="text-xs text-gray-500 px-3 py-2">{t('flightList.noMatchingBatteries')}</p>
                ) : (
                  filteredCapBatteryOptions.map((b) => {
                    const checked = selectedCapBatteries.includes(b.batterySerial);
                    return (
                      <button
                        key={b.batterySerial}
                        onClick={() => toggleCapBattery(b.batterySerial)}
                        className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors"
                        style={{
                          color: isLight ? '#0f172a' : '#e5e7eb',
                          background: checked
                            ? (isLight ? '#eff6ff' : 'rgba(120, 161, 211, 0.1)')
                            : 'transparent',
                        }}
                      >
                        <span
                          className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                          style={{
                            borderColor: checked ? '#537bab' : (isLight ? '#d6dce3' : '#4b5563'),
                            background: checked ? '#537bab' : 'transparent',
                          }}
                        >
                          {checked && (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                        <span className="truncate">{getBatteryDisplayName(b.batterySerial)}</span>
                      </button>
                    );
                  })
                )}
              </div>
              {selectedCapBatteries.length > 0 && (
                <div className="border-t px-2 py-1.5" style={{ borderColor: isLight ? '#e3e7ec' : '#374151' }}>
                  <button
                    onClick={() => setSelectedCapBatteries([])}
                    className="text-[10px] text-sky-500 hover:text-sky-400"
                  >
                    {t('overview.clearBatterySelection')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {capacitySeries.length > 0 ? (
        <div className="h-[260px]">
          <ReactECharts option={chartOption} notMerge={true} style={{ height: '100%' }} onChartReady={(chart) => {
            chart.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true });
          }} />
        </div>
      ) : (
        <p className="text-xs text-gray-500">{t('overview.noCapacityData')}</p>
      )}

      {isExportingSummary && typeof document !== 'undefined' && createPortal(
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
                  style={{
                    width: `${exportProgress.total > 0
                      ? (exportProgress.done / exportProgress.total) * 100
                      : 0}%`,
                  }}
                />
              </div>
              {exportProgress.currentFile && (
                <div className="text-xs text-gray-500 truncate">
                  {t('flightList.current')} {exportProgress.currentFile}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface MaintenanceSectionProps {
  batteries: { batterySerial: string; flightCount: number; totalDurationSecs: number; maxCycleCount: number | null }[];
  drones: { droneModel: string; droneSerial: string | null; aircraftName: string | null; flightCount: number; totalDurationSecs: number; displayLabel: string }[];
  flights: Flight[];
  isLight: boolean;
  batteryPairIndex: BatteryPairIndex;
  getBatteryDisplayName: (serial: string) => string;
  getDroneDisplayName: (serial: string, fallbackName: string) => string;
  maintenanceThresholds: {
    battery: { flights: number; airtime: number; days: number };
    aircraft: { flights: number; airtime: number; days: number };
  };
  maintenanceLastReset: {
    battery: Record<string, string>;
    aircraft: Record<string, string>;
  };
  setMaintenanceThreshold: (type: 'battery' | 'aircraft', field: 'flights' | 'airtime' | 'days', value: number) => void;
  performMaintenance: (type: 'battery' | 'aircraft', serial: string, date?: Date) => void;
}

function MaintenanceSection({
  batteries,
  drones,
  flights,
  isLight,
  batteryPairIndex,
  getBatteryDisplayName,
  getDroneDisplayName,
  maintenanceThresholds,
  maintenanceLastReset,
  setMaintenanceThreshold,
  performMaintenance,
}: MaintenanceSectionProps) {
  const { t } = useTranslation();
  const dateLocale = useFlightStore((state) => state.dateLocale);
  const appLanguage = useFlightStore((state) => state.appLanguage);

  // Expanded items (click to toggle)
  const [expandedBatteries, setExpandedBatteries] = useState<Set<string>>(new Set());
  const [expandedAircrafts, setExpandedAircrafts] = useState<Set<string>>(new Set());

  // Search filters
  const [batterySearch, setBatterySearch] = useState('');
  const [aircraftSearch, setAircraftSearch] = useState('');

  // Threshold inputs
  const [batteryFlightThreshold, setBatteryFlightThreshold] = useState(String(maintenanceThresholds.battery.flights));
  const [batteryAirtimeThreshold, setBatteryAirtimeThreshold] = useState(String(maintenanceThresholds.battery.airtime));
  const [aircraftFlightThreshold, setAircraftFlightThreshold] = useState(String(maintenanceThresholds.aircraft.flights));
  const [aircraftAirtimeThreshold, setAircraftAirtimeThreshold] = useState(String(maintenanceThresholds.aircraft.airtime));
  const [batteryDaysThreshold, setBatteryDaysThreshold] = useState(String(maintenanceThresholds.battery.days));
  const [aircraftDaysThreshold, setAircraftDaysThreshold] = useState(String(maintenanceThresholds.aircraft.days));

  // Maintenance date state for each battery/aircraft (keyed by serial)
  const [batteryMaintenanceDates, setBatteryMaintenanceDates] = useState<Record<string, Date>>({});
  const [aircraftMaintenanceDates, setAircraftMaintenanceDates] = useState<Record<string, Date>>({});

  // Date picker open state (keyed by serial)
  const [openBatteryDatePicker, setOpenBatteryDatePicker] = useState<string | null>(null);
  const [openAircraftDatePicker, setOpenAircraftDatePicker] = useState<string | null>(null);

  // Anchor position for date picker (fixed positioning to escape scroll container)
  const [datePickerAnchor, setDatePickerAnchor] = useState<{ top: number; left: number } | null>(null);

  // Today's date for blocking future dates
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  // Get or initialize maintenance date for a battery (defaults to today)
  const getBatteryMaintenanceDate = (serial: string): Date => {
    return batteryMaintenanceDates[serial] || new Date();
  };

  // Get or initialize maintenance date for an aircraft (defaults to today)
  const getAircraftMaintenanceDate = (serial: string): Date => {
    return aircraftMaintenanceDates[serial] || new Date();
  };

  // Set maintenance date for a battery
  const setBatteryMaintenanceDate = (serial: string, date: Date | undefined) => {
    if (date) {
      setBatteryMaintenanceDates(prev => ({ ...prev, [serial]: date }));
    }
  };

  // Set maintenance date for an aircraft
  const setAircraftMaintenanceDate = (serial: string, date: Date | undefined) => {
    if (date) {
      setAircraftMaintenanceDates(prev => ({ ...prev, [serial]: date }));
    }
  };

  // Format date for display
  const formatDateDisplay = (date: Date): string => {
    return fmtDateDisplay(date, dateLocale, appLanguage);
  };

  // Handle battery maintenance performed
  const handleBatteryMaintenance = (serial: string) => {
    const date = getBatteryMaintenanceDate(serial);
    const maintenanceDate = new Date(date);
    maintenanceDate.setHours(23, 59, 59, 999);
    const members = getBatteryGroupMembers(serial, batteryPairIndex);
    const relevant = members.length > 0 ? members : [normalizeSerial(serial)];
    console.debug('[battery-pairs] applying battery maintenance reset', {
      selectedSerial: normalizeSerial(serial),
      affectedSerials: relevant,
      maintenanceDate: maintenanceDate.toISOString(),
    });
    for (const member of relevant) {
      performMaintenance('battery', member, maintenanceDate);
    }
    setBatteryMaintenanceDates(prev => {
      const updated = { ...prev };
      for (const member of relevant) {
        delete updated[member];
      }
      return updated;
    });
  };

  // Handle aircraft maintenance performed
  const handleAircraftMaintenance = (serial: string) => {
    const date = getAircraftMaintenanceDate(serial);
    const maintenanceDate = new Date(date);
    maintenanceDate.setHours(23, 59, 59, 999);
    performMaintenance('aircraft', serial, maintenanceDate);
    setAircraftMaintenanceDates(prev => {
      const updated = { ...prev };
      delete updated[serial];
      return updated;
    });
  };

  // Toggle expand/collapse
  const toggleBatteryExpand = (serial: string) => {
    setExpandedBatteries(prev => {
      const next = new Set(prev);
      if (next.has(serial)) next.delete(serial);
      else next.add(serial);
      return next;
    });
  };

  const toggleAircraftExpand = (serial: string) => {
    setExpandedAircrafts(prev => {
      const next = new Set(prev);
      if (next.has(serial)) next.delete(serial);
      else next.add(serial);
      return next;
    });
  };

  // Sync local state with store when thresholds change externally
  useEffect(() => {
    setBatteryFlightThreshold(String(maintenanceThresholds.battery.flights));
    setBatteryAirtimeThreshold(String(maintenanceThresholds.battery.airtime));
    setBatteryDaysThreshold(String(maintenanceThresholds.battery.days));
    setAircraftFlightThreshold(String(maintenanceThresholds.aircraft.flights));
    setAircraftAirtimeThreshold(String(maintenanceThresholds.aircraft.airtime));
    setAircraftDaysThreshold(String(maintenanceThresholds.aircraft.days));
  }, [maintenanceThresholds]);

  // Calculate maintenance progress for a battery
  const getBatteryProgress = (batterySerial: string) => {
    const normalizedSerial = normalizeSerial(batterySerial);
    const members = getBatteryGroupMembers(normalizedSerial, batteryPairIndex);
    const relevant = members.length > 0 ? members : [normalizedSerial];

    let lastResetDate: Date | null = null;
    for (const member of relevant) {
      const lastResetTime = maintenanceLastReset.battery[member];
      if (!lastResetTime) continue;
      const date = new Date(lastResetTime);
      if (!lastResetDate || date > lastResetDate) {
        lastResetDate = date;
      }
    }

    const batteryFlights = flights.filter(f => {
      const flightSerial = normalizeSerial(f.batterySerial);
      if (!relevant.includes(flightSerial)) return false;
      if (!lastResetDate) return true;
      if (!f.startTime) return true;
      return new Date(f.startTime) > lastResetDate;
    });

    const flightsSinceMaintenance = batteryFlights.length;
    const airtimeSinceMaintenance = batteryFlights.reduce((sum, f) => sum + (f.durationSecs ?? 0), 0) / 3600;

    return {
      flights: flightsSinceMaintenance,
      airtime: airtimeSinceMaintenance,
      lastReset: lastResetDate,
    };
  };

  // Calculate maintenance progress for an aircraft
  const getAircraftProgress = (droneSerial: string) => {
    const normalizedSerial = normalizeSerial(droneSerial);
    const lastResetTime = maintenanceLastReset.aircraft[normalizedSerial];
    const lastResetDate = lastResetTime ? new Date(lastResetTime) : null;

    const aircraftFlights = flights.filter(f => {
      if (normalizeSerial(f.droneSerial) !== normalizedSerial) return false;
      if (!lastResetDate) return true;
      if (!f.startTime) return true;
      return new Date(f.startTime) > lastResetDate;
    });

    const flightsSinceMaintenance = aircraftFlights.length;
    const airtimeSinceMaintenance = aircraftFlights.reduce((sum, f) => sum + (f.durationSecs ?? 0), 0) / 3600;

    return {
      flights: flightsSinceMaintenance,
      airtime: airtimeSinceMaintenance,
      lastReset: lastResetDate,
    };
  };

  /** Calculate days since last maintenance. Returns null if no maintenance recorded. */
  const getDaysSinceLastMaintenance = (lastReset: Date | null): number | null => {
    if (!lastReset) return null;
    const now = new Date();
    const diffMs = now.getTime() - lastReset.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  };

  const handleApplyBatteryThresholds = () => {
    const flights = parseInt(batteryFlightThreshold, 10);
    const airtime = parseFloat(batteryAirtimeThreshold);
    const days = parseInt(batteryDaysThreshold, 10);
    if (!isNaN(flights) && flights > 0) {
      setMaintenanceThreshold('battery', 'flights', flights);
    }
    if (!isNaN(airtime) && airtime > 0) {
      setMaintenanceThreshold('battery', 'airtime', airtime);
    }
    if (!isNaN(days) && days > 0) {
      setMaintenanceThreshold('battery', 'days', days);
    }
  };

  const handleApplyAircraftThresholds = () => {
    const flights = parseInt(aircraftFlightThreshold, 10);
    const airtime = parseFloat(aircraftAirtimeThreshold);
    const days = parseInt(aircraftDaysThreshold, 10);
    if (!isNaN(flights) && flights > 0) {
      setMaintenanceThreshold('aircraft', 'flights', flights);
    }
    if (!isNaN(airtime) && airtime > 0) {
      setMaintenanceThreshold('aircraft', 'airtime', airtime);
    }
    if (!isNaN(days) && days > 0) {
      setMaintenanceThreshold('aircraft', 'days', days);
    }
  };

  const getProgressBarColor = (percent: number) => {
    if (percent >= 90) return '#ef4444'; // red
    if (percent >= 75) return '#b17c57'; // orange
    if (percent >= 60) return '#eab308'; // yellow
    return '#10b981'; // green
  };

  const getProgressTextColor = (percent: number) => {
    if (percent >= 90) return 'text-red-400';
    if (percent >= 75) return 'text-orange-400';
    if (percent >= 60) return 'text-yellow-400';
    return 'text-green-400';
  };

  const formatLastReset = (date: Date | null) => {
    if (!date) return t('overview.never');
    return fmtDateDisplay(date, dateLocale, appLanguage);
  };

  // Battery list: filtered by search, sorted by combined progress
  const batteryProgressList = Array.from(
    batteries.reduce((grouped, battery) => {
      const groupKey = getBatteryGroupKey(battery.batterySerial, batteryPairIndex);
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, battery);
      }
      return grouped;
    }, new Map<string, { batterySerial: string; flightCount: number; totalDurationSecs: number; maxCycleCount: number | null }>()).values(),
  )
    .filter(b => !isDecommissioned(getPairedBatteryDisplayName(b.batterySerial, batteryPairIndex, getBatteryDisplayName)))
    .map(b => {
      const progress = getBatteryProgress(b.batterySerial);
      const flightPercent = Math.min((progress.flights / maintenanceThresholds.battery.flights) * 100, 100);
      const airtimePercent = Math.min((progress.airtime / maintenanceThresholds.battery.airtime) * 100, 100);
      const displayName = getPairedBatteryDisplayName(b.batterySerial, batteryPairIndex, getBatteryDisplayName);
      return {
        serial: b.batterySerial,
        displayName,
        ...progress,
        combinedProgress: flightPercent + airtimePercent,
      };
    })
    .filter(b => !batterySearch || b.displayName.toLowerCase().includes(batterySearch.toLowerCase()))
    .sort((a, b) => b.combinedProgress - a.combinedProgress);

  // Aircraft list: filtered by search, sorted by combined progress
  const aircraftProgressList = drones
    .filter(d => d.droneSerial && !isDecommissioned(getDroneDisplayName(d.droneSerial, d.aircraftName || d.droneModel)))
    .map(d => {
      const progress = getAircraftProgress(d.droneSerial!);
      const flightPercent = Math.min((progress.flights / maintenanceThresholds.aircraft.flights) * 100, 100);
      const airtimePercent = Math.min((progress.airtime / maintenanceThresholds.aircraft.airtime) * 100, 100);
      return {
        serial: d.droneSerial!,
        displayName: getDroneDisplayName(d.droneSerial!, d.aircraftName || d.droneModel),
        ...progress,
        combinedProgress: flightPercent + airtimePercent,
      };
    })
    .filter(a => !aircraftSearch || a.displayName.toLowerCase().includes(aircraftSearch.toLowerCase()))
    .sort((a, b) => b.combinedProgress - a.combinedProgress);

  const cardBg = isLight ? 'bg-white border-gray-200' : 'bg-drone-surface border-gray-700/50';
  const textPrimary = isLight ? 'text-gray-900' : 'text-white';
  const textMuted = isLight ? 'text-gray-500' : 'text-gray-500';
  const inputBg = isLight ? 'bg-gray-100 border-gray-300' : 'bg-gray-800 border-gray-600';
  const progressBg = isLight ? 'bg-gray-200' : 'bg-gray-700/50';

  /** Render maintenance status badge: green if within threshold, amber if overdue, hidden if never maintained */
  const renderOverdueBadge = (lastReset: Date | null, type: 'battery' | 'aircraft') => {
    const days = getDaysSinceLastMaintenance(lastReset);
    if (days === null) return null;
    const daysThreshold = type === 'battery' ? maintenanceThresholds.battery.days : maintenanceThresholds.aircraft.days;
    if (days > daysThreshold) {
      return (
        <span className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/20 text-amber-400'}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          {t('overview.maintenanceOverdue', { days })}
        </span>
      );
    }
    return (
      <span className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-500/20 text-green-400'}`}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="20 6 9 17 4 12" /></svg>
        {t('overview.maintenanceOk')}
      </span>
    );
  };

  /** Render a single maintenance list item (battery or aircraft) */
  const renderMaintenanceItem = (
    item: { serial: string; displayName: string; flights: number; airtime: number; lastReset: Date | null; combinedProgress: number },
    type: 'battery' | 'aircraft',
  ) => {
    const isExpanded = type === 'battery' ? expandedBatteries.has(item.serial) : expandedAircrafts.has(item.serial);
    const toggle = type === 'battery' ? toggleBatteryExpand : toggleAircraftExpand;
    const thresholds = type === 'battery' ? maintenanceThresholds.battery : maintenanceThresholds.aircraft;
    const flightPercent = Math.min((item.flights / thresholds.flights) * 100, 100);
    const airtimePercent = Math.min((item.airtime / thresholds.airtime) * 100, 100);
    const getMaintenanceDate = type === 'battery' ? getBatteryMaintenanceDate : getAircraftMaintenanceDate;
    const setMaintenanceDate = type === 'battery' ? setBatteryMaintenanceDate : setAircraftMaintenanceDate;
    const openDatePicker = type === 'battery' ? openBatteryDatePicker : openAircraftDatePicker;
    const setOpenDatePicker = type === 'battery' ? setOpenBatteryDatePicker : setOpenAircraftDatePicker;
    const handleMaintenance = type === 'battery' ? handleBatteryMaintenance : handleAircraftMaintenance;

    return (
      <div
        key={item.serial}
        className={`rounded-lg transition-colors border ${isExpanded
          ? (isLight ? 'bg-gray-100 border-drone-primary/30' : 'bg-gray-700/30 border-drone-primary/30')
          : (isLight ? 'bg-gray-100/70 hover:bg-gray-100 border-transparent' : 'bg-gray-700/20 hover:bg-gray-700/30 border-transparent')
          }`}
      >
        {/* Clickable header row */}
        <button
          type="button"
          onClick={() => toggle(item.serial)}
          className="w-full text-left p-3 focus:outline-none group"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${isExpanded
                ? (isLight ? 'bg-drone-primary/15' : 'bg-drone-primary/20')
                : (isLight ? 'bg-gray-200 group-hover:bg-gray-300' : 'bg-gray-600/40 group-hover:bg-gray-600/60')
                }`}>
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round"
                  className={`flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''} ${isExpanded ? 'text-drone-primary' : textMuted}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
              <span className={`text-xs font-medium ${textPrimary} truncate`}>{item.displayName}</span>
              {renderOverdueBadge(item.lastReset, type)}
            </div>
          </div>
          {/* Progress bars (always visible) */}
          <div className="grid grid-cols-2 gap-3 pl-[18px]">
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className={`text-[10px] ${textMuted}`}>{t('overview.flights')}</span>
                <span className={`text-[10px] ${getProgressTextColor(flightPercent)}`}>
                  {item.flights}/{thresholds.flights}
                </span>
              </div>
              <div className={`relative h-1.5 ${progressBg} rounded-full overflow-hidden`}>
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                  style={{ width: `${flightPercent}%`, backgroundColor: getProgressBarColor(flightPercent) }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className={`text-[10px] ${textMuted}`}>{t('overview.airtime')}</span>
                <span className={`text-[10px] ${getProgressTextColor(airtimePercent)}`}>
                  {item.airtime.toFixed(1)}/{thresholds.airtime}h
                </span>
              </div>
              <div className={`relative h-1.5 ${progressBg} rounded-full overflow-hidden`}>
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                  style={{ width: `${airtimePercent}%`, backgroundColor: getProgressBarColor(airtimePercent) }}
                />
              </div>
            </div>
          </div>
        </button>

        {/* Expandable maintenance actions */}
        {isExpanded && (
          <div className={`px-3 pb-3 pt-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-600/30'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-[10px] ${textMuted}`}>
                {t('overview.lastMaintenance', { date: formatLastReset(item.lastReset) })}
              </span>
            </div>
            <div className="flex items-center gap-2 h-9">
              <div className="relative w-[40%]">
                <button
                  type="button"
                  onClick={(e) => {
                    if (openDatePicker === item.serial) {
                      setOpenDatePicker(null);
                      setDatePickerAnchor(null);
                    } else {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setDatePickerAnchor({ top: rect.top, left: rect.left });
                      setOpenDatePicker(item.serial);
                    }
                  }}
                  className={`w-full h-9 px-3 text-xs rounded-lg border flex items-center justify-between gap-2 focus:outline-none focus:ring-1 focus:ring-drone-primary ${isLight
                    ? 'bg-white border-gray-300 text-gray-900 hover:bg-gray-50'
                    : 'bg-drone-surface border-gray-600 text-gray-100 hover:bg-gray-700/30'
                    }`}
                >
                  <span className="truncate text-[11px]">{formatDateDisplay(getMaintenanceDate(item.serial))}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-60"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                </button>
                <DatePickerPopover
                  isOpen={!!(openDatePicker === item.serial && datePickerAnchor)}
                  onClose={() => {
                    setOpenDatePicker(null);
                    setDatePickerAnchor(null);
                  }}
                  isLight={isLight}
                  mode="single"
                  selected={getMaintenanceDate(item.serial)}
                  onSelect={(date) => {
                    setMaintenanceDate(item.serial, date);
                    setOpenDatePicker(null);
                    setDatePickerAnchor(null);
                  }}
                  disabled={{ after: today }}
                  defaultMonth={getMaintenanceDate(item.serial)}
                  jumpMaxDate={today}
                  onJumpDate={(date) => {
                    setMaintenanceDate(item.serial, date);
                    setOpenDatePicker(null);
                    setDatePickerAnchor(null);
                  }}
                  style={datePickerAnchor ? {
                    top: Math.max(8, datePickerAnchor.top - 310),
                    left: datePickerAnchor.left,
                  } : undefined}
                />
              </div>
              <button
                onClick={() => handleMaintenance(item.serial)}
                className={`flex-1 h-9 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${isLight
                  ? 'border-green-500 text-green-600 hover:bg-green-50'
                  : 'border-green-500/50 text-green-400 hover:bg-green-500/10'
                  }`}
              >
                {t('overview.maintenanceDone')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`card p-5 border ${cardBg}`}>
      <div className="flex items-center gap-2 mb-5">
        <MaintenanceIcon />
        <h3 className={`text-base font-semibold ${textPrimary}`}>{t('overview.maintenance')}</h3>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Battery Maintenance */}
        <div className={`p-4 rounded-lg border ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800/30 border-gray-700/50'}`}>
          <div className="flex items-center gap-2 mb-4">
            <BatteryIcon />
            <h4 className={`text-sm font-semibold ${textPrimary}`}>{t('overview.batteryMaintenance')}</h4>
          </div>

          {/* Threshold Inputs */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <label className={`block text-xs ${textMuted} mb-1.5`}>{t('overview.flightThreshold')}</label>
              <input
                type="number"
                value={batteryFlightThreshold}
                onChange={(e) => setBatteryFlightThreshold(e.target.value)}
                className={`w-full h-8 px-2 text-xs rounded border ${inputBg} ${textPrimary} focus:outline-none focus:ring-1 focus:ring-drone-primary`}
                min="1"
              />
            </div>
            <div>
              <label className={`block text-xs ${textMuted} mb-1.5`}>{t('overview.airtimeThreshold')}</label>
              <input
                type="number"
                value={batteryAirtimeThreshold}
                onChange={(e) => setBatteryAirtimeThreshold(e.target.value)}
                className={`w-full h-8 px-2 text-xs rounded border ${inputBg} ${textPrimary} focus:outline-none focus:ring-1 focus:ring-drone-primary`}
                min="0.1"
                step="0.5"
              />
            </div>
            <div>
              <label className={`block text-xs ${textMuted} mb-1.5`}>{t('overview.daysThreshold')}</label>
              <input
                type="number"
                value={batteryDaysThreshold}
                onChange={(e) => setBatteryDaysThreshold(e.target.value)}
                className={`w-full h-8 px-2 text-xs rounded border ${inputBg} ${textPrimary} focus:outline-none focus:ring-1 focus:ring-drone-primary`}
                min="1"
              />
            </div>
          </div>

          <button
            onClick={handleApplyBatteryThresholds}
            className="w-full h-7 text-xs font-medium rounded bg-drone-primary/20 text-drone-primary hover:bg-drone-primary/30 transition-colors mb-4"
          >
            {t('overview.applyThresholds')}
          </button>

          {/* Search box */}
          <div className="relative mb-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${textMuted}`}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              type="text"
              value={batterySearch}
              onChange={(e) => setBatterySearch(e.target.value)}
              placeholder={t('overview.searchBatteries')}
              className={`w-full h-8 pl-8 pr-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-drone-primary ${inputBg} ${textPrimary}`}
            />
          </div>

          {/* Single battery list */}
          {batteryProgressList.length > 0 ? (
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {batteryProgressList.map(b => renderMaintenanceItem(b, 'battery'))}
            </div>
          ) : (
            <p className={`text-xs ${textMuted} text-center py-4`}>
              {batterySearch ? t('overview.noSearchResults') : t('overview.noBatteryData')}
            </p>
          )}
        </div>

        {/* Aircraft Maintenance */}
        <div className={`p-4 rounded-lg border ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800/30 border-gray-700/50'}`}>
          <div className="flex items-center gap-2 mb-4">
            <AircraftIcon />
            <h4 className={`text-sm font-semibold ${textPrimary}`}>{t('overview.aircraftMaintenance')}</h4>
          </div>

          {/* Threshold Inputs */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <label className={`block text-xs ${textMuted} mb-1.5`}>{t('overview.flightThreshold')}</label>
              <input
                type="number"
                value={aircraftFlightThreshold}
                onChange={(e) => setAircraftFlightThreshold(e.target.value)}
                className={`w-full h-8 px-2 text-xs rounded border ${inputBg} ${textPrimary} focus:outline-none focus:ring-1 focus:ring-drone-primary`}
                min="1"
              />
            </div>
            <div>
              <label className={`block text-xs ${textMuted} mb-1.5`}>{t('overview.airtimeThreshold')}</label>
              <input
                type="number"
                value={aircraftAirtimeThreshold}
                onChange={(e) => setAircraftAirtimeThreshold(e.target.value)}
                className={`w-full h-8 px-2 text-xs rounded border ${inputBg} ${textPrimary} focus:outline-none focus:ring-1 focus:ring-drone-primary`}
                min="0.1"
                step="0.5"
              />
            </div>
            <div>
              <label className={`block text-xs ${textMuted} mb-1.5`}>{t('overview.daysThreshold')}</label>
              <input
                type="number"
                value={aircraftDaysThreshold}
                onChange={(e) => setAircraftDaysThreshold(e.target.value)}
                className={`w-full h-8 px-2 text-xs rounded border ${inputBg} ${textPrimary} focus:outline-none focus:ring-1 focus:ring-drone-primary`}
                min="1"
              />
            </div>
          </div>

          <button
            onClick={handleApplyAircraftThresholds}
            className="w-full h-7 text-xs font-medium rounded bg-drone-primary/20 text-drone-primary hover:bg-drone-primary/30 transition-colors mb-4"
          >
            {t('overview.applyThresholds')}
          </button>

          {/* Search box */}
          <div className="relative mb-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${textMuted}`}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input
              type="text"
              value={aircraftSearch}
              onChange={(e) => setAircraftSearch(e.target.value)}
              placeholder={t('overview.searchAircraft')}
              className={`w-full h-8 pl-8 pr-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-drone-primary ${inputBg} ${textPrimary}`}
            />
          </div>

          {/* Single aircraft list */}
          {aircraftProgressList.length > 0 ? (
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {aircraftProgressList.map(a => renderMaintenanceItem(a, 'aircraft'))}
            </div>
          ) : (
            <p className={`text-xs ${textMuted} text-center py-4`}>
              {aircraftSearch ? t('overview.noSearchResults') : t('overview.noDroneData')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function MaintenanceIcon() {
  return (
    <svg className="w-5 h-5 text-drone-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="2" y="7" width="18" height="10" rx="2" strokeWidth={1.5} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M22 10v4" />
      <rect x="5" y="10" width="5" height="4" fill="currentColor" stroke="none" rx="0.5" />
    </svg>
  );
}

function AircraftIcon() {
  return (
    <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
    </svg>
  );
}

// =============================================================================
// Icons
// =============================================================================

function FlightIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
      />
    </svg>
  );
}

function DistanceIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

// function DataIcon() {
//   return (
//     <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//       <path
//         strokeLinecap="round"
//         strokeLinejoin="round"
//         strokeWidth={1.5}
//         d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
//       />
//     </svg>
//   );
// }

function CameraIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function LightningIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  );
}

function AltitudeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 10l7-7 7 7M12 3v18"
      />
    </svg>
  );
}

function HomeDistanceIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
      />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
      />
    </svg>
  );
}

function TimerIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function SpeedometerIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 12l4-4"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3.34 17a10 10 0 1117.32 0"
      />
    </svg>
  );
}
