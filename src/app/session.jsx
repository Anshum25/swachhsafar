// Signed-in session for the operational app: the backend session token (src/security/authToken.js), the
// profile from GET /auth/me (role + per-division permissions), the API client and the offline operations queue.
// Sign-in is entirely our own backend's (PostgreSQL); no third-party identity provider is involved.
//
// Data access is local-first (demo mode off): one localStore over the device SQLite database backs
// both the operations queue (captures are saved locally, then synced) and the local-first API (reads
// fall back to SQLite when the server is unreachable). Demo mode uses sample GET data only and never
// writes demo records into the operational database.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createApiClient, API_BASE } from '../services/apiClient.js';
import { createOperationsQueue } from '../services/operationsQueue.js';
import { createLocalStore } from '../services/localStore.js';
import { createLocalApi } from '../services/localApi.js';
import { createLocalFirstApi, responseCacheKey } from '../services/localFirstApi.js';
import { createOperations } from '../services/operations.js';
import { DEMO_ME, DEMO_MODE, createDemoApi } from '../services/demoApi.js';
import { createOutboxRepository } from '../database/outboxRepository.js';
import { isOnline, subscribeConnectivity, subscribeForeground } from '../services/connectivityService.js';
import { solveCaptcha } from '../security/captcha.js';
import { getDevice } from '../security/device.js';
import { getCachedLease, saveCachedLease, validateOfflineLease } from '../security/lease.js';
import { refillTickets } from '../face/livenessTickets.js';
import { clearToken, getAuth, getToken as storedToken, saveAccount, saveToken, subscribeAuth } from '../security/authToken.js';

const SessionContext = createContext(null);
const LEGACY_ME_CACHE_KEY = 'session_me'; // Phase 1 cache; migrated into authorization_snapshots (v3)
const DEMO_CAPTURE_REASON = 'Demo mode: records are not saved. Turn off VITE_DEMO_MODE to capture real data.';

export const ROLE_NAMES = { 1: 'Super Admin', 2: 'Admin', 3: 'Manager', 4: 'Supervisor/EHK', 5: 'Janitor', 6: 'Contractor' };

// The signed-in account as the rest of the app sees it: null when signed out.
const accountFromAuth = (auth) => (auth
  ? { token: auth.token, uid: auth.account?.userId ?? null, userId: auth.account?.userId ?? null, email: auth.account?.email ?? null, empId: auth.account?.empId ?? null }
  : null);

async function postJson(path, body, fallback) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the Swachh Safar server. Check the connection.'), { code: 'network_error', status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message || fallback.message), { code: data?.error?.code || fallback.code, status: res.status });
  }
  return data;
}

