// Over-the-air web bundle updates (src/pwa/bundleUpdate.js): the Android app replaces its own web build
// from the server instead of waiting for a new APK.
//
// What these tests are really protecting: the app must never run bytes it has not verified, must never
// reload itself under someone mid-shift, and must never get stuck re-downloading a bundle that does not
// start. Everything else here is detail.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyBundleUpdate, checkBundleUpdate, currentBundle, markBundleHealthy } from '../../src/pwa/bundleUpdate.js';

const OFFER = {
  bundle_id: '2.0.9+422',
  version: '2.0.9',
  build: 422,
  url: '/api/v1/app/bundle/422/download',
  sha256: 'f'.repeat(64),
  size_bytes: 6_200_000,
  mandatory: false,
};

const answer = (body, { status = 200, ok = true, type = 'application/json' } = {}) => ({
  status,
  ok,
  headers: { get: () => type },
  json: async () => body,
});

let updater;

// The suite runs in the `node` environment (vite.config.js), so there is no localStorage unless one is
// put there. src/pwa/bundleUpdate.js copes with its absence by design -- a phone in private mode or with
// site data blocked is a real case -- but the retry-loop behaviour is only visible with storage present.
function installStorage(store = new Map()) {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

function installPlugin(overrides = {}) {
  updater = {
    current: vi.fn(async () => ({ bundle: { version: '2.0.8+421' }, native: '2.0.7' })),
    download: vi.fn(async () => ({ id: 'bundle-abc' })),
    next: vi.fn(async () => ({})),
    set: vi.fn(async () => ({})),
    notifyAppReady: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    ...overrides,
  };
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorUpdater: updater } };
  return updater;
}

const check = (fetchImpl, opts = {}) =>
  checkBundleUpdate({ fetchImpl, deviceId: 'device-1', ...opts });

beforeEach(() => {
  installPlugin();
  installStorage();
});

afterEach(() => {
  delete globalThis.Capacitor;
  delete globalThis.localStorage;
  vi.restoreAllMocks();
});

describe('asking the server what to run', () => {
  it('reports the bundle the server offers', async () => {
    const update = await check(async () => answer(OFFER));
    expect(update).toMatchObject({ bundleId: '2.0.9+422', version: '2.0.9', sha256: OFFER.sha256, mandatory: false });
  });

  it('sends what it is running, so the server can answer "stay where you are"', async () => {
    const fetchImpl = vi.fn(async () => answer(OFFER));
    await check(fetchImpl);
    const url = new URL(fetchImpl.mock.calls[0][0], 'https://localhost');
    expect(url.searchParams.get('current')).toBe('2.0.8+421');
    expect(url.searchParams.get('native')).toBe('2.0.7');   // the APK, which gates what may be served
    expect(url.searchParams.get('device')).toBe('device-1'); // so a staged rollout is stable per phone
    expect(url.searchParams.get('channel')).toBe('stable');
  });

  it('stays quiet when the server says there is nothing to do', async () => {
    expect(await check(async () => answer(null, { status: 204 }))).toBeNull();
  });

  // A phone in the field meets captive portals, dead connections and proxies that answer with HTML. None
  // of that may turn into "an update is available", because the next step downloads and runs code.
  it('stays quiet when the server cannot be trusted to have answered', async () => {
    expect(await check(async () => { throw new Error('offline'); })).toBeNull();
    expect(await check(async () => answer(OFFER, { ok: false, status: 500 }))).toBeNull();
    expect(await check(async () => answer(OFFER, { type: 'text/html' }))).toBeNull();
    expect(await check(async () => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => { throw new Error('nope'); } }))).toBeNull();
  });

  it('ignores an offer that is missing the hash, the url or the name', async () => {
    for (const missing of ['sha256', 'url', 'bundle_id']) {
      expect(await check(async () => answer({ ...OFFER, [missing]: undefined }))).toBeNull();
    }
  });

  it('does nothing in a browser, where there is no bundle to replace', async () => {
    delete globalThis.Capacitor;
    expect(await check(async () => answer(OFFER))).toBeNull();
  });
});

