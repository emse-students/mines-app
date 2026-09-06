import { isChannelEventFrame, isHeartbeatFrame } from '$lib/mls-client/channelEventTypes';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { fetch } from '@tauri-apps/plugin-http';
import NativeWebSocket, { type Message as WsMessage } from '@tauri-apps/plugin-websocket';
import {
  logMlsMetric,
  detectRuntimeDeviceOs,
  MLS_LOCAL_STATE_UNDECRYPTABLE,
  type MlsInitOptions,
} from '$lib/mls-client';
import { mapNativeBatchDecryptResults } from '$lib/mls-client/mlsBatchDecrypt';
import type { MlsBatchProcessResult } from '$lib/mls-client/IMlsService';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { getToken } from '$lib/stores/auth';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { getLocale } from '$lib/i18n';
import { BaseMlsService } from './BaseMlsService';
import { keystoreUnlockPrompt } from './biometric';

/** Native batch result for key package generation plus immediate `mls.bin` persistence. */
interface NativeKeyPackageBatchResult {
  fallback: number[];
  pool_packages: number[][];
  state: number[];
}

/**
 * MLS service implementation for Tauri (mobile/desktop).
 * Delegates all cryptographic operations to the native Rust side via `invoke()`.
 */
export class TauriMlsService extends BaseMlsService {
  private ws: Awaited<ReturnType<typeof NativeWebSocket.connect>> | null = null;
  private wsUnlisten: (() => void) | null = null;
  /** Consecutive pings sent without any incoming data frame from the server. */
  private missedHeartbeats = 0;
  /** Maximum consecutive pings without any server activity before we force-close (parity WebMlsService). */
  private static readonly MAX_MISSED_HEARTBEATS = 3;
  /** Cache of locally known MLS group IDs, populated after init and updated on group changes. */
  private _knownGroups: Set<string> = new Set();
  /** Last known MLS epoch per group (native); keeps sync `getEpoch()` meaningful on Tauri. */
  private _epochByGroupId: Map<string, number> = new Map();
  /** In-flight Rust MLS mutations; drained before `saveState` so mls.bin matches `_knownGroups`. */
  private pendingRustMutations: Promise<unknown>[] = [];
  private appVersionCache: string | null | undefined = undefined;
  // Device key kept in memory after init() to re-encrypt the MLS state after each
  // message without asking the user for the PIN again.
  private _deviceKeyB64 = '';
  /**
   * Value of {@link liveMutations} at the last write to `mls.bin`.
   *
   * The difference with the live counter is the number of send-ratchet advances the file does NOT
   * contain - the one thing that makes a resume reload destructive. A watermark rather than a flag
   * because the question is "how far behind is the file", asked between two instants.
   */
  private _mutationsAtLastPersist = 0;

  constructor() {
    super('tauri', fetch);
  }

  /** Tracks a native invoke so `saveState` can wait for Rust before persisting mls.bin. */
  private trackRustMutation(promise: Promise<unknown>): void {
    this.pendingRustMutations.push(promise);
    void promise.finally(() => {
      const idx = this.pendingRustMutations.indexOf(promise);
      if (idx >= 0) this.pendingRustMutations.splice(idx, 1);
    });
  }

