/**
 * A PHONE IN A POCKET WAS TOLD NOTHING, and the reason was one early return.
 *
 * `notifyInbound` returned immediately on native mobile, on the premise that "the background push
 * handler posts its own, so the user would get two". That holds only when there IS a push, and for
 * the ordinary backgrounded case there is none: the server pushes a message only when the device
 * has not ACKNOWLEDGED it after 10 s, and a backgrounded Android app keeps its WebSocket, receives
 * the frame and ACKs it. So no push was sent, the push handler never ran, and this early return
 * meant nobody notified at all.
 *
 * Measured on device 2026-09-05 with all three sources correlated on one message: the server logged
 * `[SEND] PUBLISHED recipient=...:tauri-...` with NO `[PUSH_DEFERRED]` after it, the shade held
 * nothing, and the app was holding the message the whole time. It also explains the pair the
 * campaign had backwards - LIFE-8 (`am kill`) measured a decrypted push in 4.7 s, because a killed
 * app cannot ACK so the push does fire.
 *
 * These pin the new condition from both directions, because the risk runs both ways: too quiet and
 * the defect is back, too loud and a banner interrupts somebody reading the message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle cut as the sibling notification tests - see `useMessaging.bulkIngest`.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

// MUTABLE, because the whole subject is the difference between the two runtimes. A file-level
// constant would need two files to ask one question, and the web case has to be asserted HERE:
// "mobile is quiet when unfocused" only means something beside "web is not".
let MOBILE = true;
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isMobileTauriRuntime: () => MOBILE,
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';
const LIVE_DRAIN = { bufferUi: true, showOverlay: false };

function makeContext() {
  const sendSystemNotification = vi.fn().mockResolvedValue(undefined);
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: 'something-else',
    // BOTH writers, because the two inbound paths use different ones: the live path saves one
    // message and the bulk flush saves the batch. A fixture with only the first made
    // `batchAddMessages` log a real TypeError into every drain case - harmless to the assertion,
    // and exactly the kind of red herring a later reader spends an hour on.
    storage: {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      saveMessages: vi.fn().mockResolvedValue(undefined),
    } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    getChatContainer: () => undefined,
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification,
  } as unknown as MessagingContext;
  return { ctx, sendSystemNotification };
}

/**
 * The document's two facts AND the platform's one, set INDEPENDENTLY - which is the whole point.
 *
 * On a phone the first two are not merely unreliable, they are FIXED: a backgrounded Tauri app
 * reports `visible` / `hasFocus: true`, exactly its foreground answer (measured on device
 * 2026-09-05). So every mobile case here pins `visible, focused` and moves only
 * `window.__canariForeground` - a fixture that let the document say `hidden` on mobile would be
 * testing a state that hardware never produces, and would have passed an inert fix.
 */
function screen(visibility: 'hidden' | 'visible', focused: boolean, foreground?: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  if (foreground === undefined)
    delete (window as unknown as Record<string, unknown>).__canariForeground;
  else (window as unknown as Record<string, unknown>).__canariForeground = foreground;
}

describe('native mobile notifies for the message no push will ever carry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    MOBILE = true;
  });

  it('THE DEFECT: a backgrounded phone is told about an inbound message', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    // What hardware really reports while backgrounded: the document sees nothing wrong.
    screen('visible', true, false);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-1' });

    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    // The conversation key travels, because both the 800 ms throttle and the per-conversation
    // notification id are derived from it - a notification with no key stacks for ever.
    expect(sendSystemNotification.mock.calls[0][2]).toBe(CONVO);
  });

  it('and so is one that arrived inside a catch-up drain, which is what a phone coming back does', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    messaging.beginBulkMessageIngest(LIVE_DRAIN);
    await messaging.addMessageToChat(PEER, 'buffered', CONVO, ctx, { messageId: 'm-2' });
    expect(sendSystemNotification).not.toHaveBeenCalled();

    await messaging.endBulkMessageIngest(ctx, LIVE_DRAIN);
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('THE OTHER DIRECTION: an activity ON SCREEN is not interrupted', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, true);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-3' });

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('which is NOT what the web client does with the same two facts', async () => {
    MOBILE = false;
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', false); // visible but unfocused: a desktop window behind another

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-4' });

    // A desktop tab that is visible but behind another window is a real "away", and it always
    // notified. Asserting it here is what keeps the mobile rule from being applied to both.
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('a runtime that never states the fact is treated as on screen, and stays quiet', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, undefined);

    await messaging.addMessageToChat(PEER, 'their message', CONVO, ctx, { messageId: 'm-6' });

    // The default is the quiet one deliberately: an older APK that does not push the flag keeps the
    // behaviour it has rather than notifying over the user's shoulder while they read.
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('a phone still says nothing about the user own message', async () => {
    const messaging = useMessaging();
    const { ctx, sendSystemNotification } = makeContext();
    screen('visible', true, false);

    await messaging.addMessageToChat(ME, 'my own message', CONVO, ctx, { messageId: 'm-5' });

    expect(sendSystemNotification).not.toHaveBeenCalled();
  });
});
