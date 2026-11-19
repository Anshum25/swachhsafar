"""Over-the-air web bundle releases.

The Android app is a WebView over the Vite build. Normally that build is sealed inside the APK, so a
one-line fix in src/ needs a Play Store release and a user who agrees to update. These functions let the
server hand the app a newer build of the same web code instead: the app downloads the zip, checks it
against the SHA-256 recorded here, unpacks it into its own storage and serves the pages from there on the
next start. The APK, and everything native in it, is untouched.

What is NOT in here, on purpose: anything that changes android/. Native plugin methods, permissions and
Capacitor versions still ship as an APK, and `min_native_version` is how a bundle that needs a newer one
is kept away from phones that cannot run it.
"""

import hashlib
import io
import logging

import zipfile

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import BusinessRuleViolation, Conflict, NotFound
from app.models import WebBundle, WebChannel
from app.schemas.releases import BundlePublish, ChannelPoint
from app.timeutil import utcnow

log = logging.getLogger(__name__)
MB = 1024 * 1024

# Files without which the unpacked bundle is not a runnable app. Checked here rather than trusted from CI:
# a half-uploaded or wrongly built zip that reaches a phone takes the app down until the next release, and
# the phone cannot tell us that it has happened.
REQUIRED_ENTRIES = ("index.html", "manifest.webmanifest")

def _semver(v: str) -> tuple[int, int, int]:
    major, minor, patch = (int(x) for x in v.split("."))
    return major, minor, patch

def _storage_path(version: str, build: int) -> str:
    return f"web-bundles/{version}+{build}.zip"

def _inspect_zip(body: bytes) -> None:
    """A valid zip, holding a real build, with no entry that escapes the directory it unpacks into.

    Read straight from the bytes in hand: a bundle is a few megabytes, and writing it to a temp file first
    only to open it again is both a round trip and something Windows refuses outright."""
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            names = zf.namelist()
            bad = zf.testzip()
            if bad is not None:
                raise BusinessRuleViolation(f"Bundle is corrupt at {bad}", code="bundle_corrupt")
            # Zip entry names are text from the build machine, and the device unpacks them to disk. An
            # absolute path or a '..' segment would write outside the bundle directory on the phone.
            for name in names:
                if name.startswith(("/", "\\")) or ".." in name.replace("\\", "/").split("/"):
                    raise BusinessRuleViolation(f"Bundle entry escapes its directory: {name}", code="bundle_unsafe_path")
            missing = [f for f in REQUIRED_ENTRIES if f not in names]
            if missing:
                raise BusinessRuleViolation(
                    f"Bundle is not a built web app (missing {', '.join(missing)} at its root)",
                    code="bundle_incomplete",
                )
            if not any(n.startswith("assets/") and n.endswith(".js") for n in names):
                raise BusinessRuleViolation("Bundle has no assets/*.js: it is not a Vite build", code="bundle_incomplete")
            # Unpacked size, so a small zip cannot be made to fill the phone's storage.
            unpacked = sum(i.file_size for i in zf.infolist())
            if unpacked > get_settings().web_bundle_max_unpacked_bytes:
                raise BusinessRuleViolation("Bundle unpacks to more than the allowed size", code="bundle_too_large")
    except zipfile.BadZipFile:
        raise BusinessRuleViolation("Body is not a zip file", code="bundle_not_zip")

