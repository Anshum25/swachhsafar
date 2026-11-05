#!/usr/bin/env bash
# Points nginx back at an earlier frontend release (default: the one before the live release).
#
#   sudo deploy/scripts/rollback-frontend.sh            # previous release
#   sudo deploy/scripts/rollback-frontend.sh <dirname>  # a specific release under releases/
#
# Phones get the rolled-back service worker as a normal update (byte-different serviceWorker.js), so
# local data in OPFS is kept exactly as with any update.
set -euo pipefail
BASE=/var/www/html/swachhsafar2.0
live=$(basename "$(readlink -f "$BASE/current")")
if [[ $# -ge 1 ]]; then target="$1"; else
  target=$(ls -1t "$BASE/releases" | grep -vx "$live" | head -n1)
fi
[[ -n "${target:-}" && -f "$BASE/releases/$target/index.html" ]] || { echo "No such release: ${target:-<none>}" >&2; ls -1t "$BASE/releases"; exit 1; }
ln -sfn "$BASE/releases/$target" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
echo "Rolled back: $live -> $target"
