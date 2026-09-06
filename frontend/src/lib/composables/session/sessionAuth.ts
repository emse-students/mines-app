/**
 * Authentication functions extracted from useChatSession:
 * login, logout, nativeStorageLogin, biometricLogin, resetDeviceAsFresh.
 *
 * Each function receives `ctx: SessionContext` instead of the closure,
 * and `cb: ChatSessionCallbacks` to interact with conversations / UI.
 */
import { goto } from '$app/navigation';
import { SvelteSet } from 'svelte/reactivity';
import { getStorage } from '$lib/db';
import { computePinVerifier } from '$lib/utils/chat/auth';
import {
  applyNewDeviceKeyLocally,
  performPinChange,
  reencryptLocalMessages,
  type PinProgressCallback,
} from '$lib/utils/chat/pinChange';
import { deriveDeviceKeyB64, isValidDeviceKeyB64 } from '$lib/crypto/deviceKey';
import { fetchOrUnreachable } from '$lib/utils/fetchOrUnreachable';
import { LoginFailure, isExpectedLoginOutcome, loginErrorCode } from './loginErrors';
import { MLS_LOCAL_STATE_UNDECRYPTABLE } from '$lib/mls-client';
import { getToken, clearAuth, SessionExpiredError } from '$lib/stores/auth';
import { bindCurrentSessionDevice } from '$lib/services/authSessions';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { registerOfflinePromotion, unregisterOfflinePromotion } from './promoteOfflineSession';
import {
  flushPendingGroupExits,
  registerPendingGroupExitDrain,
  unregisterPendingGroupExitDrain,
} from '$lib/utils/chat/pendingGroupExits';
import { m } from '$lib/paraglide/messages';
import { saveUserLocally, clearUserLocally, currentUserId, isGlobalAdmin } from '$lib/stores/user';
import { recoverRosterDisagreement, requestReAdd } from '$lib/utils/chat/recovery';
import {
  answerAfterMailboxDrained,
  reconcileGroup,
  resetHistoryReconciliation,
  retryDeferredReconciliations,
  setHistoryProbeSender,
} from '$lib/utils/chat/historyReconcile';
import { onPeersCameOnline } from '$lib/stores/presenceStore';
import { sendHistoryStateKey } from '$lib/utils/chat/groupActions';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { canSendInGroup } from '$lib/utils/chat/groupUsability';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { setGraineRuntime } from '$lib/utils/graine/runtime';
import { handleDistributionFrame } from '$lib/utils/graine/frameHandler';
import { sweepExpiredGraineSeeds } from '$lib/utils/graine/retention';
import {
  unregisterMlsStatePersister,
  flushActiveMlsStateEncrypted,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import { uninstallMlsStatePersisterLifecycle } from '$lib/mls-client/mlsStatePersisterLifecycle';
import { disposeMlsEncryptWorker } from '$lib/mls-client/mlsEncryptWorkerSession';
import {
  setupMessageHandler,
  initializeConnection,
  initTabLeadershipAsync,
  getIsTabLeader,
} from '$lib/utils/chat/connection';
import {
  beginStartupCatchupBench,
  beginStartupCatchupPhase,
  endStartupCatchupPhase,
  finishStartupCatchupBench,
  cancelStartupCatchupBench,
  summarizeConversationStats,
  installCatchupBenchDevTools,
} from '$lib/mls-client/catchupBenchmark';
import { saveDeviceKey, clearDeviceKey, clearDeviceKeyAndWrapKey } from '$lib/utils/deviceKeyVault';
import { wipeDeviceToFactory } from '$lib/utils/deviceReset';
import { startPushService, stopPushService } from '$lib/services/PushNotificationService';
import { consumeFcmCache } from '$lib/utils/chat/fcmCache';
import { consumeNativeReadWatermarks } from '$lib/utils/chat/readWatermarkCache';
import { adoptOrphanedMirrorEntries, reconcileOutboxSent } from '$lib/utils/chat/outboxMirror';
import { mergeFcmMessagesIntoConversations } from '$lib/utils/chat/fcmMemoryMerge';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { isLikelyPrivateBrowsing } from '$lib/utils/isLikelyPrivateBrowsing';
import {
  handleWelcomeRequest,
  handleHistoryRequest,
  processPendingInvitations,
} from '$lib/utils/chat/actions';
import { markConversationDeletedRemotely } from '$lib/utils/chat/conversations';
import {
  registerOutbox,
  unregisterOutbox,
  flushOutbox,
  applyOutboxPendingStatuses,
} from '$lib/utils/chat/outbox';
import {
  getCallSystemMessageContext,
  handleCallSignalForChat,
  recordCallEnded,
  recordCallStarted,
  setCallSystemMessageContext,
} from '$lib/utils/chat/callSystemMessages';
import { resetSiblingCallWarning } from '$lib/utils/callPresence';
import { ChannelService } from '$lib/services/ChannelService';
import type { ICallMsg } from '$lib/proto/codec';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import {
  scheduleReconnectImpl,
  runGroupDiscoveryImpl,
  startConnectionWatchdogImpl,
  stopConnectionWatchdogImpl,
} from './sessionConnection';
import { startSyncWatchdogImpl } from './sessionWatchdogs';

/**
 * Unregisters this session's presence listener. Module-level because the presence store outlives
 * any one session, so the subscription has to be revocable from logout, which is elsewhere.
 */
let unregisterPeerReturn: (() => void) | null = null;

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Builds the RecoveryDeps required by requestReAdd / recoverForkedGroup.
 * Centralised here to avoid duplication across login and attemptReconnect.
 */
export function makeRecoveryDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  const st = ctx.getStorage();
  return {
    mlsService: ctx.ensureMls(),
    storage: st,
    userId: ctx.getUserId(),
    deviceKeyB64: ctx.getDeviceKey(),
    conversations: cb.conversations,
    getSelectedContact: cb.getSelectedContact,
    setSelectedContact: cb.setSelectedContact,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id: string) => st.deleteConversation(id) : undefined,
    log: cb.log,
  };
}

/**
 * Builds the dependency bag for `initializeConnection` (WebSocket open + post-connect group
 * reconciliation). Shared by the login path and `promoteOfflineSession`, which must perform the
 * exact same connection sequence - a second, hand-copied version would drift the moment either one
 * gained a callback.
 */
export function makeConnectionDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  return {
    mlsService: ctx.ensureMls(),
    userId: ctx.getUserId(),
    deviceKeyB64: ctx.getDeviceKey(),
    scheduleReconnect: () => scheduleReconnectImpl(ctx, cb),
    setIsWsConnected: (v: boolean) => ctx.setIsWsConnected(v),
    setReconnectAttempts: (v: number) => ctx.setReconnectAttempts(v),
    processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(ctx, cb),
    log: cb.log,
    onGroupMissing: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
    onGroupDeletedRemotely: (groupId: string) =>
      markConversationDeletedRemotely(
        cb.conversations,
        groupId,
        ctx.getUserId(),
        cb.saveConversation
      ),
  };
}

/**
 * Builds the OutboxDeps for the per-session message flusher. Recovery is non-destructive
 * (welcome_request only); a group is "healthy" to send into when its MLS state is in the WASM
 * AND it is not in a known unresolved epoch gap. Sending an application message into a group
 * whose local epoch is behind produces a ciphertext that up-to-date recipients cannot decrypt
 * (msg_epoch < their group_epoch) - the message is silently lost. Holding the outbox until the
 * gap resolves (commit catches us up, or escalation re-Welcomes us at the current epoch) makes
 * the eventual re-encode happen at the right epoch.
 */
export function makeOutboxDeps(ctx: SessionContext, cb: ChatSessionCallbacks) {
  return {
    mlsService: ctx.ensureMls(),
    storage: ctx.getStorage(),
    userId: ctx.getUserId(),
    deviceKeyB64: ctx.getDeviceKey(),
    conversations: cb.conversations,
    log: cb.log,
    requestReAdd: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
    recoverRosterDisagreement: (groupId: string) =>
      recoverRosterDisagreement(groupId, makeRecoveryDeps(ctx, cb)),
    isGroupHealthy: (groupId: string) => canSendInGroup(ctx.ensureMls(), groupId),
    // A session unlocked offline holds no token: hold the queue until promoteOfflineSession has
    // one and has reopened the socket, then it flushes explicitly.
    canFlush: () => !ctx.isOfflineSession(),
    markDeletedRemotely: (groupId: string) =>
      markConversationDeletedRemotely(
        cb.conversations,
        groupId,
        ctx.getUserId(),
        cb.saveConversation
      ),
    uploadMedia: async (media: NonNullable<import('$lib/db').OutboxEntry['media']>) => {
      const { MediaService } = await import('$lib/media');
      const token = await getToken();
      const bytes = media.fileBytes ?? new Uint8Array(0);
      const file = new File([bytes.buffer as ArrayBuffer], media.fileName ?? 'file', {
        type: media.mimeType,
      });
      return new MediaService().encryptAndUpload(file, token, {
        width: media.width,
        height: media.height,
      });
    },
  };
}

