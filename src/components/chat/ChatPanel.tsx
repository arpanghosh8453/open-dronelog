import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FiArrowUp, FiMenu, FiMessageSquare, FiPlus, FiLoader, FiSettings, FiSquare, FiTrash2 } from 'react-icons/fi';
import { chatOperation, streamChat } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';
import type { ChatConnection as Connection, ChatConversation, ChatEvent, ChatMessage, ChatModel, ConversationSummary } from '@/types/chat';
import { ChatConnection } from './ChatConnection';
import { ChatSelect } from './ChatSelect';
import { ChatResult } from './ChatResult';
import { ChatUsage } from './ChatUsage';
import odlLogo from '@/assets/icon.png';
import './chat.css';

const emptyConnection: Connection = { provider: '', base_url: '', api_format: '', model: '', has_api_key: false };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function ChatPanel({ onOpenSidebar, onOpenFlight }: { onOpenSidebar: () => void; onOpenFlight: (id: number, elapsedMs?: number) => void }) {
  const { t, i18n } = useTranslation();
  const profile = useFlightStore(state => state.activeProfile);
  const unitPrefs = useFlightStore(state => state.unitPrefs);
  const [connection, setConnection] = useState<Connection>(emptyConnection);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showConnection, setShowConnection] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [follow, setFollow] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    Promise.all([chatOperation<Connection>('connection'), chatOperation<ConversationSummary[]>('list')]).then(([c, list]) => {
      if (cancelled) return;
      setConnection(c); setThreads(list); setShowConnection(!c.model || new URLSearchParams(window.location.search).get('connection') === '1');
      const linkedId = new URLSearchParams(window.location.search).get('chat');
      if (linkedId && list.some(item => item.id === linkedId)) {
        void chatOperation<ChatConversation>('conversation', { id: linkedId }).then(thread => {
          if (!cancelled) { setThreadId(thread.id); setMessages(thread.messages); }
        }).catch(e => { if (!cancelled) setError(errorText(e)); });
      }
      if (c.model) void chatOperation<ChatModel[]>('models').then(items => { if (!cancelled) setModels(items); }).catch(() => {});
    }).catch(e => { if (!cancelled) setError(errorText(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; alive.current = false; controller.current?.abort(); };
  }, [profile]);
  useEffect(() => {
    if (follow && content.current) content.current.scrollTop = content.current.scrollHeight;
  }, [messages, status, follow]);
  const refreshThreads = async () => {
    const list = await chatOperation<ConversationSummary[]>('list');
    if (alive.current) setThreads(list);
  };
  const loadThread = async (id: string) => {
    setError(''); setConfirmDelete(false);
    if (!id) { const url = new URL(window.location.href); url.searchParams.delete('chat'); window.history.replaceState(null, '', url); setThreadId(null); setMessages([]); setDraft(''); return; }
    setLoading(true);
    try { const c = await chatOperation<ChatConversation>('conversation', { id }); if (alive.current) { setThreadId(c.id); setMessages(c.messages); setFollow(true); const url = new URL(window.location.href); url.searchParams.set('chat', c.id); window.history.replaceState(null, '', url); } }
    catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setLoading(false); }
  };
  const updateSettings = async (patch: Partial<Connection>) => {
    setSaving(true); setError('');
    try { const { has_api_key: _hasKey, ...settings } = { ...connection, ...patch }; const c = await chatOperation<Connection>('save_connection', settings); if (alive.current) setConnection(c); }
    catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setSaving(false); }
  };
  const updateAssistant = (change: (message: ChatMessage) => ChatMessage) => {
    setMessages(previous => { if (!previous.length || previous[previous.length - 1].role !== 'assistant') return previous; return [...previous.slice(0, -1), change(previous[previous.length - 1])]; });
  };
  const send = async (text = draft) => {
    text = text.trim();
    if (!text || sending || loading || !connection.model) return;
    if (new TextEncoder().encode(text).length > 12_000) { setError(t('chat.messageTooLong')); return; }
    setDraft(''); setError(''); setSending(true); setStatus(t('chat.thinking')); setFollow(true); setShowConnection(false);
    const abort = new AbortController(); controller.current = abort;
    setMessages(old => [...old, { role: 'user', text, results: [] }, { role: 'assistant', text: '', results: [] }]);
    let currentId = threadId;
    let receivedError = false;
    const handleEvent = (event: ChatEvent) => {
      if (!alive.current || abort.signal.aborted) return;
      switch (event.type) {
        case 'conversation': { const url = new URL(window.location.href); url.searchParams.set('chat', event.id); window.history.replaceState(null, '', url); } currentId = event.id; setThreadId(event.id); setThreads(previous => previous.some(item => item.id === event.id) ? previous : [{ id: event.id, title: event.title, updated_at: new Date().toISOString() }, ...previous]); break;
        case 'text_delta': setStatus(t('chat.responding')); updateAssistant(m => ({ ...m, text: m.text + event.text })); break;
        case 'tool_started': setStatus(t(`chat.tools.${event.name}`, { defaultValue: t('chat.analyzing') })); break;
        case 'result': updateAssistant(m => ({ ...m, results: [...m.results, event.result] })); break;
        case 'usage': updateAssistant(m => ({ ...m, usage: [...(Array.isArray(m.usage) ? m.usage : []), event.usage] })); break;
        case 'error': receivedError = true; setError(event.message); break;
        case 'completed': setStatus(''); break;
      }
    };
    try {
      await streamChat({ request_id: crypto.randomUUID(), conversation_id: threadId, message: text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', unit_system: JSON.stringify({ ...unitPrefs, responseLanguage: i18n.resolvedLanguage || i18n.language }) }, handleEvent, abort.signal);
    } catch (e) {
      if (alive.current) {
        if (abort.signal.aborted) updateAssistant(m => ({ ...m, text: m.text || t('chat.stopped'), usage: [...(Array.isArray(m.usage) ? m.usage : []), { cost: null, cost_kind: 'unavailable' }] }));
        else { receivedError = true; setError(errorText(e)); }
      }
    } finally {
      if (alive.current) {
        setStatus(''); controller.current = null;
        if (currentId) {
          // Reload canonical persisted messages after completion. Stop may still be persisting.
          if (!abort.signal.aborted) {
            try { const c = await chatOperation<ChatConversation>('conversation', { id: currentId }); if (alive.current) setMessages(c.messages); } catch { /* Keep received content if a reload fails. */ }
          }
          void refreshThreads().catch(() => {});
        } else if (receivedError) {
          updateAssistant(m => ({ ...m, text: m.text || t('chat.failed') }));
        }
        if (alive.current) { setSending(false); input.current?.focus(); }
      }
    }
  };
  const removeThread = async () => {
    if (!threadId) return;
    setLoading(true);
    try { await chatOperation('delete', { id: threadId }); setThreadId(null); setMessages([]); setConfirmDelete(false); await refreshThreads(); }
    catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  };
  const examples = ['exampleCompare', 'exampleFind', 'exampleDistribution', 'exampleGuide'];
  return <div className="chat-panel" aria-label={t('chat.title')}>
    <header className="chat-header">
      <button type="button" className="chat-button chat-nav" onClick={onOpenSidebar} aria-label={t('chat.openSidebar')} title={t('chat.openSidebar')}><FiMenu aria-hidden="true" /></button>
      <div className="chat-title"><FiMessageSquare aria-hidden="true" /><div><h1>{t('chat.title')}</h1><p>{t('chat.profileContext', { profile })}</p></div></div>
      <div className="chat-actions">
        <button type="button" className="chat-button" onClick={() => setShowConnection(v => !v)} disabled={sending || saving || loading} aria-expanded={showConnection}><FiSettings aria-hidden="true" /><span>{t('chat.connection')}</span></button>
        <button type="button" className="chat-button" disabled={sending || loading} onClick={() => void loadThread('')}><FiPlus aria-hidden="true" /><span>{t('chat.newChat')}</span></button>
      </div>
    </header>
    <div className="chat-toolbar">
      <div className="chat-thread-select"><ChatSelect label={t('chat.conversations')} value={threadId || ''} disabled={sending || loading} searchable options={[{ value: '', label: t('chat.newConversation') }, ...threads.map(thread => ({ value: thread.id, label: thread.title }))]} onChange={id => void loadThread(id)} /></div>
      {connection.model && <>
        <div className="chat-model-select"><ChatSelect label={t('chat.model')} value={connection.model} disabled={sending || saving} searchable options={[...(!models.some(m => m.id === connection.model) ? [{ value: connection.model, label: connection.model }] : []), ...models.map(model => ({ value: model.id, label: model.id }))]} onChange={model => void updateSettings({ model, pricing: null })} /></div>
      </>}
      {threadId && <button type="button" className="chat-button chat-icon-button" title={t('chat.deleteConversation')} aria-label={t('chat.deleteConversation')} disabled={sending || loading} onClick={() => setConfirmDelete(true)}><FiTrash2 aria-hidden="true" /></button>}
    </div>
    {confirmDelete && <div className="chat-delete-confirm" role="alert"><span>{t('chat.confirmDelete')}</span><button className="chat-button" onClick={() => setConfirmDelete(false)}>{t('chat.cancel')}</button><button className="chat-button" onClick={() => void removeThread()}>{t('chat.delete')}</button></div>}
    <div ref={content} className="chat-content" onScroll={e => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}>
      <div className="chat-content-inner">
        {showConnection && <ChatConnection key={`${connection.provider}:${connection.base_url}:${connection.model}`} connection={connection} onClose={() => setShowConnection(false)} onSaved={(c, items) => { setConnection(c); setModels(items); setShowConnection(!c.model); setError(''); }} />}
        {loading && <p className="chat-loading" role="status">{t('chat.loading')}</p>}
        {!loading && !messages.length && !showConnection && <div className="chat-empty">
          <h2>{t('chat.emptyTitle')}</h2><p>{t('chat.emptyDescription')}</p>
          {!connection.model ? <button className="chat-button chat-button-primary" onClick={() => setShowConnection(true)}>{t('chat.configure')}</button> : <div className="chat-examples">{examples.map(key => <button type="button" key={key} onClick={() => { setDraft(t(`chat.${key}`)); input.current?.focus(); }}>{t(`chat.${key}`)}</button>)}</div>}
          <p className="chat-help">{t('chat.readOnlyHelp')}</p>
        </div>}
        <div className="chat-messages" aria-busy={sending}>
          {messages.map((message, index) => <article key={index} className={`chat-message chat-message-${message.role}`} aria-label={message.role === 'user' ? t('chat.you') : t('chat.assistant')}>
            <div className="chat-message-label">{message.role === 'assistant' && <span className="chat-assistant-avatar" aria-hidden="true"><img src={odlLogo} alt="" /></span>}{message.role === 'user' ? t('chat.you') : t('chat.assistant')}</div>
            {message.text && (message.role === 'user' ? <p className="chat-user-text">{message.text}</p> : <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: () => null }}>{message.text}</ReactMarkdown></div>)}
            {message.results.map(result => <ChatResult key={result.id} result={result} onOpenFlight={onOpenFlight} />)}
            {message.role === 'assistant' && index === messages.length - 1 && sending && <p className="chat-progress" role="status" aria-live="polite"><FiLoader className="chat-processing-spinner" aria-hidden="true" /><span>{status || t('chat.responding')}</span></p>}
            {message.role === 'assistant' && !(sending && index === messages.length - 1) && <ChatUsage usage={message.usage} />}
          </article>)}
        </div>
      </div>
    </div>
    {error && <div className="chat-error chat-runtime-error" role="alert">{error}<button type="button" className="chat-button" onClick={() => setError('')}>{t('chat.dismiss')}</button></div>}
    <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      <div className="chat-compose-row"><textarea ref={input} rows={2} aria-label={t('chat.message')} value={draft} maxLength={12000} disabled={!connection.model || loading} placeholder={connection.model ? t('chat.placeholder') : t('chat.configureFirst')} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!sending) void send(); } }} />
        {sending ? <button type="button" className="chat-send" onClick={() => controller.current?.abort()} aria-label={t('chat.stop')} title={t('chat.stop')}><FiSquare /></button> : <button type="submit" className="chat-send" disabled={!draft.trim() || !connection.model || loading || saving} aria-label={t('chat.send')} title={t('chat.send')}><FiArrowUp /></button>}
      </div>
      <p>{t('chat.dataDisclosure')}</p>
    </form>
  </div>;
}
