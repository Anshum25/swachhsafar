"""A stage the train has already left is missed: it locks, it cannot be back-filled, and the stage after it
opens instead of the journey dead-ending (services/trains.stage_missed, services/attendance)."""
import uuid
from datetime import time, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from app.models import Journey, Train, TrainStop
from app.providers.railradar import Stop, TrainRun, get_timetable_provider
from app.services.trains import _closing_times, stage_closes_at, stage_missed
from app.timeutil import IST, utcnow
from tests.factories import now_iso, upload
from tests.test_station_attendance import API, _configure, _load_route, _punch, _status, sched  # noqa: F401


def _cells(world, employee="jan"):
    """One employee's stage cells. Rows come back ordered by role, so never index the list blindly."""
    want = str(world.users[employee].id)
    row = next(r for r in _status(world) if r["employee_id"] == want)
    return [c["status"] for c in row["stages"]]


@pytest.fixture
def timed(world):
    """A provider whose page carries stops as well as a route, the way RailRadar's does: the two come from
    the same list, so a route that changes changes the timetable hash with it."""
    from app.main import app

    class Timed:
        def __init__(self):
            self.route = tuple((c, n) for c, n in [("ADI", "Ahmedabad Jn"), ("ND", "Nadiad Jn"),
                                                   ("BRC", "Vadodara Jn"), ("ST", "Surat"), ("BCT", "Mumbai Central")])

        def train_run(self, train_no):
            stops = tuple(Stop(seq=i, code=c, name=n, arrival=None if i == 1 else f"{5 + i:02d}:00",
                               arrival_day=None if i == 1 else 1,
                               departure=None if i == len(self.route) else f"{5 + i:02d}:05",
                               departure_day=None if i == len(self.route) else 1,
                               distance_km=float(i * 50), platform=None)
                          for i, (c, n) in enumerate(self.route, 1))
            return TrainRun(train_no=train_no, name="Timed", origin_code=self.route[0][0],
                            destination_code=self.route[-1][0], destination_name=self.route[-1][1],
                            departure="06:05", arrival=f"{5 + len(self.route):02d}:00", arrival_days=0,
                            run_days=None, return_train_no=None, coaches=(), stops=stops, route=self.route)

        def timetable(self, code):  # pragma: no cover - not used here
            raise NotImplementedError

        def composition(self, train_no):  # pragma: no cover
            return []

    fake = Timed()
    app.dependency_overrides[get_timetable_provider] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_timetable_provider, None)


def _journey_row(world):
    return world.db.scalar(select(Journey).where(Journey.id == uuid.UUID(world.journey["id"])))


def _close_stage(world, stage: int, *, hours_ago: float):
    """Put one stage's closing time `hours_ago` behind now, in the journey's own day reckoning."""
    j = _journey_row(world)
    moment = (utcnow() - timedelta(hours=hours_ago)).astimezone(IST)
    stages = [dict(s) for s in j.attendance_stages]
    stages[stage - 1]["closes_day"] = (moment.date() - j.journey_date).days + 1
    stages[stage - 1]["closes_time"] = moment.strftime("%H:%M")
    j.attendance_stages = stages
    flag_modified(j, "attendance_stages")
    world.db.commit()


def _set_grace(world, hours: int):
    current = world.client.get(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin")).json()
    r = world.client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin"),
                         json={**current, "attendance_missed_grace_hours": hours, "attendance_route_check": "off"})
    assert r.status_code == 200, r.text


# ---- the closing time itself -------------------------------------------------------------------------------

def test_closing_times_take_each_stations_first_halt_and_fall_back_to_arrival():
    train = Train(train_no="00000", name="T", division_id=uuid.uuid4(), duration_days=1, operational_days=1,
                  inspection_rounds_per_day=1, before_inspection_enabled=True, after_inspection_enabled=True,
                  daywise=False, is_active=True, auto_journeys=False)
    train.stops = [
        TrainStop(seq=1, station_code="ADI", departure=time(6, 0), departure_day=1),
        TrainStop(seq=2, station_code="ND", arrival=time(7, 0), arrival_day=1, departure=time(7, 5), departure_day=1),
        TrainStop(seq=3, station_code="ADI", departure=time(9, 0), departure_day=1),   # visited twice: first wins
        TrainStop(seq=4, station_code="BCT", arrival=time(2, 0), arrival_day=2),       # last stop: no departure
        TrainStop(seq=5, station_code="XXX"),                                          # no clock at all
    ]
    assert _closing_times(train) == {
        "ADI": dict(closes_day=1, closes_time="06:00"),
        "ND": dict(closes_day=1, closes_time="07:05"),
        "BCT": dict(closes_day=2, closes_time="02:00"),
    }


