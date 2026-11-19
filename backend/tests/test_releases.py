"""Over-the-air web bundle releases.

The point of these tests is that the two ways this feature can go wrong are both covered: a bundle that
should not reach a phone (unverified, incomplete, or needing a newer APK) must not be served, and a phone
already on the right bundle must be told to stay there rather than download it again.
"""

import hashlib
import io
import zipfile

import pytest
from pydantic import SecretStr

TOKEN = "test-release-token-" + "z" * 20
PUBLISH = "/api/v1/app/bundle"
LATEST = "/api/v1/app/bundle/latest"
SHA40 = "a" * 40


def make_bundle(extra: dict[str, str] | None = None, omit: tuple[str, ...] = ()) -> bytes:
    """A zip shaped like a Vite build: the entries app/services/releases.py insists on."""
    files = {
        "index.html": "<!doctype html><html><body><div id=root></div></body></html>",
        "manifest.webmanifest": '{"name":"Swachh Safar"}',
        "assets/index-abc123.js": "console.log('app')",
        "serviceWorker.js": "// sw",
    }
    for name in omit:
        files.pop(name, None)
    files.update(extra or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


@pytest.fixture
def token():
    """RELEASE_PUBLISH_TOKEN, set for the duration of the test (unset means publishing is closed)."""
    from app.config import get_settings

    settings = get_settings()
    previous = settings.release_publish_token
    settings.release_publish_token = SecretStr(TOKEN)
    yield TOKEN
    settings.release_publish_token = previous


def publish(client, token, body: bytes, *, version="2.0.8", build=421, min_native="0.0.0",
            api_base="https://ehk.itfarmer.in/api/v1", sha=None, header_token=None):
    return client.post(
        PUBLISH,
        params={
            "version": version, "build": build, "git_sha": SHA40,
            "sha256": sha or hashlib.sha256(body).hexdigest(),
            "min_native_version": min_native, "api_base_url": api_base,
        },
        content=body,
        headers={"X-Release-Token": header_token or token, "Content-Type": "application/zip"},
    )


def point(client, token, build, **kw):
    return client.post(f"/api/v1/app/channel/stable", json={"build": build, **kw},
                       headers={"X-Release-Token": token})


# ---- publishing -----------------------------------------------------------------------------------

def test_publishing_needs_the_release_token(client, token):
    body = make_bundle()
    assert publish(client, token, body, header_token="wrong").status_code == 401
    assert client.post(PUBLISH, content=body, params={"version": "2.0.8", "build": 1, "git_sha": SHA40,
                                                      "sha256": hashlib.sha256(body).hexdigest()}).status_code == 401


def test_publishing_is_closed_when_no_token_is_configured(client):
    """No RELEASE_PUBLISH_TOKEN in the settings must mean closed, never open."""
    body = make_bundle()
    res = publish(client, "anything", body)
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "publishing_disabled"


def test_publish_records_the_bundle_but_changes_nothing_for_phones(client, token):
    res = publish(client, token, make_bundle())
    assert res.status_code == 201
    assert res.json()["build"] == 421
    # Published is not released: until a channel is pointed at it, every phone is told to stay put.
    assert client.get(LATEST).status_code == 204


def test_a_body_that_does_not_match_the_declared_hash_is_refused(client, token):
    res = publish(client, token, make_bundle(), sha="0" * 64)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "bundle_hash_mismatch"


def test_a_body_that_is_not_a_zip_is_refused(client, token):
    res = publish(client, token, b"this is not a zip file at all")
    assert res.json()["error"]["code"] == "bundle_not_zip"


@pytest.mark.parametrize("omit", [("index.html",), ("manifest.webmanifest",), ("assets/index-abc123.js",)])
def test_an_incomplete_build_is_refused(client, token, omit):
    """A zip that is missing part of the build would leave the app unable to start, and the phone has no
    way to tell us: it is refused here, where there is still something to refuse."""
    res = publish(client, token, make_bundle(omit=omit))
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "bundle_incomplete"


@pytest.mark.parametrize("name", ["../escaped.js", "/etc/passwd", "assets/../../escaped.js"])
def test_an_entry_that_escapes_the_bundle_directory_is_refused(client, token, name):
    res = publish(client, token, make_bundle(extra={name: "x"}))
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "bundle_unsafe_path"


def test_a_bundle_built_for_the_pwa_is_refused(client, token):
    """The WebView serves from https://localhost, so a bundle built with a relative /api/v1 would send
    every request at the app's own files. That is the PWA build, and it must not be published."""
    res = publish(client, token, make_bundle(), api_base="/api/v1")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "bundle_relative_api_base"


def test_republishing_the_same_build_is_idempotent_but_not_rewritable(client, token):
    body = make_bundle()
    first = publish(client, token, body)
    assert first.status_code == 201
    # Re-running the same CI job must not fail the pipeline.
    again = publish(client, token, body)
    assert again.status_code == 201
    assert again.json()["sha256"] == first.json()["sha256"]
    # Different contents under a build number already out there would change what phones have verified.
    res = publish(client, token, make_bundle(extra={"assets/index-abc123.js": "console.log('different')"}))
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "bundle_build_reused"


# ---- what the phone is told ------------------------------------------------------------------------

def test_pointing_the_channel_is_what_releases_it(client, token):
    publish(client, token, make_bundle())
    assert client.get(LATEST).status_code == 204
    assert point(client, token, 421).status_code == 200

    res = client.get(LATEST)
    assert res.status_code == 200
    body = res.json()
    assert body["bundle_id"] == "2.0.8+421"
    assert body["url"] == "/api/v1/app/bundle/421/download"
    assert body["mandatory"] is False


def test_a_phone_already_on_the_bundle_is_told_to_stay(client, token):
    publish(client, token, make_bundle())
    point(client, token, 421)
    assert client.get(LATEST, params={"current": "2.0.8+421"}).status_code == 204
    assert client.get(LATEST, params={"current": "2.0.7+400"}).status_code == 200


def test_an_unpublished_channel_offers_nothing(client, token):
    """A server that has never published a bundle must leave every phone on the build in its APK."""
    assert client.get(LATEST).status_code == 204
    assert client.get(LATEST, params={"channel": "beta"}).status_code == 204


def test_a_bundle_needing_a_newer_apk_is_withheld(client, token):
    publish(client, token, make_bundle(), min_native="2.1.0")
    point(client, token, 421)
    # An older APK lacks the native plugin methods this bundle calls: serving it would break the app on
    # launch, and a phone whose bundle does not start cannot ask for a better one.
    assert client.get(LATEST, params={"native": "2.0.7"}).status_code == 204
    assert client.get(LATEST, params={"native": "2.1.0"}).status_code == 200
    assert client.get(LATEST, params={"native": "3.0.0"}).status_code == 200


def test_an_unreadable_native_version_is_left_alone(client, token):
    publish(client, token, make_bundle(), min_native="2.1.0")
    point(client, token, 421)
    assert client.get(LATEST, params={"native": "not-a-version"}).status_code == 204


# ---- staged rollout and rollback -------------------------------------------------------------------

def test_a_zero_percent_rollout_reaches_nobody_and_a_full_one_reaches_everybody(client, token):
    publish(client, token, make_bundle())
    point(client, token, 421, rollout_percent=0)
    assert client.get(LATEST, params={"device": "phone-1"}).status_code == 204
    point(client, token, 421, rollout_percent=100)
    assert client.get(LATEST, params={"device": "phone-1"}).status_code == 200


def test_a_partial_rollout_gives_a_device_the_same_answer_every_time(client, token):
    """A device that flipped between two bundles on each check would reinstall the app all day."""
    publish(client, token, make_bundle())
    point(client, token, 421, rollout_percent=50)
    answers = {client.get(LATEST, params={"device": "phone-7"}).status_code for _ in range(8)}
    assert len(answers) == 1

    codes = [client.get(LATEST, params={"device": f"phone-{i}"}).status_code for i in range(60)]
    assert 200 in codes and 204 in codes  # it does split the fleet, rather than being all-or-nothing


def test_rolling_back_brings_phones_on_the_newer_build_back_down(client, token):
    publish(client, token, make_bundle(), version="2.0.8", build=421)
    publish(client, token, make_bundle(extra={"assets/index-abc123.js": "console.log('bad')"}),
            version="2.0.9", build=422)
    point(client, token, 422)
    assert client.get(LATEST, params={"current": "2.0.8+421"}).json()["build"] == 422

    res = point(client, token, 421)
    assert res.status_code == 200
    assert res.json()["rolled_back_from"] == 422
    # A phone that already took 422 is told to come back to 421, not that it is up to date.
    back = client.get(LATEST, params={"current": "2.0.9+422"})
    assert back.status_code == 200
    assert back.json()["bundle_id"] == "2.0.8+421"


def test_pointing_at_a_build_that_was_never_published_is_refused(client, token):
    assert point(client, token, 999).status_code == 404


# ---- the download ----------------------------------------------------------------------------------

def test_the_download_serves_exactly_the_bytes_that_were_published(client, token):
    body = make_bundle()
    publish(client, token, body)
    point(client, token, 421)
    url = client.get(LATEST).json()["url"]

    res = client.get(url)
    assert res.status_code == 200
    assert res.content == body
    # The hash the device checks before it unpacks anything.
    assert hashlib.sha256(res.content).hexdigest() == client.get(LATEST).json()["sha256"]


def test_downloading_a_bundle_that_does_not_exist_is_a_404(client, token):
    assert client.get("/api/v1/app/bundle/9999/download").status_code == 404
