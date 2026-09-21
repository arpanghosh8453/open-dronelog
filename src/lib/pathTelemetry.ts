/**
 * Return the progress through the complete flight for a point on the currently
 * rendered path. The rendered path may contain only a prefix of the raw track
 * while flight replay is active.
 */
export function flightProgressForPathIndex(
  pathIndex: number,
  pathLength: number,
  visibleTrackLength: number,
  fullTrackLength: number,
): number {
  if (pathLength <= 1 || visibleTrackLength <= 1 || fullTrackLength <= 1) return 0;

  const clampedPathIndex = Math.min(Math.max(pathIndex, 0), pathLength - 1);
  const visibleProgress = clampedPathIndex / (pathLength - 1);
  const visibleFlightFraction = (visibleTrackLength - 1) / (fullTrackLength - 1);
  return Math.min(1, visibleProgress * visibleFlightFraction);
}

/** Map a complete-flight telemetry series onto the currently rendered path. */
export function mapTelemetrySeriesToPath<T>(
  series: readonly T[] | undefined,
  pathLength: number,
  visibleTrackLength: number,
  fullTrackLength: number,
): (T | null)[] {
  if (!series || series.length === 0) return new Array(pathLength).fill(null);

  return Array.from({ length: pathLength }, (_, pathIndex) => {
    const flightProgress = flightProgressForPathIndex(
      pathIndex,
      pathLength,
      visibleTrackLength,
      fullTrackLength,
    );
    const telemetryIndex = Math.round(flightProgress * (series.length - 1));
    return series[telemetryIndex] ?? null;
  });
}

/** Calculate a stable range while ignoring missing or non-finite samples. */
export function finiteValueRange(
  values: readonly (number | null | undefined)[],
  fallback = 0,
): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return min === Number.POSITIVE_INFINITY ? [fallback, fallback] : [min, max];
}
