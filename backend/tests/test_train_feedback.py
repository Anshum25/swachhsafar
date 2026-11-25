"""Train Master as the source of the passenger feedback lifecycle: feedback configuration, both directions'
timetables, journey legs and day targets, OTP-then-PNR verification with coach identification, duplicate
rules, and the reports (services/timetable.py, feedback_plan.py, feedback.py, feedback_reports.py).

RailRadar and the PNR provider are faked; nothing here touches the network."""

import uuid
from datetime import date, timedelta

import httpx
import pytest
from sqlalchemy import select

from app.models import Journey, JourneyFeedbackTarget, PassengerFeedback, Train, TrainSyncRun
from app.providers import external
from app.providers.external import PnrPassenger, PnrResult, ProviderUnavailable, RapidApiPnrProvider, parse_rapidapi_pnr
from app.providers.railradar import RailRadarError, Stop, TrainRun, get_timetable_provider, parse_route_stops
from app.services import feedback_plan, timetable
from app.timeutil import today_ist, utcnow
from tests.factories import now_iso

API = "/api/v1"
ALL = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _stop(seq, code, arr=None, arr_day=None, dep=None, dep_day=None, km=None):
    return Stop(seq=seq, code=code, name=code.title(), arrival=arr, arrival_day=arr_day, departure=dep,
                departure_day=dep_day, distance_km=km, platform=None)


OUT_STOPS = (_stop(1, "ADI", dep="22:00", dep_day=1, km=0), _stop(40, "BRC", "23:50", 1, "23:55", 1, 100),
             _stop(90, "RTM", "03:00", 2, "03:05", 2, 360), _stop(200, "HWH", "10:00", 2, km=1900))
# The return runs another way (NGP, not RTM) and to other times: it must not be the outbound reversed.
BACK_STOPS = (_stop(1, "HWH", dep="18:00", dep_day=1, km=0), _stop(70, "NGP", "06:00", 2, "06:10", 2, 1100),
              _stop(150, "BRC", "20:00", 2, "20:05", 2, 1800), _stop(170, "ADI", "22:30", 2, km=1900))


def _run(no, stops, *, back=None, origin=None, dest=None, days=1, run_days=ALL):
    return TrainRun(train_no=no, name=f"Express {no}", origin_code=origin or stops[0].code,
                    destination_code=dest or stops[-1].code, destination_name=(dest or stops[-1].code).title(),
                    departure=stops[0].departure, arrival=stops[-1].arrival, arrival_days=days, run_days=run_days,
                    return_train_no=back, coaches=(), stops=stops, distance_km=stops[-1].distance_km, duration_minutes=720)


class FakeTimetable:
    def __init__(self):
        self.runs = {"12001": _run("12001", OUT_STOPS, back="12002"), "12002": _run("12002", BACK_STOPS, back="12001")}
        self.fail: dict[str, str] = {}
        self.calls: list[str] = []

    def train_run(self, no):
        self.calls.append(no)
        if no in self.fail:
            raise RailRadarError(self.fail[no], "fake failure")
        if no not in self.runs:
            raise RailRadarError("not_found", "no page")
        return self.runs[no]

    def composition(self, no):
        return []

    def timetable(self, code):
        raise RailRadarError("not_found", "no station")


@pytest.fixture
def tt(world):
    from app.main import app

    fake = FakeTimetable()
    app.dependency_overrides[get_timetable_provider] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_timetable_provider, None)


def _patch_train(world, train_id, **body):
    return world.client.patch(f"{API}/trains/{train_id}", headers=world.h("manager"), json=body)


def _refresh(world, train_id):
    return world.client.post(f"{API}/trains/{train_id}/timetable/refresh", headers=world.h("manager"))


def _return_train(world):
    world.db.rollback()
    return world.db.scalar(select(Train).where(Train.division_id == world.a.id, Train.train_no == "12002"))


def _plan(world, journey_id, who="manager"):
    r = world.client.get(f"{API}/journeys/{journey_id}/feedback-plan", headers=world.h(who))
    assert r.status_code == 200, r.text
    return r.json()


