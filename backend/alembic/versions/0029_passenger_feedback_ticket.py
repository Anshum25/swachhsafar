"""The PNR ticket of a passenger feedback in its own columns.

Revision ID: 0029
Revises: 0028

passenger_feedback gets the ticket's train name, class, the passenger line's status (e.g. CNF/A1/17/SL), coach,
berth number and code, chart state and the provider that answered. Until now these were only inside the
pnr_details JSON. Rows already checked are filled from that JSON: the passenger line in the feedback's coach,
else the first one still on the ticket.
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None

COLUMNS = [
    sa.Column("pnr_train_name", sa.String(60), nullable=True),
    sa.Column("pnr_class", sa.String(5), nullable=True),
    sa.Column("pnr_booking_status", sa.String(40), nullable=True),
    sa.Column("pnr_coach", sa.String(10), nullable=True),
    sa.Column("pnr_berth_no", sa.Integer(), nullable=True),
    sa.Column("pnr_berth_code", sa.String(4), nullable=True),
    sa.Column("pnr_chart_prepared", sa.Boolean(), nullable=True),
    sa.Column("pnr_source", sa.String(12), nullable=True),
]


def _norm(code):
    return "".join(str(code or "").split()).upper()


def _ticket(details: dict, coach_code: str) -> dict:
    """Same rule as app.services.feedback.ticket_line, on the stored JSON (berth there is "17 SL")."""
    live = [p for p in details.get("passengers") or [] if not str(p.get("status") or "").upper().startswith("CAN")]
    line = next((p for p in live if p.get("coach") and _norm(p["coach"]) == _norm(coach_code)), None) \
        or next(iter(live), None) or {}
    berth = str(line.get("berth") or "").split()
    berth_no = int(berth[0]) if berth and berth[0].isdigit() else None
    berth_code = berth[1][:4] if len(berth) > 1 else None
    status = "/".join(str(x) for x in (line.get("status"), line.get("coach"), berth_no, berth_code) if x) or None
    chart = str(details.get("chart_status") or "").lower()
    return dict(
        pnr_train_name=(details.get("train_name") or None) and str(details["train_name"])[:60],
        pnr_class=(details.get("class") or None) and str(details["class"])[:5],
        pnr_booking_status=status and status[:40], pnr_coach=(line.get("coach") or None) and str(line["coach"])[:10],
        pnr_berth_no=berth_no, pnr_berth_code=berth_code,
        pnr_chart_prepared=("prepared" in chart and "not" not in chart) if chart else None,
        pnr_source=(details.get("source") or None) and str(details["source"])[:12])


def upgrade() -> None:
    for column in COLUMNS:
        op.add_column("passenger_feedback", column)
    bind = op.get_bind()
    fb = sa.table("passenger_feedback", sa.column("id", sa.Uuid()), sa.column("coach_code", sa.String()),
                  sa.column("pnr_details", sa.JSON()), *[sa.column(c.name, c.type) for c in COLUMNS])
    rows = bind.execute(sa.select(fb.c.id, fb.c.coach_code, fb.c.pnr_details)
                        .where(fb.c.pnr_details.is_not(None))).all()
    for fid, coach, details in rows:
        if isinstance(details, str):
            details = json.loads(details)
        if not isinstance(details, dict) or not details.get("found"):
            continue
        bind.execute(sa.update(fb).where(fb.c.id == fid).values(**_ticket(details, coach)))


def downgrade() -> None:
    for column in reversed(COLUMNS):
        op.drop_column("passenger_feedback", column.name)
