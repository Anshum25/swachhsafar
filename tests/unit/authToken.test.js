// The backend session token store: survives a restart (localStorage), notifies the session, and works
// (for the life of the page) when storage is blocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

describe('authToken', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores the token, keeps the account details, and clears both on sign-out', async () => {
    const t = await import('../../src/security/authToken.js');
    const seen = [];
    t.subscribeAuth((a) => seen.push(a?.token ?? null));
    expect(t.getToken()).toBeNull();
    t.saveToken('ss1.abc.secret');
    t.saveAccount({ userId: 'u1', email: 'a@b.c', empId: 'E1' });
    expect(t.getAuth()).toEqual({ token: 'ss1.abc.secret', account: { userId: 'u1', email: 'a@b.c', empId: 'E1' } });
    // A fresh module (app restart) reads the same session back.
    vi.resetModules();
    const again = await import('../../src/security/authToken.js');
    expect(again.getToken()).toBe('ss1.abc.secret');
    t.clearToken();
    expect(t.getAuth()).toBeNull();
    expect(seen).toEqual(['ss1.abc.secret', null]);
  });

  it('falls back to memory when storage throws', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} });
    const t = await import('../../src/security/authToken.js');
    t.saveToken('ss1.x.y');
    expect(t.getToken()).toBe('ss1.x.y');
  });
});
