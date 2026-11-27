// Staff attendance by stage. A journey's stages are its own (journeys.attendance_stages): Source, the
// train's configured attendance stations in route order, End -- or the original five stages when the train
// has no station-wise configuration (utils/attendanceStages.js).
// Rules: the employee must be allocated to the journey, stages are recorded in order, and each stage
// at most once. Order and uniqueness are also enforced by trg_attendance_stage_order and
// idx_attendance_slot, so two concurrent captures cannot both succeed.
import { LocalRuleError } from './errors.js';
import { requireCaptureWindow, requireDeviceTimestamp, requireGps, requireInt, requireUuid } from './captureRules.js';
import { insertStatement, placeholders } from './sqlHelpers.js';
import { stageMissed, stagesOf } from '../utils/attendanceStages.js';
import { isOutside, outsideMessage, stageRouteCheck } from '../utils/routeWindow.js';

// A local row in the shape of the backend AttendanceOut, plus where it stands between device and server.
// Rows stored from a server status grid carry only their slot; their details stay on the server.
export const attendanceOut = (r) => ({
  id: r.id, journey_id: r.journey_id, division_id: r.division_id, employee_id: r.employee_id, stage: r.stage,
  station_code: r.station_code ?? null, stage_label: r.stage_label ?? null,
  device_timestamp: r.device_timestamp, server_timestamp: r.server_timestamp, latitude: r.latitude, longitude: r.longitude,
  gps_accuracy_m: r.gps_accuracy_m, photo_media_id: r.photo_media_id, group_submission_id: r.group_submission_id ?? null, identified_by: r.identified_by ?? null, created_by_id: r.recorded_by_id,
  verification_status: r.verification_status, verified_by_id: null, review_remarks: null,
  origin: r.origin, sync_status: r.sync_status, last_sync_error: r.last_sync_error,
});
// How a capture established identity, as the server records it (attendance._check_identity).
const identifiedBy = (p) => (p.group_photo ? 'group_photo'
  : typeof p.fingerprint_score === 'number' ? 'fingerprint' : typeof p.face_distance === 'number' ? 'face' : null);

// The employee's own next stage from a status row (server or local grid): the first stage that is
// neither taken, saved on this device, nor in `extraDone` (stages just submitted and not yet reloaded).
// Progress is per employee, so a group capture asks this of each member separately. null = all done.
export function nextStageFor(row, extraDone = () => false) {
  for (const c of row.stages ?? []) {
    if (c.status === 'taken' || c.status === 'pending' || extraDone(c.stage)) continue;
    return c.stage;
  }
  return null;
}

const LIVE = "sync_status NOT IN ('rejected', 'conflict')";

// The stage descriptors of a status row's cells (they carry the journey's stage list).
const planOf = (cells) => cells.map(({
  stage, kind = null, label = null, station_code = null, station_name = null,
  valid_until_name = null, closes_time = null, closes_day = null,
}) => ({ stage, kind, label, station_code, station_name, valid_until_name, closes_time, closes_day }));

// Cell states for one employee over the journey's stages. `taken` = acknowledged by the server,
// `pending` = saved on this device, `missed` = the train has left the stage's last station, so it can no
// longer be taken and the one after it opens instead. Each cell keeps its stage's name and station.
// `missed` needs the journey's date and the division's grace; without them nothing is ever missed, which
// is how a journey whose train has no timetable behaves.
export function attendanceCells(plan, taken, pending, { journeyDate = null, policy = null, nowMs, missed = null } = {}) {
  // `missed` given: the server has already judged these, and its answer is kept rather than recomputed
  // against a device clock that may have drifted.
  const gone = (s) => !taken.has(s.stage) && !pending.has(s.stage)
    && (missed ? missed.has(s.stage) : stageMissed(journeyDate, s, policy, nowMs));
  const next = plan.find((s) => !taken.has(s.stage) && !pending.has(s.stage) && !gone(s))?.stage ?? null;
  return {
    stages: plan.map((s) => {
      if (taken.has(s.stage)) return { ...s, status: 'taken', attendance_id: taken.get(s.stage) };
      if (pending.has(s.stage)) return { ...s, status: 'pending', attendance_id: pending.get(s.stage) };
      if (gone(s)) return { ...s, status: 'missed', attendance_id: null };
      return { ...s, status: s.stage === next ? 'next' : 'locked', attendance_id: null };
    }),
    completed: next === null && [...pending.keys()].every((st) => taken.has(st)),
  };
}

