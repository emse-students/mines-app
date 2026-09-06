vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import {
  requestReAdd,
  cancelReAdd,
  recoverForkedGroup,
  recoverRosterDisagreement,
  resetReAddCooldowns,
} from './recovery';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import { saveMlsState } from '$lib/utils/hex';
import { resetHistoryReconciliation, setHistoryProbeSender } from './historyReconcile';

beforeEach(() => {
  vi.mocked(saveMlsState).mockClear();
  // Reboot deadline / not-ready markers persist in localStorage across tests - reset between cases.
  if (typeof localStorage !== 'undefined') localStorage.clear();
  // The recovery cooldown is module-global - reset it so throttling never leaks between cases.
  resetReAddCooldowns();
  // External-join success reconciles the group; the coalescing window is module-global, so it is
  // reset between cases or the second case in a file would silently skip its ask.
  resetHistoryReconciliation();
  probeSender.mockClear();
  setHistoryProbeSender(probeSender);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Stands in for the session-registered probe sender, which the reconciliation refuses to run without. */
const probeSender = vi.fn().mockResolvedValue(true);

function makeMls(overrides: Record<string, unknown> = {}) {
  return {
    // Default = group alive on server (neither absent nor tombstone).
    //
    // `isGroup` IS PART OF THE DEFAULT because the join now refuses to proceed without it: the
    // conversation row it must exist behind is a DM or a group, and the server row is the only
    // thing that says which. A stub omitting it puts every case on the deferral path.
    getGroupMeta: vi
      .fn()
      .mockResolvedValue({ groupId: 'mock-group', isGroup: true, deletedAt: null }),
    getGroupServerStatus: vi
      .fn()
      .mockResolvedValue({ groupId: 'mock-group', isGroup: true, deletedAt: null }),
    // Creating the conversation row ANNOUNCES it, so a frame buffered `absent-conversation` for
    // this group becomes routable at that instant.
    notifyConversationAvailable: vi.fn(),
    getLocalGroups: vi.fn().mockReturnValue([]),
    sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
    sendBaseRefreshRequest: vi.fn().mockResolvedValue(undefined),
    sendHistoryRequest: vi.fn().mockResolvedValue({ noPeerOnline: false }),
    // A reconciliation waits for this device's own inbound queue before asking anybody anything;
    // no case here is about the mailbox, so it is already idle.
    // No distribution group here: `reconcileGroup` asks this before anything else,
    // because a seed carrier has no history to reconcile.
    isDistributionGroup: vi.fn().mockReturnValue(false),
    waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    // Default = external join unavailable, so tests exercise the welcome_request fallback.
    externalJoin: vi.fn().mockResolvedValue({ joined: false, reason: 'no_base_published' }),
    forgetGroup: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue('self-device'),
    // Default = the server holds no PENDING row for this device, so no member owes it a Welcome and
    // the self-service external join is this device's to make. The rows are what separate the two
    // populations `requestReAdd` serves, so a stub that answers nothing puts every case on the
    // "could not tell" path and none of them reach the join at all.
    getDeviceMemberships: vi.fn().mockResolvedValue([]),
    // The self-service join now CLEARS the roster seat it joined on, so the stub owes this call.
    // Without it the success path would reject on `undefined.catch` and every join test would pass
    // for the wrong reason.
    updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * One membership row in the shape `getDeviceMemberships` returns.
 *
 * `facts` IS OMITTED BY DEFAULT ON PURPOSE. A row carrying neither `welcomeQueued` nor `addInFlight`
 * is what a server older than those fields answers, and the rows above pin that a `pending` row is
 * still read as "owed" in that case - the behaviour every shipped client has. A test that always
 * passed the facts could not tell that branch from the new one.
 */
function membership(
  groupId: string,
  status: 'pending' | 'active',
  facts?: { welcomeQueued?: boolean; addInFlight?: boolean }
) {
  return {
    id: `m-${groupId}`,
    userId: 'user-a',
    deviceId: 'self-device',
    groupId,
    status,
    ...facts,
  };
}

function makeConversations(entries: Array<[string, object]> = []) {
  return new Map(entries) as any;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    mlsService: makeMls(),
    storage: null,
    userId: 'user-a',
    deviceKeyB64: 'device-key-123',
    conversations: makeConversations(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ...overrides,
  } as any;
}

// ── requestReAdd ─────────────────────────────────────────────────────────────

describe('requestReAdd', () => {
  it('does not external-join a group a member already owes us a Welcome for', async () => {
    // THE REGRESSION THIS PINS COST GRP-4 ABOUT HALF ITS JOINS. An invited device whose membership
    // is still `pending` has an Add in flight for its own leaf; serving itself an external commit
    // puts two parties in the same tree, and the loser of that race is evicted by the winner's
    // duplicate-leaf repair. The welcome_request is not a fallback here - it is the whole path.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi.fn().mockResolvedValue([membership('g1', 'pending')]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
  });

  it('external-joins a group whose membership is already active', async () => {
    // The other half of the same discriminator: `active` is a device that joined once and may since
    // have lost its local state, which is the ONLY population external join was written for.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi.fn().mockResolvedValue([membership('g1', 'active')]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
  });

  it('waits when a Welcome is actually queued for this device and this group', async () => {
    // `welcomeQueued` is the healthy half of `pending`: the Add worked, delivery is owed, and the
    // frame arrives the moment this device drains its queue. Serving ourselves an external commit
    // here is the GRP-4 race with extra steps.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi
      .fn()
      .mockResolvedValue([
        membership('g1', 'pending', { welcomeQueued: true, addInFlight: false }),
      ]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
  });

  it('waits while a member holds the add lock, even with no Welcome queued yet', async () => {
    // THE WINDOW A QUEUED WELCOME DOES NOT COVER, and the reason `welcomeQueued` alone is not the
    // discriminator. Every Add path takes `mls:addlock:<groupId>` BEFORE writing the roster row and
    // releases it after the Welcome is queued, so "row written, Welcome not yet" is precisely when
    // the lock is held. Reading that instant as "nobody owes me anything" re-opens GRP-4.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi
      .fn()
      .mockResolvedValue([
        membership('g1', 'pending', { welcomeQueued: false, addInFlight: true }),
      ]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
  });

  it('serves itself when the roster seat has no Welcome and no Add in flight', async () => {
    // THE P1 OF 2026-09-03, PINNED. A device that enrols while nobody is online gets one `pending`
    // row per conversation and nothing else - no Welcome queued, no member adding - and used to
    // return here and ask again every 60 s for as long as it stayed open: eleven groups, ten hours,
    // 552 requests on production, and every base was published the whole time. Nothing owes this
    // device anything that exists, so the self-service join is its to make.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi
      .fn()
      .mockResolvedValue([
        membership('g1', 'pending', { welcomeQueued: false, addInFlight: false }),
      ]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('clears the roster seat it joined on, so no member re-adds a leaf already in the tree', async () => {
    // A `pending` row is a WORK ITEM `getPendingInvitations` serves to every member. Joining by
    // external commit and leaving it behind means the next member online calls `addMember` for a
    // leaf that is already there, gets `DuplicateSignature`, and its handler kicks the live leaf.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi
      .fn()
      .mockResolvedValue([
        membership('g1', 'pending', { welcomeQueued: false, addInFlight: false }),
      ]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.updateInvitationStatus).toHaveBeenCalledWith(
      'self-device',
      'user-a',
      'g1',
      'active'
    );
  });

  it('skips the round entirely when the membership status cannot be read', async () => {
    // A THIRD ANSWER THAT IS NOT A "NO". Collapsing an unreadable status into "not pending" would
    // send the invited population back down the external-join path on exactly the conditions where
    // losing the race is likeliest. The watchdog owns the cadence, so skipping costs one cycle.
    const deps = makeDeps();
    deps.mlsService.getDeviceMemberships = vi.fn().mockRejectedValue(new Error('offline'));

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('external join success short-circuits the welcome_request fallback', async () => {
    const deps = makeDeps();
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue({ joined: true });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    // External join lands at the current epoch without the peer-driven history bundle, so the
    // group is reconciled. Nothing durable records that: the comparison is cheap enough to re-run
    // on the next connection, and a note written here could not be discharged from anywhere.
    // No exclusion: this is an ordinary trigger, and only a coverage chase has a reason to skip a
    // member it has already heard from.
    expect(deps.mlsService.sendHistoryRequest).toHaveBeenCalledWith('g1', { exclude: [] });
    expect(probeSender).toHaveBeenCalledWith('g1');
    // Not-ready marker cleared on success.
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).toBeNull();
  });

  it('falls back to a welcome_request when external join is unavailable, and marks not-ready', async () => {
    const deps = makeDeps();

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    // Marked in the persistent registry so the SYNC_WATCHDOG drives the cadence.
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).not.toBeNull();
  });

  it('throttles: two immediate calls make a single recovery attempt (cooldown)', async () => {
    const deps = makeDeps();

    await requestReAdd('g1', deps);
    await requestReAdd('g1', deps);

    // The second call is within RECOVERY_TIMEOUT_MS -> throttled by the internal cooldown.
    expect(deps.mlsService.externalJoin).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);
  });

  it('already in WASM -> no recovery attempt (caller must forgetGroup first if forked)', async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue(['g1']);

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('group confirmed absent from server -> purges the phantom, no recovery', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockResolvedValue(null),
        getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
        getLocalGroups: vi.fn().mockReturnValue([]),
      }),
      conversations: makeConversations([
        ['ghost', { id: 'ghost', name: 'Ghost', lifecycle: 'pending' }],
      ]),
    });

    await requestReAdd('ghost', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.deleteConversation).toHaveBeenCalledWith('ghost');
    expect(deps.conversations.has('ghost')).toBe(false);
  });

  it('group tombstoned server-side (deletedAt) -> marks the conversation removed, no recovery', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi
          .fn()
          .mockResolvedValue({ groupId: 'tomb', isGroup: true, deletedAt: '2026-01-01' }),
      }),
      conversations: makeConversations([
        ['tomb', { id: 'tomb', name: 'Gone', lifecycle: 'active' }],
      ]),
    });

    await requestReAdd('tomb', deps);

    expect(deps.conversations.get('tomb')?.lifecycle).toBe('removed');
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  // ── The refusal that used to be a retry ────────────────────────────────────
  //
  // THREE CASES, AND THE LAST TWO ARE WHY THE FIRST ONE IS TRUSTWORTHY. A 403 on the GroupInfo read
  // is the server saying we hold no membership row, which no retry and no peer can change - so it
  // ends the recovery. Before it was typed it arrived as a bare `false`, went to the welcome_request
  // fallback, and came back every minute for as long as the group existed. The negative cases pin
  // the fix from over-reaching: a failure that says NOTHING about membership must still fall back,
  // and a group that simply has no base published yet must still ask a peer.

  it('server refuses the GroupInfo read as a non-member -> retires the conversation and stops', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new NotAGroupMemberError('left')),
      }),
      conversations: makeConversations([
        ['left', { id: 'left', name: 'A group we are out of', lifecycle: 'active' }],
      ]),
    });

    await requestReAdd('left', deps);

    expect(deps.conversations.get('left')?.lifecycle).toBe('removed');
    // The whole point: nobody is asked to re-add us to a group whose roster refused us.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    // And the watchdog must stop enumerating it, or the cadence outlives the answer.
    expect(localStorage.getItem('mls_not_ready_since:user-a:left')).toBeNull();
  });

  /**
   * THE MAP KEY IS NOT THE GROUP ID, and this module is addressed by group id.
   *
   * A direct conversation created on this device is keyed by its groupId; one learnt from a Welcome
   * is keyed by the PEER'S USER ID (`deriveConversationIdentity`). Every lookup in here used
   * `conversations.get(groupId)`, which finds the first and misses the second - so on the receiving
   * side of every DM the terminating answer was read, logged and then dropped on the floor: nothing
   * was retired, and the idempotence check below could never fire either. The two cases are
   * separated because they failed in opposite directions - one never terminating, one re-terminating
   * for ever.
   */
  it('retires a conversation keyed by the PEER, not by the group id', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new NotAGroupMemberError('g-dm')),
      }),
      conversations: makeConversations([
        ['peer-user-id', { id: 'g-dm', name: 'A DM we were removed from', lifecycle: 'active' }],
      ]),
    });

    await requestReAdd('g-dm', deps);

    expect(deps.conversations.get('peer-user-id')?.lifecycle).toBe('removed');
  });

  it('short-circuits an already-removed conversation keyed by the PEER', async () => {
    const deps = makeDeps({
      conversations: makeConversations([['peer-user-id', { id: 'g-dm', lifecycle: 'removed' }]]),
    });

    await requestReAdd('g-dm', deps);

    // Idempotence is the whole contract of step 1: a dead conversation starts no network recovery.
    expect(deps.mlsService.getGroupMeta).not.toHaveBeenCalled();
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
  });

  it('and a second call then does nothing at all - terminated by a proof, not by the throttle', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new NotAGroupMemberError('left')),
      }),
      conversations: makeConversations([['left', { id: 'left', lifecycle: 'active' }]]),
    });

    await requestReAdd('left', deps);
    // The cooldown is what USED to be the only thing containing this loop, so clearing it is exactly
    // how to tell a real termination from a throttled one: a proof survives the cooldown going away.
    resetReAddCooldowns();
    await requestReAdd('left', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.getGroupMeta).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('a failure that says nothing about membership still falls back to a welcome_request', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new Error('GroupInfo fetch HTTP error: 503')),
      }),
      conversations: makeConversations([['g1', { id: 'g1', lifecycle: 'active' }]]),
    });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    expect(deps.conversations.get('g1')?.lifecycle).toBe('active');
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).not.toBeNull();
  });

  it('already-removed conversation -> immediate no-op', async () => {
    const deps = makeDeps({
      conversations: makeConversations([['g1', { id: 'g1', lifecycle: 'removed' }]]),
    });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.getGroupMeta).not.toHaveBeenCalled();
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
  });
});

