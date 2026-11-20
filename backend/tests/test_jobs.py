"""Jobs (temporary test module): server changes reach phones through /sync/changes, phone changes arrive
through /sync/batch ('job.save')."""
import uuid
from datetime import datetime, timedelta, timezone

API = "/api/v1"
DEVICE = "dev-factory-0000"


def changes(world, who="jan", since=None):
    params = {"since": since} if since else None
    r = world.client.get(f"{API}/sync/changes", headers=world.h(who), params=params)
    assert r.status_code == 200, r.text
    return r.json()


def save(world, who="admin", **job):
    op = {"op_id": str(uuid.uuid4()), "type": "job.save", "payload": job}
    r = world.client.post(f"{API}/sync/batch", headers=world.h(who), json={"device_id": DEVICE, "operations": [op]})
    assert r.status_code == 200, r.text
    return r.json()["results"][0]


def test_server_job_reaches_every_phone_with_extra_fields(world):
    r = world.client.post(f"{API}/jobs", headers=world.h("admin"),
                          json={"title": "Clean coach B2", "priority": "high", "extra": {"assigned_to": "Ravi", "shift": 2}})
    assert r.status_code == 201, r.text
    job = r.json()
    # Visible to any signed-in user, in another division too, extra fields included as sent.
    for who in ("jan", "sup_b"):
        pulled = {j["id"]: j for j in changes(world, who)["jobs"]}
        assert pulled[job["id"]]["extra"] == {"assigned_to": "Ravi", "shift": 2}
        assert pulled[job["id"]]["priority"] == "high"


def test_server_edit_and_delete_arrive_in_the_delta(world):
    job = world.client.post(f"{API}/jobs", headers=world.h("admin"), json={"title": "Refill soap"}).json()
    cursor = changes(world)["cursor"]
    r = world.client.patch(f"{API}/jobs/{job['id']}", headers=world.h("admin"), json={"status": "in_progress"})
    assert r.status_code == 200, r.text
    delta = {j["id"]: j for j in changes(world, since=cursor)["jobs"]}
    assert delta[job["id"]]["status"] == "in_progress"

    assert world.client.delete(f"{API}/jobs/{job['id']}", headers=world.h("admin")).status_code == 204
    delta = {j["id"]: j for j in changes(world, since=cursor)["jobs"]}
    assert delta[job["id"]]["is_deleted"] is True
    # A full pull (new device) does not download deleted jobs at all.
    assert job["id"] not in {j["id"] for j in changes(world)["jobs"]}
    assert world.client.get(f"{API}/jobs/{job['id']}", headers=world.h("admin")).status_code == 404


def test_phone_save_creates_updates_and_keeps_server_extra(world):
    job_id = str(uuid.uuid4())
    result = save(world, id=job_id, title="Check water tank", priority="low", status="open")
    assert result["outcome"] == "acknowledged", result
    world.client.patch(f"{API}/jobs/{job_id}", headers=world.h("admin"), json={"extra": {"note": "from server"}})

    result = save(world, id=job_id, title="Check water tank", priority="low", status="done")
    assert result["outcome"] == "acknowledged", result
    job = world.client.get(f"{API}/jobs/{job_id}", headers=world.h("sup")).json()
    assert (job["status"], job["extra"]) == ("done", {"note": "from server"})

    assert save(world, id=job_id, title="Check water tank", deleted=True)["outcome"] == "acknowledged"
    assert world.client.get(f"{API}/jobs/{job_id}", headers=world.h("sup")).status_code == 404


def test_phone_save_is_validated(world):
    result = save(world, id=str(uuid.uuid4()), title="x", status="open")
    assert (result["outcome"], result["error"]["code"]) == ("rejected", "validation_error")
    result = save(world, id=str(uuid.uuid4()), title="Valid title", extra={"a": 1})
    assert result["outcome"] == "rejected"  # phones may not set server-owned fields


def test_future_cursor_returns_no_jobs(world):
    world.client.post(f"{API}/jobs", headers=world.h("admin"), json={"title": "Old job"})
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert changes(world, since=future)["jobs"] == []


def test_admins_can_change_jobs(world):
    for who in ("sa", "admin"):
        r = world.client.post(f"{API}/jobs", headers=world.h(who), json={"title": f"Job by {who}"})
        assert r.status_code == 201, (who, r.text)
        job_id = r.json()["id"]
        assert world.client.patch(f"{API}/jobs/{job_id}", headers=world.h(who), json={"status": "done"}).status_code == 200
        assert world.client.delete(f"{API}/jobs/{job_id}", headers=world.h(who)).status_code == 204
        assert save(world, who, id=str(uuid.uuid4()), title=f"Phone job by {who}")["outcome"] == "acknowledged"


def test_manager_ehk_janitor_and_contractor_can_only_view_jobs(world):
    job = world.client.post(f"{API}/jobs", headers=world.h("admin"), json={"title": "Visible to all"}).json()
    for who in ("manager", "sup", "jan", "contractor"):
        assert job["id"] in {j["id"] for j in changes(world, who)["jobs"]}
        assert world.client.get(f"{API}/jobs/{job['id']}", headers=world.h(who)).status_code == 200
        assert world.client.get(f"{API}/jobs", headers=world.h(who)).status_code == 200

        r = world.client.post(f"{API}/jobs", headers=world.h(who), json={"title": "Not allowed"})
        assert (r.status_code, r.json()["error"]["code"]) == (403, "job_view_only"), r.text
        assert world.client.patch(f"{API}/jobs/{job['id']}", headers=world.h(who), json={"status": "done"}).status_code == 403
        assert world.client.delete(f"{API}/jobs/{job['id']}", headers=world.h(who)).status_code == 403

        # An edit sent from a view-only phone is refused and changes nothing.
        result = save(world, who, id=job["id"], title="Hijacked", status="done")
        assert (result["outcome"], result["error"]["code"]) == ("rejected", "job_view_only"), result
        new_id = str(uuid.uuid4())
        assert save(world, who, id=new_id, title="New from a view-only role")["outcome"] == "rejected"
        assert world.client.get(f"{API}/jobs/{new_id}", headers=world.h("admin")).status_code == 404
    after = world.client.get(f"{API}/jobs/{job['id']}", headers=world.h("admin")).json()
    assert (after["title"], after["status"]) == ("Visible to all", "open")
