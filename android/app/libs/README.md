# Vendor SDK libraries

Place the ACPL (Access Computech) non-Aadhaar Android SDK here.

The `SwachhFingerprint` plugin's `AcplAst300Driver` will detect the SDK on the classpath
at runtime. Until the `.aar` / `.jar` is present, the plugin reports `connected: false` with
`reason: "sdk_not_installed"` when the scanner hardware is attached.

## What to get from the vendor

Contact Access Computech and request their **non-Aadhaar / non-RD-Service Android SDK** for
the AST300 (or FM220). This is _not_ the UIDAI L1 RD Service — that returns encrypted PID
blocks that cannot be compared locally. The SDK must:

1. Communicate with the scanner over **USB OTG** (not Bluetooth or serial).
2. Return **ISO 19794-2 minutiae templates** (not fingerprint images).
3. Provide a **matcher function** that compares two templates and returns a numeric score.

## After placing the SDK file

1. Drop the `.aar` (or `.jar`) into this directory.
2. Open `AcplAst300Driver.kt` and:
   - Update `SDK_CLASS` to the actual entry-point class name from the vendor's API docs.
   - Implement `captureWithSdk()` using the vendor's capture API.
   - Implement `matchWithSdk()` using the vendor's matcher API.
3. Rebuild the app: `cd android && ./gradlew assembleDebug`.

The `build.gradle` already includes `implementation fileTree(include: ['*.jar', '*.aar'], dir: 'libs')`,
so any file placed here is automatically on the compile and runtime classpath.

