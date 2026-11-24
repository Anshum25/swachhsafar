"""Client setup from the railway network, and journeys planned from it.

1. The Super Admin sets a client's state and city (clients.state / clients.city).
2. The client's Admin (or the Super Admin) picks that city's stations and, for each, the trains that start
   there (RailRadar's timetable, cached in railway_boards). `save_setup` turns each station into one of the
   client's divisions and each train into one of that division's trains, marked auto_journeys.
3. `plan_journeys`, every day: a journey for every auto_journeys train on each of the next PLAN_DAYS days it
   runs, paid for (at the office's rate) the moment it is created, like any journey. When the wallet cannot
   cover one it is not created, and is tried again on the next run. Planned journeys have no supervisor
   until somebody assigns one. Cancelling one before it departs gives the credit back.
4. `charge_due_journeys`: pays for any planned journey left unpaid by the earlier rule (charged on the start
   day), or cancels it if the wallet cannot.

`python -m app.cli plan-journeys` runs 3 and 4 (deploy/systemd/swachhsafar-plan-journeys.timer).
"""

import re
import uuid
from datetime import date, time, timedelta

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.errors import BusinessRuleViolation, Forbidden, NotFound, PaymentRequired, ServiceUnavailable
from app.models import (
    Client,
    ClientStatus,
    Division,
    DivisionKind,
    Journey,
    JourneyCoach,
    JourneyStatus,
    RailwayBoard,
    RailwayStation,
    RoleId,
    Train,
    TrainCoach,
)
from app.providers.railradar import RailRadarError, TimetableProvider, WEEKDAYS
from app.security.principal import Principal
from app.services.clients import charge_journey
from app.services.common import audit, get_or_404
from app.services.journeys import derive_dates
from app.timeutil import utcnow

PLAN_DAYS = 3
BOARD_MAX_AGE = timedelta(hours=12)


# ---- the station list --------------------------------------------------------------------------------------


def list_states(db: Session) -> list[str]:
    return [s for s in db.scalars(select(distinct(RailwayStation.state)).where(RailwayStation.state != "")
                                  .order_by(RailwayStation.state))]


def list_cities(db: Session, state: str) -> list[str]:
    cities = set(db.scalars(select(distinct(RailwayStation.city)).where(RailwayStation.state == state,
                                                                       RailwayStation.city != "")))
    cities |= set(db.scalars(select(distinct(RailwayStation.metro)).where(RailwayStation.state == state,
                                                                         RailwayStation.metro.is_not(None))))
    return sorted(cities, key=str.casefold)


def stations_in(db: Session, state: str, city: str) -> list[RailwayStation]:
    """A city's stations, its metro grouping included (Ahmedabad lists Sabarmati, Maninagar, ...)."""
    return list(db.scalars(select(RailwayStation).where(
        or_(and_(RailwayStation.state == state, RailwayStation.city == city), RailwayStation.metro == city))
        .order_by(RailwayStation.name)))


# ---- who may set a client up -------------------------------------------------------------------------------


def _home_client_id(db: Session, p: Principal) -> uuid.UUID | None:
    return db.scalar(select(Division.client_id).where(Division.id == p.user.division_id))


def require_setup_access(db: Session, p: Principal, client: Client) -> None:
    """The Super Admin, or the client's own Admin -- nobody else picks an office's stations and trains."""
    if p.is_super_admin:
        return
    if p.role == RoleId.ADMIN and _home_client_id(db, p) == client.id:
        return
    raise Forbidden("Only the Super Admin or this office's Admin can set up its stations and trains",
                    code="permission_denied")


def _client_area(client: Client) -> tuple[str, str]:
    if not client.state or not client.city:
        raise BusinessRuleViolation("The Super Admin has not set this office's state and city yet",
                                    code="client_area_missing")
    return client.state, client.city


# ---- a station's trains (RailRadar, cached) ----------------------------------------------------------------


