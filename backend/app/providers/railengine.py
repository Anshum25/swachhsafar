"""A train's coach composition, from RailEngine (the provider the ntes-rail tool's "coaches" page used).

    GET {base}/train/{number}/coaches      header x-api-key: RAIL_ENGINE_API_KEY
    -> {"status": "SUCCESS" | "STALE_DATA", "data": {"coaches": [{position, coachNumber, type, class, ...}]}, ...}

Used to fill a train's coaches automatically when an office sets it up (services/railway.py), since RailRadar
does not publish composition and inspections need every coach. Passenger coaches only: a guard/luggage van,
generator car, pantry or engine is not inspected for cleanliness, so it is left out. Without an API key the
provider is disabled and coaches are typed in by hand, as before.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

import httpx

from app.config import get_settings

DEFAULT_BASE_URL = "https://railway-engine.apkscope.workers.dev/v1"
TIMEOUT_SECONDS = 20.0
CACHE_SECONDS = 6 * 3600
TRAIN_NO_RE = re.compile(r"^[0-9A-Z]{3,6}$")

AC_CLASSES = {"1A", "2A", "3A", "3E", "CC", "EC", "EA", "EV", "VS", "AC"}
NON_AC_CLASSES = {"SL", "2S", "GN", "GEN", "GS", "UR", "FC", "II", "D"}
# Vehicles in a formation that are not passenger accommodation.
NOT_PASSENGER = re.compile(r"^(SLR|SLRD|LSLRD|EOG|PC|PCV|LR|LPR|VP|VPU|GRD|GUARD|ENG|LOCO|L|HCP|RMS|PWR|MLR)\d*$")
# Prefix of a coach number -> AC or not, when RailEngine gives no class (B1, A2, H1, C3, E1, M1 vs S4, D2, GN).
AC_PREFIX = re.compile(r"^(H|HA|A|B|M|C|E|EA|EV|ED|K)\d+$")
NON_AC_PREFIX = re.compile(r"^(S|D|GN|GS|UR|J|F)\d*$")


class RailEngineError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class Coach:
    code: str
    classification: str  # "AC" | "NON_AC"


class CoachProvider(Protocol):
    def coaches(self, train_no: str) -> list[Coach]: ...


def _norm(value) -> str:
    return re.sub(r"[^A-Z0-9 ]", "", str(value or "").upper()).strip()


def to_coaches(raw: list) -> list[Coach]:
    """RailEngine's formation -> the app's coaches, in formation order: passenger coaches only, codes
    made valid (A-Z, 0-9, space; at most 10) and unique (GN, GN2, GN3 ...)."""
    rows = sorted((r for r in raw if isinstance(r, dict)), key=lambda r: (r.get("position") is None, r.get("position") or 0))
    out: list[Coach] = []
    seen: dict[str, int] = {}
    for r in rows:
        code = _norm(r.get("coachNumber") or r.get("code") or r.get("type"))[:10].replace(" ", "")
        cls = _norm(r.get("class")).replace(" ", "")
        kind = _norm(r.get("type")).replace(" ", "")
        if not code or NOT_PASSENGER.match(code) or NOT_PASSENGER.match(kind):
            continue
        if cls in AC_CLASSES or (not cls and AC_PREFIX.match(code)):
            classification = "AC"
        elif cls in NON_AC_CLASSES or (not cls and NON_AC_PREFIX.match(code)):
            classification = "NON_AC"
        else:
            continue  # neither a known class nor a recognisable passenger coach
        n = seen.get(code, 0) + 1
        seen[code] = n
        unique = code if n == 1 else f"{code[:8]}{n}"
        out.append(Coach(unique, classification))
    return out


class RailEngineClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = TIMEOUT_SECONDS,
                 transport: httpx.BaseTransport | None = None, clock=time.monotonic):
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport,
                                    headers={"Accept": "application/json", "User-Agent": "SwachhSafar/2.0",
                                             "x-api-key": api_key})
        self._cache: dict[str, tuple[float, list[Coach]]] = {}
        self._lock = threading.Lock()
        self._clock = clock

    def coaches(self, train_no: str) -> list[Coach]:
        no = str(train_no or "").strip().upper()
        if not TRAIN_NO_RE.match(no):
            raise RailEngineError("config", f"{no!r} is not a train number")
        with self._lock:
            hit = self._cache.get(no)
            if hit and self._clock() - hit[0] < CACHE_SECONDS:
                return hit[1]
        try:
            r = self._client.get(f"/train/{no}/coaches")
        except httpx.TimeoutException as exc:
            raise RailEngineError("timeout", "RailEngine did not respond in time.") from exc
        except httpx.HTTPError as exc:
            raise RailEngineError("network", f"Could not reach RailEngine ({exc.__class__.__name__}).") from exc
        try:
            body = r.json()
        except ValueError:
            body = {}
        status = str(body.get("status") or "") if isinstance(body, dict) else ""
        if r.status_code == 404 or status in ("NOT_FOUND", "TRAIN_NOT_FOUND"):
            raise RailEngineError("not_found", f"RailEngine has no composition for train {no}.")
        if r.status_code >= 400 or status not in ("SUCCESS", "STALE_DATA"):
            err = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
            raise RailEngineError("http", f"RailEngine answered {r.status_code} {status or ''} {err.get('message') or ''}".strip())
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        coaches = to_coaches(data.get("coaches") if isinstance(data.get("coaches"), list) else [])
        with self._lock:
            self._cache[no] = (self._clock(), coaches)
        return coaches


class DisabledCoachProvider:
    def coaches(self, train_no: str) -> list[Coach]:
        raise RailEngineError("config", "Automatic coaches are not set up on this server (RAIL_ENGINE_API_KEY).")


@lru_cache
def get_coach_provider() -> CoachProvider:
    s = get_settings()
    if not s.rail_engine_api_key:
        return DisabledCoachProvider()
    return RailEngineClient(s.rail_engine_api_key.get_secret_value(), base_url=s.rail_engine_base_url)