/** Processes any pending MLS invitations from our own other devices (multi-device sync). Re-entrant safe. */
export async function processDeviceInvitationsLocally(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
) {
  if (ctx.isSyncing()) return;
  ctx.setIsSyncing(true);
  try {
    await processPendingInvitations({
      mlsService: ctx.ensureMls(),
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      conversations: cb.conversations,
      requestReAdd: (groupId: string) => requestReAdd(groupId, makeRecoveryDeps(ctx, cb)),
      log: cb.log,
    });
  } finally {
    ctx.setIsSyncing(false);
  }
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Wipes all local MLS state, device ID, and stored DB for the given user.
 * Called when the server signals that this device has been revoked.
 */
export async function resetDeviceAsFreshImpl(
  ctx: SessionContext,
  userIdToReset: string,
  cb: ChatSessionCallbacks
): Promise<void> {
  const { removeMlsState } = await import('$lib/utils/hex');
  await removeMlsState(userIdToReset);
  localStorage.removeItem(`mls_device_id_${userIdToReset}`);
  localStorage.removeItem(`canari_sync_guide_seen_${userIdToReset}`);

  const deviceNamePrefix = `device-name:${userIdToReset}:`;
  const keysToDelete: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(deviceNamePrefix)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    localStorage.removeItem(key);
  }

  try {
    const storageToClear = await getStorage(userIdToReset);
    await storageToClear.clear();
    await storageToClear.close();
  } catch (e) {
    // Best-effort cleanup: continue even if local DB is not accessible - but never silently, since
    // a connection left open is what makes a later delete block instead of complete.
    console.warn('[SECURITY] could not clear the local database:', e);
  }

  // The session's OWN handle, which is a different connection from the one just opened above.
  // Dropping the reference does not close it, and an open connection defers any later delete.
  try {
    await ctx.getStorage()?.close();
  } catch (e) {
    console.warn('[SECURITY] could not close the session database:', e);
  }

  ctx.resetMls();
  ctx.setStorage(null);
  ctx.setMyDeviceId('');
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  clearDeviceKeyAndWrapKey();
  clearUserLocally();
  cb.log('[SECURITY] Revoked device detected: local state purged, reconnection required.');
}

/**
 * Returns a revoked device to a fresh install, whatever discovered the revocation.
 *
 * ONE CONSEQUENCE FOR ONE FACT. Three places learn that this device is revoked - the PIN check at
 * login, a `device_revoked` frame on a live session, and a vault or biometric login asking the
 * server - and the wipe must not differ between them. It did: the frame path skipped the MLS
 * teardown that the login path performs first, and it is the frame path that runs while the
 * service is live and could still write a key back.
 *
 * The steps are ordered on purpose: STOP the session first, revoke the refresh credential while the
 * network context still exists, and only then delete everything local - so nothing left running can
 * write a key back after the wipe. The PIN is cleared last because the wipe is what makes it
 * meaningless.
 *
 * "Tear the session down first" used to mean `resetMls()` alone, which nulls the client and stops
 * nothing: measured on prod 2026-08-28, the SYNC_WATCHDOG ticked 1.25 s later, rebuilt the MLS
 * database through `ensureMls()` and re-marked all ten groups not-ready - 8.2 MB of a device that
 * had just been returned to a fresh install. `tearDownLiveSession` is that step done properly, and
 * it runs BEFORE the first delete rather than alongside it.
 */
export async function wipeRevokedDevice(ctx: SessionContext, cb: ChatSessionCallbacks) {
  // BEFORE THE FIRST STEP, BECAUSE THE FIRST STEP IS WHAT OPENS THE DOOR. `tearDownLiveSession`
  // sets `isLoggedIn` false, and that is one of the three flags `loginImpl` reads to decide nobody
  // owns the flow - so the wipe was itself the event that let a login start and undo it. Measured on
  // prod 2026-08-29: a login began 3 ms after the `device_revoked` frame, its own revocation check
  // could not be answered (the wipe had already killed the session) so it read "not revoked", and it
  // reopened `CanariDB_<userId>` 24 ms before the delete - which does not fail on an open connection,
  // it BLOCKS. The store SURVIVED on a device its owner had declared lost.
  //
  // A latch and not a device id: between clearing `mls_device_id_<userId>` and deleting the stores
  // there is a window in which no identity exists to recognise, and a login slipping into it reopens
  // the database just the same. What must be excluded is the WIPE'S WHOLE DURATION, which is exactly
  // what this spans - and being released in `finally`, it can never leave a real user locked out.
  ctx.setWipingRevokedDevice(true);
  try {
    tearDownLiveSession(ctx, cb, 'revoked');
    ctx.resetMls();
    await resetDeviceAsFreshImpl(ctx, ctx.getUserId(), cb);
    await clearAuth();
    await wipeDeviceToFactory();
    ctx.setPin('');
  } finally {
    ctx.setWipingRevokedDevice(false);
  }
}

/**
 * Full login flow: verifies the PIN against the server (unless biometric mode),
 * initialises MLS, opens IndexedDB, restores conversations, connects the WebSocket,
 * and schedules device-sync.
 *
 * When `pin` is empty, biometric mode is assumed: the server-side pin-check is
 * skipped, and `mlsService.init()` is called with an empty PIN so the Rust side
 * path (`load_encrypted_with_keystore(pin: None)`) uses the platform keystore
 * (single biometric prompt via `retrieve_device_key`).
 *
 * On failure redirects to /login (or calls cb.onLoginFailed if provided).
 */
