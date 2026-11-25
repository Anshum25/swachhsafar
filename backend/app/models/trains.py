import uuid
from datetime import time
from enum import StrEnum

from sqlalchemy import JSON, Boolean, CheckConstraint, ForeignKey, Integer, String, Time, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, str_enum

# The most intermediate attendance stations a train can ask for (Source and End come on top).
MAX_ATTENDANCE_STATIONS = 50


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
        CheckConstraint(f"attendance_station_count IS NULL OR "
                        f"(attendance_station_count >= 1 AND attendance_station_count <= {MAX_ATTENDANCE_STATIONS})",
                        name="attendance_station_count_range"),
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
    # ---- station-wise attendance (migration 0021) ----
    # The stations the train halts at, in running order, as RailRadar's schedule gives them:
    # [{"code": "ADI", "name": "Ahmedabad Jn"}, ...]. None = not read yet.
    route_stations: Mapped[list | None] = mapped_column(JSON)
    # How many intermediate stations attendance is taken at, and which (route codes, kept in route order).
    # Both None = not configured: journeys use the original five stages (services/trains.LEGACY_STAGES).
    attendance_station_count: Mapped[int | None] = mapped_column(Integer)
    attendance_station_codes: Mapped[list | None] = mapped_column(JSON)

    coaches: Mapped[list["TrainCoach"]] = relationship(
        back_populates="train", cascade="all, delete-orphan", order_by="TrainCoach.position"
    )


class TrainCoach(UUIDPk, Base):
    __tablename__ = "train_coaches"
    __table_args__ = (UniqueConstraint("train_id", "code"), UniqueConstraint("train_id", "position"))

    train_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trains.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    classification: Mapped[CoachClass] = mapped_column(str_enum(CoachClass, 8), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    train: Mapped[Train] = relationship(back_populates="coaches")
    