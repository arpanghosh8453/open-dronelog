/**
 * Telemetry charts component using ECharts
 * Displays height, VPS height, speed, battery, attitude, RC, GPS, distance to home, and velocity data
 * Optimized for performance with large datasets
 */

import { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption, ECharts, LineSeriesOption } from 'echarts';
import type { TelemetryData } from '@/types';
import type { UnitSystem, UnitPreferences, SpeedUnit } from '@/lib/utils';
import { ensureAmPmUpperCase, speedMultiplierFromMs, speedUnitLabel } from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';
import { useTranslation } from 'react-i18next';
import ColorPickerModal from '@/components/dashboard/ColorPickerModal';
import { useIsMobileRuntime } from '@/hooks/platform/useIsMobileRuntime';

/** Translation function type for passing to chart builders */
type TFn = (key: string, options?: any) => string;

// ============================================================================
// TELEMETRY FIELD DEFINITIONS
// ============================================================================

/** Definition of a telemetry field that can be plotted */
interface TelemetryFieldDef {
  id: string;
  label: string;
  color: string;
  /** The key in TelemetryData to get raw values */
  dataKey: keyof TelemetryData | 'distanceToHome';
  /** Unit string (may be overridden by unitSystem) */
  unit: string;
  /** Unit string for imperial system */
  unitImperial?: string;
  /** Conversion factor for metric (applied to raw m/s values) */
  metricFactor?: number;
  /** Conversion factor for imperial (applied to raw m/s values) */
  imperialFactor?: number;
  /** Group this field belongs to for organization */
  group: 'altitude' | 'speed' | 'battery' | 'attitude' | 'gimbal' | 'rc' | 'gps' | 'velocity';
}
/** Maximum null-gap duration to visually bridge in charts (display only). */
const MAX_DISPLAY_JOIN_GAP_SECONDS = 5.0;

/** All available telemetry fields that can be plotted */
const TELEMETRY_FIELDS: TelemetryFieldDef[] = [
  // Altitude group
  { id: 'height', label: 'telemetry.height', color: '#00A0DC', dataKey: 'height', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'altitude' },
  { id: 'vpsHeight', label: 'telemetry.vpsHeight', color: '#f97316', dataKey: 'vpsHeight', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'altitude' },
  { id: 'altitude', label: 'telemetry.altitudeGps', color: '#22d3ee', dataKey: 'altitude', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'altitude' },

  // Speed group
  { id: 'speed', label: 'telemetry.speed', color: '#00D4AA', dataKey: 'speed', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'speed' },
  { id: 'velocityX', label: 'telemetry.xSpeed', color: '#ef4444', dataKey: 'velocityX', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'velocity' },
  { id: 'velocityY', label: 'telemetry.ySpeed', color: '#a855f7', dataKey: 'velocityY', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'velocity' },
  { id: 'velocityZ', label: 'telemetry.zSpeed', color: '#7c3aed', dataKey: 'velocityZ', unit: 'km/h', unitImperial: 'mph', metricFactor: 3.6, imperialFactor: 2.236936, group: 'velocity' },

  // Battery group
  { id: 'battery', label: 'telemetry.batteryPercent', color: '#f59e0b', dataKey: 'battery', unit: '%', group: 'battery' },
  { id: 'batteryVoltage', label: 'telemetry.voltage', color: '#3b82f6', dataKey: 'batteryVoltage', unit: 'V', group: 'battery' },
  { id: 'batteryTemp', label: 'telemetry.temperature', color: '#e11d48', dataKey: 'batteryTemp', unit: '°C', unitImperial: '°F', group: 'battery' },

  // Attitude group
  { id: 'pitch', label: 'telemetry.pitch', color: '#8b5cf6', dataKey: 'pitch', unit: '°', group: 'attitude' },
  { id: 'roll', label: 'telemetry.roll', color: '#ec4899', dataKey: 'roll', unit: '°', group: 'attitude' },
  { id: 'yaw', label: 'telemetry.yaw', color: '#14b8a6', dataKey: 'yaw', unit: '°', group: 'attitude' },

  // Gimbal group
  { id: 'gimbalPitch', label: 'telemetry.gimbalPitch', color: '#f97316', dataKey: 'gimbalPitch', unit: '°', group: 'gimbal' },
  { id: 'gimbalRoll', label: 'telemetry.gimbalRoll', color: '#10b981', dataKey: 'gimbalRoll', unit: '°', group: 'gimbal' },
  { id: 'gimbalYaw', label: 'telemetry.gimbalYaw', color: '#06b6d4', dataKey: 'gimbalYaw', unit: '°', group: 'gimbal' },

  // RC group
  { id: 'rcSignal', label: 'telemetry.rcSignal', color: '#22c55e', dataKey: 'rcSignal', unit: '%', group: 'rc' },
  { id: 'rcUplink', label: 'telemetry.rcUplink', color: '#84cc16', dataKey: 'rcUplink', unit: '%', group: 'rc' },
  { id: 'rcDownlink', label: 'telemetry.rcDownlink', color: '#0369a1', dataKey: 'rcDownlink', unit: '%', group: 'rc' },

  // GPS group
  { id: 'satellites', label: 'telemetry.gpsSatellites', color: '#0ea5e9', dataKey: 'satellites', unit: '', group: 'gps' },
  { id: 'distanceToHome', label: 'telemetry.distToHome', color: '#10b981', dataKey: 'distanceToHome', unit: 'm', unitImperial: 'ft', metricFactor: 1, imperialFactor: 3.28084, group: 'gps' },

  // Cell Voltages (virtual field that expands to all available cells)
  { id: 'allCellVoltages', label: 'telemetry.cellVoltages', color: '#fbbf24', dataKey: 'cellVoltages', unit: 'V', group: 'battery' },

  // Battery capacity group
  { id: 'batteryFullCapacity', label: 'telemetry.fullCapacity', color: '#06b6d4', dataKey: 'batteryFullCapacity', unit: 'mAh', group: 'battery' },
  { id: 'batteryRemainedCapacity', label: 'telemetry.remainedCapacity', color: '#f43f5e', dataKey: 'batteryRemainedCapacity', unit: 'mAh', group: 'battery' },
];

/** Get field definition by id */
function getFieldDef(id: string): TelemetryFieldDef | undefined {
  return TELEMETRY_FIELDS.find(f => f.id === id);
}

/** Resolve which UnitSystem ('metric'|'imperial') applies to a given field based on granular prefs */
function resolveUnitForField(field: TelemetryFieldDef, unitPrefs: UnitPreferences): UnitSystem | SpeedUnit {
  switch (field.group) {
    case 'altitude': return unitPrefs.altitude;
    case 'speed':
    case 'velocity': return unitPrefs.speed;
    case 'battery':
      // batteryTemp uses temperature pref; other battery fields are unit-agnostic
      if (field.id === 'batteryTemp') return unitPrefs.temperature;
      return 'metric'; // %, V, mAh — no conversion
    case 'gps':
      // distanceToHome uses distance pref; satellites is unit-agnostic
      if (field.id === 'distanceToHome') return unitPrefs.distance;
      return 'metric';
    default: return 'metric'; // attitude, rc — degrees/percent, no conversion
  }
}

