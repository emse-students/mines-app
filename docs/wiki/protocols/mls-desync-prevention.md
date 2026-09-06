# MLS desync prevention

Tactics used to keep **server routing / epoch tracking**, **OpenMLS group state**, and **delivery order** aligned. Pair with [`mls-recovery-ladder.md`](mls-recovery-ladder.md) for what happens _after_ a fault is detected.

Run the MLS service and call-site suites in `frontend` after changing **`runCommitTransaction`** or the staged commit primitives (`stageAddMembers` / `mergePendingCommit` / `clearPendingCommit` / `exportRatchetTree`).

## Ordered tactics (by layer)

### 1. Server - epoch-gated commits

- **`POST /api/mls/commit`** — `baseEpoch` must match the group row **`activeEpoch`** (except fast-forward when `activeEpoch === 0`). A **Redis lock** (`mls:commitlock:{groupId}`) serializes concurrent validators so two devices cannot both advance from the same epoch. On success, the commit bytes are stored in the commit-log and **`activeEpoch ← baseEpoch + 1`** atomically, then fanned out. Rejects: **`epoch_mismatch`**, **`concurrent_commit`**, and **a commit carrying no `proto`** — a
  commit nothing can replay may not advance the epoch. Source: `app.controller.ts` → `validateCommit`.

  **"ATOMICALLY" WAS THIS PAGE'S CLAIM BEFORE IT WAS THE CODE'S, AND THAT COST A CONVERSATION AN
  EPOCH.** Until 2026-09-02 the insert sat OUTSIDE the transaction that advanced `activeEpoch`,
  wrapped in `try`/`catch` → `logger.warn` and reasoned as best-effort. `IDX_mls_commit_log_group_epoch`
  is UNIQUE on `(groupId, baseEpoch)`, so a row skipped there can never be written by anybody: epoch
  121 of DM `7da231f8` is absent from a log running 0..129, permanently, and every device stopped at
  121 needs a full rung-2 re-Welcome for the life of the group. The insert now shares the
  transaction, and a failure fails the commit — one round-trip for the committer instead of a hole
  for everyone.

- **A SEND FROM A DEVICE THAT HOLDS NO LEAF IS REFUSED, NOT FANNED OUT.** `status = 'active'` gated
  recipient resolution and nothing gated the SENDER, so a `pending` device's six messages became
  thirty rows of ciphertext nobody in the group could open (prod, 2026-09-02, 24 seconds).
  `sendMessage` now reads the sender's own `dm_device_group_memberships` row before resolving any
  recipient and answers **`403 sender_not_active`** with the status. Handshake frames (Welcome,
  Commit) are exempt: they are the path OUT of `pending`, and refusing them would make the gate a
  deadlock. A missing row is logged and allowed — that is an external join in flight.

### 2. Server - coordinated reset and bootstrap

- **`POST /api/mls/groups/:groupId/reset`** (**group_reset**) — Sets memberships to **pending**, **`activeEpoch = 0`**, clears Redis **`group:members`**, notifies clients (WebSocket + queued offline rows). Prevents forked MLS sessions from diverging without a shared line in the sand.

- **`POST /api/mls/groups/:groupId/claim-bootstrap`** / **`GET …/bootstrap-info`** — **Optimistic lock** on **`bootstrapVersion`** so only one device wins re-creation of a group.

### 3. Server - add-member races

- **`POST/DELETE /api/mls/add-lock`** — Redis lock **`mls:addlock:{groupId}`** so only one inviter runs **add member + Welcome** at a time for that group. Used from **`processPendingInvitations`** and discovery re-bootstrap.

### 4. Client - one staged commit regime (ADD + REMOVE)

