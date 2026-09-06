# MLS WASM client

**Source**: `frontend/mls-core/` (shared Rust logic), `frontend/mls-wasm/` (WASM bindings), `frontend/src/lib/mls-client/` (TypeScript wrapper layer)

## Overview

The MLS WASM client is the cryptographic core of Canari. It is a Rust library (OpenMLS) compiled to WebAssembly via `wasm-bindgen` and `wasm-pack`. All MLS group operations — key generation, message encryption/decryption, commit processing, group membership changes — execute inside the WASM sandbox. The server never touches plaintext or private keys.

In the Tauri desktop app the same Rust code runs natively (not WASM); the TypeScript side calls it via `invoke()` commands instead of WASM bindings.

## Package structure

```
frontend/mls-core/          # Shared Rust crate (no WASM-specific code)
├── src/
│   ├── lib.rs              # Core MLS operations
│   └── ...

frontend/mls-wasm/          # wasm-bindgen bindings
├── src/
│   └── lib.rs              # #[wasm_bindgen] exports
└── Cargo.toml

frontend/src/lib/mls-client/   # TypeScript wrapper layer
├── ARCHITECTURE.md
├── IMlsService.ts          # Interface (Web + Tauri)
├── incomingDelivery.ts     # Incoming message dispatch
├── IMlsService.ts          # The interface both platforms implement
├── mlsPlatform.ts          # Which platform is live, resolved once
├── initializeConnection.ts # syncAfterConnect(), single-pass reconnect
├── keyPackages.ts          # mintKeyPackages(): the fallback (last-resort) vs the pool
├── messagePipeline/        # handleWelcome, handleKnownGroup, handleUnknownGroup
│
│   # Inbound - receiving, decrypting, and not losing a frame
├── incomingDelivery.ts     # The inbound entry point
├── frameDelivery.ts        # One frame's journey from the socket to the store
├── inboundFrameLedger.ts   # What has been seen, so a replay is not a duplicate
├── mlsBulkIngest.ts        # Ingest depth; disk writes deferred while it is open
├── mlsBatchDecrypt.ts      # Decrypting a page of history in one crossing
├── mlsDecryptSession.ts    # A decrypt session and its lifetime
├── mlsDecryptError.ts      # Decrypt failures classified AT THE THROW, as types
├── ackRetry.ts             # ACK retries
├── mlsQueueAckPolicy.ts    # ACK exactly once, at-least-once delivery
│
│   # Outbound - and the ratchet it moves
├── sendRatchetLedger.ts    # Generations emitted vs persisted; what the burn reads at load
│
│   # Workers - crypto off the main thread
├── mlsCryptoWorkerSession.ts  # The crypto worker session
├── mlsEncryptWorkerSession.ts # Encryption off-thread
├── mlsWorkerProtocol.ts       # The message contract with the workers
│
│   # State at rest
├── mlsStatePersister.ts         # Save/load MLS state (IndexedDB / filesystem)
├── mlsStatePersisterLifecycle.ts# When a persist is armed and when it flushes
├── mlsStatePersisterRegistry.ts # Who is persisting for whom
│
│   # Transport, scheduling, tabs
├── mlsDeliveryApi.ts       # High-level API calls (groups, messages, invitations)
├── mlsDeliveryHttp.ts      # Low-level fetch helpers (keepalive POST, URL utils)
├── mlsPerGroupScheduler.ts # Round-robin MLS ops under per-group mutex
├── tabLeader.ts            # BroadcastChannel-based single-tab leader election
├── tabMessageSync.ts       # Keeping other tabs' stores in step
│
├── mlsRecoveryMetrics.ts   # Recovery attempt counters + alerting
├── catchupBenchmark.ts     # Measuring catch-up rather than guessing at it
├── mlsWasmLoader.ts        # WASM init + lazy load
├── historyTypes.ts         # History exchange types
└── mlsTypes.ts             # Shared TypeScript types
```

`ARCHITECTURE.md` sits in that directory, next to the code it describes, and is the boundary
document for the package.

## Package boundaries (from ARCHITECTURE.md)

### Preventive (normal online operation)

Measures that avoid entering bad MLS states:

- Single MLS tab leader + `BroadcastChannel` coordination (`tabLeader.ts`).
- Distributed add-lock (`acquireAddLock` / `releaseAddLock` on `IMlsService`).
- One staged commit transaction (`runCommitTransaction`): stage -> validate epoch server-side (`POST /api/mls/commit`) -> merge on accept / roll back on reject.
- Shared delivery HTTP helpers (`mlsDeliveryHttp.ts`): URLs, keepalive POST, response assertion.
- Correct Welcome-before-commit ordering (handled in the message pipeline).

