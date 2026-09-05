import type { Conversation } from '$lib/types';
import type { IStorage, StoredMessage } from '$lib/db';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

// Mock only the outbound history senders so each can be asserted, keeping the rest of groupActions
// (persist helpers, `readHistoryEntries`, the state key) intact - the comparison under test is
// computed from a REAL store read, so stubbing that too would leave nothing being tested.
const {
  sendFullHistoryBundle,
  sendHistoryBundleForIds,
  sendHistoryPull,
  sendHistoryDigestRequest,
  sendHistoryRangeBundle,
  sendHistoryCoverage,
} = vi.hoisted(() => ({
  sendFullHistoryBundle: vi.fn().mockResolvedValue(undefined),
  sendHistoryBundleForIds: vi.fn().mockResolvedValue(undefined),
  sendHistoryPull: vi.fn().mockResolvedValue(undefined),
  sendHistoryDigestRequest: vi.fn().mockResolvedValue(undefined),
  sendHistoryRangeBundle: vi.fn().mockResolvedValue(undefined),
  sendHistoryCoverage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupActions')>();
  return {
    ...actual,
    sendFullHistoryBundle,
    sendHistoryBundleForIds,
    sendHistoryPull,
    sendHistoryDigestRequest,
    sendHistoryRangeBundle,
    sendHistoryCoverage,
  };
});

import { handleHistoryRequest } from './actions';
import { buildHistoryDigest, historyRangeOf, type HistoryEntry } from './historyManifest';
import {
  digestIdentity,
  noteProbeReceived,
  resetHistoryDigestRendezvousForTests,
  takeDigestSolicitation,
} from './historyDigestRendezvous';
import { historyStateKey, invalidateAllHistoryStateKeys } from './historyStateKey';

const GROUP = 'g1';
const SELF_USER = 'u1';
const SELF_DEVICE = 'dev-self';
const REQUESTER_USER = 'u2';
const REQUESTER_DEVICE = 'dev-requester';
const REQUESTER = digestIdentity(REQUESTER_USER, REQUESTER_DEVICE);
const SELF = digestIdentity(SELF_USER, SELF_DEVICE);

function activeConversations(groupId: string): Map<string, Conversation> {
  return new Map([
    [
      groupId,
      {
        id: groupId,
        contactName: groupId,
        name: 'Test',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      } as Conversation,
    ],
  ]);
}

/** The stored row a manifest entry stands for, so one fixture drives both the digest and the key. */
const rowOf = (e: HistoryEntry): StoredMessage =>
  ({
    id: e.id,
    conversationId: GROUP,
    senderId: 'someone',
    content: 'x',
    timestamp: e.timestamp,
  }) as StoredMessage;

/**
 * A store holding exactly `entries`, or one that throws when `entries` is the string 'broken'.
 *
 * `historyFloor` is what this device would ask FROM. Setting it above the device window is what
 * makes the window assertions deterministic: the range start is `max(floor, windowStart)`, so a
 * recent floor decides it outright and the test never has to name a wall clock.
 */
function storageWith(entries: HistoryEntry[] | 'broken', historyFloor?: number): IStorage {
  return {
    getMessages: vi.fn().mockImplementation(async () => {
      if (entries === 'broken') throw new Error('store unreadable');
      return entries.map(rowOf);
    }),
    getConversations: vi
      .fn()
      .mockResolvedValue([
        { id: GROUP, name: 'Test', lifecycle: 'active', updatedAt: 0, historyFloor },
      ]),
    // The single-row read the window actually uses. Kept consistent with `getConversations` above
    // on purpose: a fixture that answers one and not the other would let a caller that reads the
    // row see no floor at all, which is what this file exists to assert about.
    getConversation: vi
      .fn()
      .mockImplementation(async (id: string) =>
        id === GROUP
          ? { id: GROUP, name: 'Test', lifecycle: 'active', updatedAt: 0, historyFloor }
          : null
      ),
  } as unknown as IStorage;
}

const at = (iso: string) => Date.parse(iso);

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    storage: storageWith([]),
    deviceKeyB64: 'k',
    log: vi.fn(),
    requesterUserId: REQUESTER_USER,
    requesterDeviceId: REQUESTER_DEVICE,
    selfUserId: SELF_USER,
    groupId: GROUP,
    conversations: activeConversations(GROUP),
    mlsService: createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      getDeviceId: vi.fn().mockReturnValue(SELF_DEVICE),
    }),
    // No probe ever ARRIVES here unless one was posted before the call, so the wait is collapsed to
    // keep the suite fast - it is a bound, never a schedule.
    probeWaitMs: 1,
    ...overrides,
  } as Parameters<typeof handleHistoryRequest>[0];
}

