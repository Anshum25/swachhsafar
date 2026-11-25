from datetime import date, timedelta

from sqlalchemy import func, select

from app.models import Journey, JourneyState, JourneyStatus
from app.services.journeys import derive_dates, journey_state
from app.timeutil import today_ist

API = "/api/v1"


def test_date_derivation_and_boundaries():
    assert derive_dates(date(2026, 3, 10), 2) == (date(2026, 3, 12), date(2026, 3, 13))
    assert derive_dates(date(2026, 12, 30), 3) == (date(2027, 1, 2), date(2027, 1, 4))   # year boundary
    assert derive_dates(date(2028, 2, 27), 2) == (date(2028, 2, 29), date(2028, 3, 1))    # leap day / month boundary
    assert derive_dates(date(2026, 5, 1), 0) == (date(2026, 5, 1), date(2026, 5, 1))      # same-day train


def test_state_derivation():
    j = Journey(journey_date=date(2026, 1, 10), end_date=date(2026, 1, 12), status=JourneyStatus.PLANNED)
    assert journey_state(j, date(2026, 1, 9)) == JourneyState.SCHEDULED
    assert journey_state(j, date(2026, 1, 10)) == JourneyState.ACTIVE
    assert journey_state(j, date(2026, 1, 12)) == JourneyState.ACTIVE
    assert journey_state(j, date(2026, 1, 13)) == JourneyState.HISTORY
    j.status = JourneyStatus.CANCELLED
    assert journey_state(j, date(2026, 1, 11)) == JourneyState.CANCELLED


def test_create_derives_dates_and_snapshots(world):
    j = world.journey
    today = today_ist()
    assert j["linked_journey_date"] == str(today + timedelta(days=1))
    assert j["end_date"] == str(today + timedelta(days=1))
    assert [c["code"] for c in j["coaches"]] == ["B1", "S1"]
    assert j["inspection_rounds_per_day"] == 2
    assert {s["user_id"] for s in j["staff"]} == {str(world.sup.id), str(world.jan.id)}


def test_supervisor_and_staff_role_validation(client, world, db):
    before = db.scalar(select(func.count()).select_from(Journey))
    body = dict(division_id=str(world.a.id), train_id=world.train["id"], journey_date=str(today_ist()),
                supervisor_id=str(world.jan.id))
    assert client.post(f"{API}/journeys", headers=world.h("manager"), json=body).status_code == 422
    body.update(supervisor_id=str(world.sup.id), staff_ids=[str(world.jan.id), str(world.jan_b.id)])
    assert client.post(f"{API}/journeys", headers=world.h("manager"), json=body).status_code == 422
    assert db.scalar(select(func.count()).select_from(Journey)) == before  # nothing persisted on failure
    assert client.post(f"{API}/journeys", headers=world.h("sup"), json={**body, "staff_ids": []}).status_code == 403


def test_linked_train_and_override(client, world):
    linked = world.create_train(train_no="12002")
    j = world.create_journey(train=world.train, linked_train_id=linked["id"],
                             linked_journey_date=str(today_ist() + timedelta(days=3)))
    assert j["linked_train_no"] == "12002"
    assert j["linked_journey_date"] == str(today_ist() + timedelta(days=3))
    assert j["end_date"] == str(today_ist() + timedelta(days=3))
    r = client.post(f"{API}/journeys", headers=world.h("manager"), json=dict(
        division_id=str(world.a.id), train_id=world.train["id"], journey_date=str(today_ist()), supervisor_id=str(world.sup.id),
        end_date=str(today_ist() - timedelta(days=1))))
    assert r.status_code == 422


def test_visibility_for_field_staff(client, world):
    other = world.create_journey(supervisor_id=str(world.sup2.id), staff=["jan2"])
    ids = {j["id"] for j in client.get(f"{API}/journeys", headers=world.h("jan")).json()["items"]}
    assert ids == {world.journey["id"]}
    assert client.get(f"{API}/journeys/{other['id']}", headers=world.h("jan")).status_code == 404
    all_ids = {j["id"] for j in client.get(f"{API}/journeys", headers=world.h("manager")).json()["items"]}
    assert {world.journey["id"], other["id"]} <= all_ids
    mine = {j["id"] for j in client.get(f"{API}/journeys?mine=true", headers=world.h("sup2")).json()["items"]}
    assert mine == {other["id"]}


