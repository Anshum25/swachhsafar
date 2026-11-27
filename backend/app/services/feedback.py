import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.sqlcompat import is_unique_violation
from sqlalchemy.orm import Session, selectinload

from app.config import get_settings
from app.errors import BusinessRuleViolation, Conflict, Forbidden, NotFound, ServiceUnavailable
from app.models import (
    AuditLog,
    CoachClass,
    Journey,
    MediaKind,
    OtpChallenge,
    OtpStatus,
    PassengerFeedback,
    PassengerFeedbackRating,
    PassengerFeedbackStatus,
    PnrStatus,
    Question,
    QuestionBank,
    RailwayFeedback,
    RailwayFeedbackRating,
    User,
    UserStatus,
)
from app.providers.external import PnrProvider, ProviderUnavailable, SmsProvider
from app.services import pnr_cache
from app.schemas.common import PageParams
from app.schemas.feedback import (
    OtpVerify,
    PassengerFeedbackComplete,
    PassengerFeedbackStart,
    QuestionBankCreate,
    Rating,
    RailwayFeedbackIn,
    VoidIn,
)
from app.schemas.operations import ReviewIn
from app.security.principal import Principal
from app.services import feedback_plan, media
from app.services.common import audit, check_replay, get_or_404, paginate, payload_hash
from app.services.inspections import day_is_open
from app.services.journeys import check_capture_window, get_journey, is_allocated
from app.services.policy import get_policy
from app.timeutil import utcnow

COUNTED = (PassengerFeedbackStatus.VERIFIED, PassengerFeedbackStatus.COMPLETED)

# ---- question banks ----------------------------------------------------------------------------------------


def create_bank(db: Session, p: Principal, body: QuestionBankCreate) -> QuestionBank:
    if body.division_id is None:
        if not p.is_super_admin:
            raise Forbidden("Only Super Admin can define default question banks", code="permission_denied")
    else:
        p.require("questions.manage", body.division_id)
    bank = QuestionBank(division_id=body.division_id, audience=body.audience, name=body.name, scale_min=body.scale_min,
                        scale_max=body.scale_max, option_labels=body.option_labels, is_active=False,
                        questions=[Question(position=i, **q.model_dump()) for i, q in enumerate(body.questions, 1)])
    db.add(bank)
    db.flush()
    audit(db, actor_id=p.id, action="question_bank.create", entity=bank, division_id=body.division_id, changes=body.model_dump(mode="json"))
    db.commit()
    return bank


def activate_bank(db: Session, p: Principal, bank_id: uuid.UUID) -> QuestionBank:
    """Banks are immutable versions; activating one retires the previously active bank for the same scope."""
    bank = get_or_404(db, QuestionBank, bank_id, "Question bank")
    if bank.division_id is None:
        if not p.is_super_admin:
            raise Forbidden("Only Super Admin can activate default question banks", code="permission_denied")
    else:
        p.require("questions.manage", bank.division_id)
    scope = QuestionBank.division_id.is_(None) if bank.division_id is None else QuestionBank.division_id == bank.division_id
    db.execute(update(QuestionBank).where(scope, QuestionBank.audience == bank.audience, QuestionBank.id != bank.id)
               .values(is_active=False))
    bank.is_active = True
    audit(db, actor_id=p.id, action="question_bank.activate", entity=bank, division_id=bank.division_id)
    db.commit()
    return bank


def assign_bank(db: Session, p: Principal, bank_id: uuid.UUID, division_ids: list[uuid.UUID]) -> list[QuestionBank]:
    """Use a bank at the given stations: each gets its own copy (same questions and options), made active
    there, retiring that station's previously active bank of the same audience. Ratings already given stay
    on the bank they were answered on."""
    src = get_or_404(db, QuestionBank, bank_id, "Question bank")
    if src.division_id is not None and not p.can_access_division(src.division_id):
        raise Forbidden("Outside your authorized divisions", code="division_forbidden")
    out = []
    for did in dict.fromkeys(division_ids):
        p.require("questions.manage", did)
        db.execute(update(QuestionBank).where(QuestionBank.division_id == did, QuestionBank.audience == src.audience)
                   .values(is_active=False))
        if src.division_id == did:
            src.is_active = True
            out.append(src)
            continue
        copy = QuestionBank(division_id=did, audience=src.audience, name=src.name, scale_min=src.scale_min, scale_max=src.scale_max,
                            option_labels=src.option_labels, is_active=False, questions=[
                                Question(position=q.position, text_en=q.text_en, text_hi=q.text_hi, applies_ac=q.applies_ac,
                                         applies_non_ac=q.applies_non_ac, applies_gen=q.applies_gen, required=q.required,
                                         psi_weight=q.psi_weight) for q in src.questions])
        db.add(copy)
        db.flush()
        copy.is_active = True
        db.flush()
        audit(db, actor_id=p.id, action="question_bank.assign", entity=copy, division_id=did, changes={"from_bank": str(src.id)})
        out.append(copy)
    db.commit()
    return out


