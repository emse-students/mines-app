/**
 * The mark that stops a device reporting its own traffic as lost.
 *
 * A frame delivered live, or drained from the server queue, is decrypted OUTSIDE the archive replay
 * and so leaves this device's position in the archive behind it. The replay later walks that same
 * row, finds the generation already spent, and reports real loss for a message the device is
 * displaying. These cases pin the two halves that make the repair work: the two paths agree on a
 * key, and a mark made during a replay is not erased by that replay's final write.
 */
// Mocked so a case can ASSERT on whether a repair was asked for. Without it the replay's loss path
// reaches the real one, which is a network call these cases have no business making.
vi.mock('$lib/utils/chat/historyReconcile', () => ({
  escalateReconciliation: vi.fn().mockResolvedValue(true),
}));

import { escalateReconciliation } from '$lib/utils/chat/historyReconcile';
import { frameFingerprint } from '$lib/mls-client/inboundFrameLedger';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  hasHistoryFrameBeenConsumed,
  markHistoryFrameConsumed,
  replayConversationHistory,
  resetSeenCipherCacheForTests,
} from './history';

const USER = 'user-1';
const GROUP = 'group-1';
const KEY = `history_seen_cipher:${USER}:${GROUP}`;

/** Reads the persisted set the way a later page load would. */
const persisted = (): string[] => JSON.parse(localStorage.getItem(KEY) ?? '[]');

/** Lets the coalesced flush run. A microtask drain, never a wall clock. */
const flush = () => Promise.resolve().then(() => undefined);

beforeEach(() => {
  localStorage.clear();
  resetSeenCipherCacheForTests();
  // Call counts are per-case evidence: without this, a case asserting "no repair was asked for"
  // reads the reconciliations of every case before it and fails for someone else's reason.
  vi.clearAllMocks();
});

describe('the key the two delivery paths share', () => {
  it('is identical whether the frame came off the archive or off the wire', () => {
    // The server writes ONE string: the same `proto` goes into the Redis stream and into the live
    // envelope, with no re-encoding between them. So the archive's base64 `content`, decoded, is
    // byte-for-byte the live frame's ciphertext - which is why a fingerprint over the bytes is a
    // usable shared key while the two ids (stream id vs queued-message uuid) never intersect.
    const wire = new Uint8Array([0x20, 0x0b, 0xad, 0xf0, 0x0d, 0x00, 0xff, 0x7f]);
    const fromArchive = fromBase64(toBase64(wire));

    expect(frameFingerprint(fromArchive)).toBe(frameFingerprint(wire));
  });

  it('separates frames that differ by a single byte', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);

    expect(frameFingerprint(a)).not.toBe(frameFingerprint(b));
  });
});

describe('markHistoryFrameConsumed', () => {
  it('persists the mark under the group key, so a reload skips the row instead of failing on it', async () => {
    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();

    expect(persisted()).toEqual(['fp-a']);
  });

  it('keeps what was already there rather than replacing it', async () => {
    localStorage.setItem(KEY, JSON.stringify(['older-stream-id']));

    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();

    expect(persisted()).toEqual(['older-stream-id', 'fp-a']);
  });

  it('collapses a whole drain into ONE write', async () => {
    // A reconnect hands over a burst of frames in one turn. Each mark rewriting a set capped at
    // five thousand entries would put a `JSON.stringify` of the lot on the hot inbound path.
    // On the INSTANCE, not on `Storage.prototype`: under jsdom the prototype spy never fires, which
    // would have made every count below trivially zero - and the "does not write twice" case would
    // have passed while measuring nothing at all.
    const setItem = vi.spyOn(localStorage, 'setItem');

    for (let i = 0; i < 40; i++) markHistoryFrameConsumed(USER, GROUP, `fp-${i}`);
    await flush();

    expect(setItem.mock.calls.filter(([k]) => k === KEY)).toHaveLength(1);
    expect(persisted()).toHaveLength(40);
    setItem.mockRestore();
  });

  it('does not write twice for the same frame', async () => {
    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();
    // Installed AFTER the first mark is persisted, so what it counts is the second mark alone.
    const setItem = vi.spyOn(localStorage, 'setItem');

    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    await flush();

    expect(setItem.mock.calls.filter(([k]) => k === KEY)).toHaveLength(0);
    setItem.mockRestore();
  });

  it('is a no-op without an identified user or group, rather than writing a nameless key', async () => {
    markHistoryFrameConsumed('', GROUP, 'fp-a');
    markHistoryFrameConsumed(USER, '', 'fp-a');
    await flush();

    expect(localStorage.length).toBe(0);
  });

  it('keeps each group to its own set', async () => {
    markHistoryFrameConsumed(USER, GROUP, 'fp-a');
    markHistoryFrameConsumed(USER, 'group-2', 'fp-b');
    await flush();

    expect(persisted()).toEqual(['fp-a']);
    expect(JSON.parse(localStorage.getItem(`history_seen_cipher:${USER}:group-2`) ?? '[]')).toEqual(
      ['fp-b']
    );
  });
});

