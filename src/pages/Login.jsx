import { useCallback, useEffect, useRef, useState } from 'react';
import Logo, { RailScene } from '../components/Logo.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { AlertIcon, CheckIcon, PhoneIcon, RefreshIcon, Spinner } from '../components/Icons.jsx';
import { useSession } from '../app/session.jsx';
import { BLOCKS } from '../security/messages.js';
import CaptchaVerification from '../components/auth/CaptchaVerification.jsx';
import { LoginUpdateBanner } from '../components/PwaPanels.jsx';

const AUTH_MESSAGES = {
  invalid_credentials: 'Email / Employee ID or password is incorrect.',
  account_inactive: 'This account is not active. Contact your supervisor.',
  network_error: 'No connection. Signing in needs internet the first time.',
  'login_locked': 'Too many unsuccessful attempts. Sign-in is locked for 15 minutes.',
  'device_revoked': 'This device has been blocked by an administrator.',
  'otp_invalid': 'The 6-digit code is incorrect or expired. Request a new code.',
  'otp_failed': 'Could not send sign-in code right now. Try password sign-in.',
  'sms_unavailable': 'Sign-in by SMS code is not available right now. Use your Employee ID and password.',
  'captcha_unavailable': 'Security check could not be loaded. Check your connection.',
  'captcha_failed': 'Security check could not be completed. Please try again.',
  'captcha_invalid': 'The security code was wrong or expired. Type the new number shown.',
};

