// The randomized active challenge (liveness.createActiveChallenge) fed the measurements a camera produces,
// for a live person and for the spoofs it must refuse. Mocked frames, not real-device tests: these prove the
// decision logic; docs/SECURITY_TEST_REPORT.md records what has (and has not) been tried on real phones.
import { describe, expect, it } from 'vitest';
import { ACTIONS, createActiveChallenge } from '../../src/face/liveness.js';

const FRAME_MS = 95;
const frame = (over = {}) => ({ count: 1, size: 0.32, ear: 0.3, yaw: 0.03, pitch: 0.5, ...over });

function machine(actions, options) {
  let t = 1_000_000;
  const c = createActiveChallenge({ actions, now: () => t, options });
  const feed = (frames) => {
    let last;
    for (const f of frames) {
      t += FRAME_MS;
      last = c.feed(f);
      if (last.status !== 'running') break;
    }
    return last;
  };
  return { c, feed };
}

const hold = (n = 6, over = {}) => Array.from({ length: n }, () => frame(over));
// The movements a live person makes for each action: out, held briefly, and back to the camera.
const MOVES = {
  turn_left: [...hold(3, { yaw: 0.3 }), ...hold(3, { yaw: 0.4 }), ...hold(3)],
  turn_right: [...hold(3, { yaw: -0.25 }), ...hold(3, { yaw: -0.35 }), ...hold(3)],
  look_up: [...hold(3, { pitch: 0.36 }), ...hold(3)],
  look_down: [...hold(3, { pitch: 0.64 }), ...hold(3)],
  closer: [...hold(2, { size: 0.36 }), ...hold(3, { size: 0.42 })],
  blink: [...hold(4), frame({ ear: 0.12 }), frame({ ear: 0.1 }), ...hold(4)],
};
const perform = (actions) => [...hold(8), ...actions.flatMap((a) => MOVES[a]), ...hold(4)];

describe('randomized active challenge', () => {
  it('a live person who follows the instructions passes, with each step timed in order', () => {
    for (const actions of [['turn_left', 'blink', 'look_up'], ['blink', 'turn_right', 'closer'], ['look_down', 'turn_left', 'blink']]) {
      const { feed } = machine(actions);
      const r = feed(perform(actions));
      expect(r.status, actions.join(',')).toBe('passed');
      expect(r.steps.map((s) => s.action)).toEqual(actions);
      expect(r.steps.map((s) => s.at)).toEqual([...r.steps.map((s) => s.at)].sort((a, b) => a - b));
      expect(r.startedAt).toBeLessThanOrEqual(r.steps[0].at);
      expect(r.completedAt).toBeGreaterThanOrEqual(r.steps.at(-1).at);
    }
  });

  it('a still photo (printed, or on another screen) never passes: nothing moves, nothing blinks', () => {
    const { feed } = machine(['turn_left', 'blink', 'look_up'], { timeoutMs: 8000 });
    const r = feed(hold(200));
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('timeout');
    expect(r.pending).toBe('turn_left');
  });

  it('a photo moved or tilted about does not count as a head turn', () => {
    // Moving or tilting a flat picture changes its size and position, not where the nose sits between the eyes.
    const { feed } = machine(['turn_left', 'blink', 'look_up'], { timeoutMs: 8000 });
    const wobble = Array.from({ length: 200 }, (_, i) => frame({ size: 0.3 + 0.05 * Math.sin(i / 5), yaw: 0.03 + 0.02 * Math.sin(i / 3) }));
    const r = feed([...hold(8), ...wobble]);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('timeout');
  });

  it('a prerecorded clip moving the other way is refused (one honest mistake is allowed, not two)', () => {
    const { feed } = machine(['turn_left', 'blink', 'look_up']);
    const r = feed([...hold(8), ...MOVES.turn_right, ...MOVES.turn_right]);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('wrong_action');

    const honest = machine(['turn_left', 'blink', 'look_up']);
    expect(honest.feed([...hold(8), ...MOVES.turn_right, ...MOVES.turn_left, ...MOVES.blink, ...MOVES.look_up, ...hold(3)]).status).toBe('passed');
  });

  it('a recording made for a different sequence does not satisfy this one', () => {
    const recorded = perform(['blink', 'look_down', 'turn_right']);
    const { feed } = machine(['turn_left', 'look_up', 'blink'], { timeoutMs: 15_000 });
    const r = feed([...recorded, ...hold(200)]);
    expect(r.status).toBe('failed');
  });

  it('the employee not performing the requested action is refused', () => {
    const { feed } = machine(['blink', 'turn_left', 'look_up'], { timeoutMs: 6000 });
    // Holds still, never blinks.
    const r = feed(hold(200));
    expect(r).toMatchObject({ status: 'failed', reason: 'timeout', pending: 'blink' });
  });

  it('more than one face in the frame fails the attempt', () => {
    const { feed } = machine(['turn_left', 'blink', 'look_up']);
    const r = feed([...hold(8), frame({ count: 2 }), frame({ count: 2 }), frame({ count: 2 })]);
    expect(r).toMatchObject({ status: 'failed', reason: 'multiple_faces' });
  });

  it('a head turn has to come back to the camera before it counts', () => {
    const { feed } = machine(['turn_left', 'blink', 'look_up']);
    const r = feed([...hold(8), ...hold(10, { yaw: 0.4 })]);
    expect(r.status).toBe('running');
    expect(r.step).toBe(0);
    expect(r.extreme).toBe(true); // the frames the depth check samples
  });

  it('only the actions the server can issue are accepted', () => {
    expect(() => createActiveChallenge({ actions: [] })).toThrow();
    expect(() => createActiveChallenge({ actions: ['smile'] })).toThrow();
    expect(ACTIONS).toEqual(['blink', 'turn_left', 'turn_right', 'look_up', 'look_down', 'closer']);
  });

  it('nothing is judged until a face has been seen holding still', () => {
    const { feed } = machine(['turn_left', 'blink', 'look_up']);
    expect(feed([frame({ count: 0 })])).toMatchObject({ status: 'running' });
    expect(feed(hold(2))).toMatchObject({ calibrating: true });
  });
});
