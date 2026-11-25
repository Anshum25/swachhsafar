"""Station-wise attendance: a train names the stations attendance is taken at; journeys get Source, those
stations in route order, and End (services/trains.attendance_plan)."""
import json
import uuid

import pytest
from sqlalchemy import func, select

from app.models import Attendance
from app.providers.railradar import RailRadarError, TrainRun, get_timetable_provider, parse_train_run
from tests.factories import now_iso, upload

API = "/api/v1"
ROUTE = (("ADI", "Ahmedabad Jn"), ("ND", "Nadiad Jn"), ("ANND", "Anand Jn"), ("BRC", "Vadodara Jn"),
         ("BH", "Bharuch Jn"), ("ST", "Surat"), ("BCT", "Mumbai Central"))


class FakeSchedule:
    def __init__(self):
        self.route = ROUTE
        self.fail = False

    def train_run(self, train_no):
        if self.fail:
            raise RailRadarError("blocked", "fake failure")
        return TrainRun(train_no=train_no, name="Test", origin_code="ADI", destination_code="BCT",
                        destination_name="Mumbai Central", departure="06:00", arrival="13:00", arrival_days=0,
                        run_days=None, return_train_no=None, coaches=(), route=self.route)

    def timetable(self, code):  # pragma: no cover - not used here
        raise RailRadarError("blocked", "not used")

    def composition(self, train_no):  # pragma: no cover
        return []


@pytest.fixture
def sched(world):
    from app.main import app

    fake = FakeSchedule()
    app.dependency_overrides[get_timetable_provider] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_timetable_provider, None)


def _load_route(world):
    r = world.client.post(f"{API}/trains/{world.train['id']}/route", headers=world.h("manager"))
    assert r.status_code == 200, r.text
    return r.json()


def _configure(world, count, codes):
    return world.client.patch(f"{API}/trains/{world.train['id']}", headers=world.h("manager"),
                              json={"attendance_station_count": count, "attendance_station_codes": codes})


def _journey(world, jid=None):
    return world.client.get(f"{API}/journeys/{jid or world.journey['id']}", headers=world.h("manager")).json()


def _punch(world, employee, stage, journey=None, by="sup", record_id=None, **extra):
    body = dict(id=record_id or str(uuid.uuid4()), journey_id=(journey or world.journey)["id"],
                employee_id=str(world.users[employee].id), stage=stage, device_timestamp=now_iso(),
                latitude=22.3, longitude=73.2, gps_accuracy_m=10.0, **extra)
    body["photo_media_id"] = upload(world.client, world.users[by], world.a.id, "attendance_photo")
    return world.client.post(f"{API}/attendance", headers=world.h(by), json=body), body


def _status(world, journey=None):
    return world.client.get(f"{API}/attendance/journeys/{(journey or world.journey)['id']}/status",
                            headers=world.h("sup")).json()


def test_route_is_read_from_the_schedule_page():
    inner = json.dumps({"trainNumber": "12009", "initialSchedule": {
        "train": {"number": "12009", "name": "Shatabdi", "source": {"code": "ADI"}, "destination": {"code": "BCT"}},
        "route": [{"sequence": 1, "station": {"code": "ADI", "name": "Ahmedabad Jn"}, "departure": "06:00"},
                  {"sequence": 3, "stationCode": "BRC", "stationName": "Vadodara Jn"},
                  {"sequence": 2, "station": {"code": "ND", "name": "Nadiad Jn"}},
                  {"sequence": 4, "station": {"code": "XYZ", "name": "Passing"}, "isHalt": False},
                  {"sequence": 5, "station": {"code": "BCT", "name": "Mumbai Central"}, "arrival": "13:00"}]}})
    page = '<script>self.__next_f.push([1,"' + inner.replace('"', '\\"') + '"])</script>'
    run = parse_train_run(page, "12009")
    assert run.route == (("ADI", "Ahmedabad Jn"), ("ND", "Nadiad Jn"), ("BRC", "Vadodara Jn"), ("BCT", "Mumbai Central"))


def test_a_train_without_configuration_keeps_the_five_stages(world):
    j = _journey(world)
    assert [s["label"] for s in j["attendance_stages"]] == ["Source", "Enroute 1", "Destination", "Enroute 2", "End"]
    assert len(_status(world)[0]["stages"]) == 5


@pytest.mark.parametrize("codes", [["ND", "ANND", "BRC"], ["ND", "ANND", "BRC", "BH", "ST"]])
def test_configured_stations_become_the_stages_between_source_and_end(world, sched, codes):
    _load_route(world)
    r = _configure(world, len(codes), codes)
    assert r.status_code == 200, r.text
    stages = _journey(world)["attendance_stages"]
    assert len(stages) == len(codes) + 2
    assert stages[0]["label"] == "Source – Ahmedabad Jn" and stages[-1]["label"] == "End – Mumbai Central"
    assert [s["station_code"] for s in stages[1:-1]] == codes
    cells = _status(world)[0]["stages"]
    assert [c["station_code"] for c in cells] == ["ADI", *codes, "BCT"]
    assert [c["status"] for c in cells] == ["next"] + ["locked"] * (len(codes) + 1)


def test_stations_are_kept_in_route_order(world, sched):
    _load_route(world)
    r = _configure(world, 3, ["ST", "ND", "BRC"])
    assert r.status_code == 200 and r.json()["attendance_station_codes"] == ["ND", "BRC", "ST"]
    assert [s["station_name"] for s in _journey(world)["attendance_stages"][1:-1]] == ["Nadiad Jn", "Vadodara Jn", "Surat"]


