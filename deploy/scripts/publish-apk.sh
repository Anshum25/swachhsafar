#!/usr/bin/env bash
# Publishes a signed release APK for download at /downloads/ (served by nginx, see swachhsafar-app.conf).
#
#   sudo deploy/scripts/publish-apk.sh path/to/app-release.apk
#
# Requires Android build-tools on PATH (apksigner, aapt2 or aapt) to verify the signature and read the
# version. Refuses debug builds, unsigned APKs and the wrong package. Older versions are kept for rollback;
# swachh-safar-latest.apk and latest.json always describe the newest one. Nothing here touches device data.
set -euo pipefail

APK=${1:?usage: publish-apk.sh path/to/app-release.apk}
DEST=${DOWNLOADS_DIR:-/var/www/html/swachhsafar2.0/downloads}
PACKAGE=in.itfarmer.swachhsafar
[[ -f "$APK" ]] || { echo "No such file: $APK" >&2; exit 1; }

command -v apksigner >/dev/null || { echo "apksigner not found (Android SDK build-tools)" >&2; exit 1; }
AAPT=$(command -v aapt2 || command -v aapt || true)
[[ -n "$AAPT" ]] || { echo "aapt2/aapt not found (Android SDK build-tools)" >&2; exit 1; }

# 1. Signature (v2/v3) and certificate.
apksigner verify --verbose "$APK" >/dev/null || { echo "Refusing: APK signature does not verify" >&2; exit 1; }
CERT=$(apksigner verify --print-certs "$APK" | sed -n 's/.*certificate SHA-256 digest: //p' | head -n1)
if apksigner verify --print-certs "$APK" | grep -qi "CN=Android Debug"; then
  echo "Refusing: signed with the Android debug key" >&2; exit 1
fi

# 2. Package, version, minimum SDK, not debuggable.
BADGING=$("$AAPT" dump badging "$APK")
PKG=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$BADGING")
VCODE=$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<<"$BADGING" | head -n1)
VNAME=$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -n1)
MINSDK=$(sed -n "s/^\(minSdkVersion\|sdkVersion\):'\([0-9]*\)'.*/\2/p" <<<"$BADGING" | head -n1)
[[ "$PKG" == "$PACKAGE" ]] || { echo "Refusing: package is '$PKG', expected $PACKAGE" >&2; exit 1; }
grep -q "application-debuggable" <<<"$BADGING" && { echo "Refusing: debuggable (debug) build" >&2; exit 1; }

# 3. Upgrade compatibility: same signing certificate and a higher versionCode than the published one.
if [[ -f "$DEST/latest.json" ]]; then
  PREV_CERT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("certificate_sha256",""))' "$DEST/latest.json")
  PREV_CODE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("version_code",0))' "$DEST/latest.json")
  [[ -z "$PREV_CERT" || "$PREV_CERT" == "$CERT" ]] || { echo "Refusing: signing certificate differs from the published release (installed apps could not update)" >&2; exit 1; }
  (( VCODE > PREV_CODE )) || { echo "Refusing: versionCode $VCODE is not higher than the published $PREV_CODE" >&2; exit 1; }
fi

# 4. Publish.
install -d -m 755 "$DEST"
NAME="swachh-safar-$VNAME.apk"
install -m 644 "$APK" "$DEST/$NAME"
install -m 644 "$APK" "$DEST/swachh-safar-latest.apk.new" && mv -f "$DEST/swachh-safar-latest.apk.new" "$DEST/swachh-safar-latest.apk"
SHA=$(sha256sum "$DEST/$NAME" | cut -d' ' -f1)
SIZE=$(stat -c %s "$DEST/$NAME")
python3 - "$DEST/latest.json" <<EOF
import json, sys, datetime
json.dump({
    "package": "$PKG", "version_name": "$VNAME", "version_code": int("$VCODE"), "min_sdk": int("${MINSDK:-26}"),
    "file": "$NAME", "latest_url": "/downloads/swachh-safar-latest.apk", "url": "/downloads/$NAME",
    "size_bytes": int("$SIZE"), "sha256": "$SHA", "certificate_sha256": "$CERT",
    "released_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
}, open(sys.argv[1] + ".new", "w"), indent=2)
EOF
mv -f "$DEST/latest.json.new" "$DEST/latest.json"
echo "Published $NAME ($VNAME / $VCODE, $SIZE bytes) sha256=$SHA"
