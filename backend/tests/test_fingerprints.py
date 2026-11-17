"""Fingerprint verification of attendance: registration (minutiae templates only, consent required), what
devices receive, and how it behaves beside the face check rather than instead of it."""
import base64

from sqlalchemy import select

from app.models import AuditLog, FingerprintEnrollment
from tests.test_attendance import punch

API = "/api/v1"
FORMAT = "iso-19794-2"
MATCHER = "acpl-sdk-v1"


def template(seed: int = 1) -> str:
    # Shaped like a minutiae record rather than an image: a few hundred bytes of opaque data.
    return base64.b64encode(bytes((seed + i) % 251 for i in range(320))).decode()


# A finger is registered from several presses, not one: a single press records only the part of the
# fingertip that happened to touch the sensor (see docs/FINGERPRINT.md).
SAMPLES = 4


def fingers(*names, samples: int = SAMPLES):
    return [{"finger": n, "templates": [template(i * 10 + j + 1) for j in range(samples)]}
            for i, n in enumerate(names or ("right_index", "left_index"))]


def enroll(world, who="jan", by="admin", **over):
    body = {"format": FORMAT, "matcher": MATCHER, "fingers": fingers(), "consent": True, **over}
    return world.client.put(f"{API}/users/{world.users[who].id}/fingerprint", headers=world.h(by), json=body)


def set_policy(world, **settings):
    r = world.client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin"), json=settings)
    assert r.status_code == 200, r.text


def test_registration_requires_consent_permission_and_two_fingers(world, db):
    assert enroll(world, consent=False).status_code == 422
    # One finger is refused on purpose: a cut or a bandage would otherwise lock someone out of a shift.
    assert enroll(world, fingers=fingers("right_index")).status_code == 422
    assert enroll(world, fingers=fingers("right_index", "right_index")).status_code == 422  # same finger twice
    assert enroll(world, fingers=[{"finger": "right_index", "templates": ["not base64!!"]},
                                  {"finger": "left_index", "templates": [template()]}]).status_code == 422
    # An image-sized payload is not a minutiae template.
    big = base64.b64encode(b"x" * 5000).decode()
    assert enroll(world, fingers=[{"finger": "right_index", "templates": [big]},
                                  {"finger": "left_index", "templates": [template()]}]).status_code == 422
    # A press that is not sent at all, and more presses of one finger than are ever taken.
    assert enroll(world, fingers=[{"finger": "right_index", "templates": []},
                                  {"finger": "left_index", "templates": [template()]}]).status_code == 422
    assert enroll(world, fingers=fingers("right_index", "left_index", samples=9)).status_code == 422
    # One press per finger is still accepted: a device registered before multi-press enrolment existed
    # must not be refused by a server it was working with yesterday.
    assert enroll(world, fingers=fingers(samples=1)).status_code == 200
    assert enroll(world, by="sup").status_code == 403  # supervisors cannot register fingerprints

    r = enroll(world)
    assert r.status_code == 200, r.text
    assert r.json()["enrolled"] and r.json()["fingers"] == ["right_index", "left_index"]
    status = world.client.get(f"{API}/users/{world.users['jan'].id}/fingerprint", headers=world.h("admin")).json()
    assert status["enrolled"] and status["format"] == FORMAT and status["matcher"] == MATCHER
    assert "template" not in str(status)  # a status never carries templates

    # The audit says which fingers, never a template.
    events = db.scalars(select(AuditLog).where(AuditLog.action == "user.fingerprint.enroll")).all()
    assert len(events) == 1
    assert "right_index" in str(events[0].changes) and template(1) not in str(events[0].changes)

    assert world.client.delete(f"{API}/users/{world.users['jan'].id}/fingerprint", headers=world.h("admin")).status_code == 204
    db.rollback()  # end this session's read snapshot (SQLite WAL) so the API's delete is visible
    assert db.get(FingerprintEnrollment, world.users["jan"].id) is None


def test_devices_receive_templates_only_when_on_and_only_for_their_staff(world):
    assert enroll(world).status_code == 200
    changes = lambda who: world.client.get(f"{API}/sync/changes", headers=world.h(who)).json()  # noqa: E731
    assert changes("sup")["fingerprint_profiles"] == []  # division has fingerprint verification off
    set_policy(world, attendance_fingerprint_verification=True)
    sup = changes("sup")["fingerprint_profiles"]
    assert [p["user_id"] for p in sup] == [str(world.users["jan"].id)] and len(sup[0]["fingers"]) == 2
    assert changes("jan")["fingerprint_profiles"][0]["user_id"] == str(world.users["jan"].id)  # own profile
    assert changes("sup2")["fingerprint_profiles"] == []  # not this journey's supervisor
    assert changes("manager_b")["fingerprint_profiles"] == []  # other division


