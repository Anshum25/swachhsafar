// Face descriptor maths (pure; unit-tested). Descriptors are 128 numbers from the face recognition model; the
// distance between two descriptors of the same person is usually below 0.5, of different people above 0.6.
export const FACE_MODEL = 'faceapi-resnet128-v1';
export const SAMPLES = 4;
// Enrolment: all registered photos must look like one person (pairwise distance at most this).
export const ENROL_CONSISTENCY = 0.6;

export function distance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Closest registered descriptor to the attendance photo's descriptor.
export function bestDistance(descriptor, registered) {
  return Math.min(Infinity, ...(registered ?? []).map((r) => distance(descriptor, r)));
}

// The attendance decision for one photo: `matched` only within the division's threshold and the same model.
export function matchFace({ descriptor, profile, threshold }) {
  if (!profile) return { matched: false, reason: 'not_enrolled', distance: null };
  const d = bestDistance(descriptor, profile.descriptors);
  if (!Number.isFinite(d)) return { matched: false, reason: 'not_enrolled', distance: null };
  return { matched: d <= threshold, reason: d <= threshold ? 'matched' : 'mismatch', distance: Math.round(d * 1000) / 1000 };
}

// Largest distance between any two registered photos: they must all be the same person.
export function enrolmentSpread(descriptors) {
  let max = 0;
  for (let i = 0; i < descriptors.length; i += 1) for (let j = i + 1; j < descriptors.length; j += 1) max = Math.max(max, distance(descriptors[i], descriptors[j]));
  return max;
}

// How similar, for people: 100% at distance 0, 0% at 1.0.
export const similarityPercent = (d) => (d == null ? null : Math.max(0, Math.min(100, Math.round((1 - d) * 100))));

// ---- identifying several faces at once (group photo) --------------------------------------------------
// A group photo asks a different question from an attendance selfie. The selfie asks "is this the person
// we named?" -- one comparison, and a wrong answer needs the photo and the named person to collide. The
// group photo asks "which of these people is this?", and the answer is the smallest of N distances, so
// the chance of some wrong candidate falling under the threshold grows with the size of the crew. Two
// rules hold that down, and both matter:
//
//   1. A margin. The closest candidate must beat the runner-up by this much. When two registered people
//      are both near a face -- brothers, cousins, or simply a 50-pixel face in the back row carrying too
//      little detail to tell anyone apart -- there is no identification here, only a guess, and it is
//      returned as `ambiguous` for a human to settle rather than silently resolved.
//   2. One face, one person. Assignment is global and greedy from the best pair outwards, so a single
//      registered person can never be matched to two faces in the same photo, nor one face to two people.
//
// There is no confirmation step after this, so these two rules are the whole of the protection: a row
// returned as `ambiguous` or `unknown` is never marked present, only reported. That is the trade the
// margin buys -- a face the model cannot place with confidence is left to be marked the slow way, rather
// than attached to whichever registered person happened to be nearest.
export const GROUP_MARGIN = 0.08;

// faces: [{ descriptor, box }]; profiles: [{ user_id, model, descriptors }].
// Returns one row per detected face: { index, box, userId, distance, runnerUp, status }
// status: 'identified' | 'ambiguous' | 'unknown'.
export function identifyFaces({ faces, profiles, threshold, margin = GROUP_MARGIN, model = FACE_MODEL }) {
  const usable = (profiles ?? []).filter((p) => p.model === model && p.descriptors?.length);
  // Every face against every candidate, so the margin can be read off the same row it guards.
  const scored = (faces ?? []).map((f, index) => {
    const ranked = usable
      .map((p) => ({ userId: p.user_id, distance: bestDistance(f.descriptor, p.descriptors) }))
      .filter((c) => Number.isFinite(c.distance))
      .sort((a, b) => a.distance - b.distance);
    return { index, box: f.box ?? null, ranked };
  });

  const takenUser = new Set();
  const settled = new Map();
  // Best pair first: a confident match claims its person before a weaker one can take them.
  const pairs = scored
    .flatMap((s) => s.ranked.map((c) => ({ face: s.index, ...c })))
    .filter((c) => c.distance <= threshold)
    .sort((a, b) => a.distance - b.distance);
  for (const pair of pairs) {
    if (settled.has(pair.face) || takenUser.has(pair.userId)) continue;
    settled.set(pair.face, pair);
    takenUser.add(pair.userId);
  }

  return scored.map((s) => {
    const best = settled.get(s.index) ?? null;
    // The runner-up is judged among candidates still free, because a person already identified elsewhere
    // in the photo is not a plausible second reading of this face.
    const runnerUp = s.ranked.find((c) => c.userId !== best?.userId && !takenUser.has(c.userId)) ?? null;
    const round = (d) => (d == null ? null : Math.round(d * 1000) / 1000);
    if (!best) {
      return { index: s.index, box: s.box, userId: null, distance: round(s.ranked[0]?.distance ?? null),
        runnerUp: null, runnerUpId: null, status: 'unknown' };
    }
    const clear = runnerUp == null || runnerUp.distance - best.distance >= margin;
    // runnerUpId lets the screen ask the supervisor "which of these two is it?" for an ambiguous face.
    return { index: s.index, box: s.box, userId: best.userId, distance: round(best.distance),
      runnerUp: round(runnerUp?.distance ?? null), runnerUpId: runnerUp?.userId ?? null,
      status: clear ? 'identified' : 'ambiguous' };
  });
}

// ---- several readings of one face ---------------------------------------------------------------------
// The group camera reads every face in a short burst of frames. One frame can catch a blink, a half-turn or
// motion blur, and its descriptor lands far from the registered ones; the element-wise mean of the readings
// of one face cancels much of that noise, while staying in the same space the registered descriptors live
// in. Readings that are missing (the face could not be read in that frame) are skipped.
export function meanDescriptor(readings) {
  const usable = (readings ?? []).filter((d) => d && d.length);
  if (!usable.length) return null;
  const n = usable[0].length;
  const out = new Array(n).fill(0);
  for (const d of usable) {
    if (d.length !== n) continue;
    for (let i = 0; i < n; i += 1) out[i] += d[i];
  }
  return out.map((v) => v / usable.length);
}
