/**
 * ONE ROW, ONE DECRYPTION - the identity of a delivery, asserted at the seam both channels share.
 *
 * A frame is pushed live over the socket AND listed by the pull, and the acknowledgement that
 * removes it server-side cannot land before a pull already in flight. Measured on production during
 * COMM-4 on 2026-08-25: `qId=d4ecf0fe` drained from the socket and absorbed, then `[PENDING]
 * Fetched 1 pending messages` handed the identical row back, and the second decrypt reported
 * `SecretReuseError` on generation 0 of an epoch already read - the ratchet refusing to spend a
 * secret twice, which is correct, and a heal (`unreadable for good - acknowledged`) covering a race
 * this side could delete.
 *
 * WHAT MAKES THIS WORTH ITS OWN FILE IS THE OPPOSITE CASE. Deduplicating deliveries is three lines
 * and one of them can strand a message for ever: a row left DELIBERATELY unacknowledged - a frame
 * whose group is not known yet - must be re-deliverable, and a memory that remembered it would turn
 * the re-fetch that exists for exactly that into a silent no-op. So both directions are asserted
 * here, and so is the bound on the memory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import type { DeliveryChannel } from '$lib/mls-client/incomingDelivery';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

/** @see BaseMlsService.mailboxBarrier.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/** Installs test doubles over protected collaborators, which no widened interface can describe. */
const poke = (svc: BaseMlsService, patch: Record<string, unknown>): void => {
  Object.assign(svc, patch);
};

/** The class's own seams, reached the way the class reaches them. */
const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    messageScheduler: MlsPerGroupScheduler;
    enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void;
  };

/** A delivery the server persisted, so it carries the row id both channels quote. */
const row = (
  queuedMessageId: string,
  overrides: Partial<MlsQueuedMessage> = {}
): MlsQueuedMessage => ({
  senderId: 'alice',
  ciphertext: new Uint8Array([1]),
  groupId: 'group-a',
  isWelcome: false,
  isCommit: false,
  queuedMessageId,
  ...overrides,
});

