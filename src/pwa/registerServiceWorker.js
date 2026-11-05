// Registers the service worker built from src/pwa/serviceWorker.js (production builds only).
//
// Updates are prompted, not forced: a new version waits until the user taps "Update" (pwa.update), so a
// running page never has its lazily-loaded screens removed from the cache underneath it.
import { registerSW } from 'virtual:pwa-register';
import { pwa } from './pwaState.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
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
  pwa.setUpdater(update);
}
