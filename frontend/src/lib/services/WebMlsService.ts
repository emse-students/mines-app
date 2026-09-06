import { createMlsCryptoWorkerSession } from '$lib/mls-client/mlsCryptoWorkerSession';
import { encryptMlsStateOffThread } from '$lib/mls-client/mlsEncryptWorkerSession';
import { wasmClientDecryptPage } from '$lib/mls-client/mlsBatchDecrypt';
import { type MlsDecryptSession } from '$lib/mls-client/mlsDecryptSession';
import type { MlsBatchProcessResult } from '$lib/mls-client/IMlsService';
import {
  loadAndInitWasm,
  migrateLegacyMlsStateBlob,
  detectRuntimeDeviceOs,
  MLS_LOCAL_STATE_UNDECRYPTABLE,
  type MlsInitOptions,
} from '$lib/mls-client';
import type { MlsKeyPackageRequest } from '$lib/mls-client/mlsWorkerProtocol';
import { isChannelEventFrame } from '$lib/mls-client/channelEventTypes';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { getToken } from '$lib/stores/auth';
import {
  saveMlsState,
  toBase64,
  fromBase64,
  tagMlsSnapshot,
  propagateMlsSnapshotVersion,
} from '$lib/utils/hex';
import MlsKeyPackageWorker from '../workers/mlsKeyPackage.worker?worker';
import { BaseMlsService } from './BaseMlsService';

/**
 * Strips CR/LF and control characters (and truncates) from a remote-controlled
 * value before it is interpolated into a log line, preventing log forging
 * (CWE-117): a crafted userId/deviceId/groupId cannot inject fake log entries.
 */
function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\t\p{Cc}]/gu, ' ').slice(0, 200);
}

/**
 * Worker result for key package generation done off the main thread.
 * Buffers are transferred back to avoid an additional clone cost.
 */
interface WorkerKeyPackageResult {
  fallback: Uint8Array;
  poolPackages: Uint8Array[];
  state: Uint8Array;
}

/** MLS service implementation for the browser (WASM via openmls). */
export class WebMlsService extends BaseMlsService {
  private client: any;
  private ws: WebSocket | null = null;
  /** Consecutive pings sent without any incoming data frame from the server. */
  private missedHeartbeats = 0;
  /** Maximum consecutive pings without any server activity before we force-close. */
  private static readonly MAX_MISSED_HEARTBEATS = 3;
  /** Last persisted MLS state snapshot used as worker bootstrap input. */
  /** Dedicated worker for expensive key package generation. */
  private keyPackageWorker: Worker | null = null;
  /** Feature flag for workerized key package generation (enabled by default). */
  private readonly useKeyPackageWorker = import.meta.env.VITE_MLS_KEYPACKAGE_WORKER !== 'false';
  /** Feature flag for off-thread MLS decrypt during catch-up (enabled by default). */
  private readonly useCryptoWorker = import.meta.env.VITE_MLS_CRYPTO_WORKER !== 'false';
  /** Feature flag for off-thread Argon2 encrypt on MLS checkpoints (enabled by default). */
  private readonly useEncryptWorker = import.meta.env.VITE_MLS_ENCRYPT_WORKER !== 'false';

  constructor() {
    super('web');
  }

  /** Returns a singleton key package worker instance. */
  private getOrCreateKeyPackageWorker(): Worker {
    if (!this.keyPackageWorker) {
      this.keyPackageWorker = new MlsKeyPackageWorker();
    }
    return this.keyPackageWorker;
  }

  /**
   * Installs `candidate` as the live client only if it does not regress any group.
   *
   * The live MLS epoch is a hard, non-decreasing invariant per group across every
   * context (foreground WASM here, native background service elsewhere): a stale
   * snapshot must never clobber newer live state. A swap is refused if any group the
   * live client holds would either disappear or move to a lower epoch in `candidate`.
   * Returns true when the swap happened, false when the live client was kept.
   *
   * THIS IS HALF THE GUARD, AND ON ITS OWN IT IS THE ONE THAT MISSES. An epoch answers "is this
   * snapshot from an older epoch"; a send moves a GENERATION INSIDE one epoch and is invisible here.
   * The other half is {@link installUnlessOvertaken}, which every replacement seam must also pass.
   *
   * Native mirror: `MlsManager::reload_is_monotonic` (mls-core), applied by
   * `recharger_mls_au_resume` in `src-tauri` on foreground resume - paired there with the
   * unpersisted-send watermark in `TauriMlsService.reloadStateFromDisk`, which is the native half of
   * `installUnlessOvertaken`. Keep BOTH halves in sync, on BOTH platforms. [[C2]]
   */
  private swapClientMonotonic(candidate: any): boolean {
    const current = this.client;
    if (!current) {
      this.client = candidate;
      return true;
    }
    const liveGroups = [...(current.get_groups() as unknown as Iterable<string>)];
    for (const gid of liveGroups) {
      let liveEpoch: number;
      try {
        liveEpoch = current.get_epoch(gid) as number;
      } catch {
        continue;
      }
      let candEpoch: number | null;
      try {
        candEpoch = candidate.get_epoch(gid) as number;
      } catch {
        candEpoch = null;
      }
      if (candEpoch === null || candEpoch < liveEpoch) {
        console.warn(
          `[MLS] Reload refused: group ${gid.slice(0, 8)}… would regress (live epoch=${liveEpoch}, candidate=${candEpoch ?? 'absent'}) - keeping live state`
        );
        return false;
      }
    }
    this.client = candidate;
    return true;
  }

