// New-version check for the Android app (APK).
//
// The PWA updates itself through the service worker. The APK cannot: its whole build is packaged inside the
// installed app, so a new version only arrives when a newer APK is installed. On start, and whenever the
// device comes back online, the app asks the server which release is published (/downloads/latest.json,
// written by deploy/scripts/receive-release.sh) and compares its commit with the one this build was made
// from. Different commit -> offer the download; anything else -> stay quiet.
import { serverUrl } from '../services/serverOrigin.js';

export const LATEST_URL = '/downloads/latest.json';
export const DOWNLOAD_URL = '/downloads/swachh-safar-latest.apk';

// The commit this bundle was built from, injected by vite.config.js from VITE_BUILD_SHA (set by CI).
// Empty in a local build: without it there is nothing to compare, so no update is ever offered.
export const BUILD_SHA = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '';

// { available: false } or { available: true, version, url }. Never throws and never reports an update it is
// not sure about: a server that is unreachable, answers with HTML (a captive portal) or publishes no commit
// id leaves the app alone.
export async function checkAppUpdate({
  fetchImpl = (...a) => fetch(...a),
  sha = BUILD_SHA,
  url = serverUrl(LATEST_URL),
  downloadUrl = serverUrl(DOWNLOAD_URL),
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
  if (!published || published === sha) return none;
  return { available: true, version: latest.version_name ?? null, url: downloadUrl };
}
