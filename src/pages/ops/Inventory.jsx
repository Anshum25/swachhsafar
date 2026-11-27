// CP-10 Inventory: issue / return of consumables per journey.
//
// Transactions are immutable and recorded through the operations queue ('inventory.record', a
// /sync/batch operation), so they work offline. The local repository refuses a return larger than the
// quantity issued for the same journey, item, coach and person, as the server does; balances are always
// derived from the ledger, never edited.
//
// One form covers a whole round: pick the item once, then every coach is listed with its own quantity and,
// for each coach, the EHK or janitor it is handed to. "Same for every coach" and "Give all to" fill every
// row in one go, and one confirmation records a transaction for each row that has a quantity. A return lists
// each coach and person that still holds some of the item.
import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import { savedLocally } from '../../components/Capture.jsx';
import {
  Badge, ConfirmDialog, DataState, Dialog, Empty, ErrorNote, Field, Loading, PageHeader, Pager, Panel, STATE_TONE, Segmented, Select,
  SubmitBar, SyncState, Table, fmtDateTime, label,
} from '../../components/ui.jsx';
import { canAct } from '../../services/authorization.js';

const qty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

// Outstanding (issued − returned) for an item, coach and person, from the balance rows.
export const outstandingOf = (balance, itemId, coachCode, recipientId = null) => {
  const row = (balance ?? []).find((r) => r.item_id === itemId && (r.coach_code ?? null) === (coachCode || null)
    && (r.recipient_id ?? null) === (recipientId || null));
  return row ? row.issued - row.returned : 0;
};

// What a person does on the journey: EHK (supervisor, role 4) or janitor (role 5).
const roleOf = (p) => (p.supervisor || p.role_id === 4 ? 'EHK' : p.role_id === 5 ? 'Janitor' : 'Staff');

// The people stock can be handed to: the journey's EHK (supervisor) and its current staff, EHKs first.
export const journeyPeople = (j) => {
  const seen = new Set();
  return [...(j.supervisor_id ? [{ user_id: j.supervisor_id, name: j.supervisor_name, supervisor: true }] : []),
    ...(j.staff ?? []).filter((s) => !s.removed_at)]
    .filter((p) => p.user_id && !seen.has(p.user_id) && seen.add(p.user_id))
    .map((p) => ({ ...p, role: roleOf(p) }))
    .sort((a, b) => (a.role === 'EHK' ? 0 : 1) - (b.role === 'EHK' ? 0 : 1));
};

// Issue rows: the whole journey and every coach.
export const coachTargets = (j) => [{ key: 'journey', label: 'Whole journey', coach_code: null },
  ...j.coaches.map((c) => ({ key: `c:${c.code}`, label: c.code, coach_code: c.code }))];

// Return rows: every coach and person still holding some of the item.
export function heldTargets(j, balance, itemId) {
  const people = new Map(journeyPeople(j).map((p) => [p.user_id, p]));
  return (balance ?? []).filter((r) => r.item_id === itemId && r.issued - r.returned > 1e-9).map((r) => {
    const who = r.recipient_id ? people.get(r.recipient_id) : null;
    const where = r.coach_code ?? 'Whole journey';
    const person = r.recipient_id ? `${who?.name ?? 'Staff'} (${who?.role ?? 'Staff'})` : null;
    return {
      key: `${r.coach_code ?? ''}:${r.recipient_id ?? ''}`, label: person ? `${where} · ${person}` : where,
      coach_code: r.coach_code ?? null, recipient_id: r.recipient_id ?? null,
    };
  });
}

