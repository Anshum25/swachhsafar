import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.errors import BusinessRuleViolation, NotFound
from app.models import (Complaint, Division, Inspection, InventoryTransaction, Journey, JourneyCoach, JourneyStatus,
                        PassengerFeedback, RailwayFeedback, Train, TrainCoach)
from app.services.journeys import derive_dates
from app.timeutil import today_ist
from app.schemas.common import PageParams
from app.schemas.trains import CoachesReplace, CoachIn, TrainCreate, TrainUpdate
from app.security.principal import Principal
from app.services import feedback_plan
from app.services.common import audit, commit_or_conflict, diff, flush_or_conflict, paginate


def _coach_rows(coaches: list[CoachIn]) -> list[TrainCoach]:
    return [TrainCoach(code=c.code, classification=c.classification, position=i) for i, c in enumerate(coaches, 1)]


def get_train(db: Session, p: Principal, train_id: uuid.UUID, permission: str = "trains.read") -> Train:
    train = db.get(Train, train_id)
    if train is None or not p.can_access_division(train.division_id):
        raise NotFound("Train not found")
    p.require(permission, train.division_id)
    return train


def create_train(db: Session, p: Principal, body: TrainCreate) -> Train:
    p.require("trains.manage", body.division_id)
    division = db.get(Division, body.division_id)
    if division is None or not division.is_active:
        raise BusinessRuleViolation("Division is not active")
    train = Train(**body.model_dump(exclude={"coaches"}), coaches=_coach_rows(body.coaches))
    _check_feedback_config(train)
    db.add(train)
    flush_or_conflict(db, "Train number already exists in this division")
    audit(db, actor_id=p.id, action="train.create", entity=train, division_id=train.division_id, changes=body.model_dump(mode="json"))
    commit_or_conflict(db, "Train number already exists in this division")
    return train


def update_train(db: Session, p: Principal, train_id: uuid.UUID, body: TrainUpdate) -> Train:
    train = get_train(db, p, train_id, "trains.manage")
    updates = body.model_dump(exclude_unset=True)
    before = updates.get("before_inspection_enabled", train.before_inspection_enabled)
    after = updates.get("after_inspection_enabled", train.after_inspection_enabled)
    if not (before or after):
        raise BusinessRuleViolation("At least one inspection phase must be enabled")
    audit(db, actor_id=p.id, action="train.update", entity=train, division_id=train.division_id, changes=diff(train, updates))
    old_times = {k: getattr(train, k) for k in JOURNEY_TIMES}
    for k, v in updates.items():
        setattr(train, k, v)
    _check_feedback_config(train)
    _sync_journeys(db, p, train, updates, old_times)
    if (FEEDBACK_CONFIG | set(JOURNEY_LENGTH) | {"is_active"}) & updates.keys():
        db.flush()
        # Journeys not ended take the new targets on the days still ahead; days begun keep theirs, and no
        # feedback record is touched (services/feedback_plan).
        n = feedback_plan.refresh_for_trains(db, [train.id])
        if n:
            audit(db, actor_id=p.id, action="train.feedback_targets.sync", entity=train, division_id=train.division_id,
                  changes={"journeys_updated": n})
    db.commit()
    return train


# Train Master settings that shape the passenger feedback targets of its journeys.
FEEDBACK_CONFIG = {"feedback_enabled", "feedback_daily_target", "feedback_coach_daily_target", "feedback_min_daily",
                   "feedback_from_day", "feedback_to_day", "feedback_days", "feedback_targets_active"}


def _check_feedback_config(train: Train) -> None:
    """The rules the database also checks, answered as a clear 422 instead of a constraint error."""
    if train.feedback_min_daily is not None and train.feedback_daily_target is not None \
            and train.feedback_min_daily > train.feedback_daily_target:
        raise BusinessRuleViolation("The daily minimum cannot be above the daily feedback target",
                                    code="feedback_min_above_target")
    if train.feedback_to_day is not None and train.feedback_to_day < (train.feedback_from_day or 1):
        raise BusinessRuleViolation("Feedback collection cannot end before it starts", code="feedback_window_order")


# Train fields each journey snapshots that only shape its inspections (not its dates).
JOURNEY_SETTINGS = ("inspection_rounds_per_day", "before_inspection_enabled", "after_inspection_enabled", "daywise")
# Train fields that also set a journey's dates (services/journeys.derive_dates).
JOURNEY_LENGTH = ("duration_days", "operational_days")
# Train times a journey copies unless it was given its own (services/journeys.create_journey).
JOURNEY_TIMES = ("start_time", "end_time", "return_start_time", "return_end_time")
RETURN_TIMES = ("return_start_time", "return_end_time")


