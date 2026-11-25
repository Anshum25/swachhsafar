import uuid
from datetime import datetime, time
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.models import CoachClass
from app.models.trains import MAX_ATTENDANCE_STATIONS
from app.schemas.common import CoachCode, ReadModel, StrictModel

FeedbackDays = Literal["all", "running"]


class RouteStationOut(StrictModel):
    code: str
    name: str


class AttendanceStageOut(StrictModel):
    """One attendance stage of a journey (services/trains.attendance_plan)."""
    stage: int
    kind: str          # source | station | end; legacy stages: source | enroute | destination | end
    label: str
    station_code: str | None = None
    station_name: str | None = None


class CoachIn(StrictModel):
    code: CoachCode
    classification: CoachClass


class CoachOut(ReadModel):
    code: str
    classification: CoachClass
    position: int


class _TrainFields(StrictModel):
    name: str = Field(min_length=2, max_length=100)
    duration_days: int = Field(ge=0, le=15)
    operational_days: int = Field(ge=1, le=30)
    start_time: time | None = None
    end_time: time | None = None
    return_start_time: time | None = None
    return_end_time: time | None = None
    daywise: bool = False
    inspection_rounds_per_day: int = Field(default=1, ge=1, le=20)
    before_inspection_enabled: bool = False
    after_inspection_enabled: bool = True
    # ---- passenger feedback configuration (services/feedback_plan) ----
    feedback_enabled: bool = True
    feedback_daily_target: int | None = Field(default=None, ge=1, le=500,
                                              description="Passenger feedback required per journey day, whole train")
    feedback_coach_daily_target: int | None = Field(default=None, ge=1, le=100,
                                                    description="Optional target per coach per journey day")
    feedback_min_daily: int | None = Field(default=None, ge=1, le=500, description="Optional daily floor")
    feedback_from_day: int = Field(default=1, ge=1, le=30)
    feedback_to_day: int | None = Field(default=None, ge=1, le=30)
    feedback_days: FeedbackDays = "all"
    feedback_targets_active: bool = True


def _unique_codes(coaches: list[CoachIn]) -> list[CoachIn]:
    codes = [c.code for c in coaches]
    if len(codes) != len(set(codes)):
        raise ValueError("coach codes must be unique")
    return coaches


class TrainCreate(_TrainFields):
    division_id: uuid.UUID
    train_no: str = Field(min_length=3, max_length=15, pattern=r"^[0-9A-Z]+( / [0-9A-Z]+)?$")
    coaches: list[CoachIn] = Field(min_length=1, max_length=40)

    _codes = field_validator("coaches")(_unique_codes)

    @model_validator(mode="after")
    def _phase(self):
        if not (self.before_inspection_enabled or self.after_inspection_enabled):
            raise ValueError("at least one inspection phase must be enabled")
        return self


class TrainUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    duration_days: int | None = Field(default=None, ge=0, le=15)
    operational_days: int | None = Field(default=None, ge=1, le=30)
    start_time: time | None = None
    end_time: time | None = None
    return_start_time: time | None = None
    return_end_time: time | None = None
    daywise: bool | None = None
    inspection_rounds_per_day: int | None = Field(default=None, ge=1, le=20)
    before_inspection_enabled: bool | None = None
    after_inspection_enabled: bool | None = None
    is_active: bool | None = None
    feedback_enabled: bool | None = None
    # Explicit null clears a target (no target); leaving the field out keeps it.
    feedback_daily_target: int | None = Field(default=None, ge=1, le=500)
    feedback_coach_daily_target: int | None = Field(default=None, ge=1, le=100)
    feedback_min_daily: int | None = Field(default=None, ge=1, le=500)
    feedback_from_day: int | None = Field(default=None, ge=1, le=30)
    feedback_to_day: int | None = Field(default=None, ge=1, le=30)
    feedback_days: FeedbackDays | None = None
    feedback_targets_active: bool | None = None

    @model_validator(mode="after")
    def _not_null(self):
        for k in ("feedback_enabled", "feedback_from_day", "feedback_days", "feedback_targets_active"):
            if k in self.model_fields_set and getattr(self, k) is None:
                raise ValueError(f"{k} cannot be null")
        return self

    # Station-wise attendance. Both null clears it (journeys go back to the five standard stages); otherwise
    # exactly `attendance_station_count` distinct stations of the train's route (first and last included).
    attendance_station_count: int | None = Field(default=None, ge=1, le=MAX_ATTENDANCE_STATIONS)
    attendance_station_codes: list[str] | None = Field(default=None, max_length=MAX_ATTENDANCE_STATIONS)

    @field_validator("attendance_station_codes")
    @classmethod
    def _distinct_stations(cls, v):
        if v is not None:
            v = [str(c).strip().upper() for c in v]
            if len(v) != len(set(v)):
                raise ValueError("a station can be selected only once")
        return v


