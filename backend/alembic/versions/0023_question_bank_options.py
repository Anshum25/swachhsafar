"""Question banks can name their answer choices (Poor … Excellent), shown as faces instead of numbers.

Revision ID: 0023
Revises: 0022

question_banks.option_labels: the choices, worst first. Choice k is stored as rating scale_min + k, so
existing ratings, reports and PSI are unchanged. NULL on existing banks = the numbered scale as before.
"""
import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("question_banks") as batch:
        batch.add_column(sa.Column("option_labels", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("question_banks") as batch:
        batch.drop_column("option_labels")