function MovementForm({ journey, type, balance, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const items = useResource('/inventory/items', { division_id: journey.division_id, active: true });
  const [itemId, setItemId] = useState('');
  const [amounts, setAmounts] = useState({});      // row key -> quantity text
  const [givenTo, setGivenTo] = useState({});      // row key -> user id ('' = the coach itself)
  const [same, setSame] = useState('');
  const [remarks, setRemarks] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const item = (items.data ?? []).find((i) => i.id === itemId);
  const returning = type === 'return';
  const unit = item?.unit ?? '';
  const people = journeyPeople(journey);
  const personLabel = (id) => {
    const p = people.find((x) => x.user_id === id);
    return p ? `${p.name ?? 'Staff'} (${p.role})` : '';
  };

  const rows = returning ? heldTargets(journey, balance, itemId) : coachTargets(journey);
  const open = (t) => outstandingOf(balance, itemId, t.coach_code, t.recipient_id);
  const parsed = rows.map((t) => {
    const raw = String(amounts[t.key] ?? '').trim();
    const n = Number(raw);
    const recipient = returning ? t.recipient_id : givenTo[t.key] || null;
    const error = !raw ? null
      : !Number.isFinite(n) || n <= 0 || n > 1_000_000 ? 'Enter a quantity above 0'
        : returning && n > open(t) + 1e-9 ? `At most ${qty(open(t))}` : null;
    return { ...t, recipient_id: recipient, raw, n, error };
  });
  const chosen = parsed.filter((r) => r.raw && !r.error);
  const invalid = parsed.some((r) => r.error);
  const total = chosen.reduce((sum, r) => sum + r.n, 0);
  const valid = item && chosen.length > 0 && !invalid;
  const noun = chosen.length === 1 ? 'coach' : 'coaches';

  const setAmount = (key, v) => setAmounts((a) => ({ ...a, [key]: v }));
  const fillAll = () => setAmounts(Object.fromEntries(rows.map((t) => [t.key, same])));
  const fillOutstanding = () => setAmounts(Object.fromEntries(rows.map((t) => [t.key, qty(open(t))])));
  const giveAll = (id) => setGivenTo(Object.fromEntries(rows.map((t) => [t.key, id])));
  const rowLabel = (r) => (r.recipient_id && !returning ? `${r.label} · ${personLabel(r.recipient_id)}` : r.label);
  const personOptions = [{ value: '', label: 'Coach (no one)' }, ...people.map((p) => ({ value: p.user_id, label: `${p.name ?? 'Staff'} (${p.role})` }))];

  async function record() {
    setBusy(true);
    const failed = [];
    let saved = 0;
    let pending = 0;
    for (const r of chosen) {
      const outcome = await queue.submit({
        type: 'inventory.record',
        // backend TxnIn (unknown fields are refused)
        payload: {
          id: crypto.randomUUID(), journey_id: journey.id, item_id: itemId, coach_code: r.coach_code,
          ...(r.recipient_id ? { recipient_id: r.recipient_id } : {}),
          txn_type: type, quantity: r.n, remarks: remarks.trim() || null,
        },
      });
      if (savedLocally(outcome)) {
        saved += 1;
        if (outcome.status !== 'synced') pending += 1;
      } else {
        failed.push(`${rowLabel(r)}: ${outcome.message}`);
      }
    }
    setBusy(false);
    setConfirming(false);
    const what = returning ? 'Returned' : 'Issued';
    if (saved) {
      const where = `${saved} ${saved === 1 ? 'coach' : 'coaches'}`;
      notify(pending ? 'warning' : 'success', pending
        ? `${what} ${item.name} for ${where}. Saved on this device; it will sync when the server is reachable.`
        : `${what} ${item.name} for ${where}.`);
    }
    for (const f of failed) notify('error', f);
    if (saved) onDone();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) setConfirming(true); }} className="space-y-3">
      <ErrorNote error={items.error} />
      <Field label="Item">
        <Select value={itemId} required onChange={(v) => { setItemId(v); setAmounts({}); }}
          placeholder={items.loading ? 'Loading…' : (items.data ?? []).length ? 'Select item' : 'No active items in this division'}
          options={(items.data ?? []).map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))} />
      </Field>

      {item && (
        <>
          {rows.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600">
              {returning ? `Nothing of ${item.name} is outstanding on this journey.` : 'This journey has no coaches.'}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2.5">
                {returning ? (
                  <button type="button" className="btn-secondary h-10 text-sm" onClick={fillOutstanding}>Return all outstanding</button>
                ) : (
                  <>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
                      Same for every coach
                      <input className="input h-10 w-20" inputMode="decimal" aria-label="Same quantity for all" value={same}
                        onChange={(e) => setSame(e.target.value)} placeholder={unit} />
                    </label>
                    <button type="button" className="btn-secondary h-10 text-sm" disabled={!same.trim()} onClick={fillAll}>Fill all</button>
                    {people.length > 0 && (
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
                        Give all to
                        <select className="input h-10 w-auto max-w-[12rem] text-sm" aria-label="Give all to" value=""
                          onChange={(e) => giveAll(e.target.value)}>
                          <option value="" disabled>Choose…</option>
                          {personOptions.map((o) => <option key={o.value || 'coach'} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    )}
                  </>
                )}
                <button type="button" className="btn-link ml-auto text-xs" onClick={() => { setAmounts({}); setGivenTo({}); }}>Clear</button>
              </div>
              <ul className="space-y-2" aria-label="Quantity per coach">
                {parsed.map((r) => (
                  <li key={r.key} className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 ring-1 ${r.error ? 'ring-red-300' : r.raw ? 'bg-brand-50/40 ring-brand-300' : 'ring-slate-200'}`}>
                    <span className="min-w-[4.5rem] flex-1">
                      <span className="block text-sm font-semibold">{r.label}</span>
                      {returning && <span className="block text-[11px] text-slate-500">Outstanding {qty(open(r))} {unit}</span>}
                      {r.error && <span className="block text-[11px] text-red-600">{r.error}</span>}
                    </span>
                    {!returning && people.length > 0 && (
                      <select className="input h-10 w-40 text-sm sm:w-56" aria-label={`${r.label} given to`}
                        value={givenTo[r.key] ?? ''} onChange={(e) => setGivenTo((g) => ({ ...g, [r.key]: e.target.value }))}>
                        {personOptions.map((o) => <option key={o.value || 'coach'} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                    <input className="input h-10 w-20 text-right" inputMode="decimal" aria-label={`${r.label} quantity`}
                      value={amounts[r.key] ?? ''} onChange={(e) => setAmount(r.key, e.target.value)} placeholder="0" />
                  </li>
                ))}
              </ul>
            </>
          )}
          <Field label="Remarks (optional)">
            <input className="input" maxLength={300} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </>
      )}

      <SubmitBar disabled={!valid} onCancel={onClose}
        label={!valid ? (returning ? 'Return' : 'Issue')
          : `${returning ? 'Return' : 'Issue'} ${qty(total)} ${unit} · ${chosen.length} ${noun}`} />
      <ConfirmDialog open={confirming} title={returning ? 'Confirm return' : 'Confirm issue'} busy={busy}
        confirmLabel={returning ? 'Record return' : 'Record issue'} onClose={() => setConfirming(false)} onConfirm={record}>
        <p>{returning ? 'Return' : 'Issue'} <strong>{item?.name}</strong>:</p>
        <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl bg-slate-50 px-3 py-2 text-sm">
          {chosen.map((r) => <li key={r.key} className="flex justify-between gap-3"><span>{rowLabel(r)}</span><strong>{qty(r.n)} {unit}</strong></li>)}
        </ul>
        <p className="text-xs text-slate-500">Inventory transactions cannot be edited or deleted once recorded. A mistake is corrected with a new transaction.</p>
      </ConfirmDialog>
    </form>
  );
}

function JourneyInventory({ id }) {
  const { me, queue, can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const j = journey.data;
  const readable = can('inventory.read');
  const balance = useResource(j && readable ? `/inventory/journeys/${id}/balance` : null);
  const [pageNo, setPageNo] = useState(1);
  const ledger = useResource(j && readable ? `/inventory/journeys/${id}/transactions` : null, { page: pageNo, page_size: 50 });
  const [type, setType] = useState(null);
  const [scope, setScope] = useState('');

  if (journey.loading && !j) return <Loading />;
  if (!j) return <ErrorNote error={journey.error} onRetry={journey.reload} />;
  const canRecord = canAct(me, 'inventory.record', j);
  const people = [...(j.supervisor_id ? [{ user_id: j.supervisor_id, name: j.supervisor_name }] : []), ...j.staff];
  const by = (uid) => people.find((p) => p.user_id === uid)?.name ?? (uid ? 'Other user' : '—');
  const unsynced = (ledger.data?.items ?? []).filter((t) => t.sync_status === 'pending').length;
  const refresh = () => {
    balance.reload();
    ledger.reload();
    queue.refresh();
  };
  const toWhom = (r) => [r.coach_code ?? (r.recipient_id ? null : 'Journey'), r.recipient_id ? by(r.recipient_id) : null].filter(Boolean).join(' · ');
  const coachRows = (rows) => rows.filter((r) => !scope
    || (scope === 'journey' ? !r.coach_code : scope === 'janitors' ? !!r.recipient_id : r.coach_code === scope));

  return (
    <>
      <PageHeader back="#/inventory"
        title="Inventory" subtitle={`${j.train_no} · ${j.train_name}`}
        actions={canRecord && (
          <>
            <button type="button" className="btn-primary h-10 text-sm" onClick={() => setType('issue')}>Issue</button>
            <button type="button" className="btn-secondary" onClick={() => setType('return')}>Return</button>
          </>
        )} />
      {!canRecord && can('inventory.transact') && (
        <p className="mb-3 text-sm text-slate-500">Only the journey supervisor, its allocated staff or a journey manager can record movements, while the journey is open.</p>
      )}
      {!readable ? <Empty title="You can record movements but not view the journey ledger.">Ask for inventory.read to see balances.</Empty> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase text-slate-500">Scope</span>
            <Segmented label="Scope" value={scope} onChange={setScope}
              options={[{ value: '', label: 'All' }, { value: 'journey', label: 'Whole journey' }, { value: 'janitors', label: 'Given to staff' },
                ...j.coaches.map((c) => ({ value: c.code, label: c.code }))]} />
          </div>
          <Panel title="Balance">
            {unsynced > 0 && balance.source === 'remote' && (
              <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                {unsynced} movement(s) recorded on this device are not yet included in the server balance.
              </p>
            )}
            <DataState res={balance} empty="Nothing issued on this journey yet.">
              {(rows) => (
                <Table rowKey={(r) => `${r.item_id}:${r.coach_code ?? ''}:${r.recipient_id ?? ''}`} rows={coachRows(rows)} columns={[
                  { key: 'item_name', label: 'Item', render: (r) => <><span className="font-medium">{r.item_name}</span><span className="block text-xs text-slate-500">{r.unit}</span></> },
                  { key: 'coach', label: 'Coach / given to', render: toWhom },
                  { key: 'issued', label: 'Issued', render: (r) => qty(r.issued) },
                  { key: 'returned', label: 'Returned', render: (r) => qty(r.returned) },
                  { key: 'consumed', label: 'Consumed', render: (r) => qty(r.consumed) },
                  { key: 'ideal', label: 'Ideal qty', render: (r) => qty(r.ideal_qty) },
                ]} />
              )}
            </DataState>
          </Panel>
          <Panel title="Transactions">
            <DataState res={ledger} empty="No transactions recorded.">
              {(page) => (
                <>
                  <Table rows={coachRows([...page.items].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))))} columns={[
                    { key: 'when', label: 'When', render: (t) => fmtDateTime(t.created_at) },
                    { key: 'type', label: 'Type', render: (t) => <Badge tone={STATE_TONE[t.txn_type]}>{label(t.txn_type)}</Badge> },
                    { key: 'item', label: 'Item', render: (t) => t.item_name ?? (balance.data ?? []).find((b) => b.item_id === t.item_id)?.item_name ?? '—' },
                    { key: 'qty', label: 'Quantity', render: (t) => `${qty(t.quantity)}${t.unit ? ` ${t.unit}` : ''}` },
                    { key: 'coach', label: 'Coach / given to', render: toWhom },
                    { key: 'by', label: 'Recorded by', render: (t) => by(t.created_by_id) },
                    { key: 'remarks', label: 'Remarks', render: (t) => t.remarks ?? '—' },
                    { key: 'sync', label: 'Sync', render: (t) => <SyncState record={t} /> },
                  ]} />
                  <Pager data={page} onPage={setPageNo} />
                </>
              )}
            </DataState>
          </Panel>
        </div>
      )}
      <Dialog open={!!type} title={type === 'issue' ? 'Issue inventory' : 'Return inventory'} onClose={() => setType(null)} wide>
        {type && <MovementForm journey={j} type={type} balance={balance.data} onClose={() => setType(null)} onDone={() => { setType(null); refresh(); }} />}
      </Dialog>
    </>
  );
}

export default function Inventory({ parts }) {
  if (parts[0]) return <JourneyInventory id={parts[0]} key={parts[0]} />;
  return (
    <>
      <PageHeader title="Inventory" subtitle="Consumables issued to and returned from journeys" />
      <JourneyPicker base="/inventory" />
    </>
  );
}
