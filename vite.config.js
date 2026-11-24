import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

// OPFS and Web Crypto only exist in secure contexts, so LAN devices must use HTTPS.
// Certificate from mkcert (gitignored): mkcert -cert-file .cert/dev-cert.pem -key-file .cert/dev-key.pem <LAN IP> localhost
const certFile = '.cert/dev-cert.pem';
const keyFile = '.cert/dev-key.pem';
const https = existsSync(certFile) && existsSync(keyFile)
  ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
  : undefined;

// Production security headers (CSP etc.) live in one nginx snippet. With PREVIEW_SECURITY_HEADERS=1 the
// preview server sends the same headers, so e2e tests exercise the build under the production CSP.
export function readSecurityHeaders(file = 'deploy/nginx/security-headers.conf') {
  const headers = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;\s*$/);
    if (m) headers[m[1]] = m[2];
  }
  return headers;
}
const previewHeaders = process.env.PREVIEW_SECURITY_HEADERS ? readSecurityHeaders() : undefined;

const APP_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;

// The commit this bundle is built from. CI passes it (VITE_BUILD_SHA = github.sha); the Android app compares
// it with the published release to offer a newer APK (src/pwa/appUpdate.js). Empty in a local build.
const BUILD_SHA = process.env.VITE_BUILD_SHA ?? '';

// Face verification models (MIT, @vladmandic/face-api), copied from the package into public/models/face/ so
// they are served and precached with the app (offline matching). Not committed: public/models/ is ignored.
// ssd_mobilenetv1_model: the thorough detector the group photo is read with (src/face/faceEngine.js).
const FACE_MODELS = ['tiny_face_detector_model', 'ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model'];
function faceModels() {
  const copy = () => {
    const src = 'node_modules/@vladmandic/face-api/model';
    const dst = 'public/models/face';
    mkdirSync(dst, { recursive: true });
    for (const m of FACE_MODELS) {
      for (const f of [`${m}.bin`, `${m}-weights_manifest.json`]) {
        if (!existsSync(`${dst}/${f}`)) copyFileSync(`${src}/${f}`, `${dst}/${f}`);
      }
    }
  };
  return { name: 'swachh-face-models', config: copy };
}

export default defineConfig(({ isPreview }) => ({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __BUILD_SHA__: JSON.stringify(BUILD_SHA) },
  plugins: [
    faceModels(),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'serviceWorker.js',
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,wasm,json,webmanifest,woff2,bin}'],
        // The face recognition model is 6.4 MB.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        id: '/',
        name: 'Swachh Safar 2.0',
        short_name: 'Swachh Safar',
        description: 'Swachh Safar on-board cleanliness operations: attendance, inspections, feedback, complaints and inventory, offline first.',
        lang: 'en-IN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Phones are used in portrait; tablets and landscape-locked devices keep working.
        orientation: 'any',
        categories: ['business', 'productivity'],
        prefers_related_applications: false,
        background_color: '#f3f7fe',
        theme_color: '#1d4ed8',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // Preview falls back to these server options, so they only apply to the dev server.
  // E2E runs preview on plain http://localhost; `npm run preview:lan` serves the build over HTTPS.
  // /api is forwarded to the FastAPI backend (override with API_PROXY_TARGET); production sets VITE_API_BASE_URL.
  server: isPreview ? {} : { host: true, port: 5173, strictPort: true, https, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' } },
  preview: { ...(process.env.PREVIEW_HTTPS ? { https } : {}), headers: previewHeaders, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' } },
  worker: { format: 'es' },
  // sqlite-wasm loads its .wasm via import.meta.url; pre-bundling would break that path.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    testTimeout: 60_000,
  },
}));
