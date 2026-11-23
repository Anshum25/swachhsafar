// An office's wallet on its Admin's home screen. Backend: GET /clients/{id}/wallet
// (services/clients.wallet_summary). Read-only on purpose: only the Super Admin adds credits, once the office
// has paid -- an office cannot fill its own wallet (the server refuses it).
import { useResource, useSession } from '../../app/session.jsx';
import { navigate } from '../../app/router.js';
import { fmtDateTime } from '../../components/ui.jsx';

const REASON = { top_up: 'Credits added', journey_charge: 'Journey', journey_refund: 'Journey refunded', adjustment: 'Adjustment' };
const fmt = (n) => (n ?? 0).toLocaleString('en-IN');

export default function WalletCard() {
  const { client, can } = useSession();
  const res = useResource(client && can('clients.read') ? `/clients/${client.id}/wallet` : null);
  const w = res.data;
  if (!client || !can('clients.read') || !w) return null;
  const free = w.credit_per_journey === 0;
  const short = !free && w.upcoming_cost > w.credit_balance;
  const tone = w.credit_balance === 0 && !free ? 'red' : w.low_credit || short ? 'amber' : 'ok';
  const ring = { red: 'ring-red-200', amber: 'ring-amber-200', ok: 'ring-slate-200/70' }[tone];

  return (
    <section className={`mb-4 rounded-2xl bg-white p-4 shadow-card ring-1 sm:p-5 ${ring}`} data-testid="wallet-card" aria-label="Credit wallet">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-600">Credit wallet · {w.office_id}</p>
          <p className={`mt-1 text-3xl font-semibold tabular-nums tracking-tight ${tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : 'text-ink'}`}>
            {fmt(w.credit_balance)} <span className="text-base font-medium text-muted">credits</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {free ? 'Journeys are free for this office.' : `${fmt(w.credit_per_journey)} per journey · enough for about ${fmt(w.journeys_covered)} more`}
          </p>
        </div>
        <button type="button" className="btn-secondary h-9 text-xs" onClick={() => navigate('/masters/clients')}>Full history</button>
      </div>

      <dl className="mt-4 grid grid-cols-3 divide-x divide-slate-100 rounded-xl bg-slate-50 py-2 text-center">
        <div><dt className="text-[11px] text-muted">Added this month</dt><dd className="font-semibold tabular-nums text-ink">+{fmt(w.added_this_month)}</dd></div>
        <div><dt className="text-[11px] text-muted">Spent this month</dt><dd className="font-semibold tabular-nums text-ink">{fmt(w.spent_this_month)}</dd></div>
        <div><dt className="text-[11px] text-muted">Planned, not paid yet</dt><dd className="font-semibold tabular-nums text-ink">{fmt(w.upcoming_journeys)} <span className="text-xs font-normal text-muted">({fmt(w.upcoming_cost)} cr)</span></dd></div>
      </dl>

      {(tone !== 'ok') && (
        <p className={`mt-3 rounded-xl px-3 py-2 text-xs ${tone === 'red' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}>
          {w.credit_balance === 0 && !free
            ? 'No credits left: no new journey can be created, and planned journeys are cancelled on their start day. '
            : short
              ? `The ${fmt(w.upcoming_journeys)} planned journeys need ${fmt(w.upcoming_cost)} credits; any the balance cannot cover are cancelled on their start day. `
              : 'Credits are running low. '}
          Ask the Super Admin to add credits for {w.office_id}.
        </p>
      )}

      {w.recent.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {w.recent.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-slate-700">{REASON[r.reason] ?? r.reason}{r.reference ? ` · ${r.reference}` : ''}
                <span className="ml-2 text-xs text-muted">{fmtDateTime(r.created_at)}</span></span>
              <span className={`shrink-0 font-semibold tabular-nums ${r.delta > 0 ? 'text-emerald-700' : 'text-ink'}`}>{r.delta > 0 ? '+' : ''}{fmt(r.delta)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted">Only the Super Admin adds credits, once your office has paid.</p>
    </section>
  );
}