/** Get data series for a field with unit conversion applied */
function getFieldData(
  fieldId: string,
  data: TelemetryData,
  unitSystem: UnitSystem | SpeedUnit
): (number | null)[] {
  const field = getFieldDef(fieldId);
  if (!field) return [];

  // allCellVoltages is handled specially in createDynamicChart, not here
  if (fieldId === 'allCellVoltages') {
    return [];
  }

  // Special handling for distanceToHome (computed field)
  if (field.dataKey === 'distanceToHome') {
    const distances = computeDistanceToHomeSeries(data);
    const factor = unitSystem === 'imperial' ? (field.imperialFactor ?? 1) : (field.metricFactor ?? 1);
    return distances.map(v => v === null ? null : v * factor);
  }

  // Special handling for height - use altitude as fallback
  if (fieldId === 'height') {
    const hasHeight = data.height.some((val) => val !== null);
    const heightSource = hasHeight ? data.height : (data.altitude ?? []);
    const factor = unitSystem === 'imperial' ? (field.imperialFactor ?? 1) : (field.metricFactor ?? 1);
    return heightSource.map(v => v === null ? null : v * factor);
  }

  // Special handling for batteryTemp — °C→°F is affine, not a simple factor
  if (fieldId === 'batteryTemp') {
    const rawData = data.batteryTemp;
    if (!rawData || !Array.isArray(rawData)) return [];
    if (unitSystem === 'imperial') {
      return rawData.map(v => {
        if (v === null || v === undefined || Math.abs(v) < 1e-6) return null;
        return v * 9 / 5 + 32;
      });
    }
    return rawData.map(v => (v === null || v === undefined || Math.abs(v) < 1e-6) ? null : v);
  }

  // Special handling for battery percentage and voltage: ignore 0 values
  if (fieldId === 'battery' || fieldId === 'batteryVoltage') {
    const rawData = data[fieldId as ('battery' | 'batteryVoltage')];
    if (!rawData || !Array.isArray(rawData)) return [];
    return rawData.map(v => (v === null || v === undefined || v === 0) ? null : v);
  }

  // RC signal quality: treat 0 as unavailable/no sample for display.
  if (fieldId === 'rcSignal' || fieldId === 'rcUplink' || fieldId === 'rcDownlink') {
    const rawData = data[fieldId as ('rcSignal' | 'rcUplink' | 'rcDownlink')];
    if (!rawData || !Array.isArray(rawData)) return [];
    return rawData.map(v => (v === null || v === undefined || v === 0) ? null : v);
  }

  const rawData = data[field.dataKey as keyof TelemetryData];
  if (!rawData || !Array.isArray(rawData)) return [];

  // Apply unit conversion
  const factor = field.group === 'speed' || field.group === 'velocity'
    ? speedMultiplierFromMs(unitSystem as SpeedUnit)
    : (unitSystem === 'imperial' ? (field.imperialFactor ?? 1) : (field.metricFactor ?? 1));

  return (rawData as (number | null)[]).map(v =>
    v === null || v === undefined ? null : v * factor
  );
}

/** Get the unit string for a field based on unit system */
function getFieldUnit(fieldId: string, unitSystem: UnitSystem | SpeedUnit): string {
  const field = getFieldDef(fieldId);
  if (!field) return '';
  if (field.group === 'speed' || field.group === 'velocity') {
    return speedUnitLabel(unitSystem as SpeedUnit);
  }
  return unitSystem === 'imperial' && field.unitImperial ? field.unitImperial : field.unit;
}

/** Get a descriptive category label for a unit when multiple series share it */
function getUnitCategoryLabel(unit: string, t: TFn): string {
  const unitCategories: Record<string, string> = {
    'm': t('telemetry.distanceM'),
    'ft': t('telemetry.distanceFt'),
    'km/h': t('telemetry.speedKmh'),
    'mph': t('telemetry.speedMph'),
    'm/s': 'Speed (m/s)',
    'ft/s': 'Speed (ft/s)',
    '°': 'Degrees (°)',
    '%': 'Percent (%)',
    'V': t('telemetry.cellVoltageV'),
    '°C': t('telemetry.tempC'),
  };
  return unitCategories[unit] || unit;
}

/**
 * Display-only interpolation for short missing runs.
 * This does not mutate source telemetry and is used only for chart rendering.
 */
function bridgeShortNullGaps(
  values: (number | null)[],
  time: number[],
  maxGapSeconds = MAX_DISPLAY_JOIN_GAP_SECONDS
): (number | null)[] {
  if (values.length === 0 || values.length !== time.length) {
    return [...values];
  }

  const bridged = [...values];
  let i = 0;
  while (i < bridged.length) {
    if (typeof bridged[i] === 'number' && Number.isFinite(bridged[i])) {
      i += 1;
      continue;
    }

    const gapStart = i;
    while (i < bridged.length && (bridged[i] === null || !Number.isFinite(bridged[i] as number))) {
      i += 1;
    }
    const gapEnd = i - 1;
    const leftIdx = gapStart - 1;
    const rightIdx = i;

    if (leftIdx < 0 || rightIdx >= bridged.length) {
      continue;
    }

    const leftVal = bridged[leftIdx];
    const rightVal = bridged[rightIdx];
    const leftTime = time[leftIdx];
    const rightTime = time[rightIdx];

    if (
      typeof leftVal !== 'number' ||
      !Number.isFinite(leftVal) ||
      typeof rightVal !== 'number' ||
      !Number.isFinite(rightVal) ||
      !Number.isFinite(leftTime) ||
      !Number.isFinite(rightTime) ||
      rightTime <= leftTime ||
      (rightTime - leftTime) > maxGapSeconds
    ) {
      continue;
    }

    const span = rightTime - leftTime;
    for (let j = gapStart; j <= gapEnd; j += 1) {
      const t = time[j];
      if (!Number.isFinite(t)) continue;
      const ratio = (t - leftTime) / span;
      bridged[j] = leftVal + (rightVal - leftVal) * ratio;
    }
  }

  return bridged;
}

/** Create a dynamic chart based on selected fields */
function createDynamicChart(
  selectedFieldIds: string[],
  data: TelemetryData,
  unitPrefs: UnitPreferences,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn,
  colorOverrides?: Record<string, string>
): EChartsOption | null {
  if (selectedFieldIds.length === 0) return null;

  // Check if allCellVoltages is selected
  const hasAllCellVoltages = selectedFieldIds.includes('allCellVoltages');
  const otherFieldIds = selectedFieldIds.filter(id => id !== 'allCellVoltages');

  // Get other fields
  const otherFields = otherFieldIds
    .map(id => getFieldDef(id))
    .filter((f): f is TelemetryFieldDef => f !== undefined);

  // Build cell voltage series if selected
  const cellVoltageColors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#a855f7'];
  let cellVoltageSeries: { label: string; data: (number | null)[]; color: string; unit: string }[] = [];

  if (hasAllCellVoltages) {
    const cellVoltages = data.cellVoltages;
    if (cellVoltages && cellVoltages.length > 0) {
      const firstValidEntry = cellVoltages.find((v) => v !== null && v !== undefined);
      if (firstValidEntry) {
        const numCells = firstValidEntry.length;
        for (let i = 0; i < numCells; i++) {
          const cellData = cellVoltages.map(voltages => {
            if (voltages && voltages[i] !== undefined && voltages[i] !== null && voltages[i] !== 0) {
              return voltages[i];
            }
            return null;
          });
          cellVoltageSeries.push({
            label: t('telemetry.cell', { n: i + 1 }),
            data: cellData,
            color: cellVoltageColors[i % cellVoltageColors.length],
            unit: 'V',
          });
        }
      }
    }
  }

  // Get data series for other fields
  const regularSeriesData = otherFields.map(field => {
    const resolved = resolveUnitForField(field, unitPrefs);
    return {
      field,
      data: getFieldData(field.id, data, resolved),
      unit: getFieldUnit(field.id, resolved),
    };
  });

  // If only allCellVoltages and no cell data, return null
  if (otherFields.length === 0 && cellVoltageSeries.length === 0) return null;

  // Combine all series
  const allSeriesData: { label: string; data: (number | null)[]; color: string; unit: string; fieldId: string | null }[] = [
    ...regularSeriesData.map(s => ({ label: t(s.field.label), data: s.data, color: colorOverrides?.[s.field.id] || s.field.color, unit: s.unit, fieldId: s.field.id })),
    ...cellVoltageSeries.map(s => ({ ...s, fieldId: null })),
  ];

  if (allSeriesData.length === 0) return null;
  const displaySeriesData = allSeriesData.map((series) => ({
    ...series,
    data: bridgeShortNullGaps(series.data, data.time),
  }));

  // Create legend data
  const legendData = displaySeriesData.map(s => s.label);

  // Group series by unit to share y-axis scales.
  const unitGroups = new Map<string, { indices: number[]; data: (number | null)[] }>();
  displaySeriesData.forEach((s, index) => {
    const unitKey = s.unit || '__no_unit__';
    if (!unitGroups.has(unitKey)) {
      unitGroups.set(unitKey, { indices: [], data: [] });
    }
    const group = unitGroups.get(unitKey)!;
    group.indices.push(index);
    group.data.push(...s.data);
  });

  // Assign y-axis indices based on unique units (max 2 axes)
  const uniqueUnits = Array.from(unitGroups.keys());
  const unitToAxisIndex = new Map<string, number>();
  uniqueUnits.forEach((unit, idx) => {
    unitToAxisIndex.set(unit, Math.min(idx, 1)); // Clamp to max 2 axes (index 0 and 1)
  });

  // Compute combined ranges for each unit group
  const unitRanges = new Map<string, { min?: number; max?: number }>();
  for (const [unit, group] of unitGroups) {
    unitRanges.set(unit, computeRange(group.data));
  }

  // Create series with y-axis index based on unit
  const series: LineSeriesOption[] = displaySeriesData.map((s, index) => {
    const unitKey = s.unit || '__no_unit__';
    const yAxisIndex = displaySeriesData.length > 1 ? unitToAxisIndex.get(unitKey) ?? 0 : 0;
    return {
      name: s.label,
      type: 'line',
      data: s.data,
      yAxisIndex,
      smooth: true,
      connectNulls: false,
      symbol: 'none',
      itemStyle: { color: s.color },
      lineStyle: { color: s.color, width: index === 0 ? 2 : 1.5 },
      ...(index === 0 ? {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: `${s.color}4d` },
              { offset: 1, color: `${s.color}0d` },
            ],
          },
        },
      } : {}),
    };
  });

  // Create Y-axes based on unique units (max 2)
  const yAxis: any[] = [];
  const axisUnits = uniqueUnits.slice(0, 2); // Max 2 axes
  axisUnits.forEach((unit, axisIndex) => {
    const group = unitGroups.get(unit)!;
    const range = unitRanges.get(unit)!;
    // Use the first series with this unit for display properties
    const firstSeriesIndex = group.indices[0];
    const s = displaySeriesData[firstSeriesIndex];
    // Build axis name: if multiple series share this unit, show descriptive category; otherwise show label with unit
    const seriesWithUnit = group.indices.map(i => displaySeriesData[i]);
    const axisName = seriesWithUnit.length > 1 && s.unit
      ? getUnitCategoryLabel(s.unit, t)
      : (s.unit ? `${s.label} (${s.unit})` : s.label);
    yAxis.push({
      type: 'value',
      name: axisName,
      min: range.min,
      max: range.max,
      nameTextStyle: { color: s.color },
      axisLine: { lineStyle: { color: s.color } },
      axisLabel: { color: '#9ca3af' },
      splitLine: { lineStyle: { color: splitLineColor }, show: axisIndex === 0 },
    });
  });

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: legendData,
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis,
    series,
  };
}