/**
 * No history moved and no exchange continued. The fast path's whole assertion.
 *
 * `sendHistoryCoverage` is deliberately NOT part of it: it moves nothing and asks for nothing, it
 * only states where this device's own memory begins. Most cases below state `since = 0` - "I name no
 * window" - which every device is narrower than, so folding it in here would turn one assertion
 * about the exchange into an assertion about the fixture's dates. It has its own block instead.
 */
function expectSilence(): void {
  expect(sendFullHistoryBundle).not.toHaveBeenCalled();
  expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  expect(sendHistoryPull).not.toHaveBeenCalled();
  expect(sendHistoryDigestRequest).not.toHaveBeenCalled();
  expect(sendHistoryRangeBundle).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  // The state key is cached per conversation, and every case here builds a different store behind
  // the same group id - a cache surviving between them would answer the previous case's question.
  invalidateAllHistoryStateKeys();
  sendFullHistoryBundle.mockClear();
  sendHistoryBundleForIds.mockClear();
  sendHistoryPull.mockClear();
  sendHistoryDigestRequest.mockClear();
  sendHistoryRangeBundle.mockClear();
  sendHistoryCoverage.mockClear();
});

describe('handleHistoryRequest - guards', () => {
  it('skips when the group is not held locally (cannot re-encrypt history)', async () => {
    await handleHistoryRequest(
      baseParams({
        mlsService: createMlsServiceStub({ getLocalGroups: vi.fn().mockReturnValue([]) }),
      })
    );
    expectSilence();
  });

  it('skips when the conversation is not active locally', async () => {
    await handleHistoryRequest(baseParams({ conversations: new Map() }));
    expectSilence();
  });

  it('answers from a SETTLED store - the inbound queue is drained first', async () => {
    // An external-commit self-join lands the requester one epoch ahead of a peer that has not yet
    // applied its commit, and a bundle re-encrypted at the old epoch is undecryptable to it. The
    // requester used to pause 2.5 s before asking, standing in for an ordering neither side could
    // observe; it is observable here, and this is where it is awaited.
    const params = baseParams();
    await handleHistoryRequest(params);
    expect(params.mlsService.waitForMessageQueueIdle).toHaveBeenCalled();
  });
});

describe('handleHistoryRequest - a probe that never arrives', () => {
  it('says nothing rather than dumping the whole store', async () => {
    // The old fallback. A device that named nothing was answered with everything, on the reasoning
    // that it might be too old to describe itself - which meant every dropped MLS frame cost a full
    // store transfer to a peer that may have needed none of it. There is no such peer any more: the
    // requester states its ask on every solicitation, and asking again costs one frame.
    await handleHistoryRequest(baseParams({ probeWaitMs: 1 }));
    expectSilence();
  });

  it('ignores a probe sent by a DIFFERENT device of the same user', async () => {
    // The election named one device. Answering another device's snapshot would compare against a
    // store that is not the asker's.
    noteProbeReceived(GROUP, digestIdentity(REQUESTER_USER, 'some-other-device'), {
      kind: 'digest',
      digest: { mode: 'ids', ids: ['a'] },
      since: 0,
    });
    await handleHistoryRequest(baseParams());
    expectSilence();
  });
});

