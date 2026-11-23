import { useEffect, useMemo, useRef, useState } from 'react';
import { FiArrowUpRight, FiCheck, FiDownload, FiLoader } from 'react-icons/fi';
import { exportChatCsv, exportChatReport } from './chatExport';
import { buildChatChart, presentChatChart } from './chatCharts';
import { ChatMap } from './ChatMap';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from 'react-i18next';
import type { ChatResult as Result } from '@/types/chat';
import { useFlightStore } from '@/stores/flightStore';

function cell(value: unknown, locale: string): string {
  if (value == null) return '—';
  if (typeof value === 'number') return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function ChatResult({ result, onOpenFlight }: { result: Result; onOpenFlight: (id: number, elapsedMs?: number) => void }) {
  const { t, i18n } = useTranslation();
  const sectionRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<'table' | 'chart'>(result.chart && result.rows.length ? 'chart' : 'table');
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [exportError, setExportError] = useState('');
  const getDisplaySerial = useFlightStore(state => state.getDisplaySerial);
  const hideSerialNumbers = useFlightStore(state => state.hideSerialNumbers); // Re-render masked serials when the preference changes.
  // Older saved results keep their original request, which safely identifies column semantics.
  const selections = (result.request as { select?: { alias: string; field: string; op?: string; bucket?: string }[] })?.select || [];
  const metadata = Object.fromEntries(selections.map(s => [s.alias, { ...s, op: s.op || 'value' }]));
  const meta = (column: string) => result.column_meta?.[column] || metadata[column];
  const columns = result.columns.filter(col => { const m = meta(col); return !(m && ['id', 'flight_id'].includes(m.field) && m.op === 'value' && !m.bucket); });
  const flightId = (index: number): number | null => {
    let verified = result.row_flight_ids?.[index];
    if (verified === undefined) {
      // Pre-metadata history can still identify IDs selected directly from f.id.
      // Never infer an ID from an alias, a row number, or an aggregate such as min(id).
      const identity = selections.find(s => ['id', 'flight_id'].includes(s.field) && (!s.op || s.op === 'value') && !s.bucket);
      if (identity) verified = result.rows[index]?.[identity.alias] as number | null | undefined;
    }
    return typeof verified === 'number' && Number.isSafeInteger(verified) && verified > 0 ? verified : null;
  };
  const hasFlightLinks = result.rows.some((_, index) => flightId(index) !== null);
  const header = (col: string) => {
    const field = meta(col)?.op === 'value' ? meta(col)?.field : undefined;
    const keys: Record<string, string> = { drone_model: 'report.droneModel', drone_serial: 'report.droneSerial', battery_serial: 'report.batterySerial', aircraft_name: 'report.aircraftName', drone_name: 'report.aircraftName', battery_name: 'flightList.battery', display_name: 'report.flightName', start_time: 'report.dateTime', tags: 'flightList.tags', notes: 'report.notes' };
    return field && keys[field] ? t(keys[field]) : col.replace(/_/g, ' ');
  };
  const display = (col: string, value: unknown) => {
    const field = meta(col)?.op === 'value' ? meta(col)?.field : undefined;
    if (field?.endsWith('_serial') && typeof value === 'string') return getDisplaySerial(value);
    return cell(value, i18n.language);
  };
  const renderCell = (col: string, value: unknown) => {
    const field = meta(col)?.op === 'value' ? meta(col)?.field : undefined;
    const text = display(col, value);
    if (value == null) return <span className="chat-cell-null">—</span>;
    if (field === 'tags') return <div className="chat-cell-tags">{String(value).split(',').filter(tag => tag.trim()).map((tag, index) => <span className="chat-data-capsule" title={tag.trim()} key={index}>{tag.trim()}</span>)}</div>;
    if (field?.endsWith('_serial')) return <span className="chat-data-capsule chat-serial-capsule">{text}</span>;
    if (['drone_model', 'drone_name', 'aircraft_name', 'battery_name'].includes(field || '')) return <span className="chat-data-capsule chat-equipment-capsule">{text}</span>;
    return <span className={typeof value === 'number' ? 'chat-cell-number' : field === 'display_name' ? 'chat-cell-name' : undefined}>{text}</span>;
  };
  useEffect(() => { if (exportStatus) { const timer = setTimeout(() => setExportStatus(''), 4000); return () => clearTimeout(timer); } }, [exportStatus]);
  const download = async () => {
    setExporting(true); setExportError(''); setExportStatus('');
    try {
      const title = result.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || 'flight-analysis';
      if (await exportChatCsv(`${title}.csv`, columns, result.rows)) setExportStatus(t('chat.csvSaved'));
    } catch (error) { setExportError(`${t('chat.csvFailed')} ${error instanceof Error ? error.message : String(error)}`); }
    finally { setExporting(false); }
  };
  const themeMode = useFlightStore(state => state.themeMode);
  const isLight = themeMode === 'light' || (themeMode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  const option = useMemo(() => buildChatChart(presentChatChart(result, getDisplaySerial), isLight, i18n.language, t('chat.unknown')), [result, isLight, i18n.language, t, getDisplaySerial, hideSerialNumbers]);
  const openRow = (index: number) => {
    const id = flightId(index); const elapsed = result.rows[index]?.elapsed_ms;
    if (id !== null) onOpenFlight(id, typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined);
  };
  const downloadReport = async () => {
    setExporting(true); setExportError('');
    try { if (await exportChatReport(result, sectionRef.current, getDisplaySerial, i18n.language, t('chat.openFlight'), useFlightStore.getState().activeProfile)) setExportStatus(t('chat.reportSaved')); }
    catch (error) { setExportError(`${t('chat.csvFailed')} ${error instanceof Error ? error.message : String(error)}`); }
    finally { setExporting(false); }
  };
  const pages = Math.ceil(result.rows.length / 20);
  return <section ref={sectionRef} className="chat-result" data-chat-result={result.id} aria-label={result.title}>
    <div className="chat-result-heading">
      <div><h3>{result.title}</h3><span className="chat-meta">{t('chat.rows', { count: result.rows.length })}{result.truncated ? ` · ${t('chat.limited')}` : ''}</span></div>
      <div className="chat-actions">
        {result.chart && <div className="chat-segments" aria-label={t('chat.resultView')}>
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>{t('chat.chart')}</button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>{t('chat.table')}</button>
        </div>}
        {!!result.sections?.length && <button type="button" className="chat-button" disabled={exporting} onClick={() => void downloadReport()}><FiDownload aria-hidden="true" />{t('chat.exportReport')}</button>}
        <button type="button" className="chat-button" onClick={() => void download()} disabled={exporting}>{exporting ? <FiLoader className="chat-processing-spinner" aria-hidden="true" /> : exportStatus ? <FiCheck aria-hidden="true" /> : <FiDownload aria-hidden="true" />}{t('chat.csv')}</button>
      </div>
    </div>
    {exportStatus && <p className="chat-export-status" role="status">{exportStatus}</p>}
    {exportError && <p className="chat-error chat-export-error" role="alert">{exportError}</p>}
    {view === 'chart' && result.chart && result.rows.length > 0 ? result.chart.kind === 'map' ? <ChatMap result={result} isLight={isLight} onOpenFlight={onOpenFlight} /> : <ReactECharts option={option} notMerge style={{ height: 340, width: '100%' }} opts={{ renderer: 'canvas' }} onEvents={{ click: (event: { seriesType?: string; dataIndex?: number; componentType?: string; data?: { rowIndex?: number } }) => {
      if (event.componentType === 'series' && event.data?.rowIndex !== undefined) openRow(event.data.rowIndex);
    } }} /> : <>
      {hasFlightLinks && <p className="chat-table-hint">{t('chat.openFlightHint')}</p>}
      <div className="chat-table-scroll" tabIndex={0} role="region" aria-label={t('chat.table')}>
        <table><thead><tr>{columns.map(col => <th key={col} scope="col" className={result.rows.some(row => typeof row[col] === 'number') ? 'chat-numeric-heading' : undefined}>{header(col)}</th>)}{hasFlightLinks && <th scope="col"><span className="sr-only">{t('chat.openFlight')}</span></th>}</tr></thead><tbody>
          {result.rows.slice(page * 20, (page + 1) * 20).map((row, index) => {
            const rowIndex = page * 20 + index;
            const id = flightId(rowIndex);
            return <tr key={rowIndex} className={id !== null ? 'chat-flight-row' : undefined} data-selected={selectedRow === rowIndex} tabIndex={id !== null ? 0 : undefined} title={id !== null ? t('chat.openFlightHint') : undefined}
              onClick={() => { if (id !== null) setSelectedRow(rowIndex); }}
              onDoubleClick={() => { if (id !== null) openRow(rowIndex); }}
              onKeyDown={event => { if (id !== null && event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); openRow(rowIndex); } }}>
              {columns.map(col => <td key={col} title={display(col, row[col])}>{renderCell(col, row[col])}</td>)}
              {hasFlightLinks && <td className="chat-row-action">{id !== null && <button type="button" className="chat-button chat-icon-button" aria-label={t('chat.openFlight')} title={t('chat.openFlight')} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); openRow(rowIndex); }}><FiArrowUpRight aria-hidden="true" /></button>}</td>}
            </tr>;
          })}
        </tbody></table>
        {result.rows.length === 0 && <p className="chat-table-empty">{t('chat.noRows')}</p>}
      </div>
      {pages > 1 && <div className="chat-pagination"><button className="chat-button" disabled={!page} onClick={() => setPage(p => p - 1)}>{t('chat.previous')}</button><span>{t('chat.pagination', { page: page + 1, pages })}</span><button className="chat-button" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>{t('chat.next')}</button></div>}
    </>}
    {!!result.chart?.annotations?.length && <details className="chat-query-details"><summary>{t('chat.recordedEvents', { count: result.chart.annotations.length })}</summary><ul className="chat-event-list">{result.chart.annotations.map((event, index) => <li key={index}><button className="chat-button" type="button" onClick={() => { const id = result.row_flight_ids?.find(id => id != null); if (id) onOpenFlight(id, event.x); }}>{new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(event.x / 1000)} s</button><span>{event.label}</span></li>)}</ul></details>}
    <details className="chat-query-details"><summary>{t('chat.queryDetails')}</summary><p>{result.note}</p><p>{t('chat.timezone')}: {result.timezone} · {t(`chat.sources.${result.source}`, { defaultValue: result.source })}</p><pre>{JSON.stringify(result.request, null, 2)}</pre></details>
    {!!result.sections?.length && <div className="chat-investigation-sections">{result.sections.map(section => <ChatResult key={section.id} result={section} onOpenFlight={onOpenFlight} />)}</div>}
  </section>;
}
