"""Passwords in PostgreSQL: our scrypt hashes, hashes imported from Firebase Authentication, and the move."""

import base64
import hashlib

from sqlalchemy import text

from app.models import UserCredential
from app.security import passwords
from tests.test_security import DEVICE, cap

# The reference vector published with Firebase's own scrypt implementation (github.com/firebase/scrypt).
FB_CONFIG = {"algorithm": "SCRYPT", "rounds": 8, "memoryCost": 14, "saltSeparator": "Bw==",
             "signerKey": "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA=="}
FB_SALT = "42xEC+ixf3L2lw=="
FB_HASH = "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ=="
FB_PASSWORD = "user1password"


def _fb_stored(hash_=FB_HASH, salt=FB_SALT):
    return passwords.firebase_hash(password_hash=hash_, salt=salt, salt_separator=FB_CONFIG["saltSeparator"],
                                   signer_key=FB_CONFIG["signerKey"], rounds=8, mem_cost=14)


def test_native_hash_round_trip_and_unique_salts():
    a, b = passwords.hash_password("Secret-123"), passwords.hash_password("Secret-123")
    assert a != b and a.startswith("scrypt$ln=15,r=8,p=1$")
    assert passwords.verify_password(a, "Secret-123") == passwords.Verification(ok=True, needs_rehash=False)
    assert not passwords.verify_password(a, "Secret-124").ok


def test_malformed_or_missing_hashes_never_match():
    for stored in (None, "", "scrypt$", "md5$abc", "scrypt$ln=15$bad$bad", "fbscrypt$r=8,m=14$a$b"):
        assert passwords.verify_password(stored, "anything").ok is False


def test_firebase_reference_vector_verifies_and_asks_for_rehash():
    stored = _fb_stored()
    check = passwords.verify_password(stored, FB_PASSWORD)
    assert check.ok and check.needs_rehash
    assert not passwords.verify_password(stored, "user1passwore").ok
    # URL-safe, unpadded base64 (how some exports encode it) is the same hash.
    urlsafe = base64.urlsafe_b64encode(base64.b64decode(FB_HASH)).decode().rstrip("=")
    assert passwords.verify_password(_fb_stored(hash_=urlsafe), FB_PASSWORD).ok


def _account(user, **kw):
    return {"uid": user.firebase_uid or "fb-" + user.emp_id, "email": user.email, "email_verified": True,
            "disabled": False, "password_hash": FB_HASH, "salt": FB_SALT} | kw


def test_import_matches_by_uid_or_verified_email_and_never_overwrites(world, db):
    from app.cli import import_firebase_passwords
    from app.services.auth import set_password

    jan, jan2, sup, sup2 = (world.users[k] for k in ("jan", "jan2", "sup", "sup2"))
    jan.firebase_uid = "fb-jan"
    jan2.email = "jan2@example.org"            # no uid: matched by its verified e-mail
    sup.email = "sup@example.org"              # no uid, unverified e-mail: not trusted
    set_password(db, sup2, "Already-set-1", source="admin")
    db.commit()
    accounts = [_account(jan, uid="fb-jan"), _account(jan2, uid="fb-jan2"),
                _account(sup, uid="fb-sup", email_verified=False), _account(sup2, uid="fb-sup2")]

    dry = import_firebase_passwords(db, accounts, FB_CONFIG, dry_run=True)
    assert set(dry["imported"]) == {jan.emp_id, jan2.emp_id} and db.get(UserCredential, jan.id) is None

    report = import_firebase_passwords(db, accounts, FB_CONFIG)
    assert set(report["imported"]) == {jan.emp_id, jan2.emp_id}
    assert sup.emp_id in report["no_account"] and sup2.emp_id in report["already_set"]
    cred = db.get(UserCredential, jan2.id)
    assert cred.source == "firebase" and cred.legacy_firebase_uid == "fb-jan2"
    db.refresh(jan2)
    assert jan2.firebase_uid == "fb-jan2"
    assert passwords.verify_password(db.get(UserCredential, sup2.id).password_hash, "Already-set-1").ok
    again = import_firebase_passwords(db, accounts, FB_CONFIG)  # idempotent
    assert again["imported"] == []


def test_imported_password_signs_in_and_is_rehashed(world, db):
    from app.cli import import_firebase_passwords

    jan = world.users["jan"]
    jan.firebase_uid = "fb-jan"
    db.commit()
    import_firebase_passwords(db, [_account(jan, uid="fb-jan")], FB_CONFIG)
    r = world.client.post("/api/v1/auth/login", json=dict(username=jan.emp_id, password=FB_PASSWORD,
                                                          captcha=cap(world.client), device=DEVICE))
    assert r.status_code == 200, r.text
    db.expire_all()
    cred = db.get(UserCredential, jan.id)
    assert cred.password_hash.startswith("scrypt$") and cred.source == "firebase"
    assert passwords.verify_password(cred.password_hash, FB_PASSWORD) == passwords.Verification(ok=True)
    r = world.client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert r.status_code == 200 and r.json()["user"]["password_set"] is True


def test_auth_profile_view_joins_signin_face_and_fingerprint(world, db):
    from app.models import FaceEnrollment
    from app.services.auth import set_password
    from app.timeutil import utcnow

    jan = world.users["jan"]
    set_password(db, jan, "Secret-123", source="admin")
    db.add(FaceEnrollment(user_id=jan.id, division_id=world.a.id, model="m", descriptors=[[0.0]], consent_at=utcnow(),
                          consent_recorded_by_id=world.manager.id))
    db.commit()
    row = db.execute(text("SELECT password_set, password_source, face_enrolled, fingerprint_enrolled "
                          "FROM user_auth_profiles WHERE emp_id = :e"), {"e": jan.emp_id}).one()
    assert (bool(row[0]), row[1], bool(row[2]), bool(row[3])) == (True, "admin", True, False)


def test_password_hash_never_in_api_responses(world, db):
    from app.services.auth import set_password

    jan = world.users["jan"]
    set_password(db, jan, "Secret-123", source="admin")
    db.commit()
    stored = db.get(UserCredential, jan.id).password_hash
    body = world.client.get("/api/v1/users", headers=world.h("manager"), params={"page_size": 100}).text
    assert stored not in body and "password_hash" not in body and hashlib.sha256(b"x")
