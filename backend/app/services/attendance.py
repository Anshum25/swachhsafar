import hashlib
import json
import uuid

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import AppError, BusinessRuleViolation, Conflict, Forbidden, NotFound
from app.models import (Attendance, FaceEnrollment, FingerprintEnrollment, Journey, MediaKind, StaffAllocation,
                        VerificationStatus)
from app.schemas.common import PageParams
from app.schemas.operations import AttendanceIn, GroupAttendanceIn, ReviewIn
from app.security.principal import Principal
from app.services import security
from app.services import media, route_window
from app.services.common import audit, check_replay, get_or_404, paginate
from app.services.journeys import check_capture_window, get_journey, is_allocated
from app.services.trains import stage_missed, stages_of, window_of
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


def _check_group_photo(db: Session, p: Principal, j: Journey, policy, body: AttendanceIn) -> None:
    """A capture recognised in one photograph of a crew. Allowed only where the division turned it on and
    only from whoever is answerable for the crew, because that is close to all it proves: not that this
    person was watched blinking at the camera, but that a named supervisor pointed the app at a group and
    it recognised them. The employee may not do this for their own attendance -- that would be a record
    with no second party to it at all."""
    if not policy.attendance_group_photo:
        raise BusinessRuleViolation("Group photo attendance is not enabled for this division", code="group_photo_not_allowed")
    if not (j.supervisor_id == p.id or p.has("attendance.review", j.division_id)):
        raise Forbidden("Only the journey supervisor or a reviewer may mark attendance from a group photo",
                        code="group_photo_not_authorized")
    # Where a face was recognised the distance is kept as evidence and still has to be within the
    # division's threshold; where the supervisor named the person themselves there is no distance to judge.
    if body.face_distance is not None:
        # A face recognised in the crew photo counts only if the app watched that face move in 3-D during
        # the preview (GroupPhotoCapture). A printed photo or a screen held up to the camera is flat and
        # never gets "passed", so the app does not send it -- this refuses a client that does anyway.
        if not (body.security and body.security.liveness == "passed"):
            raise BusinessRuleViolation("The face in the group photo was not verified as a live person",
                                        code="liveness_required")
        enrollment = db.get(FaceEnrollment, body.employee_id)
        if enrollment is None or body.face_model != enrollment.model:
            raise BusinessRuleViolation("The group photo match does not refer to this employee's registered face",
                                        code="face_not_verified")
        if body.face_distance > policy.face_match_threshold:
            raise BusinessRuleViolation("The group photo does not match the employee's registered face",
                                        code="face_mismatch",
                                        details={"distance": body.face_distance, "threshold": policy.face_match_threshold})


def _check_identity(db: Session, p: Principal, j: Journey, policy, body: AttendanceIn) -> str | None:
    """How this capture proved who it is, when the division asks for proof at all.

    Face and fingerprint are alternatives, never a replacement for one another: the scanner is a separate
    piece of hardware that can be absent or broken, and a phone without it must still be able to mark
    attendance. A capture that offers a fingerprint is judged on the fingerprint; otherwise on the face.
    Returns "fingerprint", "face", "group_photo" or None (the division asks for neither).
    """
    face_on = policy.attendance_face_verification
    fingerprint_on = policy.attendance_fingerprint_verification
    # Checked whenever the device claims it, even where the division asks for no proof, so the claim is
    # never recorded without the rules that go with it having been applied.
    if body.group_photo:
        _check_group_photo(db, p, j, policy, body)
        return "group_photo"
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


def _payload_hash(body: AttendanceIn) -> str:
    """services.common.payload_hash, leaving out station_code when it is not sent: a capture queued by an app
    from before station-wise attendance hashes as it did then, so its retry is still recognised as a replay."""
    data = body.model_dump(mode="json")
    if data.get("station_code") is None:
        data.pop("station_code", None)
    raw = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _stage_of(j: Journey, stage: int) -> dict:
    stages = stages_of(j)
    if not 1 <= stage <= len(stages):
        raise BusinessRuleViolation(f"This journey has {len(stages)} attendance stages", code="stage_out_of_range",
                                    details={"stages": len(stages)})
    return stages[stage - 1]


def check_route(j: Journey, planned: dict, policy, body: AttendanceIn) -> dict | None:
    """Where the fix is against the stage's stretch of the route (services/route_window). Raises when the
    division blocks attendance outside it; None when the division does not check or the stage has no station."""
    if policy.attendance_route_check == "off" or not planned.get("station_code"):
        return None
    result = route_window.check(window_of(j, planned), body.latitude, body.longitude, body.gps_accuracy_m,
                                policy.attendance_route_tolerance_km)
    if policy.attendance_route_check == "block" and result["status"] not in ("inside", "unknown"):
        raise BusinessRuleViolation(outside_message(planned, result), code="outside_route_window",
                                    details={"stage": planned["stage"], **result})
    return result


