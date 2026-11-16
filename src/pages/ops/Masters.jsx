import { useState } from 'react';
import { useResource, useSession, ROLE_NAMES } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { useSave } from './masters/common.jsx';
import QuestionBanks from './masters/QuestionBanks.jsx';
import { Categories, Departments } from './masters/ComplaintMasters.jsx';
import InventoryItems from './masters/InventoryItems.jsx';
import DivisionPolicy from './masters/DivisionPolicy.jsx';
import FaceEnrollDialog from './masters/FaceEnrollment.jsx';
import { Badge, DataState, Dialog, ErrorNote, Field, PageHeader, Panel, Select, SubmitBar, Table, Tabs, label } from '../../components/ui.jsx';
import { PlusIcon, UserIcon } from '../../components/Icons.jsx';

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

// Shown once, after a sign-in is created: the password exists nowhere else, so it is this or nothing.
function SignInCreated({ user, result, onClose }) {
  return (
    <div className="space-y-3" data-testid="signin-created">
      <p className="text-sm text-slate-700">
        <b>{user.name}</b> can now sign in with <b>{user.email}</b> or employee ID <b>{user.emp_id}</b>.
      </p>
      {result.temp_password ? (
        <>
          <Field label="Password"><input className="input font-mono" readOnly value={result.temp_password} data-testid="temp-password" /></Field>
          <p className="text-xs text-amber-800">
            Write it down and give it to them now. It is not stored anywhere and cannot be shown again.
          </p>
        </>
      ) : result.signin === 'existing' ? (
        <p className="text-sm text-slate-600">
          They had already registered with this address, so their existing password still applies. Nothing was changed.
        </p>
      ) : (
        <p className="text-sm text-slate-600">They sign in with the password you chose.</p>
      )}
      <button type="button" className="btn-primary h-12 w-full" onClick={onClose}>Done</button>
    </div>
  );
}

function UserForm({ divisionId, onClose, onSaved }) {
  const { api, user } = useSession();
  const [created, setCreated] = useState(null);
  const save = useSave((u) => { setCreated(u); onSaved?.(u); });
  const [f, setF] = useState({ emp_id: '', name: '', email: '', mobile: '', designation: '', role_id: '5', password: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target?.value ?? e }));
  const roles = Object.entries(ROLE_NAMES).filter(([id]) => Number(id) > user.role_id);
  if (created) return <SignInCreated user={created} result={created} onClose={onClose} />;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.post('/users', { ...f, role_id: Number(f.role_id), division_id: divisionId, email: f.email || null, mobile: f.mobile || null, designation: f.designation || null, password: f.password || null }), 'User created.'); }} className="space-y-3">
      <ErrorNote error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee ID"><input className="input" required value={f.emp_id} onChange={set('emp_id')} /></Field>
        <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Email" hint="Their sign-in is created with this address"><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile"><input className="input" pattern="[6-9][0-9]{9}" value={f.mobile} onChange={set('mobile')} /></Field>
        <Field label="Designation"><input className="input" value={f.designation} onChange={set('designation')} /></Field>
        <Field label="Role"><Select value={f.role_id} onChange={set('role_id')} options={roles.map(([value, l]) => ({ value, label: l }))} /></Field>
        {f.email && (
          <Field label="Password" hint="At least 8 characters. Leave empty and one is generated for you.">
            <input className="input" type="text" minLength={8} autoComplete="new-password" value={f.password} onChange={set('password')} />
          </Field>
        )}
      </div>
      <SubmitBar busy={save.busy} label="Create user" onCancel={onClose} />
    </form>
  );
}

// For employees created before sign-ins came with the record: gives them one without a server command.
function SignInForm({ user, onClose, onSaved }) {
  const { api } = useSession();
  const [created, setCreated] = useState(null);
  const save = useSave((u) => { setCreated(u); onSaved?.(u); });
  const [password, setPassword] = useState('');
  if (created) return <SignInCreated user={created} result={created} onClose={onClose} />;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.post(`/users/${user.id}/signin`, { password: password || null }), 'Sign-in created.'); }} className="space-y-3">
      <ErrorNote error={save.error} />
      <p className="text-sm text-slate-600">
        <b>{user.name}</b> has no sign-in yet, so they cannot open the app. This creates one for <b>{user.email}</b>.
      </p>
      <Field label="Password" hint="At least 8 characters. Leave empty and one is generated for you.">
        <input className="input" type="text" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <SubmitBar busy={save.busy} label="Create sign-in" onCancel={onClose} />
    </form>
  );
}

