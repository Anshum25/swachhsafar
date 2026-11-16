// The security policy engine: the single place that decides whether an action may run now. Screens ask
// `decide(action, ctx)`; they never test GPS/VPN/session conditions themselves.
//
// Actions: 'app' (opening the app), 'location' (inspection, feedback: location-dependent), 'attendance'.
// Result: { allowed, blockers: [code], warnings: [code] }. The server re-checks what it can (docs/SECURITY.md).

export const LOCATION_ACTIONS = new Set(['location', 'attendance']);

export function decide(action, { policy, location, network, session, platform = 'web' }) {
  const blockers = [];
  const warnings = [];
  if (session?.offlineExpired) blockers.push('offline_session_expired');
  const needsLocation = LOCATION_ACTIONS.has(action) || (action === 'app' && policy.gps_block_app);
  if (needsLocation && policy.gps_enforced) {
    const loc = location.evaluate();
    if (!loc.ok) blockers.push(loc.code);
    if (location.getState().suspicious) warnings.push('location_suspicious_jump');
  }
  if (LOCATION_ACTIONS.has(action) && policy.vpn_policy !== 'off') {
    if (network.vpn === true) {
      (policy.vpn_policy === 'block' ? blockers : warnings).push('vpn_detected');
    } else if (network.vpn == null && network.check === 'not_configured') {
      // Online, but the server has no VPN detection configured: nothing to enforce against. Warn only.
      warnings.push('vpn_check_not_configured');
    } else if (network.vpn == null || network.check === 'unavailable') {
      // Status unknown (a browser offline, or the check could not run): offline-first capture must keep
      // working, so this is recorded with the capture (vpn: null, vpn_check) and flagged, not blocked.
      // Only a VPN that is actually detected blocks.
      warnings.push('vpn_unknown');
    }
  }
  return { allowed: blockers.length === 0, blockers, warnings };
}

// Capture evidence sent with attendance and inspection records (CaptureSecurity on the server).
export function evidence({ location, network, platform, appVersion, liveness = 'not_required', faceModel = null, decision }) {
  const fix = location.getState().fix;
  return {
    gps_timestamp: fix ? new Date(fix.timestamp).toISOString() : undefined,
    security: {
      app_version: appVersion, platform, location_source: fix?.source ?? 'unknown', mock_location: fix?.mocked ?? null,
      vpn: network.vpn, vpn_check: network.check, liveness, face_model_version: faceModel,
      policy_result: decision?.warnings?.length ? 'warned' : 'allowed', warnings: (decision?.warnings ?? []).slice(0, 10),
    },
  };
}
