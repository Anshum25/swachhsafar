# Swachh Safar Authentication Architecture

## 1. Architectural Model
Authentication is owned entirely by the FastAPI backend and stored in PostgreSQL. No third-party identity
provider is involved: Firebase Authentication was retired in November 2026 (see §5 for the migration).

```
+----------+                         +-----------------------------------------+
| Frontend |                         |  FastAPI Backend  ──  PostgreSQL         |
+----+-----+                         +--------------------+--------------------+
     | 1. Solve CAPTCHA (GET /auth/captcha)               |
     |--------------------------------------------------->|
     | 2. POST /auth/login                                |
     |    (Employee ID or email, password, CAPTCHA,       | 3. CAPTCHA, lock-out (login_attempts)
     |     device info)                                   | 4. scrypt check against user_credentials
     |                                                    | 5. auth_sessions row + device registered
     | 6. { access_token, session_id, device_id }         |
     |<---------------------------------------------------|
     | 7. Every API call: Authorization: Bearer <token>   | 8. token → session → user (revocation,
     |--------------------------------------------------->|    device block, idle expiry checked)
     | 9. GET /auth/me → profile, permissions, signed     |
     |    24 h offline lease                              |
```

### Where each piece lives (PostgreSQL)

| Table | Holds |
|---|---|
| `users` | The employee: Employee ID, name, email, mobile, role, division, status. `firebase_uid` is history only. |
| `user_credentials` | One row per employee with a password: the hash, where it came from (`admin`, `user`, `cli`, `firebase`), when it was set. Kept apart from `users` so no user query or response can carry it. |
| `auth_sessions` | One row per sign-in: user, device, method, `token_hash` (SHA-256 of the token secret), last seen, revocation. |
| `devices` | Each phone/browser installation; an administrator can revoke one. |
| `face_enrollments` / `fingerprint_enrollments` | The employee's biometric templates, keyed by the same `users.id`. |
| `user_auth_profiles` (view) | Each employee with password, face and fingerprint registration side by side, plus last sign-in. For reporting and support. |

### Password hashes
`scrypt` (N = 2^15, r = 8, p = 1, 16-byte salt), stored as a self-describing string
(`scrypt$ln=15,r=8,p=1$<salt>$<hash>`). Hashes imported from Firebase are stored in Firebase's own scrypt
variant (`fbscrypt$...`) and replaced by a native hash the first time their owner signs in. An unknown
Employee ID costs the same hashing time as a wrong password, so timing does not reveal which accounts exist.

### Session tokens
`ss1.<session id>.<secret>`, where the secret is 32 random bytes. Only its SHA-256 is stored. Every API
call looks up the session, so signing out, revoking a device, or changing the password takes effect at once.
The app keeps the token in `localStorage` (`src/security/authToken.js`).

---

## 2. Supported Authentication Workflows

### Method A: Employee ID (or email) + Password + CAPTCHA
1. User enters Employee ID (e.g. `CR-10492`) or email and password.
2. A Web Worker solves the CAPTCHA proof-of-work from `GET /auth/captcha` (or the user types the number shown).
3. Credentials, solution and device identity go to `POST /auth/login`.
4. The backend checks the sliding-window lock-out (`login_attempts`), then the password against `user_credentials`.
5. It creates an `auth_sessions` row and returns `access_token`.

### Method B: Registered Mobile Number + OTP
1. User enters a 10-digit Indian mobile number; CAPTCHA as above; `POST /auth/otp/request`.
   The answer is the same whether or not the number is registered.
2. User enters the 6-digit code within 300 s; `POST /auth/otp/verify` returns `access_token`.

### Creating accounts
Administrators create employees in **Master data → Users**. A password sign-in is created with the record
when an email or a password is given (a generated password is shown once). **Create sign-in** adds one
later. There is no self-registration. From the server: `python -m app.cli set-password --emp-id X`.

### Changing a password
`POST /auth/password` with the current and new password (Profile → Change password). The server ends every
other session of that employee; the current one continues.

---

## 3. Session Revocation & Device Management
- **Logout:** `POST /auth/logout` sets `revoked_at` and `revoke_reason = "logout"`; the app deletes its token.
- **Password change:** other sessions are revoked with `revoke_reason = "password_changed"`.
- **Administrative revocation:** `POST /security/devices/{id}/revoke` blocks the device and revokes its sessions.
- **Idle expiry:** a session unused for `SESSION_IDLE_DAYS` (30) is refused.
- **Validation:** every call resolves token → session → user and answers 401 (`invalid_token`,
  `session_revoked`, `session_expired`, `device_revoked`) or 403 (`account_inactive`).

---

## 4. Offline
Offline use is unchanged: `/auth/me` returns a signed lease valid for at most 24 hours, and the authorization
is cached in SQLite. While offline the app opens with the stored token and the cached authorization; the
token is checked again on the next request that reaches the server.

---

## 5. Migration from Firebase Authentication (one-off)
Migration `0008` creates `user_credentials`, adds `auth_sessions.token_hash`, and ends every Firebase-era
session (`revoke_reason = "auth_migrated"`). After deploying:

```bash
# On the server. systemd-run is not decoration: the settings come from the unit's EnvironmentFile, so a
# plain `python -m app.cli ...` gets no DATABASE_URL or OTP_PEPPER and stops with "Field required" before
# it does anything. This runs the command as the service's own user with the service's own environment.
sudo systemd-run --pty --collect --uid=swachhsafar \
  --property=EnvironmentFile=/etc/swachhsafar/backend.env \
  --property=WorkingDirectory=/var/www/html/swachhsafar2.0/swachhsafar/backend \
  /var/www/html/swachhsafar2.0/swachhsafar/backend/.venv/bin/python \
  -m app.cli import-firebase-passwords --dry-run
```

Drop `--dry-run` to write. The same wrapper runs any other `app.cli` command on the server.

Two things it needs, and it says so plainly if either is missing:

- `firebase-admin`, which is no longer a runtime dependency. If it reports `No module named
  'firebase_admin'`:
  `sudo /var/www/html/swachhsafar2.0/swachhsafar/backend/.venv/bin/pip install -e
  '/var/www/html/swachhsafar2.0/swachhsafar/backend[firebase]'`
- `FIREBASE_CREDENTIALS_FILE` in `backend.env`, or `--credentials /path/to/service-account.json`. The
  service account must be able to read the project's password hash parameters, or the hashes it copies
  cannot be verified afterwards; the command refuses rather than importing hashes nobody can check.

For a development machine, where the settings come from `backend/.env`, the plain form still works:

```bash
cd backend
pip install ".[firebase]"                      # only needed for this step
python -m app.cli import-firebase-passwords --dry-run
```

The command reads each employee's password hash and the project's hash parameters from Firebase (read-only)
and stores them in `user_credentials`, matched by the `firebase_uid` already on the employee (or, if none,
by a *verified* email). Nobody's existing PostgreSQL password is replaced, and the command can be re-run.
Employees keep their current passwords; each hash is converted to native scrypt at the next sign-in.

Devices that were signed in through Firebase see the sign-in screen once after the update. Records waiting
on the phone are kept and sync after sign-in. After the import, Firebase is not needed: remove
`FIREBASE_WEB_API_KEY` from `backend.env`. Keep `FIREBASE_CREDENTIALS_FILE` only if
`STORAGE_BACKEND=firebase`.
