/**
 * The one fact a native mobile WebView cannot work out for itself.
 *
 * Measured on device 2026-09-05 (Mi 9T, Android 16): a BACKGROUNDED Tauri app reports
 * `{visibilityState: "visible", hidden: false, hasFocus: true}` - byte for byte its foreground
 * answer - while its JS keeps running. `WryActivity.onPause` already calls `mWebView.onPause()`, so
 * it is not a missing lifecycle call: `WebView.onPause()` does not drive the Page Visibility API.
 *
 * Two things depended on the document's answer and were therefore wrong on every phone: a
 * backgrounded device raised no notification for a message no push would ever carry, and it sent a
 * READ RECEIPT for a message nobody had seen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_FOREGROUND_EVENT, isAppInForeground, onAppForegroundChange } from './appForeground';

const FLAG = '__canariForeground';
const set = (v: unknown) => {
  (window as unknown as Record<string, unknown>)[FLAG] = v;
};
const clear = () => {
  delete (window as unknown as Record<string, unknown>)[FLAG];
};

afterEach(clear);

describe('isAppInForeground', () => {
  it('reads the flag the Android activity writes', () => {
    set(false);
    expect(isAppInForeground()).toBe(false);
    set(true);
    expect(isAppInForeground()).toBe(true);
  });

  it('IS NOT CACHED - a page that loaded while backgrounded gets the current value, not the first', () => {
    set(false);
    expect(isAppInForeground()).toBe(false);
    // The activity resumes; nothing re-imported and no listener was ever registered.
    set(true);
    expect(isAppInForeground()).toBe(true);
  });

  it('says "on screen" where nothing states the fact - which is every other runtime', () => {
    clear();
    expect(isAppInForeground()).toBe(true);
  });

  it('and where something states it BADLY, which is not the same as stating false', () => {
    // A string, a number, a null: none of them is the activity's boolean. Treating any of them as
    // falsy would turn a malformed bridge into "the app is backgrounded" and notify over the user's
    // shoulder, so only a real boolean is believed.
    for (const junk of ['false', 0, null, undefined, {}]) {
      set(junk);
      expect(isAppInForeground()).toBe(true);
    }
  });
});

describe('onAppForegroundChange', () => {
  it('fires on the activity event, both ways, and unsubscribes', () => {
    const seen: boolean[] = [];
    const off = onAppForegroundChange((f) => seen.push(f));

    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
    expect(seen).toEqual([false, true]);

    off();
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    expect(seen).toEqual([false, true]);
  });

  it('ignores an event carrying no boolean rather than inventing one', () => {
    const onChange = vi.fn();
    const off = onAppForegroundChange(onChange);

    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: {} }));
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: 'no' } }));
    window.dispatchEvent(new Event(APP_FOREGROUND_EVENT));

    expect(onChange).not.toHaveBeenCalled();
    off();
  });
});
