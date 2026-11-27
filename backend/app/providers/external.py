"""External PNR and SMS providers. Credentials come only from environment configuration."""

import logging
import re
import time
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from functools import lru_cache
from typing import Protocol

import httpx

from app.config import get_settings


class ProviderUnavailable(Exception):
    """The provider could not give an answer (disabled, network, 5xx). The record stays pending."""


@dataclass(frozen=True)
class PnrPassenger:
    """One passenger line of a PNR. Coach and berth are the current allocation when the provider gives one
    (after charting), else the booking's. The provider returns no passenger names."""
    serial: int
    status: str | None          # CNF, RAC, WL, CAN ... (current, else booking)
    coach: str | None
    berth_no: int | None
    berth_code: str | None      # LB, MB, UB, SL, SU, WS ...
    status_text: str | None     # e.g. "CNF/B4/33/LB"

    @property
    def berth(self) -> str | None:
        if self.berth_no is None:
            return None
        return f"{self.berth_no} {self.berth_code}".strip() if self.berth_code else str(self.berth_no)

    @property
    def cancelled(self) -> bool:
        return (self.status or "").upper().startswith("CAN")

    @property
    def waitlisted(self) -> bool:
        s = (self.status or "").upper()
        return s.startswith(("WL", "GNWL", "RLWL", "PQWL", "TQWL", "RSWL", "RQWL", "CKWL")) and not self.coach


@dataclass(frozen=True)
class PnrResult:
    found: bool
    train_number: str | None = None
    train_name: str | None = None
    coach_ids: frozenset[str] = field(default_factory=frozenset)
    status_text: str | None = None
    # ---- fields read when the provider returns them (each may be missing; nothing is filled in) ----
    journey_date: date | None = None            # date of journey at the boarding station
    boarding_code: str | None = None            # boarding point
    from_code: str | None = None                # source station of the ticket
    to_code: str | None = None                  # destination station of the ticket
    upto_code: str | None = None                # reservation up to (usually = to_code)
    journey_class: str | None = None            # 1A, 2A, 3A, SL, CC, 2S ...
    chart_status: str | None = None
    train_cancelled: bool = False
    passengers: tuple[PnrPassenger, ...] = ()
    source: str | None = None                   # which provider answered: "railradar", "rapidapi"

    @property
    def chart_prepared(self) -> bool:
        s = (self.chart_status or "").lower()
        return "prepared" in s and "not" not in s

    @property
    def alighting_code(self) -> str | None:
        return self.upto_code or self.to_code

    @property
    def all_cancelled(self) -> bool:
        return bool(self.passengers) and all(p.cancelled for p in self.passengers)

    @property
    def all_waitlisted(self) -> bool:
        live = [p for p in self.passengers if not p.cancelled]
        return bool(live) and all(p.waitlisted for p in live)


_PNR_DATE_FORMATS = ("%b %d, %Y %I:%M:%S %p", "%b %d, %Y", "%d-%m-%Y", "%Y-%m-%d", "%d-%b-%Y", "%d/%m/%Y")


def parse_pnr_date(value) -> date | None:
    """The provider writes dates like "Nov 25, 2026 10:05:00 AM"; a few other shapes are accepted. An
    unreadable date is None, not a guess."""
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in _PNR_DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _station(value) -> str | None:
    code = str(value or "").strip().upper()
    return code if re.match(r"^[A-Z][A-Z0-9]{0,7}$", code) else None


def _coach_code(value) -> str | None:
    code = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    return code[:10] if code and code not in ("0", "NA", "NONE") else None


