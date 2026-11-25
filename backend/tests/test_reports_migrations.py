import uuid

from sqlalchemy import create_engine, inspect, select, update

from app.models import Question
from app.timeutil import today_ist
from tests.conftest import run_migrations
from tests.factories import now_iso, upload
from tests.test_feedback import ratings, verified_feedback

API = "/api/v1"


def _punch(world, employee, stage):
    return world.client.post(f"{API}/attendance", headers=world.h("sup"), json=dict(
        id=str(uuid.uuid4()), journey_id=world.journey["id"], employee_id=str(world.users[employee].id), stage=stage,
        device_timestamp=now_iso(), latitude=23.1, longitude=79.9,
        photo_media_id=upload(world.client, world.sup, world.a.id, "attendance_photo")))


def _complete(world, fakes, pnr, mobile, values):
    fb = verified_feedback(world, fakes, pnr=pnr, mobile=mobile)
    body = {"ratings": [{**r, "value": v} for r, v in zip(ratings(world), values)]}
    assert world.client.post(f"{API}/feedback/passenger/{fb['id']}/complete", headers=world.h("sup"), json=body).status_code == 200


def test_attendance_report_and_summary(world):
    for stage in range(1, 6):
        assert _punch(world, "jan", stage).status_code == 201
    _punch(world, "sup", 1)
    today = str(today_ist())
    rows = world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today},
                            headers=world.h("manager")).json()
    by_label = {r["label"]: r for r in rows}
    assert by_label["Jan (AAA-jan)"]["records"] == 5 and by_label["Jan (AAA-jan)"]["stages"] == {str(s): 1 for s in range(1, 6)}
    assert by_label["Sup (AAA-sup)"]["records"] == 1
    journey_rows = world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today, "group_by": "journey"},
                                    headers=world.h("manager")).json()
    assert len(journey_rows) == 1 and journey_rows[0]["records"] == 6
    summary = world.client.get(f"{API}/journeys/{world.journey['id']}/summary", headers=world.h("manager")).json()
    assert (summary["staff_allocated"], summary["attendance_records"], summary["staff_fully_attended"]) == (2, 6, 1)
    assert world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today},
                            headers=world.h("jan")).status_code == 403
    assert world.client.get(f"{API}/reports/attendance", params={"date_from": today, "date_to": today, "division_id": str(world.a.id)},
                            headers=world.h("manager_b")).status_code == 403


def test_inspection_completion_report(world):
    for phase in ("B", "A"):
        world.client.post(f"{API}/inspections", headers=world.h("sup"), json=dict(
            id=str(uuid.uuid4()), journey_id=world.journey["id"], coach_code="B1", day=1, round=1, phase=phase,
            device_timestamp=now_iso(), latitude=1, longitude=1,
            photo_media_id=upload(world.client, world.sup, world.a.id, "inspection_photo")))
    today = str(today_ist())
    params = {"date_from": today, "date_to": today}
    [journey_row] = world.client.get(f"{API}/reports/inspections", params=params, headers=world.h("manager")).json()
    assert (journey_row["required"], journey_row["done"], journey_row["completion_pct"]) == (16, 2, 12.5)
    coach_rows = world.client.get(f"{API}/reports/inspections", params={**params, "coach_wise": True}, headers=world.h("manager")).json()
    assert {r["coach_code"]: r["done"] for r in coach_rows} == {"B1": 2, "S1": 0}


