import { handleSystemEvent } from './systemMessageHandler';
import {
  digestIdentity,
  noteDigestSolicited,
  resetHistoryDigestRendezvousForTests,
} from '$lib/utils/chat/historyDigestRendezvous';

/**
 * A DIGEST THAT ARRIVES AFTER THE RESPONDER STOPPED WAITING FOR IT.
 *
 * `handleHistoryRequest` asks the elected peer to describe its store and waits `DIGEST_TTL_MS`
 * (60 s) for the answer. The peer answers only once its own inbound queue has drained - deliberately,
 * since a digest computed mid-drain describes a store still being completed - and a device that has
 * just rejoined an account is applying every group's external join at once.
 *
 * MEASURED 2026-09-05, HEAL-REVOKE-5 and HEAL-REVOKE-7: 67 s to drain against a 60 s wait, the
 * digest landing seven seconds after the wait ended, the frame recorded by a rendezvous nobody was
 * listening to any more, and three messages missing from that conversation for ever. Nothing retried:
 * the other trigger fired six seconds after the join and was swallowed by the coalescing window.
 *
 * So the late digest is answered where it lands. It needs no continuation because it needs no
 * memory - the digest carries the manifest and the window, the store carries the rest - and it stays
 * addressed to ONE responder because only the device that asked holds an outstanding solicitation.
 */

const { answerHistoryDigest } = vi.hoisted(() => ({
  answerHistoryDigest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/utils/chat/historyDiffAnswer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/historyDiffAnswer')>()),
  answerHistoryDigest,
}));

const ME = 'me';
const MY_DEVICE = 'device-me';
const PEER_USER = 'peer';
const PEER_DEVICE = 'device-peer';
const PEER = digestIdentity(PEER_USER, PEER_DEVICE);
const GROUP = 'g1';

function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set(GROUP, { id: GROUP, unreadCount: 0, messages: [] });
  return {
    mlsService: {
      getDeviceId: () => MY_DEVICE,
      // The wrapper the late answer runs behind. Resolved, so the answer runs in this test's tick.
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    },
    storage: null,
    userId: ME,
    deviceKeyB64: 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get(GROUP),
    convoKey: GROUP,
    senderNorm: PEER_USER,
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

/** The wire shape of a digest naming one message. */
const DIGEST_FRAME = {
  from: PEER,
  digest: { mode: 'ids', ids: ['m1'] },
  since: 0,
};

/** Lets the `void`-ed answer chain behind `answerAfterMailboxDrained` run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetHistoryDigestRendezvousForTests();
  answerHistoryDigest.mockClear();
});

describe('a digest that arrives after the wait ended', () => {
  it('is ANSWERED when we are the device that asked for it', async () => {
    noteDigestSolicited(GROUP, PEER);

    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    expect(answerHistoryDigest).toHaveBeenCalledTimes(1);
    const call = answerHistoryDigest.mock.calls[0][0];
    expect(call.groupId).toBe(GROUP);
    expect(call.requesterIdentity).toBe(PEER);
    expect(call.selfIdentity).toBe(digestIdentity(ME, MY_DEVICE));
    // THE ASKER'S WINDOW, carried verbatim. Recomputing it here would answer a question the peer
    // did not ask - two devices deriving a sliding window disagree by whatever moved in between.
    expect(call.since).toBe(0);
  });

  it('is IGNORED when we never asked - every member sees this broadcast', async () => {
    // The election picks ONE responder. Answering an unsolicited digest would put every member of
    // the group on the same frame, which is the fan-out the election exists to prevent.
    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    expect(answerHistoryDigest).not.toHaveBeenCalled();
  });

  it('is answered ONCE - a solicitation is consumed, not read', async () => {
    noteDigestSolicited(GROUP, PEER);

    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    expect(answerHistoryDigest).toHaveBeenCalledTimes(1);
  });

  it('does not answer a digest for a DIFFERENT group', async () => {
    noteDigestSolicited('another-group', PEER);

    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    expect(answerHistoryDigest).not.toHaveBeenCalled();
  });

  it('does not answer a digest from a DIFFERENT device of the same user', async () => {
    // The solicitation names a device, because a user with three of them must be able to describe
    // its store from one without the other two answering for it.
    noteDigestSolicited(GROUP, digestIdentity(PEER_USER, 'some-other-device'));

    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    expect(answerHistoryDigest).not.toHaveBeenCalled();
  });

  it('still records the digest for a live waiter, and does not answer it twice', async () => {
    // The ordinary case: `handleHistoryRequest` is still waiting, the rendezvous hands the probe
    // straight to it, and this branch must stay out of the way - two diffs for one ask would send
    // the same bundle twice.
    const { noteProbeReceived, awaitProbe } =
      await import('$lib/utils/chat/historyDigestRendezvous');
    expect(noteProbeReceived).toBeTypeOf('function');
    noteDigestSolicited(GROUP, PEER);
    const waiting = awaitProbe(GROUP, PEER, 5_000, 0);

    await handleSystemEvent('history_digest', DIGEST_FRAME, makeCtx() as any);
    await settle();

    await expect(waiting).resolves.toMatchObject({ kind: 'digest' });
    expect(answerHistoryDigest).not.toHaveBeenCalled();
  });
});
