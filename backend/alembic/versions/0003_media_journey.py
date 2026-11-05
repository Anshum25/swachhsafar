"""media_objects.journey_id: the journey a file belongs to, used to file uploads journey-wise.

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_objects") as batch:
        batch.add_column(sa.Column("journey_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key("fk_media_objects_journey_id_journeys", "journeys", ["journey_id"], ["id"])
        batch.create_index("ix_media_objects_journey_id", ["journey_id"])


def downgrade() -> None:
    with op.batch_alter_table("media_objects") as batch:
        batch.drop_index("ix_media_objects_journey_id")
        batch.drop_constraint("fk_media_objects_journey_id_journeys", type_="foreignkey")
        batch.drop_column("journey_id")
