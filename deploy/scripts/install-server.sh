#!/usr/bin/env bash
# One-time (and safely repeatable) server setup for Swachh Safar 2.0 on https://<IP>:<PORT>.
#
#   sudo deploy/scripts/install-server.sh 76.13.243.27 8082
#
# Steps (each idempotent): service user · PostgreSQL container · backend env · TLS (private CA) ·
# backend venv · systemd units · nginx site · frontend release. Nothing here deletes data.
# Other nginx sites are never modified; `nginx -t` must pass before any reload.
set -euo pipefail

IP="${1:?usage: install-server.sh <ip> <port>}"
PORT="${2:?usage: install-server.sh <ip> <port>}"
REPO=/var/www/html/swachhsafar2.0/swachhsafar
cd "$REPO"
grep -q "listen $PORT ssl" deploy/nginx/swachhsafar.conf && grep -q "server_name $IP " deploy/nginx/swachhsafar.conf \
  || { echo "deploy/nginx/swachhsafar.conf is written for another IP/port; edit it first." >&2; exit 1; }

echo "== service user"
id swachhsafar >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin swachhsafar

echo "== PostgreSQL"
deploy/scripts/postgres-container.sh

echo "== media folder"
install -d -m 750 -o swachhsafar -g swachhsafar /var/www/html/swachhsafar2.0/uploads

echo "== backend env"
deploy/scripts/backend-env.sh "https://$IP:$PORT"
chgrp swachhsafar /etc/swachhsafar/backend.env && chmod 640 /etc/swachhsafar/backend.env
if [[ -f /etc/swachhsafar/firebase-admin.json ]]; then
  chgrp swachhsafar /etc/swachhsafar/firebase-admin.json && chmod 640 /etc/swachhsafar/firebase-admin.json
else
  echo "   NOTE: /etc/swachhsafar/firebase-admin.json not present yet: the API starts, but every"
  echo "         authenticated call answers 503 auth_not_configured until it is added (then restart)."
fi

echo "== TLS"
[[ -f /etc/swachhsafar/tls/server.crt ]] || deploy/scripts/make-ip-cert.sh "$IP"

echo "== backend venv"
[[ -x backend/.venv/bin/python ]] || python3 -m venv backend/.venv
backend/.venv/bin/pip install -q -e backend

echo "== systemd"
install -m 644 deploy/systemd/swachhsafar-api.service deploy/systemd/swachhsafar-db-backup.service \
  deploy/systemd/swachhsafar-db-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now swachhsafar-db-backup.timer
systemctl enable swachhsafar-api.service
systemctl restart swachhsafar-api.service

echo "== frontend"
deploy/scripts/deploy-frontend.sh

echo "== nginx"
install -d -m 755 /etc/swachhsafar/nginx
install -m 644 deploy/nginx/security-headers.conf /etc/swachhsafar/nginx/security-headers.conf
SITE=/etc/nginx/sites-available/swachhsafar
install -d -m 755 /var/backups/swachhsafar/nginx
if [[ -s "$SITE" ]]; then cp -p "$SITE" "/var/backups/swachhsafar/nginx/swachhsafar.$(date +%Y%m%d-%H%M%S).bak"; fi
install -m 644 deploy/nginx/swachhsafar.conf "$SITE"
ln -sfn "$SITE" /etc/nginx/sites-enabled/swachhsafar
nginx -t
systemctl reload nginx

echo
echo "Done: https://$IP:$PORT  (CA for phones: https://$IP:$PORT/swachhsafar-ca.crt)"
openssl x509 -in /etc/swachhsafar/tls/ca.crt -noout -fingerprint -sha256
