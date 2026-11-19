"""Sign-in (password + CAPTCHA, mobile OTP), sessions, devices, network risk and security events."""

from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import Device, DeviceStatus, SecurityEvent
from app.providers.external import SmsProvider, VpnProvider, get_sms_provider, get_vpn_provider
from app.schemas.common import Page, PageParams
from app.schemas.security import (
    CaptchaCheckIn,
    CaptchaImageOut,
    CaptchaOut, DeviceOut, DeviceRevokeIn, LoginOut, NetworkOut, OtpLoginRequest, OtpLoginVerify, OtpRequestOut,
    PasswordChangeIn, PasswordLogin, SecurityEventOut, SecurityEventsIn, SessionOut,
)
from app.security import captcha
from app.security.principal import Principal, get_principal
from app.security.ratelimit import limiter
from app.services import auth, security
from app.services.common import paginate
from app.timeutil import utcnow

signin_router = APIRouter(prefix="/auth", tags=["auth"])
security_router = APIRouter(prefix="/security", tags=["security"])


def client_ip(request: Request) -> str | None:
    """The caller's address behind TRUSTED_PROXY_HOPS reverse proxies (X-Forwarded-For, rightmost-first)."""
    hops = get_settings().trusted_proxy_hops
    forwarded = [x.strip() for x in request.headers.get("x-forwarded-for", "").split(",") if x.strip()]
    if hops > 0 and forwarded:
        return forwarded[-hops] if len(forwarded) >= hops else forwarded[0]
    return request.client.host if request.client else None


def _per_ip(request: Request, limit: int, window: int) -> str | None:
    ip = client_ip(request)
    limiter.hit(f"ip:{ip}:{request.scope['route'].path}", limit, window)
    return ip


@signin_router.get("/captcha", response_model=CaptchaOut)
def get_captcha(request: Request):
    _per_ip(request, 30, 60)
    return captcha.create_challenge()


@signin_router.get("/captcha/image", response_model=CaptchaImageOut)
def get_captcha_image(request: Request):
    """Visible number CAPTCHA: an image of a random number to type. Answer it with
    {"algorithm": "TEXT", "token": ..., "answer": "12345"} in the `captcha` field of /auth/login or /auth/otp/request."""
    _per_ip(request, 30, 60)
    return captcha.create_text_challenge()


@signin_router.post("/captcha/check", status_code=status.HTTP_204_NO_CONTENT)
def check_captcha(body: CaptchaCheckIn, request: Request, db: Session = Depends(get_db)):
    """Checks (and uses up) a CAPTCHA answer on its own: for sign-up, which creates its account on the device."""
    _per_ip(request, 20, 60)
    captcha.verify(db, body.captcha)
    db.commit()


@signin_router.post("/login", response_model=LoginOut)
def login(body: PasswordLogin, request: Request, db: Session = Depends(get_db)):
    return auth.login_password(db, body, _per_ip(request, 20, 60))


@signin_router.post("/otp/request", response_model=OtpRequestOut)
def otp_request(body: OtpLoginRequest, request: Request, db: Session = Depends(get_db),
                sms: SmsProvider = Depends(get_sms_provider)):
    return auth.request_otp(db, body, _per_ip(request, 10, 60), sms)


@signin_router.post("/otp/verify", response_model=LoginOut)
def otp_verify(body: OtpLoginVerify, request: Request, db: Session = Depends(get_db)):
    return auth.verify_otp(db, body, _per_ip(request, 20, 60))


@signin_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    auth.logout(db, p.user, p.session_id)


@signin_router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(body: PasswordChangeIn, request: Request, db: Session = Depends(get_db),
                    p: Principal = Depends(get_principal)):
    """The signed-in employee changes their password. Their other sessions are ended; this one continues."""
    _per_ip(request, 10, 60)
    auth.change_password(db, p.user, p.session_id, body.current_password, body.new_password)


