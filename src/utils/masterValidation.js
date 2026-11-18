// Client-side checks for master-data forms, mirroring the backend Pydantic schemas so mistakes are shown
// before submitting. The server validates again and remains the authority.
// Each validator returns { field: message } for invalid fields; an empty object means valid.

const len = (v) => String(v ?? '').trim().length;
const between = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
const isInt = (n) => Number.isInteger(n);

// schemas/feedback.py QuestionBankCreate + QuestionIn
export function validateBank(f) {
  const e = {};
  if (len(f.name) < 3 || len(f.name) > 100) e.name = 'Name must be 3–100 characters.';
  if (f.audience !== 'passenger' && f.audience !== 'railway') e.audience = 'Choose passenger or railway.';
  if (!isInt(f.scale_min) || !between(f.scale_min, 0, 10)) e.scale_min = 'Lowest rating must be a whole number 0–10.';
  if (!isInt(f.scale_max) || !between(f.scale_max, 1, 10)) e.scale_max = 'Highest rating must be a whole number 1–10.';
  if (!e.scale_min && !e.scale_max && f.scale_min >= f.scale_max) e.scale_max = 'Highest rating must be greater than the lowest.';
  const qs = f.questions ?? [];
  if (qs.length < 1 || qs.length > 20) e.questions = 'A bank needs 1–20 questions.';
  qs.forEach((q, i) => {
    const n = i + 1;
    if (len(q.text_en) < 3 || len(q.text_en) > 500) e[`q${i}.text_en`] = `Question ${n}: English text must be 3–500 characters.`;
    if (len(q.text_hi) > 500) e[`q${i}.text_hi`] = `Question ${n}: Hindi text must be at most 500 characters.`;
    if (!q.applies_ac && !q.applies_non_ac) e[`q${i}.applies`] = `Question ${n}: must apply to AC, Non-AC or both.`;
    if (q.psi_weight !== '' && q.psi_weight != null && !(Number(q.psi_weight) > 0 && Number(q.psi_weight) <= 100)) {
      e[`q${i}.psi_weight`] = `Question ${n}: PSI weight must be more than 0 and at most 100.`;
    }
  });
  return e;
}

// Request body for POST /feedback/question-banks.
export function bankPayload(f, divisionId) {
  return {
    division_id: divisionId ?? null, audience: f.audience, name: f.name.trim(), scale_min: f.scale_min, scale_max: f.scale_max,
    questions: f.questions.map((q) => ({
      text_en: q.text_en.trim(), text_hi: q.text_hi?.trim() || null, applies_ac: !!q.applies_ac, applies_non_ac: !!q.applies_non_ac,
      required: !!q.required, psi_weight: q.psi_weight === '' || q.psi_weight == null ? null : Number(q.psi_weight),
    })),
  };
}

// schemas/complaints.py DepartmentIn / DepartmentUpdate
export function validateDepartment(f) {
  return len(f.name) < 2 || len(f.name) > 100 ? { name: 'Name must be 2–100 characters.' } : {};
}

// schemas/complaints.py CategoryIn / CategoryUpdate
export function validateCategory(f) {
  const e = {};
  if (len(f.name) < 2 || len(f.name) > 100) e.name = 'Name must be 2–100 characters.';
  if (f.sla_hours !== '' && f.sla_hours != null && !(isInt(Number(f.sla_hours)) && between(Number(f.sla_hours), 1, 24 * 60))) {
    e.sla_hours = 'SLA must be a whole number of hours, 1–1440.';
  }
  if (!isInt(Number(f.sort_order))) e.sort_order = 'Display order must be a whole number.';
  return e;
}

// models/inventory.py Unit; schemas/inventory.py ItemIn / ItemUpdate
export const UNITS = [
  { value: 'nos', label: 'Numbers (nos)' }, { value: 'ltr', label: 'Litres (ltr)' },
  { value: 'ml', label: 'Millilitres (ml)' }, { value: 'kg', label: 'Kilograms (kg)' },
];

export function validateItem(f, { creating }) {
  const e = {};
  if (len(f.name) < 2 || len(f.name) > 100) e.name = 'Name must be 2–100 characters.';
  if (creating && !UNITS.some((u) => u.value === f.unit)) e.unit = 'Choose a unit.';
  if (!between(Number(f.ideal_qty), 0, 1_000_000) || f.ideal_qty === '') e.ideal_qty = 'Ideal quantity must be 0–1,000,000.';
  return e;
}

