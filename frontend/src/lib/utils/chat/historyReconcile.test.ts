/**
 * The triggers, and what stops a device asking twice for the same thing.
 *
 * Read against the module it replaces: the awaiting-history registry answered "is this conversation
 * missing history?" from durable state, and could not withdraw the answer. Everything here answers
 * a question about a MOMENT instead - did a probe just go out, did the last election find anybody -
 * so every case below is about the lifetime of a fact, not about a conversation.
 */
import type { Mock } from 'vitest';
import {
  answerAfterMailboxDrained,
  reconcileGroup,
  escalateReconciliation,
  reconcileAllGroups,
  retryDeferredReconciliations,
  deferredReconciliations,
  forgetGroupReconciliation,
  noteCoverageShortfall,
  statedCoverage,
  resetHistoryReconciliation,
  setHistoryProbeSender,
  connectionSweepDecision,
  noteConnection,
  resetConnectionRecord,
  groupsOwingAudit,
  noteGroupsAudited,
  resetAuditRecord,
  type HistoryProbeSender,
} from './historyReconcile';

const GROUP = 'g1';
const OTHER = 'g2';

/**
 * An MLS service whose election answers `outcome`, or throws when it is an Error.
 *
 * `waitForMessageQueueIdle` resolves immediately unless a test hands it a gate: no case below is
 * about the mailbox, and one that is opens the gate itself.
 */
