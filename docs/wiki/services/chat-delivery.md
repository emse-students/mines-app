# chat-delivery-service

**Stack**: NestJS  
**Port**: 3010  
**Source**: `apps/chat-delivery-service/`

## Responsibilities

The chat-delivery-service is the MLS API layer. It:

- Manages device registration and key packages (static + one-time prekeys).
- Stores and routes MLS messages for offline devices (message queue in PostgreSQL).
- Publishes each queued message to Redis `chat:messages` for real-time delivery via the gateway.
- Maintains group and membership state (DeviceGroupMembership state machine).
- Handles the sync engine for cross-device conversation history (QR-code-based transfer).
- Dispatches push notifications via Firebase Cloud Messaging.
- Maintains a Redis Stream history per group (`history:{groupId}`) for replay.
- Performs background cleanup (cron jobs) for stale devices, expired messages, orphaned data.

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Entities: KeyPackage, OneTimeKeyPackage, Group, GroupMember, DeviceGroupMembership, QueuedMessage, PinVerifier, PushToken, RevokedDevice |
| Redis | `chat:messages` pub/sub, `history:{groupId}` Streams, `group:members:{groupId}` sets, `mls:addlock:{groupId}` and `mls:commitlock:{groupId}` locks, `pending_welcome:{groupId}` sets and their per-member `pending_welcome_notify:{userId}` fan-out (drained by the gateway) |
| Firebase | Push notifications (FCM) |

## Background jobs (cron)

| Interval | Task |
|---|---|
| 1h | Detect stale devices -> reset to pending |
| 1h | Clean expired queued messages |
| 1h | Full GC of stale device entries |
| 1h | Report queue depth (observation only, deletes nothing) |
| 1h | Report stranded pending device memberships (observation only, deletes nothing) |
| 6h | Clean orphaned Redis `group:members:*` keys |
| 24h | Purge soft-deleted groups (> 90 days old), with everything they own |
| 24h | Purge stale push tokens (> 90 days) |
| 24h | Purge orphaned member rows (and the rest of what those groups own) |
| 24h | Purge stale pending invitations (> 30 days) |

### What a group owns, and the one list that says so

A group's rows live in **seven** tables, and `deleteGroupOwnedRows`
([`utils/group-purge.ts`](../../../apps/chat-delivery-service/src/utils/group-purge.ts)) is the only
definition of that set: `queued_message`, `dm_group_members`, `dm_device_group_memberships`,
`mls_commit_log`, `mls_group_info`, `group_invites`, `dm_user_dismissed_groups`. Plus three Redis
keys through `deleteGroupRedisKeys`: `history:`, `group:members:`, `pending_welcome:`. The MLS locks
(`mls:addlock:`, `mls:commitlock:`) are **not** in it, and deliberately: both are written with an
`EX` TTL, so they collect themselves.

**Five call sites, and until 2026-08-21 only the two collectors were among them.** This page used to
say "both ways a group ends call it" and name the 90-day tombstone reaper
(`cleanupSoftDeletedGroups`) and the orphan sweep (`purgeOrphanGroups`, reached from
`cleanupOrphanedMemberRows`) - which are the two things that COLLECT a group, not the ways one ends.
The three routes that actually end a group each still carried a hand-written shorter list, or none at
all:

| Where a group ends | What it swept before | Missing |
|---|---|---|
| `DELETE /api/mls/groups/:id` (`groups.controller`) | 4 tables, 2 Redis keys | `mls_commit_log`, `mls_group_info`, `group_invites`, `dm_user_dismissed_groups`, `pending_welcome:` |
| `DELETE /api/internal/users/:id`, DM branch | 3 tables, 2 Redis keys | the same five |
| `DELETE /api/internal/distribution-groups/...` | **nothing at all** | everything |

And what a soft-delete leaks is **permanent**, which is what made this worse than the 2026-08-18
case: the orphan sweep only finds groups with NO row in `dm_groups`, so it can never see the residue
of a group whose tombstone survives on purpose. Nothing collects it before the 90-day reaper.
**Measured on prod 2026-08-21**, four community distribution groups deleted during the COMM campaign
runs the same day: 71 `queued_message`, 28 `mls_commit_log`, 10 `dm_device_group_memberships` and 4
`mls_group_info` rows, all four groups tombstoned between 00:08 and 05:50 that morning. All three
routes now go through the shared list, in one transaction with the tombstone.

It exists because each caller used to carry its own shorter list. **Measured on prod 2026-08-18**,
before the fix: `mls_group_info` 21 orphan rows of 69 (30%), `mls_commit_log` 293 of 452 (65%),
`queued_message` 220, `group_invites` 3 of 4 - each naming a `groupId` absent from `dm_groups`.
`mls_commit_log` at least ages out through `pruneExpiredCommitLog`; **`mls_group_info` had no
collector of any kind**, so those rows were permanent.

What made it invisible for so long is worth keeping: `dm_group_members` and
`dm_device_group_memberships` measured **zero** orphans. That is not health, it is the diagnosis.
`cleanupOrphanedMemberRows` finds orphans by joining FROM those two tables - the ones the reaper
deletes one step before it deletes the group - so the sweep was looking in the only two places where
nothing can ever survive, and was structurally blind to every group that died normally. The fix is
therefore the shared list, **not** a wider sweep predicate: asking "which rows have no group" on a
recurring job would race the reaper that is mid-way through the same deletes.

The reaper deletes the owned rows and the `dm_groups` row in **one transaction**, so no window
exists in which the group is gone and its rows are not. Redis comes after the commit, because it
cannot join the transaction: a crash between the two leaves keys that
`cleanupOrphanedRedisGroups` collects, whereas the reverse order would strip a live group's history
if the transaction then rolled back.

