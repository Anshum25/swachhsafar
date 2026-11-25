"""Station-wise attendance: a train says at which of its route's stations attendance is taken.

Revision ID: 0021
Revises: 0020

Until now every journey had five fixed attendance stages (Source, Enroute 1, Destination, Enroute 2, End).
A train can now name the intermediate stations instead; journeys then have Source, those stations in route
order, and End (services/trains.attendance_plan).

- trains.route_stations: the stations the train halts at, in order, from RailRadar's schedule.
- trains.attendance_station_count / attendance_station_codes: the configuration. Both NULL = not configured,
  and the train's journeys keep the five legacy stages.
- journeys.attendance_stages: the journey's own stage list, a snapshot like its inspection configuration.
  NULL on every existing journey, which means the five legacy stages: nothing already recorded changes.
- attendance.station_code / stage_label: the station and stage name each record was taken at. NULL on
  existing records, which are read against the legacy stages as before.
- attendance.stage loses its 1..5 limit (a configured journey can have more than five stages).

No data is rewritten. Downgrading refuses while any attendance is recorded beyond stage 5.
"""
import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.add_column(sa.Column("route_stations", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("attendance_station_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("attendance_station_codes", sa.JSON(), nullable=True))
        batch.create_check_constraint(
            op.f("ck_trains_attendance_station_count_range"),
            "attendance_station_count IS NULL OR (attendance_station_count >= 1 AND attendance_station_count <= 50)")
    with op.batch_alter_table("journeys") as batch:
        batch.add_column(sa.Column("attendance_stages", sa.JSON(), nullable=True))
    with op.batch_alter_table("attendance") as batch:
        batch.add_column(sa.Column("station_code", sa.String(8), nullable=True))
        batch.add_column(sa.Column("stage_label", sa.String(140), nullable=True))
        batch.drop_constraint(op.f("ck_attendance_stage_range"), type_="check")
        batch.create_check_constraint(op.f("ck_attendance_stage_positive"), "stage >= 1")


def downgrade() -> None:
    beyond = op.get_bind().execute(sa.text("SELECT COUNT(*) FROM attendance WHERE stage > 5")).scalar()
    if beyond:
        raise RuntimeError(f"{beyond} attendance records are beyond stage 5; they would not fit the old limit")
    with op.batch_alter_table("attendance") as batch:
        batch.drop_constraint(op.f("ck_attendance_stage_positive"), type_="check")
        batch.create_check_constraint(op.f("ck_attendance_stage_range"), "stage BETWEEN 1 AND 5")
        batch.drop_column("stage_label")
        batch.drop_column("station_code")
    with op.batch_alter_table("journeys") as batch:
        batch.drop_column("attendance_stages")
    with op.batch_alter_table("trains") as batch:
        batch.drop_constraint(op.f("ck_trains_attendance_station_count_range"), type_="check")
        batch.drop_column("attendance_station_codes")
        batch.drop_column("attendance_station_count")
        batch.drop_column("route_stations")
