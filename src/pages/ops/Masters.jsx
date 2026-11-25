import { useEffect, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, divisionLabel, useDivision } from '../../app/division.jsx';
import { useSave } from './masters/common.jsx';
import { coachText, parseCoaches } from '../../utils/coaches.js';
import CoachBreakdown from '../../components/CoachBreakdown.jsx';
import { attendanceConfigError, inRouteOrder, selectableStations } from '../../utils/attendanceStages.js';
import QuestionBanks from './masters/QuestionBanks.jsx';
import { Categories, Departments } from './masters/ComplaintMasters.jsx';
import InventoryItems from './masters/InventoryItems.jsx';
import DivisionPolicy from './masters/DivisionPolicy.jsx';
import Users from './masters/Users.jsx';
import Clients from './masters/Clients.jsx';
import Divisions from './masters/Divisions.jsx';
import OfficeSetupSection from './masters/OfficeSetup.jsx';
import RolePermissions from './masters/RolePermissions.jsx';
import UserProfile from './masters/UserProfile.jsx';
import { MastersMobileNav } from './masters/MastersNav.jsx';
import { usesDivisionFilter, visibleSections } from './masters/sections.js';
import { Badge, DataState, Dialog, ErrorNote, Field, PageHeader, Panel, SubmitBar, Table } from '../../components/ui.jsx';
import { PlusIcon } from '../../components/Icons.jsx';

