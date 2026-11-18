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
    # Score at or above which the matcher's answer is taken as the same finger. The score is the
    # percentage of the smaller print whose minutiae line up, and it is only ever produced from at least
    # twelve matched points, so it is not a number that can be lowered far before it stops meaning
    # anything: a lower setting accepts other people. 30 was tried and did exactly that. Registration
    # takes several presses of each finger, which is what lets a genuine finger reach this honestly
    # rather than the threshold being bent down to meet a single impression.
    fingerprint_match_score: int = Field(default=40, ge=30, le=100)

    # ---- device security (enforced by the app; recorded and re-checked by the server where it can) ----
    # Location: a fix must be at most this old and this accurate for location-dependent actions
    # (attendance, inspection, passenger/railway feedback). gps_block_app: also keep the whole app closed
    # until a valid fix exists, and off by default -- a fix good enough for a record is not always there
    # indoors, and holding the entire app behind one only stopped people reading a journey or a report
    # they could perfectly well be shown. What needs a location still refuses without one.
    gps_enforced: bool = True
    gps_block_app: bool = False
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
    # A head turn as well as the blink, before the face is matched. The blink is not optional and is not
    # configurable: wherever a face is matched, the app watches for one before taking the still, because
    # a photograph of a face -- on paper or on another phone's screen -- does not blink, and without that
    # anyone could be marked present with a picture of them. The blink is passive, so most captures never
    # show a prompt. The head turn costs a few seconds more and also defeats a short recorded video.
    face_liveness_required: bool = False
