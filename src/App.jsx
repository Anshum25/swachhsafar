import { lazy, Suspense, useEffect, useState } from 'react';
import Register from './pages/Register.jsx';
import Login from './pages/Login.jsx';
import Layout from './app/Layout.jsx';
import { SessionProvider, useSession } from './app/session.jsx';
import { useRoute } from './app/router.js';
import { resolveRoute } from './app/modules.js';
import { initDatabase } from './database/sqlite.js';
import { recoverAfterStart } from './database/startupRecovery.js';
import { ErrorNote, Loading } from './components/ui.jsx';
import Splash from './components/Splash.jsx';
import Install from './pages/Install.jsx';

const Dashboard = lazy(() => import('./pages/ops/Dashboard.jsx'));
const Journeys = lazy(() => import('./pages/ops/Journeys.jsx'));
const Attendance = lazy(() => import('./pages/ops/Attendance.jsx'));
const Inspections = lazy(() => import('./pages/ops/Inspections.jsx'));
const Feedback = lazy(() => import('./pages/ops/Feedback.jsx'));
const Complaints = lazy(() => import('./pages/ops/Complaints.jsx'));
const Masters = lazy(() => import('./pages/ops/Masters.jsx'));
const Inventory = lazy(() => import('./pages/ops/Inventory.jsx'));
const Reports = lazy(() => import('./pages/ops/Reports.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));

// One screen per module key in src/app/modules.js.
const SCREENS = {
  dashboard: Dashboard, journeys: Journeys, attendance: Attendance, inspections: Inspections,
  feedback: Feedback, complaints: Complaints, inventory: Inventory, masters: Masters, reports: Reports, profile: Profile,
};

function Shell() {
  const session = useSession();
  const { path, parts } = useRoute();
  // A signed-out device starts on Sign in: staff accounts are provisioned by an administrator, and the
  // installed app opens at "/". Registration (Phase 1) is opened from the "Register" link (#/register) and
  // stays on screen even after its sync signs the new account in to Firebase, until the user navigates away.
  const [registering, setRegistering] = useState(null);

  useEffect(() => {
    if (registering === null && session.status !== 'loading') setRegistering(path === '/register');
  }, [registering, session.status, path]);
  useEffect(() => {
    if (path === '/register') setRegistering(true);
    else if (path !== '/') setRegistering(false);
  }, [path]);

  if (path === '/register' || registering) return <Register />;
  if (session.status === 'loading' || registering === null) return <Splash />;
  if (session.status === 'signedOut') return <Login />;
  if (session.status === 'error') {
    const notProvisioned = session.meError?.status === 401 || session.meError?.status === 403;
    return (
      <div className="mx-auto max-w-md space-y-3 px-4 py-16">
        <ErrorNote error={session.meError} onRetry={session.reload} />
        {notProvisioned && <p className="text-sm text-slate-600">Your Firebase account is signed in but is not linked to an active Swachh Safar employee record. Ask an administrator to link it.</p>}
        <button type="button" className="btn-secondary" onClick={session.signOut}>Sign out</button>
      </div>
    );
  }

  const route = resolveRoute(parts, session.can);
  const Screen = route.allowed ? SCREENS[route.module.key] : null;
  return (
    <Layout path={path}>
      <Suspense fallback={<Loading />}>
        {Screen ? <Screen parts={route.rest} /> : <ErrorNote error={{ message: route.module ? 'This screen is not available for your role.' : 'This page does not exist.' }} />}
      </Suspense>
    </Layout>
  );
}

// The share link https://<host>/install (or #/install) opens the install page, before any sign-in.
const isInstallPage = () => typeof location !== 'undefined' && (location.pathname.replace(/\/+$/, '') === '/install' || location.hash === '#/install');

export default function App() {
  return isInstallPage() ? <Install /> : <OperationsApp />;
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
  if (db.status === 'error') return <Register />; // Register reports the database failure itself.
  return (
    <SessionProvider db={db.handle} files={db.files}>
      <Shell />
    </SessionProvider>
  );
}
