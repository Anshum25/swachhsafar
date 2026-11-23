"""Client setup from the railway network and journeys planned from it (app/services/railway.py,
app/providers/railradar.py). RailRadar is faked: nothing here touches the network.

The test world's division A belongs to one office, B to another. Ahmedabad (Gujarat) is a metro in the
station list: ADI, SBI, MAN ... all list under it."""

from datetime import date, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from app.models import Client, Division, Journey, JourneyStatus, RoleId
from app.providers.railradar import (
    OriginTrain, RailRadarError, StationTimetable, get_timetable_provider, is_path_allowed, parse_robots,
    parse_station_timetable,
)
from app.services.railway import charge_due_journeys, plan_journeys
from app.timeutil import today_ist
from tests.factories import auth, make_user

API = "/api/v1"
ALL_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


class FakeRailRadar:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.boards = {
            "ADI": StationTimetable("ADI", "Ahmedabad Jn", (
                OriginTrain("12833", "Howrah SF Express", "Superfast", "HWH", "Howrah Jn", "00:25", 1, ALL_DAYS),
                OriginTrain("19015", "Weekly Express", "Express", "BCT", "Mumbai Central", "06:10", 1, ("mon",)),
            )),
            "SBI": StationTimetable("SBI", "Sabarmati Jn", (
                OriginTrain("22959", "Intercity", "Superfast", "BRC", "Vadodara Jn", "07:00", 1, ALL_DAYS),
            )),
        }

    def timetable(self, code):
        self.calls.append(code)
        if self.fail:
            raise RailRadarError(self.fail, "fake failure")
        return self.boards.get(code, StationTimetable(code, None, ()))


@pytest.fixture
def rr(world):
    from app.main import app

    fake = FakeRailRadar()
    app.dependency_overrides[get_timetable_provider] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_timetable_provider, None)


def _set_area(world, client_id, state="Gujarat", city="Ahmedabad"):
    return world.client.patch(f"{API}/clients/{client_id}", headers=world.h("sa"), json={"state": state, "city": city})


def _setup(world, who, client_id, stations):
    return world.client.put(f"{API}/clients/{client_id}/setup", headers=world.h(who), json={"stations": stations})


def _journeys(world, division_id):
    world.db.rollback()
    return list(world.db.scalars(select(Journey).where(Journey.division_id == division_id).order_by(Journey.journey_date)))


# ---- the station list --------------------------------------------------------------------------------------


def test_states_cities_and_stations(world):
    h = world.h("sa")
    assert "Gujarat" in world.client.get(f"{API}/railway/states", headers=h).json()
    assert "Ahmedabad" in world.client.get(f"{API}/railway/cities", params={"state": "Gujarat"}, headers=h).json()
    codes = {s["code"] for s in world.client.get(f"{API}/railway/stations",
                                                 params={"state": "Gujarat", "city": "Ahmedabad"}, headers=h).json()}
    assert {"ADI", "SBI", "MAN"} <= codes  # the metro grouping brings in the localities


def test_only_real_states_and_cities_are_accepted(world):
    assert _set_area(world, world.a.client_id).status_code == 200
    r = _set_area(world, world.a.client_id, city="Atlantis")
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_city"
    assert _set_area(world, world.a.client_id, state="Narnia").json()["error"]["code"] == "unknown_state"
    # And only the Super Admin sets them.
    r = world.client.patch(f"{API}/clients/{world.a.client_id}", headers=world.h("admin"), json={"city": "Ahmedabad"})
    assert r.status_code == 403


# ---- a station's trains ------------------------------------------------------------------------------------


def test_an_admin_reads_trains_of_their_own_city_only(world, rr):
    _set_area(world, world.a.client_id)
    r = world.client.get(f"{API}/railway/stations/ADI/trains", headers=world.h("admin"))
    assert r.status_code == 200, r.text
    assert [t["train_no"] for t in r.json()["trains"]] == ["12833", "19015"]
    assert world.client.get(f"{API}/railway/stations/NDLS/trains", headers=world.h("admin")).status_code == 403
    assert world.client.get(f"{API}/railway/stations/ADI/trains", headers=world.h("manager")).status_code == 403


