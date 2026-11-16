"""External PNR and SMS providers. Credentials come only from environment configuration."""

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Protocol

import httpx

from app.config import get_settings


class ProviderUnavailable(Exception):
    """The provider could not give an answer (disabled, network, 5xx). The record stays pending."""


@dataclass(frozen=True)
class PnrResult:
    found: bool
    train_number: str | None = None
    train_name: str | None = None
    coach_ids: frozenset[str] = field(default_factory=frozenset)
    status_text: str | None = None


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


class RapidApiPnrProvider:
    """IRCTC PNR status via RapidAPI (response: data.trainNumber, data.passengerList[].*CoachId)."""

    def __init__(self, url: str, host: str, key: str, timeout: float) -> None:
        self._url, self._host, self._key, self._timeout = url.rstrip("/") + "/", host, key, timeout

    def lookup(self, pnr: str) -> PnrResult:
        try:
            resp = httpx.get(self._url + pnr, timeout=self._timeout,
                             headers={"x-rapidapi-key": self._key, "x-rapidapi-host": self._host})
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"PNR provider unreachable: {type(exc).__name__}") from exc
        if resp.status_code >= 500 or resp.status_code == 429:
            raise ProviderUnavailable(f"PNR provider returned {resp.status_code}")
        if resp.status_code >= 400:
            return PnrResult(found=False)
        try:
            data = (resp.json() or {}).get("data") or {}
        except ValueError as exc:
            raise ProviderUnavailable("PNR provider returned invalid JSON") from exc
        passengers = data.get("passengerList") or []
        if not data.get("numberOfpassenger") or not passengers:
            return PnrResult(found=False)
        coaches = set()
        for pax in passengers:
            for key in ("bookingCoachId", "currentCoachId"):
                if pax.get(key):
                    coaches.add(str(pax[key]).strip().upper())
        first = passengers[0]
        return PnrResult(found=True, train_number=str(data.get("trainNumber") or "").strip() or None,
                         train_name=data.get("trainName"), coach_ids=frozenset(coaches),
                         status_text=first.get("currentStatusDetails") or first.get("currentStatus"))


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


@lru_cache
def get_pnr_provider() -> PnrProvider:
    s = get_settings()
    if s.pnr_provider == "rapidapi":
        if not (s.pnr_api_url and s.pnr_api_host and s.pnr_api_key):
            raise RuntimeError("PNR_PROVIDER=rapidapi requires PNR_API_URL, PNR_API_HOST and PNR_API_KEY")
        return RapidApiPnrProvider(s.pnr_api_url, s.pnr_api_host, s.pnr_api_key.get_secret_value(), s.external_timeout_seconds)
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