**No foreign key enforces this, and for `dm_user_dismissed_groups` no foreign key MAY.** That row is
not a fact about the group - it is a fact about a PERSON, recording that they asked for a
conversation to be gone from all their devices, and it is BUILT to outlive the group row: its entity
stores `groupId` as text rather than a relation, saying so in as many words ("so it outlives the
group row", "independent of the group's own lifecycle"). A `ON DELETE CASCADE` there would delete the
answer to a question still being asked - discovery reads the marker to tell "I dismissed this" from
"somebody else deleted it", and only the first may be purged silently. The `character varying` type
is the CONSEQUENCE of that design, not an obstacle to a cascade somebody would otherwise want.

**Both endpoints that touch it are idempotent, and their logs say how much of that was needed.**
`POST dismissed-groups` upserts (`ON CONFLICT DO NOTHING` on `(userId, groupId)`) and the `DELETE`
means *ensure this group is not dismissed* - so every Welcome calls it, almost always with nothing to
lift. The marker is per USER and the call is per DEVICE, which makes one re-add on a two-device
account exactly two requests and at most one lift. `[DISMISS] ... recorded=N` and
`[UNDISMISS] ... lifted=N` therefore print the affected row count, not the endpoint's intention: the
harness classifies a non-zero count as notable and a zero as benign, and before the counts existed a
single re-add printed two notable lines for zero events.

Which is why `deleteGroupOwnedRows` takes `groupRowSurvives`: a soft delete keeps the tombstone,
so it keeps the marker; a hard delete may take it, because nothing will ever ask again. The three
routes that end a group softly all pass it. **This was learnt by breaking it** - the day the three
were unified onto the shared list, all three began dropping the marker, and a by-hand repair of
tombstoned residue took 25 rows with it before anybody noticed. Those 25 conversations now show a
"deleted" banner to the one person who had asked for silence.

The one-shot that collected the rows already there is
[`016_group_owned_orphans.sql`](../../../apps/chat-delivery-service/src/migrations/016_group_owned_orphans.sql).

### A row in `dm_groups` is not a place a frame can go

`purgeOrphanGroups` is asked, by both its callers, which of a set of groups may still be handed
data. It used to answer **presence** while its own doc named the other question - "the set still
present in `dm_groups` (deliverable)". The two differ by exactly the tombstones, and a tombstone is
not a destination: its members, its keys and its history went with it, so a frame addressed to one
can never be decrypted and never be ACKed. `deletedAt` is a plain `@Column` rather than a
`@DeleteDateColumn`, so `find` returns tombstones and only naming them excludes them.

**The loop that follows has no termination.** The client is handed a frame for a group it does not
hold, asks for a Welcome (`welcome_request`) that no peer will answer, keeps the frame unACKed, and
meets it again on the next connection - for ever, because nothing in the loop consumes the frame.
Measured on prod 2026-08-21: 7 `queued_message` rows for W1's own device, addressed to a distribution
group tombstoned five hours earlier, redelivered on every connection since, and visible from the
client as `[BUFFER] welcome_request sent for unknown group b0192801`.

The call now returns two named sets, and the distinction is not cosmetic - the two causes accuse
different code:

| Group state | Frame | Residue | Log |
|---|---|---|---|
| present, active | delivered | - | - |
| **absent** from `dm_groups` | dropped | purged here, through the shared list | `[ORPHAN_PURGE]` WARN, with per-table counts |
| **tombstoned** | dropped | **left alone** | `[MSG_FETCH] ... undeliverable` WARN naming the group |

**The accusation is made once per group per process, and that was learned the hard way.** Written per
fetch it became the loudest line on the server within minutes of shipping: 134 warnings in one
three-minute window, the same four group ids over and over, because the residue is a STANDING FACT
rather than an event - every client asks on every reconnection and the rows do not go away when they
are read. Once is enough to be found, which is the line's whole job, and a restart re-announces
whatever is still there. The in-process set answers "have I already said this here", which differs
from "is this still broken" only in lifetime - so it is deliberately not durable, or it would silence
the trigger the day somebody wanted it again.

A tombstoned group's residue is deliberately **not** swept from the fetch path. It exists because a
delete route failed to take it, the fix belongs at that route, and a second collector here would hide
that route's failure - the tombstone is already counting down to the reaper. So the line accuses
instead: a queued row for a tombstoned group means a delete path leaked, and it names which group.

History follows the same rule and says so once: `deleteGroupOwnedRows` drops the `history:` stream
with the rest, so a tombstone can only ever answer an empty page. `getHistory` therefore returns
`{ rows: [] }` without a Redis round-trip - and at LOG, not WARN: a client that still holds the
conversation locally and asks for it is the most ordinary request there is. That line used to say
`orphaned - purged` for both causes, which is the wrong accusation for one of them.

### Dead devices are reaped, but only after 90 days

`detectStaleDevices` (hourly) keys liveness on `KeyPackage.createdAt`, which every WebSocket
reconnect refreshes. Past `RETENTION_WINDOW_MS` it `srem`s the device from the Redis routing set
and resets its row to `pending`; `cleanupStaleDevices` then purges the whole footprint.

Until that window elapses, a churned device id keeps receiving fan-out. That is the designed
offline window - a device that is merely off for a fortnight must still get its messages - not a
leak. Anything that needs a device to stop receiving *immediately* (a revocation) must act on the
Redis set directly rather than wait for the reaper.

### The shared log keeps mutations, and records what may notify

`history:{groupId}` is the only **shared** copy of a conversation: the per-device queue is deleted on
ACK, and MLS forward secrecy means the server can never re-derive a frame it did not keep. What is
not written here is recoverable only from a peer that still holds it, and only while that peer is
online.

Until 2026-08-12 the write was gated on `!body.silent`. `silent` is a UI property - do not notify -
and **every** control frame is silent by construction, so that one condition excluded every reaction,
edit, deletion and read receipt from the only shared copy that exists. The client now declares the
two independently (`silent`, `durable`); the server classifies nothing, because it holds ciphertext.
Reconciliation traffic stays out: it restates state held elsewhere, and a 200-message bundle chunk
would evict the messages the log exists to carry.

Because the stream now holds silent frames, each entry records its own `silent` field. Any consumer
that reads the stream in order to **notify** must honour it -
`redeliverMissedDuringActivationWindow` re-notifies a reactivated device from this stream, and
without the filter it would ring the user for every reaction. An absent field reads as visible: it
can only come from an entry written when the stream held nothing else.

Each entry also records the DEVICE that wrote it (`sender_device_id`, since 2026-08-15), and that
field exists for one reason: the stream is shared, so it necessarily holds the reader's own frames,
and MLS refuses every one of them by construction (`CannotDecryptOwnMessage`). `sender_id` cannot
filter them - the same account's OTHER device wrote frames that are both decryptable and wanted - so
without the device the replay learnt which rows were its own only by handing each one to MLS to be
refused. Measured before the fix: 5 certain-to-fail decrypts per MSG capture, in every capture, and
thousands per full replay of a 4 282-message DM. **Never learn by failing what a fact could have
told you** - the server holds the discriminator in the request body and now writes it down. Rows
predating the deploy still reach MLS and are still recognised by their refusal; that arm is the shim
and its removal date is in [legacy-compatibility](../legacy-compatibility.md).

Sizing is `HISTORY_STREAM_MAXLEN` (`retention.constants.ts`), raised 1000 → 8000 the same day. The
order matters and is not cosmetic: the store must be durable, then `maxmemory` must have headroom,
then the per-group cap may rise. Raising the per-group cap first lets eviction choose which
conversations keep a shared copy. Full reasoning in
[history-reconciliation](../protocols/history-reconciliation.md).

### The SENDER is checked before any recipient is resolved (2026-09-02)

**`status = 'active'` gated recipient resolution twice, and nothing gated the sender.** A device
whose membership row is not `active` holds NO LEAF in the ratchet tree, so whatever it encrypts is
undecryptable by construction for every member: accepting the frame does not deliver a message, it
manufactures one that will fail to open on every recipient, for ever. Measured on production
2026-09-02, DM `7da231f8`: the peer's `web-...-mtbep8vs-5oxb`, `pending` since 2026-08-27 and still
holding two undelivered Welcomes, sent six messages in 24 seconds that were fanned to five devices -
**thirty rows of ciphertext nobody in the group can ever open**. The sender saw them sent.

`sendMessage` now reads the sender's own `dm_device_group_memberships` row before resolving anybody
and answers **`403 sender_not_active`**, carrying the status so the client learns the fact rather
than inferring it. Two things the gate must not do, both asserted in `messaging.durability.spec.ts`:

- **Handshake frames are exempt.** A Welcome and a Commit carry no application payload and are
  precisely the path OUT of `pending`; refusing them makes the gate a deadlock.
- **A MISSING row is logged, not refused.** The row is written by the commit that admits the device,
  so a send racing just ahead of it is normal - though the same shape is also what a ghost looks
  like, which is why it is logged at all.

The discriminator was in the row the server already reads to address the recipients: this is the
rule about never learning by failing what a fact could have told you, applied to a seam that held
the fact and forwarded the frame anyway.

### Who a frame is queued for, and who owns the gateway's routing set

Two different questions that a single `sadd` used to blur together.

**The recipient set is resolved from `dm_device_group_memberships`, and that is the only way it has
ever been resolved.** `SendMessageBody.recipients` exists, `libs/proto/canari.proto` carries it, and
the branch that reads it was written first with the membership query behind
`if (ops.length === 0 && body.groupId)` under a comment reading *"Fallback: recipients not provided
(Redis cache miss). Resolve from DB and repopulate `group:members` so subsequent messages no longer
need this round-trip."*

No caller has ever populated the field. Not `postApplicationMessage`, which posts six keys and none
is `recipients`; not the gateway, where the word does not occur in the source at all; not
`POST mls/push/send` or the background-Welcome route; not the commit fan-out in `validateCommit`.
The proto file says as much itself - *"leave empty = derive from group members"*. So the guard was
true on every send, the fallback was the design, and `FALLBACK_MEMBERS_CACHE` announced a Redis
cache miss on **279 of 279 sends in a 23-minute window** for a cache `sendMessage` never reads. The
branch is now unconditional and named for what it does. **A fallback is a signal, never a path**: it
went unexamined for as long as it had a name that excused it.

That also had a second victim: five assertions in `messaging.durability.spec.ts` supplied their
recipients through `body.recipients`, so the suite was green while measuring the branch production
never takes and leaving the branch it always takes unasserted. They now declare membership rows and
KeyPackages, the way a real send finds them.

**The routing set is owned by `activateDeviceMembership`**, which writes `group:members:{groupId}`
at the pending→active transition - the moment membership is decided. What is left on the send path
is a reconciliation, and it exists for one historical reason: Redis ran without a volume until
2026-08-12, so the sets that died with the container have no other writer until each device happens
to re-activate.

Measured on prod 2026-08-15, which is what settled the design: of the 23 groups holding active
memberships, the 15 that **have** a set are complete to the row - **0 missing, 0 stale** - and all
11 missing rows live in the 8 groups that have no set at all. The reconciliation therefore adds
nothing on any group it has ever run against, so it reports only when it **changes** something, and
it accuses when it does: `MEMBERS_CACHE_REPAIRED` is a `warn`, matched by no rule in `srvlog.mjs`,
so a campaign run stops on it. An active device absent from that set is one
`broadcast_to_group_members` silently fails to reach (it proceeds with an empty member list and
sends to nobody) and one `forward_to_one_peer` can never elect to answer a `welcome_request` or a
`history_request`.

It reconciles against every **live** member, sender included. Reconciling against the delivery set
instead left the sender - and any `excludeDeviceIds` entry - out for ever, which made the repair
incomplete by construction.

### The queue is bounded on ONE axis, and observed on the other

`cleanupExpiredQueuedMessages` bounds the queue by AGE, and that is the only axis on which
dropping a frame is defensible: past the retention window the recipient could not have used it.
There is deliberately **no size cap**. Capping a device's queue would convert a disk problem into
silent message loss, which is the failure class the whole delivery path exists to prevent.

So the answer to "one device is running away" is to NAME it. `reportQueueDepth` (hourly, added
2026-08-11) logs the total depth plus the five deepest per-device queues, and WARNs above
`QUEUE_DEPTH_WARN_PER_DEVICE`. It deletes nothing.

It exists because of a measurement, not a theory. The retransmission storm of 2026-08-10
(WP-RETRANSMIT-1) put **28 124 frames on a single web device in five hours** - 39 MB of ciphertext,
thirty times the rest of the platform combined, addressed to a browser generation that had already
been replaced and would therefore never drain it. The table reached 70 MB. Every mechanism behaved
as designed: the frames were inside the 90-day window, and the device held a valid `KeyPackage`, so
**no ghost predicate applied to it** - which is the correction to make if you are reading an older
note: "reap frames addressed to devices with no key package" would have matched ZERO of these rows,
and on the day it was checked every one of the 52 devices with a queue had a key package. Nothing
logged, nothing warned; it was found by a manual `GROUP BY "deviceId"` a day later.

The threshold is set from those two measurements rather than from taste: healthy per-device
backlogs were <= 84 frames, one storm hour was 21 597. 2000 is ~24x the former and ~1/10 of the
latter, so ordinary traffic and a genuinely offline weekend never trip it while a runaway sender is
named within minutes.

The WARN carries the device's **last `KeyPackage` upload** because that is the evidence separating
the two causes, which call for opposite responses: a recent upload means a live device that cannot
keep up ([WP-PENDING-1](../../../CLAUDE.md), a client bug to chase), a stale one means debris
awaiting the GC. A line reporting only the depth cannot tell them apart and sends the reader to the
wrong fix.

`app.controller.queue-depth.spec.ts` pins the decision - the threshold boundary and the evidence in
the line. It cannot pin the SQL: a mocked repository never parses a query, so the builder's output
is verified only by the prod deploy log.

#### The report worked, and its discriminator earned its keep (2026-08-11)

First real use, hours after it shipped. The hourly line named
`web-d82cd226…-msi13yl3-ytaa=1419`, and a follow-up `GROUP BY` showed it climbing to 1 513 with its
oldest row timestamped **02:00:46 that same morning** — i.e. the queue had reconstituted itself from
zero since the storm rows were purged overnight, at roughly 2.4 frames a minute of ordinary traffic.

It reads exactly like WP-PENDING-1's symptom: a device receiving and never draining. It is not, and
the thing that settled it in one query was the evidence the WARN carries — a **last `KeyPackage` of
2026-08-10 19:47**, against a live browser on that same account whose device id is
`…msgm5z5j-136y`. Different generation, so nobody will ever drain it: debris, not a client bug.

Two things follow, and both are the point of building the report rather than a cap:

- **The device id is the identity, and it must be read from the client under test, never recalled.**
  The whole distinction between "a bug to chase" and "rows to sweep" rested on comparing two strings
  that differ in eight characters.
- **The reaper still cannot touch it.** A valid key package is what disqualifies it from every ghost
  predicate, so the frames accumulate until the 90-day `RETENTION_WINDOW_MS` takes them. That is the
  open half, and it is the one a future GC has to answer — with a predicate re-measured on the
  population it will actually run against, not the one that named the last incident.

#### The answer was a REVOCATION, not a sweep (2026-08-11)

The debris was closed the same day, and by the mechanism the product already has rather than by the
new predicate the report seemed to be asking for. `web-d82cd226…-msi13yl3-ytaa` was revoked from
Settings > Appareils connectés; measured immediately after, on prod:

| | before | after |
| --- | --- | --- |
| `queued_message` for that device | 2 073 | **0** |
| `dm_device_group_memberships` for it | 6 | **0** |
| `revoked_device` rows for it | 0 | **1** |
| platform-wide `queued_message` | 2 916 | **847** |

**A DELETE WOULD HAVE BEEN THE WRONG SHAPE, AND IT WOULD HAVE LOOKED RIGHT FOR A DAY.** The rows were
the symptom; the cause is that the device is still a valid fan-out target. Emptying the table leaves
the six routing memberships in place, so the next message re-queues to it and the count starts over —
which is precisely what the report had already caught happening once, the queue reconstituting itself
from zero at ~2.4 frames a minute after the overnight purge. The revoke removes the membership, the
key packages and the queue together, and records the fact in `revoked_device` so nothing re-adds it.

The generalisation, and the reason this is filed as a rule rather than an incident: **when a resource
keeps refilling, the disposal is not the fix — find the mechanism that keeps naming it as a
destination, and use the product's own control over that mechanism.** A GC predicate written for this
would have had to distinguish "a generation the user replaced" from "a device that is merely offline",
which is a judgement the server cannot make and the user already made by replacing it.

What the remaining 847 rows say is that there was nothing else of this shape: the deepest per-device
queue is **84**, on a real user's phone whose key package predates it — the ordinary profile the
threshold was set against, not a second runaway.

#### The placeholder that took a conversation's first seat, cleaned by hand (2026-08-30)

The `(userId='unknown', deviceId='pending')` member — cause, guards and story in `CHANGELOG.md` — had
no product control that could revoke it: the revoke path above needs a real device to revoke, and this
was not one. It was removed by hand on prod with the owner's go-ahead, in the order the rule above
gives, and the counts are here because the frames are gone and this is the only record of what they
were.

| | before | after |
| --- | --- | --- |
| `dm_device_group_memberships` | 1 (`active`) | **0** |
| `key_package` | 1 | **0** |
| `one_time_key_package` | 50 | **0** |
| `queued_message` | 194 | **0** |
| real device rows in that DM | 8 | **8** |

**The allowlist is an IDENTITY, and that is what made it safe** — the mistake the defect itself was:
a shape allowlist is not an identity allowlist. `unknown` and `pending` are two literals no client can
produce, since a real `userId` is 64 hex characters and a real `deviceId` is `web-<64 hex>-…` or
`tauri-<64 hex>-…`. The post-check used `OR` where the delete used `AND`, a deliberately WIDER
predicate, so it proves no row of that shape survives anywhere rather than merely that the delete ran.

**What the frames were**, read before deletion: 194 in a single group from two senders — 117 commits
and 77 application frames, **no Welcome at all**, spanning 2026-08-27 22:04 to 2026-08-30 15:28.
Bodies are ciphertext no device could ever open, so the shape is the entire evidence.

**A CLOCK NEARLY SAID THE BLEEDING HAD STOPPED.** The newest frame was 2 h 47 old at measurement,
which reads like the guards had closed it. Bucketed by hour against ALL traffic to the same group,
the ghost took 2 frames where real members took 6, then 5 against 15, then 1 against 3 — about one in
four, **unchanged across the deploy that shipped the guards**. The quiet was nobody writing in the
conversation. The guards stop a NEW placeholder; only removing the membership row stopped this one.

**What this did NOT do.** The server row is not the MLS tree. If the placeholder ever took a leaf,
only a Remove commit from a member drops it, and no server query can tell — the group sat at epoch
118 and the placeholder held a `key_package`, so an Add is likely to have happened. That question is
answered from a member's own client, not from here.

#### WP-PENDING-1 verified on hardware, and what the run could not establish

The defect: a single `AbortController(10_000)` wrapped the **whole** paginated pull, and nothing was
ingested or ACKed until the pull returned, so a backlog bigger than 10 s of transfer aborted on every
reconnect, ACKed nothing, and only grew (measured at 5 526 rows = 12 pages). The fix moves the
deadline onto one PAGE and hands each page to `onPage` as it lands
(`mlsDeliveryApi.pullPendingMessagesJson`, `BaseMlsService.fetchPendingMessages`).

Verified on A1 by parking the phone (`am force-stop`), sending 1 100 messages from the peer browser
into the two-test-account DM, and unparking it under continuous logcat with the server-side queue
polled every 4 s. Both halves agree:

| Evidence | Reading |
| --- | --- |
| `[PENDING] Fetched 500 … (500 so far)` then `Fetched 287 … (787 so far)` | the pull really paginates |
| a `[QUEUE] Drain start` **between** those two lines | page 1 was ingested before page 2 was fetched |
| depth series `795 → 305` at 54 s, then `417 → 6` at 100 s | two distinct ACK steps, ~490 then ~411 |
| final depth `0`; 0 ACK failures, 0 transport failures, 0 SQLite errors | the backlog is discharged |

The depth *rises* through the first 48 s (`693 → 795`) because the fan-out lags the last send by
minutes at this volume — which is also why the harness now polls until the depth stops growing
instead of reading it once after a fixed pause. A single read 8 s after the last send reported 615
of the ~1 100 on their way; it cost nothing here, but it is the number a verdict quotes.

**What this run does NOT establish, stated because the tempting claim is the wrong one:** 1 100 rows
is two pages and a few seconds of transfer, so the *old* code would very likely have finished inside
its 10 s budget too. The original timeout is not reproduced. What is established is the structural
property the fix is made of, which is independent of link speed — partial progress, page by page —
and reproducing the timeout would need a backlog no composer can build in under an hour.

#### A page is a unit of transfer, so it is bounded in BYTES (2026-08-13)

WP-PENDING-1 bounded the DEADLINE per page and left the page itself bounded in ROWS, which is the
wrong unit and only moved the failure. Measured on production: one phone was asked for 500 rows,
which for its queue meant **12 MB**, because a quarter of its frames carried media at up to 89 kB
each. It aborted on its own 10 s per-page deadline having received nothing, ACKed nothing, and met
the same 12 MB on every later attempt. The backlog went **959 -> 965 -> 976** over three consecutive
hourly reports and never once fell, for weeks.

Nobody was told, and that half matters as much: `QUEUE_DEPTH_WARN_PER_DEVICE` is **2000 rows**,
calibrated on the retransmission storm of 2026-08-10, and 976 rows weighing 36 MB never came near
it - a predicate that named the last incident does not name the next one. The report now warns on
`QUEUE_BYTES_WARN_PER_DEVICE` as well and orders the top-N by size.

Three mechanisms, each independently sufficient for a different failure:

| Where | What | Why it is not the others |
| --- | --- | --- |
| `fetchMessages` | fills a page to `PENDING_PAGE_MAX_BYTES` (1 MB), reading `PENDING_FETCH_CHUNK_ROWS` (50) at a time | bounds the SERVICE's memory too: reading 500 rows before trimming would load 44 MB to return 1 MB |
| `pullPendingMessagesJson` | halves `limit` when a page does not arrive, down to 1 | survives an OLD server, and a link too slow for any fixed budget; terminates on a proof (nine steps), never a clock. What counts as "does not arrive" is the progress deadline below |
| both | a page always carries **at least one row**, whatever its size | an oversized frame must stay deliverable, or it blocks its own queue for ever |

**Verified on production the same evening.** The server logged
`page capped by bytes at 53 row(s), 1 039 524 byte(s)` for that device and the queue fell **976 ->
923** - the first downward movement ever recorded on it. Total fleet queue 2266 rows / 38 MB across
55 devices, largest frame 89 600 bytes, **0 frames above 1 MB**, so a one-row page is at most 87 kB
and the halving ladder really does terminate.

**Two faults that only running it revealed**, both now fixed and both worth keeping in the head:

- **Termination was an inference.** The client stopped when `batch.length < pageLimit`, which was
  true only while rows were the sole bound. With the byte cap it read 53 < 500 as "queue empty" and
  stopped with 870 frames waiting - one reconnection per page. **Only an empty page proves there is
  nothing left**, and that is now the terminator; it costs one extra request per drain.
- **The cursor is not a total order.** The client resumes at `createdAt > last`, strict, and
  `@CreateDateColumn` writes milliseconds from the application - so two rows can share an instant
  (one such pair was in the live queue that day). A page split inside such a group drops its tail
  from every later page: queued for ever, delivered never. Byte-capping makes truncation the normal
  case, so this went from theoretical to likely. **A page never ends inside a group sharing one
  `createdAt`**, even when finishing the group takes it past its budget or its row limit. Fixed
  server-side on purpose: it covers clients too old to send a better cursor.

#### The per-page deadline measures SILENCE, not elapsed time (2026-08-17)

The residual imperfection the section above recorded rather than hid: 10 s was a TOTAL, so it could
not tell a transfer arriving slowly from one that had stopped arriving at all. That is the wrong
question. A total deadline has to be large enough for the biggest plausible answer on the slowest
plausible link - a product nobody can bound, hence a number nobody could justify. Ten seconds was
that number.

**`fetchJsonUnderProgressDeadline` asks the question that has an answer: is anything still coming.**
The timer is armed once before the request and RE-ARMED on every arrival - the response head, then
each body chunk - so it fires only on `PENDING_PAGE_STALL_MS` of complete silence. The constant did
not change and its justification did: it no longer has to cover a transfer, only the longest quiet
stretch the design permits, and there is exactly one - the server assembling a page it already
bounds at 1 MB reading 50 rows at a time. Ten seconds of total silence against that is pathological,
which is what a hang-guard should be.

Both halves are real on both platforms: the browser streams `res.body`, and Tauri's `plugin-http`
builds its `Response` over a `ReadableStream` pulling chunks across the IPC boundary, so a chunk
arriving there is a chunk arriving here. **The reader is raced against the abort rather than trusted
to honour it** - aborting the signal stops the REQUEST, not a `read()` already awaiting a chunk from
a stream that was never handed the signal, and a hang-guard that can itself hang is not one.

**The halving ladder stays, and the question of whether it still earns its place is settled: it
does.** The deadline decides when to stop waiting, the ladder decides what to ask next - a detector
and a response, not two answers to one question. Neither can do the other's job: without the
deadline the ladder never fires, and without the ladder the deadline only ever reports.

What the deadline now adds is EVIDENCE. `StalledRequestError` carries whether the response head had
arrived, so the log separates the two causes halving treats alike - a server that never started
answering (the size question, the one asking less can fix) from a transfer that started and stopped
(the link). Nine identical `page did not arrive` lines said neither. Pinned by
`progressDeadline.test.ts` (the mechanism, both outcomes) and
`mlsDeliveryApi.pending.test.ts` (a body taking six times the window and never halved).

#### A drain that acknowledges nothing now says so

WP-PENDING-1 fixed the pull. What it did not fix is that **a row nothing acknowledges is invisible
from either end**. Only what reaches `enqueueMessage` can ever be ACKed, and two places drop a row
before that without a word:

- `BaseMlsService.enqueuePendingRows` skips a row whose `proto` is absent or decodes to zero bytes
  (and used to swallow a decode failure into a single `console.error` with no tally);
- the inbound handler returns `false` for an unknown group (buffered pending a Welcome) or an absent
  conversation (waiting on the store restore) - correct in both cases, and silent in aggregate.

A device in either state re-fetches the same rows on every reconnect for the 90 days of the
retention window, and the only external symptom is a backlog that grows and never shrinks. That
reads identically to "the pull never runs", to "the pull runs and everything fails", and to a device
with nothing to do - three causes, three opposite fixes, and no server-side count separates them.
This is exactly the rule about a report having to carry the evidence that separates the causes it
cannot itself distinguish.

So both are counted and named. `enqueuePendingRows` emits one line per page splitting **empty
payload** from **undecodable payload** with a sample of ids; `unackedFrames.ts` tallies the handler's
refusals by reason with a sample of group ids, and `fetchPendingMessages` reports it **after
`waitForMessageQueueIdle`** - the rows are enqueued, not handled, so what was refused is only known
once the queue has drained. Silent when there is nothing to say.

### A roster seat is not a key, and only a Welcome tells the two apart

`addGroupMember` writes a `dm_device_group_memberships` row with `status: 'pending'` for **every**
device of the invited user that holds a `KeyPackage` in the retention window. The Welcome, on the
other hand, only reaches the devices the inviter's `addMembersBulk` actually managed to add - a
device whose KeyPackage the WASM layer rejects lands in `skippedDeviceIds` and is dropped there. The
two counts are written by different actors and nothing compared them, so a device could hold a seat
on a group's roster it had never been given the keys for: present in the roster, receiving nothing,
notifying nothing. `warnSkippedKeyPackages` logged it in the **inviter's** console and nowhere else,
which is the one place nobody reads - a correct mechanism with no report.

It was found by hand, a day late, exactly as the rule predicts. A member created a new DM on
2026-09-01; the peer's phone got its pending row at `20:45:47.420` and **no `queued_message` with
`isWelcome = true` was ever written for it**, while the account's four other devices each got one.
It sat stranded for **3 h 41**, until the phone healed itself by external join at `00:26:54` and
republished its key package at `00:53` with 39 one-time key packages. The peer read the message on a
web session and got no notification on his phone, which is how the defect surfaced at all.

`reportStrandedDeviceMemberships` (hourly, added 2026-09-01) closes the gap on the server, where
both facts are known. It selects the `pending` rows older than `STRANDED_PENDING_MEMBERSHIP_MS`
(1 h - long enough that an ordinary invitation in flight is never counted) and partitions them with
ONE grouped query against `queued_message` on the pair the row cannot carry by itself: **is a
Welcome actually queued for this device AND this group**.

- **awaiting a queued Welcome** - healthy. The Welcome exists, the device is simply offline. Logged,
  never warned; this half is the population the WARN would otherwise drown in.
- **no Welcome ever queued** - the defect, and since 2026-09-04 it is **split again**, because that
  footprint has two opposite causes wanting opposite fixes:
  - **never added** (`kickedAt IS NULL`) - the device was registered onto the roster and its
    KeyPackage was skipped, so it was never in the MLS tree. WARNed. The reader's next stop is the
    inviter's KeyPackage handling.
  - **kicked with no re-add** (`kickedAt IS NOT NULL`) - a member REMOVED this device's stale leaf
    and undertook to Add it back, and the Add threw. The device WAS in the tree. Logged at **ERROR**,
    because this is a failure rather than a state, and it is the ONLY place it is ever reported: the
    `addMember` fails on the answering device, which is a phone, and the failure is swallowed there.
    Dated by the KICK rather than by `updatedAt` - the age that matters is how long the promise has
    been outstanding.

  Both halves name the oldest `STRANDED_MEMBERSHIP_REPORT_TOP_N` as `deviceId@groupId(ISO)`, because
  a count cannot be chased and a device id can.

`kickedAt` is what makes that split possible, and it is a column written to answer exactly that one
question - never a second `updatedAt`, which moves for every write and would read an invitation, a
Welcome queue and a demotion as the same event. It is **set** by `kickStaleDevice` and
`kickStaleUser`, the only endpoints that reset a live membership (one instant for a whole batch,
because one Remove commit reset all of them), and **cleared** by the three writes that answer the
question the other way: `queueWelcome` (a Welcome exists, so the re-add landed),
`activateDeviceMembership` and `updateInvitationStatus('active')` (the device is in). A demotion to
`pending` does NOT clear it - that is a step towards cleanup and promises no Add. Left uncleared,
every successful kick-and-re-add would be reported as a failed one; never set, the ERROR half counts
zero for ever and reads as health, which is why the write sites have their own spec
(`invitations.controller.kick-marker.spec.ts`) rather than being covered only through the report.

**It cannot be backfilled**, and is not: null is the honest reading of "no kick is recorded" for
every row that predates the column, so the first passes after the deploy report the standing backlog
as *never added* and the split becomes exact as the population turns over.

It deletes nothing - `purgeOrphanedMemberRows` and the fourteen-day queue retention still own that -
and the point of the hour-scale threshold is that the report names these rows about thirteen days
before the purge erases the evidence that would explain them. `app.controller.stranded-memberships.spec.ts`
pins the partition, the threshold boundary and the shape of the WARN; as with `reportQueueDepth`, a
mocked repository never parses SQL, so the builder's output is verified only by the deploy log.

### A revoked device id does not come back for ten years

`DELETE /mls/devices/:userId/:deviceId` purges the device footprint **and** writes a
`revoked_device` row. The client deliberately restores the *same* device id after a reinstall
(`resolveDeviceId` reads `localStorage`, then `push_context.json`) - so the denylist and
re-registration meet on every reinstall of a deleted device.

The ban lapses after `DEVICE_REVOCATION_TTL_MS` (10 years, 2026-08-13). That is hygiene, not a
security parameter: a table that only ever grows is one nobody can reason about, and an identifier
retired a decade ago has no hardware left to come back on. **The bound is applied at the QUESTION,
not by the purge** - `activeRevocationWhere` at all six sites that ask "is this device banned" - so
a lapsed row stops banning whether or not `cleanupExpiredRevocations` has run; the daily job only
reclaims space. If the purge were what enforced it, a service that failed to run it would go on
banning devices it had promised to release and nothing would say so.

The write-side lookup in `deleteDevice` is deliberately NOT filtered by the window: it asks "have I
already got a row for this device", which has no age, and filtering there would insert a duplicate
the unique constraint rejects. Re-revoking refreshes `revokedAt`, so a device banned, un-banned and
banned again is banned from today - a second, deliberate revocation must never be born expired.

### A deleted device is told at once, and erases itself

The denylist is the DURABLE half of a revocation and would be met at the device's next login anyway.
It is not the immediate half, and a device its owner has just declared lost keeping a live session
until then is the wrong answer to what they asked. So `deleteDevice` also calls
`notifyDeviceRevoked`, which publishes a `device_revoked` control frame on `chat:messages` addressed
to that `userId:deviceId`. **No gateway change was needed**: `isWelcomeRequest` is that path's
generic "relay this base64 JSON to the device" flag and the inner `type` is what drives the client.

On the client, `onDeviceRevoked` fires and **confirms the revocation against the server before
destroying anything** - `GET /mls/devices/:userId/:deviceId/revoked`, over the authenticated
channel. A frame is a message, not an authority, and a total wipe is a destructive control. That
check answers `false` when it cannot reach the server, so a transport failure can never erase a
device: a status code is an answer, a transport failure is not.

Confirmed, the device is returned to a fresh install by `wipeDeviceToFactory` - MLS state, local
databases, cached responses, every stored preference, and the biometric key - then signed out. Three
steps in a fixed order: tear the session down, revoke the refresh cookie while the network context
still exists, then delete everything local, so nothing still running can write a key back after the
wipe. `IStorage.close()` exists for this: `deleteDatabase` does not fail on an open connection, it
BLOCKS, and a wipe that completes at some later moment nobody controls is not one you can assert on.

This is the immediate half only. A device that is offline when it is deleted learns at its next
login, from the denylist, exactly as before.

`registerDevice` therefore refuses a revoked id with **403 `{ code: 'DEVICE_REVOKED' }`**. Before
that check existed, registration succeeded and the device was then filtered out of `getUserDevices`
and resolved to a `null` KeyPackage by `resolveKeyPackagePayloadForDevice` - registered, absent from
its own device list, never invitable to a group, with no error surfaced anywhere. That silent state
was [WP-DEV-PANEL-1](../../../CLAUDE.md).

The client answers the refusal by becoming a new device: `BaseMlsService.generateKeyPackage` catches
the typed `DeviceRevokedError` and calls `rotateDeviceIdentity`, which mints a fresh id, reloads
empty MLS state, persists it, and deregisters the abandoned id. Retried exactly once - a second
refusal is a server bug, not a state to keep rotating through. The MLS credential is
`userId:deviceId`, so a new id *is* a new device: local history is gone and every group must
re-invite it. That is the intended cost of a revocation being real.

## Routes

All routes are under `/api/mls/*` or `/api/calls/*` and require `X-User-Id` (injected by Nginx) unless noted.

### Device management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/register-device` | Register static key package for a device |
| POST | `/api/mls/register-device/prekeys` | Bulk-upload one-time prekeys |
| PATCH | `/api/mls/devices/:userId/:deviceId/metadata` | Update device name/OS/version |
| GET | `/api/mls/devices/:userId/:deviceId/key-package` | Get a consumable key package |
| GET | `/api/mls/devices/:userId` | List all registered devices for a user |
| GET | `/api/mls/devices/:userId/:deviceId/revoked` | Is this device denylisted (gates the wipe) |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/count` | Count remaining OTKPs |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/list` | List published prekey IDs |
| POST | `/api/mls/devices/:userId/:deviceId/prekeys/prune` | Delete targeted orphaned prekeys |
| DELETE | `/api/mls/devices/:userId/:deviceId/prekeys` | Purge all prekeys for a device |
| DELETE | `/api/mls/devices/:userId/:deviceId` | Delete device and all its data |

### Group management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups` | Create group record |
| GET | `/api/mls/groups/:groupId` | Get group metadata |
| PATCH | `/api/mls/groups/:groupId` | Rename group |
| PATCH | `/api/mls/groups/:groupId/image` | Set/clear group avatar |
| DELETE | `/api/mls/groups/:groupId` | Soft-delete group |

### Membership

| Method | Path | Description |
|---|---|---|
| GET | `/api/mls/users/:userId/groups` | List user's groups |
| GET | `/api/mls/users/:userId/dismissed-groups` | List dismissed group IDs |
| POST | `/api/mls/users/:userId/dismissed-groups` | Mark group as dismissed |
| DELETE | `/api/mls/users/:userId/dismissed-groups/:groupId` | Un-dismiss group |
| POST | `/api/mls/groups/:groupId/members` | Add member record to group |
| GET | `/api/mls/groups/:groupId/user-members` | Get user-level members |
| GET | `/api/mls/groups/:groupId/members` | Get active device members |
| DELETE | `/api/mls/groups/:groupId/members/:userId` | Remove user from group |

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send MLS message/commit (publishes to Redis, queues for offline devices) |
| POST | `/api/mls/commit` | Validate commit epoch + store in commit-log + fan out (one atomic call). An optional `groupInfo` carries the external-join base for the epoch the commit CREATES; it is written with the epoch advance in one transaction, so a joiner can never leave the base behind (COMM-22) |
| GET | `/api/mls/commits/:groupId?sinceEpoch=N` | Rung-1 replay: ordered commits to catch up a lagging device |
| GET | `/api/mls/group-info/:groupId` | Latest GroupInfo for external-join (membership-gated) |
| POST | `/api/mls/group-info/:groupId` | Refresh stored GroupInfo (membership-gated, monotonic) |
| POST | `/api/mls/welcome` | Deliver Welcome message to a device |
| POST | `/api/mls/welcome-request` | Broadcast welcome_request signal |
| POST | `/api/mls/history/batch` | Get message history batch, **at most 50 groups** (response carries `heads`, one stream head per group) |
| GET | `/api/mls/history/:groupId?after=&until=&limit=` | Incremental Redis Stream history; head in `X-History-Head` |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch queued messages for device |
| POST | `/api/mls/messages/ack` | Acknowledge received messages |
| POST | `/api/mls/notify-reaction` | Fire-and-forget reaction push |

**A history walk is bounded by the head it was given.** `until` is an INCLUSIVE upper bound used as
the `XRANGE` end in place of `+`; the head is read (one `XREVRANGE ... COUNT 1`) only when the caller
supplies none, so a walk pays for it once and never per page. It exists because the stream holds every
frame *including the ones still queued for live delivery*, so an unbounded walk reads the rows the
queue is about to hand over and both paths present the same ciphertext to MLS - see
[history-reconciliation](../protocols/history-reconciliation.md#the-exchange). A malformed `after` or
`until` is dropped rather than rejected: a client that has lost its place gets the unbounded read it
would have had with no cursor, not a 500 it cannot act on.

**The batch cap is a contract with the client, and it is not on the wire.** `history/batch` refuses
more than `HISTORY_BATCH_MAX_GROUPS` (50) with a 400, and the client chunks at a constant of the same
name in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`. Neither side asks the other what the number
is, so the two are pinned by `messaging.history-bound.spec.ts` on this side and by
`mlsDeliveryApi.history.test.ts` on the other, each naming the file that has to change with it.
Until 2026-08-24 the client sent its whole conversation list in one request and *learned the cap by
being refused*: measured on production with 110 conversations, that was one 400 followed by a
sequential re-fetch of all 110 - exactly the cost the route exists to remove, paid by every client
past fifty conversations, and reported only as a `console.warn` carrying the bare status. A chunk
refused now leaves its groups unprimed and says so with the server's own words; the replay reads
those groups' first pages itself, which is the path every group took before the route existed.

### Invitations / device sync

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups/:groupId/invites` | Create shareable invite link |
| GET | `/api/mls/group-invites/:token` | Preview group invite |
| POST | `/api/mls/group-invites/:token/accept` | Accept group invite |
| GET | `/api/mls/invitations/pending/:userId/:deviceId` | Get pending invitations |
| GET | `/api/mls/device-memberships/:userId/:deviceId` | Get device memberships |
| POST | `/api/mls/invitations/status` | Upsert DeviceGroupMembership status |
| POST | `/api/mls/kick-stale-user` | Reset all devices for a user to pending |
| POST | `/api/mls/kick-stale-device` | Reset single device to pending |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId/:groupId` | Delete specific membership |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId` | Delete all device memberships |
| POST | `/api/mls/groups/:groupId/force_leave` | Force device exit from group |

### Push notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/mls/push/register` | JWT | Register/refresh FCM push token (+ optional iOS `voipToken`) |
| DELETE | `/api/mls/push/unregister/:deviceId` | JWT | Unregister push token |
| GET | `/api/mls/push/fetch-proto` | PushSecret | Fetch proto for background push service |
| GET | `/api/mls/push/avatar/:targetUserId` | PushSecret | Get avatar URL for notification display |
| GET | `/api/mls/push/media/:mediaId` | PushSecret | Proxy encrypted media ciphertext (2 MB cap) for a notification thumbnail |
| POST | `/api/mls/push/refresh-token` | PushSecret | Refresh FCM token and/or PushKit `voipToken` |
| POST | `/api/mls/push/membership-active` | PushSecret | Mark membership active after push-triggered add |
| POST | `/api/mls/push/acquire-add-lock` | PushSecret | Acquire add-lock from background service |
| DELETE | `/api/mls/push/release-add-lock` | PushSecret | Release add-lock |
| GET | `/api/mls/push/key-package` | PushSecret | Get key package for background service |
| POST | `/api/mls/push/send-welcome-and-commit` | PushSecret | Send Welcome + commit from background service |
| POST | `/api/mls/push/send` | PushSecret | Send message from background service |
| POST | `/api/mls/push/broadcast-test` | JWT | Test push to all devices of caller |
| POST | `/api/mls/push/unavailable` | JWT | A device reporting that it CANNOT obtain a push token (writes nothing - see below) |

#### A device that cannot get a push token at all

**`POST /api/mls/push/unavailable`, and it deliberately stores nothing.** A client that exhausts its
registration retries without ever holding a token POSTs `{deviceId, platform, reason}`; the
controller sanitises the three, logs
`[PUSH_UNAVAILABLE] user=<uuid> device=<id> platform=<android|ios> reason=<reason>` at WARN, and
returns `{recorded: true}`.

**Why a report and not a row.** `push_token` already owns the state of a device's push chain, one row
per `(userId, deviceId)`; a second table saying "this one has no row" would be a second source of
truth for a fact the first table already carries, and would go stale the moment the device recovers.
What was missing was never storage - it was that **the absence of a row is indistinguishable from a
device nobody opened.** Measured 2026-08-27: 49 `android` rows, zero `ios` rows ever, no message
alert or CallKit ring deliverable to an iPhone for the platform's entire life, and nothing anywhere
said so, because the client's only witness was a `console.warn` in a WebView console that cannot be
opened on iOS from a Windows machine. The healthy platform's rows stood in for both.

**The reason is the client's classification and the server never rewrites it.** `no-token` (the OS
never produced one) and `rejected` (the token existed and the backend refused the registration) are
different defects with different owners, and a server that normalised an unrecognised value into a
known one would delete the only evidence that a client had learnt something the server has not been
taught. Unknown reasons are printed verbatim, capped at 120 characters; a missing reason prints
`unstated`, never an empty field.

**It is reported ONCE, at the end.** An early attempt can fail for a reason the next one fixes -
which is what the retry ladder exists for on slow Android token generation - so reporting one of
those would file a defect against a device that goes on to work. `PushNotificationService` therefore
returns a typed `PushRegistrationOutcome` rather than a boolean, and only the exhausted ladder
reports. Tests: `push.controller.unavailable.spec.ts` (server, including that it writes nothing) and
`PushNotificationService.unavailable.test.ts` (client - in its own file, because `pushAttempted` is
module state that latches).

#### Transport — single gateway (FCM)

Both platforms are delivered through **Firebase Cloud Messaging**; there is no direct
APNs provider in the backend. For each `PushToken`, `MessagingService` issues one
`getMessaging().send()` carrying **only the half that token's platform reads**:

- an Android token gets the `data` map — read by `onMessageReceived` (fires foreground **and**
  background) — plus an `android` block (`priority: high`, 24 h TTL);
- an iOS token gets the `apns` block alone, shaped by `buildApnsRequest` in `push-payload.ts`,
  which spreads the same fields into a self-contained APNs payload.

**Why it is split, and it was not until 2026-08-30.** Every message used to carry both blocks, so
the ciphertext travelled **twice** in one message - and FCM sizes the MESSAGE, not the half the
device will read. On the shape that failed: `data` 3 789 B + `apns` 4 005 B = **7 794 B against a
4 096 B limit**, for a proto the guard had passed. That refused ten pushes in one run, to one
Android device, twice over (2026-08-29 and 2026-08-30, `Message is too large. The maximum is 4K`).
FCM ignores the `apns` block for an Android token and the `data` map is redundant for an iOS one,
so nothing was gained by sending both. `push-payload.spec.ts` pins the arithmetic, including the
case where each representation alone fits and their sum does not.

**The inline-ciphertext budget is computed from the fields, never chosen ahead of them.** The guard
was `Buffer.byteLength(protoB64) <= 3_500` applied to the ciphertext ALONE, under a comment
correctly stating the 4 KB budget belongs to the payload - so it bounded a quantity strictly
smaller than the one the limit is about. `inlineProtoBudget` now builds the payload with an empty
proto, measures **both** representations and leaves what the tighter one allows: the APNs framing
plus its `aps` block costs about 216 B more than the raw data map, and one payload is built for all
of a user's devices. What it protects against is `senderName` and `groupName`, which are unbounded
user text that nothing upstream caps. A proto that does not fit is not an error - the client fetches
the ciphertext instead - but it is logged, because a budget routinely too small is the fixed fields
growing and nothing else watches them.

A size refusal now logs `[PUSH_SIZE]` naming what was actually sent, both representations and the
largest single field: FCM's own error names no quantity at all, which is why ten identical refusals
said only "too large".

#### The one sentence this server still composes, and the column that tells it the language

Every other sentence on the push path is written BY the device: `push-content.ts` sends
`contentKey` + `actorName` + `contentArg` and the native tables build the wording, precisely because
the server cannot know who is reading. **One sentence cannot follow that rule** - `APNS_FALLBACK_BODY`,
the `alert.body` of a visible MLS message push. It is what an iPhone shows when the Notification
Service Extension does not run or cannot decrypt, and in that state the device has composed nothing.
It was `'Nouveau message'`, hard-coded, for every user in every language.

**So the language is CARRIED to the decision rather than guessed at it.** `push_token.locale`
(migration `020`) is written by `POST /mls/push/register` from `getLocale()`, the app's own choice -
the same fact `push_context.json` already mirrors natively for the NSE. `buildApnsRequest` takes it
and picks from a two-entry table; null reads as the base locale, and so does a tag the table does not
know, because refusing a registration over a language would cost the device every notification to
spare it one word.

**Two things this cost, and neither was visible from the column alone.**

- **The client's skip predicate had to be re-visited.** `registerPushToken` skipped the POST when the
  FCM token was unchanged - and `changeLocale` reloads the document while `sessionStorage` survives a
  reload, so the one registration that exists to record a language change is exactly the one that
  would have been skipped. The stored value is now `<token>|<locale>`: a skip key, not a token, and
  `stopPushService` reads it for presence only. Adding a second discriminator means re-visiting every
  predicate that tested the first.
- **The inline-ciphertext budget is one number for devices that may read different languages.** It is
  computed once per message, the ciphertext it admits is chosen once, and only then is the payload
  built per device - so a per-device body must never be able to make a payload larger than the one
  the budget measured. `inlineProtoBudget` sizes on `LONGEST_FALLBACK_LOCALE`, derived from the table
  rather than typed, so adding a language can only ever make the budget tighter. `push-payload.spec.ts`
  pins it by filling a payload to the budget and asserting every language still fits; sizing on the
  short language instead fails three of its tests.

**Why not an APNs `loc-key`, which looks cleaner.** It would need no column at all: iOS resolves it
against the app's own `Localizable.strings`, in the device's language. It is a REGRESSION today. iOS
shows the RAW KEY when a `loc-key` does not resolve - it does not fall back to `body`, so sending
both does not help - and `notif.message.encrypted` entered `canari_iOS/*.lproj` only on 2026-08-15
(`e3593d4e`) while the NSE has existed since 2026-07-21. A build from that window would show the
literal text `notif.message.encrypted` on precisely the path this is meant to fix. It also reads the
DEVICE's language, where everything else here reads the in-app Canari locale.


FCM applies the `android` block to Android tokens and **relays the `apns` block to Apple's
APNs** for iOS tokens, using the APNs `.p8` auth key uploaded in the Firebase console
(Project Settings → Cloud Messaging → APNs Authentication Key). Visible iOS pushes carry
`mutable-content: 1` so a Notification Service Extension can decrypt and rewrite the alert
(until that extension ships, the generic fallback title/body is shown); silent frames carry
`content-available: 1`, mirroring the Android data-only push. iOS clients register their
**FCM** token (not a raw APNs device token) via `/api/mls/push/register` with `platform: "ios"`.

**One send, two payload builders.** Every push leaving this service goes through
`MessagingService` and carries an `apns` block: `buildApnsRequest` shapes the MLS one,
`buildInternalApnsRequest` the non-MLS one (community channel messages and their silent
`channel_read` frames, posts, form reminders — everything arriving from social-service on
`POST /api/internal/push/notify`). That endpoint **delegates to `sendPushToUser` and sends nothing
itself**: it used to hold a second copy of the send loop, identical minus the `apns` block, and FCM
turns a message with no `apns` block into a data-only push — never surfaced by iOS, never handed to
the NSE. Every salon message, post, form reminder and cross-device read frame was therefore dropped
by every iPhone while the endpoint answered `sent` (fixed 2026-08-16; `internal.controller.push.spec.ts`
asserts the block on the message that actually reaches FCM, because `push-payload.spec.ts` had
covered the builder field by field and none of it applied to a caller that never called it).

**Which iOS process a push reaches is decided here.** `mutable-content: 1` (alert) runs the
Notification Service Extension; `content-available: 1` (background) goes to the app
(`canari_push.mm` `CanariHandleFcmData`) and never to the extension. So a silent type — today only
`channel_read` — is acted on by the app alone, and listing one in the NSE's switch is a branch that
cannot execute. `frontend/src/lib/mobile/channelPushFields.test.ts` pins both directions across the
seam.

**Client config & build:** the Firebase client config files are gitignored and injected by CI
from secrets — `GOOGLE_SERVICES_JSON` (Android → `google-services.json`) and
`GOOGLE_SERVICE_INFO_PLIST` (iOS → `canari_iOS/GoogleService-Info.plist`). The iOS Firebase
SDK is pulled via **Swift Package Manager** (not CocoaPods). The APNs↔FCM token bridge relies
on Firebase's App Delegate Proxy (`FirebaseAppDelegateProxyEnabled`, which must stay enabled).
The iOS `aps-environment` entitlement is `production` for TestFlight/App Store builds.

#### iOS background execution

Android drains the pending MLS state from an expedited `MlsBackgroundWorker` (WorkManager). The
iOS peer is a **`BGProcessingTask`** (`fr.emse.canari.cleanup`, listed in
`BGTaskSchedulerPermittedIdentifiers`): its launch handler is registered in `canari_ios_bootstrap`
(before `UIApplicationMain`, as `BGTaskScheduler` demands) and runs
`canari_native_cleanup_pending_db` to clear `mls_pending.db`. A request is re-submitted on every
background entry (`willResignActive`) and after each run, but iOS decides when — there is no
guaranteed cadence.

**Force-quit is terminal on iOS:** once the user swipes the app away, iOS delivers **no** silent
`content-available` data pushes and runs **no** `BGTask` until the app is manually relaunched. This
is a platform constraint with no workaround; visible (`mutable-content`) alert pushes still arrive
and wake the (future) Notification Service Extension, so the user is never fully silenced, but
background state-sync only resumes on next open. Android has no equivalent restriction.

#### Notification quick actions (reply / mark as read)

Both platforms attach two inline actions to an MLS message notification (never on a `channel_`
conversation - channels are server-authoritative, no MLS outbox to route through): "Repondre"
(text input) and "Marquer comme lu". Both fire while the app is fully killed - Android via a
`BroadcastReceiver`, iOS via a brief OS relaunch to deliver `didReceiveNotificationResponse`.

Since the TS runtime that normally builds an `AppMessage` proto isn't running, a minimal
dependency-free protobuf encoder (`mobile::proto_fields::build_text_app_message` /
`build_read_receipt_app_message` in `frontend/src-tauri/src/mobile/proto_fields.rs`) is exposed
identically to Android JNI (`nativeBuildTextMessageProto`/`nativeBuildReadReceiptProto` on
`CanariFirebaseMessagingService`) and iOS FFI (`canari_native_build_text_message_proto`/
`canari_native_build_read_receipt_proto`). Both actions reuse the existing outbox-drain path
unchanged: the built proto is appended to the `outbox_pending.ndjson` mirror and drained
immediately via the same `drainOutboxBackground`/JNI-or-FFI encrypt + `/api/mls/push/send` call
the background welcome-join/decrypt flows already use.

- **Reply** queues a plaintext `TextMsg` entry (`silent: false`) and only clears the notification
  once the drain actually delivers it (0 remaining) - a queued-but-undelivered reply keeps the
  notification so the user can retry from the app.
- **Mark as read** clears the notification immediately (visible feedback), then best-effort sends
  a silent `SystemMsg{event:"read_receipt"}` (`silent: true`) covering every messageId cached for
  that conversation in `fcm_message_cache.ndjson`. This is cross-device sync only - a peer/sibling
  device receiving that silent push cancels its own notification (existing read-state-sync path);
  this device's local unread-badge/readBy state is not reconciled and self-corrects next time the
  conversation is opened in-app.
- Android: `CanariNotificationActionReceiver.kt` (`ACTION_QUICK_REPLY`/`ACTION_MARK_READ`
  broadcasts). The outbox/notification helpers it shares with `CanariFirebaseMessagingService` live
  in that service's companion object, taking an explicit `Context` param (a bare
  `CanariFirebaseMessagingService()` instance is Context-unsafe - `Service` extends
  `ContextWrapper`, and `attachBaseContext` is never called on a manually-instantiated one).
