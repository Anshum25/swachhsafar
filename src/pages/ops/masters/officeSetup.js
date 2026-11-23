// Pure helpers for the office setup wizard (OfficeSetup.jsx), tested in tests/unit/officeSetup.test.js.
import { parseCoaches } from '../../../utils/coaches.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

// "Daily", "Mon, Thu", or "Days not published" (then journeys are planned every day).
export function runDaysLabel(runDays) {
  if (!runDays || !runDays.length) return 'Days not published';
  const set = new Set(runDays);
  if (DAYS.every((d) => set.has(d))) return 'Daily';
  return DAYS.filter((d) => set.has(d)).map((d) => DAY_LABEL[d]).join(', ');
}

// The picks as the wizard holds them -> PUT /clients/{id}/setup. `picks`: { [stationCode]: { [trainNo]:
// { checked, coaches } } }. A station with no train ticked is left out (it would plan nothing); coaches are
// optional and typed as "B1 AC, S1".
export function setupBody(stations, picks) {
  return {
    stations: stations
      .map((code) => ({
        code,
        trains: Object.entries(picks[code] ?? {})
          .filter(([, t]) => t.checked)
          .map(([trainNo, t]) => ({ train_no: trainNo, coaches: parseCoaches(t.coaches) })),
      }))
      .filter((s) => s.trains.length),
  };
}

// Station codes ticked but with no train ticked: the wizard warns before saving, since they plan nothing.
export function stationsWithoutTrains(stations, picks) {
  return stations.filter((code) => !Object.values(picks[code] ?? {}).some((t) => t.checked));
}

// Initial picks from the saved setup: the trains already planned, ticked.
export function initialPicks(setup) {
  const picks = {};
  for (const s of setup?.stations ?? []) {
    if (s.train_nos?.length) picks[s.code] = Object.fromEntries(s.train_nos.map((n) => [n, { checked: true, coaches: '' }]));
  }
  return picks;
}

// Stations matching a search, by name, code or locality.
export function filterStations(stations, term) {
  const t = term.trim().toLowerCase();
  if (!t) return stations;
  return stations.filter((s) => `${s.name} ${s.code} ${s.city}`.toLowerCase().includes(t));
}
