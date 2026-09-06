import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { discoverMissingGroups } from './actions';
import {
  forgetMlsGroupIfPresent,
  purgeLocalConversationRecord,
  purgeOrphanGroup,
} from './groupActions';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  // BOTH HALVES OF ONE ACT, mirrored from `BaseMlsService`. Dropping a group goes through
  // `forgetDistributionGroupById`, which erases the tree AND the note classifying it as a seed
  // carrier - a note left behind would answer "distribution group" for state the device no longer
  // holds, and the sweep spares whatever that note names. A stub with only `forgetGroup` would turn
  // the call into a caught `TypeError` and every assertion here would pass for the wrong reason.
  //
  // The held-check is kept too, because "only when WASM knows the group" is a real claim: the real
  // method returns false, and forgets nothing, for a group this device holds nothing under. Read
  // lazily off the built object so a test overriding `getLocalGroups` or `forgetGroup` still gets a
  // consistent pair.
  const built: Record<string, unknown> = {
    getUserGroups: vi.fn().mockResolvedValue([]),
    getLocalGroups: vi.fn().mockReturnValue([]),
    forgetGroup: vi.fn(),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    getDismissedGroups: vi.fn().mockResolvedValue([]),
    getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
    getGroupUserMembers: vi.fn().mockResolvedValue([]),
    isDistributionGroup: vi.fn().mockReturnValue(false),
    // Creating a placeholder ANNOUNCES it: a frame already buffered `absent-conversation` for this
    // group becomes routable at exactly this instant. Stubbed here rather than per test because
    // every path through `ensureConversationForServerGroup` that creates a row calls it.
    notifyConversationAvailable: vi.fn(),
    registerDistributionGroup: vi.fn(),
    forgetDistributionGroupById: vi.fn((groupId: string) => {
      const local = (built.getLocalGroups as () => string[])();
      if (!local.includes(groupId)) return false;
      (built.forgetGroup as (id: string) => void)(groupId);
      return true;
    }),
    ...overrides,
  };
  return built as unknown as IMlsService;
}

describe('forgetMlsGroupIfPresent', () => {
  it('calls forgetGroup only when WASM knows the group', () => {
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });
    expect(forgetMlsGroupIfPresent(mlsService, 'g1')).toBe(true);
    expect(mlsService.forgetGroup).toHaveBeenCalledWith('g1');
    expect(forgetMlsGroupIfPresent(mlsService, 'missing')).toBe(false);
  });
});

describe('purgeLocalConversationRecord', () => {
  it('removes map entry and IndexedDB row without touching MLS', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Test',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls();

    await purgeLocalConversationRecord({
      conversations,
      contactKey: 'g1',
      groupId: 'g1',
      deleteConversation,
    });

    expect(conversations.has('g1')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('g1');
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });
});