function service(
  outcome: { noPeerOnline?: boolean; target?: string; excludedOnline?: number } | Error = {},
  waitForMessageQueueIdle = vi.fn().mockResolvedValue(undefined),
  distributionGroups: readonly string[] = []
) {
  return {
    sendHistoryRequest: vi.fn().mockImplementation(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
    waitForMessageQueueIdle,
    isDistributionGroup: vi.fn((groupId: string) => distributionGroups.includes(groupId)),
  } as unknown as Parameters<typeof reconcileGroup>[0] & {
    sendHistoryRequest: ReturnType<typeof vi.fn>;
    waitForMessageQueueIdle: ReturnType<typeof vi.fn>;
    isDistributionGroup: ReturnType<typeof vi.fn>;
  };
}

let probe: Mock<HistoryProbeSender>;
const log = vi.fn();

beforeEach(() => {
  resetHistoryReconciliation();
  log.mockClear();
  probe = vi.fn().mockResolvedValue(true);
  setHistoryProbeSender(probe);
});

afterEach(() => setHistoryProbeSender(null));

/** The deferred groups alone - most cases care about which, a few care about why. */
const deferredGroups = (): string[] => deferredReconciliations().map(([groupId]) => groupId);

describe('reconcileGroup', () => {
  // FOUND ON PRODUCTION 2026-08-20, and it is the whole reason this guard exists. The connection
  // audit takes its targets from `getLocalGroups()`, which names the community's seed carrier and
  // one group per private salon - none of which has ever held a message. Each got a `history_state`
  // probe broadcast as an MLS application frame to every member, who logged it as an unhandled
  // frame of an unknown kind and answered nothing. Asserted BEFORE the coalescing window, because
  // the two refusals are not the same fact: this one is permanent.
  it('never probes a distribution group - it has no history to reconcile', async () => {
    const mls = service({}, vi.fn().mockResolvedValue(undefined), [GROUP]);

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    // Not deferred either: deferring means "ask later", and there will never be anything to ask.
    expect(deferredGroups()).not.toContain(GROUP);
  });

  it('refuses it on every trigger, not only the first - the window is not what stops it', async () => {
    const mls = service({}, vi.fn().mockResolvedValue(undefined), [GROUP]);

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(await reconcileGroup(mls, GROUP, log, Date.now() + 3_600_000)).toBe(false);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('still probes an ordinary group on the same device', async () => {
    const mls = service({}, vi.fn().mockResolvedValue(undefined), ['distribution-group']);

    expect(await reconcileGroup(mls, GROUP, log)).toBe(true);
    expect(probe).toHaveBeenCalledWith(GROUP);
  });

  it('elects a responder FIRST, then sends the probe', async () => {
    // Order, not just presence: a state key sent before the election is an MLS frame every member
    // of the group decrypts, for an exchange that may never have started.
    const order: string[] = [];
    const mls = service();
    mls.sendHistoryRequest.mockImplementation(async () => {
      order.push('elect');
      return {};
    });
    probe.mockImplementation(async () => {
      order.push('probe');
      return true;
    });

    expect(await reconcileGroup(mls, GROUP, log)).toBe(true);
    expect(order).toEqual(['elect', 'probe']);
    expect(probe).toHaveBeenCalledWith(GROUP);
  });

  it('sends NO probe when the server elected nobody, and remembers only that', async () => {
    const mls = service({ noPeerOnline: true });

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(deferredGroups()).toEqual([GROUP]);
  });

  it('records NOTHING when the election never left the device', async () => {
    // Offline, DNS, TLS, a 502 from the proxy. None of them is an answer about anybody else, so
    // none of them may be stored as one - the old marker was written on exactly this path and then
    // outlived the outage by 30 days.
    const mls = service(new Error('Failed to fetch'));

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(deferredGroups()).toEqual([]);
    // And nothing is coalesced either: the next edge must be free to ask.
    expect(await reconcileGroup(service(), GROUP, log)).toBe(true);
  });

  it('clears the awaiting-responder note as soon as an ask actually goes out', async () => {
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    expect(deferredGroups()).toEqual([GROUP]);

    await reconcileGroup(service(), GROUP, log, Date.now() + 60_000);
    expect(deferredGroups()).toEqual([]);
  });

  it('DEFERS rather than drops when no probe sender is registered yet, and SAYS so', async () => {
    // THE ASK IS THE ONLY TRACE OF THE GAP. The caller that raises this trigger - an MLS frame that
    // can never be decrypted - acks that frame in the same breath, so the server deletes it and no
    // later edge can raise the trigger again. Dropping the ask here left a production DM
    // permanently short of the messages it had lost.
    setHistoryProbeSender(null);
    const mls = service();

    expect(await reconcileGroup(mls, GROUP, log)).toBe(false);
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no probe sender'));
    expect(deferredReconciliations()).toEqual([[GROUP, 'no-probe-sender']]);
  });

  it('asks the moment a probe sender arrives, for the group deferred without one', async () => {
    // The discharge the session owes: installing the sender is the edge, and this pass is what
    // turns it into the ask that was deferred.
    setHistoryProbeSender(null);
    await reconcileGroup(service(), GROUP, log);
    setHistoryProbeSender(probe);

    await retryDeferredReconciliations(service(), [GROUP], log);

    expect(probe).toHaveBeenCalledWith(GROUP);
    expect(deferredGroups()).toEqual([]);
  });

  it('stays deferred while the sender is still missing, so a later edge still finds it', async () => {
    setHistoryProbeSender(null);
    await reconcileGroup(service(), GROUP, log);

    await retryDeferredReconciliations(service(), [GROUP], log);

    expect(deferredReconciliations()).toEqual([[GROUP, 'no-probe-sender']]);
  });

  it('keeps the group deferred when the election answered but the probe never left', async () => {
    // The note used to be cleared on the election, which asks nobody anything: a group whose probe
    // then failed to encrypt was recorded as attended to and never retried.
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    probe.mockResolvedValueOnce(false);

    expect(await reconcileGroup(service(), GROUP, log, Date.now() + 60_000)).toBe(false);
    expect(deferredGroups()).toEqual([GROUP]);
  });

  describe('escalating past a responder that answers nothing', () => {
    /**
     * THE FIFTH TRIGGER. The server elects a RANDOM online member so a retry can rotate past a peer
     * that is online but frozen; measured 2026-09-05, there was no retry to rotate. A device holding a
     * frame it cannot read knows its store is incomplete without asking anybody, so an ask in flight
     * that reached a silent member is something to argue with rather than defer to.
     */
    /** A service that elects each of `targets` in turn, as the server's randomisation would. */
    function rotating(targets: string[]) {
      let i = 0;
      return {
        sendHistoryRequest: vi.fn().mockImplementation(async () => ({
          target: targets[Math.min(i++, targets.length - 1)],
        })),
        waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
        isDistributionGroup: vi.fn(() => false),
      } as unknown as Parameters<typeof reconcileGroup>[0] & {
        sendHistoryRequest: ReturnType<typeof vi.fn>;
      };
    }

    it('elects somebody else, excluding the member the ask in flight reached', async () => {
      const mls = rotating(['u:phone', 'u:w1']);
      const now = Date.now();
      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(true);

      expect(await escalateReconciliation(mls, GROUP, log, now + 6_000)).toBe(true);

      expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
      expect(mls.sendHistoryRequest.mock.calls[1][1]).toEqual({ exclude: ['u:phone'] });
    });

    it('adds ONE member per step, and the set only grows', async () => {
      const mls = rotating(['u:phone', 'u:w1', 'u:w2']);
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);
      await escalateReconciliation(mls, GROUP, log, now + 6_000);

      expect(await escalateReconciliation(mls, GROUP, log, now + 7_000)).toBe(true);

      expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(3);
      expect(mls.sendHistoryRequest.mock.calls[2][1]).toEqual({ exclude: ['u:phone', 'u:w1'] });
    });

    it('stops loudly against a server that ignores the exclusion, and does not walk on it', async () => {
      // The one shape that would not terminate: a step that re-draws a member already in the set adds
      // nothing, so the walk stops there rather than looping politely. The guard predates this trigger
      // and is what bounds it - the walk never gets a second member to exclude.
      const mls = rotating(['u:phone']);
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      expect(await escalateReconciliation(mls, GROUP, log, now + 6_000)).toBe(false);

      expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.flat().join(' ')).toContain('which we asked it to skip');
    });

    it('ends on the proof the SERVER delivers when every reachable member has been asked', async () => {
      const mls = service({ noPeerOnline: true, excludedOnline: 2 });
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      // No ask is in flight - `no_peer_online` released the window - so this is an ordinary first ask.
      expect(await escalateReconciliation(mls, GROUP, log, now + 1_000)).toBe(false);
      expect(log.mock.calls.flat().join(' ')).toContain('every reachable member');
    });

    it('is an ordinary ask when nothing is in flight', async () => {
      const mls = service({ target: 'u:w1' });

      expect(await escalateReconciliation(mls, GROUP, log, Date.now())).toBe(true);

      expect(mls.sendHistoryRequest).toHaveBeenCalledWith(GROUP, { exclude: [] });
    });

    it('waits rather than duplicating when the election has not named anybody yet', async () => {
      // The election answered without a target - nobody is holding this ask, so escalating past it
      // would only be the duplicate the coalescing window exists to remove.
      const mls = service({});
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      expect(await escalateReconciliation(mls, GROUP, log, now + 6_000)).toBe(false);
      expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    });

    it('starts a FRESH walk on the next ordinary ask - a member may have woken up', async () => {
      const mls = service({ target: 'u:phone' });
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);
      await escalateReconciliation(mls, GROUP, log, now + 6_000);

      // Past the window: an ordinary trigger, which begins again from the whole membership.
      await reconcileGroup(mls, GROUP, log, now + 61_000);

      expect(mls.sendHistoryRequest).toHaveBeenLastCalledWith(GROUP, { exclude: [] });
    });

    it('forgets the walk with the conversation', async () => {
      const mls = service({ target: 'u:phone' });
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);
      await escalateReconciliation(mls, GROUP, log, now + 6_000);
      forgetGroupReconciliation(GROUP);

      await reconcileGroup(mls, GROUP, log, now + 7_000);

      expect(mls.sendHistoryRequest).toHaveBeenLastCalledWith(GROUP, { exclude: [] });
    });
  });

  describe('coalescing', () => {
    it('collapses a burst of triggers on one group into a single ask', async () => {
      // The case that produced it: a replay failing to decrypt forty frames of one conversation
      // raises forty edges for one difference.
      const mls = service();
      const now = Date.now();
      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(true);
      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(false);
      expect(await reconcileGroup(mls, GROUP, log, now + 29_000)).toBe(false);

      expect(probe).toHaveBeenCalledTimes(1);
      // The second and third never even reached the server.
      expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    });

    it('SAYS it coalesced - a silent decline made the caller a liar', async () => {
      // `history.ts` prints "holds N frame(s) it can never read - reconciling" and then calls this.
      // When the swallow was silent, that line claimed a repair that never happened - which is how
      // the P1 of 2026-09-05 read as a product that never retries rather than as a trigger swallowed
      // six seconds after the join it duplicated.
      const mls = service();
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);
      log.mockClear();

      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(false);

      expect(log.mock.calls.flat().join(' ')).toContain('not asking again');
    });

    it('coalesces PER GROUP - a burst on one says nothing about another', async () => {
      const mls = service();
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      expect(await reconcileGroup(mls, OTHER, log, now + 1)).toBe(true);
    });

    it('lets the window lapse rather than scheduling anything', async () => {
      // Nothing here fires on its own: the window only decides whether the NEXT edge is a duplicate.
      const mls = service();
      const now = Date.now();
      await reconcileGroup(mls, GROUP, log, now);

      expect(await reconcileGroup(mls, GROUP, log, now + 30_001)).toBe(true);
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('re-opens the window when the election went out but the probe did not', async () => {
      // The responder is now waiting for a state key that will never arrive. Leaving the group
      // coalesced would make the next edge decline to ask for another 30 s.
      probe.mockResolvedValueOnce(false);
      const mls = service();
      const now = Date.now();

      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(false);
      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(true);
    });

    it('treats a THROWN probe the same way, and logs it', async () => {
      probe.mockRejectedValueOnce(new Error('mls encrypt failed'));
      const mls = service();
      const now = Date.now();

      expect(await reconcileGroup(mls, GROUP, log, now)).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('probe failed'));
      expect(await reconcileGroup(mls, GROUP, log, now + 1)).toBe(true);
    });
  });
});

