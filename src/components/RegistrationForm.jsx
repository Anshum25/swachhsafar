import { useEffect, useRef, useState } from 'react';
import PasswordInput from './PasswordInput.jsx';
import { Spinner } from './Icons.jsx';
import CaptchaVerification from './auth/CaptchaVerification.jsx';
import { API_BASE } from '../services/apiClient.js';
import { validateRegistration } from '../utils/validation.js';

// Collects email + password and hands them to onRegister. Field errors returned by onRegister
// (e.g. duplicate email) are shown inline.
export default function RegistrationForm({ onRegister, disabled }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [captcha, setCaptcha] = useState(null);
  const captchaRef = useRef(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); };
  }, []);

  // Online: the typed number is checked (and used up) by the server before the registration is saved.
  // Offline: registration stays possible (it is saved on this device and synced later), without the check.
  async function checkCaptcha() {
    if (!online) return true;
    if (!captcha) {
      setErrors((e) => ({ ...e, captcha: 'Type the number shown in the security image.' }));
      return false;
    }
    let res;
    try {
      res = await fetch(`${API_BASE}/auth/captcha/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captcha }),
      });
    } catch {
      res = null;
    }
    if (res?.ok) return true;
    setErrors((e) => ({ ...e, captcha: res ? 'The security code was wrong or expired. Type the new number shown.' : 'Could not check the security code. Check your connection.' }));
    setCaptcha(null);
    captchaRef.current?.reset();
    return false;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const check = validateRegistration({ email, password });
    setErrors(check.errors);
    if (!check.valid) return;

    setSubmitting(true);
    try {
      if (!(await checkCaptcha())) return;
      const outcome = await onRegister({ email, password });
      if (outcome?.fieldErrors) setErrors(outcome.fieldErrors);
      if (outcome?.ok) {
        setEmail('');
        setPassword('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || disabled;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-label="Registration form">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">Username / Email</label>
        <input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck="false"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
          className={`input ${errors.email ? 'input-error' : ''}`}
          placeholder="you@example.com"
        />
        {errors.email && <p id="email-error" className="mt-1.5 text-sm text-red-600">{errors.email}</p>}
      </div>

      <PasswordInput value={password} onChange={setPassword} error={errors.password} showStrength disabled={busy} />

      {online ? (
        <div>
          <CaptchaVerification ref={captchaRef} onVerify={setCaptcha} />
          {errors.captcha && <p className="mt-1.5 text-sm text-red-600" role="alert">{errors.captcha}</p>}
        </div>
      ) : (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">Offline: the security code is skipped. Your registration is saved on this device and sent when you reconnect.</p>
      )}

      <button type="submit" disabled={busy || (online && !captcha)} className="btn-primary w-full">
        {submitting ? (<><Spinner className="h-5 w-5" /> Registering…</>) : 'Register'}
      </button>
    </form>
  );
}
