# Swachh Safar 2.0 — Android installation and physical-device test procedure

None of the results below come from a physical phone yet. The automated evidence comes from desktop Chromium
with Pixel 7 emulation. Fill in the sheet at the end on real devices.

## 1. One-time phone setup: trust the Swachh Safar certificate

The server uses a private certificate authority, so a phone must trust it once. Without it, Chrome shows a
warning, and the app cannot be installed or used offline. The CA is restricted to `76.13.243.27` only: it
cannot vouch for any other website.

1. In Chrome, open `https://76.13.243.27:8082/swachhsafar-ca.crt`. Accept the warning this one time
   (*Advanced → Proceed*). The file `swachhsafar-ca.crt` downloads.
2. Check its fingerprint against the one from IT. SHA-256:
   `03:AD:43:6E:7B:F9:23:7F:C4:54:35:46:8D:55:06:FD:23:DB:DB:16:D6:72:28:1D:68:DC:79:0A:58:71:C1:48`
3. Install it. Android needs a screen lock for this step:
   - **Pixel / stock Android:** Settings → Security & privacy → More security settings → Encryption & credentials →
     Install a certificate → **CA certificate** → Install anyway → choose `swachhsafar-ca.crt`.
   - **Samsung:** Settings → Security and privacy → More security settings → Install from device storage →
     **CA certificate** → Install anyway → choose the file.
4. Close Chrome completely, reopen `https://76.13.243.27:8082`, and check that the address bar shows no warning.

## 2. Install the app

1. Open `https://76.13.243.27:8082` in Chrome. Wait until the database status shows *Local database: Ready · persistent*.
2. Tap **Install** on the banner, or use Chrome ⋮ → *Install app*. Samsung Internet: ≡ → *Add page to* → *Home screen*.
3. Launch it from the home-screen icon. It should open full-screen, without the address bar.

## 3. Test sheet (fill per device)

Device: ______  Android: ______  Browser + version (chrome://version): ______  Tester/date: ______

| # | Test | Expected | Result | Notes / screenshot |
|---|---|---|---|---|
| 1 | Open the HTTPS URL in Chrome | Loads with no certificate warning | | |
| 2 | Install the PWA | Icon on the home screen, named "Swachh Safar" | | |
| 3 | Launch the installed app | Standalone, no browser UI | | |
| 4 | Sign in online | Dashboard *Welcome, <name>* | | |
| 5 | Initial download | Dashboard → Offline readiness: all green | | |
| 6 | Airplane mode, then use the app | *Offline* indicator; screens work | | |
| 7 | Mark attendance offline (camera + GPS) | "Saved on this device", *pending sync* | | |
| 8 | Coach inspection photo/video offline | Saved locally; preview shows | | |
| 9 | Voice comment (microphone) | Records and plays back | | |
| 10 | Move between modules offline | All screens open | | |
| 11 | Force-close and reopen offline | Records still listed as pending | | |
| 12 | Restart the phone, open offline | Records still listed | | |
| 13 | Turn the internet back on | Sync starts; "All records synced" | | |
| 14 | Server check | Each record appears once in reports | | |
| 15 | Interrupt sync (airplane mode mid-sync) | Remaining records retry later; no duplicates | | |
| 16 | App update (after a new deploy) | Banner → Update now → data still there | | |
| 17 | Back button | Goes back through screens, then leaves the app | | |
| 18 | Background 10 min, resume | Same screen; syncs if online | | |
| 19 | Switch Wi-Fi ↔ mobile data while syncing | Sync completes or retries | | |
| 20 | Rotate the screen on a capture form | Form keeps its input | | |
| 21 | Same tests in Samsung Internet | — | | |

Record any red text or error messages exactly as shown. For DevTools access, connect USB and use `chrome://inspect`
on a PC.

## 4. Known limitations and compatibility notes

- **Origin is tied to the IP and port.** A new IP, port or domain means a new, empty app on each phone. Sync all
  devices first.
- **One open copy per phone.** The OPFS SQLite VFS allows a single connection, so a second tab shows *Local database:
  Unavailable*.
- **Browser support** follows SQLite WASM's `opfs-sahpool` requirements (sync access handles in workers). Android
  WebViews inside other apps cannot install the PWA, and the app tells the user to open Chrome.
- **Offline sign-in** means resuming an existing session only. A user must have signed in online on that phone
  before. After **Sign out**, nobody can sign in until the phone is online again.
- **Media upload is blocked** until Firebase Storage is enabled for the `swachh-safar` project. Photos, video and
  voice stay safely queued on the phone until then.
- **Biometrics:** WebAuthn (fingerprint/face through Android's platform authenticator) **cannot work on an IP-address
  origin**, because a WebAuthn relying-party ID must be a domain name. It needs a domain. External USB fingerprint
  scanners and Android `BiometricPrompt` need a native wrapper, such as a Trusted Web Activity with a native
  module or Capacitor, which is separate work.