def test_the_timetable_is_cached_and_survives_railradar_being_down(world, rr):
    h = world.h("sa")
    assert world.client.get(f"{API}/railway/stations/ADI/trains", headers=h).json()["stale"] is False
    world.client.get(f"{API}/railway/stations/ADI/trains", headers=h)
    assert rr.calls == ["ADI"]  # the second read came from the cache
    rr.fail = "blocked"
    r = world.client.get(f"{API}/railway/stations/ADI/trains", params={"refresh": True}, headers=h)
    assert r.status_code == 200 and r.json()["stale"] is True
    r = world.client.get(f"{API}/railway/stations/SBI/trains", headers=h)  # nothing cached to fall back on
    assert r.status_code == 503 and r.json()["error"]["code"] == "railradar_blocked"


# ---- setup -------------------------------------------------------------------------------------------------


def test_setup_needs_the_area_first(world, rr):
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.status_code == 422 and r.json()["error"]["code"] == "client_area_missing"


def test_an_admin_sets_up_their_office_and_journeys_are_planned(world, rr):
    _set_area(world, world.a.client_id)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [
        {"train_no": "12833", "coaches": [{"code": "B1", "classification": "AC"}, {"code": "S1", "classification": "NON_AC"}]}]}])
    assert r.status_code == 200, r.text
    assert r.json() == {"divisions_created": 1, "trains_planned": 1, "journeys_created": 3}

    world.db.rollback()
    station = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == "ADI"))
    assert station.kind.value == "station" and station.name == "Ahmedabad Jn"
    planned = _journeys(world, station.id)
    assert [j.journey_date for j in planned] == [today_ist() + timedelta(days=i) for i in range(3)]
    assert all(j.supervisor_id is None and j.created_by_id is None and j.auto_created and not j.charged for j in planned)
    assert [c.code for c in planned[0].coaches] == ["B1", "S1"]

    # The office's Admin sees the new station's journeys; it is a division of their office.
    rows = world.client.get(f"{API}/journeys", params={"division_id": str(station.id), "page_size": 50},
                            headers=world.h("admin")).json()["items"]
    assert len(rows) == 3 and rows[0]["supervisor_id"] is None and rows[0]["supervisor_name"] is None

    s = world.client.get(f"{API}/clients/{world.a.client_id}/setup", headers=world.h("admin")).json()
    adi = next(x for x in s["stations"] if x["code"] == "ADI")
    assert adi["selected"] and adi["train_nos"] == ["12833"]
    assert s["planned"] == 3 and s["without_supervisor"] == 3 and s["setup_completed_at"]


def test_only_the_office_admin_or_super_admin_sets_up(world, rr):
    _set_area(world, world.a.client_id)
    body = [{"code": "ADI", "trains": [{"train_no": "12833"}]}]
    assert _setup(world, "manager", world.a.client_id, body).status_code == 403
    assert _setup(world, "sa", world.a.client_id, body).status_code == 200
    other_admin = make_user(world.db, world.b, RoleId.ADMIN, "admin_b")
    r = world.client.put(f"{API}/clients/{world.a.client_id}/setup", headers=auth(other_admin), json={"stations": body})
    assert r.status_code == 403


def test_stations_and_trains_are_checked(world, rr):
    _set_area(world, world.a.client_id)
    r = _setup(world, "admin", world.a.client_id, [{"code": "NDLS", "trains": [{"train_no": "12001"}]}])
    assert r.json()["error"]["code"] == "station_outside_city"
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "99999"}]}])
    assert r.json()["error"]["code"] == "train_not_at_station"


def test_a_refused_setup_leaves_nothing_behind(world, rr):
    """A valid first station must not be saved when a later one is refused."""
    _set_area(world, world.a.client_id)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]},
                                                   {"code": "SBI", "trains": [{"train_no": "99999"}]}])
    assert r.json()["error"]["code"] == "train_not_at_station"
    world.db.rollback()
    assert world.db.scalar(select(Division).where(Division.station_code == "ADI")) is None
    assert world.db.get(Client, world.a.client_id).setup_completed_at is None


def test_trains_are_planned_on_their_running_days_only(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "19015"}]}])
    world.db.rollback()
    station = world.db.scalar(select(Division).where(Division.station_code == "ADI"))
    window = [today_ist() + timedelta(days=i) for i in range(3)]
    assert [j.journey_date for j in _journeys(world, station.id)] == [d for d in window if d.weekday() == 0]


