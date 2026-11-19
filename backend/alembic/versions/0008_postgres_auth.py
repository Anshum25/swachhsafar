"""Sign-in moves off Firebase Authentication into PostgreSQL.

- user_credentials: one password hash per employee (scrypt; or a Firebase scrypt hash imported by
  `python -m app.cli import-firebase-passwords`, rehashed at the employee's next sign-in).
- auth_sessions.token_hash: the hashed secret of the session's bearer token. Sessions from the Firebase era
  have none, so they are ended here ("auth_migrated"): the app asks those devices to sign in again.
- user_auth_profiles: a view of each employee with their sign-in and biometric registrations side by side
  (password, face, fingerprint), all joined on users.id. For reporting and support; the API does not read it.

Revision ID: 0008
Revises: 0007
"""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

VIEW = """
CREATE VIEW user_auth_profiles AS
SELECT u.id AS user_id,
       u.emp_id,
       u.name,
       u.email,
       u.mobile,
       u.role_id,
       u.division_id,
       u.status,
       c.user_id IS NOT NULL AS password_set,
       c.source AS password_source,
       c.password_changed_at,
       f.user_id IS NOT NULL AS face_enrolled,
       f.model AS face_model,
       f.consent_at AS face_consent_at,
       fp.user_id IS NOT NULL AS fingerprint_enrolled,
       fp.matcher AS fingerprint_matcher,
       fp.consent_at AS fingerprint_consent_at,
       (SELECT max(s.last_seen_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_signed_in_at
FROM users u
LEFT JOIN user_credentials c ON c.user_id = u.id
LEFT JOIN face_enrollments f ON f.user_id = u.id
LEFT JOIN fingerprint_enrollments fp ON fp.user_id = u.id
"""


def upgrade() -> None:
    op.create_table(
        "user_credentials",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", name="fk_user_credentials_user_id_users", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("password_hash", sa.String(512), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("legacy_firebase_uid", sa.String(128)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_user_credentials_updated_at", "user_credentials", ["updated_at"])

    with op.batch_alter_table("auth_sessions") as batch:
        batch.add_column(sa.Column("token_hash", sa.String(64), nullable=True))
        batch.create_unique_constraint("uq_auth_sessions_token_hash", ["token_hash"])
        batch.alter_column("firebase_uid", existing_type=sa.String(128), nullable=True)

    # Firebase-era sessions cannot be presented any more (no token hash): record that they ended, and why.
    op.execute(sa.text("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'auth_migrated' "
                       "WHERE revoked_at IS NULL"))

    op.execute(VIEW)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS user_auth_profiles")
    op.execute(sa.text("UPDATE auth_sessions SET firebase_uid = '' WHERE firebase_uid IS NULL"))
    with op.batch_alter_table("auth_sessions") as batch:
        batch.alter_column("firebase_uid", existing_type=sa.String(128), nullable=False)
        batch.drop_constraint("uq_auth_sessions_token_hash", type_="unique")
        batch.drop_column("token_hash")
    op.drop_index("ix_user_credentials_updated_at", table_name="user_credentials")
    op.drop_table("user_credentials")
