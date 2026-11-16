# Administrator Face Enrollment & Biometric Verification

## 1. Biometric Template Principles
Swachh Safar employs on-device biometric template generation and verification using `@vladmandic/face-api` (ResNet-128 architecture):
1. **Raw Images Never Stored or Transmitted:** Neither raw photos nor video frames are uploaded to the server during enrollment or verification. Only 128-dimensional floating-point vector descriptors are calculated and synchronized.
2. **Administrator-Controlled Enrollment:** Face enrollment is exclusively performed by authorized division supervisors/administrators (`canIn('users.manage', divisionId)`).
3. **Multi-Sample Quality Verification:** Four distinct sample photos from different angles (front, slight turn left, slight turn right, slight tilt) are taken to create a composite template, verifying that intra-sample distance is `<= 0.6`.
4. **Consent Recording:** Explicit consent confirmation is mandated before enrollment can be finalized.

---

## 2. Enrollment Workflow (Admin Panel)

1. Navigate to **Masters → Users → Employee Profile**.
2. Select **Enroll Face Biometrics**.
3. Verify and check explicit employee consent.
4. Capture 4 reference frames using the device camera.
5. The client-side face engine (`src/face/faceEngine.js`):
   - Confirms exactly one face is present (`count === 1`).
   - Extracts 128-dimensional descriptor vectors.
   - Computes pairwise Euclidean distances via `enrolmentSpread()`.
6. Enrolled descriptors are submitted via `POST /faces/{user_id}/enroll` and stored in the backend `face_enrollments` table.
7. Registered descriptors synchronize down to operational shared devices via `/sync/changes` into SQLite `face_profiles`.

---

## 3. On-Device Attendance Verification Workflow

When marking attendance across the 5 operational stages:
1. **Liveness Challenge (`LiveFaceCapture`):**
   - Active front camera feed prompts the employee with random behavioral challenges: Eye blink (EAR < 0.68) and Head turn (Yaw > 0.22, then return < 0.09).
   - Defeats static photos, paper cutouts, and simple screen replay attacks.
   - Confirms that the same person is present at start and completion (descriptor distance `<= 0.5`).
2. **Template Matching (`FaceCheck`):**
   - Calculates minimum Euclidean distance between captured face descriptor and all enrolled descriptors for that employee ID.
   - If `distance <= threshold` (default `0.5`, similarity `~80%+`), attendance is verified (`matched`).
   - If `distance > threshold`, attendance is blocked with `face_mismatch`.
   - If employee has no enrolled template, blocked with `face_not_enrolled`.
3. **Supervisor Fallback:**
   - In cases of biometric injury or lighting impossibility, an authorized supervisor may mark manual attendance review with documented reason.

