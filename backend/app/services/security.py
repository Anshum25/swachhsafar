"""Security events and the server's checks on capture evidence (attendance, inspections).

The server cannot see the device's GPS, VPN or camera. What it can do, it does here:
  * refuse a capture whose own evidence breaks the division policy (stale or inaccurate fix, VPN or mock
    location reported, liveness not passed where required) — a modified client can lie, an honest one cannot
    slip through by accident;
  * derive risk flags from data it holds: implausible travel between a user's consecutive captures, a device
    clock far ahead of the server, the batch device differing from the signed-in session's device, records
    from app versions that sent no evidence at all ("legacy_client");
  * record everything as security events, marking device claims as such (source="device")."""

import math
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, union_all
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation
from app.models import Attendance, Inspection, SecurityEvent
from app.schemas.policy import PolicySettings
from app.schemas.security import SecurityEventIn
from app.timeutil import utcnow

CLOCK_SKEW = timedelta(minutes=5)


def record(db: Session, *, type: str, severity: str = "info", source: str = "server", user_id=None, device_id=None,
           session_id=None, division_id=None, details: dict | None = None, ip: str | None = None,
           occurred_at: datetime | None = None, event_id: uuid.UUID | None = None) -> None:
    now = utcnow()
    db.add(SecurityEvent(id=event_id or uuid.uuid4(), source=source, type=type, severity=severity, user_id=user_id,
                         device_id=device_id, session_id=session_id, division_id=division_id, details=details or {},
                         ip=ip, occurred_at=occurred_at or now, received_at=now))


def ingest_device_events(db: Session, p, events: list[SecurityEventIn], ip: str | None) -> int:
    """Device-reported events (idempotent by id). Returns how many were new."""
    new = 0
    for e in events:
        if db.get(SecurityEvent, e.id) is not None:
            continue
        division = e.division_id if e.division_id and p.can_access_division(e.division_id) else None
        record(db, type=e.type, severity=e.severity, source="device", user_id=p.id, device_id=p.device_id,
               session_id=p.session_id, division_id=division, details=e.details, ip=ip, occurred_at=e.occurred_at,
               event_id=e.id)
        new += 1
    db.commit()
    return new


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _previous_fix(db: Session, user_id: uuid.UUID, before: datetime, exclude: uuid.UUID):
    cols = lambda m: select(m.latitude, m.longitude, m.device_timestamp).where(  # noqa: E731
        m.created_by_id == user_id, m.device_timestamp < before, m.id != exclude)
    q = union_all(cols(Attendance), cols(Inspection)).subquery()
    return db.execute(select(q).order_by(q.c.device_timestamp.desc()).limit(1)).first()


def check_capture(db: Session, p, policy: PolicySettings, body, *, kind: str, liveness_required: bool = False) -> dict:
    """Validates the evidence of an attendance/inspection capture. Returns the columns to store
    (device_id, gps_timestamp, security, risk_flags); raises BusinessRuleViolation on a policy breach."""
    sec = getattr(body, "security", None)
    flags: list[str] = []
    now = utcnow()
    if sec is None:
        flags.append("legacy_client")  # an app version that sent no evidence: kept, flagged for review
    if policy.gps_enforced:
        if body.gps_accuracy_m is not None and body.gps_accuracy_m > policy.gps_max_accuracy_m and sec is not None:
            raise BusinessRuleViolation(
                f"Location accuracy {round(body.gps_accuracy_m)} m is worse than the {policy.gps_max_accuracy_m} m allowed.",
                code="gps_inaccurate", details={"accuracy_m": body.gps_accuracy_m, "limit_m": policy.gps_max_accuracy_m})
        if body.gps_accuracy_m is None:
            flags.append("gps_accuracy_missing")
        if body.gps_timestamp is None:
            flags.append("gps_time_missing")
        else:
            age = (body.device_timestamp - body.gps_timestamp).total_seconds()
            if age > policy.gps_max_age_seconds:
                raise BusinessRuleViolation(f"The location fix was {int(age)} s old; at most {policy.gps_max_age_seconds} s is allowed.",
                                            code="gps_stale", details={"age_seconds": int(age)})
            if age < -CLOCK_SKEW.total_seconds():
                flags.append("gps_time_after_capture")
    if sec is not None:
        if sec.mock_location:
            raise BusinessRuleViolation("The device reported a simulated (mock) location.", code="mock_location")
        if sec.vpn and policy.vpn_policy == "block":
            raise BusinessRuleViolation("A VPN was active on the device.", code="vpn_detected")
        if sec.vpn:
            flags.append("vpn_reported")
        if liveness_required and sec.liveness != "passed":
            raise BusinessRuleViolation("The live face check was not passed.", code="liveness_required")
        flags.extend(f"device:{w}"[:40] for w in sec.warnings)
    if body.device_timestamp > now + CLOCK_SKEW:
        flags.append("device_clock_ahead")
    prev = _previous_fix(db, p.id, body.device_timestamp, body.id)
    if prev is not None:
        hours = (body.device_timestamp - prev.device_timestamp).total_seconds() / 3600
        km = _km(prev.latitude, prev.longitude, body.latitude, body.longitude)
        if km > 2 and (hours <= 0 or km / hours > policy.gps_max_speed_kmh):
            flags.append("impossible_travel")
    if flags:
        record(db, type=f"{kind}.risk", severity="warning", user_id=p.id, device_id=p.device_id, session_id=p.session_id,
               details={"record_id": str(body.id), "flags": flags})
    return dict(device_id=p.device_id, gps_timestamp=body.gps_timestamp,
                security=sec.model_dump(mode="json") if sec is not None else None, risk_flags=flags or None)