def outside_message(planned: dict, result: dict) -> str:
    """Why a fix is outside an attendance's stretch of route (the phone says the same: src/utils/routeWindow.js)."""
    start, end = planned.get("station_name") or planned["label"], planned.get("valid_until_name") or planned["label"]
    if result["status"] == "before":
        return f"This attendance opens at {start}. You are about {result['off_route_km']:g} km before it."
    if result["status"] == "after":
        return f"This attendance was open until {end}. You are about {result['off_route_km']:g} km past it."
    return (f"This attendance can be taken between {start} and {end}. You are about "
            f"{result['off_route_km']:g} km from the train's route there.")


def _may_submit_for(p: Principal, j: Journey, employee_id: uuid.UUID) -> bool:
    return employee_id == p.id or j.supervisor_id == p.id or p.has("attendance.review", j.division_id)


def create(db: Session, p: Principal, body: AttendanceIn, *, sync_op_id: uuid.UUID | None = None,
           commit: bool = True) -> tuple[Attendance, bool]:
    """Returns (record, replayed)."""
    digest = _payload_hash(body)
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

    planned = _stage_of(j, body.stage)
    # The device sends the station it showed. If the office changed this journey's stations after the device
    # last saw them, the capture is refused, not filed under a stage that now means another station.
    if body.station_code is not None and body.station_code.strip().upper() != (planned["station_code"] or ""):
        raise Conflict(f"This journey's attendance stations have changed: stage {body.stage} is now "
                       f"{planned['label']}. Reload the journey and capture again.", code="attendance_plan_changed",
                       details={"stage": body.stage, "station_code": planned["station_code"]})
    previous = {s for s in db.scalars(select(Attendance.stage).where(
        Attendance.journey_id == j.id, Attendance.employee_id == body.employee_id))}
    if body.stage in previous:
        raise Conflict("Attendance already recorded for this stage", code="duplicate_attendance")
    # Stages are taken in order, but a stage the train has already left no longer blocks the ones after it:
    # otherwise one attendance missed at the first station would make every later station unmarkable for the
    # rest of the journey. A missed stage cannot be back-filled either -- the train is gone.
    plan = stages_of(j)
    if stage_missed(j, planned, policy):
        raise BusinessRuleViolation(
            f"This attendance closed when the train left {planned.get('valid_until_name') or planned['label']}",
            code="stage_missed", details={"stage": body.stage})
    skipped = [s["stage"] for s in plan
               if s["stage"] < body.stage and s["stage"] not in previous and not stage_missed(j, s, policy)]
    if skipped:
        raise BusinessRuleViolation(f"Stage {skipped[-1]} must be recorded first", code="stage_order",
                                    details={"recorded_stages": sorted(previous), "pending_stages": skipped})

    verified_by = _check_identity(db, p, j, policy, body)
    # Liveness is a property of the face photo, so it is only asked of a capture verified by face. A photo
    # is still required whenever the face check is what proved identity.
    evidence = security.check_capture(db, p, policy, body, kind="attendance",
                                      liveness_required=verified_by == "face" and policy.face_liveness_required)
    route = check_route(j, planned, policy, body)
    if route and route["status"] not in ("inside", "unknown"):
        evidence["risk_flags"] = [*(evidence["risk_flags"] or []), "outside_route_window"]
    photo_id = media.claim(db, body.photo_media_id, MediaKind.ATTENDANCE_PHOTO,
                           j.division_id, p.id,
                           required=policy.attendance_photo_required or verified_by in ("face", "group_photo"),
                           label="Attendance photo")
    record = Attendance(**body.model_dump(exclude={"photo_media_id", "security", "gps_timestamp", "group_photo", "liveness_proof",
                                                   "station_code"}),
                        station_code=planned["station_code"], stage_label=planned["label"], route_check=route,
                        **evidence, photo_media_id=photo_id, division_id=j.division_id, identified_by=verified_by,
                        created_by_id=p.id, payload_hash=digest, sync_op_id=sync_op_id)
    db.add(record)
    try:
        db.flush()
    except IntegrityError as exc:
        raise Conflict("Attendance already recorded for this stage or photo already used",
                       code="duplicate_attendance") from exc
    audit(db, actor_id=p.id, action="attendance.create", entity=record, division_id=j.division_id,
          changes={"employee_id": body.employee_id, "stage": body.stage, "station": planned["station_code"],
                   "group": body.group_submission_id})
    if commit:
        db.commit()
    return record, False


