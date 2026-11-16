#!/usr/bin/env bash
# Receives a release from GitHub Actions and applies it. The ONLY command the CI key may run: installed as
# /usr/local/sbin/swachh-receive-release, reached through swachhdeploy's forced-command SSH key + sudo.
#
# stdin: tar.gz with  SHA (commit id)  web/ (built PWA)  [app.apk]
# Order: back up DB -> backend at SHA (git fetch, deps if changed, restart = migrations) -> health check
#        (roll back on failure, frontend untouched) -> switch frontend -> publish APK. Builds nothing here.
set -euo pipefail
REPO=/var/www/html/swachhsafar2.0/swachhsafar
BASE=/var/www/html/swachhsafar2.0
DOWNLOADS=$BASE/downloads
GIT_KEY=/etc/swachhsafar/github_deploy_key
KEEP=5
log() { echo "[receive $(date -u +%H:%M:%S)] $*"; }

work=$(mktemp -d /var/tmp/swachh-release.XXXXXX)
trap 'rm -rf "$work"' EXIT
head -c 300000000 | tar -xzf - -C "$work"   # 300 MB cap
SHA=$(tr -dc '0-9a-f' < "$work/SHA" | head -c 40)
[[ ${#SHA} -eq 40 ]] || { log "refused: bad SHA"; exit 1; }
for f in index.html serviceWorker.js manifest.webmanifest; do [[ -s "$work/web/$f" ]] || { log "refused: web/$f missing"; exit 1; }; done
log "release $SHA"

# 1. Database backup.
systemctl start swachhsafar-db-backup.service && log "database backed up"

# 2. Backend code at SHA.
cd "$REPO"
export GIT_SSH_COMMAND="ssh -i $GIT_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
prev=$(git rev-parse HEAD)
git fetch -q origin main
git cat-file -e "$SHA^{commit}" || { log "refused: $SHA is not on origin/main"; exit 1; }
git merge-base --is-ancestor "$SHA" origin/main || { log "refused: $SHA is not on origin/main"; exit 1; }
git checkout -q -B main "$SHA"
if ! git diff --quiet "$prev" "$SHA" -- backend/pyproject.toml; then
  log "backend dependencies changed: installing"
  backend/.venv/bin/pip install -q -e backend
fi

# 3. Restart (ExecStartPre runs migrations) and health check; roll back the backend if it does not come up.
systemctl restart swachhsafar-api
ok=0
for _ in $(seq 1 30); do
  curl -fsS -m 3 http://127.0.0.1:8010/health >/dev/null 2>&1 && { ok=1; break; }
  sleep 1
done
if [[ $ok -ne 1 ]]; then
  log "API unhealthy after update: rolling back backend to $prev (frontend not changed)"
  git checkout -q -B main "$prev"
  systemctl restart swachhsafar-api || true
  journalctl -u swachhsafar-api -n 30 --no-pager || true
  exit 1
fi
log "API healthy"

# 4. Frontend: new release directory, atomic switch, keep the newest $KEEP.
rel="$BASE/releases/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}"
mkdir -p "$BASE/releases"
cp -a "$work/web" "$rel"
chmod -R a+rX "$rel"
ln -sfn "$rel" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
ls -1dt "$BASE"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ "$(readlink -f "$BASE/current")/" == "$old" ]] || rm -rf "$old"
done
log "frontend live: $rel"

# 5. Android app, when the pipeline built one. latest.json describes the published release: the /download
# page shows it, and the installed app compares its `sha` with its own build to offer an update.
if [[ -s "$work/app.apk" ]]; then
  install -d -m 755 "$DOWNLOADS"
  name="swachh-safar-${SHA:0:7}.apk"
  install -m 644 "$work/app.apk" "$DOWNLOADS/$name"
  ln -sfn "$name" "$DOWNLOADS/swachh-safar-latest.apk"
  SHA="$SHA" NAME="$name" META="$work/apk.json" python3 - > "$DOWNLOADS/latest.json.new" <<'PY'
import datetime, json, os, pathlib
meta = {}
path = pathlib.Path(os.environ["META"])          # written by the build-apk job (scripts/describe-apk.py)
if path.is_file():
    try:
        meta = json.loads(path.read_text())
    except ValueError:
        meta = {}
name = os.environ["NAME"]
meta.update({
    "sha": os.environ["SHA"], "file": name,
    "url": f"/downloads/{name}", "latest_url": "/downloads/swachh-safar-latest.apk",
    "released_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
})
print(json.dumps(meta, indent=2))
PY
  mv -f "$DOWNLOADS/latest.json.new" "$DOWNLOADS/latest.json"
  chmod 644 "$DOWNLOADS/latest.json"
  log "APK published: $name"
fi
log "done"