- **`runCommitTransaction(groupId, stageFn, opts)`** in **`BaseMlsService`** — the single primitive behind **every** structural commit. Under the MLS lock: stage the commit WITHOUT merging (`stageAddMembers` / `stageRemoveMembers*`), read the current **pre-merge** epoch (`freshEpoch`), **`validateCommitEpoch(groupId, baseEpoch)`**, then on accept **`mergePendingCommit`** + broadcast (and **`exportRatchetTree`** for an ADD Welcome), on reject **`clearPendingCommit`** and throw. Because the merge happens only after the server accepts, a rejected commit never advances the local epoch — the whole class of "sender fork" desyncs disappears. `baseEpoch` is the raw current epoch (no `-1` formula: nothing is merged before validation). The platform primitives (`stage*` / `merge` / `clear` / `exportRatchetTree` / `freshEpoch`) are the only pieces that differ between WASM (`WebMlsService`) and native (`TauriMlsService`).

- **Tauri** — **`_epochByGroupId`** + **`refreshEpochCache`** keep **`getEpoch()`** meaningful for validation and UI; `freshEpoch` reads the authoritative pre-merge epoch via `obtenir_epoch`; **`forgetGroup`** clears the cache.

### 5. Client - message ordering and gaps

- **Queue priority (Tauri)** — **`group_reset`** control → **Welcome queue** → **application queue** so resets and welcomes are applied before ciphertext that assumes a joined epoch.

- **Rust / WASM epoch gap** — **`frontend/mls-core`** (and Tauri path) detect **message epoch > group epoch** and fail fast so the caller can run **gap recovery** instead of consuming ratchet material incorrectly.

- **Commit-log replay (rung 1)** — on that gap, the pipeline (`setupMessageHandler` → `attemptCommitReplay`) fetches the missed ordered commits from the server commit-log (**`GET /api/mls/commits/:groupId?sinceEpoch=N`**, written atomically with the epoch advance in **`POST /api/mls/commit`**) and re-applies them to catch the epoch up **without dropping state**. Only a below-floor (pruned) commit, a NAMED HOLE, or an unapplicable one falls through to the destructive rung-2 forget + re-Welcome. See [`mls-recovery-ladder.md`](mls-recovery-ladder.md) step 4.

- **A HOLE IN THE MIDDLE OF THE LOG IS AN ANSWER THE SERVER GIVES, not one the client discovers by
  failing.** `belowFloor` only ever described the START of the requested range, so a device at 120
  handed `[120, 122, 123, …]` applied 120, threw on 122, froze its outbox and waited out
  `EPOCH_GAP_ESCALATION_MS` — 30 seconds during which every arriving frame was ACKed and dropped.
  `getCommitsSince` now walks for contiguity, truncates at the first missing epoch and returns it as
  **`gapAt`** (also when the log simply stops short of `activeEpoch`); `attemptCommitReplay` treats it
  as terminating and applies nothing, and `setupMessageHandler` escalates to rung 2 on that proof.
  PRUNING and a HOLE stay separate: both end rung 1, only the second accuses the commit path, so
  `belowFloor` suppresses the `gapAt` report rather than doubling it.

- **`connection.ts`** — Rung-2 fallback: stale decrypt / epoch error patterns can trigger **`forgetGroup`** + **`sendReinviteRequest`** when local epoch is behind the message and rung-1 replay could not catch up (see `[RECOVER]` / `[GAP]` logs).

### 6. Client - discovery re-bootstrap (stale placeholder)

- **`discoverMissingGroups`** (**`actions.ts`**) — **`sendGroupReset`** must succeed **before** **`forceCreateGroup`** + commits; otherwise **`epoch_mismatch`** would return. **`acquireAddLock`** reduces duplicate bootstraps. **`epoch_mismatch`** after reset → **`forgetGroup`** + retry path.

- **`create_group` vs `force_create_group`** — two entry points that differ in exactly one way, and
  picking the wrong one desyncs the group. `create_group` (WASM `create_group`, Tauri `creer_groupe`)
  REFUSES to create a group that already exists locally, signalling `GroupAlreadyExists` so the caller
  can skip a re-bootstrap it does not need; it is the normal entry point.
  `force_create_group` (WASM `force_create_group`, Tauri `forcer_creation_groupe`) overwrites without
  consulting local state — any existing `MlsGroup` for that `group_id` is replaced silently. Overwriting
  a LIVE group costs epoch divergence and a broken ratchet for every other member, so it belongs only
  in a controlled re-bootstrap: after a server `group_reset` and a local `forgetGroup`, never on its own.
  Implementation: [`frontend/mls-core/src/group.rs`](../../../frontend/mls-core/src/group.rs).