def station_trains(db: Session, provider: TimetableProvider, code: str, *, refresh: bool = False) -> dict:
    """The trains that start at `code`. Served from railway_boards when it is fresh enough; a failed refresh
    falls back on what was cached (flagged stale) rather than leaving the wizard empty."""
    code = code.strip().upper()
    station = db.get(RailwayStation, code)
    if station is None:
        raise NotFound("Unknown station")
    board = db.get(RailwayBoard, code)
    now = utcnow()
    if board is not None and not refresh and now - board.fetched_at < BOARD_MAX_AGE:
        return _board_out(station, board, stale=False)
    try:
        t = provider.timetable(code)
    except RailRadarError as exc:
        if board is not None:
            return _board_out(station, board, stale=True)
        raise ServiceUnavailable(f"Could not read the trains of {code}: {exc}", code=f"railradar_{exc.kind}") from exc
    if board is None:
        board = RailwayBoard(station_code=code)
        db.add(board)
    board.fetched_at, board.station_name, board.trains = now, t.station_name, [tr.as_dict() for tr in t.trains]
    db.commit()
    return _board_out(station, board, stale=False)


def _board_out(station: RailwayStation, board: RailwayBoard, *, stale: bool) -> dict:
    return dict(station_code=station.code, station_name=board.station_name or station.name,
                fetched_at=board.fetched_at, stale=stale, trains=board.trains)


# ---- setup -------------------------------------------------------------------------------------------------


def get_setup(db: Session, p: Principal, client_id: uuid.UUID) -> dict:
    client = get_or_404(db, Client, client_id, "Client")
    require_setup_access(db, p, client)
    divisions = {d.station_code: d for d in db.scalars(
        select(Division).where(Division.client_id == client.id, Division.station_code.is_not(None)))}
    trains = {}
    if divisions:
        for t in db.scalars(select(Train).where(Train.division_id.in_([d.id for d in divisions.values()]),
                                                Train.auto_journeys)):
            trains.setdefault(t.division_id, []).append(t.train_no)
    stations = stations_in(db, client.state, client.city) if client.state and client.city else []
    return dict(
        client_id=client.id, state=client.state, city=client.city, setup_completed_at=client.setup_completed_at,
        stations=[dict(code=s.code, name=s.name, city=s.city,
                       division_id=divisions[s.code].id if s.code in divisions else None,
                       selected=s.code in divisions and bool(trains.get(divisions[s.code].id)),
                       train_nos=sorted(trains.get(divisions[s.code].id, [])) if s.code in divisions else [])
                  for s in stations],
    )


def _division_code(db: Session, client: Client, station: str) -> str:
    base = re.sub(r"[^A-Z0-9]", "", client.office_id.upper())[:8] or "C"
    for n in range(100):
        code = f"{base if n == 0 else base[:6] + str(n)}_{station}"[:16]
        if db.scalar(select(Division.id).where(Division.code == code)) is None:
            return code
    raise BusinessRuleViolation("Could not find a free division code")


def _train_name(t: dict) -> str:
    name = (t.get("name") or "").strip()
    return name if len(name) >= 2 else f"Train {t['train_no']}"


