// The service worker belongs to the PWA only. Inside the Android app the build is packaged in the APK and
// served from https://localhost by the WebView, so registering one would cache the app's own assets a second
// time and could keep serving a stale copy of a build the user can no longer update from the web.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerSW = vi.fn(() => vi.fn());
vi.mock('virtual:pwa-register', () => ({ registerSW }));

const { registerServiceWorker } = await import('../../src/pwa/registerServiceWorker.js');

beforeEach(() => {
  registerSW.mockClear();
  vi.stubEnv('DEV', false); // a development build never registers one; this is the production path
  vi.stubGlobal('navigator', { serviceWorker: { addEventListener() {} } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete globalThis.Capacitor;
});

describe('service worker registration', () => {
  it('registers in a browser (the PWA keeps working exactly as before)', () => {
    registerServiceWorker();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it('does not register inside the Android app', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    registerServiceWorker();
    expect(registerSW).not.toHaveBeenCalled();
  });

  it('still registers in a browser that exposes a Capacitor object for the web platform', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    registerServiceWorker();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it('does nothing where the browser has no service worker support', () => {
    vi.stubGlobal('navigator', {});
    registerServiceWorker();
    expect(registerSW).not.toHaveBeenCalled();
  });
});
