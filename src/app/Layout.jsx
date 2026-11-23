import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Logo, { RailScene } from '../components/Logo.jsx';
import Toasts, { useToasts } from '../components/Toasts.jsx';
import {
  BarChartIcon, BellIcon, BoxIcon, BriefcaseIcon, CalendarCheckIcon, ClipboardListIcon, DatabaseGridIcon, FlagIcon, HomeIcon, KeyIcon,
  LogoutIcon, MenuIcon, MoreIcon, RefreshIcon, ShieldIcon, Spinner, ThumbUpIcon, TrainIcon, UserIcon, XIcon,
} from '../components/Icons.jsx';
import { useSecurity } from '../security/SecurityProvider.jsx';
import { BLOCKS } from '../security/messages.js';
import { BarSlotContext } from '../components/ui.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import { ROLE_NAMES, useQueueState, useSession } from './session.jsx';
import { MODULES, moduleAllowed } from './modules.js';
import { DEMO_MODE } from '../services/demoApi.js';
import { AppUpdateBanner, BundleUpdateBanner, InstallBanner, UpdateBanner } from '../components/PwaPanels.jsx';
import { requestPersistence } from '../pwa/pwaState.js';
import { BUILD_SHA } from '../pwa/appUpdate.js';
import { MastersSidebar } from '../pages/ops/masters/MastersNav.jsx';

const ToastContext = createContext(() => {});
export const useNotify = () => useContext(ToastContext);

const ICONS = {
  dashboard: HomeIcon, journeys: TrainIcon, attendance: CalendarCheckIcon, inspections: ClipboardListIcon, feedback: ThumbUpIcon,
  complaints: FlagIcon, inventory: BoxIcon, masters: DatabaseGridIcon, jobs: BriefcaseIcon, reports: BarChartIcon, profile: UserIcon,
};
// Short names for the bottom bar and home tiles (reference: Journey, Attendance, Inspection …).
export const SHORT_LABEL = {
  dashboard: 'Home', journeys: 'Journey', attendance: 'Attendance', inspections: 'Inspection', feedback: 'Feedback', complaints: 'Complaints',
  inventory: 'Inventory', masters: 'Masters', jobs: 'Jobs', reports: 'Reports', profile: 'Profile',
};

// Navigation is the module registry (src/app/modules.js) with an icon per module; `menuOnly` entries
// (the profile) are reached from the account section of the menu instead.
export const NAV = MODULES.filter((m) => !m.menuOnly).map((m) => ({ ...m, Icon: ICONS[m.key] }));
export const MODULE_ICONS = ICONS;
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
// Every APK so far carries the same version name, so the version alone cannot say which build is
// installed -- and "the app still offers an update after I installed it" is exactly the question that
// needs answering. The build id is the commit the bundle was made from; it is what the update check
// compares, and what /downloads/latest.json publishes, so the two can be read against each other.
const BUILD_ID = BUILD_SHA ? BUILD_SHA.slice(0, 7) : '';

// `modules`: the client's subscription (me.client.modules), or null for no gating. See src/app/modules.js.
export const visibleNav = (can, modules = null) => NAV.filter((n) => moduleAllowed(n, modules) && (!n.any.length || n.any.some(can)));
const isOn = (p, path) => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`));

function QueueIndicator() {
  const q = useQueueState();
  const { queue } = useSession();
  // Records captured by another user of this device sync only when that user signs in again.
  const others = q.othersPending ? <span className="text-xs text-muted" data-testid="ops-queue-others"> · {q.othersPending} waiting for another user</span> : null;
  if (!q.pending && !q.failed.length) {
    return (
      <span className="truncate text-xs font-medium text-muted" title="All records synced">
        <span className="min-[400px]:hidden">Synced</span><span className="hidden min-[400px]:inline">All records synced</span>{others}
      </span>
    );
  }
  return (
    <button type="button" onClick={() => (q.failed.length ? queue.retryFailed() : queue.flush())}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${q.failed.length ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-50 text-amber-800 ring-amber-200'}`}
      title={q.failed[0]?.last_error ?? q.lastError ?? 'Tap to sync now'} data-testid="ops-queue">
      {q.running ? <Spinner className="h-3 w-3" /> : <RefreshIcon className="h-3 w-3" />}
      {q.pending ? `${q.pending} pending` : ''}{q.pending && q.failed.length ? ' · ' : ''}{q.failed.length ? `${q.failed.length} failed` : ''}
    </button>
  );
}

