"""Drop the jobs table: the temporary Jobs module (0010) has been removed from the code.

Revision ID: 0016
Revises: 0015

The Job model went in "Take the Jobs module out again", which left its table standing until a migration could
follow. A table that is in the database but not in the models is not harmless: jobs.created_by_id and
jobs.updated_by_id reference users, so anything that empties `users` -- the test suite truncates every
model table between tests -- is refused by PostgreSQL. Nothing reads or writes jobs any more, so its rows
(test tasks for checking server -> phone sync) are dropped with it.

Downgrade recreates the empty table exactly as 0010 made it.
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.drop_index(op.f("ix_jobs_updated_at"), table_name="jobs")
    op.drop_table("jobs")


def downgrade() -> None:
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
