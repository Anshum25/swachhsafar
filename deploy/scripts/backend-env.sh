#!/usr/bin/env bash
# Creates /etc/swachhsafar/backend.env for the production API, once. An existing file is never touched
# (it holds the OTP pepper: changing it invalidates every OTP in flight).
#
#   sudo deploy/scripts/backend-env.sh https://76.13.243.27:8082
set -euo pipefail

ORIGIN="${1:?usage: backend-env.sh <public https origin, e.g. https://76.13.243.27:8082>}"
OUT=/etc/swachhsafar/backend.env
PG=/etc/swachhsafar/postgres.env

if [[ -f "$OUT" ]]; then echo "$OUT exists; left unchanged."; exit 0; fi
[[ -f "$PG" ]] || { echo "Run postgres-container.sh first ($PG missing)." >&2; exit 1; }
# shellcheck disable=SC1090
source "$PG"

umask 027
cat > "$OUT" <<EOF
# Swachh Safar API — production settings (read by swachhsafar-api.service). Never commit this file.
ENVIRONMENT=production
DATABASE_URL=postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5433/${POSTGRES_DB}

# Firebase Admin service account (verifies sign-in tokens; signs media URLs). Mode 640 root:swachhsafar.
FIREBASE_PROJECT_ID=swachh-safar
FIREBASE_CREDENTIALS_FILE=/etc/swachhsafar/firebase-admin.json
# Bucket of the registered web app (VITE_FIREBASE_STORAGE_BUCKET). Check it in Firebase console → Storage.
FIREBASE_STORAGE_BUCKET=swachh-safar.firebasestorage.app
STORAGE_BACKEND=firebase

OTP_PEPPER=$(openssl rand -base64 48 | tr -d '\n')

# Same-origin PWA: the browser does not need CORS, this only allows the public origin explicitly.
CORS_ORIGINS='["${ORIGIN}"]'

SMS_PROVIDER=disabled
PNR_PROVIDER=disabled
EOF
chgrp swachhsafar "$OUT" 2>/dev/null || true
chmod 640 "$OUT"
echo "Wrote $OUT"
