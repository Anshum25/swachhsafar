// The device's pool of server-issued liveness challenges: single use, never handed out twice even when the
// server returns a challenge again before its record has synced, and fail-closed when there are none.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireTicket, refillTickets, storeTickets, takeTicket, ticketCount } from '../../src/face/livenessTickets.js';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const USER = 'u1';
const ticket = (id, hours = 12) => ({
  id, actions: ['turn_left', 'blink', 'look_up'], signature: 'f'.repeat(64),
  issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
});

describe('liveness challenge pool', () => {
  beforeEach(() => mem.clear());

  it('each challenge is handed out once', () => {
    storeTickets(USER, [ticket('a'), ticket('b')]);
    const first = takeTicket(USER);
    const second = takeTicket(USER);
    expect(new Set([first.id, second.id])).toEqual(new Set(['a', 'b']));
    expect(takeTicket(USER)).toBeNull(); // none left: capture fails closed
  });

  it('a challenge used offline is not taken again when the server returns it before the record syncs', () => {
    storeTickets(USER, [ticket('a')]);
    expect(takeTicket(USER).id).toBe('a');
    storeTickets(USER, [ticket('a'), ticket('b')]); // refill: server still lists "a" as open
    expect(takeTicket(USER).id).toBe('b');
    expect(takeTicket(USER)).toBeNull();
  });

  it('expired or nearly expired challenges are never used', () => {
    storeTickets(USER, [ticket('old', 0.01), ticket('ok')]);
    expect(ticketCount(USER)).toBe(1);
    expect(takeTicket(USER).id).toBe('ok');
  });

  it('malformed entries are ignored', () => {
    storeTickets(USER, [{ id: 'x' }, null, ticket('ok')]);
    expect(ticketCount(USER)).toBe(1);
  });

  it('pools are per user', () => {
    storeTickets(USER, [ticket('a')]);
    expect(takeTicket('someone-else')).toBeNull();
  });

  it('online and low: refills from the server before taking one', async () => {
    const post = vi.fn(async () => [ticket('s1'), ticket('s2')]);
    const t = await acquireTicket({ post, userId: USER, online: true });
    expect(post).toHaveBeenCalledWith('/attendance/liveness/challenges', { count: 20 });
    expect(['s1', 's2']).toContain(t.id);
  });

  it('offline with an empty pool: no challenge, so no capture', async () => {
    const post = vi.fn();
    expect(await acquireTicket({ post, userId: USER, online: false })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('a failed refill never throws', async () => {
    const post = vi.fn(async () => { throw new Error('offline'); });
    expect(await refillTickets(post, USER)).toBe(0);
  });
});
