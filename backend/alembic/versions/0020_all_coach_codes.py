"""Coaches get the class their code says under the full list of Indian Railways coach codes.

Revision ID: 0020
Revises: 0019

app/coach_codes.py now knows every coach code of Railway Board Commercial Circular 07 of 2021: Garib Rath G (3A)
and J (chair car), HB and AB are AC (J was read as Non-AC before); DV, VS and FC are Non-AC; UNR and the SLR,
SLRD, SR, SRD, LRD, PWD and LDS coaches are General. Coaches on trains and journeys whose code now says another
class are corrected, as 0018 did for the codes known then. A code that says nothing keeps its class. Recorded
feedback, inspections and complaints keep the class they were taken under.

Downgrade changes nothing back: the corrected classes are what the codes say.
"""
import re

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

# app/coach_codes.py as of this migration, frozen.
OTHER = re.compile(r"^(ENG|LOCO|PC|EOG|PWR|LPR|LUG|LV|PV|VP|VPU|HCP|TM|LR)[0-9]*$")
GEN = re.compile(r"^(GEN|GS|GN|UR|UNR|SLR|SLRD|SR|SRD|LRD|PWD|LDS)[0-9]*$")
AC = re.compile(r"^(H|HA|HB|A|AB|B|M|G|C|E|J|K|EA|EV)[0-9]*$")
NON_AC = re.compile(r"^(S|D|SS|F|FC|DV|VS)[0-9]*$")


def class_of(code: str | None) -> str | None:
    c = re.sub(r"[^A-Z0-9]", "", (code or "").upper())
    if not c or OTHER.match(c):
        return None
    if GEN.match(c):
        return "GEN"
    if AC.match(c):
        return "AC"
    if NON_AC.match(c):
        return "NON_AC"
    return None


def upgrade() -> None:
    conn = op.get_bind()
    for table in ("train_coaches", "journey_coaches"):
        t = sa.table(table, sa.column("id", sa.Uuid()), sa.column("code", sa.String()),
                     sa.column("classification", sa.String()))
        moves: dict[str, list] = {"AC": [], "NON_AC": [], "GEN": []}
        for row in conn.execute(sa.select(t.c.id, t.c.code, t.c.classification)):
            want = class_of(row.code)
            if want and want != row.classification:
                moves[want].append(row.id)
        for cls, ids in moves.items():
            for i in range(0, len(ids), 500):
                conn.execute(sa.update(t).where(t.c.id.in_(ids[i:i + 500])).values(classification=cls))


def downgrade() -> None:
    pass
