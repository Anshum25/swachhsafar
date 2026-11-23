// User-management dialogs shared by the Users list and the user profile: add user, edit user, admin password
// reset, create sign-in and activate/deactivate. Every one writes through the FastAPI /users endpoints.
import { useEffect, useMemo, useState } from 'react';
import { ROLE_NAMES, useSession } from '../../../app/session.jsx';
import { divisionLabel } from '../../../app/division.jsx';
import { useNotify } from '../../../app/Layout.jsx';
import { ConfirmDialog, Dialog, ErrorNote, Field, Select, SubmitBar } from '../../../components/ui.jsx';
import PasswordInput from '../../../components/PasswordInput.jsx';
import { validatePassword } from '../../../utils/validation.js';
import { useSave } from './common.jsx';

// Mirrors backend app/security/catalog.py MANAGEABLE_ROLES (the server stays authoritative).
export const MANAGEABLE_ROLES = { 1: [2, 3, 4, 5, 6], 2: [3, 4, 5, 6], 3: [4, 5] };
export const canManageRole = (actorRole, targetRole) => (MANAGEABLE_ROLES[actorRole] ?? []).includes(Number(targetRole));
export const roleOptions = (actorRole) => (MANAGEABLE_ROLES[actorRole] ?? []).map((id) => ({ value: String(id), label: ROLE_NAMES[id] }));

// May the signed-in user manage `target` (permission in its division + role hierarchy), and is it not themself?
export function useCanManageUser(target) {
  const { canIn, user } = useSession();
  return !!target && target.id !== user.id && canIn('users.manage', target.division_id) && canManageRole(user.role_id, target.role_id);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^[6-9][0-9]{9}$/;

// Field-level checks matching backend app/schemas/org.py UserUpdate / UserCreate.
export function validateUserFields(f) {
  const e = {};
  const name = f.name.trim();
  if (name.length < 2 || name.length > 100) e.name = 'Name must be 2–100 characters.';
  if (f.name_hindi && f.name_hindi.length > 100) e.name_hindi = 'At most 100 characters.';
  if (f.email && !EMAIL_RE.test(f.email.trim())) e.email = 'Enter a valid email address.';
  if (f.mobile && !MOBILE_RE.test(f.mobile.trim())) e.mobile = 'A 10-digit mobile number starting with 6–9.';
  if (f.designation && f.designation.length > 100) e.designation = 'At most 100 characters.';
  if (!f.role_id) e.role_id = 'Choose a role.';
  if ('division_id' in f && !f.division_id) e.division_id = 'Choose a division.';
  return e;
}

// Server validation errors ({ loc: ['body', 'email'], msg }) -> { email: msg }.
export function serverFieldErrors(error) {
  const list = error?.detail?.details;
  if (!Array.isArray(list)) return {};
  return Object.fromEntries(list.filter((d) => d.loc?.[0] === 'body' && d.loc[1]).map((d) => [d.loc[1], d.msg]));
}

const blank = (v) => (v === null || v === undefined ? '' : String(v));
const orNull = (v) => (v.trim() === '' ? null : v.trim());

function userToForm(u) {
  return {
    name: blank(u.name), name_hindi: blank(u.name_hindi), email: blank(u.email), mobile: blank(u.mobile), gender: blank(u.gender),
    designation: blank(u.designation), lang: u.lang ?? 'en', role_id: String(u.role_id), division_id: String(u.division_id),
  };
}

// Only the fields that changed, in the shape PATCH /users/{id} expects.
export function userChanges(user, f) {
  const next = {
    name: f.name.trim(), name_hindi: orNull(f.name_hindi), email: f.email.trim() ? f.email.trim().toLowerCase() : null,
    mobile: orNull(f.mobile), gender: f.gender || null, designation: orNull(f.designation), lang: f.lang,
    role_id: Number(f.role_id), division_id: f.division_id,
  };
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, user[k] ?? null]));
  before.email = before.email ? before.email.toLowerCase() : null;
  before.division_id = String(before.division_id);
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== before[k]));
}