def _int(value) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def parse_rapidapi_pnr(body: dict) -> PnrResult:
    """The response of RapidAPI's "IRCTC Indian Railway PNR Status" (getPNRStatus/{pnr}): {"success": bool,
    "data": {pnrNumber, dateOfJourney, trainNumber, trainName, sourceStation, destinationStation,
    reservationUpto, boardingPoint, journeyClass, numberOfpassenger, chartStatus, trainCancelledFlag,
    passengerList: [{passengerSerialNumber, bookingStatus, bookingCoachId, bookingBerthNo, bookingBerthCode,
    currentStatus, currentCoachId, currentBerthNo, currentBerthCode, currentStatusDetails}]}}. Only what is
    present is mapped; a missing field stays None."""
    body = body or {}
    if body.get("success") is False:  # "FLUSHED PNR / PNR NOT YET GENERATED", invalid PNR ...
        return PnrResult(found=False, status_text=(str(body.get("message") or "").strip()[:120] or None))
    data = body.get("data") or {}
    if not isinstance(data, dict):
        return PnrResult(found=False)
    plist = [p for p in (data.get("passengerList") or []) if isinstance(p, dict)] \
        if isinstance(data.get("passengerList"), list) else []
    if not plist:
        return PnrResult(found=False)
    passengers, coaches = [], set()
    for i, pax in enumerate(p for p in plist if isinstance(p, dict)):
        current = _coach_code(pax.get("currentCoachId"))
        booking = _coach_code(pax.get("bookingCoachId"))
        for c in (booking, current):
            if c:
                coaches.add(c)
        status = str(pax.get("currentStatus") or pax.get("bookingStatus") or "").strip().upper() or None
        use_current = bool(current)
        passengers.append(PnrPassenger(
            serial=_int(pax.get("passengerSerialNumber")) or i + 1, status=status, coach=current or booking,
            berth_no=_int(pax.get("currentBerthNo") if use_current else pax.get("bookingBerthNo")),
            berth_code=(str(pax.get("currentBerthCode" if use_current else "bookingBerthCode") or "").strip().upper() or None),
            status_text=(pax.get("currentStatusDetails") or pax.get("bookingStatusDetails") or None)))
    first = plist[0] if isinstance(plist[0], dict) else {}
    cls = str(data.get("journeyClass") or "").strip().upper()
    return PnrResult(
        found=True, train_number=str(data.get("trainNumber") or "").strip() or None,
        train_name=(str(data.get("trainName")).strip() or None) if data.get("trainName") else None,
        coach_ids=frozenset(coaches),
        status_text=first.get("currentStatusDetails") or first.get("currentStatus"),
        journey_date=parse_pnr_date(data.get("dateOfJourney")),
        boarding_code=_station(data.get("boardingPoint")), from_code=_station(data.get("sourceStation")),
        to_code=_station(data.get("destinationStation")), upto_code=_station(data.get("reservationUpto")),
        journey_class=cls[:4] or None, chart_status=(str(data.get("chartStatus") or "").strip()[:40] or None),
        train_cancelled=data.get("trainCancelledFlag") is True, passengers=tuple(passengers))


def pnr_result_to_dict(r: PnrResult) -> dict:
    """A PnrResult as JSON (the pnr_lookups cache). Round-trips with pnr_result_from_dict."""
    return {
        "found": r.found, "train_number": r.train_number, "train_name": r.train_name,
        "coach_ids": sorted(r.coach_ids), "status_text": r.status_text,
        "journey_date": r.journey_date.isoformat() if r.journey_date else None,
        "boarding_code": r.boarding_code, "from_code": r.from_code, "to_code": r.to_code, "upto_code": r.upto_code,
        "journey_class": r.journey_class, "chart_status": r.chart_status, "train_cancelled": r.train_cancelled,
        "passengers": [dict(serial=x.serial, status=x.status, coach=x.coach, berth_no=x.berth_no,
                            berth_code=x.berth_code, status_text=x.status_text) for x in r.passengers],
        "source": r.source,
    }


def pnr_result_from_dict(d: dict) -> PnrResult:
    d = d or {}
    return PnrResult(
        found=bool(d.get("found")), train_number=d.get("train_number"), train_name=d.get("train_name"),
        coach_ids=frozenset(d.get("coach_ids") or ()), status_text=d.get("status_text"),
        journey_date=date.fromisoformat(d["journey_date"]) if d.get("journey_date") else None,
        boarding_code=d.get("boarding_code"), from_code=d.get("from_code"), to_code=d.get("to_code"),
        upto_code=d.get("upto_code"), journey_class=d.get("journey_class"), chart_status=d.get("chart_status"),
        train_cancelled=bool(d.get("train_cancelled")),
        passengers=tuple(PnrPassenger(serial=x.get("serial") or i + 1, status=x.get("status"), coach=x.get("coach"),
                                      berth_no=x.get("berth_no"), berth_code=x.get("berth_code"),
                                      status_text=x.get("status_text"))
                         for i, x in enumerate(d.get("passengers") or []) if isinstance(x, dict)),
        source=d.get("source"),
    )


