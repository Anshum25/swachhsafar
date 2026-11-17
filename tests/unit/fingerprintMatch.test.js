// The fingerprint attendance decision (src/fingerprint/fingerprintMatch.js) and the scanner contract
// (src/fingerprint/scanner.js).
//
// The scanner's SDK does the comparing and owns the score's scale. These tests pin down what the app does
// with that score, and that a scan which could not be compared is never treated as a match.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MATCH_SCORE, decideFingerprint, fingerprintFields } from '../../src/fingerprint/fingerprintMatch.js';
import { SCAN_GRACE_MS, ScanError, captureFinger, matchFinger, scannerStatus } from '../../src/fingerprint/scanner.js';

const PROFILE = {
  matcher: 'acpl-sdk-v1',
  format: 'iso-19794-2',
  fingers: [{ finger: 'right_index', template: 'AAEC' }, { finger: 'left_index', template: 'AQID' }],
};

describe('fingerprint decision', () => {
  it('matches at or above the division score, not below', () => {
    const at = decideFingerprint({ result: { score: 40, finger: 'right_index', matcher: 'acpl-sdk-v1' }, profile: PROFILE, threshold: 40 });
    expect(at).toMatchObject({ matched: true, reason: 'matched', score: 40, finger: 'right_index' });
    const below = decideFingerprint({ result: { score: 39, matcher: 'acpl-sdk-v1' }, profile: PROFILE, threshold: 40 });
    expect(below).toMatchObject({ matched: false, reason: 'mismatch', score: 39 });
  });

  it('refuses to compare scores from a different scanner SDK', () => {
    const d = decideFingerprint({ result: { score: 999, matcher: 'other-vendor' }, profile: PROFILE, threshold: 40 });
    expect(d).toMatchObject({ matched: false, reason: 'wrong_matcher', score: null });
  });

  it('is never a match when there is nothing registered, or nothing to read', () => {
    expect(decideFingerprint({ result: { score: 99 }, profile: null })).toMatchObject({ matched: false, reason: 'not_enrolled' });
    expect(decideFingerprint({ result: { score: 99 }, profile: { ...PROFILE, fingers: [] } })).toMatchObject({ reason: 'not_enrolled' });
    expect(decideFingerprint({ result: null, profile: PROFILE })).toMatchObject({ matched: false, reason: 'unreadable' });
    expect(decideFingerprint({ result: {}, profile: PROFILE })).toMatchObject({ matched: false, reason: 'unreadable' });
    expect(decideFingerprint({})).toMatchObject({ matched: false, reason: 'not_enrolled' });
  });

  it('puts the check on the record only when it actually matched', () => {
    const ok = decideFingerprint({ result: { score: 71.6, finger: 'left_index', matcher: 'acpl-sdk-v1' }, profile: PROFILE, threshold: DEFAULT_MATCH_SCORE });
    expect(fingerprintFields(ok)).toEqual({ fingerprint_score: 72, fingerprint_matcher: 'acpl-sdk-v1', fingerprint_finger: 'left_index' });
    expect(fingerprintFields(decideFingerprint({ result: { score: 5, matcher: 'acpl-sdk-v1' }, profile: PROFILE }))).toEqual({});
    expect(fingerprintFields(null)).toEqual({});
  });
});

// A device that has not yet synced its division's policy falls back to DEFAULT_MATCH_SCORE, so a server
// default that drifts away from it silently changes who is accepted on a phone that is behind.
describe('the default match score', () => {
  it('is the same number the server schema defaults to', () => {
    const schema = readFileSync(new URL('../../backend/app/schemas/policy.py', import.meta.url), 'utf8');
    const m = schema.match(/fingerprint_match_score: int = Field\(default=(\d+), ge=(\d+), le=(\d+)\)/);
    expect(m, 'fingerprint_match_score not found in policy.py').not.toBeNull();
    expect(Number(m[1])).toBe(DEFAULT_MATCH_SCORE);
    // And the default has to sit inside the range an administrator is allowed to set.
    expect(DEFAULT_MATCH_SCORE).toBeGreaterThanOrEqual(Number(m[2]));
    expect(DEFAULT_MATCH_SCORE).toBeLessThanOrEqual(Number(m[3]));
  });
});

