import type { ExternalJoinOutcome, IMlsService } from '$lib/mls-client/IMlsService';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import { persistMlsStateAfterMutation, purgeLocalConversationRecord } from './groupActions';
import { classifyServerStatus } from './groupLifecycle';
import { markGroupNotReady, clearGroupNotReady, readNotReadySince } from './notReadyRegistry';
import { reconcileGroup } from './historyReconcile';
import { pendingGroupExitIds } from './pendingGroupExits';
import { ensureConversationForServerGroup } from './serverGroupConversation';
import { retireConversation } from './conversations';
import { holdsGroupState } from './groupUsability';

/**
 * Minimum interval between two recovery attempts for the same not-ready group (throttle + cadence).
 * `requestReAdd` is the single recovery ACTION seam; it self-throttles to one attempt per this
 * interval regardless of how often it is invoked. The SYNC_WATCHDOG (the sole cadence owner)
 * re-invokes it every poll, and reactive paths call it on demand - all funnel through this cooldown.
 * 60s gives FCM iOS (background) time to wake a peer for the welcome_request fallback.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * A wait, in the coarsest unit that still reads: `42s`, `17m`, `3h`, `5d`.
 *
 * Coarse ON PURPOSE. This goes in a log line whose only job is to separate "this group is on its
 * first pass" from "this group has never been joined", and a millisecond count makes a reader do
 * the division. Nothing branches on it.
 */
function formatWaitedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Per-group timestamp (ms) of the last recovery attempt by {@link requestReAdd}. requestReAdd owns
 * no timer (the SYNC_WATCHDOG owns the cadence); this cooldown is the single throttle that caps
 * every caller - watchdog cadence and reactive triggers alike - to one attempt per
 * {@link RECOVERY_TIMEOUT_MS} per group.
 */
const lastReAddAt = new Map<string, number>();

/**
 * Clears the recovery cooldowns. Called at session setup so a re-login does not inherit a stale
 * throttle that would delay the first recovery attempt of the new session.
 */
export function resetReAddCooldowns(): void {
  lastReAddAt.clear();
}

/**
 * Minimal dependencies required by the recovery functions.
 * Subset of MessageHandlerDeps - the two are compatible.
 */
export interface RecoveryDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: SvelteMap<string, Conversation>;
  getSelectedContact: () => string | null;
  setSelectedContact: (id: string | null) => void;
  saveConversation: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * The conversation carrying `groupId`, found BY ITS `id` rather than by its map key.
 *
 * THE KEY IS NOT THE GROUP ID, AND THIS MODULE IS ADDRESSED BY GROUP ID. A direct conversation
 * created on THIS device is keyed by its groupId (`startNewConversation`), while one learnt from a
 * Welcome is keyed by the PEER'S USER ID (`deriveConversationIdentity`) - two conventions in one
 * map, and every `conversations.get(groupId)` in here silently missed the second. The consequences
 * were not symmetric: the idempotence check in {@link requestReAdd} stopped short-circuiting on an
 * already-`removed` conversation, and {@link stopRecovering} could never retire one, so a recovery
 * that had its terminating ANSWER went on asking anyway.
 *
 * Re-keying the store is a data migration and is not this. Reading by `id` is correct under BOTH
 * conventions, which is why the lookup that was already written this way - the phantom purge below,
 * the one place that never had the bug - is now the only one.
 */
function findByGroupId(
  conversations: SvelteMap<string, Conversation>,
  groupId: string
): [string, Conversation] | undefined {
  return [...conversations.entries()].find(([, c]) => c.id === groupId);
}

/**
 * Removes the local residue of a group CONFIRMED ABSENT from the server: forgets the residual
 * WASM MLS state (if any) and deletes the local conversation. EXCEPTION (rules 2 & 4): a
 * conversation marked `deletedRemotely` (deleted by a peer / exclusion) stays until a LOCAL
 * MANUAL DELETION, even if the server has hard-purged its row - we do not touch it.
 *
 * @returns `true` if the WASM MLS state was mutated (caller must then persist).
 */