// ============================================================================
// CHART CONFIGURATION TYPES & PERSISTENCE
// ============================================================================

/** Configuration for a single chart panel */
interface ChartPanelConfig {
  /** Custom title (null = use default) */
  title: string | null;
  /** Selected field IDs to plot (max 3) */
  selectedFields: string[];
}

/** All chart configurations keyed by chart ID */
interface TelemetryChartsConfig {
  altitudeSpeed: ChartPanelConfig;
  battery: ChartPanelConfig;
  cellVoltage: ChartPanelConfig;
  attitude: ChartPanelConfig;
  gimbal: ChartPanelConfig;
  rcSignal: ChartPanelConfig;
  distanceToHome: ChartPanelConfig;
  velocity: ChartPanelConfig;
  gps: ChartPanelConfig;
  batteryCapacity: ChartPanelConfig;
}

/** Default configuration for all charts */
const DEFAULT_CHART_CONFIGS: TelemetryChartsConfig = {
  altitudeSpeed: { title: null, selectedFields: ['height', 'vpsHeight'] },
  battery: { title: null, selectedFields: ['battery', 'batteryTemp'] },
  cellVoltage: { title: null, selectedFields: ['allCellVoltages', 'batteryVoltage'] },
  attitude: { title: null, selectedFields: ['pitch', 'roll', 'yaw'] },
  gimbal: { title: null, selectedFields: ['gimbalPitch', 'gimbalRoll', 'gimbalYaw'] },
  rcSignal: { title: null, selectedFields: ['rcSignal'] }, // Will be overridden if uplink/downlink available
  distanceToHome: { title: null, selectedFields: ['distanceToHome'] },
  velocity: { title: null, selectedFields: ['velocityX', 'velocityY', 'velocityZ'] },
  gps: { title: null, selectedFields: ['satellites'] },
  batteryCapacity: { title: null, selectedFields: ['batteryFullCapacity', 'batteryRemainedCapacity'] },
};

const CHART_CONFIG_STORAGE_KEY = 'telemetryChartConfigs';
/** Bump this version to force a one-time reset of saved configs to new defaults */
const CHART_CONFIG_VERSION = 3;
const CHART_CONFIG_VERSION_KEY = 'telemetryChartConfigsVersion';

/** Load chart configurations from localStorage */
function loadChartConfigs(): TelemetryChartsConfig {
  try {
    // One-time migration: if stored version doesn't match, reset to new defaults
    const storedVersion = parseInt(localStorage.getItem(CHART_CONFIG_VERSION_KEY) || '0', 10);
    if (storedVersion < CHART_CONFIG_VERSION) {
      localStorage.removeItem(CHART_CONFIG_STORAGE_KEY);
      localStorage.setItem(CHART_CONFIG_VERSION_KEY, String(CHART_CONFIG_VERSION));
      return { ...DEFAULT_CHART_CONFIGS };
    }

    const stored = localStorage.getItem(CHART_CONFIG_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Deep merge with defaults to ensure all keys exist and no empty arrays
      const result = { ...DEFAULT_CHART_CONFIGS };
      for (const key of Object.keys(DEFAULT_CHART_CONFIGS) as (keyof TelemetryChartsConfig)[]) {
        if (parsed[key]) {
          result[key] = {
            ...DEFAULT_CHART_CONFIGS[key],
            ...parsed[key],
            // Ensure selectedFields is never empty - use default if stored is empty
            selectedFields: parsed[key].selectedFields?.length > 0
              ? parsed[key].selectedFields
              : DEFAULT_CHART_CONFIGS[key].selectedFields,
          };
        }
      }
      return result;
    }
  } catch (e) {
    console.warn('Failed to load telemetry chart configs:', e);
  }
  return { ...DEFAULT_CHART_CONFIGS };
}

/** Save chart configurations to localStorage */
function saveChartConfigs(configs: TelemetryChartsConfig): void {
  try {
    localStorage.setItem(CHART_CONFIG_STORAGE_KEY, JSON.stringify(configs));
  } catch (e) {
    console.warn('Failed to save telemetry chart configs:', e);
  }
}

// ============================================================================
// CHART HEADER COMPONENT (Title + Multi-Select)
// ============================================================================

interface ChartHeaderProps {
  config: ChartPanelConfig;
  availableFields: TelemetryFieldDef[];
  onFieldsChange: (fields: string[]) => void;
  unitPrefs: UnitPreferences;
  theme: 'dark' | 'light';
  getFieldColor: (fieldId: string) => string;
  onFieldColorChange: (fieldId: string, color: string) => void;
  onFieldColorReset: (fieldId: string) => void;
}