def test_feedback_report_and_psi(world, fakes, db):
    _complete(world, fakes, "1111111111", "9111111111", [5, 3])
    _complete(world, fakes, "2222222222", "9222222222", [3, 1])
    today = str(today_ist())
    params = {"date_from": today, "date_to": today}
    rep = world.client.get(f"{API}/reports/feedback/passenger", params=params, headers=world.h("manager")).json()
    assert rep["total"] == 2 and rep["by_status"] == {"completed": 2} and (rep["scale_min"], rep["scale_max"]) == (1, 5)
    assert [q["average"] for q in rep["questions"]] == [4.0, 2.0, None]

    r = world.client.get(f"{API}/reports/psi", params=params, headers=world.h("manager"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "psi_not_configured"
    db.execute(update(Question).where(Question.bank_id == uuid.UUID(world.passenger_bank["id"])).values(psi_weight=1))
    db.commit()
    [row] = world.client.get(f"{API}/reports/psi", params=params, headers=world.h("manager")).json()
    # (4-1)/4 = 0.75 and (2-1)/4 = 0.25 with equal weights; question 3 has no responses -> excluded
    assert row["responses"] == 2 and row["psi"] == 50.0


def test_dashboard_and_complaint_report(world):
    dash = world.client.get(f"{API}/dashboard/divisions/{world.a.id}", headers=world.h("manager")).json()
    assert dash["journeys_active"] == 1 and dash["complaints_open"] == 0
    assert world.client.get(f"{API}/dashboard/divisions/{world.a.id}", headers=world.h("sup")).status_code == 403
    _punch(world, "jan", 1)
    points = world.client.get(f"{API}/dashboard/divisions/{world.a.id}/map", params={"kind": "attendance"}, headers=world.h("manager")).json()
    assert len(points) == 1 and points[0]["stage"] == 1
    today = str(today_ist())
    rep = world.client.get(f"{API}/reports/complaints", params={"date_from": today, "date_to": today}, headers=world.h("manager")).json()
    assert rep == {"total": 0, "by_status": {}, "overdue": 0, "by_category": [], "avg_resolution_hours": None}


def test_create_journey_failure_rolls_back(world, db):
    from app.models import Journey, StaffAllocation

    before = (db.scalar(select(Journey.id).limit(1)), len(db.scalars(select(StaffAllocation)).all()))
    r = world.client.post(f"{API}/journeys", headers=world.h("manager"), json=dict(
        division_id=str(world.a.id), train_id=world.train["id"], journey_date=str(today_ist()),
        supervisor_id=str(world.sup.id), staff_ids=[str(world.jan2.id), str(world.manager.id)]))
    assert r.status_code == 422
    assert len(db.scalars(select(StaffAllocation)).all()) == before[1]


def test_migrations_downgrade_and_upgrade(pg):
    server, url_for = pg
    server.psql("DROP DATABASE IF EXISTS swachh_migrate WITH (FORCE);")
    server.psql("CREATE DATABASE swachh_migrate;")
    url = url_for("swachh_migrate")
    run_migrations(url)
    engine = create_engine(url)
    assert "inspections" in inspect(engine).get_table_names()
    run_migrations(url, "base", "downgrade")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
    run_migrations(url)
    with engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT count(*) FROM roles").scalar() == 6
    engine.dispose()


def test_0011_grants_a_database_created_before_the_client_permissions(pg):
    """Production was migrated before clients.* and credits.manage existed, so 0011 has to insert their
    grants itself. A fresh test database already has them from 0002's catalog snapshot and skips that
    branch, which is how a bulk_insert that could not run on PostgreSQL got as far as the server."""
    server, url_for = pg
    server.psql("DROP DATABASE IF EXISTS swachh_pre0011 WITH (FORCE);")
    server.psql("CREATE DATABASE swachh_pre0011;")
    url = url_for("swachh_pre0011")
    run_migrations(url, "0010")
    engine = create_engine(url)
    new_codes = "('clients.read', 'clients.manage', 'credits.manage')"
    with engine.begin() as conn:
        conn.exec_driver_sql(f"DELETE FROM role_permissions WHERE permission_code IN {new_codes}")
        conn.exec_driver_sql(f"DELETE FROM permissions WHERE code IN {new_codes}")

    run_migrations(url)

    with engine.connect() as conn:
        grants = set(conn.exec_driver_sql(
            "SELECT role_id, permission_code FROM role_permissions "
            f"WHERE division_id IS NULL AND permission_code IN {new_codes} AND created_at IS NOT NULL").all())
    assert grants == {(1, "clients.read"), (1, "clients.manage"), (1, "credits.manage"), (2, "clients.read")}
    engine.dispose()


def test_0018_moves_general_coaches_to_their_own_class(pg):
    """General coaches saved as NON_AC become GEN, coaches typed with the wrong class get the one their code
    says, and every question keeps asking General coaches what it asked them as Non-AC coaches."""
    server, url_for = pg
    server.psql("DROP DATABASE IF EXISTS swachh_pre0018 WITH (FORCE);")
    server.psql("CREATE DATABASE swachh_pre0018;")
    url = url_for("swachh_pre0018")
    run_migrations(url, "0017")
    engine = create_engine(url)
    bank, train = uuid.uuid4(), uuid.uuid4()
    with engine.begin() as conn:
        conn.exec_driver_sql("SET session_replication_role = replica")  # coach rows without their train
        conn.exec_driver_sql(
            "INSERT INTO question_banks (id, division_id, audience, name, scale_min, scale_max, is_active) "
            f"VALUES ('{bank}', NULL, 'passenger', 'P', 1, 5, false)")
        for pos, ac, non_ac in ((1, True, True), (2, True, False)):
            conn.exec_driver_sql(
                "INSERT INTO questions (id, bank_id, position, text_en, applies_ac, applies_non_ac, required) "
                f"VALUES ('{uuid.uuid4()}', '{bank}', {pos}, 'Q{pos}', {ac}, {non_ac}, true)")
        for pos, (code, cls) in enumerate((("B1", "AC"), ("S1", "NON_AC"), ("GEN", "NON_AC"), ("GEN2", "NON_AC"),
                                           ("UR1", "NON_AC"), ("B2", "NON_AC"), ("S2", "AC"), ("BHJ", "AC"),
                                           ("PC", "NON_AC")), 1):
            conn.exec_driver_sql(
                "INSERT INTO train_coaches (id, train_id, code, classification, position) "
                f"VALUES ('{uuid.uuid4()}', '{train}', '{code}', '{cls}', {pos})")

    run_migrations(url)

    with engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT position, applies_gen FROM questions ORDER BY position").all() == [
            (1, True), (2, False)]
        assert dict(conn.exec_driver_sql("SELECT code, classification FROM train_coaches").all()) == {
            "B1": "AC", "S1": "NON_AC", "GEN": "GEN", "GEN2": "GEN", "UR1": "GEN", "B2": "AC", "S2": "NON_AC",
            "BHJ": "AC", "PC": "NON_AC"}
    run_migrations(url, "0017", "downgrade")
    with engine.connect() as conn:
        assert {c for (c,) in conn.exec_driver_sql("SELECT DISTINCT classification FROM train_coaches")} == {"AC", "NON_AC"}
    engine.dispose()


def test_0020_gives_saved_coaches_the_class_their_code_now_says(pg):
    server, url_for = pg
    server.psql("DROP DATABASE IF EXISTS swachh_pre0020 WITH (FORCE);")
    server.psql("CREATE DATABASE swachh_pre0020;")
    url = url_for("swachh_pre0020")
    run_migrations(url, "0019")
    engine = create_engine(url)
    train = uuid.uuid4()
    with engine.begin() as conn:
        conn.exec_driver_sql("SET session_replication_role = replica")  # coach rows without their train
        for pos, (code, cls) in enumerate((("J1", "NON_AC"), ("G1", "NON_AC"), ("HB1", "NON_AC"), ("SLRD", "NON_AC"),
                                           ("DV1", "AC"), ("BHJ", "AC"), ("B1", "AC")), 1):
            conn.exec_driver_sql(
                "INSERT INTO train_coaches (id, train_id, code, classification, position) "
                f"VALUES ('{uuid.uuid4()}', '{train}', '{code}', '{cls}', {pos})")
    run_migrations(url)
    with engine.connect() as conn:
        assert dict(conn.exec_driver_sql("SELECT code, classification FROM train_coaches").all()) == {
            "J1": "AC", "G1": "AC", "HB1": "AC", "SLRD": "GEN", "DV1": "NON_AC", "BHJ": "AC", "B1": "AC"}
    engine.dispose()
