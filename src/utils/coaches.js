// Coach classes (backend CoachClass). General (unreserved) coaches are a class of their own: feedback asks
// them their own questions.
export const COACH_CLASSES = [{ value: 'AC', label: 'AC' }, { value: 'NON_AC', label: 'Non-AC' }, { value: 'GEN', label: 'General' }];
export const classLabel = (cls) => (cls === 'AC' ? 'AC' : cls === 'GEN' ? 'General' : 'Non-AC');

// A coach's class from its code, as Indian Railways marks coaches (the same rules as backend app/coach_codes.py,
// Railway Board Commercial Circular 07 of 2021):
//   AC      H, HA, HB, A, AB, B, M, G (Garib Rath 3A), C, E, J (Garib Rath CC), K / EA (Anubhuti), EV
//   Non-AC  S, D, SS, F, FC, DV, VS
//   General GEN, GS, GN, UR, UNR, and SLR, SLRD, SR, SRD, LRD, PWD, LDS (general seating, Divyangjan, ladies)
// null for a code that says nothing (BHJ ...) or a coach that is not inspected (ENG, PC, EOG, vans ...): the
// person says which class it is.
const OTHER_CODE = /^(ENG|LOCO|PC|EOG|PWR|LPR|LUG|LV|PV|VP|VPU|HCP|TM|LR)\d*$/;
const GENERAL_CODE = /^(GEN|GS|GN|UR|UNR|SLR|SLRD|SR|SRD|LRD|PWD|LDS)\d*$/;
const AC_CODE = /^(H|HA|HB|A|AB|B|M|G|C|E|J|K|EA|EV)\d*$/;
const NON_AC_CODE = /^(S|D|SS|F|FC|DV|VS)\d*$/;
export function inferClass(code) {
  const c = String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!c || OTHER_CODE.test(c)) return null;
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
  ['H', 'First AC (1A)'], ['HA', 'First AC + AC 2-Tier'], ['HB', 'First AC + AC 3-Tier'], ['A', 'AC 2-Tier (2A)'],
  ['AB', 'AC 2-Tier + AC 3-Tier'], ['B', 'AC 3-Tier (3A)'], ['M', 'AC 3-Tier Economy (3E)'],
  ['G', 'Garib Rath AC 3-Tier'], ['C', 'AC Chair Car (CC)'], ['E', 'Executive Chair Car (EC)'],
  ['J', 'Garib Rath Chair Car'], ['K', 'Anubhuti (EA)'], ['EA', 'Anubhuti (EA)'], ['EV', 'AC Vistadome (EV)'],
  ['S', 'Sleeper Class (SL)'], ['D', 'Second Sitting (2S)'], ['SS', 'Second Sitting (2S)'], ['F', 'First Class (FC)'],
  ['FC', 'First Class (FC)'], ['DV', 'Non-AC Vistadome'], ['VS', 'Non-AC Vistadome'],
  ['GEN', 'General Unreserved (GS)'], ['GN', 'General Unreserved (GS)'], ['GS', 'General Unreserved (GS)'],
  ['UR', 'General Unreserved (GS)'], ['UNR', 'General Unreserved (GS)'],
  ['SLR', 'Seating, Luggage & Guard (SLR)'], ['SLRD', 'SLR with Divyangjan (SLRD)'],
  ['SR', 'General + Train Manager (SR)'], ['SRD', 'General + Train Manager + Divyangjan (SRD)'],
  ['LRD', 'Luggage + Train Manager + Divyangjan (LRD)'], ['PWD', 'Divyangjan compartment'], ['LDS', 'Ladies compartment'],
];
const GENERAL = new Set(['GEN', 'GN', 'GS', 'UR', 'UNR']);

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
