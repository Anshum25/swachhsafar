"""Jobs (TEMPORARY test module, see app/models/jobs.py). Every signed-in user may read every job; only
Super Admin and Admin may create, edit or delete one (Manager, Supervisor/EHK, Janitor and Contractor view only)."""
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import Conflict, Forbidden, NotFound
from app.models import RoleId
from app.models.jobs import Job
from app.schemas.common import PageParams
from app.schemas.jobs import JobIn, JobSaveIn, JobUpdate
from app.security.principal import Principal
from app.services.common import paginate

JOB_EDITORS = frozenset({RoleId.SUPER_ADMIN, RoleId.ADMIN})


def require_editor(p: Principal) -> None:
    if p.role not in JOB_EDITORS:
        raise Forbidden("Only Admin can change jobs; your role can view them only", code="job_view_only")


def list_jobs(db: Session, params: PageParams, status: str | None = None, include_deleted: bool = False):
    stmt = select(Job).order_by(Job.updated_at.desc())
    if not include_deleted:
        stmt = stmt.where(Job.is_deleted.is_(False))
    if status:
        stmt = stmt.where(Job.status == status)
    return paginate(db, stmt, params)


def get_job(db: Session, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if job is None or job.is_deleted:
        raise NotFound("Job not found")
    return job


def create(db: Session, p: Principal, body: JobIn) -> Job:
    require_editor(p)
    job_id = body.id or uuid.uuid4()
    if db.get(Job, job_id) is not None:
        raise Conflict("A job with this id already exists")
    job = Job(id=job_id, **body.model_dump(exclude={"id", "extra"}), extra=body.extra or {},
              created_by_id=p.id, updated_by_id=p.id)
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def update(db: Session, p: Principal, job_id: uuid.UUID, body: JobUpdate) -> Job:
    require_editor(p)
    job = get_job(db, job_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(job, field, value if field != "extra" else (value or {}))
    job.updated_by_id = p.id
    db.commit()
    db.refresh(job)
    return job


def delete(db: Session, p: Principal, job_id: uuid.UUID) -> None:
    require_editor(p)
    job = get_job(db, job_id)
    job.is_deleted = True
    job.updated_by_id = p.id
    db.commit()


def save_from_device(db: Session, p: Principal, body: JobSaveIn) -> tuple[Job, bool]:
    """Sync handler for 'job.save'. Flushes only: /sync/batch commits. Idempotency comes from the op id."""
    require_editor(p)  # a view-only role's phone edit is rejected, not stored
    fields = body.model_dump(exclude={"id", "deleted"})
    job = db.get(Job, body.id)
    if job is None:
        job = Job(id=body.id, **fields, extra={}, is_deleted=body.deleted, created_by_id=p.id, updated_by_id=p.id)
        db.add(job)
    else:
        for field, value in fields.items():
            setattr(job, field, value)
        job.is_deleted = job.is_deleted or body.deleted  # a deleted job stays deleted
        job.updated_by_id = p.id
    db.flush()
    return job, False