def test_a_stage_without_a_timetable_is_never_missed(world):
    j = _journey_row(world)
    assert stage_closes_at(j, {"label": "Source"}) is None
    assert stage_missed(j, {"label": "Source"}, None) is False


def test_the_grace_is_what_decides_a_late_train(world, sched):
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    _close_stage(world, 1, hours_ago=4)
    j, stage = _journey_row(world), None
    stage = _journey_row(world).attendance_stages[0]

    class P:
        attendance_missed_grace_hours = 6
    assert stage_missed(j, stage, P()) is False          # 4 h late, 6 h of grace: still open
    P.attendance_missed_grace_hours = 2
    assert stage_missed(j, stage, P()) is True           # the same stage, 2 h of grace: gone


# ---- what the crew sees and may do -------------------------------------------------------------------------

def test_a_missed_stage_locks_and_the_next_one_opens(world, sched):
    _load_route(world)
    _configure(world, 3, ["ND", "BRC", "ST"])
    _set_grace(world, 0)
    _close_stage(world, 1, hours_ago=2)
    assert _cells(world) == ["missed", "next", "locked"]


def test_a_missed_stage_cannot_be_back_filled(world, sched):
    _load_route(world)
    _configure(world, 3, ["ND", "BRC", "ST"])
    _set_grace(world, 0)
    _close_stage(world, 1, hours_ago=2)
    r, _ = _punch(world, "jan", 1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "stage_missed", r.text


def test_a_missed_stage_does_not_block_the_rest_of_the_journey(world, sched):
    """Without this, one attendance missed at the first station makes every later station unmarkable."""
    _load_route(world)
    _configure(world, 3, ["ND", "BRC", "ST"])
    _set_grace(world, 0)
    _close_stage(world, 1, hours_ago=2)
    r, _ = _punch(world, "jan", 2)
    assert r.status_code == 201, r.text
    r, _ = _punch(world, "jan", 3)
    assert r.status_code == 201, r.text
    assert _cells(world) == ["missed", "taken", "taken"]


def test_a_stage_still_open_is_required_before_the_ones_after_it(world, sched):
    _load_route(world)
    _configure(world, 3, ["ND", "BRC", "ST"])
    _set_grace(world, 0)
    r, _ = _punch(world, "jan", 2)
    assert r.status_code == 422 and r.json()["error"]["code"] == "stage_order", r.text
    assert r.json()["error"]["details"]["pending_stages"] == [1]


# ---- re-reading the route when the attendance screen opens --------------------------------------------------

def test_opening_attendance_rereads_the_route_then_leaves_railradar_alone(world, sched):
    """The screen asks on every open, so the second ask inside the throttle window must not be a second read."""
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    url = f"{API}/attendance/journeys/{world.journey['id']}/route-refresh"
    r = world.client.post(url, headers=world.h("sup"))
    assert r.status_code == 200, r.text
    assert r.json()["checked"] is True
    again = world.client.post(url, headers=world.h("sup"))
    assert again.json() == dict(checked=False, reason="fresh", changed=0, journeys_updated=0, outcome=None)


def test_a_route_that_cannot_be_read_never_stops_the_crew(world, sched):
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    sched.fail = True
    r = world.client.post(f"{API}/attendance/journeys/{world.journey['id']}/route-refresh", headers=world.h("sup"))
    assert r.status_code == 200, r.text
    assert r.json()["checked"] is True and r.json()["outcome"] == "failed"
    # and attendance still works
    assert _punch(world, "jan", 1)[0].status_code == 201


def test_a_changed_route_regives_journeys_their_stages(world, timed):
    """A diverted train: journeys with no attendance yet take the new route's stations and windows."""
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    url = f"{API}/attendance/journeys/{world.journey['id']}/route-refresh"
    assert world.client.post(url, headers=world.h("sup")).json()["checked"] is True
    world.db.expire_all()
    stages = _journey_row(world).attendance_stages
    assert [s["station_code"] for s in stages] == ["ND", "BRC"]
    # The stops give each stage the moment it closes, which is what makes "missed" possible at all.
    assert [(s["closes_time"], s["closes_day"]) for s in stages] == [("08:05", 1), ("10:00", 1)]

    timed.route = (("ADI", "Ahmedabad Jn"), ("ND", "Nadiad Jn"), ("BCT", "Mumbai Central"))  # BRC dropped
    world.db.scalar(select(Train).where(Train.id == uuid.UUID(world.train["id"]))).schedule_checked_at = None
    world.db.commit()
    assert world.client.post(url, headers=world.h("sup")).json()["checked"] is True
    world.db.expire_all()
    stages = _journey_row(world).attendance_stages
    # BRC is no longer on the route, so no window can be built for it: the stage stays, but unenforced --
    # a dropped station must not lock the crew out, it must stop being checked.
    assert [s["station_code"] for s in stages] == ["ND", "BRC"]
    assert stages[1]["window"] is None
