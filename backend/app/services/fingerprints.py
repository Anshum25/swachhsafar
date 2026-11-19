"""Fingerprint registration for attendance verification.

Only minutiae templates are stored -- extracted on the registering device by the scanner's SDK -- never
the fingerprint images. Every change is audited without the templates themselves. Distribution to devices
follows exactly the same rule as faces (app/services/faces.py): a device is sent only the registrations it
needs to verify the staff of journeys its user oversees.
"""
import uuid

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.errors import NotFound
from app.models import FingerprintEnrollment, Journey, StaffAllocation, User, UserStatus
from app.schemas.fingerprints import FingerprintEnrollIn, FingerprintStatusOut
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


def status(db: Session, p: Principal, user_id: uuid.UUID) -> FingerprintStatusOut:
    user = _user(db, user_id)
    if not _visible(p, user):
        raise NotFound("User not found")
    row = db.get(FingerprintEnrollment, user.id)
    if row is None:
        return FingerprintStatusOut(user_id=user.id, enrolled=False)
    return FingerprintStatusOut(user_id=user.id, enrolled=True, format=row.format, matcher=row.matcher,
                                fingers=[f["finger"] for f in row.fingers],
                                consent_at=row.consent_at, updated_at=row.updated_at)


def enroll(db: Session, p: Principal, user_id: uuid.UUID, body: FingerprintEnrollIn) -> FingerprintStatusOut:
    user = _user(db, user_id)
    _assert_manageable(p, user)
    row = db.get(FingerprintEnrollment, user.id)
    now = utcnow()
    fingers = [f.model_dump() for f in body.fingers]
    if row is None:
        row = FingerprintEnrollment(user_id=user.id, division_id=user.division_id, format=body.format,
                                    matcher=body.matcher, fingers=fingers, consent_at=now,
                                    consent_recorded_by_id=p.id)
        db.add(row)
        action = "user.fingerprint.enroll"
    else:
        row.format, row.matcher, row.fingers, row.division_id = body.format, body.matcher, fingers, user.division_id
        row.consent_at, row.consent_recorded_by_id = now, p.id
        action = "user.fingerprint.reenroll"
    db.flush()
    # The audit records which fingers, never a template.
    audit(db, actor_id=p.id, action=action, entity=user, division_id=user.division_id,
          changes={"format": body.format, "matcher": body.matcher,
                   "fingers": [f["finger"] for f in fingers], "consent": True})
    db.commit()
    return status(db, p, user.id)


def revoke(db: Session, p: Principal, user_id: uuid.UUID) -> None:
    user = _user(db, user_id)
    _assert_manageable(p, user)
    row = db.get(FingerprintEnrollment, user.id)
    if row is None:
        return
    audit(db, actor_id=p.id, action="user.fingerprint.remove", entity=user, division_id=user.division_id,
          changes={"format": row.format})
    db.delete(row)
    db.commit()


def profiles_for_device(db: Session, p: Principal, divisions: list[uuid.UUID],
                        user_id: uuid.UUID | None = None) -> list[FingerprintEnrollment]:
    """Templates this user's device needs to verify attendance offline, and no more: the staff of recent
    journeys the user supervises (or may review) in divisions with fingerprint verification on, and the
    user's own. `user_id` narrows it to one employee (the online fallback, `profile_for_verifier`).

    Eligibility follows the *journey's* division -- the policy attendance is actually judged by
    (services/attendance.py) -- not the division stored on the registration. That column is the
    employee's home division at the time of registering: staff allocated to another division's journey,
    or moved since, were silently left off every device and showed as "not registered" however many
    times their fingers were registered."""
    enabled = [d for d in divisions if get_policy(db, d).attendance_fingerprint_verification]
    if not enabled:
        return []
    recent = Journey.end_date >= days_ago_date(db, 7)
    reviewer_divs = [d for d in enabled if p.has("attendance.review", d)]
    oversees = or_(Journey.supervisor_id == p.id, Journey.division_id.in_(reviewer_divs)) if reviewer_divs else Journey.supervisor_id == p.id
    staff = select(StaffAllocation.user_id).join(Journey, Journey.id == StaffAllocation.journey_id).where(
        Journey.division_id.in_(enabled), recent, oversees, StaffAllocation.removed_at.is_(None))
    stmt = select(FingerprintEnrollment).join(User, User.id == FingerprintEnrollment.user_id).where(
        User.status != UserStatus.DELETED,
        or_(FingerprintEnrollment.user_id.in_(staff), FingerprintEnrollment.user_id == p.id))
    if user_id is not None:
        stmt = stmt.where(FingerprintEnrollment.user_id == user_id)
    return list(db.scalars(stmt))


def profile_for_verifier(db: Session, p: Principal, user_id: uuid.UUID) -> FingerprintEnrollment:
    """One employee's templates, read straight from the main database for a device that has no copy yet
    (registered after its last sync). Exactly the same rule as the sync: anyone this device could have
    been sent, and no one else."""
    rows = profiles_for_device(db, p, p.scope_divisions(), user_id=user_id)
    if not rows:
        raise NotFound("No registered fingerprints this device may verify for this employee",
                       code="fingerprint_not_enrolled")
    return rows[0]
