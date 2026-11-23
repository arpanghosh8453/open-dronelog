import type { ChatResult } from '@/types/chat';
import { chartFontFamily, chartSeriesColors, getChartTheme } from '@/lib/chartTheme';

function metricAxisLabel(result: ChatResult, column: string): string {
  const selections = (result.request as { select?: { alias: string; field: string; op?: string; bucket?: string }[] })?.select || [];
  const meta = result.column_meta?.[column] || selections.find(s => s.alias === column);
  const original = meta?.field || column;
  const [field, denominator] = original.split('__per_');
  const unitOf = (field: string): string => {
    if (field === 'z_score') return 'σ';
    if (['duration_hours','hours'].includes(field)) return 'h';
    if (field === 'duration_minutes') return 'min';
    if (field === 'duration_secs') return 's';
    if (field === 'distance_km') return 'km';
    if (field === 'battery_drain_per_minute' || field === 'drain_per_min') return 'pp/min';
    if (field.endsWith('_ms')) return 'ms';
    if (field.includes('percent') || field.includes('progress_pct')) return '%';
    if (field.includes('voltage') || field.includes('cell_imbalance')) return 'V';
    if (field.includes('temp')) return '°C';
    if (field.includes('speed') || field.includes('velocity')) return 'm/s';
    if (['total_distance','max_altitude','telemetry_altitude','telemetry_height','telemetry_vps_height','telemetry_altitude_abs'].includes(field)) return 'm';
    if (field.includes('latitude') || field.includes('longitude') || /_(pitch|roll|yaw)$/.test(field)) return '°';
    if (field === 'cycle_count' || field === 'cycles') return 'cycles';
    if (field.startsWith('telemetry_') && field.endsWith('_count')) return 'samples';
    return '';
  };
  let unit = meta?.op === 'count' || meta?.op === 'count_distinct' ? (field === 'id' || field === '*' ? result.source === 'flights' ? 'flights' : 'count' : 'count') : unitOf(field);
  if (denominator) unit = `${unit || 'count'}/${denominator === 'flight_hour' ? 'h' : 'km'}`;
  const name = field === 'telemetry_timestamp_ms' || field === 'elapsed_ms' ? 'elapsed time' : field === 'telemetry_progress_pct' || field === 'progress_pct' ? 'flight progress' : field.replace(/^telemetry_/, '').replace(/_/g, ' ');
  return `${name}${meta?.bucket ? ` · ${meta.bucket.replace(/_/g, ' ')}` : ''}${unit ? ` (${unit})` : ''}`;
}

