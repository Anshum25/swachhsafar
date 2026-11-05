import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models import Attendance, SyncOperation
from tests.factories import PNG, now_iso, upload

API = "/api/v1"


def init(world, data, kind="attendance_photo", content_type="image/png", size=None, sha=None, by="sup"):
    media_id = str(uuid.uuid4())
    r = world.client.post(f"{API}/media", headers=world.h(by), json=dict(
        id=media_id, division_id=str(world.a.id), kind=kind, content_type=content_type,
        size_bytes=size or len(data), sha256=sha or hashlib.sha256(data).hexdigest()))
    return media_id, r


def test_upload_validates_content(world):
    media_id, r = init(world, PNG)
    assert r.status_code == 201 and r.json()["status"] == "pending"
    r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    assert r.status_code == 200 and (r.json()["status"], r.json()["content_type"]) == ("uploaded", "image/png")
    link = world.client.get(f"{API}/media/{media_id}/download", headers=world.h("manager")).json()
    assert world.client.get(link["url"], headers=world.h("manager")).content == PNG
    assert world.client.get(f"{API}/media/{media_id}/download", headers=world.h("manager_b")).status_code == 403


def test_spoofed_type_checksum_and_size_rejected(world):
    fake = b"<?php system($_GET['c']); ?>" + bytes(50)
    media_id, _ = init(world, fake)
    r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=fake)
    assert r.status_code == 422 and "not an allowed type" in r.json()["error"]["message"]
    media_id, _ = init(world, PNG, sha="a" * 64)
    assert world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG).json()["error"]["message"] == "Checksum mismatch"
    _, r = init(world, PNG, size=9 * 1024 * 1024)
    assert r.status_code == 422 and r.json()["error"]["code"] == "file_too_large"
    _, r = init(world, PNG, content_type="application/x-msdownload")
    assert r.json()["error"]["code"] == "file_type_rejected"
    media_id, _ = init(world, PNG)
    assert world.client.put(f"{API}/media/{media_id}/content", headers=world.h("jan"), content=PNG).status_code == 404


def test_upload_is_idempotent(world):
    media_id = upload(world.client, world.sup, world.a.id, "attendance_photo")
    r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    assert r.status_code == 200 and r.json()["status"] == "uploaded"


def _attendance_op(world, media_id, stage=1, employee="jan", record_id=None):
    return dict(op_id=str(uuid.uuid4()), type="attendance.create", payload=dict(
        id=record_id or str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.users[employee].id), stage=stage,
        device_timestamp=now_iso(), latitude=23.1, longitude=79.9, photo_media_id=media_id))


def batch(world, ops, by="sup"):
    r = world.client.post(f"{API}/sync/batch", headers=world.h(by), json={"device_id": "device-001", "operations": ops})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_batch_outcomes(world):
    media_id, _ = init(world, PNG)  # registered but bytes not yet uploaded
    pending_op = _attendance_op(world, media_id)
    bad_op = dict(op_id=str(uuid.uuid4()), type="attendance.create", payload={"id": str(uuid.uuid4()), "stage": 9})
    order_op = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"), stage=3, employee="sup")
    res = batch(world, [pending_op, bad_op, order_op])
    assert [r["outcome"] for r in res] == ["retry", "rejected", "rejected"]
    assert res[0]["error"]["code"] == "media_pending" and res[2]["error"]["code"] == "stage_order"

    world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    res = batch(world, [pending_op])
    assert res[0]["outcome"] == "acknowledged" and res[0]["http_status"] == 201

    # lost acknowledgement: same op again returns the stored outcome without a second record
    again = batch(world, [pending_op])
    assert again[0]["outcome"] == "acknowledged" and again[0]["replayed"] is True
    assert world.db.scalar(select(func.count()).select_from(Attendance)) == 1
    assert world.client.get(f"{API}/sync/operations/{pending_op['op_id']}", headers=world.h("sup")).json()["outcome"] == "acknowledged"
    record = world.db.scalar(select(Attendance))
    assert str(record.sync_op_id) == pending_op["op_id"]


