// Install guidance for browsers that do not fire beforeinstallprompt (src/pwa/pwaState.js).
import { describe, expect, it } from 'vitest';
import { installDismissed, installInstructions } from '../../src/pwa/pwaState.js';

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
  webview: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('installInstructions', () => {
  it('names the right menu for each Android browser', () => {
    expect(installInstructions(UA.chromeAndroid)).toMatch(/Chrome.*Install app/);
    // Samsung Internet also contains "Chrome/" and "Android" in its UA: it must win over the Chrome text.
    expect(installInstructions(UA.samsung)).toMatch(/Samsung Internet.*Home screen/);
    expect(installInstructions(UA.firefoxAndroid)).toMatch(/Firefox.*Install/);
  });
  it('tells in-app WebViews to open Chrome, since they cannot install', () => {
    expect(installInstructions(UA.webview)).toMatch(/Open the link in Chrome/);
  });
  it('covers iOS and desktop', () => {
    expect(installInstructions(UA.iosSafari)).toMatch(/Safari.*Add to Home Screen/);
    expect(installInstructions(UA.desktop)).toMatch(/address bar/);
  });
});

describe('installDismissed', () => {
  it('is false when storage is unavailable (node has no localStorage)', () => {
    expect(installDismissed()).toBe(false);
  });
});
