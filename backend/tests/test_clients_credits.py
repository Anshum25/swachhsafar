"""Clients (offices), their module subscription and the prepaid wallet.

The wallet tests are about the two things that would actually cost money if they were wrong: a journey is
charged exactly once however often the call is retried, and a balance that cannot cover a journey refuses
it rather than going negative.
"""

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app.models import Client, CreditLedger, LedgerReason
from tests.factories import auth, make_client


# ---- helpers -------------------------------------------------------------------------------------------


def _journey_body(world, **kw):
    body = dict(
        division_id=str(world.a.id),
        train_id=world.train["id"],
        journey_date=str(date.today() + timedelta(days=3)),
        supervisor_id=str(world.users["sup"].id),
        staff_ids=[],
    )
    body.update(kw)
    return body


def _create_journey(world, **kw):
    return world.client.post("/api/v1/journeys", headers=auth(world.users["manager"]), json=_journey_body(world, **kw))


def _set_rate(world, client_id, rate):
    return world.client.put(
        f"/api/v1/clients/{client_id}/credit-rate",
        headers=auth(world.users["sa"]),
        json={"credit_per_journey": rate},
    )


def _top_up(world, client_id, credits, **kw):
    return world.client.post(
        f"/api/v1/clients/{client_id}/credits",
        headers=auth(world.users["sa"]),
        json={"credits": credits, **kw},
    )


def _client_of(world, division):
    return world.db.scalar(select(Client).where(Client.id == division.client_id))


def _balance(world, client_id):
    """The committed balance. rollback() first: the test session holds its own read transaction, and on
    SQLite that snapshot would not show what the request we just made committed on another connection."""
    world.db.rollback()
    return world.db.scalar(select(Client.credit_balance).where(Client.id == client_id))


# ---- clients -------------------------------------------------------------------------------------------


def test_only_super_admin_creates_a_client(world):
    body = dict(office_id="OFF-NEW", name="New Office", enabled_modules=["inspections"], credit_per_journey=2)

    r = world.client.post("/api/v1/clients", headers=auth(world.users["admin"]), json=body)
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "permission_denied"

    r = world.client.post("/api/v1/clients", headers=auth(world.users["sa"]), json=body)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["office_id"] == "OFF-NEW"
    assert created["enabled_modules"] == ["inspections"]
    # The wallet starts empty whatever the request said: credits only arrive through a recorded top-up.
    assert created["credit_balance"] == 0
    assert created["credit_per_journey"] == 2


def test_office_id_is_unique(world):
    body = dict(office_id="OFF-DUP", name="First")
    assert world.client.post("/api/v1/clients", headers=auth(world.users["sa"]), json=body).status_code == 201
    r = world.client.post("/api/v1/clients", headers=auth(world.users["sa"]), json=dict(body, name="Second"))
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "office_id_taken"


def test_unknown_module_is_refused(world):
    r = world.client.post("/api/v1/clients", headers=auth(world.users["sa"]),
                          json=dict(office_id="OFF-BAD", name="Bad", enabled_modules=["teleport"]))
    assert r.status_code == 422


def test_a_client_admin_sees_only_their_own_client(world):
    other = make_client(world.db, "OFF-OTHER")
    rows = world.client.get("/api/v1/clients", headers=auth(world.users["admin"])).json()
    assert [c["id"] for c in rows] == [str(world.a.client_id)]

    # And cannot read another office at all -- not even to learn that it exists.
    r = world.client.get(f"/api/v1/clients/{other.id}", headers=auth(world.users["admin"]))
    assert r.status_code == 404

    assert len(world.client.get("/api/v1/clients", headers=auth(world.users["sa"])).json()) >= 2