describe('downloading and staging', () => {
  it('passes the published hash to the updater, which refuses bytes that do not match it', async () => {
    const update = await check(async () => answer(OFFER));
    await applyBundleUpdate(update);
    expect(updater.download).toHaveBeenCalledWith({
      url: expect.stringContaining('/api/v1/app/bundle/422/download'),
      version: '2.0.9+422',
      checksum: OFFER.sha256,
    });
  });

  // The whole point of staging: a sanitation worker halfway through a journey, with unsynced records and
  // an open form, must not have the WebView reload underneath them.
  it('stages the bundle for the next cold start rather than applying it now', async () => {
    const update = await check(async () => answer(OFFER));
    const result = await applyBundleUpdate(update);
    expect(result).toEqual({ applied: true, immediate: false, bundleId: 'bundle-abc' });
    expect(updater.next).toHaveBeenCalledWith({ id: 'bundle-abc' });
    expect(updater.set).not.toHaveBeenCalled();
  });

  it('applies at once only when the server marked the release mandatory', async () => {
    const update = await check(async () => answer({ ...OFFER, mandatory: true }));
    const result = await applyBundleUpdate(update);
    expect(result).toEqual({ applied: true, immediate: true, bundleId: 'bundle-abc' });
    expect(updater.set).toHaveBeenCalledWith({ id: 'bundle-abc' });
    expect(updater.next).not.toHaveBeenCalled();
  });

  // Just opened, nobody using it yet (freshStart.js): the new bundle is switched to at once, so closing and
  // reopening the app is all an update takes.
  it('switches at once when the app has just been opened', async () => {
    const update = await check(async () => answer(OFFER));
    const result = await applyBundleUpdate(update, { now: true });
    expect(result).toEqual({ applied: true, immediate: true, bundleId: 'bundle-abc' });
    expect(updater.set).toHaveBeenCalledWith({ id: 'bundle-abc' });
    expect(updater.next).not.toHaveBeenCalled();
  });

  it('does not offer a bundle again once it has failed on this phone', async () => {
    installPlugin({ download: vi.fn(async () => { throw new Error('checksum mismatch'); }) });
    const update = await check(async () => answer(OFFER));
    expect(await applyBundleUpdate(update)).toMatchObject({ applied: false });

    // Without this, a bad release means a 6 MB download on every launch, over a connection that is
    // already the reason the field app exists.
    expect(await check(async () => answer(OFFER))).toBeNull();
    // A different release is still offered: the phone is not stuck on the broken one for ever.
    expect(await check(async () => answer({ ...OFFER, bundle_id: '2.1.0+430', version: '2.1.0' }))).toMatchObject({
      bundleId: '2.1.0+430',
    });
  });

  // Private mode, cleared site data, or a device policy that blocks storage: the app still has to work,
  // and the worst this may cost is one wasted download.
  it('survives storage it cannot read or write', async () => {
    for (const broken of [
      { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } },
      undefined,
    ]) {
      if (broken) globalThis.localStorage = broken;
      else delete globalThis.localStorage;
      installPlugin({ download: vi.fn(async () => { throw new Error('network'); }) });
      const update = await check(async () => answer(OFFER));
      expect(update).toMatchObject({ bundleId: '2.0.9+422' });
      expect(await applyBundleUpdate(update)).toMatchObject({ applied: false });
    }
  });
});

describe('the rollback signal', () => {
  // The updater reverts to the previous bundle unless the new one reports that it started. That is what
  // makes a white-screening release undo itself on the next launch with nobody touching the phone.
  it('tells the updater the bundle started', async () => {
    await markBundleHealthy();
    expect(updater.notifyAppReady).toHaveBeenCalled();
  });

  it('does not throw when there is no updater, or it fails', async () => {
    delete globalThis.Capacitor;
    await expect(markBundleHealthy()).resolves.toBeUndefined();
    installPlugin({ notifyAppReady: vi.fn(async () => { throw new Error('bridge gone'); }) });
    await expect(markBundleHealthy()).resolves.toBeUndefined();
  });

  it('reports what is running, and copes when the updater will not say', async () => {
    expect(await currentBundle()).toEqual({ bundle: '2.0.8+421', native: '2.0.7' });
    installPlugin({ current: vi.fn(async () => { throw new Error('no'); }) });
    expect(await currentBundle()).toEqual({ bundle: null, native: null });
  });
});