/** Numeric axes stay numeric; missing values never become fabricated zero observations. */
export function buildChatChart(result: ChatResult, isLight: boolean, _locale: string, unknown: string) {
  const spec = result.chart;
  if (!spec || spec.kind === 'map') return {};
  const theme = getChartTheme(isLight);
  const label = (v: unknown) => v == null ? unknown : String(v);
  const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const common = { color: chartSeriesColors, backgroundColor: 'transparent', textStyle: { fontFamily: chartFontFamily, color: theme.text }, animation: false, tooltip: { trigger: ['donut', 'scatter', 'boxplot', 'heatmap'].includes(spec.kind) ? 'item' : 'axis', confine: true, renderMode: 'richText', backgroundColor: theme.background, borderColor: theme.border, textStyle: { color: theme.text } }, legend: { type: 'scroll', bottom: 0, textStyle: { color: theme.label } } };
  const axis = { axisLabel: { color: theme.label, hideOverlap: true }, axisLine: { lineStyle: { color: theme.border } }, splitLine: { lineStyle: { color: theme.grid } } };
  const xLabel = metricAxisLabel(result, spec.x);
  const yLabel = [...new Set(spec.y.map(y => metricAxisLabel(result, y)))].join(' · ');
  const valueAxisName = { name: yLabel, nameLocation: 'end', nameGap: 16, nameTextStyle: { color: theme.label, align: 'left', width: 270, overflow: 'truncate', fontSize: 11 } };
  const grid = { left: 18, right: 24, top: 50, bottom: 78, containLabel: true };
  const zoom = [{ type: 'inside', filterMode: 'none' }, { type: 'slider', bottom: 30, height: 16, borderColor: theme.border, textStyle: { color: theme.label } }];
  if (spec.kind === 'donut') return { ...common, series: [{ name: yLabel, type: 'pie', radius: ['44%', '67%'], center: ['50%', '45%'], label: { color: theme.label, overflow: 'truncate', width: 100 }, data: result.rows.filter(r => numeric(r[spec.y[0]])).map(row => ({ name: label(row[spec.x]), value: row[spec.y[0]] })) }] };
  const groups = spec.series ? [...new Set(result.rows.map(row => label(row[spec.series!])))]: [''];
  const inGroup = (row: Record<string, unknown>, group: string) => !spec.series || label(row[spec.series]) === group;
  if (spec.kind === 'scatter') return { ...common, grid, xAxis: { ...axis, type: 'value', name: xLabel, nameLocation: 'middle', nameGap: 27, scale: true }, yAxis: { ...axis, ...valueAxisName, type: 'value', scale: true }, dataZoom: zoom, series: groups.flatMap(group => spec.y.map(y => ({ name: group || y, type: 'scatter', symbolSize: 8, data: result.rows.filter(r => inGroup(r, group) && numeric(r[spec.x]) && numeric(r[y])).map(r => ({ value: [r[spec.x], r[y]], rowIndex: result.rows.indexOf(r) })) }))) };
  const xs = [...new Set(result.rows.map(row => label(row[spec.x])))];
  if (spec.kind === 'boxplot') return { ...common, grid, xAxis: { ...axis, type: 'category', data: xs }, yAxis: { ...axis, ...valueAxisName, type: 'value', scale: true }, dataZoom: zoom, series: [{ name: spec.y.slice(0, 5).join(' / '), type: 'boxplot', data: xs.map(x => { const row = result.rows.find(r => label(r[spec.x]) === x)!; const values = spec.y.slice(0, 5).map(y => row[y]); return values.every(numeric) ? values : [null, null, null, null, null]; }) }, ...(spec.y[5] ? [{ name: spec.y[5], type: 'scatter', symbolSize: 10, data: xs.flatMap((x, index) => { const row = result.rows.find(r => label(r[spec.x]) === x)!; return numeric(row[spec.y[5]]) ? [[index, row[spec.y[5]]]] : []; }) }] : [])] };
  if (spec.kind === 'heatmap') {
    const ys = [...new Set(result.rows.map(row => label(row[spec.series!])))];
    const values = result.rows.filter(r => numeric(r[spec.y[0]])).map(r => r[spec.y[0]] as number);
    const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
    return { ...common, legend: undefined, title: { text: metricAxisLabel(result, spec.y[0]), left: 18, top: 8, textStyle: { color: theme.label, fontSize: 11, fontWeight: 'normal', width: 270, overflow: 'truncate' } }, grid, xAxis: { ...axis, type: 'category', data: xs }, yAxis: { ...axis, type: 'category', data: ys }, visualMap: { min, max: max === min ? min + 1 : max, calculable: true, orient: 'horizontal', bottom: 0, left: 'center', textStyle: { color: theme.label }, inRange: { color: isLight ? ['#e8eef6', chartSeriesColors[0]] : ['#26313e', chartSeriesColors[0]] } }, series: [{ name: spec.y[0], type: 'heatmap', data: result.rows.filter(r => numeric(r[spec.y[0]])).map(r => [xs.indexOf(label(r[spec.x])), ys.indexOf(label(r[spec.series!])), r[spec.y[0]]]) }] };
  }
  const numericX = spec.kind === 'timeline' || (spec.kind === 'line' && result.rows.some(r => numeric(r[spec.x])));
  const xValue = (row: Record<string, unknown>) => numericX ? row[spec.x] : xs.indexOf(label(row[spec.x]));
  const ordered = numericX ? [...result.rows].sort((a,b) => Number(a[spec.x]) - Number(b[spec.x])) : result.rows;
  const series: Record<string, unknown>[] = groups.flatMap(group => spec.y.map(y => ({
    name: group ? `${group}${spec.y.length > 1 ? ` · ${y}` : ''}` : y,
    type: spec.kind === 'timeline' ? 'line' : spec.kind, connectNulls: false, showSymbol: result.rows.length < 40, barMaxWidth: 44,
    lineStyle: spec.band && [spec.band.lower, spec.band.upper].includes(y) ? { width: 1, type: 'dashed', opacity: 0.65 } : { width: 2 },
    data: numericX ? ordered.filter(r => inGroup(r, group) && numeric(r[spec.x])).map(r => ({ value: [r[spec.x], numeric(r[y]) ? r[y] : null], rowIndex: result.rows.indexOf(r) })) : xs.map(x => { const row = result.rows.find(r => label(r[spec.x]) === x && inGroup(r, group)); return row?.[y] ?? null; }),
  })));
  if (spec.annotations?.length && series.length) series[0].markLine = { symbol: 'none', silent: false, lineStyle: { color: theme.label, type: 'dashed', opacity: 0.65 }, label: { show: false }, data: spec.annotations.map(a => ({ xAxis: a.x, name: a.label, tooltip: { formatter: () => a.label, renderMode: 'richText' } })) };
  if (spec.band && !spec.series) {
    const band = spec.band;
    const data = ordered.slice(1).flatMap((r, i) => { const prev = ordered[i]; return [prev[band.lower], prev[band.upper], r[band.lower], r[band.upper]].every(numeric) ? [[xValue(prev), prev[band.lower], prev[band.upper], xValue(r), r[band.lower], r[band.upper]]] : []; });
    series.unshift({ type: 'custom', silent: true, tooltip: { show: false }, z: 0, data,
      renderItem: (_params: unknown, api: { value: (i: number) => number; coord: (v: number[]) => number[] }) => ({ type: 'polygon', shape: { points: [[0,1],[0,2],[3,5],[3,4]].map(([x,y]) => api.coord([api.value(x),api.value(y)])) }, style: { fill: chartSeriesColors[0], opacity: 0.14 } }),
    });
  }
  return { ...common, grid, xAxis: { ...axis, type: numericX ? 'value' : 'category', ...(numericX ? { name: xLabel, nameLocation: 'middle', nameGap: 25 } : { data: xs }) }, yAxis: { ...axis, ...valueAxisName, type: 'value', scale: true }, dataZoom: result.rows.length > 12 ? zoom : [], series, aria: { enabled: true, description: `${result.title}. ${result.note}`, decal: { show: false } } };
}

/** Give hidden serial categories distinct pseudonyms so masking cannot merge analytical groups. */
export function presentChatChart(result: ChatResult, mask: (value: string) => string): ChatResult {
  const selections = (result.request as { select?: { alias: string; field: string; op?: string }[] })?.select || [];
  const meta = (col: string) => result.column_meta?.[col] || selections.find(s => s.alias === col);
  const serials = new Map<string, string>();
  for (const row of result.rows) for (const col of result.columns) {
    const m = meta(col); const value = row[col];
    if (m?.field.endsWith('_serial') && (!m.op || m.op === 'value') && typeof value === 'string' && mask(value) !== value && !serials.has(value)) serials.set(value, `${mask(value)} ${serials.size + 1}`);
  }
  if (!serials.size) return result;
  return { ...result, rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([col,value]) => { const m=meta(col); return [col,typeof value === 'string' && m && (!m.op || m.op === 'value') && (m.field.endsWith('_serial') || ['battery_name','drone_name'].includes(m.field)) ? serials.get(value) || value : value]; }))) };
}
