// Deployed-instance checks in Chromium with Pixel 7 emulation: trusted TLS, installability, service worker,
// OPFS SQLite under the production CSP, and an offline cold start + reload. Read-only: no sign-in.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.LIVE_URL;
test.skip(!BASE, 'LIVE_URL not set');

test('deployed PWA: trusted HTTPS, installable, works offline after one visit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swachh-live-'));
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const violations = [];
  const timings = {};
  try {
    let context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE });
    await context.exposeBinding('__csp', (_s, v) => violations.push(v));
    await context.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => globalThis.__csp?.({ d: e.effectiveDirective, b: e.blockedURI })));
    let page = context.pages()[0] ?? (await context.newPage());

    const t0 = Date.now();
    const res = await page.goto('/');
    expect(res.status()).toBe(200);
    expect(page.url()).toMatch(/^https:/);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await expect(page.getByTestId('db-status')).toContainText('Ready · persistent');
    timings.firstLoadToDbReadyMs = Date.now() - t0;
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    timings.firstLoadToSwControlMs = Date.now() - t0;

    const info = await page.evaluate(async () => ({
      opfs: typeof navigator.storage?.getDirectory === 'function',
      estimate: await navigator.storage.estimate(),
      cacheEntries: (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).length))).reduce((a, b) => a + b, 0),
      apiCached: (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat().filter((p) => p.startsWith('/api/')),
    }));
    expect(info.opfs).toBe(true);
    expect(info.cacheEntries).toBeGreaterThan(30);
    expect(info.apiCached).toEqual([]);

    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data ?? '{}').name).toBe('Swachh Safar 2.0');
    expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
    await context.close();

    // Offline: cold start of the stored app, then a reload. The database must open from OPFS again.
    context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE, offline: true });
    page = context.pages()[0] ?? (await context.newPage());
    const t1 = Date.now();
    await page.goto('/');
    await expect(page.getByTestId('db-status')).toContainText('Ready · persistent');
    timings.offlineColdStartToDbReadyMs = Date.now() - t1;
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await page.reload();
    await expect(page.getByTestId('db-status')).toContainText('Ready · persistent');
    await context.close();

    expect(violations).toEqual([]);
    console.log('[live] timings', JSON.stringify(timings), 'storage', JSON.stringify(info.estimate));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
