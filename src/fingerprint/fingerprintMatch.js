// The attendance decision for one fingerprint scan (pure; unit-tested).
//
// Unlike faces, the comparison itself is not ours: the scanner's SDK returns a score on its own scale, and
// this only decides what that score means for attendance. The matcher is recorded with every result so a
// score is never read on the wrong scale -- a division that changes scanner vendor must re-enrol, and
// until it does, its old templates are reported as not enrolled rather than quietly compared.

// Must match PolicySettings.fingerprint_match_score's default: the fallback for a device that has not
// yet synced its division's policy. The score is the percentage of the smaller print that matched, never
// produced from fewer than twelve matched minutiae; see the schema for why it is not lower.
export const DEFAULT_MATCH_SCORE = 40;
export const MIN_FINGERS = 2; // a cut or a bandage must not lock someone out of a shift
// How many presses of each finger are taken at registration. One press records only the part of the
// fingertip that happened to touch the sensor, at the angle it happened to be held, and verifying later
// against that single impression fails whenever the finger lands differently -- which is most of the
// time. Phones ask for the same finger over and over for exactly this reason.
export const SAMPLES_PER_FINGER = 4;

// { matched, reason, score, finger, matcher }
//   not_enrolled  nothing registered for this employee on this device
//   wrong_matcher registered by a different scanner SDK: the scores are not comparable
//   unreadable    the scanner could not compare (no result at all)
//   unreadable_template  it compared, but one of the templates held no minutiae it could read: the
//                 registration or the scan is in a form this matcher does not understand, which is not
//                 the same as the wrong person and is not fixed by lowering the score
//   mismatch      compared, but below the division's score
export function decideFingerprint({ result, profile, threshold = DEFAULT_MATCH_SCORE } = {}) {
  const none = { matched: false, score: null, finger: null, matcher: profile?.matcher ?? null };
  if (!profile?.fingers?.length) return { ...none, reason: 'not_enrolled' };
  if (!result) return { ...none, reason: 'unreadable' };
  if (result.matcher && profile.matcher && result.matcher !== profile.matcher) {
    return { ...none, reason: 'wrong_matcher' };
  }
  const score = typeof result.score === 'number' ? result.score : null;
  if (score == null) return { ...none, reason: 'unreadable' };
  // A template that yielded no minutiae cannot produce a score that means anything, and reporting it as
  // a mismatch sends everyone off to adjust a threshold that was never the problem.
  if (result.probeMinutiae === 0 || result.candidateMinutiae === 0) {
    return { ...none, reason: 'unreadable_template' };
  }
  const matched = score >= threshold;
  return { matched, reason: matched ? 'matched' : 'mismatch', score, finger: result.finger ?? null,
    matcher: result.matcher ?? profile.matcher ?? null };
}

// What the attendance record carries about the check, or {} when it was not verified this way. Only ever
// sent for a real match: a failed scan is a reason not to submit, never a field on a saved record.
export function fingerprintFields(decision) {
  if (!decision?.matched) return {};
  return {
    fingerprint_score: Math.round(decision.score),
    fingerprint_matcher: decision.matcher ?? null,
    fingerprint_finger: decision.finger ?? null,
  };
}
