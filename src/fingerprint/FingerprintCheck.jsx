// Attendance fingerprint check: reads a finger on the USB scanner and compares it with the employee's
// registered templates held on this device (works offline).
//
// It sits beside the face check, never instead of it. The scanner is a separate piece of hardware that
// can be left behind, unplugged or broken, and a phone without one must still be able to mark attendance
// by photo. So this control appears only when a scanner is actually there, and failing to scan is never
// a dead end: the face check is still on screen.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../app/session.jsx';
import { AlertIcon, CheckIcon, FingerprintIcon, Spinner } from '../components/Icons.jsx';
import { captureFinger, fingerLabel, matchFinger, scannerStatus } from './scanner.js';
import { decideFingerprint } from './fingerprintMatch.js';

// { status, scan } where status is off | unavailable | ready | scanning | matched | mismatch |
// not_enrolled | wrong_matcher | unreadable | error.
export function useFingerprintCheck({ employeeId, enabled, threshold }) {
  const { store } = useSession();
  const [state, setState] = useState({ status: enabled ? 'ready' : 'off' });
  const [device, setDevice] = useState({ supported: false, connected: false });

  useEffect(() => {
    if (!enabled) { setState({ status: 'off' }); return undefined; }
    let cancelled = false;
    scannerStatus().then((s) => {
      if (cancelled) return;
      setDevice(s);
      setState((prev) => (prev.status === 'off' || prev.status === 'unavailable' || prev.status === 'ready'
        ? { status: s.connected ? 'ready' : 'unavailable', reason: s.reason } : prev));
    });
    return () => { cancelled = true; };
  }, [enabled, employeeId]);

  // Resets when the dialog moves to another employee: a scan belongs to the person it was taken for.
  useEffect(() => { setState(enabled ? { status: 'ready' } : { status: 'off' }); }, [employeeId, enabled]);

  const scan = useCallback(async () => {
    setState({ status: 'scanning' });
    try {
      const profile = await store.masters.getFingerprintProfile(employeeId);
      if (!profile) { setState({ status: 'not_enrolled' }); return; }
      const captured = await captureFinger({});
      const result = await matchFinger({ template: captured.template, profile });
      const decision = decideFingerprint({ result, profile, threshold });
      setState({ status: decision.matched ? 'matched' : decision.reason, ...decision, threshold });
    } catch (e) {
      setState({ status: 'error', message: e.message });
    }
  }, [employeeId, store, threshold]);

  return { ...state, device, scan };
}

export function FingerprintCheckNote({ check, name }) {
  if (check.status === 'off') return null;
  const base = 'flex items-start gap-2 rounded-xl px-3 py-2 text-sm';
  const body = {
    // Not an error: the scanner is optional, and the photo check is still there.
    unavailable: [`${base} bg-slate-50 text-slate-600`, <FingerprintIcon key="f" className="mt-0.5 h-4 w-4" />,
      'No fingerprint scanner connected. Use the photo check, or plug in the scanner.'],
    ready: [`${base} bg-brand-50 text-brand-900`, <FingerprintIcon key="f" className="mt-0.5 h-4 w-4" />,
      `Scan ${name}'s finger, or use the photo check.`],
    scanning: [`${base} bg-brand-50 text-brand-900`, <Spinner key="s" className="mt-0.5 h-4 w-4" />, 'Reading the finger…'],
    matched: [`${base} bg-emerald-50 text-emerald-800`, <CheckIcon key="c" className="mt-0.5 h-4 w-4" />,
      `Fingerprint matched: ${name}${check.finger ? ` (${fingerLabel(check.finger).toLowerCase()})` : ''}.`],
    // The score and the score it had to reach are both named. Without them a refused finger is just a
    // "no", and there is no way to tell a wrong person from a threshold set too high for these scanners --
    // which is exactly the judgement an administrator has to make in Masters -> Division policy.
    mismatch: [`${base} bg-red-50 text-red-800`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />,
      `The fingerprint does not match ${name}${check.score != null ? ` (score ${check.score}, needs ${check.threshold})` : ''}. Try another finger, or use the photo check.`],
    not_enrolled: [`${base} bg-amber-50 text-amber-900`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />,
      `${name} has no registered fingerprints on this device. An administrator must register them (Masters → Users → Fingerprint), then sync.`],
    wrong_matcher: [`${base} bg-amber-50 text-amber-900`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />,
      `${name}'s fingerprints were registered with a different scanner and cannot be compared with this one. They must be registered again.`],
    unreadable: [`${base} bg-red-50 text-red-800`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />,
      'The scanner could not compare that finger. Try again, or use the photo check.'],
  }[check.status] ?? [`${base} bg-red-50 text-red-800`, <AlertIcon key="a" className="mt-0.5 h-4 w-4" />,
    check.message ?? 'The fingerprint could not be read.'];
  return (
    <p className={body[0]} role={check.status === 'matched' || check.status === 'scanning' ? 'status' : 'alert'}
      data-testid="fingerprint-check" data-status={check.status}>{body[1]}<span>{body[2]}</span></p>
  );
}

// The control itself, shown beside the camera. Absent when no scanner is connected, so a phone without
// one looks exactly as it does today.
export function FingerprintButton({ check, name }) {
  if (check.status === 'off' || !check.device?.connected) return null;
  const busy = check.status === 'scanning';
  return (
    <button type="button" className="btn-secondary h-11 w-full justify-center" onClick={check.scan} disabled={busy}
      data-testid="fingerprint-scan" aria-label={`Scan ${name}'s fingerprint`}>
      {busy ? <Spinner /> : <FingerprintIcon className="h-5 w-5" />}
      {check.status === 'matched' ? 'Scan again' : 'Scan fingerprint'}
    </button>
  );
}
