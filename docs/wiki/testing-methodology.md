# Testing methodology: how a result earns the right to be believed

This page is about **measurement**, not about any one feature. It is the distillation of the
**thirty-one harness faults** that produced a false verdict during the
[cross-client campaign](cross-client-testing.md) - each one a check that reported PASS or FAIL for a
reason that had nothing to do with the application.

It is worth its own page because the faults are not campaign trivia. Every one of them is a way of
being wrong that survives the harness that produced it, and several of them cost a shipped bug: a
green check whose noise was ignored, an invented app defect that was a selector, a verdict computed
over a filtered copy of its own evidence.

> **Read this before writing a check**, and before believing one. The
> [rig itself](../../tools/cross-client-harness/README.md) is a separate document: that one is the
> instrument, this one is the epistemics.

---

**A PHASE THAT DOES NOT DECLARE A DEVICE CANNOT ARM IT, AND THE SKIP WILL NAME THE WRONG THING.**
MUT-18 drives the phone; `checks.mjs` said MUT needs `W1 W2`. So the preflight never touched A1,
`sameAccountAs` found nothing on 9333, and the check recorded `SKIPPED - second client not reachable`
- true, useless, and pointing at the cable instead of at the declaration one file away. Read a skip's
reason against the phase's `needs` before believing it names an obstacle.
`checks-selftest.mjs` now asserts the declaration against the source of every script a phase names,
and it is proven to fail on this exact case.

**A SELF-TEST INVOKED BY NOTHING IS DOCUMENTATION.** All three of the rig's self-tests - the two log
classifiers and the phase declarations - existed, passed, and were run by no target and no pipeline;
the one that would have caught MUT-18 was written the same day the defect was found and would have
gone stale beside it. They are `make test-harness`, they are inside `make test`, and CI runs them on
any change under `tools/cross-client-harness/`. None touches a browser, a phone or production, which
is what makes that possible: they are assertions over the rig's own source, so the gate costs seconds
and can never be skipped for being expensive.

**TWO BRANCHES OF ONE HELPER OWE THE SAME PRECONDITION, OR THE WEAKER ONE IS THE HARNESS'S FLOOR.**
`openDM` reached `/chat` by reloading on desktop and by navigating on the phone - and the reload
delivered a visible conversation LIST as a side effect nobody had written down. On mobile, where an
open conversation takes the whole screen, the phone branch arrived with the list hidden and the next
step searched a sidebar that was not rendered, reporting zero rows on a device with ten. Where two
paths claim to establish the same state, name the state and assert it on both.


## The rules

Grouped by what they protect, and ordered inside each group by how expensive they are to break.

### What a verdict may rest on

#### 1. A verdict must never be computed over a projection of its own evidence

`heal-web.mjs` filtered the console through a **display** regex, then ran its matchers over the
**filtered** text. A line the matcher accepts but the filter drops is invisible, so the check
reported `escalated=false` on a run whose repair had demonstrably run.

A capture filter is presentation. The verdict reads **everything** the run produced, and only the
report is abridged. If the two must share a regex, the verdict's is the superset - never the
other way round.

**A CHANGE LOG IS A PROJECTION TOO, and it is the one that reads like raw evidence.** `synboot.mjs`
records a mark only when the banner or the layout offset CHANGES - which is right, because a
histogram of samples cannot tell one 0.7 s appearance from a flicker. Its first verdict then counted
marks in the post-startup window as if they were samples and required at least one, so an offset that
never moved emitted nothing and scored as `FAIL` on the run that proved the fix. The evidence was
perfect and the verdict inverted it. **When the record is transitions, the verdict must be stated in
transitions** - "zero changes after ready", never "one distinct value after ready".

#### 2. Every action asserts its own post-condition - and the post-condition is the RIGHT state, not a changed one

The two halves are one rule because they fail together: a check that cannot prove its action took effect will happily accept any effect at all.

An action that cannot prove it took effect still yields a verdict, and **that verdict is fiction**.
The campaign produced this one five separate times:

- `am kill` on a **foreground** process is a silent no-op - it returns success and the app lives.
  Go HOME first, then assert the death (`pidof`).
- A "relaunch" that opened a new tab instead, so the check measured a fresh page that had never been
  through the transition it was testing.
- A `pidof` that exits 1 **exactly when** the thing it measures happens, so the harness read the
  failure as a shell error.
- A navigation that failed, was swallowed, and left the check counting rows on the previous screen.
- A zoom button never clicked, because the guessed `aria-label` did not exist - the check still
  asserted "something changed" and passed.

**"Did the state change" is almost never the assertion. "Did it change into the RIGHT state" is**

The corollary of the last item above. A pinch check asserted that the scroll position moved; it
moved, and the page had zoomed about the wrong point, which is the entire defect the check existed
to catch.

**Validate every check as a NEGATIVE CONTROL against the unfixed build before its green means
anything**, and set its tolerance from those two measurements rather than from taste. A check that
has never been seen to fail is not a check.

#### 3. Assume a green check is wrong until its evidence says otherwise - and a FAIL too

A FAIL is not evidence about the application until the fixture and the selector have been ruled out.
Two examples on opposite sides:

- A media check passed against a fixture whose PNG CRCs were invalid - it was never rendering
  anything.
- `check-feed-retry` reported FAIL against a feed that was visibly rendering posts, because it
  counted `article` / `data-post-id`, neither of which the feed emits (`PostCard`'s root carries
  `group/card`).

**A locator failure does not bias the verdict in a predictable direction**, which is why it cannot
be discounted as "conservative".

#### 4. THE ABSENCE OF A FAILURE IS NOT EVIDENCE OF SUCCESS - prove the path was EXERCISED

A check for "the push-authenticated fetch no longer 403s" counted zero rejections and wanted to call
it PASS. But the process had cached both avatars hours earlier, so it never made a request: the
verdict was measuring a path that did not run (WP-DIRECTBOOT-1). Every check whose assertion is the
absence of something needs a second, POSITIVE assertion that the mechanism fired at all - and it must
be reported next to the verdict, so a VOID run cannot be mistaken for a green one.

The trap that hides it here is **two success logs one word apart**:

| line | what it means |
| --- | --- |
| `fetchAvatar: from cache for X` | cache hit - **no network, no Keystore, nothing under test ran** |
| `fetchAvatar: avatar cached for X` | an HTTP fetch succeeded and was written - the authenticated path DID run |

A matcher written as `/(avatar cached\|from cache)/` therefore reports success for the one outcome
that proves nothing. Read the source at the log site before trusting a string that merely sounds
right; and to force the path, remove what makes it skippable - here
`adb shell run-as fr.emse.canari rm files/avatar_*.jpg`, which works because the build is
DEBUGGABLE, one of the few things a debug build is BETTER for (rule 17).

**THE CHEAPEST POSITIVE CONTROL IS A CLIENT STILL RUNNING THE OLD BUILD, AND THE MIXED FLEET HANDS
IT OVER FREE.** `synboot.mjs` reported zero banner appearances on both web clients after WP-BANNER-1,
which is the verdict wanted and therefore the one to distrust: a probe whose selector had rotted
would say exactly the same. A1 settled it without any extra work. The phone serves the bundle inside
its APK (`frontendDist` is `../build`), so a deploy never reaches it, and its build predates the fix -
so the SAME probe run against it caught the banner rising at 4 601 ms, 26 px high, held for 4 s.
The instrument discriminates, so the zeros mean something.

Two things came out of that control which the intended measurement could not have produced. The
banner did NOT move `mainTop` on A1 (107 px throughout), so the 29 px displacement that delivered a
click to the wrong button is a DESKTOP-layout consequence, not a universal one. And the verdict was
counting marks rather than comparing offsets - two marks reading the same 107 scored as two
movements - which is rule 1 again in a third dress: the mark fires on a change in the WHOLE probe,
so only the field being judged may be compared.

**AND A WHOLE PHASE CAN BE THE PATH THAT NEVER RAN.** Found 2026-08-16 by noticing that a run
announcing NOTIF-10 had not cut the phone's radios: `notif.mjs` selects ONE check from `argv[2]` and
defaults it (`|| '4'`), `notif7.mjs` does the same (`|| 'bg'`), and the manifest listed both bare. So
`run.mjs NOTIF` ran two of five checks and reported the phase. Sweeping every manifest script for the
shape found two more, and one names itself: **`tab236.mjs` implements checks 2, 3 and 6 and ran only
2**, while `life.mjs` implements seven Android lifecycle states and ran only one. The manifest now
spells every argument out - NOTIF 2 -> 5 scripts, TAB 3 -> 5, LIFE 1 -> 6.

**A default is indistinguishable from a choice**, which is why nothing ever said so: no output
differs between "the phase asked for check 4" and "the phase asked for nothing and got 4". The
omission that must stay explicit is LIFE-5 - it REBOOTS the phone and the unlock afterwards needs the
pattern, so it is a human check named in a comment rather than a gap nobody can see. **A coverage
omission belongs in the manifest as a sentence, never as an absence.**

**A RUNNER THAT BUFFERS ITS CHILD'S OUTPUT UNTIL EXIT CANNOT REPORT THE FAILURE THAT NEVER EXITS.**
The same day and the same cause: every phase script announces its stages on stderr precisely so a
stall is distinguishable from slowness - `notif.mjs` says so in its own header - and `run.mjs`
collected the whole stream into a string it only wrote on `close`. Two `notif.mjs` processes sat
there for FOUR HOURS driving the same browsers as every other measurement of the day, and were found
by listing OS processes, not by the runner that owned them. There is now a heartbeat and a watchdog
that bounds SILENCE rather than work - set well past NOTIF-10's deliberate 600 s of quiet - and it
kills and ACCUSES rather than retrying, because a runner that quietly restarts a hung script hides
what it exists to surface. `STALLED` is reported as itself: a killed child otherwise reports a signal
and reads as an ordinary crash in its last statement.

**Where the defect can be re-created, the check should re-create it.** WP-RELOAD-DL-1 asserts that a
reload does NOT navigate - and a build with deep links entirely broken passes that too. Deleting the
one key the fix relies on (`sessionStorage['canari:deeplink:handled']`) and reloading again brought
the replay straight back, which is what turns "nothing happened" into "the guard held". A PASS whose
failure you cannot produce on demand is the weakest kind there is.

**AND WHEN THE RE-CREATION IS A RACE, THE CHECK MUST ASSERT THAT IT WON IT.** `burn.mjs` sends, waits,
reloads, and asserts the next message arrives. Its premise is that the reload landed inside the
checkpoint window - and a run that MISSES the window delivers that message too, identically, proving
nothing. First run, 2026-08-14, at the 300 ms the original defect was measured at: the checkpoint had
already landed, and a check that reported only "delivered" would have been a green light for a repair
that never ran. The window had narrowed to under 60 ms since that measurement, because an unrelated
fix had made the write faster. So the premise is read and reported separately from the result, and a
run that failed to reproduce itself is `INCONCLUSIVE` - never `PASS`.

**Pick the witness that does not depend on listening at the right millisecond.** The repair prints a
line, and the obvious check greps for it. But a reload that does not raise the PIN gate starts
initialising before a CDP session can re-attach, so on the run that PASSED the line was missed
entirely (`burnedLine: null`) while the repair had demonstrably happened. A verdict resting on that
capture would have read "no burn" and been believed. The counters the repair consults are DURABLE and
can be read on either side of the reload at leisure: deficit before, deficit after. **Where a
mechanism leaves both a log and a state, the state is the witness** - the log is how a human finds it,
not how a check proves it.

##### The sharpest instance: a run that printed PASS while the branch never ran

WP-ECHO-1's device check sends its own message "during a drain" and asserts it survives a reload.
Version 2 printed `PASS - every message sent during a drain survived the reload`, on seven real sends
and a real reload. The capture said otherwise: the seven sends were at 13:20:23-13:20:39 and the
run's **first drain opened at 13:20:42**. Nothing had been sent during a drain at all, so the fix
under test was never reached and the correct verdict was VOID.

The cause was structural, not carelessness: the check spaced its sends with `sleep`, and the window
it needed to hit is the app's own bulk-ingest phase, which measured **15 ms to 1.4 s** depending on
the decrypt. A delay cannot aim at a duration the app chooses. Two changes fixed it, and both
generalise:

- **Trigger on the SYSTEM's own signal, not on a delay.** The check now arms the composer, waits for
  the phone's log to show a new window opening, and fires into it - so the only work between the
  event and the action is one CDP round trip. (`armComposer`/`fireComposer` exist purely to make
  that gap small; the ordinary `send` is now their composition, so nothing else changed.)
- **Report the exercise count NEXT TO the verdict, from an exact discriminator.**
  `[ADD_MSG] ✓ Message added` is logged by `addMessageToChat` alone, and inside a window an inbound
  message returns early into the buffer without logging it while the later flush goes through
  `batchAddMessages`, which never logs it. So that line inside a window can only be an own message on
  the live path. The run reports `inside a window: N`, and **N = 0 is a VOID**, whatever the reload
  then shows. The passing run reported 5.

The general form: when a check must act inside a window it does not control, find the log line that
opens the window, and find a line that can only be emitted by the branch under test. Without the
first the check cannot aim; without the second it cannot tell you it hit.

##### The corollary for a PERFORMANCE verdict: fast and skipped look identical on a clock

WP-ANR-1's check measures a duration - `onReceive` to `drainPendingOutbox: done` - against the 60 s
the OS gives a `goAsync()` receiver. It came back at **2 331 ms** where the defect measured 58.6 s,
and that number on its own is worth nothing: a drain that saw the radios were off and gave up before
encrypting anything would also finish in two seconds, and it is a perfectly plausible implementation.
A duration is a *lower* bound on work done, never a statement that the work happened.

So the exercise assertion for a performance check is a COUNT of the expensive operation, taken from
a line only that operation can emit. Here: 100 `PrivateMessage::try_from_authenticated_content` and
100 **distinct** ratchet generations in the OpenMLS trace, against **one** `MlsDeviceKeyStore.retrieve`
for the whole process. That triple is the `O(|mls.bin| + N)` shape observed rather than assumed -
and the keystore-load count is the one that would have caught a regression back to the per-message
entry point, because that regression is fast per call and only the *number* of loads betrays it.

#### 37. A REQUEST SENT IS NOT A REQUEST ANSWERED, AND ONLY ONE OF THE TWO IS EVIDENCE

DEL-10's predicate counted `Network.requestWillBeSent` for a `DELETE` matching the group URL, and
called the count "the deletion reached the server". With the radios cut, the browser fires that event
and the request goes nowhere - so the check's central claim, "nothing was sent while offline", was
being tested against a stream in which the offline send is indistinguishable from an answered one.
The check was verifying the wrong half of the mechanism it was written for.

The fix is the correlation CDP already gives: keep the `requestId` of each matching
`requestWillBeSent`, then count only the `Network.responseReceived` whose `requestId` is in that set,
and record the STATUS with it. An attempt and an answer are then separate numbers in the row, which is
what lets the verdict say "sent once while offline, answered zero times" - a sentence the old row
could not express.

**And the answer the client saw is still not the state of the world.** A 200 to the DELETE says the
server accepted it; whether the row is really gone is a question only the database answers.
`del10` now reads `dm_groups."deletedAt"` over `psql` after the run, so the row carries
`onServerAfter` beside the request counts. That is the check's real subject - the defect WAS a group
surviving server-side - and no amount of network evidence substitutes for it.

### Reaching the thing under test

#### 5. RESOLVE A TARGET BY IDENTITY, NEVER BY GEOMETRY - and the DEVICE is part of the identity

A selector, a coordinate and an adb serial are the same question asked at three scales: WHICH one. Geometry answers it only until something moves.

Name an element from the **component source**, never from what the markup ought to be. Scope any
selector shared by two surfaces: `.chat-composer-editor` also exists on the social feed, so every
use is scoped to `.chat-composer-footer .chat-composer-editor`.

The device half is the same rule one level up: with two adb transports attached (USB and TCP), every
`adb` call needs `-s <serial>`, and the serial is **resolved** from `adb devices` rather than
hard-coded. `/json/list` is not creation order, so a CDP target must be identified by what it
contains, not by its index.

An `aria-label` must never outrank visible text, and a document-wide text match hits the first
hidden row.

**A reader scoped to a surface answers `0` when that surface is absent, and `0` is exactly what a
lost message looks like.** `countMessage` reads the message pane; the phone is single-pane, so it
shows the conversation LIST after a reload and after a fresh launch, and there is no pane to read.
Two probes came back `0` on 2026-08-13 and were one step from being written up as lost messages -
both were on screen throughout, one of them visible in the list's own preview line. Any reader of a
conversation must therefore ESTABLISH the conversation first (`ensureConversation`, which is a no-op
when it is already open) rather than assume the client stayed where the last step left it. The same
single-pane fact breaks the writer: `openConversation` hunts a sidebar that no longer exists once a
conversation is open, so it fails on the phone precisely when the target is already correct.

**AN ANCHOR IS A CLAIM ABOUT THE PRODUCT, AND IT EXPIRES.** `PANE` located the open conversation as
the composer's nearest `<section>` - true of every conversation the product had ever had, until a
salon reserved for administrators started replacing the composer with the reason. The pane then read
`null` for a member who could still READ perfectly well, so `awaitMessage` reported `hasPane: false`
and COMM-7 failed on the ADMINISTRATOR's message: the harness saying "this client has no conversation
open" about a client watching one. **A conversation is a place where messages are DISPLAYED; being
able to write in it is a permission, and an anchor must not confuse the two.** Anchored on
`.chat-messages-scroll` since 2026-08-20. The general form: when a check locates X through Y, it has
asserted that Y is present whenever X is - so write that assertion down, and re-read it whenever the
product grows a state where it is false.

**A CLICK IS PROVEN BY THE EVENT, NEVER BY THE GEOMETRY AROUND IT**

TYPE-5 failed roughly one run in ten with the create-channel modal on screen, at coordinates
`stableCentreOf` had verified belonged to the `general` row moments earlier. Both readings were
honest and both were useless: a hit test **before** the dispatch and a screen read **after** it
describe moments the click did not happen, and neither can tell a click that landed on the wrong
element from a right element that did nothing.

The witness is the event. `realClick` now arms a capture-phase listener before dispatching and
returns what actually received the click, which named the culprit on the first occurrence:
`{"tag":"BUTTON","text":"Ajouter un canal"}` at the row's own centre. The cause was an application
defect - a status banner in the layout flow appearing at ~480 ms and vanishing at ~2 286 ms, moving
everything 29 px between the hit test and the dispatch - and no amount of re-proving the geometry
would have found it, because the geometry was correct every time it was read.

Two lessons, and the second is rule 7 again from the other side:

- **Verify the effect you asked for, not the conditions you asked under.** A coordinate that
  hit-tests correctly is a precondition, not a result.
- **Then establish the precondition properly**: `awaitAppSettled` waits for a STATE - no status
  strip up, `main` at the same offset for three consecutive reads - not for a duration. It lives in
  `chat.mjs`, so every check that clicks inherits it rather than each learning the trap alone.

**A HELPER THAT COMPUTES ITS OWN COORDINATES INHERITS NONE OF THAT**, and the omission is invisible
until it misses. FWD ran 4 passes of 5 because `clickBubbleAction` grew its own dispatch instead of
going through `realClick` - so it had no hit test, no recorder and no parking, clicked blind, and a
miss surfaced ~15 s later as a missing dialog, indistinguishable from an application defect. Routed
through the shared primitive, the same failure now names itself at the click: `"Transférer" action
moved before the click: nothing clickable at the point`. **A second implementation of a shared
primitive is a second place for this rule to be un-learnt** - extend the primitive instead.

**AND THE SAME RULE FROM A THIRD SIDE: TWO IDENTICAL SAMPLES ARE NOT A PROOF OF REST.** They prove
only that the element was not SEEN moving. `stableCentreOf` polled a rect every 120 ms and returned
a point once two consecutive rounded centres agreed - which an entry animation satisfies twice over:
before it has begun to paint, and again after it has finished. A backgrounded tab does not advance
one at all.

Measured on 2026-08-16, and the number is the whole diagnosis: the delete-confirmation button was
clicked at `dx=0, dy=24` from its own centre, with `candidatesInDocument: 1` - **24 px is exactly
the amplitude of `Modal.svelte`'s `in:fly={{ duration: 220, y: 24 }}`**. The centre was taken at the
animation's start and dispatched after its end, so the point landed in the footer that HOLDS the
button, which has no handler. Nothing happened, and the check died 5 s later on "the dialog never
closed". Three checks were losing runs to it - MUT-7, MUT-8, MUT-19, both venues, ~1 call in 6 - and
five passes of attribution went to the wrong halves first: a mis-resolved selector, then a slow
delete, then the two motions that turned out too small to matter (`hover:-translate-y-0.5` is 2 px
over 150 ms, and `mousePressed` follows `mouseMoved` by milliseconds).

**The repair is a proof, not a longer wait**: `IS_MOVING_FN` asks the page whether the element - or
any ancestor, because a modal's `fly` is on the PANEL and its buttons are passengers - is under an
animation that will end. `getAnimations()` covers CSS animations, CSS transitions and Svelte
transitions in one answer, so no duration has to be guessed for any of them. `pending` counts as
moving: an animation created this frame has not painted, which is the exact window that lied.
Infinite animations are skipped - a spinner never settles, and waiting for one would report every
button near a loader as unfindable.

Two corollaries, both paid for here:

- **Closing the window is not the same as closing the hole.** The check and the click are two
  messages over a socket and can never be simultaneous, so a verified point is stale by
  construction. Removing round trips between them shrinks the exposure (`maxTouchPoints` was being
  re-asked on every click for an answer that cannot change, and is now cached per connection) but
  only the absence of motion makes it safe. The in-page atomic alternative - `element.click()` -
  is the one that must NOT be used: it skips hit-testing, hover and touch, so it would have passed
  straight through both the create-channel modal and the phone's touch-only activation.
- **A miss must accuse at the click.** `realClick` now resolves the intended element BEFORE
  dispatch and the recorder compares against it inside the listener - after the fact is too late,
  because a successful click usually destroys its own target, so re-resolving answers "gone" for a
  hit and a miss alike. It should never fire now; if it does, it is a motion nobody has named yet.

**AND THE PROOF HAD TO REACH THE HELPERS THAT COMPUTE THEIR OWN POINTS, which is the paragraph above
happening again within the hour.** A hovered action row, a reaction in the emoji picker and a tap in
the phone's action sheet have no selector - they are found by walking the DOM from a message row -
so they never went through `stableCentreOf` and inherited none of it. Fixing only `realClick` left
them clicking mid-animation, and the very first run that could see it said so: `the 🎉 click was
taken by "EMOJI-PICKER" (target was ANIMATING when measured)`. The picker was still opening.

`stablePoint` is `stableCentreOf` for a caller-computed point, and the reason it is one function is
that three of the four sites had already drifted apart: one retried, one did not, one threw on its
first read. **Its polling set is the lesson** - "not there yet", "covered by something" and "still
moving" are one animation seen at three moments, so all three are polled and only the exhausted
budget is a failure. `tapSheetIcon` was the starkest: it read a sheet that SLIDES UP from the bottom
of the screen, exactly once, with no retry at all.

One corollary about reports, paid immediately: after the wait was added, `clickReactionEmoji`'s
failure still printed *was the target animating* - a question the new code can only answer one way,
because the point it clicks is settled by construction. **A discriminator that can no longer take
two values is not a discriminator**, and leaving it in would send the next reader after the cause
that had just been eliminated.

**THE PHONE'S SOFT KEYBOARD MAKES COORDINATES LIE, SO A CONTROL REACHED AFTER A FIELD HAS FOCUS CANNOT BE RESOLVED BY GEOMETRY**

Arming MUT-18 - the first check in this campaign to drive a message's controls on the phone - cost
three runs, and only the first was about the thing being tested.

1. `realClick` on the edit form's Save: the click landed somewhere, the form never closed.
2. `activate` instead - the fix `fireComposer` already carries for the composer: `no element to
   activate: text=Enregistrer`, about a button a probe measured a minute later at 77x26 with its
   label spelt exactly that way.

Both are the same cause. Focusing the textarea opens Android's soft keyboard, which shrinks the
**visual** viewport while the **layout** viewport `getBoundingClientRect` reports keeps its height.
`RESOLVE`'s last filter is a hit test at the element's centre, and a hit test is a coordinate test:
it rejects a control that is plainly on screen, so `activate` reports an absence rather than a
mis-click. `realClick` does not even get that far.

`saveOpenEdit` clicks the button inside the form, by DOM. **Skipping the hit test is safe there and
would not be in general**: only one message can be in edit mode at a time, so the form is unique on
the page and there is no second candidate - which is the only thing the hit test defends against.
State the uniqueness argument at every site that skips it, or this rule quietly stops holding.

**It became the desktop path too, and not for symmetry.** Left on `realClick`, the browser then
failed MUT-2 with `no stable element for selector: text=Enregistrer` having passed the same step
minutes earlier - `stableCentreOf` samples the geometry twice and the edit form animates in, so the
check was racing a CSS transition to buy a hit test it did not need. The phone's constraint turned
out to name a flake the desktop had been carrying quietly: **when a coordinate buys nothing, it still
costs a race.**

Corollary: **an obstacle attributed to the environment gets checked before it is believed.** MUT-18's
SKIP said A1 was off adb; SESSION STATE had said the opposite for weeks, and the phone was reachable
the whole time. The real obstacle was a missing helper, which nobody went looking for because the
written reason pointed at a cable.