// Warns before a dirty form is lost to a reload or tab close.
function useLeaveGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

const GENDERS = [{ value: 'M', label: 'Male' }, { value: 'F', label: 'Female' }, { value: 'O', label: 'Other' }];
const LANGS = [{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिन्दी (Hindi)' }];

// `division`: the page's useDivision(). Division choices are labelled with their office when the editor
// sees more than one, since two offices may well both have a "Headquarters".
export function EditUserDialog({ user, division, onClose, onSaved }) {
  const { api, user: me } = useSession();
  const notify = useNotify();
  const initial = useMemo(() => userToForm(user), [user]);
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const changes = userChanges(user, f);
  const dirty = Object.keys(changes).length > 0;
  useLeaveGuard(dirty);
  const set = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setF((x) => ({ ...x, [k]: v }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };
  // The user's current role/division stay selectable even where the editor could not assign them anew.
  const roles = roleOptions(me.role_id);
  if (!roles.some((r) => r.value === String(user.role_id))) roles.unshift({ value: String(user.role_id), label: ROLE_NAMES[user.role_id] });
  const divs = division.divisions.map((d) => ({ value: String(d.id), label: divisionLabel(division, d) }));
  if (!divs.some((d) => d.value === String(user.division_id))) divs.unshift({ value: String(user.division_id), label: 'Current division' });
  const sensitive = 'role_id' in changes || 'division_id' in changes;

  function close() {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    onClose();
  }

  async function save() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const saved = await api.patch(`/users/${user.id}`, changes);
      notify('success', 'User updated.');
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setErrors(serverFieldErrors(e));
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    const found = validateUserFields(f);
    setErrors(found);
    if (Object.keys(found).length || !dirty) return;
    if (sensitive) setConfirming(true);
    else save();
  }

  return (
    <Dialog open title={`Edit user · ${user.name}`} onClose={close} wide onSubmit={submit}
      footer={<SubmitBar flush busy={busy} disabled={!dirty} label={dirty ? 'Save changes' : 'No changes'} onCancel={close} />}>
      <div className="space-y-4" data-testid="edit-user-form">
        <ErrorNote error={error} />
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Personal information</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" error={errors.name}><input className="input" value={f.name} onChange={set('name')} maxLength={100} /></Field>
            <Field label="Name in Hindi" error={errors.name_hindi}><input className="input" value={f.name_hindi} onChange={set('name_hindi')} maxLength={100} /></Field>
            <Field label="Employee ID" hint="The employee ID cannot be changed after creation."><input className="input" value={user.emp_id} disabled readOnly /></Field>
            <Field label="Email" error={errors.email}><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
            <Field label="Mobile" error={errors.mobile}><input className="input" inputMode="numeric" maxLength={10} value={f.mobile} onChange={set('mobile')} /></Field>
            <Field label="Gender"><Select value={f.gender} onChange={set('gender')} options={GENDERS} placeholder="Not specified" /></Field>
            <Field label="Language"><Select value={f.lang} onChange={set('lang')} options={LANGS} /></Field>
          </div>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Employment</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role" error={errors.role_id} hint="Permissions come from the role."><Select value={f.role_id} onChange={set('role_id')} options={roles} /></Field>
            <Field label="Division" error={errors.division_id}><Select value={f.division_id} onChange={set('division_id')} options={divs} /></Field>
            <Field label="Designation" error={errors.designation}><input className="input" value={f.designation} onChange={set('designation')} maxLength={100} /></Field>
          </div>
        </fieldset>
      </div>
      <ConfirmDialog open={confirming} title="Change role or division?" confirmLabel="Save changes" busy={busy}
        onClose={() => setConfirming(false)} onConfirm={save}>
        <p>
          {'role_id' in changes && <>Role: <b>{ROLE_NAMES[user.role_id]}</b> → <b>{ROLE_NAMES[changes.role_id]}</b>. </>}
          {'division_id' in changes && <>The employee moves to <b>{divs.find((d) => d.value === changes.division_id)?.label}</b>. </>}
        </p>
        <p>This changes what {user.name} can see and do from their next request.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

export function ResetPasswordDialog({ user, onClose, onDone }) {
  const { api } = useSession();
  const notify = useNotify();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nextError = touched || next ? validatePassword(next) : null;
  const confirmError = confirm && confirm !== next ? 'The two passwords do not match.' : null;

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (busy || validatePassword(next) || next !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.post(`/users/${user.id}/password`, { new_password: next });
      // The fields are cleared before anything else happens: the password lives nowhere but the server's hash.
      setNext('');
      setConfirm('');
      const n = out?.sessions_ended ?? 0;
      notify('success', `Password changed for ${user.name}.${n ? ` Signed out of ${n} session${n === 1 ? '' : 's'}.` : ''}`);
      onDone?.();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Change password" onClose={onClose} onSubmit={submit}
      footer={<SubmitBar flush busy={busy} disabled={!next || !confirm} label="Set new password" onCancel={onClose} />}>
      <div className="space-y-3" data-testid="reset-password-form">
        <ErrorNote error={error} />
        <p className="text-sm text-slate-600">
          Set a new password for <b>{user.name}</b> ({user.emp_id}). They are signed out on every device and sign in again with the new password.
        </p>
        <PasswordInput label="New password" value={next} onChange={setNext} error={nextError} showStrength />
        <PasswordInput label="Confirm new password" value={confirm} onChange={setConfirm} error={confirmError} placeholder="Repeat the new password" />
      </div>
    </Dialog>
  );
}

export function StatusDialog({ user, onClose, onDone }) {
  const { api } = useSession();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const activate = user.status !== 'active';
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post(`/users/${user.id}/status`, { status: activate ? 'active' : 'inactive' });
      notify('success', activate ? `${user.name} is active again.` : `${user.name} is deactivated.`);
      onDone?.(saved);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog open title={activate ? 'Activate user' : 'Deactivate user'} danger={!activate} busy={busy}
      confirmLabel={activate ? 'Activate' : 'Deactivate'} onClose={onClose} onConfirm={confirm}>
      <ErrorNote error={error} />
      {activate
        ? <p><b>{user.name}</b> will be able to sign in and use the app again.</p>
        : <p><b>{user.name}</b> will no longer be able to sign in. Requests from devices already signed in are refused. Their records are kept.</p>}
    </ConfirmDialog>
  );
}

// Shown once, after a sign-in is created: the password exists nowhere else, so it is this or nothing.
export function SignInCreated({ user, result, onClose }) {
  return (
    <div className="space-y-3" data-testid="signin-created">
      <p className="text-sm text-slate-700">
        <b>{user.name}</b> can now sign in with employee ID <b>{user.emp_id}</b>{user.email ? <> or <b>{user.email}</b></> : null}.
      </p>
      {result.temp_password ? (
        <>
          <Field label="Password"><input className="input font-mono" readOnly value={result.temp_password} data-testid="temp-password" /></Field>
          <p className="text-xs text-amber-800">
            Write it down and give it to them now. It is not stored anywhere and cannot be shown again.
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-600">They sign in with the password you chose.</p>
      )}
      <button type="button" className="btn-primary h-12 w-full" onClick={onClose}>Done</button>
    </div>
  );
}

// `division`: the page's useDivision(). The new user starts in the office and division the page is showing;
// the form lets that be changed to any office and division where the signed-in user may manage users.
export function UserForm({ division, onClose, onSaved }) {
  const { api, user, canIn } = useSession();
  const [clientId, setClientId] = useState(division.clientId);
  const [divisionId, setDivisionId] = useState(division.divisionId);
  const manageable = division.divisions.filter((d) => canIn('users.manage', d.id));
  const offices = division.clients.filter((c) => manageable.some((d) => d.client_id === c.id));
  const officeDivisions = manageable.filter((d) => !offices.length || d.client_id === clientId);
  const chooseOffice = (cid) => {
    setClientId(cid);
    setDivisionId(manageable.find((d) => d.client_id === cid)?.id ?? null);
  };
  const [created, setCreated] = useState(null);
  const save = useSave((u) => { setCreated(u); onSaved?.(u); });
  const [f, setF] = useState({ emp_id: '', name: '', email: '', mobile: '', designation: '', role_id: '5', password: '' });
  const [errors, setErrors] = useState({});
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target?.value ?? e })); setErrors((x) => ({ ...x, [k]: undefined })); };
  const roles = roleOptions(user.role_id);
  if (created) return <SignInCreated user={created} result={created} onClose={onClose} />;
  function submit(e) {
    e.preventDefault();
    if (save.busy) return;
    const found = validateUserFields(f);
    if (!f.emp_id.trim()) found.emp_id = 'Employee ID is required.';
    if (f.password && validatePassword(f.password)) found.password = validatePassword(f.password);
    if (!divisionId) found.division_id = 'Choose a division.';
    setErrors(found);
    if (Object.keys(found).length) return;
    save.run(() => api.post('/users', {
      ...f, emp_id: f.emp_id.trim(), name: f.name.trim(), role_id: Number(f.role_id), division_id: divisionId,
      email: f.email.trim() || null, mobile: f.mobile.trim() || null, designation: f.designation.trim() || null, password: f.password || null,
    }).catch((err) => { setErrors(serverFieldErrors(err)); throw err; }), 'User created.');
  }
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorNote error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {offices.length > 1 && (
          <Field label="Client (office)" hint="Whose modules and credits this user works under">
            <Select value={clientId ?? ''} onChange={chooseOffice} options={offices.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
        )}
        {(offices.length > 1 || officeDivisions.length > 1) && (
          <Field label="Division" error={errors.division_id}>
            <Select value={divisionId ?? ''} onChange={(v) => { setDivisionId(v); setErrors((x) => ({ ...x, division_id: undefined })); }}
              placeholder={officeDivisions.length ? undefined : 'No division you can add users to'}
              options={officeDivisions.map((d) => ({ value: d.id, label: d.name }))} />
          </Field>
        )}
        <Field label="Employee ID" error={errors.emp_id}><input className="input" required value={f.emp_id} onChange={set('emp_id')} /></Field>
        <Field label="Name" error={errors.name}><input className="input" required value={f.name} onChange={set('name')} /></Field>
        <Field label="Email" error={errors.email} hint="Optional. A sign-in is created when an email or password is given"><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile" error={errors.mobile}><input className="input" inputMode="numeric" maxLength={10} value={f.mobile} onChange={set('mobile')} /></Field>
        <Field label="Designation" error={errors.designation}><input className="input" value={f.designation} onChange={set('designation')} /></Field>
        <Field label="Role" error={errors.role_id}><Select value={f.role_id} onChange={set('role_id')} options={roles} /></Field>
        {f.email && (
          <Field label="Password" error={errors.password} hint="At least 8 characters with a letter and a number. Leave empty and one is generated for you.">
            <input className="input" type="text" minLength={8} autoComplete="new-password" value={f.password} onChange={set('password')} />
          </Field>
        )}
      </div>
      <SubmitBar busy={save.busy} label="Create user" onCancel={onClose} />
    </form>
  );
}

// For employees created before sign-ins came with the record: gives them one without a server command.
export function SignInForm({ user, onClose, onSaved }) {
  const { api } = useSession();
  const [created, setCreated] = useState(null);
  const save = useSave((u) => { setCreated(u); onSaved?.(u); });
  const [password, setPassword] = useState('');
  if (created) return <SignInCreated user={created} result={created} onClose={onClose} />;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!save.busy) save.run(() => api.post(`/users/${user.id}/signin`, { password: password || null }), 'Sign-in created.'); }} className="space-y-3">
      <ErrorNote error={save.error} />
      <p className="text-sm text-slate-600">
        <b>{user.name}</b> has no sign-in yet, so they cannot open the app with a password. This creates one.
      </p>
      <Field label="Password" hint="At least 8 characters. Leave empty and one is generated for you.">
        <input className="input" type="text" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <SubmitBar busy={save.busy} label="Create sign-in" onCancel={onClose} />
    </form>
  );
}
