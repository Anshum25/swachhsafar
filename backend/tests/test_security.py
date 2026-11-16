"""Backend sign-in (CAPTCHA, password, OTP), sessions and devices, capture evidence and security events."""

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models import Attendance, AuthSession, LoginAttempt, SecurityEvent
from app.security import captcha
from app.security.identity import PasswordCheck, get_password_verifier, get_token_issuer
from tests.factories import now_iso, upload

DEVICE = {"id": "dev-test-0001", "platform": "web", "label": "Test browser"}
PASSWORD = "Correct-Horse-9"


class FakePasswords:
    def __init__(self) -> None:
        self.accounts: dict[str, tuple[str, str, bool]] = {}  # email -> (password, uid, email_verified)

    def check(self, email, password):
        acct = self.accounts.get(email)
        if not acct or acct[0] != password:
            return PasswordCheck(ok=False, reason="invalid")
        return PasswordCheck(ok=True, uid=acct[1], email_verified=acct[2])


class FakeIssuer:
    def __init__(self) -> None:
        self.issued: list[tuple[str, dict]] = []
        self.by_email: dict[str, str] = {}

    def custom_token(self, uid, claims):
        self.issued.append((uid, claims))
        return f"custom::{uid}::{claims['sid']}"

    def uid_for_email(self, email):
        return self.by_email.get(email)


def solve(ch: dict) -> dict:
    for n in range(ch["maxnumber"] + 1):
        if hashlib.sha256(f"{ch['salt']}{n}".encode()).hexdigest() == ch["challenge"]:
            return {k: ch[k] for k in ("algorithm", "challenge", "salt", "signature")} | {"number": n}
    raise AssertionError("unsolvable")


@pytest.fixture
def signin(world, fakes):
    from app.main import app

    pw, issuer = FakePasswords(), FakeIssuer()
    app.dependency_overrides.update({get_password_verifier: lambda: pw, get_token_issuer: lambda: issuer})
    jan = world.users["jan"]
    jan.email = "jan@example.org"
    world.db.commit()
    pw.accounts[jan.email] = (PASSWORD, jan.firebase_uid, True)
    verifier = fakes[0]

    def session_headers(resp):
        """Simulates signInWithCustomToken: the ID token then carries the session claims."""
        uid, claims = issuer.issued[-1]
        verifier.claims[uid] = {"uid": uid, **claims}
        return {"Authorization": f"Bearer tok-{uid}"}

    return type("S", (), dict(pw=pw, issuer=issuer, jan=jan, headers=staticmethod(session_headers), sms=fakes[1], verifier=verifier))


def cap(client):
    r = client.get("/api/v1/auth/captcha")
    assert r.status_code == 200
    return solve(r.json())


def login(client, username, password=PASSWORD, solution=None, device=DEVICE):
    return client.post("/api/v1/auth/login", json=dict(username=username, password=password,
                                                       captcha=solution or cap(client), device=device))


# ---- CAPTCHA ----------------------------------------------------------------------------------------------
def test_captcha_once_only_and_checked(db, client):
    ch = client.get("/api/v1/auth/captcha").json()
    good = solve(ch)
    captcha.verify(db, good)
    with pytest.raises(Exception) as e:
        captcha.verify(db, good)
    assert e.value.details["reason"] == "reused"
    fresh = solve(client.get("/api/v1/auth/captcha").json())
    with pytest.raises(Exception) as e:
        captcha.verify(db, fresh | {"number": fresh["number"] + 1})
    assert e.value.details["reason"] == "wrong_answer"
    with pytest.raises(Exception) as e:
        captcha.verify(db, fresh | {"signature": "0" * 64})
    assert e.value.details["reason"] == "signature"
    with pytest.raises(Exception) as e:
        captcha.verify(db, fresh, now=datetime.now(timezone.utc).timestamp() + 3600)
    assert e.value.details["reason"] == "expired"


# ---- password sign-in -----------------------------------------------------------------------------------------
def test_password_login_by_employee_id_creates_session(world, signin):
    r = login(world.client, signin.jan.emp_id.lower())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method"] == "password" and body["device_id"] == DEVICE["id"]
    sess = world.db.get(AuthSession, uuid.UUID(body["session_id"]))
    assert sess.user_id == signin.jan.id and sess.revoked_at is None
    me = world.client.get("/api/v1/auth/me", headers=signin.headers(r))
    assert me.status_code == 200
    s = world.client.get("/api/v1/auth/session", headers=signin.headers(r)).json()
    assert s["session_id"] == body["session_id"] and s["device_status"] == "active"