def _sync_journeys(db: Session, p: Principal, train: Train, updates: dict, old_times: dict) -> None:
    """Journeys nothing has been recorded on yet (_untouched_journeys) follow the train's edited settings, as
    they do its coaches.

    Duration and operational days follow only on a train dated by duration_days (no schedule read from the
    railway: railway.journey_dates ignores them otherwise). A journey whose linked date and end date are the
    ones duration_days gives is re-dated; one whose dates somebody set by hand, or that has a linked train
    or outbound end date, keeps them. A journey the new length would end before today is left as it is,
    so an edit never drops a running journey into history.

    A time follows only where the journey still has the train's previous time, so times somebody gave the
    journey itself are kept; return times also stay on a journey with a linked train (they are that train's)."""
    settings = {k: v for k, v in updates.items() if k in JOURNEY_SETTINGS}
    length = {k: v for k, v in updates.items() if k in JOURNEY_LENGTH} if train.arrival_days is None else {}
    times = {k: v for k, v in updates.items() if k in JOURNEY_TIMES and v != old_times[k]}
    if not (settings or length or times):
        return
    today = today_ist()
    updated, redated, kept = [], [], []
    for j in _untouched_journeys(db, train.id):
        changes = dict(settings)
        changes.update({k: v for k, v in times.items()
                        if getattr(j, k) == old_times[k] and not (k in RETURN_TIMES and j.linked_train_id is not None)})
        if length:
            duration = length.get("duration_days", j.duration_days)
            derived = (j.linked_train_id is None and j.outbound_end_date is None
                       and (j.linked_journey_date, j.end_date) == derive_dates(j.journey_date, j.duration_days))
            linked, end = derive_dates(j.journey_date, duration) if derived else (j.linked_journey_date, j.end_date)
            if end < today:
                kept.append(str(j.id))
            else:
                changes.update(length)
                if derived and (linked, end) != (j.linked_journey_date, j.end_date):
                    changes.update(linked_journey_date=linked, end_date=end)
                    redated.append(str(j.id))
        changes = {k: v for k, v in changes.items() if getattr(j, k) != v}
        if not changes:
            continue
        for k, v in changes.items():
            setattr(j, k, v)
        j.updated_at = func.now()  # so offline devices syncing by updated_at pick up the change
        updated.append(str(j.id))
    if updated or kept:
        audit(db, actor_id=p.id, action="train.journeys.sync", entity=train, division_id=train.division_id,
              changes={**settings, **length, **{k: v and v.isoformat() for k, v in times.items()}, "journeys_updated": updated, "journeys_redated": redated,
                       "journeys_kept_would_end_before_today": kept})


def _untouched_journeys(db: Session, train_id: uuid.UUID) -> list[Journey]:
    """The train's journeys that are not cancelled, not over, and have nothing recorded against their coaches
    yet (no inspection, feedback, complaint or coach-wise inventory). Their coach snapshot can still follow
    the master; once anything names a coach, the journey keeps the coaches it actually ran with."""
    used = [
        select(Inspection.journey_id),
        select(PassengerFeedback.journey_id),
        select(RailwayFeedback.journey_id).where(RailwayFeedback.coach_code.is_not(None)),
        select(Complaint.journey_id).where(Complaint.journey_id.is_not(None), Complaint.coach_code.is_not(None)),
        select(InventoryTransaction.journey_id).where(InventoryTransaction.coach_code.is_not(None)),
    ]
    stmt = (select(Journey).options(selectinload(Journey.coaches))
            .where(Journey.train_id == train_id, Journey.status != JourneyStatus.CANCELLED,
                   Journey.end_date >= today_ist(), *[Journey.id.not_in(q) for q in used]))
    return list(db.scalars(stmt))


def replace_coaches(db: Session, p: Principal, train_id: uuid.UUID, body: CoachesReplace) -> Train:
    """Replaces the train's coaches, and the coach snapshot of its journeys nothing has been recorded on yet
    (_untouched_journeys). Journeys with inspections, feedback or complaints keep their own snapshot."""
    train = get_train(db, p, train_id, "trains.manage")
    old = [(c.code, c.classification.value) for c in train.coaches]
    train.coaches.clear()
    journeys = _untouched_journeys(db, train.id)
    for j in journeys:
        j.coaches.clear()
    db.flush()
    train.coaches.extend(_coach_rows(body.coaches))
    for j in journeys:
        j.coaches.extend(JourneyCoach(code=c.code, classification=c.classification, position=i)
                         for i, c in enumerate(body.coaches, 1))
        j.updated_at = func.now()  # so offline devices syncing by updated_at pick up the new coaches
    audit(db, actor_id=p.id, action="train.coaches.replace", entity=train, division_id=train.division_id,
          changes={"from": old, "to": [(c.code, c.classification.value) for c in body.coaches],
                   "journeys_updated": [str(j.id) for j in journeys]})
    db.commit()
    db.refresh(train)
    return train


def list_trains(db: Session, p: Principal, params: PageParams, *, division_id: uuid.UUID | None, active: bool | None,
                q: str | None, updated_since=None) -> tuple[list[Train], int]:
    divisions = p.require_any_division("trains.read")
    if division_id is not None:
        divisions = [d for d in divisions if d == division_id]
    stmt = (select(Train).options(selectinload(Train.coaches), selectinload(Train.stops), selectinload(Train.return_train))
            .where(Train.division_id.in_(divisions)))
    if active is not None:
        stmt = stmt.where(Train.is_active.is_(active))
    if q:
        stmt = stmt.where(Train.train_no.ilike(f"%{q}%") | Train.name.ilike(f"%{q}%"))
    if updated_since is not None:
        stmt = stmt.where(Train.updated_at > updated_since)
    return paginate(db, stmt.order_by(Train.train_no, Train.id), params)