function Users({ divisionId }) {
  const { canIn, api } = useSession();
  const manage = canIn('users.manage', divisionId);
  const notify = useNotify();
  const [q, setQ] = useState('');
  const res = useResource('/users', { division_id: divisionId, q, page_size: 200 });
  const [creating, setCreating] = useState(false);
  const [faceFor, setFaceFor] = useState(null);
  const [signInFor, setSignInFor] = useState(null);
  async function toggle(u) {
    try {
      await api.post(`/users/${u.id}/status`, { status: u.status === 'active' ? 'inactive' : 'active' });
      res.reload();
    } catch (e) {
      notify('error', e.message);
    }
  }
  return (
    <Panel title="Users" actions={manage && <button type="button" className="btn-secondary" onClick={() => setCreating(true)}><PlusIcon /> Add user</button>}>
      <input className="input mb-3 h-10" placeholder="Search name or employee ID" value={q} onChange={(e) => setQ(e.target.value)} />
      <DataState res={res} empty="No users found.">
        {(page) => (
          <Table rows={page.items} columns={[
            { key: 'name', label: 'Name', render: (u) => <><span className="font-medium">{u.name}</span><span className="block text-xs text-slate-500">{u.emp_id} · {u.email ?? 'no email'}</span></> },
            { key: 'role', label: 'Role', render: (u) => ROLE_NAMES[u.role_id] },
            // "Not linked" means the employee cannot sign in at all. Where that can be put right here and
            // now, the badge is the button that does it, rather than a dead-end label.
            { key: 'firebase_linked', label: 'Sign-in', render: (u) => (
              u.firebase_linked ? <Badge tone="green">Linked</Badge>
                : manage && u.email ? (
                  <button type="button" className="btn-secondary h-9 text-xs" onClick={(e) => { e.stopPropagation(); setSignInFor(u); }}
                    aria-label={`Create sign-in for ${u.name}`}>Create sign-in</button>
                ) : <Badge tone="amber" title={u.email ? undefined : 'Add an email address first'}>Not linked</Badge>
            ) },
            { key: 'status', label: 'Status', render: (u) => manage
              ? <button type="button" onClick={() => toggle(u)}><Badge tone={u.status === 'active' ? 'green' : 'slate'}>{label(u.status)}</Badge></button>
              : <Badge tone={u.status === 'active' ? 'green' : 'slate'}>{label(u.status)}</Badge> },
            ...(manage ? [{ key: 'face', label: '', render: (u) => (
              <button type="button" className="btn-secondary h-9 text-xs" onClick={(e) => { e.stopPropagation(); setFaceFor(u); }}
                aria-label={`Face registration for ${u.name}`}><UserIcon /> Face</button>
            ) }] : []),
          ]} />
        )}
      </DataState>
      {faceFor && <FaceEnrollDialog user={faceFor} onClose={() => setFaceFor(null)} />}
      <Dialog open={!!signInFor} title="Create sign-in" onClose={() => setSignInFor(null)}>
        {signInFor && <SignInForm user={signInFor} onClose={() => setSignInFor(null)} onSaved={res.reload} />}
      </Dialog>
      <Dialog open={creating} title="Add user" onClose={() => setCreating(false)} wide>
        {/* The dialog stays open after saving: it now shows the new sign-in's password, which exists
            nowhere else. Closing it is the "Done" button's job. */}
        <UserForm divisionId={divisionId} onClose={() => setCreating(false)} onSaved={res.reload} />
      </Dialog>
    </Panel>
  );
}

function Divisions() {
  const { api, can } = useSession();
  const res = useResource('/divisions');
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ code: '', name: '' });
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
        <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.post('/divisions', { code: f.code.toUpperCase(), name: f.name }), 'Division created.'); }} className="space-y-3">
          <ErrorNote error={save.error} />
          <Field label="Code" hint="Uppercase letters, digits, underscore"><input className="input" required pattern="[A-Za-z0-9_]{2,16}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <SubmitBar busy={save.busy} label="Create" onCancel={() => setCreating(false)} />
        </form>
      </Dialog>
    </Panel>
  );
}

export default function Masters() {
  const { can } = useSession();
  const division = useDivision();
  const tabs = [
    (can('trains.read') || can('trains.manage')) && { value: 'trains', label: 'Trains & coaches' },
    can('users.read') && { value: 'users', label: 'Users' },
    { value: 'divisions', label: 'Divisions' },
    // Readable by every member of the division (backend list endpoints); changes need the manage permission.
    { value: 'questions', label: 'Question banks' },
    { value: 'categories', label: 'Complaint categories' },
    { value: 'departments', label: 'Complaint departments' },
    { value: 'items', label: 'Inventory items' },
    { value: 'policy', label: 'Division policy' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0].value);
  return (
    <>
      <PageHeader title="Master data" subtitle={division.current?.name} actions={<DivisionPicker division={division} />} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'trains' && <Trains divisionId={division.divisionId} />}
      {tab === 'users' && <Users divisionId={division.divisionId} />}
      {tab === 'divisions' && <Divisions />}
      {tab === 'questions' && <QuestionBanks divisionId={division.divisionId} />}
      {tab === 'categories' && <Categories divisionId={division.divisionId} />}
      {tab === 'departments' && <Departments divisionId={division.divisionId} />}
      {tab === 'items' && <InventoryItems divisionId={division.divisionId} />}
      {tab === 'policy' && <DivisionPolicy divisionId={division.divisionId} divisionName={division.current?.name} />}
    </>
  );
}
