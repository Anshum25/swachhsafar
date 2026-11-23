# Swachh Safar Security Architecture Specification

## 1. Threat Model & Security Posture
Swachh Safar is an operational railway inspection, monitoring, attendance, and feedback management system operated by field employees across Indian Railways divisions. It operates in an offline-first environment where devices frequently experience intermittent or absent internet connectivity inside train coaches, stations, and railway corridors.

### Primary Threats Mitigated
1. **Unverified Field Attendance & Ghost Workers:** Mitigated via mandatory device GPS accuracy (<100m) and freshness (<120s), facial biometrics with a server-issued random liveness challenge and a 3-D depth check (see "The face check" below), and employee descriptor matching against admin-enrolled biometric templates.
2. **Location Spoofing & Mock Providers:** Mitigated by native Android mock-location indicator flags and speed plausibility checks (jump > 250 km/h flagged as impossible travel).
3. **Network Masking & Unauthorized Proxies:** Mitigated by native `TRANSPORT_VPN` checks on Android, server IP reputation lookup on web, and fail-closed operational submission policies for unverified PWA environments.
4. **Credential Brute-Force & Account Takeover:** Mitigated by ALTCHA self-hosted proof-of-work CAPTCHAs, sliding window IP and account lockouts (max 5 failures per 15-minute window), and backend-issued Firebase custom tokens.
5. **Offline Tampering & Replay Attacks:** Mitigated by signed offline authorization leases strictly bounded to 24 hours maximum, device and employee identity binding, and monotonic clock rollback detection.

---

## The face check, and what it proves

A face match alone never authorises attendance. Face recognition (is this the enrolled employee?) and
liveness (is a live person physically in front of the camera?) are separate checks, and both must pass.

### Input: live camera only

Every attendance photo — single capture, and each person in group "one by one" mode — is taken by the app
from the live camera (`getUserMedia`). There is no gallery picker, file input or "ordinary photo" fallback
anywhere in attendance (the group-mode fallback that took a photo from the file picker was removed). The
attempt is abandoned if the camera track ends, if the app goes to the background mid-check (for example to
open the gallery or start a recording), or if the camera's own name identifies it as a virtual camera.

### Liveness: server-issued random challenge + passive depth check

1. **Challenge.** The server issues single-use challenges (`POST /attendance/liveness/challenges`,
   `app/services/liveness.py`): three actions in a random order — always a head turn (left or right) and a
   blink, plus one of look up / look down / move closer / the other turn. Each challenge is HMAC-signed,
   bound to the user and device, and expires after 24 hours (the offline lease limit).
2. **Active check, on the device** (`src/face/liveness.js` `createActiveChallenge`). Every action must be
   seen happening in live frames, judged against the person's own neutral pose; head movements must return
   to the camera before they count; a clear movement the wrong way counts against the attempt (one mistake
   allowed). Exactly one face must be in the frame.
3. **Passive depth check, on the device** (`src/face/depthCheck.js`). Across the head movements, the nose
   must move off the plane formed by the brows, eye corners and mouth corners. Any flat surface — a printed
   photo, or a photo on a phone or monitor, however it is tilted or moved — maps between views by a single
   homography, so its nose never leaves that plane. Rejected as "Spoofing attempt detected".
4. **Same person throughout**: the face descriptor at the start and at the end must match.
5. Only then is the still taken and matched against the enrolled template (existing matcher and thresholds,
   unchanged).

### Server enforcement

`attendance.create` (direct API and `/sync`) requires, for every capture identified by face, a
`liveness_proof` whose challenge: exists; was issued to the submitting user on the submitting device; has a
valid signature; is unexpired; lists exactly the issued actions in the issued order; has plausible timing
(after issue, before the capture was submitted, 0.3 s+ per action, ≤ 120 s total, submitted within 15 min);
reports depth ≥ 0.06 and same-person drift ≤ 0.5; and has not been used. The challenge is consumed
atomically by that record (`UPDATE … WHERE consumed_at IS NULL`, plus a unique `attendance_id`), so
replaying a previous verification, reusing a challenge, or using another user's challenge is refused. A
rejected capture does not consume its challenge. An identical resend of an accepted record is an idempotent
replay, as before. The proof is stored in `attendance.security.liveness_proof` for reviewers.

### Offline

