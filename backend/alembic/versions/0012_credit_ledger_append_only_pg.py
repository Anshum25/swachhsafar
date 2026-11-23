"""credit_ledger is append-only on PostgreSQL too.

Revision ID: 0012
Revises: 0011

0011 guarded credit_ledger against UPDATE and DELETE with triggers on SQLite only; its comment promised
PostgreSQL the same in 0002's style, but nothing was created there, so a ledger row could be rewritten in
place. This attaches 0002's `forbid_mutation()` trigger to it. A new revision rather than an edit to 0011,
so databases that have already run 0011 get the guard as well.
"""
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def _postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    if _postgres():
        op.execute(
            "CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger "
            "FOR EACH ROW EXECUTE FUNCTION forbid_mutation()"
        )


def downgrade() -> None:
    if _postgres():
        op.execute("DROP TRIGGER IF EXISTS credit_ledger_append_only ON credit_ledger")