def test_password_errors_are_generic_and_lock_out(world, signin):
    unknown = login(world.client, "NOBODY-1")
    wrong = login(world.client, signin.jan.emp_id, password="nope")
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["error"]["message"] == wrong.json()["error"]["message"]
    assert unknown.json()["error"]["code"] == wrong.json()["error"]["code"] == "invalid_credentials"
    for _ in range(4):
        login(world.client, signin.jan.emp_id, password="nope")
    locked = login(world.client, signin.jan.emp_id)  # even the right password, while locked
    assert locked.status_code == 429 and locked.json()["error"]["code"] == "login_locked"
    attempts = world.db.scalars(select(LoginAttempt).where(LoginAttempt.method == "password")).all()
    assert {a.reason for a in attempts if not a.success} >= {"unknown_user", "invalid"}


def test_password_login_needs_captcha(world, signin):
    r = world.client.post("/api/v1/auth/login", json=dict(username=signin.jan.emp_id, password=PASSWORD,
                                                          captcha={"algorithm": "SHA-256"}, device=DEVICE))
    assert r.status_code == 422 and r.json()["error"]["code"] == "captcha_invalid"


def test_backend_session_required_refuses_direct_firebase_tokens(world, signin, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "auth_require_backend_session", True)
    direct = world.client.get("/api/v1/auth/me", headers=world.h("jan"))  # token with no session id
    assert direct.status_code == 401 and direct.json()["error"]["code"] == "backend_login_required"
    r = login(world.client, signin.jan.emp_id)
    assert world.client.get("/api/v1/auth/me", headers=signin.headers(r)).status_code == 200


def test_logout_and_device_revocation(world, signin):
    r = login(world.client, signin.jan.emp_id)
    h = signin.headers(r)
    assert world.client.post("/api/v1/auth/logout", headers=h).status_code == 204
    gone = world.client.get("/api/v1/auth/me", headers=h)
    assert gone.status_code == 401 and gone.json()["error"]["code"] == "session_revoked"

    r = login(world.client, signin.jan.emp_id)
    h = signin.headers(r)
    assert world.client.post(f"/api/v1/security/devices/{DEVICE['id']}/revoke", headers=world.h("jan"),
                             json={"reason": "lost"}).status_code == 403  # janitors cannot manage devices
    rv = world.client.post(f"/api/v1/security/devices/{DEVICE['id']}/revoke", headers=world.h("admin"), json={"reason": "Phone lost"})
    assert rv.status_code == 200 and rv.json()["status"] == "revoked"
    blocked = world.client.get("/api/v1/auth/me", headers=h)
    assert blocked.status_code == 401 and blocked.json()["error"]["code"] in ("session_revoked", "device_revoked")
    again = login(world.client, signin.jan.emp_id)
    assert again.status_code == 403 and again.json()["error"]["code"] == "device_revoked"
    world.client.post(f"/api/v1/security/devices/{DEVICE['id']}/restore", headers=world.h("admin"))
    assert login(world.client, signin.jan.emp_id).status_code == 200


# ---- mobile OTP --------------------------------------------------------------------------------------------
def otp_request(client, mobile):
    return client.post("/api/v1/auth/otp/request", json=dict(mobile=mobile, captcha=cap(client), device=DEVICE))


def otp_verify(client, mobile, code):
    return client.post("/api/v1/auth/otp/verify", json=dict(mobile=mobile, code=code, device=DEVICE))


def test_otp_same_answer_for_unknown_mobile(world, signin):
    unknown = otp_request(world.client, "6000000001")
    known = otp_request(world.client, signin.jan.mobile)
    assert unknown.status_code == known.status_code == 200
    assert unknown.json() == known.json()
    assert [m for m, _ in signin.sms.sent] == [signin.jan.mobile]  # nothing sent to the unknown number


def test_otp_sign_in_once_with_attempt_limit(world, signin):
    otp_request(world.client, signin.jan.mobile)
    code = signin.sms.last_code
    wrong = otp_verify(world.client, signin.jan.mobile, "000000" if code != "000000" else "111111")
    assert wrong.status_code == 401 and wrong.json()["error"]["code"] == "otp_invalid"
    ok = otp_verify(world.client, signin.jan.mobile, code)
    assert ok.status_code == 200 and ok.json()["method"] == "otp"
    replay = otp_verify(world.client, signin.jan.mobile, code)
    assert replay.status_code == 401 and replay.json()["error"]["code"] == "otp_invalid"


