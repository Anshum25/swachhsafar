// Jobs: a basic shared task list, added to TEST SYNC between the server and the phone's SQLite database.
//
// Server -> phone: jobs are part of GET /sync/changes. Every pull (app open, back online, return to the app,
// "Sync now", and every 30 s while this screen is open) writes new, edited and deleted server jobs into the
// local `jobs` table (src/database/jobRepository.js). This screen reads only that table, so what it shows is
// exactly what the phone's database holds. Fields the backend adds later, or puts in a job's `extra`, are
// stored and listed under "Server fields" with no app change.
// Phone -> server: create / edit / delete are saved locally first and sent as the 'job.save' operation through
// POST /sync/batch, so they work offline and go up when the connection returns.
//
// TEMPORARY. To remove it: delete this file, src/database/jobRepository.js, backend/app/{models,schemas,
// services,api/v1}/jobs.py and backend/tests/test_jobs.py; drop the `jobs`/'job.save'/Job entries in
// src/app/modules.js, src/App.jsx, src/app/Layout.jsx, src/pages/ops/Dashboard.jsx, src/components/Icons.jsx
// (BriefcaseIcon), src/services/localStore.js, src/services/authorization.js, backend/app/main.py,
// backend/app/models/__init__.py, backend/app/schemas/sync.py and backend/app/services/sync.py. The
// migrations (SQLite v12, Alembic 0010) are released history: leave them, or add new ones that drop the table.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueueState, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { outcomeToast, savedLocally } from '../../components/Capture.jsx';
import { BUILD_SHA } from '../../pwa/appUpdate.js';
import { PlusIcon, RefreshIcon, Spinner } from '../../components/Icons.jsx';
import { useNetworkStatus } from '../../hooks/useNetworkStatus.js';
import {
  Badge, ConfirmDialog, Dialog, Empty, Field, Loading, PageHeader, Segmented, Select, SubmitBar, SyncBadge, fmtDate, fmtDateTime, label,
} from '../../components/ui.jsx';

const STATUSES = ['open', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const STATUS_TONE = { open: 'amber', in_progress: 'brand', done: 'green' };
const PRIORITY_TONE = { low: 'slate', medium: 'amber', high: 'red' };
const NEXT_STATUS = { open: 'in_progress', in_progress: 'done', done: 'open' };
const NEXT_LABEL = { open: 'Start', in_progress: 'Mark done', done: 'Reopen' };
const AUTO_PULL_MS = 30_000;
// Who may create, edit and delete jobs (backend app/services/jobs.py JOB_EDITORS, which enforces it):
// Super Admin (1) and Admin (2). Manager, Supervisor/EHK, Janitor and Contractor view only.
export const JOB_EDITOR_ROLES = new Set([1, 2]);
export const canEditJobs = (user) => JOB_EDITOR_ROLES.has(Number(user?.role_id));

// Fields this screen already shows. Anything else the server sends is listed under "Server fields".
const KNOWN = new Set(['id', 'title', 'description', 'location', 'priority', 'status', 'due_date', 'extra', 'is_deleted',
  'created_by_id', 'updated_by_id', 'created_at', 'updated_at', 'sync_status', 'last_sync_error']);

const show = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function serverFields(job) {
  const extra = Object.entries(job.extra ?? {});
  const added = Object.entries(job).filter(([k]) => !KNOWN.has(k));
  return [...extra, ...added];
}

const EMPTY_FORM = { title: '', description: '', location: '', priority: 'medium', due_date: '' };

function JobForm({ initial, busy, onCancel, onSave }) {
  const [form, setForm] = useState(() => (initial
    ? { title: initial.title, description: initial.description ?? '', location: initial.location ?? '', priority: initial.priority, due_date: initial.due_date ?? '' }
    : EMPTY_FORM));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const valid = form.title.trim().length >= 3;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) onSave(form); }}>
      <Field label="Title" error={form.title && !valid ? 'At least 3 characters.' : undefined}>
        <input className="input" required maxLength={120} value={form.title} onChange={(e) => set({ title: e.target.value })} autoFocus />
      </Field>
      <Field label="Description">
        <textarea className="input h-20 py-3" maxLength={500} value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Location / coach" hint="Optional, e.g. B3 or Platform 2">
        <input className="input" maxLength={60} value={form.location} onChange={(e) => set({ location: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <Select value={form.priority} onChange={(v) => set({ priority: v })} options={PRIORITIES.map((p) => ({ value: p, label: label(p) }))} />
        </Field>
        <Field label="Due date">
          <input className="input" type="date" value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} />
        </Field>
      </div>
      <SubmitBar busy={busy} label={initial ? 'Save changes' : 'Create job'} disabled={!valid} onCancel={onCancel} />
    </form>
  );
}

