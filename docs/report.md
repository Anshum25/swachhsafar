# Swachh Safar production stack

What the system is built from, where biometric data lives, how matching and offline sync actually work,
and what the deployment depends on.

| | |
|---|---|
| App | 2.0.4 (versionCode 20004037) |
| Backend | 2.0.0 |
| Package | `in.itfarmer.swachhsafar` |
| Compiled from | the repository as of 18 November 2026 |

Figures below are what the code enforces today, not targets. Where this says a value is configurable, it
is set per division in **Master data → Division policy**.

---

## 1. The short answers

**Does fingerprint work on any device? No — one scanner.**
Only the ACPL / Access Computech **AST300** over USB OTG, and only inside the Android APK. Capture is an
Android intent into ACPL's companion app; no other scanner has a code path. Section 7 covers what adding
one costs.

**Where does biometric matching happen? On the device.**
Both face and fingerprint are matched on the phone, offline. The server stores the templates and
re-checks the score the device reports, but never recomputes it.

**What works without a network? Everything operational.**
Capture of every record, both biometric checks, and all reads of synced data. Writes queue in SQLite and
deliver later. The offline window is capped at 24 hours.

**What external services are mandatory? Two.**
PostgreSQL only. Sign-in (passwords, sessions) lives in PostgreSQL since November 2026. SMS, geocoding, PNR lookup and Google Maps are each optional
and currently off or unset except Maps. Section 8.

---

## 2. Technology stack

One codebase produces three artefacts: a PWA served over HTTPS, an Android APK wrapping the same bundle,
and a Python API. Versions are what the repository pins today.

### Client — PWA and APK

| Component | Technology | Version | Role |
|---|---|---|---|
| UI framework | React | 19.3.1 | No router library; hash routing is hand-rolled |
| Build | Vite | 8.3.5 | Single bundle, code-split off |
| Styling | Tailwind CSS | 4.3.4 | Via `@tailwindcss/vite`; design tokens in `index.css` |
| Native shell | Capacitor | 8.6.2 | Android only; two custom Kotlin plugins |
| Local database | `@sqlite.org/sqlite-wasm` | 3.54.1 | SQLite in OPFS, SyncAccessHandle Pool VFS, in a worker |
| Face recognition | `@vladmandic/face-api` | 1.7.15 | TensorFlow.js; WebGL backend, CPU fallback |
| Auth client | own (`src/security/authToken.js`) | — | Bearer session token issued by our backend |
| Offline shell | `vite-plugin-pwa` + Workbox | 2.0 / 7.4 | injectManifest; the APK runs no service worker |
| Fonts | `@fontsource-variable/inter` | 5.3 | Self-hosted, so the app does not need a font CDN |
| Tests | Vitest, Playwright | 5.1 / 1.64 | 298 unit tests; e2e suites for live and offline |

### Android

| Item | Value | Note |
|---|---|---|
| minSdk / target / compile | 26 / 36 / 36 | Android 8.0 and above |
| Language / JDK | Kotlin, JDK 21 | Capacitor 8 requires 21 |
| Release build | R8 minify + resource shrink | Keep rules required for `com.acpl.**` |
| Custom plugins | `SwachhFingerprint`, `SwachhSecurity` | Scanner; device, network and location integrity |
| Signing | Keystore in CI secrets | Certificate pinned in `latest.json` |
| Distribution | Self-hosted APK | Sideloaded; no Play Store listing |

`versionName` and `versionCode` are derived from `package.json` plus the CI run number, so every release
installs over the last one (see `docs/ANDROID_SETUP.md`).

### Backend and infrastructure

| Component | Technology | Version | Role |
|---|---|---|---|
| API | FastAPI + Uvicorn | ≥0.115 / ≥0.30 | Python ≥3.12, run under systemd |
| ORM / migrations | SQLAlchemy + Alembic | ≥2.0.36 / ≥1.13 | `alembic upgrade head` runs on service start |
| Database | PostgreSQL via psycopg | ≥3.2 | Runs in a Docker container on the app host |
| Validation | Pydantic + pydantic-settings | ≥2.9 | Strict models; unknown fields rejected |
| Identity | PostgreSQL + scrypt (`hashlib`) | — | Password hashes in `user_credentials`; opaque session tokens |
| HTTP client | httpx | ≥0.27 | Outbound calls to SMS, geocoding, PNR |
| Upload handling | python-multipart, filetype | ≥0.0.9 / ≥1.2 | Media uploads and content-type sniffing |
| Media storage | Local disk or Firebase Storage | configurable | `storage_backend`; defaults to local |
| Web server | nginx | — | TLS, static bundle, `/downloads/` APK serving |
| Scheduled units | systemd timers | — | Certificate renewal; database backup |
| CI/CD | GitHub Actions → SSH forced command | — | Builds, signs, ships; server runs `receive-release.sh` |
| Backend tests | pytest + pgserver | ≥8 / ≥0.1.4 | Spins up a throwaway PostgreSQL |

