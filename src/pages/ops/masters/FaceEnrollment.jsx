// Register an employee's face for attendance verification (Masters → Users → Face). Four photos are analysed
// on this device into face descriptors; only the descriptors are sent, with the recorded consent. The photos
// exist only in this dialog's memory and are dropped when it closes. Needs a connection (server write).
import { useRef, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { useNotify } from '../../../app/Layout.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';
import { AlertIcon, CameraIcon, CheckIcon, Spinner } from '../../../components/Icons.jsx';
import { ConfirmDialog, Dialog, ErrorNote, fmtDateTime } from '../../../components/ui.jsx';
import { compressImage } from '../../../utils/capture.js';
import { ENROL_CONSISTENCY, FACE_MODEL, SAMPLES, enrolmentSpread } from '../../../face/faceMatch.js';
import { describeFace } from '../../../face/faceEngine.js';

function Slot({ n, slot, onPick }) {
  const input = useRef(null);
  return (
    <div className="space-y-1">
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" data-testid={`face-photo-${n}`}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      <button type="button" onClick={() => input.current.click()} aria-label={`Face photo ${n}${slot?.descriptor ? ' ready' : ''}`}
        className={`relative grid aspect-square w-full place-items-center overflow-hidden rounded-2xl border-2 ${slot?.descriptor ? 'border-emerald-500' : slot?.error ? 'border-red-400' : 'border-dashed border-brand-300 bg-brand-50/50'}`}>
        {slot?.url ? <img src={slot.url} alt="" className="h-full w-full object-cover" />
          : <span className="flex flex-col items-center gap-1 text-xs font-semibold text-brand-800"><CameraIcon className="h-6 w-6" />Photo {n}</span>}
        {slot?.busy && <span className="absolute inset-0 grid place-items-center bg-white/70"><Spinner className="h-6 w-6" /></span>}
        {slot?.descriptor && <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white"><CheckIcon className="h-4 w-4" /></span>}
      </button>
      {slot?.error && <p className="text-[11px] leading-tight text-red-700">{slot.error}</p>}
    </div>
  );
}

export default function FaceEnrollDialog({ user, onClose }) {
  const { api } = useSession();
  const notify = useNotify();
  const online = useNetworkStatus();
  const status = useResource(`/users/${user.id}/face`);
  const [consent, setConsent] = useState(false);
  const [slots, setSlots] = useState(() => Array(SAMPLES).fill(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(false);

  const setSlot = (i, v) => setSlots((s) => s.map((x, k) => (k === i ? v : x)));
  async function pick(i, file) {
    if (slots[i]?.url) URL.revokeObjectURL(slots[i].url);
    const dataUrl = await compressImage(file, 960);
    const url = URL.createObjectURL(file);
    setSlot(i, { url, busy: true });
    try {
      const { descriptor } = await describeFace(dataUrl);
      setSlot(i, { url, descriptor });
    } catch (e) {
      setSlot(i, { url, error: e.message });
    }
  }
  const close = () => {
    slots.forEach((s) => s?.url && URL.revokeObjectURL(s.url));
    onClose();
  };

  const descriptors = slots.map((s) => s?.descriptor).filter(Boolean);
  const complete = descriptors.length === SAMPLES;
  const spread = complete ? enrolmentSpread(descriptors) : 0;
  const samePerson = spread <= ENROL_CONSISTENCY;
  const ready = online && consent && complete && samePerson && !busy;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/users/${user.id}/face`, { model: FACE_MODEL, descriptors, consent: true });
      notify('success', `Face registered for ${user.name}.`);
      close();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function remove() {
    try {
      await api.del(`/users/${user.id}/face`);
      notify('success', `Face registration removed for ${user.name}.`);
      close();
    } catch (e) {
      setError(e);
      setRemoving(false);
    }
  }

  const s = status.data;
  return (
    <Dialog open title={`Face registration · ${user.name}`} onClose={close} wide>
      <div className="space-y-4">
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200" data-testid="face-status">
          {status.loading ? 'Checking…' : s?.enrolled
            ? <>Registered {fmtDateTime(s.updated_at)} ({s.samples} photos). Registering again replaces it.</>
            : 'No face registered yet. With face verification on, this employee cannot be marked present until registered.'}
        </p>
        {!online && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Registering a face needs a connection.</p>}
        <label className="flex items-start gap-3 rounded-xl bg-brand-50/60 p-3 text-sm text-slate-800 ring-1 ring-brand-100">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand-700" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I confirm that <b>{user.name}</b> agreed that photos of their face are used to verify their attendance. Only face codes
            (numbers) are stored; the photos are not saved and are discarded after processing.</span>
        </label>
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-800">Take {SAMPLES} clear photos of the face (front, slightly left, slightly right, front again)</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {slots.map((slot, i) => <Slot key={i} n={i + 1} slot={slot} onPick={(f) => pick(i, f)} />)}
          </div>
        </div>
        {complete && !samePerson && (
          <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> These photos do not look like the same person. Retake them of {user.name} only.
          </p>
        )}
        <ErrorNote error={error ?? status.error} />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          {s?.enrolled
            ? <button type="button" className="btn-secondary h-12 justify-center text-red-700" disabled={!online} onClick={() => setRemoving(true)}>Remove</button>
            : <button type="button" className="btn-secondary h-12 justify-center" onClick={close}>Cancel</button>}
          <button type="button" className="btn-primary" disabled={!ready} onClick={save}>{busy && <Spinner />} Save face</button>
        </div>
      </div>
      <ConfirmDialog open={removing} title="Remove face registration" danger confirmLabel="Remove" onClose={() => setRemoving(false)} onConfirm={remove}>
        <p>{user.name} will not be able to be marked present while face verification is on, until registered again.</p>
      </ConfirmDialog>
    </Dialog>
  );
}