def test_planning_twice_plans_nothing_twice(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    world.db.rollback()
    assert plan_journeys(world.db, today=today_ist()) == 0
    assert plan_journeys(world.db, today=today_ist() + timedelta(days=1)) == 1  # the day the window moved on to


def test_dropping_a_train_stops_planning_it(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}, {"train_no": "19015"}]}])
    _setup(world, "admin", world.a.client_id, [{"code": "SBI", "trains": [{"train_no": "22959"}]}])
    world.db.rollback()
    s = world.client.get(f"{API}/clients/{world.a.client_id}/setup", headers=world.h("admin")).json()
    picked = {x["code"]: x["train_nos"] for x in s["stations"] if x["selected"]}
    assert picked == {"SBI": ["22959"]}  # ADI keeps its division and history, no longer planned
    assert plan_journeys(world.db, today=today_ist() + timedelta(days=5)) == 3  # only SBI's train


# ---- paying on the start day -------------------------------------------------------------------------------


def _wallet(world, client_id, rate, credits):
    h = world.h("sa")
    world.client.put(f"{API}/clients/{client_id}/credit-rate", headers=h, json={"credit_per_journey": rate})
    if credits:
        world.client.post(f"{API}/clients/{client_id}/credits", headers=h, json={"credits": credits})


def test_planned_journeys_are_paid_on_their_start_day(world, rr):
    _set_area(world, world.a.client_id)
    _wallet(world, world.a.client_id, rate=1, credits=1)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]},
                                               {"code": "SBI", "trains": [{"train_no": "22959"}]}])
    world.db.rollback()
    balance = lambda: (world.db.rollback(), world.db.get(Client, world.a.client_id).credit_balance)[1]  # noqa: E731
    assert balance() == 1  # planning is free

    result = charge_due_journeys(world.db, today=today_ist())
    assert result == {"charged": 1, "cancelled": 1}  # two start today, one credit
    assert balance() == 0
    world.db.rollback()
    today = list(world.db.scalars(select(Journey).where(Journey.auto_created, Journey.journey_date == today_ist())))
    cancelled = [j for j in today if j.status == JourneyStatus.CANCELLED]
    assert len(cancelled) == 1 and cancelled[0].cancel_reason == "Not enough credits on the start day"
    assert not cancelled[0].charged
    # Tomorrow's are untouched until tomorrow, and running it again charges nothing twice.
    assert charge_due_journeys(world.db, today=today_ist()) == {"charged": 0, "cancelled": 0}


def test_cancelling_an_unpaid_journey_refunds_nothing(world, rr):
    _set_area(world, world.a.client_id)
    _wallet(world, world.a.client_id, rate=1, credits=5)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    world.db.rollback()
    j = world.db.scalar(select(Journey).where(Journey.auto_created, Journey.journey_date == today_ist() + timedelta(days=2)))
    r = world.client.post(f"{API}/journeys/{j.id}/cancel", headers=world.h("admin"),
                          json={"reason": "not running", "version": j.version})
    assert r.status_code == 200, r.text
    world.db.rollback()
    assert world.db.get(Client, world.a.client_id).credit_balance == 5


# ---- supervisors, phones, the office admin's reach ----------------------------------------------------------


