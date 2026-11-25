// A journey's attendance stages (backend services/trains.attendance_plan): Source, the train's configured
// attendance stations in route order, End. A train with no station-wise configuration -- and every journey
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
  if (s.station_code) return s.kind === 'source' ? 'Source' : s.kind === 'end' ? 'End' : (s.station_name || s.station_code);
  return LEGACY_SHORT[s.kind] ?? s.label;
}

// A train's selectable attendance stations: its route between the first and last station.
export function selectableStations(route) {
  const r = (parse(route) ?? []).filter((s) => s?.code);
  return r.slice(1, -1);
}

// Codes in route order, each once, only those on the route.
export function inRouteOrder(route, codes) {
  const order = new Map(selectableStations(route).map((s, i) => [s.code, i]));
  return [...new Set(codes)].filter((c) => order.has(c)).sort((a, b) => order.get(a) - order.get(b));
}

// Station-wise attendance validation for the Train Master form; null = valid.
export function attendanceConfigError({ enabled, count, codes, route }) {
  if (!enabled) return null;
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) return 'Required attendance stations must be a positive whole number.';
  const available = selectableStations(route).length;
  if (!available) return "Load the train's route to choose stations.";
  if (n > available) return `The route has only ${available} stations between its source and end.`;
  if (new Set(codes).size !== codes.length) return 'A station can be selected only once.';
  if (inRouteOrder(route, codes).length !== codes.length) return "Selected stations must be on this train's route.";
  if (codes.length !== n) return `Select exactly ${n} stations (${codes.length} selected).`;
  return null;
}
