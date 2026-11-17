import uuid

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError, BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import (Attendance, AttendanceStage, FaceEnrollment, FingerprintEnrollment, Journey, MediaKind,
                        StaffAllocation, VerificationStatus)
from app.schemas.common import PageParams
from app.schemas.operations import AttendanceIn, GroupAttendanceIn, ReviewIn
from app.security.principal import Principal
from app.services import security
from app.services import media
from app.services.common import audit, check_replay, get_or_404, paginate, payload_hash
from app.services.journeys import check_capture_window, get_journey, is_allocated
from app.services.policy import get_policy
from app.timeutil import utcnow


def _check_face(db: Session, policy, body: AttendanceIn) -> None:
    """Division requires face verification: the employee must have registered faces and the device must have
    matched the photo against them with the same model, within the division's threshold."""
    enrollment = db.get(FaceEnrollment, body.employee_id)
    if enrollment is None:
        raise BusinessRuleViolation("No registered face for this employee; an administrator must register it first",
                                    code="face_not_enrolled")
    if body.face_distance is None or body.face_model != enrollment.model:
        raise BusinessRuleViolation("Face verification is required for attendance in this division", code="face_not_verified")
    if body.face_distance > policy.face_match_threshold:
        raise BusinessRuleViolation("The attendance photo does not match the employee's registered face",
                                    code="face_mismatch", details={"distance": body.face_distance, "threshold": policy.face_match_threshold})


def _check_fingerprint(db: Session, policy, body: AttendanceIn) -> None:
    """Division accepts fingerprint verification: the employee must have registered fingerprints and the
    device must have matched a finger against them with the same matcher, at or above the division's score."""
    enrollment = db.get(FingerprintEnrollment, body.employee_id)
    if enrollment is None:
        raise BusinessRuleViolation("No registered fingerprints for this employee; an administrator must register them first",
                                    code="fingerprint_not_enrolled")
    if body.fingerprint_matcher != enrollment.matcher:
        raise BusinessRuleViolation("Fingerprint verification is required for attendance in this division",
                                    code="fingerprint_not_verified")
    if body.fingerprint_score < policy.fingerprint_match_score:
        raise BusinessRuleViolation("The fingerprint does not match the employee's registered fingerprints",
                                    code="fingerprint_mismatch",
                                    details={"score": body.fingerprint_score, "required": policy.fingerprint_match_score})


def _check_identity(db: Session, policy, body: AttendanceIn) -> str | None:
    """How this capture proved who it is, when the division asks for proof at all.

    Face and fingerprint are alternatives, never a replacement for one another: the scanner is a separate
    piece of hardware that can be absent or broken, and a phone without it must still be able to mark
    attendance. A capture that offers a fingerprint is judged on the fingerprint; otherwise on the face.
    Returns "fingerprint", "face" or None (the division asks for neither).
    """
    face_on = policy.attendance_face_verification
    fingerprint_on = policy.attendance_fingerprint_verification
    if not face_on and not fingerprint_on:
        return None
    if fingerprint_on and body.fingerprint_score is not None:
        _check_fingerprint(db, policy, body)
        return "fingerprint"
    if face_on:
        _check_face(db, policy, body)
        return "face"
    raise BusinessRuleViolation("Fingerprint verification is required for attendance in this division",
                                code="fingerprint_not_verified")


def _may_submit_for(p: Principal, j: Journey, employee_id: uuid.UUID) -> bool:
    return employee_id == p.id or j.supervisor_id == p.id or p.has("attendance.review", j.division_id)


def create(db: Session, p: Principal, body: AttendanceIn, *, sync_op_id: uuid.UUID | None = None,
           commit: bool = True) -> tuple[Attendance, bool]:
    """Returns (record, replayed)."""
    digest = payload_hash(body)
    if (existing := check_replay(db, Attendance, body.id, digest, "created_by_id", p.id)) is not None:
        return existing, True

    j = get_journey(db, p, body.journey_id, for_update=False)
    p.require("attendance.submit", j.division_id)
    policy = get_policy(db, j.division_id)
    check_capture_window(j, body.device_timestamp, policy.attendance_late_grace_days)
    if not is_allocated(db, j.id, body.employee_id):
        raise BusinessRuleViolation("Employee is not allocated to this journey", code="not_allocated")
    if not _may_submit_for(p, j, body.employee_id):
        raise Forbidden("Only the employee, the journey supervisor or a reviewer may record this attendance",
                        code="not_authorized_for_employee")

    previous = {s for s in db.scalars(select(Attendance.stage).where(
        Attendance.journey_id == j.id, Attendance.employee_id == body.employee_id))}
    if body.stage in previous:
        raise Conflict("Attendance already recorded for this stage", code="duplicate_attendance")
    if body.stage > AttendanceStage.SOURCE and body.stage - 1 not in previous:
        raise BusinessRuleViolation(f"Stage {body.stage - 1} must be recorded first", code="stage_order",
                                    details={"recorded_stages": sorted(previous)})

    verified_by = _check_identity(db, policy, body)
    # Liveness is a property of the face photo, so it is only asked of a capture verified by face. A photo
    # is still required whenever the face check is what proved identity.
    evidence = security.check_capture(db, p, policy, body, kind="attendance",
                                      liveness_required=verified_by == "face" and policy.face_liveness_required)
    photo_id = media.claim(db, body.photo_media_id, MediaKind.ATTENDANCE_PHOTO,
                           j.division_id, p.id, required=policy.attendance_photo_required or verified_by == "face",
                           label="Attendance photo")
    record = Attendance(**body.model_dump(exclude={"photo_media_id", "security", "gps_timestamp"}), **evidence,
                        photo_media_id=photo_id, division_id=j.division_id,
                        created_by_id=p.id, payload_hash=digest, sync_op_id=sync_op_id)
    db.add(record)
    try:
        db.flush()
    except IntegrityError as exc:
        raise Conflict("Attendance already recorded for this stage or photo already used",
                       code="duplicate_attendance") from exc
    audit(db, actor_id=p.id, action="attendance.create", entity=record, division_id=j.division_id,
          changes={"employee_id": body.employee_id, "stage": body.stage, "group": body.group_submission_id})
    if commit:
        db.commit()
    return record, False


