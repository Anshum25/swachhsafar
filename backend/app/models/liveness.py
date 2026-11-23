import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TZDateTime
from app.models.org import JSONType


class LivenessChallenge(Base):
    """A server-issued, single-use liveness challenge for face attendance.

    The server picks a random sequence of actions (blink, turn left, ...) that the person in front of the
    camera has to perform. It is issued to one signed-in user on one device, and an attendance verified by
    face is accepted only with the proof of one of these challenges, which is consumed by that attendance
    and can never be used again. Devices hold a small pool so that attendance can still be captured offline;
    the pool expires with the offline lease, and every challenge is checked again when the record syncs."""

    __tablename__ = "liveness_challenges"
    __table_args__ = (Index("ix_liveness_challenges_owner_open", "user_id", "device_id", "consumed_at"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    device_id: Mapped[str | None] = mapped_column(String(64))
    actions: Mapped[list] = mapped_column(JSONType, nullable=False)
    issued_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    # The attendance record that used it. Unique: one challenge proves one capture, never two.
    attendance_id: Mapped[uuid.UUID | None] = mapped_column(unique=True)
