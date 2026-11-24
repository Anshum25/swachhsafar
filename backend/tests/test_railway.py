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
    Coach, OriginTrain, RailRadarError, StationTimetable, TrainSchedule, coaches_from_position,
    get_timetable_provider, is_path_allowed, parse_robots, parse_station_timetable, parse_train_composition,
    parse_train_schedule,
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

        self.rakes = {}           # train_no -> [Coach]; a train not here has no composition on RailRadar
        self.rake_fail = None
        self.rake_calls = []      # train-status pages read (coaches and schedules alike)
        # train_no -> (origin, destination, departure, arrival, arrival_day_offset, run_days, return_train_no)
        self.runs = {
            "12833": ("ADI", "HWH", "00:25", "08:40", 2, ALL_DAYS, None),
            "19015": ("ADI", "BCT", "06:10", "14:00", 0, ("mon",), None),
        }

    def timetable(self, code):
        self.calls.append(code)
        if self.fail:
            raise RailRadarError(self.fail, "fake failure")
        return self.boards.get(code, StationTimetable(code, None, ()))

    def composition(self, train_no):
        self.rake_calls.append(train_no)
        if self.rake_fail:
            raise RailRadarError(self.rake_fail, "fake failure")
        if train_no not in self.rakes:
            raise RailRadarError("parse", "no composition")
        return list(self.rakes[train_no])

    def schedule(self, train_no):
        self.rake_calls.append(train_no)
        if self.rake_fail:
            raise RailRadarError(self.rake_fail, "fake failure")
        if train_no not in self.runs:
            raise RailRadarError("parse", "no schedule")
        origin, dest, dep, arr, offset, days, ret = self.runs[train_no]
        return TrainSchedule(train_no, f"Train {train_no} Express", origin, dest, dest.title(), dep, arr, offset,
                             days, ret, tuple(self.rakes.get(train_no, ())))


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
    assert r.json() == {"divisions_created": 1, "trains_planned": 1, "journeys_created": 3, "journeys_skipped": 0,
                        "coaches_auto": [], "coaches_missing": [], "return_trains": {}}
    assert rr.rake_calls == ["12833"]  # coaches were typed; the page is read once for the train's run

    world.db.rollback()
    station = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == "ADI"))
    assert station.kind.value == "station" and station.name == "Ahmedabad Jn"
    planned = _journeys(world, station.id)
    assert [j.journey_date for j in planned] == [today_ist() + timedelta(days=i) for i in range(3)]
    assert all(j.supervisor_id is None and j.created_by_id is None and j.auto_created and j.charged for j in planned)
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
    assert plan_journeys(world.db, today=today_ist())["created"] == 0
    assert plan_journeys(world.db, today=today_ist() + timedelta(days=1))["created"] == 1  # the day the window moved on to


def test_dropping_a_train_stops_planning_it(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}, {"train_no": "19015"}]}])
    _setup(world, "admin", world.a.client_id, [{"code": "SBI", "trains": [{"train_no": "22959"}]}])
    world.db.rollback()
    s = world.client.get(f"{API}/clients/{world.a.client_id}/setup", headers=world.h("admin")).json()
    picked = {x["code"]: x["train_nos"] for x in s["stations"] if x["selected"]}
    assert picked == {"SBI": ["22959"]}  # ADI keeps its division and history, no longer planned
    assert plan_journeys(world.db, today=today_ist() + timedelta(days=5))["created"] == 3  # only SBI's train


# ---- paying when a journey is planned ---------------------------------------------------------------------


def _wallet(world, client_id, rate, credits):
    h = world.h("sa")
    world.client.put(f"{API}/clients/{client_id}/credit-rate", headers=h, json={"credit_per_journey": rate})
    if credits:
        world.client.post(f"{API}/clients/{client_id}/credits", headers=h, json={"credits": credits})


def _balance(world):
    world.db.rollback()
    return world.db.get(Client, world.a.client_id).credit_balance


def test_a_planned_journey_is_paid_when_it_is_created(world, rr):
    _set_area(world, world.a.client_id)
    _wallet(world, world.a.client_id, rate=1, credits=10)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.json()["journeys_created"] == 3 and r.json()["journeys_skipped"] == 0
    assert _balance(world) == 7  # one credit per journey, at once