- iOS: `CanariRegisterNotificationCategories`/`CanariHandleQuickReplyAction`/
  `CanariHandleMarkReadAction` in `canari_push.mm`, wired into `CanariNotificationDelegate`'s
  `didReceiveNotificationResponse`.
- iOS gotcha: the action buttons only appear when the delivered notification carries
  `categoryIdentifier == "canari_message_category"`. The app-alive path stamps it in
  `CanariShowLocalNotification`, but when the app is fully killed the NSE
  (`canari_NSE/NotificationService.swift` `applyMessageContent`) is the ONLY path that builds the
  visible alert, so it must stamp the same id too (MLS DM/group only) - the backend APNs payload
  does not send `aps.category`. iOS retains the category the app registered across termination, so
  the stamp is enough.
- Gotcha: the outbox mirror rewrite (both platforms) must persist the `silent` flag on every
  write, or a control event that survives one failed drain attempt loses its silent flag on retry
  and resends as a visible push.

#### App-icon unread badge

The launcher/home-screen badge mirrors the number of **distinct unread conversations** (not
messages). It is driven entirely off the currently displayed message notifications, so it moves up
on push receipt and down on read-state cancel with no separate counter to keep in sync.

- **Android** (`CanariFirebaseMessagingService`): `countUnreadConversations` counts the active
  message notifications (excluding the group summary and the pending-sync nudge), and
  `refreshBadgeSummary` rebuilds the group summary carrying that count via `setNumber(count)` (or
  cancels the summary when it hits 0). It is the single source of truth for both the summary and the
  badge, called after every message notification post (`showNotification`) and every cancel
  (`cancelConversationNotification`); `cancelAllMessageNotifications` clears the summary and thus the
  badge on app open. Numeric badges are honored by stock Android / Pixel / recent OEM launchers;
  some older launchers only show a dot (no third-party ShortcutBadger dependency).
