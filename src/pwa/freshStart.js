// When may the app swap itself for a new version without asking anyone?
//
// Updates apply by themselves, with no button: when the app has just been opened and nobody has started
// using it yet, the new version loads at once; otherwise it waits for the next time the app is opened. "Opened"
// also covers coming back to the app after it sat in the background for a long time, because a phone app is
// mostly resumed rather than relaunched. Never while a dialog (a capture, a form) is open on screen.
//
// Records are safe either way: they live in SQLite/OPFS, which an update never touches.
const LONG_AWAY_MS = 30 * 60 * 1000;

let touched = false;      // the user has tapped or typed since the app was (re)opened
let hiddenAt = null;
let installed = false;

export function watchFreshStart(win = globalThis) {
  if (installed || !win?.addEventListener) return;
  installed = true;
  const touch = () => { touched = true; };
  win.addEventListener('pointerdown', touch, { capture: true, passive: true });
  win.addEventListener('keydown', touch, { capture: true });
  win.document?.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt != null && Date.now() - hiddenAt >= LONG_AWAY_MS) {
      touched = false;            // back after a long time away: as good as a fresh open
      hiddenAt = null;
    }
  });
}

// True when swapping in a new version now cannot cost anyone what they are doing.
export function safeToApplyUpdate(doc = globalThis.document) {
  if (touched) return false;
  if (doc?.visibilityState === 'hidden') return false;
  return !doc?.querySelector?.('[role="dialog"]');
}

// Runs `apply` once the app is at a fresh start: now, or when it is next resumed after a long time away.
export function applyWhenFresh(apply, { win = globalThis } = {}) {
  if (safeToApplyUpdate(win.document)) { apply(); return; }
  const onVisible = () => {
    if (win.document.visibilityState !== 'visible' || !safeToApplyUpdate(win.document)) return;
    win.document.removeEventListener('visibilitychange', onVisible);
    apply();
  };
  win.document?.addEventListener('visibilitychange', onVisible);
}

// For tests.
export function resetFreshStart() {
  touched = false;
  hiddenAt = null;
}
