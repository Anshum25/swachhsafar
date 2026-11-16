// Developer options gate decision (src/security/developerMode.js).
import { describe, expect, it } from 'vitest';
import { checkDeveloperMode } from '../../src/security/developerMode.js';

describe('developer mode check', () => {
  it('blocks only when the Android app reports developer options on', async () => {
    expect(await checkDeveloperMode({ getDeviceIntegrity: async () => ({ developerMode: true, usbDebugging: true }) }))
      .toEqual({ supported: true, developerMode: true, usbDebugging: true });
    expect((await checkDeveloperMode({ getDeviceIntegrity: async () => ({ developerMode: false }) })).developerMode).toBe(false);
  });
  it('never blocks where the setting cannot be read (browser, older APK, plugin error)', async () => {
    expect(await checkDeveloperMode(null)).toEqual({ supported: false, developerMode: false });
    expect(await checkDeveloperMode({})).toEqual({ supported: false, developerMode: false });
    expect((await checkDeveloperMode({ getDeviceIntegrity: async () => { throw new Error('not implemented'); } })).developerMode).toBe(false);
  });
});
