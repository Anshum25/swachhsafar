import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.schemas.faces import FaceEnrollIn, FaceStatusOut
from app.schemas.fingerprints import FingerprintEnrollIn, FingerprintProfileOut, FingerprintStatusOut
from app.services import faces, fingerprints
from app.db import get_db
from app.errors import Forbidden
from app.models import AuditLog, UserStatus
from app.schemas.common import Page, PageParams
from app.schemas.org import (
    AuditOut,
    ChargeMapCreate,
    ChargeMapOut,
    DivisionCreate,
    DivisionOut,
    DivisionUpdate,
    GrantIn,
    GrantOut,
    KycIn,
    KycOut,
    MeOut,
    PasswordResetIn,
    PasswordResetOut,
    PermissionOut,
    RoleOut,
    SignInIn,
    UserAccountOut,
    UserCreate,
    UserOut,
    UserStatusIn,
    UserUpdate,
    UserWithSignIn,
)
from app.schemas.policy import PolicySettings
from app.security.principal import Principal, get_principal
from app.services import org, policy
from app.services.common import paginate

auth_router = APIRouter(prefix="/auth", tags=["auth"])
users_router = APIRouter(prefix="/users", tags=["users"])
roles_router = APIRouter(prefix="/roles", tags=["roles"])
divisions_router = APIRouter(prefix="/divisions", tags=["divisions"])
permissions_router = APIRouter(prefix="/permissions", tags=["permissions"])
audit_router = APIRouter(prefix="/audit", tags=["audit"])


