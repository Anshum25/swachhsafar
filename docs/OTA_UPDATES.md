# Over-the-air updates: changing the app without an install

A change to `src/` reaches every phone on the next app open. No APK, no Play Store, nothing for the user
to agree to. A change to `android/` still needs an install, and this document is largely about keeping
that line clear.

## Why this exists, and why it is not server-driven UI

The Android app is a WebView over the Vite build. Until now that build was sealed inside the APK, so a
one-line fix in `src/services/operationsQueue.js` needed a signed release, a download over a field
connection, and a user willing to install it. Meanwhile the PWA at the same commit already had the fix.

The approach people reach for first is storing the UI in the database — a JSON description of each screen
that the app renders. That is what native apps have to do, because native code cannot be swapped. We are
not native: the UI is already HTML and JavaScript, so the whole build can be replaced. That gets us more
than server-driven UI (any screen, any logic, any bug) for far less work, and the screens stay ordinary
React instead of becoming an interpreter.

The other approach is pointing the WebView at the live site with Capacitor's `server.url`. **Do not.** It
changes the WebView's origin from `https://localhost` to the server's, and the SQLite database and media
in OPFS are keyed to that origin. Every phone in the field would silently lose its local data, and the
app would need the network to start at all. Replacing the bundle keeps the origin exactly as it was.

## What the database holds

Two tables (`backend/alembic/versions/0009_web_bundles.py`). Neither holds any of the app's code — the
bundle is 6 MB of JavaScript and WASM, which is a file, not a column.

**`web_bundles`** — one row per build CI has published. An index into storage, plus the facts needed to
decide who may run it.

| Column | Why it is there |
|---|---|
| `version`, `build` | `2.0.8` and the CI run number. `build` only ever rises, so it orders releases even when several share a version name — the same trick `versionCode` uses in `android/app/build.gradle` |
| `storage_path` | `web-bundles/2.0.8+421.zip`, through the same `StorageBackend` as media |
| `sha256` | What the phone verifies before it unpacks anything |
| `size_bytes` | So the download can report progress and set `Content-Length` |
| `min_native_version` | The oldest APK allowed to run this bundle |
| `api_base_url` | Recorded so a bundle built for the PWA can be spotted |
| `git_sha`, `notes`, `published_by` | Which commit this is, and who published it |

Nothing is ever updated in place. A new build is a new row, so every bundle that has been live stays
available to go back to.

**`web_channels`** — one row per channel (`stable`, `beta`), saying which bundle it serves.

| Column | Why it is there |
|---|---|
| `bundle_id` | The pointer. Moving it is the entire release mechanism |
| `rollout_percent` | Share of phones the pointer applies to |
| `mandatory` | Apply at once instead of on the next cold start |
| `rolled_back_from` | Set when the pointer is moved back to an earlier build |
| `pointed_at`, `pointed_by` | When it went live, and who did it |

The whole design is in that split: **publishing stores a bundle, pointing a channel releases it.** They
are separate API calls, so an upload is never a release, and undoing a release never involves a rebuild.

## How a phone fetches it

`src/pwa/bundleUpdate.js`, driven by `useBundleUpdate()` in `src/components/PwaPanels.jsx`. It runs on
start and whenever the device comes back online.

```
app opens
   │
   ├─ markBundleHealthy()            main.jsx, after render: "this bundle started"
   │
   └─ GET /api/v1/app/bundle/latest?channel=stable
          &current=2.0.8+421         what it is running now
          &native=2.0.7              the installed APK, which gates what may be served
          &device=<device id>        so a staged rollout is stable for this phone
          │
          ├─ 204  stay where you are                        ← the normal answer
          └─ 200  { bundle_id, url, sha256, size_bytes, mandatory }
                   │
                   ├─ already failed on this phone? → ignore it
                   ├─ download(url, checksum: sha256)        the plugin refuses bytes that do not match
                   └─ next(bundle)                          staged for the next cold start
```

The server decides three things in `resolve()` (`backend/app/services/releases.py`), in this order:

1. **Native gate.** If `min_native_version` is newer than the APK reports, the bundle is withheld. Serving
   it would mean web code calling a plugin method that is not there, which breaks the app on launch — and
   a phone whose bundle does not start cannot ask for a better one.