**AND THE TAB IS PART OF THE DEVICE'S IDENTITY, WHICH `find` DOES NOT KNOW.** `client(port, match)`
resolved a client with `targets.find(url.includes(match))` - the FIRST tab whose URL matched, which
is a position, not an identity, and the browsers offer no guarantee about that order. With one app
tab open it is exact; with two it is a coin toss that never announces itself.

Measured 2026-08-16: **W2 was carrying seven `canari-emse.fr` tabs**, and had been for the whole MSG
re-run. A send-and-receive probe attached to one of them, read **6 console lines** from it, and
watched the profile's MLS snapshot counter advance **17 times** in tabs it could not see. W1, on one
tab, was exact throughout - which is the control that makes this the instrument and not the app.

A second tab of the app is **not a variant of the device, it is another device wearing its name**:
same profile, same login, same IndexedDB, its own gateway socket and its own in-memory counters.
Two questions the campaign had already filed as application findings dissolve on that fact:

- **`MSG-9` INVALID, "the receiver never went offline at the gateway"** - `cutHard` closes one tab's
  socket and the user stays present through the other six. The check was right to refuse.
- **Two MSG verdicts PASS-DIRTY on `[MLS] Skipping stale MLS state write (vN <= stored vM)`** - the
  write-if-newer guard in `hex.ts` doing exactly its job against seven MLS clients sharing one
  IndexedDB key, each with its own `_snapshotSeq`. **Nothing is lost when it fires** (the freshest
  snapshot is the one already stored) and on a single-tab client it cannot fire at all: a clean boot
  takes exactly ONE tagged snapshot, measured 48583 -> 48584, zero skips. So it earns **no
  forgiveness rule** - if it is ever seen again on an unambiguous browser, that is a finding.

The fix is at the seam and not at the ninety-six call sites: `client()` **refuses an ambiguous
browser**, naming the count and the paths, and `{ allowMany: true }` is the opt-in for a check that
opened a sibling on purpose. `onetab.mjs` is the repair, and `--dry` exits non-zero so a preflight
cannot ignore it.

**The origin is NOT established, and saying so is the point.** The first account written here - a
one-shot probe that spawned `chrome.exe` beside a live instance, which `startBrowser`'s docstring
says hands its URL to the running browser as a tab - is plausible and was **not** what happened: that
probe waited for the port to stop answering before every relaunch. The obvious successor theory was
measured and refuted too: a force-kill followed by `startBrowser` restores **nothing**, one tab in
and one tab out. What remains is that some path between 14:50 and 15:07 on 2026-08-16 left six
extras, and no capture from that window survives to name it.

That is exactly why the fix is a refusal and a preflight repair rather than a fix to whatever opened
them. **A precondition worth having is one the rig ENFORCES, not one it trusts every caller to
preserve** - the enforcement holds against the cause nobody identified.

The contamination window is bounded, and by the record rather than by memory: `MSG-9` cannot pass on
an ambiguous browser, and it reads PASS on all five passes of the 2026-08-15 series, PASS again at
14:48 on 2026-08-16, `INVALID` at 15:12, and PASS again at 15:35 after the repair. `Skipping stale`
appears nowhere else in `results.ndjson`. One run was affected; the x5 series was not.

**And that reading is only sound because it named a WINDOW.** `results.ndjson` is append-only over the
whole campaign: 731 rows for GRP's ten checks alone, holding every attempt including the aborted and
the partial - GRP-4 carries 61 `PASS`, 12 `PASS-DIRTY`, 9 `FAIL` and 1 `ERROR`, all of them true of
some moment. So **a tally keyed on a check id counts history, not a pass.** `run.mjs` is right today
by construction (`all().filter((r) => r.at >= startedAt)`), and the trap is waiting for the x5 sweep,
which is the first thing that will want to ask "did this row pass five times": it must key on five
identified RUNS, over one build, with the rule set fixed - three properties a check id does not carry.
Nothing in the ledger is ever deleted to make that easier; an aborted attempt is evidence, and pruning
it is how a series comes to claim more than it measured.

#### 6. A MATCHER TESTS ONE SPELLING - and one written from the success wording can only ever report success

Both are the same failure of a matcher: it was written from what the author expected to see, so the outcomes it cannot spell become silence, and silence reads as health.

When a mechanism leaves no trace, a **stale matcher is the right first suspicion** and it is cheap
to rule out: grep the log for every word the mechanism could have used, not for the one string the
check happens to look for. Only once the whole vocabulary is absent does the silence say something
about the application.

Its mirror image: two lines that **no longer exist in the codebase** appearing in a run means the
client is on an old build. Check the deploy before believing anything else that run says.

**A WATCH THAT MATCHES THE SUCCESS WORDING REPORTS ONLY SUCCESS - and silence then reads as health**

The MSG x5 of 2026-08-15 was followed by a live filter over the runner's output, alternating on
`server (clean|NOT)`. The runner prints `  server clean` when a window is clean and
`  SERVER NOT CLEAN - run srvlog.mjs --since ...` when it is not. The alternation is
**case-sensitive**, so it matched every clean window and **none** of the dirty ones: five passes were
reported, four of them said `server clean`, and the fifth said nothing at all. The pass-2 window -
`frontend-ssr NOT CLEAN, unexplained=9` - reached the reader only because the full output was read
by hand afterwards.

The failure is not the regex. It is that **the observer was written from the shape of the outcome it
expected**, and the two outcomes of this runner do not share a spelling: one is lower case, the other
is upper case with a remediation clause appended. A filter derived from the happy path cannot report
the other one, and its silence is indistinguishable from "nothing happened yet".

Applies to any live watch, not just this one: **enumerate the terminal states first, then write the
pattern over all of them.** If you cannot enumerate them, widen rather than narrow - noise costs a
read, a missed failure costs the finding. And the cheapest check on any such filter is to ask what it
would have emitted had the thing being watched crashed at that instant; if the answer is "nothing",
it is not a monitor.

### The state a check needs, before and after

#### 7. A CHECK ESTABLISHES ITS OWN PRECONDITION, and what establishes it belongs in the shared layer

One rule from two directions: a transition destroys preconditions other checks depend on, and a check that assumes one it never established is measuring the previous check's leftovers.

A kill, a reboot, a radio cycle and an `install -r` **all re-lock the PIN**. A precondition
discovered by one check belongs to every check sharing the transition, so it goes in the shared
setup, not in the check that found it.

**And the rule applies to the SETUP ITSELF, where it is easiest to miss.** A repair is a transition,
so one repair can produce exactly the state another repair exists to fix - which makes a fixed
sequence of one-shot repairs wrong however well each one is written. `run.mjs`'s preflight repaired
`unknown` (a client on a route where the PIN gate never mounts) and then `LOCKED`, once each in that
order; unlocking leaves the client wherever it already was, so a freshly launched phone went
`LOCKED -> unlock -> unknown on /posts` and the preflight refused a client that was one step from
ready and healthy throughout. The repairs now **iterate** to a fixed point, bounded on PASSES.

The bound is not the interesting half - the report is. An exhausted bound prints the TRAIL, because
`LOCKED -> unknown -> LOCKED` (a client re-locking on every navigation) and `unknown -> unknown` (one
that never moves) end in states whose last value cannot tell them apart, and they want opposite
fixes.

**AND THE SETUP IS A PRECONDITION OF EVERY SCRIPT, NOT AN OPENING CEREMONY.** The preflight ran once,
before the first job, and the eleven scripts after it started from whatever the previous one left
behind - so the result of a phase depended on the ORDER and on the leftovers, and a green run proved
nothing about the next one. That is the exact opposite of what a phase is for: a phase exists to be
**re-run after a change to show the system is still healthy**, and a phase that cannot be replayed
from a defined state cannot show anything.

It cost a real diagnosis on 2026-08-14. MSG-5 left the "Ajouter un canal" dialog open; MSG-1b,
MSG-6/7, MSG-9 and MSG-10 then all died inside `ensureChat`, each pointing at an application that was
working perfectly - four checks accusing the wrong component, which is worse than four checks not
running. Note what the existing signals said about that client: reachable, unlocked, on `/chat`, full
sidebar. **An overlay is invisible to every readiness probe and swallows the first click**, so it is
now part of what "ready" means, repaired loudly like the others. And a job whose clients cannot be
brought to a known state is reported BLOCKED rather than run: it never executed, so it has no verdict
at all, and saying so is the difference between "the app misbehaved" and "the question was not
askable".

**A CHECK MUST ESTABLISH ITS PRECONDITION, AND WHAT ESTABLISHES IT BELONGS IN THE SHARED LAYER**

TYPE-4 asks that an **offline** peer sees no typing indicator and gets none replayed when it returns.
It set `Network.emulateNetworkConditions({offline: true})` on the peer, waited, and asserted the
indicator was empty. It failed, and the failure was entirely its own: that setting fails NEW requests
and leaves an ESTABLISHED WebSocket open, so the peer was never offline, took the frame live exactly
as it should have, and the check reported a delivery defect it had manufactured.

The precondition was never established, only intended - so **the one outcome the check could not
produce was the true one**. An assertion of the form "while X, not Y" is worth nothing until X is a
fact the system under test agrees with. Here that fact is the gateway's presence key: `cutHard`
closes the socket as a dropped connection would, `awaitOffline` waits for the key to go, and a peer
that never goes offline makes the verdict **INVALID**, never `FAIL` - the difference between "the app
is wrong" and "I did not manage to ask".

**The sharper half is that none of this was new.** `msg9.mjs` had measured the same trap on
2026-08-13 - sixty seconds of "offline" with the presence key refreshed the whole way through - and
written it up in its own header, where no other check could reach it. A fact that costs a diagnosis
to learn belongs in the shared layer the moment it is learnt; left in the file that paid for it, the
next check pays again. `cut()` vs `cutHard()` is now the seam that carries it.

Two smaller instrument faults came out of the same phase, both worth naming because neither is
caught by a green gate:

- **`type.mjs` computed five verdicts and read no console at all.** The campaign's rule that
  observation is part of a check was stated globally and simply not implemented in one phase file, so
  every TYPE pass asserted that an indicator appeared and said nothing about what the two pages
  logged while it did. A rule enforced by remembering to write it is not enforced.
- **A syntax check is not a runtime check.** A comment inside an evaluated template literal quoted an
  identifier in backticks; the backticks closed the literal, leaving `template / identifier`, which
  is valid JavaScript. `node --check` passed and every run threw `ReferenceError` at the division.
  Proving a harness edit means RUNNING it, exactly as proving a native build means running it.
- **A precondition with TWO legitimate landings may not be written as one of them.** `synboot.mjs`
  waited for the PIN modal after a reload, because that is what a reload usually lands on. With
  "Rester connecte" ticked the vault device key path restores the client with no modal at all, so the
  wait burned its whole 30 s deadline and the next line then reported the app **ready in 2 ms** - a
  boot that had in fact finished 29 s earlier. Nothing failed; the check simply measured its own
  wait and printed it as the application's number. Race the landings and let the answer say which
  one happened.
- **A precondition the product cannot reach is not a precondition, it is a fabrication.** MUT-15
  built its "device that lost a pin" by dropping the pin record and restoring
  `history_last_stream_id` / `history_seen_cipher` to the instant before the frame, so the replay
  re-offered a ciphertext this device's MLS ratchet had already consumed. Forward secrecy spends a
  generation's secret at the first successful decrypt: that state exists nowhere in production, and
  the check spent five passes reading MLS's correct refusal as a product defect. The rewind is gone -
  the device is cut with `setOffline` BEFORE the peer pins, which is how a device really comes to
  lack a pin, and the absence is read back before the recovery is polled. The tell is generic: when
  a setup writes storage the application owns, name the sequence of user actions that produces that
  state, and if there is none the check is measuring its own construction.

#### 8. WHEN THE BREAK IS NOT INVERTIBLE, THE TEARDOWN RESTORES A PROPERTY, NEVER A SNAPSHOT - and a cleanup that only runs on the happy path is not a cleanup

The fixture and the teardown are the same object seen from its two ends, and both fail the same way: on the paths where the check did not reach its own last line.

Rewinding a sender cannot be undone by restoring any state: while the fork was live, the peer
consumed generations off it, so **no snapshot is both legitimate and ahead of the peer**. Restoring
one re-creates the very break.

Ask what the next run actually needs - "can this device still deliver?" - and assert that invariant
on every exit path (`ensureDeliverable`). A teardown that only runs on the happy path is not a
teardown.

**A CHECK'S FIXTURE MUST EXIST BEFORE THE SURFACE THAT READS IT - and a cleanup that only runs on the happy path is not a cleanup**

MUT-12 seeds `canari_recent_emojis` so the emoji picker offers fifteen distinct emoji to react with.
It seeded straight after `sendText`, under a comment asserting the picker reads localStorage on its
own first open. **It does not.** `MessageBubble.svelte` renders `MessageEmojiPicker` unconditionally
and only flips its `visible` prop, so that component's `onMount` runs when the **bubble** renders -
which is the instant `sendText` returns. A seed written afterwards could never reach the row the
check is about.

What it produced is the part worth remembering. `MUT-12/dm` threw on its first picker emoji, every
single run. `MUT-12/channel` **PASSED** - because the DM leg threw *before* its own cleanup line and
left the seed in localStorage, where the channel leg's bubble picked it up on mount. One leg was
failing honestly and the other was passing on the first leg's litter, which is strictly worse: on a
fresh profile both fail, and the green row said the opposite. The fix is two lines and two rules: the
fixture goes in **before** the surface exists, and the cleanup goes in a `finally`.