### Resilience (partitions, crashes, multi-device)

Measures that restore correctness after failures:

- Redis delivery queue + ACK policy (`mlsQueueAckPolicy.ts`).
- Reconnect drain, `forgetGroup` / reinvite, phantom-group handling (message pipeline).
- Push wake (platform notification services).

## WASM exported API (`WasmMlsClient`)

The primary TypeScript interface to the WASM module, used by `WebMlsService`:

```typescript
class WasmMlsClient {
  static async new(userId: string, deviceId: string, savedState: string | null, deviceKeyB64: string, stateWasExpected: boolean): Promise<WasmMlsClient>

  // Key packages
  generateKeyPackage(deviceKeyB64: string): Promise<KeyPackageBundle>
  generateKeyPackages(deviceKeyB64: string, count: number): Promise<KeyPackageBundle[]>

  // Groups
  createGroup(groupId: string): Promise<void>
  addMembersBulk(groupId: string, keyPackages: Uint8Array[]): Promise<CommitBundle>
  processWelcome(welcomeBytes: Uint8Array, ratchetTree: Uint8Array | null): Promise<string>

  // Messaging
  sendMessage(groupId: string, plaintext: Uint8Array): Promise<Uint8Array>
  processIncomingMessage(groupId: string, ciphertext: Uint8Array): Promise<Uint8Array>
  processCommit(groupId: string, commitBytes: Uint8Array): Promise<void>

  // State
  saveState(deviceKeyB64: string): Promise<string>
  forgetGroup(groupId: string): Promise<void>
  getLocalGroups(): Promise<string[]>
}
```

### `stateWasExpected`, and why the constructor cannot work it out

The constructor is handed a device key and, sometimes, an encrypted state. **A key with no state
beside it has two completely different meanings and one shape.** On a device enrolling for the first
time it is ordinary - there has never been a state to load. On a device that has booted before it
means a snapshot went missing, which is worth waking someone for.

`lib.rs` used to warn on both, because from inside the constructor they are indistinguishable. The
result was a warning that fired on every fresh client, which the cross-client harness had to forgive
per row in `FRESH_CLIENT_NARRATION` - a line nobody could act on, and one whose reader learns to skip
it. That is the standing rule about never learning by failing what a fact could have told you,
pointed at a log line rather than a request.

**The fact was already computed one layer up.** `BaseMlsService.resolveDeviceId` either finds this
device's id or mints one, and that IS the question:

| Where the device id came from | `stateWasExpected` | Why |
| --- | --- | --- |
| `localStorage` | `true` | This device has booted before; a snapshot should be here. |
| Native restore (Tauri) | `true` | The id belongs to a device that already enrolled and whose WebView stores were evicted. A state missing there was lost. |
| Freshly minted | `false` | A first enrolment. There is nothing to have lost. |
| After `rotateDeviceIdentity` | `false` | A new identity is a new device, and the load that follows deliberately passes no state. |

A factory wipe (`wipeDeviceToFactory`) clears the native app data as well as `localStorage`, so it
lands on the minted row rather than the native-restore one - a wiped device re-enrols silently, which
is what it should do.

The flag is **required** at `loadAndInitWasm`, not optional with a default. Every off-thread path
that builds its own client - `mlsKeyPackage.worker`, `mlsCrypto.worker` - therefore has to state
which case it is in, and `MlsKeyPackageRequest` carries it across the worker boundary rather than
guessing from whether a snapshot was attached: the worker is sent a snapshot only when the live
client has one, so absence there proves nothing.

**If `device_key_b64 provided but no encrypted state` ever appears again, it is a finding.** It now
means a device whose id pre-existed the boot came up without its state.

## IMlsService interface

Both `WebMlsService` (WASM) and `TauriMlsService` (native) implement `IMlsService`:

```typescript
interface IMlsService {
  init(userId: string, deviceId: string, deviceKeyB64: string, savedState?: string): Promise<void>
  generateKeyPackage(deviceKeyB64: string): Promise<KeyPackageBundle>
  createGroup(groupId: string): Promise<void>
  addMembersBulk(groupId: string, devices: DeviceInfo[]): Promise<CommitBundle>
  sendMessage(groupId: string, appMessageBytes: Uint8Array): Promise<Uint8Array>
  processIncomingMessage(groupId: string, bytes: Uint8Array): Promise<Uint8Array>
  processWelcome(bytes: Uint8Array, ratchetTree: Uint8Array | null): Promise<string>
  processCommit(groupId: string, commitBytes: Uint8Array): Promise<void>
  forgetGroup(groupId: string): Promise<void>
  getLocalGroups(): Promise<string[]>
  saveState(deviceKeyB64: string): Promise<string>
  acquireAddLock(groupId: string): Promise<boolean>
  releaseAddLock(groupId: string): Promise<void>
}
```

