import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { HistoryDigest } from '$lib/utils/chat/historyManifest';
import {
  diffHistoryDigest,
  isEmptyHistoryDiff,
  selectEntryIdsForPrefixes,
} from '$lib/utils/chat/historyManifest';
import {
  historyRangeStartFor,
  readHistoryEntries,
  sendHistoryBundleForIds,
  sendHistoryCoverage,
  sendHistoryPull,
} from '$lib/utils/chat/groupActions';

/**
 * What answering a solicitation needs, and it is the same set on both roads that reach it.
 *
 * It is a plain bag rather than the caller's own context because the two callers are on opposite
 * sides of the message pipeline: `handleHistoryRequest` answers a digest it is WAITING for, and the
 * system handler answers one that arrived after that wait ended. Sharing the bag is what keeps them
 * from drifting into two diffs.
 */
export interface HistoryAnswerDeps {
  storage: IStorage | null;
  deviceKeyB64: string;
  mlsService: IMlsService;
  log: (msg: string) => void;
}

/**
 * States where OUR completeness begins, when the asker asked from below it - and says nothing
 * otherwise.
 *
 * Called at every point a device actually ANSWERS, and at none of the points where it stays silent
 * so another member takes over: silence means "ask somebody else", and a coverage line attached to
 * it would tell the asker we answered when we did not.
 */
export async function stateOurCoverage(params: {
  groupId: string;
  selfIdentity: string;
  requesterIdentity: string;
  since: number;
  deps: HistoryAnswerDeps;
}): Promise<void> {
  const { groupId, selfIdentity, requesterIdentity, since, deps } = params;
  const coveredFrom = await historyRangeStartFor(groupId, deps.storage);
  if (coveredFrom <= since) return;
  await sendHistoryCoverage(
    groupId,
    { from: selfIdentity, to: requesterIdentity, since, coveredFrom },
    deps
  );
}

/**
 * Answers a digest: diff it against our store, send what the asker lacks, ask for what we lack.
 *
 * **THE LAST LEG OF A SOLICITATION, AND IT NEEDS NOTHING REMEMBERED.** The digest carries the
 * manifest and the window the asker drew; our own store carries the rest. That is why this is a
 * function and not a continuation inside the wait that asked for it: a digest that arrives after
 * the responder stopped waiting is still a complete, answerable question, and dropping it cost the
 * P1 measured on 2026-09-05 - three messages missing for ever on a device that had just rejoined,
 * because its queue took 67 s to drain and the waiter lived 60 s.
 *
 * Because the diff is symmetric, this repairs BOTH devices: what we hold and it does not goes out
 * as a bundle, what it holds and we do not comes back as a pull.
 */
export async function answerHistoryDigest(params: {
  groupId: string;
  /** The device that described itself - the one this answer is addressed to. */
  requesterIdentity: string;
  /** OURS, for the legs where we are the asker. */
  selfIdentity: string;
  digest: HistoryDigest;
  /** The window the asker drew. Never recomputed here: two devices deriving it disagree. */
  since: number;
  deps: HistoryAnswerDeps;
}): Promise<void> {
  const { groupId, requesterIdentity, selfIdentity, digest, since, deps } = params;
  const { log, storage } = deps;
  const short = groupId.slice(0, 8);

  const entries = await readHistoryEntries(groupId, deps);
  if (entries === null) {
    log(`[HISTORY_REQ] ${short}... store unreadable - staying silent so another member answers`);
    return;
  }

  const diff = await diffHistoryDigest(entries, digest);
  const idsToSend =
    digest.mode === 'ids'
      ? diff.missingOnPeer
      : selectEntryIdsForPrefixes(entries, diff.pushPrefixes, digest.depth);

  // The diff is computed over our WHOLE store and clipped only on the way out, which is what keeps
  // the two sides symmetric: a stored timestamp can differ by a hair between devices (see
  // `historyManifest`), so clipping the COMPARISON would let a message near the boundary read as
  // missing on one side and present on the other, for ever. Clipping the ANSWER cannot: the worst it
  // does is decline to send something the asker did not ask for.
  await sendHistoryBundleForIds(groupId, idsToSend, deps, {
    to: requesterIdentity,
    since,
  }).catch((e) => log(`[HISTORY_BUNDLE] Diff send error to ${requesterIdentity}: ${String(e)}`));

  const idsToPull = digest.mode === 'ids' ? diff.missingLocally : [];
  if (idsToPull.length > 0 || diff.pullPrefixes.length > 0) {
    // The requester listed messages we do not have, so we ask for them on the same exchange. Nothing
    // is recorded if the answer never comes: our own next connection compares again, which is
    // strictly better evidence than a note we wrote about a moment that has passed.
    await sendHistoryPull(
      groupId,
      {
        from: selfIdentity,
        to: requesterIdentity,
        ids: idsToPull,
        prefixes: diff.pullPrefixes,
        depth: digest.mode === 'range' ? digest.depth : undefined,
        // OUR window, not the requester's. On this leg we are the asker, and the `since` that
        // arrived with its digest describes what IT wants - reusing it would cap this device at the
        // shortest window in the conversation.
        since: await historyRangeStartFor(groupId, storage),
      },
      deps
    ).catch((e) => log(`[HISTORY_PULL] Pull send error to ${requesterIdentity}: ${String(e)}`));
  }

  log(
    `[HISTORY_REQ] ${short}... diff with ${requesterIdentity}: ${idsToSend.length} to send, ${idsToPull.length + diff.pullPrefixes.length} to pull${isEmptyHistoryDiff(diff) ? ' (identical stores)' : ''}`
  );

  // Last, after everything this device had to give. The diff above names what we hold and it does
  // not, which says nothing about the range below OUR window - a device that pruned to ninety days
  // has an honest, complete answer for the last ninety days and none at all before that.
  await stateOurCoverage({ groupId, selfIdentity, requesterIdentity, since, deps });
}
