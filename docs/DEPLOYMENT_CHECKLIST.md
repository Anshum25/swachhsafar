# Swachh Safar Production Deployment Checklist

## 1. Environment & Configuration Variables
Before starting the backend in production (`ENVIRONMENT=production`):

- [ ] **`DATABASE_URL`**: Verified connection string to PostgreSQL with SSL (`sslmode=require`).
- [ ] **`OTP_PEPPER`**: Random secret string of at least 32 characters (do not use "CHANGE_ME").
- [ ] **`FIREBASE_CREDENTIALS_FILE`**: Valid absolute path to the production Firebase Admin Service Account JSON.
- [ ] **`FIREBASE_PROJECT_ID`**: Production Firebase project ID.
- [ ] **`FIREBASE_WEB_API_KEY`**: Web API key of the Firebase project for server-side Identity Toolkit authentication.
- [ ] **`AUTH_REQUIRE_BACKEND_SESSION=true`**: Enabled so direct Firebase tokens are rejected.
- [ ] **`STORAGE_BACKEND`**: Set to `local` (with absolute `LOCAL_MEDIA_DIR`) or `firebase`.
- [ ] **`CORS_ORIGINS`**: Explicitly set to production domain (e.g. `'["https://ehk.itfarmer.in"]'`).
- [ ] **`SMS_PROVIDER=http`**: Configured with production DLT `SMS_SENDER_ID` and `SMS_LOGIN_TEMPLATE_ID`.
- [ ] **`VPN_PROVIDER`**: Set to `cidr` (with CIDR file) or `http` (with reputation endpoint).

---

## 2. Database Migrations
Run Alembic migrations to apply all security tables:
```bash
cd backend
.venv/bin/alembic upgrade head
```
Verify the following tables exist:
- `devices`
- `auth_sessions`
- `captcha_uses`
- `login_otps`
- `login_attempts`
- `security_events`
- `face_enrollments`

---

## 3. Frontend PWA Build & Service Worker
Build production distribution:
```bash
npm run build
```
Verify:
- `dist/index.html` is generated.
- `dist/serviceWorker.js` is generated.
- Production Content Security Policy (CSP) is active in nginx headers (`deploy/nginx/security-headers.conf`).

---

## 4. Reverse Proxy & Systemd Service
1. Check nginx proxy configuration:
   - `X-Forwarded-For` correctly set.
   - SSL/TLS certificate valid and auto-renewing.
   - Media directory `/var/media` writable by service user.
2. Restart backend service:
   ```bash
   systemctl restart swachhsafar-backend
   systemctl status swachhsafar-backend
   ```
3. Test health probe:
   ```bash
   curl -I https://ehk.itfarmer.in/api/v1/health
   ```

---

## 5. Post-Deployment Verification
- [ ] Open https://ehk.itfarmer.in in Chrome. Confirm startup security check acquires GPS fix.
- [ ] Sign in with provisioned Employee ID and password; verify ALTCHA CAPTCHA solves automatically.
- [ ] Sign in with registered mobile number and OTP; verify SMS arrives.
- [ ] Open **Security Status** screen: verify all status rows show green/verified.
- [ ] Turn on airplane mode: verify app continues functioning in offline mode with active signed 24h lease.
- [ ] Mark single employee attendance with facial liveness check.
- [ ] Reconnect internet: verify queued attendance and security events synchronize cleanly.

