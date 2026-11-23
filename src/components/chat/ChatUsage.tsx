import { useTranslation } from 'react-i18next';
import { FiInfo } from 'react-icons/fi';
import type { ChatUsageRound } from '@/types/chat';

export function ChatUsage({ usage }: { usage: unknown }) {
  const { t, i18n } = useTranslation();
  const rounds: ChatUsageRound[] = Array.isArray(usage) ? usage.filter(v => v && typeof v === 'object') : [];
  const priced = rounds.filter(r => typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost >= 0);
  const currencies = new Set(priced.map(r => r.currency));
  const complete = rounds.length > 0 && priced.length === rounds.length && currencies.size === 1;
  const available = priced.length > 0 && currencies.size === 1;
  const total = priced.reduce((sum, round) => sum + (round.cost || 0), 0);
  const shownTotal = total > 0 && total < 0.000001 ? 0.000001 : total;
  const prefix = shownTotal !== total ? '<' : '';
  const number = prefix + new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(shownTotal);
  const cost = priced[0]?.currency === 'credits' ? t('chat.costCredits', { amount: number }) : prefix + new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(shownTotal);
  const label = !available ? t('chat.costUnavailable') : !complete ? t('chat.costPartial', { cost }) : priced.some(r => r.cost_kind === 'estimated') ? t('chat.costEstimated', { cost }) : t('chat.costReported', { cost });
  const input = rounds.reduce((sum, round) => sum + (round.input_tokens ?? round.prompt_tokens ?? 0), 0);
  const output = rounds.reduce((sum, round) => sum + (round.output_tokens ?? round.completion_tokens ?? 0), 0);
  return <details className="chat-usage">
    <summary className="chat-cost-capsule"><FiInfo aria-hidden="true" /><span>{label}</span></summary>
    <div className="chat-usage-details"><p>{t('chat.costHelp')}</p><p>{t('chat.tokenSummary', { input: new Intl.NumberFormat(i18n.language).format(input), output: new Intl.NumberFormat(i18n.language).format(output) })}</p><pre>{JSON.stringify(usage, null, 2)}</pre></div>
  </details>;
}
