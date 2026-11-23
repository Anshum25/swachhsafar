"""Railway stations, a client's state and city, trains from RailRadar, and journeys planned automatically.

Revision ID: 0017
Revises: 0016

A client (office) is sold for one state and city, which the Super Admin sets. The client's Admin then picks
that city's stations and the trains that start at them (from RailRadar's station timetables), and journeys
are created for those trains a few days ahead, every day (app/services/railway.py plan_journeys).

- railway_stations: the station list (code, name, city, state, metro) loaded from app/data/railway_stations.json.
  The data merges api-allwin/Indian_Railway_Stations and DataMeet's railways dataset (ODbL: attribution
  required before redistribution or commercial use).
- railway_boards: each station's RailRadar timetable, cached, so the wizard does not ask RailRadar again
  for every person who opens it.
- clients: state, city (set by the Super Admin) and setup_completed_at.
- divisions: station_code, the railway station a division stands for.
- trains: where the train starts and ends, the days it runs, and whether journeys are planned for it.
- journeys: supervisor_id and created_by_id may be empty (a planned journey has neither until someone
  assigns a supervisor); auto_created; charged -- a planned journey is paid for on its start day, not when
  it is planned. Every journey that exists already was charged when it was created, so the column
  starts true.
"""
import json
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

DATA = Path(__file__).resolve().parents[2] / "app" / "data" / "railway_stations.json"


def _sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def upgrade() -> None:
    stations = op.create_table(
        "railway_stations",
        sa.Column("code", sa.String(length=8), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("city", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("state", sa.String(length=60), nullable=False, server_default=""),
        sa.Column("metro", sa.String(length=60), nullable=True),
        sa.PrimaryKeyConstraint("code", name=op.f("pk_railway_stations")),
    )
    op.create_index("ix_railway_stations_state_city", "railway_stations", ["state", "city"])
    op.create_index("ix_railway_stations_metro", "railway_stations", ["metro"])
    data = json.loads(DATA.read_text(encoding="utf-8"))
    op.bulk_insert(stations, [dict(zip(data["columns"], row, strict=True)) for row in data["rows"]])

    op.create_table(
        "railway_boards",
        sa.Column("station_code", sa.String(length=8), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("station_name", sa.String(length=120), nullable=True),
        sa.Column("trains", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("station_code", name=op.f("pk_railway_boards")),
    )

    with op.batch_alter_table("clients") as batch:
        batch.add_column(sa.Column("state", sa.String(length=60), nullable=True))
        batch.add_column(sa.Column("city", sa.String(length=100), nullable=True))
        batch.add_column(sa.Column("setup_completed_at", sa.DateTime(timezone=True), nullable=True))

    with op.batch_alter_table("divisions") as batch:
        batch.add_column(sa.Column("station_code", sa.String(length=8), nullable=True))
    # One division per railway station per office; divisions that are not a station (NULL) do not collide.
    op.create_index("uq_divisions_client_station", "divisions", ["client_id", "station_code"], unique=True)

    with op.batch_alter_table("trains") as batch:
        batch.add_column(sa.Column("origin_code", sa.String(length=8), nullable=True))
        batch.add_column(sa.Column("destination_code", sa.String(length=8), nullable=True))
        batch.add_column(sa.Column("destination_name", sa.String(length=120), nullable=True))
        # "mon,tue,..." as RailRadar publishes them; NULL = not known, planned every day.
        batch.add_column(sa.Column("run_days", sa.String(length=27), nullable=True))
        batch.add_column(sa.Column("auto_journeys", sa.Boolean(), nullable=False, server_default=sa.false()))

    with op.batch_alter_table("journeys") as batch:
        batch.alter_column("supervisor_id", existing_type=sa.Uuid(), nullable=True)
        batch.alter_column("created_by_id", existing_type=sa.Uuid(), nullable=True)
        batch.add_column(sa.Column("auto_created", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("charged", sa.Boolean(), nullable=False, server_default=sa.true()))
    # The planner runs every day and may run twice: at most one planned journey per train per day.
    op.create_index("uq_journeys_auto_train_date", "journeys", ["train_id", "journey_date"], unique=True,
                    postgresql_where=sa.text("auto_created"), sqlite_where=sa.text("auto_created"))


def downgrade() -> None:
    # Planned journeys may have no supervisor or creator, which the old schema cannot hold: they go.
    bind = op.get_bind()
    bind.execute(sa.text("DELETE FROM journey_coaches WHERE journey_id IN (SELECT id FROM journeys WHERE auto_created)"))
    bind.execute(sa.text("DELETE FROM staff_allocations WHERE journey_id IN (SELECT id FROM journeys WHERE auto_created)"))
    bind.execute(sa.text("DELETE FROM journeys WHERE auto_created"))
    op.drop_index("uq_journeys_auto_train_date", table_name="journeys")
    with op.batch_alter_table("journeys") as batch:
        batch.drop_column("charged")
        batch.drop_column("auto_created")
        batch.alter_column("created_by_id", existing_type=sa.Uuid(), nullable=False)
        batch.alter_column("supervisor_id", existing_type=sa.Uuid(), nullable=False)
    with op.batch_alter_table("trains") as batch:
        for col in ("auto_journeys", "run_days", "destination_name", "destination_code", "origin_code"):
            batch.drop_column(col)
    op.drop_index("uq_divisions_client_station", table_name="divisions")
    with op.batch_alter_table("divisions") as batch:
        batch.drop_column("station_code")
    with op.batch_alter_table("clients") as batch:
        for col in ("setup_completed_at", "city", "state"):
            batch.drop_column(col)
    op.drop_table("railway_boards")
    op.drop_index("ix_railway_stations_metro", table_name="railway_stations")
    op.drop_index("ix_railway_stations_state_city", table_name="railway_stations")
    op.drop_table("railway_stations")
