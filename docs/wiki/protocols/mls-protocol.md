# MLS protocol

Canari implements end-to-end encryption using **MLS (Messaging Layer Security, RFC 9420)**. All encryption and decryption happens inside a **Rust/OpenMLS** WASM module (browser) or a Tauri native binary (desktop/mobile). The server stores and routes only ciphertext — it never sees plaintext.

**Living docs** (do not archive, actively updated):
- [`mls-desync-prevention.md`](mls-desync-prevention.md) — desync root causes and countermeasures
- [`mls-recovery-ladder.md`](mls-recovery-ladder.md) — step-by-step recovery ladder (rung-1 commit replay → rung-2 external join → welcome_request fallback)

## Key properties

| Property | Value |
|---|---|
| Protocol | MLS RFC 9420 |
| Cipher suite | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 |
| Forward secrecy | Per epoch (key ratchet on every commit) |
| Post-compromise security | Devices can be removed and re-added |
| Server role | Routing + persistence of encrypted blobs only |

## Non-negotiable invariants (post-2026-06 rewrite)

1. `getLocalGroups()` is the sole source of truth for group state.
2. Every message is ACK'd exactly once.
3. No in-memory state machines (no recovery Sets/Maps).
4. Recovery: rung-1 commit replay for epoch gaps; rung-2 self-service external-commit join for a
   device lacking state (external join replaced the reboot/CAS/successor machinery in Phase 4b),
   with `welcome_request` as the thin fallback when no GroupInfo is stored yet.

## Source files

### Frontend (SvelteKit)

| File | Role |
|---|---|
| `frontend/src/lib/services/WebMlsService.ts` | WASM MLS client (browser) |
| `frontend/src/lib/services/TauriMlsService.ts` | Tauri native MLS client (desktop/mobile) |
| `frontend/src/lib/mls-client/IMlsService.ts` | Interface shared by both |
| `frontend/src/lib/mlsService.ts` | Factory: picks Web or Tauri at runtime |
| `frontend/src/lib/composables/useChatSession.svelte.ts` | Login, reconnect, device sync orchestration |
| `frontend/src/lib/utils/chat/connection.ts` | WS message handler, epoch recovery, Welcome processing |
| `frontend/src/lib/utils/chat/actions.ts` | `processPendingInvitations`, `discoverMissingGroups`, `handleWelcomeRequest` |
| `frontend/src/lib/utils/chat/history.ts` | History replay (Redis Stream fetch + MLS decrypt) |
| `frontend/src/lib/utils/chat/conversations.ts` | Conversation loading, deduplication, type detection |
| `frontend/src/lib/utils/chat/messaging.ts` | `sendChatMessage`, reactions, edits, deletes |
| `frontend/src/lib/utils/chat/messageUtils.ts` | `appMsgToEnvelope()` - unified AppMessage -> MessageEnvelope decoder |
| `frontend/src/lib/envelope.ts` | `MessageEnvelope` union type (text/media/system) + serialization |
| `frontend/src/lib/proto/codec.ts` | Protobuf encode/decode + `mediaKindToType` |
| `frontend/src/lib/types/index.ts` | Central types: `Conversation`, `ChatMessage`, `MessageReference`, `AddMessageToChatOptions` |
| `frontend/mls-wasm/` | Rust WASM bindings (OpenMLS) |
| `frontend/mls-core/` | Shared Rust MLS logic |

### Backend (NestJS - chat-delivery-service, port 3010)

| File | Role |
|---|---|
| `apps/chat-delivery-service/src/controllers/` | The MLS HTTP surface, split by concern: `devices`, `groups`, `members`, `messaging`, `invitations`, `locks`, `security`, `push`, `calls`, `internal`, `admin-storage`, `health` |
| `apps/chat-delivery-service/src/app.controller.ts` | What predates the split - still live, no longer the whole surface |
| `apps/chat-delivery-service/src/entities/` | TypeORM entities |

### Gateway (Rust/Axum - chat-gateway, port 3000)

| File | Role |
|---|---|
| `apps/chat-gateway/src/main.rs` | WebSocket routing, presence, pub/sub |

## Data model

### Entities (chat-delivery-service)

| Entity | Purpose |
|---|---|
| `KeyPackage` | Static fallback key package per device (1 per device) |
| `OneTimeKeyPackage` | One-time prekeys (OTKP), consumed on invite |
| `Group` | Group metadata (name, isGroup, epoch) |
| `GroupMember` | User <-> group membership |
| `DeviceGroupMembership` | Per-device state machine (`pending` / `active` / `removed`) |
| `QueuedMessage` | Pending messages for offline devices |
| `PinVerifier` | Argon2id verifier to detect PIN mismatch across devices |
| `PushToken` | FCM push token per device |
| `RevokedDevice` | Revoked device IDs (triggers resetRequired on next login) |

### DeviceGroupMembership state machine

```
pending --(add commit + Welcome sent)--> active
active --(device removed / group deleted)--> removed
removed --(re-add)--> pending
```

Note: prior to the 2026-06 rewrite the states were `pending / welcome_sent / welcome_received / stale`. The simplified model above is current.

## API endpoints (chat-delivery-service)

All routes require `X-User-Id` header (injected by Nginx `auth_request`).

### Device management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/register-device` | Register static key package |
| POST | `/api/mls/register-device/prekeys` | Bulk-upload one-time prekeys |
| GET | `/api/mls/devices/:userId` | Fetch all devices for a user |
| DELETE | `/api/mls/devices/:userId/:deviceId` | Delete a device (all memberships + KPs) |
| PATCH | `/api/mls/devices/:userId/:deviceId/metadata` | Update device name/OS/version |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/count` | Count remaining OTKPs |
| DELETE | `/api/mls/devices/:userId/:deviceId/prekeys` | Purge all OTKPs for device |

`DELETE /devices/:userId/:deviceId` is a full purge (KeyPackages, prekeys, push tokens,
memberships, Redis routing entry) and is irreversible for whatever that device still had in
flight, so `DeviceManagementPanel` gates it behind `showConfirm` - the same treatment a channel
kick gets. The current device has no delete button at all.

### Group management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups` | Create group |
| GET | `/api/mls/groups/:groupId` | Get group metadata |
| PATCH | `/api/mls/groups/:groupId` | Rename group |
| DELETE | `/api/mls/groups/:groupId` | Delete group |
| POST | `/api/mls/groups/:groupId/members` | Register user as member |
| GET | `/api/mls/groups/:groupId/members` | List group members |
| DELETE | `/api/mls/groups/:groupId/members/:userId` | Remove member |
| POST | `/api/mls/groups/:groupId/reset` | Trigger group_reset broadcast |
| GET | `/api/mls/users/:userId/groups` | List all groups for a user |

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send encrypted message/commit |
| POST | `/api/mls/welcome` | Deliver Welcome to device |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch pending messages |
| POST | `/api/mls/messages/ack` | Acknowledge messages |
| POST | `/api/mls/commit` | Submit a commit: validate epoch + store in the commit-log + fan out (one atomic call) |
| GET | `/api/mls/commits/:groupId?sinceEpoch=N` | Rung-1 replay: ordered commits `baseEpoch >= N` to catch up a lagging device |
| GET | `/api/mls/group-info/:groupId` | Latest GroupInfo (external-join base) - membership-gated, returns `{ groupInfo, baseEpoch }` or null |
| POST | `/api/mls/group-info/:groupId` | Refresh the stored GroupInfo (after each commit) - membership-gated, monotonic write-if-newer |