// Browser connectivity is not server connectivity: "Online" only when the last exchange with the server
// worked; a failed pull while the network is up shows as a server problem.
const SHORT_STATUS = { 'Server unreachable': 'No server', 'Records refused': 'Refused', 'Sign in again': 'Sign in', 'Syncing\u2026': 'Syncing' };

export const SIGN_IN_AGAIN = 'This device is no longer signed in to the server, so nothing can be sent. '
  + 'Sign out and sign in again; the records saved here are kept and will go as soon as you do.';

// Which of the four states the app is in, and the sentence that explains it. Pure, so it can be tested
// without rendering: this classification was wrong once in a way that cost real debugging time.
//
// The distinction that matters is between the server not answering and the server answering to refuse a
// record. Both used to read "Server unreachable", which is a lie in the second case and sends everyone
// hunting for a network fault that is not there -- while the one thing that would help, the reason the
// record was refused, sat in a `title` tooltip that a phone never shows. A refusal now says so and
// carries its reason in the text, which the sync panel displays.
export function connectionStatus(q, online) {
  if (!online) return ['amber', 'Offline', 'No network. Records are saved on this device.'];
  if (q.running || q.pulling) return ['sky', 'Syncing\u2026', 'Exchanging records with the server'];
  // Nothing can be sent without a sign-in, and no amount of tapping Sync will change that. Said before
  // anything else, because it is the only one of these the person can actually act on.
  if (q.authRequired) return ['red', 'Sign in again', SIGN_IN_AGAIN];
  if (q.failed?.length) {
    const reason = q.failed[0]?.last_error;
    const n = q.failed.length;
    return ['red', 'Records refused',
      `The server refused ${n} record${n === 1 ? '' : 's'}${reason ? `: ${reason}` : '.'}`];
  }
  if (q.pullError || (q.lastError && q.pending)) {
    return ['red', 'Server unreachable', q.pullError ?? q.lastError];
  }
  return ['emerald', 'Online', q.lastPullAt ? 'Connected to the server' : 'Network available'];
}

function useConnection(online) {
  return connectionStatus(useQueueState(), online);
}

