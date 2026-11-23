"""Server side of the face attendance liveness check.

The face itself is analysed on the device (the server never receives video), so the server cannot watch a
blink. What it can and does guarantee:

  * the challenge was issued by this server, to this user, on this device, and has not expired
    (stops a hand-built request that simply claims "liveness passed");
  * the actions were reported in exactly the random order the server chose (a proof made up without the
    challenge, or for a different one, does not fit);
  * the challenge is consumed by exactly one attendance record, atomically, and can never be reused
    (stops replaying an earlier successful verification, or one employee's verification for another);
  * the timing is plausible: the challenge was performed after it was issued, before the capture was
    submitted, and not in an impossibly short or long time;
  * the device's own measurements (3-D depth across the head turn, same face from start to end) meet the
    minimums, and a camera the device reports as virtual is refused.

A modified app on a rooted phone could still perform this protocol with frames it fabricates. That is
documented in docs/SECURITY.md; the stored photo and proof remain available to reviewers."""

import hashlib
import hmac
import re
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import BusinessRuleViolation
from app.models import LivenessChallenge
from app.schemas.liveness import LivenessProof
from app.timeutil import utcnow

TURNS = ("turn_left", "turn_right")
EXTRAS = ("look_up", "look_down", "closer")
# A pool lives as long as an offline lease can: a device that went offline with challenges in hand can
# still capture until it must come back online anyway.
CHALLENGE_TTL = timedelta(hours=24)
MAX_OPEN_PER_DEVICE = 30
CLOCK_SKEW = timedelta(minutes=5)
# Performed after it was shown, and within this long; the capture is submitted within SUBMIT_WITHIN.
MIN_SECONDS_PER_ACTION = 0.3
MAX_CHALLENGE_SECONDS = 120
SUBMIT_WITHIN = timedelta(minutes=15)
# Device-measured minimums. A live face turning its head shows the nose moving well off the plane of the
# eyes and mouth; a photo or screen, however it is tilted, does not. See src/face/depthCheck.js.
MIN_DEPTH_SCORE = 0.06
MAX_IDENTITY_DRIFT = 0.5
VIRTUAL_CAMERA = re.compile(r"virtual|obs|manycam|snap camera|xsplit|droidcam|iriun|epoccam|ndi|camtwist|"
                            r"splitcam|youcam|e2esoft|vcam|fake", re.IGNORECASE)


def _secret() -> bytes:
    pepper = get_settings().otp_pepper.get_secret_value().encode()
    return hmac.new(pepper, b"swachh-liveness-challenge-v1", hashlib.sha256).digest()


def sign(c: LivenessChallenge) -> str:
    msg = "|".join([str(c.id), str(c.user_id), c.device_id or "", ",".join(c.actions),
                    str(int(c.expires_at.timestamp()))]).encode()
    return hmac.new(_secret(), msg, hashlib.sha256).hexdigest()


def random_actions(rng: secrets.SystemRandom | None = None) -> list[str]:
    """Three actions in a random order: always one head turn (the depth check needs it), always a blink,
    and one more of look up / look down / move closer / the other turn."""
    rng = rng or secrets.SystemRandom()
    turn = rng.choice(TURNS)
    other = rng.choice([*EXTRAS, *(t for t in TURNS if t != turn)])
    actions = [turn, "blink", other]
    rng.shuffle(actions)
    return actions


def _out(c: LivenessChallenge) -> dict:
    return dict(id=c.id, actions=c.actions, issued_at=c.issued_at, expires_at=c.expires_at, signature=sign(c))


def issue(db: Session, p, count: int) -> list[dict]:
    """Tops this user's pool on this device up to `count` open challenges and returns all of them. Calling
    it again returns the same open challenges, so a device that lost its copy gets them back rather than
    piling up new ones."""
    now = utcnow()
    open_ = list(db.scalars(select(LivenessChallenge).where(
        LivenessChallenge.user_id == p.id, LivenessChallenge.device_id == p.device_id,
        LivenessChallenge.consumed_at.is_(None), LivenessChallenge.expires_at > now + timedelta(minutes=10),
    ).order_by(LivenessChallenge.issued_at)))
    want = min(count, MAX_OPEN_PER_DEVICE) - len(open_)
    for _ in range(max(0, want)):
        c = LivenessChallenge(id=uuid.uuid4(), user_id=p.id, device_id=p.device_id, actions=random_actions(),
                              issued_at=now, expires_at=now + CHALLENGE_TTL)
        db.add(c)
        open_.append(c)
    db.commit()
    return [_out(c) for c in open_]


