"""Role rights per office (migration 0014): a right is decided by the division's override, else its office's,
else the global grant. Divisions A and B of the test world belong to two different offices."""

from tests.factories import make_division

API = "/api/v1"
JANITOR = 5
MANAGER = 3


def _grant(world, who, **body):
    body = {k: str(v) if k.endswith("_id") and k != "role_id" else v for k, v in body.items()}
    return world.client.put(f"{API}/permissions/grants", headers=world.h(who), json=body)


def _perms(world, who, division):
    return set(world.client.get(f"{API}/auth/me", headers=world.h(who)).json()["divisions"][str(division.id)])


def test_an_office_override_changes_that_office_only(world):
    assert "attendance.submit" in _perms(world, "jan", world.a)

    r = _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
               effect="deny")
    assert r.status_code == 200, r.text
    assert r.json()["client_id"] == str(world.a.client_id) and r.json()["division_id"] is None

    assert "attendance.submit" not in _perms(world, "jan", world.a)
    # The other office keeps the global grant.
    assert "attendance.submit" in _perms(world, "jan_b", world.b)


def test_the_office_override_reaches_every_division_of_the_office(world):
    from app.models import Client
    from app.security.principal import role_grants

    second = make_division(world.db, "AA2", client=world.db.get(Client, world.a.client_id))
    _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
           effect="deny")
    world.db.rollback()  # see what the request committed
    assert "attendance.submit" not in role_grants(world.db, JANITOR, second.id)
    assert "attendance.submit" in role_grants(world.db, JANITOR, world.b.id)


def test_a_division_override_beats_the_office_one(world):
    _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
           effect="deny")
    r = _grant(world, "admin", role_id=JANITOR, permission_code="attendance.submit", division_id=world.a.id,
               effect="allow")
    assert r.status_code == 200, r.text
    assert "attendance.submit" in _perms(world, "jan", world.a)


def test_an_office_can_grant_what_the_global_default_does_not(world):
    assert "reports.read" not in _perms(world, "jan", world.a)
    _grant(world, "sa", role_id=JANITOR, permission_code="reports.read", client_id=world.a.client_id, effect="allow")
    assert "reports.read" in _perms(world, "jan", world.a)
    assert "reports.read" not in _perms(world, "jan_b", world.b)


def test_an_office_admin_sets_their_own_office_only(world):
    body = dict(role_id=JANITOR, permission_code="attendance.submit", effect="deny")
    assert _grant(world, "admin", client_id=world.a.client_id, **body).status_code == 200
    r = _grant(world, "admin", client_id=world.b.client_id, **body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "permission_denied"


def test_a_manager_cannot_change_rights_office_wide(world):
    """Even holding permissions.manage in their division: an office row also changes divisions they do not run."""
    assert _grant(world, "sa", role_id=MANAGER, permission_code="permissions.manage", division_id=world.a.id,
                  effect="allow").status_code == 200
    body = dict(role_id=JANITOR, permission_code="attendance.submit", effect="deny")
    assert _grant(world, "manager", division_id=world.a.id, **body).status_code == 200
    assert _grant(world, "manager", client_id=world.a.client_id, **body).status_code == 403


def test_a_grant_has_one_scope(world):
    r = _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
               division_id=world.a.id, effect="deny")
    assert r.status_code == 422


def test_listing_keeps_the_scopes_apart(world):
    _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
           effect="deny")
    h = world.h("sa")
    office = world.client.get(f"{API}/permissions/grants?client_id={world.a.client_id}", headers=h).json()
    assert [(g["role_id"], g["permission_code"], g["effect"]) for g in office] == [(JANITOR, "attendance.submit", "deny")]
    # The global list is still only global rows: an office override is not a new default.
    globals_ = world.client.get(f"{API}/permissions/grants", headers=h).json()
    assert all(g["client_id"] is None and g["division_id"] is None for g in globals_)
    # Another office cannot read it.
    r = world.client.get(f"{API}/permissions/grants?client_id={world.a.client_id}", headers=world.h("manager_b"))
    assert r.status_code == 403


