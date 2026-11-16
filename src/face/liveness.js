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
  blinkClose: 0.68,       // EAR below this fraction of the open-eye baseline counts as closed
  blinkOpen: 0.88,        // and back above this fraction as re-opened
  blinkMaxMs: 1500,
  turnYaw: 0.22,          // nose offset (inter-eye distances) that counts as turned
  frontYaw: 0.09,         // and back within this as facing the camera
};

export const PROMPTS = {
  position: 'Fit your face inside the oval',
  closer: 'Move a little closer',
  one_face: 'Only one person should be in view',
  blink: 'Blink slowly',
  turn: 'Turn your head to one side, then back to the camera',
  hold: 'Hold still, facing the camera',
};

export function createLiveness({ now = () => Date.now(), random = Math.random, options = {} } = {}) {
  const o = { ...LIVENESS_DEFAULTS, ...options };
  const order = random() < 0.5 ? ['blink', 'turn'] : ['turn', 'blink'];
  const started = now();
  let step = 0;
  let baseline = null;
  let closedAt = null;
  let turned = false;
  let multi = 0;
  let frames = 0;

  // Returns { status: 'running'|'passed'|'failed', prompt, reason?, challenge }.
  function feed(m) {
    frames += 1;
    const t = now();
    if (t - started > o.timeoutMs) return { status: 'failed', reason: 'timeout', prompt: null };
    if (m.count > 1) {
      multi += 1;
      if (multi >= 3) return { status: 'failed', reason: 'multiple_faces', prompt: PROMPTS.one_face };
      return { status: 'running', prompt: PROMPTS.one_face, challenge: order[step] };
    }
    if (m.count === 0) return { status: 'running', prompt: PROMPTS.position, challenge: order[step] };
    if (m.size < o.minFaceSize) return { status: 'running', prompt: PROMPTS.closer, challenge: order[step] };
    if (Math.abs(m.yaw) < o.frontYaw) baseline = baseline == null ? m.ear : Math.max(baseline * 0.98, m.ear * 0.3 + baseline * 0.7);
    if (step >= order.length) {
      return Math.abs(m.yaw) < o.frontYaw && baseline && m.ear > baseline * o.blinkOpen
        ? { status: 'passed', prompt: PROMPTS.hold, frames }
        : { status: 'running', prompt: PROMPTS.hold, challenge: null };
    }
    const challenge = order[step];
    if (challenge === 'blink' && baseline) {
      if (closedAt == null && m.ear < baseline * o.blinkClose) closedAt = t;
      else if (closedAt != null && m.ear > baseline * o.blinkOpen) {
        if (t - closedAt <= o.blinkMaxMs) step += 1;
        closedAt = null;
      }
    }
    if (challenge === 'turn') {
      if (!turned && Math.abs(m.yaw) > o.turnYaw) turned = true;
      else if (turned && Math.abs(m.yaw) < o.frontYaw) { step += 1; turned = false; }
    }
    return { status: 'running', prompt: step < order.length ? PROMPTS[order[step]] : PROMPTS.hold, challenge: order[step] ?? null, done: step };
  }

  return { feed, order, total: order.length };
}