/**
 * THE LEDGER IN THE OTHER DIRECTION - the replay telling live delivery what IT has consumed.
 *
 * WP-FALSELOSS-1 made live delivery visible to the replay and stopped there, so the seam stayed
 * one-way: a frame the replay had just decrypted arrived live a moment later, `handleUnreadableFrame`
 * had nowhere to look it up, and a message already on screen was reported LOST and reconciled for.
 * Measured on prod 2026-08-13 (WP-FALSELOSS-2) - three MSG checks dirty, with `copiesOnReceiver: 1`
 * recorded inside the very run reporting the loss, which is what proved nothing had been lost.
 *
 * The row id the replay writes cannot serve: a live envelope is addressed by a `queued_message`
 * uuid and an archive row by a Redis stream id, and the server discards the stream id at write time.
 * Only the bytes are shared.
 */
describe('a frame the archive replay consumed', () => {
  const wire = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const row = {
    id: '1786655250946-0',
    sender_id: 'peer',
    content: toBase64(wire),
    timestamp: String(1786655250946),
  };

  /**
   * Drives one replay page and returns the commit thunk. One result per row, in order.
   *
   * `log` is a parameter rather than a constant because the replay's END-OF-PAGE findings are
   * addressed to it, not to the console: the summary naming how many frames can never be read is
   * the one line some cases exist to read.
   */
  const replayPage = async (
    rows: Array<{ id: string; sender_id: string; content: string; timestamp: string }>,
    results: Array<{ ok: boolean; plaintext?: null; error?: string }>,
    log: (line: string) => void = () => undefined
  ) => {
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      createDecryptSession: vi.fn().mockResolvedValue({
        decryptPage: vi.fn().mockResolvedValue(results),
        finish: vi.fn().mockResolvedValue(undefined),
      }),
      // The page after the primed one is empty, which is what ends the walk.
      fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
    });
    return replayConversationHistory({
      mlsService,
      id: GROUP,
      contactName: 'peer',
      userId: USER,
      deviceKeyB64: 'device-key',
      storage: null,
      getConversation: () => undefined,
      setConversation: () => undefined,
      messageReactions: new Map(),
      log,
      primedFirstPage: { rows },
    });
  };

  /** The single-frame case, which is what most of these assertions need. */
  const replayOnePage = (result: { ok: boolean; plaintext?: null; error?: string }) =>
    replayPage([row], [result]);

  it('is recognised by live delivery, so the same frame arriving on the wire is a duplicate and not a loss', async () => {
    // `plaintext: null` is a frame with no application payload - a commit. It consumes its ratchet
    // generation exactly like a message does, which is the whole reason the mark is taken before
    // anything looks at the payload.
    await replayOnePage({ ok: true, plaintext: null });

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(true);
  });

  it('survives the reload, because the durable set is what live delivery reads', async () => {
    const commit = await replayOnePage({ ok: true, plaintext: null });
    // The replay does not persist its own progress: the caller commits it once the encrypted MLS
    // checkpoint has flushed, so durable progress can never run ahead of the durable ratchet.
    commit?.();
    await flush();

    expect(persisted()).toContain(frameFingerprint(wire));
  });

  it('is NOT claimed when the frame failed to decrypt - nobody has read it, and saying otherwise silences a real loss', async () => {
    // The safety property of the whole change. A frame that did not decrypt consumed nothing, so
    // marking its bytes would tell live delivery "already read" about a frame no one has ever read -
    // and the LOST-frame signal, which is the only thing that raises a repair, would go quiet on the
    // one case it exists for. The row is still marked seen, so the replay does not walk it forever.
    await replayOnePage({
      ok: false,
      error: 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))',
    });

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(false);
    expect(hasHistoryFrameBeenConsumed(USER, GROUP, row.id)).toBe(true);
  });

  /**
   * THE WHOLE PAGE IS MARKED WHEN THE PAGE IS DECRYPTED, NOT AS EACH FRAME IS PROCESSED.
   *
   * `decryptPage` spends the ratchet for every row it is given, in one call. The marks used to be
   * written by the loop that processes those rows afterwards - decoding, adding to the chat,
   * awaiting - so between the two there was a window in which a generation was gone and the ledger
   * did not say so. A frame arriving live inside that window looked itself up, found nothing, and was
   * reported LOST: measured on prod 2026-08-14 as an exactly reproducible pair, generation 520 called
   * a loss and generation 521 of the SAME page recognised as a duplicate three seconds later.
   */
  describe('a page of several frames', () => {
    const second = new Uint8Array([0x99, 0x88, 0x77]);
    const secondRow = {
      id: '1786655250946-1',
      sender_id: 'peer',
      content: toBase64(second),
      timestamp: String(1786655250947),
    };

    it('marks every frame the batch decrypted, not only the ones already processed', async () => {
      await replayPage(
        [row, secondRow],
        [
          { ok: true, plaintext: null },
          { ok: true, plaintext: null },
        ]
      );

      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(true);
      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(second))).toBe(true);
    });

    it('still claims only what decrypted, when one frame of the page failed', async () => {
      await replayPage(
        [row, secondRow],
        [
          { ok: true, plaintext: null },
          {
            ok: false,
            error: 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))',
          },
        ]
      );

      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(wire))).toBe(true);
      expect(hasHistoryFrameBeenConsumed(USER, GROUP, frameFingerprint(second))).toBe(false);
    });
  });

  /**
   * THE LEDGER IS CONSULTED WHERE THE VERDICT IS FORMED, NOT WHERE THE WORK WAS QUEUED.
   *
   * The mirror of the defect just above, and the half that survived it. The page is assembled by
   * checking each row against `seenCipherHashes`, and only THEN handed to `decryptPage`. Live
   * delivery can read one of those frames in between - seconds, on a real page - so a frame that
   * failed the batch may well have been read by the time the failure is being judged. The code used
   * to reason from the earlier answer ("a frame already read is skipped before ever reaching the
   * decrypt, so anything arriving here has never been read") and declared a loss on a message the
   * device was displaying.
   */
  it('is not a loss when live delivery read the frame while the page was decrypting', async () => {
    // Exactly what live delivery writes, arriving AFTER the page was assembled and BEFORE the
    // failure is judged - the window this covers.
    markHistoryFrameConsumed(USER, GROUP, frameFingerprint(wire));

    await replayOnePage({
      ok: false,
      error: 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))',
    });

    // No reconciliation was asked for: nothing was lost, so nothing needs repairing.
    expect(vi.mocked(escalateReconciliation)).not.toHaveBeenCalled();
    // And the row is still consumed, or the replay walks it again on every load.
    expect(hasHistoryFrameBeenConsumed(USER, GROUP, row.id)).toBe(true);
  });

  /**
   * AND WHEN IT IS A LOSS, THE ASK WAITS FOR THE SESSION TO CLOSE.
   *
   * `escalateReconciliation` opens on the mailbox barrier, and the barrier needs the global MLS mutex that
   * this replay's catch-up holds until `finish` resolves. Raised from inside the walk it is therefore
   * refused outright - the barrier says so and skips - and the ask goes out against a mailbox that
   * was never emptied, which is the one ordering guarantee it carries. `void` does not help: the
   * microtask runs at once, a whole replay before `finish`.
   *
   * It shipped that way under a comment claiming the store was settled by then, and cost one dirty
   * line on prod (W1, MSG pass 1 of 5, 2026-08-15 - the only pass that followed a boot). The
   * assertion is an ORDERING against a gated `finish`, because asserting that the ask happened at
   * all would have passed just as well before the fix.
   */
  it('does not ask a peer until the catch-up session it holds has been closed', async () => {
    let closeSession!: () => void;
    const finished = new Promise<void>((resolve) => {
      closeSession = resolve;
    });
    const finish = vi.fn().mockReturnValue(finished);
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      createDecryptSession: vi.fn().mockResolvedValue({
        decryptPage: vi.fn().mockResolvedValue([
          {
            ok: false,
            error: 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))',
          },
        ]),
        finish,
      }),
      fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
    });
    const replay = replayConversationHistory({
      mlsService,
      id: GROUP,
      contactName: 'peer',
      userId: USER,
      deviceKeyB64: 'device-key',
      storage: null,
      getConversation: () => undefined,
      setConversation: () => undefined,
      messageReactions: new Map(),
      log: () => undefined,
      primedFirstPage: { rows: [row] },
    });

    // WAIT UNTIL THE REPLAY IS ACTUALLY BLOCKED ON `finish`, and assert only then. A fixed number of
    // microtask turns would not discriminate: it can expire before the walk has even reached the
    // failure, and the case would then pass against the very code it is here to refuse.
    for (let turn = 0; turn < 200 && !finish.mock.calls.length; turn++) await flush();
    expect(finish).toHaveBeenCalled();
    expect(vi.mocked(escalateReconciliation)).not.toHaveBeenCalled();

    closeSession();
    await replay;

    expect(vi.mocked(escalateReconciliation)).toHaveBeenCalledWith(
      mlsService,
      GROUP,
      expect.any(Function)
    );
  });

  /**
   * HOW THE REPLAY REPORTS FRAMES IT CAN NEVER READ - a number for the arithmetic, a line for a loss.
   *
   * Three decrypt kinds end in "unreadable for good" and they are not the same event.
   * `past-epoch-application` is every frame sent before this device joined: joining at epoch N means
   * epoch N-1 is gone, and a fresh device meets that once per historical frame of every group at
   * once. `secret-reuse` and `same-epoch-refusal` are a frame this device should have been able to
   * read and cannot.
   *
   * PRINTED ALIKE, THE ARITHMETIC BURIES THE LOSS. Measured on 2026-08-28 during HEAL-NEW-3: 8259
   * of these lines out of 8976 console lines, every one of them the expected kind, and a
   * `GET /api/users/me/blocks -> 500` - the visible end of a P1 - sitting three lines inside them.
   * These cases pin the split, because it is the kind of thing a later change reverts by accident:
   * one summary carrying the COUNT, and the accusing line kept for the kinds that accuse.
   */
  describe('frames it can never read', () => {
    const pastEpoch = 'ValidationError(UnableToDecrypt(past epoch application frame))';
    const secretReuse = 'ValidationError(UnableToDecrypt(SecretTreeError(SecretReuseError)))';

    /** One row per byte given, so a case can ask for a page of any size. */
    const rowsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `1786655250946-${i}`,
        sender_id: 'peer',
        content: toBase64(new Uint8Array([0xa0, i, 0x33])),
        timestamp: String(1786655250946 + i),
      }));

    it('says how many there were in ONE line, instead of one line per frame', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const log = vi.fn();

      await replayPage(rowsOf(3), Array(3).fill({ ok: false, error: pastEpoch }), log);

      const summaries = log.mock.calls
        .map(([l]) => String(l))
        .filter((l) => l.includes('[HISTORY]'));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('holds 3 frame(s) it can never read');
      // The claim that makes the summary worth having: nothing was printed per frame.
      expect(warn.mock.calls.filter(([l]) => String(l).includes('never read here'))).toHaveLength(
        0
      );
      warn.mockRestore();
    });

    it('still names a few, because the fingerprint is what lines a loss up with the live path', async () => {
      const log = vi.fn();

      await replayPage(rowsOf(7), Array(7).fill({ ok: false, error: pastEpoch }), log);

      const summary = String(
        log.mock.calls.map(([l]) => String(l)).find((l) => l.includes('[HISTORY]'))
      );
      expect(summary).toContain('holds 7 frame(s)');
      // Bounded at five and SAID to be bounded, so a reader never reads the sample as the whole set.
      const sample = String(summary.match(/\(e\.g\. (.*)\)$/)?.[1]).split(', ');
      expect(sample.filter((f) => f !== '…')).toHaveLength(5);
      expect(summary).toContain(', …');
    });

    it('keeps the accusing line for a kind that is a real loss, not arithmetic', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await replayPage(rowsOf(1), [{ ok: false, error: secretReuse }]);

      // The whole point of the split: this one is still shouted, per frame, in the app's own words.
      const accusations = warn.mock.calls
        .map(([l]) => String(l))
        .filter((l) => l.includes('never read here and unreadable for good'));
      expect(accusations).toHaveLength(1);
      expect(accusations[0]).toContain('secret-reuse');
      warn.mockRestore();
    });

    it('counts the real loss into the same total, because the summary claims to hold it too', async () => {
      const log = vi.fn();

      await replayPage(
        rowsOf(3),
        [
          { ok: false, error: pastEpoch },
          { ok: false, error: secretReuse },
          { ok: false, error: pastEpoch },
        ],
        log
      );

      const summary = String(
        log.mock.calls.map(([l]) => String(l)).find((l) => l.includes('[HISTORY]'))
      );
      expect(summary).toContain('holds 3 frame(s) it can never read');
    });
  });
});

