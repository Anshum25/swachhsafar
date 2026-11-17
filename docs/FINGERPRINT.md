# Fingerprint verification of attendance

Fingerprint sits **beside** the face check, never instead of it. The scanner is a separate piece of
hardware that gets left behind, unplugged or broken, and the staff using this app clean trains — wet
hands, worn ridges, bandages. A phone with no scanner, or a finger that will not read, must still be able
to mark someone present. So either biometric satisfies a division that asks for both, and a phone without
a scanner looks exactly as it does today.

## What is built, and what is missing

Everything except the device driver:

| | Where |
|---|---|
| Registration (templates + consent, audited) | `backend/app/services/fingerprints.py`, `PUT /users/{id}/fingerprint` |
| Distribution to devices | `/sync/changes` → `fingerprint_profiles`, same rule as faces |
| Local storage | `fingerprint_profiles` table, local schema v11 |
| The decision | `src/fingerprint/fingerprintMatch.js` |
| Scanner contract | `src/fingerprint/scanner.js` |
| Attendance UI | `src/fingerprint/FingerprintCheck.jsx` |
| Enrolment UI | `src/pages/ops/masters/FingerprintEnrollment.jsx` |
| Server enforcement | `_check_identity` in `backend/app/services/attendance.py` |

**Missing: the Capacitor plugin `SwachhFingerprint`**, which wraps the scanner vendor's Android SDK.
Until it exists, `scanner()` returns null, the fingerprint control never appears, and nothing changes.

## Why an RD Service cannot be used

The Access AST300 is a UIDAI **L1 registered device**, and the ACPL L1 RD Service app
(`com.acpl.registersdk_l1`) is for Aadhaar authentication only. It returns a PID block encrypted with a
one-time AES key, which is itself encrypted with **UIDAI's public key** — only UIDAI can open it. There is
no template to store and no way to compare two captures, because each is encrypted afresh.

Using it would mean Aadhaar authentication: an AUA/KUA licence, every employee's Aadhaar number with
consent, and **a live connection at every capture**. Attendance here is routinely marked with no network,
so that fails exactly where the app is used.

What this needs instead is the vendor's **non-Aadhaar SDK**: capture → ISO/IEC 19794-2 minutiae template →
match against stored templates, offline. The AST300 conforms to ISO 19794-2 and is sold as
Windows/Android/Linux supported, so the hardware is capable; what must be confirmed with Access Computech
is that the Android SDK is available, runs over USB OTG, and that an L1 unit is permitted to run in SDK
mode rather than being locked to RD.

## The plugin contract

The plugin is named `SwachhFingerprint` and needs three methods. `src/fingerprint/scanner.js` is the only
file that talks to it, and `tests/unit/fingerprintMatch.test.js` exercises the contract with a fake.

```js
status()  // -> { connected: bool, device?: string, matcher?: string, reason?: string }
capture({ timeoutMs })
          // -> { template: base64, format: 'iso-19794-2', quality?: number }
          // rejects with { code: 'no_scanner'|'timeout'|'poor_quality'|'cancelled'|'permission' }
match({ template, candidates, format })
          // candidates: [{ finger, template }]
          // -> { score: number, finger?: string, matcher?: string }
```

Two rules the native side must keep:

- **Templates only.** No fingerprint image is returned, stored or logged, anywhere. An image is what
  would let someone forge a finger; a template is far less useful to a thief.
- **`matcher` identifies the scoring scale.** The score is the SDK's, not ours. It is stored with every
  result and compared against the division's `fingerprint_match_score`. Templates registered by a
  different matcher are reported as unusable rather than quietly compared — see `wrong_matcher`.

## Switching it on

Per division, in Masters → Division policy:

- `attendance_fingerprint_verification` — accept fingerprint as proof of identity
- `fingerprint_match_score` — the score at or above which the scanner's matcher is believed (default 30,
  settable 20–200)

The default is 30, not the 40 it started at. The score is a ratio of minutiae that line up, and a genuine
finger pressed at a different angle from the one it was registered at overlaps only partly, so clear
prints from the right person were scoring in the thirties and being refused. A refused scan now names the
score it got and the score it needed, so a division raises or lowers this against what its own scanners
actually produce rather than against a guess. Below 20 the server will not go: at some point the matcher
stops distinguishing people, and a biometric that accepts everyone is worse than no biometric at all.

Then register fingers per employee in Masters → Users → **Finger**. At least two, deliberately.

Registrations reach a phone by the same rule as faces: only for staff on a journey that phone's user
supervises, ending within the last 7 days, in a division with fingerprint verification on.

## Reading the scanner app's answer

The capture is done by ACPL's companion app, which hands back an `ACPL_L1_Data` parcel. Two things about
that are easy to get wrong, and both were:

- **A parcel carries the name of the class that wrote it**, and reading it resolves that name against this
  app's classes. R8 renamed `com.acpl.ACPL_L1_Data` to `x0.b` in release builds, so every scan failed to
  unparcel — and only in release builds, which is why it survived testing. `proguard-rules.pro` keeps the
  class, its fields and its `CREATOR`.
- **This app's copy of that class mirrors a field order it does not own.** A copy out by one field reads a
  stray number as `errorCode` and refuses a good scan, so a template found anywhere in the answer now wins
  over the error code, and the error code is believed only when there is no template. A template is
  recognised by the ISO 19794-2 magic `FMR` (`Rk1S` in base64), which is also what stops an image being
  mistaken for one.

A scan that fails now says what the scanner app actually returned — the extras' names and their types,
never a value.

## What the record keeps

`fingerprint_score`, `fingerprint_matcher` and `fingerprint_finger` on the attendance row, and only for a
capture that actually matched. A failed scan is a reason not to submit, never a field on a saved record.
Audit entries name which fingers were registered, never a template.
