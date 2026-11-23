// Add credits to an office's wallet once it has paid (Super Admin only; the server refuses anyone else).
// Backend: POST /clients/{id}/credits {credits, reference, note}. Used from the Super Admin dashboard's
// Offices table; the office's own page has the same in its Wallet panel (Clients.jsx).
import { useState } from 'react';
import { useSession } from '../../../app/session.jsx';
import { Dialog, ErrorNote, Field, SubmitBar } from '../../../components/ui.jsx';
import { useSave } from './common.jsx';

export default function AddCreditsDialog({ office, onClose, onSaved }) {
  const { api } = useSession();
  const [f, setF] = useState({ credits: '', reference: '', note: '' });
  const save = useSave(() => { onSaved?.(); onClose(); });
  return (
    <Dialog open={!!office} title={office ? `Add credits to ${office.office_id}` : 'Add credits'} onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        save.run(() => api.post(`/clients/${office.client_id ?? office.id}/credits`, {
          credits: Number(f.credits), reference: f.reference.trim() || null, note: f.note.trim() || null,
        }), `${f.credits} credits added to ${office.office_id}.`);
      }}>
      <ErrorNote error={save.error} />
      <p className="mb-3 text-sm text-slate-700">
        {office?.name}: the balance is <b>{office?.credit_balance ?? 0}</b>. Record what the office has paid for; it is added at once and shows in its credit history.
      </p>
      <div className="space-y-3">
        <Field label="Credits">
          <input className="input" inputMode="numeric" autoFocus value={f.credits}
            onChange={(e) => setF({ ...f, credits: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="Payment reference" hint="UTR, cheque or receipt number (optional)">
          <input className="input" maxLength={100} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
        <Field label="Note (optional)">
          <input className="input" maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
      </div>
      <SubmitBar busy={save.busy} disabled={!(Number(f.credits) > 0)} label="Add credits" onCancel={onClose} />
    </Dialog>
  );
}
