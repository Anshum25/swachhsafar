// Registers the service worker built from src/pwa/serviceWorker.js (production builds only).
//
// Updates apply by themselves (freshStart.js): a new version found when the app has just been opened loads at
// once; one found while someone is working waits, already downloaded, and loads the next time the app is
// opened (or resumed after a long time away). Nobody is asked, and nothing is swapped under an open form.
//
// Not registered inside the Android app: there the whole build is packaged in the APK and served from
// https://localhost by the WebView; it updates over the air instead (src/pwa/bundleUpdate.js).
import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from '../security/native.js';
import { pwa } from './pwaState.js';
import { applyWhenFresh, watchFreshStart } from './freshStart.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV || isNativeApp()) return;
  watchFreshStart();
  let waiting = false;
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => {
      pwa.needRefresh();
      if (waiting) return;
      waiting = true;
      applyWhenFresh(() => pwa.update());
    },
    onOfflineReady: () => pwa.offlineReady(),
    // Look for a new version straight away on every start, then hourly, and on resume when the last check is
    // over 15 minutes old: installed apps are mostly resumed from the background rather than relaunched.
    onRegisteredSW(url, registration) {
      if (!registration) return;
      let lastCheck = 0;
      const check = () => {
        if (!navigator.onLine || registration.installing) return;
        lastCheck = Date.now();
        registration.update().catch(() => {});
      };
      check();
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > 15 * 60 * 1000) check();
      });
    },
  });
  // Reload as soon as the new version controls the page. vite-plugin-pwa reloads only when workbox-window's
  // `isUpdate` is true, and that is fixed at page load as "a controller existed then". In the first session
  // after installation there was none, so activating the new worker (whose precache cleanup drops this page's
  // lazily-loaded chunks) would never reload. Data is in OPFS, so it is safe.
  pwa.setUpdater(() => {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    return update(true);
  });
}
