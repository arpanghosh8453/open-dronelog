import { isWebMode } from '@/lib/api';
import type { ChatResult } from '@/types/chat';
import { buildChatChart, presentChatChart } from './chatCharts';

/** One export path for chart/table views; native desktop saves through its filesystem API. */
export async function exportChatCsv(filename: string, columns: string[], rows: Record<string, unknown>[]): Promise<boolean> {
  const quote = (value: unknown) => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = '\uFEFF' + [columns, ...rows.map(row => columns.map(col => row[col]))].map(row => row.map(quote).join(',')).join('\r\n');
  return exportChatDocument(filename, csv, 'csv', 'text/csv;charset=utf-8');
}

export async function exportChatDocument(filename: string, text: string, extension: string, mime: string): Promise<boolean> {
  if (!isWebMode()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: filename, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

/** Standalone document with escaped evidence, regenerable charts, and no scripts or remote assets. */
export async function exportChatReport(result: ChatResult, element: HTMLElement | null, maskSerial: (value: string) => string, locale: string, openFlightLabel: string, profile = ''): Promise<boolean> {
  const escape = (v: unknown): string => String(v ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const encodeSvg = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const echarts = await import('echarts');
  const render = (r: ChatResult, depth: number): string => {
    const selections = (r.request as { select?: { alias: string; field: string; op?: string; bucket?: string }[] })?.select || [];
    const meta = (col: string) => r.column_meta?.[col] || selections.find(s => s.alias === col);
    const columns = r.columns.filter(col => { const m = meta(col); return !(m && ['id','flight_id'].includes(m.field) && (!m.op || m.op === 'value') && !m.bucket); });
    const value = (col: string, v: unknown) => { const m = meta(col); return escape(m?.field.endsWith('_serial') && typeof v === 'string' ? maskSerial(v) : typeof v === 'object' && v !== null ? JSON.stringify(v) : v); };
    let image = '';
    if (r.chart && r.rows.length) {
      if (r.chart.kind !== 'map') {
        const instance = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 380 });
        try { instance.setOption(buildChatChart(presentChatChart(r, maskSerial), true, locale, '—')); image = `<img alt="${escape(r.title)}" src="${encodeSvg(instance.renderToSVGString())}">`; } finally { instance.dispose(); }
      } else {
        const mapCanvas = element?.querySelector(`[data-chat-result="${CSS.escape(r.id)}"] .maplibregl-canvas`) as HTMLCanvasElement | null;
        if (mapCanvas) { try { image = `<img alt="${escape(r.title)}" src="${mapCanvas.toDataURL('image/png')}">`; } catch { /* Tables retain all coordinates if a browser disallows map capture. */ } }
      }
    }
    const links = r.row_flight_ids?.some(id => id != null) && ['http:','https:'].includes(window.location.protocol);
    const table = `<div class="table-scroll"><table><thead><tr>${columns.map(c => `<th>${escape(c.replace(/_/g,' '))}</th>`).join('')}${links ? `<th>${escape(openFlightLabel)}</th>` : ''}</tr></thead><tbody>${r.rows.map((row,index) => {
      let link = '';
      const id = r.row_flight_ids?.[index];
      if (links && id != null && Number.isSafeInteger(id) && id > 0) { const url = new URL(window.location.origin + window.location.pathname); url.searchParams.set('chatFlight', String(id)); url.searchParams.set('chatProfile', profile); const elapsed = row.elapsed_ms; if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) url.searchParams.set('chatTime',String(elapsed)); link = `<a href="${escape(url.href)}" rel="noreferrer">${escape(openFlightLabel)}</a>`; }
      return `<tr>${columns.map(c => `<td>${value(c,row[c])}</td>`).join('')}${links ? `<td>${link}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
    return `<section><h${Math.min(6,depth + 1)}>${escape(r.title)}</h${Math.min(6,depth + 1)}>${image}${table}<p class="method">${escape(r.note)}</p><details><summary>${escape(r.timezone)} · ${escape(r.source)} · ${r.rows.length} rows${r.truncated ? ' · LIMITED' : ''}</summary><pre>${escape(JSON.stringify(r.request,null,2))}</pre></details>${r.sections?.map(child => render(child,depth+1)).join('') || ''}</section>`;
  };
  const body = `<!doctype html><html lang="${escape(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(result.title)}</title><style>body{font:14px/1.6 system-ui,sans-serif;color:#202833;background:#fff;max-width:1100px;margin:32px auto;padding:0 24px}section{margin:28px 0}section section{border-top:1px solid #d5dde6;padding-top:12px}h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #d5dde6;padding:8px;text-align:left;vertical-align:top}th{background:#eff3f7}a{color:#315e94}.method{white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#526174}details{margin:12px 0}@media print{body{margin:0;padding:0}thead{display:table-header-group}tr,img{break-inside:avoid}.table-scroll{overflow:visible}}</style><body>${render(result,0)}</body></html>`;
  const filename = (result.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,80) || 'investigation') + '.html';
  return exportChatDocument(filename, body, 'html', 'text/html;charset=utf-8');
}
