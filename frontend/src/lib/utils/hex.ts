import { isTauriRuntime } from '$lib/utils/openExternal';

/** Converts a Uint8Array to a lowercase hex string (e.g. `Uint8Array([0xde,0xad])` → `"dead"`). */
export function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Null-safe hex conversion - returns '' for null/undefined/empty buffers. */
export function bytesToHex(bytes?: Uint8Array | null): string {
  return bytes && bytes.length > 0 ? toHex(bytes) : '';
}
/** Parses a lowercase or uppercase hex string into a Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Decodes a standard base64 string back to a Uint8Array. */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes a Uint8Array as a standard base64 string. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const B64_PREFIX = 'b64:';

// ── IndexedDB storage for MLS state ──────────────────────────────────────────
// IndexedDB has no meaningful size limit (typically GBs), unlike localStorage
// which is capped at ~5 MB. The MLS state blob grows with group count and
// prekey pool size, so we store it as raw binary here.

// Separate DB from the message/conversation DB to avoid version conflicts
const IDB_NAME = `CanariDBMls_`;
const IDB_STORE = 'state';

/** IndexedDB key for PIN-encrypted MLS state (loaded at login). */
export const MLS_STATE_ENCRYPTED_KEY = 'mls_autosave';
/** IndexedDB key for the monotonic write version guarding against stale overwrites. */
export const MLS_STATE_VERSION_KEY = 'mls_autosave_ver';
/** @deprecated Legacy plain autosave key — purged on load; never written anymore. */
const MLS_STATE_PLAIN_KEY_LEGACY = 'mls_autosave_plain';

// Monotonic snapshot versioning (write-if-newer). The live MLS client is epoch-monotonic, so a
// snapshot taken later never reflects a staler state than an earlier one. Tagging each snapshot
// with an increasing version at the synchronous capture moment, and refusing any IDB write whose
// version is not strictly newer than what is stored, prevents a slow off-thread encryption from
// overwriting a fresher concurrent write (which would silently regress the persisted epoch). The
// version travels with the bytes via a WeakMap, so the async Argon2 step cannot reorder it. Only a
// plain integer is persisted at rest - no groupId/epoch - so privacy is unchanged.
let _snapshotSeq = 0;
const _snapshotVersions = new WeakMap<Uint8Array, { seq: number; writer: string }>();

/**
 * WHO WROTE LAST, so a refusal can name BOTH sides of the race it just resolved.
 *
 * A guard that says "v134 lost to v135" states the outcome and hides the question. The campaign
 * carried that line as unexplained dirt on four HEAL-REVOKE rows for two days, and it could not be
 * attributed because nothing recorded which code path either number belonged to. A refusal is only
 * a lead if it names the two paths that overlapped.
 *
 * A module global is the right scope: the version counter is one too, both describe THIS document's
 * writers, and a second tab's writes are a different case the equality branch below already
 * separates.
 */
let _lastAcceptedWriter = '(nothing yet this session)';

/**
 * Tags `bytes` with the next monotonic snapshot version and returns the same reference.
 *
 * MUST BE CALLED IN THE SAME SYNCHRONOUS TURN AS THE CAPTURE THAT PRODUCED `bytes`. The number
 * orders CAPTURES, so tagging after an await gives a stale snapshot a fresh number and inverts the
 * ordering it exists to establish - see `propagateMlsSnapshotVersion` for the one legitimate way to
 * carry a version across an async transformation.
 *
 * @param writer which code path captured this - it is what a refusal will name.
 */
export function tagMlsSnapshot(bytes: Uint8Array, writer = 'unnamed'): Uint8Array {
  _snapshotVersions.set(bytes, { seq: ++_snapshotSeq, writer });
  return bytes;
}

/**
 * Copies the snapshot version from `from` to `to`, for bytes DERIVED from an already-tagged capture.
 *
 * THIS IS HOW A VERSION CROSSES AN AWAIT HONESTLY. `to` is a transformation of `from` - re-encrypted,
 * or returned by a worker that was handed `from` - so it describes the state as of `from`'s capture
 * and must carry `from`'s number. Tagging `to` afresh instead dates a stale snapshot to now, which
 * is the inversion the ordering exists to prevent.
 */
export function propagateMlsSnapshotVersion(from: Uint8Array, to: Uint8Array): Uint8Array {
  const v = _snapshotVersions.get(from);
  if (v !== undefined) _snapshotVersions.set(to, v);
  return to;
}

