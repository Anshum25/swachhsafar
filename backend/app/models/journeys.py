import uuid
from datetime import date, datetime, time
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    String,
    Time,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, str_enum, TZDateTime
from app.models.org import JSONType, User
from app.models.trains import CoachClass, Train


class JourneyStatus(StrEnum):
    PLANNED = "planned"
    CANCELLED = "cancelled"


class JourneyState(StrEnum):
    """Derived, never stored."""

    SCHEDULED = "scheduled"
    ACTIVE = "active"
    HISTORY = "history"
    CANCELLED = "cancelled"


class Journey(UUIDPk, Timestamps, Base):
    __tablename__ = "journeys"
    __table_args__ = (
        CheckConstraint("linked_journey_date >= journey_date", name="linked_after_start"),
        CheckConstraint("end_date >= linked_journey_date", name="end_after_linked"),
        CheckConstraint(
            "outbound_end_date IS NULL OR (outbound_end_date >= journey_date AND outbound_end_date <= end_date)",
            name="outbound_end_range",
        ),
        Index("ix_journeys_division_dates", "division_id", "journey_date", "end_date"),
        # The planner may run twice a day: one planned journey per train per day.
        Index("uq_journeys_auto_train_date", "train_id", "journey_date", unique=True,
              postgresql_where=text("auto_created"), sqlite_where=text("auto_created")),
    )

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id"), nullable=False, index=True)
    linked_train_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trains.id"))
    journey_date: Mapped[date] = mapped_column(Date, nullable=False)
    outbound_end_date: Mapped[date | None] = mapped_column(Date)
    linked_journey_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    return_start_time: Mapped[time | None] = mapped_column(Time)
    return_end_time: Mapped[time | None] = mapped_column(Time)
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False)
    operational_days: Mapped[int] = mapped_column(Integer, nullable=False)
    # Inspection configuration snapshot taken from the train when the journey is created.
    daywise: Mapped[bool] = mapped_column(Boolean, nullable=False)
    inspection_rounds_per_day: Mapped[int] = mapped_column(Integer, nullable=False)
    before_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    after_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # Empty on a journey the planner created, until somebody assigns a supervisor (migration 0017).
    supervisor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    # Empty when the planner created it (auto_created).
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    auto_created: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    # Whether the client's wallet has paid for it. Every journey is paid for when it is created, planned
    # ones included (services/railway.plan_journeys); False only on one planned under the earlier
    # start-day rule and not yet charged (services/railway.charge_due_journeys).
    charged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    status: Mapped[JourneyStatus] = mapped_column(str_enum(JourneyStatus, 10), nullable=False, default=JourneyStatus.PLANNED)
    cancelled_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    cancelled_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    __mapper_args__ = {"version_id_col": version}

    train: Mapped[Train] = relationship(foreign_keys=[train_id], lazy="joined")
    linked_train: Mapped[Train | None] = relationship(foreign_keys=[linked_train_id], lazy="joined")
    supervisor: Mapped[User | None] = relationship(foreign_keys=[supervisor_id], lazy="joined")
    coaches: Mapped[list["JourneyCoach"]] = relationship(
        back_populates="journey", cascade="all, delete-orphan", order_by="JourneyCoach.position"
    )
    legs: Mapped[list["JourneyLeg"]] = relationship(cascade="all, delete-orphan", order_by="JourneyLeg.direction")
    feedback_targets: Mapped[list["JourneyFeedbackTarget"]] = relationship(
        cascade="all, delete-orphan", order_by="JourneyFeedbackTarget.journey_day"
    )


