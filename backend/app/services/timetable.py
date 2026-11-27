"""Train timetables in both directions, read from RailRadar's train-status pages for the trains in Train Master.

For each train: its own page gives its stops in order, its run days, its return train and its coaches
(app/providers/railradar.py TrainRun). The return train is a train of its own in Train Master, and its
timetable is read from *its* page -- never made by reversing the outbound one, since stops, times and run
days differ between directions.

A reading is saved only when it validates (`validate_run`): at least an origin and a destination, the
origin leaving and the destination reached, stations in route order and the clock never running backwards
across days. An invalid reading is `rejected` and a page that cannot be read `failed`; either way the
timetable already stored stays as it was. A valid reading whose hash matches the stored one is `unchanged`
and writes nothing but the time it was checked. Every attempt is a `train_sync_runs` row.

Who calls it:
- an administrator, for one train (POST /trains/{id}/timetable/refresh) or a division (bulk);
- `python -m app.cli sync-timetables` (deploy/systemd/swachhsafar-sync-timetables.timer): trains never read,
  read longer ago than REFRESH_AFTER, or failed and past their retry delay (RETRY_DELAYS, by consecutive
  failures). Each train is committed on its own, so a run stopped half way (restart, crash) loses nothing
  and the next run carries on.

After a change, journeys that have not started are re-dated (services/railway) and their legs and future
feedback targets regenerated (services/feedback_plan). Journeys under way keep the route they are running.

RailRadar's pages are used under the operator's written permission from RailRadar; the client obeys
robots.txt, spaces requests, and stops on CAPTCHA/403/429 without working round them (providers/railradar).
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, object_session, selectinload

from app.models import Journey, JourneyStatus, Train, TrainCoach, TrainStop, TrainSyncRun
from app.providers.railradar import TRAIN_NO_RE, RailRadarError, TimetableProvider, TrainRun
from app.services import feedback_plan
from app.services.common import audit
from app.timeutil import today_ist, utcnow

log = logging.getLogger(__name__)

REFRESH_AFTER = timedelta(days=7)
RETRY_DELAYS = (timedelta(hours=1), timedelta(hours=6), timedelta(hours=24))  # 1st, 2nd, 3rd+ failure in a row
TRIGGERS = ("manual", "bulk", "scheduled", "retry", "setup")


# ---- validation --------------------------------------------------------------------------------------------


def _minutes(clock: str | None, day: int | None) -> int | None:
    if clock is None or day is None:
        return None
    h, m = clock.split(":")
    return (day - 1) * 1440 + int(h) * 60 + int(m)


def validate_run(run: TrainRun) -> list[str]:
    """What is wrong with a reading ([] = usable)."""
    problems: list[str] = []
    stops = run.stops
    if len(stops) < 2:
        return ["fewer than two stations on the route"]
    first, last = stops[0], stops[-1]
    if run.origin_code and first.code != run.origin_code:
        problems.append(f"the route starts at {first.code}, not at the train's origin {run.origin_code}")
    if run.destination_code and last.code != run.destination_code:
        problems.append(f"the route ends at {last.code}, not at the train's destination {run.destination_code}")
    if not first.departure or not first.departure_day:
        problems.append(f"no departure time at the origin {first.code}")
    if not last.arrival or not last.arrival_day:
        problems.append(f"no arrival time at the destination {last.code}")
    seqs = [s.seq for s in stops]
    if seqs != sorted(seqs) or len(set(seqs)) != len(seqs):
        problems.append("stations are not in route order")
    clock = None
    for s in stops:
        if s is not first and s is not last and not (s.arrival or s.departure):
            problems.append(f"no time at {s.code}")
            continue
        for t in (_minutes(s.arrival, s.arrival_day), _minutes(s.departure, s.departure_day)):
            if t is None:
                continue
            if clock is not None and t < clock:
                problems.append(f"the timetable runs backwards at {s.code}")
                break
            clock = t
    if first.departure_day and last.arrival_day and last.arrival_day - first.departure_day != run.arrival_days:
        problems.append("the arrival day does not match the last station's day")
    if run.run_days is not None and not run.run_days:
        problems.append("no running days")
    return problems


def schedule_hash(run: TrainRun) -> str:
    """What makes two readings the same timetable: its stops (code, times, days), run days, return train."""
    body = dict(stops=[(s.seq, s.code, s.arrival, s.arrival_day, s.departure, s.departure_day) for s in run.stops],
                run_days=list(run.run_days) if run.run_days is not None else None, back=run.return_train_no)
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _diff(train: Train, run: TrainRun) -> dict:
    old = [(s.station_code, s.arrival and s.arrival.strftime("%H:%M"), s.departure and s.departure.strftime("%H:%M"))
           for s in train.stops]
    new = [(s.code, s.arrival, s.departure) for s in run.stops]
    old_codes, new_codes = [c for c, *_ in old], [c for c, *_ in new]
    retimed = sorted({c for (c, a, d) in new if c in old_codes and (c, a, d) not in old})
    out = dict(
        stations_added=[c for c in new_codes if c not in old_codes],
        stations_removed=[c for c in old_codes if c not in new_codes],
        stations_retimed=retimed,
    )
    run_days = ",".join(run.run_days) if run.run_days else None
    if run_days != train.run_days:
        out["run_days"] = {"from": train.run_days, "to": run_days}
    if run.arrival_days != train.arrival_days:
        out["arrival_days"] = {"from": train.arrival_days, "to": run.arrival_days}
    back = run.return_train_no
    if back != train.return_train_no:
        out["return_train"] = {"from": train.return_train_no, "to": back}
    return {k: v for k, v in out.items() if v}


# ---- one train ---------------------------------------------------------------------------------------------


def _record(db: Session, train: Train, trigger: str, started: datetime, outcome: str, *, kind: str | None = None,
            message: str | None = None, changes: dict | None = None, actor_id: uuid.UUID | None = None) -> TrainSyncRun:
    run = TrainSyncRun(train_id=train.id, train_no=train.train_no, trigger=trigger, started_at=started,
                       finished_at=utcnow(), outcome=outcome, error_kind=kind, message=(message or None) and message[:300],
                       changes=changes or None, actor_id=actor_id)
    db.add(run)
    return run


def _fail(db: Session, train: Train, trigger: str, started: datetime, outcome: str, kind: str, message: str,
          actor_id) -> TrainSyncRun:
    train.schedule_status = outcome  # failed | rejected; the timetable already stored is kept
    train.schedule_checked_at = utcnow()
    train.schedule_error = message[:300]
    train.schedule_failures = (train.schedule_failures or 0) + 1
    log.info("timetable %s for train %s: %s (%s)", outcome, train.train_no, kind, message)
    return _record(db, train, trigger, started, outcome, kind=kind, message=message, actor_id=actor_id)


def _store(train: Train, run: TrainRun) -> None:
    from app.services.railway import _apply_run  # the schedule fields journeys are dated from

    _apply_run(train, run)
    # The old stops go first: the new ones reuse (train_id, seq), and a flush inserts before it deletes.
    if train.stops:
        train.stops.clear()
        session = object_session(train)
        if session is not None:
            session.flush()
    train.stops.extend([TrainStop(seq=s.seq, station_code=s.code, station_name=s.name,
                             arrival=time.fromisoformat(s.arrival) if s.arrival else None,
                             departure=time.fromisoformat(s.departure) if s.departure else None,
                             arrival_day=s.arrival_day, departure_day=s.departure_day, distance_km=s.distance_km,
                             platform=s.platform) for s in run.stops])
    train.distance_km = run.distance_km if run.distance_km is not None else (run.stops[-1].distance_km if run.stops else None)
    train.duration_minutes = run.duration_minutes
    if train.name.startswith(("Train ", "Return of ")) and run.name:
        train.name = run.name[:100]  # a placeholder name made before the page was read


def sync_train(db: Session, provider: TimetableProvider, train: Train, *, trigger: str = "manual",
               actor_id: uuid.UUID | None = None, follow_return: bool = True, done: set | None = None) -> TrainSyncRun:
    """Read one train's timetable (and, with follow_return, its return train's from that train's own page),
    validate, and store it if it changed. Flushes; the caller commits."""
    done = done if done is not None else set()
    done.add(train.id)
    started = utcnow()
    numbers = [n.strip() for n in train.train_no.split("/")]
    if len(numbers) != 1 or not TRAIN_NO_RE.match(numbers[0]):
        return _fail(db, train, trigger, started, "failed", "config",
                     f"{train.train_no} is not a single train number; give each direction its own train", actor_id)
    try:
        run = provider.train_run(numbers[0])
    except RailRadarError as exc:
        return _fail(db, train, trigger, started, "failed", exc.kind, str(exc), actor_id)
    problems = validate_run(run)
    if problems:
        return _fail(db, train, trigger, started, "rejected", "invalid", "; ".join(problems), actor_id)

    digest, old_hash = schedule_hash(run), train.schedule_hash
    changes = _diff(train, run) if digest != old_hash else {}
    if digest != old_hash:
        _store(train, run)
        train.schedule_hash = digest
    if not train.coaches and run.coaches:
        train.coaches = [TrainCoach(code=c.code, classification=c.classification, position=i)
                         for i, c in enumerate(run.coaches, 1)]
        changes["coaches_added"] = [c.code for c in run.coaches]
    now = utcnow()
    train.schedule_status, train.schedule_checked_at, train.schedule_synced_at = "ok", now, now
    train.schedule_error, train.schedule_failures = None, 0
    db.flush()
    if follow_return:
        _sync_return(db, provider, train, run, trigger=trigger, actor_id=actor_id, done=done)
    elif run.return_train_no:
        # Read as another train's return: link back to its partner when Train Master already has it.
        partner = db.scalar(select(Train).where(Train.division_id == train.division_id,
                                                Train.train_no == run.return_train_no))
        if partner is not None and train.return_train_id is None:
            train.return_train = partner
    outcome = "updated" if digest != old_hash or "coaches_added" in changes else "unchanged"
    return _record(db, train, trigger, started, outcome, changes=changes, actor_id=actor_id)


def _sync_return(db: Session, provider: TimetableProvider, train: Train, run: TrainRun, *, trigger: str,
                 actor_id, done: set) -> None:
    """The train that brings the rake back: kept as a train of the same division (made if missing, with the
    outbound rake until its own page says otherwise) and read from its own page."""
    if not run.return_train_no:
        train.return_train = None
        return
    back = db.scalar(select(Train).options(selectinload(Train.coaches), selectinload(Train.stops))
                     .where(Train.division_id == train.division_id, Train.train_no == run.return_train_no))
    if back is None:
        back = Train(division_id=train.division_id, train_no=run.return_train_no, name=f"Return of {train.train_no}",
                     duration_days=1, operational_days=1, inspection_rounds_per_day=1, before_inspection_enabled=True,
                     after_inspection_enabled=True, daywise=False, is_active=True, auto_journeys=False)
        db.add(back)
        db.flush()
    train.return_train = back
    if back.id not in done:
        sync_train(db, provider, back, trigger=trigger, actor_id=actor_id, follow_return=False, done=done)
    if not back.coaches and train.coaches:
        back.coaches = [TrainCoach(code=c.code, classification=c.classification, position=i)
                        for i, c in enumerate(train.coaches, 1)]
    db.flush()


def after_change(db: Session, train_ids, today: date | None = None) -> int:
    """Journeys of changed trains: planned ones not started are re-dated to the new schedule, and every
    journey not ended gets its legs (until it starts) and future targets regenerated. Returns the journeys
    changed. Does not commit."""
    from app.services.railway import _redate_unstarted
    from app.services.trains import refresh_journey_plans

    today = today or today_ist()
    ids = list(train_ids)
    if not ids:
        return 0
    trains = list(db.scalars(select(Train).options(selectinload(Train.return_train))
                             .where(or_(Train.id.in_(ids), Train.return_train_id.in_(ids)))))
    _redate_unstarted(db, trains, today)
    # The route itself may have moved (a diverted or re-timed train), so journeys take the stages the new
    # route gives: their attendance windows and closing times are built from it. refresh_journey_plans
    # leaves alone any journey where somebody has already marked attendance, so no record changes meaning.
    for train in trains:
        refresh_journey_plans(db, train)
    return feedback_plan.refresh_for_trains(db, [t.id for t in trains], today)


def sync_one(db: Session, provider: TimetableProvider, train: Train, *, trigger: str = "manual",
             actor_id: uuid.UUID | None = None, today: date | None = None) -> dict:
    """A train and its return train, committed; journeys follow when either changed."""
    done: set = set()
    before = {t.id: t.schedule_hash for t in (train, train.return_train) if t is not None}
    result = sync_train(db, provider, train, trigger=trigger, actor_id=actor_id, done=done)
    involved = [t for t in (train, train.return_train) if t is not None]
    changed = [t.id for t in involved if t.schedule_hash != before.get(t.id)]
    journeys = after_change(db, changed, today) if changed else 0
    if actor_id is not None:
        audit(db, actor_id=actor_id, action="train.timetable.refresh", entity=train, division_id=train.division_id,
              changes={"outcome": result.outcome, "trains_changed": [str(i) for i in changed], "journeys_updated": journeys})
    db.commit()
    return dict(outcome=result.outcome, message=result.message, changed=len(changed), journeys_updated=journeys)


# ---- many trains -------------------------------------------------------------------------------------------


def _next_try(train: Train) -> datetime | None:
    if train.schedule_checked_at is None or train.schedule_status not in ("failed", "rejected"):
        return None
    delay = RETRY_DELAYS[min(max(train.schedule_failures, 1), len(RETRY_DELAYS)) - 1]
    return train.schedule_checked_at + delay


def due_trains(db: Session, *, now: datetime | None = None, division_ids=None, include_fresh: bool = False,
               failed_only: bool = False, limit: int | None = None) -> list[Train]:
    """Active Train Master trains whose timetable is due: never read, older than REFRESH_AFTER, or failed and
    past its retry delay. Return trains are trains too and are included. Oldest first."""
    now = now or utcnow()
    stmt = (select(Train).options(selectinload(Train.stops), selectinload(Train.coaches), selectinload(Train.return_train))
            .where(Train.is_active))
    if division_ids is not None:
        stmt = stmt.where(Train.division_id.in_(list(division_ids)))
    out = []
    for t in db.scalars(stmt.order_by(Train.schedule_checked_at.is_not(None), Train.schedule_checked_at, Train.train_no)):
        retry_at = _next_try(t)
        if failed_only:
            if retry_at is not None and (include_fresh or retry_at <= now):
                out.append(t)
            continue
        if include_fresh:
            out.append(t)
        elif retry_at is not None:
            if retry_at <= now:
                out.append(t)
        elif t.schedule_synced_at is None or now - t.schedule_synced_at >= REFRESH_AFTER:
            out.append(t)
    return out[:limit] if limit else out


def sync_many(db: Session, provider: TimetableProvider, trains: list[Train], *, trigger: str,
              actor_id: uuid.UUID | None = None, today: date | None = None) -> dict:
    """Each train (and its return train) read and committed on its own: one failure never undoes another
    train's success, and a run cut short keeps what it finished. A train already read as another's return
    in this run is not read twice. RailRadar stopping us (blocked / rate limited / robots) ends the run."""
    today = today or today_ist()
    tally = dict(updated=0, unchanged=0, failed=0, rejected=0, journeys_updated=0, stopped=None)
    done: set = set()
    for train in trains:
        if train.id in done:
            continue
        before = {t.id: t.schedule_hash for t in (train, train.return_train) if t is not None}
        try:
            result = sync_train(db, provider, train, trigger=trigger, actor_id=actor_id, done=done)
            involved = [t for t in (train, train.return_train) if t is not None]
            changed = [t.id for t in involved if t.schedule_hash != before.get(t.id)]
            if changed:
                tally["journeys_updated"] += after_change(db, changed, today)
            db.commit()
        except Exception:  # noqa: BLE001 -- one train's unexpected error must not lose the others
            db.rollback()
            log.exception("timetable sync of train %s failed unexpectedly", train.train_no)
            tally["failed"] += 1
            continue
        tally[result.outcome] = tally.get(result.outcome, 0) + 1
        if result.outcome == "failed" and result.error_kind in ("blocked", "rate_limited", "disallowed"):
            tally["stopped"] = result.error_kind
            break
    return tally


_bulk_lock = threading.Lock()


def run_bulk(division_ids, *, trigger: str, actor_id: uuid.UUID | None, provider: TimetableProvider,
             include_fresh: bool = True) -> dict | None:
    """A bulk refresh in its own session (a background task, or the CLI). One at a time per process: None
    when another is already running."""
    from app.db import get_sessionmaker, write_intent

    if not _bulk_lock.acquire(blocking=False):
        return None
    try:
        with write_intent(), get_sessionmaker()() as db:
            trains = due_trains(db, division_ids=division_ids, include_fresh=include_fresh)
            tally = sync_many(db, provider, trains, trigger=trigger, actor_id=actor_id)
            tally["trains"] = len(trains)
            return tally
    finally:
        _bulk_lock.release()


def bulk_running() -> bool:
    return _bulk_lock.locked()


# ---- reading -----------------------------------------------------------------------------------------------


def stops_out(train: Train | None) -> list[dict]:
    if train is None:
        return []
    return [dict(seq=s.seq, code=s.station_code, name=s.station_name,
                 arrival=s.arrival.strftime("%H:%M") if s.arrival else None, arrival_day=s.arrival_day,
                 departure=s.departure.strftime("%H:%M") if s.departure else None, departure_day=s.departure_day,
                 day=s.day, halt_minutes=s.halt_minutes, distance_km=s.distance_km, platform=s.platform)
            for s in train.stops]


def direction_out(train: Train | None, direction: int) -> dict | None:
    if train is None:
        return None
    stops = train.stops
    return dict(
        direction=direction, train_id=train.id, train_no=train.train_no, train_name=train.name,
        origin_code=stops[0].station_code if stops else train.origin_code,
        origin_name=stops[0].station_name if stops else None,
        destination_code=stops[-1].station_code if stops else train.destination_code,
        destination_name=stops[-1].station_name if stops else train.destination_name,
        departure=train.start_time.strftime("%H:%M") if train.start_time else None,
        arrival=train.end_time.strftime("%H:%M") if train.end_time else None,
        arrival_days=train.arrival_days, journey_days=(train.arrival_days + 1) if train.arrival_days is not None else None,
        run_days=train.run_days.split(",") if train.run_days else None, distance_km=train.distance_km,
        duration_minutes=train.duration_minutes, schedule_status=train.schedule_status,
        schedule_synced_at=train.schedule_synced_at, schedule_checked_at=train.schedule_checked_at,
        schedule_error=train.schedule_error, stops=stops_out(train))


def timetable_out(db: Session, train: Train, runs: int = 10) -> dict:
    """Both directions of a train: its own timetable and its return train's, as each was read."""
    back = train.return_train
    recent = list(db.scalars(select(TrainSyncRun).where(TrainSyncRun.train_id.in_([t.id for t in (train, back) if t]))
                             .order_by(TrainSyncRun.started_at.desc()).limit(runs)))
    return dict(train_id=train.id, train_no=train.train_no, outbound=direction_out(train, 1),
                inbound=direction_out(back, 2), runs=recent, bulk_running=bulk_running())


