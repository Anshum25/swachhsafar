#!/usr/bin/env bash
# Switches PNR verification on in /etc/swachhsafar/backend.env and restarts the API. backend-env.sh writes
# PNR_PROVIDER=disabled, and then every "Verify PNR" answers "PNR service unavailable".
#
#   sudo deploy/scripts/enable-pnr.sh [--railradar <permission reference>] [--check <PNR>] < key.txt
#
# The RapidAPI key (IRCTC Indian Railway PNR Status) is read from stdin, so it never lands in shell history
# or the process list. Without --railradar the provider is RapidAPI alone. With it: RailRadar first, RapidAPI
# as the fallback. The old file is kept as backend.env.<timestamp>.bak. --check runs `app.cli pnr-check`
# afterwards with the server's own settings. It only prints what the providers answer and stores nothing.
set -euo pipefail

ENV_FILE=/etc/swachhsafar/backend.env
BACKEND_DIR="$(systemctl show -p WorkingDirectory --value swachhsafar-api)"
BACKEND_DIR="${BACKEND_DIR:-/var/www/html/swachhsafar2.0/swachhsafar/backend}"
RAILRADAR_REF="" CHECK_PNR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --railradar) RAILRADAR_REF="${2:?--railradar needs the permission reference}"; shift 2 ;;
    --check) CHECK_PNR="${2:?--check needs a 10-digit PNR}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE not found (run backend-env.sh first)" >&2; exit 1; }

if [[ -t 0 ]]; then printf 'RapidAPI key: ' >&2; IFS= read -rs KEY; echo >&2; else IFS= read -r KEY || true; fi
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[[ -n "$KEY" ]] || { echo "no RapidAPI key given on stdin" >&2; exit 1; }

cp -p "$ENV_FILE" "$ENV_FILE.$(date +%Y%m%d-%H%M%S).bak"
TMP="$(mktemp "$ENV_FILE.XXXX")"
grep -v -E '^(PNR_PROVIDER|PNR_API_URL|PNR_API_HOST|PNR_API_KEY|RAILRADAR_PNR_AUTHORIZATION)=' "$ENV_FILE" > "$TMP" || true
{
  echo ""
  echo "# PNR verification (deploy/scripts/enable-pnr.sh, $(date -I))"
  if [[ -n "$RAILRADAR_REF" ]]; then
    echo "PNR_PROVIDER=railradar"
    echo "RAILRADAR_PNR_AUTHORIZATION=$RAILRADAR_REF"
  else
    echo "PNR_PROVIDER=rapidapi"
  fi
  echo "PNR_API_URL=https://irctc-indian-railway-pnr-status.p.rapidapi.com/getPNRStatus/"
  echo "PNR_API_HOST=irctc-indian-railway-pnr-status.p.rapidapi.com"
  echo "PNR_API_KEY=$KEY"
} >> "$TMP"
chgrp --reference="$ENV_FILE" "$TMP"; chmod --reference="$ENV_FILE" "$TMP"
mv "$TMP" "$ENV_FILE"
echo "Updated $ENV_FILE (PNR_PROVIDER=$([[ -n "$RAILRADAR_REF" ]] && echo railradar || echo rapidapi))"

systemctl restart swachhsafar-api
echo "swachhsafar-api restarted"

if [[ -n "$CHECK_PNR" ]]; then
  cd "$BACKEND_DIR"
  sudo -u swachhsafar bash -c "set -a; . '$ENV_FILE'; set +a; .venv/bin/python -m app.cli pnr-check '$CHECK_PNR'"
fi
