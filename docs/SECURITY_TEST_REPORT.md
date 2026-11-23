# Swachh Safar Security Test & Verification Report

## 1. Test Execution Summary

| Test Suite | Tests Run | Passed | Skipped | Failed | Duration |
|---|---|---|---|---|---|
| Backend Pytest Suite (PostgreSQL/SQLite) | 120 | 112 | 8 | 0 | 65.44s |
| Frontend Vitest Unit Test Suite | 229 | 224 | 5 | 0 | 15.97s |
| Offline Lease & Security Session Suite | 9 | 9 | 0 | 0 | 0.27s |
| Production Vite PWA Bundle Build | 143 modules | Clean | 0 | 0 | 1.42s |

---

## 2. Key Verified Test Scenarios

### Authentication & Sessions
- `test_captcha_once_only_and_checked`: Proof-of-work CAPTCHAs can only be used once; replay fails immediately.
- `test_password_login_creates_session`: Password sign-in checks Identity Toolkit, registers canonical device, and mints custom token with session claims.
- `test_auth_require_backend_session`: Direct Firebase ID tokens without backend session claims are rejected when backend enforcement is enabled.
- `test_login_lockout_after_failures`: 5 consecutive failed attempts trigger a 15-minute lockout.
- `test_otp_login_and_attempt_limits`: Request OTP prevents user enumeration; verification limits incorrect attempts to 5 before code invalidation.
- `test_session_and_device_revocation`: Revoking a device invalidates all associated sessions.

### Offline Authorization Lease
- `test_offline_lease_issuance_and_verification`: Backend signs 24-hour lease using HMAC-SHA256. Tampered employee ID or device ID is rejected.
- `test_offline_lease_capped_at_24_hours`: Requests for longer offline allowances are hard-capped at 24.0 hours.
- `securitySession.test.js`: Client-side verification confirms clock rollback detection and device/employee identity binding.

### Device Security & Network Verification
- `test_capture_evidence_rejection`: Server rejects records with stale GPS (>120s), inaccurate GPS (>100m), mock locations, or active VPNs when policy is "block".
- `test_impossible_travel_detection`: Sequential records with speed > 250 km/h are flagged as suspicious travel.
- `test_security_events_sync_batch`: Device-recorded security events sync through outbox without exposing secrets or biometrics.
- `securitySession.test.js`: PWA fail-closed logic verified for unconfirmed offline VPN states.


## Continuation run — 2026-11-06

Changes in this run:
- `src/app/session.jsx`: removed the unused `directFirebase` option (it allowed a CAPTCHA-free client-side password sign-in).
- `src/services/operationsQueue.js`: `/sync/batch` now always uses the canonical device id from `src/security/device.js`; the outbox `device_id` meta is rewritten to match it.
- `src/security/SecurityProvider.jsx`, `src/pages/SecurityStatus.jsx`: offline expiry and remaining time come from the validated signed lease. A missing lease counts as expired. `fetched_at` is now only a secondary cap of at most 24 h.
- `backend/app/services/auth.py`: tokens whose `did` claim differs from the session's device are rejected (`session_device_mismatch`).
- Tests: added `test_session_token_device_claim_must_match_session` and `test_sync_batch_rejects_other_device_id`. Fixed two stale SQLite tests: the hardcoded Alembic head `0002` is now computed, and the face test reads after ending its WAL read snapshot. Neither was a product defect.

Actual results:
| Suite | Result |
|---|---|
| Backend, PostgreSQL | 112 passed, 8 skipped (SQLite-only tests) |
| Backend, SQLite (`TEST_DB=sqlite`) | 119 passed, 1 skipped |
| Backend security tests | all passed (including the 2 new ones) |
| Frontend unit (vitest) | 226 passed, 5 skipped |
| Vite production build | succeeded |
| Playwright offline e2e | **NOT RUN** — port 4175 was held by an orphaned `vite preview` process that the session was not permitted to stop |
| Android build / device testing | **NOT DONE** — no JDK, Android SDK or test device on the server |
| Real SMS gateway | **NOT TESTED** — only the fake provider is configured |

---

## Face attendance anti-spoofing — 2026-11-23

Change: server-issued random liveness challenge + on-device depth check, gallery input removed from all
attendance paths, server-side challenge enforcement (see docs/SECURITY.md, "The face check").

### Automated results (this run)

| Suite | Result |
|---|---|
| Backend pytest, `TEST_DB=sqlite` | 218 passed, 1 skipped (17 new in `tests/test_liveness.py`) |
| Backend pytest, embedded PostgreSQL | **NOT RUN** — `pgserver` failed to start on this machine (psql exit 1) |
| Frontend vitest | 493 passed (26 new: `livenessChallenge`, `livenessTickets`, `depthCheck`) |
| Vite production build | succeeded |
| Playwright e2e | **NOT RUN** |

### Scenario matrix

"Automated" means unit/API tests with mocked frames or hand-built requests. They prove the decision logic
and the server's enforcement, **not** that a real camera, model and phone behave as assumed.

| Scenario | Expected | Automated test | Real device |
|---|---|---|---|
| Live employee in front of camera | Accept | `test_live_employee_accepted`; challenge passes with live-person frames | **NOT DONE** |
| Existing photo opened from gallery | Reject | No gallery/file input exists in attendance (code removed); server rejects capture without proof | **NOT DONE** |
| Printed photograph shown to camera | Reject | Static frames time out; moved/tilted flat image never registers a turn; depth check rejects flat geometry | **NOT DONE** |
| Photo displayed on another phone | Reject | As above (flat surface) | **NOT DONE** |
| Screenshot on another device | Reject | As above (flat surface) | **NOT DONE** |
| Prerecorded video replay | Reject | Clip for a different sequence fails; wrong-direction movement fails | **NOT DONE** — expected weakest case, see limits |
| Employee does not perform the action | Reject | `the employee not performing the requested action is refused` | **NOT DONE** |
| Incorrect employee face | Reject | `test_incorrect_employee_face_still_rejected_with_valid_liveness` | **NOT DONE** |
| Multiple faces in frame | Reject | `more than one face in the frame fails the attempt` | **NOT DONE** |
| Camera permission denied | Reject | Handled in `LiveFaceCapture` (no automated test) | **NOT DONE** |
| Camera disconnected mid-check | Reject | Handled via `track.onended` (no automated test) | **NOT DONE** |
| Replayed verification evidence | Reject | `test_reused_challenge_and_replayed_evidence_are_rejected` | n/a (server) |
| Reused challenge token | Reject | same; plus `livenessTickets` single-use tests | n/a (server) |
| Direct API request without verification | Reject | `test_direct_api_request_with_only_a_face_match_is_rejected`, `test_forged_challenge_is_rejected` | n/a (server) |
| Valid offline capture + sync | Accept after validation | `test_offline_capture_syncs_with_its_proof_and_cannot_skip_it` | **NOT DONE** |

### Still to do before relying on this in the field

1. Real-device runs on the Android APK and the PWA (Chrome on Android), each with: live employee, printed
   photo, photo on a second phone, screenshot on a laptop screen, prerecorded video of the employee doing
   each action, wrong employee, two people in frame, camera permission denied, camera unplugged/blocked.
2. Calibrate `turnYaw`, `pitchDelta`, `DEPTH_MIN` and the server's `MIN_DEPTH_SCORE` from those runs: log
   `depth_score` for live faces vs flat images (it is stored in `attendance.security.liveness_proof`).
3. Re-run the backend suite on PostgreSQL.
