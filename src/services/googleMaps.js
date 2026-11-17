// The Google Maps JavaScript API, loaded in the browser and only when a map is actually shown.
//
// Why in the browser and not through our server, as reverse geocoding is: the key issued for this app is a
// browser key restricted by HTTP referrer (ehk.itfarmer.in), which is exactly how the Maps JS API is meant
// to be keyed -- a referrer-restricted key is refused when it is used from a server (REQUEST_DENIED). The
// restriction is what keeps the key from being used elsewhere, so the key living in the bundle is expected.
//
// Everything here is best effort. This app is offline first: with no key, no network, a blocked script or a
// referrer the key does not allow, load() resolves to null, and every caller falls back to showing the
// coordinates on their own. Nothing about capturing or saving a record depends on a map.

export const MAPS_KEY = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY ?? '';
// `region`/`language` bias place names and addresses to India (the same bias the server geocoder uses).
const REGION = import.meta.env?.VITE_GOOGLE_MAPS_REGION ?? 'IN';
const LANGUAGE = import.meta.env?.VITE_GOOGLE_MAPS_LANGUAGE ?? 'en-IN';
const LOAD_TIMEOUT_MS = 12_000;

export const mapsConfigured = () => !!MAPS_KEY;

let loading = null;
// Set when Google reports the key itself was refused (bad key, referrer not allowed, billing off). The
// script stays loaded but every map would render as an error tile, so callers show coordinates instead.
let authFailed = false;

export const mapsAuthFailed = () => authFailed;

/**
 * Resolves with the `google.maps` namespace, or null when it cannot be had. Loads the script once per
 * page; concurrent and later callers share the same promise. Never throws.
 */
export function loadGoogleMaps() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  if (window.google?.maps) return Promise.resolve(authFailed ? null : window.google.maps);
  if (loading) return loading;
  if (!MAPS_KEY) return Promise.resolve(null);
  if (navigator?.onLine === false) return Promise.resolve(null);

  loading = new Promise((resolve) => {
    const callback = '__swachhMapsReady';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callback];
      // A failed load is not cached: the next map opened with a network again gets a fresh attempt.
      if (!value) loading = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), LOAD_TIMEOUT_MS);

    // Google calls this when the key is rejected; without it a refused key shows Google's own error tile.
    window.gm_authFailure = () => { authFailed = true; };
    window[callback] = () => finish(authFailed ? null : window.google?.maps ?? null);

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({
      key: MAPS_KEY, callback, loading: 'async', region: REGION, language: LANGUAGE,
    })}`;
    script.async = true;
    script.onerror = () => { script.remove(); finish(null); };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * The address of a fix from the Maps JS geocoder, or null. Used only as a fallback for the server lookup
 * (src/services/geocode.js), so a division whose server has no geocoding key still gets an address on the
 * photo stamp from the browser key.
 */
export async function reverseGeocodeInBrowser({ latitude, longitude } = {}) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  const maps = await loadGoogleMaps();
  if (!maps?.Geocoder) return null;
  try {
    const { results } = await new maps.Geocoder().geocode({ location: { lat: latitude, lng: longitude } });
    const first = (results ?? [])[0];
    return typeof first?.formatted_address === 'string' && first.formatted_address.trim()
      ? first.formatted_address.trim() : null;
  } catch {
    // ZERO_RESULTS, OVER_QUERY_LIMIT, a refused key, offline: no address, no error for the user.
    return null;
  }
}

export const _resetGoogleMaps = () => { loading = null; authFailed = false; }; // tests only