/**
 * THE HEAD IS PINNED, THEN THE MAILBOX IS EMPTIED, THEN THE ROWS ARE READ.
 *
 * The archive holds every frame, INCLUDING the ones still queued for live delivery, so the walk and
 * the queue only stay disjoint if BOTH ends are closed: nothing above the head is walked (a frame
 * sent after the pin belongs to the queue alone), and nothing below it is still in the mailbox when
 * a row is processed (a frame sent before the pin is delivered first, and skipped by fingerprint).
 *
 * The barrier used to run BEFORE the first fetch, and this file used to assert exactly that - which
 * is what left the frames sent between "mailbox empty" and "head pinned" in both sets. Every
 * `Duplicate delivery ... already read by the archive replay` line in every capture came through
 * that window, and not one line ever named live delivery: the reconciling arm had never fired at
 * all (WP-DUPDELIVERY-1).
 *
 * The assertion is an ORDERING, which is why the gate stays shut: asserting that the barrier was
 * called proves only that it was called, not that anything waited for it.
 */
describe('the mailbox barrier', () => {
  const row = {
    id: '1-0',
    sender_id: 'peer',
    content: toBase64(new Uint8Array([0xd0, 0xd1, 0xd2])),
    timestamp: String(1786655250946),
  };

  /** A replay held open at the barrier, with the calls it made before and after in reach. */
  const gatedReplay = () => {
    let openGate!: () => void;
    const drained = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const fetchHistory = vi.fn().mockResolvedValue({ rows: [] });
    const decryptPage = vi.fn().mockResolvedValue([{ ok: true, plaintext: null }]);
    const createDecryptSession = vi
      .fn()
      .mockResolvedValue({ decryptPage, finish: vi.fn().mockResolvedValue(undefined) });
    const waitForMessageQueueIdle = vi.fn().mockReturnValue(drained);
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      fetchHistory,
      createDecryptSession,
      waitForMessageQueueIdle,
    });
    const replay = replayConversationHistory({
      mlsService,
      id: GROUP,
      contactName: 'peer',
      userId: USER,
      deviceKeyB64: 'device-key',
      storage: null,
      getConversation: () => undefined,
      setConversation: () => undefined,
      messageReactions: new Map(),
      log: () => undefined,
      primedFirstPage: { rows: [row], head: '9-0' },
    });
    return {
      replay,
      openGate,
      fetchHistory,
      decryptPage,
      createDecryptSession,
      waitForMessageQueueIdle,
    };
  };

  it('hands MLS nothing until the mailbox is empty', async () => {
    const { replay, openGate, decryptPage } = gatedReplay();

    // Several turns, so a barrier placed one await too late would still be caught.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(decryptPage).not.toHaveBeenCalled();

    openGate();
    await replay;

    expect(decryptPage).toHaveBeenCalled();
  });

  /**
   * IT IS INSIDE NO SESSION WHEN IT WAITS, AND IT MUST SAY SO.
   *
   * `waitForMessageQueueIdle(caller, catchUpGroupId)` asks which group's catch-up session the
   * caller is INSIDE, and the barrier refuses that one - the drain needs the mutex such a session
   * holds for its whole life. This call site passed `id`, the group whose session it opens on the
   * very NEXT statement, so it named a nesting that cannot exist and instead matched any CONCURRENT
   * replay of the same group. Those were reported as unresolvable deadlocks and the barrier was
   * SKIPPED - which is exactly the `Duplicate delivery ... already read by the archive replay`
   * window the ordering above exists to close, reopened by the guard meant to protect it.
   *
   * Found by GRP-7 on 2026-08-23, on the sibling call site in `historyReconcile.ts`.
   */
  it('tells the barrier it is inside no session - the session opens on the next statement', async () => {
    const { replay, openGate, waitForMessageQueueIdle, createDecryptSession } = gatedReplay();
    openGate();
    await replay;

    expect(waitForMessageQueueIdle).toHaveBeenCalledWith('archive replay', null);
    // The claim above is only true because of this ordering, so it is asserted beside it rather
    // than left to the prose: the session this replay owns does not exist yet when it waits.
    expect(waitForMessageQueueIdle.mock.invocationCallOrder[0]).toBeLessThan(
      createDecryptSession.mock.invocationCallOrder[0]
    );
  });

  it('has already pinned its upper bound when it waits, so the wait cannot widen the walk', async () => {
    // The half the old ordering got wrong. Whatever is sent while the mailbox drains is above this
    // bound and belongs to the queue alone - which is only true if the bound was taken first.
    const { replay, openGate, fetchHistory } = gatedReplay();

    openGate();
    await replay;

    expect(fetchHistory).toHaveBeenCalledWith(GROUP, '1-0', undefined, '9-0');
  });

  /**
   * THE BARRIER MAY NOT BE AWAITED FROM INSIDE THE SESSION - a deadlock, not a slow path.
   *
   * `createDecryptSession` acquires the global MLS mutex and a catch-up holds it for its whole life,
   * while the drain needs that same non-reentrant mutex for every message. Waiting for the mailbox
   * with the session already open therefore waits for a drain that can never start. Shipped that way
   * on 2026-08-15 and measured within one check: the receiver's bulk ingest opened, the frame landed
   * 389 ms later, its drain nested to depth 2, and neither finished - the client stayed wedged until
   * it was reloaded, and the message never appeared. The two tests above both passed throughout,
   * because a stub has no mutex; this one pins the ORDER, which is the part a stub can still answer.
   */
  it('has not opened the decrypt session while it waits, so the drain still has the mutex', async () => {
    const { replay, openGate, createDecryptSession } = gatedReplay();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(createDecryptSession).not.toHaveBeenCalled();

    openGate();
    await replay;

    expect(createDecryptSession).toHaveBeenCalled();
  });
});