---

## 3. Data stores

Two databases hold operational data, and the phone's copy is authoritative until the server acknowledges
a record.

- **On the phone — SQLite.** In OPFS, file `swachh_safar_local.db`, opened in a dedicated worker.
  11 schema migrations, applied forward only.
- **On the server — PostgreSQL.** Schema owned by Alembic, migrated automatically when the API service
  starts.
- **Photos and media — OPFS, then disk.** Bytes land in device storage first, upload later, and are
  referenced by an id generated at capture.

The local schema carries reference data, identity and permissions, journeys and staff allocation,
attendance, coach inspections, feedback, complaints, inventory, media metadata, sync conflicts,
tombstones, checkpoints, audit events, security events, and the two biometric profile tables.

> **OPFS requires a secure context.** The browser build refuses to open its database over plain HTTP; the
> APK serves its pages from `https://localhost`, which satisfies this.

---

## 4. Offline capture and sync

Every operational write is local first. Nothing waits on the network, and nothing is reported as saved to
the server until the server says so.

1. **Capture.** The record is validated against local data and business rules. Media bytes are written to
   device storage, then media metadata, the record itself, its `sync_outbox` operation and an audit event
   commit in a **single SQLite transaction**. Success means durable on this device.
2. **Push.** Queued operations deliver through `POST /sync/batch`. Media uploads first (`POST /media`,
   then the content `PUT`), because a record referencing missing media is useless. Ids are generated at
   capture, so a re-run of an interrupted upload is idempotent server-side.
3. **Acknowledge.** An operation is marked complete, and its record marked `synced`, only on explicit
   server acknowledgement. Delivery is per-owner: operations sync for the user who captured them.
4. **Pull.** `GET /sync/changes?since=<cursor>` returns master data, divisions, policies, journeys with
   staff, and both biometric profile sets. Master data applies in one transaction, each journey in its
   own, and the cursor checkpoint only advances if nothing failed.

| | |
|---|---|
| Offline session cap | **24 h** hard maximum. `offline_session_hours` can lower it; a backend-signed lease is authoritative. |
| Biometric profile freshness | **7 days**. A phone receives templates only for staff on journeys it supervises ending within the last 7 days. |
| Profile delivery | **Full set.** Both profile tables are replaced wholesale on every pull, so a revoked registration disappears at the next sync. |

---

## 5. Face verification

Photographs of a face are never stored for verification. What is stored is a descriptor: 128
floating-point numbers produced by the recognition model.

| Stage | Where | What happens |
|---|---|---|
| Enrolment | Admin's device | 4 photos. Each becomes a 128-float descriptor on the device. All four must be the same person — pairwise distance ≤ 0.6 — or enrolment is refused. |
| Storage | Postgres `face_enrollments` | Descriptors as JSON, plus the model name `faceapi-resnet128-v1`, consent timestamp, and who recorded it. No images. |
| Distribution | `/sync/changes` | Only for divisions with face verification on, and only for staff the device's user supervises. |
| Capture | Phone camera | Taken by the app from the live camera. A gallery photo is never accepted where a face is matched. |
| Liveness | On device | A blink is always required. Eye openness is read from the pixels every 45 ms, not from landmark geometry. A head turn is additionally required when `face_liveness_required` is on. |
| Matching | On device, offline | Euclidean distance to the nearest registered descriptor, compared with `face_match_threshold` (default 0.5, settable 0.3–0.7). Lower is stricter. |
| Server check | Postgres | Rejects the attendance if the reported distance exceeds the division threshold, and if liveness was required but not passed. |

> **Scope of the liveness check.** It defeats a photograph on paper or on another phone's screen. It does
> not defeat a video of the person played to the camera, nor a mask, and it is not a certified
> presentation-attack detector (ISO/IEC 30107-3). See `docs/SECURITY.md`.

---

## 6. Fingerprint verification

Minutiae templates only — the coordinates and angles of ridge features. No fingerprint image is produced,
stored or transmitted, which is the difference that matters if the database ever leaks.

