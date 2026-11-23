"""Clients (offices), their module subscription, and the prepaid credit wallet.

Revision ID: 0011
Revises: 0010

Divisions gain a client. The deployment already has divisions, so one client is created here to own them
all, and it is created with `credit_per_journey = 0`: no existing deployment starts refusing journeys
because a wallet it never had is empty. The super admin sets a real rate when billing starts.

New permissions (the catalog in app/security/catalog.py is the source; this migration is its snapshot):
  clients.read    see clients, their modules and their balance
  clients.manage  create and modify clients and their module subscription
  credits.manage  add credits, set the per-journey rate, adjust a balance
Only Super Admin is granted the two managing ones -- an administrator must not top up their own wallet.
"""
import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")

NEW_PERMISSIONS = [
    ("clients.read", "admin", "View clients, their modules and credit balance"),
    ("clients.manage", "admin", "Create and modify clients and their module subscription"),
    ("credits.manage", "admin", "Add credits, set the per-journey rate, adjust a balance"),
]

# role_id -> the new permissions that role gets. Super Admin (1) holds everything; Admin (2) may look at
# the wallet but never fill it.
NEW_GRANTS = {1: ["clients.read", "clients.manage", "credits.manage"], 2: ["clients.read"]}

# What the one backfilled client is subscribed to: everything, so nothing a running deployment does stops.
ALL_GATEABLE = ["attendance", "inspections", "feedback", "complaints", "inventory", "reports"]

DEFAULT_OFFICE_ID = "OFF-001"
DEFAULT_CLIENT_NAME = "Default Office"


