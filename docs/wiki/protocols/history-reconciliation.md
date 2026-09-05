# History reconciliation

How a device works out that it is missing messages, and gets them.

This page specifies the **replacement** for the `history_request` / awaiting-marker machinery described
in [`mls-recovery-ladder.md`](mls-recovery-ladder.md). That machinery was measured in production on
2026-08-12 and found to be non-terminating; see [What was wrong](#what-was-wrong). Every decision
below was taken with the product owner on that date and is recorded, with what it displaced, in
[Decisions](#decisions-taken) - do not re-litigate one without going back there.

> **Status: IMPLEMENTED.** Everything specified here is shipped - D1-D7, the durability split, the
> read watermark, the conversation floor + device window, the `since` clipping, the state key and its
> cache, the reconciliation exchange on connect, the scrollback, the deletions under
> [What disappears](#what-disappears), and the three measured defects.
>
> **Green gates are all that has been established.** Not one line of it has run on a device or in a
> browser: the frontend suite passes and `svelte-check` reports nothing, which proves it compiles and
> that its units behave, and says nothing about a real conversation between two real devices. The
> [cross-client campaign](../cross-client-campaign.md) is what would, and it is owed from MSG-1 on this
> build.

---

## Constraints, measured rather than assumed

Read off production on 2026-08-12. They are why the design looks like this, so re-measure before
changing anything that leans on one.

| Fact | Value | Where |
| --- | --- | --- |
| Shared group log | Redis Stream `history:{groupId}` | `messaging.service.ts:681-695` |
| Size cap | `MAXLEN ~ 1000` per group | `messaging.service.ts:683-685` |
| Key TTL | 90 days, **refreshed on every write** | `messaging.service.ts:695` |
| Entry cost | ~431 bytes | `MEMORY USAGE`, prod |
| Redis memory | 2.42 MB used, `maxmemory 1gb`, `volatile-lru` | prod / `docker-compose.prod.yml:45` |
| Redis persistence | **none** - no volume, `appendonly no`, `dir /data` in the container layer | `docker-compose.prod.yml:35-53` |
| Per-device queue | Postgres `queued_message`, **deleted on ACK** | `messaging.service.ts:1941-1945` |
| Excluded from the shared log | Welcome, Commit, and every `silent` frame - reactions, edits, deletes, read receipts, `history_bundle` | `messaging.service.ts:662-678` |

Four consequences drive everything else.

1. **The server is not an archive.** The only shared copy is an unpersisted Redis stream, capped at
   ~1000 entries, evictable under memory pressure, destroyed when its container is recreated.
   Measured span for an active DM: **22.6 hours**. The devices are the archive.
2. **Holding the ciphertext is not the right to read it.** MLS forward secrecy means a device cannot
   decrypt anything from before it joined, and a spent ratchet generation (`secret-reuse`) is gone
   locally. Only a member that decrypted a frame at the time can re-encrypt it. This is the
   irreducible reason a peer exchange exists at all.
3. **No mutation has a shared copy today.** Reactions, edits, deletions and read receipts are
   queue-only and deleted on ACK, so a device that missed one can never obtain it except from a peer
   that still holds it.
4. **The cap is a global budget, not a per-group one.** At ~431 bytes an entry, 1 GB holds ~2.3 M
   entries; ~1000 per group is about right for 2000 active conversations. Raising it means raising
   `maxmemory` - which must not happen before the store is persisted, or the blast radius grows with
   it.

---

## What a connection pass costs, measured

Measured on an Android device against production, 2026-08-13, nine local groups. The pass is the
connection trigger: `initializeConnection.ts` calls `reconcileAllGroups` over every local group once
the mailbox has drained.

| Fact | Value |
| --- | --- |
| Cost of one group | **~480 ms**, almost all of it the `sendHistoryRequest` election round trip |
| Cost of the pass, sequential | **4.35 s** for 9 groups |
| Cost of the MLS encrypt + send | not separable from zero - `[HISTORY_STATE] Sent` and the `asked` line that follows it land in the same second |
| Reply when the two agree | **nothing at all** - silence is the answer |

```
10:37:13.136  [HISTORY_RECONCILE] asked 66e1b07e…
10:37:13.563  [HISTORY_RECONCILE] asked 4f87267a…        ← ~480 ms apart, strictly serialised
   ...
10:37:16.603  [QUEUE] Drain start groups=1 messages=1    ← the drain starts mid-pass
10:37:17.482  [HISTORY_RECONCILE] reconciliation pass complete - 9 group(s) asked
```

Three things follow, and each corrected a belief that was written down before it was measured.

1. **The probe was never expensive in FRAMES, and always expensive in TIME.** A matching digest costs
   zero reply frames, which was taken to make asking on every connection affordable. **That part of
   the design did NOT hold either, and the sweep is gone** - see the 2026-08-13 row in
   [Decisions](#decisions-taken). The frames were cheap for the *sender* and were counted as an
   arriving backlog by every *receiver*, because a count taken before decryption cannot tell a probe
   from a message; two people talking got a banner and a locked composer out of it. A sweep now runs
   only when the server could have dropped something (`connectionSweepDecision`), which is what makes
   it a heal rather than a heartbeat. What did not hold either is the *shape* of the ask: the
   elections are HTTP, take no MLS
   mutex, and were serialised for a reason that only ever applied to the sends. They now run with a
   bound of 6 in flight (`ELECTION_CONCURRENCY`); the sends still serialise on the mutex as before.
   The bound is not decoration - a device in fifty conversations would otherwise open fifty requests
   on a phone radio at the instant it reconnects.
2. **The inbound drain does not cost what it appears to.** It overlaps the pass and inherits its
   duration, so drain time was flat at ~4 s whether it carried 2 frames or 12. Anything measuring
   "how long a drain takes" on a reconnect is measuring this pass.
3. **Every foreground return paid it.** On Tauri, `visibilitychange: hidden` pauses the connection
   immediately and deliberately (`ChatBackgroundService.svelte`), so an app switch costs a
   reconnect, hence a full pass. Holding the socket open through a short background was considered
   and **rejected**: a message arriving during the grace period would be ACKed over the WebSocket by
   a live-but-backgrounded app, which cancels the deferred FCM fallback
   (`messaging.service.ts`, `scheduleDeferredPush`, 10 s) - and nothing establishes that the web
   `Notification` shown in its place is delivered from a backgrounded Android WebView. With the pass
   itself down to one round trip, the trade stopped being worth its risk.

---

## What was wrong

Two separate flags each carried two questions. Both failures have the same shape, and it is the one
already recorded in [`durable-rules.md`](../durable-rules.md): *"is this broken" and "have I already
asked" differ only in lifetime, and using one for the other silences the trigger.*

### The marker carried "something is missing" and "I still owe an ask"

Asking "do we differ?" was expensive, so it was gated on stored evidence:

> expensive to ask → only ask with a reason → the reason must be stored → but the reason is
> **one-shot** (the frame that proves it is consumed by the act of detecting it,
> `history.ts:415-434`: *"the frame itself is about to be consumed and will never fail again to
> remind us"*) → so the store must be durable → so it needs a discharge condition → hence vouching,
> reason ranks, a 30-day horizon, a 15-minute sweep.

And the discharge condition could not be met. A proven marker (`unreadable-frames`) survives any
non-empty bundle and is cleared only by a peer that compares its whole store, answers **empty**, and
is **not itself awaiting**. Measured: both devices of a two-device DM carried the marker for **1.9
days**, so neither could ever vouch for the other. The client says it in its own log:
`ingesting without discharging our own wait`.

### `silent` carried "do not notify" and "do not persist"

`silent` is a UI property - do not raise a notification, do not render as a message. It is also, and
for no reason, the durability switch: `outbox.ts:327` marks **every** control frame silent by
construction, and `messaging.service.ts:674` excludes silent frames from the shared log. That single
overload is why no mutation has a shared copy.

**They are split.** A frame declares *visibility* and *durability* independently, in one place -
`DELIVERY` in `mls-client/frameDelivery.ts`, three named cases: `visible`, `mutation`, `transport`.
Every mutation is durable; reconciliation traffic is not, because it only restates state held
elsewhere and writing it back would be circular - and the log is capped per group, so a 200-message
bundle chunk would evict the very messages it exists to carry.

Two consequences, both handled where the assumption lived:

- the stream now carries silent frames, so each entry records its own visibility. Anything reading
  the stream to *notify* must honour it - `redeliverMissedDuringActivationWindow` re-notifies a
  reactivated device from this stream and would otherwise ring the user for a reaction;
- the client's replay handlers for mutations, dead until now because no mutation reached the
  stream, become the path every mutation takes on replay. See D7.

### Also measured that day

- solicitation fired at **+3 s**, while the device's own inbound drain was still running - a
  difference it was itself in the middle of closing. **FIXED**: the ask now waits on
  `waitForMessageQueueIdle()` rather than on a delay, so it compares a settled store by construction
  and not by luck;
- the rendered list froze for ~10 minutes after a large bundle ingest. Nothing was lost - all four
  probe markers were present after a reload - but nothing appeared on screen either. **FIXED**, and
  the cause was arithmetic rather than anything to do with history: `batchAddMessages` asked
  `convo.messages.find(...)` twice per incoming message - once to decide whether to upgrade it, once
  inside `resolveMessageTimestamp` - so ingesting `m` messages into a conversation of `n` cost
  `2·n·m` comparisons on the main thread. A bundle of a thousand into a store of eight thousand is
  sixteen million, which is the ten minutes. Both now read one index built once per batch
  (`indexMessagesById`), and `resolveMessageTimestamp` takes a LOOKUP rather than a list so no call
  site can quietly reintroduce the scan. The cost is now proportional to the batch and not to the
  conversation, which is what "any size" requires.

---

## The model

### Two boundaries, not one

**The conversation floor** - shared, monotone, travels inside the exchange.
: *"The history of this conversation begins here."* Below it nobody claims and nobody answers. It
  only moves forward; when two devices disagree the **larger wins** (a `max`, so it merges without
  coordination). It is what makes pruning safe.
: **Hard constraint:** it may never sit below what some member can still supply, or the system
  promises a completeness nobody can honour.
: **SHIPPED, worth zero.** `Conversation.historyFloor` / `ConversationMeta.historyFloor` (SQLite
  schema v7), merged by `mergeHistoryFloor` wherever a bundle lands - live and on replay - and
  restated on every `history_bundle` chunk, since a `max` is free to repeat. Nothing moves it: it is
  present so that the day something does, the field is already converged across the fleet. A floor
  claimed in the FUTURE is clamped to now at the parse boundary, for the same reason
  `parseReadWatermarks` exists - a `max` merge has no way to take a bad value back, and a floor
  above the messages would hide the conversation on every device that merged it.

**The device window** - local, **fixed per platform. Never a user-visible setting.**
: *"What this device intends to retain."* **Web: 90 days. Mobile and desktop: 5 years.**
  Deliberately unequal. Ninety days covers most of a semester, so the browser reaches for
  [scrollback](#scrollback-below-the-window) rarely rather than routinely. Five years is longer than
  the longest tenure anyone has here, so no user meets that bound while they are still a member: it
  exists to keep "everything" finite, not to expire anything anybody will miss.
: Bounded rather than literally infinite for two reasons, neither of them rendering cost - history
  already loads in pages of 60 behind the `afterStreamId` cursor, so the window never reaches the
  renderer. First, an unbounded window gives the floor nothing to move for, ever. Second, the
  [state key](#completeness-is-asked-from-the-requesters-side) is computed over the window, and an
  unbounded domain makes its worst case unbounded too.
: **SHIPPED, and now a bound.** `$lib/utils/chat/historyWindow.ts` holds the two constants, the
  platform split (`isTauriRuntime`, the only distinction that matters here - mobile and desktop
  answer the same) and `historyRangeStart(floor, now)`, the later of the floor and the window.
  `history_digest` and `history_pull` both state their `since`; the rendezvous carries the digest's
  through to the responder as one `SolicitedDigest`, because a digest without its window can only be
  answered in full - the behaviour the window exists to end.
: **`since` is STATED, never recomputed by the answering side.** The window slides, so two devices
  computing `now - 90 days` a second apart get two different boundaries - and a boundary that
  disagrees by a second is a message neither side believes it owes. The asker states it; the
  answerer obeys it; one exchange uses one number.
: **The digest says what a device HAS; `since` says what it WANTS**, and the two sets differ. The
  digest is deliberately not clipped: a device holding messages below its own window can still serve
  them to a peer whose window reaches further back, and it can only do so by describing them.
: **The clip is applied to the ANSWER, never to the COMPARISON**, in `sendHistoryBundleForIds` - the
  one place holding both the messages and their timestamps, since an id list carries no dates. This
  is not an implementation convenience: a stored timestamp can differ by a hair between two devices
  (the reason the manifest buckets the ID space and not time), so clipping the comparison would let
  a message near the boundary read as missing on one side and present on the other, permanently.
  Clipping the answer cannot - the worst it does is decline to send what was not asked for.
: **Each leg states its OWN window.** `handleHistoryRequest` plays both roles in one exchange: it
  answers within the requester's `since`, and the pull it sends back states its own. Reusing the
  requester's there would cap every device in the conversation at the shortest window in it.
: **An emptiness produced by the clip still VOUCHES.** Completeness was defined by the asker's own
  line, so "everything you lack is below it" and "you lack nothing" are the same answer; withholding
  the vouch would leave a device that is complete for its window re-soliciting for ever.
: **A bundle nobody asked for is not clipped**, and that is deliberate: `sendFullHistoryBundle` is
  pushed to a device being INVITED, which has stated no window because it has not asked anything.
  Over-delivering there costs the receiver disk and nothing else - and under-delivering would lose
  messages the joiner has no other way to obtain. It is bounded by the sender's own window anyway.

### Completeness is asked from the requester's side

A device is complete when it holds everything that exists in

```
[ max(conversationFloor, deviceWindowStart) , now ]
```

so the comparison is always scoped to the **asking** device's window. The phone is never shrunk by
the browser; the browser is never force-fed by the phone.

### The exchange

On connect, in this order - the order is load-bearing:

1. **Connect.**
2. **MLS sync** - join/refresh groups, apply commits.
3. **Drain the mailbox** (`queued_message`) to completion. *Comparing before this finishes reports a
   difference the device is in the middle of closing by itself.*

> **The seams these map to already exist, and one of them is a clock that must go.**
> `openGatewayConnection` connects and calls `fetchPendingMessages`, which pages the mailbox and then
> `await`s `waitForMessageQueueIdle()` - a real completion signal, not a delay, so step 3 needs
> nothing invented. `syncConnectionAfterWsOpen` is step 2. It ends with
> `await new Promise((r) => setTimeout(r, 500))` described as *"small delay to let the first batch of
> messages arrive"*, and **that sleep is what step 4 must replace**: a comparison placed after a
> guessed delay reports differences the device was still closing, and reports them differently on a
> fast network than a slow one. `waitForMessageQueueIdle` is the honest bound and is already
> available on `IMlsService`.
4. **Then, silently, in the background:** send the elected online peer a compact **state key** for
   the requester's window and ask whether it matches.

> **STEP 3 BINDS EVERY TRIGGER AND BOTH SIDES, which is not how it was first built** (corrected
> 2026-08-13). The order above was honoured only by the connection path, because that is where the
> ordering lived - `initializeConnection`, step 5, after its own `waitForMessageQueueIdle`. The three
> reactive triggers fire from wherever they are raised, and two of them are raised *inside the drain*,
> so they computed a state key over a store still being written. Measured on production the same day,
> on a browser and on the phone: `[HISTORY_STATE] Sent` and `[HISTORY_RECONCILE] asked` both landed
> between a `Drain start` and its `Drain complete`, while the connection path - which does wait - had
> nothing to ask for at all.
>
> **And it binds the ANSWER as much as the ask.** A device describing its store mid-drain is not a
> reliable source: it can answer *same state* while the frames that would change that answer are
> still queued, or serve a bundle short of exactly what it was about to apply. Either outcome ends
> the exchange with the two devices still apart, and the asker has spent its coalescing window on it.
>
> Two shapes hold it together, and both are load-bearing. The barrier sits in `reconcileGroup` - the
> one door every trigger passes through - **after** the coalescing reservation, so a burst of forty
> failing frames parks one waiter and not forty. On the answering side it is `answerAfterMailboxDrained`,
> which **defers rather than awaits**: every responder leg runs inside the message pipeline, so
> awaiting the queue from there is the drain waiting on itself. The frame is acknowledged once the
> answer is scheduled - a real weakening, accepted because nothing in this exchange is durable by
> design and the asker re-asks on its next edge.

> **Step 3 orders the two paths at the START of a walk. It says nothing about the middle of one, and
> that is a second overlap** (closed 2026-08-14). The archive holds every frame, *including the ones
> still queued for live delivery*. So a replay whose upper bound is "the stream tail whenever I get
> there" necessarily walks rows written while it was walking - precisely the rows the queue is about
> to hand over - and both paths present the same ciphertext to MLS again. The barrier cannot reach
> them: they did not exist when it was crossed. On a conversation large enough to page, that window
> is the whole duration of the walk, which is exactly the size the standing directive rules out.
>
> **The bound is the stream head observed at the walk's first page.** `GET /api/mls/history/:groupId`
> reports it in `X-History-Head` (`heads` on the batch route), the client passes it back as `until`,
> and the server uses it as the `XRANGE` end instead of `+`. At or below the head belongs to the
> replay; above it belongs to the queue; the split is structural rather than reconciled afterwards.
> The rows above are never read at all - no bytes on the wire, no decrypt, and no ledger entry.
>
> **Why stopping early is safe:** the cursor only ever advances over rows actually walked, in stream
> order, so a walk that stops at the head leaves the cursor at the head and the next one resumes
> there. It is the same property that makes `advancePast` a walk and not a jump.
>
> **What this does NOT close, and the honest width of it.** The seam is now one round trip wide
> instead of one walk: a frame written between the drain going idle and the head being read is below
> the head and not yet in the ledger. Two structures are involved - the per-device queue and the
> shared stream - written at different moments by the server, so no client-side ordering can make
> that zero. The shared-fingerprint ledger still covers it, which is what it was written for; what
> changed is that it is no longer the mechanism that makes ordinary traffic work.
>
> The head was expected to have a second use - a **stable, shared upper bound** to give the fourth
> trigger the terminator it lacked. **It was the right principle at the wrong end**, and saying so is
> worth more than deleting it: "I walked to H" is a fact both sides can compare against, where "I
> think something is missing near the end" cannot terminate without a clock. But the shortness the
> fourth trigger measures is at the BOTTOM, not the top - the two sides already agree on the top,
> because step 3 drains both mailboxes before either compares anything. What the answer had to state
> was where the ANSWERER's memory begins. See [the fourth trigger](#the-fourth-trigger-an-answer-that-does-not-reach-far-enough-back).

The state key covers **the id set and the mutation state** - not ids alone. Two devices agreeing on
which messages exist can still disagree on which are deleted, and both would call themselves
complete. Ids and mutation state only, never content: a deleted message keeps its id and changes its
content, and the two devices must still recognise their agreement.

It is **cached per conversation and invalidated on write**, never recomputed by walking the window.
Connect cost must not grow with retention, or the 5-year window would be paid on every connect for
a comparison that almost always matches.

**SHIPPED as the rule, not yet as the exchange.** `$lib/utils/chat/historyStateKey.ts` computes it:
a canonical string per message - id, deleted, the edit's own `editedAt`, and every reaction pair
with its instant and whether it stands - SHA-256'd and XOR-folded into 64 bits. Four properties are
load-bearing and each is pinned by a test:

- **the fold is XOR**, so the key cannot depend on the order a store is walked in, and in particular
  not on a sort two devices might do differently (the mistake `compareIds` exists to prevent);
- **XOR is not idempotent**, so a duplicated id would cancel its own message out of the key - the
  walk deduplicates by id before folding, and that guard is not tidiness;
- **content is excluded**, or a purged deletion would look like a difference for ever between two
  devices that agree completely - and so are the sender and the timestamp, which no exchange
  repairs;
- **read state, the floor and the pin register are excluded**, deliberately. All three ride on every
  bundle and converge through the shared log the reconciliation drains BEFORE comparing. Including
  them would let the most frequently changing thing in a conversation trigger a digest exchange that
  repairs messages nobody was missing.

**The boundary had to be quantised for the key to be comparable at all.** A key is computed over
`[since, now]`, and an unrounded `since` slides continuously: two devices deriving it a second apart
compute over two different ranges, so the fast path could never fire and a cache keyed by that value
could never hit. `deviceWindowStart` now rounds DOWN to the day, so every device connecting on the
same day asks from the same instant. Either side of midnight they disagree and exchange a digest,
which is what the digest is for.

**The cache is SHIPPED** (`cachedHistoryStateKey`), and what it protects against is the WALK:
computing a key reads and decrypts the whole window, which on a 5-year store is the same order of
work as the post-ingest freeze this rework removes. It is keyed by `(conversation, since)` - a key
computed over a wider range is not an answer about a narrower one - and a failed read is never
cached, because a failure is not an empty store and caching it would tell every peer this device
holds nothing.

**The invalidation lives at the storage layer, not at the call sites**, and is conservative by
construction: a stale key claiming agreement loses messages silently, while an over-eager
invalidation costs one walk. Every `IStorage` method that writes message rows drops the entry -
per conversation where it can name one, wholesale where it cannot (`deleteOldMessages`, `clear`).
Both backends are separate classes with separate write sites, so "IndexedDB was updated and SQLite
was not" is the shape the mistake takes; `historyStateKeyInvalidation.test.ts` reads both sources to
keep it from being made, and carries a vacuity guard so it cannot quietly stop checking.

- **Keys match** → nothing is sent, nothing is displayed. The common case, and it must cost one small
  frame.
- **Keys differ** → then, and only then, exchange the hierarchical digest that already exists
  (`groupActions.ts`, `sendHistoryDigest`), and each side sends what the other lacks **within that
  side's window**. That last clause is **SHIPPED**: every ask carries a `since` and every answer is
  clipped to the one it was given - see [the device window](#two-boundaries-not-one).

Election is unchanged: the server picks one online member, so the exchange stays two-party. A
broadcast digest would cost every member a decryption for a repair concerning two devices.

**And the key must ride that same election, for a reason the digest only half had.** A digest costs
every member who receives it a decryption; a state key costs each of them the WALK behind computing
their own to compare against, which is the expensive half of this whole mechanism. So the key is not
broadcast to be answered by whoever feels like it: the requester elects a responder exactly as it
does today (`sendHistoryRequest` over the WebSocket) and puts the key inside MLS, and only the
elected device compares. The rendezvous that already joins those two transports
(`historyDigestRendezvous`) is the same shape and should carry the key rather than gain a twin.

**SHIPPED, and the rendezvous carries all three asks rather than gaining a twin.** A probe names its
KIND - `state`, `digest` or `range` - and all three carry a `since`, because all three are asks and
an answer is clipped to the window it was given. Silence is the fast path: when the keys match
nothing is sent at all, which is why `vouched` and the three-way `EmptyBundleMeaning` could be
deleted outright rather than kept for the agreeing case.

The resulting flow, which is today's with one probe in front of it:

| | today | with the key |
| --- | --- | --- |
| stores agree | digest → diff → empty vouched bundle | key → empty vouched bundle |
| stores differ | digest → diff → bundle | key → *"send me your digest"* → digest → diff → bundle |

One round trip is added to the case that differs and one whole digest is removed from the case that
does not - which is the common one, and the only one paid on every connect of every device.

### The fifth trigger: an ask that reached a member which answered nothing

**The election is random on purpose, and the client owed it a second draw.** `notifyHistoryRequest`
shuffles the members before forwarding, and the comment says why: *"A backgrounded Android holds its
WebSocket TCP open, so `user:online` can be true while the app cannot process the frame
(frozen-online). The requester re-solicits on a bounded backoff; randomizing the responder each call
lets those retries rotate past a frozen peer to a genuinely reachable one."* **The requester did not
re-solicit.** `reconcileGroup` asks once and the coalescing window swallows everything for 30 s.

Measured 2026-09-05 with the server's log beside both clients, on HEAL-REVOKE-7 `--order last`:

| when | what the SERVER did | what followed |
| --- | --- | --- |
| 22:41:50 | `FORWARDED target=<the phone>` for the returning device | silence |
| 22:41:56 | - | the returning device holds 4 frames it cannot read; swallowed, 6 s into 30 |
| 22:43:15 | `FORWARDED target=<the phone>` for a reference device | silence |
| 22:43:20 | `FORWARDED target=<W1>` for the same reference device | `3 of 3 requested message(s)` |

**The reference device is whole because it asked twice**; it asks twice because a fresh enrolment
joins each group, which clears the coalescing note. The returning device re-joined into a group it
already held (`already in WASM - skip`), kept the note, and stayed three messages short for ever.

**So a trigger that can PROVE incompleteness escalates rather than defers.** A frame this device
holds and cannot read is proof of a gap without asking anybody, which means silence from a responder
has told it nothing - where for every other trigger silence genuinely means *we agree*.
`escalateReconciliation` adds the member the in-flight ask reached to an excluded set and elects
again. It terminates on the proof the server already delivers - `no_peer_online` with a positive
`excludedOnline`, *every reachable member has been asked* - which is the coverage walk's proof
reused rather than a new one. One member per step, the set only grows, and forty unreadable frames on
a group with two online members cost two elections and then a fact.

**AND THE BARRIER THAT MADE IT SLOW IS SCOPED NOW.** `answerAfterMailboxDrained` waited on the
WHOLE mailbox: idle only once the device had applied everything, which on a device rejoining
twenty-nine conversations was **189 seconds** between the question and the answer. The reason the
barrier exists is a claim about the frames of THE GROUP BEING DESCRIBED, so it takes the group it is
answering about and waits for that one - `waitUntilGroupIdle`, woken after every frame rather than at
the end of a drain. Three details carry it: a picked frame is out of its bucket and not yet applied,
so the drain records which group it is inside; the untagged bucket is waited for too, because
nothing in the scheduler can say whose an untagged frame is; and a handler that throws still clears
the marker.

**AND THE EXCLUSION IT WALKS ON HAD NEVER WORKED.** The first run of the escalation asked the
server nine times to skip the sleeping phone and was handed it back every time. The server filtered
the exclusion list with `k.length <= 128`, and a member key - `userId:deviceId`, a 64-character hex
digest plus a device id that repeats it - is **147 characters for a browser and 149 for the phone**.
Every key was dropped in silence. So the fourth trigger's termination argument, *each step of the
walk removes exactly one member*, had been inert since it shipped: the walk removed nobody, and the
client's guard against a server that ignores an exclusion stopped it instead. Fixed with a cap
measured against a real key, a warning when an exclusion cannot be used, and a test whose fixture is
the shape this platform issues rather than `ua:da`.

**What is still open is that SILENCE CARRIES TWO MEANINGS.** *We agree* and *nobody answered* are the
same observation, which is why the escalation has to be gated on local evidence instead of on the
absence of a reply. Making the agreeing responder ack would cost one frame per group per ask - the
saving the state key exists for - so it is a design question, not an oversight
([backlog](../backlog.md)).

### The second leg does not need a live waiter, and requiring one cost three messages for ever

**Measured on the local estate 2026-09-05, by HEAL-REVOKE-5 and then isolated by HEAL-REVOKE-7's
order pair.** The responder asks *"describe yourself"* and waits `DIGEST_TTL_MS` = 60 s for the
digest. The asker answers only once its own inbound queue has drained - deliberately, because a
digest computed mid-drain describes a store still being completed. **A device that has just rejoined
an account is applying every group's external join at once**: it took 67 s, and its digest reached a
responder that had stopped listening seven seconds earlier.

| when | who | what |
| --- | --- | --- |
| 22:11:09 | the returning device | external join, state key sent, `asked ... whether we hold the same history` |
| 22:11:09 | the responder | `Keys differ - asked <it> to describe` |
| 22:11:15 | the returning device | `holds 4 frame(s) it can never read - reconciling` - **and no ask leaves**: `recentlyAsked`, 6 s into a 30 s window |
| 22:12:09 | the responder | `asked ... to describe itself, no digest came` |
| 22:12:17 | the returning device | its digest goes out - **eight seconds too late** |

**The order pair is the control.** Run the same row with nobody online at the moment of the return
and the first ask is answered by no one, so the frame trigger fires 42 s later, OUTSIDE the
coalescing window, produces a real second ask, and the exchange completes in two seconds: 3 of 3
messages. The run that HAD a responder available immediately is the one that loses them.

**The repair is that the last leg needs nothing remembered.** The digest carries the manifest and
the window the asker drew; our store carries the rest. So `answerHistoryDigest` is a function, not a
continuation inside the wait, and `systemMessageHandler` calls it when a digest arrives for a
solicitation this device issued and no waiter took. `takeDigestSolicitation` keeps that addressed -
the leg is a group broadcast, every member records it, and only the device that ASKED holds an
outstanding solicitation - so the election still elects exactly one responder. The 60 s now bounds
MEMORY, which is what a TTL is for, instead of bounding CORRECTNESS.

**Two things follow that are worth stating separately.** A wait is not a termination proof: raising
the 60 s buys the next slower boot nothing, and shortening the coalescing window is the same mistake
twice. And a trigger swallowed by coalescing is promised that the ask in flight covers it - the
window's own justification says *"the next connection re-asks unconditionally either way"*, which is
false for a session that stays up - so the swallow is now LOGGED rather than silent, because
`history.ts` announces *reconciling* before calling and a silent decline made that line a claim
about something that did not happen.

### The fourth trigger: an answer that does not reach far enough back

**SHIPPED 2026-08-16.** The other three triggers are things a device notices about ITSELF - a
connection, a fresh join, a frame it could not decrypt. This one is raised by an ANSWER, and it
exists because of the deliberate inequality above: a phone keeping five years asking a browser
keeping ninety days gets a clipped answer **every single time, by construction and not by fault**.

The phone could not tell that apart from *"this conversation has no more past"*. Both look like an
absence, and an absence is not evidence of anything. So it either believed itself complete - losing
years silently - or re-asked, and a re-ask on that evidence never terminates: the same peer is
elected, gives the same clipped answer, and only a counter or a clock could ever stop it.

**Two facts replace both, and neither is a duration.**

**1. The answer STATES where the answerer's memory begins.** `history_coverage` carries
`coveredFrom` - the answerer's own `max(floor, deviceWindowStart)` - and is sent **only when that is
later than the `since` it was asked for**. Silence therefore keeps meaning *"I cover what you asked"*,
so two devices of the same platform still exchange exactly one frame. It is sent **last**, after any
bundle, because MLS orders one sender's frames: arriving last is what makes it read as *"that is
all, and I am complete only from here"*.

It is stated rather than discovered because the answerer already knows it. Handing a peer an
operation certain to come back short, in order to classify the shortness, is the work the design
owes - the discriminator travels from where it is known.

**And it is sent even when the two state keys MATCH**, which is the case nothing else would have
caught: two devices can hold exactly the same messages over the asker's window and both be missing
the years below the answerer's. The key is computed from what each store holds, so it agrees
happily. **Agreement is not completeness.**

**2. The next election EXCLUDES every member that has stated one.** `POST /api/mls/history-request`
takes `exclude` - member keys already heard from - and each step of the walk therefore removes
exactly one member from the reachable set. The set is finite and only shrinks, so the walk visits
each member at most once.

**The termination proof is delivered, not inferred.** The server answers `no_peer_online` with
`excludedOnline`, a COUNT of the members that were online and skipped only because we had already
heard from them. A positive count means *every reachable member has answered you* - the proof - and
the walk ends. Zero means *nobody was there*, which is a different fact answered by a different edge
(the peer-online retry). One status, two facts, separated by evidence rather than by prose.

Three properties keep it honest:

- **the claims are facts, not chase state.** A retention window only slides FORWARD, so a member
  that says "I am complete from ninety days ago" can never later cover more of the past. The claim
  is sound for the whole session, and nothing has to decide when a walk is "open" or "closed";
- **an ordinary reconciliation never carries an exclusion.** Those claims are about COVERAGE; an
  ordinary comparison is about CONTENT, and a member with a short memory still receives every new
  message. Excluding it there would skip a real repair;
- **a server that ignores `exclude` stops the walk, loudly.** Mid-rollout an older build re-elects
  the member we asked it to skip, and a step that re-draws a member already in the set advances
  nothing - the one shape that would not terminate. The client compares the elected `target` against
  its own exclusion list and stops with a line that accuses.

Nothing here is scheduled and nothing is retried. Being wrong about any of it costs elections, never
a message. When the walk ends without closing the gap, the gap is simply not remembered: the next
connection compares again from scratch, which is where a member with a longer memory gets its turn.

### What that leaves open, and why it is left open (decided 2026-08-17)

Two consequences follow from having no schedule, and both are accepted rather than overlooked:
**a device that never connects is never repaired**, and **one whose peers are never online at the
same moment waits for the first that is.** Neither is a defect to be fixed by a periodic
solicitation - a broadcast on a timer is the exact mechanism this rework deleted (see the list of
what was removed), and it repaired nothing while costing ~450 frames a minute.

**And `history_request` is deliberately NOT durable the way `welcome_request` is.** The asymmetry is
not an oversight, and it rests on three facts:

- a stored request drained hours later has **no probe left to answer it** - the digest rendezvous
  has a 60 s TTL, so what is replayed is an ask nobody is listening for;
- the requester **must reconnect to read anything anyway**, and reconnecting compares from scratch,
  which asks again by itself. A durable copy would only duplicate the trigger that already exists;
- the two failures are not the same size: **a missing Welcome BLOCKS a group outright, a missing
  history only degrades one.** Durability is worth its discharge condition for the first and not for
  the second - and the discharge condition is precisely what could not be met the last time this
  area carried a durable registry.

### Why it converges, and why a third device needs nothing extra

Union merge is commutative, associative and idempotent, so repeated pairwise exchanges - any order,
whoever happens to be online - converge to the union. Classic anti-entropy. Propagation to a third
device falls out; nothing to orchestrate, no membership to enumerate.

This holds only while **every merged field is monotone**:

| Field | Merge rule | Monotone |
| --- | --- | --- |
| messages | union by id | yes |
| deletion | tombstone, content purged | yes |
| edit | last-write-wins on the author's `editedAt` | yes |
| reaction | last-write-wins per `(user, emoji)` on its own timestamp | yes |
| read state | watermark, `max` | yes |
| conversation floor | `max` | yes |
| pin state | last-write-wins per message on its own `at` | yes |

**The pin was the one mutation carrying no clock, and that is what made it hard.** Every other one
here dates itself - a reaction dates each `(user, emoji)` pair, an edit dates itself, a deletion is
absorbing - while `pin`/`unpin` carried only a message id. With no date there is no merge: a union
lets a peer that has not seen the `unpin` resurrect a pin, and a replacement makes the outcome
depend on which answer landed last. So the frame now carries `at`, both legs, exactly as a
reaction's two legs do, and an `unpin` is a dated TOMBSTONE rather than a removal. The register
travels with its tombstones for the symmetric reason: a snapshot of what is merely pinned omits the
answerer's `unpin`, which is precisely the entry a stale peer needs in order to lose.

**Both carriers are needed and neither is redundant**: the frames converge a device that is
following along, and the register covers the frame that has aged out of the server's window while
the pin it created has not. That is what made this a hole rather than a policy - a channel pin came
back on a fresh device, because the server re-serves it, and a DM pin did not (MUT-15). Bounded at
500 entries per conversation, oldest first, because a tombstone is never discharged by anything.

Two of these are corrections, not restatements of today's behaviour - see
[Defects this work must fix](#defects-this-work-must-fix), D3 and D5. Pruning is **not** monotone,
which is exactly what the floor is for: pruning below it is invisible to the merge, and pruning above
it is forbidden.

### Reactions

Each `(user, emoji)` pair carries its own timestamp and an on/off state; the larger timestamp wins.
Converges without tombstones, and stays bounded - a place/remove cycle does not grow the set.

**Shipped.** `messageReactions.ts` holds the whole rule: `applyReaction` for one frame,
`mergeReactions` for a peer's set, both last-write-wins on `at`, and `activeReactions` for what the
UI renders. Equal timestamps keep what is already held, so replaying a frame onto its own result is
a no-op rather than a flip. The rule it replaces adopted a bundle's reactions **only when the
receiver had none**, so a removal never reached anyone holding a stale placement.

Three consequences worth stating, because each one was a bug in the old shape:

- **A removal is an entry, not a deletion.** Dropping the pair from the list left nothing to send,
  which is why removals could not travel. It stays, carrying `removed: true` and the time it was
  taken back, and there is exactly one entry per pair - a place/remove cycle does not grow anything.
- **Both legs are the same frame.** Taking a reaction back was a `SystemMsg("remove_reaction")`
  carrying JSON while placing one was a typed `ReactionMsg`; one shape had nowhere to put the
  timestamp the merge needs on both. `ReactionMsg` now carries `at` and `removed`, and the old event
  survives only as a decoder for stream entries written before the change
  ([legacy-compatibility](../legacy-compatibility.md)).
- **The cap is a send-side rule.** The distinct-emoji cap used to be enforced on the receive path
  too, so a device at the cap silently refused a frame another device accepted - a permanent
  divergence produced by the very mechanism meant to prevent one. A frame that reached the group is
  a fact; the cap now limits only what the user may place.

### Deletion purges

A deletion replaces the content at rest, everywhere it lands, and removes the corresponding entry
from the shared log. What remains is the tombstone.

**The at-rest half is shipped.** The bundle merge sets `isDeleted` AND replaces `content` with the
tombstone, in memory and in the row it writes. It used to set the flag alone, so the write put the
original plaintext of a deleted message straight back on disk - and the next bundle this device
answered read that row and sent the original text on to somebody else.

**The shared-log half is not, and it needs a decision.** The server holds ciphertext and cannot tell
which stream entry carries a given message, so nothing there can act on a deletion by itself. Three
ways to give it one, none of them free:

- the deleting client locates the entry by replaying the stream and names it - correct, but the cost
  grows with how far back the message is;
- the server indexes message id to stream entry id - it would have to be told the id in the clear on
  every send, which puts a stable per-message identifier in the server's hands;
- leave it. Correctness does not depend on it: the `delete_message` mutation is itself in the shared
  log since the durability split, so a device replaying the log applies the deletion after the
  message and converges on the tombstone. What is lost is only that the original ciphertext stays in
  the log until the cap or the TTL evicts it.

Correctness is therefore already covered by the third option; the first two buy forward secrecy for
a deleted body, at a price. **Open question** - see the table at the end.

### Read state becomes a watermark

**SHIPPED.** One monotone value per participant - *read up to T* - merged as `max`, replacing the
per-message `readBy` array. It lives on the conversation (`Conversation.readWatermarks`,
`ConversationMeta.readWatermarks`, SQLite schema v6), travels as a `read_watermark` frame - a
mutation, so silent and durable - and rides on every `history_bundle`. Everything derived from it -
who has read a message, the unread count, how far reading a conversation moves the mark - is in
`$lib/utils/chat/readState.ts`, which absorbed `unread.ts`.

**T is the message's own client timestamp**, `messageTime` - the PRIMARY key display order uses, not
`serverTimestamp`, which is only a tie-break. A watermark ordered differently from the list it
describes would leave a message marked read while the one visibly above it stayed unread. And it is
drawn from the MESSAGES rather than from the clock: a device an hour fast would otherwise mark an
hour of unread messages read for everyone, permanently, the merge being `max`.

What it buys, beyond travelling in the shared log so a reinstall recovers read state with no peer
online:

- **it does not depend on which messages a device holds.** A `readBy` entry can only exist where the
  message does, so a catch-up delivering an older message marked it unread - the receipt for it had
  gone out long before. A watermark already covers messages the device has not seen yet;
- **one value per participant instead of one array per message**, so a page of a thousand messages
  costs one entry per reader, and read state is untouched by the batch save that writes them;
- **D2 falls out of it**: the reading device writes its own watermark to its own row (`MainChatPage`,
  optimistic update + `saveConversation`), so what this device read survives a reload without waiting
  for a peer to hand it back.

Two consequences to keep: an edit no longer resets read state (`readBy: []` used to mean "read by
nobody again"), because a monotone value cannot express it and a peer that never saw the edit would
never agree to move back; and the pre-watermark `read_receipt` frame is still DECODED, translated
into an instant using the messages the device holds - see
[legacy-compatibility](../legacy-compatibility.md).

#### The unread count is DERIVED from the watermark, on every path that writes it

The badge is not a tally kept up to date by whoever adds a message; it is `countUnreadForUser`
applied to this user's own watermark. Four sites write it, and until 2026-08-30 only two asked that
question - the history-bundle merge and the post-replay recount. Both add paths, `addMessageToChat`
and `batchAddMessages`, inferred "unseen" from "arrived just now".

**That proxy is exactly what a reconciliation breaks.** A replay delivers frames that are new to THIS
device and were read long ago on another one, and it delivers them interleaved with the read receipts
that zero the count. Applied in arrival order, the pair replays the conversation's entire read
history in fast-forward: the tile flashed read / unread / read for as long as the reconciliation ran
(reported from real use, 2026-08-30). The count was not merely late - it was answering a different
question from the one the badge asks.

The watermark is persisted on the conversation and is therefore already loaded before any frame
arrives, so nothing had to be fetched to fix this: the add paths were ignoring a fact they held.
Deriving makes the result independent of the ORDER frames arrive in, which is the property the blink
violated and the one the tests pin.

Aligning the two also settled a disagreement between them: `batchAddMessages` had always excluded
system messages from the count, and `addMessageToChat` had not, so a "X joined" notice raised a badge
for something nobody reads - on one path only. `isUnreadForUser` is now the single place that decides,
which is what keeps the four sites from drifting again.

#### The two hydration paths are MIRRORS and must be edited together

`toConversationMeta` and the in-memory seed in `loadExistingConversations` build the same object from
two directions, and a field added to one is silently absent from the other. A fix to read state was
defeated by exactly that: `readWatermarks` was written and never read back, so read state was correct
until the first restart and wrong afterwards - which reads as a persistence bug and is a hydration
one. **A field persisted but never read back is worse than one never stored**: the write succeeds,
nothing reports it, and every test that stays inside one session passes. When adding a field to the
conversation, change both, and assert it across a reload rather than within one.

### Scrollback below the window

To reach past its own window a device asks a peer for a **bounded range** rather than everything,
answered only within the floor. Same frame shape as a reconciliation answer, different trigger: a
user gesture instead of a connection. Without it, pruning on the browser would mean the browser can
never show the old past again.

**SHIPPED.** `requestOlderFromPeers` asks for the page immediately before the OLDEST message held -
the oldest, not the last rendered, because the list is not required to be sorted where the boundary
is read - and states its own `since`, which the answerer honours rather than recomputing. It refuses
to ask at all once what it holds already reaches its floor: there is nothing below it a peer is
entitled to send, so the frame would cost every member a decryption for an answer that must be
empty.

The trigger is **automatic, with the state made visible**: reaching the top of a conversation whose
local store is exhausted asks by itself, and the reader is shown a loading row while the ask is out
and a message when nobody was online to answer it. That distinction is the whole reason the function
returns `asked` / `no-peer` / `unavailable` rather than a boolean - a silent nothing would read as
"there is no more history", which is a different statement and usually a false one. The answer is
recognised by the list reaching further back than it did when the ask went out, not by a timer.

### Media

Blobs keep their own 30-day idle retention; **text and attachments have different horizons on
purpose**. Text is cheap, blobs are not. Beyond the media horizon the message stays and the
attachment renders an explicit expired state.

---

## Defects this work must fix

Found while specifying, on 2026-08-12. D1, D3 and D5 were read and confirmed directly; the rest come
from the audit and carry its references.

| # | Defect | Where | Confirmed |
| --- | --- | --- | --- |
| D1 | ~~`saveMessage` is a full-row `put` and `toMessagePayload` omits absent fields, so every partial write **erases** the fields it does not carry. Six mutation handlers each pass a different subset - a reaction landing on a deleted message clears the tombstone; a read receipt on an edited message clears `isEdited`~~ **FIXED**: see [Persisting a mutation](#persisting-a-mutation) | `messagePayload.ts`, `types.ts`, both backends | yes |
| D2 | ~~The reading device never persists **its own** read state - the optimistic update is a bare `conversations.set`. After a reload, messages it read return as unread until a peer's bundle hands them back~~ **FIXED** as part of the watermark, which is the only place it could be fixed: see [Read state becomes a watermark](#read-state-becomes-a-watermark) | `MainChatPage.svelte`, `readState.ts` | audit |
| D3 | ~~Reaction removal never converges: a bundle's reactions are adopted only when the receiver holds none~~ **FIXED**: see [Reactions](#reactions) | `messageReactions.ts`, both merge sites | yes |
| D4 | ~~`editedAt` is not serialised into the bundle although `isEdited` is, so a device restored by bundle shows "edited" with no timestamp, permanently~~ **FIXED**: written by `serializeForBundle`, read by both merge paths and by the replay's row builder | `groupActions.ts`, `systemMessageHandler.ts`, `historySystemEvents.ts`, `history.ts` | audit |
| D5 | ~~Bundle merge flags `isDeleted` without replacing `content`, and writes the original text back to disk~~ **FIXED at rest**; dropping the shared-log entry is a separate decision, see [Deletion purges](#deletion-purges) | `systemMessageHandler.ts`, the bundle merge and its write | yes |
| D6 | ~~`serverTimestamp` is dropped on the live bundle add path, giving unstable ordering for messages sharing a client timestamp. The replay path preserves it~~ **FIXED**: carried onto the add path, matching the replay path | `systemMessageHandler.ts`, the `toAdd` mapping | audit |
| D7 | ~~The replay handlers for `reaction`, `read_receipt`, `delete_message`, `edit_message`, `remove_reaction` are unreachable for MLS groups, because those frames never enter the stream~~ **Inverted by the durability split**, then VERIFIED - and the verification found a hole the split had opened: see [Who may mutate on replay](#who-may-mutate-on-replay) | `historySystemEvents.ts`, `history.ts` | yes |

Three defects measured the same day are covered here rather than patched separately, by decision: the
stuck `isMessageCatchupActive` overlay, the post-ingest render freeze, and the 15 s `scheduleRetry`
loop that re-raises the overlay. **All three are FIXED**, and two of them turned out to be one:

- the **render freeze** was a pair of linear scans per ingested message - see
  [Also measured that day](#also-measured-that-day);
- the **15 s loop** was a clock standing in for a proof. The inbound handler leaves a frame in the
  server queue for exactly two reasons, both named in `unackedFrames.ts`, and neither is discharged
  by waiting: an unknown group needs its Welcome, an absent conversation needs the local store
  restore. Asking again every fifteen seconds re-fetched the same rows, failed them identically, and
  raised the catch-up overlay on every cycle - for the whole session, on a device whose group never
  came back. The ask is now driven by the EVENT that changes the answer
  (`refetchFramesLeftBehind`), fired where the Welcome is processed and where the restore finishes.
  No event, no ask, and nothing to bound;
- the **stuck overlay** was that loop seen from the outside: `showOverlay` is raised by any drain of
  more than one frame, and lowered in the drain's own `finally`, so a single cycle always ends. What
  never ended was the supply of cycles. Removing the clock removes it; no separate fix was needed,
  and inventing one would have been a second mechanism guarding a case that no longer occurs.

### Persisting a mutation

`IStorage.updateMessage(id, patch, deviceKeyB64)` is the only way to write a mutation of an existing
message. It reads the row by primary key, decrypts it, applies `mergeStoredMessage`, and writes it
back - the same read-modify-write `updateOutboxEntry` has always used, and the same cost in a
conversation of ten messages and one of ten thousand.

The merge rule is one sentence: **a key the patch does not carry is a key the handler knows nothing
about, so the stored value stands.** A key present as `undefined` counts as absent, because handlers
build patches by spreading optionals. Clearing stays expressible, but only deliberately - `[]`,
`false`, `0` - which is what an edit resetting `readBy`, or the removal of the last reaction, needs.
`id` and `conversationId` are dropped from any patch: the API is keyed by id, and a row that changed
conversation would vanish from both.

What this replaces: every handler used to rebuild the WHOLE row out of what it happened to know, and
`saveMessage` is a full-row replace, so the row's contents depended on which mutation touched it
last. Each patch now carries exactly what its own mutation changes - a receipt writes read state, a
reaction writes reactions, a deletion writes the tombstone and the replacement body.

A patch on a row that is not there yet is a no-op, where a full-row write used to CREATE the row.
That is the correct reading in the case it actually happens - a channel message, whose row is
deliberately not stored, no longer gets one conjured by a reaction - and in the remaining window (a
message buffered by a bulk ingest but not yet flushed to disk) the mutation is still applied in
memory and the row converges on the next reconciliation, which is what the rest of this page is for.

### Who may mutate on replay

Only the author of a message may edit or delete it. The live path has enforced that since
`f924932b`; **the replay path never did**, and until the durability split it did not matter, because
no `delete_message` or `edit_message` frame ever entered the shared log for anything to replay. The
split made those handlers reachable, and by doing so re-opened the hole one layer down: any member
could have written a deletion of any message in the group and had every device that later replayed
the log apply it.

The check is `replayMutationIsAuthorised(target, senderNorm, kind)`, and it runs at both places a
replayed mutation can land, because the two see different evidence:

- **in memory**, against the message already in the conversation, in `historySystemEvents.ts`;
- **after the batch save**, against the stored row, in `history.ts` - the frame may have arrived
  before the message it mutates, so the handler records WHO claimed it (`deletedMessages` and
  `editedMessages` are maps to `{ by }`, not sets) and the apply pass compares that to the row's real
  `senderId` once the row exists.

A refusal logs and records nothing, so a rejected frame cannot reach the DB pass through the
accumulator either. `historySystemEvents.test.ts` covers both directions; it is the module's first
test file, which is the reason a dead handler could go unnoticed for as long as it did.

The other half of the same question is on the server: `POST mls/send` took `senderId` from the body
and never compared it to the authenticated `x-user-id`, so a member could write frames into a group's
shared log under another member's name - and `senderId` is exactly what a replaying device
attributes a message, and every mutation in it, to. It now goes through the service's own
`assertRequesterMatchesCaller` (case-insensitive; skipped for an internal caller, which never crosses
nginx and has no header). The background twin `mls/push/send` was already sound: it authenticates the
claimed `userId` against that user's PushSecret before it becomes `senderId`.

Two writers stay on `saveMessage` on purpose, and neither is a mutation of accumulated state:
`persistSent` writes a message the device has just sent, under the LIVE conversation key, which a
patch cannot move a row to; and the FCM-preview upgrade replaces a placeholder with the real body.
Both now write back every field the in-memory message still carries, so neither erases anything
either.

### Everything the replay swallows, it logs

The twin of the outbox rule ([chat](../frontend/modules/chat.md#everything-the-outbox-swallows-it-logs)).
`replayHistory` is best-effort at every step that is not the decrypt itself - a localStorage quota or
a store read that fails must not abandon a page of decrypted messages - and that makes silence the
default failure mode of exactly the state the false-loss work depends on. Every one of those branches
carries a `[HISTORY]` warning naming what was lost, since 2026-08-16:

| Branch | What silence there costs |
|---|---|
| Retry counters unreadable / not persisted | The ladder restarts at zero, so a permanently undecryptable frame buys six more refetches per run |
| Seen-ciphertext set unreadable | Every archived frame is replayed as new - the shape a false loss has |
| Seen-ciphertext set not persisted | The same replay is repeated in full next time |
| Stream cursor not persisted | The next replay refetches from the previous cursor |
| Stale cursor not cleared | This run refetches from the start, the next one does not |
| Store unreadable for the cursor check | Proceeds on a cursor that points past a wiped store |
| Store unreadable before the batch write | An `isDeleted` / `isEdited` flag set by an already-seen event is overwritten with the original body |
| The post-save mutation pass | Replayed reactions, deletes and edits are not stored, and it says how many of each |

---

## What disappears

Deleted outright, not deprecated. **All of it is gone** - a grep for each name below returns
nothing, which is the only form this claim may take:

- the durable awaiting-history registry **as a trigger** (`awaitingHistoryRegistry.ts`);
- the retry - the next state edge *is* the retry, so there is nothing to re-attempt;
- vouching, reason ranks, `isProvenAwaitingReason`, the 30-day give-up horizon;
- the 15-minute sweep (`AWAITING_SWEEP_INTERVAL_MS`) and `reSolicitAwaitingHistory`;
- the response-window store and the **"history pending" banner**. If a repair is needed and possible
  it happens silently; if no peer is online it does not happen, and there is no waiting state left to
  describe;
- the three-way `EmptyBundleMeaning` and the `vouched` flag it put on the wire: with silence as the
  fast path, an empty bundle no longer has to carry what it meant;
- the per-message `readBy` array, replaced by the watermark. The NAME survives one layer up, as a
  prop `MessageMetadata` receives, but it is now derived per render by `readersOf(msg, watermarks)`
  and nothing stores it.

What replaced the durable marker as a trigger is `historyReconcile.ts`, and it holds two notes, both
in memory and both about a MOMENT rather than a conversation: which groups the last attempt found
nobody online for, and which were asked within the last 30 s. Neither can outlive the session, which
is the property the marker lacked - it answered "is this conversation broken" from state whose
discharge condition was unreachable.

Surviving in a reduced role: a note that a **specific message** was never readable. It drives no
traffic; its only use is telling the user there is a gap.

---

## Transition

**No compatibility layer.** The new mechanism ships as a clean break and `minClientVersion` is raised
to match.

One ordering constraint on the deploy, because it decides whether a forced update works or traps:
raising `minClientVersion` before the stores actually serve the new build locks users in a loop -
update screen → store → same version → update screen. So: publish to the stores, **verify the store
serves the new build**, then deploy the server change and raise the floor.

---

## Decisions taken

With the product owner, 2026-08-12. Each replaced an alternative rejected for the reason given.

| Question | Decision | Rejected, and why |
| --- | --- | --- |
| Completeness | **Unequal and deliberate** - browser recent, phone everything | Equal in a common window: makes the browser pay the phone's storage cost |
| The boundary | **Monotone per-conversation floor**, merged as `max` | Sliding window from "now": two devices never share an instant, so the edge oscillates and re-triggers exchanges. Join date: never restores anything from before a reinstall |
| Scrollback | **Specified and implemented** | Deferring it makes pruning on the browser a permanent loss of access |
| Banner | **Removed** - the repair is silent | It only ever reported a state that should not exist |
| Mutations in the shared log | **All of them**; only `history_bundle` stays out | Keeping them queue-only leaves every mutation single-sourced from a peer |
| Reaction convergence | **Last-write-wins per `(user, emoji)`** | Tombstone set: converges without a clock, but grows on every place/remove cycle |
| Deletion | **Purge the content, keep the tombstone**, drop the shared-log entry | Flag-only: a deletion that deletes nothing |
| Read state | **Watermark in the shared log** | Peer-only: a new device with no peer online starts with everything unread |
| Media | **Text kept, attachment expires** with an explicit state | Aligning the floor on media retention throws away text that costs almost nothing |
| The three measured defects | **Folded into this work** | Patching first fixes symptoms whose common cause this removes |
| Transition | **Clean break, forced update** | Cohabitation: compatibility code to write, maintain and later remove |
| Floor in v1 | **Yes, present from the start**, even while it is worth zero | Adding it later means converging one more field across a deployed fleet, and we keep no compatibility layer - so it would cost a second break |
| Window sizes | **Web 90 days, mobile/desktop 5 years** | 30 days on the web: leans on scrollback for ordinary use. A count rather than a duration: a quiet conversation would keep years and a busy one a few days, which is not what a user expects of "recent". Literally unbounded on mobile: leaves the floor immovable and the state key's domain unbounded |
| Who chooses the window | **Fixed per platform** | A user-visible setting: it is a completeness contract between devices, not a preference, and a user lowering it silently reduces what their other devices can be told |
| What may move the floor | **Nothing, for now** - it ships at zero and the merge rule (`max`) is all that is implemented | Moving it on any schedule: the floor may never sit below what a member can still supply, and with the most retentive platform at 5 years no member prunes for five years. There is nothing to move it *to* |
| Redis durability | **Fixed immediately** - named volume + `appendonly yes` | Deferring it to the rework: the log would stay destructible until then, and the cap cannot be raised before it |
| Shape of a connection pass (2026-08-13) | **Elections concurrent, bounded at 6; sends still serialised** | Sequential: measured at 4.35 s for 9 groups, ~95 % of it serialised HTTP that takes no lock. Unbounded `Promise.all`: a device in fifty conversations opens fifty requests on the radio at reconnect |
| Announcing a drain (2026-08-13) | **Raised from the decrypted buffer, at 5 real messages** | `pendingCount` at drain start: it counts ciphertexts, and nothing can classify a frame before decrypting it - so a reconnect carrying nine probes and no messages announced a synchronisation for four seconds |
| Holding the socket through a short background | **Rejected** | The app would ACK over the WebSocket while backgrounded, cancelling the deferred FCM fallback, and nothing establishes the web `Notification` is delivered from a backgrounded WebView |
| **When a connection sweeps every group (2026-08-13, REVERSES "asking on every connection")** | **Only when the server could have dropped something**: no record of an earlier connection (new or restored store), or an absence at least as long as the server's 90-day retention. Otherwise no sweep at all - `connectionSweepDecision` | Unconditional, which is what shipped: cheap in frames and still wrong. Nine groups meant nine probes and their answers on a server carrying no other traffic, and the receiving side counts frames BEFORE decrypting them, so its own housekeeping read as an arriving backlog - a banner and a locked composer for two people talking. The three gaps were re-enumerated and only one needs a peer asked: a frame that could not be applied already triggers its own group (`handleUnreadableFrame`, `sawUnreadableFrame`) and is deliberately left unacked; a frame that never arrived is still in the server's queue and is redelivered; only a frame the server no longer holds needs a sweep, and nothing local witnesses that. **This is a heal, so it runs on evidence** |
| **An ask that cannot be attempted (2026-08-13)** | **Deferred with its blocker, never dropped** - one map keyed by group, holding `no-peer-online` or `no-probe-sender`, discharged by whichever edge lifts it (a peer returning, or the session installing its sender). One retry pass covers both: `retryDeferredReconciliations` | Dropping it with a log line, which is what shipped for `no-probe-sender`. **This is the fault that kept a production DM permanently broken** - see [A group that could not heal](#a-group-that-could-not-heal). Routing each reason to its own edge was also rejected: a group deferred under one reason and discharged only by the other's edge is exactly how this gap stayed open |

---

## A group that could not heal

Measured 2026-08-13 on a production DM (two members, epoch 6). It held frames MLS could never
decrypt, and every connection re-reported them without ever repairing anything. The digest design was
not at fault and was checked first: an undecryptable frame writes no row, so it correctly counts as
NOT held, and the diff would have named it.

The failure was upstream of the diff, in three steps that are individually correct:

1. `handleUnreadableFrame` (`setupMessageHandler.ts`) asks for the one repair that exists,
   `reconcileGroup`. Correct - the sender is the only party that can still produce the plaintext.
2. The frame is ACKed anyway (`return true`). Also correct: no redelivery can ever make a consumed
   generation decrypt, so leaving it queued would loop for ever.
3. `reconcileGroup` found `sendProbe === null` - the session installs it in `sessionAuth`, and
   inbound frames drain before that point - logged `no probe sender registered`, and **returned**.

Step 3 discards the request; step 2 destroys the evidence that would raise it again. Together they
lose the repair permanently, and the log line was the only trace. It was masked for as long as the
connection sweep was unconditional, because the next connection re-asked by accident; making the
sweep conditional (the row above) removed the accident and turned a hidden fault into a permanent
one. **The lesson is not about ordering:** moving the registration earlier would narrow the window
without closing it - a frame can arrive from a background push or a replay at any point - so the fix
is that a repair which cannot be attempted is REMEMBERED until it can be, and discharged by the event
that makes it possible.

### And the fix does not reach backwards - hence the audit

Measured on the device once the fix shipped: **the damaged group did not heal, and could not.** A
clean boot, three devices online, raised exactly one line - `no sweep - away 0 d, inside what the
server keeps` - and no unreadable frame arrived, so nothing asked. Holding a repair that is RAISED
cannot manufacture a trigger for damage whose evidence was consumed before the fix existed.

That is the general shape, not one group's bad luck. Every trigger this protocol has needs a live
witness - an unreadable frame, a replay that gave up, an absence past retention - and a conversation
damaged earlier has none of them left. What remains locally is an **absence**, and an absence is not
detectable from one side: nothing on the device records that a message it never read once existed.
The trace confirmed it end to end - for `secret-reuse` and `past-epoch-application` the durable
footprint is zero. No tombstone, no placeholder, no field in `StoredMessage` or `ConversationMeta`
able to represent a gap, and nothing rendered: the user sees an unbroken list with a hole in it.

**So the repair for pre-existing damage cannot be a cleanup - there is nothing to delete.** Deleting
and recreating the group is strictly worse: it destroys the messages still held and ends where a
comparison would have ended anyway. The only instrument that finds an absence is the comparison
itself, and what was missing was a REASON to run one.

**The one-shot audit** (`groupsOwingAudit` / `noteGroupsAudited`, `historyReconcile.ts`) is that
reason. `HISTORY_AUDIT_GENERATION` names the round; a device records which groups it has really
audited, and bumping the constant is the only way to run it again, deliberately and fleet-wide.

Two properties it is held to, both learnt above:

- **Discharged PER GROUP, and only for groups an ask actually left for.** `reconcileAllGroups`
  returns the asked ids rather than a count, and they are what gets written. Recording the pass's
  INPUT would discharge groups that were merely deferred - every member offline - and lose them for
  good, which is step 3 of the failure above wearing a different hat. Recording the OUTPUT means a
  group that could not be compared comes back alone on the next connection instead of dragging the
  whole store with it.
- **Idempotence from durable state, termination from a proof.** Nothing is scheduled and nothing
  fires on an interval. A group joined after the audit ran is indistinguishable from one deferred
  during it, and costs exactly one probe, once, ever - cheaper than a second durable record of when
  each group was joined.

What the audit does NOT do: it is not a guarantee. A group whose every peer is offline at each
connection stays owed, and is asked once per connection - one probe, for the one group that genuinely
needs it, which is the same honest limit the connection edge already has.

#### Measured on the fleet, 2026-08-13

Three real clients, on the shipped build. **The noise that had polluted every run stopped after the
audit's single pass**, which is the outcome the campaign needed:

| client | first connection | next connection | `SecretReuseError` before → after |
| --- | --- | --- | --- |
| A1 (phone) | `auditing 9 group(s)` → **8/9 asked** in 1140 ms | `auditing 1 group(s)` → 1/1 | 2 → 0 |
| W1 (browser) | `auditing 9 group(s)` → 9/9 in 276 ms | `every group already audited` | 18 → 0 |
| W2 (browser) | swept (new store) → 1/1 in 194 ms | `every group already audited` | 20 → 0 |

**A1's `8/9` is the per-group discharge proving itself, not a defect.** The ninth group had been
asked twelve seconds earlier by the deferral being discharged (`no probe sender yet - a577dba6…
deferred until one is installed`, then `asked` one second later - the `233c2e0b` fix running on
hardware for the first time). The coalescing window therefore skipped it, `reconcileGroup` returned
false, and it was **not** recorded as audited - so the next connection asked it alone, and the one
after that reported `every group already audited`. Recording the pass's input instead would have
discharged it silently.

The other measurement worth keeping: **9 groups in 276 ms on the browser and 1140 ms on the phone**,
against the 4.35 s the serialised pass used to cost.

#### That `→ 0` was true and did not last - the noise REGENERATES

Measured the same day, on W2, by reloading twice and reading the seen-cipher ledger across the pair
(2267 → 2271 entries):

| reload | `SecretReuseError` | `frame never read here and unreadable for good` | asks |
| --- | --- | --- | --- |
| 1 | 10 | **2** | 1 |
| 2 | 4, at an ADVANCING generation (263 → 266) | **0** | 0 |

Each frame is reported once and silenced for ever after - which is what the `→ 0` column above
actually measured. New ones appeared only where live traffic had been since, and that is the tell:
**the audit did not fail, it was cleaning up after a generator nobody had found yet.**

The generator was the invariant asserted at the `secret-reuse` / `past-epoch-application` branch of
`history.ts`: *"anything arriving HERE is a frame this device has never read - that is real loss"*.
It was false. `seenCipherHashes` was written by the replay ALONE. A frame delivered live, or drained
from the per-device queue, consumed its ratchet generation and left no mark, so the replay walked the
same archive row, could not decrypt what this device was displaying, and reported real loss. **Every
online device reconciled on its own ordinary traffic** - and the cost that matters is not the probes,
it is that a genuine loss became indistinguishable from this noise.

Why no identifier could be used, established before touching anything: an archive row is addressed by
its **Redis stream id** (`<ms>-<seq>`, from `XADD '*'`), a live envelope by `queuedMessageId`, a
**`queued_message` uuid**. Disjoint namespaces - and the server *awaits the `XADD` return value and
discards it* (`messaging.service.ts`), so the stream id is never stored, published or logged. What
the two paths do share is the **ciphertext**: `body.proto` is destructured once and the same string
is written to the stream and published in the envelope, with no transformer and no per-recipient
variation, and `mapHistoryEntries` hands it back to the client untouched.

So the mark is `frameFingerprint(bytes)`, written by `markHistoryFrameConsumed` from the one point
live delivery and the queue drain both pass through (`setupMessageHandler`, beside the existing
in-memory `noteFrameProcessed` - two ledgers, two lifetimes, two questions). The replay recognises it
before decoding anything and folds it into the stream-id key on first sight, so later replays answer
from the cheap check. Three properties it is held to are in
[durable-rules](../durable-rules.md): the key is the ciphertext, the set is ONE object shared with the
replay (which hydrates at its start and writes back at its end, and would otherwise erase the mark),
and the cursor advances by WALKING rather than jumping - a live frame's position written straight
into the cursor would carry it over an earlier frame the queue had already expired.

**The Android background decrypt deliberately does not mark.** It loads a throwaway copy of the state
and never writes `mls.bin` back (`src-tauri/src/mobile/background.rs`), so the foreground genuinely
does read that frame again from its queue; marking it there would skip a message nobody has read.

#### Verified on prod, 2026-08-13 - and the first measurement proved nothing

The fix is **prospective**: it marks frames as they are consumed, so it can say nothing about frames
already consumed by the bundle that shipped before it. The first reload after the deploy therefore
still reported 6 false losses, and that number is evidence for neither side. A measurement that
cannot come out differently under the two hypotheses is not a measurement.

What separates them is traffic consumed live **by the new bundle**. Three runs on W1, same probe
(`falseloss.mjs` / `falseloss-live.mjs` in the harness), build id asserted equal to the deployed one
each time:

| reload | traffic before it | false loss | `SecretReuseError` | asks |
| --- | --- | --- | --- | --- |
| 1 | live, on the OLD bundle | **6** | 12 | 1 |
| 2 (control) | none | 0 | 0 | 0 |
| 3 | live, on the NEW bundle | **0** | 0 | 0 |

Row 3 is the verdict, and row 1 is what makes it one: before the fix, live traffic between two
reloads regenerated the noise every time. The durable mark set grew 2172 → 2178 over the three
messages, so the deployed bundle is demonstrably running the marker rather than merely containing
it. Reconciliation stayed silent throughout (`no sweep - away 0 d, every group already audited`),
which is the property that was actually wanted: heavy, therefore exceptional.

The phone is checked the same way and separately, because it runs the assets baked into its APK and
no web result speaks for it (`falseloss-a1.mjs`). It needs BOTH halves, because writing the mark and
reading it are different code paths and only the second is ever seen: marks 2577 → 2583 → 2589 over
two rounds of live traffic, then a webview reload whose replay reported **0 false loss, 0
`SecretReuseError`, 0 asks**. "The phone carries the fix" on the mark alone would have been a claim
about storage, not about behaviour.

**Not attributed:** the marks grow by about two per message, not one. Consistent with the device also
consuming the non-application frames of the same exchange (typing, read watermarks), but unmeasured.
It cannot cause a false loss - marking more consumed frames can only prevent them - so it is recorded
rather than chased.

#### The ledger was ONE-WAY, and the false loss moved to the head of the stream

Measured 2026-08-13 (WP-FALSELOSS-2), on the MSG phase of the campaign. The fix above is correct and
stays; its `0` was measured over the direction it was written for and says nothing about the other
one. **Two paths consume ratchet generations on this device, and only one of them was telling the
other.**

| | writes | reads | so it can recognise |
| --- | --- | --- | --- |
| live delivery / queue drain | `frameFingerprint(bytes)`, durable + an in-memory ring | the ring only | a re-delivery, within this session |
| archive replay | the **stream id** of the row, durable | both keys | anything live delivery consumed |

The replay's own consumption was therefore invisible to live delivery in both key spaces: a stream id
is not something a live envelope can look itself up by - that is the whole reason the byte key exists
- and the in-memory ring is written only by live delivery and dies with the page.

So: a replay decrypts a row; the same frame arrives live a second later onto a spent generation;
`handleUnreadableFrame` looks in the one place it knew about, finds nothing, and files
`[MLS] LOST frame` plus a reconciliation - which answers `same state as <peer> - nothing to do`,
because nothing was lost. **The app proves it in its own record:** the MSG-1b row carrying the loss
also carries `copiesOnReceiver: 1` and `primerOnReceiver: 1`. A sender that had really rewound would
have produced a message no route could recover; every message was present.

That is also why it hit exactly three checks and no others - MSG-1b, MSG-5 and MSG-6 are the ones
that run a replay CONCURRENTLY with live traffic, and MSG-1b does it deliberately. The generations
complained about tracked the head of the stream (296, 340, 379, 438, 439) because the replay was
walking the head.

**The repair is the missing direction, and nothing else.** The replay marks the frame's BYTES the
moment a decrypt succeeds, and `handleUnreadableFrame` consults the durable set as well as the ring.
Two properties are load-bearing and each is pinned by a test:

- **the mark is taken on the SUCCESS path only.** A frame that failed to decrypt consumed nothing,
  and claiming it would tell live delivery "already read" about a frame nobody has read - which
  silences the one signal that raises a repair. The give-up branches still mark the ROW, so the
  replay does not walk it forever, and never the bytes;
- **the trigger is untouched.** A frame whose bytes are in neither ledger still logs the loss and
  still reconciles. This is not a suppression, it is the evidence the decision was missing - and the
  rule it belongs to is in [durable-rules](../durable-rules.md).

The residual, accepted: the byte key is a 32-bit FNV-1a plus the length, so a collision inside one
group's 5 000-entry set could silence a real loss. The replay has leaned on that key since
WP-FALSELOSS-1 and this changes the exposure by a constant, not by an order.

##### The direction was right and the PLACE was wrong - a batch spends in one call and reported in another

Measured 2026-08-14, on the deployed fix above. The false loss did not go away, and the run that
found it is the reason the shape is now certain: `msg1 --cold` followed by `msg1b` reproduced it
**every single time**, which turns an intermittent-looking fault into an experiment.

`session.decryptPage(...)` consumes the ratchet for an ENTIRE page in one call. The marks, however,
were written by the loop that runs afterwards - the one that decodes each frame, builds its envelope,
pushes it to the chat and awaits. Between the two there is a window, seconds wide on a real page, in
which every generation of that page is spent and the ledger says nothing about any of them. A frame
arriving live inside that window looks itself up, finds nothing, and is filed as a loss.

**The proof is a pair from one page**, and it is what makes the diagnosis certain rather than
plausible:

```
00:37:58  Ciphertext generation out of bounds 520 -> [MLS] LOST frame -> reconciling
00:38:01  Ciphertext generation out of bounds 521 -> [MLS] Duplicate delivery (already read by the archive replay)
```

Same group, same epoch, same page, three seconds apart: 521 was recognised because the loop had by
then reached it, and 520 was not because it had not. Nothing about the two frames differs except when
the loop got to them - which is precisely the definition of a window rather than a defect in the
recognition itself.

**The repair is a move, not a new mechanism.** Every successfully decrypted frame of a page is marked
immediately after `decryptPage` returns, before any of them is processed; the per-frame loop keeps
only the stream-id write, which answers the different question of where the walk has got to. The
success-only property is unchanged and still pinned by a test, and two more cases pin the page
behaviour: a two-frame page marks both, and a page where one entry failed marks only the other.

The rule this taught - *a ledger is written where the effect lands, not where the results are
convenient to iterate* - is in [durable-rules](../durable-rules.md).

##### That fix works, and it did NOT end the false loss - one frame per run still refuses on both paths

Measured 2026-08-14 on the deployed batch fix, full MSG phase, three clients each proven to be on the
built code first. **12 PASS, 1 PASS-DIRTY**, the single dirty row being MSG-1b - and the tail from
W2 is worth reading in full, because it says two things at once:

```
23:44  Ciphertext generation out of bounds 555 -> [MLS] Duplicate delivery (already read by the archive replay)
24:29  Ciphertext generation out of bounds 559 -> [MLS] LOST frame -> reconciling
24:31  Ciphertext generation out of bounds 559 -> [History] frame never read here and unreadable for good
24:33  Ciphertext generation out of bounds 560 -> [MLS] Duplicate delivery (already read by the archive replay)
```

**555 and 560 are the batch fix working**: both took the branch that used to say `LOST frame`, and
both now resolve to a silent ACK. That is the mechanism above, confirmed on live traffic rather than
argued from the diff.

**559 is a different thing and must not be filed under the same cause.** It is refused by BOTH
consumers - live delivery at 24:29, the archive replay at 24:31 - and NEITHER ledger holds it. Since
those are the only two MLS consumers in the client (`noteFrameProcessed` has exactly one call site,
`markHistoryFrameConsumed` two, and the channel path is AES, not MLS), a generation spent with no
mark anywhere means the bytes that spent it are not the bytes being refused.

Nothing is actually lost, and the app proves that itself: `copiesOnReceiver: 1`, `lostAgainMs: null`,
and the reconciliation it triggers answers `same state as <peer> - nothing to do`. The cost is a
wasted round trip and a `severe` line that makes a green run unclean.

**What the log could not say, and now says.** Two causes produce this and the generation number is
identical in both - a frame consumed here without being recorded (ours), or two different ciphertexts
genuinely sent at one generation (the sender's ratchet rewound, theirs). Answering it required a live
console tail on the right browser at the right second, which no later reader and no user can go back
and take. The frame's fingerprint is now printed on all three lines - the duplicate, the `LOST frame`
and the `[History]` one - so a plain log read settles it: **the same value on two lines is a ledger
gap, two values at one generation is reuse.** Pinned by a test, because it reads as decoration.

Two hypotheses were RAISED AND REFUTED here rather than carried forward, and both refutations were
cheap: the ledger write is a `queueMicrotask`, not a timer, so a reload cannot outrun it; and
`msg1 --cold` - the only reliable trigger - merely skips a warm-up send, so "the sender reloaded and
its checkpoint was behind" cannot be the mechanism.

##### What the fingerprints exposed on their first run - the same defect, in the READ direction

The instrumentation paid for itself immediately, and not by answering the question it was written
for. Three consecutive `msg1 --cold` + `msg1b` pairs, and every one printed this shape:

```
[MLS]     LOST frame ... (SecretReuseError, frame 5p:9redaw)
[History] frame never read here and unreadable for good (secret-reuse); ... frame 1786665504640-0
```

Those are not the same kind of thing. `5p:9redaw` is a fingerprint of the ciphertext;
`1786665504640-0` is a **Redis stream id**. The replay was printing - and keying on - a variable named
`cipherFingerprint` that held `msg.id`. **A name that lied is what let two key spaces read as one**,
in the log and in the reader's head. It is `rowKey` now, and the loss line carries both.

That made the real defect visible, and it is the mirror of the one directly above. The replay
assembles a page by checking each row against `seenCipherHashes`, and only THEN calls `decryptPage`.
Live delivery can read one of those frames in between. The comment that used to sit on the failure
branch reasoned from the earlier answer - *"a frame already read is skipped before ever reaching the
decrypt, so anything arriving HERE is a frame this device has never read"* - which quietly assumed
the two moments were one. The check now re-asks at the moment the verdict is formed, which costs one
hash of bytes already in hand and only on a frame that has just failed.

**The batch fix wrote the ledger where iterating was convenient instead of where the spending
happened; this one READ it where the work was queued instead of where the verdict is formed.** One
rule, two directions, and the second was invisible until the first was fixed.

This addresses the REPLAY side only. The live path already consults both ledgers inside its own catch
- its timing was never wrong - so whether `[MLS] LOST frame` also stops is an open measurement, not a
claim. If it persists, a consumer this client does not account for is spending the generation, and
the two lines are now comparable for the first time: same fingerprint on both is a ledger gap, two
fingerprints at one generation is genuine sender-side reuse.

##### WP-DUPDELIVERY-1 - the ledger was the witness, and the overlap was one await wide

Everything above makes the two consumers RECOGNISE each other. None of it stops them meeting, and
the logs said so in a way that is easy to miss: across every capture, **every single
`Duplicate delivery` line names `already read by the archive replay`, and not one names live
delivery.** A reconciliation whose other arm has never once fired is not a reconciliation, it is a
one-directional heal standing over a real ordering hole. **A race that heals cleanly is still a
defect** - if the mechanism needs a heal in theory, the mechanism is wrong, whatever it does in
practice.

Two ends have to be closed for the walk and the queue to be disjoint by construction:

- **Above the head:** a frame sent after the pin has its row out of the walk's range, so the queue
  owns it alone. Shipped 2026-08-14 as `HistoryPage.head`.
- **Below the head:** a frame sent before the pin has a row in range AND a queued copy, so the
  mailbox has to be empty before any row is processed - live delivery marks the frame, and the
  fingerprint check skips the row.

Both existed. **The order between them was wrong, and the barrier did not do what its own docblock
claimed.**

`waitForMessageQueueIdle` was `await pendingPullInFlight` then `waitUntilIdle()`. That answers *has
the pull that is RUNNING finished* - which, with no pull running and a full mailbox on the server,
is instantly yes. Captured on prod 2026-08-15: a replay finished at `11:43:10`, a pull started at
`11:43:12.889` on a connection edge, and the one row it returned was a frame the replay had already
read. The barrier now PULLS when nothing else has, and its evidence for "empty" is a **completed
pull plus a socket still open** (`mailboxEmptiedByAPull`) - a fact about a finished operation, never
a duration. A pull that died half-way leaves it false.

And the barrier ran BEFORE the first page was fetched, so the head was pinned *after* it. That left
exactly the frames sent between "mailbox empty" and "head pinned" - one HTTP round trip - in both
sets. The barrier now runs after the first page lands and before any row is touched: pin, empty,
read. Fetching first costs nothing, because a page whose frames the drain delivered meanwhile is
skipped row by row rather than re-decrypted.

###### The first attempt at that order deadlocked the client, and where the barrier may be taken is part of the order

Shipped as `4604eda5`, the barrier moved one await too far: it landed inside the walk loop, which is
**after `createDecryptSession`**. Opening a decrypt session opens a catch-up, and a catch-up holds
the global MLS mutex for its whole life, while the drain needs that same non-reentrant mutex for
every message. The walk therefore waited for a drain that could not start.

Caught by MSG-1b on the first pass of the verification run, 2026-08-15, and the two sides of the log
agree frame for frame:

| Where | What it showed |
| --- | --- |
| W2 console | `Disk writes deferred (bulk ingest depth=1)` at `14:58:44.612`, the frame at `14:58:45.001`, its drain nesting to `depth=2` - then no `Processing message`, no `Drain complete`, no `Bulk ingest done`, ever |
| The check | `copiesOnReceiver: 0`, and `NOT IN THE STORE EITHER` after a scroll and a reopen |
| chat-delivery | the same two frames unACKed -> `PUSH_DEFERRED ... -> FCM fallback`, then `No push token for user=... device=web-...` - it is a browser |
| The rig | W2 read **OFFLINE** for the rest of the run, so all 12 scripts of passes 2-5 were BLOCKED rather than given verdicts |

It does not heal: the client stayed wedged until it was reloaded. **The order was right and the
placement was wrong** - and both facts can be established with the mutex free, because pinning the
head is one HTTP read that touches no MLS state and emptying the mailbox *is* letting the drain have
the mutex. So the sequence is **pin, empty, open, read**, with the first two above the session.

Two things came out of it that outlive the fix. The hazard was **already named in this codebase**,
at `answerAfterMailboxDrained`, for the responder legs - which solve it the other way, by deferring
past the drain instead of awaiting it. And `waitForMessageQueueIdle` is now the place that states
the fact rather than discovers it: it is the only code that can see `catchUpDepth > 0` at the moment
of the call, so it logs an error naming the call site's mistake and returns, turning an
unrecoverable hang into a defect report.

**The heal stays.** It is the witness that says whether the overlap is really gone, and it is what
covers a consumer this client does not account for. What changes is that reaching it is now a
finding rather than the normal path - so a `Duplicate delivery` line in any later capture is a
defect report, and its arm finally distinguishes two causes that can both occur.

###### The barrier also PULLS, and at boot it was reachable before anything could drain what it pulled

The second attempt was correct in its ordering and still stopped a client dead - this time on the
**startup** path, and for a reason that has nothing to do with the mutex.

`waitForMessageQueueIdle` does not only wait. When no pull has happened it *fetches* the delivery
queue, which is the half that closed WP-DUPDELIVERY-1. `processQueue` returns at its first line while
`messageCallback` is unset. In `sessionAuth`, `setupMessageHandler` - which sets that callback - sat
**after** `loadAndRestoreConversations`, and the restore drives the archive replay, which takes this
barrier. So on a device with anything queued server-side, boot went: replay → barrier → pull → frames
enqueued → nothing can drain them → `waitUntilIdle` waits on a queue it has just filled itself.

Found on 2026-08-15 while restoring the clients for the re-run, and the A/B is complete:

| | W1 | W2 |
| --- | --- | --- |
| Bundle | `__sveltekit_1yypc8t` | `__sveltekit_1yypc8t` (identical) |
| Server-side queue | 0 rows | **2 rows**, `12:58:45.088` and `12:58:47.077` - the deadlock's residue |
| Boot | `[TAB] Leadership acquired` at 2 s, socket at 2.5 s, `[WS] Connected to Chat Gateway` | last line at 1 s, then **silence**; no leadership, no `Connecting to Gateway…`, no socket created at all |
| Gateway presence | `ONLINE` | `OFFLINE`, on every reload |

The backlog alone decided it. Nothing recovers it either: the frames stay queued because the device
that would ACK them never connects, so every subsequent start reproduces it exactly. The only visible
trace was `[QUEUE] messageCallback not set` at `console.warn`, twice - which reads as a notice.

**The fix is the order, and deliberately not the guard.** The inbound pipeline is registered before
anything can pull, so the boot pull drains normally and WP-DUPDELIVERY-1 stays closed *at boot*,
which is where it matters most. Refusing to pull instead would have traded a permanent hang for a
duplicate-delivery window on every startup.

The guard is still owed, for the same reason as the `catchUpDepth` one above: the barrier is the only
code that can see the fact at the moment of the call. It logs an error naming the call site's mistake
and returns - skipping is strictly better than hanging, because a duplicate is caught by the shared
fingerprint ledger and a client that never connects again is caught by nobody. And `processQueue`'s
own branch is now an error that names the consequence rather than the condition.

###### And the guard's first sighting on prod was a real one - the replay trigger asked from inside its own session

The `catchUpDepth` guard fired once during MSG ×5 on `1647f10a`: **W1, pass 1 of 5, the only pass that
followed a boot.** It is not a false positive, and it is not new - the guard is, which is why it had
never been seen.

`replayConversationHistory` raises `void reconcileGroup(...)` when the walk meets a frame it can never
read, under a comment reading *"once, now that the whole page has been walked and the store is
settled"*. `session.finish()` runs in that function's `finally`, i.e. **after**, so the catch-up still
held the global MLS mutex. `reconcileGroup`'s first act is the mailbox barrier, the drain needs that
same mutex - and `void` defers nothing: the microtask runs roughly a full replay before `finish`.

The consequence is not the log line. The barrier refused, so **the ask went out against a mailbox that
had never been emptied** - the exact ordering guarantee that barrier carries, and the reason it lives
inside `reconcileGroup` rather than at the connection edge (see the section above: it is the one door
every trigger comes through). An ask raised against a difference the device was about to close by
itself is the routine case reconciliation must never become.

The trigger now fires from the `finally`, after `await session?.finish()` - so it also fires when the
walk threw, which is correct: the unreadable frame was seen either way. Pinned by an ORDERING test
against a gated `finish` (`history.consumedFrames.test.ts`), because asserting the ask *happened*
passes against the defect too; run against the old placement it fails with `Number of calls: 1`.

**And the report now names its caller.** `catchUpDepth` is a global: it can say a session is open,
never whose. A caller nested inside one deadlocks, a caller merely running beside one would only wait,
and both were refused with the same sentence - so `waitForMessageQueueIdle(caller)` takes a label at
all seven call sites (`archive replay`, `history ask`, `history answer`, `history request answer`,
`outbox flush`, `connection sync`, `media send`) and both refusals quote it. Attributing this one
without it cost a read of every call site.

###### And the guard was refusing six callers it should have WAITED for - fixed 2026-08-16

The label was the whole fix for the report and NO fix at all for the behaviour, which is the more
expensive half. `catchUpDepth > 0` refused **every** caller, and only one of them is a deadlock.

- **The caller is inside the session it would be waiting on.** The stack that would close that session
  is the one blocked here, so nothing can ever release it. Refuse, and say so - this is the W2 wedge
  of 2026-08-15 and the `reconcileGroup` sighting above.
- **The session belongs to somebody else.** The global mutex blocks the drain either way, but by a
  stack that finishes on its own. **The barrier resolves - later.** Waiting longer is precisely what
  the caller asked for; refusing hands it the one outcome it was written to prevent.

The second case is not hypothetical and did not stay unobserved for long: **MUT-2, 2026-08-16, on
prod.** A replay opened a session on `642f389a…`; 98 ms later `connection sync` and 99 ms later
`outbox flush` were both refused, neither being about that group. `outbox flush` then proceeded to
send - the comment at that call site names the consequence exactly, *"sending at a possibly stale
epoch"*, the silent-loss race the barrier exists to close. One connection edge, both halves of the
ordering guarantee dropped, and the only trace was the diagnostic line added the day before.

**The discriminator is now a parameter**, `waitForMessageQueueIdle(caller, catchUpGroupId)`, and it is
NOT "which group this call is about" - it is *"the group whose session this stack could be running
inside"*. `archive replay` passes its group and `history ask` passes `groupId`; the other five pass
`null`, each being a connection edge, a click, or a leg already deferred past the drain by
`answerAfterMailboxDrained`, none of which can be inside a session. A same-group session is still
refused even when the caller does not own it: the group is a proxy for "inside", not a proof, and the
asymmetry is deliberate - a wrong refusal costs a guarantee the shared-fingerprint ledger still
catches, a wrong wait costs the client until it is reloaded.

**The day it spent as prose is the lesson**, and it is rule 15 of
[testing-methodology](../testing-methodology.md): the label was matched against the open group ids
with `caller.includes(...)`, and **not one of the seven call sites spells a group id**, so `NESTED`
could not be printed in the field at all. Every real occurrence read `CONCURRENT` - including the
nesting the guard exists for, which would have read as "nothing to fix". A distinction carried in a
string is a distinction nobody makes.

---

## Open questions

**None are open.** Two were closed on 2026-08-12 and moved into [Decisions](#decisions-taken) - what
may move the floor (nothing, for now) and who chooses the window (the platform, not the user) - and
the three below were closed by measurement or by decision. They are kept struck through rather than
deleted because each records why an alternative was rejected, which is the part a later reader needs.

- ~~**The new cap.**~~ **DONE.** The order was respected: Redis persisted → `maxmemory` 1→2 GB →
  `HISTORY_STREAM_MAXLEN` 1000→8000 (`retention.constants.ts`). Worth re-deriving rather than
  re-deciding if the mutation budget turns out differently: the cap is per group and `maxmemory` is
  for the whole store, so raising the per-group cap first would let eviction choose which
  conversations keep a shared copy at all.
- ~~**State key cost at scale.**~~ **MEASURED 2026-08-12, not a problem.** Off production:
  `dm_group_members` holds 41 memberships over 23 users and 21 groups - a median of ONE conversation
  per user, a maximum of 8, plus at most 9 channels for the busiest account. The fan-out is one
  small frame times seventeen in the worst case that exists today, and it would take two orders of
  magnitude of growth before the *frame count* mattered. Re-measure with that same `GROUP BY` if the
  population changes shape; what is worth watching is not the frames but the WALK behind each key
  (see below).
- ~~**Whether a deletion must also drop the shared-log entry.**~~ **CLOSED 2026-08-12: leave it as
  it is**, and the reason is that correctness never depended on it. The `delete_message` mutation is
  itself an entry in the shared log, so any device replaying that log converges on the tombstone
  whether or not the original entry is still there. What remains is a retention question and not a
  convergence one: the original ciphertext of a deleted message sits in the stream until the cap or
  the TTL evicts it, alongside every other message of that conversation, and buying its removal
  would mean either rewriting a Redis stream in place or teaching every reader to skip entries a
  later entry cancels - two mechanisms, both permanent, for a window that closes on its own.
  Re-open it only if the log's retention is ever extended far enough for "until eviction" to stop
  being an answer.
