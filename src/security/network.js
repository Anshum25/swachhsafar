// VPN / network guard.
//   Android app: the native plugin reads ConnectivityManager NetworkCapabilities (TRANSPORT_VPN) and reports
//   changes; works offline too.
//   Browser: a web page cannot see the phone's VPN. The server checks the connection's IP against its
//   reputation source (GET /security/network); `vpn: null` means "could not tell", never "no VPN".
import { nativeSecurity } from './native.js';

export function createNetworkGuard({ api, onEvent = () => {}, now = () => Date.now() }) {
  let state = { vpn: null, check: 'unavailable', online: navigator.onLine, checkedAt: null, detail: null };
  const subs = new Set();
  const set = (patch) => {
    const before = state.vpn;
    state = { ...state, ...patch };
    if (state.vpn === true && before !== true) onEvent('vpn.detected', 'warning', { check: state.check, detail: state.detail });
    if (state.vpn === false && before === true) onEvent('vpn.cleared', 'info', { check: state.check });
    subs.forEach((f) => f(state));
  };
  let listener = null;

  async function refresh() {
    const native = nativeSecurity();
    if (native) {
      try {
        const n = await native.getNetworkState();
        set({ vpn: !!n.vpn, check: 'native', online: !!n.connected, checkedAt: now(), detail: n.transports?.join(',') ?? null });
      } catch {
        set({ vpn: null, check: 'unavailable', checkedAt: now() });
      }
      return state;
    }
    if (!navigator.onLine) {
      set({ vpn: null, check: 'unavailable', online: false, checkedAt: now() });
      return state;
    }
    try {
      const r = await api.get('/security/network');
      // source 'disabled': the server has no VPN reputation source configured, so it cannot tell. That is a
      // deployment setting, not a sign of risk on this connection, and is reported as such (never as "no VPN").
      const check = r.vpn != null ? 'server' : r.source === 'disabled' ? 'not_configured' : 'unavailable';
      set({ vpn: r.vpn, check, online: true, checkedAt: now(), detail: r.detail ?? r.source });
    } catch {
      set({ vpn: null, check: 'unavailable', checkedAt: now() });
    }
    return state;
  }

  async function start() {
    const native = nativeSecurity();
    if (native && !listener) {
      listener = await native.addListener('networkChange', (n) => set({ vpn: !!n.vpn, check: 'native', online: !!n.connected, checkedAt: now() }))
        .catch(() => null);
    }
    const on = () => { set({ online: navigator.onLine }); refresh(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    navigator.connection?.addEventListener?.('change', on);
    await refresh();
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
      navigator.connection?.removeEventListener?.('change', on);
      listener?.remove?.();
      listener = null;
    };
  }

  return { getState: () => state, subscribe: (f) => { subs.add(f); return () => subs.delete(f); }, refresh, start };
}
