/**
 * Compact profile selector dropdown — sits in the view toggle row.
 * Allows switching between named database profiles and creating new ones.
 * Supports password-protected profiles and master password gating.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFlightStore } from '@/stores/flightStore';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { isWebMode, hasMasterPassword, isManagerOverviewEnabled } from '@/lib/api';
import { ManagerOverview } from './ManagerOverview';

export function ProfileSelector() {
  const { t } = useTranslation();
  const {
    activeProfile,
    profiles,
    profilePasswords,
    loadProfiles,
    switchProfile,
    deleteProfile,
    logout,
  } = useFlightStore();

  const [open, setOpen] = useState(false);
  const [showNewInput, setShowNewInput] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteMasterPass, setDeleteMasterPass] = useState('');
  const [busy, setBusy] = useState(false);

  // Password prompt for switching to a protected profile
  const [passwordPrompt, setPasswordPrompt] = useState<string | null>(null);
  const [switchPassword, setSwitchPassword] = useState('');

  // Master password state
  const [masterRequired, setMasterRequired] = useState(false);
  const [masterPasswordVal, setMasterPasswordVal] = useState('');

  // Manager overview (opt-in on the server)
  const [managerEnabled, setManagerEnabled] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  // Check if master password is required (web mode only)
  useEffect(() => {
    if (isWebMode()) {
      hasMasterPassword().then(setMasterRequired).catch(() => setMasterRequired(false));
      isManagerOverviewEnabled().then(setManagerEnabled);
    }
  }, []);

  // Load profiles on mount
  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeAll();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Focus input when showing the new profile form
  useEffect(() => {
    if (showNewInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showNewInput]);

  // Focus password input when prompting
  useEffect(() => {
    if (passwordPrompt && passRef.current) {
      passRef.current.focus();
    }
  }, [passwordPrompt]);

  const closeAll = () => {
    setOpen(false);
    setShowNewInput(false);
    setNewName('');
    setNewPassword('');
    setNewPasswordConfirm('');
    setMasterPasswordVal('');
    setError(null);
    setBusy(false);
    setConfirmingDelete(null);
    setDeletePassword('');
    setDeleteMasterPass('');
    setPasswordPrompt(null);
    setSwitchPassword('');
  };

  /** Tiny inline spinner */
  const Spinner = () => (
    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );

  const validateName = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return t('profile.errorEmpty');
    if (trimmed === 'default') return t('profile.errorReserved');
    if (trimmed.length > 50) return t('profile.errorTooLong');
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return t('profile.errorInvalidChars');
    if (profiles.some(p => p.toLowerCase() === trimmed.toLowerCase())) return t('profile.errorExists');
    return null;
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    const validationError = validateName(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (newPassword && newPassword.length < 4) {
      setError(t('profile.passwordTooShort'));
      return;
    }
    if (newPassword && newPassword !== newPasswordConfirm) {
      setError(t('profile.passwordMismatch'));
      return;
    }
    if (masterRequired && !masterPasswordVal.trim()) {
      setError(t('profile.masterPasswordRequired'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await switchProfile(trimmed, {
        create: true,
        newPassword: newPassword || undefined,
        masterPassword: masterRequired ? masterPasswordVal : undefined,
      });
      closeAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSwitch = async (name: string) => {
    if (name === activeProfile) {
      setOpen(false);
      return;
    }
    if (profilePasswords[name]) {
      setPasswordPrompt(name);
      setSwitchPassword('');
      setError(null);
      return;
    }
    setOpen(false);
    try {
      await switchProfile(name);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSwitchWithPassword = async () => {
    if (!passwordPrompt) return;
    if (!switchPassword.trim()) {
      setError(t('profile.passwordRequired'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await switchProfile(passwordPrompt, { password: switchPassword });
      closeAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmingDelete(name);
    setDeletePassword('');
    setDeleteMasterPass('');
    setError(null);
  };

  const confirmDelete = async () => {
    if (!confirmingDelete) return;
    const name = confirmingDelete;
    if (profilePasswords[name] && !deletePassword.trim()) {
      setError(t('profile.passwordRequired'));
      return;
    }
    if (masterRequired && !deleteMasterPass.trim()) {
      setError(t('profile.masterPasswordRequired'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await deleteProfile(name, {
        password: profilePasswords[name] ? deletePassword : undefined,
        masterPassword: masterRequired ? deleteMasterPass : undefined,
      });
      setConfirmingDelete(null);
      setDeletePassword('');
      setDeleteMasterPass('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Display label: truncate long profile names
  const displayLabel = activeProfile === 'default'
    ? t('profile.default')
    : activeProfile.length > 10
      ? activeProfile.slice(0, 10) + '…'
      : activeProfile;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs py-1.5 px-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors max-w-[100px]"
        title={t('profile.switchProfile') + ': ' + activeProfile}
      >
        {/* User/profile icon */}
        <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        <span className="truncate">{displayLabel}</span>
        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 max-w-[calc(100vw-1rem)] bg-drone-secondary border border-gray-700 rounded-lg shadow-xl z-[100] overflow-hidden">

          {/* ── Password prompt for switching ── */}
          {passwordPrompt && !confirmingDelete && (
            <div className="p-3">
              <p className="text-xs text-gray-300 mb-2">
                {t('profile.enterPassword', { name: passwordPrompt })}
              </p>
              <PasswordInput
                ref={passRef}
                value={switchPassword}
                onChange={(e) => { setSwitchPassword(e.target.value); setError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSwitchWithPassword();
                  if (e.key === 'Escape') { setPasswordPrompt(null); setSwitchPassword(''); setError(null); }
                }}
                placeholder={t('profile.passwordPlaceholder')}
                className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
              />
              {error && <p className="text-[10px] text-red-400 mt-1 px-0.5">{error}</p>}
              <div className="flex gap-1 mt-1.5">
                <button
                  onClick={handleSwitchWithPassword}
                  disabled={busy}
                  className="flex-1 text-[10px] py-1 rounded bg-drone-primary/20 border border-drone-primary text-white hover:bg-drone-primary/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {busy ? <Spinner /> : null}
                  {t('profile.unlock')}
                </button>
                <button
                  onClick={() => { setPasswordPrompt(null); setSwitchPassword(''); setError(null); }}
                  disabled={busy}
                  className="flex-1 text-[10px] py-1 rounded border border-gray-600 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  {t('profile.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* ── Delete confirmation overlay ── */}
          {confirmingDelete && (
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-xs text-gray-200 leading-snug">
                  {t('profile.confirmDelete', { name: confirmingDelete })}
                </p>
              </div>
              {profilePasswords[confirmingDelete] && (
                <PasswordInput
                  wrapperClassName="mb-1.5"
                  value={deletePassword}
                  onChange={(e) => { setDeletePassword(e.target.value); setError(null); }}
                  placeholder={t('profile.passwordPlaceholder')}
                  className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
                />
              )}
              {masterRequired && (
                <PasswordInput
                  wrapperClassName="mb-1.5"
                  value={deleteMasterPass}
                  onChange={(e) => { setDeleteMasterPass(e.target.value); setError(null); }}
                  placeholder={t('profile.masterPasswordPlaceholder')}
                  className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
                />
              )}
              {error && <p className="text-[10px] text-red-400 mt-1 mb-1 px-0.5">{error}</p>}
              <div className="flex gap-1.5">
                <button
                  onClick={confirmDelete}
                  disabled={busy}
                  className="flex-1 text-[10px] py-1.5 rounded bg-red-600/20 border border-red-500 text-red-300 hover:bg-red-600/40 hover:text-white transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {busy ? <Spinner /> : null}
                  {t('profile.delete')}
                </button>
                <button
                  onClick={() => { setConfirmingDelete(null); setDeletePassword(''); setDeleteMasterPass(''); setError(null); }}
                  disabled={busy}
                  className="flex-1 text-[10px] py-1.5 rounded border border-gray-600 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  {t('profile.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* ── Normal dropdown content ── */}
          {!confirmingDelete && !passwordPrompt && (
            <>
          {/* Profile list */}
          <div className="max-h-48 overflow-y-auto">
            {profiles.map((name) => (
              <div
                key={name}
                onClick={() => handleSwitch(name)}
                className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer transition-colors ${
                  name === activeProfile
                    ? 'bg-drone-primary/20 text-white'
                    : 'text-gray-300 hover:bg-gray-700/50 hover:text-white'
                }`}
              >
                <span className="truncate flex-1 flex items-center gap-1">
                  {name === 'default' ? t('profile.default') : name}
                  {profilePasswords[name] && (
                    <svg className="w-2.5 h-2.5 text-amber-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </span>
                <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                  {name === activeProfile && (
                    <svg className="w-3 h-3 text-drone-primary" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                  {name !== 'default' && name !== activeProfile && (
                    <button
                      onClick={(e) => handleDelete(name, e)}
                      className="p-0.5 text-gray-500 hover:text-red-400 transition-colors"
                      title={t('profile.delete')}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Divider */}
          <div className="border-t border-gray-700" />

          {/* New profile */}
          {showNewInput ? (
            <div className="p-2">
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') closeAll();
                }}
                placeholder={t('profile.namePlaceholder')}
                className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
                maxLength={50}
              />
              <PasswordInput
                wrapperClassName="mt-1"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') closeAll();
                }}
                placeholder={t('profile.newPasswordPlaceholder')}
                className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
              />
              {newPassword && (
                <PasswordInput
                  wrapperClassName="mt-1"
                  value={newPasswordConfirm}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') closeAll();
                  }}
                  placeholder={t('profile.confirmPasswordPlaceholder')}
                  className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
                />
              )}
              {masterRequired && (
                <PasswordInput
                  wrapperClassName="mt-1"
                  value={masterPasswordVal}
                  onChange={(e) => { setMasterPasswordVal(e.target.value); setError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                  placeholder={t('profile.masterPasswordPlaceholder')}
                  className="w-full text-xs px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary"
                />
              )}
              {error && (
                <p className="text-[10px] text-red-400 mt-1 px-0.5">{error}</p>
              )}
              <div className="flex gap-1 mt-1.5">
                <button
                  onClick={handleCreate}
                  disabled={busy}
                  className="flex-1 text-[10px] py-1 rounded bg-drone-primary/20 border border-drone-primary text-white hover:bg-drone-primary/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {busy ? <Spinner /> : null}
                  {t('profile.create')}
                </button>
                <button
                  onClick={closeAll}
                  disabled={busy}
                  className="flex-1 text-[10px] py-1 rounded border border-gray-600 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  {t('profile.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowNewInput(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-white hover:bg-gray-700/50 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('profile.newProfile')}
            </button>
          )}
            </>
          )}

          {/* Manager overview */}
          {managerEnabled && (
            <div className="border-t border-gray-700/50">
              <button
                onClick={() => { closeAll(); setManagerOpen(true); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-white hover:bg-gray-700/50 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                {t('manager.menuItem')}
              </button>
            </div>
          )}

          {/* Log out */}
          <div className="border-t border-gray-700/50">
            <button
              onClick={() => { closeAll(); logout(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-red-400 hover:bg-gray-700/50 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              {t('profile.logout')}
            </button>
          </div>
        </div>
      )}
      {managerOpen && <ManagerOverview onClose={() => setManagerOpen(false)} />}
    </div>
  );
}
