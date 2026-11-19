import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.models import InspectionPhase, VerificationStatus
from app.schemas.common import Accuracy, AwareDatetime, Captured, CoachCode, Latitude, Longitude, ReadModel, StrictModel
from app.schemas.security import CaptureSecurity


class AttendanceIn(Captured):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    employee_id: uuid.UUID
    stage: int = Field(ge=1, le=5, description="1 Source, 2 Enroute 1, 3 Destination, 4 Enroute 2, 5 End")
    photo_media_id: uuid.UUID | None = None
    group_submission_id: uuid.UUID | None = None
    # Face verification result computed on the device (distance to the closest registered descriptor).
    face_distance: float | None = Field(default=None, ge=0, le=4)
    face_model: str | None = Field(default=None, max_length=40)
    # Fingerprint verification result from the scanner's own matcher, when that is how this capture was
    # verified. The score's scale belongs to the matcher, so it is recorded with it.
    fingerprint_score: int | None = Field(default=None, ge=0, le=10_000)
    fingerprint_matcher: str | None = Field(default=None, max_length=40)
    fingerprint_finger: str | None = Field(default=None, max_length=20)
    # This capture came from one photograph of a group whose naming the submitter confirmed, rather than a
    # live capture of this person. It weakens what the record proves, so the server records it and only
    # accepts it from a supervisor or reviewer of the journey, in a division that allows it.
    group_photo: bool = False
    # When the location fix was taken (device clock), and the capture conditions the app reports.
    gps_timestamp: AwareDatetime | None = None
    security: CaptureSecurity | None = None


class GroupMember(StrictModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    photo_media_id: uuid.UUID | None = None
    face_distance: float | None = Field(default=None, ge=0, le=4)
    face_model: str | None = Field(default=None, max_length=40)
    # Fingerprint verification result from the scanner's own matcher, when that is how this capture was
    # verified. The score's scale belongs to the matcher, so it is recorded with it.
    fingerprint_score: int | None = Field(default=None, ge=0, le=10_000)
    fingerprint_matcher: str | None = Field(default=None, max_length=40)
    fingerprint_finger: str | None = Field(default=None, max_length=20)
    liveness: Literal["passed", "failed", "not_required", "unavailable"] | None = None
    # Set when this member was named from the group photograph rather than captured individually.
    group_photo: bool = False


class GroupAttendanceIn(StrictModel):
    group_submission_id: uuid.UUID
    journey_id: uuid.UUID
    stage: int = Field(ge=1, le=5)
    device_timestamp: AwareDatetime
    latitude: Latitude
    longitude: Longitude
    gps_accuracy_m: Accuracy | None = None
    gps_timestamp: AwareDatetime | None = None
    security: CaptureSecurity | None = None
    members: list[GroupMember] = Field(min_length=1, max_length=100)

    @field_validator("members")
    @classmethod
    def _unique(cls, v: list[GroupMember]):
        if len({m.employee_id for m in v}) != len(v) or len({m.id for m in v}) != len(v):
            raise ValueError("members must be unique")
        return v


class ReviewIn(StrictModel):
    status: Literal[VerificationStatus.VERIFIED, VerificationStatus.REJECTED]
    remarks: str | None = Field(default=None, max_length=500)


class AttendanceOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    employee_id: uuid.UUID
    stage: int
    device_timestamp: datetime
    server_timestamp: datetime
    latitude: float
    longitude: float
    gps_accuracy_m: float | None
    photo_media_id: uuid.UUID | None
    group_submission_id: uuid.UUID | None
    face_distance: float | None = None
    face_model: str | None = None
    fingerprint_score: int | None = None
    fingerprint_matcher: str | None = None
    fingerprint_finger: str | None = None
    # "face", "fingerprint", "group_photo" or null. A reviewer needs this to read the record correctly: a
    # group photo is the supervisor's attestation, not a live check of this person.
    identified_by: str | None = None
    created_by_id: uuid.UUID
    verification_status: VerificationStatus
    verified_by_id: uuid.UUID | None
    review_remarks: str | None
    sync_op_id: uuid.UUID | None


class GroupResult(StrictModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    outcome: Literal["created", "replayed", "rejected"]
    error: dict | None = None
    record: AttendanceOut | None = None


class StageCell(StrictModel):
    stage: int
    status: Literal["taken", "next", "locked"]
    attendance_id: uuid.UUID | None = None


class StaffAttendanceStatus(StrictModel):
    employee_id: uuid.UUID
    name: str
    emp_id: str
    role_id: int
    stages: list[StageCell]
    completed: bool


class InspectionIn(Captured):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    coach_code: CoachCode
    day: int = Field(ge=1, le=30)
    round: int = Field(ge=1, le=20)
    phase: InspectionPhase
    comments: str | None = Field(default=None, max_length=2000)
    photo_media_id: uuid.UUID | None = None
    video_media_id: uuid.UUID | None = None
    gps_timestamp: AwareDatetime | None = None
    security: CaptureSecurity | None = None


class InspectionOut(ReadModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    division_id: uuid.UUID
    coach_code: str
    day: int
    round: int
    phase: InspectionPhase
    comments: str | None
    device_timestamp: datetime
    server_timestamp: datetime
    latitude: float
    longitude: float
    gps_accuracy_m: float | None
    photo_media_id: uuid.UUID | None
    video_media_id: uuid.UUID | None
    created_by_id: uuid.UUID
    verification_status: VerificationStatus
    review_remarks: str | None


class InspectionCell(StrictModel):
    round: int
    phase: InspectionPhase
    status: Literal["taken", "open", "locked"]
    inspection_id: uuid.UUID | None = None


class CoachDayStatus(StrictModel):
    coach_code: str
    day: int
    day_open: bool
    required: int
    done: int
    cells: list[InspectionCell]
