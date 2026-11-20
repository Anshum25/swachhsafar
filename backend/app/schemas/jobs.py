import json
import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import ReadModel, StrictModel

Priority = Literal["low", "medium", "high"]
Status = Literal["open", "in_progress", "done"]


def _small_extra(v: dict[str, Any] | None) -> dict[str, Any] | None:
    if v is not None and (len(v) > 20 or len(json.dumps(v, default=str)) > 4000):
        raise ValueError("extra may hold at most 20 fields and 4000 characters")
    return v


class JobIn(StrictModel):
    """POST /jobs. `extra`: free-form fields shown on the phone as they are (no app change needed)."""

    id: uuid.UUID | None = Field(default=None, description="Optional client-generated UUID")
    title: str = Field(min_length=3, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=60)
    priority: Priority = "medium"
    status: Status = "open"
    due_date: date | None = None
    extra: dict[str, Any] | None = None

    _extra = field_validator("extra")(_small_extra)


class JobUpdate(StrictModel):
    """PATCH /jobs/{id}. Only the fields sent are changed; `extra` replaces the whole dict."""

    title: str | None = Field(default=None, min_length=3, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=60)
    priority: Priority | None = None
    status: Status | None = None
    due_date: date | None = None
    extra: dict[str, Any] | None = None

    _extra = field_validator("extra")(_small_extra)


class JobSaveIn(StrictModel):
    """Sync operation 'job.save' from a phone: create, update or (deleted=true) delete one job. Last write wins.
    The phone never sends `extra`, so fields set on the server survive edits made on a phone."""

    id: uuid.UUID = Field(description="The job's id (device-generated for a new job)")
    title: str = Field(min_length=3, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=60)
    priority: Priority = "medium"
    status: Status = "open"
    due_date: date | None = None
    deleted: bool = False


class JobOut(ReadModel):
    id: uuid.UUID
    title: str
    description: str | None
    location: str | None
    priority: str
    status: str
    due_date: date | None
    extra: dict[str, Any] = {}
    is_deleted: bool
    created_by_id: uuid.UUID | None
    updated_by_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    @field_validator("extra", mode="before")
    @classmethod
    def _none_is_empty(cls, v):
        return v or {}
