import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatSelect } from './ChatSelect';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { chatOperation, isWebMode } from '@/lib/api';
import type { ChatConnection as Connection, ChatModel, ConnectionInput } from '@/types/chat';

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export function ChatConnection({ connection, onSaved, onClose }: { connection: Connection; onSaved: (connection: Connection, models: ChatModel[]) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ConnectionInput>({ provider: connection.provider || 'openai', base_url: connection.base_url || 'https://api.openai.com/v1', api_format: connection.api_format || 'responses', model: connection.model, pricing: connection.pricing });
  const [rates, setRates] = useState({ input: connection.pricing?.input_per_million?.toString() || '', output: connection.pricing?.output_per_million?.toString() || '', cached: connection.pricing?.cached_input_per_million?.toString() || '', write: connection.pricing?.cache_write_per_million?.toString() || '' });
  const clearRates = () => setRates({ input: '', output: '', cached: '', write: '' });
  const [key, setKey] = useState('');
  const [keyless, setKeyless] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const payload = () => ({ ...draft, pricing: rates.input !== '' && rates.output !== '' ? { input_per_million: Number(rates.input), output_per_million: Number(rates.output), cached_input_per_million: rates.cached !== '' ? Number(rates.cached) : null, cache_write_per_million: rates.write !== '' ? Number(rates.write) : null } : null, ...(keyless ? { api_key: '' } : key ? { api_key: key } : {}) });
  const run = async (action: string) => {
    setBusy(action); setError(''); setStatus('');
    try {
      if (Object.values(rates).some(value => value !== '') && (rates.input === '' || rates.output === '')) throw new Error(t('chat.completeRates'));
      if (action === 'models') { const items = await chatOperation<ChatModel[]>('models', payload()); setModels(items); setStatus(t('chat.modelsLoaded', { count: items.length })); }
      if (action === 'test') { await chatOperation('test', payload()); setStatus(t('chat.testPassed')); }
      if (action === 'save') { const saved = await chatOperation<Connection>('save_connection', payload()); setKey(''); onSaved(saved, models); }
      if (action === 'remove') { await chatOperation('remove_connection'); setKey(''); onSaved({ provider: '', base_url: '', api_format: '', model: '', has_api_key: false }, []); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  return <section className="chat-connection" aria-labelledby="chat-connection-title">
    <div className="chat-section-heading"><div><h2 id="chat-connection-title">{t('chat.connectionTitle')}</h2><p>{t('chat.connectionDescription')}</p></div><button type="button" className="chat-button" onClick={onClose} disabled={!!busy}>{t('chat.close')}</button></div>
    <form onInvalidCapture={event => { const details = (event.target as HTMLElement).closest('details'); if (details) details.open = true; }} onSubmit={e => { e.preventDefault(); void run('save'); }}>
      <fieldset disabled={!!busy}>
        <div className="chat-form-grid">
          <label>{t('chat.provider')}<ChatSelect label={t('chat.provider')} value={draft.provider} disabled={!!busy} options={[{ value: 'openai', label: 'OpenAI' }, { value: 'custom', label: t('chat.customProvider') }]} onChange={value => { const openai = value === 'openai'; setDraft({ ...draft, provider: openai ? 'openai' : 'custom', base_url: openai ? 'https://api.openai.com/v1' : '', api_format: openai ? 'responses' : 'chat_completions', model: '' }); setKey(''); clearRates(); setKeyless(false); setModels([]); setStatus(''); }} /></label>
          <label>{t('chat.baseUrl')}<input required type="url" value={draft.base_url} readOnly={draft.provider === 'openai'} placeholder="https://provider.example/v1" onChange={e => { clearRates(); setDraft({ ...draft, base_url: e.target.value }); setModels([]); setStatus(''); }} /></label>
          <div className="chat-key-field"><label htmlFor="chat-api-key">{t('chat.apiKey')}</label><PasswordInput id="chat-api-key" value={key} disabled={keyless} autoComplete="new-password" placeholder={connection.has_api_key && draft.base_url === connection.base_url ? t('chat.savedKey') : t('chat.enterKey')} onChange={e => { setKey(e.target.value); setStatus(''); }} />
            {draft.provider === 'custom' && <label className="chat-checkbox"><input type="checkbox" checked={keyless} onChange={e => { setKeyless(e.target.checked); setKey(''); }} />{t('chat.noKey')}</label>}
          </div>
          <label>{t('chat.apiFormat')}<ChatSelect label={t('chat.apiFormat')} value={draft.api_format} disabled={!!busy || draft.provider === 'openai'} options={[{ value: 'responses', label: 'Responses' }, { value: 'chat_completions', label: 'Chat Completions' }]} onChange={value => { setDraft({ ...draft, api_format: value as ConnectionInput['api_format'] }); setStatus(''); }} /></label>
          <label>{t('chat.model')}<ChatSelect label={t('chat.model')} value={draft.model} disabled={!!busy} searchable allowCustom options={models.map(model => ({ value: model.id, label: model.id }))} placeholder={t('chat.modelPlaceholder')} onChange={model => { clearRates(); setDraft({ ...draft, model }); setStatus(''); }} /></label>
        </div>
        <details className="chat-pricing-settings"><summary>{t('chat.customRates')}</summary><p className="chat-help">{t('chat.ratesHelp')}</p><div className="chat-form-grid">{(['input', 'output', 'cached', 'write'] as const).map(rate => <label key={rate}>{t(`chat.rates.${rate}`)}<input type="number" min="0" max="1000000" step="any" inputMode="decimal" value={rates[rate]} required={(rates.input !== '' || rates.output !== '' || rates.cached !== '' || rates.write !== '') && (rate === 'input' || rate === 'output')} onChange={event => setRates({ ...rates, [rate]: event.target.value })} /></label>)}</div></details>
        <p className="chat-help">{t('chat.compatibilityHelp')}</p>
        <p className="chat-help">{isWebMode() ? t('chat.serverStorage') : t('chat.desktopStorage')}</p>
        <div className="chat-connection-actions">
          <button type="button" className="chat-button" onClick={() => void run('models')} disabled={!draft.base_url}>{busy === 'models' ? t('chat.loadingModels') : t('chat.loadModels')}</button>
          <button type="button" className="chat-button" onClick={() => void run('test')} disabled={!draft.model || !draft.base_url}>{busy === 'test' ? t('chat.testing') : t('chat.testConnection')}</button>
          <button type="submit" className="chat-button chat-button-primary" disabled={!draft.model || !draft.base_url}>{busy === 'save' ? t('chat.saving') : t('chat.saveConnection')}</button>
          {connection.model && <button type="button" className="chat-button chat-remove" onClick={() => void run('remove')}>{t('chat.removeConnection')}</button>}
        </div>
        <p className="chat-help">{t('chat.testCost')}</p>
      </fieldset>
    </form>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {status && <p className="chat-status" role="status">{status}</p>}
  </section>;
}
