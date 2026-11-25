import uuid
from datetime import datetime, time
from enum import StrEnum

from sqlalchemy import JSON, Boolean, CheckConstraint, ForeignKey, Index, Integer, Numeric, String, Time, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, TZDateTime, UUIDPk, str_enum


class CoachClass(StrEnum):
    AC = "AC"
    NON_AC = "NON_AC"
    GEN = "GEN"  # General (unreserved): its own feedback questions


class Train(UUIDPk, Timestamps, Base):
    __tablename__ = "trains"
    __table_args__ = (
        UniqueConstraint("division_id", "train_no"),
        CheckConstraint("duration_days >= 0 AND duration_days <= 15", name="duration_range"),
        CheckConstraint("operational_days >= 1 AND operational_days <= 30", name="operational_days_range"),
        CheckConstraint("inspection_rounds_per_day >= 1 AND inspection_rounds_per_day <= 20", name="rounds_range"),
        CheckConstraint("before_inspection_enabled OR after_inspection_enabled", name="some_phase_enabled"),
        CheckConstraint("arrival_days IS NULL OR (arrival_days >= 0 AND arrival_days <= 7)", name="arrival_days_range"),
        # ---- passenger feedback configuration (migration 0020) ----
        CheckConstraint("feedback_daily_target IS NULL OR (feedback_daily_target >= 1 AND feedback_daily_target <= 500)",
                        name="feedback_daily_target_range"),
        CheckConstraint("feedback_coach_daily_target IS NULL OR "
                        "(feedback_coach_daily_target >= 1 AND feedback_coach_daily_target <= 100)",
                        name="feedback_coach_target_range"),
        CheckConstraint("feedback_min_daily IS NULL OR (feedback_min_daily >= 1 AND (feedback_daily_target IS NULL "
                        "OR feedback_min_daily <= feedback_daily_target))", name="feedback_min_daily_range"),
        CheckConstraint("feedback_from_day >= 1 AND feedback_from_day <= 30", name="feedback_from_day_range"),
        CheckConstraint("feedback_to_day IS NULL OR (feedback_to_day >= feedback_from_day AND feedback_to_day <= 30)",
                        name="feedback_to_day_range"),
        CheckConstraint("feedback_days IN ('all', 'running')", name="feedback_days_kind"),
    )

    division_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("divisions.id"), nullable=False, index=True)
    train_no: Mapped[str] = mapped_column(String(15), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Days from departure to the start of the linked/return leg.
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False)
    # Number of operational journey days for inspections/feedback (day 1..N).
    operational_days: Mapped[int] = mapped_column(Integer, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    return_start_time: Mapped[time | None] = mapped_column(Time)
    return_end_time: Mapped[time | None] = mapped_column(Time)
    daywise: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    inspection_rounds_per_day: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    before_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    after_inspection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # ---- from RailRadar (migration 0017) ----
    origin_code: Mapped[str | None] = mapped_column(String(8))
    destination_code: Mapped[str | None] = mapped_column(String(8))
    destination_name: Mapped[str | None] = mapped_column(String(120))
    # "mon,tue,..."; None = not known, so journeys are planned every day.
    run_days: Mapped[str | None] = mapped_column(String(27))
    # Journeys are created for this train every day, a few days ahead (services/railway.plan_journeys).
    auto_journeys: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    # ---- from RailRadar's train-status page (migration 0019) ----
    # Days after departure that it reaches its last station (0 = same day); None = schedule not read yet.
    arrival_days: Mapped[int | None] = mapped_column(Integer)
    # The train that makes the return trip, kept as a train of the same division (journeys link it).
    return_train_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trains.id", ondelete="SET NULL"))
    return_train: Mapped["Train | None"] = relationship(remote_side="Train.id", foreign_keys=[return_train_id])

    # ---- passenger feedback configuration (migration 0020; app/services/feedback_plan.py) ----
    # Whether staff may collect passenger feedback on this train's journeys at all.
    feedback_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    # Passenger feedback required on each journey day, the whole train together. None = no target.
    feedback_daily_target: Mapped[int | None] = mapped_column(Integer)
    # Optional target per coach and journey day. A separate setting from the daily target: 10 a day across
    # the train is not 10 a day in every coach.
    feedback_coach_daily_target: Mapped[int | None] = mapped_column(Integer)
    # Optional floor: a day under it is reported "short"; between it and the target, "partial".
    feedback_min_daily: Mapped[int | None] = mapped_column(Integer)
    # Collection window in journey days (1 = the departure day). Outside it nothing is collected or targeted.
    feedback_from_day: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    feedback_to_day: Mapped[int | None] = mapped_column(Integer)
    # "all": every journey day carries the target. "running": only days on which a leg of the trip runs (a
    # layover day at the far end, with no train moving, carries none).
    feedback_days: Mapped[str] = mapped_column(String(10), nullable=False, default="all", server_default="all")
    # Configuration status. False: journeys carry no targets for this train (feedback may still be taken).
    feedback_targets_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")

    # ---- the timetable read from RailRadar (migration 0020; app/services/timetable.py) ----
    schedule_status: Mapped[str | None] = mapped_column(String(10))  # ok | failed | rejected; None = never read
    schedule_synced_at: Mapped[datetime | None] = mapped_column(TZDateTime())   # last successful read
    schedule_checked_at: Mapped[datetime | None] = mapped_column(TZDateTime())  # last attempt
    schedule_error: Mapped[str | None] = mapped_column(String(300))
    schedule_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")  # in a row
    # sha256 of the validated stops and run days: a refresh that reads the same hash changes nothing.
    schedule_hash: Mapped[str | None] = mapped_column(String(64))
    distance_km: Mapped[float | None] = mapped_column(Numeric(7, 1, asdecimal=False))
    duration_minutes: Mapped[int | None] = mapped_column(Integer)

    coaches: Mapped[list["TrainCoach"]] = relationship(
        back_populates="train", cascade="all, delete-orphan", order_by="TrainCoach.position"
    )
    stops: Mapped[list["TrainStop"]] = relationship(
        back_populates="train", cascade="all, delete-orphan", order_by="TrainStop.seq"
    )

    @property
    def return_train_no(self) -> str | None:
        return self.return_train.train_no if self.return_train is not None else None

    @property
    def origin_name(self) -> str | None:
        return self.stops[0].station_name if self.stops else None


class TrainCoach(UUIDPk, Base):
    __tablename__ = "train_coaches"
    __table_args__ = (UniqueConstraint("train_id", "code"), UniqueConstraint("train_id", "position"))

    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    classification: Mapped[CoachClass] = mapped_column(str_enum(CoachClass, 8), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    train: Mapped[Train] = relationship(back_populates="coaches")


class TrainStop(UUIDPk, Base):
    """One halt of a train's timetable, in route order (migration 0020). Only the stations the train stops
    at are kept, under RailRadar's route sequence number, so a station the route visits twice appears twice.
    `arrival_day` / `departure_day` count from the day the train leaves its first station (1): a run past
    midnight keeps its dates."""

    __tablename__ = "train_stops"
    __table_args__ = (
        UniqueConstraint("train_id", "seq"),
        CheckConstraint("arrival_day IS NULL OR (arrival_day >= 1 AND arrival_day <= 10)", name="arrival_day_range"),
        CheckConstraint("departure_day IS NULL OR (departure_day >= 1 AND departure_day <= 10)",
                        name="departure_day_range"),
    )

    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    station_code: Mapped[str] = mapped_column(String(8), nullable=False)
    station_name: Mapped[str | None] = mapped_column(String(120))
    arrival: Mapped[time | None] = mapped_column(Time)    # None at the first station
    departure: Mapped[time | None] = mapped_column(Time)  # None at the last station
    arrival_day: Mapped[int | None] = mapped_column(Integer)
    departure_day: Mapped[int | None] = mapped_column(Integer)
    distance_km: Mapped[float | None] = mapped_column(Numeric(7, 1, asdecimal=False))
    platform: Mapped[str | None] = mapped_column(String(8))

    train: Mapped[Train] = relationship(back_populates="stops")

    @property
    def day(self) -> int:
        """The day of the run the train is at this station (its arrival, or its departure at the first)."""
        return self.arrival_day or self.departure_day or 1

    @property
    def halt_minutes(self) -> int | None:
        if self.arrival is None or self.departure is None:
            return None
        a = self.arrival.hour * 60 + self.arrival.minute
        d = self.departure.hour * 60 + self.departure.minute + ((self.departure_day or self.day) - self.day) * 1440
        return max(d - a, 0)


class TrainSyncRun(UUIDPk, Base):
    """One attempt to read a train's timetable: the extraction log (migration 0020). outcome: updated (the
    timetable changed and was saved), unchanged, failed (RailRadar could not be read; the timetable kept),
    rejected (read, but incomplete or inconsistent; the timetable kept)."""

    __tablename__ = "train_sync_runs"
    __table_args__ = (Index("ix_train_sync_runs_train_started", "train_id", "started_at"),)

    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id", ondelete="CASCADE"), nullable=False)
    train_no: Mapped[str] = mapped_column(String(15), nullable=False)
    trigger: Mapped[str] = mapped_column(String(10), nullable=False)  # manual | bulk | scheduled | retry | setup
    started_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    finished_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    outcome: Mapped[str] = mapped_column(String(10), nullable=False)
    error_kind: Mapped[str | None] = mapped_column(String(20))
    message: Mapped[str | None] = mapped_column(String(300))
    changes: Mapped[dict | None] = mapped_column(JSON)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
