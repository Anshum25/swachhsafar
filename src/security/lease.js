// Offline authorization lease validation on the client.
// An offline lease is cryptographically signed by the backend and issued on /auth/me or /auth/lease.
// It is strictly bound to the authenticated employee, device, and authentication session.
// Maximum validity is 24 hours.

const LEASE_STORAGE_KEY = 'swachh.offline_lease';
const MONOTONIC_CLOCK_KEY = 'swachh.last_clock_ts';
export const MAX_LEASE_HOURS = 24;

const getStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);
let memoryClockTs = 0;

export function getCachedLease() {
  try {
    const storage = getStorage();
    const raw = storage?.getItem(LEASE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveCachedLease(lease) {
  try {
    const storage = getStorage();
    if (lease) {
      storage?.setItem(LEASE_STORAGE_KEY, JSON.stringify(lease));
    } else {
      storage?.removeItem(LEASE_STORAGE_KEY);
    }
  } catch {
    // Local storage unavailable
  }
}

export function checkClockRollback(now = Date.now()) {
  try {
    const storage = getStorage();
    const rawVal = storage ? storage.getItem(MONOTONIC_CLOCK_KEY) : null;
    const last = parseInt(rawVal || String(memoryClockTs || 0), 10);
    // Allow up to 60 seconds drift for NTP adjustments
    if (last > 0 && now < last - 60_000) {
      return { rollback: true, last, now };
    }
    if (now > last) {
      memoryClockTs = now;
      storage?.setItem(MONOTONIC_CLOCK_KEY, String(now));
    }
  } catch {
    // Storage unavailable
  }
  return { rollback: false };
}

/**
 * Validates an offline lease against current device, user, and time constraints.
 * Returns { valid: boolean, code: string, remainingHours: number, lease: object | null }
 */
export function validateOfflineLease({ lease, deviceId, userId, empId, now = Date.now() }) {
  if (!lease || !lease.signature || !lease.expires_at) {
    return { valid: false, code: 'no_lease', remainingHours: 0, lease: null };
  }

  // Clock rollback detection
  const clockCheck = checkClockRollback(now);
  if (clockCheck.rollback) {
    return { valid: false, code: 'clock_rollback_detected', remainingHours: 0, lease };
  }

  // Device binding check
  if (deviceId && lease.device_id && lease.device_id !== 'unspecified' && lease.device_id !== deviceId) {
    return { valid: false, code: 'device_mismatch', remainingHours: 0, lease };
  }

  // Employee / User binding check
  if (userId && lease.user_id && lease.user_id !== String(userId)) {
    return { valid: false, code: 'user_mismatch', remainingHours: 0, lease };
  }
  if (empId && lease.emp_id && lease.emp_id.toLowerCase() !== String(empId).toLowerCase()) {
    return { valid: false, code: 'user_mismatch', remainingHours: 0, lease };
  }

  const issuedAt = Date.parse(lease.issued_at);
  const expiresAt = Date.parse(lease.expires_at);

  if (isNaN(issuedAt) || isNaN(expiresAt)) {
    return { valid: false, code: 'invalid_lease_format', remainingHours: 0, lease };
  }

  // Strict maximum 24 hours constraint: cannot exceed issued_at + 24 hours
  const hardCapExpiry = issuedAt + MAX_LEASE_HOURS * 3_600_000;
  const effectiveExpiry = Math.min(expiresAt, hardCapExpiry);

  if (now > effectiveExpiry) {
    return { valid: false, code: 'lease_expired', remainingHours: 0, lease };
  }

  const remainingHours = Math.max(0, (effectiveExpiry - now) / 3_600_000);
  return { valid: true, code: 'valid', remainingHours, lease };
}
