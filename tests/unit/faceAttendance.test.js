// Offline attendance with face verification on (local mirror of backend attendance._check_face), on a real
// SQLite database: blocked without a registered face, without a result, with another model or above the
// threshold; allowed within it. Face profiles from /sync/changes replace the device's copy.
import { describe, expect, it } from 'vitest';
import { IDS, attendancePayload, changesFixture, seededStore } from '../helpers/operationalFixtures.js';

const MODEL = 'faceapi-resnet128-v1';
const faceOn = (today) => {
  const c = changesFixture(today);
  c.policies = Object.fromEntries(Object.entries(c.policies).map(([d, p]) => [d, { ...p, attendance_face_verification: true, face_match_threshold: 0.5 }]));
  return c;
};
const profile = (userId) => ({ user_id: userId, division_id: IDS.division, model: MODEL, descriptors: [[0.1], [0.1], [0.1], [0.1]], updated_at: '2026-11-04T00:00:00Z' });

describe('face-verified attendance on the device', () => {
  it('blocks attendance until the face is registered and matched', async () => {
    const { store } = await seededStore();
    await store.ingestChanges({ ...faceOn(), face_profiles: [] });
    await expect(store.capture(attendancePayload({ face_distance: 0.2, face_model: MODEL }))).rejects.toMatchObject({ code: 'face_not_enrolled' });

    await store.ingestChanges({ ...faceOn(), face_profiles: [profile(IDS.janitor1)] });
    await expect(store.capture(attendancePayload())).rejects.toMatchObject({ code: 'face_not_verified' });
    await expect(store.capture(attendancePayload({ face_distance: 0.2, face_model: 'other' }))).rejects.toMatchObject({ code: 'face_not_verified' });
    await expect(store.capture(attendancePayload({ face_distance: 0.62, face_model: MODEL }))).rejects.toMatchObject({ code: 'face_mismatch' });
    await expect(store.capture(attendancePayload({ face_distance: 0.4, face_model: MODEL, photo_media_id: null }))).rejects.toMatchObject({ code: 'photo_required' });

    const ok = attendancePayload({ face_distance: 0.31, face_model: MODEL });
    await store.capture(ok);
    const [queued] = await store.db.query("SELECT payload FROM sync_outbox WHERE entity_id = ?", [ok.payload.id]);
    expect(JSON.parse(queued.payload).op.payload).toMatchObject({ face_distance: 0.31, face_model: MODEL }); // sent to the server
  });

  it('replaces face profiles on every pull and leaves them alone when the server sends none', async () => {
    const { store } = await seededStore();
    await store.ingestChanges({ ...faceOn(), face_profiles: [profile(IDS.janitor1), profile(IDS.janitor2)] });
    expect(await store.masters.getFaceProfile(IDS.janitor2)).toMatchObject({ model: MODEL, descriptors: [[0.1], [0.1], [0.1], [0.1]] });
    await store.ingestChanges({ ...faceOn(), face_profiles: [profile(IDS.janitor1)] }); // janitor2's registration removed
    expect(await store.masters.getFaceProfile(IDS.janitor2)).toBeNull();
    await store.ingestChanges(faceOn()); // older server: no face_profiles field -> unchanged
    expect(await store.masters.getFaceProfile(IDS.janitor1)).not.toBeNull();
  });

  it('does not require faces when the division has verification off', async () => {
    const { store } = await seededStore();
    await expect(store.capture(attendancePayload())).resolves.toBeTruthy();
  });
});
