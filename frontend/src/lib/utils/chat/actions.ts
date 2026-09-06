import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, saveMlsState, loadMlsState, exportMlsStateAsHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  sendFullHistoryBundle,
  sendHistoryDigestRequest,
  sendHistoryRangeBundle,
  historyStateKeyFor,
  persistMlsStateAfterMutation,
  forgetMlsGroupIfPresent,
  purgeLocalConversationRecord,
  kickStaleLeaf,
  isGroupActiveOnServer,
  handleDuplicateLeafError,
} from '$lib/utils/chat/groupActions';
import {
  awaitProbe,
  digestIdentity,
  DIGEST_TTL_MS,
  noteDigestSolicited,
} from '$lib/utils/chat/historyDigestRendezvous';
import { answerHistoryDigest, stateOurCoverage } from '$lib/utils/chat/historyDiffAnswer';
import { pendingGroupExitIds } from '$lib/utils/chat/pendingGroupExits';
import { ensureConversationForServerGroup } from '$lib/utils/chat/serverGroupConversation';
import { retireConversation } from '$lib/utils/chat/conversations';
import {
  classifyServerStatus,
  decideAbsentGroupFate,
  reconcileAbsentLocalGroup,
  type GroupServerStatus,
} from '$lib/utils/chat/groupLifecycle';
import { saveBlobAs } from '$lib/utils/fileDownload';
import { holdsGroupState } from '$lib/utils/chat/groupUsability';

/**
 * Whether `userId:deviceId`'s leaf is in OUR copy of `groupId`'s ratchet tree.
 *
 * THE TREE IS THE AUTHORITY ON WHO IS IN A GROUP, and the two callers of this used to ask the
 * delivery service instead - `getGroupMembers`, which is the ROUTING table. `member_identities`'
 * own Rustdoc names that exact misuse: "a reconciliation deciding whether a leaf still belongs
 * must read this, never the routing table", and both callers are precisely such a reconciliation.
 *
 * The two answers diverge on the case both callers exist to handle. A device fresh-start clears
 * its routing rows while the tree stays full, so the routing table reports "not a member" of a
 * leaf that is sitting right there. The Add then goes out, OpenMLS declines the duplicate leaf,
 * and the caller learns by failing what the tree could have told it for free - which is the
 * `[RUST::WARN] Skipping KeyPackage already a member of the group` the campaign saw on GRP-5
 * (2026-08-23) and GRP-3 (2026-08-24), both times looking like a 1-in-5 flake. It is also a
 * network round-trip on a question whose answer is local, durable and already loaded.
 *
 * THREE ANSWERS, NOT TWO, for the same reason as {@link readLocalMembership}. `null` is "we cannot
 * say": this device does not hold the group, so the tree that would answer does not exist here.
 * Neither caller may read that as "not a leaf" without saying so out loud, so the branch logs -
 * under the CALLER's tag, because which decision it was about to inform is the useful part.
 */
async function leafIsInLocalTree(deps: {
  mlsService: Pick<IMlsService, 'getGroupMemberIdentities'>;
  groupId: string;
  userId: string;
  deviceId: string;
  /** The caller's log tag, so the line reads in the sequence it belongs to. */
  tag: string;
  log: (message: string) => void;
}): Promise<boolean | null> {
  const { mlsService, groupId, userId, deviceId, tag, log } = deps;
  try {
    const identities = await mlsService.getGroupMemberIdentities(groupId);
    // The WHOLE identity, never a bare device id: leaves are `userId:deviceId`, so a suffix or
    // substring test would let one id answer for another's.
    return identities.includes(`${userId}:${deviceId}`);
  } catch (e) {
    log(
      `${tag} Tree of ${groupId.slice(0, 8)}... unreadable, cannot say whether ${deviceId.slice(0, 12)}... is a leaf: ${String(e).slice(0, 100)}`
    );
    return null;
  }
}

/**
 * Process pending device-group invitations.
 *
 * New paradigm: ANY online device of ANY group member can add a pending device.
 * This eliminates deadlocks - the first device to reconnect handles all pending
 * invitations for groups it belongs to.
 *
 * Flow:
 * 1. Fetch all pending invitations from server (devices waiting to join groups this device is in)
 * 2. For each pending device, acquire add-lock → addMember → sendWelcome → update status
 * 3. On WrongEpoch: check if someone else already handled it → skip
 */
