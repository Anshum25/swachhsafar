// The attendance decision for one fingerprint scan (pure; unit-tested).
//
// Unlike faces, the comparison itself is not ours: the scanner's SDK returns a score on its own scale, and
// this only decides what that score means for attendance. The matcher is recorded with every result so a
// score is never read on the wrong scale -- a division that changes scanner vendor must re-enrol, and
// until it does, its old templates are reported as not enrolled rather than quietly compared.

export const DEFAULT_MATCH_SCORE = 40;
export const MIN_FINGERS = 2; // a cut or a bandage must not lock someone out of a shift

// { matched, reason, score, finger, matcher }
//   not_enrolled  nothing registered for this employee on this device
//   wrong_matcher registered by a different scanner SDK: the scores are not comparable
//   unreadable    the scanner could not compare (no result at all)
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
