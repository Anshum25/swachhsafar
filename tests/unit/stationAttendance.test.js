// Station-wise attendance on the device: a journey's stages come from its train's attendance configuration
// (JourneyOut.attendance_stages) -- exactly the chosen stations, in route order -- and work offline
// exactly as the five standard stages did. Runs on a real local SQLite store.
import { describe, expect, it } from 'vitest';
import { IDS, actorFor, attendancePayload, changesFixture, journeyOut, seededStore } from '../helpers/operationalFixtures.js';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { nextStageFor } from '../../src/database/attendanceRepository.js';
import {
  LEGACY_STAGES, attendanceConfigError, inRouteOrder, resolveValidUntil, selectableStations, stageCaption, stagesOf,
  validUntilChoices,
} from '../../src/utils/attendanceStages.js';

const ROUTE = [
  { code: 'ADI', name: 'Ahmedabad Jn' }, { code: 'ND', name: 'Nadiad Jn' }, { code: 'ANND', name: 'Anand Jn' },
  { code: 'BRC', name: 'Vadodara Jn' }, { code: 'BH', name: 'Bharuch Jn' }, { code: 'ST', name: 'Surat' }, { code: 'BCT', name: 'Mumbai Central' },
];
const name = Object.fromEntries(ROUTE.map((r) => [r.code, r.name]));

// The backend's attendance_plan for these stations.
function plan(codes) {
  return [
    ...codes.map((c) => ({ kind: 'station', label: name[c], station_code: c, station_name: name[c] })),
  ].map((s, i) => ({ stage: i + 1, ...s }));
}

async function configuredStore(codes) {
  const { store, db } = await seededStore();
  const c = changesFixture();
  const today = c.journeys[0].journey_date;
  c.journeys = [journeyOut(IDS.journey, today, c.journeys[0].end_date, { attendance_stages: plan(codes), updated_at: '2026-11-02T00:00:00Z' })];
  const r = await store.ingestChanges(c);
  if (!r.ok) throw new Error('ingest failed');
  return { store, db };
}

const status = async (store, id = IDS.janitor1) => (await store.attendance.journeyStatus(IDS.journey)).find((r) => r.employee_id === id);
const capture = (store, stage, extra = {}) => store.capture({ ...attendancePayload({ stage, ...extra }), actor: actorFor(IDS.supervisor) });