def create_group(db: Session, p: Principal, body: GroupAttendanceIn) -> list[dict]:
    """Supervisor records one stage for several staff. Each member succeeds or fails independently."""
    results = []
    for m in body.members:
        item = AttendanceIn(id=m.id, journey_id=body.journey_id, employee_id=m.employee_id, stage=body.stage,
                            photo_media_id=m.photo_media_id, group_submission_id=body.group_submission_id,
                            face_distance=m.face_distance, face_model=m.face_model,
                            fingerprint_score=m.fingerprint_score, fingerprint_matcher=m.fingerprint_matcher,
                            fingerprint_finger=m.fingerprint_finger,
                            device_timestamp=body.device_timestamp, latitude=body.latitude, longitude=body.longitude,
                            gps_accuracy_m=body.gps_accuracy_m, gps_timestamp=body.gps_timestamp,
                            security=body.security.model_copy(update={"liveness": m.liveness}) if body.security else None)
        savepoint = db.begin_nested()
        try:
            record, replayed = create(db, p, item, commit=False)
            savepoint.commit()
            results.append(dict(id=m.id, employee_id=m.employee_id, outcome="replayed" if replayed else "created", record=record))
        except AppError as exc:
            savepoint.rollback()
            results.append(dict(id=m.id, employee_id=m.employee_id, outcome="rejected",
                                error={"code": exc.code, "message": exc.message}))
    db.commit()
    return results


def review(db: Session, p: Principal, attendance_id: uuid.UUID, body: ReviewIn) -> Attendance:
    record = get_or_404(db, Attendance, attendance_id, "Attendance")
    p.require("attendance.review", record.division_id)
    if record.created_by_id == p.id:
        raise Forbidden("You cannot review attendance you recorded", code="self_review")
    audit(db, actor_id=p.id, action="attendance.review", entity=record, division_id=record.division_id,
          changes={"status": {"from": record.verification_status, "to": body.status}, "remarks": body.remarks})
    record.verification_status = VerificationStatus(body.status)
    record.verified_by_id = p.id
    record.verified_at = utcnow()
    record.review_remarks = body.remarks
    db.commit()
    return record


def get(db: Session, p: Principal, attendance_id: uuid.UUID) -> Attendance:
    record = db.get(Attendance, attendance_id)
    if record is None or not _readable(db, p, record):
        raise NotFound("Attendance not found")
    return record


def _readable(db: Session, p: Principal, record: Attendance) -> bool:
    if not p.has("attendance.read", record.division_id):
        return False
    if p.has("journeys.read_all", record.division_id) or record.employee_id == p.id or record.created_by_id == p.id:
        return True
    return db.get(Journey, record.journey_id).supervisor_id == p.id


def list_records(db: Session, p: Principal, params: PageParams, *, journey_id, employee_id, stage, date_from, date_to,
                 verification_status):
    divisions = p.require_any_division("attendance.read")
    full = [d for d in divisions if p.has("journeys.read_all", d)]
    stmt = select(Attendance).join(Journey, Journey.id == Attendance.journey_id).where(
        Attendance.division_id.in_(divisions),
        or_(Attendance.division_id.in_(full), Attendance.employee_id == p.id, Attendance.created_by_id == p.id,
            Journey.supervisor_id == p.id),
    )
    for col, val in ((Attendance.journey_id, journey_id), (Attendance.employee_id, employee_id), (Attendance.stage, stage),
                     (Attendance.verification_status, verification_status)):
        if val is not None:
            stmt = stmt.where(col == val)
    if date_from:
        stmt = stmt.where(Attendance.device_timestamp >= date_from)
    if date_to:
        stmt = stmt.where(Attendance.device_timestamp < date_to)
    return paginate(db, stmt.order_by(Attendance.device_timestamp.desc(), Attendance.id), params)


def journey_status(db: Session, p: Principal, journey_id: uuid.UUID) -> list[dict]:
    j = get_journey(db, p, journey_id)
    p.require("attendance.read", j.division_id)
    allocations = db.scalars(select(StaffAllocation).where(
        StaffAllocation.journey_id == j.id, StaffAllocation.removed_at.is_(None)).order_by(StaffAllocation.role_id)).unique().all()
    taken: dict[uuid.UUID, dict[int, uuid.UUID]] = {}
    for att_id, emp, stage in db.execute(select(Attendance.id, Attendance.employee_id, Attendance.stage).where(Attendance.journey_id == j.id)):
        taken.setdefault(emp, {})[stage] = att_id
    out = []
    for a in allocations:
        done = taken.get(a.user_id, {})
        nxt = next((s for s in AttendanceStage if s not in done), None)
        cells = [dict(stage=int(s), status="taken" if s in done else ("next" if s == nxt else "locked"),
                      attendance_id=done.get(s)) for s in AttendanceStage]
        out.append(dict(employee_id=a.user_id, name=a.user.name, emp_id=a.user.emp_id, role_id=a.role_id,
                        stages=cells, completed=nxt is None))
    return out
