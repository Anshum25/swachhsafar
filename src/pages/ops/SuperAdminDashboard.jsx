// The Super Admin dashboard: every office, every headquarters and station, counted. Backend:
// GET /dashboard/overview (app/services/reports.py overview) with ?client_id= (one office), division_id (one
// headquarters or station) and the period. With no filter it is everything.
//
// Layout, top to bottom: the scope and its filters; four headline cards with a trend line each; a strip of
// network and credit figures; the daily activity chart beside complaints by status; three donuts (users by
// role, journeys by office, feedback by source); the offices table.
//
// Charts are plain SVG (the app ships no chart library). Colours are the validated categorical slots in
// fixed order (blue, orange, aqua, yellow, magenta, green; checked with the dataviz palette validator).
// Three of them sit below 3:1 against the card, so every chart names its parts in text beside it -- a
// legend with figures, or the table view -- and identity is never colour alone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useResource } from '../../app/session.jsx';
import { navigate } from '../../app/router.js';
import AddCreditsDialog from './masters/AddCreditsDialog.jsx';
import { Badge, DataState, Segmented, Select, Table } from '../../components/ui.jsx';
import {
  CalendarCheckIcon, ClipboardListIcon, FlagIcon, TrainIcon,
} from '../../components/Icons.jsx';
import {
  PERIODS, compact, donutAngles, foldParts, istToday, niceScale, pct, periodRange, ringPath, shortDate, tickDates,
} from './overviewMath.js';

const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const SURFACE = '#ffffff';
const INK_MUTED = '#6b6a65';
const GRID = '#ebe9e4';
const SERIES = [
  { key: 'journeys', label: 'Journeys', color: PALETTE[0] },
  { key: 'attendance', label: 'Attendance', color: PALETTE[1] },
  { key: 'inspections', label: 'Inspections', color: PALETTE[2] },
  { key: 'complaints', label: 'Complaints', color: PALETTE[3] },
];
const STATUSES = [
  { key: 'created', label: 'New' }, { key: 'in_process', label: 'In process' },
  { key: 'forwarded', label: 'Forwarded' }, { key: 'completed', label: 'Completed' },
];
const fmt = (n) => (n ?? 0).toLocaleString('en-IN');

function Card({ title, subtitle, actions, children, className = '' }) {
  return (
    <section className={`min-w-0 rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-5 ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

// The width a chart has, measured from a box the chart cannot widen: 0 until measured, and the SVG is only
// drawn once it is known (a guessed width would push a phone screen sideways before the first measurement).
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const measure = () => setW(Math.floor(ref.current.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---- header and filters --------------------------------------------------------------------------------

function Toolbar({ value, onChange, scopeLabel, rangeLabel }) {
  const clients = useResource('/clients');
  const divisions = useResource('/divisions');
  const set = (patch) => onChange({ ...value, ...patch });
  const officeDivisions = (divisions.data ?? []).filter((d) => !value.clientId || d.client_id === value.clientId);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">Operations overview</h2>
          <p className="mt-0.5 text-sm text-muted">{scopeLabel} · {rangeLabel}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-2 shadow-card ring-1 ring-slate-200/70">
        <div className="min-w-[11rem] flex-1">
          <Select value={value.clientId} onChange={(v) => set({ clientId: v, divisionId: '' })} aria-label="Office"
            options={[{ value: '', label: 'All offices' }, ...(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.office_id} — ${c.name}` }))]} />
        </div>
        <div className="min-w-[11rem] flex-1">
          <Select value={value.divisionId} onChange={(v) => set({ divisionId: v })} aria-label="Headquarters or station"
            options={[{ value: '', label: 'All HQs and stations' },
              ...officeDivisions.map((d) => ({ value: d.id, label: `${d.name}${d.kind === 'headquarters' ? ' (HQ)' : ''}` }))]} />
        </div>
        <Segmented label="Period" value={value.period} onChange={(v) => set({ period: v })}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
        {value.period === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" aria-label="From" className="input h-10" max={istToday()} value={value.from} onChange={(e) => set({ from: e.target.value })} />
            <span className="text-sm text-muted">to</span>
            <input type="date" aria-label="To" className="input h-10" max={istToday()} value={value.to} onChange={(e) => set({ to: e.target.value })} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- headline cards with a trend line ------------------------------------------------------------------

function Sparkline({ values, color }) {
  const max = Math.max(1, ...values);
  const n = values.length;
  if (n < 2) return null;
  const pts = values.map((v, i) => `${(i / (n - 1)) * 100},${30 - (v / max) * 26}`).join(' ');
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-10 w-full" aria-hidden="true">
      <polygon points={`0,32 ${pts} 100,32`} fill={color} opacity="0.12" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Headline({ icon: Icon, label, value, color, values, children }) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl" style={{ background: `${color}1a`, color }}><Icon className="h-[18px] w-[18px]" /></span>
        <p className="truncate text-sm font-medium text-slate-600">{label}</p>
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-ink">{compact(value)}</p>
      <div className="mt-1 min-h-[1.25rem] text-xs text-muted">{children}</div>
      <div className="mt-2"><Sparkline values={values} color={color} /></div>
    </div>
  );
}

