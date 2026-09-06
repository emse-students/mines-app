/**
 * AN ACK ATTEMPT THAT NEVER COMES BACK MUST BE ABANDONED, because a pull now waits behind it.
 *
 * `ackMessagesWithRetry` bounds how many times it gives up - four attempts with backoff - and used
 * to bound nothing at all about how long ONE of them may take. That was harmless while every call
 * site `void`ed the ack: a promise that never settled cost nobody anything. It stopped being
 * harmless the day `fetchPendingMessages` started awaiting `ackInFlight` to keep a pull from
 * overtaking this device's own acknowledgement - from then on a wedged socket is not a hung request,
 * it is a mailbox that never drains again, and every ack chained behind it is wedged too.
 *
 * A RETRY LOOP IS NOT A DEADLINE, and that distinction is the whole of this file: `fetch` waits on an
 * open socket for as long as the socket stays open, so the loop's four attempts can be four
 * unbounded waits. These cases drive the clock rather than waiting on one, so nothing here is timing
 * -dependent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ackMessagesWithRetry, clearPersistedPendingAcks } from '$lib/mls-client/ackRetry';

const body = { userId: 'user-a', deviceId: 'device-a', messageIds: ['row-1'] };

describe('an ACK attempt that never answers', () => {
  beforeEach(() => {
    clearPersistedPendingAcks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPersistedPendingAcks();
  });

  it('is abandoned on its own deadline instead of hanging the caller for ever', async () => {
    /** Every signal the transport was handed - the assertion is that it is given one at all. */
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        // A socket that is open and silent, which is the case a retry count cannot see.
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      })
    );

    const acking = ackMessagesWithRetry('https://history.test', {}, body);
    /** Settled or still waiting - read without awaiting, which is the whole question here. */
    let done = false;
    void acking.then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    expect(done).toBe(false);

    // The deadline lands, the attempt is abandoned, and the loop moves on rather than waiting out
    // a socket nobody is going to answer.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals[0].aborted).toBe(true);

    // Four attempts, each with its own deadline and the backoff between them: 4 x 10 s + 7.5 s.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(true);
    expect(signals).toHaveLength(4);

    // AND IT CONCLUDED RATHER THAN VANISHED. The ids are kept for the next connect, which is what
    // makes abandoning the attempt safe: nothing is acknowledged, and nothing is forgotten either.
    expect(
      JSON.parse(sessionStorage.getItem('canari_pending_message_acks') ?? 'null')
    ).toMatchObject({ messageIds: ['row-1'] });
  });

  it('clears the deadline when the request answers, so a slow success is still a success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, _init: RequestInit) =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve({ ok: true } as Response), 5_000);
          })
      )
    );

    const acking = ackMessagesWithRetry('https://history.test', {}, body);
    await vi.advanceTimersByTimeAsync(6_000);
    await acking;

    // Nothing persisted: the ids landed, so there is nothing owed to the next connect.
    expect(sessionStorage.getItem('canari_pending_message_acks')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