### 7. Client - persistence write-if-newer (Web/IndexedDB)

- **Monotonic snapshot version** (**`utils/hex.ts`**) — the encrypted MLS checkpoint is written under a **write-if-newer** guard. Every serialized snapshot is tagged (`tagMlsSnapshot`) with an increasing version at the synchronous capture moment; the version rides with the bytes via a `WeakMap` (`propagateMlsSnapshotVersion` across the plain→encrypted step) so the off-thread Argon2 encryption cannot reorder it. **`saveMlsStateEncrypted`** does an IDB read-modify-write and refuses any blob whose version is not strictly newer than the stored **`MLS_STATE_VERSION_KEY`**. This stops a slow encrypted flush (`mlsStatePersister`, worker Argon2) from overwriting a fresher concurrent write (`generateKeyPackage`, main-thread Argon2) — which would silently regress the persisted epoch on the next reload. The in-memory counter is reseeded from the stored version at load (`seedMlsSnapshotSeq`) so a fresh session never emits a version below what is already on disk. Only a plain integer is stored — no groupId/epoch at rest, so privacy is unchanged. Web-only: Tauri persists to the filesystem under its own `mls_bin_write_lock`.

### 8. Client - no state replacement may rewind this device's own send ratchet

**A REPLACEMENT GUARD MUST MEASURE THE THING AT RISK.** Every path that replaces the live MLS client
has the same shape - snapshot, work on the copy, install the result - and every one of them is a
window in which the live client can advance. `sendMessage` is exactly that: it moves this device's
send ratchet. Install a state taken before it and the ratchet goes BACK; the next frame re-issues a
spent generation, and the peer refuses it with `SecretReuseError`, reporting - correctly - that the
sender's ratchet rewound. The frame is not lost, but the receiver files it as a loss and pays a full
history reconciliation to discover that both sides already agree.

Every such seam therefore passes **two** guards, and neither substitutes for the other:

- **Epoch-monotonic** (`swapClientMonotonic` on web, `MlsManager::reload_is_monotonic` in mls-core):
  refuses a candidate that would move a live group to a LOWER epoch. This answers "is this snapshot
  from an older epoch" **and nothing else**.
- **Not-overtaken** (`installUnlessOvertaken` on web, the unpersisted-send watermark in
  `TauriMlsService.reloadStateFromDisk`): refuses a candidate derived before a send this device has
  already made. A generation that moved INSIDE one epoch is invisible to the epoch guard, which is
  why the epoch half alone let this defect run.

The counter is `BaseMlsService.liveMutations`, read at the snapshot and again at the install: a COUNT
rather than a flag, because the question compares two instants rather than asking "recently?".

The send seam feeds it. `sendMessage` is concrete in `BaseMlsService` and carries all three
outbound invariants - wait for catch-up idle, count the mutation, checkpoint it - so a platform
supplies only `encryptForSend`. It became a template method the day the checkpoint was found at TWO
of the EIGHTEEN call sites that reach a send: the other sixteen (read receipts, reactions, edits,
deletes, pins, group control, calls) advanced the ratchet and persisted nothing, leaving `mls.bin`
structurally behind the live client. A rule each caller has to remember is a rule the next caller
will not.

**DURABILITY MUST NOT GATE DELIVERY, AND THE GUARD DOES NOT SURVIVE A PAGE LOAD.** Two things were
measured on 2026-08-14 that this section did not account for, both now fixed.

The first: `endBulkIngest` awaits every observer, and the persister's `onBulkIngestEnd` awaited the whole
encrypted checkpoint - so a frame that arrived during the flush was not decrypted until the disk
answered. Measured at **8.0 s on a cold web client** and **3.2 s on the phone**, with an ordinary
50 ms API round trip inside the gap proving nothing else was blocked, against 279-327 ms on the four
passes that did not hit it. The flush is now started and not awaited. Nothing is risked: ordering is
already held by the monotonic snapshot version (section 7), and this checkpoint carries INBOUND state,
which a reload recovers by replaying from the server. `saveState`'s own cost is now logged separately
from the sealing, because they are different questions and neither had ever been printed.

