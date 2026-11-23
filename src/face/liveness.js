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

// ---- server-issued randomized challenge ---------------------------------------------------------------
// The attendance check. The server picks the actions and their order (app/services/liveness.py): always a
// head turn and a blink, plus one more, shuffled. The app does not know the sequence in advance, so a
// recording cannot have been made to fit it. Each action has to be seen happening in live frames, and a
// clear movement the wrong way (turning right when asked to turn left) counts against the attempt: a
// replayed clip of someone moving their head about does not follow instructions.
//
// Measurements per frame, as from faceEngine.analyseFrame: { count, size, yaw, pitch, ear }. All movement
// is judged against this person's own neutral pose, learned in the first frames.
export const ACTIONS = ['blink', 'turn_left', 'turn_right', 'look_up', 'look_down', 'closer'];
export const ACTION_PROMPTS = {
  blink: 'Blink your eyes',
  turn_left: 'Turn your head left',
  turn_right: 'Turn your head right',
  look_up: 'Look up',
  look_down: 'Look down',
  closer: 'Move slightly closer to the camera',
};
export const CHALLENGE_PROMPTS = {
  position: 'Position your face inside the frame',
  detecting: 'Detecting face…',
  closer: 'Move a little closer',
  one_face: 'Only one person should be in the frame',
  back: 'Now face the camera again',
  wrong: 'Other way',
  hold: 'Hold still, facing the camera',
};

export const CHALLENGE_DEFAULTS = {
  ...LIVENESS_DEFAULTS,
  timeoutMs: 45_000,
  minFaceSize: 0.2,
  neutralFrames: 5,
  turnYaw: 0.22,      // movement from neutral that counts as a head turn
  frontYaw: 0.12,      // and back within this of neutral as facing the camera again
  pitchDelta: 0.1,     // vertical movement that counts as looking up/down
  frontPitch: 0.06,
  closerGrow: 1.2,     // face width growth that counts as moving closer
  wrongYaw: 0.28,      // a clear movement the other way
  wrongPitch: 0.14,
  wrongAllowed: 1,     // one honest mistake (left/right confusion) is allowed; the second fails
};

