// Sign-in security check (self-hosted proof-of-work CAPTCHA, ALTCHA protocol). The server issues a signed
// challenge; this device spends a moment of computation finding its answer; the server accepts each answer once.
// No images or puzzles: nothing to see or hear, so it is accessible by design.
import { API_BASE } from '../services/apiClient.js';
import { solvePow } from './sha256.js';

export async function fetchChallenge(fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}/auth/captcha`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error('The security check could not be loaded. Check the connection and try again.'), { code: 'captcha_unavailable' });
  return res.json();
}

function solveInWorker(ch) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./captcha.worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(solvePow(ch.salt, ch.challenge, ch.maxnumber)); // no module workers: solve inline
      return;
    }
    worker.onmessage = (e) => { worker.terminate(); resolve(e.data.number); };
    worker.onerror = (e) => { worker.terminate(); reject(e); };
    worker.postMessage({ salt: ch.salt, challenge: ch.challenge, maxnumber: ch.maxnumber });
  });
}

// Returns the solution to send with POST /auth/login or /auth/otp/request.
export async function solveCaptcha() {
  const ch = await fetchChallenge();
  const number = await solveInWorker(ch);
  if (number < 0) throw Object.assign(new Error('The security check could not be completed. Refresh it.'), { code: 'captcha_failed' });
  return { solution: { algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt, signature: ch.signature, number }, expiresAt: ch.expires_at };
}
