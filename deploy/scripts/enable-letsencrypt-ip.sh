#!/usr/bin/env bash
# Switches https://76.13.243.27:8082 to a publicly trusted Let's Encrypt IP certificate, so phones need no
# certificate setup and the link can simply be shared (e.g. on WhatsApp).
#
#   sudo /var/www/html/swachhsafar2.0/swachhsafar/deploy/scripts/enable-letsencrypt-ip.sh
#
# What it changes:
#   1. SkyPOS nginx site (it answers http://76.13.243.27/): adds ONE location serving only
#      /.well-known/acme-challenge/ from /var/www/acme. Backup first; restored automatically if
#      `nginx -t` fails or SkyPOS stops answering as before.
#   2. Gets a Let's Encrypt STAGING certificate first (proves validation; installs nothing), then the real one.
#   3. Installs it for the Swachh Safar site only (active.crt/active.key) and enables auto-renewal
#      (swachhsafar-cert-renew.timer, twice a day; 6-day certificates renew about every 2 days).
# Re-running is safe: every step checks what is already done.
set -euo pipefail

IP=76.13.243.27
REPO=/var/www/html/swachhsafar2.0/swachhsafar
SKYPOS=/etc/nginx/sites-available/skypos
BACKUPS=/var/backups/swachhsafar/nginx
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -x /usr/local/bin/lego ]] || { echo "/usr/local/bin/lego missing" >&2; exit 1; }

echo "== 1/4 SkyPOS: ACME challenge location"
install -d -m 755 /var/www/acme/.well-known/acme-challenge
if grep -q 'acme-challenge' "$SKYPOS"; then
  echo "   already present"
else
  before=$(curl -s -o /dev/null -w '%{http_code}' "http://$IP/")
  install -d -m 755 "$BACKUPS"
  backup="$BACKUPS/skypos.$(date +%Y%m%d-%H%M%S).bak"
  cp -p "$SKYPOS" "$backup"
  restore() { cp -p "$backup" "$SKYPOS"; nginx -t >/dev/null 2>&1 && systemctl reload nginx; echo "   RESTORED SkyPOS from $backup" >&2; }
  python3 - "$SKYPOS" "$IP" <<'EOF'
import sys
p, ip = sys.argv[1], sys.argv[2]
s = open(p).read()
needle = f'    server_name {ip};\n'
if s.count(needle) != 1:
    sys.exit(f'unexpected layout in {p}: expected one "{needle.strip()}" line')
s = s.replace(needle, needle + '''
    # Let's Encrypt HTTP-01 validation for the Swachh Safar IP certificate (added by
    # swachhsafar2.0/deploy/scripts/enable-letsencrypt-ip.sh). Serves only this path; SkyPOS is unchanged.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
        try_files $uri =404;
    }
''')
open(p, 'w').write(s)
EOF
  if ! nginx -t; then restore; exit 1; fi
  systemctl reload nginx
  after=$(curl -s -o /dev/null -w '%{http_code}' "http://$IP/")
  if [[ "$after" != "$before" ]]; then echo "   SkyPOS answered $after (was $before)" >&2; restore; exit 1; fi
  echo "   added (backup: $backup); SkyPOS still answers $after"
fi
probe="probe-$RANDOM$RANDOM"
echo ok > "/var/www/acme/.well-known/acme-challenge/$probe"
got=$(curl -s "http://$IP/.well-known/acme-challenge/$probe" || true)
rm -f "/var/www/acme/.well-known/acme-challenge/$probe"
[[ "$got" == ok ]] || { echo "Challenge path not reachable at http://$IP/.well-known/acme-challenge/ (got: ${got:0:80})" >&2; exit 1; }
echo "   challenge path reachable"

echo "== 2/4 Let's Encrypt staging (dry run)"
"$REPO/deploy/scripts/renew-cert.sh" --staging

echo "== 3/4 Let's Encrypt production certificate"
"$REPO/deploy/scripts/renew-cert.sh"
[[ "$(readlink /etc/swachhsafar/tls/active.crt)" == le/fullchain.pem ]] || { echo "Certificate not installed (see above)" >&2; exit 1; }

echo "== 4/4 auto-renewal"
install -m 644 "$REPO/deploy/systemd/swachhsafar-cert-renew.service" "$REPO/deploy/systemd/swachhsafar-cert-renew.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now swachhsafar-cert-renew.timer
systemctl list-timers swachhsafar-cert-renew.timer --no-pager | sed -n 2p

echo
echo "Done. Publicly trusted: https://$IP:8082"
openssl x509 -in /etc/swachhsafar/tls/active.crt -noout -issuer -enddate
