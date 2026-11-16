// Location guard: permission, location services, a fresh and accurate fix, and plausibility of consecutive
// fixes. One instance per app (startLocationGuard). State changes are published to subscribers.
//
// Platform limits (documented in docs/SECURITY.md): a browser cannot tell "GPS switched off" from "no fix",
// cannot see mock-location apps, and the Permissions API is missing on some browsers (Safari < 16). The
// Android app asks the native plugin for location-services state and the mock-location flag.
import { nativeSecurity } from './native.js';

export const DEFAULT_POLICY = {
  gps_enforced: true, gps_block_app: true, gps_max_age_seconds: 120, gps_max_accuracy_m: 100, gps_timeout_seconds: 20,
  gps_max_speed_kmh: 250, vpn_policy: 'block', offline_session_hours: 24, face_liveness_required: false,
};

const km = (a, b) => {
  const r = 6371, rad = Math.PI / 180;
  const dp = (b.latitude - a.latitude) * rad, dl = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

export function createLocationGuard({ onEvent = () => {}, now = () => Date.now(), geo = globalThis.navigator?.geolocation } = {}) {
  let policy = DEFAULT_POLICY;
  let state = { permission: 'unknown', services: 'unknown', fix: null, error: null, checking: false, suspicious: null, checkedAt: null };
  const subs = new Set();
  let watchId = null;
  let permStatus = null;
  const set = (patch) => { state = { ...state, ...patch }; subs.forEach((f) => f(state)); };

  function accept(fix) {
    const prev = state.fix;
    let suspicious = state.suspicious;
    if (prev && fix.timestamp > prev.timestamp) {
      const hours = (fix.timestamp - prev.timestamp) / 3_600_000;
      const dist = km(prev, fix);
      if (dist > 2 && dist / hours > policy.gps_max_speed_kmh) {
        suspicious = { reason: 'jump', km: Math.round(dist), kmh: Math.round(dist / hours), at: now() };
        onEvent('location.suspicious_jump', 'warning', { km: suspicious.km, kmh: suspicious.kmh });
      }
    }
    if (fix.mocked) onEvent('location.mock_detected', 'critical', { source: fix.source });
    set({ fix, error: null, permission: 'granted', services: 'on', suspicious, checkedAt: now() });
  }

  const fromBrowser = (p) => ({
    latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null,
    timestamp: p.timestamp || now(), source: 'browser', mocked: null,
  });

  function fail(err) {
    // GeolocationPositionError: 1 denied, 2 unavailable (often location services off), 3 timeout.
    const code = err?.code === 1 ? 'denied' : err?.code === 2 ? 'unavailable' : err?.code === 3 ? 'timeout' : err?.code ?? 'unavailable';
    set({ error: code, checking: false, checkedAt: now(), ...(code === 'denied' ? { permission: 'denied' } : {}), ...(code === 'services_off' ? { services: 'off' } : {}) });
    onEvent(`location.${code}`, code === 'denied' || code === 'services_off' ? 'warning' : 'info', {});
  }

  async function nativeFix() {
    const native = nativeSecurity();
    const status = await native.getLocationStatus();
    set({ permission: status.permission, services: status.servicesEnabled ? 'on' : 'off' });
    if (!status.servicesEnabled) throw { code: 'services_off' };
    if (status.permission !== 'granted') {
      const req = await native.requestLocationPermission();
      set({ permission: req.permission });
      if (req.permission !== 'granted') throw { code: 1 };
    }
    const p = await native.getCurrentLocation({ timeoutMs: policy.gps_timeout_seconds * 1000, maxAgeMs: 10_000 });
    return { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy ?? null, timestamp: p.time ?? now(),
      source: p.provider === 'gps' ? 'gps' : p.provider === 'fused' ? 'fused' : 'network', mocked: !!p.mocked };
  }

  function browserFix(maximumAge = 15_000) {
    return new Promise((resolve, reject) => {
      if (!geo) { reject({ code: 'unsupported' }); return; }
      geo.getCurrentPosition((p) => resolve(fromBrowser(p)), reject,
        { enableHighAccuracy: true, timeout: policy.gps_timeout_seconds * 1000, maximumAge });
    });
  }

  async function watchPermission() {
    if (permStatus || !navigator.permissions?.query) return;
    try {
      permStatus = await navigator.permissions.query({ name: 'geolocation' });
      set({ permission: permStatus.state });
      permStatus.onchange = () => {
        set({ permission: permStatus.state });
        if (permStatus.state === 'denied') { set({ fix: null, error: 'denied' }); onEvent('location.permission_revoked', 'warning', {}); }
      };
    } catch { /* Permissions API without geolocation (older Safari) */ }
  }

  function startWatch() {
    if (watchId != null || !geo || nativeSecurity()) return;
    watchId = geo.watchPosition((p) => accept(fromBrowser(p)), (e) => { if (e.code === 1) fail(e); },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 });
  }

  // A fresh fix now. Resolves with the fix or null (state.error says why).
  async function refresh() {
    set({ checking: true });
    await watchPermission();
    try {
      const fix = nativeSecurity() ? await nativeFix() : await browserFix();
      accept(fix);
      set({ checking: false });
      startWatch();
      return fix;
    } catch (e) {
      fail(e);
      return null;
    }
  }

  // Whether the current fix satisfies the policy now: { ok, code, fix }.
  function evaluate(at = now()) {
    if (!policy.gps_enforced) return { ok: true, code: 'not_enforced', fix: state.fix };
    if (state.permission === 'denied' || state.error === 'denied') return { ok: false, code: 'location_denied' };
    if (state.services === 'off' || state.error === 'services_off') return { ok: false, code: 'gps_disabled' };
    const fix = state.fix;
    if (!fix) return { ok: false, code: state.checking ? 'location_pending' : state.error === 'timeout' ? 'location_timeout' : 'location_unavailable' };
    if (fix.mocked) return { ok: false, code: 'mock_location', fix };
    if (fix.accuracy == null || fix.accuracy > policy.gps_max_accuracy_m) return { ok: false, code: 'location_inaccurate', fix };
    if ((at - fix.timestamp) / 1000 > policy.gps_max_age_seconds) return { ok: false, code: 'location_stale', fix };
    return { ok: true, code: 'ok', fix };
  }

  return {
    getState: () => state,
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    setPolicy: (p) => { policy = { ...DEFAULT_POLICY, ...p }; set({}); },
    getPolicy: () => policy,
    refresh,
    evaluate,
    openSettings: () => nativeSecurity()?.openLocationSettings(),
    stop: () => { if (watchId != null) geo?.clearWatch(watchId); watchId = null; },
  };
}

let sharedGuardInstance = null;
export function getSharedLocationGuard(opts = {}) {
  if (!sharedGuardInstance) {
    sharedGuardInstance = createLocationGuard(opts);
  }
  return sharedGuardInstance;
}