// ── recoverForkedGroup ─────────────────────────────────────────────────────────

describe('recoverForkedGroup', () => {
  it('forgets the forked group at the known minEpoch then re-adds it', async () => {
    const mls = makeMls({ getLocalGroups: vi.fn().mockReturnValue([]) });
    const deps = makeDeps({ mlsService: mls });

    await recoverForkedGroup('g-fork', deps, 4);

    // minEpoch rejects a stale re-Welcome from the diverged branch.
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-fork', 4);
    // The forgotten group is no longer local -> requestReAdd attempts recovery (external join first).
    expect(mls.externalJoin).toHaveBeenCalledWith('g-fork');
  });
});

// -- recoverRosterDisagreement ------------------------------------------------

/**
 * THE POPULATION EVERY OTHER ENTRANCE SKIPS: a device holding a well-formed tree for a group whose
 * server roster row never left `pending`. `requestReAdd` returns at its own WASM guard, and the
 * SYNC_WATCHDOG calls `cancelReAdd` on it every 5 s for the same reason - so the only mechanism
 * that can see it is the sender, and the only evidence is the server's refusal.
 */
describe('recoverRosterDisagreement', () => {
  beforeEach(() => resetReAddCooldowns());

  /**
   * A STATEFUL LOCAL SET, because the whole seam turns on the forget being VISIBLE to the guard
   * that runs after it. A static `getLocalGroups` mock reports the group present for ever, so
   * `requestReAdd` returns at its WASM guard and the test passes on a fix that does nothing.
   */
  function makeMlsHolding(groupIds: string[], overrides: Record<string, unknown> = {}) {
    const held = new Set(groupIds);
    return makeMls({
      getLocalGroups: vi.fn(() => [...held]),
      forgetGroup: vi.fn((id: string) => {
        held.delete(id);
      }),
      _rejoin: (id: string) => held.add(id),
      ...overrides,
    });
  }

  it('forgets the tree the server holds no leaf for, then recovers the group', async () => {
    const mls = makeMlsHolding(['g-stuck']);
    const deps = makeDeps({ mlsService: mls });

    await recoverRosterDisagreement('g-stuck', deps);

    // The forget is what makes the seam reachable at all - without it requestReAdd returns at its
    // WASM guard, which is the whole defect.
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-stuck');
    // And recovery actually ran: this device is owed nothing, so it serves itself.
    expect(mls.externalJoin).toHaveBeenCalledWith('g-stuck');
  });

  it('asks the member who owes us a Welcome instead of joining over the top of the Add', async () => {
    const mls = makeMlsHolding(['g-stuck'], {
      getDeviceMemberships: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-stuck', status: 'pending', welcomeQueued: true }]),
    });
    const deps = makeDeps({ mlsService: mls });

    await recoverRosterDisagreement('g-stuck', deps);

    expect(mls.forgetGroup).toHaveBeenCalledWith('g-stuck');
    // A pending seat with a Welcome queued is not ours to external-join: two parties would write
    // the same leaf, which is the GRP-4 kick this discriminator exists to prevent.
    expect(mls.externalJoin).not.toHaveBeenCalled();
    expect(mls.sendWelcomeRequest).toHaveBeenCalled();
  });

  /**
   * WHAT THE THROTTLE ACTUALLY PROTECTS, which is not the repeated call but the repeated FORGET of
   * a tree that has since become good. The outbox re-enters on a ladder starting at 2 s, so a
   * device that rejoins between two stuck sends would have its fresh tree discarded by the very
   * seam that just repaired it.
   */
  it('does not discard a tree that has just been rejoined', async () => {
    const mls = makeMlsHolding(['g-stuck']);
    const deps = makeDeps({ mlsService: mls });

    await recoverRosterDisagreement('g-stuck', deps);
    expect(mls.forgetGroup).toHaveBeenCalledTimes(1);

    // The Welcome lands and the group is healthy again.
    (mls as unknown as { _rejoin: (id: string) => void })._rejoin('g-stuck');
    await recoverRosterDisagreement('g-stuck', deps);

    expect(mls.forgetGroup).toHaveBeenCalledTimes(1);
    expect(mls.getLocalGroups()).toContain('g-stuck');
  });

  it('leaves a group it holds no state for alone, and still drives recovery', async () => {
    const mls = makeMlsHolding([]);
    const deps = makeDeps({ mlsService: mls });

    await recoverRosterDisagreement('g-stuck', deps);

    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(mls.externalJoin).toHaveBeenCalledWith('g-stuck');
  });
});

