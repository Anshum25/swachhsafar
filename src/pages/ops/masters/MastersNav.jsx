// Master Data navigation. Desktop (lg+): a second vertical sidebar beside the app's primary sidebar,
// rendered by the Layout only while a #/masters route is open. Phones and tablets: a compact section
// button that opens the same grouped list as a bottom sheet, so three columns are never squeezed together.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../../../app/session.jsx';
import { ChevronRightIcon, DatabaseGridIcon, XIcon } from '../../../components/Icons.jsx';
import { MASTER_GROUPS, sectionOf, visibleSections } from './sections.js';

function SectionLink({ section, on, onPick }) {
  const { key, label, hint, Icon } = section;
  return (
    <a href={`#/masters/${key}`} onClick={onPick} aria-current={on ? 'page' : undefined} data-testid={`masters-nav-${key}`}
      className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 transition duration-150 ${
        on ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-slate-50'}`}>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors ${
        on ? 'bg-brand-700 text-white shadow-[0_3px_8px_rgba(7,89,214,0.28)]' : 'bg-slate-100 text-slate-500 group-hover:bg-brand-100 group-hover:text-brand-700'}`}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13.5px] font-semibold leading-tight ${on ? 'text-brand-900' : 'text-ink'}`}>{label}</span>
        <span className="block truncate text-[11.5px] leading-snug text-muted">{hint}</span>
      </span>
      {on && <ChevronRightIcon className="h-4 w-4 shrink-0 text-brand-600" />}
    </a>
  );
}

function SectionGroups({ path, onPick }) {
  const { can } = useSession();
  const current = sectionOf(path);
  const sections = visibleSections(can);
  return (
    <nav aria-label="Master data sections" className="space-y-4">
      {MASTER_GROUPS.map((g) => {
        const items = sections.filter((s) => s.group === g);
        if (!items.length) return null;
        return (
          <div key={g}>
            <p className="mb-1.5 px-2.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-slate-400">{g}</p>
            <div className="space-y-1">{items.map((s) => <SectionLink key={s.key} section={s} on={current === s.key} onPick={onPick} />)}</div>
          </div>
        );
      })}
    </nav>
  );
}

// Desktop secondary sidebar: fixed next to the primary one (which is w-68), with its own scrolling.
export function MastersSidebar({ path }) {
  return (
    <aside className="fixed inset-y-0 left-68 z-10 hidden w-64 flex-col border-r border-line bg-white lg:flex" data-testid="masters-sidebar">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line/70 px-4 pb-4 pt-6">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-100 text-brand-700"><DatabaseGridIcon className="h-5 w-5" /></span>
        <span>
          <span className="block text-[15px] font-extrabold leading-tight text-ink">Master data</span>
          <span className="block text-[11.5px] text-muted">Configuration &amp; staff</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-6 pt-4"><SectionGroups path={path} /></div>
    </aside>
  );
}

// Phones / tablets: the current section as a compact button; tapping it opens the grouped list as a sheet.
export function MastersMobileNav({ path }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const current = visibleSections(can).find((s) => s.key === sectionOf(path));
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); html.style.overflow = prev; };
  }, [open]);
  const Icon = current?.Icon;
  return (
    <div className="mb-3 lg:hidden">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} data-testid="masters-section-button"
        className="flex w-full items-center gap-3 rounded-2xl bg-white px-3 py-2.5 text-left shadow-card ring-1 ring-line/70 active:scale-[0.99]">
        {Icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-700 text-white"><Icon className="h-[18px] w-[18px]" /></span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-tight text-ink">{current?.label ?? 'Choose a section'}</span>
          <span className="block truncate text-xs text-muted">{current?.hint ?? 'Master data'}</span>
        </span>
        <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">Sections</span>
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-brand-950/45" onClick={() => setOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="Master data sections"
            className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] animate-modal-in flex-col rounded-t-[22px] bg-white shadow-2xl">
            <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-slate-200" aria-hidden="true" />
            <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-2">
              <p className="text-[16px] font-bold text-ink">Master data</p>
              <button type="button" className="icon-btn h-10 w-10 text-ink" onClick={() => setOpen(false)} aria-label="Close sections"><XIcon className="h-5 w-5" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1">
              <SectionGroups path={path} onPick={() => setOpen(false)} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
