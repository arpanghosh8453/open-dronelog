import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FiCheck, FiCopy, FiLink, FiLoader } from 'react-icons/fi';
import * as api from '@/lib/api';
import './mcp-settings.css';

async function copyText(value: string) {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(value); return; }
  } catch { /* HTTP deployments may require the selection-based fallback. */ }
  const previous = document.activeElement;
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input); input.select();
  try { if (!document.execCommand('copy')) throw new Error('copy'); }
  finally { input.remove(); if (previous instanceof HTMLElement) previous.focus(); }
}

export function McpSettings({ profile }: { profile: string }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<api.McpStatus | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ token: string; connection: api.McpConnection } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [client, setClient] = useState<'codex' | 'claude'>('codex');
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    mounted.current = true;
    void api.mcpOperation<api.McpStatus>(profile, 'status').then(value => {
      if (mounted.current && value.profile === profile) setStatus(value);
    }).catch(() => { if (mounted.current) setError(t('mcp.loadFailed')); });
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, [profile, t]);
  const endpoint = api.absoluteMcpEndpoint(status?.endpoint ?? null);
  const configuration = client === 'codex'
    ? `[mcp_servers.open_dronelog]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "ODL_MCP_TOKEN"`
    : JSON.stringify({ mcpServers: { open_dronelog: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer ${ODL_MCP_TOKEN}' } } } }, null, 2);
  const copy = async (key: string, value: string) => {
    try {
      await copyText(value);
      if (!mounted.current) return;
      setCopied(key); clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(''), 2000);
    } catch { if (mounted.current) setError(t('mcp.copyFailed')); }
  };
  const action = async (operation: string, payload: unknown) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (operation === 'generate') {
        const value = await api.mcpOperation<{ token: string; connection: api.McpConnection }>(profile, operation, payload);
        if (!mounted.current) return;
        if (value.connection.profile !== profile) throw new Error(t('mcp.loadFailed'));
        setFresh(value); setName('');
        const valueStatus = await api.mcpOperation<api.McpStatus>(profile, 'status');
        if (mounted.current && valueStatus.profile === profile) setStatus(valueStatus);
      } else {
        const value = await api.mcpOperation<api.McpStatus>(profile, operation, payload);
        if (!mounted.current) return;
        if (value.profile !== profile) throw new Error(t('mcp.loadFailed'));
        setStatus(value);
        if (operation === 'revoke' && fresh?.connection.id === (payload as { id: string }).id) setFresh(null);
        if (operation === 'enable' && !payload) setFresh(null);
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const copyButton = (key: string, text: string) => <button type="button" className="mcp-copy" onClick={() => void copy(key, text)} aria-label={`${t('mcp.copy')} ${key === 'endpoint' ? t('mcp.endpoint') : key === 'token' ? t('mcp.token') : t('mcp.configure')}`}>
    {copied === key ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
    {copied === key ? t('mcp.copied') : t('mcp.copy')}
  </button>;
  return <section className="mcp-settings" aria-labelledby="mcp-heading" aria-busy={busy}>
    <div className="mcp-heading">
      <h3 id="mcp-heading"><FiLink aria-hidden="true" />{t('mcp.title')}</h3>
      <span className="mcp-readonly">{t('mcp.readOnly')}</span>
    </div>
    <p>{t('mcp.description', { profile })}</p>
    {!status && !error && <p role="status" className="mcp-progress"><FiLoader className="animate-spin" aria-hidden="true" />{t('chat.loading')}</p>}
    {status?.mode === 'desktop' && <label className="mcp-enable">
      <input type="checkbox" checked={status.enabled} disabled={busy} onChange={event => void action('enable', event.target.checked)} />
      <span>{t('mcp.enable')}</span>
    </label>}
    {status?.mode === 'web' && !status.enabled && <p className="mcp-notice">{t('mcp.dockerDisabled')}</p>}
    {status?.mode === 'desktop' && <p className="mcp-help">{t('mcp.localHelp')}</p>}
    {endpoint && <div className="mcp-field">
      <label htmlFor="mcp-endpoint">{t('mcp.endpoint')}</label>
      <div className="mcp-copy-row"><input id="mcp-endpoint" value={endpoint} readOnly onFocus={event => event.target.select()} />{copyButton('endpoint', endpoint)}</div>
    </div>}
    {status?.enabled && <>
      <form className="mcp-generate" onSubmit={event => { event.preventDefault(); void action('generate', { name: name.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }); }}>
        <label htmlFor="mcp-name">{t('mcp.name')}</label>
        <div className="mcp-copy-row"><input id="mcp-name" value={name} maxLength={80} placeholder={t('mcp.namePlaceholder')} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="off" />
          <button type="submit" className="mcp-primary" aria-describedby={status.tokens.length >= 10 ? 'mcp-limit' : undefined} disabled={busy || !name.trim() || status.tokens.length >= 10}>
            {busy && <FiLoader className="animate-spin" aria-hidden="true" />}{t('mcp.generate')}
          </button>
        </div>
        {status.tokens.length >= 10 && <p id="mcp-limit" className="mcp-help">{t('mcp.limitHelp')}</p>}
      </form>
      {fresh && <div className="mcp-fresh">
        <label htmlFor="mcp-token">{t('mcp.token')}</label>
        <textarea id="mcp-token" readOnly rows={2} value={fresh.token} spellCheck={false} autoComplete="off" onFocus={event => event.target.select()} />
        <div className="mcp-token-footer"><p>{t('mcp.oneTime', { profile })}</p>{copyButton('token', fresh.token)}</div>
      </div>}
      {endpoint && <details className="mcp-config">
        <summary>{t('mcp.configure')}</summary>
        <p>{t('mcp.envHelp')}</p>
        <div className="mcp-client-picker" role="group" aria-label={t('mcp.configure')}>
          <button type="button" aria-pressed={client === 'codex'} onClick={() => setClient('codex')}>Codex</button>
          <button type="button" aria-pressed={client === 'claude'} onClick={() => setClient('claude')}>Claude Code</button>
        </div>
        <div className="mcp-code"><pre tabIndex={0}>{configuration}</pre>{copyButton('config', configuration)}</div>
      </details>}
    </>}
    {status && <div className="mcp-connections">
      <h4>{t('mcp.connections')}</h4>
      {status.tokens.length === 0 ? <p>{t('mcp.noConnections')}</p> : <ul>{status.tokens.map(connection => <li key={connection.id}>
        <div><strong>{connection.name}</strong><span>{t('mcp.expires', { date: new Date(connection.expires_at).toLocaleDateString(i18n.language) })}</span></div>
        <button type="button" className="mcp-revoke" disabled={busy} aria-label={`${t('mcp.revoke')} ${connection.name}`} onClick={() => void action('revoke', { id: connection.id })}>{t('mcp.revoke')}</button>
      </li>)}</ul>}
    </div>}
    {error && <p className="mcp-error" role="alert">{error}</p>}
    <span className="sr-only" role="status" aria-live="polite">{copied ? t('mcp.copied') : ''}</span>
  </section>;
}
