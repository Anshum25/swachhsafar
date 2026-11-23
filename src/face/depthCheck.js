// Passive anti-spoofing: is the face in front of the camera three-dimensional?
//
// Any flat surface -- a printed photo, a phone or monitor showing a photo -- maps from one view to another
// by a single homography, however it is tilted, bent slightly or moved. So if the face's frame of reference
// (brow ends, eye corners, mouth corners) is used to fit that homography between the neutral view and a
// turned view, a flat face's nose lands exactly where the homography predicts. A real nose stands a few
// centimetres out of that frame, and when the head turns it moves well off the prediction: that offset,
// in inter-eye distances, is the depth score.
//
// Pure maths over landmark coordinates (unit-tested with synthetic 3-D and flat faces). What it does NOT
// catch: a video of a real person played on a screen (the recorded face was 3-D when it was filmed), a 3-D
// mask, or frames injected by a modified app. Those are left to the randomized challenge and the server.

// Indices into faceEngine.DEPTH_LANDMARKS: [17, 26, 36, 39, 42, 45, 48, 54, 27, 29, 30, 33].
const ANCHORS = [0, 1, 2, 3, 4, 5, 6, 7];   // brows, eye corners, mouth corners
const PROBES = [9, 10, 11];                  // nose: lower bridge, tip, base
const EYE_L = 2;                             // outer eye corners, for the scale
const EYE_R = 5;

// Live faces measured well above this; flat images at a fraction of it. Calibrate on real devices.
export const DEPTH_MIN = 0.08;
// ...and it must also clearly exceed what the landmarks wobble by between two neutral frames.
export const DEPTH_NOISE_FACTOR = 3;

// Solves the n x n system M x = y (Gaussian elimination with partial pivoting). null when singular.
function solve(M, y) {
  const n = y.length;
  const a = M.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k += 1) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

// Centres the points and scales them to unit mean distance, for a well-conditioned fit.
function normaliser(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const d = points.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / points.length || 1;
  return (p) => [(p[0] - cx) / d, (p[1] - cy) / d];
}

// Least-squares homography from `src` to `dst` (arrays of [x, y]), h33 = 1. Returns a mapping function.
export function fitHomography(src, dst) {
  const ns = normaliser(src);
  const nd = normaliser(dst);
  const S = src.map(ns);
  const D = dst.map(nd);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, b) => {
    for (let i = 0; i < 8; i += 1) {
      Atb[i] += row[i] * b;
      for (let j = 0; j < 8; j += 1) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < S.length; i += 1) {
    const [x, y] = S[i];
    const [u, v] = D[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  // Map in normalised space, then back to dst pixels.
  const cx = dst.reduce((s, p) => s + p[0], 0) / dst.length;
  const cy = dst.reduce((s, p) => s + p[1], 0) / dst.length;
  const scale = dst.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / dst.length || 1;
  return (p) => {
    const [x, y] = ns(p);
    const w = h[6] * x + h[7] * y + 1;
    return [((h[0] * x + h[1] * y + h[2]) / w) * scale + cx, ((h[3] * x + h[4] * y + h[5]) / w) * scale + cy];
  };
}

// How far the nose moved off the plane of the rest of the face between two views, in inter-eye distances.
export function planarityResidual(neutral, turned) {
  if (!neutral || !turned || neutral.length !== turned.length) return 0;
  const H = fitHomography(ANCHORS.map((i) => neutral[i]), ANCHORS.map((i) => turned[i]));
  if (!H) return 0;
  const span = Math.hypot(turned[EYE_R][0] - turned[EYE_L][0], turned[EYE_R][1] - turned[EYE_L][1]) || 1;
  return Math.max(...PROBES.map((i) => {
    const [px, py] = H(neutral[i]);
    return Math.hypot(px - turned[i][0], py - turned[i][1]) / span;
  }));
}

// Mean of several frames' landmarks: the neutral reference, steadier than any one frame.
export function meanPoints(frames) {
  if (!frames?.length) return null;
  return frames[0].map((_, i) => [
    frames.reduce((s, f) => s + f[i][0], 0) / frames.length,
    frames.reduce((s, f) => s + f[i][1], 0) / frames.length,
  ]);
}

// The verdict over a whole challenge. `neutralFrames`: landmarks while facing the camera; `movedFrames`:
// landmarks at the extremes of the head movements. score = the largest residual seen while moved; noise =
// the largest residual between the neutral frames themselves.
export function depthVerdict(neutralFrames, movedFrames, { min = DEPTH_MIN, noiseFactor = DEPTH_NOISE_FACTOR } = {}) {
  const ref = meanPoints(neutralFrames);
  if (!ref || !movedFrames?.length) return { live: false, score: 0, noise: 0, reason: 'no_movement' };
  const score = Math.max(...movedFrames.map((f) => planarityResidual(ref, f)));
  const noise = neutralFrames.length > 1 ? Math.max(...neutralFrames.map((f) => planarityResidual(ref, f))) : 0;
  const live = score >= min && score >= noise * noiseFactor;
  return { live, score: Math.round(score * 1000) / 1000, noise: Math.round(noise * 1000) / 1000, reason: live ? null : 'flat' };
}
