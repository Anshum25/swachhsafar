// Keeps the Android app closed while Developer options are on. Checked at start and whenever the app returns
// to the foreground, so turning the setting off and coming back opens the app.
import { useCallback, useEffect, useState } from 'react';
import Logo from '../components/Logo.jsx';
import { AlertIcon, RefreshIcon } from '../components/Icons.jsx';
import { nativeSecurity } from './native.js';
import { checkDeveloperMode } from './developerMode.js';

export default function DeveloperModeGate({ children }) {
  const [state, setState] = useState({ checked: !nativeSecurity(), developerMode: false });
  const check = useCallback(async () => {
    const r = await checkDeveloperMode(nativeSecurity());
    setState({ checked: true, developerMode: r.developerMode });
  }, []);

  useEffect(() => {
    if (!nativeSecurity()) return undefined;
    check();
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    const resume = nativeSecurity()?.addListener?.('appResume', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      Promise.resolve(resume).then((h) => h?.remove?.()).catch(() => {});
    };
  }, [check]);

  if (!state.checked) return null;
  if (!state.developerMode) return children;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10" data-testid="developer-mode-gate">
      <section className="card w-full max-w-md p-6 text-center" role="alert">
        <Logo className="mx-auto h-14 w-14" />
        <span className="mx-auto mt-4 grid h-12 w-12 place-items-center rounded-full bg-red-50 text-red-600"><AlertIcon className="h-6 w-6" /></span>
        <h1 className="mt-3 text-lg font-bold text-slate-900">Please turn off Developer mode</h1>
        <p className="mt-2 text-sm text-slate-600">
          Swachh Safar cannot open while Developer options are on, to protect attendance and location records.
          Go to <b>Settings → System → Developer options</b> and switch it <b>off</b>, then return to the app.
        </p>
        <div className="mt-6 space-y-3">
          {nativeSecurity()?.openDeveloperSettings && (
            <button type="button" className="btn-primary h-11 w-full" onClick={() => nativeSecurity().openDeveloperSettings()}>Open Developer options</button>
          )}
          <button type="button" className="btn-secondary h-11 w-full justify-center" onClick={check}><RefreshIcon /> Check again</button>
        </div>
      </section>
    </div>
  );
}
