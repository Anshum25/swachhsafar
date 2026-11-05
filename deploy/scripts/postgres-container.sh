#!/usr/bin/env bash
# Dedicated PostgreSQL 16 for Swachh Safar, in Docker, reachable only from this host (127.0.0.1:5433).
# Idempotent: an existing container/volume is kept as is (data is never reset).
#
#   sudo deploy/scripts/postgres-container.sh
#
# Credentials are generated once into /etc/swachhsafar/postgres.env (root only) and reused afterwards.
set -euo pipefail

NAME=swachhsafar_db
VOLUME=swachhsafar_pgdata
PORT=5433
ENV_FILE=/etc/swachhsafar/postgres.env
install -d -m 755 /etc/swachhsafar

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  printf 'POSTGRES_USER=swachh\nPOSTGRES_DB=swachh_safar\nPOSTGRES_PASSWORD=%s\n' \
    "$(openssl rand -base64 36 | tr -d '/+=\n' | head -c 40)" > "$ENV_FILE"
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
  echo "Container $NAME exists; starting it if stopped."
  docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C.UTF-8" \
    -e TZ=UTC \
    -p 127.0.0.1:${PORT}:5432 \
    -v "$VOLUME":/var/lib/postgresql/data \
    --shm-size=256m \
    --health-cmd='pg_isready -U swachh -d swachh_safar' --health-interval=10s \
    postgres:16 >/dev/null
fi

for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" == healthy ]] && { echo "PostgreSQL ready on 127.0.0.1:$PORT"; exit 0; }
  sleep 1
done
echo "PostgreSQL did not become healthy; see: docker logs $NAME" >&2
exit 1