describe('scanner', () => {
  const plugin = (over = {}) => ({
    status: async () => ({ connected: true, device: 'AST300', matcher: 'acpl-sdk-v1' }),
    capture: async () => ({ template: 'AAEC', format: 'iso-19794-2', quality: 72 }),
    match: async () => ({ score: 88, finger: 'right_index', matcher: 'acpl-sdk-v1' }),
    ...over,
  });

  it('reports an absent scanner as a state, not a failure', async () => {
    expect(await scannerStatus(null)).toEqual({ supported: false, connected: false, reason: 'unsupported' });
    const broken = plugin({ status: async () => { throw new Error('usb gone'); } });
    expect(await scannerStatus(broken)).toMatchObject({ supported: true, connected: false, reason: 'usb gone' });
  });

  it('captures a template and keeps the finger it was asked for', async () => {
    const out = await captureFinger({ finger: 'left_thumb' }, plugin());
    expect(out).toMatchObject({ template: 'AAEC', format: 'iso-19794-2', quality: 72, finger: 'left_thumb' });
  });

  it('turns a refusal into a message a person can act on', async () => {
    await expect(captureFinger({}, null)).rejects.toBeInstanceOf(ScanError);
    await expect(captureFinger({}, null)).rejects.toThrow(/No fingerprint scanner is connected/);
    const poor = plugin({ capture: async () => ({ code: 'poor_quality' }) });
    await expect(captureFinger({}, poor)).rejects.toThrow(/Wipe the sensor/);
    const slow = plugin({ capture: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); } });
    await expect(captureFinger({}, slow)).rejects.toThrow(/Place the finger flat/);
  });

  // The bug this pins down: the native capture goes out to the scanner vendor's own activity, and when
  // that activity never comes back the promise stayed pending for ever -- the tile span on its spinner
  // and Register stayed disabled, with no way out of the dialog but closing it.
  it('gives up on a capture the scanner never answers', async () => {
    vi.useFakeTimers();
    try {
      const silent = plugin({ capture: () => new Promise(() => {}) });
      const scan = captureFinger({ finger: 'right_index', timeoutMs: 1000 }, silent);
      const seen = scan.catch((e) => e);
      await vi.advanceTimersByTimeAsync(1000 + SCAN_GRACE_MS);
      const err = await seen;
      expect(err).toBeInstanceOf(ScanError);
      expect(err.code).toBe('timeout');
      expect(err.message).toMatch(/Place the finger flat/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the scanner to compare, and treats any failure as no result', async () => {
    expect(await matchFinger({ template: 'AAEC', profile: PROFILE }, plugin()))
      .toEqual({ score: 88, finger: 'right_index', matcher: 'acpl-sdk-v1' });
    expect(await matchFinger({ template: 'AAEC', profile: PROFILE }, plugin({ match: async () => { throw new Error('nope'); } }))).toBeNull();
    expect(await matchFinger({ template: 'AAEC', profile: PROFILE }, plugin({ match: async () => ({}) }))).toBeNull();
    expect(await matchFinger({ template: null, profile: PROFILE }, plugin())).toBeNull();
    expect(await matchFinger({ template: 'AAEC', profile: null }, plugin())).toBeNull();
    expect(await matchFinger({ template: 'AAEC', profile: PROFILE }, null)).toBeNull();
  });

  it('hands the stored templates to the matcher, never the other way round', async () => {
    const seen = [];
    const spy = plugin({ match: async (args) => { seen.push(args); return { score: 50 }; } });
    await matchFinger({ template: 'FRESH', profile: PROFILE }, spy);
    expect(seen[0]).toEqual({ template: 'FRESH', candidates: PROFILE.fingers, format: 'iso-19794-2' });
  });

  it('a browser has no scanner', async () => {
    vi.stubGlobal('Capacitor', undefined);
    const { scannerSupported } = await import('../../src/fingerprint/scanner.js');
    expect(scannerSupported()).toBe(false);
    vi.unstubAllGlobals();
  });
});
