import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel


class JourneySummary(BaseModel):
    journey_id: uuid.UUID
    state: str
    staff_allocated: int
    attendance_records: int
    attendance_by_stage: dict[int, int]
    staff_fully_attended: int
    inspections_required: int
    inspections_done: int
    inspection_completion_pct: float | None
    passenger_feedback_counted: int
    passenger_feedback_completed: int
    passenger_feedback_pending: int
    passenger_feedback_void: int
    railway_feedback: int
    complaints_open: int
    complaints_overdue: int
    complaints_closed: int
    inventory_lines: int


class AttendanceRow(BaseModel):
    key_id: uuid.UUID
    label: str
    journeys: int
    records: int
    stages: dict[int, int]
    verified: int
    rejected: int


class InspectionRow(BaseModel):
    journey_id: uuid.UUID
    train_no: str
    journey_date: date
    coach_code: str | None
    required: int
    done: int
    completion_pct: float | None
    verified: int
    rejected: int


class QuestionAverage(BaseModel):
    question_id: uuid.UUID
    position: int
    text_en: str
    responses: int
    average: float | None


class FeedbackReport(BaseModel):
    audience: str
    bank_id: uuid.UUID | None
    scale_min: int | None
    scale_max: int | None
    total: int
    by_status: dict[str, int]
    by_coach_class: dict[str, int]
    questions: list[QuestionAverage]


class ComplaintReport(BaseModel):
    total: int
    by_status: dict[str, int]
    overdue: int
    by_category: list[dict]
    avg_resolution_hours: float | None


class InventoryRow(BaseModel):
    item_id: uuid.UUID
    item_name: str
    unit: str
    issued: float
    returned: float
    consumed: float
    journeys: int


class PsiRow(BaseModel):
    journey_id: uuid.UUID
    train_no: str
    journey_date: date
    responses: int
    psi: float | None


class PsiQuestionRow(BaseModel):
    question_id: uuid.UUID
    position: int
    text_en: str
    weight: float
    responses: int
    average: float | None
    score: float | None          # 0-100: (average - scale_min) / (scale_max - scale_min) * 100
    weight_share: float | None   # % of the weight of the questions answered
    contribution: float | None   # weight_share * score; the contributions add up to psi
    points_lost: float | None    # weight_share * (100 - score)


class PsiQuestions(BaseModel):
    bank_id: uuid.UUID
    scale_min: int
    scale_max: int
    weighting: Literal["configured", "equal"]
    responses: int
    psi: float | None
    questions: list[PsiQuestionRow]


class DivisionDashboard(BaseModel):
    division_id: uuid.UUID
    date: date
    journeys_active: int
    journeys_scheduled: int
    attendance_today: int
    inspections_today: int
    passenger_feedback_today: int
    railway_feedback_today: int
    complaints_open: int
    complaints_overdue: int


class OverviewTotals(BaseModel):
    offices: int
    headquarters: int
    stations: int
    users_active: int
    users_inactive: int
    journeys_active: int
    journeys_scheduled: int
    journeys: int
    journeys_cancelled: int
    attendance: int
    inspections: int
    passenger_feedback: int
    railway_feedback: int
    complaints: int
    complaints_open: int
    complaints_overdue: int
    credit_balance: int
    credits_added: int
    credits_spent: int


class OverviewDay(BaseModel):
    date: date
    journeys: int
    attendance: int
    inspections: int
    passenger_feedback: int
    railway_feedback: int
    complaints: int


class OverviewRole(BaseModel):
    role_id: int
    role: str
    count: int


class OverviewOffice(BaseModel):
    client_id: uuid.UUID
    office_id: str
    name: str
    status: str
    divisions: int
    users: int
    journeys: int
    attendance: int
    inspections: int
    complaints_open: int
    credit_balance: int
    credits_spent: int


class Overview(BaseModel):
    date_from: date
    date_to: date
    totals: OverviewTotals
    daily: list[OverviewDay]
    complaints_by_status: dict[str, int]
    users_by_role: list[OverviewRole]
    offices: list[OverviewOffice]
