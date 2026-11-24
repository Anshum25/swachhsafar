"""Train coaches from RailEngine (app/providers/railengine.py) and their use in office setup. Nothing here
touches the network: RailEngine is a fake or an httpx MockTransport."""

import httpx
import pytest
from sqlalchemy import select

from app.models import Division, Train
from app.providers.railengine import Coach, RailEngineClient, RailEngineError, get_coach_provider, to_coaches
from tests.test_railway import API, _set_area, _setup, rr  # noqa: F401  (rr: the fake RailRadar fixture)

FORMATION = [
    {"position": 1, "coachNumber": "ENG", "type": "LOCO", "class": ""},
    {"position": 2, "coachNumber": "SLR", "type": "SLR", "class": ""},
    {"position": 3, "coachNumber": "GN", "type": "GEN", "class": "GN"},
    {"position": 4, "coachNumber": "GN", "type": "GEN", "class": "GN"},
    {"position": 5, "coachNumber": "S1", "type": "SL", "class": "SL"},
    {"position": 7, "coachNumber": "B1", "type": "3A", "class": "3A"},
    {"position": 6, "coachNumber": "A1", "type": "2A", "class": "2A"},
    {"position": 8, "coachNumber": "PC", "type": "PANTRY", "class": ""},
    {"position": 9, "coachNumber": "H1", "type": "1A", "class": ""},
]


def test_a_formation_becomes_passenger_coaches_in_order():
    assert to_coaches(FORMATION) == [
        Coach("GN", "NON_AC"), Coach("GN2", "NON_AC"), Coach("S1", "NON_AC"), Coach("A1", "AC"), Coach("B1", "AC"),
        Coach("H1", "AC"),  # no class given: H1 is first AC by its number
    ]


def _client(handler):
    return RailEngineClient("test-key", base_url="https://re.test/v1", transport=httpx.MockTransport(handler))


def test_the_client_reads_the_envelope_and_sends_the_key():
    seen = {}

    def handler(request):
        seen["key"], seen["path"] = request.headers.get("x-api-key"), request.url.path
        return httpx.Response(200, json={"status": "SUCCESS", "data": {"coaches": FORMATION[4:7]}})

    c = _client(handler)
    assert [x.code for x in c.coaches("12833")] == ["S1", "A1", "B1"]
    assert seen == {"key": "test-key", "path": "/v1/train/12833/coaches"}
    c.coaches("12833")  # cached: no second request needed
    with pytest.raises(RailEngineError) as exc:
        _client(lambda r: httpx.Response(400, json={"status": "INVALID_REQUEST", "error": {"message": "Missing key"}})).coaches("12833")
    assert exc.value.kind == "http"
    with pytest.raises(RailEngineError) as exc:
        _client(lambda r: httpx.Response(404, json={"status": "NOT_FOUND"})).coaches("99999")
    assert exc.value.kind == "not_found"


class FakeRailEngine:
    def __init__(self, coaches=None, fail=None):
        self.calls, self.result, self.fail = [], coaches or [Coach("S1", "NON_AC"), Coach("B1", "AC")], fail

    def coaches(self, train_no):
        self.calls.append(train_no)
        if self.fail:
            raise RailEngineError(self.fail, "fake failure")
        return self.result


@pytest.fixture
def re_fake():
    from app.main import app

    fake = FakeRailEngine()
    app.dependency_overrides[get_coach_provider] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_coach_provider, None)


def _coaches(world, code="ADI", train_no="12833"):
    world.db.rollback()
    div = world.db.scalar(select(Division).where(Division.station_code == code))
    t = world.db.scalar(select(Train).where(Train.division_id == div.id, Train.train_no == train_no))
    return [(c.code, c.classification.value) for c in sorted(t.coaches, key=lambda c: c.position)]


def test_setup_fills_a_trains_coaches_from_railengine(world, rr, re_fake):
    _set_area(world, world.a.client_id)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.status_code == 200, r.text
    assert r.json()["coaches_auto"] == ["12833"] and r.json()["coaches_missing"] == []
    assert _coaches(world) == [("S1", "NON_AC"), ("B1", "AC")]


def test_coaches_typed_in_setup_win(world, rr, re_fake):
    _set_area(world, world.a.client_id)
    _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [
        {"train_no": "12833", "coaches": [{"code": "C1", "classification": "AC"}]}]}])
    assert _coaches(world) == [("C1", "AC")] and re_fake.calls == []


def test_setup_still_saves_when_railengine_cannot_help(world, rr, re_fake):
    re_fake.fail = "network"
    _set_area(world, world.a.client_id)
    r = _setup(world, "admin", world.a.client_id, [{"code": "ADI", "trains": [{"train_no": "12833"}]}])
    assert r.status_code == 200 and r.json()["coaches_missing"] == ["12833"]
    assert _coaches(world) == []


def test_the_wizard_can_preview_a_trains_coaches(world, re_fake):
    r = world.client.get(f"{API}/railway/trains/12833/coaches", headers=world.h("admin"))
    assert r.status_code == 200 and [c["code"] for c in r.json()] == ["S1", "B1"]
    assert world.client.get(f"{API}/railway/trains/12833/coaches", headers=world.h("manager")).status_code == 403
    re_fake.fail = "config"
    r = world.client.get(f"{API}/railway/trains/12833/coaches", headers=world.h("admin"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "railengine_config"
