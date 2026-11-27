import uuid
from datetime import timedelta

from sqlalchemy import select

from app.models import OtpChallenge, PassengerFeedback
from app.providers.external import PnrResult
from tests.factories import now_iso, upload

API = "/api/v1/feedback"


def start(world, pnr="1234567890", mobile="9123456789", coach="B1", by="sup", **extra):
    body = dict(id=str(uuid.uuid4()), journey_id=world.journey["id"], coach_code=coach, journey_day=1,
                passenger_name="Asha", mobile=mobile, pnr=pnr, seat_no="12", device_timestamp=now_iso(),
                latitude=23.1, longitude=79.9, **extra)
    return world.client.post(f"{API}/passenger", headers=world.h(by), json=body)


def valid_pnr(fakes, pnr="1234567890", train="12001", coaches=("B1",)):
    fakes[2].results[pnr] = PnrResult(found=True, train_number=train, train_name="Test", coach_ids=frozenset(coaches))


def ratings(world, coach_class="AC"):
    qs = world.passenger_bank["questions"]
    key = {"AC": "applies_ac", "GEN": "applies_gen"}.get(coach_class, "applies_non_ac")
    applicable = [q for q in qs if q[key]]
    return [{"question_id": q["id"], "value": 4} for q in applicable if q["required"]]


def verified_feedback(world, fakes, **kw):
    valid_pnr(fakes, kw.get("pnr", "1234567890"), coaches=(kw.get("coach", "B1"),))
    fb = start(world, **kw).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.status_code == 200, r.text
    return r.json()


def test_full_passenger_flow_never_exposes_otp(world, fakes):
    valid_pnr(fakes)
    r = start(world)
    assert r.status_code == 201, r.text
    fb = r.json()
    assert (fb["status"], fb["pnr_status"], fb["otp_status"]) == ("draft", "pending", "not_sent")
    assert fb["mobile_masked"] == "91XXXXXX89" and "mobile" not in fb

    # Mobile first (the passenger workflow's order), then the PNR: an OTP may be sent before the PNR check.
    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.status_code == 200
    code = fakes[1].last_code
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    assert r.json()["pnr_status"] == "valid" and r.json()["status"] == "draft"
    assert code not in r.text and len(code) == 6
    stored = world.db.scalar(select(OtpChallenge).where(OtpChallenge.feedback_id == uuid.UUID(fb["id"])))
    assert code not in stored.code_hash and len(stored.code_hash) == 64

    r = world.client.post(f"{API}/passenger/{fb['id']}/complete", headers=world.h("sup"), json={"ratings": ratings(world)})
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_verified"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": code})
    assert r.json()["status"] == "verified"

    voice = upload(world.client, world.sup, world.a.id, "feedback_voice", data=b"ID3" + bytes(300), content_type="audio/mpeg")
    r = world.client.post(f"{API}/passenger/{fb['id']}/complete", headers=world.h("sup"),
                          json={"ratings": ratings(world), "comments": "clean", "voice_media_id": voice})
    assert r.status_code == 200 and r.json()["status"] == "completed" and len(r.json()["ratings"]) == 2


