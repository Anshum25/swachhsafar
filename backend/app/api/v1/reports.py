import uuid
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas.reports import (
    AttendanceRow,
    ComplaintReport,
    DivisionDashboard,
    FeedbackReport,
    InspectionRow,
    InventoryRow,
    Overview,
    PsiQuestions,
    PsiRow,
)
from app.security.principal import Principal, get_principal
from app.services import feedback_reports as fb_reports
from app.services import reports as svc
from app.timeutil import today_ist

router = APIRouter(prefix="/reports", tags=["reports"])
dashboard_router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/attendance", response_model=list[AttendanceRow])
def attendance(date_from: date, date_to: date, group_by: Literal["employee", "journey"] = "employee",
               division_id: uuid.UUID | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.attendance_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, group_by=group_by)


@router.get("/inspections", response_model=list[InspectionRow])
def inspections(date_from: date, date_to: date, coach_wise: bool = False, division_id: uuid.UUID | None = None,
                db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.inspection_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, coach_wise=coach_wise)


@router.get("/feedback/{audience}", response_model=FeedbackReport)
def feedback(audience: Literal["passenger", "railway"], date_from: date, date_to: date, division_id: uuid.UUID | None = None,
             journey_id: uuid.UUID | None = None, bank_id: uuid.UUID | None = None,
             db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Counts and per-question raw averages on the bank's own scale (no percentage conversion is assumed)."""
    return svc.feedback_report(db, p, audience=audience, division_id=division_id, date_from=date_from, date_to=date_to,
                               journey_id=journey_id, bank_id=bank_id)


@router.get("/psi", response_model=list[PsiRow])
def psi(date_from: date, date_to: date, division_id: uuid.UUID | None = None, bank_id: uuid.UUID | None = None,
        db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.psi_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, bank_id=bank_id)


@router.get("/psi/questions", response_model=PsiQuestions | None)
def psi_questions(date_from: date, date_to: date, division_id: uuid.UUID | None = None, bank_id: uuid.UUID | None = None,
                  db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """PSI for the period, question by question (null when no passenger question bank is in use)."""
    return svc.psi_questions_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to, bank_id=bank_id)


@router.get("/feedback-sheet")
def feedback_sheet(journey_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """A journey's completed passenger feedback, coach by journey day, as the coach sheet shows it."""
    return svc.feedback_sheet(db, p, journey_id=journey_id)


@router.get("/complaints", response_model=ComplaintReport)
def complaints(date_from: date, date_to: date, division_id: uuid.UUID | None = None,
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.complaint_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to)


@router.get("/inventory", response_model=list[InventoryRow])
def inventory(date_from: date, date_to: date, division_id: uuid.UUID | None = None,
              db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.inventory_report(db, p, division_id=division_id, date_from=date_from, date_to=date_to)


@router.get("/feedback-targets")
def feedback_targets(date_from: date, date_to: date,
                     group_by: Literal["train", "direction", "date", "day", "coach"] = "train",
                     division_id: uuid.UUID | None = None, train_id: uuid.UUID | None = None,
                     direction: Literal[1, 2, 3] | None = None,
                     db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Passenger feedback against the Train Master targets of journey days in the range, train-wise
    (with direction), direction-wise, date-wise, per journey day, or coach-wise. Pending is summed day by
    day (a day over its target does not make up for another under it)."""
    return fb_reports.target_report(db, p, date_from=date_from, date_to=date_to, group_by=group_by,
                                    division_id=division_id, train_id=train_id, direction=direction)


@router.get("/feedback-verification")
def feedback_verification(date_from: date, date_to: date, division_id: uuid.UUID | None = None,
                          db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """PNR and OTP outcomes: rejections by reason, coaches moved to the ticket's, provider outages, wrong codes."""
    return fb_reports.verification_report(db, p, date_from=date_from, date_to=date_to, division_id=division_id)


@router.get("/timetable-sync")
def timetable_sync(division_id: uuid.UUID | None = None, db: Session = Depends(get_db),
                   p: Principal = Depends(get_principal)):
    """Each train's timetable state (ok / failed / rejected / never read) and the latest failed reads."""
    return fb_reports.sync_report(db, p, division_id=division_id)


class MapPoint(BaseModel):
    id: uuid.UUID
    journey_id: uuid.UUID
    latitude: float
    longitude: float
    at: datetime
    employee_id: uuid.UUID | None = None
    stage: int | None = None
    coach_code: str | None = None


@dashboard_router.get("/overview", response_model=Overview)
def overview(date_from: date | None = None, date_to: date | None = None, division_id: uuid.UUID | None = None,
             db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Counts, a day-by-day series and a per-office table for everything the caller may see. A Super Admin
    sees every office; ?client_id= narrows to one office and division_id to one headquarters or station.
    The period defaults to the last 30 days, today included."""
    date_to = date_to or today_ist()
    date_from = date_from or date_to - timedelta(days=29)
    return svc.overview(db, p, division_id=division_id, date_from=date_from, date_to=date_to)


@dashboard_router.get("/divisions/{division_id}", response_model=DivisionDashboard)
def division_dashboard(division_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.division_dashboard(db, p, division_id)


@dashboard_router.get("/divisions/{division_id}/map", response_model=list[MapPoint])
def map_points(division_id: uuid.UUID, kind: Literal["attendance", "feedback"], on: date | None = None,
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return svc.map_points(db, p, division_id, kind, on or today_ist())
