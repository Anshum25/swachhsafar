"""Face registration for attendance verification. Only descriptors are stored (computed on the device),
never photos; every change is audited without the descriptors themselves."""
import uuid

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.errors import NotFound
from app.models import FaceEnrollment, Journey, StaffAllocation, User, UserStatus
from app.schemas.faces import FaceEnrollIn, FaceStatusOut
from app.security.principal import Principal
from app.services.common import audit, get_or_404
from app.services.org import _assert_manageable, _visible
from app.services.policy import get_policy
from app.sqlcompat import days_ago_date
from app.timeutil import utcnow


def _user(db: Session, user_id: uuid.UUID) -> User:
    user = get_or_404(db, User, user_id, "User")
    if user.status == UserStatus.DELETED:
        raise NotFound("User not found")
    return user


def status(db: Session, p: Principal, user_id: uuid.UUID) -> FaceStatusOut:
    user = _user(db, user_id)
    if not _visible(p, user):
        raise NotFound("User not found")
    row = db.get(FaceEnrollment, user.id)
    if row is None:
        return FaceStatusOut(user_id=user.id, enrolled=False)
    return FaceStatusOut(user_id=user.id, enrolled=True, model=row.model, samples=len(row.descriptors),
                         consent_at=row.consent_at, updated_at=row.updated_at)


def enroll(db: Session, p: Principal, user_id: uuid.UUID, body: FaceEnrollIn) -> FaceStatusOut:
    user = _user(db, user_id)
    _assert_manageable(p, user)
    row = db.get(FaceEnrollment, user.id)
    now = utcnow()
    if row is None:
        row = FaceEnrollment(user_id=user.id, division_id=user.division_id, model=body.model, descriptors=body.descriptors,
                             consent_at=now, consent_recorded_by_id=p.id)
        db.add(row)
        action = "user.face.enroll"
    else:
        row.model, row.descriptors, row.division_id = body.model, body.descriptors, user.division_id
        row.consent_at, row.consent_recorded_by_id = now, p.id
        action = "user.face.reenroll"
    db.flush()
    audit(db, actor_id=p.id, action=action, entity=user, division_id=user.division_id,
          changes={"model": body.model, "samples": len(body.descriptors), "consent": True})
    db.commit()
    return status(db, p, user.id)


def revoke(db: Session, p: Principal, user_id: uuid.UUID) -> None:
    user = _user(db, user_id)
    _assert_manageable(p, user)
    row = db.get(FaceEnrollment, user.id)
    if row is None:
        return
    audit(db, actor_id=p.id, action="user.face.remove", entity=user, division_id=user.division_id, changes={"model": row.model})
    db.delete(row)
    db.commit()


def profiles_for_device(db: Session, p: Principal, divisions: list[uuid.UUID]) -> list[FaceEnrollment]:
    """Descriptors this user's device needs to verify attendance offline, and no more: only divisions with
    face verification on; the staff of journeys the user supervises (or may review) and the user's own."""
    enabled = [d for d in divisions if get_policy(db, d).attendance_face_verification]
    if not enabled:
        return []
    recent = Journey.end_date >= days_ago_date(db, 7)
    reviewer_divs = [d for d in enabled if p.has("attendance.review", d)]
    oversees = or_(Journey.supervisor_id == p.id, Journey.division_id.in_(reviewer_divs)) if reviewer_divs else Journey.supervisor_id == p.id
    staff = select(StaffAllocation.user_id).join(Journey, Journey.id == StaffAllocation.journey_id).where(
        Journey.division_id.in_(enabled), recent, oversees)
    return list(db.scalars(select(FaceEnrollment).where(
        FaceEnrollment.division_id.in_(enabled),
        or_(FaceEnrollment.user_id.in_(staff), FaceEnrollment.user_id == p.id))))
