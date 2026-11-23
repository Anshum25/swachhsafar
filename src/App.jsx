import { lazy, Suspense, useEffect, useState } from 'react';
import Login from './pages/Login.jsx';
import Download from './pages/Download.jsx';
import DeveloperModeGate from './security/DeveloperModeGate.jsx';
import Layout from './app/Layout.jsx';
import { SessionProvider, useSession } from './app/session.jsx';
import { useRoute } from './app/router.js';
import { resolveRoute } from './app/modules.js';
import { initDatabase } from './database/sqlite.js';
import { recoverAfterStart } from './database/startupRecovery.js';
import { ErrorNote, Loading } from './components/ui.jsx';
import Splash from './components/Splash.jsx';
import Install from './pages/Install.jsx';
import { SecurityBlockScreen, SecurityProvider } from './security/SecurityProvider.jsx';
import { BLOCKS } from './security/messages.js';

const Dashboard = lazy(() => import('./pages/ops/Dashboard.jsx'));
const Journeys = lazy(() => import('./pages/ops/Journeys.jsx'));
const Attendance = lazy(() => import('./pages/ops/Attendance.jsx'));
const Inspections = lazy(() => import('./pages/ops/Inspections.jsx'));
const Feedback = lazy(() => import('./pages/ops/Feedback.jsx'));
const Complaints = lazy(() => import('./pages/ops/Complaints.jsx'));
const Masters = lazy(() => import('./pages/ops/Masters.jsx'));
const Inventory = lazy(() => import('./pages/ops/Inventory.jsx'));
const Reports = lazy(() => import('./pages/ops/Reports.jsx'));
const Jobs = lazy(() => import('./pages/ops/Jobs.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const SecurityStatus = lazy(() => import('./pages/SecurityStatus.jsx'));

// One screen per module key in src/app/modules.js.
const SCREENS = {
  dashboard: Dashboard, journeys: Journeys, attendance: Attendance, inspections: Inspections,
  feedback: Feedback, complaints: Complaints, inventory: Inventory, masters: Masters, jobs: Jobs, reports: Reports, profile: Profile, security: SecurityStatus,
};

function Shell() {
  const session = useSession();
  const { path, parts } = useRoute();
  // A signed-out device starts on Sign in: staff accounts are provisioned by an administrator.
  if (session.status === 'loading') return <Splash />;
  if (session.status === 'signedOut') return <Login />;
  if (session.status === 'error' && BLOCKS[session.meError?.code]) {
    // Session ended, device blocked, or this sign-in predates backend sign-in: explain, then sign in again.
    return <SecurityBlockScreen code={session.meError.code} onSignIn={session.signOut} />;
  }
  if (session.status === 'error') {
    const notProvisioned = session.meError?.status === 401 || session.meError?.status === 403;
    return (
      <div className="mx-auto max-w-md space-y-3 px-4 py-16">
        <ErrorNote error={session.meError} onRetry={session.reload} />
        {notProvisioned && <p className="text-sm text-slate-600">Your sign-in is not linked to an active Swachh Safar employee record. Ask an administrator to check your account.</p>}
        <button type="button" className="btn-secondary" onClick={session.signOut}>Sign out</button>
      </div>
    );
  }

  const route = resolveRoute(parts, session.can, session.modules);
  const Screen = route.allowed ? SCREENS[route.module.key] : null;
  return (
    <SecurityProvider>
      <Layout path={path}>
        <Suspense fallback={<Loading />}>
          {Screen ? <Screen parts={route.rest} /> : <ErrorNote error={{ message: route.module ? routeDeniedMessage(route.module, session) : 'This page does not exist.' }} />}
        </Suspense>
      </Layout>
    </SecurityProvider>
  );
}

// Why a screen the user navigated to is not theirs. Two different answers, and telling them apart is
// the difference between "ask your administrator for the permission" and "your office does not pay for
// this module, and only the Super Admin can change that".
function routeDeniedMessage(module, session) {
  if (module.module && session.modules && !session.modules.includes(module.module)) {
    return `${module.label} is not part of your organisation's subscription. Ask the Super Admin to enable it.`;
  }
  return 'This screen is not available for your role.';
}

// The share link https://<host>/install (or #/install) opens the install page, before any sign-in.
const isInstallPage = () => typeof location !== 'undefined' && (location.pathname.replace(/\/+$/, '') === '/install' || location.hash === '#/install');

// https://<host>/download (or #/download): public Android APK / web app download page.
const isDownloadPage = () => typeof location !== 'undefined' && (location.pathname.replace(/\/+$/, '') === '/download' || location.hash === '#/download');

export default function App() {
  // The Developer-options gate covers every page, so no route of the Android app opens while the setting is
  // on. In a browser it cannot read the setting and renders its children straight away.
  return (
    <DeveloperModeGate>
      {isDownloadPage() ? <Download /> : isInstallPage() ? <Install /> : <OperationsApp />}
    </DeveloperModeGate>
  );
}

function OperationsApp() {
  const [db, setDb] = useState({ status: 'initializing' });
  useEffect(() => {
    initDatabase().then(async ({ db: handle, files }) => {
      // Before any screen can capture or sync: requeue operations a closed/crashed page left 'processing',
      // and remove media files left by a capture whose transaction failed.
      await recoverAfterStart({ db: handle, files });
      setDb({ status: 'ready', handle, files });
    }, (error) => setDb({ status: 'error', error }));
  }, []);

  if (db.status === 'initializing') return <Splash />;
  if (db.status === 'error') {
    return (
      <div className="mx-auto max-w-md space-y-3 px-4 py-16" data-testid="database-error">
        <ErrorNote error={{ message: `This device's local database could not be opened: ${db.error?.message ?? 'unknown error'}. The app needs a secure (HTTPS) connection and browser storage.` }} />
      </div>
    );
  }
  return (
    <SessionProvider db={db.handle} files={db.files}>
      <Shell />
    </SessionProvider>
  );
}
