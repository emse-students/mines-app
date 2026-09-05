/**
 * THE PROFILE CACHE, AND THE ONE DISTINCTION IT USED NOT TO MAKE.
 *
 * `fetchUserProfile` deduplicates for thirty seconds and used to evict on EVERY rejection, with the
 * stated reason "so the next caller retries rather than receiving the same cached error". That is
 * right for a dead radio and wrong for a 404: the account does not exist, and asking again inside
 * the same thirty seconds cannot make one. Measured on the local estate 2026-09-04 - one channel
 * message mentioning an absent account produced three identical `GET /api/users/<id> -> 404` in a
 * single check, one per mount of the mention chip, in every check that opened that conversation.
 *
 * Both halves are pinned here because they are opposite dispositions of the same `catch`, and a
 * test for only one of them would pass on the code that treats every failure alike.
 */
describe('fetchUserProfile', () => {
  /**
   * EVERY CASE RE-IMPORTS THE MODULE GRAPH, and under the full suite that is what runs out of time.
   *
   * `load` calls `vi.resetModules()` and imports `./user` again so each case gets its own cache -
   * which is the point of the file - and that import is cheap alone and slow on a contended worker.
   * Three cases here timed out at the 5 s default while passing in under two seconds on their own.
   * The bound is about the IMPORT, not about anything the cache does.
   */
  const IMPORT_HEAVY_MS = 20_000;

  const load = async (apiFetch: ReturnType<typeof vi.fn>) => {
    vi.resetModules();
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));
    vi.doMock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://example.test' }));
    return import('./user');
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    // THE CACHE IS KEYED ON `Date.now()` AND THE WINDOW IS THIRTY SECONDS, so a case asserting "one
    // request for three callers" is asserting that three awaited rejections happen inside it. That
    // held every time this file ran alone and failed twice in the full suite, where a worker under
    // contention can be descheduled for longer than the window it is standing in - the flake was the
    // wall clock, not the cache. Frozen here so the assertion is about the code (durable-rules:
    // never assert a wall clock in a test).
    // ONLY `Date`. Faking every timer stalled the suite - the module's own awaits never resolved
    // and each case timed out at 5 s. The cache reads a CLOCK, not a timer, so that is the only
    // thing that has to hold still.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'asks ONCE for a user the server says does not exist',
    async () => {
      const apiFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const mod = await load(apiFetch);

      await expect(mod.fetchUserProfile('gone')).rejects.toThrow();
      await expect(mod.fetchUserProfile('gone')).rejects.toThrow();
      await expect(mod.fetchUserProfile('gone')).rejects.toThrow();

      // The answer is cached exactly like a successful one: three callers, one request.
      expect(apiFetch).toHaveBeenCalledTimes(1);
    },
    IMPORT_HEAVY_MS
  );

  it(
    'asks AGAIN after a failure to reach the server, which answered nothing',
    async () => {
      // A throw with no response at all is the case the eviction was written for, and it keeps it.
      const apiFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const mod = await load(apiFetch);

      await expect(mod.fetchUserProfile('unreachable')).rejects.toThrow();
      await expect(mod.fetchUserProfile('unreachable')).rejects.toThrow();

      expect(apiFetch).toHaveBeenCalledTimes(2);
    },
    IMPORT_HEAVY_MS
  );

  it(
    'asks again after a 500, which is the server failing rather than answering',
    async () => {
      const apiFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const mod = await load(apiFetch);

      await expect(mod.fetchUserProfile('flaky')).rejects.toThrow();
      await expect(mod.fetchUserProfile('flaky')).rejects.toThrow();

      expect(apiFetch).toHaveBeenCalledTimes(2);
    },
    IMPORT_HEAVY_MS
  );

  it(
    'carries the status as a field, so no caller reads it back out of a sentence',
    async () => {
      const apiFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const mod = await load(apiFetch);

      const err = await mod.fetchUserProfile('gone').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(mod.UserProfileFetchError);
      expect((err as InstanceType<typeof mod.UserProfileFetchError>).status).toBe(404);
      expect(mod.isAbsentUserError(err)).toBe(true);
    },
    IMPORT_HEAVY_MS
  );

  it(
    'calls nothing but a 404 an absent user',
    async () => {
      const apiFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const mod = await load(apiFetch);

      expect(mod.isAbsentUserError(new mod.UserProfileFetchError(500))).toBe(false);
      expect(mod.isAbsentUserError(new mod.UserProfileFetchError(401))).toBe(false);
      expect(mod.isAbsentUserError(new mod.UserProfileFetchError(403))).toBe(false);
      // Not every 404 in the app is this one: only a refusal typed at THIS throw counts.
      expect(mod.isAbsentUserError(new Error('404'))).toBe(false);
      expect(mod.isAbsentUserError(null)).toBe(false);
    },
    IMPORT_HEAVY_MS
  );
});
