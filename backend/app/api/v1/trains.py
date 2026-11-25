import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import BusinessRuleViolation, Conflict
from app.models import Train, TrainSyncRun
from app.providers.railradar import TimetableProvider, get_timetable_provider
from app.schemas.common import Page, PageParams
from app.schemas.trains import (
    BulkRefreshIn,
    BulkRefreshOut,
    CoachesReplace,
    CoachOut,
    RefreshOut,
    SyncRunOut,
    TimetableOut,
    TrainCreate,
    TrainOut,
    TrainUpdate,
)
from app.security.principal import Principal, get_principal
from app.security.ratelimit import rate_limit
from app.services import journeys as journey_svc
from app.services import timetable
from app.services import trains as svc

router = APIRouter(prefix="/trains", tags=["trains"])
coaches_router = APIRouter(prefix="/coaches", tags=["coaches"])


@router.get("", response_model=Page[TrainOut])
def list_trains(params: PageParams = Depends(), division_id: uuid.UUID | None = None, active: bool | None = None,
                q: str | None = Query(None, max_length=50), db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = svc.list_trains(db, p, params, division_id=division_id, active=active, q=q)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("", response_model=TrainOut, status_code=status.HTTP_201_CREATED)
def create_train(body: TrainCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create_train(db, p, body)


@router.post("/timetable/refresh", response_model=BulkRefreshOut, status_code=status.HTTP_202_ACCEPTED)
def refresh_all(body: BulkRefreshIn, background: BackgroundTasks, db: Session = Depends(get_db),
                p: Principal = Depends(rate_limit(3, 600)), provider: TimetableProvider = Depends(get_timetable_provider)):
    """Bulk refresh: every active train of the division (or of every division the user manages trains in)
    and their return trains, read from RailRadar one after another in the background (a few seconds per
    train; requests are spaced). Progress and failures appear in GET /trains/timetable/runs."""
    divisions = [body.division_id] if body.division_id else p.require_any_division("trains.manage")
    for d in divisions:
        p.require("trains.manage", d)
    if timetable.bulk_running():
        raise Conflict("A bulk timetable refresh is already running", code="refresh_running")
    count = len(timetable.due_trains(db, division_ids=divisions, include_fresh=not body.only_due))
    actor_id = p.id
    # End this request's transaction now (and touch no ORM object after it, which would begin another): the
    # background task opens its own session, and on SQLite this one would still hold the write lock.
    db.rollback()
    if count:
        background.add_task(timetable.run_bulk, divisions, trigger="bulk", actor_id=actor_id, provider=provider,
                            include_fresh=not body.only_due)
    return BulkRefreshOut(accepted=bool(count), trains=count,
                          message=f"Reading {count} train timetable(s) from RailRadar in the background." if count
                          else "No train is due for a refresh.")


@router.get("/timetable/runs", response_model=list[SyncRunOut])
def sync_runs(division_id: uuid.UUID | None = None, outcome: str | None = Query(None, max_length=10),
              limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """The extraction log: recent timetable reads, newest first (outcome=failed|rejected for the failure report)."""
    divisions = [division_id] if division_id else p.require_any_division("trains.read")
    for d in divisions:
        p.require("trains.read", d)
    stmt = (select(TrainSyncRun).join(Train, Train.id == TrainSyncRun.train_id).where(Train.division_id.in_(divisions))
            .order_by(TrainSyncRun.started_at.desc()).limit(limit))
    if outcome:
        stmt = stmt.where(TrainSyncRun.outcome == outcome)
    return list(db.scalars(stmt))


@router.get("/{train_id}", response_model=TrainOut)
def get_train(train_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.get_train(db, p, train_id)


@router.patch("/{train_id}", response_model=TrainOut)
def update_train(train_id: uuid.UUID, body: TrainUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.update_train(db, p, train_id, body)


@router.put("/{train_id}/coaches", response_model=TrainOut)
def replace_coaches(train_id: uuid.UUID, body: CoachesReplace, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.replace_coaches(db, p, train_id, body)


@router.get("/{train_id}/timetable", response_model=TimetableOut)
def get_timetable(train_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Both directions as read from RailRadar: this train's stops and its return train's (each from its own
    page), with the last reads of either."""
    return timetable.timetable_out(db, svc.get_train(db, p, train_id))


@router.post("/{train_id}/timetable/refresh", response_model=RefreshOut)
def refresh_one(train_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(rate_limit(10, 300)),
                provider: TimetableProvider = Depends(get_timetable_provider)):
    """Read this train's timetable and its return train's now. A failed or invalid reading keeps the
    timetable already stored and is reported in the outcome and the extraction log."""
    train = svc.get_train(db, p, train_id, "trains.manage")
    result = timetable.sync_one(db, provider, train, trigger="manual", actor_id=p.id)
    db.refresh(train)
    return {**result, "timetable": timetable.timetable_out(db, train)}


@coaches_router.get("", response_model=list[CoachOut])
def list_coaches(train_id: uuid.UUID | None = None, journey_id: uuid.UUID | None = None,
                 db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Coaches with AC/Non-AC classification for a train (master) or a journey (snapshot)."""
    if journey_id is not None:
        return journey_svc.get_journey(db, p, journey_id).coaches
    if train_id is not None:
        return svc.get_train(db, p, train_id).coaches
    raise BusinessRuleViolation("Pass train_id or journey_id")