The device holds a pool of challenges, fetched whenever the session is validated online
(`src/face/livenessTickets.js`). Each is used once and remembered locally as used, so a challenge whose
record has not synced yet is never handed out again. Offline captures go through the same checks; the local
repository refuses a face capture without a proof, and the server re-checks and consumes the challenge at
sync. With no unexpired challenge left, face capture does not start (fails closed) until the device is
online again. Fingerprint attendance does not need a challenge.

### What this does not defeat (honest limits)

This is **not** a certified presentation-attack detector (ISO/IEC 30107-3).

- **The server cannot see the camera.** Face matching, the challenge and the depth measurement run on the
  device; the server verifies the challenge protocol, not the pixels. A modified app (rooted phone, patched
  web bundle, scripted browser) could fetch a challenge and submit a fabricated proof with a matching
  `face_distance`. Closing that needs server-side re-verification of the frames (planned: upload 2–3
  challenge keyframes and run recognition and a passive anti-spoofing model such as MiniFASNet on the
  server) or hardware attestation (Play Integrity) on Android.
- **Live video of a cooperating real person**, or a real-time deepfake / face-reenactment fed through an
  injected camera, can follow the instructions. The random sequence defeats a *prerecorded* clip unless the
  attacker has clips of the victim performing every action and splices them live.
- **Virtual cameras** are detected only when the driver's name gives it away. On Android in the app's own
  WebView this is hard to inject without root.
- **3-D masks** are not addressed.
- Offline challenges are known to the device up to 24 h before use. That does not help an attacker without
  the victim's cooperation, but a short-lived online challenge would be stronger where connectivity allows.
- **Group-photo attendance** (`attendance_group_photo`, off by default) is a single frame of a crew and has
  no liveness check. It remains a supervisor attestation (`identified_by="group_photo"`), allowed only from
  the journey supervisor or a reviewer. A division that needs the guarantee above must keep it off.
- `face_liveness_required` no longer changes anything for face attendance: the full challenge is always
  required. The setting is kept so existing policies stay valid.
- The thresholds (turn 0.22, depth 0.08 on the device, 0.06 on the server) are validated on synthetic
  geometry only. They must be calibrated on real phones (see docs/SECURITY_TEST_REPORT.md).

## 2. Policy Enforcement Engine

Operational actions are centrally classified:
- `app`: Overall application launch and access. Gated by `gps_block_app` and `gps_enforced`.
- `location`: Operational submissions (Inspection, Passenger Feedback, Railway Feedback, Complaints, Inventory).
- `attendance`: Biometric and location-dependent employee verification.

```
+-------------------------------------------------------------------+
|                   Central Security Policy Engine                   |
|                        (decide(action, ctx))                      |
+---------------------------------+---------------------------------+
                                  |
            +---------------------+---------------------+
            |                                           |
            v                                           v
+-----------------------+                   +-----------------------+
| Location Verification |                   | Network Risk Check    |
| - GPS Enforced: true  |                   | - Native VPN State    |
| - App Gating: true    |                   | - Server IP Reputation|
| - Max Age: 120s       |                   | - PWA Fail-Closed     |
| - Max Accuracy: 100m  |                   | - Policy: "block"     |
+-----------------------+                   +-----------------------+
            |                                           |
            +---------------------+---------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|                   Signed 24-Hour Offline Lease                    |
| - Monotonic Clock Rollback Protection                             |
| - Device ID Binding: canonical web-* / and-* identifier           |
| - Maximum Allowance: strictly capped at 24.0 hours                |
+-------------------------------------------------------------------+
```

---

## 3. Evidence Collection & Server Re-Validation
Every operational capture submitted via sync batch carries a `security` evidence payload:
```json
{
  "gps_timestamp": "2026-11-06T07:10:00Z",
  "security": {
    "app_version": "2.0.0",
    "platform": "android",
    "location_source": "gps",
    "mock_location": false,
    "vpn": false,
    "vpn_check": "native",
    "liveness": "passed",
    "face_model_version": "faceapi-resnet128-v1",
    "policy_result": "allowed",
    "warnings": []
  }
}
```
The FastAPI backend (`backend/app/services/security.py`) independently re-validates:
1. Clock skew between device capture timestamp and server arrival.
2. Spatial plausibility between consecutive submissions.
3. GPS accuracy against division threshold.
4. Active VPN status on verified server IP.
5. Session and device revocation status in PostgreSQL.

