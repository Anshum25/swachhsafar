"""Firebase as the identity store behind the backend sign-in.

PasswordVerifier checks an email/password pair with the Identity Toolkit REST API (the passwords stay in
Firebase). TokenIssuer mints a Firebase custom token for the user with the session claims; the app exchanges it
with signInWithCustomToken, and the ID tokens it then sends carry `sid` (session) and `did` (device)."""

from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

import httpx

from app.config import get_settings
from app.errors import ServiceUnavailable

IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"


@dataclass(frozen=True)
class PasswordCheck:
    ok: bool
    uid: str | None = None
    email_verified: bool = False
    reason: str | None = None  # "invalid" | "disabled" | "throttled"


class PasswordVerifier(Protocol):
    def check(self, email: str, password: str) -> PasswordCheck: ...


class TokenIssuer(Protocol):
    def custom_token(self, uid: str, claims: dict) -> str: ...
    def uid_for_email(self, email: str) -> str | None: ...


class FirebasePasswordVerifier:
    def check(self, email: str, password: str) -> PasswordCheck:
        s = get_settings()
        if s.firebase_web_api_key is None:
            raise ServiceUnavailable("Password sign-in is not configured on the server", code="auth_not_configured")
        try:
            resp = httpx.post(IDENTITY_TOOLKIT, params={"key": s.firebase_web_api_key.get_secret_value()},
                              json={"email": email, "password": password, "returnSecureToken": False},
                              timeout=s.external_timeout_seconds)
        except httpx.HTTPError as exc:
            raise ServiceUnavailable("Sign-in service unreachable", code="auth_unavailable") from exc
        if resp.status_code >= 500:
            raise ServiceUnavailable("Sign-in service unavailable", code="auth_unavailable")
        if resp.status_code != 200:
            message = ((resp.json() or {}).get("error") or {}).get("message", "") if resp.content else ""
            if message.startswith("USER_DISABLED"):
                return PasswordCheck(ok=False, reason="disabled")
            if message.startswith("TOO_MANY_ATTEMPTS"):
                return PasswordCheck(ok=False, reason="throttled")
            return PasswordCheck(ok=False, reason="invalid")
        uid = resp.json()["localId"]
        from firebase_admin import auth  # initialised by the token verifier

        from app.security.tokens import get_token_verifier

        get_token_verifier()
        return PasswordCheck(ok=True, uid=uid, email_verified=bool(auth.get_user(uid).email_verified))


class FirebaseTokenIssuer:
    def __init__(self) -> None:
        from app.security.tokens import get_token_verifier

        get_token_verifier()  # initialises firebase_admin with the service account

    def custom_token(self, uid: str, claims: dict) -> str:
        from firebase_admin import auth

        token = auth.create_custom_token(uid, claims)
        return token.decode() if isinstance(token, bytes) else token

    def uid_for_email(self, email: str) -> str | None:
        from firebase_admin import auth

        try:
            return auth.get_user_by_email(email).uid
        except auth.UserNotFoundError:
            return None


@lru_cache
def get_password_verifier() -> PasswordVerifier:
    return FirebasePasswordVerifier()


@lru_cache
def get_token_issuer() -> TokenIssuer:
    return FirebaseTokenIssuer()
