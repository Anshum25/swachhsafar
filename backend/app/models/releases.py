import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TZDateTime, Timestamps, UUIDPk


class WebBundle(UUIDPk, Timestamps, Base):
    """One built copy of the web app (src/ compiled by Vite), zipped and held in storage.

    The row is the index: it says which file the zip is, what it hashes to, and the oldest installed APK
    that may run it. The bytes never live here -- a bundle is 3-6 MB of JavaScript and WASM, which is a
    file, not a column. Nothing is ever overwritten: a new build is a new row, which is what makes a
    rollback a pointer move rather than a rebuild.
    """

    __tablename__ = "web_bundles"
    __table_args__ = (
        # `build` is the CI run number: it only ever rises, so it orders releases even when several share
        # a version name, exactly as versionCode does for the APK (android/app/build.gradle).
        UniqueConstraint("version", "build"),
        CheckConstraint("size_bytes > 0", name="size_positive"),
        CheckConstraint("build >= 0", name="build_not_negative"),
    )

    version: Mapped[str] = mapped_column(String(32), nullable=False)          # package.json version, "2.0.8"
    build: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)   # CI run number, monotonic
    git_sha: Mapped[str] = mapped_column(String(40), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(300), nullable=False, unique=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The oldest APK (versionName) that may be served this bundle. A bundle calling a native plugin method
    # an older APK does not have would crash on launch with no way back, so it is withheld instead.
    min_native_version: Mapped[str] = mapped_column(String(32), nullable=False, default="0.0.0")
    # The API base compiled into this bundle. Recorded, not used: an OTA bundle must carry the absolute
    # URL (the WebView serves from https://localhost, so a relative /api/v1 points at the app's own
    # assets), and publishing a bundle built for the PWA instead is the one mistake that breaks every
    # request on every phone. The publish endpoint refuses a bundle whose base is relative.
    api_base_url: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(String(500))
    published_by: Mapped[str | None] = mapped_column(String(64))              # "ci" or an emp id

    @property
    def bundle_id(self) -> str:
        """The name the device knows this bundle by, and the one it reports back."""
        return f"{self.version}+{self.build}"


class WebChannel(Timestamps, Base):
    """Which bundle a channel currently serves. One row per channel; the whole release mechanism is this
    pointer. Publishing does not change it -- a separate call does, so uploading is never going live."""

    __tablename__ = "web_channels"
    __table_args__ = (
        CheckConstraint("rollout_percent BETWEEN 0 AND 100", name="rollout_range"),
    )

    channel: Mapped[str] = mapped_column(String(16), primary_key=True)         # "stable" | "beta"
    bundle_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("web_bundles.id", ondelete="RESTRICT"))
    # Share of devices the pointer applies to, decided per device by a hash of (bundle, device id): the
    # same device keeps the same answer, so a phone does not flip between two bundles on every check.
    rollout_percent: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    # Ask the device to apply the bundle at once rather than on the next cold start. For a bad bug only:
    # it reloads the WebView under whoever is holding the phone.
    mandatory: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Set when the pointer is moved back to an earlier build; shown in the release history.
    rolled_back_from: Mapped[int | None] = mapped_column(Integer)
    pointed_at: Mapped[datetime | None] = mapped_column(TZDateTime())
    pointed_by: Mapped[str | None] = mapped_column(String(64))

    bundle: Mapped["WebBundle | None"] = relationship(lazy="joined")
