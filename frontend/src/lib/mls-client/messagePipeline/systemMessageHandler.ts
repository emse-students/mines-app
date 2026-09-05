import type { Conversation } from '$lib/types';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';
import {
  serializeEnvelope,
  mkChannelInviteEnvelope,
  mkChannelInviteSentEnvelope,
  channelInviteMessageId,
} from '$lib/envelope';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { applyReaction, mergeReactions } from '$lib/utils/chat/messageReactions';
import { editSupersedes } from '$lib/utils/chat/editPrecedence';
import { purgeConversation, retireConversation } from '$lib/utils/chat/conversations';
import {
  digestIdentity,
  noteProbeReceived,
  takeDigestSolicitation,
} from '$lib/utils/chat/historyDigestRendezvous';
import { answerHistoryDigest } from '$lib/utils/chat/historyDiffAnswer';
import { parseHistoryDigest, selectEntryIdsForPrefixes } from '$lib/utils/chat/historyManifest';
import { mergeHistoryFloor, parseHistorySince } from '$lib/utils/chat/historyWindow';
import { parseHistoryStateKey } from '$lib/utils/chat/historyStateKey';
import { answerAfterMailboxDrained, noteCoverageShortfall } from '$lib/utils/chat/historyReconcile';
import {
  historyRangeStartFor,
  readHistoryEntries,
  sendHistoryBundleForIds,
  sendHistoryDigest,
} from '$lib/utils/chat/groupActions';
import {
  countUnreadForUser,
  mergeReadWatermark,
  mergeReadWatermarks,
  parseReadWatermarks,
  watermarkAfterReading,
  watermarkFor,
} from '$lib/utils/chat/readState';
import { applyPin, mergePinEntries } from '$lib/stores/pinStore.svelte';
import { m } from '$lib/paraglide/messages';
import type { MessageHandlerDeps } from './deps';

/**
 * Context passed to handleSystemEvent - extends MessageHandlerDeps with
 * per-message fields that are only known inside the message-processing callback.
 */
export interface SystemEventContext extends MessageHandlerDeps {
  /** Snapshot of the conversation at the moment the system message was received. */
  convo: Conversation;
  /** Conversation key in the conversations map (= MLS group id). */
  convoKey: string;
  /** Normalised (lowercase) sender user id. */
  senderNorm: string;
  /** Persist MLS state to storage immediately (used when group membership changes). */
  persistMlsStateNow: () => void;
  /** Queue metadata for messages received via the offline delivery queue. */
  deliveryMeta?: IncomingDeliveryMeta;
}

/**
 * May `senderNorm` rewrite or remove `target`? Only its own author may.
 *
 * WHY THIS IS ENFORCED ON RECEIPT, not only where the action is offered. `isOwnMessage` gates the
 * edit and delete controls, but it runs on the device that SENDS the event - it decides what to put
 * on the wire, and a check that lives on the attacker's side of the wire is not a check. Every other
 * member then applied `delete_message` / `edit_message` by message id alone, so a member of a group
 * could silently remove or rewrite ANY other member's message on EVERY device in it. Nothing else
 * would have caught it: DMs and groups carry no server authority over their content the way channels
 * do, precisely because the server cannot read them.
 *
 * The identity is the one MLS itself authenticated for the frame, which is what makes this
 * sufficient rather than advisory: a member can lie about the message id, never about who they are.
 *
 * Refusing is silent to the user by design - the honest reading is that a peer sent something it had
 * no right to send, which is not the local user's problem to act on - but it is never silent in the
 * log, because a swallowed branch in a best-effort path leaves nothing else behind.
 */
function mutationIsAuthorised(
  target: { senderId?: string },
  senderNorm: string,
  kind: 'edit' | 'delete',
  log: (msg: string) => void
): boolean {
  const owner = (target.senderId ?? '').toLowerCase();
  if (owner && owner === senderNorm.toLowerCase()) return true;
  log(
    `[MLS] Refused ${kind === 'edit' ? 'an edit' : 'a delete'} of a message owned by ${owner.slice(0, 8) || 'unknown'} from ${senderNorm.slice(0, 8)} - only the author may mutate it`
  );
  return false;
}

/**
 * The most this device will answer to one scrollback ask, whatever the asker requests.
 *
 * The bound belongs on the ANSWERING side as well as the asking one: `limit` arrives from a peer,
 * and a peer that names a million turns a reader's scroll into an unbounded store dump. Sized to a
 * few screens, which is what a scroll gesture is worth - reaching further is more scrolling.
 */
const HISTORY_RANGE_MAX = 200;

/**
 * Validates the `from` of a probe and returns it, or `null` after logging why it was refused.
 *
 * MLS authenticates the sending USER; the device half is self-asserted. Cross-checking the user
 * means the only thing a member can misreport is which of its OWN devices it is - which costs a
 * mis-addressed bundle its owner can already read, never another member's history.
 *
 * One function because every leg of the exchange establishes identity the same way, and a check
 * copied five times is a check that will exist in four places after the next edit.
 */
