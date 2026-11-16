"""Self-hosted proof-of-work CAPTCHA (ALTCHA protocol, https://altcha.org/docs/server-integration).

The server issues {algorithm, challenge, salt, signature, maxnumber}: challenge = SHA-256(salt + secret number),
signature = HMAC-SHA-256(key, challenge). The browser finds the number by brute force (costly for a bot that
hammers the sign-in, cheap once for a person) and returns it. The server checks the signature, the expiry in
the salt and the hash, then records the signature so the same solution is accepted only once.

No third party, no images: it works under the app's Content-Security-Policy and is accessible (no puzzle to
see or hear). It is a rate-raising measure, not proof of a human; lock-out and rate limits sit behind it."""

import hashlib
import hmac
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs

from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import BusinessRuleViolation
from app.models import CaptchaUse

ALGORITHM = "SHA-256"


def _key() -> bytes:
    s = get_settings()
    if s.captcha_hmac_key is not None:
        return s.captcha_hmac_key.get_secret_value().encode()
    return hmac.new(s.otp_pepper.get_secret_value().encode(), b"captcha-v1", hashlib.sha256).digest()


def _sign(challenge: str) -> str:
    return hmac.new(_key(), challenge.encode(), hashlib.sha256).hexdigest()


def create_challenge(now: float | None = None) -> dict:
    s = get_settings()
    now = time.time() if now is None else now
    expires = int(now) + s.captcha_ttl_seconds
    salt = f"{secrets.token_hex(12)}?expires={expires}"
    number = secrets.randbelow(s.captcha_max_number + 1)
    challenge = hashlib.sha256(f"{salt}{number}".encode()).hexdigest()
    return {"algorithm": ALGORITHM, "challenge": challenge, "salt": salt, "signature": _sign(challenge),
            "maxnumber": s.captcha_max_number, "expires_at": datetime.fromtimestamp(expires, timezone.utc)}


def _fail(reason: str):
    raise BusinessRuleViolation("The security check failed. Refresh it and try again.", code="captcha_invalid",
                                details={"reason": reason})


def verify(db: Session, solution: dict | None, now: float | None = None) -> None:
    """Accepts a solved challenge once. Raises captcha_invalid otherwise (expired, wrong, reused)."""
    if not isinstance(solution, dict):
        _fail("missing")
    if solution.get("algorithm") == TEXT_ALGORITHM:
        return verify_text(db, solution, now)
    try:
        algorithm, challenge, salt = str(solution["algorithm"]), str(solution["challenge"]), str(solution["salt"])
        signature, number = str(solution["signature"]), int(solution["number"])
    except (KeyError, TypeError, ValueError):
        _fail("malformed")
    if algorithm != ALGORITHM or number < 0:
        _fail("malformed")
    if not hmac.compare_digest(_sign(challenge), signature):
        _fail("signature")
    try:
        expires = int(parse_qs(salt.split("?", 1)[1])["expires"][0])
    except (IndexError, KeyError, ValueError):
        _fail("malformed")
    now = time.time() if now is None else now
    if now > expires:
        _fail("expired")
    if not hmac.compare_digest(hashlib.sha256(f"{salt}{number}".encode()).hexdigest(), challenge):
        _fail("wrong_answer")
    # One-time use: the signature's hash is the primary key, so a replay fails on insert.
    now_dt = datetime.fromtimestamp(now, timezone.utc)
    db.execute(delete(CaptchaUse).where(CaptchaUse.expires_at < now_dt))
    savepoint = db.begin_nested()
    try:
        db.add(CaptchaUse(signature_hash=hashlib.sha256(signature.encode()).hexdigest(),
                          expires_at=datetime.fromtimestamp(expires, timezone.utc)))
        db.flush()
        savepoint.commit()
    except IntegrityError:
        savepoint.rollback()
        _fail("reused")


# ---- visible number CAPTCHA ---------------------------------------------------------------------------------
# The server draws a random number as a distorted SVG image (strokes, not <text>, so the digits are not in the
# markup) and returns it with a signed token. The answer itself is never sent: the token carries
# HMAC(key, nonce|expires|answer), so the server re-derives it from what the person typed. One-time use and
# expiry are enforced exactly like the proof-of-work challenge (CaptchaUse table).
import base64
import json
import math
import random

TEXT_ALGORITHM = "TEXT"
TEXT_LENGTH = 5

# Stroke font for digits on a 10 x 16 grid: each digit is a list of polylines.
_DIGITS = {
    "0": [[(2, 1), (8, 1), (9, 3), (9, 13), (8, 15), (2, 15), (1, 13), (1, 3), (2, 1)]],
    "1": [[(3, 4), (6, 1), (6, 15)], [(3, 15), (9, 15)]],
    "2": [[(1, 4), (3, 1), (7, 1), (9, 4), (9, 6), (1, 15), (9, 15)]],
    "3": [[(1, 2), (8, 1), (9, 4), (8, 7), (4, 8)], [(4, 8), (8, 9), (9, 12), (8, 15), (1, 14)]],
    "4": [[(7, 15), (7, 1), (1, 11), (9, 11)]],
    "5": [[(9, 1), (2, 1), (1, 7), (7, 7), (9, 10), (8, 14), (6, 15), (1, 14)]],
    "6": [[(8, 1), (3, 3), (1, 8), (1, 13), (3, 15), (7, 15), (9, 12), (8, 9), (5, 8), (1, 10)]],
    "7": [[(1, 1), (9, 1), (4, 15)], [(3, 8), (8, 8)]],
    "8": [[(5, 8), (2, 6), (2, 2), (5, 1), (8, 2), (8, 6), (5, 8), (1, 11), (2, 15), (8, 15), (9, 11), (5, 8)]],
    "9": [[(9, 6), (5, 8), (2, 7), (1, 4), (3, 1), (7, 1), (9, 4), (9, 9), (7, 14), (2, 15)]],
}