def save_setup(db: Session, p: Principal, client_id: uuid.UUID, body, provider: TimetableProvider,
               *, today: date) -> dict:
    """body.stations: [{code, trains: [{train_no, coaches: [{code, classification}]}]}]. A station listed
    becomes (or stays) one of the client's divisions; its listed trains are planned, the rest of its
    previously planned trains stop being planned. Stations not listed keep their division and history, but
    none of their trains is planned any more. Nothing is deleted."""
    client = get_or_404(db, Client, client_id, "Client")
    require_setup_access(db, p, client)
    state, city = _client_area(client)
    allowed = {s.code: s for s in stations_in(db, state, city)}
    chosen = {s.code.strip().upper(): s for s in body.stations}
    unknown = sorted(set(chosen) - set(allowed))
    if unknown:
        raise BusinessRuleViolation(f"Not stations of {city}: {', '.join(unknown)}", code="station_outside_city",
                                    details={"codes": unknown})

    # Every station's timetable is read and every pick checked before anything is written: reading a
    # timetable may commit its cache row, and a setup must not be left half-applied by a later refusal.
    boards = {}
    for code, pick in chosen.items():
        boards[code] = {t["train_no"]: t for t in station_trains(db, provider, code)["trains"]}
        missing = sorted({t.train_no for t in pick.trains} - set(boards[code]))
        if missing:
            raise BusinessRuleViolation(f"Trains that do not start at {code}: {', '.join(missing)}",
                                        code="train_not_at_station", details={"station": code, "train_nos": missing})

    created_divisions, planned = 0, []
    for code, pick in chosen.items():
        board = boards[code]
        division = db.scalar(select(Division).where(Division.client_id == client.id, Division.station_code == code))
        if division is None:
            station = allowed[code]
            division = Division(code=_division_code(db, client, code), name=station.name.title(),
                                client_id=client.id, kind=DivisionKind.STATION, station_code=code)
            db.add(division)
            db.flush()
            created_divisions += 1
        wanted = {t.train_no: t for t in pick.trains}
        for existing in db.scalars(select(Train).where(Train.division_id == division.id, Train.auto_journeys)):
            if existing.train_no not in wanted:
                existing.auto_journeys = False
        for no, choice in wanted.items():
            info = board[no]
            train = db.scalar(select(Train).options(selectinload(Train.coaches))
                              .where(Train.division_id == division.id, Train.train_no == no))
            if train is None:
                train = Train(division_id=division.id, train_no=no, name=_train_name(info), duration_days=1,
                              operational_days=1, inspection_rounds_per_day=1, before_inspection_enabled=True,
                              after_inspection_enabled=True, daywise=False, is_active=True)
                db.add(train)
            train.name = _train_name(info)
            train.start_time = time.fromisoformat(info["departure"])
            train.origin_code, train.destination_code = code, info.get("destination_code")
            train.destination_name = info.get("destination_name")
            train.run_days = ",".join(info["run_days"]) if info.get("run_days") else None
            train.auto_journeys, train.is_active = True, True
            if choice.coaches:
                train.coaches = [TrainCoach(code=c.code, classification=c.classification, position=i)
                                 for i, c in enumerate(choice.coaches, 1)]
            planned.append(no)
    # Stations dropped from the setup: keep them, stop planning their trains.
    for division in db.scalars(select(Division).where(Division.client_id == client.id,
                                                      Division.station_code.is_not(None),
                                                      Division.station_code.not_in(list(chosen) or [""]))):
        for train in db.scalars(select(Train).where(Train.division_id == division.id, Train.auto_journeys)):
            train.auto_journeys = False

    client.setup_completed_at = client.setup_completed_at or utcnow()
    audit(db, actor_id=p.id, action="client.railway_setup", entity=client, division_id=None,
          changes={"stations": {c: [t.train_no for t in s.trains] for c, s in chosen.items()}})
    db.commit()
    result = plan_journeys(db, today=today, client_id=client.id)
    return dict(divisions_created=created_divisions, trains_planned=len(planned), journeys_created=result["created"],
                journeys_skipped=result["skipped"])


# ---- the daily planner -------------------------------------------------------------------------------------


def runs_on(train: Train, day: date) -> bool:
    return not train.run_days or WEEKDAYS[day.weekday()] in train.run_days.split(",")


