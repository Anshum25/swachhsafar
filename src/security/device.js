// This installation's device id: generated once and kept on the device (Android: Keystore-encrypted storage
// via the native plugin; browser: local storage). Registered with the server at the first sign-in; an
// administrator can block it. It identifies the installation, not a person (devices are shared by staff).
import { nativeSecurity, platform } from './native.js';

const KEY = 'swachh.device_id';
const LEGACY_KEY = 'device_id';
let cached = null;

function newId() {
  const bytes = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? crypto.getRandomValues(new Uint8Array(16))
    : new Uint8Array(16).map(() => Math.floor(Math.random() * 256));
  return `${platform() === 'android' ? 'and' : 'web'}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function label() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : '';
  const model = ua.match(/Android [\d.]+; ([^;)]+)/)?.[1]?.trim();
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return (platform() === 'android' ? `Android app${model ? ` · ${model}` : ''}` : `${browser}${model ? ` · ${model}` : ''}`).slice(0, 120);
}

export async function getDeviceId() {
  const dev = await getDevice();
  return dev.id;
}

export async function getDevice() {
  if (cached) return cached;
  const native = nativeSecurity();
  let id = null;
  if (native) {
    id = (await native.secureGet({ key: KEY }).catch(() => null))?.value ?? null;
    if (!id) {
      id = (await native.secureGet({ key: LEGACY_KEY }).catch(() => null))?.value ?? null;
    }
    if (!id) {
      id = newId();
    }
    await native.secureSet({ key: KEY, value: id }).catch(() => {});
    await native.secureSet({ key: LEGACY_KEY, value: id }).catch(() => {});
  } else {
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    try {
      id = storage?.getItem(KEY) || storage?.getItem(LEGACY_KEY);
    } catch { /* storage blocked */ }
    if (!id) {
      id = newId();
    }
    try {
      storage?.setItem(KEY, id);
      storage?.setItem(LEGACY_KEY, id);
    } catch { /* session only */ }
  }
  cached = { id, platform: platform(), label: label() };
  return cached;
}
