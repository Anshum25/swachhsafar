// Security for the signed-in app: starts the location and network guards, runs the start-up check before the
// app opens, publishes the state, and lets screens ask whether an action may run (useSecurityGate).
// Policy values come from the user's division policy (cached on the device, so this works offline).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useResource, useSession } from '../app/session.jsx';
import { DEFAULT_POLICY, createLocationGuard, getSharedLocationGuard } from './location.js';
import { createNetworkGuard } from './network.js';
import { createEventLogger } from './events.js';
import { decide, evidence as buildEvidence } from './policy.js';
import { platform } from './native.js';
import { getDevice } from './device.js';
import { BLOCKS, WARNINGS } from './messages.js';
import Logo from '../components/Logo.jsx';
import { AlertIcon, CheckIcon, InfoIcon, PinIcon, RefreshIcon, Spinner } from '../components/Icons.jsx';
import { nativeSecurity } from './native.js';

// eslint-disable-next-line no-undef
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const SecurityContext = createContext(null);
export const useSecurity = () => useContext(SecurityContext);

const noop = () => () => {};
const useGuard = (guard) => useSyncExternalStore(guard?.subscribe ?? noop, guard?.getState ?? (() => null));

export function SecurityProvider({ children }) {
  const { me, queue, api } = useSession();
  const divisionId = me?.user?.division_id;
  const policyRes = useResource(divisionId ? `/divisions/${divisionId}/policy` : null);
  const policy = useMemo(() => ({ ...DEFAULT_POLICY, ...(policyRes.data ?? {}) }), [policyRes.data]);

  const log = useMemo(() => createEventLogger({ submit: (op) => queue.submit(op) }), [queue]);
  const logRef = useRef(log);
  logRef.current = log;
  const [guards] = useState(() => {
    const onEvent = (type, severity, details) => logRef.current(type, severity, details);
    return { location: getSharedLocationGuard({ onEvent }), network: createNetworkGuard({ api, onEvent }) };
  });
  const location = useGuard(guards.location);
  const network = useGuard(guards.network);
  const [startup, setStartup] = useState(() => {
    const s = guards.location.getState();
    return s?.fix && (Date.now() - (s.fix.timestamp || 0)) / 1000 < (policy.gps_max_age_seconds || 120) ? 'done' : 'checking';
  }); // 'checking' | 'done'
  const [device, setDevice] = useState(null);

  useEffect(() => { guards.location.setPolicy(policy); }, [guards, policy]);
  useEffect(() => { getDevice().then(setDevice); }, []);

  // Start-up check: location and network, bounded by the division's location timeout.
  useEffect(() => {
    let stop = () => {};
    let alive = true;
    guards.network.start().then((s) => { stop = s; });
    const limit = setTimeout(() => alive && setStartup('done'), (policy.gps_timeout_seconds + 2) * 1000);
    guards.location.refresh().finally(() => { if (alive) setStartup('done'); clearTimeout(limit); });
    // Re-check when the app comes back to the foreground (location may have been switched off meanwhile).
    const onVisible = () => { if (document.visibilityState === 'visible') { guards.location.refresh(); guards.network.refresh(); } };
    document.addEventListener('visibilitychange', onVisible);
    const resume = nativeSecurity()?.addListener?.('appResume', onVisible);
    return () => {
      alive = false;
      clearTimeout(limit);
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      Promise.resolve(resume).then((h) => h?.remove?.()).catch(() => {});
    };
  }, [guards]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchedAt = me?.fetched_at ? Date.parse(me.fetched_at) : null;
  // The backend-signed lease (validated in session.jsx) is authoritative; the fetched_at age is only a
  // secondary cap so a missing lease can never extend offline use past the policy period.
  const offlineExpired = !!(me?.offline && (me.offlineExpired || !me.offlineLease
    || (fetchedAt && Date.now() - fetchedAt > Math.min(24, policy.offline_session_hours) * 3_600_000)));
  useEffect(() => { if (offlineExpired) log('session.offline_expired', 'warning', { hours: policy.offline_session_hours }); }, [offlineExpired, log, policy.offline_session_hours]);

  const ctx = useMemo(() => ({ policy, location: guards.location, network, platform: platform() }), [policy, guards.location, network]);
  const decideAction = useCallback((action) => decide(action, { ...ctx, session: { offlineExpired } }), [ctx, offlineExpired]);
  const refreshAll = useCallback(async () => {
    await Promise.all([guards.location.refresh(), guards.network.refresh()]);
  }, [guards]);

  const value = useMemo(() => ({
    policy, location, network, device, offlineExpired, startup, guards, log,
    decide: decideAction,
    refresh: refreshAll,
    evidence: (opts = {}) => buildEvidence({ location: guards.location, network, platform: platform(), appVersion: APP_VERSION, ...opts }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [policy, location, network, device, offlineExpired, startup, guards, log, decideAction, refreshAll]);

  const app = decideAction('app');
  let screen = children;
  if (startup === 'checking' && policy.gps_enforced) screen = <StartupCheck location={location} network={network} />;
  else if (!app.allowed) screen = <SecurityBlockScreen code={app.blockers[0]} onRetry={refreshAll} onSettings={() => guards.location.openSettings()} />;
  return <SecurityContext.Provider value={value}>{screen}</SecurityContext.Provider>;
}

// For a capture screen: whether `action` may run now, the notice to show, and the evidence to attach.
export function useSecurityGate(action) {
  const sec = useSecurity();
  if (!sec) return { allowed: true, decision: { allowed: true, blockers: [], warnings: [] }, notice: null, evidence: () => ({}) };
  const decision = sec.decide(action);
  return {
    allowed: decision.allowed,
    decision,
    notice: <SecurityNotice decision={decision} onRetry={sec.refresh} onSettings={() => sec.guards.location.openSettings()} />,
    evidence: (opts) => sec.evidence({ ...opts, decision }),
  };
}

const LOCATION_PENDING = new Set(['location_pending']);

// Inline notice in a capture dialog: the first blocker as a short explanation with a retry; warnings below.
export function SecurityNotice({ decision, onRetry, onSettings }) {
  const [busy, setBusy] = useState(false);
  if (decision.allowed && !decision.warnings.length) return null;
  const code = decision.blockers[0];
  const b = code ? BLOCKS[code] : null;
  const retry = async () => { setBusy(true); await onRetry(); setBusy(false); };
  return (
    <div className="space-y-2" data-testid="security-notice" data-code={code ?? 'ok'}>
      {b && (
        <div className={`rounded-xl px-3 py-2.5 text-sm ring-1 ${LOCATION_PENDING.has(code) ? 'bg-brand-50 text-brand-900 ring-brand-200' : 'bg-red-50 text-red-900 ring-red-200'}`} role="alert">
          <p className="flex items-center gap-2 font-semibold"><AlertIcon className="h-4 w-4 shrink-0" />{b.title}</p>
          <p className="mt-1">{b.next}</p>
          {b.retry && (
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-secondary h-9" onClick={retry} disabled={busy}>{busy ? <Spinner /> : <RefreshIcon />} Check again</button>
              {b.action === 'settings' && nativeSecurity() && <button type="button" className="btn-secondary h-9" onClick={onSettings}>Open settings</button>}
            </div>
          )}
        </div>
      )}
      {decision.warnings.filter((w) => w !== 'vpn_unknown').map((w) => (
        <p key={w} className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200"><InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />{WARNINGS[w]}</p>
      ))}
    </div>
  );
}

function StartupCheck({ location, network }) {
  const row = (label, state) => (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-ink">{label}</span>
      {state === 'ok' ? <CheckIcon className="h-4 w-4 text-success" /> : state === 'checking' ? <Spinner className="h-4 w-4 text-brand-600" /> : <span className="text-xs text-muted">{state}</span>}
    </li>
  );
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-white px-6" role="status" aria-label="Security check">
      <Logo className="h-16 w-16" />
      <h1 className="mt-3 text-xl font-bold text-ink">Security check</h1>
      <p className="mt-1 max-w-xs text-center text-sm text-muted">Confirming this device’s location and network before opening Swachh Safar.</p>
      <ul className="mt-5 w-full max-w-xs divide-y divide-line rounded-2xl bg-canvas px-4 py-1">
        {row('Location', location.fix ? 'ok' : location.error ? 'not available' : 'checking')}
        {row('Network', network.checkedAt ? (network.vpn ? 'VPN on' : 'ok') : 'checking')}
      </ul>
    </div>
  );
}

// Full-screen blocking state (start-up and session problems).
export function SecurityBlockScreen({ code, onRetry, onSettings, onSignIn }) {
  const b = BLOCKS[code] ?? { title: 'Access is blocked', what: code, why: '', next: 'Try again or contact your administrator.', retry: true, action: 'retry' };
  const [busy, setBusy] = useState(false);
  const retry = async () => { setBusy(true); try { await onRetry?.(); } finally { setBusy(false); } };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10" data-testid="security-block" data-code={code}>
      <section className="card w-full max-w-md p-6 text-center shadow-raised" role="alert">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-red-50 text-red-600"><PinIcon className="h-7 w-7" /></span>
        <h1 className="mt-3 text-lg font-bold text-ink">{b.title}</h1>
        <dl className="mt-4 space-y-3 text-left text-sm">
          <div><dt className="font-semibold text-ink">What happened</dt><dd className="text-slate-600">{b.what}</dd></div>
          {b.why && <div><dt className="font-semibold text-ink">Why it matters</dt><dd className="text-slate-600">{b.why}</dd></div>}
          <div><dt className="font-semibold text-ink">What to do</dt><dd className="text-slate-600">{b.next}</dd></div>
        </dl>
        <div className="mt-5 grid gap-2">
          {b.retry && onRetry && <button type="button" className="btn-primary w-full" onClick={retry} disabled={busy}>{busy ? <Spinner /> : <RefreshIcon />} Check again</button>}
          {b.action === 'settings' && nativeSecurity() && onSettings && <button type="button" className="btn-secondary h-11 w-full" onClick={onSettings}>Open location settings</button>}
          {b.action === 'signin' && onSignIn && <button type="button" className="btn-primary w-full" onClick={onSignIn}>Sign in again</button>}
          {!b.retry && b.action !== 'signin' && <p className="text-xs text-muted">Retrying will not help until this is resolved.</p>}
        </div>
      </section>
    </div>
  );
}
