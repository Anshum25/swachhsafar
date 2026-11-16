import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import AwareDatetime, Mobile, ReadModel, StrictModel

DeviceId = str  # 8-64 chars of [A-Za-z0-9_-], generated and kept by the device


class DeviceIn(StrictModel):
    id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    platform: Literal["android", "web"]
    label: str | None = Field(default=None, max_length=120)


class CaptchaImageOut(StrictModel):
    algorithm: str
    token: str
    image: str
    length: int
    expires_at: datetime


class CaptchaCheckIn(StrictModel):
    captcha: dict[str, Any]


class CaptchaOut(StrictModel):
    algorithm: str
    challenge: str
    salt: str
    signature: str
    maxnumber: int
    expires_at: datetime


class PasswordLogin(StrictModel):
    username: str = Field(min_length=2, max_length=254, description="Employee ID or email")
    password: str = Field(min_length=1, max_length=256)
    captcha: dict[str, Any]
    device: DeviceIn


class OtpLoginRequest(StrictModel):
    mobile: Mobile
    captcha: dict[str, Any]
    device: DeviceIn


class OtpLoginVerify(StrictModel):
    mobile: Mobile
    code: str = Field(pattern=r"^[0-9]{6}$")
    device: DeviceIn


class OtpRequestOut(StrictModel):
    expires_in_seconds: int
    resend_after_seconds: int


class LoginOut(StrictModel):
    custom_token: str
    session_id: uuid.UUID
    device_id: str
    method: Literal["password", "otp"]


class SessionOut(StrictModel):
    session_id: uuid.UUID | None
    device_id: str | None
    device_status: str | None
    method: str | None
    backend_session_required: bool
    server_time: datetime


class NetworkOut(StrictModel):
    """Server's view of the caller's connection. `vpn` is None when no reputation source could decide:
    the absence of a positive result is not proof that no VPN is in use."""

    ip: str | None
    vpn: bool | None
    source: str
    detail: str | None = None
    server_time: datetime


class SecurityEventIn(StrictModel):
    id: uuid.UUID
    type: str = Field(min_length=3, max_length=48, pattern=r"^[a-z0-9_.]+$")
    severity: Literal["info", "warning", "critical"] = "info"
    occurred_at: AwareDatetime
    division_id: uuid.UUID | None = None
    details: dict[str, Any] = Field(default_factory=dict)

    @field_validator("details")
    @classmethod
    def _small(cls, v: dict) -> dict:
        import json

        if len(json.dumps(v, default=str)) > 4000:
            raise ValueError("details too large")
        for key in v:
            if any(word in key.lower() for word in ("descriptor", "embedding", "template", "password", "token", "otp")):
                raise ValueError(f"details must not contain {key}")  # biometric and secret material is never logged
        return v


class SecurityEventsIn(StrictModel):
    events: list[SecurityEventIn] = Field(min_length=1, max_length=100)


class DeviceOut(ReadModel):
    id: str
    platform: str
    label: str | None
    status: str
    first_user_id: uuid.UUID | None
    last_user_id: uuid.UUID | None
    last_seen_at: datetime | None
    last_ip: str | None
    revoked_at: datetime | None
    revoke_reason: str | None
    created_at: datetime


class DeviceRevokeIn(StrictModel):
    reason: str = Field(min_length=3, max_length=200)


class SecurityEventOut(ReadModel):
    id: uuid.UUID
    source: str
    type: str
    severity: str
    user_id: uuid.UUID | None
    device_id: str | None
    details: dict
    ip: str | None
    occurred_at: datetime
    received_at: datetime


class CaptureSecurity(StrictModel):
    """What the app reports about the conditions of a capture. Client claims: stored as evidence and used to
    refuse captures the app itself should have refused, never as proof that the conditions were met."""

    app_version: str | None = Field(default=None, max_length=32)
    platform: Literal["android", "web"] | None = None
    location_source: Literal["gps", "network", "fused", "browser", "unknown"] | None = None
    mock_location: bool | None = None
    vpn: bool | None = None
    vpn_check: Literal["native", "server", "not_configured", "unavailable"] | None = None
    liveness: Literal["passed", "failed", "not_required", "unavailable"] | None = None
    face_model_version: str | None = Field(default=None, max_length=40)
    policy_result: Literal["allowed", "warned"] | None = None
    warnings: list[str] = Field(default_factory=list, max_length=10)
