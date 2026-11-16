#!/usr/bin/env python3
"""What /downloads/latest.json says about an APK release, read from the built APK itself.

    describe-apk.py app.apk badging.txt cert.txt > apk.json

badging.txt is `aapt2 dump badging <apk>`, cert.txt the signing certificate's SHA-256 digest (from
`apksigner verify --print-certs`). Run by the build-apk job in .github/workflows/deploy.yml; the server
adds the commit id and the published file name (deploy/scripts/receive-release.sh).
"""
import hashlib
import json
import re
import sys
from pathlib import Path


def field(badging: str, pattern: str, default: str = "") -> str:
    m = re.search(pattern, badging)
    return m.group(1) if m else default


def describe(apk: Path, badging: str, certificate: str) -> dict:
    data = apk.read_bytes()
    return {
        "package": field(badging, r"package: name='([^']*)'"),
        "version_name": field(badging, r"versionName='([^']*)'"),
        "version_code": int(field(badging, r"versionCode='([0-9]+)'", "0")),
        "min_sdk": int(field(badging, r"(?:minSdkVersion|sdkVersion):'([0-9]+)'", "0")),
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "certificate_sha256": certificate.strip(),
    }


if __name__ == "__main__":
    apk_path, badging_path, cert_path = (Path(a) for a in sys.argv[1:4])
    json.dump(
        describe(apk_path, badging_path.read_text(encoding="utf-8"), cert_path.read_text(encoding="utf-8")),
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