def _fail(message: str, code: str, **details) -> BusinessRuleViolation:
    return BusinessRuleViolation(message, code=code, details=details or None)


def verify_and_consume(db: Session, p, *, attendance_id: uuid.UUID, device_timestamp, proof: LivenessProof | None) -> dict:
    """Checks a liveness proof for one face-verified attendance and consumes its challenge. Raises
    BusinessRuleViolation when anything does not hold. Returns what is stored with the record."""
    if proof is None:
        raise _fail("Face attendance needs a live verification performed in front of the camera.",
                    "liveness_proof_required")
    c = db.get(LivenessChallenge, proof.challenge_id)
    if c is None or c.user_id != p.id:
        raise _fail("The live verification was not issued to you.", "liveness_challenge_invalid")
    if p.device_id and c.device_id and c.device_id != p.device_id:
        raise _fail("The live verification was issued to a different device.", "liveness_challenge_invalid")
    if not hmac.compare_digest(proof.signature, sign(c)):
        raise _fail("The live verification does not match the one issued.", "liveness_challenge_invalid")
    if c.consumed_at is not None:
        raise _fail("This live verification has already been used. Perform the check again.", "liveness_challenge_used")

    issued, expires = c.issued_at, c.expires_at
    if proof.started_at < issued - CLOCK_SKEW:
        raise _fail("The live verification is older than its challenge.", "liveness_timing")
    if proof.completed_at > expires or device_timestamp > expires + CLOCK_SKEW:
        raise _fail("The live verification challenge had expired. Connect once to refresh it.", "liveness_challenge_expired")
    span = (proof.completed_at - proof.started_at).total_seconds()
    actions = [s.action for s in proof.steps]
    if actions != list(c.actions):
        raise _fail("The actions performed do not match the challenge.", "liveness_actions_mismatch")
    if span < MIN_SECONDS_PER_ACTION * len(actions) or span > MAX_CHALLENGE_SECONDS:
        raise _fail("The live verification timing is not plausible.", "liveness_timing")
    times = [s.at for s in proof.steps]
    if times != sorted(times) or times[0] < proof.started_at or times[-1] > proof.completed_at:
        raise _fail("The live verification timing is not plausible.", "liveness_timing")
    if proof.completed_at > device_timestamp + CLOCK_SKEW or device_timestamp - proof.completed_at > SUBMIT_WITHIN:
        raise _fail("The attendance was not captured right after the live verification.", "liveness_timing")
    if proof.depth_score < MIN_DEPTH_SCORE:
        raise _fail("A flat image (photo or screen) was detected instead of a live face.", "liveness_spoof_suspected",
                    depth_score=proof.depth_score)
    if proof.identity_drift > MAX_IDENTITY_DRIFT:
        raise _fail("The face changed during the live verification.", "liveness_face_changed")
    if proof.camera_label and VIRTUAL_CAMERA.search(proof.camera_label):
        raise _fail("A virtual camera cannot be used for attendance.", "liveness_virtual_camera")

    # Atomic: of two submissions racing with the same challenge, exactly one updates the row.
    used = db.execute(update(LivenessChallenge)
                      .where(LivenessChallenge.id == c.id, LivenessChallenge.consumed_at.is_(None))
                      .values(consumed_at=func.now(), attendance_id=attendance_id)
                      .execution_options(synchronize_session=False))
    if used.rowcount != 1:
        raise _fail("This live verification has already been used. Perform the check again.", "liveness_challenge_used")
    return dict(challenge_id=str(c.id), actions=actions, depth_score=proof.depth_score,
                identity_drift=proof.identity_drift, frames=proof.frames, camera_label=proof.camera_label)