### Device sync / invitation

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/invitations/status` | Upsert DeviceGroupMembership |
| GET | `/api/mls/invitations/pending/:userId/:deviceId` | Invitations to process |
| GET | `/api/mls/device-memberships/:userId/:deviceId` | All memberships for device |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId/:groupId` | Delete one membership |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId` | Delete all memberships |
| POST | `/api/mls/kick-stale-device` | Kick stale leaf from group |
| POST | `/api/mls/welcome-request` | Broadcast welcome_request signal |
| POST | `/api/mls/history-request` | Ask one RANDOM online member to resend the history bundle (after a fresh join); `no_peer_online` if none |
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Auth / misc

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Validate/register PIN verifier |
| POST | `/api/mls/push/register` | Register FCM push token |
| DELETE | `/api/mls/push/unregister/:deviceId` | Deregister push token |
| POST | `/api/mls/push/commits` | PushSecret-authed ordered commits `sinceEpoch` (background in-memory catch-up) |
| GET | `/api/mls/history/:groupId` | Redis Stream history (incremental) |

### Background push commit catch-up (never-opened mobile)

A device added to a group advances the epoch via a commit. A member whose mobile has not been opened
only runs the read-only background push decrypt (`mobile/background.rs::decrypt_push_message`, which
discards commits and never persists), so it stays behind and the newcomer's first message at the new
epoch is an epoch gap -> generic fallback notification. To decrypt at notification time, the FCM/APNs
decrypt-fail path performs a **read-only in-memory commit catch-up**: read the current epoch
(`nativeGroupEpoch`), fetch the ordered commits via `POST /api/mls/push/commits` (PushSecret - the
background path has no JWT), apply them to an ephemeral manager to reach the message epoch, decrypt,
and discard (`decrypt_push_message_with_commits`). It NEVER writes `mls.bin`; the durable state is
caught up later by the foreground commit-log replay. `belowFloor` (commits pruned past retention) ->
no catch-up, the existing worker-retry + fallback stands.

## Scenarios

### First login (new device)

1. `login()` loads MLS state from IndexedDB -> none found -> `freshStart = true`
2. `mlsService.init(userId, pin, undefined)` -> WASM initialized with new identity
3. `generateKeyPackage(pin)`:
   - `freshStart = true` -> DELETE stale OTKPs from server
   - Generate fresh static KP + pool of 50 OTKPs (web) / 200 (Tauri)
   - Save WASM state to IndexedDB
   - POST `/api/mls/register-device` (static KP)
   - POST `/api/mls/register-device/prekeys` (pool)
4. `initializeConnection()`:
   - Open WebSocket
   - `fetchPendingMessages()` -> process any queued Welcomes/commits via `enqueueMessage`
   - Check `getDeviceMemberships()` -> `pending` -> send `welcome_request`
5. `discoverMissingGroups()` -> find server groups with no local conversation -> create stubs, send `welcome_request`

### Starting a direct conversation

1. Creator: `createRemoteGroup(name, isGroup=false)` -> server returns `groupId`
2. Creator: `createGroup(groupId)` in WASM
3. Creator: `fetchUserDevices(peerId)` -> get peer's key packages
4. Creator: `addMembersBulk(groupId, devices, excludeDeviceIds)` -> one staged transaction (C7-A): stage the Add, validate the epoch (`POST /api/mls/commit`), merge on accept and broadcast the commit / roll back on reject. Returns `{ welcome, ratchetTree, addedDeviceIds, skippedDeviceIds }` (the ratchet tree is exported post-merge).
5. Creator: `sendWelcome(welcome, peerId, groupId, deviceId, ratchetTree)` -> POST `/api/mls/welcome`
6. Creator: `registerMember(groupId, peerId)` + `registerMember(groupId, userId)`

Only the bulk commit must stay unique (staged under the add-lock). Everything around it is
plain HTTP and runs in parallel (`groupCreation.ts` / `deliverWelcomes` in `groupActions.ts`):
device fetches across invited users, Welcome deliveries across devices (same blob, order-free),
and `registerMember` deduplicated per user. Group invites surface optimistic "pending" member
rows in the group panel while the flow runs (`pendingGroupInvites` in `useConversations`).
7. Peer: Welcome arrives via WS or pending queue -> `processWelcome(bytes, ratchetTree)` -> group joined in WASM
8. Peer: `registerMember(groupId, userId)` + `updateInvitationStatus(..., 'active')`
9. Peer: `saveState(pin)` -> persisted to IndexedDB

### Sending a message

1. `sendChatMessage()` in `messaging.ts`
2. Optimistic UI: message added with `status: 'sending'`
3. `mlsService.sendMessage(groupId, appMessageBytes)` -> WASM encrypts -> POST `/api/mls/send`
4. Gateway broadcasts to all group members' WebSocket connections
5. On success: message status patched to `'sent'`; on error: `'error'`

### Receiving a message

1. WS frame arrives -> `enqueueMessage()` -> serialized queue
2. `processQueue()` calls `messageCallback(sender, bytes, groupId, isWelcome, ratchetTree, isCommit)`
3. `connection.ts` handler:
   - Known group + `isReady`: `processIncomingMessage(groupId, bytes)` -> decrypt -> dispatch by type
   - Known group + `!isReady`: buffer, then replay after Welcome
   - Unknown group + `isWelcome`: `processWelcome()` -> create conversation -> replay history
   - Unknown group + not Welcome: buffer in `pendingGroupMessages` map

### New device added to existing account

1. New device logs in -> no MLS state -> `freshStart = true`
2. Purges stale OTKPs -> publishes fresh KPs
3. `getDeviceMemberships()` -> empty -> send `welcome_request` for each user group
4. Online devices receive `welcome_request` via WS -> `handleWelcomeRequest()`:
   - Acquire add-lock
   - `addMember(groupId, newDeviceKP, excludeDeviceIds)` -> staged transaction (validate + merge + broadcast) -> `{ welcome, ratchetTree }`
   - `sendWelcome()`
   - `updateInvitationStatus(..., 'active')`
5. New device receives Welcome -> joins group -> saves state

### Epoch recovery (diverged state)

Triggered when `processIncomingMessage` fails with epoch-related errors:

| Error | Condition | Recovery |
|---|---|---|
| `TooDistantInThePast` / `CiphertextGenerationOutOfBounds` | Ratchet key consumed | ACK, then classify - see below |
| `msg_epoch < group_epoch` | Stale message (already processed) | ACK silently |
| `msg_epoch > group_epoch` | Local state is behind | `forgetGroup()` + `requestReAdd()` |
| `SenderDataDecryption` | Sender secrets diverged | `forgetGroup()` + `requestReAdd()` |
| `WrongEpoch` | No epoch numbers | ACK silently |

#### Why a sender's ratchet goes backwards at all (WP-LOSS-1, 2026-08-06)

The recovery table above is the receiver's side of a defect whose cause is on the SENDER, and the
two were originally reported as separate bugs (WP-FWD-1, "forwarding loses messages"). They are one
defect, and it is deterministic.

The fingerprint is a sender that keeps re-offering the SAME generation:

```
sender    POST /api/mls/send -> 201
receiver  [RUST::DEBUG] Ciphertext generation out of bounds 110  SecretReuseError
receiver  [MLS] Duplicate for <group> - silent ACK
```

Forwarding was never the variable. Two experiments isolate it, neither of which forwards anything:

| Experiment | Result |
| --- | --- |
| Reload, then send three messages | only the FIRST is lost (`out of bounds 110`); a second round immediately after loses nothing |
| Prime the ratchet with a send, wait, reload, send | 300 ms wait: **lost** (generations 118, then 120). 20 s wait: delivered in 694 ms |

**MLS disk writes were deferred, so a reload that beat the checkpoint restored a state behind the
ratchet the sender had already used.** The next message is then encrypted at a generation the
receiver already consumed, and the receiver drops it as a duplicate.

`scheduleOutboundMlsPersist` therefore calls `persistNow()` rather than `scheduleDeferred()`:
encrypting a message checkpoints the ratchet at the point it moved. **An unload hook cannot
substitute** - `pagehide` / `visibilitychange` can only *start* an async save (a worker round trip,
then IndexedDB) and the document is torn down long before it lands, so it is a best-effort extra and
never the guarantee. `persistNow` still merges same-tick calls and stays deferred during a bulk
ingest, so a burst of sends costs one checkpoint.

The invariant this establishes, and it is the general form: **never hand out a ciphertext whose
ratchet advance is not yet durable.** A ratchet that can go backwards is a correctness bug in its
own right - it is also how two live tabs of one device diverge (see [multi-tab
leadership](#multi-tab-leadership)).

Two things this retires permanently, so that neither is re-opened: the load hypothesis (a burst
alone never provokes it - 30 rapid sends are clean), and "forwarding is special".

One trap worth naming: `[MLS] Disk writes deferred` sat on the harness's benign-log list for weeks.
It was the loudest line in the log.

**A consumed generation is not evidence of a duplicate.** `SecretReuseError` /
`CiphertextGenerationOutOfBounds` says only that the generation is spent, and that happens both when
the same frame arrives twice (real-time publish racing the queue or FCM) and when a sender whose
state went backwards encrypts a NEW message at a generation we spent on another one. The first is
benign; the second is a message lost for good on this side, and both used to be dropped in silence.
`inboundFrameLedger.ts` fingerprints every frame processed (in memory, 200 per group), so the two
are separated on the only evidence available - the frame's bytes. A miss logs `LOST frame` and
solicits the **history diff**, which is the single repair for this class: it reads the peer's DURABLE
store, is answered by one elected member, and names messages by id.

There used to be a narrower rung in front of it - `decrypt_failed { withinMs }`, answered from an
in-memory ring of the last five minutes of sent protos. It is deleted, and the reasoning generalises:
a repair that cannot NAME its target can only ask for a period of time, which is a broadcast; and its
one trigger is a sender whose ratchet went backwards, so what it asks that sender to do is re-encrypt
at the same rewound ratchet. Its only mode of success was the sender burning past the receiver's
high-water mark while answering - recovery by exhaustion. Measured on production 2026-08-10: ~450
frames/min across three devices for over ten minutes, repairing nothing. The receiving branch remains
only to IGNORE the event from an older peer. Never `onOutOfSync` either: the plaintext is unrecoverable
whatever we do locally, and a re-add would destroy a valid membership for nothing.

Both platforms run this classifier - the Tauri command surfaces the
error rather than answering `Ok(None)`, which used to discard the diagnosis before TypeScript saw
it. A layer that cannot make a distinction must not make it, and the guard is
`same_epoch_ratchet.rs` rather than a comment.

##### Both halves verified on hardware, and they need two DIFFERENT runs

The trigger and the repair cannot be exercised by one check, because the fix means the trigger no
longer reaches the repair. Both were run on A1 against a browser peer:

| run | what it exercises | result |
| --- | --- | --- |
| `check-loss-a1.mjs` (2026-08-11) | the ORIGINAL trigger: reload the sender, then send | 3/3 delivered before, **6/6 after**, **zero `LOST frame`** |
| `heal-a1.mjs` (2026-08-11) | the REPAIR, on a deliberately rewound sender | 10 `LOST frame … SecretReuseError`, cross-session re-solicit, `HEALED 14/14` |

Zero `LOST frame` in the first run is the point of it, not a gap in it: the sender half persists its
ratchet across a reload, so nothing goes backwards and the receiver never has to detect anything.
The detector and the diff are what the second run covers, and it has to force the rewind to get
there. **A run reporting neither is VOID** - it has shown only that nobody sent anything.

The check carries a positive control for the same reason: it delivers a baseline batch BEFORE the
reload and refuses to report on the trigger unless all of it arrived. Otherwise a delivery that was
already broken would be attributed to the reload.

Worth keeping from building it, because it nearly produced a false FAIL: the first attempt reported
`phone holds 2/3` before the trigger had even fired, and a direct comparison of the two stores
showed all three markers present on both sides. The counter gave up after a fixed number of polls.
**A harness that stops looking early manufactures exactly the silent loss this WP is about**, so the
count is now bounded by a deadline and reports how long it waited - 1472 ms and 1240 ms in the
passing run, i.e. nothing was ever slow; the earlier miss was the harness alone.

**And a generation too far AHEAD is the mirror case, with the opposite remedy.**
`SecretTreeError(TooDistantInTheFuture)` means the frame's generation is beyond what OpenMLS will
derive forward (`maximum_forward_distance`), i.e. this device missed a long run of that sender's
frames - which is what an undrainable pending queue produces (WP-PENDING-1). The epochs match on both
sides, so **no commit replay can help**: only a new epoch resets the sender ratchets. It is therefore
classified apart (`generation-gap` in TS, `DecryptErrorKind::GenerationTooFarAhead` in `mls-core`,
both matched BEFORE the generic `Process error:` / `GAP_QUEUED` rule, since the native layer wraps
one string inside the other), never queued in `pending_mls_messages` (it can never be retried), and
escalated at once to `forgetGroup()` + `requestReAdd()` with no threshold - unlike `secret-reuse`,
the group really is broken for us, because every later frame that sender emits in this epoch fails
identically. Read as an epoch gap it produced the worst possible outcome: a replay that applied zero
commits, reported `healed=true` because `epoch >= activeEpoch` was trivially satisfied, and ACKed the
message off the server (WP-PENDING-2).

### A frame from a PAST epoch is two events, and only `content_type` separates them (2026-08-11)

`process_incoming_on_group` compares the frame's epoch to the group's before deciding anything, and
for a frame that is BEHIND it answered `Ok(None)` - "no application payload" - on the reasoning that
such a frame is "almost certainly our own echoed commit". For a **handshake** that is exactly right:
a commit re-delivered after the merge has had its keys consumed by that merge, nothing is lost, and
the caller must ACK it without a word.

For an **application** frame it is a message somebody sent, and it is gone. `Ok(None)` is the same
value a commit echo returns, so both printed the same `[MLS] No application payload … - commit or
dropped frame` line and the entire ladder above was unreachable: no `LOST frame`, no
`unreadable-frames` marker, no history solicitation, and the frame ACKed off the server. Measured on
production 2026-08-11 during a HEAL-W2 run: a restored (rewound) device re-joined the group from a
still-available Welcome, then received a message sent one epoch earlier and dropped it in complete
silence.

The distinction needs no decryption, because **`content_type` is cleartext in the MLS frame header**,
exactly like `epoch` - it is read next to it, before `process_message` consumes the frame. A
handshake keeps its silent `Ok(None)`; an application frame becomes
`Process error: past epoch application frame [msg_epoch=…, group_epoch=…]`, classified as
`DecryptErrorKind::PastEpochApplication` / `'past-epoch-application'` **before** the generic
`Process error:` and `GAP_QUEUED` arms, for the same reason as `TooDistantInTheFuture`: a commit
replay repairs an epoch we are BEHIND and can do nothing for one we are already past.

The policy is `secret-reuse`'s, because the situation is the same one from the other end of the
ratchet - unreadable for good, the group itself healthy: check the frame against
`inboundFrameLedger`, log `LOST frame` when it is genuinely new, mark `unreadable-frames`, solicit
the history diff, ACK. Never a re-add (it would destroy a valid membership to recover nothing), and
never queued for retry on native (no retry can decrypt it).

**Why this is not simply "past epoch = loss".** `max_past_epochs` is 2 on all three group-config
paths, so a message merely overtaken by a commit - ordinary traffic whenever someone is invited
while a message is in flight - still decrypts, and reporting a loss there would manufacture a
phantom gap on every invitation. Reaching this branch means the epoch's secrets are genuinely
absent, which is what a **re-joined** group has for everything sent before its join: a fresh join
starts with no past epochs at all. `tests/past_epoch_frame.rs` pins all three facts - the loss is
reported, the overtaken frame still decrypts, the stale handshake stays silent - and asserts that
the wrapper carries its own marker and no other, since a string holding two markers makes the
classifier's ORDER a decision rather than a fact.

### Our own frame was classified as a retryable gap (2026-08-15)

A device's mailbox holds every frame the group produced, **including the ones it sent itself**, so
every history replay re-offers them and OpenMLS refuses them by design
(`ValidationError(CannotDecryptOwnMessage)`). That refusal is the protocol working - it is exactly
why the sender's optimistic render is its own message's only writer (WP-ECHO-1) - and it was
nonetheless routed through the generic failure arm at all three layers:

| Layer | Before | Consequence |
|---|---|---|
| `mls-core::process_incoming_on_group` | `log::error!("MLS decryption failed: … err={:?}")` | an ERROR on the normal path |
| `mls-core::decrypt_kind` | no arm -> fell through `Process error:` to `SenderRatchetGap` | **native queued the frame in `pending_mls_messages`** and retried it 3x before the sweeper removed it |
| `recevoir_message_bytes` | blanket `log::error!` above the match | a second ERROR, then a `[GAP]` WARN, per own frame |

Only the WEB was quiet, and for the wrong reason: **two shims re-matched the marker in the log text
and rewrote the level** (`mls-wasm`'s `WebLogger`, then `mlsWasmLoader`'s `wasm_bindings_log`), which
is branching on an error message twice over. Their two lists had already drifted apart - one carried
`SecretReuseError`, the other did not - and between them they hid the fact that native had no shim at
all.

**Where it comes from was itself measured, because the harness comment asserting it was wrong on both
counts.** It does not happen on every send: `broadcast_to_group_members` already excludes the
sender's own devices, so no live fanout returns our frame. Opening the DM on two peers **with no send
at all** produced the line once on each, and opening a channel produced none - the source is the
replay, nothing else.

The fix is one arm at the throw, mirroring `TooDistantInTheFuture` and `past epoch application
frame`: `DecryptErrorKind::OwnMessage`, matched **before** the generic `Process error:` rule, logged
at `debug!`, never queued, and the error still surfaced verbatim so
`classifyIncomingDecryptError` answers `'own-message'` and every consumer ACKs. `recevoir_message_bytes`
now picks its severity from the classification instead of from the bare fact that a decrypt returned
`Err` - only an **unclassified** failure keeps `error!`, since that is the one nobody has explained.
`tests/own_message_frame.rs` pins the kind, the marker, and that the same ciphertext still decrypts
for the member it was meant for (without which the classification could be right for the wrong
reason: a malformed frame would pass the first assertion too).

`requestReAdd(groupId)`: tries `externalJoin(groupId)` first (fetch the stored GroupInfo -> build a native external commit -> submit under the epoch gate -> merge, or discard + retry on an epoch race); falls back to a single `welcome_request` when no GroupInfo is available. **A 403 on the GroupInfo read is a membership ANSWER, not a failed attempt**: it arrives typed (`NotAGroupMemberError`) and retires the conversation instead of falling back, which is what makes this seam terminate on a proof rather than on its throttle — see [mls-recovery-ladder](mls-recovery-ladder.md). Self-throttled to one attempt per `RECOVERY_TIMEOUT_MS`; the SYNC_WATCHDOG drives the cadence. No reboot/CAS/successor.

**Server-side membership on an external join.** `validateCommit` promotes the committing device's `DeviceGroupMembership` to `active` (and adds it to the `group:members:<groupId>` Redis set) when it has no active row yet. An external commit is the ONE join path with no Welcome, so nothing else creates that row - and recipient resolution filters on `status='active'`. Without the promotion the rejoined device is invisible to routing while believing it is a member: its own sends work, but it receives neither the history bundle the reconciliation asks for nor any later live message. Idempotent, and skipped for ordinary commits from existing members.

That promotion passes **`redeliverMissed: false`**, unlike every other activation. The default replay exists for the Welcome path, where the device was pending while messages were sent to the group and has to be handed the window it missed. An external join has no such window: the device is joining at the CURRENT epoch, so replaying older ciphertexts sends it frames it cannot decrypt, and the history it actually needs comes re-encrypted through the reconciliation below.

On a successful external join the device also marks its conversation `active` (external join does not go through the Welcome path that normally promotes it). The pre-join history it cannot decrypt is not asked for here: it comes from the reconciliation that every connection runs, described below.

**History is no longer solicited from the join event, and that whole mechanism is gone.** What stood here until 2026-08-12 - `solicitHistory`, `historySolicit.ts`, the durable `awaiting-history` registry with its 30-day horizon, the `INITIAL_SOLICIT_DELAY_MS` deferral, the retry backoff, the 30 s response window and its "history pending" banner, the vouching that let one member's silence mean "ask someone else" - was measured in production and found unable to terminate: the marker that gated the ask was discharged only by a peer that answered empty AND was not itself awaiting, and both devices of a DM carried one. It is replaced, as a clean break with no compatibility layer, by a **state-key comparison run on every connection**.

The single page for it is **[history-reconciliation](history-reconciliation.md)** - the model, the two boundaries (a shared per-conversation floor and a per-platform device window), the exchange, the scrollback, and every decision behind them. Do not re-derive any of it here. What matters at THIS seam is only the ordering: a join or a reconnect connects, syncs MLS, drains the mailbox to completion (`waitForMessageQueueIdle`, not a delay), and only then compares - because comparing earlier reports a difference the device is in the middle of closing by itself.

**Every bundle names the device it answers.** A `history_bundle` is a group frame, so all members receive an answer meant for one of them. `bundleFrame` (`groupActions.ts`) puts the requester's `digestIdentity` in `to` on every send path - the full store, the id-filtered diff, and the range answer - and the MESSAGES are ingested by everyone (deduped by id, so over-delivery costs bandwidth only). `to` is ADDRESSING, not secrecy - see [durable-rules](../durable-rules.md) on why the `recipients` field of `POST /send` must not be used for it.

**What the bundle carries.** `serializeForBundle` (`groupActions.ts`) sends, per message: `id`, `senderId`, `content`, `timestamp`, plus `reactions`, `isDeleted`, `isEdited`, `editedAt` and `serverTimestamp` when set. Replies need no field of their own - `replyTo` lives inside the serialized envelope, i.e. inside `content`, and travels verbatim. Read state is NOT per message any more: it rides the bundle as the conversation's read watermarks, next to the floor. Pins and system messages are rebuilt by the stream replay when their events are still in the window.

Reception is in two steps, and the order matters. The add-path (`batchAddMessages`) takes only `{senderId, content, messageId, timestamp}` because `AddMessageToChatOptions` cannot carry mutation state; the metadata is merged **afterwards**, onto the messages just added *and* onto any already present (that second half is what makes bundle mutations land on our OWN sent messages, previously skipped as duplicates).

**The unread badge is recomputed, never transported**, and it is derived from the read watermark rather than from any per-message field - see [Read state becomes a watermark](history-reconciliation.md#read-state-becomes-a-watermark).

### Group reset

When no automatic recovery is possible (e.g. all devices diverged):

1. Any device calls `mlsService.sendGroupReset(groupId)` -> POST `/api/mls/groups/:id/reset`
2. Server resets all `DeviceGroupMembership` to `pending`, resets epoch
3. Server broadcasts `group_reset` WS event to all group members
4. Each client: `forgetGroup(groupId)` + marks conversation `isReady: false`
5. The triggering device creates the group fresh and invites all members

### Reconnect after network loss

1. `scheduleReconnect()` -> exponential backoff (1s, 2s, 4s, 8s, 16s, 30s), **saturating at 30s and
   never giving up**: only being logged out or a `SessionExpiredError` (401/403) ends the loop, since
   a transport failure is not an answer. See
   [auth](../frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
   for the 20-attempt latch this replaced and why it stranded desktop tabs for ever.
2. `attemptReconnect()`:
   - `mlsService.connect(token)` -> new WebSocket
   - `fetchPendingMessages()` on WS open
   - `processDeviceInvitationsLocally()` -> re-invite pending devices
   - `discoverMissingGroups()` -> delete local orphans, send `welcome_request` for missing

### Orphan cleanup (reconnect / login)

`discoverMissingGroups()` cross-checks local conversations against the server's group list:
- Groups on server but missing locally -> create stub + send `welcome_request`
- Groups locally but absent from server -> `forgetGroup()` + delete from DB
- Channel conversations (`channel_*`) are never deleted (different encryption scheme)

## Message queue architecture

```
WebSocket frame         fetchPendingMessages()
       |                         |
       v                         v
