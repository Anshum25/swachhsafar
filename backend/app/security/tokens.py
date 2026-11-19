"""Session tokens issued by the backend sign-in (POST /auth/login, /auth/otp/verify).

A token is opaque: `ss1.<session id>.<secret>`, where the secret is 32 random bytes. Only a SHA-256 of the
secret is stored (auth_sessions.token_hash), so the table cannot be used to impersonate anyone if it leaks.
Every API call looks its session up anyway (revocation, device block, idle expiry), so a signed token would add
nothing: deleting or revoking the row is what ends a session, immediately and everywhere."""

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass

PREFIX = "ss1"


@dataclass(frozen=True)
class IssuedToken:
    token: str
    token_hash: str


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("ascii")).hexdigest()


def issue(session_id: uuid.UUID) -> IssuedToken:
    secret = secrets.token_urlsafe(32)
    return IssuedToken(token=f"{PREFIX}.{session_id.hex}.{secret}", token_hash=_digest(secret))


def parse(token: str) -> tuple[uuid.UUID, str] | None:
    """(session id, secret) of a well-formed token, else None."""
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != PREFIX or not parts[2]:
        return None
    try:
        return uuid.UUID(hex=parts[1]), parts[2]
    except ValueError:
        return None


def matches(secret: str, token_hash: str | None) -> bool:
    if not token_hash:
        return False
    try:
        return hmac.compare_digest(_digest(secret), token_hash)
    except (UnicodeEncodeError, TypeError):
        return False
