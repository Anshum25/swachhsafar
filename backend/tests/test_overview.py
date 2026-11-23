"""GET /dashboard/overview: the Super Admin dashboard. Divisions A and B of the test world belong to two offices;
the world creates one journey today in A."""

from datetime import timedelta

from app.timeutil import today_ist
from tests.factories import auth, make_client

URL = "/api/v1/dashboard/overview"


def _get(world, who, **params):
    r = world.client.get(URL, headers=auth(world.users[who]), params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_super_admin_sees_every_office(world):
    empty = make_client(world.db, "OFF-EMPTY")  # an office with no division yet still counts
    o = _get(world, "sa")
    ids = {row["client_id"] for row in o["offices"]}
    assert {str(world.a.client_id), str(world.b.client_id), str(empty.id)} <= ids
    assert o["totals"]["offices"] == len(o["offices"])
    assert o["totals"]["stations"] >= 2          # A and B, both stations by default
    assert o["totals"]["journeys"] >= 1
    assert o["totals"]["journeys_active"] >= 1
    assert o["totals"]["users_active"] >= 11     # everyone the world made, both offices


def test_the_period_is_thirty_days_by_default_and_day_by_day(world):
    o = _get(world, "sa")
    assert len(o["daily"]) == 30
    assert o["daily"][-1]["date"] == str(today_ist())
    assert o["daily"][-1]["journeys"] >= 1
    assert sum(d["journeys"] for d in o["daily"]) == o["totals"]["journeys"]


def test_filtering_by_office(world):
    a = _get(world, "sa", client_id=str(world.a.client_id))
    b = _get(world, "sa", client_id=str(world.b.client_id))
    assert [row["client_id"] for row in a["offices"]] == [str(world.a.client_id)]
    assert a["totals"]["offices"] == 1 and b["totals"]["offices"] == 1
    assert a["totals"]["journeys"] == 1 and b["totals"]["journeys"] == 0
    assert b["totals"]["users_active"] == 3      # manager_b, sup_b, jan_b


def test_filtering_by_division(world):
    o = _get(world, "sa", division_id=str(world.b.id))
    assert o["totals"]["journeys"] == 0
    assert [row["client_id"] for row in o["offices"]] == [str(world.b.client_id)]


def test_a_manager_sees_only_their_own_office(world):
    o = _get(world, "manager")
    assert [row["client_id"] for row in o["offices"]] == [str(world.a.client_id)]
    r = world.client.get(URL, headers=auth(world.users["manager"]), params={"division_id": str(world.b.id)})
    assert r.status_code == 403


def test_credits_added_and_spent_in_the_period(world):
    h = auth(world.users["sa"])
    cid = world.a.client_id
    assert world.client.put(f"/api/v1/clients/{cid}/credit-rate", headers=h, json={"credit_per_journey": 2}).status_code == 200
    assert world.client.post(f"/api/v1/clients/{cid}/credits", headers=h, json={"credits": 10}).status_code == 200
    world.create_journey(journey_date=today_ist() + timedelta(days=2))
    o = _get(world, "sa", client_id=str(cid))
    assert o["totals"]["credits_added"] == 10
    assert o["totals"]["credits_spent"] == 2
    assert o["totals"]["credit_balance"] == 8
    assert o["offices"][0]["credits_spent"] == 2


def test_complaints_and_roles_are_broken_down(world):
    o = _get(world, "sa")
    roles = {r["role"]: r["count"] for r in o["users_by_role"]}
    assert roles and sum(roles.values()) == o["totals"]["users_active"] + o["totals"]["users_inactive"]
    assert isinstance(o["complaints_by_status"], dict)


def test_a_bad_period_is_refused(world):
    today = today_ist()
    r = world.client.get(URL, headers=auth(world.users["sa"]),
                         params={"date_from": str(today), "date_to": str(today - timedelta(days=1))})
    assert r.status_code == 422
