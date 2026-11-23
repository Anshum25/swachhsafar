// Clients (offices): who pays for the system, which modules they have bought, and their prepaid wallet.
// Backend: /clients (app/api/v1/clients.py). Creating a client, changing its modules and moving credits
// are Super Admin only and the server enforces that; a client's own administrator sees the office and its
// balance read-only, which is what tells them to ask for a top-up.
//
// The balance is never edited directly. Credits arrive as a recorded top-up and leave when a journey is
// created, so the ledger always explains the number.
import { useState } from 'react';
import { useSession, useResource } from '../../../app/session.jsx';
import {
  Badge, DataState, Dialog, ErrorNote, Field, Panel, Select, Stat, SubmitBar, Table, fmtDateTime, label,
} from '../../../components/ui.jsx';
import { ConfirmDialog, useSave } from './common.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';

// The modules a client may subscribe to, in the order the super admin reads them. Must match
// GATEABLE_MODULES in backend/app/models/clients.py.
const GATEABLE = [
  { key: 'attendance', label: 'Attendance', hint: 'Mark staff present, face and fingerprint checks' },
  { key: 'inspections', label: 'Coach inspection', hint: 'Before/after coach inspection with photos' },
  { key: 'feedback', label: 'Feedback', hint: 'Passenger and railway official feedback' },
  { key: 'complaints', label: 'Complaints', hint: 'Raise, forward and close complaints' },
  { key: 'inventory', label: 'Inventory', hint: 'Issue and return consumables per journey' },
  { key: 'reports', label: 'Reports', hint: 'Dashboards and operational reports' },
];

// Never switched off, so the super admin is not left wondering where they went. Matches
// ALWAYS_ON_MODULES in the same backend module.
const ALWAYS_ON = 'Sign-in, users, master data, media and journeys are always included.';

const STATUS_TONE = { active: 'green', suspended: 'red' };

function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] ?? 'slate'}>{label(status)}</Badge>;
}

function WalletStat({ client }) {
  const low = client.low_credit_threshold > 0 && client.credit_per_journey > 0
    && client.credit_balance <= client.low_credit_threshold;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat label="Credit balance" value={client.credit_balance} tone={low ? 'amber' : 'brand'}
        hint={low ? 'At or below the warning level' : undefined} />
      <Stat label="Per journey" value={client.credit_per_journey === 0 ? 'Free' : client.credit_per_journey}
        hint={client.credit_per_journey === 0 ? 'Journeys cost nothing' : 'Deducted when a journey is created'} />
      <Stat label="Journeys left" tone="slate"
        value={client.credit_per_journey === 0 ? '∞' : Math.floor(client.credit_balance / client.credit_per_journey)}
        hint="At the current rate" />
    </div>
  );
}

// ---- creating a client -----------------------------------------------------------------------------

