// A train's coach list as people type it, and back: "B1 AC, S1, S2" <-> [{code:'B1', classification:'AC'}, ...].
// Coaches default to Non-AC. Used by Master data -> Trains and by the office setup wizard.
export function parseCoaches(text) {
  return String(text ?? '').split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => {
    const [code, cls] = s.split(/\s+/);
    return { code, classification: cls === 'AC' ? 'AC' : 'NON_AC' };
  });
}

export const coachText = (coaches) => coaches.map((c) => `${c.code}${c.classification === 'AC' ? ' AC' : ''}`).join(', ');

// Coach classes by code prefix, as Indian Railways marks them. Longest prefix first (HA before H, GEN before G...).
const CLASSES = [
  ['HA', 'First AC + AC 2-Tier'], ['H', 'First AC (1A)'], ['A', 'AC 2-Tier (2A)'], ['B', 'AC 3-Tier (3A)'],
  ['M', 'AC 3-Tier Economy (3E)'], ['EV', 'Vistadome AC'], ['EA', 'Anubhuti (EA)'], ['E', 'Executive Chair Car (EC)'],
  ['C', 'AC Chair Car (CC)'], ['K', 'AC Chair Car'],
  ['GEN', 'General Unreserved (GS)'], ['GN', 'General Unreserved (GS)'], ['GS', 'General Unreserved (GS)'],
  ['UR', 'General Unreserved (GS)'], ['SS', 'Second Sitting (2S)'], ['S', 'Sleeper Class (SL)'],
  ['D', 'Second Sitting (2S)'], ['J', 'Second Sitting (2S)'], ['F', 'First Class (FC)'],
];
const GENERAL = new Set(['GEN', 'GN', 'GS', 'UR']);

function classOf(code) {
  const m = /^([A-Z]+)(\d*)$/.exec(code);
  const letters = m ? m[1] : code;
  const hit = CLASSES.find(([p]) => letters === p);
  return { prefix: letters, num: m && m[2] ? Number(m[2]) : null, label: hit ? hit[1] : `${letters} coaches` };
}

// "S1, S2, S3, S4" -> "S1–S4"; general coaches (GEN, GEN2, GEN3 ...) are one "GEN" with a count.
function codesLabel(prefix, codes) {
  if (GENERAL.has(prefix)) return prefix;
  const nums = codes.map((c) => classOf(c).num);
  const run = nums.every((n) => n != null) && nums.length >= 3
    && [...nums].sort((a, b) => a - b).every((n, i, s) => i === 0 || n === s[i - 1] + 1);
  if (run) return `${prefix}${Math.min(...nums)}–${prefix}${Math.max(...nums)}`;
  return [...codes].sort((a, b) => (classOf(a).num ?? 0) - (classOf(b).num ?? 0)).join(', ');
}

// A train's coaches split into AC and Non-AC, each grouped by class:
// { ac: { total, groups: [{ codes: 'M1–M3', label: 'AC 3-Tier Economy (3E)', count: 3 }, ...] }, nonAc: {...} }.
// Groups keep the order the class first appears in the rake.
export function coachBreakdown(coaches) {
  const side = () => ({ total: 0, groups: [] });
  const out = { ac: side(), nonAc: side() };
  const index = new Map();
  for (const c of coaches ?? []) {
    const ac = c.classification === 'AC';
    const { prefix, label } = classOf(String(c.code).toUpperCase());
    const key = `${ac}|${GENERAL.has(prefix) ? 'GEN' : prefix}`;
    const s = ac ? out.ac : out.nonAc;
    if (!index.has(key)) {
      const g = { prefix: GENERAL.has(prefix) ? 'GEN' : prefix, label, codes: [] };
      index.set(key, g);
      s.groups.push(g);
    }
    index.get(key).codes.push(String(c.code).toUpperCase());
    s.total += 1;
  }
  for (const s of [out.ac, out.nonAc]) {
    s.groups = s.groups.map((g) => ({ codes: codesLabel(g.prefix, g.codes), label: g.label, count: g.codes.length }));
  }
  return out;
}
