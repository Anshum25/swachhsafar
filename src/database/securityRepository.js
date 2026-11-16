// Security events captured on this device (see src/security/events.js). Delivered once via the outbox.
import { insertStatement } from './sqlHelpers.js';
import { LocalRuleError } from './errors.js';

const TYPE = /^[a-z0-9_.]{3,48}$/;
const SEVERITIES = new Set(['info', 'warning', 'critical']);

export function createSecurityRepository(db) {
  return {
    async prepareEvent(p, { actor, now }) {
      if (!TYPE.test(p.type ?? '')) throw new LocalRuleError('validation', 'Invalid security event type.');
      if (!SEVERITIES.has(p.severity)) throw new LocalRuleError('validation', 'Invalid security event severity.');
      const row = {
        id: p.id, user_id: actor?.id ?? null, division_id: p.division_id ?? null, type: p.type, severity: p.severity,
        details: JSON.stringify(p.details ?? {}), occurred_at: p.occurred_at, sync_status: 'pending', created_at: now, updated_at: now,
      };
      return { row, divisionId: p.division_id ?? null, statements: [insertStatement('security_events', row)] };
    },

    async recent({ limit = 50 } = {}) {
      return db.query('SELECT * FROM security_events ORDER BY occurred_at DESC LIMIT ?', [limit]);
    },
  };
}