def test_attendance_blocked_without_a_verified_match_when_required(world):
    set_policy(world, attendance_fingerprint_verification=True, fingerprint_match_score=40)
    r, _ = punch(world, "jan", 1, fingerprint_score=60, fingerprint_matcher=MATCHER, fingerprint_finger="right_index")
    assert r.status_code == 422 and r.json()["error"]["code"] == "fingerprint_not_enrolled"
    assert enroll(world).status_code == 200
    r, _ = punch(world, "jan", 1)
    assert r.json()["error"]["code"] == "fingerprint_not_verified"
    r, _ = punch(world, "jan", 1, fingerprint_score=60, fingerprint_matcher="someone-elses-sdk")
    assert r.json()["error"]["code"] == "fingerprint_not_verified"
    r, _ = punch(world, "jan", 1, fingerprint_score=39, fingerprint_matcher=MATCHER, fingerprint_finger="right_index")
    assert r.status_code == 422 and r.json()["error"]["code"] == "fingerprint_mismatch"
    r, _ = punch(world, "jan", 1, fingerprint_score=40, fingerprint_matcher=MATCHER, fingerprint_finger="right_index")
    assert r.status_code == 201, r.text
    assert r.json()["fingerprint_score"] == 40 and r.json()["fingerprint_finger"] == "right_index"


def test_fingerprint_needs_no_photo_of_its_own(world):
    """A photo is required because the division asks for one, or because the face check needs something to
    match against. Fingerprint verification adds no requirement of its own: with photos switched off, a
    fingerprint capture stands on its own."""
    set_policy(world, attendance_fingerprint_verification=True, attendance_photo_required=False)
    assert enroll(world).status_code == 200
    r, _ = punch(world, "jan", 1, photo=False, fingerprint_score=80, fingerprint_matcher=MATCHER)
    assert r.status_code == 201, r.text
    # Switching the division's own photo rule back on requires one again.
    set_policy(world, attendance_fingerprint_verification=True, attendance_photo_required=True)
    r, _ = punch(world, "jan", 2, photo=False, fingerprint_score=80, fingerprint_matcher=MATCHER)
    assert r.status_code == 422
    # And face verification still requires a photo, since that is what it matches against.
    set_policy(world, attendance_face_verification=True, attendance_fingerprint_verification=True,
               attendance_photo_required=False)
    r, _ = punch(world, "jan", 2, photo=False, face_distance=0.2, face_model="faceapi-resnet128-v1")
    assert r.status_code == 422


def test_either_biometric_satisfies_a_division_that_asks_for_both(world):
    """The scanner is separate hardware that can be absent or broken; a phone without it must still be able
    to mark attendance by face, and a capture with a fingerprint must not also need a face match."""
    from tests.test_fingerprints import MATCHER as M
    from tests.test_faces import MODEL, enroll as enroll_face

    set_policy(world, attendance_face_verification=True, attendance_fingerprint_verification=True,
               face_match_threshold=0.5, fingerprint_match_score=40)
    assert enroll(world).status_code == 200
    assert enroll_face(world).status_code == 200

    r, _ = punch(world, "jan", 1, face_distance=0.2, face_model=MODEL)  # face only
    assert r.status_code == 201, r.text
    r, _ = punch(world, "jan", 2, fingerprint_score=90, fingerprint_matcher=M)  # fingerprint only
    assert r.status_code == 201, r.text
    r, _ = punch(world, "jan", 3)  # neither
    assert r.status_code == 422 and r.json()["error"]["code"] == "face_not_verified"
    # A fingerprint that is offered and fails is not quietly retried as a face check.
    r, _ = punch(world, "jan", 3, fingerprint_score=10, fingerprint_matcher=M, face_distance=0.2, face_model=MODEL)
    assert r.status_code == 422 and r.json()["error"]["code"] == "fingerprint_mismatch"


def test_attendance_unchanged_when_fingerprint_verification_is_off(world):
    r, _ = punch(world, "jan", 1)
    assert r.status_code == 201 and r.json()["fingerprint_score"] is None
