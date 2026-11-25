import uuid
from datetime import date, datetime, time

from pydantic import Field, field_validator

from app.models import JourneyState
from app.schemas.common import ReadModel, StrictModel
from app.schemas.trains import CoachIn, CoachOut, _unique_codes


class JourneyCreate(StrictModel):
    division_id: uuid.UUID
    train_id: uuid.UUID
    linked_train_id: uuid.UUID | None = None
    journey_date: date
    outbound_end_date: date | None = None
    linked_journey_date: date | None = Field(default=None, description="Override for non-standard return; default journey_date + duration")
    end_date: date | None = Field(default=None, description="Override; default linked_journey_date + duration - 1")
    start_time: time | None = None
    end_time: time | None = None
    return_start_time: time | None = None
    return_end_time: time | None = None
    supervisor_id: uuid.UUID
    staff_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)
    coaches: list[CoachIn] | None = Field(default=None, max_length=40, description="Default: the train's coaches")

    _codes = field_validator("coaches")(lambda v: v if v is None else _unique_codes(v))


class JourneyUpdate(StrictModel):
    version: int = Field(description="Current version, for optimistic concurrency")
    linked_train_id: uuid.UUID | None = None
    journey_date: date | None = None
    outbound_end_date: date | None = None
    linked_journey_date: date | None = None
    end_date: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    return_start_time: time | None = None
    return_end_time: time | None = None
    coaches: list[CoachIn] | None = Field(default=None, max_length=40)

    _codes = field_validator("coaches")(lambda v: v if v is None else _unique_codes(v))


class SupervisorAssign(StrictModel):
    version: int
    supervisor_id: uuid.UUID


class JourneyCancel(StrictModel):
    version: int
    reason: str = Field(min_length=3, max_length=300)


class StaffAdd(StrictModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


class StaffOut(ReadModel):
    id: uuid.UUID
    user_id: uuid.UUID
    role_id: int
    name: str
    emp_id: str
    allocated_at: datetime
    removed_at: datetime | None


class JourneyOut(ReadModel):
    id: uuid.UUID
    division_id: uuid.UUID
    train_id: uuid.UUID
    train_no: str
    train_name: str
    linked_train_id: uuid.UUID | None
    linked_train_no: str | None
    journey_date: date
    outbound_end_date: date | None
    linked_journey_date: date
    end_date: date
    start_time: time | None
    end_time: time | None
    return_start_time: time | None
    return_end_time: time | None
    duration_days: int
    operational_days: int
    daywise: bool
    inspection_rounds_per_day: int
    before_inspection_enabled: bool
    after_inspection_enabled: bool
    # Empty on a planned journey until somebody assigns a supervisor (services/railway.py).
    supervisor_id: uuid.UUID | None
    supervisor_name: str | None
    created_by_id: uuid.UUID | None
    auto_created: bool = False
    charged: bool = True
    state: JourneyState
    cancel_reason: str | None
    cancelled_at: datetime | None
    version: int
    coaches: list[CoachOut]
    updated_at: datetime
    # ---- Train Master feedback configuration and the journey's directions (services/feedback_plan) ----
    feedback_enabled: bool = True
    feedback_daily_target: int | None = None
    legs: list["LegBrief"] = []


class LegBrief(ReadModel):
    direction: int
    train_no: str
    train_name: str | None = None
    origin_code: str | None = None
    origin_name: str | None = None
    destination_code: str | None = None
    destination_name: str | None = None
    departs_on: date
    departs_at: time | None = None
    arrives_on: date
    arrives_at: time | None = None
    first_day: int
    last_day: int


class LegOut(LegBrief):
    stops: list[dict] = []


class PlanDay(ReadModel):
    journey_day: int
    day_date: date
    direction: int | None
    direction_label: str
    train_nos: str | None
    required: int
    coach_required: int | None
    minimum: int | None
    submitted: int
    verified: int
    in_progress: int
    rejected: int
    pending: int
    completion: float | None
    status: str
    is_today: bool


class PlanCoachDay(ReadModel):
    journey_day: int
    required: int
    submitted: int
    verified: int
    in_progress: int
    rejected: int
    pending: int


class PlanCoach(ReadModel):
    code: str
    classification: str
    days: list[PlanCoachDay]
    required: int
    submitted: int
    verified: int
    in_progress: int
    rejected: int
    pending: int
    completion: float | None


class PlanTotals(ReadModel):
    required: int
    submitted: int
    verified: int
    in_progress: int
    rejected: int
    pending: int
    completion: float | None


class FeedbackPlanOut(ReadModel):
    journey_id: uuid.UUID
    train_id: uuid.UUID
    train_no: str
    train_name: str
    journey_date: date
    end_date: date
    operational_days: int
    feedback_enabled: bool
    targets_active: bool
    daily_target: int | None
    coach_daily_target: int | None
    min_daily: int | None
    feedback_from_day: int
    feedback_to_day: int | None
    feedback_days: str
    persisted: bool
    legs: list[LegOut]
    days: list[PlanDay]
    coaches: list[PlanCoach]
    totals: PlanTotals


class JourneyDetail(JourneyOut):
    staff: list[StaffOut]


JourneyOut.model_rebuild()