export async function processPendingInvitations(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  /**
   * The single recovery seam (`requestReAdd`), injected the way the outbox takes it.
   *
   * THIS PASS CAN DISCOVER THAT **THIS** DEVICE HOLDS NO STATE, and it used to answer that with a
   * bare `sendWelcomeRequest`: no self-service external join - the PRIMARY path, and the only one
   * that needs nobody online - no `readWelcomeOwed` (so it could race a member's in-flight Add into
   * the duplicate leaf that GRP-4 named), and no throttle, on a pass that runs on every connection.
   * It is a callback rather than an import because `RecoveryDeps` carries selection and persistence
   * hooks this function has no business knowing about.
   */
  requestReAdd: (groupId: string) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { mlsService, storage, userId, deviceKeyB64, conversations, requestReAdd, log } = params;

  const myDeviceId = mlsService.getDeviceId();

  // 1. Fetch pending invitations for groups where this device is a full member
  let pendingInvitations: Array<{
    id: string;
    userId: string;
    deviceId: string;
    groupId: string;
    status: string;
  }>;
  try {
    pendingInvitations = await mlsService.getPendingInvitations(userId, myDeviceId);
  } catch (e) {
    log(`[PENDING] Error fetching pending invitations: ${e}`);
    return;
  }

  if (pendingInvitations.length === 0) return;

  log(`[PENDING] ${pendingInvitations.length} pending invitation(s) to process`);

  // Group by groupId for sequential processing per group (avoids epoch races within a group)
  const byGroup = new Map<string, typeof pendingInvitations>();
  for (const inv of pendingInvitations) {
    const list = byGroup.get(inv.groupId) ?? [];
    list.push(inv);
    byGroup.set(inv.groupId, list);
  }

  let totalWelcomes = 0;

  for (const [groupId, invitations] of byGroup) {
    // "Ready to invite" = conversation active AND group present in local WASM.
    // After a recovery forgetGroup, the conversation stays active but the group
    // has left WASM: calling addMember would loop on "Group not found". We fall into the
    // not-ready branch (recovery welcome_request already in flight).
    const readyForInvites =
      conversations.get(groupId)?.lifecycle === 'active' && holdsGroupState(mlsService, groupId);
    if (!readyForInvites) {
      // Group not ready locally. If completely absent (not even an active:false placeholder),
      // send a welcome_request. A placeholder indicates the Welcome may already be in transit
      // from the queue - do not resend.
      const isAbsent = !conversations.has(groupId);
      if (isAbsent) {
        const active = await isGroupActiveOnServer(mlsService, userId, groupId);
        if (active === false) {
          log(`[PENDING] Group ${groupId} deleted or absent from server - cleaning up invitations`);
          for (const inv of invitations) {
            mlsService.deleteDeviceMembership(inv.userId, inv.deviceId, groupId).catch(() => {});
          }
        } else {
          // Group present on server but absent from local WASM -> the recovery seam, which decides
          // between joining ourselves and asking a member. The SYNC_WATCHDOG keeps re-driving it
          // until the group is back, and the seam owns all the pacing.
          requestReAdd(groupId).catch((e: unknown) =>
            log(`[PENDING] Group ${groupId} recovery request failed: ${String(e).slice(0, 120)}`)
          );
          log(`[PENDING] Group ${groupId} absent locally -> recovery requested`);
        }
      } else {
        log(`[PENDING] Group ${groupId}: local conversation not ready - skip`);
      }
      continue;
    }

    // Acquire distributed lock to prevent concurrent Add commits (default TTL = worst case
    // mobile: bulk add + Argon2 + commit + Welcomes, cf. MLS_ADD_LOCK_TTL_MS / H1).
    const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
    if (!lockAcquired) {
      log(`[PENDING] Group ${groupId}: lock held by another device - skip`);
      continue;
    }

    try {
      // ── Add pending devices ───────────────────────────────────────────────
      // Only 'pending' status exists now (stale removed - RFC 9420).
      const currentPending = invitations.filter((inv) => inv.status === 'pending');

      for (const inv of currentPending) {
        try {
          // Fetch fresh KeyPackage for the pending device. fetchUserDevices only returns
          // devices active within the last 30 days; fall back to fetchDeviceKeyPackage for
          // older ones. null from the fallback means the device was deregistered.
          // Best-effort (`.catch(() => [])`) : a network error here must not short-circuit
          // the fetchDeviceKeyPackage fallback below (empty list => try the fallback).
          const devices = await mlsService.fetchUserDevices(inv.userId).catch(() => []);
          let targetDevice = devices.find((d) => d.deviceId === inv.deviceId);
          if (!targetDevice) {
            const fallback = await mlsService
              .fetchDeviceKeyPackage(inv.userId, inv.deviceId)
              .catch(() => null);
            if (!fallback) {
              log(`[PENDING] Device ${inv.deviceId} not found (deregistered) -> cleanup`);
              mlsService.deleteDeviceMembership(inv.userId, inv.deviceId, groupId).catch(() => {});
              continue;
            }
            targetDevice = fallback;
            log(`[PENDING] KeyPackage retrieved via fallback for ${inv.deviceId} (> 30 days)`);
          }

          // Idempotence: if the device's leaf is already in the MLS tree, the invitation is
          // fulfilled - SKIP regardless of server status. Never kick here.
          //
          // An offline device will join via its already-queued Welcome when it reconnects;
          // a device that has truly lost its state will itself emit a welcome_request
          // (signal-driven path, with anti-livelock limiter in handleWelcomeRequest).
          // Proactively kicking a valid leaf is purely harmful: it inflates the epoch on
          // every sync, invalidates the queued Welcome (device receives a stale Welcome
          // -> re-welcome_request -> churn) and resends the history bundle for nothing. This
          // was the cause of repeated kick+re-add cycles on every reconnect for offline peer
          // devices (status stuck at 'pending' because they never confirm 'active').
          // Read the TREE, not the routing table - see `leafIsInLocalTree`. `=== true` because a
          // tree we could not read is not a "no": it falls through to the Add exactly as the
          // swallowed catch here used to, but says so first.
          const alreadyALeaf = await leafIsInLocalTree({
            mlsService,
            groupId,
            userId: inv.userId,
            deviceId: inv.deviceId,
            tag: '[PENDING]',
            log,
          });
          if (alreadyALeaf === true) {
            log(
              `[PENDING] ${inv.deviceId} already in tree for ${groupId} - skip (will join via queued Welcome)`
            );
            continue;
          }

          // One staged transaction (C7-A): stage the Add, validate the epoch server-side, then
          // merge + broadcast on accept (excluding the inviter self and the newly-welcomed device)
          // or roll back on reject. A rejected commit throws WITHOUT advancing the local epoch (no
          // fork) and is handled by the outer catch as a benign retryable failure; the Welcome is
          // only sent once the commit is accepted. [[C7]]
          const result = await mlsService.addMember(groupId, targetDevice.keyPackage, [
            `${inv.userId}:${inv.deviceId}`,
          ]);

          // Register member on server (upsert GroupMember row), keeping server state up to date.
          await mlsService.registerMember(groupId, inv.userId);

          // Send the Welcome + post-merge ratchet tree to the newly added device.
          if (result.welcome) {
            await mlsService.sendWelcome(
              result.welcome,
              inv.userId,
              groupId,
              inv.deviceId,
              result.ratchetTree
            );
            totalWelcomes++;
            log(`[PENDING] Welcome → ${inv.deviceId} (user: ${inv.userId}) for ${groupId}`);
          }

          // Save MLS state after the merged commit (crash-safety).
          await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

          // The new member has joined at our epoch via the Welcome; send the full history bundle
          // (APPLICATION MESSAGES, not a commit, so it does not go through validateCommit). [[C8]]
          await sendFullHistoryBundle(groupId, {
            storage,
            deviceKeyB64,
            mlsService,
            log,
            to: digestIdentity(inv.userId, inv.deviceId),
          }).catch((e) =>
            log(`[HISTORY_BUNDLE] History send error to ${inv.userId}: ${String(e)}`)
          );
        } catch (e) {
          const errStr = String(e);

          // Device already a member: invitation fulfilled (its leaf is already in our MLS tree).
          // Promote the invitation to active so the server stops re-serving this stale pending
          // row on every sync (root cause of the repeated "already a member" reprocessing every
          // login). Best-effort; on failure it is simply retried next cycle. Do not kick.
          if (errStr.includes('ALREADY_MEMBER')) {
            void mlsService
              .updateInvitationStatus(inv.deviceId, inv.userId, inv.groupId, 'active')
              .catch(() => {});
            log(
              `[PENDING] ${inv.deviceId} already a member of ${groupId.slice(0, 8)}... - invitation fulfilled, marked active`
            );
            continue;
          }

          if (errStr.includes('DuplicateSignatur')) {
            log(`[PENDING] ${inv.deviceId} already in MLS tree of ${groupId}`);
            // The kick triggered here itself generates a commit: if rejected for fork,
            // handleDuplicateLeafError surfaces the error -> we switch to recovery.
            try {
              await handleDuplicateLeafError({
                mlsService,
                groupId,
                targetUserId: inv.userId,
                targetDeviceId: inv.deviceId,
                userId,
                deviceKeyB64,
                log,
              });
            } catch (kickErr) {
              log(
                `[PENDING] Kick error for ${inv.deviceId} in ${groupId}: ${String(kickErr).slice(0, 100)}`
              );
            }
          } else if (errStr.includes('WrongEpoch') || errStr.includes('epoch_mismatch')) {
            // Transient concurrent race (gap 1): another device committed simultaneously.
            // Check if the invitation is already fulfilled; otherwise let the next cycle retry
            // (the missing commit arrives via the queue and we catch up on our own).
            log(`[PENDING] WrongEpoch for ${inv.deviceId} in ${groupId} - checking...`);
            try {
              const memberships = await mlsService.getDeviceMemberships(inv.userId, inv.deviceId);
              const m = memberships.find((x) => x.groupId === groupId);
              if (m?.status === 'active') {
                log(`[PENDING] ${inv.deviceId} already active - skip`);
                continue;
              }
            } catch (statusErr) {
              // The status read is what would have told us the invitation was already fulfilled;
              // without it the WrongEpoch below is reported as non-recoverable and retried next
              // cycle, which is correct but indistinguishable from a genuinely stuck add unless
              // the reason the check never ran is said out loud.
              log(
                `[PENDING] Membership status of ${inv.deviceId} unreadable: ${String(statusErr).slice(0, 100)}`
              );
            }
            // Say what THIS branch knows, which is the WrongEpoch race its own comment describes:
            // the epoch moved under the Add, the invitation is still pending, the next sweep
            // retries. It called itself "Non-recoverable error" and was neither - and a line that
            // overstates its severity teaches its reader to discount the tag, which `[PENDING]`
            // cannot afford across eighteen lines. The raw error text is dropped with the name: it
            // was what carried this line into the classifier's generic `epoch` rule, so a rule can
            // now be anchored and exact instead of depending on how long an error string was.
            log(
              `[PENDING] Epoch moved under the Add for ${inv.deviceId} in ${groupId} - invitation still pending, next sweep retries`
            );
          } else {
            log(`[PENDING] Add error for ${inv.deviceId} to ${groupId}: ${errStr.slice(0, 100)}`);
          }
        }
      }
    } finally {
      await mlsService.releaseAddLock(groupId).catch(() => {});
    }
  }

  if (totalWelcomes > 0) {
    log(`[PENDING] ${totalWelcomes} Welcome(s) sent.`);
  }
}

