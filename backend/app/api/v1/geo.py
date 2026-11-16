"""Coordinates -> a street address, for the stamp on attendance and inspection photos.

The phone never calls the geocoding service itself: the key stays on the server, and staff coordinates are
not handed to a third party by every device in the field. An address is a convenience, never evidence --
the record keeps the coordinates, and a lookup that fails just means no address is shown.
"""

import time
from threading import Lock

from fastapi import APIRouter, Depends, Query

from app.providers.external import GeocodeProvider, ProviderUnavailable, get_geocode_provider
from app.schemas.common import StrictModel
from app.security.principal import Principal, get_principal

router = APIRouter(prefix="/geo", tags=["geo"])

# Coordinates rounded to 4 decimals (~11 m) share one answer: a shift of staff photographed at the same
# platform is a single lookup. Entries last an hour; the cache is per process and is lost on restart.
_PRECISION = 4
_TTL_SECONDS = 3600
_MAX_ENTRIES = 5000
_cache: dict[tuple[float, float], tuple[float, str | None]] = {}
_lock = Lock()


class ReverseOut(StrictModel):
    address: str | None
    source: str  # "lookup" | "cache" | "disabled" | "unavailable"


def _key(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, _PRECISION), round(lon, _PRECISION)


@router.get("/reverse", response_model=ReverseOut)
def reverse(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
            p: Principal = Depends(get_principal),
            provider: GeocodeProvider = Depends(get_geocode_provider)) -> ReverseOut:
    key = _key(lat, lon)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _TTL_SECONDS:
            return ReverseOut(address=hit[1], source="cache")
    if not getattr(provider, "enabled", True):
        return ReverseOut(address=None, source="disabled")
    try:
        address = provider.reverse(*key)
    except ProviderUnavailable:
        # Not an error the user can act on: the photo is stamped with its coordinates instead.
        return ReverseOut(address=None, source="unavailable")
    with _lock:
        if len(_cache) >= _MAX_ENTRIES:
            _cache.clear()
        _cache[key] = (now, address)
    return ReverseOut(address=address, source="lookup")