describe('handleHistoryRequest - the state key', () => {
  /** Posts the requester's state key, computed over the same rule both devices apply. */
  async function postKey(entries: HistoryEntry[], since = 0): Promise<void> {
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'state',
      key: await historyStateKey(entries.map(rowOf), since),
      since,
    });
  }

  const rows = [
    { id: 'm1', timestamp: at('2026-01-01T00:00:00Z') },
    { id: 'm2', timestamp: at('2026-01-02T00:00:00Z') },
  ];

  it('says NOTHING when the two keys agree - the common case, and it must cost one frame', async () => {
    await postKey(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));
    expectSilence();
  });

  it('agrees on two empty stores, rather than reading emptiness as a difference', async () => {
    await postKey([]);
    await handleHistoryRequest(baseParams({ storage: storageWith([]) }));
    expectSilence();
  });

  it('asks the requester to describe itself when the keys differ', async () => {
    await postKey([rows[0]]);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryDigestRequest).toHaveBeenCalledWith(
      GROUP,
      { from: SELF, to: REQUESTER },
      expect.anything()
    );
    // And nothing is sent on that turn: the digest decides what, and it has not arrived yet.
    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
  });

  it('computes ITS key over the window the requester stated, not over its own', async () => {
    // Two devices comparing over two different ranges can never agree, so the fast path would never
    // fire - and every connection would pay a digest exchange for stores that match.
    const SINCE = at('2026-01-02T00:00:00Z');
    await postKey(rows, SINCE);
    await handleHistoryRequest(
      baseParams({ storage: storageWith(rows, at('2020-01-01T00:00:00Z')) })
    );

    // `m1` falls below the stated window on both sides, so the keys match and nothing is sent.
    expectSilence();
  });

  it('stays silent when its own store cannot be read - a failed read proves nothing', async () => {
    await postKey(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith('broken') }));
    expectSilence();
  });

  it('asks for a digest and ENDS - the answer is an event, not a continuation', async () => {
    // The second leg used to block here for `DIGEST_TTL_MS` and give up. It waits for nothing now:
    // the digest carries the manifest and the window, so it is answered wherever it lands - see
    // `systemMessageHandler`'s `history_digest` branch and the solicitation cases below.
    await postKey([rows[0]]);

    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryDigestRequest).toHaveBeenCalled();
    expect(sendHistoryBundleForIds).not.toHaveBeenCalled();
    expect(takeDigestSolicitation(GROUP, REQUESTER)).toBe(true);
  });
});