def _text_mac(nonce: str, expires: int, answer: str) -> str:
    return hmac.new(_key(), f"text|{nonce}|{expires}|{answer}".encode(), hashlib.sha256).hexdigest()


def _render(answer: str, rnd: random.Random) -> str:
    w, h = 200, 64
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
             f'<rect width="{w}" height="{h}" fill="#f1f5fb"/>']
    for _ in range(6):  # background noise lines
        parts.append(f'<line x1="{rnd.randint(0, w)}" y1="{rnd.randint(0, h)}" x2="{rnd.randint(0, w)}" '
                     f'y2="{rnd.randint(0, h)}" stroke="#{rnd.choice(["94a3b8", "a5b4fc", "7dd3fc"])}" stroke-width="1.2"/>')
    for _ in range(40):
        parts.append(f'<circle cx="{rnd.randint(0, w)}" cy="{rnd.randint(0, h)}" r="{rnd.uniform(0.6, 1.6):.1f}" fill="#64748b"/>')
    x = 14
    for ch in answer:
        scale = rnd.uniform(2.4, 2.9)
        angle = math.radians(rnd.uniform(-16, 16))
        ox, oy = x + rnd.uniform(-2, 2), rnd.uniform(6, 14)
        color = rnd.choice(["1e3a8a", "1d4ed8", "0f172a", "334155"])
        for line in _DIGITS[ch]:
            pts = []
            for px, py in line:
                px, py = px + rnd.uniform(-0.45, 0.45), py + rnd.uniform(-0.45, 0.45)
                rx = (px - 5) * math.cos(angle) - (py - 8) * math.sin(angle) + 5
                ry = (px - 5) * math.sin(angle) + (py - 8) * math.cos(angle) + 8
                pts.append(f"{ox + rx * scale:.1f},{oy + ry * scale:.1f}")
            parts.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#{color}" '
                         f'stroke-width="{rnd.uniform(2.6, 3.4):.1f}" stroke-linecap="round" stroke-linejoin="round"/>')
        x += 34 + rnd.randint(-2, 3)
    # One strike-through curve across the digits.
    y0 = rnd.randint(24, 40)
    parts.append(f'<path d="M4 {y0} Q {w / 2} {rnd.randint(0, h)} {w - 4} {rnd.randint(20, 44)}" fill="none" '
                 f'stroke="#475569" stroke-width="1.6"/>')
    parts.append("</svg>")
    return "".join(parts)


def create_text_challenge(now: float | None = None) -> dict:
    s = get_settings()
    now = time.time() if now is None else now
    expires = int(now) + s.captcha_ttl_seconds
    rnd = random.SystemRandom()
    answer = "".join(rnd.choice("0123456789") for _ in range(TEXT_LENGTH))
    nonce = secrets.token_hex(12)
    token = base64.urlsafe_b64encode(json.dumps(
        {"n": nonce, "e": expires, "m": _text_mac(nonce, expires, answer)}, separators=(",", ":")).encode()).decode()
    image = "data:image/svg+xml;base64," + base64.b64encode(_render(answer, rnd).encode()).decode()
    return {"algorithm": TEXT_ALGORITHM, "token": token, "image": image, "length": TEXT_LENGTH,
            "expires_at": datetime.fromtimestamp(expires, timezone.utc)}


def _consume(db: Session, key: str, expires: int, now: float) -> None:
    now_dt = datetime.fromtimestamp(now, timezone.utc)
    db.execute(delete(CaptchaUse).where(CaptchaUse.expires_at < now_dt))
    savepoint = db.begin_nested()
    try:
        db.add(CaptchaUse(signature_hash=hashlib.sha256(key.encode()).hexdigest(),
                          expires_at=datetime.fromtimestamp(expires, timezone.utc)))
        db.flush()
        savepoint.commit()
    except IntegrityError:
        savepoint.rollback()
        _fail("reused")


def verify_text(db: Session, solution: dict, now: float | None = None) -> None:
    try:
        data = json.loads(base64.urlsafe_b64decode(str(solution["token"]).encode()))
        nonce, expires, mac = str(data["n"]), int(data["e"]), str(data["m"])
        answer = "".join(ch for ch in str(solution["answer"]) if ch.isdigit())
    except (KeyError, TypeError, ValueError):
        _fail("malformed")
    now = time.time() if now is None else now
    if now > expires:
        _fail("expired")
    # Consume first: a wrong guess also uses up the image, so one image allows exactly one attempt.
    _consume(db, "text:" + nonce, expires, now)
    if len(answer) != TEXT_LENGTH or not hmac.compare_digest(_text_mac(nonce, expires, answer), mac):
        db.commit()  # keep the image used up although the request fails (the error rolls back otherwise)
        _fail("wrong_answer")
