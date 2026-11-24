// Minimal inline stroke icons (no icon font, so they work offline).
const Icon = ({ children, className = 'h-4 w-4', ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true" className={className} {...props}>
    {children}
  </svg>
);

export const EyeIcon = (p) => (
  <Icon {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const EyeOffIcon = (p) => (
  <Icon {...p}>
    <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="m2 2 20 20" />
  </Icon>
);
export const DatabaseIcon = (p) => (
  <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Icon>
);
export const CloudIcon = (p) => (
  <Icon {...p}><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12 3.5 3.5 0 0 0 6 19Z" /></Icon>
);
export const ClockIcon = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
);
export const RefreshIcon = (p) => (
  <Icon {...p}><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8" /><path d="M21 3v5h-5" /><path d="M3 21v-5h5" /></Icon>
);
export const CheckIcon = (p) => (
  <Icon {...p}><path d="m5 12 5 5 9-10" /></Icon>
);
export const AlertIcon = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" /></Icon>
);
export const Spinner = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export const HomeIcon = (p) => (
  <Icon {...p}><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></Icon>
);
export const TrainIcon = (p) => (
  <Icon {...p}><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M9 21l-2-4M15 21l2-4M9 14h.01M15 14h.01" /></Icon>
);
export const UsersIcon = (p) => (
  <Icon {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></Icon>
);
export const ClipboardIcon = (p) => (
  <Icon {...p}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 11l2 2 4-4M9 17h6" /></Icon>
);
export const ChatIcon = (p) => (
  <Icon {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></Icon>
);
export const FlagIcon = (p) => (
  <Icon {...p}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></Icon>
);
export const ChartIcon = (p) => (
  <Icon {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Icon>
);
export const DatabaseGridIcon = (p) => (
  <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>
);
export const BriefcaseIcon = (p) => (
  <Icon {...p}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></Icon>
);
export const BoxIcon = (p) => (
  <Icon {...p}><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8" /></Icon>
);
export const MenuIcon = (p) => (
  <Icon {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Icon>
);
export const XIcon = (p) => (
  <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>
);
export const CameraIcon = (p) => (
  <Icon {...p}><path d="M4 8h3l2-3h6l2 3h3v11H4Z" /><circle cx="12" cy="13" r="3.5" /></Icon>
);
// Camera with arrows around it: switch between the front and back cameras.
export const FlipCameraIcon = (p) => (
  <Icon {...p}>
    <path d="M4 8h3l2-3h6l2 3h3v11H4Z" />
    <path d="M9.5 12.5a2.8 2.8 0 0 1 5-1.6M14.5 15.5a2.8 2.8 0 0 1-5 1.6" />
    <path d="M14.8 10.9h-1.9M9.2 17.1h1.9" />
  </Icon>
);
export const PinIcon = (p) => (
  <Icon {...p}><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></Icon>
);
export const PlusIcon = (p) => (
  <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
);
export const ChevronLeftIcon = (p) => (
  <Icon {...p}><path d="m15 18-6-6 6-6" /></Icon>
);
export const LogoutIcon = (p) => (
  <Icon {...p}><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></Icon>
);
export const UserIcon = (p) => (
  <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></Icon>
);
export const FingerprintIcon = (p) => (
  <Icon {...p}>
    <path d="M12 11c0 4-.4 6.3-1.3 8.2" /><path d="M8.5 19.5A14 14 0 0 0 9.6 12a2.4 2.4 0 0 1 4.8 0c0 2.6-.2 4.6-.7 6.4" />
    <path d="M16.6 17.8A22 22 0 0 0 17 12a5 5 0 0 0-9.3-2.6" /><path d="M5 13.6A11 11 0 0 1 5 12a7 7 0 0 1 11.6-5.3" />
  </Icon>
);
export const LockIcon = (p) => (
  <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>
);
export const ThumbUpIcon = (p) => (
  <Icon {...p}><path d="M7 10v11H4V10h3Z" /><path d="M7 10l4-8a2.5 2.5 0 0 1 2.5 2.5V8h5.3a2 2 0 0 1 2 2.3l-1.4 8.4a2 2 0 0 1-2 1.7H7" /></Icon>
);
export const CalendarIcon = (p) => (
  <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Icon>
);
export const ChevronRightIcon = (p) => (
  <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>
);
export const MoreIcon = (p) => (
  <Icon {...p}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Icon>
);
export const LinkIcon = (p) => (
  <Icon {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Icon>
);
export const CheckCircleIcon = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></Icon>
);

// ---- design-system additions (Lucide geometry, 2px stroke) ------------------------------------------
export const BellIcon = (p) => (
  <Icon {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></Icon>
);
// Lucide "wallet": the office's credit wallet in the top bar.
export const WalletIcon = (p) => (
  <Icon {...p}><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></Icon>
);
export const ArrowLeftIcon = (p) => (
  <Icon {...p}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></Icon>
);
export const SeatIcon = (p) => (
  <Icon {...p}><path d="M7 18v-6a5 5 0 1 1 10 0v6" /><path d="M5 21a1 1 0 0 0 1-1v-5a2 2 0 0 0-4 0v5a1 1 0 0 0 1 1Z" /><path d="M21 21a1 1 0 0 0 1-1v-5a2 2 0 0 0-4 0v5a1 1 0 0 0 1 1Z" /><path d="M5 18h14" /><path d="M6 21v1M18 21v1" /></Icon>
);
export const TicketIcon = (p) => (
  <Icon {...p}><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M13 5v2M13 17v2M13 11v2" /></Icon>
);
export const PhoneIcon = (p) => (
  <Icon {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" /></Icon>
);
export const MessageIcon = (p) => (
  <Icon {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /><path d="M8 9h8M8 13h5" /></Icon>
);
export const ScanIcon = (p) => (
  <Icon {...p}><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 8v8M10.5 8v8M14 8v8M17 8v8" /></Icon>
);
export const CalendarCheckIcon = (p) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="m9 16 2 2 4-4" /></Icon>
);
export const ClipboardListIcon = (p) => (
  <Icon {...p}><rect x="5" y="4" width="14" height="18" rx="2" /><path d="M9 2h6v4H9z" /><path d="M9 11h6M9 15h6M9 19h3" /></Icon>
);
export const BarChartIcon = (p) => (
  <Icon {...p}><path d="M5 21V13M12 21V7M19 21V3" strokeWidth="3.5" /></Icon>
);
export const KeyIcon = (p) => (
  <Icon {...p}><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></Icon>
);
export const CheckBoldIcon = (p) => (
  <Icon strokeWidth="3" {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>
);
export const InfoIcon = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></Icon>
);
export const SearchIcon = (p) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
);
export const FilterIcon = (p) => (
  <Icon {...p}><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></Icon>
);
export const SettingsIcon = (p) => (
  <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Icon>
);

// Solid glyphs for the coloured status marks (camera, lock, thumbs-up, user): filled shapes read better
// than outlines at 20-24px on a white card, as in the reference design.
const Solid = ({ children, className = 'h-5 w-5', ...props }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className} {...props}>{children}</svg>
);
export const CameraSolidIcon = (p) => (
  <Solid {...p}><path d="M9.2 3.5a1.5 1.5 0 0 0-1.3.8L7.1 6H5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-2.1l-.8-1.7a1.5 1.5 0 0 0-1.3-.8ZM12 9a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2.2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z" fillRule="evenodd" /></Solid>
);
export const LockSolidIcon = (p) => (
  <Solid {...p}><path d="M12 1.8A5.2 5.2 0 0 0 6.8 7v3H6a2.5 2.5 0 0 0-2.5 2.5v7.7A2.5 2.5 0 0 0 6 22.7h12a2.5 2.5 0 0 0 2.5-2.5v-7.7A2.5 2.5 0 0 0 18 10h-.8V7A5.2 5.2 0 0 0 12 1.8ZM9.2 10V7a2.8 2.8 0 0 1 5.6 0v3ZM12 14a1.8 1.8 0 0 1 1 3.3V19h-2v-1.7a1.8 1.8 0 0 1 1-3.3Z" fillRule="evenodd" /></Solid>
);
export const ThumbUpSolidIcon = (p) => (
  <Solid {...p}><path d="M2 10.5A1.5 1.5 0 0 1 3.5 9h2A1.5 1.5 0 0 1 7 10.5v9A1.5 1.5 0 0 1 5.5 21h-2A1.5 1.5 0 0 1 2 19.5ZM9 20.2V10.4a2 2 0 0 1 .3-1l3.5-6a1.6 1.6 0 0 1 2.9 1.2L15 8.5h4.6a2.3 2.3 0 0 1 2.2 2.8l-1.7 7.6a2.8 2.8 0 0 1-2.7 2.1h-7.4a.9.9 0 0 1-1-.8Z" /></Solid>
);
export const UserSolidIcon = (p) => (
  <Solid {...p}><circle cx="12" cy="8" r="4.5" /><path d="M3.5 20.2C4.3 16.3 7.8 14 12 14s7.7 2.3 8.5 6.2a1.3 1.3 0 0 1-1.3 1.6H4.8a1.3 1.3 0 0 1-1.3-1.6Z" /></Solid>
);
export const TrainSolidIcon = (p) => (
  <Solid {...p}><path d="M8 2h8a4 4 0 0 1 4 4v9a3 3 0 0 1-2.2 2.9l1.6 2.6a1 1 0 0 1-1.7 1L16 18H8l-1.7 3.5a1 1 0 0 1-1.7-1l1.6-2.6A3 3 0 0 1 4 15V6a4 4 0 0 1 4-4Zm-1.5 5v4h11V7Zm1.7 6.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm7.6 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z" fillRule="evenodd" /></Solid>
);
export const BarChartSolidIcon = (p) => (
  <Solid {...p}><rect x="3" y="12" width="5" height="10" rx="1.4" /><rect x="9.5" y="7" width="5" height="15" rx="1.4" /><rect x="16" y="2" width="5" height="20" rx="1.4" /></Solid>
);
export const ShieldIcon = (p) => (
  <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></Icon>
);