class PnrProvider(Protocol):
    def lookup(self, pnr: str) -> PnrResult: ...


class SmsProvider(Protocol):
    """send_* return the gateway's message/request id ("accepted by the gateway" — not proof of handset
    delivery) and raise ProviderUnavailable when the gateway is not configured, unreachable or refuses."""

    name: str
    enabled: bool

    def send_otp(self, mobile: str, code: str) -> str | None: ...
    def send_login_otp(self, mobile: str, code: str) -> str | None: ...


class SmsRejected(ProviderUnavailable):
    """The gateway answered but refused the message (bad key, template, sender, number...)."""

    def __init__(self, message: str, category: str) -> None:
        super().__init__(message)
        self.category = category


class DisabledPnrProvider:
    def lookup(self, pnr: str) -> PnrResult:
        raise ProviderUnavailable("PNR verification is not configured")


class DisabledSmsProvider:
    name, enabled = "disabled", False

    def send_otp(self, mobile: str, code: str) -> None:
        raise ProviderUnavailable("SMS delivery is not configured")

    def send_login_otp(self, mobile: str, code: str) -> None:
        raise ProviderUnavailable("SMS delivery is not configured")


log = logging.getLogger(__name__)


class RapidApiPnrProvider:
    """IRCTC PNR status via RapidAPI (parse_rapidapi_pnr). The key stays on the server: it is sent only as the
    x-rapidapi-key header to the configured host, never returned to a client or logged.

    A network error or a 5xx is retried once after a short pause (bounded: at most `retries` extra calls),
    a 429 is not retried (the quota is spent; retrying only spends it faster). Logs name the failure, never
    the PNR or anything about the passenger."""

    name = "rapidapi"

    def __init__(self, url: str, host: str, key: str, timeout: float, *, retries: int = 1, backoff: float = 0.8,
                 sleep=time.sleep) -> None:
        self._url, self._host, self._key, self._timeout = url.rstrip("/") + "/", host, key, timeout
        self._retries, self._backoff, self._sleep = max(retries, 0), backoff, sleep

    def lookup(self, pnr: str) -> PnrResult:
        if not re.match(r"^[0-9]{10}$", pnr or ""):
            return PnrResult(found=False)
        attempt = 0
        while True:
            try:
                resp = httpx.get(self._url + pnr, timeout=self._timeout,
                                 headers={"x-rapidapi-key": self._key, "x-rapidapi-host": self._host})
            except httpx.HTTPError as exc:
                if attempt < self._retries:
                    attempt += 1
                    self._sleep(self._backoff * attempt)
                    continue
                log.warning("PNR provider unreachable (%s)", type(exc).__name__)
                raise ProviderUnavailable(f"PNR provider unreachable: {type(exc).__name__}") from exc
            if resp.status_code >= 500 and attempt < self._retries:
                attempt += 1
                self._sleep(self._backoff * attempt)
                continue
            break
        if resp.status_code >= 500 or resp.status_code == 429:
            log.warning("PNR provider answered HTTP %s", resp.status_code)
            raise ProviderUnavailable(f"PNR provider returned {resp.status_code}")
        if resp.status_code in (401, 403):
            try:  # RapidAPI says why: "You are not subscribed to this API.", "Invalid API key." ...
                why = str((resp.json() or {}).get("message") or "")[:120]
            except (ValueError, AttributeError):
                why = ""
            log.error("PNR provider refused the API key (HTTP %s%s): check PNR_API_KEY and that its RapidAPI "
                      "account is subscribed to %s", resp.status_code, f", {why}" if why else "", self._host)
            raise ProviderUnavailable(f"PNR provider refused the request ({resp.status_code}{', ' + why if why else ''})")
        if resp.status_code >= 400:
            return PnrResult(found=False)
        try:
            body = resp.json() or {}
        except ValueError as exc:
            log.warning("PNR provider returned a body that is not JSON")
            raise ProviderUnavailable("PNR provider returned invalid JSON") from exc
        return parse_rapidapi_pnr(body if isinstance(body, dict) else {})


