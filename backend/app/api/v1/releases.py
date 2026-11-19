"""Over-the-air web bundle releases: what the app asks for, and what CI publishes.

Two audiences, two kinds of authentication:

- the phone (`GET /app/bundle/latest`, `GET /app/bundle/{build}/download`) is NOT signed in. The bundle is
  the same JavaScript the site already serves openly to every browser, so there is nothing here to keep
  secret, and the check has to work before sign-in: the login screen is exactly the thing that may be
  broken and need replacing. Both routes are rate limited per IP, and the device verifies the SHA-256 it
  is given before it unpacks anything.
- CI (`POST /app/bundle`, `POST /app/channel/{channel}`) authenticates with RELEASE_PUBLISH_TOKEN, not a
  user session: there is no employee behind a pipeline run. Publishing and going live are deliberately
  two separate calls, so an upload is never a release.
"""

import hmac
from datetime import timedelta

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.errors import NotFound, ServiceUnavailable, Unauthenticated
from app.models import WebBundle, WebChannel
from app.providers.storage import StorageBackend, get_storage
from app.schemas.releases import BundleOut, BundlePublish, Channel, ChannelOut, ChannelPoint, UpdateOut
from app.security.principal import Principal, get_principal
from app.security.ratelimit import limiter
from app.services import releases as svc

router = APIRouter(prefix="/app", tags=["app-release"])


def _client_ip(request: Request) -> str | None:
    """The caller's address behind TRUSTED_PROXY_HOPS reverse proxies (as in app/api/v1/security.py)."""
    hops = get_settings().trusted_proxy_hops
    forwarded = [x.strip() for x in request.headers.get("x-forwarded-for", "").split(",") if x.strip()]
    if hops > 0 and forwarded:
        return forwarded[-hops] if len(forwarded) >= hops else forwarded[0]
    return request.client.host if request.client else None


def _per_ip(request: Request, limit: int, window: int) -> None:
    limiter.hit(f"ip:{_client_ip(request)}:{request.scope['route'].path}", limit, window)


def publisher(x_release_token: str | None = Header(default=None)) -> str:
    """CI, holding RELEASE_PUBLISH_TOKEN. Unset in the settings means publishing is closed, not open."""
    expected = get_settings().release_publish_token
    if expected is None:
        raise ServiceUnavailable("Bundle publishing is not configured on this server", code="publishing_disabled")
    if not x_release_token or not hmac.compare_digest(x_release_token, expected.get_secret_value()):
        raise Unauthenticated("Invalid release token")
    return "ci"


# ---- the phone ------------------------------------------------------------------------------------

@router.get("/bundle/latest", response_model=UpdateOut, responses={204: {"description": "Already up to date"}})
def latest(
    request: Request,
    channel: Channel = "stable",
    current: str | None = Query(default=None, max_length=64, description="The bundle the app is running, e.g. 2.0.8+421"),
    native: str | None = Query(default=None, max_length=32, description="Installed APK versionName, e.g. 2.0.7"),
    device: str | None = Query(default=None, max_length=128, description="Device id, for staged rollouts"),
    db: Session = Depends(get_db),
):
    """What this device should be running. 204 means stay where you are, which is the normal answer."""
    _per_ip(request, 60, 60)
    found = svc.resolve(db, channel, native_version=native, current=current, device_id=device)
    if found is None:
        # A bare Response, not None with a status set: returning None against a response_model makes
        # FastAPI validate it as the model and fail. 204 with no body is the normal, quiet answer.
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    bundle, mandatory = found
    return UpdateOut(
        bundle_id=bundle.bundle_id,
        version=bundle.version,
        build=bundle.build,
        url=f"/api/v1/app/bundle/{bundle.build}/download",
        sha256=bundle.sha256,
        size_bytes=bundle.size_bytes,
        mandatory=mandatory,
    )


@router.get("/bundle/{build}/download", include_in_schema=False)
def download(build: int, request: Request, db: Session = Depends(get_db),
             storage: StorageBackend = Depends(get_storage)):
    """The zip itself. Addressed by build number, so the bytes at a URL never change and the response can
    be cached hard -- a phone that loses the connection half way resumes rather than starting over."""
    _per_ip(request, 20, 300)
    bundle = db.scalar(select(WebBundle).where(WebBundle.build == build))
    if bundle is None:
        raise NotFound("Bundle not found")
    if not storage.serves_directly:
        url = storage.signed_url(bundle.storage_path, timedelta(seconds=get_settings().media_url_ttl_seconds))
        return RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    return StreamingResponse(
        storage.open(bundle.storage_path),
        media_type="application/zip",
        headers={
            "Content-Length": str(bundle.size_bytes),
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Bundle-Sha256": bundle.sha256,
            "X-Content-Type-Options": "nosniff",
        },
    )


# ---- CI -------------------------------------------------------------------------------------------

@router.post("/bundle", response_model=BundleOut, status_code=status.HTTP_201_CREATED)
async def publish(
    request: Request,
    version: str = Query(...),
    build: int = Query(...),
    git_sha: str = Query(...),
    sha256: str = Query(...),
    min_native_version: str = Query(default="0.0.0"),
    api_base_url: str | None = Query(default=None),
    notes: str | None = Query(default=None),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
    actor: str = Depends(publisher),
):
    """Upload a built bundle. Raw request body = the zip; metadata is in the query string. Publishing only
    stores it -- phones are unaffected until a channel is pointed at it."""
    meta = BundlePublish(
        version=version, build=build, git_sha=git_sha, sha256=sha256,
        min_native_version=min_native_version, api_base_url=api_base_url, notes=notes,
    )
    return svc.publish(db, storage, meta, await request.body(), actor)


@router.post("/channel/{channel}", response_model=ChannelOut)
def point_channel(channel: Channel, body: ChannelPoint, db: Session = Depends(get_db),
                  actor: str = Depends(publisher)):
    """Make a published build the one the channel serves. Naming an earlier build is the rollback."""
    return svc.point(db, channel, body, actor)


# ---- operators -------------------------------------------------------------------------------------

@router.get("/channel/{channel}", response_model=ChannelOut)
def read_channel(channel: Channel, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """What a channel is serving right now. Signed in, so the release state is visible in the admin UI."""
    row = db.get(WebChannel, channel)
    if row is None:
        raise NotFound(f"Channel {channel} has never been pointed at a bundle")
    return row


@router.get("/bundles", response_model=list[BundleOut])
def list_bundles(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db),
                 p: Principal = Depends(get_principal)):
    """Published bundles, newest build first: the release history, and the list to roll back from."""
    return svc.history(db, limit)
