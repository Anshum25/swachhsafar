"""Jobs (TEMPORARY test module). Phones read jobs from GET /sync/changes and write through POST /sync/batch
('job.save'); these endpoints are for changing jobs from the server side (Swagger at /docs, curl, scripts)."""
import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas.common import Page, PageParams
from app.schemas.jobs import JobIn, JobOut, JobUpdate, Status
from app.security.principal import Principal, get_principal
from app.services import jobs as svc

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=Page[JobOut])
def list_jobs(params: PageParams = Depends(), status_: Status | None = Query(None, alias="status"),
              include_deleted: bool = False, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = svc.list_jobs(db, params, status=status_, include_deleted=include_deleted)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


@router.post("", response_model=JobOut, status_code=status.HTTP_201_CREATED)
def create_job(body: JobIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.create(db, p, body)


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.get_job(db, job_id)


@router.patch("/{job_id}", response_model=JobOut)
def update_job(job_id: uuid.UUID, body: JobUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.update(db, p, job_id, body)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job(job_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    svc.delete(db, p, job_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