@signin_router.get("/session", response_model=SessionOut)
def session(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    from app.models import AuthSession

    s = db.get(AuthSession, p.session_id) if p.session_id else None
    device = db.get(Device, p.device_id) if p.device_id else None
    return SessionOut(session_id=p.session_id, device_id=p.device_id, device_status=device.status if device else None,
                      method=s.method if s else None, server_time=utcnow())


@security_router.get("/network", response_model=NetworkOut)
def network(request: Request, p: Principal = Depends(get_principal), vpn: VpnProvider = Depends(get_vpn_provider)):
    ip = client_ip(request)
    risk = vpn.check(ip) if ip else None
    return NetworkOut(ip=ip, vpn=risk.vpn if risk else None, source=risk.source if risk else "no_ip",
                      detail=risk.detail if risk else None, server_time=utcnow())


@security_router.post("/events", status_code=status.HTTP_202_ACCEPTED)
def post_events(body: SecurityEventsIn, request: Request, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return {"accepted": security.ingest_device_events(db, p, body.events, client_ip(request))}


@security_router.get("/events", response_model=Page[SecurityEventOut])
def list_events(params: PageParams = Depends(), type_: str | None = Query(None, alias="type"), device_id: str | None = None,
                days: int = Query(7, ge=1, le=90), db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    divisions = p.require_any_division("audit.read")
    q = select(SecurityEvent).where(SecurityEvent.received_at >= utcnow() - timedelta(days=days))
    if not p.is_super_admin:  # events of the caller's divisions, or of users belonging to them
        from app.models import User

        q = q.where(SecurityEvent.division_id.in_(divisions)
                    | SecurityEvent.user_id.in_(select(User.id).where(User.division_id.in_(divisions))))
    if type_:
        q = q.where(SecurityEvent.type == type_)
    if device_id:
        q = q.where(SecurityEvent.device_id == device_id)
    items, total = paginate(db, q.order_by(SecurityEvent.received_at.desc()), params)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@security_router.get("/devices", response_model=Page[DeviceOut])
def list_devices(params: PageParams = Depends(), status_: DeviceStatus | None = Query(None, alias="status"),
                 db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    p.require_any_division("users.manage")
    q = select(Device)
    if status_:
        q = q.where(Device.status == status_)
    items, total = paginate(db, q.order_by(Device.last_seen_at.desc().nulls_last()), params)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@security_router.post("/devices/{device_id}/revoke", response_model=DeviceOut)
def revoke_device(device_id: str, body: DeviceRevokeIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    p.require_any_division("users.manage")
    return auth.revoke_device(db, p.user, device_id, body.reason)


@security_router.post("/devices/{device_id}/restore", response_model=DeviceOut)
def restore_device(device_id: str, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    p.require_any_division("users.manage")
    return auth.restore_device(db, p.user, device_id)


@security_router.get("/sms/status")
def sms_status(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Administrator diagnostics for OTP SMS: which gateway is configured (never the secrets) and the latest
    send attempts (destination redacted; no codes)."""
    p.require_any_division("users.manage")
    s = get_settings()
    rows = db.scalars(select(SecurityEvent).where(SecurityEvent.type.in_(("sms.otp.accepted", "sms.otp.failed")))
                      .order_by(SecurityEvent.occurred_at.desc()).limit(50)).all()
    return {
        "provider": s.sms_provider,
        "enabled": s.sms_provider != "disabled",
        "configured": {"api_key": s.sms_api_key is not None, "api_url": bool(s.sms_api_url),
                       "sender_id": bool(s.sms_sender_id), "login_template_id": bool(s.sms_login_template_id),
                       "dlt_entity_id": bool(s.sms_dlt_entity_id)},
        "delivery_reports": False,
        "note": ("accepted = the gateway took the message; delivery to the handset is not confirmed "
                 "(delivery reports are not connected)."),
        "recent": [{"at": r.occurred_at, "outcome": r.type.rsplit(".", 1)[-1], **{k: r.details.get(k) for k in
                    ("provider", "to", "message_id", "category", "error", "correlation_id", "delivery")}} for r in rows],
    }
