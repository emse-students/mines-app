import { MlsPerGroupScheduler, type MlsQueuedMessage } from './mlsPerGroupScheduler';

function msg(
  groupId: string,
  label: string,
  overrides: Partial<MlsQueuedMessage> = {}
): MlsQueuedMessage {
  return {
    senderId: 'u1',
    ciphertext: new Uint8Array([label.charCodeAt(0)]),
    groupId,
    isWelcome: false,
    isCommit: false,
    ...overrides,
  };
}

describe('MlsPerGroupScheduler', () => {
  it('round-robins application messages across groups (web mode)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('group-a', 'a1'));
    scheduler.enqueue(msg('group-b', 'b1'));
    scheduler.enqueue(msg('group-a', 'a2'));
    scheduler.enqueue(msg('group-b', 'b2'));

    const order: string[] = [];
    await scheduler.drain(async (m) => {
      order.push(String.fromCharCode(m.ciphertext[0]));
    });

    expect(order).toEqual(['a', 'b', 'a', 'b']);
  });

  it('drains Welcome without waiting on the held MLS lock (handler self-locks)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    // Simulate a catch-up decrypt session holding the lock.
    const release = await scheduler.acquireMlsLock();

    let welcomeProcessed = false;
    scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
    await scheduler.drain(async () => {
      welcomeProcessed = true;
    });

    expect(welcomeProcessed).toBe(true); // Welcome is not auto-locked, so it is not blocked.
    release();
  });

  it('blocks application messages while the MLS lock is held (auto-locked)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const release = await scheduler.acquireMlsLock();

    let processed = false;
    scheduler.enqueue(msg('group-a', 'a1')); // non-Welcome -> auto-locked by the drain
    const drainP = scheduler.drain(async () => {
      processed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(processed).toBe(false); // blocked behind the held lock

    release();
    await drainP;
    expect(processed).toBe(true);
  });

  it('processes group B while group A waits on Welcome (web mode)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
    scheduler.enqueue(msg('group-a', 'a1'));
    scheduler.enqueue(msg('group-b', 'b1'));

    const order: string[] = [];
    await scheduler.drain(async (m) => {
      order.push(m.groupId ?? '?');
      if (m.isWelcome && m.groupId) {
        scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
      }
    });

    expect(order[0]).toBe('group-a');
    expect(order).toContain('group-b');
    expect(order.indexOf('group-b')).toBeLessThan(order.lastIndexOf('group-a'));
  });

  it('round-robins across groups at each priority tier (tauri mode)', async () => {
    const scheduler = new MlsPerGroupScheduler('tauri');
    scheduler.enqueue(msg('g1', 'c', { type: 'group_reset' }));
    scheduler.enqueue(msg('g2', 'c', { type: 'group_reset' }));
    scheduler.enqueue(msg('g1', 'w', { isWelcome: true }));
    scheduler.enqueue(msg('g2', 'm'));

    const order: string[] = [];
    await scheduler.drain(async (m) => {
      if (m.type === 'group_reset') order.push(`reset-${m.groupId}`);
      else if (m.isWelcome) order.push(`welcome-${m.groupId}`);
      else order.push(`msg-${m.groupId}`);
    });

    expect(order[0]).toMatch(/^reset-/);
    expect(order[1]).toMatch(/^reset-/);
    expect(order[0]).not.toBe(order[1]);
    expect(order.some((x) => x.startsWith('welcome-'))).toBe(true);
    expect(order.some((x) => x.startsWith('msg-'))).toBe(true);
  });

  it('serializes concurrent drain under MLS lock', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    let concurrent = 0;
    let maxConcurrent = 0;

    scheduler.enqueue(msg('g1', 'a'));
    scheduler.enqueue(msg('g2', 'b'));

    await scheduler.drain(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
    });

    expect(maxConcurrent).toBe(1);
  });

  it('waitUntilIdle resolves after drain completes', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('g1', 'x'));

    const idle = scheduler.waitUntilIdle();
    await scheduler.drain(async () => {});
    await expect(idle).resolves.toBeUndefined();
    expect(scheduler.isIdle()).toBe(true);
  });

  it('serialises concurrent MLS lock acquires (no reentrant grant)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const order: string[] = [];

    const releaseA = await scheduler.acquireMlsLock();
    order.push('A-acquired');

    // B must NOT be granted while A holds the lock (would be a concurrency bug).
    let bAcquired = false;
    const bPromise = scheduler.acquireMlsLock().then((releaseB) => {
      bAcquired = true;
      order.push('B-acquired');
      return releaseB;
    });

    // Let any microtasks settle: B must still be blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(bAcquired).toBe(false);

    releaseA();
    const releaseB = await bPromise;
    expect(bAcquired).toBe(true);
    expect(order).toEqual(['A-acquired', 'B-acquired']);
    releaseB();
  });

  it('release is idempotent', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const release = await scheduler.acquireMlsLock();
    release();
    release(); // second call is a no-op, must not throw or double-release

    // Lock is free again: next acquire resolves promptly.
    const next = await scheduler.acquireMlsLock();
    next();
  });

  /**
   * WP-DRAIN-2. `isDraining` is lowered only when the whole drain has returned, so any await
   * inside it can freeze every inbound message with nothing in the log. Two different awaits have
   * already done that on production; what is pinned here is that a third one cannot do it in
   * silence, whichever phase it is in.
   *
   * The freeze itself is NOT fixed - deliberately, see `guarded` - so these tests assert the
   * REPORT, and the negative control (a healthy drain saying nothing) is what makes the report
   * mean anything.
   */
  describe('a frozen drain reports itself', () => {
    const STUCK_MS = 60_000;
    let errors: string[];

    beforeEach(() => {
      vi.useFakeTimers();
      errors = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const stuck = () => errors.filter((e) => e.includes('[QUEUE] STUCK'));

    it('names the message and the group when the handler never settles', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x', { queuedMessageId: 'q-42' }));

      // Never awaited: the whole point is that it never resolves.
      void scheduler.drain(() => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(STUCK_MS + 1);

      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]).toContain('processMessage');
      expect(stuck()[0]).toContain('group=group-a');
      expect(stuck()[0]).toContain('qId=q-42');
    });

    it('keeps reporting, because the elapsed time is the diagnosis', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x'));

      void scheduler.drain(() => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(STUCK_MS * 3 + 1);

      expect(stuck()).toHaveLength(3);
      expect(stuck()[2]).toContain('180s');
    });

    it('distinguishes waiting for the MLS lock from a hung handler', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      // Somebody outside the drain holds the mutex and never gives it back - WP-DRAIN-1's shape,
      // where a recovery awaited inside the callback re-entered the lock the drain already held.
      await scheduler.acquireMlsLock();
      scheduler.enqueue(msg('group-a', 'x'));

      let handlerRan = false;
      void scheduler.drain(async () => {
        handlerRan = true;
      });
      await vi.advanceTimersByTimeAsync(STUCK_MS + 1);

      expect(handlerRan).toBe(false);
      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]).toContain('mlsLock');
      expect(stuck()[0]).not.toContain('processMessage');
    });

    it('reports the FLUSH, which is the one await that cannot be moved out of the window', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x'));

      void scheduler.drain(async () => {}, { onDrainEnd: () => new Promise<void>(() => {}) });
      await vi.advanceTimersByTimeAsync(STUCK_MS + 1);

      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]).toContain('onDrainEnd');
      // The exclusion is still held - that is the freeze this line is reporting, not a bug in it.
      expect(scheduler.draining).toBe(true);
    });

    it('says nothing about a drain that completes', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x'));
      scheduler.enqueue(msg('group-b', 'y'));

      await scheduler.drain(async () => {}, { onDrainEnd: async () => {} });
      await vi.advanceTimersByTimeAsync(STUCK_MS * 2);

      expect(stuck()).toEqual([]);
      expect(scheduler.draining).toBe(false);
    });
  });

  /**
   * THE WELCOME BUFFER IS THE WORK THIS CLASS HOLDS OUTSIDE ITS QUEUES.
   *
   * A group's frames are parked while its Welcome is in flight so they are applied after the key
   * material that makes them readable. The window is opened by a Welcome and must be closed by that
   * same Welcome - RELEASING what it held, never discarding it. Two paths used to discard, both in
   * silence, and a live WebSocket frame need not carry the `queuedMessageId` a re-fetch would need
   * to bring it back.
   */
  describe('the Welcome buffering window', () => {
    /** Drains, releasing each group's buffer as its Welcome completes - the healthy shape. */
    const drainReleasing = (scheduler: MlsPerGroupScheduler, order: string[]) =>
      scheduler.drain(async (m) => {
        order.push(`${m.isWelcome ? 'welcome' : 'msg'}-${String.fromCharCode(m.ciphertext[0])}`);
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
      });

    it('parks a frame that arrives while its Welcome is in flight, and counts it as work', () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      // The frame is NOT in a queue - it is held - and both halves have to be true or the
      // assertions below could pass on a scheduler that simply queued it normally.
      expect(scheduler.getPendingCount()).toBe(1);
      expect(scheduler.getHeldCount()).toBe(1);
      expect(scheduler.isIdle()).toBe(false);
    });

    it('applies a parked frame after the Welcome, not before it', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      const order: string[] = [];
      await drainReleasing(scheduler, order);

      expect(order).toEqual(['welcome-w', 'msg-1']);
      expect(scheduler.isIdle()).toBe(true);
      expect(scheduler.getHeldCount()).toBe(0);
    });

    it('a second Welcome does not throw away what the first one was holding', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));
      // A re-add or a server re-delivery. This used to `set(groupId, [])` and drop frame 1.
      scheduler.enqueue(msg('group-a', 'W', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '2'));

      expect(scheduler.getHeldCount()).toBe(2);

      const order: string[] = [];
      await drainReleasing(scheduler, order);

      expect(order).toContain('msg-1');
      expect(order).toContain('msg-2');
      expect(scheduler.isIdle()).toBe(true);
    });

    it('re-queues rather than drops when the window closes on a FAILED Welcome', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      const order: string[] = [];
      await scheduler.drain(async (m) => {
        order.push(String.fromCharCode(m.ciphertext[0]));
        // What `BaseMlsService` does when the Welcome handler throws: the window closes, and what
        // it held goes back in the queue for the unknown-group seam to record and re-fetch.
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome failed');
      });

      expect(order).toEqual(['w', '1']);
      expect(scheduler.isIdle()).toBe(true);
    });
  });

  /**
   * The closing invariant, and it is a PROOF rather than a deadline: at the end of a drain that
   * emptied every queue, a surviving Welcome window has nothing left anywhere to close it. Its
   * frames would never be applied, and every later frame for that group would be parked behind it
   * for the life of the tab - the freeze `guarded` cannot see, because nothing is awaiting.
   */
  describe('a Welcome window nothing can close', () => {
    let errors: string[];

    beforeEach(() => {
      errors = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const stranded = () => errors.filter((e) => e.includes('Welcome buffering window survived'));

    it('is reported and released, naming the group and the count', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      // A handler that consumes the Welcome and never closes the window it opened.
      await scheduler.drain(async () => {});

      expect(stranded()).toHaveLength(1);
      expect(stranded()[0]).toContain('group-a');
      expect(stranded()[0]).toContain('holding 1 message(s)');
      // Released, not dropped: it is back in the queue for the restart guard to pick up.
      expect(scheduler.getHeldCount()).toBe(0);
      expect(scheduler.getPendingCount()).toBe(1);
    });

    it('says nothing when the Welcome closes its own window', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      await scheduler.drain(async (m) => {
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
      });

      expect(stranded()).toEqual([]);
      expect(scheduler.isIdle()).toBe(true);
    });

    it('says nothing about a drain with no Welcome in it at all', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', '1'));
      scheduler.enqueue(msg('group-b', '2'));

      await scheduler.drain(async () => {});

      expect(stranded()).toEqual([]);
      expect(scheduler.isIdle()).toBe(true);
    });
  });
  describe('the group-scoped barrier', () => {
    /**
     * ONE GROUP'S WORK FINISHES LONG BEFORE THE ACCOUNT'S, and that difference was three minutes.
     *
     * A device rejoining twenty-nine conversations reached whole-mailbox idle 189 s after a peer
     * asked it to describe ONE of them, and answered that long after the question. Frames for the
     * other twenty-eight cannot change that group's manifest, so the leg that describes it waits for
     * its own group and nothing else.
     */
    it('resolves for a group whose frames are applied, while others are still queued', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'a1'));
      for (let i = 0; i < 20; i += 1) scheduler.enqueue(msg(`group-${i}`, 'x'));

      let aIdleAfter: number | null = null;
      let applied = 0;
      const waiting = scheduler.waitUntilGroupIdle('group-a').then(() => {
        aIdleAfter = applied;
      });

      await scheduler.drain(async () => {
        applied += 1;
      });
      await waiting;

      expect(aIdleAfter).not.toBeNull();
      // It woke inside the drain, not at the end of it: `group-a` holds one frame of twenty-one.
      expect(aIdleAfter as unknown as number).toBeLessThan(21);
    });

    it('does NOT resolve while the drain is applying a frame of that group', async () => {
      // Out of its bucket and not yet applied is the one window a bucket-only check would miss.
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'a1'));

      let resolved = false;
      let sawInsideApply: boolean | null = null;
      const waiting = scheduler.waitUntilGroupIdle('group-a').then(() => {
        resolved = true;
      });

      await scheduler.drain(async () => {
        sawInsideApply = resolved;
        expect(scheduler.isGroupIdle('group-a')).toBe(false);
      });
      await waiting;

      expect(sawInsideApply).toBe(false);
      expect(resolved).toBe(true);
    });

    it('waits for the UNTAGGED bucket too, because nothing here can say whose it is', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue({ ...msg('group-a', 'o'), groupId: undefined });

      expect(scheduler.isGroupIdle('group-a')).toBe(false);

      await scheduler.drain(async () => {});

      expect(scheduler.isGroupIdle('group-a')).toBe(true);
    });

    it('resolves immediately for a group with nothing queued', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-b', 'b1'));

      expect(scheduler.isGroupIdle('group-a')).toBe(true);
      await expect(scheduler.waitUntilGroupIdle('group-a')).resolves.toBeUndefined();
    });

    it('does not strand a group whose frame THREW - the key is cleared either way', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'a1'));

      // The drain propagates it, which is the point: the `finally` still has to run.
      await expect(
        scheduler.drain(async () => {
          throw new Error('handler exploded');
        })
      ).rejects.toThrow('handler exploded');

      expect(scheduler.isGroupIdle('group-a')).toBe(true);
    });
  });
});
