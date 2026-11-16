// Share page: https://ehk.itfarmer.in/install. Installs the app on this phone (Chrome's install prompt where
// offered, otherwise how to do it from this browser's menu), then opens it. Needs no sign-in.
import { useEffect, useState } from 'react';
import Logo, { TrainArt } from '../components/Logo.jsx';
import { CheckIcon } from '../components/Icons.jsx';
import { installInstructions, isAndroid, isStandalone, promptInstall, usePwa } from '../pwa/pwaState.js';

const openApp = () => { window.location.href = '/#/'; };

export default function Install() {
  const { installEvent, installed } = usePwa();
  const [waited, setWaited] = useState(false);
  const [outcome, setOutcome] = useState(null);
  // Chrome may offer installation a few seconds after the page loads.
  useEffect(() => { const t = setTimeout(() => setWaited(true), 4000); return () => clearTimeout(t); }, []);
  const standalone = isStandalone();
  const done = installed || outcome === 'accepted';
  const ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <div className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-gradient-to-b from-white via-brand-50 to-brand-100 px-5 pb-40 pt-12 text-center">
      <Logo className="h-24 w-24" />
      <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-brand-800">Swachh Safar</h1>
      <p className="mt-1 text-base text-slate-600">Railway Inspection &amp; Monitoring System</p>

      <div className="mt-8 w-full max-w-sm space-y-4 rounded-3xl bg-white p-5 text-left shadow-[0_8px_30px_rgba(29,78,216,0.12)] ring-1 ring-brand-100">
        {standalone ? (
          <>
            <p className="flex items-center gap-2 text-base font-semibold text-emerald-700"><CheckIcon className="h-5 w-5" /> The app is installed.</p>
            <button type="button" className="btn-primary w-full" onClick={openApp}>Open Swachh Safar</button>
          </>
        ) : done ? (
          <>
            <p className="flex items-center gap-2 text-base font-semibold text-emerald-700"><CheckIcon className="h-5 w-5" /> Installed.</p>
            <p className="text-sm text-slate-600">Open <b>Swachh Safar</b> from your home screen or app drawer and sign in.</p>
          </>
        ) : installEvent ? (
          <>
            <p className="text-sm text-slate-600">Install the app on this phone. It opens full screen and works without internet after the first sign-in.</p>
            <button type="button" className="btn-primary w-full text-lg" data-testid="install-app"
              onClick={async () => setOutcome(await promptInstall())}>Install App</button>
            {outcome === 'dismissed' && <p className="text-xs text-slate-500">Not installed. Tap Install App to try again.</p>}
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-slate-800">{waited ? 'How to install' : 'Getting the app ready…'}</p>
            {waited && (
              <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
                {isAndroid() && <li>If this page opened inside WhatsApp or another app, tap <b>⋮</b> and choose <b>Open in Chrome</b>.</li>}
                <li>{installInstructions()}</li>
                <li>Open <b>Swachh Safar</b> from your home screen and sign in.</li>
              </ol>
            )}
            {ios && waited && <p className="text-xs text-slate-500">On iPhone, use Safari for installation (Share → Add to Home Screen).</p>}
          </>
        )}
        {isAndroid() && !standalone && (
          <div className="pt-2 border-t border-slate-100">
            <p className="text-xs text-slate-500 mb-2">Prefer the native Android application?</p>
            <a href="/download" className="btn-secondary w-full text-center block text-sm font-semibold">
              Get the Android app (APK)
            </a>
          </div>
        )}
        {!standalone && (
          <a href="/#/login" className="block text-center text-sm font-semibold text-brand-700 underline-offset-2 hover:underline">Continue in the browser instead</a>
        )}
      </div>
      <TrainArt className="pointer-events-none absolute bottom-6 left-1/2 h-24 w-auto -translate-x-1/2 opacity-90" />
    </div>
  );
}
