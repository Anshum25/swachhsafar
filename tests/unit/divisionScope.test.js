import { describe, expect, it } from 'vitest';
import { firstDivisionOf, resolveDivisionScope } from '../../src/app/divisionScope.js';

// Two offices: A has headquarters and a workshop, B has its own headquarters.
const list = [
  { id: 'a-hq', name: 'Headquarters', client_id: 'A' },
  { id: 'a-ws', name: 'Workshop', client_id: 'A' },
  { id: 'b-hq', name: 'Headquarters', client_id: 'B' },
];
const all = list.map((d) => d.id);

describe('resolveDivisionScope', () => {
  it('shows only the chosen office\'s divisions', () => {
    const s = resolveDivisionScope({ list, openable: all, divisionId: 'a-hq', clientChoice: 'B' });
    expect(s.multiClient).toBe(true);
    expect(s.clientId).toBe('B');
    expect(s.shown.map((d) => d.id)).toEqual(['b-hq']);
    // A division from another office is never left selected under this one.
    expect(s.divisionId).toBe('b-hq');
  });

  it('keeps a chosen division that belongs to the chosen office', () => {
    const s = resolveDivisionScope({ list, openable: all, divisionId: 'a-ws', clientChoice: 'A' });
    expect(s.shown.map((d) => d.id)).toEqual(['a-hq', 'a-ws']);
    expect(s.divisionId).toBe('a-ws');
  });

  it('takes the office from the last division when no office was chosen', () => {
    const s = resolveDivisionScope({ list, openable: all, divisionId: 'b-hq', clientChoice: null });
    expect(s.clientId).toBe('B');
    expect(s.divisionId).toBe('b-hq');
  });

  it('ignores a stored office the user can no longer open', () => {
    const s = resolveDivisionScope({ list, openable: ['a-hq', 'a-ws'], divisionId: null, clientChoice: 'B' });
    expect(s.multiClient).toBe(false);
    expect(s.clientId).toBe('A');
    expect(s.divisionId).toBe('a-hq');
  });

  it('is the plain division list when rows carry no office (device database)', () => {
    const local = list.map(({ client_id: _ignored, ...d }) => d);
    const s = resolveDivisionScope({ list: local, openable: all, divisionId: 'b-hq', clientChoice: 'A' });
    expect(s.multiClient).toBe(false);
    expect(s.shown).toHaveLength(3);
    expect(s.divisionId).toBe('b-hq');
  });

  it('falls back to the first openable division before /divisions has loaded', () => {
    const s = resolveDivisionScope({ list: [], openable: ['a-hq'], divisionId: 'gone', clientChoice: null });
    expect(s.divisionId).toBe('a-hq');
  });
});

describe('firstDivisionOf', () => {
  it('opens the first division of the new office the user may open', () => {
    expect(firstDivisionOf({ list, openable: all, clientId: 'A' })).toBe('a-hq');
    expect(firstDivisionOf({ list, openable: ['a-ws'], clientId: 'A' })).toBe('a-ws');
    expect(firstDivisionOf({ list, openable: all, clientId: 'Z' })).toBeNull();
  });
});
