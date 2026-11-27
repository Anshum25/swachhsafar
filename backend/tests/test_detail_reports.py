"""Row-level work statements: inspection list, PSI statement, attendance summary and journey report."""

import uuid

from sqlalchemy import update

from app.models import Question
from app.timeutil import today_ist
from tests.factories import now_iso, upload
from tests.test_feedback import ratings, verified_feedback

API = "/api/v1"


def _ok(r):
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_detail_reports(world, fakes, db):
    c, H = world.client, world.h
    j = world.journey
    other = world.create_journey(staff=["jan2"], train=world.create_train(train_no="12002"))
    today = today_ist().isoformat()

    for stage in (1, 2):
        _ok(c.post(f"{API}/attendance", headers=H("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=j["id"], employee_id=str(world.users["jan"].id), stage=stage,
            device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
            photo_media_id=upload(c, world.sup, world.a.id, "attendance_photo"))))
    _ok(c.post(f"{API}/inspections", headers=H("sup"), json=dict(
        id=str(uuid.uuid4()), journey_id=j["id"], coach_code="B1", day=1, round=1, phase="A", comments="Clean",
        device_timestamp=now_iso(), latitude=1, longitude=1,
        photo_media_id=upload(c, world.sup, world.a.id, "inspection_photo"))))
    fb = verified_feedback(world, fakes, pnr="1111111111", mobile="9111111111")
    _ok(c.post(f"{API}/feedback/passenger/{fb['id']}/complete", headers=H("sup"),
               json={"ratings": [{**r, "value": v} for r, v in zip(ratings(world), [5, 3])]}))

    hm = H("manager")
    q = dict(date_from=today, date_to=today, train_id=j["train_id"])

    insp = _ok(c.get(f"{API}/reports/inspection-list", headers=hm, params=q))
    assert [(i["coach_code"], i["phase"], i["comments"]) for i in insp["items"]] == [("B1", "A", "Clean")]
    assert insp["items"][0]["photo_media_id"]
    # PSI needs weights, exactly like the PSI report.
    # no PSI weights set: every question counts equally, the statement is still produced
    assert c.get(f"{API}/reports/psi-statement", headers=hm, params=q).status_code == 200
    db.execute(update(Question).where(Question.bank_id == uuid.UUID(world.passenger_bank["id"])).values(psi_weight=1))
    db.commit()
    psi = _ok(c.get(f"{API}/reports/psi-statement", headers=hm, params=q))
    assert len(psi["journeys"]) == 1
    rows = {r["coach_code"]: r for r in psi["journeys"][0]["coaches"]}
    rated = [r for r in rows.values() if r["average"] is not None]
    assert len(rated) == 1 and 0 <= rated[0]["average"] <= 100

    att = _ok(c.get(f"{API}/reports/attendance-summary", headers=hm, params=q))
    journey = att["journeys"][0]
    jan = next(s for s in journey["staff"] if s["user_id"] == str(world.users["jan"].id))
    assert jan["slot"].startswith("G") and jan["stages"][:2] == [True, True] and jan["present"]
    assert journey["present"] >= 1 and journey["target"] == len(journey["staff"])

    rep = _ok(c.get(f"{API}/reports/journey-report", headers=hm, params=q))
    row = rep["journeys"][0]
    assert row["attendance_done"] == 2 and row["inspections_done"] == 1 and row["feedback_done"] == 1
    assert row["attendance_expected"] == row["staff"] * len(journey["stages"])

    # Without a train every journey in the period is listed.
    allq = dict(date_from=today, date_to=today)
    ids = {r["journey_id"] for r in _ok(c.get(f"{API}/reports/journey-report", headers=hm, params=allq))["journeys"]}
    assert {j["id"], other["id"]} <= ids