| Stage | Where | What happens |
|---|---|---|
| Capture | ACPL companion app | An Android intent (`in.acpl.fp.capture`) into `com.acpl.fingerscannersupport`, which drives the scanner and returns an ISO/IEC 19794-2 template. |
| Enrolment | Admin's device | 4 presses per finger, at least 2 fingers. Several presses because one records only the part of the fingertip that touched the sensor. |
| Storage | Postgres `fingerprint_enrollments` | JSON `[{finger, templates[]}]`, max 4 KB per template, with format, matcher id, consent timestamp and recorder. |
| Distribution | `/sync/changes` | Same rule as faces: verification on, supervised staff, last 7 days. |
| Matching | On device, in Kotlin | Our own matcher, not the vendor's. Minutiae are located in the record, aligned on anchor pairs, and counted within 12 px and 15°. |
| Scoring | On device | Percentage of the smaller print that matched. Zero below 12 matched minutiae — the forensic floor. Compared with `fingerprint_match_score` (default 40, settable 30–100). |
| Server check | Postgres | Refuses if nothing is registered, if the matcher id differs from the one at enrolment, or if the score is under the division threshold. |

> **The matcher id is a lock.** Templates are tagged `acpl_ast300`. A score from a different matcher is
> never compared against them — it is reported as unusable instead. Changing scanner vendor therefore
> requires re-enrolling every employee.

Full detail, including the two parser faults found in November 2026 and the tests that now hold the line,
is in `docs/FINGERPRINT.md`.

---

## 7. Hardware support

| Platform | Face | Fingerprint | Why |
|---|---|---|---|
| Android APK + AST300 | Yes | **Yes** | The only combination where both work |
| Android APK, no scanner | Yes | No | Control is hidden; attendance falls back to face |
| Browser / PWA | Yes | No | No Capacitor plugin exists in a browser |
| Any other USB scanner | Yes | No | No capture path; see below |

Three things bind the current implementation to ACPL:

- **The companion app.** Capture is an intent into `com.acpl.fingerscannersupport`. If it is not
  installed, the plugin reports no scanner.
- **The USB filter.** The manifest auto-launches on vendor id `0x34FC` (Access Computech), so plugging in
  any other device does not wake the app.
- **The matcher id.** Enrolments are tagged `acpl_ast300` and are refused against anything else.

**What adding a second scanner costs.** The matcher itself is vendor-neutral: it reads ISO/IEC 19794-2
and locates the minutiae block across the dialects vendors ship. So a scanner whose Android SDK returns
ISO templates needs a new capture path in the plugin and a new matcher id — a contained piece of work,
roughly a week with hardware in hand. Staff enrolled on the old scanner must be enrolled again.

A scanner that only offers a UIDAI RD Service **cannot be used at all**: it returns a PID block encrypted
for UIDAI, which cannot be stored or compared locally.

---

## 8. Server dependencies

Two are load-bearing. The rest degrade to a named, visible limitation rather than an error.

| Service | Status | Used for | Without it |
|---|---|---|---|
| PostgreSQL | **Required** | All server state | No API |
| Firebase Storage | Optional | Media, when `storage_backend=firebase` | Local disk is the default |
| SMS gateway | Off | OTP sign-in (MSG91 or generic HTTP) | OTP answers "unavailable"; password sign-in unaffected |
| Google Maps JS | Configured | Maps on capture screens, browser reverse geocoding | Coordinates shown instead; nothing blocks |
| Geocoding (server) | Off | Address stamped on photos | Falls back to the browser key, then to coordinates |
| PNR lookup | Off | Passenger feedback PNR validation | Feature degrades per division policy |

> **Maps keys are of two kinds.** The browser key is referrer-restricted and ships in the bundle by
> design; it must allow `https://localhost` or maps fail inside the APK. Server-side geocoding needs a
> separate key restricted by server IP.

---

## 9. Before production

Ranked by what would hurt most if left as it is.

**Design — biometric scores are computed by the device and trusted by the server.**
The server re-checks the number against the threshold but cannot recompute a distance or a match score
from what it stores. A modified client could submit a passing score. Mitigate with the existing audit
trail and device integrity signals, and treat biometric attendance as strong evidence rather than proof.

**Accuracy — the fingerprint matcher is ours, and has no measured error rates.**
It is a minutiae matcher written for this app, not a certified vendor matcher. There are no FAR/FRR
figures for it. Before wide rollout, measure it against real enrolments: a few hundred genuine pairs and
a few thousand impostor pairs will show where the threshold belongs.

**Operations — single host, single database container.**
API, PostgreSQL and media all sit on one machine. Backups run on a systemd timer. There is no replica and
no tested restore path — rehearse a restore before go-live.

**Distribution — the APK is sideloaded, not from the Play Store.**
Updates rely on each phone noticing `latest.json` and the user installing. No staged rollout, no crash
reporting, and no remote kill switch for a bad build.

**Data — biometric data is personal data.**
Consent is recorded with every registration and only templates are kept, which is the right shape.
Retention and deletion on exit still need a written policy, and the DPDP Act obligations should be
checked against it.

**Verify — re-enrol everyone after the matcher fixes.**
Registrations taken before the current build were captured against a parser that read no minutiae. They
will not verify. Re-enrol, then confirm a genuine match and a rejected impostor on real hardware before
depending on it.