async function purgePhantomConversation(groupId: string, deps: RecoveryDeps): Promise<boolean> {
  const entry = findByGroupId(deps.conversations, groupId);
  if (entry?.[1].lifecycle === 'removed') return false; // kept until manual local deletion
  const mutated = holdsGroupState(deps.mlsService, groupId);
  if (mutated) deps.mlsService.forgetGroup(groupId);
  if (entry) {
    await purgeLocalConversationRecord({
      conversations: deps.conversations,
      contactKey: entry[0],
      groupId,
      deleteConversation: deps.deleteConversation,
      log: deps.log,
    });
  }
  return mutated;
}

/**
 * THE TERMINATION OF A RECOVERY, and the only seam that performs one.
 *
 * Exactly two server answers END a recovery instead of deferring it: the group was TOMBSTONED, and
 * the server says WE HOLD NO MEMBERSHIP ROW. Neither can be changed by trying again, so both retire
 * the conversation - and retiring it is what makes the loop terminate on a PROOF rather than on a
 * throttle. Step 1 of {@link requestReAdd} returns immediately for a `removed` conversation, and
 * `clearGroupNotReady` drops the group from what the SYNC_WATCHDOG enumerates, so nothing re-arms it.
 *
 * Written once because the SECOND caller is the whole point. The not-a-member answer had no branch
 * at all: it arrived as a bare `false` from `externalJoin`, indistinguishable from "no GroupInfo
 * published yet", fell through to the welcome_request fallback, and was re-asked every minute for as
 * long as the group existed - a 403 and a broadcast per minute, ending only if somebody else deleted
 * the group. GRP-6 caught it on 2026-08-24 because it watches for thirty seconds after a leave.
 */
async function stopRecovering(groupId: string, reason: string, deps: RecoveryDeps): Promise<void> {
  cancelReAdd(groupId);
  clearGroupNotReady(deps.userId, groupId);
  const entry = findByGroupId(deps.conversations, groupId);
  if (!entry || entry[1].lifecycle === 'removed') return;
  deps.log(`[READD] ${groupId.slice(0, 8)}... ${reason} - marking removed`);
  await retireConversation({
    conversations: deps.conversations,
    key: entry[0],
    groupId,
    saveConversation: deps.saveConversation,
    patch: { id: groupId },
  });
}

/**
 * Recovers `groupId` when the local MLS state is absent or out of sync. Single recovery ACTION seam,
 * self-throttled via {@link RECOVERY_TIMEOUT_MS}; the SYNC_WATCHDOG drives the cadence, reactive
 * paths call it on demand. No private timer, no reboot/successor - the self-service external-commit
 * join replaced the CAS/successor machinery.
 *
 * Flow:
 *  1. Conversation already marked dead -> return (idempotent).
 *  2. Throttled (< RECOVERY_TIMEOUT_MS since the last attempt) -> return.
 *  3. Group CONFIRMED ABSENT server-side -> purge the local phantom, stop.
 *  4. Group already in local WASM -> nothing to recover (caller must forgetGroup first if forked).
 *  5. Group tombstoned (`deletedAt`) -> mark the conversation removed, stop.
 *  6. A member ALREADY OWES us a Welcome (membership still `pending`) -> ask one, stop. The
 *     external join below is not ours to make while an Add is in flight for our own leaf.
 *  7. Try the self-service external-commit join (Phase 4).
 *  8. The server REFUSED it as a non-member (`NotAGroupMemberError`) -> mark the conversation
 *     removed, stop. This is a terminating ANSWER and not a failed attempt, which is the difference
 *     between this seam terminating on a proof and terminating only when the group gets deleted.
 *  9. Any other failure -> fall back to a single welcome_request (a reachable member re-adds us).
 *     The watchdog re-invokes on its cadence.
 */
