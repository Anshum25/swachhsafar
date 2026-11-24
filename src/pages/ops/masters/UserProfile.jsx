// Master Data · Users · one user's profile (#/masters/users/<id>). Shows only what the backend holds:
// the user record (/users/{id}), account facts and effective permissions (/users/{id}/account) and the
// biometric registration status (/users/{id}/face, /fingerprint), which carries metadata, never templates.
import { useState } from 'react';
import { ROLE_NAMES, useResource } from '../../../app/session.jsx';
import { Badge, DetailList, Dialog, ErrorNote, Loading, Panel, fmtDateTime, label } from '../../../components/ui.jsx';
import { ArrowLeftIcon, FingerprintIcon, KeyIcon, UserIcon } from '../../../components/Icons.jsx';
import FaceEnrollDialog from './FaceEnrollment.jsx';
import FingerprintEnrollDialog from './FingerprintEnrollment.jsx';
import { RowMenu } from './Users.jsx';
import {
  DeleteUserDialog, EditUserDialog, ResetPasswordDialog, SignInForm, StatusDialog, TransferUserDialog, useCanManageUser,
} from './UserDialogs.jsx';
import { navigate } from '../../../app/router.js';

const GENDER = { M: 'Male', F: 'Female', O: 'Other' };
const LANG = { en: 'English', hi: 'Hindi' };
const SET_BY = { admin: 'an administrator', user: 'the employee', cli: 'a server command', firebase: 'import from the previous sign-in system' };
const FINGER = (f) => label(f.replace(/_/g, ' ').toLowerCase());

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function Section({ title, children, actions }) {
  return <Panel title={title} actions={actions} className="mb-4">{children}</Panel>;
}

// permission codes grouped by module: 'users.manage' -> users: [manage]
function Permissions({ codes }) {
  const groups = codes.reduce((acc, c) => {
    const [mod, ...rest] = c.split('.');
    (acc[mod] ??= []).push(rest.join('.') || mod);
    return acc;
  }, {});
  if (!codes.length) return <p className="text-sm text-slate-500">This role holds no permissions in this division.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="user-permissions">
      {Object.entries(groups).map(([mod, list]) => (
        <div key={mod}>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{label(mod)}</p>
          <div className="flex flex-wrap gap-1">{list.map((p) => <Badge key={p} tone="brand">{label(p)}</Badge>)}</div>
        </div>
      ))}
    </div>
  );
}

