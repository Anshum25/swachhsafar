import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { API_BASE } from '../../services/apiClient.js';
import { AlertIcon, RefreshIcon, ShieldIcon, Spinner } from '../Icons.jsx';

/**
 * Visible number CAPTCHA. The server draws a random number as an image (GET /auth/captcha/image) and keeps
 * the answer to itself; the person types it. The typed answer is checked by the server only when the form is
 * submitted (sign-in, OTP request, or /auth/captcha/check for sign-up), and each image allows one attempt.
 *
 * onVerify(solution | null): a solution object once the full number is typed, null otherwise.
 * ref: { reset() -> loads a new image, verify() -> same as reset (kept for existing callers) }.
 *
 * States (data-status): loading | ready (image shown) | answered (full number typed) | failed | expired.
 */
export async function fetchCaptchaImage(fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}/auth/captcha/image`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error('The security check could not be loaded. Check your connection and try again.'), { code: 'captcha_unavailable' });
  return res.json();
}

export const CaptchaVerification = forwardRef(function CaptchaVerification(
  { onVerify, autoVerify = true, className = '', fetchImpl },
  ref,
) {
  const [status, setStatus] = useState('loading');
  const [challenge, setChallenge] = useState(null);
  const [answer, setAnswer] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const expiryTimer = useRef(null);
  const active = useRef(true);
  const seq = useRef(0); // ignores a slow response that a newer load has replaced
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    clearTimeout(expiryTimer.current);
    setStatus('loading');
    setAnswer('');
    setErrorMessage('');
    onVerifyRef.current?.(null);
    try {
      const ch = await fetchCaptchaImage(fetchImpl);
      if (!active.current || mine !== seq.current) return;
      setChallenge(ch);
      setStatus('ready');
      if (ch.expires_at) {
        const ms = Math.max(1000, Date.parse(ch.expires_at) - Date.now() - 5000);
        expiryTimer.current = setTimeout(() => {
          if (!active.current || mine !== seq.current) return;
          setStatus('expired');
          setAnswer('');
          onVerifyRef.current?.(null);
        }, ms);
      }
    } catch (err) {
      if (!active.current || mine !== seq.current) return;
      setChallenge(null);
      setStatus('failed');
      setErrorMessage(err.message || 'The security check could not be loaded.');
    }
  }, [fetchImpl]);

  useImperativeHandle(ref, () => ({ reset: load, verify: load, getStatus: () => status }), [load, status]);

  useEffect(() => {
    active.current = true;
    if (autoVerify) load();
    return () => {
      active.current = false;
      clearTimeout(expiryTimer.current);
    };
  }, [autoVerify, load]);

  function onType(value) {
    const digits = value.replace(/\D/g, '').slice(0, challenge?.length ?? 5);
    setAnswer(digits);
    const complete = challenge && digits.length === challenge.length;
    setStatus(complete ? 'answered' : 'ready');
    onVerifyRef.current?.(complete ? { algorithm: challenge.algorithm, token: challenge.token, answer: digits } : null);
  }

  const bad = status === 'failed' || status === 'expired';
  return (
    <div
      className={`rounded-2xl border p-3.5 ${bad ? 'border-red-200 bg-red-50/40' : 'border-brand-200 bg-brand-50/40'} ${className}`}
      data-testid="captcha-verification"
      data-status={status}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <ShieldIcon className="h-4 w-4 shrink-0 text-brand-700" />
        <p className="text-xs font-bold uppercase tracking-wider text-slate-800">Security Verification</p>
      </div>

      <div className="flex items-center gap-2">
        <div className="grid h-16 min-w-0 flex-1 place-items-center overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
          {status === 'loading' && <Spinner className="h-5 w-5 text-brand-700" />}
          {(status === 'ready' || status === 'answered') && challenge && (
            <img src={challenge.image} alt="Number to type" className="h-16 w-full object-contain" draggable={false} />
          )}
          {bad && (
            <span className="flex items-center gap-1.5 px-2 text-center text-xs font-medium text-red-700">
              <AlertIcon className="h-4 w-4 shrink-0" />
              {status === 'expired' ? 'Code expired. Get a new one.' : errorMessage}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={status === 'loading'}
          className="grid h-16 w-12 shrink-0 place-items-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 active:scale-95 disabled:opacity-50"
          aria-label="New security code"
          title="New security code"
        >
          <RefreshIcon className="h-5 w-5" />
        </button>
      </div>

      <label className="mt-2.5 block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Type the number shown above</span>
        <input
          className="input h-11 text-center text-lg font-bold tracking-[0.4em]"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Security code"
          maxLength={challenge?.length ?? 5}
          placeholder={'•'.repeat(challenge?.length ?? 5)}
          value={answer}
          disabled={status !== 'ready' && status !== 'answered'}
          onChange={(e) => onType(e.target.value)}
        />
      </label>
    </div>
  );
});

export default CaptchaVerification;
