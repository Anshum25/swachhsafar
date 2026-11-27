"""Inventory can be issued to and returned by a janitor, not only to a coach or the journey.

Revision ID: 0028
Revises: 0027

inventory_transactions.recipient_id: the journey staff member who received an issue or handed back a return.
NULL on every existing transaction (stock went to a coach or the journey). The return limit is per item,
coach and recipient, so a janitor can only hand back what was issued to them.
"""
import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A plain ADD COLUMN, not batch_alter_table: on SQLite a batch rebuilds the table and drops the triggers
    # that keep the ledger append-only. SQLite cannot add a foreign key to an existing table; Postgres gets one.
    op.add_column("inventory_transactions", sa.Column("recipient_id", sa.Uuid(), nullable=True))
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key("fk_inventory_transactions_recipient_id_users", "inventory_transactions", "users",
                              ["recipient_id"], ["id"])


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint("fk_inventory_transactions_recipient_id_users", "inventory_transactions", type_="foreignkey")
    op.drop_column("inventory_transactions", "recipient_id")