def create_group(db: Session, p: Principal, body: GroupAttendanceIn) -> list[dict]:
    """Supervisor records attendance for several staff from one capture. Stage progression is per
    employee: each member is recorded at their own stage (the member's, else the group's, else that
    employee's next pending stage), never one stage forced on everyone. Each member succeeds or fails
    independently; create() still refuses skipped and duplicate stages."""
    results = []
    for m in body.members:
        stage = m.stage or body.stage or _member_stage(db, body.journey_id, m.id, m.employee_id)
        if stage is None:
            results.append(dict(id=m.id, employee_id=m.employee_id, outcome="rejected",
                                error={"code": "attendance_complete", "message": "Every attendance stage is already recorded"}))
            continue
        item = AttendanceIn(id=m.id, journey_id=body.journey_id, employee_id=m.employee_id, stage=stage,
                            station_code=m.station_code,
                            photo_media_id=m.photo_media_id, group_submission_id=body.group_submission_id,
                            face_distance=m.face_distance, face_model=m.face_model,
                            fingerprint_score=m.fingerprint_score, fingerprint_matcher=m.fingerprint_matcher,
                            fingerprint_finger=m.fingerprint_finger, group_photo=m.group_photo,
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


def next_stage(db: Session, journey_id: uuid.UUID, employee_id: uuid.UUID) -> int | None:
    """The employee's first stage not yet recorded on this journey, or None when all of them are."""
    j = db.get(Journey, journey_id)
    done = set(db.scalars(select(Attendance.stage).where(
        Attendance.journey_id == journey_id, Attendance.employee_id == employee_id)))
    return next((s["stage"] for s in stages_of(j) if s["stage"] not in done), None) if j else None


def _member_stage(db: Session, journey_id: uuid.UUID, record_id: uuid.UUID, employee_id: uuid.UUID) -> int | None:
    # A retried submission keeps the stage its first delivery was recorded at, so it replays instead of
    # being mistaken for a capture of the following stage.
    existing = db.get(Attendance, record_id)
    if existing is not None and existing.employee_id == employee_id:
        return int(existing.stage)
    return next_stage(db, journey_id, employee_id)


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


def refresh_route(db: Session, p: Principal, journey_id: uuid.UUID, provider) -> dict:
    """Re-read this journey's train timetable when the attendance screen opens, so a route changed under the
    crew is picked up before they capture against the old one (services/timetable.refresh_for_journey, which
    throttles the read and never raises)."""
    from app.services import timetable

    j = get_journey(db, p, journey_id)
    p.require("attendance.read", j.division_id)
    return timetable.refresh_for_journey(db, provider, j)


def journey_status(db: Session, p: Principal, journey_id: uuid.UUID) -> list[dict]:
    j = get_journey(db, p, journey_id)
    p.require("attendance.read", j.division_id)
    allocations = db.scalars(select(StaffAllocation).where(
        StaffAllocation.journey_id == j.id, StaffAllocation.removed_at.is_(None)).order_by(StaffAllocation.role_id)).unique().all()
    taken: dict[uuid.UUID, dict[int, uuid.UUID]] = {}
    for att_id, emp, stage in db.execute(select(Attendance.id, Attendance.employee_id, Attendance.stage).where(Attendance.journey_id == j.id)):
        taken.setdefault(emp, {})[stage] = att_id
    plan = stages_of(j)
    # A stage the train has already left is missed, not still to come: it locks, and the one after it opens
    # (services/trains.stage_missed). Judged per journey, not per employee, since the timetable is the same
    # for everyone on board.
    policy = get_policy(db, j.division_id)
    missed = {s["stage"] for s in plan if stage_missed(j, s, policy)}
    out = []
    for a in allocations:
        done = taken.get(a.user_id, {})
        nxt = next((s["stage"] for s in plan if s["stage"] not in done and s["stage"] not in missed), None)
        cells = [dict({k: v for k, v in s.items() if k != "window"},
                      status="taken" if s["stage"] in done
                      else "missed" if s["stage"] in missed
                      else "next" if s["stage"] == nxt else "locked",
                      attendance_id=done.get(s["stage"])) for s in plan]
        out.append(dict(employee_id=a.user_id, name=a.user.name, emp_id=a.user.emp_id, role_id=a.role_id,
                        stages=cells, completed=nxt is None))
    return out
