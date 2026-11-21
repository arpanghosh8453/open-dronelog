/**
 * HTML Report Configuration Modal
 *
 * Lets the user configure document title, pilot name,
 * and select which fields to include in the generated HTML report.
 * Checkbox state and pilot name persist across sessions via localStorage.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
    FIELD_GROUPS,
    DEFAULT_FIELD_CONFIG,
    loadFieldConfig,
    saveFieldConfig,
    type HtmlReportFieldConfig,
} from '@/lib/htmlReportBuilder';

interface HtmlReportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onGenerate: (config: {
        documentTitle: string;
        pilotName: string;
        fieldConfig: HtmlReportFieldConfig;
    }) => void;
    flightCount: number;
}

export function HtmlReportModal({ isOpen, onClose, onGenerate, flightCount }: HtmlReportModalProps) {
    const { t } = useTranslation();
    const [documentTitle, setDocumentTitle] = useState('Flight Regulation Report');
    const [pilotName, setPilotName] = useState('');
    const [fieldConfig, setFieldConfig] = useState<HtmlReportFieldConfig>(loadFieldConfig);
    const [validationError, setValidationError] = useState('');

    // Load persisted values
    useEffect(() => {
        try {
            const storedPilot = localStorage.getItem('htmlReportPilotName');
            if (storedPilot) setPilotName(storedPilot);
            const storedTitle = localStorage.getItem('htmlReportDocTitle');
            if (storedTitle) setDocumentTitle(storedTitle);
        } catch { /* ignore */ }
    }, []);

    // Save field config on change
    useEffect(() => {
        saveFieldConfig(fieldConfig);
    }, [fieldConfig]);

    // Keyboard: Escape closes
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Lock body scrollbar when open
    useEffect(() => {
        if (isOpen) {
            document.body.classList.add('modal-open');
        }
        return () => {
            document.body.classList.remove('modal-open');
        };
    }, [isOpen]);

    const toggleField = useCallback((key: keyof HtmlReportFieldConfig) => {
        setFieldConfig((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);

    const setGroupAll = useCallback((groupName: string) => {
        const group = FIELD_GROUPS.find((g) => g.name === groupName);
        if (!group) return;
        setFieldConfig((prev) => {
            const next = { ...prev };
            group.fields.forEach((f) => { next[f.key] = true; });
            return next;
        });
    }, []);

    const setGroupNone = useCallback((groupName: string) => {
        const group = FIELD_GROUPS.find((g) => g.name === groupName);
        if (!group) return;
        setFieldConfig((prev) => {
            const next = { ...prev };
            group.fields.forEach((f) => { next[f.key] = false; });
            return next;
        });
    }, []);

    const resetAll = useCallback(() => {
        setFieldConfig({ ...DEFAULT_FIELD_CONFIG });
    }, []);

    const selectAllGroups = useCallback(() => {
        setFieldConfig({ ...DEFAULT_FIELD_CONFIG });
    }, []);

    const selectNoneGroups = useCallback(() => {
        const none = { ...DEFAULT_FIELD_CONFIG };
        (Object.keys(none) as (keyof HtmlReportFieldConfig)[]).forEach((k) => { none[k] = false; });
        setFieldConfig(none);
    }, []);

    const handleGenerate = () => {
        setValidationError('');
        if (!documentTitle.trim()) {
            setValidationError(t('report.titleRequired'));
            return;
        }
        if (!pilotName.trim()) {
            setValidationError(t('report.pilotRequired'));
            return;
        }
        // Persist names
        try {
            localStorage.setItem('htmlReportPilotName', pilotName.trim());
            localStorage.setItem('htmlReportDocTitle', documentTitle.trim());
        } catch { /* ignore */ }
        onGenerate({
            documentTitle: documentTitle.trim(),
            pilotName: pilotName.trim(),
            fieldConfig,
        });
    };

    if (!isOpen) return null;

    const hasAnySelected = Object.values(fieldConfig).some(Boolean);

    return createPortal(
        <div
            className="fixed inset-0 z-[9998] flex flex-col items-center p-4 overflow-y-auto bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-drone-secondary border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col modal-mobile-max my-auto"
                style={{ maxHeight: '85vh' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-3 border-b border-gray-700 flex-shrink-0">
                    <div>
                        <h2 className="text-lg font-semibold text-white">{t('report.title')}</h2>
                        <p className="text-xs text-gray-400 mt-0.5">
                            {t('report.description', { n: flightCount })}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/30 transition-colors"
                        aria-label="Close"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Input fields — fixed, not scrollable */}
                <div className="px-6 pt-4 pb-2 flex-shrink-0 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-medium text-gray-300 mb-1">
                                {t('report.documentTitle')} <span className="text-red-400">*</span>
                            </label>
                            <input
                                type="text"
                                value={documentTitle}
                                onChange={(e) => setDocumentTitle(e.target.value)}
                                placeholder={t('report.titlePlaceholder')}
                                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-600 bg-drone-dark text-white placeholder-gray-500 focus:border-drone-primary focus:ring-1 focus:ring-drone-primary focus:outline-none transition-colors"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-300 mb-1">
                                {t('report.pilotName')} <span className="text-red-400">*</span>
                            </label>
                            <input
                                type="text"
                                value={pilotName}
                                onChange={(e) => setPilotName(e.target.value)}
                                placeholder={t('report.pilotPlaceholder')}
                                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-600 bg-drone-dark text-white placeholder-gray-500 focus:border-drone-primary focus:ring-1 focus:ring-drone-primary focus:outline-none transition-colors"
                            />
                        </div>
                    </div>

                    {/* Validation error */}
                    {validationError && (
                        <div className="text-xs text-red-400 bg-red-900/40 border border-red-700/50 rounded-lg px-3 py-2">
                            {validationError}
                        </div>
                    )}

                    {/* Global controls */}
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">{t('report.reportFields')}</span>
                        <div className="flex items-center gap-3 text-xs">
                            <button onClick={selectAllGroups} className="text-drone-primary hover:text-drone-primary font-medium transition-colors">{t('report.all')}</button>
                            <span className="text-gray-600">/</span>
                            <button onClick={selectNoneGroups} className="text-drone-primary hover:text-drone-primary font-medium transition-colors">{t('report.none')}</button>
                            <span className="text-gray-600">/</span>
                            <button onClick={resetAll} className="text-drone-primary hover:text-drone-primary font-medium transition-colors">{t('report.reset')}</button>
                        </div>
                    </div>
                </div>

                {/* Scrollable field groups section */}
                <div className="flex-1 overflow-y-scroll px-6 pb-3 min-h-0">
                    <div className="space-y-2.5">
                        {FIELD_GROUPS.map((group) => (
                            <div
                                key={group.name}
                                className="rounded-xl border border-gray-700 bg-drone-surface/50 overflow-hidden"
                            >
                                {/* Group header */}
                                <div className="flex items-center justify-between px-4 py-2 bg-drone-surface border-b border-gray-700/80">
                                    <span className="text-xs font-semibold text-gray-300">{t(`report.${group.name}`)}</span>
                                    <div className="flex items-center gap-2 text-[10px]">
                                        <button onClick={() => setGroupAll(group.name)} className="text-drone-primary hover:text-drone-primary font-medium transition-colors">{t('report.all')}</button>
                                        <span className="text-gray-600">/</span>
                                        <button onClick={() => setGroupNone(group.name)} className="text-drone-primary hover:text-drone-primary font-medium transition-colors">{t('report.none')}</button>
                                    </div>
                                </div>

                                {/* Checkboxes */}
                                <div className="px-4 py-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                                    {group.fields.map((field) => (
                                        <label
                                            key={field.key}
                                            className="flex items-center gap-2 cursor-pointer group"
                                        >
                                            <div
                                                onClick={() => toggleField(field.key)}
                                                className={`w-4 h-4 rounded flex-shrink-0 border-2 flex items-center justify-center transition-all ${fieldConfig[field.key]
                                                    ? 'bg-drone-primary border-drone-primary'
                                                    : 'border-gray-600 group-hover:border-drone-primary'
                                                    }`}
                                            >
                                                {fieldConfig[field.key] && (
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                                        <polyline points="20 6 9 17 4 12" />
                                                    </svg>
                                                )}
                                            </div>
                                            <span className="text-xs text-gray-400 group-hover:text-white transition-colors select-none">
                                                {t(`report.${field.key}`)}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-gray-700 flex-shrink-0">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-700/30 rounded-lg transition-colors"
                    >
                        {t('report.cancel')}
                    </button>
                    <button
                        onClick={handleGenerate}
                        disabled={!hasAnySelected}
                        className={`px-5 py-2 text-sm font-semibold rounded-lg transition-all flex items-center gap-2 ${hasAnySelected
                            ? 'bg-drone-primary hover:bg-drone-primary text-white shadow-md shadow-sky-500/25 hover:shadow-sky-500/40'
                            : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                            }`}
                    >
                        {t('report.generate')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