class FallbackPnrProvider:
    """Asks `primary` (RailRadar) first; only when it cannot answer -- ProviderUnavailable: down, blocked, rate
    limited, format changed -- is `fallback` (RapidAPI) asked. A definite answer from the primary, "PNR not
    found" included, is final. The result records which provider answered (PnrResult.source)."""

    def __init__(self, primary: PnrProvider, fallback: PnrProvider | None) -> None:
        self.primary, self.fallback = primary, fallback

    def lookup(self, pnr: str) -> PnrResult:
        try:
            return replace(self.primary.lookup(pnr), source=getattr(self.primary, "name", None))
        except ProviderUnavailable as first:
            if self.fallback is None:
                raise
            log.warning("PNR primary provider unavailable (%s); asking the fallback", first)
            try:
                return replace(self.fallback.lookup(pnr), source=getattr(self.fallback, "name", None))
            except ProviderUnavailable as second:
                raise ProviderUnavailable(f"{first}; fallback: {second}") from second


class HttpSmsProvider:
    """Generic JSON-over-HTTPS SMS gateway adapter: POST {to, message, sender, template_id} with a bearer key.
    Adapt the payload to the contracted DLT-registered gateway before production use."""

    name, enabled = "http", True

    def __init__(self, url: str, key: str, sender: str | None, template_id: str | None, timeout: float,
                 login_template_id: str | None = None) -> None:
        self._url, self._key, self._sender, self._template, self._timeout = url, key, sender, template_id, timeout
        self._login_template = login_template_id or template_id

    def send_otp(self, mobile: str, code: str) -> str | None:
        return self._send(mobile, f"{code} is your Swachh Safar feedback verification code.", self._template)

    def send_login_otp(self, mobile: str, code: str) -> str | None:
        return self._send(mobile, f"{code} is your Swachh Safar sign-in code. It expires in 5 minutes. Do not share it.",
                   self._login_template)

    def _send(self, mobile: str, message: str, template: str | None) -> str | None:
        payload = {"to": f"91{mobile}", "message": message, "sender": self._sender, "template_id": template}
        try:
            resp = httpx.post(self._url, json=payload, timeout=self._timeout, headers={"Authorization": f"Bearer {self._key}"})
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"SMS gateway unreachable: {type(exc).__name__}") from exc
        if resp.status_code >= 300:
            raise SmsRejected(f"SMS gateway returned {resp.status_code}", "gateway_http_error")
        try:
            body = resp.json()
        except ValueError:
            return None
        return str(body.get("message_id") or body.get("id") or body.get("request_id") or "") or None


class Msg91SmsProvider:
    """MSG91 Flow API (https://docs.msg91.com): POST https://control.msg91.com/api/v5/flow with header
    `authkey`, body {template_id, short_url, recipients: [{mobiles: "91XXXXXXXXXX", <var>: value}]}.
    The template (and its DLT template id, sender id and entity id) is set up in the MSG91 panel; the OTP is
    passed as the template variable named by SMS_OTP_VARIABLE (default "otp"). Success: {"type": "success",
    "message": "<request id>"}; anything else is a refusal."""

    name, enabled = "msg91", True
    URL = "https://control.msg91.com/api/v5/flow"

    def __init__(self, authkey: str, login_template_id: str, feedback_template_id: str | None, timeout: float,
                 otp_variable: str = "otp", url: str | None = None) -> None:
        self._key, self._login, self._feedback, self._timeout = authkey, login_template_id, feedback_template_id, timeout
        self._var, self._url = otp_variable, url or self.URL

    def send_login_otp(self, mobile: str, code: str) -> str | None:
        return self._send(mobile, code, self._login)

    def send_otp(self, mobile: str, code: str) -> str | None:
        return self._send(mobile, code, self._feedback or self._login)

    def _send(self, mobile: str, code: str, template: str) -> str | None:
        payload = {"template_id": template, "short_url": "0", "recipients": [{"mobiles": f"91{mobile}", self._var: code}]}
        try:
            resp = httpx.post(self._url, json=payload, timeout=self._timeout,
                              headers={"authkey": self._key, "accept": "application/json", "content-type": "application/json"})
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"MSG91 unreachable: {type(exc).__name__}") from exc
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if resp.status_code >= 300 or body.get("type") != "success":
            detail = str(body.get("message") or resp.status_code)[:120]
            category = "auth" if resp.status_code in (401, 403) or "auth" in detail.lower() else "rejected"
            raise SmsRejected(f"MSG91 refused the message: {detail}", category)
        return str(body.get("message") or "") or None


