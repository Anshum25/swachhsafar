// Solves a sign-in proof-of-work challenge off the main thread.
import { solvePow } from './sha256.js';

self.onmessage = (e) => {
  const { salt, challenge, maxnumber } = e.data;
  const started = performance.now();
  const number = solvePow(salt, challenge, maxnumber);
  self.postMessage({ number, took: Math.round(performance.now() - started) });
};