def list_banks(db: Session, p: Principal, division_id: uuid.UUID | None) -> list[QuestionBank]:
    stmt = select(QuestionBank).options(selectinload(QuestionBank.questions)).order_by(QuestionBank.created_at.desc())
    if division_id is None:
        stmt = stmt.where(QuestionBank.division_id.is_(None))
    else:
        if not p.can_access_division(division_id):
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        stmt = stmt.where(QuestionBank.division_id == division_id)
    return list(db.scalars(stmt))


def active_bank(db: Session, division_id: uuid.UUID, audience: str) -> QuestionBank:
    for scope in (QuestionBank.division_id == division_id, QuestionBank.division_id.is_(None)):
        bank = db.scalar(select(QuestionBank).where(scope, QuestionBank.audience == audience, QuestionBank.is_active.is_(True)))
        if bank is not None:
            return bank
    raise BusinessRuleViolation(f"No active {audience} question bank is configured", code="no_question_bank")


def applicable(bank: QuestionBank, coach_class: CoachClass | None) -> list[Question]:
    if coach_class is None:
        return list(bank.questions)
    return [q for q in bank.questions if applies_to(q, coach_class)]


def applies_to(q: Question, coach_class: CoachClass) -> bool:
    if coach_class == CoachClass.AC:
        return q.applies_ac
    if coach_class == CoachClass.GEN:
        return q.applies_gen
    return q.applies_non_ac


def _validate_ratings(bank: QuestionBank, coach_class: CoachClass | None, ratings: list[Rating]) -> None:
    questions = {q.id: q for q in applicable(bank, coach_class)}
    unknown = [str(r.question_id) for r in ratings if r.question_id not in questions]
    if unknown:
        raise BusinessRuleViolation("Ratings for questions that do not apply", code="invalid_question", details=unknown)
    missing = [str(qid) for qid, q in questions.items() if q.required and qid not in {r.question_id for r in ratings}]
    if missing:
        raise BusinessRuleViolation("Required questions not rated", code="missing_rating", details=missing)
    bad = [str(r.question_id) for r in ratings if not bank.scale_min <= r.value <= bank.scale_max]
    if bad:
        raise BusinessRuleViolation(f"Ratings must be between {bank.scale_min} and {bank.scale_max}", code="rating_range", details=bad)


# ---- shared checks -----------------------------------------------------------------------------------------


def _require_journey_staff(db: Session, p: Principal, j: Journey) -> None:
    if not (j.supervisor_id == p.id or is_allocated(db, j.id, p.id) or p.has("feedback.review", j.division_id)):
        raise Forbidden("Only journey staff may collect feedback for this journey", code="not_journey_staff")


def _coach(j: Journey, code: str):
    coach = next((c for c in j.coaches if c.code == code), None)
    if coach is None:
        raise BusinessRuleViolation("Coach is not part of this journey", code="unknown_coach")
    return coach


def _load_feedback(db: Session, p: Principal, feedback_id: uuid.UUID, *, for_update: bool = False) -> PassengerFeedback:
    stmt = select(PassengerFeedback).where(PassengerFeedback.id == feedback_id)
    if for_update:
        stmt = stmt.with_for_update()
    fb = db.scalar(stmt)
    if fb is None or not p.can_access_division(fb.division_id):
        raise NotFound("Feedback not found")
    if fb.collected_by_id != p.id and not p.has("feedback.read", fb.division_id):
        raise NotFound("Feedback not found")
    return fb


def _require_collector(p: Principal, fb: PassengerFeedback) -> None:
    if fb.collected_by_id != p.id:
        raise Forbidden("Only the collecting staff member can continue this feedback", code="not_collector")


def _maybe_verified(fb: PassengerFeedback) -> None:
    pnr_ok = fb.pnr_status in (PnrStatus.VALID, PnrStatus.NOT_REQUIRED)
    otp_ok = fb.otp_status in (OtpStatus.VERIFIED, OtpStatus.NOT_REQUIRED)
    if fb.status == PassengerFeedbackStatus.DRAFT and pnr_ok and otp_ok:
        fb.status = PassengerFeedbackStatus.VERIFIED
        fb.verified_at = utcnow()