class CoachesReplace(StrictModel):
    coaches: list[CoachIn] = Field(min_length=1, max_length=40)

    _codes = field_validator("coaches")(_unique_codes)


class TrainOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    train_no: str
    name: str
    duration_days: int
    operational_days: int
    start_time: time | None
    end_time: time | None
    return_start_time: time | None
    return_end_time: time | None
    daywise: bool
    inspection_rounds_per_day: int
    before_inspection_enabled: bool
    after_inspection_enabled: bool
    is_active: bool
    coaches: list[CoachOut]
    route_stations: list[RouteStationOut] | None = None
    attendance_station_count: int | None = None
    attendance_station_codes: list[str] | None = None
    updated_at: datetime
    # ---- route and timetable (RailRadar) ----
    origin_code: str | None = None
    origin_name: str | None = None
    destination_code: str | None = None
    destination_name: str | None = None
    run_days: str | None = None
    arrival_days: int | None = None
    return_train_id: uuid.UUID | None = None
    return_train_no: str | None = None
    distance_km: float | None = None
    duration_minutes: int | None = None
    schedule_status: str | None = None
    schedule_synced_at: datetime | None = None
    schedule_checked_at: datetime | None = None
    schedule_error: str | None = None
    auto_journeys: bool = False
    # ---- passenger feedback configuration ----
    feedback_enabled: bool = True
    feedback_daily_target: int | None = None
    feedback_coach_daily_target: int | None = None
    feedback_min_daily: int | None = None
    feedback_from_day: int = 1
    feedback_to_day: int | None = None
    feedback_days: str = "all"
    feedback_targets_active: bool = True


class StopOut(ReadModel):
    seq: int
    code: str
    name: str | None
    arrival: str | None
    arrival_day: int | None
    departure: str | None
    departure_day: int | None
    day: int
    halt_minutes: int | None
    distance_km: float | None
    platform: str | None


class DirectionOut(ReadModel):
    direction: int
    train_id: uuid.UUID
    train_no: str
    train_name: str
    origin_code: str | None
    origin_name: str | None
    destination_code: str | None
    destination_name: str | None
    departure: str | None
    arrival: str | None
    arrival_days: int | None
    journey_days: int | None
    run_days: list[str] | None
    distance_km: float | None
    duration_minutes: int | None
    schedule_status: str | None
    schedule_synced_at: datetime | None
    schedule_checked_at: datetime | None
    schedule_error: str | None
    stops: list[StopOut]


class SyncRunOut(ReadModel):
    id: uuid.UUID
    train_id: uuid.UUID
    train_no: str
    trigger: str
    started_at: datetime
    finished_at: datetime
    outcome: str
    error_kind: str | None
    message: str | None
    changes: dict | None


class TimetableOut(ReadModel):
    train_id: uuid.UUID
    train_no: str
    outbound: DirectionOut | None
    inbound: DirectionOut | None
    runs: list[SyncRunOut]
    bulk_running: bool


class RefreshOut(ReadModel):
    outcome: str
    message: str | None
    changed: int
    journeys_updated: int
    timetable: TimetableOut


class BulkRefreshIn(StrictModel):
    division_id: uuid.UUID | None = None
    only_due: bool = Field(default=False, description="Only trains never read, stale, or failed and due for a retry")


class BulkRefreshOut(ReadModel):
    accepted: bool
    trains: int
    message: str
