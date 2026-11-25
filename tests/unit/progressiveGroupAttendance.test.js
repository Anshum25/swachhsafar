// Progressive, employee-wise group attendance on the device: one group photo is a shared capture, but
// each person in it is recorded at their OWN next pending stage (Attendance.jsx GroupDialog uses
// nextStageFor on each status row). Runs on a real local SQLite store, offline.
import { describe, expect, it } from 'vitest';
import { IDS, actorFor, attendancePayload, changesFixture, seededStore } from '../helpers/operationalFixtures.js';
import { attendanceCells, nextStageFor } from '../../src/database/attendanceRepository.js';
import { LEGACY_STAGES } from '../../src/utils/attendanceStages.js';

const groupOn = () => {
  const c = changesFixture();
  c.policies = Object.fromEntries(Object.entries(c.policies).map(([d, p]) => [d, { ...p, attendance_group_photo: true }]));
  return c;
};

// What GroupDialog does on confirm: work out each selected person's next stage, then one
// attendance.create per person, all sharing one group_submission_id.
async function groupPhoto(store, employeeIds) {
  const status = await store.attendance.journeyStatus(IDS.journey);
  const submission = crypto.randomUUID();
  const recorded = {};
  for (const id of employeeIds) {
    const stage = nextStageFor(status.find((r) => r.employee_id === id));
    await store.capture({
      ...attendancePayload({ employee_id: id, stage, group_photo: true, group_submission_id: submission }),
      actor: actorFor(IDS.supervisor),
    });
    recorded[id] = stage;
  }
  return { recorded, submission };
}

const statesOf = async (store, id) => (await store.attendance.journeyStatus(IDS.journey))
  .find((r) => r.employee_id === id).stages.map((c) => c.status);

describe('nextStageFor (pure)', () => {
  const row = (taken, pending = []) => attendanceCells(LEGACY_STAGES, new Map(taken.map((s) => [s, `t${s}`])), new Map(pending.map((s) => [s, `p${s}`])));
  it('is each employee\'s own first unrecorded stage', () => {
    // Anshum at 3, Krish at 4, Om at 2 -- one photo gives each their own stage.
    expect([row([1, 2]), row([1, 2, 3]), row([1])].map((r) => nextStageFor(r))).toEqual([3, 4, 2]);
  });
  it('counts stages saved on this device and just-submitted ones, never skips, and ends at null', () => {
    expect(nextStageFor(row([1], [2]))).toBe(3);
    expect(nextStageFor(row([1]), (s) => s === 2)).toBe(3);
    expect(nextStageFor(row([]))).toBe(1);
    expect(nextStageFor(row([1, 2, 3, 4, 5]))).toBeNull();
  });
});

describe('progressive group attendance (offline store)', () => {
  it('records each person at their own stage and leaves absentees unchanged', async () => {
    const { store } = await seededStore();
    await store.ingestChanges(groupOn());
    const [a, b] = [IDS.janitor1, IDS.janitor2];

    // Test 1: only A in the first photo -> A stage 1; B untouched.
    expect((await groupPhoto(store, [a])).recorded).toEqual({ [a]: 1 });
    expect(await statesOf(store, b)).toEqual(['next', 'locked', 'locked', 'locked', 'locked']);
    expect(await statesOf(store, a)).toEqual(['pending', 'next', 'locked', 'locked', 'locked']);

    // Test 2: both in the photo -> A stage 2, B stage 1 (not the same stage for everyone).
    const { recorded, submission } = await groupPhoto(store, [a, b]);
    expect(recorded).toEqual({ [a]: 2, [b]: 1 });
    const rows = await store.db.query('SELECT employee_id, stage, group_submission_id, identified_by FROM attendance_records WHERE group_submission_id = ?', [submission]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.identified_by === 'group_photo')).toBe(true);

    // Test 3/4: A again, B absent -> A stage 3, B stays at 2 next.
    expect((await groupPhoto(store, [a])).recorded).toEqual({ [a]: 3 });
    expect(await statesOf(store, b)).toEqual(['pending', 'next', 'locked', 'locked', 'locked']);

    // Records list carries the group association and the method.
    const listed = await store.attendance.listRecords({ divisions: [IDS.division], journeyId: IDS.journey });
    expect(listed.filter((r) => r.group_submission_id === submission)).toHaveLength(2);
    expect(listed[0].identified_by).toBe('group_photo');
  });

  it('refuses duplicates and skipped stages (Test 5)', async () => {
    const { store } = await seededStore();
    await store.ingestChanges(groupOn());
    await groupPhoto(store, [IDS.janitor1]);
    const by = actorFor(IDS.supervisor);
    await expect(store.capture({ ...attendancePayload({ stage: 1, group_photo: true }), actor: by }))
      .rejects.toMatchObject({ code: 'duplicate_attendance' });
    await expect(store.capture({ ...attendancePayload({ stage: 3, group_photo: true }), actor: by }))
      .rejects.toMatchObject({ code: 'stage_order' });
  });

  it('unlocks all five stages one at a time, per employee (Test 8)', async () => {
    const { store } = await seededStore();
    await store.ingestChanges(groupOn());
    for (let i = 1; i <= 5; i += 1) {
      expect((await groupPhoto(store, [IDS.janitor1])).recorded[IDS.janitor1]).toBe(i);
    }
    expect(await statesOf(store, IDS.janitor1)).toEqual(Array(5).fill('pending'));
    expect(await statesOf(store, IDS.janitor2)).toEqual(['next', 'locked', 'locked', 'locked', 'locked']);
  });
});
