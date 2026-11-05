// Start-up screen while the local database opens and the session resolves.
import Logo, { TrainArt } from './Logo.jsx';

export default function Splash() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-white via-brand-50 to-brand-100 px-6 text-center"
      role="status" aria-label="Starting Swachh Safar">
      <Logo className="h-24 w-24" />
      <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-brand-800">Swachh Safar</h1>
      <p className="mt-2 max-w-xs text-base text-slate-600">Railway Inspection &amp; Monitoring System</p>
      <span className="mt-8 h-1 w-16 animate-pulse rounded-full bg-brand-600" />
      <TrainArt className="pointer-events-none absolute bottom-6 left-1/2 h-24 w-auto -translate-x-1/2 opacity-90 sm:h-32" />
    </div>
  );
}
