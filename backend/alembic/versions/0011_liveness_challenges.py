"""Server-issued single-use liveness challenges for face attendance.

Additive only: a new table. Existing attendance rows, face registrations and policies are untouched.

Revision ID: 0011
Revises: 0010
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "liveness_challenges",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.String(length=64), nullable=True),
        sa.Column("actions", JSONType, nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attendance_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_liveness_challenges_user_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_liveness_challenges"),
        sa.UniqueConstraint("attendance_id", name="uq_liveness_challenges_attendance_id"),
    )
    op.create_index("ix_liveness_challenges_owner_open", "liveness_challenges", ["user_id", "device_id", "consumed_at"])


def downgrade() -> None:
    op.drop_index("ix_liveness_challenges_owner_open", table_name="liveness_challenges")
    op.drop_table("liveness_challenges")
