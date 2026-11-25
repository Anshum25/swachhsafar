// Installable-PWA checks against the production build: a valid web app manifest with real 192/512 and
// maskable icons, a service worker that precaches every built asset, and an app shell that starts,
// deep-links and reloads with the network disconnected after one online visit. Browser emulation of a
// Pixel 7 (Chromium); this is not a physical Android device.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = `http://localhost:${process.env.E2E_PORT || '4175'}/`;

// Width and height from a PNG's IHDR chunk.
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

let dir;
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swachh-pwa-'));
});
test.afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch { /* Windows may keep the profile locked briefly */ }
});

test('manifest is installable: standalone, scoped, with 192/512 and maskable PNG icons', async ({ request }) => {
  const html = await (await request.get(BASE)).text();
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(html).toContain('name="theme-color"');
  const res = await request.get(`${BASE}manifest.webmanifest`);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: 'Swachh Safar 2.0', short_name: 'Swachh Safar', start_url: '/', scope: '/', display: 'standalone', id: '/' });
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  const need = [['192x192', undefined], ['512x512', undefined], ['512x512', 'maskable']];
  for (const [sizes, purpose] of need) {
    const icon = m.icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(icon, `${sizes} ${purpose ?? 'any'} icon`).toBeTruthy();
    const img = await request.get(new URL(icon.src, BASE).href);
    expect(img.ok()).toBe(true);
    expect(img.headers()['content-type']).toContain('image/png');
    const [w, h] = sizes.split('x').map(Number);
    expect(pngSize(await img.body())).toEqual({ width: w, height: h });
  }
});

test('the app shell starts, deep-links and reloads offline after one online visit', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  let context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE });
  // No backend in this test: API and Google calls fail as unreachable.
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

  // Every file of the build is in the precache (hashed JS/CSS chunks of every screen, SQLite WASM, icons).
  const built = readdirSync('dist-e2e/assets');
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    return urls;
  });
  for (const f of built) expect(cached.some((u) => u.endsWith(`/assets/${f}`)), `precached ${f}`).toBe(true);
  for (const f of ['/index.html', '/manifest.webmanifest', '/pwa-192x192.png', '/pwa-512x512.png']) expect(cached).toContain(f);
  // No API response is ever cached by the service worker.
  expect(cached.some((u) => u.startsWith('/api/'))).toBe(false);

  // ---- offline: cold start, deep link, reload ----
  await context.close();
  context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE, offline: true });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/inventory');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.goto('/some/deep/path'); // non-hash navigation: answered with the cached index.html
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  // Lazily-loaded screens are available offline too (their chunks are precached).
  const failed = [];
  page.on('requestfailed', (r) => { if (!/\/api\/v1\/|google|firebase/.test(r.url())) failed.push(r.url()); });
  await page.goto('/#/reports');
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(failed).toEqual([]);
  await context.close();
});

// Chrome's own installability engine (the check behind "Install app"), via the DevTools protocol, plus the
// production security headers served with the shell. localhost counts as a secure context like HTTPS.
test('Chrome reports the app installable, under the production security headers, with no CSP violations', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'swachh-install-')), { ...pixel, baseURL: BASE });
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  const violations = [];
  await context.exposeBinding('__cspViolation', (_s, v) => violations.push(v));
  await context.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => globalThis.__cspViolation?.({ directive: e.effectiveDirective, blocked: e.blockedURI })));
  const page = context.pages()[0] ?? (await context.newPage());
  const res = await page.goto('/');
  const headers = res.headers();
  expect(headers['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(headers['content-security-policy']).toContain("object-src 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['permissions-policy']).toContain('camera=(self)');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  // A signed-out start (what the installed app opens at start_url "/") is Sign in. There is no self-registration:
  // staff accounts are created by an administrator.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toHaveCount(0);
  // The SQLite WASM database can start under this CSP: compiling WebAssembly needs 'wasm-unsafe-eval'.
  expect(await page.evaluate(async () => {
    const mod = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return mod instanceof WebAssembly.Module;
  })).toBe(true);

  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
  expect(violations).toEqual([]);
  await context.close();
});

