/**
 * Shared export utilities for flight data
 * Used by FlightStats.tsx, FlightList.tsx, and any other components that export flight data
 */

import type { FlightDataResponse, TelemetryData } from '@/types';
import type { UnitPreferences } from './utils';
import { speedMultiplierFromMs } from './utils';

declare const __APP_VERSION__: string;

/**
 * Escape a string value for CSV output
 */
export function escapeCsv(value: string): string {
  if (value.includes('"')) value = value.replace(/"/g, '""');
  if (value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value}"`;
  }
  return value;
}

/**
 * Escape a string for XML/GPX/KML output
 */
export function escapeXml(str: string | number | null | undefined): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Compute distance to home for each telemetry point
 */
export function computeDistanceToHomeSeries(telemetry: TelemetryData): (number | null)[] {
  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];

  // Find first valid coordinate as home
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
    return telemetry.time.map(() => null);
  }

  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371000; // Earth radius in meters

  return telemetry.time.map((_, index) => {
    const lat = lats[index];
    const lng = lngs[index];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const dLat = toRad(lat - homeLat);
    const dLon = toRad(lng - homeLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(homeLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return r * c;
  });
}

/**
 * Build CSV export string from flight data
 */
export function buildCsv(data: FlightDataResponse, unitPrefs?: UnitPreferences): string {
  const { telemetry, flight } = data;

  const isDistImp = unitPrefs?.distance === 'imperial';
  const isAltImp = unitPrefs?.altitude === 'imperial';
  const speedUnit = unitPrefs?.speed ?? 'kmh';
  const isTempImp = unitPrefs?.temperature === 'imperial';

  const mToFt = 3.28084;
  const msToSpeed = speedMultiplierFromMs(speedUnit);
  const cToF = (c: number) => c * 9/5 + 32;
  const speedHeaderSuffix = speedUnit === 'mph' ? 'mph' : speedUnit === 'kmh' ? 'kmh' : speedUnit === 'fts' ? 'fts' : 'ms';

  // Build metadata JSON for the first row's metadata column
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  const metadata: Record<string, string | number | null | Array<{ tag: string; tag_type: string }> | object> = {
    format: 'Open DroneLog CSV Export',
    app_version: appVersion,
    exported_at: new Date().toISOString(),
    display_name: flight.displayName,
    drone_model: flight.droneModel,
    drone_serial: flight.droneSerial,
    aircraft_name: flight.aircraftName,
    battery_serial: flight.batterySerial,
    cycle_count: flight.cycleCount,
    rc_serial: flight.rcSerial ?? null,
    battery_life: flight.batteryLife ?? null,
    start_time: flight.startTime,
    duration_secs: flight.durationSecs,
    total_distance_m: flight.totalDistance,
    max_altitude_m: flight.maxAltitude,
    max_speed_ms: flight.maxSpeed,
    home_lat: flight.homeLat ?? null,
    home_lon: flight.homeLon ?? null,
    notes: flight.notes ?? null,
    color: flight.color ?? '#7dd3fc',
    tags: flight.tags?.map((t) => ({ tag: t.tag, tag_type: t.tagType })) ?? null,
    units: unitPrefs ? {
      distance: unitPrefs.distance,
      altitude: unitPrefs.altitude,
      speed: unitPrefs.speed,
      temperature: unitPrefs.temperature,
    } : null,
  };
  // Remove null values for cleaner JSON
  const cleanMetadata = Object.fromEntries(Object.entries(metadata).filter(([_, v]) => v != null));
  const metadataJson = JSON.stringify(cleanMetadata);

  // Build messages JSON for the first row's messages column
  const messagesJson =
    data.messages && data.messages.length > 0
      ? JSON.stringify(
          data.messages.map((m) => ({
            timestamp_ms: m.timestampMs,
            type: m.messageType,
            message: m.message,
          }))
        )
      : '';

  const headers = [
    'time_s',
    'lat',
    'lng',
    isAltImp ? 'alt_ft' : 'alt_m',
    isDistImp ? 'distance_to_home_ft' : 'distance_to_home_m',
    isAltImp ? 'height_ft' : 'height_m',
    isAltImp ? 'vps_height_ft' : 'vps_height_m',
    isAltImp ? 'altitude_ft' : 'altitude_m',
    `speed_${speedHeaderSuffix}`,
    `velocity_x_${speedHeaderSuffix}`,
    `velocity_y_${speedHeaderSuffix}`,
    `velocity_z_${speedHeaderSuffix}`,
    'battery_percent',
    'battery_voltage_v',
    isTempImp ? 'battery_temp_f' : 'battery_temp_c',
    'cell_voltages',
    'satellites',
    'rc_signal',
    'rc_uplink',
    'rc_downlink',
    'pitch_deg',
    'roll_deg',
    'yaw_deg',
    'gimbal_pitch_deg',
    'gimbal_roll_deg',
    'gimbal_yaw_deg',
    'rc_aileron',
    'rc_elevator',
    'rc_throttle',
    'rc_rudder',
    'is_photo',
    'is_video',
    'flight_mode',
    'battery_full_capacity_mah',
    'battery_remained_capacity_mah',
    'messages',
    'metadata',
  ];

  // Handle manual entries with no telemetry - create single row with home coordinates
  if (!telemetry.time || telemetry.time.length === 0) {
    const homeLat = flight.homeLat ?? '';
    const homeLon = flight.homeLon ?? '';
    
    let altVal = flight.maxAltitude != null ? flight.maxAltitude : null;
    if (altVal != null && isAltImp) altVal *= mToFt;
    
    const singleRow = [
      '0', // time_s
      String(homeLat),
      String(homeLon),
      altVal != null ? String(altVal) : '',
      '0', // distance_to_home at takeoff
      '', '', // height, vps_height
      altVal != null ? String(altVal) : '',
      '', '', '', '', // speed, velocities
      '', '', '', '', // battery_percent, battery_voltage_v, battery_temp_c, cell_voltages
      '', // satellites
      '', '', '', // rc_signal, rc_uplink, rc_downlink
      '', '', '', // pitch, roll, yaw
      '', '', '', // gimbal_pitch, gimbal_roll, gimbal_yaw
      '', '', '', '', // rc controls
      '', '', '', // is_photo, is_video, flight_mode
      '', '', // battery_full_capacity_mah, battery_remained_capacity_mah
      escapeCsv(messagesJson),
      escapeCsv(metadataJson),
    ].join(',');
    return [headers.join(','), singleRow].join('\n');
  }

  const trackAligned = data.track.length === telemetry.time.length;
  const latSeries = telemetry.latitude ?? [];
  const lngSeries = telemetry.longitude ?? [];
  const distanceToHome = computeDistanceToHomeSeries(telemetry);

  /**
   * Format a numeric value with appropriate precision for CSV export.
   * Lat/lng use full precision (DOUBLE in DB), other values use limited precision
   * since they're stored as FLOAT (7 significant digits).
   */
  const formatNum = (val: number | null | undefined, decimals: number): string => {
    if (val === null || val === undefined) return '';
    // Round to specified decimals to avoid FLOAT representation artifacts
    return Number(val.toFixed(decimals)).toString();
  };

  /** Coordinates need full precision (DOUBLE in DB) */
  const formatCoord = (val: number | null | undefined): string => {
    if (val === null || val === undefined) return '';
    return String(val); // Keep full precision for lat/lng
  };

  const getValue = (arr: (number | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : String(val);
  };

  /** Format telemetry value with appropriate precision based on field type */
  const getMetric = (arr: (number | null)[] | undefined, index: number, decimals = 2, multiplier = 1): string => {
    let val = arr?.[index];
    if (val != null) {
      val *= multiplier;
    }
    return formatNum(val, decimals);
  };

  const getBoolValue = (arr: (boolean | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : val ? '1' : '0';
  };

  const getStrValue = (arr: (string | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : val;
  };

  /** Format array of voltages with 3 decimal precision */
  const getArrayValue = (arr: (number[] | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    if (val === null || val === undefined) return '';
    // Round each voltage to 3 decimals to avoid FLOAT artifacts
    const formatted = val.map((v) => Number(v.toFixed(3)));
    return JSON.stringify(formatted);
  };

  const rows = telemetry.time.map((time, index) => {
    const track = trackAligned ? data.track[index] : null;
    const lat = track ? track[1] : latSeries[index];
    const lng = track ? track[0] : lngSeries[index];
    const alt = telemetry.altitude?.[index] ?? null;
    // telemetry.time is in seconds (converted from ms in backend)
    // Preserve sub-second resolution: 0.0, 0.1, 0.2... for 10Hz data
    const values = [
      time % 1 === 0 ? String(time) : time.toFixed(1),
      formatCoord(lat),                              // lat - full precision (DOUBLE)
      formatCoord(lng),                              // lng - full precision (DOUBLE)
      formatNum(!isAltImp ? alt : (alt != null ? alt * mToFt : null), 2),                             // alt_m
      formatNum(!isDistImp ? distanceToHome[index] : (distanceToHome[index] != null ? distanceToHome[index]! * mToFt : null), 2),           // distance_to_home_m
      // Compute unit versions on demand
      getMetric(telemetry.height, index, 2, isAltImp ? mToFt : 1),         // height_m
      getMetric(telemetry.vpsHeight, index, 2, isAltImp ? mToFt : 1),      // vps_height_m
      getMetric(telemetry.altitude, index, 2, isAltImp ? mToFt : 1),       // altitude_m
      getMetric(telemetry.speed, index, 2, msToSpeed),          // speed_<unit>
      getMetric(telemetry.velocityX, index, 2, msToSpeed),      // velocity_x_<unit>
      getMetric(telemetry.velocityY, index, 2, msToSpeed),      // velocity_y_<unit>
      getMetric(telemetry.velocityZ, index, 2, msToSpeed),      // velocity_z_<unit>
      getValue(telemetry.battery, index),            // battery_percent (integer)
      getMetric(telemetry.batteryVoltage, index, 3, 1), // battery_voltage_v
      formatNum(!isTempImp ? telemetry.batteryTemp?.[index] : (telemetry.batteryTemp?.[index] != null ? cToF(telemetry.batteryTemp[index]!) : null), 1),    // battery_temp_c
      getArrayValue(telemetry.cellVoltages, index),  // cell_voltages (JSON)
      getValue(telemetry.satellites, index),         // satellites (integer)
      getValue(telemetry.rcSignal, index),           // rc_signal (integer)
      getValue(telemetry.rcUplink, index),           // rc_uplink (integer)
      getValue(telemetry.rcDownlink, index),         // rc_downlink (integer)
      getMetric(telemetry.pitch, index, 2),          // pitch_deg
      getMetric(telemetry.roll, index, 2),           // roll_deg
      getMetric(telemetry.yaw, index, 2),            // yaw_deg
      getMetric(telemetry.gimbalPitch, index, 2),    // gimbal_pitch_deg
      getMetric(telemetry.gimbalRoll, index, 2),     // gimbal_roll_deg
      getMetric(telemetry.gimbalYaw, index, 2),      // gimbal_yaw_deg
      getMetric(telemetry.rcAileron, index, 1),      // rc_aileron
      getMetric(telemetry.rcElevator, index, 1),     // rc_elevator
      getMetric(telemetry.rcThrottle, index, 1),     // rc_throttle
      getMetric(telemetry.rcRudder, index, 1),       // rc_rudder
      getBoolValue(telemetry.isPhoto, index),
      getBoolValue(telemetry.isVideo, index),
      getStrValue(telemetry.flightMode, index),
      getMetric(telemetry.batteryFullCapacity, index, 0), // battery_full_capacity_mah
      getMetric(telemetry.batteryRemainedCapacity, index, 0), // battery_remained_capacity_mah
      // Messages and Metadata JSON only on first row (time 0)
      index === 0 ? messagesJson : '',
      index === 0 ? metadataJson : '',
    ].map(escapeCsv);
    return values.join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Build JSON export string from flight data
 */
export function buildJson(data: FlightDataResponse, unitPrefs?: UnitPreferences): string {
  const isDistImp = unitPrefs?.distance === 'imperial';
  const isAltImp = unitPrefs?.altitude === 'imperial';
  const speedUnit = unitPrefs?.speed ?? 'kmh';
  const isTempImp = unitPrefs?.temperature === 'imperial';

  const mToFt = 3.28084;
  const msToSpeed = speedMultiplierFromMs(speedUnit);
  const cToF = (c: number) => c * 9/5 + 32;

  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  
  // Clone the data to avoid mutating the original
  const flight = { ...data.flight };
  const telemetry = { ...data.telemetry };
  const track = data.track ? data.track.map(p => [...p] as [number, number, number | null]) : [];
  
  // Convert flight metadata if needed
  if (isDistImp && flight.totalDistance != null) flight.totalDistance *= mToFt;
  if (isAltImp && flight.maxAltitude != null) flight.maxAltitude *= mToFt;
  if (flight.maxSpeed != null) flight.maxSpeed *= msToSpeed;

  // Convert telemetry arrays if needed
  if (isAltImp) {
    if (telemetry.altitude) telemetry.altitude = telemetry.altitude.map(v => v != null ? v * mToFt : null);
    if (telemetry.height) telemetry.height = telemetry.height.map(v => v != null ? v * mToFt : null);
    if (telemetry.vpsHeight) telemetry.vpsHeight = telemetry.vpsHeight.map(v => v != null ? v * mToFt : null);
    for (const point of track) {
      if (point[2] != null) point[2] *= mToFt;
    }
  }
  
  if (telemetry.speed) telemetry.speed = telemetry.speed.map(v => v != null ? v * msToSpeed : null);
  if (telemetry.velocityX) telemetry.velocityX = telemetry.velocityX.map(v => v != null ? v * msToSpeed : null);
  if (telemetry.velocityY) telemetry.velocityY = telemetry.velocityY.map(v => v != null ? v * msToSpeed : null);
  if (telemetry.velocityZ) telemetry.velocityZ = telemetry.velocityZ.map(v => v != null ? v * msToSpeed : null);
  
  if (isTempImp) {
    if (telemetry.batteryTemp) telemetry.batteryTemp = telemetry.batteryTemp.map(v => v != null ? cToF(v) : null);
  }

  let distanceToHome = computeDistanceToHomeSeries(data.telemetry);
  if (isDistImp) {
    distanceToHome = distanceToHome.map(v => v != null ? v * mToFt : null);
  }

  const exportData = {
    _exportInfo: {
      format: 'Open DroneLog JSON Export',
      appVersion,
      exportedAt: new Date().toISOString(),
      units: unitPrefs ? {
        distance: unitPrefs.distance,
        altitude: unitPrefs.altitude,
        speed: unitPrefs.speed,
        temperature: unitPrefs.temperature,
      } : undefined,
    },
    flight,
    telemetry,
    track,
    messages: data.messages,
    derived: {
      distanceToHome,
    },
  };
  return JSON.stringify(exportData, null, 2);
}

/**
 * Build GPX export string from flight data
 */
export function buildGpx(data: FlightDataResponse): string {
  const { flight, telemetry, track } = data;
  const flightName = escapeXml(flight.displayName || flight.fileName || 'Flight');

  // Handle manual entries with no telemetry - create waypoint at home location
  if (!telemetry.time || telemetry.time.length === 0) {
    if (flight.homeLat != null && flight.homeLon != null) {
      const timeStr = flight.startTime ? `<time>${new Date(flight.startTime).toISOString()}</time>` : '';
      const eleStr = flight.maxAltitude != null ? `<ele>${flight.maxAltitude}</ele>` : '';
      return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Open DroneLog" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="${flight.homeLat}" lon="${flight.homeLon}">
    <name>${flightName}</name>
    ${eleStr}
    ${timeStr}
  </wpt>
</gpx>`;
    }
    // No location data at all
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Open DroneLog" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${flightName}</name>
  </metadata>
</gpx>`;
  }

  // Build trackpoints from track array
  const startTimeMs = flight.startTime ? new Date(flight.startTime).getTime() : null;

  const trackpoints = track
    .map((point, index) => {
      const [lng, lat, ele] = point;
      if (lat == null || lng == null) return '';
      const timeMs = telemetry.time[index];
      const timeStr =
        startTimeMs != null && timeMs != null
          ? `<time>${new Date(startTimeMs + timeMs * 1000).toISOString()}</time>`
          : '';
      const eleStr = ele != null ? `<ele>${ele}</ele>` : '';
      return `      <trkpt lat="${lat}" lon="${lng}">
        ${eleStr}
        ${timeStr}
      </trkpt>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Open DroneLog" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${flightName}</name>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;
}

/**
 * Build KML export string from flight data
 */
export function buildKml(data: FlightDataResponse): string {
  const { flight, telemetry } = data;
  const flightName = escapeXml(flight.displayName || flight.fileName || 'Flight');

  // Handle manual entries with no telemetry - create placemark at home location
  if (!telemetry.time || telemetry.time.length === 0) {
    if (flight.homeLat != null && flight.homeLon != null) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
    <Placemark>
      <name>${flightName}</name>
      <Point>
        <coordinates>${flight.homeLon},${flight.homeLat},${flight.maxAltitude ?? 0}</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>`;
    }
    // No location data at all
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
  </Document>
</kml>`;
  }

  // Build coordinates string using absolute altitude from telemetry
  // (track uses relative height for map visualization)
  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];
  const alts = telemetry.altitude ?? [];
  const heights = telemetry.height ?? [];
  const vpsHeights = telemetry.vpsHeight ?? [];

  const coordinates = lats
    .map((lat, i) => {
      const lng = lngs[i];
      if (lat == null || lng == null) return '';
      // Skip 0,0 points
      if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return '';
      // Use absolute altitude with fallbacks
      const ele = alts[i] ?? heights[i] ?? vpsHeights[i] ?? 0;
      return `${lng},${lat},${ele}`;
    })
    .filter(Boolean)
    .join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
    <Style id="flightPath">
      <LineStyle>
        <color>ff0080ff</color>
        <width>3</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${flightName}</name>
      <styleUrl>#flightPath</styleUrl>
      <LineString>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

/**
 * Build KML export string from flight data using relative height telemetry
 */
export function buildKmlRelative(data: FlightDataResponse): string {
  const { flight, telemetry } = data;
  const flightName = escapeXml(flight.displayName || flight.fileName || 'Flight');

  // Handle manual entries with no telemetry - create placemark at home location
  if (!telemetry.time || telemetry.time.length === 0) {
    if (flight.homeLat != null && flight.homeLon != null) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
    <Placemark>
      <name>${flightName}</name>
      <Point>
        <coordinates>${flight.homeLon},${flight.homeLat},${flight.maxAltitude ?? 0}</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>`;
    }
    // No location data at all
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
  </Document>
</kml>`;
  }

  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];
  const heights = telemetry.height ?? [];
  const vpsHeights = telemetry.vpsHeight ?? [];

  const coordinates = lats
    .map((lat, i) => {
      const lng = lngs[i];
      if (lat == null || lng == null) return '';
      // Skip 0,0 points
      if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return '';
      // Use relative height telemetry with fallback to VPS height
      const ele = heights[i] ?? vpsHeights[i] ?? 0;
      return `${lng},${lat},${ele}`;
    })
    .filter(Boolean)
    .join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
    <Style id="flightPath">
      <LineStyle>
        <color>ff0080ff</color>
        <width>3</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${flightName}</name>
      <styleUrl>#flightPath</styleUrl>
      <LineString>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}
