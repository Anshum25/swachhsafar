// Installed-app UI: the install banner, the "new version" banner, and the Android app's own update notice.
import { useEffect, useState } from 'react';
import { useQueueState } from '../app/session.jsx';
import { dismissInstall, installDismissed, installInstructions, isStandalone, promptInstall, pwa, usePwa } from '../pwa/pwaState.js';
import { checkAppUpdate } from '../pwa/appUpdate.js';
import { applyBundleUpdate, checkBundleUpdate } from '../pwa/bundleUpdate.js';
import { isNativeApp } from '../security/native.js';

// Shown at most once per 30 days while the app is not installed: an Install button when the browser
// offers installation (Chrome / Edge on Android), otherwise how to install from this browser's menu.
// The written hint waits a few seconds, because Chrome may fire beforeinstallprompt after the first render.
export function InstallBanner() {
  const { installEvent, installed } = usePwa();
  const [hidden, setHidden] = useState(installDismissed);
  const [hintDue, setHintDue] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHintDue(true), 6000);
    return () => clearTimeout(t);
  }, []);
  // Inside the Android app there is nothing to install: it is already the installed app.
  if (hidden || installed || isStandalone() || isNativeApp()) return null;
  if (!installEvent) {
    const hint = hintDue && installInstructions();
    if (!hint) return null;
    return (
      <div className="flex flex-wrap items-center gap-3 bg-brand-700 px-4 py-2 text-sm text-white sm:px-6" role="region" aria-label="Install app" data-testid="install-hint">
        <span className="min-w-0 flex-1"><span className="font-semibold">Install the app.</span> {hint}</span>
        <button type="button" className="text-white/80 underline" onClick={() => { dismissInstall(); setHidden(true); }}>Got it</button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 bg-brand-700 px-4 py-2 text-sm text-white sm:px-6" role="region" aria-label="Install app" data-testid="install-banner">
      <span className="min-w-0 flex-1">Install Swachh Safar for full-screen use and offline start.</span>
      <button type="button" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-brand-800" onClick={promptInstall}>Install</button>
      <button type="button" className="text-white/80 underline" onClick={() => { dismissInstall(); setHidden(true); }}>Not now</button>
    </div>
  );
}

export function UpdateBanner() {
  const { updateReady } = usePwa();
  const { pending } = useQueueState();
  if (!updateReady) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-sky-700 px-4 py-2 text-sm text-white sm:px-6" role="status" data-testid="update-banner">
      <span className="flex-1">
        A new version of Swachh Safar is ready. {pending ? `Your ${pending} unsynced record(s) are stored on this device and are kept.` : ''} Save any open form first.
      </span>
      <button type="button" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-sky-800" onClick={pwa.update}>Update now</button>
    </div>
  );
}

// Android app only: is a newer web bundle published? This is the usual way the app changes now -- screens,
// logic and fixes all live in the bundle -- so it is asked first, and the APK question below only matters
// for the few releases that change native code.
//
// The download runs by itself, in the background, and the bundle is staged for the next cold start: no
// prompt, nothing to agree to, and nothing reloads while a form is open. The banner appears only once a
// bundle is ready, and says what will happen rather than asking for permission to do it.
function useBundleUpdate() {
  const [state, setState] = useState(null);   // { bundleId, version } once staged
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    let cancelled = false;
    const look = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const update = await checkBundleUpdate();
      if (cancelled || !update) return;
      const result = await applyBundleUpdate(update);
      // `immediate` means the updater has already reloaded the WebView, so there is nothing to announce.
      if (!cancelled && result.applied && !result.immediate) {
        setState({ bundleId: update.bundleId, version: update.version });
      }
    };
    look();
    window.addEventListener('online', look);
    return () => {
      cancelled = true;
      window.removeEventListener('online', look);
    };
  }, []);
  return state;
}

export function BundleUpdateBanner() {
  const staged = useBundleUpdate();
  const { pending } = useQueueState();
  if (!staged) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-sky-700 px-4 py-2 text-sm text-white sm:px-6" role="status" data-testid="bundle-update-banner">
      <span className="flex-1">
        Swachh Safar {staged.version} is downloaded and starts the next time you open the app.
        {pending ? ` Your ${pending} unsynced record(s) are stored on this device and are kept.` : ''}
      </span>
    </div>
  );
}

// Android app only: is a newer APK published? Asked on start and again whenever the device comes back
// online. Offline, or in the browser, there is nothing to ask and nothing is shown.
//
// Since web bundles ship over the air, this is now only for a release that changes native code -- a new
// plugin method, a permission, a Capacitor upgrade. The server withholds a bundle that needs an APK the
// phone does not have (min_native_version), so what is left for this banner is exactly that case.
function useAppUpdate() {
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    let cancelled = false;
    const look = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      checkAppUpdate().then((u) => !cancelled && u.available && setUpdate(u));
    };
    look();
    window.addEventListener('online', look);
    return () => {
      cancelled = true;
      window.removeEventListener('online', look);
    };
  }, []);
  return update;
}

// "Download" opens the server's download link, which installs over this app. Records live in the app's own
// storage and are kept across the update.
// The build id is named here and under the menu, so "is the one I installed the one being offered?" is a
// question that can be answered by looking, rather than by installing again and hoping.
const updateText = (update) => {
  const what = [update.version, update.build].filter(Boolean).join(' · ');
  return `New version available${what ? ` (${what})` : ''}. Records stored on this phone are kept.`;
};

export function AppUpdateBanner() {
  const update = useAppUpdate();
  if (!update) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-sky-700 px-4 py-2 text-sm text-white sm:px-6" role="status" data-testid="apk-update-banner">
      <span className="flex-1">{updateText(update)}</span>
      <a href={update.url} className="rounded-lg bg-white px-3 py-1.5 font-semibold text-sky-800">Download</a>
    </div>
  );
}

// Signed-out variant (login screen): no queue context is needed, and there is no open form to lose.
// Without it, a device holding an older cached login screen is never told that a newer one is ready.
export function LoginUpdateBanner() {
  const { updateReady } = usePwa();
  const appUpdate = useAppUpdate();
  // The Android app is updated by installing a newer APK, not by the service worker: before sign-in is
  // where a phone that has been offline for a while first sees it.
  if (appUpdate) {
    return (
      <div className="relative z-20 mb-3 flex w-full max-w-md items-center gap-3 rounded-2xl bg-sky-700 px-4 py-2.5 text-sm text-white shadow" role="status" data-testid="apk-update-banner">
        <span className="flex-1">{updateText(appUpdate)}</span>
        <a href={appUpdate.url} className="rounded-lg bg-white px-3 py-1.5 font-semibold text-sky-800">Download</a>
      </div>
    );
  }
  if (!updateReady) return null;
  return (
    <div className="relative z-20 mb-3 flex w-full max-w-md items-center gap-3 rounded-2xl bg-sky-700 px-4 py-2.5 text-sm text-white shadow" role="status" data-testid="update-banner">
      <span className="flex-1">A new version of Swachh Safar is ready.</span>
      <button type="button" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-sky-800" onClick={pwa.update}>Update now</button>
    </div>
  );
}
