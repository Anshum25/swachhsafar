// The backend session token on this device, and whose it is.
//
// Sign-in (POST /auth/login or /auth/otp/verify) returns an opaque bearer token; it is sent on every API call
// until the session is signed out or revoked on the server. It is kept in localStorage, like the Firebase
// refresh token was before sign-in moved to our own backend, so the app opens signed in, also offline.
// `account` ({ userId, email, empId }) is filled from /auth/me and lets an offline start find the
// authorization cached on this device. Storage can be unavailable (private mode): then the session lasts
// as long as the page.
const KEY = 'swachh_auth_v1';
let memory = null;

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? JSON.parse(raw) : memory;
  } catch {
    return memory;
  }
}

function write(value) {
  memory = value;
  try {
    if (value) globalThis.localStorage?.setItem(KEY, JSON.stringify(value));
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* storage blocked: kept in memory only */ }
}

const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(read()));

export function getAuth() {
  const value = read();
  return value?.token ? value : null;
}

export function getToken() {
  return getAuth()?.token ?? null;
}

export function saveToken(token, account = null) {
  write({ token, account });
  emit();
}

export function saveAccount(account) {
  const current = getAuth();
  if (current) write({ ...current, account });
}

export function clearToken() {
  write(null);
  emit();
}

export function subscribeAuth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