function ClientForm({ onSaved, onClose }) {
  const { api } = useSession();
  const [f, setF] = useState({
    office_id: '', name: '', contact_name: '', contact_mobile: '', contact_email: '', gstin: '',
    credit_per_journey: '1', low_credit_threshold: '10', enabled_modules: GATEABLE.map((m) => m.key),
  });
  const [errors, setErrors] = useState({});
  const save = useSave((created) => { onSaved(created); onClose(); });

  const validate = () => {
    const found = {};
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(f.office_id)) found.office_id = 'Capitals, digits, - and _ only, e.g. OFF-001';
    if (f.name.trim().length < 2) found.name = 'Enter the office name';
    if (f.contact_mobile && !/^[6-9][0-9]{9}$/.test(f.contact_mobile)) found.contact_mobile = '10 digits, starting 6-9';
    if (f.gstin && !/^[0-9A-Z]{15}$/.test(f.gstin)) found.gstin = '15 characters, capitals and digits';
    if (!(Number(f.credit_per_journey) >= 0)) found.credit_per_journey = '0 or more';
    return found;
  };

  const submit = (e) => {
    e.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    save.run(() => api.post('/clients', {
      office_id: f.office_id.trim(),
      name: f.name.trim(),
      contact_name: f.contact_name.trim() || null,
      contact_mobile: f.contact_mobile.trim() || null,
      contact_email: f.contact_email.trim() || null,
      gstin: f.gstin.trim() || null,
      enabled_modules: f.enabled_modules,
      credit_per_journey: Number(f.credit_per_journey),
      low_credit_threshold: Number(f.low_credit_threshold),
    }), `Office ${f.office_id} created.`);
  };

  const toggle = (key) => setF((s) => ({
    ...s,
    enabled_modules: s.enabled_modules.includes(key)
      ? s.enabled_modules.filter((m) => m !== key)
      : [...s.enabled_modules, key],
  }));

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <ErrorNote error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Office ID" hint="Unique; how this client is identified" error={errors.office_id}>
          <input className="input" value={f.office_id} autoCapitalize="characters"
            onChange={(e) => setF({ ...f, office_id: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Office name" error={errors.name}>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Contact person">
          <input className="input" value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} />
        </Field>
        <Field label="Contact mobile" error={errors.contact_mobile}>
          <input className="input" inputMode="numeric" maxLength={10} value={f.contact_mobile}
            onChange={(e) => setF({ ...f, contact_mobile: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="Contact email">
          <input className="input" type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} />
        </Field>
        <Field label="GSTIN" error={errors.gstin}>
          <input className="input" maxLength={15} value={f.gstin}
            onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Credits per journey" hint="0 makes journeys free" error={errors.credit_per_journey}>
          <input className="input" inputMode="numeric" value={f.credit_per_journey}
            onChange={(e) => setF({ ...f, credit_per_journey: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="Low-credit warning at" hint="0 turns the warning off">
          <input className="input" inputMode="numeric" value={f.low_credit_threshold}
            onChange={(e) => setF({ ...f, low_credit_threshold: e.target.value.replace(/\D/g, '') })} />
        </Field>
      </div>

      <fieldset className="rounded-2xl p-3 ring-1 ring-slate-200">
        <legend className="px-1 text-sm font-semibold">Modules this client has</legend>
        <p className="mb-2 text-xs text-muted">{ALWAYS_ON}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {GATEABLE.map((m) => (
            <label key={m.key} className="flex items-start gap-2 rounded-xl p-2 ring-1 ring-slate-200">
              <input type="checkbox" className="mt-1" checked={f.enabled_modules.includes(m.key)} onChange={() => toggle(m.key)} />
              <span><span className="text-sm font-medium">{m.label}</span><br /><span className="text-xs text-muted">{m.hint}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
        The wallet starts at zero. Add credits once the client has paid.
      </p>
      <SubmitBar busy={save.busy} label="Create office" onCancel={onClose} />
    </form>
  );
}

// ---- modules, rate, credits ------------------------------------------------------------------------

function ModulesPanel({ client, onSaved, canEdit }) {
  const { api } = useSession();
  const [picked, setPicked] = useState(client.enabled_modules);
  const [confirming, setConfirming] = useState(false);
  const save = useSave((saved) => { setConfirming(false); onSaved(saved); });
  const removed = client.enabled_modules.filter((m) => !picked.includes(m));
  const added = picked.filter((m) => !client.enabled_modules.includes(m));
  const changed = removed.length + added.length > 0;

  return (
    <Panel title="Modules">
      <p className="mb-3 text-xs text-muted">{ALWAYS_ON}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {GATEABLE.map((m) => (
          <label key={m.key} className="flex items-start gap-2 rounded-xl p-2 ring-1 ring-slate-200">
            <input type="checkbox" className="mt-1" disabled={!canEdit} checked={picked.includes(m.key)}
              onChange={() => setPicked((s) => (s.includes(m.key) ? s.filter((k) => k !== m.key) : [...s, m.key]))} />
            <span><span className="text-sm font-medium">{m.label}</span><br /><span className="text-xs text-muted">{m.hint}</span></span>
          </label>
        ))}
      </div>
      {canEdit && changed && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary h-10" onClick={() => setPicked(client.enabled_modules)}>Reset</button>
          <button type="button" className="btn-primary h-10" onClick={() => setConfirming(true)}>Save modules</button>
        </div>
      )}
      <ConfirmDialog open={confirming} busy={save.busy} error={save.error} confirmLabel="Save modules"
        onClose={() => { setConfirming(false); save.setError(null); }}
        title="Change this client's modules"
        message={[
          added.length ? `Adding: ${added.join(', ')}.` : '',
          removed.length ? `Removing: ${removed.join(', ')}. Their screens disappear for every user of this office at the next sync, and the server refuses them at once. Records already captured are kept.` : '',
        ].filter(Boolean).join(' ')}
        onConfirm={() => save.run(() => api.put(`/clients/${client.id}/modules`, { enabled_modules: picked }), 'Modules updated.')} />
    </Panel>
  );
}

function WalletPanel({ client, onSaved, canEdit }) {
  const { api } = useSession();
  const [dialog, setDialog] = useState(null); // 'top_up' | 'rate' | 'adjust'
  const [f, setF] = useState({ credits: '', reference: '', note: '', rate: '', delta: '' });
  const save = useSave((saved) => { setDialog(null); onSaved(saved); });
  const open = (kind) => {
    setF({ credits: '', reference: '', note: '', rate: String(client.credit_per_journey), delta: '' });
    save.setError(null);
    setDialog(kind);
  };

  return (
    <Panel title="Wallet" actions={canEdit && (
      <div className="flex gap-2">
        <button type="button" className="btn-primary h-10" onClick={() => open('top_up')}>Add credits</button>
        <button type="button" className="btn-secondary h-10" onClick={() => open('rate')}>Set rate</button>
        <button type="button" className="btn-secondary h-10" onClick={() => open('adjust')}>Adjust</button>
      </div>
    )}>
      <WalletStat client={client} />

      <Dialog open={dialog === 'top_up'} title={`Add credits to ${client.office_id}`} onClose={() => setDialog(null)}
        onSubmit={(e) => { e.preventDefault(); save.run(() => api.post(`/clients/${client.id}/credits`, {
          credits: Number(f.credits), reference: f.reference.trim() || null, note: f.note.trim() || null,
        }), `${f.credits} credits added.`); }}>
        <ErrorNote error={save.error} />
        <p className="mb-3 text-sm text-slate-700">Record the credits this client has paid for. The balance rises at once.</p>
        <div className="space-y-3">
          <Field label="Credits to add">
            <input className="input" inputMode="numeric" autoFocus value={f.credits}
              onChange={(e) => setF({ ...f, credits: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Payment reference" hint="UTR, cheque or invoice number">
            <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
          <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <SubmitBar busy={save.busy} disabled={!(Number(f.credits) > 0)} label="Add credits" onCancel={() => setDialog(null)} />
      </Dialog>

      <Dialog open={dialog === 'rate'} title="Credits per journey" onClose={() => setDialog(null)}
        onSubmit={(e) => { e.preventDefault(); save.run(() => api.put(`/clients/${client.id}/credit-rate`, {
          credit_per_journey: Number(f.rate), note: f.note.trim() || null,
        }), 'Rate updated.'); }}>
        <ErrorNote error={save.error} />
        <p className="mb-3 text-sm text-slate-700">
          What one journey costs this client, from now on. Journeys already created are not re-priced.
          <strong> 0 makes journeys free.</strong>
        </p>
        <div className="space-y-3">
          <Field label="Credits per journey">
            <input className="input" inputMode="numeric" autoFocus value={f.rate}
              onChange={(e) => setF({ ...f, rate: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <SubmitBar busy={save.busy} label="Save rate" onCancel={() => setDialog(null)} />
      </Dialog>

      <Dialog open={dialog === 'adjust'} title="Adjust the balance" onClose={() => setDialog(null)}
        onSubmit={(e) => { e.preventDefault(); save.run(() => api.post(`/clients/${client.id}/credits/adjust`, {
          delta: Number(f.delta), note: f.note.trim(),
        }), 'Balance adjusted.'); }}>
        <ErrorNote error={save.error} />
        <p className="mb-3 text-sm text-slate-700">
          A correction, in either direction, recorded with its reason. It cannot take the balance below zero.
        </p>
        <div className="space-y-3">
          <Field label="Change" hint="e.g. 25 or -5">
            <input className="input" inputMode="numeric" autoFocus value={f.delta}
              onChange={(e) => setF({ ...f, delta: e.target.value.replace(/[^\d-]/g, '') })} />
          </Field>
          <Field label="Reason" hint="Required">
            <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
        </div>
        <SubmitBar busy={save.busy} disabled={!Number(f.delta) || f.note.trim().length < 3} label="Adjust" onCancel={() => setDialog(null)} />
      </Dialog>
    </Panel>
  );
}

const REASON_LABEL = {
  top_up: 'Credits added', journey_charge: 'Journey created', journey_refund: 'Journey cancelled', adjustment: 'Adjustment',
};

function LedgerPanel({ clientId }) {
  const [page, setPage] = useState(1);
  const res = useResource(`/clients/${clientId}/ledger`, { page, page_size: 20 });
  return (
    <Panel title="Credit history">
      <p className="mb-3 text-xs text-muted">
        Every movement of this wallet, newest first. Nothing here is ever rewritten, so these rows are the
        explanation of the balance.
      </p>
      <DataState res={res} isEmpty={(d) => !d.items?.length} empty="No credit movements yet.">
        {(data) => (
          <>
            <Table
              columns={[
                { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
                { key: 'reason', label: 'What', render: (r) => REASON_LABEL[r.reason] ?? label(r.reason) },
                {
                  key: 'delta',
                  label: 'Change',
                  render: (r) => (
                    <span className={r.delta < 0 ? 'font-medium text-red-700' : 'font-medium text-green-700'}>
                      {r.delta > 0 ? `+${r.delta}` : r.delta}
                    </span>
                  ),
                },
                { key: 'balance_after', label: 'Balance' },
                { key: 'reference', label: 'Reference', render: (r) => r.reference || r.note || '—' },
              ]}
              rows={data.items}
            />
            {data.total > data.page_size && (
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="btn-secondary h-10" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <button type="button" className="btn-secondary h-10" disabled={page * data.page_size >= data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </DataState>
    </Panel>
  );
}

// ---- the screen ------------------------------------------------------------------------------------

function ClientDetail({ clientId, onBack, onChanged }) {
  const { api, me } = useSession();
  const online = useNetworkStatus();
  const res = useResource(`/clients/${clientId}`);
  const canEdit = me?.user?.role_id === 1 && online;
  const [statusTarget, setStatusTarget] = useState(null);
  const save = useSave((saved) => { setStatusTarget(null); res.reload(); onChanged(saved); });

  return (
    <DataState res={res}>
      {(client) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="btn-secondary h-10" onClick={onBack}>← All offices</button>
            {canEdit && (
              <button type="button" className={client.status === 'active' ? 'btn-secondary h-10' : 'btn-primary h-10'}
                onClick={() => setStatusTarget(client)}>
                {client.status === 'active' ? 'Suspend office' : 'Reactivate office'}
              </button>
            )}
          </div>

          <Panel title={`${client.office_id} — ${client.name}`} actions={<StatusBadge status={client.status} />}>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[['Contact', client.contact_name], ['Mobile', client.contact_mobile], ['Email', client.contact_email],
                ['GSTIN', client.gstin], ['Address', client.address]].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1">
                    <dt className="text-muted">{k}</dt><dd className="text-right font-medium">{v || '—'}</dd>
                  </div>
              ))}
            </dl>
          </Panel>

          <WalletPanel client={client} canEdit={canEdit} onSaved={() => { res.reload(); onChanged(); }} />
          <ModulesPanel client={client} canEdit={canEdit} onSaved={() => { res.reload(); onChanged(); }} />
          <LedgerPanel clientId={client.id} />

          <ConfirmDialog open={!!statusTarget} busy={save.busy} error={save.error}
            onClose={() => { setStatusTarget(null); save.setError(null); }}
            title={client.status === 'active' ? 'Suspend this office' : 'Reactivate this office'}
            confirmLabel={client.status === 'active' ? 'Suspend' : 'Reactivate'}
            message={client.status === 'active'
              ? 'No new journeys can be created for this office while it is suspended, whatever its balance. Journeys already running are not affected and their records keep syncing.'
              : 'New journeys can be created again, subject to the wallet.'}
            onConfirm={() => save.run(
              () => api.patch(`/clients/${client.id}`, { status: client.status === 'active' ? 'suspended' : 'active' }),
              client.status === 'active' ? 'Office suspended.' : 'Office reactivated.',
            )} />
        </div>
      )}
    </DataState>
  );
}

export default function Clients() {
  const { me } = useSession();
  const online = useNetworkStatus();
  const res = useResource('/clients');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState({ q: '', status: '' });
  const isSuperAdmin = me?.user?.role_id === 1;

  if (selected) {
    return <ClientDetail clientId={selected} onBack={() => setSelected(null)} onChanged={() => res.reload()} />;
  }

  const shown = (rows) => rows.filter((r) => {
    if (filter.status && r.status !== filter.status) return false;
    const needle = filter.q.trim().toLowerCase();
    return !needle || [r.office_id, r.name, r.contact_name].some((v) => String(v ?? '').toLowerCase().includes(needle));
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {isSuperAdmin
          ? 'Each client is an office with its own modules and its own prepaid wallet. One credit is deducted when a journey is created, at the rate set per office.'
          : 'Your organisation, the modules it subscribes to and its credit balance. Only the Super Admin can change these.'}
      </p>

      {isSuperAdmin && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            <input className="input h-10 min-w-0 flex-1 sm:min-w-[14rem]" placeholder="Search office ID, name or contact"
              aria-label="Search offices" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />
            <div className="w-40">
              <Select value={filter.status} onChange={(v) => setFilter((f) => ({ ...f, status: v }))}
                options={[{ value: '', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }]}
                aria-label="Status filter" />
            </div>
          </div>
          <button type="button" className="btn-primary h-10" disabled={!online} onClick={() => setCreating(true)}>New office</button>
        </div>
      )}

      <DataState res={res} isEmpty={(d) => !d?.length} empty="No offices yet.">
        {(rows) => (
          <Table
            columns={[
              { key: 'office_id', label: 'Office ID', render: (r) => <span className="font-medium">{r.office_id}</span> },
              { key: 'name', label: 'Name' },
              { key: 'enabled_modules', label: 'Modules', render: (r) => (r.enabled_modules.length ? r.enabled_modules.length : 'Platform only') },
              {
                key: 'credit_balance',
                label: 'Credits',
                render: (r) => {
                  const low = r.low_credit_threshold > 0 && r.credit_per_journey > 0 && r.credit_balance <= r.low_credit_threshold;
                  return <span className={low ? 'font-medium text-amber-700' : ''}>{r.credit_balance}</span>;
                },
              },
              { key: 'credit_per_journey', label: 'Per journey', render: (r) => (r.credit_per_journey === 0 ? 'Free' : r.credit_per_journey) },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]}
            rows={shown(rows)}
            onRowClick={(r) => setSelected(r.id)}
          />
        )}
      </DataState>

      <Dialog open={creating} title="New office" wide onClose={() => setCreating(false)}>
        <ClientForm onSaved={() => res.reload()} onClose={() => setCreating(false)} />
      </Dialog>
    </div>
  );
}