describe('attendance stages (pure)', () => {
  it('falls back to the five standard stages for journeys without a configuration', () => {
    expect(stagesOf({}).map((s) => s.label)).toEqual(['Source', 'Enroute 1', 'Destination', 'Enroute 2', 'End']);
    expect(stagesOf({ attendance_stages: null })).toBe(LEGACY_STAGES);
    expect(stagesOf({ attendance_stages: JSON.stringify(plan(['ND'])) })).toHaveLength(1);
    expect(LEGACY_STAGES.map(stageCaption)).toEqual(['Source', 'Enroute', 'DEST', 'Enroute', 'END']);
    expect(plan(['ADI', 'ND', 'BCT']).map(stageCaption)).toEqual(['Ahmedabad Jn', 'Nadiad Jn', 'Mumbai Central']);
    expect([1, 2, 3].map((i) => stageCaption({ stage: i, kind: 'stage', label: `Stage ${i}` }))).toEqual(['1', '2', '3']);
  });

  it('offers every station of the route, first and last included, in route order', () => {
    expect(selectableStations(ROUTE).map((s) => s.code)).toEqual(['ADI', 'ND', 'ANND', 'BRC', 'BH', 'ST', 'BCT']);
    expect(inRouteOrder(ROUTE, ['ST', 'ND', 'BCT', 'BRC', 'ND', 'PUNE', 'ADI'])).toEqual(['ADI', 'ND', 'BRC', 'ST', 'BCT']);
  });

  it('validates the Train Master configuration', () => {
    const v = (count, codes, route = ROUTE) => attendanceConfigError({ enabled: true, count, codes, route });
    expect(v(3, ['ND', 'BRC', 'ST'])).toBeNull();
    expect(v(5, ['ND', 'ANND', 'BRC', 'BH', 'ST'])).toBeNull();
    expect(v(3, ['ND', 'BRC'])).toMatch(/exactly 3 stations \(2 selected\)/);       // fewer than required
    expect(v(3, ['ND', 'BRC', 'ST', 'BH'])).toMatch(/exactly 3 stations \(4 selected\)/); // more than configured
    expect(v(2, ['ND', 'ND'])).toMatch(/only once/);
    expect(v(2, ['ND', 'PUNE'])).toMatch(/on this train's route/);
    expect(v(0, [])).toMatch(/positive whole number/);
    expect(v(2.5, [])).toMatch(/positive whole number/);
    expect(v(-1, [])).toMatch(/positive whole number/);
    expect(v(8, [])).toMatch(/only 7 stations/);
    expect(v(2, ['ADI', 'BCT'])).toBeNull();   // first and last stations can be chosen
    expect(v(2, [], [])).toMatch(/Load the train's route/);
    // Without station-wise attendance only the count is checked; empty = the standard five stages.
    expect(attendanceConfigError({ enabled: false, count: 6, codes: [], route: [] })).toBeNull();
    expect(attendanceConfigError({ enabled: false, count: '', codes: [], route: [] })).toBeNull();
    expect(attendanceConfigError({ enabled: false, count: 0, codes: [], route: [] })).toMatch(/positive whole number/);
    expect(attendanceConfigError({ enabled: false, count: 51, codes: [], route: [] })).toMatch(/At most 50/);
    expect(attendanceConfigError({ enabled: true, count: '', codes: [], route: ROUTE })).toMatch(/number of attendances first/);
  });
});

describe('station-wise attendance (offline store)', () => {
  it.each([[['ND', 'BRC', 'ST']], [['ND', 'ANND', 'BRC', 'BH', 'ST']]])('gives %j exactly that many stages, nothing added', async (codes) => {
    const { store } = await configuredStore(codes);
    const row = await status(store);
    expect(row.stages.map((c) => c.station_code)).toEqual(codes);
    expect(row.stages.map((c) => c.status)).toEqual(['next', ...Array(codes.length - 1).fill('locked')]);
    const j = await store.journeys.get(IDS.journey, '2026-11-04');
    expect(j.attendance_stages).toHaveLength(codes.length);
  });

  it('unlocks every stage in order, per employee, beyond five, and records the station', async () => {
    const codes = ROUTE.map((r) => r.code);   // all seven, first and last included
    const { store, db } = await configuredStore(codes);
    await expect(capture(store, 2)).rejects.toMatchObject({ code: 'stage_order' });
    for (let stage = 1; stage <= 7; stage += 1) {
      const row = await status(store);
      expect(nextStageFor(row)).toBe(stage);
      await capture(store, stage, { station_code: row.stages[stage - 1].station_code });
    }
    await expect(capture(store, 8)).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(capture(store, 7)).rejects.toMatchObject({ code: 'duplicate_attendance' });
    expect((await status(store)).stages.every((c) => c.status === 'pending')).toBe(true);
    expect((await status(store, IDS.janitor2)).stages.map((c) => c.status)).toEqual(['next', ...Array(6).fill('locked')]);
    const rows = await db.query('SELECT stage, station_code, stage_label, sync_status FROM attendance_records WHERE employee_id = ? ORDER BY stage', [IDS.janitor1]);
    expect(rows.map((r) => r.station_code)).toEqual(codes);
    expect(rows[6].stage_label).toBe('Mumbai Central');
    // Queued for sync once each: seven operations, no duplicates.
    const queued = await db.query("SELECT entity_id FROM sync_outbox WHERE operation = 'attendance.create'");
    expect(new Set(queued.map((q) => q.entity_id)).size).toBe(7);
    expect(queued).toHaveLength(7);
  });

  it('refuses a capture made against stations the journey no longer has', async () => {
    const { store } = await configuredStore(['ND', 'BRC']);
    await expect(capture(store, 1, { station_code: 'ADI' })).rejects.toMatchObject({ code: 'attendance_plan_changed' });
    await capture(store, 1, { station_code: 'ND' });
  });

  it('keeps old journeys on the five standard stages', async () => {
    const { store } = await seededStore();
    const row = await status(store);
    expect(row.stages.map((c) => c.label)).toEqual(['Source', 'Enroute 1', 'Destination', 'Enroute 2', 'End']);
    for (let stage = 1; stage <= 5; stage += 1) await capture(store, stage);
    await expect(capture(store, 6)).rejects.toMatchObject({ code: 'invalid_value' });
  });

  it('upgrades a v16 database keeping its attendance records readable', async () => {
    const db = await createMemoryDb({ migrate: false });
    for (const m of MIGRATIONS.filter((x) => x.version <= 16)) {
      const statements = m.prepare ? await m.prepare(db) : m.statements;
      await db.transaction([...statements.map((x) => (typeof x === 'string' ? { sql: x } : x)), { sql: `PRAGMA user_version = ${m.version}` }]);
    }
    expect(await db.query("SELECT sql FROM sqlite_master WHERE name = 'attendance_records'")).toEqual([
      { sql: expect.stringContaining('CHECK (stage BETWEEN 1 AND 5)') }]);
    // A record taken before the upgrade (references are not the point here).
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run(`INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, origin, sync_status, created_at, updated_at)
      VALUES ('old-1', 'j', 'd', 'e', 5, 'server', 'synced', 't', 't')`);
    expect(await runMigrations(db)).toMatchObject({ from: 16, to: 19, applied: [17, 18, 19] });
    expect(await db.query("SELECT stage, station_code, stage_label FROM attendance_records WHERE id = 'old-1'"))
      .toEqual([{ stage: 5, station_code: null, stage_label: null }]);
    await db.run(`INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, origin, sync_status, created_at, updated_at)
      VALUES ('new-7', 'j', 'd', 'e', 7, 'server', 'synced', 't', 't')`);   // stage 7 fits now
    await expect(db.run(`INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, origin, sync_status, created_at, updated_at)
      VALUES ('bad-0', 'j', 'd', 'e', 0, 'server', 'synced', 't', 't')`)).rejects.toThrow(/CHECK/);
    const [{ sql }] = await db.query("SELECT sql FROM sqlite_master WHERE name = 'attendance_records'");
    expect(sql).toContain('CHECK (stage >= 1)');
    const cols = (await db.query('PRAGMA table_info(attendance_records)')).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['station_code', 'stage_label']));
    expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });
});

