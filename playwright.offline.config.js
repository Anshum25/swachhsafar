import { defineConfig } from '@playwright/test';

// Offline end-to-end tests of the operational screens against a production build (real OPFS SQLite,
// real service worker). Every Google API and /api/v1 request (sign-in included) is answered inside the
// browser by the test, so nothing reaches a real backend.
const BUILD_ENV = [
  'VITE_DEMO_MODE=false',
  // The commit the build claims to be made from; the Android app compares it with the published release.
  `VITE_BUILD_SHA=${'e2e'.padEnd(40, '0')}`,
].join(' ');
// The preview server sends the production security headers (deploy/nginx/security-headers.conf).
const PREVIEW_ENV = 'PREVIEW_SECURITY_HEADERS=1';

const E2E_PORT = process.env.E2E_PORT || '4175';

export default defineConfig({
  testDir: 'tests/e2e-offline',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  webServer: {
    command: `npx cross-env ${BUILD_ENV} vite build --outDir dist-e2e --emptyOutDir && npx cross-env ${PREVIEW_ENV} vite preview --outDir dist-e2e --port ${E2E_PORT} --strictPort`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
