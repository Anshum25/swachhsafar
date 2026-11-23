// Master Data · Users: server-paginated list with search and filters. A row opens the user's profile
// (#/masters/users/<id>); the Face / Finger buttons and the ⋯ menu act in place without opening it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ROLE_NAMES, useResource, useSession } from '../../../app/session.jsx';
import { navigate } from '../../../app/router.js';
import { Badge, DataState, Dialog, FilterBar, Field, Pager, Panel, Select, Table, label } from '../../../components/ui.jsx';
import { FingerprintIcon, MoreIcon, PlusIcon, SearchIcon, UserIcon } from '../../../components/Icons.jsx';
import FaceEnrollDialog from './FaceEnrollment.jsx';
import FingerprintEnrollDialog from './FingerprintEnrollment.jsx';
import { canManageRole, EditUserDialog, ResetPasswordDialog, SignInForm, StatusDialog, UserForm } from './UserDialogs.jsx';

const PAGE_SIZE = 25;
const STATUSES = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];

export const userPath = (u) => `/masters/users/${u.id}`;

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Row ⋯ menu. Portalled with fixed positioning so the scrolling table never clips it.
export function RowMenu({ user, items, label: aria, className = 'icon-btn h-9 w-9' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  useLayoutEffect(() => {
    if (!open) return;
    const r = btn.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 240;
    setPos({ right: Math.max(8, window.innerWidth - r.right), ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const close = () => setOpen(false);
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', away);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const shown = items.filter(Boolean);
  return (
    <>
      <button ref={btn} type="button" className={className} aria-label={aria ?? `Actions for ${user.name}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}><MoreIcon className="h-5 w-5" /></button>
      {open && pos && createPortal(
        <div ref={menu} role="menu" style={pos} className="fixed z-50 w-56 animate-modal-in overflow-hidden rounded-2xl bg-white py-1.5 shadow-raised ring-1 ring-line">
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" onClick={() => { setOpen(false); it.onClick(); }}
              className={`block w-full px-4 py-2.5 text-left text-sm font-semibold transition hover:bg-brand-50 ${it.danger ? 'text-red-600' : 'text-ink'}`}>
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// Keeps clicks on controls inside a row from also opening the profile.
const Stop = ({ children, className = '' }) => (
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
  <div className={className} onClick={(e) => e.stopPropagation()}>{children}</div>
);

export default function Users({ division }) {
  const { canIn, user: me } = useSession();
  const divisionId = division.divisionId;
  const manage = canIn('users.manage', divisionId);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  useEffect(() => setPage(1), [search, role, status, divisionId]);
  const res = useResource('/users', { division_id: divisionId, q: search, role_id: role, status, page, page_size: PAGE_SIZE });
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'face'|'finger'|'signin'|'edit'|'password'|'status', user }
  const open = (kind, u) => setDialog({ kind, user: u });
  const closeDialog = () => setDialog(null);
  const manages = (u) => manage && u.id !== me.id && canManageRole(me.role_id, u.role_id);

  return (
    <Panel title="Users" actions={manage && <button type="button" className="btn-secondary" onClick={() => setCreating(true)}><PlusIcon /> Add user</button>}>
      <FilterBar>
        <Field label="Search">
          <span className="relative block">
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input h-11 pl-10" type="search" placeholder="Name, employee ID or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
          </span>
        </Field>
        <Field label="Role"><Select value={role} onChange={setRole} placeholder="All roles" options={Object.entries(ROLE_NAMES).map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="Active and inactive" options={STATUSES} /></Field>
      </FilterBar>
      <DataState res={res} empty={search || role || status ? 'No users match these filters.' : 'No users found.'}>
        {(data) => (
          <>
            <Table rows={data.items} onRowClick={(u) => navigate(userPath(u))} columns={[
              { key: 'name', label: 'Name', render: (u) => (
                <a href={`#${userPath(u)}`} className="block min-w-0 hover:underline" onClick={(e) => e.stopPropagation()}>
                  <span className="font-semibold text-ink">{u.name}</span>
                  <span className="block truncate text-xs font-normal text-slate-500">{u.emp_id} · {u.email ?? 'no email'}</span>
                </a>
              ) },
              { key: 'role', label: 'Role', render: (u) => ROLE_NAMES[u.role_id] },
              { key: 'password_set', label: 'Sign-in', render: (u) => (
                <div className="flex flex-wrap items-center gap-1">
                  {u.password_set ? <Badge tone="green">Password</Badge> : <Badge tone="amber">No password</Badge>}
                  {u.face_enrolled && <Badge tone="green">Face</Badge>}
                  {u.fingerprint_enrolled && <Badge tone="green">Finger</Badge>}
                </div>
              ) },
              { key: 'status', label: 'Status', render: (u) => <Badge tone={u.status === 'active' ? 'green' : 'slate'}>{label(u.status)}</Badge> },
              ...(manage ? [{ key: 'actions', label: '', render: (u) => (manages(u) ? (
                <Stop className="flex items-center justify-end gap-1.5">
                  <button type="button" className="btn-secondary h-9 text-xs" onClick={() => open('face', u)} aria-label={`Face registration for ${u.name}`}><UserIcon /> Face</button>
                  <button type="button" className="btn-secondary h-9 text-xs" onClick={() => open('finger', u)} aria-label={`Fingerprint registration for ${u.name}`}><FingerprintIcon className="h-4 w-4" /> Finger</button>
                  <RowMenu user={u} items={[
                    { label: 'View profile', onClick: () => navigate(userPath(u)) },
                    { label: 'Edit user', onClick: () => open('edit', u) },
                    u.password_set ? { label: 'Change password', onClick: () => open('password', u) } : { label: 'Create sign-in', onClick: () => open('signin', u) },
                    { label: u.status === 'active' ? 'Deactivate' : 'Activate', danger: u.status === 'active', onClick: () => open('status', u) },
                  ]} />
                </Stop>
              ) : null) }] : []),
            ]} />
            <Pager data={data} onPage={setPage} />
          </>
        )}
      </DataState>
      {dialog?.kind === 'face' && <FaceEnrollDialog user={dialog.user} onClose={() => { closeDialog(); res.reload(); }} />}
      {dialog?.kind === 'finger' && <FingerprintEnrollDialog user={dialog.user} onClose={() => { closeDialog(); res.reload(); }} />}
      {dialog?.kind === 'edit' && <EditUserDialog user={dialog.user} division={division} onClose={closeDialog} onSaved={res.reload} />}
      {dialog?.kind === 'password' && <ResetPasswordDialog user={dialog.user} onClose={closeDialog} />}
      {dialog?.kind === 'status' && <StatusDialog user={dialog.user} onClose={closeDialog} onDone={res.reload} />}
      <Dialog open={dialog?.kind === 'signin'} title="Create sign-in" onClose={closeDialog}>
        {dialog?.kind === 'signin' && <SignInForm user={dialog.user} onClose={closeDialog} onSaved={res.reload} />}
      </Dialog>
      <Dialog open={creating} title="Add user" onClose={() => setCreating(false)} wide>
        {/* The dialog stays open after saving: it now shows the new sign-in's password, which exists
            nowhere else. Closing it is the "Done" button's job. */}
        <UserForm division={division} onClose={() => setCreating(false)} onSaved={res.reload} />
      </Dialog>
    </Panel>
  );
}