export function SessionProvider({ db, files, children }) {
  // Demo mode: no sign-in or /auth/me; a fixed admin profile and sample GET data.
  const [account, setAccount] = useState(() => (DEMO_MODE ? { email: DEMO_ME.user.email } : accountFromAuth(getAuth())));
  const [me, setMe] = useState(DEMO_MODE ? DEMO_ME : null);
  const [meError, setMeError] = useState(null);
  const configError = null;
  const outbox = useMemo(() => createOutboxRepository(db), [db]);
  const store = useMemo(() => createLocalStore({ db, files }), [db, files]);
  const meRef = useRef(me);
  meRef.current = me;
  const sessionIdRef = useRef(null);

  // Sign-in and sign-out (also from another tab) change the stored token; the session follows it. Only a
  // change of token (or signing out) re-resolves the session, not the account details filled in by /auth/me.
  useEffect(() => {
    if (DEMO_MODE) return undefined;
    let lastToken = storedToken();
    const sync = (auth) => {
      if ((auth?.token ?? null) === lastToken) return;
      lastToken = auth?.token ?? null;
      setAccount(accountFromAuth(auth));
    };
    const onStorage = (e) => { if (e.key === null || e.key === 'swachh_auth_v1') sync(getAuth()); };
    const off = subscribeAuth(sync);
    globalThis.addEventListener?.('storage', onStorage);
    return () => {
      off();
      globalThis.removeEventListener?.('storage', onStorage);
    };
  }, []);

  // Reads the bearer token this device holds; null when there is none. It cannot throw -- authToken.js
  // wraps the storage access and falls back to memory -- which is what the sync queue needs, because it
  // has to tell "no token" apart from a crash.
  //
  // This replaces a Firebase getIdToken() call that could reject (a revoked refresh token, a deleted
  // account, no network), and did: the rejection escaped the queue's try blocks, so sync went inert in
  // silence while the status bar kept showing a stale error from the last pull that had run. The queue
  // still guards the call and still reports `authRequired`, because a token can now be absent or revoked
  // server-side just as easily -- the failure is gone, the thing it taught us to report is not.
  const getToken = useCallback(async () => storedToken(), []);

  const remote = useMemo(() => (DEMO_MODE ? null : createApiClient({ getToken })), [getToken]);

  const api = useMemo(() => {
    if (DEMO_MODE) return createDemoApi();
    const getContext = () => {
      const current = meRef.current;
      return { userId: current?.user?.id ?? null, permissions: current?.divisions ?? {} };
    };
    return createLocalFirstApi({ remote, local: createLocalApi({ store, getContext }), store, isOnline, getContext });
  }, [remote, store]);
  const ops = useMemo(() => createOperations(api), [api]);

  const queue = useMemo(
    () => createOperationsQueue({
      db, store, isOnline,
      getApi: async () => (!DEMO_MODE && (await getToken()) ? remote : null),
      getActor: () => {
        const current = meRef.current;
        // `modules`: the client's subscription, so a capture for a module the office does not pay for is
        // refused here and now rather than at the next sync (src/services/authorization.js).
        return current
          ? {
            actor: { id: current.user.id, permissions: current.divisions, modules: current.client?.modules ?? null },
            divisions: Object.keys(current.divisions),
          }
          : null;
      },
      captureDisabledReason: DEMO_MODE ? DEMO_CAPTURE_REASON : null,
    }),
    [db, store, remote, getToken],
  );

  const cachedAuthorization = useCallback(async ({ userId, email } = {}) => {
    const snapshot = (await store.identity.findSnapshotByUserId(userId).catch(() => null))
      ?? await store.identity.findSnapshotByEmail(email).catch(() => null);
    if (snapshot) return snapshot;
    const legacy = await outbox.getMeta(LEGACY_ME_CACHE_KEY).catch(() => null);
    const parsed = legacy ? JSON.parse(legacy) : null;
    return parsed?.user?.email?.toLowerCase() === email?.toLowerCase() ? parsed : null;
  }, [store, outbox]);

  const loadMe = useCallback(async () => {
    setMeError(null);
    try {
      const profile = await remote.get('/auth/me');
      if (profile.offline_lease) {
        saveCachedLease(profile.offline_lease);
      }
      saveAccount({ userId: profile.user.id, email: profile.user.email ?? null, empId: profile.user.emp_id });
      setMe(profile);
      // Face attendance challenges for offline use: fetched whenever the session is checked online, so a
      // device that then loses its connection can still capture (each is accepted once, at sync). Never
      // blocks sign-in; a user without attendance rights is simply refused and holds none.
      refillTickets((path, body) => remote.post(path, body), profile.user.id);
      await store.identity.saveAuthorization(profile, { now: new Date().toISOString() })
        .catch((e) => console.warn('[session] could not cache authorization', e));
    } catch (e) {
      // Offline: sign in with the authorization cached at the last successful sign-in on this device.
      const stored = getAuth()?.account;
      const cached = e.status === 0 ? await cachedAuthorization({ userId: stored?.userId, email: stored?.email }) : null;
      if (cached) {
        const dev = await getDevice().catch(() => null);
        const lease = getCachedLease();
        const leaseCheck = validateOfflineLease({
          lease,
          deviceId: dev?.id,
          userId: cached.user?.id,
          empId: cached.user?.emp_id,
        });
        if (!leaseCheck.valid) {
          console.warn('[session] offline lease validation failed:', leaseCheck.code);
          setMe({ ...cached, offline: true, offlineExpired: true, leaseError: leaseCheck.code });
        } else {
          setMe({ ...cached, offline: true, offlineExpired: false, offlineLease: leaseCheck.lease, leaseHoursLeft: leaseCheck.remainingHours });
        }
      } else {
        setMeError(e);
      }
    }
  }, [remote, store, cachedAuthorization]);

  // Re-resolve the profile when the token changes (sign-in, sign-out), not on every account detail update.
  const signedIn = !!account;
  const loadMeRef = useRef(loadMe);
  loadMeRef.current = loadMe;
  const currentToken = account?.token;
  useEffect(() => {
    if (DEMO_MODE) return;
    if (signedIn) loadMeRef.current();
    else setMe(null);
  }, [signedIn, currentToken]);

  // Local session metadata: one row per signed-in app session on this device.
  useEffect(() => {
    if (DEMO_MODE || !me?.user?.id) return undefined;
    let cancelled = false;
    const now = new Date().toISOString();
    store.identity.startSession({ userId: me.user.id, email: me.user.email, mode: me.offline ? 'offline' : 'online', now })
      .then((id) => {
        if (cancelled) store.identity.endSession(id, new Date().toISOString());
        else sessionIdRef.current = id;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (sessionIdRef.current) store.identity.endSession(sessionIdRef.current, new Date().toISOString()).catch(() => {});
      sessionIdRef.current = null;
    };
  }, [me?.user?.id, me?.offline, me?.user?.email, store]);

  useEffect(() => {
    if (!me) return undefined;
    const sync = () => {
      queue.flush();
      queue.pull();
    };
    queue.refresh();
    sync();
    const offNet = subscribeConnectivity((online) => (online ? sync() : queue.refresh()));
    const offFg = subscribeForeground(() => {
      if (sessionIdRef.current) store.identity.touchSession(sessionIdRef.current, new Date().toISOString()).catch(() => {});
      sync();
    });
    return () => {
      offNet();
      offFg();
    };
  }, [me, queue, store]);

  // Storing the token signs in: the auth subscription above picks it up and loads /auth/me.
  const startSession = useCallback((loginData) => {
    setMeError(null);
    saveToken(loginData.access_token, null);
  }, []);

  const signIn = useCallback(async (username, password, opts = {}) => {
    if (DEMO_MODE) return;
    const { solution } = opts.captchaSolution ? { solution: opts.captchaSolution } : await solveCaptcha();
    const device = await getDevice();
    const loginData = await postJson('/auth/login', {
      username,
      password,
      captcha: solution,
      device: { id: device.id, platform: device.platform, label: device.label },
    }, { code: 'invalid_credentials', message: 'Employee ID or password is incorrect.' });
    startSession(loginData);
  }, [startSession]);

  const requestOtp = useCallback(async (mobile, opts = {}) => {
    if (DEMO_MODE) return { expires_in_seconds: 300, resend_after_seconds: 60 };
    const { solution } = opts.captchaSolution ? { solution: opts.captchaSolution } : await solveCaptcha();
    const device = await getDevice();
    return postJson('/auth/otp/request', {
      mobile,
      captcha: solution,
      device: { id: device.id, platform: device.platform, label: device.label },
    }, { code: 'otp_failed', message: 'Could not send sign-in code.' });
  }, []);

  const verifyOtp = useCallback(async (mobile, code) => {
    if (DEMO_MODE) return;
    const device = await getDevice();
    const loginData = await postJson('/auth/otp/verify', {
      mobile,
      code,
      device: { id: device.id, platform: device.platform, label: device.label },
    }, { code: 'otp_invalid', message: 'The code is incorrect or has expired.' });
    startSession(loginData);
  }, [startSession]);

  // Changes the password on the server after it re-checks the current one. Needs a connection. Other
  // sessions of this employee are ended by the server; this one continues.
  const changePassword = useCallback(async (currentPassword, newPassword) => {
    if (!remote) throw Object.assign(new Error('Sign in again to change your password.'), { code: 'not_signed_in' });
    await remote.post('/auth/password', { current_password: currentPassword, new_password: newPassword });
  }, [remote]);

  const signOut = useCallback(async () => {
    if (DEMO_MODE) return;
    const token = storedToken();
    if (token) {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    saveCachedLease(null);
    clearToken();
    setAccount(null);
    setMe(null);
  }, []);

  const value = useMemo(() => {
    const divisions = me ? Object.keys(me.divisions) : [];
    const perms = new Set(divisions.flatMap((d) => me.divisions[d]));
    // The user's client (office): which modules it is subscribed to and how its prepaid wallet stands.
    // Comes from /auth/me, is refreshed by every /sync/changes pull, and is part of the cached
    // authorization snapshot, so it is just as available offline. Null for a Super Admin, who works
    // across every client and is gated by none of them -- and in demo mode.
    const client = me?.client ?? null;
    return {
      status: !account ? 'signedOut' : me ? 'ready' : meError ? 'error' : 'loading',
      account,
      configError,
      me,
      meError,
      user: me?.user ?? null,
      divisions,
      client,
      // The modules this client has, or null for "do not gate" (Super Admin, demo mode). The server has
      // already stripped the permissions of unsubscribed modules from `me.divisions`, so this list is a
      // second, explicit layer rather than the only one. See src/app/modules.js.
      modules: client?.modules ?? null,
      moduleEnabled: (key) => !client?.modules || client.modules.includes(key),
      // `can`: held in any division (navigation). `canIn`: held in that division (actions on a record).
      can: (perm) => perms.has(perm),
      canIn: (perm, divisionId) => !!me?.divisions?.[divisionId]?.includes(perm),
      api,
      ops,
      queue,
      store,
      db,
      outbox,
      signIn,
      signOut,
      requestOtp,
      verifyOtp,
      offlineLease: me?.offlineLease || null,
      offlineExpired: !!me?.offlineExpired,
      changePassword,
      reload: loadMe,
    };
  }, [account, me, meError, configError, api, ops, queue, store, db, outbox, signIn, signOut, requestOtp, verifyOtp, changePassword, loadMe]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
const noopSubscribe = () => () => {};

export function useQueueState() {
  const { queue } = useSession();
  return useSyncExternalStore(queue.subscribe, queue.getState);
}

// Loads a GET endpoint. With the local-first API, data the server cannot provide right now comes from
// SQLite and is flagged `stale` ("Offline — showing data on this device"). Endpoints with no local
// table (reports, audit) fall back to the signed-in user's last response cached in sync_meta, with
// `cachedAt` saying when it was loaded. `path` null skips it.
// Refresh lifecycle: a resource is (re)read when its path/query changes, on reload(), and whenever the
// operations queue commits delivery outcomes or pulled changes (queue `revision`), so a screen never keeps
// showing a sync state the database has already left. Each read belongs to one effect run: a superseded
// read (older revision, other query) is discarded when it resolves, so an older response can never
// overwrite a newer one.
const selectRevision = (queue) => () => queue?.getState().revision ?? 0;

export function useResource(path, query) {
  const { api, outbox, user, queue } = useSession();
  const revision = useSyncExternalStore(queue?.subscribe ?? noopSubscribe, selectRevision(queue));
  const key = path ? `${path}?${new URLSearchParams(query ?? {}).toString()}` : null;
  const cacheKey = responseCacheKey(user?.id, path, query);
  const [state, setState] = useState({ data: null, loading: !!path, error: null, stale: false, cachedAt: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) {
      setState({ data: null, loading: false, error: null, stale: false, cachedAt: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const load = api.getWithSource ? api.getWithSource(path, query) : api.get(path, query).then((data) => ({ data, source: 'remote' }));
    load
      .then(async ({ data, source }) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null, stale: source === 'local', cachedAt: null, source });
        // Operational data already lives in SQLite tables; only cache what has no local table. Reports are
        // also kept: offline they are recalculated from device records, and the last server report remains
        // available for comparison (src/pages/ops/Reports.jsx).
        if (source === 'remote' && cacheKey && (!api.hasLocal?.(path) || path.startsWith('/reports/'))) {
          await outbox.setMeta(cacheKey, JSON.stringify(data), new Date().toISOString()).catch(() => {});
        }
      })
      .catch(async (error) => {
        const cached = error.status === 0 && cacheKey ? await outbox.getMetaEntry(cacheKey).catch(() => null) : null;
        if (cancelled) return;
        setState({ data: cached ? JSON.parse(cached.value) : null, loading: false, error, stale: !!cached, cachedAt: cached?.updated_at ?? null, source: cached ? 'snapshot' : null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cacheKey, tick, revision]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