@pytest.mark.parametrize("count, codes, code", [
    (3, ["ND", "ANND", "BRC", "BH"], "attendance_count_mismatch"),   # more than configured
    (5, ["ND", "ANND", "BRC"], "attendance_count_mismatch"),         # fewer than required
    (2, ["ND", "PUNE"], "station_not_on_route"),
    (2, ["ADI", "ND"], "station_not_on_route"),                      # Source is a stage of its own
    (9, ["ND"], "attendance_count_exceeds_route"),
])
def test_invalid_configurations_are_refused(world, sched, count, codes, code):
    _load_route(world)
    r = _configure(world, count, codes)
    assert r.status_code == 422 and r.json()["error"]["code"] == code, r.text


def test_duplicates_zero_and_unknown_route_are_refused(world, sched):
    assert _configure(world, 2, ["ND", "ANND"]).json()["error"]["code"] == "route_unknown"
    _load_route(world)
    assert _configure(world, 2, ["ND", "nd"]).status_code == 422
    assert _configure(world, 0, []).status_code == 422
    assert _configure(world, -1, []).status_code == 422


def test_each_employee_progresses_through_the_configured_stages(world, sched):
    _load_route(world)
    _configure(world, 3, ["ND", "BRC", "ST"])
    world.client.post(f"/api/v1/staff-allocation/{world.journey['id']}", headers=world.h("manager"),
                      json={"user_ids": [str(world.jan2.id)]})
    r, _ = _punch(world, "jan", 2)
    assert r.json()["error"]["code"] == "stage_order"
    for stage in range(1, 6):
        r, _ = _punch(world, "jan", stage)
        assert r.status_code == 201, r.text
    assert r.json()["station_code"] == "BCT" and r.json()["stage_label"] == "End – Mumbai Central"
    r, _ = _punch(world, "jan", 6)
    assert r.status_code == 422 and r.json()["error"]["code"] == "stage_out_of_range"
    by = {s["employee_id"]: s for s in _status(world)}
    assert by[str(world.jan.id)]["completed"] and all(c["status"] == "taken" for c in by[str(world.jan.id)]["stages"])
    assert [c["status"] for c in by[str(world.jan2.id)]["stages"]] == ["next", "locked", "locked", "locked", "locked"]


def test_a_capture_against_changed_stations_is_refused_and_replays_are_not_duplicated(world, sched):
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    r, body = _punch(world, "jan", 1, station_code="ADI")
    assert r.status_code == 201
    assert world.client.post(f"{API}/attendance", headers=world.h("sup"), json=body).status_code == 200  # replay
    r, _ = _punch(world, "jan", 2, station_code="ANND")
    assert r.status_code == 409 and r.json()["error"]["code"] == "attendance_plan_changed"
    r, _ = _punch(world, "jan", 2)  # an app that does not send the station is judged by the stage alone
    assert r.status_code == 201 and r.json()["station_code"] == "ND"
    assert world.db.scalar(select(func.count()).select_from(Attendance)) == 2


def test_recorded_journeys_keep_their_stages_and_others_follow_the_train(world, sched):
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    _punch(world, "jan", 1)
    _punch(world, "jan", 2)
    r = _configure(world, 3, ["ANND", "BH", "ST"])
    assert r.status_code == 200
    kept = _journey(world)["attendance_stages"]
    assert [s["station_code"] for s in kept] == ["ADI", "ND", "BRC", "BCT"]   # attendance was taken: unchanged
    rec = world.db.scalars(select(Attendance).where(Attendance.stage == 2)).one()
    assert (rec.station_code, rec.stage_label) == ("ND", "Nadiad Jn")


def test_a_journey_with_no_attendance_follows_a_change_and_clearing_restores_five_stages(world, sched):
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    assert len(_journey(world)["attendance_stages"]) == 4
    _configure(world, 3, ["ANND", "BH", "ST"])
    assert [s["station_code"] for s in _journey(world)["attendance_stages"]][1:-1] == ["ANND", "BH", "ST"]
    r = _configure(world, None, None)
    assert r.status_code == 200 and r.json()["attendance_station_count"] is None
    assert len(_journey(world)["attendance_stages"]) == 5


def test_route_refresh_failure_is_reported(world, sched):
    sched.fail = True
    r = world.client.post(f"{API}/trains/{world.train['id']}/route", headers=world.h("manager"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "route_unavailable"


def test_a_count_without_stations_gives_that_many_numbered_stages(world):
    r = _configure(world, 6, None)   # no route needed
    assert r.status_code == 200, r.text
    assert (r.json()["attendance_station_count"], r.json()["attendance_station_codes"]) == (6, None)
    stages = _journey(world)["attendance_stages"]
    assert [s["label"] for s in stages] == [f"Stage {i}" for i in range(1, 7)]
    assert all(s["station_code"] is None for s in stages)
    for stage in range(1, 7):
        r, _ = _punch(world, "jan", stage)
        assert r.status_code == 201, r.text
    assert _punch(world, "jan", 7)[0].json()["error"]["code"] == "stage_out_of_range"


def test_switching_from_stations_to_a_plain_count(world, sched):
    _load_route(world)
    _configure(world, 2, ["ND", "BRC"])
    assert _configure(world, 3, []).status_code == 200
    assert [s["label"] for s in _journey(world)["attendance_stages"]] == ["Stage 1", "Stage 2", "Stage 3"]
