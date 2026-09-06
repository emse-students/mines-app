import { mergeDirectConversationDuplicates } from './conversations';
import type { ConversationMeta } from '$lib/db/types';
import type { IStorage } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';

const ME = 'aaaa0000-0000-0000-0000-000000000000';
const PEER = 'bbbb0000-0000-0000-0000-000000000000';
const PRED_ID = 'pred0000-0000-0000-0000-000000000000';
const SUCC_ID = 'succ0000-0000-0000-0000-000000000000';
const IND_A = 'inda0000-0000-0000-0000-000000000000';
const IND_B = 'indb0000-0000-0000-0000-000000000000';
const NAME = `${ME}::${PEER}`;

function makeMeta(id: string, updatedAt = 1000): ConversationMeta {
  return { id, name: NAME, lifecycle: 'active', updatedAt };
}

function makeStorage(): IStorage {
  return {
    init: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue([]),
    getConversation: vi.fn().mockResolvedValue(null),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    deleteMessagesForConversation: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesPage: vi.fn().mockResolvedValue([]),
    deleteOldMessages: vi.fn().mockResolvedValue(0),
  } as unknown as IStorage;
}

function makeMlsService(getGroupMetaImpl: (id: string) => unknown): IMlsService {
  return {
    getGroupMeta: vi.fn().mockImplementation((id: string) => Promise.resolve(getGroupMetaImpl(id))),
    deleteGroupOnServer: vi.fn().mockResolvedValue(undefined),
  } as unknown as IMlsService;
}

describe('mergeDirectConversationDuplicates', () => {
  it('traite deux groupes du meme pair comme doublons independants (successeurs retires) - garde le plus recent', async () => {
    // Successors are retired: even a former predecessor/successor pair is now merged as two
    // independent duplicates, keeping the most recent and removing the older one everywhere.
    const storage = makeStorage();
    const mls = makeMlsService(() => null);

    const result = await mergeDirectConversationDuplicates(
      [makeMeta(PRED_ID, 900), makeMeta(SUCC_ID, 1000)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    // The most recent (SUCC) is kept, the older (PRED) is removed locally and on the server.
    expect(result.map((c) => c.id)).toContain(SUCC_ID);
    expect(result.map((c) => c.id)).not.toContain(PRED_ID);
    expect(storage.deleteConversation).toHaveBeenCalledWith(PRED_ID);
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(PRED_ID);
  });

  it('actually calls deleteGroupOnServer for a true duplicate with no succession relationship', async () => {
    // Two independent groups for the same peer (two devices opened the conv at the same time).
    const storage = makeStorage();
    const mls = makeMlsService(() => null); // aucune relation successeur

    const older = makeMeta(IND_A, 500);
    const newer = makeMeta(IND_B, 1000);

    const result = await mergeDirectConversationDuplicates(
      [older, newer],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    // The most recent is kept
    expect(result.map((c) => c.id)).toContain(IND_B);
    expect(result.map((c) => c.id)).not.toContain(IND_A);
    expect(storage.deleteConversation).toHaveBeenCalledWith(IND_A);
    // deleteGroupOnServer MUST be called to prevent resurrection via discoverMissingGroups
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((mls.deleteGroupOnServer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(IND_A);
  });
});

/**
 * A TOMBSTONE IS NOT A CANDIDATE, and this file is where the worse of its two consequences lives.
 *
 * Reported by the user 2026-08-23: a 1v1 pending local deletion blocked the arrival of the NEW
 * conversation with that same peer. Discovery merely declined to create a row - annoying. HERE the
 * same oversight DESTROYS: the merge picks the most RECENT of a peer's records as canonical and
 * deletes every other one locally AND on the server, so a tombstone that happens to be newer takes
 * the fresh conversation's messages and deletes the fresh group for BOTH parties.
 *
 * Both orderings are pinned, because `updatedAt` is what decided the outcome and either device may
 * hold either order.
 */
describe('mergeDirectConversationDuplicates - a record pending deletion', () => {
  const TOMB_ID = 'tomb0000-0000-0000-0000-000000000000';
  const FRESH_ID = 'fres0000-0000-0000-0000-000000000000';
  const tomb = (updatedAt: number): ConversationMeta => ({
    id: TOMB_ID,
    name: NAME,
    lifecycle: 'removed',
    updatedAt,
  });

  it('does not take a fresh conversation with the same peer, even when it is the newer record', async () => {
    const storage = makeStorage();
    const mls = makeMlsService(() => null);

    const result = await mergeDirectConversationDuplicates(
      [tomb(2000), makeMeta(FRESH_ID, 1000)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    // BOTH SURVIVE. The tombstone stays until a MANUAL deletion (rules 2 and 4) and the new
    // conversation is untouched - nothing is merged, nothing is deleted, and above all the group
    // is not deleted on the server, which would take it from the peer as well.
    expect(result.map((c) => c.id).sort()).toEqual([FRESH_ID, TOMB_ID].sort());
    expect(storage.deleteConversation).not.toHaveBeenCalled();
    expect(mls.deleteGroupOnServer).not.toHaveBeenCalled();
  });

  it('is not absorbed INTO the fresh one either, when it is the older record', async () => {
    // The mirror case, and it is not symmetric: here the tombstone would be the one deleted, which
    // looks harmless and is not - a record kept deliberately until the user removes it would vanish
    // on a login, and its messages would surface inside a conversation the user thinks is new.
    const storage = makeStorage();
    const mls = makeMlsService(() => null);

    const result = await mergeDirectConversationDuplicates(
      [tomb(500), makeMeta(FRESH_ID, 1000)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    expect(result.map((c) => c.id).sort()).toEqual([FRESH_ID, TOMB_ID].sort());
    expect(storage.deleteConversation).not.toHaveBeenCalled();
    expect(mls.deleteGroupOnServer).not.toHaveBeenCalled();
  });

  it('still merges two LIVE duplicates, so the guard is the lifecycle and not the peer', async () => {
    // The anti-vacuity case: a guard that switched the merge off entirely would pass both cases
    // above and break the thing this function exists for.
    const storage = makeStorage();
    const mls = makeMlsService(() => null);

    const result = await mergeDirectConversationDuplicates(
      [makeMeta(IND_A, 900), makeMeta(IND_B, 1000)],
      ME,
      'pin',
      storage,
      () => {},
      mls
    );

    expect(result.map((c) => c.id)).toEqual([IND_B]);
    expect(storage.deleteConversation).toHaveBeenCalledWith(IND_A);
  });
});