def upcoming_journeys(db: Session, train: Train, today: date) -> int:
    return len(list(db.scalars(select(Journey.id).where(
        or_(Journey.train_id == train.id, Journey.linked_train_id == train.id),
        Journey.status == JourneyStatus.PLANNED, Journey.end_date >= today))))


# How recently a train's timetable must have been checked for the attendance screen to leave it alone. The
# screen asks on every open, and RailRadar is rate limited (and stops on CAPTCHA/403/429), so a crew of ten
# opening the same journey must not become ten reads of the same page.
JOURNEY_REFRESH_AFTER = timedelta(minutes=30)


def refresh_for_journey(db: Session, provider: TimetableProvider, j: Journey, *,
                        now: datetime | None = None, today: date | None = None) -> dict:
    """Bring one journey's train up to date when the attendance screen opens, so a route that changed under
    the crew is noticed before they try to mark attendance against the old one.

    Throttled by JOURNEY_REFRESH_AFTER and skipped once the journey has ended -- its route is history by
    then. Never raises: a timetable that cannot be read leaves the journey exactly as it was and reports
    `checked: False`, because failing to reach RailRadar must not stop anybody marking attendance.
    """
    now = now or utcnow()
    train = j.train
    skip = (None if train is None else
            "ended" if j.status == JourneyStatus.CANCELLED or (j.end_date and j.end_date < (today or today_ist()))
            else "fresh" if train.schedule_checked_at and now - train.schedule_checked_at < JOURNEY_REFRESH_AFTER
            else None)
    if train is None or skip:
        return dict(checked=False, reason=skip or "no_train", changed=0, journeys_updated=0)
    try:
        result = sync_one(db, provider, train, trigger="scheduled", today=today)
    except Exception:                                    # noqa: BLE001 - reported, never raised at the crew
        log.exception("journey route refresh failed for train %s", train.train_no)
        db.rollback()
        return dict(checked=False, reason="unavailable", changed=0, journeys_updated=0)
    return dict(checked=True, reason=None, **{k: result[k] for k in ("changed", "journeys_updated")},
                outcome=result["outcome"])