/**
 * THE WALK STOPS AT THE HEAD IT SAW WHEN IT STARTED.
 *
 * The mailbox barrier above orders the archive and the delivery queue at the START of a replay. It
 * says nothing about what arrives DURING one, and the archive holds every frame including the
 * queued ones - so an unbounded walk reads rows live delivery is about to hand over, and the two
 * paths meet on the same ciphertext again. On a large conversation that window is the entire walk.
 *
 * With the bound, the split is structural: at or below the head belongs to the replay, above it
 * belongs to the queue. Nothing above is fetched, so it costs no bytes, no decrypt, and no ledger
 * entry - the shared ledger stops carrying ordinary traffic and goes back to covering the seam.
 */
describe('the walk is bounded by the head observed at its start', () => {
  /** One archive row; distinct bytes per id, so no case can answer another's question. */
  const rowAt = (id: string, marker: number) => ({
    id,
    sender_id: 'peer',
    content: toBase64(new Uint8Array([0xa0, marker, 0xa2, 0xa3])),
    timestamp: String(1786655250946),
  });

  /** Runs one replay off a primed first page and reports the fetches it made afterwards. */
  const walkFrom = async (primedFirstPage: { rows: ReturnType<typeof rowAt>[]; head?: string }) => {
    const fetchHistory = vi.fn().mockResolvedValue({ rows: [] });
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      fetchHistory,
      createDecryptSession: vi.fn().mockResolvedValue({
        decryptPage: vi
          .fn()
          .mockResolvedValue(primedFirstPage.rows.map(() => ({ ok: true, plaintext: null }))),
        finish: vi.fn().mockResolvedValue(undefined),
      }),
    });
    await replayConversationHistory({
      mlsService,
      id: GROUP,
      contactName: 'peer',
      userId: USER,
      deviceKeyB64: 'device-key',
      storage: null,
      getConversation: () => undefined,
      setConversation: () => undefined,
      messageReactions: new Map(),
      log: () => undefined,
      primedFirstPage,
    });
    return fetchHistory;
  };

  it('passes the head back as the upper bound of every later page', async () => {
    const fetchHistory = await walkFrom({ rows: [rowAt('3-0', 0x01)], head: '9-0' });

    // The bound travels with the request, so the rows above it are never read server-side either.
    expect(fetchHistory).toHaveBeenCalledWith(GROUP, '3-0', undefined, '9-0');
  });

  it('ends the walk on reaching the head, without spending a request to find an empty page', async () => {
    const fetchHistory = await walkFrom({ rows: [rowAt('9-0', 0x02)], head: '9-0' });

    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it('walks unbounded when the server sends no head, so an older deployment still replays', async () => {
    const fetchHistory = await walkFrom({ rows: [rowAt('3-0', 0x03)] });

    expect(fetchHistory).toHaveBeenCalledWith(GROUP, '3-0', undefined, undefined);
  });
});