enqueueMessage()      enqueueMessage()
       |                         |
       +------------+------------+
                    v
             messageQueue[]
                    |
             processQueue()  <-- serialized, one message at a time
                    |
             messageCallback()
                    |
             connection.ts handler
                    |
       processIncomingMessage() / processWelcome()
```

**Welcome priority**: Welcome messages are unshifted to the front of the queue. Non-Welcome messages for groups with a pending Welcome are buffered in `pendingWelcomeGroups` and replayed after the Welcome completes.

**TauriMlsService** uses a `callbackLock` promise chain so `fetchPendingMessages` and `processQueue` never call the Rust layer concurrently.

## Key packages

### The two kinds of key package

A device publishes two kinds, and **the difference is in the crypto, not in the naming**. Both are
minted by one builder, `MlsManager::build_key_package(last_resort)`
(`frontend/mls-core/src/state.rs`), reached through two named entry points; the TypeScript side has
one caller for both, `mintKeyPackages()` in `frontend/src/lib/mls-client/keyPackages.ts`.

| | Static fallback | One-time prekey (OTKP) |
|---|---|---|
| Server row | `key_package`, one per device, replaced on each connection | `one_time_key_package`, a pool, FIFO |
| Served when | the pool is empty - to **every** caller, unchanged | there is one left; the row is deleted with the claim |
| MLS marking | `last_resort` extension, `LastResort` in the leaf capabilities | none |
| After a join | private bundle **kept** | private bundle deleted by `into_group` |

**Why the fallback must be `last_resort`, and what it cost to find out.**
`resolveKeyPackagePayloadForDevice` returns `otkp?.keyPackage ?? device.keyPackage`, so an empty
pool means the same bytes go to every peer until the device next connects. That is deliberate -
without it, a device whose pool ran dry could never be added to a group again. But OpenMLS deletes
an ordinary KeyPackage's private bundle the moment a Welcome built on it is processed
(`openmls-0.8.1/src/group/mls_group/creation.rs:605`), so an unmarked fallback was good for exactly
one join. Measured on the Mi 9T on 2026-09-06: a device re-entering ten groups at once got ten
Welcomes built on the one fallback the server had, joined the first, and answered the other nine
with `NoMatchingKeyPackage [n_secrets=3..5]` - nineteen times. It then sent another
`welcome_request`, the responder kicked and re-added it on the same dead package, and nothing broke
the loop until the next reconnection replaced the row. From the notification shade the same event
reads `Nouveau message de <name>` with nothing under it: the group could not be joined, so the
message could not be decrypted.

`frontend/mls-core/tests/last_resort_key_package.rs` pins both halves - the fallback must survive
being served twice, the pool prekey must not - and
`apps/chat-delivery-service/src/controllers/devices.controller.static-fallback.spec.ts` pins the
server's side of the promise, so the pair cannot drift apart silently.

### Static fallback key package

- Generated on every `generateKeyPackage()` call, and published before the pool.
- Stored server-side as the device's main KP.
- Used when all OTKPs are exhausted - which the server now says out loud (`[KP] one-time pool
  EMPTY`), because a client that has stopped replenishing is invisible from anywhere else.

### One-time key packages (OTKP / prekeys)

- Pool of 50 (web) / 200 (Tauri) replenished on connect. Target: 20, threshold: 5.
- Atomically consumed by inviting devices.
- On fresh start: old OTKPs have no matching private keys -> purged via `DELETE /api/mls/devices/:userId/:deviceId/prekeys` **before** generating new ones. `freshStart` is `!state`, so this is a NEW INSTALL and not a launch - it is not what accumulated the bundles measured below.
- Every bundle a device mints stays in its local keystore until its 84-day lifetime elapses; see the section below for what one weighs and what bounds the pile.

### What a key package WEIGHS, and the prune that bounds it

Minting one writes its private bundle into the provider's storage, and until 2026-09-06 nothing ever
deleted one. `frontend/mls-core/tests/state_weight.rs` is the measurement - IGNORED by default,
because a number is not a pass or a fail and pinning today's bytes would only manufacture a failure
the first time a legitimate field is added:

```
cargo test --release --test state_weight -- --ignored --nocapture
```

| what | bytes | how it was read |
|---|---|---|
| one-time prekey bundle | **1 936** | four rounds of 50, slope |
| a group of one | 5 330 | four rounds of 10 - a FLOOR, no members, no history |
| one member added to a group | ~2 000 | four rounds of 5, each from its OWN device |
| **50 sends** | **~0** | flat after the first batch |

Two things follow, and both were assumptions before. **Sends are flat, so message history is not
what makes a blob heavy** - a device that has simply been used for months does not explain itself.
And in a state holding 41 groups AND 200 prekeys, the prekeys are **60.1%** of it. The docblocks in
`TauriMlsService` and `WebMlsService` that justify a pool of 50 said "each ~400 bytes"; they were
wrong by five times, which is what made "hundreds of unused bundles" sound affordable.

**The asymmetry that leaked.** `reconcilePublishedKeyPackages` purges the SERVER of a prekey whose
private key is gone locally. Nothing asked the opposite question, so a bundle the server had stopped
publishing was kept for ever, and two callers mint without bound: `generateKeyPackageImpl` publishes
a fresh last-resort package on **every connection**, and `republishKeyMaterial` purges the pool and
mints up to 50 more **once per 30 s** through a `NoMatchingKeyPackage` storm - ~97 kB orphaned each
round. The Mi 9T came out of the 2026-09 healing campaign with a 19 548 753-byte `mls.bin`, ~200
such rounds, a 17-second checkpoint and a 22-second unlock.

**`MlsManager::prune_expired_key_packages` deletes every stored bundle whose lifetime has elapsed,
once per load.** It hangs off `load_or_create`, and `load_with_key` delegates there, so the web
client, the native client and the background FCM path all shed through one seam - no timer, no
second path. A failure is logged and does not fail the load: a device that cannot shed still works,
one that refuses to load has lost everything.

**Why expiry, and not "the server no longer publishes it".** The delivery service DELETES a one-time
prekey as it hands it out, so absence from the server is exactly what a bundle looks like when a peer
is about to send the Welcome built on it - pruning on that signal would race a join and lose it. An
elapsed `not_after` has no such ambiguity: openmls defaults it to 84 days, and a Welcome referencing
an expired KeyPackage is invalid under RFC 9420. The delete is confined to what could not have been
used anyway, needs no server round-trip and races nothing. The clock is a PARAMETER
(`prune_key_packages_expired_at`) so `tests/prune_expired_key_packages.rs` can ask what the state
looks like in a hundred days without asserting on a wall clock.

**The prefix is an optimisation; the identity check is the safety property.** The scan first matched
`b"KeyPackage"` and decoded - and replacing that prefix with `b""`, matching every entry in the
state, left all four tests green, including the one asserting groups survive. The real refusal was
`serde_json` failing to decode group state as a `KeyPackageBundle`, which is luck: serde ignores
unknown fields. Each candidate now recomputes its own `hash_ref` and must be named by the key it is
stored under - exact by construction, since `openmls_memory_storage` builds every key as
`label || json(id) || version`.

**WHAT A REAL DEVICE'S STATE IS MADE OF, READ OFF THE PHONE RATHER THAN INFERRED** (Mi 9T,
2026-09-06, one line at load from `MlsManager::state_composition`):

| part | entries | bytes | share | each |
| --- | --- | --- | --- | --- |
| **KeyPackage** | **2 338** | **5 523 276** | **69%** | 2 362 |
| MessageSecrets | 5 | 1 220 171 | 15% | 244 034 |
| Tree | 5 | 1 208 632 | 15% | 241 726 |

**Accumulated key package bundles are two thirds of it** - 2 338 of them on a device whose server
pool holds fifty. **None had expired**, because the pile accumulates in weeks and openmls dates a
key package 84 days ahead: the prune bounds the ceiling but its horizon never arrives at this mint
rate, which is why a tighter or count-based retention is still owed ([backlog](../backlog.md)).

**A REAL GROUP IS ~490 kB, AND NOT FOR THE REASON THAT LOOKED OBVIOUS.** The weight is `Tree` - the
member leaves a long-lived group accumulates, ~242 kB being roughly 120 of them - and
`MessageSecrets`, the per-sender ratchet history that `SenderRatchetConfiguration::new(2000, 2000)`
sizes on purpose. It is NOT epochs:

**WHAT IS BOUNDED AND WHAT IS NOT, MEASURED RATHER THAN DIVIDED.** `what_an_epoch_costs_at_constant_membership`
churns one device in and out of a group forty times: at **81 epochs the state PLATEAUS at 17 364
bytes**, growth stopping after the second round, with `MessageSecrets` and `ResumptionPsk` holding
ONE entry each. **Accumulated epochs are therefore NOT what makes a long-lived group heavy** - the
obvious suspect, eliminated. The field number that prompted it: sweeping 42 abandoned groups off a
Mi 9T took `mls.bin` from 20 812 360 to 8 018 495 bytes and a checkpoint from 48 449 ms to 6 943 ms.
What remains expensive about a real group is not yet named, and
`MlsManager::state_composition` exists so the next occurrence is read off the device rather than
inferred - which is how the same question got two wrong answers in one evening.

**What this does NOT do.** It bounds growth at (mint rate x 84 days) and does not shrink a blob whose
bundles are younger. Two accrual paths remain open in [backlog](../backlog.md): reusing a still-valid
last-resort package instead of minting one per connection, and `republishKeyMaterial`'s 50 orphans.
**The obvious fix for the second is wrong** - dropping the local bundles when the server pool is
purged races a peer that claimed one seconds earlier with the Welcome still in flight. The
discriminator exists only on the server: a claim and the row's deletion are atomic, so anything still
present when `DELETE .../prekeys` runs is provably unclaimed. The endpoint returning the ids it
deleted would let the client drop exactly those, with no race and no clock.

## How the state is encoded inside the envelope (WP-ANR-1, 2026-08-11)

The envelope above is the SEAL. Inside it, `PersistedState` is CBOR, and how its byte buffers are
framed is a second at-rest format with its own compatibility rule.

**serde has no dedicated `Vec<u8>`.** A derived `Deserialize` routes it through the generic sequence
path, so ciborium wrote every buffer as a **CBOR array of integers** and read it back with one CBOR
header parse *per byte*: `Vec<u8>::deserialize` -> `deserialize_seq` -> `VecVisitor<u8>::visit_seq`
-> `SeqAccess::next_element::<u8>` -> `Decoder::pull` -> `Header::try_from`. Every buffer in the file
was on that path - `identity_bundle`, the whole OpenMLS keystore (`storage_values`), `group_ids`,
and the identity `keypair`/`credential` - and `serde_bytes` appeared nowhere in the repo.

`mls-core/src/byte_compat.rs` fixes it with `serialize_bytes` plus a visitor that accepts a byte
string **or** the legacy sequence. Measured on a 1.59 MB fixture, release build:

| | legacy | byte string |
|---|---|---|
| size | 1 586 917 B | 794 938 B (**x2.00** smaller) |
| decode | 21.6 ms | 0.5 ms (**x45** faster) |

Re-run it with
`cargo test --release --test state_cache -- --ignored --nocapture legacy_decode`. Two honest caveats
on the field figure that motivated this: the 58.6 s of CPU captured in the ANR was a **debug** APK
(debug is ~10x release on the same fixture), and the multiplier that turned a slow read into a
freeze was the per-message reload in the outbox drain, fixed separately - see
[mobile > the drain is a BATCH](../frontend/mobile.md#the-drain-is-a-batch-and-every-part-of-its-shape-is-load-bearing-wp-anr-1-2026-08-11).

**The compatibility contract, and the one-way step.** The reader for the legacy encoding ships in the
same commit, so any existing `mls.bin` or IndexedDB blob loads unchanged and is rewritten in the new
encoding at its next save. The reverse does not hold: **a device that has already migrated cannot be
read by a build older than that commit (`01bc0a13`, WP-ANR-1).** The frontend must not be rolled back past it, or every
migrated user loses their identity and every group. Decision taken deliberately 2026-08-11
(one-step: read both, write new now).

The tests that hold this up, and what each would catch:

- `byte_compat::reads_a_legacy_array_of_integers_file` - the framing.
- `state_cache::a_legacy_encoded_state_still_loads_and_is_migrated_on_save` - a **real** snapshot
  (keypair, credential, keystore, group ids) re-encoded the legacy way, through `load_or_create`.
- Negative control run 2026-08-11: deleting the `visit_seq` arm fails exactly those two plus
  `an_empty_buffer_survives_both_encodings`, and nothing else.

`StateSnapshotCache::from_loaded` was **deleted** as part of this. Seeding the cache with the bytes
just read handed them straight back to the first `save_state`, which would have pinned a
legacy-encoded file in place for ever. A reload now always re-encodes, so the migration happens once
per session rather than depending on what the user does next - which is also why
`a_reloaded_state_re_encodes_and_preserves_its_content` asserts CONTENT equality and not byte
equality (`storage_values` is an unordered `HashMap`; the CBOR is not deterministic).

## Failing to load a saved state

`loadStateWithKey` can reject three ways. Two are told apart by
`BaseMlsService.classifyStateLoadFailure`; the third is checked first because it looks exactly like
`sealed` and has a completely different answer.

### An envelope older than v0.11.0

Before v0.11.0 the snapshot was sealed `[salt (16) || nonce (12) || ciphertext]` with
Argon2id(PIN, salt). v0.11.x seals `[nonce (12) || ciphertext]` with the PBKDF2 device key, and
shipped no reader for the old envelope - while `CanariDBMls_<userId>` stayed pinned at schema
version 1 and native `mls.bin` carries no version either. Nothing rewrote or dropped those blobs,
so on the first v0.11.x login they fail to decrypt and are indistinguishable from a key rotated
elsewhere. Reported as such, they sent every upgrading user into an old-PIN recovery that could
never succeed.

So on a `sealed` verdict, when the caller supplied `MlsInitOptions.legacyPin` (the PIN just
verified server-side; absent on the biometric and vault paths), the legacy envelope is tried once:

| Platform | Entry point | On success |
|---|---|---|
| Web | `migrateLegacyMlsStateBlob` (`mlsWasmLoader.ts`) - `decrypt_with_pin` then `encrypt_mls_state_blob_with_key` | `_initImpl` reloads from the re-sealed bytes and `saveMlsState`s them |
| Tauri | `legacyPin` forwarded to `initialiser_mls`; `migrate_legacy_state_blob` in `commands/mls.rs` | Rust re-seals and `write_mls_state_blob`s before returning |

Persisting is part of the migration, not a follow-up: a snapshot left in the legacy envelope
replays the conversion at every launch, and any failure in between resurfaces as the same false
"PIN changed on another device". The layout both sides depend on is locked by
`mls-core/tests/legacy_state_envelope.rs` - **if the envelope changes again, ship the reader for
the previous one in the same commit.**

A blob the PIN does not open falls through to the table below, so a genuine rotation still gets
its recovery.

**Opening the envelope says nothing about whose state it is.** A snapshot written before an
interrupted fresh start carries the previous device's credential, so the re-sealed bytes can still
be rejected - with a `mismatch`, not a `sealed`. The verdict is therefore re-read from the
migration's own failure and applied by the normal path below. Doing this from inside the first
`catch` is what let a raw `Credential identity mismatch` escape `init` instead of fresh-starting.

### The two `classifyStateLoadFailure` verdicts

| Verdict | Meaning | Recovery |
|---|---|---|
| `sealed` | The blob would not decrypt (AEAD failure): the account key was rotated on another device. | Honour `MlsInitOptions.noFreshStart`: throw `MLS_LOCAL_STATE_UNDECRYPTABLE` so the caller can offer the old PIN and recover the history intact. |
| `mismatch` | The blob decrypted; its credential names another device (localStorage cleared, reinstall, or an interrupted fresh start). | Fresh start. `noFreshStart` does NOT apply - no PIN can repair an identity, so pausing would strand the user. |

Fresh start, in order:

1. Generate a new device ID and write it to `mls_device_id_{userId}`.
2. `loadStateWithKey(key, undefined)` -> empty client.
3. **Persist immediately** (`saveState` -> `mls.bin` / IndexedDB) - see below.
4. `deleteDevice(userId, oldDeviceId)` -> cleans up server registrations.
5. Continue as a fresh start (OTKP purge + new KP registration).

Step 3 is load-bearing. Without it the new device ID lands in localStorage while the OLD blob
stays in storage, so the next launch mismatches again and mints yet another device - a loop that
produced four device IDs in eight seconds in production, each deleted server-side, none ever
publishing a KeyPackage.

Step 3 is also where a broken save becomes fatal rather than merely logged - see the worker
contracts below.

## Worker message contracts

Three workers carry MLS work off the main thread: `mlsEncrypt.worker` (seal a snapshot),
`mlsCrypto.worker` (warm client for catch-up decryption), `mlsKeyPackage.worker` (key package
generation). Their request/response shapes live in `src/lib/mls-client/mlsWorkerProtocol.ts` and
are imported by **both** ends.

That single module is not tidiness. A `postMessage` argument is structurally typed by whatever the
call site writes, so an object literal built inline is checked by nobody: the v0.11.0 PIN ->
deviceKey rename updated the encrypt worker's destructuring to `deviceKeyB64` and left the sender
posting `pin`. The worker then sealed with `undefined`, wasm-bindgen read `undefined.length`, and
every state save through the worker failed. On the checkpoint paths that rejection was only
logged; on the fresh-start path, which awaits the save (step 3 above), it aborted login with
`can't access property "length", e is undefined`. Same failure mode as an `invoke()` name that
matches no `#[tauri::command]` - **a string or shape crossing a boundary is unchecked unless one
declaration governs both sides.**

