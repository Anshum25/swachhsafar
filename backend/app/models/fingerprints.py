import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, TZDateTime
from app.models.org import JSONType


class FingerprintEnrollment(Timestamps, Base):
    """An employee's registered fingerprints for attendance verification.

    Minutiae templates only (ISO/IEC 19794-2, extracted on the registering device by the scanner's SDK) --
    never the fingerprint images, which are what a leak would make unforgeable. A template is per finger,
    and several fingers are registered on purpose: a cut, a bandage or a wet hand must not leave someone
    unable to be marked present for a whole shift.

    `format` names the template format and `matcher` the SDK that produced it, so templates are never
    compared across formats a matcher cannot read. One active registration per employee; removing it
    deletes the row.
    """

    __tablename__ = "fingerprint_enrollments"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    format: Mapped[str] = mapped_column(String(40), nullable=False)
    matcher: Mapped[str] = mapped_column(String(40), nullable=False)
    # [{"finger": "right_index", "templates": ["<base64 ISO 19794-2>", ...]}, ...]: several presses of
    # each finger, because one press records only the part that happened to touch the sensor.
    fingers: Mapped[list] = mapped_column(JSONType, nullable=False)
    consent_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    consent_recorded_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