def _rapidapi_from_settings(s) -> RapidApiPnrProvider | None:
    if not (s.pnr_api_url and s.pnr_api_host and s.pnr_api_key):
        return None
    return RapidApiPnrProvider(s.pnr_api_url, s.pnr_api_host, s.pnr_api_key.get_secret_value(), s.external_timeout_seconds)


@lru_cache
def get_pnr_provider() -> PnrProvider:
    """PNR_PROVIDER=railradar: RailRadar (app/providers/railradar_pnr.py) first, RapidAPI as the fallback when
    PNR_API_* are set. PNR_PROVIDER=rapidapi: RapidAPI only. disabled: feedback stays pending, never a guess."""
    s = get_settings()
    if s.pnr_provider == "railradar":
        from app.providers import railradar_pnr

        fallback = _rapidapi_from_settings(s)
        if fallback is None:
            log.warning("PNR_PROVIDER=railradar without PNR_API_KEY: no RapidAPI fallback")
        if not (s.railradar_pnr_authorization or "").strip():
            if fallback is not None:
                # RailRadar is never asked without the permission reference; RapidAPI alone still verifies
                log.error("PNR_PROVIDER=railradar without RAILRADAR_PNR_AUTHORIZATION: using RapidAPI only")
                return FallbackPnrProvider(fallback, None)
            railradar_pnr.from_settings(s)  # raises the configuration error
        return FallbackPnrProvider(railradar_pnr.from_settings(s), fallback)
    if s.pnr_provider == "rapidapi":
        provider = _rapidapi_from_settings(s)
        if provider is None:
            raise RuntimeError("PNR_PROVIDER=rapidapi requires PNR_API_URL, PNR_API_HOST and PNR_API_KEY")
        return FallbackPnrProvider(provider, None)  # no fallback; stamps PnrResult.source
    return DisabledPnrProvider()


@lru_cache
def get_sms_provider() -> SmsProvider:
    s = get_settings()
    if s.sms_provider == "msg91":
        if not (s.sms_api_key and s.sms_login_template_id):
            raise RuntimeError("SMS_PROVIDER=msg91 requires SMS_API_KEY (MSG91 authkey) and SMS_LOGIN_TEMPLATE_ID")
        return Msg91SmsProvider(s.sms_api_key.get_secret_value(), s.sms_login_template_id, s.sms_template_id,
                                s.external_timeout_seconds, s.sms_otp_variable, s.sms_api_url)
    if s.sms_provider == "http":
        if not (s.sms_api_url and s.sms_api_key):
            raise RuntimeError("SMS_PROVIDER=http requires SMS_API_URL and SMS_API_KEY")
        return HttpSmsProvider(s.sms_api_url, s.sms_api_key.get_secret_value(), s.sms_sender_id, s.sms_template_id,
                               s.external_timeout_seconds, s.sms_login_template_id)
    return DisabledSmsProvider()


# ---- network risk ----------------------------------------------------------------------------------------
@dataclass(frozen=True)
class NetworkRisk:
    """`vpn`: True/False when the provider gave an answer, None when it could not (disabled, unreachable).
    Only as good as the provider's data: residential VPNs and private relays are often not listed."""

    vpn: bool | None
    source: str
    detail: str | None = None


class VpnProvider(Protocol):
    def check(self, ip: str) -> NetworkRisk: ...


class DisabledVpnProvider:
    def check(self, ip: str) -> NetworkRisk:
        return NetworkRisk(vpn=None, source="disabled")


