"""Stored PNR answers (pnr_lookups): a PNR already fetched is answered from the database until its answer
expires, so verifying the same PNR again -- a retry, a second passenger on one ticket -- costs no provider call.

How long an answer is kept (settings PNR_CACHE_*):

- chart prepared, or train cancelled: the coach and berth are final -> until the end of the journey date plus
  PNR_CACHE_DAYS_AFTER_JOURNEY days (India time), and never less than the uncharted period;
- chart not prepared: waitlist / RAC can still move -> PNR_CACHE_UNCHARTED_MINUTES;
- PNR not found: PNR_CACHE_NOT_FOUND_MINUTES, so a typo or a PNR not yet visible is re-checked soon.

An outage (ProviderUnavailable) is never stored: the next attempt asks the provider again.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.feedback import PnrLookup
from app.providers.external import PnrProvider, PnrResult, pnr_result_from_dict, pnr_result_to_dict
from app.timeutil import utcnow

IST = ZoneInfo("Asia/Kolkata")


def expiry(result: PnrResult, now: datetime) -> datetime:
    s = get_settings()
    if not result.found:
        return now + timedelta(minutes=s.pnr_cache_not_found_minutes)
    short = now + timedelta(minutes=s.pnr_cache_uncharted_minutes)
    if (result.chart_prepared or result.train_cancelled) and result.journey_date:
        end = datetime.combine(result.journey_date + timedelta(days=s.pnr_cache_days_after_journey), time.max, IST)
        return max(end, short)
    return short


def lookup(db: Session, provider: PnrProvider, pnr: str, *, now: datetime | None = None) -> PnrResult:
    """The provider's answer for `pnr`, from pnr_lookups while it is fresh, else fetched and stored. Raises
    ProviderUnavailable (from the provider) when it has to fetch and cannot."""
    s = get_settings()
    if not s.pnr_cache_enabled:
        return provider.lookup(pnr)
    now = now or utcnow()
    row = db.get(PnrLookup, pnr)
    if row is not None and row.expires_at > now:
        row.hits = (row.hits or 0) + 1
        return pnr_result_from_dict(row.result)

    result = provider.lookup(pnr)  # ProviderUnavailable propagates: nothing is stored
    data, expires = pnr_result_to_dict(result), expiry(result, now)
    if row is not None:
        row.found, row.source, row.result, row.fetched_at, row.expires_at = (
            result.found, result.source, data, now, expires)
        return result
    try:
        with db.begin_nested():  # another request may store the same PNR at the same moment
            db.add(PnrLookup(pnr=pnr, found=result.found, source=result.source, result=data, fetched_at=now,
                             expires_at=expires, hits=0))
    except IntegrityError:
        pass  # the other request's answer is as good as ours
    return result


def forget(db: Session, pnr: str) -> bool:
    """Drops a stored answer (e.g. after a passenger's ticket changes); the next lookup asks the provider."""
    row = db.get(PnrLookup, pnr)
    if row is None:
        return False
    db.delete(row)
    return True


def purge_expired(db: Session, *, now: datetime | None = None) -> int:
    """Deletes answers that have expired; returns how many."""
    from sqlalchemy import delete

    res = db.execute(delete(PnrLookup).where(PnrLookup.expires_at <= (now or utcnow())))
    return res.rowcount or 0
