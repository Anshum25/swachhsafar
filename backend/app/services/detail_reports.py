"""Row-level reports laid out like the paper work statements the railway asks for: the inspection list, the
PSI work statement, the attendance summary and the journey report. Each is filtered by period and, optionally,
one train (a journey matches when the train is its outbound or its return train). Read-only."""

import uuid
from collections import defaultdict
from datetime import date

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, aliased

from app.errors import BusinessRuleViolation, Conflict
from app.models import (
    Attendance,
    Inspection,
    Journey,
    JourneyFeedbackTarget,
    JourneyLeg,
    JourneyStatus,
    PassengerFeedback,
    PassengerFeedbackRating,
    PassengerFeedbackStatus,
    StaffAllocation,
    Train,
    User,
)
from app.models.org import RoleId
from app.security.principal import Principal
from app.services.reports import COUNTED, _bank_for, _divisions, _journeys_in, _range
from app.services.trains import stages_of

MAX_JOURNEYS = 400
MAX_INSPECTIONS = 5000


def _journeys(db: Session, p: Principal, division_id, date_from: date, date_to: date,
              train_id: uuid.UUID | None) -> list[Journey]:
    divisions = _divisions(p, division_id)
    _range(date_from, date_to)
    stmt = select(Journey).where(_journeys_in(divisions, date_from, date_to), Journey.status != JourneyStatus.CANCELLED)
    if train_id is not None:
        stmt = stmt.where(or_(Journey.train_id == train_id, Journey.linked_train_id == train_id))
    rows = db.scalars(stmt.order_by(Journey.journey_date, Journey.id).limit(MAX_JOURNEYS + 1)).unique().all()
    if len(rows) > MAX_JOURNEYS:
        raise BusinessRuleViolation(f"More than {MAX_JOURNEYS} journeys in this period; choose a train or a shorter period",
                                    code="too_many_journeys")
    return list(rows)


def _train_label(j: Journey) -> str:
    nos = [j.train.train_no] + ([j.linked_train.train_no] if j.linked_train is not None else [])
    return " - ".join(nos)


def _train_name(j: Journey) -> str:
    return j.train.name


def _coach_split(coaches) -> tuple[int, int]:
    ac = sum(1 for c in coaches if getattr(c.classification, "value", c.classification) == "AC")
    return ac, len(coaches) - ac


def _staff(db: Session, journey_ids) -> dict:
    """journey_id -> [(user_id, name, emp_id, role_id)] of staff currently allocated, EHK first."""
    out = defaultdict(list)
    if not journey_ids:
        return out
    rows = db.execute(select(StaffAllocation.journey_id, User.id, User.name, User.emp_id, StaffAllocation.role_id)
                      .join(User, User.id == StaffAllocation.user_id)
                      .where(StaffAllocation.journey_id.in_(journey_ids), StaffAllocation.removed_at.is_(None))
                      .order_by(StaffAllocation.created_at)).all()
    for jid, uid, name, emp, role in rows:
        out[jid].append((uid, name, emp, int(role)))
    for jid in out:
        out[jid].sort(key=lambda s: 0 if s[3] == RoleId.SUPERVISOR else 1)
    return out


def _required_inspections(j: Journey, coaches: int) -> int:
    phases = int(j.before_inspection_enabled) + int(j.after_inspection_enabled)
    return coaches * (j.operational_days if j.daywise else 1) * j.inspection_rounds_per_day * phases


def _train_filter_label(db: Session, train_id) -> dict | None:
    t = db.get(Train, train_id) if train_id else None
    return dict(id=t.id, train_no=t.train_no, name=t.name) if t else None


# ---- inspection list ---------------------------------------------------------------------------------------


def inspection_list(db: Session, p: Principal, *, division_id, date_from: date, date_to: date,
                    train_id: uuid.UUID | None) -> dict:
    divisions = _divisions(p, division_id)
    start, end = _range(date_from, date_to)
    author = aliased(User)
    stmt = (select(Inspection.id, Inspection.device_timestamp, Train.train_no, Train.name, Journey.journey_date,
                   Inspection.coach_code, Inspection.comments, Inspection.phase, Inspection.day, Inspection.round,
                   Inspection.photo_media_id, Inspection.video_media_id, author.name, Inspection.verification_status,
                   Inspection.latitude, Inspection.longitude)
            .join(Journey, Journey.id == Inspection.journey_id).join(Train, Train.id == Journey.train_id)
            .join(author, author.id == Inspection.created_by_id)
            .where(Inspection.division_id.in_(divisions), Inspection.device_timestamp >= start,
                   Inspection.device_timestamp < end))
    if train_id is not None:
        stmt = stmt.where(or_(Journey.train_id == train_id, Journey.linked_train_id == train_id))
    rows = db.execute(stmt.order_by(Inspection.device_timestamp.desc()).limit(MAX_INSPECTIONS + 1)).all()
    items = [dict(id=r[0], at=r[1], train_no=r[2], train_name=r[3], journey_date=r[4], coach_code=r[5], comments=r[6],
                  phase=getattr(r[7], "value", r[7]), day=r[8], round=r[9], photo_media_id=r[10], video_media_id=r[11],
                  inspector=r[12], verification_status=getattr(r[13], "value", r[13]), latitude=r[14], longitude=r[15])
             for r in rows[:MAX_INSPECTIONS]]
    return dict(train=_train_filter_label(db, train_id), truncated=len(rows) > MAX_INSPECTIONS, items=items)


