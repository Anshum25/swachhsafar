// The liveness challenge (src/face/liveness.js) as a state machine, fed the measurements a camera would
// produce. It was written to be testable without a camera and then never was, and it did not work on a
// phone: the prompt said "Blink slowly" and nothing a person did would satisfy it.
//
// Two things were wrong, and both are pinned here.
//
// 1. Whether the face counted as "facing the camera" was an absolute measurement -- the nose had to sit
//    within 0.09 inter-eye distances of the midpoint between the eyes. Plenty of people's noses do not,
//    and neither does anyone's when the phone is held slightly to one side, which is how a phone is
//    held. The open-eye baseline was only ever learned on frames that passed that test, so for those
//    people it was never learned at all and the blink could never be detected.
// 2. The baseline was dragged down by the blink it was supposed to measure, so by the time the eye was
//    closed the "closed" line had moved down with it.
import { describe, expect, it } from 'vitest';
import { LIVENESS_DEFAULTS, createLiveness } from '../../src/face/liveness.js';

// A phone gets roughly ten frames a second out of the detector, so a blink is a handful of frames.
const FRAME_MS = 95;

// One frame of measurements. `ear` is the eye aspect ratio: ~0.3 open, ~0.1 closed.
const frame = (over = {}) => ({ count: 1, size: 0.35, ear: 0.30, yaw: 0, ...over });

// Feeds frames through the machine, advancing a clock, and returns the last result.
function run(live, frames) {
  let last;
  for (const f of frames) {
    last = live.feed(f);
    if (last.status !== 'running') break;
  }
  return last;
}

const steady = (n, over) => Array.from({ length: n }, () => frame(over));
// A blink: eyes closing, shut, opening, at one measurement per frame.
const blink = (over) => [
  frame({ ear: 0.22, ...over }), frame({ ear: 0.11, ...over }), frame({ ear: 0.09, ...over }),
  frame({ ear: 0.20, ...over }), frame({ ear: 0.29, ...over }), frame({ ear: 0.30, ...over }),
];
// A head turn away and back. `base` is where this person's head sits when they are looking at the
// phone: they turn away from that, not away from some absolute zero.
const turn = (base = 0) => [0.15, 0.30, 0.34, 0.14, 0.01, 0].map((d) => frame({ yaw: base + d }));

// A clock that advances one frame per measurement, so timeouts and blink durations are real.
function clock() {
  let t = 0;
  return { now: () => (t += FRAME_MS) };
}

const liveness = (order) => {
  const c = clock();
  // random < 0.5 puts the blink first; anything else puts the turn first.
  return createLiveness({ now: c.now, random: () => (order === 'blink' ? 0.1 : 0.9) });
};

