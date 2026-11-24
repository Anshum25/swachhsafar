// Attendance marked from one photograph of a group, checked on the device the way the server checks it
// (local mirror of backend attendance._check_group_photo), on a real SQLite database.
//
// A group photo is the weakest proof the app offers: one frame, many faces, and no face watched over time
// for the blink that tells a person from a photograph of one. So most of what these tests pin down is the
// conditions under which the device refuses to send it at all, and the fact that a record made this way
// carries only what was actually established -- a match distance when the device recognised someone, and
// nothing when the supervisor supplied the name.
import { describe, expect, it } from 'vitest';
import { IDS, actorFor, attendancePayload, changesFixture, seededStore } from '../helpers/operationalFixtures.js';

const MODEL = 'faceapi-resnet128-v1';

// A division with the group photo allowed, and optionally the per-person face check on as well.
const withPolicy = (extra, today) => {
  const c = changesFixture(today);
  c.policies = Object.fromEntries(Object.entries(c.policies).map(([d, p]) => [d, { ...p, ...extra }]));
  return c;
};
const groupOn = (extra = {}) => withPolicy({ attendance_group_photo: true, face_match_threshold: 0.5, ...extra });
const profile = (userId) => ({ user_id: userId, division_id: IDS.division, model: MODEL, descriptors: [[0.1], [0.1], [0.1], [0.1]], updated_at: '2026-11-04T00:00:00Z' });

// The supervisor of the fixture journey is the one the server would accept a group photo from.
const groupCapture = (extra = {}, actor = actorFor(IDS.supervisor)) => ({
  ...attendancePayload({ group_photo: true, ...extra }), actor,
});

describe('group photo attendance on the device', () => {
  it('refuses a group photo in a division that has not turned it on', async () => {
    const { store } = await seededStore();
    await store.ingestChanges(changesFixture());   // attendance_group_photo defaults to off
    await expect(store.capture(groupCapture())).rejects.toMatchObject({ code: 'group_photo_not_allowed' });
  });

  it('accepts it only from the journey supervisor or a reviewer, never the employee alone', async () => {
    const { store } = await seededStore();
    await store.ingestChanges(groupOn());
    // The employee marking themselves present from a group photo leaves no second party to the record.
    const self = actorFor(IDS.janitor1, ['attendance.submit']);
    await expect(store.capture(groupCapture({}, self))).rejects.toMatchObject({ code: 'group_photo_not_authorized' });
    await store.capture(groupCapture());   // the supervisor may
  });

  it('keeps the match distance when the device recognised the face, and claims nothing when it did not', async () => {
    const { store } = await seededStore();
    await store.ingestChanges({ ...groupOn(), face_profiles: [profile(IDS.janitor1)] });

    // Recognised and confirmed: the distance travels with the record as evidence.
    const matched = groupCapture({ face_distance: 0.3, face_model: MODEL });
    await store.capture(matched);
    const [a] = await store.db.query('SELECT payload FROM sync_outbox WHERE entity_id = ?', [matched.payload.id]);
    expect(JSON.parse(a.payload).op.payload).toMatchObject({ group_photo: true, face_distance: 0.3 });

    // Named by the supervisor: no distance, and the record says so rather than implying a match.
    const manual = groupCapture({ employee_id: IDS.janitor2, stage: 1 });
    await store.capture(manual);
    const [b] = await store.db.query('SELECT payload FROM sync_outbox WHERE entity_id = ?', [manual.payload.id]);
    const sent = JSON.parse(b.payload).op.payload;
    expect(sent.group_photo).toBe(true);
    expect(sent.face_distance ?? null).toBeNull();
  });

  it('still refuses a claimed match that is wrong, or that names a face nobody registered', async () => {
    const { store } = await seededStore();
    await store.ingestChanges({ ...groupOn(), face_profiles: [profile(IDS.janitor1)] });
    // Above the division's threshold: a distance offered as evidence has to hold up.
    await expect(store.capture(groupCapture({ face_distance: 0.62, face_model: MODEL })))
      .rejects.toMatchObject({ code: 'face_mismatch' });
    // A distance against a model this employee was never registered with proves nothing.
    await expect(store.capture(groupCapture({ face_distance: 0.2, face_model: 'other' })))
      .rejects.toMatchObject({ code: 'face_not_verified' });
    await expect(store.capture(groupCapture({ employee_id: IDS.janitor2, face_distance: 0.2, face_model: MODEL })))
      .rejects.toMatchObject({ code: 'face_not_verified' });
  });

  it('does not demand the per-person face check of a group photo, but keeps every other rule', async () => {
    const { store } = await seededStore();
    // Face verification on as well: a group photo is a different route to the same record, not a way
    // around the rules that do not depend on watching one face.
    await store.ingestChanges({ ...groupOn({ attendance_face_verification: true }), face_profiles: [profile(IDS.janitor1)] });
    await store.capture(groupCapture({ employee_id: IDS.janitor2 }));   // no face result needed
    // A photo is still required: each record keeps this person's face, cut out of the group frame.
    await expect(store.capture(groupCapture({ employee_id: IDS.janitor1, photo_media_id: null })))
      .rejects.toMatchObject({ code: 'photo_required' });
    // Stage order and one-record-per-stage are unchanged.
    await expect(store.capture(groupCapture({ employee_id: IDS.janitor2 })))
      .rejects.toMatchObject({ code: 'duplicate_attendance' });
    await expect(store.capture(groupCapture({ employee_id: IDS.janitor2, stage: 3 })))
      .rejects.toMatchObject({ code: 'stage_order' });
    // Somebody who is not on this journey cannot be named present on it.
    await expect(store.capture(groupCapture({ employee_id: IDS.outsider })))
      .rejects.toMatchObject({ code: 'not_allocated' });
  });

  it('reads the registered faces of a named set of staff, and only those', async () => {
    const { store } = await seededStore();
    await store.ingestChanges({ ...groupOn(), face_profiles: [profile(IDS.janitor1), profile(IDS.janitor2)] });
    const found = await store.masters.faceProfilesFor([IDS.janitor1, IDS.outsider]);
    expect(found.map((f) => f.user_id)).toEqual([IDS.janitor1]);
    expect(found[0].descriptors).toEqual([[0.1], [0.1], [0.1], [0.1]]);
    expect(await store.masters.faceProfilesFor([])).toEqual([]);
    expect(await store.masters.faceProfilesFor(undefined)).toEqual([]);
    // Duplicates in the candidate list must not duplicate a person in the answer.
    expect(await store.masters.faceProfilesFor([IDS.janitor1, IDS.janitor1])).toHaveLength(1);
  });
});
