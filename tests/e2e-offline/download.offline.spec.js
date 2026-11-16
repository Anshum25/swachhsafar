// Public /download page: plain-link APK download, honest "not published" state, no APK offer on iOS.
// Engines: Chromium with each browser's user agent (Firefox/WebKit engines need host libraries not installed
// on the build server). Real-device checks are listed in docs/SECURITY_TEST_REPORT.md.
import { chromium, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = `http://localhost:${process.env.E2E_PORT || '4175'}/`;
const APK = Buffer.from('PK\x03\x04 fake apk bytes for the download test');
const SHA = createHash('sha256').update(APK).digest('hex');
const LATEST = { package: 'in.itfarmer.swachhsafar', version_name: '2.0.0', version_code: 200, min_sdk: 26,
  file: 'swachh-safar-2.0.0.apk', latest_url: '/downloads/swachh-safar-latest.apk', url: '/downloads/swachh-safar-2.0.0.apk',
  size_bytes: 31_457_280, sha256: SHA, released_at: '2026-11-06T12:00:00+00:00' };

const UAS = {
  'Chrome Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
  'Samsung Internet': 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
  'Edge Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36 EdgA/128.0',
  'Firefox Android': 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  'Opera Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36 OPR/84.0',
};

async function serve(context, { published = true } = {}) {
  await context.route('**/downloads/latest.json', (r) => (published
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LATEST) })
    : r.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' })));
  await context.route('**/downloads/*.apk', (r) => r.fulfill({ status: 200, body: APK, headers: {
    'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="swachh-safar-latest.apk"' } }));
}

for (const [name, userAgent] of Object.entries(UAS)) {
  test(`${name}: Download Android APK is a plain link and downloads the published file`, async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ userAgent, viewport: { width: 390, height: 844 }, isMobile: true, acceptDownloads: true });
    await serve(context);
    const page = await context.newPage();
    await page.goto(`${BASE}download`);
    const link = page.getByTestId('download-apk');
    await expect(link).toBeVisible();
    expect(await link.getAttribute('href')).toBe('/downloads/swachh-safar-latest.apk');
    expect(await link.getAttribute('download')).toBeNull(); // no browser-specific attribute needed
    await expect(page.getByText('30.0 MB')).toBeVisible();
    await expect(page.getByTestId('apk-sha256')).toHaveText(SHA);
    await expect(page.getByText(/Android 8\.0 or newer/)).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('swachh-safar-latest.apk');
    const bytes = readFileSync(await download.path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA);
    await expect(page.getByRole('link', { name: 'Open Web App' })).toBeVisible();
    await browser.close();
  });
}

test('iPhone: no APK offered; Add to Home Screen instructions', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  await serve(context);
  const page = await context.newPage();
  await page.goto(`${BASE}download`);
  await expect(page.getByText(/cannot be installed on iPhone/)).toBeVisible();
  await expect(page.getByTestId('download-apk')).toHaveCount(0);
  await expect(page.getByText(/Add to Home Screen/).first()).toBeVisible();
  await browser.close();
});

test('not yet published: says so, offers no broken link; desktop gets web-app guidance', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await serve(context, { published: false });
  const page = await context.newPage();
  await page.goto(`${BASE}download`);
  await expect(page.getByTestId('apk-unavailable')).toContainText(/not been published/);
  await expect(page.getByTestId('download-apk')).toHaveCount(0);
  await expect(page.getByText(/install icon in the address bar/)).toBeVisible();
  await browser.close();
});