def test_an_admin_cannot_fill_their_own_wallet(world):
    """The point of the whole arrangement: credits come from the Super Admin, not from the client."""
    r = _top_up(world, world.a.client_id, 10)
    assert r.status_code == 200

    r = world.client.post(f"/api/v1/clients/{world.a.client_id}/credits",
                          headers=auth(world.users["admin"]), json={"credits": 1000})
    assert r.status_code == 403
    r = world.client.put(f"/api/v1/clients/{world.a.client_id}/credit-rate",
                         headers=auth(world.users["admin"]), json={"credit_per_journey": 0})
    assert r.status_code == 403
    r = world.client.put(f"/api/v1/clients/{world.a.client_id}/modules",
                         headers=auth(world.users["admin"]), json={"enabled_modules": ["reports"]})
    assert r.status_code == 403


# ---- module subscription -------------------------------------------------------------------------------


def test_disabled_module_is_refused_and_disappears_from_me(world):
    """A client that only bought inspections: its users keep the inspection path and lose the rest."""
    assert world.client.put(
        f"/api/v1/clients/{world.a.client_id}/modules",
        headers=auth(world.users["sa"]),
        json={"enabled_modules": ["inspections"]},
    ).status_code == 200

    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["manager"])).json()
    assert me["client"]["modules"] == sorted(
        ["inspections", "admin", "users", "masters", "media", "journeys"]
    )
    perms = me["divisions"][str(world.a.id)]
    assert "inspections.read" in perms
    # Every permission of an unsubscribed module is gone, in /auth/me and everywhere else.
    assert not [p for p in perms if p.startswith(("attendance.", "feedback.", "complaints.", "inventory.", "reports."))]

    r = world.client.get("/api/v1/attendance", headers=auth(world.users["manager"]))
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "module_disabled"
    assert r.json()["error"]["details"]["module"] == "attendance"

    # Inspections still work, so the subscription gates the modules and nothing else.
    assert world.client.get("/api/v1/inspections",
                            headers=auth(world.users["manager"])).status_code == 200


def test_the_journey_spine_is_never_switched_off(world):
    """An office with no subscription at all still has journeys, users, master data and media: a client
    that only records inspections still records them against a journey."""
    world.client.put(f"/api/v1/clients/{world.a.client_id}/modules",
                     headers=auth(world.users["sa"]), json={"enabled_modules": []})
    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["manager"])).json()
    assert me["client"]["modules"] == sorted(["admin", "users", "masters", "media", "journeys"])
    assert world.client.get("/api/v1/journeys",
                            headers=auth(world.users["manager"])).status_code == 200


def test_super_admin_is_not_gated_by_a_subscription(world):
    """Whoever configures the subscriptions must be able to see what they are configuring."""
    world.client.put(f"/api/v1/clients/{world.a.client_id}/modules",
                     headers=auth(world.users["sa"]), json={"enabled_modules": []})
    assert world.client.get("/api/v1/attendance",
                            headers=auth(world.users["sa"])).status_code == 200
    assert world.client.get("/api/v1/auth/me", headers=auth(world.users["sa"])).json()["client"] is None


def test_the_subscription_reaches_the_phone_through_sync(world):
    world.client.put(f"/api/v1/clients/{world.a.client_id}/modules",
                     headers=auth(world.users["sa"]), json={"enabled_modules": ["inspections", "reports"]})
    changes = world.client.get("/api/v1/sync/changes", headers=auth(world.users["sup"])).json()
    assert changes["client"]["office_id"]
    assert "inspections" in changes["client"]["modules"]
    assert "attendance" not in changes["client"]["modules"]


# ---- the wallet ----------------------------------------------------------------------------------------


def test_a_free_client_is_charged_nothing(world):
    """credit_per_journey = 0, which is what every existing deployment is migrated to."""
    _set_rate(world, world.a.client_id, 0)
    assert _create_journey(world).status_code == 201
    assert world.db.scalar(select(func.count()).select_from(CreditLedger)) == 0


def test_creating_a_journey_spends_one_credit(world):
    _set_rate(world, world.a.client_id, 1)
    _top_up(world, world.a.client_id, 3, reference="UTR-123")
    assert _balance(world, world.a.client_id) == 3

    r = _create_journey(world)
    assert r.status_code == 201, r.text
    journey_id = r.json()["id"]
    assert _balance(world, world.a.client_id) == 2

    row = world.db.scalar(select(CreditLedger).where(CreditLedger.reason == LedgerReason.JOURNEY_CHARGE))
    assert (row.delta, row.balance_after, str(row.journey_id), row.is_system) == (-1, 2, journey_id, True)


