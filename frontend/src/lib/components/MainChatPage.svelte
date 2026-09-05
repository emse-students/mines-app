<script module lang="ts">
  // Last routeMode ('chat' | 'communities') that MainChatPage mounted under. Module-scoped so it
  // survives the component remount that happens when navigating between the /chat and /communities
  // routes (each is a distinct +page.svelte rendering its own MainChatPage). A component-local
  // $state would reset to null on every mount, so a mode switch could never be detected and the
  // previous discussion's content leaked across tabs.
  let lastActiveRouteMode: 'chat' | 'communities' | null = null;
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { foldForSearch } from '$lib/utils/textFold';
  import { goto } from '$app/navigation';
  import { fade } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';
  import { showToast } from '$lib/stores/toast.svelte';
  import { sendReadWatermark } from '$lib/utils/chat/messaging';
  import { isAppInForeground } from '$lib/utils/appForeground';
  import {
    mergeReadWatermark,
    watermarkAfterReading,
    watermarkFor,
  } from '$lib/utils/chat/readState';
  import { forceSyncReset } from '$lib/utils/chat/actions';
  import {
    isChannelConversationId,
    sendChannelPoll,
    type ChannelPollDraft,
  } from '$lib/utils/chat/channelCrypto';
  import { channelService } from '$lib/services/ChannelService';
  import {
    claimChannelReadSignal,
    newestForeignMessageAt,
  } from '$lib/utils/chat/channelReadSignal';
  import { applyLocalVote, setPollMeta } from '$lib/stores/pollStore.svelte';
  import { channelReactionMap } from '$lib/stores/reactionStore.svelte';
  import { aggregateSharedContent, type SharedContent } from '$lib/utils/chat/sharedContent';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import { isMessagePinned, applyPin, setPinnedSet } from '$lib/stores/pinStore.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    globalMessaging as messaging,
    globalChannels as channels,
    globalNotifs as notifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { openInvitedChannel, selectionBelongsToRoute } from '$lib/utils/chat/notificationRouting';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import Sidebar from './sidebar/Sidebar.svelte';
  import ChannelMembersSidebar from './chat/ChannelMembersSidebar.svelte';
  import ChannelSettingsModal from './chat/ChannelSettingsModal.svelte';
  import ChatArea from './chat/ChatArea.svelte';
  import MessagingSyncOverlay from './chat/MessagingSyncOverlay.svelte';
  import ForwardMessageModal from './chat/ForwardMessageModal.svelte';
  import { CALLS_ENABLED } from '$lib/features';
  import type { AddMessageToChatOptions, ChatMessage, Conversation } from '$lib/types';
  import type { BulkIngestPhase } from '$lib/mls-client';

  interface Props {
    /** Controls whether the sidebar shows private chat conversations or community channels. */
    routeMode?: 'chat' | 'communities';
  }

  let { routeMode = 'chat' }: Props = $props();

  /** True when the currently selected conversation is a channel (not an MLS DM or group). */
  const isSelectedChannel = $derived(isChannelConversationId(convs.selectedContact ?? ''));

  /**
   * Channel reactions come from their own store, because they are a cleartext server-side tally
   * rather than the encrypted MLS system messages a DM reaction is made of.
   */
  const channelReactions = channelReactionMap();

  /**
   * Whether the viewer may delete OTHER members' messages in the open channel - the
   * `channel.moderate` permission the community role matrix advertises. Server-authoritative
   * (`viewerCanModerate`) and fail-closed; the API re-checks it, so this only decides whether
   * the delete affordance is worth offering. Always false outside a channel: in a DM or group,
   * deletion stays limited to your own messages.
   */
  const canModerateSelectedChannel = $derived(
    isSelectedChannel &&
      (channels.channelWorkspaces.find((ws) =>
        ws.channels.some((ch) => ch.id === convs.selectedContact)
      )?.viewerCanModerate ??
        false)
  );

  /**
   * Whether the viewer may POST in the open channel - the salon's `writePolicy` applied to their own
   * roles, as the server decided it (`viewerCanWrite`).
   *
   * Fails OPEN, unlike {@link canModerateSelectedChannel}, and the asymmetry is deliberate: a
   * moderation affordance offered by mistake costs a refused request, while a composer withheld by
   * mistake costs the person the ability to speak. The server refuses a forbidden post either way -
   * this only decides whether the product offers a control it would refuse.
   */
  const canWriteToSelectedChannel = $derived(
    !isSelectedChannel ||
      (channels.channelWorkspaces
        .flatMap((ws) => ws.channels)
        .find((ch) => ch.id === convs.selectedContact)?.canWrite ??
        true)
  );

  /** Member user IDs of the currently selected channel, for scoping @mention suggestions. */
  let selectedChannelMemberIds = $state<string[]>([]);

  /** True while MLS unlock / queue catch-up is running. */
  const isSyncing = $derived(session.isMessagingInitializing || messaging.isMessageCatchupActive);

  /** True once at least one conversation is restored from local cache. */
  const hasCachedConversations = $derived(convs.conversations.size > 0);

  /**
   * Block the whole UI only on a cold start (nothing cached yet). Once cached conversations are
   * available we show them immediately and sync in the background.
   *
   * This used to claim "the per-group scheduler serializes sends safely meanwhile", which is not
   * what makes it safe: `sendMessage` goes straight to the WASM client and takes no scheduler lock -
   * that mutex wraps the INBOUND drain. What actually protects a send made during a drain is the
   * outbox flusher's `waitForMessageQueueIdle` barrier, which is what stops a message being
   * encrypted at a stale epoch and silently dropped by up-to-date peers.
   */
  const isMessagingBlocked = $derived(
    !session.isLoggedIn || (isSyncing && !hasCachedConversations)
  );

  const messagingOverlayMessage = $derived(
    !session.isLoggedIn ? m.chat_connecting_label() : m.chat_sync_overlay_message()
  );

  /** Explicit derived binding so ChatArea re-renders when the open conversation mutates. */
  const activeConversation = $derived(convs.currentConvo);

  /** User IDs allowed in @mention suggestions for the active chat/channel, or undefined for unrestricted (e.g. posts). */
  const composerAllowedUserIds = $derived(
    isSelectedChannel
      ? selectedChannelMemberIds
      : convs.groupMembers.length > 0
        ? convs.groupMembers
        : undefined
  );

  // Deep-link landing (notification tap, invite card, invite link) is owned by
  // ChatBackgroundService: it reads the same globalConvs/globalChannels singletons, is mounted on
  // every route, and holds the target until it is displayed. A second copy here selected the
  // target and released it early, which is what let the landing be lost.

  let messageText = $state('');

  /** Message pending forwarding (opens ForwardMessageModal when non-null). */
  let forwardingMessage = $state<ChatMessage | null>(null);
  let isWindowFocused = $state(true);
  let isTabVisible = $state(true);

  /** Appends a debug message to the global log buffer and scrolls the log panel. */
  function log(msg: string) {
    appendLog(msg);
    tick().then(() => {
      const el = document.getElementById('logContainer');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /** Builds the context object passed to channel workspace composable operations. */
  function channelsCtx() {
    return {
      conversations: convs.conversations,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      deleteConversation: (name: string) =>
        session.storage?.deleteConversation(name) ?? Promise.resolve(),
      selectConversation: convs.selectConversation,
      ensureMls: async () => session.ensureMls(),
      startDirectConversation: (targetUserId: string, opts?: { silent?: boolean }) =>
        convs.startNewConversation(targetUserId, convCtx(), opts),
      getSelectedConversationId: () => convs.selectedContact,
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        options?: AddMessageToChatOptions
      ) => messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      reloadChannelHistory: (channelConversationId: string) =>
        convs.loadHistoryForConversation(channelConversationId, channelConversationId, convCtx()),
      invalidateChannelHistoryCache: (channelConversationId: string) =>
        convs.invalidateChannelHistoryCache(channelConversationId),
      log,
    };
  }

  /** Builds the context object passed to conversation composable operations. */
  function convCtx() {
    return {
      storage: session.storage,
      ensureMls: session.ensureMls,
      userId: session.userId,
      deviceKeyB64: session.deviceKeyB64,
      historyBaseUrl: session.historyBaseUrl,
      messageReactions: messaging.messageReactions,
      log,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      batchAddMessages: (
        msgs: Parameters<typeof messaging.batchAddMessages>[0],
        contactName: string
      ) => messaging.batchAddMessages(msgs, contactName, msgCtx()),
    };
  }

  /** Builds the context object passed to messaging composable operations. */
  function msgCtx() {
    return {
      ensureMls: session.ensureMls,
      conversations: convs.conversations,
      userId: session.userId,
      deviceKeyB64: session.deviceKeyB64,
      authToken: session.authToken,
      setAuthToken: (v: string) => {
        session.authToken = v;
      },
      selectedContact: convs.selectedContact,
      getSendError: () => convs.sendError,
      setSendError: (v: string) => {
        convs.sendError = v;
      },
      getChatContainer: () => convs.chatContainer,
      storage: session.storage,
      log,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      verifyCurrentUserMembership: (name: string) =>
        convs.verifyCurrentUserMembership(name, convCtx()),
      playNotificationTone: notifs.playNotificationTone,
      playSendTone: notifs.playSendTone,
      playReceiveTone: notifs.playReceiveTone,
      playReadTone: notifs.playReadTone,
      sendSystemNotification: notifs.sendSystemNotification,
      signalChannelRead: (channelId: string) => void channelService.markChannelRead(channelId),
    };
  }

  /** Builds the callbacks object passed to session composable operations (WebSocket event handlers). */
  function sessionCb() {
    return {
      conversations: convs.conversations,
      loadAndRestoreConversations: () => convs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      beginBulkMessageIngest: (phase: BulkIngestPhase) => messaging.beginBulkMessageIngest(phase),
      endBulkMessageIngest: (phase: BulkIngestPhase) =>
        messaging.endBulkMessageIngest(msgCtx(), phase),
      batchAddMessages: (
        msgs: Parameters<typeof messaging.batchAddMessages>[0],
        contactName: string
      ) => messaging.batchAddMessages(msgs, contactName, msgCtx()),
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      selectConversation: convs.selectConversation,
      onSendError: (msg: string) => {
        convs.sendError = msg;
      },
      onReadStateAdvanced: (e: { conversationKey: string; senderId: string; at: number }) => {
        // Sound only when someone else reads MY message, in the currently open conversation
        // on the visible tab (never for my own cross-device reads).
        if (e.senderId === session.userId) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (e.conversationKey !== convs.selectedContact) return;
        notifs.playReadTone();
      },
      log,
      messageReactions: messaging.messageReactions,
      getSelectedContact: () => convs.selectedContact,
      setSelectedContact: (v: string | null) => {
        convs.selectedContact = v;
      },
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        convs.loadHistoryForConversation(contactName, groupId, convCtx()),
    };
  }

  /**
   * Returns the set of props shared by both the desktop sidebar and the mobile drawer sidebar.
   * Extracted here to avoid duplicating 20+ prop bindings in the template.
   */
  function makeSidebarCommonProps() {
    return {
      viewMode: (routeMode === 'communities' ? 'communities' : 'chat') as 'chat' | 'communities',
      conversations: convs.conversations,
      selectedContact: convs.selectedContact,
      newContactInput: convs.newContactInput,
      newGroupInput: convs.newGroupInput,
      newChannelInput: convs.newChannelInput,
      channelWorkspaces: channels.channelWorkspaces,
      selectedChannelId: channels.selectedChannelConversationId,
      currentUserId: session.userId,
      onContactInputChange: (v: string) => {
        convs.newContactInput = v;
      },
      onGroupInputChange: (v: string) => {
        convs.newGroupInput = v;
      },
      onChannelInputChange: (v: string) => {
        convs.newChannelInput = v;
      },
      onAddContact: (value?: string) => {
        const c = (value ?? convs.newContactInput).trim();
        if (c) {
          void convs.startNewConversation(c, convCtx());
          convs.newContactInput = '';
        }
      },
      onCreateGroup: (value?: string) => {
        const g = (value ?? convs.newGroupInput).trim();
        if (g) {
          void convs.createNewGroup(g, convCtx());
          convs.newGroupInput = '';
        }
      },
      onCreateChannel: (workspaceId: string, value?: string, visibility?: 'public' | 'private') => {
        const ch = (value ?? convs.newChannelInput).trim();
        if (!ch) return;
        const ws = channels.channelWorkspaces.find((w) => w.id === workspaceId);
        if (ws?.workspaceDbId)
          channels.createNewChannel(ws.workspaceDbId, ch, channelsCtx(), visibility);
        convs.newChannelInput = '';
      },
      onCreateWorkspace: (value?: string) => {
        const wn = (value ?? '').trim();
        if (wn) channels.createNewCommunity(wn, channelsCtx());
      },
      onInviteChannelMember: (
        channelId: string,
        memberId: string,
        roleName: 'member' | 'moderator' | 'admin'
      ) => channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx()),
      onUpdateWorkspaceImage: (workspaceDbId: string, mediaId: string) =>
        void channels.updateCurrentWorkspaceImage(workspaceDbId, mediaId, channelsCtx()),
      onReorderCommunities: (newOrder: typeof channels.channelWorkspaces) =>
        void channels.reorderWorkspaces(newOrder, channelsCtx()),
      onLeaveWorkspace: (workspaceDbId: string) => {
        void channels.leaveCurrentWorkspace(workspaceDbId, channelsCtx());
        if (isSelectedChannel) {
          const ws = channels.channelWorkspaces.find((w) => w.workspaceDbId === workspaceDbId);
          if (ws?.channels.some((c) => c.id === convs.selectedContact))
            convs.selectedContact = null;
        }
      },
      onDeleteWorkspace: (workspaceDbId: string, confirmationName: string) => {
        // Resolve the channel list before the delete purges the workspace from the sidebar.
        const doomedChannelIds =
          channels.channelWorkspaces
            .find((w) => w.workspaceDbId === workspaceDbId)
            ?.channels.map((c) => c.id) ?? [];
        void channels.deleteCurrentWorkspace(workspaceDbId, confirmationName, channelsCtx());
        if (convs.selectedContact && doomedChannelIds.includes(convs.selectedContact)) {
          convs.selectedContact = null;
        }
      },
      onSelectConversation: handleSelectConversation,
      onJoinPrivateChannel: (channelId: string, channelName: string) => {
        // An admin entering a private salon they could only see. Awaited nowhere: the reload it
        // triggers is what re-renders the row, and the toast is what reports either outcome.
        void channels.joinPrivateChannelAsAdmin(channelId, channelName, channelsCtx());
      },
      onSelectChannelConversation: (channelId: string) => {
        // THE RECEIPT IS OWED FOR WHAT WAS THERE TO READ, not for what this device had counted as
        // unread. Read BEFORE selectConversation, which resets the conversation's state; the marker
        // in `channelReadSignal` is what keeps an idle re-open from pushing to ourselves again.
        const readUpTo = newestForeignMessageAt(
          convs.conversations.get(channelId)?.messages ?? [],
          session.userId
        );
        channels.selectedChannelConversationId = channelId;
        convs.selectConversation(channelId);
        void convs.loadHistoryForConversation(channelId, channelId, convCtx());
        if (claimChannelReadSignal(channelId, readUpTo)) {
          void channelService.markChannelRead(channelId);
        }
      },
      onSelectCommunity: () => {
        // Switching community must not keep the previous channel open: clear the selection
        // so the chat area shows nothing until a channel of the new community is picked.
        channels.selectedChannelConversationId = '';
        convs.selectedContact = null;
      },
      // PULL-TO-REFRESH ON THE CONVERSATION LIST, and the one thing the gesture can honestly mean.
      //
      // It used to sleep 600 ms and return - no reconnect, no fetch, nothing - on the reasoning
      // that the visibility-change watchdog would get there eventually. So the spinner reported
      // work that was not happening, and it reported it for a fixed duration unrelated to anything.
      //
      // The list is fed by the WebSocket, so while the socket is up it is ALREADY current and a
      // refresh has no work at all; `canRefresh` below declines the gesture outright rather than
      // spin over nothing. While it is down the backoff ladder is armed but may be up to 30 s from
      // its next rung, and pulling is the user asking for that rung NOW. `attemptReconnect` is
      // exactly that request and is safe to make directly: it clears the armed timer rather than
      // orphaning it, no-ops if an attempt is already in flight or this tab is a follower, and
      // awaits the full post-connect sync - so the spinner lasts precisely as long as the work.
      onRefresh: async () => {
        await session.attemptReconnect(sessionCb());
      },
      canRefresh: () => !session.isWsConnected,
    };
  }

  // ─── Load group members when selected conversation changes ────────────────
  $effect(() => {
    const contact = convs.selectedContact;
    if (!contact || !session.isLoggedIn) return;
    const convo = convs.conversations.get(contact);
    if (!convo?.id) return;
    void convs.loadGroupMembers(convo.id, convCtx());
  });

  // ─── Load channel members when selected channel changes ───────────────────
  $effect(() => {
    const contact = convs.selectedContact;
    if (!contact || !session.isLoggedIn || !isSelectedChannel) {
      selectedChannelMemberIds = [];
      return;
    }
    let cancelled = false;
    channelService
      .listMembers(contact)
      .then((members) => {
        if (cancelled) return;
        selectedChannelMemberIds = members.map((m) => m.userId);
      })
      .catch(() => {
        if (cancelled) return;
        selectedChannelMemberIds = [];
      });
    return () => {
      cancelled = true;
    };
  });

  // ─── Read watermark (debounced 2 s) ───────────────────────────────────────
  let pendingReadWatermark = 0;
  let readReceiptTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (!convs.selectedContact || !session.isLoggedIn) return;
    // THE THIRD TERM IS THE ONLY ONE A PHONE ANSWERS HONESTLY. `hasFocus()` and `visibilityState`
    // are both permanently true in a backgrounded Tauri WebView (measured on device 2026-09-05:
    // a backgrounded app reports `visible` / `hasFocus: true`, byte for byte its foreground
    // answer), so on Android these two said "the user is reading this" about a phone in a pocket -
    // and the sender was told their message had been read. `isAppInForeground` reads the fact the
    // Android activity states for itself, and is `true` everywhere that has a working visibility
    // API, so the two terms above keep deciding web and desktop exactly as before.
    if (!isWindowFocused || !isTabVisible || !isAppInForeground()) return;
    // Channels are server-authoritative and have no MLS group: their read state must never
    // go through the MLS outbox (sendReadWatermark -> enqueueControlEvent), otherwise the flusher
    // loops forever on resolveTerminalGroup/welcome-request 500s for a channel_ conversation id.
    if (isSelectedChannel) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo || convo.lifecycle !== 'active') return;

    const meNorm = session.userId.toLowerCase();
    const held = watermarkFor(convo.readWatermarks, meNorm);
    const target = watermarkAfterReading(convo.messages, held);
    if (target <= held) return;

    const currentContact = convs.selectedContact;

    // Mark it read here and now, on this device, for good: the optimistic update goes into the
    // conversation AND onto disk. It used to be a bare in-memory `conversations.set`, so a reload
    // brought back as unread everything this device had read but no peer had echoed (D2).
    untrack(() => {
      setTimeout(() => {
        const fresh = convs.conversations.get(currentContact);
        if (!fresh) return;
        const merged = mergeReadWatermark(fresh.readWatermarks, meNorm, target);
        if (!merged) return;
        convs.conversations.set(currentContact, { ...fresh, readWatermarks: merged });
        void convs.saveConversation(currentContact, convCtx());
      }, 0);
    });

    pendingReadWatermark = Math.max(pendingReadWatermark, target);

    if (!readReceiptTimer) {
      readReceiptTimer = setTimeout(() => {
        untrack(() => {
          const toSend = pendingReadWatermark;
          pendingReadWatermark = 0;
          readReceiptTimer = null;
          if (toSend <= 0) return;
          // THREE WAYS OUT OF HERE AND ALL THREE USED TO BE SILENT. The debounce has already zeroed
          // `pendingReadWatermark`, so nothing will retry: whatever this device has read up to is
          // lost for the peer, which keeps showing the conversation unread until something else
          // moves the mark. That is a best-effort path, and a line is all a loss leaves behind it.
          try {
            const mlsService = session.ensureMls();
            const fresh = convs.conversations.get(currentContact);
            if (!fresh) {
              console.warn(
                `[READ] watermark ${toSend} dropped: conversation ${currentContact} left the store` +
                  ' between the debounce arming and its expiry, so the receipt is never sent'
              );
              return;
            }
            sendReadWatermark(toSend, {
              mlsService,
              userId: session.userId,
              deviceKeyB64: session.deviceKeyB64,
              conversation: fresh,
            }).catch((e) =>
              console.warn(
                `[READ] watermark ${toSend} for ${currentContact} was not sent - the peer keeps` +
                  ' showing it unread until this device reads again:',
                e
              )
            );
          } catch (e) {
            // The comment here used to READ `/* MLS not ready */` and assert a cause nothing had
            // checked. `session.ensureMls()` is the only call above that can throw, so that reading
            // is probably right - but "probably" is not what a swallowed branch may claim, and the
            // throw itself says it for free.
            console.warn(
              `[READ] watermark ${toSend} for ${currentContact} could not be sent - no MLS client:`,
              e
            );
          }
        });
      }, 2000);
    }

    // Only cancel the timer when the user navigates to a different conversation.
    // Same-conversation re-runs (e.g. from the optimistic update above) must
    // not cancel the pending timer - that was the root cause of receipts never firing.
    return () => {
      if (convs.selectedContact !== currentContact) {
        if (readReceiptTimer) {
          clearTimeout(readReceiptTimer);
          readReceiptTimer = null;
        }
        pendingReadWatermark = 0;
      }
    };
  });

  // ─── Mount: event listeners (window focus, visibility, debug shortcut) ────
  onMount(() => {
    isWindowFocused = document.hasFocus();
    isTabVisible = document.visibilityState === 'visible';

    const handleVisibilityChange = () => {
      isTabVisible = document.visibilityState === 'visible';
    };
    const handleWindowFocus = () => {
      isWindowFocused = true;
    };
    const handleWindowBlur = () => {
      isWindowFocused = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+S: force sync reset (clears device cache and reloads)
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        if (session.isLoggedIn && session.userId) {
          forceSyncReset(session.userId, log);
          log('[INFO] Reloading page in 1s…');
          setTimeout(() => window.location.reload(), 1000);
        }
      }
    };

    const handleKeyboardMediaEvent = (e: Event) => {
      handleKeyboardMedia((e as CustomEvent).detail ?? {});
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('canari-keyboard-media', handleKeyboardMediaEvent);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('canari-keyboard-media', handleKeyboardMediaEvent);
    };
  });

  // ─── Apply pending conversation selection (from cross-page navigation) ────
  $effect(() => {
    if (!session.isLoggedIn) return;
    untrack(() => {
      const pending = sessionStorage.getItem('canari_pending_contact');
      if (pending) {
        sessionStorage.removeItem('canari_pending_contact');
        setTimeout(() => {
          convs.selectConversation(pending);
        }, 600);
      }
    });
  });

  // ─── Reset selection when switching between /chat and /communities ─────────
  // The selection lives in global singletons (globalConvs/globalChannels) that outlive this
  // component, and /chat and /communities are separate route components, so navigating between
  // them remounts MainChatPage. Comparing against the module-scoped lastActiveRouteMode (which
  // survives that remount) lets us clear the stale thread on a genuine tab switch while still
  // preserving a deep-linked selection on the very first mount.
  $effect.pre(() => {
    const mode = routeMode;
    untrack(() => {
      const previous = lastActiveRouteMode;
      lastActiveRouteMode = mode;
      if (previous === null || previous === mode) return;
      // A deep link navigated us here and its target is still landing: this is not a tab switch,
      // and wiping the selection (or the community the sidebar reveals) is what made those land on
      // an empty /communities. Entering the OTHER mode instead means the user walked away from the
      // landing, which ends it.
      const landing = notifNav.pending;
      if (landing) {
        if (selectionBelongsToRoute(landing, mode)) return;
        notifNav.clear();
      }
      // Same reasoning for a target already selected: a genuine tab switch never carries a
      // selection that belongs to the mode being entered.
      if (selectionBelongsToRoute(convs.selectedContact, mode)) return;
      if (readReceiptTimer) {
        clearTimeout(readReceiptTimer);
        readReceiptTimer = null;
      }
      pendingReadWatermark = 0;
      convs.selectedContact = null;
      channels.selectedChannelConversationId = '';
      convs.isChannelSettingsModalOpen = false;
      convs.isChannelMembersDrawerOpen = false;
      convs.sendError = '';
      messageText = '';
    });
  });

  /** Opens a discussion and loads/decrypts its history (same as channel selection). */
  function handleSelectConversation(name: string) {
    convs.selectConversation(name);
    const convo = convs.conversations.get(name);
    if (convo?.id) {
      void convs.loadHistoryForConversation(name, convo.id, convCtx());
    }
  }

  // ─── Thin forwarding helpers (keep template free of logic) ────────────────

  /**
   * Sends `text`, and makes sure a failure on the way cannot vanish.
   *
   * `void promise` DISCARDS A REJECTION, and this is the send path. `sendChatMessage` writes the
   * optimistic echo and then awaits `enqueueOutboxMessage` with no `catch` of its own, so an
   * IndexedDB transaction that aborts rejects all the way up to here - where the promise was thrown
   * away. The user then sees the composer empty (it is cleared synchronously below, without waiting
   * for the enqueue), a bubble stuck on `pending`, no error, and NOTHING in the log: a message they
   * wrote, believe sent, and that no durable queue ever received. That is the one failure the
   * outbox cannot survive, because it is the one it never hears about.
   *
   * The catch does not restore the text - the echo is already on screen and pulling it back would
   * be a second surprise. It says so, out loud, on both surfaces: the error banner the media path
   * already uses, and the log, because a best-effort path that swallows leaves nothing else behind.
   */
  function sendText(text: string) {
    void messaging.handleSendChat(msgCtx(), text).catch((e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e);
      convs.sendError = m.chat_send_error({ reason });
      log(`[SEND] handleSendChat threw - the message was NOT queued: ${reason}`);
    });
  }

  /** Sends the current messageText via MLS then clears the input. */
  function handleSendChat() {
    sendText(messageText);
    messageText = '';
  }

  /** Forwards selected files to the messaging composable for upload. */
  function handleFilesSelected(files: File[]) {
    void messaging.handleFilesSelected(files, msgCtx());
  }

  /**
   * Handles rich content committed by the soft keyboard (e.g. a Gboard GIF), delivered by
   * the native KeyboardMediaBridge (Android `InputConnection.commitContent`, iOS `UIPasteboard`
   * polling) as a `canari-keyboard-media` event. Rebuilds a File from the base64 payload and
   * routes it through the normal media pipeline (encrypted upload), so a keyboard GIF behaves
   * exactly like a picked file - in DMs, groups, and channels alike.
   */
  function handleKeyboardMedia(detail: { mime?: string; name?: string; data?: string }) {
    if (!convs.selectedContact || !detail?.data) return;
    try {
      const bin = atob(detail.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = detail.mime || 'image/gif';
      const name = detail.name || `gif-${Date.now()}.${mime.split('/')[1] ?? 'gif'}`;
      handleFilesSelected([new File([bytes], name, { type: mime })]);
    } catch (e) {
      appendLog(`[keyboard-media] failed to handle committed content: ${e}`);
    }
  }

  /** Opens the forward picker for a given message. */
  function handleForward(message: ChatMessage) {
    forwardingMessage = message;
  }

  /**
   * Forwards the pending message to the conversation chosen in the modal. `targetLabel` comes from
   * the picker rather than `conversation.name`, which for a DM is the peer's raw user id and would
   * put a 64-char hash in the confirmation toast.
   */
  async function doForward(targetKey: string, _target: Conversation, targetLabel: string) {
    const message = forwardingMessage;
    forwardingMessage = null;
    if (!message) return;
    const result = await messaging.forwardMessage(message.content, targetKey, msgCtx());
    if (result.success) {
      showToast(m.chat_message_forwarded({ name: targetLabel }), 'info');
    } else {
      showToast(result.error ?? m.chat_forward_error_fallback(), 'error');
    }
  }

  /**
   * Routes a throttled typing signal to the right transport for the active
   * conversation: gateway WS for DMs/groups (keyed by the MLS groupId), social
   * HTTP for community channels. Best-effort - failures are ignored.
   */
  function handleTyping(isTyping: boolean) {
    const key = convs.selectedContact;
    if (!key) return;
    if (isSelectedChannel) {
      void channelService.sendTyping(key, isTyping);
      return;
    }
    const convo = convs.conversations.get(key);
    if (!convo?.id) return;
    Promise.resolve(session.ensureMls())
      .then((m) => m?.sendTyping?.(convo.id, isTyping))
      .catch(() => {});
  }

  /**
   * Loads the conversation's shared media/links/files from the FULL local history
   * (IndexedDB/SQLite), for the "Médias, liens & fichiers" panel.
   */
  async function loadSharedContent(conversationId: string): Promise<SharedContent> {
    // Community channels don't persist messages locally (skipDbSave), so aggregate from
    // the in-memory loaded messages. DMs/groups use the full local history from storage.
    if (isChannelConversationId(conversationId)) {
      const convo = convs.conversations.get(conversationId);
      const msgs = (convo?.messages ?? []).map((m) => ({
        id: m.id,
        senderId: m.senderId,
        timestamp: m.timestamp.getTime(),
        content: m.content,
        isDeleted: m.isDeleted,
      }));
      return aggregateSharedContent(msgs);
    }
    if (!session.storage) return { media: [], files: [], links: [] };
    const msgs = await session.storage.getMessages(conversationId, session.deviceKeyB64);
    return aggregateSharedContent(msgs);
  }

  /**
   * Full-conversation search returning matching message IDs oldest-first: over the local store for
   * DMs/groups, and over the full decrypted server history for channels (which are not persisted
   * locally). Returns null only when no source is available, so the UI falls back to the in-memory
   * loaded messages.
   */
  async function searchConversation(
    conversationId: string,
    query: string
  ): Promise<string[] | null> {
    const q = foldForSearch(query.trim());
    if (q.length < 2) return [];
    // Channels are not persisted locally: search their full server history (decrypt + match),
    // which also merges older hits into the view so the UI can scroll to them.
    if (isChannelConversationId(conversationId)) {
      return convs.searchChannelHistory(conversationId, query, convCtx());
    }
    if (!session.storage) return null;
    const msgs = await session.storage.getMessages(conversationId, session.deviceKeyB64);
    return msgs
      .filter((m) => !m.isDeleted && foldForSearch(messageSearchText(m.content)).includes(q))
      .map((m) => m.id);
  }

  function messageSearchText(content: string): string {
    try {
      return getPreviewText(parseEnvelope(content));
    } catch {
      return content;
    }
  }

  /**
   * Toggles a message's pinned state, routing to the right transport: server pin for
   * community channels (with optimistic local apply + revert on failure), MLS `pin`/`unpin`
   * system message for DMs/groups.
   */
  function handleTogglePinMessage(messageId: string) {
    const key = convs.selectedContact;
    if (!key) return;
    const convo = convs.conversations.get(key);
    if (!convo) return;
    if (isSelectedChannel) {
      const next = !isMessagePinned(convo.id, messageId);
      applyPin(convo.id, messageId, next, Date.now());
      void channelService.setMessagePinned(convo.id, messageId, next).catch(() => {
        // Revert if the server rejects. A LATER instant, or the revert would not supersede the
        // optimistic apply it exists to undo.
        applyPin(convo.id, messageId, !next, Date.now());
      });
    } else {
      void messaging.handleTogglePin(messageId, msgCtx());
    }
  }

  // Load the channel's pinned-message set from the server when a channel is opened.
  $effect(() => {
    const key = convs.selectedContact;
    if (!key || !isSelectedChannel) return;
    void channelService
      .listPinnedMessageIds(key)
      .then((ids) => setPinnedSet(key, ids))
      .catch(() => {});
  });

  /** Sends a picked GIF as a message (its direct URL is rendered inline as a GIF). */
  function handleSendGif(url: string) {
    sendText(url);
  }

  /** Encrypts and sends a community poll in the currently selected channel. */
  async function handleCreatePoll(draft: ChannelPollDraft) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    await sendChannelPoll(channelId, draft);
  }

  /** Casts (or retracts) the user's vote on a channel poll, optimistically then authoritatively. */
  async function handleVotePoll(messageId: string, optionIds: string[]) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    applyLocalVote(messageId, session.userId, optionIds);
    try {
      const meta = await channelService.votePoll(channelId, messageId, optionIds);
      setPollMeta(messageId, meta);
    } catch (e) {
      showToast(
        `${m.channel_poll_vote_error()} : ${e instanceof Error ? e.message : m.common_error_heading()}`,
        'warning'
      );
    }
  }

  /** Closes the caller's own channel poll early (server forces the deadline). */
  async function handleClosePoll(messageId: string) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    try {
      const meta = await channelService.closePoll(channelId, messageId);
      setPollMeta(messageId, meta);
    } catch (e) {
      showToast(
        `${m.channel_poll_close_error()} : ${e instanceof Error ? e.message : m.common_error_heading()}`,
        'warning'
      );
    }
  }

  /** Opens the community behind an invitation card ("Rejoindre la communauté"). */
  function handleJoinChannel(channelId: string) {
    void openInvitedChannel(channelId);
  }

  /** Starts a voice or video call when the conversation is a group or DM (not a channel). */
  function startCallForCurrentConversation(video: boolean) {
    if (!session.callService || !convs.selectedContact) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo) return;
    const type = convo.conversationType ?? 'group';
    if (type === 'channel') return;
    if (convo.lifecycle !== 'active') {
      showToast(m.chat_call_session_not_ready(), 'warning');
      return;
    }
    session.callService.startCall(convo.id, video).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Groupe introuvable') || msg.includes('Group not found')) {
        showToast(m.chat_call_group_desynced());
      } else {
        showToast(m.chat_call_error({ msg }));
      }
    });
  }
