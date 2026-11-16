// The street address of a GPS fix, for the stamp on a captured photo.
//
// Convenience, never evidence: the record stores coordinates, and the address is what a reviewer reads
// instead of two numbers. Offline — which is most of the time in this app — there is no address, and
// nothing about saving a record changes.
//
// The lookup goes through our own server (GET /geo/reverse), so the geocoding key stays there and staff
// coordinates are not handed to a third party by every phone in the field.

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
  try {
    const res = await api.get('/geo/reverse', { lat: latitude.toFixed(PRECISION), lon: longitude.toFixed(PRECISION) });
    const address = typeof res?.address === 'string' && res.address.trim() ? res.address.trim() : null;
    // A "no address here" answer is worth remembering; an outage is not, so it can be retried later.
    if (res?.source !== 'unavailable') cache.set(k, address);
    return address;
  } catch {
    if (signal?.aborted) return null;
    return null;
  }
}

export const _clearGeocodeCache = () => cache.clear(); // tests only
