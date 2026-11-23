// Pure helpers for the Super Admin dashboard (SuperAdminDashboard.jsx): the period presets and the chart
// scales. Kept apart from the JSX so tests/unit/overviewMath.test.js runs them without rendering.

// The day as YYYY-MM-DD in India, which is how the server buckets records (app/sqlcompat.ist_date_text).
export function istToday(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const PERIODS = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
  { value: 'custom', label: 'Custom' },
];

// { date_from, date_to } for a preset, today included. A custom range is passed through, put in order and
// capped to a year, which is what the server accepts.
export function periodRange(period, custom = {}, today = istToday()) {
  const preset = PERIODS.find((p) => p.value === period && p.days);
  if (preset) return { date_from: addDays(today, 1 - preset.days), date_to: today };
  let from = custom.from || addDays(today, -29);
  let to = custom.to || today;
  if (from > to) [from, to] = [to, from];
  if (addDays(from, 366) < to) from = addDays(to, -366);
  return { date_from: from, date_to: to };
}

// A round axis maximum at or above `max`, and the ticks under it (0 included): 1, 2 or 5 times a power of
// ten per step, about `count` steps.
export function niceScale(max, count = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, ticks };
}

// Which dates to print under a daily axis so labels never collide: at most `slots` of them, evenly spaced,
// always the first and the last.
export function tickDates(dates, slots = 6) {
  if (dates.length <= slots) return dates;
  const step = (dates.length - 1) / (slots - 1);
  return [...new Set(Array.from({ length: slots }, (_, i) => dates[Math.round(i * step)]))];
}

export const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