The second: `liveMutations` and every watermark compared against it are **per-page-session** state,
while the OUTBOX is durable. A client that sends, is reloaded before the checkpoint lands, and then
drains its queue encrypts those entries against an `mls.bin` that is behind its own previous sends -
and the peers refuse them with `SecretReuseError`. Reproduced twice on a settled fleet.

The invariant is *`mls.bin` is never behind a frame that has already left the device*, and it was
first read as "only an awaited checkpoint on the send path can hold it". **That reading was wrong,
and the measurement below is what refuted it**: awaiting costs 1.7 s per message on a phone, which is
not a trade worth making. The invariant does not in fact require the state to be durable at send
time - only that a state restored behind it be RECOGNISED and repaired, which is a counter and a burn
rather than a disk write. `BaseMlsService.checkpointAfterSend` therefore keeps its non-awaiting
default on both platforms.

**THE MEASUREMENT REFUTES THE OBVIOUS FIX, AND FOUND A DIFFERENT DEFECT INSTEAD.** The split log
priced a native checkpoint at **3.7 s, of which `saveState` alone is 1.7 s** (1683 / 1690 / 1761 ms
on three consecutive sends, A1, 2026-08-14). So awaiting on native costs 1.7 s **per send**, which
is not a trade worth making, and the earlier "~80 ms" estimate this decision was first taken on was
wrong by a factor of twenty. The remaining 2.0 s was the real find: the persister called `saveState`
and then `saveMlsStateEncrypted`, which is one durable write on web and **two on native** - native's
`sauvegarder_mls_et_persister` has already written `mls.bin` when it returns, so the second call
wrote the same file with the same bytes, marshalled through IPC as a `number[]`, the exact cost the
single-invoke design existed to avoid. The codebase already knew this, on `persistFreshState`; the
checkpoint path carried its own copy of the answer and the copy was wrong. Fixed by making
`IMlsService.persistCheckpoint` the one seam every checkpoint goes through - `rotateDeviceIdentity`,
the persister, the structural checkpoint - so no caller has to know which platform it is on.

**THE FIX IS NOW MEASURED ON HARDWARE, AND THE DUPLICATE IS GONE** (A1, new APK, 2026-08-15). A
green build proves nothing about a write, so the number was read off the phone actually running:
**1 454 / 1 510 / 1 512 / 1 560 / 1 597 ms, median 1 512 ms** over one MSG pass - against 3.7 s
before, and slightly under the 1.7 s the split log predicted would remain. Web on the same run, for
scale: median 58 ms over 37 checkpoints.

Nothing needed instrumenting - the persister already logs `[MLS] Encrypted state checkpoint
persisted. (N ms)`. What needed care was ATTRIBUTION, because one capture holds several consoles and
a native checkpoint costs twenty-five times a web one: averaged together they produce a number
belonging to no device. `ckpt.mjs` calls a stream native only when its OWN lines say `mode=tauri`,
and the check is self-proving here - the only streams that matched were the two named `a1`.

What is still owed for the outbox hole is therefore NOT an awaited checkpoint. The shape that fits
the cost is a durable record of what the ratchet has already spent, written per send at the price of
a key/value write rather than a snapshot, and consulted at load.

> **THAT RECORD WAS BUILT - IT IS THE SUBSECTION DIRECTLY BELOW, SHIPPED 2026-08-14.** This paragraph
> states the DEBT and the next one records its PAYMENT, and reading the first without the second is
> not a hypothetical failure: a P1 was filed on 2026-09-06 concluding *"that record has not been
> written"*, which would have had someone rebuild `sendRatchetLedger.ts` from scratch. **What the
> ledger covers is the JS load path**; the native outbox drain is a separate engine that does not
> consult it, and that gap - not a missing ledger - is what remains open in
> [backlog](../backlog.md).

#### The burn - designed against the OpenMLS source and shipped 2026-08-14

