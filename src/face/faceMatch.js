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
