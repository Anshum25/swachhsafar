// Jobs (temporary test module): server jobs pulled from /sync/changes land in the phone's SQLite `jobs`
// table, and phone edits are queued as 'job.save' operations.
import { describe, expect, it } from 'vitest';
import { createOperationsQueue } from '../../src/services/operationsQueue.js';
import { IDS, NOW, actorFor, seededStore } from '../helpers/operationalFixtures.js';

const JOB = '00000000-0000-4000-8000-0000000000a1';
const serverJob = (extra = {}) => ({
  id: JOB, title: 'Clean coach B2', description: null, location: 'B2', priority: 'high', status: 'open', due_date: null,
  extra: {}, is_deleted: false, created_by_id: null, updated_by_id: null,
  created_at: '2026-11-04T05:00:00Z', updated_at: '2026-11-04T05:00:00Z', ...extra,
});

function setup(store, db, { api } = {}) {
  return createOperationsQueue({
    db, store, getApi: async () => api, isOnline: () => true, now: () => NOW.toISOString(),
    getActor: () => ({ actor: actorFor(IDS.supervisor) }),
  });
}

describe('jobs sync', () => {
  it('stores server jobs, unknown server fields included, and removes server-deleted jobs', async () => {
    const { store } = await seededStore();
    await store.ingestChanges({ cursor: 'c1', jobs: [serverJob({ extra: { assigned_to: 'Ravi' }, new_column: 7 })] });
    const [job] = await store.jobs.list();
    expect(job).toMatchObject({ title: 'Clean coach B2', extra: { assigned_to: 'Ravi' }, new_column: 7, sync_status: 'synced' });

    await store.ingestChanges({ cursor: 'c2', jobs: [serverJob({ status: 'done', updated_at: '2026-11-04T05:10:00Z' })] });
    expect((await store.jobs.get(JOB)).status).toBe('done');

    await store.ingestChanges({ cursor: 'c3', jobs: [serverJob({ is_deleted: true })] });
    expect(await store.jobs.list()).toEqual([]);
  });

  it('keeps a pending phone edit over a pulled server version until it is delivered', async () => {
    const { store, db } = await seededStore();
    const queue = setup(store, db, { api: null }); // no API: the edit stays queued
    await store.ingestChanges({ cursor: 'c1', jobs: [serverJob()] });
    const payload = { id: JOB, title: 'Clean coach B2', description: null, location: 'B2', priority: 'high', status: 'in_progress', due_date: null, deleted: false };
    expect((await queue.submit({ type: 'job.save', payload })).status).not.toBe('invalid');
    await store.ingestChanges({ cursor: 'c2', jobs: [serverJob({ title: 'Server title' })] });
    expect(await store.jobs.get(JOB)).toMatchObject({ status: 'in_progress', title: 'Clean coach B2', sync_status: 'pending' });
  });

  it('replaces a queued edit of the same job instead of failing', async () => {
    const { store, db } = await seededStore();
    const queue = setup(store, db, { api: null });
    const payload = { id: JOB, title: 'First', description: null, location: null, priority: 'low', status: 'open', due_date: null, deleted: false };
    await queue.submit({ type: 'job.save', payload });
    const second = await queue.submit({ type: 'job.save', payload: { ...payload, title: 'Second' } });
    expect(second.status).not.toBe('invalid');
    const open = await db.query("SELECT payload FROM sync_outbox WHERE operation = 'job.save' AND sync_status != 'completed'");
    expect(open).toHaveLength(1);
    expect(JSON.parse(open[0].payload).op.payload.title).toBe('Second');
  });
});