describe('handleHistoryRequest - with a digest', () => {
  /** Posts the requester's digest so the rendezvous can hand it to the call under test. */
  async function postDigest(entries: HistoryEntry[], idModeMax?: number, since = 0): Promise<void> {
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'digest',
      digest: await buildHistoryDigest(entries, idModeMax),
      since,
    });
  }

  it('sends ONLY what the requester lacks, never the whole store', async () => {
    await postDigest([{ id: 'shared', timestamp: at('2026-01-01T00:00:00Z') }]);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([
          { id: 'shared', timestamp: at('2026-01-01T00:00:00Z') },
          { id: 'only-ours', timestamp: at('2026-01-02T00:00:00Z') },
        ]),
      })
    );

    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
      GROUP,
      ['only-ours'],
      expect.anything(),
      // `since: 0` is the requester's own window, restated: this digest stated none.
      { to: REQUESTER, since: 0 }
    );
  });

  it('sends an empty selection for identical stores, which sends nothing at all', async () => {
    // `sendHistoryBundleForIds` drops an empty selection on the floor, so this is a call with an
    // empty id list rather than a frame. There is no marker on the other side to discharge.
    const rows = [{ id: 'same', timestamp: at('2026-01-01T00:00:00Z') }];
    await postDigest(rows);
    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, [], expect.anything(), {
      to: REQUESTER,
      since: 0,
    });
    expect(sendHistoryPull).not.toHaveBeenCalled();
  });

  it('PULLS what the requester has and we do not - one exchange repairs both devices', async () => {
    await postDigest([
      { id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') },
      { id: 'shared', timestamp: at('2026-01-02T00:00:00Z') },
    ]);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([{ id: 'shared', timestamp: at('2026-01-02T00:00:00Z') }]),
      })
    );

    expect(sendHistoryPull).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ from: SELF, to: REQUESTER, ids: ['theirs'] }),
      expect.anything()
    );
  });

  it('stays silent when its own store cannot be read', async () => {
    // A failed read proves nothing about the group.
    await postDigest([{ id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') }]);
    await handleHistoryRequest(baseParams({ storage: storageWith('broken') }));

    expectSilence();
  });

  it('resolves a range-mode digest to whole SLICES of the id space, in both directions', async () => {
    // Above the id threshold a digest can only say which slice differs, so the answer over-sends
    // that slice. The receiver dedupes by id, making the cost bandwidth rather than correctness.
    // The three fixture ids land in three distinct depth-1 slices, which is what makes the
    // expectations below exact rather than incidental.
    const sliceOf = (id: string) => historyRangeOf(id, 1);
    expect(new Set(['theirs', 'ours-a', 'ours-b'].map(sliceOf)).size).toBe(3);

    await postDigest([{ id: 'theirs', timestamp: at('2026-01-10T00:00:00Z') }], -1);
    await handleHistoryRequest(
      baseParams({
        storage: storageWith([
          { id: 'ours-a', timestamp: at('2026-01-20T00:00:00Z') },
          { id: 'ours-b', timestamp: at('2026-02-10T00:00:00Z') },
        ]),
      })
    );

    // Both our slices are ours alone, so both are pushed wholesale.
    expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
      GROUP,
      ['ours-a', 'ours-b'],
      expect.anything(),
      { to: REQUESTER, since: 0 }
    );
    // Their slice is theirs alone, so it is pulled - and the DEPTH travels with the prefix, or it
    // names a slice the answering device cannot compute.
    expect(sendHistoryPull).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ prefixes: [sliceOf('theirs')], depth: 1, ids: [] }),
      expect.anything()
    );
  });

  describe('whose window bounds what', () => {
    // The rule this fixes in place: on the leg where we ANSWER we honour the requester's window, and
    // on the leg where we ASK we state our own. One handler plays both roles in a single exchange,
    // which is exactly why the two are easy to confuse.

    /** A floor recent enough to sit above any device window, so it alone decides the range start. */
    const OUR_FLOOR = Date.now() - 60_000;
    const THEIR_SINCE = 1_700_000_000_000;

    it('bounds the ANSWER by the window the requester stated, not by its own', async () => {
      await postDigest([], undefined, THEIR_SINCE);
      await handleHistoryRequest(
        baseParams({
          storage: storageWith([{ id: 'ours', timestamp: at('2026-01-01T00:00:00Z') }], OUR_FLOOR),
        })
      );

      expect(sendHistoryBundleForIds).toHaveBeenCalledWith(GROUP, ['ours'], expect.anything(), {
        to: REQUESTER,
        since: THEIR_SINCE,
      });
    });

    it("bounds what it ASKS BACK for by its OWN window, never by the requester's", async () => {
      // A phone diffing against a browser's digest asks back for five years. Reusing the browser's
      // ninety days would cap every device in the conversation at the shortest window in it.
      await postDigest(
        [{ id: 'theirs', timestamp: at('2026-01-01T00:00:00Z') }],
        undefined,
        THEIR_SINCE
      );
      await handleHistoryRequest(baseParams({ storage: storageWith([], OUR_FLOOR) }));

      expect(sendHistoryPull).toHaveBeenCalledWith(
        GROUP,
        expect.objectContaining({ ids: ['theirs'], since: OUR_FLOOR }),
        expect.anything()
      );
    });

    it('answers in full when the requester stated no window, rather than inventing one', async () => {
      // A client that states no window has not declined anything. Clipping it to a bound we chose
      // for it would withhold messages nobody refused.
      await postDigest([]);
      await handleHistoryRequest(
        baseParams({
          storage: storageWith([{ id: 'ours', timestamp: at('2020-01-01T00:00:00Z') }], OUR_FLOOR),
        })
      );

      expect(sendHistoryBundleForIds).toHaveBeenCalledWith(
        GROUP,
        ['ours'],
        expect.anything(),
        expect.objectContaining({ since: 0 })
      );
    });
  });
});

