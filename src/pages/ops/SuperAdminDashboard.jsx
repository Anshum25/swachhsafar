// The Super Admin dashboard: every office, every headquarters and station, counted. Backend:
// GET /dashboard/overview (app/services/reports.py overview) with ?client_id= (one office), division_id (one
// headquarters or station) and the period. With no filter it is everything.
//
// Charts are plain SVG (the app ships no chart library): one daily line chart of four activity series and
// two horizontal bar charts. Series colours are the validated categorical slots 1-4 (blue, orange, aqua,
// yellow); two of them sit below 3:1 against the surface, so every chart has a legend and a table view.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useResource } from '../../app/session.jsx';
import { navigate } from '../../app/router.js';
import { Badge, DataState, Field, Panel, Segmented, Select, Table } from '../../components/ui.jsx';
import { PERIODS, istToday, niceScale, periodRange, shortDate, tickDates } from './overviewMath.js';

const SERIES = [
  { key: 'journeys', label: 'Journeys', color: '#2a78d6' },
  { key: 'attendance', label: 'Attendance', color: '#eb6834' },
  { key: 'inspections', label: 'Inspections', color: '#1baf7a' },
  { key: 'complaints', label: 'Complaints', color: '#eda100' },
];
const STATUS_LABEL = { created: 'New', in_process: 'In process', forwarded: 'Forwarded', completed: 'Completed' };
const fmt = (n) => (n ?? 0).toLocaleString('en-IN');

// ---- filters -------------------------------------------------------------------------------------------

