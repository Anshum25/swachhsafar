import uuid

from app.schemas.trains import TrainCreate, one_way_days


def test_one_way_days_is_half_the_operational_days_rounded_up():
    assert [one_way_days(n) for n in (1, 2, 3, 4, 5, 30)] == [1, 1, 2, 2, 3, 15]


def _create(**extra):
    return TrainCreate(division_id=uuid.uuid4(), train_no="19483", name="Saharsa Express", operational_days=4,
                       coaches=[{"code": "A1", "classification": "AC"}], **extra)


def test_duration_follows_operational_days_when_not_sent():
    assert _create().duration_days == 2


def test_an_explicit_duration_is_kept():
    assert _create(duration_days=3).duration_days == 3
