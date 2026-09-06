const migrateLegacyMlsStateBlob = vi.hoisted(() => vi.fn());
const saveMlsState = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn(),
  migrateLegacyMlsStateBlob,
}));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveMlsState,
}));

import { WebMlsService } from './WebMlsService';

const SEALED = new Error('Decryption: aead::Error');
const MISMATCH = new Error(
  'Credential identity mismatch: expected u:web-u-new but state contains u:web-u-old'
);

/**
 * Drives `_initImpl` against stubbed primitives. Only the members it touches are provided, so a
 * new dependency shows up as an explicit failure rather than a silent pass.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: '',
    deviceId: 'web-u-new',
    delivery: { userId: '', deviceId: '' },
    freshStart: false,
    resolveDeviceId: vi.fn().mockResolvedValue('web-u-new'),
    loadStateWithKey: vi.fn().mockResolvedValue(undefined),
    classifyStateLoadFailure: WebMlsService.prototype['classifyStateLoadFailure'],
    generateDeviceId: vi.fn().mockReturnValue('web-u-fresh'),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([7])),
    deleteDevice: vi.fn().mockResolvedValue(undefined),
    // Real implementations, not mocks: the fresh-start assertions below (new id persisted, old
    // device deleted) are assertions ABOUT the rotation, so stubbing it would test nothing.
    rotateDeviceIdentity: WebMlsService.prototype['rotateDeviceIdentity'],
    // BOTH HALVES OF THE CHECKPOINT, for the same reason. `persistCheckpoint` is concrete in
    // `BaseMlsService` and carries the send-ledger pairing; `writeCheckpoint` is the platform half
    // it delegates to. Stubbing either would test the rotation against a checkpoint that is not the
    // one production runs.
    persistCheckpoint: WebMlsService.prototype['persistCheckpoint'],
    writeCheckpoint: WebMlsService.prototype['writeCheckpoint'],
    ...overrides,
  };
}

const initImpl = (
  ctx: unknown,
  state?: Uint8Array,
  opts?: { noFreshStart?: boolean; legacyPin?: string }
): Promise<void> =>
  (
    WebMlsService.prototype as unknown as {
      _initImpl(u: string, k: string, s?: Uint8Array, o?: unknown): Promise<void>;
    }
  )._initImpl.call(ctx, 'u', 'key-b64', state, opts);

describe('WebMlsService._initImpl legacy migration', () => {
  const stored = new Uint8Array([1, 2, 3]);
  const resealed = new Uint8Array([4, 5, 6]);

  beforeEach(() => {
    migrateLegacyMlsStateBlob.mockReset();
    saveMlsState.mockClear();
    localStorage.clear();
  });

  it('re-seals a legacy snapshot, loads it and persists it', async () => {
    const ctx = makeCtx({
      loadStateWithKey: vi.fn().mockRejectedValueOnce(SEALED).mockResolvedValueOnce(undefined),
    });
    migrateLegacyMlsStateBlob.mockResolvedValue(resealed);

    await initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' });

    expect(ctx.loadStateWithKey).toHaveBeenNthCalledWith(2, 'key-b64', resealed);
    expect(saveMlsState).toHaveBeenCalledWith('u', resealed);
    // The device identity survives a migration - nothing was discarded.
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(ctx.deviceId).toBe('web-u-new');
  });

  it('falls back to a fresh start when the migrated snapshot names another device', async () => {
    // The regression this guards: the second load lives inside the first catch, so its mismatch
    // used to escape init entirely and surfaced as a raw "Credential identity mismatch" instead
    // of the fresh start that actually resolves it.
    const ctx = makeCtx({
      loadStateWithKey: vi
        .fn()
        .mockRejectedValueOnce(SEALED)
        .mockRejectedValueOnce(MISMATCH)
        .mockResolvedValueOnce(undefined),
    });
    migrateLegacyMlsStateBlob.mockResolvedValue(resealed);

    await expect(
      initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' })
    ).resolves.toBeUndefined();

    // A mismatch is not repairable by any PIN, so noFreshStart must NOT hold it back.
    expect(ctx.generateDeviceId).toHaveBeenCalled();
    expect(localStorage.getItem('mls_device_id_u')).toBe('web-u-fresh');
    expect(ctx.deleteDevice).toHaveBeenCalledWith('u', 'web-u-new');
  });

  it('still offers old-PIN recovery when the blob is not a legacy envelope', async () => {
    const ctx = makeCtx({ loadStateWithKey: vi.fn().mockRejectedValue(SEALED) });
    migrateLegacyMlsStateBlob.mockResolvedValue(null);

    await expect(initImpl(ctx, stored, { noFreshStart: true, legacyPin: '1234' })).rejects.toThrow(
      'MLS_LOCAL_STATE_UNDECRYPTABLE'
    );
    expect(ctx.generateDeviceId).not.toHaveBeenCalled();
  });

  it('does not attempt a migration without a PIN (biometric and vault paths)', async () => {
    const ctx = makeCtx({ loadStateWithKey: vi.fn().mockRejectedValue(SEALED) });

    await expect(initImpl(ctx, stored, { noFreshStart: true })).rejects.toThrow(
      'MLS_LOCAL_STATE_UNDECRYPTABLE'
    );
    expect(migrateLegacyMlsStateBlob).not.toHaveBeenCalled();
  });
});
