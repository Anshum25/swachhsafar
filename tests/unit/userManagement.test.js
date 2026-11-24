import { describe, expect, it, vi } from 'vitest';
import { clearAppCache } from '../../src/pwa/clearCache.js';
import { MASTER_SECTIONS, sectionOf, visibleSections } from '../../src/pages/ops/masters/sections.js';
import { canManageRole, serverFieldErrors, userChanges, validateUserFields } from '../../src/pages/ops/masters/UserDialogs.jsx';

function fakeWindow({ online = true, cacheKeys = ['workbox-precache-v2', 'runtime'] } = {}) {
  const deleted = [];
  const unregistered = [];
  const win = {
    navigator: {
      onLine: online,
      serviceWorker: { getRegistrations: async () => [{ unregister: async () => unregistered.push(1) }] },
    },
    caches: { keys: async () => cacheKeys, delete: async (k) => deleted.push(k) },
    sessionStorage: { clear: vi.fn() },
    localStorage: { clear: vi.fn() },
    location: { reload: vi.fn() },
  };
  return { win, deleted, unregistered };
}

describe('clearAppCache', () => {
  it('removes cached app files and the service worker, then reloads', async () => {
    const { win, deleted, unregistered } = fakeWindow();
    const out = await clearAppCache({ win });
    expect(deleted).toEqual(['workbox-precache-v2', 'runtime']);
    expect(unregistered).toHaveLength(1);
    expect(out).toEqual({ caches: 2, workers: 1 });
    expect(win.location.reload).toHaveBeenCalledOnce();
  });

  it('never touches the sign-in, form drafts or records', async () => {
    const { win } = fakeWindow();
    await clearAppCache({ win });
    expect(win.localStorage.clear).not.toHaveBeenCalled();
    expect(win.sessionStorage.clear).not.toHaveBeenCalled();
  });

  it('refuses offline, when the files could not be downloaded again', async () => {
    const { win, deleted } = fakeWindow({ online: false });
    await expect(clearAppCache({ win })).rejects.toThrow(/internet/);
    expect(deleted).toEqual([]);
    expect(win.location.reload).not.toHaveBeenCalled();
  });
});

describe('master data sections', () => {
  it('lists all eleven subsections for a full administrator, gated ones hidden otherwise', () => {
    expect(MASTER_SECTIONS.map((s) => s.key)).toEqual(
      ['trains', 'users', 'divisions', 'clients', 'setup', 'roles', 'questions', 'categories', 'departments', 'items', 'policy'],
    );
    expect(visibleSections(() => true)).toHaveLength(11);
    const keys = visibleSections(() => false).map((s) => s.key);
    expect(keys).not.toContain('users');
    expect(keys).not.toContain('trains');
    // Clients and credits are the Super Admin's screens, and role rights need permissions.manage.
    expect(keys).not.toContain('clients');
    expect(keys).not.toContain('setup'); // an office's stations and trains: its Admin and the Super Admin
    expect(keys).not.toContain('roles');
  });

  it('reads the section from the hash path', () => {
    expect(sectionOf('/masters/users/abc')).toBe('users');
    expect(sectionOf('/masters')).toBeNull();
    expect(sectionOf('/journeys')).toBeNull();
  });
});

describe('user form helpers', () => {
  const user = { id: 'u1', emp_id: 'E1', name: 'Asha', name_hindi: null, email: 'asha@example.com', mobile: null, gender: null,
    designation: null, lang: 'en', role_id: 5, division_id: 'd1' };
  const form = { name: 'Asha', name_hindi: '', email: 'asha@example.com', mobile: '', gender: '', designation: '', lang: 'en', role_id: '5', division_id: 'd1' };

  it('sends only what changed', () => {
    expect(userChanges(user, form)).toEqual({});
    expect(userChanges(user, { ...form, designation: ' Lead ', role_id: '4' })).toEqual({ designation: 'Lead', role_id: 4 });
    expect(userChanges(user, { ...form, email: '' })).toEqual({ email: null });
    expect(userChanges(user, { ...form, email: 'ASHA@example.com' })).toEqual({});
  });

  it('validates fields like the backend schema', () => {
    expect(validateUserFields(form)).toEqual({});
    const e = validateUserFields({ ...form, name: 'A', email: 'nope', mobile: '12345' });
    expect(Object.keys(e).sort()).toEqual(['email', 'mobile', 'name']);
  });

  it('maps server validation errors to fields', () => {
    const err = { detail: { details: [{ loc: ['body', 'email'], msg: 'bad email' }] } };
    expect(serverFieldErrors(err)).toEqual({ email: 'bad email' });
    expect(serverFieldErrors(new Error('x'))).toEqual({});
  });

  it('mirrors the backend role hierarchy', () => {
    expect(canManageRole(3, 5)).toBe(true);
    expect(canManageRole(3, 2)).toBe(false);
    expect(canManageRole(3, 6)).toBe(false);
    expect(canManageRole(4, 5)).toBe(false);
  });
});

describe('master data: where the office / division pickers apply', () => {
  it('shows them on the division-scoped sections only', async () => {
    const { usesDivisionFilter } = await import('../../src/pages/ops/masters/sections.js');
    for (const key of ['trains', 'users', 'roles', 'questions', 'categories', 'departments', 'items', 'policy']) {
      expect(usesDivisionFilter(key)).toBe(true);
    }
    // These list or pick offices themselves: the header pickers would change nothing there.
    for (const key of ['clients', 'divisions', 'setup']) expect(usesDivisionFilter(key)).toBe(false);
    // A user's profile is one person.
    expect(usesDivisionFilter('users', 'some-user-id')).toBe(false);
  });
});
