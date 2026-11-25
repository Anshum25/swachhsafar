"""RailRadar PNR provider (app/providers/railradar_pnr.py), the RailRadar -> RapidAPI fallback and the stored
PNR answers (app/services/pnr_cache.py). No network: transports are faked."""

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.models import PnrLookup
from app.providers import railradar_pnr as rr
from app.providers.external import (
    FallbackPnrProvider,
    PnrResult,
    ProviderUnavailable,
    pnr_result_from_dict,
    pnr_result_to_dict,
)
from app.services import pnr_cache
from tests.factories import FakePnr

SAMPLE = json.loads((Path(__file__).parent / "fixtures" / "railradar_pnr.json").read_text(encoding="utf-8"))
PNR = "8944377876"


def _provider(status, body):
    return rr.RailRadarPnrProvider(lambda pnr: (status, body))


# ---- parsing -----------------------------------------------------------------------------------------------


def test_railradar_payload_maps_to_a_pnr_result():
    r = rr.parse_railradar_pnr(SAMPLE)
    assert r.found and (r.train_number, r.train_name) == ("11702", "Mook Mati Express")
    assert r.journey_date == date(2026, 11, 17) and r.journey_class == "2A"
    assert (r.boarding_code, r.from_code, r.to_code, r.upto_code, r.alighting_code) == ("JBP", "JBP", "R", "R", "R")
    assert r.chart_status == "Chart Prepared" and r.chart_prepared and not r.train_cancelled
    assert r.coach_ids == {"A1"}
    p1, p2 = r.passengers
    assert (p1.serial, p1.status, p1.coach, p1.berth, p1.status_text) == (1, "CNF", "A1", "40 UB", "CNF/A1/40")
    assert (p2.coach, p2.berth) == ("A1", "42 SU")  # berthCode sits at passenger level in RailRadar's payload


def test_current_allocation_wins_and_flags_are_read():
    body = json.loads(json.dumps(SAMPLE))
    pax = body["data"]["passengers"][0]
    pax["current"] = {"status": "RAC", "coachId": "S4", "berthNo": 7}
    pax["berthCode"] = None
    body["data"]["passengers"][1]["isCancelled"] = True
    body["data"]["passengers"][1]["current"] = {}
    body["data"]["charting"] = {"isPrepared": False}
    body["data"]["trainCancelStatus"] = "Train Cancelled"
    r = rr.parse_railradar_pnr(body)
    assert (r.passengers[0].status, r.passengers[0].coach, r.passengers[0].berth) == ("RAC", "S4", "7")
    assert r.passengers[1].status == "CAN" and r.passengers[1].coach == "A1"  # booking coach when no current one
    assert r.coach_ids == {"A1", "S4"}
    assert r.chart_status == "Chart Not Prepared" and not r.chart_prepared and r.train_cancelled


def test_partial_cancellation_does_not_cancel_the_ticket():
    body = json.loads(json.dumps(SAMPLE))
    body["data"]["trainCancelStatus"] = "Partially Cancelled"
    assert rr.parse_railradar_pnr(body).train_cancelled is False


@pytest.mark.parametrize("code", ["PRS:INVALID_PNR", "PRS:PNR_FLUSHED"])
def test_definite_not_found(code):
    r = _provider(404, {"success": False, "error": {"code": code, "message": "x"}}).lookup(PNR)
    assert r.found is False and r.status_text == code


@pytest.mark.parametrize("status,body", [
    (503, {"success": False, "error": {"code": "PRS:DOWN"}}),
    (200, {"success": False, "error": {"code": "PRS:MAINTENANCE"}}),
    (403, None),                                   # Cloudflare challenge page: not JSON
    (429, {"success": False, "error": {"code": "RATE_LIMITED"}}),
    (200, {"success": True, "data": {"trainNumber": "11702"}}),  # train-status data, not a PNR
    (200, {"success": True, "data": {"pnrNumber": PNR}}),        # nothing usable: format changed
    (200, ["not", "an", "object"]),
])
def test_anything_else_is_an_outage_not_a_rejection(status, body):
    with pytest.raises(ProviderUnavailable):
        _provider(status, body).lookup(PNR)


def test_bad_pnr_is_never_requested():
    called = []
    p = rr.RailRadarPnrProvider(lambda pnr: called.append(pnr) or (200, SAMPLE))
    assert p.lookup("12345").found is False and called == []


