"""A train's return train and arrival, so a planned journey ends when the return train is back.

Revision ID: 0019
Revises: 0018

RailRadar's train-status page gives a train's schedule and the train that makes the return trip
(app/providers/railradar.py TrainRun). A planned journey runs from the outbound train's departure, through its
arrival at the far end, to the return train's arrival back home (services/railway.plan_journeys).

- trains.arrival_days: days after departure that the train reaches its last station (0 = the same day);
  NULL = not read from RailRadar yet, and journeys are dated as before.
- trains.return_train_id: the train that brings the rake back, kept as a train of the same division so a
  journey can link it (journeys.linked_train_id).
"""
import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.add_column(sa.Column("arrival_days", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("return_train_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(op.f("fk_trains_return_train_id_trains"), "trains", ["return_train_id"], ["id"],
                                 ondelete="SET NULL")
        batch.create_check_constraint(op.f("ck_trains_arrival_days_range"),
                                      "arrival_days IS NULL OR (arrival_days >= 0 AND arrival_days <= 7)")


def downgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.drop_constraint(op.f("ck_trains_arrival_days_range"), type_="check")
        batch.drop_constraint(op.f("fk_trains_return_train_id_trains"), type_="foreignkey")
        batch.drop_column("return_train_id")
        batch.drop_column("arrival_days")
