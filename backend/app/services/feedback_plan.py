"""A journey's passenger feedback plan, driven by Train Master: its legs and its target on every journey day.

A journey is a round trip: out with its train, back with its linked (return) train. Each direction is a
`JourneyLeg` with its own dates and a snapshot of its own train's stops (app/services/timetable.py reads
both timetables separately; the return is never the outbound reversed). Every journey day falls on the
outbound leg (1), the return leg (2), both (3: the train turns round that day) or neither (None: a layover
at the far end).

`JourneyFeedbackTarget` holds what the train's Train Master configuration asks for on each journey day:
`feedback_daily_target` for the whole train, optionally `feedback_coach_daily_target` per coach, optionally a
`feedback_min_daily` floor, within the collection window `feedback_from_day`..`feedback_to_day`, on every day
or ("running") only on days a leg runs. A 4-day journey at 10 a day needs 40.

Rules that keep history intact:
- a day that has begun (its date is today or earlier) keeps its target when the master or the timetable
  changes; days still ahead follow the new values;
- legs are re-snapshotted only until the journey starts;
- submitted / verified / pending are never stored: they are counted from passenger_feedback each time, so a
  configuration change can never alter what was collected.

`refresh(db, journey, today)` is idempotent: running it again with the same inputs changes nothing.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    Journey,
    JourneyFeedbackTarget,
    JourneyLeg,
    JourneyStatus,
    OtpStatus,
    PassengerFeedback,
    PassengerFeedbackStatus,
    PnrStatus,
    Train,
)
from app.timeutil import today_ist, utcnow

OUTBOUND, RETURN, BOTH = 1, 2, 3
DIRECTION_LABEL = {OUTBOUND: "outbound", RETURN: "return", BOTH: "outbound + return", None: "layover"}


# ---- legs --------------------------------------------------------------------------------------------------


def _outbound_end(j: Journey) -> date:
    """The day the outbound train reaches its far end, from what the journey and its train record."""
    if j.outbound_end_date is not None:
        end = j.outbound_end_date
    elif j.train is not None and j.train.arrival_days is not None:
        end = j.journey_date + timedelta(days=j.train.arrival_days)
    elif j.linked_train_id is not None and j.linked_journey_date > j.journey_date:
        end = j.linked_journey_date - timedelta(days=1)  # the return leaves the day after it arrives
    elif j.linked_train_id is not None:
        end = j.journey_date
    else:
        end = j.end_date
    return min(max(end, j.journey_date), j.end_date)


def leg_windows(j: Journey) -> list[dict]:
    """[{direction, train, departs_on, arrives_on, departs_at, arrives_at}] -- one per direction the journey has."""
    out = [dict(direction=OUTBOUND, train=j.train, departs_on=j.journey_date, arrives_on=_outbound_end(j),
                departs_at=j.start_time, arrives_at=j.end_time)]
    if j.linked_train_id is not None:
        start = min(max(j.linked_journey_date, j.journey_date), j.end_date)
        out.append(dict(direction=RETURN, train=j.linked_train, departs_on=start, arrives_on=j.end_date,
                        departs_at=j.return_start_time, arrives_at=j.return_end_time))
    return out


def _clock(t) -> str | None:
    return t.strftime("%H:%M") if t is not None else None


def _stops_snapshot(j: Journey, train: Train | None, departs_on: date) -> list[dict]:
    if train is None or not train.stops:
        return []
    first_day = train.stops[0].day
    out = []
    for s in train.stops:
        on = departs_on + timedelta(days=s.day - first_day)
        out.append(dict(seq=s.seq, code=s.station_code, name=s.station_name, arrival=_clock(s.arrival),
                        departure=_clock(s.departure), day=s.day, date=on.isoformat(),
                        journey_day=(on - j.journey_date).days + 1, distance_km=s.distance_km, platform=s.platform))
    return out


def _leg_row(j: Journey, w: dict) -> dict:
    train: Train | None = w["train"]
    stops = _stops_snapshot(j, train, w["departs_on"])
    first, last = (stops[0], stops[-1]) if stops else (None, None)
    return dict(
        direction=w["direction"], train_id=train.id if train else None,
        train_no=train.train_no if train else "?", train_name=train.name if train else None,
        origin_code=(first or {}).get("code") or (train.origin_code if train else None),
        origin_name=(first or {}).get("name"),
        destination_code=(last or {}).get("code") or (train.destination_code if train else None),
        destination_name=(last or {}).get("name") or (train.destination_name if train else None),
        departs_on=w["departs_on"], departs_at=w["departs_at"], arrives_on=w["arrives_on"], arrives_at=w["arrives_at"],
        first_day=(w["departs_on"] - j.journey_date).days + 1, last_day=(w["arrives_on"] - j.journey_date).days + 1,
        stops=stops, schedule_hash=train.schedule_hash if train else None)


# ---- days --------------------------------------------------------------------------------------------------


def day_direction(legs: list[dict], on: date) -> int | None:
    dirs = {leg["direction"] for leg in legs if leg["departs_on"] <= on <= leg["arrives_on"]}
    if dirs == {OUTBOUND, RETURN}:
        return BOTH
    return next(iter(dirs), None)


def day_trains(legs: list[dict], on: date) -> list[str]:
    nos = []
    for leg in legs:
        if leg["departs_on"] <= on <= leg["arrives_on"]:
            nos.extend(n.strip() for n in str(leg["train_no"]).split("/") if n.strip())
    return list(dict.fromkeys(nos))


def targets_active(train: Train | None) -> bool:
    return bool(train and train.feedback_enabled and train.feedback_targets_active and train.feedback_daily_target)


def in_window(train: Train | None, day: int) -> bool:
    if train is None:
        return True
    return train.feedback_from_day <= day <= (train.feedback_to_day or 30)


def build_days(j: Journey, legs: list[dict]) -> list[dict]:
    """What the Train Master configuration asks for on each journey day (pure; nothing is written)."""
    train = j.train
    active = targets_active(train)
    out = []
    for day in range(1, j.operational_days + 1):
        on = j.journey_date + timedelta(days=day - 1)
        direction = day_direction(legs, on)
        counts = active and in_window(train, day) and (train.feedback_days == "all" or direction is not None)
        nos = day_trains(legs, on)
        out.append(dict(
            journey_day=day, day_date=on, direction=direction, train_nos=",".join(nos)[:40] or None,
            required=train.feedback_daily_target if counts else 0,
            coach_required=train.feedback_coach_daily_target if counts else None,
            minimum=train.feedback_min_daily if counts else None))
    return out


# ---- persistence -------------------------------------------------------------------------------------------


def refresh(db: Session, j: Journey, today: date | None = None, *, force_legs: bool = False) -> bool:
    """Bring a journey's legs and targets in line with its train's Train Master configuration and timetable.
    Days that have begun keep their target; legs follow only until the journey starts. Returns whether
    anything changed. Does not commit."""
    today = today or today_ist()
    if j.status == JourneyStatus.CANCELLED:
        return False
    changed = False
    now = utcnow()
    legs_now = [_leg_row(j, w) for w in leg_windows(j)]
    have = {leg.direction: leg for leg in j.legs}
    if force_legs or j.journey_date > today or not have:
        for row in legs_now:
            leg = have.pop(row["direction"], None)
            if leg is None:
                j.legs.append(JourneyLeg(**row, generated_at=now))
                changed = True
                continue
            diff = {k: v for k, v in row.items() if getattr(leg, k) != v}
            if diff:
                for k, v in diff.items():
                    setattr(leg, k, v)
                leg.generated_at = now
                changed = True
        for leg in have.values():  # a direction the journey no longer has (its return train was unlinked)
            j.legs.remove(leg)
            changed = True
    # Targets follow the legs the journey has now (snapshots included), so the day mapping matches them.
    legs = [dict(direction=leg.direction, departs_on=leg.departs_on, arrives_on=leg.arrives_on, train_no=leg.train_no)
            for leg in j.legs] if j.legs else legs_now
    wanted = {d["journey_day"]: d for d in build_days(j, legs)}
    existing = {t.journey_day: t for t in j.feedback_targets}
    for day, row in wanted.items():
        t = existing.pop(day, None)
        if t is None:
            j.feedback_targets.append(JourneyFeedbackTarget(**row, generated_at=now))
            changed = True
            continue
        if t.day_date <= today:
            continue  # a day under way or past keeps the target it was given
        diff = {k: v for k, v in row.items() if getattr(t, k) != v}
        if diff:
            for k, v in diff.items():
                setattr(t, k, v)
            t.generated_at = now
            changed = True
    for t in existing.values():  # days the journey no longer has; only ones still ahead are dropped
        if t.day_date > today:
            j.feedback_targets.remove(t)
            changed = True
    return changed


def _journeys(db: Session, *where) -> list[Journey]:
    return list(db.scalars(select(Journey).options(
        selectinload(Journey.legs), selectinload(Journey.feedback_targets), selectinload(Journey.coaches))
        .where(Journey.status != JourneyStatus.CANCELLED, *where)).unique())


def refresh_for_trains(db: Session, train_ids, today: date | None = None) -> int:
    """Every journey of these trains (as the outbound or the return train) that has not ended. Returns how
    many changed. Does not commit."""
    today = today or today_ist()
    ids = list(train_ids)
    if not ids:
        return 0
    journeys = _journeys(db, Journey.end_date >= today,
                         (Journey.train_id.in_(ids)) | (Journey.linked_train_id.in_(ids)))
    return sum(1 for j in journeys if refresh(db, j, today))


def backfill(db: Session, today: date | None = None) -> int:
    """Legs and targets for every journey not yet ended that has none (journeys created before migration
    0020, or by a path that did not plan them). Commits. Returns how many journeys were planned."""
    today = today or today_ist()
    no_targets = select(JourneyFeedbackTarget.journey_id)
    journeys = _journeys(db, Journey.end_date >= today, Journey.id.not_in(no_targets))
    n = sum(1 for j in journeys if refresh(db, j, today))
    db.commit()
    return n


# ---- reading the plan --------------------------------------------------------------------------------------

DONE = PassengerFeedbackStatus.COMPLETED
IN_PROGRESS = (PassengerFeedbackStatus.DRAFT, PassengerFeedbackStatus.VERIFIED)


def verified_clause():
    """A completed feedback whose passenger was checked against an outside source: the PNR was found valid by
    the provider, or the mobile number was confirmed by OTP. (A completed feedback has already passed every
    check the division requires; this tells apart those that had any external check at all.)"""
    return and_(PassengerFeedback.status == DONE,
                (PassengerFeedback.pnr_status == PnrStatus.VALID) | (PassengerFeedback.otp_status == OtpStatus.VERIFIED))


def count_columns():
    return (
        func.sum(case((PassengerFeedback.status == DONE, 1), else_=0)).label("submitted"),
        func.sum(case((verified_clause(), 1), else_=0)).label("verified"),
        func.sum(case((PassengerFeedback.status.in_(IN_PROGRESS), 1), else_=0)).label("in_progress"),
        func.sum(case((PassengerFeedback.status == PassengerFeedbackStatus.VOID, 1), else_=0)).label("rejected"),
    )


def day_status(required: int, minimum: int | None, submitted: int, on: date, today: date) -> str:
    if not required:
        return "no_target"
    if submitted >= required:
        return "complete"
    if on > today:
        return "upcoming"
    if minimum and submitted < minimum and on < today:
        return "short"
    if on < today:
        return "incomplete"
    return "in_progress"


def _pct(done: int, required: int) -> float | None:
    return round(min(done / required, 1) * 100, 1) if required else None


def plan_out(db: Session, j: Journey, today: date | None = None) -> dict:
    """The journey's feedback plan with live progress: legs, days, coaches, totals. Reads only. A journey
    whose targets were never generated is shown with the targets it would get (persisted: false)."""
    today = today or today_ist()
    persisted = bool(j.feedback_targets)
    if j.legs:
        legs = [dict(direction=leg.direction, train_no=leg.train_no, train_name=leg.train_name,
                     origin_code=leg.origin_code, origin_name=leg.origin_name, destination_code=leg.destination_code,
                     destination_name=leg.destination_name, departs_on=leg.departs_on, departs_at=leg.departs_at,
                     arrives_on=leg.arrives_on, arrives_at=leg.arrives_at, first_day=leg.first_day,
                     last_day=leg.last_day, stops=leg.stops) for leg in j.legs]
    else:
        legs = [_leg_row(j, w) for w in leg_windows(j)]
    if persisted:
        days = [dict(journey_day=t.journey_day, day_date=t.day_date, direction=t.direction, train_nos=t.train_nos,
                     required=t.required, coach_required=t.coach_required, minimum=t.minimum) for t in j.feedback_targets]
    else:
        days = build_days(j, legs)

    by_day = {r.journey_day: r for r in db.execute(
        select(PassengerFeedback.journey_day, *count_columns()).where(PassengerFeedback.journey_id == j.id)
        .group_by(PassengerFeedback.journey_day)).all()}
    by_coach_day = {(r.coach_code, r.journey_day): r for r in db.execute(
        select(PassengerFeedback.coach_code, PassengerFeedback.journey_day, *count_columns())
        .where(PassengerFeedback.journey_id == j.id)
        .group_by(PassengerFeedback.coach_code, PassengerFeedback.journey_day)).all()}

    def counts(row) -> dict:
        return dict(submitted=int(row.submitted or 0), verified=int(row.verified or 0),
                    in_progress=int(row.in_progress or 0), rejected=int(row.rejected or 0)) if row else \
            dict(submitted=0, verified=0, in_progress=0, rejected=0)

    out_days = []
    for d in days:
        c = counts(by_day.get(d["journey_day"]))
        out_days.append(dict(**d, **c, direction_label=DIRECTION_LABEL.get(d["direction"]),
                             pending=max(d["required"] - c["submitted"], 0), completion=_pct(c["submitted"], d["required"]),
                             status=day_status(d["required"], d["minimum"], c["submitted"], d["day_date"], today),
                             is_today=d["day_date"] == today))
    coach_days = {d["journey_day"]: d for d in days}
    coaches = []
    for coach in j.coaches:
        cells = []
        for day, d in coach_days.items():
            c = counts(by_coach_day.get((coach.code, day)))
            req = d["coach_required"] or 0
            cells.append(dict(journey_day=day, required=req, pending=max(req - c["submitted"], 0), **c))
        req = sum(x["required"] for x in cells)
        sub = sum(x["submitted"] for x in cells)
        coaches.append(dict(code=coach.code, classification=coach.classification, days=cells, required=req,
                            submitted=sub, verified=sum(x["verified"] for x in cells),
                            in_progress=sum(x["in_progress"] for x in cells), rejected=sum(x["rejected"] for x in cells),
                            pending=sum(x["pending"] for x in cells), completion=_pct(sub, req)))
    # Feedback recorded under a coach the journey no longer lists is still counted in the day totals above.
    req = sum(d["required"] for d in out_days)
    sub = sum(d["submitted"] for d in out_days)
    train = j.train
    return dict(
        journey_id=j.id, train_id=j.train_id, train_no=train.train_no, train_name=train.name,
        journey_date=j.journey_date, end_date=j.end_date, operational_days=j.operational_days,
        feedback_enabled=bool(train.feedback_enabled), targets_active=targets_active(train),
        daily_target=train.feedback_daily_target, coach_daily_target=train.feedback_coach_daily_target,
        min_daily=train.feedback_min_daily, feedback_from_day=train.feedback_from_day,
        feedback_to_day=train.feedback_to_day, feedback_days=train.feedback_days,
        persisted=persisted, legs=legs, days=out_days, coaches=coaches,
        totals=dict(required=req, submitted=sub, verified=sum(d["verified"] for d in out_days),
                    in_progress=sum(d["in_progress"] for d in out_days), rejected=sum(d["rejected"] for d in out_days),
                    pending=sum(d["pending"] for d in out_days), completion=_pct(sub, req)))


def target_for(db: Session, journey_id: uuid.UUID, day: int) -> JourneyFeedbackTarget | None:
    return db.scalar(select(JourneyFeedbackTarget).where(JourneyFeedbackTarget.journey_id == journey_id,
                                                         JourneyFeedbackTarget.journey_day == day))


def day_info(j: Journey, day: int) -> dict:
    """Direction and train numbers of one journey day: from its stored target when there is one, else from
    the journey's legs as they stand."""
    t = next((t for t in j.feedback_targets if t.journey_day == day), None)
    if t is not None:
        return dict(direction=t.direction, train_nos=[n for n in (t.train_nos or "").split(",") if n])
    legs = [dict(direction=leg.direction, departs_on=leg.departs_on, arrives_on=leg.arrives_on, train_no=leg.train_no)
            for leg in j.legs] if j.legs else [_leg_row(j, w) for w in leg_windows(j)]
    on = j.journey_date + timedelta(days=day - 1)
    return dict(direction=day_direction(legs, on), train_nos=day_trains(legs, on))


def leg_for(j: Journey, train_no: str | None) -> dict | None:
    """The journey's leg run by this train number (stops included), from the snapshot or the timetable."""
    if not train_no:
        return None
    legs = [dict(direction=leg.direction, train_no=leg.train_no, departs_on=leg.departs_on, arrives_on=leg.arrives_on,
                 stops=leg.stops) for leg in j.legs] if j.legs else [_leg_row(j, w) for w in leg_windows(j)]
    for leg in legs:
        if train_no in {n.strip() for n in str(leg["train_no"]).split("/")}:
            return leg
    return None
