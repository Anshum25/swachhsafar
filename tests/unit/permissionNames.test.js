import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { permissionGroup, permissionHint, permissionName } from '../../src/utils/permissionNames.js';

// Every permission the server knows (backend app/security/catalog.py).
const catalog = readFileSync(new URL('../../backend/app/security/catalog.py', import.meta.url), 'utf8');
const CODES = [...catalog.matchAll(/^ {4}"([a-z_]+(?:\.[a-z_]+)+)": \("/gm)].map((m) => m[1]);

describe('permissions in plain words', () => {
  it('names every permission of the server, without its code', () => {
    expect(CODES.length).toBeGreaterThan(30);
    for (const code of CODES) {
      expect(permissionName(code), code).not.toMatch(/\./);
      expect(permissionName(code), code).not.toBe(code);
      expect(permissionHint(code), code).not.toBe('');
      expect(permissionGroup(code), code).not.toBe('Other');
    }
  });

  it('reads plainly', () => {
    expect(permissionName('audit.read')).toBe('See the activity log');
    expect(permissionName('users.manage')).toBe('Add and edit staff');
    expect(permissionGroup('inventory.items.manage')).toBe('Master data');
  });

  it('still shows a permission it does not know, worded from its code', () => {
    expect(permissionName('reports.export_all')).toBe('Reports export all');
    expect(permissionHint('reports.export_all', 'Export every report')).toBe('Export every report');
  });
});
