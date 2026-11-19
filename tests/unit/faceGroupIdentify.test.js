// Identifying several faces in one group photo (src/face/faceMatch.js identifyFaces). The risk a group
// photo carries that a selfie does not is that the answer is the smallest of N distances, so these tests
// are mostly about what the function REFUSES to decide.
import { describe, expect, it } from 'vitest';
import { GROUP_MARGIN, identifyFaces } from '../../src/face/faceMatch.js';

const vec = (x, n = 128) => Array.from({ length: n }, () => x);
const at = (d) => { const v = vec(0); v[0] = d; return v; }; // a descriptor exactly `d` from the origin
const profile = (id, d) => ({ user_id: id, model: 'm', descriptors: [at(d)] });
const face = (d, box = null) => ({ descriptor: at(d), box });
const run = (faces, profiles, extra = {}) => identifyFaces({ faces, profiles, threshold: 0.5, model: 'm', ...extra });

describe('group photo identification', () => {
  it('identifies each face as the clearly closest registered person', () => {
    const rows = run([face(0.0), face(1.0)], [profile('a', 0.02), profile('b', 1.0)]);
    expect(rows.map((r) => [r.userId, r.status])).toEqual([['a', 'identified'], ['b', 'identified']]);
    expect(rows[0].distance).toBeCloseTo(0.02, 6);
  });

  it('leaves a face unknown when nobody registered is within the threshold', () => {
    const [row] = run([face(0)], [profile('a', 0.9)]);
    expect(row).toMatchObject({ userId: null, status: 'unknown' });
    expect(row.distance).toBeCloseTo(0.9, 6); // still reported, so the UI can say how far off it was
  });

  it('refuses to choose between two near-equal candidates', () => {
    // Both 0.30 and 0.34 are inside the threshold: a 0.04 gap is not an identification.
    const [row] = run([face(0)], [profile('a', 0.30), profile('b', 0.34)]);
    expect(row.status).toBe('ambiguous');
    expect(row.userId).toBe('a');       // the best guess is still reported...
    expect(row.runnerUp).toBeCloseTo(0.34, 6); // ...next to what makes it only a guess
  });

  it('accepts the same pair once the margin is cleared', () => {
    const [row] = run([face(0)], [profile('a', 0.10), profile('b', 0.10 + GROUP_MARGIN + 0.01)]);
    expect(row.status).toBe('identified');
  });

  it('never marks one registered person as two faces in the same photo', () => {
    // Two different faces whose closest candidate is the same person: only the better one may claim them.
    const rows = run([face(0.10), face(0.12)], [profile('a', 0)]);
    expect(rows.filter((r) => r.userId === 'a')).toHaveLength(1);
    expect(rows.find((r) => r.userId === 'a').distance).toBeCloseTo(0.10, 6); // the closer face wins
    expect(rows.find((r) => r.userId !== 'a').status).toBe('unknown');
  });

  it('assigns best-pair-first rather than in face order', () => {
    // Face 0 is near both; face 1 is near only B. B must go to face 1, and A to face 0.
    const rows = run([face(0.05), face(0.52)], [profile('a', 0.0), profile('b', 0.55)]);
    expect(rows[0].userId).toBe('a');
    expect(rows[1].userId).toBe('b');
  });

  it('ignores profiles registered with a different descriptor model', () => {
    const rows = run([face(0)], [{ user_id: 'a', model: 'other', descriptors: [at(0)] }]);
    expect(rows[0]).toMatchObject({ userId: null, status: 'unknown', distance: null });
  });

  it('carries the face box through for the confirmation UI, and handles an empty photo', () => {
    const box = { x: 1, y: 2, width: 3, height: 4 };
    expect(run([face(0, box)], [profile('a', 0)])[0].box).toEqual(box);
    expect(run([], [profile('a', 0)])).toEqual([]);
    expect(run([face(0)], [])).toEqual([{ index: 0, box: null, userId: null, distance: null, runnerUp: null, status: 'unknown' }]);
  });
});
