/**
 * Reactive composable for audio tone, system (OS-level) notifications,
 * and the channel-membership banner notice.
 */
import { SvelteMap } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { setTabRinging } from '$lib/stores/tabIndicator';
import { settings } from '$lib/stores/settingsStore.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import {
  isPermissionGranted,
  sendNotification,
  requestPermission,
  removeActive,
  onAction,
} from '@tauri-apps/plugin-notification';

/** Returns a stable positive integer ID derived from a conversation ID string, used to replace existing Tauri notifications for the same conversation. */
function stableNotifId(conversationId: string): number {
  let hash = 0;
  for (let i = 0; i < conversationId.length; i++) {
    hash = (Math.imul(31, hash) + conversationId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

export function useNotifications() {
  let audioContext = $state<AudioContext | null>(null);
  let lastNotificationAt = $state(0);
  let lastSendToneAt = $state(0);
  let lastReadToneAt = $state(0);
  // Per-conversation rate limit: conversationId → last notification timestamp.
  // Prevents notification spam on burst but lets different conversations notify independently.
  const lastNotifAtByConv = new SvelteMap<string, number>();
  let browserPermissionRetryAbort: AbortController | null = null;
  let incomingCallRingTimer: ReturnType<typeof setInterval> | null = null;
  /** Active incoming-call OS notification, kept so it can be dismissed on answer/hangup. */
  let incomingCallNotification: Notification | null = null;
  /** Tauri notification id of the active incoming-call notification, for cancellation. */
  let incomingCallNotifId: number | null = null;

  // ---------- Audio ----------

  /**
   * Returns the shared {@link AudioContext}, creating it on first use and resuming it if the
   * browser parked it.
   *
   * The resume is the point. A context constructed before the page has had a user gesture is born
   * `suspended`, and a suspended context accepts every scheduling call without complaint and makes
   * no sound - so the surrounding try/catch sees nothing to catch and the tone is dropped in
   * silence. That is the ordinary case for a tab left alone: a message arrives, this is the first
   * audio the page ever asked for, and it is inaudible. `resume()` may legitimately reject when no
   * gesture has ever happened, which is the browser's decision to make and not an error to report.
   */
  function getAudioContext(): AudioContext {
    audioContext = audioContext ?? new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    return audioContext;
  }

  /** Plays a two-note descending chime (rate-limited to one every 600 ms) when an incoming message arrives. */
  function playNotificationTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastNotificationAt < 600) return;
    lastNotificationAt = now;

    try {
      const ctx = getAudioContext();
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(920, startAt);
      osc.frequency.exponentialRampToValueAtTime(680, startAt + 0.11);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.16);
    } catch {
      // Browser/autoplay restriction - silently ignored.
    }
  }

  /** Plays a short ascending chirp when the user sends a message (rate-limited to one every 200 ms). */
  function playSendTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastSendToneAt < 200) return;
    lastSendToneAt = now;

    try {
      const ctx = getAudioContext();
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(740, startAt);
      osc.frequency.exponentialRampToValueAtTime(980, startAt + 0.08);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.05, startAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.11);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.12);
    } catch {
      // Browser/autoplay restriction - silently ignored.
    }
  }

  /** Alias for playNotificationTone - used when a message is received from another user. */
  function playReceiveTone() {
    playNotificationTone();
  }

  /** Plays one cycle of a classic dual-tone ring (best-effort; respects soundsEnabled). */
  function playIncomingCallRingBurst() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;

    try {
      const ctx = getAudioContext();
      const startAt = ctx.currentTime + 0.01;

      for (const [freq, offset] of [
        [440, 0],
        [480, 0.25],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startAt + offset);
        gain.gain.setValueAtTime(0.0001, startAt + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, startAt + offset + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt + offset);
        osc.stop(startAt + offset + 0.24);
      }
    } catch {
      /* autoplay restriction */
    }
  }

  /** Starts repeating the incoming-call ring until {@link stopIncomingCallRingtone}. */
  function startIncomingCallRingtone() {
    if (typeof window === 'undefined') return;
    stopIncomingCallRingtone();
    playIncomingCallRingBurst();
    incomingCallRingTimer = setInterval(playIncomingCallRingBurst, 2_400);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([400, 200, 400, 200, 400]);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Stops the incoming-call ring and cancels pending vibration.
   *
   * A NO-OP when nothing is ringing, and the guard is the whole point. Its caller is an `$effect`
   * that runs on every call-state evaluation, so it fires at startup with no call in sight - and
   * `navigator.vibrate(0)` is still a vibrate call, which Chrome refuses without a prior user
   * gesture and reports as a console ERROR. That put two unexplained error lines in every single
   * cold start, on a campaign whose rule is that a run is only clean when every line is accounted
   * for. Cancelling a vibration nobody started is not defensive, it is noise.
   */
  function stopIncomingCallRingtone() {
    if (incomingCallRingTimer === null) return;
    clearInterval(incomingCallRingTimer);
    incomingCallRingTimer = null;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Starts blinking the document title to attract attention on an incoming call.
   *
   * DELEGATED, because this used to be a SECOND writer of `document.title` and that is what made it
   * wrong. It saved the current title, blinked over it and restored what it had saved - so an unread
   * prefix present when a call arrived was captured into that save and reinstated after the call
   * ended, and one applied during the call was erased by the restore. `tabIndicator` owns the title
   * now and renders it from (base, unread, bell) each time, which has no such state to lose.
   */
  function startBlinkingTitle() {
    setTabRinging(true);
  }

  /** Stops the title blink; the tab goes back to whatever the unread count says it should read. */
  function stopBlinkingTitle() {
    setTabRinging(false);
  }

  /**
   * The options every Tauri notification on this app must carry, and WHY `largeBody` is not optional.
   *
   * `tauri-plugin-notification` 2.3.3 declares `inbox_lines: Vec<String>` with `#[serde(default)]`
   * and no `skip_serializing_if`, so the Rust side sends `"inboxLines": []` on EVERY notification.
   * Its Android side reads that field as `List<String>? = null` and branches on `!= null` - and an
   * empty array is not null. So every notification it posts is given an `InboxStyle` carrying ZERO
   * lines, and `InboxStyle` renders `textLines`, never `contentText`. The body is in the record and
   * on no screen.
   *
   * Measured on a Mi 9T on 2026-09-06. The notification for a real incoming message read:
   *
   *     android.title     = "Canari Test Beta"
   *     android.text      = "K-mtq268w3ndf quick reply from the shade"   <- decrypted, present
   *     android.template  = "android.app.Notification$InboxStyle"
   *     android.textLines = CharSequence[] (0)                            <- empty
   *
   * and the shade showed the sender's name with nothing under it - which is the user's report of a
   * banner that says who wrote but not what, exactly. It only shows when the notification is ALONE:
   * inside a group the child row falls back to `contentText` and the body reappears, which is why
   * this survived every stacked screenshot anyone had taken.
   *
   * `largeBody` is checked FIRST by that same builder and takes the `BigTextStyle` branch, which
   * renders. This is not a workaround for the sake of one: a message notification wants BigTextStyle,
   * which is what the plugin documents `largeBody` for ("support multiline text"). Passing the body
   * twice is the price of an under-specified call that happened to be papered over by a bug.
   *
   * ONE HELPER RATHER THAN TWO CALL SITES, because the two `sendNotification` calls in this file are
   * a message and an incoming call, and the next one to be added would have been a third chance to
   * post a notification nobody can read.
   */
  function androidReadableBody(body: string): { body: string; largeBody: string } {
    return { body, largeBody: body };
  }

  /**
   * Shows an OS notification for an incoming call.
   * Not rate-limited (unlike message notifications). Tap opens the conversation in /chat.
   */
  async function notifyIncomingCall(callerName: string, groupId: string) {
    if (typeof window === 'undefined') return;

    const title = m.call_incoming_label();
    const body = callerName
      ? m.notif_call_body_named({ caller: callerName })
      : m.notif_call_body_unknown();
    const notifId = stableNotifId(`call:${groupId}`);

    const onTap = async () => {
      notifNav.navigate(groupId);
      try {
        const { goto } = await import('$app/navigation');
        await goto('/chat');
      } catch {
        /* ignore */
      }
      try {
        window.focus();
      } catch {
        /* ignore */
      }
    };

    if (isTauriRuntime()) {
      try {
        if (await isPermissionGranted()) {
          await sendNotification({ title, ...androidReadableBody(body), id: notifId });
          incomingCallNotifId = notifId;
          return;
        }
      } catch {
        /* fallback */
      }
    }

    if ('Notification' in window) {
      if (Notification.permission !== 'granted') {
        void requestSystemNotificationPermission();
        return;
      }
      try {
        const n = new Notification(title, {
          body,
          tag: `canari-call-${groupId}`,
          requireInteraction: true,
        });
        // Keep the ref so dismissIncomingCall() can close it once the call is
        // answered or ends (requireInteraction keeps it on screen otherwise).
        incomingCallNotification = n;
        n.onclick = () => {
          void onTap();
          n.close();
          incomingCallNotification = null;
        };
        n.onclose = () => {
          if (incomingCallNotification === n) incomingCallNotification = null;
        };
      } catch {
        /* ignore */
      }
    }
  }

  /** Dismisses the incoming-call OS notification (call answered, declined, or ended). */
  async function dismissIncomingCall() {
    if (incomingCallNotification) {
      try {
        incomingCallNotification.close();
      } catch {
        /* ignore */
      }
      incomingCallNotification = null;
    }
    if (incomingCallNotifId !== null && isTauriRuntime()) {
      const id = incomingCallNotifId;
      incomingCallNotifId = null;
      try {
        await removeActive([{ id }]);
      } catch {
        /* plugin/API unavailable - ignore */
      }
    }
  }

  /** Plays a subtle descending tick when messages are marked as read (rate-limited to one every 250 ms). */
  function playReadTone() {
    if (typeof window === 'undefined') return;
    if (!settings.soundsEnabled) return;
    const now = Date.now();
    if (now - lastReadToneAt < 250) return;
    lastReadToneAt = now;

    try {
      const ctx = getAudioContext();
      const startAt = ctx.currentTime + 0.01;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1080, startAt);
      osc.frequency.exponentialRampToValueAtTime(820, startAt + 0.07);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.04, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.1);
    } catch {
      // Browser/autoplay restriction - silently ignored.
    }
  }

  // ---------- System (OS-level) notifications ----------

  /** Registers a one-shot user-gesture listener (pointerdown / keydown / touchstart) to request Notification permission the next time the user interacts with the page. */
  function installBrowserPermissionRetry() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (browserPermissionRetryAbort || Notification.permission !== 'default') return;

    const abort = new AbortController();
    browserPermissionRetryAbort = abort;

    const requestFromGesture = () => {
      void (async () => {
        try {
          await Notification.requestPermission();
        } catch {
          /* ignore */
        } finally {
          abort.abort();
          browserPermissionRetryAbort = null;
        }
      })();
    };

    for (const eventName of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(eventName, requestFromGesture, {
        once: true,
        signal: abort.signal,
      });
    }
  }

  /** Requests OS-level notification permission. On Tauri skips Linux desktop (WebKitGTK dbus deadlock); on web uses the Notification API and falls back to installBrowserPermissionRetry if the prompt is dismissed. */
  async function requestSystemNotificationPermission() {
    if (typeof window === 'undefined') return;

    if (isTauriRuntime()) {
      // On Tauri Linux desktop, the notification plugin blocks the GLib main loop
      // (the dbus call never returns in WebKitGTK). Skip on pure Linux.
      // On Android 13+, POST_NOTIFICATIONS permission MUST be requested at runtime
      // via the Tauri plugin (the manifest alone is not enough).
      // Reliable detection: Linux desktop = "Linux" in platform/userAgent WITHOUT "Android".
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const isLinuxDesktop = /linux/i.test(ua) && !/android/i.test(ua) && !/cros/i.test(ua);
      if (isLinuxDesktop) {
        // Tauri on Linux desktop: the dbus/GLib event loop deadlocks when the
        // notification plugin tries to request permission via WebKitGTK.
        // Notifications are intentionally disabled on this platform.
        console.info(
          '[Push] Notifications disabled on Tauri Linux desktop (dbus/GLib/WebKitGTK bug).'
        );
        return;
      }
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const result = await requestPermission();
          granted = result === 'granted';
        }
        console.log('[Push] Permission granted:', granted);
      } catch {
        /* plugin unavailable on this platform */
      }
      return;
    }

    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      browserPermissionRetryAbort?.abort();
      browserPermissionRetryAbort = null;
      return;
    }

    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }

      if (Notification.permission === 'default') {
        installBrowserPermissionRetry();
      }
    }
  }

  /** Shows an OS-level notification (via Tauri plugin or Web Notification API). Rate-limited per conversation to 800 ms to absorb bursts while allowing different conversations to notify independently. Uses a stable ID/tag per conversation so successive messages replace rather than stack. */
  async function sendSystemNotification(title: string, body: string, conversationId?: string) {
    if (typeof window === 'undefined') return;
    const convKey = conversationId ?? '__default__';
    const now = Date.now();
    const lastAt = lastNotifAtByConv.get(convKey) ?? 0;
    if (now - lastAt < 800) {
      // EVERY SWALLOWED BRANCH LOGS. Three returns here were silent, so "the user was not notified"
      // and "the code never got there" were the same observation from outside - which is what made
      // TAB-1's zero unattributable for a day.
      console.log(`[NOTIF] Throttled for ${convKey} - ${now - lastAt} ms since the last (800 ms).`);
      return;
    }
    lastNotifAtByConv.set(convKey, now);

    if (isTauriRuntime()) {
      try {
        if (await isPermissionGranted()) {
          await sendNotification({
            title,
            ...androidReadableBody(body),
            ...(conversationId ? { id: stableNotifId(conversationId) } : {}),
          });
          // Best-effort: register a tap action so tapping the notification on
          // Tauri desktop navigates to the conversation (parity with Web onclick).
          // onAction is only available on some Tauri notification plugin versions.
          if (conversationId) {
            try {
              if (typeof onAction === 'function') {
                (
                  onAction as unknown as (
                    cb: (action: { notification: { id?: number } }) => void
                  ) => Promise<unknown>
                )(async (action) => {
                  if (action.notification.id === stableNotifId(conversationId)) {
                    notifNav.navigate(conversationId);
                    try {
                      const { goto } = await import('$app/navigation');
                      await goto('/chat');
                    } catch {
                      /* ignore */
                    }
                  }
                });
              }
            } catch {
              /* onAction unavailable on this platform/version */
            }
          }
        }
        return;
      } catch {
        /* fallback to web */
      }
    }

    if (!('Notification' in window)) {
      console.log(`[NOTIF] Not raised for ${convKey} - this engine exposes no Notification API.`);
      return;
    }
    {
      if (Notification.permission !== 'granted') {
        console.log(
          `[NOTIF] Not raised for ${convKey} - permission is "${Notification.permission}"; asking.`
        );
        void requestSystemNotificationPermission();
        return;
      }

      try {
        const n = new Notification(title, {
          body,
          tag: `canari-${conversationId ?? 'message'}`,
        });
        n.onclick = async () => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
          if (conversationId) {
            notifNav.navigate(conversationId);
            try {
              const { goto } = await import('$app/navigation');
              await goto('/chat');
            } catch {
              /* ignore */
            }
          }
          n.close();
        };
        console.log(`[NOTIF] Raised for ${convKey}.`);
        setTimeout(() => n.close(), 8000);
      } catch (e) {
        // A browser refuses a Notification for reasons a page cannot test for in advance, and an
        // empty catch here is indistinguishable from never having tried.
        console.log(`[NOTIF] Constructor threw for ${convKey}: ${String(e)}`);
      }
    }
  }

  return {
    playNotificationTone,
    playSendTone,
    playReceiveTone,
    playReadTone,
    requestSystemNotificationPermission,
    sendSystemNotification,
    startIncomingCallRingtone,
    stopIncomingCallRingtone,
    startBlinkingTitle,
    stopBlinkingTitle,
    notifyIncomingCall,
    dismissIncomingCall,
  };
}
