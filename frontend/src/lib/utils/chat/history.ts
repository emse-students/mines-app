import type { HistoryPage } from '$lib/mls-client/historyTypes';
import { fromBase64 } from '$lib/utils/hex';
import type { IStorage, StoredMessage } from '$lib/db';
import type { ChatMessage, Conversation, MessageReaction, ReadWatermarks } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import type { MlsDecryptSession } from '$lib/mls-client/mlsDecryptSession';
import {
  applyReplaySystemEvent,
  replayMutationIsAuthorised,
  type PendingHistoryMessage,
} from './historySystemEvents';
import { decodeAppMessage } from '$lib/proto/codec';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { chat_system_message_deleted } from '$lib/paraglide/messages';
import {
  appMsgToEnvelope,
  isOwnMessage,
  isSystemSender,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { frameFingerprint } from '$lib/mls-client/inboundFrameLedger';
import { classifyIncomingDecryptError } from '$lib/mls-client/mlsDecryptError';
import { markEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { escalateReconciliation } from '$lib/utils/chat/historyReconcile';
import { readStoredTimestampMs, toValidDate } from '$lib/utils/dates';
import { normalizeMessageId } from '$lib/utils/chat/messageUtils';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { applyReaction } from '$lib/utils/chat/messageReactions';
import { mergeReadWatermarks } from '$lib/utils/chat/readState';
import { mergeHistoryFloor } from '$lib/utils/chat/historyWindow';
import { holdsGroupState } from './groupUsability';

/** Return the localStorage key used to persist the set of already-processed ciphertext fingerprints for a group. */
function seenHistoryKey(userId: string, groupId: string): string {
  return `history_seen_cipher:${userId}:${groupId}`;
}

/** Return the localStorage key used to persist the last-processed Redis stream ID for incremental history fetching. */
function lastStreamIdKey(userId: string, groupId: string): string {
  return `history_last_stream_id:${userId}:${groupId}`;
}

/** Return the localStorage key used to persist per-ciphertext retry counters for undecryptable history frames. */
function retryCipherKey(userId: string, groupId: string): string {
  return `history_retry_cipher:${userId}:${groupId}`;
}

/**
 * Max number of separate replay runs an `epoch-gap` / `wrong-epoch` history frame may stay
 * un-seen (retryable) before it is treated as permanently undecryptable and consumed. Bounds the
 * per-sync refetch storm caused by frames that no epoch catch-up can ever resolve (an external
 * joiner's pre-join / forked-epoch ciphertexts) while still leaving room for a genuinely transient
 * gap to heal across a few reconnects. [[M2]]
 */
const MAX_HISTORY_DECRYPT_RETRIES = 6;

/**
 * Decides how a recoverable history decrypt failure (`epoch-gap` / `wrong-epoch`) should be
 * handled given how many prior replay runs already left this exact ciphertext un-seen. Returns
 * the incremented attempt count and whether the frame should stay retryable (`retry: true` -> keep
 * it un-seen so a later epoch catch-up can decrypt it) or be given up on (`retry: false` -> mark it
 * seen to stop the per-sync refetch storm from a frame no catch-up can ever resolve). [[M2]]
 */
export function nextHistoryRetryDecision(priorAttempts: number): {
  attempts: number;
  retry: boolean;
} {
  const attempts = priorAttempts + 1;
  return { attempts, retry: attempts < MAX_HISTORY_DECRYPT_RETRIES };
}

/** Load the per-ciphertext retry counters from localStorage (fingerprint -> failed-replay count). */
function loadRetryCipherCounts(userId: string, groupId: string): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(retryCipherKey(userId, groupId)) ?? '[]');
    return new Map(Array.isArray(raw) ? raw : []);
  } catch (err) {
    console.warn(
      `[HISTORY] Retry counters for ${groupId.slice(0, 8)} are unreadable, restarting from zero - ` +
        `a permanently undecryptable frame gets ${MAX_HISTORY_DECRYPT_RETRIES} more refetches: ${String(err)}`
    );
    return new Map();
  }
}

/** Persist the retry counters, capped at 2 000 entries (keeps the most-recently-touched) to bound growth. */
function saveRetryCipherCounts(userId: string, groupId: string, counts: Map<string, number>): void {
  const MAX_ENTRIES = 2000;
  const entries = [...counts.entries()];
  const bounded =
    entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
  try {
    if (bounded.length === 0) {
      localStorage.removeItem(retryCipherKey(userId, groupId));
    } else {
      localStorage.setItem(retryCipherKey(userId, groupId), JSON.stringify(bounded));
    }
  } catch (err) {
    console.warn(
      `[HISTORY] Retry counters for ${groupId.slice(0, 8)} were not persisted (${bounded.length} ` +
        `entries) - the ladder restarts at zero on the next replay: ${String(err)}`
    );
  }
}

/** Read the last-processed Redis stream ID from localStorage; returns undefined if not set. */
export function readHistoryStreamCursor(userId: string, groupId: string): string | undefined {
  return localStorage.getItem(lastStreamIdKey(userId, groupId)) ?? undefined;
}

function loadLastStreamId(userId: string, groupId: string): string | undefined {
  return readHistoryStreamCursor(userId, groupId);
}

/** Persist the latest processed Redis stream ID so the next history fetch is incremental. */
function saveLastStreamId(userId: string, groupId: string, streamId: string): void {
  try {
    localStorage.setItem(lastStreamIdKey(userId, groupId), streamId);
  } catch (err) {
    console.warn(
      `[HISTORY] Stream cursor ${streamId} for ${groupId.slice(0, 8)} was not persisted - the next ` +
        `replay refetches from the previous cursor: ${String(err)}`
    );
  }
}

/**
 * ONE set per (user, group), shared by the archive replay and by live delivery.
 *
 * The sharing is a CORRECTNESS requirement, not a saved parse. The replay loads this set when it
 * starts, mutates it for the whole walk, and writes it back once at the end. A live mark that went
 * straight to localStorage would therefore be erased by that final write - made from a copy taken
 * before the mark existed - and the false loss it exists to prevent would return at the next
 * reload, unchanged. Two writers and one durable slot is last-write-wins; the only fix is that
 * there be one object.
 */
const seenCache = new Map<string, Set<string>>();