  /** Waits for pending forget/drop invokes before serializing MLS state. */
  private async awaitRustMutations(): Promise<void> {
    const pending = [...this.pendingRustMutations];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  /** Refresh cached epoch from native MLS (best-effort). */
  private async refreshEpochCache(groupId: string): Promise<void> {
    try {
      const e = await invoke<number>('obtenir_epoch', { groupId });
      this._epochByGroupId.set(groupId, e);
      logMlsMetric({ kind: 'epoch_cache', platform: 'tauri', groupId, epoch: e });
    } catch {
      this._epochByGroupId.delete(groupId);
    }
  }

  /**
   * Platform hook: refresh the epoch cache after each successfully processed message.
   * Called by BaseMlsService.processQueue after a successful messageCallback invocation.
   */
  protected override async onMessageProcessed(groupId: string | undefined): Promise<void> {
    if (groupId) {
      await this.refreshEpochCache(groupId);
    }
  }

  /** Resets the heartbeat miss counter whenever a data frame is received from the server. */
  private resetHeartbeatCounter(): void {
    this.missedHeartbeats = 0;
  }

  /** Clears the heartbeat interval. */
  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Starts the 8-second heartbeat interval (zombie detection + ping). */
  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) {
        this.clearHeartbeat();
        return;
      }
      // Check if the server has sent anything since the last ping (parity WebMlsService).
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats > TauriMlsService.MAX_MISSED_HEARTBEATS) {
        console.warn(
          `[WS] ${this.missedHeartbeats} pings without server response - closing zombie connection`
        );
        this.clearHeartbeat();
        // Unlisten before disconnecting to prevent the Close event from firing
        // disconnectCallback a second time (same pattern as connect() cleanup).
        const deadWs = this.ws;
        this.wsUnlisten?.();
        this.wsUnlisten = null;
        this.ws = null;
        void deadWs.disconnect().catch(() => {});
        this.disconnectCallback?.();
        return;
      }
      this.ws.send(JSON.stringify({ type: 'ping' })).catch(() => {
        /* socket closed between check and send */
      });
    }, 8_000); // data frame bypasses nginx proxy_read_timeout; keeps presence TTL fresh
  }

  /**
   * Returns true while the native WebSocket instance exists.
   * Unlike WebMlsService (which checks `readyState === OPEN`), the Tauri native WS
   * plugin exposes no `readyState`. `this.ws` is set to null synchronously on every
   * disconnect path (Close event, heartbeat zombie kill, connect() reconnect), so
   * `!== null` is the best available equivalent.
   */
  isWsOpen(): boolean {
    return this.ws !== null;
  }

  /** Tauri-native `invoke` wrapper - opens a NativeWebSocket to the chat gateway, passing the Bearer token in the URL query string for mobile compatibility. */
  async connect(token?: string): Promise<void> {
    // Unlisten + disconnect before reconnecting so the Close event doesn't trigger disconnectCallback.
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.wsUnlisten?.();
        this.wsUnlisten = null;
        await this.ws.disconnect();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    if (!this._visibilityHandler && typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible' && !this.ws) {
          this.disconnectCallback?.();
        }
      };
      this._onlineHandler = () => {
        if (!this.ws) {
          this.disconnectCallback?.();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      window.addEventListener('online', this._onlineHandler);
    }

    // On Tauri mobile the cookie is not sent cross-origin, so we pass the
    // Bearer token explicitly in the URL query string.
    let resolvedToken = token;
    if (!resolvedToken) {
      try {
        resolvedToken = await getToken();
      } catch {
        // Proceed without token; gateway will reject with 401 if required.
      }
    }

    // Use the same regex as WebMlsService to avoid http:// → wss:// mismatch.
    const wsBase = this.baseUrl.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
    const tokenParam = resolvedToken ? `&token=${encodeURIComponent(resolvedToken)}` : '';
    const wsUrl = `${wsBase}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam}`;
    console.log(
      `[WS] Opening connection → ${wsBase}/api/ws?device_id=${this.deviceId}${resolvedToken ? '&token=***' : ' (no token)'}`
    );

    // NativeWebSocket.connect() resolves when the handshake completes, rejects on failure.
    // Impose the same 15-second timeout as WebMlsService to prevent silent hangs on Android.
    let resolved = false;
    const connectPromise = NativeWebSocket.connect(wsUrl);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        if (!resolved) reject(new Error('WebSocket connection timeout after 15s'));
      }, 15_000)
    );
    this.ws = await Promise.race([connectPromise, timeoutPromise]);
    resolved = true;
    console.log(`[WS] Connected to Chat Gateway - device=${this.deviceId}`);

    this.wsUnlisten = this.ws.addListener((msg: WsMessage) => {
      // Any incoming frame proves the server is alive - reset heartbeat miss counter (parity WebMlsService).
      if (msg.type !== 'Close') {
        this.resetHeartbeatCounter();
      }

      if (msg.type === 'Close') {
        this.ws = null;
        this.clearHeartbeat();
        const closeData = msg.data as { code: number; reason: string } | null;
        const code = closeData?.code ?? 0;
        const codeDesc =
          code === 1000
            ? 'normal closure'
            : code === 1001
              ? 'server shutting down'
              : code === 1006
                ? 'abnormal closure (no close frame)'
                : code === 1008
                  ? 'policy violation (auth?)'
                  : code === 1011
                    ? 'internal server error'
                    : `code=${code}`;
        console.warn(`[WS] Disconnected - ${codeDesc}, reason="${closeData?.reason ?? ''}"`);
        this.disconnectCallback?.();
        return;
      }

      if (msg.type !== 'Text') return;

      void (async () => {
        try {
          const parsed = JSON.parse(msg.data as string) as Record<string, unknown>;
          const msgType = typeof parsed.type === 'string' ? parsed.type : '';
          // The transport's keepalive, not a message. Parity with `WebMlsService`, through the one
          // predicate both clients ask - see `isHeartbeatFrame`.
          if (isHeartbeatFrame(msgType)) return;

          if (isChannelEventFrame(msgType)) {
            if (this.onChannelEvent) {
              console.log(`[WS RCV] Triggering onChannelEvent for ${msgType}`);
              this.onChannelEvent({ type: msgType, data: parsed.data });
            } else {
              console.warn(`[WS RCV] Received channel event but no onChannelEvent registered.`);
            }
            return;
          }
          if (msgType === 'typing') {
            // Group/DM typing: normalise the flat gateway frame into the channel-event
            // shape so the shared handler updates the typing store uniformly.
            this.onChannelEvent?.({
              type: 'typing',
              data: { groupId: parsed.groupId, userId: parsed.userId, state: parsed.state },
            });
            return;
          }
          if (msgType === 'device_revoked') {
            // Its owner deleted this device. The denylist row is the durable half and would be
            // found at the next login anyway; this is what makes it immediate, so a device
            // declared lost stops holding a live session the moment it is disowned. Never
            // trusted blindly: the frame is addressed to this device by the gateway, and the
            // handler re-checks with the server before wiping anything.
            console.warn('[WS RCV] device_revoked - this device was deleted by its owner');
            this.deviceRevokedCallback?.();
            return;
          }
          if (msgType === 'welcome_request') {
            const requesterUserId = (parsed.requesterUserId as string) || '';
            const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
            const groupId = (parsed.groupId as string) || '';
            console.log(
              `[WS RCV] welcome_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
            );
            this.welcomeRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msgType === 'base_refresh_request') {
            const requesterUserId = (parsed.requesterUserId as string) || '';
            const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
            const groupId = (parsed.groupId as string) || '';
            console.log(
              `[WS RCV] base_refresh_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
            );
            this.baseRefreshRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msgType === 'history_request') {
            const requesterUserId = (parsed.requesterUserId as string) || '';
            const requesterDeviceId = (parsed.requesterDeviceId as string) || '';
            const groupId = (parsed.groupId as string) || '';
            console.log(
              `[WS RCV] history_request from ${requesterUserId}:${requesterDeviceId} for group ${groupId}`
            );
            this.historyRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msgType === 'epoch_rejected') {
            console.warn(
              `[WS RCV] Epoch rejected for group ${parsed.groupId} (server epoch: ${parsed.currentEpoch})`
            );
            if (this.onChannelEvent) {
              this.onChannelEvent({
                type: 'epoch_rejected',
                data: { groupId: parsed.groupId, currentEpoch: parsed.currentEpoch },
              });
            }
            return;
          }
          if (parsed.proto && this.messageCallback) {
            const ciphertext = fromBase64(parsed.proto as string);
            const ratchetTreeBytes =
              typeof parsed.ratchetTree === 'string' && (parsed.ratchetTree as string).length > 0
                ? fromBase64(parsed.ratchetTree as string)
                : undefined;
            if (ciphertext.length > 0) {
              this.enqueueMessage(
                {
                  senderId: (parsed.senderId as string) || 'unknown',
                  ciphertext,
                  groupId: (parsed.groupId as string) || undefined,
                  isWelcome: !!parsed.isWelcome,
                  isCommit: !!parsed.isCommit,
                  ratchetTreeBytes,
                  queuedMessageId: (parsed.queuedMessageId as string) || undefined,
                  queuedCreatedAt: parseServerTimestampMs(parsed.createdAt),
                },
                'live'
              );
            }
          } else if (parsed.proto && !this.messageCallback) {
            console.warn(
              `[WS RCV] a frame carried a proto but no messageCallback is registered - the frame is DROPPED`
            );
          } else if (msgType) {
            // See the same branch in `WebMlsService`: a typed frame that reached no handler is the
            // one failure this layer cannot otherwise show, and it stayed invisible for months.
            console.warn(
              `[WS RCV] frame type "${msgType}" reached no handler - the server is sending ` +
                `something this client does not route (see channelEventTypes)`
            );
          }
        } catch (e) {
          console.error('[WS RCV] Failed to process WebSocket message:', e);
        }
      })();
    });

    this.startHeartbeat();

    // Pending queue fetch is handled by initializeConnection() to keep
    // behavior aligned between WebMlsService and TauriMlsService.
  }

  /** Sends a disconnect control frame over the native WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'disconnect' })).catch(() => {
        // Best-effort - ignore if the socket is already closing
      });
    }
  }

  /** Sends an ephemeral typing signal over the native WebSocket for a DM/group. */
  sendTyping(groupId: string, isTyping: boolean): void {
    if (this.ws) {
      this.ws
        .send(JSON.stringify({ type: 'typing', groupId, state: isTyping ? 'start' : 'stop' }))
        .catch(() => {
          // Best-effort - typing is non-critical
        });
    }
  }

  /** Releases Tauri-specific resources: closes the native WebSocket and its listener. */
  protected override destroyPlatformResources(): void {
    this.clearHeartbeat();
    if (this.wsUnlisten) {
      this.wsUnlisten();
      this.wsUnlisten = null;
    }
    if (this.ws) {
      this.ws.disconnect().catch(() => {});
      this.ws = null;
    }
  }

  /**
   * Tauri override: when localStorage was cleared (Android WebView eviction / reinstall),
   * restore the original device id from native push_context.json so we don't generate a
   * new id and trigger a credential mismatch against the persisted MLS state.
   */
  protected override async restoreDeviceIdFromNative(userId: string): Promise<string | null> {
    try {
      const ctx = await invoke<{ deviceId?: string; userId?: string } | null>('load_push_context');
      if (ctx?.deviceId && ctx.userId === userId) return ctx.deviceId;
    } catch {
      /* desktop / file absent */
    }
    return null;
  }

  /** Implementation body for init(); resolves device ID from native push context or localStorage, calls `initialiser_mls`, and seeds the known-groups cache. */
  protected async _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    this.userId = userId;
    this.delivery.userId = userId;
    this._deviceKeyB64 = deviceKeyB64;
    this.freshStart = !state;

    // Per-user device ID (same rationale as WebMlsService). resolveDeviceId restores
    // from localStorage or the native push_context before generating a fresh id, and
    // is idempotent: a no-op when login already resolved it before the pin-check.
    await this.resolveDeviceId(userId);

    try {
      await this.loadStateWithKey(deviceKeyB64, state);
    } catch (e) {
      // If init fails AND a saved state existed, the state is to blame
      // (credential mismatch, partial corruption, invalid key…).
      // → systematic fresh-start to avoid blocking the user indefinitely.
      // If state == null and error → real crash (no state to blame) → rethrow.
      let cause = this.classifyStateLoadFailure(e);

      // "No keystore key and no device key provided" is a recoverable error (the
      // user just needs to enter their PIN).  Do NOT destroy the device
      // identity — let the error propagate so the caller can fall back to
      // the PIN modal.
      const isKeystoreEmpty = /no keystore key/i.test(String(e));

      // A snapshot written before v0.11.0 sits in the Argon2id envelope and cannot decrypt with
      // the device key, which is indistinguishable here from a key rotated on another device.
      // Retry once letting Rust try that envelope: on success it re-seals and persists mls.bin.
      // Must not `return` on success - the push-context write below this block still has to run.
      let migrated = false;
      if (cause === 'sealed' && state && opts?.legacyPin && !isKeystoreEmpty) {
        try {
          await this.invokeInit(deviceKeyB64, state, opts.legacyPin);
          migrated = true;
          console.log('[MLS] Pre-v0.11.0 mls.bin re-sealed under the device key.');
        } catch (migrationError) {
          // Two very different failures land here: the blob was not a legacy envelope at all
          // (still `sealed` -> recovery), or it opened and names another device (`mismatch` ->
          // fresh start). Keeping the original verdict would offer an old-PIN recovery for an
          // identity no PIN can repair.
          cause = this.classifyStateLoadFailure(migrationError);
          console.warn(
            `[MLS] Legacy migration did not yield a usable state (${cause}):`,
            String(migrationError).slice(0, 200)
          );
        }
      }

      if (migrated) {
        // State recovered in place: keep the device identity and fall through to the normal
        // post-init steps.
      } else if ((cause === 'mismatch' || state != null) && !isKeystoreEmpty) {
        // Only a `sealed` state is worth pausing for: the caller can offer the old PIN and
        // recover the history intact. A `mismatch` decrypted fine and no PIN can repair it,
        // so honouring noFreshStart there would strand the user with nothing to try.
        if (opts?.noFreshStart && cause === 'sealed') {
          throw new Error(MLS_LOCAL_STATE_UNDECRYPTABLE, { cause: e });
        }
        await this.rotateDeviceIdentity(
          deviceKeyB64,
          cause === 'mismatch'
            ? 'credential mismatch - stale state'
            : `loaded state unusable (corruption?): ${String(e).slice(0, 200)}`
        );
      } else {
        throw e;
      }
    }

    // Write mls.bin immediately after init so the FCM service can decrypt
    // even if no message has been processed yet (saveState not yet called).
    const savePromise = this.saveState(deviceKeyB64).catch(() => {});

    // Save session context for Android push notifications (no-op on desktop).
    // Must run AFTER saveState writes mls.bin (C3: race condition fix).
    // Only applicable when a device key is available (C5: skip in biometric mode
    // where deviceKeyB64="" would store an empty key, overwriting the
    // biometric key already stored by biometricLoginImpl → getKeyBytes).
    if (deviceKeyB64.length > 0) {
      void savePromise.then(() =>
        getToken()
          .then((pushToken: string) =>
            invoke('store_push_context', {
              deviceKeyB64,
              userId,
              deviceId: this.deviceId,
              baseUrl: this.historyUrl,
              pushToken,
              // Restated because this call REPLACES push_context.json - see set_push_context_locale.
              locale: getLocale(),
            })
          )
          .catch(() => {})
      );
    }

    // Populate the local groups cache from Rust after init.
    try {
      const groups = await invoke<string[]>('lister_groupes');
      this._knownGroups = new Set(groups);
    } catch {
      // Non-blocking: cache stays empty, GroupAlreadyExists fallback will handle it.
    }
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` in Rust and updates the local known-groups cache. */
  async createGroup(groupId: string): Promise<void> {
    await invoke('creer_groupe', { groupId });
    this._knownGroups.add(groupId);
  }

  /** Tauri-native `invoke` wrapper - calls `creer_groupe` ignoring GroupAlreadyExists, letting Rust handle orphan state cleanup. */
  async forceCreateGroup(groupId: string): Promise<void> {
    // Tauri: use the same creer_groupe - orphan recovery in Rust handles the wipe.
    // A dedicated force_creer_groupe IPC command could be added later if needed.
    await invoke('creer_groupe', { groupId }).catch(() => {});
    this._knownGroups.add(groupId);
  }

  /**
   * Native `saveState` writes `mls.bin` before it returns, so the checkpoint is that one call.
   * Handing its bytes back to `save_mls_state` would write the same file twice - 2.0 s of the
   * 3.7 s measured on the phone, nearly all of it marshalling the snapshot as a JS `number[]`.
   */
  protected async writeCheckpoint(deviceKeyB64: string): Promise<void> {
    await this.saveState(deviceKeyB64);
  }

  /**
   * Native `invoke` wrapper - burns `count` send generations in one crossing.
   *
   * ONE invoke for the whole burn rather than one per generation: each crossing marshals a
   * ciphertext that is thrown away, and the burn exists precisely because this platform's checkpoint
   * is too expensive to await.
   */
  protected async skipSendGenerations(groupId: string, count: number): Promise<number> {
    return invoke<number>('skip_send_generations', { groupId, count });
  }

  /** Tauri-native `invoke` wrapper - calls `sauvegarder_mls_et_persister` to encrypt and persist the MLS state to the native mls.bin file using the device key. */
  async saveState(deviceKeyB64: string): Promise<Uint8Array> {
    await this.awaitRustMutations();
    // Read the counter BEFORE the invoke, so a send that lands DURING it stays counted as
    // unpersisted. Erring that way costs a refused reload; erring the other way costs a rewound
    // ratchet, which is the whole defect this watermark exists to prevent.
    const mutationsAtSnapshot = this.liveMutations;
    // Native command handles save_encrypted_with_key + mls.bin write in one invoke
    // to avoid JS Array.from(…) conversion on large state blobs (notably Android).
    const raw = await invoke<number[]>('sauvegarder_mls_et_persister', { deviceKeyB64 });
    const bytes = Uint8Array.from(raw);
    this._mutationsAtLastPersist = mutationsAtSnapshot;
    return bytes;
  }

  /**
   * C2: reloads `mls.bin` from disk into the warm in-memory engine. Called on resume (mobile)
   * BEFORE the WS resumes processing: while backgrounded, a native engine (Welcome/send) may
   * have advanced `mls.bin`; without this the warm state is stale and its next save would clobber
   * that advance (lost-update -> SecretReuse). The native command also marks the foreground
   * active first, so background engines stop writing before it reads, and refuses any reload
   * that would regress a live group's epoch.
   *
   * A missing device key means there is nothing to decrypt with -- skip rather than throw, since
   * this runs on every resume and a failure here must not break the resume sequence.
   *
   * THE EPOCH GUARD IN RUST IS NOT ENOUGH, AND THIS IS THE NATIVE HALF OF `installUnlessOvertaken`.
   * `reload_is_monotonic` refuses a candidate that would move a live group to a LOWER epoch, which
   * is evidence for "is this snapshot from an older epoch" and for nothing else. What a send moves
   * is a GENERATION INSIDE one epoch, which is invisible to it: the reload is accepted, the live
   * ratchet goes back to where `mls.bin` left it, the next frame re-issues a spent generation and
   * the peer refuses it as `SecretReuseError` - reported, correctly, as "the sender's ratchet
   * rewound". Web has had this guard at every off-thread swap since the same defect was measured
   * there; the doc on `swapClientMonotonic` says to keep the two in sync, and until now only the
   * epoch half was.
   */
  override async reloadStateFromDisk(): Promise<void> {
    if (!this._deviceKeyB64) {
      console.warn('[MLS][Tauri] reloadStateFromDisk skipped - no device key in session.');
      return;
    }
    const unpersisted = this.liveMutations - this._mutationsAtLastPersist;
    if (unpersisted > 0) {
      // Do not reload, and do not leave the divergence on disk either: persisting the live state
      // is what makes the NEXT resume safe, and it is the only ordering under which a background
      // engine starting later reads a state that is not already behind.
      console.warn(
        `[MLS][Tauri] Resume reload SKIPPED: ${unpersisted} send(s) have not reached mls.bin - reloading would rewind this device's own send ratchet. Persisting the live state instead.`
      );
      await this.saveState(this._deviceKeyB64).catch((e) => {
        console.error('[MLS][Tauri] Persist of the live state after a skipped reload failed:', e);
      });
      return;
    }
    try {
      const reloaded = await invoke<boolean>('recharger_mls_au_resume', {
        userId: this.userId,
        deviceId: this.deviceId,
        deviceKeyB64: this._deviceKeyB64,
      });
      if (reloaded) {
        this._knownGroups = new Set(await invoke<string[]>('lister_groupes'));
        console.log('[MLS][Tauri] mls.bin reloaded on resume (C2) - group cache refreshed.');
      }
    } catch (e) {
      // Non-fatal: the warm state stays in place. Losing the reload risks clobbering a background
      // advance, so this must be loud even though it does not abort the resume.
      console.error('[MLS][Tauri] reloadStateFromDisk failed:', e);
    }
  }

  /**
   * Reads back the at-rest key `initialiser_mls` cached natively for this session.
   *
   * Biometric mode calls {@link invokeInit} with an empty string, so `_deviceKeyB64` stays empty
   * and the frontend holds no key - yet the frontend is the only layer that encrypts locally
   * stored messages. Rust resolved it from the keystore behind the one BiometricPrompt of the
   * login and cached it, so this costs no second prompt.
   *
   * Also fills `_deviceKeyB64` when it is empty: {@link reloadStateFromDisk} skips on a missing
   * key, and skipping it on every resume is how a background engine's advance to `mls.bin` gets
   * clobbered by the next save (lost-update -> SecretReuse).
   */
  override async resolveSessionDeviceKey(): Promise<string | null> {
    const keyB64 = await invoke<string | null>('recuperer_cle_session_mls');
    if (!keyB64) return null;
    if (!this._deviceKeyB64) this._deviceKeyB64 = keyB64;
    return keyB64;
  }

  /** Native decrypt + client init for a given device key/state; throws on wrong key (no fresh-start). */
  protected async loadStateWithKey(deviceKeyB64: string, state?: Uint8Array): Promise<void> {
    await this.invokeInit(deviceKeyB64, state);
  }

  /**
   * Single `initialiser_mls` call site.
   *
   * `legacyPin` is only ever set on the migration retry from {@link _initImpl}: with it, the Rust
   * side may fall back to the pre-v0.11.0 Argon2id envelope, re-seal `mls.bin` under
   * `deviceKeyB64` and persist it. {@link loadStateWithKey} must stay free of it so probing a
   * candidate key (recoverAndRekey) cannot rewrite the stored snapshot as a side effect.
   *
   * `biometricPrompt` is sent unconditionally, even though only biometric mode (empty
   * `deviceKeyB64`) raises a sheet: this is the one command that can carry it, because the native
   * keystore plugin cannot resolve a locale of its own.
   */
  private async invokeInit(
    deviceKeyB64: string,
    state?: Uint8Array,
    legacyPin?: string
  ): Promise<void> {
    this._deviceKeyB64 = deviceKeyB64;
    const encryptedState = state ? Array.from(state) : null;
    await invoke('initialiser_mls', {
      userId: this.userId,
      deviceId: this.deviceId,
      deviceKeyB64,
      encryptedState,
      opts: { legacyPin: legacyPin ?? null, biometricPrompt: keystoreUnlockPrompt() },
    });
  }

  async changeDeviceKey(newDeviceKeyB64: string): Promise<void> {
    this._deviceKeyB64 = newDeviceKeyB64;
    await this.saveState(newDeviceKeyB64);

    // Always regenerate the keystore key for background push, regardless of the biometric flag.
    // The keystore key is required for FCM decryption even without biometrics.
    if (isTauriRuntime()) {
      invoke('actualiser_cle_keystore_avec_devicekey', {
        deviceKeyB64: newDeviceKeyB64,
        userId: this.userId,
        deviceId: this.deviceId,
      }).catch((e) =>
        console.warn('[MLS][Tauri] Keystore key refresh after device key change failed:', e)
      );
    }

    // Refresh the native push context so background FCM decryption uses the
    // updated keystore key.
    void getToken()
      .then((pushToken: string) =>
        invoke('store_push_context', {
          deviceKeyB64: newDeviceKeyB64,
          userId: this.userId,
          deviceId: this.deviceId,
          baseUrl: this.historyUrl,
          pushToken,
          // Restated because this call REPLACES push_context.json - see set_push_context_locale.
          locale: getLocale(),
        })
      )
      .catch((e) =>
        console.warn('[MLS][Tauri] push_context refresh after device key change failed:', e)
      );

    console.log('[MLS][Tauri] Device key changed - state re-encrypted and persisted.');
  }

  /** Tauri-native `invoke` wrapper - calls `generer_key_packages_et_persister`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  protected async generateKeyPackageImpl(deviceKeyB64: string): Promise<Uint8Array> {
    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      await this.delivery.deleteAllOneTimePrekeys();
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    // 50 matches WebMlsService and avoids bloating the Rust state with hundreds
    // of unused private key bundles (each ~400 bytes encrypted in mls.bin).
    const existing = await this.delivery.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);
    console.log(`[MLS][Tauri] generateKeyPackage native batch path needed=${needed}`);

    // Single native command: generate fallback + OTKPs + persist encrypted state.
    const nativeBatch = await invoke<NativeKeyPackageBatchResult>(
      'generer_key_packages_et_persister',
      {
        deviceKeyB64,
        count: needed,
      }
    );
    const fallback = Uint8Array.from(nativeBatch.fallback);
    const poolPackages = nativeBatch.pool_packages.map((kp) => Uint8Array.from(kp));

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /** Tauri-native `invoke` wrapper - checks via `key_package_a_clef_privee` that we hold the KeyPackage's private key. */
  protected async keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean> {
    return invoke<boolean>('key_package_a_clef_privee', {
      keyPackageBytes: Array.from(keyPackageBytes),
    });
  }

  /**
   * Tauri-native `invoke` wrapper - stages an Add commit WITHOUT merging via `ajouter_membres_bulk`
   * (all key packages in one OpenMLS commit, one shared Welcome). Returns
   * (commit, welcome?, addedIndices, skippedIndices). `addedIndices` are positions in `keyPackages`
   * actually included - entries skipped (invalid, or already a member) are omitted rather than
   * collapsing to a bare count. `skippedIndices` are positions dropped for an INVALID/undeserializable
   * KeyPackage (not the already-member dedup), surfaced so the loss is not silent. [[C5]]
   */
  protected async stageAddMembers(
    groupId: string,
    keyPackages: Uint8Array[]
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedIndices: number[];
    skippedIndices: number[];
  }> {
    const keyPackagesBytes = keyPackages.map((kp) => Array.from(kp));
    const result = await invoke<[number[], number[] | null, number[], number[]]>(
      'ajouter_membres_bulk',
      { groupId, keyPackagesBytes }
    );
    return {
      commit: Uint8Array.from(result[0]),
      welcome: result[1] ? Uint8Array.from(result[1]) : undefined,
      addedIndices: result[2],
      skippedIndices: result[3] ?? [],
    };
  }

  /** Tauri-native `invoke` wrapper - stages a Remove commit for all devices of the given users (no merge). */
  protected async stageRemoveMembers(groupId: string, userIds: string[]): Promise<Uint8Array> {
    const commitBytes = await invoke<number[]>('retirer_membres', { groupId, userIds });
    return new Uint8Array(commitBytes);
  }

  /** Tauri-native `invoke` wrapper - stages a Remove commit for specific device identities (no merge). */
  protected async stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[]
  ): Promise<Uint8Array> {
    const commitBytes = await invoke<number[]>('retirer_membres_par_appareil', {
      groupId,
      deviceIdentities,
    });
    return new Uint8Array(commitBytes);
  }

  /** Tauri-native `invoke` wrapper - merges the pending staged commit (server accepted) and refreshes the epoch cache. */
  protected async mergePendingCommit(groupId: string): Promise<void> {
    await invoke('confirmer_commit', { groupId });
    void this.refreshEpochCache(groupId);
  }

  /** Tauri-native `invoke` wrapper - clears the pending staged commit (server rejected, no fork). */
  protected async clearPendingCommit(groupId: string): Promise<void> {
    await invoke('annuler_commit', { groupId });
  }

  /** Tauri-native `invoke` wrapper - exports the post-merge ratchet tree for the Welcome. */
  protected async exportRatchetTree(groupId: string): Promise<Uint8Array> {
    const rt = await invoke<number[]>('exporter_ratchet_tree', { groupId });
    return new Uint8Array(rt);
  }

  /** Tauri-native `invoke` wrapper - reads the authoritative pre-merge epoch via `obtenir_epoch`. */
  protected async freshEpoch(groupId: string): Promise<number> {
    try {
      const epoch = await invoke<number>('obtenir_epoch', { groupId });
      this._epochByGroupId.set(groupId, epoch);
      return epoch;
    } catch {
      return this.getEpoch(groupId);
    }
  }

  /** Tauri-native `invoke` wrapper - exports the self-contained GroupInfo (external-join base). */
  protected async exportGroupInfo(groupId: string): Promise<Uint8Array> {
    const gi = await invoke<number[]>('exporter_group_info', { groupId });
    return new Uint8Array(gi);
  }

  /** Tauri-native `invoke` wrapper - builds an external commit from a served GroupInfo and stages it.
   *  The native command returns the (group_id, commit) tuple; the group joins the known-groups cache. */
  protected async joinByExternalCommit(
    groupInfoBytes: Uint8Array
  ): Promise<{ groupId: string; commit: Uint8Array }> {
    const [groupId, commit] = await invoke<[string, number[]]>('rejoindre_par_commit_externe', {
      groupInfoBytes: Array.from(groupInfoBytes),
    });
    this._knownGroups.add(groupId);
    await this.refreshEpochCache(groupId);
    return { groupId, commit: new Uint8Array(commit) };
  }

  /** Tauri-native `invoke` wrapper - calls `trailer_welcome`, updates the known-groups cache, refreshes the epoch, and returns the derived groupId. */
  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string> {
    const groupId = await invoke<string>('trailer_welcome', {
      welcomeBytes: Array.from(welcomeBytes),
      ratchetTreeBytes: ratchetTreeBytes ? Array.from(ratchetTreeBytes) : null,
    });
    this._knownGroups.add(groupId);
    await this.refreshEpochCache(groupId);
    return groupId;
  }

  /** Tauri-native `invoke` wrapper - encrypts plaintext via `envoyer_message_bytes`, then POSTs the ciphertext to the delivery service. */
  /** Native `invoke` wrapper - advances the live send ratchet. Ordering and persistence: `sendMessage`. */
  protected async encryptForSend(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array> {
    const res = await invoke<number[]>('envoyer_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    return Uint8Array.from(res);
  }

  /** Tauri-native `invoke` wrapper - decrypts a raw MLS ciphertext via `recevoir_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const res = await invoke<number[] | null>('recevoir_message_bytes', {
      groupId,
      messageBytes: Array.from(messageBytes),
    });
    return res ? Uint8Array.from(res) : null;
  }

  /** Single IPC crossing for an ordered page of ciphertexts (history catch-up on native MLS). */
  async processIncomingMessagesBatch(
    groupId: string,
    messages: Uint8Array[]
  ): Promise<MlsBatchProcessResult[]> {
    if (messages.length === 0) return [];
    const raw = await invoke<Array<{ ok: boolean; data?: number[] | null; error?: string }>>(
      'recevoir_messages_batch',
      {
        groupId,
        messages: messages.map((m) => Array.from(m)),
      }
    );
    return mapNativeBatchDecryptResults(raw);
  }

  /** Tauri-native `invoke` wrapper - calls `exporter_secret` in Rust to derive a keying-material export for channel encryption. */
  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    const res = await invoke<number[]>('exporter_secret', {
      groupId,
      label,
      context: Array.from(context),
      keyLen,
    });
    return new Uint8Array(res);
  }

  /** Tauri-native `invoke` wrapper - publishes this device's static fallback KeyPackage to the delivery service, including device name/OS metadata. */
  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = toBase64(keyPackageBytes);
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    const deviceAppVersion = await this.getRuntimeAppVersion();
    await this.delivery.registerDeviceKeyPackage({
      keyPackageBase64: base64,
      deviceName: storedName,
      deviceOs: detectRuntimeDeviceOs('desktop'),
      ...(deviceAppVersion ? { deviceAppVersion } : {}),
    });
  }

  /** Returns the list of MLS group IDs known locally, populated from Rust via `lister_groupes` at init time. */
  getLocalGroups(): string[] {
    return [...this._knownGroups];
  }

  /**
   * Tauri-native `invoke` wrapper - `groupe_actif`. See {@link IMlsService.isGroupActive}.
   *
   * Read live from Rust rather than mirrored into `_knownGroups`: a cached membership flag is a
   * second copy of a fact OpenMLS already stores durably, and the only way the two can differ is
   * the way that matters - the cache saying we are still in a group we were removed from. It
   * propagates the Rust error, which is what an unheld group answers.
   */
  async isGroupActive(groupId: string): Promise<boolean> {
    return invoke<boolean>('groupe_actif', { groupId });
  }

  /**
   * Tauri-native `invoke` wrapper - every leaf identity (`userId:deviceId`) in the group's tree.
   *
   * Read live from Rust rather than cached: unlike the epoch, nothing here mirrors the tree, and a
   * stale roster is exactly the input a removal decision must never be given. It propagates the
   * Rust error, which is what an unheld group answers - never an empty tree.
   */
  async getGroupMemberIdentities(groupId: string): Promise<string[]> {
    return invoke<string[]>('lister_identites_membres', { groupId });
  }

  /** Returns the last cached MLS epoch for a group, or 0 if unknown; cache is refreshed by `refreshEpochCache`. */
  getEpoch(groupId: string): number {
    return this._epochByGroupId.get(groupId) ?? 0;
  }

  /** Tauri-native `invoke` wrapper - calls `oublier_groupe` in Rust to drop local MLS state and removes the group from the epoch cache. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    this._epochByGroupId.delete(groupId);
    // Keep `_knownGroups` in sync synchronously (Web reads WASM live via get_groups()).
    this._knownGroups.delete(groupId);
    this.trackRustMutation(
      invoke('oublier_groupe', { groupId, minEpoch }).catch((e) => {
        console.warn('[MLS] forgetGroup error:', e);
        return invoke<string[]>('lister_groupes')
          .then((groups) => {
            this._knownGroups = new Set(groups);
          })
          .catch(() => {});
      })
    );
  }

  /** Poison Pill - definitive purge via Tauri `supprimer_groupe`: Rust memory, storage and epoch lock at MAX. */
  dropGroup(groupId: string): void {
    this._epochByGroupId.delete(groupId);
    this._knownGroups.delete(groupId);
    this.trackRustMutation(
      invoke('supprimer_groupe', { groupId }).catch((e) => {
        console.warn('[MLS] dropGroup error:', e);
        return invoke<string[]>('lister_groupes')
          .then((groups) => {
            this._knownGroups = new Set(groups);
          })
          .catch(() => {});
      })
    );
  }

  private async getRuntimeAppVersion(): Promise<string | undefined> {
    if (this.appVersionCache !== undefined) {
      return this.appVersionCache ?? undefined;
    }
    try {
      const v = await getVersion();
      this.appVersionCache = v?.trim() ? v.trim() : null;
      return this.appVersionCache ?? undefined;
    } catch {
      this.appVersionCache = null;
      return undefined;
    }
  }
}
