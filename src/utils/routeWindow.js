// Is a GPS fix on the stretch of route an attendance is open for? Works offline: the window travels with the
// journey's stage (journeys.attendance_stages[].window = { path: [[lat, lon, km], ...], from_code, to_code }).
// The same sums as backend app/services/route_window.py; tests/fixtures/route_window_cases.json holds the
// two to the same answers.
//
// Inside = within `toleranceKm` (plus the fix's own accuracy, at most 1 km) of the path. The tolerance also
// reaches past both ends: the platform before departure, and the approach to the last station.

const EARTH_KM = 6371;
const MAX_ACCURACY_KM = 1;
const RAD = Math.PI / 180;

function km(a, b) {
  const dp = (b[0] - a[0]) * RAD, dl = (b[1] - a[1]) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Distance (km) and position t (0..1) of the nearest point of segment a-b, in a flat projection around p.
function nearestOnSegment(p, a, b) {
  const kx = EARTH_KM * RAD * Math.cos(p[0] * RAD), ky = EARTH_KM * RAD;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

// { status: inside | before | after | off_route | unknown, off_route_km, along_km }
export function checkRouteWindow(window, latitude, longitude, accuracyM, toleranceKm) {
  const path = window?.path ?? [];
  if (!path.length || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return { status: 'unknown', off_route_km: null, along_km: null };
  }
  const p = [latitude, longitude];
  const limit = toleranceKm + Math.min(Math.max(accuracyM ?? 0, 0) / 1000, MAX_ACCURACY_KM);
  if (path.length === 1) {
    const d = km(p, path[0]);
    return { status: d <= limit ? 'inside' : 'off_route', off_route_km: round(d, 2), along_km: 0 };
  }
  let best = null;
  for (let i = 0; i < path.length - 1; i++) {
    const { d, t } = nearestOnSegment(p, path[i], path[i + 1]);
    if (!best || d < best.d) best = { d, t, i };
  }
  const { d, t, i } = best;
  const along = path[i][2] + t * (path[i + 1][2] - path[i][2]);
  const status = d <= limit ? 'inside'
    : i === 0 && t === 0 ? 'before'
      : i === path.length - 2 && t === 1 ? 'after' : 'off_route';
  return { status, off_route_km: round(d, 2), along_km: round(along, 1) };
}

export const isOutside = (result) => !!result && result.status !== 'inside' && result.status !== 'unknown';

// How far a fix is from a stage's own station, in km, or null when either is unknown. The first point of
// the stage's window is that station (the window is built from it onwards), so no extra data is needed and
// this works offline like the rest of the check.
export function kmToStation(stage, fix) {
  const first = stage?.window?.path?.[0];
  if (!first || typeof fix?.latitude !== 'number' || typeof fix?.longitude !== 'number') return null;
  return round(km([fix.latitude, fix.longitude], [first[0], first[1]]), 1);
}

// What the staff member is told (backend services/attendance.outside_message says the same).
export function outsideMessage(stage, result) {
  const start = stage?.station_name || stage?.label || 'this station';
  const end = stage?.valid_until_name || stage?.label || 'this station';
  const n = `${result.off_route_km}`;
  if (result.status === 'before') return `This attendance opens at ${start}. You are about ${n} km before it.`;
  if (result.status === 'after') return `This attendance was open until ${end}. You are about ${n} km past it.`;
  return `This attendance can be taken between ${start} and ${end}. You are about ${n} km from the train's route there.`;
}

// The division's setting, read the way the server reads it (PolicySettings defaults: block, 3 km).
export function routeCheckPolicy(policy) {
  const mode = ['off', 'flag', 'block'].includes(policy?.attendance_route_check) ? policy.attendance_route_check : 'block';
  const tolerance = Number.isFinite(policy?.attendance_route_tolerance_km) ? policy.attendance_route_tolerance_km : 3;
  return { mode, toleranceKm: tolerance };
}

// The check for one stage of a journey and one fix, or null when the division does not check or the stage
// has no station (legacy and numbered stages).
export function stageRouteCheck(stage, fix, policy) {
  const { mode, toleranceKm } = routeCheckPolicy(policy);
  if (mode === 'off' || !stage?.station_code || !fix) return null;
  return { mode, ...checkRouteWindow(stage.window, fix.latitude, fix.longitude, fix.gps_accuracy_m ?? fix.accuracy ?? null, toleranceKm) };
}
