/**
 * Whether the app is actually on the user's screen - the question `document.visibilityState` cannot
 * answer on native mobile.
 *
 * MEASURED ON DEVICE 2026-09-05 (Mi 9T, Android 16). A backgrounded Tauri app reports
 * `{visibilityState: "visible", hidden: false, hasFocus: true}` - byte for byte what it reports in
 * the foreground - while its JS keeps running (a 1.5 s timer fired in 1507 ms). It is not a missing
 * lifecycle call either: `WryActivity.onPause` already calls `mWebView.onPause()`, and
 * `WebView.onPause()` simply does not drive the Page Visibility API.
 *
 * So every "is the user looking at this" decision is wrong on a phone, in the direction that says
 * yes. The one that cost something is the notification: a backgrounded phone keeps its WebSocket,
 * receives the message and ACKs it, so the server sends no push and the FCM handler never runs -
 * and the web layer, which would have raised it, saw a visible focused document and stayed quiet.
 *
 * `MainActivity.isInForeground` is the honest statement of the fact, maintained across
 * `onResume`/`onPause`, and the activity pushes it into the page as `window.__canariForeground`
 * plus a `canari:foreground` event.
 *
 * ON EVERY OTHER RUNTIME THIS IS `true` AND MEANS NOTHING. Web and desktop have a working
 * visibility API and callers keep using it; this exists for the one platform where that API lies,
 * and the default is the quiet one - an app believed to be on screen raises no notification, which
 * is the behaviour every non-mobile runtime already has from its own checks.
 */

/** The global the Android activity writes on every foreground transition. */
const FLAG = '__canariForeground';

/** The event it dispatches at the same moment, for callers that want the transition itself. */
export const APP_FOREGROUND_EVENT = 'canari:foreground';

/**
 * True when the app is on screen, as stated by the platform rather than inferred from the document.
 *
 * READ, NEVER CACHED. A cached copy would need a listener mounted before the first transition, and a
 * page loaded while the app is already backgrounded has none - it would start life believing it is
 * in the foreground and stay wrong until the next resume. The global is always current because the
 * activity writes it on every transition and once more the moment the WebView exists.
 *
 * Returns `true` when the global is absent, which is every runtime that does not set it.
 */
export function isAppInForeground(): boolean {
  if (typeof window === 'undefined') return true;
  const value = (window as unknown as Record<string, unknown>)[FLAG];
  return typeof value === 'boolean' ? value : true;
}

/**
 * Calls `onChange` whenever the app moves between foreground and background.
 *
 * Returns the unsubscribe. No-op off the platforms that emit it, which is what makes it safe to
 * register unconditionally rather than behind a runtime check at every call site.
 */
export function onAppForegroundChange(onChange: (foreground: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ foreground?: unknown }>).detail;
    if (typeof detail?.foreground === 'boolean') onChange(detail.foreground);
  };
  window.addEventListener(APP_FOREGROUND_EVENT, handler);
  return () => window.removeEventListener(APP_FOREGROUND_EVENT, handler);
}
