"""Role rights per office: a role_permissions row may now be scoped to a client (office).

Revision ID: 0014
Revises: 0013

A right is decided most-specific first: a division override, else an office (client) override, else the
global grant. Until now only the first and last existed, so making a role differ between two offices meant
repeating the same override in every division of one of them.

A row is global (client_id and division_id both NULL), office-wide (client_id set) or division-only
(division_id set) -- never both, which a CHECK enforces. The uniqueness index gains client_id so an office
row and the global row for the same (role, permission) do not collide.
"""
import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def _sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def _scope_index(columns: list[str]) -> None:
    if _sqlite():
        # SQLite has no NULLS NOT DISTINCT; coalescing NULL to '' gives the same "one global row" rule.
        cols = ["role_id", "permission_code", *(sa.text(f"coalesce({c}, '')") for c in columns)]
        op.create_index("uq_role_permissions_scope", "role_permissions", cols, unique=True)
    else:
        op.create_index("uq_role_permissions_scope", "role_permissions", ["role_id", "permission_code", *columns],
                        unique=True, postgresql_nulls_not_distinct=True)


def upgrade() -> None:
    op.drop_index("uq_role_permissions_scope", table_name="role_permissions")
    with op.batch_alter_table("role_permissions") as batch:
        batch.add_column(sa.Column("client_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(op.f("fk_role_permissions_client_id_clients"), "clients", ["client_id"], ["id"])
        batch.create_check_constraint(op.f("ck_role_permissions_one_scope"),
                                      "client_id IS NULL OR division_id IS NULL")
    _scope_index(["client_id", "division_id"])


def downgrade() -> None:
    # Office rows have no place in the old scheme; dropping them returns each office to the global grants.
    op.execute("DELETE FROM role_permissions WHERE client_id IS NOT NULL")
    op.drop_index("uq_role_permissions_scope", table_name="role_permissions")
    with op.batch_alter_table("role_permissions") as batch:
        batch.drop_constraint(op.f("ck_role_permissions_one_scope"), type_="check")
        batch.drop_constraint(op.f("fk_role_permissions_client_id_clients"), type_="foreignkey")
        batch.drop_column("client_id")
    _scope_index(["division_id"])
