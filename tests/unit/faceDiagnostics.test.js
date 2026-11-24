// What the face screens tell people when a face is not found or not matched (src/face/faceEngine.js
// noFaceReason, src/face/faceMatch.js threshold helpers). The percentage shown is 100 x (1 - distance), so
// the office's threshold maps to a minimum percentage; at the strictest setting (0.3) a 67% match is refused.
import { describe, expect, it } from 'vitest';
import { QUALITY, noFaceReason } from '../../src/face/faceEngine.js';
import { RECOMMENDED_THRESHOLD, isStrict, matchFace, requiredPercent, similarityPercent } from '../../src/face/faceMatch.js';

const at = (d) => { const v = Array(128).fill(0); v[0] = d; return v; };

describe('explaining a refused match', () => {
  it('maps the threshold to the percentage a face must reach', () => {
    expect(requiredPercent(0.3)).toBe(70);
    expect(requiredPercent(RECOMMENDED_THRESHOLD)).toBe(50);
  });

  it('reproduces the reported failure: 67% similar is refused only because the office is set to 0.3', () => {
    const profile = { descriptors: [at(0.33)] };
    const strict = matchFace({ descriptor: at(0), profile, threshold: 0.3 });
    expect(strict).toMatchObject({ matched: false, reason: 'mismatch' });
    expect(similarityPercent(strict.distance)).toBe(67);
    expect(matchFace({ descriptor: at(0), profile, threshold: RECOMMENDED_THRESHOLD }).matched).toBe(true);
  });

  it('flags only settings stricter than recommended', () => {
    expect(isStrict(0.3)).toBe(true);
    expect(isStrict(0.4)).toBe(true);
    expect(isStrict(0.5)).toBe(false);
    expect(isStrict(undefined)).toBe(false);
  });
});

describe('explaining a photo with no face found', () => {
  const ok = { brightness: 128, sharpness: 400 };
  it('says the photo is too dark, washed out or blurred when it clearly is', () => {
    expect(noFaceReason({ ...ok, brightness: QUALITY.dark - 1 })[0]).toBe('too_dark');
    expect(noFaceReason({ ...ok, brightness: QUALITY.bright + 1 })[0]).toBe('too_bright');
    expect(noFaceReason({ ...ok, sharpness: QUALITY.blurry - 1 })[0]).toBe('blurry');
  });

  it('otherwise tells the person how to frame the face', () => {
    const [code, message] = noFaceReason(ok);
    expect(code).toBe('no_face');
    expect(message).toMatch(/Fill most of the photo with the face/);
  });
});
