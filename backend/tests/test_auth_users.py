import uuid
from datetime import timedelta

from sqlalchemy import select

from app.models import EmployeeKyc, RoleId, User, UserStatus
from app.timeutil import today_ist
from tests.factories import auth, make_user

API = "/api/v1"


def test_missing_and_invalid_token(client, world):
    assert client.get(f"{API}/auth/me").status_code == 401
    r = client.get(f"{API}/auth/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_token"


def test_inactive_and_deleted_accounts_are_refused(client, world, db):
    inactive = make_user(db, world.a, RoleId.JANITOR, "idle")
    headers = auth(inactive)
    inactive.status = UserStatus.INACTIVE
    db.commit()
    r = client.get(f"{API}/auth/me", headers=headers)
    assert r.status_code == 403 and r.json()["error"]["code"] == "account_inactive"
    inactive.status = UserStatus.DELETED
    db.commit()
    r = client.get(f"{API}/auth/me", headers=headers)
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_provisioned"


def test_a_token_with_the_wrong_secret_or_an_old_firebase_token_is_refused(client, world):
    good = world.h("jan")["Authorization"].split(" ", 1)[1]
    prefix, sid, _ = good.split(".")
    for bad in (f"{prefix}.{sid}.not-the-secret", "eyJhbGciOiJSUzI1NiJ9.firebase.idtoken", f"ss1.{uuid.uuid4().hex}.x"):
        r = client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {bad}"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_token"


def test_hierarchy_on_user_creation(client, world):
    body = dict(emp_id="X1", name="Someone", role_id=int(RoleId.ADMIN), division_id=str(world.a.id))
    r = client.post(f"{API}/users", headers=world.h("manager"), json=body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "hierarchy_forbidden"
    body["role_id"] = int(RoleId.JANITOR)
    r = client.post(f"{API}/users", headers=world.h("manager"), json=body)
    assert r.status_code == 201
    assert client.post(f"{API}/users", headers=world.h("sup"), json={**body, "emp_id": "X2"}).status_code == 403


def test_client_cannot_mass_assign_server_fields(client, world):
    body = dict(emp_id="X3", name="Someone", role_id=5, division_id=str(world.a.id), status="active", created_by_id=str(world.sa.id))
    r = client.post(f"{API}/users", headers=world.h("manager"), json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_uniqueness_among_live_users(client, world):
    body = dict(emp_id="DUP", name="First", role_id=5, division_id=str(world.a.id), mobile="9876500001")
    first = client.post(f"{API}/users", headers=world.h("manager"), json=body).json()
    r = client.post(f"{API}/users", headers=world.h("manager"), json={**body, "name": "Second"})
    assert r.status_code == 409
    assert client.post(f"{API}/users/{first['id']}/status", headers=world.h("manager"), json={"status": "deleted"}).status_code == 200
    assert client.post(f"{API}/users", headers=world.h("manager"), json={**body, "name": "Second"}).status_code == 201


def test_division_isolation(client, world):
    r = client.post(f"{API}/users", headers=world.h("manager_b"),
                    json=dict(emp_id="X4", name="Intruder", role_id=5, division_id=str(world.a.id)))
    assert r.status_code == 403 and r.json()["error"]["code"] == "division_forbidden"
    assert client.get(f"{API}/users/{world.jan.id}", headers=world.h("manager_b")).status_code == 404
    assert client.get(f"{API}/journeys/{world.journey['id']}", headers=world.h("manager_b")).status_code == 404
    listed = client.get(f"{API}/users", headers=world.h("manager_b")).json()
    assert {u["division_id"] for u in listed["items"]} == {str(world.b.id)}
    assert client.get(f"{API}/users?division_id={world.a.id}", headers=world.h("manager_b")).status_code == 403


def test_visibility_hierarchy_in_listing(client, world):
    roles = {u["role_id"] for u in client.get(f"{API}/users", headers=world.h("manager")).json()["items"]}
    assert roles <= {3, 4, 5}  # manager sees supervisors, janitors and themself
    roles = {u["role_id"] for u in client.get(f"{API}/users", headers=world.h("admin")).json()["items"]}
    assert 6 in roles and 1 not in roles


def test_deactivation_blocks_login(client, world):
    assert client.post(f"{API}/users/{world.jan.id}/status", headers=world.h("manager"), json={"status": "inactive"}).status_code == 200
    assert client.get(f"{API}/auth/me", headers=world.h("jan")).status_code == 403
    assert client.post(f"{API}/users/{world.manager.id}/status", headers=world.h("manager"), json={"status": "inactive"}).status_code == 422


def test_kyc_is_restricted(client, world, db):
    body = dict(father_name="Ram", aadhaar_number="123412341234", rail_reg_id="RR1")
    assert client.put(f"{API}/users/{world.jan.id}/kyc", headers=world.h("manager"), json=body).status_code == 403
    r = client.put(f"{API}/users/{world.jan.id}/kyc", headers=world.h("admin"), json=body)
    assert r.status_code == 200 and r.json()["aadhaar_last4"] == "1234"
    assert "aadhaar_number" not in r.json()
    assert db.get(EmployeeKyc, world.jan.id).aadhaar_last4 == "1234"
    assert client.get(f"{API}/users/{world.jan.id}/kyc", headers=world.h("manager")).status_code == 403
    assert client.get(f"{API}/users/{world.jan.id}/kyc", headers=world.h("sup")).status_code == 403
    assert client.get(f"{API}/users/{world.jan.id}/kyc", headers=world.h("jan")).status_code == 200  # own record
    audit = client.get(f"{API}/audit?entity_type=employee_kyc", headers=world.h("admin")).json()
    assert any(a["action"] == "user.kyc.read" for a in audit["items"])


def test_division_override_denies_permission(client, world):
    r = client.put(f"{API}/permissions/grants", headers=world.h("admin"),
                   json=dict(role_id=4, permission_code="feedback.collect", division_id=str(world.a.id), effect="deny"))
    assert r.status_code == 200
    me = client.get(f"{API}/auth/me", headers=world.h("sup")).json()
    assert "feedback.collect" not in me["divisions"][str(world.a.id)]
    assert client.put(f"{API}/permissions/grants", headers=world.h("admin"),
                      json=dict(role_id=4, permission_code="feedback.collect", effect="deny")).status_code == 403


def test_charge_map_grants_temporary_access(client, world, db):
    assert client.get(f"{API}/journeys/{world.journey['id']}", headers=world.h("manager_b")).status_code == 404
    today = today_ist()
    body = dict(user_id=str(world.manager_b.id), division_id=str(world.a.id), from_date=str(today), to_date=str(today + timedelta(days=3)))
    assert client.post(f"{API}/users/charge-maps", headers=world.h("admin"), json=body).status_code == 403  # admin A has no authority over B
    r = client.post(f"{API}/users/charge-maps", headers=world.h("sa"), json=body)
    assert r.status_code == 201, r.text
    assert client.get(f"{API}/journeys/{world.journey['id']}", headers=world.h("manager_b")).status_code == 200
    assert client.post(f"{API}/users/charge-maps", headers=world.h("sa"), json=body).status_code == 409
    client.post(f"{API}/users/charge-maps/{r.json()['id']}/end", headers=world.h("sa"))
    assert client.get(f"{API}/journeys/{world.journey['id']}", headers=world.h("manager_b")).status_code == 404
    sup_charge = {**body, "user_id": str(world.sup_b.id)}
    assert client.post(f"{API}/users/charge-maps", headers=world.h("sa"), json=sup_charge).status_code == 422


def test_policy_requires_permission(client, world):
    assert client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("manager"), json={}).status_code == 403
    r = client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin"), json={"passenger_otp_required": False})
    assert r.status_code == 200 and r.json()["passenger_otp_required"] is False
    assert client.put(f"{API}/divisions/{world.a.id}/policy", headers=world.h("admin"), json={"bogus": 1}).status_code == 422


def test_cli_set_role_restricts_role_and_never_touches_super_admin(world, db):
    from app.cli import set_role

    sup = world.sup
    sup.email = "sup.role@example.com"
    world.sa.email = "sa.role@example.com"
    db.commit()
    assert set_role(db, email=sup.email.upper(), role="janitor") == 0
    db.refresh(sup)
    assert sup.role_id == RoleId.JANITOR
    assert set_role(db, email=sup.email, role="janitor") == 0  # no-op
    assert set_role(db, email=world.sa.email, role="admin") == 2
    assert set_role(db, email="nobody@example.com", role="admin") == 2


# ---- sign-in comes with the employee ------------------------------------------------------------------
# An administrator creating a user in the app is all it takes: the password hash is stored in PostgreSQL
# (user_credentials) in the same transaction as the employee.


def _can_sign_in(db, user_id, password) -> bool:
    from app.models import UserCredential
    from app.security.passwords import verify_password

    cred = db.get(UserCredential, user_id)
    return cred is not None and verify_password(cred.password_hash, password).ok


def test_creating_a_user_with_an_email_creates_their_signin(client, world, db):
    body = dict(emp_id="S1", name="Sign In", email="Sign.In@Example.com", role_id=5, division_id=str(world.a.id))
    r = client.post(f"{API}/users", headers=world.h("manager"), json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["password_set"] is True and out["signin"] == "created"
    assert out["face_enrolled"] is False and out["fingerprint_enrolled"] is False
    # The generated password is returned once, and is the one actually stored (hashed, never in clear).
    assert out["temp_password"] and _can_sign_in(db, uuid.UUID(out["id"]), out["temp_password"])
    from app.models import UserCredential

    cred = db.get(UserCredential, uuid.UUID(out["id"]))
    assert out["temp_password"] not in cred.password_hash and cred.password_hash.startswith("scrypt$")


def test_administrator_may_choose_the_password_and_it_is_never_echoed(client, world, db):
    body = dict(emp_id="S2", name="Chosen", role_id=5, division_id=str(world.a.id), password="Platform-9-and-3quarters")
    out = client.post(f"{API}/users", headers=world.h("manager"), json=body).json()
    assert out["signin"] == "created" and out["temp_password"] is None and out["password_set"] is True
    assert _can_sign_in(db, uuid.UUID(out["id"]), "Platform-9-and-3quarters")


def test_an_employee_without_email_or_password_gets_no_signin(client, world):
    out = client.post(f"{API}/users", headers=world.h("manager"),
                      json=dict(emp_id="S3", name="No Mail", role_id=5, division_id=str(world.a.id))).json()
    assert out["password_set"] is False and out["signin"] is None and out["temp_password"] is None


def test_firebase_uid_can_no_longer_be_assigned_by_a_client(client, world):
    body = dict(emp_id="S4", name="Fb", role_id=5, division_id=str(world.a.id), firebase_uid="someone-elses-uid")
    assert client.post(f"{API}/users", headers=world.h("manager"), json=body).status_code == 422


def test_signin_for_an_employee_who_has_none(client, world, db):
    user = make_user(db, world.a, RoleId.JANITOR, "Later")
    out = client.post(f"{API}/users/{user.id}/signin", headers=world.h("manager"), json={}).json()
    assert out["signin"] == "created" and out["temp_password"] and out["password_set"] is True
    assert _can_sign_in(db, user.id, out["temp_password"])
    # Asking twice is refused rather than silently resetting a password someone is already using.
    again = client.post(f"{API}/users/{user.id}/signin", headers=world.h("manager"), json={})
    assert again.status_code == 422 and "already sign in" in again.json()["error"]["message"]


def test_signin_needs_the_right_to_manage_that_user(client, world, db):
    other = make_user(db, world.b, RoleId.JANITOR, "Other Division", email="other@example.com")
    assert client.post(f"{API}/users/{other.id}/signin", headers=world.h("manager"), json={}).status_code == 403
    assert client.post(f"{API}/users/{other.id}/signin", headers=world.h("sup"), json={}).status_code == 403


def test_user_list_shows_signin_and_biometric_registration(client, world, db):
    from app.models import FaceEnrollment, FingerprintEnrollment, UserCredential
    from app.timeutil import utcnow

    jan = world.users["jan"]
    db.add(UserCredential(user_id=jan.id, password_hash="scrypt$x", source="admin", password_changed_at=utcnow()))
    db.add(FaceEnrollment(user_id=jan.id, division_id=world.a.id, model="m", descriptors=[[0.0]], consent_at=utcnow(),
                          consent_recorded_by_id=world.manager.id))
    db.add(FingerprintEnrollment(user_id=jan.id, division_id=world.a.id, format="f", matcher="m", fingers=[],
                                 consent_at=utcnow(), consent_recorded_by_id=world.manager.id))
    db.commit()
    items = client.get(f"{API}/users", headers=world.h("manager"), params={"page_size": 100}).json()["items"]
    row = next(u for u in items if u["id"] == str(jan.id))
    assert (row["password_set"], row["face_enrolled"], row["fingerprint_enrolled"]) == (True, True, True)
    other = next(u for u in items if u["id"] == str(world.jan2.id))
    assert (other["password_set"], other["face_enrolled"], other["fingerprint_enrolled"]) == (False, False, False)