def plan_journeys(db: Session, *, today: date, client_id: uuid.UUID | None = None, days: int = PLAN_DAYS) -> dict:
    """A journey for every planned train on each of the next `days` days it runs, if it has none yet -- and,
    like a journey somebody creates, paid for the moment it is created (services/clients.charge_journey).

    Each journey and its charge are one savepoint: when the wallet cannot cover it, that journey is not
    created and nothing is charged; it is tried again on the next run (the timer runs daily), so it appears
    once credits are added. Idempotent: run it as often as you like (uq_journeys_auto_train_date backs that
    up). Returns {"created": n, "skipped": n} -- skipped for want of credits."""
    stmt = (select(Train).options(selectinload(Train.coaches)).join(Division, Division.id == Train.division_id)
            .join(Client, Client.id == Division.client_id)
            .where(Train.auto_journeys, Train.is_active, Division.is_active, Client.status == ClientStatus.ACTIVE))
    if client_id is not None:
        stmt = stmt.where(Client.id == client_id)
    trains = list(db.scalars(stmt))
    if not trains:
        return dict(created=0, skipped=0)
    window = [today + timedelta(days=i) for i in range(days)]
    have = set(db.execute(select(Journey.train_id, Journey.journey_date).where(
        Journey.train_id.in_([t.id for t in trains]), Journey.journey_date.in_(window), Journey.auto_created)).all())
    created = skipped = 0
    # Earliest days first across all trains, so a short wallet pays for the journeys that leave soonest.
    for day in window:
        for train in trains:
            if (train.id, day) in have or not runs_on(train, day):
                continue
            linked, end = derive_dates(day, train.duration_days)
            j = Journey(
                division_id=train.division_id, train_id=train.id, journey_date=day, linked_journey_date=linked,
                end_date=end, start_time=train.start_time, end_time=train.end_time,
                return_start_time=train.return_start_time, return_end_time=train.return_end_time,
                duration_days=train.duration_days, operational_days=train.operational_days, daywise=train.daywise,
                inspection_rounds_per_day=train.inspection_rounds_per_day,
                before_inspection_enabled=train.before_inspection_enabled,
                after_inspection_enabled=train.after_inspection_enabled,
                supervisor_id=None, created_by_id=None, status=JourneyStatus.PLANNED, auto_created=True,
                charged=True,
                coaches=[JourneyCoach(code=c.code, classification=c.classification, position=c.position)
                         for c in train.coaches])
            try:
                with db.begin_nested():
                    db.add(j)
                    db.flush()
                    credits = charge_journey(db, j.division_id, j.id)
                audit(db, actor_id=None, action="journey.plan", entity=j, division_id=j.division_id,
                      changes={"train_no": train.train_no, "journey_date": str(day), "credits_charged": credits})
                created += 1
            except PaymentRequired:
                skipped += 1  # the savepoint rolled the journey back; it is tried again on the next run
    db.commit()
    return dict(created=created, skipped=skipped)


def charge_due_journeys(db: Session, *, today: date) -> dict:
    """Pay for any planned journey still unpaid -- one planned before journeys were paid for when created
    (the start-day rule) -- once it starts: one at a time, each in its own savepoint, so one office's empty
    wallet cannot stop another's. One the wallet cannot cover, or whose office is suspended, is cancelled
    with the reason and costs nothing. New planned journeys are paid when created and never reach this."""
    due = list(db.scalars(select(Journey).where(Journey.auto_created, Journey.charged.is_(False),
                                                Journey.status == JourneyStatus.PLANNED,
                                                Journey.journey_date <= today)
                          .order_by(Journey.journey_date, Journey.id)))
    charged = cancelled = 0
    for j in due:
        try:
            with db.begin_nested():
                credits = charge_journey(db, j.division_id, j.id)
                j.charged = True
            audit(db, actor_id=None, action="journey.charge", entity=j, division_id=j.division_id,
                  changes={"credits_charged": credits, "on": str(today)})
            charged += 1
        except PaymentRequired as exc:
            j.status = JourneyStatus.CANCELLED
            j.cancelled_at = utcnow()
            j.cancelled_by_id = None
            j.cancel_reason = ("Office suspended on the start day" if exc.code == "client_suspended"
                               else "Not enough credits on the start day")[:300]
            j.version += 1
            audit(db, actor_id=None, action="journey.cancel", entity=j, division_id=j.division_id,
                  changes={"reason": j.cancel_reason, "auto": True})
            cancelled += 1
    db.commit()
    return dict(charged=charged, cancelled=cancelled)


def planned_counts(db: Session, client_id: uuid.UUID, today: date) -> dict:
    """For the setup screen: planned journeys ahead, and how many still need a supervisor."""
    base = (select(func.count()).select_from(Journey).join(Division, Division.id == Journey.division_id)
            .where(Division.client_id == client_id, Journey.auto_created, Journey.journey_date >= today,
                   Journey.status == JourneyStatus.PLANNED))
    return dict(planned=db.scalar(base) or 0,
                without_supervisor=db.scalar(base.where(Journey.supervisor_id.is_(None))) or 0)