def publish(db: Session, storage, meta: BundlePublish, body: bytes, actor: str = "ci") -> WebBundle:
    """Register a built bundle and put its zip in storage. Does not change what any phone is served."""
    settings = get_settings()
    if len(body) > settings.web_bundle_max_bytes:
        raise BusinessRuleViolation(f"Bundle exceeds {settings.web_bundle_max_bytes // MB} MB", code="bundle_too_large")
    if not body:
        raise BusinessRuleViolation("Empty body", code="bundle_empty")

    digest = hashlib.sha256(body).hexdigest()
    if digest != meta.sha256:
        # The hash CI computed over the file it built, against the bytes that arrived. Everything after
        # this point -- the row, and the phone's own check before it unpacks -- is anchored on a value
        # verified end to end, so a truncated upload cannot become a published release.
        raise BusinessRuleViolation("Body does not match the declared sha256", code="bundle_hash_mismatch")

    # An OTA bundle is served to the WebView from https://localhost, so a relative API base resolves
    # against the app's own files and every request 404s. Only the APK-flavoured build (VITE_API_BASE_URL
    # set to the absolute server URL) may be published; the PWA build must not be.
    if meta.api_base_url is not None and not meta.api_base_url.startswith(("http://", "https://")):
        raise BusinessRuleViolation(
            "api_base_url must be absolute: a bundle built with a relative /api/v1 cannot reach the server "
            "from the WebView (build it with VITE_API_BASE_URL set)",
            code="bundle_relative_api_base",
        )

    existing = db.scalar(select(WebBundle).where(WebBundle.build == meta.build))
    if existing is not None:
        # Re-running the same CI job must not fail the pipeline, but a different artifact under a build
        # number that is already out there would change what a phone has verified.
        if existing.sha256 != digest:
            raise Conflict(f"Build {meta.build} is already published with different contents", code="bundle_build_reused")
        return existing

    _inspect_zip(body)

    path = _storage_path(meta.version, meta.build)
    storage.put(path, io.BytesIO(body), "application/zip")

    bundle = WebBundle(
        version=meta.version,
        build=meta.build,
        git_sha=meta.git_sha,
        storage_path=path,
        sha256=digest,
        size_bytes=len(body),
        min_native_version=meta.min_native_version,
        api_base_url=meta.api_base_url,
        notes=meta.notes,
        published_by=actor,
    )
    db.add(bundle)
    db.commit()
    log.info("web bundle published: %s (%s bytes, sha %s)", bundle.bundle_id, bundle.size_bytes, digest[:12])
    return bundle

def point(db: Session, channel: str, body: ChannelPoint, actor: str = "ci") -> WebChannel:
    """Point a channel at a published build. Pointing at an earlier build is the rollback."""
    bundle = db.scalar(select(WebBundle).where(WebBundle.build == body.build))
    if bundle is None:
        raise NotFound(f"No bundle published with build {body.build}")

    row = db.get(WebChannel, channel)
    if row is None:
        row = WebChannel(channel=channel)
        db.add(row)
    previous = row.bundle.build if row.bundle is not None else None

    row.bundle_id = bundle.id
    row.rollout_percent = body.rollout_percent
    row.mandatory = body.mandatory
    row.rolled_back_from = previous if previous is not None and previous > bundle.build else None
    row.pointed_at = utcnow()
    row.pointed_by = actor
    db.commit()
    db.refresh(row)
    log.info(
        "channel %s now serves %s (%d percent%s)",
        channel, bundle.bundle_id, row.rollout_percent, ", rolled back" if row.rolled_back_from else "",
    )
    return row

def in_rollout(bundle: WebBundle, device_id: str | None, percent: int) -> bool:
    """Whether this device is inside a partial rollout. Decided by hashing the bundle together with the
    device id, so the answer is the same on every check (a device does not flip between two bundles),
    while a different bundle reshuffles which devices go first."""
    if percent >= 100:
        return True
    if percent <= 0:
        return False
    if not device_id:
        # A device that sends no id cannot be placed in a rollout consistently, so it waits for the
        # rollout to reach everyone rather than being handed a bundle at random on each check.
        return False
    seed = f"{bundle.sha256}:{device_id}".encode()
    return int.from_bytes(hashlib.sha256(seed).digest()[:4], "big") % 100 < percent

def resolve(
    db: Session,
    channel: str,
    *,
    native_version: str | None,
    current: str | None,
    device_id: str | None,
) -> tuple[WebBundle, bool] | None:
    """The bundle this device should be running, or None when it is already right or nothing applies.

    `native_version` is the installed APK's versionName, which the updater plugin reports. A bundle that
    needs a newer APK is withheld: serving it would break the app on launch, and a phone whose bundle does
    not start cannot ask for a better one.
    """
    row = db.get(WebChannel, channel)
    if row is None or row.bundle is None:
        return None
    bundle = row.bundle

    if native_version:
        try:
            if _semver(native_version) < _semver(bundle.min_native_version):
                log.info(
                    "bundle %s withheld: APK %s is older than the required %s",
                    bundle.bundle_id, native_version, bundle.min_native_version,
                )
                return None
        except ValueError:
            return None  # unreadable version: leave the phone alone rather than guess

    if not in_rollout(bundle, device_id, row.rollout_percent):
        return None

    # Already on it. The comparison is the exact bundle name, not "is mine older": when the channel is
    # pointed back at an earlier build, every phone on the newer one has to come back down to it.
    if current == bundle.bundle_id:
        return None

    return bundle, row.mandatory

def history(db: Session, limit: int = 20) -> list[WebBundle]:
    return list(db.scalars(select(WebBundle).order_by(WebBundle.build.desc()).limit(limit)))