- **iOS** has two writers because the badge owner depends on process state:
  - App alive (`canari_push.mm`): `CanariUpdateAppBadge` recomputes from the delivered chat
    notifications and calls `setBadgeCount` (iOS 16+) / `applicationIconBadgeNumber`, after
    `CanariShowLocalNotification` (message threads only) and both cancel paths
    (`CanariCancelConversationNotification`, `CanariPushCancelMessageNotifications`).
  - App killed (`canari_NSE/NotificationService.swift`): the extension writes `content.badge`
    directly (no `UIApplication` in an extension) via `applyBadgeCount`, counting the delivered chat
    conversations plus the incoming one.
  - Both count a conversation by its per-conversation `threadIdentifier` (NSE deliveries, WP-iOS-7)
    or the stable request id (app-alive deliveries, both now use per-conversation `groupId` as
    `threadIdentifier` since WP-XP-7) - both are unique per conversation - and gate on a
    `fr.emse.canari://chat` deep link so social/form notifications never count.

#### Rich media notifications (image/GIF thumbnail)

An image or GIF message shows its decrypted thumbnail inside the notification, on both platforms and
while the app is fully killed (WP-XP-3). Scope is **images + GIF only**: video/audio keep the existing
text preview (`📷 Photo` / `🎥 Vidéo` ...). This is the MLS DM/group path only - community channels
keep their text preview.

