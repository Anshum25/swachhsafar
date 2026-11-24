"""Client setup from the railway network and journeys planned from it (app/services/railway.py,
app/providers/railradar.py). RailRadar is faked: nothing here touches the network.

The test world's division A belongs to one office, B to another. Ahmedabad (Gujarat) is a metro in the
station list: ADI, SBI, MAN ... all list under it."""

from datetime import date, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from app.models import Client, Division, Journey, JourneyStatus, RoleId, Train
from app.providers.railradar import (
    Coach, OriginTrain, RailRadarError, StationTimetable, TrainRun, coaches_from_position, get_timetable_provider,
    is_path_allowed, parse_robots, parse_station_timetable, parse_train_composition, parse_train_run,
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
        self.runs = {}            # train_no -> TrainRun (schedule and return train); else made from rakes
        self.rake_fail = None
        self.rake_calls = []

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

    def train_run(self, train_no):
        self.rake_calls.append(train_no)
        if self.rake_fail:
            raise RailRadarError(self.rake_fail, "fake failure")
        if train_no in self.runs:
            return self.runs[train_no]
        if train_no not in self.rakes:
            raise RailRadarError("parse", "no schedule")
        return _run(train_no, coaches=self.rakes[train_no])


def _run(no, *, dep="00:25", arr="10:00", days=0, back=None, run_days=None, coaches=(), origin="ADI", dest="HWH"):
    return TrainRun(train_no=no, name=f"Train {no}", origin_code=origin, destination_code=dest,
                    destination_name=dest.title(), departure=dep, arrival=arr, arrival_days=days, run_days=run_days,
                    return_train_no=back, coaches=tuple(coaches))


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


def test_an_admin_reads_any_station_but_other_roles_read_none(world, rr):
    _set_area(world, world.a.client_id)
    r = world.client.get(f"{API}/railway/stations/ADI/trains", headers=world.h("admin"))
    assert r.status_code == 200, r.text
    assert [t["train_no"] for t in r.json()["trains"]] == ["12833", "19015"]
    # Outside the office's home city: an office may run trains out of another state, so this is allowed.
    assert world.client.get(f"{API}/railway/stations/NDLS/trains", headers=world.h("admin")).status_code == 200
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
                        "coaches_auto": [], "coaches_missing": []}
    assert rr.rake_calls == ["12833"]  # its schedule is read once; the typed coaches are kept

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
    r = _setup(world, "admin", world.a.client_id, [{"code": "ZZZZ", "trains": [{"train_no": "12001"}]}])
    assert r.json()["error"]["code"] == "unknown_station"
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "99999"}]}])
    assert r.json()["error"]["code"] == "train_not_at_station"


def test_an_office_adds_a_station_from_another_state(world, rr):
    """A Gujarat office that runs a train out of Jabalpur sets that station up too. The home city is where
    the wizard starts, not a boundary -- before this it was refused as station_outside_city."""
    _set_area(world, world.a.client_id)
    rr.boards["JBP"] = StationTimetable("JBP", "Jabalpur", (
        OriginTrain("12321", "Howrah Mail", "Mail", "HWH", "Howrah Jn", "05:40", 1, ALL_DAYS),))
    r = _setup(world, "admin", world.a.client_id, [
        {"code": "ADI", "trains": [{"train_no": "12833"}]},
        {"code": "JBP", "trains": [{"train_no": "12321"}]}])
    assert r.status_code == 200, r.text
    assert r.json()["divisions_created"] == 2 and r.json()["trains_planned"] == 2

    world.db.rollback()
    jbp = world.db.scalar(select(Division).where(Division.client_id == world.a.client_id,
                                                 Division.station_code == "JBP"))
    # A real station division, not an inert one: it has the station code the nightly planner works from.
    assert jbp is not None and jbp.kind.value == "station" and jbp.name == "Jabalpur"
    assert len(_journeys(world, jbp.id)) == 3

    # And it stays visible in the wizard, flagged as being outside the home city rather than dropped.
    s = world.client.get(f"{API}/clients/{world.a.client_id}/setup", headers=world.h("admin")).json()
    out = next(x for x in s["stations"] if x["code"] == "JBP")
    assert out["home"] is False and out["state"] == "Madhya Pradesh" and out["selected"]
    assert next(x for x in s["stations"] if x["code"] == "ADI")["home"] is True


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


# ---- the return trip ------------------------------------------------------------------------------------


def _train_status_page(schedule):
    import json
    inner = json.dumps({"trainNumber": schedule["train"]["number"], "initialSchedule": schedule})
    escaped = inner.replace('"', '\\"')
    return f'<html><body><script>self.__next_f.push([1,"{escaped}"])</script></body></html>'


