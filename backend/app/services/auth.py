"""Backend-owned sign-in: Employee ID (or email) + password + CAPTCHA, and mobile + OTP.

Everything lives in PostgreSQL: the password hash in user_credentials, the session in auth_sessions. Both
sign-in methods end in a session and an opaque bearer token naming it (app/security/tokens.py); no other kind of
token is accepted by the API.

Error messages are generic ("Employee ID or password is incorrect"; an OTP request always answers the same),
so the endpoints do not reveal which employee IDs or mobile numbers exist, and an unknown account costs the same
hashing time as a wrong password. Every attempt is recorded in login_attempts; too many failures for the same
account/mobile (or from one IP) lock it for the window."""

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import BusinessRuleViolation, Forbidden, ServiceUnavailable, TooManyRequests, Unauthenticated
from app.models import AuthSession, Device, DeviceStatus, LoginAttempt, LoginOtp, User, UserCredential, UserStatus
from app.providers.external import ProviderUnavailable, SmsProvider
from app.schemas.security import DeviceIn, OtpLoginRequest, OtpLoginVerify, PasswordLogin
from app.security import captcha, passwords, tokens
from app.services.common import audit
from app.services import security as security_svc
from app.timeutil import utcnow

INVALID_PASSWORD = "Employee ID or password is incorrect."
INVALID_OTP = "The code is incorrect or has expired. Request a new code."
IP_FAILURE_FACTOR = 4  # one IP may fail this many times the per-account limit before it is throttled too


# ---- lock-out and audit ----------------------------------------------------------------------------------
def _failures(db: Session, *, subject: str | None = None, ip: str | None = None, methods: tuple[str, ...], since: datetime) -> int:
    q = select(func.count()).select_from(LoginAttempt).where(
        LoginAttempt.success.is_(False), LoginAttempt.method.in_(methods), LoginAttempt.created_at >= since)
    q = q.where(LoginAttempt.subject == subject) if subject is not None else q.where(LoginAttempt.ip == ip)
    return db.scalar(q) or 0


def _check_lockout(db: Session, subject: str, ip: str | None, methods: tuple[str, ...], now: datetime) -> None:
    s = get_settings()
    since = now - timedelta(seconds=s.login_failure_window_seconds)
    locked = _failures(db, subject=subject, methods=methods, since=since) >= s.login_max_failures
    if not locked and ip:
        locked = _failures(db, ip=ip, methods=methods, since=since) >= s.login_max_failures * IP_FAILURE_FACTOR
    if locked:
        raise TooManyRequests("Too many unsuccessful attempts. Try again later.", code="login_locked",
                              details={"retry_after_seconds": s.login_failure_window_seconds})


def _attempt(db: Session, method: str, subject: str, *, success: bool, user: User | None, device_id: str | None,
             ip: str | None, reason: str | None, now: datetime) -> None:
    db.add(LoginAttempt(method=method, subject=subject[:254], user_id=user.id if user else None, device_id=device_id,
                        ip=ip, success=success, reason=reason, created_at=now))


# ---- devices and sessions --------------------------------------------------------------------------------
def _device(db: Session, d: DeviceIn, ip: str | None, now: datetime) -> Device:
    device = db.get(Device, d.id)
    if device is None:
        device = Device(id=d.id, platform=d.platform, label=d.label, status=DeviceStatus.ACTIVE)
        db.add(device)
    elif device.status == DeviceStatus.REVOKED:
        raise Forbidden("This device has been blocked by an administrator. Contact your supervisor.", code="device_revoked")
    device.platform, device.label = d.platform, d.label or device.label
    device.last_seen_at, device.last_ip = now, ip
    db.flush()  # sessions and OTPs reference it
    return device


def _start_session(db: Session, user: User, device: Device, method: str, ip: str | None, now: datetime) -> dict:
    device.first_user_id = device.first_user_id or user.id
    device.last_user_id = user.id
    session = AuthSession(id=uuid.uuid4(), user_id=user.id, device_id=device.id, method=method, ip=ip, last_seen_at=now)
    issued = tokens.issue(session.id)
    session.token_hash = issued.token_hash
    db.add(session)
    db.flush()
    audit(db, actor_id=user.id, action="auth.sign_in", entity=session, division_id=user.division_id,
          changes={"method": method, "device_id": device.id})
    db.commit()
    return {"access_token": issued.token, "token_type": "bearer", "session_id": session.id, "device_id": device.id,
            "method": method}


