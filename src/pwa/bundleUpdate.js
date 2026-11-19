// Over-the-air web bundle updates for the Android app.
//
// The APK is a WebView over the Vite build, and normally that build is sealed inside it: a one-line fix in
// src/ needed a new APK, a Play Store release and a user willing to install it. Instead the app asks the
// server which bundle it should be running (GET /app/bundle/latest), downloads the zip, checks it against
// the SHA-256 the server published, and unpacks it into its own storage. The next cold start serves the
// pages from there.
//
// Three things this must never get wrong:
//
//  1. notifyAppReady(). The updater reverts to the previous bundle unless the new one says it started.
//     markBundleHealthy() below is that signal, and it is called from main.jsx after the app mounts. If a
//     bundle white-screens, the phone goes back by itself without anybody touching it.
//  2. Local data must survive. The WebView keeps serving from https://localhost either way, so the origin
//     does not change and the SQLite database and media in OPFS stay exactly where they are. (This is why
//     the app is not simply pointed at the live site with server.url: that changes the origin, and every
//     phone would silently lose its local database.)
//  3. Nothing is applied mid-shift. A new bundle is staged with next() and takes effect on the next cold
//     start, so a reload never happens under someone holding the phone in the middle of a journey. Only a
//     release marked `mandatory` on the server applies at once.
import { serverUrl } from '../services/serverOrigin.js';
import { getDeviceId } from '../security/device.js';
import { isNativeApp } from '../security/native.js';

export const LATEST_PATH = '/api/v1/app/bundle/latest';
export const CHANNEL = 'stable';
// Bundles that failed to start, so a bad release is not downloaded again on every launch. The updater
// reverts on its own; this stops the app re-fetching 6 MB over a field connection to fail the same way.
const FAILED_KEY = 'swachh.bundle.failed';

const plugin = () => globalThis.Capacitor?.Plugins?.CapacitorUpdater ?? null;

function failedBundles() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAILED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rememberFailure(bundleId) {
  try {
    // Keep the last few only: the list exists to stop a retry loop, not to be a history.
    const next = [...new Set([bundleId, ...failedBundles()])].slice(0, 5);
    localStorage.setItem(FAILED_KEY, JSON.stringify(next));
  } catch {
    /* private mode or blocked storage: the worst case is one wasted download */
  }
}

// What this app is running now. `bundle` is the OTA bundle's name ("2.0.8+421", or "builtin" when the app
// is still on the build inside the APK); `native` is the installed APK's versionName, which decides
// whether a bundle needing newer native code may be served at all.
export async function currentBundle() {
  const updater = plugin();
  if (!updater) return { bundle: null, native: null };
  try {
    const now = await updater.current();
    return { bundle: now?.bundle?.version ?? null, native: now?.native ?? null };
  } catch {
    return { bundle: null, native: null };
  }
}

// Tell the updater this bundle started. Until this is called the updater treats the bundle as failed and
// rolls back to the previous one on the next launch -- which is the safety net, so it is called only once
// the app has actually rendered, never at the top of a module.
export async function markBundleHealthy() {
  const updater = plugin();
  if (!updater) return;
  try {
    await updater.notifyAppReady();
  } catch {
    /* nothing useful to do: the updater will revert, which is the safe direction */
  }
}

// Ask the server what this device should run. Returns null for "stay where you are", which is the normal
// answer. Never throws: a server that is unreachable, behind a captive portal, or answering with HTML must
// leave the app alone rather than report an update it cannot stand behind.
export async function checkBundleUpdate({
  fetchImpl = (...a) => fetch(...a),
  channel = CHANNEL,
  now = null,
  deviceId = null,
} = {}) {
  if (!isNativeApp() || !plugin()) return null;
  const state = now ?? (await currentBundle());
  const device = deviceId ?? (await getDeviceId().catch(() => null));

  const url = new URL(serverUrl(LATEST_PATH), globalThis.location?.origin ?? 'https://localhost');
  url.searchParams.set('channel', channel);
  if (state.bundle) url.searchParams.set('current', state.bundle);
  if (state.native) url.searchParams.set('native', state.native);
  if (device) url.searchParams.set('device', device);

  let res;
  try {
    res = await fetchImpl(url.toString(), { cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch {
    return null;
  }
  if (res.status === 204 || !res.ok) return null;
  if (!(res.headers?.get('content-type') ?? '').includes('json')) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body?.bundle_id || !body?.url || !body?.sha256) return null;
  // A bundle that has already failed to start on this phone is not offered again.
  if (failedBundles().includes(body.bundle_id)) return null;
  return {
    bundleId: body.bundle_id,
    version: body.version,
    build: body.build,
    url: serverUrl(body.url),
    sha256: body.sha256,
    sizeBytes: body.size_bytes ?? null,
    mandatory: Boolean(body.mandatory),
  };
}

// Download and stage a bundle. `mandatory` applies it at once (and reloads the WebView); otherwise it is
// staged for the next cold start, so no one loses a form they are filling in.
//
// The checksum is passed to the updater, which refuses a download that does not match it. That matters:
// this is the one path by which the app runs code it did not ship with, and the hash is what ties those
// bytes back to the build the server published.
export async function applyBundleUpdate(update, { onProgress = null } = {}) {
  const updater = plugin();
  if (!updater || !update) return { applied: false, reason: 'unavailable' };

  let listener;
  if (onProgress && updater.addListener) {
    try {
      listener = await updater.addListener('download', (e) => onProgress(e?.percent ?? 0));
    } catch {
      listener = undefined;
    }
  }

  try {
    const bundle = await updater.download({
      url: update.url,
      version: update.bundleId,
      checksum: update.sha256,
    });
    if (!bundle?.id) throw new Error('updater returned no bundle id');
    if (update.mandatory) {
      await updater.set({ id: bundle.id });
      return { applied: true, immediate: true };
    }
    await updater.next({ id: bundle.id });
    return { applied: true, immediate: false };
  } catch (e) {
    // A download or checksum failure must not be retried every time the app is opened on a connection
    // that is already struggling.
    rememberFailure(update.bundleId);
    return { applied: false, reason: e?.message ?? 'download_failed' };
  } finally {
    try {
      await listener?.remove?.();
    } catch {
      /* listener already gone */
    }
  }
}