## State persistence

WASM state is serialized by `saveState(deviceKeyB64)` as an encrypted blob using ChaCha20-Poly1305 directly with `deviceKeyB64` (no Argon2id derivation). Storage backend:

| Platform | Storage |
|---|---|
| Browser | `IndexedDB` (key: `mls_state_{deviceId}`) |
| Tauri | Filesystem (`mls.bin`, format: `[nonce 12 || ciphertext]`) |

The persister (`mlsStatePersister.ts`) debounces writes and flushes immediately on `visibilitychange` (page hide) and on commit completion.

## Message queue

All WASM calls are serialized through a single message queue to prevent concurrent state access:

```
WebSocket frame / fetchPendingMessages
        |
  enqueueMessage()
        |
   messageQueue[]
        |
   processQueue()  <- one message at a time
        |
  messageCallback()
        |
  messagePipeline handlers
```

**Welcome priority**: Welcome messages are shifted to the front of the queue. Messages for groups with a pending Welcome are buffered until the Welcome completes.

## Tab leadership

`tabLeader.ts` uses a `BroadcastChannel` + heartbeat to elect a single leader tab:
- Only the leader opens the WebSocket and runs `discoverMissingGroups`.
- Followers skip `initializeConnection()` entirely.
- Leadership transfers automatically if the leader tab is closed.

## Building

`frontend/src/lib/wasm/` is a **build artefact and is not in git** (2026-08-18). It is produced from
`frontend/mls-wasm/`, which is bindings over `frontend/mls-core/`.

```bash
cd frontend
bun run wasm:build   # wasm-pack build mls-wasm --target web --out-dir ../src/lib/wasm
bun run generate     # the same, plus the protobuf bindings
make install         # a fresh clone: dependencies, svelte-kit sync, then generate
```

`make build-frontend` calls `generate` before `vite build`, so a full build never needs the step by
hand. After a change to `frontend/mls-core/` or `frontend/mls-wasm/`, run `bun run wasm:build` before
testing the frontend - `svelte-check` and Vitest both import the generated bindings.

### Why it is not committed

It was, until 2026-08-18, and it went stale. Only `deploy.yml` and `cd-dev.yml` rebuilt it (the latter
was deleted on 2026-09-01, dormant and wired to production's secrets); the three
release pipelines (`android-release`, `ios-release`, `appimage-release`) shipped whatever the tree
happened to hold. The result was two different cryptos in the fleet: the web ran the current
`mls-core`, the phone and the desktop app ran the binary from the last commit that thought to
regenerate it. Nothing anywhere compared the two, so nothing said so. Rebuilding the untouched
sources on 2026-08-18 produced a binary of 1 664 493 bytes against the committed 1 664 508 - the
drift was real and measurable, not inferred from dates.

**Every pipeline that ships a client now builds it**, through one composite action,
[`.github/actions/build-mls-wasm`](../../../.github/actions/build-mls-wasm/action.yml):

- one pinned `wasm-pack` (0.15.0, installed from the official prebuilt release by
  `scripts/install-wasm-pack.sh`) - two pipelines on two toolchains would put two cryptos back in
  the fleet;
- one cache keyed on `frontend/mls-wasm/**` + `frontend/mls-core/**` + `rust-toolchain.toml`, so an
  unchanged crate never pays for a rebuild and a changed one can never miss it;
- a verification step that fails the job when the artefact is absent, rather than letting a module
  resolution error three steps later say it in a job that has nothing to do with crypto.

`ci.yml` builds it too, because the frontend gates import it, and its change detection now treats
`frontend/mls-core/` as a frontend change for the same reason.

The generated protobuf module (`src/lib/proto/canari.js`, `.d.ts`) left git in the same commit and
for the same reason. `src/lib/paraglide/` had always worked this way and never drifted once.

**One note kept so nobody reaches for the wrong tool:** the binary is the largest thing in the
repository's history - a dozen full copies, roughly 19 MB of a 34 MB pack, since wasm does not delta
well. That is not a reason to rewrite history. A `filter-repo` would force-push a public repository
with another active contributor to reclaim 19 MB. The history stops growing here, which is enough.
