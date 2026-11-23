import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import AwareDatetime, StrictModel

LivenessAction = Literal["blink", "turn_left", "turn_right", "look_up", "look_down", "closer"]


class LivenessChallengeRequest(StrictModel):
    count: int = Field(default=10, ge=1, le=30)


class LivenessChallengeOut(StrictModel):
    id: uuid.UUID
    actions: list[LivenessAction]
    issued_at: datetime
    expires_at: datetime
    signature: str


class LivenessStep(StrictModel):
    action: LivenessAction
    at: AwareDatetime


class LivenessProof(StrictModel):
    """What the device reports after the person performed a challenge. The challenge itself (its id, its
    actions, its owner, its expiry, whether it was already used) is checked against the server's own record;
    the measurements are device claims and are stored as evidence, never treated as proof on their own."""

    challenge_id: uuid.UUID
    signature: str = Field(min_length=64, max_length=64)
    steps: list[LivenessStep] = Field(min_length=1, max_length=6)
    started_at: AwareDatetime
    completed_at: AwareDatetime
    # 3-D parallax of the nose against the rest of the face across the head turn, in inter-eye distances.
    # A flat photo or a screen has none.
    depth_score: float = Field(ge=0, le=10)
    # Same person at the start and the end of the challenge (face descriptor distance).
    identity_drift: float = Field(ge=0, le=4)
    frames: int = Field(ge=1, le=100_000)
    camera_label: str | None = Field(default=None, max_length=120)
