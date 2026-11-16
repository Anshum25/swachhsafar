from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    database_url: str

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

    external_timeout_seconds: float = 15.0
    media_url_ttl_seconds: int = 600

    # ---- sign-in (backend-owned; see app/services/auth.py) -------------------------------------------
    # Web API key of the Firebase project: the backend checks passwords with the Identity Toolkit REST API.
    firebase_web_api_key: SecretStr | None = None
    # When true, API calls need a token minted by POST /auth/login or /auth/otp/verify (it carries a session
    # id): tokens from a direct Firebase email/password sign-in, which skips the CAPTCHA, are refused.
    auth_require_backend_session: bool = False
    # HMAC key for CAPTCHA challenges; derived from OTP_PEPPER when not set.
    captcha_hmac_key: SecretStr | None = None
    captcha_max_number: int = 150_000  # proof-of-work difficulty (about 0.3-1 s on a mid-range phone)
    captcha_ttl_seconds: int = 300
    login_max_failures: int = 5         # per account or mobile within the window, then locked for the window
    login_failure_window_seconds: int = 900
    session_idle_days: int = 30         # a session unused this long is refused (offline use is bounded by policy)

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

    @field_validator("auth_require_backend_session")
    @classmethod
    def _require_backend_session_in_prod(cls, v: bool, info):
        if info.data.get("environment") == "production" and not v:
            import warnings
            warnings.warn(
                "CRITICAL SECURITY WARNING: AUTH_REQUIRE_BACKEND_SESSION is false in production! "
                "Direct Firebase sign-in bypasses backend CAPTCHA and device registration.",
                stacklevel=2,
            )
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