/** Load the set of already-seen ciphertext fingerprints for a group, hydrating the shared cache once. */
function loadSeenCipherHashes(userId: string, groupId: string): Set<string> {
  const cacheKey = seenHistoryKey(userId, groupId);
  const cached = seenCache.get(cacheKey);
  if (cached) return cached;
  let hydrated: Set<string>;
  try {
    hydrated = new Set(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
  } catch (err) {
    console.warn(
      `[HISTORY] The seen-ciphertext set for ${groupId.slice(0, 8)} is unreadable, starting empty - ` +
        `every archived frame is replayed as new until it is rebuilt: ${String(err)}`
    );
    hydrated = new Set();
  }
  seenCache.set(cacheKey, hydrated);
  return hydrated;
}

/** Persist the seen-ciphertext fingerprint set to localStorage, capped at 5 000 entries to bound storage growth. */
function saveSeenCipherHashes(userId: string, groupId: string, hashes: Set<string>): void {
  // Keep the cache bounded to avoid unbounded localStorage growth.
  const MAX_HASHES = 5000;
  const arr = [...hashes];
  const bounded = arr.length > MAX_HASHES ? arr.slice(arr.length - MAX_HASHES) : arr;
  try {
    localStorage.setItem(seenHistoryKey(userId, groupId), JSON.stringify(bounded));
  } catch (err) {
    console.warn(
      `[HISTORY] The seen-ciphertext set for ${groupId.slice(0, 8)} was not persisted ` +
        `(${bounded.length} entries) - this replay is repeated in full next time: ${String(err)}`
    );
  }
}

/** Groups whose shared set holds marks not yet written, drained once at the end of the current tick. */
const pendingSeenFlush = new Map<string, { userId: string; groupId: string }>();
let seenFlushScheduled = false;

/**
 * Persist the marks accumulated on THIS tick, one write per group.
 *
 * A microtask, never a timer. It is not a delay hoping more marks turn up - it is the end of the
 * current turn, so a drain handing over forty frames pays one `JSON.stringify` instead of forty
 * over a set capped at five thousand entries, and a lone frame is still written before anything can
 * observe the gap. Nothing is load-bearing if it ran late anyway: the in-memory set is already
 * correct the instant the mark is added, and the write only has to survive a reload.
 */
function scheduleSeenFlush(userId: string, groupId: string): void {
  pendingSeenFlush.set(seenHistoryKey(userId, groupId), { userId, groupId });
  if (seenFlushScheduled) return;
  seenFlushScheduled = true;
  queueMicrotask(() => {
    seenFlushScheduled = false;
    const due = [...pendingSeenFlush.values()];
    pendingSeenFlush.clear();
    for (const entry of due) {
      const set = seenCache.get(seenHistoryKey(entry.userId, entry.groupId));
      if (set) saveSeenCipherHashes(entry.userId, entry.groupId, set);
    }
  });
}

/**
 * Record that this device has CONSUMED a frame's ratchet generation outside the archive replay.
 *
 * Live delivery and the queue drain both decrypt frames the shared archive also holds, and neither
 * moves this device's position in that archive. The replay later walks the same row, finds a
 * generation already spent, and reports it as real loss - for a message the device received
 * perfectly, displayed, and still holds. That is a false alarm on the one signal that must never
 * cry wolf, and on prod it fired on every device's own ordinary traffic.
 *
 * The mark is keyed on the frame's BYTES because they are the only thing the two paths share: an
 * archive row is addressed by a Redis stream id, a live envelope by a `queued_message` uuid, and
 * the two namespaces never intersect - the server discards the stream id at write time. The
 * ciphertext does intersect: the SAME string is written to the stream and published in the
 * envelope, with no re-encoding anywhere between them.
 *
 * NOT called from the Android background decrypt. That path loads a throwaway copy of the state and
 * never writes `mls.bin` back (`src-tauri/src/mobile/background.rs`), so the foreground genuinely
 * does read the frame again from its queue; marking it consumed there would skip a message that
 * nobody has read.
 */
export function markHistoryFrameConsumed(
  userId: string,
  groupId: string,
  fingerprint: string
): void {
  if (!userId || !groupId) return;
  const seen = loadSeenCipherHashes(userId, groupId);
  if (seen.has(fingerprint)) return;
  seen.add(fingerprint);
  scheduleSeenFlush(userId, groupId);
}

/**
 * Has this device already consumed this exact ciphertext, in ANY session?
 *
 * The mirror of {@link markHistoryFrameConsumed}, and it exists because the ledger was one-way.
 * Live delivery told the replay what it had consumed; the replay told live delivery nothing, so a
 * frame the replay had just decrypted arrived live moments later, found a spent generation, and was
 * reported as a LOST frame for a message this device was already displaying (WP-FALSELOSS-2,
 * measured on prod 2026-08-13: three MSG checks dirty, `copiesOnReceiver: 1` in the very record
 * carrying the loss).
 *
 * The in-memory ring (`hasFrameBeenProcessed`) cannot answer this. It holds 200 frames per group and
 * dies with the page, so it can only speak for what THIS session delivered live - and a consumption
 * made by the replay, or by any earlier session, is invisible to it by construction. This set is the
 * durable half, keyed on the frame's bytes for the reason spelt out above: the two paths share no
 * identifier, only the ciphertext.
 */
export function hasHistoryFrameBeenConsumed(
  userId: string,
  groupId: string,
  fingerprint: string
): boolean {
  if (!userId || !groupId) return false;
  return loadSeenCipherHashes(userId, groupId).has(fingerprint);
}

/** @internal Drops the shared sets between Vitest cases, so one case cannot answer another's question. */
export function resetSeenCipherCacheForTests(): void {
  seenCache.clear();
  pendingSeenFlush.clear();
  seenFlushScheduled = false;
}

/**
 * Converts raw StoredMessage rows (from IndexedDB, or out of a peer's history bundle) to ChatMessage
 * objects, deriving BOTH sender-relative flags - `isOwn` and `isSystem` - from `senderId`.
 *
 * `isSystem` is derived here and not read, because there is nothing to read: `StoredMessage` has no
 * such column and neither does the encrypted payload. A group notice is recognised by its sentinel
 * sender and by nothing else, so a read path that waited to be told would render every restored
 * notice as an ordinary bubble from an unresolvable author.
 */
export function mapStoredMessagesToChatMessages(storedMessages: StoredMessage[], userId: string) {
  return storedMessages.map((m) => {
    return {
      id: m.id,
      senderId: m.senderId,
      content: m.content,
      timestamp: toValidDate(readStoredTimestampMs(m.timestamp)),
      isOwn: isOwnMessage(m.senderId, userId),
      isSystem: isSystemSender(m.senderId),
      reactions: m.reactions,
      serverTimestamp: m.serverTimestamp,
      ...(m.isDeleted ? { isDeleted: true } : {}),
      ...(m.isEdited ? { isEdited: true } : {}),
      ...(m.editedAt ? { editedAt: toValidDate(m.editedAt) } : {}),
      ...(m.isFcmPreview ? { isFcmPreview: true } : {}),
    } satisfies ChatMessage;
  });
}

/**
 * Makes a replay's durable progress markers (Redis stream cursor + seen ciphertext hashes)
 * persistent. The caller MUST run this only AFTER the encrypted MLS checkpoint has flushed,
 * so durable progress can never move ahead of the durable ratchet state (otherwise a crash
 * would skip messages whose ratchet advance was lost, forcing a costly re-add).
 */
export type MlsReplayCommit = () => void;

/**
 * Replays stored ciphertext messages for a conversation: decrypts them via a paged MLS
 * decrypt session, writes the results to local DB and the reactive conversation state.
 *
 * Decryption advances the MLS ratchet but this function does NOT persist progress markers
 * itself. It returns a {@link MlsReplayCommit} thunk (or `undefined` if there is nothing to
 * commit / on failure); the caller runs the thunk after the bulk-ingest window has flushed
 * the encrypted checkpoint. Wrap calls in {@link withMlsBulkIngest} to drive that flush.
 */
/**
 * Decides whether a history replay run should flag a group as forked-behind (stale epoch gap).
 * True only when the group is held locally, replay hit an `epoch-gap` (missing commit), and the
 * local epoch did NOT advance during the replay (no catch-up commit resolved it). A transient gap
 * fixed by a commit in the same run must not be flagged, or a healthy group catching up would be
 * needlessly forgotten + re-Welcomed (churn).
 */
export function shouldFlagStaleEpochGap(
  groupWasLocal: boolean,
  sawEpochGap: boolean,
  epochBefore: number,
  epochAfter: number
): boolean {
  return groupWasLocal && sawEpochGap && epochAfter === epochBefore;
}

export async function replayConversationHistory(params: {
  mlsService: IMlsService;
  id: string;
  contactName: string;
  userId: string;
  deviceKeyB64: string;
  /** Write decrypted messages directly to local DB (DB-first architecture). */
  storage: IStorage | null;
  getConversation: (contactName: string) => Conversation | undefined;
  setConversation: (contactName: string, next: Conversation) => void;
  /** Persists the conversation's metadata row - which is where the read watermarks live. */
  saveConversation?: (contactName: string) => Promise<void>;
  messageReactions: Map<string, MessageReaction[]>;
  log: (msg: string) => void;
  /** First page already fetched (e.g. login batch history) — skipped on the first loop iteration. */
  primedFirstPage?: HistoryPage;
}): Promise<MlsReplayCommit | undefined> {
  const {
    mlsService,
    id,
    contactName,
    userId,
    deviceKeyB64,
    storage,
    getConversation,
    setConversation,
    saveConversation,
    messageReactions,
    log,
    primedFirstPage,
  } = params;

  // Stale-behind detection: a group present in local WASM whose replay hits an epoch gap
  // (missing commit) is forked behind the server. We capture the epoch on entry to tell a real
  // gap from a transient one that a catch-up commit resolves during this same replay.
  const groupWasLocal = holdsGroupState(mlsService, id);
  const epochBefore = groupWasLocal ? mlsService.getEpoch(id) : -1;
  let sawEpochGap = false;
  /**
   * A frame in this replay will never be readable here, so a peer has to re-encrypt it. Carried to
   * the end of the replay rather than acted on where it is discovered: a page can hold forty such
   * frames and they are all one difference.
   */
  let sawUnreadableFrame = false;

  /**
   * HOW MANY THEY WERE, AND A FEW BY NAME - the reasoning directly above, applied to the LOG.
   *
   * The reconciliation was already carried to the end of the replay because "a page can hold forty
   * such frames and they are all one difference"; the LINE was still printed per frame, which is the
   * same claim made forty times. Measured on 2026-08-28 during HEAL-NEW-3: 8259 of these out of 8976
   * console lines on a device enrolling into eleven groups with history - 92% of the console, all of
   * it one sentence - with a `GET /api/users/me/blocks -> 500` sitting three lines inside it that no
   * reader would have found. A device cannot read anything sent before it joined; that is the ratchet
   * working, not an incident, so the bulk is expected by construction and only its SIZE informs.
   *
   * COUNTED, NEVER SILENCED, and the fingerprints kept as a bounded sample rather than dropped: the
   * frame key is what lets a loss here be lined up with the live path's `LOST frame` line, which is
   * why it was printed at all, and a handful compares exactly as well as all of them.
   */
  let unreadableFrames = 0;
  const unreadableSample: string[] = [];
  const UNREADABLE_SAMPLE_MAX = 5;

  let session: MlsDecryptSession | null = null;
  try {
    // Incremental fetch: only retrieve messages after the last processed stream ID.
    // This avoids re-delivering messages whose ratchet keys have already been consumed
    // (which would produce TooDistantInThePast / CiphertextGenerationOutOfBounds errors).
    // Fix #7: If DB was cleared (e.g. browser storage wipe) without clearing localStorage,
    // the cursor points past messages that no longer exist locally. Reset it so the full
    // history is re-fetched.
    let afterStreamId = loadLastStreamId(userId, id);
    const cursorBeforeDbCheck = afterStreamId;
    if (afterStreamId && storage) {
      try {
        const storedMsgs = await storage.getMessages(id, deviceKeyB64);
        if (storedMsgs.length === 0) {
          try {
            localStorage.removeItem(lastStreamIdKey(userId, id));
          } catch (err) {
            console.warn(
              `[HISTORY] The stale cursor for ${id.slice(0, 8)} could not be cleared - this run ` +
                `refetches from the start anyway, the next one will not: ${String(err)}`
            );
          }
          afterStreamId = undefined;
        }
      } catch (err) {
        console.warn(
          `[HISTORY] Could not read the store for ${id.slice(0, 8)} to check the cursor against - ` +
            `proceeding with ${cursorBeforeDbCheck}, which points past a wiped store if it is one: ${String(err)}`
        );
      }
    }
    let fetchCursor = afterStreamId;
    let fetchedAnyPage = false;

    // Track the highest stream ID we process so the next sync starts from there.
    let latestStreamId: string | undefined;

    /**
     * Move this device's position past a row the replay does not need to decrypt.
     *
     * Monotonic and row-by-row on purpose: the cursor only ever advances over entries actually
     * walked, in stream order, so it can never JUMP over a frame that is genuinely missing. That is
     * why "consuming a frame live advances the archive position" is implemented as a mark plus this
     * walk rather than as a direct write of the cursor - a frame delivered live while an earlier one
     * had already fallen out of the server queue would otherwise carry the cursor past a real hole,
     * and turn a repairable gap into a permanent one.
     */
    const advancePast = (rowId?: string): void => {
      if (rowId && (!latestStreamId || rowId > latestStreamId)) latestStreamId = rowId;
    };

    const seenCipherHashes = loadSeenCipherHashes(userId, id);
    let seenUpdated = false;

    // Per-ciphertext retry ledger: how many prior replay runs left this frame un-seen because it
    // failed with a recoverable epoch-gap / wrong-epoch. Bounds the refetch storm from frames no
    // catch-up can ever resolve (external joiner's pre-join / forked-epoch ciphertexts). [[M2]]
    const retryCounts = loadRetryCipherCounts(userId, id);
    let retryUpdated = false;

    let addedMsg = 0;
    let mlsUpdated = false;

    /**
     * This device's own rows in the shared archive, skipped rather than offered to MLS.
     *
     * Counted rather than logged per row: it is the expected, structural case - the archive is one
     * stream per group and has to hold what we sent - so a line each would be exactly the noise
     * this change removes. Reported once, and only alongside a replay that did something.
     */
    let ownFramesSkipped = 0;
    /**
     * Frames belonging to a group this device has been REMOVED from.
     *
     * Counted rather than logged per frame for the same reason as `ownFramesSkipped`: an evicted
     * group's entire retained backlog arrives here, one frame at a time, and a line each would bury
     * whatever else the replay found. Counted rather than ignored because zero and "all of them"
     * are the two readings a reader needs, and only a number tells them apart.
     */
    let evictedFramesSkipped = 0;
    const myDeviceId = mlsService.getDeviceId();

    // Collect reaction mutations so we can persist them to DB in one pass after
    // the main message batch write (reactions reference messages from previous
    // sessions that are already in DB).
    const reactionUpdates = new Map<string, MessageReaction[]>(); // msgId → final state
    // delete_message / edit_message events from history: collected here and persisted
    // to DB after the main batch save so the DB reload in loadExistingConversations
    // reflects the correct state without a second network round-trip.
    // Each carries WHO claims the mutation: the author check needs the stored row, which is only
    // read after the batch save.
    const deletedMessages = new Map<string, { by: string }>();
    const editedMessages = new Map<string, { content: string; editedAt: Date; by: string }>();
    // Read state accumulated over the whole page: one instant per participant, merged as `max`,
    // applied to the conversation once at the end. It is conversation-level state, so it is not
    // affected by the batch save below at all - which is exactly what made the per-message version
    // fragile enough to need a repair pass of its own.
    const readWatermarkUpdates: ReadWatermarks = {};
    // The shared history floor the page carried, merged the same way and applied in the same write.
    // A box rather than a number, because the handler that fills it cannot reassign a local.
    const historyFloorUpdate = { at: 0 };

    // Batch-collect decoded messages to flush in one UI update at the end.
    // The reactions/isDeleted/isEdited fields are optional and come only from the
    // history_bundle path (migration) - AddMessageToChatOptions does not include them
    // because addMessageToChat does not need them (the mutations arrive via separate MLS
    // events during a normal session).
    const pendingMessages: PendingHistoryMessage[] = [];
    let historyIngestSeq = 0;
    /** Queues a decoded message into the page batch (assigns ingest order, bumps the count). */
    const pushPendingMessage = (entry: Omit<PendingHistoryMessage, 'ingestSequence'>): void => {
      pendingMessages.push({
        ...entry,
        // DERIVED HERE, ONCE, FOR EVERY WRITER THAT REACHES THIS SEAM. Two of them do: the system
        // events this replay renders itself, which pass the flag, and the history_bundle loop, which
        // copies a peer's rows verbatim and never did. The second produced a duplicated group notice
        // rendered as an ordinary bubble from "Utilisateur" - the same event the stream had already
        // replayed as a centred pill, under a different id. The flag is not the bundle's to carry:
        // the sender id already says it, and saying it twice is how the two answers came apart.
        isSystem: entry.isSystem === true || isSystemSender(entry.senderId),
        ingestSequence: historyIngestSeq++,
      });
      addedMsg++;
    };

    // Batch login may have prefetched with a cursor we just invalidated (DB wipe).
    let pendingPrimedPage: HistoryPage | undefined =
      cursorBeforeDbCheck && !afterStreamId ? undefined : primedFirstPage;
    let prefetchedNextPage: Promise<HistoryPage> | null = null;

    /**
     * THE UPPER BOUND OF THIS WALK, PINNED AT ITS FIRST PAGE - so the archive and the delivery queue
     * can never hand MLS the same frame.
     *
     * The mailbox barrier below orders the two paths at the START: nothing this device's queue held
     * is still undelivered when the walk begins. It says nothing about what arrives DURING the walk,
     * and the archive holds every frame including the queued ones - so a walk whose upper bound is
     * "the tail whenever I reach it" necessarily covers rows written while it was running, which are
     * precisely the ones live delivery is about to hand over. On a large conversation that window is
     * the whole duration of the walk.
     *
     * Bounded here, the two sets are disjoint by construction: at or below the head is the replay's,
     * above it is the queue's. The rows are not fetched, so they cost no bytes, no decrypt and no
     * ledger entry - the shared-fingerprint ledger stops being the mechanism that makes ordinary
     * traffic work and goes back to being what it was written for, the irreducible seam.
     *
     * Stopping early is always safe for this cursor: it only ever advances over rows actually
     * walked, so the next replay resumes at the head and reads what was appended since.
     */
    let walkHead: string | undefined;

    /**
     * PIN THE HEAD, EMPTY THE MAILBOX, OPEN THE SESSION - in that order, and the first two with the
     * MLS MUTEX STILL FREE.
     *
     * Two facts have to hold for the archive walk and the delivery queue never to hand MLS the same
     * ciphertext, and each closes the window the other leaves:
     *
     *  - Nothing ABOVE the head is walked. A frame sent after the pin has its row out of range, so
     *    the queue owns it alone. That half is `walkHead`, passed to every fetch.
     *  - Nothing BELOW the head is still in the mailbox when a row is processed. A frame sent before
     *    the pin has a row in range AND a queued copy, so the mailbox is emptied after the pin: live
     *    delivery marks the frame, and the fingerprint check below skips the row.
     *
     * The barrier used to run before the first FETCH, which left exactly the frames sent between
     * "mailbox empty" and "head pinned" in both sets - one HTTP round trip wide, and the window every
     * `Duplicate delivery ... already read by the archive replay` line came through.
     *
     * BUT IT MAY NOT MOVE PAST `createDecryptSession`, AND THAT IS A DEADLOCK RATHER THAN A
     * PREFERENCE. Opening the session acquires the global MLS mutex, a catch-up holds it for its
     * whole life, and the drain needs that same non-reentrant mutex for every message - so a barrier
     * awaited from inside the session waits for a drain that cannot start. Measured 2026-08-15 on
     * W2: bulk ingest opened at 14:58:44.612, the frame arrived at 14:58:45.001, its drain nested to
     * depth 2, and neither ever finished. The client stayed wedged until it was reloaded, and the
     * server saw the same event from the other side - two frames unACKed, `PUSH_DEFERRED -> FCM
     * fallback`, on a browser that has no push token.
     *
     * Both facts are therefore established here, before the session exists: pinning the head is one
     * HTTP read that touches no MLS state at all, and emptying the mailbox is precisely letting the
     * drain have the mutex.
     *
     * AND `null` IS THEREFORE THE HONEST SECOND ARGUMENT, not `id`. That parameter answers "which
     * group's catch-up session am I INSIDE", and the whole point of the three paragraphs above is
     * that this line runs while there is none - the session is opened on the NEXT statement. Naming
     * `id` here claimed a nesting that cannot exist and refused the barrier whenever a SECOND replay
     * of the same group happened to be open, which is not a deadlock: that stack releases the mutex
     * on its own, so waiting is exactly what was asked for. And the skip costs precisely the
     * guarantee this call is here to buy - the mailbox is then NOT empty when the session opens, so
     * the archive walk and the delivery queue hand MLS the same ciphertext, which is the
     * `Duplicate delivery ... already read by the archive replay` line the paragraph above is about.
     */
    pendingPrimedPage ??= await mlsService.fetchHistory(id, fetchCursor, undefined, undefined);
    walkHead = pendingPrimedPage.head;
    await mlsService.waitForMessageQueueIdle('archive replay', null).catch(() => {});

    // Paged decrypt session: the ratchet advances worker-side across pages and is committed
    // to the live client once by session.finish() (run in the outer `finally`, always).
    session = await mlsService.createDecryptSession(id);

    while (true) {
      let page: HistoryPage;
      if (pendingPrimedPage !== undefined) {
        page = pendingPrimedPage;
        pendingPrimedPage = undefined;
      } else if (prefetchedNextPage) {
        page = await prefetchedNextPage;
        prefetchedNextPage = null;
      } else {
        page = await mlsService.fetchHistory(id, fetchCursor, undefined, walkHead);
      }
      // First page only: every later fetch already carried it, and the server echoes it back.
      walkHead ??= page.head;
      const history = page.rows;
      if (history.length === 0) {
        break;
      }
      fetchedAnyPage = true;

      const pageLastId = history[history.length - 1]?.id;
      // Reaching the head IS the end of the walk - no request is spent discovering an empty page.
      const hasMore = Boolean(pageLastId && pageLastId !== fetchCursor && pageLastId !== walkHead);
      if (hasMore && pageLastId) {
        prefetchedNextPage = mlsService.fetchHistory(id, pageLastId, undefined, walkHead);
      }

      const pageDecryptWork: Array<{
        msg: (typeof history)[number];
        rowKey: string;
        bytes: Uint8Array;
      }> = [];

      for (const msg of history) {
        const rowKey = msg.id || `${msg.timestamp}:${msg.content.slice(0, 64)}`;
        if (seenCipherHashes.has(rowKey)) {
          advancePast(msg.id);
          continue;
        }
        /**
         * OUR OWN FRAME, RECOGNISED BEFORE IT IS OFFERED TO MLS.
         *
         * The shared archive must hold this device's frames - every other member reads that same
         * stream - so a replay walks them by construction, and MLS refuses every one
         * (`CannotDecryptOwnMessage`). That was the design ASKING to be told, once per frame for
         * ever, what the server already knew when it wrote the row. Measured before the fix: 5
         * certain-to-fail decrypts per MSG capture, in every capture, and thousands per full
         * replay of a 4 282-message DM.
         *
         * The USER is not the discriminator and never could be: this account's other device wrote
         * frames that are both decryptable and wanted. The device is, and the server now carries
         * it (`sender_device_id`).
         *
         * The row is marked seen so later replays answer from the cheap check above, and the
         * cursor moves past it - a frame we sent is a frame we have, by definition.
         */
        if (msg.sender_device_id && msg.sender_device_id === myDeviceId) {
          ownFramesSkipped++;
          seenCipherHashes.add(rowKey);
          seenUpdated = true;
          advancePast(msg.id);
          continue;
        }
        const bytes = fromBase64(msg.content);
        // Consumed already by live delivery or by the queue drain, which read this frame without
        // ever touching this cursor. Recognised by its bytes - `markHistoryFrameConsumed` says why
        // no identifier is shared between the two paths. Folded into the stream-id key on first
        // sight, so every later replay answers from the cheap check above and the position keeps
        // moving past it without decoding anything.
        if (seenCipherHashes.has(frameFingerprint(bytes))) {
          seenCipherHashes.add(rowKey);
          seenUpdated = true;
          advancePast(msg.id);
          continue;
        }
        pageDecryptWork.push({ msg, rowKey, bytes });
      }

      const batchResults =
        pageDecryptWork.length > 0
          ? await session.decryptPage(pageDecryptWork.map((w) => w.bytes))
          : [];

      /**
       * EVERY GENERATION THIS PAGE SPENDS IS SPENT AS OF THE LINE ABOVE - so the whole page is
       * marked HERE, before a single frame is processed.
       *
       * `decryptPage` consumes the ratchet for the entire page in one call, while the loop below
       * hands each frame to the chat, decodes it, and awaits. Marking inside that loop left a window
       * between "the generation is gone" and "the ledger knows", and a frame arriving live inside it
       * looked itself up, found nothing, and was reported LOST - the residue of WP-FALSELOSS-2, and
       * measured on prod 2026-08-14 as an exactly reproducible pair: generation 520 refused and
       * called a loss, generation 521 of the SAME page recognised as a duplicate three seconds later,
       * once the loop had got that far. The mark now moves with the thing it records.
       *
       * Success only, which is the same safety argument as before: a frame that did not decrypt
       * consumed nothing, and claiming it would tell live delivery "already read" about a frame no
       * one has read - silencing the one signal that raises a repair.
       */
      for (let workIdx = 0; workIdx < pageDecryptWork.length; workIdx++) {
        if (!batchResults[workIdx]?.ok) continue;
        seenCipherHashes.add(frameFingerprint(pageDecryptWork[workIdx].bytes));
        seenUpdated = true;
      }

      for (let workIdx = 0; workIdx < pageDecryptWork.length; workIdx++) {
        const { msg, rowKey, bytes } = pageDecryptWork[workIdx];
        const batchResult = batchResults[workIdx];

        // False = epoch/ratchet gap - recoverable after resync, must not be permanently skipped.
        let skipSeenHash = false;
        let advanceStreamCursor = false;
        try {
          if (!batchResult.ok) {
            throw new Error(batchResult.error);
          }
          // The bytes were marked as consumed the moment the page was decrypted, above. What the
          // `finally` below adds is the stream id, which says "the replay is past this ROW" - a key
          // no live frame can ever look itself up by, since the two namespaces never intersect.
          const decryptedBytes = batchResult.plaintext;
          if (!decryptedBytes) continue;

          const parsed = decodeAppMessage(decryptedBytes);

          const serverMs = parseServerTimestampMs(msg.timestamp);
          const envelope = parsed ? appMsgToEnvelope(parsed, serverMs) : null;
          if (envelope) {
            pendingMessages.push({
              senderId: msg.sender_id,
              content: envelope.content,
              ...envelope.options,
              ingestSequence: historyIngestSeq++,
            });
            addedMsg++;
            mlsUpdated = true;
            continue;
          } else if (parsed?.reaction) {
            const messageId = parsed.reaction.messageId ?? '';
            const senderNorm = msg.sender_id.toLowerCase();
            const reactions = messageReactions.get(messageId) || [];
            const emoji = parsed.reaction.emoji ?? '';
            // Replay applies both legs: the frame carries `removed`, and the merge is ordered by
            // `at` rather than by the position the entry happens to hold in the stream.
            const updated = applyReaction(
              reactions,
              senderNorm,
              emoji,
              Number(parsed.reaction.at ?? 0),
              parsed.reaction.removed === true
            );
            if (!updated) continue; // already held something at least as recent - no-op
            messageReactions.set(messageId, updated);
            reactionUpdates.set(messageId, updated);
            mlsUpdated = true;
            continue;
          } else if (parsed?.system) {
            await applyReplaySystemEvent({
              parsed,
              msg,
              contactName,
              userId,
              conversationId: id,
              getConversation,
              setConversation,
              messageReactions,
              reactionUpdates,
              deletedMessages,
              editedMessages,
              readWatermarkUpdates,
              historyFloorUpdate,
              pushPendingMessage,
            });
            mlsUpdated = true;
            continue;
          }
        } catch (err) {
          const kind = classifyIncomingDecryptError(err);
          if (kind === 'own-message') {
            // MLS gives no echo of our own message; there is nothing to read and nothing is lost.
            //
            // THIS IS NOW THE SHIM, NOT THE MECHANISM. Rows written from 2026-08-15 carry
            // `sender_device_id` and are skipped above without ever reaching MLS; only rows older
            // than that deploy still arrive here to be classified by their refusal. It is kept for
            // exactly as long as such rows can exist - one `RETENTION_WINDOW_MS` past the deploy,
            // after which the stream cannot hold one. See `docs/wiki/legacy-compatibility.md`.
            ownFramesSkipped++;
            seenCipherHashes.add(rowKey);
            seenUpdated = true;
            continue;
          }
          if (kind === 'evicted') {
            // A frame for a group this device was REMOVED from. Unreadable for good, exactly like
            // the two below - but it is NOT a loss and must not be counted as one: we are not
            // entitled to the plaintext, so there is nothing for a reconciliation to recover and
            // asking a peer for it would be asking to be handed a group's traffic after being
            // removed from the group. Marked seen so the replay stops re-offering it, and silent
            // past one line: an evicted group's whole backlog reaches here, one frame at a time.
            evictedFramesSkipped++;
            seenCipherHashes.add(rowKey);
            seenUpdated = true;
            continue;
          }
          if (
            kind === 'secret-reuse' ||
            kind === 'past-epoch-application' ||
            kind === 'same-epoch-refusal'
          ) {
            // Unreadable for good, at one end of the ratchet or the other: the generation is spent
            // (`secret-reuse`), the epoch's secrets are gone (`past-epoch-application`, what a
            // re-joined group holds for everything sent before the join), or the frame was refused
            // at exactly the epoch it names and no later arrival changes that state
            // (`same-epoch-refusal`). Either way the frame will never decrypt - mark the ROW seen
            // or the replay reprocesses it forever.
            //
            // The third one used to reach the `else` at the bottom, which prints one line and lets
            // the `finally` consume the row. The row stopped, but the LOSS was never counted: this
            // is a real message the replay saw and will never read, and only the reconciliation
            // below can obtain it from a member who still holds it.
            const frameKey = frameFingerprint(bytes);

            /**
             * ASK AGAIN NOW. The answer from before the batch is about a world that has moved.
             *
             * The page was assembled by checking `seenCipherHashes` per row, and only THEN handed to
             * `decryptPage`. Between those two moments live delivery can read this very frame and
             * record it - seconds, on a real page - and the reasoning that used to sit here ("a frame
             * already read is skipped before ever reaching the decrypt, so anything arriving HERE is
             * a frame this device has never read") quietly assumed the two moments were one.
             *
             * This is the SAME defect as the one directly above, in the other direction: that one
             * wrote the ledger where iterating was convenient instead of where the spending happened,
             * this one READ it where the work was queued instead of where the verdict is formed.
             * Measured on prod 2026-08-14 - three consecutive runs of `msg1 --cold` then `msg1b`, each
             * with one frame refused by both paths while `copiesOnReceiver` stayed 1 and the
             * reconciliation it triggered answered `same state - nothing to do`.
             *
             * Re-asking costs one hash of bytes already in hand, and only on a frame that has just
             * failed to decrypt - never on the hot path.
             */
            if (seenCipherHashes.has(frameKey)) {
              seenCipherHashes.add(rowKey);
              seenUpdated = true;
              console.debug(
                `[History] frame already read live while this page was decrypting - not a loss (group ${id}, frame ${frameKey})`
              );
              continue;
            }

            // Nothing here has read these bytes, at either moment asked. That is real loss, and a
            // reconciliation is the only thing that can recover it. A false positive costs exactly
            // one comparison, which is what makes reconciling on suspicion safe.
            seenCipherHashes.add(rowKey);
            seenUpdated = true;
            sawUnreadableFrame = true;
            // The FRAME key, not the row key: the live path's `LOST frame` line names the ciphertext,
            // and a line naming the Redis stream id instead cannot be compared with it. That is not a
            // hypothetical - it was the first thing the fingerprints revealed once both were printed.
            unreadableFrames += 1;
            if (unreadableSample.length < UNREADABLE_SAMPLE_MAX) unreadableSample.push(frameKey);
            /**
             * ONE OF THESE THREE KINDS IS ARITHMETIC AND TWO ARE LOSSES, AND THEY WERE PRINTED ALIKE.
             *
             * `past-epoch-application` is every frame sent before this device joined: a device that
             * joins at epoch N cannot read epoch N-1, that is the ratchet working, and a fresh device
             * meets it once per historical frame in every group at once. `secret-reuse` and
             * `same-epoch-refusal` are the opposite - a frame this device SHOULD have been able to
             * read and cannot - and they are rare: measured 0 of 8298 across HEAL-NEW-3 and -11 on
             * 2026-08-28, where the expected kind accounted for all 8298.
             *
             * So the expected kind is carried to the summary as a number and the two losses keep the
             * line that accuses. This is not a demotion of the loss: it is the loss no longer being
             * spelled identically to a device doing arithmetic, which is what made the harness's
             * severity rule fire on every fresh device and taught its reader to skip it.
             */
            if (kind !== 'past-epoch-application') {
              console.warn(
                `[History] frame never read here and unreadable for good (${kind}); will reconcile (group ${id}, frame ${frameKey}, row ${rowKey})`
              );
            }
            continue;
          }
          if (kind === 'epoch-gap' || kind === 'wrong-epoch') {
            // epoch-gap = we are BEHIND (missing a commit). Remember it so we can flag the group
            // for recovery at the end if no catch-up commit advances our epoch in this replay.
            if (kind === 'epoch-gap') sawEpochGap = true;
            const { attempts, retry } = nextHistoryRetryDecision(retryCounts.get(rowKey) ?? 0);
            if (retry) {
              // Recoverable: epoch/ratchet gap (epoch-gap), or a frame from an epoch this replay
              // has not reached yet (wrong-epoch - the commit may apply on a later load). Do NOT
              // mark it "seen" so the entry is retried at the next history load after epoch
              // resynchronization. Bounded so it cannot refetch-storm forever. [[M2]]
              skipSeenHash = true;
              retryCounts.set(rowKey, attempts);
              retryUpdated = true;
              console.warn(
                `[History] retryable ${attempts}/${MAX_HISTORY_DECRYPT_RETRIES} (${kind}): ${String(err).slice(0, 200)}`
              );
            } else {
              // Bounded retries exhausted: no epoch catch-up has resolved this frame across many
              // syncs, so it is permanently undecryptable for us (pre-join / forked epoch). Fall
              // through with skipSeenHash=false so the finally consumes it (marks seen + advances
              // the cursor), stopping the per-sync refetch storm. The `sawEpochGap` flag above
              // still lets shouldFlagStaleEpochGap escalate a genuinely stuck-behind group.
              retryCounts.delete(rowKey);
              retryUpdated = true;
              // This is the ONLY moment the app learns that history is genuinely missing rather
              // than merely late: a frame we saw, will never read, and can only obtain re-encrypted
              // from a member. The frame itself is about to be consumed and will never fail again
              // to remind us, so the replay carries the fact to its own end and reconciles there -
              // once for the whole page, whatever the number of dead frames in it.
              sawUnreadableFrame = true;
              // Counted into the same total, because the summary's claim - frames this device can
              // never read - is true of these too. It keeps its own line: it is rare, and `attempts`
              // is the part of it a reader acts on.
              unreadableFrames += 1;
              console.warn(
                `[History] permanently undecryptable after ${attempts} attempts (${kind}); marking seen and reconciling`
              );
            }
          } else {
            console.warn(`History msg error: ${err}`);
          }
        } finally {
          if (!skipSeenHash) {
            seenCipherHashes.add(rowKey);
            seenUpdated = true;
            advanceStreamCursor = true;
            // Frame resolved (decrypted) or given up on: drop any retry counter so it can never
            // linger and re-trigger a give-up on a later, unrelated cursor position.
            if (retryCounts.delete(rowKey)) retryUpdated = true;
          }
        }

        if (advanceStreamCursor && msg.id && (!latestStreamId || msg.id > latestStreamId)) {
          latestStreamId = msg.id;
        }

        if (workIdx > 0 && workIdx % 8 === 0) {
          await yieldToMainThread();
        }
      }

      // Cursor + seen hashes are NOT persisted per page here: they are deferred to the
      // returned commit thunk so they only become durable after the encrypted checkpoint.
      if (!hasMore) break;
      fetchCursor = pageLastId!;
    }

    // Flush all decoded messages in a single batch DB write.
    if (pendingMessages.length > 0 && storage) {
      // Load existing DB state before the upsert so we can preserve isDeleted / isEdited
      // flags that were set by events already in seenCipherHashes (and therefore not
      // re-processed in this replay run).  Without this, saveMessages(store.put) would
      // overwrite a backup-imported deleted row with the original non-deleted content.
      const existingById = new Map<string, StoredMessage>();
      try {
        for (const m of await storage.getMessages(id, deviceKeyB64)) {
          existingById.set(m.id, m);
        }
      } catch (err) {
        console.warn(
          `[HISTORY] Could not read the stored rows for ${id.slice(0, 8)} before the batch write - ` +
            `an isDeleted or isEdited flag set by an event already seen may be overwritten with the ` +
            `original content: ${String(err)}`
        );
      }

      const toStore: StoredMessage[] = pendingMessages.map((pm) => {
        const msgId = normalizeMessageId(pm.messageId) ?? crypto.randomUUID();
        const prev = existingById.get(msgId);
        return {
          id: msgId,
          conversationId: id,
          senderId: pm.senderId.toLowerCase(),
          // Preserve deleted/edited content from DB if the mutation event was already
          // processed in a prior run and is now in seenCipherHashes.
          // prev.isDeleted/isEdited : state from a previous run (seenCipherHashes).
          // pm.isDeleted/isEdited   : state carried by the history_bundle.
          // Both sources are combined so fresh installs reflect the deletions/edits
          // without having replayed the MLS events.
          content:
            prev?.isDeleted || pm.isDeleted
              ? chat_system_message_deleted()
              : prev?.isEdited
                ? prev.content
                : pm.content,
          // No lookup: this path builds rows from the bundle, and what we already hold is read from
          // `prev` above rather than searched for.
          timestamp: resolveMessageTimestamp(
            pm,
            () => undefined,
            isOwnMessage(pm.senderId, userId)
          ).getTime(),
          ...(prev?.isDeleted || pm.isDeleted ? { isDeleted: true } : {}),
          ...(prev?.isEdited || pm.isEdited ? { isEdited: true } : {}),
          // Same two sources as `content` above. What we already hold wins - it came from the edit
          // event itself - and the bundle supplies it on a fresh install, which has no row to
          // preserve it from and would otherwise show "edited" with no time for ever.
          ...(prev?.editedAt || pm.editedAt ? { editedAt: prev?.editedAt ?? pm.editedAt } : {}),
          ...((pm.reactions ?? []).length > 0 ? { reactions: pm.reactions } : {}),
          ...(pm.serverTimestamp != null ? { serverTimestamp: pm.serverTimestamp } : {}),
        };
      });
      await storage.saveMessages(toStore, deviceKeyB64);
    }

    // The conversation-level state the page carried - read watermarks and the shared floor - applied
    // in one step. Neither is part of the message pass below and neither ever was a per-message
    // concern: what they cost is one entry per participant, whether the page held ten messages or
    // ten thousand.
    const convoForRead = getConversation(contactName);
    if (convoForRead) {
      const mergedWatermarks = mergeReadWatermarks(
        convoForRead.readWatermarks,
        readWatermarkUpdates
      );
      const mergedFloor = mergeHistoryFloor(convoForRead.historyFloor, historyFloorUpdate.at);
      if (mergedWatermarks || mergedFloor !== null) {
        setConversation(contactName, {
          ...convoForRead,
          ...(mergedWatermarks ? { readWatermarks: mergedWatermarks } : {}),
          ...(mergedFloor !== null ? { historyFloor: mergedFloor } : {}),
        });
        await saveConversation?.(contactName).catch(() => {});
      }
    }

    // Single post-save read: apply reaction and delete/edit mutations in one pass.
    // All of them need the post-batch-save DB state and touch independent fields,
    // so they can be merged and written back in a single saveMessages call.
    const needsPostUpdate =
      storage && (reactionUpdates.size > 0 || deletedMessages.size > 0 || editedMessages.size > 0);
    if (needsPostUpdate) {
      try {
        const allMessages = await storage!.getMessages(id, deviceKeyB64);
        // Collect all mutations keyed by message ID, merging updates for the same message.
        const updatesById = new Map<string, StoredMessage>();

        for (const m of allMessages) {
          if (reactionUpdates.has(m.id)) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              reactions: reactionUpdates.get(m.id),
            });
          }
          // The stored row is the first place the author is known for a mutation whose message was
          // not in memory when the event was replayed, so the claim is checked HERE too - not only
          // in `applyReplaySystemEvent`.
          const deletion = deletedMessages.get(m.id);
          const edit = editedMessages.get(m.id);
          if (deletion && replayMutationIsAuthorised(m, deletion.by, 'delete')) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              isDeleted: true,
              content: chat_system_message_deleted(),
            });
          } else if (edit && replayMutationIsAuthorised(m, edit.by, 'edit')) {
            updatesById.set(m.id, {
              ...(updatesById.get(m.id) ?? m),
              isEdited: true,
              content: edit.content,
              editedAt: edit.editedAt.getTime(),
            });
          }
        }

        const toUpdate = [...updatesById.values()];
        if (toUpdate.length > 0) {
          await storage!.saveMessages(toUpdate, deviceKeyB64);
        }
      } catch (err) {
        console.warn(
          `[HISTORY] The post-save mutation pass failed for ${id.slice(0, 8)} - ` +
            `${reactionUpdates.size} reaction, ${deletedMessages.size} delete and ` +
            `${editedMessages.size} edit update(s) replayed from the archive were not stored: ${String(err)}`
        );
      }
    }

    if (mlsUpdated) {
      log(
        `[OK] ${addedMsg} message(s) caught up for ${contactName}.` +
          (ownFramesSkipped > 0 ? ` ${ownFramesSkipped} own frame(s) skipped.` : '') +
          (evictedFramesSkipped > 0
            ? ` ${evictedFramesSkipped} frame(s) skipped: removed from this group.`
            : '')
      );
    }
    // A replay that added NOTHING and skipped frames only because we are no longer a member has
    // still done something worth saying - it is the difference between an empty group and a group
    // that is no longer ours, and the branch above would report neither.
    else if (evictedFramesSkipped > 0) {
      log(
        `[OK] Nothing caught up for ${contactName}: removed from this group, ${evictedFramesSkipped} frame(s) skipped.`
      );
    }

    // Stale-behind: replay hit an epoch gap for a locally-held group and our epoch did NOT
    // advance (no catch-up commit applied). The local state is forked behind the server, but no
    // live frame will arrive to trigger the reactive escalation - register the gap so the sync
    // watchdog forces forget + re-Welcome. Without this a quiet stale group stays empty forever.
    if (shouldFlagStaleEpochGap(groupWasLocal, sawEpochGap, epochBefore, mlsService.getEpoch(id))) {
      markEpochGap(id);
      log(`[HISTORY] ${id.slice(0, 8)}… epoch gap during replay - flagged for recovery`);
    }

    if (!fetchedAnyPage) return undefined;

    // Durable progress is committed by the caller AFTER the encrypted checkpoint flush,
    // so the stream cursor / seen hashes never run ahead of the persisted ratchet state.
    return () => {
      if (latestStreamId) saveLastStreamId(userId, id, latestStreamId);
      if (seenUpdated) saveSeenCipherHashes(userId, id, seenCipherHashes);
      if (retryUpdated) saveRetryCipherCounts(userId, id, retryCounts);
    };
  } catch (err) {
    // Non-blocking: log the error and continue so other conversations still load
    log(
      `[WARN] History replay failed for ${contactName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  } finally {
    // Commit the accumulated ratchet to the live client and release the worker / mutex.
    await session?.finish();

    /**
     * AND ONLY THEN ASK A PEER - the SESSION has to be closed, not merely the page walked.
     *
     * Something in this replay is lost to this device for good, so a peer that still holds it is
     * asked, once. This used to sit above, next to the walk, under a comment claiming the store was
     * settled by then: it was not. `session.finish()` runs in this `finally`, so the catch-up was
     * still open and still holding the global MLS mutex - and `reconcileGroup`'s first act is to
     * await the mailbox barrier, which needs that same mutex for the drain. `void` does not save it:
     * the microtask runs immediately, roughly a full replay before `finish`.
     *
     * The barrier therefore refused it (`awaited from inside a catch-up session ... SKIPPED`) and the
     * ask went out against a mailbox that had never been emptied - the one ordering guarantee
     * `reconcileGroup` exists to carry, and the reason its barrier lives there rather than at the
     * connection edge. Measured on prod 2026-08-15: one such line on W1, on pass 1 of 5 of MSG, the
     * only pass that followed a boot.
     *
     * Raised from the `finally` rather than the try, so a replay that threw mid-walk still asks: it
     * saw the unreadable frame either way, and that is what the ask is about.
     */
    if (sawUnreadableFrame) {
      const sample = unreadableSample.length
        ? ` (e.g. ${unreadableSample.join(', ')}${unreadableFrames > unreadableSample.length ? ', …' : ''})`
        : '';
      log(
        `[HISTORY] ${id.slice(0, 8)}… holds ${unreadableFrames} frame(s) it can never read - reconciling${sample}`
      );
      // ESCALATES rather than asks, because this trigger carries its own evidence: a frame this
      // device holds and cannot read is proof the store is incomplete for this group, whatever any
      // peer says. So an ask already in flight is not something to defer to - if it reached a member
      // that is answering nothing, the walk moves to the next one. See `escalateReconciliation`.
      void escalateReconciliation(mlsService, id, log);
    }
  }
}

const HEX_ID_RE = /\b[0-9a-f]{64}\b/g;

/**
 * Retroactively resolves 64-char hex user IDs baked into stored system message
 * content (e.g. "abc…def added xyz…uvw to the group") that were stored before
 * async name resolution was applied. Updates the local DB so future loads are
 * already clean.
 */
export async function retroactivelyResolveHexIds(
  messages: ChatMessage[],
  storage: IStorage | null,
  conversationId: string,
  deviceKeyB64: string
): Promise<ChatMessage[]> {
  const hexIds = new Set<string>();
  for (const m of messages) {
    if (m.isSystem) {
      for (const id of m.content.match(HEX_ID_RE) ?? []) hexIds.add(id);
    }
  }
  if (hexIds.size === 0) return messages;

  const getName = await resolveDisplayNames([...hexIds]);

  const updated = messages.map((m) => {
    if (!m.isSystem) return m;
    const newContent = m.content.replace(HEX_ID_RE, (id) => getName(id));
    return newContent === m.content ? m : { ...m, content: newContent };
  });

  if (storage) {
    const toSave: StoredMessage[] = updated
      .filter((m, i) => m !== messages[i])
      .map((m) => ({
        id: m.id,
        conversationId,
        senderId: 'system',
        content: m.content,
        timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp),
        reactions: m.reactions,
        ...(m.isDeleted ? { isDeleted: true } : {}),
        ...(m.isEdited ? { isEdited: true } : {}),
      }));
    if (toSave.length > 0) storage.saveMessages(toSave, deviceKeyB64).catch(() => {});
  }

  return updated;
}
