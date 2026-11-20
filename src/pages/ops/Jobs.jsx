// Jobs: a basic task list, added to test that an over-the-air bundle update (docs/OTA_UPDATES.md) reaches
// the installed APK. If the "Jobs" menu item appears on a phone without reinstalling, OTA works.
//
// TEMPORARY and self-contained, so it can be removed cleanly: delete this file and the `jobs` entries in
// src/app/modules.js, src/App.jsx, src/app/Layout.jsx, src/pages/ops/Dashboard.jsx and JobIcon in Icons.jsx.
// Jobs are kept in this device's localStorage per user; there is no backend table, migration or sync.
import { useMemo, useState } from 'react';
import { useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { BUILD_SHA } from '../../pwa/appUpdate.js';
import { PlusIcon } from '../../components/Icons.jsx';
import {
  Badge, ConfirmDialog, Dialog, Empty, Field, PageHeader, Segmented, Select, SubmitBar, fmtDate, fmtDateTime, label,
} from '../../components/ui.jsx';

const STATUSES = ['open', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const STATUS_TONE = { open: 'amber', in_progress: 'brand', done: 'green' };
const PRIORITY_TONE = { low: 'slate', medium: 'amber', high: 'red' };
const NEXT_STATUS = { open: 'in_progress', in_progress: 'done', done: 'open' };
const NEXT_LABEL = { open: 'Start', in_progress: 'Mark done', done: 'Reopen' };

const keyFor = (userId) => `swachhsafar.jobs.${userId ?? 'anonymous'}`;

function loadJobs(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveJobs(userId, jobs) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(jobs));
    return true;
  } catch {
    return false;
  }
}

const EMPTY_FORM = { title: '', description: '', location: '', priority: 'medium', due_date: '' };

function JobForm({ initial, onCancel, onSave }) {
  const [form, setForm] = useState(initial ?? EMPTY_FORM);
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
      <SubmitBar label={initial ? 'Save changes' : 'Create job'} disabled={!valid} onCancel={onCancel} />
    </form>
  );
}

function JobCard({ job, onAdvance, onEdit, onDelete }) {
  const overdue = job.status !== 'done' && job.due_date && job.due_date < new Date().toISOString().slice(0, 10);
  return (
    <li className="card space-y-2" data-testid="job-card">
      <div className="flex items-start justify-between gap-2">
        <p className={`min-w-0 flex-1 break-words text-[15px] font-bold ${job.status === 'done' ? 'text-muted line-through' : 'text-ink'}`}>{job.title}</p>
        <Badge tone={STATUS_TONE[job.status]}>{label(job.status)}</Badge>
      </div>
      {job.description && <p className="whitespace-pre-wrap break-words text-sm text-slate-600">{job.description}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={PRIORITY_TONE[job.priority]}>{label(job.priority)} priority</Badge>
        {job.location && <span>📍 {job.location}</span>}
        {job.due_date && <span className={overdue ? 'font-semibold text-red-600' : ''}>Due {fmtDate(job.due_date)}{overdue ? ' (overdue)' : ''}</span>}
      </div>
      <p className="text-[11px] text-slate-400">Updated {fmtDateTime(job.updated_at)}</p>
      <div className="flex flex-wrap gap-2 border-t border-line/70 pt-2">
        <button type="button" className="btn-primary h-9 px-3 text-sm" onClick={() => onAdvance(job)}>{NEXT_LABEL[job.status]}</button>
        <button type="button" className="btn-secondary h-9 px-3 text-sm" onClick={() => onEdit(job)}>Edit</button>
        <button type="button" className="btn-secondary h-9 px-3 text-sm text-red-700" onClick={() => onDelete(job)}>Delete</button>
      </div>
    </li>
  );
}

export default function Jobs() {
  const { user } = useSession();
  const notify = useNotify();
  const userId = user?.id;
  const [jobs, setJobs] = useState(() => loadJobs(userId));
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | job
  const [deleting, setDeleting] = useState(null);

  const commit = (next, message) => {
    setJobs(next);
    if (!saveJobs(userId, next)) notify('error', 'Could not save on this device.');
    else if (message) notify('success', message);
  };

  const counts = useMemo(() => STATUSES.reduce((acc, s) => ({ ...acc, [s]: jobs.filter((j) => j.status === s).length }), {}), [jobs]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs
      .filter((j) => filter === 'all' || j.status === filter)
      .filter((j) => !q || `${j.title} ${j.description} ${j.location}`.toLowerCase().includes(q))
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority)
        || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  }, [jobs, filter, search]);

  function save(form) {
    const now = new Date().toISOString();
    const clean = { ...form, title: form.title.trim(), description: form.description.trim(), location: form.location.trim() };
    if (editing === 'new') {
      commit([{ ...clean, id: crypto.randomUUID(), status: 'open', created_at: now, updated_at: now }, ...jobs], 'Job created');
    } else {
      commit(jobs.map((j) => (j.id === editing.id ? { ...j, ...clean, updated_at: now } : j)), 'Job updated');
    }
    setEditing(null);
  }

  const advance = (job) => commit(jobs.map((j) => (j.id === job.id ? { ...j, status: NEXT_STATUS[j.status], updated_at: new Date().toISOString() } : j)));
  const remove = () => { commit(jobs.filter((j) => j.id !== deleting.id), 'Job deleted'); setDeleting(null); };

  return (
    <div>
      <PageHeader title="Jobs" subtitle={`${counts.open} open · ${counts.in_progress} in progress · ${counts.done} done`}
        actions={<button type="button" className="btn-primary" onClick={() => setEditing('new')} data-testid="job-new"><PlusIcon /> New job</button>} />

      <p className="mb-3 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-200" data-testid="jobs-ota-note">
        Test module delivered by over-the-air update{BUILD_SHA ? ` · bundle ${BUILD_SHA.slice(0, 7)}` : ''}. Jobs are stored on this device only.
      </p>

      <div className="mb-3 space-y-2">
        <Segmented label="Filter jobs by status" value={filter} onChange={setFilter}
          options={[{ value: 'all', label: `All (${jobs.length})` }, ...STATUSES.map((s) => ({ value: s, label: `${label(s)} (${counts[s]})` }))]} />
        <input className="input" type="search" placeholder="Search jobs" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search jobs" />
      </div>

      {shown.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {shown.map((j) => <JobCard key={j.id} job={j} onAdvance={advance} onEdit={setEditing} onDelete={setDeleting} />)}
        </ul>
      ) : (
        <Empty title={jobs.length ? 'No jobs match this filter' : 'No jobs yet'}>
          {!jobs.length && 'Tap “New job” to add one.'}
        </Empty>
      )}

      <Dialog open={!!editing} title={editing === 'new' ? 'New job' : 'Edit job'} onClose={() => setEditing(null)}>
        {editing && <JobForm initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSave={save} />}
      </Dialog>
      <ConfirmDialog open={!!deleting} title="Delete job" danger confirmLabel="Delete" onClose={() => setDeleting(null)} onConfirm={remove}>
        <p>Delete <strong>{deleting?.title}</strong>? This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
