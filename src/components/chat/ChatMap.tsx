import { useEffect, useMemo, useState } from 'react';
import Map, { AttributionControl, Layer, NavigationControl, Source } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { FiLoader } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';
import { getMapStyle, type MapType } from '@/lib/mapStyles';
import { chartSeriesColors } from '@/lib/chartTheme';
import type { ChatResult } from '@/types/chat';

export function ChatMap({ result, isLight, onOpenFlight }: { result: ChatResult; isLight: boolean; onOpenFlight: (id: number, elapsedMs?: number) => void }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => { if (!loading) return; const timeout = setTimeout(() => { setLoading(false); setFailed(true); }, 12000); return () => clearTimeout(timeout); }, [loading]);
  useEffect(() => { setLoading(true); setFailed(false); }, [result.id, isLight]);
  const [hover, setHover] = useState('');
  const geometry = useMemo(() => {
    const spec = result.chart!;
    const points = result.rows.flatMap((row, index) => {
      const lon = row[spec.x], lat = row[spec.y[0]];
      if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lon === 0 && lat === 0)) return [];
      return [{ coordinates: [lon, lat], index, id: result.row_flight_ids?.[index], group: `${result.row_flight_ids?.[index] ?? ''}:${spec.series ? String(row[spec.series] ?? '') : ''}`, elapsed: row.elapsed_ms }];
    });
    // Unwrap around the first point so an antimeridian crossing does not fit the whole world.
    const anchor = points[0]?.coordinates[0] || 0;
    for (const point of points) { while (point.coordinates[0] - anchor > 180) point.coordinates[0] -= 360; while (point.coordinates[0] - anchor < -180) point.coordinates[0] += 360; }
    const groups = [...new Set(points.map(p => p.group))];
    const features: GeoJSON.Feature[] = points.map(p => ({ type: 'Feature', properties: { index: p.index, label: String(result.rows[p.index].display_name ?? result.rows[p.index].flight ?? result.title), elapsed: p.elapsed }, geometry: { type: 'Point', coordinates: p.coordinates } }));
    if (result.source === 'telemetry') for (const group of groups) {
      const route = points.filter(p => p.group === group && p.id != null);
      if (route.length > 1) features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.map(p => p.coordinates) } });
    }
    const bounds = points.length ? [[Math.min(...points.map(p => p.coordinates[0])), Math.min(...points.map(p => p.coordinates[1]))], [Math.max(...points.map(p => p.coordinates[0])), Math.max(...points.map(p => p.coordinates[1]))]] as [[number, number], [number, number]] : undefined;
    return { points, data: { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection, bounds };
  }, [result]);
  const stored = localStorage.getItem('map:mapType');
  const mapType: MapType = ['satellite','topo','osm'].includes(stored || '') ? stored as MapType : 'default';
  if (!geometry.points.length) return <p className="chat-table-empty">{t('chat.noMapPoints')}</p>;
  return <div className={`chat-map-frame${isLight ? '' : ' chat-map-dark'}`}>
    <Map key={`${result.id}-${isLight}`} initialViewState={{ bounds: geometry.bounds, fitBoundsOptions: { padding: 42, maxZoom: 16 } }} mapStyle={getMapStyle(mapType, isLight ? 'light' : 'dark')} attributionControl={false} canvasContextAttributes={{ preserveDrawingBuffer: true }} interactiveLayerIds={['chat-points']} onLoad={() => { setLoading(false); setFailed(false); }} onError={() => { setLoading(false); setFailed(true); }} onMouseMove={e => setHover(e.features?.[0]?.properties?.label || '')} onMouseLeave={() => setHover('')} onClick={e => {
      const index = Number(e.features?.[0]?.properties?.index); const id = result.row_flight_ids?.[index];
      const elapsed = result.rows[index]?.elapsed_ms;
      if (id && Number.isSafeInteger(id)) onOpenFlight(id, typeof elapsed === 'number' ? elapsed : undefined);
    }}>
      <NavigationControl position="top-right" showCompass={false} /><AttributionControl compact />
      <Source id="chat-geometry" type="geojson" data={geometry.data}>
        <Layer id="chat-route" type="line" filter={['==', '$type', 'LineString']} paint={{ 'line-color': chartSeriesColors[0], 'line-width': 2.5 }} />
        <Layer id="chat-points" type="circle" filter={['==', '$type', 'Point']} paint={{ 'circle-color': chartSeriesColors[0], 'circle-radius': 4, 'circle-stroke-width': 1, 'circle-stroke-color': isLight ? '#ffffff' : '#181c22' }} />
      </Source>
    </Map>
    {loading && <div className="chat-map-loading" role="status"><FiLoader className="chat-processing-spinner" aria-hidden="true" />{t('chat.loading')}</div>}
    {hover && <div className="chat-map-caption">{hover}</div>}
    {failed && <p className="chat-map-warning" role="status">{t('chat.mapUnavailable')}</p>}
  </div>;
}