**THE REPAIR IS A BURN, AND THIS CLIENT'S OWN RATCHET CONFIGURATION IS WHAT MAKES IT SAFE.** Read in
`openmls-0.8.1/src/tree/sender_ratchet.rs`, against the configuration `mls-core/src/group.rs`
already sets for every group it creates or joins - `SenderRatchetConfiguration::new(2000, 2000)`:

- **an encryption ratchet has no public way to move without producing a frame.**
  `RatchetSecret::set_generation` is `#[cfg(test)]` and `ratchet_forward` is `pub(crate)`, so
  advancing the send ratchet by N means encrypting N times and discarding the ciphertext. That is
  the entire implementation, and there is no other one to look for.
- **a receiver ratchets FORWARD on demand and keeps what it skips.** `secret_for_decryption` derives
  every generation between its head and the one asked for, pushes each into `past_secrets` as
  `Some`, and refuses only past `maximum_forward_distance`. So burning more than was really spent
  costs a handful of unused 48-byte keys and nothing else - and a frame still in flight during the
  burn decrypts afterwards out of that same window (`out_of_order_tolerance`, also 2000).
- **reuse is the one thing it will not forgive.** A generation already consumed is `None` in
  `past_secrets`, and `.take()` on it returns exactly `SecretReuseError` - the error the peers
  reported, from the one branch that can produce it.

**The failure mode is therefore asymmetric, and every rounding decision leans on that**: burning too
FEW reproduces the defect, burning too MANY is free. This is what lets the deficit be estimated
rather than measured, and it is why the design below needs no new atomicity anywhere.

**THE DEFICIT IS COUNTED OUTSIDE `mls.bin`, BECAUSE `mls.bin` IS THE THING THAT IS WRONG.** Per
group, two numbers:

- **emitted** - frames this device has encrypted, bumped in `sendMessage` the instant
  `encryptForSend` returns and BEFORE the POST. In `localStorage`, because it is the only store that
  is both synchronous and survives the teardown that opens this window; an async store has the same
  race as the checkpoint it exists to compensate for.
- **persisted** - what `emitted` was when the last successful checkpoint was TAKEN: read before
  `saveState` is called, written after it resolves. In that order and no other. A send landing during
  the save is then counted as unpersisted and over-burns by one; the reverse order under-burns, which
  is the defect itself.

At load, `deficit = emitted - persisted`; for each group with a positive one, encrypt-and-discard
that many times, reset the pair, checkpoint.

**What it deliberately does NOT do is change the serialised state format.** Carrying the counter
inside the snapshot would pair it with the ratchet atomically and remove the ordering discipline
above - and it would make a migration of the one file whose corruption is unrecoverable. The
asymmetry buys the same safety for nothing.

**One seam, in Rust**: `skip_generations(group_id, n)` in `mls-core`, so a burn costs native one IPC
rather than one per generation and both platforms burn through identical code.

**What is already right and must not be broken.** The Android background sender ALREADY holds the
invariant this closes: `send_messages_background_with_key` encrypts the whole batch, persists once,
and returns no ciphertext until that write succeeded - *a frame handed to the caller is a frame the
caller will POST*. It is the FOREGROUND that violates it, and only for the 1.7 s reason above. A
background send therefore never contributes to the deficit: it leaves the saved state AHEAD of the
JS counters, which yields zero or an over-burn. Safe in both directions.

**Where each piece lives.** `MlsManager::skip_send_generations` (mls-core) is the burn;
`WasmMlsClient::skip_send_generations` and the `skip_send_generations` Tauri command are the two
crossings, and the command sits in the single un-gated `generate_handler!`, so **iOS and Android get
it from the same code** - the only platform split in this area is the background sender's entry
point, never its logic. `src/lib/mls-client/sendRatchetLedger.ts` holds the counters (**`mls-client/`, not
`services/`** - this page said `services/` until 2026-09-06, and a grep at the wrong path returning
nothing is half of why the P1 above concluded the mechanism did not exist),
`BaseMlsService.persistCheckpoint` the pairing, and `BaseMlsService.reconcileSendRatchets` the
repair, run from inside the `init` promise every caller already awaits so nothing can send before it.

