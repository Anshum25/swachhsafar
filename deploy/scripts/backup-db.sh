#!/usr/bin/env bash
# Daily logical backup of the Swachh Safar database (run by swachhsafar-db-backup.timer).
# Restore into an EMPTY database:  docker exec -i swachhsafar_db pg_restore -U swachh -d <db> --clean --if-exists < FILE
set -euo pipefail
DIR=/var/backups/swachhsafar/db
KEEP_DAYS=14
install -d -m 700 "$DIR"
out="$DIR/swachh_safar-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec swachhsafar_db pg_dump -U swachh -d swachh_safar -Fc > "$out.part"
mv "$out.part" "$out"
chmod 600 "$out"
find "$DIR" -name 'swachh_safar-*.dump' -mtime +$KEEP_DAYS -delete
echo "Backup: $out ($(du -h "$out" | cut -f1))"