def test_the_rate_is_what_the_super_admin_set(world):
    _set_rate(world, world.a.client_id, 5)
    _top_up(world, world.a.client_id, 12)
    assert _create_journey(world).status_code == 201
    assert _balance(world, world.a.client_id) == 7


def test_an_empty_wallet_refuses_the_journey_and_keeps_the_balance(world):
    _set_rate(world, world.a.client_id, 1)
    assert _balance(world, world.a.client_id) == 0

    r = _create_journey(world)
    assert r.status_code == 402, r.text
    err = r.json()["error"]
    assert err["code"] == "credits_exhausted"
    assert err["details"]["required"] == 1 and err["details"]["balance"] == 0

    # Nothing was written: not the journey, not a ledger row. (The fixture's own journey predates the
    # rate and cost nothing, so the count here is of journeys created by this test.)
    assert world.db.scalar(select(func.count()).select_from(CreditLedger)) == 0
    assert _balance(world, world.a.client_id) == 0


def test_a_balance_below_the_rate_is_not_enough(world):
    _set_rate(world, world.a.client_id, 5)
    _top_up(world, world.a.client_id, 4)
    assert _create_journey(world).status_code == 402
    assert _balance(world, world.a.client_id) == 4


def test_existing_journeys_keep_working_once_the_wallet_is_empty(world):
    """Blocking creation must not block the work already paid for: staff on a train that has departed go
    on recording, whatever the office owes."""
    _set_rate(world, world.a.client_id, 1)
    _top_up(world, world.a.client_id, 1)
    journey = _create_journey(world, journey_date=str(date.today())).json()
    assert _balance(world, world.a.client_id) == 0

    assert _create_journey(world).status_code == 402
    # Reads and captures against the existing journey are untouched.
    assert world.client.get(f"/api/v1/journeys/{journey['id']}", headers=auth(world.users["sup"])).status_code == 200
    assert world.client.get(f"/api/v1/sync/changes", headers=auth(world.users["sup"])).status_code == 200


def test_cancelling_before_departure_returns_the_credit(world):
    _set_rate(world, world.a.client_id, 2)
    _top_up(world, world.a.client_id, 10)
    journey = _create_journey(world).json()
    assert _balance(world, world.a.client_id) == 8

    r = world.client.post(f"/api/v1/journeys/{journey['id']}/cancel", headers=auth(world.users["manager"]),
                          json={"reason": "train rescheduled", "version": journey["version"]})
    assert r.status_code == 200, r.text
    assert _balance(world, world.a.client_id) == 10
    refund = world.db.scalar(select(CreditLedger).where(CreditLedger.reason == LedgerReason.JOURNEY_REFUND))
    assert refund.delta == 2 and "train rescheduled" in refund.note


def test_cancelling_a_departed_journey_returns_nothing(world):
    """The train has gone; the client has had the service."""
    _set_rate(world, world.a.client_id, 2)
    _top_up(world, world.a.client_id, 10)
    journey = _create_journey(world, journey_date=str(date.today())).json()
    assert _balance(world, world.a.client_id) == 8

    r = world.client.post(f"/api/v1/journeys/{journey['id']}/cancel", headers=auth(world.users["manager"]),
                          json={"reason": "cancelled after departure", "version": journey["version"]})
    assert r.status_code == 200, r.text
    assert _balance(world, world.a.client_id) == 8
    assert world.db.scalar(select(func.count()).select_from(CreditLedger).where(
        CreditLedger.reason == LedgerReason.JOURNEY_REFUND)) == 0