def _duplicate_checks(db: Session, fb_id: uuid.UUID, journey_id: uuid.UUID, pnr: str | None, mobile: str, feedback_date,
                      coach_code: str, day: int, per_coach_day: int | None) -> None:
    counted = PassengerFeedback.status.in_(COUNTED)
    others = (PassengerFeedback.journey_id == journey_id, PassengerFeedback.id != fb_id, counted)
    if pnr and db.scalar(select(func.count()).where(*others, PassengerFeedback.pnr == pnr)):
        raise Conflict("Feedback already recorded for this PNR on this journey", code="duplicate_pnr")
    if db.scalar(select(func.count()).where(*others, PassengerFeedback.mobile == mobile,
                                            PassengerFeedback.feedback_date == feedback_date)):
        raise Conflict("Feedback already recorded from this mobile today on this journey", code="duplicate_mobile")
    if per_coach_day and db.scalar(select(func.count()).where(*others, PassengerFeedback.coach_code == coach_code,
                                                             PassengerFeedback.journey_day == day)) >= per_coach_day:
        raise Conflict("Feedback limit reached for this coach and day", code="coach_day_limit")


def _commit_transition(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if is_unique_violation(exc):
            raise Conflict("Another verified feedback already uses this PNR or mobile", code="duplicate_feedback") from exc
        raise


# ---- passenger workflow ------------------------------------------------------------------------------------


def start_passenger(db: Session, p: Principal, body: PassengerFeedbackStart) -> tuple[PassengerFeedback, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, PassengerFeedback, body.id, digest, "collected_by_id", p.id)) is not None:
        return existing, True
    j = get_journey(db, p, body.journey_id)
    p.require("feedback.collect", j.division_id)
    _require_journey_staff(db, p, j)
    policy = get_policy(db, j.division_id)
    captured_on = check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)
    coach = _coach(j, body.coach_code)
    if body.journey_day > j.operational_days or not day_is_open(j, body.journey_day, captured_on):
        raise BusinessRuleViolation("Feedback is not open for this journey day", code="day_not_open")
    # Train Master: feedback switched off for the train, or a day outside its collection window.
    if not j.train.feedback_enabled:
        raise BusinessRuleViolation("Passenger feedback is turned off for this train in Train Master",
                                    code="feedback_disabled")
    if not feedback_plan.in_window(j.train, body.journey_day):
        raise BusinessRuleViolation("Train Master does not collect passenger feedback on this journey day",
                                    code="day_outside_window")
    # General (unreserved) coaches have no ticket with a berth: the seat number is asked instead of a PNR, and
    # a PNR sent for one is ignored. Reserved coaches keep the division's PNR policy.
    general = coach.classification == CoachClass.GEN
    if general:
        if not (body.seat_no or "").strip():
            raise BusinessRuleViolation("Seat number is required in a general coach", code="seat_required")
        body = body.model_copy(update={"pnr": None})
    pnr_required = policy.passenger_pnr_required and not general
    if pnr_required and not body.pnr:
        raise BusinessRuleViolation("PNR is required", code="pnr_required")
    if db.scalar(select(User.id).where(User.mobile == body.mobile, User.status != UserStatus.DELETED)):
        raise BusinessRuleViolation("Staff mobile numbers cannot give passenger feedback", code="staff_mobile")
    _duplicate_checks(db, body.id, j.id, body.pnr, body.mobile, captured_on, coach.code, body.journey_day,
                      policy.passenger_feedback_per_coach_day)
    bank = active_bank(db, j.division_id, "passenger")
    day = feedback_plan.day_info(j, body.journey_day)
    fb = PassengerFeedback(
        **body.model_dump(), division_id=j.division_id, bank_id=bank.id, coach_class=coach.classification,
        direction=day["direction"], train_no=day["train_nos"][0] if len(day["train_nos"]) == 1 else None,
        coach_source="selected",
        feedback_date=captured_on, collected_by_id=p.id, payload_hash=digest, status=PassengerFeedbackStatus.DRAFT,
        pnr_status=PnrStatus.PENDING if pnr_required else PnrStatus.NOT_REQUIRED,
        otp_status=OtpStatus.NOT_SENT if policy.passenger_otp_required else OtpStatus.NOT_REQUIRED,
    )
    _maybe_verified(fb)
    db.add(fb)
    db.flush()
    audit(db, actor_id=p.id, action="feedback.passenger.start", entity=fb, division_id=j.division_id,
          changes={"coach": fb.coach_code, "day": fb.journey_day, "pnr_status": fb.pnr_status, "otp_status": fb.otp_status})
    _commit_transition(db)
    return fb, False


