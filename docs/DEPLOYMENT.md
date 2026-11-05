# Swachh Safar 2.0 — Production deployment (IP + port)

**URL:** `https://76.13.243.27:8082` · deployed 2026-11-05 · server `srv1403435` (shared with other sites)

```
Phone (Chrome) ──HTTPS :8082──► nginx ──/──────────► /var/www/html/swachhsafar2.0/current → releases/<time>-<sha>/
                                  └──/api/, /health──► uvicorn 127.0.0.1:8010 (swachhsafar-api.service, 2 workers)
                                                           └──► PostgreSQL 16, Docker swachhsafar_db, 127.0.0.1:5433
                                                           └──► Firebase Admin (token verification, Storage)
```

## Origin warning

The browser origin is `https://76.13.243.27:8082`. Every phone's local database, media, sign-in session and
installed app belong to that exact origin. **Changing the IP address or the port later creates a new origin:**
phones start empty there, and records that were not yet synced stay stranded under the old origin. Before any
change, make sure every device shows *0 pending*. A domain name avoids this problem for the future.

## What is installed where

| Item | Location | Notes |
|---|---|---|
| nginx site | `/etc/nginx/sites-available/swachhsafar` (from `deploy/nginx/swachhsafar.conf`) | Port 8082 only. No other site was modified. |
| Security headers | `/etc/swachhsafar/nginx/security-headers.conf` (from `deploy/nginx/security-headers.conf`) | The same file drives `vite preview` in e2e tests. |
| TLS | `/etc/swachhsafar/tls/active.{crt,key}` → `le/` | **Let's Encrypt IP certificate** (6-day `shortlived` profile, chain to ISRG Root X1). lego v5.5.2 at `/usr/local/bin/lego`, state in `/etc/swachhsafar/lego/` (back it up). Fallback: private IP-constrained CA in the same directory (`server-fullchain.crt`). |
| Cert renewal | `swachhsafar-cert-renew.timer` (twice a day) → `deploy/scripts/renew-cert.sh` → `cert-deploy-hook.sh` | Renews at ~1/3 of the lifetime left, or when Let's Encrypt's renewal info asks. A certificate goes live only if it covers the IP, matches its key, and passes `nginx -t`. |
| ACME challenge | SkyPOS site: `location ^~ /.well-known/acme-challenge/` → `/var/www/acme` | Needed because SkyPOS answers `http://76.13.243.27/`. Backup: `/var/backups/swachhsafar/nginx/skypos.20261105-080850.bak`. |
| Backend env | `/etc/swachhsafar/backend.env` (640 root:swachhsafar) | DB URL, OTP pepper, Firebase settings. Never commit. |
| Firebase key | `/etc/swachhsafar/firebase-admin.json` (640 root:swachhsafar) | Rotate it: it was shared in a chat on 2026-11-05. |
| DB credentials | `/etc/swachhsafar/postgres.env` (600 root) | |
| PostgreSQL | Docker `swachhsafar_db`, volume `swachhsafar_pgdata`, `127.0.0.1:5433` | `postgres:16`; not reachable from outside. |
| API | `swachhsafar-api.service`, user `swachhsafar` | Runs `alembic upgrade head` before starting. Sandboxed (`ProtectSystem=strict`). |
| Backups | `swachhsafar-db-backup.timer`, 03:00 IST daily → `/var/backups/swachhsafar/db/` | 14 days kept. |
| Frontend | `/var/www/html/swachhsafar2.0/releases/`, `current` symlink | The newest 5 releases are kept. |

**Ports:** 8082 is public (already allowed in ufw). 8010 and 5433 listen on loopback only. Port 8000 belongs to
another app (testlms). The Vite dev proxy's default `API_PROXY_TARGET` of `:8000` is therefore wrong on this server.

## Commands

```bash
cd /var/www/html/swachhsafar2.0/swachhsafar

# Full setup (idempotent; never deletes data)
sudo deploy/scripts/install-server.sh 76.13.243.27 8082

# Frontend release: build → checks (files, wasm, no secrets, not demo mode) → atomic switch
sudo deploy/scripts/deploy-frontend.sh
sudo deploy/scripts/rollback-frontend.sh            # back to the previous release
sudo deploy/scripts/rollback-frontend.sh <release>  # a specific one (ls ../releases)

# Backend release: code + migrations (migrations run in ExecStartPre)
backend/.venv/bin/pip install -e backend && sudo systemctl restart swachhsafar-api
journalctl -u swachhsafar-api -f

# Backup now / restore into an EMPTY database
sudo systemctl start swachhsafar-db-backup
docker exec -i swachhsafar_db pg_restore -U swachh -d <empty_db> < /var/backups/swachhsafar/db/<file>.dump

# Certificate: renews automatically. Check / force a run:
systemctl list-timers swachhsafar-cert-renew.timer; journalctl -u swachhsafar-cert-renew -n 20
sudo deploy/scripts/renew-cert.sh                  # no-op unless renewal is due
# Emergency fallback to the private CA (phones would then need ca.crt installed):
sudo ln -sfn server-fullchain.crt /etc/swachhsafar/tls/active.crt && sudo ln -sfn server.key /etc/swachhsafar/tls/active.key && sudo nginx -t && sudo systemctl reload nginx
```

**Backend rollback:** check out the previous commit, then restart the service. A migration that must be undone
needs `alembic downgrade <rev>`, run before you check out the older code. Take a backup first.

## Cache and update strategy

