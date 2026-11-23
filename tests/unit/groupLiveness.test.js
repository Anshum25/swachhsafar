// Group photo liveness against synthetic faces: real heads turning versus a printed photo (or a phone screen)
// held up to the camera and tilted about. Each face is tracked and judged on its own.
import { describe, expect, it } from 'vitest';
import { createGroupLiveness, liveTrackFor } from '../../src/face/groupLiveness.js';

// DEPTH_LANDMARKS in 3-D, in outer-eye-corner spans (as in depthCheck.test.js).
const FACE = [
  [-0.55, -0.35, 0.08], [0.55, -0.35, 0.08],
  [-0.5, -0.2, 0], [-0.17, -0.2, 0.03], [0.17, -0.2, 0.03], [0.5, -0.2, 0],
  [-0.27, 0.48, 0.06], [0.27, 0.48, 0.06],
  [0, -0.2, 0.12], [0, 0.08, 0.26], [0, 0.2, 0.36], [0, 0.28, 0.22],
];
const FLAT = FACE.map(([x, y]) => [x, y, 0]);
const deg = (d) => (d * Math.PI) / 180;
const rot = ([x, y, z], yaw = 0, pitch = 0) => {
  const [a, b, c] = [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)];
  return [a, b * Math.cos(pitch) - c * Math.sin(pitch), b * Math.sin(pitch) + c * Math.cos(pitch)];
};
// A face `dist` spans from the camera, shifted `tx` spans sideways (so several fit in one frame).
const project = (pts, tx, dist = 8) => pts.map(([x, y, z]) => [640 + (800 * (x + tx)) / (dist - z), 360 + (800 * y) / (dist - z)]);

// One face measurement as faceEngine.analyseFaces gives it.
function measure(model, tx, yaw = 0, pitch = 0) {
  const points = project(model.map((p) => rot(p, yaw, pitch)), tx);
  const xs = points.map((p) => p.x ?? p[0]);
  const ys = points.map((p) => p[1]);
  const box = { x: Math.min(...xs) - 10, y: Math.min(...ys) - 20, width: Math.max(...xs) - Math.min(...xs) + 20, height: Math.max(...ys) - Math.min(...ys) + 40 };
  const [eyeL, eyeR, nose] = [points[2], points[5], points[10]];
  const span = Math.hypot(eyeR[0] - eyeL[0], eyeR[1] - eyeL[1]);
  return { box, yaw: (nose[0] - (eyeL[0] + eyeR[0]) / 2) / span, points };
}

// A head turn: neutral, out to `peak` and back.
const sweep = (peak) => [0, 0, 0, 0, peak / 2, peak, peak, peak / 2, 0, 0].map(deg);

describe('group photo liveness', () => {
  it('passes real people who turn their heads', () => {
    const g = createGroupLiveness();
    let s;
    for (const a of sweep(25)) s = g.feed([measure(FACE, -2, a), measure(FACE, 2, -a)]);
    expect(s.total).toBe(2);
    expect(s.live).toBe(2);
  });

  it('never passes a printed photo or a screen, however it is tilted', () => {
    const g = createGroupLiveness();
    let s;
    // The picture is turned and tilted as a whole -- the most a person holding it can do.
    for (const a of sweep(35)) s = g.feed([measure(FLAT, 0, a, a / 2)]);
    expect(s.total).toBe(1);
    expect(s.live).toBe(0);
  });

  it('judges each face on its own: a real person cannot vouch for a photo held beside them', () => {
    const g = createGroupLiveness();
    let s;
    for (const a of sweep(25)) s = g.feed([measure(FACE, -2, a), measure(FLAT, 2, a, a / 3)]);
    expect(s.total).toBe(2);
    expect(s.live).toBe(1);
    const [real, photo] = [...s.tracks].sort((x, y) => x.box.x - y.box.x);
    expect(real.live).toBe(true);
    expect(photo.live).toBe(false);
  });

  it('does not pass someone who never moves', () => {
    const g = createGroupLiveness();
    let s;
    for (let i = 0; i < 20; i += 1) s = g.feed([measure(FACE, 0, 0)]);
    expect(s.live).toBe(0);
  });

  it('maps a face in the full-size still back to its live track', () => {
    const g = createGroupLiveness();
    let s;
    for (const a of sweep(25)) s = g.feed([measure(FACE, -2, a), measure(FLAT, 2, a)]);
    const real = s.tracks.find((t) => t.live);
    const photo = s.tracks.find((t) => !t.live);
    const scale = (b) => ({ x: b.x * 2, y: b.y * 2, width: b.width * 2, height: b.height * 2 });
    expect(liveTrackFor(s.tracks, scale(real.box), { sx: 2, sy: 2 })?.id).toBe(real.id);
    expect(liveTrackFor(s.tracks, scale(photo.box), { sx: 2, sy: 2 })).toBeNull();
    expect(liveTrackFor(s.tracks, { x: 0, y: 0, width: 40, height: 40 })).toBeNull();
  });
});
