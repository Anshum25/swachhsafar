import { describe, expect, it } from 'vitest';
import {
  addDays, compact, donutAngles, foldParts, istToday, niceScale, pct, periodRange, ringPath, tickDates,
} from '../../src/pages/ops/overviewMath.js';

describe('istToday', () => {
  it('is the India date, not the UTC one', () => {
    // 20:00 UTC on 1 March is 01:30 on 2 March in India.
    expect(istToday(new Date('2026-03-01T20:00:00Z'))).toBe('2026-03-02');
    expect(istToday(new Date('2026-03-01T10:00:00Z'))).toBe('2026-03-01');
  });
});

describe('periodRange', () => {
  const today = '2026-11-23';
  it('counts today in a preset', () => {
    expect(periodRange('today', {}, today)).toEqual({ date_from: today, date_to: today });
    expect(periodRange('7d', {}, today)).toEqual({ date_from: '2026-11-17', date_to: today });
    expect(periodRange('30d', {}, today)).toEqual({ date_from: '2026-10-25', date_to: today });
  });
  it('puts a custom range in order and caps it to a year', () => {
    expect(periodRange('custom', { from: '2026-11-20', to: '2026-11-01' }, today)).toEqual({ date_from: '2026-11-01', date_to: '2026-11-20' });
    expect(periodRange('custom', { from: '2024-01-01', to: '2026-11-23' }, today).date_from).toBe(addDays('2026-11-23', -366));
  });
});

describe('niceScale', () => {
  it('rounds the top up to a readable step', () => {
    expect(niceScale(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(3).max).toBe(3);
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('tickDates', () => {
  const days = Array.from({ length: 30 }, (_, i) => addDays('2026-11-01', i));
  it('keeps the first and last and at most the slots asked for', () => {
    const t = tickDates(days, 6);
    expect(t[0]).toBe(days[0]);
    expect(t[t.length - 1]).toBe(days[29]);
    expect(t.length).toBeLessThanOrEqual(6);
  });
  it('prints every date when there are few', () => {
    expect(tickDates(days.slice(0, 4), 6)).toHaveLength(4);
  });
});


describe('donut helpers', () => {
  it('folds the smallest parts past six into Other and drops zeros', () => {
    const parts = [9, 8, 7, 6, 5, 4, 3, 0].map((value, i) => ({ key: `p${i}`, label: `P${i}`, value }));
    const f = foldParts(parts, 6);
    expect(f).toHaveLength(6);
    expect(f[5]).toEqual({ key: 'other', label: 'Other', value: 7 });
    expect(foldParts([{ key: 'a', label: 'A', value: 0 }])).toEqual([]);
  });
  it('splits the circle in proportion', () => {
    const [a, b] = donutAngles([1, 3]);
    expect(a.share).toBe(0.25);
    expect(b.end).toBeCloseTo(Math.PI * 2);
    expect(donutAngles([0, 0])).toEqual([null, null]);
  });
  it('draws a full ring as two halves', () => {
    expect(ringPath(50, 50, 30, 40, 0, Math.PI * 2).match(/M/g)).toHaveLength(2);
    expect(ringPath(50, 50, 30, 40, 0, Math.PI / 2)).toMatch(/^M50 10A40 40 0 0 1 90 50/);
  });
  it('formats shares and big numbers', () => {
    expect(pct(0.333)).toBe('33%');
    expect(pct(0.001)).toBe('<1%');
    expect(compact(1284)).toBe('1,284');
    expect(compact(12900)).toBe('12.9K');
    expect(compact(4_200_000)).toBe('4.2M');
  });
});
