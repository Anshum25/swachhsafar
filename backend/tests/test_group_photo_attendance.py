"""Attendance marked from one photograph of a group.

This is the weakest proof the app offers: a single frame holds many faces, and no face in it has been
watched over time for the blink that distinguishes a person from a photograph of one. The rules that
remain are therefore about who is answerable and what is actually claimed -- the division must have
turned it on, only the journey supervisor or a reviewer may submit it, a match distance is still judged
when one is offered, and the record records that it came from a group photo so no report can read it as
a live per-person check.
"""
from app.models import Attendance
from tests.test_attendance import punch
from tests.test_faces import MODEL, enroll, set_policy


def group_punch(world, employee, stage=1, by="sup", **extra):
    return punch(world, employee, stage, by=by, group_photo=True, **extra)


def test_refused_unless_the_division_turned_it_on(world):
    r, _ = group_punch(world, "jan")
    assert r.status_code == 422 and r.json()["error"]["code"] == "group_photo_not_allowed"
    set_policy(world, attendance_group_photo=True)
    r, _ = group_punch(world, "jan")
    assert r.status_code == 201, r.text


def test_only_the_supervisor_or_a_reviewer_may_attest(world):
    set_policy(world, attendance_group_photo=True)
    # The employee marking themselves present from a group photo leaves no second party to the record,
    # even though they may submit an ordinary capture of their own.
    r, _ = group_punch(world, "jan", by="jan")
    assert r.status_code == 403 and r.json()["error"]["code"] == "group_photo_not_authorized"
    r, _ = punch(world, "jan", 1, by="jan")
    assert r.status_code == 201, r.text


def test_records_how_identity_was_established(world, db):
    set_policy(world, attendance_group_photo=True)
    r, _ = group_punch(world, "jan")
    assert r.status_code == 201
    assert r.json()["identified_by"] == "group_photo"
    assert db.get(Attendance, r.json()["id"]).identified_by == "group_photo"
    # An ordinary capture in a division asking for no proof claims nothing about how it was identified.
    r2, _ = punch(world, "jan", 2)
    assert r2.json()["identified_by"] is None


def test_a_claimed_match_is_still_judged(world):
    set_policy(world, attendance_group_photo=True, face_match_threshold=0.5)
    enroll(world)
    # Recognised in the photo and confirmed: the distance is kept as evidence and must hold up.
    r, _ = group_punch(world, "jan", face_distance=0.3, face_model=MODEL)
    assert r.status_code == 201 and r.json()["face_distance"] == 0.3
    r, _ = group_punch(world, "jan", 2, face_distance=0.62, face_model=MODEL)
    assert r.status_code == 422 and r.json()["error"]["code"] == "face_mismatch"
    # A distance against a model this employee was never registered with proves nothing.
    r, _ = group_punch(world, "jan", 2, face_distance=0.2, face_model="other-model")
    assert r.status_code == 422 and r.json()["error"]["code"] == "face_not_verified"


def test_a_name_supplied_by_the_supervisor_claims_no_match(world):
    set_policy(world, attendance_group_photo=True, attendance_face_verification=True)
    # No registered face and no distance: the supervisor's attestation stands on its own, where an
    # ordinary capture in this division would be refused for want of a face check.
    r, _ = group_punch(world, "jan")
    assert r.status_code == 201, r.text
    assert r.json()["face_distance"] is None and r.json()["identified_by"] == "group_photo"
    r, _ = punch(world, "jan", 2)
    assert r.status_code == 422 and r.json()["error"]["code"] == "face_not_enrolled"


def test_liveness_is_not_demanded_of_a_group_photo_but_a_photo_is(world):
    # A single frame cannot show that any one face blinked, so a division that asks for liveness of a
    # per-person capture cannot be asking it of this one; the photo itself is still required, because
    # each record keeps that person's face cut out of the group frame.
    set_policy(world, attendance_group_photo=True, attendance_face_verification=True,
               face_liveness_required=True, attendance_photo_required=True)
    r, _ = group_punch(world, "jan")
    assert r.status_code == 201, r.text
    r, _ = group_punch(world, "jan", 2, photo=False)
    assert r.status_code == 422 and r.json()["error"]["code"] in ("photo_required", "media_required")


def test_every_other_attendance_rule_still_applies(world):
    set_policy(world, attendance_group_photo=True)
    # Stage order, one record per stage, and allocation are unchanged: a group photo is another route to
    # the same record, not a way around the rules that do not depend on watching one face.
    r, _ = group_punch(world, "jan", 2)
    assert r.status_code == 422 and r.json()["error"]["code"] == "stage_order"
    r, _ = group_punch(world, "jan", 1)
    assert r.status_code == 201
    r, _ = group_punch(world, "jan", 1)
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_attendance"
    r, _ = group_punch(world, "jan2", 1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_allocated"