describe('the mailbox barrier', () => {
  /** A `waitForMessageQueueIdle` that stays pending until the test opens it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { wait: vi.fn().mockReturnValue(opened), open };
  }

  /** Drains the microtask queue, which is all these cases ever wait on. */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('elects nobody and probes nobody until the inbound queue is idle', async () => {
    const gateway = gate();
    const mls = service({}, gateway.wait);

    const run = reconcileGroup(mls, GROUP, log);
    await flush();
    // The whole point: the election is a round trip that commits a peer to wait for our probe, and
    // the probe states what we hold. Neither may leave over a store the drain is still writing.
    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();

    gateway.open();
    await expect(run).resolves.toBe(true);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst raised DURING the drain into one ask - the reservation precedes the barrier', async () => {
    const gateway = gate();
    const mls = service({}, gateway.wait);

    // Forty failing frames of one group raise forty edges. Reserving the window only after the
    // barrier would park all of them, and then ask forty times when the queue went idle.
    const runs = [
      reconcileGroup(mls, GROUP, log),
      reconcileGroup(mls, GROUP, log),
      reconcileGroup(mls, GROUP, log),
    ];
    gateway.open();

    expect(await Promise.all(runs)).toEqual([true, false, false]);
    expect(mls.waitForMessageQueueIdle).toHaveBeenCalledTimes(1);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * THE SECOND ARGUMENT IS NOT THE GROUP BEING RECONCILED, AND THAT COST A REAL GUARANTEE.
   *
   * `waitForMessageQueueIdle(caller, catchUpGroupId)` asks which group's catch-up session the
   * caller is INSIDE - the barrier refuses that one, because the drain would need the mutex that
   * session holds for its whole life. This call site passed the group it was reconciling, which is
   * never that: `createDecryptSession` is the only opener of a session, `history.ts` its only
   * caller, and it reaches `reconcileGroup` from a `finally` that has already awaited
   * `session.finish()`.
   *
   * So the group name only ever matched a CONCURRENT session, which the barrier then reported as
   * an unresolvable deadlock and SKIPPED - dropping the ordering guarantee this call exists to take
   * and sending the ask against a mailbox that had never been emptied. Measured by GRP-7 on
   * 2026-08-23, with `[HISTORY_STATE] holds something different` in the same report.
   *
   * Pinned on the ARGUMENT rather than on an observable effect because that is where the defect
   * lives: every consequence of it is inside `BaseMlsService`, which has its own tests for both
   * branches, and this is the only place that can state which branch this caller is entitled to.
   */
  it('tells the barrier it is inside no catch-up session, because it never is', async () => {
    const mls = service();

    await reconcileGroup(mls, GROUP, log);

    expect(mls.waitForMessageQueueIdle).toHaveBeenCalledWith('history ask', null);
  });

  it('holds an ANSWER until the queue is idle, and never blocks the drain it was raised from', async () => {
    const gateway = gate();
    const answer = vi.fn().mockResolvedValue(undefined);

    // Returns void, synchronously: every responder leg runs inside the pipeline, so awaiting the
    // queue from there would be the drain waiting on itself.
    expect(
      answerAfterMailboxDrained({ waitForGroupQueueIdle: gateway.wait } as never, GROUP, answer)
    ).toBeUndefined();
    // THE GROUP IT WAITS FOR, not the whole account: this leg describes ONE conversation, and a
    // device rejoining twenty-nine of them reached whole-mailbox idle 189 s after it was asked.
    expect(gateway.wait).toHaveBeenCalledWith('history answer', GROUP);
    await flush();
    expect(answer).not.toHaveBeenCalled();

    gateway.open();
    await flush();
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('still answers when the barrier itself rejects - a broken queue must not silence a peer', async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    answerAfterMailboxDrained(
      { waitForGroupQueueIdle: vi.fn().mockRejectedValue(new Error('scheduler gone')) } as never,
      GROUP,
      answer
    );
    await flush();
    expect(answer).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileAllGroups', () => {
  it('asks every local group - unconditionally, with no stored evidence to justify it', async () => {
    const mls = service();
    await reconcileAllGroups(mls, [GROUP, OTHER, 'g3'], log);

    expect(probe.mock.calls.map(([g]) => g)).toEqual([GROUP, OTHER, 'g3']);
  });

  it('carries on past a group whose election fails', async () => {
    const mls = service();
    mls.sendHistoryRequest.mockRejectedValueOnce(new Error('boom'));

    await reconcileAllGroups(mls, [GROUP, OTHER], log);
    expect(probe).toHaveBeenCalledWith(OTHER);
  });

  it('reports how many asks went out', async () => {
    // A correct mechanism with no report is found by hand, a day late.
    const mls = service();
    mls.sendHistoryRequest.mockResolvedValueOnce({ noPeerOnline: true });

    await reconcileAllGroups(mls, [GROUP, OTHER], log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1/2 group(s) asked'));
  });

  it('runs the elections concurrently rather than one round trip after another', async () => {
    // THE POINT OF THE PASS BEING CONCURRENT AT ALL. Nine sequential elections were measured at
    // 4.35 s on a device - ~480 ms of HTTP round trip each, taking no lock and serialised for no
    // reason - and the inbound drain that overlapped them inherited the whole duration. What is
    // asserted is the property, not a duration: several elections are in flight at the same time.
    const mls = service();
    let inFlight = 0;
    let peak = 0;
    mls.sendHistoryRequest.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {};
    });

    await reconcileAllGroups(mls, ['a', 'b', 'c', 'd'], log);
    expect(peak).toBeGreaterThan(1);
  });

  it('never opens more elections at once than the bound allows', async () => {
    // The bound is the half that keeps this safe on a phone: a device in fifty conversations must
    // not open fifty requests on the radio the instant it reconnects.
    const mls = service();
    let inFlight = 0;
    let peak = 0;
    mls.sendHistoryRequest.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return {};
    });

    await reconcileAllGroups(
      mls,
      Array.from({ length: 40 }, (_, i) => `g${i}`),
      log
    );
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('says so even when there is nothing to ask', async () => {
    await reconcileAllGroups(service(), [], log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0/0 group(s) asked'));
  });
});

describe('retryDeferredReconciliations', () => {
  it('retries ONLY the groups that found nobody, never the ones already compared', async () => {
    // A presence edge is frequent. Re-asking every group on each one would put this mechanism back
    // where the sweep it replaces was: traffic on a trigger that means nothing about the groups.
    const mls = service();
    await reconcileGroup(mls, OTHER, log); // asked, and answered
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log); // nobody online
    probe.mockClear();

    await retryDeferredReconciliations(service(), [GROUP, OTHER], log);

    expect(probe.mock.calls.map(([g]) => g)).toEqual([GROUP]);
  });

  it('does nothing when no group is waiting', async () => {
    const mls = service();
    await retryDeferredReconciliations(mls, [GROUP, OTHER], log);

    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
  });

  it('drops a waiting group this device no longer holds', async () => {
    // Left in the group, or the conversation purged, while the peers were offline. There is nothing
    // to reconcile it against, and re-electing would ask the server about a group we are not in.
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    const mls = service();

    await retryDeferredReconciliations(mls, [OTHER], log);

    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(deferredGroups()).toEqual([]);
  });
});

describe('forgetting', () => {
  it('forgetGroupReconciliation drops both notes for one conversation, and only that one', async () => {
    // State describing a conversation may not outlive one - three separate pieces of it once did,
    // one of them user-visible.
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    await reconcileGroup(service({ noPeerOnline: true }), OTHER, log);

    forgetGroupReconciliation(GROUP);

    expect(deferredGroups()).toEqual([OTHER]);
    // The coalescing note is gone too, so a group re-created under the same id may ask at once.
    const now = Date.now();
    await reconcileGroup(service(), GROUP, log, now);
    forgetGroupReconciliation(GROUP);
    expect(await reconcileGroup(service(), GROUP, log, now + 1)).toBe(true);
  });

  it('resetHistoryReconciliation drops everything, for logout', async () => {
    await reconcileGroup(service({ noPeerOnline: true }), GROUP, log);
    const now = Date.now();
    await reconcileGroup(service(), OTHER, log, now);

    resetHistoryReconciliation();

    expect(deferredGroups()).toEqual([]);
    expect(await reconcileGroup(service(), OTHER, log, now + 1)).toBe(true);
  });
});

/**
 * WHEN A CONNECTION IS WORTH A SWEEP AT ALL.
 *
 * The sweep used to be unconditional and that was its entire cost: nine groups probed on every
 * connection, on a server carrying no other traffic, announced to the user as an arriving backlog.
 * These cases pin the one question it is allowed to ask - "could the server have dropped something
 * for me" - and, just as importantly, the answers that must NOT provoke one.
 */
describe('connectionSweepDecision', () => {
  const USER = 'user-a';
  const DEVICE = 'device-1';
  const DAY = 86_400_000;
  const NOW = 1_700_000_000_000;

  beforeEach(() => resetConnectionRecord(USER, DEVICE));

  it('sweeps when nothing was ever recorded - a new or restored store holds nothing to trust', () => {
    const { sweep, reason } = connectionSweepDecision(USER, DEVICE, NOW);
    expect(sweep).toBe(true);
    expect(reason).toContain('new or restored');
  });

  it('does NOT sweep for a device that connected yesterday - the server still holds everything', () => {
    noteConnection(USER, DEVICE, NOW - DAY);
    expect(connectionSweepDecision(USER, DEVICE, NOW).sweep).toBe(false);
  });

  it('does NOT sweep just below the retention window', () => {
    noteConnection(USER, DEVICE, NOW - 89 * DAY);
    expect(connectionSweepDecision(USER, DEVICE, NOW).sweep).toBe(false);
  });

  it('sweeps once the absence reaches what the server keeps', () => {
    noteConnection(USER, DEVICE, NOW - 90 * DAY);
    const { sweep, reason } = connectionSweepDecision(USER, DEVICE, NOW);
    expect(sweep).toBe(true);
    expect(reason).toContain('past what the server keeps');
  });

  it('sweeps when the record sits in the future - a backwards clock makes the age unusable', () => {
    noteConnection(USER, DEVICE, NOW + DAY);
    expect(connectionSweepDecision(USER, DEVICE, NOW).sweep).toBe(true);
  });

  it('keeps one record per device, so a second device does not inherit the first ones answer', () => {
    noteConnection(USER, DEVICE, NOW - DAY);
    expect(connectionSweepDecision(USER, DEVICE, NOW).sweep).toBe(false);
    expect(connectionSweepDecision(USER, 'device-2', NOW).sweep).toBe(true);
    resetConnectionRecord(USER, 'device-2');
  });

  it('keeps one record per user, so re-logging as somebody else sweeps', () => {
    noteConnection(USER, DEVICE, NOW - DAY);
    expect(connectionSweepDecision('user-b', DEVICE, NOW).sweep).toBe(true);
    resetConnectionRecord('user-b', DEVICE);
  });
});

/**
 * THE ONE-SHOT AUDIT, for damage that predates the mechanism that would have caught it.
 *
 * Every other trigger needs a live witness. A conversation damaged before the repair path worked has
 * none left - the frame that would have raised it was acked and deleted at the time - so the store
 * holds an absence, and an absence is not detectable from one side. These cases pin the property the
 * whole design rests on: the audit is discharged PER GROUP and only for groups an ask really left
 * for, so a group that could not be compared comes back alone rather than dragging the store with it.
 */
describe('the one-shot audit', () => {
  const USER = 'audit-user';
  const DEVICE = 'audit-device';
  const LOCAL = ['g-1', 'g-2', 'g-3'];

  beforeEach(() => resetAuditRecord(USER, DEVICE));

  it('owes the audit for every local group when nothing was ever recorded', () => {
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual(LOCAL);
  });

  it('stops owing it for the groups an ask really left for', () => {
    noteGroupsAudited(USER, DEVICE, ['g-1', 'g-3']);
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual(['g-2']);
  });

  it('STILL owes it for a group that was handed to the pass but never asked', () => {
    // The pass was given all three; only two probes left (the third was deferred - no peer online).
    // Recording the INPUT would lose that group for good, which is the whole point of recording the
    // OUTPUT instead.
    noteGroupsAudited(USER, DEVICE, ['g-1', 'g-2']);
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toContain('g-3');
  });

  it('accumulates across connections rather than replacing the record', () => {
    noteGroupsAudited(USER, DEVICE, ['g-1']);
    noteGroupsAudited(USER, DEVICE, ['g-2']);
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual(['g-3']);
  });

  it('writes nothing at all when no ask left, so an empty pass cannot discharge anything', () => {
    noteGroupsAudited(USER, DEVICE, []);
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual(LOCAL);
  });

  it('owes it again for a record left by an earlier generation - a bump re-runs the fleet', () => {
    noteGroupsAudited(USER, DEVICE, LOCAL);
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual([]);
    localStorage.setItem(
      `history_audit:${USER}:${DEVICE}`,
      JSON.stringify({ generation: 0, groupIds: LOCAL })
    );
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual(LOCAL);
  });

  it('owes it for everything when the record is unreadable, never silently skips', () => {
    localStorage.setItem(`history_audit:${USER}:${DEVICE}`, 'not json');
    expect(groupsOwingAudit(USER, DEVICE, LOCAL)).toEqual(LOCAL);
  });

  it('owes it for a group joined after the audit ran - one probe, once, and then never again', () => {
    noteGroupsAudited(USER, DEVICE, LOCAL);
    expect(groupsOwingAudit(USER, DEVICE, [...LOCAL, 'g-new'])).toEqual(['g-new']);
    noteGroupsAudited(USER, DEVICE, ['g-new']);
    expect(groupsOwingAudit(USER, DEVICE, [...LOCAL, 'g-new'])).toEqual([]);
  });

  it('keeps one record per device and per user', () => {
    noteGroupsAudited(USER, DEVICE, LOCAL);
    expect(groupsOwingAudit(USER, 'other-device', LOCAL)).toEqual(LOCAL);
    expect(groupsOwingAudit('other-user', DEVICE, LOCAL)).toEqual(LOCAL);
    resetAuditRecord(USER, 'other-device');
    resetAuditRecord('other-user', DEVICE);
  });
});

/**
 * The fourth trigger: an answer that does not reach as far back as the ask.
 *
 * Every case here is about TERMINATION, because that is the only hard part. A phone keeping five
 * years and a browser keeping ninety days produce a clipped answer on every single reconciliation,
 * by construction - so "ask again" has to stop on a fact, and these pin which fact.
 */
describe('noteCoverageShortfall', () => {
  const DAY = 86_400_000;
  const NOW = 1_700_000_000_000;
  /** What this device asked from, and what a peer's coverage is measured against. */
  const SINCE = NOW - 5 * 365 * DAY;
  /** A browser's answer: complete for ninety days, and not one hour before that. */
  const NINETY_DAYS = NOW - 90 * DAY;

  const W1 = 'u1:browser';
  const W2 = 'u2:phone';

  it('elects again, EXCLUDING the member that said it cannot cover the range', async () => {
    const mls = service({ target: W2 });

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(mls.sendHistoryRequest).toHaveBeenCalledWith(GROUP, { exclude: [W1] });
    expect(probe).toHaveBeenCalledWith(GROUP);
  });

  it('records the claim but chases nothing when the peer DOES cover what we asked', async () => {
    // Coverage at or below our window is the answer we wanted. It is still recorded - the claim is
    // a fact about that member - but there is nothing left to look for.
    const mls = service();

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: SINCE }, log);

    expect(mls.sendHistoryRequest).not.toHaveBeenCalled();
    expect(statedCoverage(GROUP)).toEqual([[W1, SINCE]]);
  });

  it('STOPS on the proof: no peer online, and every online one already answered', async () => {
    // This is the terminator. `excludedOnline > 0` is the server saying "everybody reachable has
    // already told you" - a fact it alone holds, delivered rather than waited out.
    const mls = service({ noPeerOnline: true, excludedOnline: 2 });

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(probe).not.toHaveBeenCalled();
    // NOT deferred: no edge would ever discharge it, because nothing about those members will
    // change. The next connection compares again from scratch.
    expect(deferredGroups()).toEqual([]);
  });

  it('defers instead when nobody was online at all - a different fact, same status', async () => {
    const mls = service({ noPeerOnline: true, excludedOnline: 0 });

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(deferredReconciliations()).toEqual([[GROUP, 'no-peer-online']]);
  });

  it('walks each member at most once, so the exclusion set only grows', async () => {
    const mls = service();
    mls.sendHistoryRequest
      .mockResolvedValueOnce({ target: W2 })
      .mockResolvedValueOnce({ noPeerOnline: true, excludedOnline: 2 });

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);
    await noteCoverageShortfall(mls, GROUP, W2, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(mls.sendHistoryRequest.mock.calls.map(([, opts]) => opts.exclude)).toEqual([
      [W1],
      [W1, W2],
    ]);
  });

  it('stops loudly when the server elects a member it was asked to skip', async () => {
    // An older build mid-rollout ignores `exclude`. Left alone it is the one shape that would not
    // terminate: a step that re-draws a member already in the set advances nothing.
    const mls = service({ target: W1 });

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(probe).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('which we asked it to skip');
  });

  it('releases the coalescing window, so the ask it answers cannot suppress the next step', async () => {
    // The window collapses a BURST of triggers into one ask. Once that ask has been answered it has
    // done its job, and holding it would swallow the very step this edge exists to take.
    const mls = service({ target: W2 });
    await reconcileGroup(mls, GROUP, log);
    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(1);

    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(mls.sendHistoryRequest).toHaveBeenCalledTimes(2);
  });

  it('never lets an ORDINARY reconciliation carry an exclusion', async () => {
    // The claims are about COVERAGE. An ordinary reconciliation is about CONTENT, and a member with
    // a short memory still receives every new message - excluding it there would skip a real repair.
    const mls = service({ target: W2 });
    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);
    mls.sendHistoryRequest.mockClear();

    await reconcileGroup(mls, GROUP, log, Date.now() + 60_000);

    expect(mls.sendHistoryRequest).toHaveBeenCalledWith(GROUP, { exclude: [] });
  });

  it('re-elects a member whose claim no longer falls short - our window can have moved', async () => {
    // A claim is measured against the window it was given, and ours slides: either side of midnight
    // is enough. Excluding on "has spoken" rather than on "cannot help" would skip exactly the
    // member the walk is looking for.
    const mls = service({ target: W2 });
    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);
    mls.sendHistoryRequest.mockClear();

    // A second answer, compared against a window that now opens ABOVE what W1 said it holds - so W1
    // is no longer short of us and must be electable again.
    await noteCoverageShortfall(
      mls,
      GROUP,
      W2,
      { since: NINETY_DAYS + DAY, coveredFrom: NOW },
      log
    );

    expect(mls.sendHistoryRequest).toHaveBeenCalledWith(GROUP, { exclude: [W2] });
  });

  it('forgets the claims with the conversation they describe', async () => {
    const mls = service({ target: W2 });
    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);
    expect(statedCoverage(GROUP)).toHaveLength(1);

    forgetGroupReconciliation(GROUP);

    expect(statedCoverage(GROUP)).toEqual([]);
  });

  it('keeps the claims of one conversation out of another', async () => {
    const mls = service({ target: W2 });
    await noteCoverageShortfall(mls, GROUP, W1, { since: SINCE, coveredFrom: NINETY_DAYS }, log);

    expect(statedCoverage(OTHER)).toEqual([]);
  });
});
