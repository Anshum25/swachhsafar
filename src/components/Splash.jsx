// Start-up screen while the local database opens and the session resolves (reference: splash screen).
import Logo, { RailScene } from './Logo.jsx';

export default function Splash() {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-white" role="status" aria-label="Starting Swachh Safar">
      {/* Pale-blue curved shape entering from the top-left corner. */}
      <svg viewBox="0 0 400 300" className="pointer-events-none absolute -left-8 -top-6 w-[115%] max-w-3xl" aria-hidden="true">
        <path d="M0 0h400c-40 70-120 92-210 104C108 116 40 160 0 236Z" fill="#eaf3ff" />
        <path d="M0 0h300c-34 48-100 66-170 76C70 88 26 118 0 160Z" fill="#dcebff" opacity=".7" />
      </svg>
      <div className="relative z-10 flex flex-1 animate-splash-in flex-col items-center justify-center px-6 pb-[min(38vh,26rem,58vw)] pt-16 text-center">
        <Logo className="h-28 w-28 drop-shadow-[0_8px_18px_rgba(7,89,214,0.18)] sm:h-32 sm:w-32" />
        <h1 className="mt-3 text-[34px] font-extrabold leading-none tracking-tight text-brand-700 sm:text-4xl">Swachh Safar</h1>
        <p className="mt-3 max-w-[15rem] text-[15px] font-medium leading-snug text-brand-900">Railway Inspection &amp; Monitoring System</p>
        <span className="mt-7 flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-600" style={{ animationDelay: `${i * 180}ms` }} />)}
        </span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 animate-train-in">
        <RailScene className="mx-auto block h-auto w-full max-w-[min(42rem,58vh)]" />
      </div>
    </div>
  );
}
