"""Passenger feedback against Train Master targets, verification failures, and timetable sync status.

Every figure is computed in the database from journey_feedback_targets (what was asked for) and
passenger_feedback (what was collected); nothing is estimated. Definitions (services/feedback_plan):
- required: the day's target; pending = required - submitted, never below 0, summed day by day;
- submitted: completed feedback; verified: completed with a valid PNR or an OTP-verified mobile;
- in_progress: started, not completed; rejected: voided (invalid PNR, OTP locked, or voided by a reviewer).
Journeys whose targets were never generated have no target rows and are counted in `journeys_without_targets`.
"""

import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.errors import BusinessRuleViolation
from app.models import (
    AuditLog,
    Journey,
    JourneyCoach,
    JourneyFeedbackTarget,
    JourneyStatus,
    OtpStatus,
    PassengerFeedback,
    PassengerFeedbackStatus,
    PnrStatus,
    Train,
    TrainSyncRun,
)
from app.schemas.trains import SyncRunOut
from app.security.principal import Principal
from app.services.feedback_plan import DIRECTION_LABEL, count_columns
from app.services.reports import _divisions
from app.timeutil import IST

GROUPS = ("train", "direction", "date", "day", "coach")


def _check_range(date_from: date, date_to: date) -> None:
    if date_to < date_from or (date_to - date_from).days > 366:
        raise BusinessRuleViolation("Date range must be ascending and at most one year")


def _pct(done, required) -> float | None:
    return round(min(done / required, 1) * 100, 1) if required else None


def target_report(db: Session, p: Principal, *, date_from: date, date_to: date, group_by: str = "train",
                  division_id: uuid.UUID | None = None, train_id: uuid.UUID | None = None,
                  direction: int | None = None) -> dict:
    if group_by not in GROUPS:
        raise BusinessRuleViolation(f"group_by must be one of {', '.join(GROUPS)}")
    _check_range(date_from, date_to)
    divisions = _divisions(p, division_id)
    T = JourneyFeedbackTarget
    where = [Journey.division_id.in_(divisions), Journey.status != JourneyStatus.CANCELLED,
             T.day_date >= date_from, T.day_date <= date_to]
    if train_id is not None:
        where.append((Journey.train_id == train_id) | (Journey.linked_train_id == train_id))
    if direction is not None:
        where.append(T.direction == direction)

    if group_by == "coach":
        rows = _coach_rows(db, where)
    else:
        counts = (select(PassengerFeedback.journey_id, PassengerFeedback.journey_day, *count_columns())
                  .group_by(PassengerFeedback.journey_id, PassengerFeedback.journey_day).subquery())
        submitted = func.coalesce(counts.c.submitted, 0)
        pending_day = func.greatest(T.required - submitted, 0) if db.bind.dialect.name != "sqlite" else \
            func.max(T.required - submitted, 0)
        keys = {
            "train": (Train.train_no, Train.name, T.direction),
            "direction": (T.direction,),
            "date": (T.day_date,),
            "day": (Journey.id, Train.train_no, Train.name, Journey.journey_date, T.journey_day, T.day_date, T.direction,
                    T.train_nos),
        }[group_by]
        stmt = (select(*keys, func.count(func.distinct(Journey.id)).label("journeys"), func.count().label("days"),
                       func.sum(T.required).label("required"), func.sum(submitted).label("submitted"),
                       func.sum(func.coalesce(counts.c.verified, 0)).label("verified"),
                       func.sum(func.coalesce(counts.c.in_progress, 0)).label("in_progress"),
                       func.sum(func.coalesce(counts.c.rejected, 0)).label("rejected"),
                       func.sum(pending_day).label("pending"),
                       func.sum(func.coalesce(T.minimum, 0)).label("minimum"))
                .select_from(T).join(Journey, Journey.id == T.journey_id).join(Train, Train.id == Journey.train_id)
                .outerjoin(counts, and_(counts.c.journey_id == T.journey_id, counts.c.journey_day == T.journey_day))
                .where(*where).group_by(*keys).order_by(*keys))
        rows = []
        for r in db.execute(stmt).all():
            m = dict(r._mapping)
            row = {k: int(m[k] or 0) for k in ("journeys", "days", "required", "submitted", "verified", "in_progress",
                                                  "rejected", "pending")}
            row["completion"] = _pct(row["submitted"], row["required"])
            if "direction" in m:
                row["direction"] = m["direction"]
                row["direction_label"] = DIRECTION_LABEL.get(m["direction"])
            for k in ("train_no", "name", "day_date", "journey_date", "journey_day", "train_nos"):
                if k in m:
                    row[k] = m[k]
            if group_by == "day":
                row["journey_id"] = m["id"]
                row["minimum"] = int(m["minimum"] or 0) or None
            rows.append(row)

    without = db.scalar(select(func.count()).select_from(Journey).where(
        Journey.division_id.in_(divisions), Journey.status != JourneyStatus.CANCELLED,
        Journey.journey_date <= date_to, Journey.end_date >= date_from,
        Journey.id.not_in(select(T.journey_id)),
        *([((Journey.train_id == train_id) | (Journey.linked_train_id == train_id))] if train_id else [])))
    totals = {k: sum(r.get(k, 0) or 0 for r in rows) for k in ("required", "submitted", "verified", "in_progress",
                                                               "rejected", "pending")}
    totals["completion"] = _pct(totals["submitted"], totals["required"])
    return dict(group_by=group_by, date_from=date_from, date_to=date_to, rows=rows, totals=totals,
                journeys_without_targets=int(without or 0))