  /**
   * Rebuilds a candidate WASM client from a persisted snapshot and installs it only
   * if it does not regress any live group (see {@link swapClientMonotonic}).
   * Returns whether the live client was actually replaced.
   */
  private async reloadClientFromState(state: Uint8Array, deviceKeyB64: string): Promise<boolean> {
    // `state` is not optional here - a snapshot is what this method exists to reload.
    const candidate = await loadAndInitWasm(this.userId, this.deviceId, state, deviceKeyB64, true);
    return this.swapClientMonotonic(candidate);
  }

  /**
   * Installs a worker-derived state over the live client, UNLESS the live client moved meanwhile.
   *
   * EVERY off-thread path has the same shape - snapshot the client, work on the copy, install the
   * result - and every one of them is a window in which the live client can be mutated by something
   * that does not take the MLS lock. `sendMessage` is exactly that: it advances this device's own
   * send ratchet, and installing a state taken before it puts that ratchet BACK. The next frame then
   * re-issues a spent generation and the peer refuses it as `SecretReuseError`.
   *
   * `swapClientMonotonic` cannot answer this. It refuses a regression and measures one with the
   * EPOCH, which is evidence for "is this snapshot from an older epoch" and for nothing else - a
   * generation that moved inside one epoch is just as stale and completely invisible to it.
   *
   * Shared by the two callers rather than written twice, because the second one was found only by
   * looking for the first one's shape - and a rule that lives at one call site is a rule the next
   * off-thread worker will not inherit.
   */
  private async installUnlessOvertaken(
    what: string,
    mutationsAtSnapshot: number,
    install: () => Promise<boolean>
  ): Promise<boolean> {
    const mutated = this.liveMutations - mutationsAtSnapshot;
    if (mutated > 0) {
      console.warn(
        `[MLS] ${what} state DISCARDED: the live client was mutated ${mutated} time(s) since the snapshot - installing it would rewind this device's own send ratchet`
      );
      return false;
    }
    return install();
  }

  /** Plain-CBOR (no PIN) variant of {@link reloadClientFromState} for worker catch-up. */
  private async reloadClientFromPlainState(state: Uint8Array): Promise<boolean> {
    const candidate = await loadAndInitWasm(this.userId, this.deviceId, state, undefined, true);
    return this.swapClientMonotonic(candidate);
  }

