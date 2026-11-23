"""Operational bootstrap and account maintenance. Usage:
    python -m app.cli create-division --code JBP --name "Jabalpur Division"
    python -m app.cli create-superadmin --division-code JBP --emp-id SA001 --name "..." --email a@b.c
    python -m app.cli set-password --emp-id SA001            # prompts; or --password-stdin
    python -m app.cli set-role --email a@b.c --role manager
    python -m app.cli import-firebase-passwords [--dry-run]   # one-off: move passwords off Firebase Auth

Sign-in lives in PostgreSQL. create-superadmin asks for the Super Admin's password (or reads it from stdin with
--password-stdin) unless the account already has one.

The create commands are idempotent: re-running with the same values reports the existing record and changes
nothing. A value that conflicts with an existing record (same division code with another name, same e-mail or
employee ID belonging to someone else) is refused, never overwritten."""

import argparse
import getpass
import sys
from collections.abc import Iterable

from sqlalchemy import func, or_, select

from app.db import get_sessionmaker, write_intent
from app.models import GATEABLE_MODULES, Client, Division, RoleId, User, UserCredential, UserStatus
from app.security import passwords
from app.services.common import audit
from app.timeutil import utcnow

PASSWORD_MIN = 8


def _read_password(from_stdin: bool) -> str | None:
    if from_stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = getpass.getpass("New password: ")
        if pw != getpass.getpass("Repeat it: "):
            print("the two passwords differ; nothing changed", file=sys.stderr)
            return None
    if not (PASSWORD_MIN <= len(pw) <= 128) or not any(c.isalpha() for c in pw) or not any(c.isdigit() for c in pw):
        print(f"a password needs {PASSWORD_MIN}-128 characters with a letter and a digit; nothing changed", file=sys.stderr)
        return None
    return pw


def set_password(db, user: User, password: str, *, actor: str = "cli") -> None:
    from app.services.auth import set_password as store

    store(db, user, password, source="cli")
    audit(db, actor_id=None, action="user.password.set.cli", entity=user, division_id=user.division_id,
          changes={"by": actor})
    db.commit()


def _default_client(db) -> Client:
    """A division must belong to a client (office). Bootstrapping a deployment from the command line
    should not need one to exist first, so the first division creates `OFF-001` with every module and
    journeys free; the super admin then renames it and sets a rate from Master data → Clients."""
    client = db.scalar(select(Client).order_by(Client.created_at).limit(1))
    if client is not None:
        return client
    client = Client(office_id="OFF-001", name="Default Office", enabled_modules=list(GATEABLE_MODULES),
                    credit_per_journey=0, low_credit_threshold=0)
    db.add(client)
    db.flush()
    print(f"client {client.office_id} {client.id} (created; journeys are free until a rate is set)")
    return client


def _division(db, code: str, name: str) -> int:
    existing = db.scalar(select(Division).where(Division.code == code))
    if existing is not None:
        if existing.name != name:
            print(f"division {code} already exists with name {existing.name!r}; not changed", file=sys.stderr)
            return 2
        print(f"division {existing.code} {existing.id} (already exists)")
        return 0
    division = Division(code=code, name=name, client_id=_default_client(db).id)
    db.add(division)
    db.flush()
    audit(db, actor_id=None, action="division.create.cli", entity=division, division_id=division.id)
    db.commit()
    print(f"division {division.code} {division.id}")
    return 0


def _superadmin(db, args) -> int:
    division = db.scalar(select(Division).where(Division.code == args.division_code.upper()))
    if division is None:
        print("division not found", file=sys.stderr)
        return 1
    email = args.email.lower()
    matches = db.scalars(select(User).where(User.status != UserStatus.DELETED,
                                            or_(func.lower(User.email) == email, User.emp_id == args.emp_id))).all()
    if matches:
        user = matches[0]
        same = (len(matches) == 1 and (user.email or "").lower() == email and user.emp_id == args.emp_id
                and user.role_id == RoleId.SUPER_ADMIN and user.division_id == division.id)
        if not same:
            print("a different user already has this e-mail or employee ID; nothing changed", file=sys.stderr)
            return 2
        if db.get(UserCredential, user.id) is None:
            password = _read_password(args.password_stdin)
            if password is None:
                return 2
            set_password(db, user, password)
            print(f"super admin {user.id} (already exists; password set)")
            return 0
        print(f"super admin {user.id} (already exists)")
        return 0
    password = _read_password(args.password_stdin)
    if password is None:
        return 2
    user = User(emp_id=args.emp_id, name=args.name, email=email, role_id=RoleId.SUPER_ADMIN, division_id=division.id,
                status=UserStatus.ACTIVE)
    db.add(user)
    db.flush()
    audit(db, actor_id=None, action="user.create.cli", entity=user, division_id=division.id, changes={"role": "super_admin"})
    set_password(db, user, password)
    print(f"super admin {user.id}")
    return 0


