import type { TelemetryData } from '@/types';

export interface MediaPoint {
  position: [number, number, number];
  type: 'photo' | 'videoStart' | 'videoStop';
}

type MediaTelemetry = Pick<TelemetryData,
  'time' | 'latitude' | 'longitude' | 'height' | 'altitude' | 'isPhoto' | 'isVideo'>;

/** Use full-resolution telemetry so transitions retain their recorded GPS positions. */
export function getMediaPoints(telemetry: MediaTelemetry, is3D: boolean): MediaPoint[] {
  const points: MediaPoint[] = [];
  let wasPhoto = false;
  let wasVideo = false;

  for (let i = 0; i < telemetry.time.length; i++) {
    const lat = telemetry.latitude?.[i];
    const lng = telemetry.longitude?.[i];
    const height = telemetry.height?.[i] ?? telemetry.altitude?.[i] ?? 0;
    const isPhoto = telemetry.isPhoto?.[i] === true;
    // Unknown data is not a recording stop.
    const isVideo: boolean = telemetry.isVideo?.[i] ?? wasVideo;
    const validPosition = lat != null && lng != null
      && Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);

    if (validPosition) {
      const position: [number, number, number] = [lng, lat, is3D ? height : 0];
      if (isPhoto && !wasPhoto) points.push({ position, type: 'photo' });
      if (isVideo && !wasVideo) points.push({ position, type: 'videoStart' });
      if (!isVideo && wasVideo) points.push({ position, type: 'videoStop' });
    }

    // Consume transitions even without GPS rather than place them at a later location.
    wasPhoto = isPhoto;
    wasVideo = isVideo;
  }

  return points;
}
