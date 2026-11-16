# Swachh Safar Android Native Scaffold & Plugin Setup

## 1. Directory Structure
The Android native scaffold is located at `/var/www/html/swachhsafar2.0/swachhsafar/android`:
```
android/
├── build.gradle
├── settings.gradle
└── app/
    ├── build.gradle
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── res/values/
        │   ├── strings.xml
        │   └── styles.xml
        └── java/in/itfarmer/swachhsafar/
            ├── MainActivity.kt
            └── security/
                └── SwachhSecurityPlugin.kt
```

---

## 2. Native Capabilities Implemented in Kotlin
`SwachhSecurityPlugin.kt` implements the bridge contract invoked by `src/security/native.js`:

| Method | Implementation Details |
|---|---|
| `getLocationStatus` | Inspects `ACCESS_FINE_LOCATION` and `LocationManager.GPS_PROVIDER` |
| `requestLocationPermission` | Requests runtime location permission for Android 8.0 through Android 14+ |
| `getCurrentLocation` | Calls Google Play Services `FusedLocationProviderClient` with `PRIORITY_HIGH_ACCURACY`, detects mock location (`loc.isMock` or `loc.isFromMockProvider`) |
| `openLocationSettings` | Launches Android system `Settings.ACTION_LOCATION_SOURCE_SETTINGS` intent |
| `getNetworkState` | Reads active network `NetworkCapabilities.TRANSPORT_VPN` |
| `networkChange` event | Emits background events via `ConnectivityManager.NetworkCallback` |
| `secureGet` / `secureSet` | Hardware-backed `EncryptedSharedPreferences` utilizing Android Keystore (`MasterKey` AES256-GCM) |
| `getMonotonicTime` | Returns `SystemClock.elapsedRealtime()` and `SystemClock.uptimeMillis()` for tamper detection |

---

## 3. Building with Android Studio or Gradle CLI

### Prerequisites
- JDK 17 (Java Development Kit)
- Android SDK Platform 34 (API 34) & Build Tools 34.0.0
- Google Play Services Repository

### Build Steps
1. Build frontend distribution bundle:
   ```bash
   npm run build
   ```
2. Sync web assets into Android project assets:
   ```bash
   npx cap sync android
   ```
3. Assemble Debug APK:
   ```bash
   cd android && ./gradlew assembleDebug
   ```
   Debug APK artifact output: `android/app/build/outputs/apk/debug/app-debug.apk`

4. Assemble Production Release APK:
   ```bash
   cd android && ./gradlew assembleRelease
   ```
   Sign with production railway release keystore:
   ```bash
   jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
     -keystore /path/to/swachh_release.keystore \
     android/app/build/outputs/apk/release/app-release-unsigned.apk swachh_key_alias
   ```
   Align APK:
   ```bash
   zipalign -v 4 app-release-unsigned.apk swachh-safar-v2.0.0.apk
   ```


## Publishing the APK for download (2026-11-06)

**Why the download was browser-dependent:** no APK had ever been published. nginx answered `/downloads/swachh-safar.apk` with the app's `index.html` (200, text/html). Chrome, because of the link's `download` attribute, saved that HTML as a ".apk"; other browsers (and the service worker, which served the app shell to every navigation) simply showed the app. Fixed: nginx serves `/downloads/` from `/var/www/html/swachhsafar2.0/downloads/` with `application/vnd.android.package-archive` + `Content-Disposition: attachment` and a real 404 when missing; the service worker no longer handles `/downloads/`; the public page `/download` uses a plain link and reads `latest.json`.

Steps (on a machine with JDK 17 + Android SDK, see above):
1. `npm run build && npx cap sync android`, then in `android/`: `./gradlew assembleRelease` with the release keystore configured (never committed; keep an offline backup — losing it means installed apps can never be updated).
2. Copy `android/app/build/outputs/apk/release/app-release.apk` to the server and run `sudo deploy/scripts/publish-apk.sh app-release.apk`. It verifies the signature (refuses debug keys/builds and a changed certificate), the package `in.itfarmer.swachhsafar`, that versionCode increased, then publishes `swachh-safar-<version>.apk`, `swachh-safar-latest.apk` and `latest.json` (size, SHA-256, certificate digest, date).
3. Install the nginx change once: `sudo cp deploy/nginx/swachhsafar-app.conf /etc/swachhsafar/nginx/app.conf && sudo nginx -t && sudo systemctl reload nginx`.
4. Check: `curl -sI https://ehk.itfarmer.in/downloads/swachh-safar-latest.apk` → 200, `application/vnd.android.package-archive`, `Content-Disposition: attachment`.