def _four_day_journey(world, tt, target=10, **train_cfg):
    """Train 12001 out on day 1, arriving day 2; back with 12002 leaving day 3, home day 4. Started yesterday,
    so today is journey day 2."""
    assert _refresh(world, world.train["id"]).status_code == 200
    back = _return_train(world)
    assert _patch_train(world, world.train["id"], operational_days=4, feedback_daily_target=target, **train_cfg).status_code == 200
    d = today_ist() - timedelta(days=1)
    return world.create_journey(journey_date=d, linked_train_id=str(back.id), outbound_end_date=str(d + timedelta(days=1)),
                                linked_journey_date=str(d + timedelta(days=2)), end_date=str(d + timedelta(days=3)))


def _start(world, journey, *, day, coach="B1", pnr="1234567890", mobile="9123456789", seat=None, fid=None):
    body = dict(id=fid or str(uuid.uuid4()), journey_id=journey["id"], coach_code=coach, journey_day=day,
                passenger_name="Asha", mobile=mobile, pnr=pnr, seat_no=seat, device_timestamp=now_iso(),
                latitude=23.1, longitude=79.9)
    return world.client.post(f"{API}/feedback/passenger", headers=world.h("sup"), json=body)


def _ticket(fakes, pnr, *, train="12001", on=None, board="ADI", upto="HWH", coach="S1", berth=33, status="CNF", **kw):
    fakes[2].results[pnr] = PnrResult(
        found=True, train_number=train, train_name="Express", coach_ids=frozenset({coach} if coach else set()),
        journey_date=on, boarding_code=board, from_code=board, to_code=upto, upto_code=upto, journey_class="SL",
        passengers=(PnrPassenger(serial=1, status=status, coach=coach, berth_no=berth if coach else None,
                                 berth_code="LB" if coach else None, status_text=None),), **kw)


def _verify_otp(world, fakes, fb_id):
    assert world.client.post(f"{API}/feedback/passenger/{fb_id}/send-otp", headers=world.h("sup")).status_code == 200
    r = world.client.post(f"{API}/feedback/passenger/{fb_id}/verify-otp", headers=world.h("sup"),
                          json={"code": fakes[1].last_code})
    assert r.status_code == 200, r.text
    return r.json()


def _verify_pnr(world, fb_id):
    return world.client.post(f"{API}/feedback/passenger/{fb_id}/verify-pnr", headers=world.h("sup")).json()


def _complete(world, fb):
    qs = world.passenger_bank["questions"]
    key = {"AC": "applies_ac", "GEN": "applies_gen"}.get(fb["coach_class"], "applies_non_ac")
    ratings = [{"question_id": q["id"], "value": 4} for q in qs if q[key] and q["required"]]
    r = world.client.post(f"{API}/feedback/passenger/{fb['id']}/complete", headers=world.h("sup"), json={"ratings": ratings})
    assert r.status_code == 200, r.text
    return r.json()


# ---- Scenario 1: Train Master configuration -----------------------------------------------------------------


def test_train_master_keeps_feedback_settings_per_train(world):
    r = _patch_train(world, world.train["id"], feedback_daily_target=10, feedback_coach_daily_target=3,
                     feedback_min_daily=6, feedback_to_day=2)
    assert r.status_code == 200, r.text
    t = world.client.get(f"{API}/trains/{world.train['id']}", headers=world.h("manager")).json()
    assert (t["feedback_enabled"], t["feedback_daily_target"], t["feedback_coach_daily_target"], t["feedback_min_daily"],
            t["feedback_from_day"], t["feedback_to_day"], t["feedback_days"]) == (True, 10, 3, 6, 1, 2, "all")
    other = world.create_train(train_no="5113", feedback_daily_target=4)
    assert other["feedback_daily_target"] == 4  # each train its own target
    # The floor cannot exceed the target, a window cannot end before it starts, and nulls are refused.
    r = _patch_train(world, world.train["id"], feedback_min_daily=11)
    assert r.status_code == 422 and r.json()["error"]["code"] == "feedback_min_above_target"
    r = _patch_train(world, world.train["id"], feedback_from_day=3)
    assert r.status_code == 422 and r.json()["error"]["code"] == "feedback_window_order"
    assert _patch_train(world, world.train["id"], feedback_days=None).status_code == 422
    # Clearing the target (explicit null) is allowed; leaving it out keeps it.
    assert _patch_train(world, world.train["id"], feedback_min_daily=None, feedback_daily_target=None).json()["feedback_daily_target"] is None
    assert world.client.patch(f"{API}/trains/{world.train['id']}", headers=world.h("sup"), json={"feedback_daily_target": 5}).status_code == 403


# ---- Scenario 2: timetables in both directions ----------------------------------------------------------------


