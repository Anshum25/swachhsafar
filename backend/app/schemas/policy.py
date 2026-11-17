from typing import Literal

from pydantic import Field

from app.schemas.common import StrictModel


class PolicySettings(StrictModel):
    """Division operational policy. Defaults are the strict choice; a division relaxes them explicitly."""

    passenger_pnr_required: bool = True
    passenger_otp_required: bool = True
    # When true, PNR train must be the main train for the first half of the journey days and the linked
    # train for the second half; when false either train is accepted on any day.
    pnr_train_day_mapping: bool = False
    pnr_coach_match_required: bool = True
    passenger_feedback_per_coach_day: int | None = Field(default=None, ge=1, le=100)
    railway_feedback_limit_per_journey: int = Field(default=2, ge=0, le=50)
    attendance_photo_required: bool = True
    attendance_late_grace_days: int = Field(default=1, ge=0, le=7)
    inspection_photo_required: bool = True
    complaint_default_sla_hours: int = Field(default=72, ge=1, le=24 * 60)
    # Face verification of attendance (off by default). The device compares the attendance photo with the
    # employee's registered face descriptors; a distance above the threshold blocks the attendance.
    attendance_face_verification: bool = False
    face_match_threshold: float = Field(default=0.5, ge=0.3, le=0.7)
    # Fingerprint verification needs a scanner, so it is an alternative to the face check, never a
    # replacement: a phone without the scanner still marks attendance by face.
    attendance_fingerprint_verification: bool = False
    # Score at or above which the scanner's own matcher is taken as a match. The scale is the SDK's, not
    # ours. The default is set for the AST300's minutiae matcher, which scores a genuine finger held
    # differently from how it was registered -- a partial overlap -- well below what an identical capture
    # would score; 40 refused clear prints in the field. A division that wants it stricter raises it.
    fingerprint_match_score: int = Field(default=30, ge=20, le=200)

    # ---- device security (enforced by the app; recorded and re-checked by the server where it can) ----
    # Location: a fix must be at most this old and this accurate for location-dependent actions
    # (attendance, inspection, passenger/railway feedback). gps_block_app: also keep the whole app closed
    # until a valid fix exists (otherwise only location-dependent actions are blocked).
    gps_enforced: bool = True
    gps_block_app: bool = True
    gps_max_age_seconds: int = Field(default=120, ge=10, le=3600)
    gps_max_accuracy_m: int = Field(default=100, ge=5, le=5000)
    gps_timeout_seconds: int = Field(default=20, ge=5, le=120)
    # Consecutive fixes implying a faster speed are flagged as suspicious (trains run below 160 km/h).
    gps_max_speed_kmh: int = Field(default=250, ge=50, le=1000)
    # VPN / proxy: "block" refuses location-dependent actions while one is detected, "warn" records it.
    vpn_policy: Literal["off", "warn", "block"] = "block"
    # How long a device may keep working offline after its last online check of the user's session.
    # Strictly capped at 24 hours maximum.
    offline_session_hours: int = Field(default=24, ge=1, le=24)
    # A live-camera challenge (blink + head turn) before the face is matched for attendance.
    face_liveness_required: bool = False  # optional blink + head-turn check; the photo is face-matched either way