def verify_pnr(db: Session, p: Principal, provider: PnrProvider, feedback_id: uuid.UUID) -> PassengerFeedback:
    """Checks the PNR with the provider (RapidAPI) and matches the ticket to the journey: its train is one
    running on the feedback day, its date falls on that train's leg, its stations are on that leg's route
    and in order, and its coach is one of the journey's. When the ticket names a coach of this journey that
    differs from the coach card picked, the feedback moves to the ticket's coach (coach_source = "pnr")
    rather than being voided. Nothing is guessed: what the provider does not return is not checked."""
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.status != PassengerFeedbackStatus.DRAFT or fb.pnr_status != PnrStatus.PENDING:
        raise BusinessRuleViolation("PNR verification is not pending for this feedback", code="invalid_state")
    j = db.get(Journey, fb.journey_id)
    policy = get_policy(db, fb.division_id)
    try:
        result = pnr_cache.lookup(db, provider, fb.pnr)  # stored answer while fresh, else RailRadar -> RapidAPI
    except ProviderUnavailable as exc:
        _record_outage(db, p, fb, "feedback.passenger.pnr_unavailable", exc)
        # the provider's reason (never the PNR or the key) so the collector can tell "switched off" from "down"
        raise ServiceUnavailable(f"PNR service unavailable: {str(exc)[:200]}. Feedback remains pending",
                                 code="pnr_unavailable") from exc

    match = match_pnr(j, fb, result, policy)
    reason = match["reason"]
    if reason is None and match["coach"] != fb.coach_code:
        reason = _move_coach(db, j, fb, match["coach"], policy)
    fb.pnr_checked_at = utcnow()
    fb.pnr_details = _pnr_details(result, match)
    if result.found:
        fb.pnr_journey_date = result.journey_date
        fb.boarding_code = result.boarding_code or result.from_code
        fb.alighting_code = result.alighting_code
        _store_ticket(fb, result)
    if reason:
        fb.pnr_status = PnrStatus.INVALID
        fb.status = PassengerFeedbackStatus.VOID
        fb.void_reason = reason
    else:
        fb.pnr_status = PnrStatus.VALID
        fb.train_no = match["train_no"]
        fb.direction = match["direction"] or fb.direction
        fb.coach_verified = match["coach_verified"]
        if match["berth"] and not fb.seat_no:
            fb.seat_no = match["berth"][:10]  # from the ticket, only where staff left it empty
        _maybe_verified(fb)
    audit(db, actor_id=p.id, action="feedback.passenger.pnr", entity=fb, division_id=fb.division_id,
          changes={"pnr_status": fb.pnr_status, "reason": reason, "coach_source": fb.coach_source,
                   "coach_verified": fb.coach_verified, "checks": match["checks"]})
    _commit_transition(db)
    return fb


def _record_outage(db: Session, p: Principal, fb: PassengerFeedback, action: str, exc: Exception) -> None:
    """A provider that could not answer leaves the feedback as it was; the outage itself is logged (for the
    verification failure report) in its own transaction. The reason names the failure, never the PNR."""
    fb_id, division_id = fb.id, fb.division_id
    db.rollback()
    db.add(AuditLog(actor_id=p.id, division_id=division_id, action=action, entity_type="passenger_feedback",
                    entity_id=str(fb_id), changes={"reason": str(exc)[:120]}))
    db.commit()


def _norm(code: str | None) -> str:
    return (code or "").replace(" ", "").upper()