def test_wrong_otp_attempts_lock(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    wrong = "000000" if fakes[1].last_code != "000000" else "111111"
    for i in range(4):
        r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": wrong})
        assert r.json()["error"]["code"] == "otp_invalid"
        assert r.json()["error"]["details"]["attempts_remaining"] == 4 - i
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": wrong})
    assert r.json()["error"]["code"] == "otp_locked"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.status_code == 422
    assert world.client.get(f"{API}/passenger/{fb['id']}", headers=world.h("sup")).json()["status"] == "void"


def test_expired_otp_and_resend_limit(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    for challenge in world.db.scalars(select(OtpChallenge)):  # expire every challenge (dialect-neutral)
        challenge.expires_at -= timedelta(hours=1)
    world.db.commit()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.json()["error"]["code"] == "otp_expired"
    assert world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup")).json()["sends_remaining"] == 1
    assert world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup")).status_code == 200
    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.json()["error"]["code"] == "otp_send_limit"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.json()["status"] == "verified"


def test_pnr_mismatch_voids_and_provider_outage_keeps_pending(world, fakes):
    valid_pnr(fakes, train="99999")
    fb = start(world).json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup")).json()
    assert (r["status"], r["pnr_status"], r["void_reason"]) == ("void", "invalid", "PNR is for a different train")

    valid_pnr(fakes, pnr="5555555555", coaches=("A1",))
    fb = start(world, pnr="5555555555", mobile="9000000001").json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup")).json()
    assert r["void_reason"] == "PNR coach does not match"

    fakes[2].down = True
    fb = start(world, pnr="6666666666", mobile="9000000002").json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "pnr_unavailable"
    assert world.client.get(f"{API}/passenger/{fb['id']}", headers=world.h("sup")).json()["pnr_status"] == "pending"


def test_sms_outage_does_not_create_challenge(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    fakes[1].down = True
    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.status_code == 503
    assert world.db.scalar(select(OtpChallenge)) is None


def test_duplicate_pnr_and_mobile(world, fakes):
    verified_feedback(world, fakes)
    r = start(world, mobile="9000000003")
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pnr"
    r = start(world, pnr="2222222222")
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_mobile"


def test_duplicate_race_caught_by_database(world, fakes):
    valid_pnr(fakes)
    a, b = start(world).json(), start(world, mobile="9000000004").json()  # both drafts for the same PNR
    for fb in (a, b):
        world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{a['id']}/send-otp", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{a['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    world.client.post(f"{API}/passenger/{b['id']}/send-otp", headers=world.h("sup"))
    r = world.client.post(f"{API}/passenger/{b['id']}/verify-otp", headers=world.h("sup"), json={"code": fakes[1].last_code})
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_feedback"


def test_staff_mobile_rejected_and_pnr_required(world, fakes):
    r = start(world, mobile=world.jan.mobile)
    assert r.status_code == 422 and r.json()["error"]["code"] == "staff_mobile"
    r = start(world, pnr=None)
    assert r.status_code == 422 and r.json()["error"]["code"] == "pnr_required"


def test_general_coach_asks_seat_not_pnr(world, fakes):
    """A general (unreserved) coach has no PNR: the seat number is required, a PNR is ignored, and the PNR
    check is not required even where the division requires PNRs (reserved coaches still need one)."""
    train = world.create_train(train_no="12003", coaches=[
        {"code": "B1", "classification": "AC"}, {"code": "GEN1", "classification": "GEN"}])
    journey = world.create_journey(train=train)

    def post(coach, pnr, seat):
        body = dict(id=str(uuid.uuid4()), journey_id=journey["id"], coach_code=coach, journey_day=1, passenger_name="Asha",
                    mobile="9123456789", pnr=pnr, seat_no=seat, device_timestamp=now_iso(), latitude=23.1, longitude=79.9)
        return world.client.post(f"{API}/passenger", headers=world.h("sup"), json=body)

    r = post("GEN1", None, None)
    assert r.status_code == 422 and r.json()["error"]["code"] == "seat_required"
    r = post("GEN1", "1234567890", "42")
    assert r.status_code == 201, r.text
    assert r.json()["pnr"] is None and r.json()["seat_no"] == "42" and r.json()["pnr_status"] == "not_required"
    r = post("B1", None, "12")
    assert r.status_code == 422 and r.json()["error"]["code"] == "pnr_required"


def test_only_collector_continues(world, fakes):
    valid_pnr(fakes)
    fb = start(world).json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("manager"))
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_collector"
    assert world.client.get(f"{API}/passenger/{fb['id']}", headers=world.h("manager_b")).status_code == 404


def test_rating_validation(world, fakes):
    fb = verified_feedback(world, fakes, coach="S1", pnr="1234567890")  # Non-AC: bedroll question does not apply
    bedroll = next(q for q in world.passenger_bank["questions"] if q["text_en"] == "Bedroll quality")
    url = f"{API}/passenger/{fb['id']}/complete"
    r = world.client.post(url, headers=world.h("sup"), json={"ratings": ratings(world, "NON_AC") + [{"question_id": bedroll["id"], "value": 3}]})
    assert r.json()["error"]["code"] == "invalid_question"
    r = world.client.post(url, headers=world.h("sup"), json={"ratings": [{**ratings(world, "NON_AC")[0], "value": 9}]})
    assert r.json()["error"]["code"] == "rating_range"
    optional_only = [{"question_id": world.passenger_bank["questions"][2]["id"], "value": 3}]
    r = world.client.post(url, headers=world.h("sup"), json={"ratings": optional_only})
    assert r.json()["error"]["code"] == "missing_rating"
    assert world.client.post(url, headers=world.h("sup"), json={"ratings": ratings(world, "NON_AC")}).status_code == 200


def test_policy_without_pnr_or_otp(world, fakes):
    world.client.put(f"/api/v1/divisions/{world.a.id}/policy", headers=world.h("admin"),
                     json={"passenger_pnr_required": False, "passenger_otp_required": False})
    fb = start(world, pnr=None).json()
    assert (fb["status"], fb["pnr_status"], fb["otp_status"]) == ("verified", "not_required", "not_required")


def test_railway_feedback_limit(world):
    def railway(rid):
        qs = world.railway_bank["questions"]
        return world.client.post(f"{API}/railway", headers=world.h("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=world.journey["id"], railway_employee_id=rid, official_name="Insp. Rao",
            journey_day=1, device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
            ratings=[{"question_id": q["id"], "value": 5} for q in qs if q["required"]]))
    assert railway("R1").status_code == 201
    assert railway("R2").status_code == 201
    r = railway("R3")
    assert r.status_code == 409 and r.json()["error"]["code"] == "railway_feedback_limit"


def test_questions_endpoint_filters_by_coach_class(world):
    r = world.client.get(f"{API}/questions?journey_id={world.journey['id']}&coach_code=S1", headers=world.h("sup"))
    assert [q["text_en"] for q in r.json()] == ["Toilet cleaning", "Staff behaviour"]


def test_general_coaches_get_their_own_questions(world):
    """GEN (general, unreserved) is a class of its own: a question can be for General coaches only, or not for them."""
    train = world.create_train(train_no="12002", coaches=[
        {"code": "B1", "classification": "AC"}, {"code": "S1", "classification": "NON_AC"},
        {"code": "GEN1", "classification": "GEN"}])
    journey = world.create_journey(train=train)
    r = world.client.post(f"{API}/question-banks", headers=world.h("admin"), json=dict(
        division_id=str(world.a.id), audience="passenger", name="passenger v2", scale_min=1, scale_max=5,
        questions=[dict(text_en="Toilet cleaning"),
                   dict(text_en="Bedroll quality", applies_non_ac=False, applies_gen=False),
                   dict(text_en="Seats and floor of the general coach", applies_ac=False, applies_non_ac=False)]))
    assert r.status_code == 201, r.text
    assert r.json()["questions"][2]["applies_gen"] is True and r.json()["questions"][1]["applies_gen"] is False
    world.client.post(f"{API}/question-banks/{r.json()['id']}/activate", headers=world.h("admin"))
    asked = lambda coach: [q["text_en"] for q in world.client.get(  # noqa: E731
        f"{API}/questions?journey_id={journey['id']}&coach_code={coach}", headers=world.h("sup")).json()]
    assert asked("B1") == ["Toilet cleaning", "Bedroll quality"]
    assert asked("S1") == ["Toilet cleaning"]
    assert asked("GEN1") == ["Toilet cleaning", "Seats and floor of the general coach"]
    bad = world.client.post(f"{API}/question-banks", headers=world.h("admin"), json=dict(
        division_id=str(world.a.id), audience="passenger", name="passenger v3", scale_min=1, scale_max=5,
        questions=[dict(text_en="Nowhere", applies_ac=False, applies_non_ac=False, applies_gen=False)]))
    assert bad.status_code == 422


def test_void_by_reviewer(world, fakes):
    fb = verified_feedback(world, fakes)
    assert world.client.post(f"{API}/passenger/{fb['id']}/void", headers=world.h("sup"), json={"reason": "duplicate"}).status_code == 403
    r = world.client.post(f"{API}/passenger/{fb['id']}/void", headers=world.h("manager"), json={"reason": "fraudulent entry"})
    assert r.json()["status"] == "void"
    assert world.db.get(PassengerFeedback, uuid.UUID(fb["id"])).void_reason == "fraudulent entry"


def test_assign_bank_to_stations(world):
    """Assign puts a copy of a bank (questions and answer options) at each chosen station and makes it active there."""
    r = world.client.post(f"{API}/question-banks", headers=world.h("sa"), json=dict(
        audience="passenger", name="Standard passenger", option_labels=["Poor", "Average", "Good", "Very Good", "Excellent"],
        questions=[dict(text_en="Toilet cleaning", text_hi="शौचालय")]))
    assert r.status_code == 201, r.text
    bank = r.json()
    assert (bank["scale_min"], bank["scale_max"]) == (1, 5)
    assert world.client.post(f"{API}/question-banks/{bank['id']}/assign", headers=world.h("admin"),
                             json={"division_ids": [str(world.b.id)]}).status_code == 403
    r = world.client.post(f"{API}/question-banks/{bank['id']}/assign", headers=world.h("sa"),
                          json={"division_ids": [str(world.a.id), str(world.b.id)]})
    assert r.status_code == 200, r.text
    assert sorted(x["division_id"] for x in r.json()) == sorted([str(world.a.id), str(world.b.id)])
    for div in (world.a, world.b):
        banks = world.client.get(f"{API}/question-banks?division_id={div.id}", headers=world.h("sa")).json()
        active = [x for x in banks if x["is_active"] and x["audience"] == "passenger"]
        assert len(active) == 1 and active[0]["option_labels"][4] == "Excellent"
        assert active[0]["questions"][0]["text_hi"] == "शौचालय"


def test_master_otp_verifies_and_is_audited(world, fakes, monkeypatch):
    from pydantic import SecretStr

    from app.config import get_settings
    from app.models import AuditLog
    monkeypatch.setattr(get_settings(), "feedback_master_otp", SecretStr("246810"))
    valid_pnr(fakes)
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/verify-pnr", headers=world.h("sup"))
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": "246810"})
    assert r.status_code == 200 and r.json()["status"] == "verified", r.text
    log = world.db.scalar(select(AuditLog).where(AuditLog.action == "feedback.passenger.otp_verified"))
    assert log.changes["via"] == "master_otp"


def test_master_otp_skips_disabled_sms(world, fakes, monkeypatch):
    from pydantic import SecretStr

    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "feedback_master_otp", SecretStr("246810"))
    monkeypatch.setattr(fakes[1], "enabled", False, raising=False)
    fb = start(world).json()
    r = world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    assert r.status_code == 200, r.text
    assert fakes[1].sent == []  # no SMS went out
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": "246810"})
    assert r.json()["otp_status"] == "verified"


def test_no_master_otp_by_default(world, fakes):
    fb = start(world).json()
    world.client.post(f"{API}/passenger/{fb['id']}/send-otp", headers=world.h("sup"))
    wrong = "000000" if fakes[1].last_code != "000000" else "111111"
    r = world.client.post(f"{API}/passenger/{fb['id']}/verify-otp", headers=world.h("sup"), json={"code": wrong})
    assert r.json()["error"]["code"] == "otp_invalid"
