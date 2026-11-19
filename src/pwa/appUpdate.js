// New-version check for the Android app (APK).
//
// The PWA updates itself through the service worker, and since web bundles ship over the air
// (src/pwa/bundleUpdate.js) the APK does too for anything under src/. What is left for this check is the
// one case OTA cannot cover: a release that changes native code, which has to be installed.
//
// So the question is "is the published APK's version newer than the installed one", and NOT "is it a
// different commit". Comparing commits was right when the whole app lived inside the APK; now it is wrong
// twice over. CI rebuilds an APK on every push, so a web-only change -- one that reaches the phone by
// itself -- would put up a banner telling people to sideload an APK containing no native change at all,
// which teaches them to install things they do not need. And once a phone has taken an OTA bundle,
// BUILD_SHA is the bundle's commit rather than the APK's, so the comparison stops describing the APK.
//
// Phones that predate the updater plugin report no native version. Those keep the old commit comparison,
// because they genuinely do need an install -- it is how they get the plugin that makes OTA work at all.
import { serverUrl } from '../services/serverOrigin.js';
import { currentBundle } from './bundleUpdate.js';

export const LATEST_URL = '/downloads/latest.json';
export const DOWNLOAD_URL = '/downloads/swachh-safar-latest.apk';

// The commit this bundle was built from, injected by vite.config.js from VITE_BUILD_SHA (set by CI).
// Empty in a local build: without it there is nothing to compare, so no update is ever offered.
export const BUILD_SHA = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '';

// major.minor.patch -> comparable tuple, or null when it is not a version we can reason about.
const semver = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? '') ? v.split('.').map(Number) : null);

// Is `a` strictly newer than `b`? Only a newer version is ever offered: equal means the installed APK is
// already this release, and older means the phone is ahead of what is published (a rollback of the APK,
// or a test build), neither of which is something to ask anyone to install.
function isNewer(a, b) {
  const [x, y] = [semver(a), semver(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// { available: false } or { available: true, version, url }. Never throws and never reports an update it is
// not sure about: a server that is unreachable, answers with HTML (a captive portal) or publishes no commit
// id leaves the app alone.
export async function checkAppUpdate({
  fetchImpl = (...a) => fetch(...a),
  sha = BUILD_SHA,
  url = serverUrl(LATEST_URL),
  downloadUrl = serverUrl(DOWNLOAD_URL),
  native = undefined,
} = {}) {
  const none = { available: false };
  if (!sha) return none;
  let latest;
  try {
    const res = await fetchImpl(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok || !(res.headers?.get('content-type') ?? 'application/json').includes('json')) return none;
    latest = await res.json();
  } catch {
    return none;
  }
  const published = typeof latest?.sha === 'string' ? latest.sha : '';
  if (!published) return none;

  // The installed APK's own versionName, which only the updater plugin can report. Undefined means this
  // app has no plugin to ask, so it is an APK from before over-the-air updates existed.
  const installed = native === undefined ? (await currentBundle()).native : native;
  if (installed) {
    // OTA-capable: only a genuinely newer native release is worth an install. Everything else arrives on
    // its own, and saying nothing is the correct, quiet answer.
    if (!isNewer(latest.version_name, installed)) return none;
  } else if (published === sha) {
    return none;
  }
  // The download is the release's own file (…/swachh-safar-<sha>.apk), not the swachh-safar-latest.apk
  // alias. The alias is one name for a file that keeps changing, served with a four-hour cache, so a
  // phone can be handed the previous APK under it -- which installs, changes nothing, and leaves this
  // banner up with no way to tell why. A per-build name is safe to cache and says which build it is.
  const file = typeof latest.url === 'string' && latest.url.startsWith('/downloads/') ? serverUrl(latest.url) : downloadUrl;
  return { available: true, version: latest.version_name ?? null, build: published.slice(0, 7), url: file };
}