describe('handleHistoryRequest - the solicitation outlives the wait', () => {
  /**
   * THE P1 OF 2026-09-05, PINNED AT ITS SEAM.
   *
   * The asker answers a digest request only once its own inbound queue has drained, and a device
   * that has just rejoined is applying every group's external join at once - measured at 67 s
   * against this 60 s wait, with the digest arriving seven seconds after it ended. The exchange used
   * to die there and nothing retried it, so the conversation settled READY and three messages short,
   * for ever. What makes the late digest answerable is that this device still knows it asked.
   */
  it('records an outstanding solicitation, so the digest is answerable whenever it comes', async () => {
    noteProbeReceived(GROUP, REQUESTER, { kind: 'state', key: 'ffff', since: 0 });

    await handleHistoryRequest(baseParams({ probeWaitMs: 1 }));

    expect(sendHistoryDigestRequest).toHaveBeenCalled();
    expect(takeDigestSolicitation(GROUP, REQUESTER)).toBe(true);
  });

  it('answers a digest that arrives WITHOUT a state leg inline, and leaves nothing outstanding', async () => {
    // A device that goes straight to a digest is answered here and now: there was no request of
    // ours to record, so nothing is left for the late road to find and answer a second time.
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'digest',
      digest: await buildHistoryDigest([]),
      since: 0,
    });

    await handleHistoryRequest(baseParams({ probeWaitMs: 1 }));

    expect(sendHistoryBundleForIds).toHaveBeenCalled();
    expect(takeDigestSolicitation(GROUP, REQUESTER)).toBe(false);
  });

  it('records nothing when the two stores AGREE - there is no second leg to answer late', async () => {
    const rows = [{ id: 'm1', timestamp: at('2026-08-01T10:00:00Z') }];
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'state',
      key: await historyStateKey(rows.map(rowOf), 0),
      since: 0,
    });

    await handleHistoryRequest(baseParams({ storage: storageWith(rows) }));

    expect(sendHistoryDigestRequest).not.toHaveBeenCalled();
    expect(takeDigestSolicitation(GROUP, REQUESTER)).toBe(false);
  });
});

describe('handleHistoryRequest - scrollback', () => {
  it('answers a range probe with the bounded page it named', async () => {
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'range',
      before: at('2026-01-05T00:00:00Z'),
      limit: 50,
      since: at('2020-01-01T00:00:00Z'),
    });
    await handleHistoryRequest(baseParams());

    expect(sendHistoryRangeBundle).toHaveBeenCalledWith(GROUP, expect.anything(), {
      to: REQUESTER,
      before: at('2026-01-05T00:00:00Z'),
      limit: 50,
      since: at('2020-01-01T00:00:00Z'),
    });
    // A scrollback is not a reconciliation: it compares nothing and asks for nothing back.
    expect(sendHistoryDigestRequest).not.toHaveBeenCalled();
    expect(sendHistoryPull).not.toHaveBeenCalled();
  });
});

/**
 * What a responder says about its OWN memory - the fact the fourth trigger is built on.
 *
 * The asker cannot see this from anywhere else. A device that keeps ninety days answering a device
 * that keeps five years produces a short answer every single time, and a short answer is
 * indistinguishable from "the conversation has no more past" unless somebody states which it is.
 * The responder is the only party that knows, so it is the party that says.
 */