def test_journeys_the_wallet_cannot_pay_for_are_not_created_until_it_can(world, rr):
    _set_area(world, world.a.client_id)
    _wallet(world, world.a.client_id, rate=1, credits=2)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]},
                                                   {"code": "SBI", "trains": [{"train_no": "22959"}]}])
    assert (r.json()["journeys_created"], r.json()["journeys_skipped"]) == (2, 4)  # 2 trains x 3 days, 2 credits
    assert _balance(world) == 0
    world.db.rollback()
    made = list(world.db.scalars(select(Journey).where(Journey.auto_created)))
    # The earliest day is paid for first, for both trains; nothing exists unpaid.
    assert {j.journey_date for j in made} == {today_ist()} and all(j.charged for j in made)

    _wallet(world, world.a.client_id, rate=1, credits=10)
    world.db.rollback()  # a fresh snapshot: SQLite will not let a stale reader start writing
    assert plan_journeys(world.db, today=today_ist()) == {"created": 4, "skipped": 0}  # the next run catches up
    assert _balance(world) == 6


def test_cancelling_a_planned_journey_gives_the_credit_back(world, rr):
    _set_area(world, world.a.client_id)
    _wallet(world, world.a.client_id, rate=1, credits=5)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert _balance(world) == 2
    j = world.db.scalar(select(Journey).where(Journey.auto_created, Journey.journey_date == today_ist() + timedelta(days=2)))
    r = world.client.post(f"{API}/journeys/{j.id}/cancel", headers=world.h("admin"),
                          json={"reason": "not running", "version": j.version})
    assert r.status_code == 200, r.text
    assert _balance(world) == 3


def test_a_journey_left_unpaid_by_the_old_rule_is_charged_or_cancelled_when_it_starts(world, rr):
    """Journeys planned before planning paid for them (charged=False) are settled on their start day."""
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]},
                                               {"code": "SBI", "trains": [{"train_no": "22959"}]}])  # free: rate 0
    world.db.rollback()
    for j in world.db.scalars(select(Journey).where(Journey.auto_created)):
        j.charged = False
    world.db.commit()
    _wallet(world, world.a.client_id, rate=1, credits=1)
    assert charge_due_journeys(world.db, today=today_ist()) == {"charged": 1, "cancelled": 1}  # two today, one credit
    world.db.rollback()
    cancelled = [j for j in world.db.scalars(select(Journey).where(Journey.journey_date == today_ist(), Journey.auto_created))
                 if j.status == JourneyStatus.CANCELLED]
    assert len(cancelled) == 1 and cancelled[0].cancel_reason == "Not enough credits on the start day"


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


# ---- a train's coaches ---------------------------------------------------------------------------------------


def _train_page(position):
    """A train-status page as RailRadar serves it: the rake inside the escaped Next.js flight payload."""
    inner = '{"trainNumber":"12189","coachPosition":"%s","rakeShare":null}' % position
    escaped = inner.replace('"', '\\"')
    return f'<html><body><script>self.__next_f.push([1,"{escaped}"])</script></body></html>'


def test_coaches_are_read_from_the_coach_position():
    got = coaches_from_position("ENG-SLRD-GEN-GEN-S2-S1-H1-A1-B2-B1-M1-PC-EOG-GEN-LPR")
    assert [(c.code, c.classification) for c in got] == [
        ("GEN", "GEN"), ("GEN2", "GEN"), ("S2", "NON_AC"), ("S1", "NON_AC"), ("H1", "AC"), ("A1", "AC"),
        ("B2", "AC"), ("B1", "AC"), ("M1", "AC"), ("GEN3", "GEN")]
    assert coaches_from_position("ENG-SLR-LPR") == []


def test_the_train_status_page_gives_the_coaches():
    got = parse_train_composition(_train_page("ENG-SLRD-GEN-S1-B1-LPR"), "12189")
    assert got == [Coach("GEN", "GEN"), Coach("S1", "NON_AC"), Coach("B1", "AC")]
    with pytest.raises(RailRadarError) as exc:
        parse_train_composition("<html><title>Just a moment...</title>cf-chl</html>", "12189")
    assert exc.value.kind == "blocked"
    with pytest.raises(RailRadarError) as exc:
        parse_train_composition("<html>no rake here</html>", "12189")
    assert exc.value.kind == "parse"


