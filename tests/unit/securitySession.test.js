import { describe, expect, it, vi } from 'vitest';
import { getDevice, getDeviceId } from '../../src/security/device.js';
import { checkClockRollback, validateOfflineLease } from '../../src/security/lease.js';
import { decide } from '../../src/security/policy.js';

describe('Canonical Device Identity', () => {
  it('generates a persistent canonical device id', async () => {
    const dev1 = await getDevice();
    const dev2 = await getDevice();
    const id = await getDeviceId();

    expect(dev1.id).toBeDefined();
    expect(dev1.id).toMatch(/^(web|and)-[a-f0-9]{32}$/);
    expect(dev1.id).toBe(dev2.id);
    expect(id).toBe(dev1.id);
  });
});

describe('Signed Offline Authorization Lease Validation', () => {
  const baseLease = {
    lease_id: 'test-lease-uuid-001',
    emp_id: 'EMP-1001',
    user_id: 'user-uuid-1001',
    device_id: 'web-12345678901234567890123456789012',
    session_id: 'session-uuid-1001',
    issued_at: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    expires_at: new Date(Date.now() + 23 * 3600_000).toISOString(), // 23 hours from now
    authorization_version: 1,
    policy_version: 1,
    permitted_operations: ['attendance.record', 'inspection.record'],
    signature: 'a'.repeat(64),
  };

  it('validates a valid lease bound to employee and device', () => {
    const res = validateOfflineLease({
      lease: baseLease,
      deviceId: 'web-12345678901234567890123456789012',
      userId: 'user-uuid-1001',
      empId: 'EMP-1001',
      now: Date.now(),
    });

    expect(res.valid).toBe(true);
    expect(res.code).toBe('valid');
    expect(res.remainingHours).toBeGreaterThan(20);
    expect(res.remainingHours).toBeLessThanOrEqual(24);
  });

  it('rejects a lease with mismatched device id', () => {
    const res = validateOfflineLease({
      lease: baseLease,
      deviceId: 'web-different-device-id',
      userId: 'user-uuid-1001',
      empId: 'EMP-1001',
      now: Date.now(),
    });

    expect(res.valid).toBe(false);
    expect(res.code).toBe('device_mismatch');
  });

  it('rejects a lease with mismatched employee id', () => {
    const res = validateOfflineLease({
      lease: baseLease,
      deviceId: 'web-12345678901234567890123456789012',
      userId: 'user-uuid-1001',
      empId: 'EMP-9999',
      now: Date.now(),
    });

    expect(res.valid).toBe(false);
    expect(res.code).toBe('user_mismatch');
  });

  it('enforces maximum 24 hours even if server attempted longer expiry', () => {
    // Attempt 72 hours
    const longLease = {
      ...baseLease,
      issued_at: new Date(Date.now() - 25 * 3600_000).toISOString(), // 25 hours ago
      expires_at: new Date(Date.now() + 47 * 3600_000).toISOString(), // expires in 47 hours (72h total)
    };

    const res = validateOfflineLease({
      lease: longLease,
      deviceId: longLease.device_id,
      userId: longLease.user_id,
      empId: longLease.emp_id,
      now: Date.now(),
    });

    expect(res.valid).toBe(false);
    expect(res.code).toBe('lease_expired');
  });

  it('detects clock rollback', () => {
    // Record current time
    checkClockRollback(Date.now() + 600_000);

    const pastTime = Date.now() - 300_000;
    const check = checkClockRollback(pastTime);
    expect(check.rollback).toBe(true);

    const res = validateOfflineLease({
      lease: baseLease,
      deviceId: baseLease.device_id,
      userId: baseLease.user_id,
      empId: baseLease.emp_id,
      now: pastTime,
    });

    expect(res.valid).toBe(false);
    expect(res.code).toBe('clock_rollback_detected');
  });
});

describe('Policy Decision Engine', () => {
  const policy = {
    gps_enforced: true,
    gps_block_app: true,
    gps_max_accuracy_m: 100,
    gps_max_age_seconds: 120,
    vpn_policy: 'block',
    offline_session_hours: 24,
  };

  it('blocks capture when offline session is expired', () => {
    const mockLocation = {
      evaluate: () => ({ ok: true, code: 'ok', fix: { latitude: 19.0, longitude: 72.8, accuracy: 20, timestamp: Date.now() } }),
      getState: () => ({ suspicious: null }),
    };
    const network = { vpn: false, check: 'server' };

    const decision = decide('attendance', {
      policy,
      location: mockLocation,
      network,
      session: { offlineExpired: true },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain('offline_session_expired');
  });

  it('allows offline PWA capture with a vpn_unknown warning (offline-first; recorded with the capture)', () => {
    const mockLocation = {
      evaluate: () => ({ ok: true, code: 'ok', fix: { latitude: 19.0, longitude: 72.8, accuracy: 20, timestamp: Date.now() } }),
      getState: () => ({ suspicious: null }),
    };
    // Offline PWA: network check unavailable
    const network = { vpn: null, check: 'unavailable' };

    const decision = decide('attendance', {
      policy,
      location: mockLocation,
      network,
      session: { offlineExpired: false },
      platform: 'web',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.warnings).toContain('vpn_unknown');
  });

  it('allows attendance on Android when native VPN check confirms no VPN', () => {
    const mockLocation = {
      evaluate: () => ({ ok: true, code: 'ok', fix: { latitude: 19.0, longitude: 72.8, accuracy: 20, timestamp: Date.now() } }),
      getState: () => ({ suspicious: null }),
    };
    const network = { vpn: false, check: 'native' };

    const decision = decide('attendance', {
      policy,
      location: mockLocation,
      network,
      session: { offlineExpired: false },
      platform: 'android',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.blockers).toHaveLength(0);
  });
});