def test_a_journey_is_charged_once_and_refunded_once(world):
    """Idempotency, enforced by uq_credit_ledger_journey_reason rather than by the caller behaving."""
    from app.services.clients import charge_journey, refund_journey
    from app.errors import Conflict

    _set_rate(world, world.a.client_id, 1)
    _top_up(world, world.a.client_id, 5)
    journey = _create_journey(world).json()
    jid = uuid.UUID(journey["id"])
    assert _balance(world, world.a.client_id) == 4

    # A second charge for the same journey cannot be written.
    with pytest.raises(Conflict):
        charge_journey(world.db, world.a.id, jid)
    world.db.rollback()
    assert _balance(world, world.a.client_id) == 4

    assert refund_journey(world.db, world.a.id, jid, note="first") == 1
    world.db.commit()
    assert _balance(world, world.a.client_id) == 5
    # A second refund returns nothing rather than paying twice.
    assert refund_journey(world.db, world.a.id, jid, note="second") == 0
    world.db.commit()
    assert _balance(world, world.a.client_id) == 5


def test_a_suspended_client_cannot_create_journeys(world):
    _set_rate(world, world.a.client_id, 1)
    _top_up(world, world.a.client_id, 50)
    assert world.client.patch(f"/api/v1/clients/{world.a.client_id}", headers=auth(world.users["sa"]),
                              json={"status": "suspended"}).status_code == 200

    r = _create_journey(world)
    assert r.status_code == 402
    assert r.json()["error"]["code"] == "client_suspended"
    assert _balance(world, world.a.client_id) == 50


def test_two_offices_have_separate_wallets(world):
    """Division B belongs to its own client, so spending A's credits leaves B's alone."""
    _set_rate(world, world.a.client_id, 1)
    _top_up(world, world.a.client_id, 2)
    _set_rate(world, world.b.client_id, 1)
    _top_up(world, world.b.client_id, 7)

    assert _create_journey(world).status_code == 201
    assert _balance(world, world.a.client_id) == 1
    assert _balance(world, world.b.client_id) == 7


def test_an_adjustment_cannot_go_below_zero(world):
    _top_up(world, world.a.client_id, 3)
    r = world.client.post(f"/api/v1/clients/{world.a.client_id}/credits/adjust",
                          headers=auth(world.users["sa"]), json={"delta": -4, "note": "write-off"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "insufficient_credits"
    assert _balance(world, world.a.client_id) == 3

    assert world.client.post(f"/api/v1/clients/{world.a.client_id}/credits/adjust",
                             headers=auth(world.users["sa"]),
                             json={"delta": -3, "note": "write-off"}).status_code == 200
    assert _balance(world, world.a.client_id) == 0


def test_the_ledger_explains_the_balance(world):
    """Every movement is recorded, and the sum of the ledger is the balance. If these ever disagree, one
    of them is lying about money."""
    _set_rate(world, world.a.client_id, 2)
    _top_up(world, world.a.client_id, 10, reference="UTR-1")
    journey = _create_journey(world).json()
    world.client.post(f"/api/v1/journeys/{journey['id']}/cancel", headers=auth(world.users["manager"]),
                      json={"reason": "not running", "version": journey["version"]})
    _top_up(world, world.a.client_id, 5, reference="UTR-2")

    page = world.client.get(f"/api/v1/clients/{world.a.client_id}/ledger",
                            headers=auth(world.users["sa"])).json()
    assert [r["reason"] for r in page["items"]] == ["top_up", "journey_refund", "journey_charge", "top_up"]
    assert page["items"][0]["reference"] == "UTR-2"
    total = world.db.scalar(select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(
        CreditLedger.client_id == world.a.client_id))
    assert total == _balance(world, world.a.client_id) == 15


def test_the_ledger_cannot_be_rewritten(world):
    """Append-only, so a balance can never be quietly corrected without a visible row."""
    _top_up(world, world.a.client_id, 4)
    row = world.db.scalar(select(CreditLedger))
    row.delta = 4000
    with pytest.raises(Exception):
        world.db.commit()
    world.db.rollback()


def test_a_client_administrator_can_see_the_balance_and_the_warning(world):
    """They cannot fill the wallet, but they must be able to see that it needs filling."""
    _set_rate(world, world.a.client_id, 1)
    _top_up(world, world.a.client_id, 2)
    world.client.patch(f"/api/v1/clients/{world.a.client_id}", headers=auth(world.users["sa"]),
                       json={"low_credit_threshold": 5})

    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["admin"])).json()
    assert me["client"]["credit_balance"] == 2
    assert me["client"]["low_credit"] is True

    _top_up(world, world.a.client_id, 100)
    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["admin"])).json()
    assert me["client"]["low_credit"] is False


