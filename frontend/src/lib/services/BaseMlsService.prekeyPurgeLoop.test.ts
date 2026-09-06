// Same import-cycle break as the other BaseMlsService specs.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { fingerprintKeyPackage } from '$lib/mls-client/keyPackages';

/**
 * A DEVICE MUST NEVER PURGE A PREKEY IT JUST PUBLISHED ITSELF.
 *
 * Measured on the Mi 9T on 2026-09-06, in a run with zero `NoMatchingKeyPackage` and zero storms:
 *
 *     [MLS][Tauri] generateKeyPackage native batch path needed=49    (x3, plus one needed=50)
 *     [MLS] reconcilePublishedKeyPackages: purged 49/50 orphaned prekey(s)
 *
 * `needed=49` means the server held 1; the client published 49 to make 50; 49 were purged. So the
 * packages it threw away were the ones it had just minted, the pool never filled, and the next
 * connection minted 49 again - ~97 kB of bundles a round into a state nothing prunes below 84 days.
 * `mls.bin` grew 1.26 MB in a day and one checkpoint went from 17 s to 48 s.
 *
 * **WHY THE GUARD IS PROVENANCE AND NOT A PROPORTION.** A device restored from an older backup has
 * genuinely lost every private key it published, and purging 50 of 50 is exactly what this function
 * exists to do - so "too many orphans" cannot be the test without breaking the legitimate case. What
 * separates the loop from that case is that THIS PROCESS minted these bytes and therefore holds
 * their private key by construction. A `false` about one of them is not evidence about the server.
 */
type Published = { id: string; keyPackage: Uint8Array };

const kp = (n: number) => new Uint8Array([n, n + 1, n + 2]);

function makeCtx(
  published: Published[],
  hasPrivate: (k: Uint8Array) => boolean,
  publishedThisSession: Set<string>
) {
  const pruneOwnPrekeys = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      delivery: {
        listOwnPrekeys: vi.fn().mockResolvedValue(published),
        pruneOwnPrekeys,
      },
      keyPackageHasPrivate: vi.fn(async (k: Uint8Array) => hasPrivate(k)),
      publishedThisSession,
    },
    pruneOwnPrekeys,
  };
}

const reconcile = (ctx: unknown): Promise<void> =>
  (
    BaseMlsService.prototype as unknown as {
      reconcilePublishedKeyPackages(): Promise<void>;
    }
  ).reconcilePublishedKeyPackages.call(ctx);

describe('reconcilePublishedKeyPackages never undoes its own top-up', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('refuses to purge the 49 of 50 it just published, and ACCUSES instead of staying silent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mine = Array.from({ length: 49 }, (_, i) => kp(i));
    const stranger = kp(200);
    const session = new Set(mine.map(fingerprintKeyPackage));

    const { ctx, pruneOwnPrekeys } = makeCtx(
      [...mine, stranger].map((keyPackage, i) => ({ id: `id-${i}`, keyPackage })),
      // The broken seam: the device disowns everything, including its own fresh mints.
      () => false,
      session
    );
    await reconcile(ctx);

    // The stranger is a real orphan and still goes; the 49 own mints do not.
    expect(pruneOwnPrekeys).toHaveBeenCalledWith(['id-49']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED to purge 49/50'));
  });

  it('still purges EVERY prekey for a device restored from an older backup - the case the loop must not break', async () => {
    const published = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      keyPackage: kp(i),
    }));
    // Nothing was published by THIS process: a fresh process on a restored state.
    const { ctx, pruneOwnPrekeys } = makeCtx(published, () => false, new Set());
    await reconcile(ctx);

    expect(pruneOwnPrekeys).toHaveBeenCalledWith(published.map((p) => p.id));
  });

  it('purges nothing when the device backs everything, own mints included', async () => {
    const published = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${i}`,
      keyPackage: kp(i),
    }));
    const { ctx, pruneOwnPrekeys } = makeCtx(
      published,
      () => true,
      new Set(published.map((p) => fingerprintKeyPackage(p.keyPackage)))
    );
    await reconcile(ctx);

    expect(pruneOwnPrekeys).not.toHaveBeenCalled();
  });

  it('fingerprints by bytes AND length, so a shorter package sharing a prefix is a different package', () => {
    expect(fingerprintKeyPackage(new Uint8Array([1, 2, 3]))).toBe(
      fingerprintKeyPackage(new Uint8Array([1, 2, 3]))
    );
    expect(fingerprintKeyPackage(new Uint8Array([1, 2, 3]))).not.toBe(
      fingerprintKeyPackage(new Uint8Array([1, 2]))
    );
  });
});