function ChartHeader({
  config,
  availableFields,
  onFieldsChange,
  unitPrefs,
  theme,
  getFieldColor,
  onFieldColorChange,
  onFieldColorReset,
}: ChartHeaderProps) {
  const { t } = useTranslation();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [colorPickerFieldId, setColorPickerFieldId] = useState<string | null>(null);
  const [colorPickerPos, setColorPickerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter available fields by search
  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) return availableFields;
    const q = searchQuery.toLowerCase();
    return availableFields.filter(f => t(f.label).toLowerCase().includes(q));
  }, [availableFields, searchQuery, t]);

  // Sort: selected first, then alphabetically
  const sortedFields = useMemo(() => {
    return [...filteredFields].sort((a, b) => {
      const aSelected = config.selectedFields.includes(a.id);
      const bSelected = config.selectedFields.includes(b.id);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return t(a.label).localeCompare(t(b.label));
    });
  }, [filteredFields, config.selectedFields, t]);

  const handleFieldToggle = useCallback((fieldId: string) => {
    const isSelected = config.selectedFields.includes(fieldId);
    if (isSelected) {
      // Don't allow deselecting the last item - must have at least 1 selection
      if (config.selectedFields.length <= 1) return;
      onFieldsChange(config.selectedFields.filter(f => f !== fieldId));
    } else if (config.selectedFields.length < 4) {
      onFieldsChange([...config.selectedFields, fieldId]);
    }
  }, [config.selectedFields, onFieldsChange]);

  const getFieldUnitForHeader = useCallback((field: TelemetryFieldDef) => {
    const resolved = resolveUnitForField(field, unitPrefs);
    if (resolved === 'imperial' && field.unitImperial) {
      return field.unitImperial;
    }
    return field.unit;
  }, [unitPrefs]);

  const isLight = theme === 'light';

  // Don't render if no fields available
  if (availableFields.length === 0) return null;

  return (
    <div className="flex items-center justify-start mb-1 px-1">
      {/* Multi-Select Dropdown - Left side, bigger with highlighted border */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsDropdownOpen(v => !v)}
          className={`text-[11px] h-6 px-2.5 py-1 flex items-center gap-1.5 rounded-md border-2 transition-colors ${isLight
            ? 'bg-gray-100 border-sky-400 text-gray-700 hover:bg-gray-200 hover:border-sky-500'
            : 'bg-drone-surface border-sky-500/60 text-gray-300 hover:bg-gray-700 hover:border-sky-400'
            }`}
          title={t('telemetry.selectData')}
        >
          <span className="font-medium">{config.selectedFields.length}/4</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {isDropdownOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => { setIsDropdownOpen(false); setSearchQuery(''); }}
            />
            <div
              ref={dropdownRef}
              className={`absolute left-0 top-full mt-1 z-50 w-52 max-h-64 rounded-lg border-2 shadow-xl flex flex-col overflow-hidden ${isLight
                ? 'bg-white border-sky-400'
                : 'bg-drone-surface border-sky-500/60'
                }`}
            >
              {/* Search input */}
              <div className={`px-2 pt-2 pb-1 border-b flex-shrink-0 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setHighlightedIndex(0); }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setHighlightedIndex(prev => prev < sortedFields.length - 1 ? prev + 1 : 0);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setHighlightedIndex(prev => prev > 0 ? prev - 1 : sortedFields.length - 1);
                    } else if (e.key === 'Enter' && sortedFields.length > 0) {
                      e.preventDefault();
                      const field = sortedFields[highlightedIndex];
                      if (field) handleFieldToggle(field.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsDropdownOpen(false);
                      setSearchQuery('');
                    }
                  }}
                  placeholder={t('telemetry.searchFields')}
                  autoFocus
                  className={`w-full text-[11px] rounded px-2 py-1 border focus:outline-none ${isLight
                    ? 'bg-gray-50 text-gray-800 border-gray-300 focus:border-sky-500 placeholder-gray-400'
                    : 'bg-drone-dark text-gray-200 border-gray-600 focus:border-drone-primary placeholder-gray-500'
                    }`}
                />
              </div>

              {/* Field list */}
              <div className="overflow-auto flex-1">
                {sortedFields.length === 0 ? (
                  <p className={`text-[11px] px-3 py-2 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                    {t('telemetry.noMatchingFields')}
                  </p>
                ) : (
                  sortedFields.map((field, index) => {
                    const isSelected = config.selectedFields.includes(field.id);
                    // Disable if: max selections reached (for unselected), or it's the only selection (can't deselect last)
                    const isLastSelected = isSelected && config.selectedFields.length === 1;
                    const isDisabled = isLastSelected || (!isSelected && config.selectedFields.length >= 4);
                    return (
                      <button
                        key={field.id}
                        type="button"
                        onClick={() => !isDisabled && handleFieldToggle(field.id)}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        disabled={isDisabled}
                        className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-2 transition-colors ${isDisabled && isLastSelected
                          ? isLight ? 'bg-sky-100/50 text-sky-600 cursor-not-allowed' : 'bg-sky-500/10 text-sky-300 cursor-not-allowed'
                          : isDisabled
                            ? isLight ? 'text-gray-400 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed'
                            : isSelected
                              ? isLight ? 'bg-sky-100 text-sky-800' : 'bg-sky-500/20 text-sky-200'
                              : index === highlightedIndex
                                ? isLight ? 'bg-gray-100' : 'bg-gray-700/50'
                                : isLight ? 'text-gray-700 hover:bg-gray-50' : 'text-gray-300 hover:bg-gray-700/50'
                          }`}
                        title={isLastSelected ? t('telemetry.cannotDeselect') : undefined}
                      >
                        <span
                          className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected
                            ? 'border-sky-500 bg-sky-500'
                            : isLight ? 'border-gray-400' : 'border-gray-600'
                            }`}
                        >
                          {isSelected && (
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0 cursor-pointer ring-1 ring-transparent hover:ring-gray-400 transition-shadow"
                          style={{ backgroundColor: getFieldColor(field.id) }}
                          title={t('telemetry.changeColor', 'Click to change color, right-click to reset')}
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = (e.target as HTMLElement).getBoundingClientRect();
                            setColorPickerPos({ x: rect.right + 8, y: rect.top });
                            setColorPickerFieldId(field.id);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onFieldColorReset(field.id);
                          }}
                        />
                        <span className="truncate flex-1">{t(field.label)}</span>
                        <span className={`flex-shrink-0 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                          {getFieldUnitForHeader(field)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Color Picker Modal for telemetry field colors */}
      {colorPickerFieldId && (
        <ColorPickerModal
          isOpen={true}
          currentColor={getFieldColor(colorPickerFieldId)}
          onSelect={(color) => {
            onFieldColorChange(colorPickerFieldId, color);
            setColorPickerFieldId(null);
          }}
          onClose={() => setColorPickerFieldId(null)}
          position={colorPickerPos}
        />
      )}
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT TYPES
// ============================================================================

interface TelemetryChartsProps {
  data: TelemetryData;
  unitPrefs: UnitPreferences;
  startTime?: string | null;
}

export function TelemetryCharts({ data, unitPrefs, startTime }: TelemetryChartsProps) {
  const { t } = useTranslation();
  const chartsRef = useRef<ECharts[]>([]);
  const isSyncingRef = useRef(false);
  const themeMode = useFlightStore((state) => state.themeMode);
  const locale = useFlightStore((state) => state.locale);
  const timeFormat = useFlightStore((state) => state.timeFormat);
  const mapSyncEnabled = useFlightStore((state) => state.mapSyncEnabled);
  const setMapSyncEnabled = useFlightStore((state) => state.setMapSyncEnabled);
  const mapReplayProgress = useFlightStore((state) => state.mapReplayProgress);
  const telemetryColors = useFlightStore((state) => state.telemetryColors);
  const setTelemetryColor = useFlightStore((state) => state.setTelemetryColor);
  const resetTelemetryColor = useFlightStore((state) => state.resetTelemetryColor);

  /** Get the effective color for a field (user override or default) */
  const getFieldColor = useCallback((fieldId: string): string => {
    return telemetryColors[fieldId] || getFieldDef(fieldId)?.color || '#888888';
  }, [telemetryColors]);
  const resolvedTheme = useMemo(() => resolveThemeMode(themeMode), [themeMode]);
  const splitLineColor = resolvedTheme === 'light' ? '#e2e8f0' : '#2a2a4e';
  const tooltipFormatter = useMemo(
    () => createTooltipFormatter(startTime ?? null, resolvedTheme, locale, timeFormat !== '24h'),
    [resolvedTheme, startTime, locale, timeFormat]
  );
  const tooltipColors = useMemo(
    () =>
      resolvedTheme === 'light'
        ? {
          background: '#ffffff',
          border: '#e2e8f0',
          text: '#0f172a',
        }
        : {
          background: '#16213e',
          border: '#4a4e69',
          text: '#ffffff',
        },
    [resolvedTheme]
  );

  // Chart configuration state (persisted to localStorage)
  const [chartConfigs, setChartConfigs] = useState<TelemetryChartsConfig>(() => loadChartConfigs());

  // Persist configuration changes
  const updateChartConfig = useCallback((
    chartId: keyof TelemetryChartsConfig,
    updates: Partial<ChartPanelConfig>
  ) => {
    setChartConfigs(prev => {
      const newConfigs = {
        ...prev,
        [chartId]: { ...prev[chartId], ...updates },
      };
      saveChartConfigs(newConfigs);
      return newConfigs;
    });
  }, []);

  // Update module-level base config when theme changes
  useMemo(() => {
    baseChartConfig = createBaseChartConfig(resolvedTheme);
    return resolvedTheme;
  }, [resolvedTheme]);

  const isMobileRuntime = useIsMobileRuntime();
  const dragZoomAllowed = !isMobileRuntime;
  const [dragZoomActive, setDragZoomActive] = useState(false);

  useEffect(() => {
    if (dragZoomAllowed) return;
    setDragZoomActive(false);
    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'dataZoomSelect',
        dataZoomSelectActive: false,
      });
    });
  }, [dragZoomAllowed]);

  const toggleDragZoom = useCallback(() => {
    if (!dragZoomAllowed) return;
    setDragZoomActive((prev) => {
      const next = !prev;
      chartsRef.current.forEach((chart) => {
        chart.dispatchAction({
          type: 'takeGlobalCursor',
          key: 'dataZoomSelect',
          dataZoomSelectActive: next,
        });
      });
      return next;
    });
  }, [dragZoomAllowed]);

  const resetZoom = useCallback(() => {
    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'dataZoom',
        start: 0,
        end: 100,
      });
    });
  }, []);

  const resetSelections = useCallback(() => {
    setChartConfigs({ ...DEFAULT_CHART_CONFIGS });
    saveChartConfigs({ ...DEFAULT_CHART_CONFIGS });
  }, []);

  const syncZoom = useCallback((sourceChart: ECharts) => {
    if (isSyncingRef.current) return;
    const dataZoom = sourceChart.getOption().dataZoom as
      | { start?: number; end?: number; startValue?: number; endValue?: number }[]
      | undefined;
    if (!dataZoom || dataZoom.length === 0) return;

    const { start, end, startValue, endValue } = dataZoom[0] ?? {};

    isSyncingRef.current = true;
    chartsRef.current.forEach((chart) => {
      if (chart === sourceChart) return;
      chart.dispatchAction({
        type: 'dataZoom',
        start,
        end,
        startValue,
        endValue,
      });
    });
    window.setTimeout(() => {
      isSyncingRef.current = false;
    }, 0);
  }, []);

  const registerChart = useCallback(
    (chart: ECharts) => {
      if (chartsRef.current.includes(chart)) return;
      chartsRef.current.push(chart);

      chart.on('dataZoom', () => {
        syncZoom(chart);
      });

      // Keep drag-to-zoom disabled by default; only enable after explicit toggle.
      // A deferred dispatch is required because onChartReady fires synchronously
      // after setOption, before the toolbox dataZoom feature is ready to handle
      // the takeGlobalCursor action.
      if (dragZoomAllowed) {
        requestAnimationFrame(() => {
          chart.dispatchAction({
            type: 'takeGlobalCursor',
            key: 'dataZoomSelect',
            dataZoomSelectActive: dragZoomActive,
          });
        });
      }
    },
    [dragZoomActive, dragZoomAllowed, syncZoom]
  );

  // Show vertical line indicator when map replay progress changes
  useEffect(() => {
    if (!mapSyncEnabled || mapReplayProgress === 0) {
      // Clear axis pointer when not syncing or at start
      chartsRef.current.forEach((chart) => {
        chart.dispatchAction({
          type: 'hideTip',
        });
      });
      return;
    }

    const dataLength = data.time?.length ?? 0;
    if (dataLength === 0) return;

    const dataIndex = Math.round(mapReplayProgress * (dataLength - 1));

    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'showTip',
        seriesIndex: 0,
        dataIndex,
      });
    });
  }, [mapSyncEnabled, mapReplayProgress, data.time]);

  // Memoize chart options to prevent unnecessary re-renders
  // Use dynamic chart creation when custom fields are selected
  const altitudeSpeedOption = useMemo(
    () => {
      const config = chartConfigs.altitudeSpeed;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      // Fallback to original chart when no fields selected
      return createAltitudeSpeedChart(
        data,
        unitPrefs,
        splitLineColor,
        tooltipFormatter,
        tooltipColors,
        t
      );
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.altitudeSpeed, t, telemetryColors]
  );

  const batteryOption = useMemo(
    () => {
      const config = chartConfigs.battery;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createBatteryChart(data, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.battery, t, telemetryColors]
  );

  const cellVoltageOption = useMemo(
    () => {
      const config = chartConfigs.cellVoltage;
      // If user selected custom fields, use dynamic chart
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      // Default: use the special cell voltage chart (shows individual cells)
      return createCellVoltageChart(data, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.cellVoltage, t, telemetryColors]
  );

  const attitudeOption = useMemo(
    () => {
      const config = chartConfigs.attitude;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createAttitudeChart(data, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.attitude, t, telemetryColors]
  );

  const rcSignalOption = useMemo(
    () => {
      const config = chartConfigs.rcSignal;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createRcSignalChart(data, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.rcSignal, t, telemetryColors]
  );

  const gimbalOption = useMemo(
    () => {
      const config = chartConfigs.gimbal;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createGimbalChart(data, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.gimbal, t, telemetryColors]
  );

  const distanceToHomeOption = useMemo(
    () => {
      const config = chartConfigs.distanceToHome;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createDistanceToHomeChart(data, unitPrefs.distance, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.distanceToHome, t, telemetryColors]
  );

  const velocityOption = useMemo(
    () => {
      const config = chartConfigs.velocity;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createVelocityChart(data, unitPrefs.speed, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.velocity, t, telemetryColors]
  );

  const gpsOption = useMemo(
    () => {
      const config = chartConfigs.gps;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return createGpsChart(data, splitLineColor, tooltipFormatter, tooltipColors, t);
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.gps, t, telemetryColors]
  );

  // Battery Capacity chart - only show if data exists
  const batteryCapacityOption = useMemo(
    () => {
      const hasCapData = data.batteryFullCapacity?.some(v => v !== null) || data.batteryRemainedCapacity?.some(v => v !== null);
      if (!hasCapData) return null;
      const config = chartConfigs.batteryCapacity;
      if (config.selectedFields.length > 0) {
        return createDynamicChart(
          config.selectedFields,
          data,
          unitPrefs,
          splitLineColor,
          tooltipFormatter,
          tooltipColors,
          t,
          telemetryColors
        );
      }
      return null;
    },
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitPrefs, chartConfigs.batteryCapacity, t, telemetryColors]
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-start md:justify-end gap-1.5">
        <button
          onClick={() => setMapSyncEnabled(!mapSyncEnabled)}
          className={`text-xs border rounded px-2 py-1 transition-colors ${mapSyncEnabled
            ? 'text-drone-accent border-drone-accent/50 bg-drone-accent/10'
            : 'text-gray-400 hover:text-white border-gray-700'
            }`}
          title={mapSyncEnabled ? 'Disable map sync' : 'Enable map sync'}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          {t('telemetry.mapSync')}
        </button>
        <button
          onClick={toggleDragZoom}
          className={`${dragZoomAllowed ? 'inline-block' : 'hidden'} text-xs border rounded px-2 py-1 transition-colors ${dragZoomActive
            ? 'text-drone-primary border-drone-primary/50 bg-drone-primary/10'
            : 'text-gray-400 hover:text-white border-gray-700'
            }`}
          title={dragZoomActive ? 'Disable drag to zoom' : 'Enable drag to zoom'}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 1024 1024" fill="currentColor">
            <path d="M1005.3 967.5L755.8 718.1c63.2-74.5 101.5-171 101.5-276.4C857.3 198 665.3 6 429.6 6S2 198 2 441.7s192 435.7 427.7 435.7c105.4 0 201.9-38.3 276.4-101.5l249.4 249.4c10.4 10.4 27.3 10.4 37.8 0l12-12c10.4-10.5 10.4-27.3 0-37.8zM429.6 810.4c-203.4 0-368.7-165.3-368.7-368.7s165.3-368.7 368.7-368.7 368.7 165.3 368.7 368.7-165.3 368.7-368.7 368.7z" />
          </svg>
          {t('telemetry.dragZoom')}
        </button>
        <button
          onClick={resetZoom}
          className="hidden md:inline-block text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1"
          title="Reset zoom on all charts"
        >
          {t('telemetry.resetZoom')}
        </button>
        <button
          onClick={resetSelections}
          className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1"
          title="Reset all chart selections to default"
        >
          {t('telemetry.resetSelection')}
        </button>
      </div>

      {/* Altitude & Speed Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.altitudeSpeed}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('altitudeSpeed', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-64 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={altitudeSpeedOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Battery Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.battery}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('battery', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-60 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={batteryOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Cell Voltage Chart - only shown if cell voltage data exists */}
      {cellVoltageOption && (
        <div>
          <ChartHeader
            config={chartConfigs.cellVoltage}
            availableFields={TELEMETRY_FIELDS}
            onFieldsChange={(fields) => updateChartConfig('cellVoltage', { selectedFields: fields })}
            unitPrefs={unitPrefs}
            theme={resolvedTheme}
            getFieldColor={getFieldColor}
            onFieldColorChange={setTelemetryColor}
            onFieldColorReset={resetTelemetryColor}
          />
          <div className={`h-52 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
            <ReactECharts
              option={cellVoltageOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge={true}
              onChartReady={registerChart}
            />
          </div>
        </div>
      )}

      {/* Battery Capacity Chart - only shown if capacity data exists */}
      {batteryCapacityOption && (
        <div>
          <ChartHeader
            config={chartConfigs.batteryCapacity}
            availableFields={TELEMETRY_FIELDS}
            onFieldsChange={(fields) => updateChartConfig('batteryCapacity', { selectedFields: fields })}
            unitPrefs={unitPrefs}
            theme={resolvedTheme}
            getFieldColor={getFieldColor}
            onFieldColorChange={setTelemetryColor}
            onFieldColorReset={resetTelemetryColor}
          />
          <div className={`h-52 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
            <ReactECharts
              option={batteryCapacityOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge={true}
              onChartReady={registerChart}
            />
          </div>
        </div>
      )}

      {/* Attitude Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.attitude}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('attitude', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-64 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={attitudeOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Gimbal Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.gimbal}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('gimbal', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-64 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={gimbalOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* RC Signal Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.rcSignal}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('rcSignal', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-40 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={rcSignalOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Distance to Home Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.distanceToHome}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('distanceToHome', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-52 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={distanceToHomeOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* Velocity Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.velocity}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('velocity', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-52 ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={velocityOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>

      {/* GPS Satellites Chart */}
      <div>
        <ChartHeader
          config={chartConfigs.gps}
          availableFields={TELEMETRY_FIELDS}
          onFieldsChange={(fields) => updateChartConfig('gps', { selectedFields: fields })}
          unitPrefs={unitPrefs}
          theme={resolvedTheme}
          getFieldColor={getFieldColor}
          onFieldColorChange={setTelemetryColor}
          onFieldColorReset={resetTelemetryColor}
        />
        <div className={`h-[207px] ${mapSyncEnabled ? 'pointer-events-none' : ''}`}>
          <ReactECharts
            option={gpsOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      </div>
    </div>
  );
}

/** Shared chart configuration - theme-aware */
function createBaseChartConfig(theme: 'dark' | 'light'): Partial<EChartsOption> {
  const isLight = theme === 'light';
  const axisColor = isLight ? '#cbd5e1' : '#4a4e69';
  const labelColor = isLight ? '#64748b' : '#9ca3af';
  const zoomBg = isLight ? '#f1f5f9' : '#16213e';
  const zoomBorder = isLight ? '#cbd5e1' : '#2a2a4e';
  const zoomFiller = isLight ? 'rgba(0, 122, 204, 0.15)' : 'rgba(0, 160, 220, 0.2)';
  const handleColor = isLight ? '#007acc' : '#00A0DC';

  return {
    animation: false,
    toolbox: {
      show: true,
      feature: {
        dataZoom: {
          yAxisIndex: 'none',
          title: { zoom: '', back: '' },
          iconStyle: { opacity: 0 },
          emphasis: { iconStyle: { opacity: 0 } },
        },
      },
      right: -999,
      top: -999,
      itemSize: 0,
    },
    grid: {
      left: 40,
      right: 40,
      top: 30,
      bottom: 50,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      renderMode: 'html',
      confine: true,
      backgroundColor: isLight ? '#ffffff' : '#16213e',
      borderColor: isLight ? '#e2e8f0' : '#4a4e69',
      textStyle: {
        color: isLight ? '#0f172a' : '#fff',
      },
      axisPointer: {
        type: 'line',
        axis: 'x',
        lineStyle: {
          color: axisColor,
        },
      },
    },
    legend: {
      textStyle: {
        color: labelColor,
      },
      top: 0,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: axisColor,
        },
      },
      axisLabel: {
        color: labelColor,
        formatter: (value: string) => {
          const secs = parseFloat(value);
          const mins = Math.floor(secs / 60);
          const remainingSecs = Math.floor(secs % 60);
          return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
        },
      },
      splitLine: {
        show: false,
      },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'filter',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: false,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        height: 18,
        bottom: 12,
        brushSelect: false,
        borderColor: zoomBorder,
        backgroundColor: zoomBg,
        fillerColor: zoomFiller,
        handleStyle: {
          color: handleColor,
        },
        textStyle: {
          color: labelColor,
        },
        dataBackground: {
          lineStyle: { color: isLight ? '#94a3b8' : '#4a4e69' },
          areaStyle: { color: isLight ? '#cbd5e1' : '#2a2a4e' },
        },
        selectedDataBackground: {
          lineStyle: { color: handleColor },
          areaStyle: { color: isLight ? 'rgba(0, 122, 204, 0.1)' : 'rgba(0, 160, 220, 0.15)' },
        },
      },
    ],
  };
}

// Module-level cache for current base config (set by TelemetryCharts component)
let baseChartConfig: Partial<EChartsOption> = createBaseChartConfig('dark');

function createAltitudeSpeedChart(
  data: TelemetryData,
  unitPrefs: UnitPreferences,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const hasHeight = data.height.some((val) => val !== null);
  const fallbackHeight = data.altitude ?? [];
  const heightSource = hasHeight ? data.height : fallbackHeight;
  const heightSeries =
    unitPrefs.altitude === 'imperial'
      ? heightSource.map((val) => (val === null ? null : val * 3.28084))
      : heightSource;
  const vpsHeightSeries =
    unitPrefs.altitude === 'imperial'
      ? data.vpsHeight.map((val) => (val === null ? null : val * 3.28084))
      : data.vpsHeight;
  const speedSeries =
    data.speed.map((val) => (val === null ? null : val * speedMultiplierFromMs(unitPrefs.speed)));
  const heightRange = computeRange([
    ...heightSeries,
    ...vpsHeightSeries,
  ]);
  const speedRange = computeRange(speedSeries);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.height'), t('telemetry.vpsHeight'), t('telemetry.speed')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: [
      {
        type: 'value',
        name: unitPrefs.altitude === 'imperial' ? t('telemetry.heightFt') : t('telemetry.heightM'),
        min: heightRange.min,
        max: heightRange.max,
        nameTextStyle: {
          color: '#00A0DC',
        },
        axisLine: {
          lineStyle: {
            color: '#00A0DC',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          lineStyle: {
            color: splitLineColor,
          },
        },
      },
      {
        type: 'value',
        name: (() => {
          if (unitPrefs.speed === 'mph') return t('telemetry.speedMph');
          if (unitPrefs.speed === 'kmh') return t('telemetry.speedKmh');
          if (unitPrefs.speed === 'fts') return 'Speed (ft/s)';
          return 'Speed (m/s)';
        })(),
        min: speedRange.min,
        max: speedRange.max,
        nameTextStyle: {
          color: '#00D4AA',
        },
        axisLine: {
          lineStyle: {
            color: '#00D4AA',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          show: false,
        },
      },
    ],
    series: [
      {
        name: t('telemetry.height'),
        type: 'line',
        data: bridgeShortNullGaps(heightSeries, data.time),
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#00A0DC',
        },
        lineStyle: {
          color: '#00A0DC',
          width: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(0, 160, 220, 0.3)' },
              { offset: 1, color: 'rgba(0, 160, 220, 0.05)' },
            ],
          },
        },
      },
      {
        name: t('telemetry.vpsHeight'),
        type: 'line',
        data: bridgeShortNullGaps(vpsHeightSeries, data.time),
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f97316',
        },
        lineStyle: {
          color: '#f97316',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.speed'),
        type: 'line',
        data: bridgeShortNullGaps(speedSeries, data.time),
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#00D4AA',
        },
        lineStyle: {
          color: '#00D4AA',
          width: 2,
        },
      },
    ],
  };
}

function createBatteryChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const batteryRange = computeRange(data.battery, { clampMin: 0, clampMax: 100 });
  const voltageRange = computeRange(data.batteryVoltage);
  const batteryTempSeries = (data.batteryTemp ?? []).map((value) => {
    if (value === null || value === undefined || Math.abs(value) < 1e-6) return null;
    return value;
  });
  const tempRange = computeRange(batteryTempSeries);
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.batteryPercent'), t('telemetry.voltage'), t('telemetry.temperature')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: [
      {
        type: 'value',
        name: t('telemetry.batteryPercentAxis'),
        min: batteryRange.min,
        max: batteryRange.max,
        axisLine: {
          lineStyle: {
            color: '#f59e0b',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          lineStyle: {
            color: splitLineColor,
          },
        },
      },
      {
        type: 'value',
        name: t('telemetry.tempC'),
        position: 'right',
        min: tempRange.min,
        max: tempRange.max,
        axisLine: {
          lineStyle: {
            color: '#a855f7',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          show: false,
        },
      },
      {
        type: 'value',
        position: 'right',
        offset: 44,
        min: voltageRange.min,
        max: voltageRange.max,
        axisLabel: {
          show: false,
        },
        axisLine: {
          show: false,
        },
        axisTick: {
          show: false,
        },
        splitLine: {
          show: false,
        },
      },
    ],
    series: [
      {
        name: t('telemetry.batteryPercent'),
        type: 'line',
        data: bridgeShortNullGaps(data.battery, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f59e0b',
        },
        lineStyle: {
          color: '#f59e0b',
          width: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(245, 158, 11, 0.3)' },
              { offset: 1, color: 'rgba(245, 158, 11, 0.05)' },
            ],
          },
        },
        markArea: {
          silent: true,
          itemStyle: {
            color: 'rgba(239, 68, 68, 0.18)',
          },
          data: [[{ yAxis: 0 }, { yAxis: 20 }]],
        },
      },
      {
        name: t('telemetry.voltage'),
        type: 'line',
        data: bridgeShortNullGaps(data.batteryVoltage, data.time),
        yAxisIndex: 2,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#38bdf8',
        },
        lineStyle: {
          color: '#38bdf8',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.temperature'),
        type: 'line',
        data: bridgeShortNullGaps(batteryTempSeries, data.time),
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#a855f7',
        },
        lineStyle: {
          color: '#a855f7',
          width: 1.5,
        },
      },
    ],
  };
}

// Colors for cell voltage series (up to 12 cells)
const cellVoltageColors = [
  '#10b981', // emerald-500
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
  '#6366f1', // indigo-500
  '#84cc16', // lime-500
  '#06b6d4', // cyan-500
  '#a855f7', // purple-500
];

function createCellVoltageChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption | null {
  // Determine the number of cells from the first non-null entry
  const cellVoltages = data.cellVoltages;
  if (!cellVoltages || cellVoltages.length === 0) {
    return null;
  }

  // Find first non-null entry to determine cell count
  const firstValidEntry = cellVoltages.find((v) => v !== null && v !== undefined);
  if (!firstValidEntry) {
    return null;
  }

  const numCells = firstValidEntry.length;
  if (numCells === 0) {
    return null;
  }

  // Extract individual cell series
  // Treat 0 values as missing (0.0 indicates unparsed/unavailable data)
  const cellSeries: (number | null)[][] = Array.from({ length: numCells }, () => []);
  for (const voltages of cellVoltages) {
    for (let i = 0; i < numCells; i++) {
      if (voltages && voltages[i] !== undefined && voltages[i] !== null && voltages[i] !== 0) {
        cellSeries[i].push(voltages[i]);
      } else {
        cellSeries[i].push(null);
      }
    }
  }

  // Compute range across all cells (excluding nulls which already excludes zeros)
  const allVoltages = cellSeries.flat().filter((v): v is number => v !== null);
  const voltageRange = computeRange(allVoltages, { paddingRatio: 0.05 });

  const legendData = Array.from({ length: numCells }, (_, i) => t('telemetry.cell', { n: i + 1 }));

  const series: LineSeriesOption[] = cellSeries.map((values, i) => ({
    name: t('telemetry.cell', { n: i + 1 }),
    type: 'line',
    data: bridgeShortNullGaps(values, data.time),
    smooth: true,
    symbol: 'none',
    itemStyle: {
      color: cellVoltageColors[i % cellVoltageColors.length],
    },
    lineStyle: {
      color: cellVoltageColors[i % cellVoltageColors.length],
      width: 1.5,
    },
  }));

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: legendData,
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: t('telemetry.cellVoltageV'),
      min: voltageRange.min,
      max: voltageRange.max,
      axisLine: {
        lineStyle: {
          color: '#10b981',
        },
      },
      axisLabel: {
        color: '#9ca3af',
        formatter: '{value}',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series,
  };
}

function createAttitudeChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const attitudeRange = computeRange([
    ...data.pitch,
    ...data.roll,
    ...data.yaw,
  ]);
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.pitch'), t('telemetry.roll'), t('telemetry.yaw')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: t('telemetry.rotations'),
      nameTextStyle: {
        color: '#8b5cf6',
      },
      min: attitudeRange.min,
      max: attitudeRange.max,
      axisLine: {
        lineStyle: {
          color: '#8b5cf6',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: t('telemetry.pitch'),
        type: 'line',
        data: bridgeShortNullGaps(data.pitch, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#8b5cf6',
        },
        lineStyle: {
          color: '#8b5cf6',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.roll'),
        type: 'line',
        data: bridgeShortNullGaps(data.roll, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#ec4899',
        },
        lineStyle: {
          color: '#ec4899',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.yaw'),
        type: 'line',
        data: bridgeShortNullGaps(data.yaw, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#14b8a6',
        },
        lineStyle: {
          color: '#14b8a6',
          width: 1.5,
        },
      },
    ],
  };
}

function createGimbalChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const gimbalPitch = data.gimbalPitch ?? [];
  const gimbalRoll = data.gimbalRoll ?? [];
  const gimbalYaw = data.gimbalYaw ?? [];
  const gimbalRange = computeRange([
    ...gimbalPitch,
    ...gimbalRoll,
    ...gimbalYaw,
  ]);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.gimbalPitch'), t('telemetry.gimbalRoll'), t('telemetry.gimbalYaw')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: t('telemetry.gimbalRotations'),
      nameTextStyle: {
        color: '#f97316',
      },
      min: gimbalRange.min,
      max: gimbalRange.max,
      axisLine: {
        lineStyle: {
          color: '#f97316',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: t('telemetry.gimbalPitch'),
        type: 'line',
        data: bridgeShortNullGaps(gimbalPitch, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f97316',
        },
        lineStyle: {
          color: '#f97316',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.gimbalRoll'),
        type: 'line',
        data: bridgeShortNullGaps(gimbalRoll, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#10b981',
        },
        lineStyle: {
          color: '#10b981',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.gimbalYaw'),
        type: 'line',
        data: bridgeShortNullGaps(gimbalYaw, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#06b6d4',
        },
        lineStyle: {
          color: '#06b6d4',
          width: 1.5,
        },
      },
    ],
  };
}

function createRcSignalChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const sanitizeRcSeries = (series?: (number | null)[]): (number | null)[] =>
    (series ?? []).map((val) => (val === 0 ? null : val));

  const rcSignal = sanitizeRcSeries(data.rcSignal);
  const rcUplink = sanitizeRcSeries(data.rcUplink);
  const rcDownlink = sanitizeRcSeries(data.rcDownlink);
  const hasUplink = rcUplink.some((val) => val !== null && val !== undefined);
  const hasDownlink = rcDownlink.some((val) => val !== null && val !== undefined);
  const showCombined = !hasUplink && !hasDownlink;
  const series: LineSeriesOption[] = [
    ...(showCombined
      ? [
        {
          name: t('telemetry.rcSignal'),
          type: 'line' as const,
          data: bridgeShortNullGaps(rcSignal, data.time),
          smooth: true,
          connectNulls: false,
          symbol: 'none',
          itemStyle: {
            color: '#22c55e',
          },
          lineStyle: {
            color: '#22c55e',
            width: 1.5,
          },
        },
      ]
      : [
        {
          name: t('telemetry.rcUplink'),
          type: 'line' as const,
          data: bridgeShortNullGaps(rcUplink, data.time),
          smooth: true,
          connectNulls: false,
          symbol: 'none',
          itemStyle: {
            color: '#22c55e',
          },
          lineStyle: {
            color: '#22c55e',
            width: 1.5,
          },
        },
        {
          name: t('telemetry.rcDownlink'),
          type: 'line' as const,
          data: bridgeShortNullGaps(rcDownlink, data.time),
          smooth: true,
          connectNulls: false,
          symbol: 'none',
          itemStyle: {
            color: '#38bdf8',
          },
          lineStyle: {
            color: '#38bdf8',
            width: 1.5,
          },
        },
      ]),
  ];
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: showCombined ? [t('telemetry.rcSignal')] : [t('telemetry.rcUplink'), t('telemetry.rcDownlink')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: t('telemetry.rcSignalAxis'),
      min: 0,
      max: 100,
      interval: 50,
      axisLine: {
        lineStyle: {
          color: '#22c55e',
        },
      },
      axisLabel: {
        color: '#9ca3af',
        formatter: (value: number) => (value % 50 === 0 ? String(value) : ''),
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series,
  };
}

function createDistanceToHomeChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const distances = computeDistanceToHomeSeries(data);
  const distanceSeries =
    unitSystem === 'imperial'
      ? distances.map((val) => (val === null ? null : val * 3.28084))
      : distances;
  const distanceRange = computeRange(distanceSeries, { clampMin: 0 });

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.distToHome')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: unitSystem === 'imperial' ? t('telemetry.distanceFt') : t('telemetry.distanceM'),
      min: distanceRange.min,
      max: distanceRange.max,
      axisLine: {
        lineStyle: {
          color: '#22c55e',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: t('telemetry.distToHome'),
        type: 'line',
        data: bridgeShortNullGaps(distanceSeries, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#22c55e',
        },
        lineStyle: {
          color: '#22c55e',
          width: 1.5,
        },
      },
    ],
  };
}

function createVelocityChart(
  data: TelemetryData,
  unitSystem: SpeedUnit,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const velocityX = data.velocityX ?? [];
  const velocityY = data.velocityY ?? [];
  const velocityZ = data.velocityZ ?? [];
  const speedSeriesFactor = speedMultiplierFromMs(unitSystem);
  const xSeries = velocityX.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const ySeries = velocityY.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const zSeries = velocityZ.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const speedRange = computeRange([...xSeries, ...ySeries, ...zSeries]);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.xSpeed'), t('telemetry.ySpeed'), t('telemetry.zSpeed')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: unitSystem === 'mph'
        ? t('telemetry.speedMph')
        : unitSystem === 'kmh'
          ? t('telemetry.speedKmh')
          : unitSystem === 'fts'
            ? 'Speed (ft/s)'
            : 'Speed (m/s)',
      min: speedRange.min,
      max: speedRange.max,
      axisLine: {
        lineStyle: {
          color: '#f59e0b',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: t('telemetry.xSpeed'),
        type: 'line',
        data: bridgeShortNullGaps(xSeries, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f59e0b',
        },
        lineStyle: {
          color: '#f59e0b',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.ySpeed'),
        type: 'line',
        data: bridgeShortNullGaps(ySeries, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#ec4899',
        },
        lineStyle: {
          color: '#ec4899',
          width: 1.5,
        },
      },
      {
        name: t('telemetry.zSpeed'),
        type: 'line',
        data: bridgeShortNullGaps(zSeries, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#38bdf8',
        },
        lineStyle: {
          color: '#38bdf8',
          width: 1.5,
        },
      },
    ],
  };
}

function computeDistanceToHomeSeries(data: TelemetryData): Array<number | null> {
  const lats = data.latitude ?? [];
  const lngs = data.longitude ?? [];
  let homeLat: number | null = null;
  let homeLng: number | null = null;
  for (let i = 0; i < lats.length; i += 1) {
    const lat = lats[i];
    const lng = lngs[i];
    if (typeof lat === 'number' && typeof lng === 'number') {
      homeLat = lat;
      homeLng = lng;
      break;
    }
  }
  if (homeLat === null || homeLng === null) {
    return data.time.map(() => null);
  }

  return data.time.map((_, index) => {
    const lat = lats[index];
    const lng = lngs[index];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return haversineDistance(homeLat, homeLng, lat, lng);
  });
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function createGpsChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors,
  t: TFn
): EChartsOption {
  const gpsRange = computeRange(data.satellites, { clampMin: 0 });
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: [t('telemetry.gpsSatellites')],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: t('telemetry.satellitesAxis'),
      min: gpsRange.min,
      max: gpsRange.max,
      axisLine: {
        lineStyle: {
          color: '#0ea5e9',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: t('telemetry.gpsSatellites'),
        type: 'line',
        data: bridgeShortNullGaps(data.satellites, data.time),
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#0ea5e9',
        },
        lineStyle: {
          color: '#0ea5e9',
          width: 1.5,
        },
      },
    ],
  };
}

function computeRange(
  values: Array<number | null | undefined>,
  options: { clampMin?: number; clampMax?: number; paddingRatio?: number } = {}
): { min?: number; max?: number } {
  const cleaned = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  if (cleaned.length === 0) return {};

  // Use iterative min/max to avoid "Maximum call stack size exceeded"
  // when spreading large telemetry arrays into Math.min/max arguments.
  let min = cleaned[0];
  let max = cleaned[0];
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i] < min) min = cleaned[i];
    if (cleaned[i] > max) max = cleaned[i];
  }
  if (min === max) {
    const delta = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= delta;
    max += delta;
  }

  const paddingRatio = options.paddingRatio ?? 0.08;
  const padding = (max - min) * paddingRatio;
  min -= padding;
  max += padding;

  if (typeof options.clampMin === 'number') {
    min = Math.max(min, options.clampMin);
  }
  if (typeof options.clampMax === 'number') {
    max = Math.min(max, options.clampMax);
  }

  min = roundAxisValue(min);
  max = roundAxisValue(max);

  if (min === max) {
    const bump = min === 0 ? 1 : Math.abs(min) * 0.1;
    min = roundAxisValue(min - bump);
    max = roundAxisValue(max + bump);
  }

  return { min, max };
}

function roundAxisValue(value: number): number {
  if (Math.abs(value) < 0.0001) return 0;
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(value.toFixed(decimals));
}

function resolveThemeMode(mode: 'system' | 'dark' | 'light'): 'dark' | 'light' {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

type TooltipFormatter = (params: any) => string;
type TooltipColors = {
  background: string;
  border: string;
  text: string;
};

function createTooltipFormatter(
  startTime: string | null,
  theme: 'light' | 'dark',
  locale?: string,
  hour12?: boolean
): TooltipFormatter {
  return (params) => {
    const items = Array.isArray(params) ? params : [params];
    const axisValue = items[0]?.axisValue ?? '';
    const seconds =
      typeof axisValue === 'number'
        ? axisValue
        : Number.parseFloat(String(axisValue));
    const header = formatTooltipHeader(startTime, seconds, theme, locale, hour12);

    const lines = items.map((item) => {
      const marker = typeof item.marker === 'string' ? item.marker : '';
      const label = item.seriesName ?? '';
      const rawValue =
        Array.isArray(item.value) && item.value.length > 0
          ? item.value[item.value.length - 1]
          : item.value ?? item.data;
      const value =
        typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? formatNumericValue(rawValue)
          : rawValue ?? '-';
      return `${marker} ${label}: ${value}`;
    });

    return [header, ...lines].join('<br/>');
  };
}

function formatTooltipHeader(
  startTime: string | null,
  seconds: number,
  theme: 'light' | 'dark',
  locale?: string,
  hour12 = true,
): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const durationLabel = formatDurationLabel(safeSeconds);
  if (!startTime) {
    return durationLabel;
  }
  const startDate = new Date(startTime);
  const timestamp = new Date(startDate.getTime() + safeSeconds * 1000);
  const timeLabel = ensureAmPmUpperCase(new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  }).format(timestamp));
  const durationBg = theme === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(0,212,170,0.2)';
  const timeBg = theme === 'light' ? 'rgba(2, 132, 199, 0.12)' : 'rgba(0,160,220,0.22)';
  const textColor = theme === 'light' ? '#0f172a' : '#e2e8f0';
  return `<div style="margin-bottom:0px;display:flex;gap:6px;align-items:center;">
    <span class="tooltip-duration-tag" style="display:inline-block;padding:2px 8px;border-radius:999px;background:${durationBg};color:${textColor};font-size:11px;line-height:1.2;">${durationLabel}</span>
    <span class="tooltip-time-tag" style="display:inline-block;padding:2px 8px;border-radius:999px;background:${timeBg};color:${textColor};font-size:11px;line-height:1.2;">${timeLabel}</span>
  </div>`;
}

function formatDurationLabel(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(remaining).padStart(2, '0');
  return `${mm}m ${ss}s`;
}

function formatNumericValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.00$/, '');
}

function createTimeAxis(time: number[]): EChartsOption['xAxis'] {
  const values = time.map((t) => t.toFixed(1));
  return {
    type: 'category',
    boundaryGap: false,
    data: values,
    axisLine: {
      lineStyle: {
        color: '#4a4e69',
      },
    },
    axisTick: {
      alignWithLabel: true,
    } as any,
    axisLabel: {
      color: '#9ca3af',
      showMinLabel: false,
      showMaxLabel: false,
      hideOverlap: true,
      rotate: 30,
      interval: (index: number) => {
        if (index === 0) return true;
        const current = time[index];
        const previous = time[index - 1];
        if (!Number.isFinite(current) || !Number.isFinite(previous)) return false;
        return Math.floor(previous / 60) !== Math.floor(current / 60);
      },
      formatter: (value: string) => {
        return formatTimeLabel(value);
      },
    },
    splitLine: {
      show: false,
    },
  };
}

function formatTimeLabel(value: string): string {
  const secs = Number.parseFloat(value);
  if (!Number.isFinite(secs)) return '';
  const rounded = Math.round(secs);
  const mins = Math.floor(rounded / 60);
  const remainingSecs = Math.floor(rounded % 60);
  return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
}
