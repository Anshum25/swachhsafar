// "Clear cache" on this device: removes the app's cached files (Cache Storage: the service worker's precache
// and runtime caches) and unregisters the service worker, then reloads so the newest version is fetched
// fresh from the server.
//
// Deliberately NOT touched: the SQLite database in OPFS (records captured on this device, including ones not
// yet synced), localStorage (the sign-in and device settings), sessionStorage (form drafts) and IndexedDB. Clearing those would lose work,
// so "clear cache" can never cost a record.
//
// Needs the network: without it the app could not load its files again after the cache is gone.
export async function clearAppCache({ win = globalThis, reload = true } = {}) {
  const result = { caches: 0, workers: 0 };
  if (win.navigator?.onLine === false) {
    throw new Error('Connect to the internet first: the app downloads its files again after the cache is cleared.');
  }
  if (win.caches?.keys) {
    const keys = await win.caches.keys();
    await Promise.all(keys.map((k) => win.caches.delete(k)));
    result.caches = keys.length;
  }
  if (win.navigator?.serviceWorker?.getRegistrations) {
    const regs = await win.navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    result.workers = regs.length;
  }
  // sessionStorage is left alone too: it holds unsent form drafts (Feedback).
  if (reload) win.location.reload();
  return result;
}