function Figure({ label, value, hint, tone }) {
  const tones = { amber: 'text-amber-700', red: 'text-red-700' };
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-xs font-medium text-muted">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${tones[tone] ?? 'text-ink'}`}>{compact(value)}</p>
      {hint && <p className="truncate text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

// ---- daily activity: multi-line with crosshair, legend toggle and table view ---------------------------

function DailyChart({ daily }) {
  const [ref, width] = useWidth();
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const shown = SERIES.filter((s) => !hidden.has(s.key));
  const H = 260, pad = { l: 36, r: 12, t: 12, b: 28 };
  const iw = Math.max(1, width - pad.l - pad.r), ih = H - pad.t - pad.b;
  const scale = niceScale(Math.max(0, ...daily.flatMap((d) => shown.map((s) => d[s.key]))));
  const x = (i) => pad.l + (daily.length === 1 ? iw / 2 : (i * iw) / (daily.length - 1));
  const y = (v) => pad.t + ih - (v / scale.max) * ih;
  const labelled = new Set(tickDates(daily.map((d) => d.date), width < 480 ? 4 : 7));
  const toggle = (key) => setHidden((h) => { const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = daily.length === 1 ? 0 : Math.round(((e.clientX - box.left - pad.l) / iw) * (daily.length - 1));
    setHover(Math.min(daily.length - 1, Math.max(0, i)));
  };
  const h = hover != null ? daily[hover] : null;

  return (
    <Card title="Daily activity" subtitle="Records per day, India time" className="lg:col-span-2"
      actions={<button type="button" className="btn-secondary h-8 text-xs" onClick={() => setAsTable((v) => !v)}>{asTable ? 'Chart' : 'Table'}</button>}>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Series">
        {SERIES.map((s) => (
          <button key={s.key} type="button" aria-pressed={!hidden.has(s.key)} onClick={() => toggle(s.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-slate-200 transition hover:bg-slate-50 ${hidden.has(s.key) ? 'text-slate-400' : 'text-ink'}`}>
            <span className="h-2 w-2 rounded-full" style={{ background: hidden.has(s.key) ? '#cbd5e1' : s.color }} />{s.label}
          </button>
        ))}
      </div>
      {asTable ? (
        <div className="max-h-[17rem] overflow-auto">
          <Table rowKey={(d) => d.date} rows={[...daily].reverse()} columns={[
            { key: 'date', label: 'Date', render: (d) => shortDate(d.date) },
            ...SERIES.map((s) => ({ key: s.key, label: s.label, render: (d) => fmt(d[s.key]) })),
          ]} />
        </div>
      ) : (
        <div ref={ref} className="relative w-full min-w-0 overflow-hidden" style={{ minHeight: H }}>
          {width > 0 && (
            <svg width={width} height={H} role="img" aria-label={`Daily activity over ${daily.length} days`}
              onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block touch-none">
              {scale.ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
                  <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill={INK_MUTED}>{fmt(t)}</text>
                </g>
              ))}
              {daily.map((d, i) => (labelled.has(d.date) ? (
                <text key={d.date} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}
                  fontSize="11" fill={INK_MUTED}>{shortDate(d.date)}</text>
              ) : null))}
              {shown.map((s) => (
                <polyline key={s.key} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                  points={daily.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')} />
              ))}
              {h && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#a3a29d" strokeWidth="1" strokeDasharray="3 3" />}
              {h && shown.map((s) => <circle key={s.key} cx={x(hover)} cy={y(h[s.key])} r="4.5" fill={s.color} stroke={SURFACE} strokeWidth="2" />)}
            </svg>
          )}
          {h && (
            <div className="pointer-events-none absolute top-2 z-10 min-w-[10rem] rounded-xl bg-white px-3 py-2 text-xs shadow-raised ring-1 ring-line"
              style={x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }}>
              <p className="mb-1 font-semibold text-ink">{shortDate(h.date)}</p>
              {shown.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-4 text-slate-700">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
                  <span className="font-semibold tabular-nums text-ink">{fmt(h[s.key])}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---- donut: slices with 2px gaps, the total in the middle, a legend with figures and shares -------------

function Donut({ title, subtitle, parts, centerLabel, empty, className = '' }) {
  const [active, setActive] = useState(null);
  const shown = foldParts(parts, 6).map((p) => ({ ...p, color: p.color ?? PALETTE[parts.findIndex((q) => q.key === p.key)] ?? '#94a3b8' }));
  const total = shown.reduce((n, p) => n + p.value, 0);
  const angles = donutAngles(shown.map((p) => p.value));
  const S = 168, c = S / 2, r1 = 80, r0 = 56;
  const focus = active != null ? shown[active] : null;
  return (
    <Card title={title} subtitle={subtitle} className={className}>
      {total === 0 ? <p className="py-10 text-center text-sm text-muted">{empty}</p> : (
        <div className="flex flex-col items-center gap-4">
          <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} role="img" className="shrink-0"
            aria-label={`${title}: ${shown.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
            {shown.map((p, i) => (
              <path key={p.key} d={ringPath(c, c, active === i ? r0 - 2 : r0, active === i ? r1 + 3 : r1, angles[i].start, angles[i].end)}
                fill={p.color} stroke={SURFACE} strokeWidth={shown.length > 1 ? 2 : 0} strokeLinejoin="round"
                opacity={active == null || active === i ? 1 : 0.35} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
                <title>{`${p.label}: ${fmt(p.value)} (${pct(angles[i].share)})`}</title>
              </path>
            ))}
            <text x={c} y={c - 4} textAnchor="middle" fontSize="24" fontWeight="600" fill="#0b0b0b">{compact(focus ? focus.value : total)}</text>
            <text x={c} y={c + 16} textAnchor="middle" fontSize="11" fill={INK_MUTED}>{focus ? focus.label : centerLabel}</text>
          </svg>
          <ul className="w-full min-w-0 space-y-1.5">
            {shown.map((p, i) => (
              <li key={p.key} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}
                className={`grid grid-cols-[0.75rem_minmax(0,1fr)_auto_2.75rem] items-center gap-2 rounded-lg px-1.5 py-1 text-sm ${active === i ? 'bg-slate-50' : ''}`}>
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
                <span className="truncate text-slate-700">{p.label}</span>
                <span className="font-semibold tabular-nums text-ink">{fmt(p.value)}</span>
                <span className="text-right text-xs tabular-nums text-muted">{pct(angles[i].share)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---- offices -------------------------------------------------------------------------------------------

function Offices({ offices, onPick, onAddCredits }) {
  const maxCredits = Math.max(1, ...offices.map((o) => o.credit_balance));
  return (
    <Card title="Offices" subtitle="Pick one to filter the dashboard to it"
      actions={<button type="button" className="btn-secondary h-8 text-xs" onClick={() => navigate('/masters/clients')}>Manage offices</button>}>
      <Table rowKey={(o) => o.client_id} rows={offices} onRowClick={(o) => onPick(o.client_id)} columns={[
        { key: 'name', label: 'Office', render: (o) => <><span className="font-semibold">{o.office_id}</span><span className="block text-xs text-slate-500">{o.name}</span></> },
        { key: 'divisions', label: 'HQ & stations', render: (o) => fmt(o.divisions) },
        { key: 'users', label: 'Users', render: (o) => fmt(o.users) },
        { key: 'journeys', label: 'Journeys', render: (o) => fmt(o.journeys) },
        { key: 'attendance', label: 'Attendance', render: (o) => fmt(o.attendance) },
        { key: 'inspections', label: 'Inspections', render: (o) => fmt(o.inspections) },
        { key: 'complaints_open', label: 'Open complaints', render: (o) => fmt(o.complaints_open) },
        { key: 'credit_balance', label: 'Credits', render: (o) => (
          <span className="flex min-w-[6rem] items-center gap-2">
            <span className="w-8 text-right tabular-nums">{fmt(o.credit_balance)}</span>
            <span className="h-1.5 flex-1 rounded-full bg-slate-100">
              <span className="block h-1.5 rounded-full" style={{ width: `${(o.credit_balance / maxCredits) * 100}%`, background: PALETTE[0] }} />
            </span>
          </span>
        ) },
        { key: 'credits_spent', label: 'Spent', render: (o) => fmt(o.credits_spent) },
        { key: 'status', label: 'Status', render: (o) => <Badge tone={o.status === 'active' ? 'green' : 'red'}>{o.status === 'active' ? 'Active' : 'Suspended'}</Badge> },
        // The row itself filters the dashboard; this button tops the wallet up without leaving it.
        { key: 'add', label: '', render: (o) => (
          <button type="button" className="btn-secondary h-8 whitespace-nowrap text-xs" aria-label={`Add credits to ${o.office_id}`}
            onClick={(e) => { e.stopPropagation(); onAddCredits(o); }}>+ Credits</button>
        ) },
      ]} />
    </Card>
  );
}

// ---- the screen ----------------------------------------------------------------------------------------

export default function SuperAdminDashboard() {
  const [filters, setFilters] = useState({ clientId: '', divisionId: '', period: '30d', from: '', to: '' });
  const range = periodRange(filters.period, { from: filters.from, to: filters.to });
  const query = useMemo(() => ({
    ...range,
    ...(filters.clientId ? { client_id: filters.clientId } : {}),
    ...(filters.divisionId ? { division_id: filters.divisionId } : {}),
  }), [range.date_from, range.date_to, filters.clientId, filters.divisionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useResource('/dashboard/overview', query);
  const [adding, setAdding] = useState(null); // the office whose wallet is being topped up
  const rangeLabel = range.date_from === range.date_to ? shortDate(range.date_to) : `${shortDate(range.date_from)} – ${shortDate(range.date_to)}`;
  const offices = res.data?.offices ?? [];
  const scopeLabel = filters.clientId
    ? (offices.find((o) => o.client_id === filters.clientId)?.name ?? 'One office') + (filters.divisionId ? ' · one HQ or station' : '')
    : 'All offices';

  return (
    <div className="space-y-4">
      <Toolbar value={filters} onChange={setFilters} scopeLabel={scopeLabel} rangeLabel={rangeLabel} />
      {/* One object, not a list: DataState would otherwise call it empty for having no `items`. */}
      <DataState res={res} isEmpty={() => false}>
        {(o) => {
          const t = o.totals;
          const series = (key) => o.daily.map((d) => d[key]);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Headline icon={TrainIcon} label="Journeys" value={t.journeys} color={PALETTE[0]} values={series('journeys')}>
                  <span className="font-semibold text-ink">{fmt(t.journeys_active)}</span> running now · {fmt(t.journeys_scheduled)} scheduled
                </Headline>
                <Headline icon={CalendarCheckIcon} label="Attendance records" value={t.attendance} color={PALETTE[1]} values={series('attendance')}>
                  in the period
                </Headline>
                <Headline icon={ClipboardListIcon} label="Coach inspections" value={t.inspections} color={PALETTE[2]} values={series('inspections')}>
                  in the period
                </Headline>
                <Headline icon={FlagIcon} label="Complaints raised" value={t.complaints} color={PALETTE[3]} values={series('complaints')}>
                  <span className={t.complaints_open ? 'font-semibold text-amber-700' : ''}>{fmt(t.complaints_open)} open</span>
                  {' · '}<span className={t.complaints_overdue ? 'font-semibold text-red-700' : ''}>{fmt(t.complaints_overdue)} overdue</span>
                </Headline>
              </div>

              <div className="grid grid-cols-2 divide-slate-100 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
                <Figure label="Offices" value={t.offices} />
                <Figure label="Headquarters" value={t.headquarters} />
                <Figure label="Stations" value={t.stations} />
                <Figure label="Active users" value={t.users_active} hint={`${fmt(t.users_inactive)} inactive`} />
                <Figure label="Credit balance" value={t.credit_balance} hint={`+${fmt(t.credits_added)} added in period`} />
                <Figure label="Credits spent" value={t.credits_spent} hint={`${fmt(t.journeys_cancelled)} journeys cancelled`} />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <DailyChart daily={o.daily} />
                <Donut title="Complaints by status" subtitle="All complaints, any date" centerLabel="complaints" empty="No complaints yet."
                  parts={STATUSES.map((s) => ({ key: s.key, label: s.label, value: o.complaints_by_status[s.key] ?? 0 }))} />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Donut title="Users by role" subtitle="Active and inactive" centerLabel="users" empty="No users yet."
                  parts={o.users_by_role.map((r) => ({ key: String(r.role_id), label: r.role, value: r.count }))} />
                <Donut title="Journeys by office" subtitle="In the period" centerLabel="journeys" empty="No journeys in this period."
                  parts={o.offices.map((x) => ({ key: x.client_id, label: x.name, value: x.journeys }))} />
                <Donut title="Feedback by source" subtitle="In the period" centerLabel="feedback" empty="No feedback in this period."
                  parts={[{ key: 'passenger', label: 'Passengers', value: t.passenger_feedback },
                    { key: 'railway', label: 'Railway officials', value: t.railway_feedback }]} />
              </div>

              <Offices offices={o.offices} onPick={(id) => setFilters((f) => ({ ...f, clientId: id, divisionId: '' }))}
                onAddCredits={setAdding} />
            </div>
          );
        }}
      </DataState>
      <AddCreditsDialog office={adding} onClose={() => setAdding(null)} onSaved={res.reload} />
    </div>
  );
}