// Train Master > Attendance Configuration: how many intermediate stations attendance is taken at, and which
// stations of the train's route (RailRadar schedule). Journeys get Source, these stations in route order,
// and End; a train left unconfigured keeps the five standard stages. Journeys where attendance has started
// keep the stages they had (backend services/trains.refresh_journey_plans).
function AttendanceConfig({ train, value, onChange, route, onRoute }) {
  const { api } = useSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const stations = selectableStations(route);
  const count = Number(value.count);
  const full = Number.isInteger(count) && count > 0 && value.codes.length >= count;
  const problem = attendanceConfigError({ ...value, route });

  async function loadRoute() {
    setLoading(true);
    setError(null);
    try {
      const t = await api.post(`/trains/${train.id}/route`, {});
      onRoute(t.route_stations ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  const toggle = (code, on) => onChange({ ...value, codes: on ? inRouteOrder(route, [...value.codes, code]) : value.codes.filter((c) => c !== code) });

  return (
    <fieldset className="space-y-3 rounded-2xl p-3 ring-1 ring-line">
      <legend className="px-1 text-sm font-semibold text-ink">Attendance Configuration</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.enabled} disabled={!train}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        Configure station-wise attendance
      </label>
      {!train && <p className="text-xs text-muted">Create the train first; its route is then read so stations can be chosen.</p>}
      {value.enabled && (
        <>
          <Field label="Required attendance stations" hint="Intermediate stations only. Source and End are always stages of their own.">
            <input type="number" min={1} step={1} max={stations.length || undefined} inputMode="numeric" className="input sm:max-w-40"
              value={value.count} onChange={(e) => onChange({ ...value, count: e.target.value === '' ? '' : Number(e.target.value) })} />
          </Field>
          <ErrorNote error={error} />
          {!stations.length ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted">This train's route has not been read yet.</span>
              <button type="button" className="btn-secondary" disabled={loading} onClick={loadRoute}>{loading ? 'Loading route…' : 'Load route'}</button>
            </div>
          ) : (
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-600" aria-live="polite">
                  {value.codes.length} of {Number.isInteger(count) && count > 0 ? count : '?'} stations selected
                </p>
                <button type="button" className="btn-link text-xs" disabled={loading} onClick={loadRoute}>{loading ? 'Loading…' : 'Reload route'}</button>
              </div>
              <p className="mb-1 text-xs text-slate-500">Source: {route[0]?.name} · End: {route[route.length - 1]?.name}</p>
              <ul className="grid max-h-64 gap-1 overflow-y-auto rounded-xl p-1 ring-1 ring-slate-200 sm:grid-cols-2" aria-label="Route stations">
                {stations.map((st, i) => {
                  const on = value.codes.includes(st.code);
                  return (
                    <li key={st.code}>
                      <label className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${!on && full ? 'opacity-50' : ''}`}>
                        <input type="checkbox" className="h-4.5 w-4.5" checked={on} disabled={!on && full}
                          onChange={(e) => toggle(st.code, e.target.checked)} />
                        <span className="w-6 shrink-0 text-right text-xs text-slate-400">{i + 2}</span>
                        <span className="min-w-0 flex-1 truncate">{st.name}</span>
                        <span className="shrink-0 text-xs text-slate-500">{st.code}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {problem && <p className="text-xs font-medium text-amber-700" role="status">{problem}</p>}
        </>
      )}
    </fieldset>
  );
}

function TrainForm({ train, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const save = useSave(onSaved);
  const [f, setF] = useState({
    train_no: train?.train_no ?? '', name: train?.name ?? '', duration_days: train?.duration_days ?? 1, operational_days: train?.operational_days ?? 2,
    inspection_rounds_per_day: train?.inspection_rounds_per_day ?? 1, before_inspection_enabled: train?.before_inspection_enabled ?? false,
    after_inspection_enabled: train?.after_inspection_enabled ?? true, daywise: train?.daywise ?? false, coaches: train ? coachText(train.coaches) : '',
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));
  const configured = !!train?.attendance_station_count;
  const [route, setRoute] = useState(train?.route_stations ?? []);
  const [att, setAtt] = useState({
    enabled: configured, count: train?.attendance_station_count ?? 5, codes: train?.attendance_station_codes ?? [],
  });
  const attError = attendanceConfigError({ ...att, route });

  function submit(e) {
    e.preventDefault();
    if (attError) return;
    const { train_no, coaches, ...fields } = f;
    // Sent only when station-wise attendance is on, or was on and is being turned off.
    const attendance = att.enabled
      ? { attendance_station_count: Number(att.count), attendance_station_codes: inRouteOrder(route, att.codes) }
      : configured ? { attendance_station_count: null, attendance_station_codes: null } : {};
    save.run(async () => {
      if (train) {
        await api.patch(`/trains/${train.id}`, { ...fields, ...attendance });
        if (coaches !== coachText(train.coaches)) await api.put(`/trains/${train.id}/coaches`, { coaches: parseCoaches(coaches) });
      } else {
        await api.post('/trains', { ...fields, division_id: divisionId, train_no: train_no.toUpperCase(), coaches: parseCoaches(coaches) });
      }
    }, train ? 'Train updated.' : 'Train created.');
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Train no." hint="e.g. 12951 or 12951 / 12952"><input className="input" required disabled={!!train} value={f.train_no} onChange={set('train_no')} /></Field>
        <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Duration (days)"><input type="number" min={0} max={15} className="input" value={f.duration_days} onChange={set('duration_days')} /></Field>
        <Field label="Operational days"><input type="number" min={1} max={30} className="input" value={f.operational_days} onChange={set('operational_days')} /></Field>
        <Field label="Inspection rounds / day"><input type="number" min={1} max={20} className="input" value={f.inspection_rounds_per_day} onChange={set('inspection_rounds_per_day')} /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.before_inspection_enabled} onChange={set('before_inspection_enabled')} /> Before inspection</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.after_inspection_enabled} onChange={set('after_inspection_enabled')} /> After inspection</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.daywise} onChange={set('daywise')} /> Day-wise</label>
      </div>
      <Field label="Coaches" hint="Comma separated, e.g. B1, B2, S1, GEN. The class comes from the code (B, A, H, M = AC; S = Non-AC; GEN = General); write AC, NON-AC or GEN after a code to set it yourself.">
        <textarea className="input h-20 py-3" required value={f.coaches} onChange={set('coaches')} />
      </Field>
      <CoachBreakdown coaches={parseCoaches(f.coaches)} />
      <AttendanceConfig train={train} value={att} onChange={setAtt} route={route} onRoute={setRoute} />
      <SubmitBar busy={save.busy} disabled={!!attError} label={train ? 'Save Train' : 'Create train'} onCancel={onClose} />
    </form>
  );
}

function Trains({ divisionId }) {
  const { canIn } = useSession();
  const manage = canIn('trains.manage', divisionId);
  const res = useResource('/trains', { division_id: divisionId, page_size: 200 });
  const [edit, setEdit] = useState(null);
  const done = () => { setEdit(null); res.reload(); };
  return (
    <Panel title="Trains & coaches" actions={manage && <button type="button" className="btn-secondary" onClick={() => setEdit('new')}><PlusIcon /> Add train</button>}>
      <DataState res={res} empty="No trains configured for this division.">
        {(page) => (
          <Table rows={page.items} onRowClick={manage ? setEdit : undefined} columns={[
            { key: 'train_no', label: 'Train', render: (t) => <><span className="font-semibold">{t.train_no}</span><span className="block text-xs text-slate-500">{t.name}</span></> },
            { key: 'coaches', label: 'Coaches', render: (t) => <span className="text-xs">{coachText(t.coaches)}</span> },
            { key: 'rounds', label: 'Rounds/day', render: (t) => t.inspection_rounds_per_day },
            { key: 'attendance', label: 'Attendance', render: (t) => (t.attendance_station_count ? `${t.attendance_station_count} stations` : '5 stages') },
            { key: 'is_active', label: 'Status', render: (t) => <Badge tone={t.is_active ? 'green' : 'slate'}>{t.is_active ? 'Active' : 'Inactive'}</Badge> },
          ]} />
        )}
      </DataState>
      <Dialog open={!!edit} title={edit === 'new' ? 'Add train' : 'Edit train'} onClose={() => setEdit(null)} wide>
        {edit && <TrainForm train={edit === 'new' ? null : edit} divisionId={divisionId} onClose={() => setEdit(null)} onSaved={done} />}
      </Dialog>
    </Panel>
  );
}

export default function Masters({ parts = [] }) {
  const { can } = useSession();
  const division = useDivision();
  const sections = visibleSections(can);
  const [section, userId] = parts;
  const known = sections.some((s) => s.key === section);
  // #/masters (or a section this user cannot open) lands on the first section, replacing the history
  // entry so Back does not bounce through the bare route.
  const first = sections[0]?.key;
  useEffect(() => {
    if (!known && first) location.replace(`#/masters/${first}`);
  }, [known, first]);
  if (!known) return null;
  const title = sections.find((s) => s.key === section)?.label;
  const filtered = usesDivisionFilter(section, userId);
  return (
    <>
      <PageHeader title="Master data"
        subtitle={<><span className="hidden lg:inline">{title}{filtered ? ' · ' : ''}</span>{filtered && <span className="text-slate-500">{division.current && divisionLabel(division, division.current)}</span>}</>}
        actions={filtered ? <DivisionPicker division={division} /> : null} />
      <MastersMobileNav path={`/masters/${parts.join('/')}`} />
      {section === 'trains' && <Trains divisionId={division.divisionId} />}
      {section === 'users' && (userId ? <UserProfile key={userId} userId={userId} division={division} /> : <Users division={division} />)}
      {section === 'divisions' && <Divisions />}
      {section === 'clients' && <Clients />}
      {section === 'setup' && <OfficeSetupSection />}
      {section === 'roles' && <RolePermissions divisionId={division.divisionId} divisionName={division.current?.name}
        clientId={division.current?.client_id} clientName={division.client?.name} divisionKind={division.current?.kind} />}
      {section === 'questions' && <QuestionBanks divisionId={division.divisionId} />}
      {section === 'categories' && <Categories divisionId={division.divisionId} />}
      {section === 'departments' && <Departments divisionId={division.divisionId} />}
      {section === 'items' && <InventoryItems divisionId={division.divisionId} />}
      {section === 'policy' && <DivisionPolicy divisionId={division.divisionId} divisionName={division.current?.name} />}
    </>
  );
}