export async function requestReAdd(groupId: string, deps: RecoveryDeps): Promise<void> {
  // Idempotence: an already-dead conversation does not restart a network recovery.
  const known = findByGroupId(deps.conversations, groupId)?.[1];
  if (known?.lifecycle === 'removed') return;

  // Throttle: this seam is invoked by the watchdog every poll and by reactive paths on demand.
  // Cap it to one attempt per RECOVERY_TIMEOUT_MS per group. The marker is set only once we commit
  // to an attempt (below), so a first call is never blocked.
  const now = Date.now();
  const sinceLast = now - (lastReAddAt.get(groupId) ?? 0);
  if (sinceLast < RECOVERY_TIMEOUT_MS) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... throttled (${Math.round(sinceLast / 1000)}s ago)`);
    return;
  }

  // Entry log, and it earns its noise: the throttle above returns silently, so an attempt that got
  // stuck on one of the network calls below was indistinguishable from one that never started.
  // Measured on the device 2026-08-06 - `requestReAdd` never returned and never logged a thing.
  //
  // THE AGE IS THE HALF THAT ACCUSES. Every attempt logged the same sentence, so a group on its
  // first pass and one that had been waiting five days read identically - and the second is the
  // stranded population `reportStrandedDeviceMemberships` names hourly on the server, with nothing
  // saying it client-side. The registry already stored the instant; nothing read it.
  const notReadySince = readNotReadySince(deps.userId, groupId);
  deps.log(
    `[READD] ${groupId.slice(0, 8)}... attempt starting` +
      (notReadySince === undefined
        ? ''
        : ` (not ready for ${formatWaitedFor(now - notReadySince)})`)
  );

  const meta = await deps.mlsService.getGroupMeta(groupId).catch(() => null);
  deps.log(`[READD] ${groupId.slice(0, 8)}... getGroupMeta -> ${meta === null ? 'null' : 'ok'}`);

  // No server metadata: `getGroupMeta` returns null for both absent groups and network errors, so
  // resolve the ambiguity - `getGroupServerStatus` distinguishes a CONFIRMED ABSENT (no dm_groups
  // row) from a transient network error.
  if (meta === null) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... getGroupServerStatus…`);
    const status = classifyServerStatus(
      await deps.mlsService.getGroupServerStatus(groupId).catch(() => 'error' as const)
    );
    deps.log(`[READD] ${groupId.slice(0, 8)}... serverStatus -> ${status.kind}`);
    if (status.kind === 'absent') {
      // The group no longer exists AT ALL server-side. Purge the local phantom instead of
      // re-emitting recovery indefinitely for a group that does not exist and is invisible in the UI.
      deps.log(`[READD] ${groupId.slice(0, 8)}... absent from server (confirmed) - phantom purged`);
      cancelReAdd(groupId);
      clearGroupNotReady(deps.userId, groupId);
      if (await purgePhantomConversation(groupId, deps))
        await persistMlsStateAfterMutation(
          deps.mlsService,
          deps.userId,
          deps.deviceKeyB64,
          deps.log
        );
      return;
    }
    // Transient network error: skip this round, the watchdog retries on its cadence.
    //
    // AND IT NOW REALLY DOES SKIP. This branch fell through and attempted the join anyway, on a
    // group whose server row could not be read - so the conversation the join makes this device
    // reachable for could not be described either (see the block before `externalJoin`: `isGroup`
    // decides whether the row is a DM, and guessing it is guessing the row's name and its key).
    // Nothing is lost by waiting one cadence for an answer that is the input to both steps.
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... server metadata unreadable - deferring the join one round`
    );
    return;
  }

  if (holdsGroupState(deps.mlsService, groupId)) {
    clearGroupNotReady(deps.userId, groupId);
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... already in WASM - skip (call forgetGroup before recovery if out of sync)`
    );
    return;
  }

  // Tombstoned server-side: mark the conversation removed, stop recovering.
  if (meta?.deletedAt) {
    await stopRecovering(groupId, 'deleted server-side', deps);
    return;
  }

  // Commit to an attempt: arm the throttle and the persistent not-ready marker (the SYNC_WATCHDOG
  // enumerates it to drive the cadence).
  lastReAddAt.set(groupId, now);
  markGroupNotReady(deps.userId, groupId);

  // THE FACT THAT DECIDES WHICH OF THE TWO JOIN PATHS IS OURS, READ WHERE IT IS ALREADY WRITTEN.
  //
  // `pending` means a member has been told to Add this device and OWES it a Welcome - the state the
  // invitation flow writes the moment a link is accepted. `active` means this device joined once and
  // may since have lost its local state, which is the ONLY population the self-service external
  // join was ever written for. Both used to arrive here indistinguishable, so an invited device
  // served itself an external commit while the Add was in flight: two parties then held the same
  // leaf in the same tree, the member's `addMember` failed `DuplicateSignature`, and its handler
  // kicked our LIVE leaf - a Remove commit evicting us from the group we had just joined. Measured
  // on 2026-08-26 (GRP-4): the invitation link and this seam raced on every join by link, and the
  // joiner lost about half of them. The overlap is deleted here rather than reconciled afterwards,
  // because a ledger repairing two parties that wrote the same leaf is a witness, not a fix.
  const owed = await readWelcomeOwed(groupId, deps);
  if (owed === null) {
    // The discriminator could not be read, so neither path is known to be ours. The watchdog owns
    // the cadence and re-invokes; guessing here is the exact move this block exists to stop.
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... membership status unreadable - skipping this round`
    );
    return;
  }
  if (owed) {
    await askAMemberToReAddUs(groupId, deps, 'invited, Welcome owed by a member');
    return;
  }

  // THE ROW BEFORE THE LEAF, AND THE ORDER IS THE WHOLE OF THIS BLOCK.
  //
  // `externalJoin` PUBLISHES our leaf: from the instant it returns, every member may address this
  // group and the delivery service routes to us - while a frame arriving for a group this device
  // holds no conversation row for is answered `false` and left in the server queue. So the two
  // facts are not interchangeable, and one strictly precedes the other: a device must not become
  // REACHABLE for a group it cannot yet ROUTE for.
  //
  // It used to take its row from `discoverMissingGroups`, a different sweep over the same server
  // list, running fire-and-forget on its own cadence - so the order was decided by whichever
  // finished first. Measured on HEAL-REVOKE-4 (2026-09-06): the join won by five seconds, and the
  // member's answer to this device's OWN history solicitation - sent in the same second as the join
  // - landed in the gap. The Welcome path never had it, because `setupMessageHandler` writes the
  // row inside the lock that installs the group; this is that same step, for this path.
  //
  // A REFUSAL IS NOT A REASON TO JOIN ANYWAY. `exit-owed` is a decision this device already took
  // and terminates the recovery on that proof; the other two clear by themselves and the watchdog
  // re-invokes this seam on its cadence. Joining first would buy nothing but the window above.
  //
  // `isGroup` IS READ, NEVER DEFAULTED. It decides whether the row is a DM, which decides its
  // display name and its peer - so `undefined` is a question the server did not answer, not a
  // "no". The column is non-null server-side and the response carries the whole entity, so this
  // branch is an anomaly worth a line rather than a case to paper over with a default.
  if (meta === null || meta.isGroup === undefined) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... join deferred - the server row does not say whether this is a DM`
    );
    return;
  }
  const routable = await ensureConversationForServerGroup(
    { groupId, name: meta.name, isGroup: meta.isGroup },
    {
      mlsService: deps.mlsService,
      userId: deps.userId,
      conversations: deps.conversations,
      saveConversation: deps.saveConversation,
      owedExits: await pendingGroupExitIds(deps.storage),
      log: deps.log,
    }
  );
  if (routable === 'exit-owed') {
    // Not `stopRecovering`: there is no conversation to retire, and the exit drain - not this seam -
    // owns what happens next. Dropping the bookkeeping is what stops the watchdog enumerating a
    // group this device is on its way out of, every five seconds, for as long as the exit is owed.
    cancelReAdd(groupId);
    clearGroupNotReady(deps.userId, groupId);
    return;
  }
  if (routable !== 'existed' && routable !== 'created') {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... join deferred - nothing could route for it yet (${routable})`
    );
    return;
  }

  // Self-service external-commit join first (Phase 4): fetch the stored GroupInfo and rejoin at the
  // current epoch without a peer. On success, clear the recovery bookkeeping and return.
  deps.log(`[READD] ${groupId.slice(0, 8)}... externalJoin…`);
  let outcome: ExternalJoinOutcome;
  try {
    outcome = await deps.mlsService.externalJoin(groupId);
  } catch (e) {
    // A STATUS CODE IS AN ANSWER. The server holds no membership row for us, so there is no base to
    // join and no point asking a member to re-add us - the group's own roster is what refused. This
    // is the proof this loop never had: the refusal used to arrive as a bare `false`, land in the
    // welcome_request fallback below, and come back every minute until the group was deleted.
    if (e instanceof NotAGroupMemberError) {
      await stopRecovering(groupId, 'server holds no membership row for us', deps);
      return;
    }
    // Anything else says NOTHING about membership, so it must not retire a conversation: the
    // fallback below stays the right next move, and the log is what keeps the branch from being
    // silent on the path a real outage would take.
    deps.log(`[READD] ${groupId.slice(0, 8)}... externalJoin threw: ${String(e).slice(0, 120)}`);
    outcome = { joined: false, reason: 'unreachable' };
  }
  // The REASON is logged, not just the verdict. A chat group falls back to welcome_request for every
  // refusal - a peer can Welcome us where a distribution group has nobody to ask - so the branch
  // does not fork here; what it must not do is leave the five causes indistinguishable in the log,
  // which is where `stale_base` (a base no retry can ever use) hid as an ordinary lost race.
  deps.log(
    `[READD] ${groupId.slice(0, 8)}... externalJoin -> ${outcome.joined ? 'joined' : outcome.reason}`
  );
  if (outcome.joined) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... rejoined via external commit (self-service)`);
    clearGroupNotReady(deps.userId, groupId);
    cancelReAdd(groupId);
    // THE ROSTER SEAT IS A WORK ITEM, AND JOINING BY OURSELVES DOES NOT CLEAR IT. `pending` is what
    // `getPendingInvitations` serves to every member: leaving it behind means the next member to come
    // online calls `addMember` for a leaf that is ALREADY in the tree, gets `DuplicateSignature`, and
    // its handler kicks the live leaf we just published - which is the duplicate-leaf repair firing
    // on a device that needed no repair. The Welcome path promotes the row (`setupMessageHandler`)
    // and the inviter's path promotes it (`processPendingInvitations`); this path never did, and it
    // is the path this commit makes reachable, so it owes the same write.
    //
    // Best-effort and LOGGED rather than thrown: the join has already landed and the group is live
    // locally, so failing here costs one wrongly-served invitation, not the conversation. A swallowed
    // branch with no line is all a loss leaves.
    await deps.mlsService
      .updateInvitationStatus(deps.mlsService.getDeviceId(), deps.userId, groupId, 'active')
      .catch((e) =>
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... joined, but the roster seat is still pending: ` +
            `${String(e).slice(0, 120)} - a member may try to Add a leaf already in the tree`
        )
      );
    // External join does not go through the Welcome path that normally promotes the conversation:
    // the group is now live in WASM, so mark it active here so the UI leaves the "syncing" state
    // without waiting for a page reload.
    //
    // BY `id`, AND SAVED BY THE MAP KEY - the two are not the same string, and this call site was
    // the last one in this module still reading the map by groupId. A direct conversation learnt
    // from a Welcome is keyed by the PEER'S USER ID ({@link findByGroupId}), so for every received
    // DM this lookup missed, the promotion never happened, and the badge stayed on a conversation
    // that had just rejoined and worked - until the next login's reconciliation noticed. The write
    // that follows takes the KEY: `saveConversation(groupId)` would have persisted nothing.
    const entry = findByGroupId(deps.conversations, groupId);
    if (entry && entry[1].lifecycle !== 'active') {
      deps.conversations.set(entry[0], { ...entry[1], lifecycle: 'active' });
      await deps.saveConversation(entry[0]).catch(() => {});
    }
    // An external join lands at the current epoch WITHOUT the pre-join history, which only a member
    // can re-encrypt. Nothing has to decide whether anything is actually missing any more - this
    // very path also runs for a device that merely rotated its MLS identity and whose store, keyed
    // by user, still holds the whole conversation, and the comparison answers "we agree" for it in
    // one frame. That guess used to be a durable marker, and getting it wrong was permanent.
    await reconcileGroup(deps.mlsService, groupId, deps.log);
    deps.log(`[READD] ${groupId.slice(0, 8)}... external-join path done`);
    return;
  }

  // No GroupInfo stored yet -> ask a reachable member to re-add us via a Welcome. The SYNC_WATCHDOG
  // re-invokes this on its cadence until we rejoin. "Or not an authorized member" used to be in this
  // sentence, and it was the bug: that case cannot be answered by any member and now exits at step 8
  // instead of arriving here.
  //
  // A STALE BASE WANTS A DIFFERENT FAVOUR, AND ASKING FOR THE WRONG ONE IS WHY IT NEVER HEALED.
  // `stale_base` means the published GroupInfo names an epoch the group has left: no retry can
  // satisfy it, because only a member holding the tree can mint a new base. The shared fallback
  // asked for a Welcome instead - which MUTATES the tree, takes the group's add lock and replays the
  // duplicate-leaf race, to obtain something this device did not need. What it needs is a read-only
  // publish that takes no lock and changes no epoch, after which it serves itself on the next pass.
  //
  // MEASURED ON PRODUCTION 2026-09-04, and this is not a hypothetical population: four of the
  // forty-three groups holding a base were stale, every one by exactly ONE epoch, two of them since
  // 2026-08-30 - with three devices sitting `pending` on those two, unable to join for five days. A
  // stale base does not drain itself: only a member's next commit republishes one, and a quiet
  // conversation has no next commit.
  //
  // The re-ask is the caller's existing cadence, not a retry here: the watchdog runs this seam again
  // while the device still cannot join, and each ask is forwarded to a randomly re-elected member,
  // so a responder whose own tree is behind does not absorb the request for ever.
  if (outcome.reason === 'stale_base') {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... the published base is at epoch ${outcome.baseEpoch} and the group ` +
        `is at ${outcome.serverEpoch} - asking a member to REPUBLISH it, not to re-add us`
    );
    await deps.mlsService
      .sendBaseRefreshRequest(groupId)
      .catch((e) =>
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... base-refresh request did not reach the server: ` +
            `${String(e).slice(0, 120)}`
        )
      );
    return;
  }

  // WHAT REACHES HERE IS THEREFORE BOUNDED BY SOMETHING: a group whose base is unpublished has a
  // member who will publish one, or a peer who can send a Welcome. Nothing that reaches this line
  // any longer has a server-side answer proving the request is hopeless.
  await askAMemberToReAddUs(groupId, deps, `external join refused: ${outcome.reason}`);
}

/**
 * Answers "does a member already owe this device a Welcome for `groupId`, RIGHT NOW?" from the
 * server's own per-device membership row and the two facts the row cannot carry.
 *
 * THREE ANSWERS, AND THE THIRD IS NOT A "NO". `true` an Add is in flight for our leaf, `false`
 * nobody owes us anything that exists, `null` the question could not be asked. Collapsing `null`
 * into `false` is precisely the mistake this seam exists to stop making: it would send the invited
 * population back down the external-join path on exactly the network conditions where losing the
 * race is likeliest. `getDeviceMemberships` rejects rather than answering `[]` so that this function
 * can tell the two apart at all.
 *
 * **`pending` ALONE USED TO BE THE ANSWER, AND IT IS A STATE READ AS AN EVENT.** The row says a
 * member has been TOLD to Add this device; it says nothing about anyone doing it. So a device that
 * enrolled while nobody was online - which writes one `pending` row per conversation of its user and
 * nothing else - read "a member owes me a Welcome" about every one of them, returned here before
 * reaching the self-service external join, and asked again every 60 s for as long as it stayed open.
 * Measured on production 2026-09-03: eleven groups, ten hours, 552 requests, zero queued Welcomes,
 * `updatedAt` never moved; and reproduced on the local estate 2026-09-04 on four groups whose
 * external-join base was published the whole time. The device could have joined every one of them by
 * itself. **The gate itself is right and stays** - it is what deleted the GRP-4 duplicate-leaf race
 * of 2026-08-26 - it simply had no way to tell "in flight for 200 ms" from "registered yesterday and
 * never honoured", and the fact that separates them was already known server-side.
 *
 * **THE TWO NEW FACTS, AND WHY BOTH ARE NEEDED.** `welcomeQueued` says a Welcome is really sitting
 * in the queue for this device and this group, so it will arrive the moment delivery runs -
 * `reportStrandedDeviceMemberships` has partitioned on exactly this since 2026-09-01. `addInFlight`
 * says a member holds this group's add lock, which is the window a queued Welcome does not yet cover:
 * every Add path takes the lock BEFORE writing the roster row and releases it after the Welcome is
 * queued, so `welcomeQueued` alone would let the requester race a legitimate Add and re-open GRP-4.
 * Together they are true for every `pending` row somebody is actually working on, and false only for
 * a roster seat nothing follows.
 *
 * **A SERVER THAT DOES NOT SAY IS NOT A SERVER SAYING NO.** Both fields are optional, and a row from
 * a server that carries neither falls back to the old reading - `pending` means owed. A native client
 * ships its own frontend (`frontendDist`), so an APK older than this change talks to a server that
 * has it and vice versa; treating a missing field as `false` would hand the whole invited population
 * the external join, which is the race, not the fix.
 */
async function readWelcomeOwed(groupId: string, deps: RecoveryDeps): Promise<boolean | null> {
  try {
    const rows = await deps.mlsService.getDeviceMemberships(
      deps.userId,
      deps.mlsService.getDeviceId()
    );
    const row = rows.find((r) => r.groupId === groupId);
    if (row?.status !== 'pending') return false;

    // A server that carries neither field cannot be asked the question, so the row's status is all
    // there is - the behaviour every client had before this change.
    if (row.welcomeQueued === undefined && row.addInFlight === undefined) return true;

    const owed = row.welcomeQueued === true || row.addInFlight === true;
    if (!owed) {
      // THIS LINE IS THE DEFECT'S NAME, and it accuses. A roster seat with no Welcome and no Add in
      // flight is the population `reportStrandedDeviceMemberships` names hourly; reaching it here
      // means this device was given a seat nobody ever honoured, and the next lines are the
      // self-service join that used to be unreachable. If it is common, the inviter is dropping
      // devices - which is the P2 next door, not this seam.
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... roster seat with NO queued Welcome and NO add in flight` +
          ` - nobody owes us anything; serving ourselves`
      );
    }
    return owed;
  } catch (e) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... getDeviceMemberships threw: ${String(e).slice(0, 120)}`
    );
    return null;
  }
}

/**
 * Asks a reachable member to re-add this device by Welcome, and says WHY it was asked.
 *
 * The single seam for the only remaining way into a group this device cannot join by itself, shared
 * by the two callers that reach it for opposite reasons - one because a member already owes us the
 * Welcome, one because the external join was refused. `context` is what keeps the log honest: the
 * same request sent for those two reasons means different things, and reading "fallback" on the path
 * that is the PRIMARY one would misdescribe a healthy join as a degraded one.
 */
async function askAMemberToReAddUs(
  groupId: string,
  deps: RecoveryDeps,
  context: string
): Promise<void> {
  deps.log(`[READD] ${groupId.slice(0, 8)}... sendWelcomeRequest… (${context})`);
  await deps.mlsService
    .sendWelcomeRequest(groupId)
    .catch((e) =>
      deps.log(`[READD] welcome_request failed for ${groupId.slice(0, 8)}...: ${String(e)}`)
    );
  deps.log(
    `[READD] welcome_request sent for ${groupId.slice(0, 8)}... (cadence ${RECOVERY_TIMEOUT_MS / 1000}s)`
  );
}

/**
 * Recovery of a group whose local MLS state is FORKED BEHIND the server
 * (local epoch < server `activeEpoch`), detected via an `epoch_mismatch` commit rejection.
 *
 * Unlike `requestReAdd` alone - which skips groups still present in WASM
 * (cf. `localGroups.includes` guard) - we `forgetGroup` FIRST: the forked group leaves local
 * WASM, then `requestReAdd` rejoins it (external commit, or a welcome_request honored by an
 * up-to-date peer) at the current epoch. History is backfilled by the bundle. Without this forget,
 * the device would keep committing stale epochs that the server rejects in a loop.
 *
 * Write-side analogue (commit rejected) of the read-side epoch-gap escalation
 * (undecipherable message) in `setupMessageHandler`.
 */
export async function recoverForkedGroup(
  groupId: string,
  deps: RecoveryDeps,
  minEpoch = 0
): Promise<void> {
  deps.log(`[FORK] ${groupId.slice(0, 8)}... local state forked behind server - forget + re-add`);
  // minEpoch = known server epoch: rejects a stale re-Welcome from a diverged branch
  // (a commit queued at the old epoch must not re-fork us).
  deps.mlsService.forgetGroup(groupId, minEpoch);
  await requestReAdd(groupId, deps);
}

/**
 * Recovery of a group the SERVER refuses this device's frames for, while local WASM still holds a
 * tree for it - the roster and the tree disagree, and the server is the one that is right.
 *
 * THE ONLY SEAM ENTERED ON THE SERVER'S WORD RATHER THAN ON THIS DEVICE'S OWN, which is why it
 * exists at all. Every other entrance infers a desync from a LOCAL absence:
 * `syncConnectionAfterWsOpen` and the SYNC_WATCHDOG both ask `getLocalGroups()`, and
 * `requestReAdd` skips anything that answers yes. That test answers "do I hold a tree", never "does
 * the server accept me as a member", and a device can hold a perfectly well-formed tree for a group
 * whose `dm_device_group_memberships` row has never left `pending`. Such a device is invisible to
 * all three: it looks healthy, it is not, and nothing it encrypts can be opened by anyone.
 *
 * MEASURED ON THE LOCAL ESTATE 2026-09-04, and it is not a corner. A device re-minted after a PIN
 * reset was given a `pending` roster seat at 15:34:52 and never a Welcome. Its outbox held eight
 * messages at attempt 18-23, refused `SenderNotActive` every time and re-queued each as a
 * "transient failure"; the SYNC_WATCHDOG called `cancelReAdd` on the group every 5 s because WASM
 * held it; a full page reload did not lift it. The server names the whole population hourly -
 * `reportStrandedDeviceMemberships`, 70 pending past the window, 25 of them holding a roster seat
 * with no Welcome ever queued, the oldest since 2026-08-27. The report existed; the repair did not.
 *
 * THE FORGET IS WHAT MAKES THE SEAM REACHABLE, and it is what `requestReAdd`'s own guard asks for in
 * as many words ("call forgetGroup before recovery if out of sync"). Dropping the tree costs
 * nothing that was not already worthless - the server holds no leaf for it, so it can neither
 * encrypt for anyone nor be opened by anyone - and it is what lets `requestReAdd` reach the
 * `pending` discriminator written for exactly this population: a member owes us a Welcome, or
 * nobody does and we serve ourselves an external commit. Both were unreachable from here.
 *
 * IT IS THROTTLED ON THE SHARED COOLDOWN AND ARMS NOTHING ITSELF. The outbox re-enters on its own
 * backoff ladder, which starts at 2 s - so an unthrottled forget would discard the tree repeatedly,
 * including a Welcome that had just been processed. The check is read-only here and
 * {@link requestReAdd} still owns the marker, so one attempt per {@link RECOVERY_TIMEOUT_MS} per
 * group holds across every caller, this one included.
 *
 * The checkpoint is NOT optional: without it the forgotten tree is still in IndexedDB, and a reload
 * before the rejoin lands restores the very state this was entered to drop. That is precisely what
 * made the measured device survive a reload still stuck.
 */
export async function recoverRosterDisagreement(
  groupId: string,
  deps: RecoveryDeps
): Promise<void> {
  const sinceLast = Date.now() - (lastReAddAt.get(groupId) ?? 0);
  if (sinceLast < RECOVERY_TIMEOUT_MS) return;

  deps.log(
    `[ROSTER] ${groupId.slice(0, 8)}... the server refuses our frames while WASM holds the group` +
      ' - forgetting the tree the server has no leaf for, then re-entering recovery'
  );
  if (holdsGroupState(deps.mlsService, groupId)) {
    deps.mlsService.forgetGroup(groupId);
    await persistMlsStateAfterMutation(deps.mlsService, deps.userId, deps.deviceKeyB64, deps.log);
  }
  await requestReAdd(groupId, deps);
}

/**
 * Clears the recovery cooldown for `groupId`, so a later desync re-triggers immediately instead of
 * waiting out {@link RECOVERY_TIMEOUT_MS}.
 *
 * Called as soon as a Welcome / external join succeeds for this group.
 *
 * IT USED TO TAKE A TIMER MAP, AND NOTHING HAD ARMED ONE SINCE 2026-07-04. The timer existed to
 * schedule the `reboot` step; `reboot` was retired with the CAS/successor machinery, and the only
 * `timers.set` in the codebase went with it - leaving a map that was created, threaded through eight
 * modules, read, cleared and deleted from, and never written. `requestReAdd`'s own doc already said
 * "no private timer".
 */
export function cancelReAdd(groupId: string): void {
  lastReAddAt.delete(groupId);
}
