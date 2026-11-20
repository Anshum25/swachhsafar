// Master Data navigation. Desktop (lg+): a second vertical sidebar beside the app's primary sidebar,
// rendered by the Layout only while a #/masters route is open. Phones and tablets: a "section" button that
// opens the same list in a drawer, so three columns are never squeezed onto a small screen.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../../../app/session.jsx';
import { ChevronRightIcon, XIcon } from '../../../components/Icons.jsx';
import { sectionOf, visibleSections } from './sections.js';

function SectionLinks({ path, onPick }) {
  const { can } = useSession();
  const current = sectionOf(path);
  return (
    <nav className="space-y-0.5" aria-label="Master data sections">
      {visibleSections(can).map(({ key, label, Icon }) => {
        const on = current === key;
        return (
          <a key={key} href={`#/masters/${key}`} onClick={onPick} aria-current={on ? 'page' : undefined}
            data-testid={`masters-nav-${key}`}
            className={`relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition duration-150 ${
              on ? 'bg-brand-100 text-brand-900' : 'text-ink hover:bg-brand-50'}`}>
            {on && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-brand-700" />}
            <Icon className={`h-[18px] w-[18px] shrink-0 ${on ? 'text-brand-700' : 'text-slate-500'}`} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </a>
        );
      })}
    </nav>
  );
}

// Desktop secondary sidebar: fixed next to the primary one (which is w-68), with its own scrolling.
export function MastersSidebar({ path }) {
  return (
    <aside className="fixed inset-y-0 left-68 z-10 hidden w-60 flex-col border-r border-line bg-white lg:flex" data-testid="masters-sidebar">
      <p className="shrink-0 px-5 pb-3 pt-7 text-[11px] font-bold uppercase tracking-wider text-slate-400">Master data</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6"><SectionLinks path={path} /></div>
    </aside>
  );
}

// Phones / tablets: the current section as a button; tapping it lists every section in a drawer.
export function MastersMobileNav({ path }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const current = visibleSections(can).find((s) => s.key === sectionOf(path));
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const Icon = current?.Icon;
  return (
    <div className="mb-4 lg:hidden">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} data-testid="masters-section-button"
        className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-white px-4 text-left shadow-card ring-1 ring-line/70">
        {Icon && <Icon className="h-5 w-5 shrink-0 text-brand-700" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-400">Master data</span>
          <span className="block truncate text-[15px] font-semibold text-ink">{current?.label ?? 'Choose a section'}</span>
        </span>
        <ChevronRightIcon className="h-5 w-5 shrink-0 rotate-90 text-slate-400" />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-brand-950/45" onClick={() => setOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="Master data sections"
            className="absolute inset-x-0 bottom-0 max-h-[80dvh] animate-modal-in overflow-y-auto rounded-t-[20px] bg-white px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 shadow-2xl">
            <div className="mb-1 flex items-center justify-between px-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Master data</p>
              <button type="button" className="icon-btn h-10 w-10 text-ink" onClick={() => setOpen(false)} aria-label="Close sections"><XIcon className="h-5 w-5" /></button>
            </div>
            <SectionLinks path={path} onPick={() => setOpen(false)} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