def authenticate(db: Session, token: str) -> tuple[AuthSession, User]:
    """Called for every API request with the bearer token: its session, and the employee it belongs to."""
    s = get_settings()
    parsed = tokens.parse(token)
    session = db.get(AuthSession, parsed[0]) if parsed else None
    if session is None or not tokens.matches(parsed[1], session.token_hash):
        raise Unauthenticated("Your sign-in is not valid. Sign in again.", code="invalid_token")
    if session.revoked_at is not None:
        raise Unauthenticated("Your session was ended. Sign in again.", code="session_revoked",
                              details={"reason": session.revoke_reason})
    now = utcnow()
    device = db.get(Device, session.device_id)
    if device is None or device.status == DeviceStatus.REVOKED:
        raise Unauthenticated("This device has been blocked by an administrator.", code="device_revoked")
    if now - session.last_seen_at > timedelta(days=s.session_idle_days):
        session.revoked_at, session.revoke_reason = now, "idle"
        db.commit()
        raise Unauthenticated("Your session expired. Sign in again.", code="session_expired")
    user = db.get(User, session.user_id)
    if user is None or user.status == UserStatus.DELETED:
        raise Forbidden("Account is not provisioned for operations", code="not_provisioned")
    if user.status != UserStatus.ACTIVE:
        raise Forbidden("Account is not active", code="account_inactive")
    if now - session.last_seen_at > timedelta(minutes=5):  # bounded write load
        session.last_seen_at = now
        device.last_seen_at = now
        db.commit()
    return session, user


def logout(db: Session, user: User, session_id: uuid.UUID | None) -> None:
    if session_id is None:
        return
    session = db.get(AuthSession, session_id)
    if session is not None and session.user_id == user.id and session.revoked_at is None:
        session.revoked_at, session.revoke_reason = utcnow(), "logout"
        audit(db, actor_id=user.id, action="auth.sign_out", entity=session, division_id=user.division_id)
        db.commit()


def revoke_device(db: Session, actor: User, device_id: str, reason: str | None) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        from app.errors import NotFound

        raise NotFound("Device not found")
    now = utcnow()
    device.status, device.revoked_at, device.revoked_by_id, device.revoke_reason = DeviceStatus.REVOKED, now, actor.id, reason
    for session in db.scalars(select(AuthSession).where(AuthSession.device_id == device_id, AuthSession.revoked_at.is_(None))):
        session.revoked_at, session.revoke_reason = now, "device_revoked"
    audit(db, actor_id=actor.id, action="device.revoke", entity=device, division_id=None, changes={"reason": reason})
    db.commit()
    return device


def restore_device(db: Session, actor: User, device_id: str) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        from app.errors import NotFound

        raise NotFound("Device not found")
    device.status, device.revoked_at, device.revoked_by_id, device.revoke_reason = DeviceStatus.ACTIVE, None, None, None
    audit(db, actor_id=actor.id, action="device.restore", entity=device, division_id=None)
    db.commit()
    return device


# ---- passwords -------------------------------------------------------------------------------------------
def set_password(db: Session, user: User, password: str, *, source: str, now: datetime | None = None) -> UserCredential:
    """Stores a new password for `user` (hashed). The caller commits and audits."""
    now = now or utcnow()
    hashed = passwords.hash_password(password)
    cred = db.get(UserCredential, user.id)
    if cred is None:
        cred = UserCredential(user_id=user.id, password_hash=hashed, source=source, password_changed_at=now)
        db.add(cred)
    else:
        cred.password_hash, cred.source, cred.password_changed_at = hashed, source, now
    db.flush()
    db.expire(user, ["credential"])
    return cred