def _coach_rows(db: Session, where: list) -> list[dict]:
    """Per train and coach: feedback collected there, and the coach target over the days that carry one."""
    T = JourneyFeedbackTarget
    days = (select(T.journey_id, T.journey_day, T.coach_required).join(Journey, Journey.id == T.journey_id)
            .join(Train, Train.id == Journey.train_id).where(*where).subquery())
    fb = (select(Train.train_no, PassengerFeedback.coach_code, *count_columns())
          .select_from(PassengerFeedback)
          .join(days, and_(days.c.journey_id == PassengerFeedback.journey_id,
                           days.c.journey_day == PassengerFeedback.journey_day))
          .join(Journey, Journey.id == PassengerFeedback.journey_id).join(Train, Train.id == Journey.train_id)
          .group_by(Train.train_no, PassengerFeedback.coach_code))
    got = {(r.train_no, r.coach_code): r for r in db.execute(fb).all()}
    target = (select(Train.train_no, JourneyCoach.code, func.sum(func.coalesce(days.c.coach_required, 0)).label("required"))
              .select_from(days).join(JourneyCoach, JourneyCoach.journey_id == days.c.journey_id)
              .join(Journey, Journey.id == days.c.journey_id).join(Train, Train.id == Journey.train_id)
              .group_by(Train.train_no, JourneyCoach.code))
    req = {(r.train_no, r.code): int(r.required or 0) for r in db.execute(target).all()}
    rows = []
    for key in sorted(set(got) | set(req)):
        r = got.get(key)
        sub = int(r.submitted or 0) if r else 0
        required = req.get(key, 0)
        rows.append(dict(train_no=key[0], coach_code=key[1], required=required, submitted=sub,
                         verified=int(r.verified or 0) if r else 0, in_progress=int(r.in_progress or 0) if r else 0,
                         rejected=int(r.rejected or 0) if r else 0, pending=max(required - sub, 0),
                         completion=_pct(sub, required)))
    return rows


