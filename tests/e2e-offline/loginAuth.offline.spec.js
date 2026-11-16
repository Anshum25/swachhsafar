import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { createFakeNetwork, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const USER_EMAIL = 'supervisor.auth@example.com';
const USER_MOBILE = '9876543210';
const net = createFakeNetwork({
  today: istDate(new Date()),
  users: {
    [USER_EMAIL]: meFor({
      id: IDS.supervisor,
      name: 'Ravi Kumar',
      email: USER_EMAIL,
      roleId: 4,
      divisionId: IDS.division,
    }),
  },
});

const profileDirs = [];
function newProfileDir() {
  const dir = mkdtempSync(join(tmpdir(), 'swachh-login-'));
  profileDirs.push(dir);
  return dir;
}

test.afterAll(() => {
  for (const dir of profileDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch { /* ignored */ }
  }
});

test.afterAll(() => expect(net.server.cspViolations).toEqual([]));

test.describe('Login Screen — Visible CAPTCHA & Mobile OTP Authentication', () => {
  test('1. Default Login: visible CAPTCHA, form validation, and successful password sign-in', async () => {
    test.setTimeout(120_000);
    const dir = newProfileDir();
    const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
    const context = await chromium.launchPersistentContext(dir, {
      ...pixel,
      baseURL: `http://localhost:${process.env.E2E_PORT || '4175'}/`,
      geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 },
      permissions: ['geolocation'],
    });
    await net.install(context);
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto('/#/login');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

    // Verify Default Screen Elements
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Swachh Safar operations')).toBeVisible();

    const emailInput = page.getByLabel('Email');
    await expect(emailInput).toBeVisible();

    const passwordInput = page.getByLabel('Password', { exact: true });
    await expect(passwordInput).toBeVisible();

    // Verify visible CAPTCHA verification component
    const captchaComponent = page.getByTestId('captcha-verification');
    await expect(captchaComponent).toBeVisible();
    await expect(captchaComponent.getByText(/Security Verification/i)).toBeVisible();

    // The image loads; the person types the number.
    await expect(captchaComponent).toHaveAttribute('data-status', 'ready');
    await expect(captchaComponent.getByRole('img')).toBeVisible();
    await page.getByLabel('Security code', { exact: true }).fill('12345');
    await expect(captchaComponent).toHaveAttribute('data-status', 'answered');

    // "OR" Divider and "Log in with Mobile Number"
    await expect(page.getByText('OR', { exact: true })).toBeVisible();
    const mobileLoginBtn = page.getByRole('button', { name: /Log in with Mobile Number/i });
    await expect(mobileLoginBtn).toBeVisible();

    // Sign in button is disabled if fields are empty
    const signInBtn = page.getByRole('button', { name: 'Sign in' });
    await expect(signInBtn).toBeDisabled();

    // Fill invalid credentials
    await emailInput.fill(USER_EMAIL);
    await passwordInput.fill('Wrong-Password-1');
    await expect(signInBtn).toBeEnabled();
    await signInBtn.click();

    // Error message appears
    await expect(page.getByRole('alert')).toContainText(/Employee ID or password is incorrect/i);

    // A failed sign-in uses up the code: a new image, and Sign in waits for a new answer.
    await expect(captchaComponent).toHaveAttribute('data-status', 'ready');
    await expect(signInBtn).toBeDisabled();

    // A wrong code is refused by the server.
    await passwordInput.fill('E2e-Password-1');
    await page.getByLabel('Security code', { exact: true }).fill('99999');
    await signInBtn.click();
    await expect(page.getByRole('alert')).toContainText(/security code was wrong/i);
    await expect(captchaComponent).toHaveAttribute('data-status', 'ready');

    // Right code and password.
    await page.getByLabel('Security code', { exact: true }).fill('12345');
    await expect(signInBtn).toBeEnabled();
    await signInBtn.click();

    // Successfully logged in
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: 'Welcome, Ravi' })).toBeVisible({ timeout: 60_000 });

    await context.close();
  });

  test('2. Mobile OTP Login: mode switch, CAPTCHA, request OTP, invalid OTP and valid OTP verification', async () => {
    test.setTimeout(120_000);
    const dir = newProfileDir();
    const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
    const context = await chromium.launchPersistentContext(dir, {
      ...pixel,
      baseURL: `http://localhost:${process.env.E2E_PORT || '4175'}/`,
      geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 },
      permissions: ['geolocation'],
    });
    await net.install(context);
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto('/#/login');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

    // Click "Log in with Mobile Number"
    await page.getByRole('button', { name: /Log in with Mobile Number/i }).click();

    // Verify Mobile OTP Screen
    await expect(page.getByRole('heading', { name: 'Mobile Number Login' })).toBeVisible();
    await expect(page.getByText('Sign in using your registered mobile number')).toBeVisible();

    // Country code prefix and Mobile input
    await expect(page.getByText('+91')).toBeVisible();
    const mobileInput = page.getByPlaceholder('9876543210');
    await expect(mobileInput).toBeVisible();

    // Visible CAPTCHA verification component on mobile screen
    const captchaComponent = page.getByTestId('captcha-verification');
    await expect(captchaComponent).toBeVisible();
    await expect(captchaComponent).toHaveAttribute('data-status', 'ready');

    // "Send OTP" button
    const sendOtpBtn = page.getByRole('button', { name: 'Send OTP' });
    await expect(sendOtpBtn).toBeDisabled();

    // Check "Back to Email & Password" button
    const backBtn = page.getByRole('button', { name: /Back to Email & Password/i });
    await expect(backBtn).toBeVisible();

    // Test switching back and forth
    await backBtn.click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByRole('button', { name: /Log in with Mobile Number/i }).click();
    await expect(page.getByRole('heading', { name: 'Mobile Number Login' })).toBeVisible();

    // Enter 10-digit mobile number; Send OTP still waits for the security code.
    await expect(captchaComponent).toHaveAttribute('data-status', 'ready');
    await mobileInput.fill(USER_MOBILE);
    await expect(sendOtpBtn).toBeDisabled();
    await page.getByLabel('Security code', { exact: true }).fill('12345');
    await expect(sendOtpBtn).toBeEnabled();

    // Send OTP
    await sendOtpBtn.click();

    // Step 2: OTP Entry displayed
    await expect(page.getByText(`If +91 ${USER_MOBILE} is registered`, { exact: false })).toBeVisible();
    await expect(page.getByText(/Enter 6-Digit OTP/i)).toBeVisible();
    await expect(page.getByText(/Expires in/i)).toBeVisible();
    await expect(page.getByText(/Valid for 5 mins/i)).toBeVisible();
    await expect(page.getByText(/Resend code in/i)).toBeVisible();

    const verifyBtn = page.getByRole('button', { name: /Verify & Sign in/i });
    await expect(verifyBtn).toBeDisabled();

    // Enter wrong 6-digit OTP
    const digitInputs = page.getByRole('group', { name: '6-Digit Verification Code' }).locator('input');
    await expect(digitInputs).toHaveCount(6);

    for (let i = 0; i < 6; i++) {
      await digitInputs.nth(i).fill('9');
    }
    await expect(verifyBtn).toBeEnabled();
    await verifyBtn.click();

    // Rejected with invalid OTP message
    await expect(page.getByRole('alert')).toContainText(/incorrect or expired/i);

    // Enter correct 6-digit OTP (123456)
    const validCode = '123456';
    for (let i = 0; i < 6; i++) {
      await digitInputs.nth(i).fill(validCode[i]);
    }

    await verifyBtn.click();

    // Session established and dashboard loaded!
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: 'Welcome, Ravi' })).toBeVisible({ timeout: 60_000 });

    await context.close();
  });

  test('3. CAPTCHA failure/expiry/refresh, single request per double tap, OTP resend with fresh CAPTCHA, phone widths', async () => {
    test.setTimeout(180_000);
    const dir = newProfileDir();
    const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
    const context = await chromium.launchPersistentContext(dir, {
      ...pixel,
      baseURL: `http://localhost:${process.env.E2E_PORT || '4175'}/`,
      geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 },
      permissions: ['geolocation'],
    });
    await net.install(context);
    // Routes registered later take priority over the fake network's.
    let captchaMode = 'fail';
    const counts = { captcha: 0, login: 0, otp: 0 };
    await context.route('**/api/v1/auth/captcha/image', async (route) => {
      counts.captcha += 1;
      if (captchaMode === 'fail') return route.fulfill({ status: 503, body: '' });
      const ttl = captchaMode === 'short' ? 5_500 : 300_000;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="64"><rect width="200" height="64" fill="#eef"/></svg>';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        algorithm: 'TEXT', token: `t${counts.captcha}`, image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, length: 5,
        expires_at: new Date(Date.now() + ttl).toISOString() }) });
    });
    await context.route('**/api/v1/auth/login', async (route) => {
      counts.login += 1;
      await new Promise((r) => setTimeout(r, 800)); // slow server: a second tap lands while the first is pending
      return route.fulfill({ status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid_credentials', message: 'Employee ID or password is incorrect.' } }) });
    });
    await context.route('**/api/v1/auth/otp/request', async (route) => {
      counts.otp += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ expires_in_seconds: 300, resend_after_seconds: 2 }) });
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/#/login');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

    const captcha = page.getByTestId('captcha-verification');
    const signInBtn = page.getByRole('button', { name: 'Sign in' });
    await page.getByLabel('Email').fill(USER_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill('Any-Password-1');

    const code = page.getByLabel('Security code', { exact: true });
    const refresh = captcha.getByRole('button', { name: 'New security code' });
    // Unavailable image: a visible error with a refresh button, never a bypass.
    await expect(captcha).toHaveAttribute('data-status', 'failed');
    await expect(captcha.getByText(/could not be loaded/i)).toBeVisible();
    await expect(signInBtn).toBeDisabled();

    // Refresh to an image that expires: answered, then expired (Sign in disabled again), then a new image.
    captchaMode = 'short';
    await refresh.click();
    await expect(captcha).toHaveAttribute('data-status', 'ready');
    await expect(signInBtn).toBeDisabled(); // nothing typed yet
    await code.fill('12345');
    await expect(signInBtn).toBeEnabled();
    await expect(captcha).toHaveAttribute('data-status', 'expired', { timeout: 10_000 });
    await expect(signInBtn).toBeDisabled();
    captchaMode = 'ok';
    await refresh.click();
    await expect(captcha).toHaveAttribute('data-status', 'ready');
    await code.fill('12345');

    // Double tap: exactly one login request.
    await signInBtn.dblclick();
    await expect(page.getByRole('alert')).toContainText(/incorrect/i);
    expect(counts.login).toBe(1);

    // Screenshots and layout checks at common phone widths, both modes.
    const shots = process.env.LOGIN_SHOTS_DIR;
    for (const width of [360, 375, 390, 412, 430]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(700); // let the card's entry animation settle before measuring
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(captcha).toBeInViewport();
      if (shots) await page.screenshot({ path: `${shots}/password-${width}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: /Log in with Mobile Number/i }).click();
    await expect(captcha).toHaveAttribute('data-status', 'ready');
    await code.fill('12345');
    for (const width of [360, 375, 390, 412, 430]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(700); // let the card's entry animation settle before measuring
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page.getByRole('button', { name: 'Send OTP' })).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/mobile-${width}.png`, fullPage: true });
    }

    // OTP: double tap sends one request; resend needs and gets a fresh CAPTCHA.
    await page.getByPlaceholder('9876543210').fill(USER_MOBILE);
    await page.getByRole('button', { name: 'Send OTP' }).dblclick();
    await expect(page.getByText(`If +91 ${USER_MOBILE} is registered`, { exact: false })).toBeVisible();
    expect(counts.otp).toBe(1);
    if (shots) await page.screenshot({ path: `${shots}/otp-entry.png`, fullPage: true });
    const before = counts.captcha;
    const resend = page.getByRole('button', { name: /Resend OTP/i });
    await expect(resend).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('captcha-verification')).toHaveAttribute('data-status', 'ready');
    expect(counts.captcha).toBeGreaterThan(before);
    await expect(resend).toBeDisabled(); // a resend needs the new code typed
    await code.fill('12345');
    await expect(resend).toBeEnabled();
    await resend.click();
    await expect.poll(() => counts.otp).toBe(2);
    await expect(page.getByText(/Resend code in/i)).toBeVisible();
    expect(await page.getByRole('alert').count()).toBe(0);

    await context.close();
  });
});
