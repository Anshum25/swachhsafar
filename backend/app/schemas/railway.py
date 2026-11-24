import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ReadModel, StrictModel
from app.schemas.trains import CoachIn, _unique_codes


class RailwayStationOut(ReadModel):
    code: str
    name: str
    city: str
    state: str
    metro: str | None


class StationTrainOut(BaseModel):
    train_no: str
    name: str | None
    type: str | None
    destination_code: str | None
    destination_name: str | None
    departure: str
    departure_day: int | None
    run_days: list[str] | None


class StationTrainsOut(BaseModel):
    station_code: str
    station_name: str | None
    fetched_at: datetime
    # True when RailRadar could not be reached just now and this is the last copy that was.
    stale: bool
    trains: list[StationTrainOut]


class SetupStationOut(BaseModel):
    code: str
    name: str
    city: str
    division_id: uuid.UUID | None
    selected: bool
    train_nos: list[str]


class SetupOut(BaseModel):
    client_id: uuid.UUID
    state: str | None
    city: str | None
    setup_completed_at: datetime | None
    stations: list[SetupStationOut]
    planned: int = 0
    without_supervisor: int = 0


class SetupTrainIn(StrictModel):
    train_no: str = Field(min_length=1, max_length=15, pattern=r"^[0-9A-Z]+$")
    # Optional: RailRadar does not publish a train's composition. Inspections need it, so it can be given
    # here or added later on the train.
    coaches: list[CoachIn] = Field(default_factory=list, max_length=40)

    _codes = field_validator("coaches")(_unique_codes)


class SetupStationIn(StrictModel):
    code: str = Field(min_length=1, max_length=8)
    trains: list[SetupTrainIn] = Field(min_length=1, max_length=100)

    @field_validator("trains")
    @classmethod
    def _distinct(cls, v: list[SetupTrainIn]) -> list[SetupTrainIn]:
        nos = [t.train_no for t in v]
        if len(nos) != len(set(nos)):
            raise ValueError("a train is listed twice")
        return v


class SetupIn(StrictModel):
    stations: list[SetupStationIn] = Field(max_length=50)

    @field_validator("stations")
    @classmethod
    def _distinct(cls, v: list[SetupStationIn]) -> list[SetupStationIn]:
        codes = [s.code.strip().upper() for s in v]
        if len(codes) != len(set(codes)):
            raise ValueError("a station is listed twice")
        return v


class SetupResult(BaseModel):
    divisions_created: int
    trains_planned: int
    journeys_created: int
    # Not created because the wallet could not pay for them; tried again on the next daily run.
    journeys_skipped: int = 0
