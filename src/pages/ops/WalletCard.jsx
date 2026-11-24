// An office's credit wallet, in the top bar next to the bell: the balance on the button, the details in a
// panel that opens from it. Backend: GET /clients/{id}/wallet (services/clients.wallet_summary).
//
// Read-only on purpose: only the Super Admin adds credits, once the office has paid -- an office cannot fill
// its own wallet (the server refuses it). Shown to users who may read their office (clients.read: its Admin).
import { useEffect, useRef, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { navigate } from '../../app/router.js';
import { fmtDateTime } from '../../components/ui.jsx';
import { WalletIcon } from '../../components/Icons.jsx';
import { compact } from './overviewMath.js';

const REASON = { top_up: 'Credits added', journey_charge: 'Journey', journey_refund: 'Journey refunded', adjustment: 'Adjustment' };
const fmt = (n) => (n ?? 0).toLocaleString('en-IN');

// red: out of credits; amber: low, or short of what older planned journeys still need; ok otherwise.
export function walletTone(w) {
  if (!w) return 'ok';
  const free = w.credit_per_journey === 0;
  if (w.credit_balance === 0 && !free) return 'red';
  if (w.low_credit || (!free && w.upcoming_cost > w.credit_balance)) return 'amber';
  return 'ok';
}

function WalletDetails({ w, onClose }) {
  const free = w.credit_per_journey === 0;
  const tone = walletTone(w);
  const short = !free && w.upcoming_cost > w.credit_balance;
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-600">Credit wallet · {w.office_id}</p>
          <p className={`mt-1 text-3xl font-semibold tabular-nums tracking-tight ${tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : 'text-ink'}`}>
            {fmt(w.credit_balance)} <span className="text-base font-medium text-muted">credits</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {free ? 'Journeys are free for this office.' : `${fmt(w.credit_per_journey)} per journey · enough for about ${fmt(w.journeys_covered)} more`}
          </p>
        </div>
        <button type="button" className="btn-secondary h-9 shrink-0 text-xs" onClick={() => { onClose(); navigate('/masters/clients'); }}>Full history</button>
      </div>

      <dl className="grid grid-cols-3 divide-x divide-slate-100 rounded-xl bg-slate-50 py-2 text-center">
        <div><dt className="text-[11px] text-muted">Added this month</dt><dd className="font-semibold tabular-nums text-ink">+{fmt(w.added_this_month)}</dd></div>
        <div><dt className="text-[11px] text-muted">Spent this month</dt><dd className="font-semibold tabular-nums text-ink">{fmt(w.spent_this_month)}</dd></div>
        <div><dt className="text-[11px] text-muted">Per journey</dt><dd className="font-semibold tabular-nums text-ink">{free ? 'Free' : `${fmt(w.credit_per_journey)} cr`}</dd></div>
      </dl>

      {tone !== 'ok' && (
        <p className={`rounded-xl px-3 py-2 text-xs ${tone === 'red' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}>
          {w.credit_balance === 0 && !free
            ? 'No credits left: no new journey can be created, and the daily planning creates none until credits are added. '
            : short
              ? `${fmt(w.upcoming_journeys)} older planned journeys still need ${fmt(w.upcoming_cost)} credits; any the balance cannot cover are cancelled when they start. `
              : 'Credits are running low. '}
          Ask the Super Admin to add credits for {w.office_id}.
        </p>
      )}

      {w.recent.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {w.recent.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-slate-700">{REASON[r.reason] ?? r.reason}{r.reference ? ` · ${r.reference}` : ''}
                <span className="ml-2 text-xs text-muted">{fmtDateTime(r.created_at)}</span></span>
              <span className={`shrink-0 font-semibold tabular-nums ${r.delta > 0 ? 'text-emerald-700' : 'text-ink'}`}>{r.delta > 0 ? '+' : ''}{fmt(r.delta)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted">Only the Super Admin adds credits, once your office has paid.</p>
    </div>
  );
}

// The top-bar button: wallet icon and the balance; the details open below it (full width on a phone).
export default function WalletButton() {
  const { client, can } = useSession();
  const allowed = !!client && can('clients.read');
  const res = useResource(allowed ? `/clients/${client.id}/wallet` : null);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    res.reload(); // journeys are charged as they are created: show the balance as of now
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const w = res.data;
  if (!allowed || !w) return null;
  const tone = walletTone(w);
  const chip = { red: 'bg-red-50 text-red-700 ring-red-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200', ok: 'bg-brand-50 text-brand-800 ring-brand-200' }[tone];

  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        aria-label={`Credit wallet: ${fmt(w.credit_balance)} credits`} data-testid="wallet-button"
        className={`flex h-10 items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold tabular-nums ring-1 transition hover:brightness-95 ${chip}`}>
        <WalletIcon className="h-5 w-5 shrink-0" />
        <span>{compact(w.credit_balance)}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Credit wallet"
          className="fixed inset-x-2 top-16 z-30 max-h-[80vh] animate-modal-in overflow-auto rounded-2xl bg-white p-4 text-left shadow-raised ring-1 ring-line sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-96">
          <WalletDetails w={w} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
