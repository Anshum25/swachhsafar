// Jobs (TEMPORARY test module, see src/pages/ops/Jobs.jsx): the phone's copy of the server's `jobs` table.
//
// Read side: GET /sync/changes delivers `jobs`; serverStatements() writes each one here. `data` keeps the
// server's complete JSON for the job, so a field the backend adds later is stored and shown on the phone
// without any app change. A job deleted on the server arrives with is_deleted=true and is removed here.
// A job with a local edit that has not reached the server yet (sync_status 'pending') is never overwritten.
//
// Write side: prepareSave() stores a local create/edit/delete as 'pending'; localStore.capture() queues the
// 'job.save' operation with it in the same transaction, and /sync/batch delivers it.
import { parseJson } from './sqlHelpers.js';

const COLUMNS = ['title', 'description', 'location', 'priority', 'status', 'due_date', 'is_deleted', 'data',
  'created_by_id', 'updated_by_id', 'server_updated_at', 'sync_status', 'last_sync_error', 'synced_at'];

export const jobOut = (r) => {
  const server = parseJson(r.data, {});
  return {
    ...server,
    id: r.id, title: r.title, description: r.description, location: r.location, priority: r.priority, status: r.status,
    due_date: r.due_date, extra: server.extra ?? {}, created_by_id: r.created_by_id, updated_by_id: r.updated_by_id,
    created_at: r.created_at, updated_at: r.server_updated_at ?? r.updated_at,
    sync_status: r.sync_status, last_sync_error: r.last_sync_error,
  };
};

export function createJobRepository(db) {
  return {
    // One server JobOut -> statements. Pending local edits win until they are delivered.
    serverStatements(job, now) {
      if (job.is_deleted) {
        return [{ sql: "DELETE FROM jobs WHERE id = ? AND sync_status != 'pending'", params: [job.id] }];
      }
      const row = {
        title: job.title, description: job.description ?? null, location: job.location ?? null, priority: job.priority ?? 'medium',
        status: job.status ?? 'open', due_date: job.due_date ?? null, is_deleted: 0, data: JSON.stringify(job),
        created_by_id: job.created_by_id ?? null, updated_by_id: job.updated_by_id ?? null, server_updated_at: job.updated_at ?? null,
        sync_status: 'synced', last_sync_error: null, synced_at: now,
      };
      return [{
        sql: `INSERT INTO jobs (id, ${COLUMNS.join(', ')}, created_at, updated_at) VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)
              ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at
              WHERE jobs.sync_status != 'pending'`,
        params: [job.id, ...COLUMNS.map((c) => row[c]), job.created_at ?? now, now],
      }];
    },

    // payload: the 'job.save' operation payload (backend JobSaveIn).
    async prepareSave(payload, { now, actor }) {
      const [existing] = await db.query('SELECT * FROM jobs WHERE id = ?', [payload.id]);
      const row = {
        title: payload.title, description: payload.description, location: payload.location, priority: payload.priority,
        status: payload.status, due_date: payload.due_date, is_deleted: payload.deleted ? 1 : 0,
        data: existing?.data ?? JSON.stringify({}), created_by_id: existing?.created_by_id ?? actor.id, updated_by_id: actor.id,
        server_updated_at: existing?.server_updated_at ?? null, sync_status: 'pending', last_sync_error: null, synced_at: existing?.synced_at ?? null,
      };
      return {
        divisionId: null,
        row: { id: payload.id, ...row },
        statements: [{
          sql: `INSERT INTO jobs (id, ${COLUMNS.join(', ')}, created_at, updated_at) VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)
                ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`,
          params: [payload.id, ...COLUMNS.map((c) => row[c] ?? null), existing?.created_at ?? now, now],
        }],
      };
    },

    async list() {
      const rows = await db.query('SELECT * FROM jobs WHERE is_deleted = 0 ORDER BY updated_at DESC');
      return rows.map(jobOut);
    },

    async get(id) {
      const [row] = await db.query('SELECT * FROM jobs WHERE id = ?', [id]);
      return row ? jobOut(row) : null;
    },

    async count() {
      const [row] = await db.query('SELECT COUNT(*) AS n FROM jobs WHERE is_deleted = 0');
      return row.n;
    },
  };
}
