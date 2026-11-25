"""PNR status from RailRadar -- the JSON behind https://railradar.in/pnr (GET /app/v1/pnr/{pnr}).

Ported from the operator's pnrfetch tool (pnrdk.py): the same source, the same envelope checks and the same
error-code mapping, reduced to what PNR verification needs and returned as an `external.PnrResult`.

Use of RailRadar is under the operator's written permission from RailRadar (their Terms §9 forbid scraping
otherwise); the deployment names that permission in RAILRADAR_PNR_AUTHORIZATION, and without it this provider
refuses to run. Whatever the permission, the rules of the original tool apply:

- one lookup at a time, at least `min_interval` seconds apart, with an identifying User-Agent (http transport);
- no cookies, login, CAPTCHA or bot protection is worked around: a block (403/451, a challenge page) or a rate
  limit (429) is an outage -- ProviderUnavailable -- and the fallback provider (RapidAPI) answers instead;
- logs never carry the PNR.

Transports (RAILRADAR_PNR_TRANSPORT):

- "http" (default): requests the JSON endpoint directly with httpx. Light; no browser on the server.
- "browser": opens the public railradar.in/pnr page in headless Chromium (Playwright, optional dependency:
  `pip install .[pnr-browser]` and `python -m playwright install chromium`) and reads the PNR JSON the page
  itself receives -- the pnrfetch "portal" method. One long-lived browser per process, owned by one thread.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any, Callable

import httpx

from app.providers.external import (
    PnrPassenger,
    PnrResult,
    ProviderUnavailable,
    _coach_code,
    _int,
    _station,
    parse_pnr_date,
)

log = logging.getLogger(__name__)

PORTAL_URL = "https://railradar.in/pnr"
DATA_PATH = "/app/v1/pnr/"
USER_AGENT = "SwachhSafar/2.0 (+PNR verification for passenger feedback)"
PNR_RE = re.compile(r"^[0-9]{10}$")

# Error codes that are a definite answer about the PNR (not an outage): final, no fallback is asked.
NOT_FOUND_CODES = frozenset({"PRS:INVALID_PNR", "PRS:PNR_FLUSHED", "INVALID_PNR", "PNR_NOT_FOUND", "NOT_FOUND"})


# ---- parsing -----------------------------------------------------------------------------------------------


def _obj(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


_CODE_IN_PARENS = re.compile(r"\(([A-Z][A-Z0-9]{0,7})\)\s*$")


def _rr_station(value: Any) -> str | None:
    """RailRadar writes a station as {"code": "JBP", "name": "Jabalpur"}; a bare code or "Jabalpur (JBP)" is
    accepted too."""
    if isinstance(value, dict):
        return _station(value.get("code"))
    text = str(value or "").strip().upper()
    m = _CODE_IN_PARENS.search(text)
    return _station(m.group(1)) if m else _station(text)


def validate_source_response(payload: Any) -> dict:
    """The envelope {success: true, data: {...}} -> data (pnrdk.validate_source_response). A body that is not a
    PNR at all -- the format changed, or train-status data came back -- is an outage, never a rejected ticket."""
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ProviderUnavailable("RailRadar PNR response did not report success")
    data = payload.get("data")
    if not isinstance(data, dict) or not data:
        raise ProviderUnavailable("RailRadar PNR response has no data")
    if "trainNumber" in data and "pnrNumber" not in data:
        raise ProviderUnavailable("RailRadar returned train-status data, not PNR data")
    if data.get("passengers") is not None and not isinstance(data.get("passengers"), list):
        raise ProviderUnavailable("RailRadar PNR passenger list is malformed")
    if not _obj(data.get("train")).get("number") and not data.get("passengers"):
        raise ProviderUnavailable("RailRadar PNR response is not in the expected format")
    return data


def parse_railradar_pnr(payload: Any) -> PnrResult:
    """RailRadar's PNR JSON -> PnrResult. Shape (tests/fixtures/railradar_pnr.json):

        data: {pnrNumber, generatedAt, isWaitlisted, trainCancelStatus?,
               charting: {status: "Chart Prepared", isPrepared},
               train: {number, name, journeyDate "YYYY-MM-DD", journeyDateRaw, journeyClass,
                       source, destination, boardingPoint, reservationUpto: {code, name}},
               passengers: [{serialNumber, berthCode, coachPosition, isCancelled, isConfirmed, isRAC,
                             isWaitlisted, booking: {status, formatted, coachId, berthNo, berthCode, quota},
                             current: {status, formatted, coachId, berthNo, quota}}]}

    The current allocation is used, the booking one only where there is no current one. Only what is present
    is mapped; a missing field stays None."""
    data = validate_source_response(payload)
    train, charting = _obj(data.get("train")), _obj(data.get("charting"))
    passengers, coaches = [], set()
    for i, pax in enumerate(p for p in (data.get("passengers") or []) if isinstance(p, dict)):
        booking, current = _obj(pax.get("booking")), _obj(pax.get("current"))
        cur_coach, book_coach = _coach_code(current.get("coachId")), _coach_code(booking.get("coachId"))
        for c in (book_coach, cur_coach):
            if c:
                coaches.add(c)
        status = str(current.get("status") or booking.get("status") or "").strip().upper() or None
        if pax.get("isCancelled") is True and not (status or "").startswith("CAN"):
            status = "CAN"
        src = current if cur_coach else booking
        berth_code = pax.get("berthCode") or src.get("berthCode")  # passenger level in RailRadar's payload
        passengers.append(PnrPassenger(
            serial=_int(pax.get("serialNumber")) or i + 1, status=status, coach=cur_coach or book_coach,
            berth_no=_int(src.get("berthNo")),
            berth_code=str(berth_code or "").strip().upper()[:4] or None,
            status_text=(current.get("formatted") or booking.get("formatted") or None)))

    chart = str(charting.get("status") or "").strip()[:40] or None
    if chart is None and isinstance(charting.get("isPrepared"), bool):
        chart = "Chart Prepared" if charting["isPrepared"] else "Chart Not Prepared"
    cancel = str(data.get("trainCancelStatus") or "").upper()
    cls = str(train.get("journeyClass") or "").strip().upper()
    first = passengers[0] if passengers else None
    return PnrResult(
        found=True, train_number=str(train.get("number") or "").strip() or None,
        train_name=(str(train.get("name")).strip() or None) if train.get("name") else None,
        coach_ids=frozenset(coaches),
        status_text=(first.status_text or first.status) if first else None,
        journey_date=parse_pnr_date(train.get("journeyDate")) or parse_pnr_date(train.get("journeyDateRaw")),
        boarding_code=_rr_station(train.get("boardingPoint")), from_code=_rr_station(train.get("source")),
        to_code=_rr_station(train.get("destination")), upto_code=_rr_station(train.get("reservationUpto")),
        journey_class=cls[:4] or None, chart_status=chart,
        # a cancelled train stops the ticket; a partial cancellation (some stations) does not
        train_cancelled="CANCEL" in cancel and "PARTIAL" not in cancel,
        passengers=tuple(passengers))


def interpret(status: int, body: Any) -> PnrResult:
    """(HTTP status, JSON body) of the PNR endpoint -> PnrResult, or ProviderUnavailable for anything that is
    not a definite answer (pnrdk._exit_code_for, folded into found / not found / outage)."""
    if not isinstance(body, dict):
        log.warning("RailRadar PNR answered HTTP %s without a JSON object", status)
        raise ProviderUnavailable(f"RailRadar PNR returned HTTP {status} without JSON")
    if 200 <= status < 300 and body.get("success") is True:
        return parse_railradar_pnr(body)
    err = _obj(body.get("error"))
    code = str(err.get("code") or "").strip().upper()
    if code in NOT_FOUND_CODES:
        return PnrResult(found=False, status_text=code)
    log.warning("RailRadar PNR refused (HTTP %s, %s)", status, code or "no code")
    raise ProviderUnavailable(f"RailRadar PNR unavailable (HTTP {status}, {code or 'no code'})")


# ---- transports: (pnr) -> (HTTP status, parsed JSON or None) ------------------------------------------------


class HttpTransport:
    """GET {base}/app/v1/pnr/{pnr} with httpx; one request at a time, `min_interval` apart."""

    def __init__(self, base_url: str, timeout: float, *, min_interval: float = 2.0,
                 transport: httpx.BaseTransport | None = None, sleep=time.sleep, monotonic=time.monotonic) -> None:
        self._url = base_url.rstrip("/") + DATA_PATH
        self._client = httpx.Client(timeout=timeout, transport=transport, follow_redirects=True,
                                    headers={"User-Agent": USER_AGENT, "Accept": "application/json",
                                             "Accept-Language": "en"})
        self._min_interval, self._sleep, self._monotonic = min_interval, sleep, monotonic
        self._lock = threading.Lock()
        self._last = 0.0

    def __call__(self, pnr: str) -> tuple[int, Any]:
        with self._lock:
            wait = self._last + self._min_interval - self._monotonic()
            if self._last and wait > 0:
                self._sleep(wait)
            self._last = self._monotonic()
            try:
                resp = self._client.get(self._url + pnr)
            except httpx.HTTPError as exc:
                log.warning("RailRadar PNR unreachable (%s)", type(exc).__name__)
                raise ProviderUnavailable(f"RailRadar PNR unreachable: {type(exc).__name__}") from exc
        try:
            return resp.status_code, resp.json()
        except ValueError:
            return resp.status_code, None  # an HTML challenge page, a proxy error page ...


# Resources the PNR JSON does not depend on; skipping them roughly halves page time (pnrdk).
_BLOCK_TYPES = {"image", "font", "media", "stylesheet"}
_BLOCK_URL_PARTS = ("/timetable/pack", "google-analytics.com", "googletagmanager.com", "doubleclick.net")


def _playwright():
    try:
        from playwright.sync_api import Error as PWError
        from playwright.sync_api import TimeoutError as PWTimeout
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise ProviderUnavailable("RAILRADAR_PNR_TRANSPORT=browser needs Playwright (pip install .[pnr-browser])") from exc
    return sync_playwright, PWError, PWTimeout


class BrowserTransport:
    """The pnrfetch portal method: load railradar.in/pnr?pnr=... in headless Chromium (no cookies, no login) and
    take the PNR JSON the page itself receives. Playwright's sync API is bound to the thread that started it, so
    one worker thread owns the browser and lookups reach it through a queue; the context is reused (warm cache)
    and recycled every RECYCLE_AFTER lookups or after a browser failure."""

    RECYCLE_AFTER = 200

    def __init__(self, timeout: float, *, min_interval: float = 2.0, channel: str | None = None,
                 portal_url: str = PORTAL_URL) -> None:
        import queue

        self._timeout_ms = int(timeout * 1000) + 20_000  # page load + script + the PNR request
        self._min_interval, self._channel, self._portal = min_interval, channel or None, portal_url
        self._jobs: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def _ensure_started(self) -> None:
        with self._start_lock:
            if self._thread is None or not self._thread.is_alive():
                _playwright()  # fail fast, in the caller's thread, when Playwright is missing
                self._thread = threading.Thread(target=self._run, name="railradar-pnr-browser", daemon=True)
                self._thread.start()

    def __call__(self, pnr: str) -> tuple[int, Any]:
        self._ensure_started()
        fut: Future = Future()
        self._jobs.put((pnr, fut))
        try:
            return fut.result(timeout=self._timeout_ms / 1000 + 15)
        except FutureTimeout:
            fut.cancel()
            raise ProviderUnavailable("RailRadar PNR page took too long")

    def close(self) -> None:
        self._jobs.put(None)

    def _new_context(self, pw):
        browser = pw.chromium.launch(channel=self._channel, headless=True)
        context = browser.new_context()

        def route(r):
            req = r.request
            if req.resource_type in _BLOCK_TYPES or any(s in req.url for s in _BLOCK_URL_PARTS):
                return r.abort()
            return r.continue_()

        context.route("**/*", route)
        return browser, context

    def _lookup(self, context, pnr: str) -> tuple[int, Any]:
        page = context.new_page()
        try:
            with page.expect_response(
                    lambda r: r.request.method == "GET" and r.url.split("?")[0].endswith(DATA_PATH + pnr),
                    timeout=self._timeout_ms) as info:
                page.goto(f"{self._portal}?pnr={pnr}", wait_until="commit", timeout=self._timeout_ms)
            resp = info.value
            try:
                return resp.status, resp.json()
            except Exception:  # noqa: BLE001 - not JSON
                return resp.status, None
        finally:
            try:
                page.close()
            except Exception:  # noqa: BLE001
                pass

    def _run(self) -> None:
        sync_playwright, PWError, PWTimeout = _playwright()
        pw = sync_playwright().start()
        browser = context = None
        used, last = 0, 0.0

        def reset():
            nonlocal browser, context, used
            for obj in (context, browser):
                try:
                    if obj is not None:
                        obj.close()
                except Exception:  # noqa: BLE001
                    pass
            browser = context = None
            used = 0

        while True:
            job = self._jobs.get()
            if job is None:
                break
            pnr, fut = job
            if fut.cancelled():
                continue
            wait = last + self._min_interval - time.monotonic()
            if last and wait > 0:
                time.sleep(wait)
            last = time.monotonic()
            try:
                if context is None or used >= self.RECYCLE_AFTER or not browser.is_connected():
                    reset()
                    browser, context = self._new_context(pw)
                used += 1
                fut.set_result(self._lookup(context, pnr))
            except PWTimeout:
                log.warning("RailRadar PNR page timed out")
                if not fut.done():
                    fut.set_exception(ProviderUnavailable("RailRadar PNR page timed out"))
            except PWError as exc:
                log.warning("RailRadar PNR browser error: %s", str(exc).splitlines()[0][:200])
                reset()  # the browser is likely broken; relaunch on the next lookup
                if not fut.done():
                    fut.set_exception(ProviderUnavailable("Could not load the RailRadar PNR page"))
            except BaseException as exc:  # noqa: BLE001
                if not fut.done():
                    fut.set_exception(exc)
        reset()
        pw.stop()


# ---- provider ----------------------------------------------------------------------------------------------


class RailRadarPnrProvider:
    """external.PnrProvider backed by RailRadar. `fetch` is a transport: (pnr) -> (HTTP status, JSON)."""

    name = "railradar"

    def __init__(self, fetch: Callable[[str], tuple[int, Any]]) -> None:
        self._fetch = fetch

    def lookup(self, pnr: str) -> PnrResult:
        if not PNR_RE.match(pnr or ""):
            return PnrResult(found=False)
        status, body = self._fetch(pnr)
        return interpret(status, body)


def from_settings(s) -> RailRadarPnrProvider:
    if not (s.railradar_pnr_authorization or "").strip():
        raise RuntimeError("PNR_PROVIDER=railradar requires RAILRADAR_PNR_AUTHORIZATION (the reference of the "
                           "written permission from RailRadar)")
    if s.railradar_pnr_transport == "browser":
        fetch = BrowserTransport(s.external_timeout_seconds, min_interval=s.railradar_pnr_min_interval_seconds,
                                 channel=s.railradar_pnr_browser_channel,
                                 portal_url=s.railradar_base_url.rstrip("/") + "/pnr")
    else:
        fetch = HttpTransport(s.railradar_base_url, s.external_timeout_seconds,
                              min_interval=s.railradar_pnr_min_interval_seconds)
    return RailRadarPnrProvider(fetch)
