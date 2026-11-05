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

# Media files: mirrored (never --delete, so a file removed from uploads/ is still kept in the backup).
MEDIA_SRC=/var/www/html/swachhsafar2.0/uploads
MEDIA_DST=/var/backups/swachhsafar/uploads
if [[ -d "$MEDIA_SRC" ]]; then
  install -d -m 700 "$MEDIA_DST"
  rsync -a "$MEDIA_SRC"/ "$MEDIA_DST"/
  echo "Media mirror: $MEDIA_DST ($(du -sh "$MEDIA_DST" | cut -f1))"
fi