export default function UserProfile({ userId, division }) {
  const res = useResource(`/users/${userId}`);
  const account = useResource(`/users/${userId}/account`);
  const face = useResource(`/users/${userId}/face`);
  const finger = useResource(`/users/${userId}/fingerprint`);
  const [dialog, setDialog] = useState(null);
  const user = res.data;
  const manage = useCanManageUser(user);
  const reloadAll = () => { res.reload(); account.reload(); face.reload(); finger.reload(); };
  const close = () => setDialog(null);

  const back = (
    <a href="#/masters/users" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline" data-testid="back-to-users">
      <ArrowLeftIcon className="h-4 w-4" /> Back to Users
    </a>
  );
  if (res.loading && !user) return <>{back}<Loading /></>;
  if (!user) return <>{back}<ErrorNote error={res.error ?? { message: 'User not found.' }} onRetry={res.reload} /></>;

  const acc = account.data;
  const f = face.data;
  const fp = finger.data;
  const active = user.status === 'active';
  const divisionName = acc?.division_name ?? division.divisions.find((d) => d.id === user.division_id)?.name;

  return (
    <div data-testid="user-profile">
      {back}
      <section className="card mb-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-700 text-lg font-bold text-white sm:h-16 sm:w-16 sm:text-xl" aria-hidden="true">{initials(user.name)}</span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-ink sm:text-xl">{user.name}</h2>
            <p className="text-sm text-muted">Employee ID {user.emp_id}{user.designation ? ` · ${user.designation}` : ''}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="brand">{ROLE_NAMES[user.role_id]}</Badge>
              <Badge tone={active ? 'green' : 'slate'}>{label(user.status)}</Badge>
              {divisionName && <Badge>{divisionName}</Badge>}
            </div>
          </div>
          {manage && (
            // Phones: Edit | Password | ⋯ as one even row; from 640px the buttons sit beside the name.
            <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 sm:flex sm:w-auto sm:items-center">
              <button type="button" className="btn-primary h-11 min-w-0 px-3 sm:px-4" onClick={() => setDialog('edit')}><span className="truncate">Edit user</span></button>
              {user.password_set
                ? <button type="button" className="btn-secondary h-11 min-w-0 px-3" onClick={() => setDialog('password')}><KeyIcon className="h-4 w-4 shrink-0" /><span className="truncate"><span className="hidden min-[400px]:inline">Change </span>password</span></button>
                : <button type="button" className="btn-secondary h-11 min-w-0 px-3" onClick={() => setDialog('signin')}><KeyIcon className="h-4 w-4 shrink-0" /><span className="truncate">Create sign-in</span></button>}
              <RowMenu user={user} label="More user actions" className="icon-btn h-11 w-11 rounded-xl ring-1 ring-line" items={[
                { label: user.face_enrolled ? 'Re-register face' : 'Register face', onClick: () => setDialog('face') },
                { label: user.fingerprint_enrolled ? 'Re-register fingers' : 'Register fingers', onClick: () => setDialog('finger') },
                { label: 'Move to another station', onClick: () => setDialog('move') },
                { label: active ? 'Deactivate user' : 'Activate user', danger: active, onClick: () => setDialog('status') },
                { label: 'Delete user', danger: true, onClick: () => setDialog('delete') },
              ]} />
            </div>
          )}
        </div>
      </section>

      <div className="grid gap-x-4 xl:grid-cols-2">
        <Section title="Personal information">
          <DetailList items={[
            ['Full name', user.name],
            user.name_hindi && ['Name (Hindi)', user.name_hindi],
            ['Employee ID', user.emp_id],
            ['Email address', user.email],
            ['Mobile number', user.mobile],
            ['Gender', GENDER[user.gender]],
            ['Language', LANG[user.lang] ?? user.lang],
          ]} />
        </Section>
        <Section title="Employment">
          <DetailList items={[
            ['Role', ROLE_NAMES[user.role_id]],
            ['Division', acc ? `${acc.division_name} (${acc.division_code})` : divisionName],
            ['Designation', user.designation],
            ['Account status', <Badge key="s" tone={active ? 'green' : 'slate'}>{label(user.status)}</Badge>],
          ]} />
        </Section>
        <Section title="Authentication">
          <DetailList items={[
            ['Password login', user.password_set ? <Badge key="p" tone="green">Enabled</Badge> : <Badge key="p" tone="amber">No password set</Badge>],
            acc?.password_changed_at && ['Password last set', `${fmtDateTime(acc.password_changed_at)}${SET_BY[acc.password_set_by] ? ` by ${SET_BY[acc.password_set_by]}` : ''}`],
            ['Mobile OTP', user.mobile ? 'Available (mobile on record)' : 'Not available (no mobile)'],
            ['Face authentication', user.face_enrolled ? <Badge key="f" tone="green">Registered</Badge> : <Badge key="f">Not registered</Badge>],
            ['Fingerprint authentication', user.fingerprint_enrolled ? <Badge key="g" tone="green">Registered</Badge> : <Badge key="g">Not registered</Badge>],
            acc && ['Active sessions', acc.active_sessions],
          ]} />
        </Section>
        <Section title="Account">
          {account.error && !acc ? <ErrorNote error={account.error} onRetry={account.reload} /> : (
            <DetailList items={[
              ['Created', fmtDateTime(acc?.created_at)],
              ['Created by', acc?.created_by ? `${acc.created_by.name} (${acc.created_by.emp_id})` : null],
              ['Last updated', fmtDateTime(acc?.updated_at ?? user.updated_at)],
              ['Last sign-in', acc ? (acc.last_sign_in_at ? fmtDateTime(acc.last_sign_in_at) : 'Never signed in') : null],
            ]} />
          )}
        </Section>
      </div>

      <Section title="Biometric registration" actions={manage && (
        <div className="flex gap-2">
          <button type="button" className="btn-secondary h-9 text-xs" onClick={() => setDialog('face')}><UserIcon /> {user.face_enrolled ? 'Re-register face' : 'Register face'}</button>
          <button type="button" className="btn-secondary h-9 text-xs" onClick={() => setDialog('finger')}><FingerprintIcon className="h-4 w-4" /> {user.fingerprint_enrolled ? 'Re-register fingers' : 'Register fingers'}</button>
        </div>
      )}>
        <div className="grid gap-4 sm:grid-cols-2" data-testid="user-biometrics">
          <div>
            <p className="mb-2 text-sm font-bold text-ink">Face</p>
            {face.error && !f ? <ErrorNote error={face.error} onRetry={face.reload} /> : (
              <DetailList items={[
                ['Status', f?.enrolled ? 'Registered' : 'Not registered'],
                f?.enrolled && ['Samples', f.samples],
                f?.enrolled && ['Model', f.model],
                f?.enrolled && ['Consent recorded', fmtDateTime(f.consent_at)],
                f?.enrolled && ['Last registered', fmtDateTime(f.updated_at)],
              ]} />
            )}
          </div>
          <div>
            <p className="mb-2 text-sm font-bold text-ink">Fingerprint</p>
            {finger.error && !fp ? <ErrorNote error={finger.error} onRetry={finger.reload} /> : (
              <DetailList items={[
                ['Status', fp?.enrolled ? 'Registered' : 'Not registered'],
                fp?.enrolled && ['Fingers', `${fp.fingers.length} · ${fp.fingers.map(FINGER).join(', ')}`],
                fp?.enrolled && ['Consent recorded', fmtDateTime(fp.consent_at)],
                fp?.enrolled && ['Last registered', fmtDateTime(fp.updated_at)],
              ]} />
            )}
          </div>
        </div>
      </Section>

      <Section title="Permissions">
        {account.error && !acc ? <ErrorNote error={account.error} onRetry={account.reload} />
          : !acc ? <Loading /> : (
            <>
              <p className="mb-3 text-sm text-muted">
                Effective access of the <b>{acc.role_name}</b> role in {acc.division_name}. Permissions are granted per role (and per-division
                overrides), so they change with the user&apos;s role.
              </p>
              <Permissions codes={acc.permissions} />
            </>
          )}
      </Section>

      {dialog === 'edit' && <EditUserDialog user={user} division={division} onClose={close} onSaved={reloadAll} />}
      {dialog === 'password' && <ResetPasswordDialog user={user} onClose={close} onDone={reloadAll} />}
      {dialog === 'status' && <StatusDialog user={user} onClose={close} onDone={reloadAll} />}
      {dialog === 'move' && <TransferUserDialog user={user} division={division} onClose={close} onSaved={reloadAll} />}
      {/* A deleted user has no profile to come back to: return to the list. */}
      {dialog === 'delete' && <DeleteUserDialog user={user} onClose={close} onDone={() => navigate('/masters/users')} />}
      {dialog === 'face' && <FaceEnrollDialog user={user} onClose={() => { close(); reloadAll(); }} />}
      {dialog === 'finger' && <FingerprintEnrollDialog user={user} onClose={() => { close(); reloadAll(); }} />}
      <Dialog open={dialog === 'signin'} title="Create sign-in" onClose={close}>
        {dialog === 'signin' && <SignInForm user={user} onClose={close} onSaved={reloadAll} />}
      </Dialog>
    </div>
  );
}