function Filters({ value, onChange }) {
  const clients = useResource('/clients');
  const divisions = useResource('/divisions');
  const set = (patch) => onChange({ ...value, ...patch });
  const officeDivisions = (divisions.data ?? []).filter((d) => !value.clientId || d.client_id === value.clientId);
  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div className="min-w-[12rem] flex-1">
        <Field label="Office">
          <Select value={value.clientId} onChange={(v) => set({ clientId: v, divisionId: '' })} aria-label="Office"
            options={[{ value: '', label: 'All offices' }, ...(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.office_id} — ${c.name}` }))]} />
        </Field>
      </div>
      <div className="min-w-[12rem] flex-1">
        <Field label="Headquarters / station">
          <Select value={value.divisionId} onChange={(v) => set({ divisionId: v })} aria-label="Headquarters or station"
            options={[{ value: '', label: value.clientId ? 'All of this office' : 'All divisions' },
              ...officeDivisions.map((d) => ({ value: d.id, label: `${d.name}${d.kind === 'headquarters' ? ' (HQ)' : ''}` }))]} />
        </Field>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-ink">Period</p>
        <Segmented label="Period" value={value.period} onChange={(v) => set({ period: v })}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
      </div>
      {value.period === 'custom' && (
        <div className="flex gap-2">
          <Field label="From"><input type="date" className="input h-10" max={istToday()} value={value.from} onChange={(e) => set({ from: e.target.value })} /></Field>
          <Field label="To"><input type="date" className="input h-10" max={istToday()} value={value.to} onChange={(e) => set({ to: e.target.value })} /></Field>
        </div>
      )}
    </div>
  );
}

// ---- number tiles --------------------------------------------------------------------------------------

function Tile({ label, value, hint, tone }) {
  const tones = { brand: 'text-brand-700', amber: 'text-amber-700', red: 'text-red-700', slate: 'text-ink' };
  return (
    <div className="card">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone ?? 'slate']}`}>{fmt(value)}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function TileGroup({ title, children, three }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2>
      <div className={`grid grid-cols-2 gap-3 ${three ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>{children}</div>
    </section>
  );
}

// ---- daily line chart ----------------------------------------------------------------------------------

// The width the chart has, measured from a box the chart cannot widen: 0 until measured, and the SVG is only
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

function DailyChart({ daily }) {
  const [ref, width] = useWidth();
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const shown = SERIES.filter((s) => !hidden.has(s.key));
  const H = 240, pad = { l: 36, r: 12, t: 12, b: 28 };
  const iw = width - pad.l - pad.r, ih = H - pad.t - pad.b;
  const scale = niceScale(Math.max(0, ...daily.flatMap((d) => shown.map((s) => d[s.key]))));
  const x = (i) => pad.l + (daily.length === 1 ? iw / 2 : (i * iw) / (daily.length - 1));
  const y = (v) => pad.t + ih - (v / scale.max) * ih;
  const labelled = new Set(tickDates(daily.map((d) => d.date), width < 480 ? 4 : 7));
  const toggle = (key) => setHidden((h) => { const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left - pad.l;
    const i = daily.length === 1 ? 0 : Math.round((px / iw) * (daily.length - 1));
    setHover(Math.min(daily.length - 1, Math.max(0, i)));
  };
  const h = hover != null ? daily[hover] : null;

  return (
    <Panel title="Daily activity" actions={
      <button type="button" className="btn-secondary h-9 text-xs" onClick={() => setAsTable((v) => !v)}>{asTable ? 'Show chart' : 'Show as table'}</button>
    }>
      {/* Legend doubles as the series toggle; identity is never colour alone (name + swatch). */}
      <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Series">
        {SERIES.map((s) => (
          <button key={s.key} type="button" aria-pressed={!hidden.has(s.key)} onClick={() => toggle(s.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-slate-200 ${hidden.has(s.key) ? 'text-slate-400' : 'text-ink'}`}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: hidden.has(s.key) ? '#cbd5e1' : s.color }} />{s.label}
          </button>
        ))}
      </div>
      {asTable ? (
        <div className="max-h-80 overflow-auto">
          <Table rowKey={(d) => d.date} rows={[...daily].reverse()} columns={[
            { key: 'date', label: 'Date', render: (d) => shortDate(d.date) },
            ...SERIES.map((s) => ({ key: s.key, label: s.label, render: (d) => fmt(d[s.key]) })),
            { key: 'passenger_feedback', label: 'Passenger feedback', render: (d) => fmt(d.passenger_feedback) },
          ]} />
        </div>
      ) : (
        <div ref={ref} className="relative w-full min-w-0 overflow-hidden" style={{ minHeight: H }}>
          {width > 0 && <svg width={width} height={H} role="img" aria-label={`Daily activity, ${daily.length} days`}
            onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block touch-none">
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="#e7e5e0" strokeWidth="1" />
                <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="#6b6a65">{fmt(t)}</text>
              </g>
            ))}
            {daily.map((d, i) => (labelled.has(d.date) ? (
              <text key={d.date} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}
                fontSize="11" fill="#6b6a65">{shortDate(d.date)}</text>
            ) : null))}
            {shown.map((s) => (
              <polyline key={s.key} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                points={daily.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')} />
            ))}
            {daily.length <= 31 && shown.map((s) => daily.map((d, i) => (
              <circle key={`${s.key}-${d.date}`} cx={x(i)} cy={y(d[s.key])} r={hover === i ? 4.5 : 0} fill={s.color} stroke="#fff" strokeWidth="2" />
            )))}
            {h && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#a3a29d" strokeWidth="1" strokeDasharray="3 3" />}
          </svg>}
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
    </Panel>
  );
}

// ---- horizontal bars (one hue: these are counts of named things, not series) ---------------------------

