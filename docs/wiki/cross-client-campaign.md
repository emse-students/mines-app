# The cross-client campaign - its shape, its scope and its standing rules

What the campaign IS. The live state of every check is
[cross-client-testing](cross-client-testing.md), which carries state and nothing else; how a result
earns the right to be believed is [testing-methodology](testing-methodology.md); how to operate the
instrument is [`tools/cross-client-harness/README.md`](../../tools/cross-client-harness/README.md).

Sibling of [device-verification](device-verification.md), which answers a different question: that
page asks whether a native path works **on hardware at all** (one device, one check); the campaign
asks whether the system stays correct when **several clients, several lifecycles and a damaged
store** meet.

## Where it runs, and what may never leave it

**TARGET IS THE LOCAL ESTATE** (`http://localhost:1420`), since 2026-09-03. Dedicated accounts,
a database restored from a full production dump, and a stack whose nginx is the same single entry
point production has.

**What moving off production bought, and it is more than convenience.** Three things the campaign
had lived with are simply gone. A run could be voided by a deploy landing under it - three
measurements died that way on 2026-08-27, two of them to DOCUMENTATION commits - and nothing
deploys under a local run. A run left DEBRIS on the production database that later runs then
measured and could not tell from real traffic; local debris is cleared by restoring the dump again.
And a check that damages a store, revokes a device or deletes a conversation was reasoning about
data real members depend on, which is why several rows are `SKIPPED` for a reason that is not a
technical one.

**What it costs, stated so no row silently claims otherwise.** Local is production's data, not
production's POPULATION: it is a snapshot, its push tokens are truncated by the copy, and its FCM
path reaches no real device. So **a rung whose question is about a population** - how many devices
are stranded, what the re-key rate is - measures the snapshot and says so on the row. And the
COOKIE is not the same: see the standing rules below.

**Pointing the rig is ONE line, and the claim that it was not is a correction this page owes.** It
used to say "89 files under `tools/cross-client-harness/` carry `canari-emse.fr` as a literal with
no central constant". That was wrong, and it was disproved by reading rather than by arguing:
`SITE` in the machine-local `names.mjs` is the single constant, with `ORIGIN[device]` beside it for
the phone, and everything else imports from there. **The correction matters more than the error** -
it was the whole stated reason the rig could not leave production, and it was never true.

**The phone enters over `adb reverse`, and that is per-device and does not survive a replug.**
Neither phone can reach `localhost` on the workstation otherwise. The APK still serves its own
frontend from `tauri.localhost`, so the phone's `ORIGIN` is not the site's - `bundle.mjs` derives
the web/phone split from `ORIGIN[device] === SITE` precisely so this stays one fact in one place.

**The rig is in this repository**, at `tools/cross-client-harness/` - the scripts that run, not a
copy of them. **Its STATE is deliberately outside**, in `../../canari-harness` (moved one level up
on 2026-09-03, so that nothing of the LITHIUM rig can be inherited by accident): the account file,
the two Chrome profiles (which ARE W1 and W2 - their MLS identity, their history, their login), the
verdict record, the APK and the phone baseline. **Two files stayed behind in the old directory on
purpose** - `play-console-sa.json` and `google-services.json` - because they are store and build
credentials rather than rig state, and other tooling records their paths. One constant, `STATE_DIR` in `names.mjs`,
bridges the two. Credentials outside the work tree **cannot** be committed, which is a structure; a
`.gitignore` rule would only be a policy, and this repository is public.

The two accounts appear in every document as **owner** (W1, A1) and **peer** (W2). No PIN, login,
display name, device id or group id belongs in a committed file. `idcheck.mjs` reads the staged index
and refuses the commit; run it before every commit that touches the rig.

**Every test message goes in the owner-peer DM, and nowhere else.** A one-off probe once fired a
"dangerous link" warning into a real colleague's thread. Anything needing a CHANNEL uses the
`Canari Test Venue` community - never MiTV, whose private channels are readable by every association
admin.

## How a check is written

Three rules from the user, and they are one design:

1. **A script covers a FEW checks, never a whole phase.** A file that owns twelve verdicts fails as
   one unit, and a single throw takes the eleven that had nothing to do with it.
2. **A check is INDEPENDENT.** It establishes its own precondition, leaves the clients in a state the
   next check can start from, and asserts nothing that another check had to arrange. Independence is
   what makes them runnable one after another as well as alone - the sequence is then a convenience,
   never a requirement.
3. **The dashboard carries state, never commentary.** [cross-client-testing](cross-client-testing.md)
   holds each check, its state, and the commit it last ran on. Prose belongs on the topical page, a
   story belongs in `CHANGELOG.md`, a rule belongs in [testing-methodology](testing-methodology.md).

## The three transports - read this before reading any phase

| World | What travels | Who can read it |
| --- | --- | --- |
| DM and group | MLS `AppMessage` protobuf, `POST /api/mls/send`. Every MUTATION too - edit, delete, read receipt, pin, reaction removal - as a `SystemMsg{event, data}` sent `silent=true` | members only; the server stores ciphertext |
| Community channel | REST on social-service + a Redis broadcast relayed by the gateway. Server-held `masterSecret` per epoch, NOT MLS | **the server, in cleartext, INCLUDING message bodies** - every epoch key is `HKDF(masterSecret, ...)` and the secret is a plain Postgres column |
| Ephemeral | WebSocket JSON: `ping`, `disconnect`, `welcome_request`, `typing`. Nothing else | online peers, now, or never |

## The ladder

| Token | Meaning |
| --- | --- |
| `W1 W2` | the two browsers, both online, nothing else |
| `+A1` | the phone as a third client |
| `+push` | FCM, so the phone AND a background, doze or killed state |
| `+snapshot` | an MLS or app-data snapshot taken **before** the check, because the check breaks something |
| `+user` | a step no tool here can perform: the owner account's 2FA, the lock-screen pattern, a biometric prompt |

**`+user` IS A COST, NOT A BLOCKER - and the user said so in as many words on 2026-08-27:**
*"je suis la, donc la 2FA, me login, redemarrer le telephone etc est possible."* So a row may not
be recorded `SKIPPED` on the mere PRICE of a 2FA, a re-login or a phone reboot while a human is at
the keyboard - ASK for it. That retires the only reason MULTI-3 and MULTI-4 were skipped on
`0c31be5d`, and it is what makes the eleven `HEAL-NEW-*` rows affordable at all. What `+user` still
means is that the row cannot run UNATTENDED: it may not be scheduled into a background sweep, and
the x5 sweep owed after the ladder must either budget a human or declare these rows out of it.

**The order is the numbered ladder and there is no other.** It is ordered by tier, so each rung
assumes what the one below it proved, and it already carries every sequencing constraint there is:
HEAL before MULTI and PIN because it rewinds W1's ratchet in every group, PIN after HEAL because
PIN-3 probes the lockout, CORRUPT last because it destroys state. **A second copy of this order was
kept elsewhere and drifted**, sending a run to FWD straight after READ on 2026-08-15. Two orders in
two places IS the fault; if the order changes, it changes here.

| Tier | What it establishes | Rungs |
| --- | --- | --- |
| A - the floor | nothing higher can be interpreted until these hold, and they are re-proved in the SAME session, never cited from a previous one | 0 SETUP, 1 MSG, 2 TYPE |
| B - a message that already arrived | one delivered message and the states hung off it; each rung adds one mechanism to a path rung 1 proved | 3 READ, 4 MUT, 5 SEARCH, 6 MENTION, 7 FWD |
| C - the container | the conversation itself changes: members, epochs, existence. Everything here can break a path tier B just proved | 8 GRP, 9 COMM, 10 DEL |
| D - several clients, several lifecycles | more than one context of one identity, then the phone, then the phone asleep. A failure here is attributable because A-C fixed what a single online client can get wrong | 11 TAB, 12 MULTI, 13 LIFE, 14 NOTIF, 15 CALL |
| E - deliberate damage | destructive, ordered by how expensive the way back is. Nothing after a rung here is trusted until its teardown restored the invariant | 16 HEAL, 17 PIN, 18 CORRUPT |

### What the ladder is allowed to contain

Two standing instructions from the user govern the scope, and they are why the ladder covers the
feature surface rather than the incident history: *"Vraiment je veux que cross-client-testing soit une
matrice parfaite de tout ce qui est possible de faire avec les messageries/communautes"*, *"Tester les
appels audios et video aussi"*, and *"J'ai dit que je voulais tous les tests possibles, qu'ils soient
plus ou moins absurdes, plus ou moins courant. Un test absurde qui provoque une incoherence peut
servir dans d'autres contextes que celui de ce test absurde"*.

So a hole is visible as an empty cell rather than as the absence of a memory, and the absurd
crossings get rows. That is not a hypothesis: the first question ever asked of the DEL phase - which
existed only because deletion had never been a subject, only a step - found a defect sitting in
production.

## Standing rules for every check

Decided with the user, not to be re-litigated.

- **THE REFRESH COOKIE IS NOT THE SAME LOCALLY, AND EVERY ROW THAT REASONS ABOUT IT SAYS SO.**
  `auth.controller.ts` emits `Secure; SameSite=None` in production and flips to `SameSite=Lax`
  without `Secure` as soon as `ALLOW_INSECURE_COOKIES=true`, which is what local runs with
  (decision 11 of the [workflow migration](workflow-migration.md), a documented reservation and not
  a defect - plain HTTP has no `Secure` cookie to send). On a stack where the frontend is
  `localhost:1420` and core is behind nginx on `localhost:8081`, `SameSite=Lax` is enough, because a
  differing PORT is still same-site. **So a row whose question is about CROSS-SITE cookie behaviour
  measures something else here** - the session rows, anything about a cookie surviving a
  third-party context, anything comparing the web credential with the `X-Canari-Refresh` header the
  Tauri clients carry instead. Such a row is not `SKIPPED` and it is not silently believed: it
  carries the reservation in its own cell, so a verdict cannot be read as covering the production
  cookie policy. The rule is the general one this repository already has - **a column is only
  evidence for the question it was written to answer.**

- **Six rungs ARE the target, and the other four come after them.** The campaign runs in autonomy
  by the user's decision of 2026-08-21 (*"C'est parti pour la campagne"*), top of the ladder down,
  and their priority of 2026-08-27 is verbatim: *"PASS ou PASS-DIRTY sur COMM, DEL, MULTI, LIFE,
  NOTIF, HEAL."* TAB, CALL, PIN and CORRUPT are reached only once those six read one of the two.
- **A `PASS-DIRTY` does not stop a rung by itself** (user, 2026-08-25). The x5 sweep of the whole
  ladder accepting nothing short of `PASS` comes AFTER the ladder is finished (user, 2026-08-26) -
  so a dirty verdict is a row on the second pass, never a blocker on the first.
- **The order the rungs are owed in, once a device exists**, is not the ladder's order: the `+A1`
  rows first; then **HEAL-REVOKE-1 to -4, which have NO RUNNER and are what actually closes the open
  P1**; then the ungated re-runs of HEAL-NEW-1 and -3; then every DEL and MULTI cell, because both
  runners have CHANGED since their verdicts were taken; then LIFE and NOTIF. CALL, CORRUPT and PIN
  have no runner at all.
- **A defect is fixed and pushed the moment it is found.** Prod is the test server, so the fix is
  verified RUNNING, which is the only thing this campaign is for. Consequence accepted: every deploy
  invalidates the loaded bundle, so `reload.mjs` runs again after each one.
- **Then EVERY check the fix could touch, however remotely, is re-run - err wide.** Verbatim: *"quand
  tu fixes quelque chose, il faut refaire tous les tests qui peuvent etre touches de pres ou de loin
  par ce que tu as fait, vois large"*. A narrow re-run is a guess about a blast radius nobody
  measured, and this campaign has been wrong about exactly that twice.
- **Every fix also pays down the cost of the NEXT check.** Verbatim: *"si tu dois faire un fix,
  profite pour rendre les tests suivants plus rapides et plus faciles"*. An `aria-label`, a
  `role="option"`, a stable `id` is simultaneously what a screen reader announces and what a harness
  selects on, and both outlive a Tailwind class or a portal's screen position.
- **`recon.mjs` starts from a known baseline, and `LOSS` on the W1/W2 pair is the EXPECTED verdict
  until the number changes** (established 2026-08-19). **Five** message ids, all on W1 only, all
  created 2026-08-16 between 09:45 and 16:27 UTC. A run reporting five has found nothing; a sixth is
  new. Do not clear them - the divergence is the evidence. Why they are believed never to have left
  the sender is WP-ECHO-1's, in [backlog](backlog.md).
- **Observation is part of every check, not a debugging step.** A verdict is `PASS` only if the
  assertions hold AND the run is clean, on every client and on the server.
- **Reconciliation runs after every phase, not once at the end.** `recon.mjs` is the only instrument
  that can SEE this codebase's loss class, and a diff taken only at the end cannot say which phase
  opened it.
- **The destructive phases proceed unattended**, PIN and CORRUPT included. The floor under that is
  SETUP-8's archive plus the fact that a full re-enrolment is always possible; it costs the 2FA.
- **The `+user` rows are BATCHED to the end**, not asked for as they arise. **The phone otherwise is
  free** - reboots, radio cycles, forced doze and `install -r` need no warning.
- **NOTHING NAVIGATES THE PHONE ANY MORE, AND THE ONE EXCEPTION SAYS SO.** `goto` refuses A1 unless
  the caller passes `{ relaunch: 'why' }`, because replacing the document re-locks the PIN *and*
  breaks Tauri's in-flight IPC callbacks - which is what MUT-18's `runCallback` dirt was
  (methodology rule 21). `openChannel` is the last holder of that opt-in: there is no click path to
  `/communities` on the phone yet, so a phone verdict inside a CHANNEL check that goes dirty on a PIN
  modal or a `runCallback` exception is the RIG, not the app. Writing that click path removes the
  last A1 reload from the campaign.
- **The phone runs the assets bundled into its APK.** A wire-protocol change reaches the browsers the
  moment CD is green and reaches A1 only through a new build. Either state the fleet is mixed and say
  which branch each A1 row is reading, or rebuild before the device rungs - never report an A1 verdict
  without knowing which of the two it was.

### The four decided 2026-08-21, when the campaign was launched

Asked and answered before the first rung, because each one changes what the run costs and what it is
worth. They hold for the whole campaign and are not re-litigated inside it.

- **Every empty phase gets its runners written, CALL included.** Six phases had no instrument at all
  when the campaign opened - DEL, MULTI, CALL, PIN, CORRUPT, and GRP beyond `grp-traffic.mjs`, about
  fifty-six checks. They are written **as the ladder reaches the phase**, never in a batch ahead of
  it: writing a phase and running it later is verification by COMPILING, which is the thing this
  campaign exists to refuse. Each new script joins `checks.mjs` in the commit that writes it.
- **One pass everywhere first, five passes where a race is the subject.** The ladder is walked once
  end to end so that every row carries a verdict on one known build, and only then is `--repeat 5`
  spent on the rows whose subject IS an intermittency - a reconnect, an outbox drain, a merge, a
  rewind - and on any row a first pass found unstable. Breadth before depth: a phase with no verdict
  at all is a bigger hole than a phase with one.
