// Installed-app UI: the install banner and the "new version" banner.
import { useEffect, useState } from 'react';
import { useQueueState } from '../app/session.jsx';
import { dismissInstall, installDismissed, installInstructions, isStandalone, promptInstall, pwa, usePwa } from '../pwa/pwaState.js';

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
  if (hidden || installed || isStandalone()) return null;
  if (!installEvent) {
    const hint = hintDue && installInstructions();
    if (!hint) return null;
    return (
      <div className="flex flex-wrap items-center gap-3 bg-teal-700 px-4 py-2 text-sm text-white sm:px-6" role="region" aria-label="Install app" data-testid="install-hint">
        <span className="min-w-0 flex-1"><span className="font-semibold">Install the app.</span> {hint}</span>
        <button type="button" className="text-white/80 underline" onClick={() => { dismissInstall(); setHidden(true); }}>Got it</button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 bg-teal-700 px-4 py-2 text-sm text-white sm:px-6" role="region" aria-label="Install app" data-testid="install-banner">
      <span className="min-w-0 flex-1">Install Swachh Safar for full-screen use and offline start.</span>
      <button type="button" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-teal-800" onClick={promptInstall}>Install</button>
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
