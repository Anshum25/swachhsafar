import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.models import GATEABLE_MODULES, Client, Division, RoleId, User, UserStatus
from app.providers.external import PnrResult, ProviderUnavailable
from app.timeutil import today_ist

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + bytes(200)
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + bytes(200)
PDF = b"%PDF-1.4\n" + bytes(200)


class FakeSms:
    name, enabled = "fake", True

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.down = False

    def send_otp(self, mobile: str, code: str) -> None:
        if self.down:
            raise ProviderUnavailable("down")
        self.sent.append((mobile, code))
        return f"fake-{len(self.sent)}"

    def send_login_otp(self, mobile: str, code: str) -> None:
        return self.send_otp(mobile, code)

    @property
    def last_code(self) -> str:
        return self.sent[-1][1]


class FakePnr:
    def __init__(self) -> None:
        self.results: dict[str, PnrResult] = {}
        self.down = False
        self.calls: list[str] = []

    def lookup(self, pnr: str) -> PnrResult:
        self.calls.append(pnr)
        if self.down:
            raise ProviderUnavailable("down")
        return self.results.get(pnr, PnrResult(found=False))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


TEST_DEVICE = "dev-factory-0000"


def session_token(user: User, device_id: str = TEST_DEVICE) -> str:
    """A real session for `user` (as a sign-in creates one), on the shared factory device."""
    from sqlalchemy.orm import object_session

    from app.models import AuthSession, Device
    from app.security import tokens
    from app.timeutil import utcnow

    db = object_session(user)
    if db.get(Device, device_id) is None:
        db.add(Device(id=device_id, platform="web", label="factory"))
        db.flush()
    session = AuthSession(id=uuid.uuid4(), user_id=user.id, device_id=device_id, method="password", last_seen_at=utcnow())
    issued = tokens.issue(session.id)
    session.token_hash = issued.token_hash
    db.add(session)
    db.commit()
    return issued.token


def auth(user: User) -> dict:
    """Bearer header of a session for `user`, created once per user object and reused."""
    token = user.__dict__.get("_test_token")
    if token is None:
        token = session_token(user)
        user.__dict__["_test_token"] = token
    return {"Authorization": f"Bearer {token}"}


def make_client(db, office_id: str, **kw) -> Client:
    """A client (office) with every module subscribed and journeys free, which is what the operational
    tests assume. The credit tests set a rate and a balance themselves."""
    c = Client(
        office_id=office_id,
        name=kw.pop("name", f"{office_id} Office"),
        enabled_modules=kw.pop("enabled_modules", list(GATEABLE_MODULES)),
        credit_per_journey=kw.pop("credit_per_journey", 0),
        credit_balance=kw.pop("credit_balance", 0),
        **kw,
    )
    db.add(c)
    db.commit()
    return c


def make_division(db, code: str, client: Client | None = None) -> Division:
    d = Division(code=code, name=f"{code} Division", client_id=(client or make_client(db, f"OFF-{code}")).id)
    db.add(d)
    db.commit()
    return d


_mobile_seq = iter(range(10_000_000))


def make_user(db, division: Division, role: RoleId, name: str, **kw) -> User:
    u = User(emp_id=f"{division.code}-{name}", name=name.title(), role_id=int(role), division_id=division.id,
             status=kw.pop("status", UserStatus.ACTIVE),
             mobile=kw.pop("mobile", f"9{next(_mobile_seq):09d}"), **kw)
    db.add(u)
    db.commit()
    return u


def upload(client, user: User, division_id, kind: str, data: bytes = PNG, content_type: str = "image/png") -> str:
    media_id = str(uuid.uuid4())
    r = client.post("/api/v1/media", headers=auth(user), json=dict(
        id=media_id, division_id=str(division_id), kind=kind, content_type=content_type, size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest()))
    assert r.status_code == 201, r.text
    r = client.put(f"/api/v1/media/{media_id}/content", headers=auth(user), content=data)
    assert r.status_code == 200, r.text
    return media_id


@dataclass
class World:
    db: object
    client: object
    a: Division
    b: Division
    users: dict[str, User] = field(default_factory=dict)
    train: dict | None = None
    journey: dict | None = None

    def __getattr__(self, name):
        users = self.__dict__.get("users", {})
        if name in users:
            return users[name]
        raise AttributeError(name)

    def h(self, name: str) -> dict:
        return auth(self.users[name])

    @classmethod
    def build(cls, db, client) -> "World":
        a, b = make_division(db, "AAA"), make_division(db, "BBB")
        w = cls(db=db, client=client, a=a, b=b)
        for div, specs in ((a, [("sa", RoleId.SUPER_ADMIN), ("admin", RoleId.ADMIN), ("manager", RoleId.MANAGER),
                                ("sup", RoleId.SUPERVISOR), ("sup2", RoleId.SUPERVISOR), ("jan", RoleId.JANITOR),
                                ("jan2", RoleId.JANITOR), ("contractor", RoleId.CONTRACTOR)]),
                           (b, [("manager_b", RoleId.MANAGER), ("sup_b", RoleId.SUPERVISOR), ("jan_b", RoleId.JANITOR)])):
            for name, role in specs:
                w.users[name] = make_user(db, div, role, name)
                auth(w.users[name])  # sessions minted now, not lazily from concurrent test threads
        w.train = w.create_train()
        w.journey = w.create_journey(staff=["jan"])
        w.create_banks()
        return w

    def create_train(self, **overrides) -> dict:
        body = dict(division_id=str(self.a.id), train_no=overrides.pop("train_no", "12001"), name="Shatabdi Test",
                    duration_days=1, operational_days=2, inspection_rounds_per_day=2, before_inspection_enabled=True,
                    after_inspection_enabled=True, daywise=False,
                    coaches=[{"code": "B1", "classification": "AC"}, {"code": "S1", "classification": "NON_AC"}])
        body.update(overrides)
        r = self.client.post("/api/v1/trains", headers=self.h("manager"), json=body)
        assert r.status_code == 201, r.text
        return r.json()

    def create_journey(self, staff=(), train=None, journey_date=None, **overrides) -> dict:
        train = train or self.train
        body = dict(division_id=str(self.a.id), train_id=train["id"], journey_date=str(journey_date or today_ist()),
                    supervisor_id=str(self.sup.id), staff_ids=[str(self.users[s].id) for s in staff])
        body.update(overrides)
        r = self.client.post("/api/v1/journeys", headers=self.h("manager"), json=body)
        assert r.status_code == 201, r.text
        return r.json()

    def create_banks(self) -> None:
        for audience in ("passenger", "railway"):
            r = self.client.post("/api/v1/feedback/question-banks", headers=self.h("admin"), json=dict(
                division_id=str(self.a.id), audience=audience, name=f"{audience} v1", scale_min=1, scale_max=5,
                questions=[dict(text_en="Toilet cleaning", applies_ac=True, applies_non_ac=True),
                           dict(text_en="Bedroll quality", applies_ac=True, applies_non_ac=False),
                           dict(text_en="Staff behaviour", applies_ac=True, applies_non_ac=True, required=False)]))
            assert r.status_code == 201, r.text
            bank = r.json()
            assert self.client.post(f"/api/v1/feedback/question-banks/{bank['id']}/activate", headers=self.h("admin")).status_code == 200
            setattr(self, f"{audience}_bank", bank)