describe('handleHistoryRequest - stating our coverage', () => {
  /**
   * A floor recent enough to sit above any device window, so `max(floor, window)` is decided by the
   * floor alone - the same construction as `OUR_FLOOR` above, and for the same reason.
   *
   * It is RELATIVE to now on purpose. This was the literal `2026-06-01`, which sat above the
   * ninety-day window on the day it was written and below it the next morning: the suite went red
   * at midnight having asserted a wall clock without ever naming one. A date that only works while
   * it holds a fixed relation to `Date.now()` IS a wall-clock assertion, whatever its spelling.
   */
  const FLOOR = Date.now() - 60_000;
  /** Below the floor and below any device window, whenever this suite happens to run. */
  const BELOW_FLOOR = at('2020-01-01T00:00:00Z');
  /** A message this device holds INSIDE its own coverage - the only side of the floor that is fixed. */
  const IN_COVERAGE = FLOOR + 1_000;

  it('states where our history begins when the asker asked from below it', async () => {
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'digest',
      digest: await buildHistoryDigest([]),
      since: BELOW_FLOOR,
    });

    await handleHistoryRequest(baseParams({ storage: storageWith([], FLOOR) }));

    expect(sendHistoryCoverage).toHaveBeenCalledWith(
      GROUP,
      { from: SELF, to: REQUESTER, since: BELOW_FLOOR, coveredFrom: FLOOR },
      expect.anything()
    );
  });

  it('says nothing when the exchange died before we ever answered', async () => {
    // The keys differed, we asked the requester to describe itself, and no digest came. Nothing
    // left this device, so there is no answer for a coverage line to be the end of - and the asker
    // is plainly not listening.
    noteProbeReceived(GROUP, REQUESTER, { kind: 'state', key: 'ffff', since: BELOW_FLOOR });

    await handleHistoryRequest(baseParams({ storage: storageWith([], FLOOR) }));

    expect(sendHistoryDigestRequest).toHaveBeenCalled();
    expect(sendHistoryCoverage).not.toHaveBeenCalled();
  });

  it('says NOTHING when it covers everything that was asked for', async () => {
    // Silence has to keep meaning "I cover your window", or the fast path costs two frames instead
    // of one for the case that matters most - two devices of the same platform, agreeing.
    const rows = [{ id: 'm1', timestamp: IN_COVERAGE }];
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'state',
      key: await historyStateKey(rows.map(rowOf), FLOOR),
      since: FLOOR,
    });

    await handleHistoryRequest(baseParams({ storage: storageWith(rows, FLOOR) }));

    expect(sendHistoryCoverage).not.toHaveBeenCalled();
  });

  it('states it even when the two stores AGREE - agreement is not completeness', async () => {
    // Both devices can hold exactly the same messages over the asker's window and both be missing
    // the years below ours. The key is computed from what each store holds, so it matches happily,
    // and this is the only signal that would send the asker to a member with a longer memory.
    const rows = [{ id: 'm1', timestamp: IN_COVERAGE }];
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'state',
      key: await historyStateKey(rows.map(rowOf), BELOW_FLOOR),
      since: BELOW_FLOOR,
    });

    await handleHistoryRequest(baseParams({ storage: storageWith(rows, FLOOR) }));

    expectSilence();
    expect(sendHistoryCoverage).toHaveBeenCalled();
  });

  it('states it LAST, after everything it had to give', async () => {
    // MLS orders one sender's frames, so arriving last is what makes it read as "that is all".
    const order: string[] = [];
    sendHistoryBundleForIds.mockImplementation(async () => void order.push('bundle'));
    sendHistoryCoverage.mockImplementation(async () => void order.push('coverage'));
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'digest',
      digest: await buildHistoryDigest([]),
      since: BELOW_FLOOR,
    });

    await handleHistoryRequest(
      baseParams({
        storage: storageWith([{ id: 'only-ours', timestamp: IN_COVERAGE }], FLOOR),
      })
    );

    expect(order).toEqual(['bundle', 'coverage']);
    sendHistoryBundleForIds.mockResolvedValue(undefined);
    sendHistoryCoverage.mockResolvedValue(undefined);
  });

  it('states it after a scrollback answer too - the same fact bounds that ask as well', async () => {
    noteProbeReceived(GROUP, REQUESTER, {
      kind: 'range',
      before: at('2026-08-01T00:00:00Z'),
      limit: 50,
      since: BELOW_FLOOR,
    });

    await handleHistoryRequest(baseParams({ storage: storageWith([], FLOOR) }));

    expect(sendHistoryCoverage).toHaveBeenCalledWith(
      GROUP,
      expect.objectContaining({ coveredFrom: FLOOR }),
      expect.anything()
    );
  });

  it('says nothing when our store could not be read - that silence means "ask somebody else"', async () => {
    // A failed read proves nothing about this group, and a coverage line attached to it would tell
    // the asker we answered when we did not - ending its walk one member early.
    noteProbeReceived(GROUP, REQUESTER, { kind: 'state', key: 'ffff', since: BELOW_FLOOR });

    await handleHistoryRequest(baseParams({ storage: storageWith('broken', FLOOR) }));

    expectSilence();
    expect(sendHistoryCoverage).not.toHaveBeenCalled();
  });

  it('says nothing when no probe ever arrived - there was no ask to answer', async () => {
    await handleHistoryRequest(baseParams({ storage: storageWith([], FLOOR) }));
    expect(sendHistoryCoverage).not.toHaveBeenCalled();
  });
});