# ---- PSI work statement ------------------------------------------------------------------------------------


def _day_direction(legs) -> callable:
    def direction(day: int) -> int:
        for leg in legs:
            if leg.first_day <= day <= leg.last_day:
                return leg.direction
        return 1
    return direction


def psi_statement(db: Session, p: Principal, *, division_id, date_from: date, date_to: date,
                  train_id: uuid.UUID | None, bank_id: uuid.UUID | None) -> dict:
    """Per journey and coach: the PSI of each direction (1 = outbound, 2 = return) and their average.
    PSI = sum(w * (avg - min) / (max - min)) / sum(w) * 100 over the bank's questions, as in the PSI report."""
    divisions = _divisions(p, division_id)
    journeys = _journeys(db, p, division_id, date_from, date_to, train_id)
    bank = _bank_for(db, divisions, "passenger", bank_id)
    if bank is not None and (not bank.questions or any(q.psi_weight is None for q in bank.questions)):
        raise Conflict("PSI weights are not configured for this question bank", code="psi_not_configured")
    ids = [j.id for j in journeys]
    staff = _staff(db, ids)
    legs = defaultdict(list)
    for leg in db.scalars(select(JourneyLeg).where(JourneyLeg.journey_id.in_(ids))) if ids else []:
        legs[leg.journey_id].append(leg)
    # (journey, coach, day, question) -> (sum, count)
    sums = {}
    if bank is not None and ids:
        for jid, coach, day, qid, total, n in db.execute(
                select(PassengerFeedback.journey_id, PassengerFeedback.coach_code, PassengerFeedback.journey_day,
                       PassengerFeedbackRating.question_id, func.sum(PassengerFeedbackRating.value), func.count())
                .join(PassengerFeedback, PassengerFeedback.id == PassengerFeedbackRating.feedback_id)
                .where(PassengerFeedback.journey_id.in_(ids), PassengerFeedback.bank_id == bank.id,
                       PassengerFeedback.status == PassengerFeedbackStatus.COMPLETED)
                .group_by(PassengerFeedback.journey_id, PassengerFeedback.coach_code, PassengerFeedback.journey_day,
                          PassengerFeedbackRating.question_id)):
            sums[(jid, coach, day, qid)] = (float(total), int(n))
    weights = {q.id: float(q.psi_weight) for q in bank.questions} if bank is not None else {}
    span = float(bank.scale_max - bank.scale_min) if bank is not None else 1.0

    def psi(acc: dict) -> float | None:
        # acc: question -> [sum, count]
        num = den = 0.0
        for qid, (total, n) in acc.items():
            if n and qid in weights:
                num += weights[qid] * ((total / n) - bank.scale_min) / span
                den += weights[qid]
        return round(100 * num / den, 2) if den else None

    by_journey = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0.0, 0])))
    for (jid, coach, day, qid), (total, n) in sums.items():
        direction = _day_direction(legs[jid])(day)
        cell = by_journey[jid][(coach, direction)][qid]
        cell[0] += total
        cell[1] += n
    directions = sorted({leg.direction for ls in legs.values() for leg in ls} | {1})
    if any(j.linked_train_id for j in journeys):
        directions = sorted(set(directions) | {2})
    directions = [d for d in directions if d in (1, 2)]

    out = []
    for j in journeys:
        coaches = sorted(j.coaches, key=lambda c: c.position)
        ac, nac = _coach_split(coaches)
        rows = []
        for i, c in enumerate(coaches, 1):
            values = {d: psi(by_journey[j.id].get((c.code, d), {})) for d in directions}
            present = [v for v in values.values() if v is not None]
            rows.append(dict(sr=i, coach_code=c.code, classification=getattr(c.classification, "value", c.classification),
                             psi={str(d): v for d, v in values.items()},
                             average=round(sum(present) / len(present), 2) if present else None))
        janitors = sum(1 for s in staff.get(j.id, []) if s[3] != RoleId.SUPERVISOR)
        out.append(dict(journey_id=j.id, journey_date=j.journey_date, end_date=j.end_date, train=_train_label(j),
                        train_name=_train_name(j), ac=ac, nac=nac, target_janitors=janitors, coaches=rows))
    return dict(train=_train_filter_label(db, train_id), bank_id=bank.id if bank else None,
                directions=[str(d) for d in directions], journeys=out)


