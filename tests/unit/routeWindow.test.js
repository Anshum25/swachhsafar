// The phone's offline route-window check gives the server's answers (backend tests/test_route_window.py
// reads the same cases), and the capture rules use it the way backend attendance.check_route does.
import { describe, expect, it } from 'vitest';
import cases from '../fixtures/route_window_cases.json';
import { checkRouteWindow, isOutside, outsideMessage, routeCheckPolicy, stageRouteCheck } from '../../src/utils/routeWindow.js';

describe('route window check', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const window = c.window ? cases[c.window] : null;
      expect(checkRouteWindow(window, c.latitude, c.longitude, c.accuracy_m, cases.tolerance_km)).toEqual(c.expected);
    });
  }

  it('reads the division policy with the server defaults', () => {
    expect(routeCheckPolicy({})).toEqual({ mode: 'block', toleranceKm: 3 });
    expect(routeCheckPolicy({ attendance_route_check: 'flag', attendance_route_tolerance_km: 5 })).toEqual({ mode: 'flag', toleranceKm: 5 });
  });

  it('checks only station stages, and not when the division turned it off', () => {
    const stage = { station_code: 'ADI', station_name: 'Ahmedabad Jn', valid_until_name: 'Nadiad Jn', window: cases.window };
    const fix = { latitude: 22.310756, longitude: 73.181065, gps_accuracy_m: 10 };   // Vadodara
    const r = stageRouteCheck(stage, fix, { attendance_route_check: 'block' });
    expect(r.mode).toBe('block');
    expect(isOutside(r)).toBe(true);
    expect(outsideMessage(stage, r)).toMatch(/open until Nadiad Jn/);
    expect(stageRouteCheck(stage, fix, { attendance_route_check: 'off' })).toBeNull();
    expect(stageRouteCheck({ stage: 1, kind: 'source' }, fix, {})).toBeNull();
  });
});