export function createActiveChallenge({ actions, now = () => Date.now(), options = {} } = {}) {
  if (!actions?.length || actions.some((a) => !ACTIONS.includes(a))) throw new Error('Invalid liveness challenge');
  const o = { ...CHALLENGE_DEFAULTS, ...options };
  const createdAt = now();
  let startedAt = null;     // when the first action was shown
  let neutral = null;
  const calib = [];
  let step = 0;
  let moved = false;        // true: the movement was seen, waiting for the return; 'wrong': went the other way
  let wrong = 0;
  let multi = 0;
  let frames = 0;
  const steps = [];
  // Blink state, as in createLiveness.
  let baseline = null;
  let baselineSeen = 0;
  let closedAt = null;
  let lastEar = null;
  let jitter = null;

  const result = (status, extra = {}) => ({ status, step, total: actions.length, action: actions[step] ?? null, frames, ...extra });
  const complete = (t) => {
    steps.push({ action: actions[step], at: t });
    step += 1;
    moved = false;
    closedAt = null;
  };

  function feed(m) {
    frames += 1;
    const t = now();
    if (t - createdAt > o.timeoutMs) return result('failed', { reason: 'timeout', pending: actions[step] ?? null });
    if (m.count > 1) {
      multi += 1;
      if (multi >= 3) return result('failed', { reason: 'multiple_faces', prompt: CHALLENGE_PROMPTS.one_face });
      return result('running', { prompt: CHALLENGE_PROMPTS.one_face });
    }
    if (!m.count) return result('running', { prompt: CHALLENGE_PROMPTS.position, phase: neutral ? 'action' : 'detecting' });
    if (!Number.isFinite(m.yaw) || !Number.isFinite(m.pitch) || !Number.isFinite(m.size)) {
      return result('running', { prompt: CHALLENGE_PROMPTS.position });
    }
    // Moving closer is the one action where a big face is the point; everywhere else it must be big enough.
    if (m.size < o.minFaceSize && !(neutral && actions[step] === 'closer')) {
      return result('running', { prompt: CHALLENGE_PROMPTS.closer, phase: neutral ? 'action' : 'detecting' });
    }

    // Learn neutral: the first consecutive frames facing roughly towards the camera.
    if (!neutral) {
      if (Math.abs(m.yaw) < o.turnYaw) calib.push(m);
      else calib.length = 0;
      if (calib.length < o.neutralFrames) return result('running', { prompt: CHALLENGE_PROMPTS.detecting, phase: 'detecting', calibrating: true });
      const avg = (k) => calib.reduce((s, c) => s + c[k], 0) / calib.length;
      neutral = { yaw: avg('yaw'), pitch: avg('pitch'), size: avg('size') };
      startedAt = t;
    }

    const dyaw = m.yaw - neutral.yaw;
    const dpitch = m.pitch - neutral.pitch;
    const frontal = Math.abs(dyaw) < o.frontYaw && Math.abs(dpitch) < o.frontPitch;

    if (Number.isFinite(m.ear) && frontal && closedAt == null) {
      baseline = baseline == null ? m.ear : Math.max(m.ear, baseline * 0.99);
      baselineSeen += 1;
      if (lastEar != null) jitter = jitter == null ? Math.abs(m.ear - lastEar) : jitter * 0.8 + Math.abs(m.ear - lastEar) * 0.2;
    }
    if (Number.isFinite(m.ear)) lastEar = m.ear;

    if (step >= actions.length) {
      return frontal
        ? result('passed', { steps: steps.slice(), startedAt, completedAt: t, prompt: CHALLENGE_PROMPTS.hold })
        : result('running', { prompt: CHALLENGE_PROMPTS.back, phase: 'action' });
    }

    const action = actions[step];
    const prompt = ACTION_PROMPTS[action];
    // A clear movement the other way. Judged only for the directional actions.
    const against = (action === 'turn_left' && dyaw < -o.wrongYaw) || (action === 'turn_right' && dyaw > o.wrongYaw)
      || (action === 'look_up' && dpitch > o.wrongPitch) || (action === 'look_down' && dpitch < -o.wrongPitch);
    if (against && moved === false) {
      wrong += 1;
      if (wrong > o.wrongAllowed) return result('failed', { reason: 'wrong_action', pending: action });
      moved = 'wrong';   // wait for the head to come back before counting again
    }
    if (moved === 'wrong') {
      if (frontal) moved = false;
      return result('running', { prompt: `${CHALLENGE_PROMPTS.wrong}: ${prompt.toLowerCase()}`, phase: 'action' });
    }

    let extreme = false;
    if (action === 'blink') {
      const dip = baseline == null ? null : Math.max(baseline * o.blinkDip, (jitter ?? 0) * o.jitterDips);
      if (baseline != null && baselineSeen >= o.baselineFrames && Number.isFinite(m.ear)) {
        if (closedAt == null && m.ear <= baseline - dip) closedAt = t;
        else if (closedAt != null && m.ear >= baseline - dip * o.blinkRecover) {
          if (t - closedAt <= o.blinkMaxMs) complete(t);
          else closedAt = null;
        }
      }
    } else if (action === 'closer') {
      if (m.size >= neutral.size * o.closerGrow) complete(t);
    } else {
      const off = { turn_left: dyaw, turn_right: -dyaw, look_up: -dpitch, look_down: dpitch }[action];
      const need = action.startsWith('turn') ? o.turnYaw : o.pitchDelta;
      if (moved === false && off > need) moved = true;
      if (moved === true && off > need * 0.8) extreme = true;
      if (moved === true && frontal) complete(t);
    }
    if (step >= actions.length) return result('running', { prompt: CHALLENGE_PROMPTS.hold, phase: 'action', extreme });
    return result('running', {
      prompt: moved === true ? CHALLENGE_PROMPTS.back : ACTION_PROMPTS[actions[step]], phase: 'action', extreme,
    });
  }

  return { feed, actions, steps };
}