/** Which code path captured `bytes`, or undefined if they were never tagged. */
export function mlsSnapshotWriter(bytes: Uint8Array): string | undefined {
  return _snapshotVersions.get(bytes)?.writer;
}

/** Returns the snapshot version tagged onto `bytes`, or undefined if the bytes were never tagged. */
export function mlsSnapshotVersion(bytes: Uint8Array): number | undefined {
  return _snapshotVersions.get(bytes)?.seq;
}

/**
 * Raises the snapshot counter to at least `version`.
 * The counter resets on page reload while the stored version does not, so a fresh session must
 * seed from the persisted version or its first writes would look stale and be skipped.
 */
export function seedMlsSnapshotSeq(version: number | undefined): void {
  if (version !== undefined && version > _snapshotSeq) _snapshotSeq = version;
}

let _dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Closes this module's cached handle on `CanariDBMls_<userId>`, so a later delete can complete.
 *
 * IT IS THE ONE CONNECTION NO CALLER CAN REACH, AND THAT IS WHY IT SURVIVED EVERY WIPE. `_dbPromise`
 * is a module singleton opened on first use and never released; `removeMlsState` REOPENS it, and it
 * is the last thing a revoked device does before `wipeDeviceToFactory` tries to drop the database.
 * `indexedDB.deleteDatabase` does not fail on an open connection, it BLOCKS - so the wipe logged
 * `CanariDBMls_... is still open elsewhere - delete deferred`, reported two stores SURVIVED, and a
 * device its owner had declared lost kept its MLS store. Measured on prod by HEAL-REVOKE-5,
 * 2026-08-29; every other surface said the wipe had worked.
 *
 * `close()` returns immediately and the connection ends once its open transactions finish, so this
 * is awaited on the handle rather than on the close: what the caller needs is that no NEW
 * transaction can be started, which nulling the cache guarantees.
 */
export async function closeMlsDb(): Promise<void> {
  const pending = _dbPromise;
  _dbPromise = null;
  if (!pending) return;
  // A handle that never opened has nothing to close, and its rejection is not this function's to
  // report - the caller that asked for it already logged one.
  await pending.then((db) => db.close()).catch(() => undefined);
}

function openMlsDb(userId: string): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME + userId, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        _dbPromise = null;
        reject(req.error);
      };
    });
  }
  return _dbPromise;
}

/**
 * Persist the MLS state blob for `userId` in IndexedDB.
 * Stores raw bytes - no base64 overhead.
 */