def test_otp_cooldown_expiry_and_too_many_wrong_codes(world, signin, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "otp_resend_cooldown_seconds", 60)  # the test env sets 0
    otp_request(world.client, signin.jan.mobile)
    otp_request(world.client, signin.jan.mobile)  # within the cooldown: same answer, no second SMS
    assert len(signin.sms.sent) == 1
    code = signin.sms.last_code
    for _ in range(get_settings().otp_max_attempts):
        otp_verify(world.client, signin.jan.mobile, "999999" if code != "999999" else "888888")
    late = otp_verify(world.client, signin.jan.mobile, code)  # code burnt (or account locked) after the attempts
    assert late.status_code in (401, 429)

    monkeypatch.setattr(get_settings(), "login_max_failures", 50)
    monkeypatch.setattr(get_settings(), "otp_resend_cooldown_seconds", 0)
    monkeypatch.setattr(get_settings(), "otp_max_sends", 10)
    monkeypatch.setattr(get_settings(), "otp_ttl_seconds", -1)  # issued already expired
    otp_request(world.client, signin.jan.mobile)
    expired = otp_verify(world.client, signin.jan.mobile, signin.sms.last_code)
    assert expired.status_code == 401 and expired.json()["error"]["code"] == "otp_invalid"


def test_otp_sms_down_is_reported(world, signin):
    signin.sms.down = True
    r = otp_request(world.client, signin.jan.mobile)
    assert r.status_code == 503 and r.json()["error"]["code"] == "sms_unavailable"


# ---- capture evidence ------------------------------------------------------------------------------------------
def punch(world, *, stage=1, headers=None, **extra):
    body = dict(id=str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.jan.id), stage=stage,
                device_timestamp=now_iso(), latitude=23.1815, longitude=79.9864, gps_accuracy_m=12.5,
                photo_media_id=upload(world.client, world.sup, world.a.id, "attendance_photo"))
    body.update(extra)
    return world.client.post("/api/v1/attendance", headers=headers or world.h("sup"), json=body)


def sec(**kw):
    return {"app_version": "2.1.0", "platform": "web", "location_source": "browser", "mock_location": False, "vpn": False,
            "vpn_check": "server", "liveness": "not_required", **kw}


def test_capture_evidence_rules(world):
    old_fix = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    r = punch(world, gps_timestamp=old_fix, security=sec())
    assert r.status_code == 422 and r.json()["error"]["code"] == "gps_stale"
    r = punch(world, gps_timestamp=now_iso(), security=sec(mock_location=True))
    assert r.json()["error"]["code"] == "mock_location"
    r = punch(world, gps_timestamp=now_iso(), security=sec(vpn=True))
    assert r.json()["error"]["code"] == "vpn_detected"
    r = punch(world, gps_timestamp=now_iso(), gps_accuracy_m=900, security=sec())
    assert r.json()["error"]["code"] == "gps_inaccurate"
    ok = punch(world, gps_timestamp=now_iso(), security=sec())
    assert ok.status_code == 201, ok.text
    world.db.rollback()
    rec = world.db.get(Attendance, uuid.UUID(ok.json()["id"]))
    assert rec.security["vpn_check"] == "server" and rec.gps_timestamp is not None and not rec.risk_flags


def test_legacy_client_kept_and_flagged_and_impossible_travel(world):
    r = punch(world)  # an older app version: no evidence block
    assert r.status_code == 201
    world.db.rollback()  # new read snapshot (SQLite)
    rec = world.db.get(Attendance, uuid.UUID(r.json()["id"]))
    assert "legacy_client" in rec.risk_flags
    r = punch(world, stage=2, gps_timestamp=now_iso(), security=sec(), latitude=28.6139, longitude=77.2090)  # ~700 km in seconds
    assert r.status_code == 201
    world.db.rollback()  # new read snapshot (SQLite)
    rec = world.db.get(Attendance, uuid.UUID(r.json()["id"]))
    assert "impossible_travel" in rec.risk_flags
    world.db.rollback()
    events = world.db.scalars(select(SecurityEvent).where(SecurityEvent.type == "attendance.risk")).all()
    assert len(events) == 2 and all(e.source == "server" for e in events)