def match_pnr(j: Journey, fb: PassengerFeedback, result, policy) -> dict:
    """How a PNR result fits the journey (pure). reason = None when it fits. checks records what was and was
    not checked (a field the provider did not return is "unknown", never assumed)."""
    out = dict(reason=None, train_no=None, direction=None, coach=fb.coach_code, coach_verified=False, berth=None,
               checks={})
    checks = out["checks"]
    if not result.found:
        out["reason"] = "PNR not found"
        return out
    if result.train_cancelled:
        out["reason"] = "The train is cancelled on this PNR's date"
        return out
    if result.all_cancelled:
        out["reason"] = "The ticket on this PNR is cancelled"
        return out
    # The train: one that runs on the feedback day (its leg), else any train of the journey (layover days and
    # journeys without legs use the older rule, pnr_train_day_mapping).
    info = feedback_plan.day_info(j, fb.journey_day)
    expected = set(info["train_nos"]) or _expected_train_numbers(j, fb.journey_day, policy.pnr_train_day_mapping)
    if result.train_number not in expected:
        out["reason"] = "PNR is for a different train"
        checks["train"] = "mismatch"
        return out
    checks["train"] = "ok"
    out["train_no"] = result.train_number
    leg = feedback_plan.leg_for(j, result.train_number)
    if leg is not None:
        out["direction"] = leg["direction"]
    # The date: the ticket's journey date is the boarding date, which falls on the leg's run.
    if result.journey_date is None or leg is None:
        checks["date"] = "unknown"
    elif not (leg["departs_on"] <= result.journey_date <= leg["arrives_on"]):
        out["reason"] = "PNR is for another date of this train"
        checks["date"] = "mismatch"
        return out
    elif fb.feedback_date < result.journey_date:
        out["reason"] = "The passenger boards after the feedback date"
        checks["date"] = "mismatch"
        return out
    else:
        checks["date"] = "ok"
    # The stations: boarding before alighting, both on the leg's route (a station on it twice may match either).
    board, alight = result.boarding_code or result.from_code, result.alighting_code
    codes = [s.get("code") for s in (leg or {}).get("stops") or []]
    if not codes or not board or not alight:
        checks["stations"] = "unknown"
    else:
        firsts = [i for i, c in enumerate(codes) if c == board]
        lasts = [i for i, c in enumerate(codes) if c == alight]
        if not firsts or not lasts or min(firsts) >= max(lasts):
            out["reason"] = "PNR stations are not on this train's route"
            checks["stations"] = "mismatch"
            return out
        checks["stations"] = "ok"
    # The coach: the passenger's allocation (current, else booking), live passengers only.
    live = [x for x in result.passengers if not x.cancelled]
    coaches = list(dict.fromkeys(x.coach for x in live if x.coach)) or sorted(result.coach_ids)
    journey_coaches = {_norm(c.code): c.code for c in j.coaches}
    if _norm(fb.coach_code) in {_norm(c) for c in coaches}:
        out["coach_verified"] = True
        checks["coach"] = "ok"
    elif on_journey := [journey_coaches[_norm(c)] for c in coaches if _norm(c) in journey_coaches]:
        out["coach"], out["coach_verified"] = on_journey[0], True
        checks["coach"] = "moved"
    elif coaches:
        checks["coach"] = "mismatch"
        if policy.pnr_coach_match_required:
            out["reason"] = "PNR coach does not match"
            return out
    else:
        checks["coach"] = "unknown"
        if policy.pnr_coach_match_required:
            out["reason"] = ("The ticket is waitlisted, not confirmed" if result.all_waitlisted
                             else "PNR coach does not match")
            return out
    seat = next((x for x in live if x.coach and _norm(x.coach) == _norm(out["coach"])), None)
    out["berth"] = seat.berth if seat is not None else None
    return out


def _move_coach(db: Session, j: Journey, fb: PassengerFeedback, code: str, policy) -> str | None:
    """Put the feedback on the coach its ticket names. Refused (returns a reason) when that coach's limit for
    the day is already reached."""
    coach = _coach(j, code)
    limit = policy.passenger_feedback_per_coach_day
    if limit and db.scalar(select(func.count()).where(
            PassengerFeedback.journey_id == j.id, PassengerFeedback.id != fb.id, PassengerFeedback.status.in_(COUNTED),
            PassengerFeedback.coach_code == coach.code, PassengerFeedback.journey_day == fb.journey_day)) >= limit:
        return f"Feedback limit reached for coach {coach.code} (the coach on the ticket) on this day"
    if coach.classification != fb.coach_class:
        fb.coach_class = coach.classification  # ratings come later, on the questions of the right class
    fb.coach_code, fb.coach_source = coach.code, "pnr"
    return None


def ticket_line(result, coach_code: str | None):
    """The ticket's passenger line for this feedback: the one in the feedback's coach, else the first line still
    on the ticket (a PNR carries several passengers but no names)."""
    live = [x for x in result.passengers if not x.cancelled]
    return next((x for x in live if x.coach and _norm(x.coach) == _norm(coach_code or "")), None) or next(iter(live), None)


