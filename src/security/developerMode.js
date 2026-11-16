// Developer options check (Android app only). A browser/PWA cannot read this setting, so it is reported as
// unsupported there and never blocks. An older APK without the native method is also unsupported.
export async function checkDeveloperMode(plugin) {
  if (!plugin?.getDeviceIntegrity) return { supported: false, developerMode: false };
  try {
    const r = await plugin.getDeviceIntegrity();
    return { supported: true, developerMode: r?.developerMode === true, usbDebugging: r?.usbDebugging === true };
  } catch {
    return { supported: false, developerMode: false };
  }
}
