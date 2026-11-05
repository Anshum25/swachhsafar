// Face matching decisions (src/face/faceMatch.js): what blocks or allows an attendance.
import { describe, expect, it } from 'vitest';
import { bestDistance, distance, enrolmentSpread, matchFace, similarityPercent } from '../../src/face/faceMatch.js';

const vec = (x, n = 128) => Array.from({ length: n }, () => x);
const shift = (v, d) => v.map((x, i) => (i === 0 ? x + d : x)); // moves the descriptor exactly `d` away

describe('face matching', () => {
  const base = vec(0.05);
  const profile = { model: 'm', descriptors: [base, shift(base, 0.2), shift(base, 0.3), shift(base, 0.25)] };

  it('measures Euclidean distance and picks the closest registered photo', () => {
    expect(distance(base, shift(base, 0.4))).toBeCloseTo(0.4, 6);
    expect(distance(base, vec(0.05, 64))).toBe(Infinity); // different model / length never matches
    expect(bestDistance(shift(base, 0.45), profile.descriptors)).toBeCloseTo(0.15, 6);
  });

  it('matches within the threshold and blocks above it', () => {
    expect(matchFace({ descriptor: shift(base, 0.1), profile, threshold: 0.5 })).toMatchObject({ matched: true, reason: 'matched', distance: 0.1 });
    expect(matchFace({ descriptor: shift(base, 0.9), profile, threshold: 0.5 })).toMatchObject({ matched: false, reason: 'mismatch' });
    expect(matchFace({ descriptor: shift(base, 0.5), profile, threshold: 0.5 }).matched).toBe(true); // boundary is inclusive, like the server
  });

  it('blocks when the employee has no registered face', () => {
    expect(matchFace({ descriptor: base, profile: null, threshold: 0.5 })).toEqual({ matched: false, reason: 'not_enrolled', distance: null });
    expect(matchFace({ descriptor: base, profile: { descriptors: [] }, threshold: 0.5 }).reason).toBe('not_enrolled');
  });

  it('checks that registration photos are one person', () => {
    expect(enrolmentSpread(profile.descriptors)).toBeCloseTo(0.3, 6);
    expect(enrolmentSpread([base, shift(base, 0.9)])).toBeCloseTo(0.9, 6);
  });

  it('shows similarity as a percentage', () => {
    expect(similarityPercent(0.25)).toBe(75);
    expect(similarityPercent(1.4)).toBe(0);
    expect(similarityPercent(null)).toBeNull();
  });
});