The third lesson is about the sentence. `clickReactionEmoji` threw `no quick-reaction 🎉 on the row`,
which is the same sentence for *the picker never opened* and for *the picker opened with the wrong
list* - and those want opposite fixes (rule 16's shape again). `offeredEmojis` now names what the row
**does** offer, so the next failure of this kind is one line to read.

**AND THE DEBRIS A CHECK LEAVES DOES NOT SIT QUIETLY - IT TALKS, ON EVERY LATER RUN.**

READ-10 creates a group, has the peer delete it, and asserts the owner's client sends no read
receipt for the corpse. The corpse is the point of the check, so leaving it looked free. It is not:
a conversation marked `removed` is a fact about what its owner was TOLD, so it survives every later
reconciliation until a human dismisses it - and each one narrates that decision, once per row, on
every load of every check that follows. Four had accumulated before anyone counted them, and the
first symptom was READ-10's own verdict coming back `PASS-DIRTY` on a line its own previous runs had
written.

Two things follow, and the second is the one that generalises. A check must undo its fixture
**through the product's own exit** - here the "delete locally" control, the only one the app offers
that row - which turns the teardown into coverage instead of housekeeping. And the debris to look for
is not the row: it is the LINE. Ask of every leftover what it will say on the next run, because
litter that speaks is worse than litter that does not - it teaches the reader of a log to skip a
line, and the next defect will arrive in the ones they have learnt to skip.

#### 9. A CHECK THAT REPAIRS THE CLIENT MUST WAIT FOR ITS OWN REPAIR - a single sample right after it measures the instrument

`run.mjs`'s in-run preflight repairs a client parked on `/communities` - where the PIN gate does not
mount, so readiness reads `unknown` - by sending it to `/chat` with a full document navigation. Every
other repair in that loop then waits on a DEADLINE (`settle`, 3-20 s). The gateway-presence check did
not: one `presence.mjs` sample, taken immediately, and a non-zero exit blocked the phase.

**MSG-6/7 was `BLOCKED` on five passes out of five** on a phone that was working perfectly. Measured
directly by parking A1 and polling:

| after the navigation | gateway |
| --- | --- |
| 4 879 ms | OFFLINE |
| 7 828 ms | OFFLINE |
| **10 832 ms** | **ONLINE**, still on `/communities` |

The route was never the problem - the page it sits on is irrelevant, the reconnect cost is
everything. A document navigation destroys the socket with the document, so the read that follows
answers about the harness's own action. It now polls to a 25 s deadline and prints only the last
attempt: a client already connected answers on the first sample and pays nothing, and a client
genuinely absent still fails - the diagnostic value is untouched.

The general form, and the reason this is not rule 7 again: rule 7 is about a precondition the check
never ESTABLISHED. Here the precondition was established, correctly, by the check itself - and then
read before the system had finished responding to it. **Anything you did to the client is a
transition; give it the same deadline you would give the application's own.**

#### 41. AN UNDRIVEN DEVICE IS A PARTICIPANT, SO A "TWO-DEVICE" CHECK IS NOT TWO-DEVICE

GRP-4's evictions were committed by neither browser the check drives. The commits came from a fleet
device the run never touches - the preflight had said so on every single run, as
`note FLEET: 1 device(s) online that this run does not drive` - and the first diagnosis blamed the
inviter's browser because that was the only other party the check knew about. The inviter's console
was SILENT, which was read as "the log line must not carry the group id"; it carried it, and the
silence was the answer.

A device that holds a leaf commits on its own timers whether a check drives it or not. So the
population under test is every device ONLINE for the accounts in play, not every device the runner
has a handle on - and the preflight note naming them is evidence, not noise. When a check's two
parties cannot account for what the tree did, the third party is in that note.

Corollary for the diagnosis order: a client's silence is only evidence once the line you expected is
confirmed to carry the field you filtered on. Read the log SITE before reading meaning into its
absence.

### Watching, and what a window means

#### 10. FORGIVING AN EVENT MEANS TAKING IT OUT OF THE GATE, NEVER OUT OF THE RECORD

A classifier exists to decide what breaks `clean`. It is not entitled to decide what is *kept*, and
the two get conflated the moment a bucket is emptied rather than moved.

`ignoringOfflineCut` did exactly that. A check that cuts the link on purpose must not be marked dirty
by its own cut, so the function set `wsEvents: []` - correct as a gating decision, and it destroyed
the only DATED record of the instant the socket died. When WP-RECONNECT-2 turned on precisely that
instant, the answer had been thrown away by the instrument, for being expected. **Expected is not the
same as uninformative**, and the events a check deliberately provokes are usually the best-timed
things in its whole capture.

The same mistake has a quieter form: **a line with no clock cannot be placed, and bucket order is not
a clock.** `[WS] Disconnected` is a `console.warn`, so it carried no timestamp where every
`appendLog` line around it did; it was placed at one end of a 98-second hole by the order it appeared
in a bucket, and that inference reversed the diagnosis when it was questioned. CDP has carried the
real clocks all along - epoch milliseconds on console events, monotonic seconds on network events,
convertible through the one event that carries both - and none of it was being read.

So: two fields, not one. `wsEventsDuringCut` beside a `wsEvents` that the gate may empty, and a
`timeline` that dates and interleaves everything regardless of which bucket a line ended in. **The
question a capture will be asked is rarely the question it was written for**, which is the whole
argument for keeping the raw sequence next to the verdict.

#### 11. A CAP IS NOT A COUNT, AND A SUMMARY AS LONG AS ITS SOURCE IS UNREAD

Two ways a triage list lies about its own size, both met on 2026-08-14 within an hour of each other.

**A truncated bucket reported its truncation as its measurement.** `srvlog.mjs` kept
`errors.slice(0, 40)` and then printed `errors.length` - which is 40 whether the window held forty
errors or nine hundred. The summary line a reader uses to decide *whether to look at all* was
therefore incapable of ever saying "this is worse than you think". The window that finally got read
held **1 154** unexplained gateway lines behind a `40`. Every truncated bucket now carries its own
`…Count` taken before the slice.

**And a list of 1 154 lines is not read by anybody**, so it may as well be empty. Collapsing each
line to its *shape* - text with every identifier replaced by its kind - turned those 1 154 into 33
sentences, and the whole seven-service window into 72. That is a list a person finishes.

The catch is that **the normaliser then decides how big the work looks, so it is load-bearing and it
must be tested.** Its first draft matched ids at sixteen hex characters, so eight-character
correlation ids survived and 287 copies of one sentence counted as 287 distinct shapes - a summary
exactly as long as the thing it summarised. Its second bug was ordering: the device rule ran after
the id rule, so `web-<id>-suffix` had already stopped looking like a device by the time anything
looked for one. Neither has a symptom on a live window; both are pinned in `srvclassify-selftest.mjs`
now, next to the assertion that genuinely different sentences must still *not* collapse.

#### 12. AN INSTRUMENT'S OWN LIMIT ARRIVES WEARING THE SYSTEM'S FAULT - and it bites the busiest subject first

`chat-delivery-service` reported `unreachable: spawnSync … ENOBUFS`, which reads as a broken tunnel
or a dead container. It was neither: Node's default `maxBuffer` is 1 MB, and that service writes
11 824 lines a day, so any window wide enough to be interesting exceeded it. **The busiest service on
the platform was the one whose logs could never be read, and the reason looked like infrastructure.**

The general shape is worse than the instance. A limit that scales with the subject's activity fails
*precisely* on the subject that has the most to say - the quiet services all read fine, so the
instrument looks healthy in aggregate. Anything that reads a variable-sized answer needs its ceiling
chosen against the loudest case, not the median one.

What saved this from being silent is that `srvReport` files an unreadable service as `unreachable`
and breaks `clean`, rather than returning `[]`. **An unreachable service is not a quiet one**, and
the substitution of one for the other is the single failure this harness exists to refuse.

#### 13. AN OBSERVATION WINDOW MUST KNOW WHETHER ITS SUBJECT WAS REPLACED DURING IT

The gateway logged five `Connection reset without closing handshake` errors inside three
milliseconds, across four different users. Nothing a client does explains that. The container
timestamps did: `frontend-ssr` and `frontend` were recreated at 12:45:20.5, and the five resets are
at 12:45:19.892-.895 - the tear-down of the old container, 0.7 s earlier.

Two consequences, and the second is the general one. First, an operational fact worth knowing:
**nginx is the single public entry point, so a frontend redeploy severs every proxied WebSocket on
the platform at once.** Second, and the reason this is a rule: a run whose window straddles a deploy
will attribute the deploy's fallout to whatever it happened to be measuring. So a service *starting*
inside the window is classified `notable` and never benign - `Listening on http`, `Nest application
successfully started`. The window must be able to say "I was rebuilt under myself".

The same instant answered a question the passes could not: the three MSG passes ran 12:22-12:45 and
the fix under test deployed at 12:45:20, **after all of them**. `webstate.mjs` then showed both tabs
still on `__sveltekit_1prkb1y` against a served `__sveltekit_1ywe1to`. Re-running without reloading
would have measured the old bundle a fourth time and called it a verification.

##### The same rule pointed at the CLIENT - where the replacer is the check itself

READ was the first phase whose runner classified console lines at all, and on the run that wired it
in, READ-1, READ-2 and READ-4 each came back `PASS-DIRTY` on exactly one `Network.webSocketClosed`,
with `[WS] Disconnected. Code: 1006, Reason: no reason` beside it. 1006 means no close frame was
received - the signature of an intermediary dropping a connection - so it read as a live socket dying,
which is WP-RECONNECT-2's exact shape.

**The first attribution was wrong, and the probe that produced it was not.** `wsclose.mjs` reported
that the closed socket had never been created inside the window, which is true and correctly
measured. The conclusion drawn - that the window had inherited the *previous* page's close - did not
follow, because that probe never performs the check's SECOND navigation. `gotoWatched` was built on
it, delayed each window until the new page's handshake, and the next run came back identically dirty.
**A probe answers the question it was written to answer**, which is the client-side twin of "a column
is only evidence for the question it was written to answer": the measurement was reusable, the
inference was not.

What settled it were two CONTROLS rather than more evidence of the same kind:

- `wsidle.mjs` left W1 **and W2** alone for eight minutes, touching neither - same instrument, two
  subjects, one window. **Zero closes on both.** That kills the idle-timeout-on-the-path reading
  outright: nothing drops an untouched socket, so the event is caused by something the check does.
- `navclose.mjs` then navigated three times and counted: three main-frame `Page.frameNavigated`,
  three `webSocketCreated`, three `webSocketClosed`, three `Code: 1006`. **One document replacement,
  one close, exactly.** `openDM` is `goto` is `Page.navigate`, so each of those checks was tearing
  down its own socket and then reporting the teardown as dirt.

Two things follow, and neither is "ignore socket closes".

**Forgiveness is bounded by a counted proof.** `ignoringNavigation` forgives at most
`documentsReplaced` closes and no more; the (N+1)th still breaks `clean`, so a live socket dying stays
visible. The tempting rule - *ignore a close whose open I never saw* - would have silenced precisely
the class the campaign exists to catch. Note also that the obvious counter is the wrong one:
`Runtime.executionContextsCleared` fired **six** times for three navigations, and only main-frame
`Page.frameNavigated` is 1:1.

**And the window opens BEFORE the navigation, not after it.** `gotoWatched` now watches first and
navigates second - the inverse of what it did when it was written. A window that opens late is a
window blind to the boot it skipped, and the boot is where a startup defect lives.

An application "fix" fell out of this, shipped, and was **reverted the next day as inert** - the
story is rule 14. The harness rule above is unaffected either way: it attributes a close to a counted
document replacement, and a document being replaced still closes its socket however politely it does
so. **`ignoringNavigation` is what actually removed this dirt**, and it was the whole of the fix.

#### 14. A FIX MUST NAME THE OBSERVER WHOSE SIGNAL IT IMPROVES, AND THAT OBSERVER MUST BE ABLE TO SEE IT

Rule 14 found that every `goto` closes its own socket and reports `1006`. The harness fix was right.
The APPLICATION fix that shipped beside it - `closeForUnload`, closing with `1001 - going away` so a
routine navigation would stop spending the code that means *an intermediary dropped the link* - was
**measured inert the next day and reverted**. Nobody could ever have seen it:

- **The client cannot.** `CloseEvent.code` carries the code the SERVER sent back in its half of the
  closing handshake. At unload the document is destroyed long before a reply can arrive, so the
  browser fills in `1006` whatever code the page asked for. Measured on a tab positively confirmed to
  be running the new bundle: **3 navigations, 3 x 1006** - identical to before the fix.
- **The gateway cannot either.** It matches the app's own `{"type":"disconnect"}` frame with
  `handle_disconnect(...); break` (`chat-gateway/src/handlers.rs`), so it has already left its read
  loop when the close frame arrives. Its `Client closed connection: {:?}` line is unreachable for any
  client that announces itself: **0 occurrences against 12 explicit disconnects in 25 minutes of
  production traffic.**

So the change was a no-op with an interface method, four implementations and a test behind it, and
its CHANGELOG entry promised users a reduction in something that never reduced. **Before writing the
fix, name the log line, counter or screen that will read differently afterwards, and check that
something actually reaches it.** Here the honest answer was already available: the `disconnect` frame
tells the gateway everything a close code would, and earlier - so there was nothing to add.

Two corollaries, both paid for on the same day:

- **A discriminator that fires identically with and without the change discriminates nothing.**
  `unloadframe.mjs` counted the `disconnect` frame at each navigation and called 3/3 a PASS for the
  fix - but `sendDisconnect` PREDATES the fix. W2, on a bundle positively lacking the new chunk,
  emitted the frames too. It only looked decisive because it was run first on the one client that
  happened to have the change. **Run the negative control before believing the positive one.**
- **A NAVIGATION DOES NOT PICK UP A DEPLOY; ONLY A CACHE-BUSTING RELOAD DOES.** W2 served the old
  entry chunk across three `Page.navigate` calls made after a successful deploy. Any check re-run
  "on the new build" without `Page.reload {ignoreCache:true}` is measuring the old one - rule 17 with
  a sharper edge. `bundle-id.mjs` reads the loaded chunk hashes off the resource timeline and answers
  it directly; a fingerprint that comes back EMPTY compares equal to itself and will happily report
  "unchanged" for ever, which is how the first attempt at this reported `INCONCLUSIVE` for a reason
  that was not the true one.

---

#### 15. A DISCRIMINATOR CARRIED IN A LABEL DISCRIMINATES NOTHING - check it against the values that will actually reach it

A report that separates two causes is only worth what its separator is worth, and a separator matched
out of prose is worth nothing until someone proves it fires.

The mailbox barrier refuses a caller while a catch-up session is open, and the two situations it
covers are opposite: the caller is INSIDE that session (a deadlock, fix the call site's order) or
beside somebody else's (not a deadlock at all - it should wait). On 2026-08-15 the refusal was taught
to say which, by matching the caller's label against the open group ids -
`caller.includes(s.groupId)`, "the caller carries its group by convention `<site>:<groupId>`".

**No call site carries one.** All seven pass a bare literal (`'history ask'`, `'outbox flush'`, …),
and only the unit tests ever passed `'history ask:g-abc'` - which is exactly why the tests were green.
So `NESTED` could not be printed in the field at all, every real occurrence read `CONCURRENT`,
and the one sighting on prod the next day (MUT-2, 2026-08-16) read as the benign case by
construction. Had the deadlock recurred, it would have reported itself as "nothing to fix".

Three things this pins, none specific to that barrier:

- **A convention that the code does not enforce is a comment.** `<site>:<groupId>` was documented in
  the same commit that failed to implement it at a single call site.
- **Test the discriminator against the population it will run on**, which is one grep for the call
  sites - the same move as rule 6's watch that matched only the success wording, and the same as the
  fleet-wide `GROUP BY` before believing a predicate.
- **Then carry it as a parameter.** `waitForMessageQueueIdle(caller, catchUpGroupId)` cannot be
  called without deciding, and a value the compiler demands cannot be forgotten at six sites out of
  seven. Same rule as the project's `Never branch on an error MESSAGE`: classify where the fact is
  known, as a type, not where it is being read back out of a sentence.

### Time

#### 16. WAIT FOR THE EVENT, NEVER FOR A DELAY - and a wait that can end two ways must assert the state between them

A delay and an ambiguous wait are the same defect at two moments: the first cannot aim at the event, the second cannot say which event it caught.

A fixed delay has two defects and one of them always lands. **Too short**, it makes "it never
happened" and "it has not happened yet" the same observation - MUT-11 flapped on `sleep(300)` while
the peer's real spread was 157-1453 ms. **Too long**, it charges every run for time in which
everything has already finished, and that cost is paid for ever.

Polling fixes only the first. The condition to wait for is almost always the one the verdict already
asserts, and reaching it IS the finish line:

- MUT-18 waited 15 s for an edit to appear and then slept 3 s for a later edit to overwrite it.
  Rewritten to wait for **convergence itself** - all three clients showing the same body, and that
  body being one of the two edits - it reports `convergedInMs: 22`. The guess was **136x** the
  measurement, on every run, and could still have been too short for a slow peer.
- MUT-12's `reactAndConfirm` and MUT-11's `awaitBadges` are the same move applied to a badge.

**An absence is the one thing that cannot be waited for, only waited out** - and even there, nothing
justifies a constant. Take the bound from the same run's measurement of the thing whose absence is
being asserted, and end early on the event that would refute it:

- MUT-13 proves a self-reaction notifies nobody. It slept 6 s; it now watches for `silenceWindowMs =
  max(1500, 6 x reactorNotifyMs)`, where `reactorNotifyMs` is what the *positive* leg of the same
  check just measured (~156 ms), and it breaks the instant a notify POST appears, because that POST
  is the failure. **The window is recorded in the row**: a bare `0` cannot be judged, `0 over 1500 ms
  when the same request took 156 ms` can.
- NOTIF-9 proves one message raises one notification. Same rewrite: `max(8 s, 2 x notifiedInMs)`
  instead of a flat `sleep(20_000)`, ending the moment a second notification appears.

Two delays are legitimate and must say so where they sit: one that **is** the behaviour under test
(`longPressBubble` holds 700 ms against the app's own 420 ms threshold), and one that paces a poll.

---

**A WAIT THAT CAN END TWO WAYS MUST ASSERT THE STATE BETWEEN THEM - and the SETUP that reaches it is part of the check**

`openChannel` clicked a channel row and waited fifteen seconds for the composer. On pass 4 of 5 of
the TYPE x5 of 2026-08-15 the composer never came, and the report - a good one, carrying the
coordinates, the element that RECEIVED the click, and the screen at both instants - could still only
say that. Two causes end in exactly that state and their fixes are opposite:

- the click was received and never HANDLED, or
- it was handled and the chat area rendered nothing. `ChatArea` renders **nothing at all** - header,
  message list and composer - while its conversation is missing from the store, so a selected channel
  with no entry looks identical to a click that never landed.

A channel selection changes no url either (it is a state assignment), so the address bar cannot
witness it, and fifteen seconds of waiting produce one bit where two are needed. The check now
asserts the intermediate state first - the row becoming `aria-current` - and reports which of the two
sentences applies. **The attribute already existed** for the screen reader, which is the recurring
shape: the affordance that makes a state announceable is the same one that makes it assertable, and
where it is missing, adding it serves both readers.

**And the evidence was absent for a second, independent reason: the setup ran outside the observation
window.** Both `watch` calls opened *after* `openChannel`, so the throw carried one sentence and not a
single console line from either client - on a rig whose whole premise is that observation is part of
every check. A setup that fails IS the check failing. Watch first; `report` already forgives the
navigation the setup performs, by counting `Page.frameNavigated` itself. And a setup failure must
drain those reports into its own record, or the file's top-level handler writes a poorer row over it
and the richer one is the copy nobody finds.

Corollary worth stating on its own: **a re-run is not a recovery.** The next four passes were green,
which recovered nothing - it destroyed the only window in which the fault was visible.

---

### The build under the check

#### 17. DATE THE BUILD BEFORE BELIEVING ANYTHING IT SAYS - and the build's own log strings are the date

A1 was measured for hours on 2026-08-11 against a **debug** APK several commits stale, and nothing in
the check said so. The fingerprint was in the evidence the whole time: the phone printed
`[QUEUE] STUCK: messageCallback has not settled after 60s`, a string `93244a7b` had **deleted** that
same day when it replaced the single-step watchdog with `guarded`. One `git log -S` on a line the
device logged dated the build in seconds - which is the general method, because a log string is
version-stamped evidence a running process hands you for free, while `versionName` is a constant
somebody edits at release time and had read `0.13.1` on both.

Two consequences, and the second is the expensive one:

- **A debug build is not the app.** WP-ANR-1's own note measures debug at ~10x release on the same
  fixture, so a TIMING verdict from a debug APK is not a weak result, it is an answer to a different
  question. Behavioural verdicts survive the distinction; performance verdicts do not.
- **Check the SIGNATURE before planning an install, not after.** `dumpsys package | grep pkgFlags`
  says `DEBUGGABLE` outright, and a debug-keystore install and a release-signed APK cannot replace
  one another - `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and the only way across is an uninstall that
  wipes `mls.bin`. Discovering that at the install step means the whole preceding setup was arranged
  for a step that could never run.

Same family as rule 1: `versionName` is a projection, the running code is the evidence.

#### 35. A BUILD LABEL IS ONLY EVIDENCE IF IT IS RESOLVED AGAINST A HISTORY THAT CONTAINS THE BUILD

Nothing a SvelteKit bundle serves names its commit; `/_app/version.json` carries a millisecond
timestamp, and `resolveStamp` turned it into a commit by asking for the newest one on `origin/main`
at or before it. That is exact for the DEPLOYMENT, which CD builds from a commit that is pushed by
definition. It is not exact for the PHONE, whose APK is built HERE, from the working tree - and a
commit reaches `origin/main` only when somebody pushes, which can be hours after the build.

So the same bundle answered differently depending on WHEN it was asked. A1's bundle, built
`2026-08-22T01:36:04.345Z` from `a7981206` (committed 03:12 local, pushed 05:27), was recorded as
`6748f6b8` by 207 MUT rows and as `a7981206` by the NOTIF rows that followed - one bundle, one
`builtAt`, two names, both on the board. The tell was the pair, not either half: an identical
`builtAt` under two commits is impossible, and only a query against a MOVING ref produces it.

`resolveStamp` now REQUIRES the ref and has no default, because the choice is the correctness
argument and a default would let the next caller inherit the wrong one silently. The deployment
passes `origin/main`; a client that serves its own bundle passes `HEAD`.

Two things this does not fix, both stated rather than left to be rediscovered:

- **Dating a build by a clock is still inference.** A commit that lands later carrying an EARLIER
  date - a pull of somebody else's work, a rebase - moves the answer again. The fix that ends it is
  the bundle carrying its own commit (`kit.version.name`), which is filed in `backlog.md` and was
  not done mid-campaign: it changes the deployment's version identity while prod IS the test server.
- **`builtAt` is the identity, the commit is the label.** The ledger is append-only, so the 207 rows
  keep the name they were written with; the board carries the correction and the reason.

Same family as rule 28: a device's build is part of its answer, and an answer nobody can attribute
is not evidence. Here the field was present, populated, and wrong.

#### 36. A CLIENT'S BUILD MUST BE READ FROM THE CLIENT, AND POINTING AT PRODUCTION IS NOT RUNNING IT

The phone was never on the deployment and the rig knew it: `ORIGIN` reads
`{ W1: SITE, W2: SITE, A1: 'http://tauri.localhost' }`, and every runner that touches A1 stamps
`a1Build` beside `build` precisely because a deploy cannot reach an APK. The web clients got the
opposite treatment - they point at production, so their build was taken to BE the deployed one, and
`clientBuild()` read it with a same-origin `fetch('/_app/version.json')`. For A1 that is the APK's own
asset and the answer is true. For W1 and W2 it is a network round trip to production, which answers
with what production serves NOW whatever the tab is executing. One function, two questions, and only
the phone's is the one the function's own doc claims.

**A browser left open across a deploy keeps executing the old bundle, and its console is
indistinguishable from a reloaded one.** On 2026-08-24, two minutes into `GRP --repeat 5`, GRP-3 came
back `PASS-DIRTY` on `[OUTBOX] … evicted from … - permanent failure` - a spelling REPLACED four
commits earlier, absent from all 205 chunks production was serving, and present in exactly one place
in the source: a test name. The classifier was right, the correction was right, the client was old.

Three things make this rule rather than an anecdote:

- **The stamp cannot be repaired after the fact.** A web row records production's build at the
  runner's import, so a phase that measured a stale client produces rows that are not merely
  unattributed but CONFIDENTLY MISATTRIBUTED. There is no retroactive audit: the client's own build
  was never captured, so `results.ndjson` cannot be re-read to find which rows were affected.
- **Staleness is a PER-CHECK property, not a per-run one.** SvelteKit polls `version.json` and
  reloads on the next navigation once it has changed, so a client is stale for an unpredictable
  PREFIX of a run and correct afterwards - W2 printed the old line at 15:22 and read as current when
  asked by hand nine minutes later, having healed itself in between. A one-shot check at the top of a
  phase would therefore have passed while the phase still measured two builds under one stamp. The
  gate belongs before every job, which costs one CDP connect for a client already current.
- **The discriminator has to come from the same place the decision is made.** `ORIGIN[device] ===
  SITE` already says which clients the deployment serves, so the web/phone split is a lookup and not
  a device-name list kept somewhere else.

The proof for the web half is the one SvelteKit already hands over: the shell writes
`__sveltekit_<id>` as a **global**, baked into the bundle rather than fetched, so a running page
carries its own build id in `window` while the origin serves the current one in the shell it renders.
Comparing the two is a property of the code that is actually executing, which is what rule 17 asks of
evidence.

And the reason this went unseen for days is rules 21 and 22 together. "W1 and W2 must be reloaded onto
the current bundle before any repair check" was a campaign rule **in prose**; `bundle-id.mjs` detected
the violation and `reload.mjs` repaired it, both written and both correct - and the only caller either
had in the whole rig was a sentence in a comment inside the other. A detector nothing executes reads
as coverage on every review, and the seam that can refuse a run is the preflight, so that is where the
question now lives.

### The check itself, over time

#### 18. A CHECK IS A CLAIM ABOUT A MECHANISM, AND IT ROTS WHEN THE MECHANISM MOVES

A check is written against the mechanism as it stands. Fix the mechanism and the check does not become stale quietly - it starts asserting the opposite of the product, in a colour nobody rereads.

Two rows here were built to fail on purpose, and both went green-side-up on 2026-08-16 when the
defects they described were fixed. Left alone, each would have asserted the opposite of the product.

**MUT-19 had been DEMOTED and had to be promoted back.** Deleting a message still in the outbox sent
it and then withdrew it, and whether the peer painted the original for one frame was scheduling the
check does not control - measured `false` then `true` within an hour on the same bundle. So the
assertion was moved off `everSawOriginal` and onto the settled state, correctly: a verdict that flaps
says nothing. But the demotion was a property of the DEFECT, not of the check. With the queued entry
withdrawn there is no race left to lose, so a single sighting is now a defect rather than an
accident, and the assertion goes back where it was. **A check softened to survive a defect carries a
debt that comes due with the fix.**

**MUT-21 was worse: it returned `true` unconditionally**, a leftover from the same era, so the hover
bar could have escaped the message pane again behind a green tally. A row that reports `FAIL` and
tallies `ok` is not a compromise, it is a check that has been switched off in one place and left
looking alive in another.

**A SIMULATION IS ONLY FAITHFUL TO THE MECHANISM IT REWINDS - name what it cannot reach**

MUT-15 simulated a fresh device by wiping one `localStorage` key and reloading. That was faithful
while pin state had no other source; the moment it gained one it stopped being a simulation of
anything, because **the device's position in the shared log was still at the head** - it re-read no
frame, so it could not recover anything from the log by construction.

Fixing that turned up a second, sharper constraint: **MLS gives a device no echo of its own frames**,
so a device replaying the log reaches its own `pin` frame and is told `own-message`. A device can
never recover from the log a pin it placed ITSELF. The check therefore had to change *which device
pins* - the peer places it, the device under test receives it - before any amount of rewinding could
help.

The rewind that works is a snapshot: capture the stream cursor and the seen-ciphertext set before the
frame, restore them after. That moves the device back by ONE frame, where deleting the keys would
have re-walked ninety days of a conversation holding thousands of messages on a production account.

And what it still cannot reach is written into the check's own record (`doesNotCover`): the
`history_bundle` half needs a genuine fresh enrolment, which belongs to
[device-verification](device-verification.md). **A check that names its own blind spot is worth more
than one that quietly implies it has none.**

Ordered by how expensive it is to break them.

#### 18b. A VERDICT IS EVIDENCE ONLY FOR THE ASSERTIONS THAT PRODUCED IT - tightening a check retires its previous verdict

Rule 18 is about a check that rots against a moving product. This is its twin, and it bit on
2026-08-20: the check moved and the BOARD did not.

**COMM-5 was recorded `PASS`, and its own row says `liveWithoutReload: false`.** At the moment of
that run the row asked only that a promoted member gain the capability eventually, so a reload was
allowed to be what delivered it and the record kept the live figure beside the verdict without
asserting on it. `capabilityIsLive` was added to its expectations afterwards, the runner was never
re-run, and the board went on showing a green row earned under a weaker question.

The cost was not theoretical. That recorded `false` WAS the defect found fifteen hours later - four
`workspace.*` events dropped by both socket clients - sitting in the results file, under a `PASS`,
where nothing would ever look at it again.

**So a row now names the check it ran as** (`check`, `checkSha` in `results.mjs`), exactly as it
already names the build it ran against, and "this verdict predates the current runner" is computed
rather than remembered. The hash covers the ENTRY script, where a check's own assertions live; a
change to a shared gesture in `comm.mjs` is not covered, and that limit is written down in the code
rather than assumed away.

**Reading it is the discipline the field only enables:** before believing a green row, compare its
`checkSha` with the runner on disk. A verdict whose check has changed is not a weaker verdict - it is
a verdict about a different question.

#### 19. A SCRIPT OWNS A FEW CHECKS, AND EVERY CHECK IS INDEPENDENT - the two halves of one rule

Standing instruction from the user, and it governs every phase: *"C'est bien de faire des scripts pour
un nombre limité de tests à la fois plutôt que pour tous les tests de la phase"*, and *"Un test doit
être indépendant. S'il est indépendant, il pourra aussi être fait les uns à la suite des autres"*.

**The granularity half.** A file that owns a whole phase fails as one unit. One throw in check three
takes checks four to twelve with it, and they had nothing to do with the failure - which is how a
phase reports one defect and eleven silences. The campaign has paid this twice in one week: three
scripts exiting non-zero having recorded nothing at all, and a run where a single `armComposer` throw
cost every verdict downstream of it in the same file.

**The independence half is what makes the granularity possible**, and it is the stronger claim. A
check establishes its own precondition, asserts nothing another check had to arrange, and leaves the
clients in a state the next one can start from. The test of it is not "does the phase pass" - it is
**does this check pass ALONE, and does it pass in any position**. MSG-8b passing standalone while
failing inside its phase is exactly the reading that is only available when checks are independent;
without it the failure is a property of the file and cannot be attributed at all.

Two corollaries the campaign already learnt the expensive way, now stated as consequences of this
rule rather than as separate lessons: a check that leaves an overlay, a backgrounded page or an extra
tab behind has broken the independence of every check after it (rules 7 and 8), and a check that
passes on the previous check's litter is strictly worse than one that fails honestly - on a fresh
profile both fail, and the green row said the opposite.

**Sequence is then a convenience, never a requirement.** The ladder's order exists because each rung
is easier to interpret once the one below it holds, not because a rung needs the previous one's
leftovers.

#### 20. RESIDUE A CHECK LEAVES IS A CLAIM ABOUT THE APP BEFORE IT IS A CLAIM ABOUT THE CHECK - and it is settled by re-running the check, not by reasoning about the dates

`recon.mjs` reported four messages one device held and no other did: the shape of a real loss, on
production, on the sender's side. The tempting reading was debris - MUT-19 deliberately strands a
message, so "the harness made them" would have closed the entry and bought a teardown. The dates
argued AGAINST it (the four were spread over 90 minutes, MUT-19's five runs fitted in 30), and that
argument was worth nothing in both directions: it could neither convict nor acquit.

**The causal test settles in one run what the timeline cannot settle at all.** One
`mut.mjs --only 19`, one re-measure: four became five, at the minute of the run. Attribution, not
inference - and it costs less than the reasoning it replaces.

Then the part that matters more: **the residue was the defect.** The check was doing exactly what a
user does, and the row it left behind was the application's own durable answer to it - a tombstone
for a message no peer had ever received. Writing a teardown would have deleted the evidence of a
live bug and made the instrument permanently blind to that whole class. So the order is fixed: find
out WHY the state is there, and only then decide whether anything should clean it up. A teardown is
correct only for state the check creates that the application would never have created itself.

The corollary for the instrument: a check that can leave the app in a state another instrument reads
as a defect must ASSERT that state itself. MUT-19 now reads the sender's store, because on screen a
dropped row and a tombstone are indistinguishable - the discriminator is at rest, and only a check
that goes to look can carry it.

#### 21. A RULE THE HARNESS WRITES IN PROSE IS A RULE THE HARNESS WILL BREAK - the seam that can refuse is where it belongs

`goto()` had carried **"DO NOT USE ON A1"** in its own doc comment for weeks, with the reason spelt
out. Three call sites did it anyway - `openDM`, `openChannel`, and NOTIF-7 deliberately - because a
comment is read once, by whoever is writing that function, and never again by the caller two files
away.

**What it cost was a defect attributed to the application.** MUT-18 went PASS-DIRTY on A1 with
`Uncaught TypeError: Cannot read properties of undefined (reading 'runCallback')` at `(no url):1:28`,
three times, and it sat in SESSION STATE as *not yet attributed to the harness or to the app*. It is
the harness, and the column number proves it: Tauri delivers every command error and every scalar
response by having Rust EVALUATE `window.__TAURI_INTERNALS__.runCallback(...)` into the page
(`format_raw_js`, tauri 2.11), and character 28 of that string is exactly where `runCallback` is read
off `window.__TAURI_INTERNALS__`. So the object was undefined - the document had been replaced under
an in-flight IPC call, by the harness's own `Page.navigate`. No script URL, because the script was
evaluated from outside the page: the frame said so all along, once `watch.mjs` started printing it.

The fix is not a fourth comment. `goto` now **refuses** A1 unless the caller passes
`{ relaunch: 'why' }`, `openDM` takes the click path there, and the one remaining reload declares
itself in a word that can be grepped. A rule that can be enforced at a seam belongs at that seam;
prose is what you write when it cannot be.

#### 22. A TEST FILE NOBODY EXECUTES READS AS COVERAGE ON EVERY REVIEW - check the file COUNT, not the colour

Sky's `tests/api.test.ts` was neither passing nor failing for months: the vitest `include` only ever
looked under `src/`, so the runner never found it. It had rotted meanwhile - a mock missing an export
the route calls, and an env assignment placed after a hoisted import - so every case would have
answered 500 had it ever run. Nothing announces this. **A green suite says only that the files it
FOUND passed**, and a reviewer reading the tree sees a covered surface.

So whenever a suite lives outside the pattern's roots, or a runner's `include` / `testMatch` is
edited, read the reported file and case COUNT and compare it to what is on disk. The same instrument
answers the general form of the question: a check that never ran and a check that passed are the same
colour, and only the count separates them.

#### 23. CODE THAT LEAVES THIS PROCESS IS DATA WHILE IT IS HERE - and its escapes are read on the way out

Every expression this rig runs in a browser is built as a template literal and handed to CDP as a
string. Node reads the escapes before CDP ever sees it: `\r` leaves as a carriage return, `\s` leaves
as the bare letter `s`. The same is true of a pattern handed to `new RegExp`. **The backslash belongs
to whoever parses the string LAST, and a template literal is not that parser.**

Four sites had it on 2026-08-20, and the pair of failure modes is the whole lesson:

- `chat.mjs`'s `HEADER_NAME` carried `/[\r\n]+/`, which reached the page as a regex literal cut in
  half by a real newline. `evaluate` threw `SyntaxError: Invalid regular expression: missing /` on
  **every** call, so `ensureConversation` - the single thing that names which conversation is open -
  did not run at all. **It was written correctly and halved by an edit AROUND it**: doubled since
  `29ee5d8c`, single from `614bddbd` three hours before it was found, a commit that rewrote `PANE`
  and re-typed the lines beside it. A doubled backslash reads like a typo to whoever touches the
  region next, which is why the rule cannot live in the escaping and has to live in `String.raw`.
- `nav.mjs`, `synopen.mjs` and `comm8.mjs` carried `/\s+/` and `` `\[GRAINE\] seed \S+ ...` ``, which
  reach their parser as `/s+/` and `[GRAINE] seed S+ ...` - valid, sane-looking, and asking a
  different question. SILENT. `comm8`'s reading of "the peer's own device never announced a seed for
  this salon" **could not say yes**, and said no under a recorded verdict.

The silent half is the dangerous one and it is the argument for the fix: `String.raw` forwards the
literal parts verbatim, interpolates `${...}` exactly as before, and makes the shape immune by
construction instead of by vigilance. `rawcheck.mjs` keeps it that way, exits non-zero, and was
validated as a negative control against all four sites before its clean verdict was believed - see
rule 12. It reports only templates that are page-side expressions or go straight into `RegExp`,
because a check that also flags a `\n` in a console banner is a check whose reader learns to skip it.

**The general form outlives this rig:** whenever a string is authored in one language to be parsed by
another - a page-side expression, a regex built from a template, a shell command assembled in Node,
an SQL statement assembled in a shell - name which parser reads it last, and confirm the escapes
survive the trip. Confirm by RUNNING it, not by reading it: all four sites read correctly to four
separate reviews.

#### 24. A SEARCH THAT WALKS OUTWARD FINDS A CONTAINER - bound what it may land on, or it counts the list as an item

COMM-4 counts invitation cards, and a card has no test id: it is found by its description, then by
walking up to the nearest ancestor that also carries THIS run's community name. That ancestor is the
card - for the card the run just produced. For the five cards **previous runs** left in the same
conversation, the nearest ancestor carrying this run's name is the container holding all six, and it
was counted as a second card. Measured on the live screen: six descriptions in the pane, five of them
landing on one shared ancestor, one landing on a real card one level up.

So COMM-4 reported two cards where the store holds one row, on both devices, and had done so on every
run. **The check's own residue is what fed it** - rule 20's other edge: residue does not only make a
check flaky, it can make a check's WAY OF LOOKING wrong in a way an empty venue would never reveal.

The fix is a bound the search can assert: an ancestor is a card only if it holds exactly ONE
description. A container holds six, and says so.

That run's other half is worth the same sentence. The invitee's card counted ZERO because the check
looked for its expected wording, rebuilt by filling `msg_channel_invite_description_by` with the name
in `names.mjs` - which is what the SIDEBAR is searched by, a first name, while the card is worded with
what the profile resolves to. Two different questions, one string, and the answer was "no card". A
rendered message is now matched by its LITERAL parts with anything at the placeholders
(`saysMessage`), which also tells the three invitation wordings apart, and no display name is spelt
in the repository to do it.

**Both faults pointed at the product and neither was in it**, and they hid each other: fixing the
wording turned the invitee's 0 into a 2, which read as a NEW duplication defect rather than as the
container artefact that had been there all along. A count that disagrees with the store is a question
about the instrument first - the store had one row per invitation on both devices, with the
deterministic id and no twin, before any of this was believed.


#### 25. A PREDICATE THAT SAMPLES A MOVING VALUE REPORTS A FRAME, NOT A STATE - ask whether it has settled

`clearOverlays` is the rig's only isolation guarantee, and `enterCommunities` calls it at the START
of every runner. It decided what counted as an overlay by reading `getComputedStyle(el).opacity` and
skipping anything at `0`. A dialog renders at opacity 0 for the first frames of its entry
transition - so a caller arriving inside that window was told **the screen is clean** while a
894x631 modal was opening on top of it. Measured directly: `op:"0"` on one sample, `op:"1"` 300ms
later, same dialog, nothing else changed.

The cost is never paid where it happens. The runner proceeds, and dies several gestures later on
`no stable element` for a composer that is plainly in the DOM, correctly sized and not disabled.
Two checks failed that way on 2026-08-20 and neither error mentioned a dialog.

**The repair is not a wait.** A sleep only makes the sample likelier to land after the fade, which
is the same race with better odds - and it would be a clock standing in for a proof. What was wrong
is that a value still travelling was read as a value that had arrived, so the question asked is now
whether it has settled: an element at opacity 0 counts as present while its OWN transition is still
running. Narrowed to its own animation deliberately - the shared `IS_MOVING_FN` walks ancestors
because its question is "can this be clicked yet", and borrowing it here would let any motion
anywhere above a genuinely hidden element present it as debris to be cleared.

Armed both ways before it was believed: six opens, six caught mid-fade, and an idle page still
reads clean.

#### 26. A PANEL'S LIFETIME BELONGS TO WHOEVER OPENED IT - and a fix aimed at the gesture that failed leaves the class standing

A settings panel is a `position: fixed` backdrop over the whole page. The gestures that act INSIDE
one - `revokeChannelAccess`, `setMemberRole`, `cyclePermissionCell` - deliberately leave it up,
because their callers usually have more to do in there; only `Save` genuinely ends the interaction,
which is why `saveChannelAccess` is the one that clears. That is correct, and it means the
obligation to close lands on the check.

Five of the twelve call sites had quietly dropped it. The comment on `saveChannelAccess` records
this exact aftermath being paid for once already - "COMM-9/10 saved the roster, tried to post, and
died on `no stable element` for a composer that was plainly in the DOM" - and the fix went to the
single gesture that had failed. Its sibling `revokeChannelAccess` needs no save, ends inside the
same panel, and reproduced the same failure in the same check five days later.

**Enumerate the class, not the instance.** The twelve sites were listed and split: seven end in a
save that clears, five did not close at all. `inPanel(cx, open, body)` now opens, runs, and closes in
a `finally`, so a check cannot open a panel without closing it, and a body that throws still hands
the screen back - a check failing inside a panel has a safe verdict, while leaving the panel up takes
the rest of the run down with it.

The other half of the lesson is the report. `whyNotStable` named the blocker
`DIV.fixed z-[280] flex justify-center bg-black/40` - a tag and a truncated class list that identify
nothing - and finding the panel behind it took a hand-driven DOM dig. It now names the covering
dialog by its label, and separately the dialogs open anywhere: "the dialog is over me" and "a dialog
is open somewhere" are two claims, and the second must not be read as the first.
#### 27. A CLICK IS NOT A SELECTION, AND A CHECK THAT SWALLOWS THE GESTURE THAT NAMES ITS SUBJECT WRITES ON A STRANGER

`realClick` proves that a mousedown reached the centre of an element which was there, still, and on
top. Whether the application then did the thing is a SEPARATE FACT, and on 2026-08-20 the two came
apart: COMM-12 clicked a community in the rail, the click did not take, and `openCommunity` reported
it honestly. Everything after that is the lesson.

The check caught the failure in its `step()` wrapper, recorded it, and carried on - which sounds
careful and is the opposite. Every gesture below that line is scoped to "the open community" and
none of them names one, so they all ran against whatever the app still had selected. The arm then set
a Graine **history-visibility rule on a community the check had never heard of**, and reported the
value it read back from its OWN community, which was untouched and therefore still at the default.
Nothing failed. Two unrelated communities on production were left carrying `historyVisibility =
joined`, and the only reason it was found is that the wrong value looked odd in an unrelated query.

Three things were wrong and each is its own rule:

**The wait did not prove what the click needed.** `openCommunity` waited on `text=<name>`, which any
element mentioning the community satisfies - including the line the app logs when it creates one -
then clicked `[aria-label="<name>"]`. A wait must be expressed in the selector the next gesture will
use, or it is a different question answered confidently.

**The proof of a selection is the application's own statement.** The panel header names the open
community, so that is what `provesOpen` polls. A click that lands and a community that opens are now
two assertions instead of one hopeful one.

**A gesture scoped to a subject must refuse to run when nobody named that subject.** Every
community-scoped write in `comm.mjs` reaches the panel through `openCommunitySettings`, so that is
where the gate went: a ledger records which community each client was PROVEN to have open, the header
says which one is open now, and the two must agree. It is emptied by everything that can invalidate
it - a navigation (the app re-selects the first community by itself after a reload, which is exactly
how this stayed invisible), a failed open, a deletion. No call site changed.

And in the check: **the step that establishes the subject of every later step must be fatal.** COMM-12
already returned early when it could not read its community's id; it now does the same when it could
not open it. A swallowed failure is only safe when nothing after it depends on the thing that failed.

**And the same rule reaches a click aimed at COORDINATES, which is where it bit next.** MENTION-1
locates the rendered mention chip - a `<button>` with no hook of its own - by scoping to the bubble
carrying its marker, then clicking the centre of its rect. The helper called
`btn.scrollIntoView({ block: 'center' })` and read `getBoundingClientRect()` on the very next line,
so whenever the pane actually had to scroll - which it does for a message just sent, sitting at the
bottom - the rect described where the chip had BEEN. The click landed on whatever had taken that
place, and the row read `bubbleChipFound: true`, `bubbleChipText: "@<peer>"`, `navigatedPath: null`:
found, correctly named, and clicked somewhere else. It passed whenever the chip happened to need no
scroll, which is what made it an intermittent rather than a failure (x1 green on 2026-08-22, `FAIL`
on the x5 that followed).

A point is now SETTLED before it is used - the same rect twice in a row, which a scroll still in
flight cannot produce - and then CHECKED, `document.elementFromPoint` at that point resolving to the
button itself. Both flags are on the row. A point that never settles makes the verdict `VACUOUS`,
because a check that could not arm its gesture has not measured the product: the distinction the
whole rule exists for.

#### 28. A DEVICE'S BUILD IS PART OF ITS ANSWER, AND A CLASSIFIER MUST NOT EAT THE EVIDENCE IT CLASSIFIES

Two faults, one run, and the run was COMM-25's first.

**The verdict was FAIL and the device could not have passed.** The check asks whether an account's
SECOND device is carried into a private salon by the first one's access. The phone's roster stayed at
one device for the full 90 s, which is exactly the defect the row was written for - except that the
phone serves the bundle inside its APK (`frontendDist` is `../build`, so no deploy reaches it) and the
build it was running, `a232c070`, predates `b9ed05f7` - the commit that gave a private salon a
distribution group of its own. The device has no notion of the group it was being asked to join. The
FAIL was a statement about an APK, wearing the costume of a statement about the product.

This is the standing rule *never learn by failing what a fact could have told you*, applied to a
build. The phone's own `/_app/version.json` is one fetch away and dates it through the same
stamp-to-commit derivation the deployment already used. So `clientBuild(cx)` reads it, COMM-25 arms
only when the phone clears the threshold, and `a1Build` is recorded on **every** row rather than only
on a failure - this is the one check in the phase whose two devices can legitimately be on different
builds, and a reader has to be able to see which. **The threshold is a COMMIT, not a date**: the check
names what introduced the mechanism it measures, and the date is derived from the repository, so it
cannot go on being true after the fact stops being true.

It is read while ARMING, before the salon exists. That is what keeps it compatible with a row whose
whole claim is that no gesture was needed: nothing can be repaired that has not yet been created.

**And the same run printed `0 console lines` for a run that had driven W1 through four navigations.**
`report()` ends by clearing `cx.events`. That is deliberate and correct - a second `report` must cover
only what happened since the first - but it destroyed the RAW log along with the classified one, so
`consoleLines` answered nothing to anybody who asked *after* gating. Every other runner happens to ask
before, which is why this survived twenty runners. `consoleLines` documents itself as "every console
line the page emitted since `watch()`"; it now is that, because `report` archives what it drains.

The general form is worth more than either instance: **a classifier may not consume its input.** The
file already carried the sibling rule - a verdict must never be computed over a projection of its own
evidence - and this is the same sentence one step further on. A projection that destroys the original
makes every later question unanswerable, and the symptom is an empty log rather than a wrong one,
which reads like a quiet run instead of a broken instrument.

#### 40. A LOG CLASSIFIER'S KEY BELONGS TO THE LOG SITE, NOT TO ONE OF ITS CALLERS

**Third time in a row that GRP was stopped by the rig and not by the product, 2026-08-25.** Ten
product rows PASS, and the 5-pass run stopped at pass 1 because `chat-delivery-service` held thirteen
`unexplained` lines. Every one of them was a push that left correctly.

The line is written once, at `messaging.service.ts:490`, and reached by four entry points that each
stamp the trace id after themselves: `send`, its own deferred retry `send-...-def`, a Welcome
`welcome-send`, and a reactivation catch-up `reactivate`. The rule named `send-`. So the SAME
successful push about the SAME device was a known event from one entry point and an unknown line from
three - and which one you got depended on how the group had been built, not on what happened.

**The shape of the mistake is what generalises.** A trace prefix is a fact about the CALLER; the log
line is a fact about the SITE. Keying a rule on the prefix silently narrows it to one path through
the code, and adding a fifth caller then adds a false finding rather than a new line - the rule does
not become wrong, it becomes *partially* wrong, which is worse, because the half that still matches
is the proof a reader uses to believe it. Enumerate the site's callers (`grep` the private method,
not the tag) and key on what they all share.

**A LIVE WINDOW CANNOT SHOW THIS GAP, AND THAT IS WHY THE PIN IS THE FIX.** An entry point nobody
exercised does not appear as a hole; it appears as nothing at all - and the first phase that
exercises it reads as new noise. `srvclassify-selftest.mjs` now pins all four callers of this site,
including the two no phase has produced yet. The same file had ALREADY been given this exact repair
for the sibling rule two hundred lines above, in an edit that missed this one: **a fix keyed on a
shared cause must be applied to every rule sharing it, in the same edit, or the next one is found by
being stopped by it.**

**And the counter-half, which is not symmetry.** The neighbouring `PUSH_DEFERRED` rule is keyed on
`send-` and stays that way: `scheduleDeferredPush` has exactly one caller, so `send-` IS its site's
shape. Widening it would forgive an entry point that cannot exist, which is the mirror error -
a rule that matches too much moves a real signal into a bucket that does not break `clean`. The
number of callers is the whole argument, in both directions, and it is cheap to count.

#### 29. A BLOCKER IS PROVEN AGAINST THE HARNESS, NEVER INFERRED FROM A LOG LINE

COMM-25's third run left the phone saying `[PIN] No device key in vault - auto-login impossible`. I
read that as the end of the road, wrote **"the PIN re-entered ON the phone - a human action no tool
here can answer"** into `CLAUDE.md` and into the board, and committed it. The user's answer was one
sentence: *"Tu as toujours entre le pin, regarde tes scripts."*

`pin.mjs` has entered that PIN since the beginning, on the phone as well as the browsers - it carries
a whole mobile branch for the keypad shape, because `#encryption-pin` does not exist there. Two
paragraphs of this file already said so. Rule 7 lists `install -r` among the transitions that re-lock
the PIN, precisely so the shared layer restores it. `state.mjs` documents its third answer as
*`unknown` means run `pin.mjs`, which is idempotent*, and records the identical incident: A1 read
`unlocked` on `/posts` and `pin.mjs` then found the keypad and typed four digits into it. The claim
was refuted by the repository before it was written.

**The log line was true and the conclusion drawn from it was not.** `No device key in vault` names
what failed - the *auto*-login path - and says nothing whatever about the interactive one the modal
was at that moment offering. Reading a capability as absent because one path to it reported empty is
the same shape as branching on an error message: a fact stated for one purpose, spent on a question it
was never written to answer.

The rule is cheap to apply and there is no excuse for skipping it: **before recording that something
cannot be automated, name the tool that would do it and show it missing.** One `ls` over the harness
answers it. A blocker written without that costs more than a failed run - it retires a capability the
rig has, and every check downstream of it is then owed to a person who was never actually needed. The
same evening it was written, `bun pin.mjs --device A1 --stay` unlocked the phone in 4.2 s and the
run that had been declared impossible produced the phase's first attributable verdict.

#### 30. A GATE THAT REFUSES WITHOUT A REASON TEACHES ITS OPERATOR THE FLAG THAT DISARMS IT

Two things happened within an hour on 2026-08-21 and they are the same mistake seen from both ends.

**First, the gate was skipped.** COMM-22 was owed its eighth attempt, the phone was unauthorised, and
`run.mjs --file comm22.mjs` refuses without A1 - so the check was started as `bun comm22.mjs`
instead, straight past the preflight. The push that deployed a backend fix was minutes old. Prod was
mid-restart, the gateway answered 502 and 503, the community was never created, and the run recorded
VACUOUS with `redeployedMidRun` naming the CD run by id. **The instrument was right and it saved the
verdict** - `gate()` turned a collision into VACUOUS rather than a FAIL naming an innocent product.
But nothing had to be saved: `deploy.mjs`'s wait-for-a-deploy-in-flight lives in the PREFLIGHT, and
running the script directly is exactly how a run gets past it.

**Second, the refusal was unfounded.** `--file` reads the owning phase's `needs`, which is the UNION
over that phase's scripts. COMM-22 is a two-browser check; COMM needs a phone for four OTHER rows.
So the preflight refused a run whose devices were all present and healthy, and the only way past it
was `--no-preflight` - the flag that stops a check being refused against a LOCKED client, which is
the failure mode most of this file exists to prevent. A gate that fires when it should not is not
merely noisy: **it trains the one person who can disable it.**

Both halves are fixed in the declaration rather than in the operator's habits. `checks.mjs` names
which of a phase's scripts need the phone (`PHONE_SCRIPTS`), `--file` narrows to them, and the ninth
run preflighted `W1 W2`, passed, and ran on a prod nothing was deploying to.

The rule generalises past this harness: **when a check refuses, ask whether it refused about the thing
it is guarding.** A gate answering a question adjacent to its own - "does this PHASE need a phone"
standing in for "does this SCRIPT need one" - is a false positive, and a false positive on a gate is
spent by removing the gate. And when a run must bypass one, the bypass is the finding: name what the
gate would have checked, and check it by hand in the same breath.

#### 31. A CONSTANT IN A CHECK'S PAYLOAD IS A COMMENT WEARING A DATA FIELD'S CLOTHES

Reading MUT's evidence stream after a clean x5 turned up three fields, in one runner, all asserting
things about the product that had stopped being true - each one a literal in the source rather than
something the run measured.

- **MUT-10 emitted `architecturalGapFound: true`** with a paragraph describing `delete_message` and
  `edit_message` applying unconditionally on receipt. That hole was real, and it was closed on
  2026-08-12 by `mutationIsAuthorised`, with seven cases pinning it. The check went on reporting it
  for ten days, on every pass, as a finding.
- **MUT-18's `note` explained its own verdict by that same missing guard.** Its verdict was right and
  its reasoning was a decade of git history out of date: both edits are admitted because the two
  devices share the ACCOUNT, not because nothing checks.
- **MUT-21's `filedAs` named a `backlog.md` entry** that was deleted the day the defect shipped
  fixed - the pointer dangled while the field kept claiming a filing.

Nothing failed. Every one of the three was carried by a `PASS`, which is exactly why they survived:
**a green tally is not read for accuracy, only for colour.** And the shape is the one this file keeps
meeting from other directions - a column that answers the question it was written for and not the one
it is now asked, a predicate that named the last incident. Here it is the cheapest version of it: a
value with no mechanism behind it cannot be wrong at the moment it runs, because it never runs.

So: **a field in a payload is a measurement, or it is not a field.** If a check has something to say
about the product that it did not measure, that belongs in the comment above it, in `CHANGELOG.md`,
or on the wiki page that owns the mechanism - all three of which a reader knows to date. And a
finding a check reports must be re-derived by the check, or deleted from it the day it is fixed.

#### 32. PUT ONLY THE THING YOU ARE COMPARING INSIDE THE CONCURRENCY WINDOW

MUT-18 crosses two edits of one message from two devices of one account. It did it by starting a
whole desktop edit and a whole mobile edit together and awaiting both. Those are not the same length:
the desktop path is a hover and a click; the mobile path is a 700 ms press, a sheet that animates up
from the bottom, and a tap on it. So W1 COMMITTED while A1 was still walking its sheet, W1's edit
reached A1 in six milliseconds, the row re-rendered, and the sheet closed under A1's own tap.

It passed five times and failed the sixth. **The five passes were the same defect as the failure** -
the window happened to close in the tolerable order. A check whose result depends on which of two
unequal paths finishes first is not measuring concurrency, it is sampling a scheduler.

The fix is not a longer timeout and not a retry. Both devices are ARMED first - form open, replacement
typed, nothing sent - one after the other, order and duration irrelevant because no event has left
either device. Then the two COMMITS are released together. What is inside the window is now exactly
what the verdict talks about, and the convergence figure changed from 4-76 ms to 232-467 ms because
the earlier number was measuring a crossing that had largely already happened.

**And the verdict was wrong in the other direction too.** A1's sheet closing under its own tap was
scored `FAIL` - the product named for a gesture that never landed. Arming is a PRECONDITION, so a
device that could not be armed has not disagreed with anything: that is `VACUOUS`. This file already
says a PASSING check that never armed its precondition measures nothing; the failing direction is the
same statement and is easier to miss, because a `FAIL` looks like the check working.

Generally: **name the two things you claim happen at once, and check that setup for neither of them is
in the window.** Where the two paths cost different amounts to reach the starting line, the cheap one
finishes the whole race while the expensive one is still walking to it.

#### 33. A RUN IS INVALIDATED BY A CHANGE TO ANYTHING IT CONSULTS, NOT ONLY TO THE FILE WHOSE SHA IT RECORDS

`checkSha` is the sha256 of the runner, and it is the campaign's whole answer to "which code produced
this verdict". It covers one file. A verdict also depends on `chat.mjs`, on `watch.mjs`'s classifier,
on `checks.mjs`'s declarations - none of which move it.

Met twice in one session, in both directions:

- **The gap hiding a fix.** `mut.mjs`'s sha did not change when `chat.mjs`'s `openDM` was fixed, so a
  verdict produced by the repaired code was recorded under the sha of the run that had failed.
- **The gap corrupting a measurement.** A `NOTABLE` rule was added to `watch.mjs` DURING an x5, to
  classify a line the run itself had just produced. Each check is a separate process, so passes 1-2
  judged `clean` by the old rules and 3-5 would have judged it by the new ones. The tally would have
  mixed `PASS` and `PASS-DIRTY` for a reason that had nothing to do with the product, and the board
  cell built on it would have been wrong with nothing to show it. The run was killed and restarted.

The operational rule is the cheap half and it is absolute: **while a repeated run is in flight, the
rig is frozen.** Not the product - prod is the test server and a deploy mid-run is a known, detected
condition - the RIG. If a classification is owed to a line the run just produced, that is a finding to
write down and apply to the NEXT run, never to this one.

The deeper half is unresolved and stated so it is not mistaken for solved: a verdict names one file's
sha while depending on several. Hashing the whole directory would move every sha on every edit and
make the field useless; hashing the import graph is the honest fix and nothing does it. Until then,
**a verdict's runner sha is a necessary condition for believing it, never a sufficient one**, and a
board row whose phase was touched anywhere gets re-run rather than reasoned about.

#### 34. THE RIG'S OWN HOST IS PART OF THE SYSTEM UNDER TEST, AND AN INTERMITTENT MUST BE CLEARED OF IT FIRST

Two Chrome profiles, a phone over `adb` and the driver all run on ONE laptop, which also runs the
greps, the `ssh` queries and a pre-commit hook that sweeps the whole frontend for two to three
minutes. A check that measures latency measures that machine too.

MUT-12's channel leg is the case. It missed three times, and the miss looked exactly like a product
defect: the peer never saw the message. The production log said otherwise - the server had it two
seconds before the check gave up, and the send itself took 600 ms. The 21 seconds in front of it were
the SENDER's client making no server call at all, after `sendText` had already returned on the
optimistic bubble. A real stall and a saturated host produce that identical shape.

What settled the balance was not an argument, it was a control: **eight consecutive passes with the
box deliberately quiet.** Both failures had fallen in stretches where the box was busy. That is not
proof and no defect was filed on it - but it is the difference between an unattributed intermittent
and one that has been cleared of the cheapest explanation before the expensive one is investigated.

Two things follow, and the second is the reusable half:

- **Reproduce an intermittent under a QUIET host before believing it.** The control costs one loop
  and it is the only way to tell a measurement of the product from a measurement of the laptop.
**UPDATED 2026-08-22, and the update weakens the host explanation.** SEARCH-2 produced the same
signature during rung 5 - a marker absent from pane and body, `fromBottomPx: 0`, one pass in five.
That makes four sightings across two independent checks, and **every one of them is on the CHANNEL
transport**. No DM check has ever produced it, and the DM checks vastly outnumber the channel ones,
so the absence there is not for want of looking. Host contention is transport-agnostic: it would stall
a DM send as readily as a channel send. So the quiet-host control still stands as the reason no defect
was filed on one sighting, and the transport pattern is now the stronger lead. What it is owed is the
discriminator below, which currently exists only in MUT - see the shared-helper item in
[backlog](backlog.md).

- **Carry the discriminator in the evidence, so the next occurrence settles itself.** A hole is made
  of absent lines, so no classifier bucket shows it; `longestSilence` turns it into a value and it
  was already computed for every client on every check and thrown away everywhere but MSG-10. MUT's
  `finish()` now attaches it to any non-PASS verdict, per client. **A hole in EVERY client at once is
  the host freezing; a hole in only one client's timeline is that client.** Same run, same payload,
  and nobody has to go back to the production log by hand a day later.

#### 38. A THROW IS NOT A VERDICT - a precondition that did not hold is a FAIL WITH EVIDENCE

`grp3` and `grp8` both established the same precondition - the peer is in the roster - and both
enforced it the same way:

```js
const peerId = both.removableIds.find((id) => !ownerIds.includes(id)) ?? null;
if (!peerId) throw new Error('grp3: could not identify the peer among the removable ids');
```

The throw looks like rigour and is the opposite of it. `removableIds` is built from the panel's
`Retirer <id>` controls, so an id exists only once the peer is a MEMBER; an invitation still in
flight renders `Invitation en cours...` and no control at all. "No id outside the owner's" therefore
means one of exactly two things and **both are findings about the product** - the Add did not land,
or it landed and the roster has not rendered it.

Telling those apart needs the two clients' consoles, and the throw is precisely what never gets
them: it skips `recordObserved`, which is the only thing that drains the observers into the row.
GRP-8 pass 2 of 2026-08-25 threw `round 2 could not identify the peer after the add` and left a
**five-line log** - the verdict tail and nothing else. The check had to be re-run by hand to read
what it had already seen once, which is the exact loss the runner's whole-output write exists to
prevent, reintroduced one layer above it.

- **A failed precondition is recorded, not raised.** `identifyPeer` returns null, prints the roster
  count it read, and the caller records a `FAIL` through `recordObserved` so both consoles land in
  the row. The assertion is untouched - GRP-8's already required `afterAdd === 2`.
- **Capture the discriminator while it is still readable.** `invitationPending` can only be read with
  the panel open, and every caller closes its overlays on the way to recording, so the helper reads
  it at the seam rather than leaving the caller to remember.
- **An early exit must be visible in the assertion.** GRP-8's loop now `break`s instead of throwing,
  so `rounds.length === 2` had to join the conjunction: a loop that ended after one round would
  otherwise have satisfied `rounds.every(...)` vacuously and passed.
- **Member rows are never printed.** They are display names of real production accounts and this
  repository is public. The count and the pending flag carry the diagnosis without them.

The general form: a check may only raise for something that makes the QUESTION unaskable - a client
that will not attach, a selector the product no longer has. Anything the product could plausibly have
done, however wrong, is a verdict, and a verdict has to carry its evidence.

#### 39. LOOK AT THE CLIENT BEFORE READING THE RIG - and a stuck web client is RELOADED, not diagnosed

**Measured 2026-08-25, and the cost was paid in tool calls rather than in a wrong verdict.** The
preflight refused to start GRP with `W1: still LOCKED+overlay on /settings after 4 repair(s)`. What
was actually on screen: the device-management modal, left open by a human who had just deleted two
devices through the product. Two facts settled it, and neither needed a hypothesis - the page's own
`innerText`, and a screenshot.

`shot.mjs` exists for exactly this, and its first line says so: *"Saves a PNG screenshot of a client,
so a layout claim is looked at rather than inferred."* It was not run. Instead the diagnosis went
through the rig's source - seven files, four greps - to arrive at what one look would have given in
one call.

**So the order is fixed:**

1. **Look at the client.** `bun state.mjs` for the four-field health read, `bun shot.mjs <port>` for
   the screen. A claim about what a client is doing is checked against the client, never against the
   code that describes it.
2. **Then reload it.** A web client in an unexpected state is not a puzzle to solve: a reload is
   idempotent, and it erases the leftover modal, the wrong route and the stale bundle in one action
   instead of three conditional repairs. **This is what the preflight should do by default** rather
   than repairing what it finds - see the entry in [backlog](backlog.md).
3. **Only then read the rig.** If the client is healthy and the rig still refuses, the fault is in the
   rig - and that is the ONE case where its source is the right place to look.

**The phone is excluded from step 2, by construction.** `goto` on A1 reloads the Tauri webview, which
re-locks the PIN and breaks Tauri's IPC callbacks into the old document; `chat.mjs` throws rather than
let a caller do it by accident. A1 keeps the repair path.

**And a reload must SAY what it erased.** The preflight's repairs are loud on purpose - *"the day it
is something else, the line is the only warning"* - so an unconditional reload that printed nothing
would delete the only evidence of what the previous check left behind. Read the state, log it, then
reload.

**The general form, and the reason it belongs in a methodology page rather than in a habit:**
speculating about a live system is not merely less reliable than looking at it, it is usually SLOWER.
The rig has a probe for every question it can be asked. Using one costs a single call; reasoning
about which of seven copies of a predicate might be wrong cost a dozen.

## Observation is part of the check, not a debugging step

Decided 2026-08-06, after two shipped bugs came out of the logs of **passing** checks.

A check that only asserts its own outcome answers "did the message arrive", never "did it arrive for
the right reasons" - and a pass sitting on a swallowed exception, an unread 4xx, a request that
should not have been made, or a reconnect mid-measurement is worth nothing.

`watch.mjs` therefore attaches to every client for the duration of every check and sorts what it saw
into buckets, reported next to the verdict:

| Bucket | Meaning |
| --- | --- |
| `errors` / `exceptions` / `badHttp` / `wsEvents` | anything here makes the run **not clean**, whatever the assertion said |
| `notable` | not an error, but it happened: `SecretReuse`, `out of bounds`, `Duplicate`, `silent ACK`, `epoch`, `GAP`, `out-of-sync`, `welcome_request`, `forget`, `revoke` |
| `stateChanges` | the client changed under the check's feet - gateway reconnect, token refresh, session change. Explains a latency or a retry that would otherwise look like a result |
| `unexplained` | everything not on the known-benign list, **verbatim** |

A verdict is `PASS` only when the assertions hold **and** the run is clean; otherwise
`PASS-WITH-NOISE`, which is a result that still needs reading.

**A line that turns out to be routine is ADDED to the benign list, never ignored in place.** That is
the whole mechanism: the `unexplained` bucket only keeps its value if it shrinks by decision.

**AND A RECORD THAT SAYS `clean: false` MUST SAY WHY, IN THE SAME ROW.** MSG-10 reported a dirty
sender on 2026-08-14 with `senderSevere: []` and `senderErrors: []` printed beside it, because the
two buckets that check happened to keep were not the two that had broken its verdict. The only way to
learn what it saw was to run it again - and it came back clean, so the cause is now unattributable
and stays that way. **A result you cannot read is a result you cannot believe, and a re-run is not a
recovery: it destroys the evidence it was meant to recover.** Each check listing buckets by hand is
how they drift apart from the definition of `clean`, so they are listed once, next to it: `dirtOf()`
returns every clean-breaking bucket that is non-empty, and checks record that.

#### 42. A CLASSIFIER AND ITS FIXTURES SPEAK A DIALECT THE SERVER CAN LEAVE, AND A COUNT-BASED RULE LEAVES NOTHING BEHIND TO SEE IT

The COMM-8 fix added `base=<n> active=<n>` to three server lines. Four of `srvlog.mjs`'s BENIGN rules
and one count-based predicate were anchored on the fields either side of the new pair, so all five
stopped matching the moment it appeared: every seed read in the estate landed in `unexplained`, no
server window was ever clean, and `--repeat` could not reach pass 2 on any phase. A stale classifier
stopped the campaign, and no product defect was involved.

Two things kept it invisible. The self-test was green because its fixtures were copied verbatim from
production in August and never refreshed when the server moved - a fixture is a RECORDING, and it
ages exactly as fast as the code that produced it. And the predicate counted matches rather than
judging lines, so its failure produced a number that was merely wrong instead of a population a
reader could look at. **Prefer a rule whose failure leaves its subjects visible under their own
name.** Where a rule must be widened past a field, widen it by READING that field - `base=(\d+)
active=\1` forgives equality with a backreference and cannot match the stale-base condition it was
widened past, so it can never launder the defect. Disjoint spellings get disjoint branches
(`base=none` for an unpublished base), not one loose pattern.

And two rules for one log line, 140 lines apart, go stale together while giving no reason to look for
each other. One line, one rule, carrying every spelling.

### Classify the SITE, not the line - a run finds spellings ONE AT A TIME

Written 2026-08-25, out of GRP x5. Three of its five passes came back `PASS-DIRTY`, on three
different rows, for three different lines - and all three were the SAME log site saying the same
thing in a spelling the classifier had not met: pass 2 the pending sweep's `local conversation not
ready`, pass 3 its `lock held by another device - skip`, pass 5 the welcome buffer's `Buffering
message for group X`. Each cost a dirty verdict, an investigation and an edit to `watch.mjs`.

**And each edit landed MID-RUN, which disqualifies the run that produced it.** Passes measured
against different rule sets are not five passes of one check; the instrument changed between them, so
the five together cannot support "clean 5/5" however many of them were clean. That is the real cost,
and it is paid once per spelling.

So when a line lands in `unexplained`, the unit of work is its SITE, never the line:

1. **Enumerate every log call under that tag, in the file, in one pass** - `[PENDING]` was 19 calls,
   `[QUEUE]` 23. Read the templates exactly, including the ones built from a `reason` or `trigger`
   variable, and enumerate that variable's values from its type or its call sites rather than
   writing `\S+` and hoping. `UnackedReason` has exactly two members; the rule names both, so a
   third one appearing lands in `unexplained` where it belongs.
2. **Measure where each spelling ALREADY lands** - a throwaway probe reusing `classify-selftest`'s
   `cxOf` shape, printing the buckets for every line. Never assume: half of `[QUEUE]` was already
   classified by generic rules, one of them by accident of a word (`socket closed, the reconnect
   pull covers it` reached `stateChanges` because it says "reconnect").
3. **Pin every spelling in `classify-selftest.mjs`**, including the ones already correct. The rule
   that classifies them today is not the rule that will exist after the next widening.
4. **Name the ones left deliberately ruleless, and why**, in the block itself - the `console.error`
   siblings that must keep breaking `clean`, the fallback whose whole meaning is that the primary
   path failed. A reader who cannot tell "not yet classified" from "classified as a finding" will
   eventually classify it.

**And check the LEVEL the app writes it at.** `console.warn` has its own bucket, reported but
non-breaking by design, so a line that names a defect and is written at `warn` is silent until a
`SEVERE` rule claims it. `[QUEUE] endBulkIngest without a matching beginBulkIngest - ignored` sat
there: an unpaired close means an observer's window shut against a phase it did not open, which the
code's own comment describes as stranding the message pipeline for the rest of the session.

### AND IT APPLIES TO EVERY CHECK OF EVERY PHASE - which was measured, and was not true

Set by the user on 2026-08-16, after `NOTIF-10` reported `PASS` over a phone that had been raising
generic "Nouveau message de X" notifications: *"il faut que dans TOUTES les phases de TOUTE la
campagne, il faut que tout soit mesure ... nous devons etre extremement precis et TOUT verifier."*

The rule above was already written, and the harness was audited against it the same day rather than
assumed to follow it. It did not. **Twelve phases, three different behaviours:**

| | Phases | What actually happened |
| --- | --- | --- |
| Observed **and** gated | MSG (11 scripts), TYPE, READ, MUT, FWD-3/4/5 | the bar, enforced |
| Recorded, never gated | FWD-1/2, TAB-4, TAB-5, HEAL-W2, **SEARCH (6 checks)**, **MENTION (6 checks)** | the report printed **under** the verdict, where it could be read but never contradict it |
| Recorded **nothing at all** | NOTIF, NOTIF7, FWD-5, LIFE, TAB-2/3/6, HEAL, HEAL-A1, HEAL-WEB, GRP | a verdict computed, printed as JSON, and absent from `results.ndjson` - so `run.mjs` printed `done` |

SEARCH, MENTION and GRP - the three phases queued to run next - had **no observer at all**:
`watch = 0`, `report = 0`. Twelve verdicts between them, resting on nobody looking. That is the exact
fault READ shipped eight passes on, and `mut.mjs` was rewritten for, reappearing in the phases nobody
had rewritten yet.

**THE REPAIR IS NOT THIS PARAGRAPH.** A rule saying "gate every check" is the rule that was already
stated at the top of this section, and it was forgotten in seven scripts by authors who had read it.
An omission of MEMORY is not fixed by a second thing to remember - the same reasoning `results.mjs`
already carries for the exit code. So the refusal lives in the two places that cannot be bypassed:

- **`record()` demotes a `PASS` that carries no gated report to `UNOBSERVED`.** `gate()` is the only
  producer of `clean`, so its presence in the detail IS the proof an observation happened. A check
  that genuinely cannot observe must say so as a written sentence (`unobservable: '<why>'`), which is
  a decision in the record rather than an absence in it. `UNOBSERVED` is deliberately distinct from
  `PASS-DIRTY`: "nobody looked" and "someone looked and it was dirty" send their reader to different
  places, and both exit non-zero through the `beforeExit` derivation that already existed.
- **`run.mjs` counts the rows each job wrote and reports a job that exited 0 having written none.**
  `results.mjs` can only see the rows a process wrote, never the rows it owed; the runner is the only
  observer that knows a script was supposed to speak. A silent job now counts against the pass,
  because a phase claiming coverage its record cannot support is the same debt as a dirty window.

**The three surfaces were at three different levels of rigour, and the phone was the lowest.** The
server has a full classifier with a per-rule self-test; the web has `report()`'s buckets; the phone
had a **keyword grep** - `/\bE\b|FATAL|Exception|...|fail|error/i` over raw logcat. Measured against a
real 2 627-line capture, that predicate marks 43 lines that are not Canari's at all: 39 from the
WebView's own Chrome-Sync subsystem, and four `Could not create Worker com.linkedin.android...` from
**a different application on the device**. Gating on it would have made the phone permanently dirty,
which is dirt nobody reads. The phone's own native tags are a small, structured population - 25
distinct shapes across the captures, all `D/` or `I/` - so it is classifiable exactly like the other
two, with everything foreign COUNTED rather than judged. See {@link watch.mjs}'s `logcatReport`.

### The bar is "expected", not "no failure" - and it applies to the server too

Set by the user on 2026-08-13, and it raises everything above: *"je veux que tout soit explique et que
le comportement, y compris dans les logs web, mobile, et serveur, soit completement normaux et
attendus. Limite tu devrais savoir exactement avant de le voir. Nous devons etre intransigeants."*

So the discipline is **predict, then read**: say what the log should contain BEFORE the run, and
afterwards account for every line that is not on that list. Each one is either understood and written
down as benign *with its reason*, or it is a finding. There is no third bucket. "Pre-existing",
"benign", "probably the IPC warming up" are not explanations - they are the places where an
explanation is owed, and each one is a mechanism nobody has looked at yet. The server's logs are in
scope exactly like the two clients': a check that reads only what the UI printed has observed one
third of the system.

**The server observer now meets that bar and is tested like the other two.** `srvlog.mjs` classifies
every application container's `docker logs` over a run's own window into the same buckets, `run.mjs`
calls it at the end of every pass so the bar is not enforced by somebody remembering to type a
command, and `bun srvlog.mjs --since <t> --shapes` collapses `unexplained` and `notable` to distinct
sentences for triage. Its buckets have one addition the client's classifier does not need:
`expectedErrors`, for errors that are real, named and not defects - `WebSocket protocol error:
Connection reset without closing handshake` is the gateway describing a *client* that vanished
without a close frame, which every reload this campaign performs produces. Forgiven from the gate,
kept in the record, per rule 10.

The first fully classified window, 2026-08-14 12:22-12:45Z: **8 534 lines across seven services, zero
unexplained**, five notable shapes. Two of those five were open questions rather than noise -
`FALLBACK_MEMBERS_CACHE` fired on **279 of 279 sends**, and five `NO_PEER_ONLINE` history asks were
requests for repair that nobody could answer.

**The first of the two turned out to be a defect, and refusing to file it as routine is the whole
reason it was ever read.** It was kept out of `BENIGN` on the grounds that a 100 % rate may be the
design but nobody had said so; it was not. No caller has ever populated `recipients`, so the branch
calling itself a Redis cache miss was the only path a proto send has, for a cache `sendMessage`
never reads - and the fixture in `messaging.durability.spec.ts` was supplying recipients through
that same dead field, so five green assertions measured a branch production never takes. The
narrative is on [chat-delivery](services/chat-delivery.md); what generalises is the rule: **a rate
is a measurement against a population, and a name is not evidence.** Its replacement,
`MEMBERS_CACHE_REPAIRED`, is matched by no rule at all, on purpose - a defect report a bucket
forgives is one nobody reads.

`call-service` deserves its own note: **0 lines
in 24 hours**, its last entry the startup line from two days earlier - so the CALL phase, when it is
written, will have no server-side observer at all until that service logs something.

**DECIDED 2026-08-18 (the user): `call-service` gets that logging BEFORE the twenty CALL scripts are
written** - invite, answer, ICE candidate exchange, hangup, duration. The argument is the paragraph
above it: a call has two halves and each client sees only its own, so a failed call is exactly the
shape of result nothing on either side can attribute. The same reasoning found the silent channel
push 404s, which had been failing on every channel message and which no client-side observation
could have surfaced. **Twenty scripts standing on no observer would produce twenty results none of
which could be believed**, which is not a cheaper campaign, it is a longer one.

Two rate rules follow. **A claim about frequency needs a denominator** - "it fires on every launch"
is a measurement (N cold starts, N observations), never an impression from one occurrence. And **a
measurement taken on a locked client measures nothing**: entering the PIN is part of starting a
client, not a step before the interesting part, because MLS does no work at all until it is unlocked.
The app's side of that contract is a property worth asserting rather than assuming: **it must not
attempt MLS work before a PIN has been entered** (a stored PIN or biometrics count as entered), so
MLS activity observed before the unlock is a defect, not a timing quirk.

#### Three classifier faults, and why each was a near-miss on an existing rule

Taken from the MSG run of 2026-08-14 17:17-17:38Z, where they were the only dirt. None was an
application fault, and none was a *missing category* - each was a rule that already existed failing
to recognise a member of the population it was written for. That is the shape to expect: **three of
the last four classifier additions were near-misses on an existing rule, not new categories.**

- **A 200 called a failure.** `badHttp` decided on CDP's `r.failed` BEFORE consulting the status, so
  a response that arrived with a 200 and whose body load was then cancelled was filed as a failure -
  breaking `clean` and taking the run's exit code with it. **A status code is an ANSWER**: a request
  that got one is judged on it, and only a request that got none is a transport failure. `watch.mjs`
  now says so, with four HTTP cases in `classify-selftest.mjs` pinning it, including that a 502 on
  the same endpoint still breaks `clean`.
- **A report missed by a space.** The hourly `[CRON] reportQueueDepth:` is camelCase, and the rule
  spelt it `queue depth|QUEUE_DEPTH`, matching neither form - so the one line that reports the
  fleet's delivery backlog landed in `unexplained` once an hour. A matcher tests one SPELLING
  (rule 6); a rule naming a log line must be written against the line, not against its subject.
- **A crawler's `[404] GET /sitemap.xml.gz`**, the same family as the `/sitemap_index.xml` guess
  already classified. Spelt out per path deliberately, with an assertion that a 404 on a route we DO
  serve stays unexplained - an allowlist of what may be forgiven, never a pattern for what to ignore.

#### A hand-run instrument reproduces the automated one only with the automated one's arguments

Found 2026-08-25, chasing a contradiction that did not exist - and worth the chase, because two
instruments disagreeing about one line would make every `server clean` on the board suspect. GRP
pass 3 reported the server clean; `bun srvlog.mjs --since <that pass's window>`, run by hand
afterwards over the same window, reported two `unexplained` lines timestamped inside it.

Neither was wrong. `run.mjs` calls `srvReport(window, { subjects: [...SUBJECTS] })`, and
`isThirdParty` opens with `if (!subjects.length) return false` - so the two `No push token for
user=<a user the run does not drive>` lines the pass had correctly filed as `third-party` had nowhere
to go but `unexplained` for a CLI invocation that named no subjects.

**The difference is invisible in the output.** Both reports print the same bucket names, and neither
states the subject list it was given, so the hand-run copy reads as a stricter second opinion when it
is in fact a differently-configured one. The pass's own summary already carried the answer -
`third-party=30`, printed at the time - and the general rule is the one the campaign keeps
re-learning in new clothes: **a number is only evidence for the question its instrument was
configured to ask.** Re-run a window with the subjects that pass had, or read the pass's line.

---

## Reconciliation: the only way a silent loss can be seen

A silent loss leaves no mark anywhere a **single** client can look. The sender keeps its optimistic
echo, the server answered `201`, and the receiver simply never had the row - so both UIs are
self-consistent and both are wrong about the conversation. The only evidence is a **set difference**
between two clients' view of one thread.

Every campaign message therefore carries a unique `PREFIX-<base36>` marker: DOM rows have no id, but
the text does, and the marker embeds its own send time.

Getting this measurement right took two corrections, and **the first version of it stated a
conclusion that was wrong**. Both are recorded because either one silently produces an
authoritative-looking diff made of noise:

- **The list is VIRTUALISED.** `innerText` holds only the rows currently rendered, so scrolling to
  the top and reading once returns the oldest screenful and drops everything between. The first run
  did exactly that and reported two messages permanently lost. They were not - the peer had both.
  The collector now reads at every scroll position and accumulates.
- **The two windows do not coincide, and deriving the bound from the data does not fix it.** Each
  side loads whatever its scrolling reached, so a marker absent from one list may simply be older
  than that side went. Bounding to "the newer of the two oldest markers" still makes the answer
  depend on how far each run happened to get - **two consecutive runs disagreed**, one calling a
  dozen messages lost that the other reconciled. The window is FIXED (`RECON_WINDOW_MIN`, 90 min by
  default) and each side must hold at least one marker OLDER than it, which is the only evidence it
  covered the range. A diff reported without `covered` **and** `trustworthy` is not a result.

**A diff between unequal windows looks authoritative and is noise.** No per-check verdict substitutes
for reconciliation: it is what found WP-LOSS-1 and WP-ECHO-1, and both were invisible to every check
that was passing at the time.

Both corrections above became moot on 2026-08-11, when the collector moved from the rendered pane to
the STORE - a window onto the history is not the history, and on the test DM the pane read 60 rows
of 1 804 and called the empty difference a success. The store answers the same question in one read,
for a conversation of any length.

### The phone was outside it until 2026-08-15, and the fix was choosing the right route

`recon.mjs` reconciled WEB clients only, and said so - a native client keeps its messages in SQLite
behind Tauri, while the `CanariDB_*` IndexedDB it also carries is a permanently empty vestige. **That
left the device most likely to lose a message as the one device the loss instrument could not see**:
the phone is the one that backgrounds, takes pushes, and pays 1.5 s per checkpoint.

Two obvious routes were rejected for stated reasons, and the reason is the transferable part:

- **`adb pull` the database.** It works. `canari_<uid>.db` is 2.4 MB of a REAL account's
  conversations, including people who never agreed to be in a test harness, so copying it to the
  host is the credential leak `mlsdb.mjs` refuses in its own header - a debugging motive does not
  change what the bytes are.
- **Query it in place with `sqlite3`.** There is no `sqlite3` binary reachable under
  `run-as fr.emse.canari`.

**So ask the application, which already holds the file open.** `@tauri-apps/plugin-sql` exposes
`plugin:sql|select` over IPC, and IPC is callable from CDP - so the query runs on the device and
**only ids and counts come back**. `cipher_text` is never named in it. The database is keyed
`sqlite:canari_<userId>.db` and the id is taken from the page's own `mls_send_ledger_<userId>` key,
so no account identifier is typed on a command line or committed. The RUNTIME picks the reader, not
the port or the label, so a client moved to another port cannot silently take the wrong one.

First run: **RECONCILED across all nine shared conversations, id by id, `onlyW1: 0` and `onlyA1: 0`
everywhere**, including the 4 282-message DM, and no one-sided conversation at all.

The general lesson is not about SQLite. **When the data cannot be moved and cannot be read in place,
the process that already has it open is the third option**, and it is usually the one that also
happens to be the only privacy-preserving one.

---

## Reading a repair on the wire

The repair mechanism is **invisible to the network panel**: the diff travels as encrypted MLS
application frames, so the server sees one HTTP call and nothing else. The whole negotiation is
observable only in the CONSOLE. The design is in
[chat > pooling history between devices](frontend/modules/chat.md); this is the map from that design
to what a run can grep.

The only server-visible seam is `POST /api/mls/history-request` (`messaging.controller.ts`), which
elects one online member and relays, logging `FORWARDED target=…` or `NO_PEER_ONLINE`.

| Console prefix | Emitted by | What it tells a check |
| --- | --- | --- |
| `[HISTORY_REQ]` | requester + responder | the whole negotiation, both ends |
| `[HISTORY_DIGEST]` | requester broadcast, responder receipt | leg 2 arrived, and in which mode |
| `[HISTORY_PULL]` | responder -> requester | the REVERSE direction (the requester holds more) |
| `[HISTORY_BUNDLE]` | responder | what was actually shipped, filtered by id |
| `[MLS]` | `setupMessageHandler` | the escalation from a decrypt failure into the diff |

Four lines decide a verdict, and each says something different:

- `…: N to send, M to pull (identical stores)` - **the diff RAN**. This is the success line.
- `no digest from <identity> … - sending the whole store` - **the fallback fired.** Not a failure,
  but the run did not test what it meant to: the `HISTORY_DIGEST_GRACE_MS` rendezvous lost, so this
  is the old full dump wearing the new mechanism's name. Re-run it.
- `store unreadable - staying silent so another member answers` and `nothing to add and we are
  awaiting history too - staying silent` - a **deliberate** silence.

That last one carries a rule of its own: **a responder that stays silent looks exactly like a
responder that never got the request**, so a check asserting "no repair happened" must read the
responder's console too, never only the requester's.

Two further facts a HEAL verdict depends on:

- **The digest logs its MODE, and the mode is part of the verdict.** `ids, N id(s)` is an exact diff;
  `range, N slice(s) at depth D` is the size fallback, which resolves to a slice of the **id space**.
  A run reporting `range` exercised a different code path from one reporting `ids` - say which.
- **A responder is elected at RANDOM** among all online devices except the requester's own
  (`messaging.service.ts`), so every run must record **which device answered**. Two runs of one check
  can exercise two code paths on two machines, and the greener verdict is the one that says less.

Since there is now exactly one repair, any repair observed **is** the diff. What replaces the old
"which mechanism was that" question is a quantitative one every HEAL check must answer instead:
**how much traffic did the repair cost?** The deleted rung was a broadcast (~450 frames/min for over
ten minutes, repairing nothing), so a run whose frame rate does not fall back to the ordinary send
rate has found something.

---

## Environment traps that read as application bugs

These are not faults of judgement - they are platform behaviours that will be mistaken for defects
by anyone who has not met them.

- **A DUMP IS NOT A SCREEN, AND EVERY NOTIFICATION CHECK HERE READ THE DUMP.** They match on `full`,
  the whole `NotificationRecord` block, so `android.text` holding the right string satisfies all of
  them. On 2026-09-06 a Mi 9T drew a Canari notification as a sender's name with nothing under it
  while that same record carried the decrypted message - and NOTIF-1b had just passed its
  `itCarriedTheMessageAndNotJustASenderName` clause on exactly that. `GENERIC_BODIES` could not help:
  the body was not generic, it was invisible. The cause is mechanical (`InboxStyle` with zero lines
  renders `textLines`, never `contentText`) and so is the test - `phone.bodyIsDrawn` reads the
  template out of the same dump, and `drawnHits` is what a preview clause must now count. **The two
  counts are kept apart deliberately: hits without drawn hits IS the finding.** What found it was
  looking at the shade, which no amount of parsing would have done.

- **A COLD START IS NOT A STEADY STATE, AND A ROW ABOUT A BACKGROUNDED APP MUST PROVE ONE.** Straight
  after an `install -r`, NOTIF-1b sent its marker while the app was still draining fifty pending
  invitations; the frame never reached the JS layer, the ten-second push backstop delivered at 29 s,
  and the row reported `itBeatTheDeferredPushWindow` unmet - accusing a notification path that had
  not been asked yet. The same row had passed in 2190 ms an hour earlier on a warm app. **The fix is
  not a sleep**, which is a guess about one handset that stops being true on the next: a warm-up
  message received in the FOREGROUND is the app demonstrating that its socket is up and routing, and
  it exercises the very path under test. Its clause is named
  `theAppWasRoutingBeforeItWasHidden` so a reader can tell a rig precondition from a product verdict.

- **MIUI CUTS A BACKGROUNDED APP'S NETWORK OUTRIGHT, AND EVERY ROW ABOUT A PHONE IN A POCKET IS
  MEASURING THAT UNLESS IT SAYS OTHERWISE.** Measured on the Mi 9T on 2026-09-06 with one fetch,
  issued from the same page over CDP (which travels on adb, not on the app's network, so it does not
  answer its own question): `status 404` in 49 ms with the app in front, `error sending request for
  url` in 32 ms behind HOME. With the socket gone, the JS layer cannot receive a frame, cannot
  notify, and the FCM handler's own `fetchWelcomeBundle` fails as `Unable to resolve host
  "localhost"` - which reads exactly like a rig misconfiguration and is not one. `dumpsys netpolicy`
  is NO help: its `blocked_state={...effective=APP_BACKGROUND}` line for the uid is identical
  foreground and background, so it describes a policy rather than a verdict. Lift it with
  `adb shell cmd appops set fr.emse.canari RUN_ANY_IN_BACKGROUND allow` and
  `adb shell dumpsys deviceidle whitelist +fr.emse.canari`, and **assert it inside the row**:
  NOTIF-1b carries `theOsLetTheHiddenAppKeepItsNetwork` as its own clause, because "the OS cut the
  network" and "the product stayed silent" are different findings that must never share a verdict.
  Note what this also means for the PRODUCT: on a phone configured as it ships, the JS notification
  path does not exist and the push is the only one there is.

- **A PUSH TO `main` IS A RESTART OF THE SERVER UNDER THE RUN.** Prod IS the test server, so every
  commit that reaches CD - including one touching only `tools/` - stops the containers, and nginx
  drops whatever the rig had in flight. On 2026-08-21 that took out COMM-22's fifth and sixth cycles,
  which reported `the salon never appeared in the sidebar` and `the access panel is not open`: two
  sentences about the product, both caused by the operator pushing while the check ran. **A redeploy
  makes a run VACUOUS, never FAIL** - a server that restarted never answered, and the campaign's
  first rule is that a transport failure is not an answer. Both halves are mechanised in
  `deploy.mjs`: the preflight WAITS for a deploy in flight rather than starting a run that cannot
  count, and `gate()` asks afterwards whether one overlapped the window and demotes the verdict if it
  did. When `gh` cannot answer, the record says `deployWindow: unknown - <why>` and the verdict
  stands: a blind spot is reported, never guessed away.
- **The Cloudflare edge in front of production drops connections in bursts**, and it takes the SSH
  tunnel with it - so `[ssh] canari: transport failure (255)` and a page of `ERR_CONNECTION_CLOSED`
  arrive together, from one cause, with no deploy anywhere near. Measured 2026-08-21 06:23-06:34
  local: prod's own uptime was 59 days and it answered normally four minutes later. A run in that
  window arms nothing and must be re-run, not diagnosed.
- **Chrome discards every input event on a page it considers hidden**, and native occlusion detection
  marks a fully covered window hidden while `windowState` still says `normal`. Hence the
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` launch
  flags. A backgrounded tab must be made by focusing another **tab**, never by covering the window.
- **Only one OS window can have focus**, so two browsers cannot both report `hasFocus: true`. A check
  that asserts focus on both is asserting something impossible.
- **`am force-stop` is NOT "the user killed the app".** Android's STOPPED state cancels every FCM
  broadcast until a manual launch, so any push-dependent check must use a swipe from recents or
  `am kill`.
- **CDP's Network domain is BLIND to the app's own requests on mobile**: `hooks.client.ts` swaps
  `window.fetch` for the Tauri plugin's Rust client. Record from **inside** the page, inject failures
  there too, and keep such navigation client-side or a reload takes the patch with it.
- **An offline RECEIVER cannot be faked in the browser.** `emulateNetworkConditions` fails new
  requests in ~10 ms and the receiver still renders the message; only the SENDER side is faked
  faithfully. A true offline receiver needs the phone's radios
  (`svc wifi disable` + `svc data disable`).
- **`window.open` returning `null` is not proof of a blocked popup** - the spec permits `null` for a
  cross-origin window that did open.
- **Clicking through to an external app backgrounds the WebView**, which throttles it, so every read
  taken after that point is against a frozen page.
- **`tail`-piped output buffers until EOF**, so a progressing job looks hung.
- **A LOCKED PHONE IS A LIVE APP THAT IS NOT CONNECTED, and the window it focuses is called
  `NotificationShade`.** On 2026-08-15 the READ preflight stopped on `A1 OFFLINE` while the same
  preflight had just reported the app unlocked with its ten conversations on screen. `dumpsys window`
  said `mCurrentFocus=Window{... NotificationShade}` - which reads as "somebody left the shade pulled
  down" and is in fact the keyguard, that being the window it is drawn in. Two further readings that
  look like contradictions and are not: `am start` answers *"intent has been delivered to currently
  running top-most instance"*, because the activity really is top-most with the keyguard over it; and
  the socket is gone because the webview went `hidden` and the native foreground guard released it,
  which is the design, not a reconnect failure. `input keyevent`, `cmd statusbar collapse` and a
  swipe all fail against a keyguard; `wm dismiss-keyguard` clears it when there is no credential to
  enter, and presence returns within seconds. **`svc power stayon usb` does not prevent this** - it
  keeps the screen on, it does not keep the device unlocked.
- **`logcat -b all` is the whole PHONE, not the app.** Any filter over it must be scoped to the app's
  pid (`adb shell pidof fr.emse.canari`) before it is scoped to a word. An unscoped search for
  `forbidden` - looking for a Tauri capability rejection - counted **26** of them, every one the modem
  printing `Received Forbidden PLMNs`, and would have reported a colleague's storage panel as broken
  because of the SIM card.
- **An install can succeed over a WebView that then serves a cached page**, so a run can measure the
  previous bundle while every gate is green. Compare the loaded `_app/immutable/entry/*.js` names
  against the local build output - and read them from `performance.getEntriesByType('resource')`, not
  from `script[src]`: SvelteKit boots from an inline module, so a selector-based version of that
  assertion finds nothing and silently asserts nothing.
- **`Log.enable` and `Runtime.enable` REPLAY what the page buffered before you attached.** A probe
  that connects, enables, reloads and counts attributes the PREVIOUS session's errors to the reload
  it just performed. Measured 2026-08-13: 29 `SecretReuseError` reported for a fresh boot, every
  sample timestamped 35 minutes earlier. Take a cutoff instant before the reload and discard every
  event whose `timestamp` is at or below it.
- **A reload DESTROYS the execution context the Runtime and Log agents were enabled against**, and
  events stop being delivered for the new document - so the same probe then observes almost nothing
  and reports a silent, healthy client. The tell is the volume: 3 classified events across a whole
  app boot is not a quiet client, it is a detached agent. Re-send `Runtime.enable` / `Log.enable` on
  a tick across the observation window; both are idempotent, and the cutoff above already filters
  the duplicate replays that re-enabling produces.
- **The phone's message store is NOT IndexedDB, and reading it there reports the phone as wiped.**
  Measured 2026-08-13: on A1 the `CanariDB_<hash>` database exists with exactly the expected
  `conversations` / `messages` / `outbox` stores, and all three count **0**, while `/chat` lists a
  full conversation list on screen. The stores are present and empty because the WebView creates the
  schema; the data lives in the native (Rust/SQLite) store. A probe that counts IndexedDB on the
  phone therefore "proves" a total data loss that has not happened - and it will do so most
  convincingly right after a reinstall, exactly when a wipe is plausible. Assert against the SCREEN,
  or against the native store, and never carry a browser-shaped store probe over to the device
  unchanged.
- **A conversation looked up by NAME is ambiguous once the campaign has created test groups**, since
  a group containing the peer matches the peer's own name. Harmless for a check that only needs
  *some* group, wrong for anything asserting about the DM - resolve the id, and report which
  conversation the run actually used.
- **Postgres stores UTC while the prod host is `Europe/Paris`**, so a DB timestamp is two hours
  behind the wall clock a test just wrote down. Both are correct; convert, and never "fix" the
  server clock.
- **A virtualised count needs a FRESH MOUNT and the max over repeated polls**; a count taken while
  rows are still loading is non-monotonic and undercounts.
- **A baseline needs a polled budget, not a fixed wait.** A fixed sleep after a send reported a
  healthy link as lossy.
- **A conversation-scoped banner only renders inside `ChatArea`**, and its phase store is in-memory,
  so "no banner" is meaningless unless the check asserts the conversation is open **and** the
  observation window spans a fresh attempt. After a reload, "no banner" is guaranteed and proves
  nothing.
- **THE PIN GATE ONLY MOUNTS ON `/chat` AND `/communities`, so a LOCKED client reads as unlocked
  everywhere else.** Any launch, kill, reboot, radio cycle, `install -r` or self-restart re-locks the
  encryption PIN, and a locked client decrypts nothing and ACKs nothing - every number taken from it
  is wrong, and it never says so. `input[type=password]` is doubly wrong: the mobile shape is a
  KEYPAD with no input element at all. `state.mjs` therefore answers `LOCKED` / `unlocked` /
  `unknown (gate not on this route)` - `unknown` means *run `pin.mjs`*, which is idempotent, so
  running it when it was not needed costs nothing while skipping it costs the whole measurement.
- **`client()` turns FOCUS EMULATION on, and an emulated-focus page is pinned `visible`.** That is
  what lets three clients each be "the focused window" at once, and it silently defeats every attempt
  to background one: `window.open` really does open a sibling tab and the page stays `visible`
  anyway. `background()` now toggles it off for the duration; closing the sibling also does not
  necessarily re-select the app, so the restore asks for `Page.bringToFront` explicitly. A failed
  attempt must close its own tab, or the next run inherits a window full of stale `about:blank`.
- **A node script holding an open CDP socket never exits**, so a PowerShell pipeline that buffers
  (`| Select-Object -Last N`) prints NOTHING and reads as a hang - after the script has already
  computed and printed a perfectly good answer. Redirect to a file and read the file. This cost three
  runs in one session before it was recognised.
- **The message store is CIPHERTEXT at rest**, so searching its rows for a marker string finds
  nothing whether or not the message is there: only `id` and `conversationId` are plaintext. A probe
  written that way is VACUOUS, not negative - and it will happily "confirm" a loss that never
  happened. Assert on the rendered pane for presence, on id sets for reconciliation.
- **A frozen Chrome renderer still answers `/json/list` over HTTP** while every `Runtime.enable`
  times out, so the browser looks alive and each individual check looks broken. Opening a fresh tab
  on the same profile does NOT help - the whole browser process is the thing that is wedged. Relaunch
  it with `launch.mjs`, whose profile is on disk, then re-enter the PIN.
- **The phone's devtools socket is named after the PID and the app restarts on its own**, so a
  forward left from earlier in the session points at nothing while the app is perfectly healthy - and
  a process with no WebView (the background push handler) is *also* a valid `pidof` answer that has
  no devtools socket at all. Re-derive it (`a1forward.mjs`), and treat "no targets" as "re-forward",
  never as "the app is down".
- **THE TEST ACCOUNT IS A REAL ACCOUNT, AND ITS OTHER SESSIONS JOIN EVERY GROUP A CHECK MAKES.** The
  rig drives W1, W2 and A1; nothing said the campaign user owned only those. Measured 2026-08-25:
  three web devices of W1's user were heartbeating on the gateway at once, two of them elsewhere and
  driven by nobody. Every device of a group's creator is fanned in at creation, so those two were
  added to each throwaway group, were slow to process their Welcome, and one asked for it again -
  reaching the repair that kicks the stale leaf and re-adds it. That is GRP-8's `PASS-DIRTY` of
  2026-08-24, and `[KICK] Stale leaf ... removed` is `unexplained` **by design**
  (`actions.welcomeRequest.test.ts`), so the row was correct dirt about a real device. **The defect
  was that nothing could SEE the device**: attributing one line cost a session. The pre-flight now
  diffs `user:online:<user>:*` against the devices it drives and prints `FLEET #tag: N device(s)
  online that this run does not drive`, by install tag. It is a NOTE and never fails the run - an
  uncontrolled device is not broken, and refusing to start would block the ladder on somebody closing
  a browser. Enumerate the fleet before blaming the product; and a phase whose verdict turns on the
  creator's device set should say which devices were present.

- **THE MOBILE LOGIN DOES NOT HAPPEN IN THE APP.** Tauri hands the OIDC hop to a Chrome Custom Tab,
  which is a different browser and therefore a **different devtools endpoint** - `phone.mjs` forwards
  the app's WebView on the device port and Chrome's own on the next one up (9333 / 9334 for A1). A
  script attached to the WebView alone sees a `/login` that never changes and reports "no credential
  form" about a form plainly on screen. Measured 2026-08-28 re-enrolling A1 after a factory wipe:
  Authentik's cookie had survived and **CAS's had not**, so the form was in Chrome for sixty seconds
  while the rig polled the app. `login.mjs` now ends its wait on EITHER client and fills whichever
  holds the form, with one copy of the fill.
- **AND THE APP'S WEBVIEW MAY NOT SURVIVE THE HOP.** Android is free to kill the Tauri process while
  the Custom Tab is in front, and it did - the pre-hop target was gone, so the socket opened before
  the login answered nothing at all. A landing after a Custom Tab is read by **re-resolving the
  target**, never through a connection held across the hop. This is the same class as
  `launch.mjs start` no-opping on a running browser: a handle is not a guarantee that what it names
  still exists.
- **A FRESHLY ENROLLED DEVICE IS OFFERED BIOMETRICS, AND THE OFFER MUST BE DECLINED.** The
  "Connexion rapide" modal covers the app after an enrolment, and its own words are *"Votre PIN sera
  efface de cet appareil"* - so accepting it destroys the ONE credential this harness can present,
  permanently, since nothing here can offer a fingerprint. `clearOverlays` ANSWERS it with "Plus
  tard" before its Escape logic and reports it as debris; Escape alone would only postpone the
  question. It was safe by luck already - the escalation only ever presses an icon-only button, and
  every confirming control in this app carries a word - but safe is not answered. **HEAL re-enrols
  repeatedly by design, so this modal is met on every pass.**

---


## A defect the ladder cannot ask about, found by READING one row's log

**Measured 2026-08-28, during HEAL-NEW-3.** The row passed. Its client log carried
`[SettingsBlockedSection.load failed] Error: blocks 500`, and the server behind it read
`EntityMetadataNotFoundError: No metadata for "UserBlock" was found` eleven times that day. The
whole blocking feature was down on production, and with it opening a 1-to-1 and inviting anyone to
a group - both creation paths ask `isBlockedWith` first and are written to stop rather than guess.

**Nothing here could have caught it, and the reason is structural.** No row asks the question; the
classifier does not fire on it, because a 500 on a section this row never navigates to is not dirt
this row produced; and the deploy was green, since the container boots and Nest maps every route.
The fault is a disagreement between two lists in one file - `forFeature` and the root DataSource -
and a green ladder says nothing about it.

**So the instruction stands and it is not a formality.** A run's logs are read on every pass, and
the useful half is what the row was NOT asking about. Two more things came out of the same log and
neither is in the verdict: the reconciliation covered 7 of 11 groups and deferred the rest for want
of a probe sender, so the sidebar went green on the READD path rather than on a complete sweep; and
the fresh-device bulk of `TooDistantInThePast` is the documented past-epoch noise, which is exactly
the kind of line a reader learns to skip - and the 500 was three lines away from it.

## AN OBSERVER POINTED AT THE WRONG ESTATE ANSWERS, AND ITS ANSWER IS ALWAYS "NO"

The campaign moved to the local estate on 2026-09-03. `psql` and `redis` were made to follow `SITE`
that day and `estate.mjs` was written to hold the decision. **`srvlog.mjs` - the THIRD observer, the
one that reads the platform's own logs - was not, and nobody noticed for two days**, because it
still spelt `ssh canari docker logs infrastructure-<service>-1` and production is never quiet: every
window it returned was full of real lines, so it read as a working instrument.

**What it costs is not an error, it is a NEGATIVE.** Every predicate of the form "this line is
absent" is satisfied for free in an estate where the subject was never created. COMM-14 asks whether
the three channel notification levels are enforced and reads
`[CHANNEL_PUSH] channel=<id> message=<id> recipients=N` as the decision itself; on 2026-09-05 it
recorded **FAIL** on a product that was working, while the PHONE's tray held both notifications it
said had not been sent. The local container had logged thirty such lines. The instrument had read
production's, where that channel id has never existed.

Two rules come out of it, and the second is the one that generalises:

- **EVERY OBSERVER FOLLOWS `SITE`, AND THERE IS NO SECOND MECHANISM.** A rig cannot be
  half-configured: `estate.mjs` decides once, at import, for the database, the cache and now the
  logs. `srvlog.mjs` stays PURE - it may not import `names.mjs`, because eleven gated self-tests take
  its rule lists in CI from a checkout that has no `names.mjs` - so the reader lives in `estate.mjs`
  and is PASSED IN. That is why `srvReport` takes its reader as an argument rather than reaching for
  one.
- **AN ABSENCE IS THE WEAKEST EVIDENCE THERE IS, AND IT FAILS SILENTLY IN BOTH DIRECTIONS.** The same
  row also read "no `[CHANNEL_PUSH]` line for this message" as "the server chose to notify nobody",
  on a stated premise about the service that was simply false - it logs `recipients=0 of N ...`
  precisely so those two stop looking alike. Two wrong things agreed, and the row was green on the
  cases that mattered least. **Assert a COUNT, never a silence**: `recipients=0` says the decision
  was taken and selected nobody; an absence cannot tell that from a message that never arrived, and
  those want opposite repairs.

## THE INSTRUMENT DESTROYED THE EVENT IT WAS MEASURING - COMM-18, THREE TIMES OVER

COMM-18 asks one thing: force-stop the app, follow `fr.emse.canari://chat/channel_<uuid>`, and land
in that salon. It recorded `FAIL` or `VACUOUS` all session on 2026-09-05, and **every symptom pointed
at the product** - the deep-link listener registered, `getCurrent()` returned nothing, the app sat on
`/posts`, the PIN gate read as refused. The build was correct throughout: driven by hand, the same
APK read the launch URL on attempt 1, 38 ms after the bundle ran, every single time.

Three separate rig defects, each of which alone produced a believable product story:

- **`unlockClient` had never once been able to spawn `pin.mjs`.** It passed the bare name with
  `archive/` as the cwd, and `pin.mjs` is in the harness root: the child answered
  `error: Module not found "pin.mjs"` on every call since the helper was written. It looked like it
  worked because its early return covers the common case - a client already past the gate - and
  because the failure went into a `said` string most callers drop. **`requireScript` exists for
  exactly this** and says why in its own docstring; the helper simply did not use it.
- **`resolveDevice` computed `isPhone` from the SPELT device name.** It already resolves a port back
  to its device for `account` and for `device`, then threw that away for the one field that ARMS the
  phone - so `--port 9333` was A1 for every purpose except re-deriving the adb forward. After a
  force-stop the devtools socket is named after the new pid, so the caller connected to a socket
  belonging to a process that no longer existed.
- **`phone.ensure` foregrounds the app with `am start -n <pkg>/.MainActivity`, and its comment
  called that "a no-op on an app already in front".** It is not. That is a plain MAIN intent;
  `MainActivity` is `launchMode="singleTask"`, so it arrives at `onNewIntent`, which calls
  `setIntent(it)` - and the deep-link plugin reads `activity.intent` in `load(webView)` to find the
  URL the app was started with. Fired 1.5 s after the row's own `am start -d <link>`, with the
  WebView still booting, it **replaced the intent under test**.

**THE RULE. An instrument that touches the subject must say what it touches.** Two of the three were
gestures the rig makes on every phone row and had no visible cost anywhere else; they were only ever
wrong on the ONE row whose subject is the launch intent. So the question to ask of any arming step is
not "does this work" but "what does this CHANGE", and a step that changes the thing under test needs
an opt-out the row can take - `ensure({ keepIntent: true })` - rather than a comment asserting it
changes nothing.

**AND THE CORROLLARY THAT COST THE MOST TIME.** All three failures were swallowed into strings: a
`said` nobody recorded, a `verdict` with no reason beside it, an intent nobody logged. The row now
records `a1GateSaid`, and `pingate` PRINTS a non-zero exit rather than only returning it, because
`LOCKED` has three causes that read alike - the PIN was refused, the modal never mounted, or the tool
never reached the phone.

## A STATUS WITH NO REQUEST IS EVIDENCE FOR NOTHING

**Measured 2026-08-29, on HEAL-NEW-15's gate.** The row was demoted to `PASS-DIRTY` partly on
`Failed to load resource: the server responded with a status of 415` - and no `badHttp` entry, and
no `knownBadHttp` entry, named the request. The method, the path and the caller were all
undetermined, so the line could be neither explained nor fixed, and it would have demoted every
future run of the row for as long as it went unnamed.

**That shape is the one an ignore list must never be allowed to swallow**, and it is why the rule is
here rather than in a runner. A line that can be READ is either explained and named per row, or it
is a finding; a line that cannot be read is neither, and adding it to a needle list is weakening the
test while looking exactly like explaining it. The disposition for an unidentifiable dirt line is to
make it identifiable.

**None of it was missing evidence, which is the transferable half.** `Log.entryAdded` carries the
resource's `url` as a field and its `networkRequestId` joins the line to the request the classifier
already held, so the METHOD was there too - and both were thrown away at render time, one line below
the comment explaining why `url` was kept. The report now renders a network line as
`<sentence> <- METHOD /path` in every console bucket and in the timeline, and classification is
untouched: every rule, and every `ignoringExpectedLog` needle, still matches the sentence alone.

**And the same key was forgiving the wrong request.** Chrome writes ONE sentence for every failing
resource, so the de-duplication that collapses `Log.entryAdded` against `Runtime.consoleAPICalled`
was collapsing ten different failures into one line carrying the FIRST url - and `isBenignUrl` then
judged all ten on it. A benign avatar `404` arriving first forgave a `404` from anywhere else on the
page: an under-report, invisible from a green run, and the second time on this campaign that a
classifier compared a different string from the one it meant. **Two network lines are the same event
only when they are about the same resource.** All four cases were run against the unfixed
classifier first and fail there.

**Then the fix over-reached, and the report said so.** A worker's own `console.log` reaches
`Log.entryAdded` too, and its `url` is the WORKER FILE - so HEAL-NEW-2's first read showed four
`[RUST::WARN] Past-epoch application frame` lines dressed as
`<- ??? /_app/immutable/workers/mlsCrypto.worker-*.js`. **The `???` where a method belongs is what
gave it away**, which is the argument for rendering the method at all rather than the url alone: a
join that failed is visible instead of plausible. `entry.source` is the field that separates a
network line from a script's, and both the renderer and the de-duplication key now require
`source === 'network'`. The negative control is a self-test case, because a narrowing that quietly
restored the old collapsing would look identical from a green run.

## A ZERO THAT COULD MEAN "SILENT" OR "UNREAD" IS A DEFECT IN THE INSTRUMENT, NOT A FINDING

**Measured 2026-08-29 on HEAL-REVOKE-5, which spent twenty-five minutes recording two product
defects it had invented.** The row reported `theDeviceWipedItself: false` about a revoked device, and
an equality gap of `rows: 3 vs 11` against its reference. Both are P1-shaped. Neither was real.

**The first: `classifyWipe` was reading a field `report()` does not return.** It was called as
`classifyWipe((await report(obs)).lines ?? [])`; the report object carries `timeline`, and has never
carried `lines` - the exact mistake `consoleLines()` was exported to prevent in 2026-08-11, with a
doc comment naming it. So the classifier ran over `[]` on every call, every `said(...)` was `false`,
and the runner concluded the device had stayed silent - when nothing had read a single line of its
console. The server logs said the opposite and settled it: the delivery service signalled the
revocation, the gateway routed the control frame to the victim's live socket, and the disk sample
taken independently showed two databases still present. **The `?? []` is the whole story**: it turned
a field that did not exist into a defensible-looking empty, and an empty console into a verdict.

**AND FIXING THE FIELD DID NOT FIX THE DEFECT, WHICH IS THE HALF WORTH KEEPING.** Reading
`rep.timeline` is correct and still reported `linesRead: 0` on the very next run, because
**`report()` DRAINS** - it consumes `cx.events` on purpose, so that a second report covers only what
happened since the first. The wipe is waited for in a poll, four seconds apart, up to thirty times;
each call therefore ATE the window the previous one had filled, and what the run recorded was the
last four seconds of a two-minute wait. It also quietly emptied the gated `wipeWindow` observer that
had just been added to close this rung's gate. A classifier must never be built on a projection that
consumes its own evidence: `consoleLines(cx)` is the archive `report` fills as it drains, cumulative
and safe to call in a loop, and it is what the classifier reads now.

**The second: the settle predicate accepted a device that had not finished arriving.** `watch`'s
default is `rows > 0 && syncing === 0`, which a sidebar holding three of eleven groups with nothing
amber satisfies exactly. The returning device was declared settled at 2 292 ms - the second of two
samples in the entire watch - and its state was then compared with a reference that had eleven. The
row reported the gap in the WORSE direction, as a device that had lost eight groups.

**The rule both leave: a measurement whose zero is indistinguishable from "not measured" must FAIL
rather than pick one.** `classifyWipe` now returns `linesRead`, and `theWipeWindowWasActuallyRead`
asserts it above zero, so a silent device and an unread console can never again produce the same
row - and that guard is what caught the drain, on its first run, in a window where the verdict
itself was `VACUOUS` and would have told nobody anything. The predicate is now anchored to a count the rig can READ - the server's own active-group count
for that user, less the groups dismissed while still a member - and when that count cannot be read
`expected` is `null`, the predicate is never satisfied, and
`theSettlePredicateKnewWhatToWaitFor` names the cause. **There is deliberately no fallback to the
weaker predicate**: falling back would restore exactly the reading that produced the phantom gap,
and a fallback is a signal, never a path.

**The transferable half is that both failures were invisible from the verdict.** A `FAIL` with five
unmet expectations reads as a product in trouble; nothing in it says the instrument never looked.
That is what makes these guards expectations rather than notes - they are cheap, they cost one field
each, and the alternative is a campaign whose worst findings are the ones nobody can trust.

## THE HEAL-REVOKE RUNG WAITED FOR A PROOF THIS ACCOUNT CANNOT REACH

**Measured across three runs of HEAL-REVOKE-5 on 2026-08-29, and the number was the same every
time.** Two rows of twelve stay amber for the full 600 s deadline on EVERY device in the world - the
seeded victim, the returned device, the freshly minted reference - and the ids are identical:
`3ca20e77` and `6e7c9ab1`. `syncing === 0` therefore burnt three deadlines a run, thirty of a run's
thirty-five minutes, and then reported a stall that nothing online could have prevented.

**That is the same failure `servable.mjs` was written for on the HEAL-NEW rung, and this is its
second caller - but not with the same subset.** There the responder is the PEER, a different account,
so `activeGroupIds` (a per-USER question) already narrows the set. Here the responder is the owner's
own other device: the server says it is a member of every group the victim is in, and the per-user
set narrows NOTHING. **A device can only answer a re-admission request for a group whose MLS state it
HOLDS**, and the sidebar says which those are - a READY row. So the subset is the union of the ready
rows of every client that is up, which is a strictly stronger statement than membership.

**An empty world still never settles.** `subsetSettled` refuses a vacuous subset by construction, so
HEAL-REVOKE-7 `--order first` - which exists to return with nobody online - reports a device that
could not heal rather than becoming the fastest PASS on the board. The runner's own guard knows which
rows meant it: `theSettlePredicateKnewWhatToWaitFor` demands a non-empty world only where the row's
declared `returnTopology` put someone there.

**What the change did NOT do is weaken the equality the row exists for.** `itEndedWhereAFreshDeviceEnds`
still compares the whole fingerprint, and the run that established all of this returned an EMPTY gap:
13 rows, 11 ready, 2 syncing, same `serverActive`, and the same two amber ids on the returned device
and on the reference. The rows that cannot heal are equal too, which is the claim.

## A CADENCE READ OFF A HEAL-NEW LOG MEASURES THE RIG, UNLESS IT IS SCOPED TO ONE DOCUMENT

**Measured 2026-08-29 on HEAL-NEW-2 and -12, and it would have been misread in BOTH directions.**
Each row logged 19 `welcome_request`s where 10 groups were asked: ten at once, then nine again - 34 s
later on row 2, and 60 s later on row 12, against an app line that names its own cadence as
`(cadence 60s)`. Read alone, row 2 is a violation and row 12 is a confirmation. Neither is either.

**Both ledger lines carry `documentsReplaced: 1`.** `confirmEnrolment` drives the abandoned-device
purge through the device panel, which replaces the document - and the re-add throttle is an
in-memory `Map`, so the reload resets it. The second round follows that reload by 6-8 s in both runs,
and the 34 s and the 60 s are the distance to a page load, not a cadence. **Row 12's agreement with
the documented number was a coincidence**, which is the more dangerous of the two readings.

**Inside one document the throttle held exactly.** Every one of the nine repeats logged
`[READD] <id>... throttled (17s ago) / (22s ago) / (36s ago) / (43s ago)` at each 5 s watchdog poll.
That is the measurement the row can actually support. **A rate, an interval or a count taken from a
HEAL-NEW log is a statement about ONE document or it is a statement about the harness** - the runner
navigates the client by design, and every in-memory guard in the app is reset each time it does.

## Where a result goes

- **PASS** -> one row in the [dashboard](cross-client-testing.md), with the build it ran against.
- **FAIL** -> a Work Package in `CLAUDE.md`, severity per its rules, **with the captured log inline**.
  A durable marker written without its evidence is legacy.

The campaign is not done when the tables are full. It is done when every FAIL is either a Work
Package or a fixed commit, and the dashboard says which build produced each verdict.

### A killed run can destroy a measurement seconds from being recorded

COMM-22 was stopped mid-run on 2026-08-26 to make a push safe. The server log then showed its OWN
teardown had already fired (`[WORKSPACE] delete ... reason=admin_deleted`), so the check had reached
its last step and the stop landed in the gap before `results.ndjson` was written. No debris and no
verdict: the estate was clean without needing a sweep, and the whole cycle - minutes of grant, join,
send and revoke - bought nothing at all.

**A verdict exists only once it is written.** Everything before that line is a process that can be
killed, and the closer a run is to finishing the more a stop costs. So: let a run finish, or accept
that the push waits. There is no third option that keeps both, because the two are competing for the
same deployed bundle - a redeploy mid-run is what makes `gate` call a phase `VACUOUS` in the first
place.

### The board must read the ledger's NEWEST verdict, and `rows.mjs` is what says whether it does

On 2026-08-26 the board claimed rung 9 COMM was swept - 23 `PASS`. The ledger's newest verdict for
eleven of those rows was worse: 12 `PASS`, 10 `PASS-DIRTY`, 3 `FAIL`. Nobody had falsified a cell.
The rows had genuinely passed on `5d7fac13` at 14:03, a later sweep on `d6f61539` at 21:26 had gone
dirty, and only the rows somebody happened to look at afterwards were carried across. The board kept
the better half of a two-sided record.

**An older PASS is not evidence against a newer FAIL - it is evidence that the defect is
intermittent, which is worse.** COMM-18 makes the point sharply: it holds a `PASS` at 19:47 and a
`FAIL` at 22:02 on the SAME build, with the same runner. A cell that shows only the first has not
summarised the evidence, it has selected from it. The newest verdict holds, always, and a superseded
one survives in the cell only as prose that names it as superseded.

`bun rows.mjs` answers this in one command: it reads the board and the ledger and prints every row
where they disagree, every row the board claims and the ledger cannot corroborate, and every verdict
taken by a runner that has since changed. **Run it before believing a cell, and before writing a
phase's summary line.** It had been reporting these fourteen divergences for a day before anyone
ran it - a check that exists and is not run is worth exactly what no check is worth.

### Dirt repeated across rows is ONE defect, and a per-row report cannot show that

The same `d6f61539` sweep is the other half of the lesson. Ten consecutive COMM rows came back
`PASS-DIRTY`, and each cell dutifully named its dirt. Read one at a time they are ten small
blemishes, each individually arguable, none worth stopping a rung for - which is exactly how the
rung got called swept. Read together they are one line, repeated verbatim, naming ONE salon:

```
[GRAINE] could not join the distribution group of salon 0855f9f6 of 9b34e540
```

That salon was created by COMM-8 at 21:27, whose own `FAIL` was `seedAfterTheGrant: false` on the
same salon, and W2 was still failing to join its distribution group twenty minutes later. Eleven
rows, one defect - the stale published base that COMM-22 measured head-on.

**A report that attributes dirt to a row and never groups it across rows converts one defect into
many acceptable ones.** So when a phase comes back with several dirty rows, sort the dirt before
triaging the rows: identical lines, and especially identical ids inside those lines, mean one cause
and one re-run. The corollary is a scheduling one - a defect that leaks across row boundaries makes
every LATER row in the sweep suspect, including the ones that passed, because the estate they ran
against was already broken.

### A precondition a function cannot answer without belongs INSIDE it, not at each call site

Three rows have now died on one fault, and the first two were "fixed" both times:

| Row | Date | What it reported | What was true |
| --- | --- | --- | --- |
| READ-9 | 2026-08-21 | an EMPTY conversation list | thirteen rows on the device |
| MUT-18 | 2026-08-22 | `listedEntries: 0` | ten rows on the device |
| DEL-7 | 2026-08-27 | `the group never reached A1` | it had, in 147ms |

At the 411px width A1 runs at, `.sidebar-panel` keeps its rows in the DOM and goes `display: none`
while a conversation is open. Every list assertion in the harness filters on
`getBoundingClientRect().width > 0` - correctly, since an invisible row is not a listed row - so the
whole list reads as absent. `parkConversation` is the cure and has existed since READ-9; it was added
to `openDM`'s A1 branch after MUT-18, and to nothing else.

**Two lessons, and the second is the one that keeps costing.** The parking now happens inside
`awaitListed`, which is the function that cannot answer its question without it, so no future call
site can forget - a precondition placed at a call site is a precondition that will be missing at the
next call site written. And when the same wrong answer appears a second time, the fix is not the
second call site: it is finding what makes the answer reachable at all. `awaitListed` also logs the
discriminator now (`{panel, hiddenPanel, rowsInDom}`), because "not listed" and "listed but hidden"
were indistinguishable in the failure output for six days.

### A field in the detail is not a gate, and two HEAL runners believed it was

**Measured 2026-08-28.** Forty-eight checks put their outcome through `gate()`; `healnew.mjs` and
`healrevoke.mjs` did not. They computed `PASS` from their unmet expectations alone and stored
`clean: false` beside it as a fact nobody acted on. HEAL-NEW-11 landed exactly there - every
expectation met, thirty-nine severe lines in the console, and a `PASS` on the board that no other
rung's `PASS` meant the same thing as. HEAL-NEW-1 and -3 were taken the same way.

**The redeploy half is the sharper one.** `gate()` also turns a run VACUOUS when a deploy replaced
the server underneath it, and the campaign has already lost three cells that way. An ungated runner
would have recorded a product verdict about a server that went away mid-measurement.

**`finishObserved` is the affordance, and it is shorter than not using it** - it takes the reports,
gates on both, and exits on the gated verdict. `heal-a1.mjs` and `heal-web.mjs` are the exception
and say so in the source: they rewind an MLS store on purpose, so the loss markers are their
stimulus and the console is promoted to the ASSERTION rather than used as a gate.

### A build stamp that names only the frontend cannot separate two runs against different servers

**Measured 2026-08-28.** HEAL-NEW-3 ran at 19:42 and HEAL-NEW-11 at 20:37, both recorded against
build `ebef7f3c`, `builtAt` 19:30. Between them, at 19:56, a core-service fix deployed and closed the
`UserBlock` P1 - which is why the first run carries `GET /api/users/me/blocks -> 500` and the second
carries `badHttp: []`. The frontend artefact genuinely did not change, so the stamp is not wrong; it
is simply not an answer to "which server did this row ask". Two rows naming one build ran against two
different systems, and only the wall clock told them apart.


### A phone declaration matched by whole-string equality silently unarms the phone

DEL-7 first recorded `INVALID` blaming the product - `the group never reached A1` - when the group HAD
reached A1 in 147 ms. `devicesFor` compared its declaration `del.mjs --only 7` against the invocation
that actually exists, `del.mjs --only 7 --destructive`, by whole-string equality. No match, so the
preflight silently ran `W1 W2` and the phone was never armed. **A declaration is a PREDICATE over
invocations, never a string to be equal to** - and the failure mode is the worst available: not an
error, but a row that measures a different fleet than the one it names and then accuses the product.

### A runner must not fold cleanliness into its own assertion - `gate` only ever DOWNGRADES

DEL-9 recorded `FAIL` on 2026-08-27 with all four of its own assertions holding, because `rep.clean`
sat inside its `ok` expression. One benign `[HISTORY_COVERAGE]` line - emitted because A1 had joined
the fleet, nothing to do with deleting an open conversation - turned a passing row into a failing
one.

`gate` (`watch.mjs`) takes a verdict and the observation reports and returns `PASS` or `PASS-DIRTY`;
it never rescues a `FAIL`. So a row that ANDs `clean` into its assertion is not being strict, it is
making `PASS-DIRTY` structurally unreachable for itself and mislabelling environmental noise as a
product defect. **An assertion answers the row's own question and nothing else. Cleanliness is the
gate's job, once, for every row.**

### The ending a check owes, and the repair for it that lies

`results.mjs` derives the exit code from the verdicts a script recorded, through a `beforeExit`
hook whose whole design is that there is nothing to add to a script and therefore nothing to omit.
It fires when the event loop IDLES - and a check holding a CDP socket never idles, because nothing
closes one. `client()` alone is enough: a two-line script that opens one and prints a line was
measured on 2026-09-05 still running 25 s later, killed by its timeout.

So such a script runs off its end and sits there with its verdict already on disk, blocking whatever
was queued behind it. `tab236.mjs` was alive twenty-five minutes after printing `1/1 pass`;
`tab5.mjs` and `notif.mjs` were in the same state; `tab4.mjs` cost six minutes a run.

**THE OBVIOUS REPAIR IS THE DEFECT.** A bare `process.exit(0)` ends the process and claims a pass
in the same breath, so a recorded `FAIL` is reported as `done` - which is exactly what `beforeExit`
was written to stop. Six files in the tree carry a comment saying so, each written the day that file
was caught, and `tab236.mjs` acquired a seventh on 2026-09-05 UNDER a comment stating the code was
derived. Both halves have to be the same call: `exitOnRecorded()` is the derivation, invoked rather
than waited for.

**Five endings are honest and closing the socket is one of them** - it lets the loop idle, which is
precisely what the hook waits for; thirty checks end `w1.close(); w2.close();` and are correct. A
first draft of the gate condemned all thirty, and a gate that condemns the correct majority gets
deleted rather than obeyed. `archive/exit-selftest.mjs` asserts both halves, and asserts its own
predicate on fixtures first: an exit-0 downstream of a `record(` is flagged, an early opt-out before
any verdict is not, and prose about `record(...)` is not an import.

### A spawned atom that never exits turns SUCCESS into a timeout, and only on the rows that need it

DEL-7 came back `PASS-DIRTY` on 2026-09-05 carrying `pinOnWake: "pin.mjs failed: ...[pin] after:"`,
while a screenshot taken at the same moment showed the phone unlocked and past the gate. Both were
true. `pin.mjs` closes its CDP socket and names an exit code on every REFUSAL - a PIN the product
rejected (exit 1), no gate to answer (exit 2) - and the path where the PIN WORKED fell off the end of
the file with the socket still open. An open socket keeps the event loop alive, so the process never
exited. `phone.unlockPin()` runs it under `execFileSync(..., { timeout: 120_000 })`: unlock in 2.7 s,
sit for 117 more, get killed, report `pin.mjs failed`.

**It hid behind the path that worked.** A client already past the gate leaves at the `exit(2)` branch
and its caller reads `no modal` instantly - which is the state of the phone on every run except the
first after a restart. So the hang could only appear on rows that RESTART the app, the one population
that cannot afford two lost minutes, and it looked like a phone problem every time.

Two rules came out of it, and only the first is about exit codes.

- **A process must end as deliberately when it succeeds as when it fails.** An exit code is part of a
  contract; a success path that simply runs out of file has opted out of it, and its caller is left
  inferring the outcome from a clock.
- **A failure report built from STDOUT is built from the one stream that says nothing about why.**
  `unlockPin` kept 200 characters of stdout and discarded the exit code and stderr - so "the product
  refused the PIN", "the app is on an estate that is not the local one" and "the CDP context died"
  all rendered as the same truncated line, ending mid-sentence on the most interesting word in it.
  The record must carry the evidence separating the causes it cannot itself distinguish.

**And the instrument hash could not have flagged the fix.** `instrument.mjs` walked `import`
specifiers, and `pin.mjs` is SPAWNED, never imported - so the file that decides whether a phone row
can read anything at all was in no hash, and repairing it changed what every `+A1` row meeting the
gate observes without ageing one verdict. That is the same failure the hash was built for (`chat.mjs`
opening the wrong conversation under runners whose own bytes had not moved), one level further out:
**an import graph answers what a file LOADS, never what it RUNS.** The walk now follows a bare `.mjs`
name in call or array position, anchored there so a filename in prose stays out - over-inclusion is
the safe direction only while it stays bounded, and a hash invalidated by every edit anywhere is
worth what no hash is worth. Measured on `del.mjs`: 20 files to 25, the five being exactly the
spawned scripts and their imports.

### A campaign run and a push to `main` are mutually exclusive - three measurements died of it in one day

On 2026-08-27, COMM-12, COMM-22 and DEL-9 all recorded `VACUOUS` with `failures: []`. Nothing they
asked had failed. Each was voided because CD deployed a new frontend while the row was running:

| Row | The deploy that landed mid-run |
| --- | --- |
| COMM-12 | `396dd396` `docs(tooling): the flag was dropped, the config was not` |
| COMM-22 | `9c601be9` `docs(ecosystem): the last repo, and the bit git never recorded` |
| DEL-9 | `5bb1cc92` `fix(posts)!: the field stripped for privacy was the field the pencil was drawn from` |

**Two of the three were DOCUMENTATION commits.** A docs push is not a harmless push here: every
commit to `main` triggers CD, CD redeploys the frontend, and prod IS the test server. A row that
straddles that redeploy cannot say which artefact it measured, which is precisely what `gate` reports
by returning `VACUOUS` with `redeployedMidRun` naming the run.

**THE RULE IS RETIRED (2026-09-03), AND THE INCIDENT IS WHY THE PAGE KEEPS IT.** Both halves of
it are gone: a push to `main` deploys nothing now, and the rig targets the LOCAL estate, so no
deploy is on the path of a run at all. A documentation commit cannot void a row, and neither can a
release. The heading above is left naming the push because that is what actually happened on
2026-08-27 - a rule reads as retired the moment its incident is rewritten out of it, and this one is
retired for a reason worth being able to check.

**WHAT REPLACED IT IS SMALLER, MORE FREQUENT AND LESS VISIBLE, WHICH IS THE WHOLE WARNING.** A
`bun run dev` reload swaps the bundle under the clients exactly as a deploy did. It happens on a
SAVE, it takes no run and no pipeline, and there is nothing to watch the way `gh run list` was
watched. `bundle.mjs` - written for the deploy case, and derived from what a client is EXECUTING
rather than from what happened upstream - is the only thing that still catches it, which is the
argument for deriving a check from state rather than from a cause: it kept working when its cause
was replaced by a different one.

**The mechanism is working and must not be softened.** `gate` refusing the attribution is the only
reason no false verdict entered the ledger - the alternative is a `PASS` against an unknown build,
which is worse than no measurement. The cost is real, though: three rows have to be re-run, and one of
them (DEL-9) had already been re-run once for a different reason.

So the scheduling rule: **while a phase is running, nothing pushes to `main` - docs included.** When
two sessions work in parallel, one of them owns the remote for the duration of the rung. A row that
comes back `VACUOUS` with `failures: []` and a `redeployedMidRun` key is not a defect to diagnose, it
is a measurement to take again in a quiet window.

### The IdP's session survives an app-origin wipe, and reading that as a failure cost six rows

On 2026-08-28 five checks failed in a row - HEAL-NEW-0, HEAL-REVOKE-5/7/8, MULTI-8/9 - every one of
them on `login: false`, and not one of them measured the product. The console of each said the
device had enrolled and the census carried its new id.

**One cause.** `Storage.clearDataForOrigin` clears `canari-emse.fr`. The SSO session does not live
there: it lives on `auth.canari-emse.fr` and `cas.emse.fr`. So a device wiped to factory walks the
whole flow and lands signed in with **no field to fill** - and `login.mjs` had been written to treat
"no `#username` after 30 s" as a failure.

That is not an edge case, it is the normal path, and it is the reason the eleven HEAL rows cost ONE
2FA instead of eleven. `newdevice.mjs`'s own header had said as much since the day it was written;
the helper it calls had never been told.

**The rule is the one this repo already had, applied one layer down: classify at the throw, as a
type.** Downstream both outcomes are the same sentence - "no credential form" - and a caller reading
that as a failure records a rig fault where the product behaved. What separates them is a fact
available at the throw and nowhere after it: where the browser ended up.

### A predicate must not assert against a gesture the instrument itself made

`nothingSurvivedTheWipe` read localStorage after the wipe and required zero keys. It found
`PARAGLIDE_LOCALE` and failed the primitive, while both MLS databases, every cookie and every
identity-bearing key really were gone.

**Measured, not argued:** clearing the origin leaves `[]`. It is the reload performed two lines
later - performed on purpose, so the wipe is read against a fresh document rather than one still
holding the app's in-memory copies - that lets the app boot and write its locale back. The assertion
was therefore about the rig's own reload.

Two things follow. **Name the claim after what must be absent, not after a count**: the row asks
that no IDENTITY survived, so an allowlist of what the boot legitimately writes is the shape, by
name, and the next key the app learns to write surfaces as a name for someone to judge instead of
slipping under a threshold. And **when a verification needs a gesture of its own to be trustworthy,
ask what that gesture creates** - the answer belongs in the predicate before the first run, not
after a `FAIL`.

### A helper's exit code is a classification - collapsing it to a boolean destroys the discriminator

`pin.mjs` exits `2` for "no unlock modal on screen". `newdevice.mjs`'s `run()` returned `r.status
=== 0`, so "the gate was not there" and "the gate refused us" arrived at the verdict as the same
missing tick, and the primitive failed on the one of the two that is not a failure at all.

**A spawned script's status is the only channel it has for a distinction it already knows.**
Throwing it away is the same fault as branching on an error message, from the other end: the
information exists and is discarded at the boundary rather than never produced.

### A click that was delivered is not a click that was acted on

A launcher that has painted but not hydrated takes a click and does nothing with it. `realClick`'s
page-side recorder confirms the `BUTTON` received the event - so the click layer, which is the layer
built precisely to catch a click landing on the wrong element, reports success - and the step then
spends its whole budget waiting for a navigation that was never started. This read as "no credential
form after 30s" while the same click made by hand two minutes later reached `/chat` in two seconds.

**So a gesture is judged by its EFFECT, and the wait ends on a fact rather than on a timeout.** A
dropped click is not cured by waiting longer for it, which means the step retries rather than
extends; and where a gesture has two legitimate outcomes, the loop watches for both and says which
one it got.

### A primitive asserts its own claim and nothing more

The same run also failed because no PIN gate appeared for a brand-new device. That is a real
question about the product - possibly a sharp one - and it was being answered by accident, in a
primitive whose claim is narrow and load-bearing: this browser is now a device the server has never
seen, of the same account, enrolled, reached with no human step.

A finding smuggled into a primitive arrives labelled as a broken instrument, and nine rows resting
on that instrument stop for a reason that is not theirs. **Record the observation by name, let the
row that set out to ask do the judging.** `pinGate: "answered" | "none shown" | "refused (exit N)"`
says what happened without deciding what it means.

### A row's own teardown is the next row's inherited state, and the SEQUENCER owns the baseline

HEAL-NEW-1's condition is an account with nothing online, so the row kills W1 and W2. That is right
for the row. It is fatal for the row after it: `run.mjs`'s preflight refuses a run whose clients are
unreachable, and the preflight runs BEFORE the script that would have started them. So HEAL-NEW-2,
-12 and -3 each died in thirty seconds, having measured nothing, with a refusal naming a state their
own runner was written to create.

**This is campaign rule 4 arriving from the direction nobody watched.** The rule was written for a
row blocked by an inherited state - a leftover group, a client on the wrong page - and the
assumption was that the harm comes from a previous row failing. Here every row behaved perfectly:
one row's correct teardown was the next row's broken precondition.

**The baseline belongs to whatever sequences the rows, because that is the only layer that knows a
row ran before this one.** A runner cannot restore what its own condition required it to destroy -
and it cannot do it in an exit hook either, since starting a browser is asynchronous and an exit
hook cannot await. So the ladder starts both browsers and unlocks them before every row,
idempotently, and the row is free to kill whatever its condition needs dead.

**It has a second half that is easy to forget: the phone.** `healnew.mjs` restarts the app it
force-stopped, but not the devtools forward - `phone.mjs` owns that - so a row that stopped A1
leaves it running and INVISIBLE, which reads exactly like a dead cable to the next row that needs
it. The baseline re-arms it for the same reason it starts the browsers.

### A primitive that navigates the client owes putting it back, and splitting one is where that debt comes due

`confirmEnrolment` ends by driving `purge-devices.mjs` through the new device's own settings panel,
which is the only way to reclaim the slot the mint abandoned. It therefore leaves the client on
`/settings`, a page with no sidebar on it.

That cost nothing for as long as the mint was one call: every caller ran the whole thing first and
navigated to `/chat` itself afterwards, so the debt was always paid by accident. Split at the live
client on 2026-08-29 - so a row can watch the heal in the window the second half used to occupy -
the second half now runs LAST, and whatever reads the sidebar after it reads `/settings`.

HEAL-NEW-15 is where it came due. Its closing `readAll` reported `{panel: false}`, and two
expectations that are claims ABOUT THE SIDEBAR - `rowsWereEnumerated` and `readerMatchesMarkup` -
were recorded false against a page that never had one. **A `FAIL` naming the product, produced
entirely by the instrument's own navigation.** The same left-behind route is why that run's debris
sweep declined W3, which is the tell: one cause, two victims, and neither of them the app.

**Fix it where the navigation happens, not where the reading does.** A reader defended at each call
site is defended once per site anyone remembers; the primitive that moved the client is the only
place that knows it moved. It restores with `ensureChat` and not a `goto`, because a `goto` re-mounts
the PIN gate and would hand the caller a locked client - the debris sweep's complaint in the other
direction.

### A poll does not make a predicate true, it only proves how long it is false

The night before, `sameAccountEnrolled` was read once after a fixed sleep and said `false` at +20.7 s
where an earlier run had said `true` at +19.8 s. That is the exact signature of a race, so it was
fixed as one: poll for the fact, bound the wait, record `enrolledInMs`. Five rows then failed with
`the census carries the new id: false (after 63762ms)` - the full deadline, every time.

**The poll was the right instrument and it returned the right answer: the fact is never true.** What
looked like a race was two different devices, one of which happened to have published a KeyPackage
and one of which had not. A single read cannot tell those apart; a bounded poll can, and did, in one
run. So a poll is worth adding even when the flake turns out not to be a flake - it converts "it
sometimes says no" into "it says no for 63.7 s", and only the second form points at the predicate.

The predicate was wrong in the way [durable-rules](durable-rules.md) already names: **a column is
only evidence for the question it was written to answer.** `census()` reads `key_package` UNION
`dm_device_group_memberships`, which answers *is this device addressable*, not *does this device
exist*. On this schema there is no device-registry table at all - `auth_sessions` is the only row a
registration writes - so "enrolled" had no correct column and the runner reached for the nearest one.

### A number that looks like a regression is one `GROUP BY` away from being your own footprint

Twelve of today's twenty-two new web devices held a session and no KeyPackage, against zero on each
of the six preceding days. Read alone, that is a regression landing with tonight's deploy, and it
would have been written up as a P1. One more query - group the same population by owner - returned a
single row: all twelve were the harness's own account, first seen inside a sixteen-minute window that
matches the failing rung to the second.

**Before a population becomes a finding, ask who is IN it.** The rig is a participant on this
platform, not an observer of it, and every row it runs writes to the tables the next question reads.
A day-over-day count is the shape most likely to hide that, because the rig's own activity is exactly
what is new today.

### A board cell is a verdict, and prose in one is state that has not been written down yet

**A `PASS` cell says `PASS X/X` and a time if the time means anything. Nothing else.** A cell may
keep words in exactly two cases: the verdict is not a clean pass (`PASS-DIRTY`, `FAIL`, `SKIPPED`, a
partial like `4/5`), or the row carries an unresolved item - a missing `a1Build`, an owed re-run.
Both are open state, which is the whole of what the board is for.

Everything else has a home, and the reason to enforce it is not tidiness: a fact that exists in two
files diverges the first time one of them is updated, and the board is the file that gets edited
mid-run. What a hard-won run cost goes to [cross-client-campaign](cross-client-campaign.md); what was
a defect goes to `CHANGELOG.md`; what is open goes to `CLAUDE.md`; and the build belongs on the PHASE
row, once, not on twelve check rows.

### A predicate that answers "no" for a whole minute may be reporting a REFUSAL - ask the server before you change it

On 2026-08-28 five HEAL-NEW rows failed on `the census carries the new id: false (after 63762ms)`. The
bounded poll had done its job perfectly: it turned "sometimes false" into "false for 63.7 s", which is
the shape of a fact that is never going to be true. The conclusion drawn from it was that the
PREDICATE was wrong - the census reads `key_package`, so it asks whether a peer can address the
device rather than whether the device exists - and it was replaced with a read of `auth_sessions`.

**That reasoning was correct about the two columns and wrong about the defect.** The device really had
no KeyPackage, because `POST /api/mls/register-device` had answered **400**: the account was at the
server's fifteen-device cap, filled by the rig's own abandoned mints. The census was asking exactly
the right question and getting the right answer. Reading the session instead made the row PASS while
the device was addressable by nobody - a green row over a client that could never heal, which is the
worst outcome available.

**The cheap step that was skipped: the client had printed the status code.**
`[KP] Publication failed (Error: Failed to publish KeyPackage: 400 )` was in the console of the very
run being diagnosed, and `[MEMBERSHIP_ACTIVE] REFUSED reason=no_key_package` was in the server log for
every group. A single `docker logs | grep` would have named the cause in seconds. Instead the
instrument was rewritten on an inference, and the inference was published.

**The rules that follow, and both are cheaper than the mistake:**

- **When a poll exhausts its deadline, the next question is "what did the server answer", not "is my
  predicate right".** A refusal has a status code and a log line; a wrong predicate has neither. Only
  one of the two can be checked in one command.
- **When two columns answer two different questions, read BOTH and report the pair.** Session and
  KeyPackage together mean enrolled; session without KeyPackage means refused, and names where to
  look. Choosing between them throws away the discriminator - which is the same fault, one layer up,
  as collapsing an exit code to a boolean.


### A predicate that names a state by page TEXT is matched by the page that documents that state

The encryption gate was detected three ways at once, and one of them was
`document.body.innerText.indexOf('PIN de chiffrement') !== -1`. `/settings` **names** the gate in its
own security section - `profile_pin_heading`, "Code PIN de chiffrement", which contains that
substring - so a client parked there read `LOCKED` while being perfectly unlocked. Measured
2026-08-28 on W1: `pin.mjs` spent its whole 25 s deadline and reported "no unlock modal",
`state.mjs` printed `LOCKED`, and `pingate.settle()` - whose `gate` branch is tested BEFORE
`mounted` - returns `LOCKED` to `comm17`, `comm18`, `comm22` and `tab3b`, none of which produces a
verdict when the gate cannot be passed. W1 was on `/chat` with eleven sidebar buttons two commands
later; it had never been locked.

**A gate is a MODAL, not a phrase.** The prompt is `PinModal.svelte` through `shared/Modal.svelte`,
which carries `role="dialog"` and `aria-label={title}` - so it is identifiable EXACTLY, by the label
of a dialog, instead of approximately by any text anywhere on the page. The corollary is the older
rule again: a predicate is only evidence for the question it was written to answer, and "the page
mentions the PIN" was never that question.

**And it had THREE COPIES, which is why the loosest one decided.** `pin.mjs`, `pingate.mjs` and
`state.mjs` each carried their own, and `pin.mjs` carried a fourth as its "the modal is gone" check.
They now import one `GATE_EXPR` from `gate-probe.mjs`, and `gone` is that expression NEGATED.
`gate-probe-selftest.mjs` classifies eleven pages, four of which are the ones that used to be
misread - `/settings`, prose anywhere, the device panel, and a fresh phone's biometric offer.

### An `INVALID` that carries no console cannot say why the question was unaskable

**Measured 2026-08-29.** `healnew.mjs` had six `INVALID` exits and not one attached its observer,
though the observer is installed before the wipe and exists on every one of those paths. So the row
could say *the sidebar was already green* and nothing about WHY - and on HEAL-NEW-15 that was the
row's own question. The console held the answer the whole time: ten `welcome_request`s answered in
two seconds, twenty seconds before the runner believed the client was live.

Six copies of a record-close-exit sequence is also five places for the next field to be forgotten in.
One helper takes the report ONCE - reporting twice on one observer drains the second read - and it
uses `record`, never `finishObserved`: an `INVALID` is already not a pass, and `gate()` exists to
downgrade a verdict about the product, which an unaskable question is not.

### A duration is evidence only for the interval it was measured over, and a NAME has to say which

The same change moved the enrolment poll from inside the mint to after the row's watch. The numbers
did not change shape - `Date.now() - askedAt` still - but their meaning did completely: the poll now
starts minutes after the device went live, so what used to be the enrolment latency became "no later
than this". Renaming them `registeredWithinMs` / `addressableWithinMs`, measured from an explicit
`liveAt`, and pairing each with `registeredWasAlreadyTrue` / `addressableWasAlreadyTrue` is what keeps
a reader from doing arithmetic the number cannot support. The first run after the split recorded
`10152 ms` with `alreadyTrue: true` - a bound and an admission, where the old name would have read as
a ten-second enrolment.

**And a field nothing sets is worse than a missing one.** `enrolledInMs` was reported by two call
sites and returned by nothing, so the ledger carried `null` under a name that reads like a
measurement. It was removed with the split; the fields that exist replaced it.

### A criterion must be shown to FAIL on a dirty device before a green from it is worth anything

`footprint.mjs` existed for one reason: `[RESET] done - nothing of this device remains` is a claim
about the steps that ran, not about the disk, and twenty HEAL rows asserted the log line. Its whole
criterion was `canariDatabases === 0`, which is sound on a browser, where nothing but a signed-in
session creates a `CanariDB`.

**On A1 it returned "nothing of the account remains" while the phone was displaying eleven
conversations.** A Tauri client keeps its messages in native SQLite, so that count is 0 on a fully
enrolled phone and 0 on a wiped one. The predicate could not fail on the device class it was being
used to judge, and it had been read as evidence three times.

Nothing subtle was needed to catch it - only running the criterion against a device known to be
DIRTY, once, and requiring it to say so. That is the whole test, it costs one command, and it is the
step that was never taken:

- **Before believing a criterion's green, run it on a device you know is loaded and require a red.**
  A criterion that answers the same on both populations is measuring neither. This is the same fault
  as a predicate asserting against a gesture the instrument itself made, arrived at from the other
  side: there the instrument caused the answer, here it could not see it.
- **A total, not a name, is not a criterion.** The native byte total read 19 MB with the account gone
  and 31 MB with it present, on the same device within the hour - the running WebView's own cache
  moves it by more than the account does. `nativeResidue()` answers WHICH paths survived instead, and
  an empty list is a claim that can be wrong out loud.
- **A device with two stores needs a verdict over BOTH, computed in one place.** The web half was
  clean and the native half held twenty-nine paths; two separate readings had been taken and the
  clean one quoted. `footprint.mjs --device A1` now reads the native half itself and returns the AND,
  and a native half it cannot read voids the verdict rather than passing it.

**AND "IN ONE PLACE" MEANT IN THE COMMAND-LINE BLOCK, WHICH IS NOT A PLACE A RUNNER CAN REACH.** The
AND above was written inside `footprint.mjs`'s `import.meta.url === ...` guard, so `bun footprint.mjs
--device A1` was correct while `healrevoke.mjs` - the runner that actually records the row - imported
`nothingOfTheAccountRemains` and asserted the WEB HALF ALONE. The fix that closed the defect for a
human reading a terminal left it open for every row, which is worse: a row's verdict is believed
later, by someone who was not there. Caught before any HEAL-REVOKE cell was taken on a phone, and only
because the row for A1 was being written; nothing would have reported it.

The verdict is now `deviceResidue(label, cx)`, exported, with the pure combiner
(`residueVerdict`) beside `classifyNativePaths` in `native-residue.mjs` so
`residue-selftest.mjs` pins it with no device and no `names.mjs` - nine new cases, one of them the
exact reading that cost three sessions. **A CLI ENTRY POINT IS A CALLER, NEVER A HOME.** Anything a
row asserts on has to be reachable by import, or the tool and the runner are two implementations of
one criterion and only one of them is ever exercised by hand.

### A green sidebar tile does not prove the group is not epoch-forked

Measured on production 2026-08-29, while diagnosing the write-side entrance to the recovery ladder.
Two conversations, `3ca20e77` and `6e7c9ab1`, had been forked one epoch behind for twenty-four hours:
every commit W1 staged in them was refused, 191 and 172 times, and no message could enter or leave.
**Both tiles read `data-ready="true"` on W1's sidebar for the whole of it**, and every `readAll` this
rung takes reported `syncing: 0`, `amber: []`.

That is not a bug in the tile. `data-ready` says the conversation has a local MLS group and has
finished its initial load - which was true, and stayed true, because a fork does not unload anything.
It is the instrument's mistake to have read it as more: **`watchRows`'s settle predicate counts ready
tiles, so it is green on a device that cannot send or receive in the group it is green about.** The
fork was found in the SERVER's refusal count and nowhere else; nothing on any screen in this rig
would ever have said it.

So a settle predicate built on tile readiness bounds exactly one thing - *the list finished loading* -
and never *this device is in step with the group*. Any row wanting the second has to ask for it, by
the epoch or by a round trip through the group, and **no row on the board asks**. This is the same
fault as the `footprint.mjs` reading two paragraphs below and as
[the column rule](durable-rules.md): a signal is evidence only for the question it was written to
answer, and readiness was written to answer whether the list had painted.

### A termination proof must be about the unknown ITS OWN row is aimed at

`subsetSettled` was written for HEAL-NEW and reused verbatim by HEAL-REVOKE, and the reuse was wrong
in a way neither row could report. It reads: *of the rows this device already has, the ones some
responder could serve are ready.* On HEAL-NEW that is a complete proof, because the server lists a
fresh device into its groups before the watch opens - the sidebar already holds every row it will
ever hold, and only the COLOUR is unknown. After a revocation wipe the sidebar starts **empty** and
the rows arrive one at a time, so PRESENCE is the unknown, and a predicate that looks only at rows
already present is satisfied by the first one to land.

Measured on `96bdd1bb`, HEAL-REVOKE-5. The returning device recorded `+0ms rows=0` then
`+6022ms rows=1 ready=1` and was declared settled; the reference, minted through `newdevice.mjs`,
walked into its own watch already holding twelve. The row's last unmet expectation was
`itEndedWhereAFreshDeviceEnds`, `rows: 1 vs 12` - the equality failing not because the product healed
one group of twenty-one, but because **one device was judged after six seconds and the other after a
minute**, which is [the interval rule](#a-duration-is-evidence-only-for-the-interval-it-was-measured-over-and-a-name-has-to-say-which)
arriving through the settle predicate instead of through a name.

The fix is a second predicate, `subsetArrivedAndSettled`, and NOT a change to the first: made strict,
`subsetSettled` would demand the peer responder's own groups of a device that is not a member of them
and stall HEAL-NEW forever. Two rows with two different unknowns need two proofs, and the self-test
now carries the pair - including the case that states the defect outright, *the loose predicate calls
this same sidebar settled*.

The owed set is then an INTERSECTION, and each half alone is a false verdict in a different
direction. What a responder can serve, without membership, is the peer's rows - demanded of a device
that will never see them, a 600 s stall reported as a defect. Membership without serving is a row
nothing online could hand over - the same stall, and the reason the subset rule exists at all. The
runner reads membership from the actor, which is the subject's own other device, and a set it could
not narrow stays EMPTY so the existing `theSettlePredicateKnewWhatToWaitFor` guard calls the row
unobservable - **never a silent widening back to the loose rule, which is a fallback and would turn a
stall into a PASS.**

### A premise a row never LIFTS is not a premise, it is a different question

HEAL-REVOKE-7 exists to ask whether the ORDER of a revoked device's return changes where it ends up:
`--order first` returns before the account's other clients are online, `--order last` after. The
runner implemented `first` by setting the topology to nothing and leaving it there for the rest of
the row.

**Nothing about the product could then make that half pass, and the reason is arithmetic rather than
protocol.** The subset a return must wait for is what the world can SERVE intersected with what the
subject is OWED, and the servers are read from the account's own online clients - so with none online
the subset is empty, and `subsetArrivedAndSettled` refuses an empty subset by construction. The watch
could therefore never terminate whatever the app did. On 2026-08-30 the row sat at `25 rows, 0 ready,
25 syncing` from its first sample to the 600 s deadline.
Three expectations - `bothSettled`, `theNewGroupArrived`, `theSettlePredicateKnewWhatToWaitFor` -
were unsatisfiable by any behaviour of the app, and a `FAIL` would have been recorded against the
product for a world the rig had built and never taken down.

**A GUARD THAT EXCUSES THE SYMPTOM HIDES THE DESIGN ERROR.** The runner already knew the subset would
be empty and carried an exemption for it: `theSettlePredicateKnewWhatToWaitFor` demanded a non-empty
world *only where the row's own topology put someone there*. That reads as care and it was the
opposite - it let the one row that could never settle stop reporting that it could never settle,
while every other expectation still failed. The exemption was deleted, not widened: every order now
reaches the watch in a world that can serve, so an empty subset there is a rig fault in any order.

**The shape of the fix, and why it asserts MORE than before.** Isolation is a PHASE of the row, so it
is observed, asserted on, and then ended:

1. the device returns with nobody of its own account online;
2. it is watched for an interval and the state it reaches is RECORDED;
3. the actor is brought up, and only then does the settle watch open.

The comparison the pair exists for is now between two devices in the same populated world, which is
the only comparison that means anything.

**STEP 2 WAS AN ASSERTION FOR EXACTLY ONE RUN, AND RETRACTING IT IS THE MORE USEFUL HALF OF THIS
ENTRY.** It claimed that a row going ready with no client of the account online could only have come
from a store the revocation should have taken - HEAL-REVOKE-1's P1 by a second door. The window ended
with one row of 26 ready and the assertion failed on it. **Three causes produce that one row and the
rig can separate none of them:** `externalJoin` on a community's key-distribution group is a
documented self-service path that needs no server at all and the 2/12 ORDER PAIR recorded it; a
Welcome is owed by A MEMBER rather than by another device of yours - the app says so in the line it
logs, `sendWelcomeRequest… (invited, Welcome owed by a member)` - so any other member of a shared
conversation can serve one, and killing the account's own clients does not isolate the device from
them; and the defect the assertion was written for. **An assertion resting on a premise its row never
established is not a weaker test for being removed - it was never a valid one**, and the honest
disposition for a measurement whose causes are not separable is to record it and assert nothing.
Naming the self-servable rows is what would make a claim possible here, and that is a piece of work
rather than a line.

**THE ONE TIMER, AND WHY IT IS ALLOWED TO EXIST.** Step 2 observes a state that only exists for as
long as the isolation lasts, so it needs a window. The window is not a constant: it is three times the SEED device's settle
time, measured minutes earlier in this same world on this same account, so it scales with the size of
the account rather than assuming one. And it is wrong LENIENTLY in both directions - too short makes
the negative trivially true and asserts less, too long only costs time - so no setting of it can
manufacture a failure. **A window that can only ever under-claim is a different object from a
deadline that decides a verdict**, and the row's real claim remains the final-state equality.

**A NUMBER THAT TWO CAUSES PRODUCE IS EVIDENCE FOR NEITHER, AND THAT APPLIES TO THE WINDOW ITSELF.**
A low ready count is true of a device that was served nothing and of a device that left `/chat` two
seconds in. The phase therefore records why it ended alongside what it reached, so a reader can tell
a window that ran from a window that broke - which is the same discipline that retracted the
assertion, applied to the measurement that replaced it.

## What the HEAL rung taught the instrument

Moved off the board on 2026-08-28 with the rest of section 16's prose. These are rules about measuring, not verdicts.

**A LAUNCHER CLICK IS JUDGED BY ITS EFFECT.** A button that has painted but not hydrated takes the
click and does nothing with it - `realClick`'s recorder confirms the `BUTTON` received the event, so
no layer reports a problem - and the step then spends its budget waiting for a navigation that never
started. A dropped click is not cured by waiting longer, so the step retries and ends on a fact.

**THE DIRT EVERY FRESH DEVICE CARRIES.** `[History] frame never read here and unreadable for good
(past-epoch-application); will reconcile` arrives once per frame older than the device's own epoch -
hundreds of lines on an account with history. A device that was not in the group at that epoch
genuinely cannot read those frames, so the condition is expected; what is not settled is whether
`severe` is the right level for it, and until that is answered **every row on this rung is
`PASS-DIRTY` at best**, which is a reporting question standing between this rung and the `PASS` the
user asked for.

**What that says about this board is the point.** The defect is invisible to every row here, and to
the two HEAL-REVOKE cells that ARE green, because they assert the log line - `[RESET] done - nothing
of this device remains` - or the product's behaviour, and neither is a reading of the disk. It was
also invisible to every gate in the repo: nothing in CI compiles the Android app, so a missing class
in a LAYOUT inside a dependency reached a user. **A cell asserting an empty store after a revocation,
on BOTH halves, is therefore owed on A1 and on a web device**, and it is the only row that would have
caught this. Until it exists, a HEAL-REVOKE pass means the product recovered, never that the device
is clean.

**THE INSTRUMENT WAS THE REASON THIS TOOK THREE READINGS, and that is the transferable part.**
`footprint.mjs` answered **"nothing of the account remains" about A1 while the phone was displaying
eleven conversations.** Its whole criterion was `canariDatabases === 0`, and on a Tauri client the
message store is native SQLite - so the count is 0 on an enrolled phone and 0 on a wiped one. **A
predicate that cannot fail on the device class it judges is not a criterion**, and this one had been
read as evidence three times. Three changes, all in
[testing-methodology](testing-methodology.md): it also counts `mls_device_id_<userId>` and
`canari_device_key_vault`, which nothing but an enrolment writes; a new `nativeResidue()` reports
WHICH paths survived, because the byte total read 19 MB with the account gone and 31 MB with it
present, on the same device inside an hour; and for a Tauri origin the verdict is the AND of the two
halves, computed in one place, with an unreadable native half VOIDING it rather than passing it.
`logs/Canari.log` is reported separately - the running app rewrites it in milliseconds, the same
argument that keeps `PARAGLIDE_LOCALE` out of the web criterion.

### A fix that PREVENTS a state does not repair the instances it already made, and the next measurement measures those

HEAL-REVOKE-7 half B was re-run three times on 2026-08-30 and the product changed only once. The
sequence is the lesson:

1. `FAIL` on `0f06a4b3` - the row's own P1: a group forgotten 291 ms after creation, so it reached
   neither device.
2. `FAIL` on `edb8d7ab`, the build carrying the fix. `equalityGap: ["rows: 12 vs 13",
   "syncing: 0 vs 1"]`, and the single group in the gap was `8868be1c` - **the very group the P1 had
   destroyed the night before.** The fix stopped new corpses; it could not raise the old one.
3. `PASS-DIRTY` on the same `edb8d7ab` after `cleanup.mjs` swept it - `unmet: []`, `equalityGap: []`,
   11 rows and the same eleven ids on both devices. No code moved between 2 and 3.

**So a green build is not a clean world, and the second run's `FAIL` was honest.** The corpse was a
live group whose `dm_device_group_memberships` row said `active` for a device holding no MLS state:
the server went on offering it to every device that enrolled afterwards, each landing `pending` for
ever. A freshly minted reference dutifully built a thirteenth row for it and left it amber; the
returning device built none. **Both behaviours are defensible and they DIFFER, which is exactly what
this rung asserts must not happen** - so a defect class the row is not about can fail the row. It is
recorded as its own P2 in [backlog](backlog.md), with the population, because the answer to "how many
more of these are there" is a number and nothing on the board asks for one: 22 of the 24 pending
invitations on live groups were older than an hour, across five groups, three of them real
conversations rather than harness debris.

**The instrument rule.** After fixing a defect that WRITES bad state, sweep the state before the
re-run, and say in the cell that you did - otherwise the re-run is measuring the old defect and the
verdict cannot distinguish "the fix does not work" from "the fix came too late for this row". The
sweep is an ALLOWLIST every time: here `debris.mjs`'s `HGRP` pattern matched three throwaway groups
and nothing else, and the three real conversations in the same shape were left untouched deliberately.
The converse trap is the one the P1 itself was: **a destructive path that decides a group is dead from
an incomplete read.** Sweeping the world and pruning inside the product are not the same act, and only
one of them is allowed to guess.