function JobCard({ job, busy, canEdit, onAdvance, onEdit, onDelete }) {
  const overdue = job.status !== 'done' && job.due_date && job.due_date < new Date().toISOString().slice(0, 10);
  const extra = serverFields(job);
  return (
    <li className="card space-y-2" data-testid="job-card">
      <div className="flex items-start justify-between gap-2">
        <p className={`min-w-0 flex-1 break-words text-[15px] font-bold ${job.status === 'done' ? 'text-muted line-through' : 'text-ink'}`}>{job.title}</p>
        <Badge tone={STATUS_TONE[job.status] ?? 'slate'}>{label(job.status)}</Badge>
      </div>
      {job.description && <p className="whitespace-pre-wrap break-words text-sm text-slate-600">{job.description}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={PRIORITY_TONE[job.priority] ?? 'slate'}>{label(job.priority)} priority</Badge>
        {job.location && <span>📍 {job.location}</span>}
        {job.due_date && <span className={overdue ? 'font-semibold text-red-600' : ''}>Due {fmtDate(job.due_date)}{overdue ? ' (overdue)' : ''}</span>}
        <SyncBadge status={job.sync_status} error={job.last_sync_error} />
      </div>
      {job.sync_status === 'rejected' && job.last_sync_error && <p className="text-xs text-red-700">{job.last_sync_error}</p>}
      {extra.length > 0 && (
        <dl className="rounded-xl bg-brand-50 px-3 py-2 text-xs ring-1 ring-brand-200" data-testid="job-server-fields">
          <p className="mb-1 font-bold text-brand-900">Server fields</p>
          {extra.map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="shrink-0 font-semibold text-brand-900">{label(k)}:</dt><dd className="min-w-0 break-words text-slate-700">{show(v)}</dd></div>
          ))}
        </dl>
      )}
      <p className="text-[11px] text-slate-400">Updated {fmtDateTime(job.updated_at)}</p>
      {canEdit && <div className="flex flex-wrap gap-2 border-t border-line/70 pt-2">
        <button type="button" className="btn-primary h-9 px-3 text-sm" disabled={busy} onClick={() => onAdvance(job)}>{NEXT_LABEL[job.status] ?? 'Reopen'}</button>
        <button type="button" className="btn-secondary h-9 px-3 text-sm" disabled={busy} onClick={() => onEdit(job)}>Edit</button>
        <button type="button" className="btn-secondary h-9 px-3 text-sm text-red-700" disabled={busy} onClick={() => onDelete(job)}>Delete</button>
      </div>}
    </li>
  );
}

// Where this phone's copy stands against the server, and a button to pull now.
function SyncPanel({ count, onSync }) {
  const q = useQueueState();
  const online = useNetworkStatus();
  return (
    <div className="mb-3 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-200" data-testid="jobs-sync-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p><b>{count}</b> job{count === 1 ? '' : 's'} in this phone&apos;s database · last server pull {q.lastPullAt ? fmtDateTime(q.lastPullAt) : 'never'}</p>
          <p className="text-brand-800/80">Pulls every 30 s while this screen is open{BUILD_SHA ? ` · bundle ${BUILD_SHA.slice(0, 7)}` : ''}</p>
          {q.pullError && <p className="font-semibold text-red-700">Last pull failed: {q.pullError}</p>}
        </div>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!online || q.pulling || q.running} onClick={onSync} data-testid="jobs-sync-now">
          {q.pulling || q.running ? <Spinner className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />} Sync now
        </button>
      </div>
    </div>
  );
}

