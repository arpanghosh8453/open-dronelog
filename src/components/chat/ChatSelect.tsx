import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FiCheck, FiChevronDown } from 'react-icons/fi';

interface Option { value: string; label: string }
interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  searchable?: boolean;
  allowCustom?: boolean;
  placeholder?: string;
}

/** Profile/model menus share the application's palette; portal avoids clipping in scroll panes. */
export function ChatSelect({ value, options, onChange, label, disabled = false, searchable = false, allowCustom = false, placeholder }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value)?.label || value;
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = options.filter(option => !query || `${option.label} ${option.value}`.toLocaleLowerCase().includes(query));
    if (allowCustom && query && !options.some(option => option.value === search.trim())) {
      return [...matches, { value: search.trim(), label: t('chat.useModel', { model: search.trim() }) }];
    }
    return matches;
  }, [options, search, allowCustom, t]);
  const close = () => { setOpen(false); setSearch(''); };
  const choose = (option: Option) => { onChange(option.value); close(); input.current?.focus(); };
  const show = () => {
    if (disabled) return;
    setSearch(''); setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = Math.min(300, Math.max(below, above));
      const down = below >= Math.min(220, above);
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: down ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), width, maxHeight: down ? Math.min(300, below) : height });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => { menu.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  const current = filtered[active];
  return <div ref={anchor} className="chat-select" data-open={open}>
    <input ref={input} role="combobox" aria-label={label} title={selected || label} aria-expanded={open} aria-controls={open ? id : undefined} aria-autocomplete={searchable || allowCustom ? 'list' : 'none'} aria-activedescendant={open && current ? `${id}-${active}` : undefined} autoComplete="off" disabled={disabled} readOnly={!searchable && !allowCustom} value={open && (searchable || allowCustom) ? search : selected} placeholder={open && (searchable || allowCustom) ? t('chat.filterOptions') : placeholder || label}
      onClick={() => { if (!open) show(); }}
      onChange={event => { setSearch(event.target.value); setActive(0); setOpen(true); }}
      onBlur={event => { if (!menu.current?.contains(event.relatedTarget)) { if (open && allowCustom && search.trim()) onChange(search.trim()); close(); } }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) show();
          else setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(filtered.length, 1));
        } else if (event.key === 'Enter' || (event.key === ' ' && !searchable && !allowCustom)) {
          event.preventDefault(); if (!open) show(); else if (current) choose(current);
        } else if (open && event.key === 'Home' && !searchable && !allowCustom) { event.preventDefault(); setActive(0); }
        else if (open && event.key === 'End' && !searchable && !allowCustom) { event.preventDefault(); setActive(filtered.length - 1); }
      }} />
    <button type="button" tabIndex={-1} aria-label={label} disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => { if (open) close(); else show(); input.current?.focus(); }}><FiChevronDown aria-hidden="true" /></button>
    {open && position && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="chat-select-menu" style={position} onPointerDown={event => event.preventDefault()}>
      {filtered.length ? filtered.map((option, index) => <div id={`${id}-${index}`} role="option" aria-selected={option.value === value} key={option.value} data-highlighted={active === index} onPointerMove={event => { if (event.pointerType === 'mouse') setActive(index); }} onClick={() => choose(option)}><span>{option.label}</span>{option.value === value && <FiCheck aria-hidden="true" />}</div>) : <p role="status">{t('chat.noOptions')}</p>}
    </div>, document.body)}
  </div>;
}
