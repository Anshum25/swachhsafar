# Indian SMS Gateway & DLT Configuration Guide

## 1. Compliance Requirements (TRAI DLT)
In accordance with Telecom Regulatory Authority of India (TRAI) Distributed Ledger Technology (DLT) regulations, all transactional and service implicit SMS sent to Indian mobile numbers (`+91`) must originate from a registered Principal Entity (PE ID), use an approved 6-character Sender ID (Header), and match a registered Content Template ID.

---

## 2. Environment Variables Configuration

Set these variables in `/var/www/html/swachhsafar2.0/swachhsafar/backend/.env`:

```ini
# Enable the HTTP SMS gateway adapter
SMS_PROVIDER=http

# Provider Gateway HTTPS endpoint (e.g. CDAC, NIC SMS Gateway, Textlocal, Gupshup, ValueFirst)
SMS_API_URL=https://api.sms-gateway-provider.in/v1/send

# Provider API Key / Bearer Token
SMS_API_KEY=your_production_secret_api_key

# 6-Character TRAI Approved DLT Sender ID (Header)
# E.g. NRISMS, CRISMS, RLYSVR, SWSFAR
SMS_SENDER_ID=SWSFAR

# TRAI Approved Template ID for Passenger Feedback OTP
SMS_TEMPLATE_ID=1107161234567890123

# TRAI Approved Template ID for Employee Sign-In OTP
SMS_LOGIN_TEMPLATE_ID=1107169876543210987

# SMS API Call Timeout in seconds
EXTERNAL_TIMEOUT_SECONDS=15.0
```

---

## 3. Approved Message Templates

### Employee Sign-in OTP Template
- **DLT Template Name:** `SWACHH_SAFAR_LOGIN_OTP`
- **DLT Template Type:** Service Implicit / Transactional
- **Registered Template Text:**
  ```
  {#var#} is your Swachh Safar sign-in code. It expires in 5 minutes. Do not share it. - Indian Railways
  ```

### Passenger Feedback OTP Template
- **DLT Template Name:** `SWACHH_SAFAR_FEEDBACK_OTP`
- **DLT Template Type:** Service Implicit / Transactional
- **Registered Template Text:**
  ```
  {#var#} is your Swachh Safar feedback verification code. - Indian Railways
  ```

---

## 4. Test Double for Automated Environments
When `SMS_PROVIDER=disabled` or in automated pytest suites:
- OTPs are verified in test mocks without external HTTP calls.
- The system handles gateway failure gracefully by returning code `sms_unavailable`.


## Update 2026-11-06: why no SMS arrived, and MSG91 setup

**Root cause.** Production had `SMS_PROVIDER=disabled`; no gateway was ever called. Requests for numbers that are not registered (and resends during the cooldown) still answered 200 by design (no account enumeration), so the screen looked successful. Now:
- With SMS disabled, every OTP request answers `503 sms_unavailable` (the same for every number). Nothing pretends a code was sent.
- The login screen says "If +91 … is registered, a code has been sent by SMS", never "delivered".
- Each send is recorded as a security event: `sms.otp.accepted` (gateway message id; delivery `unknown`) or `sms.otp.failed` (category: unreachable / auth / rejected / gateway_http_error). Recorded fields: provider, last-2-digit-redacted number, message id, category, correlation id. Never the code, the key or the full number.
- Administrators (users.manage): `GET /api/v1/security/sms/status` shows the configured provider (which fields are set, never their values) and the last 50 attempts.
- Delivery reports (handset delivery) are not connected yet; "accepted" means the gateway took the message.

**MSG91 (adapter `SMS_PROVIDER=msg91`, Flow API `POST https://control.msg91.com/api/v5/flow`).** The administrator obtains:
1. DLT registration (on the operator's DLT portal, e.g. Jio / Vi / Airtel): **Principal Entity ID**, an approved **Header (sender ID)**, and an approved **Service-Implicit/Transactional OTP content template**, e.g. `{#var#} is your Swachh Safar sign-in code. It expires in 5 minutes. Do not share it. - <Entity name>`; note its **DLT Template ID**.
2. In MSG91: add the sender ID and entity ID, create a template with that exact text using variable `##otp##`, and link the DLT Template ID. Note the **MSG91 template id** and the **authkey**.
3. In `/etc/swachhsafar/backend.env`: `SMS_PROVIDER=msg91`, `SMS_API_KEY=<authkey>`, `SMS_LOGIN_TEMPLATE_ID=<MSG91 template id>`, optionally `SMS_DLT_ENTITY_ID=<entity id>` (recorded for reference), then `sudo systemctl restart swachhsafar-api`.
4. Real test: sign in by mobile with a registered employee's number; check the handset, then `GET /api/v1/security/sms/status` for `accepted` with a message id. If MSG91 refuses (wrong template/sender), the event shows `failed` with the gateway's message.

Other DLT-compliant gateways: use `SMS_PROVIDER=http` (generic JSON POST) if its API matches, or add an adapter next to `Msg91SmsProvider` in `backend/app/providers/external.py`.
