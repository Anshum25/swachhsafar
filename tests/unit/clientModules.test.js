// What a user sees is the client's subscription and their role, together. These tests pin the two layers
// apart, because a bug in either one looks identical from the outside -- a module that is simply missing.
import { describe, expect, it } from 'vitest';
import { MODULES, moduleAllowed, resolveRoute, visibleModules } from '../../src/app/modules.js';
import { visibleNav } from '../../src/app/Layout.jsx';
import { CAPTURE_RULES, authorizeCapture, captureModuleAllowed } from '../../src/services/authorization.js';

// The permissions the backend grants each role by default (backend/app/security/catalog.py), which is
// what /auth/me returns once the client's subscription has been applied to it.
const ROLE_PERMISSIONS = {
  manager: ['users.read', 'users.manage', 'trains.read', 'trains.manage', 'journeys.read', 'journeys.read_all',
    'journeys.manage', 'staff.manage', 'attendance.read', 'attendance.review', 'inspections.read',
    'inspections.review', 'feedback.read', 'feedback.review', 'complaints.create', 'complaints.read',
    'complaints.manage', 'inventory.read', 'inventory.transact', 'reports.read', 'dashboard.read', 'media.upload'],
  supervisor: ['trains.read', 'journeys.read', 'attendance.submit', 'attendance.read', 'inspections.submit',
    'inspections.read', 'feedback.collect', 'feedback.railway.submit', 'feedback.read', 'complaints.create',
    'complaints.read', 'inventory.read', 'inventory.transact', 'media.upload'],
  janitor: ['journeys.read', 'attendance.submit', 'attendance.read', 'media.upload'],
  contractor: ['trains.read', 'journeys.read', 'journeys.read_all', 'attendance.read', 'inspections.read',
    'feedback.read', 'complaints.read', 'inventory.read', 'reports.read', 'dashboard.read'],
};

const ALL_MODULES = ['admin', 'users', 'masters', 'media', 'journeys',
  'attendance', 'inspections', 'feedback', 'complaints', 'inventory', 'reports'];
const PLATFORM_ONLY = ['admin', 'users', 'masters', 'media', 'journeys'];

const can = (role) => (perm) => ROLE_PERMISSIONS[role].includes(perm);
const keys = (role, modules) => visibleModules(can(role), modules).map((m) => m.key);

describe('what each role sees, with every module subscribed', () => {
  it('a janitor gets the dashboard, journeys and attendance, and nothing else', () => {
    // `profile` and `security` are everyone's own account, reached from the menu rather than the nav.
    expect(keys('janitor', ALL_MODULES)).toEqual(
      ['dashboard', 'journeys', 'attendance', 'jobs', 'profile', 'security'],
    );
    expect(visibleNav(can('janitor'), ALL_MODULES).map((m) => m.key))
      .toEqual(['dashboard', 'journeys', 'attendance', 'jobs']);
  });

  it('a supervisor gets the field modules but no master data and no reports', () => {
    const seen = keys('supervisor', ALL_MODULES);
    expect(seen).toContain('inspections');
    expect(seen).toContain('feedback');
    expect(seen).toContain('inventory');
    expect(seen).not.toContain('masters');
    expect(seen).not.toContain('reports');
  });

  it('a manager gets master data and reports as well', () => {
    const seen = keys('manager', ALL_MODULES);
    expect(seen).toContain('masters');
    expect(seen).toContain('reports');
    // ...but not the two capture-only paths a manager does not perform.
    expect(seen).toContain('attendance'); // attendance.read
  });

  it('a contractor reads but never captures', () => {
    const seen = keys('contractor', ALL_MODULES);
    expect(seen).toContain('reports');
    expect(seen).not.toContain('masters');
  });

  it('every module a role sees is one it holds a permission for', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      for (const m of visibleModules(can(role), ALL_MODULES)) {
        expect(m.any.length === 0 || m.any.some(can(role))).toBe(true);
      }
    }
  });
});

