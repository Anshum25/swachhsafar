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
