// The passive depth check against synthetic faces: a 3-D face turning its head versus the same face printed
// flat (paper or a screen) and tilted, moved and turned in every way a person holding it could. These prove
// the maths; the thresholds still need calibrating on real phones (docs/SECURITY_TEST_REPORT.md).
import { describe, expect, it } from 'vitest';
import { DEPTH_MIN, depthVerdict, planarityResidual } from '../../src/face/depthCheck.js';

// Approximate 3-D positions of DEPTH_LANDMARKS [17, 26, 36, 39, 42, 45, 48, 54, 27, 29, 30, 33], in units
// of the outer-eye-corner span; z towards the camera.
const FACE = [
  [-0.55, -0.35, 0.08], [0.55, -0.35, 0.08],                    // brow ends
  [-0.5, -0.2, 0], [-0.17, -0.2, 0.03], [0.17, -0.2, 0.03], [0.5, -0.2, 0], // eye corners
  [-0.27, 0.48, 0.06], [0.27, 0.48, 0.06],                       // mouth corners
  [0, -0.2, 0.12], [0, 0.08, 0.26], [0, 0.2, 0.36], [0, 0.28, 0.22], // nose
];

const rot = ([x, y, z], yaw = 0, pitch = 0, roll = 0) => {
  // yaw about y, pitch about x, roll about z
  let [a, b, c] = [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)];
  [a, b, c] = [a, b * Math.cos(pitch) - c * Math.sin(pitch), b * Math.sin(pitch) + c * Math.cos(pitch)];
  return [a * Math.cos(roll) - b * Math.sin(roll), a * Math.sin(roll) + b * Math.cos(roll), c];
};
// Pin-hole camera, face `dist` spans away, 400 px focal length, image centre (320, 240).
const project = (pts, { dist = 4, tx = 0, ty = 0 } = {}) => pts.map(([x, y, z]) => {
  const depth = dist - z;
  return [320 + (400 * (x + tx)) / depth, 240 + (400 * (y + ty)) / depth];
});
// Seeded jitter: the landmark model's own wobble, in pixels.
function jitter(pts, px, seed) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
  return pts.map(([x, y]) => [x + r() * px, y + r() * px]);
}

const live = (yaw, pitch = 0, opts = {}) => project(FACE.map((p) => rot(p, yaw, pitch)), opts);
// The face as printed: its frontal image flattened onto a plane, then that plane held at an angle.
const FLAT = FACE.map(([x, y]) => [x, y, 0]);
const flat = (yaw, pitch = 0, roll = 0, opts = {}) => project(FLAT.map((p) => rot(p, yaw, pitch, roll)), opts);

const deg = (d) => (d * Math.PI) / 180;
const neutralFrames = (make, n = 4, px = 1) => Array.from({ length: n }, (_, i) => jitter(make(), px, i + 11));

describe('depth check', () => {
  it('a real face turning its head has clear depth', () => {
    for (const yaw of [deg(20), deg(-25), deg(35)]) {
      const r = planarityResidual(live(0), live(yaw));
      expect(r, `yaw ${yaw}`).toBeGreaterThan(DEPTH_MIN * 1.5);
    }
  });

  it('a flat photo has none, however it is tilted, turned or moved', () => {
    const poses = [[deg(30), 0, 0], [deg(-35), deg(10), 0], [0, deg(30), deg(10)], [deg(20), deg(-20), deg(-15)]];
    for (const [y, p, r] of poses) {
      expect(planarityResidual(flat(0), flat(y, p, r, { tx: 0.2, dist: 3 })), `pose ${[y, p, r]}`).toBeLessThan(0.01);
    }
  });

  it('verdict: live face passes with realistic landmark noise', () => {
    const v = depthVerdict(neutralFrames(() => live(0)), [jitter(live(deg(28)), 1, 99)]);
    expect(v.live).toBe(true);
    expect(v.score).toBeGreaterThan(DEPTH_MIN);
  });

  it('verdict: photo on paper or a phone screen is rejected even with noise', () => {
    const v = depthVerdict(neutralFrames(() => flat(0)), [jitter(flat(deg(35), deg(5)), 1, 99), jitter(flat(deg(-30)), 1, 98)]);
    expect(v.live).toBe(false);
    expect(v.reason).toBe('flat');
  });

  it('verdict: no movement means no verdict of life', () => {
    expect(depthVerdict(neutralFrames(() => live(0)), []).live).toBe(false);
  });

  it('noisy landmarks alone cannot fake depth', () => {
    // A flat image under heavy wobble: the noise floor rises with it, so the score does not clear it.
    const v = depthVerdict(neutralFrames(() => flat(0), 6, 4), [jitter(flat(deg(30)), 4, 7)]);
    expect(v.live).toBe(false);
  });
});