export async function loginImpl(ctx: SessionContext, cb: ChatSessionCallbacks): Promise<void> {
  const userId = ctx.getUserId();
  const pin = ctx.getPin();
  // Reassigned below once the PIN branch has fetched the server salt and derived the key.
  let deviceKeyB64 = ctx.getDeviceKey();

  // Biometric mode: skip the PIN-fields guard. The keystore handles authentication.
  // Vault-based (nativeStorageLogin) also skips pin-check: deviceKeyB64 is loaded from
  // the encrypted vault, proving the user already authenticated with the correct PIN.
  const isBiometric = deviceKeyB64.length === 0 && pin.length === 0;
  const isVaultLogin = deviceKeyB64.length > 0 && pin.length === 0;

  /**
   * Whether this login can complete with no network at all.
   *
   * Exactly the two paths above, and for exactly the reason they skip the server PIN check when
   * online: the platform keystore (biometrics) or the encrypted device-key vault IS the
   * authentication factor, so no server answer is part of the decision. Unlocking them offline
   * therefore verifies everything it verifies online - nothing is skipped and nothing is deferred.
   *
   * The PIN path is deliberately excluded: its at-rest key derives from a per-user salt that only
   * the server holds (`/api/mls/security/pin-salt`), and caching that salt on the device is what
   * would turn a 4-character PIN into an offline-bruteforceable secret. A PIN user offline still
   * gets the honest "cannot reach the server".
   */
  const offlineCapable = isBiometric || isVaultLogin;
  /** Set when the token could not be obtained: the session runs on local state only. */
  let offlineSession = false;

  if (!userId.trim()) {
    const msg = 'Please fill in all fields.';
    ctx.setLoginError(msg);
    cb.onLoginFailed?.(msg);
    return;
  }

  // Guard against a login starting while something else owns the flow: a concurrent call (onMount +
  // afterNavigate firing together), or the revocation wipe, whose teardown clears `isLoggedIn` and
  // would otherwise read as "nobody owns it" to the very login that then reopens what it deletes.
  // Returning silently here is intentional: the in-flight login owns the flow and will
  // resolve the caller's UI. An explicit PIN submit must clear this flag before calling
  // (see handlePinSubmit) so a user action is never swallowed by a background login.
  if (
    ctx.isLoggedIn() ||
    ctx.isReconnecting() ||
    ctx.getIsLoginInProgress() ||
    ctx.isWipingRevokedDevice()
  ) {
    // Name the flag that won. A swallowed user tap is otherwise indistinguishable in a log from a
    // tap that never reached loginImpl at all: on Android 2026-07-29 the FIRST biometric attempt of
    // a cold launch returned here and only a second tap 3 s later went through, with no way to tell
    // which of the three was still set - which is the whole reason that bug is still open.
    cb.log(
      `[LOGIN] Call ignored, a login already owns the flow (loggedIn=${ctx.isLoggedIn()}, ` +
        `reconnecting=${ctx.isReconnecting()}, loginInProgress=${ctx.getIsLoginInProgress()}, ` +
        `wipingRevokedDevice=${ctx.isWipingRevokedDevice()})`
    );
    return;
  }
  ctx.setIsLoginInProgress(true);

  ctx.setLoginError('');
  ctx.setUserId(userId.trim().toLowerCase());

  // Clear any stale reconnect timer from a previous session
  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  ctx.setReconnectAttempts(0);

  ctx.setTabLeaderSessionCb(cb);

  try {
    const mlsService = ctx.ensureMls();
    if (isBiometric) {
      cb.log('[BIOMETRIC] Skipping PIN verification - using device keystore...');
    } else {
      cb.log('Verifying PIN...');
    }

    // Start MLS state load immediately - pure I/O, doesn't need the token.
    const { loadMlsState } = await import('$lib/utils/hex');
    // loadMlsState already picks the backend for the runtime: `load_mls_state` (mls.bin) under
    // Tauri, IndexedDB on the web. So the source is decided by the runtime, not by which call
    // answered - the log used to report "IndexedDB" on a mobile launch that had just read mls.bin,
    // which is a misleading thing to hand someone reading a log to debug local storage. The
    // Tauri-only retry that used to sit here invoked the very same command loadMlsState had just
    // failed on, and could not answer where that one had not.
    const mlsStatePromise = (async (): Promise<
      { bytes: Uint8Array; source: 'native' | 'indexeddb' } | undefined
    > => {
      const loaded = await loadMlsState(ctx.getUserId());
      if (!loaded) return undefined;
      return { bytes: loaded, source: isTauriRuntime() ? 'native' : 'indexeddb' };
    })();

    let accessToken: string;
    try {
      accessToken = await getToken();
    } catch (err) {
      // A SessionExpiredError means the refresh cookie is dead (HTTP 401/403) - the session
      // cannot be recovered by re-entering the PIN. Surface it as a session loss (logout +
      // redirect to /login); fall back to a direct redirect when no callback is wired so
      // the user is never stranded in the PIN modal with a dead session.
      //
      // This branch stays unconditional, offline unlock or not: a 401 is an ANSWER. The server
      // was reached and refused us, which is precisely the case that must never be papered over
      // as "no network".
      if (err instanceof SessionExpiredError) {
        ctx.setIsLoginInProgress(false);
        if (cb.onSessionExpired) cb.onSessionExpired();
        else void goto('/login', { replaceState: true });
        return;
      }
      // Anything else is a transport failure (no network, backend restarting): the server was
      // never reached, so it has said nothing about this session.
      if (offlineCapable) {
        // Nothing this path needs from the server has been skipped - see `offlineCapable`. Carry
        // on with an empty token: the MLS state, the encrypted message store and the outbox are
        // all local, and `promoteOfflineSession` settles the session when the network returns.
        offlineSession = true;
        accessToken = '';
        connectivity.notifyServerUnreachable();
        cb.log('[LOGIN] Offline unlock (no token) - local session, will promote on reconnect.');
      } else {
        // The PIN path genuinely cannot continue: the salt it needs lives on the server. Keep the
        // PIN modal open with a truthful retryable message - do NOT claim the session expired.
        ctx.setIsLoginInProgress(false);
        const msg = m.auth_server_unreachable();
        ctx.setLoginError(msg);
        // Notify the caller so a PIN-modal spinner does not hang forever.
        cb.onLoginFailed?.(msg);
        return;
      }
    }

    // Collect the MLS state that was loading in the background.
    const mlsStateResult = await mlsStatePromise;
    if (mlsStateResult) {
      cb.log(
        mlsStateResult.source === 'native'
          ? 'MLS state loaded from mls.bin (native).'
          : 'MLS state loaded from IndexedDB.'
      );
    }

    // Biometric mode & vault-based login: skip server-side PIN verification.
    // The keystore (retrieve_device_key → BiometricPrompt) or the encrypted
    // device key vault are the authentication factors.
    if (!isBiometric && !isVaultLogin) {
      cb.log('Initialising MLS...');
      // Resolve the device id and verify the PIN BEFORE init(). init() decrypts the
      // encrypted MLS state, and a WRONG PIN makes that decryption fail - which would
      // trigger a destructive fresh-start (generate a new id + deleteDevice → revocation).
      // By resolving the real deviceId (no state decryption) and verifying the PIN first:
      //  - a wrong PIN is rejected without ever touching the device's identity or state;
      //  - a revoked device is matched on its real deviceId (not the 'pending' placeholder),
      //    so the one-shot reset fires instead of leaving it banned forever.
      // Fetch the per-user random salt from the server
      const saltRes = await fetchOrUnreachable(
        `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-salt/${encodeURIComponent(ctx.getUserId())}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        m.auth_pin_salt_unreachable()
      );
      if (!saltRes.ok) {
        throw new Error(m.auth_pin_salt_unreachable());
      }
      const { salt } = (await saltRes.json()) as { salt: string };
      const verifier = await computePinVerifier(ctx.getUserId(), ctx.getPin(), salt);
      const verifierHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      };
      const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
      const verifierPayload = JSON.stringify({ userId: ctx.getUserId(), verifier, deviceId });
      const pinCheckRes = await fetchOrUnreachable(
        `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`,
        { method: 'POST', headers: verifierHeaders, body: verifierPayload },
        m.auth_pin_check_unreachable()
      );
      if (!pinCheckRes.ok) {
        throw new Error(m.auth_pin_check_unreachable());
      }
      const pinCheckData = (await pinCheckRes.json()) as {
        status: string;
        resetRequired?: boolean;
      };

      if (pinCheckData.status === 'mismatch') {
        throw new LoginFailure('pin_mismatch', m.auth_pin_mismatch());
      }
      if (pinCheckData.resetRequired === true) {
        // A REVOKED DEVICE IS RETURNED TO A FRESH INSTALL, not merely stripped of its MLS state.
        // Its owner declared it lost or stolen, so leaving its cached media, its drafts, its
        // conversation list and its signed-in session behind answers the wrong question.
        await wipeRevokedDevice(ctx, cb);
        cb.log('[SECURITY] Revoked device: signed out and reset to a fresh install.');
        throw new LoginFailure('device_revoked', m.auth_device_revoked_reset());
      }
      if (pinCheckData.status === 'registered') cb.log('First device: PIN registered.');

      // PIN accepted: derive this device's at-rest key from it. Done here rather than at the
      // call site because it needs the same server salt the verifier was just computed with,
      // and it must not run before the PIN has been proven correct.
      deviceKeyB64 = await deriveDeviceKeyB64(ctx.getUserId(), pin, salt);
      ctx.setDeviceKey(deviceKeyB64);
    } else {
      cb.log(
        isVaultLogin
          ? 'Initialising MLS (vault device key path)...'
          : 'Initialising MLS (biometric keystore path)...'
      );
      // NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU. These two paths skip the PIN check
      // on purpose - the keystore and the vault ARE the authentication factor - but `resetRequired`
      // was the only thing that ever asked whether this device is still allowed to exist, so they
      // skipped that too. A device revoked while it was offline then logged straight back in and
      // kept everything, and the only remaining trigger was a `device_revoked` frame that had
      // already been sent to a device that was not there to receive it.
      //
      // The revocation is a server fact with a route of its own, so ASK IT, on every login path.
      // `resolveDeviceId` is safe here for the same reason the PIN path calls it before `init()`:
      // it reads the stored id and decrypts nothing. `isDeviceRevoked` answers `false` when it
      // cannot reach the server, so an offline login is never wiped by a transport failure.
      const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
      if (await mlsService.isDeviceRevoked(ctx.getUserId(), deviceId)) {
        await wipeRevokedDevice(ctx, cb);
        cb.log('[SECURITY] Revoked device: signed out and reset to a fresh install.');
        throw new LoginFailure('device_revoked', m.auth_device_revoked_reset());
      }
    }

    // PIN verified server-side (or biometric mode) - now decrypt the local MLS state.
    // When a saved state exists, pass noFreshStart so an undecryptable state (the account
    // PIN was rotated on another device → local state still sealed under the old PIN)
    // surfaces as a recoverable signal instead of a destructive fresh-start that would
    // drop history. In biometric mode, an empty PIN is passed so the Rust side invokes
    // retrieve_device_key (single BiometricPrompt).
    const [mlsInitSettled, storageSettled] = await Promise.allSettled([
      mlsService.init(ctx.getUserId(), deviceKeyB64, mlsStateResult?.bytes, {
        noFreshStart: !!mlsStateResult?.bytes,
        // Only the PIN paths can carry it, and only a snapshot older than the v0.11.0 envelope
        // change needs it: init re-seals such a snapshot instead of reporting a PIN rotation.
        legacyPin: !isBiometric && !isVaultLogin ? pin : undefined,
      }),
      getStorage(ctx.getUserId()),
    ]);
    if (mlsInitSettled.status === 'rejected') {
      const reason = mlsInitSettled.reason;
      const reasonStr = reason instanceof Error ? reason.message : String(reason);
      const isUndecryptable = reasonStr === MLS_LOCAL_STATE_UNDECRYPTABLE;
      if (isUndecryptable) {
        throw new LoginFailure('state_sealed_with_old_key', m.auth_state_sealed_old_pin());
      }
      // Empty keystore on biometric path: no key stored yet (first launch or
      // keystore was wiped). Surface a clean message and let the caller recover.
      if (isBiometric && /no keystore key/i.test(reasonStr)) {
        throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
      }
      throw mlsInitSettled.reason;
    }
    if (storageSettled.status === 'rejected') throw storageSettled.reason;

    // Biometric mode derived no key: init() passed an empty one and the native side resolved the
    // real key from the platform keystore, behind the single prompt this login already raised.
    // Pull it into the session now, BEFORE anything below reads ctx.getDeviceKey().
    //
    // This is not cosmetic. `deviceKeyB64` seals more than mls.bin, which Rust handles on its own:
    // locally stored messages are AES-256-GCM blobs encrypted *in the frontend*, so a session left
    // with an empty key cannot decrypt a single stored row (importDeviceKey rejects a zero-length
    // key) and cannot write a new one either - silently, because every persistence call site
    // swallows its error. That is a whole biometric session of history quietly not being saved.
    //
    // The local `deviceKeyB64` deliberately stays empty: it means "a key the caller supplied", and
    // it is what gates the device-key vault write and store_push_context further down. Biometric
    // mode must keep both skipped - the keystore is the only place this key belongs at rest.
    if (isBiometric) {
      const sessionKey = await mlsService.resolveSessionDeviceKey();
      if (!sessionKey || !isValidDeviceKeyB64(sessionKey)) {
        throw new LoginFailure('keystore_empty', m.auth_keystore_empty_enter_pin());
      }
      ctx.setDeviceKey(sessionKey);
    }

    ctx.setStorage(storageSettled.value);
    ctx.setMyDeviceId(mlsService.getDeviceId());
    cb.log(`MLS identity initialised (device: ${ctx.getMyDeviceId()})`);
    console.log(
      `[INIT] MLS initialized for userId=${ctx.getUserId()} device=${ctx.getMyDeviceId()}`
    );
    cb.log('Local database initialised.');

    // Notify only on genuine private browsing (blocked / ephemeral storage).
    void isLikelyPrivateBrowsing()
      .then((privateBrowsing) => {
        if (!privateBrowsing) return;
        ctx.setMlsFatalError('private_mode');
        cb.log(
          '[WARN] Private browsing detected - MLS state will not be persisted after window close.'
        );
        appendLog(
          'ℹ️ Private browsing mode: your messages will not be saved after the tab is closed.'
        );
      })
      .catch(() => {});

    // Offline: there is no token to set, and asking again would throw INSIDE this try - whose
    // catch calls resetMls() + clearUserLocally() + clearDeviceKey(). A network blip would then
    // destroy the very session that just unlocked. The empty token is what every network-touching
    // helper reads as "not authenticated yet"; promoteOfflineSession fills it in.
    ctx.setAuthToken(offlineSession ? '' : await getToken());
    ctx.setIsOfflineSession(offlineSession);

    ctx.setIsLoggedIn(true);
    saveUserLocally({ id: ctx.getUserId(), admin: isGlobalAdmin() });
    ctx.setIsMessagingInitializing(true);
    installCatchupBenchDevTools();
    beginStartupCatchupBench();
    cb.log('[INIT] MLS ready - syncing messages in background.');
    cb.onMlsReady?.();

    // Fire-and-forget: saveDeviceKey is independent of conversation loading.
    // The device key is always saved — on Tauri it feeds push_context.json for
    // background FCM decryption; on web it powers auto-login.
    // Biometric mode derives nothing: the keystore holds the key, so there is nothing to vault.
    if (deviceKeyB64) {
      void (async () => {
        await saveDeviceKey(deviceKeyB64);
      })();
    }

    // Stamp this session with the device that just unlocked. It is the ONLY
    // join between a login (core-service) and a device (delivery service), and
    // without it the security settings can list both but never say which row on
    // one is which row on the other. Fire-and-forget: an unstamped session is
    // fully functional, it simply shows as a row of its own - so a failure is
    // reported and dropped rather than delaying a screen the user is waiting on.
    // Skipped offline: there is no token yet, and promoteOfflineSession re-runs it.
    if (!offlineSession) {
      void bindCurrentSessionDevice(ctx.getMyDeviceId()).catch((e) =>
        cb.log(
          `[WARN] Session/device binding failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }

    // Check push health AFTER registration so pending_push_secret.txt is present
    // (written by store_push_secret during startPushService) before the health check runs.
    // Skipped offline - registering a push token requires the server, and the resulting failure
    // would raise a spurious "push degraded" fatal error. promoteOfflineSession re-runs it.
    if (offlineSession) {
      cb.log('[PUSH] Registration deferred - offline session.');
    } else {
      void startPushService(ctx.getHistoryBaseUrl(), ctx.getAuthToken(), ctx.getMyDeviceId())
        .then(async () => {
          cb.log('[PUSH] Push token registration complete.');
          if (!isTauriRuntime()) return;
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const health = await invoke<{ ok: boolean; reason?: string }>(
              'check_push_secret_health'
            );
            if (!health.ok && health.reason === 'no_secret') {
              ctx.setMlsFatalError('keystore_lost');
              cb.log(
                '[WARN] Push keystore lost - background notifications are degraded. Restart the app to re-enable them.'
              );
              appendLog('⚠️ Push notifications degraded - restart the app to re-enable them.');
            }
          } catch {
            /* non-blocking */
          }
        })
        .catch((e) =>
          cb.log(`[WARN] Push registration failed: ${e instanceof Error ? e.message : String(e)}`)
        );
    }

    // Message outbox: register the flusher before loading conversations so that
    // applyOutboxPendingStatuses can restore the "pending" status on restored messages.
    registerOutbox(makeOutboxDeps(ctx, cb));

    // Watch for connectivity returning. Registered on every session, not only the offline ones:
    // promoteOfflineSession no-ops on a session that already holds a token, and registering here
    // unconditionally keeps one lifecycle (login registers, logout unregisters) instead of a flag
    // deciding whether a listener exists.
    registerOfflinePromotion(ctx, cb, () => makeConnectionDeps(ctx, cb));

    // Group exits this device decided and the server never answered. Same lifecycle and the same
    // seam as the one above: a delete or a leave that met no server is owed until one answers, and
    // the answer cannot be waited for with a timer (see `pendingGroupExits`).
    registerPendingGroupExitDrain({
      getStorage: () => ctx.getStorage(),
      ensureMls: () => ctx.ensureMls(),
      getUserId: () => ctx.getUserId(),
      log: cb.log,
    });

    // THE INBOUND PIPELINE IS REGISTERED BEFORE ANYTHING CAN PULL, and that ordering is load-
    // bearing rather than tidy. The startup archive replay takes the mailbox barrier, the barrier
    // PULLS the delivery queue, and `processQueue` cannot drain a single frame until
    // `setupMessageHandler` has set the message callback - so with this block below the restore, a
    // device holding anything server-side pulled it into a queue with no consumer and waited for an
    // idle that could never come. Measured on prod 2026-08-15: 2 queued frames were enough to stop
    // a browser mid-boot, before tab leadership, with no socket and no error line, on every reload.

    beginStartupCatchupPhase('setup_handler');

    // A key-distribution group has its external-join base on social-service, not on chat-delivery:
    // the base IS the capability to read every seed on it, so it is gated on membership of the
    // scope it belongs to - a community, or one private salon - which only social-service holds.
    // Wired as a transport rather than imported, so the MLS layer never learns to speak to the
    // communities API.
    const distributionChannels = new ChannelService();
    mlsService.setDistributionGroupInfoTransport({
      fetch: async (scope) => {
        const ref = await distributionChannels.getDistributionGroup(scope);
        return ref.groupInfo !== null && ref.baseEpoch !== null
          ? { groupInfo: ref.groupInfo, baseEpoch: ref.baseEpoch, activeEpoch: ref.activeEpoch }
          : null;
      },
      publish: (scope, groupInfo, baseEpoch, deviceId) =>
        distributionChannels.publishDistributionGroupInfo(scope, groupInfo, baseEpoch, deviceId),
    });

    // Sealing a salon message needs the device key, the local store, the MLS client and who this
    // device is - four things a crypto utility has no business reaching for. They are decided here
    // and invalid after logout, so they are installed here and cleared in `logout`.
    setGraineRuntime({
      storage: ctx.getStorage()!,
      deviceKeyB64: ctx.getDeviceKey(),
      userId: ctx.getUserId(),
      mlsService,
    });
    // What a frame arriving on a distribution group MEANS. The MLS layer routes them here and
    // refuses to acknowledge one with no handler wired, so this is the difference between a seed
    // stored and a seed redelivered for ever.
    mlsService.onDistributionFrame(handleDistributionFrame);

    const callSystemCtx = {
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      storage: ctx.getStorage(),
      conversations: cb.conversations,
      addMessageToChat: cb.addMessageToChat,
    };
    setCallSystemMessageContext(callSystemCtx);
    ctx.getCallService()?.setChatNotifier({
      onCallStarted: (groupId: string, callId: string) =>
        recordCallStarted(getCallSystemMessageContext(), groupId, callId, ctx.getUserId()),
      onCallEnded: (groupId: string, callId: string) =>
        recordCallEnded(getCallSystemMessageContext(), groupId, callId),
    });

    setupMessageHandler({
      mlsService,
      storage: ctx.getStorage(),
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      historyBaseUrl: ctx.getHistoryBaseUrl(),
      conversations: cb.conversations,
      messageReactions: cb.messageReactions,
      getSelectedContact: cb.getSelectedContact,
      setSelectedContact: cb.setSelectedContact,
      saveConversation: cb.saveConversation,
      deleteConversation: ctx.getStorage()
        ? (id) => ctx.getStorage()!.deleteConversation(id)
        : undefined,
      drainOrphanMessages: cb.drainOrphanMessages,
      addMessageToChat: cb.addMessageToChat,
      batchAddMessages: cb.batchAddMessages,
      loadHistoryForConversation: cb.onLoadHistoryForConversation,
      onChannelMemberJoined: cb.onChannelMemberJoined,
      onChannelMemberKicked: cb.onChannelMemberKicked,
      onChannelUpdated: cb.onChannelUpdated,
      onRolePermissionsChanged: cb.onRolePermissionsChanged,
      onChannelDeleted: cb.onChannelDeleted,
      onWorkspaceUpdated: cb.onWorkspaceUpdated,
      onWorkspaceRoleChanged: cb.onWorkspaceRoleChanged,
      onWorkspaceDeleted: cb.onWorkspaceDeleted,
      onChannelMessageDeleted: cb.onChannelMessageDeleted,
      onReadStateAdvanced: cb.onReadStateAdvanced,
      onCallSignal: (senderId: string, groupId: string, callMsg) => {
        void handleCallSignalForChat(
          getCallSystemMessageContext(),
          senderId,
          groupId,
          callMsg as ICallMsg,
          ctx.getUserId()
        );
        ctx
          .getCallService()
          ?.handleCallSignal(
            senderId,
            groupId,
            callMsg,
            ctx.getUserId(),
            ctx.ensureMls().getDeviceId()
          );
      },
      onGroupReady: (() => {
        let t: ReturnType<typeof setTimeout> | null = null;
        return (readyGroupId: string) => {
          // The group just became sendable (Welcome processed / external join complete): drain
          // the outbox to deliver pending messages and refresh their status.
          flushOutbox();
          void applyOutboxPendingStatuses();
          const deferred = ctx.deferredWelcomeRequests.get(readyGroupId);
          if (deferred?.length) {
            ctx.deferredWelcomeRequests.delete(readyGroupId);
            for (const req of deferred) {
              handleWelcomeRequest({
                mlsService: ctx.ensureMls(),
                storage: ctx.getStorage(),
                userId: ctx.getUserId(),
                deviceKeyB64: ctx.getDeviceKey(),
                conversations: cb.conversations,
                log: cb.log,
                requesterUserId: req.requesterUserId,
                requesterDeviceId: req.requesterDeviceId,
                groupId: readyGroupId,
              }).catch(() => {});
            }
          }
          if (t !== null) clearTimeout(t);
          t = setTimeout(() => {
            t = null;
            processDeviceInvitationsLocally(ctx, cb).catch(() => {});
          }, 500);
        };
      })(),
      onMlsFatalError: (kind) => {
        ctx.setMlsFatalError(kind);
        if (kind === 'oom') {
          cb.log('[FATAL] Insufficient WASM memory - reload the application.');
          appendLog(
            '⚠️ Insufficient memory - reload the application to continue receiving messages.'
          );
        } else if (kind === 'private_mode') {
          cb.log(
            '[WARN] Private browsing detected - MLS state will not be persisted after window close.'
          );
          appendLog(
            'ℹ️ Private browsing mode: your messages will not be saved after the tab is closed.'
          );
        } else if (kind === 'keystore_lost') {
          cb.log('[WARN] Android keystore lost - push notifications degraded.');
          appendLog('⚠️ Push notifications degraded - restart the app to re-enable them.');
        }
      },
      log: cb.log,
    });

    if (cb.beginBulkMessageIngest && cb.endBulkMessageIngest) {
      const beginUi = cb.beginBulkMessageIngest;
      const endUi = cb.endBulkMessageIngest;
      mlsService.addBulkIngestObserver({
        onBulkIngestStart: (phase) => beginUi(phase),
        onBulkIngestEnd: (phase) => endUi(phase),
      });
    }
    endStartupCatchupPhase();

    // Adopt anything the native side queued on its own (an undelivered notification quick reply
    // lives only in the mirror file, which the next mirror rewrite would erase). BEFORE the load:
    // the adopted message is written to the store, so the ordinary history load displays it and
    // applyOutboxPendingStatuses below marks it pending.
    await adoptOrphanedMirrorEntries(ctx.getStorage()!, ctx.getDeviceKey(), ctx.getUserId()).catch(
      (e) => cb.log(`[OUTBOX_MIRROR] Adoption pass failed: ${String(e)}`)
    );

    // Load conversations first: consumeFcmCache can access
    // the conversations Map via addMessageToChat once it is populated.
    beginStartupCatchupPhase('load_conversations');
    await cb.loadAndRestoreConversations();
    {
      const stats = summarizeConversationStats(cb.conversations);
      endStartupCatchupPhase({
        conversationCount: stats.conversationCount,
        messageCount: stats.localMessageCount,
      });
    }
    // Reconcile background sends (killed app) first: remove from the outbox any
    // messages already delivered by the native service, BEFORE re-deriving "pending"
    // statuses (otherwise an already-sent message would be shown as pending again).
    await reconcileOutboxSent(ctx.getStorage()!).catch(() => {});
    // Re-mark "pending" messages still in the outbox queue (derived status, not persisted).
    await applyOutboxPendingStatuses();

    beginStartupCatchupPhase('fcm_cache');
    const fcmInjected = await consumeFcmCache(ctx.getDeviceKey(), ctx.getStorage()!).catch(
      () => [] as []
    );
    if (Array.isArray(fcmInjected) && fcmInjected.length > 0) {
      const mergedCount = mergeFcmMessagesIntoConversations(
        fcmInjected,
        cb.conversations,
        ctx.getUserId()
      );
      cb.log(`[FCM_CACHE] ${mergedCount} message(s) merged in memory at login`);
    }
    endStartupCatchupPhase({
      messageCount: Array.isArray(fcmInjected) ? fcmInjected.length : 0,
    });

    // What the notification shade acknowledged while the app was not running. AFTER the FCM cache:
    // the watermark's whole job is to recompute `unreadCount`, and it must count the messages that
    // pre-injection just added, not the ones that were there a moment ago.
    await consumeNativeReadWatermarks(cb.conversations, ctx.getUserId(), cb.saveConversation).catch(
      (e) => cb.log(`[READ_WATERMARK] Merge pass failed: ${String(e)}`)
    );

    try {
      const localMlsGroups = new SvelteSet(mlsService.getLocalGroups());
      const missingKeys: string[] = [];
      // Conversations stuck in 'pending' while their local MLS state exists:
      // the "Sync" badge would remain forever (DF5). Reconciliation demoted absent
      // groups but never promoted the inverse - this adds the mirror promotion.
      const recoveredKeys: string[] = [];
      for (const [key, c] of cb.conversations.entries()) {
        if (isChannelConversationId(c.id)) continue;
        if (c.lifecycle === 'active' && !localMlsGroups.has(c.id)) {
          cb.conversations.set(key, { ...c, lifecycle: 'pending' });
          missingKeys.push(key);
        } else if (c.lifecycle === 'pending' && localMlsGroups.has(c.id)) {
          cb.conversations.set(key, { ...c, lifecycle: 'active' });
          recoveredKeys.push(key);
        }
      }
      if (missingKeys.length > 0) {
        cb.log(
          `[WARN] Groups without local MLS state detected - ${missingKeys.length} conversation(s) marked not-ready, re-invite triggered on next connect.`
        );
        console.warn(
          `[INIT] ${missingKeys.length} conversation(s) missing local MLS state - marked not-ready`
        );
        await Promise.all(missingKeys.map((key) => cb.saveConversation(key).catch(() => {})));
      }
      if (recoveredKeys.length > 0) {
        cb.log(
          `[INIT] ${recoveredKeys.length} conversation(s) stuck pending but already synced - "Sync" badge cleared.`
        );
        await Promise.all(recoveredKeys.map((key) => cb.saveConversation(key).catch(() => {})));
      }
    } catch (e) {
      console.warn('[INIT] Error detecting missing MLS groups:', e);
    }

    // processDeviceInvitationsLocally is called at the end of syncConnectionAfterWsOpen -
    // calling it here before the WebSocket is opened is redundant.

    if ('onWelcomeProcessed' in mlsService) {
      (mlsService as any).onWelcomeProcessed(async (groupId?: string) => {
        if (groupId) {
          cb.log(`[SYNC] Welcome processed for ${groupId}, refreshing...`);
          if (!cb.conversations.has(groupId)) {
            cb.conversations.set(groupId, {
              id: groupId,
              contactName: groupId,
              name: groupId,
              messages: [],
              lifecycle: 'active',
              mlsStateHex: null,
              unreadCount: 0,
              conversationType: 'group',
            });
            await cb.saveConversation(groupId);
            await cb
              .loadAndRestoreConversations()
              .catch((e) => cb.log(`[WARN] Error resyncing convs (Welcome): ${e}`));
            // Fresh join: the Welcome lands us at the current epoch with no pre-join history. The
            // inviter pushes a bundle on the foreground add path, but its background twin
            // (send-welcome-and-commit) does not, so we compare here as well - which costs one
            // frame when the bundle already arrived, and repairs the group when it did not.
            await reconcileGroup(mlsService, groupId, cb.log);
          }
          cb.onLoadHistoryForConversation(groupId, groupId).catch((e) =>
            cb.log(`[WARN] Error refreshing conv ${groupId}: ${e}`)
          );
        } else {
          cb.log('[SYNC] Welcome processed, refreshing conversations...');
          cb.loadAndRestoreConversations().catch((e) =>
            cb.log(`[WARN] Error refreshing convs: ${e}`)
          );
        }
      });
    }

    mlsService.onDeviceRevoked(() => {
      void (async () => {
        // GATED ON A SERVER FACT, NEVER ON THE FRAME. The frame says "you were deleted"; erasing a
        // device on the strength of a message is exactly the destructive-control shape that has to
        // be confirmed first. `isDeviceRevoked` answers false when it cannot reach the server, so a
        // transport failure can never destroy anything - a status code is an answer, a transport
        // failure is not.
        const deviceId = await mlsService.resolveDeviceId(ctx.getUserId());
        const revoked = await mlsService.isDeviceRevoked(ctx.getUserId(), deviceId);
        if (!revoked) {
          cb.log('[SECURITY] device_revoked frame received but the server disagrees - ignored.');
          return;
        }
        cb.log('[SECURITY] This device was revoked by its owner - signing out and resetting.');
        await wipeRevokedDevice(ctx, cb);
        // A REVOCATION IS NOT A FAILED LOGIN ATTEMPT, AND THE SEAM DECIDES WHAT THE USER SEES.
        // `onLoginFailed` means "the credential you just offered was refused, stay in the modal and
        // try again" - which is right at the two login-path call sites above, where a person is
        // standing at the gate. Here there is no gate and nothing to retry: the wipe one line up has
        // just returned this device to a fresh install, so there is no PIN, no device id and no
        // session left for a modal to act on. The live callbacks bind `onLoginFailed` to the
        // saved-PIN handler, so this call REOPENED THE PIN PROMPT on top of /chat and the app then
        // sat there - measured on prod 2026-08-29: no sidebar, no session, no navigation, until the
        // prompt's own attempt drew a 401 and the session-expired path finally did the redirect.
        //
        // `onSessionExpired` is the seam written for exactly this - an authentication loss rather
        // than a retryable error - and it is the one callback the background service wires
        // unconditionally: it clears the auth and goes to /login. Nothing is lost by the change,
        // because the message it replaces was displayed in a modal the app abandoned two seconds
        // later anyway.
        cb.onSessionExpired?.();
      })();
    });

    // A DEVICE ASKING FOR A BASE REFRESH IS A DEVICE THAT CANNOT GET IN AT ALL, so this is answered
    // before anything else and logged at a level that accuses. The published external-join base names
    // an epoch the group has left; nothing but a member's publish can move it, and only a commit
    // otherwise does - so on a quiet conversation a stale base is permanent. Measured on production
    // 2026-09-04: four groups stale, all by exactly one epoch, two of them since 2026-08-30 with
    // three devices sitting `pending` on them.
    //
    // WHAT THIS IS NOT: it is not an Add. Nothing here mutates the tree, takes the group's add lock
    // or changes an epoch - `refreshGroupInfo` exports what this device already holds and publishes
    // it. That is the whole reason the requester asks for THIS rather than for a Welcome.
    //
    // A RESPONDER WHOSE OWN TREE IS BEHIND CANNOT HELP, AND DOES NOT HAVE TO CHECK. The publish is
    // monotonic server-side - a lower `baseEpoch` is ignored - so a behind device cannot make the
    // base worse, and the requester's next ask is forwarded to a randomly re-elected member. The
    // epoch this device published at is logged so the two outcomes stay distinguishable.
    mlsService.onBaseRefreshRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        const short = groupId.slice(0, 8);
        cb.log(
          `[BASE_REFRESH] ${short}... asked by ${requesterUserId.slice(0, 8)}:${requesterDeviceId.slice(0, 12)}` +
            ` - a device cannot external-join this group`
        );
        try {
          const mls = ctx.ensureMls();
          if (!(await mls.isGroupActive(groupId))) {
            // Not a fault of the requester's, and not silent: this device was elected and holds no
            // usable state for the group, so the ask has to reach somebody else.
            cb.log(
              `[BASE_REFRESH] ${short}... this device holds no active MLS state for it - cannot mint a base`
            );
            return;
          }
          await mls.refreshGroupInfo(groupId);
          cb.log(`[BASE_REFRESH] ${short}... republished at epoch ${mls.getEpoch(groupId)}`);
        } catch (e) {
          cb.log(`[BASE_REFRESH] ${short}... refresh failed: ${String(e).slice(0, 120)}`);
        }
      }
    );

    mlsService.onWelcomeRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] welcome_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        try {
          await handleWelcomeRequest({
            mlsService: ctx.ensureMls(),
            storage: ctx.getStorage(),
            userId: ctx.getUserId(),
            deviceKeyB64: ctx.getDeviceKey(),
            conversations: cb.conversations,
            log: cb.log,
            requesterUserId,
            requesterDeviceId,
            groupId,
            onNotReady: (terminalGroupId) => {
              const list = ctx.deferredWelcomeRequests.get(terminalGroupId) ?? [];
              list.push({ requesterUserId, requesterDeviceId });
              ctx.deferredWelcomeRequests.set(terminalGroupId, list);
              cb.log(`[WELCOME_REQ] ${terminalGroupId.slice(0, 8)}... not ready yet - deferred`);
            },
          });
        } catch (e) {
          cb.log(
            `[WARN] Echec handleWelcomeRequest: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    );

    // The only place holding the store, the device key and the MLS client at once, so it is where
    // the reconciliation's probe sender is installed. Every solicitation says what this device HOLDS
    // before asking anything, which is what lets the usual answer be silence.
    setHistoryProbeSender(async (groupId: string) => {
      const mls = ctx.ensureMls();
      return sendHistoryStateKey(groupId, digestIdentity(ctx.getUserId(), mls.getDeviceId()), {
        storage: ctx.getStorage(),
        deviceKeyB64: ctx.getDeviceKey(),
        mlsService: mls,
        log: cb.log,
      });
    });

    // INSTALLING THE SENDER IS ITSELF AN EDGE, and this is where it is discharged. Frames drain
    // before this point in the setup, so a frame MLS could never decrypt has already asked for the
    // one repair that exists and has already been acked off the server - the ask is the only trace
    // of the gap left anywhere. Dropping it kept a production DM permanently short of the messages
    // it had lost. Fired here, in the same tick as the registration, so nothing drained in between
    // falls in the gap; it returns immediately when nothing is deferred.
    void retryDeferredReconciliations(mlsService, mlsService.getLocalGroups(), cb.log);

    // A reconciliation the server could not elect anybody for has to wait for a member to return,
    // and presence tells us that within ten seconds. This is that seam, and it retries ONLY the
    // groups that could not be asked at all - every other group was already compared on this
    // connection, and a presence edge says nothing new about them.
    unregisterPeerReturn?.();
    unregisterPeerReturn = onPeersCameOnline(() => {
      // `ensureMls` CREATES the service when there is none, so it must never be reached from a
      // background callback: storage is what says a session is live, the same guard `sendDisconnect`
      // uses. Without it a stray edge after teardown would build an MLS client for nobody.
      if (!ctx.getStorage()) return;
      const mls = ctx.ensureMls();
      cb.log('[HISTORY_RECONCILE] a peer came back online - retrying what nobody could answer');
      void retryDeferredReconciliations(mls, mls.getLocalGroups(), cb.log);
    });

    mlsService.onHistoryRequest(
      async (requesterUserId: string, requesterDeviceId: string, groupId: string) => {
        cb.log(
          `[SYNC] history_request received from ${requesterUserId}:${requesterDeviceId} for ${groupId}`
        );
        // OUR MAILBOX FIRST, here too: this is the leg where we state what we hold, and a state key
        // computed over a store still being filled makes this device an unreliable source - it can
        // claim agreement it does not have yet, which ends the exchange with the two still apart.
        // Deferred rather than awaited for the same reason as every other leg: whether this
        // callback runs inside the drain is not something this call site should have to know.
        answerAfterMailboxDrained(ctx.ensureMls(), groupId, async () => {
          try {
            await handleHistoryRequest({
              mlsService: ctx.ensureMls(),
              storage: ctx.getStorage(),
              deviceKeyB64: ctx.getDeviceKey(),
              conversations: cb.conversations,
              log: cb.log,
              requesterUserId,
              requesterDeviceId,
              selfUserId: ctx.getUserId(),
              groupId,
            });
          } catch (e) {
            cb.log(
              `[WARN] Echec handleHistoryRequest: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        });
      }
    );

    const tabLeaderNow = await initTabLeadershipAsync(cb.log);
    ctx.setIsTabLeader(tabLeaderNow);
    if (!tabLeaderNow) {
      cb.log('[TAB] Follower tab - WebSocket active in another Canari tab.');
    }

    // Offline: skip the connection entirely rather than let it fail. openGatewayConnection would
    // degrade correctly on its own, but the attempt costs a timeout on a launch that already knows
    // there is no network, and it logs "Gateway inaccessible" for a device that never had one.
    if (offlineSession) {
      cb.log('[INIT] Offline session - gateway connection deferred until the network returns.');
      finishStartupCatchupBench(cb.log);
    } else {
      beginStartupCatchupPhase('initialize_connection');
      await initializeConnection(makeConnectionDeps(ctx, cb));
      {
        const stats = summarizeConversationStats(cb.conversations);
        endStartupCatchupPhase({
          conversationCount: stats.conversationCount,
          messageCount: stats.localMessageCount,
        });
      }
      finishStartupCatchupBench(cb.log);

      // Connection established and groups reconciled: drain the outbox (covers reconnection,
      // which re-runs initializeConnection).
      flushOutbox();

      // Same moment, and NOT covered by the reconnect listener: an app killed while offline comes
      // back with the link already up, so no `online` edge ever fires for the exit it still owes.
      void flushPendingGroupExits();
    }

    const STALE_SESSION_MS = 90 * 24 * 60 * 60 * 1_000;
    const lastActiveKey = `canari_last_active:${ctx.getUserId()}`;
    const lastActiveRaw = localStorage.getItem(lastActiveKey);
    if (lastActiveRaw) {
      const lastActive = parseInt(lastActiveRaw, 10);
      if (Number.isFinite(lastActive) && Date.now() - lastActive > STALE_SESSION_MS) {
        appendLog(
          '⚠️ You have not logged in for more than 3 months. Some older messages may no longer be available.'
        );
      }
    } else if (isTauriRuntime()) {
      // localStorage may be empty after Android process kill - try Tauri Store fallback.
      try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load('session-meta.json', { autoSave: true, defaults: {} });
        const nativeLastActive = await store.get<number>(lastActiveKey);
        if (
          typeof nativeLastActive === 'number' &&
          Date.now() - nativeLastActive > STALE_SESSION_MS
        ) {
          appendLog(
            '⚠️ You have not logged in for more than 3 months. Some older messages may no longer be available.'
          );
        }
      } catch {
        /* non-blocking */
      }
    }
    const nowMs = Date.now();
    localStorage.setItem(lastActiveKey, String(nowMs));
    // Persist to Tauri Store so the value survives Android process kills.
    if (isTauriRuntime()) {
      import('@tauri-apps/plugin-store')
        .then(({ load }) => load('session-meta.json', { autoSave: true, defaults: {} }))
        .then((store) => store.set(lastActiveKey, nowMs))
        .catch(() => {});
    }

    if (!getIsTabLeader()) return;

    // Everything below talks to the server. On an offline session the watchdogs are the harmful
    // part: the connection watchdog would schedule a reconnect every tick against a network that is
    // not there, and an offline session has no access token for the handshake to carry anyway - so
    // every attempt is known-futile before it is made, which is the one case where NOT retrying is
    // the right answer. promoteOfflineSession starts all of this once a token exists.
    if (offlineSession) return;

    runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls());

    // Graine retention, once per boot and LEADER-ONLY: two tabs sweeping would ask the same
    // question twice and race each other's deletes. Deliberately after the startup bench is closed
    // - it is maintenance, not startup, and nothing waits on it. Its own failures are logged and
    // swallowed inside; the catch here only exists because this call site cannot await it.
    sweepExpiredGraineSeeds().catch((e: unknown) => {
      console.warn(`[GRAINE] retention sweep threw: ${e instanceof Error ? e.message : String(e)}`);
    });

    for (const delay of [35_000, 70_000]) {
      setTimeout(() => {
        if ([...cb.conversations.values()].some((c) => c.lifecycle === 'pending')) {
          runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls(), 'retry');
        }
      }, delay);
    }

    startSyncWatchdogImpl(ctx, cb);
    startConnectionWatchdogImpl(ctx, cb);
  } catch (_e: unknown) {
    cancelStartupCatchupBench();
    const msg = _e instanceof Error ? _e.message : String(_e);
    const code = loginErrorCode(_e);
    ctx.setLoginError(msg);
    // AN ORDINARY OUTCOME IS NARRATED, A DEFECT IS ACCUSED - see `isExpectedLoginOutcome` for why
    // one catch cannot say both with one level. The code is read here rather than below because the
    // log is the first thing anybody looks at, and a mistyped PIN or a train tunnel filed under
    // `[INIT] Login failed` beside a WASM that would not load is a line whose reader learns to skip
    // it. The code is NAMED in the line so the two can still be told apart at a glance.
    if (isExpectedLoginOutcome(code)) {
      cb.log(`[INIT] Login did not complete (${code}): ${msg}`);
      console.warn(`[INIT] Login did not complete (${code}):`, msg);
    } else {
      cb.log(`Error: ${msg}`);
      console.error(`[INIT] Login failed (${code}):`, msg);
    }
    ctx.resetMls();
    clearUserLocally();
    clearDeviceKey();
    // A dead session (refresh cookie expired/revoked) is not retryable via the PIN modal:
    // hand it to onSessionExpired so the caller logs out and redirects to /login. When no
    // callback is wired, redirect directly so the user is never stranded in the modal.
    if (_e instanceof SessionExpiredError) {
      if (cb.onSessionExpired) cb.onSessionExpired();
      else void goto('/login', { replaceState: true });
    } else if (cb.onLoginFailed) {
      cb.onLoginFailed(msg, code);
    } else {
      const cur = window.location.pathname + window.location.search + window.location.hash;
      void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
    }
  } finally {
    ctx.setIsLoginInProgress(false);
    ctx.setIsMessagingInitializing(false);
  }
}

