"""Group photo attendance: attendance.identified_by records how identity was established, so a record
named out of one group photograph is never counted as a live per-person face check.

Revision ID: 0007
Revises: 0006
"""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance") as batch:
        batch.add_column(sa.Column("identified_by", sa.String(20), nullable=True))
    # Records made before this column existed: a face distance or a fingerprint score says how each one
    # was verified, and nothing else could have been a group photo, since there was no way to send one.
    op.execute("UPDATE attendance SET identified_by = 'fingerprint' WHERE fingerprint_score IS NOT NULL")
    op.execute("UPDATE attendance SET identified_by = 'face' WHERE fingerprint_score IS NULL AND face_distance IS NOT NULL")


def downgrade() -> None:
    with op.batch_alter_table("attendance") as batch:
        batch.drop_column("identified_by")
