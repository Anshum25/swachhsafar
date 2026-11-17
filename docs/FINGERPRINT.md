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
- `fingerprint_match_score` — the score at or above which the matcher is believed (default 40, settable
  30–100)

The score is the percentage of the smaller print whose minutiae line up, and it is never produced from
fewer than twelve matched points. It was briefly lowered to 30 to admit prints that were being refused;
a colleague's finger was then accepted for someone else's attendance. Lowering the threshold was the
wrong answer to that, and two real faults were behind it — see below. A refused scan names the score it
got and the score it needed, so a division sets this against what its own scanners produce rather than
against a guess.

## Why a finger is pressed several times

Registration records `SAMPLES_PER_FINGER` presses of each finger, not one. A single press captures only
the part of the fingertip that happened to touch the sensor, at the angle it happened to be held;
verifying later against that one impression fails whenever the finger lands differently, which is most
of the time. Phones ask for the same finger over and over for exactly this reason. Matching tries every
stored impression and keeps the best, so a genuine finger reaches the threshold honestly instead of the
threshold being bent down to meet a single impression.

## What the matcher will and will not do

Comparing fingerprints means counting minutiae that line up once one print is rotated onto the other.
Two different fingers always line up somewhat, so the rules that keep one person out of another's
attendance are the tolerances and the floor, not the threshold alone:

- A point counts only within 12 pixels and 15° of where the alignment puts it.
- Fewer than 12 matched points scores zero, whatever proportion it works out to. That floor is the
  long-standing forensic one for calling two prints the same finger.
- Bytes that are not an ISO/IEC 19794-2 record are refused, not guessed at. Minutiae invented from
  arbitrary bytes line up with other invented minutiae about as readily as a finger does with itself.

Two faults were found here after a colleague's finger was accepted:

1. **The alignment turned the probe the wrong way.** `dTheta` is how much further round the probe was
   pressed, so the probe has to be turned back by it; the code rotated forward instead. The points
   scattered, and what was being counted was coincidence rather than agreement. Scores from before this
   was fixed meant nothing — in either direction.
2. **The score was inflated and had no floor**: `matched / average_count × 150`, with a 20-pixel, 25°
   tolerance. Six coincidental points out of thirty scored 30.

`android/app/src/test/.../IsoTemplateMatcherTest.kt` holds the line: a genuine second press scores at or
above the threshold, and forty different-finger pairs all stay below it.

## When a phone says "no fingerprints for this person"

It almost never means nobody registered them. Templates reach a phone only when all of these hold, and
the message on the phone names them in this order:

1. the division's policy has `attendance_fingerprint_verification` on,
2. the fingers are registered (Masters → Users → Finger),
3. that phone has synced since, while online —

and then only for staff on journeys that phone's user supervises, ending within the last 7 days.

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