  /**
   * Runs key package generation in a worker and resolves with generated artifacts.
   *
   * Guarantees:
   * - 30s timeout: the timer is cancelled as soon as the worker responds (no timer leak).
   * - Listener cleanup: `removeEventListener` is always called, whether we resolve,
   *   reject or timeout, thanks to the `settled` flag and `cleanup()`.
   * - Worker termination on timeout: the worker is terminated (`terminate()`) and the singleton
   *   set to null to prevent a late response from contaminating the next call.
   * - State buffer transfer: the `ArrayBuffer` is transferred (not copied) to avoid
   *   memory duplication on snapshots that may weigh several hundred KB.
   */
  private runWorkerKeyPackageGeneration(
    deviceKeyB64: string,
    needed: number,
    state?: Uint8Array
  ): Promise<WorkerKeyPackageResult> {
    return new Promise<WorkerKeyPackageResult>((resolve, reject) => {
      const worker = this.getOrCreateKeyPackageWorker();
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timeoutId);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      const onMessage = (event: MessageEvent): void => {
        if (settled) return;
        const msg = event.data as
          | {
              type: 'generateKeyPackage:ok';
              payload: { fallback: ArrayBuffer; poolPackages: ArrayBuffer[]; state: ArrayBuffer };
            }
          | { type: 'generateKeyPackage:error'; error: string };
        if (!msg) return;
        if (msg.type === 'generateKeyPackage:ok') {
          settled = true;
          cleanup();
          resolve({
            fallback: new Uint8Array(msg.payload.fallback),
            poolPackages: msg.payload.poolPackages.map((b) => new Uint8Array(b)),
            state: new Uint8Array(msg.payload.state),
          });
        } else if (msg.type === 'generateKeyPackage:error') {
          settled = true;
          cleanup();
          reject(new Error(msg.error));
        }
      };

      const onError = (event: ErrorEvent): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(event.error ?? new Error(event.message || 'worker error'));
      };

      // The timer is cancelled by cleanup() in onMessage/onError - no leak.
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // Terminate the worker instance so a late response does not arrive on
        // a new listener registered by the next generateKeyPackage call.
        this.keyPackageWorker?.terminate();
        this.keyPackageWorker = null;
        reject(new Error('key package worker timeout after 15s'));
      }, 15_000);

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);

      // Transfer the buffer (ownership move, no copy) to avoid doubling
      // memory on a snapshot that may weigh several hundred KB.
      const workerState = state ? state.slice() : undefined;
      const request: MlsKeyPackageRequest = {
        type: 'generateKeyPackage',
        payload: {
          userId: this.userId,
          deviceId: this.deviceId,
          deviceKeyB64,
          needed,
          state: workerState?.buffer,
          stateWasExpected: this.stateWasExpected,
        },
      };
      worker.postMessage(request, workerState ? [workerState.buffer] : []);
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Closes the socket without throwing on already-closing WebViews. */
  private safeCloseWebSocket(ws: WebSocket, code = 1000, reason?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        this.disconnectCallback?.();
        return;
      }
      // Check if the server has sent anything since the last ping (JSON pong or data).
      // WS protocol Pong frames do not fire `onmessage` in browsers.
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats > WebMlsService.MAX_MISSED_HEARTBEATS) {
        console.warn(
          `[WS] ${this.missedHeartbeats} pings without server response - closing zombie connection`
        );
        this.clearHeartbeat();
        this.safeCloseWebSocket(ws, 1001, 'heartbeat timeout');
        this.disconnectCallback?.();
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.clearHeartbeat();
        this.disconnectCallback?.();
      }
    }, 8_000);
  }

  /** Call whenever a data frame is received to reset the heartbeat counter. */
  private resetHeartbeatCounter(): void {
    this.missedHeartbeats = 0;
  }

  isWsOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** WASM client wrapper - opens a native browser WebSocket to the chat gateway, wiring message/close handlers and registering reconnect listeners once. */
  async connect(token?: string): Promise<void> {
    this.clearHeartbeat();
    // Close existing socket before creating a new one
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    // Register visibility/online listeners once - trigger reconnect when the
    // tab becomes visible or the network comes back after a gap.
    if (!this._visibilityHandler && typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        if (
          document.visibilityState === 'visible' &&
          (!this.ws || this.ws.readyState !== WebSocket.OPEN)
        ) {
          this.disconnectCallback?.();
        }
      };
      this._onlineHandler = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.disconnectCallback?.();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      window.addEventListener('online', this._onlineHandler);
    }

    // Same-origin cookie often works; passing JWT in the query matches Tauri and
    // fixes upgrades where `canari_ws_token` is not forwarded (proxies, ITP).
    const wsUrl = this.baseUrl.replace(/^https?:/, (match) =>
      match === 'https:' ? 'wss:' : 'ws:'
    );
    let resolvedToken = token;
    if (!resolvedToken) {
      try {
        resolvedToken = await getToken();
      } catch {
        /* rely on canari_ws_token cookie only */
      }
    }
    const tokenParam = resolvedToken ? `&token=${encodeURIComponent(resolvedToken)}` : '';
    const fullWsUrl = `${wsUrl}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam}`;
    const logUrl = `${wsUrl}/api/ws?device_id=${encodeURIComponent(this.deviceId)}${tokenParam ? '&token=***' : ''}`;

    return new Promise((resolve, reject) => {
      console.log(`[WS] Opening connection → ${logUrl}`);
      this.ws = new WebSocket(fullWsUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.ws?.close();
          reject(new Error('WebSocket connection timeout after 15s'));
        }
      }, 15_000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        resolved = true;
        this.startHeartbeat();
        console.log(`[WS] Connected to Chat Gateway - device=${this.deviceId}`);
        resolve();
      };
      this.ws.onerror = (event) => {
        clearTimeout(timeout);
        console.error('[WS] WebSocket error:', event);
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `WebSocket connection failed to ${wsUrl}/api/ws (chat-gateway). Check that the gateway is running and reachable.`
            )
          );
        }
      };
      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `WebSocket closed before opening. Code: ${event.code}, Reason: ${event.reason || 'Connection refused or network error'}`
            )
          );
        } else {
          this.clearHeartbeat();
          console.warn(
            `[WS] Disconnected. Code: ${event.code}, Reason: ${event.reason || 'no reason'}`
          );
          this.disconnectCallback?.();
        }
      };
      this.ws.onmessage = async (event) => {
        // Any incoming frame proves the server is alive - reset heartbeat miss counter.
        this.resetHeartbeatCounter();
        try {
          // Gateway sends JSON text frames: { senderId, senderDeviceId, groupId, isWelcome, proto: base64(ciphertext) }
          const text: string =
            typeof event.data === 'string'
              ? event.data
              : event.data instanceof Blob
                ? await (event.data as Blob).text()
                : new TextDecoder().decode(event.data as ArrayBuffer);

          const msg = JSON.parse(text);
          const frameType = typeof msg.type === 'string' ? msg.type : '';
          if (frameType === 'pong' || frameType === 'ping') {
            return;
          }
          // THE ONE FIELD EVERY FRAME HAS IS ITS TYPE, and this line used to print four that only a
          // PAYLOAD frame carries - so every control frame (a read receipt, a typing signal, a
          // channel event) announced itself as `senderId=undefined, isWelcome=undefined,
          // protoLen=undefined`. Measured on the local estate 2026-09-04: two of the thirty-six
          // lines of an ordinary two-client exchange, each reporting three `undefined`s about a
          // frame that was perfectly well formed. A reader who learns to skip that is a reader who
          // will skip the next real one, and one who does not learns nothing from three `undefined`s.
          // The payload fields are logged on the payload branch below, where they exist.
          console.log(`[WS RCV] ${frameType || 'payload'} frame for group ${msg.groupId ?? '-'}`);
          if (isChannelEventFrame(frameType)) {
            if (this.onChannelEvent) {
              console.log(`[WS RCV] Triggering onChannelEvent for ${msg.type}`);
              this.onChannelEvent({ type: msg.type, data: msg.data });
            } else {
              console.warn(
                `[WS RCV] Received channel/post event but no onChannelEvent registered.`
              );
            }
            return;
          }
          if (msg.type === 'typing') {
            // Group/DM typing: normalise the flat gateway frame into the channel-event
            // shape so the shared handler updates the typing store uniformly.
            this.onChannelEvent?.({
              type: 'typing',
              data: { groupId: msg.groupId, userId: msg.userId, state: msg.state },
            });
            return;
          }
          if (msg.type === 'device_revoked') {
            // Its owner deleted this device. The denylist row is the durable half and would be
            // found at the next login anyway; this is what makes it immediate, so a device
            // declared lost stops holding a live session the moment it is disowned. Never
            // trusted blindly: the frame is addressed to this device by the gateway, and the
            // handler re-checks with the server before wiping anything.
            console.warn('[WS RCV] device_revoked - this device was deleted by its owner');
            this.deviceRevokedCallback?.();
            return;
          }
          if (msg.type === 'welcome_request') {
            const requesterUserId = (msg.requesterUserId as string) || '';
            const requesterDeviceId = (msg.requesterDeviceId as string) || '';
            const groupId = (msg.groupId as string) || '';
            console.log(
              `[WS RCV] welcome_request from ${sanitizeForLog(requesterUserId)}:${sanitizeForLog(requesterDeviceId)} for group ${sanitizeForLog(groupId)}`
            );
            this.welcomeRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msg.type === 'base_refresh_request') {
            const requesterUserId = (msg.requesterUserId as string) || '';
            const requesterDeviceId = (msg.requesterDeviceId as string) || '';
            const groupId = (msg.groupId as string) || '';
            console.log(
              `[WS RCV] base_refresh_request from ${sanitizeForLog(requesterUserId)}:${sanitizeForLog(requesterDeviceId)} for group ${sanitizeForLog(groupId)}`
            );
            this.baseRefreshRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msg.type === 'history_request') {
            const requesterUserId = (msg.requesterUserId as string) || '';
            const requesterDeviceId = (msg.requesterDeviceId as string) || '';
            const groupId = (msg.groupId as string) || '';
            console.log(
              `[WS RCV] history_request from ${sanitizeForLog(requesterUserId)}:${sanitizeForLog(requesterDeviceId)} for group ${sanitizeForLog(groupId)}`
            );
            this.historyRequestCallback?.(requesterUserId, requesterDeviceId, groupId);
            return;
          }
          if (msg.type === 'epoch_rejected') {
            console.warn(
              `[WS RCV] Epoch rejected for group ${msg.groupId} (server epoch: ${msg.currentEpoch})`
            );
            // Notify via channel event so connection.ts can trigger recovery
            if (this.onChannelEvent) {
              this.onChannelEvent({
                type: 'epoch_rejected',
                data: { groupId: msg.groupId, currentEpoch: msg.currentEpoch },
              });
            }
            return;
          }
          if (msg.proto && this.messageCallback) {
            const ciphertext = fromBase64(msg.proto as string);
            const ratchetTreeBytes =
              typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                ? fromBase64(msg.ratchetTree as string)
                : undefined;

            if (ciphertext.length > 0) {
              // The payload frame's own fields, where they are known to exist - the half of the
              // entry line above that only this branch can honestly print.
              console.log(
                `[WS RCV] payload: sender=${sanitizeForLog((msg.senderId as string) || 'unknown')},` +
                  ` welcome=${msg.isWelcome === true}, commit=${msg.isCommit === true},` +
                  ` bytes=${ciphertext.length}`
              );
              // Queue the message for sequential processing
              this.enqueueMessage(
                {
                  senderId: (msg.senderId as string) || 'unknown',
                  ciphertext,
                  groupId: (msg.groupId as string) || undefined,
                  isWelcome: msg.isWelcome === true,
                  isCommit: msg.isCommit === true,
                  ratchetTreeBytes,
                  queuedMessageId: (msg.queuedMessageId as string) || undefined,
                  queuedCreatedAt: parseServerTimestampMs(msg.createdAt),
                },
                'live'
              );
            }
          } else if (msg.proto && !this.messageCallback) {
            console.warn(
              `[WS RCV] a frame carried a proto but no messageCallback is registered - the frame is DROPPED`
            );
          } else if (frameType) {
            // A TYPED FRAME THAT REACHED NO BRANCH IS THE ONE FAILURE THIS LAYER CANNOT OTHERWISE
            // SHOW. The `workspace.*` family was published, forwarded and delivered here for months
            // and died on this line under a comment saying it was silently ignored; nothing anywhere
            // could have said so. It accuses now, and names the type, which is the whole diagnosis.
            console.warn(
              `[WS RCV] frame type "${frameType}" reached no handler - the server is sending ` +
                `something this client does not route (see channelEventTypes)`
            );
          }
        } catch (e) {
          console.error('[WS RCV] Failed to process WebSocket message:', e);
        }
      };
    });
  }

  /** Releases Web-specific resources: terminates the key package worker. */
  protected override destroyPlatformResources(): void {
    if (this.keyPackageWorker) {
      this.keyPackageWorker.terminate();
      this.keyPackageWorker = null;
    }
  }

  /** Sends a disconnect control frame over the browser WebSocket so the gateway removes the presence key immediately. */
  sendDisconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'disconnect' }));
      } catch {
        // Best-effort - ignore if the socket is already closing
      }
    }
  }

  /** Sends an ephemeral typing signal over the browser WebSocket for a DM/group. */
  sendTyping(groupId: string, isTyping: boolean): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({ type: 'typing', groupId, state: isTyping ? 'start' : 'stop' })
        );
      } catch {
        // Best-effort - typing is non-critical
      }
    }
  }

  /**
   * Initialises the WASM MLS client, short-circuiting if already initialised.
   * Delegates dedup and actual init to the base class / {@link _initImpl}.
   */
  override async init(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    if (this.client) return;
    // `opts` MUST be forwarded: dropping it silences `noFreshStart`, and an undecryptable
    // saved state then takes the destructive fresh-start branch (new device id, old device
    // deleted server-side) instead of surfacing MLS_LOCAL_STATE_UNDECRYPTABLE for recovery.
    // TypeScript accepts an override that declares fewer parameters, so the loss is silent.
    return super.init(userId, deviceKeyB64, state, opts);
  }

  /** Implementation body for init(); resolves device ID from localStorage and calls `loadAndInitWasm`, handling credential-mismatch recovery. */
  protected async _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    this.userId = userId;
    this.delivery.userId = userId;
    this.freshStart = !state;

    // Per-user device ID - prevents two users in the same browser from sharing a
    // device ID, which would cause the delivery service to route the welcome message
    // to the wrong user. Idempotent: a no-op when login already resolved it before
    // the pin-check.
    await this.resolveDeviceId(userId);

    try {
      await this.loadStateWithKey(deviceKeyB64, state);
    } catch (e) {
      // If init fails AND a saved state existed, the state is to blame
      // (credential mismatch, partial corruption, invalid key…).
      // → systematic fresh-start to avoid blocking the user indefinitely.
      // If state == null and error → real crash (no state to blame) → rethrow.
      let cause = this.classifyStateLoadFailure(e);

      // Before treating a sealed state as a PIN rotation, check whether it is simply older than
      // the v0.11.0 envelope change. Those snapshots were never rewritten (the MLS IndexedDB is
      // still at schema version 1), so on the first v0.11.x login they look exactly like a state
      // sealed with someone else's key - and the recovery offered for that cannot open them.
      if (cause === 'sealed' && state && opts?.legacyPin) {
        const migrated = await migrateLegacyMlsStateBlob(state, opts.legacyPin, deviceKeyB64);
        if (migrated) {
          console.log('[MLS] Pre-v0.11.0 snapshot re-sealed under the device key.');
          try {
            await this.loadStateWithKey(deviceKeyB64, migrated);
            // Persist immediately: leaving the legacy blob in place would replay this migration
            // on every launch, and any later failure would resurface the false rotation error.
            await saveMlsState(userId, migrated);
            return;
          } catch (migrationError) {
            // Opening the envelope says nothing about WHOSE state it is. A snapshot from before
            // an interrupted fresh start names the previous device, so re-classify and let the
            // block below apply the right answer - out here, not from inside this catch, or the
            // mismatch escapes init and the user sees a raw crypto error instead of recovering.
            cause = this.classifyStateLoadFailure(migrationError);
            console.warn(
              `[MLS] Migrated snapshot rejected (${cause}):`,
              String(migrationError).slice(0, 200)
            );
          }
        }
      }

      if (cause === 'mismatch' || state != null) {
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
        console.error('[MLS] WASM init failed:', e);
        throw e;
      }
    }
  }

  /** WASM decrypt + client init for a given device key/state; throws on wrong key (no fresh-start). */
  protected async loadStateWithKey(deviceKeyB64: string, state?: Uint8Array): Promise<void> {
    this.client = await loadAndInitWasm(
      this.userId,
      this.deviceId,
      state,
      deviceKeyB64,
      this.stateWasExpected
    );
  }

  /** WASM client wrapper - calls `this.client.create_group` to create a new local MLS group. */
  async createGroup(groupId: string): Promise<void> {
    this.client.create_group(groupId);
  }

  /** WASM client wrapper - calls `this.client.force_create_group`, wiping any orphan state before creating the group. */
  async forceCreateGroup(groupId: string): Promise<void> {
    this.client.force_create_group(groupId);
  }

  /** WASM client wrapper - serialises current MLS state as plain CBOR (no Argon2). */
  async saveStatePlain(): Promise<Uint8Array> {
    // Tag at the synchronous snapshot moment: this is the freshness reference the write-if-newer
    // guard uses, and it must be captured before the async encryption can let anything interleave.
    return tagMlsSnapshot(this.client.save_state(undefined) as Uint8Array);
  }

  /** Encrypts a plain CBOR snapshot (worker when enabled, else main-thread WASM). */
  async encryptState(plain: Uint8Array, deviceKeyB64: string): Promise<Uint8Array> {
    return encryptMlsStateOffThread(plain, deviceKeyB64, { enabled: this.useEncryptWorker });
  }

  /** Web keeps its snapshot in IndexedDB, so the encrypted bytes still have to be handed over. */
  protected async writeCheckpoint(deviceKeyB64: string): Promise<void> {
    await saveMlsState(this.userId, await this.saveState(deviceKeyB64));
  }

  /** WASM client wrapper - burns `count` send generations, discarding every frame it produces. */
  protected async skipSendGenerations(groupId: string, count: number): Promise<number> {
    return this.client.skip_send_generations(groupId, count) as number;
  }

  /** Plain CBOR on main thread, then Argon2+ChaCha off-thread when the encrypt worker is enabled. */
  async saveState(deviceKeyB64: string): Promise<Uint8Array> {
    const plain = await this.saveStatePlain();
    const encrypted = await this.encryptState(plain, deviceKeyB64);
    // Carry the plain snapshot's version onto the encrypted bytes so the off-thread Argon2 step
    // cannot reorder the write relative to a concurrent, fresher save.
    propagateMlsSnapshotVersion(plain, encrypted);
    return encrypted;
  }

  /**
   * Re-encrypts the in-memory MLS state with the new device key and writes it to storage.
   * The in-memory client state is unchanged; only the persisted blob is re-encrypted.
   */
  async changeDeviceKey(newDeviceKeyB64: string): Promise<void> {
    const newState = await this.saveState(newDeviceKeyB64);
    await saveMlsState(this.userId, newState);
    console.log('[MLS] Device key changed - state re-encrypted and persisted.');
  }

  /** WASM client wrapper - calls `this.client.generate_key_package`, replenishes the OTKP pool to 50, saves state, then publishes to the delivery service. */
  protected async generateKeyPackageImpl(deviceKeyB64: string): Promise<Uint8Array> {
    // On fresh start (no saved WASM state), old OTKPs on the server belong to
    // a previous session whose private keys are gone. Purge them so inviting
    // devices don't consume stale prekeys that would cause NoMatchingKeyPackage.
    if (this.freshStart) {
      this.freshStart = false;
      await this.delivery.deleteAllOneTimePrekeys();
    }

    // Replenish the one-time prekey pool up to 50 on each connection.
    // 50 is sufficient for normal use and avoids bloating the MLS state
    // with hundreds of unused private key bundles (each ~400 bytes).
    const existing = await this.delivery.fetchPrekeyCount();
    const needed = Math.max(0, 50 - existing);

    let fallback: Uint8Array;
    let poolPackages: Uint8Array[] = [];
    let stateBytesToPersist: Uint8Array | undefined;

    if (this.useKeyPackageWorker && typeof Worker !== 'undefined') {
      // The worker generates KeyPackages off-thread, but its result contains private keys
      // from a snapshot that may be stale if WebSocket messages were processed in parallel.
      // The MLS lock is held for the worker's whole life, which serialises this against the drain
      // and against a catch-up - and NOT against a send, which never takes that lock. So the swap
      // is guarded by `installUnlessOvertaken` as well: this window is the longest in the codebase
      // (a 30 s worker timeout), and the claim that the lock alone made it safe was the same claim
      // the catch-up path made, for the same reason, wrongly.
      //
      // Guarded rather than ORDERED, unlike the catch-up: making every send wait for key-package
      // generation would stall sending for up to 30 s on each connection, which is a worse defect
      // than the one being fixed. Refusing the swap costs nothing here - the `!swapped` branch
      // below already regenerates on the live client, because a refused snapshot's key packages
      // hold private keys the live client does not have.
      const workerGenResult = await this.messageScheduler.runUnderMlsLock(async () => {
        try {
          console.log('[MLS] generateKeyPackage via worker (under mlsLock)');
          const mutationsAtSnapshot = this.liveMutations;
          const snapshot = (this.client.save_state(deviceKeyB64) as Uint8Array).slice();
          const workerResult = await this.runWorkerKeyPackageGeneration(
            deviceKeyB64,
            needed,
            snapshot
          );
          const swapped = await this.installUnlessOvertaken(
            'key package worker',
            mutationsAtSnapshot,
            () => this.reloadClientFromState(workerResult.state, deviceKeyB64)
          );
          if (!swapped) {
            // The worker snapshot became stale (a mutation advanced the live client while it
            // ran): its key packages belong to a state we refused, so their private keys are
            // not in the live client. Regenerate on the authoritative live client rather than
            // publish orphaned prekeys (which would later cause NoMatchingKeyPackage).
            console.warn('[MLS] key package worker snapshot stale - regenerating on live client');
            const fb = this.client.generate_key_package() as Uint8Array;
            const pool =
              needed > 0
                ? [
                    ...(this.client.generate_key_packages(
                      needed
                    ) as unknown as Iterable<Uint8Array>),
                  ]
                : [];
            return {
              fallback: fb,
              poolPackages: pool,
              stateBytesToPersist: this.client.save_state(deviceKeyB64) as Uint8Array,
            };
          }
          return {
            fallback: workerResult.fallback,
            poolPackages: workerResult.poolPackages,
            stateBytesToPersist: workerResult.state,
          };
        } catch (e) {
          console.warn('[MLS] key package worker failed, fallback to main thread path:', e);
          const fb = this.client.generate_key_package() as Uint8Array;
          const pool =
            needed > 0
              ? [...(this.client.generate_key_packages(needed) as unknown as Iterable<Uint8Array>)]
              : [];
          return {
            fallback: fb,
            poolPackages: pool,
            stateBytesToPersist: this.client.save_state(deviceKeyB64) as Uint8Array,
          };
        }
      });
      fallback = workerGenResult.fallback;
      poolPackages = workerGenResult.poolPackages;
      stateBytesToPersist = workerGenResult.stateBytesToPersist;
    } else {
      // Always generate a fresh static fallback KP for this device.
      fallback = this.client.generate_key_package() as Uint8Array;
      if (needed > 0) {
        // generate_key_packages returns a js_sys::Array of Uint8Array values.
        poolPackages = [
          ...(this.client.generate_key_packages(needed) as unknown as Iterable<Uint8Array>),
        ];
      }
      stateBytesToPersist = this.client.save_state(deviceKeyB64) as Uint8Array;
    }

    if (stateBytesToPersist) {
      try {
        // Tag here: this synchronous save-and-write turn has no interleaving await, so the version
        // reflects the just-captured state and orders correctly against a concurrent encrypted flush.
        await saveMlsState(this.userId, tagMlsSnapshot(stateBytesToPersist));
      } catch (e) {
        console.warn('[MLS] Auto-save failed in WASM mode:', e);
      }
    }

    // Publish the static fallback KP (always refreshed on connection).
    await this.publishKeyPackage(fallback);

    // Bulk-publish new pool prekeys if any.
    if (poolPackages.length > 0) {
      await this.publishKeyPackages(poolPackages);
    }

    return fallback;
  }

  /**
   * WASM client wrapper - stages an Add commit WITHOUT merging via `this.client.add_members_bulk`.
   * Returns `[commit, welcome, added_indices, skipped_indices]`. `added_indices` are the positions
   * in `keyPackages` actually included in the commit - WASM silently skips invalid key packages and
   * ones already belonging to an existing member, so a bare count would misalign whenever a skip
   * isn't the very last entry. `skipped_indices` are positions dropped for an INVALID/undeserializable
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
    const jsArray = keyPackages.reduce((arr, kp) => {
      arr.push(kp);
      return arr;
    }, [] as Uint8Array[]);
    const res = this.client.add_members_bulk(groupId, jsArray);
    return {
      commit: res[0] as Uint8Array,
      welcome: res[1] as Uint8Array | undefined,
      addedIndices: res[2] as number[],
      skippedIndices: (res[3] as number[] | undefined) ?? [],
    };
  }

  /** WASM client wrapper - stages a Remove commit for all devices of the given users (no merge). */
  protected async stageRemoveMembers(groupId: string, userIds: string[]): Promise<Uint8Array> {
    const jsArray = userIds.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    return this.client.remove_members(groupId, jsArray) as Uint8Array;
  }

  /** WASM client wrapper - stages a Remove commit for specific device identities (no merge). */
  protected async stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[]
  ): Promise<Uint8Array> {
    const jsArray = deviceIdentities.reduce((arr, id) => {
      arr.push(id);
      return arr;
    }, [] as string[]);
    return this.client.remove_members_by_device(groupId, jsArray) as Uint8Array;
  }

  /** WASM client wrapper - merges the pending staged commit (server accepted). */
  protected async mergePendingCommit(groupId: string): Promise<void> {
    this.client.merge_pending_commit(groupId);
  }

  /** WASM client wrapper - clears the pending staged commit (server rejected, no fork). */
  protected async clearPendingCommit(groupId: string): Promise<void> {
    this.client.clear_pending_commit(groupId);
  }

  /** WASM client wrapper - exports the post-merge ratchet tree for the Welcome. */
  protected async exportRatchetTree(groupId: string): Promise<Uint8Array> {
    return this.client.export_ratchet_tree(groupId) as Uint8Array;
  }

  /** WASM getEpoch() reads live in-memory state, so the sync value is already authoritative. */
  protected async freshEpoch(groupId: string): Promise<number> {
    return this.getEpoch(groupId);
  }

  /** WASM client wrapper - exports the self-contained GroupInfo (external-join base). */
  protected async exportGroupInfo(groupId: string): Promise<Uint8Array> {
    return this.client.export_group_info(groupId) as Uint8Array;
  }

  /** WASM client wrapper - builds an external commit from a served GroupInfo and stages it. Returns
   *  [group_id, commit] from the WASM boundary. */
  protected async joinByExternalCommit(
    groupInfoBytes: Uint8Array
  ): Promise<{ groupId: string; commit: Uint8Array }> {
    const res = this.client.join_by_external_commit(groupInfoBytes) as unknown as [
      string,
      Uint8Array,
    ];
    return { groupId: res[0], commit: res[1] };
  }

  /** WASM client wrapper - calls `this.client.process_welcome` and returns the derived groupId. */
  async processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string> {
    return this.client.process_welcome(welcomeBytes, ratchetTreeBytes);
  }

  /** WASM client wrapper - encrypts plaintext via `this.client.send_message_bytes`, then POSTs the ciphertext to the delivery service. */
  /** WASM client wrapper - advances the live send ratchet. Ordering and persistence: `sendMessage`. */
  protected async encryptForSend(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array> {
    return this.client.send_message_bytes(groupId, messageBytes) as Uint8Array;
  }

  /** WASM client wrapper - decrypts a raw MLS ciphertext via `this.client.process_incoming_message_bytes`; returns null for commit or proposal frames. */
  async processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null> {
    const result = this.client.process_incoming_message_bytes(groupId, messageBytes);
    return result ?? null;
  }

  /** Single WASM crossing for an ordered page of ciphertexts (history catch-up / fallback path). */
  async processIncomingMessagesBatch(
    groupId: string,
    messages: Uint8Array[]
  ): Promise<MlsBatchProcessResult[]> {
    return wasmClientDecryptPage(this.client, groupId, messages);
  }

  /**
   * Off-thread decrypt session for history catch-up.
   *
   * Holds the MLS client mutex from snapshot to commit so the live client is never mutated
   * concurrently, runs a persistent worker that accumulates the ratchet across pages, and
   * reloads the live client a single time on {@link MlsDecryptSession.finish}. If the worker
   * cannot start, falls back to the sequential live-client session under the same held lock.
   */
  override async createDecryptSession(groupId: string): Promise<MlsDecryptSession> {
    if (!this.useCryptoWorker || typeof Worker === 'undefined') {
      return super.createDecryptSession(groupId);
    }

    const release = await this.messageScheduler.acquireMlsLock();

    // Closes the gate every send waits on, and remembers where the live client stood. The gate is
    // the fix; the count below is the proof it held - if it ever differs at the swap, a send got
    // through and the state about to be installed would undo it.
    this.beginCatchUp(groupId);
    const mutationsAtSnapshot = this.liveMutations;

    let workerSession: Awaited<ReturnType<typeof createMlsCryptoWorkerSession>> | null;
    try {
      const snapshot = (this.client.save_state(undefined) as Uint8Array).slice();
      workerSession = await createMlsCryptoWorkerSession({
        userId: this.userId,
        deviceId: this.deviceId,
        groupId,
        state: snapshot,
      });
    } catch (e) {
      // Worker bootstrap failed - degrade to the sequential live-client path for this session.
      console.warn('[MLS] crypto worker session bootstrap failed, sequential fallback:', e);
      workerSession = null;
    }

    if (!workerSession) {
      const seq = await super.createDecryptSession(groupId);
      return {
        decryptPage: (msgs) => seq.decryptPage(msgs),
        finish: async () => {
          try {
            await seq.finish();
          } finally {
            // The sequential path mutates the live client in place: no snapshot, so no swap and no
            // rewind - nothing here can rewind a ratchet.
            this.endCatchUp(groupId);
            release();
          }
        },
      };
    }

    const session = workerSession;
    let usedWorker = false;
    return {
      async decryptPage(messageBytesList: Uint8Array[]) {
        if (messageBytesList.length === 0) return [];
        usedWorker = true;
        // Page failure rejects: the caller stops feeding pages and calls finish(),
        // which restores the live client from the untouched snapshot (state discarded).
        return session.decryptPage(messageBytesList);
      },
      finish: async () => {
        try {
          if (usedWorker) {
            const finalState = await session.finalize();
            /**
             * The gate in `sendMessage` should make this unreachable, and it is kept anyway: the
             * gate is an ORDERING and this is an INVARIANT. A future send path that forgets to wait
             * must be caught here rather than corrupt a ratchet silently - which is precisely how
             * WP-FALSELOSS-2 survived three sessions of looking straight at it.
             *
             * Refusing costs nothing: the decrypted plaintexts were already handed to the caller,
             * so only the catch-up's ratchet advance is thrown away, and the next replay redoes it.
             */
            // The verdict is not read here because a REFUSAL reports itself: `installUnlessOvertaken`
            // warns with the reason before returning false, so a caller storing the boolean would be
            // a second place to keep the same fact - which is what the field deleted with this line
            // was, written five times and read nowhere.
            await this.installUnlessOvertaken(
              `catch-up (${groupId.slice(0, 8)}…)`,
              mutationsAtSnapshot,
              () => this.reloadClientFromPlainState(finalState)
            );
          }
        } catch (e) {
          // A page or finalize failed: leave the live client at the untouched snapshot
          // (worker mode never mutates it). The conversation is retried on the next catch-up.
          console.warn('[MLS] decrypt session finalize failed, live client left at snapshot:', e);
        } finally {
          this.endCatchUp(groupId);
          session.dispose();
          release();
        }
      },
    };
  }

  /** WASM client wrapper - calls `this.client.export_secret` to derive keying material for channel encryption. */
  async exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array> {
    if (!this.client) throw new Error('WC not initialized');
    return this.client.export_secret(groupId, label, context, keyLen);
  }

  /** WASM client wrapper - publishes this device's static fallback KeyPackage to the delivery service, including device name/OS metadata. */
  async publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void> {
    const base64 = toBase64(keyPackageBytes);
    const storedName =
      localStorage.getItem(`device-name:${this.userId}:${this.deviceId}`) || undefined;
    await this.delivery.registerDeviceKeyPackage({
      keyPackageBase64: base64,
      deviceName: storedName,
      deviceOs: detectRuntimeDeviceOs(),
    });
  }

  /** WASM client wrapper - returns all MLS group IDs known to the WASM module via `this.client.get_groups`. */
  getLocalGroups(): string[] {
    if (!this.client) return [];
    return Array.from(this.client.get_groups() as Iterable<string>);
  }

  /**
   * WASM client wrapper - `is_group_active`. See {@link IMlsService.isGroupActive}.
   *
   * THROWS rather than answering `false` when the client is not ready: "not loaded yet" and "we
   * were removed" are opposite facts, and the caller retires a conversation on the second.
   */
  async isGroupActive(groupId: string): Promise<boolean> {
    if (!this.client)
      throw new Error(`[MLS] WASM client not ready - cannot read membership of ${groupId}`);
    return this.client.is_group_active(groupId);
  }

  /**
   * WASM client wrapper - every leaf identity (`userId:deviceId`) in the group's ratchet tree.
   *
   * THROWS rather than answering `[]` when the group is not held: an empty tree and a group this
   * device does not have are opposite facts, and the caller that reconciles a roster against it
   * would read the second as "every member has left" and remove them all.
   */
  async getGroupMemberIdentities(groupId: string): Promise<string[]> {
    if (!this.client)
      throw new Error(`[MLS] WASM client not ready - cannot read ${groupId}'s tree`);
    return Array.from(this.client.get_member_identities(groupId) as Iterable<string>);
  }

  /** WASM client wrapper - returns the current MLS epoch for a group via `this.client.get_epoch`, or 0 if unavailable. */
  getEpoch(groupId: string): number {
    if (!this.client) return 0;
    try {
      return this.client.get_epoch(groupId) as number;
    } catch {
      return 0;
    }
  }

  /** WASM client wrapper - calls `this.client.forget_group` to drop local MLS state for the given group. */
  forgetGroup(groupId: string, minEpoch = 0): void {
    if (!this.client) return;
    try {
      this.client.forget_group(groupId, minEpoch);
    } catch (e) {
      console.warn('[MLS] forgetGroup error:', e);
    }
  }

  /** Poison Pill - definitive purge: WASM memory, OpenMLS storage and epoch lock at MAX. */
  dropGroup(groupId: string): void {
    if (!this.client) return;
    try {
      this.client.drop_group(groupId);
    } catch (e) {
      console.warn('[MLS] dropGroup error:', e);
    }
  }

  /** WASM client wrapper - checks via `this.client.key_package_has_private` that we hold the KeyPackage's private key. */
  protected async keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean> {
    return this.client.key_package_has_private(keyPackageBytes) as boolean;
  }
}