def test_route_stops_keep_halts_order_repeats_and_days():
    route = [
        {"sequence": 1, "station": {"code": "MMCT", "name": "Mumbai Central"}, "isHalt": True, "departure": "17:00",
         "departureDay": 1, "distance": 0},
        {"sequence": 2, "station": {"code": "MX"}, "isHalt": False, "arrival": "17:01", "arrivalDay": 1},
        {"sequence": 3, "station": {"code": "BRC", "name": "Vadodara"}, "isHalt": True, "arrival": "23:58", "arrivalDay": 1,
         "departure": "00:08", "departureDay": 2, "distance": 393.4, "platform": 2},
        {"sequence": 4, "station": {"code": "KOTA"}, "isHalt": True, "arrival": "03:15", "arrivalDay": 2, "departure": "03:20",
         "departureDay": 2},
        {"sequence": 5, "station": {"code": "BRC"}, "isHalt": True, "arrival": "07:00", "arrivalDay": 2, "departure": "07:05",
         "departureDay": 2},
        {"sequence": 6, "station": {"code": "NDLS", "name": "New Delhi"}, "isHalt": True, "arrival": "08:32", "arrivalDay": 2},
    ]
    stops = parse_route_stops(route)
    assert [s.code for s in stops] == ["MMCT", "BRC", "KOTA", "BRC", "NDLS"]  # the passing point MX is dropped
    assert (stops[0].arrival, stops[0].departure, stops[-1].departure) == (None, "17:00", None)
    assert (stops[1].arrival_day, stops[1].departure_day, stops[1].platform) == (1, 2, "2")  # a halt over midnight
    run = _run("12951", stops, days=1)
    assert timetable.validate_run(run) == []
    backwards = _run("12951", (stops[0], _stop(3, "BRC", "16:00", 1, "16:10", 1), stops[-1]), days=1)
    assert "the timetable runs backwards at BRC" in timetable.validate_run(backwards)
    assert timetable.validate_run(_run("12951", stops[:1], days=0)) == ["fewer than two stations on the route"]


