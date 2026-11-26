"""Where each attendance was taken against its stretch of the route.

Revision ID: 0026
Revises: 0025

attendance.route_check: {status, off_route_km, along_km} from services/route_window.check -- inside the
stage's window (its station to its "valid until" station), before or after it, or off the route. NULL on
records taken before, on legacy stages, and where the division's attendance_route_check is "off".
Station locations are reference data shipped with the app (app/data/station_locations.json), not a table.
"""
import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance") as batch:
        batch.add_column(sa.Column("route_check", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("attendance") as batch:
        batch.drop_column("route_check")
