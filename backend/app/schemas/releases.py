from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field

from app.schemas.common import ReadModel, StrictModel

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Semver = Annotated[str, Field(pattern=r"^\d+\.\d+\.\d+$")]
GitSha = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
Channel = Literal["stable", "beta"]


class BundlePublish(StrictModel):
    """Metadata sent with the zip by CI (scripts/publish-bundle.mjs). The bytes are the request body."""

    version: Semver
    build: Annotated[int, Field(ge=0, le=2_000_000_000)]
    git_sha: GitSha
    sha256: Sha256
    min_native_version: Semver = "0.0.0"
    api_base_url: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=500)


class ChannelPoint(StrictModel):
    """Make a published bundle the one a channel serves. This is the only call that changes what phones get."""

    build: Annotated[int, Field(ge=0)]
    rollout_percent: Annotated[int, Field(ge=0, le=100)] = 100
    mandatory: bool = False


class BundleOut(ReadModel):
    version: str
    build: int
    git_sha: str
    sha256: str
    size_bytes: int
    min_native_version: str
    notes: str | None
    created_at: datetime


class ChannelOut(ReadModel):
    channel: str
    rollout_percent: int
    mandatory: bool
    rolled_back_from: int | None
    pointed_at: datetime | None
    bundle: BundleOut | None


class UpdateOut(StrictModel):
    """The answer to an update check. `url` is unauthenticated on purpose: the same bundle is already
    served openly as the PWA, and a phone that cannot sign in (because its login screen is the thing that
    is broken) still has to be able to repair itself."""

    bundle_id: str          # "2.0.8+421", the name the device stores it under
    version: str
    build: int
    url: str
    sha256: str
    size_bytes: int
    mandatory: bool