/**
 * WHAT THE SERVER KNEW AT WRITE TIME IS NOT LEARNT BY FAILING.
 *
 * `history:{groupId}` is one stream per group and must hold this device's own frames, because every
 * other member reads it - so a replay walks them by construction and MLS refuses every one
 * (`CannotDecryptOwnMessage`). That was the design asking to be told, once per frame for ever, what
 * the request body already carried: measured at 5 certain-to-fail decrypts per MSG capture, in
 * every capture, and thousands per full replay of a 4 282-message DM.
 *
 * `sender_id` cannot do it and never could: the SAME account's other device wrote frames that are
 * both decryptable and wanted, which is the whole reason this needed a new field.
 */
describe("this device's own rows in the shared archive", () => {
  const ME = 'device-test'; // what `createMlsServiceStub` answers for `getDeviceId`
  const row = (id: string, marker: number, sender_device_id?: string) => ({
    id,
    sender_id: USER,
    sender_device_id,
    content: toBase64(new Uint8Array([0xc0, marker, 0xc2])),
    timestamp: String(1786655250946),
  });

  /** Replays one primed page and reports what was actually handed to MLS. */
  const replayWith = async (rows: ReturnType<typeof row>[]) => {
    const decryptPage = vi.fn().mockResolvedValue(rows.map(() => ({ ok: true, plaintext: null })));
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([GROUP]),
      fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
      createDecryptSession: vi
        .fn()
        .mockResolvedValue({ decryptPage, finish: vi.fn().mockResolvedValue(undefined) }),
    });
    await replayConversationHistory({
      mlsService,
      id: GROUP,
      contactName: 'peer',
      userId: USER,
      deviceKeyB64: 'device-key',
      storage: null,
      getConversation: () => undefined,
      setConversation: () => undefined,
      messageReactions: new Map(),
      log: () => undefined,
      primedFirstPage: { rows },
    });
    return decryptPage;
  };

  it('are never offered to MLS at all', async () => {
    const decryptPage = await replayWith([row('1-0', 0x01, ME)]);

    expect(decryptPage).not.toHaveBeenCalled();
  });

  it('do not stop the rows around them from being read', async () => {
    const decryptPage = await replayWith([
      row('1-0', 0x01, ME),
      row('2-0', 0x02, 'peer-device'),
      row('3-0', 0x03, ME),
    ]);

    expect(decryptPage).toHaveBeenCalledTimes(1);
    expect(decryptPage.mock.calls[0][0]).toHaveLength(1);
  });

  it('are marked seen, so a later replay answers from the cheap check and the cursor moves past', async () => {
    await replayWith([row('1-0', 0x01, ME)]);

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, '1-0')).toBe(true);
  });

  it('are still offered when the row predates the field, which is the shim and not the mechanism', async () => {
    // A row written before 2026-08-15 carries no `sender_device_id`, so it reaches MLS and is
    // recognised by its refusal - the `own-message` arm of the replay's catch. Removable one
    // retention window after the deploy; see `docs/wiki/legacy-compatibility.md`.
    const decryptPage = await replayWith([row('1-0', 0x01, undefined)]);

    expect(decryptPage).toHaveBeenCalledTimes(1);
  });

  it("are not confused with the same USER's other device, whose frames are wanted", async () => {
    // The discriminator has to be the device. A user-level check would have skipped exactly the
    // frames a second device of this account needs to read.
    const decryptPage = await replayWith([row('1-0', 0x01, 'my-other-device')]);

    expect(decryptPage).toHaveBeenCalledTimes(1);
  });
});

