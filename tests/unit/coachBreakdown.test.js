import { describe, expect, it } from 'vitest';
import { coachBreakdown, parseCoaches } from '../../src/utils/coaches.js';

// Train 12189's rake as RailRadar gives it (engine, vans and pantry already dropped by the backend).
const RAKE = parseCoaches('GEN, GEN2, S7, S6, S5, S4, S3, S2, S1, HA1 AC, A1 AC, B4 AC, B3 AC, B2 AC, B1 AC, '
  + 'M1 AC, M2 AC, M3 AC, GEN3, GEN4');

describe('coachBreakdown (AC / Non-AC by class)', () => {
  it('splits a rake the way the coach chart does', () => {
    const b = coachBreakdown(RAKE);
    expect(b.ac.total).toBe(9);
    expect(b.ac.groups).toEqual([
      { codes: 'HA1', label: 'First AC + AC 2-Tier', count: 1 },
      { codes: 'A1', label: 'AC 2-Tier (2A)', count: 1 },
      { codes: 'B1–B4', label: 'AC 3-Tier (3A)', count: 4 },
      { codes: 'M1–M3', label: 'AC 3-Tier Economy (3E)', count: 3 },
    ]);
    expect(b.nonAc.total).toBe(11);
    expect(b.nonAc.groups).toEqual([
      { codes: 'GEN', label: 'General Unreserved (GS)', count: 4 },
      { codes: 'S1–S7', label: 'Sleeper Class (SL)', count: 7 },
    ]);
  });
  it('lists short or broken runs coach by coach', () => {
    const b = coachBreakdown(parseCoaches('B1 AC, B3 AC, S1, S2'));
    expect(b.ac.groups[0].codes).toBe('B1, B3');
    expect(b.nonAc.groups[0].codes).toBe('S1, S2');
  });
  it('is empty for no coaches', () => {
    expect(coachBreakdown([])).toEqual({ ac: { total: 0, groups: [] }, nonAc: { total: 0, groups: [] } });
  });
});
