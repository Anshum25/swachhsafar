// Swachh Safar mark: a train (journey) with a broom (cleanliness). `tile` draws it on a blue rounded square,
// the same artwork as public/logo.svg (the source of the app icons); otherwise it is drawn on transparent.
export default function Logo({ className = 'h-11 w-11', tile = false }) {
  const body = tile ? '#ffffff' : '#1d4ed8';
  const glass = tile ? '#1d4ed8' : '#dbeafe';
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="Swachh Safar logo">
      {tile && <rect width="64" height="64" rx="16" fill="#1d4ed8" />}
      <path d="M17 52l-4 7M41 52l4 7M12 59h36" stroke={body} strokeWidth="3" strokeLinecap="round" />
      <rect x="13" y="10" width="32" height="40" rx="10" fill={body} />
      <rect x="18" y="16" width="22" height="12" rx="3" fill={glass} />
      <path d="M18 33h22" stroke={glass} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="21" cy="41" r="3" fill="#fbbf24" />
      <circle cx="37" cy="41" r="3" fill="#fbbf24" />
      <path d="M58 9L47 37" stroke="#b45309" strokeWidth="3" strokeLinecap="round" />
      <path d="M44 34l7 3 2 13c-5 1-10-1-13-5l4-11Z" fill="#f59e0b" />
      <path d="M45 40l-2 6M48 41l-1 7M51 42v7" stroke="#b45309" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// Side view of a modern train on a track, for the splash screen, banners and cards. Decorative.
export function TrainArt({ className = 'h-24 w-auto' }) {
  return (
    <svg viewBox="0 0 260 96" className={className} aria-hidden="true">
      <path d="M0 86h260" stroke="#93c5fd" strokeWidth="3" />
      <path d="M6 92h248" stroke="#bfdbfe" strokeWidth="2" strokeDasharray="10 8" />
      <path d="M8 34c0-8 6-14 14-14h176c26 0 46 14 56 34 3 7-2 14-10 14H22c-8 0-14-6-14-14V34Z" fill="#ffffff" stroke="#1d4ed8" strokeWidth="3" />
      <path d="M12 56h236" stroke="#1d4ed8" strokeWidth="5" />
      <path d="M12 63h230" stroke="#60a5fa" strokeWidth="2" />
      {[24, 58, 92, 126, 160].map((x) => <rect key={x} x={x} y="30" width="26" height="16" rx="3" fill="#bfdbfe" stroke="#1d4ed8" strokeWidth="1.5" />)}
      <path d="M200 30h10c14 0 26 7 33 18h-43V30Z" fill="#1e3a8a" />
      {[34, 74, 150, 190].map((x) => <circle key={x} cx={x} cy="76" r="7" fill="#1e3a8a" />)}
    </svg>
  );
}
