// Application update with unsynced data on the device: a record captured offline is still waiting for the
// server when a new service worker version is published. While the app is in use the update waits (nothing
// is swapped under the user, and there is no button to tap); closing and reopening the app loads it by
// itself. The record must survive the update and then be delivered exactly once.
//
// The "new version" is published like a deploy does: the served serviceWorker.js on disk changes (the same
// build plus a marker that answers a message), so the browser's own update check finds a byte-different
// script and runs the real install -> waiting -> activate flow. (Playwright routing cannot intercept the
// browser's service-worker update fetch, so the file itself is replaced, and restored afterwards.)
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { FIELD_PERMS, createFakeNetwork, ensureGps, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const BASE = `http://localhost:${process.env.E2E_PORT || '4175'}/`;
const EMAIL = 'update.e2e@example.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const net = createFakeNetwork({
  users: { [EMAIL]: meFor({ id: IDS.supervisor, name: 'Ravi Kumar', email: EMAIL, roleId: 4, divisionId: IDS.division, perms: FIELD_PERMS }) },
  today: istDate(new Date()),
});
const { server } = net;
const V2_MARKER = `
self.addEventListener('message', (e) => { if (e.data === 'e2e-version') e.ports[0].postMessage('v2'); });
`;

const SW_FILE = 'dist-e2e/serviceWorker.js';
let swOriginal;
let dir;
test.beforeAll(() => { swOriginal = readFileSync(SW_FILE, 'utf8'); });
test.afterAll(() => { if (swOriginal) writeFileSync(SW_FILE, swOriginal); });
test.beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'swachh-update-')); });
test.afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows lock */ } });
test.afterAll(() => expect(server.cspViolations).toEqual([]));

const swVersion = (page) => page.evaluate(() => new Promise((resolve) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => resolve(e.data);
  navigator.serviceWorker.controller.postMessage('e2e-version', [ch.port2]);
  setTimeout(() => resolve('v1'), 1500); // the original worker does not answer
}));

test('a new version loads by itself when the app is reopened, keeps the unsynced record, and the record is delivered once', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, {
    ...pixel, baseURL: BASE, geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 }, permissions: ['geolocation'],
  });
  await net.install(context);
  const page = context.pages()[0] ?? (await context.newPage());

  // ---- online: sign in and download journeys ----
  await page.goto('/#/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('E2e-Password-1');
  // The sign-in form keeps its button disabled until the visible security check is answered; the fake
  // backend (fakeNetwork.js) accepts 12345.
  await page.getByLabel('Security code', { exact: true }).fill('12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/#/journeys');
  await expect(page.getByText('Mumbai Rajdhani').first()).toBeVisible({ timeout: 60_000 });
  expect(await swVersion(page)).toBe('v1');

  // ---- server unreachable: capture attendance, which stays pending ----
  server.connected = false;
  await page.goto('/#/attendance');
  await page.getByRole('button', { name: /12951/ }).click();
  await page.getByRole('listitem', { name: 'Sunita Devi stage 1 Source next' }).click();
  const dialog = page.getByRole('dialog');
  await ensureGps(dialog);
  await dialog.getByTestId('photo-input').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG });
  await expect(dialog.getByAltText('Captured evidence')).toBeVisible();
  await dialog.getByRole('button', { name: 'Mark attendance' }).click();
  await expect(page.getByRole('listitem', { name: 'Sunita Devi stage 1 Source pending sync' })).toBeVisible();

  // ---- a new version is published while the app is in use: it waits, already downloaded ----
  writeFileSync(SW_FILE, swOriginal + V2_MARKER);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  const banner = page.getByTestId('update-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('loads the next time you open the app');
  await expect(banner).toContainText('1 unsynced record(s) are stored on this device and are kept');
  await expect(banner.getByRole('button')).toHaveCount(0);   // nothing to tap, no "clear cache"
  expect(await swVersion(page)).toBe('v1'); // not swapped under the user

  // ---- the app is closed and opened again: the new version loads by itself ----
  await page.reload();
  await expect.poll(() => swVersion(page), { timeout: 30_000 }).toBe('v2');
  await expect(page.getByTestId('update-banner')).toHaveCount(0);

  // ---- after the update: the record is still on the device and still pending ----
  await page.goto('/#/attendance');
  await page.getByRole('button', { name: /12951/ }).click();
  await expect(page.getByRole('listitem', { name: 'Sunita Devi stage 1 Source pending sync' })).toBeVisible();
  expect(server.batches).toEqual([]);

  // ---- server back: delivered exactly once ----
  server.connected = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('listitem', { name: 'Sunita Devi stage 1 Source pending sync' })).toHaveCount(0, { timeout: 60_000 });
  const att = server.batches.filter((o) => o.type === 'attendance.create');
  expect(att).toHaveLength(1);
  expect(new Set(server.batches.map((o) => o.op_id)).size).toBe(server.batches.length);
  await context.close();
});
