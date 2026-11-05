#!/usr/bin/env bash
# Builds the PWA into a new release directory and switches nginx to it atomically.
#
#   sudo deploy/scripts/deploy-frontend.sh
#
# Releases: /var/www/html/swachhsafar2.0/releases/<UTC time>-<git sha>; nginx serves the `current` symlink.
# The previous releases stay for rollback (rollback-frontend.sh). Device data is unaffected by a deploy:
# it lives in each phone's OPFS (SQLite + media), which the service worker never touches; phones pick up
# the new version through the "new version ready" banner.
set -euo pipefail

REPO=/var/www/html/swachhsafar2.0/swachhsafar
BASE=/var/www/html/swachhsafar2.0
KEEP=5
cd "$REPO"

[[ -f .env.local ]] || { echo ".env.local (VITE_FIREBASE_*) missing" >&2; exit 1; }
# VITE_DEMO_MODE=false is passed in the environment below, which takes precedence over .env.local
# (a developer's .env.local may have demo mode on); the built bundle is checked for it afterwards.

SHA=$(git rev-parse --short HEAD)$(git diff --quiet -- src public index.html vite.config.js || echo -dirty)
REL="$BASE/releases/$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
mkdir -p "$BASE/releases"

npx cross-env VITE_DEMO_MODE=false vite build --outDir "$REL" --emptyOutDir

# Sanity checks before going live.
for f in index.html serviceWorker.js manifest.webmanifest pwa-192x192.png pwa-512x512.png maskable-icon-512x512.png; do
  [[ -s "$REL/$f" ]] || { echo "Build is missing $f" >&2; rm -rf "$REL"; exit 1; }
done
ls "$REL"/assets/*.wasm >/dev/null || { echo "Build is missing sqlite3.wasm" >&2; rm -rf "$REL"; exit 1; }
# No server secrets may ever reach the bundle (VITE_* values are public client identifiers only).
if grep -rlE 'BEGIN (RSA )?PRIVATE KEY|"private_key"|OTP_PEPPER|DATABASE_URL|POSTGRES_PASSWORD' "$REL"; then
  echo "Refusing: secret-looking content in the build (files above)" >&2; rm -rf "$REL"; exit 1
fi

# Demo mode compiles in this capture-blocking message; a production bundle must not contain it.
if grep -rq 'Demo mode: records are not saved' "$REL/assets"; then
  echo "Refusing: the build has demo mode enabled" >&2; rm -rf "$REL"; exit 1
fi

chmod -R a+rX "$REL"
ln -sfn "$REL" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
echo "Live: $REL"

# Keep the newest $KEEP releases (never the live one).
ls -1dt "$BASE"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ "$(readlink -f "$BASE/current")/" == "$old" ]] || rm -rf "$old"
done
