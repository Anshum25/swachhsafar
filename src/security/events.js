// Security events: recorded on the device (works offline) and delivered through the sync outbox
// ('security.event'), exactly once. Repeats of the same type within 10 minutes are dropped. Never include
// face descriptors, photos, tokens or codes in details (the server refuses such keys).
const recent = new Map();
const REPEAT_MS = 10 * 60_000;

export function createEventLogger({ submit, now = () => Date.now() }) {
  return function logSecurityEvent(type, severity = 'info', details = {}, divisionId = null) {
    const last = recent.get(type);
    if (last && now() - last < REPEAT_MS) return;
    recent.set(type, now());
    submit({
      type: 'security.event',
      payload: { id: crypto.randomUUID(), type, severity, occurred_at: new Date(now()).toISOString(), division_id: divisionId, details },
    }).catch(() => {});
  };
}
