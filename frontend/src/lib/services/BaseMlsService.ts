import type {
  IMlsService,
  GroupMeta,
  UserGroupRow,
  MlsInitOptions,
  BulkIngestPhase,
  BulkIngestObserver,
} from '$lib/mls-client';
import { MlsDeliveryApi, resolveMlsPublicUrls, MLS_ADD_LOCK_TTL_MS } from '$lib/mls-client';
import {
  type MlsDecryptSession,
  createSequentialDecryptSession,
} from '$lib/mls-client/mlsDecryptSession';
import {
  DeviceRevokedError,
  NotAGroupMemberError,
  type MlsDeliveryFetch,
} from '$lib/mls-client/mlsDeliveryApi';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import {
  persistMlsStructuralCheckpoint,
  scheduleOutboundMlsPersist,
} from '$lib/mls-client/mlsStatePersisterRegistry';
import {
  MAX_BURN_GENERATIONS,
  commitPersisted,
  noteFrameEmitted,
  pendingSendGenerations,
  resetSendRatchetLedger,
  snapshotEmitted,
} from '$lib/mls-client/sendRatchetLedger';
import { fingerprintKeyPackage } from '$lib/mls-client/keyPackages';
import type {
  DeviceMembershipRow,
  HistoryRequestOutcome,
  IncomingDeliveryMeta,
} from '$lib/mls-client/IMlsService';
import { MlsPerGroupScheduler, type MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';
import {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
  logMlsMetric,
} from '$lib/mls-client';
import {
  beginQueueDrainBench,
  recordQueueDrainMessage,
  finishQueueDrainBench,
  recordPendingMessagesFetched,
} from '$lib/mls-client/catchupBenchmark';
import { attemptCommitReplay } from '$lib/utils/chat/commitReplay';
import { markEpochGap, clearEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { runAsEpochAdvance, runAsEpochSend } from '$lib/utils/chat/epochSendBarrier';
import {
  parseServerTimestampMs,
  type DeliveryChannel,
  type DeliveryRepeatShape,
} from '$lib/mls-client/incomingDelivery';
import { classifyIncomingDecryptError } from '$lib/mls-client/mlsDecryptError';
import { scopeKey, scopeLabel, type DistributionScope } from '$lib/mls-client/distributionScope';
import {
  reportUnackedFrames,
  takeGroupAwaiting,
  takeGroupsAwaiting,
  type UnackedReason,
} from '$lib/mls-client/messagePipeline/unackedFrames';
import { getToken } from '$lib/stores/auth';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import type {
  DistributionFrameHandler,
  DistributionGroupInfoTransport,
  ExternalJoinOutcome,
} from '$lib/mls-client/IMlsService';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';

/**
 * How many times {@link BaseMlsService.externalJoin} may re-read the base and resubmit.
 *
 * A BOUND, NOT THE TERMINATION CONDITION. The only refusal it exists for is `concurrent_commit`,
 * where the commit lock was busy and the base may legitimately have moved by the next read; a base
 * that is behind the group's epoch ends the loop on that fact, whatever this number is.
 */
const EXTERNAL_JOIN_MAX_ATTEMPTS = 3;

/**
 * Abstract base class shared by WebMlsService (WASM) and TauriMlsService (Rust native).
 *
 * Contains every field and method that is identical between the two platforms:
 * - All `/api/mls/*` delivery REST wrappers (delegated to {@link MlsDeliveryApi})
 * - WebSocket callback registrations (onMessage, onDisconnect, etc.)
 * - Queue plumbing (enqueueMessage, waitForMessageQueueIdle, processQueue, fetchPendingMessages)
 * - Event-driven re-fetch of frames the handler left unacknowledged (refetchFramesLeftBehind)
 * - Lifecycle boilerplate (init promise dedup, destroy base listeners)
 *
 * Platform-specific code lives exclusively in the subclasses:
 * - WebMlsService: WASM client, key-package worker, browser WebSocket
 * - TauriMlsService: invoke() calls, native WebSocket, epoch/group caches
 */
/**
 * The value {@link BaseMlsService.userId} holds before a session has resolved one.
 *
 * It is a NON-IDENTITY, not a user, and it is exported because the difference has to be checkable
 * from outside this file: the server was once sent this literal and stored it as a group member.
 */
export const UNRESOLVED_USER_ID = 'unknown';

/**
 * The value {@link BaseMlsService.deviceId} holds before {@link BaseMlsService.resolveDeviceId}
 * has run. Same contract as {@link UNRESOLVED_USER_ID}, and the same reason for being named.
 */
export const UNRESOLVED_DEVICE_ID = 'pending';

/**
 * Thrown when a seam that publishes an identity is reached before that identity exists.
 *
 * Typed rather than a message, because the ONE call site that must tell this apart from a network
 * failure is the one deciding whether to retry: an unresolved identity resolves on its own and the
 * next cycle succeeds, where a 500 does not.
 */
export class UnresolvedIdentityError extends Error {
  constructor(
    readonly seam: string,
    readonly field: 'userId' | 'deviceId'
  ) {
    super(`${seam} refused: ${field} is still the unresolved placeholder`);
    this.name = 'UnresolvedIdentityError';
  }
}

/**
 * Refuses to publish an identity that does not exist yet.
 *
 * WHY IT IS A THROW AND NOT A SKIP: on 2026-08-27 a client reached `updateInvitationStatus` with
 * `userId = 'unknown'` and `deviceId = 'pending'` and the server stored the pair as an ACTIVE
 * member of a real conversation - one second before the two real members joined. For 134 minutes
 * the placeholder held the peer's place while both of the peer's own devices sat `pending`, and
 * every message between them was lost. The class already knew both values were non-identities and
 * guarded on them in four other places; these seams did not.
 *
 * The caller may swallow it - most of these calls are fire-and-forget and are re-driven on the
 * next cycle, by which time the identity exists. What must NOT happen is the value reaching the
 * server, because a roster cannot tell a placeholder from a member.
 */
function assertResolvedIdentity(seam: string, userId: string, deviceId: string): void {
  if (userId === UNRESOLVED_USER_ID || !userId) {
    console.error(`[IDENTITY] ${seam} called before the userId resolved - refused`);
    throw new UnresolvedIdentityError(seam, 'userId');
  }
  if (deviceId === UNRESOLVED_DEVICE_ID || !deviceId) {
    console.error(`[IDENTITY] ${seam} called before the deviceId resolved - refused`);
    throw new UnresolvedIdentityError(seam, 'deviceId');
  }
}

export abstract class BaseMlsService implements IMlsService {
  // ── Platform identity ─────────────────────────────────────────────────────
  protected readonly platform: 'web' | 'tauri';

  // ── Callbacks ─────────────────────────────────────────────────────────────
  onChannelEvent?: (event: { type: string; data: unknown }) => void;

  protected messageCallback:
    | ((
        senderId: string,
        content: Uint8Array,
        groupId?: string,
        isWelcome?: boolean,
        ratchetTreeBytes?: Uint8Array,
        isCommit?: boolean,
        deliveryMeta?: IncomingDeliveryMeta
      ) => Promise<boolean>)
    | null = null;

  protected disconnectCallback: (() => void) | null = null;

  protected welcomeRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;

  /**
   * Installed by the session so this device can republish a group's external-join base when another
   * device asks. Read-only for the tree: no lock, no epoch change, nothing to merge.
   */
  protected baseRefreshRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | undefined;
  protected historyRequestCallback:
    | ((requesterUserId: string, requesterDeviceId: string, groupId: string) => void)
    | null = null;

  protected welcomeProcessedCallback: ((groupId?: string) => void) | null = null;

  /**
   * Raised when the server says THIS device has been revoked, while it is still connected.
   *
   * Distinct from the revocation the key-package path already handles: that one is discovered by
   * asking, on the next enrolment, and answered by rotating to a fresh identity. This one arrives
   * unprompted at the moment its owner deletes the device, and the answer is the opposite - there
   * is no identity to continue under, so the session ends and the device is returned to a fresh
   * install.
   */
  protected deviceRevokedCallback: (() => void) | null = null;

  // ── URLs & identity ───────────────────────────────────────────────────────
  protected baseUrl: string;
  protected historyUrl: string;
  protected userId: string = UNRESOLVED_USER_ID;
  protected deviceId: string = UNRESOLVED_DEVICE_ID;

  // ── Delivery REST client ──────────────────────────────────────────────────
  protected readonly delivery: MlsDeliveryApi;

  // ── Graine key-distribution groups ────────────────────────────────────────
  /**
   * Group id -> the roster it carries: a community, or ONE private salon of it.
   *
   * It exists because a distribution group's external-join base does not live where every other
   * group's does. Chat-delivery gates `group-info` on a `dm_group_members` row, and this group has
   * none by construction - it is entered by external commit and authorized by membership of the
   * scope, a fact only social-service holds. So the base is fetched and published through
   * social-service, and this map is how the MLS layer knows which of the two it is looking at
   * without asking.
   *
   * The value is the whole scope and not a workspace id: since 2026-08-19 a private salon has its
   * own group, and a map that could only name a community would have had to guess which of the two
   * a group was - the guess being exactly the sharing the salon scope removes.
   */
  private readonly distributionScopeByGroup = new Map<string, DistributionScope>();

  /**
   * Groups the SERVER has said are distribution groups, whose scope this session cannot yet name.
   *
   * TWO QUESTIONS, AND ONLY ONE OF THEM NEEDS THE SCOPE. "Is this a distribution group" is
   * answerable from the `dm_groups` row alone; "which roster is it" is not, because a salon's scope
   * carries its community and the row cannot - chat-delivery does not own `channels`. Holding both
   * answers in the map above made the easy question inherit the hard one's precondition: a salon's
   * group whose community this session had not loaded answered `isDistributionGroup() === false`,
   * although the server had just said otherwise and the sweep had just kept it on that basis.
   *
   * That is a discriminator dropped in transit, and it is not harmless: every consumer of the
   * predicate - the sweep, the frame router, the history reconciliation - was then wrong about that
   * group for the rest of the session. Recorded here instead, so the cheap answer stops waiting on
   * the expensive one.
   */
  private readonly knownDistributionGroups = new Set<string>();

  /**
   * Groups this device CREATED whose base is not arbitrated yet - held locally, not usable yet.
   *
   * A THIRD STATE THE CODE USED TO SPELL AS THE SECOND. `distributionEpochFor` asks "is the group
   * held locally" and reads the answer as "may seeds ride it". Between {@link createGroup} and the
   * server's verdict on the first publish those two differ: the group is in `getLocalGroups()`, so
   * it answers epoch 0, while it may still be thrown away for having lost the race.
   *
   * A send landing in that window mints an outbound Graine session against the doomed group and
   * distributes the seed into it. `forgetGroup` then takes the session with the group, and whatever
   * it sealed is unreadable for ever - by its own author included, which is how it is noticed.
   *
   * Measured 2026-08-27 on the COMM rung: two devices of one account both found a salon
   * uninitialised, the loser recovered exactly as designed, and its already-minted session did not.
   * The comment on {@link ensureDistributionGroup} asserted the window was empty - "this runs
   * before any seed is sent" - and nothing enforced it. This set is that enforcement, and it lives
   * exactly as long as the window: see the `finally` that clears it.
   */
  private readonly unsettledDistributionGroups = new Set<string>();

  /** Set once at wiring time; see {@link setDistributionGroupInfoTransport}. */
  private distributionGroupInfo: DistributionGroupInfoTransport | null = null;

  /** Set once at wiring time; see {@link onDistributionFrame}. */
  private distributionFrameHandler: DistributionFrameHandler | null = null;

  // ── Init dedup ────────────────────────────────────────────────────────────
  protected initPromise: Promise<void> | null = null;
  /** True when MLS is initialized without an existing state blob (fresh device). */
  protected freshStart = false;

  /**
   * Fingerprints of every key package THIS process has published, so
   * {@link reconcilePublishedKeyPackages} can never purge one of them.
   *
   * Per-process and deliberately not durable: the claim it supports is "this process minted these
   * bytes and therefore holds their private key", which is only true of this process. A durable
   * version would assert something it cannot know after a restart, which is precisely the mistake
   * the guard exists to catch.
   */
  private readonly publishedThisSession = new Set<string>();
  /** Epoch ms of the last {@link republishKeyMaterial} run, used to debounce it. */
  private lastKeyMaterialRepublish = 0;

  // ── Timers & event handlers ───────────────────────────────────────────────
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  protected _visibilityHandler: (() => void) | null = null;
  protected _onlineHandler: (() => void) | null = null;

  // ── Message queue ─────────────────────────────────────────────────────────
  /** Per-conversation queues with round-robin scheduling and a global MLS mutex. */
  protected readonly messageScheduler: MlsPerGroupScheduler;

  /**
   * Deliveries taken in, by the server's queue id, and whether this device is finished with them.
   *
   * TWO CHANNELS CARRY THE SAME ROW AND ONE OF THEM IS ALWAYS LATE. A frame is pushed live over the
   * socket and it is also listed by the pull, and the acknowledgement that removes it server-side
   * cannot land before the pull that was already in flight. Measured on production during COMM-4 on
   * 2026-08-25, at boot, one second apart: `qId=d4ecf0fe` drained from the socket and absorbed, then
   * `[PENDING] Fetched 1 pending messages` handed the identical row back and the second decrypt
   * reported `SecretReuseError` on generation 0 of an epoch already read - which is the ratchet
   * refusing to spend a secret twice, and correct.
   *
   * SO THE DELIVERY IS IDENTIFIED, AND ENTERS ONCE. The queue id is the row's identity, given by the
   * server, and this map is the state that makes taking it in idempotent - not a flag saying a frame
   * "was handled", which would answer a different question and lag the ratchet. Deduplicating here
   * rather than at either caller is deliberate: both channels are legitimate, neither can know what
   * the other received, and the overlap is deleted at the ONE seam they share.
   *
   * `queued` AND `done` ARE DIFFERENT ANSWERS TO A REPEAT. A row this device has acknowledged is
   * acknowledged AGAIN and not decrypted, because the only way it can be offered after an ack is
   * that the ack never arrived, and dropping it silently would leave it pending for ever. A row still
   * in the queue needs nothing: the copy already there will ack it.
   *
   * A ROW LEFT DELIBERATELY UNACKNOWLEDGED IS FORGOTTEN, which is the case this must not break. A
   * frame for an unknown group is processed, not acked, and re-fetched when its Welcome lands - so
   * remembering it would make that re-fetch a no-op. The entry is dropped exactly where the ack
   * decision says no.
   */
  private readonly deliveries = new Map<string, 'queued' | 'done'>();

  /** Persistence-only window: no UI buffering, no overlay (default for {@link withMlsBulkIngest}). */
  /** How many delivery ids {@link rememberDelivery} keeps. See its doc for why it is bounded. */
  private static readonly DELIVERY_MEMORY = 512;

  private static readonly PERSIST_ONLY_PHASE: BulkIngestPhase = {
    bufferUi: false,
    showOverlay: false,
  };

  /** Lifecycle observers of bulk-ingest windows (MLS state persister, UI render buffer). */
  private readonly bulkIngestObservers: BulkIngestObserver[] = [];

  /** Stack of open phases, so {@link endBulkIngest} replays the exact phase its open used. */
  private readonly bulkIngestPhases: BulkIngestPhase[] = [];

  constructor(platform: 'web' | 'tauri', fetchImpl?: MlsDeliveryFetch) {
    this.platform = platform;
    // Device ID is resolved per-user in init() to avoid collisions when multiple
    // users share the same browser (e.g. two tabs in the same browser window).
    this.deviceId = 'pending';

    const urls = resolveMlsPublicUrls();
    this.baseUrl = urls.baseUrl;
    this.historyUrl = urls.historyUrl;
    this.messageScheduler = new MlsPerGroupScheduler(platform);
    this.delivery = new MlsDeliveryApi({
      historyUrl: this.historyUrl,
      getToken,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialises the MLS identity, deduplicating concurrent calls via a shared promise.
   * Delegates actual init to the platform-specific {@link _initImpl}.
   */
  async init(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const p = this._initImpl(userId, deviceKeyB64, state, opts).then(() =>
      // BEFORE ANYTHING CAN SEND, and inside the promise every caller already awaits: a send racing
      // the repair would be encrypted at the very generation the repair exists to move past.
      this.reconcileSendRatchets(deviceKeyB64)
    );
    this.initPromise = p;
    try {
      await p;
    } catch (e) {
      // Clear the cached promise so a failed init (e.g. undecryptable state pending
      // recovery) can be retried instead of returning the same rejection forever.
      this.initPromise = null;
      throw e;
    }
  }

  /**
   * Classifies why {@link loadStateWithKey} rejected, so `_initImpl` can pick a recovery that
   * actually addresses the cause.
   *
   * The distinction is not cosmetic. `sealed` means the blob would not decrypt: the account key
   * changed on another device, and re-entering the OLD PIN recovers it - so the caller must stop
   * and offer that path rather than destroy anything. `mismatch` means the blob DID decrypt and
   * only carries another device's identity; no PIN can fix that, so pausing for a recovery the
   * user cannot complete just strands them. Treating the two alike is what surfaced a false
   * "your PIN was changed on another device" to users who had never changed their PIN.
   */
  protected classifyStateLoadFailure(error: unknown): 'mismatch' | 'sealed' {
    const errStr = String(error);
    return errStr.includes('identity mismatch') || errStr.includes('Credential identity')
      ? 'mismatch'
      : 'sealed';
  }

  /** Platform-specific init body (WASM load vs Tauri invoke). */
  protected abstract _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: MlsInitOptions
  ): Promise<void>;

  /**
   * Platform-specific decrypt + client init for a given device key and (optional) saved state.
   * Throws on a wrong key / unusable state - and unlike {@link _initImpl} performs NO
   * fresh-start fallback, so callers can probe a candidate key non-destructively.
   * `this.userId` and `this.deviceId` must already be resolved.
   */
  protected abstract loadStateWithKey(deviceKeyB64: string, state?: Uint8Array): Promise<void>;

  /**
   * Forgot-PIN-elsewhere recovery: the account PIN was changed on another device, so this
   * device's local state is still sealed under the OLD key. Decrypts it with `oldDeviceKeyB64`
   * (non-destructively - no fresh-start, device id untouched) then re-encrypts it under
   * `newDeviceKeyB64` via {@link changeDeviceKey}, preserving all local messages. Marks the
   * client as initialised so a following {@link init}/login reuses it instead of re-decrypting.
   *
   * Returns `false` when `oldDeviceKeyB64` does not decrypt the local state (so the caller can
   * show an "ancien PIN incorrect" error); `true` on success.
   */
  async recoverAndRekey(
    userId: string,
    oldDeviceKeyB64: string,
    newDeviceKeyB64: string,
    state: Uint8Array
  ): Promise<boolean> {
    this.userId = userId;
    this.delivery.userId = userId;
    await this.resolveDeviceId(userId);
    try {
      await this.loadStateWithKey(oldDeviceKeyB64, state);
    } catch (e) {
      console.warn(
        '[MLS] recoverAndRekey: old device key did not decrypt local state:',
        String(e).slice(0, 160)
      );
      return false;
    }
    await this.changeDeviceKey(newDeviceKeyB64);
    // The client is already decrypted in memory and the persisted blob is now re-encrypted
    // under newPin; short-circuit init() so the subsequent login reuses this exact client.
    this.initPromise = Promise.resolve();
    return true;
  }

  /**
   * Removes shared event listeners and clears the heartbeat timer.
   * Calls {@link destroyPlatformResources} for subclass-specific teardown.
   */
  destroy(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // The work list of unacknowledged frames belongs to the session, not to this client: it is
    // dropped by `resetUnackedFrames` at logout, and a destroy that kept the socket's successor
    // running must not lose what still needs re-fetching.
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      this._onlineHandler = null;
    }
    this.destroyPlatformResources();
  }

  /** Override to release platform-specific resources (e.g. Worker, native WebSocket). */
  protected destroyPlatformResources(): void {}

  // ── WebSocket (platform-specific) ─────────────────────────────────────────

  abstract connect(token?: string): Promise<void>;
  abstract isWsOpen(): boolean;
  abstract sendDisconnect(): void;

  abstract sendTyping(groupId: string, isTyping: boolean): void;

  // ── Callbacks ─────────────────────────────────────────────────────────────

  onMessage(
    callback: (
      senderId: string,
      content: Uint8Array,
      groupId?: string,
      isWelcome?: boolean,
      ratchetTreeBytes?: Uint8Array,
      isCommit?: boolean,
      deliveryMeta?: IncomingDeliveryMeta
    ) => Promise<boolean>
  ): void {
    this.messageCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
  }

  onWelcomeRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.welcomeRequestCallback = callback;
  }

  onBaseRefreshRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.baseRefreshRequestCallback = callback;
  }

  onHistoryRequest(
    callback: (requesterUserId: string, requesterDeviceId: string, groupId: string) => void
  ): void {
    this.historyRequestCallback = callback;
  }

  onWelcomeProcessed(callback: (groupId?: string) => void): void {
    this.welcomeProcessedCallback = callback;
  }

  /** @see deviceRevokedCallback */
  onDeviceRevoked(callback: () => void): void {
    this.deviceRevokedCallback = callback;
  }

  /** Asks the server whether the named device is denylisted. `false` when the question cannot be reached. */
  isDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
    return this.delivery.isDeviceRevoked(userId, deviceId);
  }

  addBulkIngestObserver(observer: BulkIngestObserver): void {
    this.bulkIngestObservers.push(observer);
  }

  beginBulkIngest(phase: BulkIngestPhase = BaseMlsService.PERSIST_ONLY_PHASE): void {
    this.bulkIngestPhases.push(phase);
    for (const observer of this.bulkIngestObservers) {
      // Isolated for the same reason as the close below: one observer refusing to OPEN its window
      // must not stop the next from opening one it will be asked to close.
      try {
        observer.onBulkIngestStart(phase);
      } catch (e) {
        console.error('[QUEUE] bulk-ingest observer failed to start:', e);
      }
    }
  }

  async endBulkIngest(): Promise<void> {
    const phase = this.bulkIngestPhases.pop();
    if (!phase) {
      console.warn('[QUEUE] endBulkIngest without a matching beginBulkIngest - ignored');
      return;
    }
    // Replay the exact phase the matching open used: start and end can never disagree.
    //
    // PER OBSERVER, and that is the whole point. These are independent subscribers - the encrypted
    // state persister and the UI render buffer - and they were being awaited in one bare loop, so
    // the FIRST to reject cancelled every one after it. The persister is registered first and
    // rethrows when a checkpoint fails, which would have left the UI observer's window open
    // forever: `messageCatchupDepth` never comes back down (the sync banner stays up for the rest
    // of the session) and `bulkIngestActive` stays raised, so every later inbound message is
    // buffered instead of rendered and is then discarded by the next drain. A failed disk write
    // must cost a checkpoint, never the message pipeline.
    for (const observer of this.bulkIngestObservers) {
      try {
        await observer.onBulkIngestEnd(phase);
      } catch (e) {
        console.error('[QUEUE] bulk-ingest observer failed to end (window closed anyway):', e);
      }
    }
  }

  // ── Message queue ─────────────────────────────────────────────────────────

  /**
   * Settles when the offline backlog is being pulled from the server, or immediately when it is not.
   *
   * Covers the FETCH only, never the drain that follows it: {@link fetchPendingMessages} ends by
   * awaiting the barrier below, so a flag held across that tail would make the pull wait on itself.
   */
  private pendingPullInFlight: Promise<void> | null = null;

  /**
   * Settles when every acknowledgement this device has issued has actually reached the server.
   *
   * THE MIRROR OF {@link pendingPullInFlight}, closing the same overlap from the other side.
   * WP-DUPDELIVERY-1 deleted the one where a PULL raced the archive replay; this is the one where a
   * pull races THIS DEVICE'S OWN ACK, and it had no barrier at all because every ack site is
   * deliberately fire-and-forget - a drain must not wait on an HTTP round trip to finish.
   *
   * FIRE-AND-FORGET IS RIGHT; UNANNOUNCED IS NOT. The two are separable, and separating them is the
   * whole fix: the ack still returns immediately to its caller, and now says so here, so the one
   * path that must not overtake it can wait.
   *
   * THE RACE IS NOT INCIDENTAL - IT IS SCHEDULED. `onDrainEnd` acks the rows it just drained and,
   * in the SAME TICK, `refetchFramesLeftBehind` starts a pull (`void this.fetchPendingMessages()`)
   * whenever a Welcome landed. The server has not recorded the ack yet, so it lists those rows
   * again and the device meets its own frames a second time - `[QUEUE] delivery ... arrived twice -
   * the pull listed a row this device had already acknowledged`. Measured on four campaign rows
   * before it was fixed, and the population is what named it: it appears on TAB-3b, HEAL-REVOKE-2,
   * -3, -9 and HEAL-NEW-3, all of them a client with an EMPTY store draining a backlog - the state
   * with the most rows in flight to race - and NOT on HEAL-NEW-1, whose store is equally empty and
   * which has nobody online to deliver anything.
   *
   * CHAINED, NOT REPLACED. Acks are serialised behind one another so a second never overtakes a
   * first, which is what makes awaiting this a statement about ALL of them rather than the latest.
   *
   * AND CHAINING RATHER THAN `allSettled` CLOSES A SECOND, LATENT LOSS in the persisted-ack store.
   * `ackMessagesWithRetry` READS the ids a failed attempt left in sessionStorage, merges them into
   * its own payload, and CLEARS the store on success - a read-modify-write with no lock. Two acks in
   * flight together can interleave it: A exhausts its retries and persists `{x, a}`, B succeeds a
   * moment later and clears the store, and `a` - which only ever travelled in the request that
   * failed - is now acknowledged nowhere and remembered nowhere. Serialising the requests serialises
   * that read-modify-write with them, so the cheaper `allSettled` would have kept the ordering and
   * kept the bug.
   * It never rejects: a caller wanting the ORDERING must not be handed a transport failure to
   * swallow, and a FAILED ack is not a defect here - the server really does still hold those rows,
   * so a pull that lists them again is telling the truth and the log line is honest.
   */
  private ackInFlight: Promise<void> | null = null;

  /**
   * Acknowledges message ids and announces the request, so a pull can refuse to overtake it.
   *
   * Every ack in this class goes through here. Callers keep `void`-ing it - the drain must not wait
   * on a round trip - and the ordering is recovered by {@link fetchPendingMessages} awaiting
   * {@link ackInFlight} instead.
   *
   * @param messageIds the ids to acknowledge; EMPTY is meaningful - `ackMessagesWithRetry` merges
   *   the ids persisted by a failed earlier attempt, so an empty call is the flush of those.
   */
  private announceAck(messageIds: string[]): Promise<void> {
    const previous = this.ackInFlight;
    // WHOSE IDS THESE ARE, CAPTURED WHEN THEY ARE HANDED OVER RATHER THAN WHEN THEY ARE SENT.
    // `MlsDeliveryApi.ackMessages` reads `userId`/`deviceId` and mints its auth header at CALL time,
    // which is now inside a continuation that may run several seconds later - and acknowledging one
    // account's message ids under another's identity is precisely what `clearPersistedPendingAcks`
    // exists to prevent on logout. Chaining must not widen that window, so the chain checks.
    const issuedFor = this.userId;
    const sent = (async () => {
      await previous?.catch(() => {});
      if (this.userId !== issuedFor) {
        // NOT SILENT. Nothing is lost here - the server still holds these rows and the next pull
        // for the account that owns them lists them again - but a queue drained under one identity
        // and acknowledged under none is worth a line, and its RATE is the reading that matters.
        console.warn(
          `[ACK] ${messageIds.length} id(s) dropped: they were queued for ${issuedFor} and this` +
            ` service is now ${this.userId}. The rows stay on the server for that account's next pull`
        );
        // AND THEY ARE UNACKNOWLEDGED, which is the same fact a thrown ack records. Without this the
        // repeat these rows will provoke would be ACCUSED - the shape reserved for a pull that
        // overtook a landed ack - when the honest reading is that nothing ever acknowledged them.
        for (const id of messageIds) this.unacknowledged.add(id);
        return;
      }
      try {
        await this.delivery.ackMessages(messageIds);
        // One success covers every id a failed attempt had persisted, because the retry merged them
        // into this payload - so the whole set goes, not just the ids named here.
        this.unacknowledged.clear();
      } catch (e) {
        for (const id of messageIds) this.unacknowledged.add(id);
        throw e;
      }
    })();
    const settled = sent.catch(() => {});
    this.ackInFlight = settled;
    // Cleared only if nothing has chained behind it, so the chain cannot grow without end and a
    // later pull does not await an ack that landed minutes ago.
    void settled.then(() => {
      if (this.ackInFlight === settled) this.ackInFlight = null;
    });
    return sent;
  }

  /**
   * True while the LAST pull ran to completion - every page fetched, no transport failure.
   *
   * It is what lets {@link waitForMessageQueueIdle} state emptiness instead of idleness. Read
   * together with `isWsOpen()`, never alone: a socket that has since dropped means frames may have
   * been queued while this device was unreachable, and the pull that covers them is the reconnect's
   * (`initializeConnection` runs one immediately after every `connect`). Cleared at the start of
   * each pull, so a pull that failed half-way leaves it false and the next barrier pulls again.
   */
  private mailboxEmptiedByAPull = false;

  /**
   * The catch-up sessions currently open, in the order they opened.
   *
   * A LIST RATHER THAN A DEPTH, and the difference is what {@link waitForMessageQueueIdle} BRANCHES
   * on. A count says "somebody has one open", which is true of two situations whose handling is
   * opposite: a caller that opened one ITSELF and then waited for its own mailbox (a deadlock -
   * refuse it and name it), and a caller that merely ran BESIDE somebody else's session (not a
   * deadlock at all - wait, which is all the caller ever asked for). The guard used to refuse both,
   * so a routine connection edge lost the ordering guarantee it had taken the barrier to get.
   *
   * The group id is the discriminator, and it is already known at both openers - so it is carried
   * from there rather than re-derived: a barrier whose caller names the same group as an open
   * session is nested, a different group is concurrent. `openedAt` is diagnostic only; nothing
   * branches on it.
   */
  private openCatchUps: Array<{ groupId: string; openedAt: number }> = [];

  /** Open catch-up sessions. A depth rather than a flag: nothing guarantees only one at a time. */
  private catchUpDepth = 0;

  /** Pending while a catch-up is open; `null` when none is. */
  private catchUpGate: Promise<void> | null = null;

  /** Opens {@link catchUpGate}. Held only while `catchUpDepth > 0`. */
  private releaseCatchUpGate: (() => void) | null = null;

  /**
   * How many times the LIVE MLS client has been mutated by something other than a catch-up.
   *
   * Read at the snapshot and again at the swap: if it moved, the state about to be installed
   * predates a mutation the live client already made, and installing it would undo that mutation.
   * A COUNT rather than a flag because the swap has to compare two instants, not ask "recently?".
   */
  protected liveMutations = 0;

  /**
   * Records a mutation of the live MLS client made outside a catch-up.
   *
   * Called by the send path today, which is the only mutation that runs unserialised against a
   * catch-up: everything else goes through the drain, and the drain and the catch-up take the same
   * mutex, so they cannot overlap by construction.
   */
  protected noteLiveMutation(): void {
    this.liveMutations++;
  }

  /**
   * Marks a catch-up session as open, closing the gate every send waits on.
   *
   * THE THIRD ACTOR. Sequencing "drain, then history exchange" orders the two paths that READ this
   * device's store, and leaves the one that WRITES to it - a send - free to land anywhere. On web a
   * send during the window is then overwritten by the swap: measured 2026-08-14 across three runs of
   * MSG-1b, `sendsDuringWindow=1` produced a `LOST frame` twice and `sendsDuringWindow=0` produced
   * none, with the frame named on the LOST line being, byte for byte, the send that followed the
   * rewind. The victim is always the next send after the swap - usually the focused tab's read
   * watermark, which is why the loss looked for days like a property of silent frames.
   */
  protected beginCatchUp(groupId: string): void {
    this.openCatchUps.push({ groupId, openedAt: Date.now() });
    this.catchUpDepth++;
    if (this.catchUpDepth === 1) {
      this.catchUpGate = new Promise<void>((resolve) => {
        this.releaseCatchUpGate = resolve;
      });
    }
  }

  /**
   * Marks a catch-up session as closed, releasing every send waiting behind it.
   *
   * Removes the LAST entry for that group: sessions on one group nest LIFO, and an id that is not
   * there closes nothing rather than silently closing somebody else's.
   */
  protected endCatchUp(groupId: string): void {
    for (let i = this.openCatchUps.length - 1; i >= 0; i--) {
      if (this.openCatchUps[i].groupId === groupId) {
        this.openCatchUps.splice(i, 1);
        break;
      }
    }
    this.catchUpDepth = Math.max(0, this.catchUpDepth - 1);
    if (this.catchUpDepth === 0) {
      this.releaseCatchUpGate?.();
      this.releaseCatchUpGate = null;
      this.catchUpGate = null;
    }
  }

  /**
   * Resolves when no catch-up session is open.
   *
   * Awaited by the send path, and safe to await from anywhere a send happens today. The drain holds
   * the MLS mutex for each message and a catch-up holds it for its whole life, so no catch-up can be
   * open while a handler runs - a send raised from inside the pipeline therefore never waits here.
   * The one send raised from inside a replay (`reconcileGroup`, on an unreadable frame) is
   * fire-and-forget, so it settles after `finish` rather than blocking it.
   */
  async waitForCatchUpIdle(): Promise<void> {
    await this.catchUpGate;
  }

  /**
   * Resolves when this device's mailbox is EMPTY - nothing left to fetch, and nothing left to apply.
   *
   * BOTH HALVES, because either one alone answers a different question. `waitUntilIdle` says "I have
   * applied everything I received"; it says nothing about what is still sitting on the server, and
   * the backlog is pulled ONE PAGE AT A TIME (`fetchPendingMessages`). Between a drained page and the
   * next one landing, the scheduler is genuinely idle while the mailbox is genuinely full - measured
   * on A1 at 976 rows / 36 MB, which is many pages with real network gaps between them.
   *
   * Every caller of this barrier - the ask, the answer, the archive replay, the outbox flusher -
   * wants the second, stronger fact: a device that has not emptied its mailbox is not a reliable
   * source about its own history, and must neither ask for one nor describe what it holds.
   *
   * Sequential rather than a loop, and that is what makes it terminate: the pull is edge-driven (a
   * connection), so nothing starts a new one while the queue it filled is draining. A pull that DOES
   * begin later is a new edge, which re-triggers the reconciliation by itself.
   *
   * AND IT PULLS IF NOBODY ELSE HAS, which is the half this was missing and the docblock was already
   * claiming (WP-DUPDELIVERY-1). Waiting on `pendingPullInFlight` answers "has the pull that is
   * RUNNING finished" - so with no pull running and a full mailbox on the server, both halves
   * resolved instantly and the caller went on to read the archive with its own frames still queued.
   * Measured on prod 2026-08-15: an archive replay finished at 11:43:10, a pull started at
   * 11:43:12.889 on a connection edge, and the single row it returned was a frame the replay had
   * already read - `Duplicate delivery ... already read by the archive replay`. Every such line in
   * every capture says the archive won, and not one says live delivery, so this arm had never once
   * been the one that fired. The heal was the witness; the overlap is what had to go.
   *
   * The evidence for "empty" is a COMPLETED pull plus a socket still open (see
   * {@link mailboxEmptiedByAPull}), never a duration.
   */
  async waitForMessageQueueIdle(caller: string, catchUpGroupId: string | null): Promise<void> {
    /**
     * FROM INSIDE A CATCH-UP THIS BARRIER CANNOT RESOLVE, SO IT ACCUSES INSTEAD OF HANGING.
     *
     * A catch-up session holds the global MLS mutex for its whole life (`createDecryptSession` ->
     * {@link beginCatchUp}) and the drain needs that same non-reentrant mutex for every message. A
     * caller that opens one and then waits for its mailbox waits for a drain that cannot start:
     * both sides stop for good, and nothing in the client recovers without a reload.
     *
     * It is a deadlock in theory before it is one in practice, and it shipped once - 2026-08-15, the
     * archive replay took this barrier after opening its session. W2 opened a bulk ingest at
     * 14:58:44.612, the frame arrived 389 ms later, its drain nested to depth 2, and neither ever
     * finished; the server saw the other side of the same event as two frames unACKed and a
     * `PUSH_DEFERRED -> FCM fallback` on a browser with no push token.
     *
     * There is no legitimate caller here - the barrier's whole purpose is to be taken BEFORE the
     * session - so this is a defect report, not a degradation to absorb quietly. The responder legs
     * solve the same problem the other way, by DEFERRING past the drain rather than awaiting it
     * (`answerAfterMailboxDrained`), which is the shape to copy when a call site cannot know whether
     * it runs inside one.
     *
     * ONLY THE SESSION THIS STACK IS INSIDE IS A DEADLOCK, AND `catchUpGroupId` IS WHAT SAYS SO. A
     * session open elsewhere takes the same global mutex, so the drain is blocked there too - but it
     * is blocked by a stack that will release it on its own, and this barrier then merely waits
     * longer. Waiting is what the caller asked for; refusing is not.
     *
     * That distinction was carried in PROSE for a day and carried nothing: the caller string was
     * matched against the open group ids by substring, and not one of the seven call sites spells a
     * group id, so `NESTED` could not be printed in the field at all. Every real occurrence read
     * `CONCURRENT` - including the nesting this guard exists for - and the first one measured said
     * so on prod (MUT-2, 2026-08-16: "connection sync" and "outbox flush", 98 ms after a replay
     * opened a session on a group neither of them was about). The discriminator is a PARAMETER now,
     * passed from the call sites that already know it.
     *
     * `null` means the call site cannot be inside a session at all ("connection sync", "outbox
     * flush", "media send", and the legs deferred past the drain): each is raised by a connection
     * edge, a visibility change, a click or a microtask that owns nothing, so none can be the nested
     * case. A future call site that passes `null` from inside one would hang here rather than be
     * told - which is why the parameter is required rather than optional, and why this sentence
     * exists.
     *
     * A caller that names a group it does NOT own a session on is refused too, and that is the one
     * deliberate imprecision: the group is a proxy for "inside", not a proof of it. Refusing costs a
     * guarantee the ledger can still catch afterwards; waiting on a session that will never close
     * costs the client until it is reloaded, and that one shipped (W2, 2026-08-15).
     *
     * AS OF 2026-08-23 NO CALL SITE PASSES A GROUP, AND THAT IS THE CORRECT STATE RATHER THAN A
     * REGRESSION. The two that did read the parameter as "the group I am working on": `history.ts`
     * named the group whose session it was about to open on the NEXT statement, and
     * `historyReconcile.ts` named the group it was reconciling, reached from a `finally` that had
     * already awaited `session.finish()`. Neither can be inside a session, so neither ever
     * described a nesting - they described a CONCURRENT replay of the same group, which the arm
     * above then reported as an unresolvable deadlock and skipped. Found by GRP-7 on 2026-08-23,
     * where the skipped barrier is visible in the same report as the `[HISTORY_STATE] holds
     * something different` it caused.
     *
     * So the guard stands unfired, which is what a guard against a shape the code no longer has
     * should do - `createDecryptSession` is the only opener of a session, `history.ts` is its only
     * caller, and nothing reaches a barrier from inside it. A FUTURE caller that does, and passes
     * `null`, hangs here instead of being told: the last line it prints is the `debug` below,
     * naming it and the session it is waiting behind, which is what makes that hang diagnosable
     * rather than silent. Anything awaiting this barrier from inside a session must pass its group.
     */
    const nestedSession =
      catchUpGroupId !== null
        ? this.openCatchUps.find((s) => s.groupId === catchUpGroupId)
        : undefined;
    if (nestedSession) {
      const now = Date.now();
      const open = this.openCatchUps
        .map((s) => `${s.groupId} (${now - s.openedAt}ms ago)`)
        .join(', ');
      console.error(
        `[QUEUE] mailbox barrier awaited by "${caller}" for group ${catchUpGroupId} while a catch-up session` +
          ` on that same group has been open for ${now - nestedSession.openedAt}ms [${open}] - this can` +
          ' never resolve: the drain needs the MLS mutex that session holds for its whole life. Take the' +
          ' barrier BEFORE opening the session, or defer past the drain instead of awaiting it' +
          ' (`answerAfterMailboxDrained`). It was SKIPPED and the caller is proceeding against a mailbox' +
          ' that may not be empty.'
      );
      return;
    }
    /**
     * AND IT CANNOT RESOLVE BEFORE THERE IS ANYTHING TO DRAIN IT, EITHER.
     *
     * `processQueue` returns immediately while {@link messageCallback} is unset, so nothing empties
     * the buckets and `waitUntilIdle` has no way to fire - and this barrier PULLS, so awaiting it
     * without a consumer is what fills the queue it is then waiting on. The device stops mid-boot
     * with no socket, for ever, and the only visible trace is a `console.warn` about a callback.
     *
     * Measured on prod 2026-08-15: W2 held 2 frames queued since the deadlock earlier that day, and
     * every boot afterwards pulled them, hung inside the startup archive replay before
     * `setupMessageHandler`, and never reached tab leadership - no `[TAB] Leadership acquired`, no
     * `Connecting to Gateway...`, silence from 1 s onwards. W1, same bundle and same code with an
     * EMPTY server-side mailbox, booted normally: the backlog alone decided it.
     *
     * The order is fixed at the call site - the inbound pipeline is registered before anything can
     * replay an archive - so reaching this is a defect report, not a state to absorb. Skipping is
     * still strictly better than hanging: the caller reads an archive whose mailbox may not be
     * settled, which the shared-fingerprint ledger catches, and a duplicate is recoverable where a
     * client that never connects again is not.
     */
    if (!this.messageCallback) {
      console.error(
        `[QUEUE] mailbox barrier awaited by "${caller}" before the inbound pipeline was registered -` +
          ' nothing can drain the queue this barrier pulls into, so it can never resolve and it was' +
          ' SKIPPED. Register the message handler before any caller can take this barrier.'
      );
      return;
    }
    /**
     * A WAIT NOBODY CAN SEE CANNOT BE VERIFIED, and this one replaced a refusal that was loud.
     *
     * Every other session is now waited out rather than refused, which is correct and completely
     * silent - so the only evidence the fix works would have been the ABSENCE of the old line, and
     * an absence proves nothing about a branch that fires on 2 runs in 5. This states the wait
     * instead: which caller, how long, and whose session it was behind.
     *
     * It is `debug`, not `error`, because it is not a defect - it is the barrier doing its job while
     * something legitimately holds the mutex. It is rare by construction (only while a catch-up
     * overlaps a barrier, twice on a busy boot at most) and it explains a latency that would
     * otherwise have no account at all, which is the whole bar for keeping a line.
     */
    const behind = this.openCatchUps.map((s) => s.groupId);
    if (behind.length > 0) {
      /**
       * SAID BEFORE THE WAIT, NOT ONLY AFTER IT - because the one case this report is most needed
       * for is the wait that never ends, and a line printed on the far side of an `await` cannot
       * describe it. This used to be a single line after `settleBarrier()`: it accounted for the
       * latency perfectly and went completely silent on a hang, which is the state the guard above
       * exists to keep a caller out of and the state a FUTURE caller reaches by passing `null` from
       * inside a session. The last thing such a client now prints names it and names the session it
       * is stuck behind, which is the difference between a diagnosable hang and a dead tab.
       */
      console.debug(
        `[QUEUE] mailbox barrier for "${caller}" is waiting behind ${behind.length} catch-up` +
          ` session(s) on [${behind.join(', ')}] - not this caller's, so it is waited out rather` +
          ' than refused. If this is the last line from this client, the caller was inside one of' +
          ' those sessions and must pass its group id rather than null.'
      );
      const waitedFrom = Date.now();
      await this.settleBarrier();
      console.debug(
        `[QUEUE] mailbox barrier for "${caller}" waited ${Date.now() - waitedFrom}ms behind` +
          ` ${behind.length} catch-up session(s) on [${behind.join(', ')}] - not this caller's, so it` +
          ' was waited out rather than refused.'
      );
      return;
    }
    return this.settleBarrier();
  }

  /**
   * The barrier proper: pull if nobody has, then wait for the queue to be applied.
   *
   * Split out so the guards above can time it without repeating it - the two call sites must not be
   * able to drift apart, since one of them is what the other claims to have measured.
   */
  private settleBarrier(): Promise<void> {
    if (
      !this.pendingPullInFlight &&
      !(this.mailboxEmptiedByAPull && this.isWsOpen()) &&
      this.userId !== UNRESOLVED_USER_ID
    ) {
      // Ends by awaiting `settleMailbox` itself, so this is the whole barrier and not a step of it.
      return this.fetchPendingMessages().catch(() => {});
    }
    return this.settleMailbox();
  }

  /**
   * The wait alone: whatever pull is in flight has landed, and the scheduler has applied it.
   *
   * Split out of {@link waitForMessageQueueIdle} because {@link fetchPendingMessages} ends on it -
   * calling the full barrier there would have the pull wait on itself.
   */
  /** @inheritdoc */
  async waitForGroupQueueIdle(caller: string, groupId: string): Promise<void> {
    // THE PULL FIRST, exactly as the whole-mailbox barrier does it: a bucket that is empty because
    // nothing has been FETCHED yet is not a bucket that has nothing left. What this skips is the
    // other twenty-eight conversations' frames, not the round trip that lists our own.
    await this.pendingPullInFlight?.catch(() => {});
    // SILENT. A leg waiting for its own group's frames is the routine path and finishes in
    // milliseconds; a line announcing the wait, with nothing announcing its end, is half a story
    // printed once per conversation per answer. What a reader needs is the OUTCOME, and
    // `[HISTORY_REQ] ... diff with <them>` is it.
    await this.messageScheduler.waitUntilGroupIdle(groupId);
  }

  private async settleMailbox(): Promise<void> {
    await this.pendingPullInFlight?.catch(() => {});
    return this.messageScheduler.waitUntilIdle();
  }

  /** @inheritdoc */
  notifyConversationsRestored(): void {
    this.refetchFramesLeftBehind('absent-conversation', 'conversations restored');
  }

  /** @inheritdoc */
  notifyConversationAvailable(groupId: string): void {
    this.refetchFramesLeftBehind(
      'absent-conversation',
      `conversation ${groupId.slice(0, 8)}… now exists`,
      groupId
    );
  }

  /** Runs `fn` under the global MLS client mutex (shared with the drain and catch-up sessions). */
  runUnderMlsLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.messageScheduler.runUnderMlsLock(fn);
  }

  /**
   * WHAT A REPEATED DELIVERY MEANS, by the channel that offered the second copy and by what this
   * device already knew about the row. Four cells, four different findings, and only three of them
   * are explained by a crossing.
   *
   * Three are the SAME event seen from either side, and neither side is at fault: an acknowledgement
   * cannot land before a pull already in flight, so a row can be listed by the pull after the socket
   * delivered it, or delivered by the socket after the pull listed it. Both are ordinary at a
   * reconnect and both are healed here by not decrypting twice.
   *
   * THE FOURTH IS NOT A CROSSING AND IS THEREFORE LOUD. The socket publishes a frame ONCE, when the
   * delivery service accepts the message - it does not replay the queue on connect - so a live frame
   * for a row this device has already ACKNOWLEDGED is not this client losing a race with itself. It
   * is the same row published twice, and nothing here can fix that; the ack is repeated so the row
   * cannot be left pending, and the line accuses so the next occurrence is investigated rather than
   * absorbed. It has never been observed, which is exactly why it must not be printed at the same
   * level as the three that are routine.
   */
  private static readonly REPEAT_MEANS: Record<
    DeliveryChannel,
    Record<'queued' | 'done', { say: string; accuse: boolean }>
  > = {
    pull: {
      queued: {
        say:
          'the pull listed a row the socket had already handed in and this device has not drained' +
          ' yet - the ordinary crossing, and nothing is wrong',
        accuse: false,
      },
      done: {
        say:
          'the pull listed a row this device had already acknowledged, AND that acknowledgement had' +
          ' landed before the pull was issued - `fetchPendingMessages` awaits `ackInFlight`, so' +
          ' nothing routine explains this: either a pull was started outside that barrier, or the' +
          ' server answered without recording an ack it had accepted',
        accuse: true,
      },
    },
    live: {
      queued: {
        say:
          'the socket delivered a row the pull had already listed and this device has not drained' +
          ' yet - the ordinary crossing, seen from the other side',
        accuse: false,
      },
      done: {
        say:
          'THE SERVER PUBLISHED THE SAME ROW TWICE: a live frame arrived for a delivery this device' +
          ' had already acknowledged, and no crossing explains that - the socket publishes once, at' +
          ' send, and never replays the queue on connect',
        accuse: true,
      },
    },
  };

  /**
   * WHAT `pull:done` MEANS WHEN THE ACK NEVER GOT THROUGH, which is the only routine reading it has
   * left and the reason the entry above is allowed to accuse.
   *
   * A repeat has two possible causes and this device knows which one it is looking at, so it must
   * not classify by guessing: an ack that LANDED and a row that came back anyway is a defect, while
   * an ack that could not be delivered leaves the row genuinely owed, and the server listing it
   * again is correct behaviour. The discriminator is carried from {@link announceAck}, where it is
   * already known, rather than inferred from the repeat - and the finding in that case is the
   * `[ACK]` failure upstream, which already accuses. This line is its visible end, not a second
   * report of it.
   */
  private static readonly PULL_DONE_AFTER_A_FAILED_ACK = {
    say:
      'the pull listed a row whose acknowledgement never reached the server - it really is still' +
      ' owed, so this is the [ACK] failure above showing its consequence, not a delivery defect',
    accuse: false,
  };

  /**
   * The ids whose acknowledgement is known to have FAILED, so a repeat of one can be explained.
   *
   * Only ever holds the payload of the most recent unsuccessful ack: `ackMessagesWithRetry` merges
   * everything a failed attempt persisted into the next one, so one success covers all of them and
   * clears this. That is what bounds it without a cap.
   */
  private readonly unacknowledged = new Set<string>();

  /**
   * HOW OFTEN EACH REPEAT SHAPE HAPPENS, which is the reading the shape's SENTENCE cannot give.
   *
   * Two of the four are crossings nothing can prevent - two channels carry the same row and one is
   * always late - so their per-occurrence lines said the same true thing over and over, and what
   * decides anything is the rate.
   *
   * `pull:done` USED TO BE A THIRD, at one per send: the ordinary cost of a send under load,
   * measured 23/25 by FWD-2 on 2026-09-05. That measurement described a race that no longer exists
   * - the ack and the pull it was crossing are now ordered - so the shape has been re-read against
   * the population it will actually run on rather than kept on the reading that named the last
   * incident. What is left of it accuses, unless the ack is known to have failed.
   *
   * In the instance and not the module because two services can exist at once in a test.
   */
  private readonly repeats: Record<DeliveryRepeatShape, number> = {
    'pull:queued': 0,
    'pull:done': 0,
    'live:queued': 0,
    'live:done': 0,
  };

  /** The counters as a sentence, for the accusing line. Only shapes that happened are named. */
  private repeatSummary(): string {
    const seen = Object.entries(this.repeats).filter(([, n]) => n > 0);
    return seen.length ? seen.map(([k, n]) => `${k}=${n}`).join(' ') : 'none';
  }

  /**
   * What the repeat counters say right now.
   *
   * Exported through the instance rather than read off module state, so a test and a debug surface
   * ask the same question in the same way - the shape {@link displayNameLookupStats} established.
   */
  deliveryRepeatStats(): Record<DeliveryRepeatShape, number> {
    return { ...this.repeats };
  }

  /** Enqueues a message and starts the per-group fair drain loop if idle. */
  /**
   * True when this delivery has never been taken in, so it may enter the queue.
   *
   * A frame with NO queue id is always admitted: it is a live socket frame the server never
   * persisted, there is nothing to acknowledge and nothing can re-offer it, so there is no second
   * copy to recognise. See {@link deliveries} for the race this closes and for why a repeat of an
   * acknowledged row is acknowledged again instead of dropped.
   *
   * @param channel which side offered this copy - see {@link REPEAT_MEANS} for what each of the
   *   four combinations of channel and prior state actually says.
   */
  private admitDelivery(queuedMessageId: string | undefined, channel: DeliveryChannel): boolean {
    if (!queuedMessageId) return true;
    const known = this.deliveries.get(queuedMessageId);
    if (!known) {
      this.rememberDelivery(queuedMessageId, 'queued');
      return true;
    }
    // NOT A FALLBACK AND NOT SILENT, and no longer a guess: this used to report "the live frame and
    // the pull crossed" whichever way round it had happened, which is why a repeat could never be
    // triaged from a log. Its RATE is still the reading that matters - many of these for one group
    // is a pull firing on something other than an event - but the SHAPE is what says whose defect
    // it would be, and the shape is now named.
    // THE DISCRIMINATOR IS CARRIED, NOT GUESSED. Only this instance knows whether the ack for this
    // row got through, and that is exactly what separates a defect from a consequence.
    const meaning =
      channel === 'pull' && known === 'done' && this.unacknowledged.has(queuedMessageId)
        ? BaseMlsService.PULL_DONE_AFTER_A_FAILED_ACK
        : BaseMlsService.REPEAT_MEANS[channel][known];
    const shape = `${channel}:${known}` as DeliveryRepeatShape;
    this.repeats[shape] += 1;
    const line =
      `[QUEUE] delivery ${queuedMessageId.slice(0, 8)}... arrived twice - ${meaning.say};` +
      ` not decrypting it again` +
      (known === 'done' ? ', acknowledging it once more' : '');
    // A RATE IS NOT READ ONE LINE AT A TIME, and this comment used to say so while the code printed
    // one line at a time anyway. FWD-2 measured it on 2026-09-05: twenty-five forwards back to back,
    // and `pull:done` - the ack still in flight when the pull was answered - fired in TWENTY-THREE
    // of them. That is not a race, it is what a send costs under load; a reader learns to skip it,
    // and the line it hides next is the one that mattered.
    //
    // SO THE ROUTINE SHAPES EXPLAIN THEMSELVES ONCE AND ARE COUNTED AFTERWARDS. Not demoted - a
    // `debug` line is still a line, and the first occurrence still says the whole sentence. The
    // count is what answers the question the sentence cannot ("is this every send, or one in
    // three hundred"), it rides on the accusation below where a reader is already looking, and
    // {@link deliveryRepeatStats} hands it to a test and a debug surface without either reaching
    // into module state.
    if (meaning.accuse) {
      console.warn(`${line} [repeats so far: ${this.repeatSummary()}]`);
    } else if (this.repeats[shape] === 1) {
      console.log(`${line}. Further ones of this shape are counted, not printed`);
    }
    if (known === 'done') {
      void this.announceAck([queuedMessageId]).catch((e) =>
        console.warn('[ACK] re-ack of a repeated delivery failed:', e)
      );
    }
    return false;
  }

  /**
   * Records what the drain decided about a delivery: acknowledged, or owed a re-delivery.
   *
   * @param acked whether this drain acknowledged the row. False FORGETS it, because an unacked row
   *   is one the server must be able to hand back - see {@link deliveries}.
   */
  private settleDelivery(queuedMessageId: string | undefined, acked: boolean): void {
    if (!queuedMessageId) return;
    if (acked) this.rememberDelivery(queuedMessageId, 'done');
    else this.deliveries.delete(queuedMessageId);
  }

  /**
   * Remembers one delivery, evicting the oldest entry past {@link DELIVERY_MEMORY}.
   *
   * BOUNDED BECAUSE A SESSION IS NOT. The window a repeat can arrive in is one boot - a pull already
   * in flight against an ack already sent - so a few hundred entries covers it many times over, and
   * the cost of an eviction is that a repeat of a very old row is decrypted twice and acknowledged,
   * which is exactly what happened before this map existed. Insertion order is the eviction order:
   * a `Map`'s first key is its oldest, and a re-`set` of a known id is a state change, not a
   * refresh, so nothing here can keep an entry alive by touching it.
   */
  private rememberDelivery(queuedMessageId: string, state: 'queued' | 'done'): void {
    this.deliveries.set(queuedMessageId, state);
    while (this.deliveries.size > BaseMlsService.DELIVERY_MEMORY) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }
  }

  /**
   * @param channel which side handed this delivery in. REQUIRED, and required here rather than on
   *   {@link MlsQueuedMessage}: it is a fact about the ARRIVAL, not about the message, and the same
   *   row can arrive twice by two different routes - which is the only thing {@link admitDelivery}
   *   cannot work out for itself.
   */
  protected enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void {
    if (!this.admitDelivery(msg.queuedMessageId, channel)) return;
    this.messageScheduler.enqueue(msg);
    if (!this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Re-fetches the delivery queue because the thing that was blocking `reason` has just happened.
   *
   * THIS REPLACED A 15-SECOND TIMER, and the difference is the whole point. The handler leaves a
   * frame unacknowledged for exactly two reasons, and neither of them is discharged by waiting: an
   * unknown group needs its Welcome, an absent conversation needs the local store restore. A clock
   * asking again every fifteen seconds re-fetched the same rows, failed them the same way, and
   * re-opened the catch-up overlay on every cycle - for the whole session, on a device whose group
   * never came back. So the ask is now driven by the EVENT that changes the answer, and there is no
   * cycle to bound: no event, no ask.
   *
   * Silent and free when nothing is waiting, so callers may fire it on any occurrence of the event.
   */
  protected refetchFramesLeftBehind(
    reason: UnackedReason,
    trigger: string,
    /**
     * One group, when the event that discharges the wait is per-group rather than global.
     *
     * ONE IMPLEMENTATION, because the two callers differ only in WHICH entries they take: everything
     * after that - the socket check, the line, the pull - is identical, and a second copy is how the
     * two would drift into disagreeing about whether a closed socket still owes a re-fetch.
     */
    groupId?: string
  ): void {
    const groups = groupId
      ? takeGroupAwaiting(reason, groupId)
        ? [groupId]
        : []
      : takeGroupsAwaiting(reason);
    if (groups.length === 0) return;
    if (!this.isWsOpen()) {
      // Nothing to re-fetch over: the reconnect runs a pull of its own, and the handler will note
      // whatever still fails. Dropping the note here is safe for the same reason `take` is.
      console.log(`[QUEUE] ${trigger}: socket closed, the reconnect pull covers it`);
      return;
    }
    console.log(
      `[QUEUE] ${trigger}: re-fetching for ${groups.length} group(s) left behind as ${reason} [${groups
        .map((g) => g.slice(0, 8))
        .join(', ')}]`
    );
    void this.fetchPendingMessages();
  }

  /** Drains per-group queues with round-robin scheduling and a global MLS mutex. */
  protected async processQueue(): Promise<void> {
    if (!this.messageCallback) {
      // A frame reached the queue before the pipeline that consumes it existed. Nothing here can
      // drain it, and anything already waiting on `waitUntilIdle` is waiting for good - so this is
      // an error, not a notice: the inbound pipeline is registered during boot BEFORE any path that
      // can pull or receive, and a line here means that order was broken.
      console.error(
        `[QUEUE] messageCallback not set - ${this.messageScheduler.getPendingCount()} queued message(s)` +
          ' cannot be processed and every mailbox barrier now open will never resolve'
      );
      return;
    }

    const ackIds: string[] = [];
    /** Groups whose Welcome landed in this drain: the one event that unblocks an unknown group. */
    const welcomedGroups: string[] = [];

    await this.messageScheduler.drain(
      async (msg) => {
        const groupId = msg.groupId;
        recordQueueDrainMessage(groupId);

        // group_reset control messages: ACK and ignore on both platforms.
        // The WebSocket reconnect is sufficient to re-sync state.
        if (msg.type === 'group_reset') {
          console.log(`[QUEUE] group_reset (control) ignored - group=${groupId ?? 'unknown'}`);
          const ackedReset = shouldAckGroupResetControl({
            hasQueuedId: Boolean(msg.queuedMessageId),
          });
          if (ackedReset) ackIds.push(msg.queuedMessageId!);
          this.settleDelivery(msg.queuedMessageId, ackedReset);
          return;
        }

        try {
          console.log(
            `[QUEUE] Processing ${msg.isWelcome ? 'Welcome' : msg.isCommit ? 'Commit' : 'message'} group=${groupId ?? 'unknown'} sender=${msg.senderId}${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const deliveryMeta: IncomingDeliveryMeta | undefined =
            msg.queuedCreatedAt !== undefined || msg.queuedMessageId
              ? {
                  ...(msg.queuedCreatedAt !== undefined
                    ? { queuedCreatedAt: msg.queuedCreatedAt }
                    : {}),
                  ...(msg.queuedMessageId ? { queuedMessageId: msg.queuedMessageId } : {}),
                }
              : undefined;

          // The stuck-callback watchdog that used to sit here is gone, and it is not lost: it
          // covered ONE of the four awaits that can freeze the drain, and `MlsPerGroupScheduler`
          // now guards every one of them - including this callback, which it invokes as
          // `processMessage`. Two watchdogs for one await would have reported the same freeze
          // twice and still said nothing about the other three.
          const cbResult = await this.messageCallback!(
            msg.senderId,
            msg.ciphertext,
            msg.groupId,
            msg.isWelcome,
            msg.ratchetTreeBytes,
            msg.isCommit,
            deliveryMeta
          );

          console.log(
            `[QUEUE] messageCallback → ${cbResult} (group=${groupId ?? 'unknown'})${msg.queuedMessageId ? ` qId=${msg.queuedMessageId}` : ''}`
          );

          const flags = {
            isWelcome: msg.isWelcome,
            isCommit: msg.isCommit,
            hasQueuedId: Boolean(msg.queuedMessageId),
          };
          const acked = shouldAckAfterSuccess(cbResult, flags) && !!msg.queuedMessageId;
          this.settleDelivery(msg.queuedMessageId, acked);
          if (acked) {
            ackIds.push(msg.queuedMessageId!);
          } else if (flags.hasQueuedId && cbResult === false) {
            // The handler already recorded WHY, against the group, in `unackedFrames`. Nothing to
            // note here: what discharges it is an event, not this drain ending.
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'callback_retry',
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
            });
          }

          if (msg.isWelcome && groupId) {
            this.messageScheduler.releaseWelcomeBuffer(groupId, 'Welcome complete');
            this.welcomeProcessedCallback?.(groupId);
            welcomedGroups.push(groupId);
          }

          // Platform hook: called after each successful message (e.g. Tauri epoch cache refresh).
          await this.onMessageProcessed(groupId);
        } catch (e) {
          console.error(`[QUEUE] Error processing message:`, e);

          if (msg.isWelcome) {
            logMlsMetric({
              kind: 'queue_skip_ack',
              platform: this.platform,
              reason: 'welcome_error',
            });
            console.error(
              `[QUEUE] Welcome failed for group=${groupId} - NOT ACKed, retry on reconnect`
            );
            // FORGOTTEN, so "retry on reconnect" stays true. The row was not acknowledged, so the
            // server will offer it again, and an id still remembered here would make the pull that
            // re-offers it drop the frame instead of retrying it.
            this.settleDelivery(msg.queuedMessageId, false);
            // The window closes either way, and what it held is RE-QUEUED rather than dropped.
            // Dropping assumed the server would re-deliver, which is true only of a frame carrying
            // a `queuedMessageId`; a live WebSocket frame need not carry one. Re-queued, the group
            // is still unknown, so the handler records it against that group and the Welcome that
            // eventually lands re-fetches it - the seam that exists for exactly this.
            if (groupId) this.messageScheduler.releaseWelcomeBuffer(groupId, 'Welcome failed');
          } else {
            const exFlags = {
              isWelcome: msg.isWelcome,
              isCommit: msg.isCommit,
              hasQueuedId: Boolean(msg.queuedMessageId),
            };
            const ackedAfterThrow = shouldAckAfterException(exFlags) && !!msg.queuedMessageId;
            this.settleDelivery(msg.queuedMessageId, ackedAfterThrow);
            if (ackedAfterThrow) {
              ackIds.push(msg.queuedMessageId!);
            } else if (exFlags.hasQueuedId) {
              logMlsMetric({
                kind: 'queue_skip_ack',
                platform: this.platform,
                reason: 'exception_non_commit',
                isWelcome: msg.isWelcome,
                isCommit: msg.isCommit,
              });
            }
            // A throwing NON-Welcome used to close the group's Welcome window here, which is the
            // one path that could close a window its Welcome had not opened and would not close.
            // It is gone: the window now belongs to the Welcome from end to end, which is what
            // makes `releaseStrandedWelcomeBuffers` an invariant rather than one case among
            // several. Nothing is left open by dropping it - this branch could only be reached
            // while the Welcome was still queued, so that Welcome closes the window itself.
          }
        }
      },
      {
        onDrainStart: (pendingCount) => {
          beginQueueDrainBench(pendingCount);
          // Live drain: buffer decrypted messages for one grouped UI flush; show the overlay
          // only for a multi-message catch-up. endBulkIngest replays this exact phase.
          this.beginBulkIngest({ bufferUi: true, showOverlay: pendingCount > 1 });
        },
        onDrainEnd: async () => {
          if (ackIds.length > 0) {
            logMlsMetric({ kind: 'queue_ack', platform: this.platform, count: ackIds.length });
            // ANNOUNCED, still not awaited: the drain must not block on a round trip, and the
            // pull `refetchFramesLeftBehind` starts a few lines below must not overtake it.
            void this.announceAck(ackIds).catch((e) => console.warn('[ACK] drain ack failed:', e));
          }

          // A Welcome landing is the proof that frames buffered for an unknown group can now be
          // read. `releaseWelcomeBuffer` replays the ones this session buffered in memory; this
          // asks the server for the ones it left unacknowledged in earlier drains.
          if (welcomedGroups.length > 0) {
            this.refetchFramesLeftBehind('unknown-group', 'welcome processed');
          }

          finishQueueDrainBench(ackIds.length);
          await this.endBulkIngest();
        },
      }
    );

    // Messages that arrived via WebSocket while onDrainEnd was awaiting (draining=true)
    // were enqueued but could not start a new drain. Restart here so they are not stuck.
    if (this.messageScheduler.getPendingCount() > 0 && !this.messageScheduler.draining) {
      void this.processQueue();
    }
  }

  /**
   * Platform hook called after each successfully processed message.
   * Override in subclasses to perform platform-specific post-processing
   * (e.g. refreshing epoch cache on Tauri).
   */
  protected async onMessageProcessed(_groupId: string | undefined): Promise<void> {}

  /**
   * Fetches offline-queued messages from the delivery service and routes each through the priority
   * queue, ONE PAGE AT A TIME: a page is enqueued (and so, later, ACKed) as soon as it lands, so a
   * pull that dies half-way still shrinks the backlog. Draining the whole queue behind a single
   * deadline was WP-PENDING-1 - a device far enough behind aborted on every reconnect, ACKed
   * nothing, and its backlog grew forever.
   */
  async fetchPendingMessages(): Promise<void> {
    if (this.userId === UNRESOLVED_USER_ID) return;

    // Cleared here rather than on failure: what the barrier may trust is a pull that finished, and
    // this one has not started. A pull that dies half-way therefore leaves it false.
    this.mailboxEmptiedByAPull = false;

    // A PULL MUST NOT RACE THIS DEVICE'S OWN ACKNOWLEDGEMENT, and this line used to start one that
    // did: `void`, so the flush of any persisted ack was still in the air when the server answered,
    // and so was the drain's ack when `refetchFramesLeftBehind` called straight back in here.
    // Awaiting it is an ORDERING, not a timeout - it resolves the moment the acks land, or once
    // their retries are exhausted, and in that second case the rows really are still owed.
    await this.announceAck([]).catch(() => {});

    let fetched = 0;

    /**
     * ANNOUNCED WHILE IT RUNS, so the barrier can state a fact about the whole mailbox rather than
     * about whichever pages happen to have landed. Never rejects - every failure is handled below -
     * so nothing waiting on it can be left hanging by a transport error.
     */
    const pull = (async () => {
      try {
        // The per-page silence deadline is the delivery API's own (`PENDING_PAGE_STALL_MS`): it is a
        // property of that request, and a second copy here is a second number to keep true.
        await this.delivery.pullPendingMessagesJson({
          onPage: (rows) => {
            fetched += rows.length;
            recordPendingMessagesFetched(rows.length);
            console.log(`[PENDING] Fetched ${rows.length} pending messages (${fetched} so far)`);
            this.enqueuePendingRows(rows as Record<string, unknown>[]);
          },
        });
        // Every page fetched and enqueued: the server holds nothing more for this device, which is
        // the fact the barrier is allowed to stand on.
        this.mailboxEmptiedByAPull = true;
        if (fetched === 0) {
          console.log(`[PENDING] No pending MLS messages for ${this.userId}:${this.deviceId}`);
        }
      } catch (e) {
        // Partial progress is still progress, and saying so is the difference between "the pull
        // failed" and "the pull failed after draining 4 pages" - the second is what proves the
        // backlog is shrinking across attempts.
        //
        // NAME THE CONSEQUENCE, not just the failure. A transport failure is not an answer: reaching
        // here means this device's offline backlog is still on the server and nothing here will go
        // back for it - the next reconnect's pull is what covers it. Read as "fetch failed", the line
        // sat in production logs beside a queue that had not shrunk in weeks and nobody connected the
        // two. `pullPendingMessagesJson` has already halved its page size down to a single row before
        // giving up, so this is a genuine transport failure rather than an answer too big to arrive.
        console.error(
          `[PENDING] Pending fetch failed after ${fetched} message(s) - the backlog for ${this.userId}:${this.deviceId} is UNDRAINED and stays queued until the next reconnect:`,
          e
        );
      }
    })();
    this.pendingPullInFlight = pull;
    try {
      await pull;
    } finally {
      // CLEARED BEFORE THE BARRIER, deliberately: the line below is that barrier, and a pull still
      // announcing itself here would be waiting on its own completion.
      this.pendingPullInFlight = null;
    }
    await this.settleMailbox();
    // Only now is the answer complete: the rows were enqueued, not handled, so what the handler
    // refused to acknowledge is known only once the queue has drained. Without this, a device that
    // re-fetches the same backlog on every reconnect reports a perfectly healthy pull each time.
    reportUnackedFrames((msg) => console.warn(msg));
  }

  /**
   * Routes one page of raw pending rows through the serialized queue, so they never race with live
   * WebSocket messages calling messageCallback.
   *
   * **A ROW THIS DROPS IS NEVER ACKED, SO IT IS DRAINED AGAIN FOR EVER.** Only what reaches
   * `enqueueMessage` can ever be acknowledged: anything the loop passes over stays in
   * `queued_message` until the 90-day retention, is re-fetched on every reconnect, and makes the
   * backlog a number that only ever grows. That is invisible from the outside - a pull that returns
   * 500 rows and acknowledges none looks exactly like a pull that had nothing to do - so the rows
   * are COUNTED and NAMED here, with their two causes kept apart because they call for opposite
   * fixes: a payload that is absent or empty is a producer writing a row it never filled, while one
   * that fails to decode is a corrupt or truncated write.
   */
  private enqueuePendingRows(rows: Record<string, unknown>[]): void {
    /** Rows this page will not acknowledge, by cause. Bounded by the page size, so keeping ids is cheap. */
    const undeliverable: { empty: string[]; malformed: string[] } = { empty: [], malformed: [] };

    for (const msg of rows) {
      const msgId = (msg.id || msg._id) as string | undefined;
      const queuedCreatedAt = parseServerTimestampMs(msg.createdAt);
      const proto: string | undefined = typeof msg.proto === 'string' ? msg.proto : undefined;

      // ── Control messages (group_reset persisted for offline devices) ──
      // These have no MLS payload (empty proto). Both platforms ACK and ignore:
      // WebSocket reconnect is sufficient to re-sync state.
      if (msg.type === 'group_reset') {
        this.enqueueMessage(
          {
            senderId: (msg.senderId as string) || 'unknown',
            ciphertext: new Uint8Array(0),
            groupId: (msg.groupId as string) || undefined,
            isWelcome: false,
            isCommit: false,
            queuedMessageId: msgId,
            type: 'group_reset',
            queuedCreatedAt,
          },
          'pull'
        );
        continue;
      }

      if (proto) {
        try {
          const ciphertext = fromBase64(proto);
          if (ciphertext.length > 0) {
            this.enqueueMessage(
              {
                senderId: (msg.senderId as string) || 'unknown',
                ciphertext,
                groupId: (msg.groupId as string) || undefined,
                isWelcome: msg.isWelcome === true,
                isCommit: msg.isCommit === true,
                ratchetTreeBytes:
                  typeof msg.ratchetTree === 'string' && msg.ratchetTree.length > 0
                    ? fromBase64(msg.ratchetTree as string)
                    : undefined,
                queuedMessageId: msgId,
                queuedCreatedAt,
              },
              'pull'
            );
            continue;
          }
        } catch (e) {
          console.error('[PENDING] Failed to enqueue proto message:', e);
          undeliverable.malformed.push(msgId ?? '(no id)');
          continue;
        }
      }
      // Reached only by a row carrying no usable payload: no `proto` at all, or one that decoded to
      // zero bytes. Nothing was enqueued, so nothing will ACK it.
      undeliverable.empty.push(msgId ?? '(no id)');
    }

    const stuck = undeliverable.empty.length + undeliverable.malformed.length;
    if (stuck > 0) {
      const sample = (ids: string[]) =>
        ids.slice(0, 5).join(', ') + (ids.length > 5 ? ', ...' : '');
      console.warn(
        `[PENDING] ${stuck}/${rows.length} row(s) of this page cannot be delivered and will NOT be acknowledged - they will be re-fetched on every reconnect until the retention window expires. ` +
          `empty payload: ${undeliverable.empty.length}${undeliverable.empty.length ? ` [${sample(undeliverable.empty)}]` : ''}; ` +
          `undecodable payload: ${undeliverable.malformed.length}${undeliverable.malformed.length ? ` [${sample(undeliverable.malformed)}]` : ''}`
      );
    }
  }

  // ── Delivery wrappers ─────────────────────────────────────────────────────
  // All methods below are pure pass-throughs to this.delivery. Both Web and Tauri
  // implementations were 100% identical, so they live here once.

  /** Announces to group members that this device needs a Welcome. */
  async sendWelcomeRequest(groupId: string): Promise<void> {
    await this.delivery.deliveryPost('welcome-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
  }

  /**
   * Asks one online member to REPUBLISH this group's external-join base, and asks for nothing else.
   *
   * THE FAVOUR THAT MATCHES THE REFUSAL. `externalJoin` answers `stale_base` when the published
   * GroupInfo names an epoch the group has left: no retry can ever satisfy it, because only a member
   * holding the tree can mint a new one. Until 2026-09-04 that refusal fell into the shared
   * `sendWelcomeRequest` fallback, which asks for something far more expensive and entirely
   * different - a Welcome MUTATES the tree, takes the group's add lock and replays the
   * duplicate-leaf race, where a refresh is a read-only publish that changes no epoch and takes no
   * lock. Measured on production the same day: four of the forty-three groups holding a base were
   * stale, all by exactly one epoch, two of them since 2026-08-30 with three devices sitting
   * `pending` on them - a stale base does not drain itself, because only a member's next commit
   * republishes one and a quiet conversation has none.
   *
   * Best-effort by construction: the requester keeps its own cadence and asks again while it still
   * cannot join, so nothing here is retried and nothing is stored for an offline member.
   */
  async sendBaseRefreshRequest(groupId: string): Promise<void> {
    await this.delivery.deliveryPost('base-refresh-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
    });
  }

  /**
   * Asks the server to elect ONE online member to reconcile `groupId` with us. What we want is
   * stated separately, inside MLS, so this frame carries nothing about the conversation's contents.
   *
   * The server elects the responder, so it alone knows whether there was one, and it says so:
   * `noPeerOnline` reports that answer. It is true ONLY on an explicit `no_peer_online` - a request
   * that failed to reach the server, or answered something unparseable, proves nothing about who is
   * reachable, and concluding "nobody" from it would abandon a reconciliation on a dropped packet.
   *
   * `exclude` names the members we have already heard from, so a requester chasing a coverage gap
   * walks its members instead of re-drawing the one that already told us it cannot help.
   */
  async sendHistoryRequest(
    groupId: string,
    opts: { exclude?: string[] } = {}
  ): Promise<HistoryRequestOutcome> {
    const answer = await this.delivery.deliveryPost('history-request', {
      groupId,
      requesterUserId: this.userId,
      requesterDeviceId: this.deviceId,
      ...(opts.exclude?.length ? { exclude: opts.exclude } : {}),
    });
    const excludedOnline = Number(answer?.excludedOnline);
    return {
      noPeerOnline: answer?.status === 'no_peer_online',
      target: typeof answer?.target === 'string' ? answer.target : undefined,
      // A server too old to count says nothing, and 0 is what "nothing was skipped" means - which is
      // also the reading that makes a chase keep looking rather than claim a proof it was not given.
      excludedOnline: Number.isFinite(excludedOnline) && excludedOnline > 0 ? excludedOnline : 0,
    };
  }

  /** Delivers a Welcome message to the target user/device. */
  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array
  ): Promise<void> {
    return this.delivery.sendWelcome(
      welcomeBytes,
      targetUserId,
      groupId,
      targetDeviceId,
      ratchetTreeBytes
    );
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Whether this device's id pre-existed this boot, and so whether an MLS state SHOULD be found
   * beside it.
   *
   * Read by the WASM-backed implementation and handed to the client constructor, which otherwise
   * cannot tell a first enrolment from a device that lost its snapshot - both reach it as a device
   * key with no state. `false` is the safe default: it is what a service that has not resolved an
   * id is entitled to claim, and it accuses nothing.
   *
   * Set by {@link resolveDeviceId} (found an id / minted one) and cleared by
   * {@link rotateDeviceIdentity}, which mints a new identity deliberately.
   */
  protected stateWasExpected = false;

  /**
   * Resolves (or generates and persists) this device's stable per-user id WITHOUT
   * touching the encrypted MLS state. Safe to call before {@link init}, so the PIN
   * can be verified against the real deviceId before any state decryption /
   * fresh-start can run - a wrong PIN must never delete/revoke the device.
   *
   * Resolution order: in-memory (already resolved) → localStorage → native restore
   * (Tauri push context) → freshly generated. The result is cached on the instance
   * and mirrored to the delivery client, so the subsequent {@link init} reuses it.
   */
  async resolveDeviceId(userId: string): Promise<string> {
    if (this.deviceId && this.deviceId !== UNRESOLVED_DEVICE_ID) return this.deviceId;
    const deviceKey = `mls_device_id_${userId}`;
    const stored = localStorage.getItem(deviceKey);
    let resolved = stored;
    if (!resolved) {
      const restored = await this.restoreDeviceIdFromNative(userId);
      // A NATIVE RESTORE COUNTS AS PRE-EXISTING, which is the whole point of that path: it hands
      // back the id of a device that was already enrolled and whose WebView stores were evicted
      // from under it, so a state missing THERE is a state that was lost. A factory wipe does not
      // reach this branch - it clears the native app data too, so the id below is minted instead.
      this.stateWasExpected = restored !== null;
      resolved = restored ?? this.generateDeviceId(userId);
      localStorage.setItem(deviceKey, resolved);
    } else {
      this.stateWasExpected = true;
    }
    this.deviceId = resolved;
    this.delivery.deviceId = resolved;
    return resolved;
  }

  /**
   * Generates and publishes this device's key packages, re-enrolling under a fresh id when the
   * server answers that this one is revoked.
   *
   * A revoked id is denylisted for good and `resolveDeviceId` deliberately hands the same id back
   * after a reinstall, so retrying it is futile: the only way forward is to become a new device.
   * Retried exactly once - a second refusal is a server bug, not a state to keep rotating through.
   */
  async generateKeyPackage(deviceKeyB64: string): Promise<Uint8Array> {
    try {
      return await this.generateKeyPackageImpl(deviceKeyB64);
    } catch (e) {
      if (!(e instanceof DeviceRevokedError)) throw e;
      const abandoned = await this.rotateDeviceIdentity(deviceKeyB64, 'revoked server-side');
      console.warn(`[MLS] Device ${abandoned} was revoked - re-enrolled as ${this.deviceId}`);
      return this.generateKeyPackageImpl(deviceKeyB64);
    }
  }

  /**
   * Abandons this device's identity and starts over under a freshly generated id: the MLS
   * credential is `userId:deviceId`, so a new id IS a new device and the old state can only be
   * discarded. Used for a credential mismatch (the state names someone else) and for a server-side
   * revocation (the id is denylisted and no retry can lift it).
   *
   * Order matters: the fresh state is persisted under the new id BEFORE anything else may fail.
   * Leaving a new id in localStorage next to the old blob is what made the churn self-sustaining -
   * every launch mismatched again and minted yet another device.
   *
   * @returns the id that was abandoned, for the caller to log.
   */
  protected async rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string> {
    const oldDeviceId = this.deviceId;
    console.warn(`[MLS] Rotating device identity (${reason}), abandoning ${oldDeviceId}`);
    this.deviceId = this.generateDeviceId(this.userId);
    localStorage.setItem(`mls_device_id_${this.userId}`, this.deviceId);
    this.delivery.deviceId = this.deviceId;
    // A brand new identity has never held a state, and the load below deliberately passes none.
    // Left true, the abandonment of a device would report itself as a loss.
    this.stateWasExpected = false;
    // The counters describe the ratchets of the device being abandoned, whose state is about to be
    // discarded for a fresh one starting at generation zero. Carried over, they would burn against
    // sends that, from the peers' side, this device has never made.
    resetSendRatchetLedger(this.userId);
    await this.loadStateWithKey(deviceKeyB64, undefined);
    await this.persistCheckpoint(deviceKeyB64);
    // Deregister the abandoned device so other members stop generating Welcomes for a key package
    // our fresh state no longer holds (NoMatchingKeyPackage). Best-effort: a revoked id is already
    // gone server-side, and a mismatch must not block on the network.
    this.deleteDevice(this.userId, oldDeviceId).catch((err) =>
      console.warn(`[MLS] Cleanup old device ${oldDeviceId} failed:`, err)
    );
    return oldDeviceId;
  }

  /**
   * Platform hook: restore a previously-used device id from native storage when
   * localStorage was cleared (Tauri reads push_context.json to avoid a credential
   * mismatch after a WebView eviction / reinstall). Web has no native store → null.
   */
  protected async restoreDeviceIdFromNative(_userId: string): Promise<string | null> {
    return null;
  }

  /** Generates a fresh, unique per-user device id prefixed with the platform tag. */
  protected generateDeviceId(userId: string): string {
    return `${this.platform}-${userId}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  }

  async fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  > {
    return this.delivery.fetchUserDevices(userId);
  }

  /**
   * Deletes every published one-time prekey, then regenerates the key material (static
   * fallback + pool) from the current local keystore via {@link generateKeyPackage}. Guarantees
   * that no published KeyPackage references a private key missing locally - the root of the
   * `NoMatchingKeyPackage` loop.
   *
   * Debounces close-together calls (<= 30 s): several groups can fail at the same time, but a
   * single purge/regeneration (expensive, up to 50 KeyPackages) is enough to reconcile all
   * published material.
   */
  async republishKeyMaterial(deviceKeyB64: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastKeyMaterialRepublish < 30_000) return;
    this.lastKeyMaterialRepublish = now;
    await this.delivery.deleteAllOneTimePrekeys();
    await this.generateKeyPackage(deviceKeyB64);
  }

  /**
   * Validates every published one-time prekey and purges from the server those whose local
   * private key is gone (state reset/restored). Conservative: only purges *proven* orphans
   * (KeyPackage validated but absent from the keystore); a KeyPackage that cannot be validated
   * is left in place (a peer might be able to validate it). Best-effort.
   */
  async reconcilePublishedKeyPackages(): Promise<void> {
    const published = await this.delivery.listOwnPrekeys();
    if (published.length === 0) return;

    const orphanIds: string[] = [];
    let disownedOwnMints = 0;
    for (const { id, keyPackage } of published) {
      try {
        if (await this.keyPackageHasPrivate(keyPackage)) continue;

        // A PACKAGE THIS SESSION PUBLISHED IS NEVER AN ORPHAN, AND SAYING SO IS THE WHOLE GUARD.
        //
        // Measured on the Mi 9T on 2026-09-06: `needed=49` on every connection, and immediately
        // after each top-up `purged 49/50 orphaned prekey(s)` - the device throwing away the very
        // packages it had just minted, so the pool never filled and it minted fifty more next
        // time. ~97 kB of bundles a round into a state nothing prunes below 84 days; `mls.bin`
        // grew 1.26 MB in a day and a checkpoint went from 17 s to 48 s.
        //
        // A SHARE-BASED FLOOR WOULD BE WRONG HERE. A device restored from an older backup has
        // genuinely lost every private key, and purging 50 of 50 is exactly what this function is
        // for - so "too many" cannot be the test. What separates the loop from the legitimate case
        // is not the proportion but the PROVENANCE: this process minted these bytes, so it holds
        // the private key by construction, and a `false` about one of them is never evidence about
        // the server. It is evidence that the seam between minting and asking is broken.
        //
        // So it is refused and ACCUSED rather than executed. The cause is still open
        // (`docs/wiki/backlog.md`); what this closes is the silence - a reconciliation undoing its
        // own top-up looked exactly like a reconciliation doing its job.
        if (this.publishedThisSession.has(fingerprintKeyPackage(keyPackage))) {
          disownedOwnMints++;
          continue;
        }
        orphanIds.push(id);
      } catch {
        // KeyPackage not locally deserializable/validatable: don't purge it.
      }
    }

    if (disownedOwnMints > 0) {
      console.error(
        `[MLS] reconcilePublishedKeyPackages: REFUSED to purge ${disownedOwnMints}/${published.length} prekey(s) ` +
          'this session published itself - the device cannot back a package it just minted, which is a broken ' +
          'seam between minting and asking, NOT a server orphan. Purging them is the loop that empties the pool ' +
          'and mints fifty more on every connection (see backlog: the prekey purge loop).'
      );
    }

    if (orphanIds.length > 0) {
      await this.delivery.pruneOwnPrekeys(orphanIds);
      console.log(
        `[MLS] reconcilePublishedKeyPackages: purged ${orphanIds.length}/${published.length} orphaned prekey(s)`
      );
    }
  }

  /** True if the local keystore still holds the private key for the given public KeyPackage. */
  protected abstract keyPackageHasPrivate(keyPackageBytes: Uint8Array): Promise<boolean>;

  async fetchDeviceKeyPackage(
    userId: string,
    deviceId: string
  ): Promise<{
    keyPackage: Uint8Array;
    deviceId: string;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  } | null> {
    return this.delivery.fetchDeviceKeyPackage(userId, deviceId);
  }

  async registerMember(groupId: string, userId: string): Promise<void> {
    return this.delivery.registerMember(groupId, userId);
  }

  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    for (const kp of packages) this.publishedThisSession.add(fingerprintKeyPackage(kp));
    return this.delivery.publishKeyPackages(packages);
  }

  async updateDeviceMetadata(
    userId: string,
    deviceId: string,
    metadata: { deviceName?: string; deviceOs?: string; deviceAppVersion?: string }
  ): Promise<{
    status: string;
    deviceName: string | null;
    deviceOs: string | null;
    deviceAppVersion: string | null;
  }> {
    return this.delivery.updateDeviceMetadata(userId, deviceId, metadata);
  }

  async acquireAddLock(groupId: string, ttlMs = MLS_ADD_LOCK_TTL_MS): Promise<boolean> {
    return this.delivery.acquireAddLock(groupId, ttlMs);
  }

  async releaseAddLock(groupId: string): Promise<void> {
    return this.delivery.releaseAddLock(groupId);
  }

  async createRemoteGroup(name: string, isGroup = true): Promise<string> {
    return this.delivery.createRemoteGroup(name, isGroup);
  }

  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number,
    until?: string
  ): Promise<import('$lib/mls-client/historyTypes').HistoryPage> {
    return this.delivery.fetchHistory(groupId, afterStreamId, limit, until);
  }

  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryPage>> {
    return this.delivery.fetchHistoryBatch(groups);
  }

  async fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
  }> {
    return this.delivery.fetchCommitsSince(groupId, sinceEpoch);
  }

  async forceLeaveGroup(groupId: string): Promise<void> {
    try {
      await this.delivery.deliveryPost(`groups/${groupId}/force_leave`, {
        deviceId: this.deviceId,
      });
    } catch (e) {
      console.warn('[MLS] forceLeaveGroup error (non-fatal):', e);
    }
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    return this.delivery.renameGroup(groupId, name);
  }

  async setGroupImage(groupId: string, mediaId: string | null): Promise<void> {
    return this.delivery.setGroupImage(groupId, mediaId);
  }

  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    return this.delivery.deleteGroupOnServer(groupId);
  }

  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    return this.delivery.removeMemberFromServer(groupId, userId);
  }

  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    return this.delivery.getGroupMembers(groupId);
  }

  async getGroupUserMembers(groupId: string): Promise<{ userId: string }[]> {
    return this.delivery.getGroupUserMembers(groupId);
  }

  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    return this.delivery.getUserGroups(userId);
  }

  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    return this.delivery.getGroupMeta(groupId);
  }

  async getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta> {
    return this.delivery.getGroupServerStatus(groupId);
  }

  async getDismissedGroups(): Promise<string[]> {
    return this.delivery.getDismissedGroups();
  }

  async dismissGroup(groupId: string): Promise<void> {
    return this.delivery.dismissGroup(groupId);
  }

  async undismissGroup(groupId: string): Promise<void> {
    return this.delivery.undismissGroup(groupId);
  }

  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    return this.delivery.getPendingInvitations(userId, deviceId);
  }

  async getDeviceMemberships(userId: string, deviceId: string): Promise<DeviceMembershipRow[]> {
    return this.delivery.getDeviceMemberships(userId, deviceId);
  }

  /**
   * Marks a device's membership `pending` or `active` on the server.
   *
   * GUARDED, because this is the only client call that can CREATE an `active` membership row from
   * nothing, and it was reached twice with an identity that did not exist yet - see
   * {@link assertResolvedIdentity} for what that cost. The throw is the report: every call site is
   * fire-and-forget and re-driven, so refusing here delays a promotion by one cycle and prevents a
   * placeholder from being written into a roster for good.
   */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void> {
    assertResolvedIdentity('updateInvitationStatus', userId, deviceId);
    return this.delivery.updateInvitationStatus(deviceId, userId, groupId, status);
  }

  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    return this.delivery.kickStaleDevice(deviceId, userId, groupId);
  }

  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteDeviceMembership(userId, deviceId, groupId);
  }

  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    return this.delivery.deleteAllDeviceMemberships(userId, deviceId);
  }

  async deleteDevice(
    userId: string,
    deviceId: string
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }> {
    return this.delivery.deleteDevice(userId, deviceId);
  }

  // ── Shared MLS decrypt session (overridden on Web for the worker path) ─────

  /** Sequential, in-place session used by Tauri and when the crypto worker is disabled. */
  async createDecryptSession(groupId: string): Promise<MlsDecryptSession> {
    // The sequential path decrypts in place, so it cannot be UNDONE by a swap the way the worker
    // path can - but a send during it is still a send racing a catch-up, and the ordering rule is
    // about the sequence, not about which platform happens to survive breaking it.
    this.beginCatchUp(groupId);
    let session: MlsDecryptSession;
    try {
      session = await createSequentialDecryptSession(this, groupId);
    } catch (e) {
      this.endCatchUp(groupId);
      throw e;
    }
    return {
      decryptPage: (msgs) => session.decryptPage(msgs),
      finish: async () => {
        try {
          await session.finish();
        } finally {
          this.endCatchUp(groupId);
        }
      },
    };
  }

  /**
   * Default no-op: only Tauri/Android has a background JNI engine that can advance `mls.bin`
   * while the app is backgrounded, so only TauriMlsService overrides this to reload (C2). On
   * web/desktop the in-memory engine is the sole writer; there is nothing to reload.
   */
  async reloadStateFromDisk(): Promise<void> {}

  /**
   * Default null: every path but the Tauri biometric one derives the device key in the frontend
   * and hands it to {@link init}, so there is nothing to ask back for.
   */
  async resolveSessionDeviceKey(): Promise<string | null> {
    return null;
  }

  // ── Platform-specific (abstract) ──────────────────────────────────────────

  /**
   * Writes the current state to this platform's durable store. Split from {@link saveState} because
   * Tauri's already lands on disk while Web still has to hand the bytes to IndexedDB, and no caller
   * - {@link rotateDeviceIdentity}, the checkpoint persister, the structural checkpoint - may have
   * to know which. See `IMlsService.persistCheckpoint` for what the duplicate cost.
   */
  protected abstract writeCheckpoint(deviceKeyB64: string): Promise<void>;

  /**
   * Advances this device's send ratchet by `count` generations without emitting anything.
   *
   * Platform-specific and nothing else: WHEN to burn, and by how much, is decided once in
   * {@link reconcileSendRatchets}. See `MlsManager::skip_send_generations` for why it encrypts and
   * why burning too many is free while burning too few is the defect.
   */
  protected abstract skipSendGenerations(groupId: string, count: number): Promise<number>;

  /**
   * Checkpoints the live state AND records how much of this device's send ratchet it makes durable.
   *
   * CONCRETE, FOR THE REASON {@link sendMessage} IS. The count is read BEFORE the write is started
   * and committed only AFTER it resolves, and that order is the entire guarantee: a send landing
   * during the write is then counted as unpersisted and costs one burnt generation too many on the
   * next load, where the opposite order costs one too few and reproduces exactly the fault this
   * exists to close. Leaving the pairing to each call site would be the eighteen-call-sites lesson
   * of `sendMessage`, re-learnt on the seam that guards the ratchet instead of the one that moves it.
   */
  async persistCheckpoint(deviceKeyB64: string): Promise<void> {
    const emitted = snapshotEmitted(this.userId);
    await this.writeCheckpoint(deviceKeyB64);
    commitPersisted(this.userId, emitted);
  }

  /**
   * Burns whatever this device sent but never checkpointed, so the restored ratchet is back where
   * the peers already believe it is. Runs once per {@link init}, before anything can send.
   *
   * A fresh start has no history to repair and any surviving count describes a device that no longer
   * exists, so the ledger is dropped rather than replayed.
   *
   * Per group, and isolated per group: the ledger can name a conversation this device has since left
   * or forgotten, and `skipSendGenerations` answers `GroupNotFound` for it. One unrepairable group
   * must not cost the repair of the others.
   */
  protected async reconcileSendRatchets(deviceKeyB64: string): Promise<void> {
    if (this.freshStart) {
      resetSendRatchetLedger(this.userId);
      return;
    }
    const pending = pendingSendGenerations(this.userId);
    if (pending.length === 0) return;

    let repaired = 0;
    for (const { groupId, deficit, clamped } of pending) {
      if (clamped) {
        // NAMED, NEVER SILENT: a deficit past the receivers' forward window is a corrupt counter,
        // not a backlog, and burning the cap will not repair it. Saying so is what separates
        // "repaired" from "gave up at the bound" in the log a later reader will have.
        console.warn(
          `[MLS] Send ledger for ${groupId.slice(0, 8)}... claims more than ${MAX_BURN_GENERATIONS} unpersisted frames - burning the cap only; the ratchet cannot be repaired past the receivers' forward window`
        );
      }
      try {
        await this.skipSendGenerations(groupId, deficit);
        repaired++;
        console.log(
          `[MLS] Restored state for ${groupId.slice(0, 8)}... was ${deficit} generation(s) behind this device's own sends - burnt, no frame will re-use a spent generation`
        );
      } catch (e) {
        console.warn(
          `[MLS] Could not burn ${deficit} generation(s) for ${groupId.slice(0, 8)}...:`,
          String(e).slice(0, 160)
        );
      }
    }

    // The burn moved the live ratchet and nothing durable knows it yet, so a second reload would
    // burn the same generations again. Harmless (over-shooting is free) but pointless, and the
    // checkpoint is what closes the ledger: it commits `persisted = emitted` through the pairing
    // above. A failure leaves the deficit standing, which repairs itself on the next load.
    if (repaired > 0) {
      await this.persistCheckpoint(deviceKeyB64).catch((e) =>
        console.warn('[MLS] Checkpoint after the ratchet burn failed:', String(e).slice(0, 160))
      );
    }
  }

  abstract saveState(deviceKeyB64: string): Promise<Uint8Array>;
  abstract changeDeviceKey(newDeviceKeyB64: string): Promise<void>;
  protected abstract generateKeyPackageImpl(deviceKeyB64: string): Promise<Uint8Array>;
  abstract publishKeyPackage(keyPackageBytes: Uint8Array): Promise<void>;
  abstract createGroup(groupId: string): Promise<void>;
  abstract forceCreateGroup(groupId: string): Promise<void>;

  // ── One commit regime (C7-A unified: stage -> validate -> merge/clear) ──────
  //
  // Every structural commit (ADD and REMOVE) runs through runCommitTransaction: the stage step
  // produces the commit WITHOUT merging, the server validates the epoch, then we merge (accept) or
  // clear (reject). A rejected commit therefore never leaves the local epoch ahead, so the whole
  // class of "sender fork" desyncs disappears. The platform primitives below (stage / merge / clear
  // / export tree / fresh epoch) are the only pieces that differ between WASM and native.

  /** Stages an Add commit WITHOUT merging. Returns the commit, shared Welcome, and the input
   *  positions actually added / dropped-as-invalid (already-member dedup is silent). */
  protected abstract stageAddMembers(
    groupId: string,
    keyPackages: Uint8Array[]
  ): Promise<{
    commit: Uint8Array;
    welcome?: Uint8Array;
    addedIndices: number[];
    skippedIndices: number[];
  }>;
  /** Stages a Remove commit (all devices of the given users) WITHOUT merging. Returns the commit. */
  protected abstract stageRemoveMembers(groupId: string, userIds: string[]): Promise<Uint8Array>;
  /** Stages a Remove commit for specific devices ("userId:deviceId") WITHOUT merging. */
  protected abstract stageRemoveMembersByDevice(
    groupId: string,
    deviceIdentities: string[]
  ): Promise<Uint8Array>;
  /** Merges the pending staged commit (server accepted): advances the local epoch. */
  protected abstract mergePendingCommit(groupId: string): Promise<void>;
  /** Clears the pending staged commit (server rejected): local epoch unchanged, no fork. */
  protected abstract clearPendingCommit(groupId: string): Promise<void>;
  /** Exports the group's ratchet tree from the CURRENT (post-merge) state for the Welcome. */
  protected abstract exportRatchetTree(groupId: string): Promise<Uint8Array>;
  /** Reads the authoritative current (pre-merge) epoch for server validation. */
  protected abstract freshEpoch(groupId: string): Promise<number>;
  /** Exports a self-contained GroupInfo (ratchet tree included) for the external-join base. */
  protected abstract exportGroupInfo(groupId: string): Promise<Uint8Array>;
  /** Builds an external commit from a served GroupInfo and stages it locally (group at epoch+1).
   *  Returns the resolved group id and the commit to submit for server epoch validation. */
  protected abstract joinByExternalCommit(
    groupInfoBytes: Uint8Array
  ): Promise<{ groupId: string; commit: Uint8Array }>;

  /**
   * Runs one staged commit transaction under the MLS lock: stage (no merge) -> validate the epoch
   * server-side -> merge (accept) or clear (reject, throws). On accept it broadcasts the commit
   * (skipping `excludeDeviceIds`) and, when `exportTree` is set, exports the post-merge ratchet
   * tree for the caller to deliver in the Welcome. The network preamble that builds the stage
   * inputs stays OUTSIDE this method; only the stage->merge unit is locked.
   */
  protected async runCommitTransaction(
    groupId: string,
    stageFn: () => Promise<{
      commit: Uint8Array;
      welcome?: Uint8Array;
      addedDeviceIds?: string[];
      skippedDeviceIds?: string[];
    }>,
    opts: { excludeDeviceIds?: string[]; exportTree?: boolean } = {}
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skippedDeviceIds: string[];
  }> {
    const out = await this.runUnderMlsLock(async () =>
      // RAISED UNDER THE MLS MUTEX, WHICH IS WHAT MAKES IT DEADLOCK-FREE: a send that sees this
      // barrier provably does not hold the mutex, so it blocks nothing the drain inside waits for.
      // The section covers stage through merge - the whole window in which this device's notion of
      // the epoch and the server's can disagree. See `epochSendBarrier`.
      runAsEpochAdvance(groupId, async () => {
        const staged = await stageFn();
        // baseEpoch = current (pre-merge) epoch: the staged commit will transition N -> N+1.
        const baseEpoch = await this.freshEpoch(groupId);
        // One atomic server round-trip: validate the epoch, and on accept the server records the
        // commit in the epoch-indexed log (rung-1 replay) AND fans it out to members. If we crash
        // between this accept and the local merge below, our epoch lags the server by one - a gap the
        // rung-1 replay heals on the next sync, no longer a destructive fork. [[C7]]
        const validation = await this.delivery.submitCommit(
          groupId,
          baseEpoch,
          toBase64(staged.commit),
          opts.excludeDeviceIds
        );
        if (!validation.accepted) {
          // Rejected: roll back the staged commit. The local epoch never moved, so there is NO fork.
          // Throw without the `server epoch:.., sent:..` marker so the caller treats it as a
          // retryable failure rather than a fork to heal. [[C7]]
          await this.clearPendingCommit(groupId).catch(() => {});
          // ...and MAKE that retry true, because until now nothing did. See `catchUpOnRefusedCommit`.
          await this.catchUpOnRefusedCommit(groupId, baseEpoch, validation.currentEpoch);
          throw new Error(`Staged commit rejected: ${validation.reason || 'epoch_mismatch'}`);
        }
        await this.mergePendingCommit(groupId);
        const ratchetTree = opts.exportTree ? await this.exportRatchetTree(groupId) : undefined;
        return {
          welcome: staged.welcome,
          ratchetTree,
          addedDeviceIds: staged.addedDeviceIds ?? [],
          skippedDeviceIds: staged.skippedDeviceIds ?? [],
        };
      })
    );
    // The commit advanced the epoch: refresh the external-join base so a member lacking state can
    // self-join at the new epoch. Skipped on reject (the closure above throws before we get here, so
    // the epoch never moved). [[Phase 4]]
    //
    // FIRE-AND-FORGET, AND WHAT IT COSTS IS NOT NOTHING. This is the ONLY thing that mints a base,
    // so losing it strands the group's published base one epoch behind - permanently, and every
    // stateless joiner is refused for as long as it lasts. It stays off the critical path (a commit
    // that succeeded must not be reported as failed because a follow-up did not land) and the repair
    // lives where a device that CAN mint a base already reads the group: `republishStaleBase` in
    // [distributionGroup](../utils/graine/distributionGroup.ts).
    void this.refreshGroupInfo(groupId);
    return out;
  }

  /**
   * Enters the recovery ladder from the WRITE side, on a commit the server refused because our base
   * epoch is behind its active one.
   *
   * **THE LADDER HAD EXACTLY ONE ENTRANCE, AND IT WAS THE READ SIDE.** Both rungs - the
   * non-destructive {@link attemptCommitReplay}, then the forget + re-Welcome - are reached from
   * `setupMessageHandler`, when a frame arrives this device cannot decrypt. So a device that is
   * behind but receives nothing never enters it, and the retry the rejection above is designed for
   * rests on a premise nothing establishes: that the commit we missed reaches us on its own. On a
   * quiet conversation it never does, because the only traffic left is our own refused commits.
   *
   * The refusal carries the server's `activeEpoch`, so being behind is KNOWN here rather than
   * inferred, and re-applying the commits we missed is what makes the caller's next retry the one
   * the design already expects to succeed. When rung 1 cannot close the gap - commits pruned below
   * the log floor, or one that will not apply - the group is left in the epoch-gap registry, whose
   * owner is the sync watchdog: it escalates to rung 2, and freezing the outbox until it does keeps
   * a stale-epoch ciphertext off the wire.
   *
   * No rung, no cadence and no escalation is added here. This is the entrance the write side never
   * had, and the ladder behind it is the one the read side has always used.
   *
   * @param baseEpoch - the epoch we staged the commit on, i.e. our local epoch.
   * @param activeEpoch - the server's own epoch, absent when it refused for any other reason.
   */
  private async catchUpOnRefusedCommit(
    groupId: string,
    baseEpoch: number,
    activeEpoch: number | undefined
  ): Promise<void> {
    // The EPOCHS decide, not the reason string: a refusal that does not report a server epoch ahead
    // of ours says nothing about a gap, and re-applying commits would answer a question nobody asked.
    if (activeEpoch === undefined || activeEpoch <= baseEpoch) return;

    const short = groupId.slice(0, 8);
    const log = (msg: string) => console.log(msg);
    log(`[GAP] commit refused on ${short}: we are at ${baseEpoch}, the server at ${activeEpoch}`);
    markEpochGap(groupId);
    let exhausted: string | undefined;
    try {
      const replay = await attemptCommitReplay(this, groupId, log);
      if (replay.healed) {
        clearEpochGap(groupId);
        scheduleOutboundMlsPersist();
        return;
      }
      // "Still behind" merges two futures: one where the next frame closes the gap, and one where
      // NOTHING ever does because the server has no commits to give. The escalation still belongs
      // to the watchdog - deliberately, see above - but the line must say which of the two this is,
      // or a log read cannot tell a transient lag from a permanently holed log.
      if (replay.belowFloor) exhausted = 'the commits are pruned below the log floor';
      else if (replay.gapAt !== undefined) {
        exhausted = `the commit log is HOLED at epoch ${replay.gapAt} and can never be refilled`;
      }
    } catch (e) {
      // Swallowed on purpose - the caller is about to throw the refusal, which is the outcome that
      // matters - but never silently: this is the branch that leaves the group to rung 2.
      console.warn(`[GAP] replay error for ${short} after a refused commit:`, e);
    }
    log(
      exhausted
        ? `[GAP] ${short} cannot be caught up by replay - ${exhausted}; rung 2 is OWED, not merely possible (waiting on the sync watchdog)`
        : `[GAP] ${short} still behind after rung 1 - left to the sync watchdog for rung 2`
    );
  }

  /**
   * Declares `groupId` to be the Graine key-distribution group of `scope`.
   *
   * Called once the client has learned the pair from social-service. From here on, every decision
   * that differs for this group - where its external-join base lives, and that its frames are seeds
   * rather than a conversation - is taken from THIS fact rather than rediscovered.
   */
  registerDistributionGroup(scope: DistributionScope, groupId: string): void {
    this.distributionScopeByGroup.set(groupId, scope);
    this.knownDistributionGroups.add(groupId);
  }

  /**
   * Records that `groupId` IS a distribution group, without claiming to know whose.
   *
   * The server's answer for a salon's group whose community this session has not loaded. Naming the
   * scope has to wait for that load; being right about what the group is must not.
   */
  noteDistributionGroup(groupId: string): void {
    this.knownDistributionGroups.add(groupId);
  }

  /** True when `groupId` carries channel seeds and must never reach the conversation pipeline. */
  isDistributionGroup(groupId: string): boolean {
    return this.knownDistributionGroups.has(groupId);
  }

  /**
   * Whether `groupId`'s external-join base is arbitrated - the question "held locally" cannot answer.
   *
   * True for every group this device did not create in this session: JOINING one means its base was
   * already published, and the publish is the arbitration. False only inside the create window of
   * {@link ensureDistributionGroup}; the reason is on {@link unsettledDistributionGroups}.
   */
  isDistributionBaseSettled(groupId: string): boolean {
    return !this.unsettledDistributionGroups.has(groupId);
  }

  /**
   * Leaves a scope's key-distribution group: the MLS tree AND the registration, together.
   *
   * THE COUNTERPART OF {@link ensureDistributionGroup}, and it did not exist. Nothing removed this
   * group when a community left the device, because the reconciliation sweep destroyed it on the
   * next connection anyway - by accident, and for the wrong reason. Once the sweep correctly keeps
   * it (WP-GRAINE-1), a community left in the morning would still have its seed carrier held at
   * midnight, and every seed sent in it would still arrive.
   *
   * Both halves or neither: forgetting the tree while leaving the registration would leave
   * `distributionGroupFor` naming a group this device no longer holds, which is the exact state
   * `distributionEpochFor` exists to refuse. The MLS state still has to be checkpointed by the
   * caller, which knows the device key.
   *
   * @returns the group that was left, or null when this device held none for that community.
   */
  forgetDistributionGroup(scope: DistributionScope): string | null {
    const groupId = this.distributionGroupFor(scope);
    if (!groupId) return null;
    this.forgetDistributionGroupById(groupId);
    return groupId;
  }

  /**
   * The same, named by the GROUP - for a caller holding the server's answer rather than a scope.
   *
   * IT CANNOT BE EXPRESSED THROUGH THE SCOPE FORM, and that is the whole reason it exists. The
   * scope form resolves the group through `distributionScopeByGroup`, so it forgets only what that
   * registration already names; the state worth forgetting is one where the registration and the
   * held tree have drifted apart, and there the scope form returns null and leaves the tree behind -
   * whereupon {@link ensureDistributionGroup}, which early-returns on the GROUP ID, sees the group
   * still held and joins nothing. Named by the group, both halves go, whatever the registration
   * says.
   *
   * @returns whether this device held anything under that id
   */
  forgetDistributionGroupById(groupId: string): boolean {
    const held = holdsGroupState(this, groupId) || this.knownDistributionGroups.has(groupId);
    if (!held) return false;
    this.forgetGroup(groupId);
    this.distributionScopeByGroup.delete(groupId);
    // BOTH, OR THE PREDICATE OUTLIVES THE GROUP: a set entry left behind would go on answering
    // "distribution group" for state this device no longer holds, and the sweep would go on
    // sparing it for ever.
    this.knownDistributionGroups.delete(groupId);
    return true;
  }

  /**
   * The distribution group registered for `scope`, or null.
   *
   * Scanned rather than kept in a second map on purpose: a reverse index is a second copy of the
   * same fact, and two copies of a fact drift. The population is one entry per community a user
   * belongs to plus one per private salon they may open - dozens at most - so the scan is not worth
   * a consistency risk.
   */
  distributionGroupFor(scope: DistributionScope): string | null {
    const key = scopeKey(scope);
    for (const [groupId, registered] of this.distributionScopeByGroup) {
      if (scopeKey(registered) === key) return groupId;
    }
    return null;
  }

  /**
   * Every scope this device holds a distribution group for.
   *
   * The enumeration a sweep needs: a reconciliation or a forget that could only ask about scopes it
   * already knew would never find the one it had stopped knowing about.
   */
  distributionScopes(): DistributionScope[] {
    return [...this.distributionScopeByGroup.values()];
  }

  /** Wires the social-service transport for distribution-group GroupInfo. Set once, at startup. */
  setDistributionGroupInfoTransport(transport: DistributionGroupInfoTransport | null): void {
    this.distributionGroupInfo = transport;
  }

  /** Wires what decrypted key-distribution frames are handed to. Set once, at startup. */
  onDistributionFrame(handler: DistributionFrameHandler | null): void {
    this.distributionFrameHandler = handler;
  }

  /**
   * Decrypts a frame that arrived on a key-distribution group and hands it to the Graine handler.
   *
   * It never touches a conversation, and it is the reason the pipeline branches on
   * {@link isDistributionGroup} BEFORE anything else: `handleKnownGroup` looks the group up in the
   * conversation map, finds nothing, and returns without acknowledging - so every seed frame would
   * be redelivered for ever while never being read.
   *
   * @returns whether the frame may be acknowledged. A commit is applied and acknowledged with no
   *   handler involvement (it carries no payload); a frame this device cannot yet decrypt is NOT
   *   acknowledged, so the server redelivers it once the join has landed.
   */
  async routeDistributionFrame(
    groupId: string,
    sender: string,
    ciphertext: Uint8Array
  ): Promise<boolean> {
    const scope = this.distributionScopeByGroup.get(groupId);
    if (scope === undefined) {
      // Unreachable through the pipeline, which only calls this behind `isDistributionGroup`.
      console.warn(`[GRAINE] frame for unregistered distribution group ${groupId.slice(0, 8)}...`);
      return false;
    }
    const { workspaceId } = scope;

    let plaintext: Uint8Array | null;
    try {
      plaintext = await this.processIncomingMessage(groupId, ciphertext);
    } catch (e) {
      // WHY THIS ASKS WHICH FAILURE IT WAS. Refusing to acknowledge is right for a frame that may
      // still become readable - the join has not landed, a commit is missing - and it is an
      // INFINITE REDELIVERY LOOP for one that never will. This branch used to refuse them all, so
      // a device's own seeds (`CannotDecryptOwnMessage`) and every seed overtaken by a commit came
      // back on every single connection, for ever: 6 frames re-read ten times per boot, measured on
      // prod 2026-08-19 while WP-GRAINE-1 was moving the epoch under them.
      //
      // The permanence is decided at the throw, by `classifyIncomingDecryptError`, and never by
      // re-reading a sentence here.
      const kind = classifyIncomingDecryptError(e);
      const permanent =
        kind === 'own-message' ||
        kind === 'secret-reuse' ||
        kind === 'past-epoch-application' ||
        kind === 'generation-gap' ||
        // Refused at exactly the epoch it names, which no later arrival changes. THIS IS THE ARM
        // THE LIST ABOVE WAS MISSING: those four name a ratchet position, and everything else fell
        // through to `unknown` and was refused an ACK on the argument that it might still become
        // readable - true of a frame from an epoch we have not reached, false of one already
        // compared against ours. On prod 2026-08-26 that was a single `InvalidSignature` at
        // epoch 0 on two distribution groups, handed back on every connection for ever and
        // dirtying eleven cells of the COMM rung by itself.
        kind === 'same-epoch-refusal' ||
        // Removed from the distribution group. Permanent in the strongest sense of the four above:
        // those are frames we may no longer READ, this is a group we are no longer IN, and no peer
        // answering a history request can change that.
        kind === 'evicted';
      if (permanent) {
        // ACKNOWLEDGED, and said once. The seed is gone from THIS device for good; what recovers it
        // is a peer answering `requestCommunityHistory`, never the server handing the same
        // undecryptable bytes back. Leaving it queued would cost the line above on every boot and
        // hide the next real refusal underneath it.
        console.warn(
          `[GRAINE] frame on ${groupId.slice(0, 8)}... is unreadable for good (${kind}) - acknowledged; its seed comes back through a history request, not a redelivery`
        );
        return true;
      }
      console.warn(
        `[GRAINE] undecryptable frame on ${groupId.slice(0, 8)}... - not acknowledged (${kind}):`,
        String(e).slice(0, 120)
      );
      return false;
    }

    // A commit: MLS state advanced and there is nothing to hand over. Acknowledged, because
    // replaying it would only be refused.
    if (!plaintext) return true;

    const handler = this.distributionFrameHandler;
    if (!handler) {
      // Not silent, and not acknowledged: the frame is a seed somebody needs, and the ONLY symptom
      // of a handler never wired would otherwise be a community whose history quietly never loads.
      console.error(
        `[GRAINE] no handler wired - dropping a ${plaintext.length}-byte frame from ${sender.slice(0, 8)}... on community ${workspaceId.slice(0, 8)}...`
      );
      return false;
    }

    try {
      await handler({ scope, workspaceId, groupId, sender, plaintext });
    } catch (e) {
      // NOT acknowledged, on purpose: the handler is what STORES a seed, so a throw here means the
      // seed did not land, and acknowledging would drop key material nobody can ask for again.
      // Redelivery is exactly the right outcome - including after a logout, where the session this
      // handler needs is gone by construction.
      console.error(
        `[GRAINE] handler refused a frame from ${sender.slice(0, 8)} on community ${workspaceId.slice(0, 8)} - not acknowledged:`,
        e instanceof Error ? e.message : String(e)
      );
      return false;
    }
    return true;
  }

  /**
   * THE ONE PLACE that decides where a group's external-join base lives.
   *
   * Both callers below need the same answer, and a group cannot change kind, so the decision is made
   * once from a fact already registered rather than re-derived at each call site - which is the shape
   * of rule the next call site forgets.
   *
   * A group registered as a distribution group with no transport wired is a WIRING BUG, and it
   * throws: routing it to chat-delivery instead would produce a 403 that reads like a permission
   * problem and send the next reader to entirely the wrong place.
   */
  protected groupInfoChannel(groupId: string): {
    fetch(): Promise<{ groupInfo: string; baseEpoch: number; activeEpoch: number } | null>;
    publish(groupInfoBase64: string, baseEpoch: number): Promise<{ stored: boolean }>;
  } {
    const scope = this.distributionScopeByGroup.get(groupId);
    if (scope === undefined) {
      return {
        fetch: () => this.delivery.fetchGroupInfo(groupId),
        publish: (gi, epoch) => this.delivery.storeGroupInfo(groupId, gi, epoch),
      };
    }
    const transport = this.distributionGroupInfo;
    if (!transport) {
      throw new Error(
        `[MLS] no distribution GroupInfo transport wired - group ${groupId.slice(0, 8)}... belongs to ${scopeLabel(scope)}`
      );
    }
    return {
      fetch: () => transport.fetch(scope),
      publish: (gi, epoch) => transport.publish(scope, gi, epoch, this.deviceId),
    };
  }

  /**
   * Exports the current GroupInfo and pushes it to the delivery service (external-join base, Phase 4)
   * so an authorized member lacking MLS state can self-join at the current epoch.
   *
   * NEVER THROWS, AND THE LOSS IS NOT MOMENTARY - which is what the doc that used to sit here
   * claimed ("a joiner may momentarily get a one-epoch-stale base and retry"). Nothing else ever
   * publishes a base, so a refresh lost here leaves the published one behind the group's epoch until
   * some unrelated member happens to commit; the strict gate refuses every external commit built on
   * it in the meantime, and a distribution group has no peer-Welcome fallback to take instead. On
   * production 2026-08-25 that locked a member out of a private salon for the rest of the session.
   * The repair is `republishStaleBase` in
   * [distributionGroup](../utils/graine/distributionGroup.ts), driven by any HOLDER's ordinary read.
   */
  async refreshGroupInfo(groupId: string): Promise<void> {
    try {
      const groupInfo = await this.exportGroupInfo(groupId);
      const baseEpoch = this.getEpoch(groupId);
      await this.groupInfoChannel(groupId).publish(toBase64(groupInfo), baseEpoch);
    } catch (e) {
      console.warn(
        `[MLS] refreshGroupInfo failed for ${groupId.slice(0, 8)}...:`,
        String(e).slice(0, 120)
      );
    }
  }

  /**
   * Attempts to (re)join `groupId` via an external commit built from the server-stored GroupInfo,
   * WITHOUT a peer Welcome. This is the self-service recovery seam (Phase 4): a member with no local
   * MLS state fetches the published base, builds an external commit, and submits it under the strict
   * epoch gate (no peer liveness required, which is what makes a distribution group joinable at all).
   *
   * EVERY OUTCOME IS A TYPE, and that is the whole shape of this method. Five different things can
   * stop a join and exactly one of them is worth retrying; flattened into `false` they were
   * indistinguishable to every caller, so the one retry-forever loop was taken for all five.
   *
   * **A stale base is not a race, and no number of attempts wins it.** The gate accepts a base equal
   * to `activeEpoch` and nothing else. That base is published by a follow-up call from the device
   * whose commit was just accepted, and NOTHING else ever mints one - so when that call is lost the
   * two numbers separate for good, and every commit built on the published base is refused, for
   * ever. The server now serves both numbers, so this is READ rather than discovered by submitting:
   * we answer {@link ExternalJoinOutcome} `stale_base` and let a device that HOLDS the tree repair
   * it (see `joinDistributionGroup`). Found on production 2026-08-25, when it cost a private salon
   * its second member: three refusals in one second, the freshly built tree discarded each time, and
   * the same doomed base still being submitted twenty minutes later.
   *
   * **Termination is a proof, not a count.** The bound below only covers `concurrent_commit` - the
   * commit lock being busy, where the base genuinely may move. A refusal whose refetch shows the
   * base behind the group's epoch exits on that fact instead of burning the remaining attempts.
   *
   * THROWS {@link NotAGroupMemberError} when the server says we hold no membership row, and that is
   * the one outcome a caller must not treat as "try again later". A distribution group cannot reach
   * that branch: {@link groupInfoChannel} routes those to their own transport, so a 403 here is
   * always a chat group we are genuinely outside of.
   */
  async externalJoin(groupId: string): Promise<ExternalJoinOutcome> {
    const excludeSelf = [`${this.userId}:${this.deviceId}`];
    const short = groupId.slice(0, 8);
    for (let attempt = 0; attempt < EXTERNAL_JOIN_MAX_ATTEMPTS; attempt++) {
      // THE REFUSAL HAS TO SURVIVE THIS CATCH, which flattened every outcome into `null` and cost
      // the caller the only discriminator it needed. `NotAGroupMemberError` is the server answering
      // the question recovery is asking; anything else says nothing about membership and leaves the
      // welcome_request fallback the right next move. And it is logged now: this was a swallowed
      // branch on the path a real outage would take.
      const gi = await this.groupInfoChannel(groupId)
        .fetch()
        .catch((e) => {
          if (e instanceof NotAGroupMemberError) throw e;
          console.warn(
            `[MLS] externalJoin GroupInfo fetch failed for ${short}...:`,
            String(e).slice(0, 120)
          );
          return null;
        });
      if (!gi) return { joined: false, reason: 'no_base_published' };

      // NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU. A base behind the group's epoch is
      // refused by the gate with certainty, and the refusal costs a round trip and the tree we would
      // build to make it. Only a member already holding the tree can publish a usable one.
      if (gi.baseEpoch < gi.activeEpoch) {
        console.warn(
          `[MLS] externalJoin STALE base for ${short}... (published ${gi.baseEpoch}, group at ${gi.activeEpoch})` +
            ` - not attempting; a member holding the tree must republish it`
        );
        return {
          joined: false,
          reason: 'stale_base',
          baseEpoch: gi.baseEpoch,
          serverEpoch: gi.activeEpoch,
        };
      }

      // BUILD THE COMMIT AND THE BASE IT CREATES IN THE SAME BREATH. An external commit is applied
      // to the returned instance at once (unlike a staged add/remove), so this device - and for one
      // moment ONLY this device - can export the GroupInfo for the epoch its own commit produces.
      // That base then travels inside the submission below and is stored with the epoch advance,
      // which is what stops an external joiner from locking the NEXT one out (COMM-22).
      let joined: { groupId: string; commit: Uint8Array; nextBase: string };
      try {
        joined = await this.runUnderMlsLock(async () => {
          const built = await this.joinByExternalCommit(fromBase64(gi.groupInfo));
          const localEpoch = this.getEpoch(built.groupId);
          // A HARD ERROR, NOT A DEGRADED SUBMISSION. The published base is monotonic and cannot be
          // walked back, so a blob exported at any other epoch than the one the server will record
          // it under would strand the group for good. Nothing about this can be true and unnoticed:
          // if the instance is not at base + 1 the join is abandoned like any other build failure,
          // and the caller's welcome_request fallback is the right next move.
          if (localEpoch !== gi.baseEpoch + 1) {
            throw new Error(
              `external join instance at epoch ${localEpoch}, expected ${gi.baseEpoch + 1}`
            );
          }
          const nextBase = toBase64(await this.exportGroupInfo(built.groupId));
          return { ...built, nextBase };
        });
      } catch (e) {
        // Build failed (e.g. the group is already held locally) -> fall back.
        console.warn(`[MLS] externalJoin build failed for ${short}...:`, String(e).slice(0, 120));
        return { joined: false, reason: 'build_failed' };
      }

      // Submit under the epoch gate against the GroupInfo's base epoch. The server fans the external
      // commit out to existing members (excluding this device, which already applied it).
      let validation: { accepted: boolean; reason?: string; currentEpoch?: number };
      try {
        validation = await this.delivery.submitCommit(
          joined.groupId,
          gi.baseEpoch,
          toBase64(joined.commit),
          excludeSelf,
          joined.nextBase
        );
      } catch (e) {
        // A TRANSPORT FAILURE IS NOT AN ANSWER, and this used to be relabelled an epoch race: the
        // staged commit was discarded, the base refetched, and the whole thing retried against a
        // server that had never been reached. We claim NOTHING about membership here. The group is
        // still dropped, because an external commit cannot be cleared and a pending one left
        // unmerged breaks every later operation on it - and if the server DID accept the commit we
        // never saw acknowledged, its base is now stale and a holder's republish is what fixes it.
        this.forgetGroup(joined.groupId);
        console.warn(
          `[MLS] externalJoin could not reach the commit gate for ${short}... (base ${gi.baseEpoch}) -` +
            ` nothing is claimed about membership:`,
          String(e).slice(0, 120)
        );
        return { joined: false, reason: 'unreachable' };
      }

      if (validation.accepted) {
        await this.runUnderMlsLock(() => this.mergePendingCommit(joined.groupId));
        // THE SERVER HAS ALREADY MADE THIS DURABLE FOR EVERYONE ELSE, so this device may not hold
        // its half in RAM. The commit is accepted: the group's epoch has advanced for every other
        // member, and the secrets that make the new epoch usable exist ONLY here, in WASM memory.
        // A reload before the next checkpoint restores a device that is IN the published tree and
        // cannot read a word of it - and, finding no local group, joins again from the new base.
        //
        // THAT SECOND JOIN FORKS THE GROUP. Measured on prod 2026-08-27: a device joined one salon
        // at base 0 and again at base 1 two seconds apart across a navigation, leaving the salon at
        // epoch 2, the granting device stranded at 0 refusing frames it could not read, and the
        // seed that device held undeliverable - a member granted access who can read nothing.
        //
        // `mlsStatePersister` defers routine writes for a reason it states in full: inbound state
        // is replayable from the server, and outbound ratchet state is checkpointed on the send
        // path. AN EXTERNAL JOIN IS NEITHER. Nothing on the server can replay these secrets back,
        // so the structural checkpoint is awaited here, at the point the state moved.
        let checkpointed: boolean;
        try {
          checkpointed = await persistMlsStructuralCheckpoint();
        } catch (e) {
          checkpointed = false;
          console.error(
            `[MLS] externalJoin FAILED to checkpoint ${short}... - a reload before the next write` +
              ` would rejoin and fork the group:`,
            String(e).slice(0, 120)
          );
        }
        // The join stands either way - it is accepted server-side and usable for this session, and
        // refusing it here would discard a membership the rest of the group can already see. What
        // is lost is only its durability, which is why this accuses rather than informs.
        if (!checkpointed) {
          console.error(
            `[MLS] externalJoin for ${short}... was not checkpointed: no persister is registered,` +
              ` so this membership does not survive a reload and the next load will rejoin`
          );
        }
        // NO FOLLOW-UP REFRESH HERE, AND ITS ABSENCE IS THE FIX. The base for the epoch this join
        // created was written in the same transaction as the epoch itself, so there is nothing left
        // to mint and nothing left to lose - which is what a reload used to take with it.
        console.log(
          `[MLS] externalJoin succeeded for ${joined.groupId.slice(0, 8)}... (base epoch ${gi.baseEpoch},` +
            ` base for ${gi.baseEpoch + 1} stored with the commit)`
        );
        return { joined: true };
      }

      // REFUSED, and the server said WHY - both fields used to be dropped and the line called every
      // refusal an epoch race. An external commit cannot be cleared, so the group goes; the next
      // pass re-reads the base and exits on the stale-base fact above if nobody republished.
      this.forgetGroup(joined.groupId);
      console.warn(
        `[MLS] externalJoin REFUSED for ${joined.groupId.slice(0, 8)}... (base ${gi.baseEpoch},` +
          ` reason ${validation.reason ?? 'unspecified'}, group at ${validation.currentEpoch ?? '?'})` +
          ` - attempt ${attempt + 1}/${EXTERNAL_JOIN_MAX_ATTEMPTS}`
      );
      if (attempt === EXTERNAL_JOIN_MAX_ATTEMPTS - 1) {
        return {
          joined: false,
          reason: 'refused',
          serverReason: validation.reason ?? 'unspecified',
          ...(validation.currentEpoch !== undefined
            ? { serverEpoch: validation.currentEpoch }
            : {}),
        };
      }
    }
    // Unreachable - the last attempt returns above. Typed rather than asserted.
    return { joined: false, reason: 'refused', serverReason: 'unspecified' };
  }

  /**
   * Makes this device a member of a community's Graine key-distribution group, whatever state it
   * finds - the "on first use" entry point of WP-22.
   *
   * Three states, and the caller does not have to know which one it is in:
   *  - already held locally: nothing to do;
   *  - a base is published: external-join it, exactly as any other group is rejoined;
   *  - nothing published: this device is the first member in, so it CREATES the MLS group and
   *    publishes the base everyone after it will join from.
   *
   * THE THIRD CASE RACES, AND IS SETTLED WITHOUT AN ELECTION. Two devices can both find the group
   * uninitialised, and both create an MLS group under the same id at epoch 0 - so the monotonic
   * rule cannot separate them, epoch 0 being no newer than epoch 0. What separates them is who won
   * the INSERT, which the server now reports: the loser throws its group away and joins the
   * winner's. No peer has to be online for any of it.
   *
   * DISCARDING THE LOSER COSTS NOTHING ONLY IF NOTHING WAS BUILT ON IT, and this used to claim that
   * outright - "this runs before any seed is sent". It runs before any seed is sent BY THIS CALL;
   * it does not run before any seed is sent AT ALL, and a salon message concurrent with the create
   * window sealed one against the group about to be discarded. The window is now closed rather
   * than asserted away: {@link unsettledDistributionGroups} holds the group for its duration, and
   * `distributionEpochFor` refuses to mint against a group it names.
   *
   * @param ref what social-service answered: the group id, the published base or null, and the
   *   group's real epoch - which the base can be permanently behind (see {@link externalJoin})
   * @returns the outcome, distinguishable: a stale base is not a lost race
   */
  async ensureDistributionGroup(
    scope: DistributionScope,
    ref: {
      groupId: string;
      groupInfo: string | null;
      baseEpoch: number | null;
      activeEpoch: number;
    }
  ): Promise<ExternalJoinOutcome> {
    const { groupId } = ref;
    this.registerDistributionGroup(scope, groupId);

    if (holdsGroupState(this, groupId)) return { joined: true };

    if (ref.groupInfo !== null) {
      return this.externalJoin(groupId);
    }

    console.log(
      `[GRAINE] no base published for ${scopeLabel(scope)} - creating group ${groupId.slice(0, 8)}...`
    );
    // MARKED BEFORE IT EXISTS, so there is no instant at which a sender can find it both held and
    // settled. Cleared in the `finally`, on every branch: a mark outliving its window would strand
    // the scope refusing to send for the rest of the session.
    this.unsettledDistributionGroups.add(groupId);
    try {
      await this.runUnderMlsLock(() => this.createGroup(groupId));

      let published: { stored: boolean };
      try {
        const groupInfo = await this.exportGroupInfo(groupId);
        published = await this.groupInfoChannel(groupId).publish(
          toBase64(groupInfo),
          this.getEpoch(groupId)
        );
      } catch (e) {
        // The group exists locally and nobody can join it: that is worse than not having created
        // it, because the next call would find it in `getLocalGroups` and return early for ever.
        this.forgetGroup(groupId);
        console.warn(
          `[GRAINE] publishing the base for ${groupId.slice(0, 8)}... failed - group discarded:`,
          String(e).slice(0, 120)
        );
        return { joined: false, reason: 'unreachable' };
      }

      if (published.stored) return { joined: true };

      // Lost the race: another device published first and its base is what everyone else will join
      // from. Ours would fork the community in two.
      this.forgetGroup(groupId);
      console.log(
        `[GRAINE] lost the first-publish race for ${groupId.slice(0, 8)}... - joining the published base instead`
      );
      return this.externalJoin(groupId);
    } finally {
      this.unsettledDistributionGroups.delete(groupId);
    }
  }

  async addMember(
    groupId: string,
    keyPackageBytes: Uint8Array,
    excludeDeviceIds?: string[]
  ): Promise<{ welcome?: Uint8Array; ratchetTree?: Uint8Array }> {
    const result = await this.runCommitTransaction(
      groupId,
      async () => {
        const staged = await this.stageAddMembers(groupId, [keyPackageBytes]);
        return { commit: staged.commit, welcome: staged.welcome };
      },
      { excludeDeviceIds, exportTree: true }
    );
    return { welcome: result.welcome, ratchetTree: result.ratchetTree };
  }

  async addMembersBulk(
    groupId: string,
    devices: Array<{ keyPackage: Uint8Array; deviceId: string }>,
    excludeDeviceIds?: string[]
  ): Promise<{
    welcome?: Uint8Array;
    ratchetTree?: Uint8Array;
    addedDeviceIds: string[];
    skippedDeviceIds: string[];
  }> {
    return this.runCommitTransaction(
      groupId,
      async () => {
        const staged = await this.stageAddMembers(
          groupId,
          devices.map((d) => d.keyPackage)
        );
        return {
          commit: staged.commit,
          welcome: staged.welcome,
          addedDeviceIds: staged.addedIndices.map((i) => devices[i].deviceId),
          skippedDeviceIds: staged.skippedIndices.map((i) => devices[i].deviceId),
        };
      },
      { excludeDeviceIds, exportTree: true }
    );
  }

  async removeMember(groupId: string, userIds: string[]): Promise<void> {
    await this.runCommitTransaction(groupId, async () => ({
      commit: await this.stageRemoveMembers(groupId, userIds),
    }));
  }

  async removeMemberDevice(groupId: string, deviceIdentities: string[]): Promise<void> {
    await this.runCommitTransaction(groupId, async () => ({
      commit: await this.stageRemoveMembersByDevice(groupId, deviceIdentities),
    }));
  }

  abstract processWelcome(welcomeBytes: Uint8Array, ratchetTreeBytes?: Uint8Array): Promise<string>;
  /**
   * Encrypts one application message against the LIVE client, advancing this device's send ratchet.
   * Platform-specific and nothing else: every rule that has to hold around a send lives in
   * {@link sendMessage}, which is the only caller.
   */
  protected abstract encryptForSend(groupId: string, messageBytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Encrypts an application message and puts it on the wire.
   *
   * CONCRETE, AND SHARED BY BOTH PLATFORMS ON PURPOSE. Three things must happen around every send,
   * and each of them was previously the responsibility of the caller:
   *
   * - nothing leaves this device while a catch-up is open ({@link waitForCatchUpIdle}), because a
   *   send advances the ratchet of a client the catch-up is about to replace with a copy taken
   *   before it;
   * - the advance is COUNTED ({@link noteLiveMutation}), which is what lets every state-replacement
   *   seam refuse a candidate that predates it;
   * - the advance is CHECKPOINTED, because the moment the frame is on the wire the peer has consumed
   *   that generation, and a ratchet that only moved in RAM is a ratchet the next load puts back.
   *
   * It was a template method the day the third rule was found at TWO of the EIGHTEEN call sites
   * that reach a send - the sixteen others (read receipts, reactions, edits, deletes, pins, group
   * control, calls) advanced the ratchet and checkpointed nothing. A rule that each caller has to
   * remember is a rule the next caller will not, so it is enforced here or not at all.
   */
  async sendMessage(
    groupId: string,
    messageBytes: Uint8Array,
    _messageId?: string,
    frameDelivery: FrameDelivery = DELIVERY.visible
  ): Promise<Uint8Array> {
    await this.waitForCatchUpIdle();
    // ...and nothing straddles a LOCAL epoch advance either: a frame encrypted at epoch N and posted
    // after this device's own commit moved the group to N+1 is a past-epoch frame for every
    // recipient, which two further commits make undecryptable for good. The barrier deletes the
    // overlap rather than detecting it afterwards - see `epochSendBarrier`, which also carries the
    // lock order this relies on.
    return runAsEpochSend(groupId, () => this.emitFrame(groupId, messageBytes, frameDelivery));
  }

  /**
   * The frame itself: encrypt against the live client, count the advance, checkpoint it, post it.
   *
   * Split out of {@link sendMessage} only so the whole of it - encrypt AND post - sits inside one
   * barrier section. Registering just the post would leave the straddle the barrier exists to
   * delete, the stale epoch being chosen at the encrypt.
   */
  private async emitFrame(
    groupId: string,
    messageBytes: Uint8Array,
    frameDelivery: FrameDelivery
  ): Promise<Uint8Array> {
    const encryptedBytes = await this.encryptForSend(groupId, messageBytes);
    this.noteLiveMutation();
    // DURABLE, AND BEFORE THE POST. The ratchet has moved by now and stays moved whether or not the
    // POST below succeeds, so this is the only correct moment: counting a successful send instead
    // would leave every failed POST as an under-count, which is the direction that re-issues a spent
    // generation. It is what a reload recovers the advance from when the checkpoint below does not
    // land in time - the whole reason that checkpoint is allowed not to be awaited.
    noteFrameEmitted(this.userId, groupId);
    await this.checkpointAfterSend();
    const proto = toBase64(encryptedBytes);
    await this.delivery.postApplicationMessage(groupId, proto, frameDelivery);
    return encryptedBytes;
  }
  /**
   * Checkpoints the ratchet advance the send just made, and decides whether the send WAITS for it.
   *
   * THE COUNTER THAT GUARDS THIS WINDOW DOES NOT SURVIVE A PAGE LOAD. `liveMutations` and every
   * watermark compared against it are per-page-session state, initialised to 0 when the app starts;
   * the OUTBOX is durable and outlives it. So a client that sends, is reloaded before the checkpoint
   * lands, and then drains its queue encrypts those entries against a state read back from disk that
   * is behind the sends the previous session already made - and the peers refuse the frames with
   * `SecretReuseError`, reporting, correctly, that the sender's ratchet rewound. Measured on the
   * phone on 2026-08-14, twice, on a fleet with nothing else happening to it.
   *
   * The invariant is therefore: `mls.bin` is never behind a frame that has already left the device.
   * Only awaiting the checkpoint before the frame goes on the wire can hold it, because no in-memory
   * guard is present after the load that has to be defended against.
   *
   * The DEFAULT does not await, and that is web's answer on purpose: its checkpoint is an Argon2
   * round trip, and putting one on the latency of every message is not a trade worth making for a
   * fault that reconciles itself. Native overrides this - see `TauriMlsService`.
   */
  protected async checkpointAfterSend(): Promise<void> {
    scheduleOutboundMlsPersist();
  }

  abstract processIncomingMessage(
    groupId: string,
    messageBytes: Uint8Array
  ): Promise<Uint8Array | null>;
  abstract exportSecret(
    groupId: string,
    label: string,
    context: Uint8Array,
    keyLen: number
  ): Promise<Uint8Array>;
  abstract getLocalGroups(): string[];

  /** See {@link IMlsService.isGroupActive}. Platform-specific: WASM query vs Tauri `invoke`. */
  abstract isGroupActive(groupId: string): Promise<boolean>;
  abstract getEpoch(groupId: string): number;
  abstract getGroupMemberIdentities(groupId: string): Promise<string[]>;
  abstract forgetGroup(groupId: string, minEpoch?: number): void;
  abstract dropGroup(groupId: string): void;
}
