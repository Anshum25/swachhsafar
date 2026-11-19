// What the connection indicator says (src/app/Layout.jsx connectionStatus).
//
// This got it wrong in a way that cost real debugging time: a record the server had answered and refused
// was reported as "Server unreachable", so the obvious reading was a network or deployment fault, while
// the actual reason sat in a `title` tooltip that a touchscreen never shows. The rule being pinned down
// here is that the server not answering and the server refusing are different things, and a refusal
// carries its reason in text the sync panel displays.
import { describe, expect, it } from 'vitest';
import { connectionStatus } from '../../src/app/Layout.jsx';

const quiet = { pending: 0, failed: [], running: false, pulling: false, lastError: null, pullError: null, lastPullAt: null };
const q = (over) => ({ ...quiet, ...over });

describe('connection status', () => {
  it('reports no network before anything about the server', () => {
    // Offline is the one the user can act on, so it wins even with records refused earlier.
    const [tone, text] = connectionStatus(q({ failed: [{ last_error: 'nope' }], pullError: 'boom' }), false);
    expect([tone, text]).toEqual(['amber', 'Offline']);
  });

  it('shows an exchange in progress', () => {
    expect(connectionStatus(q({ running: true }), true)[1]).toBe('Syncing…');
    expect(connectionStatus(q({ pulling: true }), true)[1]).toBe('Syncing…');
  });

  it('calls a refusal a refusal, and puts the reason in the text', () => {
    const [tone, text, detail] = connectionStatus(
      q({ failed: [{ last_error: 'Group photo attendance is not enabled for this division' }], pending: 2 }), true);
    expect([tone, text]).toEqual(['red', 'Records refused']);
    expect(detail).toBe('The server refused 1 record: Group photo attendance is not enabled for this division');
  });

  it('counts refused records and stays readable without a reason', () => {
    expect(connectionStatus(q({ failed: [{}, {}, {}] }), true)[2]).toBe('The server refused 3 records.');
  });

  it('keeps "unreachable" for the case that really is unreachable', () => {
    expect(connectionStatus(q({ pullError: 'Failed to fetch' }), true))
      .toEqual(['red', 'Server unreachable', 'Failed to fetch']);
    // A push error only counts while something is still waiting to go.
    expect(connectionStatus(q({ lastError: 'timeout', pending: 1 }), true)[1]).toBe('Server unreachable');
    expect(connectionStatus(q({ lastError: 'timeout', pending: 0 }), true)[1]).toBe('Online');
  });

  it('is online once an exchange has worked', () => {
    expect(connectionStatus(q({ lastPullAt: 1 }), true)).toEqual(['emerald', 'Online', 'Connected to the server']);
    expect(connectionStatus(q({}), true)[2]).toBe('Network available');
  });

  it('survives a queue state that is missing fields', () => {
    expect(() => connectionStatus({}, true)).not.toThrow();
    expect(connectionStatus({}, true)[1]).toBe('Online');
  });
});

describe('no usable sign-in', () => {
  it('says to sign in again, before anything about the server', () => {
    // This is the state that produced "Server unreachable" for a reachable server: no token, so the
    // queue could neither push nor pull, and the stale error from the last pull that did run stayed on
    // screen for ever. Tapping Sync could not fix it; signing in again is the only thing that can.
    const [tone, text, detail] = connectionStatus(
      { ...quiet, authRequired: true, pending: 10, pullError: 'Cannot reach the Swachh Safar server.' }, true);
    expect([tone, text]).toEqual(['red', 'Sign in again']);
    expect(detail).toMatch(/signed in/i);
  });

  it('still reports an exchange in progress and offline ahead of it', () => {
    expect(connectionStatus({ ...quiet, authRequired: true, running: true }, true)[1]).toBe('Syncing\u2026');
    expect(connectionStatus({ ...quiet, authRequired: true }, false)[1]).toBe('Offline');
  });

  it('goes back to the ordinary states once a token is available again', () => {
    expect(connectionStatus({ ...quiet, authRequired: false, pullError: 'boom' }, true)[1]).toBe('Server unreachable');
    expect(connectionStatus({ ...quiet, authRequired: false, lastPullAt: 1 }, true)[1]).toBe('Online');
  });
});
