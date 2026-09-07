import {
  tagMlsSnapshot,
  propagateMlsSnapshotVersion,
  mlsSnapshotVersion,
  seedMlsSnapshotSeq,
  saveMlsStateEncrypted,
  loadMlsState,
  MLS_STATE_ENCRYPTED_KEY,
  MLS_STATE_VERSION_KEY,
} from './hex';

// Tauri runtime detection must be false so saveMlsStateEncrypted takes the IndexedDB path.
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => false }));

/**
 * Minimal in-memory IndexedDB fake covering the single-store read-modify-write the MLS
 * persistence uses: one object store, get/put by key, ordered request callbacks, tx.oncomplete.
 * Faithful enough to exercise the write-if-newer guard without pulling in fake-indexeddb.
 */
function installFakeIndexedDb(): Map<string, unknown> {
  const store = new Map<string, unknown>();

  function makeStore() {
    return {
      get(key: string) {
        const req: {
          result: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = { result: undefined, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          req.result = store.get(key);
          req.onsuccess?.();
        });
        return req;
      },
      put(value: unknown, key: string) {
        store.set(key, value);
        return { onsuccess: null, onerror: null };
      },
      delete() {
        return { onsuccess: null, onerror: null };
      },
    };
  }

  function makeTx() {
    const tx: {
      objectStore: () => ReturnType<typeof makeStore>;
      oncomplete: (() => void) | null;
      onerror: (() => void) | null;
    } = { objectStore: makeStore, oncomplete: null, onerror: null };
    // Complete after pending get microtasks so onsuccess handlers run first.
    queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
    return tx;
  }

  vi.stubGlobal('indexedDB', {
    open() {
      const req: {
        result: { transaction: () => ReturnType<typeof makeTx>; createObjectStore: () => void };
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: { transaction: makeTx, createObjectStore: () => {} },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  });

  return store;
}

describe('MLS snapshot versioning helpers', () => {
  it('tags snapshots with a strictly increasing version', () => {
    const a = tagMlsSnapshot(new Uint8Array([1]));
    const b = tagMlsSnapshot(new Uint8Array([2]));
    const va = mlsSnapshotVersion(a)!;
    const vb = mlsSnapshotVersion(b)!;
    expect(vb).toBeGreaterThan(va);
  });

  it('propagates a version from a plain snapshot to its encrypted bytes', () => {
    const plain = tagMlsSnapshot(new Uint8Array([1]));
    const encrypted = new Uint8Array([9, 9]);
    propagateMlsSnapshotVersion(plain, encrypted);
    expect(mlsSnapshotVersion(encrypted)).toBe(mlsSnapshotVersion(plain));
  });

  it('returns undefined for untagged bytes', () => {
    expect(mlsSnapshotVersion(new Uint8Array([7]))).toBeUndefined();
  });

  it('seedMlsSnapshotSeq raises the counter so the next tag exceeds the seed', () => {
    seedMlsSnapshotSeq(1_000_000);
    const tagged = tagMlsSnapshot(new Uint8Array([0]));
    expect(mlsSnapshotVersion(tagged)!).toBeGreaterThan(1_000_000);
  });
});

describe('saveMlsStateEncrypted write-if-newer (IndexedDB)', () => {
  let store: Map<string, unknown>;

  // The module caches its IDBDatabase promise, so the fake must be installed once and the backing
  // store cleared between tests rather than reinstalled (a new store would be orphaned).
  beforeAll(() => {
    store = installFakeIndexedDb();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    store.clear();
    seedMlsSnapshotSeq(2_000_000); // isolate versions from the helper tests above
  });

  it('writes a newer tagged snapshot and records its version', async () => {
    const fresh = tagMlsSnapshot(new Uint8Array([1, 2, 3]));
    await saveMlsStateEncrypted('user-1', fresh);
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.get(MLS_STATE_VERSION_KEY)).toBe(mlsSnapshotVersion(fresh));
  });

  it('skips a stale write whose version is not newer than the stored one', async () => {
    const older = tagMlsSnapshot(new Uint8Array([1]));
    const newer = tagMlsSnapshot(new Uint8Array([2]));
    // The newer snapshot reaches disk first; the older (slower) flush must then be skipped.
    await saveMlsStateEncrypted('user-1', newer);
    await saveMlsStateEncrypted('user-1', older);
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([2]));
    expect(store.get(MLS_STATE_VERSION_KEY)).toBe(mlsSnapshotVersion(newer));
  });

  /**
   * THE CASE TWO TABS PRODUCE, AND THE ONE THE GUARD USED TO CALL "STALE".
   *
   * `_snapshotSeq` is a PER-DOCUMENT counter seeded from the stored version on load, so within one
   * document it only ever goes up and equality is impossible. Equality therefore means a SECOND
   * writer - another tab - reached the same number from the same seed. Nothing is stale: the two
   * counters are simply not comparable.
   *
   * TAB-4 drives two tabs of one client and makes this fire on an ordinary run (measured 2026-09-05,
   * `v3294 <= stored v3294`), which is what turned the line into one a reader learns to skip.
   */
  it('drops a colliding write from a second writer, and does not call it stale', async () => {
    const mine = tagMlsSnapshot(new Uint8Array([1]));
    // The other tab's bytes, carrying the SAME version - what two seeds from one stored value give.
    const theirs = propagateMlsSnapshotVersion(mine, new Uint8Array([9, 9]));
    await saveMlsStateEncrypted('user-1', mine);

    const said: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void said.push(a.join(' ')));
    await saveMlsStateEncrypted('user-1', theirs);
    spy.mockRestore();

    // The write is dropped - that is the existing behaviour and this test does not change it.
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([1]));
    expect(store.get(MLS_STATE_VERSION_KEY)).toBe(mlsSnapshotVersion(mine));
    // What it must not do is describe a collision as staleness.
    expect(said.join('\n')).toContain('collides');
    expect(said.join('\n')).not.toContain('stale');
  });

  /**
   * ON `console.warn` RATHER THAN `console.log`, and that is the point of the assertion.
   *
   * Two captures of one document were in flight at once. Unlike the collision above - two tabs,
   * whose counters are simply not comparable - this one says the SAME writer's own flushes finished
   * out of order, which is a race and not a fact of life. A line at `log` level is one a reader
   * skips; this one has to accuse, because the fix is upstream of it.
   */
  it('and a genuinely OLDER write reads as stale, accuses, and names both writers', async () => {
    const older = tagMlsSnapshot(new Uint8Array([1]), 'the-old-path');
    const newer = tagMlsSnapshot(new Uint8Array([2]), 'the-new-path');
    await saveMlsStateEncrypted('user-1', newer);

    const said: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a) => void said.push(a.join(' ')));
    await saveMlsStateEncrypted('user-1', older);
    spy.mockRestore();

    expect(said.join('\n')).toContain('stale');
    expect(said.join('\n')).toContain('<');
    expect(said.join('\n')).not.toContain('collides');
    // WHICH TWO PATHS OVERLAPPED IS THE FINDING. Without both names the line states an outcome and
    // hides the question, which is how it sat in the campaign's dirt for two days unattributed.
    expect(said.join('\n')).toContain('the-old-path');
    expect(said.join('\n')).toContain('the-new-path');
  });

  /**
   * A VERSION MUST CROSS AN AWAIT BY PROPAGATION, NEVER BY A FRESH TAG.
   *
   * The key-package path handed a snapshot to a worker, kept it for up to 30 s, and tagged the
   * result when it came back - dating a stale capture to now. A checkpoint captured DURING that
   * window then carried a lower number and was refused against it, so the guard dropped the fresher
   * state and kept the older one. This pins the shape rather than the call site.
   */
  it('a derived blob tagged AFTER an await outranks a fresher capture - propagation is the fix', async () => {
    const captured = tagMlsSnapshot(new Uint8Array([1]), 'slow-path capture');
    // ... time passes, and a checkpoint of genuinely newer state is captured and written ...
    const fresher = tagMlsSnapshot(new Uint8Array([2]), 'checkpoint');
    await saveMlsStateEncrypted('user-1', fresher);

    // The wrong way: the slow path's result is numbered when it comes back.
    const lateTagged = tagMlsSnapshot(new Uint8Array([3]), 'slow-path result');
    expect(mlsSnapshotVersion(lateTagged)!).toBeGreaterThan(mlsSnapshotVersion(fresher)!);
    await saveMlsStateEncrypted('user-1', lateTagged);
    // The older state won, which is exactly the inversion the guard exists to prevent.
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([3]));

    // The right way: the result carries the CAPTURE's number, so the fresher checkpoint outranks it.
    const propagated = propagateMlsSnapshotVersion(captured, new Uint8Array([4]));
    expect(mlsSnapshotVersion(propagated)!).toBeLessThan(mlsSnapshotVersion(fresher)!);
  });

  it('always writes untagged bytes (restore / migration have no concurrency)', async () => {
    await saveMlsStateEncrypted('user-1', new Uint8Array([5, 5]));
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([5, 5]));
  });

  it('loadMlsState seeds the counter from the stored version', async () => {
    const tagged = tagMlsSnapshot(new Uint8Array([8]));
    await saveMlsStateEncrypted('user-2', tagged);
    const storedVersion = store.get(MLS_STATE_VERSION_KEY) as number;
    await loadMlsState('user-2');
    // After seeding from the stored version, the next tag must exceed it.
    const next = tagMlsSnapshot(new Uint8Array([9]));
    expect(mlsSnapshotVersion(next)!).toBeGreaterThan(storedVersion);
  });
});