class CidrVpnProvider:
    """Ranges of known VPN / proxy / hosting networks from a local file (e.g. a licensed IP2Proxy or X4BNet
    export), one CIDR per line; '#' comments allowed. Re-read when the file changes."""

    def __init__(self, path: str) -> None:
        self._path, self._mtime, self._nets = path, None, []

    def _load(self) -> None:
        import ipaddress
        import os

        mtime = os.path.getmtime(self._path)
        if mtime == self._mtime:
            return
        nets = []
        with open(self._path, encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip()
                if line:
                    try:
                        nets.append(ipaddress.ip_network(line, strict=False))
                    except ValueError:
                        continue
        self._nets, self._mtime = nets, mtime

    def check(self, ip: str) -> NetworkRisk:
        import ipaddress

        try:
            self._load()
            addr = ipaddress.ip_address(ip)
        except (OSError, ValueError):
            return NetworkRisk(vpn=None, source="cidr", detail="unavailable")
        hit = next((n for n in self._nets if addr.version == n.version and addr in n), None)
        return NetworkRisk(vpn=hit is not None, source="cidr", detail=str(hit) if hit else None)


class HttpVpnProvider:
    def __init__(self, url: str, key: str | None, timeout: float) -> None:
        self._url, self._key, self._timeout = url.rstrip("/") + "/", key, timeout

    def check(self, ip: str) -> NetworkRisk:
        try:
            resp = httpx.get(self._url + ip, timeout=self._timeout,
                             headers={"Authorization": f"Bearer {self._key}"} if self._key else {})
            data = resp.json() if resp.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            data = None
        if not isinstance(data, dict):
            return NetworkRisk(vpn=None, source="http", detail="unavailable")
        flags = [k for k in ("vpn", "proxy", "tor", "relay", "hosting") if data.get(k) is True]
        return NetworkRisk(vpn=bool(flags), source="http", detail=",".join(flags) or None)


@lru_cache
def get_vpn_provider() -> VpnProvider:
    s = get_settings()
    if s.vpn_provider == "cidr":
        if not s.vpn_cidr_file:
            raise RuntimeError("VPN_PROVIDER=cidr requires VPN_CIDR_FILE")
        return CidrVpnProvider(s.vpn_cidr_file)
    if s.vpn_provider == "http":
        if not s.vpn_api_url:
            raise RuntimeError("VPN_PROVIDER=http requires VPN_API_URL")
        return HttpVpnProvider(s.vpn_api_url, s.vpn_api_key.get_secret_value() if s.vpn_api_key else None, s.external_timeout_seconds)
    return DisabledVpnProvider()


# ---- reverse geocoding ---------------------------------------------------------------------------------
# Coordinates -> a street address, stamped on the photo a record is saved with, so a reviewer reads a place
# instead of two numbers. Never required: the record's evidence is the coordinates, and an address that
# cannot be fetched (disabled, offline, provider down) simply is not shown.

GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json"


class GeocodeProvider(Protocol):
    def reverse(self, lat: float, lon: float) -> str | None: ...


class DisabledGeocoder:
    enabled = False

    def reverse(self, lat: float, lon: float) -> str | None:
        return None


class GoogleGeocoder:
    enabled = True

    def __init__(self, key: str, region: str, timeout: float) -> None:
        self._key, self._region, self._timeout = key, region, timeout

    def reverse(self, lat: float, lon: float) -> str | None:
        try:
            resp = httpx.get(GOOGLE_GEOCODE, timeout=self._timeout,
                             params={"latlng": f"{lat},{lon}", "key": self._key, "region": self._region})
        except httpx.HTTPError as exc:
            raise ProviderUnavailable("Geocoding service unreachable") from exc
        if resp.status_code != 200:
            raise ProviderUnavailable(f"Geocoding service answered HTTP {resp.status_code}")
        data = resp.json() if resp.content else {}
        status = data.get("status")
        if status == "ZERO_RESULTS":
            return None
        if status != "OK":
            # REQUEST_DENIED is the usual answer for a browser key used from a server, or one whose
            # project has no Geocoding API: say so, rather than silently showing no address forever.
            raise ProviderUnavailable(f"Geocoding refused: {status} {data.get('error_message', '')}".strip())
        results = data.get("results") or []
        return results[0].get("formatted_address") if results else None


@lru_cache
def get_geocode_provider() -> GeocodeProvider:
    s = get_settings()
    if s.geocode_provider == "google":
        if not s.geocode_api_key:
            raise RuntimeError("GEOCODE_PROVIDER=google requires GEOCODE_API_KEY")
        return GoogleGeocoder(s.geocode_api_key.get_secret_value(), s.geocode_region, s.external_timeout_seconds)
    return DisabledGeocoder()
