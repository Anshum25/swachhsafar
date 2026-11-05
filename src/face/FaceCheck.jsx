// Attendance face check: compares the attendance photo with the employee's registered face on this device
// (works offline). With face verification on, attendance can be saved only when this reports `matched`.
import { useEffect, useState } from 'react';
import { useSession } from '../app/session.jsx';
import { AlertIcon, CheckIcon, Spinner } from '../components/Icons.jsx';
import { describeFace } from './faceEngine.js';
import { matchFace, similarityPercent } from './faceMatch.js';

export function useFaceCheck({ photo, employeeId, enabled, threshold }) {
  const { store } = useSession();
  const [state, setState] = useState({ status: enabled ? 'waiting' : 'off' });
  useEffect(() => {
    if (!enabled) { setState({ status: 'off' }); return undefined; }
    if (!photo) { setState({ status: 'waiting' }); return undefined; }
    let cancelled = false;
    setState({ status: 'checking' });
    (async () => {
      const profile = await store.masters.getFaceProfile(employeeId);
      if (!profile) return { status: 'not_enrolled' };
      const { descriptor, model } = await describeFace(photo);
      if (profile.model !== model) return { status: 'not_enrolled' };
      const m = matchFace({ descriptor, profile, threshold });
      return { status: m.matched ? 'matched' : 'mismatch', distance: m.distance, model };
    })().then((r) => !cancelled && setState(r), (e) => !cancelled && setState({ status: e.code ?? 'error', message: e.message }));
    return () => { cancelled = true; };
  }, [photo, employeeId, enabled, threshold, store]);
  return state;
}

// Fields sent with the attendance when the face matched.
export const faceFields = (check) => (check.status === 'matched' ? { face_distance: check.distance, face_model: check.model } : {});

export function FaceCheckNote({ check, name }) {
  if (check.status === 'off') return null;
  const base = 'flex items-start gap-2 rounded-xl px-3 py-2 text-sm';
  const body = {
    waiting: [`${base} bg-brand-50 text-brand-900`, null, `Face verification is on: take a photo of ${name}'s face.`],
    checking: [`${base} bg-brand-50 text-brand-900`, <Spinner key="s" className="mt-0.5 h-4 w-4" />, 'Checking the face…'],
    matched: [`${base} bg-emerald-50 text-emerald-800`, <CheckIcon key="c" className="mt-0.5 h-4 w-4" />, `Face matched: ${name} (${similarityPercent(check.distance)}% similar).`],
    mismatch: [`${base} bg-red-50 text-red-800`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />, `The face does not match ${name} (${similarityPercent(check.distance)}% similar). Retake the photo of ${name}.`],
    not_enrolled: [`${base} bg-red-50 text-red-800`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />, `${name} has no registered face on this device. An administrator must register it (Masters → Users → Face), then sync.`],
  }[check.status] ?? [`${base} bg-red-50 text-red-800`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />, check.message ?? 'Face verification failed.'];
  return <p className={body[0]} role={check.status === 'matched' || check.status === 'checking' ? 'status' : 'alert'} data-testid="face-check" data-status={check.status}>{body[1]}<span>{body[2]}</span></p>;
}
