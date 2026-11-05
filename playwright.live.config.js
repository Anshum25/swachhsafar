import { defineConfig } from '@playwright/test';

// Read-only smoke test of a DEPLOYED instance (no build, no fake network, nothing written to the server).
//   LIVE_URL=https://76.13.243.27:8082 HOME=<dir with .pki/nssdb trusting the CA> npx playwright test -c playwright.live.config.js
// Certificate errors are NOT ignored: the browser must trust the server like a phone that installed the CA.
export default defineConfig({
  testDir: 'tests/e2e-live',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
});