/**
 * On Tauri (no biometrics), restores the device key from the vault and delegates to loginImpl().
 * Returns true if login succeeded, false if manual PIN entry is still needed.
 *
 * Option C: when biometrics are configured, do NOT attempt the automatic login. The flow must
 * go through the PinModal (or the biometric prompt) so the platform keystore stays the
 * authentication factor.
 */
export async function nativeStorageLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  biometricConfigured?: boolean
): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  // Option C: skip the auto-login when biometrics are configured. Biometrics take priority --
  // the flow must go through the BiometricBottomSheet or the PinModal, not the auto-login.
  try {
    let isConfigured: boolean;
    if (biometricConfigured !== undefined) {
      isConfigured = biometricConfigured;
    } else {
      const { BiometricService } = await import('$lib/services/biometric');
      isConfigured = await BiometricService.isConfigured();
    }
    if (isConfigured) {
      appendLog('[PIN] Biometric configured - skipping native storage auto-login');
      return false;
    }
  } catch {
    // Cannot determine the biometric state: fall through to the auto-login attempt.
  }

  // Read deviceKeyB64 from the device key vault (AES-GCM encrypted), never from
  // push_context.json.
  try {
    const { loadDeviceKey } = await import('$lib/utils/deviceKeyVault');
    const deviceKeyB64 = await loadDeviceKey();
    if (!deviceKeyB64) {
      appendLog('[PIN] No device key in vault - auto-login impossible');
      return false;
    }
    // Builds before the derivation existed stored the raw PIN under this key. Such a value can
    // never decrypt anything, so refuse the auto-login and let the PIN modal re-derive a real
    // key rather than failing deeper in the crypto stack with an opaque error.
    if (!isValidDeviceKeyB64(deviceKeyB64)) {
      appendLog('[PIN] Vaulted device key is not a 32-byte key - discarding, PIN required');
      const { clearDeviceKeyAndWrapKey: dropVault } = await import('$lib/utils/deviceKeyVault');
      dropVault();
      return false;
    }
    appendLog('[PIN] Device key restored from PinVault - auto-login…');
    ctx.setDeviceKey(deviceKeyB64);
    await loginImpl(ctx, cb);
    return ctx.isLoggedIn();
  } catch {
    return false;
  }
}

