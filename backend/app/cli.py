"""Operational bootstrap. Usage:
    python -m app.cli create-division --code JBP --name "Jabalpur Division"
    python -m app.cli create-superadmin --division-code JBP --emp-id SA001 --name "..." --email a@b.c [--firebase-uid UID]
The Super Admin signs in with Firebase; the account links on first sign-in with a verified email, or immediately
when --firebase-uid is given.

Both commands are idempotent: re-running with the same values reports the existing record and changes nothing.
A value that conflicts with an existing record (same division code with another name, same e-mail or employee ID
belonging to someone else, a different Firebase UID) is refused, never overwritten. Nothing here contacts
Firebase: accounts are only mapped to Firebase identities that already exist."""

import argparse
import sys

from sqlalchemy import func, or_, select

from app.db import get_sessionmaker, write_intent
from app.models import Division, RoleId, User, UserStatus
from app.services.common import audit


def _division(db, code: str, name: str) -> int:
    existing = db.scalar(select(Division).where(Division.code == code))
    if existing is not None:
        if existing.name != name:
            print(f"division {code} already exists with name {existing.name!r}; not changed", file=sys.stderr)
            return 2
        print(f"division {existing.code} {existing.id} (already exists)")
        return 0
    division = Division(code=code, name=name)
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
        if args.firebase_uid and user.firebase_uid not in (None, args.firebase_uid):
            print("this user is already linked to a different Firebase account; nothing changed", file=sys.stderr)
            return 2
        if args.firebase_uid and user.firebase_uid is None:
            user.firebase_uid = args.firebase_uid
            audit(db, actor_id=None, action="user.link.cli", entity=user, division_id=division.id)
            db.commit()
            print(f"super admin {user.id} (already exists; linked to the given Firebase UID)")
            return 0
        print(f"super admin {user.id} (already exists)")
        return 0
    user = User(emp_id=args.emp_id, name=args.name, email=email, firebase_uid=args.firebase_uid,
                role_id=RoleId.SUPER_ADMIN, division_id=division.id, status=UserStatus.ACTIVE)
    db.add(user)
    db.flush()
    audit(db, actor_id=None, action="user.create.cli", entity=user, division_id=division.id, changes={"role": "super_admin"})
    db.commit()
    print(f"super admin {user.id}")
    return 0


ROLE_NAMES = {"admin": RoleId.ADMIN, "manager": RoleId.MANAGER, "supervisor": RoleId.SUPERVISOR,
              "janitor": RoleId.JANITOR, "contractor": RoleId.CONTRACTOR}


def link_user(db, *, email: str, firebase_uid: str | None, role: str | None) -> int:
    """Links an existing employee to their Firebase login (needed when the Firebase email is unverified, which
    blocks automatic linking) and optionally changes the role. An administrator's explicit decision: whoever
    holds that Firebase account signs in as this employee. Super Admin is never granted here."""
    email = email.lower()
    users = db.scalars(select(User).where(User.status != UserStatus.DELETED, func.lower(User.email) == email)).all()
    if len(users) != 1:
        print(f"expected one employee with e-mail {email}, found {len(users)}; nothing changed", file=sys.stderr)
        return 2
    user = users[0]
    changes = {}
    if firebase_uid:
        taken = db.scalar(select(User).where(User.firebase_uid == firebase_uid, User.id != user.id))
        if taken is not None:
            print(f"Firebase account already linked to employee {taken.emp_id}; nothing changed", file=sys.stderr)
            return 2
        if user.firebase_uid not in (None, firebase_uid):
            print("employee is linked to a different Firebase account; nothing changed", file=sys.stderr)
            return 2
        if user.firebase_uid is None:
            user.firebase_uid = firebase_uid
            changes["firebase_uid"] = "linked"
    if role:
        new_role = ROLE_NAMES[role]
        if user.role_id == RoleId.SUPER_ADMIN:
            print("refusing to change a Super Admin's role here", file=sys.stderr)
            return 2
        if user.role_id != new_role:
            changes["role"] = {"from": int(user.role_id), "to": int(new_role)}
            user.role_id = new_role
    if changes:
        audit(db, actor_id=None, action="user.update.cli", entity=user, division_id=user.division_id, changes=changes)
        db.commit()
    print(f"{user.emp_id} {user.name}: {changes or 'already up to date'}")
    return 0


def _firebase_uid_for(email: str) -> str | None:
    import firebase_admin
    from firebase_admin import auth, credentials

    from app.config import get_settings

    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(get_settings().firebase_credentials_file))
    try:
        return auth.get_user_by_email(email).uid
    except auth.UserNotFoundError:
        return None


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
    s.add_argument("--firebase-uid")
    lk = sub.add_parser("link-user", help="link an employee to their Firebase login and/or change their role")
    lk.add_argument("--email", required=True)
    lk.add_argument("--role", choices=sorted(ROLE_NAMES))
    lk.add_argument("--no-link", action="store_true", help="only change the role")
    f = sub.add_parser("file-media-by-journey", help="move files kept under other/ into their journey folder")
    f.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.cmd == "link-user":
        uid = None
        if not args.no_link:
            uid = _firebase_uid_for(args.email.lower())
            if uid is None:
                print(f"no Firebase account for {args.email}: the person must register in the app first", file=sys.stderr)
                return 1
        with write_intent(), get_sessionmaker()() as db:
            return link_user(db, email=args.email, firebase_uid=uid, role=args.role)

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
