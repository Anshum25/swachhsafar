// The Android app's new-version check (src/pwa/appUpdate.js): the APK has no service worker to update
// itself, so it compares the commit it was built from with the published release and offers a download.
import { describe, expect, it } from 'vitest';
import { checkAppUpdate } from '../../src/pwa/appUpdate.js';

const BUILT = 'a'.repeat(40);
const PUBLISHED = 'b'.repeat(40);

const answer = (body, { ok = true, type = 'application/json' } = {}) => async () => ({
  ok,
  headers: { get: () => type },
  json: async () => body,
});

const check = (fetchImpl, sha = BUILT) =>
  checkAppUpdate({ fetchImpl, sha, url: '/downloads/latest.json', downloadUrl: '/downloads/swachh-safar-latest.apk' });

describe('APK update check', () => {
  it('offers the download when the published release is a different commit', async () => {
    expect(await check(answer({ sha: PUBLISHED, version_name: '2.1.0' }))).toEqual({
      available: true, version: '2.1.0', build: PUBLISHED.slice(0, 7), url: '/downloads/swachh-safar-latest.apk',
    });
  });

  // The alias is one name for a file that keeps changing, cached for hours; the release's own file is
  // not. Handing back a cached older APK under the alias installs something that changes nothing and
  // leaves the banner up, so the release's own url wins whenever it publishes one.
  it("downloads the release's own file rather than the latest alias", async () => {
    const release = { sha: PUBLISHED, version_name: '2.1.0', url: '/downloads/swachh-safar-bbbbbbb.apk' };
    expect(await check(answer(release))).toMatchObject({ url: expect.stringContaining('/downloads/swachh-safar-bbbbbbb.apk') });
    // Anything that is not a download path on this server is ignored: the banner never sends a phone
    // somewhere a release file said to go.
    for (const url of ['https://elsewhere.example/app.apk', '/etc/passwd', 42]) {
      expect(await check(answer({ ...release, url }))).toMatchObject({ url: '/downloads/swachh-safar-latest.apk' });
    }
  });

  it('says nothing when the published release is this build', async () => {
    expect(await check(answer({ sha: BUILT, version_name: '2.0.0' }))).toEqual({ available: false });
  });

  it('offers the download even when the release states no version name', async () => {
    expect(await check(answer({ sha: PUBLISHED }))).toEqual({
      available: true, version: null, build: PUBLISHED.slice(0, 7), url: '/downloads/swachh-safar-latest.apk',
    });
  });

  it('never guesses: no commit in the build, none published, an error, or a non-JSON answer', async () => {
    const quiet = { available: false };
    expect(await check(answer({ sha: PUBLISHED }), '')).toEqual(quiet); // local build, nothing to compare
    expect(await check(answer({ file: 'x.apk' }))).toEqual(quiet); // release without a commit id
    expect(await check(answer({ sha: PUBLISHED }, { ok: false }))).toEqual(quiet);
    expect(await check(answer('<html>', { type: 'text/html' }))).toEqual(quiet); // captive portal
    expect(await check(async () => { throw new Error('offline'); })).toEqual(quiet);
    expect(await check(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => { throw new Error('bad json'); } }))).toEqual(quiet);
  });

  it('asks the server for the current release, never a cached copy', async () => {
    const calls = [];
    await check(async (url, init) => {
      calls.push([url, init]);
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ sha: BUILT }) };
    });
    expect(calls[0][0]).toBe('/downloads/latest.json');
    expect(calls[0][1].cache).toBe('no-store');
  });
});
