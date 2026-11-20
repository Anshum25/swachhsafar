"""Jobs: a simple shared task list, added to test that server-side changes reach the phone's SQLite database
through GET /sync/changes without an app update. TEMPORARY (see src/pages/ops/Jobs.jsx for removal notes).

Every signed-in user sees every job. A deletion is a soft delete (is_deleted), so it travels to phones in
the next /sync/changes delta like any other change. `extra` holds free-form fields set on the server; phones
display whatever it contains, so new fields can be tried without changing the app."""
import uuid
from datetime import date

from sqlalchemy import Boolean, CheckConstraint, Date, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk
from app.models.org import JSONType

JOB_PRIORITIES = ("low", "medium", "high")
JOB_STATUSES = ("open", "in_progress", "done")


class Job(UUIDPk, Timestamps, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint("priority IN ('low', 'medium', 'high')", name="priority_valid"),
        CheckConstraint("status IN ('open', 'in_progress', 'done')", name="status_valid"),
    )

    title: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    location: Mapped[str | None] = mapped_column(String(60))
    priority: Mapped[str] = mapped_column(String(8), nullable=False, default="medium")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="open")
    due_date: Mapped[date | None] = mapped_column(Date)
    extra: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