/**
 * Force re-processing of pending device invitations.
 * Clears any stale local MLS autosave so the next reload starts fresh.
 */
export function forceSyncReset(_userId: string, log: (msg: string) => void) {
  log(`[SYNC] Forced reset. Reload the page to restart pending invitation processing.`);
}

/**
 * Discovers missing groups.
 *
 * Creates local placeholders for server groups absent from the client
 * (Welcome lost, new device, etc.) and immediately drops local groups
 * absent from the server (when the server list was successfully fetched).
 *
 * IMPORTANT: the unique identifier is the pair (userId, deviceId).
 * A given userId can have multiple devices - never use userId alone
 * to identify a participant or a leaf node.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
  /** Optional: IndexedDB access to verify messages have been migrated before purge. */
  storage?: IStorage | null;
}) {
  const {
    mlsService,
    userId,
    deviceKeyB64,
    conversations,
    saveConversation,
    deleteConversation,
    log,
  } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  let serverGroups: {
    groupId: string;
    name: string;
    isGroup: boolean;
    imageMediaId?: string | null;
    deletedAt?: string | null;
  }[] = [];
  let serverFetchSucceeded = false;
  /**
   * THE LOCAL SET IS CAPTURED BEFORE THE SERVER LIST, AND THE ORDER IS THE WHOLE POINT.
   *
   * The purge below destroys the MLS tree of any local group the server did not list, so it is only
   * sound for groups that already existed when the server was asked. Reading the local set AFTER the
   * fetch - which is what this did - puts every group created DURING the fetch into the comparison
   * against a snapshot that could not possibly contain it, and the sweep then deletes the only copy
   * of a group that is seconds old. It is not a rare window: `getDismissedGroups` is awaited between
   * the two reads as well.
   *
   * MEASURED, NOT REASONED. On 2026-08-30 a group was created at 22:31:31.905 and forgotten by its
   * creator inside the same second - `[MLS] forgetGroup 50799ae8… (absent from server)` - and prod
   * still holds the row, `deletedAt` null. Five seconds later the same device asked the server
   * directly and was told the group is there, then refused its own re-entry with
   * `no_base_published`, because the base it would have external-joined was the state it had just
   * deleted. Every other member is left counted by the server and unable to open it.
   *
   * `initializeConnection` has taken both reads at one instant since WP-GRAINE-1 and says so where
   * it does it; this is the second copy of that decision, which had the guard against an unreliable
   * LIST and not the one against a list that is merely OLDER than what it is compared to.
   *
   * Capturing early can only ever SPARE a group - one that became absent during the fetch is simply
   * swept on the next pass - so the change cannot destroy anything this did not already destroy.
   */
  const localGroupsWhenTheServerWasAsked = mlsService.getLocalGroups();
  try {
    serverGroups = await mlsService.getUserGroups(userId);
    serverFetchSucceeded = true;
  } catch {
    // Continue to Phase 2 even if server fetch fails - there may be pending placeholders
  }

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Active groups only: exclude soft-deleted tombstones (kept server-side for the 90-day
  // recovery window but never re-created as local placeholders).
  const activeServerGroups = uniqueServerGroups.filter((g) => !g.deletedAt);

  // ── Orphan cleanup (server membership = source of truth) ─────────────────
  // Phase 1 - MLS WASM: drop OpenMLS trees for groupIds absent from the server.
  // Phase 2 - UI/IndexedDB: drop conversation rows (may exist without WASM state).
  // Only when getUserGroups succeeded (never purge on transient network errors).
  if (serverFetchSucceeded) {
    const serverGroupIds = new Set(uniqueServerGroups.map((g) => g.groupId));
    // Groups dismissed by THIS user (manual deletion/leave on one device): must be purged
    // on ALL their devices (rules 3 & 5), not shown with the banner.
    // Best-effort (`[]` on error -> never purge on doubt).
    const dismissedGroupIds = new Set(await mlsService.getDismissedGroups().catch(() => []));
    let mlsMutated = false;

    // Absence from `getUserGroups` is a reason to ASK, never a reason to destroy: that list answers
    // for conversations, and a community's key-distribution group is excluded from it by
    // construction. See `reconcileAbsentLocalGroup` - the same decision `initializeConnection`
    // takes, in one place, because two copies of it diverging is what WP-GRAINE-1 was.
    for (const groupId of localGroupsWhenTheServerWasAsked) {
      if (isChannelConversationId(groupId)) continue;
      if (serverGroupIds.has(groupId)) continue;
      const fate = await reconcileAbsentLocalGroup(mlsService, groupId);
      if (fate.action === 'keep') {
        log(`[DISCOVERY] MLS state kept for ${groupId.slice(0, 8)}… - ${fate.reason}`);
        continue;
      }
      if (forgetMlsGroupIfPresent(mlsService, groupId, log)) mlsMutated = true;
    }
    if (mlsMutated) {
      await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);
    }

    for (const [key, convo] of conversations.entries()) {
      if (isChannelConversationId(key)) continue;

      // Dismissed by the user (manual deletion/leave on another device). Two cases:
      //  - no longer an active member -> PURGE (rules 3 & 5), no banner. Top priority.
      //  - active member again (RE-INVITE since) -> dismiss is stale: lift it
      //    server-side and keep the conversation (re-add rule). Do NOT purge here,
      //    or we would delete a group we just re-joined.
      if (dismissedGroupIds.has(convo.id)) {
        if (!serverGroupIds.has(convo.id)) {
          log(`[DISCOVERY] UI group "${convo.name || convo.id}" dismissed by user - removing`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        log(
          `[DISCOVERY] "${convo.name || convo.id}" dismissed but we are a member again - dismiss lifted`
        );
        void mlsService.undismissGroup(convo.id).catch(() => {});
        // Let normal processing continue (active group).
      }

      if (!serverGroupIds.has(convo.id)) {
        // Fate decision centralised in `decideAbsentGroupFate` (single source shared with
        // other reconcilers). We only query the server for genuinely undecided cases: a conv
        // already `deletedRemotely` short-circuits without a network call.
        let serverStatus: GroupServerStatus = { kind: 'unknown' };
        let isStillUserMember: boolean | null = null;
        if (convo.lifecycle !== 'removed') {
          serverStatus = classifyServerStatus(await mlsService.getGroupServerStatus(convo.id));
          // Anti-race: only re-validate our actual membership on a LIVE group absent from our
          // getUserGroups snapshot (which may be stale for a group just created/joined).
          if (serverStatus.kind === 'active') {
            const userMembers = await mlsService.getGroupUserMembers(convo.id).catch(() => null);
            isStillUserMember =
              userMembers === null ? null : userMembers.some((m) => m.userId === userId);
          }
        }

        const fate = decideAbsentGroupFate({
          lifecycle: convo.lifecycle,
          serverStatus,
          isStillUserMember,
        });
        const label = convo.name || convo.id;

        if (fate.action === 'purge') {
          log(`[DISCOVERY] UI group "${label}" - ${fate.reason} - removing`);
          await purgeLocalConversationRecord({
            conversations,
            contactKey: key,
            groupId: convo.id,
            deleteConversation,
            log,
          });
          continue;
        }
        if (fate.action === 'markRemoved') {
          await retireConversation({
            conversations,
            key,
            groupId: convo.id,
            saveConversation,
          });
          log(`[DISCOVERY] UI group "${label}" ${fate.reason} - marked removed`);
          continue;
        }
        // keep
        log(`[DISCOVERY] UI group "${label}" kept - ${fate.reason}`);
        continue;
      }
    }
  }

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login. Only active groups get placeholders
  // (soft-deleted tombstones are skipped via activeServerGroups above).
  const localGroupIds = new Set([...conversations.values()].map((c) => c.id));

  // Read ONCE for the whole sweep and handed to the seam below, which owns the guard: a group this
  // device has already decided to leave is not "missing locally", it is on its way out
  // ({@link ensureConversationForServerGroup}). The question is per group, the round trip is not.
  const owedExits = await pendingGroupExitIds(params.storage);
  const missing = activeServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} server group(s) missing locally: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  // ONE construction, shared with the recovery seam that joins a group. This loop used to build the
  // row itself, and the external-commit join took its row from HERE - two sweeps over the same
  // server list, each doing half the job, with no order between them.
  for (const g of missing) {
    await ensureConversationForServerGroup(g, {
      mlsService,
      userId,
      conversations,
      saveConversation,
      owedExits,
      log,
    });
  }

  // ── Seed group name + avatar from the server (source of truth) ───────────
  // Both are re-seeded from getUserGroups on every discovery so a device that missed the
  // one-shot `groupRenamed`/`groupImageChanged` MLS message (stuck in SYNC, offline, or
  // joined late) still converges on the authoritative name/photo. Live changes still arrive
  // via the MLS system message; this is the durable fallback. Groups only - DM names are
  // peer-derived, never overwritten from the server row.
  for (const g of activeServerGroups) {
    if (!g.isGroup) continue;
    const convo = conversations.get(g.groupId);
    if (!convo) continue;
    const nextImage = g.imageMediaId ?? null;
    const serverName = g.name?.trim() ?? '';
    // Only adopt a non-empty server name that actually differs, so we never clobber a good
    // local name with an empty/placeholder server value.
    const nameChanged = serverName !== '' && serverName !== convo.name;
    const imageChanged = (convo.imageMediaId ?? null) !== nextImage;
    if (nameChanged || imageChanged) {
      conversations.set(g.groupId, {
        ...convo,
        ...(nameChanged ? { name: serverName } : {}),
        ...(imageChanged ? { imageMediaId: nextImage } : {}),
      });
      // Persist so the resolved name survives the next reload (image stays server-seeded).
      if (nameChanged) await saveConversation?.(g.groupId).catch(() => {});
    }
  }
}

/** Exports the user's full backup (conversations + messages + MLS state) as a `.canari` file. In Tauri opens a folder picker; in the browser triggers an anchor download. */
export async function exportUserBackup(params: {
  storage: IStorage;
  userId: string;
  deviceKeyB64: string;
  myDeviceId: string;
  log: (msg: string) => void;
}) {
  const { storage, userId, deviceKeyB64, myDeviceId, log } = params;
  const mlsStateHex = await exportMlsStateAsHex(userId);
  const blob = await exportBackup(storage, userId, deviceKeyB64, myDeviceId, mlsStateHex);
  const date = new Date().toISOString().split('T')[0];
  const filename = `canari-backup-${userId}-${date}.canari`;

  // One path for both runtimes: `saveBlobAs` owns the split, because an anchor download is a
  // no-op inside the Tauri WebView (no download handler on either mobile platform) and a
  // directory picker is not something Android's SAF offers in the first place.
  const saved = await saveBlobAs(
    new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
    filename
  );
  log(saved ? `[OK] Backup exported: ${filename}` : '[..] Backup export cancelled');
}

/** Imports a `.canari` backup file: decrypts conversations/messages, restores the MLS state if this is the same device, then reloads the conversation list. */
export async function importUserBackup(params: {
  file: File;
  deviceKeyB64: string;
  storage: IStorage;
  myDeviceId: string;
  userId: string;
  log: (msg: string) => void;
  reloadConversations: () => Promise<void>;
  clearConversations: () => void;
}): Promise<{ conversations: number; messages: number; isSameDevice: boolean }> {
  const {
    file,
    deviceKeyB64,
    storage,
    myDeviceId,
    userId,
    log,
    reloadConversations,
    clearConversations,
  } = params;

  const arrayBuffer = await file.arrayBuffer();
  const { data: backup, isSameDevice } = await importBackup(
    new Uint8Array(arrayBuffer),
    deviceKeyB64,
    storage,
    myDeviceId
  );

  if (isSameDevice) {
    const existingMlsState = await loadMlsState(userId);
    if (backup.mlsState && !existingMlsState) {
      await saveMlsState(userId, fromHex(backup.mlsState));
      log('MLS state restored (same device).');
    } else if (existingMlsState) {
      log('Local MLS state preserved (device already active).');
    }
  } else {
    log(
      '[WARNING] New device detected. Conversations are imported as read-only. ' +
        'Reconnect the exporting device to trigger automatic group invitation.'
    );
  }

  clearConversations();
  await reloadConversations();

  log(
    `[OK] Backup imported: ${backup.conversations.length} conversation(s), ` +
      `${backup.messages.length} message(s).`
  );

  // Returned rather than only logged: the caller has to be able to TELL the user what happened,
  // and the counts and the device verdict are the only facts the sentence needs.
  return {
    conversations: backup.conversations.length,
    messages: backup.messages.length,
    isSameDevice,
  };
}

// In-process guard: prevents the same tab from handling two welcome_requests
// for the same group concurrently (e.g. rapid retries arriving before the
// first one finishes).  Cross-device races are handled by acquireAddLock below.
const welcomeRequestInProgress = new Set<string>();

/** Re-add attempts keyed by `${groupId}:${requesterDeviceId}` within the sliding window. */
const reAddAttempts = new Map<string, { count: number; first: number }>();

/** Maximum re-add attempts for the same device within the window before suspending. */
const MAX_READD_ATTEMPTS = 3;

/** Sliding window duration for the re-add anti-livelock guard. */
const READD_WINDOW_MS = 3 * 60_000;

/** Timestamp of the last Welcome sent, keyed by `${groupId}:${requesterDeviceId}`. */
const lastWelcomeSentAt = new Map<string, number>();

/**
 * Cooldown after which a freshly-invited device is presumed "still joining".
 * While it runs, further welcome_requests from that device are ignored: its leaf is fresh,
 * not stale, and kicking it would cause UseAfterEviction on send. Must cover Welcome
 * decryption + history bundle ingestion (several seconds).
 */
const WELCOME_COOLDOWN_MS = 30_000;

/**
 * Handles a welcome_request received from a device that wants to join a group.
 *
 * Nominal case: addMember -> sendWelcome -> sendCommit.
 *
 * "Leaf already present" case: if the device was previously in the group
 * (stale, crash, etc.), its leaf node is still in the MLS tree but its
 * local state is lost. In this case:
 *   1. removeMemberDevice (kick the stale leaf)
 *   2. kickStaleDevice (reset server membership to pending)
 *   3. addMember with a fresh KeyPackage -> sendWelcome -> sendCommit
 *
 * IMPORTANT: the unique identifier is (userId, deviceId), not userId alone.
 *
 * Security: refuses to re-add a requester absent from dm_group_members (a removed user).
 * The gateway authenticates the sender but does not check their membership before relaying.
 */
export async function handleWelcomeRequest(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  requesterDeviceId: string;
  groupId: string;
  /** Called when the terminal group exists but is not ready yet (Welcome in transit). */
  onNotReady?: (terminalGroupId: string) => void;
}) {
  const {
    mlsService,
    storage,
    userId,
    deviceKeyB64,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    groupId: requestedGroupId,
    onNotReady,
  } = params;

  // Anti-self guard: the gateway broadcasts welcome_requests to ALL devices of the user,
  // including the sender. A device must never handle its own request: it would add itself
  // to the MLS tree and kick its own leaf (self-eviction), leaving the group it just created.
  if (requesterUserId === userId && requesterDeviceId === mlsService.getDeviceId()) {
    log(`[WELCOME_REQ] Request from self (${requesterDeviceId.slice(0, 12)}...) - ignored`);
    return;
  }

  const terminalId = requestedGroupId;
  const terminalMeta = await mlsService.getGroupMeta(requestedGroupId).catch(() => null);

  // Group not found on server.
  if (!terminalMeta) {
    log(`[WELCOME_REQ] Group ${requestedGroupId.slice(0, 8)}... not found - refusing`);
    return;
  }

  // Group is deleted - refuse to invite into a dead group.
  if (terminalMeta.deletedAt) {
    log(`[WELCOME_REQ] Group ${requestedGroupId.slice(0, 8)}... deleted - refusing`);
    return;
  }

  const groupId = terminalId;

  // ── Membership guard (security) ─────────────────────────────────────────────
  // The gateway authenticates the sender (no spoofing) but relays the request without checking
  // membership; we must therefore refuse here to re-add a REMOVED user. The source of truth is
  // dm_group_members (user-level): a removed user no longer has a row, whereas a legitimate
  // invited/pending user has one BEFORE emitting any welcome_request (addGroupMember /
  // acceptGroupInvite create it first). We cannot gate on group:members / the MLS tree: the very
  // purpose of a welcome_request is to serve someone absent from routing (lost WASM state).
  // Fail-closed: if the list is unavailable (network), refuse - the requester retries (60s cadence)
  // and another peer can honor it. Never re-add on doubt.
  const userMembers = await mlsService.getGroupUserMembers(groupId).catch(() => null);
  if (userMembers === null) {
    log(
      `[WELCOME_REQ] Members of ${groupId.slice(0, 8)}… unavailable - refused (requester will retry)`
    );
    return;
  }
  if (!userMembers.some((m) => m.userId === requesterUserId)) {
    log(
      `[WELCOME_REQ] ${requesterUserId} not a member of ${groupId.slice(0, 8)}… (removed) - re-add refused`
    );
    return;
  }

  // Defence in depth: verify we have a ready conversation for this terminal group.
  // If this device is not yet in the terminal group (Welcome in transit or initial sync
  // not complete), signal via onNotReady so the caller defers and retries.
  if (conversations.get(groupId)?.lifecycle !== 'active') {
    log(`[WELCOME_REQ] No ready conversation for ${groupId.slice(0, 8)}... - deferring`);
    onNotReady?.(groupId);
    return;
  }

  // Guard in-process: prevents two concurrent handles for the same group
  // in the same tab (rapid retries arrive before the first one finishes)
  if (welcomeRequestInProgress.has(groupId)) {
    log(`[WELCOME_REQ] Already in progress for ${groupId} - skip`);
    return;
  }
  welcomeRequestInProgress.add(groupId);

  // Acquire the distributed lock to prevent races with
  // processPendingInvitations on another device of the same group (default TTL, cf. H1)
  const lockAcquired = await mlsService.acquireAddLock(groupId).catch(() => false);
  if (!lockAcquired) {
    log(`[WELCOME_REQ] Lock busy for ${groupId} - another device in progress, skip`);
    welcomeRequestInProgress.delete(groupId);
    return;
  }

  try {
    const attemptKey = `${groupId}:${requesterDeviceId}`;
    const now = Date.now();

    // Post-Welcome cooldown: if we sent a Welcome to this device recently, it is almost
    // certainly still processing it (decryption + history bundle take several seconds).
    // Kicking now would evict a freshly-added leaf -> the invitee falls into
    // UseAfterEviction on send. Let it finish joining.
    const lastWelcome = lastWelcomeSentAt.get(attemptKey);
    if (lastWelcome && now - lastWelcome < WELCOME_COOLDOWN_MS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... Welcome sent ${Math.round((now - lastWelcome) / 1000)}s ago - still joining, skip`
      );
      return;
    }

    // Anti-livelock guard: limits repeated re-adds of the same device within a sliding
    // window. If the invitee loops (their published KeyPackages are orphaned from their
    // private key -> NoMatchingKeyPackage client-side), re-adding is pointless and would
    // saturate the server (Welcome + history bundle each round). The fix is client-side
    // (republish); here we simply stop looping.
    const prev = reAddAttempts.get(attemptKey);
    const attempt = prev && now - prev.first < READD_WINDOW_MS ? prev : { count: 0, first: now };
    attempt.count += 1;
    reAddAttempts.set(attemptKey, attempt);
    if (attempt.count > MAX_READD_ATTEMPTS) {
      log(
        `[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... re-added ${attempt.count - 1}x in vain on ${groupId.slice(0, 8)}... - re-add suspended (fix needed client-side)`
      );
      return;
    }

    // Fetch a fresh KeyPackage for the requesting device.
    // If absent: the device has not yet published its KP -> cannot invite it.
    // Causality is guaranteed upstream: syncConnectionAfterWsOpen does not send a
    // welcome_request until generateKeyPackage has succeeded.
    // Best-effort: a network error must not short-circuit the fetchDeviceKeyPackage fallback.
    const devices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
    let targetDevice = devices.find((d) => d.deviceId === requesterDeviceId);
    if (!targetDevice) {
      // fetchUserDevices applies a 30-day cutoff: the requesting device may be absent
      // (old device reconnecting). Retry via fetchDeviceKeyPackage, which has no cutoff -
      // same fallback as processPendingInvitations. Without this, a valid but out-of-window
      // device stays stuck (silent abandon, no re-add possible).
      const fallback = await mlsService
        .fetchDeviceKeyPackage(requesterUserId, requesterDeviceId)
        .catch(() => null);
      if (!fallback) {
        log(`[WELCOME_REQ] KeyPackage not found for ${requesterDeviceId} - aborting`);
        return;
      }
      targetDevice = fallback;
      log(`[WELCOME_REQ] KeyPackage retrieved via fallback for ${requesterDeviceId} (> 30 days)`);
    }

    // ── Check if the device's leaf is already in the MLS tree ────────────
    // Do not check status='active' here: sendWelcome marks the device active
    // optimistically before the phone processes the Welcome. If the device loses its
    // WASM state (restart, fresh-install, NoMatchingKeyPackage), it resends a
    // welcome_request while already marked 'active' server-side.
    // -> always kick + re-add when the leaf is present in the tree.
    // Read the TREE, not the routing table - see `leafIsInLocalTree`. This decides a KICK, and the
    // Rustdoc on `member_identities` is explicit that a decision to remove a leaf reads the tree.
    // `=== true` keeps the old fall-through: on an unreadable tree the Add is still attempted.
    const leafPresent = await leafIsInLocalTree({
      mlsService,
      groupId,
      userId: requesterUserId,
      deviceId: requesterDeviceId,
      tag: '[WELCOME_REQ]',
      log,
    });
    if (leafPresent === true) {
      log(`[WELCOME_REQ] ${requesterDeviceId.slice(0, 12)}... leaf in MLS tree - kick + re-add`);
      try {
        await kickStaleLeaf(groupId, requesterUserId, requesterDeviceId, mlsService, log);

        // Save MLS state after the remove commit
        await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

        // Re-fetch KeyPackage (may have changed after kick)
        // Best-effort: empty list on network error => freshDevice not found => clean skip.
        const freshDevices = await mlsService.fetchUserDevices(requesterUserId).catch(() => []);
        const freshDevice = freshDevices.find((d) => d.deviceId === requesterDeviceId);
        if (!freshDevice) {
          log(`[WELCOME_REQ] KeyPackage not found after kick for ${requesterDeviceId} - skip`);
          return;
        }
        // Update the reference for the add below
        targetDevice.keyPackage = freshDevice.keyPackage;
      } catch (e) {
        // BEHAVIOUR UNCHANGED - the Add is still attempted - but no longer silent. Whatever failed
        // here, the leaf the Add is about to collide with may still be in the tree, so the
        // DuplicateSignature that follows used to be the only trace this branch left.
        //
        // IT DOES NOT SAY "the kick failed", because `kickStaleLeaf` cannot throw - it reports its
        // own two halves and returns. Persisting the post-kick state is what reaches here, and
        // naming the kick instead would send a reader to the one call that had already spoken.
        log(
          `[WELCOME_REQ] Post-kick repair of ${requesterDeviceId.slice(0, 12)}... did not complete: ${String(e).slice(0, 100)} - attempting the add anyway`
        );
      }
    }

    // ── Add the device to the MLS group (staged transaction, C7-A) ─────
    // Stage the Add, validate the epoch server-side, then merge + broadcast on accept (excluding
    // the inviter self and the invitee) or roll back on reject. A rejected commit throws WITHOUT
    // advancing the local epoch (no fork) and is handled by the outer catch as a retryable failure;
    // the Welcome is only sent once the commit is accepted. [[C7]]
    const result = await mlsService.addMember(groupId, targetDevice.keyPackage, [
      `${requesterUserId}:${requesterDeviceId}`,
    ]);
    await mlsService.registerMember(groupId, requesterUserId);

    // Send the Welcome + post-merge ratchet tree to the requesting device.
    if (result.welcome) {
      await mlsService.sendWelcome(
        result.welcome,
        requesterUserId,
        groupId,
        requesterDeviceId,
        result.ratchetTree
      );
      lastWelcomeSentAt.set(attemptKey, Date.now());
      log(`[WELCOME_REQ] Welcome -> ${requesterUserId}:${requesterDeviceId} for ${groupId}`);
    }

    // Save MLS state after the merged commit (crash-safety).
    await persistMlsStateAfterMutation(mlsService, userId, deviceKeyB64, log);

    // Send the full history to the new member. These are APPLICATION MESSAGES (not a commit, do not
    // go through validateCommit): the recipient has already joined via the Welcome (same epoch as
    // us). The bundle arrives after the Welcome client-side (order guaranteed by MLS) and reads
    // IndexedDB. [[C8]]
    await sendFullHistoryBundle(groupId, {
      storage,
      deviceKeyB64,
      mlsService,
      log,
      to: digestIdentity(requesterUserId, requesterDeviceId),
    }).catch((e) => log(`[HISTORY_BUNDLE] History send error to ${requesterUserId}: ${String(e)}`));
  } catch (e) {
    const errStr = String(e);

    if (errStr.includes('ALREADY_MEMBER')) {
      // Device already a member: request fulfilled (will join via queued Welcome).
      log(
        `[WELCOME_REQ] ${requesterDeviceId} already a member of ${groupId.slice(0, 8)}... - skip`
      );
    } else if (errStr.includes('DuplicateSignatur')) {
      try {
        await handleDuplicateLeafError({
          mlsService,
          groupId,
          targetUserId: requesterUserId,
          targetDeviceId: requesterDeviceId,
          userId,
          deviceKeyB64,
          log,
        });
      } catch (kickErr) {
        log(`[WELCOME_REQ] Kick error for ${requesterDeviceId}: ${String(kickErr).slice(0, 100)}`);
      }
    } else {
      log(`[WELCOME_REQ] Error for ${requesterDeviceId}: ${errStr.slice(0, 100)}`);
    }
  } finally {
    await mlsService.releaseAddLock(groupId).catch(() => {});
    welcomeRequestInProgress.delete(groupId);
  }
}

/**
 * How long the elected responder waits for the MLS half of a solicitation.
 *
 * The two halves travel by different transports - the election over the WebSocket, the probe inside
 * MLS - and nothing orders them, so the responder has to wait for an EVENT rather than guess a
 * delay. The bound on that wait is the one duration a probe already has: beyond `DIGEST_TTL_MS` it
 * describes a store that has moved and would be refused anyway.
 *
 * Reaching it is not a tuning question. It means the MLS frame never arrived, and the answer to that
 * is silence: the requester asks again on its next edge, which costs one small frame, where
 * answering a device that named nothing means dumping a whole store on a peer that may need none of
 * it. That fallback is what this rework removed.
 */
const HISTORY_PROBE_WAIT_MS = DIGEST_TTL_MS;

/**
 * Handles an incoming history_request: a device asks whether it holds the same history as us, and
 * for whatever it turns out to be missing. We are already co-members (it is in the MLS tree), so we
 * only resend messages re-encrypted at the current epoch - no re-add, no commit. Guarded to active
 * members holding the group locally; the delivery service already picks a single online responder,
 * so no throttle is needed here.
 *
 * **THE ANSWER DEPENDS ON WHICH PROBE ARRIVES**, and there are three:
 *
 * - `state` - a 64-bit key over the asker's window. We compute ours over the SAME window and, when
 *   they match, say NOTHING AT ALL. That is the common case on every connection of every device,
 *   and it costs one frame and no store read on either side. When they differ we ask for a digest
 *   and the exchange continues below;
 * - `digest` - the hierarchical manifest, either as the second leg of the above or from a device
 *   that went straight to it. We diff it against our store and send what it lacks;
 * - `range` - scrollback, a bounded page below what the asker holds.
 *
 * **We answer from a settled store.** `waitForMessageQueueIdle` is awaited first because an
 * external-commit self-join lands the requester one epoch ahead of a peer that has not yet applied
 * its commit, and a bundle re-encrypted at the old epoch is undecryptable to it and wasted. The
 * requester used to compensate with a 2.5 s pause before asking - a delay standing in for an
 * ordering neither side could observe. The ordering IS observable, on this side, and this is it.
 *
 * Because the diff is symmetric, the same exchange also tells US what the requester has and we do
 * not, so one solicitation repairs both devices instead of pushing history one way.
 */
export async function handleHistoryRequest(params: {
  mlsService: IMlsService;
  storage: IStorage | null;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  requesterUserId: string;
  /** The requesting DEVICE - a user with several devices must be answered on the right one. */
  requesterDeviceId: string;
  /** OUR user id - the responder's, not the requester's. */
  selfUserId: string;
  groupId: string;
  /** Overridable for tests only. */
  probeWaitMs?: number;
}): Promise<void> {
  const {
    mlsService,
    storage,
    deviceKeyB64,
    conversations,
    log,
    requesterUserId,
    requesterDeviceId,
    selfUserId,
    groupId,
    probeWaitMs = HISTORY_PROBE_WAIT_MS,
  } = params;
  const short = groupId.slice(0, 8);
  if (!holdsGroupState(mlsService, groupId)) {
    log(`[HISTORY_REQ] ${short}... not local - cannot serve history, skip`);
    return;
  }
  if (conversations.get(groupId)?.lifecycle !== 'active') {
    log(`[HISTORY_REQ] ${short}... not active locally - skip`);
    return;
  }

  const deps = { storage, deviceKeyB64, mlsService, log };
  const requesterIdentity = digestIdentity(requesterUserId, requesterDeviceId);
  const selfIdentity = digestIdentity(selfUserId, mlsService.getDeviceId());

  // WHEN THE ELECTION REACHED US, taken before any await. Every probe older than this belongs to an
  // earlier ask - this device stores every probe it can decrypt, elected or not - and answering with
  // one would compare against a state key up to `DIGEST_TTL_MS` old. See `awaitProbe`.
  //
  // The asker ORDERS the two - `reconcileGroup` awaits the election's HTTP response before sending
  // the probe, and the server publishes the election before answering that request - so a probe for
  // THIS ask should postdate this line. `awaitProbe` treats that as a preference and not a rule: if
  // the order is ever broken it waits, then uses the older probe anyway rather than going silent.
  const electedAt = Date.now();

  // Answer from a settled store, not from one still being written - see the note above.
  // `null`: this leg is already deferred past the drain by `answerAfterMailboxDrained` and owns no
  // catch-up session, so a session open on this group belongs to somebody else and will close.
  await mlsService.waitForMessageQueueIdle('history request answer', null).catch(() => {});

  let probe = await awaitProbe(groupId, requesterIdentity, probeWaitMs, electedAt);
  if (!probe) {
    log(`[HISTORY_REQ] no probe from ${requesterIdentity} for ${short}... - nothing to answer`);
    return;
  }

  /**
   * Our coverage, stated to this asker - the shared one bound to this exchange.
   *
   * Awaited at every point this device ANSWERS and at none where it stays silent, which is what
   * makes it read as the end of an answer rather than as one.
   */
  const ourCoverage = (since: number): Promise<void> =>
    stateOurCoverage({ groupId, selfIdentity, requesterIdentity, since, deps });

  if (probe.kind === 'range') {
    await sendHistoryRangeBundle(groupId, deps, {
      to: requesterIdentity,
      before: probe.before,
      limit: probe.limit,
      since: probe.since,
    }).catch((e) => log(`[HISTORY_RANGE] Answer failed for ${short}...: ${String(e)}`));
    await ourCoverage(probe.since);
    return;
  }

  if (probe.kind === 'state') {
    // OUR key over THE ASKER'S window. Computing it over our own would compare two different
    // questions and never match, which is why `since` is stated by the asker and obeyed here.
    const ourKey = await historyStateKeyFor(groupId, probe.since, deps);
    if (ourKey === null) {
      // A read that FAILED proves nothing about the group. Staying silent lets the requester ask
      // another member on its next edge.
      log(`[HISTORY_REQ] ${short}... store unreadable - staying silent so another member answers`);
      return;
    }
    if (ourKey === probe.key) {
      log(
        `[HISTORY_REQ] ${short}... same state as ${requesterIdentity} (${ourKey}) - nothing to do`
      );
      // AGREEMENT IS NOT COMPLETENESS, and this is the one case where nothing else would say so. Two
      // devices can hold exactly the same messages over the asker's window and both be missing the
      // years below OUR window - the key is computed over what each store holds, so it agrees
      // happily. Stating our coverage here is what lets the asker go and ask a member with a longer
      // memory instead of reading a match as "I am complete".
      await ourCoverage(probe.since);
      return;
    }

    // Same rule for the second leg, dated from OUR request rather than from the election: a digest
    // that predates the request cannot be an answer to it.
    // THE SECOND LEG DOES NOT WAIT, AND THERE IS NOTHING LEFT FOR IT TO WAIT FOR.
    //
    // It used to send this request and then block on `awaitProbe` for `DIGEST_TTL_MS`, ending the
    // exchange if the digest was late. That deadline cost three messages permanently on 2026-09-05:
    // the asker answers only once its own mailbox has drained, and a device that has just rejoined
    // an account is applying every group's external join at once - 67 s against a 60 s wait.
    //
    // The digest needs no continuation because it needs no memory: it carries the manifest and the
    // window, our store carries the rest. So the solicitation is recorded and this leg ENDS. The
    // frame is answered wherever it lands, by `systemMessageHandler` - one road instead of two, and
    // no line claiming an exchange failed while the repair was still on its way. On a device joining
    // twenty-five groups the old wait produced nine such lines per enrolment and repaired every one
    // of them seconds later.
    //
    // NOTHING IS LOGGED HERE. `[HISTORY_STATE] Keys differ ... asked <them> to describe` is written
    // one branch above by this same device, and the outcome arrives as `diff with <them>: N to send`
    // - one ask, one answer, per group. A third line saying the ask was made was pure duplication,
    // and on a device joining twenty-nine groups it was twenty-nine of them.
    noteDigestSolicited(groupId, requesterIdentity);
    await sendHistoryDigestRequest(groupId, { from: selfIdentity, to: requesterIdentity }, deps);
    return;
  }

  const { digest, since } = probe;
  await answerHistoryDigest({ groupId, requesterIdentity, selfIdentity, digest, since, deps });
}
