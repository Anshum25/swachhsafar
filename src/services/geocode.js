// The street address of a GPS fix, for the stamp on a captured photo.
//
// Convenience, never evidence: the record stores coordinates, and the address is what a reviewer reads
// instead of two numbers. Offline — which is most of the time in this app — there is no address, and
// nothing about saving a record changes.
//
// The lookup goes through our own server (GET /geo/reverse) first, so the geocoding key stays there and
// staff coordinates are not handed to a third party by every phone in the field. When the server has no
// geocoding provider configured (or its provider is down), the browser's own Maps JS key is the fallback,
// so the photo still carries a place name instead of two numbers.
import { reverseGeocodeInBrowser } from './googleMaps.js';

// Fixes within ~11 m share an answer, matching the server's own rounding: a shift photographed on one
// platform asks once. Kept for the life of the page.
const PRECISION = 4;
const cache = new Map();
const key = (lat, lon) => `${lat.toFixed(PRECISION)},${lon.toFixed(PRECISION)}`;

// Resolves to an address string, or null when there is none to be had (offline, provider off or down,
// nothing at those coordinates). Never throws and never blocks the caller for long.
export async function reverseGeocode(api, { latitude, longitude } = {}, { signal } = {}) {
  if (api == null || typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  const k = key(latitude, longitude);
  if (cache.has(k)) return cache.get(k);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  let source = 'unavailable';
  let address = null;
  try {
    const res = await api.get('/geo/reverse', { lat: latitude.toFixed(PRECISION), lon: longitude.toFixed(PRECISION) });
    source = res?.source ?? 'unavailable';
    address = typeof res?.address === 'string' && res.address.trim() ? res.address.trim() : null;
  } catch {
    if (signal?.aborted) return null;
  }
  // The server answered with a place: done. 'disabled' (no key there) and 'unavailable' (provider down,
  // or the call itself failed) fall through to the browser key; 'lookup'/'cache' with no address means
  // there is genuinely nothing at those coordinates, so asking again would only waste a call.
  if (!address && (source === 'disabled' || source === 'unavailable')) {
    address = await reverseGeocodeInBrowser({ latitude, longitude });
    if (address) {
      cache.set(k, address);
      return address;
    }
  }
  // A "no address here" answer is worth remembering; an outage is not, so it can be retried later.
  if (source !== 'unavailable') cache.set(k, address);
  return address;
}

export const _clearGeocodeCache = () => cache.clear(); // tests only