def test_liveness_required_when_face_verification_and_liveness_on(world):
    policy = world.client.get(f"/api/v1/divisions/{world.a.id}/policy", headers=world.h("admin")).json()
    policy.update(attendance_face_verification=True, face_liveness_required=True)
    assert world.client.put(f"/api/v1/divisions/{world.a.id}/policy", headers=world.h("admin"), json=policy).status_code == 200
    r = punch(world, gps_timestamp=now_iso(), security=sec(liveness="failed"), face_distance=0.2, face_model="x")
    assert r.status_code == 422
    assert r.json()["error"]["code"] in ("liveness_required", "face_not_enrolled")


# ---- security events ----------------------------------------------------------------------------------------
def test_device_events_idempotent_and_no_biometrics(world, signin):
    r = login(world.client, signin.jan.emp_id)
    h = signin.headers(r)
    ev = {"id": str(uuid.uuid4()), "type": "location.denied", "severity": "warning", "occurred_at": now_iso(),
          "details": {"reason": "permission"}}
    assert world.client.post("/api/v1/security/events", headers=h, json={"events": [ev]}).json()["accepted"] == 1
    assert world.client.post("/api/v1/security/events", headers=h, json={"events": [ev]}).json()["accepted"] == 0
    world.db.rollback()
    stored = world.db.get(SecurityEvent, uuid.UUID(ev["id"]))
    assert stored.source == "device" and stored.device_id == DEVICE["id"]
    bad = dict(ev, id=str(uuid.uuid4()), details={"face_descriptor": [0.1]})
    assert world.client.post("/api/v1/security/events", headers=h, json={"events": [bad]}).status_code == 422
    # Also through the offline sync batch, idempotently.
    op = {"op_id": str(uuid.uuid4()), "type": "security.event", "payload": dict(ev, id=str(uuid.uuid4()), type="vpn.detected")}
    out = world.client.post("/api/v1/sync/batch", headers=h, json={"device_id": DEVICE["id"], "operations": [op]}).json()
    assert out["results"][0]["outcome"] == "acknowledged", out
    listed = world.client.get("/api/v1/security/events", headers=world.h("admin")).json()
    assert {e["type"] for e in listed["items"]} >= {"location.denied", "vpn.detected"}


def test_network_check_reports_provider_answer(world):
    from app.main import app
    from app.providers.external import NetworkRisk, get_vpn_provider

    class Listed:
        def check(self, ip):
            return NetworkRisk(vpn=True, source="cidr", detail="203.0.113.0/24")

    app.dependency_overrides[get_vpn_provider] = lambda: Listed()
    r = world.client.get("/api/v1/security/network", headers={**world.h("jan"), "X-Forwarded-For": "203.0.113.7"})
    assert r.status_code == 200 and r.json()["vpn"] is True and r.json()["ip"] == "203.0.113.7"
    del app.dependency_overrides[get_vpn_provider]
    r = world.client.get("/api/v1/security/network", headers=world.h("jan"))
    assert r.json()["vpn"] is None  # no provider configured: unknown, never "no VPN"


def test_session_token_device_claim_must_match_session(world, signin):
    r = login(world.client, signin.jan.emp_id)
    h = signin.headers(r)
    uid = signin.issuer.issued[-1][0]
    verifier_claims = dict(signin.issuer.issued[-1][1])
    # Simulate a token whose device claim was swapped to another installation.
    world_claims = {"uid": uid, **verifier_claims, "did": "web-someotherdevice000000000000000"}
    signin.verifier.claims[uid] = world_claims
    bad = world.client.get("/api/v1/auth/me", headers=h)
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "session_device_mismatch"


def test_sync_batch_rejects_other_device_id(world, signin):
    r = login(world.client, signin.jan.emp_id)
    h = signin.headers(r)
    res = world.client.post("/api/v1/sync/batch", headers=h, json={"device_id": "web-notthisdevice", "operations": []})
    assert res.status_code in (403, 409, 422)


# ---- visible number CAPTCHA ---------------------------------------------------------------------------------
def _text_answer(token: str, monkeypatch=None) -> str:
    """Recovers the answer the way only the server can: by trying every number against the token's MAC."""
    import base64
    import json

    from app.security.captcha import _text_mac

    d = json.loads(base64.urlsafe_b64decode(token.encode()))
    for n in range(100000):
        a = f"{n:05d}"
        if _text_mac(d["n"], d["e"], a) == d["m"]:
            return a
    raise AssertionError("no answer")


