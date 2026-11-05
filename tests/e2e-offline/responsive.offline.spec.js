// Responsive layout audit: every screen at phone, tablet and desktop widths. Fails on anything that makes
// the page scroll sideways or sticks out of the screen (content inside its own horizontal scroller, like a
// wide table, is allowed), on a top bar that wraps onto extra lines, and on bottom-navigation targets that
// are too small to tap. Screenshots of every screen x width go to test-results/responsive/ for review.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { createFakeNetwork, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const BASE = 'http://localhost:4175/';
const EMAIL = 'responsive.e2e@example.com';
const ALL_PERMS = [
  'divisions.manage', 'policies.manage', 'permissions.manage', 'charge.manage', 'audit.read', 'users.read', 'users.manage',
  'trains.read', 'trains.manage', 'questions.manage', 'inventory.items.manage', 'complaints.masters.manage', 'journeys.read',
  'journeys.read_all', 'journeys.manage', 'staff.manage', 'attendance.submit', 'attendance.read', 'attendance.review',
  'inspections.submit', 'inspections.read', 'inspections.review', 'feedback.collect', 'feedback.railway.submit', 'feedback.read',
  'feedback.review', 'complaints.create', 'complaints.read', 'complaints.manage', 'inventory.read', 'inventory.transact',
  'reports.read', 'dashboard.read', 'media.upload',
];
const net = createFakeNetwork({
  users: { [EMAIL]: meFor({ id: IDS.supervisor, name: 'Ravi Kumar Srivastava', email: EMAIL, roleId: 1, divisionId: IDS.division, perms: ALL_PERMS }) },
  today: istDate(new Date()),
});

const PHONES = [320, 360, 390, 412];
const WIDE = [768, 1024, 1366, 1920];
const ROUTES = [
  '/', '/journeys', `/journeys/${IDS.journey}`, '/attendance', `/attendance/${IDS.journey}`, '/inspections',
  `/inspections/${IDS.journey}`, '/feedback', '/complaints', '/inventory', `/inventory/${IDS.journey}`, '/masters', '/reports',
  '/profile', '/profile/password',
];
const SHOTS = 'test-results/responsive';

// Runs in the page: horizontal overflow of the document and the outermost elements sticking out of it.
function measure() {
  const W = document.documentElement.clientWidth;
  const insideScroller = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) {
        const r = a.getBoundingClientRect();
        if (r.left >= -1 && r.right <= W + 1) return true;
      }
    }
    return false;
  };
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 4).join('.') : '';
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${text}" [${Math.round(r.left)}..${Math.round(r.right)} of ${W}]`;
  };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.position === 'fixed' && (r.right <= 0 || r.left >= W)) continue;
    if ((r.right > W + 1 || r.left < -1) && !insideScroller(el)) bad.push(el);
  }
  const outermost = bad.filter((el) => !bad.some((o) => o !== el && o.contains(el)));
  const rowHeight = (id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    const r = el?.getBoundingClientRect();
    return r && r.width > 0 ? Math.round(r.height) : 0;
  };
  const navLinks = [...document.querySelectorAll('nav.fixed a')].map((a) => a.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  return {
    pageOverflow: document.documentElement.scrollWidth - W,
    offenders: outermost.slice(0, 8).map(describe),
    barHeight: rowHeight('topbar-main'),
    statusHeight: rowHeight('topbar-status'),
    smallTaps: navLinks.filter((r) => r.height < 44 || r.width < 44).length,
  };
}

let dir;
test.beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'swachh-responsive-')); mkdirSync(SHOTS, { recursive: true }); });
test.afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows lock */ } });
test.afterAll(() => expect(net.server.cspViolations).toEqual([]));

test('every screen fits phone, tablet and desktop widths', async () => {
  test.setTimeout(600_000);
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE });
  await net.install(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('E2e-Password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/#/journeys');
  await expect(page.getByText('Mumbai Rajdhani').first()).toBeVisible({ timeout: 60_000 });

  const problems = [];
  const check = async (width, name) => {
    await page.waitForTimeout(350);
    const m = await page.evaluate(measure);
    await page.screenshot({ path: `${SHOTS}/${String(width).padStart(4, '0')}-${name}.png`, fullPage: true });
    const issues = [];
    if (m.pageOverflow > 0) issues.push(`page scrolls sideways by ${m.pageOverflow}px`);
    if (m.offenders.length) issues.push(`sticks out: ${m.offenders.join(' | ')}`);
    if (m.barHeight > 64) issues.push(`top bar wraps (${m.barHeight}px tall)`);
    if (m.statusHeight > 56) issues.push(`status strip wraps (${m.statusHeight}px tall)`);
    if (m.smallTaps) issues.push(`${m.smallTaps} bottom-nav target(s) under 44px`);
    if (issues.length) problems.push(`${width}px ${name}: ${issues.join('; ')}`);
  };

  for (const width of [...PHONES, ...WIDE]) {
    await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
    for (const route of ROUTES) {
      await page.goto(`/#${route}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await check(width, route === '/' ? 'dashboard' : route.slice(1).replace(/\//g, '_').slice(0, 40));
    }
    if (width < 1024) { // side menu (drawer) on phones and tablets
      await page.goto('/#/');
      await page.getByRole('button', { name: 'Open menu' }).click();
      await check(width, 'menu');
      await page.getByRole('button', { name: 'Close menu' }).click();
    }
    await page.goto(`/#/attendance/${IDS.journey}`); // a capture dialog
    const next = page.getByRole('button', { name: /stage 1 next/ }).first();
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await check(width, 'attendance-dialog');
      await page.keyboard.press('Escape');
    }
  }
  await context.close();
  expect(problems, problems.join('\n')).toEqual([]);
});
