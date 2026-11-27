"""Refuse an attendance taken away from its stretch of route, instead of only flagging it.

Revision ID: 0027
Revises: 0026

attendance_route_check was "flag" by default, so a fix off the route was recorded for review rather than
refused. It is now "block": an attendance marked somewhere the train never was is not worth recording. This
moves the divisions still carrying the old default over; a division that chose "off" is left alone, since
that is an explicit opt-out. Stages whose stations have no known location still check as "unknown" and are
never refused, so this cannot lock anyone out over missing reference data.

settings is a JSON column, so the rows are rewritten one by one rather than with a JSON path update, which
sqlite and postgres spell differently.
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None

POLICIES = sa.table("division_policies", sa.column("division_id"), sa.column("settings"))


def _move(old: str, new: str) -> None:
    bind = op.get_bind()
    for division_id, settings in bind.execute(sa.select(POLICIES.c.division_id, POLICIES.c.settings)):
        # JSON columns come back decoded on postgres and as text on sqlite.
        data = json.loads(settings) if isinstance(settings, str) else settings
        if not isinstance(data, dict) or data.get("attendance_route_check") != old:
            continue
        data = {**data, "attendance_route_check": new}
        bind.execute(POLICIES.update().where(POLICIES.c.division_id == division_id)
                     .values(settings=data if not isinstance(settings, str) else json.dumps(data)))


def upgrade() -> None:
    _move("flag", "block")


def downgrade() -> None:
    _move("block", "flag")
