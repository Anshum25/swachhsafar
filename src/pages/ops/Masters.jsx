import { useEffect, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { useSave } from './masters/common.jsx';
import QuestionBanks from './masters/QuestionBanks.jsx';
import { Categories, Departments } from './masters/ComplaintMasters.jsx';
import InventoryItems from './masters/InventoryItems.jsx';
import DivisionPolicy from './masters/DivisionPolicy.jsx';
import Users from './masters/Users.jsx';
import Clients from './masters/Clients.jsx';
import RolePermissions from './masters/RolePermissions.jsx';
import UserProfile from './masters/UserProfile.jsx';
import { MastersMobileNav } from './masters/MastersNav.jsx';
import { visibleSections } from './masters/sections.js';
import { Badge, DataState, Dialog, ErrorNote, Field, PageHeader, Panel, Select, SubmitBar, Table } from '../../components/ui.jsx';
import { PlusIcon } from '../../components/Icons.jsx';

// "B1 AC, S1, S2" -> [{code:'B1', classification:'AC'}, ...]; coaches default to Non-AC.
export function parseCoaches(text) {
  return text.split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => {
    const [code, cls] = s.split(/\s+/);
    return { code, classification: cls === 'AC' ? 'AC' : 'NON_AC' };
  });
}
const coachText = (coaches) => coaches.map((c) => `${c.code}${c.classification === 'AC' ? ' AC' : ''}`).join(', ');

function TrainForm({ train, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const save = useSave(onSaved);
  const [f, setF] = useState({
    train_no: train?.train_no ?? '', name: train?.name ?? '', duration_days: train?.duration_days ?? 1, operational_days: train?.operational_days ?? 2,
    inspection_rounds_per_day: train?.inspection_rounds_per_day ?? 1, before_inspection_enabled: train?.before_inspection_enabled ?? false,
    after_inspection_enabled: train?.after_inspection_enabled ?? true, daywise: train?.daywise ?? false, coaches: train ? coachText(train.coaches) : '',
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));

  function submit(e) {
    e.preventDefault();
    const { train_no, coaches, ...fields } = f;
    save.run(async () => {
      if (train) {
        await api.patch(`/trains/${train.id}`, fields);
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
      <Field label="Coaches" hint="Comma separated; add AC after air-conditioned coaches, e.g. B1 AC, B2 AC, S1, S2">
        <textarea className="input h-20 py-3" required value={f.coaches} onChange={set('coaches')} />
      </Field>
      <SubmitBar busy={save.busy} label={train ? 'Save' : 'Create train'} onCancel={onClose} />
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

function Divisions() {
  const { api, can } = useSession();
  const res = useResource('/divisions');
  // Every division belongs to a client (office): whose wallet its journeys spend and whose module
  // subscription its users see. Only a Super Admin creates divisions, and they can read every client.
  const clients = useResource(can('divisions.manage') ? '/clients' : null);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ code: '', name: '', client_id: '' });
  const save = useSave(() => { setCreating(false); res.reload(); });
  return (
    <Panel title="Divisions" actions={can('divisions.manage') && <button type="button" className="btn-secondary" onClick={() => setCreating(true)}><PlusIcon /> Add division</button>}>
      <DataState res={res} empty="No divisions.">
        {(rows) => (
          <Table rows={rows} columns={[
            { key: 'code', label: 'Code', render: (d) => <span className="font-semibold">{d.code}</span> },
            { key: 'name', label: 'Name' },
            { key: 'is_active', label: 'Status', render: (d) => <Badge tone={d.is_active ? 'green' : 'slate'}>{d.is_active ? 'Active' : 'Inactive'}</Badge> },
          ]} />
        )}
      </DataState>
      <Dialog open={creating} title="Add division" onClose={() => setCreating(false)}>
        <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.post('/divisions', { code: f.code.toUpperCase(), name: f.name, client_id: f.client_id }), 'Division created.'); }} className="space-y-3">
          <ErrorNote error={save.error} />
          <Field label="Code" hint="Uppercase letters, digits, underscore"><input className="input" required pattern="[A-Za-z0-9_]{2,16}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Client (office)" hint="Whose modules and credits this division uses">
            <Select value={f.client_id} onChange={(v) => setF({ ...f, client_id: v })} placeholder="Select an office"
              options={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.office_id} — ${c.name}` }))} />
          </Field>
          <SubmitBar busy={save.busy} disabled={!f.client_id} label="Create" onCancel={() => setCreating(false)} />
        </form>
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
  return (
    <>
      <PageHeader title="Master data" subtitle={<><span className="hidden lg:inline">{title} · </span><span className="text-slate-500">{division.current?.name}</span></>}
        actions={<DivisionPicker division={division} />} />
      <MastersMobileNav path={`/masters/${parts.join('/')}`} />
      {section === 'trains' && <Trains divisionId={division.divisionId} />}
      {section === 'users' && (userId ? <UserProfile key={userId} userId={userId} division={division} /> : <Users division={division} />)}
      {section === 'divisions' && <Divisions />}
      {section === 'clients' && <Clients />}
      {section === 'roles' && <RolePermissions divisionId={division.divisionId} divisionName={division.current?.name} />}
      {section === 'questions' && <QuestionBanks divisionId={division.divisionId} />}
      {section === 'categories' && <Categories divisionId={division.divisionId} />}
      {section === 'departments' && <Departments divisionId={division.divisionId} />}
      {section === 'items' && <InventoryItems divisionId={division.divisionId} />}
      {section === 'policy' && <DivisionPolicy divisionId={division.divisionId} divisionName={division.current?.name} />}
    </>
  );
}
