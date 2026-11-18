// Liveness challenge as a pure state machine over per-frame measurements (see faceEngine.analyseFrame), so it
// can be tested without a camera. Two challenges in random order: a blink and a head turn (either side and
// back). Fails on more than one face, and at the end when the start and end faces differ (checked by the
// component with descriptors).
//
// What this does and does not prove: it defeats a still printed photo or a still image on a screen. It does
// NOT reliably defeat a replayed video of the person, a 3-D mask, or a determined attacker; it is not a
// certified presentation-attack detector (ISO/IEC 30107-3). See docs/SECURITY.md.

export const LIVENESS_DEFAULTS = {
  timeoutMs: 25_000,
  minFaceSize: 0.22,      // face width / frame width
  blinkDip: 0.16,         // how far the eye measure must fall below its open level to count as closed (responsive on phones)
  jitterDips: 2.0,        // ...or this many times the measurement's own noise, whichever is larger
  blinkRecover: 0.60,     // and must climb back this much of that fall to count as re-opened
  blinkMaxMs: 3000,       // a slow blink, which is what people are asked for, at ten frames a second
  turnYaw: 0.25,          // how far the head must move from neutral to count as turned
  frontYaw: 0.18,         // and back within this of neutral as facing the camera again
  neutralFrames: 3,       // frames averaged to learn where this person's neutral actually is
  baselineFrames: 2,      // open-eye measurements needed before a blink can be judged against them
};

export const PROMPTS = {
  position: 'Fit your face inside the oval',
  closer: 'Move a little closer',
  one_face: 'Only one person should be in view',
  blink: 'Blink slowly',
  turn: 'Turn your head to one side, then back to the camera',
  hold: 'Hold still, facing the camera',
};

// `challenges` picks what has to be seen. The default asks for both, in a random order. ['blink'] is the
// passive path: nothing is demanded of the person beyond the blink they were going to make anyway.
export function createLiveness({ now = () => Date.now(), random = Math.random, options = {}, challenges } = {}) {
  const o = { ...LIVENESS_DEFAULTS, ...options };
  const order = challenges ?? (random() < 0.5 ? ['blink', 'turn'] : ['turn', 'blink']);
  const started = now();
  let step = 0;
  let baseline = null;       // the open-eye EAR this person actually has
  let baselineSeen = 0;
  let neutral = null;        // where "facing the camera" is for this person, on this phone
  let neutralSum = 0;
  let neutralSeen = 0;
  let closedAt = null;
  let lastEar = null;
  let jitter = null;      // how much the measurement moves by itself, frame to frame
  let turned = false;
  let multi = 0;
  let frames = 0;

  // How far this frame is from the person's own neutral. Measuring the nose against the midpoint of the
  // eyes in absolute terms does not work: plenty of noses do not sit there, and nobody's does when the
  // phone is held a little to one side, which is how a phone is held. Judged absolutely, those people
  // were never once counted as facing the camera -- so the open-eye baseline was never learned, the
  // blink could never be measured against it, and the prompt sat on "Blink slowly" for ever.
  const offset = (m) => Math.abs(m.yaw - (neutral ?? 0));
  const frontal = (m) => (neutral == null ? Math.abs(m.yaw) < o.turnYaw : offset(m) < o.frontYaw);

  // Returns { status: 'running'|'passed'|'failed', prompt, reason?, challenge }.
  function feed(m) {
    frames += 1;
    const t = now();
    // Which challenge ran out of time, so the person is told what was not seen rather than that
    // something unnamed did not happen.
    if (t - started > o.timeoutMs) {
      return { status: 'failed', reason: 'timeout', pending: order[step] ?? null, prompt: null };
    }
    if (m.count > 1) {
      multi += 1;
      if (multi >= 3) return { status: 'failed', reason: 'multiple_faces', prompt: PROMPTS.one_face };
      return { status: 'running', prompt: PROMPTS.one_face, challenge: order[step] };
    }
    if (m.count === 0) return { status: 'running', prompt: PROMPTS.position, challenge: order[step] };
    if (m.size < o.minFaceSize) return { status: 'running', prompt: PROMPTS.closer, challenge: order[step] };
    if (!Number.isFinite(m.ear) || !Number.isFinite(m.yaw)) {
      return { status: 'running', prompt: PROMPTS.position, challenge: order[step] };
    }

    // Neutral is learned from the first few frames, while the person is simply looking at the phone.
    if (neutral == null && Math.abs(m.yaw) < o.turnYaw) {
      neutralSum += m.yaw;
      neutralSeen += 1;
      if (neutralSeen >= o.neutralFrames) neutral = neutralSum / neutralSeen;
    }

    // The open-eye baseline is the recent high-water mark, and is never updated during a blink: letting
    // it follow the eye down moves the "closed" line down with it, so the blink measures against itself
    // and never registers. It decays slowly so that moving nearer or further still re-levels it.
    if (frontal(m) && closedAt == null) {
      baseline = baseline == null ? m.ear : Math.max(m.ear, baseline * 0.99);
      baselineSeen += 1;
      // What the measurement does on its own, frame to frame, with the eye held open. It is the yardstick
      // for whether a fall is the eye closing or the detector wobbling.
      if (lastEar != null) {
        const moved = Math.abs(m.ear - lastEar);
        jitter = jitter == null ? moved : jitter * 0.8 + moved * 0.2;
      }
    }
    lastEar = m.ear;

    // How far the eye ratio has to fall for the fall to be a blink. The landmark model draws a closed
    // eye from a small crop of the frame and does not draw it fully shut, so the fall is around a fifth,
    // not the two thirds a face measured properly would give: a fixed deep threshold is one a person can
    // never satisfy, however hard they blink. What separates a blink from the detector's own wobble is
    // not depth but that the fall is far larger than the wobble -- so it is measured against both.
    const dip = baseline == null ? null : Math.max(baseline * o.blinkDip, (jitter ?? 0) * o.jitterDips);

    if (step >= order.length) {
      return frontal(m) && baseline && m.ear > baseline - (dip ?? 0) * o.blinkRecover
        ? { status: 'passed', prompt: PROMPTS.hold, frames }
        : { status: 'running', prompt: PROMPTS.hold, challenge: null };
    }
    const challenge = order[step];
    if (challenge === 'blink' && baseline && baselineSeen >= o.baselineFrames) {
      if (closedAt == null && m.ear <= baseline - dip) closedAt = t;
      else if (closedAt != null && m.ear >= baseline - dip * o.blinkRecover) {
        if (t - closedAt <= o.blinkMaxMs) {
          step += 1;
          if (step >= order.length) return { status: 'passed', prompt: PROMPTS.hold, frames };
        }
        closedAt = null;
      }
    }
    if (challenge === 'turn') {
      if (!turned && offset(m) > o.turnYaw) turned = true;
      else if (turned && frontal(m)) {
        step += 1;
        turned = false;
        if (step >= order.length) return { status: 'passed', prompt: PROMPTS.hold, frames };
      }
    }
    return { status: 'running', prompt: step < order.length ? PROMPTS[order[step]] : PROMPTS.hold, challenge: order[step] ?? null, done: step };
  }

  return { feed, order, total: order.length };
}
