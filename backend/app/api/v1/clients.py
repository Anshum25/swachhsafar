"""Clients (offices), their module subscription and their prepaid wallet.

Everything that changes a subscription or moves credits is Super Admin only, checked in the service, not
only here. Reading is open to `clients.read`, and a non-super-admin only ever reads their own client.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas.clients import (
    ClientCreate,
    ClientModulesIn,
    ClientOut,
    ClientUpdate,
    CreditAdjustIn,
    CreditLedgerOut,
    CreditRateIn,
    CreditTopUpIn,
)
from app.schemas.common import Page, PageParams
from app.security.principal import Principal, get_principal
from app.services import clients as svc

router = APIRouter(prefix="/clients", tags=["clients"])


@router.get("", response_model=list[ClientOut])
def list_clients(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.list_clients(db, p)


@router.post("", response_model=ClientOut, status_code=201)
def create_client(body: ClientCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_client(db, p, body)


@router.get("/{client_id}", response_model=ClientOut)
def get_client(client_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.readable_client(db, p, client_id)


@router.patch("/{client_id}", response_model=ClientOut)
def update_client(client_id: uuid.UUID, body: ClientUpdate, db: Session = Depends(get_db),
                  p: Principal = Depends(get_principal)):
    return svc.update_client(db, p, client_id, body)


@router.put("/{client_id}/modules", response_model=ClientOut)
def set_modules(client_id: uuid.UUID, body: ClientModulesIn, db: Session = Depends(get_db),
                p: Principal = Depends(get_principal)):
    """Replace the whole subscription. A module removed here is refused on the next call any of the
    client's users make, and disappears from their phones at the next sync."""
    return svc.set_modules(db, p, client_id, body)


@router.put("/{client_id}/credit-rate", response_model=ClientOut)
def set_rate(client_id: uuid.UUID, body: CreditRateIn, db: Session = Depends(get_db),
             p: Principal = Depends(get_principal)):
    """How many credits one journey costs this client. 0 makes journeys free."""
    return svc.set_rate(db, p, client_id, body)


@router.post("/{client_id}/credits", response_model=ClientOut)
def top_up(client_id: uuid.UUID, body: CreditTopUpIn, db: Session = Depends(get_db),
           p: Principal = Depends(get_principal)):
    """The client paid; add the credits they paid for, with the payment reference."""
    return svc.top_up(db, p, client_id, body)


@router.post("/{client_id}/credits/adjust", response_model=ClientOut)
def adjust(client_id: uuid.UUID, body: CreditAdjustIn, db: Session = Depends(get_db),
           p: Principal = Depends(get_principal)):
    """A correction in either direction. Never takes a balance below zero."""
    return svc.adjust(db, p, client_id, body)


@router.get("/{client_id}/ledger", response_model=Page[CreditLedgerOut])
def ledger(client_id: uuid.UUID, params: PageParams = Depends(), db: Session = Depends(get_db),
           p: Principal = Depends(get_principal)):
    """Every movement of this wallet, newest first. Append-only: this is the explanation of the balance."""
    items, total = svc.list_ledger(db, p, client_id, params)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)
