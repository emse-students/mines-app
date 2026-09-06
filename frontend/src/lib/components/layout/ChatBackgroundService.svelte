<script lang="ts">
  /**
   * Always-on layout component for the MLS session lifecycle.
   *
   * Responsibilities:
   * - MLS session + WebSocket initialization (PIN, biometrics).
   * - WS reconnection on page visibility changes.
   * - Global UI: PIN modal, call overlay, channel invite notices, biometric enrollment prompt.
   *
   * Uses global singletons (globalChatSingleton.svelte.ts) so the connection
   * persists across all routes, not only /chat.
   */
  import { onMount, untrack } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { m } from '$lib/paraglide/messages';
  import { BiometricService } from '$lib/services/biometric';
  import {
    loadDeviceKey,
    isDeviceKeyPersistenceEnabled,
    setDeviceKeyPersistence,
  } from '$lib/utils/deviceKeyVault';
  import { isBiometricPromptDismissed } from '$lib/composables/session/sessionBiometrics';
  import {
    isRecoverableWithOldPin,
    type LoginErrorCode,
  } from '$lib/composables/session/loginErrors';
  import {
    getToken,
    clearAuth,
    setSessionExpiredHandler,
    isRefreshCredentialProvenDead,
  } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import {
    globalSession,
    globalConvs,
    globalMessaging,
    globalChannels,
    globalNotifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { resolveDisplayNames } from '$lib/utils/users/displayName';
  import { serializeEnvelope, mkSystemEnvelope } from '$lib/envelope';
  import type { ChatMessage } from '$lib/types';
  import PinModal from '$lib/components/auth/PinModal.svelte';
  import ChangePinModal from '$lib/components/auth/ChangePinModal.svelte';
  import BiometricBottomSheet from '$lib/components/auth/BiometricBottomSheet.svelte';
  import BiometricEnrollSheet from '$lib/components/auth/BiometricEnrollSheet.svelte';
  import { biometricPrompt } from '$lib/stores/biometricPrompt.svelte';
  import CallOverlay from '$lib/components/chat/CallOverlay.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { removalOutcome } from '$lib/utils/chat/memberRemoval';
  import type { ConversationContext } from '$lib/composables/useConversations.svelte';
  import type { WorkspacePurgeContext } from '$lib/composables/useChannelWorkspaces.svelte';
  import type { MessagingContext } from '$lib/composables/useMessaging.svelte';
  import type { BulkIngestPhase } from '$lib/mls-client';
  import { Phone, PhoneOff, Video } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { IStorage, StoredMessage } from '$lib/db';
  import { deliveryUrl } from '$lib/utils/apiUrl';
  import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
  import { reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
  import {
    refreshAppVersionCheck,
    shouldBlockSessionUnlock,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import type { CallParticipant } from '$lib/services/CallService';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import {
    openNotificationTarget,
    resolveConversationKey,
  } from '$lib/utils/chat/openConversationFromId';
  import {
    chatDeepLinkRoute,
    landingAfterRefresh,
    landingRecovery,
    openInvitedChannel,
  } from '$lib/utils/chat/notificationRouting';
  import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
  import { setGraineRepairListener } from '$lib/utils/graine/runtime';
  import { channelService } from '$lib/services/ChannelService';
  import { drainNativePendingCallAccept } from '$lib/stores/pendingCallAccept';
  import { warnIfSiblingDeviceInCall } from '$lib/utils/callPresence';
  import { CALLS_ENABLED } from '$lib/features';
  import { mergeFcmMessagesIntoConversations } from '$lib/utils/chat/fcmMemoryMerge';
  import { subscribeTabMessageUpdates } from '$lib/mls-client/tabMessageSync';
  import { flushActiveMlsStateEncrypted } from '$lib/mls-client/mlsStatePersisterRegistry';
  import { insertMessageOrdered } from '$lib/utils/chat/messageOrder';

  /** Remote users to show on the call overlay (avatars / labels), excluding the local user. */
  function buildRemoteCallParticipants(): CallParticipant[] {
    const uid = (globalSession.userId || currentUserId() || '').toLowerCase();
    const convo = globalConvs.currentConvo;
    const callerId = globalSession.callService?.incomingCallerId?.toLowerCase();

    if (!convo) {
      if (callerId && callerId !== uid) {
        return [{ userId: callerId, displayName: getUserDisplayNameSync(callerId) }];
      }
      return [];
    }

    const pres = resolveConversationListPresentation(
      {
        id: convo.id,
        name: convo.name,
        contactName: convo.contactName,
        conversationType: convo.conversationType,
        directPeerId: convo.directPeerId,
      },
      uid
    );

    if (pres.conversationType === 'direct') {
      const peer = pres.contactId.toLowerCase();
      if (!peer || peer === uid) return [];
      return [{ userId: peer, displayName: pres.displayName }];
    }

    return globalConvs.groupMembers
      .map((m) => m.toLowerCase())
      .filter((m) => m && m !== uid)
      .map((m) => ({ userId: m, displayName: getUserDisplayNameSync(m) }));
  }

  let callRemoteParticipants = $derived.by(buildRemoteCallParticipants);

  /** Whether the current route is the chat page (where the full call overlay is native). */
  let isOnChatPage = $derived(
    typeof window !== 'undefined' && $page.url.pathname.startsWith('/chat')
  );

  /** When NOT on the chat page, show a compact incoming-call toast instead of the full hero screen. */
  let showIncomingToast = $derived(globalSession.callState === 'incoming' && !isOnChatPage);

  /** Last call id we started ringing for (dedupes effect re-runs). */
  let lastIncomingRingCallId = $state<string | null>(null);

  /** Ring + OS notification when an MLS call invite arrives (any route). */
  $effect(() => {
    const state = globalSession.callState;
    const callId = globalSession.callService?.currentCallId ?? null;
    const groupId = globalSession.callService?.currentGroupId ?? null;
    const callerId = globalSession.callService?.incomingCallerId ?? null;

    if (state === 'incoming' && callId && groupId) {
      if (lastIncomingRingCallId !== callId) {
        lastIncomingRingCallId = callId;
        const callerName = getUserDisplayNameSync(callerId ?? '');
        globalNotifs.startIncomingCallRingtone();
        globalNotifs.startBlinkingTitle();
        void globalNotifs.notifyIncomingCall(callerName, groupId);
      }
      return;
    }

    if (lastIncomingRingCallId !== null) {
      lastIncomingRingCallId = null;
    }
    globalNotifs.stopIncomingCallRingtone();
    globalNotifs.stopBlinkingTitle();
    // Call left the "incoming" state (answered on any device, declined, or ended):
    // dismiss the lingering incoming-call OS notification.
    void globalNotifs.dismissIncomingCall();
  });

  /**
   * Notification target we have already routed to /chat for. Plain (non-reactive) so updating
   * it never re-triggers the effect; it only dedupes the one-shot navigation per pending target.
   */
  let lastNavigatedNotifTarget: string | null = null;

  /**
   * Pending channel target we already refetched the sidebar for. A just-accepted invitation (card
   * or link) names a channel that is not in the loaded list yet, and `openNotificationTarget`
   * refuses a channel it cannot find - so without one refresh the arrival selects nothing and the
   * join looks like it did nothing. Guarded per target so a genuinely unknown channel (revoked
   * access, deleted community) cannot loop on the endpoint.
   */
  let refreshedWorkspacesForTarget: string | null = null;

  /**
   * Lands the deep-link target: routes to the view that can show it, then selects it.
   *
   * Owns the landing for the whole app - `MainChatPage` deliberately does not duplicate it, since
   * both read the same `globalConvs`/`globalChannels` singletons.
   *
   * The target is held until it is actually displayed, and this effect re-runs on every mutation
   * of the conversations map, so a selection dropped by the IndexedDB restore or by a community
   * prune is re-asserted instead of being lost. It stays idle once the target is on screen, or a
   * plain incoming message would re-select it and refetch its history.
   */
  $effect(() => {
    const id = notifNav.pending;
    if (!id || !globalSession.isLoggedIn) return;
    // Route to the view that can show this target once per pending id. hooks.client.ts also routes,
    // but on a cold start that goto can fire before the SvelteKit router is ready and silently
    // no-op, leaving the user on the home feed. This effect runs post-mount (router ready) and
    // re-runs as login completes / conversations load, so it reliably reaches the right route and
    // selects the target. Community channels live under /communities, DMs/groups under /chat.
    const targetRoute = chatDeepLinkRoute(id);
    if (lastNavigatedNotifTarget !== id) {
      lastNavigatedNotifTarget = id;
      if (window.location.pathname !== targetRoute) {
        appendLog(`[notifNav] routing to ${targetRoute} for pending conversation ${id}`);
        void goto(targetRoute);
      }
    }
    // Already on screen: the landing is done and must stay idle until the target is lost. The
    // selection is a map key and the target is a group id, so they are only ever equal for a
    // channel - matched raw, a landed DM never looked landed, and every mutation of the map
    // re-selected it and re-requested its history.
    const displayedKey = resolveConversationKey(globalConvs.conversations, id);
    if (displayedKey !== null && globalConvs.selectedContact === displayedKey) return;

    if (
      openNotificationTarget(
        globalConvs,
        convCtx(),
        id,
        (channelId) => (globalChannels.selectedChannelConversationId = channelId)
      )
    ) {
      return;
    }
    const recovery = landingRecovery({
      isChannel: isChannelConversationId(id),
      alreadyRefreshed: refreshedWorkspacesForTarget === id,
      conversationsRestored: globalConvs.conversationsRestored,
    });
    if (recovery === 'wait') return;
    if (recovery === 'abandon') {
      appendLog(`[notifNav] conversation ${id} not on this device - abandoning`);
      notifNav.clear();
      return;
    }

    // Unresolved channel: refetch the communities once, then let this effect re-run on the
    // resulting conversation update and select it.
    refreshedWorkspacesForTarget = id;
    appendLog(`[notifNav] channel ${id} unknown - refreshing communities before selecting`);
    void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx()).then((refreshRan) => {
      if (notifNav.pending !== id) return;
      const loadError = globalChannels.workspacesLoadError;
      const outcome = landingAfterRefresh({
        refreshRan,
        targetLoaded: globalConvs.conversations.has(id),
        refreshFailed: loadError !== null,
      });
      // Our refetch never ran, or ran and failed: allow one more once it settles. On a failure the
      // online/foreground listener reloads on its own, and this effect re-runs on the result.
      if (outcome === 'retry') {
        refreshedWorkspacesForTarget = null;
        if (loadError)
          appendLog(`[notifNav] channel ${id} refresh failed (${loadError}) - holding`);
      }
      if (outcome !== 'abandon') return;
      appendLog(`[notifNav] channel ${id} still unknown after refresh - abandoning`);
      notifNav.clear();
    });
  });

  /** Load MLS group members while a group call is active so all avatars can be shown. */
  $effect(() => {
    if (globalSession.callState === 'idle' || !globalSession.isLoggedIn) return;
    const groupId = globalSession.callService?.currentGroupId;
    const convo = globalConvs.currentConvo;
    if (!groupId || !convo || (convo.conversationType ?? 'group') === 'direct') return;
    void globalConvs.loadGroupMembers(groupId, convCtx());
  });

  let showPinModal = $state(false);
  /** True when the user has no prior MLS device on this browser - shown as "choose your PIN". */
  let isFirstPinSetup = $state(false);
  let pinError = $state('');
  let pinLoading = $state(false);
  let pinStep = $state('');
  let biometricConfigured = $state(false);
  // "Stay signed in" opt-in (browser only): persists the PIN vault across browser restarts.
  // Offered on the PIN modal; initialised from the stored preference so it reflects a prior choice.
  // Disabled once biometrics are configured, because the saved PIN would never be used (the
  // biometric flow takes over at the next launch).
  let showStaySignedIn = $derived(!biometricConfigured);
  let pinStaySignedIn = $state(isDeviceKeyPersistenceEnabled());

  // Post-login biometric enrolment offer sheet (Tauri only)
  let showBiometricEnrollSheet = $state(false);
  let biometricCheckedForEnrollment = $state(false);

  // "PIN changed on another device" recovery (offered on a mismatch when local state exists).
  let canRecoverPin = $state(false);
  let showRecoverModal = $state(false);
  let recoverError = $state('');
  let recoverLoading = $state(false);
  let recoverProgress = $state<import('$lib/utils/chat/pinChange').PinOperationProgress | null>(
    null
  );

  /**
   * Enables the recovery link when a local MLS state exists and the failure is either a
   * PIN mismatch (tried the old PIN) or the explicit "PIN changed on another device"
   * signal (tried the new PIN but the local state is still sealed under the old one).
   *
   * Branches on the machine-readable {@link LoginErrorCode}, never on the message: the
   * message is localized, so a regex over it stops matching as soon as the locale changes.
   */
  async function evaluateRecoverable(uid: string, code: LoginErrorCode | undefined) {
    if (!uid || !code || !isRecoverableWithOldPin(code)) {
      canRecoverPin = false;
      return;
    }
    try {
      const { loadMlsState } = await import('$lib/utils/hex');
      canRecoverPin = !!(await loadMlsState(uid));
    } catch {
      canRecoverPin = false;
    }
  }

  /** Opens the recovery modal (old PIN → new PIN, no data loss). */
  function handleOpenRecover() {
    recoverError = '';
    showRecoverModal = true;
  }

  /** Runs the cross-device PIN recovery, then closes the modals on success. */
  async function handleRecoverSubmit(oldPin: string, newPin: string) {
    recoverError = '';
    recoverLoading = true;
    recoverProgress = { percent: 0, stage: 'verify' };
    let failMsg = '';
    try {
      await globalSession.recoverPin(
        { ...sessionCb(), onLoginFailed: (m: string) => (failMsg = m), onMlsReady: () => {} },
        oldPin,
        newPin,
        (progress) => {
          recoverProgress = progress;
        }
      );
      if (!globalSession.isLoggedIn) {
        throw new Error(failMsg || 'Login failed after recovery.');
      }
      showRecoverModal = false;
      showPinModal = false;
      canRecoverPin = false;
      pinError = '';
    } catch (e) {
      recoverError = e instanceof Error ? e.message : String(e);
    } finally {
      recoverLoading = false;
      recoverProgress = null;
    }
  }

  let showBiometricSheet = $state(false);
  /** Lets startLoginFlow() know the user chose "use the PIN code" rather than biometrics on
   *  the BiometricBottomSheet. */
  let biometricCancelled = $state(false);

  function onBiometricSkip() {
    biometricCancelled = true;
    showBiometricSheet = false;
  }

  /**
   * Returns false when the encryption PIN must not be asked for at all.
   *
   * Two independent facts refuse it, and both are known BEFORE the keypad is mounted. The platform
   * gates - minimum version, maintenance - refuse an unlock the server would not honour. The dead
   * refresh credential refuses one the client cannot use: a correct PIN would unlock MLS state for
   * a session that is already over, and the user would be redirected to the login gate a second
   * later having typed a secret for nothing (measured on W1, 2026-08-28).
   *
   * Named for the question rather than for one of its two answers, because it is now both.
   */
  async function mayPromptForPin(): Promise<boolean> {
    if (isRefreshCredentialProvenDead()) {
      appendLog('[platform] PIN prompt declined - refresh credential already proven dead.');
      return false;
    }
    await refreshAppVersionCheck();
    if (shouldBlockSessionUnlock(isGlobalAdmin())) {
      appendLog('[platform] MLS unlock blocked (maintenance or minimum version gate)');
      return false;
    }
    return true;
  }

  /** Opens the PIN modal for the given user, computing isFirstSetup from the server. */
  async function openPinModal(uid: string) {
    if (!(await mayPromptForPin())) return;
    globalSession.userId = uid;
    isFirstPinSetup = await detectFirstPinSetup(uid);
    showPinModal = true;
  }

  /**
   * Called when the session is definitively dead (refresh cookie expired/revoked). Rather
   * than leave a "Session expired" message stuck in the PIN modal - which strands the user
   * with no clear action - close the modal, clear the auth state, and redirect straight to
   * the login page so they can sign in again.
   */
  async function handleSessionExpired() {
    // RELEASING THIS CALLER IS NOT THE LOGOUT, AND DEDUPLICATING THEM TOGETHER SILENCED THE
    // TRIGGER. `_sessionExpiredHandled` answers "has a logout already run for this expiry" -
    // several observers reach the same verdict at once (the global notifier, the promotion path, a
    // login attempt) and one logout is enough. It was also, wrongly, gating the part that releases
    // whoever is waiting RIGHT NOW, and those two have different lifetimes: the first is true once
    // per expiry, the second is true again on every single submit.
    //
    // Measured on W1, 2026-08-28. The session had expired earlier, so the guard was already set.
    // A PIN submit then ran `loginImpl` -> `getToken()` -> `refresh()`, which is latched once a
    // 401 has proven the cookie dead, threw `SessionExpiredError`, and reached here - where this
    // function returned at the guard without touching the modal. `handlePinSubmit` clears its
    // watchdog on `onMlsReady` and `onLoginFailed` only, so nothing cleared it: ten seconds later
    // the spinner was unblocked with "Le deverrouillage prend plus de temps que prevu. Veuillez
    // reessayer." - an invented cause, and advice that can never work, since the latch is
    // permanent by design and only a fresh credential clears it. The client's own log said exactly
    // what had happened; the modal said something else.
    //
    // So the release is unconditional and runs first. Every line of it is idempotent.
    dismissAuthPrompts();
    pinError = '';
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;

    if (_sessionExpiredHandled) {
      // NOT A SILENT RETURN. This is the branch that used to swallow the whole event, and the only
      // trace it can leave is this line.
      appendLog('[AUTH] Session expired again - the logout already ran; released the PIN modal.');
      return;
    }
    _sessionExpiredHandled = true;
    appendLog('[AUTH] Session expired - logging out and redirecting to /login.');
    await clearAuth().catch(() => {});
    void goto('/login', { replaceState: true });
  }

  /**
   * The PIN gate's way out, and the ONE that destroys nothing.
   *
   * The gate stopped being dismissible on 2026-09-05 (see the comment on `PinModal.svelte`), which
   * makes an exit mandatory rather than optional: without one, a person who has forgotten their PIN
   * has only the destructive reset, and a modal that cannot be closed and offers nothing but "erase
   * my message history" is a softlock with a button on it.
   *
   * IT IS THE APP'S ORDINARY SIGN-OUT, deliberately - `clearAuth()` then `/login`, the same two
   * lines the navbar's logout runs. `clearAuth` ends the session on the server, drops the access
   * token, the refresh credential and the persisted ACKs, and touches NOTHING that a PIN protects:
   * `mls.bin`, the message database and the device key vault are all still there afterwards. The
   * user asked for exactly this ("deconnecter seulement, garder l'etat"), and it is what makes the
   * exit safe to offer without a confirmation step.
   *
   * THE GATE COMES DOWN LAST, which is the opposite order to `handleSessionExpired` and for the
   * opposite reason. There, callers are blocked on a promise and the release is what unblocks them.
   * Here nobody is waiting: the person pressed a button, and taking the gate down before `clearAuth`
   * has come back would show them the app they are not allowed into for as long as the round trip
   * lasts. `PlatformGateOverlay` holds its own gate the same way, on the same argument.
   */
  async function handlePinSignOut() {
    appendLog('[AUTH] Sign-out from the PIN gate - ending the session, keeping the local state.');
    // A failure here is a failure to REVOKE, never a reason to strand the user on a gate they asked
    // to leave - and a swallowed one would leave nothing behind, so it is accused by name.
    await clearAuth().catch((e) => appendLog(`[AUTH] Sign-out: clearAuth failed - ${e}`));
    await goto('/login', { replaceState: true });
    dismissAuthPrompts();
    pinError = '';
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;
  }

  /**
   * Called when a stored PIN is rejected; resets state and shows the PIN modal again.
   *
   * Re-asking is only worth it while a session could still use the answer. A login that failed
   * BECAUSE the refresh credential is dead arrives here like any other rejection, and putting the
   * keypad back up then asks for a secret whose verification is already impossible - the same
   * defect `mayPromptForPin` exists to prevent, reached from the one path that does not go through
   * it. The latch is synchronous, so the check costs nothing and needs no await here.
   */
  function onSavedPinFailed(msg: string, code?: LoginErrorCode) {
    if (isRefreshCredentialProvenDead()) {
      appendLog('[platform] Stored PIN rejected on a dead session - not re-prompting.');
      showPinModal = false;
      return;
    }
    pinError = msg;
    isFirstPinSetup = false;
    showPinModal = true;
    void evaluateRecoverable(globalSession.userId || currentUserId() || '', code);
  }

  /**
   * Returns true only when the user has never registered a PIN (no PinVerifier row
   * server-side) - the genuine "first setup" case. This is the source of truth, unlike
   * a device-count check which wrongly reports "first setup" for a user whose devices
   * were all revoked/GC'd but who still has a registered PIN (picking a new PIN would
   * then fail the verifier with a confusing mismatch). Defaults to false on any
   * network/auth failure so the "first setup" wording is never shown by mistake.
   */
  async function detectFirstPinSetup(uid: string): Promise<boolean> {
    try {
      const token = await getToken();
      const res = await fetch(
        `${deliveryUrl()}/api/mls/security/pin-status/${encodeURIComponent(uid)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return false;
      const { registered } = (await res.json()) as { registered: boolean };
      return !registered;
    } catch {
      return false;
    }
  }

  // Guard against concurrent login attempts (e.g. onMount + afterNavigate both firing).
  let _loginInProgress = false;
  // Guard against several observers reaching the "session is dead" verdict at once.
  let _sessionExpiredHandled = false;

  /** Closes PIN/biometric modals as soon as MLS unlocks; catch-up continues in the background. */
  function dismissAuthPrompts() {
    showBiometricSheet = false;
    showPinModal = false;
    pinLoading = false;
    pinStep = '';
  }

  // ── Context builders ──────────────────────────────────────────────────────
  // Same shape as MainChatPage context builders, but references global singletons.

  function convCtx(): ConversationContext {
    return {
      storage: globalSession.storage,
      ensureMls: globalSession.ensureMls,
      userId: globalSession.userId,
      deviceKeyB64: globalSession.deviceKeyB64,
      historyBaseUrl: globalSession.historyBaseUrl,
      messageReactions: globalMessaging.messageReactions,
      log: appendLog,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        globalMessaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
    };
  }

  function msgCtx(): MessagingContext {
    return {
      ensureMls: globalSession.ensureMls,
      conversations: globalConvs.conversations,
      userId: globalSession.userId,
      deviceKeyB64: globalSession.deviceKeyB64,
      authToken: globalSession.authToken,
      setAuthToken: (v: string) => {
        globalSession.authToken = v;
      },
      selectedContact: globalConvs.selectedContact,
      getSendError: () => globalConvs.sendError,
      setSendError: (v: string) => {
        globalConvs.sendError = v;
      },
      getChatContainer: () => globalConvs.chatContainer,
      storage: globalSession.storage,
      log: appendLog,
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      verifyCurrentUserMembership: (name: string) =>
        globalConvs.verifyCurrentUserMembership(name, convCtx()),
      playNotificationTone: globalNotifs.playNotificationTone,
      playSendTone: globalNotifs.playSendTone,
      playReceiveTone: globalNotifs.playReceiveTone,
      playReadTone: globalNotifs.playReadTone,
      sendSystemNotification: globalNotifs.sendSystemNotification,
      signalChannelRead: (channelId: string) => void channelService.markChannelRead(channelId),
    };
  }

  function channelsCtx() {
    return {
      conversations: globalConvs.conversations,
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      deleteConversation: (name: string) =>
        globalSession.storage?.deleteConversation(name) ?? Promise.resolve(),
      selectConversation: globalConvs.selectConversation,
      ensureMls: globalSession.ensureMls,
      startDirectConversation: (targetUserId: string, opts?: { silent?: boolean }) =>
        globalConvs.startNewConversation(targetUserId, convCtx(), opts),
      getSelectedConversationId: () => globalConvs.selectedContact,
      reloadChannelHistory: (channelConversationId: string) =>
        globalConvs.loadHistoryForConversation(
          channelConversationId,
          channelConversationId,
          convCtx()
        ),
      invalidateChannelHistoryCache: (channelConversationId: string) =>
        globalConvs.invalidateChannelHistoryCache(channelConversationId),
      log: appendLog,
    };
  }

  /**
   * Warns when another device of the same account is already in a call.
   */
  function checkSiblingCallWarning() {
    // One /api/calls/sibling-status request fires per session start. While calls are held off it
    // could only ever report a legacy device, and it would say so in a toast about a call this
    // client cannot join - a request and a line that are both pure noise.
    if (!CALLS_ENABLED) return;
    const deviceId = globalSession.myDeviceId;
    if (!deviceId || globalSession.callState !== 'idle') return;
    void warnIfSiblingDeviceInCall(deviceId);
  }

  /**
   * Erases a community from local state, then clears the chat panel if the conversation on
   * screen belonged to it. The channel ids have to be read BEFORE the purge, which is exactly
   * what makes this shared by the two ways a community can vanish under the user: an admin
   * deleted it, or an admin removed the user from it.
   * @param workspaceId Server id of the community leaving local state.
   * @param purge The event-specific handler doing the removal (it owns the log line).
   */
  async function dropCommunityLocally(
    workspaceId: string,
    purge: (ctx: WorkspacePurgeContext) => Promise<void>
  ) {
    const doomedChannelIds =
      globalChannels.channelWorkspaces
        .find((ws) => ws.workspaceDbId === workspaceId)
        ?.channels.map((ch) => ch.id) ?? [];
    await purge({
      conversations: globalConvs.conversations,
      deleteConversation: (id: string) =>
        globalSession.storage?.deleteConversation(id) ?? Promise.resolve(),
      invalidateChannelHistoryCache: globalConvs.invalidateChannelHistoryCache,
      log: appendLog,
    });
    if (globalConvs.selectedContact && doomedChannelIds.includes(globalConvs.selectedContact)) {
      globalConvs.selectedContact = null;
      globalConvs.sendError = '';
    }
  }

  /**
   * Builds the full callback object for globalSession.login() / session callbacks.
   * @param overrides Per-call hooks (e.g. handlePinSubmit step timer).
   */
  function sessionCb(
    overrides: Partial<import('$lib/composables/session/sessionTypes').ChatSessionCallbacks> = {}
  ) {
    const base = {
      conversations: globalConvs.conversations,
      loadAndRestoreConversations: () => globalConvs.loadAndRestoreConversations(convCtx()),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        globalMessaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      drainOrphanMessages: (convoKey: string) =>
        globalMessaging.drainOrphanMessages(convoKey, msgCtx()),
      beginBulkMessageIngest: (phase: BulkIngestPhase) =>
        globalMessaging.beginBulkMessageIngest(phase),
      endBulkMessageIngest: (phase: BulkIngestPhase) =>
        globalMessaging.endBulkMessageIngest(msgCtx(), phase),
      batchAddMessages: (
        msgs: Parameters<typeof globalMessaging.batchAddMessages>[0],
        contactName: string
      ) => globalMessaging.batchAddMessages(msgs, contactName, msgCtx()),
      saveConversation: (name: string) => globalConvs.saveConversation(name, convCtx()),
      selectConversation: globalConvs.selectConversation,
      onChannelMemberJoined: (event: any) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        const workspace = globalChannels.ensureWorkspaceForChannelEvent(event);
        const isPrivate = event.visibility === 'private';
        globalChannels.addChannelToWorkspace(workspace.id, {
          id: channelConversationId,
          name: (event.channelName || 'canal').toLowerCase(),
          isPrivate,
        });
        if (!globalConvs.conversations.has(channelConversationId)) {
          globalConvs.conversations.set(channelConversationId, {
            id: channelConversationId,
            contactName: channelConversationId,
            name: (event.channelName || 'canal').toLowerCase(),
            messages: [],
            lifecycle: 'active',
            mlsStateHex: null,
          });
        }
        // Without this the channel is registered but belongs to no community as far as the send
        // path is concerned, so the first message typed into it is refused until an app relaunch
        // runs the full workspace hydration. A private salon also enters its own distribution
        // group here, for the same reason and in the same window.
        if (workspace.workspaceDbId) {
          void globalChannels
            .registerJoinedChannel(
              event.channelId,
              workspace.workspaceDbId,
              isPrivate,
              globalSession.ensureMls
            )
            .catch((e) =>
              appendLog(
                `[GRAINE] could not prepare joined channel ${event.channelId}: ${e instanceof Error ? e.message : String(e)}`
              )
            );
        }
        appendLog(`Joined channel #${event.channelName || event.channelId}`);

        // Add a system message to the channel so the inviter (and other members) see who joined.
        if (event.invitedBy && event.joinedBy) {
          void (async () => {
            try {
              const getName = await resolveDisplayNames([event.invitedBy, event.joinedBy]);
              const inviterName = getName(event.invitedBy);
              const joinedName = getName(event.joinedBy);

              // The invitee already receives mkChannelInviteEnvelope via the key distribution DM.
              const currentUserIdLower = globalSession.userId?.toLowerCase();
              if (event.joinedBy.toLowerCase() === currentUserIdLower) return;

              const systemText = m.chat_system_member_added({
                sender: inviterName,
                members: joinedName,
              });

              const convo = globalConvs.conversations.get(channelConversationId);
              if (!convo) return;

              const newMsg: ChatMessage = {
                id: crypto.randomUUID(),
                senderId: 'system',
                content: serializeEnvelope(mkSystemEnvelope(systemText as string)),
                timestamp: new Date(),
                isOwn: false,
                isSystem: true,
              };
              globalConvs.conversations.set(channelConversationId, {
                ...convo,
                messages: [...convo.messages, newMsg],
                lastMessageAt: Math.max(convo.lastMessageAt ?? 0, newMsg.timestamp.getTime()),
              });
            } catch {
              // Non-blocking: system message is best-effort.
            }
          })();
        }
      },
      onChannelMemberKicked: (event: any) => {
        const outcome = removalOutcome({
          localUserId: globalSession.userId,
          kickedUserId: event.kickedUserId,
          channelId: event.channelId,
          channelIsPrivate: event.channelIsPrivate,
        });
        if (outcome === 'ignore') return;

        if (outcome === 'community') {
          const communityName =
            globalChannels.channelWorkspaces.find((ws) => ws.workspaceDbId === event.workspaceId)
              ?.name ?? '';
          void dropCommunityLocally(event.workspaceId, (ctx) =>
            globalChannels.handleRemovedFromWorkspace(event, ctx)
          );
          showToast(m.channel_removed_from_community({ community: communityName }), 'info');
          return;
        }

        if (outcome === 'public-channel') {
          appendLog(
            `Removed from public channel #${event.channelName || event.channelId} - access retained`
          );
          return;
        }

        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.invalidateChannelHistoryCache(channelConversationId);
        globalConvs.conversations.delete(channelConversationId);
        void globalSession.storage?.deleteConversation(channelConversationId).catch(() => {});
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
          globalConvs.sendError = '';
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
        appendLog(`Removed from channel #${event.channelName || event.channelId}`);
        showToast(m.channel_removed_from_channel({ channel: event.channelName || '' }), 'info');
      },
      onRolePermissionsChanged: (event: { roleId: string; permissions: string[] }) => {
        globalChannels.handleRolePermissionsChanged(event);
        appendLog(
          `[ROLE] ${event.roleId.slice(0, 8)} now grants ${event.permissions.length} permission(s)`
        );
      },
      onChannelUpdated: (event: { channelId: string; name?: string; viewerCanWrite?: boolean }) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        // ONE PASS FOR BOTH FACTS, and each applied only when the event carried it: a rename sends
        // no verdict about writing and an access change sends no name. `canWrite` is what the chat
        // view reads to decide whether to offer a composer at all, so this is the whole difference
        // between learning of a new rule now and learning of it on the next full load.
        if (event.name || typeof event.viewerCanWrite === 'boolean') {
          globalChannels.channelWorkspaces = globalChannels.channelWorkspaces.map((ws) => ({
            ...ws,
            channels: ws.channels.map((ch) =>
              ch.id === channelConversationId
                ? {
                    ...ch,
                    ...(event.name ? { name: event.name } : {}),
                    ...(typeof event.viewerCanWrite === 'boolean'
                      ? { canWrite: event.viewerCanWrite }
                      : {}),
                  }
                : ch
            ),
          }));
          appendLog(
            `[CHANNEL] #${event.name ?? event.channelId} updated - canWrite=${String(event.viewerCanWrite ?? 'unchanged')}`
          );
        }
        const convo = globalConvs.conversations.get(channelConversationId);
        if (convo && event.name) {
          globalConvs.conversations.set(channelConversationId, {
            ...convo,
            name: event.name,
          });
        }
      },
      onChannelDeleted: (event: { channelId: string }) => {
        if (!event.channelId) return;
        const channelConversationId = `channel_${event.channelId}`;
        globalConvs.invalidateChannelHistoryCache(channelConversationId);
        globalConvs.conversations.delete(channelConversationId);
        void globalSession.storage?.deleteConversation(channelConversationId).catch(() => {});
        globalChannels.removeChannelFromWorkspaces(channelConversationId);
        if (globalConvs.selectedContact === channelConversationId) {
          globalConvs.selectedContact = null;
          globalConvs.sendError = '';
        }
        if (globalChannels.selectedChannelConversationId === channelConversationId) {
          globalChannels.selectedChannelConversationId = '';
        }
      },
      onWorkspaceUpdated: (event: { workspaceId: string; imageMediaId?: string }) => {
        globalChannels.handleWorkspaceUpdated(event);
      },
      onWorkspaceRoleChanged: (event: {
        workspaceId: string;
        roleName: string;
        canManage: boolean;
        permissions: string[];
      }) => {
        globalChannels.handleWorkspaceRoleChanged(event);
        appendLog(
          `[WORKSPACE] my role in ${event.workspaceId.slice(0, 8)} is now "${event.roleName}" (canManage=${event.canManage})`
        );
      },
      onWorkspaceDeleted: (event: { workspaceId: string }) => {
        if (!event.workspaceId) return;
        void dropCommunityLocally(event.workspaceId, (ctx) =>
          globalChannels.handleWorkspaceDeleted(event, ctx)
        );
      },
      onChannelMessageDeleted: (event: { channelId: string; messageId: string }) => {
        globalChannels.handleChannelMessageDeleted(event, {
          conversations: globalConvs.conversations,
          invalidateChannelHistoryCache: globalConvs.invalidateChannelHistoryCache,
          log: appendLog,
        });
      },
      onReadStateAdvanced: (e: { conversationKey: string; senderId: string; at: number }) => {
        // Sound only when another user reads MY message, in the open conversation on the visible tab
        // (never for my own cross-device reads).
        if (e.senderId === globalSession.userId) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (e.conversationKey !== globalConvs.selectedContact) return;
        globalNotifs.playReadTone();
      },
      onSendError: (msg: string) => {
        globalConvs.sendError = msg;
      },
      log: appendLog,
      messageReactions: globalMessaging.messageReactions,
      getSelectedContact: () => globalConvs.selectedContact,
      setSelectedContact: (v: string | null) => {
        globalConvs.selectedContact = v;
      },
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        globalConvs.loadHistoryForConversation(contactName, groupId, convCtx()),
      onMlsReady: () => {
        dismissAuthPrompts();
        checkSiblingCallWarning();
        overrides.onMlsReady?.();
      },
      onSessionExpired: handleSessionExpired,
    };
    return {
      ...base,
      ...overrides,
      onMlsReady: base.onMlsReady,
      onSessionExpired: base.onSessionExpired,
    };
  }

  /** Navigates to the channel community when the user clicks "Rejoindre la communauté". */
  function handleJoinChannel(channelId: string) {
    void openInvitedChannel(channelId);
  }

  // ── Post-login: load channel workspaces ───────────────────────────────────
  $effect(() => {
    if (!globalSession.isLoggedIn) return;
    untrack(() => {
      void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx()).then((refreshRan) => {
        if (refreshRan && globalChannels.workspacesLoadError !== null) {
          appendLog(
            `[WORKSPACE-LOAD] post-login community load failed: ${globalChannels.workspacesLoadError}`
          );
          // No blocking UI: the online/foreground listener will retry automatically.
        }
      });
    });
  });

  // ── Online / foreground resume: retry a failed workspace load ─────────────
  onMount(() => {
    // A Graine repair lands minutes after the rows it repairs were rendered unreadable and dropped,
    // and nothing else would go back for them before the user next leaves and re-enters the salon.
    // Registered HERE because this is the layer holding both the seed layer and the conversations.
    setGraineRepairListener((channelIds) => {
      for (const channelId of channelIds) {
        const conversationId = `channel_${channelId}`;
        globalConvs.invalidateChannelHistoryCache(conversationId);
        void globalConvs.loadHistoryForConversation(conversationId, conversationId, convCtx());
      }
    });

    function handleOnline() {
      if (!globalSession.isLoggedIn) return;
      if (globalChannels.isLoadingWorkspaces) return;
      if (globalChannels.workspacesLoadError === null) return;
      appendLog('[WORKSPACE-LOAD] online event - retrying community load');
      void globalChannels.loadChannelWorkspacesFromBackend(channelsCtx());
    }

    function handleVisibility() {
      if (document.visibilityState !== 'visible') return;
      handleOnline();
    }

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    // The refresh endpoint is the only place that learns a session is dead, and it can learn it
    // from any caller - a background poll, a socket reconnect, a native auto-login. Wiring the
    // reaction once, here, is what makes the logout unmissable instead of depending on which path
    // happened to observe the 401 (WP-ANDROID-SESS-1).
    setSessionExpiredHandler(() => void handleSessionExpired());

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      setSessionExpiredHandler(null);
      setGraineRepairListener(null);
    };
  });

  // ── Post-login: propose biometric enrollment on mobile ────────────────────
  // After a successful PIN login on Tauri, check if biometric enrollment
  // should be offered (hardware available, not already configured, not dismissed).
  $effect(() => {
    const loggedIn = globalSession.isLoggedIn;
    const isTauri = isTauriRuntime();
    if (!loggedIn || !isTauri) return;
    if (biometricCheckedForEnrollment) return;
    if (showPinModal || showBiometricSheet) return;

    biometricCheckedForEnrollment = true;
    untrack(async () => {
      const configured = await BiometricService.isConfigured().catch(() => false);
      if (configured) return;
      const dismissed = await isBiometricPromptDismissed();
      if (dismissed) return;
      const available = await BiometricService.isAvailable().catch(() => false);
      if (!available) return;

      showBiometricEnrollSheet = true;
    });
  });

  /**
   * Consumes the native FCM cache and injects messages directly into reactive memory,
   * enabling immediate display without waiting for the next history poll (5s or foreground resume).
   */
  async function flushFcmCache(deviceKeyB64: string, storage: IStorage) {
    if (globalMessaging.isMessageCatchupActive) return;
    const injected = await consumeFcmCache(deviceKeyB64, storage).catch(
      () => [] as StoredMessage[]
    );
    if (injected.length === 0 || !globalSession.userId) return;
    mergeFcmMessagesIntoConversations(injected, globalConvs.conversations, globalSession.userId);
  }

  /** Applies leader-tab message broadcasts to follower tab UI state. */
  function applyTabMessageEvent(event: import('$lib/mls-client/tabMessageSync').TabMessageEvent) {
    if (globalSession.isTabLeader) return;
    const convo = globalConvs.conversations.get(event.conversationId);
    if (!convo) return;

    if (event.type === 'message_added') {
      if (convo.messages.some((m) => m.id === event.message.id)) return;
      globalConvs.conversations.set(event.conversationId, {
        ...convo,
        messages: insertMessageOrdered(convo.messages, event.message),
        lastMessageAt: event.lastMessageAt,
        unreadCount: event.unreadCount,
      });
      return;
    }

    const existingIds = new Set(convo.messages.map((m) => m.id));
    const toAdd = event.messages.filter((m) => !existingIds.has(m.id));
    if (toAdd.length === 0) return;
    let merged = convo.messages;
    for (const msg of toAdd) {
      merged = insertMessageOrdered(merged, msg);
    }
    globalConvs.conversations.set(event.conversationId, {
      ...convo,
      messages: merged,
      lastMessageAt: event.lastMessageAt,
      unreadCount: event.unreadCount,
    });
  }

  /**
   * Core login flow: checks platform, discovers biometrics/saved PIN, and either starts
   * loginImpl or opens the PIN modal. Shared between onMount, afterNavigate, and the
   * reactive $effect so the flow triggers regardless of how the user reaches a page.
   *
   * Sets globalSession.isLoginInProgress = true BEFORE any await so the layout guard
   * (`+layout.ts`) never fires fetchUserProfile while login is pending.
   */
  async function startLoginFlow() {
    if (_loginInProgress || globalSession.isLoggedIn || globalSession.isLoginInProgress) return;
    _loginInProgress = true;
    globalSession.isLoginInProgress = true;
    try {
      if (!(await mayPromptForPin())) {
        globalSession.isLoginInProgress = false;
        return;
      }

      // ── TAURI (MOBILE) BRANCH ──
      if (isTauriRuntime()) {
        const savedUser = currentUserId();
        if (!savedUser) {
          globalSession.isLoginInProgress = false;
          return;
        }
        globalSession.userId = savedUser;

        // Step 1: check whether biometrics are CONFIGURED (user flag) — P1-A
        // NEVER query the keystore if the user disabled biometrics, even if a leftover key exists.
        let biometricAttempted = false;
        const isBiometricConfigured = await BiometricService.isConfigured();

        if (isBiometricConfigured) {
          const deviceKey = `mls_device_id_${savedUser}`;
          const storedDeviceId = localStorage.getItem(deviceKey);
          const hasExistingDevice = storedDeviceId !== null;

          if (hasExistingDevice) {
            const alias = `mls_device_key_${savedUser}_${storedDeviceId}`;
            const keyPresent = await BiometricService.isKeyPresent(alias).catch(() => false);

            if (keyPresent) {
              biometricAttempted = true;
              // Subsequent login with biometrics ENROLLED → straight to BiometricBottomSheet
              biometricConfigured = true;
              biometricCancelled = false;
              showBiometricSheet = true;

              // Leave a short delay so the user can interact with the BiometricBottomSheet
              // (choosing "Use my PIN"). If onSkip fires during that delay, biometricCancelled
              // flips to true and we skip the OS biometric prompt.
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (biometricCancelled) {
                showBiometricSheet = false;
              } else {
                // Same handover as the web branch below, and for the same reason: this function
                // raised isLoginInProgress for the +layout.ts guard, and loginImpl refuses to run
                // when that flag is set - it cannot tell our flag from a real concurrent login.
                // Left set, the automatic biometric attempt of every cold launch was swallowed
                // ("[LOGIN] Call ignored, a login already owns the flow"): the sheet appeared, no
                // OS prompt ever did, and the flow fell through to the PIN modal - where the same
                // tap on "use biometrics" worked, because line ~918 had cleared the flag by then.
                globalSession.isLoginInProgress = false;
                await globalSession.biometricLogin({
                  ...sessionCb(),
                  onLoginFailed: onSavedPinFailed,
                });
                dismissAuthPrompts();
              }
            }
          }
        }

        if (!globalSession.isLoggedIn) {
          // P2-A: no automatic fallback after a biometric failure. If biometrics were attempted
          // and failed or were cancelled, the user must enter their PIN explicitly — no
          // nativeStorageLogin.
          if (!biometricAttempted) {
            globalSession.isLoginInProgress = false;
            const ok = await globalSession.nativeStorageLogin(
              {
                ...sessionCb(),
                onLoginFailed: onSavedPinFailed,
              },
              isBiometricConfigured
            );
            if (ok) return;
          }

          // Fallback: PIN modal. It keeps the "use fingerprint" button exactly when biometrics
          // were actually usable (configured AND a key present in the keystore), so a user who
          // cancelled or mistyped the prompt can retry it instead of being forced onto the PIN.
          // When no biometric is enrolled the button stays hidden - it could only fail again.
          biometricConfigured = biometricAttempted;
          globalSession.isLoginInProgress = false;
          await openPinModal(savedUser);
        }
        return;
      }

      // ── WEB BRANCH ──
      const savedUser = currentUserId();
      const savedDeviceKeyB64 = await loadDeviceKey();
      if (savedUser && savedDeviceKeyB64) {
        globalSession.userId = savedUser;
        globalSession.deviceKeyB64 = savedDeviceKeyB64;
        // loginImpl checks isLoginInProgress itself and will bail if it's true.
        // Reset it here so loginImpl can set it and manage its own lifecycle.
        globalSession.isLoginInProgress = false;
        void globalSession.login({ ...sessionCb(), onLoginFailed: onSavedPinFailed });
      } else if (savedUser) {
        globalSession.userId = savedUser;
        globalSession.isLoginInProgress = false;
        await openPinModal(savedUser);
      } else {
        globalSession.isLoginInProgress = false;
      }
    } finally {
      if (!globalSession.isLoggedIn && !showPinModal) _loginInProgress = false;
    }
  }

  // ── Reactive trigger: userId becomes available after OIDC (Tauri Android) ──
  // Fires as soon as currentUserId() transitions from null → value so the PIN/
  // biometric modal appears immediately without requiring a manual navigation.
  $effect(() => {
    const uid = currentUserId();
    const loggedIn = globalSession.isLoggedIn;
    if (!uid || loggedIn) return;
    if (typeof window === 'undefined') return;
    const path = window.location.pathname;
    if (path.startsWith('/login') || path.startsWith('/auth/') || path.startsWith('/legal')) return;
    untrack(() => {
      globalSession.initServices(appendLog);
      void startLoginFlow();
    });
  });

  // ── Mount ─────────────────────────────────────────────────────────────────
  onMount(() => {
    // Already logged in (e.g. navigating from /chat): nothing to do.
    if (globalSession.isLoggedIn) return;

    const w = window as Window & {
      wasm_bindings_log?: (level: string, msg: string) => void;
    };
    w.wasm_bindings_log = (level: string, msg: string) => appendLog(`[RUST::${level}] ${msg}`);

    globalSession.initServices(appendLog);
    // WP-XP-5: a CallKit answer may predate this cold start (app launched from the call UI).
    // Drain it before login so the auto-accept fires as soon as the invite arrives over WS.
    void drainNativePendingCallAccept();
    void startLoginFlow();

    /** Fire-and-forget native MLS foreground-guard command (mobile only; no-op on desktop/web). */
    const invokeNative = (cmd: string): void => {
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd)).catch(() => {});
    };

    // Foreground heartbeat (Android + iOS): keeps the native guard fresh while the app is visible so
    // the background engines abstain from writing mls.bin. The FOREGROUND_GRACE_MS guard gates the
    // background writers on BOTH platforms, but iOS only refreshes it once (canari_ios_on_resume);
    // without this 10s heartbeat the guard would expire ~30s into a genuinely-foregrounded iOS
    // session and an in-process FCM data push could clobber the warm engine's in-memory state. The
    // native mls_foreground_heartbeat command is platform-agnostic (mark_foreground_active).
    // createPausableInterval auto-pauses on hidden, so the guard expires shortly after backgrounding
    // even without a clean `hidden` event.
    const stopForegroundHeartbeat = isMobileTauriRuntime()
      ? createPausableInterval(() => invokeNative('mls_foreground_heartbeat'), 10_000)
      : null;

    // Pause/resume WebSocket based on app visibility.
    // On mobile/Tauri, pause immediately when backgrounded (OS will kill the process soon).
    // On desktop web, don't pause: browsers keep WebSocket connections alive in background
    // tabs, and pausing breaks recovery timers and causes unnecessary reconnects.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && globalSession.isLoggedIn) {
        if (isTauriRuntime()) {
          globalSession.pauseConnection();
        }
        // CHECKPOINT FIRST, THEN RELEASE THE GUARD - the order is the whole point, not a nicety.
        // Releasing it is what lets a background JNI engine load `mls.bin` and advance the ratchet
        // from it; if the foreground's own advances have not landed yet, that engine starts from a
        // state already behind and re-issues generations this device has spent, which the peer
        // refuses as `SecretReuseError`. The guard would expire on its own after ~30s, so nothing
        // here is load-bearing on a clock: it only makes the handoff immediate AND ordered.
        void flushActiveMlsStateEncrypted()
          .catch((e) => {
            // Loud, and the release still happens: holding the guard on a failed flush would
            // strand background delivery entirely, which is a worse failure than the one above.
            console.error('[MLS] Checkpoint before backgrounding failed:', e);
          })
          .finally(() => invokeNative('pause_mls_foreground'));
        return;
      }
      if (document.visibilityState === 'visible' && globalSession.isLoggedIn) {
        const { deviceKeyB64, storage } = globalSession;
        // Ordered resume sequence. C2 first: reload mls.bin into the warm engine BEFORE anything
        // processes, because a background join/send may have advanced it while we were away; the
        // stale warm state would otherwise clobber that advance on the next save (SecretReuse).
        // No-op off Android. Then reconcile outbox_sent BEFORE the flusher re-reads the queue (so
        // we don't re-send a message the background already delivered), then reconnect/flush.
        void (async () => {
          await globalSession.ensureMls().reloadStateFromDisk();
          if (storage) await reconcileOutboxSent(storage).catch(() => {});
          // WP-XP-5: the user may have answered a CallKit ring while we were away - record
          // the intent BEFORE the WS reconnect delivers the MLS invite that auto-accepts it.
          await drainNativePendingCallAccept();
          // resumeConnection, NOT attemptReconnect: `pauseConnection` stopped the connection and
          // sync watchdogs on the way out, and only this seam re-arms them - so it must run even
          // when the socket survived the background, hence no isWsConnected guard here. Calling
          // attemptReconnect directly left a mobile client with no timer able to notice a later
          // dead socket, which is exactly what was measured on hardware (see resumeConnectionImpl).
          void globalSession.resumeConnection(sessionCb());
          checkSiblingCallWarning();
          // Flush FCM messages cached while the app was in the background.
          if (deviceKeyB64 && storage) {
            void flushFcmCache(deviceKeyB64, storage);
          }
        })();
      }
    };

    /**
     * The network coming back is evidence conditions changed, exactly like a foreground
     * transition - and it must reach the same seam.
     *
     * WHAT THIS BUYS IS LATENCY, NOT RECOVERY, and the distinction is the lesson of
     * WP-RECONNECT-1. The reconnect ladder used to stop after 20 attempts and wait for exactly
     * these two events to release it - which stranded for ever every client that can emit neither
     * (a desktop tab, foreground, unchanged network). The ladder no longer stops, so a client with
     * no lifecycle events at all still recovers on its own. This handler resets the backoff to its
     * first rung, turning "within 30 s" into "now" when there is real evidence the outage ended.
     *
     * `resumeConnection` is idempotent here: it resets the ladder, re-arms the watchdogs, and
     * returns immediately if the socket is already up.
     */
    const handleOnlineResume = () => {
      if (!globalSession.isLoggedIn) return;
      appendLog('[LIFECYCLE] Network back online - re-arming watchdogs and reconnecting...');
      void globalSession.resumeConnection(sessionCb());
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnlineResume);

    const unsubscribeTabMessages = subscribeTabMessageUpdates(applyTabMessageEvent);

    // ── FCM cache polling (Tauri/Android only) ────────────────────────────
    // Messages received via FCM while the app is in the foreground are written
    // to fcm_message_cache.ndjson by the Kotlin service but the visibility-change
    // handler above only fires on background→foreground transitions, so those
    // messages would only appear after a restart. Poll every 5 s while visible.
    const FCM_POLL_INTERVAL = 5_000;
    const isTauri = isTauriRuntime();
    const fcmPollTimer = isTauri
      ? setInterval(() => {
          if (document.hidden || globalMessaging.isMessageCatchupActive) return;
          const { deviceKeyB64, storage } = globalSession;
          if (!deviceKeyB64 || !storage) return;
          void flushFcmCache(deviceKeyB64, storage);
        }, FCM_POLL_INTERVAL)
      : null;

    // ── IndexedDB garbage collection: delete messages older than 90 days ───
    const GC_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const MESSAGE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days
    const gcTimer = setInterval(() => {
      if (document.hidden) return;
      const storage = globalSession.storage;
      if (storage) {
        storage
          .deleteOldMessages(MESSAGE_MAX_AGE)
          .then((n) => {
            if (n > 0) appendLog(`[GC] Deleted ${n} old message(s) from IndexedDB`);
          })
          .catch(() => {});
      }
    }, GC_INTERVAL);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnlineResume);
      unsubscribeTabMessages();
      if (fcmPollTimer !== null) clearInterval(fcmPollTimer);
      clearInterval(gcTimer);
      stopForegroundHeartbeat?.();
    };
  });

  // ── Biometrics: post-login enrolment handlers ─────────────────────────────

  async function handleBiometricEnroll() {
    showBiometricEnrollSheet = false;
    await globalSession.enrollBiometric();
    // After a successful enrollment, refresh biometricConfigured for the next flow
    if (globalSession.isLoggedIn) {
      biometricConfigured = await BiometricService.isConfigured().catch(() => false);
    }
  }

  async function handleBiometricEnrollDismiss() {
    showBiometricEnrollSheet = false;
    await globalSession.dismissBiometricPrompt();
  }

  async function handleBiometricFromModal() {
    pinError = '';
    pinLoading = true;
    await globalSession.biometricLogin(
      sessionCb({
        onLoginFailed: (msg: string, code?: LoginErrorCode) => {
          pinError = msg;
          pinLoading = false;
          void evaluateRecoverable(globalSession.userId || currentUserId() || '', code);
        },
      })
    );
    pinLoading = false;
    if (globalSession.isLoggedIn) {
      dismissAuthPrompts();
    } else if (!pinError) {
      pinError = m.auth_biometric_failed_fallback();
    }
  }

  function handlePinSubmit(submittedPin: string) {
    pinError = '';
    pinLoading = true;
    pinStep = m.auth_pin_step_verifying();
    canRecoverPin = false;
    globalSession.pin = submittedPin;
    // Record the "stay signed in" choice before login: loginImpl's savePin then writes the
    // PIN vault into the matching store (localStorage when persistent, sessionStorage otherwise).
    if (showStaySignedIn) void setDeviceKeyPersistence(pinStaySignedIn, null);
    _loginInProgress = true;
    // An explicit PIN submit takes priority over any background login that may have set
    // this flag (onMount/afterNavigate race); loginImpl bails silently if it is still set.
    globalSession.isLoginInProgress = false;

    // Transition to the MLS loading step after PIN derivation (~800 ms)
    const stepTimer = setTimeout(() => {
      if (pinLoading) pinStep = m.auth_pin_step_loading_mls();
    }, 800);

    /**
     * Whether the login ANSWERED - `onMlsReady` or `onLoginFailed`, whichever came first.
     *
     * THIS REPLACED A TEN-SECOND CLOCK, AND THE CLOCK WAS WRONG ON EVERY COLD START OF A REAL
     * PHONE. It called itself a "temporal safety net" for "an unexpected early return or a hung
     * network call" and, on expiry, told the user in red that the unlock had failed and to try
     * again. Measured on a Mi 9T on 2026-09-06, three times out of three: the watchdog fired at
     * 18:47:58 and the login succeeded at 18:48:10 - twelve seconds later, having spent them inside
     * one native call that decrypts a 19.9 MB `mls.bin` and emits nothing at all while it does. So
     * the clock could not distinguish "hung" from "working", and its guess manufactured the retry
     * that then hits `loginImpl`'s "a login already owns the flow" guard, which returns silently.
     *
     * The case it was written for is real and stays covered - but by a PROOF rather than a guess.
     * `login()` always settles; the only way a caller can be left waiting is for it to settle
     * without having answered, which is exactly what an early return looks like from here. That is
     * observable, so it is observed. A slow login is no longer a failed one, and a genuinely silent
     * return is reported as what it is instead of being timed.
     *
     * What this deliberately does NOT cover is a promise that never settles - a hung fetch. That is
     * a missing deadline on the REQUEST, where the fact lives; inventing a verdict here would be
     * the same mistake in a shorter form. Root cause of the twelve seconds:
     * `docs/wiki/backlog.md`, the 19.5 MB entry.
     */
    let answered = false;

    void globalSession
      .login(
        sessionCb({
          onMlsReady: () => {
            answered = true;
            clearTimeout(stepTimer);
          },
          onLoginFailed: (msg: string, code?: LoginErrorCode) => {
            answered = true;
            clearTimeout(stepTimer);
            pinError = msg;
            pinLoading = false;
            pinStep = '';
            void evaluateRecoverable(globalSession.userId || currentUserId() || '', code);
          },
        })
      )
      .then(() => {
        // Settled with no answer: something returned early without resolving this caller's UI.
        // Nothing else can release the modal, and the message says what happened rather than
        // guessing why.
        if (answered || !pinLoading) return;
        clearTimeout(stepTimer);
        pinError = m.auth_pin_no_result();
        pinLoading = false;
        pinStep = '';
        _loginInProgress = false;
        appendLog('[PIN] login() returned without calling back - unblocking the PIN modal.');
      })
      .catch((e: unknown) => {
        // login() routes errors through onLoginFailed; this guards against a rejection
        // that escapes that path (e.g. before the internal try) leaving the spinner stuck.
        answered = true;
        clearTimeout(stepTimer);
        const msg = e instanceof Error ? e.message : String(e);
        pinError = msg;
        pinLoading = false;
        pinStep = '';
        _loginInProgress = false;
        appendLog(`[PIN] login() rejected: ${msg}`);
      });
  }

  /**
   * "Forgot PIN" reset: wipes the user's PIN-protected MLS state server-side (keeping
   * the account, posts and community), clears local MLS state, then re-opens the modal
   * in first-setup mode so the user chooses a new PIN. Past encrypted messages are lost.
   */
  async function handlePinReset() {
    const uid = globalSession.userId || currentUserId();
    if (!uid) return;
    pinError = '';
    pinLoading = true;
    pinStep = m.auth_pin_step_resetting();
    appendLog(`[PIN_RESET] Starting for userId=${uid.slice(0, 8)}…`);
    try {
      const token = await getToken();
      const res = await fetch(`${deliveryUrl()}/api/mls/security/pin-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: uid }),
      });
      if (!res.ok) throw new Error('Server-side PIN reset failed.');
      // Local MLS state is encrypted under the old PIN - wipe it so a new PIN starts fresh.
      await globalSession.resetDeviceAsFresh(uid, sessionCb());
      appendLog('[PIN_RESET] MLS state wiped - choose a new PIN.');
      globalSession.userId = uid;
      isFirstPinSetup = true;
      // Deliberately NOT gated on `mayPromptForPin`: the POST above carried a live access token, so
      // the credential is not dead, and the local MLS state is already wiped. Declining the keypad
      // here would strand the user mid-reset with nothing to unlock and no way to finish.
      showPinModal = true;
    } catch (e) {
      pinError = e instanceof Error ? e.message : String(e);
      appendLog(`[PIN_RESET] Failed: ${pinError}`);
    } finally {
      pinLoading = false;
      pinStep = '';
    }
  }

  // Safety net for navigations that arrive before onMount's startLoginFlow completes
  // (e.g. the OIDC callback navigates to /posts while onMount already ran with uid=null).
  // Delegates to startLoginFlow which handles both mobile and web paths uniformly.
  afterNavigate(async ({ to }) => {
    const path = to?.url.pathname ?? window.location.pathname;
    const isAuthRoute =
      path === '/login' ||
      path.startsWith('/login') ||
      path.startsWith('/auth/') ||
      path.startsWith('/legal');
    if (isAuthRoute) return;
    if (globalSession.isLoggedIn || _loginInProgress || globalSession.isLoginInProgress) return;

    const uid = currentUserId();
    if (!uid) return;

    // Set the flag early - before the first async call - so that the layout guard
    // in +layout.ts sees isLoginInProgress = true and skips fetchUserProfile.
    globalSession.isLoginInProgress = true;

    if (!(await mayPromptForPin())) {
      globalSession.isLoginInProgress = false;
      return;
    }

    // Arriving on a non-auth route with a user but not yet logged in:
    // trigger the login flow that onMount missed.
    globalSession.initServices(appendLog);
    // Reset the flag so startLoginFlow can proceed (it sets it again internally).
    globalSession.isLoginInProgress = false;
    void startLoginFlow();
  });
</script>

<!-- Post-login biometric enrolment offer (Tauri only), shown once after the first PIN entry -->
<BiometricEnrollSheet
  open={showBiometricEnrollSheet}
  onEnroll={handleBiometricEnroll}
  onDismiss={handleBiometricEnrollDismiss}
/>

<!-- In-app companion to the OS biometric prompt: unlock at login, or enrolment confirmation.
     During enrolment no onSkip is passed - the OS prompt owns the interaction. -->
<BiometricBottomSheet
  open={showBiometricSheet || biometricPrompt.enrolling}
  variant={biometricPrompt.enrolling ? 'enroll' : 'unlock'}
  onSkip={biometricPrompt.enrolling ? undefined : onBiometricSkip}
/>

<!-- PIN modal (visible on all routes) -->
<PinModal
  open={showPinModal}
  onSubmit={handlePinSubmit}
  onClose={() => {
    showPinModal = false;
    _loginInProgress = false;
    globalSession.isLoginInProgress = false;
  }}
  onSignOut={handlePinSignOut}
  onBiometricRequest={handleBiometricFromModal}
  showBiometricButton={biometricConfigured}
  {showStaySignedIn}
  bind:staySignedIn={pinStaySignedIn}
  externalError={pinError}
  isLoading={pinLoading}
  loadingStep={pinStep}
  isFirstSetup={isFirstPinSetup}
  onForgotPinReset={handlePinReset}
  onRecoverPin={canRecoverPin ? handleOpenRecover : undefined}
/>

<!-- PIN recovery after a cross-device PIN change -->
<ChangePinModal
  open={showRecoverModal}
  variant="recover"
  onSubmit={handleRecoverSubmit}
  onClose={() => (showRecoverModal = false)}
  externalError={recoverError}
  isLoading={recoverLoading}
  loadingProgress={recoverProgress}
/>

{#if showIncomingToast}
  <!-- Compact incoming-call toast when user is browsing another page (P5) -->
  {@const callerName = getUserDisplayNameSync(globalSession.callService?.incomingCallerId ?? '')}
  {@const isVideoCall = globalSession.callService?.incomingHasVideo ?? true}
  <div
    class="bg-cn-scrim/95 fixed top-4 left-1/2 z-310 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 animate-[slideDown_0.3s_ease-out] items-center gap-3 rounded-2xl px-4 py-3 shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl"
    transition:fly={{ y: -20, duration: 250 }}
  >
    <div class="relative h-10 w-10 shrink-0">
      <span
        class="ring-cn-scrim absolute -top-0.5 -right-0.5 z-10 h-3 w-3 animate-pulse rounded-full bg-amber-400 ring-2"
      ></span>
      <div class="h-full w-full overflow-hidden rounded-full bg-black/30 ring-1 ring-white/20">
        <Avatar
          userId={globalSession.callService?.incomingCallerId ?? ''}
          fill
          shape="circle"
          fallbackLabel={callerName}
        />
      </div>
    </div>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-bold text-white">{callerName || m.call_incoming_label()}</p>
      <p class="flex items-center gap-1 text-xs text-white/55">
        {#if isVideoCall}
          <Video size={12} strokeWidth={2.5} />
        {:else}
          <Phone size={12} strokeWidth={2.5} />
        {/if}
        {isVideoCall ? m.chat_video_call_label() : m.chat_audio_call_label()}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <div class="flex flex-col items-center gap-0.5">
        <button
          class="rounded-full bg-emerald-500 p-2 text-white transition-all hover:bg-emerald-400 active:scale-95"
          onclick={() =>
            globalSession.callService?.acceptCall(
              globalSession.callService.currentGroupId ?? '',
              globalSession.callService.currentCallId ?? ''
            )}
          aria-label={m.call_accept_label()}
        >
          <Phone size={18} class="fill-current" />
        </button>
        <span class="text-[9px] font-bold tracking-wider text-emerald-400 uppercase"
          >{m.call_accept_label()}</span
        >
      </div>
      <div class="flex flex-col items-center gap-0.5">
        <button
          class="rounded-full bg-red-500 p-2 text-white transition-all hover:bg-red-400 active:scale-95"
          onclick={() => globalSession.callService?.endCall()}
          aria-label={m.call_decline_label()}
        >
          <PhoneOff size={18} />
        </button>
        <span class="text-[9px] font-bold tracking-wider text-red-400 uppercase"
          >{m.call_decline_label()}</span
        >
      </div>
    </div>
  </div>
{:else if globalSession.callService && globalSession.callState !== 'idle'}
  <CallOverlay
    callService={globalSession.callService}
    currentUserId={globalSession.userId || currentUserId() || ''}
    participants={callRemoteParticipants}
  />
{/if}
