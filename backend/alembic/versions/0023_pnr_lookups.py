"""Stored PNR answers: pnr_lookups keeps the last answer a PNR provider (RailRadar, else RapidAPI) gave for a
PNR until it expires, so the same PNR is not fetched again (app/services/pnr_cache.py).

Revision ID: 0023
Revises: 0022
"""
import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pnr_lookups",
        sa.Column("pnr", sa.String(length=10), nullable=False),
        sa.Column("found", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=True),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("hits", sa.Integer(), server_default="0", nullable=False),
        sa.PrimaryKeyConstraint("pnr", name=op.f("pk_pnr_lookups")),
    )
    op.create_index(op.f("ix_pnr_lookups_expires_at"), "pnr_lookups", ["expires_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_pnr_lookups_expires_at"), table_name="pnr_lookups")
    op.drop_table("pnr_lookups")
