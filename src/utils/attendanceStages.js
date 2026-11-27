// A journey's attendance stages (backend services/trains.attendance_plan): the train's configured attendance
// stations in route order, or a configured number of numbered stages. A train with no station-wise configuration -- and every journey
// synced before it existed -- has the original five stages, so old records keep reading as they did.

export const LEGACY_STAGES = Object.freeze([
  { stage: 1, kind: 'source', label: 'Source', station_code: null, station_name: null },
  { stage: 2, kind: 'enroute', label: 'Enroute 1', station_code: null, station_name: null },
  { stage: 3, kind: 'destination', label: 'Destination', station_code: null, station_name: null },
  { stage: 4, kind: 'enroute', label: 'Enroute 2', station_code: null, station_name: null },
  { stage: 5, kind: 'end', label: 'End', station_code: null, station_name: null },
]);

// Short captions under the legacy stage icons (the original reference design).
const LEGACY_SHORT = { source: 'Source', enroute: 'Enroute', destination: 'DEST', end: 'END' };

function parse(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) {
    try {
      const v = JSON.parse(value);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

// The stages of a journey (JourneyOut or a local row whose attendance_stages is JSON text).
export function stagesOf(journey) {
  const stages = parse(journey?.attendance_stages);
  return stages?.length ? stages : LEGACY_STAGES;
}

export function stageInfo(stages, stage) {
  return stages.find((s) => s.stage === stage) ?? { stage, kind: null, label: `Stage ${stage}`, station_code: null, station_name: null };
}

// What a record or cell is called: the label it was saved with, else the journey's stage name.
export const stageLabel = (stages, stage, saved) => saved || stageInfo(stages, stage).label;

// The caption under a stage icon: a station's name, or the legacy short caption.
export function stageCaption(s) {
  if (s.kind === 'stage') return String(s.stage);
  if (s.station_code) return s.kind === 'source' ? 'Source' : s.kind === 'end' ? 'End' : (s.station_name || s.station_code);
  return LEGACY_SHORT[s.kind] ?? s.label;
}

// A train's selectable attendance stations: every station of its route, first and last included.
export function selectableStations(route) {
  return (parse(route) ?? []).filter((s) => s?.code);
}

// Codes in route order, each once, only those on the route.
export function inRouteOrder(route, codes) {
  const order = new Map(selectableStations(route).map((s, i) => [s.code, i]));
  return [...new Set(codes)].filter((c) => order.has(c)).sort((a, b) => order.get(a) - order.get(b));
}

// How far along the route each attendance stays open (backend services/trains.valid_until_choices): from its
// own station through the next attendance station; the last one, to the end of the route. The next
// attendance station is included so an attendance stays open over the whole leg between the two.
export function validUntilChoices(route, codes, code) {
  const stations = selectableStations(route);
  const start = stations.findIndex((s) => s.code === code);
  if (start < 0) return [];
  const index = (c) => stations.findIndex((s) => s.code === c);
  const later = codes.map(index).filter((i) => i > start);
  return stations.slice(start, later.length ? Math.min(...later) + 1 : stations.length);
}

// Each selected station's window end: the office's choice while it still fits, else the default (the last choice).
export function resolveValidUntil(route, codes, chosen = {}) {
  const out = {};
  for (const code of codes) {
    const choices = validUntilChoices(route, codes, code);
    if (!choices.length) continue;
    out[code] = choices.some((s) => s.code === chosen?.[code]) ? chosen[code] : choices[choices.length - 1].code;
  }
  return out;
}

// The most attendances a train can ask for (backend MAX_ATTENDANCE_STATIONS).
export const MAX_ATTENDANCE = 50;

// Train Master attendance validation; null = valid. An empty count means the standard five stages.
export function attendanceConfigError({ enabled, count, codes, route }) {
  if (count === '' || count == null) return enabled ? 'Enter the number of attendances first.' : null;
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) return 'The number of attendances must be a positive whole number.';
  if (n > MAX_ATTENDANCE) return `At most ${MAX_ATTENDANCE} attendances.`;
  if (!enabled) return null;
  const available = selectableStations(route).length;
  if (!available) return "Load the train's route to choose stations.";
  if (n > available) return `The route has only ${available} stations.`;
  if (new Set(codes).size !== codes.length) return 'A station can be selected only once.';
  if (inRouteOrder(route, codes).length !== codes.length) return "Selected stations must be on this train's route.";
  if (codes.length !== n) return `Select exactly ${n} stations (${codes.length} selected).`;
  return null;
}

// When a stage stops being markable, as epoch ms, or null when it has none. The stage carries a clock and
// a day offset rather than a moment (backend services/trains._closing_times), so it reads against the day
// this journey's train leaves. Dates are India time, as everywhere else in the app.
export function stageClosesAt(journeyDate, stage) {
  const clock = stage?.closes_time;
  const day = stage?.closes_day;
  if (!clock || !day || !journeyDate) return null;
  const [y, m, d] = String(journeyDate).slice(0, 10).split('-').map(Number);
  const [hh, mm] = clock.split(':').map(Number);
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
  // IST is UTC+5:30 the year round, so the moment is built directly rather than through a local-time Date,
  // whose answer would depend on the phone's own time zone.
  return Date.UTC(y, m - 1, d + (day - 1), hh - 5, mm - 30);
}

// Has the train left the last station this stage stays open at, with the division's grace on top? The grace
// keeps a late train from locking its staff out (backend services/trains.stage_missed says the same).
export function stageMissed(journeyDate, stage, policy, nowMs = Date.now()) {
  const closes = stageClosesAt(journeyDate, stage);
  if (closes === null) return false;
  const grace = Number.isFinite(policy?.attendance_missed_grace_hours) ? policy.attendance_missed_grace_hours : 6;
  return nowMs > closes + grace * 3600_000;
}
