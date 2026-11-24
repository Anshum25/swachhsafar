"""Deleting a user and moving one to another station or office (Users -> ... -> Delete user / Move)."""

API = "/api/v1"


def test_a_deleted_user_disappears_and_is_signed_out(world):
    jan = world.users["jan"]
    h_jan = world.h("jan")  # signed in before the delete
    r = world.client.post(f"{API}/users/{jan.id}/status", headers=world.h("sa"), json={"status": "deleted"})
    assert r.status_code == 200, r.text
    ids = {u["id"] for u in world.client.get(f"{API}/users", params={"page_size": 100}, headers=world.h("sa")).json()["items"]}
    assert str(jan.id) not in ids
    assert world.client.get(f"{API}/users/{jan.id}", headers=world.h("sa")).status_code == 404
    assert world.client.get(f"{API}/auth/me", headers=h_jan).status_code in (401, 403)


def test_the_super_admin_moves_a_user_to_another_office(world):
    jan = world.users["jan"]
    r = world.client.patch(f"{API}/users/{jan.id}", headers=world.h("sa"), json={"division_id": str(world.b.id)})
    assert r.status_code == 200, r.text
    assert r.json()["division_id"] == str(world.b.id)


def test_an_office_admin_cannot_move_a_user_out_of_their_office(world):
    jan = world.users["jan"]
    r = world.client.patch(f"{API}/users/{jan.id}", headers=world.h("admin"), json={"division_id": str(world.b.id)})
    assert r.status_code == 403
