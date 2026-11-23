// The device's pool of server-issued liveness challenges (POST /attendance/liveness/challenges).
//
// Each face attendance capture takes one challenge and never gives it back, whether the attempt passes or
// fails. The pool is fetched while online so that capture keeps working offline; the server checks every
// challenge again when the record syncs, and accepts each one once. With no valid challenge left on the
// device, face capture refuses to start (fails closed) until the device is back online.
//
// A challenge taken here is remembered as used until it expires. The server keeps returning a challenge
// until a synced record consumes it, so without this a challenge used offline -- its record still waiting
// to sync -- would come back in the next refill, be used again, and the second record would be refused.

const KEY = (userId) => `swachh.liveness.${userId}`;
const REFILL_BELOW = 8;
const POOL_SIZE = 20;
// A challenge this close to expiry is not started: the capture might not finish in time.
const MIN_LIFE_MS = 2 * 60_000;

const storage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

function load(userId) {
  try {
    const raw = storage()?.getItem(KEY(userId));
    const v = raw ? JSON.parse(raw) : null;
    return { tickets: Array.isArray(v?.tickets) ? v.tickets : [], used: v?.used && typeof v.used === 'object' ? v.used : {} };
  } catch {
    return { tickets: [], used: {} };
  }
}

function save(userId, state, now) {
  // Forget what has expired: an expired challenge is refused by the server anyway.
  const alive = (iso) => Date.parse(iso) > now;
  const tickets = state.tickets.filter((t) => alive(t.expires_at) && !state.used[t.id]);
  const used = Object.fromEntries(Object.entries(state.used).filter(([, exp]) => alive(exp)));
  try {
    storage()?.setItem(KEY(userId), JSON.stringify({ tickets, used }));
  } catch { /* storage full or blocked: the in-memory pool for this call still works */ }
  return { tickets, used };
}

const valid = (t) => t && typeof t.id === 'string' && typeof t.signature === 'string' && Array.isArray(t.actions)
  && t.actions.length > 0 && typeof t.expires_at === 'string';

// Merges what the server returned into the pool. Returns how many usable challenges the device now holds.
export function storeTickets(userId, list, now = Date.now()) {
  const state = load(userId);
  const byId = new Map(state.tickets.map((t) => [t.id, t]));
  for (const t of list ?? []) if (valid(t) && !state.used[t.id]) byId.set(t.id, t);
  return save(userId, { tickets: [...byId.values()], used: state.used }, now).tickets.length;
}

export function ticketCount(userId, now = Date.now()) {
  const { tickets, used } = load(userId);
  return tickets.filter((t) => !used[t.id] && Date.parse(t.expires_at) - now > MIN_LIFE_MS).length;
}

// Takes one challenge out of the pool for a capture, or null when there is none.
export function takeTicket(userId, now = Date.now()) {
  if (!userId) return null;
  const state = load(userId);
  const usable = state.tickets.filter((t) => valid(t) && !state.used[t.id] && Date.parse(t.expires_at) - now > MIN_LIFE_MS);
  if (!usable.length) return null;
  const ticket = usable[0];
  state.used[ticket.id] = ticket.expires_at;
  save(userId, state, now);
  return ticket;
}

// Fetches challenges from the server. `post` is the API client's post. Never throws.
export async function refillTickets(post, userId, { count = POOL_SIZE, timeoutMs = 6000 } = {}) {
  if (!post || !userId) return 0;
  try {
    const list = await Promise.race([
      post('/attendance/liveness/challenges', { count }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return storeTickets(userId, list);
  } catch {
    return ticketCount(userId);
  }
}

// For a capture: tops the pool up first when it is running low and the device is online, then takes one.
export async function acquireTicket({ post, userId, online }) {
  if (online && ticketCount(userId) < REFILL_BELOW) await refillTickets(post, userId);
  return takeTicket(userId);
}

export function clearTickets(userId) {
  try { storage()?.removeItem(KEY(userId)); } catch { /* nothing to clear */ }
}
