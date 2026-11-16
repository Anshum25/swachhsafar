// Where URLs point from inside the Android app (src/services/serverOrigin.js).
//
// In the browser the page and the API share an origin and every URL stays relative, exactly as the PWA has
// always built them. In the APK the page is https://localhost while the API base is the site's full URL, so
// anything that must reach the server has to be rewritten to that host.
import { describe, expect, it } from 'vitest';
import { serverOrigin, serverUrl } from '../../src/services/serverOrigin.js';

const PWA = { base: '/api/v1', origin: 'https://ehk.itfarmer.in' };
const APK = { base: 'https://ehk.itfarmer.in/api/v1', origin: 'https://localhost' };

describe('server origin', () => {
  it('is the page itself when the API base is relative (PWA)', () => {
    expect(serverOrigin(PWA)).toBe('https://ehk.itfarmer.in');
  });

  it('is the API host when the base is absolute (APK, page served from https://localhost)', () => {
    expect(serverOrigin(APK)).toBe('https://ehk.itfarmer.in');
  });

  it('falls back to the page origin for an unusable base', () => {
    expect(serverOrigin({ base: 'http://[bad', origin: 'https://localhost' })).toBe('https://localhost');
  });
});

describe('server URLs', () => {
  it('leaves every path relative in the browser, so the PWA is unchanged', () => {
    for (const path of ['/downloads/latest.json', '/downloads/swachh-safar-latest.apk', '/models/face/x.bin', '/install']) {
      expect(serverUrl(path, PWA)).toBe(path);
    }
  });

  it('points at the site, not at the APK’s own assets, inside the Android app', () => {
    expect(serverUrl('/downloads/latest.json', APK)).toBe('https://ehk.itfarmer.in/downloads/latest.json');
    expect(serverUrl('/downloads/swachh-safar-latest.apk', APK)).toBe('https://ehk.itfarmer.in/downloads/swachh-safar-latest.apk');
  });

  it('keeps an absolute URL as it is', () => {
    expect(serverUrl('https://other.example/x', APK)).toBe('https://other.example/x');
  });
});
