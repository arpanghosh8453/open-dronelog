/**
 * One-time prompt after the photo-count fix: offers to recount photos for flights imported
 * with older versions, using the photo count DJI writes into each original log.
 *
 * "Remind me later" hides it for a day on this device; "Don't ask again" is stored on the
 * server for the profile; finishing the recount marks it done there too.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFlightStore } from '@/stores/flightStore';
import { dismissPhotoRecount, getPhotoRecountStatus, runPhotoRecount } from '@/lib/api';

const REMIND_LATER_MS = 24 * 60 * 60 * 1000;
const remindKey = (profile: string) => `photoRecountRemindAfter:${profile}`;

type Phase = 'hidden' | 'ask' | 'running' | 'finished' | 'error';

export function PhotoRecountPrompt() {
  const { t } = useTranslation();
  const { activeProfile, isFlightsInitialized, needsAuth, loadFlights } = useFlightStore();

  const [phase, setPhase] = useState<Phase>('hidden');
  const [flightCount, setFlightCount] = useState(0);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [result, setResult] = useState({ updated: 0, missing: 0 });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isFlightsInitialized || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const remindAfter = Number(localStorage.getItem(remindKey(activeProfile)) || 0);
        if (Date.now() < remindAfter) return;
      } catch {
        // storage unavailable: just ask
      }
      try {
        const status = await getPhotoRecountStatus();
        if (cancelled || status.state !== 'pending') return;
        if (status.djiFlights === 0) {
          // Nothing imported with the old counting: mark done so the prompt never shows.
          await runPhotoRecount(0);
          return;
        }
        setFlightCount(status.djiFlights);
        setPhase('ask');
      } catch {
        // Older server without the endpoint, or offline: don't prompt.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfile, isFlightsInitialized, needsAuth]);

  const recount = async () => {
    setPhase('running');
    setError('');
    let offset = 0;
    let updated = 0;
    let missing = 0;
    try {
      for (;;) {
        const chunk = await runPhotoRecount(offset);
        updated += chunk.updated;
        missing += chunk.missing;
        setProgress({ processed: chunk.nextOffset, total: chunk.total });
        if (chunk.done) break;
        offset = chunk.nextOffset;
      }
      setResult({ updated, missing });
      setPhase('finished');
      await loadFlights();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const remindLater = () => {
    try {
      localStorage.setItem(remindKey(activeProfile), String(Date.now() + REMIND_LATER_MS));
    } catch {
      // storage unavailable: it will ask again next load
    }
    setPhase('hidden');
  };

  const neverAsk = async () => {
    setPhase('hidden');
    try {
      await dismissPhotoRecount();
    } catch {
      // if this fails the prompt simply returns next time
    }
  };

  if (phase === 'hidden') return null;

  const percent = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;
  const primary = 'px-3 py-1.5 text-xs rounded bg-drone-primary/20 border border-drone-primary text-white hover:bg-drone-primary/30 transition-colors disabled:opacity-50';
  const secondary = 'px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:text-white transition-colors disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm mobile-safe-container">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="photo-recount-title"
        className="w-full max-w-md bg-drone-secondary border border-gray-700 rounded-xl shadow-2xl p-5 text-gray-200"
      >
        <h2 id="photo-recount-title" className="text-base font-semibold text-white mb-2">
          {t('photoRecount.title')}
        </h2>

        {(phase === 'ask' || phase === 'error') && (
          <>
            <p className="text-sm leading-relaxed mb-2">{t('photoRecount.whatChanged')}</p>
            <p className="text-sm leading-relaxed mb-2">{t('photoRecount.offer', { count: flightCount })}</p>
            <p className="text-xs text-gray-400 leading-relaxed mb-4">{t('photoRecount.originalsNote')}</p>
            {phase === 'error' && <p className="text-xs text-red-400 mb-3">{t('photoRecount.failed', { error })}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button className={secondary} onClick={() => void neverAsk()}>{t('photoRecount.dontAsk')}</button>
              <button className={secondary} onClick={remindLater}>{t('photoRecount.later')}</button>
              <button className={primary} onClick={() => void recount()}>{t('photoRecount.recountNow')}</button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            <p className="text-sm mb-3">{t('photoRecount.running', { done: progress.processed, total: progress.total || flightCount })}</p>
            <div className="h-2 w-full rounded bg-gray-700 overflow-hidden" aria-hidden="true">
              <div className="h-full bg-drone-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
            </div>
          </>
        )}

        {phase === 'finished' && (
          <>
            <p className="text-sm leading-relaxed mb-2">{t('photoRecount.finished', { count: result.updated })}</p>
            {result.missing > 0 && (
              <p className="text-xs text-gray-400 leading-relaxed mb-2">{t('photoRecount.missing', { count: result.missing })}</p>
            )}
            <div className="flex justify-end mt-3">
              <button className={primary} onClick={() => setPhase('hidden')}>{t('photoRecount.close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