export function createAttendanceRepository(db, { journeys, masters }) {
  async function liveStages(journeyId, employeeId) {
    return db.query(
      `SELECT id, stage, sync_status FROM attendance_records WHERE journey_id = ? AND employee_id = ? AND ${LIVE}`,
      [journeyId, employeeId],
    );
  }

  return {
    // Validates a capture against local data and returns the statements that insert it.
    async prepareCapture(p, { actor, policy, nowMs, now, today }) {
      requireUuid(p.id, 'id');
      requireUuid(p.journey_id, 'journey_id');
      requireUuid(p.employee_id, 'employee_id');
      const capturedOn = requireDeviceTimestamp(p.device_timestamp, nowMs);
      const gps = requireGps(p);
      const journey = await journeys.get(p.journey_id, today);
      const plan = stagesOf(journey);
      const stage = requireInt(p.stage, 'stage', 1, plan.length);
      const planned = plan[stage - 1];
      // Backend attendance.create: the station the screen showed must still be this stage's station.
      if (p.station_code != null && p.station_code !== (planned.station_code ?? '')) {
        throw new LocalRuleError('attendance_plan_changed',
          `This journey's attendance stations have changed: stage ${stage} is now ${planned.label}. Capture again.`);
      }
      requireCaptureWindow(journey, capturedOn);
      // Backend attendance.check_route: a station stage is taken on its stretch of route. Checked here
      // offline against the window the journey carries; "flag" leaves it to the server to record.
      const route = stageRouteCheck(planned, gps, policy);
      if (route?.mode === 'block' && isOutside(route)) {
        throw new LocalRuleError('outside_route_window', outsideMessage(planned, route), { stage, ...route });
      }
      if (!(await journeys.isAllocated(journey.id, p.employee_id))) {
        throw new LocalRuleError('not_allocated', 'This employee is not allocated to the journey.');
      }
      // Backend _may_submit_for: the employee, the journey supervisor, or attendance.review in the division.
      const reviewer = actor?.permissions?.[journey.division_id]?.includes('attendance.review');
      if (actor && !reviewer && actor.id !== p.employee_id && actor.id !== journey.supervisor_id) {
        throw new LocalRuleError('forbidden', 'Only the employee, the journey supervisor or a reviewer may record this attendance.');
      }
      if ((policy.attendance_photo_required || policy.attendance_face_verification) && !p.photo_media_id) {
        throw new LocalRuleError('photo_required', 'A photograph is required for attendance.');
      }
      // Backend attendance._check_group_photo: a capture recognised in one photograph of a crew. It is
      // checked here in the same order as the server, so a crew marked offline is accepted or refused
      // on this device for the reason the server would give, rather than failing hours later at sync.
      if (p.group_photo) {
        if (!policy.attendance_group_photo) {
          throw new LocalRuleError('group_photo_not_allowed', 'Group photo attendance is not enabled for this division.');
        }
        if (!(journey.supervisor_id === actor?.id || reviewer)) {
          throw new LocalRuleError('group_photo_not_authorized', 'Only the journey supervisor or a reviewer may mark attendance from a group photo.');
        }
        // Only a face the device actually recognised carries a distance, and it still has to be within
        // the threshold; a person the supervisor named has none to judge.
        if (typeof p.face_distance === 'number') {
          // Backend _check_group_photo: the capture must carry a passed liveness -- someone in the crew was
          // seen moving in 3-D in the live preview. A printed picture or a screen alone is flat and never passes.
          if (p.security?.liveness !== 'passed') {
            throw new LocalRuleError('liveness_required', 'This face was not verified as a live person. A photo or a screen cannot be used for attendance.');
          }
          const profile = await masters?.getFaceProfile(p.employee_id);
          if (!profile || p.face_model !== profile.model) {
            throw new LocalRuleError('face_not_verified', "The group photo match does not refer to this employee's registered face.");
          }
          if (p.face_distance > policy.face_match_threshold) {
            throw new LocalRuleError('face_mismatch', "The group photo does not match the employee's registered face.");
          }
        }
      }
      // Backend attendance._check_face: registered face, same model, within the division's threshold.
      if (!p.group_photo && policy.attendance_face_verification) {
        const profile = await masters?.getFaceProfile(p.employee_id);
        if (!profile) throw new LocalRuleError('face_not_enrolled', 'No registered face for this employee. An administrator must register it first.');
        if (typeof p.face_distance !== 'number' || p.face_model !== profile.model) {
          throw new LocalRuleError('face_not_verified', 'Face verification is required for attendance in this division.');
        }
        if (p.face_distance > policy.face_match_threshold) {
          throw new LocalRuleError('face_mismatch', "The photo does not match the employee's registered face.");
        }
      }
      const done = new Set((await liveStages(journey.id, p.employee_id)).map((r) => r.stage));
      if (done.has(stage)) throw new LocalRuleError('duplicate_attendance', 'Attendance is already recorded for this stage.');
      // A stage the train has already left is gone: it cannot be back-filled, and it no longer holds up the
      // stages after it -- otherwise one attendance missed at the first station would lock the crew out of
      // the whole journey. The server applies the same two rules (services/attendance.create).
      const gone = (s) => stageMissed(journey.journey_date, s, policy, nowMs);
      if (gone(planned)) {
        throw new LocalRuleError('stage_missed',
          `This attendance closed when the train left ${planned.valid_until_name || planned.label}.`, { stage });
      }
      const pendingEarlier = plan.filter((s) => s.stage < stage && !done.has(s.stage) && !gone(s));
      if (pendingEarlier.length) {
        const previous = pendingEarlier[pendingEarlier.length - 1].stage;
        throw new LocalRuleError('stage_order', `Stage ${previous} must be recorded first.`,
          { recorded_stages: [...done].sort(), pending_stages: pendingEarlier.map((s) => s.stage) });
      }
      const row = {
        id: p.id, journey_id: journey.id, division_id: journey.division_id, employee_id: p.employee_id, stage, ...gps,
        // The station and stage name it was taken at (a legacy stage has no station).
        ...(planned.station_code ? { station_code: planned.station_code, stage_label: planned.label } : {}),
        device_timestamp: p.device_timestamp, captured_on: capturedOn, photo_media_id: p.photo_media_id ?? null,
        recorded_by_id: actor?.id ?? null,
        // Written only when they carry something, so an ordinary capture inserts the same columns as before.
        ...(p.group_submission_id ? { group_submission_id: p.group_submission_id } : {}),
        ...(identifiedBy(p) ? { identified_by: identifiedBy(p) } : {}),
        origin: 'local', sync_status: 'pending', created_at: now, updated_at: now,
      };
      return { row, divisionId: journey.division_id, statements: [insertStatement('attendance_records', row)] };
    },

    // Server-confirmed records seen in GET /attendance/journeys/{id}/status. INSERT OR IGNORE keeps
    // this device's own copy; a slot already held locally is left for the sync outcome to decide.
    serverStatements(journey, statusRows, now) {
      return statusRows.flatMap((r) => r.stages.filter((c) => c.status === 'taken' && c.attendance_id).map((c) => insertStatement('attendance_records', {
        id: c.attendance_id, journey_id: journey.id, division_id: journey.division_id, employee_id: r.employee_id, stage: c.stage,
        ...(c.station_code ? { station_code: c.station_code, stage_label: c.label ?? null } : {}),
        origin: 'server', sync_status: 'synced', synced_at: now, created_at: now, updated_at: now,
      }, { orIgnore: true })));
    },

    async get(id) {
      const [r] = await db.query('SELECT * FROM attendance_records WHERE id = ?', [id]);
      return r ?? null;
    },

    async listForJourney(journeyId) {
      return db.query('SELECT * FROM attendance_records WHERE journey_id = ? ORDER BY employee_id, stage, created_at', [journeyId]);
    },

    // Records in `divisions` (GET /attendance filters), newest first, as attendanceOut().
    async listRecords({ divisions = [], journeyId, employeeId, stage, verificationStatus } = {}) {
      if (!divisions.length) return [];
      const rows = await db.query(
        `SELECT * FROM attendance_records WHERE division_id IN (${placeholders(divisions)})
           AND (? IS NULL OR journey_id = ?) AND (? IS NULL OR employee_id = ?) AND (? IS NULL OR stage = ?)
           AND (? IS NULL OR verification_status = ?)
         ORDER BY COALESCE(device_timestamp, server_timestamp, created_at) DESC, stage DESC`,
        [...divisions, journeyId ?? null, journeyId ?? null, employeeId ?? null, employeeId ?? null, stage ?? null, stage ?? null,
          verificationStatus ?? null, verificationStatus ?? null],
      );
      return rows.map(attendanceOut);
    },

    async pendingForJourney(journeyId) {
      return db.query(
        "SELECT id, employee_id, stage FROM attendance_records WHERE journey_id = ? AND sync_status = 'pending'",
        [journeyId],
      );
    },

    // What `missed` has to be judged against: the day the train leaves and the division's grace.
    async missedContext(journeyId) {
      const [row] = await db.query('SELECT journey_date, division_id FROM journeys WHERE id = ?', [journeyId]);
      return { journeyDate: row?.journey_date ?? null, policy: row ? await masters?.getPolicy(row.division_id) : null };
    },

    // Same shape as GET /attendance/journeys/{id}/status, plus 'pending' cells for unsynced records.
    async journeyStatus(journeyId) {
      const [staff, records, [journey], context] = await Promise.all([
        journeys.activeStaff(journeyId),
        db.query(`SELECT id, employee_id, stage, sync_status FROM attendance_records WHERE journey_id = ? AND ${LIVE}`, [journeyId]),
        db.query('SELECT attendance_stages FROM journeys WHERE id = ?', [journeyId]),
        this.missedContext(journeyId),
      ]);
      const plan = stagesOf(journey);
      return staff.map((s) => {
        const mine = records.filter((r) => r.employee_id === s.user_id);
        const taken = new Map(mine.filter((r) => r.sync_status === 'synced').map((r) => [r.stage, r.id]));
        const pending = new Map(mine.filter((r) => r.sync_status === 'pending').map((r) => [r.stage, r.id]));
        return { employee_id: s.user_id, name: s.name, emp_id: s.emp_id, role_id: s.role_id,
          ...attendanceCells(plan, taken, pending, context) };
      });
    },

    // Adds this device's unsynced records to a server status response. Which stages are missed comes from
    // the server's own cells, not from this device's clock.
    async overlayStatus(journeyId, rows) {
      const pending = await this.pendingForJourney(journeyId);
      if (!pending.length) return rows;
      return rows.map((r) => {
        const taken = new Map(r.stages.filter((c) => c.status === 'taken').map((c) => [c.stage, c.attendance_id]));
        const mine = new Map(pending.filter((p) => p.employee_id === r.employee_id && !taken.has(p.stage)).map((p) => [p.stage, p.id]));
        const missed = new Set(r.stages.filter((c) => c.status === 'missed').map((c) => c.stage));
        return mine.size ? { ...r, ...attendanceCells(planOf(r.stages), taken, mine, { missed }) } : r;
      });
    },

    async countOn(divisionId, date) {
      const [row] = await db.query(
        `SELECT COUNT(*) AS n FROM attendance_records WHERE division_id = ? AND captured_on = ? AND ${LIVE}`,
        [divisionId, date],
      );
      return row.n;
    },
  };
}
