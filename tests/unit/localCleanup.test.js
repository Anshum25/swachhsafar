import { describe, expect, it } from 'vitest';
import { createLocalCleanup } from '../../src/database/localCleanup.js';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createMemoryFiles } from '../helpers/memoryFiles.js';

// Today is 2026-11-26 (IST); NOW is its morning.
const TODAY = '2026-11-26';
const NOW = '2026-11-26T04:00:00.000Z';
const T = '2026-11-20T04:00:00.000Z';   // when the old records were made
const SHA = 'a'.repeat(64);

async function setup() {
  const db = await createMemoryDb();
  const files = createMemoryFiles();
  await db.run('PRAGMA foreign_keys = OFF');   // records without their divisions, trains and users
  const journey = (id, endDate, status = 'planned') => db.run(
    `INSERT INTO journeys (id, division_id, train_id, train_no, train_name, journey_date, end_date, supervisor_id, status,
       origin, sync_status, created_at, updated_at) VALUES (?, 'd1', 't1', '12951', 'Rajdhani', ?, ?, 'u1', ?, 'server', 'synced', ?, ?)`,
    [id, endDate, endDate, status, T, T]);
  await journey('ended', '2026-11-22');          // ended four days ago
  await journey('running', TODAY);               // still running
  await journey('old-empty', '2026-11-10');      // ended two weeks ago, nothing of its own here
  await journey('cancelled', '2026-12-01', 'cancelled');
  const media = async (id, owner, uploaded) => {
    await files.write(id, new Uint8Array([1, 2, 3]));
    await db.run(`INSERT INTO media_files (id, owner_table, owner_id, kind, mime_type, size_bytes, sha256, storage_path, upload_status,
      created_at, updated_at) VALUES (?, 'attendance_records', ?, 'attendance_photo', 'image/jpeg', 3, ?, ?, ?, ?, ?)`,
    [id, owner, SHA, `media/${id}`, uploaded ? 'uploaded' : 'pending', T, T]);
  };
  const attendance = async (id, journeyId, employee, sync) => {
    await media(`m-${id}`, id, sync === 'synced');
    await db.run(`INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, photo_media_id, sync_status,
      synced_at, created_at, updated_at) VALUES (?, ?, 'd1', ?, 1, ?, ?, ?, ?, ?)`,
    [id, journeyId, employee, `m-${id}`, sync, sync === 'synced' ? T : null, T, T]);
  };
  await attendance('a-ended-synced', 'ended', 'e1', 'synced');
  await attendance('a-ended-pending', 'ended', 'e2', 'pending');
  await attendance('a-running-synced', 'running', 'e1', 'synced');
  await attendance('a-cancelled-synced', 'cancelled', 'e1', 'synced');
  const inventory = (id, sync) => db.run(`INSERT INTO inventory_transactions (id, journey_id, division_id, item_id, txn_type, quantity, unit,
    sync_status, created_at, updated_at) VALUES (?, 'ended', 'd1', 'i1', 'issue', 2, 'pcs', ?, ?, ?)`, [id, sync, T, T]);
  await inventory('inv-synced', 'synced');
  await inventory('inv-pending', 'pending');
  await db.run(`INSERT INTO complaints (id, journey_id, division_id, category_id, description, sla_hours, due_at, sync_status, created_at, updated_at)
    VALUES ('c1', 'ended', 'd1', 'cat', 'Toilet not cleaned', 24, ?, 'synced', ?, ?)`, [T, T, T]);
  await db.run(`INSERT INTO complaint_history (id, complaint_id, to_status, created_at) VALUES ('h1', 'c1', 'created', ?)`, [T]);
  const outbox = (id, status, completedAt) => db.run(`INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, sync_status,
    completed_at, created_at, updated_at) VALUES (?, 'operation', ?, 'attendance.create', '{}', ?, ?, ?, ?)`, [id, id, status, completedAt, T, T]);
  await outbox('o-done-old', 'completed', T);
  await outbox('o-done-now', 'completed', NOW);
  await outbox('o-pending', 'pending', null);
  await db.run(`INSERT INTO audit_events (id, occurred_at, action, entity_type, entity_id) VALUES
    ('old', '2026-09-01T00:00:00.000Z', 'x', 'y', 'z'), ('new', ?, 'x', 'y', 'z')`, [NOW]);
  return { db, files };
}

const ids = async (db, table) => (await db.query(`SELECT id FROM ${table} ORDER BY id`)).map((r) => r.id);

describe('clearing what the server already has from the phone', () => {
  it('clears synced records of finished journeys and the files they own, and keeps anything not yet delivered', async () => {
    const { db, files } = await setup();
    const out = await createLocalCleanup(db, { files }).run({ today: TODAY, now: NOW });

    // Synced records of the ended and the cancelled journey are gone; the pending one and the running journey's stay.
    expect(await ids(db, 'attendance_records')).toEqual(['a-ended-pending', 'a-running-synced']);
    expect(await ids(db, 'inventory_transactions')).toEqual(['inv-pending']);
    expect(await ids(db, 'complaints')).toEqual([]);
    expect(await ids(db, 'complaint_history')).toEqual([]);
    // Their media rows and files are gone. The running journey's uploaded photo keeps its row but not its
    // bytes (a preview loads it from the server); the photo not yet uploaded keeps both.
    expect(await ids(db, 'media_files')).toEqual(['m-a-ended-pending', 'm-a-running-synced']);
    expect([...files.map.keys()].sort()).toEqual(['m-a-ended-pending']);

    // The journey that ended two weeks ago and the cancelled one go once nothing of theirs is left; the ended
    // one stays while it still has a record waiting to be delivered.
    expect(await ids(db, 'journeys')).toEqual(['ended', 'running']);
    // Outbox entries delivered more than a day ago go; the pending one and today's stay.
    expect(await ids(db, 'sync_outbox')).toEqual(['o-done-now', 'o-pending']);
    expect(await ids(db, 'audit_events')).toEqual(['new']);
    expect(out).toMatchObject({ records: 4, journeys: 2, outbox: 1 });
  });

  it('still refuses to delete what is not on the server yet', async () => {
    const { db } = await setup();
    await expect(db.run("DELETE FROM inventory_transactions WHERE id = 'inv-pending'")).rejects.toThrow(/immutable/);
    await expect(db.run("DELETE FROM audit_events WHERE id = 'new'")).rejects.toThrow(/immutable/);
    await db.run("UPDATE complaints SET sync_status = 'pending' WHERE id = 'c1'");
    await expect(db.run("DELETE FROM complaint_history WHERE id = 'h1'")).rejects.toThrow(/immutable/);
  });

  it('gives the freed space back to the phone', async () => {
    const { db, files } = await setup();
    // Enough synced rows of an ended journey to free a good share of the file.
    const big = 'x'.repeat(4000);
    for (let i = 0; i < 1000; i += 1) {
      await db.run(`INSERT INTO security_events (id, type, severity, details, occurred_at, sync_status, synced_at, created_at, updated_at)
        VALUES (?, 't', 'info', json_object('pad', ?), ?, 'synced', ?, ?, ?)`, [`s${i}`, big, T, T, T, T]);
    }
    const [{ page_count: before }] = await db.query('PRAGMA page_count');
    const out = await createLocalCleanup(db, { files }).run({ today: TODAY, now: NOW });
    const [{ page_count: after }] = await db.query('PRAGMA page_count');
    expect(out.compacted).toBe(true);
    expect(after).toBeLessThan(before / 2);
  });
});
