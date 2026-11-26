"""How far along the route each station-wise attendance stays open.

Revision ID: 0025
Revises: 0024

trains.attendance_valid_until: {opening station code: last station code}, e.g. {"ADI": "SAU"} keeps the
Ahmedabad attendance open until Sanand. NULL, or a station without an entry, means the attendance stays open
until the halt before the next attendance station (the last attendance: to the end of the route). Journeys
carry the window in their stage list (journeys.attendance_stages: valid_until_code / valid_until_name), so
the phone has it offline. Nothing already recorded changes.
"""
import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.add_column(sa.Column("attendance_valid_until", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.drop_column("attendance_valid_until")