class JourneyCoach(UUIDPk, Base):
    __tablename__ = "journey_coaches"
    __table_args__ = (UniqueConstraint("journey_id", "code"),)

    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    classification: Mapped[CoachClass] = mapped_column(str_enum(CoachClass, 8), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    journey: Mapped[Journey] = relationship(back_populates="coaches")


class JourneyLeg(UUIDPk, Base):
    """One direction of a journey (migration 0020; app/services/feedback_plan.py): 1 = outbound with the
    journey's train, 2 = back with its linked (return) train. Each leg carries its own dates, the journey
    days it covers and a snapshot of its train's stops, taken from that train's own timetable -- the return
    is never the outbound reversed. The snapshot follows the timetable until the journey starts, then keeps
    the route it actually ran."""

    __tablename__ = "journey_legs"
    __table_args__ = (
        UniqueConstraint("journey_id", "direction"),
        CheckConstraint("direction IN (1, 2)", name="direction_kind"),
        CheckConstraint("first_day >= 1 AND last_day >= first_day", name="day_order"),
        CheckConstraint("arrives_on >= departs_on", name="date_order"),
    )

    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id", ondelete="CASCADE"), nullable=False)
    direction: Mapped[int] = mapped_column(Integer, nullable=False)
    train_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trains.id", ondelete="SET NULL"))
    train_no: Mapped[str] = mapped_column(String(15), nullable=False)
    train_name: Mapped[str | None] = mapped_column(String(100))
    origin_code: Mapped[str | None] = mapped_column(String(8))
    origin_name: Mapped[str | None] = mapped_column(String(120))
    destination_code: Mapped[str | None] = mapped_column(String(8))
    destination_name: Mapped[str | None] = mapped_column(String(120))
    departs_on: Mapped[date] = mapped_column(Date, nullable=False)
    departs_at: Mapped[time | None] = mapped_column(Time)
    arrives_on: Mapped[date] = mapped_column(Date, nullable=False)
    arrives_at: Mapped[time | None] = mapped_column(Time)
    first_day: Mapped[int] = mapped_column(Integer, nullable=False)  # journey days this leg runs on
    last_day: Mapped[int] = mapped_column(Integer, nullable=False)
    # [{seq, code, name, arrival, departure, date, journey_day}] -- empty when the timetable was never read.
    stops: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    schedule_hash: Mapped[str | None] = mapped_column(String(64))
    generated_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)


class JourneyFeedbackTarget(UUIDPk, Base):
    """The passenger feedback a journey needs on one journey day (migration 0020), from its train's Train
    Master configuration. Submitted / verified / pending figures are never stored: they are counted from the
    feedback records, so they cannot drift. A day that has begun keeps its target when the master changes;
    days still ahead follow it (app/services/feedback_plan.py)."""

    __tablename__ = "journey_feedback_targets"
    __table_args__ = (
        UniqueConstraint("journey_id", "journey_day"),
        CheckConstraint("journey_day >= 1", name="day_positive"),
        CheckConstraint("required >= 0", name="required_positive"),
        CheckConstraint("direction IS NULL OR direction IN (1, 2, 3)", name="direction_kind"),
    )

    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id", ondelete="CASCADE"), nullable=False)
    journey_day: Mapped[int] = mapped_column(Integer, nullable=False)
    day_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # 1 outbound, 2 return, 3 both (the train turns round that day), None = layover (no leg runs).
    direction: Mapped[int | None] = mapped_column(Integer)
    # The train numbers a passenger on this day may hold a PNR for ("12951" or "12951,12952").
    train_nos: Mapped[str | None] = mapped_column(String(40))
    required: Mapped[int] = mapped_column(Integer, nullable=False)
    coach_required: Mapped[int | None] = mapped_column(Integer)
    minimum: Mapped[int | None] = mapped_column(Integer)
    generated_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)


class StaffAllocation(UUIDPk, Timestamps, Base):
    __tablename__ = "staff_allocations"
    __table_args__ = (
        Index(
            "uq_staff_allocations_live",
            "journey_id",
            "user_id",
            unique=True,
            postgresql_where=text("removed_at IS NULL"), sqlite_where=text("removed_at IS NULL"),
        ),
    )

    journey_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journeys.id"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), nullable=False)
    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False)
    allocated_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    removed_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    removed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="joined")
