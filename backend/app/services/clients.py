"""Clients (offices), their module subscription and their prepaid wallet.

Two things here are worth reading before changing them:

**The wallet moves under a row lock.** Every balance change selects the client `FOR UPDATE` first, so two
journeys created in the same second cannot both see the last credit. The ledger row and the new balance
are written in the caller's transaction -- for a journey that is the same transaction that inserts the
journey, so a journey without its charge, or a charge without its journey, cannot exist.

**Charging is idempotent per journey.** `uq_credit_ledger_journey_reason` allows one `journey_charge` and
one `journey_refund` per journey, so a retried create or a double cancel cannot double-spend.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation, Forbidden, NotFound, PaymentRequired
from app.models import Client, ClientStatus, CreditLedger, Division, LedgerReason
from app.schemas.clients import (
    ClientCreate,
    ClientModulesIn,
    ClientSummary,
    ClientUpdate,
    CreditAdjustIn,
    CreditRateIn,
    CreditTopUpIn,
)
from app.security.principal import Principal
from app.services.common import audit, commit_or_conflict, diff, flush_or_conflict, paginate
from app.schemas.common import PageParams
from app.timeutil import utcnow


# ---- reads ---------------------------------------------------------------------------------------------


def get_client(db: Session, client_id: uuid.UUID, *, for_update: bool = False) -> Client:
    stmt = select(Client).where(Client.id == client_id)
    if for_update:
        # of=Client: the joined divisions must not be locked as well.
        stmt = stmt.with_for_update(of=Client)
    client = db.scalars(stmt).unique().one_or_none()
    if client is None:
        raise NotFound("Client not found")
    return client


def client_of_division(db: Session, division_id: uuid.UUID) -> Client | None:
    """The client that owns a division. None only for a division id that does not exist."""
    return db.scalar(select(Client).join(Division, Division.client_id == Client.id).where(Division.id == division_id))


def client_for_principal(db: Session, p: Principal) -> Client | None:
    """The signed-in user's own client, through their home division. A Super Admin has no single client:
    they work across all of them, so this is None and the app shows them no subscription banner."""
    if p.is_super_admin:
        return None
    return client_of_division(db, p.user.division_id)


def client_summary(db: Session, p: Principal) -> ClientSummary | None:
    """What /auth/me tells a signed-in user about their own office: which modules to show, and how the
    wallet stands. None for a Super Admin, who works across every client and is gated by none of them."""
    client = client_for_principal(db, p)
    if client is None:
        return None
    return ClientSummary(
        id=client.id,
        office_id=client.office_id,
        name=client.name,
        status=client.status,
        modules=sorted(client.modules),
        credit_balance=client.credit_balance,
        credit_per_journey=client.credit_per_journey,
        low_credit=(
            client.low_credit_threshold > 0
            and client.credit_per_journey > 0
            and client.credit_balance <= client.low_credit_threshold
        ),
        state=client.state,
        city=client.city,
        setup_completed_at=client.setup_completed_at,
    )


def list_clients(db: Session, p: Principal) -> list[Client]:
    """Super Admin sees every client; anyone else with clients.read sees only their own."""
    if p.is_super_admin:
        return list(db.scalars(select(Client).order_by(Client.name)))
    own = client_for_principal(db, p)
    if own is None:
        return []
    p.require("clients.read", p.user.division_id)
    return [own]


def readable_client(db: Session, p: Principal, client_id: uuid.UUID) -> Client:
    client = get_client(db, client_id)
    if p.is_super_admin:
        return client
    own = client_for_principal(db, p)
    if own is None or own.id != client.id:
        raise NotFound("Client not found")
    p.require("clients.read", p.user.division_id)
    return client


def list_ledger(db: Session, p: Principal, client_id: uuid.UUID, params: PageParams) -> tuple[list, int]:
    client = readable_client(db, p, client_id)
    stmt = (
        select(CreditLedger)
        .where(CreditLedger.client_id == client.id)
        .order_by(CreditLedger.created_at.desc(), CreditLedger.id.desc())
    )
    return paginate(db, stmt, params)


# ---- the super admin's writes --------------------------------------------------------------------------


def _require_super_admin(p: Principal, what: str) -> None:
    if not p.is_super_admin:
        raise Forbidden(f"Only Super Admin can {what}", code="permission_denied")


def create_client(db: Session, p: Principal, body: ClientCreate) -> Client:
    _require_super_admin(p, "create clients")
    client = Client(**body.model_dump())
    db.add(client)
    flush_or_conflict(db, "Office ID already exists", code="office_id_taken")
    audit(db, actor_id=p.id, action="client.create", entity=client, division_id=None, changes=body.model_dump())
    commit_or_conflict(db, "Office ID already exists", code="office_id_taken")
    return client


def update_client(db: Session, p: Principal, client_id: uuid.UUID, body: ClientUpdate) -> Client:
    _require_super_admin(p, "modify clients")
    client = get_client(db, client_id)
    updates = body.model_dump(exclude_unset=True)
    if "state" in updates or "city" in updates:
        from app.services.railway import list_cities, list_states

        state = updates.get("state", client.state)
        city = updates.get("city", client.city)
        if state is not None and state not in list_states(db):
            raise BusinessRuleViolation(f"{state} is not a state of the railway station list", code="unknown_state")
        if city is not None and (state is None or city not in list_cities(db, state)):
            raise BusinessRuleViolation(f"{city} is not a city of {state or 'that state'} in the railway station list",
                                        code="unknown_city")
    audit(db, actor_id=p.id, action="client.update", entity=client, division_id=None, changes=diff(client, updates))
    for key, value in updates.items():
        setattr(client, key, value)
    db.commit()
    return client


def set_modules(db: Session, p: Principal, client_id: uuid.UUID, body: ClientModulesIn) -> Client:
    """Replace the client's subscription. Takes effect on the next call every user makes, and on the phone
    at its next sync -- a module removed here stops being reachable even if the app still has its screen."""
    _require_super_admin(p, "change a client's modules")
    client = get_client(db, client_id)
    before = list(client.enabled_modules)
    client.enabled_modules = body.enabled_modules
    audit(db, actor_id=p.id, action="client.modules", entity=client, division_id=None,
          changes={"enabled_modules": {"from": before, "to": body.enabled_modules}})
    db.commit()
    return client


def set_rate(db: Session, p: Principal, client_id: uuid.UUID, body: CreditRateIn) -> Client:
    _require_super_admin(p, "change the credit rate")
    client = get_client(db, client_id, for_update=True)
    before = client.credit_per_journey
    client.credit_per_journey = body.credit_per_journey
    audit(db, actor_id=p.id, action="client.rate", entity=client, division_id=None,
          changes={"credit_per_journey": {"from": before, "to": body.credit_per_journey}, "note": body.note})
    db.commit()
    return client


def top_up(db: Session, p: Principal, client_id: uuid.UUID, body: CreditTopUpIn) -> Client:
    """The client paid; the super admin records the credits. The payment reference is kept with the row."""
    _require_super_admin(p, "add credits")
    client = get_client(db, client_id, for_update=True)
    _move(db, client, delta=body.credits, reason=LedgerReason.TOP_UP, actor_id=p.id,
          reference=body.reference, note=body.note)
    audit(db, actor_id=p.id, action="client.top_up", entity=client, division_id=None,
          changes={"credits": body.credits, "reference": body.reference, "balance_after": client.credit_balance})
    db.commit()
    return client


def adjust(db: Session, p: Principal, client_id: uuid.UUID, body: CreditAdjustIn) -> Client:
    _require_super_admin(p, "adjust a balance")
    client = get_client(db, client_id, for_update=True)
    if client.credit_balance + body.delta < 0:
        raise BusinessRuleViolation(
            f"Adjustment would take the balance below zero (balance {client.credit_balance})",
            code="insufficient_credits",
        )
    _move(db, client, delta=body.delta, reason=LedgerReason.ADJUSTMENT, actor_id=p.id, note=body.note)
    audit(db, actor_id=p.id, action="client.adjust", entity=client, division_id=None,
          changes={"delta": body.delta, "note": body.note, "balance_after": client.credit_balance})
    db.commit()
    return client


# ---- what journeys do to the wallet --------------------------------------------------------------------


def charge_journey(db: Session, division_id: uuid.UUID, journey_id: uuid.UUID) -> int:
    """Spend this client's per-journey rate. Call inside the transaction that creates the journey, before
    the commit, so the two are inseparable. Returns what was charged (0 when the client is free).

    Raises PaymentRequired (402, `credits_exhausted`) when the wallet cannot cover it: the journey is
    refused at the moment somebody is looking at the screen, which is the only honest time to say no.
    """
    client = _locked_client_of_division(db, division_id)
    if client.status != ClientStatus.ACTIVE:
        raise PaymentRequired(
            f"Client {client.office_id} is suspended; no new journeys can be created.",
            code="client_suspended",
            details={"office_id": client.office_id},
        )
    rate = client.credit_per_journey
    if rate == 0:
        return 0
    if client.credit_balance < rate:
        raise PaymentRequired(
            f"Not enough credits: this journey costs {rate} and the balance is {client.credit_balance}. "
            f"Ask the Super Admin to add credits for office {client.office_id}.",
            code="credits_exhausted",
            details={"office_id": client.office_id, "balance": client.credit_balance, "required": rate},
        )
    _move(db, client, delta=-rate, reason=LedgerReason.JOURNEY_CHARGE, actor_id=None,
          journey_id=journey_id, is_system=True, note="Journey created")
    return rate


def refund_journey(db: Session, division_id: uuid.UUID, journey_id: uuid.UUID, *, note: str) -> int:
    """Give back what a journey was charged, if it was charged and has not already been refunded. Returns
    the credits returned, 0 when there is nothing to return."""
    charge = db.scalar(
        select(CreditLedger).where(
            CreditLedger.journey_id == journey_id, CreditLedger.reason == LedgerReason.JOURNEY_CHARGE
        )
    )
    if charge is None:
        return 0
    already = db.scalar(
        select(CreditLedger.id).where(
            CreditLedger.journey_id == journey_id, CreditLedger.reason == LedgerReason.JOURNEY_REFUND
        )
    )
    if already is not None:
        return 0
    client = _locked_client_of_division(db, division_id)
    credits = -charge.delta
    _move(db, client, delta=credits, reason=LedgerReason.JOURNEY_REFUND, actor_id=None,
          journey_id=journey_id, is_system=True, note=note)
    return credits


def _locked_client_of_division(db: Session, division_id: uuid.UUID) -> Client:
    client_id = db.scalar(select(Division.client_id).where(Division.id == division_id))
    if client_id is None:
        raise NotFound("Division not found")
    return get_client(db, client_id, for_update=True)


def _move(db: Session, client: Client, *, delta: int, reason: LedgerReason, actor_id: uuid.UUID | None,
          journey_id: uuid.UUID | None = None, reference: str | None = None, note: str | None = None,
          is_system: bool = False) -> CreditLedger:
    """One balance movement and its ledger row. The caller holds the client's row lock and commits."""
    client.credit_balance += delta
    row = CreditLedger(
        created_at=utcnow(), client_id=client.id, delta=delta, balance_after=client.credit_balance,
        reason=reason, journey_id=journey_id, reference=reference, note=note, created_by_id=actor_id,
        is_system=is_system,
    )
    db.add(row)
    flush_or_conflict(db, "This journey has already been settled", code="already_settled")
    return row


