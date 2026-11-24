"""A train's return train and how many days it runs, from RailRadar's train-status page.

Revision ID: 0019
Revises: 0018

RailRadar's train-status page names the train that takes the rake back from the destination (12951 ->
12952) and gives the last stop's arrival day. Setup saves the return train as a train of the same division
and links it here, so journeys get their linked train, return dates and return times from it
(services/journeys.return_leg):

- trains.arrival_day_offset: days after leaving the origin that the train reaches its destination;
- trains.return_train_id: the train back (SET NULL if that train is deleted).

Both start empty: the next setup save of an office reads its trains' pages and fills them. Until then its
journeys are planned as before, from duration_days.
"""
import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.add_column(sa.Column("arrival_day_offset", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("return_train_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(op.f("fk_trains_return_train_id_trains"), "trains", ["return_train_id"], ["id"],
                                 ondelete="SET NULL")
        batch.create_check_constraint(
            op.f("ck_trains_arrival_day_offset_range"),
            "arrival_day_offset IS NULL OR (arrival_day_offset >= 0 AND arrival_day_offset <= 15)")


def downgrade() -> None:
    with op.batch_alter_table("trains") as batch:
        batch.drop_constraint(op.f("ck_trains_arrival_day_offset_range"), type_="check")
        batch.drop_constraint(op.f("fk_trains_return_train_id_trains"), type_="foreignkey")
        batch.drop_column("return_train_id")
        batch.drop_column("arrival_day_offset")
