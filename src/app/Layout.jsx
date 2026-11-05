import { createContext, useContext, useEffect, useState } from 'react';
import Logo, { TrainArt } from '../components/Logo.jsx';
import Toasts, { useToasts } from '../components/Toasts.jsx';
import {
  BoxIcon, ChartIcon, ClipboardIcon, DatabaseGridIcon, FlagIcon, HomeIcon, LockIcon, LogoutIcon, MenuIcon, MoreIcon,
  RefreshIcon, Spinner, ThumbUpIcon, TrainIcon, UserIcon, UsersIcon, XIcon,
} from '../components/Icons.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import { ROLE_NAMES, useQueueState, useSession } from './session.jsx';
import { MODULES } from './modules.js';
import { DEMO_MODE } from '../services/demoApi.js';
import { InstallBanner, UpdateBanner } from '../components/PwaPanels.jsx';
import { requestPersistence } from '../pwa/pwaState.js';

const ToastContext = createContext(() => {});
export const useNotify = () => useContext(ToastContext);

const ICONS = {
  dashboard: HomeIcon, journeys: TrainIcon, attendance: UsersIcon, inspections: ClipboardIcon, feedback: ThumbUpIcon,
  complaints: FlagIcon, inventory: BoxIcon, masters: DatabaseGridIcon, reports: ChartIcon, profile: UserIcon,
};

// Navigation is the module registry (src/app/modules.js) with an icon per module; `menuOnly` entries
// (the profile) are reached from the account section of the menu instead.
export const NAV = MODULES.filter((m) => !m.menuOnly).map((m) => ({ ...m, Icon: ICONS[m.key] }));
export const MODULE_ICONS = ICONS;
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const visibleNav = (can) => NAV.filter((n) => !n.any.length || n.any.some(can));

