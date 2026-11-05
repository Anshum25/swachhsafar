"""Face verification of attendance: face_enrollments (descriptors only) and attendance.face_distance/face_model.

Revision ID: 0004
Revises: 0003
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "face_enrollments",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", name="fk_face_enrollments_user_id_users"), primary_key=True),
        sa.Column("division_id", sa.Uuid(), sa.ForeignKey("divisions.id", name="fk_face_enrollments_division_id_divisions"), nullable=False),
        sa.Column("model", sa.String(40), nullable=False),
        sa.Column("descriptors", JSONType, nullable=False),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consent_recorded_by_id", sa.Uuid(),
                  sa.ForeignKey("users.id", name="fk_face_enrollments_consent_recorded_by_id_users"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_face_enrollments_division_id", "face_enrollments", ["division_id"])
    with op.batch_alter_table("attendance") as batch:
        batch.add_column(sa.Column("face_distance", sa.Float(), nullable=True))
        batch.add_column(sa.Column("face_model", sa.String(40), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("attendance") as batch:
        batch.drop_column("face_model")
        batch.drop_column("face_distance")
    op.drop_index("ix_face_enrollments_division_id", table_name="face_enrollments")
    op.drop_table("face_enrollments")
