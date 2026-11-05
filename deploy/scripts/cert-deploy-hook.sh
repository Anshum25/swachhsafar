#!/usr/bin/env bash
# lego deploy hook: installs a newly issued/renewed Let's Encrypt certificate for nginx.
# lego passes LEGO_HOOK_CERT_PATH (full chain) and LEGO_HOOK_CERT_KEY_PATH. The new certificate goes live
# only if it covers the IP, matches its key, and nginx accepts it; otherwise the previous one stays.
set -euo pipefail

IP="${SWACHH_CERT_IP:-76.13.243.27}"
TLS=/etc/swachhsafar/tls
LE="$TLS/le"
CRT="${LEGO_HOOK_CERT_PATH:?LEGO_HOOK_CERT_PATH not set (run by lego only)}"
KEY="${LEGO_HOOK_CERT_KEY_PATH:?LEGO_HOOK_CERT_KEY_PATH not set}"

openssl x509 -in "$CRT" -noout -ext subjectAltName | grep -q "IP Address:$IP" \
  || { echo "cert-deploy-hook: certificate does not cover IP $IP; not installed" >&2; exit 1; }
[[ "$(openssl x509 -in "$CRT" -noout -pubkey | sha256sum)" == "$(openssl pkey -in "$KEY" -pubout | sha256sum)" ]] \
  || { echo "cert-deploy-hook: key does not match certificate; not installed" >&2; exit 1; }

install -d -m 700 "$LE"
install -m 644 "$CRT" "$LE/fullchain.pem.new"
install -m 600 "$KEY" "$LE/privkey.pem.new"
mv -f "$LE/fullchain.pem.new" "$LE/fullchain.pem"
mv -f "$LE/privkey.pem.new" "$LE/privkey.pem"

prev_crt=$(readlink "$TLS/active.crt" || true)
prev_key=$(readlink "$TLS/active.key" || true)
ln -sfn le/fullchain.pem "$TLS/active.crt"
ln -sfn le/privkey.pem "$TLS/active.key"

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "cert-deploy-hook: installed, valid until $(openssl x509 -in "$LE/fullchain.pem" -noout -enddate | cut -d= -f2)"
else
  [[ -n "$prev_crt" ]] && ln -sfn "$prev_crt" "$TLS/active.crt"
  [[ -n "$prev_key" ]] && ln -sfn "$prev_key" "$TLS/active.key"
  echo "cert-deploy-hook: nginx rejected the configuration; previous certificate kept" >&2
  exit 1
fi