- **The APK is rebuilt after every fix that touches the mobile path.** The alternative - one build at
  the start - leaves every defect the campaign finds unverified on the client that cannot receive a
  deploy, which is the one place a Tauri capability, a Kotlin path or a native store can fail alone.
  A build costs minutes and forbids any other frontend build while it runs; that is the price of a
  phone verdict meaning anything. `a1Build` on the row still names which bundle answered.
- **A defect is fixed and pushed on discovery; the blast radius is replayed before the next rung.**
  The phase in progress is finished on the new build, then everything the fix could touch is re-run,
  and only then does the ladder descend. Deferring the wide re-run to one pass at the end would leave
  a rung's verdicts standing on a build that no longer exists; replaying it the instant a fix lands
  would restart the ladder from the top on every defect. The end of a phase is the seam that has
  both properties.

### What stops the ladder, and what only gets recorded - decided 2026-08-25

**The user's decision, taken with three quarters of the ladder still owed:** *"on peut se contenter des
pass dirty et passer a la suite"*, then the criterion that makes it usable: *"Rien ne t'empeche de
corriger les causes des dirty en parallele, mais si c'est du cosmetique et pas du fonctionnement, ca ne
doit pas etre bloquant"* - and, asked what functional means, *"une ligne de fallback ou de heal non
voulue par exemple"*.

So a `PASS-DIRTY` is no longer a stop by itself. What decides is the CLASS of the dirt:

- **It STOPS the rung** when the dirt shows the application taking a REPAIR it should not have needed -
  a fallback line, a heal, a recovery, a re-add, a reconciliation. That is the same sentence as the
  standing rule "a fallback is a signal, never a path": the line is the visible end of a primary path
  that failed, and the fix belongs there. It also stops when the dirt is UNCLASSIFIED, because a line
  nobody has read is a line whose class nobody knows, and when it touches the assertion itself.
- **It is RECORDED and the ladder moves** when the class has been read and named and the assertions
  held. The verdict on the board stays `PASS-DIRTY` with the dirt named - never promoted to `PASS` -
  and the cause becomes an entry in [backlog](backlog.md) worked in parallel.

**This is not a relaxation of any assertion, and the distinction is the whole point.** No check is
weakened, no gate gains a flag that disarms it, no dirt is deleted from a row: `run.mjs` still exits
non-zero on anything that is not a clean `PASS`, and the board still says what happened. What changed
is only who decides whether a named, non-assertional defect blocks the next rung - and that was always
the user's call rather than the rig's.

**The first application of it is GRP-3**, accepted the day the rule was written: one live
`Network.webSocketClosed` on W1 that no navigation explains, all six assertions held, cause open as a
P2. It sits close to the stopping side - a socket that dies makes the client reconnect, which is a heal
- which is why it is being probed in parallel rather than merely filed.

### What the rest of the ladder costs, measured 2026-08-24

The bullet above says the empty phases get their runners written as the ladder reaches them. This is
what that bill actually is, counted from the board's rows against `checks.mjs`'s `PHASES` - so it is a
measurement and not an estimate, and it is re-countable in two `grep`s. **Rungs 9 to 18 carry 129
rows and 58 of them have an instrument** (46 when this was first counted on 2026-08-24: TAB gained
three runners and DEL was found to have had nine all along), which means 71 rows still have no
instrument at all and the remaining campaign is dominated by WRITING runners, not by running them.
Whoever plans a session on this should read the third column, not the first.

| Rung | Rows | With a runner | Owed | What the gap is |
| --- | --- | --- | --- | --- |
| 9 COMM | 25 | 25 | 0 | fully armed, and armed for the first time only now the phone answers: 4 of the 25 need A1 (`PHONE_SCRIPTS`) |
| 10 DEL | 10 | 10 | 0 | fully armed, and this row claimed one runner of ten until 2026-08-25 - a count left behind by its own phase. `del1.mjs` covers DEL-1 and `del.mjs --only N` covers the other nine, DEL-8 last because it rewinds a ratchet. Eight of the ten are already `PASS 1/1` on the board; what DEL owes is RE-RUNS (DEL-1 on its rewrite, DEL-10 on the deployed fix, DEL-8 never run), not runners |
| 11 TAB | 8 | 8 | 0 | fully armed 2026-08-25. TAB-1 was RE-SCOPED to write it: half its stated subject (title/badge) does not exist in the product, and the signal that does exist is a web `Notification` no DOM probe can see. TAB-3b decomposes the cold start into launch/render/unlock/queue, because the 77.7 s the board records is unattributable as a single total - and has no row behind it in `results.ndjson` |
| 12 MULTI | 6 | 0 | 6 | zero coverage by declaration |
| 13 LIFE | 8 | 6 | 2 | LIFE-1, and LIFE-5 which is a HUMAN check by design - it needs the unlock pattern after a reboot, so it belongs on [device-verification](device-verification.md) and will never have a runner |
| 14 NOTIF | 21 | 5 | 16 | `notif.mjs` answers 4/9/10 and `notif7.mjs` answers 7/7b; the other sixteen have nothing |
| 15 CALL | 20 | 0 | 20 | the largest single hole on the ladder, and the only rung whose subject (WebRTC media) no existing runner touches at all |
| 16 HEAL | 22 | 4 | 18 | HEAL-W1/W3/W4, the four `HEAL-REVOKE-*`, and the ELEVEN `HEAL-NEW-*` added 2026-08-27. The rung doubled because the eleven original rows all break a device that ALREADY HELD the group, and the user reports the sensitive path is the one where a device has never held anything - see section 16 of the [board](cross-client-testing.md). All eleven are `+user`, so the rung now needs a human present |
| 17 PIN | 10 | 0 | 10 | zero coverage; SETUP-7 is owed before it |
| 18 CORRUPT | 10 | 0 | 10 | zero coverage; SETUP-8 is owed before it |

Two consequences worth stating once. **SETUP-7 and SETUP-8 both need A1 and both gate a rung**, so
they are owed before 17 and 18 and not at the end. And **LIFE-5 is the one row on the whole ladder
that cannot end green through this rig** - it is not a hole to fill but a check that belongs to a
human, which is exactly the distinction `device-verification.md` exists to hold.

## Pre-flight, and none of it is a check

A run that skips this measures the previous build.

| Gate | Why it is a gate |
| --- | --- |
| Prod version + `minClientVersion` | a client below the floor is bounced, and the run would be measuring the bounce |
| `git fetch` | another contributor pushes to `main`; the local tree is not the deployed truth |
| One app tab per browser | a second tab is a second MLS client on that profile, and every probe resolves a client by position among the tabs. `run.mjs` closes extras before every job; `onetab.mjs` is the manual repair |
| `reload.mjs` on W1 and W2 | a browser left open across a deploy runs yesterday's code and its log is read as if it did not. It detects staleness, repairs it, then RE-ASSERTS the build id |
| `unlock.mjs` | a launch, kill, reboot, radio cycle or `install -r` re-locks the PIN, and a locked client reads as healthy on every screen that is not the gate |
| A1 present and DEBUGGABLE | `run-as` is how every at-rest assertion reads the phone; a release build refuses outright |
| The two profiles hold their identity | `chrome-w1` / `chrome-w2` ARE the devices - fingerprint them (device id, MLS blob size, conversation and message counts) |
| `recon.mjs` W1 vs W2 | the campaign starts from a reconciled fleet or it cannot attribute what it finds |
| `[HISTORY_RECONCILE]` quiet on all three | a client still asking for history is state the run would otherwise blame itself for |

## A row handed to another session - the delegation contract

The campaign is run by a TRUNK that holds the ladder's state and by delegated sessions that hold one
row each. A delegated session has this repository and nothing else: no chat history, no memory of the
previous rung, no idea which cell is owed. **So the prompt that hands it a row IS the interface, and a
prompt missing any of the eight points below buys a verdict nobody may believe** - the same failure as
an ungated runner, one level further out.

Written 2026-08-29, when this contract existed only inside a chat prompt - exactly what `CLAUDE.md`
forbids of any decision.

0. **ONE PROMPT, ONE ROW - except an ORDER PAIR, which is one question wearing two ids.** Rows 3 and
   11, and 2 and 12, assert an EQUALITY between a responder present from the start and the same
   responder arriving late, so the pair is adjudicated by reading two ledger lines against each
   other - and that is only legible if both ran under the SAME fleet. Split across two sessions it
   cannot be settled at all. So a pair goes in one prompt, runs adjacently, and the prompt says which
   comparison closes it.
1. **The row id, its question, and what its `expect` ENTAILS.** `PASS` is never "it went green":
   several rows on this ladder expect an outcome no repair can reach, so a row whose condition makes
   healing impossible must FAIL if it heals. The prompt STATES the entailment; it does not leave it to
   be inferred from the runner's source.
2. **The exact invocation, and the devices it demands.** Through `run.mjs`, so the preflight runs -
   `run.mjs`'s own flags first, then `--file <script>`, then the script's arguments.
3. **The preconditions the runner does NOT establish itself.** Whatever a runner assumes rather than
   asserts is a step in the prompt, not a hope.
4. **What to read in the LOG beyond the verdict, named precisely.** Never "read the logs". The
   reconciliations especially: one that DEFERS (`no member online - will ask when one returns`) is
   readable only against the instant the responder arrived, so the observation window has to COVER
   that instant - and where it does not, the question is UNDECIDABLE and the report says so instead of
   choosing.
5. **The security constraints, non-negotiable.** No credential ever on a command line (`accounts.mjs`
   is the only reader); output in ACCOUNTS, never in names; ids cut to 8 characters; this repository is
   PUBLIC and `names.mjs` is gitignored; a destructive control takes an ALLOWLIST (`--only <ids>
   --expect N`), never a denylist.
6. **The mutual exclusion is RETIRED, and what replaced it is closer to hand.** It said a run and
   a push to `main` could not overlap, because a push redeployed the server under the run. Neither
   half survives: a push deploys nothing since 2026-09-03, and the target is LOCAL, so no deploy is
   on the path of a run at all. `gh run list` is no longer a precondition for a row. **What does
   the same damage now is a `bun run dev` reload** - a save in the frontend while a run is in
   flight, which swaps the bundle under the clients exactly as a deploy did. It is more frequent
   than a deploy ever was and it has no run to watch, so `bundle.mjs`'s check is the only thing
   standing between it and a verdict about the wrong build. Do not edit the frontend during a run.
7. **Where the verdict is written.** The board cell - a verdict, a count, a time, four or five words -
   and the ledger; then `bun rows.mjs`, which is what proves the two vocabularies still agree.
8. **A branch CARRIES ITS ROW TO GREEN - it tests, and it FIXES, the product included** (user,
   2026-08-29). A row that ends `FAIL` because the product is wrong is not finished by reporting the
   `FAIL`: the branch diagnoses it, fixes it where the cause is, re-runs the row, and comes back with
   a `PASS` and the story. What it may never do is get there by moving the target - **fixing the
   PRODUCT is the job, weakening the TEST is the one forbidden move**, and they are easy to confuse
   at three in the morning. So a change that makes a row pass by asserting less, by widening a
   deadline, by adding a fallback, or by narrowing a population is out of bounds whatever it does to
   the colour. Three things still come back to the trunk before they are written, because they are
   decisions about what the campaign MEASURES rather than about whether the product works: **the
   scope of a row** (its topology, its `expect`, what it asserts), **a new row or a retired one**,
   and **a fix whose blast radius leaves the row's own subject**. Everything else - the diagnosis,
   the code, the test that changes with it, the CHANGELOG entry, the rule in
   [durable-rules](durable-rules.md) - belongs to the branch, and so does saying plainly when it
   could not get there.

**The trunk keeps the campaign's state and not the runs' logs.** A returned verdict updates the board,
`CLAUDE.md` and `CHANGELOG.md`, and whatever it closes is DELETED from all three - the board is a
state table, never a session journal.

## A commit from another contributor owes a WEB pass and a MOBILE pass

Their tests establish that their code compiles and that their units behave. They cannot establish
that it RUNS against this deployment, which is the only thing this campaign is for. So each of their
commits that lands in a measured surface gets two observations, and they are not the same observation
twice: a panel can render perfectly in a browser and be empty on a phone, because the two halves are
fed by different code.

The device-storage panels are the worked example. The WEB pass is the only one that can see an admin
panel reading four independent backend measurements, one across a service boundary - the exact shape
that fails only on a deployment, silently, when a variable is missing from a compose `environment:`
block. The MOBILE pass is the only one that can see a new Rust command that the web build never calls,
and a Tauri v2 command not granted in `capabilities/` builds, ships, installs and then rejects on a
real device. Three lessons generalise to every future one:

- **Assert on what the PAGE rendered, not on a probe of your own.** A bare `fetch` to the admin
  endpoint got `403` while the page beside it showed all four figures - the access token lives in
  MEMORY, never in a cookie. The 403 was the right answer to the wrong question.
- **Scope a log filter to the app's own pid.** `logcat -b all` carries the whole platform: an unscoped
  search for `forbidden` counted 26 "command rejections" that were the modem printing
  `Received Forbidden PLMNs`.
- **Prove WHICH bundle is running.** An install can succeed over a WebView that then serves a cached
  page, and the comparison must read `performance.getEntriesByType('resource')`, not `script[src]` -
  SvelteKit boots from an inline module, so a selector-based assertion finds nothing and silently
  asserts nothing.

**Leon pushes to Canari's `main` too**, and the same reasoning applies to every commit of his:
`git fetch` at the START of a session and again before any measurement, then `git pull` his work in.
His work does not concern the campaign and owes no pass of its own (user, 2026-08-21) - but a verdict
taken against a tree that is behind `main` is a verdict about something nobody is running, and that
is how a cell becomes wrong without anyone touching it.

## The negative rows - what does NOT exist

Written down so that no check is invented for them, and so nobody "fixes" one by reflex during a run.
Each was confirmed absent in the code on 2026-08-11, not merely unremembered.

**Messages.** Delete-for-me-only. Editing a channel message. A tombstone for a channel deletion (it is
a hard row delete). Disappearing, expiring or view-once messages of any kind. Chat drafts - the
composer is plain component state, so switching conversation loses it. Global or cross-conversation
search, any server-side index, and any search filter. A mention notification in a DM or group. A
read-receipt privacy toggle. An edit time window or edit history. A per-recipient *delivered* ACK -
`sent` means the server accepted the POST and nothing more. Any "forwarded from" attribution.

**Calls.** Screen share. Camera flip. A busy signal. Any signal back to the caller when the callee
declines. ICE restart or any mid-call reconnection. Android `ConnectionService`/Telecom. Any
participant cap. A call-history screen - the history is the system bubbles in the thread.

**Communities.** Join requests or approval. Bans. Renaming a community. A community description. A
channel description or topic. Channel reordering (only communities reorder). A community-level mute.
An endpoint to revoke an invite link, though the `revoked` column exists. Any MLS involvement in
community membership.