function ConnectionIndicator({ online }) {
  const [tone, text, title] = useConnection(online);
  const dot = { amber: 'bg-amber-500', sky: 'bg-sky-500', red: 'bg-red-500', emerald: 'bg-success' }[tone];
  const color = { amber: 'text-amber-700', sky: 'text-sky-700', red: 'text-red-700', emerald: 'text-emerald-700' }[tone];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-semibold ${color}`} title={title} role="status" data-testid="connection-status">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-[400px]:hidden">{SHORT_STATUS[text] ?? text}</span><span className="hidden min-[400px]:inline">{text}</span>
    </span>
  );
}

// The bell: this device's notices are its sync state. The red dot shows records waiting or refused; the
// panel says where things stand and syncs now.
function SyncBell({ online }) {
  const q = useQueueState();
  const { queue } = useSession();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const [, text, title] = useConnection(online);
  const alert = q.failed.length > 0 || q.pending > 0;
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <button type="button" className="icon-btn relative" onClick={() => setOpen((v) => !v)} aria-label={alert ? 'Sync notifications (attention)' : 'Sync notifications'} aria-expanded={open}>
        <BellIcon className="h-6 w-6" />
        {alert && <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-30 w-72 animate-modal-in rounded-2xl bg-white p-4 text-left shadow-raised ring-1 ring-line" role="dialog" aria-label="Sync status">
          <p className="text-sm font-bold text-ink">{text}</p>
          <p className="mt-0.5 text-xs text-muted">{title}</p>
          <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <p className="flex justify-between"><span className="text-muted">Waiting to sync</span><b className="tabular-nums">{q.pending}</b></p>
            <p className="flex justify-between"><span className="text-muted">Refused by server</span><b className={`tabular-nums ${q.failed.length ? 'text-red-600' : ''}`}>{q.failed.length}</b></p>
            {q.failed[0]?.last_error && <p className="text-xs text-red-700">{q.failed[0].last_error}</p>}
          </div>
          <button type="button" className="btn-secondary mt-3 w-full" disabled={!online || q.running}
            onClick={() => (q.failed.length ? queue.retryFailed() : queue.flush())}>
            {q.running ? <Spinner /> : <RefreshIcon />} {q.failed.length ? 'Retry refused records' : 'Sync now'}
          </button>
        </div>
      )}
    </div>
  );
}

// Menu row: blue line icon, bold navy label, full-width target; the current screen on pale blue.
function MenuRow({ href, onClick, Icon, label, on, tone }) {
  const cls = `flex min-h-12 w-full items-center gap-3.5 rounded-xl px-3.5 text-left text-[15px] font-semibold transition duration-150 active:scale-[0.99] ${
    on ? 'bg-brand-100 text-brand-900' : tone === 'danger' ? 'text-ink hover:bg-red-50 hover:text-red-700' : 'text-ink hover:bg-brand-50'}`;
  const body = <><Icon className={`h-5 w-5 shrink-0 ${tone === 'danger' ? '' : 'text-brand-700'}`} /><span className="min-w-0 flex-1 truncate">{label}</span></>;
  return href ? <a href={href} onClick={onClick} className={cls} aria-current={on ? 'page' : undefined}>{body}</a>
    : <button type="button" onClick={onClick} className={cls}>{body}</button>;
}

function MenuContent({ path, onPick, showBrand = true }) {
  const { user, can, modules, signOut } = useSession();
  const items = visibleNav(can, modules).filter((m) => m.key !== 'dashboard');
  return (
    <div className="flex h-full min-h-0 flex-col">
      {showBrand && (
        <div className="flex flex-col items-center pb-4 pt-1">
          <Logo className="h-14 w-14" />
          <p className="mt-1 text-xl font-extrabold tracking-tight text-brand-700">Swachh Safar</p>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        <div className="mb-3 flex items-center gap-3 rounded-2xl bg-canvas px-3 py-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-700 text-white"><UserIcon className="h-4.5 w-4.5" /></span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-ink">{user.name}</p>
            <p className="truncate text-xs text-muted">{ROLE_NAMES[user.role_id]} · {user.emp_id}</p>
          </div>
        </div>
        <nav className="divide-y divide-line/80" aria-label="Account">
          <div className="py-1"><MenuRow href="#/profile" onClick={onPick} Icon={UserIcon} label="User Profile" on={path === '/profile'} /></div>
          <div className="py-1"><MenuRow href="#/profile/password" onClick={onPick} Icon={KeyIcon} label="Change Password" on={path === '/profile/password'} /></div>
          <div className="py-1"><MenuRow href="#/security" onClick={onPick} Icon={ShieldIcon} label="Security Status" on={path === '/security'} /></div>
          <div className="py-1"><MenuRow onClick={signOut} Icon={LogoutIcon} label="Logout" tone="danger" /></div>
        </nav>
        <p className="mb-1 mt-4 px-3.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Modules</p>
        <nav className="space-y-0.5 pb-3" aria-label="Modules">
          <MenuRow href="#/" onClick={onPick} Icon={HomeIcon} label="Home" on={path === '/'} />
          {items.map((m) => <MenuRow key={m.key} href={`#${m.path}`} onClick={onPick} Icon={m.Icon} label={m.label} on={isOn(m.path, path)} />)}
        </nav>
      </div>
      <div className="shrink-0">
        <RailScene compact className="block h-auto w-full" />
        <p className="bg-[#c6dcfa] pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-xs font-medium text-brand-900" data-testid="app-version">
          App Version: {APP_VERSION}{BUILD_ID ? ` · ${BUILD_ID}` : ''}
        </p>
      </div>
    </div>
  );
}

