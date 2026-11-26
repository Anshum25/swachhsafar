import uuid

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session, selectinload

from app.errors import BusinessRuleViolation, NotFound
from app.models import (Attendance, Complaint, Division, Inspection, InventoryTransaction, Journey, JourneyCoach,
                        JourneyStatus, PassengerFeedback, RailwayFeedback, Train, TrainCoach)
from app.services.journeys import derive_dates
from app.timeutil import today_ist
from app.schemas.common import PageParams
from app.schemas.trains import CoachesReplace, CoachIn, TrainCreate, TrainUpdate
from app.security.principal import Principal
from app.services import feedback_plan, route_window
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
# train with no configuration, and how records taken before migration 0021 are read.
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
    """The attendance stages of a journey of this train: the configured stations, in route order, and nothing else.
    With a count but no stations, that many numbered stages (Stage 1 .. Stage N). A train with neither keeps
    the five legacy stages."""
    if not train.attendance_station_count:
        return legacy_stages()
    if not is_configured(train):
        return [dict(stage=i, kind="stage", label=f"Stage {i}", station_code=None, station_name=None)
                for i in range(1, train.attendance_station_count + 1)]
    route = _route(train)
    names = {r["code"]: r.get("name") or r["code"] for r in route}
    order = {r["code"]: i for i, r in enumerate(route)}
    codes = sorted(train.attendance_station_codes, key=lambda c: order.get(c, len(order)))
    until = valid_until_of(route, codes, train.attendance_valid_until)
    return [dict(stage=i, kind="station", label=names.get(c, c), station_code=c, station_name=names.get(c, c),
                 valid_until_code=until.get(c), valid_until_name=names.get(until.get(c)) if until.get(c) else None,
                 window=station_window(route, codes, c, until.get(c)))
            for i, c in enumerate(codes, 1)]


def station_window(route: list[dict], codes: list[str], code: str, until: str | None) -> dict | None:
    """The route path the attendance at `code` may be taken on (services/route_window), or None when the
    stations have no known location."""
    choices = valid_until_choices(route, codes, code)
    if not choices or until not in choices:
        return None
    start = _first_index(route)[code]
    return route_window.build_window(route, start, start + choices.index(until))


def window_of(j: Journey, planned: dict) -> dict | None:
    """A stage's window. A station stage planned before windows existed (no "window" key) gets one from the
    train's current route and configuration."""
    if "window" in planned or not planned.get("station_code") or j.train is None:
        return planned.get("window")
    train = j.train
    route = _route(train)
    codes = [c for c in (train.attendance_station_codes or []) if c in _first_index(route)]
    if planned["station_code"] not in codes:
        return None
    until = valid_until_of(route, codes, train.attendance_valid_until).get(planned["station_code"])
    return station_window(route, codes, planned["station_code"], until)


def _first_index(route: list[dict]) -> dict[str, int]:
    order: dict[str, int] = {}
    for i, r in enumerate(route):
        order.setdefault(r["code"], i)
    return order


def valid_until_choices(route: list[dict], codes: list[str], code: str) -> list[str]:
    """The stations the attendance opening at `code` may stay open until: from that station up to the halt
    before the next attendance station (the last attendance: to the end of the route), in route order."""
    order = _first_index(route)
    if code not in order:
        return []
    start = order[code]
    later = [order[c] for c in codes if c in order and order[c] > start]
    stop = min(later) if later else len(route)
    return [r["code"] for r in route[start:stop]]


def valid_until_of(route: list[dict], codes: list[str], chosen: dict | None) -> dict[str, str]:
    """Each attendance station's last station: the office's choice when it still fits the route and the other
    stations, otherwise the default (the last of its choices)."""
    out = {}
    for c in codes:
        choices = valid_until_choices(route, codes, c)
        if choices:
            pick = (chosen or {}).get(c)
            out[c] = pick if pick in choices else choices[-1]
    return out


def check_valid_until(train: Train, codes: list[str], chosen: dict) -> dict[str, str]:
    """The office's "valid until" stations, validated against the configured stations. Raises
    BusinessRuleViolation. Returns only the stations given."""
    route = _route(train)
    unknown = [c for c in chosen if c not in codes]
    if unknown:
        raise BusinessRuleViolation("A valid-until station is given for a station that is not an attendance station",
                                    code="valid_until_unknown_station", details={"stations": unknown})
    for c, until in chosen.items():
        if until not in valid_until_choices(route, codes, c):
            raise BusinessRuleViolation(
                f"The attendance at {c} can stay open only from {c} up to the station before the next attendance "
                f"station", code="valid_until_out_of_range", details={"station": c, "valid_until": until})
    return {c: chosen[c] for c in codes if c in chosen}


def stages_of(j: Journey) -> list[dict]:
    """A journey's own attendance stages; journeys created before migration 0021 have the legacy five."""
    return j.attendance_stages or legacy_stages()


def selectable_stations(train: Train) -> list[dict]:
    """Stations attendance can be configured at: every station of the route, first and last included."""
    return _route(train)


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
        raise BusinessRuleViolation(f"The route has only {len(allowed)} stations",
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
    replans = False
    if {"attendance_station_count", "attendance_station_codes", "attendance_valid_until"} & updates.keys():
        count = updates.get("attendance_station_count", train.attendance_station_count)
        if count is None:
            updates["attendance_station_count"] = updates["attendance_station_codes"] = None
            updates["attendance_valid_until"] = None
        else:
            updates["attendance_station_count"] = count
            codes = updates.get("attendance_station_codes", train.attendance_station_codes)
            # No stations: `count` numbered stages. Stations: exactly `count` of them, on the route.
            codes = updates["attendance_station_codes"] = check_attendance_config(train, count, codes) if codes else None
            if not codes:
                updates["attendance_valid_until"] = None
            elif "attendance_valid_until" in updates:
                updates["attendance_valid_until"] = check_valid_until(train, codes, updates["attendance_valid_until"] or {}) or None
            elif train.attendance_valid_until:
                # The stations changed without new windows: keep the choices that still fit, the rest go to default.
                kept = {c: u for c, u in train.attendance_valid_until.items()
                        if c in codes and u in valid_until_choices(_route(train), codes, c)}
                updates["attendance_valid_until"] = kept or None
        replans = tuple(updates.get(k, getattr(train, k)) for k in ATTENDANCE_CONFIG) != tuple(
            getattr(train, k) for k in ATTENDANCE_CONFIG)
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
    if replans:
        db.flush()
        refresh_journey_plans(db, train)
    db.commit()
    return train


# Train Master settings that shape the attendance stages of its journeys.
ATTENDANCE_CONFIG = ("attendance_station_count", "attendance_station_codes", "attendance_valid_until")

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