// ── cancelReAdd ────────────────────────────────────────────────────────────────

describe('cancelReAdd', () => {
  it('clears the cooldown so a later desync re-triggers immediately', async () => {
    const deps = makeDeps();

    await requestReAdd('g1', deps);
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);

    // Without cancelReAdd a second immediate call would be throttled; cancelling lets it fire again.
    cancelReAdd('g1');
    await requestReAdd('g1', deps);
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
  });
});

/**
 * A STALE BASE IS A REFUSAL NO RETRY CAN LIFT, AND IT WAS ANSWERED BY ASKING FOR THE WRONG THING.
 *
 * `externalJoin` answers `stale_base` when the published GroupInfo names an epoch the group has
 * left. Only a member holding the tree can mint a new base, so no amount of retrying helps - and
 * until 2026-09-04 this fell into the shared `welcome_request` fallback, which asks a member to
 * MUTATE the tree, take the group's add lock and replay the duplicate-leaf race, in order to obtain
 * something the requester did not need.
 *
 * Measured on production the same day: four of the forty-three groups holding a base were stale, all
 * by exactly ONE epoch, two of them since 2026-08-30 with three devices sitting `pending` on them. A
 * stale base does not drain itself - only a member's next commit republishes one, and a quiet
 * conversation has no next commit.
 */