def test_setup_fills_a_trains_coaches_from_railradar(world, rr):
    _set_area(world, world.a.client_id)
    rr.rakes["12833"] = [Coach("S1", "NON_AC"), Coach("B1", "AC")]
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}, {"train_no": "19015"}]}])
    assert r.status_code == 200, r.text
    assert r.json()["coaches_auto"] == ["12833"] and r.json()["coaches_missing"] == ["19015"]
    world.db.rollback()
    station = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == "ADI"))
    assert [c.code for c in _journeys(world, station.id)[0].coaches] == ["S1", "B1"]

    # Saved again: the train has coaches now, so RailRadar is not asked for them twice.
    calls = len(rr.rake_calls)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert len(rr.rake_calls) == calls


def test_setup_is_saved_when_the_coaches_cannot_be_had(world, rr):
    _set_area(world, world.a.client_id)
    rr.rake_fail = "blocked"
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.status_code == 200, r.text
    assert r.json()["trains_planned"] == 1 and r.json()["coaches_missing"] == ["12833"]


def test_the_wizard_looks_up_a_trains_coaches(world, rr):
    rr.rakes["12833"] = [Coach("B1", "AC"), Coach("S1", "NON_AC")]
    url = f"{API}/railway/trains/12833/coaches"
    assert world.client.get(url, headers=world.h("admin")).json() == [
        {"code": "B1", "classification": "AC"}, {"code": "S1", "classification": "NON_AC"}]
    assert world.client.get(url, headers=world.h("sa")).status_code == 200
    assert world.client.get(url, headers=world.h("manager")).status_code == 403
    assert world.client.get(f"{API}/railway/trains/19015/coaches", headers=world.h("admin")).status_code == 404
    rr.rake_fail = "rate_limited"
    r = world.client.get(url, headers=world.h("admin"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "railradar_rate_limited"


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
    # Three journeys planned and paid at 2 credits each, straight away.
    assert (w["credit_balance"], w["credit_per_journey"], w["journeys_covered"]) == (4, 2, 2)
    assert w["added_this_month"] == 10 and w["spent_this_month"] == 6
    assert (w["upcoming_journeys"], w["upcoming_cost"]) == (0, 0)  # nothing left to pay later
    assert w["recent"][0]["reason"] == "journey_charge"


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


# ---- stations of several cities made divisions of one office -------------------------------------------------


def _add_stations(world, who, client_id, codes, kind="station"):
    return world.client.post(f"{API}/divisions/stations", headers=world.h(who),
                             json={"client_id": str(client_id), "station_codes": codes, "kind": kind})


def test_stations_of_different_states_become_divisions_of_one_office(world):
    r = _add_stations(world, "sa", world.a.client_id, ["ADI", "jbp"])
    assert r.status_code == 201, r.text
    created = {d["station_code"]: d for d in r.json()["created"]}
    assert set(created) == {"ADI", "JBP"} and r.json()["existing"] == []
    assert created["JBP"]["name"] == "Jabalpur" and created["ADI"]["client_id"] == str(world.a.client_id)
    # Asked again, nothing is made twice; a new station alongside is still added.
    r = _add_stations(world, "sa", world.a.client_id, ["JBP", "SBI"])
    assert r.status_code == 201, r.text
    assert [d["station_code"] for d in r.json()["created"]] == ["SBI"] and r.json()["existing"] == ["JBP"]
    # The office's Admin works in all of them.
    me = world.client.get(f"{API}/auth/me", headers=world.h("admin")).json()
    assert {created["ADI"]["id"], created["JBP"]["id"]} <= set(me["divisions"])


def test_adding_stations_is_checked(world):
    assert _add_stations(world, "admin", world.a.client_id, ["ADI"]).status_code == 403
    r = _add_stations(world, "sa", world.a.client_id, ["ADI", "NOPE"])
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_station"
    world.db.rollback()
    assert world.db.scalar(select(Division).where(Division.station_code == "ADI")) is None
    assert _add_stations(world, "sa", world.a.client_id, ["ADI", "adi"]).status_code == 422


# ---- the return train: journey B -----------------------------------------------------------------------------


def _schedule_page(train_no, ret, first, last, run_days=ALL_DAYS):
    """A train-status page with RailRadar's initialSchedule: the train, its return train and its route."""
    sched = {"train": {"number": train_no, "name": "Tejas Rajdhani", "source": {"code": "MMCT", "name": "Mumbai Central"},
                       "destination": {"code": "NDLS", "name": "New Delhi"}, "runDays": list(run_days),
                       "returnTrain": ret, "coachPosition": "ENG-LPR-B1-B2-H1-A1-LPR"},
             "route": [{"sequence": 1, "station": {"code": "MMCT"}, **first},
                       {"sequence": 2, "station": {"code": "BRC"}, "arrival": "23:50", "arrivalDay": 1},
                       {"sequence": 3, "station": {"code": "NDLS"}, **last}]}
    import json
    inner = json.dumps({"trainNumber": train_no, "initialSchedule": sched})
    escaped = inner.replace('"', '\\"')
    return f'<html><body><script>self.__next_f.push([1,"{escaped}"])</script></body></html>'


def test_the_train_status_page_gives_the_run_and_the_return_train():
    page = _schedule_page("12951", "12952", {"departure": "17:00", "departureDay": 1},
                          {"arrival": "08:32", "arrivalDay": 2})
    s = parse_train_schedule(page, "12951")
    assert (s.origin_code, s.destination_code, s.departure, s.arrival, s.arrival_day_offset, s.return_train_no) == \
        ("MMCT", "NDLS", "17:00", "08:32", 1, "12952")
    assert s.run_days == ALL_DAYS and [c.code for c in s.coaches] == ["B1", "B2", "H1", "A1"]
    # A train named as its own return, or a junk number, is no return train.
    assert parse_train_schedule(_schedule_page("12951", "12951", {"departure": "17:00", "departureDay": 1},
                                               {"arrival": "08:32", "arrivalDay": 2}), "12951").return_train_no is None
    with pytest.raises(RailRadarError) as exc:
        parse_train_schedule(page, "12952")
    assert exc.value.kind == "parse"
    with pytest.raises(RailRadarError) as exc:
        parse_train_schedule("<html><title>Just a moment...</title>cf-chl</html>", "12951")
    assert exc.value.kind == "blocked"


def test_the_return_leg_starts_when_the_return_train_next_leaves():
    from datetime import time

    from app.models import Train
    from app.services.journeys import return_leg

    out = Train(train_no="12951", arrival_day_offset=1, end_time=time(8, 32))
    back = Train(train_no="12952", arrival_day_offset=1, start_time=time(16, 55), end_time=time(8, 35))
    mon = date(2026, 11, 23)
    # Arrives Tuesday 08:32; the return leaves the same day at 16:55 and reaches back on Wednesday.
    assert return_leg(mon, out, back) == (mon + timedelta(days=1), mon + timedelta(days=1), mon + timedelta(days=2))
    # A return that leaves before the rake comes in goes on its next run.
    back.start_time = time(6, 0)
    assert return_leg(mon, out, back)[1] == mon + timedelta(days=2)
    # A weekly return (Fridays) waits for Friday.
    back.run_days = "fri"
    assert return_leg(mon, out, back) == (mon + timedelta(days=1), mon + timedelta(days=4), mon + timedelta(days=5))
    # Run not known: no return leg, the caller keeps duration_days.
    back.arrival_day_offset = None
    assert return_leg(mon, out, back) is None
    assert return_leg(mon, out, None) is None


def test_setup_links_the_return_train_and_journeys_get_the_return_leg(world, rr):
    _set_area(world, world.a.client_id)
    rr.rakes["12833"] = [Coach("S1", "NON_AC"), Coach("B1", "AC")]
    rr.runs["12833"] = ("ADI", "HWH", "00:25", "08:40", 2, ALL_DAYS, "12834")
    rr.runs["12834"] = ("HWH", "ADI", "23:55", "07:30", 2, ALL_DAYS, "12833")
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.status_code == 200, r.text
    assert r.json()["return_trains"] == {"12833": "12834"} and r.json()["trains_planned"] == 1

    world.db.rollback()
    from app.models import Train
    station = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == "ADI"))
    out = world.db.scalar(select(Train).where(Train.division_id == station.id, Train.train_no == "12833"))
    back = world.db.scalar(select(Train).where(Train.division_id == station.id, Train.train_no == "12834"))
    assert out.return_train_id == back.id and not back.auto_journeys and back.name == "Train 12834 Express"
    assert [c.code for c in back.coaches] == ["S1", "B1"]  # the same rake goes back

    planned = _journeys(world, station.id)
    assert len(planned) == 3  # the return train is not planned on its own
    j = planned[0]
    start = today_ist()
    # Leaves day 0 at 00:25, reaches Howrah day 2 at 08:40; 12834 leaves that night at 23:55, back day 4.
    assert j.linked_train_id == back.id
    assert (j.journey_date, j.outbound_end_date, j.linked_journey_date, j.end_date) == \
        (start, start + timedelta(days=2), start + timedelta(days=2), start + timedelta(days=4))
    assert (str(j.start_time), str(j.end_time), str(j.return_start_time), str(j.return_end_time)) == \
        ("00:25:00", "08:40:00", "23:55:00", "07:30:00")

    # Saved again: both runs are known, so neither page is read twice.
    calls = len(rr.rake_calls)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert len(rr.rake_calls) == calls