2. **Rollout.** `sha256(bundle.sha256 + device_id) % 100 < rollout_percent`. Deterministic, so a phone
   gets the same answer on every check instead of flipping between two bundles; a different bundle
   reshuffles which phones go first.
3. **Already on it?** Compared by exact bundle name, not "is mine older". That is what makes a rollback
   work: when the channel points back at `2.0.8+421`, phones on `2.0.9+422` are told to come back down.

The check and the download are **unauthenticated**, on purpose. The same JavaScript is already served
openly to every browser at the site root, so there is nothing here to keep secret, and the check has to
work before sign-in — the login screen is exactly the thing that may be broken and need replacing. Both
routes are rate limited per IP, and the hash is what makes the bytes trustworthy, not the transport.

## Releasing

`git push` to `main` does it, once `PUBLISH_BUNDLE` is set (see Setup). The `publish-bundle` job runs
after `deploy`, so the backend is always at least as new as the web code talking to it.

```
git push main
   │
   ├─ test-web, test-backend
   ├─ build-web   → server → nginx current        the PWA, unchanged
   ├─ build-apk   → /downloads                    only when BUILD_APK is on
   ├─ deploy
   └─ publish-bundle
        ├─ vite build (APK flavour)
        ├─ POST /api/v1/app/bundle         upload + row. No phone affected yet.
        └─ POST /api/v1/app/channel/stable live
```

By hand, against any built directory:

```bash
export RELEASE_API_BASE=https://ehk.itfarmer.in/api/v1
export RELEASE_PUBLISH_TOKEN=...
export VITE_API_BASE_URL=https://ehk.itfarmer.in/api/v1

npx vite build --outDir bundle-web          # must be the APK flavour, see below
node scripts/publish-bundle.mjs --dir bundle-web --build 9001            # upload only
node scripts/publish-bundle.mjs --dir bundle-web --build 9001 --release --rollout 10
```

### Rolling back

One call. No rebuild, no new bundle.

```bash
curl -X POST https://ehk.itfarmer.in/api/v1/app/channel/stable \
  -H "X-Release-Token: $RELEASE_PUBLISH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"build": 421}'
```

Phones that already took the bad build come back down on their next open. `GET /api/v1/app/bundles`
(signed in) lists what there is to go back to.

There is also a rollback that needs nobody at all: a bundle is on probation until it calls
`notifyAppReady()`, which `src/main.jsx` does after render. A bundle that white-screens never gets there,
so the plugin reverts to the previous one on the next launch, and the client records the failure so it is
not downloaded again.

### Staged rollout

`--rollout 10` points the channel at the build for a tenth of the fleet. Watch, then re-point at 100.
Set `RELEASE_CHANNEL_ROLLOUT` as a repository variable to make that the default for every release.

## Setup, once

**Backend** (`backend/.env`): `RELEASE_PUBLISH_TOKEN`, a long random secret. Unset means publishing is
closed, not open — the endpoints answer `503 publishing_disabled`.

**GitHub** → Settings → Secrets and variables → Actions:

| Name | Kind | Value |
|---|---|---|
| `RELEASE_PUBLISH_TOKEN` | secret | same as the backend's |
| `PUBLISH_BUNDLE` | variable | `true` to publish on every push to `main` |
| `MIN_NATIVE_VERSION` | variable | oldest APK allowed to run the bundle |
| `RELEASE_CHANNEL_ROLLOUT` | variable | optional, `1`–`100` |

**One APK release is required to start.** The updater is itself a native plugin: phones need an APK built
with `@capgo/capacitor-updater` before any of this reaches them. Build and publish that APK first, then
set `PUBLISH_BUNDLE=true`. Phones on older APKs keep using the APK-update banner they have now.

nginx needs no change: `client_max_body_size 30m` in `deploy/nginx/swachhsafar-app.conf` already covers a
6 MB upload, and the download is served through the existing `/api/` proxy.

### Plugin configuration

In `capacitor.config.json`, under `CapacitorUpdater`:

- **`autoUpdate: false`** — the most important one. Left on, the plugin talks to Capgo's own hosted
  service. We serve bundles from our own server, so the app drives the download itself.
