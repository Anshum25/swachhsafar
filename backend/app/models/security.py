"""Sign-in, devices and security events.

Sessions are created only by the backend sign-in endpoints (password + CAPTCHA, or mobile OTP); the Firebase
custom token they return carries the session id (`sid`) and device id (`did`) as claims, so every API call can
be tied to a session that an administrator can revoke. OTP codes and CAPTCHA signatures are stored hashed."""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, TZDateTime, str_enum
from app.models.org import JSONType


class DeviceStatus(StrEnum):
    ACTIVE = "active"
    REVOKED = "revoked"


class Device(Timestamps, Base):
    """A phone or browser installation. Devices are shared between staff, so a device is not owned by a user;
    it is registered at its first successful sign-in and can be revoked by an administrator."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # generated on the device, kept in its storage
    platform: Mapped[str] = mapped_column(String(16), nullable=False)  # "android" | "web"
    label: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[DeviceStatus] = mapped_column(str_enum(DeviceStatus, 10), nullable=False, default=DeviceStatus.ACTIVE)
    first_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    last_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    last_seen_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    last_ip: Mapped[str | None] = mapped_column(String(45))
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    revoked_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    revoke_reason: Mapped[str | None] = mapped_column(String(200))


class AuthSession(Timestamps, Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (Index("ix_auth_sessions_user_active", "user_id", "revoked_at"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), nullable=False, index=True)
    method: Mapped[str] = mapped_column(String(16), nullable=False)  # "password" | "otp"
    firebase_uid: Mapped[str] = mapped_column(String(128), nullable=False)
    ip: Mapped[str | None] = mapped_column(String(45))
    last_seen_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    revoke_reason: Mapped[str | None] = mapped_column(String(40))


class CaptchaUse(Base):
    """A solved CAPTCHA challenge, kept until it expires so the same solution cannot be replayed."""

    __tablename__ = "captcha_uses"

    signature_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False, index=True)


class LoginOtp(Timestamps, Base):
    """Sign-in OTP for a registered mobile. Only an HMAC of the code is stored; consumed codes stay for audit."""

    __tablename__ = "login_otps"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    mobile: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    send_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    last_sent_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    device_id: Mapped[str | None] = mapped_column(String(64))


class LoginAttempt(Base):
    """Every sign-in attempt (login audit and brute-force lock-out). `subject` is the employee ID / email /
    mobile as typed, lower-cased; `user_id` is set only when it matched an account."""

    __tablename__ = "login_attempts"
    __table_args__ = (Index("ix_login_attempts_subject_time", "subject", "created_at"),
                      Index("ix_login_attempts_ip_time", "ip", "created_at"))

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    method: Mapped[str] = mapped_column(String(16), nullable=False)  # "password" | "otp_request" | "otp_verify"
    subject: Mapped[str] = mapped_column(String(254), nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(String(45))
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reason: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)


class SecurityEvent(Base):
    """A security observation. `source` says who vouches for it: "server" (checked here) or "device"
    (reported by the app: GPS, VPN, mock location, liveness results are client claims, not proof)."""

    __tablename__ = "security_events"
    __table_args__ = (Index("ix_security_events_user_time", "user_id", "occurred_at"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)  # device-generated for device events (idempotent)
    source: Mapped[str] = mapped_column(String(8), nullable=False)
    type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(8), nullable=False)  # "info" | "warning" | "critical"
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[str | None] = mapped_column(String(64), index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column()
    division_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("divisions.id"))
    details: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    ip: Mapped[str | None] = mapped_column(String(45))
    occurred_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    received_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