function Bars({ title, rows, empty }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Panel title={title}>
      {rows.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-[7.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-sm" title={`${r.label}: ${fmt(r.value)}`}>
              <span className="truncate text-slate-700">{r.label}</span>
              <span className="h-3 rounded-r bg-slate-100">
                <span className="block h-3 rounded-r" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 4 : 0, background: '#2a78d6' }} />
              </span>
              <span className="text-right font-semibold tabular-nums text-ink">{fmt(r.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---- offices -------------------------------------------------------------------------------------------

function Offices({ offices, onPick }) {
  return (
    <Panel title="Offices">
      <Table rowKey={(o) => o.client_id} rows={offices} onRowClick={(o) => onPick(o.client_id)} columns={[
        { key: 'name', label: 'Office', render: (o) => <><span className="font-semibold">{o.office_id}</span><span className="block text-xs text-slate-500">{o.name}</span></> },
        { key: 'divisions', label: 'HQ & stations', render: (o) => fmt(o.divisions) },
        { key: 'users', label: 'Active users', render: (o) => fmt(o.users) },
        { key: 'journeys', label: 'Journeys', render: (o) => fmt(o.journeys) },
        { key: 'attendance', label: 'Attendance', render: (o) => fmt(o.attendance) },
        { key: 'inspections', label: 'Inspections', render: (o) => fmt(o.inspections) },
        { key: 'complaints_open', label: 'Open complaints', render: (o) => fmt(o.complaints_open) },
        { key: 'credit_balance', label: 'Credits', render: (o) => <span className="tabular-nums">{fmt(o.credit_balance)}</span> },
        { key: 'credits_spent', label: 'Spent', render: (o) => fmt(o.credits_spent) },
        { key: 'status', label: 'Status', render: (o) => <Badge tone={o.status === 'active' ? 'green' : 'red'}>{o.status === 'active' ? 'Active' : 'Suspended'}</Badge> },
      ]} />
      <p className="mt-2 text-xs text-muted">Pick an office to filter the whole dashboard to it.
        {' '}<button type="button" className="font-semibold text-brand-700 underline" onClick={() => navigate('/masters/clients')}>Manage offices</button></p>
    </Panel>
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
  const days = `${shortDate(range.date_from)} – ${shortDate(range.date_to)}`;

  return (
    <div className="space-y-4">
      <Filters value={filters} onChange={setFilters} />
      {/* One object, not a list: DataState would otherwise call it empty for having no `items`. */}
      <DataState res={res} isEmpty={() => false}>
        {(o) => {
          const t = o.totals;
          return (
            <div className="space-y-5">
              <TileGroup title="Network">
                <Tile label="Offices" value={t.offices} tone="brand" />
                <Tile label="Headquarters" value={t.headquarters} />
                <Tile label="Stations" value={t.stations} />
                <Tile label="Active users" value={t.users_active} hint={`${fmt(t.users_inactive)} inactive`} />
              </TileGroup>
              <TileGroup title={`Journeys · ${days}`}>
                <Tile label="Running now" value={t.journeys_active} tone="brand" />
                <Tile label="Scheduled" value={t.journeys_scheduled} />
                <Tile label="In the period" value={t.journeys} />
                <Tile label="Cancelled" value={t.journeys_cancelled} tone={t.journeys_cancelled ? 'amber' : 'slate'} />
              </TileGroup>
              <TileGroup title={`Field work · ${days}`}>
                <Tile label="Attendance records" value={t.attendance} />
                <Tile label="Coach inspections" value={t.inspections} />
                <Tile label="Passenger feedback" value={t.passenger_feedback} />
                <Tile label="Railway feedback" value={t.railway_feedback} />
              </TileGroup>
              <div className="grid gap-5 lg:grid-cols-2">
                <TileGroup title={`Complaints · ${days}`} three>
                  <Tile label="Raised in period" value={t.complaints} />
                  <Tile label="Open now" value={t.complaints_open} tone={t.complaints_open ? 'amber' : 'slate'} />
                  <Tile label="Overdue now" value={t.complaints_overdue} tone={t.complaints_overdue ? 'red' : 'slate'} />
                </TileGroup>
                <TileGroup title={`Credits · ${days}`} three>
                  <Tile label="Balance now" value={t.credit_balance} tone="brand" />
                  <Tile label="Added in period" value={t.credits_added} />
                  <Tile label="Spent in period" value={t.credits_spent} />
                </TileGroup>
              </div>

              <DailyChart daily={o.daily} />

              <div className="grid gap-4 lg:grid-cols-2">
                <Bars title="Users by role" empty="No users yet."
                  rows={o.users_by_role.map((r) => ({ label: r.role, value: r.count }))} />
                <Bars title="Complaints by status (all time)" empty="No complaints yet."
                  rows={Object.entries(STATUS_LABEL).map(([k, l]) => ({ label: l, value: o.complaints_by_status[k] ?? 0 }))} />
              </div>

              <Offices offices={o.offices} onPick={(id) => setFilters((f) => ({ ...f, clientId: id, divisionId: '' }))} />
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