**WHAT THE LEDGER DOES NOT COVER, AND IT IS NOT A DETAIL.** The counters are read and written by the
FOREGROUND only. Android runs four engines against one ratchet - foreground Tauri, FCM JNI, Worker
JNI and the native outbox drain `send_messages_background_with_key` - and the drain loads `mls.bin`,
encrypts every queued entry and saves, without ever asking what the foreground has emitted but not
yet checkpointed. Two things hold it back and both are visibility-shaped rather than fact-shaped:
`background_write_mls_bin` refuses while `foreground_is_active()`, which is a 30-second deadline
released deliberately on `hidden`; and `reloadStateFromDisk`, the one thing that re-syncs the
foreground to a background advance, has exactly one caller - the RESUME branch of
`visibilitychange`. An app that is backgrounded and stays alive has released the guard, still holds
a live in-memory client, and will not reload until a resume that may never come.

**HOW IT IS PROVEN, AND WHY THE PROOF IS IN RUST.** `mls-core/tests/burn_spent_generations.rs` runs
two real clients: alice sends two frames, bob consumes both generations, alice is restored from a
snapshot taken before them. The first test asserts the FAULT - bob refuses the next frame with
`SecretReuse` - so the day the defect is fixed somewhere else, that test fails and says the repair
has become dead weight. The second asserts the repair, and the third asserts that burning five where
two were spent still decrypts, which is the property the ledger's deliberate over-count depends on.
Four tests, no device, no timing.

What that CANNOT establish is the seam above it - that the count survives the teardown and the load
path consults it. `burn.mjs` in the harness does, against production: send, reload inside the window,
send again.

**WEB: TAKEN, 2026-08-14.** Deficit 1 before the reload, 0 after it, next frame delivered in 415 ms,
zero loss lines on the peer. Two findings came with it. The window has narrowed to **under 60 ms** -
at the 300 ms the original defect was measured at, the checkpoint had already landed and the run was
reported `INCONCLUSIVE`, which is what a check must do when it fails to reproduce its own premise.
And the console capture MISSED the repair's log line on the passing run, because a reload that does
not raise the PIN gate initialises before a session can re-attach: the verdict rests on the durable
counters instead, read on either side of the reload. Both lessons are in
[testing-methodology](../testing-methodology.md) under rule 4.

**NATIVE: TAKEN, 2026-08-14.** The window there is 1.7 s rather than 60 ms, so it is far easier to
enter: a 300 ms reload found **2** unpersisted frames, the repair reported burning 2, the next frame
decrypted in 3 772 ms and the peer reported no loss. Two things that run taught, both now in the
check: the residual deficit AFTER the load is not a post-condition - it is a live quantity, bumped by
the read receipts the restored session sends on opening the conversation and cleared 1.7 s later by
the phone's own checkpoint - and `burnedLine` legitimately exceeded the pre-reload snapshot, because a
send landed between the two. The repair burns what the ledger holds AT LOAD, which is the only figure
that can be right; a check comparing the two for equality would have called a correct run a fault.

**RE-TAKEN ON THE DEPLOYED BUNDLE, 2026-08-15, AND THE RECIPE STOPPED BEING A RACE.** W1 burnt 1
with the next frame decrypted in 447 ms; A1 burnt 1, next frame 3 589 ms; both peers clean, no loss
line on either side. Getting there needed one change to the check. **A fixed delay cannot enter a
window narrower than itself**, and the window on web is now ~58 ms, so `--delay 300` reloaded at
136 ms with the ledger already at 0 and reported `INCONCLUSIVE` - correct, but it would have done so
for ever, and an INCONCLUSIVE that never resolves is indistinguishable from a repair with nothing to
do. The reload is now GATED on the premise instead: send without awaiting the composer's own 100 ms
post-condition, poll `emitted - persisted`, and reload the instant it is positive. The window opened
on the FIRST send on both platforms. This is rule 7 - a precondition the client agrees with beats
one the check hopes for.

