"""Fingerprint verification of attendance: fingerprint_enrollments (minutiae templates only) and
attendance.fingerprint_score/matcher/finger.

Revision ID: 0006
Revises: 0005
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "fingerprint_enrollments",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", name="fk_fingerprint_enrollments_user_id_users"), primary_key=True),
        sa.Column("division_id", sa.Uuid(),
                  sa.ForeignKey("divisions.id", name="fk_fingerprint_enrollments_division_id_divisions"), nullable=False),
        sa.Column("format", sa.String(40), nullable=False),
        sa.Column("matcher", sa.String(40), nullable=False),
        sa.Column("fingers", JSONType, nullable=False),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consent_recorded_by_id", sa.Uuid(),
                  sa.ForeignKey("users.id", name="fk_fingerprint_enrollments_consent_recorded_by_id_users"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_fingerprint_enrollments_division_id", "fingerprint_enrollments", ["division_id"])
    with op.batch_alter_table("attendance") as batch:
        batch.add_column(sa.Column("fingerprint_score", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("fingerprint_matcher", sa.String(40), nullable=True))
        batch.add_column(sa.Column("fingerprint_finger", sa.String(20), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("attendance") as batch:
        batch.drop_column("fingerprint_finger")
        batch.drop_column("fingerprint_matcher")
        batch.drop_column("fingerprint_score")
    op.drop_index("ix_fingerprint_enrollments_division_id", table_name="fingerprint_enrollments")
    op.drop_table("fingerprint_enrollments")
