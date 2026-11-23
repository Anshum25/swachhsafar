# Swachh Safar 2.0 — Final Project Report

**Repository:** `Anshum25/swachhsafar` · **Branch:** `main` @ `4f757b6`
**App version:** 2.1.0 · **Backend version:** 2.0.0 · **Android package:** `in.itfarmer.swachhsafar`
**Report compiled:** 20 November 2026 · **Source of truth:** the code in this repository, not plans or targets

> This report is the end-to-end account of the project: what was built, what was tried and abandoned,
> every framework and tool in use, the alternative that was available at each decision, which option is
> actually better, and what should be done next. Where a figure is stated, it is what the code enforces
> today.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [What the system does](#2-what-the-system-does)
3. [End-to-end architecture](#3-end-to-end-architecture)
4. [Complete technology inventory](#4-complete-technology-inventory)
5. [Decision log — every choice, its alternatives, and the verdict](#5-decision-log--every-choice-its-alternatives-and-the-verdict)
6. [Effort log — what was attempted, what broke, what fixed it](#6-effort-log--what-was-attempted-what-broke-what-fixed-it)
7. [Tool-by-tool verdicts: what is better, and at what](#7-tool-by-tool-verdicts-what-is-better-and-at-what)
8. [Current state: completeness, tests, metrics](#8-current-state-completeness-tests-metrics)
9. [Risk register, ranked](#9-risk-register-ranked)
10. [Recommendations](#10-recommendations)
11. [Scaling and cost path](#11-scaling-and-cost-path)
12. [Appendix](#12-appendix)

---

## 1. Executive summary

Swachh Safar 2.0 is an **offline-first railway cleanliness-operations platform** for Indian Railways
divisions. One React codebase produces three artefacts — an installable PWA, an Android APK that wraps
the same bundle, and nothing else client-side — against one FastAPI + PostgreSQL backend.

**The defining engineering constraint:** staff work inside moving coaches, in tunnels, in yards, with no
network. Therefore *every operational write is local-first*. The phone's SQLite database is authoritative
until the server acknowledges a record. Nothing in the capture path waits on connectivity, and nothing is
ever reported as "saved to the server" until the server says so.

**Where the project stands.** Eleven of twelve functional checkpoints are complete or complete-for-capture;
the remaining gaps are all *online-only writes* (review/approval flows, journey administration, master-data
writes) rather than missing features. 300 device-side unit tests, 193 backend tests, 11 offline end-to-end
specs and one live-deployment spec gate every push through GitHub Actions. Biometric attendance (face +
fingerprint) works offline, on-device, with templates only — no face images, no fingerprint images.

**The three decisions that define the system, and all three were right:**

| Decision | Alternative that was available | Verdict |
|---|---|---|
| SQLite WASM on OPFS as the device database, with business rules enforced in SQL | IndexedDB / Dexie / PouchDB | **Correct, and hard to reverse.** Triggers and composite FKs make invalid records impossible to write, even from two concurrent screens. No key-value store can do that. |
| PWA + Capacitor wrapper rather than a native or Flutter app | React Native, Flutter, native Kotlin | **Correct for this problem.** One codebase, and — because the UI is HTML — the entire app can be replaced over the air without an install. |
| Over-the-air bundle replacement instead of Play Store releases or server-driven UI | Play Store staged rollout; JSON-described screens | **Correct and unusually valuable.** A fix in `src/` reaches every phone on next open. Screens stay ordinary React instead of becoming an interpreter. |

**The three things that most need attention, in order:** biometric scores are computed by the device and
only re-*checked* (not recomputed) by the server; the fingerprint matcher is in-house and has no measured
FAR/FRR; and the entire production system — API, PostgreSQL, media — runs on a single host with an
unrehearsed restore path.

---

## 2. What the system does

### 2.1 Operational modules

Registered once in `src/app/modules.js`, which drives routing, navigation and checkpoint ownership
together — a single registry rather than three lists that drift apart.

| Module | CP | Permissions gate | Offline capture |
|---|---|---|---|
| Dashboard | — | open to all | n/a |
| Journeys | CP-04 | `journeys.read`, `journeys.read_all` | read only (create/edit online) |
| Attendance | CP-05 | `attendance.submit`, `attendance.read` | **yes** — 5-stage and group |
| Coach inspection | CP-06 | `inspections.submit`, `inspections.read` | **yes** — photo + video ≤ 25 MB |
| Feedback (passenger + railway) | CP-07/08 | `feedback.*` | railway **yes**; passenger partly (PNR/OTP online) |
| Complaints | CP-09 | `complaints.create`, `complaints.read` | **yes** — create with attachment |
| Inventory | CP-10 | `inventory.read`, `inventory.transact` | **yes** — issue/return with SQL-enforced balance |
| Master data | CP-03 | 7 management permissions | reads only |
| Reports | CP-11 | `reports.read` | **yes** — device-scope figures, labelled as such |
| Profile / Security status | — | own account | yes |

### 2.2 The two biometric paths

| | Face | Fingerprint |
|---|---|---|
| Hardware | Any camera (PWA or APK) | **ACPL / Access Computech AST300 only**, USB OTG, APK only |
| Capture | Live camera; a gallery photo is never accepted | Android intent into `com.acpl.fingerscannersupport` |
| Enrolment | 4 photos, pairwise distance ≤ 0.6 or refused | 4 presses per finger, ≥ 2 fingers |
| What is stored | 128-float descriptor (`faceapi-resnet128-v1`) | ISO/IEC 19794-2 minutiae template, ≤ 4 KB |
| Matching | On device, offline — Euclidean distance vs `face_match_threshold` (default 0.5, range 0.3–0.7) | On device, in Kotlin — our own matcher; minutiae within 12 px / 15°, floor of 12 matched points |
| Liveness | Blink always (read from eye pixels every 45 ms); head turn when `face_liveness_required` | Not applicable — a print cannot be photographed into the sensor |
| Server role | Re-checks the reported distance against the division threshold | Re-checks score, matcher id (`acpl_ast300`), and that something is registered |

### 2.3 Offline guarantees, as enforced

| Property | Value | Enforced by |
|---|---|---|
| Offline session cap | **24 h hard maximum** | Backend-signed lease; `offline_session_hours` may lower it, never raise it |
| Biometric template freshness | **7 days** | `/sync/changes` only sends templates for staff on journeys the device supervises ending within 7 days |
| Template delivery | **full replacement** every pull | A revoked registration disappears at the next sync |
| Capture durability | one SQLite transaction | media_files + record + sync_outbox + audit_events commit together |
| Delivery semantics | exactly once, in order, per owner | `sync_outbox` with one-open-op-per-entity index; ids generated at capture, so retries are idempotent |

---

## 3. End-to-end architecture

```
┌──────────────────────── DEVICE (PWA in browser, or APK WebView at https://localhost) ────────────────┐
│                                                                                                      │
│  React 19 screens (hash router, no router library)                                                   │
│        │                                                                                             │
│        ├── READ  ──► localFirstApi ──► FastAPI if reachable ──► ingest into SQLite + overlay pending  │
│        │                         └──► localApi (SQLite only) when offline  → flagged "stale"         │
│        │                                                                                             │
│        └── WRITE ──► operationsQueue.submit ──► localStore.capture:  ONE TRANSACTION                 │
│                           │                      media_files + record + sync_outbox + audit_events   │
│                           │                      media bytes ──► OPFS  swachh-media/<uuid>           │
│                           │                                                                          │
│                           ├── flush ──► POST /media → PUT /media/{id}/content → POST /sync/batch     │
│                           └── pull  ──► GET /sync/changes?since=<cursor>                             │
│                                                                                                      │
│  SQLite WASM 3.54 · OPFS · SAH-pool VFS · dedicated worker · swachh_safar_local.db · schema v13      │
│  face-api.js (TF.js, WebGL→CPU) · Kotlin SwachhFingerprint · Kotlin SwachhSecurity                   │
└──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                               │ HTTPS, Bearer ss1.<session>.<secret>
┌──────────────────────────────────────────────▼───────────────────────────────────────────────────────┐
│  nginx  — TLS · security headers · gzip · rate limit (burst 120) · /downloads/ APK · static bundle   │
│     └─► uvicorn / FastAPI (systemd: swachhsafar-api.service)                                         │
│             · 16 v1 routers · Pydantic strict models · scrypt passwords · opaque session tokens      │
│             · alembic upgrade head on every service start (10 migrations)                            │
│             · StorageBackend: local disk (default) | Firebase Storage                                │
│     └─► PostgreSQL 16 in Docker, bound to 127.0.0.1:5433, volume swachhsafar_pgdata                  │
│  systemd timers: certificate renewal · database backup                                               │
└──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                               │
┌──────────────────────────────────────────────▼───────────────────────────────────────────────────────┐
│  GitHub Actions: test-web ─┐                                                                         │
│                 test-backend ─┴─► build-web ─► deploy (tar | ssh → receive-release.sh, forced cmd)   │
│                               └─► build-apk (JDK 21, Node 22, sign, verify, describe)                │
│                               └─► publish-bundle ─► POST bundle ─► point channel (rollout %)         │
│  The server never builds. It only receives finished bundles through a restricted SSH key.            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Complete technology inventory

### 4.1 Client — PWA and APK (one build serves both)

| Component | Technology | Version | Role and notable constraint |
|---|---|---|---|
| UI framework | React | 19.3.1 | No router library; hash routing hand-rolled in `src/app/router.js` |
| Build tool | Vite | 8.3.5 | Single bundle, code-splitting off deliberately (offline precache simplicity) |
| Styling | Tailwind CSS | 4.3.4 | Via `@tailwindcss/vite`; design tokens in `src/index.css` |
| Native shell | Capacitor | 8.6.2 | Android only; two first-party Kotlin plugins |
| OTA updater | `@capgo/capacitor-updater` | 8.54.2 | `autoUpdate: false` — the app decides, not the plugin |
| Device database | `@sqlite.org/sqlite-wasm` | 3.54.1 | OPFS, SyncAccessHandle Pool VFS, one dedicated worker, **requires a secure context** |
| Face recognition | `@vladmandic/face-api` | 1.7.15 | TensorFlow.js; WebGL backend with CPU fallback; 6.4 MB model precached |
| Fonts | `@fontsource-variable/inter` | 5.3 | Self-hosted, so the app never needs a font CDN (and the CSP stays tight) |
| Offline shell | `vite-plugin-pwa` + Workbox | 2.0 / 7.4 | `injectManifest` strategy; **the APK runs no service worker at all** |
| Auth client | first-party (`src/security/authToken.js`) | — | Bearer token in `localStorage` |
| Unit tests | Vitest | 5.1 | 300 cases, real SQLite (in-memory and file) |
| Browser tests | Playwright | 1.64 | 11 offline specs, 1 live-deployment spec |

### 4.2 Android

| Item | Value | Why |
|---|---|---|
| minSdk / target / compile | 26 / 36 / 36 | API 26 is the oldest WebView that reliably provides OPFS + Web Crypto, and the floor for `EncryptedSharedPreferences` |
| Language / JDK | Kotlin, JDK 21 | Capacitor 8 requires 21 |
| Release build | R8 minify + resource shrink | Keep rules required for `com.acpl.**` |
| First-party plugins | `SwachhFingerprint`, `SwachhSecurity` | Scanner capture + matching; device, network and location integrity |
| Scanner binding | USB vendor id `0x34FC` (13561) | Auto-launch filter; 15 s default capture timeout |
| Signing | Keystore in CI secrets | Certificate SHA-256 pinned in `latest.json` |
| Distribution | Self-hosted APK at `/downloads/` | Sideloaded; no Play Store listing |
| Versioning | `package.json` version + CI run number | Every release installs over the last one |

### 4.3 Backend

| Component | Technology | Version | Role |
|---|---|---|---|
| API | FastAPI + Uvicorn | ≥ 0.115 / ≥ 0.30 | Python ≥ 3.12, under systemd |
| ORM / migrations | SQLAlchemy + Alembic | ≥ 2.0.36 / ≥ 1.13 | 10 migrations; `alembic upgrade head` on service start |
| Database driver | psycopg (binary) | ≥ 3.2 | PostgreSQL 16 |
| Validation | Pydantic + pydantic-settings | ≥ 2.9 / ≥ 2.5 | Strict models; unknown fields rejected |
| Passwords | `hashlib.scrypt` | stdlib | N = 2^15, r = 8, p = 1, 16-byte salt; self-describing hash string |
| Legacy hash support | cryptography | ≥ 42 | AES-CTR, to verify hashes imported from Firebase Auth |
| HTTP client | httpx | ≥ 0.27 | SMS, geocoding, PNR |
| Uploads | python-multipart + filetype | ≥ 0.0.9 / ≥ 1.2 | Content-type sniffing, not trusting the client |
| Lint | Ruff | line-length 140 | `F`, `E9`, `B` |
| Tests | pytest + pgserver | ≥ 8 / ≥ 0.1.4 | 193 tests against a throwaway real PostgreSQL |

### 4.4 Infrastructure and delivery

| Component | Technology | Role |
|---|---|---|
| Web server | nginx | TLS, static bundle, `/api` proxy, rate limiting, `/downloads/` |
| Database host | Docker (`postgres:16`) | `127.0.0.1:5433` only, named volume, healthcheck, `--restart unless-stopped` |
| Process management | systemd | API unit + two timers (cert renewal, DB backup) |
| TLS | Let's Encrypt IP certificate (6-day profile) / private CA fallback | `make-ip-cert.sh`, `enable-letsencrypt-ip.sh`, renewal hook |
| CI/CD | GitHub Actions → SSH forced command | Server runs only `receive-release.sh` |
| Media | Local disk (default) or Firebase Storage | `storage_backend` switch, journey-wise folders |
| Captcha | ALTCHA-style self-hosted proof of work | Solved in a Web Worker; no third-party captcha service |

### 4.5 Optional / external services — and what happens without each

| Service | Status | Without it |
|---|---|---|
| PostgreSQL | **required** | No API |
| Google Maps JS | configured | Coordinates shown instead of a map; nothing blocks |
| Firebase Storage | optional | Local disk is the default |
| SMS gateway (MSG91 or generic HTTP) | off | OTP sign-in answers "unavailable"; password sign-in unaffected |
| Server-side geocoding | off | Falls back to the browser key, then to raw coordinates |
| PNR lookup (RapidAPI) | off | Passenger feedback degrades per division policy |

**Exactly one external dependency is load-bearing.** Everything else degrades to a named, visible
limitation rather than an error. That is the right shape for field software.

---

## 5. Decision log — every choice, its alternatives, and the verdict

Each row is a real decision this project made, the options that were genuinely on the table, and an
honest verdict on whether the chosen option is still the better one.

### 5.1 Client platform

| # | Decision | Alternatives considered | Why the choice won | Verdict today |
|---|---|---|---|---|
| 1 | **PWA + Capacitor** wrapper | React Native, Flutter, native Kotlin, pure PWA with no wrapper | One codebase for web and Android; native access only where it is needed (scanner, GPS integrity, VPN state) | **Keep.** The OTA mechanism in §5.4 is only possible because the UI is HTML. Flutter or React Native would have forced Play Store releases for every fix. |
| 2 | **React 19** | Vue, Svelte, SolidJS | Team familiarity, largest ecosystem, face-api/TF.js examples all assume it | **Keep.** No pain observed. Svelte would cut bundle size but the 6.4 MB face model dominates anyway. |
| 3 | **Hand-rolled hash router** (`src/app/router.js`, one registry in `modules.js`) | React Router, TanStack Router | Hash routing needs no server rewrite rules and works from the WebView's `https://localhost` origin; the module registry also drives nav and permissions | **Keep, with a caveat.** It does exactly what is needed. Revisit only if nested routes or route-level code splitting become necessary. |
| 4 | **Tailwind CSS v4** | CSS Modules, MUI, Chakra, shadcn/ui | No component-library weight; design tokens in one file; responsive from 320 px to 1920 px was achievable quickly | **Keep.** A component library would have added megabytes for screens that are mostly forms and tiles. |
| 5 | **Single bundle, code-splitting off** | Route-level lazy chunks | The service worker precaches the whole shell anyway; splitting adds offline failure modes | **Keep for now.** Reconsider only if first-load time on 2G becomes a complaint — and then split the face model, not the screens. |

### 5.2 Device data storage — the most consequential choice

| # | Decision | Alternatives considered | Why the choice won | Verdict today |
|---|---|---|---|---|
| 6 | **SQLite WASM on OPFS, SAH-pool VFS, in a dedicated worker** | IndexedDB raw, Dexie.js, PouchDB, WatermelonDB, localStorage | Real SQL: transactions across four tables, composite foreign keys, triggers, unique partial indexes | **Keep — this is the system's backbone.** |
| 7 | **Business rules enforced in SQL, not only in JavaScript** | Validate in the React layer | Two screens writing concurrently cannot bypass a trigger; a bad record is impossible, not merely unlikely | **Strongly keep.** Examples: attendance stage *n* requires *n−1*; inspection Before-before-After; a return can never exceed the issued quantity; audit events and complaint history are append-only by trigger. |
| 8 | **Outbox pattern** (`sync_outbox`, one open op per entity, owner-scoped) | CRDTs, SQLite replication, last-write-wins | Explicit, inspectable, exactly-once with server acknowledgement; owner scoping means a shared device cannot deliver another user's records | **Keep.** CRDTs would solve a conflict problem this domain does not have — records are owned by one capturer at one checkpoint. |
| 9 | **Media bytes in OPFS first, uploaded later** | Base64 into SQLite, upload at capture | Keeps the database small; the record is durable the instant the shutter closes | **Keep.** |
| 10 | **Forward-only migrations via `PRAGMA user_version`** (now v13) | Drop-and-recreate on version change, down-migrations | Field phones hold unsynced records; destroying the database would destroy work | **Keep.** The absence of down-migrations is correct here: you never roll a phone's data back, you ship a forward fix. |

> **The cost of this choice:** OPFS requires a secure context, so the browser build refuses plain HTTP, and
> only one connection per origin exists — a second tab cannot open the database. Both are accepted
> trade-offs, documented in `docs/CHECKPOINTS.md`.

### 5.3 Backend and database

| # | Decision | Alternatives considered | Why the choice won | Verdict today |
|---|---|---|---|---|
| 11 | **FastAPI** | Django + DRF, Flask, Express/NestJS, Go | Pydantic validation is the same shape as the sync contract; async for outbound HTTP; OpenAPI for free | **Keep.** Django would have brought an admin and an ORM-first worldview this API does not want. |
| 12 | **PostgreSQL 16** | Firestore, MySQL, MongoDB, SQLite on the server | Relational integrity mirrors the device schema; real constraints; JSON columns where needed | **Keep.** |
| 13 | **Firestore abandoned as the central store** (CP-12) | Continue with Firestore | Per-document billing and absent joins fit neither the reporting load nor the relational rules; the device already mirrors FastAPI service rules | **Correct call.** Firestore now holds nothing operational. `scripts/deploy-firestore-rules.mjs` is vestigial and should be removed (§10). |
| 14 | **Alembic, auto-upgraded on service start** | Manual `alembic upgrade` as a deploy step, no migrations | The deploy cannot forget it; the API refuses to serve a schema it does not own | **Keep, with a guard rail.** Right default for one host; see §10 for the long-lock risk once tables are large. |
| 15 | **Own auth in PostgreSQL** (migration `0008`, November 2026) | Keep Firebase Authentication, Auth0, Keycloak | Firebase made every authenticated call depend on a third party being reachable and on a service-account file being present (`503 auth_not_configured`); offline leases and biometric linkage want to live beside `users` | **Correct and already paid off.** One load-bearing dependency instead of two. The import path (`app.cli import-firebase-passwords`) converted existing hashes without resetting anyone's password. |
| 16 | **scrypt (N = 2^15)** | bcrypt, Argon2id, PBKDF2 | In the Python standard library — no extra dependency, no native build; strong parameters; self-describing hash string | **Good.** Argon2id is the modern first choice, but scrypt at these parameters is not a weakness, and `hashlib` costs nothing to ship. Only move if a formal standard requires Argon2. |
| 17 | **Opaque session tokens** `ss1.<session>.<secret>`, SHA-256 stored | JWT | Every call resolves the session, so logout, device revocation and password change take effect *immediately* | **Strongly keep.** Correct for a system that must revoke a lost field phone at once. JWT's stateless appeal is worthless here; you would need a revocation list, which is a session table with extra steps. |
| 18 | **Self-hosted proof-of-work CAPTCHA (ALTCHA style), solved in a Web Worker** | reCAPTCHA, hCaptcha, Turnstile | No third-party script (the CSP stays strict), no data leaving the system, works behind a private CA | **Keep.** It stops credential stuffing, which is the actual threat; it is not trying to be a bot oracle. |
| 19 | **Real PostgreSQL in tests via `pgserver`** | SQLite in tests, Dockerised Testcontainers, a shared test database | Tests exercise the same engine and constraints as production, with no Docker daemon needed on the runner | **Excellent choice.** SQLite-backed tests would have hidden Postgres-specific behaviour; Testcontainers needs privileged Docker on CI. |

### 5.4 Delivery, updates and hosting — including the Docker question

| # | Decision | Alternatives considered | Why the choice won | Verdict today |
|---|---|---|---|---|
| 20 | **PostgreSQL in a Docker container; everything else on the host** | `apt install postgresql`, full Docker Compose stack, Kubernetes, managed Postgres (RDS/Cloud SQL) | Pinned major version, isolated from the host's Python/apt world, one-command idempotent provisioning, a named volume that survives recreation, and a healthcheck the installer waits on | **Right-sized.** See the analysis below. |
| 21 | **Python API under systemd, not in a container** | Containerise the API too | systemd gives `EnvironmentFile`, restart policy, journald logs and timer units with no orchestration layer; the API needs the host's media directory anyway | **Defensible today; the first thing to revisit at two hosts.** |
| 22 | **GitHub Actions builds; the server only receives** | Build on the server (`git pull && npm ci && build`), Jenkins, GitLab CI, a self-hosted runner | The production host never needs Node, a toolchain, or repository credentials; the deploy key is a *forced command* that can only run `receive-release.sh` | **Strongly keep.** This is the single best operational decision in the project. |
| 23 | **Over-the-air web-bundle replacement** (`@capgo/capacitor-updater`, `web_bundles` + `web_channels`) | Play Store releases for every fix; server-driven UI from the database; Capacitor `server.url` pointing at the live site | A change in `src/` reaches every phone on next open, with checksum verification, a native-version gate, deterministic staged rollout and instant rollback by moving a pointer | **Keep — and the rejected options were rejected for good reasons.** |
| 24 | **Sideloaded APK from `/downloads/`, with `latest.json`** | Google Play, Play Internal App Sharing, Firebase App Distribution, MDM | No Play review latency, no account requirements for field staff, full control of the certificate | **Works, but this is the weakest link in delivery** — no crash reporting, no staged native rollout, no kill switch. §10 addresses it. |
| 25 | **nginx on the host** | Caddy, Traefik, Cloudflare Tunnel only | Mature, already present, one security-headers snippet shared by every server block — and the same snippet is replayed in `vite preview`, so e2e tests run under the production CSP | **Keep.** The CSP-in-tests trick is a genuinely good idea. |
| 26 | **Let's Encrypt IP certificate (6-day profile) + private CA fallback** | Self-signed only, a domain-only certificate, Cloudflare origin certificate | The deployment is reachable by IP *and* by `ehk.itfarmer.in`; phones need a certificate they trust without installing a CA | **Keep, but automate verification.** A 6-day certificate makes renewal failure visible within days — good — but only if someone is watching. |

#### Analysis: "is Docker still better here?"

Docker and GitHub Actions are not alternatives to each other — one is a runtime isolation tool, the other
a build/release pipeline. The project uses both, each where it belongs. The meaningful comparisons are:

**Docker for PostgreSQL vs `apt install postgresql`**

| | Docker container (chosen) | Host package |
|---|---|---|
| Version control | **Pinned `postgres:16`; a host upgrade cannot move it** | Follows the distro; a release upgrade can move the major version under you |
| Provisioning | **One idempotent script, waits for `pg_isready` health** | Several steps; locale/encoding set at initdb time by distro defaults |
| Blast radius | **Isolated; bound to `127.0.0.1:5433`** | Shares the host; listens per `pg_hba.conf` |
| Data safety | Named volume `swachhsafar_pgdata`, survives container recreation | On-disk cluster, equally safe |
| Backup/restore | Needs `docker exec`; slightly more ceremony | Native `pg_dump` paths |
| Performance | Negligible difference at this load | Marginally simpler I/O path |
| **Verdict** | **Better for this project.** Pinning and one-command reproducibility outweigh the small operational overhead. | Better only if the DBA team is strictly host-package-oriented. |

**Docker for the whole stack (Compose) vs host-native API + containerised DB (chosen)**

Compose would give one `up` command and identical dev/prod topology, but it would also containerise a
service that needs host media paths and whose logs and restart policy are already well served by systemd.
**Verdict: the current split is right at one host.** The moment a second host appears, containerise the API
too — that is the natural trigger, not an arbitrary preference.

**Kubernetes** — **no.** One API process, one database, a few hundred phones. Kubernetes would add more
moving parts than the entire application has.

**Managed PostgreSQL (RDS, Cloud SQL)** — **better than the current setup on every axis except cost and
data-residency control**: automated backups with point-in-time recovery, a tested restore path, failover.
This is the single highest-value infrastructure upgrade available (§10), and the only reasons not to take
it are budget and a requirement to keep railway data on a specific host.

**GitHub Actions vs building on the server**

| | GitHub Actions (chosen) | Server-side build |
|---|---|---|
| Toolchain on production | **None needed** | Node, JDK, Android SDK on a production host |
| Credentials on production | **None — the deploy key is a forced command** | Repository read access on the server |
| Reproducibility | **Clean runner every time** | Accumulated host state |
| Signing keys | In CI secrets, removed from disk after the step | Would live on the server |
| Cost | Free minutes, then paid | "Free", but pays in risk |
| **Verdict** | **Strongly better. Keep.** | Only for an air-gapped deployment. |

**GitHub Releases vs self-hosted `/downloads/latest.json`** — GitHub Releases would give free, fast,
CDN-backed APK hosting and a changelog for nothing. The self-hosted path was chosen because the server
describes the release from the signed APK itself (`scripts/describe-apk.py`) and pins the certificate
digest. **Verdict: the self-hosted path is better for integrity; adding GitHub Releases as a mirror would
cost nothing and improve download reliability in the field.**

### 5.5 Biometrics

| # | Decision | Alternatives considered | Why the choice won | Verdict today |
|---|---|---|---|---|
| 27 | **Templates only — never images** | Store the enrolment photo / fingerprint image | If the database leaks, 128 floats and minutiae coordinates are not a face or a print | **Strongly keep.** This is the decision that makes the system defensible under the DPDP Act. |
| 28 | **On-device matching, offline** | Server-side matching | Attendance must work in a tunnel; and the raw biometric never leaves the phone | **Keep** — but it is the root of the trust problem in §9.1. |
| 29 | **`@vladmandic/face-api` (TF.js, ResNet-128)** | MediaPipe / BlazeFace, AWS Rekognition, Azure Face, a native Android SDK | MIT-licensed, runs in a WebView, 128-float descriptors, models precached for offline use | **Keep for now.** MediaPipe is faster and lighter and would be the choice for a rebuild; cloud APIs are disqualified outright by the offline requirement. |
| 30 | **Blink liveness read from eye pixels every 45 ms** | Landmark-geometry EAR, challenge-response prompts, a certified PAD SDK | Landmark geometry proved too noisy to separate a blink from detector jitter; pixel-level openness measured against the detector's own noise floor worked | **Keep, and be honest about its limits.** It defeats a printed photo or a phone screen. It does **not** defeat a video of the person, or a mask, and it is not ISO/IEC 30107-3 certified. |
| 31 | **Our own ISO/IEC 19794-2 minutiae matcher, in Kotlin** | The vendor's matching SDK, NBIS/Bozorth3, a UIDAI RD Service | Offline, vendor-neutral at the template level, and no per-match licence; the vendor SDK would have bound the data format as well as the capture path | **Keep, but it must be measured.** It has no FAR/FRR figures (§9.2). |
| 32 | **UIDAI RD Service ruled out** | Use Aadhaar authentication | An RD Service returns a PID block encrypted for UIDAI; it cannot be stored or compared locally, which makes offline attendance impossible | **Correct and final.** Documented in `docs/FINGERPRINT.md`. |
| 33 | **Matcher id lock (`acpl_ast300`)** | Compare any template against any other | A score from a different matcher is meaningless against these templates, so it is reported unusable rather than trusted | **Keep.** The cost is that changing scanner vendor requires re-enrolling everyone — which is the honest cost, not a bug. |

### 5.6 Security posture

| # | Decision | Alternatives | Verdict |
|---|---|---|---|
| 34 | **Signed 24-h offline lease, hard-capped, with monotonic clock-rollback detection** | Trust the device clock; unlimited offline | **Keep.** The cap is enforced server-side; a division can lower it, never raise it. |
| 35 | **Native VPN / mock-location / developer-mode checks in Kotlin; fail-closed for an unverified PWA** | Trust the browser | **Keep.** The browser cannot answer these questions, so the PWA is treated as the weaker environment by policy, not by accident. |
| 36 | **Server re-validation of every capture's security envelope** | Accept the device's verdict | **Keep.** Clock skew, spatial plausibility, GPS accuracy, VPN state and session/device revocation are all re-checked. |
| 37 | **CI refuses a bundle containing secrets or demo-mode strings** | Trust the build | **Excellent.** Gates for private keys, `DATABASE_URL`, `POSTGRES_PASSWORD`, `OTP_PEPPER` and the demo banner, plus a check that the WASM file is present. |
| 38 | **Commit messages passed to scripts via environment, never spliced into a command line** | String interpolation in the workflow | **Excellent.** This is a real injection class, on a runner holding the deploy key, closed deliberately. |

---

## 6. Effort log — what was attempted, what broke, what fixed it

103 commits between **3 November and 20 November 2026**. The pattern worth noting: nearly every entry
below is a case of something being *tried*, observed to fail in the field or in CI, and replaced — not a
design arrived at on paper.

### Phase 1 — foundation (3–5 Nov)

| Attempt | Outcome |
|---|---|
| UI mock-ups, then a Stage 1 skeleton | Became the blue theme, app frame, home tiles and journey cards |
| Backend packaged as an installable Python project | Needed for the Linux test harness to work at all |
| Production CSP + Chrome installability test | Both became permanent gates |
| "Update now" did not reload in the first session | Fixed; IP deployment added in the same pass |
| `CORS_ORIGINS` parsed differently by bash and systemd | Fixed by single-quoting in `backend-env.sh` — a one-line fix that cost a deployment |
| A signed-out device started on registration | Changed to start on Sign in |
| Media stored flat | Reorganised journey-wise (`uploads/journeys/<date>_<train>_<id>/<kind>/`), with a migration that moved older uploads |
| Responsive layout 320 px–1920 px | Done; the "Offline readiness" panel removed as noise |
| Face verification | Backend first (descriptors only, consent, off by default), then on-device offline matching |

### Phase 2 — Android, security, CI (16 Nov)

| Attempt | Outcome |
|---|---|
| A Capacitor project that actually builds | Took several passes; `android/` committed only when the APK built reproducibly |
| APK reaching the server | The WebView serves from `https://localhost`, so a relative `/api/v1` pointed at the app's own assets — the APK build now carries an absolute API base, and **runs no service worker** |
| CI: `android-actions/setup-android@v3` | Failed — v3 installs the obsolete SDK package `tools`, which Google no longer publishes. Moved to v4 |
| CI: Node 20 for the APK job | Failed — the Capacitor 8 CLI refuses Node 20. That job alone moved to Node 22; the web jobs stayed on the tested Node |
| CI: default JDK | Failed — Capacitor 8 needs JDK 21 |
| CI: keystore from a base64 secret | Copy-paste added CRs and line breaks. Now stripped, and `keytool` verifies the keystore *before* a 4-minute build depends on it, with an actionable error message |
| Seven e2e specs never answered the security check | Fixed; then the last two offline specs that could not sign in |
| Sign-in with an Employee ID | The field refused anything without `@`. Fixed |
| R8 renamed the class the scanner's result is read with | Keep rules added for `com.acpl.**` |

### Phase 3 — biometrics in the field (17–19 Nov)

This is the most instructive sequence in the project: **a feature that passed its tests and still did not
work.**

| Attempt | What actually happened |
|---|---|
| Fingerprint matching, first implementation | Assumed a fixed offset for the minutiae block in the ISO template |
| "Find the minutiae in the template instead of assuming where they are" | Vendors ship dialects of ISO/IEC 19794-2; the block has to be *located* |
| Genuine fingerprints still scored **0** | Two parser faults — the matcher was reading **zero minutiae** from real templates |
| Diagnostics added: "points lined up, points read, matcher build"; template headers shown when a scan cannot be read | Made the failure legible instead of a silent zero — this is what found the remaining fault |
| Angle convention | The scanner's angle convention differed from the one assumed. Now matched whatever convention the scanner uses |
| Threshold too strict | Lowered, and made a per-division setting (`fingerprint_match_score`, default 40, range 30–100) |
| Scans spinning forever | A timeout was added |
| "No fingerprints for this person" on attendance phones | Template distribution was wrong; fixed, and documented as a named failure mode |
| **Consequence** | Registrations captured before these fixes read no minutiae and **will not verify** — everyone enrolled earlier must be re-enrolled |

Face liveness followed the same path: capture on entering the oval → hold still → hold for 600 ms →
require a blink → measure the blink against the detector's noise rather than a fixed depth → read eye
openness from the pixels many times a second. Four iterations, each because the previous one either
refused real people or accepted a photograph.

Group attendance: one group photograph → progressive employee-wise → automatic with a 1-second steady
hold. Three iterations, driven by how the camera is actually held in a coach.

### Phase 4 — auth migration and OTA (19–20 Nov)

| Attempt | Outcome |
|---|---|
| Firebase Authentication | Retired. Migration `0008` + `import-firebase-passwords` moved hashes without resetting passwords; Firebase-era sessions revoked with `auth_migrated` |
| Auth migration against a hand-edited database | The migration was made to *converge* a database somebody had edited by hand, rather than fail |
| `python -m app.cli` on the server | Did not work — no `DATABASE_URL`, no `OTP_PEPPER`. The documented form is now a `systemd-run` wrapper that borrows the service's own `EnvironmentFile` |
| Sync failing silently on a lapsed sign-in | 2.0.9 made it visible; 2.1.0 made a refused *session* stop looking like a refused *record* |
| "Network problem" for every sync failure | 2.0.8: says which problem it is |
| Blank page on group attendance | 2.0.7 |
| Release-bundle work committed by accident | Reverted cleanly |
| Deploy script exiting before its own rollback | Fixed — it now always reaches the rollback and prints why the API did not start |
| OTA path | Proven with a deliberately visible change: the dashboard greeting became `Welcome1234`, then `AAvo`, then `Welcome` — three releases whose only purpose was to watch the over-the-air path work on real phones |
| OTA, second proof | A whole temporary **Jobs** module shipped over the air, then (20 Nov) backed with a server API, Alembic `0010`, and phone schema **v13**. Removed once it had proved the path, which is the other half of a test module being honest about itself |
| "Install the APK" prompts for web-only changes | Stopped — asking people to install something for a change that arrives on its own is noise |

### What this log shows

1. **Hardware integration dominated the effort.** The scanner work — intent protocol, template dialects,
   angle conventions, R8 keep rules, timeouts, distribution — was by far the largest single cost.
2. **Tests passed while the feature was broken.** The zero-minutiae fault survived a green test suite
   because the tests used templates the parser could read. The fix came from *diagnostics in the UI*, and
   the tests that now hold the line were written afterwards.
3. **CI was configured by failure, not by reading documentation.** Four separate CI breakages (SDK action
   version, Node version, JDK version, keystore encoding) each cost a cycle.
4. **Every error message that blamed the wrong thing cost a release.** Three of the 2.0.x releases exist
   only to make a failure say what it actually was.

---

## 7. Tool-by-tool verdicts: what is better, and at what

A consolidated answer to "which is better" for every pairing this project faced. **Bold = chosen.**

### Same-category comparisons

| Question | Options | Better, and why |
|---|---|---|
| Device database | **SQLite WASM/OPFS** vs IndexedDB/Dexie vs PouchDB | **SQLite.** Only it gives multi-table transactions, triggers and composite FKs. For a simple cache, Dexie wins on size and simplicity. |
| App shell | **PWA + Capacitor** vs React Native vs Flutter vs native | **PWA + Capacitor**, because of OTA. Flutter wins on raw UI performance and native polish; neither matters here, and both lose the ability to replace the app without an install. |
| Router | **Hand-rolled hash router** vs React Router | **Hand-rolled**, for a 12-route app with a permission registry. React Router wins past roughly 30 routes or with nested layouts. |
| CSS | **Tailwind v4** vs MUI/Chakra vs CSS Modules | **Tailwind**, for forms and tiles with no design-system requirement. MUI wins when a team needs accessible complex widgets (date pickers, data grids) it will not build. |
| Backend framework | **FastAPI** vs Django+DRF vs Express/Nest | **FastAPI.** Pydantic *is* the sync contract. Django wins when you want an admin panel and batteries included. |
| Server database | **PostgreSQL** vs Firestore vs MongoDB vs MySQL | **PostgreSQL.** Relational rules mirror the device; reporting needs joins. Firestore wins only for a read-heavy app with no joins and no reporting — which this is not, and that is why it was abandoned. |
| Auth | **Own auth in PostgreSQL** vs Firebase Auth vs Auth0/Keycloak | **Own auth here**, because offline leases and biometric linkage belong beside `users`, and because a third party must not be able to stop every authenticated call. Firebase/Auth0 win when you need social login, MFA and SSO you do not want to build. |
| Session format | **Opaque token + session table** vs JWT | **Opaque token.** Immediate revocation of a lost field phone is a hard requirement. JWT wins only for stateless multi-service fan-out, and then needs a revocation list anyway. |
| Password hash | **scrypt** vs Argon2id vs bcrypt | **Argon2id is marginally better** on paper; **scrypt at N = 2^15 is chosen and fine**, and it is in the standard library. Not worth a migration without a compliance driver. |
| CAPTCHA | **Self-hosted PoW** vs reCAPTCHA/Turnstile | **Self-hosted**, for CSP strictness, privacy and offline-friendliness. Turnstile wins against sophisticated bot farms. |
| Fingerprint matching | **Own ISO-19794-2 matcher** vs vendor SDK vs NBIS vs UIDAI RD | **Own matcher**, given the offline and vendor-neutrality requirements — *provided it gets measured*. A certified vendor matcher wins the moment accuracy must be defensible to an auditor. |
| Face engine | **face-api.js (TF.js)** vs MediaPipe vs cloud APIs | **MediaPipe would be the better choice for a rebuild** (lighter, faster, actively developed). face-api.js is adequate and already precached. Cloud APIs are disqualified by the offline requirement. |
| Unit tests | **Vitest** vs Jest | **Vitest.** Same Vite pipeline, no separate transform config. |
| E2E tests | **Playwright** vs Cypress | **Playwright.** Multi-context, offline simulation, mobile emulation, and it can run the production build under the production CSP. |
| Backend test DB | **pgserver (real Postgres)** vs SQLite vs Testcontainers | **pgserver.** Real engine, no Docker daemon on the runner. |
| Postgres hosting | Docker (**chosen**) vs host package vs **managed** | **Managed is best** (tested restore, PITR, failover); **Docker is the best self-hosted option**; host package is last. |
| App process | **systemd** vs container vs supervisor | **systemd at one host**; containerise when a second host appears. |
| Orchestration | **none** vs Compose vs Kubernetes | **None is correct** at this size. Compose at 3–5 services. Kubernetes is not on the table. |
| Reverse proxy | **nginx** vs Caddy vs Traefik | **nginx**, already present, and its shared headers snippet is reused by the tests. Caddy wins on automatic TLS if starting fresh. |
| CI | **GitHub Actions** vs Jenkins vs GitLab CI vs self-hosted runner | **GitHub Actions**, because the code already lives on GitHub and the production host stays toolchain-free. |
| Android delivery | **Sideload + `latest.json`** vs Play Store vs Firebase App Distribution vs MDM | **Play Store (closed track) would be better** for crash reporting, staged rollout and trust; sideloading wins on control and zero review latency. A **hybrid** is best: Play for the native shell, OTA for everything else. |
| Web update delivery | **OTA bundle replacement** vs Play releases vs server-driven UI vs `server.url` | **OTA bundle replacement, decisively.** It gives more than server-driven UI (any screen, any logic, any fix) for far less work, and screens stay React instead of becoming an interpreter. |

### Comparisons that are not actually comparisons

These pairings come up in discussion but compare different categories. Stated plainly so the report is not
read as choosing one over the other:

- **Docker vs GitHub (Actions)** — Docker isolates a *runtime*; Actions runs a *pipeline*. This project
  correctly uses Docker for PostgreSQL and Actions for build-and-ship. Neither replaces the other. The real
  question, "should the server build its own images?", is answered **no** in §5.4 #22.
- **Docker vs systemd** — both supervise processes. Docker adds image pinning and filesystem isolation;
  systemd integrates with the host's logging, environment files and timers. Here: **Docker for the database
  (version pinning matters), systemd for the API (host integration matters).** That split is deliberate.
- **PWA vs APK** — not alternatives in this project. They are **the same bundle** in two containers, and
  the APK exists only for the scanner path and OTA, not because the web version is inferior.
- **GitHub Releases vs `/downloads/`** — both host files. Self-hosting was chosen for certificate pinning
  and self-described releases; **adding GitHub Releases as a mirror is free and recommended** (§10).

---

## 8. Current state: completeness, tests, metrics

### 8.1 Checkpoint completeness

| CP | Area | Status | What remains |
|---|---|---|---|
| 01 | App & offline foundation | **COMPLETE** | One OPFS connection per origin (a second tab cannot open the DB) |
| 02 | Auth, identity, permissions | **COMPLETE** | Cached authorization has no maximum age |
| 03 | Master data | **COMPLETE** | Writes are online only; no delete (deactivate instead) |
| 04 | Journeys | **PARTIAL** | Create/edit/cancel/supervisor/staff online only — needs journey sync operations with base-version conflict handling |
| 05 | Attendance | **COMPLETE (capture)** | Review online only |
| 06 | Inspections | **COMPLETE (capture)** | Review online only; video capture has no e2e test |
| 07 | Passenger feedback | **PARTIAL** | PNR/OTP/ratings need the server (external verification) |
| 08 | Railway feedback | **COMPLETE (capture)** | Review online only; no media field server-side |
| 09 | Complaints | **PARTIAL** | Offline status transitions unsupported by the backend |
| 10 | Inventory | **COMPLETE** | — |
| 11 | Reports & dashboards | **COMPLETE** | Offline figures cover only this device's records, and say so |
| 12 | Sync & integration | **PARTIAL** | Device ↔ FastAPI verified; the Firestore central-persistence line of work is closed, not pending |

**The pattern in the gaps is consistent and worth stating:** every remaining gap is a *write that needs
server arbitration* — review/approval, server-assigned ids, external verification. Capture, the thing that
happens in a coach with no signal, is complete everywhere it matters.

### 8.2 Test inventory

| Suite | Count | What it actually exercises |
|---|---|---|
| Device unit tests (Vitest) | **300 cases in 36 files** | Real SQLite, real migrations, real matching maths |
| Backend tests (pytest + pgserver) | **193 tests in 20 files** | A throwaway real PostgreSQL per run |
| Offline e2e (Playwright) | **11 specs** | Production build, network disconnected: cold start, reload, deep link, shared device, media, responsive, update |
| Live e2e | **1 spec** | The deployed site |
| CI gates beyond tests | — | No secrets in the bundle; no demo-mode string; WASM present; APK not debuggable; keystore verified before build |

Notable coverage: report parity. `backend/tests/test_report_parity.py` exports 30 server reports to a
fixture that `tests/unit/reportParity.test.js` reproduces on-device, **matching all 30 exactly**, including
an IST-midnight edge case. That is a genuinely strong test, and the right answer to "do offline figures
agree with the server?"

### 8.3 Code metrics

| Area | Lines | Files |
|---|---|---|
| `src/pages` | 5,168 | 19 |
| `src/database` | 3,196 | 22 |
| `src/services` | 2,002 | 12 |
| `src/components` | 1,783 | 19 |
| `src/face` | 1,131 | 5 |
| `src/security` | 892 | 15 |
| `src/app` | 783 | 5 |
| `src/pwa` | 439 | 5 |
| `src/utils` | 402 | 5 |
| `src/fingerprint` | 318 | 3 |
| Backend `app/` | — | 90 modules across api / models / schemas / services / security |
| Migrations | — | 10 Alembic (server) · 13 forward-only (device) |

### 8.4 Process

Work moves through short-lived personal branches (`krish`, `kashyap`, `attendance-location-map`) into
`main` by pull request — 10 PRs in 17 days. `main` is the deploy trigger; `concurrency` in the workflow
prevents overlapping deploys without cancelling one already in flight.

---

## 9. Risk register, ranked

### 9.1 The device computes the score the server trusts — design risk, highest

The server re-checks the reported distance or match score against the division threshold, but it **cannot
recompute** either from what it stores. A modified client could submit a passing score.

*Mitigations in place:* audit trail, device integrity signals, session/device revocation, spatial and clock
plausibility re-checks. *Honest framing:* treat biometric attendance as **strong evidence, not proof**.
*Real fix:* server-side re-computation for a sampled percentage of submissions — which requires sending the
captured descriptor (not the image) and is a meaningful design change.

### 9.2 The fingerprint matcher has no measured error rates — accuracy risk, high

It is an in-house minutiae matcher, not a certified one, and there are no FAR/FRR figures. The default
threshold of 40 was *lowered* empirically because genuine prints were being refused — which is exactly the
direction that raises false accepts. **Before wide rollout: a few hundred genuine pairs and a few thousand
impostor pairs, measured, with the threshold set from the resulting curve.**

### 9.3 Single host, single database container, unrehearsed restore — operational risk, high

API, PostgreSQL and media all on one machine. Backups run on a systemd timer. There is no replica and **no
tested restore path**. A disk failure is currently an unbounded data-loss event.

### 9.4 Stale biometric enrolments will silently fail — data risk, high and time-sensitive

Everyone enrolled before the November matcher fixes was enrolled against a parser that read zero minutiae.
Those registrations **will not verify**. Re-enrolment is mandatory, and must be confirmed on real hardware
with both a genuine match and a rejected impostor.

### 9.5 Sideloaded distribution with no telemetry — delivery risk, medium

No crash reporting, no staged native rollout, no kill switch for a bad APK. The OTA channel mitigates this
substantially for web code (rollout %, instant rollback, health marking, per-phone failure memory) but not
for anything under `android/`.

### 9.6 Single scanner vendor — procurement risk, medium

Three separate bindings to ACPL: the companion-app intent, the USB vendor-id filter, and the matcher id.
Adding a second ISO-template scanner is a contained week with hardware in hand — **but every employee
enrolled on the old scanner must be enrolled again.** A scanner offering only a UIDAI RD Service **cannot
be used at all.**

### 9.7 Personal-data governance incomplete — compliance risk, medium

Consent is recorded per registration and only templates are kept, which is the right shape. What is missing
is a written **retention and deletion-on-exit policy**, and a check of DPDP Act obligations against it.

### 9.8 Smaller items

- A Google Maps browser key is committed in `.env.example`. It is referrer-restricted by design, but a
  real key does not belong in an example file — replace it with a placeholder and rotate.
- `scripts/deploy-firestore-rules.mjs`, `firebase-admin-client.mjs` and `register-web-app.mjs` are
  vestigial now that Firestore and Firebase Auth are gone.
- Cached authorization has no maximum age (the 24-h lease bounds the session, not the cached permissions).
- `alembic upgrade head` on service start will, at some table size, mean a deploy that blocks on a lock.
- A 6-day TLS certificate makes renewal failure urgent, and nothing currently alerts on it.

---

## 10. Recommendations

### Immediate — before any further field rollout (days)

1. **Re-enrol every biometric registration**, then verify on real AST300 hardware that a genuine finger
   matches and an impostor is refused. Without this, attendance silently fails for anyone enrolled before
   19 November. *(Addresses 9.4.)*
2. **Rehearse a database restore end to end** on a throwaway host, from the actual backup the systemd timer
   produces, and write down the elapsed time. An untested backup is not a backup. *(9.3.)*
3. **Rotate the Maps key and replace it in `.env.example` with a placeholder.** *(9.8.)*
4. **Add an alert on certificate renewal and on API health.** With a 6-day certificate, silent renewal
   failure takes the whole deployment down within a week.

### Short term — the next two to four weeks

5. **Measure the fingerprint matcher.** Collect genuine and impostor pairs from real enrolments, compute
   FAR/FRR, publish the curve, and set `fingerprint_match_score` from it rather than from field complaints.
   *(9.2 — the single highest-value engineering task on this list.)*
6. **Move PostgreSQL to a managed instance, or add a hot standby plus point-in-time recovery.** Managed is
   better on every axis except cost and data residency. *(9.3.)*
7. **Add crash and error reporting** (Sentry, or a first-party endpoint — the latter keeps data in-house and
   fits the existing security envelope). Right now a crash in the field is invisible. *(9.5.)*
8. **Write the biometric retention and deletion policy**, including deletion on employee exit, and check it
   against DPDP Act obligations. *(9.7.)*
9. **Delete the vestigial Firebase scripts** and the `firebase_uid` references that no longer serve the
    import path, so nobody rebuilds a dependency that was deliberately removed. *(9.8.)*
10. **Mirror the APK to GitHub Releases** alongside `/downloads/`. Free, CDN-backed, better for field
    downloads, and `latest.json` can keep the certificate pin either way.

### Medium term — one to three months

11. **Sample server-side biometric re-computation.** Send the descriptor for a configurable percentage of
    attendance submissions and recompute the distance server-side. This converts "strong evidence" into
    something closer to proof without giving up offline capture. *(9.1.)*
12. **Close the online-only write gaps** by adding sync operations for review/approval and journey
    administration with base-version conflict handling. Review is the most-requested of these, and the
    backend already has the version machinery. *(CP-04, 05, 06, 08, 09.)*
13. **Publish the Android shell to a Play Store closed track**, keeping OTA for everything web. Best of
    both: Play's crash reporting, staged native rollout and trust signal, with the existing instant web
    delivery untouched. *(9.5.)*
14. **Add a maximum age to cached authorization**, so a permission revoked while a device is offline
    expires rather than persisting until the next successful sync. *(9.8.)*
15. **Add the second scanner vendor** if procurement is likely to need it, and budget the re-enrolment that
    comes with it. The matcher is already vendor-neutral at the template level. *(9.6.)*
16. **Make migrations explicit for large tables.** Keep auto-upgrade for small ones, but add a pre-deploy
    check that refuses to start a migration estimated to hold a long lock. *(9.8.)*

### Longer term — architectural, only if the driver appears

17. **Containerise the API** the moment a second host exists. Not before — systemd is serving it well.
18. **Evaluate MediaPipe** to replace face-api.js if first-load size or match latency becomes a complaint.
    Budget re-enrolment: a different model means different descriptors.
19. **Consider Argon2id** for password hashing if a compliance standard requires it. Not otherwise.
20. **Route-level code splitting** only if 2G first-load becomes a field complaint — and split the 6.4 MB
    face model out first, not the screens.

### Explicitly *not* recommended

- **Kubernetes, or a Compose-everything migration.** One API, one database, a few hundred phones. The
  orchestration would be larger than the application.
- **Server-driven UI.** Already rejected for the right reason: the UI is HTML, so the whole build can be
  replaced. Re-opening this would turn React screens into an interpreter for no gain.
- **Capacitor `server.url` pointing at the live site.** It would change the WebView origin from
  `https://localhost` to the server's, and **every phone in the field would silently lose its SQLite
  database and all OPFS media**, which are keyed to that origin. This is the most dangerous available
  shortcut in the codebase, and it is correctly documented as forbidden.
- **A UIDAI RD Service scanner.** Structurally incompatible with offline matching.
- **Returning to Firestore or Firebase Auth.** Both were removed deliberately and the system is simpler
  for it.

---

## 11. Scaling and cost path

| Load | What breaks first | Change needed |
|---|---|---|
| Today — one division, tens to low hundreds of phones | Nothing | — |
| A few hundred phones, several divisions | `/sync/changes` full-set template delivery; nginx rate-limit burst of 120 | Incremental template delivery; tune `limit_req`; review indexes on the sync-cursor queries |
| Low thousands of phones | Single API process; `alembic` on-start locks; media on the app disk | Multiple uvicorn workers behind nginx; explicit migrations; media to object storage (the `StorageBackend` abstraction already exists) |
| Multi-region railway rollout | Single host, single database | Managed Postgres with a read replica; containerised API on two or more hosts; Compose or a small orchestrator at that point |

The cost profile today is deliberately low: one VPS, GitHub Actions free minutes, Let's Encrypt, no
per-match biometric licence, no captcha service, no identity provider, no Play Store requirement for the
field. The two places where paying money buys disproportionate safety are **managed PostgreSQL** and
**crash reporting**.

---

## 12. Appendix

### 12.1 Repository map

```
swachhsafar/
├─ src/                      React app (see §8.3 for line counts)
│  ├─ app/                   Layout, hash router, module registry, session, division context
│  ├─ components/            Capture, JourneyCard/Picker, LocationMap, PwaPanels, ui primitives
│  ├─ database/              SQLite worker, oo1 adapter, 13 migrations, 11 repositories, media store
│  ├─ face/                  FaceCheck, LiveFaceCapture, GroupPhotoCapture, engine, matching, liveness
│  ├─ fingerprint/           FingerprintCheck, scanner bridge, match scoring
│  ├─ pages/ops/             The 10 operational modules + masters/
│  ├─ pwa/                   Service worker, app-update and bundle-update logic, PWA state
│  ├─ security/              Policy engine, device/network/location, captcha, lease, auth token
│  ├─ services/              apiClient, localFirstApi, localApi, operationsQueue, localStore, reports
│  └─ utils/                 Business dates (Asia/Kolkata), capture, validation, voice recording
├─ backend/
│  ├─ app/{api/v1,models,schemas,services,security,providers}/   16 routers, 90 modules
│  ├─ alembic/versions/      0001 … 0010
│  └─ tests/                 193 tests, real PostgreSQL via pgserver
├─ android/                  Capacitor project; SwachhFingerprint + SwachhSecurity Kotlin plugins
├─ deploy/
│  ├─ nginx/                 site conf, app conf, shared security headers
│  ├─ scripts/               install-server, postgres-container, receive-release, backup, cert, rollback
│  └─ systemd/               api service + cert-renew and db-backup timers
├─ docs/                     15 documents (this report, PHASE1/2, SECURITY, FINGERPRINT, OTA_UPDATES, …)
├─ scripts/                  publish-bundle, describe-apk, backend/PWA start helpers, (vestigial Firebase)
└─ tests/                    unit (36 files) · e2e-offline (11 specs) · e2e-live (1) · fixtures · helpers
```

### 12.2 Commands

```bash
npm install
npm run dev                  # https://localhost:5173 (mkcert certificate in .cert/ enables OPFS)
npm run build                # production PWA  -> dist/
npm run build:demo           # demo build      -> dist-demo/
npm run preview              # production bundle on http://localhost:4173
npm run preview:lan          # same over HTTPS, for a physical phone on the LAN
npm test                     # 300 unit tests, real SQLite
npm run test:e2e:offline     # Playwright, production build, network disconnected

cd backend
pip install -e '.[test]'
python -m pytest             # 193 tests, throwaway PostgreSQL
python -m app.cli set-password --emp-id X
```

On the server, any `app.cli` command must borrow the service's environment:

```bash
sudo systemd-run --pty --collect --uid=swachhsafar \
  --property=EnvironmentFile=/etc/swachhsafar/backend.env \
  --property=WorkingDirectory=/var/www/html/swachhsafar2.0/swachhsafar/backend \
  /var/www/html/swachhsafar2.0/swachhsafar/backend/.venv/bin/python -m app.cli <command>
```

### 12.3 Configuration surface

**Client (build-time, `VITE_*`)** — `VITE_DEMO_MODE`, `VITE_API_BASE_URL` (absolute for the APK, relative
for the PWA), `VITE_GOOGLE_MAPS_API_KEY` / `_REGION` / `_LANGUAGE`, `VITE_BUILD_SHA`.

**Backend (`/etc/swachhsafar/backend.env`)** — `DATABASE_URL`, `OTP_PEPPER`, `CORS_ORIGINS`,
`STORAGE_BACKEND` plus `LOCAL_MEDIA_DIR` or the Firebase bucket, `SMS_PROVIDER` (+ MSG91/DLT fields),
`PNR_PROVIDER` (+ RapidAPI fields), `RELEASE_PUBLISH_TOKEN`, `WEB_BUNDLE_MAX_BYTES`,
`WEB_BUNDLE_MAX_UNPACKED_BYTES`, `SESSION_IDLE_DAYS`.

**Per-division policy (Master data → Division policy)** — `face_match_threshold` (0.3–0.7, default 0.5),
`fingerprint_match_score` (30–100, default 40), `face_liveness_required`, `offline_session_hours` (≤ 24),
`gps_enforced`, `gps_block_app`, GPS accuracy and freshness limits.

**CI (GitHub repository settings)** — *Secrets:* `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`,
`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
`RELEASE_PUBLISH_TOKEN`. *Variables:* `DEPLOY_HOST`, `BUILD_APK`, `PUBLISH_BUNDLE`, `MIN_NATIVE_VERSION`,
`RELEASE_CHANNEL_ROLLOUT`, `APK_API_BASE_URL`, `VITE_GOOGLE_MAPS_API_KEY`.

> `MIN_NATIVE_VERSION` must be raised **in the same commit** that adds a native plugin method the web code
> starts calling. A phone served a bundle that cannot start cannot ask for a better one.

### 12.4 Related documents

| Document | Covers |
|---|---|
| `docs/report.md` | The earlier production-stack report (app 2.0.4); this report supersedes it |
| `docs/PHASE1.md` / `PHASE2.md` | Architecture, registration and sync workflow; the SQLite foundation |
| `docs/CHECKPOINTS.md` | Per-checkpoint audit with evidence and open items |
| `docs/SECURITY.md` | Threat model, policy engine, evidence collection, what liveness proves |
| `docs/SECURITY_TEST_REPORT.md` | Security test results |
| `docs/AUTHENTICATION.md` | Auth architecture, tables, hashes, sessions, the Firebase migration |
| `docs/CLIENTS_AND_CREDITS.md` | Clients (offices), per-client module subscriptions, role rights, the prepaid credit wallet |
| `docs/FINGERPRINT.md` | Matcher internals, plugin contract, why an RD Service cannot be used |
| `docs/FACE_ENROLLMENT.md` | Enrolment procedure |
| `docs/OTA_UPDATES.md` | Bundle/channel model, native gate, rollout, rollback |
| `docs/DEPLOYMENT.md` / `DEPLOYMENT_CHECKLIST.md` | Production runbook and pre-flight list |
| `docs/ANDROID_SETUP.md` / `ANDROID_TESTING.md` | APK build, signing, versioning; physical-device test sheet |
| `docs/OTP_PROVIDER_SETUP.md` | MSG91 / generic SMS gateway configuration |

---

### Closing assessment

In seventeen days this project went from a UI mock-up to a signed Android app with offline biometric
attendance, an over-the-air release channel, 493 automated tests and a production deployment that the
server itself never builds. The architectural choices that cost the most to make — SQL on the device,
templates instead of images, a bundle that can be replaced without an install — are the ones that will
keep paying.

What stands between this and a system that can be depended on for payroll-grade attendance is not more
features. It is **three measurements and one rehearsal**: measure the fingerprint matcher, measure what the
server can and cannot verify about a biometric score, measure what a restore actually takes — and rehearse
that restore before go-live.
