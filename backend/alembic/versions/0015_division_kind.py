"""Divisions have a type (headquarters or station), and role rights can target every division of one type in
an office.

Revision ID: 0015
Revises: 0014

An office has one headquarters and several stations, and a role often needs the same rights at every station
but different ones at headquarters. Without a type that meant one override per station. A role_permissions
row with client_id and division_kind set applies to every division of that kind in that office.

A right is now decided most-specific first: the division's own override, else its kind's in its office, else
its office's, else the global grant.

Existing divisions become stations; the Super Admin marks the headquarters (Master data -> Divisions).
"""
import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

KINDS = "('headquarters', 'station')"


def _sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def _scope_index(columns: list[str]) -> None:
    if _sqlite():
        cols = ["role_id", "permission_code", *(sa.text(f"coalesce({c}, '')") for c in columns)]
        op.create_index("uq_role_permissions_scope", "role_permissions", cols, unique=True)
    else:
        op.create_index("uq_role_permissions_scope", "role_permissions", ["role_id", "permission_code", *columns],
                        unique=True, postgresql_nulls_not_distinct=True)


def upgrade() -> None:
    with op.batch_alter_table("divisions") as batch:
        batch.add_column(sa.Column("kind", sa.String(length=12), nullable=False, server_default="station"))
        batch.create_check_constraint(op.f("ck_divisions_kind_valid"), f"kind IN {KINDS}")

    op.drop_index("uq_role_permissions_scope", table_name="role_permissions")
    with op.batch_alter_table("role_permissions") as batch:
        batch.add_column(sa.Column("division_kind", sa.String(length=12), nullable=True))
        batch.create_check_constraint(op.f("ck_role_permissions_division_kind_valid"),
                                      f"division_kind IS NULL OR division_kind IN {KINDS}")
        # A kind is always within one office, and never alongside a single division.
        batch.create_check_constraint(op.f("ck_role_permissions_kind_scope"),
                                      "division_kind IS NULL OR (client_id IS NOT NULL AND division_id IS NULL)")
    _scope_index(["client_id", "division_kind", "division_id"])


def downgrade() -> None:
    op.execute("DELETE FROM role_permissions WHERE division_kind IS NOT NULL")
    op.drop_index("uq_role_permissions_scope", table_name="role_permissions")
    with op.batch_alter_table("role_permissions") as batch:
        batch.drop_constraint(op.f("ck_role_permissions_kind_scope"), type_="check")
        batch.drop_constraint(op.f("ck_role_permissions_division_kind_valid"), type_="check")
        batch.drop_column("division_kind")
    _scope_index(["client_id", "division_id"])
    with op.batch_alter_table("divisions") as batch:
        batch.drop_constraint(op.f("ck_divisions_kind_valid"), type_="check")
        batch.drop_column("kind")
