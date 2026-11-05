import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.schemas.common import ReadModel, StrictModel

DESCRIPTOR_LENGTH = 128  # face-api / dlib ResNet face descriptor
SAMPLES = 4  # photos registered per employee


class FaceEnrollIn(StrictModel):
    model: str = Field(min_length=3, max_length=40, description="Descriptor model, e.g. faceapi-resnet128-v1")
    descriptors: list[list[float]] = Field(min_length=SAMPLES, max_length=SAMPLES)
    consent: Literal[True] = Field(description="The employee agreed to face verification for attendance")

    @field_validator("descriptors")
    @classmethod
    def _shape(cls, v: list[list[float]]) -> list[list[float]]:
        for d in v:
            if len(d) != DESCRIPTOR_LENGTH or any(not -2.0 <= x <= 2.0 for x in d):
                raise ValueError(f"each descriptor must be {DESCRIPTOR_LENGTH} numbers between -2 and 2")
        return v


class FaceStatusOut(StrictModel):
    user_id: uuid.UUID
    enrolled: bool
    model: str | None = None
    samples: int = 0
    consent_at: datetime | None = None
    updated_at: datetime | None = None


class FaceProfileOut(ReadModel):
    user_id: uuid.UUID
    division_id: uuid.UUID
    model: str
    descriptors: list[list[float]]
    updated_at: datetime