def _store_ticket(fb: PassengerFeedback, result) -> None:
    """The ticket in its own columns (alongside pnr_details): train name, class, chart, and the passenger line's
    status, coach and berth, e.g. CNF/A1/17/SL."""
    line = ticket_line(result, fb.coach_code)
    fb.pnr_train_name = (result.train_name or "")[:60] or None
    fb.pnr_class = (result.journey_class or "")[:5] or None
    fb.pnr_chart_prepared = result.chart_prepared if result.chart_status else None
    fb.pnr_source = (result.source or "")[:12] or None
    fb.pnr_coach = (line.coach or "")[:10] or None if line else None
    fb.pnr_berth_no = line.berth_no if line else None
    fb.pnr_berth_code = (line.berth_code or "")[:4] or None if line else None
    status = "/".join(str(x) for x in (line.status, line.coach, line.berth_no, line.berth_code) if x) if line else ""
    fb.pnr_booking_status = status[:40] or None


def _pnr_details(result, match: dict) -> dict:
    """What is kept of the provider's answer: train, date, stations, class, chart and each passenger's status,
    coach and berth. The provider returns no passenger names; nothing personal beyond the ticket is stored."""
    return {
        "found": result.found, "source": result.source,
        "train_number": result.train_number, "train_name": result.train_name,
        "coach_ids": sorted(result.coach_ids), "status": result.status_text,
        "journey_date": result.journey_date.isoformat() if result.journey_date else None,
        "boarding": result.boarding_code, "from": result.from_code, "to": result.to_code, "upto": result.upto_code,
        "class": result.journey_class, "chart_status": result.chart_status, "train_cancelled": result.train_cancelled,
        "passengers": [dict(serial=x.serial, status=x.status, coach=x.coach, berth=x.berth) for x in result.passengers],
        "matched_coach": match["coach"] if not match["reason"] else None, "berth": match["berth"],
        "direction": match["direction"], "checks": match["checks"],
    }


def _expected_train_numbers(j: Journey, day: int, day_mapping: bool) -> set[str]:
    def numbers(train) -> set[str]:
        return {n.strip() for n in train.train_no.split("/")} if train else set()

    main, linked = numbers(j.train), numbers(j.linked_train)
    if not day_mapping or not linked:
        return main | linked
    return main if day <= (j.operational_days + 1) // 2 else linked


def _otp_hash(feedback_id: uuid.UUID, code: str) -> str:
    pepper = get_settings().otp_pepper.get_secret_value().encode()
    return hmac.new(pepper, f"{feedback_id}:{code}".encode(), hashlib.sha256).hexdigest()


def send_otp(db: Session, p: Principal, sms: SmsProvider, feedback_id: uuid.UUID) -> dict:
    settings = get_settings()
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.status != PassengerFeedbackStatus.DRAFT or fb.otp_status not in (OtpStatus.NOT_SENT, OtpStatus.SENT):
        raise BusinessRuleViolation("OTP cannot be sent in the current state", code="invalid_state")
    # The mobile number is verified first, then the PNR (either order is accepted: both must pass before the
    # feedback counts, and verification is always decided here, never by what the device reports).
    now = utcnow()
    challenge = db.scalar(select(OtpChallenge).where(OtpChallenge.feedback_id == fb.id))
    if challenge is not None:
        if challenge.send_count >= settings.otp_max_sends:
            raise BusinessRuleViolation("OTP resend limit reached", code="otp_send_limit")
        wait_until = challenge.last_sent_at + timedelta(seconds=settings.otp_resend_cooldown_seconds)
        if now < wait_until:
            raise BusinessRuleViolation("Please wait before requesting another OTP", code="otp_cooldown",
                                        details={"resend_available_at": wait_until.isoformat()})
    code = f"{secrets.randbelow(1_000_000):06d}"
    master_only = settings.feedback_master_otp is not None and not getattr(sms, "enabled", True)
    try:
        if not master_only:
            sms.send_otp(fb.mobile, code)
    except ProviderUnavailable as exc:
        _record_outage(db, p, fb, "feedback.passenger.sms_unavailable", exc)
        raise ServiceUnavailable("SMS service unavailable; try again later", code="sms_unavailable") from exc
    expires = now + timedelta(seconds=settings.otp_ttl_seconds)
    if challenge is None:
        challenge = OtpChallenge(feedback_id=fb.id, mobile=fb.mobile, code_hash=_otp_hash(fb.id, code), expires_at=expires,
                                 attempts=0, send_count=1, last_sent_at=now)
        db.add(challenge)
    else:
        challenge.code_hash = _otp_hash(fb.id, code)
        challenge.expires_at = expires
        challenge.attempts = 0
        challenge.send_count += 1
        challenge.last_sent_at = now
    fb.otp_status = OtpStatus.SENT
    audit(db, actor_id=p.id, action="feedback.passenger.otp_sent", entity=fb, division_id=fb.division_id,
          changes={"send_count": challenge.send_count, "sms_skipped_master_otp": master_only})
    db.commit()
    return dict(otp_status=fb.otp_status, expires_at=expires,
                resend_available_at=now + timedelta(seconds=settings.otp_resend_cooldown_seconds),
                sends_remaining=settings.otp_max_sends - challenge.send_count, mobile_masked=fb.mobile_masked)