@auth_router.get("/me", response_model=MeOut)
def me(p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    from app.security.lease import issue_offline_lease
    from app.services.policy import get_policy
    pol = get_policy(db, p.user.division_id) if p.user.division_id else None
    offline_hours = pol.offline_session_hours if pol else 24
    lease = issue_offline_lease(p.user, p.device_id, p.session_id, offline_hours=offline_hours)
    return MeOut(user=UserOut.model_validate(p.user),
                 divisions={d: sorted(p.permissions_in(d)) for d in p.division_ids},
                 offline_lease=lease)


@auth_router.get("/lease", response_model=dict)
def get_lease(p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    from app.security.lease import issue_offline_lease
    from app.services.policy import get_policy
    pol = get_policy(db, p.user.division_id) if p.user.division_id else None
    offline_hours = pol.offline_session_hours if pol else 24
    return issue_offline_lease(p.user, p.device_id, p.session_id, offline_hours=offline_hours)


# ---- users -------------------------------------------------------------------------------------------------

@users_router.get("", response_model=Page[UserOut])
def list_users(params: PageParams = Depends(), role_id: int | None = None, status_: UserStatus | None = Query(None, alias="status"),
               division_id: uuid.UUID | None = None, q: str | None = Query(None, max_length=50),
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    items, total = org.list_users(db, p, params, role_id=role_id, status=status_, division_id=division_id, q=q)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def _with_signin(user, signin) -> UserWithSignIn:
    """The user as always, plus what just happened to their sign-in (a generated password is shown once)."""
    if signin is None:
        return UserWithSignIn.model_validate(user)
    return UserWithSignIn.model_validate(user).model_copy(
        update={"temp_password": signin.password, "signin": "created"})


@users_router.post("", response_model=UserWithSignIn, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Creates the employee and, when an e-mail or password is given, the sign-in that goes with it."""
    user, signin = org.create_user(db, p, body)
    return _with_signin(user, signin)


@users_router.post("/{user_id}/signin", response_model=UserWithSignIn)
def create_signin(user_id: uuid.UUID, body: SignInIn, db: Session = Depends(get_db),
                  p: Principal = Depends(get_principal)):
    """Password sign-in for an employee who has none (created without e-mail or password)."""
    user, signin = org.create_signin(db, p, user_id, body.password)
    return _with_signin(user, signin)


@users_router.get("/charge-maps", response_model=list[ChargeMapOut])
def list_charges(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.list_charges(db, p)


@users_router.post("/charge-maps", response_model=ChargeMapOut, status_code=status.HTTP_201_CREATED)
def create_charge(body: ChargeMapCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.create_charge(db, p, body)


@users_router.post("/charge-maps/{charge_id}/end", response_model=ChargeMapOut)
def end_charge(charge_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.end_charge(db, p, charge_id)


@users_router.get("/{user_id}", response_model=UserOut)
def get_user(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.get_user(db, p, user_id)


@users_router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.update_user(db, p, user_id, body)


@users_router.get("/{user_id}/account", response_model=UserAccountOut)
def get_account(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Creation, sign-in and effective permissions of a user, for the administrator's profile view."""
    return org.account_summary(db, p, user_id)


@users_router.post("/{user_id}/password", response_model=PasswordResetOut)
def reset_password(user_id: uuid.UUID, body: PasswordResetIn, db: Session = Depends(get_db),
                   p: Principal = Depends(get_principal)):
    """An administrator sets a new password for an employee they manage; that employee's sessions are ended."""
    return PasswordResetOut(sessions_ended=org.reset_password(db, p, user_id, body.new_password))


@users_router.post("/{user_id}/status", response_model=UserOut)
def set_status(user_id: uuid.UUID, body: UserStatusIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.set_user_status(db, p, user_id, UserStatus(body.status))


@users_router.get("/{user_id}/face", response_model=FaceStatusOut)
def get_face(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return faces.status(db, p, user_id)


@users_router.put("/{user_id}/face", response_model=FaceStatusOut)
def put_face(user_id: uuid.UUID, body: FaceEnrollIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """Register (or replace) the employee's face descriptors. Requires the employee's recorded consent."""
    return faces.enroll(db, p, user_id, body)


@users_router.get("/{user_id}/fingerprint", response_model=FingerprintStatusOut)
def get_fingerprint(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return fingerprints.status(db, p, user_id)


@users_router.get("/{user_id}/fingerprint/profile", response_model=FingerprintProfileOut)
def get_fingerprint_profile(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    """The employee's templates for a device verifying their attendance that has not synced them yet.
    Same access rule as /sync/changes: only staff this user may record attendance for, and their own."""
    return fingerprints.profile_for_verifier(db, p, user_id)


@users_router.put("/{user_id}/fingerprint", response_model=FingerprintStatusOut)
def put_fingerprint(user_id: uuid.UUID, body: FingerprintEnrollIn, db: Session = Depends(get_db),
                    p: Principal = Depends(get_principal)):
    """Register (or replace) the employee's fingerprint templates. Requires the employee's recorded consent."""
    return fingerprints.enroll(db, p, user_id, body)


@users_router.delete("/{user_id}/fingerprint", status_code=status.HTTP_204_NO_CONTENT)
def delete_fingerprint(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    fingerprints.revoke(db, p, user_id)


@users_router.delete("/{user_id}/face", status_code=status.HTTP_204_NO_CONTENT)
def delete_face(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    faces.revoke(db, p, user_id)


@users_router.get("/{user_id}/kyc", response_model=KycOut)
def get_kyc(user_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.get_kyc(db, p, user_id)


@users_router.put("/{user_id}/kyc", response_model=KycOut)
def put_kyc(user_id: uuid.UUID, body: KycIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.put_kyc(db, p, user_id, body)


# ---- roles / permissions / divisions -----------------------------------------------------------------------

@roles_router.get("", response_model=list[RoleOut])
def list_roles(db: Session = Depends(get_db), _: Principal = Depends(get_principal)):
    return org.roles(db)


@permissions_router.get("", response_model=list[PermissionOut])
def list_permissions(db: Session = Depends(get_db), _: Principal = Depends(get_principal)):
    return org.permissions(db)


@permissions_router.get("/grants", response_model=list[GrantOut])
def list_grants(division_id: uuid.UUID | None = None, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.list_grants(db, p, division_id)


@permissions_router.put("/grants", response_model=GrantOut)
def upsert_grant(body: GrantIn, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.upsert_grant(db, p, body)


@permissions_router.delete("/grants/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_grant(grant_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    org.delete_grant(db, p, grant_id)


@divisions_router.get("", response_model=list[DivisionOut])
def list_divisions(db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.list_divisions(db, p)


@divisions_router.post("", response_model=DivisionOut, status_code=status.HTTP_201_CREATED)
def create_division(body: DivisionCreate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.create_division(db, p, body)


@divisions_router.patch("/{division_id}", response_model=DivisionOut)
def update_division(division_id: uuid.UUID, body: DivisionUpdate, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    return org.update_division(db, p, division_id, body)


@divisions_router.get("/{division_id}/policy", response_model=PolicySettings)
def get_policy(division_id: uuid.UUID, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    if not p.can_access_division(division_id):
        raise Forbidden("Outside your authorized divisions", code="division_forbidden")
    return policy.get_policy(db, division_id)


@divisions_router.put("/{division_id}/policy", response_model=PolicySettings)
def put_policy(division_id: uuid.UUID, body: PolicySettings, db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    p.require("policies.manage", division_id)
    return policy.set_policy(db, division_id, body, p.id)


@audit_router.get("", response_model=Page[AuditOut])
def list_audit(params: PageParams = Depends(), entity_type: str | None = None, entity_id: str | None = None,
               db: Session = Depends(get_db), p: Principal = Depends(get_principal)):
    divisions = p.require_any_division("audit.read")
    stmt = select(AuditLog).where(AuditLog.division_id.in_(divisions))
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    items, total = paginate(db, stmt.order_by(AuditLog.created_at.desc()), params)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)
