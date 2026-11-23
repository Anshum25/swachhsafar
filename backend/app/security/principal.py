import uuid
from dataclasses import dataclass, field

from fastapi import Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import AppError, Forbidden, Unauthenticated
from app.models import ALWAYS_ON_MODULES, GATEABLE_MODULES, ChargeMap, PermissionEffect, RoleId, RolePermission, User
from app.security.catalog import ALL_MODULES, MANAGEABLE_ROLES, PERMISSION_MODULE
from app.timeutil import today_ist


def role_grants(db: Session, role_id: int, division_id: uuid.UUID) -> set[str]:
    """The permissions a role holds in a division by its grants alone (no module gating), most specific last:
    the global grant, then the division's office, then every division of its kind (headquarters or station)
    in that office, then the division itself. The one place this order lives."""
    from app.models import Division

    where = db.execute(select(Division.client_id, Division.kind).where(Division.id == division_id)).first()
    client_id, kind = where if where else (None, None)
    rows = db.execute(
        select(RolePermission.permission_code, RolePermission.client_id, RolePermission.division_kind,
               RolePermission.division_id, RolePermission.effect).where(
            RolePermission.role_id == role_id,
            (RolePermission.client_id.is_(None) & RolePermission.division_id.is_(None))
            | ((RolePermission.client_id == client_id)
               & (RolePermission.division_kind.is_(None) | (RolePermission.division_kind == kind)))
            | (RolePermission.division_id == division_id),
        )
    ).all()

    def level(cl, k, div) -> int:
        return 3 if div is not None else 2 if k is not None else 1 if cl is not None else 0

    granted: set[str] = set()
    for code, cl, k, div, eff in sorted(rows, key=lambda r: level(*r[1:4])):
        (granted.add if eff == PermissionEffect.ALLOW else granted.discard)(code)
    return granted


