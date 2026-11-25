"""Train Master as the source of the passenger feedback lifecycle: feedback targets, full timetables in both
directions, journey legs and per-day feedback targets.

Revision ID: 0022
Revises: 0021

- trains: the passenger feedback configuration (enabled, target per journey day, optional target per coach
  and day, optional daily minimum, collection window, which days carry the target, configuration status) and
  the state of its timetable read from RailRadar (status, last success, last attempt, error, consecutive
  failures, a hash of the validated timetable, distance, duration).
- train_stops: every halt of a train's route, in order, with arrival/departure times and their day of the
  run. A station visited twice is two rows.
- train_sync_runs: the extraction log, one row per attempt to read a train's timetable.
- journey_legs: each direction of a journey (1 outbound, 2 return) with its own dates and a snapshot of its
  own train's stops.
- journey_feedback_targets: the passenger feedback a journey needs on each journey day.
- passenger_feedback: the leg (direction) and train of the day, where the coach came from (picked or the
  PNR), whether the PNR confirmed it, and the ticket's boarding date and stations.

Existing trains keep collecting feedback (feedback_enabled true) and have no target until one is set.
Existing feedback keeps every value it had; the new columns are empty on it.
"""
import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.add_column(sa.Column("feedback_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("feedback_daily_target", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("feedback_coach_daily_target", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("feedback_min_daily", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("feedback_from_day", sa.Integer(), nullable=False, server_default="1"))
        batch.add_column(sa.Column("feedback_to_day", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("feedback_days", sa.String(length=10), nullable=False, server_default="all"))
        batch.add_column(sa.Column("feedback_targets_active", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("schedule_status", sa.String(length=10), nullable=True))
        batch.add_column(sa.Column("schedule_synced_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("schedule_checked_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("schedule_error", sa.String(length=300), nullable=True))
        batch.add_column(sa.Column("schedule_failures", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("schedule_hash", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("distance_km", sa.Numeric(7, 1), nullable=True))
        batch.add_column(sa.Column("duration_minutes", sa.Integer(), nullable=True))
        batch.create_check_constraint(
            op.f("ck_trains_feedback_daily_target_range"),
            "feedback_daily_target IS NULL OR (feedback_daily_target >= 1 AND feedback_daily_target <= 500)")
        batch.create_check_constraint(
            op.f("ck_trains_feedback_coach_target_range"),
            "feedback_coach_daily_target IS NULL OR (feedback_coach_daily_target >= 1 AND feedback_coach_daily_target <= 100)")
        batch.create_check_constraint(
            op.f("ck_trains_feedback_min_daily_range"),
            "feedback_min_daily IS NULL OR (feedback_min_daily >= 1 AND (feedback_daily_target IS NULL "
            "OR feedback_min_daily <= feedback_daily_target))")
        batch.create_check_constraint(op.f("ck_trains_feedback_from_day_range"),
                                      "feedback_from_day >= 1 AND feedback_from_day <= 30")
        batch.create_check_constraint(
            op.f("ck_trains_feedback_to_day_range"),
            "feedback_to_day IS NULL OR (feedback_to_day >= feedback_from_day AND feedback_to_day <= 30)")
        batch.create_check_constraint(op.f("ck_trains_feedback_days_kind"), "feedback_days IN ('all', 'running')")

    op.create_table(
        "train_stops",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("train_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("station_code", sa.String(length=8), nullable=False),
        sa.Column("station_name", sa.String(length=120), nullable=True),
        sa.Column("arrival", sa.Time(), nullable=True),
        sa.Column("departure", sa.Time(), nullable=True),
        sa.Column("arrival_day", sa.Integer(), nullable=True),
        sa.Column("departure_day", sa.Integer(), nullable=True),
        sa.Column("distance_km", sa.Numeric(7, 1), nullable=True),
        sa.Column("platform", sa.String(length=8), nullable=True),
        sa.CheckConstraint("arrival_day IS NULL OR (arrival_day >= 1 AND arrival_day <= 10)",
                           name=op.f("ck_train_stops_arrival_day_range")),
        sa.CheckConstraint("departure_day IS NULL OR (departure_day >= 1 AND departure_day <= 10)",
                           name=op.f("ck_train_stops_departure_day_range")),
        sa.ForeignKeyConstraint(["train_id"], ["trains.id"], name=op.f("fk_train_stops_train_id_trains"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_train_stops")),
        sa.UniqueConstraint("train_id", "seq", name=op.f("uq_train_stops_train_id_seq")),
    )

    op.create_table(
        "train_sync_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("train_id", sa.Uuid(), nullable=False),
        sa.Column("train_no", sa.String(length=15), nullable=False),
        sa.Column("trigger", sa.String(length=10), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("outcome", sa.String(length=10), nullable=False),
        sa.Column("error_kind", sa.String(length=20), nullable=True),
        sa.Column("message", sa.String(length=300), nullable=True),
        sa.Column("changes", sa.JSON(), nullable=True),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["train_id"], ["trains.id"], name=op.f("fk_train_sync_runs_train_id_trains"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], name=op.f("fk_train_sync_runs_actor_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_train_sync_runs")),
    )
    op.create_index("ix_train_sync_runs_train_started", "train_sync_runs", ["train_id", "started_at"])

    op.create_table(
        "journey_legs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("journey_id", sa.Uuid(), nullable=False),
        sa.Column("direction", sa.Integer(), nullable=False),
        sa.Column("train_id", sa.Uuid(), nullable=True),
        sa.Column("train_no", sa.String(length=15), nullable=False),
        sa.Column("train_name", sa.String(length=100), nullable=True),
        sa.Column("origin_code", sa.String(length=8), nullable=True),
        sa.Column("origin_name", sa.String(length=120), nullable=True),
        sa.Column("destination_code", sa.String(length=8), nullable=True),
        sa.Column("destination_name", sa.String(length=120), nullable=True),
        sa.Column("departs_on", sa.Date(), nullable=False),
        sa.Column("departs_at", sa.Time(), nullable=True),
        sa.Column("arrives_on", sa.Date(), nullable=False),
        sa.Column("arrives_at", sa.Time(), nullable=True),
        sa.Column("first_day", sa.Integer(), nullable=False),
        sa.Column("last_day", sa.Integer(), nullable=False),
        sa.Column("stops", sa.JSON(), nullable=False),
        sa.Column("schedule_hash", sa.String(length=64), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("direction IN (1, 2)", name=op.f("ck_journey_legs_direction_kind")),
        sa.CheckConstraint("first_day >= 1 AND last_day >= first_day", name=op.f("ck_journey_legs_day_order")),
        sa.CheckConstraint("arrives_on >= departs_on", name=op.f("ck_journey_legs_date_order")),
        sa.ForeignKeyConstraint(["journey_id"], ["journeys.id"], name=op.f("fk_journey_legs_journey_id_journeys"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["train_id"], ["trains.id"], name=op.f("fk_journey_legs_train_id_trains"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_journey_legs")),
        sa.UniqueConstraint("journey_id", "direction", name=op.f("uq_journey_legs_journey_id_direction")),
    )

    op.create_table(
        "journey_feedback_targets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("journey_id", sa.Uuid(), nullable=False),
        sa.Column("journey_day", sa.Integer(), nullable=False),
        sa.Column("day_date", sa.Date(), nullable=False),
        sa.Column("direction", sa.Integer(), nullable=True),
        sa.Column("train_nos", sa.String(length=40), nullable=True),
        sa.Column("required", sa.Integer(), nullable=False),
        sa.Column("coach_required", sa.Integer(), nullable=True),
        sa.Column("minimum", sa.Integer(), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("journey_day >= 1", name=op.f("ck_journey_feedback_targets_day_positive")),
        sa.CheckConstraint("required >= 0", name=op.f("ck_journey_feedback_targets_required_positive")),
        sa.CheckConstraint("direction IS NULL OR direction IN (1, 2, 3)", name=op.f("ck_journey_feedback_targets_direction_kind")),
        sa.ForeignKeyConstraint(["journey_id"], ["journeys.id"], name=op.f("fk_journey_feedback_targets_journey_id_journeys"),
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_journey_feedback_targets")),
        sa.UniqueConstraint("journey_id", "journey_day", name=op.f("uq_journey_feedback_targets_journey_id_journey_day")),
    )
    op.create_index("ix_journey_feedback_targets_day_date", "journey_feedback_targets", ["day_date"])

    # Plain ADD COLUMNs (no table rebuild on SQLite, where passenger_feedback carries partial indexes).
    op.add_column("passenger_feedback", sa.Column("direction", sa.Integer(), nullable=True))
    op.add_column("passenger_feedback", sa.Column("train_no", sa.String(length=15), nullable=True))
    op.add_column("passenger_feedback", sa.Column("coach_source", sa.String(length=10), nullable=True))
    op.add_column("passenger_feedback", sa.Column("coach_verified", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("passenger_feedback", sa.Column("pnr_journey_date", sa.Date(), nullable=True))
    op.add_column("passenger_feedback", sa.Column("boarding_code", sa.String(length=8), nullable=True))
    op.add_column("passenger_feedback", sa.Column("alighting_code", sa.String(length=8), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("passenger_feedback") as batch:
        for col in ("alighting_code", "boarding_code", "pnr_journey_date", "coach_verified", "coach_source", "train_no",
                    "direction"):
            batch.drop_column(col)
    op.drop_index("ix_journey_feedback_targets_day_date", table_name="journey_feedback_targets")
    op.drop_table("journey_feedback_targets")
    op.drop_table("journey_legs")
    op.drop_index("ix_train_sync_runs_train_started", table_name="train_sync_runs")
    op.drop_table("train_sync_runs")
    op.drop_table("train_stops")
    with op.batch_alter_table("trains") as batch:
        for ck in ("feedback_days_kind", "feedback_to_day_range", "feedback_from_day_range", "feedback_min_daily_range",
                   "feedback_coach_target_range", "feedback_daily_target_range"):
            batch.drop_constraint(op.f(f"ck_trains_{ck}"), type_="check")
        for col in ("duration_minutes", "distance_km", "schedule_hash", "schedule_failures", "schedule_error",
                    "schedule_checked_at", "schedule_synced_at", "schedule_status", "feedback_targets_active",
                    "feedback_days", "feedback_to_day", "feedback_from_day", "feedback_min_daily",
                    "feedback_coach_daily_target", "feedback_daily_target", "feedback_enabled"):
            batch.drop_column(col)
