"""Jobs: a shared task list used to test server -> phone sync (TEMPORARY; see app/models/jobs.py).

Revision ID: 0010
Revises: 0009
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=True),
        sa.Column("location", sa.String(length=60), nullable=True),
        sa.Column("priority", sa.String(length=8), nullable=False, server_default="medium"),
        sa.Column("status", sa.String(length=12), nullable=False, server_default="open"),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("extra", JSONType, nullable=False, server_default=sa.text("'{}'")),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by_id", sa.Uuid(), nullable=True),
        sa.Column("updated_by_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("priority IN ('low', 'medium', 'high')", name="ck_jobs_priority_valid"),
        sa.CheckConstraint("status IN ('open', 'in_progress', 'done')", name="ck_jobs_status_valid"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], name="fk_jobs_created_by_id_users"),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], name="fk_jobs_updated_by_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_jobs"),
    )
    op.create_index(op.f("ix_jobs_updated_at"), "jobs", ["updated_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_jobs_updated_at"), table_name="jobs")
    op.drop_table("jobs")