export default function Jobs() {
  const { store, queue, user } = useSession();
  const canEdit = canEditJobs(user);
  const { revision } = useQueueState();
  const online = useNetworkStatus();
  const notify = useNotify();
  const [jobs, setJobs] = useState(null);
  const [count, setCount] = useState(0);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | job
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  // Re-read the local table whenever the queue commits pulled changes or delivery outcomes.
  const load = useCallback(async () => {
    const [list, n] = await Promise.all([store.jobs.list(), store.jobs.count()]);
    setJobs(list);
    setCount(n);
  }, [store]);
  useEffect(() => { load().catch((e) => notify('error', `Could not read jobs on this device: ${e.message}`)); }, [load, revision, notify]);

  const sync = useCallback(() => queue.flush().finally(() => queue.pull()), [queue]);
  // Keep pulling while the screen is open, so a change made on the server shows up without any action.
  useEffect(() => {
    if (!online) return undefined;
    const id = setInterval(() => { if (document.visibilityState === 'visible') queue.pull(); }, AUTO_PULL_MS);
    return () => clearInterval(id);
  }, [online, queue]);

  const counts = useMemo(() => STATUSES.reduce((acc, s) => ({ ...acc, [s]: (jobs ?? []).filter((j) => j.status === s).length }), {}), [jobs]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (jobs ?? [])
      .filter((j) => filter === 'all' || j.status === filter)
      .filter((j) => !q || `${j.title} ${j.description ?? ''} ${j.location ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority)
        || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  }, [jobs, filter, search]);

  // One 'job.save' operation (backend JobSaveIn) per change; saved on the phone first, then sent.
  async function submit(job, what) {
    if (!canEdit) return false;
    setBusy(true);
    try {
      const outcome = await queue.submit({
        type: 'job.save',
        payload: {
          id: job.id, title: job.title.trim(), description: job.description?.trim() || null, location: job.location?.trim() || null,
          priority: job.priority, status: job.status, due_date: job.due_date || null, deleted: !!job.deleted,
        },
      });
      outcomeToast(notify, outcome, what);
      await load();
      return savedLocally(outcome);
    } catch (e) {
      notify('error', `${what} not saved: ${e.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(form) {
    const ok = editing === 'new'
      ? await submit({ ...form, id: crypto.randomUUID(), status: 'open' }, 'Job')
      : await submit({ ...editing, ...form }, 'Job');
    if (ok) setEditing(null);
  }
  const advance = (job) => submit({ ...job, status: NEXT_STATUS[job.status] ?? 'open' }, 'Job');
  async function remove() {
    if (await submit({ ...deleting, deleted: true }, 'Deletion')) setDeleting(null);
  }

  return (
    <div>
      <PageHeader title="Jobs" subtitle={jobs ? `${counts.open} open · ${counts.in_progress} in progress · ${counts.done} done` : undefined}
        actions={canEdit ? <button type="button" className="btn-primary" onClick={() => setEditing('new')} data-testid="job-new"><PlusIcon /> New job</button> : null} />

      {!canEdit && (
        <p className="mb-3 rounded-xl bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 ring-1 ring-slate-200" data-testid="jobs-view-only">
          View only: jobs are created and updated by Admin.
        </p>
      )}

      <SyncPanel count={count} onSync={sync} />

      <div className="mb-3 space-y-2">
        <Segmented label="Filter jobs by status" value={filter} onChange={setFilter}
          options={[{ value: 'all', label: `All (${jobs?.length ?? 0})` }, ...STATUSES.map((s) => ({ value: s, label: `${label(s)} (${counts[s]})` }))]} />
        <input className="input" type="search" placeholder="Search jobs" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search jobs" />
      </div>

      {!jobs ? <Loading /> : shown.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {shown.map((j) => <JobCard key={j.id} job={j} busy={busy} canEdit={canEdit} onAdvance={advance} onEdit={setEditing} onDelete={setDeleting} />)}
        </ul>
      ) : (
        <Empty title={jobs.length ? 'No jobs match this filter' : 'No jobs yet'}>
          {!jobs.length && (canEdit ? 'Tap “New job”, or create one on the server and tap “Sync now”.' : 'Jobs added by Admin appear here.')}
        </Empty>
      )}

      <Dialog open={canEdit && !!editing} title={editing === 'new' ? 'New job' : 'Edit job'} onClose={() => setEditing(null)}>
        {editing && <JobForm initial={editing === 'new' ? null : editing} busy={busy} onCancel={() => setEditing(null)} onSave={save} />}
      </Dialog>
      <ConfirmDialog open={!!deleting} title="Delete job" danger busy={busy} confirmLabel="Delete" onClose={() => setDeleting(null)} onConfirm={remove}>
        <p>Delete <strong>{deleting?.title}</strong> for everyone? This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