describe('the liveness challenge', () => {
  it('passes a person who blinks and turns, facing the camera', () => {
    const live = liveness('blink');
    const r = run(live, [...steady(5), ...blink(), ...steady(3), ...turn(), ...steady(4)]);
    expect(r.status).toBe('passed');
  });

  // The failure as reported: the prompt sat on "Blink slowly" and blinking never satisfied it.
  it("passes someone whose nose does not sit between their eyes, or who holds the phone to one side", () => {
    for (const yaw of [-0.14, 0.14, 0.15]) {
      const live = liveness('blink');
      const r = run(live, [...steady(6, { yaw }), ...blink({ yaw }), ...steady(3, { yaw }),
        ...turn(yaw), ...steady(4, { yaw })]);
      expect(r.status, `held at yaw ${yaw}`).toBe('passed');
    }
  });

  it('does not count a blink the baseline was allowed to follow', () => {
    // Eyes half-closed for a long stretch and never properly shut: not a blink.
    const live = liveness('blink');
    const r = run(live, [...steady(5), ...steady(40, { ear: 0.26 }), ...steady(5)]);
    expect(r.status).toBe('running');
    expect(r.prompt).toBe('Blink slowly');
  });

  it('still refuses a photograph: no blink, no turn, no pass', () => {
    const live = liveness('blink');
    const r = run(live, steady(300));
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('timeout');
    // And says which challenge was never seen, so the person is told what to do differently.
    expect(r.pending).toBe('blink');
  });

  it('refuses a second face in view, and asks for one first', () => {
    const live = liveness('blink');
    const r = run(live, [frame(), ...Array.from({ length: 3 }, () => ({ count: 2 }))]);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('multiple_faces');
  });

  it('asks the person to come closer rather than silently never starting', () => {
    const live = liveness('blink');
    const r = live.feed(frame({ size: LIVENESS_DEFAULTS.minFaceSize - 0.01 }));
    expect(r.status).toBe('running');
    expect(r.prompt).toBe('Move a little closer');
  });

  it('counts a slow blink, which is what people are asked for', () => {
    const live = liveness('blink');
    const slow = [frame({ ear: 0.18 }), ...steady(6, { ear: 0.09 }), frame({ ear: 0.19 }), frame({ ear: 0.30 })];
    const r = run(live, [...steady(5), ...slow, ...steady(3), ...turn(), ...steady(4)]);
    expect(r.status).toBe('passed');
  });

  // The measure fed in is how open the eyes look in the pixels, which falls by half or more on a real
  // blink. In poor light, against a dark iris, the fall is shallower -- around a third -- and that
  // still has to count, or the check works in an office and not on a platform at night.
  it('counts the shallower blink that poor light gives', () => {
    const live = liveness('blink');
    const shallow = [frame({ ear: 0.26 }), frame({ ear: 0.21 }), frame({ ear: 0.205 }),
      frame({ ear: 0.25 }), frame({ ear: 0.295 }), frame({ ear: 0.30 })];
    const r = run(live, [...steady(5), ...shallow, ...steady(3), ...turn(), ...steady(4)]);
    expect(r.status).toBe('passed');
  });

  // The other side of that: a still photograph measures a ratio that wobbles only with the detector's
  // own noise, and no amount of wobble may be mistaken for a blink.
  it('does not mistake measurement noise in a still photo for a blink', () => {
    const live = liveness('blink');
    const noisy = Array.from({ length: 320 }, (_, i) => frame({ ear: 0.30 + (i % 3 - 1) * 0.004 }));
    const r = run(live, noisy);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('timeout');
  });

  // The quick capture path: the blink alone, watched for without asking. A face held in front of the
  // camera on another phone's screen is the attack this exists to stop -- it never blinks, so it never
  // passes, however long it is held there and however well it fills the oval.
  describe('the blink on its own, as the quick capture uses it', () => {
    const blinkOnly = () => createLiveness({ now: clock().now, challenges: ['blink'] });

    it('passes on a blink, with nothing else asked of the person', () => {
      const r = run(blinkOnly(), [...steady(5), ...blink(), ...steady(3)]);
      expect(r.status).toBe('passed');
    });

    it('never passes a photograph of a face, however long it is held there', () => {
      const r = run(blinkOnly(), steady(300));
      expect(r.status).toBe('failed');
      expect(r.reason).toBe('timeout');
      expect(r.pending).toBe('blink');
    });

    it('never passes a photo on a screen that is moved about but does not blink', () => {
      // Held by hand: the face drifts and changes size, and the eye ratio wobbles with the detector.
      const waved = Array.from({ length: 300 }, (_, i) => frame({
        yaw: Math.sin(i / 7) * 0.1, size: 0.3 + Math.sin(i / 11) * 0.05, ear: 0.3 + (i % 3 - 1) * 0.005,
      }));
      expect(run(blinkOnly(), waved).status).toBe('failed');
    });
  });

  it('works with the turn asked for first', () => {
    const live = liveness('turn');
    const r = run(live, [...steady(5), ...turn(), ...steady(3), ...blink(), ...steady(4)]);
    expect(r.status).toBe('passed');
  });
});
