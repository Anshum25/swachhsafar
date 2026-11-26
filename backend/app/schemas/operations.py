import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.models import InspectionPhase, VerificationStatus
from app.models.trains import MAX_ATTENDANCE_STATIONS
from app.schemas.common import Accuracy, AwareDatetime, Captured, CoachCode, Latitude, Longitude, ReadModel, StrictModel
from app.schemas.security import CaptureSecurity


# Source + the most attendance stations a train can configure + End.
MAX_STAGE = MAX_ATTENDANCE_STATIONS + 2


class AttendanceIn(Captured):
    id: uuid.UUID = Field(description="Device-generated UUID; idempotency key")
    journey_id: uuid.UUID
    employee_id: uuid.UUID
    # Position in the journey's attendance stages (JourneyOut.attendance_stages), 1 = Source.
    stage: int = Field(ge=1, le=MAX_STAGE)
    # The station of that stage as the device had it. When given it must still be the journey's, so a capture
    # made against stages the office has since changed is refused rather than recorded at the wrong station.
    station_code: str | None = Field(default=None, max_length=8)
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
    # This capture came from one photograph of a crew in which this person was recognised, rather than a
    # live capture of them. It weakens what the record proves, so the server records it and only accepts
    # it from a supervisor or reviewer of the journey, in a division that allows it.
    group_photo: bool = False
    # When the location fix was taken (device clock), and the capture conditions the app reports.
    gps_timestamp: AwareDatetime | None = None
    security: CaptureSecurity | None = None
    # Sent by app builds that had the liveness-challenge feature (since removed). Accepted so records queued
    # offline on those phones still sync; never stored or checked.
    liveness_proof: dict | None = None


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
    # Sent by app builds that had the liveness-challenge feature (since removed). Accepted so records queued
    # offline on those phones still sync; never stored or checked.
    liveness_proof: dict | None = None
    # Set when this member was named from the group photograph rather than captured individually.
    group_photo: bool = False
    # This member's own stage. Progress is per employee, so one group capture can record different
    # stages for different people. Omitted: the group's stage if given, else the member's next pending stage.
    stage: int | None = Field(default=None, ge=1, le=MAX_STAGE)
    station_code: str | None = Field(default=None, max_length=8)


class GroupAttendanceIn(StrictModel):
    group_submission_id: uuid.UUID
    journey_id: uuid.UUID
    # Optional: when omitted, each member is recorded at their own next pending stage.
    stage: int | None = Field(default=None, ge=1, le=MAX_STAGE)
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
    station_code: str | None = None
    stage_label: str | None = None
    # services/route_window.check: where the fix was against the stage's stretch of the route.
    route_check: dict | None = None
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
    kind: str | None = None
    label: str | None = None
    station_code: str | None = None
    station_name: str | None = None
    valid_until_code: str | None = None
    valid_until_name: str | None = None


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
