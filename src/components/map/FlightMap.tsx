/**
 * Flight map component using react-map-gl with MapLibre
 * Displays the GPS track of the selected flight
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { NavigationControl, AttributionControl, Marker, Source, Layer, useControl } from 'react-map-gl/maplibre';
import type { MapRef } from 'react-map-gl/maplibre';
import { PathLayer, ScatterplotLayer, TextLayer, IconLayer } from '@deck.gl/layers';
import { MapLibreOverlay } from '@deck.gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getTrackCenter, calculateBounds, formatAltitude, formatSpeed, formatDistance } from '@/lib/utils';
import { getFlightData } from '@/lib/api';
import { getMediaPoints, type MediaPoint } from '@/lib/mediaMarkers';
import { useFlightStore } from '@/stores/flightStore';
import { Select } from '@/components/ui/Select';
import type { TelemetryData, FlightMessage } from '@/types';
import { useTranslation } from 'react-i18next';
import { type MapType, MAP_TYPE_OPTIONS, getMapStyle } from '@/lib/mapStyles';

interface FlightMapProps {
  flightId: number;
  track: [number, number, number][]; // [lng, lat, alt][]
  homeLat?: number | null;
  homeLon?: number | null;
  durationSecs?: number | null;
  telemetry?: TelemetryData;
  themeMode: 'system' | 'dark' | 'light';
  messages?: FlightMessage[];
}

type ColorByMode =
  | 'progress'
  | 'height'
  | 'speed'
  | 'distance'
  | 'videoSegment'
  | 'batteryPercent'
  | 'rcSignal'
  | 'satelliteCount';

const TERRAIN_SOURCE_ID = 'terrain-dem';
const TERRAIN_SOURCE = {
  type: 'raster-dem',
  url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
  tileSize: 256,
  maxzoom: 12,
} as const;

const getSessionBool = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') return fallback;
  const stored = window.sessionStorage.getItem(key);
  if (stored === null) return fallback;
  return stored === 'true';
};

// ─── Catmull-Rom spline smoothing ───────────────────────────────────────────
// Interpolates between GPS points to produce a smooth, natural curve.
// `resolution` controls how many sub-points to insert between each pair (higher = smoother).
function smoothTrack(
  points: [number, number, number][],
  resolution = 4
): [number, number, number][] {
  if (points.length < 3) return points;

  const result: [number, number, number][] = [];
  const n = points.length;

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, n - 1)];

    for (let step = 0; step < resolution; step++) {
      const t = step / resolution;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom coefficients
      const lng =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const lat =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      const alt =
        0.5 *
        (2 * p1[2] +
          (-p0[2] + p2[2]) * t +
          (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 +
          (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3);

      result.push([lng, lat, alt]);
    }
  }

  // Always include the final point
  result.push(points[n - 1]);
  return result;
}

/**
 * Simple moving-average smoother for mobile.
 * Averages a window of `radius*2+1` points — no overshoot, just noise reduction.
 */
function movingAverageSmooth(
  points: [number, number, number][],
  radius = 3
): [number, number, number][] {
  if (points.length < 3) return points;
  const n = points.length;
  const result: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    let sumLng = 0, sumLat = 0, sumAlt = 0, count = 0;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    for (let j = lo; j <= hi; j++) {
      sumLng += points[j][0];
      sumLat += points[j][1];
      sumAlt += points[j][2];
      count++;
    }
    result.push([sumLng / count, sumLat / count, sumAlt / count]);
  }
  return result;
}

/**
 * Downsample a path to at most `maxPts` points using uniform stride.
 * Always keeps the first and last point.
 */
function downsample(
  points: [number, number, number][],
  maxPts: number
): [number, number, number][] {
  if (points.length <= maxPts) return points;
  const result: [number, number, number][] = [points[0]];
  const stride = (points.length - 1) / (maxPts - 1);
  for (let i = 1; i < maxPts - 1; i++) {
    result.push(points[Math.round(i * stride)]);
  }
  result.push(points[points.length - 1]);
  return result;
}

// ─── Haversine distance in meters ───────────────────────────────────────────
function haversineM(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Color ramps ────────────────────────────────────────────────────────────
// Maps a normalized value 0→1 to a color via multi-stop gradient.
function valueToColor(
  t: number,
  ramp: [number, number, number][]
): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const maxIdx = ramp.length - 1;
  const scaled = clamped * maxIdx;
  const lo = Math.floor(scaled);
  const hi = Math.min(lo + 1, maxIdx);
  const f = scaled - lo;
  return [
    Math.round(ramp[lo][0] + (ramp[hi][0] - ramp[lo][0]) * f),
    Math.round(ramp[lo][1] + (ramp[hi][1] - ramp[lo][1]) * f),
    Math.round(ramp[lo][2] + (ramp[hi][2] - ramp[lo][2]) * f),
  ];
}

// Yellow → Red  (start→end progress)
const RAMP_PROGRESS: [number, number, number][] = [
  [250, 204, 21],
  [239, 68, 68],
];
// Green → Yellow → Red  (low→high value)
const RAMP_HEIGHT: [number, number, number][] = [
  [34, 197, 94],
  [250, 204, 21],
  [239, 68, 68],
];
// Blue → Cyan → Green → Yellow → Red  (speed)
const RAMP_SPEED: [number, number, number][] = [
  [59, 130, 246],
  [34, 211, 238],
  [34, 197, 94],
  [250, 204, 21],
  [239, 68, 68],
];
// Green → Yellow → Orange → Red  (distance from home)
const RAMP_DISTANCE: [number, number, number][] = [
  [34, 197, 94],
  [250, 204, 21],
  [251, 146, 60],
  [239, 68, 68],
];
// Red → Yellow → Green (signal/quality metrics)
const RAMP_QUALITY: [number, number, number][] = [
  [239, 68, 68],
  [250, 204, 21],
  [34, 197, 94],
];

// Blue for normal flight, Red for video recording segments
const COLOR_VIDEO_NORMAL: [number, number, number] = [59, 130, 246]; // Blue
const COLOR_VIDEO_RECORDING: [number, number, number] = [239, 68, 68]; // Red

const COLOR_BY_OPTIONS: { value: ColorByMode; labelKey: string }[] = [
  { value: 'progress', labelKey: 'map.startToEnd' },
  { value: 'height', labelKey: 'map.height' },
  { value: 'speed', labelKey: 'map.speed' },
  { value: 'distance', labelKey: 'map.distFromHome' },
  { value: 'batteryPercent', labelKey: 'map.batteryPercent' },
  { value: 'rcSignal', labelKey: 'map.rcSignal' },
  { value: 'satelliteCount', labelKey: 'map.satelliteCount' },
  { value: 'videoSegment', labelKey: 'map.videoSegment' },
];

// ─── Arrow icon for replay marker ───────────────────────────────────────────
// Pre-render the arrow onto a canvas so the IconLayer has a synchronous atlas.
// This avoids async image-loading issues when deck.gl runs inside MapLibreOverlay
// (MapLibre never gets a repaint request after a data-URL finishes loading).
const ARROW_ATLAS_SIZE = 64;
const arrowAtlasCanvas: HTMLCanvasElement | null = (() => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ARROW_ATLAS_SIZE;
  canvas.height = ARROW_ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Scale the original 32×32 path up to 64×64 for crispness
  const s = ARROW_ATLAS_SIZE / 32;
  ctx.save();
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(16, 2);
  ctx.lineTo(26, 28);
  ctx.lineTo(16, 22);
  ctx.lineTo(6, 28);
  ctx.closePath();
  ctx.fillStyle = '#00d4aa';
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
  return canvas;
})();

const ARROW_ICON_MAPPING: Record<string, { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number }> = {
  arrow: { x: 0, y: 0, width: ARROW_ATLAS_SIZE, height: ARROW_ATLAS_SIZE, anchorX: ARROW_ATLAS_SIZE / 2, anchorY: ARROW_ATLAS_SIZE / 2 },
};

/**
 * Synchronizes deck.gl layers with MapLibre using its supported overlay integration.
 *
 * Uses interleaved: false (default) so deck.gl renders all layers as an overlay
 * on top of the MapLibre scene. This prevents path segments from clipping against
 * terrain and keeps media markers above map elements.
 */
function DeckGLOverlay(props: {
  layers: any[];
  pickingRadius?: number;
  overlayRef?: React.MutableRefObject<MapLibreOverlay | null>;
}) {
  const { overlayRef, ...overlayProps } = props;
  const overlay = useControl(() => new MapLibreOverlay(overlayProps));
  overlay.setProps(overlayProps);
  // Expose overlay instance for external picking / snapshot use
  if (overlayRef) overlayRef.current = overlay;
  return null;
}

/* ─── Directional arrow stick widget ────────────────────────────── */

interface RCStickPadProps {
  /** Horizontal axis value, -100 (left) to +100 (right) */
  x: number;
  /** Vertical axis value, -100 (down) to +100 (up) */
  y: number;
  /** Label shown inside the pad */
  label: string;
  /** Position of the label: bottom-left or bottom-right */
  labelPosition: 'bl' | 'br';
  /** Tailwind color class for the dot (bg-*) */
  dotColor: string;
  /** Tailwind shadow glow class */
  dotGlow: string;
}

