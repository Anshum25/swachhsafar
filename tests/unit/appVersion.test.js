// The app's version lives in package.json and nowhere else.
//
// It used to be written twice -- package.json for the footer, android/app/build.gradle for the APK -- and
// the two drifted: every APK published said 2.0.2 while the builds inside them differed, so neither the
// app nor Android could say which release was installed. The Gradle file now reads package.json, and
// versionCode is that version plus the CI run number, which rises with every build.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const gradle = read('android/app/build.gradle');
const pkgVersion = JSON.parse(read('package.json')).version;

// What android/app/build.gradle computes, kept here so the scheme can be checked without running Gradle.
const versionCode = (version, build) => {
  const [major, minor, patch] = version.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  return (major * 10000 + minor * 100 + patch) * 1000 + build;
};

describe('app version', () => {
  it('is a plain major.minor.patch in package.json', () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is not written a second time in the Android build', () => {
    expect(gradle).toMatch(/versionName swachhVersionName/);
    expect(gradle).toMatch(/versionCode swachhVersionCode/);
    expect(gradle).toMatch(/parse\(file\('\.\.\/\.\.\/package\.json'\)\)/);
    // A literal version in the Gradle file is the drift this guards against.
    expect(gradle).not.toMatch(/versionName\s+"\d/);
    expect(gradle).not.toMatch(/versionCode\s+\d/);
  });

  it('builds a versionCode that always rises, and stays inside what Android accepts', () => {
    // Within one version: a later CI run is a higher code.
    expect(versionCode('2.0.3', 419)).toBeGreaterThan(versionCode('2.0.3', 418));
    // Across a version bump the base jumps by 1000, so the code rises even when the run number resets.
    expect(versionCode('2.0.4', 0)).toBeGreaterThan(versionCode('2.0.3', 999));
    expect(versionCode('2.1.0', 0)).toBeGreaterThan(versionCode('2.0.99', 999));
    expect(versionCode('3.0.0', 0)).toBeGreaterThan(versionCode('2.9.9', 999));
    // Higher than the 202 that releases up to 2.0.2 carried, so those phones are offered an upgrade.
    expect(versionCode(pkgVersion, 0)).toBeGreaterThan(202);
    // Android refuses a versionCode above 2_100_000_000.
    expect(versionCode('9.9.9', 999)).toBeLessThan(2_100_000_000);
  });
});