def change_password(db: Session, user: User, session_id: uuid.UUID | None, current: str, new: str) -> None:
    """The signed-in employee changes their own password. Every other session of theirs is ended, so a
    password someone else knew stops working everywhere, not only for new sign-ins."""
    now = utcnow()
    cred = db.get(UserCredential, user.id)
    _check_lockout(db, f"pwchange:{user.id}", None, ("password_change",), now)
    if cred is None or not passwords.verify_password(cred.password_hash, current).ok:
        if cred is None:
            passwords.burn_time(current)
        _attempt(db, "password_change", f"pwchange:{user.id}", success=False, user=user, device_id=None, ip=None,
                 reason="wrong_password", now=now)
        db.commit()
        raise Unauthenticated("Your current password is not correct.", code="wrong_password")
    if current == new:
        raise BusinessRuleViolation("The new password must be different from the current one.", code="password_unchanged")
    set_password(db, user, new, source="user", now=now)
    ended = 0
    for other in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))):
        if other.id != session_id:
            other.revoked_at, other.revoke_reason = now, "password_changed"
            ended += 1
    audit(db, actor_id=user.id, action="auth.password.change", entity=user, division_id=user.division_id,
          changes={"other_sessions_ended": ended})
    db.commit()


# ---- password + CAPTCHA ----------------------------------------------------------------------------------
def _find_user(db: Session, username: str) -> User | None:
    return db.scalar(select(User).where(
        User.status != UserStatus.DELETED,
        or_(func.lower(User.emp_id) == username, func.lower(User.email) == username)))


def login_password(db: Session, body: PasswordLogin, ip: str | None) -> dict:
    now = utcnow()
    subject = body.username.strip().lower()
    captcha.verify(db, body.captcha)
    _check_lockout(db, subject, ip, ("password",), now)
    device = _device(db, body.device, ip, now)

    def fail(reason: str, user: User | None = None, message: str = INVALID_PASSWORD, code: str = "invalid_credentials"):
        _attempt(db, "password", subject, success=False, user=user, device_id=device.id, ip=ip, reason=reason, now=now)
        db.commit()
        raise Unauthenticated(message, code=code)

    user = _find_user(db, subject)
    cred = db.get(UserCredential, user.id) if user is not None else None
    if cred is None:
        passwords.burn_time(body.password)  # same cost as a real check: existence is not revealed by timing
        fail("unknown_user" if user is None else "no_password", user)
    check = passwords.verify_password(cred.password_hash, body.password)
    if not check.ok:
        fail("invalid", user)
    if user.status != UserStatus.ACTIVE:
        fail("inactive", user, "Your account is not active. Contact your administrator.", "account_inactive")
    if check.needs_rehash:  # imported from Firebase (or older parameters): store it in today's format
        old_scheme = cred.password_hash.split("$", 1)[0]
        cred.password_hash = passwords.hash_password(body.password)  # same password: password_changed_at stays
        audit(db, actor_id=user.id, action="auth.password.rehash", entity=user, division_id=user.division_id,
              changes={"from": old_scheme, "to": passwords.NATIVE})
    _attempt(db, "password", subject, success=True, user=user, device_id=device.id, ip=ip, reason=None, now=now)
    return _start_session(db, user, device, "password", ip, now)


# ---- mobile OTP --------------------------------------------------------------------------------------------
def _otp_hash(otp_id: uuid.UUID, code: str) -> str:
    pepper = get_settings().otp_pepper.get_secret_value().encode()
    return hmac.new(pepper, f"login:{otp_id}:{code}".encode(), hashlib.sha256).hexdigest()


