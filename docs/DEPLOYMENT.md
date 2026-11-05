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
| TLS | `/etc/swachhsafar/tls/` | Private CA `ca.crt`/`ca.key` (600), leaf `server.crt` (397 days, SAN `IP:76.13.243.27`). |
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

# Certificate: reissue the leaf before it expires (07 Dec 2027). Phones need no change.
sudo deploy/scripts/make-ip-cert.sh 76.13.243.27 && sudo nginx -t && sudo systemctl reload nginx
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
6. `lego` was installed briefly for a Let's Encrypt IP certificate, then removed when self-signed was chosen.
7. Pre-existing and unrelated: the `admission.cblu.ac.in` certificate expired on 26 Jul 2026.

## Verification evidence (2026-11-05)

- `curl --cacert ca.crt`: TLS verifies (HTTP/2). Without the CA it is rejected. `http://…:8082` redirects with 301 to https.
- `tests/e2e-live/deployment.live.spec.js` (Chromium, Pixel 7 emulation, the CA trusted through NSS, certificate errors
  **not** ignored): secure context; `Page.getInstallabilityErrors` = []; the manifest name is "Swachh Safar 2.0";
  the service worker controls the page; OPFS SQLite reports "Ready · persistent"; no API response in the cache;
  offline cold start + reload work; no CSP violations. First load to DB ready ≈ 1.1 s; offline cold start ≈ 0.5–1.0 s.
- Lighthouse 13.5.0, mobile (simulated slow 4G): Performance 98, Accessibility 100, Best Practices 100, SEO 91
  (SEO before `robots.txt` was added). LCP 2.0 s, TBT 20 ms, CLS 0, 611 KiB.
- API: `/health` returns ok. Missing token → 401 `unauthenticated`; forged token → 401 `invalid_token`. Alembic at head
  (34 tables, 6 roles).
- Firebase Admin key: valid (Google issued an access token).

Run the live test again: `LIVE_URL=https://76.13.243.27:8082 HOME=<dir whose .pki/nssdb trusts ca.crt> npx playwright test -c playwright.live.config.js`