function probeSender(
  data: any,
  senderNorm: string,
  log: (msg: string) => void,
  tag: string
): string | null {
  const from = String(data?.from ?? '');
  const claimedUser = from.split(':')[0]?.toLowerCase();
  const deviceId = from.slice(from.indexOf(':') + 1);
  if (!claimedUser || !deviceId || claimedUser !== senderNorm) {
    log(`[${tag}] Rejected: "${from}" does not match the MLS sender ${senderNorm}`);
    return null;
  }
  return from;
}

/**
 * Dispatches a decoded MLS system event to the appropriate handler.
 *
 * Called from setupMessageHandler after JSON-parsing `msg.system.data`.
 * Always returns `true` (ACK) - unknown events are silently ignored so
 * they don't block the delivery queue.
 */

export async function handleSystemEvent(
  event: string,
  data: any,
  ctx: SystemEventContext
): Promise<boolean> {
  const {
    mlsService,
    storage,
    userId,
    deviceKeyB64,
    conversations,
    messageReactions,
    addMessageToChat,
    batchAddMessages,
    deleteConversation,
    saveConversation,
    getSelectedContact,
    setSelectedContact,
    onReadStateAdvanced,
    log,
    convo,
    convoKey,
    senderNorm,
    persistMlsStateNow,
    deliveryMeta,
  } = ctx;

  // `decrypt_failed` was the narrow repair: a peer that could not decrypt asked every member to
  // re-send whatever it had sent in the last two minutes. It is gone, and this branch stays only to
  // absorb it from a peer running an older build - answering would restart exactly the broadcast the
  // deletion removes, and the requester's own history diff repairs it correctly and by name.
  if (event === 'decrypt_failed') {
    log(
      `[MLS] Ignoring a legacy decrypt_failed from ${senderNorm} in ${convoKey.slice(0, 8)}… - the history diff repairs this by name`
    );
    return true;
  }

  // A peer is telling us, in sixteen characters, everything it holds for this conversation, so the
  // elected member can answer "we agree" without either side opening its store. The first leg of
  // every reconciliation and usually the only one.
  //
  // Only RECORDED here: the election arrives by a different transport, and the two are joined by the
  // rendezvous so they can land in either order.
  if (event === 'history_state') {
    const from = probeSender(data, senderNorm, log, 'HISTORY_STATE');
    if (!from) return true;
    const key = parseHistoryStateKey(data?.key);
    if (!key) {
      log(`[HISTORY_STATE] Malformed key from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    const since = parseHistorySince(data?.since);
    if (since === null) {
      log(`[HISTORY_STATE] No window stated by ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    noteProbeReceived(convoKey, from, { kind: 'state', key, since });
    log(
      `[HISTORY_STATE] From ${senderNorm} for ${convoKey.slice(0, 8)}… - ${key}, from ${since > 0 ? new Date(since).toISOString() : 'the beginning'}`
    );
    return true;
  }

  // The elected member compared our state key against its own, found them different, and is asking
  // us to describe ourselves properly. The SECOND leg of one solicitation, which is why the digest
  // it triggers lands on the same rendezvous rather than starting a new exchange.
  if (event === 'history_digest_request') {
    const me = digestIdentity(userId, mlsService.getDeviceId());
    if (String(data?.to ?? '').toLowerCase() !== me.toLowerCase()) return true;
    if (!probeSender(data, senderNorm, log, 'HISTORY_STATE')) return true;

    log(
      `[HISTORY_STATE] ${senderNorm} holds something different for ${convoKey.slice(0, 8)}… - describing our store`
    );
    // OUR MAILBOX FIRST: a digest computed while this device is still applying its own queue
    // describes a store it is in the middle of completing, so the asker diffs against a snapshot
    // that was already wrong when it was taken.
    answerAfterMailboxDrained(mlsService, () =>
      sendHistoryDigest(convoKey, me, { storage, deviceKeyB64, mlsService, log }).catch((e) =>
        log(`[HISTORY_DIGEST] Could not answer ${senderNorm}: ${String(e).slice(0, 120)}`)
      )
    );
    return true;
  }

  // A peer is telling us what it holds for this conversation, so that whichever member the server
  // elects can answer a solicitation with the DIFFERENCE rather than its whole store (WP-HIST-3).
  if (event === 'history_digest') {
    const from = probeSender(data, senderNorm, log, 'HISTORY_DIGEST');
    if (!from) return true;
    const digest = parseHistoryDigest(data?.digest);
    if (!digest) {
      log(`[HISTORY_DIGEST] Malformed digest from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    // The window the asker drew, carried to whichever leg of the exchange ends up answering. Stating
    // none is malformed: every sender types it as required, so its absence is a broken frame rather
    // than an old peer, and answering it in full would be inventing a window on the asker's behalf.
    const since = parseHistorySince(data?.since);
    if (since === null) {
      log(`[HISTORY_DIGEST] No window stated by ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    const takenByAWaiter = noteProbeReceived(convoKey, from, { kind: 'digest', digest, since });
    const size =
      digest.mode === 'ids'
        ? `${digest.ids.length} id(s)`
        : `${digest.ranges.length} slice(s) at depth ${digest.depth}`;
    log(
      `[HISTORY_DIGEST] From ${senderNorm} for ${convoKey.slice(0, 8)}… - ${digest.mode}, ${size}, asking from ${since > 0 ? new Date(since).toISOString() : 'the beginning'}`
    );

    // THE LATE HALF OF AN EXCHANGE WE OPENED, and answering it here is what stops a slow peer from
    // costing messages permanently. `handleHistoryRequest` waits `DIGEST_TTL_MS` for this frame and
    // then returns; the digest that arrives afterwards used to be recorded and never looked at
    // again, and nothing anywhere would ask a second time - measured 2026-09-05, a device that had
    // just rejoined took 67 s to drain twenty external joins against that 60 s wait and stayed three
    // messages short for ever.
    //
    // It needs no continuation because it needs no memory: the digest carries the manifest and the
    // window, our store carries the rest. `takeDigestSolicitation` is what keeps it addressed - this
    // leg is a group broadcast, so every member records it, and only the one that ASKED consumes an
    // outstanding solicitation and answers. The election still elects exactly one responder.
    if (!takenByAWaiter && takeDigestSolicitation(convoKey, from)) {
      // SILENT, because this IS the road now and it says nothing a reader can act on. The line above
      // reports the digest, and `[HISTORY_REQ] ... diff with <them>` reports what it produced; a
      // third line between them announced a road that no longer has an alternative, once per group
      // per enrolment.
      //
      // OUR MAILBOX FIRST, for the same reason every other store read in this file waits: a diff
      // resolved mid-drain names what we hold SO FAR and tells the asker that is all there is.
      answerAfterMailboxDrained(mlsService, () =>
        answerHistoryDigest({
          groupId: convoKey,
          requesterIdentity: from,
          selfIdentity: digestIdentity(userId, mlsService.getDeviceId()),
          digest,
          since,
          deps: { storage, deviceKeyB64, mlsService, log },
        }).catch((e) =>
          log(
            `[HISTORY_DIGEST] Late answer failed for ${convoKey.slice(0, 8)}…: ${String(e).slice(0, 120)}`
          )
        )
      );
    }
    return true;
  }

  // Scrollback: a reader reached the top of what their device holds and is asking for the page
  // before it. Same rendezvous, same election, different boundary - and bounded by `limit`, so the
  // answer is one page whatever the conversation's size.
  if (event === 'history_range') {
    const from = probeSender(data, senderNorm, log, 'HISTORY_RANGE');
    if (!from) return true;
    const before = Number(data?.before);
    const limit = Number(data?.limit);
    const since = parseHistorySince(data?.since);
    if (
      !Number.isFinite(before) ||
      before <= 0 ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      since === null
    ) {
      log(`[HISTORY_RANGE] Unusable range from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    noteProbeReceived(convoKey, from, {
      kind: 'range',
      before: Math.floor(before),
      limit: Math.min(Math.floor(limit), HISTORY_RANGE_MAX),
      since,
    });
    log(
      `[HISTORY_RANGE] ${senderNorm} wants up to ${limit} message(s) before ${new Date(before).toISOString()} in ${convoKey.slice(0, 8)}…`
    );
    return true;
  }

  // A peer has finished answering us and is stating where its OWN history begins - which it only
  // does when that is later than the instant we asked from. THE FOURTH TRIGGER: this is the one edge
  // raised by an answer rather than by something this device noticed about itself, and it is what
  // tells a clipped answer apart from a conversation that simply has no more past.
  if (event === 'history_coverage') {
    const me = digestIdentity(userId, mlsService.getDeviceId());
    if (String(data?.to ?? '').toLowerCase() !== me.toLowerCase()) return true;
    const from = probeSender(data, senderNorm, log, 'HISTORY_COVERAGE');
    if (!from) return true;
    const coveredFrom = Number(data?.coveredFrom);
    if (!Number.isFinite(coveredFrom) || coveredFrom <= 0) {
      log(`[HISTORY_COVERAGE] Unusable coverage from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }

    // OUR OWN WINDOW, not the `since` the peer echoed back. The question this answers is "does that
    // peer cover what THIS device wants", and only this device is entitled to say what that is - the
    // echo is what the peer compared against, which is one round trip old and, either side of
    // midnight, a different day.
    const since = await historyRangeStartFor(convoKey, storage);
    void noteCoverageShortfall(
      mlsService,
      convoKey,
      from,
      { since, coveredFrom: Math.floor(coveredFrom) },
      log
    ).catch((e) =>
      log(
        `[HISTORY_COVERAGE] Chase failed for ${convoKey.slice(0, 8)}…: ${String(e).slice(0, 120)}`
      )
    );
    return true;
  }

  // The mirror image: a peer diffed our digest against its own store, found messages IT lacks, and
  // is asking us for them by name. Every leg of this exchange is a group broadcast, so the first
  // thing to establish is whether it was meant for us at all.
  //
  // This is where the exchange terminates, and that is deliberate: a pull is answered by a bundle,
  // and a bundle asks for nothing. Nothing here can re-enter the loop it came from.
  if (event === 'history_pull') {
    const me = digestIdentity(userId, mlsService.getDeviceId());
    if (String(data?.to ?? '').toLowerCase() !== me.toLowerCase()) return true;

    // Our answer is a group broadcast addressed back to the puller, so its identity is established
    // here exactly as every other leg does it. An unusable `from` is dropped rather than answered to
    // nobody - a bundle with no addressee is pure traffic.
    const puller = probeSender(data, senderNorm, log, 'HISTORY_PULL');
    if (!puller) return true;

    const deps = { storage, deviceKeyB64, mlsService, log };
    const ids = Array.isArray(data?.ids)
      ? (data.ids as unknown[]).filter((id): id is string => typeof id === 'string' && !!id.trim())
      : [];
    // The depth the prefixes were computed at travels with them: a prefix names a slice of the id
    // space only relative to a depth, and re-deriving it from our OWN store's size would name a
    // different slice on each device.
    const depth = Number(data?.depth);
    const prefixes =
      Array.isArray(data?.prefixes) && Number.isInteger(depth) && depth >= 1
        ? (data.prefixes as unknown[]).filter(
            (p): p is string => typeof p === 'string' && p.length === depth && /^[0-9a-f]+$/.test(p)
          )
        : [];
    // The puller's own window, which is NOT the one we would have used: it may retain five years
    // where we keep ninety days, or the reverse. Only the asker may set the bound on its answer, so
    // a pull that states none is declined rather than answered over a window we invented for it.
    const since = parseHistorySince(data?.since);
    if (since === null) {
      log(`[HISTORY_PULL] No window stated by ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }

    // EVERYTHING THAT READS THE STORE WAITS FOR OUR MAILBOX - the selection as much as the send. A
    // prefix slice resolved mid-drain names the messages we hold SO FAR, so the bundle is short of
    // exactly the frames we were about to apply, and the puller is told that is all there is.
    // Parsing above is pure and stays inline; only what depends on the store is deferred.
    answerAfterMailboxDrained(mlsService, async () => {
      let wanted = ids;
      if (wanted.length === 0 && prefixes.length > 0) {
        // A range diff resolves to a slice of the id space, never to a message, so the asker cannot
        // name what it wants: it names the slice and we send everything we hold in it. The receiver
        // dedupes by id, so over-sending costs bandwidth and nothing else.
        const entries = await readHistoryEntries(convoKey, deps);
        if (entries === null) {
          log(
            `[HISTORY_PULL] Store unreadable - cannot answer ${senderNorm} for ${convoKey.slice(0, 8)}…`
          );
          return;
        }
        wanted = selectEntryIdsForPrefixes(entries, prefixes, depth);
      }
      if (wanted.length === 0) {
        log(
          `[HISTORY_PULL] ${senderNorm} asked for nothing usable in ${convoKey.slice(0, 8)}… - ignored`
        );
        return;
      }

      log(
        `[HISTORY_PULL] ${senderNorm} wants ${wanted.length} message(s) from ${convoKey.slice(0, 8)}…`
      );
      await sendHistoryBundleForIds(convoKey, wanted, deps, { to: puller, since }).catch((e) =>
        log(`[HISTORY_PULL] Answer failed: ${String(e).slice(0, 120)}`)
      );
    });
    return true;
  }

  if (event === 'channel_invitation') {
    const channelId = String(data.channelId || '');
    const channelName = String(data.channelName || channelId);
    const workspaceName = data.workspaceName ? String(data.workspaceName) : undefined;
    const workspaceImageMediaId = data.workspaceImageMediaId
      ? String(data.workspaceImageMediaId)
      : undefined;

    if (!channelId) {
      // An invitation naming no salon cannot be rendered and cannot be deduplicated either - the
      // stable id is derived from it. Refusing is right; refusing in silence is what made an
      // invitation that reached a device and produced nothing unattributable from any log.
      log(
        `[CHANNEL_INVITE] refusing an invitation from ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… - it names no channel`
      );
      return true;
    }

    const inviteeId = String(data.inviteeId || '');
    const inviteMessageId = channelInviteMessageId(channelId, inviteeId);

    if (senderNorm === userId) {
      // The inviter's OTHER devices: MLS never returns a message to the device that sent it, so
      // this branch is only ever reached on a second device. The sending device inserts the same
      // card locally in `inviteMemberToChannel`.
      const inviteeDisplayName = String(data.inviteeName || data.inviteeId || '');
      await addMessageToChat(
        'system',
        serializeEnvelope(
          mkChannelInviteSentEnvelope(
            channelId,
            workspaceName ?? channelName,
            workspaceName,
            inviteeDisplayName,
            workspaceImageMediaId
          )
        ),
        convoKey,
        { isSystem: true, messageId: inviteMessageId }
      );
      log(
        `[CHANNEL_INVITE] our own invitation of ${inviteeId.slice(0, 8)} to ${channelId.slice(0, 8)}, seen from another device - card ${inviteMessageId} into ${convoKey.slice(0, 8)}…`
      );
    } else {
      // The invitee receives the invitation card
      const inviterDisplayName = String(data.inviterName || '');
      const inviteEnvelope = serializeEnvelope(
        mkChannelInviteEnvelope(
          channelId,
          workspaceName ?? channelName,
          workspaceName,
          inviterDisplayName,
          workspaceImageMediaId
        )
      );
      await addMessageToChat('system', inviteEnvelope, convoKey, {
        isSystem: true,
        messageId: inviteMessageId,
      });
      // THE ONLY THING THE INVITEE IS EVER TOLD. A direct invitation makes them a member with no
      // gesture of their own, so this card is the whole notification - and one line saying it was
      // written, naming the conversation it went into, is what separates "never delivered" from
      // "delivered into a conversation nobody is looking at".
      log(
        `[CHANNEL_INVITE] invited to ${channelId.slice(0, 8)} by ${senderNorm.slice(0, 8)} - card ${inviteMessageId} into ${convoKey.slice(0, 8)}…`
      );
    }

    return true;
  }

  if (event === 'groupRenamed' && data.newName) {
    conversations.set(convoKey, { ...convo, name: data.newName });
    if (storage) await saveConversation(convoKey);
    const getName = await resolveDisplayNames([senderNorm]);
    await addMessageToChat(
      'system',
      m.chat_system_group_renamed({ sender: getName(senderNorm), name: data.newName }),
      convoKey,
      { isSystem: true }
    );
    log(`📝 Group renamed to "${data.newName}" by ${getName(senderNorm)}`);
    return true;
  }

  if (event === 'groupImageChanged') {
    const imageMediaId =
      typeof data.imageMediaId === 'string' && data.imageMediaId ? data.imageMediaId : null;
    conversations.set(convoKey, { ...convo, imageMediaId });
    if (storage) await saveConversation(convoKey);
    const getName = await resolveDisplayNames([senderNorm]);
    await addMessageToChat(
      'system',
      imageMediaId
        ? m.chat_system_group_photo_changed({ sender: getName(senderNorm) })
        : m.chat_system_group_photo_removed({ sender: getName(senderNorm) }),
      convoKey,
      { isSystem: true }
    );
    log(`🖼️ Group photo changed by ${getName(senderNorm)} (media=${imageMediaId ?? 'null'})`);
    return true;
  }

  if (event === 'memberRemoved' && data.targetUser) {
    const getName = await resolveDisplayNames([senderNorm, data.targetUser]);
    if (data.targetUser.toLowerCase() === userId.toLowerCase()) {
      // Current user was excluded. Mirror the peer-delete (`groupDeleted`) handling instead of a
      // silent purge: forget the WASM state (we can no longer decrypt future epochs) but KEEP the
      // local conversation as `removed`. The user reads the history behind a banner and deletes it
      // manually - which dismisses it on ALL their devices. A silent purge here dropped the
      // conversation everywhere with no visible trace.
      try {
        mlsService.forgetGroup(convo.id);
      } catch {
        /* non-blocking */
      }
      persistMlsStateNow();
      await addMessageToChat('system', m.chat_system_removed_from_group(), convoKey, {
        isSystem: true,
      });
      await retireConversation({
        conversations,
        key: convoKey,
        groupId: convo.id,
        saveConversation,
      });
      log(`[INFO] Excluded from group "${convoKey}" by ${getName(senderNorm)} - marked removed`);
    } else {
      await addMessageToChat(
        'system',
        m.chat_system_member_removed({
          sender: getName(senderNorm),
          target: getName(data.targetUser),
        }),
        convoKey,
        { isSystem: true }
      );
    }
    return true;
  }

  if (event === 'memberAdded') {
    const newUserIds: string[] =
      data.newUsers && Array.isArray(data.newUsers)
        ? data.newUsers
        : data.newUser
          ? [data.newUser]
          : [];
    const getName = await resolveDisplayNames([senderNorm, ...newUserIds]);
    const added = newUserIds.map((u: string) => getName(u)).join(', ');
    if (added) {
      await addMessageToChat(
        'system',
        m.chat_system_member_added({ sender: getName(senderNorm), members: added }),
        convoKey,
        { isSystem: true }
      );
    }
    return true;
  }

  if (event === 'groupDeleted') {
    const getName = await resolveDisplayNames([senderNorm]);
    const senderName = getName(senderNorm);
    try {
      mlsService.forgetGroup(convo.id);
    } catch {
      /* non-blocking */
    }
    persistMlsStateNow();

    if (senderNorm === userId) {
      // Deletion performed by us on another device: remove immediately
      // without user interaction (syncing our own action).
      if (getSelectedContact() === convoKey) setSelectedContact(null);
      // A purge removes the row, so nothing keyed by the group is reachable through the UI any
      // more - but the awaiting-history marker is keyed by the GROUP, not by the row, and outlives
      // it. That is where this rig's orphan markers came from: conversations deleted on another
      // device, whose markers then sat in localStorage until the 30-day horizon.
      await purgeConversation({
        conversations,
        key: convoKey,
        groupId: convo.id,
        deleteStored: deleteConversation,
      });
      log(`[INFO] Group deleted on another device - conversation removed immediately`);
    } else {
      // Deleted by another participant: add a visible message and set the
      // conversation to `removed` so the user can read the history before closing.
      await addMessageToChat(
        'system',
        m.chat_system_conversation_deleted({ sender: senderName }),
        convoKey,
        { isSystem: true }
      );
      await retireConversation({
        conversations,
        key: convoKey,
        groupId: convo.id,
        saveConversation,
      });
      log(`[INFO] Group deleted by ${senderName} - conversation marked removed`);
    }
    return true;
  }

  if (event === 'read_watermark' || event === 'read_receipt') {
    const c = conversations.get(convoKey);
    if (c) {
      // `read_receipt` is the shape senders used before the watermark, and it names message ids
      // instead of an instant. Translated rather than dropped: the ids we hold give the instant
      // directly, and ids we do not hold say nothing we could act on anyway.
      const at =
        event === 'read_watermark'
          ? Number(data.at)
          : watermarkAfterReading(
              c.messages.filter((m) => (data.messageIds ?? []).includes(m.id)),
              0
            );
      const merged = mergeReadWatermark(c.readWatermarks, senderNorm, at);
      // Read by OURSELVES on another device: clear the badge here too, which is the whole point of
      // the watermark travelling between our own devices.
      const selfRead = senderNorm === userId;
      if (merged || selfRead) {
        conversations.set(convoKey, {
          ...c,
          ...(merged ? { readWatermarks: merged } : {}),
          ...(selfRead ? { unreadCount: 0 } : {}),
        });
        // The read state lives on the conversation row, so this save is what persists it - for a
        // peer's watermark as much as for our own.
        await saveConversation?.(convoKey).catch(() => {});
      }
      if (merged) {
        log(`[READ] ${senderNorm} has read up to ${new Date(at).toISOString()}`);
        onReadStateAdvanced?.({ conversationKey: convoKey, senderId: senderNorm, at });
      }
    }
    return true;
  }

  if (event === 'delete_message') {
    const c = conversations.get(convoKey);
    if (c && data.messageId) {
      const idx = c.messages.findIndex((m) => m.id === data.messageId);
      if (idx !== -1 && !mutationIsAuthorised(c.messages[idx], senderNorm, 'delete', log))
        return true;
      if (idx !== -1) {
        const orig = c.messages[idx];
        const deletedMsg = {
          ...orig,
          isDeleted: true,
          content: m.chat_system_message_deleted(),
        };
        conversations.set(convoKey, {
          ...c,
          messages: c.messages.map((m, i) => (i === idx ? deletedMsg : m)),
        });
        if (storage) {
          try {
            // The tombstone and the replacement body, nothing else: the edit flags and the read
            // state of the message being deleted are not this handler's to rewrite.
            await storage.updateMessage(
              deletedMsg.id,
              { isDeleted: true, content: deletedMsg.content },
              deviceKeyB64
            );
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if (event === 'edit_message' && data.messageId && data.newContent) {
    const c = conversations.get(convoKey);
    if (c) {
      const idx = c.messages.findIndex((m) => m.id === data.messageId);
      if (idx !== -1 && !mutationIsAuthorised(c.messages[idx], senderNorm, 'edit', log))
        return true;
      if (idx !== -1) {
        const orig = c.messages[idx];
        // A DELETE IS ABSORBING: THE TOMBSTONE WINS, WHATEVER THE ORDER. The tombstone lives in
        // `content`, so an edit applied on top of it does not merely reorder two bodies - it puts
        // the deleted text back on screen, italic and faded, which is the one outcome a delete
        // exists to prevent. Reachable the same way the ordering defect was: two devices of one
        // account, one deleting while the other edits. The archive's own post-save pass
        // (`history.ts`, `if (deletion) ... else if (edit)`) has always had this rule; the live path
        // and the replay never did.
        if (orig.isDeleted) {
          log(
            `[MLS] Dropped an edit of ${String(data.messageId).slice(0, 8)} - the message is deleted and a tombstone is final`
          );
          return true;
        }
        const editedAtMs = typeof data.editedAt === 'number' ? data.editedAt : Date.now();
        // AN EDIT OLDER THAN THE ONE THIS ROW ALREADY CARRIES IS DROPPED, and dropping it is what
        // makes two devices agree. Applying on arrival meant the answer was "whichever frame came
        // last", which differs per device: MUT-18 crossed two edits from two devices of one account
        // and left W1 on A1's text and A1 on W1's, permanently, with no error anywhere. See
        // `editSupersedes` for why a sender-stamped clock is enough - convergence needs the same
        // winner, not the right one.
        if (!editSupersedes({ editedAt: editedAtMs, content: data.newContent }, orig)) {
          log(
            `[MLS] Dropped an edit of ${String(data.messageId).slice(0, 8)} dated ${editedAtMs} - the row already holds a later one`
          );
          return true;
        }
        const editedAt = new Date(editedAtMs);
        // No read state is reset here. It used to clear `readBy`, so an edited message showed as
        // read by nobody - which the watermark cannot express and should not: a watermark is
        // monotone, and a peer that never sees the edit would never agree to move back anyway.
        const editedMsg = { ...orig, isEdited: true, editedAt, content: data.newContent };
        conversations.set(convoKey, {
          ...c,
          messages: c.messages.map((m, i) => (i === idx ? editedMsg : m)),
        });
        if (storage) {
          try {
            await storage.updateMessage(
              editedMsg.id,
              { content: data.newContent, isEdited: true, editedAt: editedAt.getTime() },
              deviceKeyB64
            );
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if (event === 'history_bundle') {
    // INGESTION IS FOR EVERYONE. A bundle is a group broadcast, so every member sees an exchange
    // between two of them, and the messages are free to take - the merge below dedupes by id.
    //
    // Nothing else about the addressee matters any more, and that is a simplification the state key
    // paid for. A bundle used to DISCHARGE the receiver's durable awaiting-history marker, so
    // reading somebody else's answer as our own stopped a solicitation on another device's evidence
    // and lost history for good. There is no marker to discharge: what a device holds is compared
    // again on its next connection, so an answer meant for a peer is simply free messages.
    const addressee = String(data?.to ?? '');
    const me = digestIdentity(userId, mlsService.getDeviceId()).toLowerCase();
    if (addressee && addressee.toLowerCase() !== me) {
      log(
        `[HISTORY_BUNDLE] ${convoKey.slice(0, 8)}… - answer for ${addressee.slice(0, 8)}…, ingesting it anyway`
      );
    }
    try {
      type BundleMsg = {
        id: string;
        senderId: string;
        content: string;
        timestamp: number;
        reactions?: import('$lib/types').MessageReaction[];
        isDeleted?: boolean;
        isEdited?: boolean;
        editedAt?: number;
        serverTimestamp?: number;
      };
      const msgs: BundleMsg[] = Array.isArray(data.messages) ? data.messages : [];

      // 0) The conversation's own state - read watermarks and the shared history floor - which
      //    travels ONCE for the whole conversation rather than once per message. Merged before
      //    anything else so the unread recount in step 3 sees it, and merged even for an empty
      //    bundle: "you are missing no messages, and here is who has read what" is a perfectly
      //    ordinary answer. Both merges are `max`, so a value restated by every chunk is free.
      const beforeMerge = conversations.get(convoKey);
      if (beforeMerge) {
        const mergedWatermarks = mergeReadWatermarks(
          beforeMerge.readWatermarks,
          parseReadWatermarks(data.readWatermarks)
        );
        const mergedFloor = mergeHistoryFloor(beforeMerge.historyFloor, data.floor);
        if (mergedWatermarks || mergedFloor !== null) {
          conversations.set(convoKey, {
            ...beforeMerge,
            ...(mergedWatermarks ? { readWatermarks: mergedWatermarks } : {}),
            ...(mergedFloor !== null ? { historyFloor: mergedFloor } : {}),
          });
          await saveConversation?.(convoKey).catch(() => {});
        }
      }

      // The pin register rides beside them, merged entry by entry on the same `at` the frames
      // carry. Reported only when something actually moved - a bundle restating what we already
      // hold is the common case and says nothing.
      const pinsMerged = mergePinEntries(convoKey, data.pins);
      if (pinsMerged > 0) {
        log(
          `[HISTORY_BUNDLE] ${pinsMerged} pin state(s) converged for ${convoKey.slice(0, 8)}… from ${senderNorm.slice(0, 8)}`
        );
      }

      if (msgs.length > 0) {
        const existingIds = new Set(convo.messages.map((m) => m.id));
        // 1) Add only the genuinely new messages. The add-path (AddMessageToChatOptions) cannot
        //    carry reactions/tombstones, so that metadata is merged in step 2 for new AND existing
        //    messages alike.
        const toAdd = msgs
          .filter((m) => !existingIds.has(m.id))
          .map((m) => ({
            senderId: m.senderId.toLowerCase(),
            content: m.content,
            messageId: m.id,
            timestamp: new Date(m.timestamp),
            // The secondary sort key. Dropping it here - the replay path keeps it - left two
            // messages sharing a client timestamp in an order that changed on every reload.
            ...(typeof m.serverTimestamp === 'number'
              ? { serverTimestamp: m.serverTimestamp }
              : {}),
          }));
        if (toAdd.length > 0) {
          log(`[HISTORY_BUNDLE] ${toAdd.length} messages received from the inviting peer`);
          if (batchAddMessages) {
            await batchAddMessages(toAdd, convoKey);
          } else {
            for (const item of toAdd) {
              await addMessageToChat(item.senderId, item.content, convoKey, item);
            }
          }
        }

        // 2) Merge transport-carried state (reactions, delete/edit) onto the conversation
        //    messages - both the ones just added and any that already existed.
        const bundleById = new Map(msgs.map((m) => [m.id, m]));
        const c = conversations.get(convoKey);
        if (c) {
          const changedIds = new Set<string>();
          const nextMessages = c.messages.map((existing) => {
            const b = bundleById.get(existing.id);
            if (!b) return existing;
            let next = existing;
            // reactions: merged pair by pair, larger timestamp wins. This used to seed from the
            // bundle ONLY when we held none, so a removal never reached a device holding a stale
            // placement and the two never converged (D3).
            if (Array.isArray(b.reactions) && b.reactions.length > 0) {
              const merged = mergeReactions(
                messageReactions.get(existing.id) ?? next.reactions ?? [],
                b.reactions
              );
              if (merged) {
                next = { ...next, reactions: merged };
                messageReactions.set(existing.id, merged);
                changedIds.add(existing.id);
              }
            }
            // A deletion REPLACES the body. Setting the flag and keeping the text put the original
            // plaintext of a deleted message straight back on disk, where the tombstone was
            // supposed to be the only thing left of it (D5).
            if (b.isDeleted === true && !next.isDeleted) {
              next = { ...next, isDeleted: true, content: m.chat_system_message_deleted() };
              changedIds.add(existing.id);
            }
            if (b.isEdited === true && !next.isEdited) {
              next = { ...next, isEdited: true };
              changedIds.add(existing.id);
            }
            // The edit time, which only the bundle can supply: the sender's own edit is never
            // echoed back over MLS, so a device restored this way has no other source for it.
            if (typeof b.editedAt === 'number' && b.editedAt > 0 && next.editedAt == null) {
              next = { ...next, editedAt: new Date(b.editedAt) };
              changedIds.add(existing.id);
            }
            return next;
          });
          // 3) Recount the unread badge against our own watermark, which step 0 may have just
          //    advanced. Step 1 went through the add-path, which counts EVERY incoming message as
          //    unread because it cannot see read state - a message this user already read on
          //    another device is below the watermark and must not raise a badge here.
          //    Clamped to the current value: an open conversation was already zeroed by the
          //    add-path and must never regain a badge, and a genuine new member - whose watermark
          //    is 0 - keeps the full count.
          const stillUnread = countUnreadForUser(
            nextMessages,
            watermarkFor(c.readWatermarks, userId.toLowerCase())
          );
          const nextUnreadCount = Math.min(c.unreadCount ?? 0, stillUnread);
          if (changedIds.size > 0 || nextUnreadCount !== (c.unreadCount ?? 0)) {
            conversations.set(convoKey, {
              ...c,
              messages: nextMessages,
              unreadCount: nextUnreadCount,
            });
            log(
              `[HISTORY_BUNDLE] merged metadata onto ${changedIds.size} message(s), unread ${c.unreadCount ?? 0} -> ${nextUnreadCount}`
            );
            if (storage) {
              for (const msg of nextMessages) {
                if (!changedIds.has(msg.id)) continue;
                try {
                  // The metadata the merge above may have moved. The body is left alone EXCEPT on
                  // a deletion, which must purge it at rest: the tombstone is meant to be all that
                  // survives, and writing the row without it put the original text back on disk.
                  await storage.updateMessage(
                    msg.id,
                    {
                      reactions: messageReactions.get(msg.id) ?? msg.reactions,
                      serverTimestamp: msg.serverTimestamp,
                      ...(msg.isDeleted ? { isDeleted: true, content: msg.content } : {}),
                      ...(msg.isEdited ? { isEdited: true } : {}),
                      ...(msg.editedAt ? { editedAt: msg.editedAt.getTime() } : {}),
                    },
                    deviceKeyB64
                  );
                } catch {
                  // Non-blocking
                }
              }
            }
          }
        }
      }
    } catch {
      /* malformed bundle - ignore silently */
    }
    return true;
  }

  // LEGACY FRAME. Taking a reaction back now travels as a `ReactionMsg` with `removed` set, the
  // same frame that placed it. This branch only ever sees entries written to the shared log before
  // that change; no client sends one any more. Removal condition in
  // `docs/wiki/legacy-compatibility.md`.
  if (event === 'remove_reaction' && data.messageId && data.emoji) {
    const reactions = messageReactions.get(data.messageId) || [];
    // Dated with the delivery time, which is the only clock this frame shape carries. It is
    // therefore ordered after every placement that preceded it in the log, which is what it meant.
    const updated = applyReaction(
      reactions,
      senderNorm,
      String(data.emoji),
      deliveryMeta?.queuedCreatedAt ?? Date.now(),
      true
    );
    if (!updated) return true;
    messageReactions.set(data.messageId, updated);

    const c = conversations.get(convoKey);
    if (c) {
      const msgIdx = c.messages.findIndex((m) => m.id === data.messageId);
      if (msgIdx !== -1) {
        const nextMsgs = [...c.messages];
        nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: updated };
        conversations.set(convoKey, { ...c, messages: nextMsgs });
        if (storage) {
          try {
            await storage.updateMessage(nextMsgs[msgIdx].id, { reactions: updated }, deviceKeyB64);
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if ((event === 'pin' || event === 'unpin') && data.messageId) {
    // `at` is the sender's clock, and the merge needs it. A frame from a client too old to send one
    // is dated on receipt: later than anything we hold, which is the right answer for a frame
    // arriving live, and the only one available. See `docs/wiki/legacy-compatibility.md`.
    applyPin(convoKey, String(data.messageId), event === 'pin', Number(data.at) || Date.now());
    return true;
  }

  // Unknown system event - ACK silently to avoid blocking the delivery queue
  return true;
}