def test_phones_get_a_planned_journey_once_it_has_a_supervisor(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    world.db.rollback()
    station = world.db.scalar(select(Division).where(Division.station_code == "ADI"))
    sup = make_user(world.db, station, RoleId.SUPERVISOR, "sup_adi")
    j = _journeys(world, station.id)[0]

    synced = lambda: {x["id"] for x in world.client.get(f"{API}/sync/changes", headers=world.h("admin")).json()["journeys"]}  # noqa: E731
    assert str(j.id) not in synced()
    r = world.client.post(f"{API}/journeys/{j.id}/supervisor", headers=world.h("admin"),
                          json={"supervisor_id": str(sup.id), "version": j.version})
    assert r.status_code == 200, r.text
    assert r.json()["supervisor_name"] == "Sup_Adi"
    assert str(j.id) in synced()


def test_an_office_admin_sees_every_division_of_their_office_only(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    world.db.rollback()
    station = world.db.scalar(select(Division).where(Division.station_code == "ADI"))
    me = world.client.get(f"{API}/auth/me", headers=world.h("admin")).json()
    assert {str(world.a.id), str(station.id)} <= set(me["divisions"])
    assert str(world.b.id) not in me["divisions"]
    # A Manager of the same office still sees only their own division.
    assert set(world.client.get(f"{API}/auth/me", headers=world.h("manager")).json()["divisions"]) == {str(world.a.id)}


# ---- the RailRadar reader itself ---------------------------------------------------------------------------

FIXTURE = Path(__file__).parent / "fixtures" / "railradar_adi_station_page.html"


def test_the_station_page_is_read_for_trains_starting_there():
    t = parse_station_timetable(FIXTURE.read_text(encoding="utf-8"), "adi")
    assert t.station_code == "ADI" and t.station_name == "Ahmedabad Jn"
    howrah = next(x for x in t.trains if x.train_no == "12833")
    assert (howrah.departure, howrah.destination_code, howrah.run_days) == ("00:25", "HWH", ALL_DAYS)
    with pytest.raises(RailRadarError) as exc:
        parse_station_timetable(FIXTURE.read_text(encoding="utf-8"), "NDLS")  # the page is ADI's, not NDLS's
    assert exc.value.kind == "parse"


def test_a_challenge_page_is_not_worked_around():
    with pytest.raises(RailRadarError) as exc:
        parse_station_timetable("<html><title>Just a moment...</title>cf-chl</html>", "ADI")
    assert exc.value.kind == "blocked"
    with pytest.raises(RailRadarError) as exc:
        parse_station_timetable("<html>hello</html>", "ADI")
    assert exc.value.kind == "parse"


def test_robots_rules_are_obeyed():
    rules = parse_robots("User-agent: *\nDisallow: /api/\nAllow: /api/public\n\nUser-agent: other\nDisallow: /")
    assert is_path_allowed(rules, "/station/adi?hours=8")
    assert not is_path_allowed(rules, "/api/v1/x")
    assert is_path_allowed(rules, "/api/public/x")
    assert not is_path_allowed(parse_robots("User-agent: swachhsafar\nDisallow: /station"), "/station/adi")


def test_me_tells_the_office_admin_when_setup_is_due(world, rr):
    me = lambda: world.client.get(f"{API}/auth/me", headers=world.h("admin")).json()["client"]  # noqa: E731
    assert me()["state"] is None and me()["setup_completed_at"] is None
    _set_area(world, world.a.client_id)
    assert (me()["state"], me()["city"]) == ("Gujarat", "Ahmedabad")
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert me()["setup_completed_at"]


# ---- the wallet at a glance ------------------------------------------------------------------------------


def test_the_office_admin_sees_their_wallet_and_what_is_coming(world, rr):
    _set_area(world, world.a.client_id)
    _wallet(world, world.a.client_id, rate=2, credits=10)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    w = world.client.get(f"{API}/clients/{world.a.client_id}/wallet", headers=world.h("admin")).json()
    assert (w["credit_balance"], w["credit_per_journey"], w["journeys_covered"]) == (10, 2, 5)
    assert w["added_this_month"] == 10 and w["spent_this_month"] == 0
    assert (w["upcoming_journeys"], w["upcoming_cost"]) == (3, 6)  # three planned, none paid yet
    assert w["recent"][0]["reason"] == "top_up"

    charge_due_journeys(world.db, today=today_ist())
    w = world.client.get(f"{API}/clients/{world.a.client_id}/wallet", headers=world.h("admin")).json()
    assert (w["credit_balance"], w["spent_this_month"], w["upcoming_journeys"]) == (8, 2, 2)


def test_another_office_cannot_read_the_wallet(world):
    assert world.client.get(f"{API}/clients/{world.a.client_id}/wallet", headers=world.h("manager_b")).status_code == 404
    assert world.client.get(f"{API}/clients/{world.a.client_id}/wallet", headers=world.h("sa")).status_code == 200


def test_an_office_can_be_created_with_its_state_and_city(world):
    h = world.h("sa")
    r = world.client.post(f"{API}/clients", headers=h, json={"office_id": "OFF-ADI", "name": "Ahmedabad office",
                                                             "state": "Gujarat", "city": "Ahmedabad"})
    assert r.status_code == 201, r.text
    assert (r.json()["state"], r.json()["city"]) == ("Gujarat", "Ahmedabad")
    r = world.client.post(f"{API}/clients", headers=h, json={"office_id": "OFF-X", "name": "Nowhere", "state": "Gujarat",
                                                             "city": "Atlantis"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_city"
