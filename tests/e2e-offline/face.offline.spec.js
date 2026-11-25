// Face-verified attendance in the real app, with the network disconnected: the face model (precached by the
// service worker) runs on the device under the production CSP, and attendance cannot be saved unless the
// photo matches the employee's registered face. Not covered here: a true positive match, which needs real
// face photos (none ship with the library, and photos of real people are not used as test data); the
// matching decision itself is unit-tested in tests/unit/faceMatch.test.js.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { FIELD_PERMS, createFakeNetwork, ensureGps, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const BASE = `http://localhost:${process.env.E2E_PORT || '4175'}/`;
const EMAIL = 'face.e2e@example.com';
const net = createFakeNetwork({
  users: { [EMAIL]: meFor({ id: IDS.supervisor, name: 'Ravi Kumar', email: EMAIL, roleId: 4, divisionId: IDS.division, perms: FIELD_PERMS }) },
  today: istDate(new Date()),
});
const { server } = net;
for (const p of Object.values(net.masters.policies)) Object.assign(p, { attendance_face_verification: true, face_match_threshold: 0.5 });
const descriptor = (seed) => Array.from({ length: 128 }, (_, i) => Math.round(Math.sin(seed + i) * 1000) / 10000);
server.faceProfiles = [{ user_id: IDS.janitor1, division_id: IDS.division, model: 'faceapi-resnet128-v1', descriptors: [1, 2, 3, 4].map(descriptor), updated_at: '2026-11-04T00:00:00Z' }];

let dir;
test.beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'swachh-face-')); });
test.afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows lock */ } });
test.afterAll(() => expect(server.cspViolations).toEqual([]));

test('face verification blocks offline attendance without a live face capture', async () => {
  test.setTimeout(300_000);
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, {
    ...pixel, baseURL: BASE, geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 }, permissions: ['geolocation'],
  });
  await net.install(context);
  const page = context.pages()[0] ?? (await context.newPage());
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

  // ---- offline from here: the face library and models come from the service worker's precache ----
  server.connected = false;
  await context.setOffline(true);
  await page.goto(`/#/attendance/${IDS.journey}`);

  // With face verification on, the photo comes only from the live camera, after a blink: there is no gallery
  // picker, so a picture of someone (or a photo with no face) cannot be chosen. This machine has no camera,
  // so nothing is captured and attendance cannot be marked, for a registered or an unregistered person.
  for (const name of ['Sunita Devi', 'Mohan Lal']) {
    await page.getByRole('listitem', { name: `${name} stage 1 Source next` }).click();
    const dialog = page.getByRole('dialog');
    await ensureGps(dialog);
    await expect(dialog.getByTestId('live-face')).toBeVisible();
    await expect(dialog.getByTestId('photo-input')).toHaveCount(0);
    await expect(dialog.getByTestId('face-check')).toHaveAttribute('data-status', 'waiting');
    await expect(dialog.getByRole('button', { name: 'Mark attendance' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }

  // Nothing was saved or sent.
  await expect(page.getByRole('listitem', { name: /pending sync/ })).toHaveCount(0);
  expect(server.batches).toEqual([]);
  await context.close();
});