describe('a delivery that arrives twice', () => {
  let svc: BaseMlsService;
  /** Every frame that reached the pipeline, by row id - the count IS the assertion. */
  let applied: string[];
  let ack: ReturnType<typeof vi.fn>;
  let note: ReturnType<typeof vi.spyOn>;
  let grumble: ReturnType<typeof vi.spyOn>;
  let complaint: ReturnType<typeof vi.spyOn>;

  /** A pipeline that accepts everything, or refuses the ids named - `false` is "not acknowledged". */
  const handlerThat = (refuse: string[] = []) =>
    vi.fn(
      async (
        _senderId: string,
        _content: Uint8Array,
        _groupId?: string,
        _isWelcome?: boolean,
        _tree?: Uint8Array,
        _isCommit?: boolean,
        meta?: { queuedMessageId?: string }
      ): Promise<boolean> => {
        const id = meta?.queuedMessageId ?? '(none)';
        applied.push(id);
        return !refuse.includes(id);
      }
    );

  /**
   * Enqueues and waits for the drain the enqueue started, so nothing here waits on a duration.
   *
   * The channel defaults to the PULL, which is the shape every repeat in this file is about and the
   * one the campaign actually measures. The live side is asserted separately, because it is the
   * only combination the seam is allowed to be loud about.
   */
  const deliver = async (
    msg: MlsQueuedMessage,
    channel: DeliveryChannel = 'pull'
  ): Promise<void> => {
    inner(svc).enqueueMessage(msg, channel);
    await inner(svc).messageScheduler.waitUntilIdle();
  };

  beforeEach(() => {
    svc = makeService();
    applied = [];
    ack = vi.fn().mockResolvedValue(undefined);
    note = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    grumble = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    complaint = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    poke(svc, {
      userId: 'user-a',
      messageCallback: handlerThat(),
      delivery: { ackMessages: ack, pullPendingMessagesJson: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    note.mockRestore();
    grumble.mockRestore();
    complaint.mockRestore();
  });

  /** Every `console.log` the drain emitted - the repeat reports itself on this channel. */
  const logged = (): string => (note.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

  /** Every `console.warn` - reserved for the one repeat shape no crossing explains. */
  const warned = (): string =>
    (grumble.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

  it('is decrypted once, and says so', async () => {
    await deliver(row('d4ecf0fe'));
    await deliver(row('d4ecf0fe'));

    expect(applied).toEqual(['d4ecf0fe']);
    // ON THE ACCUSING CHANNEL SINCE 2026-09-06. `pull:done` was routine while a pull could be
    // issued beside this device's own ack; `fetchPendingMessages` now waits for that ack, so a
    // repeat here is no longer explained by a crossing.
    expect(warned()).toContain('arrived twice');
  });

  it('names the channel that offered the second copy, not a guess about both', async () => {
    // THE LINE USED TO SAY "the live frame and the pull crossed" WHATEVER HAD HAPPENED. Three of the
    // four shapes are healed the same way and differ only in who was late, so a repeat could be
    // counted but never triaged - which is what left READ-2 and READ-4 PASS-DIRTY on 2026-09-04
    // against a log line that no one could either explain or fix.
    await deliver(row('d4ecf0fe'), 'live');
    await deliver(row('d4ecf0fe'), 'pull');

    expect(warned()).toContain('the pull listed a row this device had already acknowledged');
    // The SHAPE is what the line has to carry, and it names the pull rather than "one of the two".
    expect(warned()).not.toContain('the socket delivered a row');
  });

  it('explains a routine crossing ONCE and counts the rest, because a rate is not read line by line', async () => {
    // THE MEASUREMENT THAT FORCED THIS. FWD-2 ran twenty-five forwards back to back on 2026-09-05
    // and `pull:done` - this device's own ack still in flight when the pull was answered - fired in
    // TWENTY-THREE of them. Every line said the same true thing, so every line was skipped, and a
    // check that opens a busy conversation could not be clean while doing its job. The sentence is
    // worth saying; saying it once per send is not.
    //
    // IT IS ASSERTED ON `pull:queued` NOW, AND THE MOVE IS THE POINT. That measurement described a
    // race the ack barrier has since deleted, so `pull:done` is no longer a routine shape, and
    // asserting the quiet path on it would pin the code to a reading of a population that has
    // changed. The MECHANISM is what this case exists for, and the ordinary crossing - two channels
    // carrying one row, one of them always late - is what still exercises it.
    for (const id of ['d4ecf0fe', 'a1b2c3d4', 'beefcafe']) {
      // Both copies before the drain can finish, which is what leaves the first one `queued`.
      inner(svc).enqueueMessage(row(id), 'pull');
      inner(svc).enqueueMessage(row(id), 'pull');
      await inner(svc).messageScheduler.waitUntilIdle();
    }

    const explained = logged()
      .split('\n')
      .filter((l) => l.includes('arrived twice'));
    expect(explained).toHaveLength(1);
    expect(explained[0]).toContain('Further ones of this shape are counted, not printed');
    // Silence is not what replaced them: the count is the thing that answers "how often".
    expect(svc.deliveryRepeatStats()['pull:queued']).toBe(3);
    // And the accusing channel stayed empty, so the quiet path is quiet for the right reason.
    expect(warned()).toBe('');
  });

  it('counts each shape apart, so one loud shape cannot silence another', async () => {
    await deliver(row('d4ecf0fe'), 'live');
    await deliver(row('d4ecf0fe'), 'pull'); // pull:done
    await deliver(row('a1b2c3d4'), 'pull');
    await deliver(row('a1b2c3d4'), 'live'); // live:done - the accusing one

    expect(svc.deliveryRepeatStats()).toEqual({
      'pull:queued': 0,
      'pull:done': 1,
      'live:queued': 0,
      'live:done': 1,
    });
    // THE RATE RIDES ON THE ACCUSATION, where a reader is already looking - the shape that would be
    // a server defect is also the one place worth printing how much of everything else happened.
    expect(warned()).toContain('pull:done=1');
    expect(warned()).toContain('live:done=1');
  });

  it('ACCUSES when a live frame repeats a row already acknowledged, because no crossing explains it', async () => {
    // The gateway publishes a frame once, at send, and never replays the queue on connect - so this
    // shape is the same row published twice and is not this client losing a race with itself. It has
    // never been observed; printing it at the level of the three routine ones is how it would stay
    // that way.
    await deliver(row('d4ecf0fe'), 'pull');
    await deliver(row('d4ecf0fe'), 'live');

    expect(warned()).toContain('THE SERVER PUBLISHED THE SAME ROW TWICE');
    expect(applied).toEqual(['d4ecf0fe']);
  });

  it('is acknowledged again, because an ack that never landed is the only way it can come back', async () => {
    await deliver(row('d4ecf0fe'));
    expect(ack.mock.calls.flatMap((c) => c[0] as string[])).toEqual(['d4ecf0fe']);

    await deliver(row('d4ecf0fe'));

    // Twice in the acknowledgement stream, once through the pipeline. Dropping the repeat silently
    // would leave the row pending for ever on a device that had already read it.
    expect(ack.mock.calls.flatMap((c) => c[0] as string[])).toEqual(['d4ecf0fe', 'd4ecf0fe']);
    expect(applied).toEqual(['d4ecf0fe']);
  });

  it('is admitted every time when the server holds no row for it', async () => {
    // A live WebSocket frame need not carry a `queuedMessageId`: there is nothing to acknowledge and
    // nothing that can re-offer it, so there is no second copy to recognise and no identity to
    // deduplicate on. Two of them are two messages.
    await deliver(row('', { queuedMessageId: undefined }));
    await deliver(row('', { queuedMessageId: undefined }));

    expect(applied).toEqual(['(none)', '(none)']);
    expect(ack).not.toHaveBeenCalled();
  });

  it('is re-delivered when the drain deliberately left it unacknowledged', async () => {
    // THE CASE THIS MUST NOT BREAK. A frame whose group is not known yet is processed, refused, and
    // NOT acknowledged - the server keeps it and hands it back once the Welcome lands. A memory that
    // remembered it would make that re-fetch drop the very frame it went to get.
    poke(svc, { messageCallback: handlerThat(['left-behind']) });

    await deliver(row('left-behind'));
    await deliver(row('left-behind'));

    expect(applied).toEqual(['left-behind', 'left-behind']);
    expect(ack).not.toHaveBeenCalled();
  });

  it('forgets the oldest delivery once its memory is full', async () => {
    // The bound is what keeps a long session from growing a map for ever, and the cost of an
    // eviction is exactly the behaviour that shipped before the map existed: one repeat decrypted
    // twice and acknowledged. Asserted so the bound is known to be reachable rather than assumed.
    const memory = 512;
    for (let i = 0; i < memory + 1; i += 1) await deliver(row(`row-${i}`));
    expect(applied).toHaveLength(memory + 1);

    await deliver(row('row-0'));

    expect(applied[applied.length - 1]).toBe('row-0');
  });
});
