"""Cryptographically signed offline authorization lease.

Issued during online session validation (/auth/me or /auth/lease). Allows the device to operate offline
for up to policy.offline_session_hours (strictly <= 24 hours). If expired, tampering detected, or signature invalid,
restricted offline captures are blocked.
"""

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta
from typing import Any

from pydantic import Field

from app.config import get_settings
from app.errors import BusinessRuleViolation, Unauthenticated
from app.models import User
from app.schemas.common import StrictModel
from app.timeutil import utcnow

MAX_OFFLINE_LEASE_HOURS = 24
PERMITTED_OFFLINE_OPERATIONS = [
    "attendance.record",
    "inspection.record",
    "feedback.passenger.start",
    "feedback.railway.create",
    "complaint.create",
    "inventory.record",
    "security.event",
]


class OfflineLease(StrictModel):
    lease_id: str
    emp_id: str
    user_id: str
    device_id: str
    session_id: str | None
    issued_at: str
    expires_at: str
    authorization_version: int = 1
    policy_version: int = 1
    permitted_operations: list[str] = Field(default_factory=lambda: list(PERMITTED_OFFLINE_OPERATIONS))
    signature: str


def _lease_secret() -> bytes:
    pepper = get_settings().otp_pepper.get_secret_value().encode()
    return hmac.new(pepper, b"swachh-offline-lease-v1", hashlib.sha256).digest()


def _canonical_string(data: dict[str, Any]) -> str:
    # Deterministic canonical payload string excluding the signature
    fields = [
        str(data.get("lease_id", "")),
        str(data.get("emp_id", "")),
        str(data.get("user_id", "")),
        str(data.get("device_id", "")),
        str(data.get("session_id", "") or ""),
        str(data.get("issued_at", "")),
        str(data.get("expires_at", "")),
        str(data.get("authorization_version", "1")),
        str(data.get("policy_version", "1")),
        ",".join(sorted(data.get("permitted_operations", []))),
    ]
    return "|".join(fields)


def sign_lease_data(data: dict[str, Any]) -> str:
    payload = _canonical_string(data).encode("utf-8")
    return hmac.new(_lease_secret(), payload, hashlib.sha256).hexdigest()


def issue_offline_lease(
    user: User,
    device_id: str | None,
    session_id: uuid.UUID | None,
    offline_hours: int = 24,
) -> dict[str, Any]:
    """Issues a signed offline authorization lease strictly capped at 24 hours."""
    now = utcnow()
    hours = min(max(1, offline_hours), MAX_OFFLINE_LEASE_HOURS)
    expires = now + timedelta(hours=hours)

    lease_data = {
        "lease_id": str(uuid.uuid4()),
        "emp_id": user.emp_id or "",
        "user_id": str(user.id),
        "device_id": device_id or "unspecified",
        "session_id": str(session_id) if session_id else None,
        "issued_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "authorization_version": 1,
        "policy_version": 1,
        "permitted_operations": list(PERMITTED_OFFLINE_OPERATIONS),
    }
    lease_data["signature"] = sign_lease_data(lease_data)
    return lease_data


def verify_offline_lease(lease_dict: dict[str, Any]) -> bool:
    sig = lease_dict.get("signature")
    if not sig:
        return False
    expected = sign_lease_data(lease_dict)
    if not hmac.compare_digest(sig, expected):
        return False

    try:
        raw_exp = lease_dict["expires_at"].replace("Z", "+00:00")
        expires = datetime.fromisoformat(raw_exp)
        if expires.tzinfo is None:
            from datetime import timezone
            expires = expires.replace(tzinfo=timezone.utc)
        if utcnow() > expires:
            return False
    except (KeyError, ValueError):
        return False

    return True