def verification_report(db: Session, p: Principal, *, date_from: date, date_to: date,
                        division_id: uuid.UUID | None = None) -> dict:
    """PNR and OTP outcomes of passenger feedback captured in the range: rejections by reason, coach checks,
    provider outages and wrong OTP entries (from the audit log)."""
    _check_range(date_from, date_to)
    divisions = _divisions(p, division_id)
    F = PassengerFeedback
    in_range = [F.division_id.in_(divisions), F.feedback_date >= date_from, F.feedback_date <= date_to]
    pnr = dict(db.execute(select(F.pnr_status, func.count()).where(*in_range).group_by(F.pnr_status)).all())
    otp = dict(db.execute(select(F.otp_status, func.count()).where(*in_range).group_by(F.otp_status)).all())
    reasons = [dict(reason=r, count=int(n)) for r, n in db.execute(
        select(F.void_reason, func.count()).where(*in_range, F.status == PassengerFeedbackStatus.VOID)
        .group_by(F.void_reason).order_by(func.count().desc())).all()]
    pnr_reasons = [dict(reason=r, count=int(n)) for r, n in db.execute(
        select(F.void_reason, func.count()).where(*in_range, F.pnr_status == PnrStatus.INVALID)
        .group_by(F.void_reason).order_by(func.count().desc())).all()]
    coach = dict(db.execute(select(F.coach_source, func.count()).where(*in_range, F.pnr_status == PnrStatus.VALID)
                            .group_by(F.coach_source)).all())
    unverified_coach = db.scalar(select(func.count()).where(*in_range, F.pnr_status == PnrStatus.VALID,
                                                            F.coach_verified.is_(False))) or 0
    lo = datetime.combine(date_from, time.min, IST)
    hi = datetime.combine(date_to + timedelta(days=1), time.min, IST)
    events = dict(db.execute(select(AuditLog.action, func.count()).where(
        AuditLog.division_id.in_(divisions), AuditLog.created_at >= lo, AuditLog.created_at < hi,
        AuditLog.action.in_(("feedback.passenger.pnr_unavailable", "feedback.passenger.sms_unavailable",
                             "feedback.passenger.otp_failed"))).group_by(AuditLog.action)).all())
    return dict(
        date_from=date_from, date_to=date_to,
        pnr=dict(valid=int(pnr.get(PnrStatus.VALID, 0)), invalid=int(pnr.get(PnrStatus.INVALID, 0)),
                 pending=int(pnr.get(PnrStatus.PENDING, 0)), not_required=int(pnr.get(PnrStatus.NOT_REQUIRED, 0)),
                 provider_unavailable=int(events.get("feedback.passenger.pnr_unavailable", 0)), reasons=pnr_reasons),
        otp=dict(verified=int(otp.get(OtpStatus.VERIFIED, 0)), locked=int(otp.get(OtpStatus.LOCKED, 0)),
                 sent=int(otp.get(OtpStatus.SENT, 0)), not_sent=int(otp.get(OtpStatus.NOT_SENT, 0)),
                 not_required=int(otp.get(OtpStatus.NOT_REQUIRED, 0)),
                 wrong_codes=int(events.get("feedback.passenger.otp_failed", 0)),
                 sms_unavailable=int(events.get("feedback.passenger.sms_unavailable", 0))),
        coach=dict(as_selected=int(coach.get("selected", 0)), moved_to_ticket=int(coach.get("pnr", 0)),
                   not_confirmed_by_ticket=int(unverified_coach)),
        void_reasons=reasons)


def sync_report(db: Session, p: Principal, *, division_id: uuid.UUID | None = None) -> dict:
    """Each train's timetable state, and the latest failed or rejected reads."""
    divisions = _divisions(p, division_id, "trains.read")
    trains = list(db.scalars(select(Train).where(Train.division_id.in_(divisions)).order_by(Train.train_no)))
    stops = dict(db.execute(select(Train.id, func.count()).join(Train.stops).where(Train.division_id.in_(divisions))
                            .group_by(Train.id)).all())
    status = {}
    for t in trains:
        status[t.schedule_status or "never"] = status.get(t.schedule_status or "never", 0) + 1
    failures = list(db.scalars(select(TrainSyncRun).join(Train, Train.id == TrainSyncRun.train_id)
                               .where(Train.division_id.in_(divisions), TrainSyncRun.outcome.in_(("failed", "rejected")))
                               .order_by(TrainSyncRun.started_at.desc()).limit(50)))
    return dict(
        counts=status,
        trains=[dict(train_id=t.id, train_no=t.train_no, name=t.name, is_active=t.is_active,
                     origin_code=t.origin_code, destination_code=t.destination_code,
                     return_train_no=t.return_train_no, stops=int(stops.get(t.id, 0)), schedule_status=t.schedule_status,
                     schedule_synced_at=t.schedule_synced_at, schedule_checked_at=t.schedule_checked_at,
                     schedule_error=t.schedule_error, schedule_failures=t.schedule_failures,
                     feedback_enabled=t.feedback_enabled, feedback_daily_target=t.feedback_daily_target) for t in trains],
        recent_failures=[SyncRunOut.model_validate(r).model_dump() for r in failures])
