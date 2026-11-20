import { useEffect, useState } from 'react';
import { useResource, useSession, useQueueState } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { Badge, DataState, ErrorNote, Loading, Panel, STATE_TONE, Stat, Table, fmtDate, fmtDateTime, label } from '../../components/ui.jsx';
import { daysAgo, today } from '../../utils/capture.js';
import { navigate } from '../../app/router.js';
import { SHORT_LABEL, visibleNav } from '../../app/Layout.jsx';
import { TrainArt } from '../../components/Logo.jsx';
import {
  BarChartSolidIcon, BoxIcon, BriefcaseIcon, CalendarCheckIcon, ChevronRightIcon, ClipboardListIcon, DatabaseGridIcon, FlagIcon, ThumbUpSolidIcon, TrainSolidIcon, UserSolidIcon,
} from '../../components/Icons.jsx';

const SLIDES = [
  ['A Clean', 'Rail Journey', 'for Every Passenger'],
  ['Every Coach', 'Inspected', 'before and after the journey'],
  ['Every Voice', 'Counts', 'verified passenger feedback'],
];

// Reference home banner: pale-blue sky, clouds, the train at the right, carousel dots underneath.
function HomeBanner() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const t = setInterval(() => setN((v) => (v + 1) % SLIDES.length), 6000);
    return () => clearInterval(t);
  }, []);
  const [a, b, sub] = SLIDES[n];
  return (
    <section className="mb-4" aria-roledescription="carousel" aria-label="Swachh Safar">
      <div className="relative h-40 overflow-hidden rounded-2xl bg-gradient-to-br from-[#dcebff] via-brand-100 to-[#f6faff] shadow-card ring-1 ring-brand-200/60 sm:h-48">
        <svg viewBox="0 0 320 160" preserveAspectRatio="xMaxYMax slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <path d="M210 40a12 12 0 0 1 22-5a9 9 0 0 1 15 6h-37z" fill="#fff" opacity=".9" />
          <path d="M150 22a9 9 0 0 1 16-4a7 7 0 0 1 11 5h-27z" fill="#fff" opacity=".8" />
          <path d="M0 160 L320 128 L320 160Z" fill="#cfe2fd" />
          <path d="M292 30v88M286 36h12" stroke="#a3c8fa" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="292" cy="30" r="4" fill="#a3c8fa" />
        </svg>
        <div key={n} className="relative z-10 flex h-full max-w-[56%] animate-rise-in flex-col justify-center pl-5 sm:pl-8">
          <p className="text-[22px] font-extrabold leading-[1.15] tracking-tight text-brand-900 sm:text-[28px]">{a}<br />{b}</p>
          <p className="mt-1.5 text-[13px] font-medium text-brand-900/75 sm:text-sm">{sub}</p>
        </div>
        <TrainArt className="pointer-events-none absolute -right-16 bottom-2 h-[56%] w-auto -scale-x-100 sm:-right-8 sm:h-[66%]" />
      </div>
      <div className="mt-2.5 flex justify-center gap-1.5">
        {SLIDES.map((_, i) => (
          <button key={i} type="button" onClick={() => setN(i)} aria-label={`Slide ${i + 1}`} aria-current={i === n}
            className={`h-1.5 rounded-full transition-all duration-300 ${i === n ? 'w-5 bg-brand-700' : 'w-1.5 bg-brand-300'}`} />
        ))}
      </div>
    </section>
  );
}

const TILE_ICONS = {
  journeys: TrainSolidIcon, attendance: CalendarCheckIcon, inspections: ClipboardListIcon, feedback: ThumbUpSolidIcon, reports: BarChartSolidIcon,
  profile: UserSolidIcon, complaints: FlagIcon, inventory: BoxIcon, masters: DatabaseGridIcon, jobs: BriefcaseIcon,
};
// Reference order first (Journey … Profile), then the further modules this user has.
const TILE_ORDER = ['journeys', 'attendance', 'inspections', 'feedback', 'reports', 'profile', 'complaints', 'inventory', 'masters', 'jobs'];