Because media is end-to-end encrypted (the media service stores only opaque AES-256-GCM ciphertext,
the CEK/IV live inside the MLS message), the native notification builder must fetch and decrypt the
blob itself:

1. **Decrypt metadata**: the shared Rust parser `extract_full_message_info` (`proto_fields.rs`) now
   emits `mediaId` + base64 `mediaKey`/`mediaIv` + `mimeType` alongside `mediaKind` for a `MediaMsg`.
   These ride the same decrypt JSON both platforms already parse.
2. **Fetch ciphertext**: a killed app has no user JWT, so the blob is pulled through a new
   PushSecret-authed proxy `GET /api/mls/push/media/:mediaId` (chat-delivery), which relays it from
   media-service's server-to-server `GET /api/media/internal/:id` (X-Internal-Secret gate). A **2 MB
   cap** (matching client-side send compression) keeps videos and oversized blobs out - above it the
   proxy returns 413 and the native side shows the text-only notification.
3. **Decrypt blob**: a new leaf FFI decrypts the ciphertext with the CEK, reusing the channel AES-GCM
   path (`background::decrypt_media_blob`). Android JNI `nativeDecryptMedia(keyB64, ivB64, ciphertext)`
   returns the plaintext bytes; iOS C-ABI `canari_native_decrypt_media(..., out_len)` returns a heap
   buffer freed with `canari_free_bytes`. The plaintext (original image bytes) never transits the
   server or FCM.