describe('purgeOrphanGroup', () => {
  it('forgets MLS then persists state then drops UI row', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Test',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });

    await purgeOrphanGroup({
      conversations,
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      contactKey: 'g1',
      groupId: 'g1',
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith('g1');
    // The forget has to reach disk, whatever "disk" means on this platform - which is exactly why
    // the assertion is on the checkpoint and not on `saveState`, whose result web still has to store.
    expect(mlsService.persistCheckpoint).toHaveBeenCalledWith('1234');
    expect(conversations.has('g1')).toBe(false);
  });
});

describe('discoverMissingGroups orphan cleanup', () => {
  it('marks an established conversation deletedRemotely (not purged) when it is a server tombstone', async () => {
    // A ready conversation absent from our membership BUT still present server-side with
    // deletedAt (deleted by a peer / us on another device). We land on a deletedRemotely
    // tombstone instead of a silent purge: the user keeps the row, sees the banner and
    // deletes it locally. (A silent purge would let them type into a dead group.) We only
    // purge if getGroupServerStatus confirms total absence ('absent').
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      // Tombstone: the dm_groups row still exists with deletedAt -> keep + banner.
      getGroupServerStatus: vi
        .fn()
        .mockResolvedValue({ groupId: 'orphan-id', deletedAt: '2026-01-01T00:00:00Z' }),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation,
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(true);
    expect(conversations.get('orphan-id')?.lifecycle).toBe('removed');
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(saveConversation).toHaveBeenCalledWith('orphan-id');
  });

  it('re-seeds the authoritative group name + avatar from the server onto an existing group', async () => {
    // A device that missed the one-shot `groupRenamed` MLS message keeps a stale name ("Groupe").
    // Discovery must converge it to the server row (source of truth), like it already does for the
    // avatar. DM names are peer-derived and must NOT be overwritten from the server row.
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Groupe',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
          conversationType: 'group',
          imageMediaId: null,
        },
      ],
    ]);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([
          { groupId: 'g1', name: 'Les ROOTz', isGroup: true, imageMediaId: 'img-9' },
        ]),
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.get('g1')?.name).toBe('Les ROOTz');
    expect(conversations.get('g1')?.imageMediaId).toBe('img-9');
    expect(saveConversation).toHaveBeenCalledWith('g1');
  });

  it("purge une conversation que l'utilisateur a dismissée (suppression/quitter manuel, regles 3/5)", async () => {
    const conversations = new Map<string, Conversation>([
      [
        'dismissed-id',
        {
          id: 'dismissed-id',
          contactName: 'dismissed-id',
          name: 'Dismissée',
          messages: [],
          lifecycle: 'removed', // even marked, an explicit dismiss purges it on all devices
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getDismissedGroups: vi.fn().mockResolvedValue(['dismissed-id']),
      // Even if the group still exists server-side, dismiss takes priority -> purge.
      getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'dismissed-id', deletedAt: null }),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('dismissed-id')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('dismissed-id');
  });

  it('garde une conversation vivante ou on est ENCORE membre (snapshot perime, anti-race)', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'fresh-id',
        {
          id: 'fresh-id',
          contactName: 'fresh-id',
          name: 'Fraiche',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]), // stale snapshot: does not list fresh-id
      getLocalGroups: vi.fn().mockReturnValue([]),
      getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'fresh-id', deletedAt: null }),
      // Fresh dm_group_members: we are still a member -> keep active, DO NOT mark.
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'user-a' }]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation,
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.has('fresh-id')).toBe(true);
    expect(conversations.get('fresh-id')?.lifecycle).not.toBe('removed');
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it("marque deletedRemotely une exclusion (groupe vivant, on n'est PLUS membre)", async () => {
    const conversations = new Map<string, Conversation>([
      [
        'excluded-id',
        {
          id: 'excluded-id',
          contactName: 'excluded-id',
          name: 'Exclu',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'excluded-id', deletedAt: null }),
      // Group alive but we are NOT in the members -> exclusion -> banner.
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'someone-else' }]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation,
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.has('excluded-id')).toBe(true);
    expect(conversations.get('excluded-id')?.lifecycle).toBe('removed');
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('purges a placeholder (never-ready) UI row when absent from server', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          lifecycle: 'pending',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('orphan-id');
  });

  it('forgets phantom MLS group even without UI conversation row', async () => {
    const conversations = new Map<string, Conversation>();
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue(['phantom-mls']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      log: vi.fn(),
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith('phantom-mls');
    // The forget has to reach disk, whatever "disk" means on this platform - which is exactly why
    // the assertion is on the checkpoint and not on `saveState`, whose result web still has to store.
    expect(mlsService.persistCheckpoint).toHaveBeenCalledWith('1234');
  });

  it('does not purge when server fetch failed', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockRejectedValue(new Error('network')),
      getLocalGroups: vi.fn().mockReturnValue(['orphan-id']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(true);
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });

  it('does NOT forget a group created while the server list was being fetched', async () => {
    // THE RACE THAT DESTROYED A REAL CONVERSATION, on prod on 2026-08-30. The purge compares local
    // groups against a server snapshot, so a group born DURING the fetch is absent from the snapshot
    // by construction - and the sweep used to read the local set afterwards, which is the only way
    // the two can disagree about a group that is seconds old. The creator held the sole copy of the
    // tree, so forgetting it left every member counted by the server and unable to ever join.
    let theFetchHasStarted = false;
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockImplementation(async () => {
        theFetchHasStarted = true;
        return [];
      }),
      // Empty when the server is asked, holding the new group by the time the loop would run.
      getLocalGroups: vi.fn(() => (theFetchHasStarted ? ['born-during-the-fetch'] : [])),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations: new Map<string, Conversation>(),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    expect(mlsService.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });
});

/**
 * DEL-10's second half. The deletion that never reached the server left the group standing there,
 * and the very next discovery saw a server group with no local row - which is exactly what phase 1
 * is built to repair - and re-created it as a placeholder. The user's deletion was undone by the
 * reconciler meant to serve it.
 *
 * On the wire the two cases are identical: a server group this client does not hold. The owed-exit
 * row is the only thing that tells them apart, which is why the guard reads it rather than guessing.
 */
describe('discoverMissingGroups - a group with an exit still owed', () => {
  const OWED = 'a0000000-0000-4000-8000-00000000000a';
  const FRESH = 'b0000000-0000-4000-8000-00000000000b';

  function serverGroups() {
    return [
      { groupId: OWED, name: 'Groupe supprime', isGroup: true },
      { groupId: FRESH, name: 'Groupe legitime', isGroup: true },
    ];
  }

  function storageOwing(ids: string[]) {
    return {
      getPendingGroupExits: vi.fn(async () =>
        ids.map((groupId) => ({ groupId, kind: 'delete' as const, requestedAt: 1 }))
      ),
    } as never;
  }

  it('is not re-created as a placeholder, and the reason is logged', async () => {
    const conversations = new Map<string, Conversation>();
    const log = vi.fn();
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue(serverGroups()),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      log,
      storage: storageOwing([OWED]),
    });

    expect(conversations.has(OWED)).toBe(false);
    // The other group proves the guard is a filter and not an outage: discovery still does its job.
    expect(conversations.has(FRESH)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('owes the server an exit'));
  });

  it('re-creates it again once nothing is owed - the guard is the row, not the group', async () => {
    const conversations = new Map<string, Conversation>();
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue(serverGroups()),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      log: vi.fn(),
      storage: storageOwing([]),
    });

    expect(conversations.has(OWED)).toBe(true);
  });

  // An unreadable table must not hide real groups from a user who never asked to leave them: the
  // cost of guessing empty is one placeholder the drain deletes a moment later.
  it('re-creates placeholders when the owed rows cannot be read at all', async () => {
    const conversations = new Map<string, Conversation>();
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue(serverGroups()),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      deviceKeyB64: '1234',
      conversations,
      log: vi.fn(),
      storage: {
        getPendingGroupExits: vi.fn(async () => {
          throw new Error('store closed');
        }),
      } as never,
    });

    expect(conversations.has(OWED)).toBe(true);
    expect(conversations.has(FRESH)).toBe(true);
  });
});