def test_state_filters(client, world):
    future = world.create_journey(journey_date=today_ist() + timedelta(days=5))
    active = {j["id"] for j in client.get(f"{API}/journeys?state=active", headers=world.h("manager")).json()["items"]}
    scheduled = {j["id"] for j in client.get(f"{API}/journeys?state=scheduled", headers=world.h("manager")).json()["items"]}
    assert world.journey["id"] in active and future["id"] in scheduled and future["id"] not in active


def test_update_cancel_and_version_conflict(client, world):
    future = world.create_journey(journey_date=today_ist() + timedelta(days=5))
    url = f"{API}/journeys/{future['id']}"
    r = client.patch(url, headers=world.h("manager"), json={"version": future["version"], "journey_date": str(today_ist() + timedelta(days=6))})
    assert r.status_code == 200
    updated = r.json()
    assert updated["end_date"] == str(today_ist() + timedelta(days=7)) and updated["version"] == future["version"] + 1
    stale = client.patch(url, headers=world.h("manager"), json={"version": future["version"], "start_time": "10:00:00"})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "version_conflict"
    r = client.post(f"{url}/cancel", headers=world.h("manager"), json={"version": updated["version"], "reason": "Train cancelled"})
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    again = client.post(f"{url}/cancel", headers=world.h("manager"), json={"version": r.json()["version"], "reason": "again"})
    assert again.status_code == 422
    cancelled = {j["id"] for j in client.get(f"{API}/journeys?state=cancelled", headers=world.h("manager")).json()["items"]}
    assert future["id"] in cancelled


def test_cannot_move_start_of_running_journey(client, world):
    r = client.patch(f"{API}/journeys/{world.journey['id']}", headers=world.h("manager"),
                     json={"version": world.journey["version"], "journey_date": str(today_ist() + timedelta(days=1))})
    assert r.status_code == 422 and r.json()["error"]["code"] == "journey_started"


def test_staff_allocation(client, world):
    url = f"{API}/staff-allocation/{world.journey['id']}"
    r = client.post(url, headers=world.h("manager"), json={"user_ids": [str(world.jan2.id), str(world.jan.id)]})
    assert r.status_code == 200
    assert {s["user_id"] for s in r.json()} == {str(world.sup.id), str(world.jan.id), str(world.jan2.id)}
    assert client.post(url, headers=world.h("sup"), json={"user_ids": [str(world.jan2.id)]}).status_code == 403
    assert client.delete(f"{url}/{world.jan2.id}", headers=world.h("manager")).status_code == 204
    assert client.delete(f"{url}/{world.jan2.id}", headers=world.h("manager")).status_code == 404
    assert client.delete(f"{url}/{world.sup.id}", headers=world.h("manager")).status_code == 422
    history = client.get(f"{url}?include_removed=true", headers=world.h("manager")).json()
    assert any(s["user_id"] == str(world.jan2.id) and s["removed_at"] for s in history)
    # re-allocation after removal is allowed (partial unique index only covers live rows)
    assert client.post(url, headers=world.h("manager"), json={"user_ids": [str(world.jan2.id)]}).status_code == 200


def test_assign_supervisor(client, world):
    r = client.post(f"{API}/journeys/{world.journey['id']}/supervisor", headers=world.h("manager"),
                    json={"version": world.journey["version"], "supervisor_id": str(world.sup2.id)})
    assert r.status_code == 200
    body = r.json()
    assert body["supervisor_id"] == str(world.sup2.id)
    assert str(world.sup2.id) in {s["user_id"] for s in body["staff"]}


def test_month_boundary_end_to_end(client, world):
    long_train = world.create_train(train_no="12999", duration_days=3, operational_days=6)
    start = date(today_ist().year + 1, 12, 30)
    j = world.create_journey(train=long_train, journey_date=start)
    assert (j["linked_journey_date"], j["end_date"]) == ("%d-01-02" % (start.year + 1), "%d-01-04" % (start.year + 1))
    assert j["state"] == "scheduled"


def _journey(client, world, jid):
    return client.get(f"{API}/journeys/{jid}", headers=world.h("manager")).json()


