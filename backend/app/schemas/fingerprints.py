import base64
import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.schemas.common import ReadModel, StrictModel

# ISO/IEC 19794-2 minutiae records are a few hundred bytes; the cap is generous and only there so a
# malformed or image-sized payload is refused rather than stored.
MAX_TEMPLATE_BYTES = 4096
MIN_FINGERS = 2  # a cut or a bandage must not lock someone out of a shift
MAX_FINGERS = 10
# A finger is registered from several presses, not one. A single press records only the part of the
# fingertip that happened to touch the sensor, at the angle it happened to be held; verifying later
# against that one impression fails whenever the finger lands differently, which is most of the time.
MIN_SAMPLES = 1   # what an older device may still send
MAX_SAMPLES = 6

FINGERS = Literal[
    "right_thumb", "right_index", "right_middle", "right_ring", "right_little",
    "left_thumb", "left_index", "left_middle", "left_ring", "left_little",
]


class FingerTemplate(StrictModel):
    """One finger, as several impressions of it. Matching tries them all and keeps the best."""

    finger: FINGERS
    templates: list[str] = Field(min_length=MIN_SAMPLES, max_length=MAX_SAMPLES,
                                 description="Base64 ISO/IEC 19794-2 minutiae templates, one per press")

    @field_validator("templates")
    @classmethod
    def _decode(cls, v: list[str]) -> list[str]:
        for t in v:
            if len(t) < 16:
                raise ValueError("template is too short to be a minutiae record")
            try:
                raw = base64.b64decode(t, validate=True)
            except Exception as exc:  # noqa: BLE001 - any decoding problem is the same answer to the caller
                raise ValueError("template must be base64") from exc
            if not raw or len(raw) > MAX_TEMPLATE_BYTES:
                raise ValueError(f"template must be between 1 and {MAX_TEMPLATE_BYTES} bytes")
        return v


class FingerprintEnrollIn(StrictModel):
    format: str = Field(min_length=3, max_length=40, description="Template format, e.g. iso-19794-2")
    matcher: str = Field(min_length=3, max_length=40, description="SDK that extracted and will compare them")
    fingers: list[FingerTemplate] = Field(min_length=MIN_FINGERS, max_length=MAX_FINGERS)
    consent: Literal[True] = Field(description="The employee agreed to fingerprint verification for attendance")

    @field_validator("fingers")
    @classmethod
    def _distinct(cls, v: list[FingerTemplate]) -> list[FingerTemplate]:
        if len({f.finger for f in v}) != len(v):
            raise ValueError("each finger may be registered only once")
        return v


class FingerprintStatusOut(StrictModel):
    user_id: uuid.UUID
    enrolled: bool
    format: str | None = None
    matcher: str | None = None
    fingers: list[str] = []
    consent_at: datetime | None = None
    updated_at: datetime | None = None


class FingerprintProfileOut(ReadModel):
    """What a device needs to verify this employee offline. Templates, never images."""

    user_id: uuid.UUID
    division_id: uuid.UUID
    format: str
    matcher: str
    fingers: list[dict]
    updated_at: datetime