4. **Attach**:
   - **Android** (`CanariFirebaseMessagingService.fetchAndDecryptMedia`): writes the decrypted image
     under the FileProvider-mapped cache dir (`cacheDir/tauri/notif_media/`, 24 h sweep) and attaches
     it inline via `MessagingStyle.Message.setData(mime, contentUri)` - preserving conversation
     stacking + quick actions. NotificationManager grants SystemUI read access to the content URI.
   - **iOS** attaches a `UNNotificationAttachment` from a decrypted temp file. Since iOS shows only the
     first image attachment as the banner preview, the **media thumbnail outranks the sender avatar**
     (avatar is used only for text/non-image). App alive: `canari_push.mm`
     `CanariFetchAndDecryptMedia` → `CanariShowLocalNotification`. App killed:
     `canari_NSE/NotificationService.swift` `fetchAndDecryptMedia` → `attachImage`.

Gotcha: only `mediaKind == "image"` (which also covers GIF, mime `image/gif`) is rendered; the
extension budget (~30 s) and the 2 MB cap bound the background download + decrypt.

#### Boot/relaunch re-registration (WP-XP-4)

An FCM token can rotate while the phone is off; `onNewToken` only fires on **change events the
process observes**, so a rotation missed during downtime leaves the backend pushing to a dead
token until the app is manually opened. Outbox messages queued before a reboot wait just as long.

- **Android** — `CanariBootReceiver` (manifest receiver, `BOOT_COMPLETED` +
  `MY_PACKAGE_REPLACED`, `exported="false"` — both are protected system broadcasts; requires
  `RECEIVE_BOOT_COMPLETED`). On fire (`goAsync` + wake lock + worker thread, like
  `CanariNotificationActionReceiver`):
  1. Force-reads the current FCM token (`Tasks.await(FirebaseMessaging.getInstance().token)`),
     persists it (`fcm_token.txt` + prefs) and re-registers it on the backend via the PushSecret
     endpoint `POST /api/mls/push/refresh-token`
     (`CanariFirebaseMessagingService.refreshTokenOnBackend`, now a companion function). The
     backend refresh is unconditional — even an unchanged token heals a server-side entry that
     expired while the device was off.
  2. Drains the outbox mirror through the shared `drainOutboxBackground` path (which also warms
     the MLS state via the JNI). Skipped silently when the device is not enrolled
     (`push_context.json` / pushSecret absent).
  `BOOT_COMPLETED` is delivered post-unlock, so credential-encrypted storage is available.
