import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerServiceWorker } from './pwa/registerServiceWorker.js';
import { captureInstallEvents } from './pwa/pwaState.js';
import { markBundleHealthy } from './pwa/bundleUpdate.js';
import './index.css';

captureInstallEvents();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();

// An over-the-air bundle is on probation until it says it started: the updater reverts to the previous one
// on the next launch otherwise, so a release that white-screens undoes itself without anyone intervening.
// It belongs here, after render() rather than at the top of the file, because reaching this line is the
// thing being attested -- and nowhere earlier, or a bundle that crashes on mount would mark itself healthy
// on the way down. Does nothing in a browser or on an APK without the updater plugin.
markBundleHealthy();
