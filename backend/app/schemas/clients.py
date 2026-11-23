import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.models.clients import GATEABLE_MODULES, ClientStatus, LedgerReason
from app.schemas.common import Mobile, ReadModel, StrictModel

ModuleKey = Literal["attendance", "inspections", "feedback", "complaints", "inventory", "reports"]


def _unique_modules(v: list[str]) -> list[str]:
    unknown = [m for m in v if m not in GATEABLE_MODULES]
    if unknown:
        raise ValueError(f"unknown modules: {', '.join(sorted(unknown))}")
    # Stored in catalog order, so two equivalent subscriptions are the same JSON and diff cleanly.
    return [m for m in GATEABLE_MODULES if m in set(v)]


class ClientCreate(StrictModel):
    office_id: str = Field(min_length=2, max_length=32, pattern=r"^[A-Z0-9][A-Z0-9_-]*$")
    name: str = Field(min_length=2, max_length=150)
    contact_name: str | None = Field(default=None, max_length=100)
    contact_mobile: Mobile | None = None
    contact_email: str | None = Field(default=None, max_length=254)
    gstin: str | None = Field(default=None, min_length=15, max_length=15, pattern=r"^[0-9A-Z]{15}$")
    address: str | None = Field(default=None, max_length=1000)
    enabled_modules: list[ModuleKey] = Field(default_factory=list)
    # The wallet starts empty: credits only ever arrive through a recorded top-up, so the ledger always
    # explains the balance.
    credit_per_journey: int = Field(default=1, ge=0, le=1000)
    low_credit_threshold: int = Field(default=10, ge=0, le=100000)

    @field_validator("enabled_modules")
    @classmethod
    def _modules(cls, v: list[str]) -> list[str]:
        return _unique_modules(v)


class ClientUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=150)
    contact_name: str | None = Field(default=None, max_length=100)
    contact_mobile: Mobile | None = None
    contact_email: str | None = Field(default=None, max_length=254)
    gstin: str | None = Field(default=None, min_length=15, max_length=15, pattern=r"^[0-9A-Z]{15}$")
    address: str | None = Field(default=None, max_length=1000)
    status: ClientStatus | None = None
    low_credit_threshold: int | None = Field(default=None, ge=0, le=100000)
    # Where the office works: a state and city of the railway station list (services/clients.update_client
    # checks them). Its Admin then picks this city's stations and trains (services/railway.py).
    state: str | None = Field(default=None, min_length=1, max_length=60)
    city: str | None = Field(default=None, min_length=1, max_length=100)


class ClientModulesIn(StrictModel):
    """The whole subscription, replaced as a set -- there is no add/remove, so what is sent is what the
    client has. An empty list leaves only the always-on platform: users, master data, journeys, media."""

    enabled_modules: list[ModuleKey]

    @field_validator("enabled_modules")
    @classmethod
    def _modules(cls, v: list[str]) -> list[str]:
        return _unique_modules(v)


class CreditRateIn(StrictModel):
    """What one journey costs this client, from now on. Journeys already charged are not re-priced."""

    credit_per_journey: int = Field(ge=0, le=1000)
    note: str | None = Field(default=None, max_length=500)


class CreditTopUpIn(StrictModel):
    credits: int = Field(gt=0, le=1_000_000, description="Credits to add; the client has paid for these")
    reference: str | None = Field(default=None, max_length=100, description="Payment reference the office recorded")
    note: str | None = Field(default=None, max_length=500)


class CreditAdjustIn(StrictModel):
    """A correction, in either direction, with a reason. Cannot take a balance below zero."""

    delta: int = Field(ge=-1_000_000, le=1_000_000)
    note: str = Field(min_length=3, max_length=500)

    @field_validator("delta")
    @classmethod
    def _non_zero(cls, v: int) -> int:
        if v == 0:
            raise ValueError("delta must not be zero")
        return v


class ClientOut(ReadModel):
    id: uuid.UUID
    office_id: str
    name: str
    contact_name: str | None
    contact_mobile: str | None
    contact_email: str | None
    gstin: str | None
    address: str | None
    status: ClientStatus
    enabled_modules: list[str]
    credit_balance: int
    credit_per_journey: int
    low_credit_threshold: int
    state: str | None = None
    city: str | None = None
    setup_completed_at: datetime | None = None
    updated_at: datetime


class ClientSummary(ReadModel):
    """What a signed-in user is told about their own client: the modules to show, and the wallet state so
    an administrator can see a top-up coming. Not the contact or billing details."""

    id: uuid.UUID
    office_id: str
    name: str
    status: ClientStatus
    # Everything this client may use, subscription plus always-on, so the device needs no second list.
    modules: list[str]
    credit_balance: int
    credit_per_journey: int
    low_credit: bool
    # Where the office works and whether its Admin has picked its stations and trains yet: the app asks
    # them to, once the Super Admin has set the state and city.
    state: str | None = None
    city: str | None = None
    setup_completed_at: datetime | None = None


class CreditLedgerOut(ReadModel):
    id: uuid.UUID
    created_at: datetime
    delta: int
    balance_after: int
    reason: LedgerReason
    journey_id: uuid.UUID | None
    reference: str | None
    note: str | None
    created_by_id: uuid.UUID | None
    is_system: bool


__all__ = [
    "ClientCreate",
    "ClientModulesIn",
    "ClientOut",
    "ClientSummary",
    "ClientUpdate",
    "CreditAdjustIn",
    "CreditLedgerOut",
    "CreditRateIn",
    "CreditTopUpIn",
    "ModuleKey",
]