</script>

<!--
  WHICH PAGE IS MOUNTED, published rather than inferred from the URL. `location.pathname` changes
  when SvelteKit STARTS a navigation and this component swaps after it, so for a moment the address
  says `/communities` while the `/chat` document is still on screen - and both pages render a
  sidebar with the same rows, so nothing in the DOM told the two apart. An instrument that read the
  URL and then clicked found the element it wanted on the page it was leaving, clicked into the
  swap, and reported `no stable element` about a screen where the thing was plainly there
  (`openChannel`, 2026-09-05). Same one-attribute cost as `data-conversation-tile`, same reason.
-->
<div class="app-layout" data-route-mode={routeMode} in:fade>
  {#if session.isLoggedIn}
    <!-- NO BANNERS HERE ANY MORE, and the two that were are why this comment exists. Both said what
         another banner was already saying: "En attente de connexion" duplicated `OfflineBanner` at
         the window scale (offline raised BOTH, three seconds apart), and the synchronisation strip
         duplicated `ChatArea`'s, driven by the very same `isCatchupOverlayVisible` - so they never
         appeared apart. Worse, both sat IN THE FLOW: raising one shoved the whole application down
         29 px and dropping it snapped everything back, which on 2026-08-14 delivered a click aimed
         at a channel row to the button below it. One fact, one banner, at one scale. -->
    <main class="main-content">
      <!-- Desktop sidebar (always mounted, hidden on mobile when chat is open) -->
      <Sidebar {...makeSidebarCommonProps()} isHidden={convs.mobileView === 'chat'} />

      <svelte:boundary onerror={(e) => appendLog(`[UI] ChatArea error recovered: ${e}`)}>
        {#snippet failed(_error, reset)}
          <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
          >
            <p class="text-text-muted text-sm">{m.chat_area_error_message()}</p>
            <button
              type="button"
              onclick={reset}
              class="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white"
            >
              {m.common_retry_button()}
            </button>
          </div>
        {/snippet}
        <ChatArea
          currentUserId={session.userId}
          conversation={activeConversation}
          {messageText}
          isChannel={isSelectedChannel ?? false}
          imageMediaId={activeConversation?.imageMediaId ?? null}
          onMessageChange={(value) => (messageText = value)}
          onSend={handleSendChat}
          onTyping={handleTyping}
          onSendGif={handleSendGif}
          onCreatePoll={isSelectedChannel ? handleCreatePoll : undefined}
          onVotePoll={isSelectedChannel ? handleVotePoll : undefined}
          onClosePoll={isSelectedChannel ? handleClosePoll : undefined}
          onLoadSharedContent={loadSharedContent}
          onSearchAll={searchConversation}
          onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
          onBack={() => {
            channels.selectedChannelConversationId = '';
            convs.goBackToMenu();
          }}
          onOpenConversations={convs.openConversationDrawer}
          onOpenSettings={isSelectedChannel
            ? () => (convs.isChannelSettingsModalOpen = true)
            : undefined}
          isHidden={convs.mobileView === 'list'}
          onJoinChannel={handleJoinChannel}
          isLoadingHistory={convs.isLoadingHistory}
          isCatchingUpMessages={messaging.isMessageCatchupActive}
          isCatchupAnnounced={messaging.isCatchupOverlayVisible}
          groupMembers={convs.groupMembers}
          pendingInvites={convs.pendingGroupInvites}
          allowedUserIds={composerAllowedUserIds}
          canWrite={canWriteToSelectedChannel}
          sendError={convs.sendError}
          onGroupRename={(name) => void convs.handleRenameGroup(name, convCtx())}
          onGroupSetImage={(mediaId) => void convs.handleSetGroupImage(mediaId, convCtx())}
          onGroupDelete={() => void convs.handleDeleteGroup(convCtx())}
          onGroupDeleteLocally={() => void convs.handleDeleteGroupLocally(convCtx())}
          onGroupLeave={() => void convs.handleLeaveGroup(convCtx())}
          onGroupRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
          messageReactions={isSelectedChannel ? channelReactions : messaging.messageReactions}
          replyingTo={messaging.replyingTo}
          onReply={messaging.handleReply}
          onForward={handleForward}
          onReact={isSelectedChannel
            ? (msgId, emoji) =>
                void channels.toggleChannelReaction(
                  convs.selectedContact ?? '',
                  msgId,
                  emoji,
                  channelsCtx()
                )
            : (msgId, emoji) => void messaging.handleAddReaction(msgId, emoji, msgCtx())}
          canModerate={canModerateSelectedChannel}
          onDelete={isSelectedChannel
            ? (msgId) =>
                void channels.deleteChannelMessage(
                  convs.selectedContact ?? '',
                  msgId,
                  channelsCtx()
                )
            : (msgId) => void messaging.handleDeleteMessage(msgId, msgCtx())}
          onEdit={isSelectedChannel
            ? undefined
            : (msgId, text) => void messaging.handleEditMessage(msgId, text, msgCtx())}
          onTogglePin={handleTogglePinMessage}
          onCancelReply={messaging.cancelReply}
          authToken={session.authToken}
          onFilesSelected={handleFilesSelected}
          pendingFiles={messaging.pendingMediaFiles}
          onRemovePendingFile={messaging.removePendingMediaFile}
          isUploading={messaging.isUploadingMedia}
          onStartAudioCall={CALLS_ENABLED
            ? () => {
                void startCallForCurrentConversation(false);
              }
            : undefined}
          onStartVideoCall={CALLS_ENABLED
            ? () => {
                void startCallForCurrentConversation(true);
              }
            : undefined}
          onOpenMembers={routeMode === 'communities' && isSelectedChannel
            ? convs.toggleChannelMembersDrawer
            : undefined}
          membersActive={convs.isChannelMembersDrawerOpen}
          onLoadOlderMessages={() => convs.loadOlderMessages(convs.selectedContact!, convCtx())}
          onRequestOlderFromPeers={() =>
            convs.requestOlderFromPeers(convs.selectedContact!, convCtx())}
          onMessagesScrollEl={(el) => {
            convs.chatContainer = el ?? undefined;
          }}
        />
      </svelte:boundary>

      {#if routeMode === 'communities'}
        {#if channels.selectedChannelConversationId}
          <ChannelMembersSidebar
            currentUserId={session.userId}
            selectedChannelId={channels.selectedChannelConversationId}
            isOpen={convs.isChannelMembersDrawerOpen}
          />
        {/if}

        {#if convs.isChannelMembersDrawerOpen}
          <button
            type="button"
            class="fixed inset-0 z-40 bg-black/30 xl:hidden"
            aria-label={m.chat_close_members_panel_aria()}
            onclick={convs.closeChannelMembersDrawer}
          ></button>
          <div
            class="border-cn-border fixed top-0 right-0 bottom-0 z-50 w-[90vw] max-w-sm border-l bg-[color-mix(in_srgb,var(--cn-surface)_90%,white)] shadow-2xl xl:hidden"
          >
            <ChannelMembersSidebar
              mode="mobile"
              currentUserId={session.userId}
              onClose={convs.closeChannelMembersDrawer}
              selectedChannelId={channels.selectedChannelConversationId}
            />
          </div>
        {/if}
      {/if}

      <!-- Mobile drawer sidebar (mounted only when the drawer is open) -->
      {#if convs.isConversationDrawerOpen}
        <Sidebar
          {...makeSidebarCommonProps()}
          isHidden={false}
          drawerMode={true}
          onCloseDrawer={convs.closeConversationDrawer}
        />
      {/if}

      <ChannelSettingsModal
        open={convs.isChannelSettingsModalOpen}
        onClose={() => (convs.isChannelSettingsModalOpen = false)}
        selectedChannelId={channels.selectedChannelConversationId}
        channelWorkspaces={channels.channelWorkspaces}
        onRenameChannel={(channelId, newName) =>
          channels.renameCurrentChannel(channelId, newName, channelsCtx())}
        onDeleteChannel={(channelId) => {
          void channels.deleteCurrentChannel(channelId, channelsCtx());
          if (convs.selectedContact === channelId) convs.selectedContact = null;
        }}
        onLeaveChannel={(channelId) => {
          void channels.leaveCurrentChannel(channelId, channelsCtx());
          if (convs.selectedContact === channelId) convs.selectedContact = null;
        }}
      />

      <ForwardMessageModal
        open={!!forwardingMessage}
        conversations={[...convs.conversations.entries()]}
        excludeKey={convs.selectedContact}
        currentUserId={session.userId}
        channelWorkspaces={channels.channelWorkspaces}
        onClose={() => (forwardingMessage = null)}
        onSelect={doForward}
      />
    </main>
  {:else}
    <main class="main-content" aria-hidden="true"></main>
  {/if}

  {#if isMessagingBlocked}
    <MessagingSyncOverlay message={messagingOverlayMessage} />
  {/if}
</div>

<style>
  .app-layout {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    width: 100%;
  }

  .main-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }
</style>