/**
 * Biometric login: delegates to loginImpl() WITHOUT a PIN. The platform keystore
 * (Android KeyStore / iOS Keychain) holds the MLS decryption key directly (see
 * docs/wiki/frontend/modules/auth.md, "Where the key lives"). `retrieve_device_key`
 * triggers the single biometric prompt.
 *
 * When the keystore is empty (first launch, app reinstall), the biometric prompt
 * still appears (user-presence check) but loginImpl will surface a clean
 * "keystore empty" error — the caller should then fall back to the PIN modal
 * without showing an error to the user.
 */
export async function biometricLoginImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  ctx.setLoginError('');
  cb.log('[BIOMETRIC] Biometric login attempt (keystore key path)...');
  try {
    const savedUser = currentUserId();
    if (!savedUser) {
      ctx.setLoginError('No user registered for biometric authentication.');
      cb.log('[BIOMETRIC] Failed - no local user found.');
      return;
    }
    cb.log(`[BIOMETRIC] Authenticating for userId=${savedUser.slice(0, 8)} via device keystore...`);
    ctx.setUserId(savedUser);
    // Pass an empty PIN AND an empty device key — loginImpl selects its mode from that pair,
    // and only (deviceKey === '' && pin === '') means biometric. Clearing the device key is
    // required, not cosmetic: after a failed PIN attempt the session still holds the derived
    // key, which would put loginImpl in vault mode and silently retry that same key instead
    // of reading the keystore. loginImpl then calls load_encrypted_with_keystore(key: None),
    // which triggers retrieve_device_key → single BiometricPrompt.
    ctx.setPin('');
    ctx.setDeviceKey('');

    // P2-B: never swallow the authentication error. If the user cancels the BiometricPrompt
    // the error must reach startLoginFlow, which then shows the PinModal (P2-A). Rust
    // distinguishes "empty keystore" from "authentication cancelled" via distinct messages.
    await loginImpl(ctx, cb);
  } catch (e) {
    ctx.setLoginError('Biometric authentication failed. Please enter your PIN manually.');
    cb.log(`[BIOMETRIC] Exception: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  }
}

/**
 * Fetches this user's PIN salt from the server. The salt is the shared input to BOTH the
 * account verifier ({@link computePinVerifier}) and this device's at-rest key
 * ({@link deriveDeviceKeyB64}), so every flow that touches the PIN needs it.
 */
async function fetchPinSalt(ctx: SessionContext, userId: string, token: string): Promise<string> {
  const res = await fetchOrUnreachable(
    `${ctx.getHistoryBaseUrl()}/api/mls/security/pin-salt/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    m.auth_pin_salt_unreachable()
  );
  if (!res.ok) throw new Error(m.auth_pin_salt_unreachable());
  const { salt } = (await res.json()) as { salt: string };
  return salt;
}

