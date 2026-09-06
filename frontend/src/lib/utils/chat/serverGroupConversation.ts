import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { resolveDirectPeerId } from './conversations';
import { holdsGroupState } from './groupUsability';

/**
 * THE CONVERSATION ROW FOR A GROUP THE SERVER LISTS - written in ONE place, by every path that
 * needs one to exist.
 *
 * IT IS AN INVARIANT AND NOT A HELPER, AND THE INVARIANT IS AN ORDER. A device becomes REACHABLE
 * for a group the instant its leaf is in that group's tree; it becomes able to ROUTE what arrives
 * only once a conversation row exists for it. The inbound handler is explicit about the gap between
 * the two - a frame for a group with no row is answered `false`, left in the server queue and noted
 * `absent-conversation` - which is the only honest thing to do with a frame nothing can hold, and
 * is not a state to pass through on purpose.
 *
 * The Welcome path never had the gap: `setupMessageHandler` writes the row inside the same MLS lock
 * that installs the group, so joining and being able to route are one step. The self-service
 * external-commit join had no such step: it took its row from a different sweep entirely
 * (`discoverMissingGroups`, fire-and-forget, on its own cadence). Both read the SAME server list and
 * each did half the job, so the order between them was decided by whichever finished first.
 *
 * MEASURED 2026-09-06 (HEAL-REVOKE-4). A re-admitted device external-joined at 02:00:37; the
 * member's answer to that device's own history solicitation arrived in the same second and was
 * buffered `absent-conversation`; the row appeared at 02:00:42. Five seconds of window, and the one
 * exchange that repairs a rejoining device's whole history fell inside it.
 *
 * SO THE JOIN WAITS FOR THIS, and this is what discovery already did - EXTRACTED rather than
 * re-written. Two functions building a conversation row is two conventions for its key, its display
 * name and its duplicate check, and those three had already diverged once between the Welcome path
 * and this one.
 */

/**
 * The subset of a server group row this seam needs.
 *
 * `isGroup` IS REQUIRED, AND THAT IS THE POINT OF THE TYPE. It decides whether the row is a DM -
 * which decides its display name, its `directPeerId` and the duplicate check - so an absent value
 * is not a default, it is a question nobody answered. `GroupMeta` declares it optional because the
 * parser cannot promise what a response contains, and a caller holding one must therefore say what
 * it does about `undefined` rather than let it fall through as "DM".
 */
export type ServerGroupRow = {
  groupId: string;
  name?: string | null;
  isGroup: boolean;
  imageMediaId?: string | null;
};

/** What building the row needs, in the shape both callers already hold. */
export type EnsureConversationDeps = {
  mlsService: IMlsService;
  userId: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  /**
   * The groups this device owes the server an exit for, READ BY THE CALLER.
   *
   * Passed in rather than read here because discovery asks the question once for a whole sweep and
   * recovery asks it for one group: the guard belongs in one place, the round trip does not.
   */
  owedExits: ReadonlySet<string>;
  log: (msg: string) => void;
};

/**
 * Why no row was created, when none was - each one a DIFFERENT next move for the caller.
 *
 * `existed` and `created` both mean the device may now route for the group. The other three mean it
 * may not, and a caller about to make this device a member has to treat them as such rather than
 * joining anyway: `peer-unresolved` and `duplicate` clear by themselves on a later pass,
 * `exit-owed` clears when the exit is answered.
 */
export type EnsureConversationOutcome =
  | 'existed'
  | 'created'
  | 'peer-unresolved'
  | 'duplicate'
  | 'exit-owed';

/**
 * Ensure a conversation row exists for `group`, creating the placeholder if it does not.
 *
 * @returns Whether the device can now route for this group - see {@link EnsureConversationOutcome}.
 */