describe('requestReAdd - a stale base asks for a republish, not for a Welcome', () => {
  const staleBase = () =>
    vi.fn().mockResolvedValue({
      joined: false,
      reason: 'stale_base',
      baseEpoch: 283,
      serverEpoch: 284,
    });

  it('asks for a base refresh and NOT for a Welcome', async () => {
    const deps = makeDeps();
    deps.mlsService.externalJoin = staleBase();

    await requestReAdd('g1', deps);

    expect(deps.mlsService.sendBaseRefreshRequest).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('names both epochs, so the log says how far behind the base is', async () => {
    const lines: string[] = [];
    const deps = makeDeps();
    deps.log = (m: string) => lines.push(m);
    deps.mlsService.externalJoin = staleBase();

    await requestReAdd('g1', deps);

    const out = lines.join(' | ');
    expect(out).toContain('283');
    expect(out).toContain('284');
  });

  it('still asks for a Welcome when NO base is published - that one a member CAN answer', async () => {
    // The two refusals are not the same question: nothing published means nothing to republish, and
    // a Welcome is then exactly the right favour to ask for.
    const deps = makeDeps();
    deps.mlsService.externalJoin = vi
      .fn()
      .mockResolvedValue({ joined: false, reason: 'no_base_published' });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendBaseRefreshRequest).not.toHaveBeenCalled();
  });

  it('a request that never reaches the server is logged, never thrown', async () => {
    // Best-effort by construction: the watchdog runs this seam again while the device still cannot
    // join, and each ask is forwarded to a randomly re-elected member. A swallowed branch with no
    // line is all a loss leaves.
    const lines: string[] = [];
    const deps = makeDeps();
    deps.log = (m: string) => lines.push(m);
    deps.mlsService.externalJoin = staleBase();
    deps.mlsService.sendBaseRefreshRequest = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(requestReAdd('g1', deps)).resolves.toBeUndefined();
    expect(lines.join(' | ')).toContain('did not reach the server');
  });
});

/**
 * THE BADGE STAYED ON A CONVERSATION THAT HAD JUST REJOINED AND WORKED.
 *
 * Two key conventions live in one map: a DM created on this device is keyed by its groupId, one
 * learnt from a Welcome by the PEER'S USER ID (`deriveConversationIdentity`). The promotion after a
 * successful external join read the map by groupId, so for every RECEIVED DM it found nothing and
 * wrote nothing - and `saveConversation(groupId)` would have persisted nothing either. The
 * conversation was live in WASM, sendable and readable, wearing a badge that claimed otherwise until
 * the next login's reconciliation happened to notice.
 *
 * `findByGroupId` had already been written for exactly this, and the rule it carries is that any
 * `[key]` lookup over this heterogeneously-keyed map is a defect on sight.
 */
describe('requestReAdd - the promotion after a successful external join', () => {
  const joined = () =>
    makeMls({
      getDeviceMemberships: vi.fn().mockResolvedValue([membership('g1', 'active')]),
      externalJoin: vi.fn().mockResolvedValue({ joined: true }),
    });

  it('promotes a conversation keyed by the PEER USER ID, and saves it by that key', async () => {
    const deps = makeDeps({
      mlsService: joined(),
      conversations: makeConversations([['peer-user-42', { id: 'g1', lifecycle: 'pending' }]]),
    });

    await requestReAdd('g1', deps);

    expect(deps.conversations.get('peer-user-42').lifecycle).toBe('active');
    expect(deps.saveConversation).toHaveBeenCalledWith('peer-user-42');
    // The groupId is NOT a key here, and writing under it would leave the real row pending while
    // adding a second, unreachable one.
    expect(deps.conversations.has('g1')).toBe(false);
  });

  it('promotes a conversation keyed by its own groupId, which is the other convention', async () => {
    const deps = makeDeps({
      mlsService: joined(),
      conversations: makeConversations([['g1', { id: 'g1', lifecycle: 'pending' }]]),
    });

    await requestReAdd('g1', deps);

    expect(deps.conversations.get('g1').lifecycle).toBe('active');
    expect(deps.saveConversation).toHaveBeenCalledWith('g1');
  });

  it('writes nothing when the conversation is already active - the common case is free', async () => {
    const deps = makeDeps({
      mlsService: joined(),
      conversations: makeConversations([['peer-user-42', { id: 'g1', lifecycle: 'active' }]]),
    });

    await requestReAdd('g1', deps);

    expect(deps.saveConversation).not.toHaveBeenCalled();
  });

  it('creates the conversation row BEFORE publishing the leaf, never after it', async () => {
    // THE ORDER IS THE ASSERTION, and a test that only checked the row exists AFTERWARDS would pass
    // on the defect: it did exist afterwards - five seconds afterwards, created by a different
    // sweep - and the member's history answer arrived in between and was buffered
    // `absent-conversation` (HEAL-REVOKE-4, 2026-09-06). `externalJoin` is the instant this device
    // becomes addressable, so what the map holds AT THAT CALL is the whole question.
    const deps = makeDeps({ mlsService: joined(), conversations: makeConversations() });
    let rowsWhenTheLeafWentOut = -1;
    deps.mlsService.externalJoin = vi.fn(async () => {
      rowsWhenTheLeafWentOut = deps.conversations.size;
      return { joined: true };
    });

    await requestReAdd('g1', deps);

    expect(rowsWhenTheLeafWentOut).toBe(1);
    expect(deps.conversations.get('g1').id).toBe('g1');
    // And it is persisted, so a reload cannot re-open the window the join just closed.
    expect(deps.saveConversation).toHaveBeenCalledWith('g1');
  });

  it('caps the retry rate when the server row cannot be read, though it made no attempt', async () => {
    // THE WATCHDOG CALLS THIS SEAM EVERY FIVE SECONDS. Deferring the join is right; deferring it
    // without arming the cooldown turns an unreachable server into two HTTP round trips every five
    // seconds, for as long as it stays unreachable. The throttle is the only thing between the two.
    const deps = makeDeps({ mlsService: joined(), conversations: makeConversations() });
    deps.mlsService.getGroupMeta = vi.fn().mockResolvedValue(null);
    deps.mlsService.getGroupServerStatus = vi.fn().mockResolvedValue('error');

    await requestReAdd('g1', deps);
    await requestReAdd('g1', deps);

    // One probe, not two: the second call is refused by the cooldown before it asks anything.
    expect(deps.mlsService.getGroupMeta).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
  });

  it('does not join at all when no row can be built, rather than joining anyway', async () => {
    // A DM whose peer the roster cannot name yet has no row that can be created, so this device
    // must not become reachable for it. The watchdog re-invokes on its cadence; joining first would
    // buy nothing but the window above.
    const deps = makeDeps({
      mlsService: joined(),
      conversations: makeConversations(),
    });
    deps.mlsService.getGroupMeta = vi
      .fn()
      .mockResolvedValue({ groupId: 'g1', isGroup: false, name: '', deletedAt: null });
    deps.mlsService.getGroupUserMembers = vi.fn().mockResolvedValue([{ userId: 'user-a' }]);

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.conversations.size).toBe(0);
  });

  it('stops recovering a group this device owes the server an exit for', async () => {
    // Rejoining a group the user deleted is the DEL-10 resurrection with the halves swapped: the
    // row is refused (correctly), so the join would make this device a member of a group nothing
    // can route for, for ever. Terminating on the owed-exit row is a proof, not a timeout.
    const deps = makeDeps({
      mlsService: joined(),
      conversations: makeConversations(),
      storage: {
        getPendingGroupExits: vi
          .fn()
          .mockResolvedValue([{ groupId: 'g1', kind: 'delete', requestedAt: 1 }]),
      },
    });

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.conversations.size).toBe(0);
  });
});