__all__ = [
    "adjust",
    "client_summary",
    "charge_journey",
    "client_for_principal",
    "client_of_division",
    "create_client",
    "get_client",
    "list_clients",
    "list_ledger",
    "readable_client",
    "refund_journey",
    "set_modules",
    "set_rate",
    "top_up",
    "update_client",
]


# ---- the wallet at a glance --------------------------------------------------------------------------------


def wallet_summary(db: Session, p: Principal, client_id: uuid.UUID, *, today) -> dict:
    """What the office's home screen shows about its wallet: the balance and rate, what moved this month,
    and what is coming -- planned journeys not paid for yet, which are charged on their start day and
    cancelled if the balance cannot cover them then (services/railway.py)."""
    from datetime import datetime, time

    from app.models import Journey, JourneyStatus
    from app.timeutil import IST

    client = readable_client(db, p, client_id)
    month_start = datetime.combine(today.replace(day=1), time.min, IST)
    moved = dict(db.execute(
        select(CreditLedger.reason, func.coalesce(func.sum(CreditLedger.delta), 0))
        .where(CreditLedger.client_id == client.id, CreditLedger.created_at >= month_start)
        .group_by(CreditLedger.reason)).all())
    upcoming = db.scalar(
        select(func.count()).select_from(Journey).join(Division, Division.id == Journey.division_id)
        .where(Division.client_id == client.id, Journey.auto_created, Journey.charged.is_(False),
               Journey.status == JourneyStatus.PLANNED, Journey.journey_date >= today)) or 0
    rate = client.credit_per_journey
    recent = list(db.scalars(select(CreditLedger).where(CreditLedger.client_id == client.id)
                             .order_by(CreditLedger.created_at.desc(), CreditLedger.id.desc()).limit(5)))
    return dict(
        client_id=client.id, office_id=client.office_id, name=client.name, status=client.status,
        credit_balance=client.credit_balance, credit_per_journey=rate,
        low_credit_threshold=client.low_credit_threshold,
        low_credit=client.low_credit_threshold > 0 and rate > 0 and client.credit_balance <= client.low_credit_threshold,
        journeys_covered=(client.credit_balance // rate) if rate else None,
        added_this_month=int(moved.get(LedgerReason.TOP_UP, 0)),
        spent_this_month=int(-(moved.get(LedgerReason.JOURNEY_CHARGE, 0) + moved.get(LedgerReason.JOURNEY_REFUND, 0))),
        upcoming_journeys=upcoming,
        upcoming_cost=upcoming * rate,
        recent=recent,
    )