def test_a_janitor_sees_only_their_own_modules(world):
    """What the role grants, capped by what the office bought. A janitor marks attendance and nothing else
    even when the office is subscribed to everything."""
    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["jan"])).json()
    perms = set(me["divisions"][str(world.a.id)])
    assert {"attendance.submit", "journeys.read"} <= perms
    assert not perms & {"inspections.submit", "complaints.create", "inventory.transact", "reports.read",
                        "users.manage", "clients.read"}

    # And once the office drops attendance, the janitor has nothing left to submit.
    world.client.put(f"/api/v1/clients/{world.a.client_id}/modules",
                     headers=auth(world.users["sa"]), json={"enabled_modules": ["inspections"]})
    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["jan"])).json()
    assert "attendance.submit" not in me["divisions"][str(world.a.id)]


# ---- client filter -------------------------------------------------------------------------------------


def _ids(r):
    assert r.status_code == 200, r.text
    body = r.json()
    return {row["id"] for row in (body["items"] if isinstance(body, dict) else body)}


def test_super_admin_lists_one_client_at_a_time(world):
    """`?client_id=` narrows every list to that office's divisions: B's office has no journeys and only B's
    people, A's office has the journey."""
    h = auth(world.users["sa"])
    a_client, b_client = world.a.client_id, world.b.client_id

    assert _ids(world.client.get(f"/api/v1/divisions?client_id={b_client}", headers=h)) == {str(world.b.id)}
    assert _ids(world.client.get(f"/api/v1/journeys?client_id={b_client}", headers=h)) == set()
    assert world.journey["id"] in _ids(world.client.get(f"/api/v1/journeys?client_id={a_client}", headers=h))

    b_users = _ids(world.client.get(f"/api/v1/users?client_id={b_client}&page_size=100", headers=h))
    assert b_users == {str(world.users[n].id) for n in ("manager_b", "sup_b", "jan_b")}

    # Without the filter a Super Admin still sees every office.
    assert _ids(world.client.get("/api/v1/divisions", headers=h)) >= {str(world.a.id), str(world.b.id)}


def test_a_division_outside_the_chosen_client_is_refused(world):
    r = world.client.get(f"/api/v1/users?client_id={world.b.client_id}&division_id={world.a.id}",
                         headers=auth(world.users["sa"]))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "division_forbidden"


def test_the_client_filter_never_widens_what_a_user_sees(world):
    """A filter, not a grant: naming another office leaves a division manager with nothing, not with it."""
    h = auth(world.users["manager"])
    assert _ids(world.client.get(f"/api/v1/divisions?client_id={world.b.client_id}", headers=h)) == set()
    assert world.client.get(f"/api/v1/journeys?client_id={world.b.client_id}", headers=h).status_code == 403
    # Their own office is unchanged by naming it.
    assert world.journey["id"] in _ids(world.client.get(f"/api/v1/journeys?client_id={world.a.client_id}", headers=h))


def test_a_malformed_client_id_is_a_bad_request(world):
    r = world.client.get("/api/v1/journeys?client_id=not-a-uuid", headers=auth(world.users["sa"]))
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_client_id"


def test_me_gives_a_super_admin_every_division(world):
    """The web app only opens divisions /auth/me lists, so a Super Admin must get all of them -- otherwise
    choosing another office's division springs back to their own."""
    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["sa"])).json()
    assert {str(world.a.id), str(world.b.id)} <= set(me["divisions"])
    # Everyone else still gets only their own.
    me = world.client.get("/api/v1/auth/me", headers=auth(world.users["manager"])).json()
    assert set(me["divisions"]) == {str(world.a.id)}
