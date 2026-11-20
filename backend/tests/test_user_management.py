"""Administrator user management: profile summary, password reset, search and status."""

import uuid

from sqlalchemy import select

from app.models import AuditLog, AuthSession, UserCredential
from app.security.passwords import verify_password

API = "/api/v1"
NEW = "Fresh-Password-42"


def _can_sign_in(db, user_id, password) -> bool:
    db.expire_all()
    cred = db.get(UserCredential, user_id)
    return cred is not None and verify_password(cred.password_hash, password).ok


def test_admin_resets_a_managed_users_password_and_ends_their_sessions(client, world, db):
    jan = world.jan
    assert client.get(f"{API}/auth/me", headers=world.h("jan")).status_code == 200
    r = client.post(f"{API}/users/{jan.id}/password", headers=world.h("manager"), json={"new_password": NEW})
    assert r.status_code == 200 and r.json()["sessions_ended"] >= 1
    assert NEW not in r.text
    assert _can_sign_in(db, jan.id, NEW)
    # The old session no longer works.
    r = client.get(f"{API}/auth/me", headers=world.h("jan"))
    assert r.status_code == 401 and r.json()["error"]["code"] == "session_revoked"
    # Only that employee changed: the other janitor's sessions are untouched and no credential appeared.
    assert client.get(f"{API}/auth/me", headers=world.h("jan2")).status_code == 200
    assert db.get(UserCredential, world.jan2.id) is None
    # Audited, without the password.
    row = db.scalar(select(AuditLog).where(AuditLog.action == "user.password.reset", AuditLog.entity_id == str(jan.id)))
    assert row is not None and NEW not in str(row.changes)
    revoked = db.scalars(select(AuthSession).where(AuthSession.user_id == jan.id)).all()
    assert all(s.revoke_reason == "password_reset" for s in revoked)


def test_password_reset_respects_permission_and_hierarchy(client, world):
    body = {"new_password": NEW}
    # A supervisor holds no users.manage; a manager may not manage an admin; another division's manager may not reach A.
    assert client.post(f"{API}/users/{world.jan.id}/password", headers=world.h("sup"), json=body).status_code == 403
    assert client.post(f"{API}/users/{world.admin.id}/password", headers=world.h("manager"), json=body).status_code == 403
    assert client.post(f"{API}/users/{world.jan.id}/password", headers=world.h("manager_b"), json=body).status_code == 403
    # Own password goes through the change-password flow with the current password.
    r = client.post(f"{API}/users/{world.manager.id}/password", headers=world.h("manager"), json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "own_password"
    # Weak passwords are refused by validation.
    r = client.post(f"{API}/users/{world.jan.id}/password", headers=world.h("manager"), json={"new_password": "short"})
    assert r.status_code == 422
    assert client.post(f"{API}/users/{uuid.uuid4()}/password", headers=world.h("manager"), json=body).status_code == 404


def test_account_summary_has_no_secrets_and_respects_visibility(client, world, db):
    r = client.post(f"{API}/users/{world.jan.id}/password", headers=world.h("manager"), json={"new_password": NEW})
    assert r.status_code == 200
    r = client.get(f"{API}/users/{world.jan.id}/account", headers=world.h("manager"))
    assert r.status_code == 200
    out = r.json()
    assert out["password_set"] is True and out["password_set_by"] == "admin" and out["password_changed_at"]
    assert out["division_code"] == "AAA" and out["role_name"]
    assert out["permissions"] and out["permissions"] == sorted(out["permissions"])
    assert "users.manage" not in out["permissions"]  # a janitor's effective access, not the caller's
    text = r.text.lower()
    for secret in ("password_hash", "scrypt", "descriptor", "template", NEW.lower()):
        assert secret not in text
    # A janitor cannot read a colleague's account; another division's manager cannot either.
    # (jan2 asks: jan's own sessions were ended by the reset above.)
    assert client.get(f"{API}/users/{world.jan.id}/account", headers=world.h("jan2")).status_code == 404
    assert client.get(f"{API}/users/{world.jan.id}/account", headers=world.h("manager_b")).status_code in (403, 404)


def test_user_search_matches_email(client, world):
    body = dict(emp_id="MAIL1", name="Mailable", role_id=5, division_id=str(world.a.id), email="Findable.Person@example.com")
    assert client.post(f"{API}/users", headers=world.h("manager"), json=body).status_code == 201
    r = client.get(f"{API}/users", headers=world.h("manager"), params={"q": "findable.person"})
    assert [u["emp_id"] for u in r.json()["items"]] == ["MAIL1"]


def test_edit_and_status_persist(client, world, db):
    jan = world.jan
    r = client.patch(f"{API}/users/{jan.id}", headers=world.h("manager"), json={"designation": "Senior janitor", "mobile": "9876512345"})
    assert r.status_code == 200 and r.json()["designation"] == "Senior janitor"
    assert client.get(f"{API}/users/{jan.id}", headers=world.h("manager")).json()["mobile"] == "9876512345"
    r = client.post(f"{API}/users/{jan.id}/status", headers=world.h("manager"), json={"status": "inactive"})
    assert r.status_code == 200 and r.json()["status"] == "inactive"
    assert client.get(f"{API}/auth/me", headers=world.h("jan")).json()["error"]["code"] == "account_inactive"
    # Promoting beyond one's own reach is refused.
    r = client.patch(f"{API}/users/{jan.id}", headers=world.h("manager"), json={"role_id": 2})
    assert r.status_code == 403
