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

// ---- donut ---------------------------------------------------------------------------------------------

// At most `max` parts, largest kept and the rest folded into one "Other" (a ninth colour is never invented).
// Parts at zero are dropped: they draw nothing and would only crowd the legend.
export function foldParts(parts, max = 6) {
  const live = parts.filter((p) => p.value > 0);
  if (live.length <= max) return live;
  const sorted = [...live].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((n, p) => n + p.value, 0);
  return [...kept, { key: 'other', label: 'Other', value: rest }];
}

// Start and end angles (radians, clockwise from 12 o'clock) of each part's slice.
export function donutAngles(values) {
  const total = values.reduce((n, v) => n + v, 0);
  if (!(total > 0)) return values.map(() => null);
  let a = 0;
  return values.map((v) => {
    const start = a;
    a += (v / total) * Math.PI * 2;
    return { start, end: a, share: v / total };
  });
}

// SVG path of a ring slice between radii r0 < r1. A single part filling the ring is drawn as two halves,
// since an arc cannot start and end at the same point.
export function ringPath(cx, cy, r0, r1, start, end) {
  if (end - start >= Math.PI * 2 - 1e-6) {
    return `${ringPath(cx, cy, r0, r1, 0, Math.PI)} ${ringPath(cx, cy, r0, r1, Math.PI, Math.PI * 2)}`;
  }
  const pt = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)].map((n) => Math.round(n * 100) / 100);
  const large = end - start > Math.PI ? 1 : 0;
  const [x0, y0] = pt(r1, start), [x1, y1] = pt(r1, end), [x2, y2] = pt(r0, end), [x3, y3] = pt(r0, start);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

export const pct = (share) => (share >= 0.995 ? '100%' : share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

// 1,284 / 12.9K / 4.2M: the stat-tile number.
export function compact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 10_000) return v.toLocaleString('en-IN');
  if (Math.abs(v) < 1_000_000) return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
