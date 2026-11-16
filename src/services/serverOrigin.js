// Where the Swachh Safar server lives, as seen from the running app.
//
// PWA: the page is served by that same server and VITE_API_BASE_URL is relative ('/api/v1'), so the server
// origin is the page's own origin and every URL below stays relative — unchanged from before.
//
// Android app (Capacitor): the page is served by the WebView from https://localhost, so a path like
// '/downloads/latest.json' points at the app's own bundled assets and not at the site. The APK build sets
// VITE_API_BASE_URL to the full https://ehk.itfarmer.in/api/v1, which is the one place the real host is
// configured; everything that must reach the server derives its origin from it instead of hard-coding a host.
import { API_BASE } from './apiClient.js';

const pageOrigin = () => (typeof location === 'undefined' ? '' : location.origin);

// Origin of the API base ('https://ehk.itfarmer.in'), or the page's own origin when the base is relative.
export function serverOrigin({ base = API_BASE, origin = pageOrigin() } = {}) {
  try {
    return new URL(base, origin || undefined).origin;
  } catch {
    return origin;
  }
}

// An absolute URL for a path on the server, or the path itself when the server is this page's own origin
// (the PWA: links and fetches stay relative, so nothing about the web app changes).
export function serverUrl(path, { base = API_BASE, origin = pageOrigin() } = {}) {
  const target = serverOrigin({ base, origin });
  if (!target || target === origin) return path;
  return new URL(path, target).toString();
}
