/**
 * Reactive composable owning all message-level operations:
 * - Incoming message append + unread tracking
 * - Text send, media upload, reactions, edit, delete
 * - Read receipts (debounced)
 * - Reply/cancel-reply state
 * - File selection + validation
 */
import { tick } from 'svelte';
import { isAppInForeground } from '$lib/utils/appForeground';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { SvelteMap, SvelteDate } from 'svelte/reactivity';
import { getToken } from '$lib/stores/auth';
import { fromHex } from '$lib/utils/hex';
import {
  sendChatMessage,
  addReaction,
  removeReaction,
  editMessage,
  deleteMessage,
  setMessagePinned,
} from '$lib/utils/chat/messaging';
import { editSupersedes } from '$lib/utils/chat/editPrecedence';
import { applyPin, isMessagePinned } from '$lib/stores/pinStore.svelte';
import {
  indexMessagesById,
  isStaleInboundMessage,
  normalizeMessageId,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import {
  insertMessageOrdered,
  mergeMessagesInInputOrder,
  messageTime,
} from '$lib/utils/chat/messageOrder';
import { isOwnMessage } from '$lib/utils/chat/messageUtils';
import { isUnreadForUser, watermarkFor } from '$lib/utils/chat/readState';
import {
  MAX_DISTINCT_MESSAGE_REACTIONS,
  activeReactions,
  applyReaction,
  canAddDistinctReactionEmoji,
} from '$lib/utils/chat/messageReactions';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { chat_system_message_deleted, m } from '$lib/paraglide/messages';
import { MediaService } from '$lib/media';
import { getPreviewText, mkMediaEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import { encodeAppMessage, mkMedia, MediaKind } from '$lib/proto/codec';
import type {
  AddMessageToChatOptions,
  ChatMessage,
  MessageReaction,
  Conversation,
} from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { BulkIngestPhase } from '$lib/mls-client';
import type { IStorage, OutboxEntry, StoredMessage } from '$lib/db';
import { enqueueOutboxMessage } from '$lib/utils/chat/outbox';
import { ChannelService } from '$lib/services/ChannelService';
import {
  isChannelConversationId,
  sendEncryptedChannelMessage,
} from '$lib/utils/chat/channelCrypto';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { beginBulkUiFlushBench, finishBulkUiFlushBench } from '$lib/mls-client/catchupBenchmark';
import { shouldUpgradeMessage, mergeMessageUpgrade } from '$lib/utils/chat/messageMerge';
import { publishTabMessageUpdate } from '$lib/mls-client/tabMessageSync';
import { claimChannelReadSignal } from '$lib/utils/chat/channelReadSignal';

/** Runtime dependencies injected into all messaging operations. */
export interface MessagingContext {
  /** Returns (or lazily creates) the active MLS service. */
  ensureMls: () => IMlsService;
  /** Reactive map of all open conversations (DMs + channels). */
  conversations: SvelteMap<string, Conversation>;
  userId: string;
  deviceKeyB64: string;
  authToken: string;
  setAuthToken: (v: string) => void;
  selectedContact: string | null;
  getSendError: () => string;
  setSendError: (v: string) => void;
  getChatContainer: () => HTMLElement | undefined;
  storage: IStorage | null;
  log: (msg: string) => void;
  saveConversation: (contactName: string) => Promise<void>;
  verifyCurrentUserMembership: (contactName: string) => Promise<boolean>;
  playNotificationTone: () => void;
  playSendTone?: () => void;
  playReceiveTone?: () => void;
  playReadTone?: () => void;
  sendSystemNotification: (title: string, body: string, conversationId?: string) => Promise<void>;
  /**
   * Tells this user's OTHER devices that a salon has been read, so any of them still showing its
   * notification drops it. Optional: only the layer holding a channel client can provide it, and
   * a context without one simply never signals rather than failing.
   */
  signalChannelRead?: (channelId: string) => void;
}

/**
 * Maps an envelope media type to its protobuf {@link MediaKind}. A file has no dedicated kind,
 * so anything unrecognised falls through to UNSPECIFIED, which is what the renderer treats as
 * "generic attachment".
 */
function mediaKindFromEnvelope(type: string): number {
  switch (type) {
    case 'image':
      return MediaKind.MEDIA_KIND_IMAGE;
    case 'video':
      return MediaKind.MEDIA_KIND_VIDEO;
    case 'audio':
      return MediaKind.MEDIA_KIND_AUDIO;
    default:
      return MediaKind.MEDIA_KIND_UNSPECIFIED;
  }
}

/** Creates and returns the reactive messaging store covering send, receive, reactions, edit, delete, replies, and media uploads. */
export function useMessaging() {
  const messageReactions = new SvelteMap<string, MessageReaction[]>();
  let replyingTo = $state<ChatMessage | null>(null);
  let pendingMediaFiles = $state<import('$lib/media').PendingMediaFile[]>([]);
  let isUploadingMedia = $state(false);

  /** Depth of nested MLS queue catch-up sessions (overlay stays until zero). */
  let messageCatchupDepth = 0;
  let isMessageCatchupActive = $state(false);

  /**
   * How many real messages a drain must actually produce before it is ANNOUNCED to the user.
   *
   * Below this the insertion is fast enough that a banner would say less than it costs: it would
   * appear and vanish, and the user would have learnt nothing they could not see.
   */
  const OVERLAY_MIN_MESSAGES = 5;

  /**
   * Whether the "synchronisation" banner is up - a DIFFERENT question from
   * {@link isMessageCatchupActive}, and separating the two is the whole point.
   *
   * `isMessageCatchupActive` answers "is a multi-frame drain running", which is what the three
   * concurrency guards that read it actually need (the FCM cache flush, its poll, and the media
   * send). This one answers "is there something worth telling the user about", and only that.
   *
   * They were one flag, decided at drain START from `pendingCount` - a count of CIPHERTEXTS. Nothing
   * downstream can classify a frame before decrypting it: `MlsQueuedMessage` carries no delivery
   * class and the server's envelope carries neither `silent` nor `durable`. So the banner was
   * counting frames it could not read, and a reconnect whose nine frames were all history probes
   * announced a synchronisation of exactly zero messages - for four seconds, every time the app came
   * back to the foreground. It is raised from the BUFFER instead, which holds decrypted messages and
   * therefore knows what it has.
   */
  let isCatchupOverlayVisible = $state(false);
  /** When true, incoming messages are buffered and flushed in one UI update (MLS queue catch-up). */
  let bulkIngestActive = false;
  /** Global MLS catch-up sequence (reset when bulk buffer starts). */
  let bulkIngestSeq = 0;
  const bulkIngestBuffer = new SvelteMap<
    string,
    Array<{ senderId: string; content: string } & AddMessageToChatOptions>
  >();

  /** Buffer of orphan messages that arrived before their conversation was in the map.
   *  Capped per conversation to avoid memory leaks. */
  const MAX_ORPHAN_MESSAGES_PER_CONVERSATION = 50;
  const orphanBuffer = new SvelteMap<
    string,
    Array<{
      senderId: string;
      content: string;
      contactName: string;
      options: AddMessageToChatOptions & { skipDbSave?: boolean };
    }>
  >();

  const mediaService = new MediaService();
  const mediaMaxSizeMb = Number.parseInt(import.meta.env.VITE_MEDIA_MAX_SIZE_MB ?? '100', 10);
  const mediaMaxSizeBytes = mediaMaxSizeMb * 1024 * 1024;

  // ── Incoming message ──────────────────────────────────────────────────────

  /**
   * Opens a UI catch-up window for a bulk-ingest phase: buffers incoming messages for one grouped
   * flush per conversation (`bufferUi`) and/or shows the blocking sync overlay (`showOverlay`).
   */
  function beginBulkMessageIngest(phase: BulkIngestPhase) {
    const { bufferUi, showOverlay } = phase;
    if (!bufferUi && !showOverlay) return;

    if (showOverlay) {
      messageCatchupDepth += 1;
      isMessageCatchupActive = true;
    }
    if (bufferUi) {
      bulkIngestActive = true;
      bulkIngestSeq = 0;
      warnIfDiscardingBuffered('beginBulkMessageIngest');
      bulkIngestBuffer.clear();
    }
  }

  /**
   * Both clear sites below discard whatever is still buffered, and a drain restarting before the
   * previous one ended is exactly that shape. Discarding is the deliberate behaviour - a flush here
   * would re-enter the ingest path from inside its own reset - but it must never be SILENT, because
   * a dropped buffer is indistinguishable from a message that never arrived. This is the only trace
   * it leaves.
   */
  function warnIfDiscardingBuffered(where: string) {
    if (bulkIngestBuffer.size === 0) return;
    const count = [...bulkIngestBuffer.values()].reduce((sum, msgs) => sum + msgs.length, 0);
    console.warn(
      `[ADD_MSG] ${where}: discarding ${count} buffered message(s) across ${bulkIngestBuffer.size} conversation(s) - they were never rendered nor persisted`
    );
  }

  /**
   * Raises the banner once the buffer holds enough real messages to be worth announcing.
   *
   * Called on every buffered message, and deliberately cheap: it stops scanning for good once the
   * banner is up, and the scan itself is over CONVERSATIONS rather than messages.
   */
  function raiseOverlayIfWorthAnnouncing() {
    if (isCatchupOverlayVisible || messageCatchupDepth === 0) return;
    let buffered = 0;
    for (const msgs of bulkIngestBuffer.values()) {
      buffered += msgs.length;
      if (buffered >= OVERLAY_MIN_MESSAGES) {
        isCatchupOverlayVisible = true;
        return;
      }
    }
  }

  /** Clears catch-up UI state (safety net if begin/end ever desync). */
  function resetMessageCatchupState() {
    messageCatchupDepth = 0;
    isMessageCatchupActive = false;
    isCatchupOverlayVisible = false;
    bulkIngestActive = false;
    warnIfDiscardingBuffered('resetMessageCatchupState');
    bulkIngestBuffer.clear();
  }

  /** Ends catch-up: flushes bulk buffer when used, then hides the loading overlay. */
  async function endBulkMessageIngest(ctx: MessagingContext, phase: BulkIngestPhase) {
    const { bufferUi, showOverlay } = phase;
    if (!bufferUi && !showOverlay) return;

    try {
      if (bufferUi && bulkIngestActive) {
        // Disable buffering BEFORE the await loop: any message that arrives during the flush
        // (e.g. a channel event calling addMessageToChat outside the drain queue) then takes
        // the live path and renders immediately, instead of landing in a buffer the finally
        // block is about to discard - which would silently drop it.
        bulkIngestActive = false;
        const entries = [...bulkIngestBuffer.entries()].sort(([, a], [, b]) => {
          const seqA = a[0]?.ingestSequence ?? Number.MAX_SAFE_INTEGER;
          const seqB = b[0]?.ingestSequence ?? Number.MAX_SAFE_INTEGER;
          return seqA - seqB;
        });
        const benchMessageCount = entries.reduce((sum, [, msgs]) => sum + msgs.length, 0);
        beginBulkUiFlushBench(entries.length, benchMessageCount);
        bulkIngestBuffer.clear();
        for (const [contactName, messages] of entries) {
          if (messages.length > 0) {
            await batchAddMessages(messages, contactName, ctx);
            await yieldToMainThread();
          }
        }
        finishBulkUiFlushBench();
        tick().then(() => {
          const chatContainer = ctx.getChatContainer();
          if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
        });
      }
    } catch (e) {
      console.error('[CATCHUP] endBulkMessageIngest failed:', e);
    } finally {
      if (bufferUi) {
        bulkIngestActive = false;
        bulkIngestBuffer.clear();
      }
      if (showOverlay) {
        messageCatchupDepth = Math.max(0, messageCatchupDepth - 1);
        if (messageCatchupDepth === 0) {
          isMessageCatchupActive = false;
          isCatchupOverlayVisible = false;
        }
      }
    }
  }

  /**
   * Appends a single message to the conversation, updates `lastMessageAt`, persists to
   * IndexedDB, and scrolls to bottom. Deduplicates by id. No-op if the conversation is
   * not in the map.
   */
  /**
   * The OS notification for ONE inbound message, and the only place that decides to raise it.
   *
   * IT LIVED INSIDE `addMessageToChat` AND THEREFORE COVERED ONE OF THE TWO INBOUND PATHS. The
   * other is the bulk buffer: while a catch-up is draining, `addMessageToChat` files an inbound
   * message into `bulkIngestBuffer` and RETURNS - above this decision - and the flush hands it to
   * `batchAddMessages`, which never had one. So a message that arrived inside a drain window
   * notified nobody, and a backgrounded tab is exactly the state that produces a drain: TAB-1
   * recorded permission `granted`, the tab hidden, the message arrived, and zero notifications
   * constructed (2026-09-05). The probe's evidence was one line - `[ADD_MSG] Batch into "...":
   * 1 added` - which named the path that had no branch.
   *
   * Per-conversation throttling belongs to `sendSystemNotification` (800 ms) and is not repeated
   * here, so a batch that ends in several messages for one conversation still raises one.
   */
  function notifyInbound(
    ctx: MessagingContext,
    conversationKey: string,
    conversationName: string,
    senderId: string,
    content: string,
    isSystem: boolean,
    isOwn: boolean
  ): void {
    if (isOwn || isSystem) return;
    if (typeof document === 'undefined') return;

    // NATIVE MOBILE USED TO RETURN HERE, AND THAT IS WHY A PHONE IN A POCKET NEVER NOTIFIED.
    //
    // The premise was "the background push handler posts its own, so the user would get two". It
    // holds only when there IS a push, and for the ordinary backgrounded case there is none. The
    // server pushes a message only when the device has not ACKNOWLEDGED it after 10 s
    // (`scheduleDeferredPush`); a backgrounded Android app keeps its WebSocket, receives the frame
    // and ACKs it - so no push is ever sent, the push handler never runs, and this early return
    // meant nobody notified at all. Measured on device 2026-09-05, all three sources correlated on
    // one message: `[SEND] PUBLISHED recipient=...:tauri-...` with NO `[PUSH_DEFERRED]` after it,
    // an empty shade, and the app holding the message the whole time.
    //
    // That also explains the pair the campaign had backwards: LIFE-8 (`am kill` - the user killing
    // it) measured a decrypted push in 4.7 s, because a killed app cannot ACK, so the push does fire
    // and the handler notifies. The phone in a pocket was the failing case and the phone the user
    // had killed the passing one. (NOT LIFE-3, which force-stops: a force-stopped package sits in
    // Android's STOPPED state and the framework cancels every FCM broadcast to it, so that row
    // expects no notification at all and says nothing about this.)
    //
    // AND THE MOBILE CONDITION IS NOT THE DOCUMENT'S, BECAUSE THE DOCUMENT LIES THERE. Measured on
    // device: a backgrounded Tauri app reports `visibilityState: "visible"`, `hidden: false` and
    // `hasFocus: true` - byte for byte its foreground answer - so BOTH halves of the check below
    // would return early and this fix would have been inert. `isAppInForeground` reads the fact the
    // Android activity states for itself; see `appForeground.ts` for the measurement.
    const mobile = isMobileTauriRuntime();
    if (mobile) {
      if (isAppInForeground()) return;
    } else if (document.visibilityState === 'visible' && document.hasFocus()) return;
    // THE DECISION LINE, and it fires only when a notification is actually expected - the tab is
    // not in front of the user. Everything downstream of here already speaks (`[NOTIF] Raised`,
    // `Throttled`, `permission is ...`), and everything upstream is the ordinary case of a visible
    // tab. Without it "no notification" and "never asked for one" are the same silence, which is
    // what left TAB-1 unattributable across three probes.
    console.log(
      `[NOTIF] Inbound in ${conversationKey} while ` +
        `${mobile ? 'the app is backgrounded (no push is sent for a frame this client ACKed)' : document.visibilityState}` +
        ' - asking.'
    );
    const preview = getPreviewText(parseEnvelope(content));
    void ctx.sendSystemNotification(
      getUserDisplayNameSync(senderId, conversationName),
      preview || m.notif_new_message(),
      conversationKey
    );
  }

  async function addMessageToChat(
    senderId: string,
    content: string,
    contactName: string,
    ctx: MessagingContext,
    options: AddMessageToChatOptions & { skipDbSave?: boolean } = {}
  ) {
    const normalized = contactName.toLowerCase();

    // An OWN message is never deferred, and that is a difference in kind rather than a tuning
    // choice. The bulk buffer exists to stop a large inbound drain re-rendering the list message by
    // message - but MLS gives no echo of your own message, so THIS call is the only writer the
    // sender's copy will ever get, and the buffer is discarded without flushing by a second drain
    // (`beginBulkMessageIngest` clears unconditionally) and by `resetMessageCatchupState`. The
    // outbox cannot repair it either: `persistSent` looks the message up in `conversations`, which a
    // buffered message never reached, and returns without writing. So a send composed during any
    // drain window died before it was persisted - the receiver had it and the sender lost it at the
    // next load (WP-ECHO-1). It also explains why the OFFLINE path was always correct: offline there
    // is no inbound drain, so the echo took the live path. One extra item costs nothing to render.
    if (bulkIngestActive && !isOwnMessage(senderId, ctx.userId)) {
      const convo = ctx.conversations.get(normalized);
      if (!convo) {
        console.warn(
          `[ADD_MSG] conversation "${normalized}" introuvable (bulk) — bufferisation orpheline`
        );
        const buffer = orphanBuffer.get(normalized) ?? [];
        if (buffer.length < MAX_ORPHAN_MESSAGES_PER_CONVERSATION) {
          buffer.push({ senderId, content, contactName, options });
          orphanBuffer.set(normalized, buffer);
        }
        return;
      }
      const id = normalizeMessageId(options.messageId) ?? crypto.randomUUID();
      const existing = bulkIngestBuffer.get(normalized) ?? [];
      if (existing.some((m) => m.messageId === id) || convo.messages.some((m) => m.id === id)) {
        // A duplicate is ordinary and this is not an accusation - but it is the FIRST of two silent
        // returns on the only path an inbound message can take, and between them they can absorb a
        // message without leaving anything behind. A card that never appeared has to be explainable
        // from a log, and "we already had it" is one of the explanations.
        console.log(`[ADD_MSG] Duplicate ignored during a bulk ingest id=${id}…`);
        return;
      }
      existing.push({
        senderId,
        content,
        ...options,
        messageId: id,
        ingestSequence: options.ingestSequence ?? bulkIngestSeq++,
      });
      bulkIngestBuffer.set(normalized, existing);
      raiseOverlayIfWorthAnnouncing();
      return;
    }

    const convo = ctx.conversations.get(normalized);
    if (!convo) {
      console.warn(`[ADD_MSG] conversation "${normalized}" introuvable — bufferisation orpheline`);
      const buffer = orphanBuffer.get(normalized) ?? [];
      if (buffer.length < MAX_ORPHAN_MESSAGES_PER_CONVERSATION) {
        buffer.push({ senderId, content, contactName, options });
        orphanBuffer.set(normalized, buffer);
      }
      return;
    }

    const isOwn = isOwnMessage(senderId, ctx.userId);
    // One arriving message, so one scan: building an index here would cost the same walk and throw
    // it away. The batch path below is the one that had to change.
    const resolvedTimestamp = resolveMessageTimestamp(
      options,
      (id) => convo.messages.find((m) => m.id === id),
      isOwn
    );
    const newMsg: ChatMessage = {
      id: normalizeMessageId(options.messageId) ?? crypto.randomUUID(),
      senderId: senderId.toLowerCase(),
      content,
      timestamp: new SvelteDate(resolvedTimestamp),
      isOwn,
      replyTo: options.replyTo,
      isSystem: options.isSystem ?? false,
      status: options.status,
      isFcmPreview: options.isFcmPreview,
      serverTimestamp: options.serverTimestamp,
    };

    const dupIdx = convo.messages.findIndex((m) => m.id === newMsg.id);
    if (dupIdx !== -1) {
      const existing = convo.messages[dupIdx];
      if (shouldUpgradeMessage(existing, content)) {
        const upgraded = mergeMessageUpgrade(existing, newMsg);
        const nextMessages = insertMessageOrdered(
          convo.messages.filter((m) => m.id !== newMsg.id),
          upgraded
        );
        ctx.conversations.set(normalized, {
          ...convo,
          messages: nextMessages,
          lastMessageAt: Math.max(convo.lastMessageAt ?? 0, upgraded.timestamp.getTime()),
        });
        if (ctx.storage && !(options.skipDbSave ?? isChannelConversationId(normalized))) {
          try {
            // The row is replaced wholesale, so everything the merged message still carries has to
            // be written back: a reaction that landed on the FCM preview before the real body
            // arrived would otherwise be erased by the upgrade.
            await ctx.storage.saveMessage(
              {
                id: upgraded.id,
                conversationId: normalized,
                senderId: upgraded.senderId,
                content: upgraded.content,
                timestamp: upgraded.timestamp.getTime(),
                serverTimestamp: upgraded.serverTimestamp,
                reactions: upgraded.reactions,
                isDeleted: upgraded.isDeleted,
                isEdited: upgraded.isEdited,
                ...(upgraded.editedAt ? { editedAt: upgraded.editedAt.getTime() } : {}),
                isFcmPreview: false,
              },
              ctx.deviceKeyB64
            );
          } catch (e) {
            console.error('[DB] Failed to upgrade message:', e);
          }
        }
        const updatedConvo = ctx.conversations.get(normalized);
        if (updatedConvo) {
          publishTabMessageUpdate({
            type: 'message_added',
            conversationId: normalized,
            message: upgraded,
            lastMessageAt: updatedConvo.lastMessageAt ?? upgraded.timestamp.getTime(),
            unreadCount: updatedConvo.unreadCount ?? 0,
          });
        }
        console.log(`[ADD_MSG] ✓ Message upgraded: id=${newMsg.id}…`);
        return;
      }
      console.log(`[ADD_MSG] Duplicate ignored id=${newMsg.id}…`);
      return;
    }

    const isConversationOpen = ctx.selectedContact === normalized;
    // The same question the batch path asks, which until 2026-08-30 it did not: this one forgot
    // the watermark AND counted system messages, so a replayed frame taking the single path could
    // still raise a badge for something already read, and a "X joined" notice raised one for
    // something nobody reads at all.
    const shouldMarkUnread =
      !isConversationOpen &&
      isUnreadForUser(newMsg, watermarkFor(convo.readWatermarks, ctx.userId.toLowerCase()));
    const nextUnreadCount = shouldMarkUnread
      ? (convo.unreadCount ?? 0) + 1
      : isConversationOpen
        ? 0
        : (convo.unreadCount ?? 0);

    ctx.conversations.set(normalized, {
      ...convo,
      unreadCount: nextUnreadCount,
      messages: insertMessageOrdered(convo.messages, newMsg),
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, newMsg.timestamp.getTime()),
    });
    console.log(`[ADD_MSG] ✓ Message added: id=${newMsg.id}…`);

    publishTabMessageUpdate({
      type: 'message_added',
      conversationId: normalized,
      message: newMsg,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, newMsg.timestamp.getTime()),
      unreadCount: nextUnreadCount,
    });

    // READ ON ARRIVAL IS STILL READ. This is the case the unread counter cannot see: the salon is
    // already open, so the message is read the instant it lands and `nextUnreadCount` stays 0 - and
    // a sibling device holding its banner has been told nothing. See `channelReadSignal`.
    if (
      isConversationOpen &&
      !isOwn &&
      !options.isSystem &&
      isChannelConversationId(normalized) &&
      claimChannelReadSignal(normalized, newMsg.timestamp.getTime())
    ) {
      ctx.signalChannelRead?.(normalized);
    }

    if (!isOwn && !options.isSystem && !isStaleInboundMessage(resolvedTimestamp)) {
      (ctx.playReceiveTone ?? ctx.playNotificationTone)();
    }

    // ONE DECISION, ASKED BY BOTH INBOUND PATHS - see `notifyInbound`.
    notifyInbound(ctx, normalized, convo.name, senderId, content, !!options.isSystem, isOwn);

    const skipDbSave = options.skipDbSave ?? isChannelConversationId(normalized);
    if (ctx.storage && !skipDbSave) {
      try {
        const row = {
          id: newMsg.id,
          conversationId: normalized,
          senderId: newMsg.senderId,
          content,
          timestamp: newMsg.timestamp.getTime(),
          serverTimestamp: options.serverTimestamp,
          ...(options.isFcmPreview ? { isFcmPreview: true } : {}),
        };
        // AN OWN MESSAGE AND THE ENTRY THAT SENDS IT ARE ONE FACT, so they are one write. Persisting
        // the echo and then queuing it was two awaits, and a document torn down between them left a
        // message the sender could see and no queue would ever send (TAB-5, 2026-09-05). Every other
        // caller - an inbound message, an FCM upgrade - has no entry and takes the single-store path.
        if (options.outboxEntry) {
          await ctx.storage.saveMessageWithOutboxEntry(row, options.outboxEntry, ctx.deviceKeyB64);
        } else {
          await ctx.storage.saveMessage(row, ctx.deviceKeyB64);
        }
        await ctx.saveConversation(normalized);
      } catch (e) {
        console.error('[DB] Failed to persist message:', e);
      }
    }

    tick().then(() => {
      const chatContainer = ctx.getChatContainer();
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  /**
   * Appends multiple messages in a single reactive update and one batch IndexedDB write.
   * Used by history replay and bulk catch-up to avoid O(n) individual updates that would
   * cause UI jank. Updates `lastMessageAt` to the max timestamp in the batch.
   */
  async function batchAddMessages(
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string,
    ctx: MessagingContext
  ) {
    if (messages.length === 0) return;
    const normalized = contactName.toLowerCase();
    const convo = ctx.conversations.get(normalized);
    if (!convo) {
      // THE SECOND SILENT RETURN, and the more dangerous one: these messages were ACCEPTED into the
      // bulk buffer, which means the conversation was in the map when they arrived and is not any
      // more. They are dropped here without being rendered or persisted, and nothing else in the
      // system would ever mention them again. Same rule as `warnIfDiscardingBuffered`: discarding
      // may be right, being silent about it never is.
      console.warn(
        `[ADD_MSG] conversation "${normalized}" vanished between buffering and flush - dropping ${messages.length} message(s), never rendered nor persisted`
      );
      return;
    }

    // ONE index, built once, for the two questions this loop asks of every incoming message: "do we
    // already hold it" and "what timestamp did we give it". Both used to be a linear scan of the
    // rendered list, so a catch-up of `m` messages into a conversation of `n` cost `2·n·m`
    // comparisons on the main thread - the post-ingest freeze, and a cost that grows with the
    // conversation rather than with the batch. It has to work at any size, so it is an index.
    // Ids seen during THIS batch are added to it too, which is what the separate dedup set did.
    const byId = indexMessagesById(convo.messages);
    const toStore: StoredMessage[] = [];
    const upgradedById = new SvelteMap<string, ChatMessage>();
    const brandNew: ChatMessage[] = [];

    let processedCount = 0;
    for (const pm of messages) {
      // Yield to the main thread every 50 messages to avoid UI freeze during large catch-ups.
      processedCount++;
      if (processedCount % 50 === 0) await yieldToMainThread();

      const id = normalizeMessageId(pm.messageId) ?? crypto.randomUUID();
      const existingMsg = byId.get(id);
      if (existingMsg && shouldUpgradeMessage(existingMsg, pm.content)) {
        const upgraded = mergeMessageUpgrade(existingMsg, {
          content: pm.content,
          replyTo: pm.replyTo,
          isSystem: pm.isSystem,
          serverTimestamp: pm.serverTimestamp,
        });
        upgradedById.set(id, upgraded);
        if (ctx.storage) {
          toStore.push({
            id,
            conversationId: normalized,
            senderId: upgraded.senderId,
            content: pm.content,
            timestamp: upgraded.timestamp.getTime(),
            serverTimestamp: pm.serverTimestamp,
            isFcmPreview: false,
          });
        }
        continue;
      }
      if (existingMsg) continue;

      const isOwn = isOwnMessage(pm.senderId, ctx.userId);
      const resolvedTimestamp = resolveMessageTimestamp(pm, (mid) => byId.get(mid), isOwn);
      const newMsg: ChatMessage = {
        id,
        senderId: pm.senderId.toLowerCase(),
        content: pm.content,
        timestamp: new SvelteDate(resolvedTimestamp),
        isOwn,
        replyTo: pm.replyTo,
        isSystem: pm.isSystem,
        ingestSequence: pm.ingestSequence,
      };
      brandNew.push(newMsg);
      // The index is also the dedup set: a batch carrying the same id twice must add it once.
      byId.set(id, newMsg);

      if (ctx.storage) {
        toStore.push({
          id,
          conversationId: normalized,
          senderId: newMsg.senderId,
          content: pm.content,
          timestamp: (newMsg.timestamp instanceof Date
            ? newMsg.timestamp
            : new SvelteDate(newMsg.timestamp)
          ).getTime(),
          serverTimestamp: pm.serverTimestamp,
          ...(pm.isSystem ? { readBy: [] } : {}),
        });
      }
    }

    if (upgradedById.size === 0 && brandNew.length === 0) {
      // Ordinary - a re-drain of frames this device already holds - and still not silent: it is the
      // difference between "the batch arrived and we had it all" and "the batch never arrived".
      console.log(
        `[ADD_MSG] Batch into "${normalized}": ${messages.length} message(s), all already held`
      );
      return;
    }

    const isConversationOpen = ctx.selectedContact === normalized;
    // COUNTED AGAINST THIS USER'S OWN WATERMARK, not against "arrived just now". The two are the
    // same thing only for live traffic; a reconciliation delivers frames that are new to THIS
    // device and were read long ago on another one, and counting those raised a badge the next
    // read receipt in the same replay immediately cleared. Interleaved, the pair made a
    // conversation flash read/unread for the whole reconciliation. The watermark is persisted on
    // the conversation, so it is already loaded before any of this runs - the count was ignoring a
    // fact it held. Deriving it here makes the result independent of the order frames arrive in.
    const myWatermark = watermarkFor(convo.readWatermarks, ctx.userId.toLowerCase());
    const addedUnread = brandNew.filter((msg) => isUnreadForUser(msg, myWatermark)).length;
    const nextUnreadCount = isConversationOpen ? 0 : (convo.unreadCount ?? 0) + addedUnread;

    const withUpgrades = convo.messages.map((m) => upgradedById.get(m.id) ?? m);
    const merged = mergeMessagesInInputOrder(withUpgrades, brandNew);
    const batchMaxTs = merged.reduce((max, m) => Math.max(max, messageTime(m)), 0);

    ctx.conversations.set(normalized, {
      ...convo,
      unreadCount: nextUnreadCount,
      messages: merged,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, batchMaxTs),
    });

    // THE ONLY INBOUND PATH WITH NO SUCCESS LINE, until 2026-08-20. The live path says
    // `Message added` per message; this one said nothing at all, so a message that took the buffered
    // path was invisible whether it landed or not - which is exactly the state an invitation card
    // that never appeared left the log in. One line per FLUSH rather than per message: a catch-up
    // carries thousands, and the question a reader has is which conversation received how many.
    // System messages are named individually because they are few, and because a card is one.
    const systemIds = brandNew.filter((m) => m.isSystem).map((m) => m.id);
    console.log(
      `[ADD_MSG] Batch into "${normalized}": ${brandNew.length} added, ${upgradedById.size} upgraded` +
        (systemIds.length > 0 ? ` - system: ${systemIds.join(', ')}` : '')
    );

    // THE SAME QUESTION THE LIVE PATH ASKS, and until 2026-09-05 this path never asked it. A message
    // buffered during a catch-up reaches the user through here and through nowhere else, so a tab
    // in the background - the state that produces a catch-up in the first place - was told about
    // nothing at all (TAB-1). ONE notification per flush, for the LAST inbound message: the
    // 800 ms throttle in `sendSystemNotification` would collapse a per-message loop to one anyway,
    // and the one a reader wants is the most recent, not the oldest.
    const lastInbound = [...brandNew]
      .reverse()
      .find((msg) => !msg.isSystem && !isOwnMessage(msg.senderId, ctx.userId));
    if (
      !lastInbound &&
      brandNew.length &&
      typeof document !== 'undefined' &&
      document.visibilityState !== 'visible'
    ) {
      // The other half of the same question: a flush that added messages while the tab was away and
      // raised nothing has either seen only own/system rows, or lost them to a predicate.
      console.log(
        `[NOTIF] Batch into "${normalized}" added ${brandNew.length} while ${document.visibilityState}, none of them an inbound message - nothing to raise.`
      );
    }
    if (lastInbound) {
      notifyInbound(
        ctx,
        normalized,
        convo.name,
        lastInbound.senderId,
        lastInbound.content,
        false,
        false
      );
    }

    publishTabMessageUpdate({
      type: 'messages_batch',
      conversationId: normalized,
      messages: brandNew,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, batchMaxTs),
      unreadCount: nextUnreadCount,
    });

    // Single batch DB write (community channels are server-authoritative)
    if (ctx.storage && toStore.length > 0 && !isChannelConversationId(normalized)) {
      try {
        await ctx.storage.saveMessages(toStore, ctx.deviceKeyB64);
        await ctx.saveConversation(normalized);
      } catch (e) {
        console.error('[DB] batchAddMessages failed:', e);
      }
    }

    tick().then(() => {
      const chatContainer = ctx.getChatContainer();
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /** Main send handler: verifies MLS membership, uploads any pending media files (with client-side AES-GCM encryption), then sends a text message. Handles channel (REST) and DM/group (MLS) paths. */
  async function handleSendChat(ctx: MessagingContext, messageText: string) {
    const text = messageText.trim();
    const filesToSend = [...pendingMediaFiles];
    const fileEntries = filesToSend;
    const mediaCaption = text || undefined;
    let sentMediaMessageCount = 0;

    ctx.log(
      `[SEND] handleSendChat: contact="${ctx.selectedContact}" text="${text.slice(0, 40)}" files=${filesToSend.length}`
    );

    if (!text && filesToSend.length === 0) {
      ctx.log('[SEND] Abort: pas de texte ni de fichier');
      return;
    }
    if (!ctx.selectedContact) {
      ctx.log('[SEND] Abort: no contact selected.');
      return;
    }
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) {
      ctx.log(`[SEND] Abort: no conversation found for "${ctx.selectedContact}".`);
      return;
    }

    const isChannel = isChannelConversationId(ctx.selectedContact);
    ctx.log(
      `[SEND] convo: groupId="${convo.id}" lifecycle=${convo.lifecycle} isChannel=${isChannel}`
    );

    // Media (inline upload+send) still requires a ready MLS group; queuing media is a later
    // increment. Text/reply are captured into the outbox and never blocked here - they flush
    // automatically once the group becomes sendable.
    if (filesToSend.length > 0 && !isChannel) {
      // WAIT FOR THE DRAIN, DO NOT REFUSE BECAUSE OF IT.
      //
      // This used to bail out on `isMessageCatchupActive` and tell the user "Synchronisation en
      // cours - reessayez dans un instant". That flag is raised from `pendingCount > 1`, a count of
      // CIPHERTEXTS taken before anything is decrypted, so it cannot tell an arriving message from
      // the reconciliation's own probe: two probe frames on a server carrying no other traffic were
      // enough to refuse a photo. The requirement was never "no drain is running" - it is "encrypt
      // at the current epoch", and `waitForMessageQueueIdle` states exactly that, as a fact rather
      // than a guess. It is the same barrier the outbox flusher takes before every send, and it
      // costs nothing when there is no drain to wait for.
      await ctx
        .ensureMls()
        // `null`: a click on the send button, never a stack inside a decrypt session.
        .waitForMessageQueueIdle('media send', null)
        .catch((e) => ctx.log(`[SEND] queue-idle barrier failed, sending anyway: ${String(e)}`));
      const stillMember = await ctx.verifyCurrentUserMembership(ctx.selectedContact);
      if (!stillMember || convo.lifecycle !== 'active') {
        ctx.setSendError(m.chat_send_session_establishing());
        return;
      }
    }

    const currentReplyingTo = replyingTo;
    replyingTo = null;
    ctx.setSendError('');
    const channelSvc = isChannel ? new ChannelService() : null;

    const mediaTypeFromMime = (mime: string): 'image' | 'video' | 'audio' | 'file' =>
      mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'file';

    if (fileEntries.length > 0) {
      pendingMediaFiles = [];
      try {
        for (let index = 0; index < fileEntries.length; index++) {
          const entry = fileEntries[index];
          const captionForFile = index === 0 ? mediaCaption : undefined;
          const messageId = crypto.randomUUID();
          const sentAt = Date.now();

          if (isChannel && channelSvc) {
            // Channels are server-authoritative + always available: encrypt + upload + send inline.
            isUploadingMedia = true;
            let { authToken } = ctx;
            if (!authToken) {
              authToken = await getToken();
              ctx.setAuthToken(authToken);
            }
            const mediaRef = await mediaService.encryptAndUpload(entry.file, authToken, {
              width: entry.width,
              height: entry.height,
            });
            const protoBytes = encodeAppMessage({
              ...mkMedia({
                kind: mediaKindFromEnvelope(mediaRef.type),
                mediaId: mediaRef.mediaId,
                key: fromHex(mediaRef.key),
                iv: fromHex(mediaRef.iv),
                mimeType: mediaRef.mimeType,
                size: mediaRef.size,
                fileName: mediaRef.fileName ?? '',
                caption: captionForFile,
                ...(mediaRef.width && mediaRef.height
                  ? { width: mediaRef.width, height: mediaRef.height }
                  : {}),
              }),
              messageId,
              sentAt,
            });
            const actualChannelId = ctx.selectedContact!.replace('channel_', '');
            await sendEncryptedChannelMessage(actualChannelId, protoBytes, messageId);
          } else {
            // MLS: queue the media. The flusher uploads then sends once the group is ready
            // (the optimistic message shows a skeleton + pending clock until then).
            const type = mediaTypeFromMime(entry.file.type);
            const placeholder = serializeEnvelope(
              mkMediaEnvelope(
                {
                  type,
                  mediaId: '',
                  key: '',
                  iv: '',
                  mimeType: entry.file.type,
                  size: entry.file.size,
                  fileName: entry.file.name,
                  width: entry.width,
                  height: entry.height,
                },
                captionForFile
              )
            );
            await addMessageToChat(ctx.userId, placeholder, ctx.selectedContact!, ctx, {
              messageId,
              status: 'pending',
              timestamp: new SvelteDate(sentAt),
            });
            const fileBytes = new Uint8Array(await entry.file.arrayBuffer());
            const outboxEntry: OutboxEntry = {
              id: messageId,
              conversationId: convo.id,
              sentAt,
              kind: 'media',
              media: {
                kind: mediaKindFromEnvelope(type),
                mimeType: entry.file.type,
                size: entry.file.size,
                fileName: entry.file.name,
                width: entry.width,
                height: entry.height,
                caption: captionForFile,
                fileBytes,
              },
              status: 'pending',
              attempts: 0,
              createdAt: sentAt,
            };
            await enqueueOutboxMessage(outboxEntry);
          }
          sentMediaMessageCount++;
        }
        if (sentMediaMessageCount > 0) {
          ctx.playSendTone?.();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (sentMediaMessageCount < fileEntries.length) {
          pendingMediaFiles = [...fileEntries.slice(sentMediaMessageCount), ...pendingMediaFiles];
        }
        ctx.setSendError(m.chat_media_send_error({ reason: errorMessage }));
        ctx.log(
          `[MEDIA] send failed, ${fileEntries.length - sentMediaMessageCount} file(s) re-staged: ${errorMessage}`
        );
      } finally {
        isUploadingMedia = false;
      }
    }

    if (sentMediaMessageCount > 0 || !text) return;

    const result = await sendChatMessage(text, ctx.selectedContact!, currentReplyingTo, {
      userId: ctx.userId,
      conversation: convo,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        addMessageToChat(sid, content, contactName, ctx, options),
      log: ctx.log,
    });

    // Text/reply now always succeed (captured into the outbox); only a hard block
    // (deleted group) or a channel error surfaces a message to the user.
    if (!result.success) {
      if (result.error) {
        ctx.setSendError(result.error);
        ctx.log(`[SEND] Failed: ${result.error}`);
      }
      return;
    }

    ctx.log('[SEND] handleSendChat completed (message queued).');
    ctx.playSendTone?.();
  }

  // ── File handling ─────────────────────────────────────────────────────────

  /** Validates and enqueues files for sending. Images are auto-compressed with canvas API before queuing. Files exceeding the configured size limit are rejected with an error message. */
  async function handleFilesSelected(files: File[], ctx: MessagingContext) {
    const readyFiles: import('$lib/media').PendingMediaFile[] = [];
    for (const file of files) {
      if (Number.isFinite(mediaMaxSizeBytes) && file.size > mediaMaxSizeBytes) {
        const size = (file.size / 1024 / 1024).toFixed(1);
        ctx.setSendError(m.chat_media_too_large({ size, limit: mediaMaxSizeMb }));
        // The LOG is dev-facing and stays English, and it names the file the banner cannot: the
        // banner tells the user one file was too big, this says WHICH, so a report of "it refused my
        // picture" is answerable without asking them to reproduce it.
        ctx.log(`[MEDIA] refused "${file.name}" - ${size} Mo over the ${mediaMaxSizeMb} Mo limit`);
        continue;
      }
      let entry: import('$lib/media').PendingMediaFile = { file };
      // Never re-encode GIFs: canvas compression renders a single frame and would drop the
      // animation (matters for both picked GIFs and keyboard-committed GIFs). They are already
      // small and optimized, so they are sent as-is.
      if (file.type.startsWith('image/') && file.type !== 'image/gif') {
        try {
          const { compressImage, IMAGE_COMPRESS_PRESETS } = await import('$lib/media');
          const originalSize = file.size;
          const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.chat;
          const compressed = await compressImage(file, maxWidth, maxHeight, quality);
          entry = {
            file: compressed.file,
            width: compressed.width > 0 ? compressed.width : undefined,
            height: compressed.height > 0 ? compressed.height : undefined,
          };
          if (compressed.file.size < originalSize) {
            const savedPercent = ((1 - compressed.file.size / originalSize) * 100).toFixed(0);
            ctx.log(
              `Image compressee: ${(originalSize / 1024 / 1024).toFixed(1)} Mo -> ${(compressed.file.size / 1024 / 1024).toFixed(1)} Mo (-${savedPercent}%)`
            );
          }
        } catch (e) {
          console.warn('Compression failed, using original:', e);
        }
      }
      readyFiles.push(entry);
    }
    if (readyFiles.length > 0) pendingMediaFiles = [...pendingMediaFiles, ...readyFiles];
  }

  /** Removes a staged (not yet sent) file from the pending media queue by its index. */
  function removePendingMediaFile(index: number) {
    pendingMediaFiles = pendingMediaFiles.filter((_, i) => i !== index);
  }

  // ── Reactions / edit / delete ─────────────────────────────────────────────

  /**
   * Writes a locally-applied mutation (reaction, edit, delete) back to the encrypted store.
   *
   * The sender never receives an MLS echo of their own control event, so this is the ONLY thing
   * that makes the mutation survive a reload on the device that issued it - the peers get theirs
   * from `systemMessageHandler`. Without it the optimistic in-memory update is dropped on the next
   * load and the pre-edit body comes back.
   *
   * Best-effort by design: the control event is already durable in the outbox, so a failed write
   * costs a stale local row, never a lost mutation for the group.
   */
  async function persistLocalMutation(msg: ChatMessage, ctx: MessagingContext): Promise<void> {
    if (!ctx.storage) return;
    try {
      // A patch, not a rewrite: `serverTimestamp` is known to the delivery path and not to this
      // one, and a full-row write erased it every time the user reacted.
      await ctx.storage.updateMessage(
        msg.id,
        {
          content: msg.content,
          reactions: messageReactions.get(msg.id),
          isDeleted: msg.isDeleted,
          isEdited: msg.isEdited,
          ...(msg.editedAt ? { editedAt: msg.editedAt.getTime() } : {}),
        },
        ctx.deviceKeyB64
      );
    } catch (e) {
      ctx.log(
        `[DB] Failed to persist local mutation on ${msg.id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Toggles an emoji reaction on a message: adds it if absent, removes it if the user already used that emoji. Updates state optimistically in memory and DB before sending the MLS message. */
  async function handleAddReaction(messageId: string, emoji: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const conversationKey = ctx.selectedContact.toLowerCase();
    const convo = ctx.conversations.get(conversationKey);
    if (!convo) return;
    const meNorm = ctx.userId.toLowerCase();
    const existing = messageReactions.get(messageId) ?? [];
    const alreadyReacted = activeReactions(existing).some(
      (r) => r.userId === meNorm && r.emoji === emoji
    );

    // The cap is enforced HERE and nowhere else: it limits what the user may place, and a device
    // refusing a frame that already reached the group would never converge with one that took it.
    if (!alreadyReacted && !canAddDistinctReactionEmoji(existing, emoji)) {
      ctx.log(
        `[REACTION] Maximum of ${MAX_DISTINCT_MESSAGE_REACTIONS} distinct reactions reached on this message.`
      );
      return;
    }

    // One clock reading for the optimistic update and the frame, so this device and its peers hold
    // the same timestamp for this pair and the merge is a no-op when the echo comes back.
    const at = Date.now();
    const updated = applyReaction(existing, meNorm, emoji, at, alreadyReacted);
    if (!updated) return;

    messageReactions.set(messageId, updated);

    // Immediate in-memory and DB update to survive page reload.
    const msgIdx = convo.messages.findIndex((m) => m.id === messageId);
    if (msgIdx !== -1) {
      const nextMsgs = [...convo.messages];
      nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: updated };
      ctx.conversations.set(conversationKey, { ...convo, messages: nextMsgs });
      await persistLocalMutation(nextMsgs[msgIdx], ctx);
    }

    const reactionDeps = {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      conversation: convo,
      currentUserDisplayName: getUserDisplayNameSync(ctx.userId),
    };
    if (alreadyReacted) {
      await removeReaction(messageId, emoji, at, reactionDeps);
    } else {
      await addReaction(messageId, emoji, at, reactionDeps);
    }
  }

  /**
   * Drops a message row from the encrypted store.
   *
   * Only for a message WITHDRAWN before it was sent: a deletion the peers know about keeps its row,
   * because the tombstone has to survive a reload. Best-effort like `persistLocalMutation`, and for
   * the same reason - but the cost of a failure is the opposite one, a row that comes back on the
   * next load and that no peer can ever match.
   */
  async function forgetLocalMessage(
    messageId: string,
    conversationId: string,
    ctx: MessagingContext
  ): Promise<void> {
    if (!ctx.storage) return;
    try {
      await ctx.storage.deleteMessage(messageId, conversationId);
    } catch (e) {
      ctx.log(
        `[DB] Failed to drop withdrawn message ${messageId}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Sends a "delete_message" MLS system message and marks the message as deleted in the local conversation state. Only the original sender can delete their own message. */
  async function handleDeleteMessage(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can delete their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || !isOwnMessage(target.senderId, ctx.userId)) return;

    const outcome = await deleteMessage(messageId, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      conversation: convo,
    });

    // A withdrawal is not a deletion the peers have to be told about - it is a message that never
    // existed anywhere but here, so the row goes, rather than becoming a tombstone standing for
    // nothing. Measured before the fix: every withdrawal left a row no other device held, which
    // `recon.mjs` reports as a loss on the sender for ever.
    if (outcome === 'withdrawn') {
      ctx.conversations.set(ctx.selectedContact, {
        ...convo,
        messages: convo.messages.filter((m) => m.id !== messageId),
      });
      await forgetLocalMessage(messageId, convo.id, ctx);
      return;
    }

    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx !== -1) {
      msgs[idx] = { ...msgs[idx], isDeleted: true, content: chat_system_message_deleted() };
      ctx.conversations.set(ctx.selectedContact, { ...convo, messages: msgs });
      await persistLocalMutation(msgs[idx], ctx);
    }
  }

  /** Sends an "edit_message" MLS system message and updates the message content and editedAt in the local conversation state. Only the original sender can edit their own message. */
  async function handleEditMessage(messageId: string, text: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;

    // Ownership check: only the sender can edit their own message
    const target = convo.messages.find((m) => m.id === messageId);
    if (!target || !isOwnMessage(target.senderId, ctx.userId)) return;

    // ONE INSTANT FOR BOTH HALVES - see handleTogglePin below, which has always done this. Taking
    // it twice dated the local apply and the broadcast differently for the same act, and now that
    // the timestamp decides which of two concurrent edits survives, the difference is a device that
    // can lose to its own frame.
    const editedAt = Date.now();
    await editMessage(messageId, text, editedAt, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      conversation: convo,
    });
    const msgs = [...convo.messages];
    const idx = msgs.findIndex((m) => m.id === messageId);
    // The row is defended against our own edit by the same rule that defends it against a peer's:
    // if it already holds a later one, this edit lost and the broadcast above will lose everywhere.
    if (idx !== -1 && editSupersedes({ editedAt, content: text }, msgs[idx])) {
      msgs[idx] = {
        ...msgs[idx],
        isEdited: true,
        editedAt: new SvelteDate(editedAt),
        content: text,
      };
      ctx.conversations.set(ctx.selectedContact, { ...convo, messages: msgs });
      await persistLocalMutation(msgs[idx], ctx);
    }
  }

  /**
   * Toggles a message's pinned state: applies it locally (optimistic - the sender gets no
   * MLS echo) and broadcasts a "pin"/"unpin" system message so all members converge.
   */
  async function handleTogglePin(messageId: string, ctx: MessagingContext) {
    if (!ctx.selectedContact) return;
    const convo = ctx.conversations.get(ctx.selectedContact);
    if (!convo) return;
    const next = !isMessagePinned(convo.id, messageId);
    // One instant for both halves - see setMessagePinned. Taking it twice would date the local
    // apply and the broadcast differently, for the same act.
    const at = Date.now();
    applyPin(convo.id, messageId, next, at);
    await setMessagePinned(messageId, next, at, {
      mlsService: ctx.ensureMls(),
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      conversation: convo,
    });
  }

  // ── Reply ─────────────────────────────────────────────────────────────────

  /** Sets the message the user is replying to, which will be embedded as a quote preview in the next send. */
  function handleReply(message: ChatMessage) {
    replyingTo = message;
  }

  /** Clears the pending reply state (user dismissed the reply banner). */
  function cancelReply() {
    replyingTo = null;
  }

  /**
   * Forwards a message (text OR media) to ANOTHER conversation, without touching
   * the current composition state (reply / pending files).
   *
   * Media: the envelope already carries the encrypted blob reference (mediaId) + the
   * decryption key (CEK/iv). The SAME media envelope is re-sent (no re-upload),
   * giving members of the target conversation access to the same blob via the forwarded key.
   *
   * The target may be a DM, a group OR a community channel; the source may equally be any of
   * them. Only the transport differs - MLS for the first two, the channel epoch key for the
   * third - and both directions cross freely, so a channel message can be forwarded into a DM
   * and vice versa. A channel target re-encrypts under its own key, and the blob stays reachable
   * because the CEK travels inside the forwarded envelope.
   */
  async function forwardMessage(
    sourceContent: string,
    targetName: string,
    ctx: MessagingContext
  ): Promise<{ success: boolean; error?: string }> {
    const convo = ctx.conversations.get(targetName);
    if (!convo) return { success: false, error: m.chat_forward_error_conversation_missing() };

    const env = parseEnvelope(sourceContent);

    // Channels are server-authoritative and always sendable: no MLS group, no outbox, and no
    // local echo (the `channel.message.created` broadcast is what renders the bubble).
    if (isChannelConversationId(targetName)) {
      try {
        if (env.kind === 'media') {
          await sendEncryptedChannelMessage(
            targetName,
            encodeAppMessage({
              ...mkMedia({
                kind: mediaKindFromEnvelope(env.media.type),
                mediaId: env.media.mediaId,
                key: fromHex(env.media.key),
                iv: fromHex(env.media.iv),
                mimeType: env.media.mimeType,
                size: env.media.size,
                fileName: env.media.fileName ?? '',
                caption: env.caption,
                ...(env.media.width && env.media.height
                  ? { width: env.media.width, height: env.media.height }
                  : {}),
              }),
              messageId: crypto.randomUUID(),
              sentAt: Date.now(),
            })
          );
          return { success: true };
        }
        const channelText = env.kind === 'text' ? env.text.trim() : '';
        if (!channelText)
          return { success: false, error: m.chat_forward_error_nothing_to_forward() };
        return await sendChatMessage(channelText, targetName, null, {
          userId: ctx.userId,
          conversation: convo,
          addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
            addMessageToChat(sid, content, contactName, ctx, options),
          log: ctx.log,
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        ctx.log(`[FORWARD] channel forward failed for "${targetName}": ${reason}`);
        return { success: false, error: m.chat_forward_error({ reason }) };
      }
    }

    const mlsService = ctx.ensureMls();

    try {
      if (env.kind === 'media') {
        // Media forward is an inline upload+send: it still needs a ready MLS group.
        if (convo.lifecycle !== 'active')
          return { success: false, error: m.chat_forward_error_conversation_not_ready() };
        const media = env.media;
        const messageId = crypto.randomUUID();
        const protoBytes = encodeAppMessage({
          ...mkMedia({
            kind: mediaKindFromEnvelope(media.type),
            mediaId: media.mediaId,
            key: fromHex(media.key),
            iv: fromHex(media.iv),
            mimeType: media.mimeType,
            size: media.size,
            fileName: media.fileName ?? '',
            caption: env.caption,
            ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
          }),
          messageId,
          sentAt: Date.now(),
        });
        await mlsService.sendMessage(convo.id, protoBytes, messageId);
        const payload = serializeEnvelope(mkMediaEnvelope({ ...media }, env.caption));
        await addMessageToChat(ctx.userId, payload, targetName, ctx, { messageId });
        return { success: true };
      }

      const text = env.kind === 'text' ? env.text.trim() : '';
      if (!text) return { success: false, error: m.chat_forward_error_nothing_to_forward() };
      return await sendChatMessage(text, targetName, null, {
        userId: ctx.userId,
        conversation: convo,
        addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
          addMessageToChat(sid, content, contactName, ctx, options),
        log: ctx.log,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      ctx.log(`[FORWARD] MLS forward failed for "${targetName}": ${reason}`);
      return { success: false, error: m.chat_forward_error({ reason }) };
    }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    /** Reactive map of emoji reactions keyed by message ID. */
    messageReactions,

    /** Message the user is currently replying to (null when no reply is pending). */
    get replyingTo() {
      return replyingTo;
    },
    /** Files staged for sending in the next handleSendChat call. */
    get pendingMediaFiles() {
      return pendingMediaFiles;
    },
    /** True while a media file is being encrypted and uploaded. */
    get isUploadingMedia() {
      return isUploadingMedia;
    },
    /** True while the MLS queue is draining after reconnect (catch-up in progress). */
    get isCatchupOverlayVisible() {
      return isCatchupOverlayVisible;
    },
    get isMessageCatchupActive() {
      return isMessageCatchupActive;
    },

    /** Appends a single message to a conversation's reactive state and persists it to DB. */
    addMessageToChat,
    /** Buffers incoming messages during MLS queue catch-up (pair with endBulkMessageIngest). */
    beginBulkMessageIngest,
    /** Flushes buffered messages after MLS queue catch-up. */
    endBulkMessageIngest,
    /** Resets overlay + bulk buffer (e.g. after a desynced catch-up on mobile). */
    resetMessageCatchupState,
    /**
     * Replays the buffered orphan messages for a conversation that has just been added to the
     * map (e.g. after processing an MLS Welcome).
     * Called via MessageHandlerDeps.drainOrphanMessages.
     */
    drainOrphanMessages: (convoKey: string, ctx: MessagingContext) => {
      const normalized = convoKey.toLowerCase();
      const messages = orphanBuffer.get(normalized);
      if (!messages || messages.length === 0) return;
      orphanBuffer.delete(normalized);
      console.log(`[ORPHAN] Draining ${messages.length} buffered message(s) for "${normalized}"`);
      for (const msg of messages) {
        addMessageToChat(msg.senderId, msg.content, msg.contactName, ctx, msg.options);
      }
    },
    /** Appends multiple messages in one reactive update and one batch DB write. */
    batchAddMessages,
    /** Main send handler: uploads pending media then sends a text message. */
    handleSendChat,
    forwardMessage,
    /** Validates and enqueues files (with image compression) for the next send. */
    handleFilesSelected,
    /** Removes a staged file from the pending media queue by index. */
    removePendingMediaFile,
    /** Toggles an emoji reaction on a message (add if absent, remove if present). */
    handleAddReaction,
    /** Sends a delete_message MLS event and marks the message as deleted locally. */
    handleDeleteMessage,
    /** Sends an edit_message MLS event and updates the message content locally. */
    handleEditMessage,
    /** Toggles a message's pinned state (optimistic local + pin/unpin MLS system event). */
    handleTogglePin,
    /** Sets the message to reply to (shown as a quote in the next send). */
    handleReply,
    /** Clears the pending reply state. */
    cancelReply,
  };
}
