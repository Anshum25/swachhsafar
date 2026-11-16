import uuid
from datetime import timedelta

from sqlalchemy import select

from app.models import EmployeeKyc, RoleId, User, UserStatus
from app.timeutil import today_ist
from tests.factories import make_user

API = "/api/v1"


def test_missing_and_invalid_token(client, world):
    assert client.get(f"{API}/auth/me").status_code == 401
    r = client.get(f"{API}/auth/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_token"


def test_unprovisioned_and_inactive(client, world, db):
    r = client.get(f"{API}/auth/me", headers={"Authorization": "Bearer tok-stranger"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_provisioned"
    inactive = make_user(db, world.a, RoleId.JANITOR, "idle", status=UserStatus.INACTIVE)
    r = client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer tok-{inactive.firebase_uid}"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "account_inactive"


def test_links_by_verified_email_only(client, world, db, fakes):
    verifier = fakes[0]
    user = make_user(db, world.a, RoleId.JANITOR, "newbie", firebase_uid=None, email="newbie@rail.in")
    verifier.claims["fresh-uid"] = {"uid": "fresh-uid", "email": "NEWBIE@rail.in", "email_verified": False}
    assert client.get(f"{API}/auth/me", headers={"Authorization": "Bearer tok-fresh-uid"}).status_code == 403
    verifier.claims["fresh-uid"]["email_verified"] = True
    r = client.get(f"{API}/auth/me", headers={"Authorization": "Bearer tok-fresh-uid"})
    assert r.status_code == 200 and r.json()["user"]["id"] == str(user.id)
    db.refresh(user)
    assert user.firebase_uid == "fresh-uid"


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


def test_cli_link_user_links_login_and_restricts_role(world, db):
    """Unverified Firebase e-mail: the admin links it explicitly; role can be lowered; Super Admin untouched."""
    from app.cli import link_user
    from app.models import RoleId

    sup, other = world.sup, world.users["jan"]
    sup.firebase_uid, sup.email = None, "sup.link@example.com"
    other.email = "jan.link@example.com"
    db.commit()
    assert link_user(db, email=sup.email.upper(), firebase_uid="uid-new-login", role="janitor") == 0
    db.refresh(sup)
    assert (sup.firebase_uid, sup.role_id) == ("uid-new-login", RoleId.JANITOR)
    # Re-running is a no-op; a different login or a login already used elsewhere is refused.
    assert link_user(db, email=sup.email, firebase_uid="uid-new-login", role="janitor") == 0
    assert link_user(db, email=sup.email, firebase_uid="uid-other", role=None) == 2
    assert link_user(db, email=other.email, firebase_uid="uid-new-login", role=None) == 2
    assert link_user(db, email="nobody@example.com", firebase_uid="x", role=None) == 2


# ---- sign-in comes with the employee ------------------------------------------------------------------
# An administrator creating a user in the app is all it takes. Before this, a created employee had no login
# at all: they appeared "Not linked" and only found out at the sign-in screen, and an administrator had to
# run a server command or have the person register and verify an e-mail.


def test_creating_a_user_with_an_email_creates_their_signin(client, world, db, fakes):
    provisioner = fakes[3]
    body = dict(emp_id="S1", name="Sign In", email="Sign.In@Example.com", role_id=5, division_id=str(world.a.id))
    r = client.post(f"{API}/users", headers=world.h("manager"), json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["firebase_linked"] is True and out["signin"] == "created"
    # The generated password is returned once, and is the one actually set on the identity store.
    assert out["temp_password"] and provisioner.created["sign.in@example.com"] == out["temp_password"]
    user = db.get(User, uuid.UUID(out["id"]))
    db.refresh(user)
    assert user.firebase_uid == "uid-sign.in@example.com"


def test_administrator_may_choose_the_password_and_it_is_never_echoed(client, world, fakes):
    body = dict(emp_id="S2", name="Chosen", email="chosen@example.com", role_id=5,
                division_id=str(world.a.id), password="Platform-9-and-3quarters")
    out = client.post(f"{API}/users", headers=world.h("manager"), json=body).json()
    assert out["signin"] == "created" and out["temp_password"] is None
    assert fakes[3].created["chosen@example.com"] == "Platform-9-and-3quarters"


def test_an_employee_without_an_email_gets_no_signin(client, world):
    out = client.post(f"{API}/users", headers=world.h("manager"),
                      json=dict(emp_id="S3", name="No Mail", role_id=5, division_id=str(world.a.id))).json()
    assert out["firebase_linked"] is False and out["signin"] is None and out["temp_password"] is None


def test_an_account_that_already_exists_is_adopted_with_its_own_password(client, world, fakes):
    """Somebody registered themselves first. Their account is linked, their password left alone, and no
    password is reported -- handing the administrator one that does not work would be worse than none."""
    fakes[3].existing["known@example.com"] = "uid-already-there"
    out = client.post(f"{API}/users", headers=world.h("manager"),
                      json=dict(emp_id="S4", name="Known", email="known@example.com", role_id=5,
                                division_id=str(world.a.id))).json()
    assert out["signin"] == "existing" and out["temp_password"] is None
    assert out["firebase_linked"] is True
    assert "known@example.com" not in fakes[3].created


def test_signin_for_an_employee_who_has_none(client, world, db, fakes):
    """The repair path for employees created before sign-ins came with the record."""
    user = make_user(db, world.a, RoleId.JANITOR, "Later Mail", email="later@example.com", firebase_uid=None)
    assert user.firebase_uid is None
    out = client.post(f"{API}/users/{user.id}/signin", headers=world.h("manager"), json={}).json()
    assert out["signin"] == "created" and out["temp_password"]
    assert fakes[3].created["later@example.com"] == out["temp_password"]
    # Asking twice is refused rather than silently resetting a password someone is already using.
    again = client.post(f"{API}/users/{user.id}/signin", headers=world.h("manager"), json={})
    assert again.status_code == 422 and "already sign in" in again.json()["error"]["message"]


def test_signin_needs_an_email_and_the_right_to_manage_that_user(client, world, db):
    no_mail = make_user(db, world.a, RoleId.JANITOR, "Mailless", firebase_uid=None)
    r = client.post(f"{API}/users/{no_mail.id}/signin", headers=world.h("manager"), json={})
    assert r.status_code == 422 and "e-mail" in r.json()["error"]["message"]
    other = make_user(db, world.b, RoleId.JANITOR, "Other Division", email="other@example.com", firebase_uid=None)
    assert client.post(f"{API}/users/{other.id}/signin", headers=world.h("manager"), json={}).status_code == 403
    assert client.post(f"{API}/users/{other.id}/signin", headers=world.h("sup"), json={}).status_code == 403


def test_nothing_is_saved_when_the_identity_store_fails(client, world, db, fakes):
    """A half-created employee -- a record with no possible sign-in -- is exactly what this feature exists
    to prevent, so the whole request fails and the administrator can simply try again."""
    fakes[3].fails = True
    r = client.post(f"{API}/users", headers=world.h("manager"),
                    json=dict(emp_id="S5", name="Doomed", email="doomed@example.com", role_id=5,
                              division_id=str(world.a.id)))
    assert r.status_code == 503 and r.json()["error"]["code"] == "signin_unavailable"
    assert db.scalar(select(User).where(User.emp_id == "S5")) is None