ROLE_NAMES = {"admin": RoleId.ADMIN, "manager": RoleId.MANAGER, "supervisor": RoleId.SUPERVISOR,
              "janitor": RoleId.JANITOR, "contractor": RoleId.CONTRACTOR}


def set_role(db, *, email: str, role: str) -> int:
    """Changes an employee's role. Super Admin is never granted or taken away here."""
    email = email.lower()
    users = db.scalars(select(User).where(User.status != UserStatus.DELETED, func.lower(User.email) == email)).all()
    if len(users) != 1:
        print(f"expected one employee with e-mail {email}, found {len(users)}; nothing changed", file=sys.stderr)
        return 2
    user = users[0]
    new_role = ROLE_NAMES[role]
    if user.role_id == RoleId.SUPER_ADMIN:
        print("refusing to change a Super Admin's role here", file=sys.stderr)
        return 2
    changes = {}
    if user.role_id != new_role:
        changes["role"] = {"from": int(user.role_id), "to": int(new_role)}
        user.role_id = new_role
        audit(db, actor_id=None, action="user.update.cli", entity=user, division_id=user.division_id, changes=changes)
        db.commit()
    print(f"{user.emp_id} {user.name}: {changes or 'already up to date'}")
    return 0


# ---- moving passwords off Firebase Authentication ----------------------------------------------------------
def import_firebase_passwords(db, accounts: Iterable[dict], hash_config: dict, *, dry_run: bool = False) -> dict:
    """Copies the Firebase password hash of every employee into user_credentials, so they keep signing in with
    the password they already have. `accounts`: Firebase users as {uid, email, email_verified, disabled,
    password_hash, salt}; `hash_config`: the project's {algorithm, signerKey, saltSeparator, rounds, memoryCost}.

    An employee is matched by the Firebase UID recorded on them; one without a UID only by a *verified* e-mail
    (an unverified address proves nothing about who holds the account). Nobody's existing PostgreSQL password is
    ever replaced. Returns counts and per-employee outcomes (Employee IDs only, never hashes)."""
    if (hash_config.get("algorithm") or "").upper() != "SCRYPT":
        raise ValueError(f"unsupported Firebase hash algorithm {hash_config.get('algorithm')!r}")
    by_uid = {a["uid"]: a for a in accounts}
    by_email = {}
    for a in by_uid.values():
        if a.get("email"):
            by_email.setdefault(a["email"].lower(), []).append(a)
    report: dict = {"imported": [], "already_set": [], "no_account": [], "no_hash": [], "disabled": []}
    now = utcnow()
    for user in db.scalars(select(User).where(User.status != UserStatus.DELETED).order_by(User.emp_id)):
        if db.get(UserCredential, user.id) is not None:
            report["already_set"].append(user.emp_id)
            continue
        acct = by_uid.get(user.firebase_uid) if user.firebase_uid else None
        if acct is None and user.email and not user.firebase_uid:
            found = [a for a in by_email.get(user.email.lower(), []) if a.get("email_verified")]
            acct = found[0] if len(found) == 1 else None
        if acct is None:
            report["no_account"].append(user.emp_id)
            continue
        if not acct.get("password_hash") or not acct.get("salt"):
            report["no_hash"].append(user.emp_id)
            continue
        if acct.get("disabled"):
            report["disabled"].append(user.emp_id)  # imported anyway: the employee's status decides access now
        stored = passwords.firebase_hash(password_hash=acct["password_hash"], salt=acct["salt"],
                                         salt_separator=hash_config["saltSeparator"], signer_key=hash_config["signerKey"],
                                         rounds=hash_config["rounds"], mem_cost=hash_config["memoryCost"])
        if not dry_run:
            db.add(UserCredential(user_id=user.id, password_hash=stored, source="firebase", password_changed_at=now,
                                  legacy_firebase_uid=acct["uid"]))
            user.firebase_uid = user.firebase_uid or acct["uid"]
            audit(db, actor_id=None, action="user.password.import", entity=user, division_id=user.division_id,
                  changes={"from": "firebase"})
        report["imported"].append(user.emp_id)
    if dry_run:
        db.rollback()
    else:
        db.commit()
    return report