def _sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def _now():
    return sa.text("(strftime('%Y-%m-%d %H:%M:%f', 'now'))") if _sqlite() else sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "clients",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("office_id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("contact_name", sa.String(length=100), nullable=True),
        sa.Column("contact_mobile", sa.String(length=10), nullable=True),
        sa.Column("contact_email", sa.String(length=254), nullable=True),
        sa.Column("gstin", sa.String(length=15), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=10), nullable=False, server_default="active"),
        sa.Column("enabled_modules", JSONType, nullable=False, server_default=sa.text("'[]'")),
        sa.Column("credit_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("credit_per_journey", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("low_credit_threshold", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("credit_balance >= 0", name=op.f("ck_clients_credit_balance_non_negative")),
        sa.CheckConstraint("credit_per_journey >= 0", name=op.f("ck_clients_credit_rate_non_negative")),
        sa.CheckConstraint("status IN ('active', 'suspended')", name=op.f("ck_clients_status_valid")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_clients")),
        sa.UniqueConstraint("office_id", name=op.f("uq_clients_office_id")),
    )
    op.create_index(op.f("ix_clients_status"), "clients", ["status"])
    op.create_index(op.f("ix_clients_updated_at"), "clients", ["updated_at"])

    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=20), nullable=False),
        sa.Column("journey_id", sa.Uuid(), nullable=True),
        sa.Column("reference", sa.String(length=100), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.Uuid(), nullable=True),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.CheckConstraint("delta <> 0", name=op.f("ck_credit_ledger_delta_non_zero")),
        sa.CheckConstraint(
            "reason IN ('top_up', 'journey_charge', 'journey_refund', 'adjustment')",
            name=op.f("ck_credit_ledger_reason_valid"),
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], name=op.f("fk_credit_ledger_client_id_clients")),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], name=op.f("fk_credit_ledger_created_by_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_credit_ledger")),
    )
    op.create_index(op.f("ix_credit_ledger_created_at"), "credit_ledger", ["created_at"])
    op.create_index("ix_credit_ledger_client_created", "credit_ledger", ["client_id", "created_at"])
    # One charge and one refund per journey, however often a caller retries.
    op.create_index("uq_credit_ledger_journey_reason", "credit_ledger", ["journey_id", "reason"], unique=True)

    # The ledger records how a balance got where it is and is never rewritten. SQLite's triggers are here;
    # PostgreSQL's forbid_mutation() trigger is attached in 0012.
    if _sqlite():
        for event in ("UPDATE", "DELETE"):
            op.execute(
                f"CREATE TRIGGER trg_credit_ledger_no_{event.lower()} BEFORE {event} ON credit_ledger "
                f"BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END"
            )

    # ---- divisions belong to a client -------------------------------------------------------------------
    op.add_column("divisions", sa.Column("client_id", sa.Uuid(), nullable=True))

    clients = sa.table(
        "clients",
        sa.column("id", sa.Uuid),
        sa.column("office_id", sa.String),
        sa.column("name", sa.String),
        sa.column("status", sa.String),
        sa.column("enabled_modules", JSONType),
        sa.column("credit_balance", sa.Integer),
        sa.column("credit_per_journey", sa.Integer),
        sa.column("low_credit_threshold", sa.Integer),
    )
    bind = op.get_bind()
    division_count = bind.scalar(sa.text("SELECT count(*) FROM divisions")) or 0
    if division_count:
        default_id = uuid.uuid4()
        op.bulk_insert(
            clients,
            [
                dict(
                    id=default_id,
                    office_id=DEFAULT_OFFICE_ID,
                    name=DEFAULT_CLIENT_NAME,
                    status="active",
                    enabled_modules=ALL_GATEABLE,
                    credit_balance=0,
                    # 0 = journeys cost nothing. An existing deployment must not begin refusing journeys
                    # the moment this migration runs; the super admin sets the real rate when billing starts.
                    credit_per_journey=0,
                    low_credit_threshold=0,
                )
            ],
        )
        bind.execute(sa.text("UPDATE divisions SET client_id = :cid WHERE client_id IS NULL").bindparams(cid=default_id))

    with op.batch_alter_table("divisions") as batch:
        batch.alter_column("client_id", existing_type=sa.Uuid(), nullable=False)
        batch.create_foreign_key(op.f("fk_divisions_client_id_clients"), "clients", ["client_id"], ["id"])
    op.create_index(op.f("ix_divisions_client_id"), "divisions", ["client_id"])

    # ---- permission catalog ------------------------------------------------------------------------------
    perms = sa.table("permissions", sa.column("code", sa.String), sa.column("module", sa.String), sa.column("description", sa.String))
    grants = sa.table(
        "role_permissions",
        sa.column("id", sa.Uuid),
        sa.column("role_id", sa.Integer),
        sa.column("permission_code", sa.String),
        sa.column("division_id", sa.Uuid),
        sa.column("effect", sa.String),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    # Inserted only where missing. Migration 0002 seeds the catalog by importing app.security.catalog, so
    # a database created after this commit already has these three rows and their grants; one created
    # before it does not. The same migration has to be right for both.
    existing_perms = set(bind.scalars(sa.text("SELECT code FROM permissions")))
    missing = [dict(code=c, module=m, description=d) for c, m, d in NEW_PERMISSIONS if c not in existing_perms]
    if missing:
        op.bulk_insert(perms, missing)

    existing_grants = set(
        bind.execute(sa.text("SELECT role_id, permission_code FROM role_permissions WHERE division_id IS NULL")).all()
    )
    now = _now()
    new_grants = [
        dict(id=uuid.uuid4(), role_id=role, permission_code=code, division_id=None, effect="allow",
             created_at=now, updated_at=now)
        for role, codes in NEW_GRANTS.items()
        for code in codes
        if (role, code) not in existing_grants
    ]
    if new_grants:
        op.bulk_insert(grants, new_grants)


def downgrade() -> None:
    bind = op.get_bind()
    codes = tuple(c for c, _, _ in NEW_PERMISSIONS)
    bind.execute(sa.text("DELETE FROM role_permissions WHERE permission_code IN :codes").bindparams(
        sa.bindparam("codes", value=codes, expanding=True)))
    bind.execute(sa.text("DELETE FROM permissions WHERE code IN :codes").bindparams(
        sa.bindparam("codes", value=codes, expanding=True)))

    op.drop_index(op.f("ix_divisions_client_id"), table_name="divisions")
    with op.batch_alter_table("divisions") as batch:
        batch.drop_constraint(op.f("fk_divisions_client_id_clients"), type_="foreignkey")
        batch.drop_column("client_id")

    if _sqlite():
        for event in ("update", "delete"):
            op.execute(f"DROP TRIGGER IF EXISTS trg_credit_ledger_no_{event}")
    op.drop_index("uq_credit_ledger_journey_reason", table_name="credit_ledger")
    op.drop_index("ix_credit_ledger_client_created", table_name="credit_ledger")
    op.drop_index(op.f("ix_credit_ledger_created_at"), table_name="credit_ledger")
    op.drop_table("credit_ledger")
    op.drop_index(op.f("ix_clients_updated_at"), table_name="clients")
    op.drop_index(op.f("ix_clients_status"), table_name="clients")
    op.drop_table("clients")