export default function Login() {
  const { signIn, requestOtp, verifyOtp, configError } = useSession();

  // Mode: 'password' (default) | 'otp' (mobile login)
  const [mode, setMode] = useState('password');

  // Password login state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordCaptcha, setPasswordCaptcha] = useState(null);
  const passwordCaptchaRef = useRef(null);

  // Mobile OTP state
  const [mobile, setMobile] = useState('');
  const [otpCaptcha, setOtpCaptcha] = useState(null);
  const otpCaptchaRef = useRef(null);
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [otpSent, setOtpSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [otpExpiresIn, setOtpExpiresIn] = useState(0);
  const otpInputRefs = useRef([]);

  const [busy, setBusy] = useState(false);
  // Synchronous guard: two taps in the same frame both see busy=false before React re-renders.
  const inFlight = useRef(false);
  const begin = () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    return true;
  };
  const end = () => {
    inFlight.current = false;
    setBusy(false);
  };
  const [error, setError] = useState(null);

  const handlePasswordCaptcha = useCallback((sol) => setPasswordCaptcha(sol), []);
  const handleOtpCaptcha = useCallback((sol) => setOtpCaptcha(sol), []);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const interval = setInterval(() => {
      setResendCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  // OTP expiration timer (5 minutes)
  useEffect(() => {
    if (!otpSent || otpExpiresIn <= 0) return undefined;
    const interval = setInterval(() => {
      setOtpExpiresIn((e) => {
        if (e <= 1) {
          setError('Verification code expired. Request a new code.');
          return 0;
        }
        return e - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [otpSent, otpExpiresIn]);

  // Handle password form submission
  async function handlePasswordSubmit(e) {
    e.preventDefault();
    if (!email.trim() || !password || !passwordCaptcha) return;
    if (!begin()) return;
    setError(null);
    try {
      await signIn(email.trim(), password, { captchaSolution: passwordCaptcha });
      window.location.hash = '#/';
    } catch (err) {
      const code = err.code || err.message;
      const b = BLOCKS[code];
      setError(b ? b.what : (AUTH_MESSAGES[code] || err.message || 'Sign in failed'));
      // Reset CAPTCHA on failure as challenges are single-use
      setPasswordCaptcha(null);
      passwordCaptchaRef.current?.reset?.();
      passwordCaptchaRef.current?.verify?.();
    } finally {
      end();
    }
  }

  // Handle Request OTP
  async function handleSendOtp(e) {
    e?.preventDefault?.();
    const cleanMobile = mobile.replace(/\D/g, '');
    if (cleanMobile.length !== 10) {
      setError('Enter a valid 10-digit Indian mobile number');
      return;
    }
    if (!otpCaptcha) {
      setError('Please complete the security verification first');
      return;
    }
    if (!begin()) return;
    setError(null);
    try {
      const res = await requestOtp(cleanMobile, { captchaSolution: otpCaptcha });
      setOtpSent(true);
      setResendCooldown(res.resend_after_seconds || 60);
      setOtpExpiresIn(res.expires_in_seconds || 300);
      setOtpDigits(['', '', '', '', '', '']);
      // Clear CAPTCHA solution after use; a new request requires a fresh CAPTCHA
      setOtpCaptcha(null);
      otpCaptchaRef.current?.reset?.();
      setTimeout(() => otpInputRefs.current[0]?.focus(), 100);
    } catch (err) {
      const code = err.code || err.message;
      setError(AUTH_MESSAGES[code] || err.message || 'Could not send verification code');
      setOtpCaptcha(null);
      otpCaptchaRef.current?.reset?.();
      otpCaptchaRef.current?.verify?.();
    } finally {
      end();
    }
  }

  // Handle individual OTP digit change
  const handleDigitChange = (index, value) => {
    const val = value.replace(/\D/g, '');
    const newDigits = [...otpDigits];

    if (val.length > 1) {
      // Pasted multi-character code
      const pasted = val.slice(0, 6).split('');
      pasted.forEach((d, i) => {
        newDigits[i] = d;
      });
      setOtpDigits(newDigits);
      const nextIdx = Math.min(5, pasted.length);
      otpInputRefs.current[nextIdx]?.focus();
      return;
    }

    newDigits[index] = val ? val[val.length - 1] : '';
    setOtpDigits(newDigits);

    if (val && index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleDigitKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    }
  };

  // Handle Verify OTP and Sign in
  async function handleVerifyOtp(e) {
    e.preventDefault();
    const cleanMobile = mobile.replace(/\D/g, '');
    const code = otpDigits.join('');

    if (code.length !== 6) {
      setError('Enter the complete 6-digit verification code');
      return;
    }
    if (otpExpiresIn <= 0) {
      setError('Verification code expired. Request a new code.');
      return;
    }
    if (!begin()) return;
    setError(null);
    try {
      await verifyOtp(cleanMobile, code);
      window.location.hash = '#/';
    } catch (err) {
      const errCode = err.code || err.message;
      setError(AUTH_MESSAGES[errCode] || err.message || 'Invalid verification code');
    } finally {
      end();
    }
  }

  const formatExpiryTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#f0f6ff] px-4 pb-32 pt-8 sm:px-6">
      {/* Background railway decorative geometry */}
      <svg
        viewBox="0 0 400 300"
        className="pointer-events-none absolute -left-8 -top-6 w-[115%] max-w-3xl"
        aria-hidden="true"
      >
        <path d="M0 0h400c-40 70-120 92-210 104C108 116 40 160 0 236Z" fill="#eaf3ff" />
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        <RailScene className="mx-auto block h-auto w-full max-w-[min(42rem,40vh)]" />
      </div>

      <LoginUpdateBanner />

      {/* Main Login Card */}
      <div className="card relative z-10 w-full max-w-md animate-splash-in space-y-5 rounded-3xl bg-white p-6 shadow-raised ring-1 ring-slate-100 sm:p-8">
        {mode === 'password' ? (
          /* ========================================================================= */
          /* DEFAULT SCREEN: EMAIL + PASSWORD + CAPTCHA                                */
          /* ========================================================================= */
          <>
            {/* 1. Logo, 2. Heading, 3. Subtitle */}
            <div className="flex flex-col items-center text-center">
              <Logo className="h-16 w-16" />
              <p className="mt-1 text-2xl font-black tracking-tight text-brand-700">Swachh Safar</p>
              <h1 className="mt-2 text-xl font-bold text-ink">Sign in</h1>
              <p className="text-sm font-medium text-slate-500">Swachh Safar operations</p>
            </div>

            {/* Error Message */}
            {(error || configError) && (
              <div
                className="flex items-start gap-2.5 rounded-2xl bg-red-50 p-3.5 text-sm font-medium text-red-800 ring-1 ring-red-200"
                role="alert"
              >
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <span className="flex-1">{error ?? configError}</span>
              </div>
            )}

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              {/* 4. Email or Employee ID. Sign-in accepts either (the backend matches emp_id or email), so
                   this must not be type="email": the browser would refuse an employee ID for having no "@". */}
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-slate-700">Email or Employee ID</span>
                <input
                  id="email"
                  aria-label="Email or Employee ID"
                  className="input h-11"
                  name="username"
                  type="text"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  placeholder="name@railnet.gov.in or EMP ID"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              {/* 5. Password Field & 6. Show/hide password */}
              <div>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                />
              </div>

              {/* 7. Visible CAPTCHA verification component */}
              <div className="pt-1">
                <CaptchaVerification
                  ref={passwordCaptchaRef}
                  onVerify={handlePasswordCaptcha}
                  autoVerify={true}
                />
              </div>

              {/* 8. Blue Sign in button (disabled until CAPTCHA verified) */}
              <button
                type="submit"
                className="btn-primary w-full h-11 text-base font-bold shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition"
                disabled={busy || !email.trim() || !password || !passwordCaptcha}
              >
                {busy ? <Spinner className="h-5 w-5 text-white" /> : null}
                <span>Sign in</span>
              </button>
            </form>

            {/* 9. Divider: OR */}
            <div className="relative my-4 flex items-center justify-center">
              <div className="w-full border-t border-slate-200" />
              <span className="absolute bg-white px-3 text-xs font-bold uppercase tracking-wider text-slate-400">
                OR
              </span>
            </div>

            {/* 10. Alternative mobile OTP login option */}
            <button
              type="button"
              onClick={() => {
                setMode('otp');
                setError(null);
                setOtpSent(false);
              }}
              className="flex w-full h-11 items-center justify-center gap-2 rounded-2xl border-2 border-brand-600 bg-white px-4 text-sm font-semibold text-brand-700 shadow-sm hover:bg-brand-50/60 active:scale-[0.99] transition"
            >
              <PhoneIcon className="h-4 w-4 text-brand-600" />
              <span>Log in with Mobile Number</span>
            </button>

            {/* 11. Accounts are created by an administrator */}
            <p className="pt-1 text-center text-sm font-medium text-slate-500">
              New user? Ask your administrator for an account.
            </p>
          </>
        ) : (
          /* ========================================================================= */
          /* MOBILE OTP LOGIN SCREEN                                                   */
          /* ========================================================================= */
          <>
            {/* 1. Logo, 2. Heading, 3. Subtitle */}
            <div className="flex flex-col items-center text-center">
              <Logo className="h-16 w-16" />
              <p className="mt-1 text-2xl font-black tracking-tight text-brand-700">Swachh Safar</p>
              <h1 className="mt-2 text-xl font-bold text-ink">Mobile Number Login</h1>
              <p className="text-sm font-medium text-slate-500">Sign in using your registered mobile number</p>
            </div>

            {/* Error Message */}
            {(error || configError) && (
              <div
                className="flex items-start gap-2.5 rounded-2xl bg-red-50 p-3.5 text-sm font-medium text-red-800 ring-1 ring-red-200"
                role="alert"
              >
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <span className="flex-1">{error ?? configError}</span>
              </div>
            )}

            {!otpSent ? (
              /* Step 1: Mobile Number Entry + CAPTCHA + Send OTP */
              <form onSubmit={handleSendOtp} className="space-y-4">
                {/* 4. Mobile number input with 5. Country code +91 */}
                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">Mobile Number</span>
                  <div className="relative">
                    <span className="absolute left-3.5 top-3 flex items-center gap-1 text-sm font-bold text-slate-500">
                      <span>🇮🇳</span>
                      <span>+91</span>
                    </span>
                    <input
                      className="input h-11 pl-16 text-base tracking-wider font-medium"
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9]{10}"
                      maxLength={10}
                      autoComplete="tel-national"
                      placeholder="9876543210"
                      required
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    />
                  </div>
                </label>

                {/* 6. Visible CAPTCHA verification component */}
                <div className="pt-1">
                  <CaptchaVerification
                    ref={otpCaptchaRef}
                    onVerify={handleOtpCaptcha}
                    autoVerify={true}
                  />
                </div>

                {/* 7. Send OTP button */}
                <button
                  type="submit"
                  className="btn-primary w-full h-11 text-base font-bold shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition"
                  disabled={busy || mobile.replace(/\D/g, '').length !== 10 || !otpCaptcha}
                >
                  {busy ? <Spinner className="h-5 w-5 text-white" /> : null}
                  <span>Send OTP</span>
                </button>
              </form>
            ) : (
              /* Step 2: OTP Verification */
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                  <span>If +91 {mobile} is registered, a code has been sent by SMS. It can take a minute to arrive.</span>
                  <button
                    type="button"
                    className="text-brand-700 hover:underline"
                    onClick={() => {
                      setOtpSent(false);
                      setOtpDigits(['', '', '', '', '', '']);
                    }}
                  >
                    Change
                  </button>
                </div>

                {/* 8. Six-digit OTP input boxes */}
                <div>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-700">Enter 6-Digit OTP</span>
                    {otpExpiresIn > 0 && (
                      <span className="font-medium text-slate-500">
                        Expires in <b className="text-brand-700">{formatExpiryTime(otpExpiresIn)}</b>
                      </span>
                    )}
                  </div>

                  <div className="flex justify-between gap-2" role="group" aria-label="6-Digit Verification Code">
                    {otpDigits.map((digit, idx) => (
                      <input
                        key={idx}
                        ref={(el) => (otpInputRefs.current[idx] = el)}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        className="h-12 w-11 rounded-xl border border-slate-300 bg-white text-center text-xl font-bold text-slate-900 shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20 sm:w-12"
                        value={digit}
                        onChange={(e) => handleDigitChange(idx, e.target.value)}
                        onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                        autoFocus={idx === 0}
                      />
                    ))}
                  </div>
                </div>

                {/* A resend is a new OTP request, so it needs a fresh CAPTCHA (challenges are single-use). */}
                {resendCooldown <= 0 && (
                  <CaptchaVerification ref={otpCaptchaRef} onVerify={handleOtpCaptcha} autoVerify={true} />
                )}

                {/* 9. Resend countdown & 10. Resend OTP option */}
                <div className="flex items-center justify-between pt-1 text-xs">
                  {resendCooldown > 0 ? (
                    <span className="text-slate-500">Resend code in {resendCooldown}s</span>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-bold text-brand-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={handleSendOtp}
                      disabled={busy || !otpCaptcha}
                    >
                      <RefreshIcon className="h-3 w-3" />
                      <span>Resend OTP</span>
                    </button>
                  )}
                  <span className="text-slate-400">Valid for 5 mins</span>
                </div>

                {/* 11. Verify & Sign in button */}
                <button
                  type="submit"
                  className="btn-primary w-full h-11 text-base font-bold shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition"
                  disabled={busy || otpDigits.join('').length !== 6 || otpExpiresIn <= 0}
                >
                  {busy ? <Spinner className="h-5 w-5 text-white" /> : null}
                  <span>Verify &amp; Sign in</span>
                </button>
              </form>
            )}

            {/* 12. Back to Email & Password option */}
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => {
                  setMode('password');
                  setError(null);
                }}
                className="text-sm font-semibold text-brand-700 hover:underline"
              >
                ← Back to Email &amp; Password
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