def _fetch_firebase(credentials_file: str) -> tuple[list[dict], dict]:
    """All Firebase Auth users with their password hashes, and the project's hash parameters (read-only)."""
    import json

    import firebase_admin  # optional dependency: pip install ".[firebase]"
    from firebase_admin import auth, credentials
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    info = json.loads(open(credentials_file, encoding="utf-8").read())
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(info))
    accounts = [{"uid": u.uid, "email": u.email, "email_verified": u.email_verified, "disabled": u.disabled,
                 "password_hash": u.password_hash, "salt": u.password_salt} for u in auth.list_users().iterate_all()]
    scoped = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    resp = AuthorizedSession(scoped).get(
        f"https://identitytoolkit.googleapis.com/admin/v2/projects/{info['project_id']}/config", timeout=30)
    resp.raise_for_status()
    hash_config = (resp.json().get("signIn") or {}).get("hashConfig") or {}
    if not hash_config.get("signerKey"):
        raise RuntimeError("the service account cannot read the project's password hash parameters")
    return accounts, hash_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("create-division")
    d.add_argument("--code", required=True)
    d.add_argument("--name", required=True)
    s = sub.add_parser("create-superadmin")
    s.add_argument("--division-code", required=True)
    s.add_argument("--emp-id", required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--email", required=True)
    s.add_argument("--password-stdin", action="store_true", help="read the password from stdin instead of prompting")
    sp = sub.add_parser("set-password", help="set (or reset) an employee's password")
    sp.add_argument("--emp-id", required=True)
    sp.add_argument("--password-stdin", action="store_true")
    sr = sub.add_parser("set-role", help="change an employee's role")
    sr.add_argument("--email", required=True)
    sr.add_argument("--role", required=True, choices=sorted(ROLE_NAMES))
    fb = sub.add_parser("import-firebase-passwords",
                        help="copy employees' password hashes from Firebase Auth (one-off migration)")
    fb.add_argument("--credentials", help="service-account JSON (default FIREBASE_CREDENTIALS_FILE)")
    fb.add_argument("--dry-run", action="store_true")
    f = sub.add_parser("file-media-by-journey", help="move files kept under other/ into their journey folder")
    f.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.cmd == "set-role":
        with write_intent(), get_sessionmaker()() as db:
            return set_role(db, email=args.email, role=args.role)

    if args.cmd == "set-password":
        with write_intent(), get_sessionmaker()() as db:
            user = db.scalar(select(User).where(User.status != UserStatus.DELETED,
                                                func.lower(User.emp_id) == args.emp_id.lower()))
            if user is None:
                print("employee not found", file=sys.stderr)
                return 1
            password = _read_password(args.password_stdin)
            if password is None:
                return 2
            set_password(db, user, password)
            print(f"{user.emp_id}: password set")
            return 0

    if args.cmd == "import-firebase-passwords":
        from app.config import get_settings

        source = args.credentials or get_settings().firebase_credentials_file
        if not source:
            print("give --credentials or set FIREBASE_CREDENTIALS_FILE", file=sys.stderr)
            return 1
        accounts, hash_config = _fetch_firebase(source)
        with write_intent(), get_sessionmaker()() as db:
            report = import_firebase_passwords(db, accounts, hash_config, dry_run=args.dry_run)
        print(f"Firebase accounts read: {len(accounts)}{' (dry run: nothing written)' if args.dry_run else ''}")
        for outcome, emp_ids in report.items():
            print(f"  {outcome}: {len(emp_ids)}" + (f"  [{', '.join(emp_ids)}]" if emp_ids else ""))
        return 0

    if args.cmd == "file-media-by-journey":
        from app.config import get_settings
        from app.services.media import file_by_journey

        settings = get_settings()
        if settings.storage_backend != "local":
            print("only for STORAGE_BACKEND=local", file=sys.stderr)
            return 1
        with get_sessionmaker()() as db:
            moved = file_by_journey(db, settings.local_media_dir, dry_run=args.dry_run)
        for old, new in moved:
            print(f"{'would move' if args.dry_run else 'moved'} {old} -> {new}")
        print(f"{len(moved)} file(s)")
        return 0

    # The whole check-then-create runs under the database write lock (SQLite), so two concurrent runs
    # cannot both create the record.
    with write_intent(), get_sessionmaker()() as db:
        if args.cmd == "create-division":
            return _division(db, args.code.upper(), args.name)
        return _superadmin(db, args)


if __name__ == "__main__":
    raise SystemExit(main())
