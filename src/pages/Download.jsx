// Public download page: https://<host>/download (or #/download). No sign-in, no database, no browser-specific
// install APIs: the APK is a plain HTTPS link to a file nginx serves as application/vnd.android.package-archive
// with Content-Disposition: attachment, so every Android browser downloads it the same way.
// Release details come from /downloads/latest.json, written by deploy/scripts/publish-apk.sh.
import { useEffect, useState } from 'react';
import Logo from '../components/Logo.jsx';
import { installInstructions } from '../pwa/pwaState.js';

const ANDROID_VERSIONS = { 24: '7.0', 26: '8.0', 28: '9', 29: '10', 30: '11', 31: '12', 33: '13', 34: '14' };
const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);
export const platformOf = (agent = ua()) =>
  /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
    ? 'ios' : /Android/i.test(agent) ? 'android' : 'desktop';

const mb = (n) => `${(n / 1_048_576).toFixed(1)} MB`;

export default function Download() {
  const [release, setRelease] = useState({ status: 'loading' });
  const platform = platformOf();

  useEffect(() => {
    fetch('/downloads/latest.json', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (r) => {
        const type = r.headers.get('content-type') ?? '';
        if (!r.ok || !type.includes('json')) return setRelease({ status: 'none' });
        setRelease({ status: 'ready', ...(await r.json()) });
      })
      .catch(() => setRelease({ status: 'error' }));
  }, []);

  return (
    <div className="min-h-dvh bg-[#f0f6ff] px-4 pb-16 pt-10">
      <div className="mx-auto w-full max-w-md space-y-5">
        <div className="flex flex-col items-center text-center">
          <Logo className="h-16 w-16" />
          <p className="mt-1 text-2xl font-black tracking-tight text-brand-700">SWACHH SAFAR</p>
          <h1 className="mt-1 text-xl font-bold text-ink">Download the app</h1>
        </div>

        {/* 1. Android APK */}
        <section className="space-y-3 rounded-3xl bg-white p-5 shadow-raised ring-1 ring-slate-100" aria-labelledby="apk-h">
          <h2 id="apk-h" className="text-base font-bold text-ink">Android app (APK)</h2>
          {platform === 'ios' ? (
            <p className="text-sm text-slate-600">The Android app cannot be installed on iPhone or iPad. Use the web app below.</p>
          ) : release.status === 'loading' ? (
            <p className="text-sm text-slate-500">Checking the latest release…</p>
          ) : release.status === 'ready' ? (
            <>
              <a href={release.latest_url ?? release.url} className="btn-primary flex h-12 w-full items-center justify-center text-base font-bold" data-testid="download-apk">
                Download Android APK
              </a>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-slate-500">Version</dt><dd className="font-semibold text-ink">{release.version_name} ({release.version_code})</dd>
                <dt className="text-slate-500">Size</dt><dd className="text-ink">{mb(release.size_bytes)}</dd>
                <dt className="text-slate-500">Released</dt><dd className="text-ink">{new Date(release.released_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</dd>
                <dt className="text-slate-500">Needs</dt><dd className="text-ink">Android {ANDROID_VERSIONS[release.min_sdk] ?? `API ${release.min_sdk}`} or newer</dd>
                <dt className="text-slate-500">SHA-256</dt><dd className="break-all font-mono text-[11px] text-slate-700" data-testid="apk-sha256">{release.sha256}</dd>
              </dl>
              <details className="text-sm text-slate-700">
                <summary className="cursor-pointer font-semibold text-brand-700">How to install</summary>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5">
                  <li>Tap <b>Download Android APK</b>. Works in Chrome, Samsung Internet, Edge, Firefox and Opera.</li>
                  <li>Open the downloaded file from the notification or your <b>Downloads</b> folder.</li>
                  <li>If Android asks, allow <b>Install unknown apps</b> for <i>this browser only</i>. This is Android&apos;s normal protection for apps not from the Play Store; do not turn off other security settings.</li>
                  <li>Tap <b>Install</b>, then open Swachh Safar and sign in.</li>
                </ol>
                <p className="mt-2 text-xs text-slate-500">Updating: install the newer APK over the old one. Records saved on the phone are kept. The file can also be shared on WhatsApp.</p>
              </details>
            </>
          ) : (
            <p className="text-sm text-slate-600" data-testid="apk-unavailable">
              {release.status === 'none'
                ? 'The Android app has not been published yet. Use the web app below in the meantime.'
                : 'Could not check for the Android app. Check your connection and reload.'}
            </p>
          )}
        </section>

        {/* 2. Web app, 3. Add to home screen */}
        <section className="space-y-3 rounded-3xl bg-white p-5 shadow-raised ring-1 ring-slate-100" aria-labelledby="web-h">
          <h2 id="web-h" className="text-base font-bold text-ink">Web app</h2>
          <p className="text-sm text-slate-600">Runs in the browser on any phone or computer, and works offline after the first sign-in.</p>
          <a href="/#/login" className="flex h-11 w-full items-center justify-center rounded-2xl border-2 border-brand-600 bg-white text-sm font-semibold text-brand-700">Open Web App</a>
          <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">
            <p className="font-semibold text-ink">{platform === 'ios' ? 'Add to Home Screen (iPhone / iPad)' : 'Install the web app'}</p>
            <p className="mt-1">
              {platform === 'ios'
                ? 'Open this page in Safari, tap the Share button, then Add to Home Screen.'
                : platform === 'desktop'
                  ? 'In Chrome or Edge, use the install icon in the address bar. Other browsers can simply bookmark the web app.'
                  : installInstructions()}
            </p>
            {platform !== 'ios' && <a href="/install" className="mt-1 inline-block text-xs font-semibold text-brand-700 underline">Guided install</a>}
          </div>
        </section>
      </div>
    </div>
  );
}