def verify_otp(db: Session, p: Principal, feedback_id: uuid.UUID, body: OtpVerify) -> PassengerFeedback:
    settings = get_settings()
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.otp_status != OtpStatus.SENT or fb.status != PassengerFeedbackStatus.DRAFT:
        raise BusinessRuleViolation("No OTP is awaiting verification", code="invalid_state")
    challenge = db.scalar(select(OtpChallenge).where(OtpChallenge.feedback_id == fb.id).with_for_update())
    if utcnow() > challenge.expires_at:
        raise BusinessRuleViolation("OTP expired; request a new one", code="otp_expired")
    challenge.attempts += 1
    master = settings.feedback_master_otp
    via_master = master is not None and hmac.compare_digest(master.get_secret_value(), body.code)
    if not via_master and not hmac.compare_digest(challenge.code_hash, _otp_hash(fb.id, body.code)):
        if challenge.attempts >= settings.otp_max_attempts:
            fb.otp_status = OtpStatus.LOCKED
            fb.status = PassengerFeedbackStatus.VOID
            fb.void_reason = "Too many incorrect OTP attempts"
        audit(db, actor_id=p.id, action="feedback.passenger.otp_failed", entity=fb, division_id=fb.division_id,
              changes={"attempts": challenge.attempts})
        db.commit()
        if fb.otp_status == OtpStatus.LOCKED:
            raise BusinessRuleViolation("Too many incorrect attempts; feedback voided", code="otp_locked")
        raise BusinessRuleViolation("Incorrect OTP", code="otp_invalid",
                                    details={"attempts_remaining": settings.otp_max_attempts - challenge.attempts})
    challenge.verified_at = utcnow()
    fb.otp_status = OtpStatus.VERIFIED
    _maybe_verified(fb)
    audit(db, actor_id=p.id, action="feedback.passenger.otp_verified", entity=fb, division_id=fb.division_id,
          changes={"via": "master_otp" if via_master else "sms"})
    _commit_transition(db)
    return fb


def complete_passenger(db: Session, p: Principal, feedback_id: uuid.UUID, body: PassengerFeedbackComplete) -> PassengerFeedback:
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    _require_collector(p, fb)
    if fb.status == PassengerFeedbackStatus.COMPLETED:
        if sorted((r.question_id, r.value) for r in fb.ratings) == sorted((r.question_id, r.value) for r in body.ratings):
            return fb  # idempotent replay
        raise Conflict("Feedback already completed", code="already_completed")
    if fb.status != PassengerFeedbackStatus.VERIFIED:
        raise BusinessRuleViolation("Feedback must be verified before ratings are submitted", code="not_verified",
                                    details={"pnr_status": fb.pnr_status, "otp_status": fb.otp_status})
    bank = db.get(QuestionBank, fb.bank_id)
    _validate_ratings(bank, fb.coach_class, body.ratings)
    fb.voice_media_id = media.claim(db, body.voice_media_id, MediaKind.FEEDBACK_VOICE, fb.division_id, p.id,
                                    required=False, label="Voice recording")
    fb.ratings = [PassengerFeedbackRating(question_id=r.question_id, value=r.value) for r in body.ratings]
    fb.comments = body.comments
    fb.status = PassengerFeedbackStatus.COMPLETED
    fb.completed_at = utcnow()
    audit(db, actor_id=p.id, action="feedback.passenger.complete", entity=fb, division_id=fb.division_id)
    _commit_transition(db)
    return fb


def void_passenger(db: Session, p: Principal, feedback_id: uuid.UUID, body: VoidIn) -> PassengerFeedback:
    fb = _load_feedback(db, p, feedback_id, for_update=True)
    if fb.status == PassengerFeedbackStatus.VOID:
        return fb
    own_draft = fb.collected_by_id == p.id and fb.status == PassengerFeedbackStatus.DRAFT
    if not own_draft:
        p.require("feedback.review", fb.division_id)
    audit(db, actor_id=p.id, action="feedback.passenger.void", entity=fb, division_id=fb.division_id,
          changes={"from": fb.status, "reason": body.reason})
    fb.status = PassengerFeedbackStatus.VOID
    fb.void_reason = body.reason
    db.commit()
    return fb


