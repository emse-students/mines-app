/** The slice of the WASM client {@link mintKeyPackages} needs. */
export interface KeyPackageMinter {
  generate_last_resort_key_package(): Uint8Array;
  generate_key_packages(count: number): unknown;
}

/** A device's published key material: one reusable fallback plus the one-time pool. */
export interface MintedKeyPackages {
  fallback: Uint8Array;
  poolPackages: Uint8Array[];
}

/**
 * Mints the two kinds of KeyPackage a device publishes, and it is the ONLY place that decides
 * which is which.
 *
 * The distinction is not cosmetic. The delivery service pops a one-time prekey when the pool has
 * one and otherwise returns the device's static row - the same bytes, to every caller, until the
 * next connection replaces it. MLS deletes an ordinary KeyPackage's private bundle as soon as a
 * Welcome built on it is processed, so a static row that is not marked last-resort can open
 * exactly one group and then locks the device out of every other group that was served it. Four
 * call sites used to mint the fallback (the worker, its two recovery branches and the main-thread
 * path); a fifth would have been one more chance to mint the wrong kind.
 */
export function mintKeyPackages(client: KeyPackageMinter, needed: number): MintedKeyPackages {
  const fallback = client.generate_last_resort_key_package();
  const poolPackages =
    needed > 0 ? [...(client.generate_key_packages(needed) as Iterable<Uint8Array>)] : [];
  return { fallback, poolPackages };
}
