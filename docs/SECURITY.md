# Swachh Safar Security Architecture Specification

## 1. Threat Model & Security Posture
Swachh Safar is an operational railway inspection, monitoring, attendance, and feedback management system operated by field employees across Indian Railways divisions. It operates in an offline-first environment where devices frequently experience intermittent or absent internet connectivity inside train coaches, stations, and railway corridors.

### Primary Threats Mitigated
1. **Unverified Field Attendance & Ghost Workers:** Mitigated via mandatory device GPS accuracy (<100m) and freshness (<120s), facial biometrics with liveness verification (blink + head turn), and employee descriptor matching against admin-enrolled biometric templates.
2. **Location Spoofing & Mock Providers:** Mitigated by native Android mock-location indicator flags and speed plausibility checks (jump > 250 km/h flagged as impossible travel).
3. **Network Masking & Unauthorized Proxies:** Mitigated by native `TRANSPORT_VPN` checks on Android, server IP reputation lookup on web, and fail-closed operational submission policies for unverified PWA environments.
4. **Credential Brute-Force & Account Takeover:** Mitigated by ALTCHA self-hosted proof-of-work CAPTCHAs, sliding window IP and account lockouts (max 5 failures per 15-minute window), and backend-issued Firebase custom tokens.
5. **Offline Tampering & Replay Attacks:** Mitigated by signed offline authorization leases strictly bounded to 24 hours maximum, device and employee identity binding, and monotonic clock rollback detection.

---

## The face check, and what it proves

The photo matched against an employee's registered face is always taken by the app from the live camera.
A photo chosen from the gallery is never accepted where the face is being matched: a face check against
a picture the user picked proves nothing.

**A blink is always required** before the still is taken. It is not a setting. A photograph of a face —
on paper or on another phone's screen — does not blink, and without that anyone could be marked present
with a picture of them, which was briefly possible and is the reason this is written down.

The blink is watched for passively: people blink every few seconds unprompted, so most captures just
happen while the phone is held up, and "Blink" only appears if one is overdue. The still is taken on the
blink, with the face held in the oval.

`face_liveness_required` adds **a head turn** on top. That costs a few seconds more and also defeats a
short recorded video played to the camera, which a blink alone does not.

What neither does: this is not a certified presentation-attack detector (ISO/IEC 30107-3). A video of
the person blinking, played to the camera, passes the blink check, and nothing here resists a mask. A
division that needs attendance to be hard to fake should turn the head turn on as well, or use the
fingerprint scanner, which no picture or video can satisfy.

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