function NavList({ items, active, onPick }) {
  return (
    <nav className="space-y-1">
      {items.map(({ path, label, Icon }) => {
        const on = path === '/' ? active === '/' : active.startsWith(path);
        return (
          <a key={path} href={`#${path}`} onClick={onPick}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${on ? 'bg-brand-100 text-brand-800' : 'text-slate-600 hover:bg-brand-50 hover:text-brand-800'}`}>
            <Icon className="h-5 w-5" /> {label}
          </a>
        );
      })}
    </nav>
  );
}

function QueueIndicator() {
  const q = useQueueState();
  const { queue } = useSession();
  // Records captured by another user of this device sync only when that user signs in again.
  const others = q.othersPending ? <span className="text-xs text-slate-500" data-testid="ops-queue-others"> · {q.othersPending} waiting for another user</span> : null;
  if (!q.pending && !q.failed.length) {
    return (
      <span className="truncate text-xs text-slate-500" title="All records synced">
        <span className="min-[400px]:hidden">Synced</span><span className="hidden min-[400px]:inline">All records synced</span>{others}
      </span>
    );
  }
  return (
    <button type="button" onClick={() => (q.failed.length ? queue.retryFailed() : queue.flush())}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${q.failed.length ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-50 text-amber-800 ring-amber-200'}`}
      title={q.lastError ?? 'Tap to sync now'} data-testid="ops-queue">
      {q.running ? <Spinner className="h-3 w-3" /> : <RefreshIcon className="h-3 w-3" />}
      {q.pending ? `${q.pending} pending` : ''}{q.pending && q.failed.length ? ' · ' : ''}{q.failed.length ? `${q.failed.length} failed` : ''}
    </button>
  );
}

// Browser connectivity is not server connectivity: "Online" only when the last exchange with the server
// worked; a failed pull while the network is up shows as a server problem.
const SHORT_STATUS = { 'Server unreachable': 'No server', 'Syncing…': 'Syncing' };

// Literal class names so Tailwind generates them (bottom bar: up to 3 screens + More).
const NAV_COLS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' };

function ConnectionIndicator({ online }) {
  const q = useQueueState();
  const [tone, text, title] = !online ? ['amber', 'Offline', 'No network. Records are saved on this device.']
    : q.running || q.pulling ? ['sky', 'Syncing…', 'Exchanging records with the server']
      : q.pullError || (q.lastError && q.pending) ? ['red', 'Server unreachable', q.pullError ?? q.lastError]
        : ['emerald', 'Online', q.lastPullAt ? 'Connected to the server' : 'Network available'];
  const dot = { amber: 'bg-amber-500', sky: 'bg-sky-500', red: 'bg-red-500', emerald: 'bg-emerald-500' }[tone];
  const color = { amber: 'text-amber-700', sky: 'text-sky-700', red: 'text-red-700', emerald: 'text-emerald-700' }[tone];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium ${color}`} title={title} role="status" data-testid="connection-status">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-[400px]:hidden">{SHORT_STATUS[text] ?? text}</span><span className="hidden min-[400px]:inline">{text}</span>
    </span>
  );
}

export default function Layout({ path, children }) {
  const { user, can, signOut, me } = useSession();
  const online = useNetworkStatus();
  // The SQLite database lives in OPFS: ask the browser not to evict it once a user works on this device.
  useEffect(() => {
    requestPersistence().catch(() => {});
  }, []);
  const { toasts, notify, dismiss } = useToasts();
  const [open, setOpen] = useState(false);
  const items = visibleNav(can);
  // Bottom bar (phones/tablets): Home + the first two other screens the user has, then More (the menu).
  const bottom = [items[0], ...items.slice(1, 3)].filter(Boolean);
  const close = () => setOpen(false);

  const account = [
    { href: '#/profile', label: 'User Profile', Icon: UserIcon, on: path === '/profile' },
    { href: '#/profile/password', label: 'Change Password', Icon: LockIcon, on: path === '/profile/password' },
  ];
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-2 pb-5">
        <Logo className="h-10 w-10" />
        <div>
          <p className="text-base font-extrabold text-brand-800">Swachh Safar</p>
          <p className="text-xs text-slate-500">Railway Inspection &amp; Monitoring</p>
        </div>
      </div>
      <div className="mb-4 flex items-center gap-3 rounded-2xl bg-brand-50 p-3 ring-1 ring-brand-100">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-700 text-white"><UserIcon className="h-5 w-5" /></span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
          <p className="truncate text-xs text-slate-500">{ROLE_NAMES[user.role_id]} · {user.emp_id}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavList items={items} active={path} onPick={close} />
        <div className="mt-4 space-y-1 border-t border-slate-100 pt-4">
          {account.map(({ href, label, Icon, on }) => (
            <a key={href} href={href} onClick={close}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${on ? 'bg-brand-100 text-brand-800' : 'text-slate-600 hover:bg-brand-50 hover:text-brand-800'}`}>
              <Icon className="h-5 w-5" /> {label}
            </a>
          ))}
          <button type="button" onClick={signOut}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-red-50 hover:text-red-700">
            <LogoutIcon className="h-5 w-5" /> Logout
          </button>
        </div>
      </div>
      <div className="pt-3 text-center">
        <TrainArt className="mx-auto h-14 w-auto opacity-80" />
        <p className="mt-1 text-xs text-slate-400">App Version {APP_VERSION}</p>
      </div>
    </div>
  );

  return (
    <ToastContext.Provider value={notify}>
      <div className="min-h-dvh bg-canvas">
        <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-4 lg:block">{sidebar}</aside>
        {open && (
          <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={close}>
            <aside className="flex h-full w-72 max-w-[85vw] flex-col bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="mb-1 ml-auto block rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" onClick={close} aria-label="Close menu"><XIcon className="h-5 w-5" /></button>
              <div className="min-h-0 flex-1">{sidebar}</div>
            </aside>
          </div>
        )}
        <div className="lg:pl-64">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur">
            {/* Phones/tablets: menu · centred brand (the sidebar carries the brand on desktop). */}
            <div className="grid min-h-14 grid-cols-[2.5rem_1fr_2.5rem] items-center px-2 sm:px-4 lg:hidden" data-testid="topbar-main">
              <button type="button" className="grid h-10 w-10 place-items-center rounded-xl text-brand-800 hover:bg-brand-50" onClick={() => setOpen(true)} aria-label="Open menu">
                <MenuIcon className="h-6 w-6" />
              </button>
              <a href="#/" className="flex min-w-0 items-center justify-center gap-2" aria-label="Swachh Safar home">
                <Logo className="h-8 w-8 shrink-0" />
                <span className="truncate text-lg font-extrabold tracking-tight text-brand-800">Swachh Safar</span>
              </a>
              <span aria-hidden="true" />
            </div>
            {/* Sync status: a slim strip under the bar on phones, the right side of the bar on desktop. */}
            <div className="flex min-h-8 items-center justify-between gap-3 border-t border-slate-100 bg-brand-50/50 px-4 py-1 sm:px-6 lg:min-h-14 lg:justify-end lg:border-0 lg:bg-transparent" data-testid="topbar-status">
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
          <InstallBanner />
          {me.offline && <p className="bg-amber-50 px-4 py-2 text-xs text-amber-900 sm:px-6">Signed in offline with your cached profile. Permissions will refresh when you reconnect.</p>}
          <main className="mx-auto max-w-6xl px-4 py-5 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-6 lg:pb-8">{children}</main>
          <nav className={`fixed inset-x-0 bottom-0 z-20 grid ${NAV_COLS[bottom.length + 1]} border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(15,23,42,0.06)] lg:hidden`}>
            {bottom.map(({ path: p, label, Icon }) => {
              const on = p === '/' ? path === '/' : path.startsWith(p);
              return (
                <a key={p} href={`#${p}`} className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold ${on ? 'text-brand-700' : 'text-slate-500'}`}>
                  <Icon className="h-5 w-5" /> <span className="truncate">{p === '/' ? 'Home' : label.split(' ')[0]}</span>
                </a>
              );
            })}
            <button type="button" onClick={() => setOpen(true)} className="flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold text-slate-500">
              <MoreIcon className="h-5 w-5" /> <span>More</span>
            </button>
          </nav>
        </div>
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    </ToastContext.Provider>
  );
}
