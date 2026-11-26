// Keeps the phone's database small: what the server already has is cleared from the device.
//
// The device is where captures wait while there is no connection; once the server has them, the server is
// the record. Online, screens already read the server and only add this device's NOT-yet-synced records
// (localFirstApi overlay), so a synced copy here is only ever used offline. What is cleared, and when:
//
// - Photos, videos and voice notes: the file is deleted as soon as it is uploaded and the record that owns it
//   is synced. A preview then loads it from the server (MediaPreview falls back to it).
// - Synced records (attendance, inspections, feedback, complaints, inventory, security events): once their
//   journey has ended (more than a day ago) or was cancelled. While a journey runs, its synced records stay:
//   offline they are what tells the app a stage or slot is already done, so it is not captured twice.
// - Journeys from the server that ended more than a week ago and have nothing left on the device.
// - Delivered outbox entries after a day; resolved sync conflicts and audit events after 30 days.
//
// Nothing that is not yet on the server is ever touched: pending, rejected and conflicting records, their
// files and their outbox entries all stay until they are delivered or the user discards them.
const DAY = 24 * 60 * 60 * 1000;

// Record tables, with the column that ties a row to its journey.
const RECORDS = [
  { table: 'attendance_records', journey: 'journey_id' },
  { table: 'inspection_records', journey: 'journey_id' },
  { table: 'passenger_feedback', journey: 'journey_id' },
  { table: 'railway_feedback', journey: 'journey_id' },
  { table: 'complaints', journey: 'journey_id' },
  { table: 'inventory_transactions', journey: 'journey_id' },
  { table: 'security_events', journey: null },
];

const addDays = (isoDate, n) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const fileName = (path) => String(path).replace(/^media\//, '');
const chunks = (xs, n = 400) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const marks = (xs) => xs.map(() => '?').join(', ');

export function createLocalCleanup(db, { files }) {
  // Synced rows of `table` that may go: their journey ended before `ended` or was cancelled. Security events
  // (no journey) go a day after they were delivered.
  function purgeable({ table, journey }, { ended, dayAgo }) {
    if (!journey) return { where: `sync_status = 'synced' AND COALESCE(synced_at, created_at) < ?`, params: [dayAgo] };
    // A complaint need not belong to a journey: one without goes a day after it was delivered.
    const orphan = table === 'complaints' ? ` OR (${journey} IS NULL AND COALESCE(synced_at, created_at) < ?)` : '';
    return {
      where: `sync_status = 'synced' AND (${journey} IN (SELECT id FROM journeys WHERE end_date < ? OR status = 'cancelled')${orphan})`,
      params: orphan ? [ended, dayAgo] : [ended],
    };
  }

  async function removeFiles(paths) {
    if (!paths.length) return 0;
    const present = new Set(await files.list().catch(() => []));
    let n = 0;
    for (const p of paths) {
      const name = fileName(p);
      if (!present.has(name)) continue;
      await files.remove(name).catch(() => {});
      n += 1;
    }
    return n;
  }

  return {
    // { today: 'YYYY-MM-DD', now: ISO timestamp }. Returns what was cleared.
    async run({ today, now }) {
      const nowMs = Date.parse(now);
      const dayAgo = new Date(nowMs - DAY).toISOString();
      const monthAgo = new Date(nowMs - 30 * DAY).toISOString();
      const ended = addDays(today, -1);       // journeys whose last day was before yesterday
      const weekAgo = addDays(today, -7);
      const out = { records: 0, files: 0, journeys: 0, outbox: 0 };

      // 1. Synced records of finished journeys, with their files.
      for (const r of RECORDS) {
        const { where, params } = purgeable(r, { ended, dayAgo });
        const ids = (await db.query(`SELECT id FROM ${r.table} WHERE ${where}`, params)).map((x) => x.id);
        if (!ids.length) continue;
        for (const part of chunks(ids)) {
          const media = await db.query(
            `SELECT id, storage_path FROM media_files WHERE owner_table = ? AND owner_id IN (${marks(part)})`, [r.table, ...part]);
          const statements = [];
          if (r.table === 'complaints') {
            statements.push(
              { sql: `DELETE FROM complaint_attachments WHERE complaint_id IN (${marks(part)})`, params: part },
              { sql: `DELETE FROM complaint_history WHERE complaint_id IN (${marks(part)})`, params: part },
            );
          }
          statements.push({ sql: `DELETE FROM ${r.table} WHERE id IN (${marks(part)})`, params: part });
          if (media.length) statements.push({ sql: `DELETE FROM media_files WHERE id IN (${marks(media)})`, params: media.map((m) => m.id) });
          await db.transaction(statements);
          out.records += part.length;
          out.files += await removeFiles(media.map((m) => m.storage_path));
        }
      }

      // 2. Files already uploaded whose record is on the server too: the bytes go, the small metadata row
      //    stays until the record itself is cleared (step 1).
      const unsynced = RECORDS.map((r) => `(m.owner_table = '${r.table}' AND EXISTS (SELECT 1 FROM ${r.table} o WHERE o.id = m.owner_id AND o.sync_status != 'synced'))`);
      const uploaded = await db.query(
        `SELECT m.storage_path FROM media_files m WHERE m.upload_status = 'uploaded' AND NOT (${unsynced.join(' OR ')})`);
      out.files += await removeFiles(uploaded.map((m) => m.storage_path));

      // 3. Journeys from the server that ended a week ago and have nothing of their own left here.
      const left = RECORDS.filter((r) => r.journey).map((r) => `NOT EXISTS (SELECT 1 FROM ${r.table} x WHERE x.${r.journey} = j.id)`);
      const old = (await db.query(
        `SELECT j.id FROM journeys j WHERE j.sync_status = 'synced' AND (j.end_date < ? OR j.status = 'cancelled') AND ${left.join(' AND ')}`,
        [weekAgo])).map((x) => x.id);
      for (const part of chunks(old)) {
        await db.transaction([{ sql: `DELETE FROM journeys WHERE id IN (${marks(part)})`, params: part }]);   // coaches and staff cascade
        out.journeys += part.length;
      }

      // 4. Bookkeeping: delivered outbox entries, settled conflicts, old audit events.
      const { changes } = await db.run(
        "DELETE FROM sync_outbox WHERE sync_status = 'completed' AND COALESCE(completed_at, updated_at) < ?", [dayAgo]);
      out.outbox = changes ?? 0;
      await db.run("DELETE FROM sync_conflicts WHERE status != 'open' AND COALESCE(resolved_at, detected_at) < ?", [monthAgo]);
      await db.run('DELETE FROM audit_events WHERE occurred_at < ?', [monthAgo]);

      // 5. Give the space back: SQLite keeps freed pages inside the file until it is compacted.
      const [{ page_count: pages }] = await db.query('PRAGMA page_count');
      const [{ freelist_count: free }] = await db.query('PRAGMA freelist_count');
      out.compacted = pages > 0 && free / pages > 0.25 && free > 256;
      if (out.compacted) await db.run('VACUUM');
      return out;
    },
  };
}
