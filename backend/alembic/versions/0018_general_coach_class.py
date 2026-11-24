"""General (unreserved) coaches become their own class: GEN, beside AC and NON_AC.

Revision ID: 0018
Revises: 0017

Feedback questions differ for General coaches, so a question now says whether it applies to them
(questions.applies_gen). Until now General coaches were NON_AC, so every question keeps asking what it asked
them before: applies_gen starts as applies_non_ac.

Coach class columns are VARCHAR(8) without a CHECK on their values (the enum is not native), so "GEN" needs
no column change.

Coaches on trains and journeys get the class their code says, as the app now sets it when coaches are typed:
General codes (GEN, GEN2, GN1, GS, UR1 ...) become GEN, and wrongly typed ones are corrected -- the Trains form
saved "B1, B2" as NON_AC unless " AC" was typed after each, and the journey coach editor offered AC first, so
an added S1 was saved as AC. A code that says nothing (BHJ, PC ...) keeps its class. Recorded feedback,
inspections and complaints keep the class they were taken under: they show what was asked at the time.

Downgrade folds GEN back into NON_AC and drops applies_gen; corrected AC / NON_AC classes stay corrected.
"""
import re

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

# The app's own reading of a coach code (src/utils/coaches.js inferClass), frozen here.
GENERAL_CODE = re.compile(r"^(GEN|GN|GS|UR)[0-9]*$")
AC_CODE = re.compile(r"^(H|HA|A|B|M|C|E|EA|EV|K)[0-9]*$")
NON_AC_CODE = re.compile(r"^(S|D|J|F)[0-9]+$|^SS[0-9]*$")
COACH_TABLES = ("train_coaches", "journey_coaches")


def class_of(code: str | None) -> str | None:
    c = (code or "").strip().upper()
    if GENERAL_CODE.match(c):
        return "GEN"
    if AC_CODE.match(c):
        return "AC"
    if NON_AC_CODE.match(c):
        return "NON_AC"
    return None


def upgrade() -> None:
    with op.batch_alter_table("questions") as batch:
        batch.add_column(sa.Column("applies_gen", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.execute("UPDATE questions SET applies_gen = applies_non_ac")
    with op.batch_alter_table("questions") as batch:
        batch.drop_constraint(op.f("ck_questions_applies_somewhere"), type_="check")
        batch.create_check_constraint(op.f("ck_questions_applies_somewhere"), "applies_ac OR applies_non_ac OR applies_gen")

    conn = op.get_bind()
    for table in COACH_TABLES:
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
    for table in ("train_coaches", "journey_coaches", "passenger_feedback", "complaints"):
        column = "classification" if table.endswith("coaches") else "coach_class"
        op.execute(f"UPDATE {table} SET {column} = 'NON_AC' WHERE {column} = 'GEN'")
    with op.batch_alter_table("questions") as batch:
        batch.drop_constraint(op.f("ck_questions_applies_somewhere"), type_="check")
        batch.create_check_constraint(op.f("ck_questions_applies_somewhere"), "applies_ac OR applies_non_ac")
        batch.drop_column("applies_gen")
