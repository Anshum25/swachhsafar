"""Device security: devices, backend sign-in sessions, CAPTCHA replay guard, sign-in OTPs, login attempts,
security events; capture evidence on attendance and inspections.

Revision ID: 0005
Revises: 0004
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _ts(name, nullable=True, default=False):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=sa.func.now() if default else None)


def _fk(col, table, name, nullable=True):
    return sa.Column(col, sa.Uuid(), sa.ForeignKey(f"{table}.id", name=name), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "devices",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("label", sa.String(120)),
        sa.Column("status", sa.String(10), nullable=False, server_default="active"),
        _fk("first_user_id", "users", "fk_devices_first_user_id_users"),
        _fk("last_user_id", "users", "fk_devices_last_user_id_users"),
        _ts("last_seen_at"),
        sa.Column("last_ip", sa.String(45)),
        _ts("revoked_at"),
        _fk("revoked_by_id", "users", "fk_devices_revoked_by_id_users"),
        sa.Column("revoke_reason", sa.String(200)),
        _ts("created_at", False, True),
        _ts("updated_at", False, True),
        sa.CheckConstraint("status IN ('active', 'revoked')", name="ck_devices_status"),
    )
    op.create_index("ix_devices_updated_at", "devices", ["updated_at"])

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        _fk("user_id", "users", "fk_auth_sessions_user_id_users", nullable=False),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id", name="fk_auth_sessions_device_id_devices"), nullable=False),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("firebase_uid", sa.String(128), nullable=False),
        sa.Column("ip", sa.String(45)),
        _ts("last_seen_at", False),
        _ts("revoked_at"),
        sa.Column("revoke_reason", sa.String(40)),
        _ts("created_at", False, True),
        _ts("updated_at", False, True),
    )
    op.create_index("ix_auth_sessions_user_active", "auth_sessions", ["user_id", "revoked_at"])
    op.create_index("ix_auth_sessions_device_id", "auth_sessions", ["device_id"])
    op.create_index("ix_auth_sessions_updated_at", "auth_sessions", ["updated_at"])

    op.create_table(
        "captcha_uses",
        sa.Column("signature_hash", sa.String(64), primary_key=True),
        _ts("expires_at", False),
    )
    op.create_index("ix_captcha_uses_expires_at", "captcha_uses", ["expires_at"])

    op.create_table(
        "login_otps",
        sa.Column("id", sa.Uuid(), primary_key=True),
        _fk("user_id", "users", "fk_login_otps_user_id_users", nullable=False),
        sa.Column("mobile", sa.String(10), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        _ts("expires_at", False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("send_count", sa.Integer(), nullable=False, server_default="1"),
        _ts("last_sent_at", False),
        _ts("consumed_at"),
        sa.Column("device_id", sa.String(64)),
        _ts("created_at", False, True),
        _ts("updated_at", False, True),
    )
    op.create_index("ix_login_otps_user_id", "login_otps", ["user_id"])
    op.create_index("ix_login_otps_mobile", "login_otps", ["mobile"])
    op.create_index("ix_login_otps_updated_at", "login_otps", ["updated_at"])

    op.create_table(
        "login_attempts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("subject", sa.String(254), nullable=False),
        _fk("user_id", "users", "fk_login_attempts_user_id_users"),
        sa.Column("device_id", sa.String(64)),
        sa.Column("ip", sa.String(45)),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("reason", sa.String(40)),
        _ts("created_at", False),
    )
    op.create_index("ix_login_attempts_subject_time", "login_attempts", ["subject", "created_at"])
    op.create_index("ix_login_attempts_ip_time", "login_attempts", ["ip", "created_at"])

    op.create_table(
        "security_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("source", sa.String(8), nullable=False),
        sa.Column("type", sa.String(48), nullable=False),
        sa.Column("severity", sa.String(8), nullable=False),
        _fk("user_id", "users", "fk_security_events_user_id_users"),
        sa.Column("device_id", sa.String(64)),
        sa.Column("session_id", sa.Uuid()),
        _fk("division_id", "divisions", "fk_security_events_division_id_divisions"),
        sa.Column("details", JSONType, nullable=False),
        sa.Column("ip", sa.String(45)),
        _ts("occurred_at", False),
        _ts("received_at", False),
    )
    op.create_index("ix_security_events_type", "security_events", ["type"])
    op.create_index("ix_security_events_device_id", "security_events", ["device_id"])
    op.create_index("ix_security_events_user_time", "security_events", ["user_id", "occurred_at"])

    for table in ("attendance", "inspections"):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("device_id", sa.String(64), nullable=True))
            batch.add_column(sa.Column("gps_timestamp", sa.DateTime(timezone=True), nullable=True))
            batch.add_column(sa.Column("security", JSONType, nullable=True))
            batch.add_column(sa.Column("risk_flags", JSONType, nullable=True))


def downgrade() -> None:
    for table in ("inspections", "attendance"):
        with op.batch_alter_table(table) as batch:
            for col in ("risk_flags", "security", "gps_timestamp", "device_id"):
                batch.drop_column(col)
    for table in ("security_events", "login_attempts", "login_otps", "captcha_uses", "auth_sessions", "devices"):
        op.drop_table(table)
