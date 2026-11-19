"""Password hashes for the sign-in credentials kept in PostgreSQL (`user_credentials`).

Two formats are stored, each a self-describing string:

    scrypt$ln=15,r=8,p=1$<salt>$<hash>
        Our own: scrypt (RFC 7914) with a 16-byte random salt and a 32-byte output. Every new or changed
        password, and every imported one after its first successful sign-in, is stored like this.

    fbscrypt$r=8,m=14$<salt>$<salt separator>$<signer key>$<hash>
        A hash exported from Firebase Authentication, so employees kept their passwords when sign-in moved
        off Firebase. Firebase's variant of scrypt: the key derived from (password, salt + separator) is used
        as an AES-256-CTR key to encrypt the project's signer key, and the ciphertext is the stored hash. The
        project parameters travel inside the string because they are needed to check it -- they make the
        hash exactly as hard to attack offline as a plain scrypt hash, no easier. `verify` reports these as
        needing a rehash, so each disappears at its owner's next sign-in.

All byte fields are standard base64. Only `hashlib` (scrypt) and `cryptography` (AES, for the Firebase format)
are used; comparisons are constant-time."""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

NATIVE = "scrypt"
FIREBASE = "fbscrypt"

_LN, _R, _P = 15, 8, 1  # N = 2^15: about 30 MB and 50-100 ms per check, the RFC 7914 interactive setting
_SALT_BYTES, _HASH_BYTES = 16, 32
_MAXMEM = 128 << 20  # scrypt needs 128 * r * N bytes; the default 32 MB cap is just too small for N = 2^15
MAX_PASSWORD_CHARS = 256  # scrypt of a huge input is not a problem, but nobody types this much


@dataclass(frozen=True)
class Verification:
    ok: bool
    needs_rehash: bool = False


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str) -> bytes:
    """Standard or URL-safe base64, padded or not (Firebase exports use either)."""
    text = text.strip().replace("-", "+").replace("_", "/")
    return base64.b64decode(text + "=" * (-len(text) % 4), validate=True)


def _params(text: str) -> dict[str, int]:
    return {k: int(v) for k, v in (part.split("=", 1) for part in text.split(","))}


def _scrypt(password: str, salt: bytes, ln: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=1 << ln, r=r, p=p, dklen=dklen, maxmem=_MAXMEM)


def hash_password(password: str) -> str:
    if not password or len(password) > MAX_PASSWORD_CHARS:
        raise ValueError("password length out of range")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = _scrypt(password, salt, _LN, _R, _P, _HASH_BYTES)
    return f"{NATIVE}$ln={_LN},r={_R},p={_P}${_b64(salt)}${_b64(digest)}"


def firebase_hash(*, password_hash: str, salt: str, salt_separator: str, signer_key: str, rounds: int,
                  mem_cost: int) -> str:
    """The stored form of a hash exported from Firebase Authentication (all byte arguments base64)."""
    parts = [_b64(_unb64(x)) for x in (salt, salt_separator, signer_key, password_hash)]
    return f"{FIREBASE}$r={int(rounds)},m={int(mem_cost)}${'$'.join(parts)}"


def _firebase_digest(password: str, salt: bytes, separator: bytes, signer_key: bytes, rounds: int, mem_cost: int) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt + separator, n=1 << mem_cost, r=rounds, p=1,
                             dklen=64, maxmem=_MAXMEM)
    encryptor = Cipher(algorithms.AES(derived[:32]), modes.CTR(b"\x00" * 16)).encryptor()
    return encryptor.update(signer_key) + encryptor.finalize()


def verify_password(stored: str | None, password: str) -> Verification:
    """Never raises for a malformed or unknown stored value: it simply does not match."""
    if not stored or not password or len(password) > MAX_PASSWORD_CHARS:
        return Verification(ok=False)
    try:
        scheme, params, *fields = stored.split("$")
        p = _params(params)
        if scheme == NATIVE and len(fields) == 2:
            salt, expected = (_unb64(f) for f in fields)
            actual = _scrypt(password, salt, p["ln"], p["r"], p["p"], len(expected))
            ok = hmac.compare_digest(actual, expected)
            return Verification(ok=ok, needs_rehash=ok and (p["ln"], p["r"], p["p"]) != (_LN, _R, _P))
        if scheme == FIREBASE and len(fields) == 4:
            salt, separator, signer_key, expected = (_unb64(f) for f in fields)
            actual = _firebase_digest(password, salt, separator, signer_key, p["r"], p["m"])
            ok = hmac.compare_digest(actual, expected)
            return Verification(ok=ok, needs_rehash=ok)
    except (ValueError, KeyError, TypeError):
        pass
    return Verification(ok=False)


# A real hash of a random string, checked when the account does not exist, so an unknown Employee ID takes
# as long to refuse as a wrong password (no timing difference to tell them apart).
_DUMMY = hash_password(secrets.token_urlsafe(16))


def burn_time(password: str) -> None:
    verify_password(_DUMMY, password or "x")
