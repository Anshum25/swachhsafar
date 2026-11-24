// Coach classes (backend CoachClass). General (unreserved) coaches are a class of their own: feedback asks
// them their own questions.
export const COACH_CLASSES = [{ value: 'AC', label: 'AC' }, { value: 'NON_AC', label: 'Non-AC' }, { value: 'GEN', label: 'General' }];
export const classLabel = (cls) => (cls === 'AC' ? 'AC' : cls === 'GEN' ? 'General' : 'Non-AC');

// A coach's class from its code, as Indian Railways marks coaches (backend app/providers/railradar.py):
// H1, HA1, A2, B5, M1, C3, E1 ... are AC; S7, D1, J1 ... are Non-AC; GEN, GEN2, GN, GS, UR1 are General.
// null for a code that says nothing (BHJ, PC ...): the person says which class it is.
const AC_CODE = /^(H|HA|A|B|M|C|E|EA|EV|K)\d*$/;
const NON_AC_CODE = /^(S|D|J|F)\d+$|^SS\d*$/;
const GENERAL_CODE = /^(GEN|GN|GS|UR)\d*$/;
export function inferClass(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (GENERAL_CODE.test(c)) return 'GEN';
  if (AC_CODE.test(c)) return 'AC';
  if (NON_AC_CODE.test(c)) return 'NON_AC';
  return null;
}

// A train's coach list as people type it, and back: "B1, S1, GEN, BHJ AC" <-> [{code:'B1', classification:'AC'}, ...].
// The class comes from the code (B1 is AC, S1 Non-AC, GEN General); a class written after the code wins
// (AC, NON-AC, GEN), and is how a code that says nothing gets one (Non-AC when none is written).
// Used by Master data -> Trains and by the office setup wizard.
export function parseCoaches(text) {
  return String(text ?? '').split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => {
    const [code, cls = ''] = s.split(/\s+/);
    const tag = cls.replace(/[^A-Z]/g, '');
    const classification = tag === 'AC' ? 'AC' : tag === 'GEN' || tag === 'GENERAL' ? 'GEN'
      : tag === 'NONAC' ? 'NON_AC' : inferClass(code) ?? 'NON_AC';
    return { code, classification };
  });
}

// Writes a class only where the code does not already say it.
const TAG = { AC: ' AC', NON_AC: ' NON-AC', GEN: ' GEN' };
const classTag = (c) => (c.classification === (inferClass(c.code) ?? 'NON_AC') ? '' : TAG[c.classification] ?? '');
export const coachText = (coaches) => coaches.map((c) => `${c.code}${classTag(c)}`).join(', ');

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

// A train's coaches split into AC, Non-AC and General, each grouped by class:
// { ac: { total, groups: [{ codes: 'M1–M3', label: 'AC 3-Tier Economy (3E)', count: 3 }, ...] }, nonAc: {...}, gen: {...} }.
// Groups keep the order the class first appears in the rake.
export function coachBreakdown(coaches) {
  const side = () => ({ total: 0, groups: [] });
  const out = { ac: side(), nonAc: side(), gen: side() };
  const index = new Map();
  for (const c of coaches ?? []) {
    const cls = c.classification === 'AC' ? 'ac' : c.classification === 'GEN' ? 'gen' : 'nonAc';
    const { prefix, label } = classOf(String(c.code).toUpperCase());
    const key = `${cls}|${GENERAL.has(prefix) ? 'GEN' : prefix}`;
    const s = out[cls];
    if (!index.has(key)) {
      const g = { prefix: GENERAL.has(prefix) ? 'GEN' : prefix, label, codes: [] };
      index.set(key, g);
      s.groups.push(g);
    }
    index.get(key).codes.push(String(c.code).toUpperCase());
    s.total += 1;
  }
  for (const s of [out.ac, out.nonAc, out.gen]) {
    s.groups = s.groups.map((g) => ({ codes: codesLabel(g.prefix, g.codes), label: g.label, count: g.codes.length }));
  }
  return out;
}
