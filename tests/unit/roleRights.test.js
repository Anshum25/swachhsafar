import { describe, expect, it } from 'vitest';
import { resolve } from '../../src/pages/ops/masters/roleRights.js';

const JANITOR = 5;
const row = (effect, scope = {}) => ({ id: `${effect}-${JSON.stringify(scope)}`, role_id: JANITOR, permission_code: 'attendance.submit', effect, client_id: null, division_id: null, ...scope });

describe('resolve (role rights)', () => {
  it('uses the global grant when nothing overrides it', () => {
    const s = resolve('attendance.submit', JANITOR, [row('allow')]);
    expect(s).toMatchObject({ allowed: true, base: true, inOffice: true, office: null, division: null });
  });

  it('lets the office override the global grant', () => {
    const s = resolve('attendance.submit', JANITOR, [row('allow'), row('deny', { client_id: 'A' })]);
    expect(s.base).toBe(true);
    expect(s.inOffice).toBe(false);
    expect(s.allowed).toBe(false);
    expect(s.office.effect).toBe('deny');
  });

  it('lets the division override the office', () => {
    const s = resolve('attendance.submit', JANITOR, [row('allow'), row('deny', { client_id: 'A' }), row('allow', { division_id: 'd1' })]);
    expect(s.inOffice).toBe(false);
    expect(s.allowed).toBe(true);
  });

  it('can grant in an office what the default does not', () => {
    const s = resolve('attendance.submit', JANITOR, [row('allow', { client_id: 'A' })]);
    expect(s.base).toBe(false);
    expect(s.allowed).toBe(true);
  });

  it('ignores other roles and permissions', () => {
    const s = resolve('attendance.submit', JANITOR, [{ ...row('allow'), role_id: 3 }, { ...row('allow'), permission_code: 'reports.read' }]);
    expect(s.allowed).toBe(false);
  });
});