def test_the_train_status_page_gives_the_schedule_and_the_return_train():
    page = _train_status_page({"train": {
        "number": "20947", "name": "Ahmedabad - Ekta Nagar Jan Shatabdi", "source": {"code": "ADI"},
        "destination": {"code": "EKNR", "name": "Ekta Nagar (Kevadiya)"}, "runDays": ["mon", "tue", "wed"],
        "returnTrain": "20948", "coachPosition": "ENG-LPR-C1-D1-D2-EV1"},
        "route": [{"sequence": 1, "departure": "07:55", "departureDay": 1},
                  {"sequence": 2, "arrival": "08:30", "arrivalDay": 1, "departure": "08:32", "departureDay": 1},
                  {"sequence": 3, "arrival": "10:50", "arrivalDay": 2}]})
    run = parse_train_run(page, "20947")
    assert (run.departure, run.arrival, run.arrival_days, run.return_train_no) == ("07:55", "10:50", 1, "20948")
    assert (run.origin_code, run.destination_code, run.run_days) == ("ADI", "EKNR", ("mon", "tue", "wed"))
    assert [c.code for c in run.coaches] == ["C1", "D1", "D2", "EV1"]
    with pytest.raises(RailRadarError) as exc:
        parse_train_run(page, "12001")  # the page is 20947's
    assert exc.value.kind == "parse"


def _station(world, code="ADI"):
    world.db.rollback()
    return world.db.scalar(select(Division).where(Division.client_id == world.a.client_id, Division.station_code == code))


def test_a_planned_journey_ends_when_the_return_train_is_back(world, rr):
    """Out with 12833 (00:25, arriving 10:00 the next day), back with 12834 that evening at 23:00, home at 08:00
    the day after: three days, and the journey shows its linked train."""
    _set_area(world, world.a.client_id)
    rr.runs["12833"] = _run("12833", dep="00:25", arr="10:00", days=1, back="12834", coaches=[Coach("B1", "AC")])
    rr.runs["12834"] = _run("12834", dep="23:00", arr="08:00", days=1, origin="HWH", dest="ADI")
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.status_code == 200, r.text

    station = _station(world)
    back = world.db.scalar(select(Train).where(Train.division_id == station.id, Train.train_no == "12834"))
    assert back is not None and not back.auto_journeys and [c.code for c in back.coaches] == ["B1"]  # the same rake
    j = _journeys(world, station.id)[0]
    d = j.journey_date
    assert (j.outbound_end_date, j.linked_journey_date, j.end_date) == (d + timedelta(days=1), d + timedelta(days=1),
                                                                        d + timedelta(days=2))
    assert (j.duration_days, j.operational_days, j.linked_train_id) == (1, 3, back.id)
    assert (str(j.start_time), str(j.end_time), str(j.return_start_time), str(j.return_end_time)) == (
        "00:25:00", "10:00:00", "23:00:00", "08:00:00")
    out = world.client.get(f"{API}/journeys/{j.id}", headers=world.h("admin")).json()
    assert out["linked_train_no"] == "12834"
    assert len(_journeys(world, back.division_id)) == 3  # the return train is not planned on its own


def test_the_return_leaves_on_a_day_it_runs_and_after_the_train_arrives(world, rr):
    _set_area(world, world.a.client_id)
    # Arrives 10:50 the same day; the return leaves at 09:00, so not that day; and only on Wednesdays.
    rr.runs["12833"] = _run("12833", dep="07:55", arr="10:50", days=0, back="12834")
    rr.runs["12834"] = _run("12834", dep="09:00", arr="12:00", days=0, run_days=("wed",), origin="HWH", dest="ADI")
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    for j in _journeys(world, _station(world).id):
        d = j.journey_date
        wed = next(d + timedelta(days=k) for k in range(1, 8) if (d + timedelta(days=k)).weekday() == 2)
        assert (j.outbound_end_date, j.linked_journey_date, j.end_date) == (d, wed, wed)


def test_a_train_with_no_return_ends_when_it_arrives(world, rr):
    _set_area(world, world.a.client_id)
    rr.runs["12833"] = _run("12833", dep="22:00", arr="06:00", days=1)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    j = _journeys(world, _station(world).id)[0]
    d = j.journey_date
    assert (j.linked_journey_date, j.end_date, j.linked_train_id, j.operational_days) == (
        d + timedelta(days=1), d + timedelta(days=1), None, 2)


def test_trains_set_up_before_schedules_were_read_get_them_on_the_next_planner_run(world, rr):
    _set_area(world, world.a.client_id)
    rr.rake_fail = "blocked"  # RailRadar unreadable at setup: dated as before
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    station = _station(world)
    before = _journeys(world, station.id)
    assert all(j.linked_train_id is None for j in before)

    rr.rake_fail = None
    rr.runs["12833"] = _run("12833", dep="00:25", arr="10:00", days=0, back="12834", coaches=[Coach("S1", "NON_AC")])
    rr.runs["12834"] = _run("12834", dep="18:00", arr="23:00", days=0, origin="HWH", dest="ADI")
    world.db.rollback()
    plan_journeys(world.db, today=today_ist(), provider=rr)
    after = {j.journey_date: j for j in _journeys(world, station.id)}
    today = today_ist()
    assert after[today].linked_train_id is None  # under way: left as it was
    for d in (today + timedelta(days=1), today + timedelta(days=2)):
        assert after[d].linked_train_id is not None and after[d].end_date == d  # back the same evening


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