def test_http_transport_requests_the_pnr_json_and_spaces_requests():
    seen, sleeps, clock = [], [], [100.0]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers["user-agent"]))
        return httpx.Response(200, json=SAMPLE)

    t = rr.HttpTransport("https://railradar.example", 5, min_interval=2.0, transport=httpx.MockTransport(handler),
                         sleep=sleeps.append, monotonic=lambda: clock[0])
    p = rr.RailRadarPnrProvider(t)
    assert p.lookup(PNR).train_number == "11702"
    p.lookup(PNR)
    assert seen[0][0] == f"https://railradar.example/app/v1/pnr/{PNR}" and "SwachhSafar" in seen[0][1]
    assert sleeps == [2.0]  # the second request waited out the interval


def test_http_transport_network_error_is_an_outage():
    def handler(request):
        raise httpx.ConnectError("boom")

    t = rr.HttpTransport("https://railradar.example", 5, min_interval=0, transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderUnavailable):
        rr.RailRadarPnrProvider(t).lookup(PNR)


def test_railradar_needs_the_authorization_reference():
    s = SimpleNamespace(railradar_pnr_authorization=" ", railradar_pnr_transport="http",
                        railradar_base_url="https://railradar.in", external_timeout_seconds=5,
                        railradar_pnr_min_interval_seconds=2, railradar_pnr_browser_channel=None)
    with pytest.raises(RuntimeError, match="RAILRADAR_PNR_AUTHORIZATION"):
        rr.from_settings(s)
    s.railradar_pnr_authorization = "RR-permission-2026"
    assert isinstance(rr.from_settings(s), rr.RailRadarPnrProvider)


# ---- fallback ----------------------------------------------------------------------------------------------


class _Named(FakePnr):
    def __init__(self, name):
        super().__init__()
        self.name = name


def test_fallback_answers_only_when_railradar_cannot():
    primary, fallback = _Named("railradar"), _Named("rapidapi")
    fallback.results[PNR] = PnrResult(found=True, train_number="11702")
    p = FallbackPnrProvider(primary, fallback)

    primary.down = True
    r = p.lookup(PNR)
    assert (r.found, r.source, fallback.calls) == (True, "rapidapi", [PNR])

    primary.down = False  # RailRadar answers "not found": final, RapidAPI is not asked
    r = p.lookup(PNR)
    assert (r.found, r.source, len(fallback.calls)) == (False, "railradar", 1)

    primary.down = fallback.down = True
    with pytest.raises(ProviderUnavailable):
        p.lookup(PNR)


# ---- stored answers ----------------------------------------------------------------------------------------


def test_result_round_trips_through_json():
    r = rr.parse_railradar_pnr(SAMPLE)
    assert pnr_result_from_dict(json.loads(json.dumps(pnr_result_to_dict(r)))) == r


def test_same_pnr_is_answered_from_the_database(db):
    fake = _Named("railradar")
    fake.results[PNR] = rr.parse_railradar_pnr(SAMPLE)
    now = datetime(2026, 11, 16, 6, 0, tzinfo=timezone.utc)
    first = pnr_cache.lookup(db, fake, PNR, now=now)
    db.commit()
    second = pnr_cache.lookup(db, fake, PNR, now=now + timedelta(hours=20))
    assert first == second and fake.calls == [PNR]
    row = db.get(PnrLookup, PNR)
    assert row.found and row.hits == 1
    # charted: kept until the end of journey date + 2 days, India time
    assert row.expires_at == datetime(2026, 11, 19, 18, 29, 59, 999999, tzinfo=timezone.utc)
    pnr_cache.lookup(db, fake, PNR, now=row.expires_at + timedelta(seconds=1))
    assert fake.calls == [PNR, PNR]  # expired: asked again and stored afresh


def test_not_found_and_uncharted_answers_expire_soon(db):
    fake = FakePnr()
    now = datetime(2026, 11, 16, 6, 0, tzinfo=timezone.utc)
    pnr_cache.lookup(db, fake, "1111111111", now=now)
    assert db.get(PnrLookup, "1111111111").expires_at == now + timedelta(minutes=15)
    fake.results["2222222222"] = PnrResult(found=True, train_number="1", chart_status="Chart Not Prepared",
                                           journey_date=date(2026, 11, 20))
    pnr_cache.lookup(db, fake, "2222222222", now=now)
    assert db.get(PnrLookup, "2222222222").expires_at == now + timedelta(hours=3)


def test_an_outage_is_never_stored(db):
    fake = FakePnr()
    fake.down = True
    with pytest.raises(ProviderUnavailable):
        pnr_cache.lookup(db, fake, PNR)
    assert db.get(PnrLookup, PNR) is None
