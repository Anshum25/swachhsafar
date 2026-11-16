// What a captured photo says about where and when it was taken (src/utils/capture.js stampLines), and the
// address lookup behind it (src/services/geocode.js).
//
// A record's evidence is its coordinates. The address is a convenience for whoever reads the photo later,
// so every path here has to survive not having one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stampLines } from '../../src/utils/capture.js';
import { _clearGeocodeCache, reverseGeocode } from '../../src/services/geocode.js';

const AT = new Date('2026-11-16T09:30:00+05:30');
const FIX = { latitude: 23.259933, longitude: 77.412615, gps_accuracy_m: 12.4 };

describe('photo stamp', () => {
  it('shows the address first, with the coordinates and time under it', () => {
    const lines = stampLines({ ...FIX, address: 'Platform 1, Bhopal Junction, Madhya Pradesh 462001', at: AT });
    expect(lines[0]).toBe('Platform 1, Bhopal Junction, Madhya Pradesh 462001');
    expect(lines[1]).toContain('23.25993, 77.41262');
    expect(lines[1]).toContain('±12 m');
    expect(lines).toHaveLength(2);
  });

  it('says the address is pending rather than leaving the photo unexplained offline', () => {
    const lines = stampLines({ ...FIX, address: null, at: AT });
    expect(lines[0]).toContain('23.25993, 77.41262');
    expect(lines[1]).toContain('Address pending');
  });

  it('stamps nothing at all without a fix, instead of printing "undefined"', () => {
    expect(stampLines({})).toEqual([]);
    expect(stampLines()).toEqual([]);
    expect(stampLines({ address: 'Somewhere' })).toEqual([]);
  });

  it('leaves out an accuracy the device did not report', () => {
    expect(stampLines({ latitude: 1, longitude: 2, at: AT })[0]).not.toContain('±');
  });
});

describe('address lookup', () => {
  const api = (impl) => ({ get: impl, calls: 0 });
  beforeEach(() => {
    _clearGeocodeCache();
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the server once for fixes within the same few metres', async () => {
    const calls = [];
    const fake = { get: async (path, q) => { calls.push([path, q]); return { address: 'Bhopal Junction', source: 'lookup' }; } };
    expect(await reverseGeocode(fake, FIX)).toBe('Bhopal Junction');
    expect(await reverseGeocode(fake, { ...FIX, latitude: 23.259939 })).toBe('Bhopal Junction');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/geo/reverse');
  });

  it('never throws: offline, an error, or no address at those coordinates', async () => {
    expect(await reverseGeocode(api(async () => { throw new Error('network'); }), FIX)).toBeNull();
    _clearGeocodeCache();
    expect(await reverseGeocode(api(async () => ({ address: null, source: 'disabled' })), FIX)).toBeNull();
    _clearGeocodeCache();
    expect(await reverseGeocode(null, FIX)).toBeNull();
    expect(await reverseGeocode(api(async () => ({})), {})).toBeNull();
  });

  it('does not call the server at all while the device is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    let called = false;
    expect(await reverseGeocode(api(async () => { called = true; return {}; }), FIX)).toBeNull();
    expect(called).toBe(false);
  });

  it('remembers "no address here" but retries after an outage', async () => {
    let n = 0;
    const flaky = { get: async () => { n += 1; return n === 1 ? { address: null, source: 'unavailable' } : { address: 'Found later', source: 'lookup' }; } };
    expect(await reverseGeocode(flaky, FIX)).toBeNull();
    expect(await reverseGeocode(flaky, FIX)).toBe('Found later'); // the outage was not cached
    expect(await reverseGeocode(flaky, FIX)).toBe('Found later'); // the answer was
    expect(n).toBe(2);
  });
});