def test_text_captcha_image_once_only_and_checked(db, client):
    import base64

    r = client.get("/api/v1/auth/captcha/image")
    assert r.status_code == 200
    ch = r.json()
    assert ch["algorithm"] == "TEXT" and ch["length"] == 5 and ch["image"].startswith("data:image/svg+xml;base64,")
    svg = base64.b64decode(ch["image"].split(",", 1)[1]).decode()
    assert "<text" not in svg and "answer" not in ch
    answer = _text_answer(ch["token"])
    wrong = "".join(str((int(c) + 1) % 10) for c in answer)
    bad = client.post("/api/v1/auth/captcha/check", json={"captcha": {"algorithm": "TEXT", "token": ch["token"], "answer": wrong}})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "captcha_invalid"
    # A wrong guess used up that image: even the right answer is now refused.
    again = client.post("/api/v1/auth/captcha/check", json={"captcha": {"algorithm": "TEXT", "token": ch["token"], "answer": answer}})
    assert again.status_code == 422
    ch2 = client.get("/api/v1/auth/captcha/image").json()
    ok = client.post("/api/v1/auth/captcha/check", json={"captcha": {"algorithm": "TEXT", "token": ch2["token"], "answer": _text_answer(ch2["token"])}})
    assert ok.status_code == 204


def test_text_captcha_expires(db):
    from app.errors import BusinessRuleViolation
    from app.security import captcha as c

    ch = c.create_text_challenge(now=1_000_000)
    with pytest.raises(BusinessRuleViolation):
        c.verify(db, {"algorithm": "TEXT", "token": ch["token"], "answer": _text_answer(ch["token"])}, now=1_000_000 + 10_000)


def test_password_login_with_typed_captcha(world, signin):
    ch = world.client.get("/api/v1/auth/captcha/image").json()
    sol = {"algorithm": "TEXT", "token": ch["token"], "answer": _text_answer(ch["token"])}
    r = login(world.client, signin.jan.emp_id, solution=sol)
    assert r.status_code == 200, r.text


# ---- SMS gateway --------------------------------------------------------------------------------------------
def test_otp_refused_for_every_number_when_sms_disabled(world, signin):
    from app.main import app
    from app.providers.external import DisabledSmsProvider, get_sms_provider

    app.dependency_overrides[get_sms_provider] = lambda: DisabledSmsProvider()
    for mobile in (signin.jan.mobile or "9000000001", "9999999999"):
        r = world.client.post("/api/v1/auth/otp/request", json={"mobile": mobile, "captcha": cap(world.client), "device": DEVICE})
        assert r.status_code == 503 and r.json()["error"]["code"] == "sms_unavailable"


def test_otp_send_is_audited_without_code_or_full_number(world, signin):
    from app.models import SecurityEvent

    jan = signin.jan
    jan.mobile = jan.mobile or "9876500011"
    world.db.commit()
    r = world.client.post("/api/v1/auth/otp/request", json={"mobile": jan.mobile, "captcha": cap(world.client), "device": DEVICE})
    assert r.status_code == 200, r.text
    ev = world.db.scalars(select(SecurityEvent).where(SecurityEvent.type == "sms.otp.accepted")).all()
    assert len(ev) == 1 and ev[0].details["message_id"] == "fake-1"
    blob = str(ev[0].details)
    assert jan.mobile not in blob and signin.sms.last_code not in blob
    st = world.client.get("/api/v1/security/sms/status", headers=world.h("admin")).json()
    assert st["recent"][0]["outcome"] == "accepted" and st["recent"][0]["to"].count("*") == 6
    assert world.client.get("/api/v1/security/sms/status", headers=world.h("jan")).status_code == 403


def test_msg91_adapter_payload_and_refusal(monkeypatch):
    import httpx

    from app.providers.external import Msg91SmsProvider, SmsRejected

    calls = []

    def fake_post(url, json, timeout, headers):
        calls.append((url, json, headers))
        ok = json["recipients"][0]["mobiles"] == "919876543210"
        return httpx.Response(200 if ok else 400, json={"type": "success", "message": "req-1"} if ok
                              else {"type": "error", "message": "Invalid template"})

    monkeypatch.setattr(httpx, "post", fake_post)
    p = Msg91SmsProvider("KEY", "TPL", None, 5)
    assert p.send_login_otp("9876543210", "123456") == "req-1"
    url, body, headers = calls[0]
    assert url.endswith("/api/v5/flow") and headers["authkey"] == "KEY"
    assert body["template_id"] == "TPL" and body["recipients"][0]["otp"] == "123456"
    with pytest.raises(SmsRejected):
        p.send_login_otp("9000000000", "123456")