// schemas/policy.py PolicySettings: every setting, with its type and allowed range.
export const POLICY_FIELDS = [
  { key: 'passenger_pnr_required', type: 'bool', label: 'Passenger PNR required', group: 'Passenger feedback' },
  { key: 'passenger_otp_required', type: 'bool', label: 'Passenger OTP verification required', group: 'Passenger feedback' },
  { key: 'pnr_train_day_mapping', type: 'bool', label: 'PNR train must match journey half (main train first half, linked train second half)', group: 'Passenger feedback' },
  { key: 'pnr_coach_match_required', type: 'bool', label: 'PNR coach must match the feedback coach', group: 'Passenger feedback' },
  { key: 'passenger_feedback_per_coach_day', type: 'int', min: 1, max: 100, nullable: true, label: 'Passenger feedback limit per coach per day', hint: 'Leave empty for no limit', group: 'Passenger feedback' },
  { key: 'railway_feedback_limit_per_journey', type: 'int', min: 0, max: 50, label: 'Railway feedback limit per journey', group: 'Railway feedback' },
  { key: 'attendance_photo_required', type: 'bool', label: 'Attendance photo required', group: 'Attendance and inspection' },
  { key: 'attendance_late_grace_days', type: 'int', min: 0, max: 7, label: 'Late attendance grace (days after journey end)', group: 'Attendance and inspection' },
  { key: 'inspection_photo_required', type: 'bool', label: 'Inspection photo required', group: 'Attendance and inspection' },
  { key: 'complaint_default_sla_hours', type: 'int', min: 1, max: 1440, label: 'Default complaint SLA (hours)', group: 'Complaints' },
  { key: 'attendance_face_verification', type: 'bool', label: 'Face verification for attendance (blocks attendance when the face does not match)', group: 'Face verification' },
  { key: 'face_match_threshold', type: 'float', min: 0.3, max: 0.7, label: 'Face match strictness (lower is stricter)', hint: '0.3–0.7 · recommended 0.5', group: 'Face verification' },
  { key: 'attendance_fingerprint_verification', type: 'bool', label: 'Accept a fingerprint as proof of identity (an alternative to the face check, never a replacement)', group: 'Fingerprint verification' },
  { key: 'fingerprint_match_score', type: 'int', min: 30, max: 100, label: 'Fingerprint match score (lower accepts weaker matches)', hint: '30–100 · recommended 40. This is the percentage of the print that must match; below 40 other people start to pass.', group: 'Fingerprint verification' },
  { key: 'face_liveness_required', type: 'bool', label: 'Ask for a head turn as well as the blink', hint: 'A blink is always required before the face is matched, so a photo cannot be used. The head turn adds a few seconds and also defeats a recorded video.', group: 'Face verification' },
  // Location. These decide when a record may be made at all, so they are the division's to set rather
  // than something only a deploy can change: 100 m is right in the open and impossible indoors.
  { key: 'gps_enforced', type: 'bool', label: 'Require a verified location for attendance, inspections and feedback', group: 'Location' },
  { key: 'gps_max_accuracy_m', type: 'int', min: 5, max: 5000, label: 'Worst location accuracy accepted (metres)', hint: '5–5000 · 100 outdoors; raise it for indoor or depot use', group: 'Location' },
  { key: 'gps_max_age_seconds', type: 'int', min: 10, max: 3600, label: 'Oldest location fix accepted (seconds)', hint: '10–3600 · 120 by default', group: 'Location' },
  { key: 'gps_timeout_seconds', type: 'int', min: 5, max: 120, label: 'How long to wait for a fix (seconds)', hint: '5–120 · 20 by default', group: 'Location' },
  { key: 'gps_max_speed_kmh', type: 'int', min: 50, max: 1000, label: 'Speed above which consecutive fixes are flagged (km/h)', hint: '50–1000 · trains run below 160', group: 'Location' },
  { key: 'gps_block_app', type: 'bool', label: 'Keep the whole app shut until there is a usable fix (off: only the records that need location wait)', group: 'Location' },
  { key: 'vpn_policy', type: 'enum', options: [{ value: 'off', label: 'Ignore' }, { value: 'warn', label: 'Record it' }, { value: 'block', label: 'Refuse the record' }], label: 'When a VPN or proxy is detected', group: 'Device security' },
  { key: 'offline_session_hours', type: 'int', min: 1, max: 24, label: 'How long a device may work offline after its last online check (hours)', hint: '1–24', group: 'Device security' },
];

export function validatePolicy(f) {
  const e = {};
  for (const field of POLICY_FIELDS) {
    const v = f[field.key];
    if (field.type === 'bool') {
      if (typeof v !== 'boolean') e[field.key] = `${field.label}: choose yes or no.`;
    } else if (field.type === 'enum') {
      if (!field.options.some((o) => o.value === v)) e[field.key] = `${field.label}: choose one of the listed options.`;
    } else if (v === null || v === '' || v === undefined) {
      if (!field.nullable) e[field.key] = `${field.label} is required.`;
    } else if (field.type === 'float') {
      if (!between(Number(v), field.min, field.max)) e[field.key] = `${field.label} must be a number ${field.min}–${field.max}.`;
    } else if (!isInt(Number(v)) || !between(Number(v), field.min, field.max)) {
      e[field.key] = `${field.label} must be a whole number ${field.min}–${field.max}.`;
    }
  }
  return e;
}

// Request body for PUT /divisions/{id}/policy: exactly the PolicySettings fields (the schema forbids extras).
export function policyPayload(f) {
  return Object.fromEntries(POLICY_FIELDS.map((field) => {
    const v = f[field.key];
    if (field.type === 'bool') return [field.key, !!v];
    if (field.type === 'enum') return [field.key, v];
    return [field.key, v === '' || v == null ? null : Number(v)];
  }));
}
