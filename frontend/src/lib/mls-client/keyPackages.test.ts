import { mintKeyPackages } from './keyPackages';

/**
 * `replenishKeyPackages` was tested here until 2026-09-06 and deleted with these tests: it wrapped
 * `mlsService.generateKeyPackage` in one line, its docblock called itself "a single entry point for
 * the connection layer", and the connection layer called the service directly. Its only caller was
 * this file.
 */
function makeClient() {
  return {
    generate_last_resort_key_package: vi.fn(() => new Uint8Array([0xfa])),
    generate_key_packages: vi.fn((n: number) =>
      Array.from({ length: n }, (_, i) => new Uint8Array([i]))
    ),
  };
}

describe('mintKeyPackages', () => {
  it('mints the fallback as LAST RESORT, which is the whole reason this helper exists', () => {
    const client = makeClient();
    const { fallback } = mintKeyPackages(client, 0);
    expect(client.generate_last_resort_key_package).toHaveBeenCalledTimes(1);
    // The ordinary minter must not have been touched for the fallback: the delivery service serves
    // that one package to every peer that finds the pool empty, and MLS deletes an ordinary
    // package's private bundle at the first Welcome built on it.
    expect(client.generate_key_packages).not.toHaveBeenCalled();
    expect(fallback).toEqual(new Uint8Array([0xfa]));
  });

  it('mints the pool as ORDINARY one-time prekeys', () => {
    const client = makeClient();
    const { poolPackages } = mintKeyPackages(client, 3);
    expect(client.generate_key_packages).toHaveBeenCalledWith(3);
    expect(poolPackages).toHaveLength(3);
  });

  it('asks for no pool at all when the server already holds enough', () => {
    const client = makeClient();
    const { poolPackages } = mintKeyPackages(client, 0);
    expect(client.generate_key_packages).not.toHaveBeenCalled();
    expect(poolPackages).toEqual([]);
  });

  it('materialises the pool, which the WASM layer returns as a lazy js_sys::Array', () => {
    const client = makeClient();
    const { poolPackages } = mintKeyPackages(client, 2);
    expect(Array.isArray(poolPackages)).toBe(true);
    expect(poolPackages[0]).toBeInstanceOf(Uint8Array);
  });
});
