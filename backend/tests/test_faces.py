"""Face verification of attendance: registration (descriptors only, consent required), what devices receive,
and enforcement when a division switches it on."""
from sqlalchemy import select

from app.models import AuditLog, FaceEnrollment
from tests.test_attendance import punch

API = "/api/v1"
MODEL = "faceapi-resnet128-v1"


def descriptors(base=0.1):
    return [[round(base + i * 0.001 + k * 0.0001, 6) for i in range(128)] for k in range(4)]


def enroll(world, who="jan", by="admin", **over):
    body = {"model": MODEL, "descriptors": descriptors(), "consent": True, **over}
    return world.client.put(f"{API}/users/{world.users[who].id}/face", headers=world.h(by), json=body)


def set_policy(world, **settings):
    r = world.client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin"), json=settings)
    assert r.status_code == 200, r.text


def test_registration_requires_consent_permission_and_four_descriptors(world, db):
    assert enroll(world, consent=False).status_code == 422
    assert enroll(world, descriptors=descriptors()[:3]).status_code == 422
    assert enroll(world, descriptors=[[0.1] * 127] * 4).status_code == 422
    assert enroll(world, by="sup").status_code == 403  # supervisors cannot register faces
    r = enroll(world)
    assert r.status_code == 200 and r.json()["enrolled"] and r.json()["samples"] == 4
    status = world.client.get(f"{API}/users/{world.users['jan'].id}/face", headers=world.h("admin")).json()
    assert status["enrolled"] and status["model"] == MODEL and "descriptors" not in status
    # Audit records the change but never the descriptors.
    events = db.scalars(select(AuditLog).where(AuditLog.action == "user.face.enroll")).all()
    assert len(events) == 1 and "descriptors" not in str(events[0].changes)
    assert world.client.delete(f"{API}/users/{world.users['jan'].id}/face", headers=world.h("admin")).status_code == 204
    db.rollback()  # end this session's read snapshot (SQLite WAL) so the API's delete is visible
    assert db.get(FaceEnrollment, world.users["jan"].id) is None


def test_devices_receive_descriptors_only_when_on_and_only_for_their_staff(world):
    assert enroll(world).status_code == 200
    changes = lambda who: world.client.get(f"{API}/sync/changes", headers=world.h(who)).json()  # noqa: E731
    assert changes("sup")["face_profiles"] == []  # division has face verification off
    set_policy(world, attendance_face_verification=True)
    sup = changes("sup")["face_profiles"]
    assert [p["user_id"] for p in sup] == [str(world.users["jan"].id)] and len(sup[0]["descriptors"]) == 4
    assert changes("jan")["face_profiles"][0]["user_id"] == str(world.users["jan"].id)  # own profile
    assert changes("sup2")["face_profiles"] == []  # not this journey's supervisor
    assert changes("manager_b")["face_profiles"] == []  # other division


def test_attendance_blocked_without_a_verified_match_when_required(world):
    set_policy(world, attendance_face_verification=True, face_match_threshold=0.5)
    r, _ = punch(world, "jan", 1, face_distance=0.2, face_model=MODEL)
    assert r.status_code == 422 and r.json()["error"]["code"] == "face_not_enrolled"
    assert enroll(world).status_code == 200
    r, _ = punch(world, "jan", 1)
    assert r.json()["error"]["code"] == "face_not_verified"
    r, _ = punch(world, "jan", 1, face_distance=0.2, face_model="other-model")
    assert r.json()["error"]["code"] == "face_not_verified"
    r, _ = punch(world, "jan", 1, face_distance=0.61, face_model=MODEL)
    assert r.status_code == 422 and r.json()["error"]["code"] == "face_mismatch"
    r, body = punch(world, "jan", 1, face_distance=0.31, face_model=MODEL)
    assert r.status_code == 201, r.text
    assert r.json()["face_distance"] == 0.31 and r.json()["face_model"] == MODEL
    # A photo is required while face verification is on.
    r, _ = punch(world, "jan", 2, photo=False, face_distance=0.2, face_model=MODEL)
    assert r.status_code == 422


def test_a_record_queued_by_an_older_app_with_a_liveness_proof_still_syncs(world):
    # App builds that briefly had server-issued liveness challenges sent `liveness_proof`. Records they
    # queued offline must still be accepted; the proof is ignored.
    set_policy(world, attendance_face_verification=True, face_match_threshold=0.5)
    assert enroll(world).status_code == 200
    proof = {"challenge_id": "c1", "signature": "a" * 64, "steps": [{"action": "blink"}]}
    r, _ = punch(world, "jan", 1, face_distance=0.3, face_model=MODEL, liveness_proof=proof)
    assert r.status_code == 201, r.text


def test_attendance_unchanged_when_face_verification_is_off(world):
    r, _ = punch(world, "jan", 1)
    assert r.status_code == 201 and r.json()["face_distance"] is None