- **`appReadyTimeout: 20000`** — how long a new bundle has to call `notifyAppReady()` before it is treated
  as broken and reverted. Generous, because a cold start also initialises SQLite WASM and the face models.
- **`resetWhenUpdate: true`** — installing a newer APK discards OTA bundles and returns to the build
  inside it. Without this, new native code could end up paired with an older web bundle.
- **`directUpdate: false`** — never swap the bundle during a session; staging is handled explicitly.

## What ships this way, and what does not

Everything in `src/` — all 16 screens, the components, all 13 services, the security JS, the face and
fingerprint JavaScript, the SQLite layer. In practice this is upwards of 90% of changes.

| Change | How it ships |
|---|---|
| Redesign `src/pages/ops/Attendance.jsx` | OTA |
| New screen + route in `src/App.jsx` | OTA |
| Sync bug in `src/services/localFirstApi.js` | OTA |
| New backend endpoint, consumed in `apiClient.js` | OTA |
| Face liveness flow, thresholds, even a swapped model file | OTA |
| Fingerprint prompts, retry counts, enrolment screens | OTA |
| SQLite migration in `src/database/` | OTA — but see below |
| A new method on `SwachhSecurityPlugin.kt` | **APK** |
| A new Android permission | **APK** |
| A different fingerprint scanner (`AcplAst300Driver.kt`) | **APK** |
| The matcher (`IsoTemplateMatcher.kt`) | **APK** |
| Push notifications (new native plugin) | **APK** |
| Capacitor/Gradle/`targetSdk`, app name, icon, native splash | **APK** |

Thresholds and operational switches need neither: `PolicySettings` in `backend/app/schemas/policy.py`
already carries about 40 of them per division — GPS rules, face and fingerprint thresholds, SLA hours,
which photos are required. Changing one of those takes effect with no download at all.

So, three tiers, fastest first: **policy** (instant) → **bundle** (next app open) → **APK** (rare).

## Four things that will bite you

**The bundle must be the APK-flavoured build.** `build-web` compiles a *relative* `/api/v1` for the PWA;
the APK needs the *absolute* URL, because the WebView serves from `https://localhost` and a relative path
would resolve against the app's own files. Publish the PWA build by mistake and every API call on every
phone 404s. Three things stop this: `publish-bundle` is a separate build step with the APK environment,
`scripts/publish-bundle.mjs` refuses a relative `VITE_API_BASE_URL`, and the server refuses the upload
(`bundle_relative_api_base`).

**Raise `MIN_NATIVE_VERSION` in the same commit that starts calling new native code.** The gate only
works if it is set. And because it compares `versionName`, an APK that changes the native surface must
bump the version in `package.json` — otherwise two different native surfaces share one version name and
the gate cannot tell them apart.

**SQLite migrations are the one thing a rollback does not undo.** Rolling the bundle back does not roll
the schema back, and the older bundle then meets a newer database. Keep migrations in `src/database/`
additive — new tables and nullable columns — so an older bundle still reads what it finds.

**The zip is the whole served directory.** The plugin serves the unpacked bundle *instead of* the APK's
assets, so anything missing from the zip is simply gone — including the 7 MB of face models and the
SQLite WASM. Never prune the bundle to make the download smaller.

## Reading the code

| What | Where |
|---|---|
| Tables | `backend/app/models/releases.py`, `backend/alembic/versions/0009_web_bundles.py` |
| Decision logic (gate, rollout, rollback) | `backend/app/services/releases.py` |
| Endpoints | `backend/app/api/v1/releases.py` |
| Client: check, download, stage | `src/pwa/bundleUpdate.js` |
| Banner, and the health signal | `src/components/PwaPanels.jsx`, `src/main.jsx` |
| Publishing | `scripts/publish-bundle.mjs`, `.github/workflows/deploy.yml` |
| Tests | `backend/tests/test_releases.py` (24), `tests/unit/bundleUpdate.test.js` (14) |

The APK-update path (`src/pwa/appUpdate.js`, `/downloads/latest.json`) is untouched and still needed: it
is what offers the install when a release does change native code.
