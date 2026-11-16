import { describe, expect, it } from 'vitest';
import { decide } from '../../src/security/policy.js';

const policy = { gps_enforced: false, gps_block_app: false, vpn_policy: 'block' };
const location = { evaluate: () => ({ ok: true }), getState: () => ({}) };
const run = (network, platform = 'web') => decide('attendance', { policy, location, network, session: {}, platform });

describe('VPN policy', () => {
  it('server without VPN detection configured: warns, does not block', () => {
    const r = run({ vpn: null, check: 'not_configured' });
    expect(r.allowed).toBe(true);
    expect(r.warnings).toContain('vpn_check_not_configured');
  });
  it('status unknown in a browser (offline / check failed): allowed with a warning, so offline capture works', () => {
    const r = run({ vpn: null, check: 'unavailable' });
    expect(r.allowed).toBe(true);
    expect(r.warnings).toContain('vpn_unknown');
  });
  it('VPN detected: blocks', () => {
    expect(run({ vpn: true, check: 'server' }).blockers).toContain('vpn_detected');
  });
  it('confirmed no VPN: allowed', () => {
    expect(run({ vpn: false, check: 'server' })).toMatchObject({ allowed: true, blockers: [] });
  });
});