# ---- attendance summary ------------------------------------------------------------------------------------


def attendance_summary(db: Session, p: Principal, *, division_id, date_from: date, date_to: date,
                       train_id: uuid.UUID | None) -> dict:
    """Per journey: every allocated staff member (EHK first, then G1, G2, ...) and whether they marked each
    attendance stage of the journey."""
    journeys = _journeys(db, p, division_id, date_from, date_to, train_id)
    ids = [j.id for j in journeys]
    staff = _staff(db, ids)
    marked = defaultdict(set)
    if ids:
        for jid, emp, stage in db.execute(select(Attendance.journey_id, Attendance.employee_id, Attendance.stage)
                                          .where(Attendance.journey_id.in_(ids)).distinct()):
            marked[(jid, emp)].add(int(stage))
    out = []
    for j in journeys:
        stages = [dict(stage=int(s["stage"]), label=s.get("label") or f"Stage {s['stage']}",
                       station_code=s.get("station_code")) for s in stages_of(j)]
        people, g = [], 0
        for uid, name, emp, role in staff.get(j.id, []):
            if role == RoleId.SUPERVISOR:
                slot = "EHK"
            else:
                g += 1
                slot = f"G{g}"
            done = marked.get((j.id, uid), set())
            people.append(dict(slot=slot, user_id=uid, name=name, emp_id=emp,
                               stages=[s["stage"] in done for s in stages],
                               present=bool(done), complete=all(s["stage"] in done for s in stages)))
        out.append(dict(journey_id=j.id, journey_date=j.journey_date, end_date=j.end_date, train=_train_label(j),
                        train_name=_train_name(j), days=j.duration_days, target=len(people),
                        present=sum(1 for x in people if x["present"]), stages=stages, staff=people))
    return dict(train=_train_filter_label(db, train_id), journeys=out)


# ---- journey report ----------------------------------------------------------------------------------------


def journey_report(db: Session, p: Principal, *, division_id, date_from: date, date_to: date,
                   train_id: uuid.UUID | None) -> dict:
    """Per journey: coaches (AC | non-AC), staff, and done | expected for attendance, passenger feedback and
    inspections. Expected attendance is staff x stages; feedback is the Train Master target of the journey."""
    journeys = _journeys(db, p, division_id, date_from, date_to, train_id)
    ids = [j.id for j in journeys]
    staff = _staff(db, ids)

    def per_journey(stmt):
        return dict(db.execute(stmt).all()) if ids else {}

    att = defaultdict(int)
    if ids:
        for jid, _emp, _stage in db.execute(select(Attendance.journey_id, Attendance.employee_id, Attendance.stage)
                                            .where(Attendance.journey_id.in_(ids)).distinct()):
            att[jid] += 1
    fb = per_journey(select(PassengerFeedback.journey_id, func.count())
                     .where(PassengerFeedback.journey_id.in_(ids), PassengerFeedback.status.in_(COUNTED))
                     .group_by(PassengerFeedback.journey_id))
    fb_target = per_journey(select(JourneyFeedbackTarget.journey_id, func.sum(JourneyFeedbackTarget.required))
                            .where(JourneyFeedbackTarget.journey_id.in_(ids)).group_by(JourneyFeedbackTarget.journey_id))
    insp = per_journey(select(Inspection.journey_id, func.count()).where(Inspection.journey_id.in_(ids))
                       .group_by(Inspection.journey_id))
    out = []
    for i, j in enumerate(sorted(journeys, key=lambda x: x.journey_date, reverse=True), 1):
        coaches = list(j.coaches)
        ac, nac = _coach_split(coaches)
        n_staff = len(staff.get(j.id, []))
        out.append(dict(sr=i, journey_id=j.id, train=_train_label(j), train_name=_train_name(j), ac=ac, nac=nac,
                        journey_date=j.journey_date, end_date=j.end_date, staff=n_staff,
                        attendance_done=int(att.get(j.id, 0)), attendance_expected=n_staff * len(stages_of(j)),
                        feedback_done=int(fb.get(j.id, 0)),
                        feedback_target=int(fb_target[j.id]) if fb_target.get(j.id) is not None else None,
                        inspections_done=int(insp.get(j.id, 0)), inspections_required=_required_inspections(j, len(coaches))))
    return dict(train=_train_filter_label(db, train_id), journeys=out)
