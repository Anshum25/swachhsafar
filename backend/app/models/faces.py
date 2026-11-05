import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, TZDateTime
from app.models.org import JSONType


class FaceEnrollment(Timestamps, Base):
    """An employee's registered face for attendance verification: face descriptors only (numbers computed on
    the registering admin's device), never the photos. One active registration per employee; removing it
    deletes the row. `model` names the descriptor model, so codes from a different model are never compared."""

    __tablename__ = "face_enrollments"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(40), nullable=False)
    descriptors: Mapped[list] = mapped_column(JSONType, nullable=False)
    consent_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    consent_recorded_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
