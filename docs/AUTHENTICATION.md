# Swachh Safar Authentication Architecture

## 1. Architectural Model
Authentication is entirely owned and issued by FastAPI, using Firebase Authentication solely as the identity token provider for downstream API authorizations. Direct client-side sign-ins (such as calling Firebase `signInWithEmailAndPassword`) are disallowed in production when `AUTH_REQUIRE_BACKEND_SESSION=true`.

```
+----------+             +--------------------+             +------------------+
| Frontend |             |  FastAPI Backend   |             |  Firebase Auth   |
+----+-----+             +---------+----------+             +--------+---------+
     |                             |                                 |
     | 1. Solve ALTCHA PoW         |                                 |
     |---------------------------->|                                 |
     |                             |                                 |
     | 2. POST /auth/login         |                                 |
     |    (Employee ID, password,  |                                 |
     |     PoW, device info)       |                                 |
     |---------------------------->|                                 |
     |                             | 3. Validate PoW & Lockout       |
     |                             | 4. Verify Identity Toolkit API  |
     |                             |-------------------------------->|
     |                             | 5. Create AuthSession & Device  |
     |                             | 6. Mint Custom Token (sid, did) |
     |                             |-------------------------------->|
     | 7. Return custom token      |                                 |
     |<----------------------------|                                 |
     |                             |                                 |
     | 8. signInWithCustomToken    |                                 |
     |-------------------------------------------------------------->|
     |                             |                                 |
     | 9. Load /auth/me & Lease    |                                 |
     |---------------------------->|                                 |
     | 10. Cache signed lease      |                                 |
     |<----------------------------|                                 |
```

---

## 2. Supported Authentication Workflows

### Method A: Employee ID + Password + CAPTCHA
1. User enters Employee ID (e.g. `CR-10492`) or provisioned corporate email and password.
2. Web Worker solves background ALTCHA SHA-256 proof-of-work challenge issued by `GET /auth/captcha`.
3. Credentials, solution, and canonical device identity are submitted to `POST /auth/login`.
4. FastAPI checks sliding window brute-force lockout table (`login_attempts`).
5. Backend verifies password via Google Identity Toolkit REST API.
6. Backend creates an `AuthSession` and issues a Firebase Custom Token containing `sid` (session ID) and `did` (device ID) claims.
7. Frontend exchanges custom token via `signInWithCustomToken` and retrieves signed 24h authorization lease.

### Method B: Registered Mobile Number + OTP
1. User enters 10-digit Indian mobile number (`^[6-9][0-9]{9}$`).
2. Web Worker solves ALTCHA CAPTCHA.
3. Frontend submits `POST /auth/otp/request`. Generic response prevents phone number enumeration.
4. Active users receive a 6-digit OTP via the configured Indian SMS gateway with approved DLT template.
5. User enters 6-digit OTP code before 300-second expiration.
6. Frontend calls `POST /auth/otp/verify`.
7. Successful validation issues a Firebase custom token bound to the employee session and device.

---

## 3. Session Revocation & Device Management
- **Logout:** Calling `signOut()` invokes `POST /auth/logout`, setting `revoked_at = utcnow()` and `revoke_reason = "logout"`.
- **Administrative Revocation:** Administrators can revoke compromised devices via `POST /security/devices/{id}/revoke`. This revokes all active sessions bound to that device ID.
- **Session Validation:** On every operational API call, FastAPI extracts `sid` from token claims and rejects revoked sessions with HTTP 401 (`session_revoked`).