def test_without_a_return_train_journeys_keep_the_duration(world, rr):
    _set_area(world, world.a.client_id)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "19015"}]}])
    assert r.status_code == 200, r.text
    assert r.json()["return_trains"] == {}
    station = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == "ADI"))
    for j in _journeys(world, station.id):
        assert j.linked_train_id is None and j.outbound_end_date is None
        assert j.linked_journey_date == j.journey_date + timedelta(days=1)


def test_journey_b_is_linked_from_the_journey_screen(world, rr):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    station = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == "ADI"))
    j = _journeys(world, station.id)[0]
    assert j.linked_train_id is None
    url, h = f"{API}/journeys/{j.id}/return-leg", world.h("admin")

    # RailRadar unreachable: said so, nothing linked.
    rr.rake_fail = "blocked"
    r = world.client.post(url, headers=h, json={})
    assert r.status_code == 503 and r.json()["error"]["code"] == "railradar_blocked"
    rr.rake_fail = None
    # RailRadar names no return train: dates from the duration, and a note to pick one.
    r = world.client.post(url, headers=h, json={})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "none" and r.json()["linked_train_id"] is None and "no return train" in r.json()["message"]

    # Now it does: found, linked to the train, and journey B worked out -- but the journey is not changed.
    rr.runs["12833"] = ("ADI", "HWH", "00:25", "08:40", 2, ALL_DAYS, "12834")
    rr.runs["12834"] = ("HWH", "ADI", "23:55", "07:30", 2, ALL_DAYS, "12833")
    world.db.rollback()
    from app.models import Train
    world.db.get(Train, j.train_id).arrival_day_offset = None  # read the page again, as before this train had one
    world.db.commit()
    r = world.client.post(url, headers=h, json={})
    assert r.status_code == 200, r.text
    leg = r.json()
    d = j.journey_date
    assert (leg["source"], leg["linked_train_no"], leg["from_timetable"]) == ("railradar", "12834", True)
    assert (leg["outbound_end_date"], leg["linked_journey_date"], leg["end_date"]) == \
        (str(d + timedelta(days=2)), str(d + timedelta(days=2)), str(d + timedelta(days=4)))
    assert (leg["end_time"], leg["return_start_time"], leg["return_end_time"]) == ("08:40:00", "23:55:00", "07:30:00")
    assert _journeys(world, station.id)[0].linked_train_id is None

    # Asked again: the link is saved on the train, RailRadar is not read again.
    calls = len(rr.rake_calls)
    assert world.client.post(url, headers=h, json={}).json()["source"] == "saved"
    assert len(rr.rake_calls) == calls

    # Saved on the journey (version-checked), and the detail shows it.
    body = {k: leg[k] for k in ("linked_train_id", "outbound_end_date", "linked_journey_date", "end_date", "end_time",
                                "return_start_time", "return_end_time")}
    r = world.client.patch(f"{API}/journeys/{j.id}", headers=h, json={"version": j.version, **body})
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["linked_train_no"], out["linked_train_name"], out["linked_journey_date"], out["return_start_time"]) == \
        ("12834", "Train 12834 Express", leg["linked_journey_date"], "23:55:00")
    assert world.client.patch(f"{API}/journeys/{j.id}", headers=h, json={"version": j.version, **body}).status_code == 409

    # The train itself is no return train; unlinking keeps the dates.
    assert world.client.post(url, headers=h, json={"linked_train_id": str(j.train_id)}).status_code == 422
    r = world.client.patch(f"{API}/journeys/{j.id}", headers=h, json={"version": out["version"], "linked_train_id": None})
    assert r.status_code == 200 and r.json()["linked_train_id"] is None and r.json()["end_date"] == leg["end_date"]
    # Somebody outside the office does not see the journey at all.
    assert world.client.post(url, headers=world.h("manager_b"), json={"lookup": False}).status_code == 404