// One tile per module this user can open, plus their profile.
function ModuleTiles() {
  const { can } = useSession();
  const tiles = [...visibleNav(can).filter((m) => m.key !== 'dashboard'), { key: 'profile', path: '/profile', label: 'Profile' }]
    .sort((x, y) => TILE_ORDER.indexOf(x.key) - TILE_ORDER.indexOf(y.key));
  return (
    <nav aria-label="Modules" className="mb-6 grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-6">
      {tiles.map((m) => {
        const Icon = TILE_ICONS[m.key];
        return (
          <a key={m.key} href={`#${m.path}`} data-testid={`tile-${m.key}`}
            className="tap flex aspect-[1.08] flex-col items-center justify-center gap-2.5 rounded-2xl bg-white p-2 text-center shadow-card ring-1 ring-line/70 hover:ring-brand-200 sm:aspect-[1.3]">
            <Icon className="h-8 w-8 text-brand-700" />
            <span className="truncate text-[13px] font-semibold text-brand-900">{SHORT_LABEL[m.key] ?? m.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function DivisionStats({ divisionId }) {
  const res = useResource(divisionId ? `/dashboard/divisions/${divisionId}` : null);
  if (res.loading && !res.data) return <Loading />;
  if (res.error && !res.data) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const d = res.data;
  if (!d) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 [&>*]:min-w-0">
      <Stat label="Active journeys" value={d.journeys_active} hint={`${d.journeys_scheduled} scheduled`} />
      <Stat label="Attendance today" value={d.attendance_today} hint="records captured" />
      <Stat label="Inspections today" value={d.inspections_today} />
      <Stat label="Open complaints" value={d.complaints_open} hint={`${d.complaints_overdue} overdue`} tone={d.complaints_overdue ? 'red' : 'brand'} />
      <Stat label="Passenger feedback" value={d.passenger_feedback_today} hint="today" tone="slate" />
      <Stat label="Railway feedback" value={d.railway_feedback_today} hint="today" tone="slate" />
    </div>
  );
}

function InspectionProgress({ divisionId }) {
  const res = useResource('/reports/inspections', { date_from: daysAgo(7), date_to: today(), division_id: divisionId });
  return (
    <Panel title="Inspection progress · last 7 days">
      <DataState res={res} empty="No inspections required in this period.">
        {(rows) => (
          <ul className="space-y-3">
            {rows.slice(0, 6).map((r) => {
              const pct = r.completion_pct ?? 0;
              return (
                <li key={`${r.journey_id}-${r.coach_code}`}>
                  <div className="flex justify-between text-sm"><span className="font-medium">{r.train_no} · {fmtDate(r.journey_date)}</span><span className="tabular-nums text-slate-600">{r.done}/{r.required}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-brand-100"><div className="h-2 rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>
    </Panel>
  );
}

function AttendanceOverview({ divisionId }) {
  const res = useResource('/reports/attendance', { date_from: today(), date_to: today(), group_by: 'journey', division_id: divisionId });
  return (
    <Panel title="Attendance today by journey">
      <DataState res={res} empty="No attendance captured today.">
        {(rows) => (
          <Table rowKey={(r) => r.key_id} rows={rows} columns={[
            { key: 'label', label: 'Journey' },
            { key: 'records', label: 'Records' },
            ...[1, 2, 3, 4, 5].map((s) => ({ key: `s${s}`, label: `S${s}`, render: (r) => r.stages?.[s] ?? 0 })),
          ]} />
        )}
      </DataState>
    </Panel>
  );
}

function ComplaintsSummary({ divisionId }) {
  const res = useResource('/reports/complaints', { date_from: daysAgo(30), date_to: today(), division_id: divisionId });
  return (
    <Panel title="Complaints · last 30 days">
      <DataState res={res} isEmpty={(d) => !d.total} empty="No complaints raised in the last 30 days.">
        {(d) => (
          <div className="space-y-2 text-sm">
            <p><span className="text-2xl font-bold text-brand-700">{d.total}</span> total · <span className="text-red-600">{d.overdue} overdue</span></p>
            <div className="flex flex-wrap gap-2">{Object.entries(d.by_status).map(([k, v]) => <Badge key={k} tone={STATE_TONE[k]}>{label(k)}: {v}</Badge>)}</div>
            {d.avg_resolution_hours != null && <p className="text-slate-500">Average resolution {d.avg_resolution_hours.toFixed(1)} h</p>}
          </div>
        )}
      </DataState>
    </Panel>
  );
}

function ActiveJourneys() {
  const res = useResource('/journeys', { state: 'active', page_size: 8 });
  return (
    <Panel title="Active journeys" actions={<a className="btn-link" href="#/journeys">View all</a>}>
      <DataState res={res} empty="No journeys are running right now.">
        {(page) => (
          <ul className="divide-y divide-line/70">
            {page.items.map((j) => (
              <li key={j.id}>
                <button type="button" onClick={() => navigate(`/journeys/${j.id}`)} className="flex w-full items-center gap-3 py-2.5 text-left text-sm transition hover:text-brand-800">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700"><TrainSolidIcon className="h-4.5 w-4.5" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-bold uppercase text-brand-900">{j.train_name}</span>
                    <span className="block truncate text-xs text-muted">{j.train_no} · {fmtDate(j.journey_date)} → {fmtDate(j.end_date)}</span></span>
                  <ChevronRightIcon className="h-5 w-5 shrink-0 text-slate-400" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </DataState>
    </Panel>
  );
}

function RecentActivity({ divisionId }) {
  const { can } = useSession();
  const audit = useResource(can('audit.read') ? '/audit' : null, { page_size: 8 });
  const q = useQueueState();
  return (
    <Panel title="Recent activity">
      {q.failed.length > 0 && <p className="mb-2 text-sm text-red-700">{q.failed.length} record(s) on this device were rejected by the server: {q.failed[0].last_error}</p>}
      {can('audit.read') ? (
        <DataState res={audit} empty="No recorded activity yet.">
          {(page) => (
            <ul className="space-y-2 text-sm">
              {page.items.filter((a) => !divisionId || a.division_id === divisionId).map((a) => (
                <li key={a.id} className="flex justify-between gap-3"><span className="min-w-0 break-words">{label(a.action)} · <span className="text-muted">{a.entity_type}</span></span><span className="shrink-0 text-xs text-muted">{fmtDateTime(a.created_at)}</span></li>
              ))}
            </ul>
          )}
        </DataState>
      ) : (
        <p className="text-sm text-slate-500">{q.pending ? `${q.pending} record(s) waiting to sync from this device.` : 'All records captured on this device are synchronized.'}</p>
      )}
    </Panel>
  );
}

export default function Dashboard() {
  const { can, user } = useSession();
  const division = useDivision();
  const id = division.divisionId;
  return (
    <>
      {/* Whose session this is (devices are shared between staff). */}
      <h1 className="mb-3 truncate text-[17px] font-bold text-ink">Welcome, {user.name.split(' ')[0]}</h1>
      <HomeBanner />
      <ModuleTiles />
      {division.divisions.length > 1 && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-ink">{division.current?.name ?? 'Operations overview'}</p>
          <DivisionPicker division={division} />
        </div>
      )}
      <div className="space-y-4">
        {can('dashboard.read') && <DivisionStats divisionId={id} />}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
          {(can('journeys.read') || can('journeys.read_all')) && <ActiveJourneys />}
          {can('reports.read') && <InspectionProgress divisionId={id} />}
          {can('reports.read') && <AttendanceOverview divisionId={id} />}
          {can('reports.read') && <ComplaintsSummary divisionId={id} />}
          <RecentActivity divisionId={id} />
        </div>
      </div>
    </>
  );
}