/**
 * Renders a joystick-style pad: a rounded square with crosshair lines
 * and a coloured dot whose position reflects the stick deflection.
 */
function RCStickPad({ x, y, label, labelPosition, dotColor, dotGlow }: RCStickPadProps) {
  // Clamp to -100..+100 range
  const cx = Math.min(100, Math.max(-100, x));
  const cy = Math.min(100, Math.max(-100, y));

  const labelPosClass = labelPosition === 'bl'
    ? 'bottom-0.5 left-1'
    : 'bottom-0.5 right-1';

  return (
    <div className="rc-stick-pad w-14 h-14 rounded-lg bg-gray-800/80 border border-gray-600/50 relative">
      {/* Label badge */}
      <span className={`absolute ${labelPosClass} text-[9px] font-bold rc-stick-label leading-none select-none z-10`}>{label}</span>
      {/* Crosshairs */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px rc-stick-crosshair" />
      <div className="absolute top-1/2 left-0 right-0 h-px rc-stick-crosshair" />
      {/* Stick position dot */}
      <div
        className={`absolute w-3 h-3 rounded-full ${dotColor} shadow-lg ${dotGlow} -translate-x-1/2 -translate-y-1/2 transition-all duration-75`}
        style={{
          left: `${50 + cx / 2}%`,
          top: `${50 - cy / 2}%`,
        }}
      />
    </div>
  );
}

export function FlightMap({ flightId, track, homeLat, homeLon, durationSecs, telemetry, themeMode, messages }: FlightMapProps) {
  const { t } = useTranslation();
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 0,
    zoom: 14,
    pitch: 45,
    bearing: 0,
  });
  const [is3D, setIs3D] = useState(() => getSessionBool('map:is3d', true));
  const [mapType, setMapType] = useState<MapType>(() => {
    if (typeof window === 'undefined') return 'satellite'; // Change default to satellite for flight path map
    const validMapTypes = new Set(MAP_TYPE_OPTIONS.map((option) => option.value));

    try {
      const storedLocal = window.localStorage.getItem('map:mapType');
      if (storedLocal && validMapTypes.has(storedLocal as MapType)) {
        return storedLocal as MapType;
      }
    } catch {
      // Ignore localStorage access failures and fall back to session/default.
    }

    // Migrate existing session value if present.
    try {
      const storedSession = window.sessionStorage.getItem('map:mapType');
      if (storedSession && validMapTypes.has(storedSession as MapType)) {
        return storedSession as MapType;
      }
    } catch {
      // Ignore sessionStorage access failures and use default.
    }

    return 'satellite';
  });
  const [colorBy, setColorBy] = useState<ColorByMode>(() => {
    if (typeof window === 'undefined') return 'progress';
    const stored = window.sessionStorage.getItem('map:colorBy') as ColorByMode | null;
    if (stored && COLOR_BY_OPTIONS.some((opt) => opt.value === stored)) {
      return stored;
    }
    return 'progress';
  });
  const [showTooltip, setShowTooltip] = useState(() => {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    return getSessionBool('map:showTooltip', !isMobile);
  });
  const [showAircraft, setShowAircraft] = useState(() => getSessionBool('map:showAircraft', true));
  const [showMedia, setShowMedia] = useState(() => getSessionBool('map:showMedia', false));
  const [mediaTelemetry, setMediaTelemetry] = useState<{ flightId: number; telemetry: TelemetryData } | null>(null);
  useEffect(() => {
    if (!showMedia || mediaTelemetry?.flightId === flightId) return;
    let cancelled = false;
    // Display telemetry may be averaged; markers need the original transition coordinates.
    getFlightData(flightId)
      .then((data) => {
        if (!cancelled) setMediaTelemetry({ flightId, telemetry: data.telemetry });
      })
      .catch((error) => {
        if (!cancelled) console.error('Failed to load media marker positions:', error);
      });
    return () => { cancelled = true; };
  }, [flightId, showMedia, mediaTelemetry?.flightId]);
  const [showMessages, setShowMessages] = useState(() => getSessionBool('map:showMessages', true));
  const [tracePath, setTracePath] = useState(() => getSessionBool('map:tracePath', true));
  const [simplified, setSimplified] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('map:simplified');
    if (stored !== null) return stored === 'true';
    // Default: ON for mobile/tablet (<1024px), OFF for desktop
    return window.innerWidth < 1024;
  });
  const [lineThickness, setLineThickness] = useState(() => {
    if (typeof window === 'undefined') return 3;
    const stored = window.sessionStorage.getItem('map:lineThickness');
    return stored ? Number(stored) : 3;
  });
  const [mapSettingsCollapsed, setMapSettingsCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const isMobile = window.innerWidth < 768;
    const stored = window.sessionStorage.getItem('map:settingsCollapsed');
    if (stored !== null) return stored === 'true';
    return isMobile;
  });
  const [hoverInfo, setHoverInfo] = useState<{
    x: number; y: number;
    height: number; speed: number; distance: number; progress: number;
    lat: number; lng: number; battery: number | null;
  } | null>(null);
  const { unitPrefs, locale, mapSyncEnabled, setMapReplayProgress } = useFlightStore();
  const mapRef = useRef<MapRef | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [groundElevation, setGroundElevation] = useState(0);
  const updateGroundElevation = useCallback(() => {
    const map = mapRef.current?.getMap();
    const lng = homeLon ?? track[0]?.[0];
    const lat = homeLat ?? track[0]?.[1];
    const elevation = is3D && map?.getTerrain() && lng != null && lat != null
      ? map.queryTerrainElevation([lng, lat])
      : 0;
    setGroundElevation(elevation != null && Number.isFinite(elevation) ? elevation : 0);
  }, [homeLat, homeLon, track, is3D]);
  useEffect(updateGroundElevation, [updateGroundElevation]);

  // Capture map snapshot when requested (for FlyCard export)
  // MapLibreOverlay with interleaved: false renders deck.gl layers on a
  // separate canvas stacked on top of the MapLibre canvas.  We must
  // composite all canvases inside the map container to include the
  // flight path, markers, etc.
  const captureMapSnapshot = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) {
      console.warn('Map ref not available for capture');
      return null;
    }

    try {
      map.triggerRepaint();

      const mapCanvas = map.getCanvas();
      if (!mapCanvas) {
        console.warn('Map canvas not available');
        return null;
      }

      // Collect all visible canvas elements inside the map container
      const container = map.getContainer();
      const allCanvases = Array.from(container.querySelectorAll('canvas'));

      if (allCanvases.length <= 1) {
        // Only the base map canvas — fast path
        return mapCanvas.toDataURL('image/png');
      }

      // Composite every canvas (map tiles + deck.gl overlay) in DOM order
      const composite = document.createElement('canvas');
      composite.width = mapCanvas.width;
      composite.height = mapCanvas.height;
      const ctx = composite.getContext('2d');
      if (!ctx) return mapCanvas.toDataURL('image/png');

      for (const c of allCanvases) {
        if (c.width === 0 || c.height === 0) continue;
        try {
          ctx.drawImage(c, 0, 0, composite.width, composite.height);
        } catch {
          // skip tainted canvases
        }
      }

      return composite.toDataURL('image/png');
    } catch (err) {
      console.error('Failed to capture map snapshot:', err);
      return null;
    }
  }, []);

  // Expose capture function via store when map is ready
  useEffect(() => {
    // Store the capture function reference for external access
    (window as any).__captureFlightMapSnapshot = captureMapSnapshot;
    return () => {
      delete (window as any).__captureFlightMapSnapshot;
    };
  }, [captureMapSnapshot]);

  // ─── Flight replay state ────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0); // 0–1
  const [replaySpeed, setReplaySpeed] = useState(1);
  const replayTimerRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return themeMode;
  }, [themeMode]);

  const activeMapStyle = useMemo(
    () => getMapStyle(mapType, resolvedTheme),
    [mapType, resolvedTheme]
  );

  // Save map settings to session storage whenever they change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('map:mapType', mapType);
        window.localStorage.setItem('map:simplified', String(simplified));
      } catch {
        // Ignore persistence failures (map still functions with in-memory state).
      }
      window.sessionStorage.setItem('map:is3d', String(is3D));
      window.sessionStorage.setItem('map:colorBy', colorBy);
      window.sessionStorage.setItem('map:showTooltip', String(showTooltip));
      window.sessionStorage.setItem('map:showAircraft', String(showAircraft));
      window.sessionStorage.setItem('map:showMedia', String(showMedia));
      window.sessionStorage.setItem('map:showMessages', String(showMessages));
      window.sessionStorage.setItem('map:tracePath', String(tracePath));
      window.sessionStorage.setItem('map:lineThickness', String(lineThickness));
      window.sessionStorage.setItem('map:settingsCollapsed', String(mapSettingsCollapsed));
    }
  }, [
    mapType,
    is3D,
    colorBy,
    showTooltip,
    showAircraft,
    showMedia,
    showMessages,
    tracePath,
    simplified,
    lineThickness,
    mapSettingsCollapsed,
  ]);

  // ─── Flight replay animation loop ──────────────────────────────────
  const effectiveDuration = useMemo(
    () => (durationSecs && durationSecs > 0 ? durationSecs : track.length),
    [durationSecs, track.length]
  );

  // Stop replay when track changes (new flight selected)
  useEffect(() => {
    setIsPlaying(false);
    setReplayProgress(0);
    if (replayTimerRef.current) {
      cancelAnimationFrame(replayTimerRef.current);
      replayTimerRef.current = null;
    }
  }, [track]);

  useEffect(() => {
    if (!isPlaying) {
      if (replayTimerRef.current) {
        cancelAnimationFrame(replayTimerRef.current);
        replayTimerRef.current = null;
      }
      return;
    }

    lastFrameRef.current = performance.now();

    const animate = (now: number) => {
      const dt = (now - lastFrameRef.current) / 1000; // seconds elapsed
      lastFrameRef.current = now;

      setReplayProgress((prev) => {
        const increment = (dt * replaySpeed) / effectiveDuration;
        const next = prev + increment;
        if (next >= 1) {
          setIsPlaying(false);
          return 1;
        }
        return next;
      });

      replayTimerRef.current = requestAnimationFrame(animate);
    };

    replayTimerRef.current = requestAnimationFrame(animate);

    return () => {
      if (replayTimerRef.current) {
        cancelAnimationFrame(replayTimerRef.current);
        replayTimerRef.current = null;
      }
    };
  }, [isPlaying, replaySpeed, effectiveDuration]);

  // Compute current replay marker position by interpolating along the smoothed track
  const replayMarkerPos = useMemo(() => {
    if (track.length === 0) return null;
    // Use raw track (not smoothed) so the index maps cleanly to flight time
    const n = track.length;
    const idx = replayProgress * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n - 1);
    const frac = idx - lo;
    const pLo = track[lo];
    const pHi = track[hi];
    if (!pLo || !pHi) return null;
    const lng = pLo[0] + (pHi[0] - pLo[0]) * frac;
    const lat = pLo[1] + (pHi[1] - pLo[1]) * frac;
    const alt = pLo[2] + (pHi[2] - pLo[2]) * frac;
    return { lng, lat, alt: is3D ? alt + groundElevation : 0 };
  }, [track, replayProgress, is3D, groundElevation]);

  // Sync replay progress to store for chart axis pointer
  useEffect(() => {
    if (mapSyncEnabled) {
      setMapReplayProgress(replayProgress);
    }
  }, [mapSyncEnabled, replayProgress, setMapReplayProgress]);

  // Clear store progress when sync is disabled
  useEffect(() => {
    if (!mapSyncEnabled) {
      setMapReplayProgress(0);
    }
  }, [mapSyncEnabled, setMapReplayProgress]);

  // Build DeckGL replay marker layers (3D-aware)
  const replayDeckLayers = useMemo(() => {
    if (!showAircraft || !replayMarkerPos || (!isPlaying && replayProgress === 0)) return [];
    const pos: [number, number, number] = [replayMarkerPos.lng, replayMarkerPos.lat, replayMarkerPos.alt];

    // Interpolate yaw at current replay position
    let yaw = 0;
    if (telemetry?.yaw && telemetry.yaw.length > 0) {
      const n = telemetry.yaw.length;
      const idx = replayProgress * (n - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, n - 1);
      const frac = idx - lo;
      const yawLo = telemetry.yaw[lo];
      const yawHi = telemetry.yaw[hi];
      if (yawLo !== null && yawHi !== null) {
        // Handle angle wrap-around (e.g., 350° to 10°)
        let diff = yawHi - yawLo;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        yaw = yawLo + diff * frac;
      } else if (yawLo !== null) {
        yaw = yawLo;
      } else if (yawHi !== null) {
        yaw = yawHi;
      }
    }

    return [
      // Outer glow ring (kept for visual effect)
      new ScatterplotLayer({
        id: 'replay-marker-glow',
        data: [{ position: pos }],
        getPosition: (d: { position: [number, number, number] }) => d.position,
        getRadius: 18,
        radiusUnits: 'pixels',
        getFillColor: [0, 212, 170, 50],
        stroked: false,
        filled: true,
        billboard: true,
        parameters: { depthTest: false },
      }),
      // Arrow icon showing heading direction (fixed pixel size)
      ...(arrowAtlasCanvas ? [new IconLayer({
        id: 'replay-marker-arrow',
        data: [{ position: pos, angle: yaw }],
        getPosition: (d: { position: [number, number, number] }) => d.position,
        iconAtlas: arrowAtlasCanvas as any,
        iconMapping: ARROW_ICON_MAPPING,
        getIcon: () => 'arrow',
        getSize: 28,
        sizeUnits: 'pixels',
        getAngle: (d: { angle: number }) => -d.angle, // Negative because IconLayer rotates counter-clockwise
        billboard: false,
        parameters: { depthTest: false },
      })] : []),
    ];
  }, [showAircraft, replayMarkerPos, isPlaying, replayProgress, telemetry?.yaw]);

  // Whether the replay is actively showing (playing or scrubbed away from 0)
  const replayActive = showAircraft && (isPlaying || replayProgress > 0);

  // Optionally render only the travelled portion of the path while replay is active.
  const tracePathActive = tracePath && replayActive;
  const displayedTrack = useMemo(() => {
    if (!tracePathActive || track.length < 2) return track;
    const maxIdx = Math.max(1, Math.min(track.length - 1, Math.floor(replayProgress * (track.length - 1))));
    return track.slice(0, maxIdx + 1);
  }, [tracePathActive, track, replayProgress]);

  // Interpolate telemetry at current replay position
  const replayTelemetry = useMemo(() => {
    if (!telemetry || !telemetry.time || telemetry.time.length === 0 || track.length === 0) return null;
    const n = telemetry.time.length;
    const idx = replayProgress * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n - 1);
    const frac = idx - lo;

    const lerp = (arr: (number | null)[] | undefined): number | null => {
      if (!arr) return null;
      const a = arr[lo] ?? null;
      const b = arr[hi] ?? null;
      if (a === null) return b;
      if (b === null) return a;
      return a + (b - a) * frac;
    };

    const height = lerp(telemetry.height);
    const speed = lerp(telemetry.speed);
    const battery = lerp(telemetry.battery);
    const satellites = telemetry.satellites?.[lo] ?? null;
    const altitude = lerp(telemetry.altitude) ?? lerp(telemetry.height);
    const vpsHeight = lerp(telemetry.vpsHeight);
    const pitch = lerp(telemetry.pitch);
    const roll = lerp(telemetry.roll);
    const yaw = lerp(telemetry.yaw);
    const rcSignalRaw = telemetry.rcSignal?.[lo] ?? null;
    const rcSignal = rcSignalRaw === 0 ? null : rcSignalRaw;
    const batteryVoltage = lerp(telemetry.batteryVoltage);
    const batteryTemp = lerp(telemetry.batteryTemp);
    const rcAileron = lerp(telemetry.rcAileron);
    const rcElevator = lerp(telemetry.rcElevator);
    const rcThrottle = lerp(telemetry.rcThrottle);
    const rcRudder = lerp(telemetry.rcRudder);

    // Compute distance from home at this point
    const lat = lerp(telemetry.latitude);
    const lng = lerp(telemetry.longitude);
    const hLat = homeLat ?? (track.length > 0 ? track[0]?.[1] : null) ?? 0;
    const hLon = homeLon ?? (track.length > 0 ? track[0]?.[0] : null) ?? 0;
    const distHome = lat !== null && lng !== null
      ? haversineM(hLat, hLon, lat, lng)
      : null;

    // Flight time
    const timeSecs = durationSecs != null && durationSecs > 0
      ? Math.round(replayProgress * durationSecs)
      : null;

    return {
      height, speed, battery, satellites, altitude, vpsHeight,
      pitch, roll, yaw, rcSignal, batteryVoltage, batteryTemp,
      rcAileron, rcElevator, rcThrottle, rcRudder,
      distHome, timeSecs, lat, lng,
    };
  }, [telemetry, track, replayProgress, homeLat, homeLon, durationSecs]);

  // Compute active message at current replay position
  const activeMessage = useMemo(() => {
    if (!showMessages || !messages || messages.length === 0) return null;
    if (!replayActive) return null;

    const currentTimeMs = durationSecs != null && durationSecs > 0
      ? replayProgress * durationSecs * 1000
      : 0;

    // Find message closest to current time within a 2-second window
    const tolerance = 2000; // 2 seconds
    let closest: FlightMessage | null = null;
    let closestDist = tolerance;

    for (const msg of messages) {
      const dist = Math.abs(msg.timestampMs - currentTimeMs);
      if (dist < closestDist) {
        closest = msg;
        closestDist = dist;
      }
    }

    return closest;
  }, [showMessages, messages, replayActive, replayProgress, durationSecs]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      // If at end, restart from beginning
      if (replayProgress >= 1) setReplayProgress(0);
      setIsPlaying(true);
    }
  }, [isPlaying, replayProgress]);

  const handleReplaySeek = useCallback((value: number) => {
    setReplayProgress(value);
  }, []);

  const formatReplayTime = useCallback(
    (progress: number) => {
      const totalSecs = Math.round(progress * effectiveDuration);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    },
    [effectiveDuration]
  );

  // Calculate center and bounds when track changes
  useEffect(() => {
    if (track.length > 0) {
      const [lng, lat] = getTrackCenter(track);
      const bounds = calculateBounds(track);

      // Estimate zoom from bounds
      let zoom = 14;
      if (bounds) {
        const lngDiff = bounds[1][0] - bounds[0][0];
        const latDiff = bounds[1][1] - bounds[0][1];
        const maxDiff = Math.max(lngDiff, latDiff);
        zoom = Math.max(10, Math.min(18, 16 - Math.log2(maxDiff * 111)));
      }

      setViewState((prev) => ({
        ...prev,
        longitude: lng,
        latitude: lat,
        zoom,
      }));
    } else if (homeLat != null && homeLon != null) {
      // Manual entry with no track - center on home location
      setViewState((prev) => ({
        ...prev,
        longitude: homeLon,
        latitude: homeLat,
        zoom: 15,
      }));
    }
  }, [track, homeLat, homeLon]);

  // Smooth the raw GPS track
  const smoothedTrack = useMemo(() => {
    if (displayedTrack.length < 3) return displayedTrack;
    if (simplified) {
      // Simplified: two passes of moving-average for noise reduction
      // with minimal vertex count — works well on all devices.
      const pass1 = movingAverageSmooth(displayedTrack, 5);
      return movingAverageSmooth(pass1, 4);
    }
    // Full mode: cap raw points before Catmull-Rom to avoid creating
    // an excessive number of segments (resolution 4 = 4x multiplier).
    // 3000 raw → ~12000 smoothed points is plenty for visual fidelity.
    const capped = displayedTrack.length > 3000 ? downsample(displayedTrack, 3000) : displayedTrack;
    return smoothTrack(capped, 4);
  }, [displayedTrack, simplified]);

  const deckPathData = useMemo(() => {
    if (smoothedTrack.length < 2) return [];

    // Flight heights are relative to takeoff; deck.gl positions are above sea level.
    const toAlt = (altitude: number) => (is3D ? altitude + groundElevation : 0);
    const n = smoothedTrack.length;
    const rawN = displayedTrack.length;

    // ── Simplified: single multi-point path with solid color ──────
    // This reduces GPU draw calls from thousands to 1, which is
    // critical for mobile WebGL where per-segment PathLayer data
    // (each with capRounded + jointRounded + billboard tessellation)
    // exceeds vertex buffer / shader limits.
    if (simplified) {
      // When 3D terrain is on, use deck.gl PathLayer for altitude.
      // When flat 2D, the MapLibre native line layer handles rendering.
      if (!is3D) return [];
      const full: [number, number, number][] = smoothedTrack.map(([lng, lat, alt]) => [
        lng, lat, toAlt(alt),
      ]);
      const path = downsample(full, 2000);
      return [{
        path,
        color: [250, 204, 21] as [number, number, number],
        meta: { height: 0, speed: 0, distance: 0, progress: 0, lat: 0, lng: 0, battery: null },
      }];
    }

    // ── Desktop: per-segment gradient coloring ────────────────────
    const telemetryN = telemetry?.isVideo?.length ?? 0;

    // Pre-compute per-point values depending on colorBy mode
    let values: number[] | null = null;
    let nullableValues: (number | null)[] | null = null;
    let minVal = 0;
    let maxVal = 1;

    // For video segment mode, map telemetry isVideo to smoothed track indices
    // The track is derived from telemetry (filtered/downsampled), so we map through telemetry length
    let isVideoAtIndex: boolean[] | null = null;
    if (colorBy === 'videoSegment' && telemetry?.isVideo && telemetryN > 0) {
      isVideoAtIndex = [];
      for (let i = 0; i < n; i++) {
        // Map smoothed point → raw track index → telemetry index
        const rawTrackIndex = Math.round((i / Math.max(1, n - 1)) * Math.max(1, rawN - 1));
        const telemetryIndex = Math.round((rawTrackIndex / Math.max(1, rawN - 1)) * Math.max(1, telemetryN - 1));
        const isRecording = telemetry.isVideo[telemetryIndex] === true;
        isVideoAtIndex.push(isRecording);
      }
    }

    const mapTelemetrySeriesToPath = (series?: (number | null)[]): (number | null)[] => {
      const telemetryLen = series?.length ?? 0;
      if (!series || telemetryLen === 0) return new Array(n).fill(null);
      const mapped: (number | null)[] = [];
      for (let i = 0; i < n; i++) {
        const rawTrackIndex = Math.round((i / Math.max(1, n - 1)) * Math.max(1, rawN - 1));
        const telemetryIndex = Math.round((rawTrackIndex / Math.max(1, rawN - 1)) * Math.max(1, telemetryLen - 1));
        mapped.push(series[telemetryIndex] ?? null);
      }
      return mapped;
    };

    const batteryAtIndex = mapTelemetrySeriesToPath(telemetry?.battery);
    const telemetrySpeedAtIndex = mapTelemetrySeriesToPath(telemetry?.speed);
    const rcSignalAtIndex = mapTelemetrySeriesToPath(telemetry?.rcSignal).map((v) => (v === 0 ? null : v));
    const rcSignalNearestAtIndex = [...rcSignalAtIndex];
    let lastRcSignal: number | null = null;
    for (let i = 0; i < rcSignalNearestAtIndex.length; i++) {
      const value = rcSignalNearestAtIndex[i];
      if (value !== null) {
        lastRcSignal = value;
      } else if (lastRcSignal !== null) {
        rcSignalNearestAtIndex[i] = lastRcSignal;
      }
    }
    let nextRcSignal: number | null = null;
    for (let i = rcSignalNearestAtIndex.length - 1; i >= 0; i--) {
      const value = rcSignalNearestAtIndex[i];
      if (value !== null) {
        nextRcSignal = value;
      } else if (nextRcSignal !== null) {
        rcSignalNearestAtIndex[i] = nextRcSignal;
      }
    }
    const satelliteCountAtIndex = mapTelemetrySeriesToPath(telemetry?.satellites);

    if (colorBy === 'height') {
      values = smoothedTrack.map((p) => p[2]);
      minVal = values[0] ?? 0;
      maxVal = values[0] ?? 0;
      for (let i = 1; i < values.length; i++) {
        if (values[i] < minVal) minVal = values[i];
        if (values[i] > maxVal) maxVal = values[i];
      }
    } else if (colorBy === 'speed') {
      // Speed telemetry is stored in m/s; prefer it for accurate color mapping.
      // Fall back to distance/time estimation when telemetry speed is unavailable.
      const fallbackStepSecs = durationSecs && durationSecs > 0 && n > 1
        ? durationSecs / (n - 1)
        : null;
      values = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const telemetryMs = telemetrySpeedAtIndex[i];
        if (telemetryMs !== null) {
          values[i] = telemetryMs;
          continue;
        }
        if (i === 0 || !fallbackStepSecs || fallbackStepSecs <= 0) {
          values[i] = 0;
          continue;
        }
        const d = haversineM(
          smoothedTrack[i - 1][1], smoothedTrack[i - 1][0],
          smoothedTrack[i][1], smoothedTrack[i][0]
        );
        values[i] = d / fallbackStepSecs;
      }
      minVal = values[0] ?? 0;
      maxVal = values[0] ?? 0;
      for (let i = 1; i < values.length; i++) {
        if (values[i] < minVal) minVal = values[i];
        if (values[i] > maxVal) maxVal = values[i];
      }
    } else if (colorBy === 'distance') {
      const hLat = homeLat ?? smoothedTrack[0]?.[1] ?? 0;
      const hLon = homeLon ?? smoothedTrack[0]?.[0] ?? 0;
      values = smoothedTrack.map((p) => haversineM(hLat, hLon, p[1], p[0]));
      minVal = values[0] ?? 0;
      maxVal = values[0] ?? 0;
      for (let i = 1; i < values.length; i++) {
        if (values[i] < minVal) minVal = values[i];
        if (values[i] > maxVal) maxVal = values[i];
      }
    } else if (colorBy === 'batteryPercent') {
      values = batteryAtIndex.map((v) => v ?? 0);
      minVal = 0;
      maxVal = 100;
    } else if (colorBy === 'rcSignal') {
      nullableValues = rcSignalNearestAtIndex;
      minVal = 30;
      maxVal = 100;
    } else if (colorBy === 'satelliteCount') {
      values = satelliteCountAtIndex.map((v) => v ?? 3);
      minVal = 3;
      maxVal = 30;
    }

    const range = maxVal - minVal || 1;

    const getRamp = () => {
      switch (colorBy) {
        case 'height': return RAMP_HEIGHT;
        case 'speed': return RAMP_SPEED;
        case 'distance': return RAMP_DISTANCE;
        case 'batteryPercent':
        case 'rcSignal':
        case 'satelliteCount':
          return RAMP_QUALITY;
        default: return RAMP_PROGRESS;
      }
    };
    const ramp = getRamp();

    // Pre-compute per-point speed (m/s) and distance for tooltip.
    const fallbackStepSecs = durationSecs && durationSecs > 0 && n > 1
      ? durationSecs / (n - 1)
      : null;
    const speeds: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const telemetryMs = telemetrySpeedAtIndex[i];
      if (telemetryMs !== null) {
        speeds[i] = telemetryMs;
        continue;
      }
      if (i === 0 || !fallbackStepSecs || fallbackStepSecs <= 0) {
        speeds[i] = 0;
        continue;
      }
      const d = haversineM(smoothedTrack[i - 1][1], smoothedTrack[i - 1][0], smoothedTrack[i][1], smoothedTrack[i][0]);
      speeds[i] = d / fallbackStepSecs;
    }
    const hLat = homeLat ?? smoothedTrack[0]?.[1] ?? 0;
    const hLon = homeLon ?? smoothedTrack[0]?.[0] ?? 0;
    const distances: number[] = smoothedTrack.map((p) => haversineM(hLat, hLon, p[1], p[0]));

    const segments: {
      path: [number, number, number][];
      color: [number, number, number];
      meta: { height: number; speed: number; distance: number; progress: number; lat: number; lng: number; battery: number | null };
    }[] = [];

    // Batch consecutive segments whose colors are similar into multi-point
    // paths.  For gradient modes (progress/height/speed/distance) the color
    // changes on every segment, so exact-match batching does nothing.
    // Using a perceptual threshold (max channel diff ≤ 12) groups segments
    // that look virtually identical, cutting draw calls by 10-40× while
    // preserving the visible gradient.
    const BATCH_SIZE = showTooltip ? 1 : 80;
    const COLOR_THRESHOLD = showTooltip ? -1 : 12; // disable color batching while hovering for fine-grained updates
    let batchPath: [number, number, number][] = [];
    let batchColor: [number, number, number] | null = null;
    let batchMeta: { height: number; speed: number; distance: number; progress: number; lat: number; lng: number; battery: number | null } | null = null;

    const flushBatch = () => {
      if (batchPath.length >= 2 && batchColor && batchMeta) {
        segments.push({ path: [...batchPath], color: batchColor, meta: batchMeta });
      }
    };

    for (let i = 0; i < n - 1; i++) {
      const ptA = smoothedTrack[i];
      const ptB = smoothedTrack[i + 1];
      if (!ptA || !ptB) continue;

      let color: [number, number, number];
      if (colorBy === 'videoSegment') {
        // Use red for video recording, blue for normal flight
        const isRecording = isVideoAtIndex ? isVideoAtIndex[i] : false;
        color = isRecording ? COLOR_VIDEO_RECORDING : COLOR_VIDEO_NORMAL;
      } else {
        const isRcSignalMode = colorBy === 'rcSignal';
        const value = isRcSignalMode ? (nullableValues?.[i] ?? null) : (values?.[i] ?? null);
        const t = value !== null
          ? (value - minVal) / range
          : (isRcSignalMode ? 0.5 : i / Math.max(1, n - 2));
        color = valueToColor(t, ramp);
      }

      const [lng1, lat1, alt1] = ptA;
      const [lng2, lat2, alt2] = ptB;
      const pt1: [number, number, number] = [lng1, lat1, toAlt(alt1)];
      const pt2: [number, number, number] = [lng2, lat2, toAlt(alt2)];

      // Check if color is close enough to current batch color
      const similarColor = batchColor &&
        Math.abs(color[0] - batchColor[0]) <= COLOR_THRESHOLD &&
        Math.abs(color[1] - batchColor[1]) <= COLOR_THRESHOLD &&
        Math.abs(color[2] - batchColor[2]) <= COLOR_THRESHOLD;
      if (!similarColor || batchPath.length >= BATCH_SIZE) {
        flushBatch();
        batchPath = [pt1, pt2];
        batchColor = color;
        batchMeta = {
          height: alt1,
          speed: speeds[i],
          distance: distances[i],
          progress: i / Math.max(1, n - 2),
          lat: lat1,
          lng: lng1,
          battery: batteryAtIndex[i],
        };
      } else {
        batchPath.push(pt2);
      }
    }
    flushBatch();

    return segments;
  }, [is3D, groundElevation, smoothedTrack, displayedTrack, colorBy, homeLat, homeLon, telemetry, durationSecs, showTooltip, simplified]);

  // ── Simplified 2D: GeoJSON for MapLibre native line layer ──────
  const simplifiedPathGeoJSON = useMemo(() => {
    if (!simplified || is3D || smoothedTrack.length < 2) return null;
    const coords = downsample(smoothedTrack, 800).map(([lng, lat]) => [lng, lat]);
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: coords,
      },
      properties: {},
    };
  }, [simplified, is3D, smoothedTrack]);

  const deckLayers = useMemo(() => {
    if (deckPathData.length === 0) return [];
    const shadowWidth = lineThickness + 3;

    if (simplified) {
      // Simplified 3D: single PathLayer with consistent uniform thickness.
      // 2D mode uses MapLibre native line instead (deckPathData returns [] above).
      return [
        new PathLayer({
          id: 'flight-path-simplified',
          data: deckPathData,
          getPath: (d) => d.path,
          getColor: [250, 204, 21, 255],
          getWidth: lineThickness,
          widthUnits: 'pixels',
          widthMinPixels: Math.max(2, lineThickness),
          capRounded: true,
          jointRounded: true,
          billboard: false,
          opacity: 1,
          pickable: false,
          parameters: { depthTest: false },
        }),
      ];
    }

    // Full mode: shadow + gradient path
    return [
      // Shadow layer slightly thicker than path, purely for visual drop-shadow effect
      new PathLayer({
        id: 'flight-path-shadow',
        data: deckPathData,
        getPath: (d) => d.path,
        getColor: [0, 0, 0, mapType === 'satellite' ? 40 : 0],
        getWidth: shadowWidth,
        widthUnits: 'pixels',
        widthMinPixels: shadowWidth - 1,
        capRounded: true,
        jointRounded: true,
        billboard: true,
        opacity: 1,
        pickable: false,
        parameters: { depthTest: false },
      }),
      // Main gradient path layer — pickable when tooltip is on
      new PathLayer({
        id: 'flight-path-3d',
        data: deckPathData,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: lineThickness,
        widthUnits: 'pixels',
        widthMinPixels: Math.max(1, lineThickness - 1),
        capRounded: true,
        jointRounded: true,
        billboard: true,
        opacity: 1,
        pickable: showTooltip,
        parameters: { depthTest: is3D }, // Disable depth-test in 2D so layers aren't clipped by invisible terrain
      }),
    ];
  }, [deckPathData, showTooltip, lineThickness, is3D, mapType, simplified]);

  // ─── Media markers (photo/video locations) with clustering ────────
  interface MediaCluster {
    position: [number, number, number];
    type: 'photo' | 'videoStart' | 'videoStop';
    count: number;
  }

  // Extract photo and video capture locations from telemetry
  const mediaPoints = useMemo<MediaPoint[]>(() => {
    if (!showMedia || mediaTelemetry?.flightId !== flightId) return [];
    return getMediaPoints(mediaTelemetry.telemetry, is3D).map((point) => ({
      ...point,
      position: [point.position[0], point.position[1], point.position[2] + (is3D ? groundElevation : 0)] as [number, number, number],
    }));
  }, [flightId, mediaTelemetry, showMedia, is3D, groundElevation]);

  // Cluster points within 0.5 meters of each other
  // For mixed types at same location, create separate markers for each type
  const mediaClusters = useMemo<MediaCluster[]>(() => {
    if (mediaPoints.length === 0) return [];

    const CLUSTER_THRESHOLD_M = 0.5; // 0.5 meters
    const used = new Set<number>();
    const clusteredPoints: { points: MediaPoint[]; position: [number, number, number] }[] = [];

    // Group nearby points together
    for (let i = 0; i < mediaPoints.length; i++) {
      if (used.has(i)) continue;

      const pt = mediaPoints[i];
      const [lng, lat] = pt.position;
      const cluster: MediaPoint[] = [pt];
      used.add(i);

      // Find nearby points to cluster together
      for (let j = i + 1; j < mediaPoints.length; j++) {
        if (used.has(j)) continue;
        const other = mediaPoints[j];
        const dist = haversineM(lat, lng, other.position[1], other.position[0]);
        if (dist < CLUSTER_THRESHOLD_M) {
          cluster.push(other);
          used.add(j);
        }
      }

      // Calculate cluster center
      const avgLng = cluster.reduce((s, p) => s + p.position[0], 0) / cluster.length;
      const avgLat = cluster.reduce((s, p) => s + p.position[1], 0) / cluster.length;
      const avgAlt = cluster.reduce((s, p) => s + p.position[2], 0) / cluster.length;

      clusteredPoints.push({
        points: cluster,
        position: [avgLng, avgLat, avgAlt],
      });
    }

    // Now split each cluster by type
    const clusters: MediaCluster[] = [];

    for (const { points, position } of clusteredPoints) {
      // Group by type at this location - create separate clusters for each type
      const byType: Record<string, number> = {};
      for (const p of points) {
        byType[p.type] = (byType[p.type] ?? 0) + 1;
      }

      // Create a cluster for each type present at this location
      for (const type of Object.keys(byType)) {
        clusters.push({
          position,
          type: type as 'photo' | 'videoStart' | 'videoStop',
          count: byType[type],
        });
      }
    }

    return clusters;
  }, [mediaPoints]);

  // DeckGL layers for media markers (3D positioned)
  const mediaLayers = useMemo(() => {
    if (!showMedia || mediaClusters.length === 0) return [];

    // Use meters for radius so markers scale with zoom
    const baseRadius = 4; // increased from 3 to 5 based on user request

    // Define offset cluster type
    type OffsetCluster = MediaCluster & { offset: [number, number] };

    // Offset positions slightly for overlapping markers at same location
    // Group by position to detect overlaps
    const positionGroups: Record<string, MediaCluster[]> = {};
    for (const cluster of mediaClusters) {
      const key = `${cluster.position[0].toFixed(7)},${cluster.position[1].toFixed(7)}`;
      if (!positionGroups[key]) positionGroups[key] = [];
      positionGroups[key].push(cluster);
    }

    // Apply small offsets for overlapping markers
    const offsetClusters: OffsetCluster[] = [];
    for (const key of Object.keys(positionGroups)) {
      const group = positionGroups[key];
      if (group.length === 1) {
        offsetClusters.push({ ...group[0], offset: [0, 0] });
      } else {
        // Offset markers horizontally when multiple at same location
        const spacing = 8; // pixels
        const totalWidth = (group.length - 1) * spacing;
        group.forEach((cluster: MediaCluster, i: number) => {
          offsetClusters.push({
            ...cluster,
            offset: [i * spacing - totalWidth / 2, 0]
          });
        });
      }
    }

    // Separate by type
    const photoClusters = offsetClusters.filter((d: OffsetCluster) => d.type === 'photo');
    const videoClusters = offsetClusters.filter((d: OffsetCluster) => d.type !== 'photo');

    return [
      // === PHOTO MARKERS ===
      // Photo border (white outline)
      new ScatterplotLayer({
        id: 'media-photo-border',
        data: photoClusters,
        getPosition: (d: OffsetCluster) => d.position,
        getRadius: baseRadius * 1.3,
        radiusUnits: 'meters',
        radiusMinPixels: 8,
        radiusMaxPixels: 14,
        getFillColor: [255, 255, 255, 255],
        stroked: false,
        filled: true,
        billboard: true,
        getPixelOffset: (d: OffsetCluster) => d.offset,
        parameters: { depthTest: true, depthMask: true },
      }),
      // Photo dot (blue)
      new ScatterplotLayer({
        id: 'media-photo-dot',
        data: photoClusters,
        getPosition: (d: OffsetCluster) => d.position,
        getRadius: baseRadius,
        radiusUnits: 'meters',
        radiusMinPixels: 5,
        radiusMaxPixels: 11,
        getFillColor: [59, 130, 246, 255], // Blue
        stroked: false,
        filled: true,
        billboard: true,
        getPixelOffset: (d: OffsetCluster) => d.offset,
        parameters: { depthTest: true, depthMask: true },
      }),
      // Photo count text
      new TextLayer({
        id: 'media-photo-text',
        data: photoClusters,
        getPosition: (d: OffsetCluster) => d.position,
        getText: (d: OffsetCluster) => String(d.count),
        getSize: baseRadius * 1.8,
        sizeUnits: 'meters',
        sizeMinPixels: 10,
        sizeMaxPixels: 14,
        getColor: [255, 255, 255, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: 'bold',
        billboard: true,
        getPixelOffset: (d: OffsetCluster) => d.offset,
        parameters: { depthTest: true, depthMask: false },
      }),
      // === VIDEO MARKERS ===
      // Video border
      new ScatterplotLayer({
        id: 'media-video-border',
        data: videoClusters,
        getPosition: (d: OffsetCluster) => d.position,
        getRadius: baseRadius * 1.3,
        radiusUnits: 'meters',
        radiusMinPixels: 8,
        radiusMaxPixels: 14,
        getFillColor: [255, 255, 255, 255],
        stroked: false,
        filled: true,
        billboard: true,
        getPixelOffset: (d: OffsetCluster) => d.offset,
        parameters: { depthTest: true, depthMask: true },
      }),
      // Video dot (green for start, red for stop)
      new ScatterplotLayer({
        id: 'media-video-dot',
        data: videoClusters,
        getPosition: (d: OffsetCluster) => d.position,
        getRadius: baseRadius,
        radiusUnits: 'meters',
        radiusMinPixels: 5,
        radiusMaxPixels: 11,
        getFillColor: (d: OffsetCluster) => {
          if (d.type === 'videoStart') return [34, 197, 94, 255];  // Green
          return [239, 68, 68, 255];  // Red for stop
        },
        stroked: false,
        filled: true,
        billboard: true,
        getPixelOffset: (d: OffsetCluster) => d.offset,
        parameters: { depthTest: true, depthMask: true },
      }),
    ];
  }, [showMedia, mediaClusters]);

  // Start and end markers
  const startPoint = displayedTrack.length > 0 ? displayedTrack[0] : undefined;
  const endPoint = displayedTrack.length > 0 ? displayedTrack[displayedTrack.length - 1] : undefined;

  const handleMapMove = useCallback(
    ({ viewState: nextViewState }: { viewState: typeof viewState }) => {
      setViewState(nextViewState);
    },
    []
  );

  // Reset view to fit the track (same as initial load)
  const resetView = useCallback(() => {
    if (track.length === 0) return;

    const [lng, lat] = getTrackCenter(track);
    const bounds = calculateBounds(track);

    let zoom = 14;
    if (bounds) {
      const lngDiff = bounds[1][0] - bounds[0][0];
      const latDiff = bounds[1][1] - bounds[0][1];
      const maxDiff = Math.max(lngDiff, latDiff);
      zoom = Math.max(10, Math.min(18, 16 - Math.log2(maxDiff * 111)));
    }

    setViewState((prev) => ({
      ...prev,
      longitude: lng,
      latitude: lat,
      zoom,
      pitch: is3D ? 60 : 0,
      bearing: 0,
    }));
  }, [track, is3D]);

  const enableTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    try {
      if (!map.getSource(TERRAIN_SOURCE_ID)) {
        map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
      }
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.4 });
    } catch (e) {
      console.warn('[FlightMap] Failed to enable terrain:', e);
    }
  }, []);

  const disableTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    try {
      map.setTerrain(null);
    } catch (e) {
      console.warn('[FlightMap] Failed to disable terrain:', e);
    }
  }, []);

  useEffect(() => {
    if (is3D) {
      enableTerrain();
      setViewState((prev) => ({ ...prev, pitch: 60 }));
    } else {
      disableTerrain();
      setViewState((prev) => ({ ...prev, pitch: 0 }));
    }
  }, [disableTerrain, enableTerrain, is3D]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:is3d', String(is3D));
    }
  }, [is3D]);

  // isSatellite has been replaced by the centralized mapType effect above


  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:colorBy', colorBy);
    }
  }, [colorBy]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:lineThickness', String(lineThickness));
    }
  }, [lineThickness]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:showTooltip', String(showTooltip));
    }
    if (!showTooltip) setHoverInfo(null);
  }, [showTooltip]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:showAircraft', String(showAircraft));
    }
    if (!showAircraft) {
      setIsPlaying(false);
      setReplayProgress(0);
    }
  }, [showAircraft]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:showMedia', String(showMedia));
    }
  }, [showMedia]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:showMessages', String(showMessages));
    }
  }, [showMessages]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:tracePath', String(tracePath));
    }
  }, [tracePath]);

  useEffect(() => {
    if (is3D) {
      enableTerrain();
    }
  }, [enableTerrain, is3D, resolvedTheme]);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const resizeMap = () => {
      const map = mapRef.current?.getMap();
      if (!map) return;
      // Run on next frame so layout changes settle before resizing the canvas.
      requestAnimationFrame(() => {
        map.resize();
      });
    };

    resizeMap();

    const observer = new ResizeObserver(() => {
      resizeMap();
    });
    observer.observe(container);

    window.addEventListener('resize', resizeMap);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeMap);
    };
  }, []);

  // Check if we have any location data to display
  const hasHomeLocation = homeLat != null && homeLon != null && (Math.abs(homeLat) > 0.000001 || Math.abs(homeLon) > 0.000001);

  if (track.length === 0 && !hasHomeLocation) {
    return (
      <div className="h-full flex items-center justify-center bg-drone-dark">
        <p className="text-gray-500">{t('map.noGpsData')}</p>
      </div>
    );
  }

  return (
    <div
      ref={mapContainerRef}
      className="relative h-full w-full min-h-0"
      onMouseMove={(e) => {
        if (!showTooltip || !overlayRef.current || replayActive) {
          if (hoverInfo) setHoverInfo(null);
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const picked = overlayRef.current.pickObject({ x, y, radius: 12 });
        if (picked?.object?.meta) {
          const { meta } = picked.object;
          setHoverInfo({ x, y, ...meta });
        } else {
          setHoverInfo(null);
        }
      }}
      onMouseLeave={() => { if (hoverInfo) setHoverInfo(null); }}
    >
      <Map
        {...viewState}
        minZoom={10}
        maxZoom={22}
        maxPitch={is3D ? 85 : 0}
        cooperativeGestures={true}
        style={{ width: '100%', height: '100%', position: 'absolute', top: '0', right: '0', bottom: '0', left: '0' }}
        mapStyle={activeMapStyle}
        attributionControl={false}
        canvasContextAttributes={{ preserveDrawingBuffer: true }}
        ref={mapRef}
        onMove={handleMapMove}
        onSourceData={updateGroundElevation}
        onIdle={updateGroundElevation}
        onLoad={() => {
          if (is3D) {
            enableTerrain();
          }
          // Signal that map is loaded for FlyCard capture
          (window as any).__flightMapLoaded = true;
        }}
      >
        <NavigationControl position="top-right" />
        <AttributionControl position="bottom-left" compact={true} />

        {/* Map Controls */}
        <div className="map-overlay absolute top-2 left-2 z-10 bg-drone-dark/80 border border-gray-700 rounded-xl shadow-lg">
          {/* Collapsible header */}
          <button
            type="button"
            onClick={() => setMapSettingsCollapsed((v) => {
              const next = !v;
              window.sessionStorage.setItem('map:settingsCollapsed', String(next));
              return next;
            })}
            className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs text-gray-300 hover:text-white transition-colors"
          >
            <span className="font-semibold">{t('map.mapSettings')}</span>
            <span
              className={`w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center transition-transform duration-200 ${mapSettingsCollapsed ? 'rotate-180' : ''
                }`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
            </span>
          </button>

          {/* Collapsible body */}
          <div
            className={`transition-all duration-200 ease-in-out ${mapSettingsCollapsed ? 'max-h-0 overflow-hidden opacity-0' : 'max-h-[500px] overflow-visible opacity-100'
              }`}
          >
            <div className="px-3 pb-3 space-y-2">
              <ToggleRow
                label={t('map.terrain3d')}
                checked={is3D}
                onChange={setIs3D}
              />
              <ToggleRow
                label={t('map.telemetry')}
                checked={showTooltip}
                onChange={setShowTooltip}
              />
              <ToggleRow
                label={t('map.aircraft')}
                checked={showAircraft}
                onChange={setShowAircraft}
              />
              <ToggleRow
                label={t('map.media')}
                checked={showMedia}
                onChange={setShowMedia}
              />
              <ToggleRow
                label={t('map.messages')}
                checked={showMessages}
                onChange={setShowMessages}
              />
              <ToggleRow
                label="Trace path"
                checked={tracePath}
                onChange={setTracePath}
              />
              <ToggleRow
                label={t('map.simplified')}
                checked={simplified}
                onChange={setSimplified}
              />

              <div className="pt-2 border-t border-gray-600/50 flex items-center justify-between gap-3">
                <label className="text-xs text-gray-300">Mode</label>
                <div className="w-[110px]">
                  <Select
                    value={mapType}
                    onChange={(val) => setMapType(val as MapType)}
                    options={MAP_TYPE_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey as any),
                    }))}
                  />
                </div>
              </div>

              {/* Color-by dropdown — hidden when simplified mode is on (single-color path) */}
              {!simplified && (
                <div className="pt-2 border-t border-gray-600/50 flex items-center justify-between gap-3">
                  <label className="text-xs text-gray-300">Color</label>
                  <div className="w-[110px]">
                    <Select
                      value={colorBy}
                      onChange={(v) => setColorBy(v as ColorByMode)}
                      className="text-xs"
                      listMaxHeight="h-40"
                      options={COLOR_BY_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                    />
                  </div>
                </div>
              )}

              {/* Line thickness dropdown */}
              <div className="pt-2 border-t border-gray-600/50 flex items-center justify-between gap-3">
                <label className="text-xs text-gray-300">Line</label>
                <div className="w-[110px]">
                  <Select
                    value={String(lineThickness)}
                    onChange={(v) => setLineThickness(Number(v))}
                    className="text-xs"
                    options={[
                      { value: '1', label: t('map.extraThin') },
                      { value: '2', label: t('map.thin') },
                      { value: '3', label: t('map.normal') },
                      { value: '4', label: t('map.thick') },
                      { value: '5', label: t('map.extraThick') },
                    ]}
                  />
                </div>
              </div>

              {/* Reset View — mobile only (desktop has floating button) */}
              <div className="pt-1 border-t border-gray-600/50 md:hidden">
                <button
                  type="button"
                  onClick={resetView}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-drone-dark/80 hover:bg-drone-dark border border-gray-700 hover:border-gray-500 rounded-lg text-xs text-gray-300 hover:text-white transition-colors"
                  title={t('map.resetView')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                  </svg>
                  <span>{t('map.reset')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Start Marker — pulsing yellow */}
        {startPoint && (
          <Marker longitude={startPoint[0]} latitude={startPoint[1]} anchor="center">
            <div className="relative flex items-center justify-center">
              <div className="absolute w-7 h-7 bg-yellow-400/30 rounded-full animate-ping" />
              <div className="w-4 h-4 bg-yellow-400 rounded-full border-2 border-white shadow-lg z-10" />
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-semibold bg-yellow-500 text-black px-1.5 py-0.5 rounded shadow whitespace-nowrap z-10">
                {t('map.start')}
              </div>
            </div>
          </Marker>
        )}

        {/* End Marker — red with landing icon */}
        {endPoint && (
          <Marker longitude={endPoint[0]} latitude={endPoint[1]} anchor="center">
            <div className="relative flex items-center justify-center">
              <div className="w-5 h-5 bg-red-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center z-10">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 2V8M3 6L5 8L7 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-semibold bg-red-500 text-white px-1.5 py-0.5 rounded shadow whitespace-nowrap z-10">
                {t('map.end')}
              </div>
            </div>
          </Marker>
        )}

        {/* Home Marker — "H" in a circle */}
        {homeLat != null && homeLon != null && Math.abs(homeLat) > 0.000001 && (
          <Marker longitude={homeLon} latitude={homeLat} anchor="center">
            <div className="w-6 h-6 rounded-full border-2 border-white bg-sky-500 flex items-center justify-center shadow-lg">
              <span className="text-[11px] font-bold text-white leading-none">H</span>
            </div>
          </Marker>
        )}

        {/* Reset View Button — bottom right, hidden on mobile (moved to map settings) */}
        <div className="absolute bottom-3 right-3 z-10 hidden md:block">
          <button
            type="button"
            onClick={resetView}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-drone-dark/80 hover:bg-drone-dark border border-gray-700 hover:border-gray-500 rounded-lg text-xs text-gray-300 hover:text-white shadow-lg transition-all"
            title={t('map.resetView')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
            <span>{t('map.reset')}</span>
          </button>
        </div>


        {/* Simplified 2D: MapLibre native line layer — uniform width, reliable on all GPUs */}
        {simplified && !is3D && simplifiedPathGeoJSON && (
          <Source id="simplified-flight-path" type="geojson" data={simplifiedPathGeoJSON}>
            <Layer
              id="simplified-flight-path-line"
              type="line"
              paint={{
                'line-color': '#facc15',
                'line-width': lineThickness + 1,
                'line-opacity': 1,
              }}
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
            />
          </Source>
        )}

        <DeckGLOverlay
          layers={[...deckLayers, ...mediaLayers, ...replayDeckLayers]}
          pickingRadius={12}
          overlayRef={overlayRef}
        />
      </Map>

      {/* Hover tooltip — hidden during replay */}
      {hoverInfo && showTooltip && !replayActive && (
        <div
          className="pointer-events-none absolute z-50"
          style={{ left: hoverInfo.x + 12, top: hoverInfo.y - 60 }}
        >
          <div className="map-tooltip bg-gray-900/95 backdrop-blur-sm border border-gray-600/60 rounded-lg px-3 py-2 shadow-xl text-[11px] text-gray-200 space-y-0.5 min-w-[160px]">
            {durationSecs != null && durationSecs > 0 && (
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">{t('map.flightTime')}</span>
                <span className="font-medium text-white">
                  {(() => { const s = Math.round(hoverInfo.progress * durationSecs); const m = Math.floor(s / 60); return `${m}m ${s % 60}s`; })()}
                </span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">{t('map.height')}</span>
              <span className="font-medium text-white">{formatAltitude(hoverInfo.height, unitPrefs.altitude, locale)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">{t('map.speed')}</span>
              <span className="font-medium text-white">{formatSpeed(hoverInfo.speed, unitPrefs.speed, locale)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">{t('map.distHome')}</span>
              <span className="font-medium text-white">{formatDistance(hoverInfo.distance, unitPrefs.distance, locale)}</span>
            </div>
            {hoverInfo.battery != null && (
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">{t('map.batteryLabel')}</span>
                <span className={`font-medium ${hoverInfo.battery > 50 ? 'text-green-400' :
                  hoverInfo.battery > 30 ? 'text-yellow-400' :
                    hoverInfo.battery > 15 ? 'text-orange-400' : 'text-red-400'
                  }`}>{Math.round(hoverInfo.battery)}%</span>
              </div>
            )}
            <div className="border-t border-gray-700/60 mt-1 pt-1 flex justify-between gap-4">
              <span className="text-gray-500">{t('map.lat')}</span>
              <span className="text-gray-400">{hoverInfo.lat?.toFixed(6) ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">{t('map.lng')}</span>
              <span className="text-gray-400">{hoverInfo.lng?.toFixed(6) ?? '—'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Replay telemetry overlay — fixed top-right during playback */}
      {replayActive && showTooltip && replayTelemetry && (
        <div className="absolute top-2 right-12 z-20 pointer-events-none">
          <div className="map-overlay bg-drone-dark/80 backdrop-blur border border-gray-700 rounded-xl px-3.5 py-3 shadow-lg text-[11px] text-gray-200 min-w-[180px]">
            {/* Flight time */}
            {replayTelemetry.timeSecs != null && (
              <div className="flex items-center gap-2 mb-2 pb-2 border-b border-gray-700/50">
                <svg className="w-3.5 h-3.5 text-drone-accent flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span className="font-semibold text-white text-xs tabular-nums">
                  {(() => { const m = Math.floor(replayTelemetry.timeSecs! / 60); const s = replayTelemetry.timeSecs! % 60; return `${m}:${String(s).padStart(2, '0')}`; })()}
                </span>
                <span className="text-gray-500 text-[10px]">/ {formatReplayTime(1)}</span>
              </div>
            )}

            {/* Primary stats */}
            <div className="space-y-1">
              <ReplayStatRow label={t('map.height')} value={formatAltitude(replayTelemetry.height, unitPrefs.altitude, locale)} />
              <ReplayStatRow label={t('map.speed')} value={formatSpeed(replayTelemetry.speed, unitPrefs.speed, locale)} />
              <ReplayStatRow label={t('map.distHome')} value={formatDistance(replayTelemetry.distHome, unitPrefs.distance, locale)} />
            </div>

            {/* Battery */}
            {replayTelemetry.battery != null && (
              <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-gray-400">{t('map.batteryLabel')}</span>
                  <span className={`font-medium tabular-nums ${replayTelemetry.battery! < 20 ? 'text-red-400' :
                    replayTelemetry.battery! < 40 ? 'text-amber-400' : 'text-emerald-400'
                    }`}>{Math.round(replayTelemetry.battery!)}%</span>
                </div>
                {replayTelemetry.batteryVoltage != null && (
                  <ReplayStatRow label={t('map.voltage')} value={`${replayTelemetry.batteryVoltage!.toFixed(1)} V`} />
                )}
                {replayTelemetry.batteryTemp != null && (
                  <ReplayStatRow label={t('map.battTemp')} value={unitPrefs.temperature === 'imperial' ? `${(replayTelemetry.batteryTemp! * 9 / 5 + 32).toFixed(0)}°F` : `${replayTelemetry.batteryTemp!.toFixed(0)}°C`} />
                )}
              </div>
            )}

            {/* Satellites */}
            {replayTelemetry.satellites != null && (
              <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1">
                <ReplayStatRow label={t('map.satellites')} value={String(Math.round(replayTelemetry.satellites!))} />
              </div>
            )}

            {/* Attitude */}
            {(replayTelemetry.pitch != null || replayTelemetry.roll != null || replayTelemetry.yaw != null) && (
              <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1">
                {replayTelemetry.pitch != null && (
                  <ReplayStatRow label={t('map.pitch')} value={`${replayTelemetry.pitch!.toFixed(1)}°`} />
                )}
                {replayTelemetry.roll != null && (
                  <ReplayStatRow label={t('map.roll')} value={`${replayTelemetry.roll!.toFixed(1)}°`} />
                )}
                {replayTelemetry.yaw != null && (
                  <ReplayStatRow label={t('map.yaw')} value={`${replayTelemetry.yaw!.toFixed(1)}°`} />
                )}
              </div>
            )}

            {/* Coordinates */}
            {replayTelemetry.lat != null && replayTelemetry.lng != null && (
              <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-gray-500">{t('map.lat')}</span>
                  <span className="text-gray-400 tabular-nums">{replayTelemetry.lat!.toFixed(6)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-gray-500">{t('map.lng')}</span>
                  <span className="text-gray-400 tabular-nums">{replayTelemetry.lng!.toFixed(6)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Message popup — centered at top during playback */}
      {activeMessage && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none max-w-[400px]">
          <div className={`flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 shadow-lg backdrop-blur ${activeMessage.messageType === 'caution'
            ? 'bg-red-900/90 border border-red-600/60'
            : activeMessage.messageType === 'warn'
              ? 'bg-amber-900/90 border border-amber-600/60'
              : 'bg-blue-900/90 border border-blue-600/60'
            }`}>
            {activeMessage.messageType === 'caution' ? (
              <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : activeMessage.messageType === 'warn' ? (
              <svg className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className={`text-sm font-medium ${activeMessage.messageType === 'caution' ? 'text-red-100'
              : activeMessage.messageType === 'warn' ? 'text-amber-100' : 'text-blue-100'
              }`}>
              {activeMessage.message}
            </span>
          </div>
        </div>
      )}

      {/* Replay bottom controls — shared width wrapper */}
      {showAircraft && track.length > 1 ? (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex flex-col items-stretch gap-1.5 min-w-[280px] max-w-[460px] w-[90%] sm:w-auto">

          {/* RC Stick Overlay — above the playbar */}
          {replayActive && showTooltip && replayTelemetry && (replayTelemetry.rcAileron !== null || replayTelemetry.rcThrottle !== null) && (
            <div className="flex items-center justify-center gap-3 pointer-events-none mb-1">
              {/* Left Stick — Throttle (Y) + Rudder (X) */}
              <RCStickPad
                x={replayTelemetry.rcRudder ?? 0}
                y={replayTelemetry.rcThrottle ?? 0}
                label="L"
                labelPosition="bl"
                dotColor="bg-drone-accent"
                dotGlow="shadow-drone-accent/50"
              />
              {/* Right Stick — Elevator (Y) + Aileron (X) */}
              <RCStickPad
                x={replayTelemetry.rcAileron ?? 0}
                y={replayTelemetry.rcElevator ?? 0}
                label="R"
                labelPosition="br"
                dotColor="bg-drone-primary"
                dotGlow="shadow-drone-primary/50"
              />
            </div>
          )}

          {/* Flight Replay Controls — Playbar */}
          <div
            className="bg-drone-dark/90 backdrop-blur-sm border border-gray-700 rounded-xl px-3 py-2 shadow-xl flex items-center gap-3 pointer-events-auto"
          >
            {/* Play / Pause */}
            <button
              type="button"
              onClick={handlePlayPause}
              className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-drone-accent/20 text-drone-accent hover:bg-drone-accent/30 transition-colors"
              title={isPlaying ? t('map.pause') : t('map.play')}
            >
              {isPlaying ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <rect x="2" y="1" width="4" height="12" rx="1" />
                  <rect x="8" y="1" width="4" height="12" rx="1" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M3 1.5V12.5L12 7L3 1.5Z" />
                </svg>
              )}
            </button>

            {/* Time */}
            <span className="text-[11px] text-gray-400 tabular-nums flex-shrink-0 w-[36px] text-right">
              {formatReplayTime(replayProgress)}
            </span>

            {/* Seek Slider */}
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={replayProgress}
              onChange={(e) => handleReplaySeek(Number(e.target.value))}
              className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer replay-slider"
              style={{
                background: `linear-gradient(to right, rgb(var(--drone-accent)) ${replayProgress * 100}%, #4a4e69 ${replayProgress * 100}%)`,
              }}
            />

            {/* End Time */}
            <span className="text-[11px] text-gray-400 tabular-nums flex-shrink-0 w-[36px]">
              {formatReplayTime(1)}
            </span>

            {/* Speed – click to cycle (hidden on mobile) */}
            <button
              type="button"
              onClick={() => {
                const speeds = [0.5, 1, 2, 4, 8, 16];
                const idx = speeds.indexOf(replaySpeed);
                setReplaySpeed(speeds[(idx + 1) % speeds.length]);
              }}
              className="hidden md:inline-flex flex-shrink-0 text-[9px] text-gray-300 border border-gray-600 rounded px-1.5 py-px cursor-pointer text-center min-w-[32px] hover:border-gray-400 transition-colors themed-select-trigger"
              title={t('map.clickToCycleSpeed')}
            >
              {replaySpeed === 0.5 ? '½×' : `${replaySpeed}×`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReplayStatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-gray-400">{label}</span>
      <span className="font-medium text-white tabular-nums">{value}</span>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 text-xs text-gray-300 hover:text-white transition-colors"
      aria-pressed={checked}
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${checked
          ? 'bg-drone-primary/90 border-drone-primary'
          : 'bg-drone-surface border-gray-600 toggle-track-off'
          }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'
            }`}
        />
      </span>
    </button>
  );
}
