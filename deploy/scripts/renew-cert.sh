#!/usr/bin/env bash
# Obtains or renews the Let's Encrypt IP certificate (6-day "shortlived" profile; IP certificates are
# only issued with it). Safe to run often: lego renews only when ~1/3 of the lifetime is left, or when
# Let's Encrypt's renewal info (ARI) asks for it, and then runs cert-deploy-hook.sh.
#
#   sudo deploy/scripts/renew-cert.sh            # production (used by swachhsafar-cert-renew.timer)
#   sudo deploy/scripts/renew-cert.sh --staging  # Let's Encrypt staging: proves validation works, installs nothing
set -euo pipefail
IP="${SWACHH_CERT_IP:-76.13.243.27}"
REPO=/var/www/html/swachhsafar2.0/swachhsafar
args=(run --accept-tos --account-id swachhsafar --domains "$IP" --profile shortlived
      --http --http.webroot /var/www/acme)
if [[ "${1:-}" == "--staging" ]]; then
  exec /usr/local/bin/lego "${args[@]}" --server letsencrypt-staging --path /etc/swachhsafar/lego-staging
fi
exec /usr/local/bin/lego "${args[@]}" --path /etc/swachhsafar/lego \
  --deploy-hook "$REPO/deploy/scripts/cert-deploy-hook.sh"