def test_duplicate_from_second_device_is_conflict(world):
    first = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"))
    second = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"))
    res = batch(world, [first, second])
    assert [r["outcome"] for r in res] == ["acknowledged", "conflict"]
    assert res[1]["error"]["code"] == "duplicate_attendance"
    assert world.db.scalar(select(func.count()).select_from(SyncOperation)) == 2


def test_op_id_cannot_be_hijacked(world):
    op = _attendance_op(world, upload(world.client, world.sup, world.a.id, "attendance_photo"))
    batch(world, [op])
    res = batch(world, [op], by="jan")
    assert res[0]["outcome"] == "rejected" and res[0]["error"]["code"] == "op_id_reused"
    assert world.client.get(f"{API}/sync/operations/{op['op_id']}", headers=world.h("jan")).status_code == 404


def test_batch_handles_other_types(world):
    item = world.client.post(f"{API}/inventory/items", headers=world.h("admin"),
                             json={"division_id": str(world.a.id), "name": "Soap", "unit": "nos", "ideal_qty": 10}).json()
    ops = [dict(op_id=str(uuid.uuid4()), type="inventory.record", payload=dict(
        id=str(uuid.uuid4()), journey_id=world.journey["id"], item_id=item["id"], txn_type="issue", quantity=3))]
    assert batch(world, ops)[0]["outcome"] == "acknowledged"


def test_incremental_changes(world):
    full = world.client.get(f"{API}/sync/changes", headers=world.h("sup")).json()
    assert full["full"] is True
    assert [t["train_no"] for t in full["trains"]] == ["12001"]
    assert [j["id"] for j in full["journeys"]] == [world.journey["id"]]
    assert str(world.a.id) in full["policies"] and len(full["question_banks"]) == 2
    jan_view = world.client.get(f"{API}/sync/changes", headers=world.h("jan2")).json()
    assert jan_view["journeys"] == []

    future = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    later = world.client.get(f"{API}/sync/changes", params={"since": future}, headers=world.h("sup")).json()
    assert later["full"] is False and later["trains"] == [] and later["journeys"] == []
    since = full["cursor"]
    world.client.post(f"/api/v1/staff-allocation/{world.journey['id']}", headers=world.h("manager"),
                      json={"user_ids": [str(world.jan2.id)]})
    delta = world.client.get(f"{API}/sync/changes", params={"since": since}, headers=world.h("jan2")).json()
    assert [j["id"] for j in delta["journeys"]] == [world.journey["id"]]


# ---- journey-wise storage layout ----

def _init_with_journey(world, data, journey_id, division=None):
    media_id = str(uuid.uuid4())
    r = world.client.post(f"{API}/media", headers=world.h("sup"), json=dict(
        id=media_id, division_id=str(division or world.a.id), kind="attendance_photo", content_type="image/png",
        size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), journey_id=journey_id))
    return media_id, r


def test_media_is_stored_in_its_journey_folder(world, db):
    from app.models import Journey, MediaObject, Train
    from tests.conftest import _MEDIA

    media_id, r = _init_with_journey(world, PNG, world.journey["id"])
    assert r.status_code == 201, r.text
    assert world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG).status_code == 200
    db.expire_all()
    stored = db.get(MediaObject, uuid.UUID(media_id))
    journey = db.get(Journey, uuid.UUID(world.journey["id"]))
    train_no = db.get(Train, journey.train_id).train_no
    folder = f"journeys/{journey.journey_date:%Y-%m-%d}_{''.join(c if c.isalnum() or c == '-' else '-' for c in train_no).strip('-')}_{journey.id}"
    assert stored.storage_path == f"{folder}/attendance_photo/{media_id}.png"
    assert (_MEDIA / stored.storage_path).read_bytes() == PNG
    # Served back through the authenticated API as before.
    link = world.client.get(f"{API}/media/{media_id}/download", headers=world.h("manager")).json()
    assert world.client.get(link["url"], headers=world.h("manager")).content == PNG