def test_train_coach_and_settings_edits_reach_untouched_journeys(client, world):
    from tests.test_inspections import inspect

    untouched = world.create_journey(journey_date=today_ist() + timedelta(days=2))
    assert inspect(world).status_code == 201  # world.journey now has an inspection on B1
    cancelled = world.create_journey(journey_date=today_ist() + timedelta(days=4))
    assert client.post(f"{API}/journeys/{cancelled['id']}/cancel", headers=world.h("manager"),
                       json={"reason": "test", "version": cancelled["version"]}).status_code == 200

    tid = world.train["id"]
    new = [{"code": "B1", "classification": "AC"}, {"code": "B2", "classification": "AC"}, {"code": "S1", "classification": "NON_AC"}]
    assert client.put(f"{API}/trains/{tid}/coaches", headers=world.h("manager"), json={"coaches": new}).status_code == 200
    r = client.patch(f"{API}/trains/{tid}", headers=world.h("manager"),
                     json={"inspection_rounds_per_day": 3, "before_inspection_enabled": False})
    assert r.status_code == 200, r.text

    u = _journey(client, world, untouched["id"])
    assert [c["code"] for c in u["coaches"]] == ["B1", "B2", "S1"]
    assert u["inspection_rounds_per_day"] == 3 and u["before_inspection_enabled"] is False

    inspected = _journey(client, world, world.journey["id"])  # keeps what it ran with
    assert [c["code"] for c in inspected["coaches"]] == ["B1", "S1"]
    assert inspected["inspection_rounds_per_day"] == 2 and inspected["before_inspection_enabled"] is True

    c = _journey(client, world, cancelled["id"])
    assert [x["code"] for x in c["coaches"]] == ["B1", "S1"] and c["inspection_rounds_per_day"] == 2


def test_train_length_edit_redates_untouched_journeys(client, world):
    from tests.test_inspections import inspect

    start = today_ist() + timedelta(days=2)
    derived = world.create_journey(journey_date=start)                       # dates from duration_days (1)
    by_hand = world.create_journey(journey_date=start + timedelta(days=1),
                                   end_date=str(start + timedelta(days=6)))  # end date set by hand
    assert inspect(world).status_code == 201                                 # world.journey has an inspection

    r = client.patch(f"{API}/trains/{world.train['id']}", headers=world.h("manager"),
                     json={"duration_days": 2, "operational_days": 4})
    assert r.status_code == 200, r.text

    d = _journey(client, world, derived["id"])
    assert (d["duration_days"], d["operational_days"]) == (2, 4)
    assert d["linked_journey_date"] == str(start + timedelta(days=2)) and d["end_date"] == str(start + timedelta(days=3))

    h = _journey(client, world, by_hand["id"])
    assert (h["duration_days"], h["operational_days"]) == (2, 4)
    assert h["end_date"] == str(start + timedelta(days=6))                   # hand-set dates kept

    i = _journey(client, world, world.journey["id"])
    assert (i["duration_days"], i["operational_days"]) == (1, 2) and i["end_date"] == world.journey["end_date"]


def test_train_length_edit_never_ends_a_running_journey(client, world):
    running = world.create_journey(journey_date=today_ist() - timedelta(days=1))  # 1-day train: ends today
    r = client.patch(f"{API}/trains/{world.train['id']}", headers=world.h("manager"), json={"duration_days": 0})
    assert r.status_code == 200, r.text
    j = _journey(client, world, running["id"])
    assert j["duration_days"] == 1 and j["end_date"] == running["end_date"]


def test_train_time_edit_follows_unless_journey_has_its_own(client, world):
    tid = world.train["id"]
    assert client.patch(f"{API}/trains/{tid}", headers=world.h("manager"),
                        json={"start_time": "06:00", "end_time": "14:00"}).status_code == 200
    follows = world.create_journey(journey_date=today_ist() + timedelta(days=2))
    own = world.create_journey(journey_date=today_ist() + timedelta(days=3), start_time="07:15")

    r = client.patch(f"{API}/trains/{tid}", headers=world.h("manager"), json={"start_time": "06:30", "end_time": "15:00"})
    assert r.status_code == 200, r.text

    f = _journey(client, world, follows["id"])
    assert f["start_time"].startswith("06:30") and f["end_time"].startswith("15:00")
    o = _journey(client, world, own["id"])
    assert o["start_time"].startswith("07:15") and o["end_time"].startswith("15:00")  # own start kept
