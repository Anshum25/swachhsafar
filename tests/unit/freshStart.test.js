import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWhenFresh, resetFreshStart, safeToApplyUpdate, watchFreshStart } from '../../src/pwa/freshStart.js';

// A window and document with just what freshStart.js uses.
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', dialogOpen: false });
doc.querySelector = (sel) => (sel === '[role="dialog"]' && doc.dialogOpen ? {} : null);
const win = Object.assign(new EventTarget(), { document: doc });
watchFreshStart(win);

const setVisibility = (state) => {
  doc.visibilityState = state;
  doc.dispatchEvent(new Event('visibilitychange'));
};

describe('updates apply by themselves at a fresh start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFreshStart();
    doc.visibilityState = 'visible';
    doc.dialogOpen = false;
  });
  afterEach(() => vi.useRealTimers());

  it('applies at once when the app has just been opened and nobody is using it', () => {
    const apply = vi.fn();
    expect(safeToApplyUpdate(doc)).toBe(true);
    applyWhenFresh(apply, { win });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('waits while someone is working, then applies when they come back after a long time away', () => {
    win.dispatchEvent(new Event('pointerdown'));
    const apply = vi.fn();
    applyWhenFresh(apply, { win });
    expect(apply).not.toHaveBeenCalled();

    setVisibility('hidden');
    vi.advanceTimersByTime(5 * 60 * 1000);   // a quick look at another app (or the camera): not long enough
    setVisibility('visible');
    expect(apply).not.toHaveBeenCalled();

    win.dispatchEvent(new Event('keydown'));
    setVisibility('hidden');
    vi.advanceTimersByTime(31 * 60 * 1000);
    setVisibility('visible');
    expect(apply).toHaveBeenCalledOnce();
  });

  it('never applies under an open dialog (a capture or a form)', () => {
    doc.dialogOpen = true;
    expect(safeToApplyUpdate(doc)).toBe(false);
    const apply = vi.fn();
    applyWhenFresh(apply, { win });
    expect(apply).not.toHaveBeenCalled();
    doc.dialogOpen = false;
    expect(safeToApplyUpdate(doc)).toBe(true);
  });
});
