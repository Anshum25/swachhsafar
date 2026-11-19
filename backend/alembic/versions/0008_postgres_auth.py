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


# This migration checks before it creates, which a migration normally has no business doing.
#
# The reason is specific and worth stating. An earlier version of this work was numbered 0007 and was run
# against the production database by hand before being renumbered to 0008. That database therefore holds
# these tables already while `alembic_version` says 0007, so a plain CREATE TABLE fails with "relation
# user_credentials already exists" -- which is exactly how the API came to be down. Checking first lets
# the same migration converge whether it meets an untouched database or that one.
#
# It does NOT make the migration re-runnable in general: alembic still records it once. The checks exist
# only so that a database somebody edited by hand can be brought back onto the rails.
def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _has_column(table: str, column: str) -> bool:
    return any(c["name"] == column for c in _inspector().get_columns(table))


def _has_unique(table: str, name: str) -> bool:
    return any(u["name"] == name for u in _inspector().get_unique_constraints(table))


def _has_index(table: str, name: str) -> bool:
    return any(i["name"] == name for i in _inspector().get_indexes(table))


def upgrade() -> None:
    if not _has_table("user_credentials"):
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
    if not _has_index("user_credentials", "ix_user_credentials_updated_at"):
        op.create_index("ix_user_credentials_updated_at", "user_credentials", ["updated_at"])

    # Whether this run is what ends the Firebase-era sessions. Only a run that introduces token_hash may
    # do that: on a database where the column is already there, the sessions were dealt with when it was
    # added, and revoking again would sign everybody out a second time for no reason.
    added_token_hash = not _has_column("auth_sessions", "token_hash")
    if added_token_hash:
        op.add_column("auth_sessions", sa.Column("token_hash", sa.String(64), nullable=True))
    if not _has_unique("auth_sessions", "uq_auth_sessions_token_hash"):
        op.create_unique_constraint("uq_auth_sessions_token_hash", "auth_sessions", ["token_hash"])
    # Relaxing NOT NULL is harmless to repeat.
    op.alter_column("auth_sessions", "firebase_uid", existing_type=sa.String(128), nullable=True)

    if added_token_hash:
        # Firebase-era sessions cannot be presented any more (no token hash): record that they ended, and why.
        op.execute(sa.text("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'auth_migrated' "
                           "WHERE revoked_at IS NULL"))

    # The group photo column from 0007. On a database where an earlier, hand-run copy of this migration
    # had already taken the name "0007", alembic believes 0007 is done and will never apply the real one,
    # so the column is missing and every group photo attendance fails on insert. Putting it right here is
    # the only place that can see such a database. On any ordinary one, 0007 made it and this does nothing.
    if not _has_column("attendance", "identified_by"):
        op.add_column("attendance", sa.Column("identified_by", sa.String(20), nullable=True))
        op.execute("UPDATE attendance SET identified_by = 'fingerprint' WHERE fingerprint_score IS NOT NULL")
        op.execute("UPDATE attendance SET identified_by = 'face' "
                   "WHERE fingerprint_score IS NULL AND face_distance IS NOT NULL")

    # Replaced rather than created: the view may be left over from the hand-run copy, and its column list
    # can differ, which CREATE OR REPLACE will not tolerate.
    op.execute("DROP VIEW IF EXISTS user_auth_profiles")
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