/**
 * Changes the account PIN for a logged-in user.
 *
 * Two halves that must both happen, in this order:
 *  1. Rotate the account-wide verifier server-side (`POST mls/security/pin-change`), which
 *     also proves the user knows the current PIN. Done FIRST: if the local re-encryption
 *     then fails, the account already expects the new PIN and the user can finish with
 *     {@link recoverPinImpl} (old PIN -> new PIN). The reverse order would leave the
 *     account on the old PIN with local state sealed under the new key -- unrecoverable.
 *  2. Re-derive this device's key from the new PIN and re-encrypt the MLS state plus every
 *     locally stored message under it ({@link performPinChange}).
 *
 * The other devices keep their old key locally and will hit a verifier mismatch at their
 * next login; {@link recoverPinImpl} is what gets them across. That is inherent: the device
 * key never leaves the device.
 *
 * @throws A user-facing (localized) message when the current PIN is wrong or the server is
 *         unreachable.
 */
export async function changePinImpl(
  ctx: SessionContext,
  log: (msg: string) => void,
  currentPin: string,
  newPin: string,
  onProgress?: PinProgressCallback
): Promise<void> {
  const userId = ctx.getUserId();
  if (!userId.trim()) throw new Error(m.auth_no_user_signed_in());
  log('[PIN_CHANGE] Starting PIN change...');
  onProgress?.({ percent: 2, stage: 'verify' });

  const token = await getToken();
  const salt = await fetchPinSalt(ctx, userId, token);
  const [oldVerifier, newVerifier] = await Promise.all([
    computePinVerifier(userId, currentPin, salt),
    computePinVerifier(userId, newPin, salt),
  ]);

  onProgress?.({ percent: 6, stage: 'server' });
  const res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, oldVerifier, newVerifier }),
  });
  if (res.status === 403) throw new Error(m.auth_pin_change_current_incorrect());
  if (!res.ok) throw new Error(m.auth_pin_change_server_error());
  log('[PIN_CHANGE] Account verifier rotated server-side.');

  // Derive both device keys from the same salt: the old one to read the existing state,
  // the new one to re-seal it.
  const [currentDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, currentPin, salt),
    deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  await performPinChange(
    {
      userId,
      mlsService: ctx.ensureMls(),
      setDeviceKey: (k: string) => ctx.setDeviceKey(k),
      log,
      onProgress,
    },
    currentDeviceKeyB64,
    newDeviceKeyB64
  );
  log('[PIN_CHANGE] Complete - local state re-encrypted under the new PIN.');
}