@dataclass
class Principal:
    """The authenticated caller. Role and divisions come from PostgreSQL, never from the request."""

    user: User
    division_ids: frozenset[uuid.UUID]
    _db: Session
    _perm_cache: dict[uuid.UUID, frozenset[str]] = field(default_factory=dict)
    _module_cache: dict[uuid.UUID, frozenset[str]] = field(default_factory=dict)
    # Backend sign-in session and its device.
    session_id: uuid.UUID | None = None
    device_id: str | None = None
    # Optional `?client_id=` on the request: narrows every list to that client's divisions. A filter, never a
    # grant -- it can only take divisions away from what the caller may already see.
    client_id: uuid.UUID | None = None

    @property
    def id(self) -> uuid.UUID:
        return self.user.id

    @property
    def role(self) -> RoleId:
        return RoleId(self.user.role_id)

    @property
    def is_super_admin(self) -> bool:
        return self.role == RoleId.SUPER_ADMIN

    def can_access_division(self, division_id: uuid.UUID) -> bool:
        return self.is_super_admin or division_id in self.division_ids

    def modules_in(self, division_id: uuid.UUID) -> frozenset[str]:
        """What the division's client is subscribed to, plus the always-on platform. A Super Admin is not
        gated: they configure the subscriptions, so they must be able to see what they are configuring."""
        if self.is_super_admin:
            return ALL_MODULES
        if division_id not in self._module_cache:
            from app.models import Client, Division

            modules = self._db.scalar(
                select(Client.enabled_modules).join(Division, Division.client_id == Client.id).where(
                    Division.id == division_id
                )
            )
            enabled = {m for m in (modules or []) if m in GATEABLE_MODULES}
            self._module_cache[division_id] = ALWAYS_ON_MODULES | frozenset(enabled)
        return self._module_cache[division_id]

    def module_enabled(self, permission: str, division_id: uuid.UUID) -> bool:
        """Whether the module a permission belongs to is part of the division's client subscription. A
        permission outside the catalog is treated as always-on: this gate is a subscription check, not a
        second place for a typo to become a silent denial."""
        module = PERMISSION_MODULE.get(permission)
        return module is None or module in self.modules_in(division_id)

    def permissions_in(self, division_id: uuid.UUID) -> frozenset[str]:
        if division_id not in self._perm_cache:
            granted = role_grants(self._db, self.user.role_id, division_id)
            # The client's subscription caps the role: what the office has not bought, nobody in it holds.
            # Doing it here means /auth/me, every list endpoint and every require() agree without each
            # having to remember the check.
            allowed_modules = self.modules_in(division_id)
            self._perm_cache[division_id] = frozenset(
                code for code in granted
                if PERMISSION_MODULE.get(code) is None or PERMISSION_MODULE[code] in allowed_modules
            )
        return self._perm_cache[division_id]

    def has(self, permission: str, division_id: uuid.UUID) -> bool:
        return self.can_access_division(division_id) and permission in self.permissions_in(division_id)

    def require(self, permission: str, division_id: uuid.UUID) -> None:
        if not self.can_access_division(division_id):
            raise Forbidden("Outside your authorized divisions", code="division_forbidden")
        # Said apart from permission_denied so the answer is actionable: the role is right, the office has
        # not subscribed to this module, and only the Super Admin can change that.
        if not self.module_enabled(permission, division_id):
            raise Forbidden(
                f"The {PERMISSION_MODULE[permission]} module is not enabled for this client",
                code="module_disabled",
                details={"module": PERMISSION_MODULE[permission]},
            )
        if permission not in self.permissions_in(division_id):
            raise Forbidden(f"Missing permission {permission}", code="permission_denied")

    def require_any_division(self, permission: str) -> list[uuid.UUID]:
        """Divisions in which the caller holds the permission (for list endpoints). Empty -> forbidden."""
        scope = self.scope_divisions()
        divisions = [d for d in scope if permission in self.permissions_in(d)]
        if not divisions:
            # Distinguish "your office has not bought this module" from "your role lacks this permission".
            # Both are 403, but only one of them is something the user can ask to have changed.
            if scope and not any(self.module_enabled(permission, d) for d in scope):
                raise Forbidden(
                    f"The {PERMISSION_MODULE[permission]} module is not enabled for this client",
                    code="module_disabled",
                    details={"module": PERMISSION_MODULE[permission]},
                )
            raise Forbidden(f"Missing permission {permission}", code="permission_denied")
        return divisions

    def scope_divisions(self) -> list[uuid.UUID]:
        """Every division the caller may see: all of them for a Super Admin, otherwise their home division and
        active charges. With a client filter, only the ones belonging to that client."""
        from app.models import Division

        if self.is_super_admin:
            stmt = select(Division.id)
        elif self.client_id is None:
            return list(self.division_ids)
        else:
            stmt = select(Division.id).where(Division.id.in_(self.division_ids))
        if self.client_id is not None:
            stmt = stmt.where(Division.client_id == self.client_id)
        return list(self._db.scalars(stmt.order_by(Division.name)))

    def can_manage_role(self, role_id: int) -> bool:
        return RoleId(role_id) in MANAGEABLE_ROLES[self.role]


def resolve_principal(db: Session, user: User) -> Principal:
    """Role and divisions (home division plus any active temporary charge) of an authenticated employee."""
    today = today_ist()
    charge = db.scalars(
        select(ChargeMap.division_id).where(
            ChargeMap.user_id == user.id,
            ChargeMap.is_active.is_(True),
            ChargeMap.from_date <= today,
            ChargeMap.to_date >= today,
        )
    ).all()
    return Principal(user=user, division_ids=frozenset({user.division_id, *charge}), _db=db)


def get_principal(request: Request, authorization: str | None = Header(default=None),
                  db: Session = Depends(get_db)) -> Principal:
    """The caller, from the session token issued by the backend sign-in (app/services/auth.py).

    `?client_id=` on any request narrows the caller's division scope to that client (scope_divisions), so
    every list endpoint filters by client without each declaring the parameter. It is read from the query
    string here rather than declared, because /clients/{client_id}/... already uses the name for a path."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthenticated("Missing bearer token")
    from app.services.auth import authenticate  # late import: services depend on this module

    session, user = authenticate(db, authorization.split(" ", 1)[1].strip())
    principal = resolve_principal(db, user)
    principal.session_id, principal.device_id = session.id, session.device_id
    raw = request.query_params.get("client_id")
    if raw:
        try:
            principal.client_id = uuid.UUID(raw)
        except ValueError:
            raise AppError("client_id is not a valid UUID", code="invalid_client_id") from None
    return principal
