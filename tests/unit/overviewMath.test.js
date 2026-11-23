import { describe, expect, it } from 'vitest';
import { addDays, istToday, niceScale, periodRange, tickDates } from '../../src/pages/ops/overviewMath.js';

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