export async function ensureConversationForServerGroup(
  group: ServerGroupRow,
  deps: EnsureConversationDeps
): Promise<EnsureConversationOutcome> {
  const { mlsService, userId, conversations, saveConversation, owedExits, log } = deps;
  const groupId = group.groupId;

  // BY `id`, NEVER BY THE MAP KEY. A direct conversation learnt from a Welcome is keyed by the
  // PEER'S USER ID, so `conversations.has(groupId)` answers "no" for a group this device already
  // holds a perfectly good row for - and creating a second one is the duplicate-DM defect that
  // `mergeDirectConversationDuplicates` exists to clean up afterwards.
  if ([...conversations.values()].some((c) => c.id === groupId)) return 'existed';

  // A GROUP THIS DEVICE HAS ALREADY DECIDED TO LEAVE IS NOT "MISSING LOCALLY", IT IS ON ITS WAY OUT.
  // Without this, DEL-10's group came back: the delete met no server, the local state was purged,
  // and the very next sweep saw a server group with no local row and helpfully re-created it as a
  // placeholder - so the user's deletion was undone by the reconciler that is supposed to serve it.
  // The owed-exit row is the only thing that can tell the two apart, because on the wire they are
  // identical: a server group this client does not have.
  if (owedExits.has(groupId)) {
    // Never silent: this is the branch that makes a server group invisible, and the reader who
    // wonders where a group went must find the reason rather than deduce it.
    log(
      `[DISCOVERY] ${groupId.slice(0, 8)}... not re-created - this device owes the server an exit for it`
    );
    return 'exit-owed';
  }

  // Resolve the DM peer authoritatively: the group name is only a hint and may be malformed
  // (legacy groups can carry a self-only name -> a bogus "conversation with yourself").
  // When it is unusable, fall back to the server roster. A DM whose peer cannot be resolved yet
  // (transport error, or roster transiently self-only mid re-add) is skipped, not shown as self.
  const directPeer = group.isGroup
    ? null
    : await resolveDirectPeerId(mlsService, groupId, group.name || '', userId, log);
  if (!group.isGroup && !directPeer) {
    log(`[DISCOVERY] DM "${groupId.slice(0, 8)}..." peer unresolved - skip (retry next sync)`);
    return 'peer-unresolved';
  }
  const displayName = directPeer || group.name || groupId;

  // Local dedup: if a direct conv with this same peer already exists under a different groupId
  // (server-side duplicate), do not create a second placeholder.
  if (directPeer) {
    const alreadyLoaded = [...conversations.values()].find(
      (c) =>
        (c.conversationType ?? 'group') === 'direct' &&
        (c.directPeerId ?? c.contactName).toLowerCase() === directPeer
    );
    if (alreadyLoaded) {
      log(`[DISCOVERY] Duplicate ignored for "${directPeer}" (existing: ${alreadyLoaded.id})`);
      return 'duplicate';
    }
  }

  const key = groupId; // map key = groupId
  // A group already present in the local WASM (joined via an external commit before this ran) is
  // live: mark it active so the UI leaves the "syncing" placeholder state without a reload.
  // Otherwise it stays pending until the Welcome is processed.
  const joinedLocally = holdsGroupState(mlsService, groupId);
  conversations.set(key, {
    id: groupId,
    contactName: displayName,
    name: displayName,
    messages: [],
    lifecycle: joinedLocally ? 'active' : 'pending',
    mlsStateHex: null,
    conversationType: group.isGroup ? 'group' : 'direct',
    imageMediaId: group.imageMediaId ?? null,
    ...(directPeer ? { directPeerId: directPeer } : {}),
  });
  if (saveConversation) {
    try {
      await saveConversation(key);
    } catch (e) {
      log(
        `[WARN] Placeholder persistence failed for ${groupId}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  log(`[DISCOVERY] Placeholder "${displayName}" created.`);
  // A FRAME MAY ALREADY BE WAITING ON THIS EXACT CONVERSATION EXISTING. The inbound handler returns
  // `false` for a group whose conversation row is missing, leaving the frame in the server queue -
  // and the only global trigger that collects those is the boot restore, which cannot produce a
  // conversation the local store has never held. This is that conversation appearing, which is
  // precisely when the frame became readable.
  //
  // IT IS THE NET AND NO LONGER THE MECHANISM. Every path that makes this device a member now
  // writes the row first, so nothing should be waiting here; a line from this call is a window
  // somebody re-opened, not a routine catch-up.
  mlsService.notifyConversationAvailable(groupId);
  return 'created';
}