// Slide-in menu (phones and tablets): 82% of the width, the rest dimmed; closes on X, outside tap or Esc.
function Drawer({ open, onClose, path }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <div className={`fixed inset-0 z-40 transition-[visibility] duration-300 lg:hidden ${open ? 'visible' : 'invisible'}`} aria-hidden={!open}>
      <div className={`absolute inset-0 bg-brand-950/45 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} />
      <aside className={`absolute inset-y-0 left-0 flex w-[82vw] max-w-[21rem] flex-col bg-white pt-[env(safe-area-inset-top)] shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${open ? 'translate-x-0' : '-translate-x-full'}`}
        aria-label="Menu">
        <button type="button" className="icon-btn absolute right-2 top-[calc(0.5rem+env(safe-area-inset-top))] z-10 text-ink" onClick={onClose} aria-label="Close menu" tabIndex={open ? 0 : -1}>
          <XIcon className="h-6 w-6" />
        </button>
        <div className="min-h-0 flex-1 pt-4"><MenuContent path={path} onPick={onClose} /></div>
      </aside>
    </div>
  );
}

// Location-dependent actions are blocked: say so on every screen, linking to the status page.
function SecurityBanner({ path }) {
  const sec = useSecurity();
  if (!sec || path === '/security' || sec.startup === 'checking') return null;
  const d = sec.decide('location');
  const code = d.blockers.find((c) => c !== 'location_pending');
  if (!code) return null;
  return (
    <a href="#/security" className="flex items-center gap-2 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800 sm:px-6" role="alert" data-testid="security-banner">
      <ShieldIcon className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{BLOCKS[code]?.title}: attendance, inspection and feedback are paused.</span><span className="underline">Fix</span>
    </a>
  );
}

// Literal class names so Tailwind generates them (bottom bar: up to 3 screens + More).
const NAV_COLS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' };

export default function Layout({ path, children }) {
  const { can, me, modules } = useSession();
  const online = useNetworkStatus();
  // The SQLite database lives in OPFS: ask the browser not to evict it once a user works on this device.
  useEffect(() => {
    requestPersistence().catch(() => {});
  }, []);
  const { toasts, notify, dismiss } = useToasts();
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState(null);
  const items = visibleNav(can, modules);
  // Bottom bar (phones/tablets): Home + the first two other screens the user has, then More (the menu).
  const bottom = [items[0], ...items.slice(1, 3)].filter(Boolean);
  const close = () => setOpen(false);
  // Any navigation (a menu link, the browser/Android back button) closes the menu.
  useEffect(() => setOpen(false), [path]);
  const home = path === '/';
  const masters = isOn('/masters', path);

  return (
    <ToastContext.Provider value={notify}>
      <BarSlotContext.Provider value={slot}>
        <div className="min-h-dvh bg-canvas">
          <aside className="fixed inset-y-0 left-0 hidden w-68 flex-col border-r border-line bg-white pt-5 lg:flex">
            <a href="#/" className="mb-4 flex items-center gap-3 px-5" aria-label="Swachh Safar home">
              <Logo className="h-11 w-11" />
              <span><span className="block text-lg font-extrabold leading-tight text-brand-700">Swachh Safar</span>
                <span className="block text-xs text-muted">Railway Inspection &amp; Monitoring</span></span>
            </a>
            <div className="min-h-0 flex-1"><MenuContent path={path} onPick={undefined} showBrand={false} /></div>
          </aside>
          <Drawer open={open} onClose={close} path={path} />
          {/* Master Data has a second sidebar next to this one (desktop only); the content column makes room for it. */}
          {masters && <MastersSidebar path={path} />}
          <div className={masters ? 'lg:pl-132' : 'lg:pl-68'}>
            <header className="sticky top-0 z-20 bg-white pt-[env(safe-area-inset-top)] shadow-bar">
              <div className={home ? '' : 'hidden'}>
                {/* Home: menu · centred brand · bell (reference home screen). */}
                <div className="grid min-h-14 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center px-1.5 sm:px-3" data-testid={home ? 'topbar-main' : undefined}>
                  <button type="button" className="icon-btn lg:invisible" onClick={() => setOpen(true)} aria-label="Open menu">
                    <MenuIcon className="h-6 w-6" />
                  </button>
                  <a href="#/" className="flex min-w-0 items-center justify-center gap-2" aria-label="Swachh Safar home">
                    <TrainIcon className="h-6 w-6 shrink-0 text-brand-700" />
                    <span className="truncate text-xl font-extrabold tracking-tight text-brand-700">Swachh Safar</span>
                  </a>
                  <SyncBell online={online} />
                </div>
              </div>
              {/* Inner screens: their PageHeader renders the back arrow and title here. */}
              <div ref={setSlot} className={home ? 'hidden' : ''} />
              {/* Sync status: records are captured offline, so where they stand is always visible. */}
              <div className="flex min-h-7 items-center justify-between gap-3 border-t border-line/70 bg-brand-50 px-4 py-1 sm:px-6" data-testid="topbar-status">
                <QueueIndicator />
                <ConnectionIndicator online={online} />
              </div>
            </header>
            {DEMO_MODE && (
              <p className="bg-fuchsia-700 px-4 py-2 text-center text-xs font-semibold text-white sm:px-6" role="status" data-testid="demo-banner">
                DEMO MODE — sample data only, not real operational records. Changes are not sent to any server.
              </p>
            )}
            <UpdateBanner />
            <BundleUpdateBanner />
            <AppUpdateBanner />
            <InstallBanner />
            {me.offline && <p className="bg-amber-50 px-4 py-2 text-xs text-amber-900 sm:px-6">Signed in offline with your cached profile. Permissions will refresh when you reconnect.</p>}
            <SecurityBanner path={path} />
            <main className="mx-auto max-w-6xl animate-rise-in px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 lg:pb-10 lg:pt-6" key={path.split('/')[1] ?? ''}>{children}</main>
            <nav className={`fixed inset-x-0 bottom-0 z-20 grid ${NAV_COLS[bottom.length + 1]} border-t border-line bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(17,29,53,0.05)] lg:hidden`} aria-label="Main">
              {bottom.map(({ path: p, key, Icon }) => {
                const on = isOn(p, path);
                return (
                  <a key={p} href={`#${p}`} aria-current={on ? 'page' : undefined}
                    className={`relative flex min-h-[3.75rem] min-w-0 flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold transition-colors duration-200 ${on ? 'text-brand-700' : 'text-slate-500'}`}>
                    <span className={`absolute top-0 h-[3px] w-8 rounded-b-full bg-brand-700 transition-opacity duration-200 ${on ? 'opacity-100' : 'opacity-0'}`} />
                    <Icon className="h-[22px] w-[22px]" /> <span className="truncate">{SHORT_LABEL[key]}</span>
                  </a>
                );
              })}
              <button type="button" onClick={() => setOpen(true)} className="flex min-h-[3.75rem] min-w-0 flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold text-slate-500">
                <MoreIcon className="h-[22px] w-[22px]" /> <span>More</span>
              </button>
            </nav>
          </div>
          <Toasts toasts={toasts} onDismiss={dismiss} />
        </div>
      </BarSlotContext.Provider>
    </ToastContext.Provider>
  );
}