**Two of these are gaps rather than decisions**, and each has a check expected to fail rather than a
shrug: a reply quote keeps showing the snapshotted preview of a parent that has since been deleted,
and jumping to it lands on the tombstone; and `recordCallMissed` is invoked with the LOCAL user's id
on the caller's own device, so the caller sees a missed call from themselves while the callee who
never answered gets no missed record at all (CALL-18). Neither is a Work Package until a check
captures it. A third - a DM pin never reaching a device that was offline - is **fixed** since
2026-08-16, and MUT-15 asserts the recovery instead of the hole.

## Rows that named a mechanism the product does not have

The COMM rows were rewritten on 2026-08-20, and the reason is a class of fault the negative rows above
do not catch: a row can name a mechanism that never existed, or one that has since been deleted, and
still read as a perfectly good check until somebody sits down to automate it. **A row written from
what the product was believed to do is a claim about the product, and it expires.**

Four rows were rewritten, each for the same reason:

| Row | What it named | What is there |
| --- | --- | --- |
| COMM-6 | a CUSTOM role, created through the panel | `POST /api/channels/roles` is served and **no client calls it**. The panel renders the three roles a community is created with and a grid over them, and offers no way to make a fourth. The row now asserts the grid, the three defaults and a toggle that reaches the column; the unreachable endpoint is RECORDED by the runner, not asserted - a check cannot demand a feature, and only its owner can say whether an endpoint no client reaches is dead weight or an unbuilt one. |
| COMM-9 | a per-member key the server "revokes" | there is no such object. What the server does is drop the member's **routing rows** on the salon's distribution group, so the next Graine session never reaches them; the row asks for that, plus the previous session still opening. |
| COMM-13 | an admin being "granted" a private salon | joining one is an action the admin performs, not a grant. The row asks what a join changes - `distribution-group` 403 before and 200 after, the member list, the transcript unchanged, the row ceasing to offer the join. |
| COMM-22 | a function that had been deleted | it timed a code path that no longer exists. The row now times the FIRST RENDER of a salon carrying many Graine sessions, and the repair when one seed is missing - both observable from outside. |

Three rows were ADDED at the same time, for the per-salon distribution groups that shipped 2026-08-20
(COMM-23, COMM-24, COMM-25), which is what takes the phase to twenty-five.

**The rule this leaves.** A row is written against a mechanism that can be pointed at in the code or
in a log line, and a row that cannot be is rewritten before it is run - never automated as written and
never "checked by hand". The cost of not doing this is not a failed run: it is a PASS on a check that
was measuring nothing, which is the one outcome the campaign has no defence against.

## The at-rest artefacts

Enumerated for real at SETUP-7, not guessed - a corruption test written against a guessed key name
tests nothing and passes silently. **The web artefacts are keyed by the USER id**, so a test
hardcoding one client's key silently no-ops on the other. The device id is what the SERVER knows the
client by; it names no local artefact.

**Any check that reaches for a web artefact must enumerate `indexedDB.databases()` and match, never
construct a name.** A probe that built the names from the documented pattern reported "DB ABSENT" for
both databases - and worse than the wrong answer is what producing it cost: `indexedDB.open(name)`
CREATES when the name is absent, so the guess did not fail, it manufactured two empty databases
inside each profile under test and then declared the real ones missing.

| Client | Artefact | Path / key |
| --- | --- | --- |
| Web | MLS state | IndexedDB `CanariDBMls_<userId>` v1, store `state` |
| Web | message store | IndexedDB `CanariDB_<userId>` v6: `conversations`, `messages`, `outbox` |
| Web | device key vault | `sessionStorage.canari_device_key_vault` + `canari_device_key_vault_key` |
| Web | vault persistence flag | `localStorage.canari_device_key_persist` |
| Web | device id, last active, saved user | `localStorage.mls_device_id_<userId>`, `canari_last_active:<userId>`, `canari_saved_user` |
| Web | WS auth | cookie `canari_ws_token` - the only cookie readable from JS |
| Android | MLS state | `mls.bin`, at the app data **ROOT**, not under `files/`. ChaCha20-Poly1305, `[nonce 12 \|\| ct]`, **no version field** |
| Android | message store | `canari_<dev>.db` + `-wal` + `-shm`. **WAL mode, and the WAL is where the data is** - corrupting the `.db` alone tests nothing |
| Android | pending MLS, channel keys, push context | `mls_pending.db`, `channel_keys.json`, `push_context.json` |
| Android | device key | `shared_prefs/keystore_aliases.xml`, `<alias>_ct` / `_iv` |
| Android | push secret, native flags, app log | `pending_push_secret.txt`, `fcm_token.txt`, `native_flags.json`, `logs/Canari.log` |
| Android | WorkManager | `no_backup/androidx.work.workdb*` |

`run-as` reaches all of it **only because the installed build is debuggable**; a release build refuses
outright. Worth recording what is NOT there: **no access token in any web storage**, on either client
- the "access tokens in memory ONLY" rule holding in production.

## The campaign owns its own debris, and clearing it is a check in itself

A campaign that creates groups, devices and backlogs leaves state behind that later runs then
measure. **On a LOCAL target this got cheaper but not optional**: the way back is restoring the
production dump again, which is a minute rather than a `DELETE` somebody has to be trusted with -
and the debris still breaks the instrument between restores, which is the half that never depended
on which database it was. Clearing it is the last step of the ladder, after CORRUPT's rollback.

**IT IS ALSO THE FIRST STEP, because debris does not merely get measured - it BREAKS the instrument.**
Most checks build a salon inside the shared `Canari Test Venue` venue, which no runner deletes, so a
crashed runner's salon stays for ever. Measured 2026-08-21: 25 salons in that one community, 23 of
them debris, and at that length the community's own "add a channel" control sat at y=1149 in a
944-tall viewport - below the fold and unclickable. COMM-14 failed on it. The check could not build
its venue, in a community whose only problem was the debris of the checks before it. So `cleanup.mjs`
owns BOTH estates now, salons first, and it runs before the ladder as well as after it.

**AND THE VENUE ITSELF IS NOT PERMANENT - it is a FIXTURE, so it is asserted rather than assumed.**
It went missing twice on 2026-08-25, and both times the estate had been cleared by hand by the user
(*"Ah oui, j'ai tout supprime"*) - a legitimate action on their own production data, and one no
runner can be made to survive by being more careful. What made the two occasions different is all
that matters here:

- The FIRST time nothing asserted it. Rung 9 discovered it one row at a time - COMM-5, COMM-8,
  COMM-9/10, COMM-14, COMM-25 came back `VACUOUS` and COMM-23/24 `FAIL`, seven rows and a full cycle
  each, every one of them reporting "the community was never listed", which reads like a sidebar
  defect and was a missing fixture. Then it cost an afternoon of attribution: the culprit could not be
  found because the only log window covering the gesture had been destroyed by a deploy.
- The SECOND time, fourteen minutes after `venue.mjs --dry` had reported the fixture whole, the
  preflight refused the run outright and named the command that rebuilds it. Cost: one line of
  output, and the run started three minutes later.

- The THIRD time, 2026-08-26, the preflight caught it again and `venue.mjs` rebuilt it (`fbddc890` /
  `general` `064ac7d2`, 2 members). Three disappearances and the CAUSE is still unrecorded on all
  three - which is the open half of this: nothing yet says WHICH gesture removes it, only that the
  preflight now always notices.

So the rule is not "do not delete the venue" - it is that **`run.mjs`'s preflight reads
`channel_workspaces`, `channels` and `channel_members` before every phase**, and `venue.mjs` rebuilds
what is owed, idempotently, through the product and never through the database (a community inserted
as rows carries no key-distribution group, and every check posting into it would then be measuring a
venue no real gesture could have produced). Neither has a destructive path at all, so neither needs an
allowlist; the estate's destructive half stays in `cleanup.mjs`.

Its allowlist for salons is enumerated from what the runners mint - `c<n>-comm<n>-<mark>`, plus
COMM-12's `c12-<arm>-comm12-<mark>` - and a name outside that shape is listed for a human rather than
swept. Three such existed (`g3-priv-a` and two `rep-repair-<mark>`, from hand-made probes no runner in
the repo mints) and were deleted BY NAME, not by widening the shape: a pattern loose enough to reach
them is loose enough to reach a real salon.

