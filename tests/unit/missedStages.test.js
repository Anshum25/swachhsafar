import { describe, expect, it } from 'vitest';
import { stageClosesAt, stageMissed } from '../../src/utils/attendanceStages.js';
import { kmToStation } from '../../src/utils/routeWindow.js';
import { attendanceCells } from '../../src/database/attendanceRepository.js';

// A stage closes when the train leaves the last station it stays open at. The stage carries a clock plus a
// day offset, never a moment, so the same plan reads correctly on whichever day the journey runs.
describe('when an attendance stage closes', () => {
  const stage = (closes_time, closes_day) => ({ stage: 1, closes_time, closes_day });

  it('reads the clock against the day the train leaves, in India time', () => {
    expect(stageClosesAt('2026-11-27', stage('06:05', 1))).toBe(Date.UTC(2026, 10, 27, 0, 35));
    // A run past midnight: day 2 of a journey that left on the 27th is the 28th.
    expect(stageClosesAt('2026-11-27', stage('23:30', 2))).toBe(Date.UTC(2026, 10, 28, 18, 0));
  });

  it('has no deadline without a timetable, and is then never missed', () => {
    expect(stageClosesAt('2026-11-27', { stage: 1 })).toBeNull();
    expect(stageClosesAt(null, stage('06:05', 1))).toBeNull();
    expect(stageMissed('2026-11-27', { stage: 1 }, {}, Date.UTC(2030, 0, 1))).toBe(false);
  });

  it('gives a late train the division\'s grace before calling the stage missed', () => {
    const closes = stageClosesAt('2026-11-27', stage('06:05', 1));
    const hours = (n) => closes + n * 3600_000;
    expect(stageMissed('2026-11-27', stage('06:05', 1), { attendance_missed_grace_hours: 0 }, hours(0.5))).toBe(true);
    expect(stageMissed('2026-11-27', stage('06:05', 1), { attendance_missed_grace_hours: 6 }, hours(5))).toBe(false);
    expect(stageMissed('2026-11-27', stage('06:05', 1), { attendance_missed_grace_hours: 6 }, hours(7))).toBe(true);
    // No policy: the server's own default of 6 hours.
    expect(stageMissed('2026-11-27', stage('06:05', 1), null, hours(5))).toBe(false);
    expect(stageMissed('2026-11-27', stage('06:05', 1), null, hours(7))).toBe(true);
  });
});

describe('stage cells once a stage is missed', () => {
  const PLAN = [
    { stage: 1, label: 'Ahmedabad Jn', closes_time: '06:05', closes_day: 1 },
    { stage: 2, label: 'Nadiad Jn', closes_time: '23:00', closes_day: 1 },
    { stage: 3, label: 'Surat', closes_time: '23:00', closes_day: 2 },
  ];
  const at = (iso) => new Date(iso).getTime();
  const context = (iso) => ({ journeyDate: '2026-11-27', policy: { attendance_missed_grace_hours: 0 }, nowMs: at(iso) });

  it('locks the missed stage and opens the one after it', () => {
    const { stages, completed } = attendanceCells(PLAN, new Map(), new Map(), context('2026-11-27T08:00:00Z'));
    expect(stages.map((c) => c.status)).toEqual(['missed', 'next', 'locked']);
    expect(completed).toBe(false);
  });

  it('counts the journey complete when every stage left is missed or taken', () => {
    const taken = new Map([[2, 'a2'], [3, 'a3']]);
    const { stages, completed } = attendanceCells(PLAN, taken, new Map(), context('2026-11-27T08:00:00Z'));
    expect(stages.map((c) => c.status)).toEqual(['missed', 'taken', 'taken']);
    expect(completed).toBe(true);
  });

  it('never calls a taken or pending stage missed, however late it is', () => {
    const { stages } = attendanceCells(PLAN, new Map([[1, 'a1']]), new Map([[2, 'p2']]),
      context('2026-12-01T00:00:00Z'));
    expect(stages.map((c) => c.status)).toEqual(['taken', 'pending', 'missed']);
  });

  it('takes the server\'s word for which stages are missed, not the device clock', () => {
    const { stages } = attendanceCells(PLAN, new Map(), new Map([[3, 'p3']]), { missed: new Set([1]) });
    expect(stages.map((c) => c.status)).toEqual(['missed', 'next', 'pending']);
  });

  it('misses nothing when the stages carry no timetable', () => {
    const plain = PLAN.map(({ stage, label }) => ({ stage, label }));
    const { stages } = attendanceCells(plain, new Map(), new Map(), context('2030-01-01T00:00:00Z'));
    expect(stages.map((c) => c.status)).toEqual(['next', 'locked', 'locked']);
  });
});

describe('how near the next attendance station is', () => {
  const stage = { window: { path: [[22.310756, 73.181065, 0], [21.206568, 72.840793, 127.7]] } };

  it('measures from the stage\'s own station, the first point of its window', () => {
    expect(kmToStation(stage, { latitude: 22.310756, longitude: 73.181065 })).toBe(0);
    expect(kmToStation(stage, { latitude: 22.4, longitude: 73.181065 })).toBe(9.9);
  });

  it('answers null rather than guessing when the fix or the window is missing', () => {
    expect(kmToStation(stage, null)).toBeNull();
    expect(kmToStation(stage, { latitude: 22.3 })).toBeNull();
    expect(kmToStation({ label: 'Source' }, { latitude: 22.3, longitude: 73.2 })).toBeNull();
  });
});