| Path | Cache-Control | Why |
|---|---|---|
| `/`, `/index.html`, `/serviceWorker.js`, `/manifest.webmanifest` | `no-cache` | These decide which version runs, so they are always revalidated. |
| `/assets/*` (content-hashed) | `public, max-age=31536000, immutable` (2xx only) | A 404 is never cached. |
| icons | `max-age=86400` | |
| `/api/*` | `no-store` | The service worker never caches the API either. |

The service worker precaches the whole shell, including every lazy chunk and `sqlite3.wasm`, and has no runtime
caching. After a deploy, phones detect the new version on launch, every hour, and on resume when the last check
is more than 15 minutes old. They show *"A new version is ready… your N unsynced record(s) are kept"* and switch
only when the user taps **Update now**. Records and media live in OPFS, which the service worker never touches.
This is covered by `tests/e2e-offline/update.offline.spec.js`.

## Configuration changes on this server (2026-11-05)

1. Created user `swachhsafar`, `/etc/swachhsafar/`, `/var/backups/swachhsafar/`.
2. Docker container `swachhsafar_db` (volume `swachhsafar_pgdata`).
3. Systemd: `swachhsafar-api.service` (enabled), `swachhsafar-db-backup.{service,timer}` (enabled).
4. nginx: `sites-available/swachhsafar` (was empty) + `/etc/swachhsafar/nginx/security-headers.conf`.
5. `web_ip` was edited and then **restored byte-for-byte** from `/var/backups/swachhsafar/nginx/web_ip.20261105-072652.bak`.
   It turned out not to serve bare-IP port 80: `skypos` declares the same `server_name` and wins. nginx's
   "conflicting server name 76.13.243.27" warning predates this work.
6. `lego` v5.5.2 installed (checksum verified). One location added to the **SkyPOS** site by
   `deploy/scripts/enable-letsencrypt-ip.sh`. SkyPOS still answers as before.
   `swachhsafar-cert-renew.{service,timer}` enabled.
7. Pre-existing and unrelated: the `admission.cblu.ac.in` certificate expired on 26 Jul 2026.

## Verification evidence (2026-11-05)

- Plain `curl` with system trust: TLS verifies (HTTP/2), with the Let's Encrypt chain to ISRG Root X1. `http://…:8082`
  redirects with 301 to https.
- `tests/e2e-live/deployment.live.spec.js` (Chromium, Pixel 7 emulation, fresh profile, default trust store,
  certificate errors **not** ignored): secure context; `Page.getInstallabilityErrors` = []; the manifest name is "Swachh Safar 2.0";
  the service worker controls the page; OPFS SQLite reports "Ready · persistent"; no API response in the cache;
  offline cold start + reload work; no CSP violations. First load to DB ready ≈ 1.1 s; offline cold start ≈ 0.5–1.0 s.
- Lighthouse 13.5.0, mobile (simulated slow 4G): Performance 98, Accessibility 100, Best Practices 100, SEO 91
  (SEO before `robots.txt` was added). LCP 2.0 s, TBT 20 ms, CLS 0, 611 KiB.
- API: `/health` returns ok. Missing token → 401 `unauthenticated`; forged token → 401 `invalid_token`. Alembic at head
  (34 tables, 6 roles).
- Firebase Admin key: valid (Google issued an access token).

Run the live test again: `LIVE_URL=https://76.13.243.27:8082 npx playwright test -c playwright.live.config.js`

## Accounts

First Super Admin (2026-11-05): `SA001` "DK Parmar", `dkparmar1412@gmail.com`, home division `HQ` "Headquarters",
linked by Firebase UID because the email is unverified. Employee ID and division **code** cannot be changed later.
Name, email and the division **name** can. Further staff are added in the app. Provision from the shell:

```bash
cd backend && sudo -u swachhsafar bash -c 'set -a; . /etc/swachhsafar/backend.env; set +a
  .venv/bin/python -m app.cli create-division --code <CODE> --name "<Name>"
  .venv/bin/python -m app.cli create-superadmin --division-code <CODE> --emp-id <ID> --name "<Name>" --email <email> [--firebase-uid <uid>]'
```
Without `--firebase-uid`, the record links on first sign-in only if the Firebase email is verified.

## Media files (photos, video, voice notes)

Stored on this server since 2026-11-05: Firebase Storage has no bucket for the project.

```
/var/www/html/swachhsafar2.0/uploads/            (swachhsafar:swachhsafar 750 — NOT served by nginx)
  journeys/<journey date>_<train no>_<journey id>/<attendance_photo|inspection_photo|inspection_video|feedback_voice|complaint_attachment>/<media id>.<ext>
  other/<kind>/<yyyy>/<mm>/<media id>.<ext>     (no journey: KYC documents, complaints without a journey)
```

- Files can only be downloaded through the API (`/api/v1/media/{id}/file`), which checks sign-in and permissions.
  Do not rename or move files by hand: `media_objects.storage_path` in the database points at them.
- The phone sends the record's journey with each upload. A phone still on an older app version uploads to `other/`.
  File those afterwards (dry run first):
  ```bash
  cd backend && sudo systemd-run --wait --pipe -p User=swachhsafar -p EnvironmentFile=/etc/swachhsafar/backend.env \
    -p WorkingDirectory=$PWD -p ProtectSystem=strict -p ReadWritePaths=/var/www/html/swachhsafar2.0/uploads \
    .venv/bin/python -m app.cli file-media-by-journey --dry-run    # then without --dry-run
  ```
- Backup: `backup-db.sh` (nightly) mirrors `uploads/` to `/var/backups/swachhsafar/uploads/`. The mirror never deletes,
  but it is on the same disk: copy it off the server regularly.
- Size limits per file: photos 8 MB, voice 10 MB, complaint attachments 15 MB, video 100 MB (nginx accepts up to 30 MB,
  matching the device's 25 MB video limit).
