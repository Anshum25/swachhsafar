"""Server-side enforcement of live face verification for attendance.

These cover what the server can decide on its own: a face match alone never authorises attendance, the
liveness proof must answer a challenge this server issued to this user on this device, in the order it
chose, in time, and only once. The on-device checks (blink, head movement, 3-D depth) are unit-tested in
tests/unit/liveness*.test.js; real-device spoofing tests are recorded in docs/SECURITY_TEST_REPORT.md."""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.models import Attendance, LivenessChallenge
from app.services.liveness import random_actions
from tests.test_attendance import punch
from tests.test_faces import MODEL, enroll, set_policy

API = "/api/v1/attendance/liveness/challenges"


def challenges(world, by="sup", count=3):
    r = world.client.post(API, headers=world.h(by), json={"count": count})
    assert r.status_code == 200, r.text
    return r.json()


def proof_for(c, *, actions=None, at=None, depth=0.2, drift=0.2, camera="camera2 1, facing front", span=4.0):
    end = at or datetime.now(timezone.utc) - timedelta(seconds=1)
    start = end - timedelta(seconds=span)
    acts = actions or c["actions"]
    step = span / (len(acts) + 1)
    return {
        "challenge_id": c["id"], "signature": c["signature"],
        "steps": [{"action": a, "at": (start + timedelta(seconds=step * (i + 1))).isoformat()} for i, a in enumerate(acts)],
        "started_at": start.isoformat(), "completed_at": end.isoformat(),
        "depth_score": depth, "identity_drift": drift, "frames": 120, "camera_label": camera,
    }


def live_face(world, by="sup", **over):
    """The fields a genuine live face capture sends."""
    c = challenges(world, by, count=1)[0]
    return dict(face_distance=0.3, face_model=MODEL, security={"liveness": "passed"}, liveness_proof=proof_for(c, **over))


def face_on(world):
    set_policy(world, attendance_face_verification=True, face_match_threshold=0.5)
    assert enroll(world).status_code == 200


def code(r):
    return r.json()["error"]["code"]


def test_actions_are_random_and_always_include_a_turn_and_a_blink():
    seen = {tuple(random_actions()) for _ in range(300)}
    assert len(seen) > 20  # not a fixed sequence
    for s in seen:
        assert len(s) == 3 and len(set(s)) == 3
        assert "blink" in s and ({"turn_left", "turn_right"} & set(s))


def test_challenges_are_bound_to_the_requesting_user_and_topped_up_not_piled_up(world):
    first = challenges(world, count=5)
    assert len(first) == 5 and all(len(c["signature"]) == 64 for c in first)
    again = challenges(world, count=5)
    assert {c["id"] for c in again} == {c["id"] for c in first}  # same pool returned, not new ones
    assert len(challenges(world, count=30)) == 30
    assert len(challenges(world, count=30)) == 30  # capped


def test_live_employee_accepted(world, db):
    face_on(world)
    r, body = punch(world, "jan", 1, **live_face(world))
    assert r.status_code == 201, r.text
    db.rollback()
    c = db.get(LivenessChallenge, uuid.UUID(body["liveness_proof"]["challenge_id"]))
    assert c.consumed_at is not None and str(c.attendance_id) == body["id"]
    rec = db.get(Attendance, uuid.UUID(body["id"]))
    assert rec.security["liveness_proof"]["challenge_id"] == str(c.id)


def test_direct_api_request_with_only_a_face_match_is_rejected(world):
    face_on(world)
    # A hand-built request that claims a match and a passed liveness check, without a challenge.
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, security={"liveness": "passed"})
    assert r.status_code == 422 and code(r) == "liveness_proof_required"


def test_forged_challenge_is_rejected(world):
    face_on(world)
    c = challenges(world, count=1)[0]
    fake = dict(c, id=str(uuid.uuid4()))
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(fake))
    assert r.status_code == 422 and code(r) == "liveness_challenge_invalid"
    bad_sig = dict(c, signature="0" * 64)
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(bad_sig))
    assert r.status_code == 422 and code(r) == "liveness_challenge_invalid"


def test_reused_challenge_and_replayed_evidence_are_rejected(world):
    face_on(world)
    fields = live_face(world)
    r, _ = punch(world, "jan", 1, **fields)
    assert r.status_code == 201, r.text
    # Same proof on a new record (next stage): the challenge is spent.
    r, _ = punch(world, "jan", 2, **fields)
    assert r.status_code == 422 and code(r) == "liveness_challenge_used"


def test_identical_resend_is_an_idempotent_replay_not_a_second_use(world):
    face_on(world)
    r, body = punch(world, "jan", 1, **live_face(world))
    assert r.status_code == 201
    again = world.client.post("/api/v1/attendance", headers=world.h("sup"), json=body)
    assert again.status_code == 200 and again.headers["Idempotent-Replayed"] == "true"


