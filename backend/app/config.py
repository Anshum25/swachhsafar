from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    database_url: str

    # Firebase is used only by the optional STORAGE_BACKEND=firebase and by `app.cli import-firebase-passwords`
    # (the one-off move of passwords off Firebase Authentication). Sign-in itself never contacts Firebase.
    firebase_project_id: str | None = None
    firebase_credentials_file: str | None = None
    firebase_storage_bucket: str | None = None

    storage_backend: Literal["firebase", "local"] = "local"
    local_media_dir: str = "./var/media"

    otp_pepper: SecretStr
    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5
    otp_resend_cooldown_seconds: int = 60
    otp_max_sends: int = 3

    cors_origins: list[str] = []

    # SMS gateway for OTPs. "msg91": MSG91 Flow API (DLT template mapped in the MSG91 panel; needs SMS_API_KEY =
    # authkey and SMS_LOGIN_TEMPLATE_ID = the MSG91 flow/template id). "http": generic JSON gateway (SMS_API_URL).
    # "disabled": no SMS; OTP sign-in answers "unavailable" (never a pretend success).
    sms_provider: Literal["disabled", "http", "msg91"] = "disabled"
    sms_otp_variable: str = "otp"  # name of the OTP variable in the gateway template (MSG91)
    sms_dlt_entity_id: str | None = None  # Principal Entity ID (DLT), sent where the gateway takes it
    sms_api_url: str | None = None
    sms_api_key: SecretStr | None = None
    sms_sender_id: str | None = None
    sms_template_id: str | None = None
    sms_login_template_id: str | None = None  # DLT template of the sign-in OTP message

    pnr_provider: Literal["disabled", "rapidapi"] = "disabled"
    pnr_api_url: str | None = None
    pnr_api_host: str | None = None
    pnr_api_key: SecretStr | None = None

    # Reverse geocoding: coordinates -> a street address, stamped on attendance and inspection photos.
    # "disabled" (the default) keeps everything working and simply shows coordinates; nothing leaves the
    # server without a key. The key is a SERVER key: restrict it by the server's IP, not by HTTP referrer.
    geocode_provider: Literal["disabled", "google"] = "disabled"
    geocode_api_key: SecretStr | None = None
    geocode_region: str = "IN"  # biases results to India (Google `region`)

    external_timeout_seconds: float = 15.0
    media_url_ttl_seconds: int = 600

    # ---- sign-in (backend-owned, PostgreSQL only; see app/services/auth.py) ---------------------------
    # HMAC key for CAPTCHA challenges; derived from OTP_PEPPER when not set.
    captcha_hmac_key: SecretStr | None = None
    captcha_max_number: int = 150_000  # proof-of-work difficulty (about 0.3-1 s on a mid-range phone)
    captcha_ttl_seconds: int = 300
    login_max_failures: int = 5         # per account or mobile within the window, then locked for the window
    login_failure_window_seconds: int = 900
    session_idle_days: int = 30         # a session unused this long is refused (offline use is bounded by policy)

    # ---- over-the-air web bundle releases (app/services/releases.py) ---------------------------------
    # Shared secret the CI pipeline sends as X-Release-Token to publish a bundle and to point a channel at
    # it. Unset means publishing is closed: the endpoints answer "not configured" rather than running open.
    release_publish_token: SecretStr | None = None
    web_bundle_max_bytes: int = 60 * 1024 * 1024          # the zip; a current build is about 6 MB
    web_bundle_max_unpacked_bytes: int = 200 * 1024 * 1024  # what it may expand to on the phone

    # ---- network risk (VPN / proxy) ------------------------------------------------------------------
    # "cidr": a local file of CIDR ranges (one per line) known to be VPN/proxy/hosting; "http": a JSON IP
    # reputation API (GET {url}/{ip} with a bearer key returning {"vpn": bool, "proxy": bool, "hosting": bool}).
    vpn_provider: Literal["disabled", "cidr", "http"] = "disabled"
    vpn_cidr_file: str | None = None
    vpn_api_url: str | None = None
    vpn_api_key: SecretStr | None = None
    # Number of trusted reverse proxies (nginx, Cloudflare) in front of the app, for the client IP.
    trusted_proxy_hops: int = 1

    @field_validator("otp_pepper")
    @classmethod
    def _pepper_strength(cls, v: SecretStr) -> SecretStr:
        raw = v.get_secret_value()
        if len(raw) < 32 or raw == "CHANGE_ME":
            raise ValueError("OTP_PEPPER must be a random secret of at least 32 characters")
        return v

    # Local disk is allowed in production (single-server deployment) only with an explicit absolute
    # LOCAL_MEDIA_DIR, so files never land in a directory relative to wherever the process started.
    @field_validator("local_media_dir")
    @classmethod
    def _absolute_media_dir_in_prod(cls, v, info):
        if info.data.get("environment") == "production" and info.data.get("storage_backend") == "local" and not v.startswith("/"):
            raise ValueError("LOCAL_MEDIA_DIR must be an absolute path when STORAGE_BACKEND=local in production")
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
