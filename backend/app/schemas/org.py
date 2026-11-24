import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.models import DivisionKind, PermissionEffect, UserStatus
from app.schemas.clients import ClientSummary
from app.schemas.common import Mobile, ReadModel, StrictModel


class DivisionCreate(StrictModel):
    code: str = Field(min_length=2, max_length=16, pattern=r"^[A-Z0-9_]+$")
    name: str = Field(min_length=2, max_length=100)
    # The client (office) whose wallet this division's journeys spend and whose modules its users see.
    client_id: uuid.UUID
    kind: DivisionKind = DivisionKind.STATION


class DivisionStationsCreate(StrictModel):
    """Railway stations, from any state or city, made divisions of one client (office) in one go."""
    client_id: uuid.UUID
    station_codes: list[str] = Field(min_length=1, max_length=50)
    kind: DivisionKind = DivisionKind.STATION

    @field_validator("station_codes")
    @classmethod
    def _codes(cls, v: list[str]) -> list[str]:
        codes = [c.strip().upper() for c in v]
        if any(not c or len(c) > 8 for c in codes):
            raise ValueError("a station code is 1 to 8 characters")
        if len(codes) != len(set(codes)):
            raise ValueError("a station is listed twice")
        return codes


class DivisionUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    is_active: bool | None = None
    kind: DivisionKind | None = None


class DivisionOut(ReadModel):
    id: uuid.UUID
    code: str
    name: str
    is_active: bool
    client_id: uuid.UUID
    kind: DivisionKind
    # The railway station this division stands for, when it was made from one.
    station_code: str | None = None
    updated_at: datetime


class DivisionStationsResult(BaseModel):
    created: list[DivisionOut]
    # Stations that already were divisions of the office: left as they were.
    existing: list[str]


class RoleOut(ReadModel):
    id: int
    code: str
    name: str
    level: int


class PermissionOut(ReadModel):
    code: str
    module: str
    description: str


class GrantIn(StrictModel):
    role_id: int = Field(ge=1, le=6)
    permission_code: str
    # At most one of the two: neither = the global default, client_id = the whole office, division_id = one
    # division (services/org.py refuses both).
    client_id: uuid.UUID | None = None
    # With client_id: every headquarters or every station of that office.
    division_kind: DivisionKind | None = None
    division_id: uuid.UUID | None = None
    effect: PermissionEffect = PermissionEffect.ALLOW


class GrantOut(ReadModel):
    id: uuid.UUID
    role_id: int
    permission_code: str
    client_id: uuid.UUID | None
    division_kind: DivisionKind | None
    division_id: uuid.UUID | None
    effect: PermissionEffect


class UserCreate(StrictModel):
    emp_id: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=2, max_length=100)
    name_hindi: str | None = Field(default=None, max_length=100)
    email: EmailStr | None = None
    mobile: Mobile | None = None
    gender: Literal["M", "F", "O"] | None = None
    designation: str | None = Field(default=None, max_length=100)
    lang: Literal["en", "hi"] = "en"
    role_id: int = Field(ge=1, le=6)
    division_id: uuid.UUID
    # A password sign-in is created with the employee when an e-mail or a password is given, so a new user can
    # sign in straight away (with Employee ID or e-mail). With an e-mail but no password, the server generates
    # one, returned once as `temp_password`.
    password: str | None = Field(default=None, min_length=8, max_length=128)


class UserUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    name_hindi: str | None = Field(default=None, max_length=100)
    email: EmailStr | None = None
    mobile: Mobile | None = None
    gender: Literal["M", "F", "O"] | None = None
    designation: str | None = Field(default=None, max_length=100)
    lang: Literal["en", "hi"] | None = None
    role_id: int | None = Field(default=None, ge=1, le=6)
    division_id: uuid.UUID | None = None


class UserStatusIn(StrictModel):
    status: Literal[UserStatus.ACTIVE, UserStatus.INACTIVE, UserStatus.DELETED]


class UserOut(ReadModel):
    id: uuid.UUID
    emp_id: str
    name: str
    name_hindi: str | None
    email: str | None
    mobile: str | None
    gender: str | None
    designation: str | None
    lang: str
    role_id: int
    division_id: uuid.UUID
    status: UserStatus
    password_set: bool  # has a password sign-in (user_credentials)
    face_enrolled: bool  # has a registered face (face_enrollments)
    fingerprint_enrolled: bool  # has registered fingerprints (fingerprint_enrollments)
    updated_at: datetime


class SignInIn(StrictModel):
    """Creating the password sign-in of an employee who has none."""

    password: str | None = Field(default=None, min_length=8, max_length=128)


class PasswordResetIn(StrictModel):
    """An administrator sets a new password for another employee. Never echoed back, never logged."""

    new_password: str = Field(min_length=8, max_length=128)


class PasswordResetOut(StrictModel):
    sessions_ended: int


class UserRef(StrictModel):
    id: uuid.UUID
    name: str
    emp_id: str


class UserAccountOut(StrictModel):
    """Account facts for the administrator's user profile. Holds no password hash and no biometric template."""

    user_id: uuid.UUID
    created_at: datetime
    updated_at: datetime
    created_by: UserRef | None
    division_code: str
    division_name: str
    role_name: str
    password_set: bool
    password_changed_at: datetime | None
    password_set_by: str | None  # "admin" | "user" | "cli" | "firebase"
    last_sign_in_at: datetime | None
    active_sessions: int
    # The role's effective permissions in the user's home division (global grants with division overrides).
    permissions: list[str]


class UserWithSignIn(UserOut):
    """A user plus what just happened to their sign-in.

    `temp_password` is shown once and never stored in clear: it is present only when the server generated one,
    never when the administrator chose the password.

    `signin` is "created" or null (no e-mail and no password given, so no sign-in yet)."""

    temp_password: str | None = None
    signin: Literal["created"] | None = None


class MeOut(StrictModel):
    user: UserOut
    divisions: dict[uuid.UUID, list[str]]
    # The user's own client (office): which modules it has subscribed to, and how its wallet stands. None
    # for a Super Admin, who works across every client. The app shows only the modules listed here.
    client: ClientSummary | None = None
    offline_lease: dict | None = None


class KycIn(StrictModel):
    father_name: str | None = Field(default=None, max_length=100)
    birth_date: date | None = None
    first_engaged_on: date | None = None
    rail_reg_id: str | None = Field(default=None, max_length=32)
    aadhaar_number: str | None = Field(default=None, pattern=r"^[0-9]{12}$", description="Only the last 4 digits are stored")
    education: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=1000)
    documents: dict[str, uuid.UUID] = Field(default_factory=dict, description="document type -> media id")


class KycOut(ReadModel):
    user_id: uuid.UUID
    father_name: str | None
    birth_date: date | None
    first_engaged_on: date | None
    rail_reg_id: str | None
    aadhaar_last4: str | None
    education: str | None
    address: str | None
    documents: dict


class ChargeMapCreate(StrictModel):
    user_id: uuid.UUID
    division_id: uuid.UUID
    from_date: date
    to_date: date

    @model_validator(mode="after")
    def _range(self):
        if self.from_date > self.to_date:
            raise ValueError("from_date must not be after to_date")
        return self


class ChargeMapOut(ReadModel):
    id: uuid.UUID
    user_id: uuid.UUID
    division_id: uuid.UUID
    from_date: date
    to_date: date
    is_active: bool


class AuditOut(ReadModel):
    id: uuid.UUID
    created_at: datetime
    actor_id: uuid.UUID | None
    division_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: str
    changes: dict
