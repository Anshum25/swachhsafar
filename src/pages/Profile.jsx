// The signed-in user's profile (#/profile) and password change (#/profile/password).
import { useState } from 'react';
import { ROLE_NAMES, useSession } from '../app/session.jsx';
import { navigate } from '../app/router.js';
import { useDivision } from '../app/division.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import PasswordInput from '../components/PasswordInput.jsx';
import { AlertIcon, CheckIcon, ChevronRightIcon, KeyIcon, LogoutIcon, Spinner, UserSolidIcon } from '../components/Icons.jsx';
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
    <Panel className="mx-auto max-w-md">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-100 text-brand-700"><KeyIcon className="h-5 w-5" /></span>
        <div><h2 className="text-[15px] font-bold text-ink">Change password</h2><p className="text-xs text-muted">Use at least 8 characters.</p></div>
      </div>
      <form onSubmit={submit} className="space-y-4">
        {!online && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Changing your password needs internet.</p>}
        <PasswordInput label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" placeholder="Your current password" />
        <PasswordInput label="New password" value={next} onChange={setNext} error={nextError} showStrength />
        <PasswordInput label="Confirm new password" value={confirm} onChange={setConfirm} error={confirmError} placeholder="Repeat the new password" />
        {next && current && next === current && <p className="text-sm text-amber-800">The new password must be different from the current one.</p>}
        {state.error && <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert"><AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />{state.error}</p>}
        {state.done && <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status"><CheckIcon className="h-4 w-4" />Password changed. Use the new password next time you sign in.</p>}
        <button type="submit" className="btn-primary w-full" disabled={!ready || state.busy}>{state.busy && <Spinner />} Update password</button>
      </form>
    </Panel>
  );
}

export default function Profile({ parts = [] }) {
  const { user, signOut } = useSession();
  const { divisions } = useDivision();
  const tab = parts[0] === 'password' ? 'password' : 'profile';
  return (
    <>
      <PageHeader title={tab === 'password' ? 'Change Password' : 'User Profile'} back={tab === 'password' ? '#/profile' : '#/'} />
      <div className="mx-auto max-w-md">
        <Tabs value={tab} onChange={(v) => navigate(v === 'password' ? '/profile/password' : '/profile')}
          tabs={[{ value: 'profile', label: 'Profile' }, { value: 'password', label: 'Password' }]} />
      </div>
      {tab === 'password' ? <ChangePassword /> : (
        <div className="mx-auto max-w-md space-y-3">
          <Panel>
            <div className="mb-4 flex flex-col items-center text-center">
              <span className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-[0_8px_20px_rgba(7,89,214,0.3)]"><UserSolidIcon className="h-10 w-10" /></span>
              <p className="mt-3 max-w-full truncate text-lg font-bold text-ink">{user.name}</p>
              <p className="text-sm text-muted">{ROLE_NAMES[user.role_id]} · {user.emp_id}</p>
            </div>
            <DetailList items={[
              ['Employee ID', user.emp_id],
              ['Role', ROLE_NAMES[user.role_id]],
              ['Email', user.email],
              ['Mobile', user.mobile],
              ['Designation', user.designation],
              ['Divisions', divisions.map((d) => d.name).join(', ')],
            ]} />
          </Panel>
          <div className="card divide-y divide-line/70 p-1.5">
            <a href="#/profile/password" className="flex min-h-12 items-center gap-3.5 rounded-xl px-3 text-[15px] font-semibold text-ink hover:bg-brand-50">
              <KeyIcon className="h-5 w-5 text-brand-700" /><span className="flex-1">Change Password</span><ChevronRightIcon className="h-5 w-5 text-slate-400" />
            </a>
            <button type="button" onClick={signOut} className="flex min-h-12 w-full items-center gap-3.5 rounded-xl px-3 text-left text-[15px] font-semibold text-ink hover:bg-red-50 hover:text-red-700">
              <LogoutIcon className="h-5 w-5" /><span className="flex-1">Logout</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