def test_both_directions_are_read_from_their_own_pages(world, tt):
    r = _refresh(world, world.train["id"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["outcome"] == "updated" and out["changed"] == 2
    tt_ = out["timetable"]
    assert [s["code"] for s in tt_["outbound"]["stops"]] == ["ADI", "BRC", "RTM", "HWH"]
    assert [s["code"] for s in tt_["inbound"]["stops"]] == ["HWH", "NGP", "BRC", "ADI"]  # not the outbound reversed
    assert tt_["inbound"]["train_no"] == "12002" and tt_["outbound"]["journey_days"] == 2
    assert tt.calls == ["12001", "12002"]
    rtm = tt_["outbound"]["stops"][2]
    assert (rtm["arrival"], rtm["day"], rtm["halt_minutes"]) == ("03:00", 2, 5)
    back = _return_train(world)
    assert back.return_train_id is not None and back.schedule_status == "ok" and not back.auto_journeys
    t = world.client.get(f"{API}/trains/{world.train['id']}", headers=world.h("manager")).json()
    assert (t["origin_code"], t["destination_code"], t["return_train_no"], t["schedule_status"]) == ("ADI", "HWH", "12002", "ok")
    # Same timetable again: nothing changes, and the log says so.
    assert _refresh(world, world.train["id"]).json()["outcome"] == "unchanged"
    runs = world.client.get(f"{API}/trains/timetable/runs", headers=world.h("manager")).json()
    assert [r["outcome"] for r in runs if r["train_no"] == "12001"] == ["unchanged", "updated"]


def test_a_bad_or_failed_read_never_replaces_a_good_timetable(world, tt):
    _refresh(world, world.train["id"])
    tt.runs["12001"] = _run("12001", (OUT_STOPS[0], _stop(40, "BRC", "21:00", 1, "21:05", 1), OUT_STOPS[-1]), back="12002")
    r = _refresh(world, world.train["id"]).json()
    assert r["outcome"] == "rejected" and "backwards" in r["message"]
    assert [s["code"] for s in r["timetable"]["outbound"]["stops"]] == ["ADI", "BRC", "RTM", "HWH"]  # kept
    assert r["timetable"]["outbound"]["schedule_status"] == "rejected"

    tt.fail["12001"] = "blocked"
    r = _refresh(world, world.train["id"]).json()
    assert r["outcome"] == "failed" and len(r["timetable"]["outbound"]["stops"]) == 4
    world.db.rollback()
    train = world.db.get(Train, uuid.UUID(world.train["id"]))
    assert train.schedule_failures == 2 and train.schedule_synced_at is not None
    # Retries back off: not due straight away, due once the delay for a 2nd failure (6 h) has passed.
    assert train not in timetable.due_trains(world.db, failed_only=True)
    assert train in timetable.due_trains(world.db, failed_only=True, now=utcnow() + timedelta(hours=7))


def test_bulk_refresh_reads_every_train_once_and_stops_when_refused(world, tt):
    world.create_train(train_no="5113")
    tt.runs["5113"] = _run("5113", OUT_STOPS, back=None)
    r = world.client.post(f"{API}/trains/timetable/refresh", headers=world.h("manager"), json={"division_id": str(world.a.id)})
    assert r.status_code == 202 and r.json()["accepted"] and r.json()["trains"] == 2
    world.db.rollback()
    assert sorted(tt.calls) == ["12001", "12002", "5113"]  # 12002 read once, as 12001's return
    statuses = {t.train_no: t.schedule_status for t in world.db.scalars(select(Train).where(Train.division_id == world.a.id))}
    assert statuses == {"12001": "ok", "12002": "ok", "5113": "ok"}
    # Nothing due afterwards when only due trains are asked for.
    r = world.client.post(f"{API}/trains/timetable/refresh", headers=world.h("manager"),
                          json={"division_id": str(world.a.id), "only_due": True})
    assert r.json() == {"accepted": False, "trains": 0, "message": "No train is due for a refresh."}
    # RailRadar refusing us ends a run instead of hammering it.
    tt.fail = {"12001": "rate_limited", "5113": "rate_limited"}
    trains = timetable.due_trains(world.db, division_ids=[world.a.id], include_fresh=True)
    tally = timetable.sync_many(world.db, tt, trains, trigger="scheduled")
    assert tally["stopped"] == "rate_limited" and tally["failed"] == 1
    assert world.client.post(f"{API}/trains/timetable/refresh", headers=world.h("sup"), json={}).status_code == 403


# ---- Scenarios 3 and 4: journey days and targets ---------------------------------------------------------------


def test_a_four_day_journey_gets_ten_a_day_forty_in_all(world, tt):
    j = _four_day_journey(world, tt, target=10)
    plan = _plan(world, j["id"])
    assert plan["persisted"] and plan["daily_target"] == 10
    assert [(d["journey_day"], d["required"], d["direction"]) for d in plan["days"]] == [(1, 10, 1), (2, 10, 1), (3, 10, 2), (4, 10, 2)]
    assert plan["totals"]["required"] == 40 and plan["totals"]["pending"] == 40
    d0 = date.fromisoformat(j["journey_date"])
    assert [d["day_date"] for d in plan["days"]] == [str(d0 + timedelta(days=i)) for i in range(4)]
    out, back = plan["legs"]
    assert (out["train_no"], out["first_day"], out["last_day"], back["train_no"], back["first_day"], back["last_day"]) == (
        "12001", 1, 2, "12002", 3, 4)
    assert [s["journey_day"] for s in out["stops"]] == [1, 1, 2, 2]  # RTM and HWH are reached on day 2
    assert [s["code"] for s in back["stops"]] == ["HWH", "NGP", "BRC", "ADI"]
    assert [d["train_nos"] for d in plan["days"]] == ["12001", "12001", "12002", "12002"]
    journeys = world.client.get(f"{API}/journeys/{j['id']}", headers=world.h("manager")).json()
    assert [leg["direction"] for leg in journeys["legs"]] == [1, 2] and journeys["feedback_daily_target"] == 10
    # Running it again changes nothing (idempotent).
    world.db.rollback()
    jj = world.db.get(Journey, uuid.UUID(j["id"]))
    assert feedback_plan.refresh(world.db, jj) is False


def test_daily_target_is_not_a_coach_target(world, tt):
    j = _four_day_journey(world, tt, target=10, feedback_coach_daily_target=2)
    plan = _plan(world, j["id"])
    coach = {c["code"]: c for c in plan["coaches"]}
    assert coach["B1"]["required"] == 8 and coach["S1"]["required"] == 8  # 2 a day in each of 2 coaches x 4 days
    assert plan["totals"]["required"] == 40  # the train's own target is separate


def test_collection_window_and_running_days(world, tt):
    j = _four_day_journey(world, tt, target=5, feedback_from_day=2, feedback_to_day=3)
    assert [d["required"] for d in _plan(world, j["id"])["days"]] == [0, 5, 5, 0]
    r = _start(world, j, day=1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "day_outside_window"
    # A layover (no leg running) carries no target when only running days count.
    world.db.rollback()
    train = world.db.get(Train, uuid.UUID(world.train["id"]))
    jj = world.db.get(Journey, uuid.UUID(j["id"]))
    train.feedback_from_day, train.feedback_to_day, train.feedback_days = 1, None, "running"
    legs = [dict(direction=1, departs_on=jj.journey_date, arrives_on=jj.journey_date, train_no="12001"),
            dict(direction=2, departs_on=jj.journey_date + timedelta(days=3), arrives_on=jj.journey_date + timedelta(days=3),
                 train_no="12002")]
    days = feedback_plan.build_days(jj, legs)
    assert [(d["direction"], d["required"]) for d in days] == [(1, 5), (None, 0), (None, 0), (2, 5)]
    world.db.rollback()


def test_feedback_can_be_switched_off_per_train(world):
    _patch_train(world, world.train["id"], feedback_enabled=False)
    r = _start(world, world.journey, day=1)
    assert r.status_code == 422 and r.json()["error"]["code"] == "feedback_disabled"


# ---- Scenarios 5-8: OTP, PNR, linking and duplicates ----------------------------------------------------------


def test_otp_then_pnr_identifies_train_coach_and_seat(world, tt, fakes):
    j = _four_day_journey(world, tt)
    d0 = date.fromisoformat(j["journey_date"])
    _ticket(fakes, "1234567890", on=d0, coach="S1", berth=33)
    fb = _start(world, j, day=2, coach="B1").json()
    assert (fb["direction"], fb["train_no"], fb["coach_source"]) == (1, "12001", "selected")
    fb = _verify_otp(world, fakes, fb["id"])
    assert fb["otp_status"] == "verified" and fb["status"] == "draft"  # the PNR is still to be checked
    fb = _verify_pnr(world, fb["id"])
    assert (fb["status"], fb["pnr_status"]) == ("verified", "valid")
    # The ticket says S1: the feedback moves there (and to its class), seat filled from the ticket.
    assert (fb["coach_code"], fb["coach_class"], fb["coach_source"], fb["coach_verified"]) == ("S1", "NON_AC", "pnr", True)
    assert fb["seat_no"] == "33 LB" and fb["pnr_journey_date"] == str(d0)
    assert (fb["boarding_code"], fb["alighting_code"], fb["train_no"], fb["direction"]) == ("ADI", "HWH", "12001", 1)
    assert fb["pnr_details"]["checks"] == {"train": "ok", "date": "ok", "stations": "ok", "coach": "moved"}
    done = _complete(world, fb)
    plan = _plan(world, j["id"])
    assert plan["days"][1]["submitted"] == 1 and plan["days"][1]["verified"] == 1 and plan["days"][1]["pending"] == 9
    assert {c["code"]: c["submitted"] for c in plan["coaches"]} == {"B1": 0, "S1": 1}
    assert done["status"] == "completed"

    # Scenario 8: the same PNR again on this journey is refused; a network retry of the same record is not a duplicate.
    r = _start(world, j, day=2, mobile="9000000009")
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pnr"
    fid = str(uuid.uuid4())
    _ticket(fakes, "2222222222", on=d0)
    first = _start(world, j, day=2, pnr="2222222222", mobile="9000000010", fid=fid)
    again = world.client.post(f"{API}/feedback/passenger", headers=world.h("sup"), json={
        **{k: first.json()[k] for k in ("id", "journey_id", "coach_code", "journey_day", "passenger_name", "pnr", "seat_no")},
        "mobile": "9000000010", "device_timestamp": first.json()["device_timestamp"], "latitude": 23.1, "longitude": 79.9})
    assert first.status_code == 201 and again.status_code in (200, 201)
    world.db.rollback()
    assert world.db.scalar(select(PassengerFeedback).where(PassengerFeedback.id == uuid.UUID(fid))) is not None


@pytest.mark.parametrize("ticket,reason", [
    (dict(train="12002"), "PNR is for a different train"),                     # the return train, on an outbound day
    (dict(on_offset=5), "PNR is for another date of this train"),
    (dict(board="HWH", upto="ADI"), "PNR stations are not on this train's route"),  # the wrong way round
    (dict(board="NGP"), "PNR stations are not on this train's route"),               # not a stop of 12001
    (dict(coach="A1"), "PNR coach does not match"),                                  # not a coach of this journey
    (dict(coach=None, status="WL"), "The ticket is waitlisted, not confirmed"),
    (dict(train_cancelled=True), "The train is cancelled on this PNR's date"),
    (dict(status="CAN"), "The ticket on this PNR is cancelled"),
])
def test_pnr_that_does_not_fit_the_journey_is_rejected(world, tt, fakes, ticket, reason):
    j = _four_day_journey(world, tt)
    d0 = date.fromisoformat(j["journey_date"])
    offset = ticket.pop("on_offset", 0)
    _ticket(fakes, "1234567890", on=d0 + timedelta(days=offset), **ticket)
    fb = _start(world, j, day=2).json()
    fb = _verify_pnr(world, fb["id"])
    assert (fb["status"], fb["pnr_status"], fb["void_reason"]) == ("void", "invalid", reason)


def test_return_leg_feedback_takes_the_return_train(world, tt, fakes):
    """Day 3 is the return: a 12002 ticket fits, and the record says direction 2."""
    j = _four_day_journey(world, tt)
    world.db.rollback()  # a fresh snapshot: the journey was created through the API
    jj = world.db.get(Journey, uuid.UUID(j["id"]))
    info = feedback_plan.day_info(jj, 3)
    assert info == {"direction": 2, "train_nos": ["12002"]}
    d0 = date.fromisoformat(j["journey_date"])
    fake_fb = PassengerFeedback(coach_code="B1", journey_day=3, feedback_date=d0 + timedelta(days=2))
    _ticket(fakes, "3333333333", train="12002", on=d0 + timedelta(days=2), board="HWH", upto="ADI", coach="B1")
    from app.services.feedback import match_pnr
    from app.services.policy import get_policy

    m = match_pnr(jj, fake_fb, fakes[2].results["3333333333"], get_policy(world.db, jj.division_id))
    assert (m["reason"], m["train_no"], m["direction"], m["coach_verified"], m["berth"]) == (None, "12002", 2, True, "33 LB")
    world.db.rollback()


def test_provider_outage_keeps_feedback_pending_and_is_reported(world, tt, fakes):
    j = _four_day_journey(world, tt)
    fakes[2].down = True
    fb = _start(world, j, day=2).json()
    r = world.client.post(f"{API}/feedback/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "pnr_unavailable"
    assert world.client.get(f"{API}/feedback/passenger/{fb['id']}", headers=world.h("sup")).json()["pnr_status"] == "pending"
    today = str(today_ist())
    rep = world.client.get(f"{API}/reports/feedback-verification", headers=world.h("manager"),
                           params={"date_from": today, "date_to": today}).json()
    assert rep["pnr"]["provider_unavailable"] == 1 and rep["pnr"]["pending"] == 1


# ---- Scenario 9: changes reach the future, never the past -------------------------------------------------------


def test_master_and_timetable_changes_leave_history_alone(world, tt, fakes):
    j = _four_day_journey(world, tt, target=10)
    later = world.create_journey(journey_date=today_ist() + timedelta(days=1))
    d0 = date.fromisoformat(j["journey_date"])
    _ticket(fakes, "1234567890", on=d0, coach="B1")
    fb = _start(world, j, day=2).json()
    _verify_otp(world, fakes, fb["id"])
    kept = _complete(world, _verify_pnr(world, fb["id"]))

    assert _patch_train(world, world.train["id"], feedback_daily_target=12).status_code == 200
    plan = _plan(world, j["id"])
    assert [d["required"] for d in plan["days"]] == [10, 10, 12, 12]  # days begun keep their target
    assert plan["totals"]["submitted"] == 1

    tt.runs["12001"] = _run("12001", (OUT_STOPS[0], _stop(40, "BRC", "23:40", 1, "23:45", 1, 100), OUT_STOPS[2], OUT_STOPS[3]),
                            back="12002")
    r = _refresh(world, world.train["id"]).json()
    assert r["outcome"] == "updated" and r["journeys_updated"] >= 1
    runs = world.client.get(f"{API}/trains/timetable/runs", headers=world.h("manager")).json()
    latest = next(x for x in runs if x["train_no"] == "12001")
    assert latest["outcome"] == "updated" and latest["changes"]["stations_retimed"] == ["BRC"]
    started = _plan(world, j["id"])["legs"][0]["stops"]
    ahead = _plan(world, later["id"])["legs"][0]["stops"]
    assert started[1]["arrival"] == "23:50" and ahead[1]["arrival"] == "23:40"  # under way: the route it is running
    after = world.client.get(f"{API}/feedback/passenger/{fb['id']}", headers=world.h("sup")).json()
    assert {k: after[k] for k in ("status", "coach_code", "journey_day", "ratings")} == \
        {k: kept[k] for k in ("status", "coach_code", "journey_day", "ratings")}


# ---- Scenario 10: replays and backfill ---------------------------------------------------------------------------


def test_replayed_start_from_an_offline_queue_is_idempotent(world):
    fid = str(uuid.uuid4())
    body = dict(id=fid, journey_id=world.journey["id"], coach_code="B1", journey_day=1, passenger_name="Asha",
                mobile="9123456789", pnr="1234567890", seat_no=None, device_timestamp=now_iso(), latitude=23.1, longitude=79.9)
    a = world.client.post(f"{API}/feedback/passenger", headers=world.h("sup"), json=body)
    b = world.client.post(f"{API}/feedback/passenger", headers=world.h("sup"), json=body)
    assert (a.status_code, b.status_code) == (201, 200) and a.json()["id"] == b.json()["id"]
    changed = world.client.post(f"{API}/feedback/passenger", headers=world.h("sup"), json={**body, "passenger_name": "Other"})
    assert changed.status_code == 409


def test_journeys_from_before_targets_are_backfilled(world):
    world.db.rollback()
    world.db.query(JourneyFeedbackTarget).delete()
    world.db.commit()
    assert not _plan(world, world.journey["id"])["persisted"]
    _patch_train(world, world.train["id"], feedback_daily_target=3)
    assert feedback_plan.backfill(world.db) == 0  # the train edit already planned it
    plan = _plan(world, world.journey["id"])
    assert plan["persisted"] and [d["required"] for d in plan["days"]] == [3, 3]


# ---- reports ----------------------------------------------------------------------------------------------------


def test_reports_train_day_coach_and_sync(world, tt, fakes):
    # The world's own journey (started today, before any target was set) would count too: day 1 kept its 0,
    # day 2 took 10. Cancelled here so the figures below are this journey's alone; cancelled ones never count.
    r = world.client.post(f"{API}/journeys/{world.journey['id']}/cancel", headers=world.h("manager"),
                          json={"reason": "not in this report", "version": world.journey["version"]})
    assert r.status_code == 200, r.text
    j = _four_day_journey(world, tt, target=10, feedback_coach_daily_target=2)
    d0 = date.fromisoformat(j["journey_date"])
    _ticket(fakes, "1234567890", on=d0, coach="B1")
    fb = _start(world, j, day=2).json()
    _verify_otp(world, fakes, fb["id"])
    _complete(world, _verify_pnr(world, fb["id"]))
    _ticket(fakes, "4444444444", train="99999")
    _verify_pnr(world, _start(world, j, day=2, pnr="4444444444", mobile="9000000004").json()["id"])

    params = {"date_from": str(d0), "date_to": str(d0 + timedelta(days=3))}
    get = lambda path, **q: world.client.get(f"{API}/reports/{path}", headers=world.h("manager"), params={**params, **q}).json()  # noqa: E731
    by_train = get("feedback-targets", group_by="train", train_id=world.train["id"])
    rows = {r["direction"]: r for r in by_train["rows"]}
    assert (rows[1]["required"], rows[1]["submitted"], rows[1]["verified"], rows[1]["rejected"], rows[1]["pending"]) == (20, 1, 1, 1, 19)
    assert (rows[2]["required"], rows[2]["submitted"], rows[2]["pending"]) == (20, 0, 20)
    assert by_train["totals"]["required"] == 40 and by_train["totals"]["completion"] == 2.5
    days = [r for r in get("feedback-targets", group_by="day")["rows"] if r["journey_id"] == j["id"]]
    assert [(r["journey_day"], r["required"], r["submitted"], r["pending"], r["completion"]) for r in days] == [
        (1, 10, 0, 10, 0.0), (2, 10, 1, 9, 10.0), (3, 10, 0, 10, 0.0), (4, 10, 0, 10, 0.0)]
    coaches = {r["coach_code"]: r for r in get("feedback-targets", group_by="coach")["rows"] if r["train_no"] == "12001"}
    assert (coaches["B1"]["required"], coaches["B1"]["submitted"], coaches["B1"]["pending"]) == (8, 1, 7)
    assert get("feedback-targets", group_by="direction")["rows"][0]["direction_label"] == "outbound"
    ver = get("feedback-verification")
    assert ver["pnr"]["invalid"] == 1 and ver["pnr"]["reasons"] == [{"reason": "PNR is for a different train", "count": 1}]
    assert ver["otp"]["verified"] == 1
    sync = world.client.get(f"{API}/reports/timetable-sync", headers=world.h("manager")).json()
    assert {t["train_no"]: t["stops"] for t in sync["trains"]}["12002"] == 4
    assert world.client.get(f"{API}/reports/feedback-targets", headers=world.h("jan"), params=params).status_code == 403


# ---- the RapidAPI provider ----------------------------------------------------------------------------------------

SAMPLE = {"success": True, "data": {
    "pnrNumber": "1234567890", "dateOfJourney": "Nov 24, 2026 10:00:00 PM", "trainNumber": "12001", "trainName": "Express",
    "sourceStation": "ADI", "destinationStation": "HWH", "reservationUpto": "HWH", "boardingPoint": "BRC",
    "journeyClass": "3A", "numberOfpassenger": 2, "chartStatus": "Chart Prepared", "trainCancelledFlag": False,
    "passengerList": [
        {"passengerSerialNumber": 1, "bookingStatus": "WL", "bookingCoachId": "", "currentStatus": "CNF",
         "currentCoachId": "B4", "currentBerthNo": 33, "currentBerthCode": "LB", "currentStatusDetails": "CNF/B4/33/LB"},
        {"passengerSerialNumber": 2, "bookingStatus": "CNF", "bookingCoachId": "B2", "bookingBerthNo": 7,
         "bookingBerthCode": "UB", "currentStatus": "CAN", "currentCoachId": ""}]}}


def test_rapidapi_response_is_mapped_field_by_field():
    r = parse_rapidapi_pnr(SAMPLE)
    assert (r.found, r.train_number, r.journey_date, r.boarding_code, r.from_code, r.alighting_code, r.journey_class) == (
        True, "12001", date(2026, 11, 24), "BRC", "ADI", "HWH", "3A")
    assert [(p.status, p.coach, p.berth, p.cancelled) for p in r.passengers] == [
        ("CNF", "B4", "33 LB", False), ("CAN", "B2", "7 UB", True)]
    assert r.coach_ids == frozenset({"B4", "B2"}) and not r.all_cancelled
    assert parse_rapidapi_pnr({"data": {"numberOfpassenger": 0}}).found is False
    missing = parse_rapidapi_pnr({"data": {"numberOfpassenger": 1, "passengerList": [{"currentStatus": "CNF"}]}})
    assert missing.found and missing.journey_date is None and missing.boarding_code is None  # nothing invented


def test_rapidapi_retries_once_and_never_treats_a_bad_key_as_a_bad_pnr(monkeypatch):
    answers = []

    def fake_get(url, timeout, headers):
        assert headers["x-rapidapi-key"] == "k" and url.endswith("/1234567890")
        return answers.pop(0)

    monkeypatch.setattr(external.httpx, "get", fake_get)
    p = RapidApiPnrProvider("https://h/getPNRStatus", "h", "k", 5, sleep=lambda s: None)
    answers[:] = [httpx.Response(502), httpx.Response(200, json=SAMPLE)]
    assert p.lookup("1234567890").found and not answers
    answers[:] = [httpx.Response(401, json={"message": "invalid key"})]
    with pytest.raises(ProviderUnavailable):
        p.lookup("1234567890")
    answers[:] = [httpx.Response(429)]
    with pytest.raises(ProviderUnavailable):
        p.lookup("1234567890")
    assert answers == []  # 429 is not retried
    assert p.lookup("12345").found is False  # not a PNR: no call made


def test_sync_log_records_every_attempt(world, tt):
    _refresh(world, world.train["id"])
    world.db.rollback()
    runs = list(world.db.scalars(select(TrainSyncRun).order_by(TrainSyncRun.started_at)))
    assert {(r.train_no, r.outcome, r.trigger) for r in runs} == {("12001", "updated", "manual"), ("12002", "updated", "manual")}
