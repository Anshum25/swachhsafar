// A train's coach list as people type it, and back: "B1 AC, S1, S2" <-> [{code:'B1', classification:'AC'}, ...].
// Coaches default to Non-AC. Used by Master data -> Trains and by the office setup wizard.
export function parseCoaches(text) {
  return String(text ?? '').split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => {
    const [code, cls] = s.split(/\s+/);
    return { code, classification: cls === 'AC' ? 'AC' : 'NON_AC' };
  });
}

export const coachText = (coaches) => coaches.map((c) => `${c.code}${c.classification === 'AC' ? ' AC' : ''}`).join(', ');
