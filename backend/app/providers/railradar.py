"""RailRadar station timetables: which trains start at a station, when, and on which days.

Ported from the ntes-rail station-board tool (src/railradar/scraper.ts, departures.ts). RailRadar's station
page (https://railradar.in/station/{code}) is rendered by Next.js and embeds its data as JSON in the page's
`self.__next_f.push([1, "..."])` script chunks. We read `fullBoardData` from it -- the station's 24-hour
timetable, with each train's source, destination, run days and its stop here -- and keep the trains that
*start* at this station.

Use of RailRadar's pages is under the operator's written permission from RailRadar (their Terms §9 forbid
scraping otherwise). Whatever the permission, the same rules as the original tool apply:

- robots.txt is read (cached for a day) and obeyed; if it cannot be read, nothing is crawled;
- one request at a time, at least MIN_INTERVAL_SECONDS apart, with an identifying User-Agent;
- 403/451 and CAPTCHA/challenge pages stop with `blocked` and are never retried or worked around;
- 429 is reported with its Retry-After and not retried here;
- a page whose structure has changed fails with `parse` rather than returning an empty timetable.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

import httpx

from app.coach_codes import rake_class
from app.config import get_settings

BASE_URL = "https://railradar.in"
USER_AGENT = "SwachhSafar/2.0 (+station timetable for client setup; respects robots.txt)"
MIN_INTERVAL_SECONDS = 3.0
ROBOTS_TTL_SECONDS = 24 * 3600
TIMEOUT_SECONDS = 25.0
STATION_CODE_RE = re.compile(r"^[A-Z][A-Z0-9]{0,6}$")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")  # date.weekday() order
CHALLENGE_RE = re.compile(r"cf-chl|challenge-platform|captcha|Just a moment\.\.\.|Attention Required!", re.I)


class RailRadarError(Exception):
    """kind: config | disallowed | not_found | blocked | rate_limited | server | http | timeout | network | parse."""

    def __init__(self, kind: str, message: str, *, status: int | None = None, retry_after: int | None = None):
        super().__init__(message)
        self.kind, self.status, self.retry_after = kind, status, retry_after


@dataclass(frozen=True)
class OriginTrain:
    """A train that starts at the station."""

    train_no: str
    name: str | None
    type: str | None
    destination_code: str | None
    destination_name: str | None
    departure: str  # "HH:MM", India time
    departure_day: int | None
    run_days: tuple[str, ...] | None  # ("mon", ...) or None when RailRadar does not say

    def as_dict(self) -> dict:
        return dict(train_no=self.train_no, name=self.name, type=self.type, destination_code=self.destination_code,
                    destination_name=self.destination_name, departure=self.departure, departure_day=self.departure_day,
                    run_days=list(self.run_days) if self.run_days is not None else None)


@dataclass(frozen=True)
class StationTimetable:
    station_code: str
    station_name: str | None
    trains: tuple[OriginTrain, ...]


class TimetableProvider(Protocol):
    def timetable(self, code: str) -> StationTimetable: ...
    def composition(self, train_no: str) -> list["Coach"]: ...
    def train_run(self, train_no: str) -> "TrainRun": ...


# ---- a train's coaches -------------------------------------------------------------------------------------
#
# RailRadar's train-status page (https://railradar.in/train-status/{number}) embeds the train's rake as
# `"coachPosition":"ENG-SLRD-GEN-GEN-S7-...-S1-H1-A2-A1-B5-...-B1-M1-GEN-GEN-LPR"` in the same Next.js payload as
# the station pages -- the method the user's pnrfetch tool used, read from the page's HTML rather than a
# headless browser. Passenger coaches only, classed by app/coach_codes.py: engine, power car (LPR), generator
# (EOG), pantry, luggage and parcel vans are not inspected for cleanliness; SLR / SLRD carry general seating.

TRAIN_NO_RE = re.compile(r"^[0-9]{3,6}$")
_COACH_POSITION = re.compile(r'"coachPosition"\s*:\s*"([A-Z0-9 /-]{1,400})"')


@dataclass(frozen=True)
class Coach:
    code: str
    classification: str  # "AC" | "NON_AC" | "GEN"


def coaches_from_position(position: str) -> list[Coach]:
    """"ENG-SLRD-GEN-GEN-S7-...-B1-M1-GEN-GEN-LPR" -> passenger coaches in order; repeated codes numbered
    (GEN, GEN2, GEN3 ...) so every coach is told apart; codes at most 10 characters (A-Z, 0-9)."""
    out: list[Coach] = []
    seen: dict[str, int] = {}
    for part in re.split(r"[-/ ]+", position.upper()):
        code = re.sub(r"[^A-Z0-9]", "", part)[:10]
        if not code:
            continue
        classification = rake_class(code)  # app/coach_codes.py
        if classification is None:
            continue  # engine, vans, pantry, generator, or nothing recognisable
        n = seen.get(code, 0) + 1
        seen[code] = n
        out.append(Coach(code if n == 1 else f"{code[:8]}{n}", classification))
    return out


_HHMM = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


@dataclass(frozen=True)
class TrainRun:
    """A train's schedule from its train-status page (`initialSchedule`): when it leaves its first station,
    when it reaches its last (arrival_days after the day it left: 0 = the same day), the days it runs, the
    train that makes the return trip, and its passenger coaches."""
    train_no: str
    name: str | None
    origin_code: str | None
    destination_code: str | None
    destination_name: str | None
    departure: str | None      # "HH:MM"
    arrival: str | None        # "HH:MM"
    arrival_days: int
    run_days: tuple[str, ...] | None
    return_train_no: str | None
    coaches: tuple[Coach, ...]


def parse_train_run(html: str, train_no: str) -> TrainRun:
    """The schedule of a fetched train-status page. Raises RailRadarError(blocked | parse)."""
    payload = decode_flight_payload(html) or html
    sched = extract_json_after_key(payload, "initialSchedule")
    if not isinstance(sched, dict) or not isinstance(sched.get("train"), dict):
        if CHALLENGE_RE.search(html):
            raise RailRadarError("blocked", "RailRadar answered with a challenge/CAPTCHA page; it is not worked around.")
        raise RailRadarError("parse", f"No schedule on train {train_no}'s page.")
    train, route = sched["train"], sched.get("route") or []
    if str(train.get("number") or "") != train_no:
        raise RailRadarError("parse", f"Asked for train {train_no} but the page is for {train.get('number')!r}.")
    first = route[0] if route and isinstance(route[0], dict) else {}
    last = route[-1] if route and isinstance(route[-1], dict) else {}

    def hhmm(v):
        return v if isinstance(v, str) and _HHMM.match(v) else None

    def day(v):
        return v if isinstance(v, int) and 1 <= v <= 10 else 1

    days = train.get("runDays")
    run_days = tuple(d for d in WEEKDAYS if d in {str(x).strip().lower()[:3] for x in days}) \
        if isinstance(days, list) and days else None
    back = str(train.get("returnTrain") or "").strip()
    position = train.get("coachPosition")
    if not isinstance(position, str):
        m = _COACH_POSITION.search(payload)
        position = m.group(1) if m else ""
    src, dst = train.get("source") or {}, train.get("destination") or {}
    return TrainRun(
        train_no=train_no, name=(str(train["name"]).strip()[:100] or None) if train.get("name") else None,
        origin_code=normalize_code(src.get("code")) if src.get("code") else None,
        destination_code=normalize_code(dst.get("code")) if dst.get("code") else None,
        destination_name=(str(dst.get("name")).strip()[:120] or None) if dst.get("name") else None,
        departure=hhmm(first.get("departure")), arrival=hhmm(last.get("arrival")),
        arrival_days=max(day(last.get("arrivalDay")) - day(first.get("departureDay")), 0),
        run_days=run_days, return_train_no=back if TRAIN_NO_RE.match(back) and back != train_no else None,
        coaches=tuple(coaches_from_position(position)))


def parse_train_composition(html: str, train_no: str) -> list[Coach]:
    """The passenger coaches of a fetched train-status page. Raises RailRadarError(blocked | parse)."""
    payload = decode_flight_payload(html) or html
    m = _COACH_POSITION.search(payload)
    if not m:
        if CHALLENGE_RE.search(html):
            raise RailRadarError("blocked", "RailRadar answered with a challenge/CAPTCHA page; it is not worked around.")
        raise RailRadarError("parse", f"No coach composition on train {train_no}'s page.")
    return coaches_from_position(m.group(1))


def normalize_code(code: str) -> str:
    c = str(code or "").strip().upper()
    if not STATION_CODE_RE.match(c):
        raise RailRadarError("config", f"{str(code)[:20]!r} is not a valid station code")
    return c


# ---- robots.txt (RFC 9309) ---------------------------------------------------------------------------------


def parse_robots(body: str, agent_token: str = "swachhsafar") -> list[tuple[bool, str]]:
    """(allow, path) rules of the group for our own product token if present, else `*`."""
    groups: list[tuple[list[str], list[tuple[bool, str]]]] = []
    current = None
    last_was_agent = False
    for raw in body.splitlines():
        line = re.sub(r"#.*$", "", raw).strip()
        m = re.match(r"^([A-Za-z-]+)\s*:\s*(.*)$", line)
        if not m:
            continue
        field, value = m.group(1).lower(), m.group(2).strip()
        if field == "user-agent":
            if current is None or not last_was_agent:
                current = ([], [])
                groups.append(current)
            current[0].append(value.lower())
            last_was_agent = True
            continue
        last_was_agent = False
        if current is not None and field in ("allow", "disallow") and value:
            current[1].append((field == "allow", value))
    own = next((g for g in groups if any(a != "*" and a in agent_token for a in g[0])), None)
    star = next((g for g in groups if "*" in g[0]), None)
    return (own or star or ([], []))[1]


def _rule_matches(rule: str, path: str) -> bool:
    anchored = rule.endswith("$")
    body = rule[:-1] if anchored else rule
    pattern = ".*".join(re.escape(part) for part in body.split("*"))
    return re.match(f"^{pattern}{'$' if anchored else ''}", path) is not None


def is_path_allowed(rules: list[tuple[bool, str]], path: str) -> bool:
    """Longest matching rule wins; Allow wins a tie; no matching rule = allowed."""
    best: tuple[bool, str] | None = None
    for allow, rule in rules:
        if not _rule_matches(rule, path):
            continue
        if best is None or len(rule) > len(best[1]) or (len(rule) == len(best[1]) and allow):
            best = (allow, rule)
    return best[0] if best else True


# ---- page parsing ------------------------------------------------------------------------------------------

_CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')


def decode_flight_payload(html: str) -> str:
    """The concatenated, unescaped Next.js flight payload of a page ("" if none)."""
    out = []
    for m in _CHUNK_RE.finditer(html):
        try:
            out.append(json.loads(m.group(1)))
        except ValueError:
            continue  # a chunk that is not a valid string literal is skipped, not guessed at
    return "".join(out)


def extract_json_after_key(payload: str, key: str) -> Any:
    """The JSON object/array following the first `"key":`, parsed (string-aware bracket scan); None if absent."""
    at = payload.find(f'"{key}":')
    if at < 0:
        return None
    start = at + len(key) + 3
    while start < len(payload) and payload[start].isspace():
        start += 1
    if start >= len(payload) or payload[start] not in "{[":
        return None
    depth, in_string, i = 0, False, start
    while i < len(payload):
        ch = payload[i]
        if in_string:
            if ch == "\\":
                i += 1
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(payload[start:i + 1])
                except ValueError:
                    return None
        i += 1
    return None


def _text(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _ref(value: Any, names: dict[str, str]) -> tuple[str | None, str | None]:
    if isinstance(value, str):
        code = _text(value)
        code = code.upper() if code else None
        return code, names.get(code) if code else None
    if isinstance(value, dict):
        code = _text(value.get("code"))
        code = code.upper() if code else None
        return code, _text(value.get("name")) or (names.get(code) if code else None)
    return None, None


def _clock(value: Any) -> str | None:
    m = re.match(r"^(\d{1,2}):(\d{2})", _text(value) or "")
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def parse_station_timetable(html: str, code: str) -> StationTimetable:
    """The trains that start at `code`, from a fetched station page. Raises RailRadarError(blocked | parse)."""
    code = normalize_code(code)
    payload = decode_flight_payload(html)
    full = extract_json_after_key(payload, "fullBoardData")
    live = extract_json_after_key(payload, "initialLiveResponse")
    if not isinstance(full, dict) or not isinstance(full.get("trains"), list):
        if CHALLENGE_RE.search(html):
            raise RailRadarError("blocked", "RailRadar answered with a challenge/CAPTCHA page; it is not worked around.")
        raise RailRadarError("parse", "The station page no longer embeds its timetable (fullBoardData); "
                                      "RailRadar's page structure has changed." if payload else
                             "The response is not a RailRadar station page.")
    names: dict[str, str] = {}
    for entry in full["trains"]:
        train = entry.get("train") if isinstance(entry, dict) else None
        if isinstance(train, dict):
            for ref in (train.get("source"), train.get("destination")):
                if isinstance(ref, dict) and _text(ref.get("code")) and _text(ref.get("name")):
                    names.setdefault(_text(ref["code"]).upper(), _text(ref["name"]))
    station = (live or {}).get("station") if isinstance(live, dict) else None
    station = station if isinstance(station, dict) else (full.get("station") if isinstance(full.get("station"), dict) else {})
    page_code = (_text(station.get("code")) or "").upper()
    if page_code and page_code != code:
        raise RailRadarError("parse", f"Asked for station {code} but the page is for {page_code}.")

    trains: dict[str, OriginTrain] = {}
    for entry in full["trains"]:
        if not isinstance(entry, dict):
            continue
        train = entry.get("train") if isinstance(entry.get("train"), dict) else {}
        stop = entry.get("stop") if isinstance(entry.get("stop"), dict) else {}
        number = _text(train.get("number")) or (str(train["number"]) if isinstance(train.get("number"), int) else None)
        if not number or stop.get("isHalt") is False:
            continue
        origin, _ = _ref(train.get("source"), names)
        dest_code, dest_name = _ref(train.get("destination"), names)
        departure = _clock(stop.get("departure"))
        # Starts here: its source is this station, it leaves from here, and it does not also end here.
        if origin != code or not departure or dest_code == code:
            continue
        days = train.get("runDays")
        run_days = tuple(d for d in WEEKDAYS if d in {str(x).strip().lower()[:3] for x in days}) \
            if isinstance(days, list) and days else None
        dep_day = stop.get("departureDay")
        trains.setdefault(number, OriginTrain(
            train_no=number, name=_text(train.get("name")), type=_text(train.get("type")),
            destination_code=dest_code, destination_name=dest_name, departure=departure,
            departure_day=dep_day if isinstance(dep_day, int) else None, run_days=run_days))
    ordered = sorted(trains.values(), key=lambda t: (t.departure, t.train_no))
    return StationTimetable(code, _text(station.get("name")) or names.get(code), tuple(ordered))


# ---- polite client -----------------------------------------------------------------------------------------


class RailRadarClient:
    """One shared instance per process: the request spacing and the robots.txt cache are process-wide."""

    def __init__(self, base_url: str = BASE_URL, timeout: float = TIMEOUT_SECONDS,
                 min_interval: float = MIN_INTERVAL_SECONDS, transport: httpx.BaseTransport | None = None,
                 sleep=time.sleep, monotonic=time.monotonic):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout, transport=transport, follow_redirects=True,
                                    headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
        self._min_interval, self._sleep, self._monotonic = min_interval, sleep, monotonic
        self._lock = threading.Lock()
        self._last = 0.0
        self._robots: tuple[float, list[tuple[bool, str]]] | None = None

    def _train_page(self, train_no: str) -> tuple[str, str]:
        no = str(train_no or "").strip()
        if not TRAIN_NO_RE.match(no):
            raise RailRadarError("config", f"{no[:20]!r} is not a train number")
        path = f"/train-status/{no}"
        if not is_path_allowed(self._robots_rules(), path):
            raise RailRadarError("disallowed", f"robots.txt disallows {path}; not requesting it.")
        status, body, headers = self._get(self.base_url + path, "text/html")
        if status != 200:
            raise _classify(status, body, headers.get("retry-after"))
        return no, body

    def composition(self, train_no: str) -> list[Coach]:
        """A train's passenger coaches from its train-status page; the same politeness as timetables."""
        no, body = self._train_page(train_no)
        return parse_train_composition(body, no)

    def train_run(self, train_no: str) -> TrainRun:
        """A train's schedule, return train and coaches from its train-status page (one request)."""
        no, body = self._train_page(train_no)
        return parse_train_run(body, no)

    def timetable(self, code: str) -> StationTimetable:
        code = normalize_code(code)
        path = f"/station/{code.lower()}?hours=8"
        if not is_path_allowed(self._robots_rules(), path):
            raise RailRadarError("disallowed", f"robots.txt disallows {path}; not requesting it.")
        status, body, headers = self._get(self.base_url + path, "text/html")
        if status != 200:
            raise _classify(status, body, headers.get("retry-after"))
        return parse_station_timetable(body, code)

    def _robots_rules(self) -> list[tuple[bool, str]]:
        now = self._monotonic()
        if self._robots and now - self._robots[0] < ROBOTS_TTL_SECONDS:
            return self._robots[1]
        try:
            status, body, _ = self._get(self.base_url + "/robots.txt", "text/plain")
        except RailRadarError as exc:
            raise RailRadarError(exc.kind, f"Could not read robots.txt ({exc}); not crawling without it.") from exc
        if 200 <= status < 300:
            rules = parse_robots(body)
        elif 400 <= status < 500:
            rules = []
        else:
            raise RailRadarError("server", f"robots.txt answered HTTP {status}; not crawling without it.", status=status)
        self._robots = (now, rules)
        return rules

    def _get(self, url: str, accept: str) -> tuple[int, str, httpx.Headers]:
        with self._lock:
            wait = self._last + self._min_interval - self._monotonic()
            if self._last and wait > 0:
                self._sleep(wait)
            self._last = self._monotonic()
            try:
                r = self._client.get(url, headers={"Accept": accept})
            except httpx.TimeoutException as exc:
                raise RailRadarError("timeout", "RailRadar did not respond in time.") from exc
            except httpx.HTTPError as exc:
                raise RailRadarError("network", f"Could not reach RailRadar ({exc.__class__.__name__}).") from exc
            return r.status_code, r.text, r.headers


