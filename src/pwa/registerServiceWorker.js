// Registers the service worker built from src/pwa/serviceWorker.js (production builds only).
//
// Updates are prompted, not forced: a new version waits until the user taps "Update" (pwa.update), so a
// running page never has its lazily-loaded screens removed from the cache underneath it.
//
// Not registered inside the Android app: there the whole build is packaged in the APK and served from
// https://localhost by the WebView, so there is nothing for a service worker to cache and no new version to
// fetch — the app is updated by installing a newer APK (src/pwa/appUpdate.js).
import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from '../security/native.js';
import { pwa } from './pwaState.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV || isNativeApp()) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => pwa.needRefresh(),
    onOfflineReady: () => pwa.offlineReady(),
    // Installed PWAs can stay open for days and are mostly resumed from the background rather than
    // relaunched: look for a new version hourly, and on resume when the last check is over 15 min old.
    onRegisteredSW(url, registration) {
      if (!registration) return;
      let lastCheck = Date.now();
      const check = () => {
        if (!navigator.onLine || registration.installing) return;
        lastCheck = Date.now();
        registration.update().catch(() => {});
      };
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > 15 * 60 * 1000) check();
      });
    },
  });
  // Reload as soon as the new version controls the page. vite-plugin-pwa reloads only when workbox-window's
  // `isUpdate` is true, and that is fixed at page load as "a controller existed then". In the first session
  // after installation there was none, so "Update now" would activate the new worker (whose precache
  // cleanup drops this page's lazily-loaded chunks) without ever reloading. Data is in OPFS, so it is safe.
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