`mlsEncryptWorkerSession.test.ts` drives the real worker handler with the real posted message, so a
field renamed on one side alone fails the suite as well as `svelte-check`.

## History replay

`replayConversationHistory()` in `history.ts`:

1. Load `lastStreamId` from localStorage (incremental - avoids re-processing consumed ratchet keys).
2. Fetch Redis Stream from `/api/mls/history/:groupId?after=<streamId>`.
3. For each message: use Redis Stream ID as deduplication fingerprint.
4. `processIncomingMessage()` -> decrypt -> `appMsgToEnvelope()` -> dispatch.
5. Permanent same-epoch errors (`CannotDecryptOwnMessage`, `SecretReuseError`) -> add to seen fingerprints -> skip.
6. Recoverable errors (`epoch-gap` = future frame we are behind; `wrong-epoch`) -> kept **un-seen** so a later load after epoch catch-up can decrypt them. Bounded by a per-ciphertext retry ledger (`history_retry_cipher:*`, cap `MAX_HISTORY_DECRYPT_RETRIES`): a frame that stays undecryptable across that many replay runs is a permanently-undecryptable frame (an external joiner's pre-join / forked-epoch ciphertext), so it is finally marked seen and the cursor advances past it - this stops the per-sync `Sender data decryption error` refetch storm. `epoch-gap` still sets the stale-gap flag (`shouldFlagStaleEpochGap`) so a genuinely stuck-behind group is escalated to forget + re-Welcome.
7. Save `lastStreamId` (and the retry ledger) for next fetch - deferred to the post-checkpoint commit thunk so durable progress never runs ahead of the persisted ratchet.

## Multi-tab leadership

`initTabLeadershipAsync()` uses a `BroadcastChannel` + heartbeat to elect a single leader tab. Only the leader tab opens the WebSocket and runs `discoverMissingGroups`. Follower tabs skip `initializeConnection()` entirely.

## Bugs fixed by the 2026-06 rewrite

| Bug ID | Description | Fix |
|---|---|---|
| S2 | Static fallback rotation | Rotated on every connection by `syncConnectionAfterWsOpen` |
| S5 | Stale `lastKnownState` passed to worker | Fresh state passed at each generation |
| C1 | Ambiguous null `ProcessResult` | Typed `ProcessResult` |
| C2 | False positive null counting | Removed |
| C3 | Poison Pill on transient failure | Removed |
| C4 | Orphan group CAS race | Retry cleanup in catch |
| C5 | `deleteAll` before generate (wrong order) | Generate first, delete after |
| C7 | Buffer drop silently | 10s buffer + explicit ACK |
| C8 | Migrate without dedup | Check `conversations.has(to)` |
| R1 | Watchdog vs Welcome race | Timer cancelled on WASM ok |
| R2 | Insufficient coalescing | `timers.has(groupId)` gate |
| R3 | Double `welcome_request` in two-pass | Single pass with `seen` Set |
| R4 | `addMembersBulk` without epoch | `runCommitTransaction` stage->validate->merge |
| R5 | Silent add-lock failure | 2s retry |

## Earlier bug fixes (pre-rewrite)

| Commit | Fix |
|---|---|
| `8cd8d94` | Orphan group cleanup: `discoverMissingGroups` deletes local groups absent from server |
| `851f37a` | Welcome callback overwrite: removed duplicate `onWelcomeRequest` from `connection.ts` |
| `851f37a` | Welcome buffer recovery: re-queue buffered messages when Welcome throws |
| `851f37a` | `WebMlsService` credential mismatch recovery (mirror of TauriMlsService) |
| `851f37a` | `WebMlsService` OTKP purge on fresh start + `DELETE /prekeys` backend endpoint |
| `bccd872` | Remote reactions not rendering; delete/edit reactivity (Svelte 5 `conversations.set()`) |
| `7abba95` | `addMessageToChat` positional API -> options object (`messageId`, `replyTo` were silently discarded) |
| `2009dd4` | Centralised `MessageReference` / `AddMessageToChatOptions`, unified `appMsgToEnvelope()` decoder |
| `2654acb` | Remove legacy fallbacks (base64 proto, old JSON format, plain-text) |
