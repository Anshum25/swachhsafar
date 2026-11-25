"""Field operations captured on board: attendance and inspections."""

import uuid
from datetime import datetime
from enum import IntEnum, StrEnum

from sqlalchemy import CheckConstraint, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.org import JSONType
from app.models.base import Base, GeoPoint, Timestamps, str_enum, TZDateTime


class AttendanceStage(IntEnum):
    """The original five stages: still the plan of a journey whose train has no station-wise configuration
    (services/trains.LEGACY_STAGES). A configured journey's stages are its own list (Journey.attendance_stages)."""
    SOURCE = 1
    ENROUTE_1 = 2
    DESTINATION = 3
    ENROUTE_2 = 4
    END = 5


class VerificationStatus(StrEnum):
    SUBMITTED = "submitted"
    VERIFIED = "verified"
    REJECTED = "rejected"


class InspectionPhase(StrEnum):
    BEFORE = "B"
    AFTER = "A"


class CapturedRecord(GeoPoint, Timestamps):
    """Common columns for device-captured records. The primary key is device-generated and doubles as the
    idempotency key; payload_hash detects a replay that carries different content."""

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False, index=True)
    device_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    server_timestamp: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    verification_status: Mapped[VerificationStatus] = mapped_column(
        str_enum(VerificationStatus, 10), nullable=False, default=VerificationStatus.SUBMITTED
    )
    verified_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    verified_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    review_remarks: Mapped[str | None] = mapped_column(String(500))
    sync_op_id: Mapped[uuid.UUID | None] = mapped_column()
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Capture evidence (device claims) and the server's own findings. device_id comes from the sync batch.
    device_id: Mapped[str | None] = mapped_column(String(64))
    gps_timestamp: Mapped[datetime | None] = mapped_column(TZDateTime())
    security: Mapped[dict | None] = mapped_column(JSONType)     # as reported by the device
    risk_flags: Mapped[list | None] = mapped_column(JSONType)   # derived by the server


class Attendance(CapturedRecord, Base):
    __tablename__ = "attendance"
    __table_args__ = (
        UniqueConstraint("journey_id", "employee_id", "stage"),
        CheckConstraint("stage >= 1", name="stage_positive"),
    )

    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    # Position in the journey's attendance plan (Journey.attendance_stages), 1 = Source.
    stage: Mapped[int] = mapped_column(Integer, nullable=False)
    # The station and stage name this record was taken at, as the plan had them (migration 0021). NULL on
    # records taken before, and on legacy stages, which have no station.
    station_code: Mapped[str | None] = mapped_column(String(8))
    stage_label: Mapped[str | None] = mapped_column(String(140))
    photo_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
    group_submission_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    face_distance: Mapped[float | None] = mapped_column(Float)
    face_model: Mapped[str | None] = mapped_column(String(40))
    # How identity was established: "face", "fingerprint", "group_photo" or NULL (the division asked for
    # no proof). A group photo is recorded separately from a live face check because it proves less -- one
    # frame, many faces, no face watched over time for a blink -- and a report that treats the two alike
    # would overstate what is known. With "group_photo", face_distance tells the two cases apart: set when
    # the device recognised the person and the supervisor agreed, NULL when the supervisor named them.
    identified_by: Mapped[str | None] = mapped_column(String(20))
    # How the fingerprint check went, when that is how this attendance was verified. The score is the
    # scanner SDK's own, so `fingerprint_matcher` records whose scale it is.
    fingerprint_score: Mapped[int | None] = mapped_column(Integer)
    fingerprint_matcher: Mapped[str | None] = mapped_column(String(40))
    fingerprint_finger: Mapped[str | None] = mapped_column(String(20))


class Inspection(CapturedRecord, Base):
    __tablename__ = "inspections"
    __table_args__ = (
        UniqueConstraint("journey_id", "coach_code", "day", "round", "phase"),
        CheckConstraint("day >= 1", name="day_positive"),
        CheckConstraint("round >= 1", name="round_positive"),
        Index("ix_inspections_journey_day", "journey_id", "day"),
    )

    coach_code: Mapped[str] = mapped_column(String(10), nullable=False)
    day: Mapped[int] = mapped_column(Integer, nullable=False)
    round: Mapped[int] = mapped_column(Integer, nullable=False)
    phase: Mapped[InspectionPhase] = mapped_column(str_enum(InspectionPhase, 1), nullable=False)
    comments: Mapped[str | None] = mapped_column(Text)
    photo_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
    video_media_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("media_objects.id"), unique=True)