describe('hasHistoryFrameBeenConsumed', () => {
  it('answers no for a frame nothing has marked, so an unread frame still reconciles', () => {
    expect(hasHistoryFrameBeenConsumed(USER, GROUP, 'never-seen')).toBe(false);
  });

  it('reads what an earlier SESSION wrote - the in-memory ring cannot, and that is why it exists', () => {
    localStorage.setItem(KEY, JSON.stringify(['fp-from-a-previous-page-load']));

    expect(hasHistoryFrameBeenConsumed(USER, GROUP, 'fp-from-a-previous-page-load')).toBe(true);
  });

  it('is a no-op without an identified user or group rather than reading a nameless key', () => {
    expect(hasHistoryFrameBeenConsumed('', GROUP, 'fp-a')).toBe(false);
    expect(hasHistoryFrameBeenConsumed(USER, '', 'fp-a')).toBe(false);
  });
});

describe('a mark made while a replay is walking', () => {
  it('survives the replay writing its own copy back at the end', async () => {
    // THE REASON THE SET IS SHARED RATHER THAN RE-READ. The replay loads the set when it starts,
    // mutates it for the whole walk, and writes it back once at the end. If live delivery marked a
    // frame into a DIFFERENT object in between, that final write - made from a copy taken before
    // the mark existed - would erase it, and the false loss would return at the next reload.
    //
    // Simulated here from the outside: a first mark stands in for the replay's hydration, a second
    // for a live frame arriving mid-walk, and the assertion is that the durable set holds both.
    localStorage.setItem(KEY, JSON.stringify(['stream-id-1']));
    markHistoryFrameConsumed(USER, GROUP, 'stream-id-1'); // hydrates the shared set, adds nothing
    markHistoryFrameConsumed(USER, GROUP, 'fp-live');
    await flush();

    expect(persisted()).toEqual(['stream-id-1', 'fp-live']);
  });
});
