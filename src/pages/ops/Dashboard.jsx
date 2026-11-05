import { useResource, useSession, useQueueState } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { Badge, DataState, ErrorNote, Loading, PageHeader, Panel, STATE_TONE, Stat, Table, fmtDate, fmtDateTime, label } from '../../components/ui.jsx';
import { daysAgo, today } from '../../utils/capture.js';
import { navigate } from '../../app/router.js';
import { MODULE_ICONS, visibleNav } from '../../app/Layout.jsx';
import { TrainArt } from '../../components/Logo.jsx';

// Short tile names (the design's home grid).
const TILE_LABEL = { journeys: 'Journey', attendance: 'Attendance', inspections: 'Inspection', feedback: 'Feedback', complaints: 'Complaints',
  inventory: 'Inventory', masters: 'Masters', reports: 'Reports' };

function HomeBanner() {
  return (
    <div className="relative mb-4 min-h-36 overflow-hidden rounded-3xl bg-gradient-to-br from-brand-100 via-brand-50 to-white p-5 ring-1 ring-brand-100 sm:min-h-40 sm:p-7">
      <p className="max-w-[58%] text-xl font-extrabold leading-tight text-brand-900 sm:text-2xl">A Clean Rail Journey</p>
      <p className="mt-1 max-w-[58%] text-sm text-brand-800/80">for Every Passenger</p>
      <TrainArt className="pointer-events-none absolute bottom-2 right-3 h-14 w-auto sm:bottom-4 sm:right-6 sm:h-24" />
    </div>
  );
}

// One tile per module this user can open, plus their profile.
function ModuleTiles() {
  const { can } = useSession();
  const tiles = [...visibleNav(can).filter((m) => m.key !== 'dashboard'), { key: 'profile', path: '/profile', label: 'Profile' }];
  return (
    <nav aria-label="Modules" className="mb-5 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {tiles.map((m) => {
        const Icon = MODULE_ICONS[m.key];
        return (
          <a key={m.key} href={`#${m.path}`} data-testid={`tile-${m.key}`}
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-white p-3 text-center shadow-[0_1px_3px_rgba(15,23,42,0.06),0_6px_16px_rgba(29,78,216,0.06)] ring-1 ring-slate-100 transition hover:ring-brand-200 active:scale-[0.98]">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-700"><Icon className="h-6 w-6" /></span>
            <span className="text-xs font-semibold text-slate-800 sm:text-sm">{TILE_LABEL[m.key] ?? m.label}</span>
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
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
                  <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-600" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
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
          <ul className="divide-y divide-slate-100">
            {page.items.map((j) => (
              <li key={j.id}>
                <button type="button" onClick={() => navigate(`/journeys/${j.id}`)} className="flex w-full items-center justify-between py-2.5 text-left text-sm hover:text-brand-800">
                  <span><span className="font-semibold">{j.train_no}</span> {j.train_name}<span className="block text-xs text-slate-500">{fmtDate(j.journey_date)} → {fmtDate(j.end_date)} · {j.supervisor_name}</span></span>
                  <Badge tone="green">Active</Badge>
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
                <li key={a.id} className="flex justify-between gap-3"><span>{label(a.action)} · <span className="text-slate-500">{a.entity_type}</span></span><span className="shrink-0 text-xs text-slate-500">{fmtDateTime(a.created_at)}</span></li>
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
  const { user, can } = useSession();
  const division = useDivision();
  const id = division.divisionId;
  return (
    <>
      <PageHeader title={`Welcome, ${user.name.split(' ')[0]}`} subtitle={division.current?.name ?? 'Operations overview'}
        actions={division.divisions.length > 1 ? <DivisionPicker division={division} /> : null} />
      <HomeBanner />
      <ModuleTiles />
      <div className="space-y-4">
        {can('dashboard.read') && <DivisionStats divisionId={id} />}
        <div className="grid gap-4 lg:grid-cols-2">
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