def test_another_users_challenge_cannot_be_used(world):
    face_on(world)
    theirs = challenges(world, by="jan", count=1)[0]  # issued to the employee
    r, _ = punch(world, "jan", 1, by="sup", face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(theirs))
    assert r.status_code == 422 and code(r) == "liveness_challenge_invalid"


def test_actions_not_performed_in_the_challenge_order_are_rejected(world):
    face_on(world)
    c = challenges(world, count=1)[0]
    wrong = list(reversed(c["actions"]))
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(c, actions=wrong))
    assert r.status_code == 422 and code(r) == "liveness_actions_mismatch"
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(c, actions=c["actions"][:2]))
    assert r.status_code == 422 and code(r) == "liveness_actions_mismatch"


def test_implausible_timing_is_rejected(world):
    face_on(world)
    c = challenges(world, count=1)[0]
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(c, span=0.2))
    assert r.status_code == 422 and code(r) == "liveness_timing"
    # Performed before the challenge existed.
    early = datetime.now(timezone.utc) - timedelta(hours=2)
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(c, at=early),
                 ts=(early + timedelta(seconds=5)).isoformat())
    assert r.status_code == 422 and code(r) == "liveness_timing"


def test_expired_challenge_is_rejected(world, db):
    face_on(world)
    c = challenges(world, count=1)[0]
    row = db.get(LivenessChallenge, uuid.UUID(c["id"]))
    row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=30)
    db.commit()
    # The signature covers the expiry, so re-read it the way the device would have received it.
    from app.services.liveness import sign
    c["signature"] = sign(row)
    r, _ = punch(world, "jan", 1, face_distance=0.1, face_model=MODEL, liveness_proof=proof_for(c))
    assert r.status_code == 422 and code(r) == "liveness_challenge_expired"


def test_flat_image_virtual_camera_and_changed_face_are_rejected(world):
    face_on(world)
    for over, expected in (({"depth": 0.01}, "liveness_spoof_suspected"),
                           ({"camera": "OBS Virtual Camera"}, "liveness_virtual_camera"),
                           ({"drift": 0.9}, "liveness_face_changed")):
        r, _ = punch(world, "jan", 1, **live_face(world, **over))
        assert r.status_code == 422 and code(r) == expected, (over, r.text)


def test_incorrect_employee_face_still_rejected_with_valid_liveness(world):
    face_on(world)
    fields = live_face(world)
    fields["face_distance"] = 0.8
    r, _ = punch(world, "jan", 1, **fields)
    assert r.status_code == 422 and code(r) == "face_mismatch"


def test_rejected_capture_does_not_burn_the_challenge(world, db):
    face_on(world)
    fields = live_face(world)
    r, _ = punch(world, "jan", 2, **fields)  # stage order violation, refused before liveness
    assert r.status_code == 422 and code(r) == "stage_order"
    r, _ = punch(world, "jan", 1, **fields)
    assert r.status_code == 201, r.text


def test_offline_capture_syncs_with_its_proof_and_cannot_skip_it(world, db):
    face_on(world)
    c = challenges(world, count=1)[0]  # fetched while online (an hour ago), used later offline
    row = db.get(LivenessChallenge, uuid.UUID(c["id"]))
    row.issued_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.commit()
    captured = datetime.now(timezone.utc) - timedelta(minutes=20)
    good = dict(id=str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.jan.id), stage=1,
                device_timestamp=(captured + timedelta(seconds=30)).isoformat(), latitude=23.18, longitude=79.98,
                gps_accuracy_m=10, face_distance=0.3, face_model=MODEL,
                liveness_proof=proof_for(c, at=captured + timedelta(seconds=20)))
    from tests.factories import upload
    good["photo_media_id"] = upload(world.client, world.sup, world.a.id, "attendance_photo")
    bad = dict(good, id=str(uuid.uuid4()), stage=2, liveness_proof=None)
    bad["photo_media_id"] = upload(world.client, world.sup, world.a.id, "attendance_photo")
    from tests.factories import TEST_DEVICE
    batch = {"device_id": TEST_DEVICE, "operations": [
        {"op_id": str(uuid.uuid4()), "type": "attendance.create", "payload": good},
        {"op_id": str(uuid.uuid4()), "type": "attendance.create", "payload": bad},
    ]}
    r = world.client.post("/api/v1/sync/batch", headers=world.h("sup"), json=batch)
    assert r.status_code == 200, r.text
    outcomes = [x["outcome"] for x in r.json()["results"]]
    assert outcomes == ["acknowledged", "rejected"], r.json()["results"][0].get("error")
    assert r.json()["results"][1]["error"]["code"] == "liveness_proof_required"


def test_fingerprint_and_non_face_attendance_unchanged(world):
    # Face verification off: no proof is asked for (the existing behaviour for these divisions).
    r, _ = punch(world, "jan", 1)
    assert r.status_code == 201, r.text


def test_challenge_issue_needs_attendance_permission(world):
    r = world.client.post(API, json={"count": 1})
    assert r.status_code == 401