def test_removing_the_office_override_restores_the_default(world):
    row = _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
                 effect="deny").json()
    assert world.client.delete(f"{API}/permissions/grants/{row['id']}", headers=world.h("admin")).status_code == 204
    assert "attendance.submit" in _perms(world, "jan", world.a)


def test_the_same_right_can_be_set_for_the_office_and_globally(world):
    """The uniqueness index includes client_id: an office row does not collide with the global one."""
    body = dict(role_id=JANITOR, permission_code="attendance.submit", effect="allow")
    assert _grant(world, "sa", **body).status_code == 200
    assert _grant(world, "sa", client_id=world.a.client_id, **body).status_code == 200
    assert _grant(world, "sa", client_id=world.a.client_id, **body).status_code == 200  # upsert, not a duplicate
    office = world.client.get(f"{API}/permissions/grants?client_id={world.a.client_id}", headers=world.h("sa")).json()
    assert len(office) == 1


# ---- headquarters and stations (migration 0015) ----------------------------------------------------------


def _office_a_with_hq(world):
    """Office A: division A (a station, the default) plus a headquarters."""
    from app.models import Client

    hq = make_division(world.db, "AHQ", client=world.db.get(Client, world.a.client_id))
    r = world.client.patch(f"{API}/divisions/{hq.id}", headers=world.h("sa"), json={"kind": "headquarters"})
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "headquarters"
    return hq


def _role_grants(world, division):
    from app.security.principal import role_grants

    world.db.rollback()  # see what the requests committed
    return role_grants(world.db, JANITOR, division.id)


def test_a_new_division_is_a_station(world):
    rows = world.client.get(f"{API}/divisions", headers=world.h("sa")).json()
    assert {d["kind"] for d in rows} == {"station"}


def test_a_station_rule_covers_the_office_stations_only(world):
    hq = _office_a_with_hq(world)
    r = _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id,
               division_kind="station", effect="deny")
    assert r.status_code == 200, r.text
    assert r.json()["division_kind"] == "station"

    assert "attendance.submit" not in _role_grants(world, world.a)  # a station of office A
    assert "attendance.submit" in _role_grants(world, hq)            # its headquarters
    assert "attendance.submit" in _role_grants(world, world.b)       # a station of another office


def test_the_order_is_division_then_kind_then_office(world):
    hq = _office_a_with_hq(world)
    body = dict(role_id=JANITOR, permission_code="reports.read")
    _grant(world, "sa", client_id=world.a.client_id, effect="allow", **body)                            # office
    _grant(world, "sa", client_id=world.a.client_id, division_kind="station", effect="deny", **body)    # stations
    assert "reports.read" in _role_grants(world, hq)            # office rule, no headquarters rule
    assert "reports.read" not in _role_grants(world, world.a)   # the station rule beats the office's
    _grant(world, "sa", division_id=world.a.id, effect="allow", **body)                                # one division
    assert "reports.read" in _role_grants(world, world.a)       # the division beats its kind


def test_a_kind_needs_an_office(world):
    r = _grant(world, "sa", role_id=JANITOR, permission_code="attendance.submit", division_kind="station",
               effect="deny")
    assert r.status_code == 422


def test_an_office_admin_sets_station_rules_for_their_office_only(world):
    body = dict(role_id=JANITOR, permission_code="attendance.submit", division_kind="station", effect="deny")
    assert _grant(world, "admin", client_id=world.a.client_id, **body).status_code == 200
    assert _grant(world, "admin", client_id=world.b.client_id, **body).status_code == 403
    assert _grant(world, "manager", client_id=world.a.client_id, **body).status_code == 403


def test_the_office_list_includes_its_station_and_headquarters_rows(world):
    body = dict(role_id=JANITOR, permission_code="attendance.submit", client_id=world.a.client_id, effect="deny")
    _grant(world, "sa", **body)
    _grant(world, "sa", division_kind="station", **body)
    _grant(world, "sa", division_kind="headquarters", **body)
    rows = world.client.get(f"{API}/permissions/grants?client_id={world.a.client_id}", headers=world.h("sa")).json()
    assert sorted(str(r["division_kind"]) for r in rows) == ["None", "headquarters", "station"]
