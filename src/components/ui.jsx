// Reusable building blocks for the operational screens: page headers, cards, tables, dialogs,
// form fields and the loading / empty / error / offline / sync states every data view needs.
import { isBlank } from '../utils/blank.js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertIcon, ArrowLeftIcon, InfoIcon, MoreIcon, Spinner, XIcon } from './Icons.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';

// The layout's top bar has a slot (see Layout) into which each screen's PageHeader renders its bar:
// back arrow on the left, the title centred. Without the slot (outside the layout) it renders in place.
export const BarSlotContext = createContext(null);

// `back`: where the arrow goes (a '#/…' href; default home). false hides it. `subtitle` and `actions`
// render under the bar, in the page.
export function PageHeader({ title, subtitle, actions, back = '#/', barAction }) {
  const slot = useContext(BarSlotContext);
  const bar = (
    <div className="grid min-h-14 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center px-1.5 sm:px-3" data-testid="topbar-main">
      {back ? (
        <a href={back} className="icon-btn" aria-label="Back"><ArrowLeftIcon className="h-6 w-6" /></a>
      ) : <span aria-hidden="true" />}
      <h1 className="truncate text-center text-[19px] font-bold tracking-tight text-ink">{title}</h1>
      <span className="flex justify-end">{barAction}</span>
    </div>
  );
  return (
    <>
      {slot ? createPortal(bar, slot) : bar}
      {(subtitle || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {subtitle ? <p className="min-w-0 text-sm font-medium text-muted">{subtitle}</p> : <span />}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
    </>
  );
}

export function Panel({ title, actions, children, className = '' }) {
  return (
    <section className={`card sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="min-w-0 text-[15px] font-bold text-ink">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'brand' }) {
  const tones = { brand: 'text-brand-700', amber: 'text-amber-600', red: 'text-red-600', slate: 'text-slate-700' };
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone]}`}>{value ?? '—'}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const BADGE = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
  brand: 'bg-brand-50 text-brand-800 ring-brand-200',
};

export function Badge({ tone = 'slate', children }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${BADGE[tone]}`}>{children}</span>;
}

export const STATE_TONE = {
  active: 'green', scheduled: 'brand', history: 'slate', cancelled: 'red',
  created: 'amber', in_process: 'brand', forwarded: 'amber', completed: 'green',
  pending: 'amber', verified: 'green', rejected: 'red', draft: 'amber', void: 'red',
  issue: 'brand', return: 'slate',
};

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm font-medium text-muted" role="status">
      <Spinner className="h-5 w-5 text-brand-600" /> {label}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="rounded-2xl border border-dashed border-brand-200 bg-white/60 px-4 py-10 text-center">
      <span className="mx-auto mb-2 grid h-11 w-11 place-items-center rounded-full bg-brand-100 text-brand-700"><InfoIcon className="h-5 w-5" /></span>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  const unavailable = error.code === 'endpoint_unavailable';
  const conflict = error.code === 'version_conflict';
  const heading = unavailable ? 'Backend endpoint unavailable' : conflict ? 'Changed by someone else'
    : error.status === 0 ? 'Offline' : 'Request failed';
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-200" role="alert">
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">{heading}</p>
        <p>{error.message}</p>
      </div>
      {onRetry && <button type="button" className="btn-link" onClick={onRetry}>{conflict ? 'Reload latest' : 'Retry'}</button>}
    </div>
  );
}

// `cachedAt`: when an offline snapshot (no local table) was loaded from the server.
export function StaleNote({ stale, cachedAt }) {
  if (!stale) return null;
  return (
    <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
      {cachedAt ? `Offline — showing the copy last loaded ${fmtDateTime(cachedAt)}. It may be out of date.` : 'Offline — showing data stored on this device.'}
    </p>
  );
}

// Wraps the loading / error / empty decision for a useResource() result.
export function DataState({ res, empty, isEmpty, children }) {
  if (res.loading && !res.data) return <Loading />;
  if (res.error && !res.data) return <ErrorNote error={res.error} onRetry={res.reload} />;
  if (!res.data) return null;
  const blank = isEmpty ? isEmpty(res.data) : isBlank(res.data); // an empty list, never a single record
  return (
    <>
      <StaleNote stale={res.stale} cachedAt={res.cachedAt} />
      {blank ? <Empty title={empty ?? 'Nothing here yet'} /> : children(res.data)}
    </>
  );
}

// Page navigation for the backend's { items, total, page, page_size } envelope.
export function Pager({ data, onPage }) {
  if (!data?.total || data.total <= data.page_size) return null;
  const pages = Math.ceil(data.total / data.page_size);
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
      <span>Page {data.page} of {pages} · {data.total} records</span>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
        <button type="button" className="btn-secondary" disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}>Next</button>
      </div>
    </div>
  );
}

// A row of filters above a list.
export function FilterBar({ children }) {
  return <div className="mb-4 flex flex-wrap items-end gap-3 [&>*]:min-w-[9rem] [&>*]:flex-1 [&>*]:basis-[9rem]">{children}</div>;
}

export function Segmented({ options, value, onChange, label: aria }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={aria}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`h-9 rounded-full px-3.5 text-[13px] font-semibold ring-1 transition duration-150 active:scale-95 ${value === o.value ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-brand-900 ring-line hover:bg-brand-50'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Where a record stands between this device and the server. Server-confirmed records show nothing.
const SYNC = {
  pending: ['amber', 'Not synced'],
  rejected: ['red', 'Rejected by server'],
  conflict: ['red', 'Sync conflict'],
};
export function SyncBadge({ status, error }) {
  const s = SYNC[status];
  if (!s) return null;
  return <span title={error ?? undefined}><Badge tone={s[0]}>{s[1]}</Badge></span>;
}

// Table cell form: 'On server' for server-confirmed records, the badge otherwise.
export function SyncState({ record }) {
  return SYNC[record.sync_status] ? <SyncBadge status={record.sync_status} error={record.last_sync_error} /> : <span className="text-xs text-slate-500">On server</span>;
}

// A button for an action that needs the server: disabled offline, with the reason shown beside it.
export function OnlineButton({ reason, className = 'btn-secondary', disabled, children, ...rest }) {
  const online = useNetworkStatus();
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={className} disabled={!online || disabled} title={!online ? reason : undefined} {...rest}>{children}</button>
      {!online && reason && <span className="mt-1 max-w-xs text-xs text-amber-800">{reason}</span>}
    </span>
  );
}

// Explains, once per screen, why its server-only actions are unavailable.
export function OfflineActionsNote({ reason }) {
  const online = useNetworkStatus();
  if (online) return null;
  return <p className="mb-3 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">Offline: {reason}</p>;
}

export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', danger, busy, disabled, onConfirm, onClose }) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-700">{children}</div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button type="button" className="btn-secondary h-12" onClick={onClose}>Back</button>
        <button type="button" className={danger ? 'btn-primary bg-red-600 shadow-none hover:bg-red-700' : 'btn-primary'} disabled={busy || disabled} onClick={onConfirm}>
          {busy && <Spinner />} {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// Label/value pairs of a record. `items`: [[label, value], ...]; empty values show as '—'.
export function DetailList({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-line/70 py-2 last:border-0 sm:block sm:border-0 sm:py-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-right font-medium text-ink sm:text-left">{v === null || v === undefined || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

// Append-only history, oldest first. `items`: [{ id, title, at, body }].
export function Timeline({ items, empty = 'No history recorded.' }) {
  if (!items.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ol className="space-y-3 border-l-2 border-brand-100 pl-4">
      {items.map((h) => (
        <li key={h.id} className="text-sm">
          <p className="font-medium">{h.title} <span className="text-xs font-normal text-slate-500">· {fmtDateTime(h.at)}</span></p>
          {h.body && <p className="text-slate-600">{h.body}</p>}
        </li>
      ))}
    </ol>
  );
}

// One rating question on the bank's scale.
// Face for choice k of n (0 = worst): the mouth goes from a frown to a smile and the colour from red to green.
const FACE_COLOURS = ['#e5484d', '#f76b15', '#f5b100', '#9bd12b', '#30a46c'];
function faceColour(k, n) {
  if (n <= 1) return FACE_COLOURS[4];
  return FACE_COLOURS[Math.round((k / (n - 1)) * (FACE_COLOURS.length - 1))];
}

export function RatingFace({ k, n, selected, className = 'h-11 w-11' }) {
  const t = n <= 1 ? 1 : k / (n - 1);          // 0 sad … 1 happy
  const curve = (t - 0.5) * 16;                // mouth control point offset
  const mouth = Math.abs(curve) < 1.5 ? 'M14 29h12' : `M13 28 Q20 ${28 + curve} 27 28`;
  const fill = selected ? faceColour(k, n) : '#3f3f46';
  return (
    <svg viewBox="0 0 40 40" className={`${className} transition duration-150 ${selected ? 'scale-110 drop-shadow' : ''}`} aria-hidden="true">
      <circle cx="20" cy="20" r="18" fill={fill} />
      {selected && <circle cx="20" cy="20" r="18" fill="url(#face-shine)" />}
      <defs><radialGradient id="face-shine" cx="0.35" cy="0.3" r="0.7"><stop offset="0" stopColor="#fff" stopOpacity="0.45" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient></defs>
      <circle cx="14" cy="16" r="2.2" fill={selected ? '#1f2937' : '#fff'} />
      <circle cx="26" cy="16" r="2.2" fill={selected ? '#1f2937' : '#fff'} />
      <path d={mouth} fill="none" stroke={selected ? '#1f2937' : '#fff'} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

// Answer picker. With `options` (a bank's answer labels, worst first) each choice is a face with its label
// and is stored as min + index; without them the faces are labelled with the numbers min..max.
export function RatingScale({ min, max, options, value, onChange, label: aria }) {
  const choices = options?.length
    ? options.map((text, i) => ({ v: min + i, text }))
    : Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => ({ v: min + i, text: String(min + i) }));
  return (
    <div className="flex justify-between gap-1" role="radiogroup" aria-label={aria}>
      {choices.map(({ v, text }, i) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} aria-label={text} onClick={() => onChange(v)}
          className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl py-1 transition active:scale-95">
          <RatingFace k={i} n={choices.length} selected={value === v} />
          <span className={`w-full truncate text-center text-xs ${value === v ? 'font-semibold text-ink' : 'text-muted'}`}>{text}</span>
        </button>
      ))}
    </div>
  );
}

// Label of a stored rating value: the bank's answer label, or the number out of the scale.
export function ratingText(value, bank) {
  if (!bank) return String(value);
  return bank.option_labels?.[value - bank.scale_min] ?? `${value} / ${bank.scale_max}`;
}

// Below 640px every row is a card (first column as its title, the rest as label/value pairs), so phones never
// scroll a table sideways; from 640px it is a normal table. Both keep table semantics for screen readers.
export function Table({ columns, rows, onRowClick, rowKey = (r) => r.id }) {
  const [first, ...rest] = columns;
  const cell = (c, r) => (c.render ? c.render(r) : r[c.key]);
  return (
    <>
    <div role="table" className="divide-y divide-line/70 sm:hidden">
      {/* Column headers for screen readers; the visible per-value labels below are decorative. */}
      <div role="rowgroup" className="sr-only">
        <div role="row">{columns.map((c) => <span role="columnheader" key={c.key}>{c.label}</span>)}</div>
      </div>
      <div role="rowgroup">
        {rows.map((r) => (
          <div role="row" key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
            className={`py-3 ${onRowClick ? 'cursor-pointer active:bg-brand-50/60' : ''}`}>
            <div role="cell" className="min-w-0 break-words text-sm font-semibold text-ink">{cell(first, r)}</div>
            <div className="mt-1.5 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {rest.map((c) => (c.label ? (
                <div role="cell" key={c.key} className="contents">
                  <span aria-hidden="true" className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.label}</span>
                  <span className="min-w-0 break-words text-slate-800">{cell(c, r)}</span>
                </div>
              ) : (
                <div role="cell" key={c.key} className="col-span-2 min-w-0">{cell(c, r)}</div>
              )))}
            </div>
          </div>
        ))}
      </div>
    </div>
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            {columns.map((c) => <th key={c.key} className="px-4 py-2 font-medium sm:px-3">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-b border-line/60 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-brand-50/40' : ''}`}>
              {columns.map((c) => <td key={c.key} className="px-4 py-2.5 align-top sm:px-3">{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

// Pill tabs that never clip a label: with a few tabs they share the width equally, and once the labels
// stop fitting (Master data has eight) the row scrolls sideways instead of truncating to "Tr…".
// The selected tab is always scrolled into view, and a fade on each scrollable edge shows there is more.
export function Tabs({ tabs, value, onChange }) {
  const strip = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 });
  };

  useEffect(() => {
    const el = strip.current;
    if (!el) return undefined;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  // Keep the selected pill visible when the tab changes from elsewhere (or on first paint).
  useEffect(() => {
    const el = strip.current?.querySelector('[aria-selected="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [value]);

  return (
    <div className="relative mb-4">
      <div ref={strip} onScroll={measure} role="tablist"
        className="no-scrollbar flex snap-x snap-mandatory gap-1 overflow-x-auto rounded-full bg-white p-1 shadow-card ring-1 ring-line/70">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
            className={`snap-start whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-semibold transition duration-200 ${
              tabs.length > 4 ? 'shrink-0' : 'flex-1 basis-0 text-center'
            } ${value === t.value
              ? 'bg-brand-700 text-white shadow-[0_3px_10px_rgba(7,89,214,0.3)]'
              : 'text-brand-900 hover:bg-brand-50 active:scale-[0.97]'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div aria-hidden="true" className={`pointer-events-none absolute inset-y-1 left-1 w-8 rounded-l-full bg-gradient-to-r from-white to-transparent transition-opacity duration-200 ${edges.left ? 'opacity-100' : 'opacity-0'}`} />
      <div aria-hidden="true" className={`pointer-events-none absolute inset-y-1 right-1 w-8 rounded-r-full bg-gradient-to-l from-white to-transparent transition-opacity duration-200 ${edges.right ? 'opacity-100' : 'opacity-0'}`} />
    </div>
  );
}

// Centred modal (reference: inspection photo dialog): title centred over a divider, close X top-right, a body
// that scrolls on short screens and, with `footer`, an action row that always stays inside the card. With
// `onSubmit` the body and footer are one <form>, so the footer's submit button submits it.
export function Dialog({ open, title, onClose, children, wide, footer, onSubmit }) {
  const card = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); html.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  const Body = onSubmit ? 'form' : 'div';
  // Portalled to <body>: an animated ancestor (the page's entrance animation) would otherwise become the
  // containing block of this fixed overlay and the bars would show above it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-brand-950/45 p-3 backdrop-blur-[1px] sm:p-6" onClick={onClose}>
      <div ref={card} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[min(92dvh,52rem)] w-full animate-modal-in flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_24px_60px_rgba(6,29,66,0.28)] ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="grid shrink-0 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center border-b border-line px-2 py-2.5">
          <span aria-hidden="true" />
          <h2 className="truncate text-center text-[17px] font-bold text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="icon-btn h-9 w-9 text-ink" aria-label="Close"><XIcon className="h-5 w-5" /></button>
        </div>
        <Body className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="shrink-0 border-t border-line/70 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">{footer}</div>}
        </Body>
      </div>
    </div>,
    document.body,
  );
}

// A labelled input. `icon`: a line icon left of the label and input (reference: feedback form).
export function Field({ label, hint, error, icon: Icon, children }) {
  const body = (
    <>
      <span className="mb-1.5 block text-[13px] font-medium text-slate-600">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </>
  );
  if (!Icon) return <label className="block min-w-0">{body}</label>;
  return (
    <label className="flex min-w-0 items-start gap-3">
      <Icon className="mt-0 h-5 w-5 shrink-0 text-slate-500" />
      <span className="block min-w-0 flex-1">{body}</span>
    </label>
  );
}

export function Select({ value, onChange, options, placeholder, ...rest }) {
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// Steps of a multi-step flow (reference: feedback form): small circles on a grey line, labels underneath.
// `current` is the step in progress; steps before it are done.
export function Stepper({ steps, current }) {
  return (
    <ol className="relative mb-5 flex items-start" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current;
        const on = i === current;
        return (
          <li key={s} className="relative flex flex-1 flex-col items-center text-center" aria-current={on ? 'step' : undefined}>
            {i > 0 && <span className={`absolute right-1/2 top-[9px] h-[2px] w-full transition-colors duration-300 ${i <= current ? 'bg-brand-600' : 'bg-line'}`} aria-hidden="true" />}
            <span className={`relative z-10 grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold transition-all duration-300 ${done || on ? 'bg-brand-600 text-white' : 'bg-white text-slate-400 ring-2 ring-line'} ${on ? 'shadow-[0_0_0_4px_rgba(8,102,232,0.16)]' : ''}`}>
              {done ? <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg> : i + 1}
            </span>
            <span className={`mt-1.5 px-1 text-[11px] font-semibold leading-tight sm:text-xs ${on ? 'text-brand-700' : done ? 'text-ink' : 'text-slate-400'}`}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

// `flush`: inside a Dialog footer (no top margin). `icon`: shown before the label when not busy.
export function SubmitBar({ busy, label, onCancel, disabled, flush, icon }) {
  return (
    <div className={`${flush ? '' : 'mt-5'} grid gap-3 ${onCancel ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {onCancel && <button type="button" className="btn-secondary h-12" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="btn-primary min-w-0 px-3" disabled={busy || disabled}>{busy ? <Spinner /> : icon} <span className="truncate">{label}</span></button>
    </div>
  );
}

export const fmtDate = (d) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const label = (s) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');

// Overflow menu for a screen's secondary actions (top-bar ⋯). `items`: [{ label, onClick, disabled, danger, hint }].
export function ActionMenu({ items, label: aria = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="relative" ref={box}>
      <button type="button" className="icon-btn" aria-label={aria} aria-expanded={open} onClick={() => setOpen((v) => !v)}><MoreIcon className="h-6 w-6" /></button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-60 animate-modal-in overflow-hidden rounded-2xl bg-white py-1.5 shadow-raised ring-1 ring-line" role="menu">
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} title={it.hint}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={`block w-full px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40 ${it.danger ? 'text-red-600' : 'text-ink'}`}>
              {it.label}
              {it.disabled && it.hint && <span className="block text-xs font-normal text-amber-800">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