/**
 * "PIN changed on another device" recovery. The account PIN was rotated elsewhere, so
 * this device's local MLS state is still sealed under the OLD pin while the server now
 * expects the NEW one. Decrypts the local state with the OLD device key (non-destructively),
 * re-encrypts it under the NEW one, then logs in normally - preserving every local message
 * instead of falling back to a fresh-start.
 *
 * Throws a user-facing message when the new PIN is wrong, the old PIN does not decrypt
 * the local state, or there is no local state to recover.
 */
export async function recoverPinImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  oldPin: string,
  newPin: string,
  onProgress?: PinProgressCallback
): Promise<void> {
  const userId = ctx.getUserId();
  if (!userId.trim()) throw new Error(m.auth_no_user_signed_in());
  cb.log('[PIN_RECOVER] Starting recovery...');
  onProgress?.({ percent: 3, stage: 'verify' });

  const { loadMlsState } = await import('$lib/utils/hex');
  const state = await loadMlsState(userId);
  if (!state) {
    throw new Error(m.auth_no_local_state_recover());
  }

  // The new PIN must be the real (rotated) account PIN: verify its verifier server-side.
  const token = await getToken();
  const salt = await fetchPinSalt(ctx, userId, token);
  const newVerifier = await computePinVerifier(userId, newPin, salt);
  const res = await fetch(`${ctx.getHistoryBaseUrl()}/api/mls/security/pin-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, verifier: newVerifier }),
  });
  if (!res.ok) throw new Error(m.auth_pin_verify_new_unreachable());
  const data = (await res.json()) as { status: string };
  if (data.status !== 'ok') {
    throw new Error(m.auth_pin_new_incorrect());
  }

  // Both device keys come from the same salt: the old one still seals the local state,
  // the new one is what every device will derive from now on.
  const [oldDeviceKeyB64, newDeviceKeyB64] = await Promise.all([
    deriveDeviceKeyB64(userId, oldPin, salt),
    deriveDeviceKeyB64(userId, newPin, salt),
  ]);

  onProgress?.({ percent: 15, stage: 'mls' });
  // Non-destructively decrypt local state with the old key, then re-encrypt under the new.
  const mls = ctx.ensureMls();
  const ok = await mls.recoverAndRekey(userId, oldDeviceKeyB64, newDeviceKeyB64, state);
  if (!ok) {
    throw new Error(m.auth_pin_old_incorrect());
  }
  cb.log('[PIN_RECOVER] MLS state re-encrypted with the new device key.');

  const storage = await getStorage(userId);
  await reencryptLocalMessages(storage, oldDeviceKeyB64, newDeviceKeyB64, cb.log, onProgress, {
    start: 20,
    end: 82,
  });
  cb.log('[PIN_RECOVER] Local messages re-encrypted with the new device key.');

  onProgress?.({ percent: 88, stage: 'finalize' });
  await applyNewDeviceKeyLocally(newDeviceKeyB64, cb.log);
  ctx.setPin(newPin);
  ctx.setDeviceKey(newDeviceKeyB64);

  onProgress?.({ percent: 92, stage: 'login' });
  // Continue with a normal login. init() is a no-op (recoverAndRekey already marked the
  // client initialised), so the decrypted client is reused and all messages are kept.
  await loginImpl(ctx, cb);
  if (!ctx.isLoggedIn()) {
    throw new Error(m.auth_login_failed_after_recovery());
  }
  onProgress?.({ percent: 100, stage: 'login' });
  cb.log('[PIN_RECOVER] Complete - messages preserved.');
}

/**
 * Stops everything this session is running, and stops it for good.
 *
 * ONE SEAM FOR "THIS SESSION IS OVER", because the two exits differ only in what they may still
 * write. A sign-out and a revocation both leave a five-second watchdog, an outbox, four timers and
 * a set of listeners behind, and only `logoutImpl` ever took them down: the revocation path set its
 * flags and wiped the disk while the SYNC_WATCHDOG kept ticking. Measured on prod 2026-08-28:
 * 1.25 s after a device was revoked and wiped, the watchdog found ten conversations still in memory
 * and an empty WASM, and drove `requestReAdd` for all ten - re-marking every group not-ready and
 * REBUILDING the MLS database through `ensureMls()`, which creates a client whenever it finds none.
 * A wipe is not a wipe while something is still running that can put the state back.
 *
 * `reason` is the only discriminator, and both differences follow from it. A revoked device must not
 * FLUSH its MLS state on the way out - that write is the one thing the wipe exists to remove - and
 * must not deregister its push token, which the server already deleted when it revoked the device,
 * so asking would earn a 401 and nothing else.
 *
 * It deliberately does NOT clear the auth token or the storage handle: `clearAuth` needs the token
 * to revoke the refresh credential, and the wipe needs the handle to close the connection that
 * would otherwise defer every delete. Each caller owns its own erasure, in its own order.
 */
export function tearDownLiveSession(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  reason: 'logout' | 'revoked'
): void {
  unregisterOutbox();
  // Detach the reconnect listener too, or a regained network would promote a session that no
  // longer exists - reopening a WebSocket for the user who just signed out.
  unregisterOfflinePromotion();
  // Same reason: an exit owed by the user who just signed out must not be replayed with the next
  // one's token. The row survives in storage, and that user's next login replays it.
  unregisterPendingGroupExitDrain();
  resetHistoryReconciliation();
  // The probe sender closes over this session's storage and device key, so it must not outlive it:
  // a reconciliation from the next login would otherwise describe the previous user's store.
  setHistoryProbeSender(null);
  // Same reason, and the presence poll outlives a logout: an edge arriving afterwards would
  // reconcile history for the user who just signed out.
  unregisterPeerReturn?.();
  unregisterPeerReturn = null;

  if (reason === 'logout') {
    void flushActiveMlsStateEncrypted().finally(() => {
      uninstallMlsStatePersisterLifecycle();
      unregisterMlsStatePersister();
      // Dispose after the final flush: flushEncrypted relies on the encrypt worker.
      disposeMlsEncryptWorker();
    });
  } else {
    // NO FINAL FLUSH FOR A REVOKED DEVICE. Persisting the state the next step deletes is precisely
    // the write that must not survive the wipe, so the persister is uninstalled without one.
    uninstallMlsStatePersisterLifecycle();
    unregisterMlsStatePersister();
    disposeMlsEncryptWorker();
  }

  if (reason === 'logout') {
    const tokenForPushCleanup = ctx.getAuthToken();
    const deviceForPushCleanup = ctx.getMyDeviceId();
    if (tokenForPushCleanup && deviceForPushCleanup) {
      void stopPushService(ctx.getHistoryBaseUrl(), tokenForPushCleanup, deviceForPushCleanup);
    }
  }

  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  if (ctx.timers.health !== null) {
    clearInterval(ctx.timers.health);
    ctx.timers.health = null;
  }
  if (ctx.timers.syncWatchdog !== null) {
    clearInterval(ctx.timers.syncWatchdog);
    ctx.timers.syncWatchdog = null;
  }
  stopConnectionWatchdogImpl(ctx);
  ctx.setReconnectAttempts(0);
  ctx.setTabLeaderSessionCb(null);
  ctx.setIsLoggedIn(false);
  ctx.setIsWsConnected(false);
  ctx.setIsMessagingInitializing(false);
  // The watchdog's candidate set IS the live conversation map, so emptying it is half of why
  // nothing can drive recovery for a session that has ended.
  cb.conversations.clear();
  cb.setSelectedContact(null);
  setCallSystemMessageContext(null);
  // Decrypted Graine seeds and the channel-to-community map belong to the account that just left.
  setGraineRuntime(null);
  ctx.getCallService()?.setChatNotifier(null);
  resetSiblingCallWarning();
}

/**
 * Clears all session state (conversations, tokens, push registration),
 * deregisters the device push token, and redirects to /login.
 */
export function logoutImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  cb.log(`[LOGOUT] Signing out userId=${ctx.getUserId()?.slice(0, 8) ?? 'unknown'}...`);
  tearDownLiveSession(ctx, cb, 'logout');
  ctx.setStorage(null);
  ctx.setAuthToken('');
  clearUserLocally();
  clearDeviceKeyAndWrapKey();
  clearAuth();
  cb.log('[LOGOUT] Local state cleared - redirecting to /login.');
  void goto('/login', { replaceState: true });
}
