import { describe, expect, it } from 'vitest';
import { isBlank } from '../../src/utils/blank.js';

describe('isBlank (what DataState shows as "Nothing here yet")', () => {
  it('is an empty list or an empty page', () => {
    expect(isBlank([])).toBe(true);
    expect(isBlank({ items: [], total: 0 })).toBe(true);
    expect(isBlank(null)).toBe(true);
  });
  it('is never a list with rows or a single record', () => {
    expect(isBlank([{ id: 1 }])).toBe(false);
    expect(isBlank({ items: [{ id: 1 }], total: 1 })).toBe(false);
    // One office (GET /clients/{id}) has no `items`: it used to count as empty and hid the Manage page.
    expect(isBlank({ id: 'c1', office_id: '002', name: 'skydot' })).toBe(false);
  });
});
