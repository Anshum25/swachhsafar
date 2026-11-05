// The signed-in user's profile (#/profile) and password change (#/profile/password).
import { useState } from 'react';
import { ROLE_NAMES, useSession } from '../app/session.jsx';
import { navigate } from '../app/router.js';
import { useDivision } from '../app/division.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import PasswordInput from '../components/PasswordInput.jsx';
import { AlertIcon, CheckIcon, LockIcon, Spinner, UserIcon } from '../components/Icons.jsx';
import { DetailList, PageHeader, Panel, Tabs } from '../components/ui.jsx';
import { validatePassword } from '../utils/validation.js';

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Your current password is not correct.',
  'auth/invalid-login-credentials': 'Your current password is not correct.',
  'auth/wrong-password': 'Your current password is not correct.',
  'auth/too-many-requests': 'Too many attempts. Try again later.',
  'auth/network-request-failed': 'No connection. Changing your password needs internet.',
  'auth/weak-password': 'Choose a stronger password.',
  'auth/requires-recent-login': 'Sign out and sign in again, then change your password.',
};

function ChangePassword() {
  const { changePassword } = useSession();
  const online = useNetworkStatus();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState({ busy: false, error: null, done: false });
  const nextError = next ? validatePassword(next) : null;
  const confirmError = confirm && confirm !== next ? 'The two new passwords do not match.' : null;
  const ready = online && current && next && !nextError && confirm === next && next !== current;

  async function submit(e) {
    e.preventDefault();
    setState({ busy: true, error: null, done: false });
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setState({ busy: false, error: null, done: true });
    } catch (err) {
      setState({ busy: false, error: AUTH_MESSAGES[err.code] ?? err.message, done: false });
    }
  }

  return (
    <Panel title="Change password">
      <form onSubmit={submit} className="max-w-md space-y-4">
        {!online && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Changing your password needs internet.</p>}
        <PasswordInput label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" placeholder="Your current password" />
        <PasswordInput label="New password" value={next} onChange={setNext} error={nextError} showStrength />
        <PasswordInput label="Confirm new password" value={confirm} onChange={setConfirm} error={confirmError} placeholder="Repeat the new password" />
        {next && current && next === current && <p className="text-sm text-amber-800">The new password must be different from the current one.</p>}
        {state.error && <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert"><AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />{state.error}</p>}
        {state.done && <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status"><CheckIcon className="h-4 w-4" />Password changed. Use the new password next time you sign in.</p>}
        <button type="submit" className="btn-primary w-full sm:w-auto" disabled={!ready || state.busy}>{state.busy && <Spinner />} Update password</button>
      </form>
    </Panel>
  );
}

export default function Profile({ parts = [] }) {
  const { user } = useSession();
  const { divisions } = useDivision();
  const tab = parts[0] === 'password' ? 'password' : 'profile';
  return (
    <>
      <PageHeader title={tab === 'password' ? 'Change Password' : 'User Profile'} />
      <Tabs value={tab} onChange={(v) => navigate(v === 'password' ? '/profile/password' : '/profile')}
        tabs={[{ value: 'profile', label: 'Profile' }, { value: 'password', label: 'Password' }]} />
      {tab === 'password' ? <ChangePassword /> : (
        <Panel>
          <div className="mb-4 flex items-center gap-4">
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-brand-700 text-white"><UserIcon className="h-8 w-8" /></span>
            <div className="min-w-0">
              <p className="truncate text-lg font-bold text-slate-900">{user.name}</p>
              <p className="text-sm text-slate-500">{ROLE_NAMES[user.role_id]} · {user.emp_id}</p>
            </div>
          </div>
          <DetailList items={[
            ['Employee ID', user.emp_id],
            ['Role', ROLE_NAMES[user.role_id]],
            ['Email', user.email],
            ['Mobile', user.mobile],
            ['Designation', user.designation],
            ['Divisions', divisions.map((d) => d.name).join(', ')],
          ]} />
          <a href="#/profile/password" className="btn-secondary mt-5"><LockIcon /> Change password</a>
        </Panel>
      )}
    </>
  );
}
