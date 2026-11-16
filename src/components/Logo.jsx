import { useId } from 'react';

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

// Decorative artwork (aria-hidden): a modern blue-and-white train in three-quarter view, and the station scene
// of the splash screen and menu. Gradient ids are per instance (useId) because several trains share a page.
export function TrainArt({ className = 'h-24 w-auto', track = true }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 240 104" className={className} aria-hidden="true">
      <TrainShape id={id} track={track} />
    </svg>
  );
}

function TrainShape({ id, track = true, x = 0, y = 0, scale = 1 }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e1edfc" /></linearGradient>
        <linearGradient id={`${id}w`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0b3f8f" /><stop offset="1" stopColor="#08295c" /></linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#ffffff" stopOpacity="0" /><stop offset="0.18" stopColor="#ffffff" stopOpacity="1" /></linearGradient>
        <mask id={`${id}m`}><rect width="240" height="104" fill={`url(#${id}f)`} /></mask>
      </defs>
      {track && (
        <>
          <ellipse cx="124" cy="95" rx="116" ry="5" fill="#0759d6" opacity=".10" />
          <path d="M0 98 L240 90" stroke="#9cc2f5" strokeWidth="2" />
          <path d="M0 103 L240 95" stroke="#c9ddf8" strokeWidth="1.5" />
        </>
      )}
      <g mask={`url(#${id}m)`}>
        <path d="M-6 41 L148 26 C184 23 212 36 228 60 C235 71 233 81 222 84 L-6 93 Z" fill={`url(#${id}b)`} stroke="#0759d6" strokeWidth="2.2" strokeLinejoin="round" />
        <path d="M-6 48 L150 34 C168 32 182 34 194 39" fill="none" stroke="#bcd5f7" strokeWidth="1.5" />
        <path d="M-6 54 L166 43 L170 55 L-6 65 Z" fill={`url(#${id}w)`} />
        <path d="M30 51.3v11.2M58 49.6v11.4M86 47.9v11.6M114 46.2v11.8M142 44.5v12" stroke="#5f8fd6" strokeWidth="1.2" />
        <path d="M-6 73 L200 66 C214 66 225 68 231 72 L231 77 L-6 85Z" fill="#0759d6" />
        <path d="M-6 80 L231 74" stroke="#1685f8" strokeWidth="1.4" />
        <path d="M96 58.5v19M104 58v19" stroke="#bcd5f7" strokeWidth="1.2" />
        <path d="M20 91 h40 M150 87 h40" stroke="#08295c" strokeWidth="3" strokeLinecap="round" />
      </g>
      <path d="M174 34 C196 34 214 45 225 62 L198 63 C193 52 186 42 174 34Z" fill="#08295c" />
      <path d="M180 37 C194 38 206 46 213 55" fill="none" stroke="#3d7be0" strokeWidth="1.5" opacity=".8" />
      <ellipse cx="221" cy="80" rx="4.5" ry="2" fill="#ffd166" />
    </g>
  );
}

const Cloud = ({ x, y, s = 1 }) => (
  <path transform={`translate(${x} ${y}) scale(${s})`} d="M0 20a14 14 0 0 1 26-7a11 11 0 0 1 19 7Z" fill="#ffffff" />
);

// Station platform under two blue canopies with the train at the platform. `compact` drops the city
// skyline and canopies' outer pillars for the small version at the foot of the menu.
export function RailScene({ className = 'w-full', compact = false }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox={compact ? '0 64 360 166' : '0 0 360 230'} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#eaf3ff" stopOpacity="0" /><stop offset="1" stopColor="#d4e6fd" /></linearGradient>
      </defs>
      <rect width="360" height="230" fill={`url(#${id}s)`} />
      {!compact && (
        <g fill="#d3e4fb">
          <rect x="10" y="78" width="22" height="80" rx="2" /><rect x="36" y="58" width="16" height="100" rx="2" /><rect x="56" y="92" width="26" height="66" rx="2" />
          <rect x="268" y="70" width="18" height="88" rx="2" /><rect x="290" y="88" width="28" height="70" rx="2" /><rect x="322" y="52" width="18" height="106" rx="2" />
        </g>
      )}
      <Cloud x={34} y={compact ? 18 : 28} /><Cloud x={258} y={compact ? 8 : 16} s={1.15} /><Cloud x={150} y={compact ? 30 : 46} s={0.7} />
      <path d="M-10 92 L132 74 L146 82 L-10 104Z" fill="#0759d6" />
      <path d="M-10 104 L146 82 L146 87 L-10 110Z" fill="#08295c" />
      <path d="M28 104v62M104 90v76" stroke="#0b3f8f" strokeWidth="4" />
      <path d="M370 80 L232 66 L218 74 L370 92Z" fill="#1685f8" />
      <path d="M370 92 L218 74 L218 79 L370 97Z" fill="#0b3f8f" />
      <path d="M332 94v72M256 80v86" stroke="#0b3f8f" strokeWidth="4" />
      <TrainShape id={`${id}t`} x={22} y={88} scale={1.32} track={false} />
      <path d="M0 202 L360 186 L360 230 L0 230Z" fill="#c6dcfa" />
      <path d="M0 202 L360 186" stroke="#0759d6" strokeWidth="3" />
      <path d="M0 212 L360 195" stroke="#ffd166" strokeWidth="2" strokeDasharray="10 8" />
    </svg>
  );
}