def _classify(status: int, body: str, retry_after: str | None) -> RailRadarError:
    if status == 404:
        return RailRadarError("not_found", "RailRadar has no page for this station.", status=status)
    if status in (403, 451) or CHALLENGE_RE.search(body or ""):
        return RailRadarError("blocked", f"RailRadar refused the request (HTTP {status}); not worked around.", status=status)
    if status == 429:
        seconds = int(retry_after) if retry_after and retry_after.strip().isdigit() else None
        return RailRadarError("rate_limited", "RailRadar is limiting requests; try again later.", status=status,
                              retry_after=seconds)
    if status >= 500:
        return RailRadarError("server", f"RailRadar had a server error (HTTP {status}).", status=status)
    return RailRadarError("http", f"RailRadar answered HTTP {status}.", status=status)


class DisabledTimetableProvider:
    def composition(self, train_no: str) -> list[Coach]:
        raise RailRadarError("config", "Train data is not enabled on this server (RAILRADAR_ENABLED).")

    def train_run(self, train_no: str) -> TrainRun:
        raise RailRadarError("config", "Train data is not enabled on this server (RAILRADAR_ENABLED).")

    def timetable(self, code: str) -> StationTimetable:
        raise RailRadarError("config", "Train timetables are not enabled on this server (RAILRADAR_ENABLED).")


@lru_cache
def get_timetable_provider() -> TimetableProvider:
    s = get_settings()
    if not s.railradar_enabled:
        return DisabledTimetableProvider()
    return RailRadarClient(base_url=s.railradar_base_url)