def get_passenger(db: Session, p: Principal, feedback_id: uuid.UUID) -> PassengerFeedback:
    return _load_feedback(db, p, feedback_id)


def list_passenger(db: Session, p: Principal, params: PageParams, *, journey_id, status, coach_code, journey_day):
    divisions = p.require_any_division("feedback.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = (select(PassengerFeedback).options(selectinload(PassengerFeedback.ratings))
            .join(Journey, Journey.id == PassengerFeedback.journey_id)
            .where(PassengerFeedback.division_id.in_(divisions),
                   or_(PassengerFeedback.division_id.in_(full), PassengerFeedback.collected_by_id == p.id,
                       Journey.supervisor_id == p.id)))
    for col, val in ((PassengerFeedback.journey_id, journey_id), (PassengerFeedback.status, status),
                     (PassengerFeedback.coach_code, coach_code), (PassengerFeedback.journey_day, journey_day)):
        if val is not None:
            stmt = stmt.where(col == val)
    return paginate(db, stmt.order_by(PassengerFeedback.server_timestamp.desc(), PassengerFeedback.id), params)


# ---- railway workflow --------------------------------------------------------------------------------------


def create_railway(db: Session, p: Principal, body: RailwayFeedbackIn, *, commit: bool = True) -> tuple[RailwayFeedback, bool]:
    digest = payload_hash(body)
    if (existing := check_replay(db, RailwayFeedback, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True
    j = get_journey(db, p, body.journey_id, for_update=True)  # lock serialises the per-journey limit check
    p.require("feedback.railway.submit", j.division_id)
    _require_journey_staff(db, p, j)
    policy = get_policy(db, j.division_id)
    captured_on = check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)
    if body.journey_day > j.operational_days or not day_is_open(j, body.journey_day, captured_on):
        raise BusinessRuleViolation("Feedback is not open for this journey day", code="day_not_open")
    coach_class = _coach(j, body.coach_code).classification if body.coach_code else None
    used = db.scalar(select(func.count()).where(RailwayFeedback.journey_id == j.id,
                                                RailwayFeedback.verification_status != "rejected"))
    if used >= policy.railway_feedback_limit_per_journey:
        raise Conflict(f"Railway feedback limit ({policy.railway_feedback_limit_per_journey}) reached for this journey",
                       code="railway_feedback_limit")
    bank = active_bank(db, j.division_id, "railway")
    _validate_ratings(bank, coach_class, body.ratings)
    fb = RailwayFeedback(**body.model_dump(exclude={"ratings"}), division_id=j.division_id, bank_id=bank.id,
                         created_by_id=p.id, payload_hash=digest,
                         ratings=[RailwayFeedbackRating(question_id=r.question_id, value=r.value) for r in body.ratings])
    db.add(fb)
    db.flush()
    audit(db, actor_id=p.id, action="feedback.railway.create", entity=fb, division_id=j.division_id,
          changes={"railway_employee_id": body.railway_employee_id, "day": body.journey_day})
    if commit:
        db.commit()
    return fb, False


def review_railway(db: Session, p: Principal, feedback_id: uuid.UUID, body: ReviewIn) -> RailwayFeedback:
    fb = get_or_404(db, RailwayFeedback, feedback_id, "Feedback")
    p.require("feedback.review", fb.division_id)
    if fb.created_by_id == p.id:
        raise Forbidden("You cannot review feedback you recorded", code="self_review")
    audit(db, actor_id=p.id, action="feedback.railway.review", entity=fb, division_id=fb.division_id,
          changes={"status": {"from": fb.verification_status, "to": body.status.value}, "remarks": body.remarks})
    fb.verification_status = body.status.value
    fb.verified_by_id = p.id
    fb.verified_at = utcnow()
    db.commit()
    return fb


def list_railway(db: Session, p: Principal, params: PageParams, *, journey_id):
    divisions = p.require_any_division("feedback.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = (select(RailwayFeedback).options(selectinload(RailwayFeedback.ratings))
            .join(Journey, Journey.id == RailwayFeedback.journey_id)
            .where(RailwayFeedback.division_id.in_(divisions),
                   or_(RailwayFeedback.division_id.in_(full), RailwayFeedback.created_by_id == p.id, Journey.supervisor_id == p.id)))
    if journey_id:
        stmt = stmt.where(RailwayFeedback.journey_id == journey_id)
    return paginate(db, stmt.order_by(RailwayFeedback.server_timestamp.desc(), RailwayFeedback.id), params)

