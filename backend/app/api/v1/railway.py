"""The railway network (stations, their trains) and a client's setup from it. Rules: app/services/railway.py."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import Forbidden
from app.models import Client, RoleId
from app.providers.railradar import TimetableProvider, get_timetable_provider
from app.schemas.railway import RailwayStationOut, SetupIn, SetupOut, SetupResult, StationTrainsOut, TrainCoachOut
from app.security.principal import Principal, get_principal
from app.services import railway as svc
from app.services.clients import client_of_division
from app.services.common import get_or_404
from app.timeutil import today_ist

router = APIRouter(prefix="/railway", tags=["railway"])
setup_router = APIRouter(prefix="/clients", tags=["clients"])


@router.get("/states", response_model=list[str])
def states(db: Session = Depends(get_db), _: Principal = Depends(get_principal)):
    return svc.list_states(db)


@router.get("/cities", response_model=list[str])
def cities(state: str = Query(min_length=1, max_length=60), db: Session = Depends(get_db),
           _: Principal = Depends(get_principal)):
    return svc.list_cities(db, state)


@router.get("/stations", response_model=list[RailwayStationOut])
def stations(state: str = Query(min_length=1, max_length=60), city: str = Query(min_length=1, max_length=100),
             db: Session = Depends(get_db), _: Principal = Depends(get_principal)):
    return svc.stations_in(db, state, city)


@router.get("/stations/{code}/trains", response_model=StationTrainsOut)
def station_trains(code: str, refresh: bool = False, db: Session = Depends(get_db),
                   p: Principal = Depends(get_principal), provider: TimetableProvider = Depends(get_timetable_provider)):
    """Trains that start at the station. Each lookup may reach RailRadar, so it is for the people who set
    offices up: the Super Admin, or an office's Admin for a station of their own office's city."""
    if not p.is_super_admin:
        client = client_of_division(db, p.user.division_id)
        own_city = {s.code for s in svc.stations_in(db, client.state, client.city)} \
            if client is not None and client.state and client.city else set()
        if p.role != RoleId.ADMIN or code.strip().upper() not in own_city:
            raise Forbidden("Only the Super Admin or the office's Admin can look up a station of the office's city",
                            code="permission_denied")
    # Only the Super Admin may force a fresh read past the cache: it is a request to RailRadar.
    return svc.station_trains(db, provider, code, refresh=refresh and p.is_super_admin)


@router.get("/trains/{train_no}/coaches", response_model=list[TrainCoachOut])
def train_coaches(train_no: str, p: Principal = Depends(get_principal),
                  provider: TimetableProvider = Depends(get_timetable_provider)):
    """A train's passenger coaches from its RailRadar train-status page, for the setup wizard. The people who
    set offices up only (each lookup may reach RailRadar): the Super Admin, or an office's Admin."""
    if not (p.is_super_admin or p.role == RoleId.ADMIN):
        raise Forbidden("Only the Super Admin or an office's Admin can look up a train's coaches", code="permission_denied")
    return svc.train_coaches(provider, train_no)


@setup_router.get("/{client_id}/setup", response_model=SetupOut)
def get_setup(client_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    out = svc.get_setup(db, p, client_id)
    return {**out, **svc.planned_counts(db, client_id, today_ist())}


@setup_router.put("/{client_id}/setup", response_model=SetupResult)
def put_setup(client_id: uuid.UUID, body: SetupIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal),
              provider: TimetableProvider = Depends(get_timetable_provider)):
    """The office's stations and the trains planned from each, replaced as a whole. Journeys for the next
    days are planned straight away."""
    get_or_404(db, Client, client_id, "Client")
    return svc.save_setup(db, p, client_id, body, provider, today=today_ist())
