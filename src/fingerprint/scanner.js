// The USB fingerprint scanner, as the app sees it.
//
// Everything below is the contract with the native side; the implementation lives in a Capacitor plugin
// that wraps the scanner vendor's Android SDK (ACPL, for the Access AST300 over USB OTG). The browser has
// no scanner, so there the provider is simply absent and every screen falls back to the face check.
//
// Why matching happens natively, unlike faces: a face descriptor is 128 numbers and comparing two is a
// subtraction, which is honest to do in JavaScript. Fingerprints are minutiae templates, and comparing
// them is the vendor's matcher -- a real algorithm we are not going to reimplement, and whose score scale
// belongs to it. So the app stores templates and asks the scanner to compare; it never invents a score.
//
// IMPORTANT: a UIDAI "RD Service" cannot be used for this. It returns a PID block encrypted for UIDAI, so
// nothing can be stored or compared locally. This needs the vendor's non-Aadhaar SDK.

export const TEMPLATE_FORMAT = 'iso-19794-2';

// Fingers offered at enrolment, in the order a person is usually asked for them.
export const FINGERS = [
  { id: 'right_index', label: 'Right index' },
  { id: 'left_index', label: 'Left index' },
  { id: 'right_thumb', label: 'Right thumb' },
  { id: 'left_thumb', label: 'Left thumb' },
  { id: 'right_middle', label: 'Right middle' },
  { id: 'left_middle', label: 'Left middle' },
];
export const fingerLabel = (id) => FINGERS.find((f) => f.id === id)?.label ?? id;

// The native plugin, or null in a browser / an APK built before the scanner existed.
export function scanner() {
  const plugin = globalThis.Capacitor?.Plugins?.SwachhFingerprint;
  return plugin && typeof plugin.capture === 'function' ? plugin : null;
}

export const scannerSupported = () => scanner() != null;

// Is a scanner plugged in and ready right now? Never throws: an answer of "no" is a normal state, not an
// error, because the scanner is a separate object that is often simply not there.
export async function scannerStatus(plugin = scanner()) {
  if (!plugin) return { supported: false, connected: false, reason: 'unsupported' };
  try {
    const s = await plugin.status();
    return { supported: true, connected: s?.connected === true, device: s?.device ?? null,
             matcher: s?.matcher ?? null, reason: s?.connected ? 'ready' : s?.reason ?? 'disconnected' };
  } catch (e) {
    return { supported: true, connected: false, reason: e?.message ?? 'unavailable' };
  }
}

// How long the native side is given beyond its own timeout before the app stops waiting on it.
export const SCAN_GRACE_MS = 5_000;

// Rejects with a `timeout` ScanError if `promise` has not settled in time. The native call is left to
// finish on its own; its answer is simply no longer waited for.
function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('The scanner did not answer.'), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SCAN_ERRORS = {
  no_scanner: 'No fingerprint scanner is connected. Plug it in, or use the photo check instead.',
  timeout: 'No finger was read. Place the finger flat on the scanner and hold still.',
  poor_quality: 'The scan was not clear enough. Wipe the sensor and the finger, then try again.',
  cancelled: 'Scan cancelled.',
  permission: 'Permission to use the scanner was refused.',
};
// The canned sentence says what to do about it; the scanner's own words say what happened. Keeping only
// the first made every failure read "the scan was not clear enough", including the ones that had nothing
// to do with the finger -- so a clear print and a result the app could not read looked the same.
export const scanMessage = (code, detail) => {
  const known = SCAN_ERRORS[code];
  if (!known) return detail || 'The fingerprint could not be read.';
  return detail && detail !== known ? `${known} (${detail})` : known;
};

// One capture: { template, format, quality, finger }. Throws ScanError, which callers show as-is.
//
// `timeoutMs` is handed to the native side, but it is also enforced here, with a grace margin. A native
// capture goes out to the scanner vendor's own activity, and anything that activity does not come back
// from -- a missing companion app, a result that cannot be unparcelled, a driver that never answers --
// would otherwise leave the promise pending for ever, and the screen waiting on a spinner that can never
// stop. A scan that has not answered in time is a failed scan, and is reported as one so it can be retried.
export async function captureFinger({ finger, timeoutMs = 15_000 } = {}, plugin = scanner()) {
  if (!plugin) throw new ScanError('no_scanner', scanMessage('no_scanner'));
  let out;
  try {
    out = await withTimeout(plugin.capture({ timeoutMs }), timeoutMs + SCAN_GRACE_MS);
  } catch (e) {
    throw new ScanError(e?.code ?? 'failed', scanMessage(e?.code, e?.message));
  }
  if (!out?.template) throw new ScanError(out?.code ?? 'poor_quality', scanMessage(out?.code, out?.message));
  return { template: out.template, format: out.format ?? TEMPLATE_FORMAT, quality: out.quality ?? null, finger };
}

// Compares a freshly captured template against an employee's registered ones, using the scanner's own
// matcher. Returns { score, finger, matcher } for the best finger, or null when nothing could be compared.
export async function matchFinger({ template, profile }, plugin = scanner()) {
  if (!plugin || !template || !profile?.fingers?.length) return null;
  try {
    const r = await plugin.match({ template, candidates: profile.fingers, format: profile.format });
    if (typeof r?.score !== 'number') return null;
    return { score: r.score, finger: r.finger ?? null, matcher: r.matcher ?? profile.matcher };
  } catch {
    return null;
  }
}