/** Persists the PIN-encrypted MLS checkpoint (Argon2 + ChaCha20). Used at login and on critical flush. */
export async function saveMlsStateEncrypted(userId: string, bytes: Uint8Array): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_mls_state', { data: Array.from(bytes) });
      return;
    } catch (e) {
      console.warn('[MLS] save_mls_state failed:', e);
      throw e;
    }
  }

  const version = mlsSnapshotVersion(bytes);
  const db = await openMlsDb(userId);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const verReq = store.get(MLS_STATE_VERSION_KEY);
    verReq.onsuccess = () => {
      const stored = (verReq.result as number | undefined) ?? 0;
      // A tagged write older than or equal to what is stored is a stale flush - skip it so a slow
      // encrypted checkpoint cannot clobber a fresher concurrent write. Untagged writes (restore,
      // migration) have no concurrency and always land.
      //
      // TWO CASES, AND THEY ARE NOT THE SAME EVENT. `_snapshotSeq` is a PER-DOCUMENT counter seeded
      // from the stored version on load, so:
      //
      //   version < stored   one of THIS document's own flushes finished out of order - exactly what
      //                      the guard was written for, and worth a line.
      //   version === stored two writers seeded from the same stored value both produced this
      //                      number. Within one document that cannot happen (the counter only goes
      //                      up), so it means a SECOND writer - another tab. Nothing is stale; the
      //                      two are simply not comparable, and this write is dropped.
      //
      // One sentence covered both and called both "stale". TAB-4 (two tabs of one client) makes the
      // equality case fire on an ordinary run - measured 2026-09-05, `v3294 <= stored v3294` - so the
      // line was one a reader learns to skip, which is the one that hides the next defect. Whether
      // dropping the second tab's write can lose state is a real question and is P2 in `backlog.md`;
      // it is not answered by the wording, but it is no longer hidden by it.
      // NAMES BOTH PATHS, because a refusal that states only the outcome cannot be acted on. The
      // two writers ARE the finding: this line is the visible end of two captures overlapping, and
      // which two decides whether the overlap is legitimate coalescing or an ordering inversion.
      const mine = mlsSnapshotWriter(bytes) ?? 'unnamed';
      if (version !== undefined && version < stored) {
        console.warn(
          `[MLS] Skipping stale MLS state write (v${version} < stored v${stored}) - this write came ` +
            `from ${mine}, the stored one from ${_lastAcceptedWriter}. Two captures were in flight ` +
            `at once; if either tagged itself after an await, the numbers do not order the captures`
        );
        return;
      }
      if (version !== undefined && version === stored) {
        console.log(
          `[MLS] Snapshot v${version} collides with the stored one - another writer reached this ` +
            `version from the same seed, so the two are not comparable; not writing (this write ` +
            `from ${mine})`
        );
        return;
      }
      store.put(bytes, MLS_STATE_ENCRYPTED_KEY);
      if (version !== undefined) {
        store.put(version, MLS_STATE_VERSION_KEY);
        _lastAcceptedWriter = mine;
      }
    };
    verReq.onerror = () => reject(verReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Removes a legacy plain MLS snapshot if present (pre-option-2 installs). */
export async function purgeLegacyPlainMlsState(userId: string): Promise<void> {
  if (isTauriRuntime()) return;

  const db = await openMlsDb(userId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(MLS_STATE_PLAIN_KEY_LEGACY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** @deprecated Alias for {@link saveMlsStateEncrypted}. */
export async function saveMlsState(userId: string, bytes: Uint8Array): Promise<void> {
  return saveMlsStateEncrypted(userId, bytes);
}

/**
 * Load the MLS state blob for `userId` from IndexedDB.
 *
 * Includes a one-time migration: if the key is absent in IDB but present in
 * localStorage (old format), the data is migrated automatically and the
 * localStorage entry is removed.
 */
export async function loadMlsState(userId: string): Promise<Uint8Array | null> {
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<number[] | null>('load_mls_state');
      if (res && Array.isArray(res) && res.length > 0) return Uint8Array.from(res);
      return null;
    } catch (e) {
      console.warn('[MLS] load_mls_state failed:', e);
      return null;
    }
  }

  const db = await openMlsDb(userId);
  const idbResult = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(MLS_STATE_ENCRYPTED_KEY);
    const verReq = store.get(MLS_STATE_VERSION_KEY);
    tx.oncomplete = () => {
      // Seed this session's counter above the persisted version so the first flush is not
      // mistaken for stale (the in-memory counter resets on reload; the stored version does not).
      seedMlsSnapshotSeq(verReq.result as number | undefined);
      resolve((req.result as Uint8Array) ?? null);
    };
    tx.onerror = () => reject(tx.error);
  });
  if (idbResult) {
    void purgeLegacyPlainMlsState(userId).catch(() => {});
    return idbResult;
  }

  // Migration path: read legacy localStorage entry, move it to IDB, erase from localStorage.
  const saved = localStorage.getItem('mls_autosave_' + userId);
  if (!saved) return null;
  const bytes = saved.startsWith(B64_PREFIX)
    ? fromBase64(saved.slice(B64_PREFIX.length))
    : fromHex(saved);
  await saveMlsState(userId, bytes);
  localStorage.removeItem('mls_autosave_' + userId);
  return bytes;
}

/** Remove the MLS state for `userId` from IndexedDB (and legacy localStorage). */
export async function removeMlsState(userId: string): Promise<void> {
  // Remove legacy localStorage entry always
  try {
    localStorage.removeItem('mls_autosave_' + userId);
  } catch {
    /* ignore */
  }

  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_mls_state');
    } catch (e) {
      console.warn('[MLS] delete_mls_state failed:', e);
    }
    return;
  }

  const db = await openMlsDb(userId);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(MLS_STATE_ENCRYPTED_KEY);
    tx.objectStore(IDB_STORE).delete(MLS_STATE_PLAIN_KEY_LEGACY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Loads the MLS state and returns it as a hex string for use in backup/export files. Returns `undefined` if no state is stored. */
export async function exportMlsStateAsHex(userId: string): Promise<string | undefined> {
  const bytes = await loadMlsState(userId);
  return bytes ? toHex(bytes) : undefined;
}
