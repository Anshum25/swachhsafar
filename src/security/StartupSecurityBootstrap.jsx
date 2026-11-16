import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { DEFAULT_POLICY, getSharedLocationGuard } from './location.js';
import { nativeSecurity } from './native.js';
import Logo from '../components/Logo.jsx';
import { AlertIcon, CheckIcon, PinIcon, RefreshIcon, Spinner } from '../components/Icons.jsx';
import { SecurityBlockScreen } from './SecurityProvider.jsx';

const noop = () => () => {};

export function StartupSecurityBootstrap({ children, policy = DEFAULT_POLICY }) {
  const guard = getSharedLocationGuard();
  const locState = useSyncExternalStore(guard?.subscribe ?? noop, guard?.getState ?? (() => null));
  const [status, setStatus] = useState('checking'); // 'checking' | 'ready' | 'blocked'
  const [blockCode, setBlockCode] = useState(null);
  const [userPromptNeeded, setUserPromptNeeded] = useState(false);

  const runCheck = useCallback(async () => {
    setStatus('checking');
    setBlockCode(null);
    setUserPromptNeeded(false);

    // Initial check without prompt
    const fix = await guard.refresh();
    const evalResult = guard.evaluate();

    if (evalResult.ok) {
      setStatus('ready');
      return;
    }

    if (evalResult.code === 'location_denied' || evalResult.code === 'location_unavailable' || !fix) {
      if (locState?.permission === 'prompt' || locState?.permission === 'unknown') {
        setUserPromptNeeded(true);
      }
    }

    if (!evalResult.ok && policy.gps_block_app && policy.gps_enforced) {
      setBlockCode(evalResult.code);
      setStatus('blocked');
    } else {
      setStatus('ready');
    }
  }, [guard, locState?.permission, policy.gps_block_app, policy.gps_enforced]);

  useEffect(() => {
    guard.setPolicy(policy);
    let alive = true;
    runCheck().finally(() => {
      // Timeout fallback if browser hangs on geolocation
      if (alive && status === 'checking') {
        const evalResult = guard.evaluate();
        if (evalResult.ok || !policy.gps_block_app) {
          setStatus('ready');
        } else {
          setBlockCode(evalResult.code);
          setStatus('blocked');
        }
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        guard.refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    const resume = nativeSecurity()?.addListener?.('appResume', onVisible);

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      Promise.resolve(resume).then((h) => h?.remove?.()).catch(() => {});
    };
  }, [guard, policy, runCheck]);

  // Request browser permission explicitly on user button click
  const requestPermission = async () => {
    setStatus('checking');
    try {
      await guard.refresh();
      const evalResult = guard.evaluate();
      if (evalResult.ok) {
        setStatus('ready');
      } else {
        setBlockCode(evalResult.code);
        setStatus('blocked');
      }
    } catch {
      setStatus('blocked');
    }
  };

  if (status === 'checking') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-white px-6" role="status" aria-label="Startup Security Check">
        <Logo className="h-16 w-16" />
        <h1 className="mt-4 text-xl font-bold text-ink">Swachh Safar</h1>
        <p className="mt-2 text-center text-sm text-muted">Checking required location services before opening the application...</p>
        <div className="mt-6 flex items-center gap-2 text-sm text-brand-700">
          <Spinner className="h-5 w-5" />
          <span>Acquiring GPS fix...</span>
        </div>
      </div>
    );
  }

  if (status === 'blocked' && policy.gps_block_app) {
    if (userPromptNeeded || blockCode === 'location_denied') {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10" data-testid="startup-location-gate">
          <section className="card w-full max-w-md p-6 text-center shadow-raised" role="alert">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-50 text-brand-600">
              <PinIcon className="h-7 w-7" />
            </span>
            <h1 className="mt-4 text-lg font-bold text-ink">Location Access Required</h1>
            <p className="mt-2 text-sm text-slate-600">
              Swachh Safar policy requires verified device location for all operational railway tasks (attendance, inspections, and feedback).
            </p>
            <div className="mt-6 space-y-3">
              <button
                type="button"
                className="btn-primary w-full h-11"
                onClick={requestPermission}
              >
                Allow Location Access
              </button>
              {nativeSecurity() && (
                <button
                  type="button"
                  className="btn-secondary w-full h-11"
                  onClick={() => guard.openSettings()}
                >
                  Open Location Settings
                </button>
              )}
            </div>
            <p className="mt-4 text-xs text-muted">
              In your browser: tap the lock/info icon in the address bar → Site Settings / Permissions → Location → Allow.
            </p>
          </section>
        </div>
      );
    }

    return (
      <SecurityBlockScreen
        code={blockCode || 'location_unavailable'}
        onRetry={runCheck}
        onSettings={() => guard.openSettings()}
      />
    );
  }

  return children;
}

