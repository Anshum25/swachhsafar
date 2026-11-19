"""Over-the-air web bundle releases: the app's web build becomes something the server can replace.

- web_bundles: one row per build of the Vite app that CI has published. The zip lives in storage
  (web-bundles/<version>+<build>.zip); the row holds the hash the phone verifies before unpacking, and
  min_native_version, the oldest APK allowed to run it. Nothing is ever updated in place, so every build
  that has ever been live stays available to go back to.
- web_channels: one row per channel ("stable", "beta") saying which bundle it serves. Moving this pointer
  is the entire release mechanism, and pointing it at an earlier build is the rollback.

Seeded with a "stable" channel pointing at nothing, which is what makes the update check answer "stay
where you are" until the first bundle is published: installing this migration changes no phone.

Revision ID: 0009
Revises: 0008
"""
import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_bundles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("build", sa.Integer(), nullable=False),
        sa.Column("git_sha", sa.String(length=40), nullable=False),
        sa.Column("storage_path", sa.String(length=300), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("min_native_version", sa.String(length=32), nullable=False, server_default="0.0.0"),
        sa.Column("api_base_url", sa.String(length=200), nullable=True),
        sa.Column("notes", sa.String(length=500), nullable=True),
        sa.Column("published_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("size_bytes > 0", name="ck_web_bundles_size_positive"),
        sa.CheckConstraint("build >= 0", name="ck_web_bundles_build_not_negative"),
        sa.PrimaryKeyConstraint("id", name="pk_web_bundles"),
        sa.UniqueConstraint("build", name="uq_web_bundles_build"),
        sa.UniqueConstraint("storage_path", name="uq_web_bundles_storage_path"),
        sa.UniqueConstraint("version", "build", name="uq_web_bundles_version_build"),
    )
    op.create_index(op.f("ix_web_bundles_updated_at"), "web_bundles", ["updated_at"])

    op.create_table(
        "web_channels",
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=True),
        sa.Column("rollout_percent", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("mandatory", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("rolled_back_from", sa.Integer(), nullable=True),
        sa.Column("pointed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pointed_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("rollout_percent BETWEEN 0 AND 100", name="ck_web_channels_rollout_range"),
        sa.PrimaryKeyConstraint("channel", name="pk_web_channels"),
        # RESTRICT: a bundle a channel is serving cannot be deleted out from under the phones running it.
        sa.ForeignKeyConstraint(["bundle_id"], ["web_bundles.id"], name="fk_web_channels_bundle_id_web_bundles",
                                ondelete="RESTRICT"),
    )
    op.create_index(op.f("ix_web_channels_updated_at"), "web_channels", ["updated_at"])

    op.bulk_insert(
        sa.table("web_channels", sa.column("channel"), sa.column("rollout_percent"), sa.column("mandatory")),
        [
            {"channel": "stable", "rollout_percent": 100, "mandatory": False},
            {"channel": "beta", "rollout_percent": 100, "mandatory": False},
        ],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_web_channels_updated_at"), table_name="web_channels")
    op.drop_table("web_channels")
    op.drop_index(op.f("ix_web_bundles_updated_at"), table_name="web_bundles")
    op.drop_table("web_bundles")
