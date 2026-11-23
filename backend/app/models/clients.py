"""Clients (offices) and their prepaid credit wallet.

A client is the organisation that pays for the system. Each has its own `office_id`, its own set of
divisions, its own module subscription and its own wallet. Divisions already scope every operational
record, so the client sits one level above them: a user's client is the client of their division, and
nothing operational needs a second scope column.

The wallet is prepaid. The super admin adds credits when the client pays; creating a journey spends
`credit_per_journey`. `credit_balance` on the client is the running total, and `credit_ledger` is the
append-only record of how it got there -- the balance is derivable from the ledger, and a test asserts
the two agree.
"""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, TZDateTime, UUIDPk, str_enum

JSONType = JSON().with_variant(JSONB(), "postgresql")


class ClientStatus(StrEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"


class LedgerReason(StrEnum):
    """Why the balance moved. `top_up` and `adjustment` are the super admin's; the rest follow journeys."""

    TOP_UP = "top_up"
    JOURNEY_CHARGE = "journey_charge"
    JOURNEY_REFUND = "journey_refund"
    ADJUSTMENT = "adjustment"


# The modules a client may or may not subscribe to. Everything else -- sign-in, users, master data, media,
# the dashboard, and the journey spine every operational record hangs off -- is the platform itself and is
# never switched off, because a client with "only inspection" still records inspections against journeys.
GATEABLE_MODULES: tuple[str, ...] = (
    "attendance",
    "inspections",
    "feedback",
    "complaints",
    "inventory",
    "reports",
)

ALWAYS_ON_MODULES: frozenset[str] = frozenset({"admin", "users", "masters", "media", "journeys"})


class Client(UUIDPk, Timestamps, Base):
    __tablename__ = "clients"
    __table_args__ = (
        CheckConstraint("credit_balance >= 0", name="credit_balance_non_negative"),
        CheckConstraint("credit_per_journey >= 0", name="credit_rate_non_negative"),
    )

    # The client's office identifier, as the client knows it. Unique, and what the super admin searches by.
    office_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(100))
    contact_mobile: Mapped[str | None] = mapped_column(String(10))
    contact_email: Mapped[str | None] = mapped_column(String(254))
    gstin: Mapped[str | None] = mapped_column(String(15))
    address: Mapped[str | None] = mapped_column(Text)
    status: Mapped[ClientStatus] = mapped_column(
        str_enum(ClientStatus, 10), nullable=False, default=ClientStatus.ACTIVE, index=True
    )

    # Module subscription: the keys of GATEABLE_MODULES this client has bought. Enforced server-side on
    # every call (app/security/principal.py) and mirrored to the phone so a disabled module never appears.
    enabled_modules: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)

    # ---- prepaid wallet ----
    credit_balance: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # What one journey costs this client. The super admin sets it per client; 0 means journeys are free.
    credit_per_journey: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # Below this, the app shows the client's administrators a top-up warning. 0 turns the warning off.
    low_credit_threshold: Mapped[int] = mapped_column(Integer, nullable=False, default=10)

    # ---- where the office works (migration 0017) ----
    # Set by the Super Admin; the office's Admin then picks this city's stations and their trains.
    state: Mapped[str | None] = mapped_column(String(60))
    city: Mapped[str | None] = mapped_column(String(100))
    setup_completed_at: Mapped[datetime | None] = mapped_column(TZDateTime())

    divisions: Mapped[list["Division"]] = relationship(  # noqa: F821
        back_populates="client", lazy="select", viewonly=True
    )

    @property
    def modules(self) -> frozenset[str]:
        """Every module this client may use, subscription plus the always-on platform."""
        return ALWAYS_ON_MODULES | {m for m in self.enabled_modules if m in GATEABLE_MODULES}

    def allows_module(self, module: str) -> bool:
        return module in self.modules

    @property
    def is_active(self) -> bool:
        return self.status == ClientStatus.ACTIVE


class CreditLedger(UUIDPk, Base):
    """Append-only. One row per movement; `balance_after` is what the wallet held once it was applied."""

    __tablename__ = "credit_ledger"
    __table_args__ = (
        # A journey is charged at most once and refunded at most once, whatever the caller retries. Top-ups
        # and adjustments carry no journey_id, and NULLs do not collide in a unique index on either engine.
        Index("uq_credit_ledger_journey_reason", "journey_id", "reason", unique=True),
        Index("ix_credit_ledger_client_created", "client_id", "created_at"),
        CheckConstraint("delta <> 0", name="delta_non_zero"),
    )

    created_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False, index=True)
    client_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("clients.id"), nullable=False)
    # Positive adds credits, negative spends them.
    delta: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[LedgerReason] = mapped_column(str_enum(LedgerReason, 20), nullable=False)
    # Set for journey_charge and journey_refund. Not a foreign key: the ledger outlives a deleted journey.
    journey_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    # The payment the client made, for top-ups: reference number, date, whatever the office records.
    reference: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


__all__ = [
    "ALWAYS_ON_MODULES",
    "GATEABLE_MODULES",
    "Client",
    "ClientStatus",
    "CreditLedger",
    "LedgerReason",
]