describe("the client's subscription caps the role", () => {
  it('an office that bought only inspections shows only the inspection path', () => {
    // The server strips the permissions of unsubscribed modules, so this is what /auth/me would return.
    const subscribed = [...PLATFORM_ONLY, 'inspections'];
    const inspectionOnly = (perm) => ROLE_PERMISSIONS.supervisor.includes(perm)
      && !perm.startsWith('attendance.') && !perm.startsWith('feedback.')
      && !perm.startsWith('complaints.') && !perm.startsWith('inventory.');
    const seen = visibleModules(inspectionOnly, subscribed).map((m) => m.key);
    expect(seen).toContain('inspections');
    expect(seen).toContain('journeys');
    expect(seen).not.toContain('attendance');
    expect(seen).not.toContain('feedback');
    expect(seen).not.toContain('reports');
  });

  it('hides an unsubscribed module even for a role whose permissions were not stripped', () => {
    // Belt and braces: if a stale cached snapshot still carried the permission, the subscription alone
    // must still hide the screen.
    const seen = keys('manager', [...PLATFORM_ONLY, 'reports']);
    expect(seen).toContain('reports');
    expect(seen).not.toContain('attendance');
    expect(seen).not.toContain('complaints');
  });

  it('never switches off the platform or the journey spine', () => {
    const seen = keys('manager', PLATFORM_ONLY);
    expect(seen).toContain('dashboard');
    expect(seen).toContain('journeys');
    expect(seen).toContain('masters');
  });

  it('a null subscription gates nothing, which is the Super Admin and demo mode', () => {
    expect(keys('manager', null).length).toBeGreaterThan(keys('manager', PLATFORM_ONLY).length);
    expect(MODULES.every((m) => moduleAllowed(m, null))).toBe(true);
  });

  it('navigation and routing agree with each other', () => {
    const modules = [...PLATFORM_ONLY, 'attendance'];
    const nav = visibleNav(can('janitor'), modules).map((m) => m.key);
    expect(nav).toContain('attendance');
    expect(resolveRoute(['attendance'], can('janitor'), modules).allowed).toBe(true);

    const withoutAttendance = visibleNav(can('janitor'), PLATFORM_ONLY).map((m) => m.key);
    expect(withoutAttendance).not.toContain('attendance');
    expect(resolveRoute(['attendance'], can('janitor'), PLATFORM_ONLY).allowed).toBe(false);
  });

  it('a route for an unsubscribed module still resolves to the module, so the app can say why', () => {
    const route = resolveRoute(['inventory'], can('supervisor'), PLATFORM_ONLY);
    expect(route.module.key).toBe('inventory');
    expect(route.allowed).toBe(false);
  });
});

describe('offline capture respects the subscription', () => {
  const actor = (modules) => ({
    id: 'u1',
    modules,
    permissions: { d1: ['attendance.submit', 'inspections.submit', 'inventory.transact'] },
  });

  it('refuses a capture for a module the office does not pay for', () => {
    expect(() => authorizeCapture('attendance.create', { actor: actor(PLATFORM_ONLY), divisionId: 'd1' }))
      .toThrowError(/subscription/);
    try {
      authorizeCapture('attendance.create', { actor: actor(PLATFORM_ONLY), divisionId: 'd1' });
    } catch (e) {
      expect(e.code).toBe('module_disabled');
    }
  });

  it('allows it once the module is subscribed', () => {
    expect(() => authorizeCapture('attendance.create', { actor: actor([...PLATFORM_ONLY, 'attendance']), divisionId: 'd1' }))
      .not.toThrow();
  });

  it('checks the subscription before the permission, so the message names the real reason', () => {
    const noPermission = { id: 'u1', modules: PLATFORM_ONLY, permissions: { d1: [] } };
    try {
      authorizeCapture('attendance.create', { actor: noPermission, divisionId: 'd1' });
      throw new Error('should have refused');
    } catch (e) {
      expect(e.code).toBe('module_disabled');
    }
  });

  it('leaves the always-on operations alone', () => {
    for (const type of ['security.event', 'job.save']) {
      expect(() => authorizeCapture(type, { actor: actor(PLATFORM_ONLY), divisionId: 'd1' })).not.toThrow();
    }
  });

  it('gates nothing when there is no subscription to apply', () => {
    expect(() => authorizeCapture('inventory.record', { actor: actor(null), divisionId: 'd1' })).not.toThrow();
  });

  it('every capture rule names a module or is deliberately always-on', () => {
    for (const [type, rule] of Object.entries(CAPTURE_RULES)) {
      expect(Object.hasOwn(rule, 'module'), `${type} must declare a module (null for always-on)`).toBe(true);
      expect(captureModuleAllowed(rule, null)).toBe(true);
    }
  });
});
