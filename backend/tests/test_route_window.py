"""Attendance taken on its stretch of route: the window each station stage carries (services/route_window), the
server's check of every capture against it, and the division's choice to flag or refuse one outside it."""
import json
from pathlib import Path

import pytest

from app.services import route_window
from tests.test_station_attendance import API, _configure, _journey, _load_route, _punch, _status, sched  # noqa: F401

CASES = json.loads((Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "route_window_cases.json")
                   .read_text(encoding="utf-8"))
ADI, BRC = route_window.location_of("ADI"), route_window.location_of("BRC")


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
def test_the_shared_cases(case):
    # src/utils/routeWindow.js is held to the same answers (tests/unit/routeWindow.test.js).
    window = CASES[case["window"]] if case["window"] else None
    assert route_window.check(window, case["latitude"], case["longitude"], case["accuracy_m"],
                              CASES["tolerance_km"]) == case["expected"]


def test_a_window_reaches_past_stations_without_a_location():
    route = [{"code": "ADI"}, {"code": "ZZZ1"}, {"code": "ND"}, {"code": "ZZZ2"}, {"code": "ANND"}]
    w = route_window.build_window(route, 1, 3)  # opens and closes at stations with no known location
    assert (w["from_code"], w["to_code"]) == ("ADI", "ANND") and len(w["path"]) == 3
    assert route_window.build_window([{"code": "ZZZ1"}], 0, 0) is None


def _policy(world, **settings):
    current = world.client.get(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin")).json()
    r = world.client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin"), json={**current, **settings})
    assert r.status_code == 200, r.text


def _at(place):
    return dict(latitude=place[0], longitude=place[1])


@pytest.fixture
def two_stations(world, sched):  # noqa: F811
    _load_route(world)
    r = world.client.patch(f"{API}/trains/{world.train['id']}", headers=world.h("manager"), json={
        "attendance_station_count": 2, "attendance_station_codes": ["ADI", "BRC"],
        "attendance_valid_until": {"ADI": "ND"}})
    assert r.status_code == 200, r.text
    return world


def test_each_station_stage_carries_its_window_and_status_cells_do_not(two_stations):
    world = two_stations
    stages = _journey(world)["attendance_stages"]
    assert [(s["window"]["from_code"], s["window"]["to_code"]) for s in stages] == [("ADI", "ND"), ("BRC", "BCT")]
    assert stages[0]["window"]["path"][0][:2] == list(ADI)
    assert all("window" not in c for c in _status(world)[0]["stages"])
    train = world.client.get(f"{API}/trains/{world.train['id']}", headers=world.h("manager")).json()
    assert all(s["located"] for s in train["route_stations"])


def test_outside_the_window_is_refused_by_default(two_stations):
    world = two_stations
    r, _ = _punch(world, "jan", 1, **_at(BRC))      # Attd 1 runs Ahmedabad to Nadiad; this is Vadodara
    assert r.status_code == 422 and r.json()["error"]["code"] == "outside_route_window", r.text
    assert "open until Nadiad Jn" in r.json()["error"]["message"]
    r, _ = _punch(world, "jan", 1, **_at(ADI))
    assert r.status_code == 201 and r.json()["route_check"]["status"] == "inside"
    r, _ = _punch(world, "jan", 2, **_at(BRC))
    assert r.json()["route_check"] == {"status": "inside", "off_route_km": 0.0, "along_km": 0.0}


def test_a_division_can_relax_the_check_to_a_flag(two_stations):
    world = two_stations
    _policy(world, attendance_route_check="flag")
    r, _ = _punch(world, "jan", 1, **_at(BRC))
    assert r.status_code == 201, r.text
    assert r.json()["route_check"]["status"] == "after"


def test_a_division_can_turn_the_check_off(two_stations):
    world = two_stations
    _policy(world, attendance_route_check="off")
    r, _ = _punch(world, "jan", 1, **_at(BRC))
    assert r.status_code == 201 and r.json()["route_check"] is None


def test_the_tolerance_is_the_divisions(two_stations):
    world = two_stations
    _policy(world, attendance_route_check="block", attendance_route_tolerance_km=25)
    near = (ADI[0], ADI[1] - 0.15)                  # ~15 km west of Ahmedabad, off the line
    r, _ = _punch(world, "jan", 1, **_at(near))
    assert r.status_code == 201 and r.json()["route_check"]["status"] == "inside"


def test_legacy_stages_are_not_checked(world):
    r, _ = _punch(world, "jan", 1)
    assert r.status_code == 201 and r.json()["route_check"] is None
