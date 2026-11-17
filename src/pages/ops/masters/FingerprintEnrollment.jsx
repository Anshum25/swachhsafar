// Register an employee's fingerprints for attendance verification (Masters → Users → Fingerprint).
//
// Each finger is read on the USB scanner and turned into a minutiae template by the scanner's own SDK;
// only the templates are sent, with the recorded consent. Fingerprint images are never produced, stored
// or transmitted — a leaked image is what would let someone forge a finger.
//
// At least two fingers are registered on purpose: a cut, a bandage or a wet hand must not leave someone
// unable to be marked present for a whole shift.
import { useEffect, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { useNotify } from '../../../app/Layout.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';
import { AlertIcon, CheckIcon, FingerprintIcon, Spinner } from '../../../components/Icons.jsx';
import { ConfirmDialog, Dialog, ErrorNote, fmtDateTime } from '../../../components/ui.jsx';
import { FINGERS, TEMPLATE_FORMAT, captureFinger, fingerLabel, scannerStatus } from '../../../fingerprint/scanner.js';
import { MIN_FINGERS } from '../../../fingerprint/fingerprintMatch.js';

function FingerSlot({ finger, slot, onScan, disabled }) {
  const done = !!slot?.template;
  return (
    <div className="space-y-1">
      <button type="button" onClick={onScan} disabled={disabled || slot?.busy}
        aria-label={`Scan ${finger.label}${done ? ' (registered)' : ''}`}
        data-testid={`finger-${finger.id}`}
        className={`relative grid aspect-square w-full place-items-center gap-1 overflow-hidden rounded-2xl border-2 ${
          done ? 'border-emerald-500 bg-emerald-50/60' : slot?.error ? 'border-red-400' : 'border-dashed border-brand-300 bg-brand-50/50'}`}>
        <FingerprintIcon className={`h-7 w-7 ${done ? 'text-emerald-600' : 'text-brand-700'}`} />
        <span className="px-1 text-center text-[11px] font-semibold leading-tight text-slate-700">{finger.label}</span>
        {slot?.busy && <span className="absolute inset-0 grid place-items-center bg-white/70"><Spinner className="h-6 w-6" /></span>}
        {done && <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white"><CheckIcon className="h-4 w-4" /></span>}
      </button>
      {slot?.error && <p className="text-[11px] leading-tight text-red-700">{slot.error}</p>}
      {done && slot.quality != null && <p className="text-[11px] leading-tight text-slate-500">Quality {slot.quality}</p>}
    </div>
  );
}

export default function FingerprintEnrollDialog({ user, onClose }) {
  const { api } = useSession();
  const notify = useNotify();
  const online = useNetworkStatus();
  const status = useResource(`/users/${user.id}/fingerprint`);
  const [consent, setConsent] = useState(false);
  const [slots, setSlots] = useState({});
  const [device, setDevice] = useState({ supported: false, connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    scannerStatus().then((s) => !cancelled && setDevice(s));
    return () => { cancelled = true; };
  }, []);

  async function scan(finger) {
    setSlots((s) => ({ ...s, [finger.id]: { busy: true } }));
    try {
      const out = await captureFinger({ finger: finger.id });
      setSlots((s) => ({ ...s, [finger.id]: { template: out.template, quality: out.quality } }));
    } catch (e) {
      setSlots((s) => ({ ...s, [finger.id]: { error: e.message } }));
    }
  }

  const captured = FINGERS.filter((f) => slots[f.id]?.template).map((f) => ({ finger: f.id, template: slots[f.id].template }));
  const enough = captured.length >= MIN_FINGERS;
  const ready = online && consent && enough && device.connected && !busy;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/users/${user.id}/fingerprint`, {
        format: TEMPLATE_FORMAT, matcher: device.matcher ?? 'unknown', fingers: captured, consent: true,
      });
      notify('success', `Fingerprints registered for ${user.name}.`);
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function remove() {
    try {
      await api.del(`/users/${user.id}/fingerprint`);
      notify('success', `Fingerprint registration removed for ${user.name}.`);
      onClose();
    } catch (e) {
      setError(e);
      setRemoving(false);
    }
  }

  const s = status.data;
  return (
    <Dialog open title={`Fingerprint registration · ${user.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200" data-testid="fingerprint-status">
          {status.loading ? 'Checking…' : s?.enrolled
            ? <>Registered {fmtDateTime(s.updated_at)} ({s.fingers.map(fingerLabel).join(', ')}). Registering again replaces it.</>
            : 'No fingerprints registered yet. They can still be marked present by photo; fingerprint is an alternative, not a replacement.'}
        </p>
        {!device.connected && (
          <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert" data-testid="no-scanner">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            {device.supported
              ? 'No fingerprint scanner is connected. Plug the scanner into this device and try again.'
              : 'Fingerprints can only be registered in the Android app with a scanner attached.'}
          </p>
        )}
        {!online && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Registering fingerprints needs a connection.</p>}
        <label className="flex items-start gap-3 rounded-xl bg-brand-50/60 p-3 text-sm text-slate-800 ring-1 ring-brand-100">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand-700" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I confirm that <b>{user.name}</b> agreed that their fingerprints are used to verify their attendance. Only
            fingerprint codes (templates) are stored; no fingerprint image is saved or sent.</span>
        </label>
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-800">
            Scan at least {MIN_FINGERS} fingers (e.g. Right & Left Index). Any additional fingers are optional.
          </p>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {FINGERS.map((f) => <FingerSlot key={f.id} finger={f} slot={slots[f.id]} disabled={!device.connected} onScan={() => scan(f)} />)}
          </div>
        </div>
        <ErrorNote error={error ?? status.error} />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          {s?.enrolled
            ? <button type="button" className="btn-secondary h-12 justify-center text-red-700" disabled={!online} onClick={() => setRemoving(true)}>Remove</button>
            : <button type="button" className="btn-secondary h-12 justify-center" onClick={onClose}>Cancel</button>}
          <button type="button" className="btn-primary h-12 justify-center" disabled={!ready} onClick={save} data-testid="save-fingerprints">
            {busy ? <Spinner /> : null} Register {captured.length ? `(${captured.length})` : ''}
          </button>
        </div>
      </div>
      {removing && (
        <ConfirmDialog title="Remove fingerprint registration?" confirmLabel="Remove" tone="danger"
          onCancel={() => setRemoving(false)} onConfirm={remove}>
          {user.name} will no longer be verifiable by fingerprint. They can still be marked present by photo.
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
