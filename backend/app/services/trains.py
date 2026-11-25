import uuid

from sqlalchemy import exists, select
from sqlalchemy.orm import Session, selectinload

from app.errors import BusinessRuleViolation, NotFound
from app.models import Attendance, Division, Journey, JourneyStatus, Train, TrainCoach
from app.schemas.common import PageParams
from app.schemas.trains import CoachesReplace, CoachIn, TrainCreate, TrainUpdate
from app.security.principal import Principal
from app.services.common import audit, commit_or_conflict, diff, flush_or_conflict, paginate


def _coach_rows(coaches: list[CoachIn]) -> list[TrainCoach]:
    return [TrainCoach(code=c.code, classification=c.classification, position=i) for i, c in enumerate(coaches, 1)]


def get_train(db: Session, p: Principal, train_id: uuid.UUID, permission: str = "trains.read") -> Train:
    train = db.get(Train, train_id)
    if train is None or not p.can_access_division(train.division_id):
        raise NotFound("Train not found")
    p.require(permission, train.division_id)
    return train


# ---- station-wise attendance ------------------------------------------------------------------------------

# The five stages every journey had before trains could name their attendance stations. Still the plan of a
# train with no configuration, and how records taken before migration 0020 are read.
LEGACY_STAGES: tuple[tuple[str, str], ...] = (
    ("source", "Source"), ("enroute", "Enroute 1"), ("destination", "Destination"), ("enroute", "Enroute 2"),
    ("end", "End"))


def legacy_stages() -> list[dict]:
    return [dict(stage=i, kind=kind, label=label, station_code=None, station_name=None)
            for i, (kind, label) in enumerate(LEGACY_STAGES, 1)]


def is_configured(train: Train) -> bool:
    return bool(train.attendance_station_count and train.attendance_station_codes)


def _route(train: Train) -> list[dict]:
    return [r for r in (train.route_stations or []) if isinstance(r, dict) and r.get("code")]


def attendance_plan(train: Train) -> list[dict]:
    """The attendance stages of a journey of this train: Source, the configured stations in route order, End.
    A train with no configuration keeps the five legacy stages."""
    if not is_configured(train):
        return legacy_stages()
    route = _route(train)
    names = {r["code"]: r.get("name") or r["code"] for r in route}
    first = route[0]["code"] if route else train.origin_code
    last = route[-1]["code"] if route else train.destination_code
    order = {r["code"]: i for i, r in enumerate(route)}
    codes = sorted(train.attendance_station_codes, key=lambda c: order.get(c, len(order)))
    plan = [dict(kind="source", label=f"Source – {names.get(first, first or 'origin')}",
                 station_code=first, station_name=names.get(first, first))]
    plan += [dict(kind="station", label=names.get(c, c), station_code=c, station_name=names.get(c, c)) for c in codes]
    plan.append(dict(kind="end", label=f"End – {names.get(last, last or 'destination')}",
                     station_code=last, station_name=names.get(last, last)))
    return [dict(stage=i, **st) for i, st in enumerate(plan, 1)]


def stages_of(j: Journey) -> list[dict]:
    """A journey's own attendance stages; journeys created before migration 0020 have the legacy five."""
    return j.attendance_stages or legacy_stages()


def selectable_stations(train: Train) -> list[dict]:
    """Stations attendance can be configured at: the route between its first and last station (Source and
    End are stages of their own)."""
    return _route(train)[1:-1]


def check_attendance_config(train: Train, count: int, codes: list[str]) -> list[str]:
    """The configured stations, validated and in route order. Raises BusinessRuleViolation."""
    allowed = [r["code"] for r in selectable_stations(train)]
    if not allowed:
        raise BusinessRuleViolation("This train's route is not known yet; load its route before choosing stations",
                                    code="route_unknown")
    codes = [str(c).strip().upper() for c in codes]
    if len(codes) != len(set(codes)):
        raise BusinessRuleViolation("A station can be selected only once", code="duplicate_station")
    if count > len(allowed):
        raise BusinessRuleViolation(f"The route has only {len(allowed)} stations between its source and end",
                                    code="attendance_count_exceeds_route", details={"available": len(allowed)})
    outside = [c for c in codes if c not in allowed]
    if outside:
        raise BusinessRuleViolation("Selected stations must be on this train's route", code="station_not_on_route",
                                    details={"stations": outside})
    if len(codes) != count:
        raise BusinessRuleViolation(f"Select exactly {count} stations ({len(codes)} selected)",
                                    code="attendance_count_mismatch", details={"required": count, "selected": len(codes)})
    return sorted(codes, key=allowed.index)


