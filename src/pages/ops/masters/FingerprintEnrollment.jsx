// Register an employee's fingerprints for attendance verification (Masters → Users → Fingerprint).
//
// Each finger is read on the USB scanner and turned into a minutiae template by the scanner's own SDK;
// only the templates are sent, with the recorded consent. Fingerprint images are never produced, stored
// or transmitted — a leaked image is what would let someone forge a finger.
//
// At least two fingers are registered on purpose: a cut, a bandage or a wet hand must not leave someone
// unable to be marked present for a whole shift.
import { useEffect, useRef, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { useNotify } from '../../../app/Layout.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';
import { AlertIcon, CheckIcon, FingerprintIcon, Spinner } from '../../../components/Icons.jsx';
import { ConfirmDialog, Dialog, ErrorNote, fmtDateTime } from '../../../components/ui.jsx';
import { FINGERS, TEMPLATE_FORMAT, captureFinger, fingerLabel, scannerStatus } from '../../../fingerprint/scanner.js';
import { MIN_FINGERS, SAMPLES_PER_FINGER } from '../../../fingerprint/fingerprintMatch.js';

// A tile is empty, waiting on the scanner, failed, or filled with the presses taken so far. A finger is
// registered from SAMPLES_PER_FINGER presses, not one, and the tile shows how far along it is: it fills
// from the bottom, the count reads 2/4, and it only turns green once the finger is done. While a press
// is being waited for the tile is the button that stops waiting -- a scanner gone quiet must never
// strand it.
function FingerSlot({ finger, slot, onScan, onCancel, disabled }) {
  const taken = slot?.templates?.length ?? 0;
  const done = taken >= SAMPLES_PER_FINGER;
  const busy = !!slot?.busy;
  const pct = Math.round((Math.min(taken, SAMPLES_PER_FINGER) / SAMPLES_PER_FINGER) * 100);
  return (
    <div className="space-y-1">
      <button type="button" onClick={busy ? onCancel : onScan} disabled={(disabled && !busy) || (done && !busy)}
        aria-label={busy ? `Stop waiting for ${finger.label}`
          : done ? `${finger.label} recorded, ${taken} presses`
            : `Scan ${finger.label}, press ${taken + 1} of ${SAMPLES_PER_FINGER}`}
        data-testid={`finger-${finger.id}`}
        className={`relative grid aspect-square w-full place-items-center gap-0.5 overflow-hidden rounded-2xl border-2 transition duration-150 active:scale-[0.97] disabled:active:scale-100 ${
          done ? 'border-emerald-500 bg-emerald-50/60'
            : slot?.error ? 'border-red-400 bg-red-50/50'
              : taken ? 'border-brand-500 bg-brand-50' : 'border-dashed border-brand-300 bg-brand-50/50'}`}>
        {/* How much of the finger has been recorded, drawn as the tile filling from the bottom. */}
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-brand-200/60 transition-[height] duration-300"
          style={{ height: done ? '0%' : `${pct}%` }} />
        <FingerprintIcon className={`relative h-7 w-7 ${done ? 'text-emerald-600' : 'text-brand-700'}`} />
        <span className="relative px-1 text-center text-[11px] font-semibold leading-tight text-slate-700">{finger.label}</span>
        <span className={`relative text-[10px] font-bold tabular-nums ${done ? 'text-emerald-700' : 'text-brand-800'}`}
          data-testid={`finger-${finger.id}-progress`}>
          {done ? 'Done' : `${taken}/${SAMPLES_PER_FINGER}`}
        </span>
        {busy && (
          <span className="absolute inset-0 grid place-items-center gap-1 bg-white/85">
            <Spinner className="h-6 w-6" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Tap to stop</span>
          </span>
        )}
        {done && <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white"><CheckIcon className="h-4 w-4" /></span>}
      </button>
      {slot?.error && <p className="text-[11px] leading-tight text-red-700">{slot.error}</p>}
      {!done && taken > 0 && !slot?.error && !busy && (
        <p className="text-[11px] leading-tight text-brand-800">Press again, shifted a little.</p>
      )}
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
  const scanToken = useRef({});

  useEffect(() => {
    let cancelled = false;
    scannerStatus().then((s) => !cancelled && setDevice(s));
    return () => { cancelled = true; };
  }, []);

  // One press. Each carries a token: only the newest press for a finger may write its tile, so a capture
  // that was given up on (or restarted) cannot come back later and overwrite what is on screen. A press
  // adds to what that finger already has rather than replacing it.
  async function scan(finger) {
    const token = (scanToken.current[finger.id] ?? 0) + 1;
    scanToken.current[finger.id] = token;
    setSlots((s) => ({ ...s, [finger.id]: { ...s[finger.id], busy: true, error: null } }));
    const write = (fn) => setSlots((s) => (scanToken.current[finger.id] === token
      ? { ...s, [finger.id]: fn(s[finger.id] ?? {}) } : s));
    try {
      const out = await captureFinger({ finger: finger.id });
      write((prev) => ({
        templates: [...(prev.templates ?? []), out.template].slice(0, SAMPLES_PER_FINGER),
        // The tile reports the finger, not the last attempt at it, so the best press is the one shown.
        quality: Math.max(prev.quality ?? 0, out.quality ?? 0) || null,
        busy: false,
        error: null,
      }));
    } catch (e) {
      write((prev) => ({ ...prev, busy: false, error: e.message }));
    }
  }

  // Stop waiting on a press. The scanner is left to finish in its own time and its answer is dropped;
  // the presses already taken for that finger stay.
  function cancelScan(finger) {
    scanToken.current[finger.id] = (scanToken.current[finger.id] ?? 0) + 1;
    setSlots((s) => ({ ...s, [finger.id]: { ...s[finger.id], busy: false, error: 'Scan stopped. Tap to try again.' } }));
  }

  // Only a finger with all of its presses counts. A half-recorded finger is exactly the one that fails
  // to verify later, which is the whole reason for taking several.
  const captured = FINGERS
    .filter((f) => (slots[f.id]?.templates?.length ?? 0) >= SAMPLES_PER_FINGER)
    .map((f) => ({ finger: f.id, templates: slots[f.id].templates }));
  const enough = captured.length >= MIN_FINGERS;
  const ready = online && consent && enough && device.connected && !busy;
  // A greyed-out button that does not say what it is waiting for is just a dead end, and the three
  // things it waits for (a scanner, the consent box, two good scans) are not guessable from the tile grid.
  const blocker = !device.connected ? 'Connect the scanner to register.'
    : !online ? 'Registering fingerprints needs a connection.'
    : !consent ? 'Tick the consent box above to register.'
    : !enough ? `Finish ${MIN_FINGERS - captured.length} more finger${MIN_FINGERS - captured.length === 1 ? '' : 's'}: ${SAMPLES_PER_FINGER} presses each.`
    : null;

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
          <p className="mb-1 text-sm font-semibold text-slate-800">
            Record at least {MIN_FINGERS} fingers (e.g. Right &amp; Left Index). Any additional fingers are optional.
          </p>
          <p className="mb-2 text-xs leading-relaxed text-slate-600">
            Press each finger {SAMPLES_PER_FINGER} times, lifting it between presses and shifting it a
            little each time — tip, centre, then slightly to each side. One press records only the part
            of the fingertip that touched the sensor, and a finger that later lands differently would
            not be recognised.
          </p>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {FINGERS.map((f) => <FingerSlot key={f.id} finger={f} slot={slots[f.id]} disabled={!device.connected}
              onScan={() => scan(f)} onCancel={() => cancelScan(f)} />)}
          </div>
        </div>
        <ErrorNote error={error ?? status.error} />
        {blocker && <p className="text-sm text-slate-600" data-testid="fingerprint-blocker">{blocker}</p>}
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