def test_media_without_journey_goes_to_other(world, db):
    from app.models import MediaObject

    media_id, _ = init(world, PNG)
    world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    db.expire_all()
    assert db.get(MediaObject, uuid.UUID(media_id)).storage_path.startswith("other/attendance_photo/")


def test_journey_must_exist_in_the_media_division(world):
    _, r = _init_with_journey(world, PNG, str(uuid.uuid4()))
    assert r.status_code == 422 and r.json()["error"]["code"] == "journey_mismatch"
    # A real journey, but of division A, declared for a division-B file (the supervisor may not even upload there).
    _, r = _init_with_journey(world, PNG, world.journey["id"], division=world.b.id)
    assert r.status_code in (403, 422)


def test_older_client_init_then_journey_on_retry(world, db):
    """A file registered without journey_id (older app) is filed journey-wise once a retry declares it."""
    from app.models import MediaObject

    media_id, _ = init(world, PNG)
    r = world.client.post(f"{API}/media", headers=world.h("sup"), json=dict(
        id=media_id, division_id=str(world.a.id), kind="attendance_photo", content_type="image/png",
        size_bytes=len(PNG), sha256=hashlib.sha256(PNG).hexdigest(), journey_id=world.journey["id"]))
    assert r.status_code == 201
    world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    db.expire_all()
    assert db.get(MediaObject, uuid.UUID(media_id)).storage_path.startswith("journeys/")


def test_storage_failure_is_retryable_not_a_crash(world, db):
    """Missing bucket / full disk: 503 storage_unavailable (the device retries), file stays pending."""
    from app.main import app
    from app.models import MediaObject, MediaStatus
    from app.providers.storage import get_storage

    class Broken:
        serves_directly = True

        def put(self, *a, **k):
            raise OSError("No space left on device")

    previous = app.dependency_overrides[get_storage]
    app.dependency_overrides[get_storage] = lambda: Broken()
    try:
        media_id, _ = _init_with_journey(world, PNG, world.journey["id"])
        r = world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
        assert r.status_code == 503 and r.json()["error"]["code"] == "storage_unavailable"
    finally:
        app.dependency_overrides[get_storage] = previous
    db.expire_all()
    assert db.get(MediaObject, uuid.UUID(media_id)).status == MediaStatus.PENDING
    # Storage back: the same upload succeeds.
    assert world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG).status_code == 200


def test_file_by_journey_moves_old_uploads_into_their_journey_folder(world, db):
    """An older app uploaded without journey_id (file under other/); the record that uses it names the journey."""
    from app.models import MediaObject
    from app.services.media import file_by_journey
    from tests.conftest import _MEDIA

    media_id, _ = init(world, PNG)
    world.client.put(f"{API}/media/{media_id}/content", headers=world.h("sup"), content=PNG)
    batch(world, [_attendance_op(world, media_id)])
    db.expire_all()
    old = db.get(MediaObject, uuid.UUID(media_id)).storage_path
    assert old.startswith("other/")

    assert file_by_journey(db, str(_MEDIA), dry_run=True)[0][0] == old
    db.expire_all()
    assert db.get(MediaObject, uuid.UUID(media_id)).storage_path == old  # dry run changes nothing

    moved = file_by_journey(db, str(_MEDIA))
    db.expire_all()
    media = db.get(MediaObject, uuid.UUID(media_id))
    assert moved == [(old, media.storage_path)] and media.storage_path.startswith("journeys/")
    assert str(media.journey_id) == world.journey["id"]
    assert (_MEDIA / media.storage_path).read_bytes() == PNG and not (_MEDIA / old).exists()
    link = world.client.get(f"{API}/media/{media_id}/download", headers=world.h("manager")).json()
    assert world.client.get(link["url"], headers=world.h("manager")).content == PNG
    assert file_by_journey(db, str(_MEDIA)) == []  # idempotent
