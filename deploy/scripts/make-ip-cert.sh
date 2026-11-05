#!/usr/bin/env bash
# Private CA + server certificate for https://<IP>:<port> (no domain name).
#
#   sudo deploy/scripts/make-ip-cert.sh 76.13.243.27
#
# - The CA is created ONCE and never overwritten: every phone that installed it would stop trusting the
#   site. It is name-constrained to the single IP, so even a leaked CA key cannot sign a certificate that
#   phones would accept for any other host or address.
# - The server certificate is (re)issued on each run, valid 397 days. Re-run before it expires; phones
#   need no change because they trust the CA, not the leaf.
set -euo pipefail

IP="${1:?usage: make-ip-cert.sh <ipv4-address>}"
DIR=/etc/swachhsafar/tls
CA_DAYS=3650
LEAF_DAYS=397
install -d -m 750 "$DIR"
umask 077

if [[ ! -f "$DIR/ca.key" ]]; then
  echo "Creating private CA (name-constrained to IP $IP)"
  openssl genrsa -out "$DIR/ca.key" 4096
  openssl req -x509 -new -key "$DIR/ca.key" -sha256 -days "$CA_DAYS" -out "$DIR/ca.crt" \
    -subj "/O=Swachh Safar/CN=Swachh Safar Device CA ($IP)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -addext "nameConstraints=critical,permitted;IP:$IP/255.255.255.255"
else
  echo "Keeping existing CA ($DIR/ca.crt)"
  openssl x509 -in "$DIR/ca.crt" -noout -ext nameConstraints | grep -q "IP:$IP/255.255.255.255" \
    || { echo "Existing CA is not constrained to $IP; refusing to continue." >&2; exit 1; }
fi

echo "Issuing server certificate for IP:$IP ($LEAF_DAYS days)"
openssl genrsa -out "$DIR/server.key.new" 2048
openssl req -new -key "$DIR/server.key.new" -subj "/O=Swachh Safar/CN=$IP" -out "$DIR/server.csr"
cat > "$DIR/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$IP
authorityKeyIdentifier=keyid
subjectKeyIdentifier=hash
EOF
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile "$DIR/server.ext" -out "$DIR/server.crt.new"
openssl verify -CAfile "$DIR/ca.crt" "$DIR/server.crt.new"

mv "$DIR/server.key.new" "$DIR/server.key"
mv "$DIR/server.crt.new" "$DIR/server.crt"
cat "$DIR/server.crt" "$DIR/ca.crt" > "$DIR/server-fullchain.crt"
rm -f "$DIR/server.csr" "$DIR/server.ext"
chmod 600 "$DIR/ca.key" "$DIR/server.key"
chmod 644 "$DIR/ca.crt" "$DIR/server.crt" "$DIR/server-fullchain.crt"
chmod 755 "$DIR"

echo
echo "CA certificate for phones: $DIR/ca.crt (served at https://$IP:<port>/swachhsafar-ca.crt)"
openssl x509 -in "$DIR/ca.crt" -noout -fingerprint -sha256
openssl x509 -in "$DIR/server.crt" -noout -enddate