describe('attendance windows (how far along the route each attendance stays open)', () => {
  const codes = (list) => list.map((s) => s.code);

  it('offers the stations from its own up to the halt before the next attendance station', () => {
    expect(codes(validUntilChoices(ROUTE, ['ADI', 'BRC'], 'ADI'))).toEqual(['ADI', 'ND', 'ANND']);
    expect(codes(validUntilChoices(ROUTE, ['ADI', 'BRC'], 'BRC'))).toEqual(['BRC', 'BH', 'ST', 'BCT']);
    expect(codes(validUntilChoices(ROUTE, ['ADI', 'ND'], 'ADI'))).toEqual(['ADI']);
    expect(validUntilChoices(ROUTE, ['ADI'], 'PUNE')).toEqual([]);
  });

  it('keeps a choice that still fits and otherwise defaults to the last choice', () => {
    expect(resolveValidUntil(ROUTE, ['ADI', 'BRC'], {})).toEqual({ ADI: 'ANND', BRC: 'BCT' });
    expect(resolveValidUntil(ROUTE, ['ADI', 'BRC'], { ADI: 'ND', BRC: 'BH' })).toEqual({ ADI: 'ND', BRC: 'BH' });
    // ND became an attendance station, so ADI's window cannot reach ANND any more.
    expect(resolveValidUntil(ROUTE, ['ADI', 'ND', 'BRC'], { ADI: 'ANND' })).toEqual({ ADI: 'ADI', ND: 'ANND', BRC: 'BCT' });
  });
});