**AND A DELETED GROUP IS TWO ESTATES.** Deleting it server-side clears it from the CREATOR's client
and from nobody else's: `initializeConnection.ts:171` forgets the member's WASM state - so she can no
longer send - and then calls `onGroupDeletedRemotely`, which marks the conversation `removed` and
shows it with a banner "instead of removing it silently". That state is a fact about what its owner
was TOLD, so no later reconciliation may reach past it (`decideAbsentGroupFate`'s first guard), and
the only exit is the owner clicking **"Supprimer localement"**. Correct for a person, wrong for a rig:
measured 2026-08-24, W1 - which creates and deletes - was clean at 9 conversations, while W2, which is
only ever a member, held **189** tombstoned rows from the GRP phase alone, each emitting a
`[DISCOVERY] ... kept` line on every load of every later check. `dismiss.mjs` sweeps that estate, from
`ConversationMeta.lifecycle` rather than from the row's caption - the sidebar preview of one of those
rows announces a member ADDITION, the last message from before the deletion, which describes the
conversation's state no better than any other message would.

It shares ONE allowlist with `cleanup.mjs` ([debris.mjs](../../tools/cross-client-harness/debris.mjs)),
because two lists disagreeing about what may be destroyed is the same defect with a longer fuse - and
it refuses to dismiss a group whose server row is still ALIVE, since hiding it from one device while
every other member keeps theirs is not cleaning up. **The 189 also measured the allowlist itself:** 22
were `GRP5-<mark>-R`, from the rename GRP-5 performs to prove a rename is a broadcast, and the pattern
matched neither them nor their tombstones - the server-side sweep would equally have spared a LIVE
`GRP5-*-R` left by a run that died between the rename and its teardown. Widened by ENUMERATING what
the runners mint (`grep -n renameGroup *.mjs` is the whole enumeration), never by relaxing a shape
until it fits.

**Delete test groups through the UI, never by SQL.** `DELETE /api/mls/groups/:groupId` emits nothing
to clients: the notice is an E2EE MLS `groupDeleted` system message the CLIENT sends *before* calling
the server, precisely because the server call hard-deletes `dm_group_members` and strips the routing a
later message would need ([groupActions.ts](../../frontend/src/lib/utils/chat/groupActions.ts)). An
`UPDATE` straight into Postgres leaves the peer holding a live MLS group for a conversation that no
longer exists - manufacturing the exact orphan state this campaign hunts.

**Revoke a dead client generation, do not delete its rows** - see
[chat-delivery](services/chat-delivery.md) for why. And two rules for any destructive cleanup script,
both learnt by nearly getting them wrong:

- **Name the target, never infer it.** The device dialog labels its rows "Appareil 1/2/3" and shows no
  id, so pressing on an ordinal is a guess between this browser, the phone and the debris - and a
  wrong guess destroys a live device's access. The id is in a `title` attribute; the script matches on
  it and **fails** unless it finds exactly one match.
- **Assert the post-condition, not the click.** The delete is asynchronous (MLS broadcast, then the
  server call), so a loop counting clicks reports success for a no-op. Poll until the entry actually
  leaves the sidebar.

A cleanup script must also only ever match the harness's own name prefixes: a real user's group sits
in the same sidebar.

**The messages themselves are NOT debris, and are deliberately not swept.** `Canari Test Venue` /
`general` is the standing venue nearly every channel row writes into, and nothing prunes it: measured
2026-08-22, 805 rows since 2026-08-19, growing with every pass of every phase. That is the one large
realistic corpus this campaign owns, and two things depend on it. SEARCH-4 times a channel search
over what is actually there, so a swept channel would measure an empty one. And `searchChannelHistory`
asks the server for at most 2000 rows, a cap SEARCH-2 can currently only reach through the *throwing*
branch because manufacturing 2000 messages inside a check is impractical - at this rate the campaign
manufactures them itself, and the capped branch becomes reachable for real rather than by proxy.

So the count is a MEASUREMENT to be watched, not a mess to be cleared. What it does owe is attention
when a latency changes: a send or an open that slows as this channel grows is the user's standing
requirement failing (*"doit marcher avec une conversation de toute les tailles"*), and it will show up
here first, on the venue with the most history, before it shows up for any real user.

**Which also means a channel timing is only comparable to another taken at the same size.** The venue
grew from 805 rows at 02:00 on 2026-08-22 to 1052 by 03:45 - roughly 250 an hour while the ladder
runs. Any row quoting a channel-path duration therefore has to say how large the corpus was, or it is
a number nobody can reproduce: the same check run a day later walks a different conversation. Rows
timing the DM path are unaffected, since those conversations are built per check.

## Measurements the board deliberately no longer carries

**The board is a state table, and a `PASS` cell says `PASS X/X` and a time.** That was decided on
2026-08-22 (the user: *"rien de verbeux quand c'est pass, je veux juste PASS X/X avec le temps si
pertinent"*), and it is not only a formatting preference - a cell that grows a paragraph every time a
check is hard-won stops being readable as state at all, and the paragraph is never about the pass. It
is about what the run cost to get. That belongs here, or in `CHANGELOG.md` if it was a defect.

A cell keeps prose in exactly two cases: the verdict is not a clean pass (`PASS-DIRTY`, `FAIL`,
`SKIPPED`, a partial like `4/5`), or the row carries an unresolved item such as a missing `a1Build`.
Both are open state, which is what the board is for.

What was removed on 2026-08-22, preserved because it was measured once and is expensive to measure
again:

- **FWD's first x5, 2026-08-22, read `NOT REPRODUCIBLE` on FWD-3/4/5 - and it was the INSTRUMENT, not
  the product.** `fwd345.mjs` recorded no verdict at all in passes 2 and 3, which is a `-` in the
  cross-pass table and is NOT a `F`: nothing failed, nothing was written. The evidence was
  unreadable, because `LOG_DIR` is one directory per RUN while the log filename was per SCRIPT, so
  inside a `--repeat` every pass overwrote the one before it and the two captures worth reading had
  already been replaced by passes 4 and 5 by the time the table said so. `run.mjs` now prefixes the
  filename with `pass<N>-`, so the capture of a failing pass survives the passes after it - the exact
  loss the whole-output write exists to prevent. **The re-run on 2026-08-23 came back `CLEAN 5/5`
  with all 25 rows persisted**, so the non-recording did not recur and there is no product defect
  behind it. It is written down because a one-off that leaves no trace is exactly what the next
  reader will otherwise rediscover from scratch.

- **THE WHOLE OF RUNG 9 IS ONE RE-RUN, not thirteen investigations (decided 2026-08-26).** Correcting
  the board against the ledger turned 23 `PASS` into 12 `PASS`, 10 `PASS-DIRTY` and 3 `FAIL` - and
  then showed that eleven of those thirteen rows carry the SAME dirt line on W2, naming the SAME
  salon: the one COMM-8 created at 21:27, whose own `FAIL` was `seedAfterTheGrant: false` on that
  salon, and whose distribution group W2 was still failing to join twenty minutes later. That is the
  stale published base COMM-22 measured head-on, fixed the same day. So the rung is re-run whole on
  the fixed build rather than triaged row by row, and the two rows outside that signature are named
  separately: COMM-18 (a `FAIL` at 22:02 next to a `PASS` at 19:47 on the same build - intermittent,
  needs the phone) and COMM-24 (already re-run and green on `2a4297cb`). The methodology this cost is
  on [testing-methodology](testing-methodology.md): the board reads the ledger's NEWEST verdict, and
  dirt is sorted across rows before rows are triaged.

- **COMM-22's believed `PASS-DIRTY` DID NOT HOLD, and what replaced it is a `FAIL`.** Read the
  paragraph below as the history of one attempt, not as the row's state: on 2026-08-26 the row
  failed on `2a4297cb` exactly as it had on `d6f61539`, with the same runner. The defect and its
  evidence are in [backlog](backlog.md); what the tenth attempt saw is kept because the SHAPE it
  describes - 13 epochs, 12 sessions, one message each - is what arms the row, and no message
  count can distinguish it from an unchurned salon.
  It settled then on its TENTH attempt and was the campaign's only `PASS-DIRTY` that was
  nonetheless believed. Armed as intended: six grant/join/send/revoke/send cycles drove the salon's
  group through **13 epochs** and minted **12 distinct sessions** for 12 messages, one per session - a
  shape no message count could distinguish from an unchurned salon, which is why the earlier nine
  attempts proved nothing. The peer missed 7 sessions while revoked and **absorbed all 7** on
  re-grant, leaving nothing unreadable. First render: sender 3 815 ms, peer warm 2 938 ms, peer
  **cold 6 789 ms** after a reload and a PIN. Recorded, never asserted - the product carries no
  budget for a cold first render, and inventing one in a check would be the check deciding product
  policy.
- **COMM-17** settled on its FOURTH attempt. All six expectations held: a real pointer drag moved the
  community to the top, nothing else moved, `channel_members.sortOrder` held the new order, it
  survived a reload of W1, it reached A1, and the reverse drag restored the original. It is the first
  A1 row of the campaign read on a build that was current at the time. The `PASS-DIRTY` before it
  carried one `[PIPELINE] Recovery attempt finished` line, fixed by `f950c01c`; the attempt before
  THAT held all six and was `VACUOUS` anyway, because a push of ours landed mid-run.
- **MUT's server window read `unexplained=2` on every pass of the x5 before `e3e5a60bb007`, and the
  lines were MUT's own.** A channel message being hard-deleted (`[ChannelService] [CHANNEL] message
  deleted ...`, and its `(moderation)` form) is the one delete in the product that leaves no
  tombstone; MUT-8 and MUT-9 are the only checks that produce it, and neither had ever run in a
  window anybody classified. Both shapes are `NOTABLE` now and pinned in `srvclassify-selftest.mjs`.
  That span - 30 464 lines over seven services on runner `4a9814f845d7` - then read clean with 15
  notable and nothing unexplained.
- **MUT-12's channel leg has an intermittent that is NOT attributed to the product**, written here so
  nobody re-derives it. It has missed three times ever (2026-08-16, and twice on 2026-08-22 at 114
  and 136 rendered paragraphs). The second was taken apart against the production log: the message
  was never lost - the server created and pushed it two seconds BEFORE the check gave up - and the
  sender's whole send took 600 ms once it started (`DISTRIBUTION_GROUP` -> `liveGraineSessions` ->
  `CHANNEL_PUSH`). What preceded it was 21 seconds in which the sender's client made no server call
  at all, having already rendered its optimistic bubble; `sendText` waits for that bubble, so the
  check's clock had been running the whole time.

  That leaves two causes the evidence could not separate: a client-side stall, or THIS host
  saturating while it drives two Chrome profiles and a phone. Both failures fell in stretches where
  the box was also running greps, `ssh` and pre-commit sweeps; **eight consecutive passes with the
  box deliberately quiet did not reproduce it**. That is not proof, and it is why no defect is filed.
  The instrument is in place for the next occurrence instead: MUT's `finish()` attaches `silence` -
  the longest hole in each client's OWN timeline - to any non-PASS verdict, and a hole appearing in
  EVERY client at once is this host freezing while a hole in only the sender's is the product. See
  [testing-methodology](testing-methodology.md) 34.
- **Channel search DOES cover the whole history - a verified negative, not an assumption.** After the
  loop was fixed, SEARCH-4 settled at two `/messages` pages, which looked like a walk stopping early
  against a 1057-row channel. It is not: the server's `limit` counts NON-SILENT rows and then carries
  the reaction rows along with them, and this channel is **163 bodies to 894 reactions**. Page one
  takes all 163 bodies, page two comes back short, the walk ends - complete. `pagesWalked` is
  recorded on the row so the next reader measures this instead of re-deriving it.

  It sharpens the 2000-row cap gap in [backlog](backlog.md) rather than closing it: the 2000 is a cap
  on ROWS, and 85% of the rows here are reactions - so a heavily-reacted channel reaches the cap at a
  small fraction of 2000 actual messages, and the truncation it then hides is correspondingly closer
  than the number suggests.
- **One SEARCH `FAIL` was the harness, not the product**, kept because the distinction is the phase's
  whole value. SEARCH-3 reported a deleted message still findable by its original text.
  `button:last-of-type` is "last button among ITS OWN siblings", so `Modal.svelte`'s lone header
  `Fermer` qualified and preceded the footer in document order: the check pressed dismiss and never
  deleted anything. It now activates by text, asserts what it activated, and asserts the tombstone
  before asking search anything. Same family as rule 27 - a gesture that is not asserted is a gesture
  that did not happen.
- **SEARCH-5 passes ON a gap, by design.** Search folds case and NOT diacritics, in all three places
  that match. The check asserts the DIRECTION (a no-accent query misses, an accented-uppercase query
  hits), so it would also fail if the behaviour silently changed. Whether to fold diacritics is a
  product decision, taken nowhere yet, and it is in [backlog](backlog.md).
- **TYPE** holds a 5/5 x5 on superseded runner `25376b86` (shown 70-90 ms, cleared 245-272 ms;
  TYPE-2 expired 4 138-4 221 ms). The current-runner run is x1, and the header says so.

What was removed on 2026-08-25, when the board was swept a second time:

- **COMM-18 cost five FAILs and they were four distinct product defects**, each one further along the
  same path - which is the row's whole value: nothing else in the ladder cold-starts a real device
  into a salon it has no seed for. The first three shared one cause (the repair path excluded the
  asking user by name, so a device could not ask its OWN other device for a seed that device had
  minted); the fourth proved that fix while failing further along; the fifth named the last cause,
  which was neither candidate as written. **The sixth is a clean PASS on `d6f61539`**: both replies
  print `as key material` - the two frames run 5 recorded as dropped - and the marker rendered 135 ms
  after the deep link resolved. That 135 ms is also why the row does not claim WHICH route fed the
  seed: it is too fast to separate the two from outside, and `why` is only populated on a miss. What
  is asserted is what was measured - the identical geometry that lost both answers now keeps them.
  Stories in `CHANGELOG.md`.
- **Three GRP rows carried their own provenance in the cell.** GRP-4's `PASS` followed a re-run owed
  after `51dcb814` dirt (one unclassified Welcome line, classified since). GRP-7's followed the
  mailbox-barrier fix - a guard reporting an impossible deadlock and skipping the ordering guarantee
  it exists for. GRP-10 was found in SOURCE while GRP-4 was being written, captured as a `FAIL` on
  `1579d5c3`, and is green on the fix: a check written from reading, which is the cheapest kind.
- **HEAL had four runners for eleven rows and two of them were older than the rows they answer.**
  `heal-a1.mjs` and `heal.mjs` had existed, worked and recorded verdicts throughout - the phone mirror
  of HEAL-repair, and the "does the next message arrive" question after an escalation - under ids no
  row had ever named, so nothing reconciled them and nothing could report them missing. `rows.mjs`
  named all three faults at once, the third being `heal-web.mjs` answering HEAL-repair under
  `HEAL-WEB`. Every runner now records the id of the row it answers.
- **The four HEAL-REVOKE rows are four and not one, and the reasoning is load-bearing for two of
  them.** HEAL-REVOKE-3's shortfall must be REPORTED rather than silently partial - a restore that
  stops halfway looks complete, which is how the user's PC lost conversations without knowing to
  retry. HEAL-REVOKE-4 is the row a green run can most easily fake: a heal firing on every connection
  would satisfy "it caught up" while proving nothing, so its TRIGGER CONDITIONS are part of the
  assertion rather than context around it.
- **`rows.mjs` read seventeen answered rows as `unstated` and reported them as unrecorded work.** The
  board writes some verdicts bold (`**`PASS`**`) and some with the count inside the code span
  (`` `PASS 1/1` ``), and the reader anchored on a bare backtick followed by letters alone - so all of
  GRP and most of DEL fell through. Third instrument fault of this shape in this file, found the same
  way each time: a gap that large about phases already known green is a gap in the reader, not in the
  campaign. Both spellings are read now.

- **RUNG 9's LAST TWO SWEEPS, AND THE AMPLIFIER FIX THAT WAS HIDING EVERYTHING ELSE.** Twenty-one of
  the rung's cells were dirty on one signature, and acknowledging a same-epoch refusal removed it: the
  re-run of 2026-08-27 on `cb967b6c` (twenty rows `--without A1`, the four `+A1` rows keeping their `6808a89c` verdict until the full re-run on `0c31be5d`) turned **15 into `PASS` where the
  previous sweep had none**, and `could not join the distribution group` has appeared in no row since.
  Three cells survived that fix, and they were not the old signature:

  - **COMM-8 `FAIL`** - the one row whose dirt was never only the amplifier. A member granted a
    private salon reached its delivery roster and stored no seed at all, because the peer had
    external-joined the salon's group TWICE across a navigation, base 0 then base 1 two seconds apart.
    The salon reached epoch 2, the granting device stayed at 0 refusing frames it had no tree for, and
    the seed could not move. **Four groups were double-joined in that one rung** (`93c80263`,
    `a3b34f58`, `73cb54d2`, `60561454`). The cause - an accepted external join durable on the SERVER
    and volatile on the client - and its fix are in `CHANGELOG.md`; the row is green on `0c31be5d`.
  - **COMM-11 `PASS-DIRTY`** - one same-epoch refusal at 0/0 on `5e09125d`, correctly ACKed but still
    an ERROR, same root: a distribution group forked by a duplicate join. Clean since.
  - **COMM-9/10, COMM-21 and COMM-22 `VACUOUS`**, unchanged by the fix, which is what adjudicates
    them: none was the debris. COMM-21's HTTP 400 survived exactly as predicted.

  **And the ACK fix did not cause COMM-8.** The ledger carries `seedAfterTheGrant: false` twice on
  pre-fix builds (`d3cff54c`, `d6f61539`), and has never once recorded `'distributed'` - every pass
  that row has ever taken came through the history-repair route, never the distribution frame, which
  is why WP-REGRANT-2's proof is still owed with the row green.

- **COMM-22's full measurement**, taken on `66639621` in the quiet window: 12 Graine sessions minted
  over 6 join/leave cycles (epochs 1->13), every message reaching the server (12/12), the sender
  reading all 12, and the peer reading all 12 both warm (3.2 s) and cold (3.3 s, `gate: unlocked`)
  holding **one seed per session** - the same twelve session ids in `seedsWarm` and `seedsCold`, so
  nothing was reconstructed by luck. `nothingStaysUnreadable` is the assertion that matters: the peer
  DID miss 30 frames and DID render `[CHANNEL] ... unreadable ... (repairable)` rows, then
  `[GRAINE] absorbed` closed every one. **It is also the first production measurement of the joiner
  publishing `base + 1` inside its own submission**:
  `[MLS] externalJoin succeeded ... (base epoch 0, base for 1 stored with the commit)`.

- **MULTI-5's `ERROR` in full**: `openChannel` on the second tab saw `no gateway connection line
  within 30 s`, then `sidebarPanel: false, listedEntries: 14, bodyChars: 960`.

- **COMM-12 SETTLED ON ITS THIRD ATTEMPT, and only because the rail was swept.** Its two `VACUOUS`
  were a mid-run CD deploy with `failures: []`, then a NAMED failure:
  `click missed its target: [aria-label="Ajouter une communaute"] - dispatched at 108,475 on <BUTTON>,
  taken by` a community TILE of an earlier COMM run. `stableCentreOf` had cleared that point 120 ms
  earlier and the recorder named who took it, so the campaign's OWN debris - 8 communities on the rail
  - was overflowing the control. Six debris communities and 26 debris salons later the same runner
  passes unchanged, which is the cleanest possible proof that nothing about the product was ever at
  fault: **an inherited state, not a defect**, and queue item 4's per-step starting point is what stops
  it recurring. Its residual dirt is 9 social-service lines the classifier has no rule for - a
  workspace create, an invite pair, the distribution-group commits, and six
  `No message queued after validation - recipients=0` WARNs that are correct for a key-distribution
  group whose only member is its creator. Noise to teach `srvclassify` about, not a signal.

### The evidence the cells carried before 2026-08-28

The board's State column is a verdict, a number and a time - the rule above, applied to every cell on
2026-08-28 when the user read the file as a session state rather than a state table
(*"s'il y a plus de 4-5 mots c'est probablement que c'est verbeux"*). What each of those cells said,
kept because it was measured once and is expensive to measure again. Where a row's EXPECTATION was
living in this column it moved into the board's own "What it asks", which is where it belongs, and is
not repeated here.

- **0 SETUP** - 5/9 `passed`; SETUP-2 `skipped` by decision, SETUP-7/8 owed before CORRUPT and PIN
- **1 MSG** - **`PASS` 12/12 x1**; four `+A1` rows owe a re-run for `a1Build`
- **9 COMM** - 19 `PASS`, 5 `PASS-DIRTY`, no `FAIL`, no `VACUOUS`; COMM-10 never run
- **10 DEL** - 4 `PASS`, 6 `PASS-DIRTY`, no `FAIL`, no `VACUOUS`; 7 cells owe a re-run on `del.mjs` `2dd7a0f4a933`
- **12 MULTI** - 1 `PASS`, 1 `PASS-DIRTY`, 1 `VACUOUS`, 2 `SKIPPED`, MULTI-5 `ERROR`; every cell owes a re-run on `multi.mjs` `74bb17b8283f`
- **SETUP-2** - `skipped` - deliberate; `install -r` keeps the store and avoids re-paying SETUP-4's 2FA
- **MSG-2** - `PASS` - 578 ms. **No `a1Build`** - re-run owed for attribution (see the phase note)
- **READ-5** - `SKIPPED`, TERMINAL (user, 2026-08-23) - needs FOUR readers and the estate has TWO accounts, the watermark being per USER. Closed, not deferred
- **SEARCH-2** - `PASS` 5/5 - one `ERROR` in the six, the intermittent of [testing-methodology](testing-methodology.md) 34
- **GRP-1** - **`PASS`** - `feecfaf5` x4; one run `PASS-DIRTY` on the deliberately unclassified `[KICK] Stale leaf`, read and benign (the phone re-asked for a Welcome whose leaf was already in the tree)
- **GRP-3** - **`PASS`** - `feecfaf5` x4. An earlier run was `PASS-DIRTY` on one `webSocketClosed` no navigation explains; it did not return, and it stays a P2 in [backlog](backlog.md)
- **GRP-4** - **`PASS`** - `feecfaf5` x4 after `e027679a`; was 4 FAIL / 4 PASS before it (two parties added the joiner's leaf, the healing Welcome dropped as a redelivery)
- **GRP-8** - `PASS-DIRTY` - `feecfaf5` x4, identical each time: the re-admitted device calls its own exclusion window a loss and reconciles for it. P2 in [backlog](backlog.md). Clean before `e027679a`, when the re-admission never happened
- **COMM-8** - `PASS` - the fork is gone, twelve assertions hold, the peer 403s and was never sealed a seed. **`seedAfterTheGrant: repaired`, not `true`**: the seed came through the REPAIR path, so WP-REGRANT-2's proof is not taken
- **COMM-9** - `PASS-DIRTY`, as `COMM-9/10`. Dirt is one W1 line, `[GRAINE] lost the first-publish race for 38ad9778 - joining the published base instead`. It heals, and a race that heals cleanly is still a defect
- **COMM-10** - `PASS-DIRTY` - same combined row, same dirt. **The runner debt the user named is PAID**: a line that cannot ask its question now says so in `failures[]` instead of recording a bare `VACUOUS`
- **COMM-12** - `PASS-DIRTY` on `66639621`, after `cleanup.mjs` swept the rail - **the sweep IS the adjudication**: the two `VACUOUS` before it were a mid-run CD deploy and then a debris community tile taking the click, an inherited state and not a defect. Dirt is 9 social-service lines `srvclassify` has no rule for
- **COMM-18** - `PASS-DIRTY` - on screen in 153 ms. Dirt is one A1 line, `[hooks] launch URL already acted on by this start, ignoring the replay`, a designed dedupe announcing itself
- **COMM-21** - `PASS-DIRTY` - dirt is one W2 line, `[MLS] Skipping stale MLS state write (v63068 <= stored v63069)`, the `peerWroteBefore` signature. **Its 400 probe is INTENDED** and is not the cause - `comm21.mjs:196` requires it
- **COMM-22** - `PASS` on `66639621`, clean - 12 Graine sessions over 6 join/leave cycles (epochs 1->13), 12/12 read warm (3.2 s) and cold (3.3 s), one seed per session and the same ids in both. 30 frames were missed and `[GRAINE] absorbed` closed every one
- **COMM-23** - `PASS-DIRTY` - the routing flip holds. Dirt is on the OWNER, `GET /api/mls/group-info/8473ce11 -> 403`: a QUESTION, not a designed refusal, and the one thing in this run nobody has explained
- **DEL-1** - `PASS-DIRTY 1/1` - armed at last (`armed: true`), 4/4. Dirt = 6 W2 lines `[History] frame never read here and unreadable for good (past-epoch-application)`, a designed line announcing a loss reconciliation then recovers
- **DEL-7** - `PASS 1/1` - reached A1 in 147 ms, killed at `LAST`, purged on wake, converged in 0 ms, ONE `[READD]` solicitation. Two harness faults paid first, both fixed
- **DEL-8** - `PASS 1/1` - first run ever, and it validates the `solicitationsAbout` predicate DEL-7 now shares. **RUNS LAST of the phase**, it restores a snapshot over W1's real state
- **DEL-9** - `PASS-DIRTY` on `66639621` - 4/4. Dirt is ONE unexplained W1 line, `[blocks.isBlockedWith] Object`, a debug log printing an object as the string `Object`: noise to fix, not a signal
- **DEL-10** - `PASS-DIRTY 1/1`, **and it CONTRADICTS the `FAIL` on `2a4297cb`** - the missing trigger fired here, in the dirt: `[EXIT] replaying 1 exit(s) the server never answered`, then `[EXIT] c92c92e4 delete replayed - server deleted it`. **Do not close the P2 in [backlog](backlog.md) on one row**: nothing names what changed between the builds, and the old FAIL measured a queued SEND where this measured a queued EXIT
- **TAB-1** - `pending` - RE-SCOPED 2026-08-24 onto the web `Notification`, the only out-of-page signal the product has. The gap it cannot assert is P3 in [backlog](backlog.md)
- **TAB-3b** - `pending` - one 77.7 s run stands on the record, unexplained and not reproduced in four more
- **MULTI-2** - `VACUOUS` - `no stored conversation row named the peer`, so the row never asked its question. Fixture debt, undiagnosed
- **MULTI-3** - `SKIPPED`, **and the reason is RETIRED**: it was priced on SETUP-4's 2FA, which the user made payable on request 2026-08-27. Simply OWED, and it is the mobile twin of `HEAL-NEW-6` - one re-provisioning pays both
- **MULTI-4** - `SKIPPED` - the 2FA half of the reason is retired (see MULTI-3), but the row is DESTRUCTIVE on the one armed phone. It runs LAST of the phone rows, after `HEAL-NEW-4/5/6`, or a revocation costs the campaign its only phone
- **MULTI-5** - **`ERROR`**, and it is RUNNER debt: `no gateway connection line within 30 s`, then `sidebarPanel: false, listedEntries: 14`. NOT the SharedWorker limitation ([chat-gateway](services/chat-gateway.md)). **Hypothesis, UNPROVEN**: a fresh tab is behind the PIN gate and 14 buttons is a keypad; `pin.mjs --match` is the fixture fix
- **MULTI-7** - `INVALID` - NO VENUE: the channel URL carried no group id, so no roster was read. Re-run owed, the row untried
- **MULTI-8** - `INVALID` - same venue fault, untried. A new device id appearing is a `FAIL`, not a recovery
- **MULTI-10** - `FAIL` on `e731b5b8`, a true positive against DATA, not code: ONE expectation unmet, `noPlaceholderIdentityAnywhere`, on the single row `userId='unknown'` / `status=active` in group `7da231f8`. The two invariants that would accuse the product HOLD. **It cannot go green by being re-run** - the guards of `c8addd53` repair nothing existing, so this is one `DELETE` on production, a one-off that belongs to the user
- **NOTIF-2** - `pending` - a generic fallback is CORRECT; opening the app must recover
- **NOTIF-4** - `PASS-DIRTY` - on `1f396ac7`, taken by a runner changed since, so a re-run is owed. a `PASS-DIRTY` on `1f396ac7` stands in the ledger, taken by a runner changed since
- **NOTIF-6** - `pending` - reported not working from a real phone 2026-08-20, on an APK predating the current bundle
- **NOTIF-7d** - `pending` - the case most likely to lose a pending deep link
- **NOTIF-15** - `pending` - MUT-13 asserts the in-app half and defers the push half here
- **HEAL-W1** - `pending` - a `healed` verdict after applying ZERO commits is a regression
- **HEAL-W2** - `FAIL` of 2026-08-11, **which must NOT be read as current**: it predates the `build` field, so no artefact can be named for it, and it recorded `recovered: false` with `unknownGroupFired: 0` and `recoveryLines: 0` - the drain ran 8/8 and nothing asked for the missing group. The rung's FIRST question, not its verdict
- **HEAL-REVOKE-1** - `pending` - the user found one that kept everything, P1 in [backlog](backlog.md)
- **HEAL-REVOKE-2** - `pending` - the blacklist can make this row pass while HEAL-REVOKE-1 fails
- **HEAL-REVOKE-4** - `pending` - the TRIGGER CONDITIONS are part of the assertion, not context
- **HEAL-REVOKE-5** - `INVALID` on `48b65d08` - the shared instrument cause: no enrolled victim, so nothing to revoke. Re-run owed
- **HEAL-REVOKE-6** - `pending` - **the instrument is in**: `deviceResidue()` is the AND of both halves, and the web-only predicate was still what `healrevoke.mjs` imported until 2026-08-28, so this row would have passed on a dirty phone. What is left is the victim being A1 rather than W3, one re-enrolment per run, measured at no 2FA
- **HEAL-REVOKE-9** - **`PASS-DIRTY` on `da0ce2f2`, `unmet: []`** - written 2026-08-28, the user's second question and the half no row had ever asked. It took three runs and the two FAILs were both worth having: the first on a trigger the product does not have (the row asked a RELOAD; the product defines a LOGIN plus the PIN its refusal names - settled by the owner 2026-08-30, the product is the reference), the second on `noStoreSurvivedTheWipe`, a P1 in the wipe fixed in `da0ce2f2`. **The half that matters passed on all three**: severed, revoked, state still present, `wipeRan: false`. **Its dirt is all identified and two shapes are the ROW's own** - the revocation refusal it provokes, and the dead refresh cookie that latches behind it - and they are deliberately NOT on the victim's noise list: a list widened after a verdict changes `checkSha` and leaves the runner disagreeing with the cell it produced, and the three shapes left (a LOST frame, the already-queued GRAINE rejoin, one not-ready conversation) hold it amber whatever the other two do. **The list is widened on the run that needs it, never after one.**
- **HEAL-NEW-0** - **`PASS-DIRTY` on `48b65d08`** - the primitive the other fifteen rest on: nothing left of the identity, the store or the cookie, a never-seen `device_id` minted, and **no credential prompt**, the SSO session living outside the app origin - which is why the group costs ONE 2FA and not eleven. **The ledger's NEWEST row here is a `FAIL` the board deliberately does not take** (`03d015fd`): dirt only, and it measures the classifier - P3 in [backlog](backlog.md)
- **HEAL-NEW-1** - **`PASS` on `48b65d08`** - the isolation was REAL (both webs killed, the phone force-stopped, `extra: []` after a 915 ms drain), and ten rows stayed amber the full 600 s at `serverActive: 10`, which the condition entails. **It asserts the OUTCOME, not that the app SAYS `no_peer_online`** - HEAL-NEW-5 is where that distinction is made
- **HEAL-NEW-2** - `pending` on `a35cf4e5`, re-scoped to the `servableSubset` - 1 row of 10. Two earlier `FAIL`s measured the instrument: the device cap on `48b65d08`, then `expect: healed` over ten groups the peer is not in on `3b5cee35`
- **HEAL-NEW-3** - **`PASS`** on `ebef7f3c` - 10/10 ready, settled during enrolment; heal served over READD while the reconciliation itself asked 7/11 (rest deferred, no probe sender). Three earlier runs measured the instrument
- **HEAL-NEW-5** - `pending` - a responder that cannot answer must not leave a group on Sync with nothing owed. The row that says whether the ladder terminates on a PROOF or on a clock
- **HEAL-NEW-6** - `pending` - this is MULTI-3, and it stops being `SKIPPED` the moment a 2FA is being paid anyway
- **HEAL-NEW-7** - `pending` - the user's first symptom. Three causes to tell apart, and only two are visible to a new device: the third is an exit still owed, which lives in the DELETING device's own IndexedDB
- **HEAL-NEW-8** - `pending` - the user's second symptom. The assertion is a COUNT plus the identity of every laggard, never a sample
- **HEAL-NEW-10** - `pending` - the add-lock under two concurrent enumerations. Lowest of the group, and it costs a second 2FA
- **HEAL-NEW-11** - `FAIL` on `48b65d08` - the shared instrument cause, read twice: `wentAmberBeforeTheResponderArrived: false` is `{"panel":false}`, which is what a device refused its KeyPackage looks like. Re-run owed
- **HEAL-NEW-12** - `pending` on `a35cf4e5` - same `servableSubset` narrowing as HEAL-NEW-2, and runnable for the first time
- **HEAL-NEW-13** - `pending` - says whether the retry is driven by OUR reconnect or the RESPONDER's. Read with HEAL-NEW-5, whose responder can never answer
- **HEAL-NEW-14** - `pending` - the user's own worry. A reload must not restart the ladder from zero, and a cut must not leave a row amber with nothing owed
- **HEAL-NEW-15** - `FAIL` on `48b65d08` - shared instrument cause; `healed: true` and `usability.openedInMs: 26`, so the app WAS navigable. Its `fleet.extra` also named two abandoned mints. Re-run owed

## 12 MULTI - the four rows added 2026-08-28, and why NOTHING on the board could have caught the defect

**A conversation lost both its directions for 134 minutes on production and every rung above would
have passed through it.** The peer had NO active device in the group: a placeholder identity
(`userId='unknown'`, `deviceId='pending'`) had been stored as an `active` member 0.84 s before the
real members joined, and the peer's own two devices sat `pending` and were never activated. Full
account in [backlog](backlog.md), not restated here.

**The board was searched before these rows were written, and the gap is STRUCTURAL, not an
oversight.** Of the 200-odd rows, exactly ONE reads `dm_device_group_memberships` at all - COMM-8 -
and it reads **who is named**, never **what status they hold**. Every other row asserts the SYMPTOM: a
message appears, a badge lights, a list is right. That is precisely what this defect leaves intact -
it was invisible from the sender's side, and the receiver's side was a device the rig does not own.
**A rung can be green while a member of the group is a string the client itself defines as "no
identity yet".**

**Nor would the ladder have run long enough.** Every runner enrols, measures and tears down inside one
session. Three of the ten stranded memberships found on production had stood since 2026-08-03,
twenty-five days, and no row anywhere asks a question whose answer is a POPULATION rather than an
event. MULTI-10 is that question, and it is the cheapest of the four.

**And it is NOT an iOS defect, which is what makes it belong on the ladder rather than on
[device-verification](device-verification.md)**: nine of the ten stranded devices are `web-`, on
Chrome, and the guards that shipped are one client seam and one server allowlist, neither of them
platform-specific. `W1 W2` alone can run all four rows.

What each of the four is for:

- **MULTI-7** is the cheap half: `userId` and `deviceId` are compared against the client's own
  non-identity literals (`unknown`, `pending`), and a match is a `FAIL` however well the messages
  flowed. Nothing on this board had ever asserted the ROW.
- **MULTI-8** names the defect. On production the activation never came at all and the "heal" was the
  user uninstalling the app, which minted a new device id and took the group's only commit. **A
  reinstall must not be what makes this pass** - the runner asserts the ORIGINAL device id went
  `active`. W3 is the second device it enrols, so the row costs no re-enrolment of A1.
- **MULTI-9** asserts the half nobody watched: for 134 minutes messages were accepted, fanned out and
  lost while both clients showed them sent. A message sent while a member device is pending must still
  be RECOVERABLE by that device after it activates, and nothing may claim success in between.
- **MULTI-10** opens no client - it reads the table and the gateway only, runs as a preflight, and its
  output is a COUNT with the offending ids. A non-zero count is a finding even when every other rung
  is green. Its `pending` half is discriminated by PRESENCE: a switched-off device is legitimately
  pending, so those rows are reported as `notCountedAgainstTheProduct` rather than counted.

  **AND THAT PRESENCE PREDICATE WAS MEASURED AGAINST THE POPULATION IT WILL RUN ON, 2026-09-05,
  BEFORE THE RUNNER WAS WRITTEN - IT REPORTS ZERO.** The local estate holds **73 pending memberships
  across 42 devices**, the oldest 37 days, and every one of them names a group that still EXISTS and
  a device that is still ENROLLED - so none is debris by any structural test. Three devices were
  online at the time of the reading and **not one of them carried a single pending row**. A row
  asserting "no pending membership past the budget, for a device that is present" would therefore
  have recorded a `PASS` about nothing at all, on a table holding 73 rows of exactly the shape it
  exists to find. That is the rule this campaign already carries - *a predicate that named the last
  incident is not the predicate that names the next one; re-measure it against the population it
  will actually run on* - and one `GROUP BY` settled it.

  **What the row must do instead, in three parts.** The **placeholder half is unconditional and
  needs no discriminator**: `userId` or `deviceId` equal to a non-identity literal is a finding
  whatever the device is doing, it reads the whole table, and it is currently 0 - which is the guard
  that shipped, holding. The **pending half must report a CENSUS**, bucketed by age and by whether
  the device is present, so the 73 are visible rather than silently excluded by a predicate that
  cannot judge them. And the presence-discriminated assertion must record **whether it was vacuous**:
  if no online device carried any membership at all, that half is `INCONCLUSIVE`, never `PASS` - a
  rig that cannot ask its question must say so rather than answer it.

  **Which is also why MULTI-8 comes first.** The controlled case - enrol W3 while the peer is
  offline, then assert THAT membership reaches `active` within the budget - is the only one where
  the rig owns both ends, so it is the only one that can be non-vacuous on demand. MULTI-10 is the
  census over everything else, and it is worth exactly what its buckets say.

## 16 HEAL - what the rows are, and what they cost

Moved off [the board](cross-client-testing.md) on 2026-08-28: it had grown to 280 lines of prose around 44 lines of table, which is the rule of 2026-08-22 broken in one section - a cell is a verdict, a count and a time. Nothing here is state; it is why each row exists.

**Four runners for eleven rows**, and every runner now records the id of the row it answers:
`heal-web.mjs` (HEAL-repair), `heal-a1.mjs` (HEAL-A1), `heal.mjs` (HEAL-NEXT). HEAL-W1, HEAL-W3,
HEAL-W4 and the four HEAL-REVOKE rows are written as the ladder reaches this rung. HEAL-W2's only
ledger verdict is a `FAIL` from 2026-08-11 taken by a script rewritten that same day, so it reads
`pending`.

**The four HEAL-REVOKE rows** come from the user's decision that revocation is a WIPE
([backlog](backlog.md)). They are four rows and not one because a wipe is executed BY the device being
wiped: "the wipe ran" and "the device came back like-new" are different claims.

**The two nights' timings, since the cells no longer carry them:** HEAL-NEW-1 drained its fleet in
915 ms and left ten rows amber for the full 600 s at `serverActive: 10`; HEAL-NEW-2's first run healed
10/10 in 6.1 s on a premise the device cap had already voided, and its second drained in 982 ms before
healing 1 of 10; HEAL-NEW-11's `wentAmberBeforeTheResponderArrived` note was
`never went amber alone within 90s: {"panel":false}`.

**AND FOUR MORE, ON THE USER'S ASK OF 2026-08-27: a revoked device that missed a LOT.** Verbatim:
*"un appareil qui a ete revoque, qui a manque plein de messages/changements MLS (nouveaux groupes,
suppressions de groupes etc) et de bien voir si tout est rattrape correctement a la fin (l'appareil
revoque devrait agir comme un appareil neuf puisque la revocation lui demande de tout supprimer, mais
il faut le tester). Ce cas est la porte vers beaucoup d'autres, toujours avec les histoires d'ordre,
et de device mobile ou web."*

**The expectation is an EQUALITY, and that is what makes it testable at all:** if revocation really
wipes, then a revoked device returning is a NEW device, and its final state must be the state a fresh
device reaches in the same window - the whole `HEAL-NEW-*` group already measures that side. So these
rows do not re-measure repair, they measure SAMENESS, and any difference is the finding: a returning
device that ends with more than a fresh one kept something the wipe was supposed to destroy
(HEAL-REVOKE-1's open P1 is exactly a device that kept everything); a device that ends with LESS is
carrying state that survived just enough to poison enumeration - the worse of the two, because it
looks healthy.

**Why the missed CHANGES matter and not just missed messages.** A device away for a long window misses
two kinds of thing, and only one of them has a catch-up path: messages accumulate in a queue that can
be drained, while MEMBERSHIP changes - a group created, a group deleted, a member removed - move the
epoch and cannot be replayed at all. A returning device therefore has to be told the shape of the
world rather than catch up to it, which is enumeration, which is the `HEAL-NEW-*` mechanism again. The
axes the user names - ORDER, and web versus mobile - apply unchanged, so the same equality is asserted
in each.

Every row above breaks a device that **already held** the group - a rewound snapshot, or a
revocation. A device that has **never held anything** is a different mechanism, and it is the one the
user names as the app's sensitive point (2026-08-27): conversations stuck on the "Sync" badge, some
repairing and others not, and rows for conversations that are DELETED.

**Why it is a mechanism and not a variation.** A new device holds no group, so every row it shows is
minted by server enumeration - `discoverMissingGroups` in `utils/chat/actions.ts` - and every one of
them starts `isReady: false`. The badge is `chat_sync_badge_label` ("Sync"), rendered by
`ConversationTile.svelte` on exactly `!isReady && lifecycle !== 'removed'`. So **"Sync" is not a
progress indicator, it is the absence of MLS state** - and a row that will never repair looks
identical to one that is about to. Getting from there to ready is rung 2 of the
[recovery ladder](protocols/mls-recovery-ladder.md): `requestReAdd` tries `externalJoin` (fetch the
published GroupInfo, build an external commit, no peer required), and only when no GroupInfo exists
does it fall back to a `welcome_request` - which **needs a member ONLINE to answer it**. So who else
is running is not a nuisance variable to be held constant, it IS the axis, which is why the user's
five conditions are five rows and not five repetitions of one.

**What this group must separate, and no existing row does:** an enumerated row that repaired by
external join, one that repaired by a peer's Welcome, one that CANNOT repair because nobody can
answer, and one that should never have been enumerated at all. All four look the same in the sidebar.

**The cost, stated once: every row here is `+user`,** because a fresh device pays SETUP-4's 2FA -
which is why MULTI-3 has been `SKIPPED` since `0c31be5d`. **THAT PRICE FELL ON 2026-09-02**: the
campaign moved to two dedicated Authentik accounts that sign in through the service-account link,
whose flow has no MFA stage, so a fresh device now costs a username and a password. The rows are
still `+user` in the sense that a human decides when to spend a device, but the 2FA that made a
group of nine unaffordable is gone, and `newdevice.mjs` is a convenience rather than the primitive
the whole group rests on. The group is only affordable if ONE 2FA
buys many rows, so it stands on a primitive the rig does not have: `newdevice.mjs`, clearing the
Canari ORIGIN (IndexedDB, the device key vault, the refresh cookie) while leaving the CAS/Authentik
session on its own origin intact, so the next load enrols as a device the server has never seen
without a credential prompt. **That is a claim, not a plan, and nine rows may not rest on an
unmeasured one** - it is HEAL-NEW-0 and it runs first.

**ORDER IS AN AXIS, NOT A DETAIL, and equality across it is the assertion** (user, 2026-08-27:
*"W3 actif avant W1, w1 actif avant W3, etc. Toutes les configurations sont a tester et finir, pour
que tout pass, de la meme facon (tout l'interet de la reconciliation)"*). A responder that is
ALREADY online when the fresh device first enumerates, and the same responder arriving AFTER every
row has gone amber, are two different mechanisms wearing one sidebar: the first can be answered
inside the initial `discoverMissingGroups`, the second needs something to notice later and ask
again - a reconnect, a presence event, or a retry. That is why each responder kind gets a
present-from-the-start row AND an arrives-late row, and why the verdict is an EQUALITY: **a
difference in the FINAL state between two orders is a `FAIL`; a difference in the TIME to reach it
is dirt carrying a number.** Reconciliation that depends on who booted first is not reconciliation.

### The HEAL-REVOKE-7 ORDER PAIR, adjudicated 2026-08-30 - the ORDER changes NOTHING, and the row found a P1 doing it

Both halves ran adjacently on `0f06a4b3`, one fleet, one bundle, after the world was swept clean of
the orphan the FIRST attempt had left in it. **The comparison the pair exists for:**

| | `--order first`, back before the others are online | `--order last`, back after |
| --- | --- | --- |
| verdict | `PASS-DIRTY`, `unmet: []` | `FAIL`, on an assertion that is not the pair's |
| returned device | 11 rows, 11 ready, 0 syncing | 12 rows, 11 ready, 1 syncing |
| reference, minted minutes later | 11 rows, 11 ready, 0 syncing | 12 rows, 11 ready, 1 syncing |
| `equalityGap` | `[]` | `[]` |
| time to settle | 22 150 ms | never settled, 601 356 ms |

**In BOTH orders the returning device ends exactly where a freshly minted device ends. The pair
PASSES its own question**: the order of the return does not change the final state. The difference
is in TIME, and in `last` the time is unbounded - which is dirt carrying a number only because both
devices were held by the SAME cause, equally.

**THE FIRST ATTEMPT AT THIS PAIR HAD TO BE THROWN AWAY, AND THAT IS THE INSTRUMENT LESSON.** It
recorded `first` = `FAIL` with `gap: ["rows: 29 vs 28", "syncing: 1 vs 0"]` and `last` = `PASS-DIRTY`
with an empty gap, which reads exactly like "the order matters". It did not. The whole difference was
one permanently orphaned group, `50799ae8`, left alive on the server by the previous P1: it appeared
on the returning device and not on the fresh reference in one half, and on both in the other.
**A yardstick minted in a world that contains a corpse measures the corpse.** Sweeping it (with
`cleanup.mjs`, through the shared `debris.mjs` allowlist - 20 live throwaway groups, 0 left) and
re-running both halves turned `first` from `FAIL` into `PASS-DIRTY` with an empty gap, on identical
code. Nothing about the product had changed.

**WHY `last` STILL FAILED, AND WHY IT IS NOT THE PAIR'S ANSWER.** Its three unmet expectations are
`bothSettled`, `theNewGroupArrived` and `theNewGroupArrivedOnTheReferenceToo` - the group the runner
creates while the victim is away never became ready, on EITHER device. The cause is a P1 this row
found: the actor created the group and a concurrent sweep forgot it 291 ms later, so the only member
who could serve a Welcome answered `Group not found` for twenty minutes. Fixed the same day in
`edb8d7ab` - story in `CHANGELOG.md`, mechanism on
[chat](frontend/modules/chat.md#a-group-must-be-nameable-by-the-server-before-it-is-holdable-here-or-every-sweep-is-a-hazard).
**The equality the pair asserts was met anyway, because both devices were equally locked out** - which
is precisely the shape this group of rows was designed to distinguish from a device ending with LESS.

**SETTLED 2026-08-30, AND IT TOOK TWO RE-RUNS ON THE SAME BUILD.** The first re-run on `edb8d7ab`
FAILed - `equalityGap: ["rows: 12 vs 13", "syncing: 0 vs 1"]` - on `8868be1c`, **the group the P1 had
destroyed the night before.** The fix stops new corpses and cannot raise old ones, and the actor
itself reported `12 ready of 13`, so no device in the fleet could serve it: the fresh reference built
a thirteenth row and left it amber for ever, the returning device built none. Sweeping it through the
`debris.mjs` allowlist (three throwaway groups, nothing else touched) and re-running the SAME build
gave `PASS-DIRTY`, `unmet: []`, `equalityGap: []`, 11 rows / 11 ready / 0 syncing and the same eleven
ids on both devices. The corpse's own class - a live group whose membership row says `active` for a
device holding nothing, collecting invitations nobody can honour - is a P2 in
[backlog](backlog.md) with its population; the instrument rule is in
[testing-methodology](testing-methodology.md#a-fix-that-prevents-a-state-does-not-repair-the-instances-it-already-made-and-the-next-measurement-measures-those).

**Two things the run says that no cell carries.** The isolated phase healed **0 of 11** rows in
20 099 ms with nobody online, `abandonedOn: null` - the third such sample (0/29, 1/26, 0/11), and the
reason the assertion written there on 2026-08-29 was retracted: the count is not deterministic, only
the failure to settle is. And **the server window was `NOT CLEAN` for both halves** and is not on the
ledger: `chat-gateway` 997 then 1 349 lines, `chat-delivery-service` 4 171 then 4 599 with 41 and 84
unexplained, `core-service` 9 then 8, `social-service` 28 then 66; media, call and frontend-ssr clean
throughout. `run.mjs` prints that window per pass and `gate()` never sees it.

### The 2 / 12 ORDER PAIR, adjudicated 2026-08-29 - the final states are EQUAL

Both rows ran adjacently on `038c7e8d`, under one fleet and one bundle, and both came back
`PASS-DIRTY` with `unmet: []`. **The comparison the pair exists for:**

| | HEAL-NEW-2, peer online from the start | HEAL-NEW-12, peer arriving late |
| --- | --- | --- |
| `servable.rowsInTheSubset` | `642f389a`, 1 of 10 | `642f389a`, 1 of 10 |
| `servable.finalStateOfTheSubset` | `[{642f389a, ready: true}]` | `[{642f389a, ready: true}]` |
| the nine outside | amber, unasserted | amber, unasserted |
| time to the Welcome | 552 ms after the `welcome_request` | 2 589 ms after the responder was READY |

**Equal final state, so the pair PASSES; the difference is time, which is dirt carrying a number.**
Reconciliation here does not depend on who booted first.

**THE PEER IS PROVABLY THE RESPONDER IN BOTH, and that separation is the whole reason this group of
rows exists.** `fleet.extra` was empty in both (drained in 1 358 ms and 908 ms), W1 was killed and the
phone stopped, so no device of the owner could have answered - and the row that healed did so on a
frame the console names: `WS RCV ... senderId=b78568a3..., groupId=642f389a..., isWelcome=true`,
followed by `[SYNC] Welcome processed`. **Both `externalJoin succeeded` lines in each run are for
`315b8a1d`, the key-distribution group, not a conversation** - so ZERO conversation rows healed
without a peer, which is exactly what tells a self-service join apart from a peer-served Welcome.

**Row 12 is the one that actually observed the transition.** Its premise held with nothing to spare:
`amber alone: 10 rows, 0 ready, 10 syncing` at +28.9 s, W2 started there and reached READY at
+51.6 s (it needed a PIN unlock, ~20 s of that), the Welcome landed at +54.2 s and the subset settled
at +56.0 s. Row 2's subset was already ready 2 s after the client went live - its `settledInMs: 1` is
a fact about when the watch could open, not about the app - which is the same shape section 16
records for row 15 on a start topology.

**AND THE CADENCE READING THAT WOULD HAVE BEEN WRONG BOTH WAYS.** Each row logged 19
`welcome_request`s: ten at once, then nine again - 34 s later on row 2 and 60 s later on row 12,
against a line that says `(cadence 60s)`. Neither gap is the cadence. Both runs carry
`documentsReplaced: 1` - `confirmEnrolment` drives the abandoned-id purge through the device panel,
which replaces the document and resets the in-memory `lastReAddAt` map - and the second round follows
that reload by 6 to 8 s in both. **Inside one document the throttle held exactly**, and says so:
`[READD] <id>... throttled (Ns ago)` on every one of the nine, at every 5 s watchdog poll, for the
whole window. A reader taking the gap at face value would have called row 2 a cadence violation and
row 12 a confirmation of 60 s, and both readings would have been about the rig.

**THE SERVER HALF OF BOTH RUNS WAS `NOT CLEAN`, AND IT IS NOT ON THE LEDGER.** `run.mjs` takes a
server window per pass and PRINTS it; `healnew.mjs` writes `observers: { w3 }` and nothing else, so a
HEAL-NEW cell says "clean on the web client" and never "clean on the server". Read from the run's
own output, both windows hold the same three things and no fourth: the WebSocket resets from the
kills the topology performs on purpose (1 on row 2, 2 on row 12, classified `expected-errors`), the
mint's own server-side narration (`Refresh refused: no canari_refresh cookie`, `[DELETE_DEVICE]`,
`[PURGE_PREKEYS]`, the lock and KeyPackage pushes, `[KICK]`), and **one already-queued P2 recurring on
each row** - `[MEMBERSHIP_ACTIVE] REFUSED group=315b8a1d... reason=no_key_package`, on the community
distribution group, 27 s before activation on row 2 and 55 s before it on row 12. Timestamps and the
correlation with the stale-distribution-group rejoin are in
[backlog](backlog.md#p2---a-membership-is-refused-for-want-of-a-keypackage-one-second-after-the-device-external-joined-that-very-group-measured-2026-08-29);
neither was acted on here, both leave these rows' subject.

**EVERY ROW HERE IS A TIMELINE, NOT A SNAPSHOT** (user, 2026-08-27: *"Est-ce-que tout finit bien par
HEAL, et est-ce que le temps gene la navigation/UX"*). Two questions, and a readiness count answers
neither: does it EVENTUALLY heal, and is the app usable while it does not. So every row records, per
sample, an elapsed offset and a wall-clock stamp - the offset is what an assertion may use, the
stamp is what makes a sample correlatable with a console, logcat or server line when the cause turns
out to be on the far side of the wire. A row that ends amber must name WHICH rows and for how long;
a row that heals must say when. `syncrows.mjs` is that reader, and it counts readiness off
`data-conversation-tile` / `data-ready` / `data-removed` rather than off the "Sync" badge's text,
because the badge is a Paraglide message and counting it counts the translation - the day the string
moves, the count silently becomes zero, which is exactly the answer that lets a HEAL row pass over a
broken app.

**MEASURED AND OWED A ROW OF ITS OWN: a brand-new device enrols with NO PIN gate shown.** It reaches
`/chat`, enrols, and the census carries it, while `pin.mjs` finds no modal. Recorded as `pinGate:
"none shown"` on every HEAL row rather than judged here - see section 17, where the question
belongs.

**THE PHONE IS NOT PART OF ANY HEAL-NEW TOPOLOGY, so every row stops it first.** A1 is a third
device of the OWNER's account, fanned into every group the owner creates, and no row here models it:
row 1 claims nothing of the account was online, rows 2 and 12 claim no device of ours could have
served the Welcome, and rows 3, 11 and 15 could not say whether W1 or the phone answered. `am
force-stop` is the kill, for the reason a browser is killed rather than navigated away - a
backgrounded app keeps its gateway socket - and it is paired with a restore registered as an exit
hook, because a row that dies early would otherwise leave the package in Android's STOPPED state
where FCM is cancelled, and every later push row would silently measure this row's kill.

**Two things follow for the rows themselves.** A HEAL-REVOKE cell on A1 must read BOTH halves -
`footprint.mjs` sees the WebView and only `nativeFootprint()` in `phone.mjs`, over `adb run-as`, sees
`mls.bin` and the `.db` files - and a row that reads one half has measured the smaller one. And the
build the phone must carry is NEWER THAN `v0.14.11`, for the reason below.

**So the owed cell is now writable, and its predicate is the tool.** A HEAL-REVOKE row asserting
`bun footprint.mjs --device A1` reads `residue: 0` and `identityKeys: 0` is the row that would have
caught all three of these defects, and none of the ~200 existing rows would have caught any. The
BEFORE reading for it, taken on a fully enrolled A1: `identityKeys: 3`, native `residue: 28`.

### What five of the rows assert, moved off the board 2026-08-28

The cells carried these as prose; they are design, and the board is a state table.

- **HEAL-REVOKE-8 is HEAL-NEW-7 from the other side, and the sharper case:** a returning device may
  hold a stale membership belief no fresh device would have. Three causes must stay separable, and
  only two are visible to a new device at all: a server tombstone (`deletedAt`, filtered by
  `activeServerGroups`), a per-user dismissal (`getDismissedGroups`), and an **owed exit**, which
  lives in the DELETING device's own IndexedDB (`pendingGroupExits.ts`). While the first device still
  owes the server that exit, a new device is *entitled* to re-create the group, and the user sees a
  deleted conversation wearing a Sync badge.
- **HEAL-REVOKE-9 takes THREE samples of one disk, and it took two until 2026-08-30.** While
  `cutHard` has the device really unreachable the state must still be PRESENT (`isDeviceRevoked`
  answers `false` when it cannot ask, because a transport failure is not an answer - a wipe here
  would mean every offline user loses their device). After a reload with a network it must **still**
  be present and the page must stop at `/login`: `sessionAuth.ts` holds exactly three triggers and
  every one needs a credential or a live socket, so a page load that authenticates nobody confirms
  nothing and must erase nothing. Only the LOGIN spends the deferral, and the return the product
  documents is a login AND the PIN its own refusal asks for in as many words.

  **THE ROW ASKED FOR A RELOAD AND THE PRODUCT IS THE REFERENCE** (owner, 2026-08-30). It was
  re-aimed rather than relaxed: it now asserts three things where it asserted one, plus
  `noStoreSurvivedTheWipe` - and that last one is what caught the P1, two `getStorage()` connections
  where the wipe closed one. It still ends before the return equality, which is HEAL-REVOKE-5/7/8's
  subject; this row is the DEFERRAL and what ends it.
- **HEAL-NEW-8's assertion is a count because the throttles are the question.**
  `RECOVERY_TIMEOUT_MS` allows one attempt per period and `PROBE_COALESCE_MS` collapses a 30 s burst,
  so whether recovery is per-GROUP or per-DEVICE is exactly what a 13-conversation account measures
  and a 1-conversation account cannot.
- **HEAL-NEW-9 separates "no history" from "no history YET".** `externalJoin` restores membership,
  never the past, and [history-reconciliation](protocols/history-reconciliation.md) says a new
  device with no peer online starts with everything unread.
- **HEAL-NEW-15 is a finding independent of the heal completing.** An amber sidebar that cannot be
  clicked, or a healed conversation that will not open, fails the row whatever the repair does next: a
  10-minute heal is acceptable where 10 minutes of a frozen list is not.
  **THE PROBE WAS MOVED INSIDE THE WATCH ON 2026-08-29, AND THE ROW IS STILL UNASKABLE ONE LAYER
  EARLIER.** `healnew.mjs` used to call `navigationCost` AFTER `watchRows` had returned, so on a
  topology that heals fast - row 15's responder is W1, present from the start, which is row 3's
  topology and row 3 settled during enrolment - the click landed on a sidebar that was already green.
  The `FAIL` of `48b65d08` recorded exactly that pair, `healed: true` beside `usability.openedInMs:
  26`: a real number, about an app that had finished healing. `watch()` now takes an awaited
  `onSample` hook and the row fires it ONCE, at the first sample holding a ready row and a syncing
  row at once, storing `usability.whileAmber`; the post-settle click stays as `usability.afterSettle`,
  because a healed conversation that will not open fails the row too. A run where the two states
  never coexist is `INVALID` - never a pass over an unasked question.
  **AND THAT IS WHAT THE FIRST GATED RUN RECORDED, on `dc8bf000`: the watch's FIRST sample read
  10 rows, 10 ready, 0 syncing, and it settled in 2 ms.** The sidebar had finished healing before the
  watch could open, which is not a fact about the watch: the runner's own `first read`, 900 ms
  earlier, was already 10/10, and between the device landing on the app (+12.5 s) and that read
  (+61.3 s) sits the whole enrolment, the abandoned-id purge and the KeyPackage poll - about 49 s in
  which NO sidebar reader runs at all. So the amber window on this topology lives inside the mint,
  not after it, and reaching it is a DESIGN decision about where the first sample belongs, not a
  wider deadline. `navigationCost` was also cleared of the fear that it would destroy its own watch:
  measured on the post-click client, `.sidebar-panel [data-conversation-tile]` still reads 10 rows
  and 0 unhooked with a composer open, so no non-navigating probe is owed.
  **THE SPLIT SHIPPED ON `56090443` AND THE ROW IS STILL UNASKABLE - one layer earlier again, and
  this time the number says where.** `becomeANewDevice` now returns at the live client and
  `confirmEnrolment` holds the settle, the database poll and the abandoned-id purge, called after the
  watch. It did exactly what it was designed to do: `watchOpenedAfterLiveMs` fell from about 49 000 ms
  to **1 118 ms**. The first sample still read 10 rows, 10 ready, 0 syncing, and the watch settled in
  1 ms. The heal was over long before either: the console has all ten `welcome_request`s sent between
  +12.9 s and +14.9 s of the row and every row ready by +15 s, while the client did not reach the
  handover until +37.6 s. **The remaining 22 s are the LOGIN half, and 25 of them are one call** -
  `pin.mjs` polling for an unlock modal a brand-new device never shows, recorded as `pinGate: "none
  shown"` since 2026-08-28. So on this topology the amber window is about two seconds wide, it opens
  before the app has finished logging in, and no reader placed after the login can see it.
  **That makes the row a RE-SCOPING question and not another instrument round:** either the responder
  has to be one that heals slowly (row 11's late W1, row 2's peer subset), or the observation has to
  start inside the login, which is a different primitive. The trunk decides which; a third widening of
  the watch would not reach it.

### HEAL-REVOKE-1, 2026-09-05 - the P1 does not reproduce, and the row's first `INVALID` was the rig blaming the product

**The row.** A device the account had just enrolled, holding 7 of 7 rows plus a group minted so the
wipe would have something real to take, revoked through the product's own device panel. The server
recorded the decision in 276 ms and the device left the census 670 ms later. The device's own
`[RESET]` trail reported the wipe run and finished, `0` failed steps, no `store(s) SURVIVED` line.
The disk, read seconds after the trail so anything still running had time to put state back, held
**0 Canari databases, 0 identity keys, 0 localStorage keys**. `PASS`, clean, `unmet: []`.

**It asserts two witnesses and not one, deliberately.** The app can be right about a wipe it did not
complete, and a `deleteDatabase` can leave something no log mentions - those are the two defects this
entry's backlog history already records, and they wore the same report. So the log claim and the disk
claim are separate expectations.

**IT STOPS AT THE WIPE, AND THAT IS THE ONLY INSTANT THAT CAN ANSWER ITS QUESTION.** A re-enrolment
writes `CanariDB_<userId>` back under the same name within seconds of the wipe, so no later sample
separates a store that survived from one that was rebuilt. Whether a returning device ENDS where a
fresh one ends is a different claim, and it belongs to HEAL-REVOKE-2 and -3.

**AND THE FIRST RUN WAS `INVALID` FOR A REASON THAT WAS NOT THE PRODUCT'S.** It wrote *"the victim
could not be brought to an enrolled starting point, so there is nothing to revoke"* - a sentence that
reads exactly like a product fault. `newdevice.mjs` spawned `login.mjs` by BARE NAME with no `cwd`,
so the name resolved against the CALLER'S working directory. **That is what kept it invisible for as
long as it did**: `bun archive/healnew.mjs` started from the harness root works, `cd archive && bun
healrevoke.mjs` does not, and the difference is a `cd` no verdict records - so the primitive had a
history of successful runs while being broken for anyone who entered the directory first. When it
fails it exits 1 with `Module not found "login.mjs"` on a stderr the helper discarded, and reports
`login ok=false`.

**NINTH SIGHTING, AND THE FIRST ONE THE GATE HAD BEEN GREEN FOR.** `spawn-selftest.mjs` exists for
exactly this defect and forbade *a bare string literal in argv*; this site spawns `[script, ...args]`
out of a two-line helper whose callers write `run("login.mjs", ...)`. **A literal at the call site
and a variable at the spawn is invisible to a rule about argv.** The gate is now an allowlist of the
property it was always claiming - the path handed to the runtime must be ABSOLUTE, so
`requireScript(...)`, `join(...)` and a runtime flag are accepted and everything else, a variable
included, is rejected - and the old line is kept as a specimen so the shape can never stop being
seen. Rule in [durable-rules](durable-rules.md).

**One board fault came out of the same session.** LIFE-2's cell quoted a notification shade
containing a `|`, which markdown reads as a column separator: the table silently grew a column, and
`rows.mjs` - which takes the LAST cell as the state - reported `board: unstated` against a ledger
holding `PASS`. The message named the wrong problem, so the reader now checks the cell COUNT (three
after the id, everywhere, measured across all 246 rows) and says so first.

### The HEAL rung's first two nights, and the device cap under all of it

**WHAT THE FIRST NIGHT OF THIS RUNG ACTUALLY MEASURED, 2026-08-28.** Five rows died in a row -
HEAL-NEW-0 `FAIL`, HEAL-REVOKE-5/7/8 and MULTI-8/9 `INVALID` - all on `login: false`, and not one of
them measured the product. **One cause, six rows:** the wipe clears the app's origin and does not
touch the SSO session, which lives on `auth.canari-emse.fr` and `cas.emse.fr`, so the browser walks
the whole flow and lands signed in with no field to fill - and `login.mjs` read "no `#username`
after 30 s" as a failure. `newdevice.mjs`'s own header had said so since it was written; the helper
had not been told. Three rig faults came out, each fixed by making a predicate name what it meant:

- **A missing form is TWO outcomes.** Classified at the throw now, by the fact available there -
  where the browser ended up - because downstream both are the same sentence.
- **`PARAGLIDE_LOCALE` was never a survivor.** MEASURED: clearing the origin leaves `[]`, and the
  reload the rig performs on purpose - so the wipe is read against a fresh document - is what writes
  the locale back. Asserting zero keys asserted against the rig's own reload. The claim is now no
  IDENTITY survived, with an allowlist by name rather than a tolerance by count.
- **`pin.mjs` exits 2 for "no unlock modal", which is an OBSERVATION.** `run()` collapsed every
  non-zero to `false`, so "the gate was not there" and "the gate refused us" reached the verdict as
  the same missing tick. Whether the app challenges a brand-new device is a question about the
  product, not this primitive's claim, and smuggling it in answered it by accident.

**THE SECOND NIGHT MEASURED ONE THING, AND IT WAS THE INSTRUMENT, 2026-08-28 03:30-03:58.**
Run 3 of the ladder took eight rows and recorded NOTHING: HEAL-NEW-2, -12, -3, -11 and -15 exited 1,
and all four HEAL-REVOKE rows exited 2 on the preflight's own refusal. **No verdict from this run is
on this board, and none should be** - `gate` refusing the attribution is again the only reason
nothing false was recorded.

**The five HEAL-NEW rows died on one predicate, and the predicate was wrong.** Every row failed
`sameAccountEnrolled` while everything the row was written to measure had already succeeded: the
wipe was total, the IdP kept its session, the client minted a fresh id (`mtca2o9o-6fn1` for row 2),
and `active` grew from 9 to 10. The poll added the night before then ran its FULL 60 s deadline -
`the census carries the new id: false (after 63762ms)` - so the fix that was supposed to remove the
flake instead proved the fact is never true. **`census()` reads `key_package` UNION
`dm_device_group_memberships`** (`devices.mjs:76`), so a device that has published no KeyPackage and
joined no group is not absent from the census, it is INVISIBLE to it. Measured on prod for that
exact device: `auth_sessions` 1 row at 01:33:32 - the same instant the client reported the id -
`key_package` 0, `one_time_key_package` 0, memberships 0. **There is no device-registry table at
all**; `auth_sessions` is the only table that records that a device exists, and it is the table the
predicate should have read.

**The population question was asked before believing any of it, and it changed the answer.** Web
devices holding a session but no KeyPackage, by day: **12 of 22 today, and ZERO on every day from
2026-08-21 to 2026-08-27** but one. That shape reads exactly like a regression landing with tonight's
deploy - and it is not one: **all 12 belong to `d82cd226`, the harness owner account, first seen
between 01:30:01 and 01:45:59, which is run 3's HEAL-NEW window to the second.** Nothing outside this
rig is affected, and no P1 is opened. **What is NOT settled is which of two causes it is** - the
runner tearing W3 down before the client gets to publish (rig timing), or a wiped profile genuinely
failing to publish (product). The discriminator is one gesture and it is the first thing owed on
resumption: **mint ONE device by hand, leave it entirely alone for ten minutes, then query
`key_package`.** Until that is run, `enrolled` must not be read as a product fact in either
direction.

**The four HEAL-REVOKE rows never started, and the cause is W2, not the runner.** Each preflight
reported `W2 (9223): OFFLINE` and `still unknown on /login after 4 repair(s) - unknown -> unknown ->
unknown -> unknown -> unknown`, while `start w2` answered exit 1 (already running) every time. W2 was
therefore alive, on `/login`, and logged out - and the ladder's `baseline()` cannot repair that,
because `launch.mjs start` is a no-op against a running browser and `unlock.mjs` only answers a PIN
gate. **A device that has lost its session is a state no baseline in this rig currently restores**,
which is the per-STEP starting point queue item 6 was written for, now blocking rows rather than
merely owed. `login.mjs --device W2` against the live profile is the cheap first attempt.

**One rig fault was fixed and has not yet run:** `revoke()` in `healrevoke.mjs` read the census once,
immediately after the purge, and that single read is the gate all four HEAL-REVOKE rows stand on. It
now polls for the disappearance with a 45 s bound and records `goneInMs`. It inherits the census
defect described above and must be re-pointed at `auth_sessions` / `revoked_device` in the same pass.

**AND THE MINT WAS STILL SPENDING A SLOT PER ROW, SILENTLY, UNTIL 2026-08-28.** `becomeANewDevice`
purges the id each mint abandons - through `purge-devices.mjs --port <W1>`, which drives W1's device
PANEL. HEAL-NEW-2 kills W1 by construction (its premise is that no device of ours is online), so the
purge died on `ECONNREFUSED 127.0.0.1:9224` and reported `purged: false - a slot stays spent, and the
cap is one row closer`. **That failure costs a slot and never a verdict, by design**, so a rung of
sixteen such rows walks into the fifteen-device cap with nothing objecting - which is precisely how
15/15 was reached the first time. It now purges through the device it just enrolled, the only client
the function can prove is up and the one guaranteed to be on the right account. First run after the
fix: `purged: true`. The account sat at 3/15 through the pass.

**THE CAUSE OF EVERY HEAL-NEW FAILURE WAS THE PER-USER DEVICE CAP, AND THE PREDICATE WAS RIGHT ALL
ALONG, 2026-08-28 10:22.** One mint on a quiet prod settled it: `POST /api/mls/register-device -> 400`,
`[KP] Publication failed (400) - welcome_request deferred to next connection`, then
`[MEMBERSHIP_ACTIVE] REFUSED reason=no_key_package` on the server for all ten groups. `registerDevice`
counts the account's `key_package` rows and throws at `MAX_DEVICES_PER_USER` = 15 **before it logs
`[REGISTER_DEVICE] START`**, which is why the server's trace looked empty. The owner account stood at
exactly 15, and **all fifteen slots were the campaign's own abandoned mints**. With the debris purged
(25 devices deleted through the product's own panel, account back to 2), the same profile published
its KeyPackage in **1.9 s**.

**AND THE PREDICATE THAT NAMES THE RESPONDER IS SATISFIED BY THE DEBRIS, read 2026-08-29.** Rows 3
and 15 assert `ourOwnDeviceWasInTheFleet` as `fleet.readable && fleet.extra.length > 0`
(`healnew.mjs:600`) - a COUNT, over a presence read whose keys outlive their device by up to 20 s and
which the abandoned mints of this very rung populate. HEAL-NEW-15's `FAIL` on `48b65d08` carried two
abandoned mints in `fleet.extra`, so the expectation would have been met with W1 shut. It is the same
fault as a `PASS` over an empty intersection: a predicate that cannot tell the responder the row NAMES
from the wreckage the row left behind. Every HEAL-NEW cell taken until it asserts W1's own id by name
is owed a read of `fleet.extra` before it is believed.

**THE AMBER WINDOW LIVES INSIDE THE MINT, AND THE DESIGN CALL IS THAT NO BLOCKING WORK MAY SIT
BETWEEN A LIVE CLIENT AND THE FIRST SAMPLE** (trunk, 2026-08-29, on HEAL-NEW-15's `INVALID` of
`dc8bf000`). The probe moved inside the watch and the row was still unaskable one layer earlier: the
watch's FIRST sample read 10 rows, 10 ready, 0 syncing and settled in 2 ms, because the fresh device
had landed on the app at +12.5 s and the runner's first sidebar read did not happen until +61.3 s.
The 49 s in between are `becomeANewDevice`'s own tail - an 8 s settle, the enrolment poll against the
database, and the abandoned-id purge - and every one of them is `spawnSync` or an `ssh`, so the
event loop is BLOCKED and no concurrent reader can exist. Widening a deadline cannot reach this and
neither can a second connection.

**So the primitive is SPLIT at the moment the fresh client is live on `/chat`**, which is the moment
the sidebar starts to enumerate and therefore the moment the row's subject begins. Everything after
it - the settle, the new device id, the two server facts, the purge - is a SECOND call the row makes
once its watch is finished. This is a factorisation and not a new mechanism: the primitive was doing
two jobs, producing a fresh live client and proving it enrolled, and only the first one is a
precondition of watching a sidebar. `enrolled` is read at verdict time, never as a gate, so moving
the proof later changes no assertion - and the guard that actually protects the rung from the device
cap, `theAccountHadRoomForOneMore`, is asserted BEFORE the wipe and stays exactly where it is.

**What the split COSTS, stated so nobody reads it as a measurement it is not:** the enrolment
timings become an UPPER BOUND, because the first database read now happens after the watch rather
than seconds after landing. They are named as a bound, measured from the instant the client went
live, and the real latency belongs to HEAL-NEW-0, which mints and measures nothing else. A column is
only evidence for the question it was written to answer.

**THE SPLIT SHIPPED, IT WORKED, AND IT WAS NOT ENOUGH - so the row is RE-SCOPED, which is the
trunk's call and not the branch's** (2026-08-29, on runner `56090443`). `watchOpenedAfterLiveMs` fell
from ~49 000 ms to 1 118 ms and the row was still `INVALID`: all ten `welcome_request`s land between
+12.9 s and +14.9 s, the sidebar is 10/10 by +15 s, and the handover is at +37.6 s. **Most of the 22 s
in between is `pin.mjs` polling for a modal a fresh device never shows** - a fact this page has
recorded since 2026-08-28 and which the sequence then spent twenty seconds re-learning.

Three decisions follow, and the first is the one that matters:

- **HEAL-NEW-15 moves to `at: "late"`.** Its own words are *N rows amber, and the user navigates and
  sends*, and on `at: "start"` there are no N rows amber: W1 is a member of all eleven groups and the
  heal is over in about two seconds. That is not a slow instrument, it is a topology with no window
  in it, and no amount of earlier observation manufactures one. A late responder gives `ALONE_MS` of
  amber alone and then a STAGGERED heal, which is the only shape in which a ready row and a syncing
  row coexist - the exact instant the usability probe is written to fire. **Nothing is lost by the
  move**: row 3 already owns the start-topology heal, and row 15 was never part of an order pair.
- **The handover moves AHEAD of the PIN probe.** `ensureChat` runs as soon as the client lands, the
  row takes its client there, and the PIN probe joins the rest of the post-watch work in
  `confirmEnrolment`. No expectation reads `pinGate` or `pinOk` - they are recorded observations, and
  section 17 is where they are judged - so nothing is weakened. If a gate ever IS shown, the row's
  first sample reads `panel: false` and the `INVALID` names it, which is a better answer than
  blinding the row for twenty seconds to ask a question whose answer is already on this page.
- **The sampling cadence is per row.** A 2 000 ms cadence cannot see a two-second window, and a
  reader that cannot resolve the event it is pointed at reports its own period as the product's
  behaviour.

**AND THE ROW GAINS THE PROBE IT WAS ALWAYS DESIGNED AROUND AND HAS NEVER HAD** (branch, 2026-08-29).
This row's design has said since it was written that *an amber sidebar that cannot be clicked fails
the row*, and every instrument built for it clicked a `data-ready="true"` tile - which measures the
opposite half, *a healed conversation opens*. The amber half was unmeasurable for a plain reason:
until the late topology there was no amber row alive long enough to click. `amberListCost` clicks a
SYNCING tile during the alone window, which this topology guarantees for `ALONE_MS`, and times the
app's acknowledgement.

**It asserts the TIMING and never the outcome, and the distinction is the whole probe.** A
conversation with no MLS state that declines to open is legitimate product behaviour; a list that
does not react at all is a frozen app, and only the second is a finding. So `answeredBy` records what
the app did and `answeredInMs` how long it took, and only the second reaches an expectation. The
three usability numbers a run now carries are three different apps: `amberList` is a click on a
syncing tile with nothing healed, `usability.whileAmber` a click on a ready tile mid-heal, and
`usability.afterSettle` a click on a healed sidebar.

**The behaviour was OBSERVED before the probe was written, on a bench built for it.** A fresh device
with W1 killed and the phone stopped cannot be served by anybody, so its sidebar stays amber
indefinitely - HEAL-NEW-1 measured ten rows amber for 600 s - which makes it the one place this
question can be poked at by hand. Measured there on 2026-08-29, 10 rows / 0 ready / 10 syncing: a
click on a syncing tile is answered in **35 ms**, the tile goes selected AND a composer appears, the
route does not change and no toast is raised. **So today the product opens a syncing conversation**,
and the probe still does not assume it will tomorrow - selection alone answers the row.

**That needed one product change, and it is an instrument rather than a behaviour.** The only
statement a tile made that it had received a click was its SELECTED STYLE, a Tailwind class string; a
reader matching it would report a frozen app the day the style is restyled, which is the "Sync" badge
mistake in different clothes. `ConversationTile` now publishes `data-selected` beside `data-ready` and
`data-removed`, for the reason written in its own markup comment. Nothing renders differently.

**What the re-scope does to the expectations, since a set that is not audited drifts:** it GAINS
`wentAmberBeforeTheResponderArrived` and `ourOwnDeviceArrivedLate`, LOSES
`ourOwnDeviceWasInTheFleet` (which is the `at: "start"` predicate), KEEPS the five that describe the
mint and the reader, and still asserts NOTHING about healing - `expect` stays `either`, so a green
sidebar is not this row passing. `navigableWhileAmber` moves from asserted to **asserted only where it
was askable**: it needs a sample holding a ready row and a syncing row at once, which only a staggered
heal produces, and demanding one would fail the row for the shape of the heal rather than for the app.
What makes a run `INVALID` is no longer that coexistence but the amber-alone window failing to open at
all - the premise the rig owes, which is what `INVALID` has always been for.

**MEASURED ON THE NEW TOPOLOGY, `PASS-DIRTY` on `038c7e8d`** (branch, 2026-08-29). The window opened
exactly as designed: ten rows amber alone 27 s after the mint, W1 started only then and arriving 9 s
later, the heal staggered over 858 ms once it did. **The click on the amber list was answered in
26 ms** - selected AND opened - and a mid-heal sample holding 4 ready and 6 syncing made
`navigableWhileAmber` askable, answered in 10 ms; a healed sidebar answered in 165 ms. Three clicks,
three different apps, all under a fifth of a second. `laggards: 0`, `finalState` 10/10 ready.

**Its first run FAILed on the instrument, and the cause was the mint split itself** - the second half
now runs last and leaves the client on `/settings`, so the row's closing sidebar read had no sidebar
under it. Fixed where the navigation happens; the reasoning is in
[testing-methodology](testing-methodology.md#a-primitive-that-navigates-the-client-owes-putting-it-back-and-splitting-one-is-where-that-debt-comes-due),
and it matters beyond this row because every HEAL-NEW row reaches that same closing read.

**This is the rung's FIRST verdict to have passed `gate()`** - HEAL-NEW-1, -3 and -11 predate it. The
dirt is mint-shaped and none of it is this row's subject: a `POST /api/auth/refresh -> 401` from a
client that has just wiped every cookie, a 415 no `badHttp` entry names, the OIDC callback's `debug:`
trail and the purge's `[DevicePanel]` lines in a production console. **One line is HEAL's own and goes
back to the trunk**: 60 s after external-joining the community distribution group at epoch 56, the
device found `the group holds NO row for it ... the local group is stale, rejoining` and joined again
at 57. A race that heals cleanly is still a defect. Reconciliation asked **10/11 groups in 794 ms**;
the unasked one is that same distribution group. No deferrals at all this run - zero
`no probe sender yet`, zero `no member online for` - and no `[MEMBERSHIP_ACTIVE] REFUSED` and no
`[KP] Publication failed`.

**So the census was never the wrong question - it was the RIGHT one, asked of a device the server had
refused.** Reading `auth_sessions` instead made the row pass while the device was unusable, which is
worse than the failure it replaced. The primitive now reads BOTH facts and reports the pair: a session
with no KeyPackage is not "publication is slow", it is "the registration was REFUSED, go read the
server's line". It also asserts the account has a free slot BEFORE it wipes anything, and purges the
id each mint abandons - a sixteen-row rung fills a fifteen-device cap by construction. **The product
half is a P1 in [backlog](backlog.md): a 400 that means "delete a device" reaches the user as a
console line saying "deferred to next connection".**

**Restorable since 2026-08-28**: `setTopology` was a sixth copy of "bring a client up" and could not restore a session, so those four verdicts measured the rig; it now uses `bringToReady`, checks its ACTOR before minting the victim, and `state.mjs` reads `/login` as `signedOut`. Story in `CHANGELOG.md`, rule in [durable-rules](durable-rules.md).
