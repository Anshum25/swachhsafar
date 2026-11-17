// The browser Maps key, as the field sees it: Google refuses a key *after* the API has loaded, and a
// geocode under a refused key never answers at all. Both were found against the real key, whose referrer
// allowlist did not (yet) include the app's domain -- the attendance photo then read "Address pending"
// for as long as the dialog stayed open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetGoogleMaps, mapsAuthFailed, onMapsAuthFailure, reverseGeocodeInBrowser } from '../../src/services/googleMaps.js';

// A loaded Maps JS API whose geocoder behaves as `geocode` says.
function stubMaps(geocode) {
  const win = { google: { maps: { Geocoder: class { geocode = geocode; } } }, navigator: { onLine: true } };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { head: { appendChild: () => {} }, createElement: () => ({}) });
  return win;
}

describe('browser Maps key', () => {
  beforeEach(() => _resetGoogleMaps());
  afterEach(() => { vi.unstubAllGlobals(); _resetGoogleMaps(); });

  it('gives up on a geocode that never answers, instead of leaving the address pending for ever', async () => {
    stubMaps(() => new Promise(() => {})); // a refused key: Google answers the auth failure, not the call
    await expect(reverseGeocodeInBrowser({ latitude: 23.26, longitude: 77.41 }, { timeoutMs: 20 })).resolves.toBeNull();
  });

  it('stops waiting the moment Google refuses the key', async () => {
    const win = stubMaps(() => new Promise(() => {}));
    const pending = reverseGeocodeInBrowser({ latitude: 23.26, longitude: 77.41 }, { timeoutMs: 10_000 });
    win.gm_authFailure?.();
    await expect(pending).resolves.toBeNull();
  });

  it('tells a map already on screen that the key was refused, since Google says so only after it loads', async () => {
    const win = stubMaps(async () => ({ results: [] }));
    const told = [];
    onMapsAuthFailure(() => told.push('off'));
    expect(mapsAuthFailed()).toBe(false);
    // The service installs the handler as the script is injected; a loaded API already has it.
    await reverseGeocodeInBrowser({ latitude: 23.26, longitude: 77.41 }, { timeoutMs: 50 });
    win.gm_authFailure?.();
    expect(told).toEqual(['off']);
    expect(mapsAuthFailed()).toBe(true);
    // A listener added after the refusal is told at once, not left waiting for a second failure.
    const late = [];
    onMapsAuthFailure(() => late.push('off'));
    expect(late).toEqual(['off']);
  });

  it('returns the address when the key is allowed', async () => {
    stubMaps(async () => ({ results: [{ formatted_address: 'Platform 1, Bhopal Junction, Madhya Pradesh' }] }));
    await expect(reverseGeocodeInBrowser({ latitude: 23.26, longitude: 77.41 })).resolves
      .toBe('Platform 1, Bhopal Junction, Madhya Pradesh');
  });

  it('asks for nothing without a fix, and never throws on a geocode that errors', async () => {
    stubMaps(async () => { throw new Error('ZERO_RESULTS'); });
    await expect(reverseGeocodeInBrowser({})).resolves.toBeNull();
    await expect(reverseGeocodeInBrowser({ latitude: 23.26, longitude: 77.41 })).resolves.toBeNull();
  });
});