- **iOS** — no OS boot hook exists, and the equivalent CANNOT be a launch-time fetch. Until
  2026-08-28 `canari_push.mm` `CanariPushSetup` called `tokenWithCompletion` at the bottom of
  `canari_ios_bootstrap()`, as the declared mirror of Android's step 1 - but FIRMessaging cannot mint
  an FCM token before an APNs token exists, and that only arrives after
  `registerForRemoteNotifications`, which the same bootstrap schedules for `DidFinishLaunching`. That
  call could only ever fail. The equivalent is now `CanariSyncFcmTokenIfApnsReady()`, called from
  `CanariOnDidBecomeActive`: it returns with a line if `[FIRMessaging messaging].APNSToken` is nil,
  otherwise it fetches, persists and refreshes on the backend. `didBecomeActive` fires after launch
  completes and on every foreground, so first-open-after-reboot is still covered - see
  [mobile](../frontend/mobile.md#the-fcm-token-an-iphone-could-never-obtain-and-the-silence-that-hid-it-for-the-platforms-life).

CI guard: `src/lib/mobile/androidFcmManifest.test.ts` fails if the receiver, its actions, or the
`RECEIVE_BOOT_COMPLETED` permission are dropped from the manifest (e.g. by `tauri android init`).

#### Priority notifications - calls & @mentions (WP-XP-5)

Incoming calls ring like real phone calls and @mentions break through the normal notification
tier, on both platforms, app killed included.

**Ring signal - why an explicit endpoint.** The server cannot read MLS ciphertexts, so it cannot
tell a call invite apart from a text message. Instead the **caller's client** POSTs
`/api/calls/ring` (JWT) right after sending the MLS `CallMsg` invite - which is now sent
**silent**, like all call signaling (invite/answered/hangup), killing the old generic
"Nouveau message de X" push for call traffic. The backend verifies membership and fans out
per member token:

- **Android** → high-priority FCM data `{type: "call_ring", groupId, callId, callerId,
  callerName, senderName, groupName, hasVideo}`. `senderName` is a legacy alias so old builds
  show a normal "message" notification instead of nothing.
- **iOS with a `voipToken`** → **direct APNs VoIP push** (`ApnsVoipService`) - the single
  deliberate exception to the all-FCM rule, because FCM cannot carry `apns-push-type: voip`
  and only a VoIP push may wake CallKit from a killed state. ES256 provider JWT (cached 40 min)
  over node:http2, topic `<bundle>.voip`, `apns-expiration` now+45 s; a 410 response clears the
  stored `voipToken`.
- **iOS without `voipToken`** (legacy builds) → FCM alert banner ("📞 Appel entrant").

`/api/calls/ring-end` (reason `answered`/`cancelled`/`ended`) is sent to **all** members
including the caller's own devices and stops the ring everywhere; both platforms also arm a
local 60 s timeout as a safety net. Ordering gotcha: `call_ring_end` must be processed **before**
the foreground guard on both platforms - a stale ring must clear even if the user has since
opened the app.

- **Android** (`CanariFirebaseMessagingService`): channel `canari_calls` (IMPORTANCE_HIGH,
  ringtone audio attributes, `setBypassDnd`). `showIncomingCallNotification` builds a
  `NotificationCompat.CallStyle.forIncomingCall` (API 31+; two-action fallback below) with
  full-screen intent (`USE_FULL_SCREEN_INTENT`), `FLAG_INSISTENT` looping ringtone,
  `CATEGORY_CALL`, 60 s `setTimeoutAfter`. Answer = deep link
  `fr.emse.canari://chat/<groupId>?acceptCall=<callId>&video=<0|1>`; decline = local dismiss
  broadcast (`ACTION_CALL_DECLINE` - group decline only means "stop ringing me").
  `activeCallRings` dedupes the explicit `call_ring` against the MLS invite push
  (`call_invite` typed extraction is the fallback ring for pre-WP-XP-5 callers).
- **iOS** (`canari_push.mm`): PushKit `PKPushRegistry` delivers the VoIP push;
  `CanariReportIncomingCall` **must** report a CallKit call immediately (Apple contract -
  missing it terminates the app). Answer cannot start audio directly (MLS/WebRTC live in the
  webview behind the PIN): `performAnswerCallAction` writes `pending_call_accept.json` + fires
  the accept deep link; the TS store `pendingCallAccept` drains it
  (`read_and_clear_pending_call_accept`) and `CallService` auto-accepts when the matching MLS
  invite arrives over WS post-unlock. The CallKit session is ended (`AnsweredElsewhere`) on
  `didBecomeActive` - handover to the in-app call UI. The PushKit token is persisted to
  `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field) and rotations
  via `/api/mls/push/refresh-token`.
- **@mentions**: for an MLS message, native detection = decrypted text contains `@[<myUserId>]`
  (case-insensitive; userId from `push_context.json`) - the server cannot read the message, so the
  device has to look. **A CHANNEL MESSAGE IS TOLD INSTEAD**: it carries the sender's cleartext
  `mentionedUserIds`, so the social-service computes `mentioned` per recipient (the same fact that
  honours the `mentions` level) and all three handlers read it since 2026-08-16 - the only answer
  that still works when the ciphertext was too large to inline and there is no text to scan. Both
  paths then land in the same place: Android posts on `canari_mentions` (IMPORTANCE_HIGH,
  `setBypassDnd`; posted-notification channel switches require cancel-then-notify). iOS sets
  `interruptionLevel = .timeSensitive` (app-alive path and NSE), which needs the
  `com.apple.developer.usernotifications.time-sensitive` entitlement - without it iOS silently
  downgrades to `.active`.
- **NSE** (`NotificationService.swift`): `call_invite` → ringtone + time-sensitive banner with
  the accept deep link; `call_control` with `callEnded` → blank passive content + removes any
  delivered notification whose `userInfo["canariCallId"]` matches.

#### Unified rich notification grouping (WP-XP-7)

One conceptual notification model shared across both platforms: per-conversation stacking, a
group summary, avatar/initials fallback, and sender-name subtitles inside group chats.

**Per-conversation stacking**

- **Android** — `NotificationCompat.MessagingStyle` already stacks successive messages of the same
  conversation into a single notification since the initial implementation. Each conversation gets a
  stable `notifId` (`getStableNotifId(groupId)`); rebuilding from the active notification (bounded to
  `MAX_NOTIF_MESSAGES = 6`) preserves history across pushes. All conversation notifications carry
  `.setGroup(GROUP_KEY_MESSAGES)` so Android bundles them under one expandable group.
- **iOS** — two paths, unified under the same `threadIdentifier = groupId` model:
  - **App killed** (`NotificationService.swift`): the NSE already set per-conversation
    `threadIdentifier` (WP-iOS-7), so successive pushes from the same groupId stack naturally.
  - **App alive** (`canari_push.mm`): `CanariShowMessageNotification` previously passed the flat
    `@"canari_messages"` thread for every chat notification — successive messages overwrote each
    other regardless of conversation. Now it passes `groupId` as `threadIdentifier` (fallback
    `@"canari_messages"` when empty), mirroring the NSE. Social/form notifications keep their own
    threads (`canari_social`/`canari_forms`).

**Group summary**

- **Android** — `refreshBadgeSummary` builds a group-summary notification (`.setGroupSummary(true)`)
  on `GROUP_KEY_MESSAGES` every time a message notification is posted or cancelled. The summary
  carries the unread-conversation count via `.setNumber(count)` which also serves as the launcher
  badge (WP-XP-2). When the count hits 0 the summary is cancelled.
- **iOS 15+** — `UNMutableNotificationContent.summaryArgument` is set to the conversation title
  (group name for groups, sender name for DMs, `"Canari"` fallback). The system shows this text in
  the stacked-notification group summary line. Set by both paths:
  - App alive: `CanariShowLocalNotification` (new `summaryArgument` parameter).
  - App killed: `NotificationService.swift` `applyMessageContent`.

**Subtitle (group chats)**

- **Android** — `MessagingStyle.Message` already carries the sender `Person` object, so the sender
  name is shown inline with each stacked message.
- **iOS** — `UNMutableNotificationContent.subtitle` is set to the sender name inside group
  conversations (when `isGroup && senderName` is non-empty). Both the app-alive path
  (`CanariShowLocalNotification` new `subtitle` parameter) and the NSE path
  (`applyMessageContent`) set it. Flat DMs already have the sender as the title, so no subtitle is
  set.

**App-open cancel**

When the app opens, `CanariPushCancelMessageNotifications` now clears every delivered chat
notification — both the legacy flat-thread ones and the new per-conversation ones — by checking
the `deepLink` prefix (`fr.emse.canari://chat`) in addition to the `threadIdentifier`.

#### Shared deferred-retry engine (WP-XP-8)

When the opportunistic outbox drain (FCM push, Welcome join, boot receiver) leaves messages unsent
(network down, server unreachable), a shared deferred-retry engine automatically retries with
exponential backoff on both platforms.

- **Android** — `OutboxRetryWorker` (WorkManager): expedited one-shot work request with exponential
  backoff (30s → 60s → 120s …). After 3 consecutive failures it enters a persistent failure state
  and shows the "open the app" nudge (`showPendingSyncNotification`). The flag resets when the user
  opens the app (`MainActivity.onResume`). A foreground guard defers retry when the TS outbox
  flusher is active (avoids double-send).
- **iOS** — `BGTaskScheduler` handler `fr.emse.canari.outboxRetry`: `BGProcessingTaskRequest` with
  `requiresNetworkConnectivity = YES`. The handler drains the outbox mirror and re-submits the
  request on failure so a window always stays queued. Unlike Android WorkManager, iOS
  BGTaskScheduler offers no guaranteed cadence — the "open the app" nudge (`CanariShowPendingSyncNotification`)
  remains the safety net. The existing cleanup handler (`fr.emse.canari.cleanup`) is unchanged.

Both platforms trigger the retry from the same seam: `maybeNotifyPendingSync` /
`CanariMaybeNotifyPendingSync` — when the opportunistic drain leaves `remaining > 0`, it shows the
nudge AND schedules the next automatic retry. This closes the "Foreground/background service"
parity row.

### Security / PIN

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Check/register PIN verifier (PBKDF2) |
| GET | `/api/mls/security/pin-status/:userId` | Check if PIN is registered |
| POST | `/api/mls/security/pin-change` | Change PIN verifier |
| POST | `/api/mls/security/pin-reset` | Reset PIN (purge devices, keep memberships) |
| GET | `/api/mls/link-preview` | Fetch safe external URL preview |
| GET | `/api/mls/link-preview/image?url=` | Proxy a preview's `og:image` or favicon |
| GET | `/api/mls/link-safety?url=` | Google Safe Browsing verdict for a URL (WP-SAFELINK-1) |

#### Who carries the MiGallery key, and who does not

One rule, decided on 2026-08-17: **an image is public and needs no key, a metadata read does.**

`fetchMiGalleryPreview` calls `/api/albums/:id/info` with `MIGALLERY_API_KEY`, because that
endpoint stays gated for private albums - it is the only credentialed call to MiGallery in this
service. Cover images are not: MiGallery serves `/cover` (square) and `/og-cover` (wide) publicly
for every visibility, since an external site embeds one from an `<img>` tag, which carries no key.
They go through the ordinary `/api/mls/link-preview/image` proxy like any other preview image -
which is also the only path with the SSRF guard and the content-type check.

A second, key-carrying `/api/mls/gallery-cover/:albumId` proxy existed until then, from when covers
were gated. Deleting it is what makes the rule true rather than aspirational: with two doors to one
site, which credential applied depended on which field of the payload the client happened to read.

#### Link preview is a user-controlled server-side fetch (SSRF)

`/api/mls/link-preview` takes a URL from a chat message and fetches it from inside the cluster, so
`utils/url-guard.ts` is what stands between a pasted link and the internal network. Two barriers,
because one is not enough:

- **`assertSafeExternalUrl`** rejects non-http(s) schemes, embedded credentials, `localhost`, and
  any host that DNS-resolves to a non-public address. Redirects are handled manually
  (`redirect: 'manual'`, 3 max) and each hop is re-validated - an allowed host that answers `302
  http://127.0.0.1/` is the obvious bypass otherwise.
- **`ssrfSafeDispatcher`** re-checks at connect time through undici's `lookup`, so the IP the
  socket reaches is the IP that was validated. This closes the DNS-rebinding window: the two
  resolutions are separate events and an attacker-controlled zone can answer differently.

**The dispatcher and the `fetch` that carries it must come from the same undici copy**, which is
why every call site goes through `ssrfSafeFetch` rather than passing `dispatcher:` to the global
`fetch`. Node bundles its own undici behind the global `fetch`; handed an `Agent` built from the
`undici` package, it throws `InvalidArgumentError: invalid onRequestStart method` before opening a
socket - the two copies disagree on the dispatch handler interface. That mismatch broke *every*
non-YouTube preview in production after the undici major bump, and it was invisible because `fetch`
reports it as a bare `TypeError: fetch failed` and the handler answered a generic
`Link preview failed`. The failure is now logged (`[LINK_PREVIEW] <host> failed: <cause>`), and
`url-guard.spec.ts` pins the pairing offline: a fetch to `localhost` must fail with `ESSRFBLOCKED`
(our lookup ran) and nothing else.

#### One fetch per page per six hours, not one per reader per render

`TtlCache` (`utils/ttl-cache.ts`) is a bounded map with a per-entry TTL and LRU eviction, and
`SecurityController` holds two static instances of it: 500 previews and 200 proxied images.

| | TTL | why |
|---|---|---|
| preview, success | 6 h | Open Graph tags change on the scale of an edit, not of a render |
| preview, refused (400) | 10 min | the site ANSWERED something unusable - a 404, a non-HTML body, a page over 1 MB, a redirect to a private address. A fact about this URL, and re-downloading the page to rediscover it is what the cache exists to stop |
| preview, **unreachable (502)** | **never** | not a fact about the URL at all |
| proxied image | 6 h | and only when the body is <= 256 KB - a favicon is asked for constantly and costs a kilobyte, a full-size `og:image` would evict a hundred of them to save one request |

**ONLY AN ANSWER MAY BE CACHED, AND ONLY AN ANSWER MAY BE A 400.** Both halves were wrong until
2026-08-16 and they compounded: a Wikipedia connect timeout was stored as a refusal and replayed as
`400` - *your request was malformed* - to every reader for ten minutes, for a page that answered
normally six minutes later (`cache hit ... ok=true`, same log). The distinction is carried by a TYPE,
`UpstreamUnreachableError`, thrown where the failure happens rather than recovered from a message at
the top: every outbound call inside `resolveLinkPreview` goes through its `reachOr` wrapper, so
"the site said something unusable" and "the site said nothing" cannot be confused by the handler.
An unexpected error - a parser fault, a bug in this file - is neither cached nor blamed on the
caller: it is a `500`, logged at `error`.

**One budget, and every mechanism that can enforce it agrees.** `OUTBOUND_BUDGET_MS` (4 000 ms) arms
the endpoint's `AbortController` for the whole operation - redirect chain and oEmbed follow-up - AND
the dispatcher's `connect.timeout`, `headersTimeout` and `bodyTimeout` for each individual leg.
There used to be two: the stated 4 s abort, and undici's untouched 10 s defaults, which is the one
that actually fired (`ConnectTimeoutError ... timeout: 10000ms`). A stated budget that is not the one
that fires is a comment, not a rule. `fetchYouTubeOEmbed` was outside both - no signal reached it at
all, on the FIRST outbound request the preview path makes - and it now takes the same signal.

The endpoint answers cached entries with a matching `Cache-Control: public, max-age=`, which is the
only way to stop the browser asking at all. Before this, every render of every message re-downloaded
the remote page: a conversation scrolled back through hammered a site that never agreed to any of
it, and each of those requests announced that somebody was reading.

The cache is per-process, and deliberately so - chat-delivery runs as a single instance, so a shared
store would be infrastructure bought for nothing. Replicating the service costs hit rate, never
correctness, which is what makes the choice reversible.

#### Link safety is its own endpoint, deliberately not a field on the preview (WP-SAFELINK-1)

`/api/mls/link-safety?url=` answers `{ unsafe: boolean }` from Google Safe Browsing's Lookup API
(`utils/safe-browsing.ts`), gating navigation client-side through `confirmUnsafeLinkIfNeeded`
(`frontend/src/lib/utils/checkLinkSafety.ts`), which only shows a confirmation (`showConfirm`,
danger-styled) at the point of an actual click on a flagged link - never a badge decorating every
rendered link, which would be alert fatigue for a check that is almost always going to say "fine".

**The gate lives in `openExternal()` (`frontend/src/lib/utils/openExternal.ts`), not in the two
components that render a link.** It shipped there first (`AppLink`/`LinkPreviewCard` each gating
their own bubble-phase `onclick`), which worked on the web and was silently dead on every Tauri
build: a document-level CAPTURE-phase listener installed by `hooks.client.ts`, pre-existing since
April for unrelated in-app-link routing, already intercepts and `stopPropagation()`s the same click
before it reaches the anchor, and opens the URL through `openExternal` directly. Moving the check
into `openExternal` itself - the one function every path to an actually-opened URL calls, including
that interceptor and the conversation's shared-links tab (which had no check on any platform) -
means no future caller can bypass it by forgetting to call `confirmUnsafeLinkIfNeeded` first. See
[durable-rules](../durable-rules.md#mobile-and-native---frontendmobile).

- **A separate endpoint from `getLinkPreview` on purpose.** The two checks have unrelated failure
  modes: a page with a broken `<title>` or a redirect loop makes `getLinkPreview` throw and return
  nothing at all. Folding the safety verdict into that response would have taken it down with the
  metadata fetch, and `AppLink` cares only about the verdict, never about whether the site also has
  good Open Graph tags.
- **No SSRF guard needed for the Safe Browsing call itself** - unlike the preview fetch, the target
  of this request is always Google's own fixed endpoint; the caller-supplied URL only ever appears
  as a JSON string in the POST body, never as something this service connects to. `assertSafeExternalUrl`
  is still run first, same as the preview endpoint, since the URL has to be validated before being
  used as a cache key either way.
- **Fails OPEN at every layer** - no `GOOGLE_SAFE_BROWSING_API_KEY` configured, a network error, a
  timeout, or a non-2xx response from Google all resolve to "not flagged". A safety check that
  cannot answer must never become an outage for every link in the app; the config-side warning
  (`::warning::GOOGLE_SAFE_BROWSING_API_KEY is not set...` in `serve-prod.yml`) is the only trace of it.
- **Cached in its own `TtlCache<boolean>`**, independent of `previewCache` for the reason above.
  Google gives no cache guidance for a clean verdict (only a flagged match carries its own
  `cacheDuration`, e.g. `"300s"` - the longest one wins when several matches disagree), so a clean
  result gets a conservative 30-minute TTL chosen here; a failed lookup gets 5 minutes, short enough
  that a transient outage or a bad key self-heals on the next request rather than silently
  disabling the check for as long as a real answer would be trusted.
- **Client-side dedup, not a client-side TTL**: `checkLinkSafety` keeps a `Map<string, Promise<boolean>>`
  for the page's lifetime so `AppLink` and `LinkPreviewCard` asking about the same URL around the
  same time produce one request, not two - freshness across page loads is entirely the server
  cache's job.

#### Preview images are proxied, so the site never sees the reader

`/api/mls/link-preview/image?url=` fetches an image server-side and relays it. The card used to
point an `<img src>` straight at the remote host, so every reader of a message opened a connection
to a third party **from inside an end-to-end encrypted conversation**: the site learned each
reader's IP, their user agent, and the moment they scrolled to the message. Encrypting the body and
then fetching its illustration in clear gives a good part of that back.

- Same SSRF guard as the page fetch - the URL is caller-supplied, so it is exactly as
  attacker-controlled as the pasted link. Redirects are *followed* here rather than walked by hand
  (a CDN answers image requests with two or three), which is safe because `ssrfSafeDispatcher`
  re-validates at every connect.
- `image/*` only, **SVG excluded**: an SVG is a document that can carry script, and it would be
  served from our own origin. `X-Content-Type-Options: nosniff` on the way out.
- 3 MB ceiling, checked on `content-length` *and* on the received body, because the header can be
  absent or wrong.
- Unauthenticated, like the preview endpoint it serves: it fetches only public URLs and holds no
  credential.

Client-side the rewrite is one helper, `frontend/src/lib/utils/previewImageProxy.ts`, applied to the
`og:image` and to **every** favicon candidate - the conventional paths are derived in the browser, so
nothing server-side would have rewritten them. It skips URLs already on our own origin, which is
what keeps the MiGallery cover proxy from being proxied twice.

The CSP `img-src` is deliberately **not** tightened to match: Klipy GIFs and other remote sources
still need auditing, and that is a separate change.

#### oEmbed discovery covers Spotify, Vimeo, Bandcamp and X in one path

A page that declares `<link rel="alternate" type="application/json+oembed">` is publishing metadata
*for* embedders, and usually describes itself better there than in its Open Graph tags.
`extractOEmbedEndpoint` reads the declaration out of the HTML already downloaded, so discovery is
free; only following it costs a request, through the same SSRF guard (the href is someone else's
markup, so its scheme is checked, not merely its parse - the `extractIconUrl` trap again).

`mergeOEmbedIntoPayload` is written so it can be applied blindly: **Open Graph wins wherever both
speak.** oEmbed only fills gaps - a title where the page fell back to its hostname, a
`thumbnail_url` where there was no `og:image`, a `provider_name` where the site name was just the
host - and adds the one thing Open Graph has no field for, `author_name`, which becomes the
description when the page declared none. A site with good tags is never made worse.

The YouTube short-circuit stays ahead of all of it: it needs no HTML fetch at all, so it is strictly
cheaper.

#### Ecosystem sites are named, not spelled out

`frontend/src/lib/utils/ecosystemHosts.ts` maps the four hosts we share users with -
`gallery.mitv.fr`, `sky.mitv.fr`, `cercle.canari-emse.fr`, `portail-etu.emse.fr` - to the name the
reader knows them by. The badge rule below is unchanged; `sky.mitv.fr` simply names the destination
to nobody but whoever deployed it. The registry also carries the paths worth a cover-first card
(`EcosystemCoverPreview.svelte`, a MiGallery album today), which is what the hostname compared in
place used to decide. Adding a fifth site is one entry there. It carries no bundled logos on
purpose: the card already resolves each site's own favicon, which survives a rebrand.

#### Favicons come from the site, never from an icon service

`extractIconUrl` reads the page's own `<link rel="icon">` - the page is already downloaded for its
Open Graph tags, so the icon is free, and the site is the only authority on it. A third-party icon
service answers a generic placeholder for any host it has not crawled, indistinguishable from a
real icon, which is what made every self-hosted site look iconless; it would also leak every
browsed hostname out of an end-to-end encrypted conversation. The largest declared `sizes` wins,
then an `apple-touch-icon`, then anything else. The `href` reaches an `<img src>`, so its scheme is
checked explicitly - `new URL('javascript:...', base)` resolves rather than throws.

Client-side, `faviconCandidates` (frontend) turns that into an ordered list: the declared icon
first, then `/favicon.ico`, `/favicon.svg`, `/favicon.png`, `/apple-touch-icon.png`. Only the globe
is left once every candidate has failed - a site whose SPA answers `index.html` on `/favicon.ico`
(a 200 that is not an image) still gets its real icon, because the probe decides on the bytes.

**The list is walked with off-screen `Image` probes, never by cascading the displayed `<img>`
through its own `onerror`.** That `<img>` is one element reused across every candidate: assigning a
new `src` aborts the previous load but does not unqueue an error already fired for it, so a stale
event advances the pointer past the candidate now on screen. The chain is rebuilt exactly when the
preview payload arrives with the declared icon - i.e. while a conventional path is in flight - so
the race is the normal case, not an edge one: the icon appeared and was then replaced by the globe.
A probe owns its element, so an answer can only be about the URL that was asked.

#### The badge says where the link goes; the title says what is there

`LinkPreviewCard.svelte` draws two text lines, and the rule that keeps them from colliding is the
same on both branches: **the badge must carry what the title does not already say.**

| | badge | title |
|---|---|---|
| external | the HOST (`parsed.host`) | `og:title` |
| external, ecosystem | the site's NAME (`ecosystemSiteFor`) | `og:title` |
| in-app, typed | the KIND (Publication, Association, Formulaire, Profil) | the entity's name |
| in-app, plain route | `CANARI_BADGE_LABEL` | `publicAppLinkLabel()` (Accueil, Agenda...) |

Never `og:site_name` on the external branch: a great many sites set it to the page title, so the
card printed the same sentence twice. The in-app branch had the mirror-image bug - a plain route
has no entity, and both fields were fed the same `publicAppLinkLabel()`, giving "ACCUEIL CANARI"
over "Accueil Canari". The badge now falls back to the brand (the in-app counterpart of the host
chip) and the label is the title alone; correspondingly, `publicAppLinkLabel` names the
destination and never the app, since every surface that shows it already says Canari beside it.

**Deciding "is this address reachable" is the whole guard, and the address space is wider than
RFC 1918.** `isPrivateIpAddress` also rejects `0.0.0.0/8` (on Linux a connection to `0.0.0.0`
lands on loopback), CGNAT, the benchmark/protocol blocks, multicast and reserved space; on IPv6
the unspecified address, the full `fe80::/10` (not just the `fe80:` hextet) and multicast. Any
form embedding an IPv4 - `::ffff:127.0.0.1`, its hex spelling `::ffff:7f00:1`, `::127.0.0.1`,
NAT64 - is judged on the **embedded** address, because that is where the socket lands. A host that
cannot be parsed counts as private.

One parsing trap: `URL.hostname` keeps the brackets around an IPv6 literal, so `isIP('[::1]')`
answers "not an address" and skips the literal check entirely. `unbracketHost` strips them first.

### Distributed locks

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Calls

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, return a room token + room ID for the in-repo `call-service` SFU |
| GET | `/api/calls/room-token` | Get room token for recipient |
| GET | `/api/calls/ice-servers` | Get ICE server configuration |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |
| POST | `/api/calls/ring` | Fan out an incoming-call ring to all group members (WP-XP-5) |
| POST | `/api/calls/ring-end` | Stop the ring everywhere (reason: answered/cancelled/ended) |

The room id returned by `/api/calls/initiate` **is** the `callId` used by every other call route and
by the SFU, so this service's `[call] invite` / `[ring] call=` lines and call-service's
`[call] session ...` records join on that one value. The whole record, its disposition tokens and
how to read it are on [`call-service`](call-service.md#the-call-record) - keep no second copy here.

### Internal / health

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/internal/push/notify` | InternalSecret | Send push via internal secret |
| DELETE | `/api/internal/users/:userId` | InternalSecret | Delete all user MLS/device data |
| GET | `/api/health` | none | Liveness probe |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with core-service) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | no | Firebase Admin SDK credentials (push notifications) |
| `PUSH_SECRET` | yes | Shared secret for background push service routes |
| `INTERNAL_SECRET` | yes | Shared secret for internal service-to-service routes |
| `CALL_ROOM_SECRET` | yes, for calls | HS256 secret signing the 5-minute room token. Unset, `/api/calls/initiate` answers 503 |
| `MEDIA_SERVICE_URL` | no | media-service base URL (rich media notification proxy) |
| `APNS_VOIP_KEY_P8` | no | APNs auth key (.p8, raw PEM or base64) for direct VoIP pushes (CallKit) |
| `APNS_VOIP_KEY_ID` | no | Key ID of the APNs auth key |
| `APNS_VOIP_TEAM_ID` | no | Apple Developer Team ID (`4CLNB8SR6L`) |
| `APNS_VOIP_TOPIC` | no | VoIP topic, default `fr.emse.canari.voip` |
| `APNS_VOIP_SANDBOX` | no | `true` to target the APNs sandbox (dev builds) |