// The share link: /install works without signing in, offers installation (Chrome's prompt where available,
// otherwise this browser's steps), keeps working offline from the stored app, and leads to sign-in.
test('install page (share link) needs no sign-in, offers install, works offline', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const profile = mkdtempSync(join(tmpdir(), 'swachh-installpage-'));
  let context = await chromium.launchPersistentContext(profile, { ...pixel, baseURL: BASE });
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: 'Swachh Safar' })).toBeVisible();
  await expect(page.getByTestId('install-app').or(page.getByText('How to install'))).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await context.close();

  context = await chromium.launchPersistentContext(profile, { ...pixel, baseURL: BASE, offline: true });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: 'Swachh Safar' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue in the browser instead' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});

// Everything the page does differently when it runs inside the APK rather than in a browser: no service
// worker (the build is packaged in the app), no "install the web app" banner, and the APK's own update
// notice when the server publishes a release built from a different commit.
// Browser emulation with the Capacitor bridge faked; a real APK can only be checked on a phone.
test('inside the Android app: no service worker, no install banner, an APK update offer instead', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const profile = mkdtempSync(join(tmpdir(), 'swachh-native-'));
  const context = await chromium.launchPersistentContext(profile, { ...pixel, baseURL: BASE });
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  await context.route('**/downloads/latest.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ sha: 'f'.repeat(40), version_name: '2.1.0', file: 'swachh-safar-ffffff.apk' }),
  }));
  await context.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { SwachhSecurity: {
        getDeviceIntegrity: async () => ({ developerMode: false, usbDebugging: false }),
        addListener: () => ({ remove() {} }),
      } },
    };
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const banner = page.getByTestId('apk-update-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/downloads/swachh-safar-latest.apk');
  // No service worker is registered, and the PWA's install banner never appears in an installed app.
  await page.waitForTimeout(7000); // the written install hint waits 6s before it would appear
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect(page.getByTestId('install-hint')).toHaveCount(0);
  await expect(page.getByTestId('install-banner')).toHaveCount(0);
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});

// The same page in a browser: the published release is a different commit, but no APK notice is shown,
// because the web app updates itself through the service worker.
test('in a browser the APK update notice never appears', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const profile = mkdtempSync(join(tmpdir(), 'swachh-web-noapk-'));
  const context = await chromium.launchPersistentContext(profile, { ...pixel, baseURL: BASE });
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  await context.route('**/downloads/latest.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'f'.repeat(40), version_name: '2.1.0' }),
  }));
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await expect(page.getByTestId('apk-update-banner')).toHaveCount(0);
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});

// Android app with Developer options on: nothing but the "turn off Developer mode" screen; it opens once off.
test('developer mode keeps the Android app closed until it is turned off', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const profile = mkdtempSync(join(tmpdir(), 'swachh-devmode-'));
  const context = await chromium.launchPersistentContext(profile, { ...pixel, baseURL: BASE });
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  await context.addInitScript(() => {
    window.__devMode = true;
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { SwachhSecurity: {
        getDeviceIntegrity: async () => ({ developerMode: window.__devMode, usbDebugging: false }),
        openDeveloperSettings: async () => {},
        addListener: () => ({ remove() {} }),
      } },
    };
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Please turn off Developer mode' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);
  // No route of the app is a way around it, not even the public pages.
  for (const path of ['/download', '/install', '/#/reports']) {
    await page.goto(path);
    await expect(page.getByTestId('developer-mode-gate')).toBeVisible();
  }
  await page.goto('/');
  await page.evaluate(() => { window.__devMode = false; });
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('developer-mode-gate')).toHaveCount(0);
  await context.close();
  rmSync(profile, { recursive: true, force: true });
});
