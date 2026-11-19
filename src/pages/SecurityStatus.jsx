// Security status (#/security): each check this device makes, with an honest state. Green only when the check
// actually succeeded; "Unavailable" when this platform cannot perform it (e.g. a browser cannot see a VPN).
import { useEffect, useState } from 'react';
import { useResource, useSession } from '../app/session.jsx';
import { useSecurity } from '../security/SecurityProvider.jsx';
import { isNativeApp } from '../security/native.js';
import { BLOCKS } from '../security/messages.js';
import { PageHeader, Panel, fmtDateTime } from '../components/ui.jsx';
import { RefreshIcon, Spinner } from '../components/Icons.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';

const TONE = {
  Verified: 'bg-success/10 text-emerald-700 ring-success/30',
  Pending: 'bg-brand-50 text-brand-800 ring-brand-200',
  Failed: 'bg-red-50 text-red-700 ring-red-200',
  Unavailable: 'bg-slate-100 text-slate-600 ring-slate-200',
};

function Row({ label, state, detail }) {
  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{label}</p>
        {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${TONE[state]}`} data-testid={`status-${label}`}>{state}</span>
    </li>
  );
}

export default function SecurityStatus() {
  const sec = useSecurity();
  const { me, store } = useSession();
  const online = useNetworkStatus();
  const session = useResource(online && !me.offline ? '/auth/session' : null);
  const [faces, setFaces] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    store.db.query('SELECT COUNT(*) AS n FROM face_profiles').then(([r]) => setFaces(r?.n ?? 0)).catch(() => setFaces(null));
    store.security.recent({ limit: 15 }).then(setEvents).catch(() => {});
  }, [store, sec?.location?.checkedAt]);
  if (!sec) return null;
  const { policy, location: loc, network, device } = sec;
  const evalLoc = sec.guards.location.evaluate();
  const native = isNativeApp();
  const age = loc.fix ? Math.round((Date.now() - loc.fix.timestamp) / 1000) : null;
  const hoursLeft = me.offline ? (typeof me.leaseHoursLeft === 'number' ? Math.max(0, me.leaseHoursLeft) : 0) : null;

  const rows = [
    ['Location services', native ? (loc.services === 'on' ? 'Verified' : loc.services === 'off' ? 'Failed' : 'Pending')
      : loc.fix ? 'Verified' : loc.error === 'unavailable' ? 'Failed' : 'Unavailable',
    native ? `Android location: ${loc.services}` : 'A browser cannot read the GPS switch; shown as verified only when a fix arrives.'],
    ['Location permission', loc.permission === 'granted' ? 'Verified' : loc.permission === 'denied' ? 'Failed' : loc.permission === 'prompt' ? 'Pending' : 'Unavailable', `Permission: ${loc.permission}`],
    ['GPS accuracy', !loc.fix ? (loc.checking ? 'Pending' : 'Failed') : evalLoc.ok ? 'Verified' : 'Failed',
      loc.fix ? `±${Math.round(loc.fix.accuracy ?? 0)} m (limit ${policy.gps_max_accuracy_m} m) · ${age}s old (limit ${policy.gps_max_age_seconds}s)${loc.fix.mocked ? ' · MOCK LOCATION' : ''}`
        : BLOCKS[evalLoc.code]?.title],
    ['VPN status', network.vpn === true ? 'Failed' : network.vpn === false ? 'Verified' : 'Unavailable',
      network.check === 'native' ? 'Checked on this phone (Android network transport).'
        : network.check === 'server' ? 'Checked by the server against its IP reputation list (best effort: not every VPN is listed).'
          : 'Could not be checked here (browser offline or no reputation source). Absence of a result is not proof of no VPN.'],
    ['Network', online ? 'Verified' : 'Unavailable', online ? 'Connected' : 'Offline: records are saved on this device'],
    ['Authentication', me.offline ? 'Pending' : 'Verified', me.offline ? `Signed in offline with the profile cached ${fmtDateTime(me.fetched_at)}` : `Signed in as ${me.user.emp_id}`],
    ['Device registration', session.data?.device_status === 'active' ? 'Verified' : session.data?.device_status === 'revoked' ? 'Failed'
      : session.data && !session.data.session_id ? 'Pending' : 'Unavailable',
    session.data?.session_id ? `Device ${device?.id ?? ''}` : session.data ? 'This sign-in predates device registration: sign in again to register the device.' : 'Checked when online.'],
    ['Offline authorization', me.offline ? (sec.offlineExpired ? 'Failed' : 'Verified') : 'Verified',
      me.offline ? (sec.offlineExpired ? 'Signed offline lease expired (> 24 h). Reconnect to continue.' : `${hoursLeft?.toFixed(1)} h left of signed 24 h offline authorization lease.`) : `Online. Backend-signed offline authorization lease allows up to ${policy.offline_session_hours} h of offline use.`],
    ['Face verification readiness', !policy.attendance_face_verification ? 'Unavailable' : faces ? 'Verified' : 'Failed',
      !policy.attendance_face_verification ? 'Face verification is off in this division.'
        : `${faces ?? 0} registered face(s) on this device${policy.face_liveness_required ? ' · live check (blink + head turn) required' : ''}`],
  ];

  return (
    <>
      <PageHeader title="Security Status" back="#/" />
      <div className="mx-auto max-w-xl space-y-4">
        <Panel title="This device" actions={(
          <button type="button" className="btn-secondary h-9" disabled={busy} onClick={async () => { setBusy(true); await sec.refresh(); setBusy(false); }}>
            {busy ? <Spinner /> : <RefreshIcon />} Check again
          </button>
        )}>
          <ul className="divide-y divide-line/70">{rows.map(([l, s, d]) => <Row key={l} label={l} state={s} detail={d} />)}</ul>
          <p className="mt-2 text-xs text-muted">{native ? 'Android app' : 'Browser (PWA)'} · {device?.label} · checked {loc.checkedAt ? fmtDateTime(new Date(loc.checkedAt).toISOString()) : '—'}</p>
        </Panel>
        <Panel title="Recent security events on this device">
          {events.length === 0 ? <p className="text-sm text-muted">None recorded.</p> : (
            <ul className="divide-y divide-line/70 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex justify-between gap-3 py-2">
                  <span className="min-w-0 break-words"><b className={e.severity === 'critical' ? 'text-red-700' : e.severity === 'warning' ? 'text-amber-800' : 'text-ink'}>{e.type}</b></span>
                  <span className="shrink-0 text-xs text-muted">{fmtDateTime(e.occurred_at)} · {e.sync_status === 'synced' ? 'sent' : 'not sent'}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