def refresh_journey_plans(db: Session, train: Train) -> int:
    """Gives the train's journeys that have no attendance yet the train's current stages. A journey where
    anyone has marked attendance keeps the stages it had, so no record changes meaning."""
    plan = attendance_plan(train)
    journeys = db.scalars(select(Journey).where(
        Journey.train_id == train.id, Journey.status != JourneyStatus.CANCELLED,
        ~exists().where(Attendance.journey_id == Journey.id))).unique().all()
    changed = 0
    for j in journeys:
        if j.attendance_stages != plan:
            j.attendance_stages = plan
            changed += 1
    return changed


def set_route(train: Train, route) -> None:
    """route: ((code, name), ...) in running order, as RailRadar's schedule gives it."""
    if route:
        train.route_stations = [dict(code=c, name=n) for c, n in route]


def refresh_route(db: Session, p: Principal, train_id: uuid.UUID, provider) -> Train:
    """Reads the train's stations from its RailRadar schedule (the same page office setup reads)."""
    from app.providers.railradar import RailRadarError

    train = get_train(db, p, train_id, "trains.manage")
    try:
        run = provider.train_run(train.train_no.split(" / ")[0].strip())
    except RailRadarError as exc:
        raise BusinessRuleViolation(f"The train's route could not be read: {exc}", code="route_unavailable") from exc
    if len(run.route) < 2:
        raise BusinessRuleViolation("RailRadar lists no stations for this train", code="route_unavailable")
    set_route(train, run.route)
    audit(db, actor_id=p.id, action="train.route.refresh", entity=train, division_id=train.division_id,
          changes={"stations": [c for c, _ in run.route]})
    if is_configured(train):
        db.flush()
        refresh_journey_plans(db, train)
    db.commit()
    return train


def create_train(db: Session, p: Principal, body: TrainCreate) -> Train:
    p.require("trains.manage", body.division_id)
    division = db.get(Division, body.division_id)
    if division is None or not division.is_active:
        raise BusinessRuleViolation("Division is not active")
    train = Train(**body.model_dump(exclude={"coaches"}), coaches=_coach_rows(body.coaches))
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
    replans = False
    if "attendance_station_count" in updates or "attendance_station_codes" in updates:
        count = updates.get("attendance_station_count", train.attendance_station_count)
        if count is None:
            updates["attendance_station_count"] = updates["attendance_station_codes"] = None
        else:
            updates["attendance_station_count"] = count
            updates["attendance_station_codes"] = check_attendance_config(
                train, count, updates.get("attendance_station_codes", train.attendance_station_codes) or [])
        replans = (updates["attendance_station_count"], updates["attendance_station_codes"]) != (
            train.attendance_station_count, train.attendance_station_codes)
    audit(db, actor_id=p.id, action="train.update", entity=train, division_id=train.division_id, changes=diff(train, updates))
    for k, v in updates.items():
        setattr(train, k, v)
    if replans:
        db.flush()
        refresh_journey_plans(db, train)
    db.commit()
    return train


def replace_coaches(db: Session, p: Principal, train_id: uuid.UUID, body: CoachesReplace) -> Train:
    """Existing journeys keep their own coach snapshot; only future journeys see the new list."""
    train = get_train(db, p, train_id, "trains.manage")
    old = [(c.code, c.classification.value) for c in train.coaches]
    train.coaches.clear()
    db.flush()
    train.coaches.extend(_coach_rows(body.coaches))
    audit(db, actor_id=p.id, action="train.coaches.replace", entity=train, division_id=train.division_id,
          changes={"from": old, "to": [(c.code, c.classification.value) for c in body.coaches]})
    db.commit()
    db.refresh(train)
    return train


def list_trains(db: Session, p: Principal, params: PageParams, *, division_id: uuid.UUID | None, active: bool | None,
                q: str | None, updated_since=None) -> tuple[list[Train], int]:
    divisions = p.require_any_division("trains.read")
    if division_id is not None:
        divisions = [d for d in divisions if d == division_id]
    stmt = select(Train).options(selectinload(Train.coaches)).where(Train.division_id.in_(divisions))
    if active is not None:
        stmt = stmt.where(Train.is_active.is_(active))
    if q:
        stmt = stmt.where(Train.train_no.ilike(f"%{q}%") | Train.name.ilike(f"%{q}%"))
    if updated_since is not None:
        stmt = stmt.where(Train.updated_at > updated_since)
    return paginate(db, stmt.order_by(Train.train_no, Train.id), params)
