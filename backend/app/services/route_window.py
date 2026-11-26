"""Where along its route an attendance may be taken, and whether a GPS fix is there.

An attendance station's window runs from its own station to its "valid until" station
(services/trains.valid_until_choices). It is stored with the journey's stage as a path of the route stations
in between: [[latitude, longitude, km from the first point], ...], so the phone can check a fix offline
(src/utils/routeWindow.js does the same sums; tests/fixtures/route_window_cases.json holds the two together).

A fix is inside the window when it is within `tolerance_km` (plus its own accuracy) of that path. The tolerance
also reaches past both ends, which gives the platform before departure and the approach to the last station.
Station locations come from app/data/station_locations.json (DataMeet, ODbL). A station without a location is
left out of the path; when the opening or closing station has none, the nearest located station beyond it is
used instead, so the window is never shorter than the stretch the office chose.
"""
import json
import math
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data" / "station_locations.json"
EARTH_KM = 6371.0
MAX_ACCURACY_KM = 1.0  # a worse fix is refused by the location policy anyway; never let it widen the window more


@lru_cache(maxsize=1)
def _locations() -> dict[str, tuple[float, float]]:
    try:
        raw = json.loads(DATA.read_text(encoding="utf-8"))["locations"]
    except (OSError, ValueError, KeyError):
        return {}
    return {code: (lat, lon) for code, (lat, lon) in raw.items()}


def location_of(code: str | None) -> tuple[float, float] | None:
    return _locations().get(code or "")


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    rad = math.pi / 180
    dp, dl = (b[0] - a[0]) * rad, (b[1] - a[1]) * rad
    h = math.sin(dp / 2) ** 2 + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def build_window(route: list[dict], start: int, end: int) -> dict | None:
    """The window over route[start..end] (indexes, inclusive). None when no station in it has a location."""
    if not route or not 0 <= start <= end < len(route):
        return None
    lo, hi = start, end
    while lo > 0 and location_of(route[lo]["code"]) is None:
        lo -= 1
    while hi < len(route) - 1 and location_of(route[hi]["code"]) is None:
        hi += 1
    points = [location_of(r["code"]) for r in route[lo:hi + 1]]
    points = [p for p in points if p is not None]
    if not points:
        return None
    path, along = [], 0.0
    for i, p in enumerate(points):
        if i:
            along += _km(points[i - 1], p)
        path.append([p[0], p[1], round(along, 2)])
    return {"path": path, "from_code": route[lo]["code"], "to_code": route[hi]["code"]}


def _nearest_on_segment(p, a, b) -> tuple[float, float]:
    """(distance km, t) from p to segment a-b, in a local flat projection around p (fine over a few km)."""
    rad = math.pi / 180
    kx = EARTH_KM * rad * math.cos(p[0] * rad)
    ky = EARTH_KM * rad
    ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky
    bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy), t


def check(window: dict | None, latitude: float, longitude: float, accuracy_m: float | None,
          tolerance_km: float) -> dict:
    """{"status": inside | before | after | off_route | unknown, "off_route_km", "along_km"}.
    before/after: nearest to the window's first/last station; off_route: beside the window, too far from it."""
    path = (window or {}).get("path") or []
    if not path:
        return {"status": "unknown", "off_route_km": None, "along_km": None}
    p = (latitude, longitude)
    limit = tolerance_km + min(max(accuracy_m or 0.0, 0.0) / 1000, MAX_ACCURACY_KM)
    if len(path) == 1:
        d = _km(p, (path[0][0], path[0][1]))
        status = "inside" if d <= limit else "off_route"
        return {"status": status, "off_route_km": round(d, 2), "along_km": 0.0}
    best = None
    for i in range(len(path) - 1):
        a, b = path[i], path[i + 1]
        d, t = _nearest_on_segment(p, a, b)
        if best is None or d < best[0]:
            best = (d, t, i)
    d, t, i = best
    along = path[i][2] + t * (path[i + 1][2] - path[i][2])
    if d <= limit:
        status = "inside"
    elif i == 0 and t == 0.0:
        status = "before"
    elif i == len(path) - 2 and t == 1.0:
        status = "after"
    else:
        status = "off_route"
    return {"status": status, "off_route_km": round(d, 2), "along_km": round(along, 1)}