def request_otp(db: Session, body: OtpLoginRequest, ip: str | None, sms: SmsProvider) -> dict:
    """Always the same answer whether or not the mobile is registered (no enumeration)."""
    s = get_settings()
    now = utcnow()
    if not getattr(sms, "enabled", True):
        # No gateway: say so to everyone (same answer for every number), never pretend a code was sent.
        raise ServiceUnavailable("Sign-in by mobile number is not available yet (SMS is not set up). "
                                 "Use your Employee ID and password.", code="sms_unavailable")
    captcha.verify(db, body.captcha)
    _check_lockout(db, body.mobile, ip, ("otp_request", "otp_verify"), now)
    device = _device(db, body.device, ip, now)
    answer = {"expires_in_seconds": s.otp_ttl_seconds, "resend_after_seconds": s.otp_resend_cooldown_seconds}
    user = db.scalar(select(User).where(User.mobile == body.mobile, User.status == UserStatus.ACTIVE))

    def done(reason: str | None, success: bool) -> dict:
        _attempt(db, "otp_request", body.mobile, success=success, user=user, device_id=device.id, ip=ip, reason=reason, now=now)
        db.commit()
        return answer

    if user is None:
        return done("unknown_mobile", True)  # counted as an ordinary request; nothing is sent
    window = now - timedelta(seconds=s.login_failure_window_seconds)
    recent = db.scalars(select(LoginOtp).where(LoginOtp.mobile == body.mobile, LoginOtp.created_at >= window)
                        .order_by(LoginOtp.created_at.desc())).all()
    if recent and now - recent[0].last_sent_at < timedelta(seconds=s.otp_resend_cooldown_seconds):
        return done("cooldown", True)
    if len(recent) >= s.otp_max_sends:
        return done("send_limit", True)
    for old in recent:
        old.consumed_at = old.consumed_at or now  # only the newest code is valid
    otp_id = uuid.uuid4()
    code = f"{secrets.randbelow(1_000_000):06d}"
    provider = getattr(sms, "name", type(sms).__name__)
    correlation = uuid.uuid4().hex[:16]
    try:
        message_id = sms.send_login_otp(body.mobile, code)
    except ProviderUnavailable as exc:
        db.rollback()
        security_svc.record(db, type="sms.otp.failed", severity="warning", user_id=user.id, device_id=device.id, ip=ip,
                            details={"provider": provider, "to": redact_mobile(body.mobile), "correlation_id": correlation,
                                     "category": getattr(exc, "category", "unreachable"), "error": str(exc)[:160]})
        db.commit()
        raise ServiceUnavailable("Sign-in codes cannot be sent right now. Use your Employee ID and password.",
                                 code="sms_unavailable") from exc
    db.add(LoginOtp(id=otp_id, user_id=user.id, mobile=body.mobile, code_hash=_otp_hash(otp_id, code),
                    expires_at=now + timedelta(seconds=s.otp_ttl_seconds), attempts=0, send_count=len(recent) + 1,
                    last_sent_at=now, device_id=device.id))
    # "accepted": the gateway took the message. Handset delivery is only known from a delivery report.
    security_svc.record(db, type="sms.otp.accepted", user_id=user.id, device_id=device.id, ip=ip,
                        details={"provider": provider, "to": redact_mobile(body.mobile), "correlation_id": correlation,
                                 "message_id": message_id, "delivery": "unknown"})
    return done(None, True)


def redact_mobile(mobile: str) -> str:
    return f"{mobile[:2]}******{mobile[-2:]}" if len(mobile) >= 4 else "****"


def verify_otp(db: Session, body: OtpLoginVerify, ip: str | None) -> dict:
    s = get_settings()
    now = utcnow()
    _check_lockout(db, body.mobile, ip, ("otp_request", "otp_verify"), now)
    device = _device(db, body.device, ip, now)
    otp = db.scalar(select(LoginOtp).where(LoginOtp.mobile == body.mobile, LoginOtp.consumed_at.is_(None))
                    .order_by(LoginOtp.created_at.desc()).limit(1).with_for_update())
    user = db.get(User, otp.user_id) if otp else None

    def fail(reason: str):
        _attempt(db, "otp_verify", body.mobile, success=False, user=user, device_id=device.id, ip=ip, reason=reason, now=now)
        db.commit()
        raise Unauthenticated(INVALID_OTP, code="otp_invalid")

    if otp is None:
        fail("no_code")
    if now > otp.expires_at:
        otp.consumed_at = now
        fail("expired")
    otp.attempts += 1
    if not hmac.compare_digest(otp.code_hash, _otp_hash(otp.id, body.code)):
        if otp.attempts >= s.otp_max_attempts:
            otp.consumed_at = now  # this code can no longer be used
        fail("wrong_code")
    otp.consumed_at = now
    if user is None or user.status != UserStatus.ACTIVE or user.mobile != body.mobile:
        fail("inactive")
    _attempt(db, "otp_verify", body.mobile, success=True, user=user, device_id=device.id, ip=ip, reason=None, now=now)
    return _start_session(db, user, device, "otp", ip, now)