The background handoff is ordered for the same reason: on `hidden` the checkpoint is flushed
**before** `pause_mls_foreground` releases the native guard. Releasing it is what lets a background
JNI engine load `mls.bin` and advance from it, so releasing it first hands that engine a state that
is already behind. The guard expires on its own after ~30 s, so nothing here rests on a clock - the
ordering is the guarantee.

### 9. Client - an application frame never straddles a local epoch advance

- **`runAsEpochSend` / `runAsEpochAdvance`** in
  [`epochSendBarrier.ts`](../../../frontend/src/lib/utils/chat/epochSendBarrier.ts) — a send is
  encrypt-then-POST with a suspension between them; a commit is stage-accept-merge. Nothing ordered
  the two, so a frame encrypted at epoch N could reach the wire after this device's own commit had
  moved every recipient to N+1. **Two past epochs of OpenMLS tolerance is what hid it**: one straddle
  is survived silently, and two commits in quick succession make the frame undecryptable for good
  while the sender considers it delivered. Measured on prod 2026-09-02 (DM `7da231f8`): seven frames
  across commits 128 and 129, the first 36 ms after the commit, four of them lost.

- The overlap is **deleted, not reconciled**. A frame is encrypted AND on the wire before a local
  commit starts, or it is encrypted after that commit merged; there is no third ordering and no clock
  in it. Re-encrypting a frame found stale would be a race that heals cleanly, which is still a
  defect.

- **The barrier is raised only under the MLS mutex, and that is the whole deadlock argument.**
  `runCommitTransaction` raises it inside `runUnderMlsLock`; the mutex being exclusive, a send that
  observes a raised barrier provably does not hold the mutex the advance is waiting for. Registered
  sends never need the mutex themselves (`encryptForSend` is a direct client call), so an advance
  holding it can wait for them to land. A barrier raised outside the mutex, or a send issued from
  inside it, reintroduces the cycle.

## Verification

| Tactic | What must hold | How we check |
|---|---|---|
| `baseEpoch` formula | Web and Tauri stage the commit then read the pre-merge epoch in `runCommitTransaction` | `messaging.commit-log.spec.ts` |
| Commit log shares the advance's fate | A failing commit-log insert fails the commit; a protoless commit advances no epoch | `messaging.commit-log.spec.ts` |
| A hole is named, not discovered | `getCommitsSince` truncates at the gap and reports `gapAt`; `belowFloor` reports none | `messaging.commit-log.spec.ts`, `commitReplay.test.ts` |
| A leafless sender is refused | A `pending` device queues zero rows and gets `sender_not_active`; handshake frames still pass | `messaging.durability.spec.ts` |
| Send / advance never straddle | A frame is posted before a local commit starts, or encrypted after it merged - in both directions, and per group | `epochSendBarrier.test.ts` |
| Persistence monotonic | Stale encrypted flush cannot lower the stored blob | `hex.mlsVersion.test.ts` |
| Recovery vs prevention | Desync _handling_ (ACK rules, retries) | [`mls-recovery-ladder.md`](mls-recovery-ladder.md) |
| Server commit logic | Locks + `activeEpoch` rules | Code review / `app.controller.ts` |

## Related sources

- [`apps/chat-delivery-service/src/app.controller.ts`](../../../apps/chat-delivery-service/src/app.controller.ts) — `validateCommit`, `resetGroup`, `resetGroupEpoch`, add-lock, claim-bootstrap.
- [`frontend/src/lib/services/BaseMlsService.ts`](../../../frontend/src/lib/services/BaseMlsService.ts) - `freshEpoch`, which is where a commit's `baseEpoch` is decided before it is published.
- [`frontend/mls-core/src/lib.rs`](../../../frontend/mls-core/src/lib.rs) — epoch gap detection in `process_incoming_message`.
- [`frontend/src/lib/utils/chat/actions.ts`](../../../frontend/src/lib/utils/chat/actions.ts) — `discoverMissingGroups`, group_reset ordering.

## See also

- [`mls-recovery-ladder.md`](mls-recovery-ladder.md) — Recovery steps after desync is detected
- [`mls-protocol.md`](mls-protocol.md) — MLS protocol overview, invariants, data model
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Backend commit validation and epoch management
