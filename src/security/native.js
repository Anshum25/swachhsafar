// The Android app's native security plugin (android/app/src/main/java/.../SwachhSecurityPlugin.kt), reached
// through the Capacitor bridge. null in a browser (PWA): callers fall back to web APIs and say so.
export const isNativeApp = () => !!globalThis.Capacitor?.isNativePlatform?.();

export function nativeSecurity() {
  return isNativeApp() ? globalThis.Capacitor?.Plugins?.SwachhSecurity ?? null : null;
}

export const platform = () => (isNativeApp() ? 'android' : 'web');
