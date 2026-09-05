# Backlog

**Everything below is SCHEDULED** - the user's decision of 2026-08-18: the backlog and `CLAUDE.md`
are both emptied before the campaign restarts. This file is no longer a parking area; it is the
DETAIL for the queue in `CLAUDE.md`, which carries the order and one line per item. Read the order
there, the substance here, and delete an entry from BOTH when it ships.

The exception is the handful that genuinely cannot be pulled forward - blocked upstream, blocked on
an iPhone that does not exist, blocked on credentials somebody else owes, or post-campaign by the
user's own decision. Each says which it is, and `CLAUDE.md` lists them together at the end of the
queue so that "not scheduled" never has to be inferred.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`, the mechanism to the wiki page that entry points at. An entry describing its own fix
is an entry nobody trusts to be current.

**NOTHING FIXED BELONGS IN THIS FILE.** Where a fix is in the tree and only its measurement is
missing, it gets ONE LINE in the table at the top and no entry of its own - a fixed thing mixed in
with open work is how a queue stops being readable (user, 2026-08-30). Where an entry keeps an open
half, the shipped half is a pointer, never a retelling.

---

## Owed a VERIFICATION, and nothing else

Each of these is fixed in the tree; what is left is the measurement that would prove it. **Nothing
about them is open work** - the story is in `CHANGELOG.md`, the mechanism on the wiki page named,
the rule in [durable-rules](durable-rules.md). Delete the line once the measurement is taken.

| What | The measurement that closes it |
| --- | --- |
| `/forms/success` no longer asks for a form called `success` | after the deploy, social-service logs no `invalid input syntax for type uuid: "success"` across a completed payment - the symptom fired once per payment, so ONE payment settles it. The unit test pins the derived set; only prod pins the silence |
| the `apiFetch` fallback now names its cause | the next run's logs separate "a container is restarting", which needs nothing, from "refresh is broken", which needs everything - they were the identical line. If one cause dominates, its RATE wants measuring against the population before the name "transient" is believed |
| the `[PENDING]` line that called a routine race "Non-recoverable" | the next run reports it in `notable` from an ANCHORED rule, not from the generic `epoch` rule matching words an error string happened to carry. **The two old spellings stay pinned** until A1 runs a build emitting the new line - an APK embeds its frontend and is not reached by a deploy |
| a push carries its ciphertext once, not twice | HARDWARE, both platforms, iOS the riskier half - no iPhone has yet received a push built without the redundant `data` map ([chat-delivery](services/chat-delivery.md#transport--single-gateway-fcm)) |
| a device with no push token now says so | after the next release, a tokenless device either acquires one or prints `[PUSH_UNAVAILABLE]` naming a cause; continued silence with a tokenless device still in `key_package` means a FIFTH cause, not a fixed one |
| the notification quick reply's 403 | HARDWARE: check K steps 1-5 and **K2**, on A1 which already carries the build - **and the window must be ARMED, a run made without arming proves nothing** ([check K](device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)). The iOS twin is corrected identically and equally unproven |
| the login button that took a press and showed nothing | the fix is a reordering, visible in the component's own state, so any cold `/login` press proves it. What is NOT explained is the 2026-08-28 measurement's "no request" over thirty seconds: a version check running its ladder would have issued three. Read the network tail of the next cold login before calling that measurement understood |
| the last server-composed sentence now asks the device which language it reads | after the next release, `[PUSH_REGISTER]` prints `locale=fr` or `locale=en` rather than `unstated` for a device that has restarted once - every client re-registers on its next start because the skip predicate changed shape. The VISIBLE half needs an iPhone AND a failed NSE, which is why the log line is the measurement |
| acknowledging a conversation from the notification shade | HARDWARE, both platforms. On A1: send from W1, background the app, tap **Marquer comme lu**, then OPEN the app - the badge must be gone, which is the half that needed `read_watermarks.ndjson`. Then the same with a quick REPLY, which now means the same thing. `logcat` must show `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never a value near `now`. Board row **NOTIF-6b**, and the iOS twin is written identically and equally unproven |
| search folds accents now, everywhere it folds case | **SEARCH-5, and it needs `W1 W2` only - no hardware.** Its five `PASS`es asserted the pre-fix behaviour (the row was written to RECORD the gap), so they are VOID and the runner's prediction is flipped. A run answering `noAccentFound=true` closes this; SEARCH-1, -3 and -6 are ASCII-only and unaffected |
| WP-REGRANT-2, a re-granted member's re-join | COMM-22, four grant/revoke cycles green - and COMM-8 reading `seedAfterTheGrant: true`, never `repaired`, which is a fallback and not a path |
| the auto-merge sweep drains its queue unattended | the next sweep after a merge must merge EVERY pull request that is mergeable, not one. Until 2026-09-01 each merge moved `main` and staleness-invalidated the rest, so the queue drained at one per pass and only while somebody pushed; the predicate now asks whether `.github/workflows/` or `.github/scripts/` moved instead. #302 and #303 are the population sitting on it - both `CLEAN`, both built on `6a356d7e`, neither touched by a gate change. One sweep log showing both merged closes this |
| a security advisory now has an ACTOR at all | `automated-security-fixes` was `{"enabled":false}` while alerts were on, and the `cargo` ecosystem limits `production-dependencies` to patch - so `serde_with` 3.19.0 -> 3.21.0 (GHSA-7gcf-g7xr-8hxj, medium, `frontend/src-tauri/Cargo.lock`) could be reported and never fixed by anything. Enabled 2026-09-02, and it fired within the minute - **onto a THIRD refusal nobody knew about**, the update job failing on a manifest cargo cannot parse (P1 below). So **this row cannot close on alert 210**: it closes on the first security pull request Dependabot opens for ANY directory, and 210 itself waits on the P1 |
| the auto-merge ceiling refuses a major | **half taken.** The workflow is enabled again and its shipped loop body was replayed over all 33 open Dependabot PRs: 26 merge, 6 refuse, and the 6 collapse to the two gates below. What replay cannot show is the workflow REFUSING in its own run log, because no major has opened since - so the row stays until a real one does, logging `REFUSED` and staying open |
| the five products the boutique never sold are buyable | **ONE MANUAL FLIP IS OWED, and it is the user's** (2026-08-31). `activationWithheld` releases a product when payments BECOME ready, and BDE's Stripe onboarding completed long ago - no event will ever fire for it, which is the correct behaviour for an allowlist and the reason a per-tier on-sale switch now exists. So: open `/associations/bde/edit`, Cotisations tab, tick **En vente** on the 170 EUR tier, then buy nothing and simply confirm it appears in `/shop`. The other four associations have no payment account at all, so their products are correctly withheld and release themselves when one arrives - what closes THAT half is the next association to finish onboarding, whose products must go on sale with nobody touching them |

---

## Owed to the USER - decisions, rotations and one-off clicks

**This section holds NO substance.** Every line points at the entry that carries it, and exists only
so that "what is waiting on me" is one list rather than a sweep of the file (user, 2026-09-02:
*"Fais moi une liste des choses qu'il me reste a faire"*). Delete a line when its target entry ships
or its click is made. A line here is a thing NO agent can do - a decision, a credential somebody
else holds, a console owned by the user, or hardware that does not exist.

| What | Kind | Where the substance is |
| --- | --- | --- |
| ~~UNLOCK THE CAMPAIGN PHONE~~ **DONE 2026-09-05** (`deviceLocked=0`, measured). What remains is OPTIONAL and the user asked for it: removing the pattern needs the credential, so either they clear it in Settings or it joins `test-accounts.json` like every other one. Retiring the lock costs no key material - both keystore keys are explicitly `setUserAuthenticationRequired(false)`, measured before proposing it | 1 gesture on the device | [P2 - every silent push on the phone fails to decrypt](#p1---a-backgrounded-phone-is-never-told-about-a-message-it-has-already-received-because-the-js-layer-waits-for-a-push-the-server-never-sends-measured-on-device-2026-09-05) |
| choose how production says it is down - the probe must hit `/api/version`, which needs the database | decision, then ~1 click | [P2 - nothing tells anybody production is down](#p2---nothing-tells-anybody-production-is-down-and-both-outages-of-2026-09-01-were-reported-by-the-user-owed-to-the-user-a-decision-then-one-click) |
| should a dev-ONLY trigger exist - today one push deploys both estates and a broken dev BLOCKS production, by design | decision | [dev.canari-emse.fr becomes a real second environment](#devcanari-emsefr-becomes-a-real-second-environment---decided-2026-08-17) |
| a fine-grained PAT from an account WITH PUSH ACCESS - the App token was measured refused, ten times | decision | [P1 - no identity CI can mint may ask Dependabot to rebuild a branch](#p1---no-identity-ci-can-mint-may-ask-dependabot-to-rebuild-a-branch-so-a-moved-gate-parks-the-whole-queue---and-the-app-token-was-the-recommendation-this-row-itself-made-measured-2026-09-03) |
| PostgreSQL 15 -> 18, parked by the user (*"on verra ca plus tard"*); its test also releases `redis` and `garage` | decision | [P2 - PostgreSQL is held at 15](#p2---postgresql-is-held-at-15-because-18-needs-a-migration-nobody-has-performed-after-the-outage-of-2026-09-01) |
| is a MiGallery application worth building | decision | [post-campaign projects](#post-campaign-projects---decided-not-scheduled) |
| how `frontend/src-tauri` gets its cargo updates - Dependabot cannot parse it and the fix that would let it is verified only by an Android AND an iOS build | decision | [P1 - two of the six cargo directories are invisible to Dependabot](#p1---two-of-the-six-cargo-directories-are-invisible-to-dependabot-and-one-of-them-is-the-app-that-ships-to-phones-measured-2026-09-02) |
| rotate `CF_DNS_TOKEN` **and** the cloudflared tunnel run token - both reached a transcript on 2026-09-01 | rotation | agent memory names both; neither may enter this repo |
| put the BDE 170 EUR tier on sale - an allowlist correctly withholds it and no event will ever fire | 1 click | the verification table above |
| App Store Connect: the 2.3.6 radio button | 1 click | [mobile](frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on) |
| Lydia's credentials, which Lydia owes | blocked upstream | WP-LYDIA-1 |
| an Android phone and an iPhone - unblocks the whole verification table above and the campaign | hardware | [device-verification](device-verification.md) |
| copy `canari-harness/` to the second machine to resume the campaign; **SETUP-4's 2FA is no longer owed**, the test accounts carry no MFA | 1 copy | [cross-client-campaign-resume](cross-client-campaign-resume.md) |

**Firebase owes nothing** (asked 2026-09-02): dev reuses the existing `fr.emse.canari` app, and the
`DEV_*` push secrets are disposition `warn`, so their absence has never blocked a deploy - the fact
and its test are on [dev-environment](infrastructure/dev-environment.md).

---

## CI and the chain that runs unattended

### P2 - a 7.3 TB RAID1 now has a sensor and still has no report, and nothing on that host can reach a human (measured 2026-09-03)

**`mitv`'s mirror was monitored by nothing at all until 2026-09-03** - `mdmonitor.service` had
refused to start on every boot back to at least 9 June, for want of an alert destination. It runs
now, with severity by event class, and its alarm was proved by firing a test event through the real
path. The whole account, including why `MAILADDR` would have made it worse and the stale `spares=1`
that would have cried wolf on every boot, is
[host-updates](infrastructure/host-updates.md#the-73-tb-raid1-nobody-was-watching-found-while-rebooting-for-the-kernel-2026-09-03).

**What stays open is the channel.** The events go to syslog, and syslog on that box is read by
nobody and nothing: postfix and exim4 are inactive, and `monit` runs with no `set alert` and no
`set mailserver`. So a failing disk is now RECORDED and still not REPORTED.

**What retires it:** `/proc/mdstat` read into the daily host report - a degraded array is exactly
the shape that report already handles, and it would name the array and the missing component - plus
that report reaching hosts other than production, which is the row above this one. The two close
together or not at all, and neither needs a new mechanism, only the existing one pointed at one
more fact and one more box.

### P3 - vitest cannot start a worker on this workstation, so half of `make run-ci` is not available where development now happens (measured 2026-09-03)

`bunx vitest run src/lib/utils/appVersion.test.ts` ends in
`[vitest-pool-runner]: Timeout waiting for worker to respond` after 60 seconds, reporting
`Test Files  no tests`. Measured with the default pool and with `--pool=forks`, and with a single
test file, so it is not one suite being slow - **no worker starts at all.**

**Why it is not cosmetic.** WP-5 moved development and the whole test campaign LOCAL, and
`CLAUDE.md` names `make run-ci` as the full local pipeline. A local gate that cannot be executed on
the machine doing the work is not a gate: the frontend half of that pipeline is currently CI-only,
so a frontend defect is found after a push rather than before one. It also means a session cannot
verify a frontend change it just wrote - on 2026-09-03 a `compareSemver` fix had to be checked by
extracting the function into a standalone script (13 cases, all passing) because its real test file
could not be run, and only CI exercised the file itself.

**What retires it:** naming the cause. Candidates not yet separated - Windows plus the forks pool,
the `paraglide:compile` step the `test` script runs first, or a `node_modules` state specific to
this box. `bun test` as a runner is NOT the answer to reach for: the suites are written for vitest,
and swapping the runner to dodge a broken worker would change what is being asserted.

### ~~P1 - a release-asset upload was refused with the permission it was granted~~ - RETIRED 2026-09-04, the call that was refused is deleted

**Not fixed: withdrawn, because the step no longer makes the call.** On the stable `v0.16.0` the iOS
arm's `softprops/action-gh-release@v3` step found the release and was then refused:

```
Found release v0.16.0 (with id=382122297)
Unexpected error fetching GitHub release for tag refs/tags/v0.16.0: HttpError: Resource not accessible by integration
  https://docs.github.com/rest/releases/releases#update-a-release
```

**THE FULL POPULATION, MEASURED 2026-09-04** across every release since the gated chain began -
five stables and five pre-releases:

| arm | pre-release | stable |
|---|---|---|
| iOS (`Canari.ipa`) | attached, 5/5 | **refused on 0.16.0**; SKIPPED on 0.16.1, 0.16.2, 0.16.3 |
| Android (`.aab` + `.apk`) | attached | attached, 5/5 |

Four things that measurement settles, each of which was open:

- **It is not transient.** The re-run this entry called "open, and cheap" was attempt 2 of run
  `33771324318`, and it **reproduced the 403 identically**.
- **It is not `prerelease: false`.** The Android arm's identical step - same action, same token, same
  run, same release - SUCCEEDED on that very stable 24 minutes earlier (15:24:34 against the iOS
  failure at 15:48:21), and on all three stables since.
- **It is not the asset upload.** The error names `update-a-release`, and the action's own message
  says *"fetching ... for tag refs/tags/v0.16.0"* - it FINDS the release by `tag_name`, then makes a
  second, `github.ref`-shaped call. **That hostile second lookup was already documented in
  [cicd](cicd.md#notable-ci-gotchas) before 0.16.0**, with the same error string, for the
  `refs/heads/main` variant under `workflow_dispatch`. The tag variant under a `release` event is
  new; the class is not.
- **The missing `Canari.ipa` on the other four stables is not this defect at all.** Since the
  ordering fix the step runs AFTER the App Store submission, and that submission failed on 0.16.1,
  0.16.2 and 0.16.3 - so `Upload to Release` was `skipped`, not refused. The 403 has had no
  opportunity to recur.

**WHY THE ROW IS WITHDRAWN RATHER THAN CARRIED.** Attaching a file to a release needs no release
UPDATE, so the capability that was refused is one neither arm ever wanted. Both now use
`gh release upload "$TAG" ... --clobber`, which performs exactly one call - POST to the release's
assets - and creates nothing when the release is absent, which is strictly better than the action it
replaces (that one would have CREATED a release, publishing a release, restarting `release.yml`;
hence the `github.event_name == 'release'` guard, which stays). `release-chain.test.sh` refuses an
`uses:` in either step and requires `gh release upload`, validated in negative.

**What is NOT explained, and now has no consumer:** why that second lookup was refused for a
stable's tag and not a pre-release's. The org-ruleset candidate still needs `admin:org`, which this
token lacks. Nothing calls that endpoint any more, so nothing can answer it and nothing depends on
the answer - which is why the mechanism note in [cicd](cicd.md#notable-ci-gotchas) is where the
lesson lives instead of here.

### P2 - the nine NestJS pull requests were closed IN ONE BATCH, so the suppression question was never measured on one first, and Monday 2026-09-07 is the only thing that can answer it now (updated 2026-09-03)

**THIS ROW WAS WRONG UNTIL 2026-09-03 AND SAID THE OPPOSITE.** It claimed nine of the ten backend
pull-request slots were held by NestJS 12 bumps that could never go green. **They are all closed** -
`#282 #281 #280 #278 #277 #267` and the rest, every one `CLOSED merged=non` at **2026-09-03T08:14**,
the same minute, so this was a batch action. Two backend slots are occupied now, not nine, and the
queue is not the problem any more.

**WHAT THE BATCH COST IS THE MEASUREMENT, NOT THE QUEUE.** The plan written here was explicit: close
**ONE** first, because closing a Dependabot pull request tells Dependabot to stop proposing that
VERSION of that dependency, and nobody had established whether that suppression is per-package or
would also silence the `nestjs` GROUP that is supposed to replace them. Closing all nine at once
removed the control case. There is now exactly one way to find out, and it is to wait: the cargo and
bun ecosystems are on `interval: weekly, day: monday`, so **Monday 2026-09-07** is when Dependabot
next evaluates.

**THE TWO OUTCOMES, AND THEY NEED DIFFERENT FIXES:**

| What appears on 2026-09-07 | Meaning | What to do |
|---|---|---|
| ONE grouped pull request per service, `@nestjs/*` together | the group works and suppression is per-PR-version, not per-group | nothing; merge it through the ordinary gate |
| NOTHING at all | closing the singles suppressed 12.x for those packages | the requirement has to change to un-suppress it - bump the version range in each `package.json` by hand, or re-open one closed pull request |

**THE FOUR openmls PULL REQUESTS ARE THE SAME QUESTION, STILL IN ITS "BEFORE" STATE** - and that is
what makes them worth keeping open rather than tidying away. `#297 #295 #291 #290` bump
`openmls`, `openmls_traits`, `openmls_rust_crypto` and `openmls_basic_credential` from `0.8.1` to
`0.9.0` as four SINGLES, all four red, for the documented reason that none can build alone
(`there are multiple different versions of crate openmls_traits in the dependency graph`). **The
`openmls` group already exists** in `.github/dependabot.yml` with `patterns: ["openmls*"]` and all
three update-types - it simply landed AFTER these four were opened, exactly as the `nestjs` group
did, and Dependabot does not group retroactively.

So they are the control case the NestJS batch destroyed: **close ONE of the four on or after
2026-09-07, once the NestJS outcome is known**, and the pair of observations answers the suppression
question for good. Closing all four now would repeat the same mistake on the one family where
getting it wrong is an ENCRYPTION defect rather than an availability one.

### P1 - two of the six cargo directories are invisible to Dependabot, and one of them is the app that ships to phones (measured 2026-09-02)

**The Tauri app has had no automated dependency update since 2026-08-08, and its security alerts have
no actor at all.** Enabling `automated-security-fixes` (the row above) made Dependabot attempt the
`serde_with` bump within the minute, and the update job FAILED - which is the only reason anybody
learned this. Cargo refused the manifest before considering any version:

```
error: failed to get `tauri-plugin-customtabs` as a dependency of package `canari v0.14.15`
Caused by: failed to parse manifest at `.../plugins/tauri-plugin-customtabs/Cargo.toml`
Caused by: package specifies that it links to `tauri-plugin-customtabs`
           but does not have a custom build script
```

`build.rs` is committed and present in the working tree. **Dependabot materialises a temp checkout of
manifests and lockfiles only** - it stubs declared lib and bin targets and copies no build script -
so a `links` key is a manifest cargo will not read. The key arrived with the Android custom-tabs
plugin on 2026-08-08 (`7cf394f3`, WP-OIDC-TAB-1), and it blocks BOTH declared directories whose graph
reaches that crate: `/frontend/src-tauri` and `/frontend/src-tauri/plugins/tauri-plugin-customtabs`.

**THE POPULATION IS THE PROOF, AND IT WAS SITTING THERE FOR 25 DAYS.** `/frontend/src-tauri` has
produced exactly ONE Dependabot pull request ever - #195, 2026-07-24, two weeks before the plugin -
and the plugin directory none at all, while `/apps/chat-gateway` and `/apps/call-service`, in the
same ecosystem entry, produced eighteen across 2026-08-26 and 2026-08-31. A dependency graph that
stops moving looks exactly like one with nothing to update, which is why the absence has to be
asserted rather than noticed.

**WHAT IS ALREADY DONE: the silence is closed.**
`.github/scripts/tests/dependabot-cargo-reach.test.sh` (in `make test-ci-scripts`, six assertions)
reads the cargo directories out of `dependabot.yml`, follows every `path = ` dependency out of each
root manifest, collects the manifests declaring `links`, and compares the resulting set against a
pinned one - so a NEW blocked directory fails on the day it is committed and these two cannot be
forgotten. The derivation is proven on a fixture in the same file rather than trusted, and both
mutations were checked to fail (removing the `links` key, and pinning a directory `dependabot.yml`
no longer declares).

**WHAT IS OPEN IS THE CHOICE, AND ITS THREE OPTIONS ARE NOT EQUAL.**

1. **Remove `links` from the plugin manifest.** It is what exposes a build script's metadata to
   dependents, and this build script is `tauri_plugin::Builder::new(COMMANDS).android_path("android")
   .ios_path("ios").build()` - the call that tells `tauri-build` where the plugin's Kotlin and Swift
   live. Dropping it plausibly drops the native half of the plugin from the app, which **compiles
   fine and fails at runtime on a phone**: exactly the class three iOS defects already came from.
   Only an Android AND an iOS build, then a login on a device, could clear it. Cheapest to type,
   most expensive to be wrong about.
2. **Take the two directories out of `dependabot.yml`.** Honest bookkeeping, no risk, and it makes
   the shipped mobile artefact permanently unmanaged - the outcome the user's *"un projet qui peut
   'vivre tout seul'"* is against.
3. **Keep both declared and update those two directories deliberately**, which is the state today
   minus the silence. It needs a named trigger, because "somebody remembers" is not a mechanism: a
   scheduled job that runs `cargo update --dry-run` in `frontend/src-tauri` and opens an issue, or
   the release checklist doing it before each mobile build. A routine bump is not visible - and
   **neither is a vulnerability, which this option assumed until 2026-09-04**: see below.

**AND THE ONE THING THAT WAS SUPPOSED TO COVER THE GAP DOES NOT (measured 2026-09-04, same crate).**
Option 3 rested on "`cargo audit` already runs in CI, so a VULNERABILITY there is visible". It is
false. GitHub raised GHSA-7gcf-g7xr-8hxj against `serde_with` 3.19.0 in this very lockfile - a panic
on an empty `KeyValueMap` entry, medium - and `cargo audit`, run by hand on the unbumped tree,
**exited 0**. The advisory is GHSA-only and is not in the RustSec database `cargo audit` reads, so a
green Rust pass is not evidence about GHSA at all. The bump landed as its own commit; what stays
open is the blindness, and it is a THIRD mechanism rather than a variant of the two above:

- Dependabot cannot open the pull request (the `links` manifest, this whole entry).
- `cargo audit` cannot see the advisory (different database).
- ~~**Nothing in CI reads GitHub's own alert list**~~ - **CLOSED 2026-09-04.**
  `.github/scripts/dependabot-alerts-report.sh` runs in the nightly `Scheduled` pass, on the 02:00
  cron beside the analysis it completes, and an open alert makes the run RED. It was found in the
  first place because a `git push` happened to print a line about it.

The alert list is a property of the DEFAULT BRANCH, not of a pull request's tree, so a pull request
can neither be blamed for an open alert nor sensibly blocked by one - which is why the report is in
the nightly pass and nowhere else.

**WHAT THAT REPORT HAD TO GET RIGHT, because it is the same defect class one layer up.** An empty
alert list has four causes and only ONE of them is health: a 200 with no alerts, a 403 (the token
may not read alerts, so NOTHING looked), a 404 (the feature is DISABLED, or the slug is wrong) and
no response at all (a transport failure, which is not an answer). The last three fail the run by
name; a reporter that prints "0 open alerts" when it was refused would be exactly the mechanism this
entry accuses `cargo audit` of being. Both refusal arms were measured against the real API rather
than reasoned about, and `dependabot-alerts-report.test.sh` pins all four plus a response whose
SHAPE changed - valid JSON, right count, none of the fields this reader wants - which must accuse the
reader rather than count as zero. 19 assertions, in `make test-ci-scripts`.

**Adding it made `scheduled.test.sh` fail, and the test was wrong.** Two jobs on one cron is legal,
and that test says so in its own note - while comparing declared against claimed with `comm` over
NON-deduped lists, so the second claim on 02:00 came back as a cron no schedule declares. It failed
and passed the "legal, check it is deliberate" note in the same run. Deduped now, with both
directions of the real assertion re-validated by planting an undeclared cron.

**Measured the day it was written**: 0 open alerts, 2 dismissed, 98 fixed - including
GHSA-7gcf-g7xr-8hxj itself, now `fixed`, in `frontend/src-tauri/Cargo.lock`.

Option 3 with a real trigger, plus option 1 attempted behind a mobile build when a device exists, is
the shape that fits the rest of this repository - but which one is taken is a decision, and it is
recorded in the table of what is owed to the user above. Upstream, this is dependabot-core's cargo
updater not copying build scripts; nothing here can fix that.

### P2 - a dev deploy still cannot tell a broken CHANGE from an unreachable REGISTRY, and the conflation MOVED rather than went away (measured 2026-09-02, first day it ran)

**The original measurement.** `deploy-to-server` used to need `deploy-dev` to be `success` or
`skipped`, and the hazard written into the comment above that clause the day it was added - *"a dev
estate broken for a reason of its own would hold production's releases hostage"* - materialised
within hours. Run `33633156004` (workflow_dispatch, 13:00, 17m38s): everything built, every image
pushed, and `Deploy to dev.canari-emse.fr` failed in 16 s on

```
Image ghcr.io/emse-students/***/frontend:dev Error failed to resolve reference ...
  net/http: TLS handshake timeout
```

A TLS handshake to ghcr.io. Production was not deployed because the other estate could not reach a
registry - nothing about the change, nothing about the data, nothing a second environment exists to
catch.

**WHAT THE WORKFLOW MIGRATION CHANGED, AND WHAT IT DID NOT (2026-09-03).** `deploy-to-server` no
longer names `deploy-dev` in its `needs:` at all, and this time that is not a re-routing: **a run
deploys exactly one estate.** A pre-release runs `deploy-dev` and stops; a stable runs
`deploy-to-server` and never touches dev. So a registry timeout on the dev deploy can no longer
block, delay or silently cancel anything production-bound, which is the whole of what the branch
split had merely MOVED.

**The conflation itself survives, one estate smaller.** A `deploy-dev` that fails on a TLS handshake
to ghcr.io still reports the same red run as a `deploy-dev` that fails because the change is broken,
and the cost is now precise: **the dev estate silently did not receive that pre-release**, so the
next alpha tester is measuring the previous build and nothing says so. That is smaller than "a
release that did not happen" and it is the same defect.

**Owed, unchanged in substance:** the dev deploy separates the failures it OWNS (a migration refused,
a container that will not start, `/api/version` unanswered) from the ones it merely observed (a
registry timeout, an SSH drop), and only the first stops the promotion; an observed failure is
re-attempted rather than reported. A retry on the pull is not the fix - it narrows the window and
leaves the conflation - though the pull should retry too.

**And the second half, which the split made newly visible:** nothing reports *"`dev` is green and
`main` was not advanced"*. That is the same shape as the P2 below - a correct mechanism with no
report is found by hand, a day late - and the probe owed there (`/api/version`, hitting the database)
is the same probe. They want doing together. Until then the escape is still one visible variable:
`gh variable set DEV_ENVIRONMENT_ENABLED --body false`, which skips the dev arm and sends releases
by the emergency path, a push straight to `main`.

---

### P2 - NOTHING TELLS ANYBODY PRODUCTION IS DOWN, and both outages of 2026-09-01 were reported by the user (owed to the USER: a decision, then one click)

**This is the largest thing the postgres outage exposed, and it is not a code defect.** Production
lost every backend service twice on 2026-09-01, for 33 minutes and then again after a manual deploy,
and on both occasions the thing that raised the alarm was **the user noticing**. Nothing in this
repository or on the box would have said so.

**What DID report, and why it was not enough.** The CD run went red both times, on `Run database
migrations` - so the mechanism worked and the signal existed. Nobody is paged for a red run, and a
GitHub notification in a mailbox is not a page. Worse, the frontend kept answering **200** throughout:
`frontendDist` is embedded and nginx serves it without touching a service, so every external check
that reads the homepage saw a healthy site while `auth_db` was unreachable. **A liveness probe must
hit something that needs the database** - `/api/version` and `/api/chat-delivery-health` both do, and
both returned 502 the whole time.

**What is owed to the user is a DECISION, not a tool** (`CLAUDE.md`: one-off actions go to the user).
The cheapest honest option is an external probe on `/api/version` and `/api/chat-delivery-health`
with a notification - Cloudflare already fronts all three zones and can do it, or any uptime service.
It is a few clicks in a dashboard, and building a poller in this repository to replace them would be
exactly the waste that rule names.

**One thing that would be code, and is worth doing whichever way the above goes:** CD's health checks
(`Health Check`, `Wait for services to be healthy`) run AFTER the migration step, so a deploy that
fails on migrations never reaches them and reports only "migrations failed" - true, and silent about
the estate being down. Reaching them on the failure path, or asserting the datastores before
migrations, would make the run say what actually happened.

### P2 - PostgreSQL is held at 15 because 18 needs a migration nobody has performed (after the outage of 2026-09-01)

**This is a DEFERRAL the user chose, not a defect** (2026-09-01: *"remettre 18 est pas si genant si on
fait la migration, mais on verra ca plus tard"*). Nothing is broken while it waits; the point of the
entry is that the reason for the pin is a missing PROCEDURE, so a later session cannot read
`postgres:15-alpine` as neglect and bump it back.

**What happened, in one line:** the auto-merge shipped `15-alpine -> 18-alpine`, the deploy recreated
the container, PostgreSQL 18 exited on startup against the existing `postgres_data`, and all eight
backend services lost `auth_db` - the only database - for 33 minutes. The full account is in
`CHANGELOG.md`; the rule it left is in
[durable-rules](durable-rules.md#release-and-ci---cicd). The image is refused by name in
`.github/scripts/lib/ceiling.sh` now, so Dependabot's next attempt is declined with its reason
rather than merged.

**Why it is not a one-line bump.** PostgreSQL 18 refuses the data directory for TWO independent
reasons, and a procedure has to answer both:

1. **The catalogue.** A 15 cluster is not readable by 18 - `pg_upgrade` needs BOTH binaries present
   at once, which no single official image carries. Either a `tianon/postgres-upgrade`-style
   throwaway container, or a `pg_dumpall` / restore, which is the simple option and the one with
   downtime proportional to the database.
2. **The mount moved.** The 18+ images expect a single mount at `/var/lib/postgresql` and place the
   cluster in a major-version subdirectory beneath it; this repository mounts `postgres_data` at
   `/var/lib/postgresql/data`. So `docker-compose.prod.yml`, `docker-compose.dev.yml` and
   `infrastructure/local/docker-compose.yml` all change shape, not just a tag - and the `pg_isready`
   / `psql` invocations in `deploy.yml`'s migration step run inside that container.

**What retires this entry, and it is the same thing that lifts the refusal:** a test that starts the
NEW major against a data directory written by the OLD one and proves the upgrade path carries it.
That is the gate `lib/ceiling.sh` names, and writing it makes a whole class of datastore update
merge by itself - the same shape as `boot-nest-apps` releasing 22 refusals on 2026-08-31. It also
covers `redis` and `garage`, which sit behind the same arm for the same reason and have never been
upgraded across a major either.

**MEASURED 2026-09-01: `auth_db` is 84 MB.** That settles the choice - a dump and restore of 84 MB
is seconds, not an evening, so `pg_upgrade` and its requirement that both binaries live in one image
buy nothing here and should not be built. The remaining halves of this item are unchanged: 18 also
moved the expected mount from `/var/lib/postgresql/data` to `/var/lib/postgresql` with a
major-version subdirectory, so the compose changes with the image, and the ceiling arm in
`.github/scripts/lib/ceiling.sh` is what holds the bump back until both are done. Re-measure the size
before the window rather than quoting this line - it is a number that only grows.

### ~~P1 - no identity CI can mint may ask Dependabot to rebuild a branch~~ - RETIRED 2026-09-04, the mechanism that needed it is deleted

**Not fixed: withdrawn, because the thing it blocked no longer exists.** The row said that a moved
gate parks the whole Dependabot queue, since the only exit is a rebuild and `@dependabot rebase`
authorises by PUSH ACCESS - which no identity a workflow can mint has. That measurement stands, and
it is worth keeping: ten refusals out of ten asks, on eight pull requests, with `github-actions[bot]`
and with the `canari-auto-merge` App, three seconds after each ask. **An App installation is not an
account.** `Contents: write` is not push access, and this repository recommended the App token in
three places before measuring it.

What is gone is the mechanism that needed the rebuild. `dependabot-auto-merge.yml` refused to arm a
pull request whose check suite described gates `main` no longer carried, and the only way to lift
that refusal was a rebuild nobody could perform. The sweep was deleted on 2026-09-04 together with
the staleness predicate, so nothing refuses on staleness any more and there is nothing to unblock.

**The underlying question is answered elsewhere, and better.** "Can a pull request that was green
against an older set of gates still merge, and would we know" - yes it can, and yes we would:
`ci.yml` runs on `push: main` as well as on `pull_request`, so the merged trunk is tested,
and a red `CI passed` ON `main` makes `release-preflight.sh` gate 3 refuse every release cut from
that commit. The protection sits at the release rather than at the merge, which is the only place it
changes what a user sees.

The durable rule this produced is on
[durable-rules](durable-rules.md) and stays there.

### P3 - one merge out of three did NOT delete its remote branch, and nothing here refused it (observed 2026-09-03)

**One occurrence, recorded because it is a measurement and not a theory.** The repository has
`delete_branch_on_merge: true` (inventoried in
[MIGRATION.md](../../infrastructure/MIGRATION.md) section 3bis), and on 2026-09-03 three pull
requests merged within twenty minutes of one another, all squash-merged by the same App through
GitHub's auto-merge:

| Pull request | Branch after the merge |
| --- | --- |
| #339 | deleted (404) |
| #340 | deleted (404) |
| #341 | **still present**, twelve minutes later |

`DELETE /git/refs/heads/...` then removed it with **no error and no refusal**, so nothing in this
repository was protecting it - no ruleset, no protection rule, no open pull request pointing at it.
Whatever happened, happened on GitHub's side, and the cause is UNMEASURED.

**Why it is worth a row rather than a shrug:** the remote branch is what tells a workstation its
local branch is finished. `[origin/x: gone]` after a fetch is the signal a session uses to delete
its local copies, and a branch that is never marked gone accumulates silently in every clone - the
exact confusion that had to be explained on 2026-09-03
([workflow-developpement](../user-guide/workflow-developpement.md) section 3.1).

**What retires this row:** either it never recurs - in which case delete the row after a month of
merges - or it recurs and the pattern says what it depends on. Do not write a workaround for one
observation: a sweep that deletes leftover branches would be a destructive control built on an
unmeasured cause, and it would need an allowlist of what it may touch.

### ~~P2 - the vulnerability audit cannot block a merge~~ - CLOSED 2026-09-04

**The three security jobs now feed `CI passed`.** `code-analysis.yml` lost its own `pull_request`
and `schedule` triggers and became a `workflow_call` library; `ci.yml` calls it as the
`security` job and lists it in `ci-passed`'s `needs`, which is the one check the branch ruleset
requires. So CodeQL, the TruffleHog secret scan and the vulnerability audit can now stop a merge,
which is what the row asked for.

**What it was.** They ran on every pull request and could not block one, because the ruleset names
exactly one check and this was not it. A live secret in a PUBLIC repository, or a HIGH advisory,
produced a red tick beside a mergeable pull request - *a red tick nothing enforces is worse than no
tick, because it looks enforced.* It spent a day failing on every pull request while they merged
anyway.

**And the nightly pass survived the change**, which was the other half: `scheduled.yml` calls the
same file on `0 2 * * *`. A new advisory lands against code nobody touched, and no pull-request
gate can ever see that.

### P3 - TWO audit advisories are suppressed because they cannot be reached, and both should stop being

`GHSA-vcc3-ghjq-m6fr` (moderate, denial of service) covers every `decode-uri-component` at or below
0.4.2 and reaches media-service as `minio > query-string > decode-uri-component`. **It is ignored
for that one service only**, because nothing in the chain can move - minio 8.0.7 is the latest
release and pins `query-string: ^7.1.3`, which pins `decode-uri-component: ^0.2.2` - and because the
fixed 0.5.0 is ESM-only where `query-string@7` is CommonJS, so an override would fail at boot
instead of at audit. The reachability argument and the assertion that keeps it honest are in
`.github/workflows/code-analysis.yml`, which is the only copy.

**What retires this row:** minio publishing a release that drops `query-string@7` - or
`query-string` itself depending on a `decode-uri-component` above 0.4.2. Either makes the ignore
unnecessary, and it should be deleted the same day, along with the premise assertion beside it.
Until then the assertion is what stops the suppression outliving its reason: CI fails if minio ever
parses a query string, or if the `stringify` call site the measurement was taken on disappears.

---

### P2 - MOSTLY CLOSED 2026-09-03: the hosts take their security updates and a daily run reports it. What is left is three hosts nobody reports on, and a library nothing restarts

**The mechanism and the report both exist since 2026-09-03**, installed on the user's decision
(*"unattended-upgrades securite + rapport"*) across all four hosts: security origins only, nothing
reboots, and `.github/workflows/scheduled.yml` fails a daily run on any finding. The whole
write-up - the policy, the `#clear` that the file needs to not be decorative, the 30-second `502`
this scope does NOT incur and the evidence for that, and the two defects the report itself had - is
[host-updates](infrastructure/host-updates.md), the only copy.

**THREE THINGS STAY OPEN and they are smaller than what closed.**

1. **The report covers PRODUCTION and no other host.** It has to be taken on the box, the runner
   lives on the production origin, and the runner's key is authorised on none of the other three
   (measured 2026-09-03). So `mitv`, `cercle` and `miconnect` now apply their security updates with
   nothing saying whether they still are - which is exactly the shape this row was opened about, one
   estate smaller. **Retired by** either a key for the runner on the other three (a privilege
   expansion, so the user's decision), or the Cloudflare Access service token already listed as
   optional in the dev-environment work, which would let an `ubuntu-latest` job reach all four the
   way a workstation does.
2. **`mitv` has needed a REBOOT since 12 July**, for `linux-image-6.12.95+deb12-amd64`, with 8 weeks
   of uptime. The report names it now; only a human reboots it. A kernel security update that is
   installed and not running is a security update you do not have.
3. **A library security fix is installed, not in effect.** `unattended-upgrades` restarts no
   services, so an `openssl`/`libssl3t64` upgrade leaves every long-running process mapped to the
   old library until something restarts it. Nothing measures that. **Retired by** reading
   `needrestart -b` (or `/usr/lib/needrestart/`) into the same report - which turns a silent gap
   into a named finding without deciding to restart anything.

The original row, kept because it carries the measurement and the trade-off that were priced before
the decision:

### P2 - nothing upgrades the production box's OS packages, and nothing reports that they are stale (measured 2026-09-02, ANSWERED 2026-09-03)

The chain that keeps *dependencies* current stops at the repository. **The host carrying every
service has no equivalent, and it had drifted 113 packages behind - 50 of them from
`stable-security`** - on Debian 13, before an upgrade was run by hand on 2026-09-02. Measured on the
box, not inferred:

| Question | Answer |
|---|---|
| `unattended-upgrades` installed | **no** |
| `/etc/apt/apt.conf.d/20auto-upgrades` | **absent** |
| `/etc/apt/apt.conf.d/50unattended-upgrades` | **absent** |
| `apt-daily-upgrade.timer` | `enabled` - and with nothing installed to do the upgrading, it does nothing |

That last row is the trap: **an enabled timer looks like a mechanism.** Anyone auditing this box by
listing timers would have concluded packages were being kept current. The one timer that *was*
specific to keeping software current, `cloudflared-update.timer`, is `disabled`, `inactive` and has
**never run** - and enabling it would be wrong for a separate reason, given on
[cloudflare-edge](infrastructure/cloudflare-edge.md#nothing-keeps-the-daemon-current-and-a-dormant-timer-says-otherwise).

**The upgrade of 2026-09-02 does not retire this row.** It moved the count to 0 once; it installed no
mechanism, so the count starts climbing again the same day, and nothing will say so. This is the
repository's own rule about a correct mechanism with no report, applied to the host instead of the
code: found by hand, months late.

**What retired it, 2026-09-03:** `unattended-upgrades` with the security origin enabled, plus a
REPORT that names the count - because unattended upgrades that silently stop are the same defect one
layer down. **The decision was the user's and the cost they were asked to accept did not
materialise.** The concern was that an apt upgrade on this box restarts the Docker daemon (12
`docker`/`containerd` packages were in the manual set), which restarts all 23 containers at once and
gave a ~30-second window of `502` on the public site - so an unattended upgrade would bring that
window unannounced, at night, on both estates at once. **Security-only scope excludes Docker
entirely**, and that was verified rather than argued: the Docker CE origin is pinned `-32768`,
*"Marking not allowed"*, in `unattended-upgrade --dry-run --debug` on a host with Docker updates
actually pending. Docker moves when a human decides. The evidence is on
[host-updates](infrastructure/host-updates.md).

Two facts to carry into that decision, both measured during the manual run:

- **`apt-get upgrade` and `full-upgrade` agreed** - 113 upgraded, 0 removed, 0 newly installed, 0 held
  back - and no `linux-image` was in the set, the kernel coming from the Proxmox host. So no reboot
  was required. A future set containing a kernel would be a different decision.
- **There is no snapshot to fall back on.** No Proxmox credential exists on the workstation, so the
  only pre-flight is the dry run and the only recovery route is the LAN hop from another tunnel host.

---

### P3 - the release's commit is resolved three times by three chains, and two of them record nothing (measured 2026-09-03)

`deploy.yml` was fixed on 2026-09-03: `release-kind` resolves `main` once and every job below it checks
out `${{ needs.release-kind.outputs.sha }}`, so the commit that gets built is the commit the image
tag and the `prod-released` / `dev-deployed` markers name. **`android.yml` and
`ios.yml` still check out `ref: main` themselves**, and `main` moves for the same reason it
moved for `deploy.yml`: the bump's push raises a `push` event, `ci.yml` runs on `main` while the release
chains start, and a pull request merged in those minutes lands between them.

**WHY THIS IS P3 AND NOT THE P-LEVEL `deploy.yml` HAD.** Neither store workflow records a SHA anywhere,
so neither can contradict itself the way `deploy.yml` could - there is no false marker, only an
unmeasured one. What is left is a cross-chain question: a merge landing between the three runs would
ship a store bundle built from a different tree than production, and **nothing would ever say so**,
because each chain is internally consistent and no artefact carries the commit. `frontendDist:
"../build"` means the app EMBEDS the frontend, so the divergence is real code and not a
configuration difference.

**THE WINDOW IS SMALL AND SHOULD BE MEASURED BEFORE IT IS CLOSED.** All three chains start from the
same `workflow_run` completion, so they resolve `main` within seconds of each other; the ruleset
means the intervening change must be a squash-merge of a green pull request, which takes minutes of
human gesture. Measuring it is one query: for the last N releases, compare `main`'s SHA at each
chain's checkout step. If it has never differed, the fix is worth having anyway but is not urgent.

**CLOSING IT MEANS DECIDING WHERE THE RELEASE'S SHA IS RESOLVED ONCE FOR ALL THREE CHAINS**, and
that is a design choice rather than a patch:

- **The tag.** `refs/tags/vX.Y.Z` is immutable, but it points at the commit BEFORE the bump - the
  whole reason `CHECKOUT_REF` is `main`. It only works if the bump moves the tag, which makes a
  published release's tag mutable and is worse than the problem.
- **A `release-sha` marker the bump writes**, in its own commit or as an output every chain reads
  through `gh api`. One writer, three readers, immutable once written - but it adds a lookup to two
  workflows that currently need none.
- **Fold the store builds into `deploy.yml`** as jobs depending on `release-kind`, which is the only
  option that removes the class rather than covering it. It also serialises them behind the deploy's
  concurrency group, which may or may not be wanted.

Until then, `cicd.md` states the gap in the section next to the `deploy.yml` fix, so nobody reads that
fix as covering all three chains.

## Security - blocked upstream

### P3 - the two libcrux crates that ARE compiled are pinned by `openmls_rust_crypto 0.5.1`

`libcrux-sha3` and `libcrux-secrets` reach this build through `hpke-rs`, and their advisories are
the ones that survive. Both are pinned by `openmls_rust_crypto 0.5.1`, and a `0.0.x` requirement is
exact in Cargo semver - only a stable `openmls_rust_crypto 0.6.0` moves them. Each case is an entry
in the crate's `.cargo/audit.toml` naming why it cannot be honoured and what lifts it, so
`cargo audit` is green with none of them forgotten. A scheduled dependency upgrade, not a live
defect.

The rule the `libcrux-chacha20poly1305` measurement left - **a lockfile entry is not a
dependency**, because `cargo audit` reads the lockfile while `cargo tree -i` reads what is actually
compiled - is in [durable-rules](durable-rules.md). That alert is dismissed (user, 2026-08-31) and
no Dependabot alert is open.

### The rest of what an iPhone will find, named by the user before it was looked for (2026-08-27)

**Not a defect and not scheduled - a standing expectation, recorded so it is not re-discovered as a
surprise.** Said while the first iPhone was still in front of a log, verbatim: *"Il y aura d'autres
problemes graphiques et peut-etre memoire aussi, sur le fait de mal gerer la mise en arriere plan par
exemple, la reconnexion qui ne se fait pas etc."*

**Why it deserves a line rather than a WP.** Every iOS defect found so far - the CORS allowlist, the
third-party refresh cookie, the FCM ordering - was invisible to every gate in this repository and
became visible the moment a device ran the app. Three of three. The classes the user names are the
ones the platform's own lifecycle owns and the ones a compile can least speak to: suspension and
resume, the WebView being evicted under memory pressure, and a socket that does not come back. Two
mechanisms already exist and neither has been observed on iOS - the reconnection ladder
([auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it))
and `didBecomeActive`, which the FCM fix has just made load-bearing.

**How it gets closed: by hardware, one check at a time.** Each class becomes a lettered check in
[device-verification](device-verification.md) when someone has an iPhone in hand, not a speculative
entry here. **What must NOT happen is a fix written against a suspected iOS lifecycle bug that nobody
has seen** - the repo has no way to tell whether it worked.

### P1 - the PIN modal can be DISMISSED, so a user who forgot their PIN walks the app closing it on every page, and there is no way to sign out (user, 2026-09-05)

**Observed on real people, not inferred.** Verbatim: *"Certaines personnes oublient leur PIN et
plutot que de le reinitialiser, elles naviguent de page en page en fermant le modal de PIN (qui
s'ouvre a chaque fois). Il faut trouver une solution, que ce ne soit pas possible de dismiss ce
modal. Mais il faut aussi mettre un bouton pour se deconnecter pour ne pas etre softlock en cas de
probleme."*

**WHAT THE CODE DOES TODAY, so picking this up does not start with a rediscovery.**

- `Modal.svelte` ALREADY carries the prop this needs: `dismissible?: boolean`, and when false it
  disables the backdrop click, Escape AND the header close button, in one place. `PinModal.svelte`
  simply does not pass it, so it defaults to `true`.
- The call site's `onClose` (`ChatBackgroundService.svelte`) hides the modal and clears
  `_loginInProgress` / `globalSession.isLoginInProgress` - so dismissing does not merely hide a
  dialog, it ends the login attempt, and the next page re-opens it from scratch.
- `PinModal` carries a SECOND way out that `dismissible={false}` would not touch: an
  `<a href="/profile">` labelled with `auth_pin_delete_account_link` that calls `onClose` on its way.
  Whatever is decided about the backdrop has to be decided about that link too, or the fix closes one
  door and leaves the other open.
- A reset EXISTS - `onForgotPinReset` -> `handlePinReset`, behind a `confirmReset` confirmation -
  and it is destructive: it wipes the PIN-protected messaging state. It is the path the user says
  people are avoiding, and avoiding it is rational.
- **There is no sign-out control anywhere in the modal.**

**THE TWO HALVES ARE ONE CHANGE, AND THE SECOND IS WHAT MAKES THE FIRST SAFE.** Making the modal
undismissable without an exit turns a loop into a wall: the user who cannot remember their PIN would
be left with a destructive reset or the account-deletion link, on a modal that no longer closes. So
the sign-out button lands FIRST, or both land in the same commit - never the lock alone.
**A destructive control needs an allowlist of what it may touch**, and "sign out" is the
non-destructive exit this screen has never had.

**WHAT THIS IS NOT.** Dismissing the modal exposes nothing: the PIN gates the local MLS store, so a
user who closes it walks an application with nothing decrypted in it. This is P1 for the PATH being
broken - people are stuck in it now - not for a disclosure.

**AND THE ROW REPRODUCED IT BEFORE ANYTHING WAS TOUCHED.** PIN-11 (`pinrows.mjs --row 11`) empties
the device key vault by an allowlist of its five named keys, reloads to raise the gate, and measures
each gesture against a FRESHLY raised one - the first draft used a single gate for all three, so the
moment Escape closed it the other two measured an absence and reported it as their own finding.
Measured 2026-09-05 on the local estate, verdict `FAIL`:

| gesture | gate survived |
| --- | --- |
| `Escape` | **no** |
| backdrop click (`backdrop: "clicked"`, so the event landed) | **no** |
| a control that ends the session and KEEPS the state | `signOut: 0` |
| navigation after a dismissal (the MITIGATION, not the defect) | the gate DID come back - `reopenedAfterNavigation: true` |

`exits: {signOut: 0, reset: 0, leaves: 0}` says the modal carried no exit AT ALL in its default
state: the reset and the account link both sit behind a disclosure the row never opened. So the
"forgot my PIN" path was not merely destructive, it was not even on screen until the user went
looking.

**TWO INSTRUMENT ERRORS ARE WORTH KEEPING, because both produced a confident wrong reading.** The
navigation gesture first reported `survivedNavigation: false` - it navigated with `history.pushState`
plus a synthetic `popstate`, which overwrites the history state SvelteKit keeps its router index in,
so the router was handed a navigation it did not author. A fix written against that reading would
have been aimed at a product doing nothing wrong. And `EXITS` matched ASCII needles against a French
interface, so `deconnect` never touched "Se deconnecter" and `oublie` never touched "PIN oublie ?" -
a zero meaning "nothing found", indistinguishable from the zero meaning "nothing there" that the
whole verdict turns on. It is stripped of diacritics before matching now.

**FIXED 2026-09-05, both halves in one commit** (story in `CHANGELOG.md`, rule in
[durable-rules](durable-rules.md)): `dismissible={false}` on the gate, `dismissible` extended in
`Modal.svelte` to govern the BACK GESTURE as well - it does not come through the backdrop, Escape or
the cross, it comes through the history entry every open modal pushed - and a sign-out on screen from
the first frame, running the app's ordinary `clearAuth()` + `/login` so `mls.bin` and the message
database are untouched. Pinned by `PinModal.gate.svelte.test.ts` and
`Modal.dismissal.svelte.test.ts`, both of which fail against the old component.

**PIN-11 re-read the fixed build and recorded `PASS`, clean**: `survivedEscape: true`,
`survivedBackdrop: true` with `backdrop: "clicked"` so the event still landed, and
`exits: {signOut: 1, reset: 1, leaves: 0}`.

**GETTING TO A CLEAN `PASS` COST ONE MORE FIX, AND IT WAS THE ESTATE'S.** The first re-run was
`PASS-DIRTY` on `GET /api/media/4a805a13-... -> 404` twice plus `[PostMedia] media download failed` -
a post COMMENT carrying an attachment whose object the local copy never received.
`infrastructure/lib/copy-strips.sh` exists to make that impossible and its own residue query
reported **0** over three such rows: it enumerates media-bearing COLUMNS, and a comment's attachment
lives inside a jsonb array of objects, one level below anything the list could see. Both the strip
and the count now cover `posts.comments`, and the file carries the loop that FOUND it - a scan of
every text and jsonb column for `mediaId` and `/api/media/`, which answered nothing else on this
schema. **A list of columns is a claim about a schema, and it goes stale in silence.** The remaining
line, Chrome's `[DOM] Password forms should have ... username fields`, is the browser's and not the
app's: the documented remedy would invite a password manager to store an end-to-end encryption
secret, so the row NAMES it through `ignoringExpectedLog` and nothing wider.

**Still owed: the fix is merged, not shipped.** This entry goes when a release carries it.

### P3 - a media object that is gone reads as a hard error unless one JSON file survived, and that file is known to be losable (found 2026-09-05)

`MediaService.download` answers `purged` - which the controller turns into a 410 and the client into
a calm *"media expired"* label - only when `media_metadata.json` still holds an entry with
`purgedAt` and `purgeReason === 'retention_expired'`. If the object is gone and that entry is not,
the answer is a 404, and `PostMedia` renders the red failure and writes `console.error`. The two are
the same event to the user.

**The metadata file is known to be losable, in this very service**: `downloadPublic` carries an
explicit *"metadata lost after a container restart"* fallback that backfills an entry from storage.
`download` has no equivalent, so the private path depends on a file the public path is written not
to trust.

**What is NOT known** is how often a 404 on this endpoint means "purged" rather than "never existed
here" - that is a measurement on production's media service, not a reading. **A predicate that named
the last incident is not the predicate that names the next one**, and this one has not been measured
on the population it would run on. Cheap and worth doing before deciding anything: count 404s and
410s on `/api/media/:id` over a week.

### P2 - the PIN modal's error is a bare paragraph, so a refused unlock is never announced to a screen reader (measured 2026-09-04)

`PinModal.svelte` renders its failure as `<p class="...text-red-500">{displayError}</p>` in BOTH
shapes - line 156 (the keypad) and line 229 (the manual input). No `role="alert"`, no `aria-live`.
The element is inserted after the submit, and an insertion that carries neither is one assistive
technology has no reason to read out: a user who cannot see the screen submits a PIN, hears nothing,
and has no way to learn that the attempt was refused or why.

**Found because an instrument hit the same wall.** `pin.mjs` waited for the gate to close or for the
body to contain "incorrect", and the product refused with something else entirely - *"Votre PIN a ete
change sur un autre appareil"* - so the atom spent 25 s and threw `until() timed out` about a message
plainly on screen. The atom was fixed the same day to key on the error ELEMENT rather than on any
wording, which is why the missing role was noticed at all: **the only handle the modal offers is a
Tailwind colour class**, and a test keying on `text-red-500` is a test that breaks on a restyle.

**The fix is one attribute per site** (`role="alert"`, which implies `aria-live="assertive"`), and it
makes the accessible name the handle - so the harness can stop keying on a colour. Both shapes, and
worth a sweep for the same pattern elsewhere: `ChangePinModal.svelte` and `LoginForm.svelte` carry
`text-red-500` too and were not checked.

**Not fixed inline, deliberately** (user, 2026-09-04): P2s go here rather than into the session that
found them.

### P2 - the local estate's DATABASE references media its OBJECT STORE never received, so any row that renders the feed is PASS-DIRTY on 404s that are the estate's (measured 2026-09-04, first row run after the tidy)

**Measured on HEAL-NEW-0.** Every assertion of the row passed - `wipe`, `loggedOut`, `noHumanStep`,
`freshId`, `neverSeen`, `sameAccount`, `registered`, `addressable` - and the re-minted device
rejoined FOUR groups by external commit inside one second. The verdict was still `PASS-DIRTY`, and
**100% of the dirt was media**: five `[associationLogoCache] fetch failed 404`, one
`[PostMedia] media download failed`, and fourteen `GET /api/media/... -> 404` in `badHttp`.

**The cause is a restore that copies one half of a pair.** `pull-prod-dump.sh` fetches a Postgres
dump and nothing else; `restore-into-local.sh` writes those ROWS. Neither touches Garage, and
`restore-into-local.sh` says so in its own header - *"WHAT A COPY DOES NOT BUY"*. What that header
does NOT say is the consequence: the copied rows still name media ids, the objects behind them live
only in production's store, and the product then does exactly the right thing - it asks for what its
database says exists, and is answered 404 fourteen times.

**Scope, measured rather than assumed.** It is NOT every row. A client sitting on `/chat` is clean -
`logs.mjs --device W1 --for 8000` and the same on W3 both reported clean minutes after the run. The
404s fire ONCE, on the first render of the social feed after a login. So the affected class is
**rows that log in fresh or wipe a profile and land on `/posts`** - the HEAL-NEW, HEAL-REVOKE, LIFE
and SETUP families - plus anything touching a community feed. That is a large systematic class, and
it is why this is written down rather than dispositioned.

**Do NOT close it with `ignoringExpectedLog`.** Per-row disposition is the sanctioned mechanism for
expected noise, but it is per ROW on purpose, and this would be the same excuse copied into every
member of four rungs - which is a wider classifier wearing a per-row costume, and the thing the
methodology forbids. The noise is also not *necessary*: it is the visible end of an estate that
disagrees with itself, and the rule is to explain it or FIX it.

**The fix belongs in the restore, which already does this kind of work.** `restore-into-local.sh`
exists to strip *"the things a copy must never carry"*; stripping references to objects the copy did
not carry is the same step. Clearing the dangling media ids on the association and post rows leaves
the estate SELF-CONSISTENT - a post with no image is a state the product renders correctly and a
real user can be in - whereas copying production's media blobs would drag the PII half of the estate
that the DB copy at least keeps behind one deliberate decision. It is a change to infrastructure
tooling with its own blast radius, so it is a P2 here rather than something done inline during a
harness tidy.

### P2 - a device reconciles history for a group it has not joined yet, and learns by 403 what its own store already knew (measured on DEL-1, 2026-09-05)

**The line.** `[HISTORY_STATE] Send failed for b0b436ed...: SenderNotActiveError: This device holds
no leaf in group b0b436ed... (membership pending)`, on W2, seconds after W1 added it to a group and
before its Welcome had been processed.

**Nothing is lost, and that is why this is a P2 and not a P1.** `sendHistoryStateKey` returns
`false`, and its contract says what that means - *"the caller treats that as 'this group was not
reconciled', never as 'we agree'"* - so the sweep simply has not happened yet and happens later. The
server is also right to refuse: a device with no leaf encrypts frames no member can open, which is
the defect `SenderNotActiveError` was typed for after production turned six messages into thirty
unopenable rows on 2026-09-02.

**What is wrong is the ASKING.** The reconciliation sweep audits every group the device has a row
for, including one it has been given a roster seat in and has not yet joined - and the only thing
that tells it so is a round trip that ends in 403. That is
[durable-rules](durable-rules.md)' *"never learn by failing what a fact could have told you"*: whether
this device holds a leaf in a group is answerable from the local MLS store, at the point the sweep
picks its candidates, with no network at all. Carrying that discriminator into the sweep's predicate
removes a frame, a refusal, and a line that reads like a delivery defect to anybody who meets it.

**Where.** The candidate set is chosen by the `[HISTORY_RECONCILE]` sweep (`auditing N group(s) that
never have been`); the refusal is thrown in `mlsDeliveryApi.ts` and reported by
`sendHistoryStateKey` in `groupActions.ts`. The row that produced it keeps it ACCUSING on purpose -
`del1.mjs` forgives its own group creation and its own cut, and deliberately not this.

### P3 - `[BUFFER] welcome_request sent for unknown group` announces a send that has not happened and may not happen (found 2026-09-05, DEL-6)

`handleUnknownGroup` logs that line immediately after calling `startRecovery`, which is `void`-ed
on purpose - an await there stalls the whole inbound drain. So the sentence is written before
`requestReAdd` has looked at anything, and that seam has several early returns: a throttle inside
`RECOVERY_TIMEOUT_MS`, a group already held locally, a tombstone, a membership still `pending`.
In each the line claims a `welcome_request` that never went out.

**The case that mattered is FIXED and this is the residue.** A frame for a conversation at
`lifecycle: 'removed'` is now acknowledged and dropped before any of this runs, which is where the
real cost was - a queue row nothing would ever take out. What is left is wording.

**It is not changed inline because the sentence has three consumers**, and one of them is a
predicate of a rung that has not run yet in this campaign: `heal-w2.mjs` requires the line to have
fired, `classify-selftest.mjs` pins its bucket, and `chat-delivery.md` quotes it. Renaming it to
what it can honestly claim - a recovery STARTED - moves the instrument and the subject in the same
commit, before HEAL has produced a single verdict. It belongs in the same pass as the HEAL rung.
### P3 - the remove control in a group panel announces a raw 64-hex user id, so a screen reader reads the id where everyone else reads a name (measured 2026-09-05)

`Sidebar`'s member rows render display names correctly - GRP-9 measured zero of five rows showing a
raw id, both names resolving - and the panel's per-member remove control carries
`aria-label="Retirer <userId>"` with the full 64-hex id. So the one surface that exists to be read
aloud is the one that says the id.

It is also the ONLY per-member hook the panel offers, which is why the campaign addresses members
through it (`grp.mjs`'s header says so). Giving it a name would need a second hook for the rig, or
the rig switching to a `data-` attribute - the same one-attribute pattern `data-channel-row` and
`data-conversation-tile` already use, which is the cleaner end state.

Not fixed inline during rung 8 because the accessible name is load-bearing for the instrument and
swapping both halves at once is a change that wants its own measurement.

### P2 - an inviter that dies between sending a Welcome and registering the joiner leaves a member in the MLS tree with no server-side membership, and nothing repairs it (measured 2026-09-05)

`groupCreation.ts` delivers Welcomes and THEN calls `registerMember` for each user whose Welcome was
delivered. Between those two the joiner is cryptographically in the group and unknown to the
delivery service, so nothing routes to it.

A line in `setupMessageHandler.ts` claimed to cover this - the joiner registering ITSELF, described
as a "safety net ... if the inviter has not yet called registerMember" - and it could not: the
server's `assertCallerMayMutateMembership` refuses a caller who is not already a member, exempting
only the creator of an empty group. It has been deleted (see `CHANGELOG.md`), which removes a 403
on every join and changes nothing about the exposure.

**What would actually close it** is registering before delivering rather than after, so the server
knows the member before the Welcome can arrive - which is the order the delivery service's own
docblock already assumes ("Freshly-invited joiners are registered as members BEFORE their Welcome").
The reason it is not that way is visible in the code: only users whose Welcome was DELIVERED get
registered, so inverting the order also changes which users end up registered when a delivery fails.
That is a real design decision and wants measuring, not guessing.

### P3 - the @mention dropdown offers you yourself, and mentioning yourself can do nothing at all (measured 2026-09-05)

Typing `@` in a channel composer lists the signed-in user among the suggestions. Picking it inserts
a chip and puts your own id in `mentionedUserIds`, and then nothing happens - `notifyChannelRecipients`
skips `member.userId === input.senderId` before it looks at any notification level, so a self-mention
cannot produce a notification for anybody, including you. It is a control whose only possible effect
is on the message text.

**It was measured because it broke an instrument, not a user.** `mentionInComposer` clicked the top
suggestion; from W2 the top row for the owner's first word was W2 ITSELF, so MENTION-2 mentioned the
sender, the server correctly pushed to nobody, and the row recorded `FAIL` against a notification
level that worked. That half is fixed on the rig's side (the row is addressed by id or by whole
display name, and an ambiguous list is a refusal). What is left is the product question.

`UserAutocomplete` already takes `excludeIds`, and the composer already knows who is signed in, so
excluding self is one argument. **Whether it SHOULD be excluded is a judgement, not a bug** - some
chat apps allow a self-mention as a way to bookmark a message - which is why this is a P3 and not a
fix applied inline: it is the user's call.

### P3 - NOTHING LINTS THE HARNESS, and the 158 scripts that drive every campaign verdict carry 29 warnings nobody has ever been shown (measured 2026-09-04)

`bun run lint` is scoped to `frontend/`; `make test-harness` runs the self-tests and
`inventory.mjs --check`, and neither lints. So the rig that produces every campaign verdict - 158
scripts, the instruments the board is believed on - is the one directory in this repository no
linter has an opinion about.

**Measured**: `bunx oxlint -c frontend/.oxlintrc.json tools/cross-client-harness` reports **29
warnings** - 26 `no-unused-vars` (dead imports in archived rows: `fwd.mjs`, `fwd5.mjs`, `ws1.mjs`
and others), plus `no-useless-spread`, `no-useless-fallback-in-spread` and
`prefer-string-starts-ends-with`. None is a defect today. **That is the point** - the value is not
the 29, it is that a 158-script tree has no gate, so the 30th will be a real one and will arrive
silently.

**The fix is the GATE, not the 29.** Add the harness to a lint recipe and make `make test-harness`
run it, so the count can only go down. Hand-clearing the warnings first buys one clean session and
guarantees the next drift is invisible again - the same trade `inventory.mjs` was written to end for
the index.

**Not fixed inline, deliberately.** It surfaced during work item A3 (the atom/row reclassification),
and clearing 29 warnings across archived rows that cannot be re-run right now is a different change
with a different risk: a dead import removed from a row is safe, a `no-useless-spread` rewrite
inside one is not, and the two must not ride together. P3 per the standing rule.

### P3 - the gateway logs a client that merely went away at ERROR, and a clean goodbye at INFO, so the level says nothing about whether anything is wrong (measured 2026-09-04)

`handlers.rs:529` ends the receive loop with two arms and one of them is unconditional:
`Ok(Message::Close(c))` logs `info!("Client closed connection")`, and `Err(e)` logs
`error!("WebSocket Error from {user_id}: {e}")` whatever `e` is. **A browser that reloads,
navigates away or is killed sends no close frame** - the socket resets - so the ordinary end of a
web session is recorded at the same level as a genuine protocol fault.

**Measured, and the cause is visible in the timestamps.** Three ERROR lines at `16:19:49.602`,
`.603490` and `.603505` - three sockets dying inside a millisecond of each other, which is
`make local-frontend` recreating the nginx container in front of them, not three clients
misbehaving. The one `Client closed connection` line in the same window carries `code: 1001`
("going away"), the polite version of the same event.

**The fix is a classification, not a demotion**, which is the distinction
[durable-rules](durable-rules.md) draws when it says never to demote a line: `axum` 0.8 surfaces the
tungstenite error, so `ProtocolError::ResetWithoutClosingHandshake` is a TYPE and reading it is
reading a discriminator rather than prose. A reset with no handshake from a web client is the
expected end of a connection and belongs at `info!`/`debug!` beside the clean close; everything else
stays `error!` and finally means something when it appears.

**The rate here is NOT the rate that matters and must be measured before the name is believed.**
This estate is idle apart from one operator, so three lines is all it produced; on production the
line fires once per client that ever closes a tab without a handshake, and nobody has counted that.
Measure it on the production gateway first - if it is the dominant ERROR line there, that alone is
the argument.

### P3 - the dirt classifier fails a row on the OIDC callback that row performs on purpose (2026-08-28)

**Measured.** `healnew.mjs --row 0` recorded `FAIL` on `03d015fd` with **no unmet condition and no
unobservable** - dirt only. Its seven `unexplained` lines: six ordinary `debug: [auth] core-service
response status: 200` / `got access_token` / `handleOidcCallback complete` / `[callback] goto -> /`
lines, and Chrome's accessibility hint that a password form wants a username field. The primitive
succeeded; the classifier is what failed the row, and it did so on the one row whose whole job is to
re-enrol a device through the IdP.

**The disposition is NOT to widen the classifier globally.** Those six lines are expected on a row
that logs in and are the visible end of something upstream anywhere else - which is the noise rule
exactly. The mechanism that already fits is `ignoringExpectedLog`, per row, naming them.

**The accessibility hint is a separate, real, small finding**: the PIN field is a bare
`type=password` with no username field in its form. It belongs with the P2 above, in the same pass.

**IT RECURRED ON HEAL-NEW-15, `038c7e8d`, and that run is why the disposition above is now owed
rather than merely correct.** It is the rung's FIRST verdict to have passed `gate()` at all, and the
gate demoted it to `PASS-DIRTY` on three shapes, none of them the row's subject and all three the
MINT's own signature: `POST /api/auth/refresh?clientVersion=0.14.12 -> 401` from a client that had
just deleted every cookie it owned, which is the wipe working; the OIDC callback's `debug:` trail
(`code length: 32`, `savedState present`, `redirectUri`, `got access_token`); and the purge's
`[DevicePanel] Found/Deleting/Deleted`. **Every HEAL-NEW row will produce all three, every time**, so
the per-row `ignoringExpectedLog` list is what stands between this rung and a wall of `PASS-DIRTY`
verdicts that say nothing about the product. Name them per row, never widen the classifier.

**SHIPPED FOR THE HEAL-NEW ROWS ON 2026-08-29, and only for them.** `healnew.mjs` carries
`withoutTheMintsOwnNoise` - `ignoringExpectedRefusal` for the `POST /api/auth/refresh -> 401` and
then `ignoringExpectedLog` for the OIDC trail and the purge's three lines, in that order, because
`ignoringExpectedLog` recomputes `clean` over `badHttp` as it finds it. Every needle names a SUCCESS
spelling - the status pinned to `200`, the state check to `matches: true`, and none of
`[DevicePanel]`'s five `console.error`/`console.warn` spellings named at all - so a `500` from
core-service, a mismatched OIDC state or a failed device deletion stays dirt.

**CLOSED FOR THE HEAL-REVOKE ROWS TOO, and the claim that it was open was WRONG** (checked in the
source 2026-08-30, after this file and `CLAUDE.md` had both carried "`healrevoke.mjs` ... has no such
list" for two days). That runner ships FOUR lists, one per OBSERVER rather than one per row, which is
the finer cut: `asAReturningDevice` forgives the OIDC trail and a cold client but not the panel it
never drove; `asAFreshlyMintedDevice` adds the purge; `asTheWipedVictim` is the only one handed
`AUTH_TEARDOWN_NARRATION`, because a session clearing itself is its subject and everyone else's
finding; and `asTheActor` forgives NO refusal at all, so a `401` on `/api/auth/refresh` - the wipe
working, on the victim - stays a finding on the one client that wiped nothing. The wipe's own three
sentences are deliberately in no list: `NOTABLE` already claims them, so a list would forgive nothing
and report three dry needles on every row of the rung.

**Two lines from that run are explained and must NOT be re-opened.** `History msg error: Group not
found: 642f389a...` is the amber probe's own doing - the row clicks a SYNCING tile on purpose, and a
conversation with no MLS state is exactly a group the history reader cannot find. `[WS] Disconnected.
Code: 1006` is a browser the row killed by construction.



### P2 - iOS carries none of the window-layout work Android already has (user, 2026-08-28)

**Named by the user from real use on an iPhone**, and one of the three is already fixed. The Android
half of each of these took a measurement and a comment to get right (`MainActivity`,
[mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)); iOS inherited
none of it because `gen/apple` is a different generated project nothing compared against `gen/android`.

- **DONE 2026-08-28 - the keyboard.** WKWebView was never resized, so the shell was pinned to the
  visible height inside a full-height document and a keyboard-tall empty band opened below it.
  `CanariApplyKeyboardLayout` shrinks the WebView's frame; no web change was needed. Written up on
  [mobile](frontend/mobile.md#ios-shrinks-the-webview-and-that-is-the-same-decision-taken-twice).
- **OPEN - the bars at the top and the bottom.** The user reports black bands, or none at all, where
  the status bar and the home indicator are, with the interface colliding with system text and
  controls. Android's answer is an explicit inset contract; iOS has `env(safe-area-inset-*)` scattered
  across `app.css` and a dozen components and no single owner. **This wants ONE pass over `app.css`
  with a device in hand**, not local patches - the same conclusion the emoji / dead-row / device-row
  items reached, and the same pass.
- **ANSWERED 2026-08-28 - the question "what else has no iOS peer" now has a written answer.** The
  audit is [android-ios-parity](frontend/android-ios-parity.md), the only copy: six graphical
  findings, six software ones, eight concerns confirmed already at parity so nobody re-derives them,
  and one asymmetry closed by construction that must NOT be given a peer. The orientation lock and the
  bottom nav's reservation are both fine. **The three structural candidates for the bars the user
  reports are 1.1 (iOS hides the status bar where Android keeps it edge-to-edge), 1.3 (the launch
  background is Apple's, not the product's) and 1.4 (the WKWebView background is never set, so the
  mechanism that kills Android's startup flash has no iOS peer).** Ranking them is a DEVICE
  measurement; the audit deliberately refuses to rank them from source.

**This closes by HARDWARE, one item at a time**, like every other iOS finding: three of three defects
so far were invisible to every gate here.

### P3 - nothing records which BUILD each device runs, though two mechanisms already carry it (2026-08-27)

Asked by the user while debugging the iOS session: is there one place naming the version of every
device? There is not, and the two pages that look like it are not it - `/admin/platform` WRITES
`minClientVersion` (a policy, not an observation) and `/admin/status` reads live presence out of the
gateway (no version at all). The question mattered immediately: every `Refresh refused` line from an
iPhone was ambiguous until the user stated by hand that all of them were on 0.14.5.

**Two mechanisms already receive the value.** `GET /users/me/announcement?clientVersion=` takes it from
every client on every launch and uses it only to decide an announcement's audience, then discards it;
and since 2026-08-27 `POST /auth/refresh?clientVersion=` carries it for the refusal log. Meanwhile
`push_token` already holds exactly one row per `(userId, deviceId)` with a `platform` and an
`updatedAt`. Recording the version against a device is therefore a column and a write, not a feature -
and it would have answered both this question and the iOS FCM one above without asking anybody.

Not done tonight because the cheap version is genuinely cheap and the useful version is a decision:
which table owns it, whether a web session counts as a device, and what a dashboard should show
(distribution by version, or the laggards below `minClientVersion`).

**AND A THIRD MECHANISM ALREADY HAS THE COLUMN, WRITES IT ON ONE PLATFORM AND LEAVES IT NULL ON THE
REST - measured on prod 2026-08-28.** `key_package.deviceAppVersion` exists, `register-device`
sanitises it, and both client services accept it. Over the last 21 days, by `deviceOs`:

| `deviceOs` | enrolments | carrying a version |
| --- | --- | --- |
| android | 58 | 36 |
| ios | 48 | **5** |
| windows | 40 | **0** |
| macos | 12 | **0** |
| linux | 6 | **0** |

Two separate causes, and the population is what separates them. **The web never sends it at all**:
`WebMlsService.publishKeyPackage` passes `deviceName` and `deviceOs` and stops there, while
`TauriMlsService.publishKeyPackage` awaits `getRuntimeAppVersion()` and includes it - so windows,
macos and linux read 0 out of 58 by construction, and that half is one line. **The iOS half is not
that**: it goes through the Tauri path, which does send the field, and still 43 of 48 enrolments
carry nothing - so `getRuntimeAppVersion()` is answering empty on that platform, which is a
different defect and the one worth measuring before writing anything. Android's 22 missing rows say
it is not purely iOS either.

**Why this is worth more than a column being tidy: `minClientVersion` is raised BY HAND and is
supposed to be reasoning about what devices actually run.** On the evidence above, the one table that
records a device's build is empty for every desktop browser and for 90% of iPhones - so raising the
floor is a decision taken against no data at all, which is exactly what
[legacy-compatibility](legacy-compatibility.md) warns about from the other side. Found while checking
the per-user device cap on a real account, not by a gate.

**A REAL ACCOUNT IS AT THE CAP, AND IT IS NOT A DEFECT - it is what the cap looks like from the
inside.** `39b96d7e` holds 15/15 `key_package` rows: **14 `ios` between 2026-07-21 and today**, plus
one `windows` taken today, and 13 `auth_sessions` all created between 2026-08-26 and 2026-08-28 with
12 distinct iPhone user agents. That is the iOS debugging campaign - every install minted a device
and nothing ever deleted one - and the next install on that account will be REFUSED. The mechanism is
complete and behaves: the server logs `[REGISTER_DEVICE] REFUSED device cap`, throws
`DEVICE_LIMIT_REACHED`, the client classifies it as `DeviceLimitReachedError` at the fetch and
`chat_device_limit_reached` tells the user in French to delete a device in Settings. Recorded because
the failure LOOKS like "iOS cannot enrol" and cost a HEAL rung a night once already, on the test
account, for exactly this reason. **A device is only reclaimed by the 90-day retention window or by a
person deleting it**, so an account debugged through fifteen installs stays capped for three months.

### P3 - the native refresh credential could live in the platform keychain, on BOTH platforms (2026-08-27)

**Not a defect - a strict improvement, deliberately not bundled with the fix that needed shipping.**
Today the credential sits in a file inside the app sandbox: the Chromium cookie file on Android, a
`@tauri-apps/plugin-store` file on `tauri://localhost` ([sessions](sessions.md#the-credential-a-client-carries-itself)).
Both are protected by the OS at the container level and neither is encrypted as a secret. The
platforms both offer better - iOS Keychain, Android Keystore / `EncryptedSharedPreferences` - and the
same argument applies to each, which is why this is one item and not two.

**What blocks it from being trivial:** `patches/tauri-plugin-keystore` already reaches the iOS keychain,
but its `ios/Sources/CustomTabsPlugin`-style path builds `SecAccessControlCreateWithFlags` with
BIOMETRIC flags, because it guards the MLS device key - reading it raises Face ID, which cannot sit in
front of every cold start. So this needs a second, non-biometric command in the vendored plugin
(`kSecAttrAccessibleAfterFirstUnlock`), Kotlin parity so the Android build still links, a permission
entry, and an iOS build to verify - none of it measurable from this machine.

**Do not start it as a security fix.** The current posture is the one Android has had all along and
which the user has accepted; this is an upgrade to both, worth doing when native work is being done
anyway rather than as an emergency.

### P3 - the last node runtime: four jest suites that will not run under bun (decided 2026-08-27, AFTER the campaign)

**Scheduled, not parked, and the decision behind it is the user's** (2026-08-27): npm leaves now,
node leaves later. npm is already gone - `node --run test` replaced the one `npm test` in
`ci.yml` and the one `bun run test` in the Makefile's `test-history`, so nothing in this repository
invokes a package manager other than bun. What survives is the node RUNTIME, in three places:
`actions/setup-node` twice in `ci.yml` (once for the backend suites, once for the harness
self-tests) and once in `code-analysis.yml`.

**The measured blocker, and it is one file.**
`apps/chat-delivery-service/src/controllers/admin-storage.controller.mls.spec.ts` passes 8/8 under
node and fails under the bun runtime. That single spec is why CI installs, lints and builds with bun
but TESTS with node, and both call sites say so in a comment. **Do not collapse the two runtimes
without re-running that spec** - the note has been in `CLAUDE.md` since the bun migration and it is
the only thing standing between a green pipeline and a silently weaker one.

**What the work actually is.** Porting four NestJS services from jest to `bun test`: `jest.fn()` and
`jest.spyOn` to bun's `mock`/`spyOn`, `ts-jest` (which TypeScript 7 already could not load - see
[ecosystem-convergence](ecosystem-convergence.md) section 9), the `moduleNameMapper`, and the
`@nestjs/testing` module fixtures. It is days, not hours, and it touches suites that guard MLS
storage - the wrong place to discover a mock that silently stopped asserting.

**Sequencing, and why it is not now.** The campaign is running and prod is the test server. A test
framework migration changes what "green" means for every rung still to be taken, so it waits until
the ladder reaches the bottom. Until then the honest description of this repo is: **bun is the
package manager and the runtime everywhere except one test invocation, which runs on node on
purpose, for a reason that has been measured.**

### P1 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27)

**This is not a bug report. It is the absence of one, which is worse.** `apps/call-service` was
brought back to compiling on 2026-08-27 after two Dependabot majors had merged onto `main` through a
CI hole (story in `CHANGELOG.md`; the hole itself is closed - the crate is in the Rust matrix now).
The bumps were `webrtc` 0.11 -> 0.17 and `axum` 0.7 -> 0.8. **What is verified is that it builds,
that clippy is clean under `--all-features`, and that its ten unit tests pass. Not one of those runs
the ICE stack, and not one of them places a call.** The repository's own rule names exactly this
distance: a green gate is not a working system.

**Six majors of webrtc-rs is not a version bump, it is a different library.** One behaviour change is
already known because it caused a compile error: `RTCIceServer::credential_type` is gone, and the
rule it carried moved inside the crate - `RTCIceServer::urls()` now returns `ErrNoTurnCredentials`
for a `turn:`/`turns:` URL whose username or credential is empty, where 0.11 accepted the same input
with an `Unspecified` credential type. A misconfigured TURN entry therefore used to degrade quietly
and now fails the WHOLE ICE configuration for that peer connection. `build_rtc_ice_server` warns and
names the offending server, which is the only thing that can be done from here without a call.

That one surfaced because it broke the build. **The ones that did not break the build are the reason
this entry exists**, and they cannot be enumerated by reading a diff - between 0.11 and 0.17 the
crate reworked ICE gathering, DTLS and the RTP/RTCP interceptor chain, none of which this crate's
types force it to acknowledge.

**What settles it is one call, and only one call.** Two peers, audio and video, over the SFU, with
TURN configured as production configures it - the relay path specifically, because that is the path
the `ErrNoTurnCredentials` change sits on and the path a STUN-only test never touches. Watch for: the
peer connection reaching `connected` at all; the terminal ICE line the crate already logs; whether
renegotiation still lands (`main.rs` has a renegotiation path that no test covers either).

**Blocked on nothing but a runner.** This is rung 15 of the ladder, CALL, and CALL is one of the
three phases with NO runner written - so the measurement cannot be taken until that runner exists.
Until then the honest statement is that calls are UNVERIFIED on this build, not that they are broken:
nothing observed them failing, because nothing observed them at all.

**SETTLED 2026-09-01 BY HOLDING THE SURFACE OFF, not by taking the measurement** (user: *"les appels
video et audio ne sont pas la priorite, et n'ont pas ete testes en bonne et due forme"*). The
paragraph that stood here said a release must not carry this unplaced; `CALLS_ENABLED = false`
(`frontend/src/lib/features.ts`) is how 0.14.15 carries it instead - the buttons are not rendered,
`handleCallSignal` refuses an invite a legacy peer still sends, and the two system ring surfaces are
uninstalled at their choke points (`CanariReportIncomingCall`, `showIncomingCallNotification`). The
platform declarations went with it, because each is a claim about a feature the store can check: the
iOS `voip` UIBackgroundModes entry (refused by App Review under 2.5.4 on 2026-08-31) and Android's
`USE_FULL_SCREEN_INTENT`.

**What is still owed is unchanged, and now has a name to flip.** One relay-path call, two peers,
audio and video, with TURN as production configures it - prod HAS it configured
(`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_CALLS_API_TOKEN`, TTL 7200, read off the container
2026-09-01) and has never once used it. The revival is one commit: `CALLS_ENABLED`, the plist entry,
the manifest permission, `kCanariCallsEnabled` and Kotlin's `CALLS_ENABLED` all move together, and
`CallService.callsEnabled.test.ts` is the test that already asserts the on state.

### P3 - the SFU's TURN acquisition fails in silence, twice (2026-09-01)

`fetch_cloudflare_ice_servers` ends both its network call and its JSON decode with `.ok()?`
(`apps/call-service/src/main.rs`), so a Cloudflare outage, an expired API token and a response shape
change all produce the same thing: `None`, no line, and a silent slide into `ice_servers_from_env`
and then STUN-only - on which a relay-only client cannot connect at all. The failure branches BELOW
these two already log (`[ICE] Cloudflare TURN API failed status=`), which is what makes the omission
visible as an inconsistency rather than a style. Every swallowed branch logs; these two do not.

Noticed while establishing that the SFU has never had a peer connection opened against it: the
success line `[ICE] SFU using N Cloudflare TURN server(s)` was absent from the whole container log,
and it took reading the call site to know that meant "no call" rather than "acquisition failed".
That ambiguity is the defect. Note also that `docs/wiki/services/call-service.md` claimed the fetch
happens **on startup**; it happens per peer connection (`resolve_ice_servers()` at the API builder),
and the page has been corrected.

### P2 - what made the profile fetches fail on that device at that moment

**The MECHANISM is closed** (2026-08-16): the swallowed `catch` now accuses, a reconnection clears
`failedAt` because a failure recorded while the network was down is evidence about the network rather
than about the user, a failed lookup answers `null` instead of the label that overwrote names the
caller already had, and `displayName.spec.ts` pins all of it.

**What is owed is the DENOMINATOR, and it is a measurement rather than a change.** The log line that
makes it countable did not exist when the symptom was seen - twice on 2026-08-16, on both platforms,
nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. Do not assume it is the
same fault as the avatar endpoint, and do not assume it is not.

**The denominator now rides ON the accusation (2026-08-19).** `displayName.ts` counts the lookups
that actually reached the network - a cache hit, the current user, the `system` sender and a lookup
already suppressed by the backoff are all excluded, because counting them would drive the rate
towards zero exactly as the cache warmed and measure the cache rather than the fault - and every
warn now ends `(failed/attempted lookups failed this session, X%)`. One line answers both "did a name
get lost" and "how often does that happen here", which is the question the backoff turns on.
`displayNameLookupStats()` exposes the same numbers to a test or a debug surface.

**Where the number will come from:** the campaign run logs, on both platforms. Nothing here is sent
anywhere - there is no client telemetry and this did not add any - so the rate is read from a device
or a browser console during a run, which is exactly where the symptom was seen. Server-side is not
an option: `GET /api/users/:id` is not request-logged, and a client that never reached the network
would not appear there anyway.

**Then decide about `FAILURE_BACKOFF_MS`.** A high rate argues the two-minute suppression is doing
real work against a refusing server; a rate near zero argues it is a clock hiding a name for two
minutes over a blip that the reconnection listener already handles.

### P2 - measure EGRESS over time, because two unrelated upstreams stalled in one window

The code half is fixed: `UpstreamUnreachableError` classifies at the throw, so an unreachable host is
a **502 `no-store`** never remembered, while an answer about the URL stays a cacheable 400; and
`OUTBOUND_BUDGET_MS` is the single budget, set on the `AbortController` AND on the undici dispatcher,
so the stated budget is the one that fires. Pinned by `security.controller.link-preview.spec.ts`.

**What is owed is not a code change.** Within one three-minute window on 2026-08-15, two unrelated
upstreams timed out from two different containers (`chat-delivery-service` → Wikipedia at 14:37:02,
`core-service` → gallery at 14:39:58). That is not evidence about either upstream, and it is the
second time this shape has been mistaken for one - the IPv6 reading was refuted by measuring the
components, which all came back healthy. **Measure EGRESS over time rather than the endpoints again**:
the component probes already say each is fine at the moment it is asked, so what is left to establish
is whether these stalls are CORRELATED, which a one-shot probe cannot answer by construction.

**ARMED 2026-08-19.** [`infrastructure/egress-probe/`](../../infrastructure/egress-probe/README.md)
takes a sample a minute - both stalled upstreams, the tunnel back to ourselves, a control at 1.1.1.1,
and the same target from inside `chat-delivery-service` through Node's own fetch - with DNS, connect
and TLS recorded apart from the total. `report.py` prints each conditional rate beside the base rate
it has to beat. Installed in the `canari` crontab, verified writing, `probe.err` empty.

**This item cannot be closed by working on it.** A report over a quiet week says the week was quiet.
Read the ledger the next time a stall appears in a service log; that is the moment the two
hypotheses differ, and the stall will already have been measured.

---

## Communities and permissions

### Question - does an invitation into a community notify somebody the inviter has never spoken to? (user, 2026-09-05)

Verbatim: *"Inviter dans communaute sans avoir discussion prealable : notification ?"*

**A QUESTION, NOT A DEFECT REPORT - and its first task is to answer itself.** Nobody here has asked
it, so the current behaviour is unknown rather than wrong, and an entry that guessed would be worse
than one that does not.

**WHY IT IS WORTH A ROW RATHER THAN A READ OF THE CODE.** "No prior conversation" is not a cosmetic
variation on the invitation path - it is the state in which the two parties share the least. Reading
the source can say which call is made; it cannot say whether a device with no prior anything is
addressable at the moment the invitation is sent, which is a fact about the server's roster and the
push token, not about the branch. The campaign has already found one defect of exactly that
shape - a device given a roster seat and never a Welcome - and it was invisible to every reading.

**WHAT WOULD ANSWER IT.** One row: a fresh peer with no conversation history with the inviter, the
app backgrounded, invited into a community. Three outcomes to tell apart, and they want different
fixes: no notification is raised at all (the push was never sent, or the device holds no token), one
is raised but carries nothing readable (the decrypt failed - the
[community notification P2](#p2---a-community-message-is-not-decrypted-in-a-background-notification-and-the-killed-case-is-unmeasured-for-both-kinds-user-2026-09-05)),
or it works. The logcat is what separates the first from the second; the shade alone cannot.


Six entries came out of ONE audit on 2026-08-17, prompted by a user question rather than by a
failure. **All six are closed as of 2026-08-19** and are not repeated here - the last one, two communities
sharing a name, the user closed by decision rather than by code (2026-08-19: it is not a defect).
The five that shipped on 2026-08-18: the mechanism is on
[social-service](services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18),
the audit and its prod figures on [community-rework](services/community-rework.md), the rule in
[durable-rules](durable-rules.md), and the story in `CHANGELOG.md`. Those six are closed; the entry
below them, a private salon's seed being sealed to the whole community, closed on 2026-08-20.
WP-REGRANT-1, opened 2026-08-21 by the campaign, shipped and was verified on production the same day -
its entry below is kept as CLOSED because the second attempt at the fix is the interesting half. **One
thing IS open here, and it is an observation rather than a finding:** the past-epoch seed frame below.
**The association permission audit, asked for on 2026-08-26, SHIPPED the same day** - all three
parts. Its measured flag table, the one predicate that replaced four disagreeing spellings, and the
seven findings D1-D7 are on [association-permissions](association-permissions.md), the only copy;
the rules it paid for are in [durable-rules](durable-rules.md), the story in `CHANGELOG.md`, and the
French user page it owed is `docs/user-guide/permissions-association.md`.

### P3 - an epoch-0 seed frame is delivered on every rotation, and nobody can open it (observed 2026-08-21, did not reproduce)

**COMM-22, six cycles, six of these** - one per cycle, both clients seeing the same frame at the same
second, `group_epoch` 3/5/7/9/11/13 and `msg_epoch` **0 every time**. So a frame sealed at the group's
first epoch is presented again on every rotation.

**Not a loss, and the product says so:** the frame is acknowledged and the seed arrives through the
history request instead - 12 markers of 12 warm AND cold. What is unexplained is why an epoch-0 frame is
delivered at all: `queued_message` held no publish matching it, which points at a REPLAY rather than a
sender sealing under a stale handle, and "points at" is not a finding.

**AND IT DID NOT REPRODUCE** - the next run on the same build, after `cleanup.mjs` swept three debris
communities, recorded `pastEpochFrames: []` over six cycles. The other half of the original observation
WAS real and is closed (a deleted community's seed carrier held for ever - see
[graine](protocols/channel-encryption.md#a-community-deleted-left-its-seed-carrier-held-for-ever---fixed-2026-08-21)),
and it accounts for the redelivery bursts but not for these frames, which appeared on a salon whose
community was alive.

**P3 and not higher because it may already be gone.** Settling it needs ONE probe that publishes a seed
and reads back what the server fanned out - a different instrument from the COMM runners. `comm22.mjs`
records `pastEpochFrames` verbatim on every run, so every future run says whether it is back, and the
cheapest next step is to read those rows rather than to build the probe.

### P3 - a Welcome is repaired by kick + re-add, and nothing records which of the two causes it was

Found 2026-08-25, while attributing GRP-8's `PASS-DIRTY` of 2026-08-24 (the run is on the
[board](cross-client-testing.md); the environment half is a methodology rule and is not repeated
here). A device of the group's creator was fanned into a new group, then sent a `welcome_request`
for a group whose leaf was ALREADY in the MLS tree. `actions.ts:956` handles that the documented way
- read the tree, kick the stale leaf, re-add - and logs `[KICK] Stale leaf ... removed`.

**The repair is right; what is missing is which situation it repaired.** Two reach this line and they
are not the same event:

- the Welcome was **lost or never delivered**, and the device's request is the retry that recovers
  it. The mechanism working exactly as intended.
- the Welcome was **still in flight**, and the device asked before it arrived. Then the push and the
  pull overlap, the repair is reconciling two paths that produced the same leaf, and the standing
  rule applies: *a race that heals cleanly is still a defect - name what makes the two paths overlap
  and delete the overlap; a ledger that reconciles them afterwards is a witness, never a fix.*

Nothing at the kick site can tell them apart, and the client that would know is the one being
repaired. **What would distinguish them:** the requesting device's own log - whether it had received
and failed to process a Welcome for that group, or had never seen one - and the elapsed time between
`sendWelcome` for that (group, device) and the `welcome_request` arriving. Neither is recorded today.
Carry the discriminator to the decision from where it is already known, rather than learning by
failing: the handler knows when the Welcome was sent, so the line can say which case it is.

Not raised above P3 because the repair is correct either way and no user-visible loss has been
observed - but it is the reason a group-creating check can go dirty on a device nobody touched, so
whoever reads the next `[KICK]` needs this page.

### P3 - the seam that forgets a conversation forgets it silently

Found on 2026-08-25 in the same reading. `historyReconcile.ts:756` is `forgetGroupReconciliation`,
the one seam every deletion path calls so that state describing a conversation cannot outlive one -
`conversations.ts:193` and `:228`, `groupActions.ts:151` and `:362`. Its own doc comment says why it
is one seam and not a line in each path: *"the old registry learnt the hard way: state describing a
conversation may not outlive one, and three separate pieces of it once did, one of them
user-visible."*

It clears three maps - `asked`, `deferred`, `coverageStated` - and logs nothing at all. So the
mechanism that exists BECAUSE this state once leaked past a deletion leaves no evidence that it ran,
which is the one thing a reader would want when it leaks again. Every rule this project has about
observation says the same: a correct mechanism with no report is found by hand, a day late.

**One line at entry, naming the group and what it held** (`asked`/`deferred`/`coverageStated` all
carry a value worth printing - a deferred reason, a peer count), plus the rule to classify it. Two
sibling exports read the same maps and are called only by `historyReconcile.test.ts` -
`deferredReconciliations()` and `statedCoverage()`. That is a legitimate test seam, not dead code,
and it stays.

**Why it is deferred.** Same reason as the entry above and filed with it: a product log line changes
what the classifier sees on four deletion paths at once, so it lands after the ladder, with its rule
written in the same commit.

### P2 - a bundle of pure DECLINES still goes out as transport, and a dropped decline strands a requester

**The measured case shipped 2026-08-25** - an answer carrying seeds is now `DELIVERY.keyMaterial`,
silent AND durable, so the server queues it without consulting presence. Story in `CHANGELOG.md`, rule
in [durable-rules](durable-rules.md), and COMM-18 is a clean `PASS` on it.

**What is left is the same shape, smaller, and has never been observed.** A bundle of PURE DECLINES
still goes out as transport, deliberately: it carries no key material and restates a fact the requester
could derive. But a dropped decline strands a requester exactly as permanently as a dropped seed did -
it is the fact that sends them to the NEXT member, and nothing re-asks.

**Why it is not fixed with the other half.** It needs the ability to deliver a frame to a device that
presence reports offline WITHOUT appending it to the group's log - the fourth combination `DELIVERY`
does not have (`silent` and `durable` were one boolean until 2026-08-12, and `durable` still gates both
the presence filter and the history append server-side). Splitting them is a wire-level change, so it
waits for a measurement that needs it rather than being guessed at now.

### P3 - a poll whose deadline passes while the card is on screen flips only on reload

Left behind by the COMM-15 fix of 2026-08-25, and stated here so it cannot hide behind that defect a
second time. The closure of a channel poll is now the SERVER's statement (`ServedChannelPollMeta.closed`,
[social-service](services/social-service.md#channel-polls-and-who-decides-one-is-over)), which fixes
the case that mattered - a poll closed by a human, whose card used to stay open for ever because two
clocks answered the question. It does not fix the case where the deadline simply arrives: `closed` is
stamped when the poll is handed out, and nothing re-reads it afterwards.

Two things stop at that instant, and only one of them is worth anything. The FOOTER (the vote form
giving way to the ended label) is the one that matters, and it is wrong for as long as the card stays
mounted - a person can still submit into a poll the server will refuse with a 403, which is the same
class of "the server enforces a rule the client has never heard of" the write-policy work already
named. The COUNTDOWN is cosmetic: `pollCountdown` renders whole minutes and does not tick, so it is
already stale between renders, and it now floors at zero rather than claiming an ended poll is still
open.

**The fix is NOT a timer in the card**, which is what "make it tick" would buy, and would put a
per-poll interval in a list that scrolls. The deadline is KNOWN, so the moment it becomes interesting
is known too: one `setTimeout` per mounted poll, at `endsAt - now`, that flips the poll's own state
once and never fires again for an already-closed poll (and never at all for one with no deadline).
Even that has to state whose clock it used, so the delay is computed from the same server statement
the card is already given rather than from a comparison this side makes. Alternatively - and cheaper -
the vote submission's own 403 is a fact the card can act on, which is the one path where being wrong
actually costs a person something.

**Why it is deferred.** It is a rendering item behind a defect that is fixed, nothing on the ladder
asserts a deadline arriving live (the campaign closes polls with the close control), and MUT-20 aside
no check waits on wall-clock time at all. It belongs with the rendering pass, not with a rung.

## Messaging convergence

### P1 - a backgrounded phone is never told about a message it has already received, because the JS layer waits for a push the server never sends (measured on device 2026-09-05)

**THIS ENTRY SAID SOMETHING ELSE UNTIL 2026-09-05 EVENING, AND THE MECHANISM IT NAMED WAS THE
WRONG ONE.** It read the `SecretReuseError` below as the reason a backgrounded phone shows no
notification. It is not: that error belongs to a SILENT frame that was never going to notify
anybody. The reason is one early return in the client, and it is worse than what was filed. The old
account is kept below because the observations in it are all real - only the conclusion moved.

## What actually happens, correlated across all three sources on ONE message

The phone was backgrounded with HOME (LIFE-2's premise, app alive), W2 sent one text message.

```
client   POST /api/mls/send  {"proto":"<348 chars>","silent":false,"durable":true}   <- the message
client   POST /api/mls/send  {"proto":"<276 chars>","silent":true, "durable":true}   <- a mutation frame

server   17:57:40 [SEND][send-cc0b716e] PUBLISHED recipient=<owner>:tauri-...       <- and NOTHING after it
server   17:57:42 [SEND][send-2bf6df35] PUBLISHED recipient=<owner>:tauri-...
server   17:57:52 [PUSH_DEFERRED][send-2bf6df35] still unACKed after 10 s -> FCM fallback
server   17:57:52 [PUSH_SEND][send-2bf6df35-def] FCM sent ... platform=android

phone    19:57:53 onMessageReceived: queuedMessageId=eaab3c04...   <- the MUTATION, not the message
phone    19:57:53 thread: ... silent=true
phone    19:57:57 Silent push decryption failed -> returning silently

result   notifiedInMs=null, shade empty, and `A1 holds the message: 1`
```

**The visible message never became a push at all.** `scheduleDeferredPush` fires only for a message
still unACKed after 10 s, and a backgrounded Android app keeps its WebSocket, receives the frame and
ACKs it - so the server correctly sends nothing. The push that DID arrive was for the silent
mutation frame beside it, which by definition raises no notification whatever it decrypts to.

**And the client had already decided not to speak.** `notifyInbound` opened with:

```ts
// Native mobile (Android + iOS) posts its own OS notification from the background push handler,
// so the JS layer must NOT also fire one - the user would get two.
if (isMobileTauriRuntime()) return;
```

The premise holds only when there IS a push. For the ordinary backgrounded case there is none, the
push handler never runs, and **nobody notifies at all**. The app has the message the whole time; the
user is simply never told.

**It also explains the pair this campaign had backwards.** **LIFE-8** (`am kill` - the user killing
the app) measured a decrypted push in 4.7 s: a killed app cannot ACK, so the deferred push fires and
the Kotlin handler notifies. *The phone in a pocket was the failing case and the phone the user had
killed the passing one*, which the earlier account noticed and attributed to a spent ratchet
generation. The generation is spent, and it is not why.

**AND THE ROW FIRST CITED HERE WAS THE WRONG ONE - twice, by two different readers.** The original
entry said *"LIFE-3, which KILLS the app, passes: a killed app has spent no generation, so its push
decrypts and notifies"*, and the first correction of this entry repeated it. LIFE-3 **force-stops**,
and `life.mjs` says why that is a different question: a force-stopped package sits in Android's
STOPPED state and the framework cancels every FCM broadcast to it, so the row records
`notification: {expected: false, afterMs: null}` and PASSES because nothing was owed. It is evidence
about nothing here. Re-run 2026-09-05 20:24 to check this fix for a regression - `PASS-DIRTY`,
unchanged - and that run is what caught the citation. **A row's verdict means what the row asserted,
and "it passes" is not a mechanism.**

**FIXED 2026-09-05**: the early return is gone. Native mobile now notifies on
`visibilityState === 'hidden'` - not on "hidden or unfocused", which is the desktop rule: a WebView
reporting no focus while its activity is on screen would interrupt somebody reading the message.
Five tests pin both directions, and two of them fail if the early return comes back.

**What is still owed, and it is the overlap rather than the defect.** When a message is unACKed for
10 s AND the app is alive, both paths can now notify, and they cannot merge into one banner because
they compute the notification id differently - see the table below. The window is narrow, the
failure mode is one extra banner rather than a lost message, and it is strictly better than the
silence it replaces. The id unification is the follow-up.

## The older account, whose observations stand and whose conclusion does not

On the phone, for every message:

```
E/openmls: Ciphertext generation out of bounds 433 / SecretReuseError
E/mls_core::messaging: MLS decryption failed at exactly its own epoch, so no redelivery can help
   group=2bd5add9 msg_epoch=12 group_epoch=12
E/mines_app_lib::mobile::background: [PushBG] key-based: process_incoming_message Err(... same-epoch refusal ...)
W/CanariFCM: decryptProto: ok=false -> decryption failed
D/CanariFCM: fetchCommitsFromBackend: 0 commit(s) since epoch=12
D/CanariFCM: catchup: no commit to catch up (epoch=12) -> fallback
W/CanariFCM: Decryption failed -> MlsBackgroundWorker enqueued
D/CanariWorker: doWork: background cleanup completed          <- 60 ms, and it decrypts nothing
```

**What the user sees**: `Nouveau message de <name>` with no preview. NOTIF-10 cuts the RADIOS rather
than backgrounding the app, so the app is alive, decrypts over its socket when the radios return,
and the push loses - `notifiedInMs: null` for all five messages there. That row is the one place
this noise becomes a verdict, and the fix above is what should now carry it.

**Why the generation is already consumed, from the server's own log.** The push is not
unconditional: `[PUSH_DEFERRED] queuedId=... still unACKed after 10 s -> FCM fallback`, then
`[PUSH_SEND] FCM sent`. So the server pushes only what the device has not ACKNOWLEDGED.

The phone had DECRYPTED the message - spending the generation - and had not ACKED it, because its
network was failing in exactly that window: `[OUTBOX] a461056f... transient failure (attempt 1..3):
error sending request for url (http://localhost:8081/api/mls/send)`. Ten seconds later the server
pushed a message the device already held, and the push could not decrypt it, because a ratchet
generation can be spent once.

**The notification falls into the gap between DECRYPTED and ACKNOWLEDGED**, and the ACK is being
asked a question it was not written to answer: it says whether the SERVER's copy was collected, and
it is read as whether the DEVICE needs telling. On a phone whose uplink is degraded - the ordinary
case for a backgrounded app - those two come apart on every message.

**LIFE-2 is the same defect and it is worse there.** Backgrounded via HOME (not killed), the shade
held nothing but the USB notice, `notification.afterMs: null`, and the message took 95 s to appear.
~~LIFE-3, which KILLS the app, passes: a killed app has spent no generation, so its push decrypts and
notifies.~~ **Both halves of that sentence are wrong** - LIFE-3 FORCE-STOPS, which cancels FCM
outright, so it expects no notification and passes because nothing was owed; and the row that does
measure the killed case is LIFE-8 (`am kill`, a decrypted push in 4.7 s), where the reason is the
missing ACK rather than an unspent generation. **A phone in a pocket is the failing case and a phone
the user has killed is the passing one** - that part held, for a different reason than the one given
here.

**Three rules this sits on.** *A race that heals cleanly is still a defect* - and this one does not
heal: the preview is gone for good. *A fallback is a signal, never a path* - this one is taken 100%
of the time and leads to a worker that only runs `background cleanup`. *Never learn by failing what
a fact could have told you* - `queuedMessageId` is in hand before the decrypt is attempted.

**The discriminator already exists one layer down and is thrown away one layer up.** `mls_core`
names this exactly - "same-epoch refusal", distinct from an epoch gap - and `CanariFirebaseMessaging-
Service` collapses both into `decrypted == null`, then answers with a commit catch-up whose own
comment says it is for "an epoch gap (a commit arrived while the app was closed)". For a same-epoch
refusal the catch-up cannot help by construction, and it costs a backend round trip and a worker
enqueue per message.

**What a fix owes.** Two halves, and they are independent - the first stops the waste, the second
restores the preview:

1. Carry the kind to Kotlin as a TYPE - *never branch on an error message* - so a same-epoch refusal
   stops costing a backend round trip and a worker enqueue per message, and can be answered from the
   copy the device already holds.
2. **When the JS layer is the path that decrypted, the preview must reach the notification the
   platform already has.** `notifyInbound` excludes native mobile wholesale, on the ground that "the
   background push handler posts its own" - true only when the push CAN decrypt, and by the ratchet
   argument exactly one of the two ever can.

**THE SHAPE FILED FOR (2) ON 2026-09-05 WAS WRONG, AND IT WOULD HAVE SHIPPED A SECOND NOTIFICATION.**
It said the two sides "already key their notification per conversation (`stableNotifId` / tag
`canari-<id>`), so the app's would REPLACE the contentless fallback". They key per conversation and
they key it DIFFERENTLY - measured 2026-09-05 by reading both:

| | how the id is computed | what else the notification carries |
| --- | --- | --- |
| Kotlin, `CanariFirebaseMessagingService.getStableNotifId` | a **SharedPreferences counter from 1000**, one per `groupId`, `commit()`ed under a lock so two conversations cannot collide | `MessagingStyle`, the reply and mark-as-read actions, the channel, the group summary, the launcher badge |
| JS, `useNotifications.stableNotifId` | `Math.abs(hash31(conversationId)) \|\| 1` | title and body |

Two id spaces that coincide only by accident, in one `NotificationManager` namespace - so
`sendNotification({ id })` from the WebView posts a NEW notification beside the contentless one,
with no actions, no style, no summary and no badge. **Keying "per conversation" is not the same as
keying on the SAME conversation key**, and the entry above read the first as the second.

**So the shape is a bridge, not a second surface.** The JS layer hands the decrypted preview to the
native side - one Tauri command reaching the `showNotification` path that already exists (it is
`private` in the service today, and it already suppresses itself when the app is in the foreground,
which is the guard this call needs anyway). One notification surface on Android, keyed by the id the
platform is already using, so a push that DID manage to decrypt and an app that decrypted the same
message update one notification rather than racing to post two. **Idempotent by construction rather
than by a check**, which is the only version of this worth shipping.

**Why none was written on 2026-09-05.** A rule rather than a budget: **a green gate is not a working
system, and three of three iOS defects were invisible to every gate here.** Both halves change
notification behaviour on a surface only hardware can judge, and **the phone went behind its
credential lock screen mid-phase** (`deviceLocked=1`, `wm dismiss-keyguard` refused, no credential in
the rig), so LIFE-6/7/8 never ran and nothing could be re-measured. A notification fix verified only
by unit tests is exactly the shape that has cost this project three times. **The phone answered again
later the same day**, so the blocking condition is lifted; what is left is the APK build and the
hardware pass, and the four rows to re-take are the ones in the COMMUNITY entry below.


### P2 - a COMMUNITY message is not decrypted in a background notification, and the KILLED case is unmeasured for both kinds (user, 2026-09-05)

**Reported by the user, who has seen it**, and asked in the same breath for the question the campaign
has so far half-answered: *"Notification non dechiffrees en background - Communaute"*, and *"Les
messages sont ils bien dechiffres en notification quand l'app est tuee OU en background ?"*

**FOUR CELLS, AND ONLY TWO HAVE EVER BEEN MEASURED.** The two axes are the conversation's encryption
and the app's lifecycle state, and they are independent - so the answer to one cell says nothing
about any other.

| | app BACKGROUNDED | app KILLED |
| --- | --- | --- |
| DM or group (per-conversation MLS ratchet) | **FAIL** - LIFE-2, no notification at all. **Cause found and fixed 2026-09-05**; owed a re-run | **PASS-DIRTY** - LIFE-3, and it passes *because* a killed app cannot ACK |
| Community salon (the community's shared key) | **PASS, measured 2026-09-05** - full plaintext in the shade in 2 244 ms, seed mirrored | **UNMEASURED** |
| Community salon, seed NEVER mirrored | **UNMEASURED - and this is the user's report's likeliest home** | **UNMEASURED** |

**THE DM ROW'S CAUSE IS ESTABLISHED AND IS NOT THIS ENTRY'S.** It is
[the backgrounded-phone P1](#p1---a-backgrounded-phone-is-never-told-about-a-message-it-has-already-received-because-the-js-layer-waits-for-a-push-the-server-never-sends-measured-on-device-2026-09-05):
a backgrounded app receives the message over its WebSocket and ACKs it, so the server never sends a
push at all, and the client had an early return refusing to notify on native mobile. **The phone in
a pocket is the failing case and the phone that was killed is the passing one** - a killed app
cannot ACK, so its push does fire. *(Until 2026-09-05 evening this paragraph blamed a spent ratchet
generation. That was measured and is real, and it is not why the notification is missing.)*

**AND THE SALON HALF DOES NOT REPRODUCE.** Measured on device 2026-09-05, app backgrounded with
HOME, one message into `Canari Test Venue / #general`: the shade held
`Canari Test Venue - #general | <the full plaintext>` after **2 244 ms**, and the phone logged
`handleChannelMessage: showNotification title=... body=<the text> mentionsMe=false`. So the salon
path decrypts in the background, and it does so through a mechanism that has nothing to do with the
MLS ratchet: `lookupGraineSeed(channelId, sessionId)` against `graine_seeds.json`, a mirror the
FOREGROUND writes. **That is where the user's report most likely lives**, and it is a different
question from the one measured: the run above had A1 open the salon first, which is exactly what
mirrors the seed. The unmeasured case is a session whose seed was never mirrored - a sender who
started a new Graine session while this device was away - and its symptom is
`handleChannelMessage: no seed/ciphertext -> generic notification`.

**That line cannot say which of its four conditions failed**, and it is one `if` with four terms
(`seedB64`, `ciphertext`, `nonce`, `messageIndex`). A seed that was never mirrored and a ciphertext
the server declined to inline are opposite problems - one is a mirroring bound, the other a 4 KB FCM
budget - and they print the same sentence. Naming the term is a one-line change and it is what turns
the user's report into a diagnosis.

**A COMMUNITY SALON CANNOT INHERIT THAT ANSWER, BECAUSE IT IS NOT THE SAME KEY PATH.** A salon is
encrypted with the community's shared key
([channel-encryption](protocols/channel-encryption.md)), not with a per-conversation MLS ratchet, so
the spent-generation argument that explains the DM failure may not apply to it at all - and if it
does not, the cause is a second, unrelated one wearing the same symptom. **Two causes that produce
the same screen want opposite fixes**, so the two rows are measured apart before either is touched.

**WHAT IS OWED, and it is measurement first.** Four NOTIF rows - salon x {backgrounded, killed} and
the two DM cells re-taken on the same build so the comparison is from one afternoon rather than from
two. All four need the phone, which is
[owed a human unlock](#owed-to-the-user---decisions-rotations-and-one-off-clicks). Read the salon
rows with the invitation question in
[Communities and permissions](#communities-and-permissions): a notification that never arrives and a
notification that arrives undecryptable are different failures, and only the logcat separates them.

### P1 - a device that joins a group ends up permanently short of the messages sent just before it arrived: the responder gives up seven seconds before the answer comes, and the one retry that would have saved it is swallowed by a coalescing window (measured on the local estate 2026-09-05, eight reproductions and ONE CONTROL THAT PASSED)

**HEAL-REVOKE-5 found it on the first run that ever sent a message.** The runner's own docstring had
claimed for a week that the world it moves while the device is away is made of *"a group created, a
group deleted, and messages sent"*; the code moved MEMBERSHIP only. Adding the message half took one
run to fail.

**THE MEASUREMENT, IDENTICAL IN SEVEN RUNS AND ON TWO DIFFERENT ROWS** - HEAL-REVOKE-5 six times and HEAL-REVOKE-8 once, the latter with every one of its own assertions green. W1 creates a group while the victim is revoked, says
three marked things in it, and the victim then comes back:

| | messages seen | time |
| --- | --- | --- |
| the returned device | **0 of 3** | after waiting **60 s** |
| a reference device minted ~90 s later, same profile, same group | **3 of 3** | already there, **2 ms** |

**IT IS NOT THE INSTRUMENT, AND THREE SEPARATE THINGS SAY SO.** Both devices are given the same
budget and the wait ends the instant the target is reached, so the reference's 2 ms and the returned
device's 60 s are the same question asked with the same patience. A RELOAD on the returned device -
which rebuilds the view from the store - still shows 0, so this is not a conversation failing to
re-render something it holds. And the first version of the probe DID manufacture a false asymmetry
by reading the two devices half a minute apart; that was found and removed before any of this was
believed, which is why the budget is equal now.

**IT IS NOT FORWARD SECRECY EITHER, WHICH IS THE FIRST THING TO RULE OUT.** A device that joins at
epoch N cannot read epoch N-1, and that would blind BOTH devices equally - the assertion is an
EQUALITY for exactly that reason. Both joined after the messages were sent. One got them.

**BOTH DEVICES TAKE THE SAME PATH, VERBATIM.** Neither is added by a member; both let themselves in:

    [READD] 968a2339... roster seat with NO queued Welcome and NO add in flight - nobody owes us
            anything; serving ourselves
    [READD] 968a2339... externalJoin -> joined
    [HISTORY_STATE] Sent for 968a2339... - 00000000..., from 2026-06-07T00:00:00.000Z
    [HISTORY_RECONCILE] asked 968a2339... whether we hold the same history

Same path, same state key, same window. `recovery.ts` calls `reconcileGroup` right after an external
join precisely because *"an external join lands at the current epoch WITHOUT the pre-join history,
which only a member can re-encrypt"* - so the mechanism is there and both devices used it.

**THE DIFFERENCE IS ENTIRELY ON THE ANSWERING SIDE, AND IT IS A SILENCE.** W1's console:

| when (local) | what W1 did |
| --- | --- |
| 21:49:50 | said the three things - they are in its own store |
| 21:49:56 | `[HISTORY_STATE] From ... for 968a2339...` - **received the returning device's key, and nothing more** |
| 21:51:21 | received the reference's key, `Keys differ`, asked it to describe itself |
| 21:51:25 | `[HISTORY_BUNDLE] Chunk 1/1 - 3 msg`, `Diff sent: 3 of 3 requested` |

**Six seconds after storing three messages of its own, W1 answered nothing at all.** Not
`same state as ... - nothing to do`, not `no probe from ... - nothing to answer`, not `store
unreadable - staying silent`: `handleHistoryRequest` writes a line on every branch it can take, and
none of them is in the window. **The comparison never ran.** Ninety seconds later the identical ask
from an identical device ran it and worked.

**THE CAUSE, AND IT IS A RACE BETWEEN TWO CLOCKS ON TWO DIFFERENT DEVICES.** The sixth run caught
the whole exchange, second by second, with the phone deliberately taken off the socket so only W1
could be elected:

| when | who | what |
| --- | --- | --- |
| 21:59:14 | returning device | external join, then `[HISTORY_STATE] Sent`, `asked ... whether we hold the same history` |
| 21:59:14 | **W1** | `Keys differ for b88db381... - asked <returning device> to describe` |
| ... | returning device | **silence for 67 seconds**, while it externally joins the other nineteen groups |
| **22:00:14** | **W1** | **`asked ... to describe itself, no digest came`** - it gives up |
| 22:00:21 | returning device | `holds something different - describing our store` |
| 22:00:22 | returning device | `[HISTORY_DIGEST] Sent` - **seven seconds too late** |
| 22:00:38 | reference device | the same exchange, digest in the SAME SECOND, `3 of 3 requested message(s)` sent |

**Both halves are individually reasonable and their assumptions do not meet.** The responder waits
`HISTORY_PROBE_WAIT_MS`, which is `DIGEST_TTL_MS` = **60 s**. The asker answers a digest request only
`answerAfterMailboxDrained`, deliberately - *"a digest computed while this device is still applying
its own queue describes a store it is in the middle of completing"*. **A device that has just come
back is applying twenty external joins**, so its queue takes longer to drain than the responder is
willing to wait. The reference wins because it happens to ask when its own queue is already quiet.

**AND NOTHING RETRIES - BUT NOT FOR THE REASON FIRST WRITTEN HERE.** The first version of this
entry said a late joiner holds no unreadable frame and so never raises the reconciler's other
trigger. **That is false, and HEAL-REVOKE-7 measured it false.** The server hands a joining device
the group's queued frames, it cannot read any of them, and it says so out loud six seconds after the
join:

    [22:11:09] [HISTORY_RECONCILE] asked fc1cb0bc... whether we hold the same history
    [22:11:15] [HISTORY] fc1cb0bc... holds 4 frame(s) it can never read - reconciling
    [22:12:09] [HISTORY_REQ] fc1cb0bc... asked <the returning device> to describe itself, no digest came

**The trigger fires. The ask never leaves.** `reconcileGroup` returns at `if (recentlyAsked(groupId,
now)) return false` - `PROBE_COALESCE_MS` is 30 s and the join's own ask was 6 s ago - and it returns
there SILENTLY, after the caller has already printed the word *reconciling*. So the one line a reader
would trust is the one that is not true.

**THE COALESCING WINDOW IS SOUND ONLY UNDER AN ASSUMPTION THAT IS FALSE HERE**, and the code states
the assumption itself: being wrong about it costs *"one repair deferred to the next edge, and the
next connection re-asks unconditionally either way"*. The next connection edge is the next time this
device reconnects - which for a session that simply stays up is never. The trigger's evidence is
spent by then (the frame is acked and gone), so the deferral is permanent. The conversation settles,
shows READY, shows `amber: []`, and is short three messages for ever, with nothing anywhere saying
so.

**THE ORDER PAIR IS THE CONTROLLED EXPERIMENT, AND IT ISOLATES THE VARIABLE TO ONE NUMBER.**
HEAL-REVOKE-7 runs the same runner twice with one difference - whether anybody is online at the
moment the device returns - and the two runs disagree on the final state, which is why the pair is a
`FAIL`:

| | first ask | the frame trigger | gap between them | second ask | messages |
| --- | --- | --- | --- | --- | --- |
| `--order last` (world online) | 22:11:09, at the join | 22:11:15 | **6 s - inside the 30 s window** | never | **0 of 3, for ever** |
| `--order first` (world offline, lifted later) | 22:14:18, at the join, answered by nobody | 22:15:00 | **42 s - outside it** | 22:15:00, answered | **3 of 3 in 3.5 s** |

**The run that had NOBODY to answer its first ask is the run that ends up complete.** Its first ask
was wasted, so its retry fell outside the coalescing window; by the time the retry went out its own
mailbox had drained, the digest went out in two seconds, `history_bundle` landed, and the device is
whole. The run that had a responder available immediately is the one that loses the messages
permanently. **The failure needs the two clocks AND the swallowed retry: fix either and this
measurement passes.**

**THIS IS ALSO WHAT HEAL-repair IS BLOCKED ON.** That row is `PARTIAL` - 7 of 14 reached the peer -
and the open question written beside it is the string `no digest came`. It is the same line, from
the same branch, for the same reason. **One cause, two rows**, and the second one has been open since
2026-09-05 morning with no mechanism proposed.

**TWO HYPOTHESES WERE MEASURED AND KILLED FIRST**, which is why the one above is stated plainly.
*The server elected a device that was not there*: the election reads `user:online:<user>:<device>`
before forwarding and skips anything else, so it cannot. *The elected member was the phone, online
but frozen*: the phone IS a member of that group and WAS online, and the Android was measured
`Awake`, `mState=ACTIVE`, Canari the top resumed activity - not frozen - and the failure reproduced
identically with the phone force-stopped and off the socket entirely.

**IT IS THE USER'S OWN REPORTED SYMPTOM CLASS**, and it is worth reading beside the P1 about twelve
dropped messages: *"j'ai l'impression de n'avoir qu'une petite partie des messages qu'il m'envoie"*.
A conversation that is READY and incomplete is indistinguishable, to its owner, from one that is
complete.

**WHAT THE FIX HAS TO SATISFY, and a deadline is not it** ([durable-rules](durable-rules.md):
*termination comes from a proof, never from a clock*). Raising the 60 s buys the next slower boot
nothing, and neither does shortening the coalescing window - both are the same mistake twice.

**The responder's half is the one that can be made event-driven, and the shape is already in this
file.** `history_pull` is answered on ARRIVAL, addressed, with no rendezvous and no TTL, and it
terminates because a bundle asks for nothing. The second leg of the state exchange is the only one
that needs a live waiter, and it needs it for nothing: the digest carries the manifest and the
window, our own store carries the rest, so **a digest that arrives for a solicitation we issued is
answerable whenever it arrives**. The 60 s then bounds MEMORY, which is what a TTL is for, instead
of bounding CORRECTNESS, which is what it is doing now.

**The asker's half is the retry, and it must not be a timer either.** A trigger that is coalesced is
being told *an ask already in flight will cover you* - so the honest form is to REMEMBER it and let
the in-flight ask's window close into a real second ask, rather than to drop it and hope a
reconnection comes. And the silent `return false` has to say something: a line reading *reconciling*
followed by nothing is worse than no line at all.

**AND THE RE-RUN FOUND A SECOND CAUSE WITH THE SAME SYMPTOM, WHICH IS WHY THE FIRST FIX DID NOT
CLOSE THE ROW.** On the build carrying it, HEAL-REVOKE-7 `--order last` failed identically - and the
SERVER's log named the difference:

    22:41:50  FORWARDED target=<the phone>  requester=<the returning device>   - silence
    22:41:56  the returning device holds 4 frames it cannot read - swallowed, 6 s into 30
    22:43:15  FORWARDED target=<the phone>  requester=<a reference device>     - silence
    22:43:20  FORWARDED target=<W1>         requester=<a reference device>     - 3 of 3 sent

**The election is RANDOM by design**, and `notifyHistoryRequest` says why: a backgrounded Android
holds its socket open, so `user:online` is true while the app cannot process the frame, and
randomising *"lets those retries rotate past a frozen peer to a genuinely reachable one"*. **There
were no retries.** The reference device is whole because it asked twice - a fresh enrolment joins
each group, which clears the coalescing note - while the returning device re-joined a group it
already held (`already in WASM - skip`), kept the note, and asked once. Two defects, one symptom:
the responder that answers TOO LATE, and the responder that answers NOTHING.

**Both are fixed.** The second by `escalateReconciliation`: a trigger that can prove incompleteness -
a frame this device holds and cannot read - excludes the member the in-flight ask reached and elects
another, terminating on the server's own `no_peer_online` + `excludedOnline` proof, one member per
step, bounded by membership.

**WHAT REMAINS OPEN IS THE REASON THE ESCALATION HAS TO BE GATED ON EVIDENCE: silence means both
*we agree* and *nobody answered*.** They are the same observation, so a device with no local proof of
a gap cannot tell a healthy responder from a frozen one. Making the agreeing responder ack would cost
one frame per group per ask, which is the whole saving the state key exists for - so it is a design
question rather than an oversight, and it is written here rather than improvised.

**FIXED THE SAME DAY, AND THE ROW IT WAS FOUND ON IS WHAT VERIFIES IT.** Both halves shipped
together: `answerHistoryDigest` is a function rather than a continuation inside the wait, and
`systemMessageHandler` calls it when a digest arrives for a solicitation this device issued and no
waiter took - addressed by `takeDigestSolicitation`, so the leg stays two-party and the election
still elects exactly one responder. The 60 s now bounds MEMORY. The coalesced swallow is logged
instead of silent, so `history.ts`'s *reconciling* line can no longer stand for something that did
not happen. Nine tests, three files. **What is left is the measurement**: HEAL-REVOKE-7 `--order
last` and HEAL-REVOKE-5 re-run on a build carrying it, and HEAL-repair, which was `PARTIAL` on the
same string.

**The instrument is in and the next measurement is a re-run, not an investigation.** The runner
records the `[READD]`/`[HISTORY*]` trail of all three clients on every run, filtered to the group by
its id.

### P3 - a browser report has no notion of a FOREIGN origin, so every row that logs in reads the identity provider's console as the application's (measured 2026-09-05)

`login.mjs` drives the real login, so the observed TAB navigates to Authentik and back - and a
console observer follows the tab, not the origin. Everything Authentik's front end prints while it
renders its password stage therefore landed in `unexplained`, attributed to Canari. HEAL-REVOKE-9
collected ten such lines on its first run, and **every row that logs in collects them**.

The phone report already has the idea: `logcatReport` buckets other Android applications as
`foreign`, with a count and a tag list rather than an inline dump, precisely because a device writes
hundreds of lines this rig did not cause. The BROWSER report has no equivalent at all.

**Disposed of for now, not fixed.** `IDP_CONSOLE_NARRATION` names the five sentence shapes and the
three login dispositions in `healrevoke.mjs` take it - which is a per-row disposition, the campaign's
own rule, and it works. **The fix is to attribute a console line to the ORIGIN that emitted it** and
classify anything that is not `SITE` (or `tauri.localhost`) as foreign, at which point no row needs
the list at all.

**Why it was not done inline**: it rewrites the classifier every runner shares, so it ages a large
part of the ledger - the same reason the `unlockPin` de-duplication is parked. It belongs between
rungs. Note that `watch.mjs` was already touched twice on 2026-09-05, so the ledger has been aged
today regardless; what makes this different is that the earlier edits were ADDITIVE constants and
this one changes what `clean` means.

### P3 - the read-receipt half of the visibility fix is unit-tested and OWED a hardware pass, and the probe that would give it needs a different precondition (2026-09-05)

The notification half was verified on the device (shade carries the decrypted text 2 218 ms after
the send, LIFE-2 `FAIL` -> `PASS`). **The read-watermark half was not**, and it is the same one-term
guard reading the same `isAppInForeground()` whose value WAS measured flipping correctly on hardware
(`{"foreground":false}` backgrounded, `true` in front) - so the residual risk is that the watermark
path behaves differently, not that the fact is wrong.

**Two instrument problems stopped the probe, and both are worth having written down.**

**`openConversation` CANNOT BE A PRECONDITION ON A PHONE THAT IS ALREADY IN THE CONVERSATION.** It
waits for the peer's row in the SIDEBAR, and on a mobile layout the list and the conversation are
different screens - so it reported `listedEntries: 0` for three and a half minutes about a client
sitting inside the very DM it wanted. A screenshot settled it in one look: the app was in the
conversation, showing every probe message including the one the probe thought had gone nowhere. **It
was one step from being filed as "the phone's sidebar comes back empty after a reinstall"**, against
an app doing exactly the right thing. The rig's own rule - LOOK AT THE SCREEN when something does
not work - is what caught it.

**And a raw `/api/mls/send` count is the wrong observable.** The watermark is an MLS control frame
among other control frames, so the count cannot name it; and the probe's own positive control came
back ZERO in the foreground, where a watermark IS owed, which correctly made the whole run
`INCONCLUSIVE` rather than a pass. Whether that zero is "already at its target" (`if (target <=
held) return`), a watermark sent before the observer attached, or a path this probe does not see, is
not established.

**What a real row needs**: the peer's view, not the sender's traffic. W2 holds the read state for
its own message, and that is the fact a user cares about - `A1 read it` appearing for a message
nobody looked at. That is one DOM read on W2 against a marker, and it is falsifiable in both
directions without counting anything.

### P2 - eleven more decisions read a visibility API that lies on every phone, and two of them look like they matter (measured 2026-09-05)

`document.visibilityState` and `document.hasFocus()` are both permanently true in a backgrounded
Android Tauri WebView - measured, see [durable-rules](durable-rules.md). Two consumers were fixed
the day it was found, because each had a user-visible defect behind it: the inbound notification and
the read watermark. **The rest were not touched, and they were not measured either.**

| call site | what it decides | what a permanently-`visible` phone does instead |
| --- | --- | --- |
| `mlsStatePersisterLifecycle.ts:16` | persist the MLS state when the page goes hidden | **never persists on backgrounding** - the case the hook exists for is the one it cannot see |
| `TauriMlsService.ts:173` | reconnect the socket when the page becomes visible | the edge never fires, so a socket dropped while away is not re-opened by this path |
| `backgroundPausableInterval.ts:29,38` | pause timers while hidden | never pauses - battery, not correctness |
| `ChatBackgroundService.svelte:881,953,1218,1237` | four guards around login and reconnection | unmeasured |
| `MainChatPage.svelte:266` | a guard on a periodic refresh | unmeasured |
| `useMessaging.svelte.ts:750` | the batch-notify log line | says `visible` about a backgrounded phone in the log, which is misleading rather than wrong |
| `LoginPage.svelte:85` | a retry on becoming visible | unmeasured |

**The first two are the ones worth measuring first**, and the first is the one that could cost
something durable: a state persister whose trigger never fires on the platform where the process is
most likely to be killed without warning. That is a hypothesis from reading, not a measurement - the
phone may well persist on another trigger, and **saying which needs one run, not an argument**.

**The fix shape is settled and cheap**: `isAppInForeground()` already exists and is `true` on every
runtime that has a working visibility API, so each site becomes one extra term and web and desktop
keep their current behaviour exactly. What is NOT settled is which sites should change - a guard
that is merely wasteful on mobile is not the same as one that loses state, and they want different
urgency.

### P2 - a frame this device already read is re-accused as lost on every later cold start, and the reconciliation it triggers finds nothing (measured 2026-09-05)

TAB-3b runs five cold starts. Each one printed `[History] frame never read here and unreadable for
good (secret-reuse); will reconcile` - and the later runs re-printed **the same row keys** as the
earlier ones (`row 1788591833954-0` appears in run 1 and again in run 2), alongside
`Ciphertext generation out of bounds` and
`MLS decryption failed at exactly its own epoch ... msg_epoch=12 group_epoch=12`.

**Same-epoch `SecretReuseError` means the generation was already consumed, which means this device
already decrypted that frame.** So the verdict is a false alarm, and it is the loudest line the
history replay has: the harness's severity rule fires on it, and its reader is being taught to skip
the one line that would name a real loss.

The ledger that should prevent it is `seenCipherHashes` (`utils/chat/history.ts`), which IS durable -
localStorage, capped at 5 000 - and the unreadable path does `seenCipherHashes.add(rowKey)` before
warning. But the save is a THUNK returned to the caller and committed only "AFTER the encrypted
checkpoint flush", deliberately, so the cursor never runs ahead of the persisted ratchet. **A session
that ends before that flush keeps the accusation and loses the record of having made it**, which is
exactly what five cold starts manufacture.

Two things are owed before a fix: whether the thunk is reached at all on these runs, and where the
duplicate delivery that reaches the decryptor comes from - `[QUEUE] delivery ... arrived twice`
(**seen four times on 2026-09-05, and the three new ones narrow it**: TAB-3b, then HEAL-REVOKE-9 and
HEAL-REVOKE-2 on a device that had just been WIPED and logged back in, then HEAL-REVOKE-3 on a device
FRESHLY MINTED and never revoked at all. So it is not the tab-leadership path TAB-3b exercises - one
tab reproduces it - and it is not revocation either: **what the three have in common is a client with
an EMPTY store pulling a backlog it has never acknowledged before**, which is where an ack still in
flight has the most rows to race. On each of those three rows, once the row's own noise was named, it
is the ONLY dirt left, so this one line alone holds three cells at `PASS-DIRTY`. **It is deliberately
forgiven on none of them**: a row made clean by widening a needle is worse than one reporting
honestly, and a defect costing three cells is easier to justify fixing than one nobody can see)
recognises one class of duplicate and acknowledges it without decrypting, so this one took a
different path. **A race that heals cleanly is still a defect**, and this one heals by asking the
peer for history it already has.

### P2 - the leader tab does not render a message the follower tab sent, until it re-reads (measured 2026-09-05)

TAB-4b: with two tabs of one account open, a message sent from the SECOND tab renders there, reaches
the peer, and does NOT appear in the first tab - `counts.tab1: 0`, against `tab2: 1, peer: 1`. The
reverse direction works (TAB-4c measured `tab2: 1` for a message sent from the first tab), and an
inbound message reaches both (TAB-4a). It is not loss: a reload of the leader shows it, so the row IS
persisted - measured directly, the message survives closing the follower and reloading.

What is missing is a live fan-out. `tabMessageSync` carries three events - `outbox_flush_request`,
`outbox_entry_sent`, `outbox_entry_cancelled` - and the second is a STATUS echo: the follower uses it
to settle a row it already shows (`patchStatus` needs `findMessage` to succeed). There is no
"a message was composed" event, so the sibling tab has nothing to render from. The symmetric fix is
one more event carrying the optimistic row; the throttle question is whose copy wins if both tabs
hold one.

The row does not assert it - TAB-4b expects the sending tab and the peer - so this is recorded rather
than failing a cell.


### P1 - twelve of sixteen messages were FETCHED AND DROPPED, and the commit log has a PERMANENT HOLE at epoch 121 (measured on prod 2026-09-02)

**Reported by the user as an impression - *"j'ai l'impression de n'avoir qu'une petite partie des
messages qu'il m'envoie"* - and it is exact.** DM `7da231f8-119c-4ce2-884f-55f5c94c903f`, created
2026-08-27, two members (`d82cd226...` / `0acc3ab9...`), not deleted, `activeEpoch` 130.

**What was sent, against what the phone shows** (Paris time; server rows are UTC + 2):

| When | Sent by the peer | Displayed on the Android phone |
| --- | --- | --- |
| 30/08 15:11 | 1, from his iPhone | **0** |
| 02/09 10:44 | 6, from a `pending` web device | **0** |
| 02/09 11:28 | 2, from his iPhone | 1 |
| 02/09 13:10-13:11 | 7, from his iPhone | 3 |
| **total** | **16** | **4** |

**Twelve is a FLOOR, not a total.** `queued_message` is a queue, so only sends still holding an
undelivered copy on one of the four stale web sessions can be audited at all - nothing before 30/08
is measurable. The phone FETCHED all sixteen: its queue for this group is empty, it is `active`, and
it was still being fanned to in other groups at 11:16 the same day. **Every loss is therefore after
the fetch.**

**The ciphertexts are still on prod** (`proto` non-null, 3-4 copies each, in the web sessions'
queues), and they are NOT recoverable through them: [group.rs](../../frontend/mls-core/src/group.rs)
sets `max_past_epochs(2)`, so only the 13:10 batch (epochs 129/130) is still inside the phone's
retention window and two further commits close it for good. The one path that recovers them is the
diff against the peer's iPhone, which holds the plaintext.

**FOUR DEFECTS, ALL FOUR FIXED 2026-09-02 - and the entry stays open, because the fixes stop the
NEXT loss and recover none of these twelve.** (C) and (D) each lose messages on their own, (A)
strands a device at an epoch nothing can ever refill, and (B) turned all three into a timeout instead
of an answer:

- **(A) THE CATCH-UP LOG IS BEST-EFFORT WHILE THE EPOCH ADVANCE IS AUTHORITATIVE, and that is why
  epoch 121 does not exist.** `mls_commit_log` for this group runs 0..129 with **121 missing**:
  epoch 120 committed 31/08 16:00:12, epoch 122 on 01/09 02:29:46. `IDX_mls_commit_log_group_epoch`
  is UNIQUE on `(groupId, baseEpoch)`, so **nothing can ever fill it**, and any device stopped at 121
  is stranded for the life of the group. The cause is the commit path in
  [messaging.service.ts](../../apps/chat-delivery-service/src/services/messaging.service.ts): the
  comment claims the insert happens "UNDER THE LOCK (atomic with the advance)", but it sits OUTSIDE
  the `transaction(...)` that advanced `activeEpoch` four lines above, wrapped in `try`/`catch` ->
  `logger.warn`, with the reasoning spelled out - *"Storing is best-effort: a failure must not undo
  the accepted epoch advance."* **The inversion IS the defect**: the record that makes the advance
  survivable for every other device is optional, while the advance is not. And `if (body.proto)` is a
  SECOND path to the same hole - a commit carrying no `proto` advances the epoch and records nothing
  at all, without even the warning.
  **FIXED 2026-09-02.** The insert is inside the `transaction(...)`, so the advance and the record
  that makes it survivable share one fate, and a commit carrying no `proto` is refused with a 400
  before anything moves. A rejected commit costs the committer one round-trip, a lost one costs the
  conversation. Two tests in `messaging.commit-log.spec.ts`: a rejecting insert fails the whole
  commit and fans nothing out, and a protoless commit advances no epoch.

- **(B) `getCommitsSince` ANSWERS "IS THE FLOOR TOO HIGH" AND IS ASKED "IS THIS REPLAY APPLICABLE".**
  Same file. It computes `belowFloor` for a gap at the START and returns every row at or above
  `sinceEpoch` untouched. A hole in the MIDDLE passes that check: a device at 120 receives
  `[120, 122, 123, ...]`, `belowFloor` is `false`, and
  [commitReplay.ts](../../frontend/src/lib/utils/chat/commitReplay.ts) applies 120, fails on 122,
  breaks, and returns `healed=false`.
  **This is NOT a permanent stranding and the first draft of this entry wrongly said it was**: the
  group stays in the epoch-gap registry, and `sessionWatchdogs.ts` forces the forget + re-Welcome
  once `STUCK_EPOCH_GAP_MS` has passed. So the hole is survivable - **by a CLOCK**, after a failed
  decrypt, a wasted round-trip and a frozen outbox, when the server could have said so in the
  response it was already writing. That is the rule about never learning by failing what a fact could
  have told you, and a termination that is a budget rather than a proof.
  **FIXED 2026-09-02.** `getCommitsSince` walks for contiguity from `sinceEpoch`, truncates at the
  first hole and names it as `gapAt` - from either end, a hole in the span or a log stopping short of
  `activeEpoch`. `belowFloor` suppresses it, PRUNING and a HOLE being different defects and only one
  of them accusing anybody. `attemptCommitReplay` treats `gapAt` as terminating and applies nothing;
  `setupMessageHandler` escalates to rung 2 on that proof instead of after `EPOCH_GAP_ESCALATION_MS`,
  which is where the frames arriving during those 30 s were being ACKed and dropped.

- **(C) A SEND FROM A `pending` DEVICE IS ACCEPTED AND FANNED OUT TO EVERYONE.** `status = 'active'`
  gates recipient resolution twice in that file, and nothing gates the SENDER. The peer's
  `web-...-mtbep8vs-5oxb` is `pending` in this group - registered 2026-08-27, still holding two
  undelivered Welcomes queued 02/09 at 11:07 and 11:10 - and it sent six messages between 10:44:20
  and 10:44:44 that were fanned to five devices: **30 rows of ciphertext nobody in the group can ever
  open**, the device not being in the MLS tree. The server held the discriminator at the moment it
  accepted them, which is the rule about never learning by failing what a fact could have told you.
  **FIXED 2026-09-02.** `sendMessage` reads the sender's own membership row before resolving any
  recipient and answers `403 sender_not_active` with the status, so the client learns the fact the
  server already held. Handshake frames (Welcome, Commit) are exempt - they are the path OUT of
  `pending`, and refusing them would make the gate a deadlock. A missing row is logged, not refused:
  that is an external join in flight.

- **(D) A DEVICE EMITS APPLICATION MESSAGES BETWEEN ITS OWN COMMIT AND THAT COMMIT'S ACCEPTANCE.**
  Measured to the millisecond, `mls_commit_log` against `queued_message`:

  ```
  13:10:43.234  commit baseEpoch=128
  13:10:43.270  message                 36 ms later
  13:10:44.302  commit baseEpoch=129
  13:10:45.120  message
  13:10:47.480  message
  13:10:51.901  message
  13:10:53.965  message
  13:10:58.783  message
  13:11:00.750  message
  ```

  Seven messages racing two epoch advances the peers cannot have applied yet; three arrived, four did
  not. A race that heals cleanly would still be a defect, and this one does not heal.
  **FIXED 2026-09-02.** [epochSendBarrier](../../frontend/src/lib/utils/chat/epochSendBarrier.ts):
  a frame is encrypted AND on the wire before a local commit starts, or it is encrypted after that
  commit merged. There is no third ordering and no clock in it. The barrier is raised only under the
  MLS mutex, which is what makes it deadlock-free - a send that observes it provably does not hold
  the mutex the advance needs. The overlap is deleted rather than reconciled: a re-encrypt-on-stale
  retry would have been a race that heals cleanly, which is still a defect.

**WHICH ARM OF `process_message` DROPPED THE 13:10 FOUR IS NOT ESTABLISHED, and the logcat cannot say
retroactively.** The buffer on the Pixel 6a spanned 08-31 17:57 to 09-02 14:40, but the app's OWN
lines reached back only to 14:33 - the 13:10 window was already gone. Settling it needs a reproduction
with `clearLogcat()` first, through
[phone.mjs](../../tools/cross-client-harness/phone.mjs) (`console_`, `clearLogcat`) and the tag list
in [verify-on-device.py](../../tools/android/verify-on-device.py) (`LOGCAT_TAGS`). **Do not write a
fix against a suspected arm** - the candidates in
[messaging.rs](../../frontend/mls-core/src/messaging.rs) are the epoch-gap fast-fail, the past-epoch
application arm and the same-epoch refusal, and they carry different fixes.

**And the UI asserts the opposite of the truth**: "Infos de la discussion" shows a green shield
reading "SÉCURISÉ & SYNC" on this conversation, with twelve messages gone. A device that dropped an
application frame must say so there.

**WHAT IS STILL OPEN, none of it closed by the four fixes:** the twelve messages themselves, whose
plaintext exists only on the peer's iPhone; the hole at epoch 121, which is permanent by construction
and now merely *survivable at once* rather than after 30 s; the arm of `process_message` above; the
green shield below; and the two entries after this one, which are what would have named all of it
without a user's impression.

**State left on prod: NOTHING was modified.** The four stale web sessions still hold 87 undelivered
message rows since 30/08, one of them (`web-...-mtd1d1fc-m84y`) 96 commits behind and therefore
permanently stuck below the 121 hole. The peer's second iPhone (`tauri-...-mtc0al5c-9hny`) has been
`pending` since 2026-08-27 with zero one-time KeyPackages - the same signature as the Welcome livelock
P1 below, and the two want reading together.

---

### P2 - nothing measures a RE-KEY RATE, and nothing would ever report a HOLE in a commit log (2026-09-02)

**129 epochs in six days on a TWO-PERSON DM, and no mechanism said a word.** Group `7da231f8` above:

| Window | Epochs | Committer |
| --- | --- | --- |
| 30/08 02:43 -> 03:31 | 89 -> 104, **16 commits in 48 minutes** | one web session |
| 30/08 04:22 -> 06:36 | 105 -> 116, 12 commits | the Android phone |
| 31/08 -> 02/09 | 118 -> 129, 12 commits | both peers |

Every commit is a re-key, every re-key is an epoch a lagging device must cross, and this churn is what
makes the P1's four defects fire at all. Nothing counts commits per group per hour; nothing counts
sends that are undecryptable by construction (defect C produced thirty such rows in 24 seconds); and
nothing detects a gap in a commit log - one `GROUP BY` would have named epoch 121 on 31/08.

**Owed:** a counter on the fanout for undecryptable-by-construction sends, and two lines in the hourly
report - commits per group per hour, and any hole between `min(baseEpoch)` and `activeEpoch - 1`. A
correct mechanism with no report is found by hand a day late; this one was found by a user's
impression, four days late.

---

### P3 - the phone prints eight warning lines a minute that mean nothing, and polls presence every ten seconds (measured by logcat 2026-09-02)

Read off the Pixel 6a with `adb logcat` - 147 app lines over seven minutes of an otherwise idle
session:

- **56 occurrences of `[WS RCV] frame type "pong" reached no handler - the server is sending
  something this client does not route (see channelEventTypes)`**, at **W** level. A keepalive pong is
  expected and needs no handler, so the line is the visible end of either a server routing it as a
  payload frame or a client that should consume it silently. At WARN it pollutes exactly the level a
  reader scans for real defects.
- **45 `GET /api/presence` in seven minutes** - one every ten seconds, on a mobile client that already
  holds a live WebSocket. A clock where a push belongs, and it costs battery and data on every phone.

Both fall under the rule that noise is never acceptable: a line is either expected AND necessary, or
it is the visible end of something upstream. The first is also part of why the P1's 13:10 window was
no longer in the buffer when it was needed.

---

### P2 - a device holds a distribution group the group holds no row for it, and heals by rejoining (measured 2026-08-29)

**Handed back by HEAL-NEW-15's branch on `038c7e8d`, deliberately unacted on because its blast radius
leaves that row.** Sixty seconds after external-joining the community distribution group `315b8a1d`
at epoch 56, the fresh device logged:

```
this device holds the distribution group but the group holds NO row for it (3 device(s) for this user)
 - the local group is stale, rejoining
```

and joined again at epoch 57. **A race that heals cleanly is still a defect**: if the mechanism needs
a heal in THEORY it is wrong whatever it does in practice, and the thing to find is what makes the
two paths overlap, not to admire the repair.

**Two facts from the same run belong with it and may or may not be one cause.** `315b8a1d` is the
ONLY group of eleven the reconciliation did not ask about - `reconciliation pass complete - 10/11
group(s) asked in 794 ms` - and it is also the only group that was external-joined twice, at 56->57
and 57->58, both before the late responder arrived. Whether the skipped reconciliation is a
CONSEQUENCE of the membership row being absent, or a second symptom of the same stale local state, is
undetermined and is the first question to ask. **Do not assume the correlation is causation**; one
`GROUP BY` over `dm_device_group_memberships` for this device and this group settles which row
existed when.

**RECURRED ON BOTH ROWS OF THE 2 / 12 PAIR, same build `038c7e8d`, so it is not a one-run
coincidence and the population is "every freshly minted device", not "a device that waited for a late
peer".** Stamps, which is all these two rows owe it: row 2 logged the stale-group line at 15:09:47
and `externalJoin succeeded for 315b8a1d...` at 15:09:48; row 12 logged both at 15:14:31. In both,
the community is `fbddc890` and the device count in the line is 3. **Two of the reading conditions
differ from row 15's and rule nothing out:** each of these rows external-joined `315b8a1d` TWICE and
no conversation group at all, and the reconciliation asked 0 of 1 and 0 of 2 rather than skipping one
of eleven - so the "only group the reconciliation did not ask about" correlation cannot be tested at
this fleet size and is neither confirmed nor refuted here.

**RECURRED ON A DIFFERENT RUNG, AND THE DEVICE COUNT IS NOT A CONSTANT.** HEAL-REVOKE-5 on
`96bdd1bb`, 2026-08-29: the wipe window logged the line at 23:00:52 with `(3 device(s) for this
user)` and the reference device logged it at 23:02:55 with `(2 device(s) for this user)` - **two
different counts in ONE run, two minutes apart**, tracking the live device population as devices were
revoked and minted. So the `3` recorded above is not part of the shape and nothing should be read
into it; what is constant across every sighting is the community, `fbddc890`. The population is
therefore wider than "every freshly minted device": a device that RETURNS from a revocation wipe
produces it too, which is a second rung and a second build. Not chased here, per the row's brief.

### P2 - a membership is REFUSED for want of a KeyPackage one second after the device external-joined that very group (measured 2026-08-29)

**It heals, and by the standing rule that is still a defect:** a race that needs a heal in THEORY is
wrong whatever it does in practice, and a ledger that reconciles the two paths afterwards is a
witness, never a fix.

Seen twice in HEAL-NEW-15's run on `dc8bf000` / runner `56090443`, on a device that had been minted
seconds earlier: the client logs `externalJoin succeeded` for a group, and roughly one second later
the server logs `[MEMBERSHIP_ACTIVE] REFUSED ... reason=no_key_package` for the SAME group. The
membership goes active shortly afterwards, so no row went amber for it and nothing in the sidebar
records that it happened.

**What has to be named before a fix is written** is which of the two orderings is the real one - a
KeyPackage published after the external commit, or an activation read that runs before the
publication it depends on has committed. The two are indistinguishable from the refusal line alone,
and this is the second time on this rung that a `no_key_package` refusal has meant something other
than what it said (see the entry below, where it meant the device cap). The discriminator is the
publication's own timestamp against the refusal's, both of which exist.

**It cost nothing here** because W1 was online and serving; the concern is the population where
nothing is. Nobody has measured how often it happens outside this rig.

**RECURRED ON BOTH ROWS OF THE 2 / 12 PAIR, on `038c7e8d`, and the refused group is the SAME ONE the
entry above is about.** Row 2: `[MEMBERSHIP_ACTIVE] REFUSED group=315b8a1d... reason=no_key_package`
at 13:09:20, then `[MEMBERSHIP_ACTIVE] group=315b8a1d...` at 13:09:47 - 27 s. Row 12: refused
13:13:36, active 13:14:31 - 55 s. **In both, the group is the community distribution group and NOT a
conversation**, and in both the client external-joined that same group twice and logged the stale
local group of the entry above within a second of the activation. Two P2s, one group, one second
apart, twice: **treat "are these one defect" as the first question, not two independent
investigations.** The discriminator both entries name is still unmeasured - the KeyPackage
publication's own timestamp against the refusal's.

**RECURRED ON HEAL-REVOKE-5, `96bdd1bb`, 2026-08-29 - same group `315b8a1d`, on the SEED device, at
21:00:41.** This sighting cannot measure the interval the entry asks for: **no `[MEMBERSHIP_ACTIVE]`
line for that device appears in the window at all**, and that is explained by the ROW rather than by
the defect - HEAL-REVOKE-5 revokes the seed roughly ninety seconds later, so the activation had no
opportunity to happen. Recorded so the absence is not later read as a refusal that never healed. The
population now includes "a device minted as a revocation row's seed", which is a third rung.

**And on those two rows the refusal was invisible from the client half.** `healnew.mjs` records only
`observers: { w3 }`; the server window is taken by `run.mjs` per PASS and printed, not written to the
ledger row - so `bun rows.mjs` and every HEAL-NEW cell are silent about it, and it was found by
reading the run's stdout. Nothing here is wrong, but a HEAL-NEW verdict says "clean on the web
client", never "clean on the server".

### P1 - a device asks for a Welcome for ever, and the member that answers RESETS the row that would have let it heal itself (measured on prod 2026-09-01)

> **A FIFTH HALF WAS FOUND ON 2026-09-04 AND FIXED THE SAME DAY, AND IT IS THE ONE THAT MADE THE
> OTHER FOUR UNREACHABLE FOR PART OF THE POPULATION.** Everything above negotiates what a `pending`
> row MEANS; none of it runs for a device whose local WASM still holds the group, because
> `requestReAdd` returns at its `holdsGroupState` guard before any of it is read, the connection sync
> and the SYNC_WATCHDOG both skip such a group, and the watchdog additionally calls `cancelReAdd` on
> it every 5 s. The outbox held the only proof - the server's own `SenderNotActive` - and merely
> logged it. `recoverRosterDisagreement` now converts that proof into the forget the guard asks for
> and re-enters the seam. Measured end to end on the local estate: refusal at 18:28:34, rejoined by
> external commit and the held message sent at 18:28:37, `MEMBERSHIP_ACTIVE` in the server log. Story
> in `CHANGELOG.md`, rules in [durable-rules](durable-rules.md), residual scope in the P2 below.
>
> **ALL FOUR ARE FIXED, 2026-09-04. WHAT IS LEFT IS ONE MEASUREMENT ON PROD AFTER THE RELEASE THAT CARRIES THEM.** `pending` no longer decides anything on its own: the endpoint answers per row with
> `welcomeQueued` and `addInFlight`, a device owed nothing serves itself an external-commit join and
> clears its own seat. **The residual window (A) was not allowed to ship without is closed by
> `addInFlight` - the group's `mls:addlock:<groupId>` held right now - and NOT by the inviter's own
> refusal as this entry proposed**: the lock is held for the whole of the `registerMember` ->
> `addMembersBulk` interval, which is exactly the interval in which the queue is legitimately empty,
> so it needs no second party to answer and no new failure to classify. **It was reproduced first**,
> on the local estate on four groups with the production signature line for line, and then measured
> twice green - two fresh devices each joining all four groups in the same second, rows promoted,
> epochs advanced, fresh bases republished. Tests:
> `invitations.controller.device-memberships.spec.ts` (6) and `recovery.test.ts` (21).
> **(C) IS FIXED TOO, AND ITS CAUSE WITH IT.** The `stale_base` arm no longer asks for a Welcome - it
> asks for a republish, which is read-only, takes no lock and changes no epoch. But the ask was the
> band-aid: the CAUSE is that a base is minted only as a fire-and-forget follow-up to a commit
> (`void refreshGroupInfo`), whose own comment already said the loss was permanent. Measured across
> prod that day: four of forty-three bases stale, every one by EXACTLY ONE epoch. Any holder now
> repairs a stale base on the read it already makes on every connection
> (`GET /mls/users/:id/groups` carries both epochs), one implementation in `staleBase.ts` shared with
> the distribution-group repair, 11 tests validated against three silent mutations. **So the
> `4f87267a` base this entry has been waiting on since 2026-08-30 gets a cure it never had** - it
> heals the next time any member of that group connects, with nobody asking.
>
> **(B), the same day, because (A) made it worse rather than better.** `kickStaleLeaf` cleared the
> routing row whether or not the leaf came out of the tree, and a `pending` row over a LIVE leaf now
> tells that device to external-join beside it - GRP-4 from the other side, the repair manufacturing
> the fault it cleans up. The row is cleared only when the tree is genuinely without the leaf, and
> "the leaf was never there" is a TYPE (`MlsError::NoSuchMember`) rather than a substring of an
> OpenMLS message, because it is the one refusal that means the caller's goal is already met.
> `groupActions.kickStaleLeaf.test.ts` (5) pins the order and was validated in negative against the
> unfixed function; `roster_removal.rs` pins the variant and that the tree is untouched.
> **The `4f87267a` base is a separate matter and is still stale on prod.**


**A LIVELOCK, NOT A WAIT: each side re-creates the other's precondition, and it ran for 20 HOURS on
the owner's own account.** Reported from the web client 2026-09-01: three conversations stuck on the
`SYNC` badge for ever, `[READD] ... throttled` printed every 5 s for each, while the SAME
conversations were healthy on the reporter's phone. Nothing was broken server-side - no tombstone, no
missing roster row, no revocation - and the recovery loop was running exactly as designed.

**The evidence, all of it read on prod before any code was written:**

| Fact | Value |
| --- | --- |
| the enrolling device | `web-d82cd226...-mthfj460-44v8`, first membership rows written 2026-08-31 `16:05:10.586028` |
| its 12 group memberships | **9 went `active` within 3 s**; **3 stayed `pending`** at the registration instant and were never touched again |
| `queued_message` for that device | **0 rows, for any group, at any point** - no Welcome was ever queued for it, before OR after the repair attempts |
| `mls_group_info` for the 3 | present for all three: baseEpoch **283**, **279**, **286** |
| `key_package` / `revoked_device` | one fresh KeyPackage, no revocation - the device was addable throughout |
| `one_time_key_package` | **0** - the same spent-pool hypothesis as the P2 below, still untested |

**THE EXPERIMENT THAT SETTLED THE FIRST CAUSE.** The three `pending` rows were flipped to `active` by
hand at `10:09:37` (an allowlisted UPDATE on that one deviceId, `status = 'pending'` only). Within
90 s, two of the three healed with no peer involved at all:

```
10:10:31  COMMIT bee389a8 baseEpoch=286 -> base published with the commit -> epoch=287 ACCEPT
10:10:31  COMMIT 6e7c9ab1 baseEpoch=279 -> base published with the commit -> epoch=280 ACCEPT
```

So the device could have freed itself at any moment in those 20 hours, and exactly one `if` forbade
it. **That is proof on pieces rather than by reasoning, and it is what makes this a P1 rather than a
suspicion.**

**THE CLOSED LOOP, on the third group (`4f87267a`), read line by line in the delivery log:**

```
10:18:37  WELCOME_REQ FORWARDED -> tauri-...-mtd1qgu3-vnde     the phone receives it
10:18:37  ADD_LOCK    acquired=true                            it takes the lock
10:18:38  [KICK] Reset device web-...-mthfj460-44v8 to pending  it evicts the stale leaf AND RESETS THE ROW
10:18:42  RELEASE_LOCK released=true                            it releases
          (no Welcome queued, no commit - the Add never lands)
10:18:45  WELCOME_REQ FORWARDED -> the same device              and round again
```

`kickStaleDevice` writes `pending` BEFORE knowing the Add will land, and `pending` is precisely what
forbids the requester's self-service external join. **Every turn of the repair destroys the only state
from which the requester could have saved itself**, and the requester's next request re-arms the
repair. Neither side is idle and neither side is wrong on its own terms.

**AND THE ESCAPE HATCH IS LOCKED FROM THE OTHER SIDE on that group**: `mls_group_info` holds baseEpoch
**283** while the group is at **284**, published 2026-08-30 `04:36:47` and never refreshed. The server
says so itself, once a minute - *"the published external-join base is unusable and only a member
holding the tree can refresh it"*. Only a member's COMMIT republishes a base, which is literally what
repaired the other two groups; `4f87267a` has had no commit since. So even with the gate corrected,
that group cannot external-join until somebody commits into it.

**FOUR DEFECTS, each independently sufficient to make the loop infinite:**

- **(A) `pending` is a STATE read as an EVENT.** `readWelcomeOwed` returns "an Add is IN FLIGHT and a
  member owes me a Welcome" on the strength of the row's status alone
  ([recovery.ts](../../frontend/src/lib/utils/chat/recovery.ts), step 6), so `requestReAdd` never
  reaches the external join. The gate itself is legitimate - it is what deleted the GRP-4
  duplicate-leaf race of 2026-08-26 - but it cannot tell "in flight for 200 ms" from "registered
  yesterday and never honoured". **The fact that separates them already exists and is already
  computed, server-side, hourly, by `reportStrandedDeviceMemberships`: is a Welcome actually queued
  for THIS device and THIS group.** It is simply not carried to where the decision is made; adding it
  to the existing `GET /api/mls/device-memberships/:userId/:deviceId` response costs no round trip.
  **The residual question a fix must answer: between `registerMember` and `addMembersBulk` the queue
  is legitimately empty while an Add really is in flight**, so the queued-Welcome fact alone re-opens
  GRP-4 in that window - which is why the inviter's own refusal (the P2 below) is the discriminator
  that closes this properly, and why (A) must not ship as a bare `&& welcomeQueued`.
- **(B) A destructive repair is not gated on the repair succeeding.** The `[KICK]` writes `pending`
  first and attempts the Add after. This is the invariant established the same morning by `f46e7660`
  - **a field written ONCE, after every prerequisite, cannot lose a race for it** - applied to the
  function next door, for the third time in this area. Write the row when the Add lands, or not at
  all. This is the P1 half: it is what turns a failure into a loop.
- **(C) On `stale_base`, the wrong favour is asked.** `requestReAdd` falls back to a `welcome_request`
  for every external-join refusal, including `stale_base` - a reason no retry can ever satisfy. A
  Welcome MUTATES the tree, needs the add lock, and replays the race; refreshing the base is a
  read-only publish by any member holding the tree, needs no lock, changes no epoch, and hands the
  requester back its ability to serve itself. `stale_base` is already classified at the throw; it
  wants its own action, not the shared fallback.
- **(D) The failing `addMember` was reported NOWHERE - FIXED 2026-09-04.** It is swallowed on the
  answering device (a phone), and server-side the row a failed re-add leaves is byte-identical to the
  row of a device whose KeyPackage was skipped and which was never in the tree at all: one footprint,
  two opposite causes, two opposite fixes. `dm_device_group_memberships.kickedAt` is the evidence the
  report was missing - written by the two kick endpoints, cleared by the three writes that answer the
  question the other way (a Welcome queued, or the device marked `active`), and NOT by a demotion,
  which is cleanup and promises no Add. `reportStrandedDeviceMemberships` prints the halves apart:
  *never added* at WARN, *kicked with no re-add* at **ERROR**, dated by the kick rather than by the
  row. It is deliberately not a second `updatedAt`, which moves for every write. The write sites have
  their own spec (`invitations.controller.kick-marker.spec.ts`, 5) because a kick that forgot to stamp
  would make the ERROR half count zero for ever and read as health; the report's split is pinned by 4
  more in `app.controller.stranded-memberships.spec.ts`, validated against two mutations. **It cannot
  be backfilled**, so the first passes report the standing backlog as *never added*.

**Two more, same session, lower severity but in the same seams:**

- **The key-vs-id audit that `f46e7660` did not finish.** That commit fixed three lookups in
  `recovery.ts` and the watchdog and wrote the rule *treat any `[key]` destructuring over a
  heterogeneously-keyed map as a defect on sight* - but never enumerated the consumers. Still reading
  the map by groupId, in a store where a DM learnt from a Welcome is keyed by the PEER'S USER ID:
  `processPendingInvitations` (the readiness gate deciding whether an Add is even attempted),
  `handleWelcomeRequest` (the *"No ready conversation - deferring"* branch, which would decline every
  such request in silence), the history-serving gate, `recovery.ts` in the promotion after a
  SUCCESSFUL external join - which would leave the `SYNC` badge on for ever on a conversation that
  has actually rejoined - and `setupMessageHandler.ts` on the redelivery path. **Unproven as the cause
  of anything above**, the phone's logs not being available, but a defect on sight by the repo's own
  rule.
- **The throttle logs its silent branch.** `[READD] ... throttled` prints on every 5 s poll against a
  60 s cooldown: 12 lines per group per window, on a branch whose own comment says the throttle
  *"returns silently"*. Three stuck conversations made 36 lines a minute, which is what the reporter
  actually saw.

**STATE LEFT ON PROD, 2026-09-01 ~10:20 - a resuming session must not re-derive this:**

- `bee389a8` and `6e7c9ab1`: **healed and `active`**, joined by external commit at epochs 287 and 280.
- `4f87267a`: **still `pending`** (the `[KICK]` of `10:18:38` undid the manual flip) and **its base is
  still stale at 283/284**. It will not heal until a member commits into that group. Flipping the row
  again is pointless on its own - the kick resets it within seconds.
- The manual UPDATE is the only hand-write performed; nothing was deleted, and the fourteen-day purge
  still owns those rows.

**What closes this entry: ONE measurement on prod after the release that carries all four.** The four
stale bases at `activeEpoch`, `4f87267a` among them, taken with
`SELECT ... FROM mls_group_info gi JOIN dm_groups g ...` and no hand-written UPDATE - and one reading
of the hourly report's new ERROR arm, whose count is the first number anybody has for how often the
re-add after a kick fails. (A), (B), (C) and (D) all landed 2026-09-04; (A) already carries the
measurement this line asked for - a device reaching `active` by external join with no peer involved,
taken twice - and (C) was verified end to end on the local estate, four bases armed one epoch behind
and all four repaired within two seconds of a holder connecting. **Production is on `0.16.1`, two
stables behind, so none of this is deployed yet.** The cause of the skipped Add itself is the P2
immediately below, and the two want reading together.

### P2 - a device stranded on a roster seat is only discovered by TRYING TO SEND, so a silent reader stays stranded (measured 2026-09-04, alongside the fix above)

`recoverRosterDisagreement` closes the case where a device holding a group tree the server has no
leaf for **attempts to send**: the refusal is the proof, the outbox holds it, and the repair follows
in about three seconds. **Nothing detects the same device if it never sends.** It holds a
well-formed tree, shows a normal-looking conversation, and is refused nothing, because it asks for
nothing - while every frame the group produces is encrypted to a tree its leaf is absent from.

**The population is real and the server already counts it.** `reportStrandedDeviceMemberships` named
70 pending memberships past its window on this estate, 25 of them holding a roster seat with no
Welcome ever queued and no kick recorded, the oldest since 2026-08-27. The report says *"they
receive nothing and notify nothing"* - which is exactly the half a sender-side repair cannot reach.

**What would close it, and what would not.** A client-side timer that periodically re-asks is the
shape the durable rules refuse: termination would come from a clock, and the ask would be made by
the device least able to answer it. The fact is ALREADY authoritative server-side and already read
on a call every device makes on every connection - `GET /mls/users/:id/groups`, the same read
`staleBase.ts` repairs a stale base on. **Carrying the membership status on that row is the shape
that needs no new trigger**, and it is the move [durable-rules](durable-rules.md) names for the
sibling defect: *never let a repair need a trigger the mechanism does not already have*. That makes
this a server contract change plus one branch in the sync loop, which is why it is not inlined into
the session that found it.

**Do not close it by widening the sender-side seam.** The sender-side repair is correct and
sufficient for what it can see; the gap is a device that produces no evidence at all, and no amount
of classification at the send site can observe a send that never happens.

### P2 - a device was given a roster seat and never a Welcome, and WHY its KeyPackage was skipped is unmeasured (measured on prod 2026-09-01)

**The report is in; the CAUSE is not.** `reportStrandedDeviceMemberships` (hourly, chat-delivery)
now names every `pending` device membership older than an hour with no `queued_message` carrying
`isWelcome = true` for that device AND that group - see
[chat-delivery](services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart)
for the mechanism and the measurement. What it cannot say is why the inviter's `addMembersBulk`
dropped the device into `skippedDeviceIds` in the first place.

The sighting: a new DM on 2026-09-01, group `ab47add3`. The peer's phone
(`tauri-...mtd1qgu3-vnde`) got its pending row at `20:45:47.420` and no Welcome, while the account's
four other devices each got one. It stayed stranded **3 h 41**, healed itself by external join at
`00:26:54`, and republished its key package at `00:53` with 39 one-time key packages. The user
received the message on a web session (`mthfj460`, active at `20:45:48.309`) and got **no
notification on his phone** - which is the only reason anyone noticed.

**What has to be named before a fix is written**, and all of it is knowable:

- Which KeyPackage the inviter was handed for that device, and why WASM rejected it. `addMembersBulk`
  currently discards the reason with the device - `skippedDeviceIds` is a list of ids and nothing
  else, so the one fact that would classify this is thrown away at the only place it exists.
- Whether it is the last-resort KeyPackage or a one-time one. **All four of the peer's web devices
  showed 0 one-time key packages remaining** at the time, which makes a spent OTK pool the first
  hypothesis to test, not the conclusion - the phone's own pool is the number that matters and it was
  not read before the device healed.
- Whether the 3 h 41 is the external-join ladder's ordinary latency for a device in this state or a
  device that only healed because it happened to be opened. Nothing here paces that heal.

**THE 3 H 41 IS NOW BOUNDED, AND THAT CHANGES WHAT THIS ENTRY IS FOR (2026-09-04).** The heal at
`00:26:54` happened because the device was opened; nothing paced it, and its sibling P1 explains why a
device in that state could go 20 hours instead. With (A) fixed, a device holding a roster seat that
nothing follows joins on its next poll rather than when a human touches it - so the stranding is no
longer a user-visible outage and this entry loses its user-facing half. **What it keeps is the whole
of its question**: a skip that cannot name its own cause. The heal being fast does not make the Add
correct, and a device that external-joins every time is a device whose KeyPackage is being rejected
every time with nobody counting.

**THE POPULATION IS NOW EXACTLY THIS ENTRY'S, 2026-09-04.** The hourly report used to lump this
cause together with a device whose leaf a member kicked and failed to re-add - same footprint,
different fix. `kickedAt` separates them, so the WARN arm named *never added* is now this entry's
population and nothing else's, and its count is the number a fix has to move.

**Until the reason is typed, the skip is a count.** The rule that a skip printing a count cannot name
its own cause applies exactly: `warnSkippedKeyPackages` prints ids, and the two causes it collapses -
a genuinely unusable KeyPackage and a device whose pool is momentarily empty - want opposite fixes
(reject and re-mint, versus wait and retry). Carry the reason out of the WASM boundary alongside the
id, then the server report can partition on it instead of on the queue.

### P2 - a HEAL verdict says "clean on the web client" and never "clean on the server" (measured 2026-08-29)

**Instrument debt, and it qualifies every verdict this rung has taken.** `healnew.mjs` and
`healrevoke.mjs` record `observers: { w3 }` and nothing else. The server window IS taken - `run.mjs`
does it per pass and `srvlog.mjs` classifies it - but it is PRINTED, never written to the ledger row,
so `gate()` never sees it, `bun rows.mjs` cannot report it, and no cell on the board can say
anything about it either way.

**It is not hypothetical: both windows of the 2/12 pair were NOT clean**, and the `no_key_package`
refusal in the entry above was found by reading a run's stdout rather than by any mechanism the
campaign owns. A `PASS-DIRTY` on a HEAL row today means "the web console was dirty"; whether the
server's was is simply unrecorded.

**The campaign's own rule is that a pass is a pass only if its window is clean on web, on the phone
and on the server** - so until the third window reaches the ledger, every HEAL-NEW and HEAL-REVOKE
cell is carrying two thirds of a gate. It is the same class as the pre-gate re-runs owed by
HEAL-NEW-1 and -3, and it should be paid before the post-ladder sweep rather than during it.

### P3 - the mint's own refusal is not a verdict, so a full account throws instead of recording (measured 2026-08-29)

`becomeANewDevice` returns `{ refused: ... }` when the account is at the per-user device cap - the
guard added on 2026-08-28 so nothing is destroyed that cannot be rebuilt. `healnew.mjs` never reads
`minted.refused`: it goes straight on to use `minted.cx`, which is not there, and the row dies with
a TypeError instead of recording `INVALID` with the reason the primitive had already measured and
handed it.

**A blocked job is not a crashed one**, and this turns the one refusal the rig knows how to explain
into the least legible failure it can produce. Every HEAL-NEW row is affected, and it costs nothing
today only because the owner sits at 3 of 15 slots.

### P2 - a client at the DEVICE CAP still enumerates ten rows it can never join

**A rendering-honesty question rather than a mechanism**, and a P2 rather than a P1 because nothing
is silent any more: the refusal is logged with the count it read, the user is shown
`chat_device_limit_reached` naming the device list to open. What is left: ten conversations
that can never become ready still wear the "Sync" badge, because the sidebar is enumerated from the
server's group list and every row starts `isReady: false`. The toast explains the cause once; the
rows keep claiming a repair is in progress for as long as the device stays refused.

**Everything below is the original measurement, kept because it is the evidence, not the plan.**

**This is the user's own HEAL report, mechanised.** They described adding a device and finding
conversations wearing the "Sync" badge, some repairing and others not. That is exactly the state a
device reaches when its KeyPackage publication is REFUSED: the sidebar is enumerated from the
server's group list, every row starts `isReady: false`, and nothing can ever move them because the
device is not addressable.

**THE MEASUREMENT.** A device minted on prod at 10:22, on a fresh profile of an account holding
fifteen devices:

```
POST /api/mls/register-device -> 400
[KP] Publication failed (Error: Failed to publish KeyPackage: 400 ) - welcome_request deferred to next connection
[SYNC] 7da231f8... absent - welcome_request deferred (KP not published)      (x10, one per group)
```

and on the server, for every one of the ten groups:

```
[MEMBERSHIP_ACTIVE] REFUSED group=... device=...  reason=no_key_package
```

`registerDevice` counts `key_package` rows inside `RETENTION_WINDOW_MS` and throws
`BadRequestException` at `MAX_DEVICES_PER_USER` (15) - **before** it logs `[REGISTER_DEVICE] START`,
which is why the server's own trace shows nothing for the device at all. The cap is deliberate (audit
M5) and is not the defect.

**THE DEFECT IS THAT THE CLIENT CALLS A PERMANENT REFUSAL "deferred to next connection".** A 400 here
is a statement about the ACCOUNT, not about this attempt: no reconnection, no retry and no amount of
waiting will change it, and the user is never told the one thing that would fix it - delete a device
in Settings. The server's message already says so and is thrown away. A fallback is a signal, never a
path: the retry loop here is a path, and it is silent.

**WHY IT IS NOT ONLY OUR TEST ACCOUNT.** Two accounts on prod are at exactly 15 on 2026-08-28: the
campaign owner (its own debris, since purged to 2) and one REAL user, whose oldest device dates from
2026-07-21. Their next device will be refused the same way, and nothing will tell them.

**WHAT A FIX MUST DO**, in the order that matters:

1. **Classify at the throw, not on the message.** A 400 from `register-device` is terminal; a 5xx or
   a transport failure is retryable. The publication path currently treats every failure as the
   second kind. The discriminator is the status code, which is already there.
2. **Say it, once, where the user is.** The refusal is the answer to "why is everything stuck on
   Sync", so it belongs on the sidebar state, not in a console line - and it needs a Paraglide
   string, with the action (`Settings -> Devices`) in it.
3. **Do not enumerate what cannot be joined.** Ten rows that can never become ready are ten rows
   claiming a repair is in progress. Whatever the UI decides to show, the honest state is not "Sync".

**MEASURED SO IT IS NOT RE-DERIVED:** with a slot free, the same profile publishes its KeyPackage in
**1.9 s** - so slowness was never the story, and neither was the wipe.

**WHAT IT COST THE CAMPAIGN, recorded because the lesson is the reusable part.** The rung's own
sixteen HEAL-NEW rows each mint a device and abandon it, so the cap was reached by construction, and
five rows then reported that a wiped profile does not publish - a phantom product defect written into
this file overnight. `newdevice.mjs` now asserts the account has a slot BEFORE it wipes anything, and
purges the id each mint abandons.

### P1 - a client on the LOCAL estate says the roster and the tree disagree, and it cannot send at all (measured 2026-09-04)

**THE CLASS IS REPRODUCING, AND THIS TIME A CLIENT SAYS SO IN ITS OWN WORDS.** The entry below asks
whether a stale seat leaves a LEAF behind and notes that no server query can answer it. On the LOCAL
estate, W1 now answers it out loud - the DM group `2bd5add9-2a1b-4b25-829b-4114146c3ab5`:

```
POST /api/mls/send -> 403
[OUTBOX] REFUSED by the server: this device holds no leaf in 2bd5add9... while the local MLS
         state says it is a member - the roster and the tree disagree, and only a Welcome or an
         external commit lifts it
SenderNotActiveError: This device holds no leaf in group 2bd5add9-2a1b-4b25-829b
```

**W1 cannot send anything into that DM.** Four entries sit in its outbox, two at attempt 6 backing
off ~50 s. `queued_message` has no row for any of them, so nothing reached the server. The app
renders the bubble optimistically, so **the screen shows a conversation that looks fine.**

**PROVENANCE: MOST LIKELY SELF-INFLICTED, AND THAT IS THE HONEST READING.** A PIN reset was performed
on A1 at 15:32 the same day (authorised; the accounts are throwaway). A reset re-keys the ACCOUNT, and
W1 kept a device identity minted under the old one - so W1's local MLS state still claims membership
while the tree the server holds no longer carries its leaf. That is exactly the sentence the client
prints. **This entry therefore does NOT establish a spontaneous product defect**, and must not be
cited as one.

I got this wrong first and the user corrected it. I had checked W1 after the reset, seen no PIN gate
and an `mls_device_id` present, and concluded "the risk did not hold" - **I measured the absence of a
gate, not the validity of the key.** A client whose persisted device key is stale shows no gate at
all: `canari_device_key_persist` is a five-character flag and the key material is in IndexedDB, so
nothing on the surface distinguishes a live device from a dead one. **"No gate" is not "healthy", and
the only thing that tells them apart is trying to send.**

**The rule that leaves:** a PIN reset invalidates EVERY OTHER DEVICE on that account, silently, and
the campaign's fixture step must be redone for all of them rather than for the device that was reset.

**What it already proves regardless:** the product's own diagnosis names the remedy - *"only a Welcome
or an external commit lifts it"* - and **nothing lifted it**, across at least six retries and several
minutes. That is the same shape as the healing P1 above: a client that knows exactly what it needs and
never gets it. Read with [the Welcome livelock](#p1---a-device-asks-for-a-welcome-for-ever-and-the-member-that-answers-resets-the-row-that-would-have-let-it-heal-itself-measured-on-prod-2026-09-01).

**A FULL PAGE RELOAD DOES NOT LIFT IT EITHER** (measured 2026-09-04, at the user's suggestion - it was
the obvious thing to try and it deserved measuring rather than assuming). W1 was reloaded, came back on
`/chat` with no gate, and the very next send was refused with the same 403 and the same sentence. So
the state survives a re-mount and a fresh fetch of the client's MLS state: **whatever recovery exists
is not on the boot path**, which removes the cheapest explanation - "it just needed a restart" - and
means a user meeting this has no self-service way out. The conversation looks entirely normal on
screen the whole time.

**It is also the first thing the new `send.mjs` atom caught**, and only after being fixed twice: its
first post-condition was the sender's own pane (which renders optimistically, so it passed on a
refused message), and its second read the response in the same tick the request was sent (so the
status was `pending` and it passed again). It now waits for the answer and exits 1 on a 4xx.

### P1 - the placeholder is GONE from prod; what it may have left in the MLS TREE is not answered

**The defect, its cause, the guards of 2026-08-28 and the hand cleanup of 2026-08-30 - with every
count and the evidence the deleted frames carried - are in `CHANGELOG.md` and on
[chat-delivery](services/chat-delivery.md#the-placeholder-that-took-a-conversations-first-seat-cleaned-by-hand-2026-08-30).
None of it is restated here.** The server estate is zero on all four tables and the DM kept its eight
real device rows. Two things are open, and neither is a database question.

1. **WHETHER IT LEFT A LEAF, which no server query can answer.** The server row is not the MLS tree:
   if a commit ever Added the placeholder, only a Remove commit from a member drops it, and deleting
   the row did not. The group sat at **epoch 118** and the placeholder held a `key_package`, so an
   Add is likely rather than certain. **It is answered from a member's own client** - both members
   are the account owners, so either can read the tree of `7da231f8-119c-4ce2-884f-55f5c94c903f` and
   say how many leaves it carries and whether one has no owner. Until then, that conversation may be
   encrypting to a member that does not exist, which costs nothing cryptographically and makes the
   roster wrong.
2. **NOT ESTABLISHED: whether the ghost is what stopped the activation.** The peer's real devices
   were `pending` and an active member device of the OWNER's account was online and polling
   throughout - the server answered it `invitations=8` at 23:03, 23:03, 23:09, 23:10, 23:11 and
   23:16 and it committed none of them. Whether `addMember` was failing over a tree holding the
   placeholder's leaf, or the client skipped for its own reason, is a CLIENT-log question and no
   server line separates them.
   **Do not assert the guards fixed it.** MULTI-8 and MULTI-9 on
   [cross-client-testing](cross-client-testing.md) are the rows that answer it.
3. **A report for the stranded state.** `No active membership` is logged at `LOG` and is also the
   normal answer for a device in its first seconds, so a working system and a broken one print the
   same thing twenty-one times - the same shape as the push token no row reported. The age of the
   row is already in the table, so the predicate is a `WHERE`, not a new column, and it must be
   measured against the whole population before its name is believed.

**THE POPULATION, RE-MEASURED 2026-08-30 BECAUSE THE FIRST MEASUREMENT NO LONGER DESCRIBES IT**
(`GROUP BY status`): **125 `active`, 17 `pending`** - against 150 / 10 on 2026-08-28. The stranded
count did not shrink after the guards, it **grew by seven**, so whatever produces a long-lived
`pending` is not the placeholder defect and is not fixed. Of the 17: **12 are `web-`, all older than
an hour, the oldest since 2026-08-25**; 5 are `tauri-`, 3 of them older than an hour. **Still mostly
Chrome, still not an iOS defect and not a mobile one** - but the predicate in (3) must be aimed at
this population, not at the one that named the incident.

**One thing was checked and is NOT a defect, so it is not re-derived**: nine of those ten have an
undelivered Welcome sitting in `queued_message`, which looks like a deadlock and is not.
`MSG_FETCH` filters on group tombstones, never on membership status, so those Welcomes are
retrievable the moment the device comes back - they are abandoned browser profiles, debris. The
tenth, the device that lost the user's messages, has **no queued row at all**: nobody ever added it.

### P3 - discovery honours a dismissal only for a row it ALREADY has, and a new device has none (measured 2026-08-27, population EMPTY today)

`discoverMissingGroups` (`frontend/src/lib/utils/chat/actions.ts`) fetches the dismiss set once and
uses it in exactly ONE place: the loop over `conversations.entries()`. The second loop - the one that
CREATES placeholder rows out of `activeServerGroups` - filters two things, a local row already
existing and an owed exit, and never consults the dismiss set at all. So a group in
`dismissed AND still a member server-side` is purged on a device that has the row, and re-created as
a `pending` placeholder wearing the Sync badge on a device that does not. **A device with an empty
store is precisely the case where the dismiss set is load-bearing, and precisely the case where it is
not read.** The server does not close the gap either: `getUserGroups` (`members.controller.ts`)
filters distribution groups and `deletedAt` tombstones, never dismissals.

**IT IS NOT THE CAUSE OF THE USER'S SYMPTOM, AND THAT WAS MEASURED, NOT ASSUMED.** Read from the
owner's own session on 2026-08-27 (`bun syncrows.mjs --device W3`): 9 active groups, 0 tombstoned,
**876** dismissed-group rows, and `dismissedStillMember: 0`. The intersection is EMPTY, so the branch
cannot currently fire - which is why this is a P3 latent gap and not the explanation for the Sync
rows the user reported. A predicate that names an incident has to be re-measured against the
population it will run on, and this one was.

**Two swallowed branches sit on the same seam**, both in `exitGroupAndCleanup`
(`useConversations.svelte.ts`): `await mlsService.dismissGroup(convo.id).catch(() => {})`, twice, with
no log. That call is the ONLY thing that propagates a manual delete to the user's other devices, so a
silent failure means the group comes back on the next new device with nothing anywhere saying why.
`mlsDeliveryApi.dismissGroup` swallows its own transport error too, for the stated reason that the
local purge already happened - which is true and does not make the loss unloggable. Every swallowed
branch logs; in a best-effort path that is all a loss leaves.

**The 876 is worth a second look on its own**: `user_dismissed_group` grows one row per manual delete
per user, for ever, and the campaign is what put 876 there. Nothing reads it in bulk, so it is not an
incident - but it is an unbounded table nobody has decided about.

Reached by `HEAL-NEW-7` on the board, which is written to tell this cause apart from the two that can
actually fire today - a server tombstone, and an exit still owed in the DELETING device's own
IndexedDB.


### P3 - openmls 0.8.1 PANICS on a corrupted PrivateMessage body instead of returning an error (found 2026-08-27)

Found while writing a producer for the same-epoch refusal test: tampering with the AEAD-protected
body of a `PrivateMessage` does not yield an `Err`. It aborts inside the library -
`panicked at openmls-0.8.1/src/framing/private_message_in.rs:136: Ciphertext decryption failed`.

**Why it is more than a test inconvenience.** In WASM a panic surfaces as `unreachable`, which
`mlsDecryptError.ts` classifies as `'oom'`, which routes to `onMlsFatalError`. So **a byte string the
server hands us can kill the MLS client**, and the server is not trusted with plaintext but IS the
thing that stores and returns these bytes. Nothing on the ladder produces one today - the campaign
never corrupts a frame - which is precisely why CORRUPT (rung 18) should, and it is the natural
place to settle it.

**What is NOT known:** whether the panic is reachable from a frame the server could actually return
(a truncated or bit-flipped ciphertext row) or only from a hand-built one. Answer that before
deciding between catching it at the WASM boundary and carrying it upstream to openmls.

The workaround the tests use is to avoid the shape entirely: the producer is two members committing
at the same epoch, which is the production shape anyway and returns cleanly.

### P2 - a group that never leaves its creation epoch keeps collecting device invitations nobody can honour (measured on prod 2026-08-30)

Found by HEAL-REVOKE-7 `--order last` on `edb8d7ab` - the run that was supposed to confirm the P1
above and instead FAILed on that P1's RESIDUE. Kept as its own item because the residue turned out to
name a class, and the class has real conversations in it.

**What the row saw.** `equalityGap: ["rows: 12 vs 13", "syncing: 0 vs 1"]`. The server listed 13
groups for the subject; the returning device built 12 rows and settled; the freshly minted reference
built 13, the 13th amber for ever. The extra one was `8868be1c`, the very group the P1 above
destroyed. The actor itself reported `12 ready of 13` - so no device in the fleet could serve it.

**What prod said, and it is the membership row that lies.** The group was alive (`deletedAt` null,
`activeEpoch 1`, no rotation payload) and its device memberships read:

    web-...-msgm5z5j-136y   active    2026-08-30 01:20:44.793     <- the creator, holding NOTHING
    web-...-mtd1d1fc-m84y   pending   2026-08-30 01:20:44.849
    tauri-...-mtd1qgu3-vnde pending   2026-08-30 01:20:44.849
    web-...-mtf6rlvn-hkhr   pending   2026-08-30 02:24:18.378     <- this run's reference mint

`active` is written when the creator registers itself, and nothing ever revisits it. The creator's
local MLS state was gone 291 ms later, so the server went on offering the group to every device that
enrolled afterwards - including a device minted an hour later, which duly went `pending` and stayed
there. **A membership row records that an invitation was SENT; nothing reads back whether it was ever
honoured, and nothing expires it.**

**THE POPULATION, because this is exactly the kind of question no row on the board asks** (measured
2026-08-30, before the sweep that cleared the instance):

    -- invitations still pending on a LIVE group, by age
    SELECT CASE WHEN now() - m."createdAt" < interval '1 hour' THEN 'a: < 1h (in flight)'
                WHEN now() - m."createdAt" < interval '1 day'  THEN 'b: < 1 day'
                WHEN now() - m."createdAt" < interval '7 days' THEN 'c: < 7 days'
                ELSE 'd: older' END AS age,
           count(*) AS pending_rows, count(DISTINCT m."groupId") AS groups,
           count(DISTINCT m."groupId") FILTER (WHERE g."activeEpoch" <= 1) AS in_epoch1_groups
    FROM dm_device_group_memberships m JOIN dm_groups g ON g.id = m."groupId"
    WHERE g."deletedAt" IS NULL AND m.status = 'pending' GROUP BY 1 ORDER BY 1;

    a: < 1h (in flight)    2 rows   2 groups   1 at epoch 1
    b: < 1 day             9 rows   5 groups   1 at epoch 1
    c: < 7 days           13 rows   5 groups   3 at epoch 1

**22 of the 24 pending rows on live groups were older than an hour, 13 of them older than a day**, and
none pointed at a revoked device - they are live devices holding invitations that will not resolve.
Of the nine live groups sitting at epoch 0 or 1, **four carried pending rows and three of those are
real conversations, not harness debris** - two DMs from 2026-08-03 and 2026-08-28, and one unnamed
group from 2026-08-28. The oldest such group is 33 days old. `HGRP` debris was one of the four and
has been swept; the other three are untouched, deliberately - they are real user data and no
destructive control here has a reason to name them.

**Do not take `activeEpoch <= 1` for the predicate.** Pending rows exist on healthy groups too
(epochs 3, 4, 5, 8, 10, 108 and 258 each had one), so "pending" alone is not the signal and "epoch 1"
alone is not either: a DM created and never written to legitimately sits at epoch 1 with everyone
`active`. What distinguishes the corpse is a `pending` row that has outlived any plausible delivery -
which is a duration, and therefore has to be measured against the population before a name is put on
it, not chosen from this one incident.

**The second fact, and the one that reaches a HEAL row.** The two devices disagree about an
unservable group: a FRESH device creates a row for it and leaves the tile amber for ever; a RETURNING
device creates no row at all. Neither is obviously wrong - not showing it is arguably the better of
the two - but they differ, and "a returned device ends where a fresh device ends" is precisely what
rung 16 asserts. **So this class can fail a HEAL-REVOKE row that is not about it**, which is how it
was found, and it is the same family as the dead row a deleted group leaves every other member.

**Not fixed here: the blast radius leaves the row's subject.** Three things want deciding together,
and the third is the only one that is cheap: whether an invitation should expire; whether a group
whose creator holds no state should still be offered; and whether an unservable group should present
a tile at all. Nothing here should be settled by widening a sweep - the P1 above is precisely what
happens when a destructive path decides a group is dead from an incomplete read.

### P3 - one client reads a new salon's distribution group TWICE, concurrently (measured 2026-08-27)

`srvlog.mjs` leaves `published=false base=none active=0 devices=0` unexplained on purpose - it is
the shape that found the concurrent-join race - and on `cb967b6c` it earned that again. Every new
salon in the COMM rung is served that read **exactly twice, in the same second, to the same user**:
`93c80263`, `7e91ade3`, `5e09125d`, `d4b3152f`, `2de1a37c`, `ccc67640`, six for six.

Two callers are invoking `ensureDistributionGroup` for one channel concurrently. Neither can be
stopped by its `getLocalGroups()` guard, because at that instant neither has created anything - the
guard answers a question that only becomes true after one of them wins.

**It is currently harmless and that is the whole reason it is a P3, not a P2.** The first-publish
race is handled: the loser's `publish` returns `stored:false`, it calls `forgetGroup` and external
-joins the winner's base instead. So the duplicate costs one wasted group creation per salon and
nothing else that has been measured. It is filed because it is the SAME two-callers-one-read shape
that has already shipped one defect, and because a mitigation is not an absence.

**Do not fix it by widening the guard.** The question to answer first is who the second caller is -
the roster sweep and the channel-open path are both candidates - because a lock around the read
would hide the duplication rather than remove it.

### P2 - two COMM rows could not ARM, and the re-run has to say whether that was the debris (measured 2026-08-27)

`f21502e1` left three `VACUOUS` cells. COMM-22 is the entry below. The other two are open:

- **COMM-9/10** - `failures: []`, and yet nothing to judge: `keptArrived:false`,
  `keptLatencyMs:null`, `deniedLatencyMs:null`, `keptCopiesAfterRemoval:0`. The message the row
  removes a member around never arrived, so the removal raced nothing. An empty `failures[]` beside
  an unarmed check is itself a runner defect - the row knew it could not ask its question and said
  nothing about why.
- **COMM-21** - `the peer posts while it may: COMM21-... never appeared in 30000ms`, and
  `probeBefore` answered **HTTP 400 `senderSessionId is required for channel messages`**.
  **CORRECTED 2026-08-27: THAT 400 IS THE DESIGN, NOT A DEFECT.** `comm21.mjs`'s own header states
  it - the probe is deliberately session-less so the SAME request is refused for two different
  reasons, 400 while the peer is still a member and 403 once it is not, "without the 400 the 403
  could equally be a malformed probe". The arm condition at `comm21.mjs:196` REQUIRES
  `probeBefore?.status === 400`. So the 400 is a satisfied conjunct and the row failed on a
  DIFFERENT one - and the real cause is named right there in the same verdict line, which was read
  past: **`the peer posts while it may: COMM21-... never appeared in 30000ms`, i.e.
  `peerWroteBefore !== true`.** The peer could not send in the salon it was still a member of.
  **Read the ledger record before touching the probe** - and note the shape: the granting device
  and the peer failing to exchange a message in a fresh salon is EXACTLY the forked-group signature
  COMM-8 turned out to be, so re-run this row on a build carrying that fix BEFORE calling it a
  runner defect at all.

**ADJUDICATED 2026-08-27 on `cb967b6c`, the first build carrying the same-epoch ACK.** Both
survived the debris being cleared, so both causes are real and neither was the redelivery:

- **COMM-9/10 still `VACUOUS`**, identically: `keptArrived:false` with `failures: []`. The runner
  defect stands as written - a row that cannot ask its question must say so in `failures[]`, and
  this one still says nothing.
- **COMM-21 still `VACUOUS`** with the same `probeBefore` 400 - which the correction above shows is
  the design. Its blocker is `peerWroteBefore`, and the first thing owed to it is a re-run on the
  COMM-8 fix, not a runner change.

### P2 - a STAGED commit cannot export a base at submit time, and keeps a repair where the external path needs none (COMM-22)

**Reproduced on two builds with one runner**, `d6f61539` (2026-08-25T21:56Z) and `2a4297cb`
(2026-08-26T17:45Z), `armed: true`, six grant/join/send/revoke/send cycles both times. It is NOT the
wreckage path `ea8266b2` removed: that commit landed at 20:25Z, before both.

The signature is narrow, and that is what makes it a defect rather than a slow window:

| | value |
| --- | --- |
| sender reads | 12 of 12, 6 837 ms |
| peer reads WARM | **11 of 12** |
| peer reads COLD, after reload + PIN | **11 of 12** - the same eleven |
| seeds the peer holds | **11**, for 12 sessions |
| `nothingStaysUnreadable` | true |

**WARM AND COLD ARE IDENTICAL, WHICH IS THE WHOLE FINDING.** A repair that had not finished yet would
differ across a reload; the same eleven on both sides means the twelfth seed is not late, it is
absent, and no reload will fetch it. The row it belongs to renders as explicitly unreadable
(`no seed for session ... (repairable)`) - so the product is honest about it and the reader still
never sees the message.

**THE SENDER DID ANSWER.** `repair.senderAnswered` holds nine answers summing to twelve seeds and
`senderWithheld` is empty, while `peerAbsorbed` records four lines summing to seven. So the loss is
on the receiving or the requesting side, not a sender that refused.

**THE CAUSE, FROM THE RUN LOG OF `2a4297cb`.** The peer is not slow and it is not refused a seed: it
is not IN the salon's distribution group at all, and it is its OWN earlier commit that put it out.

    19:36:12  W1  no base published for salon 58afab93 - creating group 9e46429d
    19:36:12  W1  POST .../distribution-group/group-info        <- base published at epoch 0
    19:36:21  W1  Processing Commit group=9e46429d sender=<peer>  <- the peer's external join, epoch -> 1
                  ... and NO group-info POST from the peer, ever
    19:36:26  W2  externalJoin STALE base for 9e46429d (published 0, group at 1) - not attempting
    19:36:31  W2  undecryptable frame on 9e46429d - not acknowledged: Group not found
    19:36:34  W2  could not ask for 1 missing seed(s) in channel 58afab93: Group not found
    19:36:40  W1  the published base is at epoch 0 while the group is at 1 - republishing   <- 14 s too late

**AN EXTERNAL JOIN ADVANCES THE GROUP AND LEAVES THE BASE BEHIND IT.** `externalJoin` publishes the
new base with `void this.refreshGroupInfo(joined.groupId)` (`BaseMlsService.ts:2288`) - fire-and-forget,
by the same deliberate choice as the one after `submitCommit` (`:1912`), so a commit that succeeded is
never reported as failed because a follow-up did not land. The check reloads the peer moments later on
a CLEAN state, so that follow-up never lands AND the tree that could mint the base is gone with it. The
joiner has locked itself out, and every stateless joiner after it: the commit gate accepts a base equal
to the active epoch and nothing else, and a distribution group has no peer-Welcome fallback.

**THE REPAIR EXISTS AND IS 14 SECONDS LATE, WHICH IS WHY THE LOSS IS PERMANENT.** `republishStaleBase`
did fire, three times across the run (base 0->1, 6->7, 12->13), from the one holder with a current
tree - but its trigger is that holder's *ordinary read* of the salon, not the epoch change, so it
always lands after the refused peer has already given up. And the peer's giving-up is terminal twice
over: `stale_base` is treated as a fact for the session, and the seed repair on top of it deletes its
`outstanding` entry before the send it then loses (`repair.ts:124-160`), with `asked` never set
(`:303-321`) and all three re-arm paths driven by an arriving answer that cannot come.

**Two standing rules name it.** *Never learn by failing what a fact could have told you* - the repair
hands the ask to a layer certain to refuse it, to discover a group it is not in, eight seconds after
`stale_base` established exactly that. And *a race that heals cleanly is still a defect* - here it
does not heal at all.

**The external-join half is shipped and is not restated here** - story in `CHANGELOG.md`, mechanism
on [mls-protocol](protocols/mls-protocol.md). What matters for the half below is only its shape: the
window was DELETED rather than narrowed, because an external commit is applied at once and the
joiner can export the base its own commit created before merging. Narrowing was considered and
rejected - a two-member salon whose other member is offline still has nobody to mint the base, and
a shorter race is still a race.

**THE HALF THAT REMAINS, and why it is separate.** An ordinary staged commit (add/remove) cannot
export a base at submit time: its commit is unapplied, so the device is still at the OLD epoch and
`export_group_info` would describe the base the joiner already has. Those paths keep
`void this.refreshGroupInfo(groupId)` after the merge (`BaseMlsService.ts:1912`) and a holder's
`republishStaleBase` as their repair - the same window, one round-trip wide, on a device that stays a
holder and is far less likely to reload mid-flight. Closing it needs the GroupInfo openmls already
builds and all four call sites discard (`mls-core/src/members.rs:85,121,273`, `welcome.rs:86`, each
destructuring `_group_info`); the groups use `use_ratchet_tree_extension(true)`, so it carries the
tree exactly as `export_group_info(.., true)` does. Layers: `mls-core` -> `mls-wasm` (a third slot on
the returned array) -> `BaseMlsService` -> the already-widened `submitCommit`, plus `npm run
generate`. The server side is done and takes it unchanged.

**ONE HYPOTHESIS ALREADY REFUTED, recorded so it is not re-run:** the missing session was
`R3jf6bcWThQ2oUnLKLaKvi--`, the only one of the twelve whose id ends in `-`, which in SQL would open
a comment. It does not: `getGraineHistoryFloors` binds the ids as an array
(`IN (:...sessionIds)`, `channel.service.ts:1318`), so nothing is interpolated. The trailing dashes
are a coincidence of base64url.

**THE RECORD WAS INCONSISTENT ACROSS THREE FILES before this**, which is why the FAIL survived two
sessions unnoticed: the board said `VACUOUS`, [cross-client-campaign](cross-client-campaign.md) said
a believed `PASS-DIRTY`, and `results.ndjson` said `FAIL` twice. All three now say `FAIL`. The
believed pass was real but on an OLDER runner, and its shape differed where it matters: the peer
missed seven sessions there and absorbed all seven.

### P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (measured 2026-08-26)

**Found by a fix working.** GRP-8's round-2 re-admission Welcome used to be dropped as a redelivery
(closed in `e027679a`), so the re-admission never happened on the joiner and the check passed anyway -
it counts the INVITER's roster. With the Welcome processed, this is the honest consequence. Nine clean
`PASS` rows before `feecfaf5`, `PASS-DIRTY` on it.

**THE SAME FRAME IS JUDGED TWICE AND THE TWO ANSWERS DISAGREE**, fifteen seconds apart, on `feecfaf5`:

    11:09:19  Frame arrived after this device was evicted - ACKed and dropped, no repair is owed
              msg_epoch=3 group_epoch=3
    11:09:34  [WELCOME] held but EVICTED - re-admission, not a redelivery   -> forget_group, epoch 4
    11:09:34  Past-epoch application frame, unreadable for good: msg_epoch=3 group_epoch=4
    11:09:34  [History] frame never read here and unreadable for good; will reconcile
    11:09:34  [HISTORY_RECONCILE] asked ... whether we hold the same history

`history.ts`'s `kind === 'evicted'` branch already carries the whole argument three lines above the one
that fires - *"we are not entitled to the plaintext, so there is nothing for a reconciliation to
recover"*. The defect is that this reasoning is keyed on the CURRENT membership state, so it stops
applying the instant the device is re-admitted, while the frames it protects are still in the stream.
**A column is only evidence for the question it was written to answer**: `evicted` answers "am I out
NOW", not "was I out THEN".

**What it costs:** one reconciliation per re-add over the whole exclusion window rather than one frame,
so it scales with how long the device was out and how busy the group was - against *"doit marcher avec
une conversation de toute les tailles"*. And it puts a repair line in a window where nothing needed
repairing.

**The fix, and the one thing blocking the obvious version.** An ENTITLEMENT FLOOR per group, written
where the Welcome installs - which is now a named branch, `readmittedAfterEviction` in
`setupMessageHandler.ts`. A frame below the floor is then handled exactly like `evicted`: marked seen,
no loss, no reconciliation. **The frame's own epoch is not visible from JS** - Rust has it and prints it
(`msg_epoch=3 group_epoch=4`) but the error reaching `classifyIncomingDecryptError` is
`SecretTreeError(TooDistantInThePast)` with no number, and `getEpoch(groupId)` gives only the current
epoch. So either surface the frame's epoch through the decrypt error - **never learn by failing what a
fact could have told you** - or key the floor on the STREAM POSITION at re-admission, since the replay
already walks rows in order and row ids are timestamps. The second needs no WASM rebuild and no APK.

**A policy question sits behind it and is NOT answered here** - see
[open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add). Nothing
should be changed on the strength of a reading of it.

**How to confirm it is gone:** GRP-8 goes clean. It is the only check that re-adds a removed member.


**RECURRENCE 2026-08-30, AND IT WIDENS THE POPULATION THIS ENTRY CLAIMS.** Read off six
HEAL-REVOKE-5 runs, builds `96bdd1bb` through `0044a041`. **The device losing the frames was never
evicted from the group it loses them in** - it is a fresh device of the same user, joining for the
first time after a revocation wipe. So the entitlement floor cannot be keyed on
`readmittedAfterEviction` alone, which is what the fix above proposes: that branch never runs here.
**A floor belongs at every entitlement START, however the entitlement was acquired.** And "how to
confirm it is gone: GRP-8, the only check that re-adds a removed member" is incomplete for the same
reason - HEAL-REVOKE-5's reference observer reaches this branch with no eviction anywhere in the row.

**What was measured.** 107 distinct `LOST frame` fingerprints over the six runs, growing run over run
(1, 8, 8, 9, 30, 51). In the run of record, 50 of 51 fall in ONE group of the 23 the owner is a member
of. They are not chat text: the fingerprint's first field is `frame.length` in base 36, so the sizes
read straight off it - median 52 KB, max 84 KB, 5.6 MB over the six runs.

**A SECOND AND MUCH LARGER POPULATION SITS BEHIND THE SAME GROUP**, reported in aggregate rather than
per frame:

    [HISTORY] 642f389a... holds 8005 frame(s) it can never read - reconciling (e.g. 5p:1cx1kog, ...)
    [HISTORY] 642f389a... holds 3005 frame(s) it can never read - reconciling (e.g. 5p:1cx1kog, ...)

`5p` is 205 bytes, so these are small frames and a different population from the 52 KB ones above. The
example fingerprints are IDENTICAL across all three observers of one run, so that backlog is stable.

**WHAT IS NOT ESTABLISHED, AND THE INFERENCE THAT MUST NOT BE DRAWN FROM IT.** No fingerprint repeats
across any two runs, and **that is not evidence the frames are new messages.** `frameFingerprint` is
FNV-1a over the CIPHERTEXT bytes, and `historyManifest.ts` answers a reconciliation by re-encrypting
the peer's durable copy at the CURRENT generation - so the very same message re-sent to a new device
fingerprints differently every time. Zero overlap discriminates nothing here, and a reading of it as
"fresh traffic each run" was formed and retracted before it reached this page.

**The cheap discriminator, for whoever takes it.** The digest that precedes the burst asks with
nothing held - `[HISTORY_DIGEST] Sent for 642f389a... - ids mode, 0 id(s), asking from
2026-05-31T00:00:00.000Z` - so whether the 52 KB frames ARE that answer is settled by putting the
`Sent` stamp beside the burst, which lands inside a single second. Worth one look before anything is
changed: if the reconciliation's own answer is what arrives unreadable, the repair is feeding the
loss it was sent to cure.

**One more line from the same window, unqueued elsewhere and not chased here:**
`[HISTORY_RECONCILE] no probe sender yet - 642f389a... deferred until one is installed`, five times
across two groups before the first digest goes out.


### P2 - a device revoked while OFFLINE keeps its store until someone LOGS IN on it (measured 2026-08-30)

**The product does what it says, and HEAL-REVOKE-9 now asserts three things where it asserted one.**
While the victim was severed (`severed: true` in 4 ms) and revoked from the owner's panel
(`stillAddressable: false` in 2 106 ms), its state was still there - `identityKeys: 1`, 2 databases, 22
localStorage keys, `wipeRan: false`. **A device that cannot ask does not conclude**, and a wipe there
would have been this rung's worst possible outcome. A reload alone changed nothing
(`revocationSeen: false`; `footprint.mjs` still read 6.54 MB fourteen minutes later); one
`login.mjs --device W3` then took it to `identityKeys: 0`, 3.46 MB. **The wipe is DEFERRED, not lost.**
`sessionAuth.ts` has exactly three triggers and each requires a credential or a live socket, so a page
load that finds a dead cookie hits none of them - by design, since wiping on an unauthenticated page
visit is a destructive control firing without a confirmed server fact.

**SO WHAT IS OPEN IS A DECISION, NOT A PATCH: how long the residue may sit.** On a machine never logged
into again - the stolen-laptop case revocation exists for - it stays on disk indefinitely. It is an
identifier (`mls_device_id_<userId>`) plus SEALED key material (`canari_device_key_vault`) over databases
encrypted under that device key: ciphertext and a name, not readable messages, which is why this is a P2.
Closing it needs a choice between two bad options - asking the revocation route at the login GATE means
answering `/api/mls/devices/:userId/:deviceId/revoked` to an unauthenticated caller, a device-enumeration
oracle; the alternative is a local expiry, the exact clock this project refuses to make load-bearing.
**That question is the whole of what stays open here.**

### P3 - a `history_bundle` restores the EDITED flag without the edited body

Found by enumerating every applier of a message mutation on 2026-08-22, after three defects in that
seam were fixed (see `CHANGELOG.md` and [chat](frontend/modules/chat.md)). This is the fourth
applier, and unlike the other three it is not broken - it is deliberately narrower than the others in
a way that has a visible consequence nobody has decided about.

`systemMessageHandler.ts`, the `history_bundle` merge over messages a device ALREADY holds: a
deletion in the bundle replaces the body with the tombstone, and an edit in the bundle sets
`isEdited: true` and fills `editedAt` when absent - but never touches `content`. So a device that
missed an `edit_message` frame and later receives a bundle carrying the edited message ends up
showing the PRE-EDIT text with an "edited" marker on it. It cannot diverge two bodies, because it
never writes a body; it can present a body it knows is superseded.

**Why it is not simply a bug to fix.** Taking the bundle's body means trusting a peer's copy of
another member's message content over our own, and the comment on the deletion branch (D5) shows the
narrowness there was reasoned rather than accidental. `editSupersedes` now gives the merge a rule it
did not have when it was written - apply the bundle's body when its `editedAt` is strictly newer -
which would close this without trusting anything undated. That is a trust-model decision, so it is
recorded here rather than taken while a campaign is running.

**What would tell us it matters:** no board row covers it, and reaching it needs a device that missed
an edit AND is later handed a bundle containing it - which is the FWD/HEAL shape, not MUT's.

### P3 - a deleted group leaves every OTHER member a dead row, for ever, clearable only one at a time

Found on 2026-08-24 while clearing the campaign's own debris off W2, and the retention itself is NOT
the finding - it is deliberate and right. `initializeConnection.ts:171` forgets the member's WASM
state, so she can no longer send, and then calls `onGroupDeletedRemotely` so the conversation is
marked `removed` and shown with a banner "instead of removing it silently". `decideAbsentGroupFate`'s
first guard then makes that state unreachable by any later reconciliation, because it records what
its owner was TOLD. Removing a conversation from under someone without telling them would be the
worse behaviour, and the design says so.

**What has no answer is the ACCUMULATION, and the fact that the only exit is per-row.** "Supprimer
localement" acts on the OPEN conversation, so N dead rows cost N navigations and N clicks; there is
no bulk gesture, no "clear the deleted ones", and nothing ages them out - a `removed` row is
permanent by construction. The rig measured the extreme: W2 held **189** of them, from one phase of
one campaign, and clearing them needed a purpose-built sweep (`dismiss.mjs`) driving the button 189
times. A real user's number is not 189, but it is not zero either and it only ever grows: a promo
with a group per project, deleted at the end of each year, accumulates a dozen dead rows that no
gesture can clear together.

**Why it is a product decision rather than a bug to fix.** Any bulk control has to decide what it may
touch, and the only honest allowlist is "conversations already marked `removed`" - which is
exactly the set whose whole purpose is to have been SEEN by its owner first. A control that clears
them wholesale re-introduces, by the owner's own hand, the silent removal the banner exists to
prevent. So the question is a UX one and belongs to the user: is the exit a bulk action, an
age-out for a row whose banner has been seen, or nothing at all.

**What would tell us it matters:** no board row covers it, and no rung would ever notice - every
runner either creates and deletes its own group (so it is the CREATOR, whose copy `deleteGroup`
purges) or leaves the debris behind for the next run to inherit. That asymmetry is why it went
unseen for the whole campaign: W1 measured clean at 9 conversations on the same day W2 held 189.

### P1 - a REVOKED device kept its local store, restored only SOME conversations, and a locally-pending deletion blocked the new conversation with that peer

Reported by the user 2026-08-23, verbatim: *"sur un vieux PC client qui avait toujours une memoire
locale (pourquoi, puisqu'il avait ete des appareils connectes via l'interface ?), le fait de se
reconnecter n'a pas charge toutes les conversations (certaines oui, certaines non). Pire : une
conversation 1v1 avec quelqu'un [qui] avait ete en attente de suppression locale sur cet appareil (le
pair avait supprime la conversation, mais nous elle etait toujours presente localement) a fait
barrage a la reception de la nouvelle conversation avec ce pair (ca faisait doublon j'imagine)."*

Three separate things, in the order they have to be answered:

1. **ANSWERED, AND IT IS WHY THIS ENTRY IS A P1.** The question was what revocation is DEFINED to
   do; the user settled it 2026-08-23, verbatim: *"Effacer ce qu'il detient (il doit devenir un
   appareil comme neuf s'il essaie de se reconnecter, c'est a ca que sert la blacklist non ?)"*.
   Revocation is a WIPE. A revoked device that still holds its local store is therefore a defect,
   not a wording problem.

   **WHICH OF THE TWO IT WAS IS NOW SETTLED, BY READING: THE MECHANISM EXISTS, SO IT DID NOT FIRE.**
   `resetDeviceAsFreshImpl` (`sessionAuth.ts`) is thorough - MLS state, the device id, the sync-guide
   flag, every `device-name:` key, the IndexedDB store cleared AND closed, the session's own handle
   closed, the auth cleared, the device wiped to factory. **What was missing was a path that ASKS.**
   Until 2026-08-26 the only two triggers were `resetRequired` on the PIN check and a
   `device_revoked` control frame, and the first was reached only inside
   `if (!isBiometric && !isVaultLogin)`. So a vault or biometric login never learned at login time
   that it had been revoked, and depended entirely on a frame arriving while it was online - a frame
   sent to a device that was not there to receive it. **Fixed 2026-08-26**: every login path now
   resolves its real device id and asks `/api/mls/devices/:userId/:deviceId/revoked` before `init()`,
   and the one wipe is `wipeRevokedDevice`, shared by all three triggers - which also gave the frame
   path the MLS teardown it was skipping, on the one path where the service is still live. Story in
   `CHANGELOG.md`, rule in [durable-rules](durable-rules.md).

   **AND A SECOND CAUSE OF THE SAME SYMPTOM WAS FOUND ON 2026-08-30, by HEAL-REVOKE-9, which means
   the fix above was NECESSARY AND NOT SUFFICIENT.** `getStorage()` is a factory, so the number of
   open connections is the number of readers; `/posts` was measured holding two, the wipe closed one,
   `deleteDatabase` fired `onblocked`, and a revoked device kept its message store **with the wipe
   having run and reported success**. Fixed in `da0ce2f2` at the module that creates the connections,
   with a registry mirroring `closeMlsDb`. So "the wipe did not fire" and "the wipe fired and was
   blocked" are two different defects wearing one report, and only the first was known.

   **THIS DOES NOT CLOSE THE ENTRY, AND MUST NOT BE READ AS CLOSING IT.** Points 2 and 3 below are
   untouched by both fixes. What closes it is HEAL-REVOKE-1, -2 and -3 run against a build carrying
   `da0ce2f2`, not the inference that the cause found must have been the cause reported.

   **HEAL-REVOKE-1 RAN ON 2026-09-05 AND THE SYMPTOM DOES NOT REPRODUCE - `PASS`, clean, `unmet: []`
   on `2862d958`.** A device that held 7 of 7 rows plus a group minted for the row was revoked
   through the product's own panel; the server recorded the decision in 276 ms and the device left
   the census 670 ms later; the device's `[RESET]` trail reported the wipe run and finished with no
   failed step and no `store(s) SURVIVED` line; and the disk, read seconds after the trail, held
   **0 Canari databases, 0 identity keys, 0 localStorage keys**. **Two independent witnesses, and the
   row asserts both** - the app can be right about a wipe it did not complete, and a `deleteDatabase`
   can leave something no log mentions.

   **WHAT THAT DOES AND DOES NOT SETTLE.** It settles the first instant, which is the only one that
   can be read: a re-enrolment writes `CanariDB_<userId>` back under the same name within seconds, so
   no later sample separates a store that survived from one that was rebuilt. It does NOT settle
   points 2 and 3, and it does not settle the RETURN - whether a device that comes back ends where a
   fresh one ends is HEAL-REVOKE-2 and -3, and those rows have no runner yet. **The entry stays open
   on them**, not on this half.

   **AND THE FIRST ATTEMPT AT THIS ROW WAS `INVALID` FOR A REASON THAT WAS NOT THE PRODUCT'S**, which
   is worth recording because the sentence it wrote read exactly like one: *"the victim could not be
   brought to an enrolled starting point"*. `newdevice.mjs` spawned `login.mjs` by BARE NAME, so a
   mint resolved it against the CALLER'S working directory - fine from the harness root, `Module not
   found` after a `cd archive` - and exited 1 on a stderr the helper discarded. Ninth sighting of that defect and the first one
   `spawn-selftest.mjs` had been green for; the gate is now an allowlist of resolved forms rather
   than a ban on one spelling ([durable-rules](durable-rules.md)).

   **AND THE PARAGRAPH ABOVE WAS HALF WRONG, CORRECTED BY MEASUREMENT 2026-08-28.** The wipe was
   thorough and the trigger was missing - both true - but the wipe was also **not permanent**, which
   reading it could not show: it ran, deleted everything, and the SYNC_WATCHDOG nobody had stopped
   rebuilt the MLS database and re-marked ten groups 1.25 s later, on a device that had just printed
   `nothing of this device remains`. So "the mechanism exists, so it did not fire" was the right
   deduction from the wrong premise, and a user's report of a revoked PC that *still had local
   memory* is consistent with the wipe having fired all along. **Fixed by `tearDownLiveSession`;
   story in `CHANGELOG.md`, mechanism on
   [auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it), two rules
   in [durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).** It also means the two candidate causes
   below are no longer the only two: a third is that the PC was revoked, wiped, and re-created its
   own store - the one the user would have seen as "still had local memory".

   **A SECOND, INDEPENDENT WAY A REVOKED DEVICE KEPT ITS STORE - FIXED THE SAME DAY, AND IT DOES NOT
   EXPLAIN THIS REPORT.** `wipeDeviceToFactory` had the native stores and the WebView's as the two
   ARMS of one platform branch, so inside Tauri it deleted `mls.bin` and the `.db` files and never
   touched IndexedDB - measured on a Pixel 6a holding 5.9 MB of `CanariDB_<userId>` it should never
   have had, created by a reader that named `IndexedDbStorage` instead of asking `getStorage`. Both
   halves are fixed with a guard test. **It is recorded here so it is not mistaken for a fourth
   candidate cause above: the user's device was a PC, on the web, where that branch always ran.**
   Story in `CHANGELOG.md`, mechanism on the same auth section, two more rules in
   [durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).

   **TWO CANDIDATE CAUSES SURVIVE that fix and only the user's own history separates them**, so
   neither is worth code before rung 16 measures it: the removed panel row may have been
   SESSION-only, since `handleRemoveRow` calls `deleteDevice` only when `row.device` exists, in which
   case nothing was ever revoked and nothing is broken; or the device was deleted but
   `revokeRowSessions` failed - a state the code already anticipates in as many words - leaving the
   PC a valid refresh cookie, so it never reached a login path at all.

   The rest of that decision is not a fix but three things to VERIFY, and they are rows, not prose:
   a revoked device really does become like-new; its first reconnection resynchronises as a NEW
   device would, history included; and if that first pass does not catch everything up, the later
   connections do, through the heal-on-diff mechanism - which must be shown to TRIGGER, and to
   trigger on the right conditions rather than on any reconnection at all.

   The last of those is the one a green run can most easily fake. A heal that fires on every
   connection would make every check pass while proving nothing, so its conditions are part of the
   assertion, not context around it - the standing rule that a predicate which named the last
   incident is not the predicate that names the next one applies to its trigger directly.
2. **A partial restore is worse than no restore.** Reconnecting brought back some conversations and
   not others, with nothing saying which or why. A restore that silently stops halfway looks
   complete, so the user does not know to retry - it needs to know its own expected count and report
   the shortfall, per the standing rule that a correct mechanism with no report is found by hand a
   day late.
3. **A local tombstone was treated as a live conversation for de-duplication.** The peer had deleted
   the 1v1; locally it sat pending deletion; the NEW conversation with that same peer was then
   dropped, apparently as a duplicate of the record that was on its way out. Whatever key the dedup
   uses must exclude anything pending deletion, or the pending state has to be resolved before the
   new conversation is accepted - a record that exists only to be removed must not be able to refuse
   its own replacement.

**This is HEAL's, by the user's own framing** (*"On y reviendra au moment ou on fera la campagne
HEAL"*). Rung 16 is where it gets armed, and item 1 now carries FOUR rows rather than needing a
definition: the wipe on revocation, the like-new state on reconnection, the first-reconnect resync
with history, and the heal-on-diff trigger with its conditions. Items 2 and 3 are both reproducible
without a second human - a stale profile plus a peer-side delete is exactly what the HEAL runners
already build - so all of it becomes rows on [cross-client-testing](cross-client-testing.md) rather
than hand-checked stories.

**One thing to settle before writing those rows, and it is not obvious which way it goes:** a wipe is
executed BY the device being wiped, so it can only run when that device next comes online - and a
device that never returns is never wiped, whatever the server recorded. So the row proving "it became
like-new" and the row proving "the wipe ran" are not the same row, and neither implies the other. The
blacklist is what makes the first true without the second, which is exactly the reading the user's
own phrasing points at (*"c'est a ca que sert la blacklist non ?"*). The 2026-08-26 fix does not
change that - a wipe still needs the device back - but it narrows "comes online" from "is online at
the moment a frame is sent" to "logs in at all, by any path", which is the difference between a
guarantee and a coincidence.

### P2 - an offline deletion is remembered and never replayed, and DEL-10 fails on its own fix (measured 2026-08-26)

**The memory half works; the trigger half does not.** DEL-10 was `FAIL` on `c6eb7b20` because the
deletion was LOST - attempted once with the link cut, the local state purged anyway, and the group
handed back by `discoverMissingGroups`. `pendingGroupExits` fixed that half. On `2a4297cb` the row is
`FAIL` again, and what broke has moved:

| field | value | reading |
| --- | --- | --- |
| `sentWhileOffline` | 1 | the DELETE was attempted |
| `listedOnDeleter` | true | the group was NOT purged locally - the durable row did its job |
| `sentOnFirstReconnect` | 0 | **nothing replayed it** |
| `sentOnSecondReconnect` | 0 | nor the second time |
| `onServerAfter` | `live` | the deletion never happened |

So the decision is written down and kept, exactly as designed, and then no one comes back for it.
`drainPendingGroupExits` has two triggers - `ConnectivityStore.onReconnect`, and one pass at chat start
for the app killed while offline - and the check reconnects the link WITHOUT a reload, so only the
first applies. Either it does not fire for a link cut through CDP, or it fires and the drain finds no
row.

**BOTH HALVES OF THAT ARE NOW INSTRUMENTED (2026-08-27), and it took a product change as well as a
runner one.** The runner half was the easy half: `del10` snapshots `consoleLines(w1)` around each
reconnect and records `firstReconnectSaid` / `secondReconnectSaid`, so the entry now carries whether
the trigger announced itself (`ConnectivityStore` logs before it emits, so that line IS the listener
running) and whether the drain announced a replay. The product half is the one worth reading: the
drain returned a bare `[]` for `!storage` and for re-entrancy, and an empty array is precisely what a
trigger that never fired returns too - so two of the four ways to replay nothing were unnameable from
outside. They accuse now. `owed.length === 0` deliberately stays silent, because THAT one is routine:
it runs on every reconnect of every session that owes nothing, and a line there is the noise that
teaches a reader to skip `[EXIT]` and then to skip the one that matters. **The re-run is owed and
will name the cause rather than the symptom.**

**Do not read this as the old defect returning.** The two failures share a row id and nothing else: one
lost the decision, this one keeps it and never acts on it. The fix for the first is what makes the
second visible at all.

## Mentions

### P2 - a mention notification shows a 64-character hex id where the name should be

Found by the user on the phone, 2026-08-22, while the MENTION rung was running.

The wire format of a mention is `@[<64 lowercase hex>]` (`utils/mentions.ts`), and the WEB resolves
it at render time - `mentions.parse.ts:44` replaces `@[id]` with `@DisplayName` for bodies, previews
and reply quotes. **The Android notification does not.** `CanariFirebaseMessagingService` READS the
token (line 1332, `decrypted?.text?.contains("@[$myUserId]")`) to decide whether this is a mention of
me, and then passes the decrypted text to the notification builder unchanged. Both paths are
affected: the MLS/DM one and `handleChannelMessage`.

So the notification reads `Salut @[d82cd226…64 hex…] tu peux regarder ?`.

**It is worse than cosmetic.** `canari_mentions` is `IMPORTANCE_HIGH` and asks to bypass DND
(`CanariApplication.kt:223`): the one notification designed to interrupt someone is the one that
cannot be read. And the check that covers the path does not see it - MENTION-2 asserts that the
notification carries the marker, which is true of a body full of hex.

**THE MLS PATH CANNOT BE FIXED SERVER-SIDE, AND THE REASON IS KNOWLEDGE, NOT PRIVACY.** A DM or
group message reaches the server as ciphertext, so the server does not know a mention happened at all
- which is exactly why the Kotlin scans the decrypted text for `@[<myUserId>]` rather than being told.
No payload field can carry a name the sender of the payload cannot compute.

**The privacy argument this entry used to make is FALSE, and it was worth measuring rather than
assuming.** It said a display name in the payload would send real names of real students through FCM
and APNs. Every message push already does: `messaging.service.ts:463` calls `resolveUserDisplayName`
and ships the result as `senderName` in both the FCM data map and the APNs alert title
(`push-payload.ts`). So the objection to naming a MENTIONED user is not that names may not travel -
they already do - it is only that on the MLS path nobody server-side knows which ones to send.

**The CHANNEL path is therefore a different, much cheaper problem**, and the two should not be
bundled. `handleChannelMessage` is told `mentioned` by the server, from a cleartext
`mentionedUserIds` the sender supplies (the documented leak, MENTION-6). The server can resolve those
ids the same way it already resolves `senderName`, and the only real constraint is SIZE: `senderName`
and `groupName` are already flagged as unbounded user text against the 4 KB APNs budget
(`push-payload.ts:97`), and N mentioned names is N times that risk. Bound it - the first mention, or
nothing.

**For the MLS path the resolution belongs on the device, and this repo has TWO shapes for it.** The
one this entry originally proposed is a network fetch: `fetchAvatar(userId)` resolves a stranger's
avatar from `GET /api/mls/push/avatar/:targetUserId`, authenticated by `requesterId` + `deviceId` +
the Keystore push secret, behind a 24 h file cache, and a sibling endpoint returning
`resolveUserDisplayName` would mirror it. **The other is cheaper and better suited**, because a
notification arrives exactly when the device may be offline: `graine_seeds.json` is an app-private
file the FOREGROUND writes through a Tauri command (`store_graine_seed`) and the push service reads
with no network at all (`lookupGraineSeed`). The web already keeps a resolved-display-name cache -
`peekUserDisplayName` / `seedUserDisplayName` in `utils/users/displayName.ts` - so mirroring it is the
same three pieces the seed mirror has: a Rust command plus its `capabilities/` grant (an ungranted
Tauri command ships and rejects on a real device), a call site in the resolver, and a Kotlin reader.
No new server route, no deploy, and no name that the device did not already know.

**Whichever is chosen, it needs a substitution pass over the body before the notification is built.**

**The degrade must be decided, not defaulted - and the web decided it on 2026-08-30.** A cache miss
with no network is the exact case a notification arrives in, and it must not print hex. The mention
chip and the post mention link both stopped using the id as its own fallback that day: an unresolved
mention renders as a bare `@`, because a name that is not known YET is not the same fact as a name
that does not exist, and only the second may be painted. The notification has no second chance to
re-render, which argues for the same answer rather than a different one - a bare `@` is honest, and
`@[d82cd226...]` is not. Confirm against the native side before building.

**iOS is presumed to have the same gap and cannot be checked** - no iPhone in the estate
(`device-verification.md`). `push-payload.ts` builds the APNs half from the same fields.

**Cost, stated because it is why this is not a drive-by fix:** the channel half is server-only and
small; the MLS half is native (a Tauri command and its ACL grant, Kotlin, an APK rebuild and install)
and the rebuild re-bases A1's build for every phase of the ladder that follows it. Neither half can be
VERIFIED without a phone - a native change is checked by compiling, which proves nothing about
running.

## The harness itself

### P3 - a check run BY HAND can measure a bundle older than the build it stamps, and nothing refuses it (measured 2026-09-05)

`bundle.mjs` exists precisely for this and states it: a browser left open across a deploy keeps
executing the old bundle and its console reads exactly like a reloaded one. `run.mjs` asks; a check
invoked directly does not, and `record()` stamps `build` from the repository rather than from the
client.

Measured: TAB-1 was re-run three times against a fixed application and recorded `FAIL` each time
against a build whose fix its tab had never loaded. Three probes were spent before the stale tab was
the answer, and the ledger holds three rows naming a commit they did not measure. `tab1.mjs` now
reloads (as `tab4.mjs` and `tab5.mjs` already did), but that is one file remembering, not a rule:
`tab3b.mjs`, `tab7.mjs`, `notif.mjs`, `del1.mjs`, `msg4.mjs` and `mut.mjs` still do not.

The fix belongs in `recordObserved`, which is the only place that knows BOTH the verdict and the
clients it was observed on: compare each observed client's running bundle id against the deployed one
and refuse the row rather than stamp it. That is the rig's own rule - never learn by failing what a
fact could have told you - and the discriminator is already written and already exported. The care
needed is that TAB-7 asserts `neverReloaded`, so the check must REFUSE, never silently reload.


### P2 - no row on the board can tell a healthy conversation from an epoch-forked one (measured 2026-08-29)

Two production conversations sat forked one epoch behind for twenty-four hours, refusing 191 and 172
commits, and **every reading this rig takes was green throughout**: `data-ready="true"` on both tiles,
`syncing: 0`, `amber: []`. The fork was found in the SERVER's refusal count while chasing something
else. Reasoning in
[testing-methodology](testing-methodology.md#a-green-sidebar-tile-does-not-prove-the-group-is-not-epoch-forked);
this is the queue entry for the gap it leaves.

**What is missing is a predicate, not a runner.** Readiness answers *the list has painted*, which is
what it was written for. Nothing anywhere in the rig asks *is this device at the group's epoch*,
though the answer is one field: the client already holds `getEpoch(groupId)`, and the server already
answers `activeEpoch` on any refused commit and carries it in the commit-log endpoint. A `syncrows`
reader that put the two side by side would turn a class of defect that is currently found by hand,
a day late, into a per-row assertion.

**The row it belongs to is not written either.** COMM and MULTI both send and observe arrival, so
they would catch a fork that blocks traffic *in the window they watch*; neither asks the question of
a conversation it is not itself using, which is the only place a quiet fork can live. Scope it with
the four MULTI rows of queue item 3 - same shape, same devices, and the same reason none of ~200
existing rows would have caught it.


### P3 - an internet scanner can stop a `--repeat`, and separate invocations are the way round it (2026-08-26)

`GRP --repeat 5` stopped at pass 1 with `frontend-ssr NOT CLEAN ... unexplained=3`, the three lines being
`[404] HEAD /WP`, `[404] HEAD /old`, `[404] HEAD /Old` - a scanner sweeping a public host for WordPress
and a leftover backup directory.

**`srvlog.mjs` is not wrong to leave them there.** Its 404 rules are keyed on a stack prefix the
application provably cannot own (`/wp-*`, `/administrator/`, `/_next/`), and its own comments state twice
why a blanket `[404]` rule may never exist: it would forgive a route we DO own answering 404. `/WP` misses
the existing rule on case and on the absent hyphen, and `/old` is a shape a SvelteKit app could own, so
forgiving it would break the file's criterion rather than extend it.

**So the finding is not the three lines - it is that campaign throughput depends on what the internet
does to prod during a window.** Prod IS the test server, so this recurs with every new scanner spelling,
each time costing the remaining passes of a `--repeat`.

**The route round it, used the same day, needing no change to any gate:** the stop is BETWEEN passes, not
inside one - all ten checks of pass 1 ran and recorded their verdicts. Five separate `run.mjs GRP`
invocations therefore give five measured passes where `--repeat 5` gives one, with nothing disarmed. It
costs one preflight per pass.

**The real fix, when it is worth the time,** is to stop enumerating spellings and read the fact instead:
the set of paths the application owns is knowable without a build, from `frontend/src/routes/**` and
`frontend/static/**`. A 404 on a path IN that set is a defect; a 404 outside it provably cannot be ours.
That satisfies the file's own criterion better than any regex and closes the class instead of the
instance - the difference [testing-methodology](testing-methodology.md) rule 42 is about.


### P3 - the server's log SHAPES that a reader has to carry an exception for (measured 2026-08-30, one added 2026-08-31)

Read off HEAL-REVOKE-7's own run window (`srvlog.mjs --since 2026-08-30T02:31:06.469Z`, the pass that
gave `PASS-DIRTY` on `edb8d7ab`). **52 unexplained lines across four services and not one of them is
an error.** Recorded because the standing rule is that a line is either expected AND necessary or it
is the visible end of something upstream, and these are neither - they are the reason the server half
of this rung has never once been reported clean.

**The two shapes that ARE the bucket**, both `chat-delivery-service`, both `LOG`:

- `[InvitationsController] [DEVICE_MEMBERSHIPS] user=<64 hex> device=<full device id> count=12
  statuses=<twelve UUIDs, each with :active or :pending>` - emitted on every membership poll, so
  several per second while any device is settling. It alone is most of the 47.
- `[MessagingService] [PUSH_SEND] No push token for user=<64 hex> device=<full device id>` - one per
  addressee with no FCM token, on every send. In this fleet that is every desktop Tauri device, for
  ever, and one line reads `user=unknown device=pending`.

**They also put full identities in production logs.** Both print the 64-character user id and the
whole device id rather than the 8-character prefix the client's own logs use, and `social-service`
adds `[SubmitterFactsService] [FORMS] profile user=<8 hex> promo=<year> formation=<code>` at `DEBUG` -
a named person's cohort and course, in a log. Nothing here needs the full-length ids to be actionable.

**The other three are explained and must NOT be re-opened.** `[DevicesController] [DELETE_DEVICE] ...
groupsCleaned=11 keyPackagesDeleted=1 oneTimeKeyPackagesDeleted=35 queuedMessagesDeleted=13
signalled=true` is a genuine audit line and it is the SERVER-side proof that revocation drains the
frame queue - corroborated on prod the same day: of 5 621 queued frames across 53 devices, **zero
belong to any of the 223 revoked devices**. `[KICK] Reset device ... to pending` is the queued
kick+re-add P3. `Refresh refused: no canari_refresh cookie` twice on `core-service` is the wiped
victim asking with no cookie - the wipe working, which is this rung's subject.

**One line is worth a look on its own**: `[DEL_MEMBERSHIP] ... group=8c0e53b9... affected=0` - a
membership delete that matched no row. Harmless, but it means a caller believed in a row that was not
there, and `affected=0` is the only place that shows.

**A THIRD SHAPE, on the gateway, and it is the one a HUMAN reader trips over** (measured
2026-08-31: 15 in 6 hours on prod, and `sed`-grouped they are ONE shape, not several).
`handlers.rs:529` logs every read error at `ERROR`:

```
ERROR chat_gateway::handlers: WebSocket Error from <64 hex>: WebSocket protocol error: Connection reset without closing handshake
```

That is a CLIENT that vanished without a close frame - a tab closed, a phone suspended, a network
dropped, a container torn down under a live socket. The server did nothing wrong and can do nothing
about it, so it is expected and NOT necessary at that level, which is the standing rule's own
definition of noise. It also puts a full 64-character user id in a production log, like the two
above.

**The fix is a CLASSIFICATION, never a demotion**, and that distinction is the work: the read loop
must separate "the transport went away", which is routine, from "this client sent something invalid",
which is not - and it must do that on the error's TYPE, not on its text. `axum::Error` is opaque and
`into_inner()` yields a `BoxError`; the concrete type is `tungstenite::Error` at whatever version
axum resolved (0.29 today, and axum does not re-export it). **Adding `tungstenite` as a direct
dependency to downcast couples this crate to axum's private choice, and the failure mode is silent**
- an axum bump moves the version, the downcast stops matching, and every reset is an ERROR again with
nothing to say so. Answer that before writing the code; a test that asserts the classification on a
constructed error is what would make the coupling loud.

**Two readers already carry the exception for it**, and both would shrink: `EXPECTED_ERRORS` in
`srvlog.mjs` is a REGEX ON THE MESSAGE TEXT - exactly the thing the repo's rules forbid a decision to
rest on - and the fixture pinning it is `srvclassify-selftest.mjs:460`.
[testing-methodology](testing-methodology.md) documents the shape at three places.

**NOT changed here, deliberately.** Lowering a level or trimming a field changes what `srvlog.mjs`
classifies, and doing that between two passes of a running campaign would make the next window
incomparable with every window already recorded. It is a one-commit job for after the ladder.

### P2 - a LIVE socket dies in the middle of GRP-3, and no navigation explains it (measured 2026-08-25)

**Accepted as a `PASS-DIRTY` by the user's decision of 2026-08-25** - *"on peut se contenter des pass
dirty et passer a la suite"* - so this is recorded rather than blocking rung 8. The frontier drawn with
that decision is what makes it recordable: dirt whose CLASS has been read and named may pass, dirt that
is unclassified or that touches an assertion may not. This one is a known SHAPE with an UNKNOWN cause,
which is the reason it is a P2 and not a note.

**The measurement.** `GRP --repeat 5`, pass 1, 2026-08-25. Ten rows, nine `PASS`, and GRP-3
`PASS-DIRTY` on exactly one line:

    dirt_W1: wsEvents: ["11:28:30.944 Network.webSocketClosed {requestId 20644.93706}"]

Every product assertion held - `rosterBeforeRemoval: 2`, `rosterAfterRemoval: 1`,
`peerStillHoldsPreRemovalMessage: true`, `peerReceivedPostRemovalMessage: false`,
`removedDeviceLearntFromTheCommit: true`, `removedDeviceAskedToComeBack: []`. The row was recorded at
11:28:42, so the close landed ~12 s before the end of the check: inside the 30 s negative window,
roughly 18 s AFTER `removeMember` and after the post-removal send. It is on W1, the client that did
the removing, not W2, the one removed.

**WHY THE KNOWN EXPLANATION DOES NOT APPLY, which is the whole finding.** Rule 14 of
[testing-methodology](testing-methodology.md) established that every `goto` is a `Page.navigate`, that
a document replacement closes its own socket, and that `1006` follows - so `ignoringNavigation`
forgives at most `documentsReplaced` closes. This close was NOT forgiven, and GRP-3 gives it nowhere
to come from: every `openGroup` in it passes `navigate: false`, and `ensureChat` does not reload - it
clicks `text=Discussions`, a client-side SvelteKit route change, which fires
`Page.navigatedWithinDocument` and replaces no document. So `documentsReplaced` is 0, the forgiveness
budget is 0, and this is a live socket dying. `wsidle.mjs` already ruled out the other cheap reading:
W1 and W2 left untouched for eight minutes produced **zero** closes, so nothing on the path drops an
idle connection and the event is caused by something the check does.

**What is NOT known, and must not be guessed.** No console line accompanied it - READ's instance of
this shape came with `[WS] Disconnected. Code: 1006` beside it and this one came with nothing, though
that may only mean the app's own line is classified BENIGN and therefore absent from the dirt
projection rather than absent from the log. Whether the socket reopened is also unmeasured HERE:
`watch.mjs:1121` collects `Network.webSocketFrameError` and `Network.webSocketClosed` and **not**
`Network.webSocketCreated`, so a reconnection could never have appeared in this row. Reading its
absence as a failure to reconnect would be exactly the inference rule 39 warns about.

**The rate.** One in two recent runs: clean on the attempt of 2026-08-25 that stopped on the server
window, dirty on the next. GRP-3's `PASS-DIRTY` of 2026-08-24 is a DIFFERENT cause and must not be
counted here - it was an `[OUTBOX] ... evicted from ...` line from a browser left on a stale bundle,
which is what `8c248131` closed.

**How to settle it, in order, and none of it needs a new tool.** `ws1.mjs` already prints one
interleaved timeline of every `Network.webSocket*` event and every console line on one clock, written
for precisely this question on READ. Point it at GRP-3's sequence rather than READ-1's; add
`Network.webSocketCreated` to the collector at `watch.mjs:1121` first, since the reconnection is half
the answer and is currently invisible by construction. Then the discriminator is cheap: if the close
sits at a fixed offset from `removeMember` it belongs to the Remove commit path, and if it sits at a
fixed offset from the socket's own age it is a lifetime, which `wsidle.mjs` did not test because it
watched a socket for eight minutes rather than an old one.

### P2 - ONE NAMED STARTING POINT, reachable at every granularity (asked 2026-08-25)

**The user's requirement, verbatim:** *"Le preflight doit permettre d'executer chaque phase, voire meme
chaque etape de phase ou groupe d'etape en ayant le meme point de depart, independamment de ce qui a pu
se passer avant"*, and before it *"tu peux recharger la page au debut de la phase au moment de l'etape
d'initilisation, ce serait beaucoup plus simple"* and *"Si le modal de pin s'affiche, tape le pin, s'il
ne s'affiche pas, ne le tape pas, si on est sur la mauvaise page, on peut recharger la page"*. It is
their standing directive - deterministic, reproducible, explicable - applied to initialisation.

**What is true today, measured 2026-08-25 rather than assumed.** `client()` opens a CDP connection and
guarantees NOTHING about the application: not the route, not the lock, not whether a modal is up. Of
23 sampled runners, **8 assert something at their start** (`ensureChat` or `goto`) and **15 assert
nothing at all** - `msg2`, `msg3`, `msg5`, `msg67`, `msg8`, `msg9`, `msg10`, `type`, `del1`, `comm2`,
`comm14`, `tab1` among them. They inherit whatever the previous script left, which is exactly what
`client()`'s own comment admits: *"Seventeen call sites pass no match at all and were relying on the
browser having one page - true after the preflight, and silently false the moment anything leaves a tab
behind."* The preflight does the work ONCE per run, so the guarantee decays with every script after it.

**The contract to write.** One exported entry point, idempotent, with an ASSERTED postcondition rather
than a described one:

- **The target state is named, not implied**: on `/chat`, unlocked, no overlay, chat mounted, on the
  deployed bundle. The same five facts `state.mjs` already reads.
- **It is cheap when already satisfied** - read the state first, act only on what diverges. That is
  what makes it affordable to call between step GROUPS inside a phase, which is the granularity asked
  for; a call that always paid a reload would be too expensive to put there.
- **The PIN is typed only if the gate is really up** (the user's wording exactly). Detected
  structurally: `#encryption-pin`, or a button whose text is the `U+232B` backspace glyph. Never by
  searching the page text - see the predicate entry below, which is what made a false lock permanent.
- **A wrong route is repaired by RELOADING, for a web client.** Not because a reload is a fallback -
  it is a REPAIR, logged loudly, and CLAUDE.md's rule stands: a fallback is a signal, never a path.
  Reaching it means the previous check left the client somewhere, and the log is what makes that
  visible.
- **A1 is excluded from the reload, by construction.** `goto` on the phone re-locks the PIN and breaks
  Tauri's IPC callbacks into the old document; `chat.mjs` throws rather than let a caller do it by
  accident. The phone keeps the repair path.
- **It says what it erased, before erasing it.** The existing repairs are loud on purpose - *"the day
  it is something else, the line is the only warning"* - and a check that leaves a modal up is a defect
  in that check. Silent tidying would delete the only evidence of it.
- **Then every runner calls it**, and `run.mjs`'s preflight becomes that same contract applied per
  device plus the run-wide checks (identity, bundle, server window). One definition, not two.

**Why it is worth the conversion cost.** [testing-methodology](testing-methodology.md) 33 says changing
what a check READS invalidates its green rows, and that is the argument that has deferred other
wholesale conversions. It does not bite here in the same way: the contract does not change what any
assertion measures, it makes the state BEFORE the assertion known. What it removes is a class of
failure the campaign has already paid for repeatedly - a check measuring behind a modal, on the wrong
route, or behind a PIN gate - each of which produced a refusal or a hang, never a false PASS. The rows
stay; the flakiness they cost goes.

### P3 - a build names itself by a clock, and the commit is inferred from it

`/_app/version.json` carries `Date.now()` at build time and nothing else, so `resolveStamp` derives
the commit by asking git for the newest one at or before that instant. Rule 35 fixed the half that
was outright wrong - a locally built bundle was being dated against `origin/main`, a ref that does
not contain it until somebody pushes - but the derivation itself remains an inference, and it moves
if a commit ever lands carrying an earlier date than the build that preceded it (a pull of somebody
else's work, a rebase).

**The fix is the bundle carrying its own commit**: SvelteKit takes `kit.version.name` in
`svelte.config.js` and writes it verbatim into `version.json`. Setting it to `<builtAtMs>-<sha>`
keeps the timestamp the `updated` store needs to distinguish two builds of the SAME commit, and adds
the identity the harness currently guesses. `resolveStamp` then parses instead of querying git, and
the `ref` argument disappears with it.

Two constraints, both established 2026-08-22 rather than assumed:

- **The Docker image does not build the frontend.** `infrastructure/local/Dockerfile.frontend` copies
  `frontend/build/client` from an artifact the CI `build-frontend` job produced, so git availability
  is a question about the CI job and the local Tauri build, not about the image. Both have a
  checkout.
- **It changes the deployment's version identity**, which is why it was not done during the campaign:
  prod IS the test server, and a `svelte.config.js` that throws when git is absent breaks every
  build including CD. Verify the CI job's checkout depth before relying on `git rev-parse`.

### P3 - six runners carry a dead import, and fixing them now would retire green rows

`oxlint tools/cross-client-harness/` reports eight warnings across `newgroup.mjs`, `msg9.mjs`,
`ckpt.mjs`, `type.mjs`, `tabguard-selftest.mjs` and `ws1.mjs` - unused imports and one useless
spread, nothing that changes what any of them measures.

**Deliberately not fixed during the campaign.** `msg9.mjs` and `type.mjs` back MSG and TYPE, both
green on the board, and `checkSha` hashes the runner's source: touching either supersedes its rows
(`rows.mjs`), so the ledger would demand a re-run of two finished phases to pay for a dead import.
Rule 33 is what makes that automatic, and it is right to be - the ledger cannot know the edit was
cosmetic, and a human waving it through is exactly the judgement the rule exists to remove.

Sweep all eight in ONE commit once the ladder is finished, when a re-run costs nothing. Note the
harness is NOT oxfmt-formatted (`oxfmt --check` fails on files nobody has touched), so the sweep is
`oxlint` only - running the formatter would rewrite the whole directory.

### P3 - the bubble-action and observation helpers live in one runner, and every other runner re-invents them

`mut.mjs` carries `clickBubbleIcon` / `deleteBubble`, which locate a message's controls by their
lucide icon class and prove the click was RECEIVED - its own header calls this "a pattern the rest of
the harness could adopt". `search.mjs` did not adopt it and hand-rolled a confirm click that pressed
the wrong button for as long as the check has existed (2026-08-22, see `CHANGELOG.md`). The same
split exists for observation: `longestSilence` turns a hole in a client's timeline into a value, MUT's
`finish()` attaches it to every non-PASS verdict, and no other phase does - which is exactly the
evidence rung 5's one SEARCH-2 miss needed and did not have.

**Why it is not done yet, and this is the whole reason it is written down.** The shared home is
`chat.mjs`, and every phase consults `chat.mjs`. Moving a helper there invalidates MSG, TYPE, READ and
MUT under [testing-methodology](testing-methodology.md) 33 - "a board row whose phase was touched
anywhere gets re-run rather than reasoned about" - which is hours of ladder time to buy a refactor
nothing is currently failing for. So it waits for a moment when the rig can be changed wholesale and
the affected phases re-run together, rather than being slipped in mid-ladder where it would silently
cost four phases their verdicts.

### P3 - eight runners open IndexedDB by hand, and `idb.mjs` exists

`idb.mjs` (2026-08-24) is the one reader that ITERATES the databases a profile holds, filters
`CanariDB_` while excluding `CanariDBMls*`, and never decrypts. It was written because `recon.mjs`
takes the FIRST database it finds, which on a two-account Chrome profile is a coin toss, and because
reaching into `CanariDBMls*` by prefix returns an empty result that reads exactly like "nothing
queued". Counted 2026-08-24, `indexedDB.databases` appears in nine files and one of them is `idb.mjs`: EIGHT
call sites still carry their own copy of the preamble (`del1`, `dismiss`, `grainestore`, `grp`,
`identity`, `mlsdb`, `mut`, `recon`), and `del.mjs` is the only phase reading through the module.

**Why the copies are deliberately still there.** Converting a caller changes what that caller READS,
and every one of them belongs to a phase already green on the board - so the conversion invalidates
those rows under [testing-methodology](testing-methodology.md) 33, exactly as the
bubble-helper entry above does. The duplication costs nothing while it is identical; it costs a phase
the day one copy is fixed and ten are not, which is the shape `recon.mjs`'s first-database bug already
had. So this waits for the same wholesale moment: convert all eight, re-run the phases together.

### P2 - re-registering the PIN verifier strands every other client SILENTLY, and only its next unlock finds out (measured 2026-09-04)

`pin_verifier` holds ONE row per user - verifier, salt, `registeredAt` - and minting a fresh device
re-registers it. The owner's row was re-registered at **15:32:11** during the P1 reproduction, when a
device was re-minted after a PIN reset.

**Nothing told the other clients, and nothing had to, for four and a half hours.** W1 was already
unlocked and holds its derived key in memory, so it kept sending, receiving and passing checks all
afternoon against material the server had replaced. The staleness became visible only at 20:15, when
TYPE-3 killed W1's tab and forced a fresh unlock: the correct PIN was then refused with *"Votre PIN a
ete change sur un autre appareil. Recuperez vos messages avec votre ancien PIN."*

**Why this is written down rather than fixed here.** Two of the three parts may well be correct. An
unlocked session keeping a key in memory is the design; the refusal message is accurate and names the
remedy. What is NOT obviously correct is the silence: a client whose vault material has been replaced
is, from that moment, one reload away from being locked out of its own history, and it is told
nothing while it can still act. The signal exists on the server (`registeredAt` moved) and reaches no
one.

**What it costs the campaign, which is the immediate cost.** `newdevice.mjs` is the HEAL-NEW runner
and re-minting is its whole job, so every HEAL-NEW row re-registers the verifier and strands W1 and
W2 at their next unlock - hours later, in a different rung, reading as a broken client. Its
`WIPEABLE` allowlist protects the profile it wipes and says nothing about the account-wide effect of
a PIN reset. **A destructive control needs an allowlist of what it may touch**, and the verifier is
outside the one it has.

**THE REPAIR IS KNOWN AND CHEAP, MEASURED 2026-09-04 21:27.** A stranded client is fixed by WIPING
it, not by recovering it: `bun newdevice.mjs --device W1` removed the stale local material, logged
back in with no human step, answered the account's current PIN, minted `...mtnci3lc-7mhd`, and
rejoined all four conversations plus the venue's distribution group by external commit, self-service,
inside a second. The two `pending` seats the old device held on Repro Alpha and Repro Beta went with
it - `READD ... roster seat with NO queued Welcome and NO add in flight - nobody owes us anything;
serving ourselves`. It does NOT touch `pin_verifier`, so the other clients are unaffected, which a
re-registration would not have left true. **What the wipe costs is the local history, and that is
already unreadable by the time anyone notices - so the repair is free exactly when it is needed.**

**Owed before this can be closed.** Whether the same digits re-registered produce a verifier the
other clients would accept (they did not here, so the refusal is about material rather than value);
whether the "ancien PIN" recovery restores a stranded client's MLS state or resets it, which decides
whether a stranded W1 is recoverable or must be re-minted; and whether production has ever put a real
member in this state - `registeredAt` beside each device's `lastSeen` would answer it from the table.

### P3 - a check that dies mid-gesture leaves a file staged in the composer, and the NEXT check sends it (measured 2026-09-04)

MSG-4 stages a file, types a caption and clicks send. When it died between those steps - which it
did all afternoon, on a fixture that did not exist - the composer kept the staged attachment. The
next runner opened the same conversation, typed its own text and sent, and the orphaned file went
with it. MSG-6 recorded `PASS-DIRTY` on `Erreur envoi media: A requested file or directory could not
be found`, an error about MSG-4's fixture, in a check that never attaches anything. Both rows came
back clean once MSG-4 stopped dying.

**Why this is the same fault the campaign already names.** `openDM`'s docblock states that a check
may not inherit a precondition from whatever ran before it, and every runner now navigates for
itself. The composer's staging tray is a piece of state that survives that navigation, so it is
exactly the residue the rule was written about, and nothing asserts it is empty.

**What would close it.** A staged-tray assertion in the shared entry point rather than in each
runner - the same shape as `clearOverlays`, which already runs at the top of `ensureChat` for the
same reason. It is P3 and not P2 only because the dirt is LOUD: it surfaced as a recorded
`PASS-DIRTY` naming a file the check does not use, which is a verdict pointing at its own cause.
The danger is the quiet version - a valid file staged by a check that then passes, sending an
attachment nobody asked for into a row about plain text.

### P3 - TWO out-of-tree directories are both called `canari-harness`, and a decoy `names.mjs` sits in the one the harness does not read (measured 2026-09-04)

The rig keeps its secrets and state outside the public tree, and two different directories now
answer to that description because two tools resolve the same name to different places:

| Reader | Specifier | Resolves to | Holds |
| --- | --- | --- | --- |
| `tools/cross-client-harness/names.mjs` | `../../../../canari-harness/` | `<parent-of-EMSE>/canari-harness/` | `names.mjs`, the three Chrome profiles, `results.ndjson`, `logs`, `test-accounts.json` |
| `tools/play-vitals/lib.mjs` | `../../../canari-harness/` | `<EMSE>/canari-harness/` | `play-console-sa.json`, `google-services.json`, `dumps`, AND a stale `names.mjs` |
| `infrastructure/local/pull-prod-dump.sh` | `$ROOT/../canari-harness/dumps` | `<EMSE>/canari-harness/` | the production dumps |

Both are live and neither is wrong on its own - `names.example.mjs` documents `<repo>/../../` and
`play-vitals/lib.mjs` documents `../canari-harness/`, and each is accurate about itself. What is
wrong is that they share a NAME while meaning different directories, and that the one the harness
does NOT read contains a `names.mjs` of its own: same filename, same shape, same constants, one
`VENUE` line apart. Editing it changes nothing and says nothing, which is exactly what happened
during the venue rename on 2026-09-04 - the edit landed, `grep` confirmed it, and the run kept
printing the old value.

**Why this is not fixed here.** Moving either directory breaks the other reader, and both hold
credentials and state (`play-console-sa.json`, the Chrome profiles) that a wrong move destroys - so
this is a one-off gesture on the user's own machine rather than a code change, and
[ONE-OFF ACTIONS GO TO THE USER](../../CLAUDE.md). The cheap half a session can do is make each
reader PRINT the absolute path it resolved, so a wrong edit is visible in the first line of output
rather than in a value that refuses to change. Note that `STATE_DIR` is already exported and has
three consumers, so the resolved path is available and simply never shown.

## Search

### P2 - the posts search escapes the feed's filters, and scans the whole base before it answers anything

Reported by the user 2026-08-23, verbatim: *"La recherche dans les posts permet d'acceder a des posts
apres notre arrivee a l'EMSE (la recherche desactive les filtres ?)"*. Three distinct things, and
they are not the same severity.

1. **The filters appear not to apply to the search.** The feed is scoped, the search is not, so the
   search surfaces posts the scoped feed would never show. **The first task is to establish what that
   scope IS**, because it decides everything: a scope that is a VISIBILITY rule makes this a P1
   (search reads what the reader may not read), a scope that is only a convenience narrowing makes it
   a P2 surprise. Do not write code before that question has an answer - `## Open questions` is where
   an unanswered one belongs, and this entry moves there rather than growing a fix if the answer is
   not immediate.
2. **The order is backwards: filter, THEN search.** Filtering downstream means the search spends its
   whole cost on rows that were never going to be displayed. Correctness aside, it is the same work
   done against a corpus several times larger than the reachable one.
3. **It loads everything before it answers.** A post from this week should not wait on a scan of the
   entire base. The search should walk backwards in time and stream what it finds, so a recent hit is
   returned early and the long tail keeps arriving - the standing requirement is that the mechanism
   works for a corpus of ANY size, and a single up-front load is the shape that cannot.

Related but NOT the same item: in-conversation (chat) search is the entry above; this one is the
social feed. MiGallery's `fuzzyScore`/`fuzzySearch` is the reference implementation the standing
search requirement points at.

## Composer and reactions

### P2 - the emoji picker cannot be scrolled, and often opens outside the screen

Reported by the user 2026-08-23. Two defects and two questions, and they are listed apart because
only the first two are known to be wrong.

- **The list does not scroll.** Whatever does not fit in the panel is unreachable, so the picker
  offers exactly one screenful of the set it claims to offer.
- **The panel frequently renders partly off-screen.** So this is not only a scroll bug: the placement
  has no viewport clamping, and near an edge the picker loses rows in a second, independent way.
- **ANSWERED 2026-08-23, NO: the glyph set is the platform's.**
  `frontend/src/lib/components/messages/MessageEmojiPicker.svelte` mounts `emoji-picker-element`,
  which renders native codepoints in the system font - there is no bundled sprite sheet. Only the
  DATA is self-hosted (`data-source="/emoji-data-fr.json"`, and that exists so French search keywords
  work: `locale="fr"` alone translates the UI and not the keywords). So one codepoint, N pictures -
  Windows, Android and iOS each draw their own, and the library even ships an
  `emojiUnsupportedMessage` for a client with no colour emoji at all. **The product decision this
  bullet said was owed was TAKEN on 2026-08-23: we bundle one set - see the entry below, which is
  one work package with this one.**
- **ANSWERED 2026-08-23, YES: recents exist** - `canari_recent_emojis` in `localStorage`, most-recent
  first, capped at 12, rendered as a row above the picker. Two limits worth knowing before anyone
  "adds" the feature: it is PER DEVICE and never synced, and it is fed only by
  `handleEmojiClick`, so a reaction added by any path that does not go through this picker never
  reaches the list.

**The likely cause of BOTH defects is one line, and it is the same line.** The panel is
`flex flex-col overflow-hidden` with a `max-height` written by `bindFixedPopover`
(`frontend/src/lib/actions/fixedPopover.ts`), and the `<emoji-picker>` inside it already carries
`min-h-0 flex-1` - which is exactly the arrangement that sizes correctly on its own. It is then
overridden by an inline
`style="height: min(22rem, calc(var(--popover-max-h) - {recents ? '5.5rem' : '3rem'}))"`. That
subtraction is a HARD-CODED GUESS at the height of everything above the picker, and the recents row
is `flex-wrap` with up to twelve 32 px buttons plus a label inside a `min(92vw,22rem)` panel - so it
wraps to two lines well before twelve, and the guess is then short by a whole line. The picker is
sized taller than the room actually left, the parent is `overflow-hidden`, and the bottom of the list
- with its scroll affordance - is clipped away. **The fix is to delete the inline height, not to
correct the constant**: the flex layout already knows the answer, and a second hard-coded number
would be wrong again the next time the header gains a line (the reactions-at-limit banner is exactly
such a line, and it is not in the guess either).

A second, narrower placement fault is in `computeFixedPopoverPosition`: `maxHeight` is floored at
`Math.max(160, ...)` after the side has been chosen, so on a short viewport the panel can be given
160 px in a gap smaller than 160 px and hang off the bottom. The floor should not be able to exceed
the space that was measured.

Both defects are visible without any instrument, so this needs no campaign row to be believed - but
the picker sits on the reaction path that DEL, MUT and MSG all drive, so fixing it mid-ladder changes
code under checks that have already run. Schedule it after the ladder unless the user says otherwise.

### P2 - the app draws emoji with the platform's font, and must draw ONE bundled font everywhere (decided 2026-08-23)

**Decided by the user on 2026-08-23, and the weight is explicitly NOT a factor** (their words: the
size does not enter the decision). Canari bundles **Noto Color Emoji** and draws every emoji with it,
in the whole app and the whole site, on every platform. This is the product choice the third bullet of
the picker entry above said was owed.

**It is ONE work package with the picker fixes, not two** - the user's framing, and it is structurally
right: the picker is where the set is OFFERED and the app is where it is DRAWN, so offering what the
font cannot draw, or drawing what the picker never offers, is a single defect seen from two ends. The
picker's scroll and placement faults are described in the entry above and are not restated here.

Microsoft's Fluent Emoji was examined first, on 2026-08-23, and **rejected on coverage, not licence**.
It is MIT (copyright Microsoft Corporation, no trademark clause in the repository), so it would have
been legally clean. Measured on its git tree: 1 595 base emoji, 3 145 variants, **zero country flags**
(the only "flag" assets are Black, White, Chequered, Triangular, Crossed, Pirate, Rainbow,
Transgender and Flag-in-hole), **no family / couple / people-holding-hands ZWJ sequences** at all, and
frozen at Unicode 15.1 (its Emoji 15.1 merge is from 2024-10-02, its last commit 2025-01-30). It also
ships no font whatsoever - 12 625 files: 3D PNG 109.7 MB, Color SVG 131.9 MB, Flat SVG 17.2 MB, High
Contrast 6.4 MB. A set with no flags cannot be THE set for a French student association.

#### Why Noto, in numbers

`googlefonts/noto-emoji`, OFL 1.1, last push 2025-09-15. Measured on its git tree 2026-08-23:

- `svg/` holds **3 732 glyph sources**, of which **2 291 are multi-codepoint sequences** (ZWJ
  families, couples, professions, skin tones). Country flags live in `third_party/region-flags`, and
  the prebuilt fonts prove they are shipped: `Noto-COLRv1.ttf` 4.7 MB **with** flags against
  `Noto-COLRv1-noflags.ttf` 2.8 MB, plus a `NotoColorEmoji-flagsonly.ttf` of 0.8 MB.
- **It is level with the picker's own dataset.** Probed by codepoint: every Emoji 16 addition
  (fingerprint, leafless tree, root vegetable, splatter, harp, shovel) and every Emoji 17 sample
  taken (distorted face, orca, trombone, treasure chest) is present. That is what makes "the picker
  offers exactly what the app can draw" an achievable requirement rather than an aspiration.
- **Licence.** OFL 1.1 permits embedding in the APK/AAB/IPA/AppImage and permits modification
  (subsetting, rebuilding). The header declares `Copyright 2013 Google LLC` with **no Reserved Font
  Name**, so a rebuild does not force a rename. Two real obligations: the OFL text travels with the
  binary, and the font is never sold on its own. One notch more verbose than MIT, no practical effect
  here, and compatible with a public repository.

#### The format is the whole difficulty, and it has a solution

No single colour-font table covers both engine families, and Canari ships on both:

| Table | Chromium: WebView2 (Windows), Android WebView, Chrome/Edge | WebKit: WKWebView (iOS, macOS), Safari | Firefox |
| --- | --- | --- | --- |
| **COLRv1** | yes, 98+ | **no** - not implemented, and marked not in active development (WebKit standards-positions 415) | yes, 107+ |
| **OT-SVG** (`SVG` table) | **no**, ever | yes - Safari 12.1+, iOS Safari 12.2+ | yes, 31+ |

The two are exactly complementary, and **they fit in one file**. `maximum_color`, from
`googlefonts/nanoemoji` (Google's own tool, the one that builds Noto), adds the `SVG` table to a COLR
font and the reverse; its stated intent is "a font that will Just Work in any modern browser". Each
engine reads the table it understands, from a single `.woff2`. Where a two-file split is preferred
instead, the selector is `src: url(...) tech(color-COLRv1), url(...) tech(color-svg)`, with
`@supports font-tech()` available since Safari 17 for the awkward case.

Three things that must not be got wrong:

- **Do not pass `--bitmaps`.** Chrome and anything on Skia *prefers* CBDT to COLR when both tables are
  present (nanoemoji says so, over Skia 12945 and FreeType 1142), and CBDT is the 10.1 MB build.
  Weight is not a factor by the user's decision, but rendering the WRONG table is a defect.
- **nanoemoji describes itself as "under active development, doubtless full of bugs".** So it is not a
  CI dependency: build ONCE, commit the produced `.woff2`, and record the exact command plus the
  expected hash so the artefact is reproducible without the toolchain being installed anywhere. This
  is the opposite disposition to `frontend/src/lib/wasm/`, which is generated and not committed
  precisely because every pipeline can build it; nothing in CI can build this one.
- **Serve it from our own origin**, never Google Fonts: a third-party font host leaks the IP of every
  member and cannot work offline in the Tauri apps.

**WebKitGTK was the one target that may read neither table**, and **it is no longer a target at
all** - the Linux desktop build was dropped 2026-09-03
([cicd](cicd.md#the-linux-desktop-build-is-suspended-not-lost-2026-09-03)), so
this row owes one fewer verification than it did. Kept because it returns with the target: WebKitGTK
goes through FreeType/Skia and WebKit bug 191976 ("[FreeType] Color emoji not properly supported")
is still open. It was also the only target where the failure was free - the system emoji font on
Linux **is** Noto Color Emoji, so the fallback drew the same pictures. Never design around it; if
the desktop target comes back, verify it once on a real build.

**And note what this is, under the standing rule that a fallback is a signal and never a path**: a
font stack IS a fallback chain, so "it looks right" is not a verdict. The question is always *which
family resolved*, and that is measurable - see the campaign rows below.

#### What has to change in the app

- **The two global stacks are the whole of it, and neither has an emoji fallback today**, which is why
  100 % of emoji are currently the platform's: `frontend/src/app.css:134` (`body`) and
  `frontend/src/app.css:144` (`h1`-`h6`, `.font-brand`). Append the bundled family to both.
- **The picker uses the same family or the app disagrees with itself.** `emoji-picker-element` 1.29.1
  exposes `--emoji-font-family` on the element; that is the entire change on that side.
- **Every stack that is re-declared for an EXPORT is a place the screen and the artefact can
  disagree**, and each one must be handled explicitly: `PosterCanvas.svelte` (4 inline stacks),
  `calendarExport.ts`, `trombinoscope.ts`, `avatar.ts` (an SVG data-URI stack), and
  `MentionComposerInput.svelte:399` (monospace).
- **A PDF is not a browser.** `frontend/src/lib/pdf/appFonts.ts` maps a computed stack plus a weight
  onto an embedded jsPDF font, so an emoji in an exported PDF is a separate question this WP owes an
  answer to (embed, or rasterise). The CSS change does not cover it.
- `font-display: swap` plus a preload, and the font shipped as a bundled app asset so the mobile
  builds have it at first paint with no network. An invisible emoji while a font loads is worse than a
  platform emoji.

#### The picker must offer exactly what the font can draw

- **What it offers today**: `frontend/static/emoji-data-fr.json`, 540 KB, emojibase FR, **1 923 base
  entries / 3 953 including skins**, groups 0-9 all populated (270 flags, the France flag present,
  249 ZWJ entries), with `version` values up to **Emoji 17**.
- So the offered set and Noto are level, and the WP owes a **build-time diff that proves it**: every
  codepoint and every sequence in the dataset must resolve to a glyph in the shipped font (`cmap`
  plus the `GSUB` ligatures that make a flag or a ZWJ family one glyph). It belongs in the build
  recipe, not in a one-off notebook. A miss is then either a font to rebuild or an entry to drop -
  either way a known fact, not a surprise on a member's screen.
- **DEFECT FOUND WHILE SCOPING THIS, and it is the "offers everything" half.**
  `MessageEmojiPicker.svelte:256` reads
  `data-source={getLocale() === 'en' ? undefined : '/emoji-data-fr.json'}`, and `undefined` means the
  element's default, which is
  `https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json`
  (`picker.js:1649`). So on the English locale the app fetches its emoji data from a third-party CDN -
  an outbound request, hence an IP leak, for every user who opens the picker; the picker cannot open
  offline, which is fatal in the mobile apps; and `@^1` pins nothing, so the offered set changes under
  us, which is exactly the non-determinism the standing directive forbids. **Self-host the EN dataset
  the way FR already is, and pin both.**
- `emojiUnsupportedMessage` is shown by the library when it detects no colour-emoji support at all.
  Once a font is bundled, decide whether that state is still reachable (WebKitGTK is the only
  candidate) and delete the string if it is not - a message nothing can display is noise in
  `messages/*.json`.

#### What a future campaign owes - asked for by the user on 2026-08-23

These are rows for the **second campaign** (see that entry below); they are listed here, once, and are
not restated there. Every one names the evidence it rests on, because "the emoji looked fine" is not
an observation.

1. **The bundled family actually resolved**, per platform, on W1, W2 and A1 - plus an iPhone when one
   exists. `document.fonts.check()` is necessary and not sufficient: it answers "loaded", not "used".
   The verdict rests on a rendered-pixel comparison of one known codepoint against the same codepoint
   with the platform family forced. **Identical pixels mean the bundled font did NOT apply.**
2. **The same codepoint is the same picture on every device.** One message carrying a v1 emoji, a
   country flag, a ZWJ family, a skin-toned person, an Emoji 16 and an Emoji 17 addition; compare the
   rendered bubble across W1, W2 and A1. Cross-device identity IS the point of this WP, so this is the
   row that fails if the font silently did not load on one client.
3. **A flag and a ZWJ sequence render as ONE glyph**, not as two letters or five people. This is the
   row Fluent would have failed outright, and a font built without its `GSUB` fails it too.
4. **The whole set is reachable in the picker**: scroll to the last row of the last group, on a short
   viewport, with the recents row both empty and full - the two states whose heights differ, which is
   the arrangement the picker entry above traces the clipping to.
5. **The panel is entirely inside the viewport** at each anchor: first message, last message, a row at
   the top edge, one at the bottom, on the own side and the peer side.
6. **French search still finds things** (the FR dataset is load-bearing for keywords) **and English
   search works with the network off** - the row that would have caught the jsdelivr default.
7. **Pick, send, peer**: the codepoint the peer receives equals the one picked, and it is still a
   CODEPOINT - copy the text out and assert on it. That is the proof the app stayed on the font path
   and did not drift into image substitution.
8. **A reaction** carrying a flag and a ZWJ sequence survives the round trip, including the
   distinct-reaction limit path.
9. **The notification shade is drawn by the OS**, so an emoji in a notification body uses the SYSTEM
   font and will not match the app. Assert what it does; do not assert that it matches.
10. **Exported artefacts**: an emoji in a poster, a calendar and a trombinoscope export. Whatever this
    WP decides for PDF, the campaign asserts it.
11. **Cold start, offline, on A1**: open the picker with no network and confirm the set is complete AND
    that no request left the device - an assertion about the absence of an outbound request, which the
    harness's server window can support.

#### Limits to state before anyone reports them as bugs

- **The notification shade, the OS share sheet, the keyboard's own emoji panel and every other native
  surface are drawn by the platform.** Bundling a font changes nothing there. "The notification shows
  a different emoji" is then expected behaviour, not a regression.
- A member on an Android WebView older than Chrome 98 gets neither table and falls back to the system
  emoji font - which on Android is Noto anyway, so the picture is unchanged. `minClientVersion` is not
  the lever for this.


### P3 - 37 arbitrary Tailwind values have a canonical spelling, and only the IDE says so (measured 2026-09-04)

`flex-shrink-0` (37 occurrences across 20 components), `rounded-[1.5rem]` -> `rounded-3xl`,
`h-[3.25rem]` -> `h-13`, `z-[260]` -> `z-260`, `md:w-[28rem]` -> `md:w-md`. Ten of them sit in
`ChatGroupPanel.svelte` alone.

**Nothing in the repository reports these.** `bun run check` answers `0 ERRORS 0 WARNINGS` on 8128
files and `oxlint` is silent; the only thing that names them is the editor's Tailwind plugin, which
means they are invisible to CI and to any session not looking at that file in an IDE. That is the
part worth fixing first - a rule enforced by a tooltip is not enforced.

**It is ONE sweep, and it must not ride along with an unrelated change.** Three of them are in the
files the SYNC-badge fix touched and were deliberately left: correcting three of thirty-seven inside
a behaviour PR produces a file that disagrees with its twenty neighbours and hides the real diff.
Wants doing with the four other items that each want one pass over `app.css` (queue item 7), and the
gate that would keep it fixed - a lint rule in `bun run check` - is the deliverable, not the
replacement.

### P3 - the two controls on a device row do not look like the same kind of thing (reported 2026-08-25)

**Reported by the user with a screenshot**: *"Petite note graphique, il faudrait homogeneiser la
corbeille et la modification."* On a device row the delete control is a filled rounded square and the
rename control is a bare pencil floating under the text, so two controls of equal standing read as one
button and one decoration.

The divergence is entirely in two class lists in `DeviceManagementPanel.svelte`, and it is every axis
at once rather than a single oversight:

| | rename (`Edit2`) | delete (`Trash2`) |
| --- | --- | --- |
| resting background | none | `bg-black/5` / `dark:bg-white/5` |
| radius | `rounded-lg` | `rounded-xl` |
| padding | `p-1.5` | `p-2.5` |
| icon | `size={14} strokeWidth={2}` | `size={18} strokeWidth={2.5}` |
| press feedback | none | `active:scale-95` |

**Where they may legitimately still differ: colour.** The destructive one hovers red, the rename one
amber, and that is the distinction worth keeping - a trash can and a pencil should differ by INTENT,
not by whether they look clickable.

Two things to settle before touching it, because neither is answerable from the row alone:

- **The same pair exists elsewhere.** A homogenisation that only fixes this panel trades one
  inconsistency for another, so the fix is a shared class (or a `.btn-glass` modifier - `app.css` is
  the single source of truth for tokens and `--radius-*`, CLAUDE.md) applied at every site, and the
  audit of those sites is part of the work.
- **The rename control also sits in a different place in the layout** - inside the text block, after
  the version line - while the delete button is a sibling of the whole row. Matching their appearance
  without settling their POSITION will just move the question.

Grouped with the emoji-picker geometry and the bundled-font work above: all three are user-reported
appearance items, all three are post-ladder, and all three want the same pass over `app.css` rather
than three local patches.

## Storage and retention

### P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

`saveMlsStateEncrypted` refuses any tagged write whose version is not strictly newer than the stored
one. The version comes from `tagMlsSnapshot`, which is `++_snapshotSeq` - a module-level counter,
and therefore **one counter per DOCUMENT**, seeded from the persisted version by
`seedMlsSnapshotSeq` when the tab loads.

Within one tab this is exactly right and is what the guard was written for: a slow off-thread Argon2
flush finishing after a fresher one must not clobber it, and there `version < stored` is a true
statement about ordering.

**Across two tabs it is comparing two unrelated sequences.** Both tabs load, both seed from stored
version *N*, and both then produce *N+1* for their next snapshot - different bytes, same number. The
guard sees `version <= stored` and drops the second one. Measured on TAB-4, which drives two tabs of
one client: `Skipping stale MLS state write (v3294 <= stored v3294)` on an ordinary run.

**What is not yet answered is whether anything is LOST.** The dropped snapshot may hold state the
winner does not - the second tab may have processed a frame the first had not - and the counter
cannot say, because it is not a clock over the pair. In practice a later flush from either tab
carries a higher number and lands, so the state is expected to converge; that expectation is
untested and the window is unmeasured. **A clock written by one writer is not evidence about
another's ordering** - the same rule as a liveness column written by something other than the thing
whose liveness it measures.

The wording is already fixed (2026-09-05): the collision case says so instead of claiming staleness,
and `hex.mlsVersion.test.ts` pins both branches. That makes the event visible; it does not decide
it. Deciding it means either making the version a shared counter (a `BroadcastChannel` claim, or an
IndexedDB read-modify-write inside the same transaction as the put - the transaction is already
there) or establishing that convergence always happens and how long it takes.


The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

## Payments

### P2 - the payout estimate is Stripe's fee schedule, now rendered under provider-neutral wording

Opened 2026-08-30 by the pass that removed Stripe's name from everything it did not own
([payments](frontend/modules/payments.md#where-a-providers-name-may-appear-and-where-it-may-not)).

`frontend/src/lib/payments/stripeFees.ts` hard-codes Stripe's French pricing (a percentage plus a
fixed cent amount) and `StripeNetPayoutHint.svelte` renders the result. Both keep the vendor's name,
deliberately - the arithmetic really is Stripe's, and a neutral name there would be the lie. **What
changed is the copy above them**: `payout_hint_fees_note` no longer says Stripe, so the number now
presents itself as "what you will receive" whoever is processing.

While `payment_provider` is `stripe` the estimate is correct and nothing is wrong today. The day
WP-LYDIA-1 flips it, the hint keeps quoting Stripe's schedule for a Lydia payment, and a treasurer
has no way to tell. **This is not fixed by renaming anything** - the fee schedule is a per-provider
FACT, so it belongs behind the same seam the rest of the provider already sits behind: either
`PaymentProvider` exposes its schedule, or the hint asks `GET /api/payments/provider` (already live,
already consumed by the association edit page) and picks. The second is cheaper and needs no server
change; the first is right if a third provider ever appears.

**Its blocking condition is the same as WP-LYDIA-1's**, and deliberately so: Lydia's real fee
schedule is part of the credentials Lydia still owes, and inventing a placeholder here would ship a
second wrong number rather than none. Do it in the same work package.

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: the **credentials**
and the **answers Lydia owes**. Everything that does not map - live balance and status, saved payment
methods - throws a documented error rather than faking a result, and that is deliberate: Lydia has no
live status-poll endpoint, and the saved-card flow was **explicitly dropped by the user** rather than
reimplemented, so every purchase becomes its own interactive request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at.

**2026-08-19: onboarding storage coexists (see [core-service#payments](services/core-service.md#payments-stripe--lydia)),
and checkout routing now does too.** `resolvePaymentTarget` (`payment-delegation.util.ts`) takes the
active provider as a parameter and resolves against the matching column pair; `AssociationsService`/
`ProductsService` fetch it from the public `GET /api/payments/provider` before resolving, and let a
failure to reach core-service propagate rather than guess. `PaymentTarget.connectAccountId` (renamed
from `stripeAccountId`) now genuinely holds whichever provider's account is active. A Lydia
`request/do` payment is also confirmed server-side now: `confirm_url`/`cancel_url`/`expire_url` are
registered per-request, and `POST /api/payments/lydia-request-callback`
(`webhook.controller.ts`) verifies the signature and fans out to the same submission/purchase
fulfillment Stripe's webhook already used, via a shared `order_ref` encoding
(`form:<submissionId>` / `product:<productId>:<userId>`, parsed by `lydia-order-ref.ts`).

**Two things still block actually flipping the switch, both found while wiring this:**
1. **`payerRecipient` is never supplied.** `LydiaPaymentProvider.createCheckoutSession` throws
   without it (`request/do` needs the payer's email/phone), and nothing in `products.service.ts`/
   `forms.service.ts` resolves one - the interface field has existed since Phase 2 but no caller was
   ever wired to it. Needs a design decision on where the payer's email comes from for a boutique
   purchase (a logged-in user's account has no email stored in social-service today; only forms with
   a guest `input.email` field have one at all).
2. **The `business/create` `BUSINESS_VALIDATED`/`BUSINESS_UNVALIDATED` webhook is deliberately not
   built.** It has no documented signature and `vendor_token` is PUBLIC - building it as-is would let
   anyone knowing another association's vendor_token forge or break its `lydiaOnboardingComplete`,
   with no resync since Lydia sends the event once. Add "does `business/create`'s `webhook` param
   have a signature scheme?" to Livrable A below before building this.

---

### P3 - an admin who never joined a private salon is not told when it is deleted

`channelAudience` is the salon's roster, and since 2026-08-19 an administrator reaches a private
salon by JOINING it rather than through `workspace.manage` - so one who has not joined is not on the
roster and receives no `channel.deleted`, nor any other event the salon emits. They ARE shown that
the salon exists (name only, `viewerHasAccess: false`), so their sidebar keeps a row for something
that is gone until their next load.

**Not fixed by widening the audience**, which is the obvious move and the wrong one: that is exactly
what put every private salon's messages, typing, pins and poll tallies on the socket of members the
same server refuses to serve them over REST, and it was closed this week. The shape that would work
is a separate, contentless `channel.gone` addressed to the community - worth doing only if the stale
row is ever seen to matter, since a reload clears it and nothing is wrong underneath.

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

**Play's requirement, verbatim in substance:** an app that supports user sign-in, optional or
mandatory, must support Zero-Tap Sign-In restoration when the user moves to a new Android device.
Mobile and tablet only. Games are exempt; Canari is not. Enforcement begins **April 2027**. Three
exemptions exist and none obviously fits us: a Block Store integration completed by **30 September
2026**, enterprise or permanently-private apps, and a regulatory exemption requested for
financial/healthcare mandates.

**The mechanism is the Restore Credentials API**, and a restore credential is a system-managed
WebAuthn public key credential - a passkey the user never sees, tied to the package name, created
silently after sign-in, backed up with the device and readable on the new one during setup. It is
`androidx.credentials`, minimum Android 9 (our minSdk is exactly 28, so every install qualifies),
GMS core 24220000 or higher. **It works regardless of `android:allowBackup`**, which matters here:
the credential lives in the system credential store, not in app data, so it is orthogonal to the
device-transfer exclusion shipped on 2026-08-26 and does not reopen it.

**What this costs is a server we do not have.** `grep` over `apps/core-service/src` for `webauthn`,
`passkey`, `publicKeyCredential` and `fido` returns NOTHING: there is no WebAuthn registration or
assertion endpoint anywhere, and a restore key needs both - a `PublicKeyCredentialCreationOptions`
to create, an assertion to verify, and a store that keeps restore keys distinguishable from real
passkeys. Canari's session model is an opaque refresh row plus a stateless 1 h access token
([sessions](sessions.md)); a successful assertion has to mint exactly that pair.

**THE PRINCIPLE IS DECIDED - THE USER ACCEPTED IT ON 2026-08-26, AND THE WORK IS SCHEDULED AFTER
THE CAMPAIGN.** The question put to them was not technical: zero-tap means the new device is signed
in with no password and no second factor, and Google's documentation states plainly that the API
"does not handle multi-factor authentication", while Canari has 2FA and SETUP-4 exists because
re-enrolling a device costs one. It was accepted on the ground below - a restored session
authenticates, it does not decrypt - and because the exemptions on offer (enterprise, permanently
private, financial or healthcare regulation) do not describe a student messaging app, so refusing
would have risked a publication block rather than bought time. **Do not re-open the principle; what
is open is the build, and it does not start before the ladder reaches the bottom.**

**What it does NOT restore, and why that is fine.** Keystore material is non-exportable, so the MLS
device key does not travel. A zero-tap sign-in authenticates; it does not decrypt. The new device
still enrols as a new MLS client and is re-invited, exactly as
[frontend/backup](frontend/backup.md) already describes for a restore onto a different device. The
feature is therefore coherent with E2EE - it removes a password prompt, not a re-enrolment.

**Three traps to carry into the work when it is scheduled:**

- **The logout half is a requirement, not a nicety** - Play requires the restore key be deleted when
  the user signs out. Canari's logout lives in TypeScript, so this needs a Tauri command down to
  `ClearCredentialStateRequest(TYPE_CLEAR_RESTORE_CREDENTIAL)`, and it must run on the paths that
  log out WITHOUT a user gesture too - a 401/403, a revoked session.
- **The library is `1.7.0-alpha03` at the time of writing.** An alpha is not shippable on the
  release track here; check for a stable line before starting, not after.
- **`E2eeUnavailableException` is expected, not exceptional** - it fires when the user has no screen
  lock or no Google backup, and the documented handling is to retry with `isCloudBackupEnabled =
  false`. That is a second path, so it is logged at a level that accuses and its rate is measured
  before anyone believes what it says.


## Tooling

### P3 - the one-shot history audit can never discharge a group that needed nothing, so it re-lists the same groups on every connection (observed 2026-09-05)

Read out of PIN-9's report, which is clean and carries the two lines as `notable`:

```
[HISTORY_RECONCILE] no sweep - away 0 d, inside what the server keeps; auditing 7 group(s) that never have been
[HISTORY_RECONCILE] reconciliation pass complete - 0/7 group(s) asked in 0 ms
```

`groupsOwingAudit` returns every local group not in the device's audit record, and
`noteGroupsAudited` is called with *"the groups a probe actually LEFT for"* - `reconcileGroup`'s
`true`. That is deliberate and its docstring says why: a group whose members were all offline was
DEFERRED, not audited, and marking it would discharge an audit that never happened.

**But `reconcileGroup` returns `false` for at least six different outcomes, and only some of them
are deferrals.** `isDistributionGroup` (a group that can never be audited at all),
`recentlyAsked` (the coalescing window - it was audited, moments ago), and *"every reachable member
has stated its coverage - nothing more to ask"* are all COMPLETED work; *"no probe sender yet"* and
*"could not reach the service"* are genuine deferrals. The boolean cannot tell them apart, so a
group in the first set is never marked and is listed again on every connection for the life of the
device. This is the file's own rule about durable state turned on itself: **a column is only
evidence for the question it was written to answer**, and `askedGroups` was written to answer *"did
a probe leave"*, not *"was this group audited"*.

`0 ms` for seven groups says these seven exited at one of the two guards before the first `await`,
so the likeliest population is distribution groups - which would make the line permanent and
un-dischargeable rather than merely repetitive. **That is the measurement this item owes**, and it
is one log line away: name the reason per group, then decide between excluding
`isDistributionGroup` from `groupsOwingAudit` and returning an outcome instead of a boolean.

**Why it is P3 and not P2:** nothing is left unrepaired - the groups that owe a real audit still get
one, which is the direction that matters. What it costs is a pass and two log lines on every
connection for ever, and **a line its reader learns to skip is the one that hides the next defect**.

### P3 - "unlock the PIN through the CLI" is written three times in the rig, and all three had to be fixed separately (measured 2026-09-05)

`phone.mjs:unlockPin`, `archive/notif7.mjs:unlock` and `archive/tab236.mjs:unlock` are the same
wrapper around `pin.mjs`, differing only in which device they name and which origin they match. They
were written independently, and on 2026-09-05 all three carried the same two defects: the script was
spawned by BARE NAME (so two of the three resolved it to `archive/`, where it does not live, and did
nothing at all while reporting a string), and the failure was reported from STDOUT, the one stream
that cannot say why. Both were repaired in each copy, one at a time - which is the shape the rule
about re-implemented CLI predicates already names.

`atoms.mjs` is the home that exists for this and says so in its own docstring: *"ONE SPELLING OF THE
ARGUMENTS, IN ONE PLACE."* The three copies simply predate it. The change is `unlockPin({ port,
account, match })` there, returning `{ ok, line, why }`, with the three sites delegating - and it is
P3 rather than P2 because the defect is gone and only the duplication is left.

**It is not free**: `atoms.mjs` and `phone.mjs` are in the instrument set of nearly every runner, so
the change ages a large part of the ledger. It belongs between rungs, or after the campaign.

### P3 - `scripts/` is the one shell directory CI does not shellcheck, and it holds the release's first step (measured 2026-09-03)

`ci.yml`'s shellcheck step globs `.github/scripts/**`, `infrastructure/dev/*.sh` and
`infrastructure/deploy/*.sh` - and, since 2026-09-03, `scripts/bump-app-version.sh` by name, because
that file is the first thing a release runs and it was rewritten that day. **The rest of `scripts/`
is still unchecked**, and running shellcheck 0.11.0 over it by hand found:

| file | findings |
|---|---|
| `check-oidc.sh` | SC1090 (non-constant `source`), four SC2015 (`A && B \|\| C` is not if-then-else) |
| `deploy.sh` | SC2046 - unquoted `export $(cat .env \| xargs)` |
| `print-android-app-link-fingerprint.sh` | three SC2154 - `keyAlias`, `storePassword`, `keyPassword` referenced but never assigned in the file |

None is obviously a live defect - the last three come from a `keystore.properties` sourced at
runtime - but the last one is the shape that bites: a variable shellcheck cannot see assigned is
also a variable a typo would silently empty, in a script that signs an Android release.

Retired by: fixing or annotating each, then widening the glob to `scripts/*.sh` so the directory
cannot regain findings. Deliberately NOT done in the same commit as the workflow migration: it is a
cleanup pass over five unrelated files, and mixing it in would have hidden it.

### P3 - CI pins shellcheck 0.10.0, so a local run with a newer one disagrees (measured 2026-09-03)

Installing shellcheck locally (0.11.0) reported two SC2329 findings CI never sees - "this function
is never invoked" on the `psql` stubs in `deploy-migrations.test.sh`, which exist to be called from
`eval`ed code. They are annotated now, so the two agree again, but **the class stays open**: the
pin is a sha256 in `ci.yml` and nothing tells a developer which version to install, so the next
divergence is found the same way - by a local run disagreeing with a green pipeline, or worse, by a
green local run disagreeing with a red one.

Retired by: naming the version somewhere a human reads before installing it (the development page,
or a `.tool-versions`-shaped file), so "what CI runs" is not something you learn by failing.

### P3 - the root `load` warns on every navigation that it used `window.fetch`, and the fix it asks for buys nothing here (measured 2026-09-03)

The dev server prints, once per navigation:

```
Loading http://localhost:1420/api/auth/refresh?clientVersion=0.14.15 using `window.fetch`.
For best results, use the `fetch` that is passed to your `load` function
```

It comes from `frontend/src/routes/+layout.ts`, whose silent-refresh path calls `refresh()` in
`$lib/stores/auth.ts:424`. **The warning's two reasons do not apply to this app.** SvelteKit asks for
the injected `fetch` so that a SERVER render forwards cookies and so that the response is inlined
into the HTML and not re-fetched at hydration - and this root layout declares `export const ssr =
false` (Tauri needs SPA mode), guards itself with `if (typeof window === 'undefined') return`, and
therefore never runs on a server. There is no render to forward for and no hydration fetch to
deduplicate.

What it WOULD cost to silence: `event.fetch` threaded from the load into `refresh()`, from there
into `apiFetch`, and into `fetchUserProfile` - a `fetch` parameter through the auth and user stores,
for a warning about a case the app has ruled out. **That is why it is P3 and not simply "fix it":
the honest disposition is either that thread or a decision to accept the line, and accepting a line
is only allowed once somebody has written down why**, which is what this entry does.

Retired by: `ssr = false` disappearing from the root layout (then the fix becomes required, not
optional), or by SvelteKit offering a per-call opt-out.

### P3 - the local WebSocket closes 1006 on navigation, and nothing says whether that is the unload or a defect (observed 2026-09-03)

`[WS] Disconnected. Code: 1006, Reason: no reason`, twice, between two full page navigations on the
local estate. 1006 is an ABNORMAL closure - the code a browser synthesises when no close frame
arrived - which is also exactly what a page unload produces, so **the line cannot distinguish the
benign case from a gateway dropping the socket.** That is the defect worth fixing whether or not the
underlying close is: a log line whose reader must guess is one they learn to skip. Measure it by
closing the socket deliberately on `beforeunload` and seeing whether 1006 stops; if it does, the
remaining 1006s are real and mean something.

### DONE 2026-08-31 - all four repos carry the ceiling, the sweep and the dispatch

**Canari's `dependabot-auto-merge.yml` merged any green Dependabot PR with no ceiling at all, its
merges reached CD not once, and it could only ever act on an event it happened to catch.** The
workflow was the same file in all four repositories - it had been copied - so all four had all
three defects. All four are fixed. What is NOT yet proven is in the row below the table.

| Repo | Its ceiling | Does an auto-merge deploy? | Can it drain a queue it did not watch open? |
| --- | --- | --- | --- |
| **Canari** | the at-rest trio, the protocol crates, `aes-gcm`, the SFU stack | yes, an explicit `workflow_dispatch` on `deploy.yml` | a full sweep on every CD completion, plus an hourly cron at :17 |
| **Sky** | EMPTY, measured - all three candidates closed by writing the test | yes, `deploy.yml` dispatched, its `verify` job re-running CI on the merged tree | a full sweep on every `CI (Bun)` completion, plus a cron at :17 |
| **MiGallery** | `jspdf`/`jspdf-autotable`, `form-data`; `sharp` closed by `tests/face-crop.test.ts` | yes, `deploy.yml` dispatched; its `run-ci` job already gated `build-image` | a full sweep on every CD completion, plus a cron at :23 |
| **Portail-etu** | EMPTY, measured - both candidates closed by writing the gate | yes, `deploy.yml` dispatched, with a new `verify` job so the dispatch is no longer ungated | a full sweep on every `Run Tests` completion, plus a cron at :41 |

**THE CONVERGENT HALF WAS A CLOCK, AND THE CLOCK DOES NOT FIRE.** Measured 2026-08-31 17:00 UTC:
`event=schedule` had produced **zero** runs of `dependabot-auto-merge.yml` in ANY of the four
repositories, and Canari's `17 * * * *` had been on `main` since 14:32 UTC, so two slots passed with
nothing. None of the four is a fork, none is archived, every workflow reads `state=active`, and
schedules plainly work in these repositories - Canari alone has 183 scheduled runs of other
workflows. **The cause is delivery, not configuration:** `code-analysis.yml` asks for `0 2 * * *`
and actually ran at 03:01, 03:09, 08:05, 08:24, 08:47, 12:37 and **14:10** UTC on seven consecutive
days. GitHub does not queue the slots an hourly cron misses; it drops them.

**So the convergent trigger is no longer the clock.** All four sweeps now also run on the completion
of the workflow their repository executes on a push to `main` - full sweep, not one pull request -
which is an event tied to somebody actually working rather than to a schedule the platform honours
when it feels like it. The cron keeps its slot as a bonus for stretches where nothing is pushed, at
whatever reliability GitHub offers. **What this closes is the objection that stood here for three
hours: an unproven recovery path is exactly the mechanism this repository has twice been caught
believing in.** What it does NOT close is the long quiet stretch - if nobody pushes for a week and
the cron never fires, only a Dependabot pull request's own CI wakes anything, and that path handles
its own branch only.

**Two things the sweep still does not do**, neither of which the ceiling is about: nothing REPAIRS a
pull request that is red, and nothing reports whether a pass ran at all. The second is what makes
the paragraph above possible.

**Le Cercle is on GitLab and has no GitHub workflow**, so it is out of scope for this one.

**The fix is a copy of what landed here** - `.github/scripts/dependabot-auto-merge.sh` plus the
workflow that calls it twice - **but the ceiling itself does NOT copy across, and that is the whole
point.** A first draft here refused by SEMVER, every major and every `0.x` minor, and it was
measured wrong the same day: 28 of 33 open pull requests refused, a queue nobody would ever drain.
**Semver is not the question.** A `base64` 0.22 -> 0.23 break stops the tree compiling and the suite
sees it; what a green suite cannot see is a dependency whose failure mode NOTHING here tests, and
that has no relation to the version number. So each repo's list is its OWN: the entries are the
dependencies whose failure would be invisible THERE, and each names the test that would retire it.
Sky and Portail-etu may well have an empty list, and an empty list is a correct answer - it says
their suites are evidence about everything they depend on. Read the reasoning on
[ecosystem-convergence](ecosystem-convergence.md) and the rules in [durable-rules](durable-rules.md).

**Do NOT re-enable an auto-merge anywhere before its ceiling is in**, and do not enable one whose
only trigger is `workflow_run`: it cannot touch a pull request that was already green when it was
installed.

### P2 - a cargo bump in `mls-core` leaves two committed lockfiles Dependabot will never fix

`frontend/mls-core` is a library: its `Cargo.lock` is gitignored. `frontend/mls-wasm` and
`frontend/src-tauri` are binaries with COMMITTED lockfiles, and both depend on `mls-core` by path -
so every crate `mls-core` names appears in their locks too.

**Dependabot opens one pull request, against `mls-core/Cargo.toml`, and that pull request is
incomplete by construction.** There is no manifest to change in the other two directories, so their
locks keep the old version and CI's `Refuse a lockfile the manifests no longer describe` step fails
with `cannot update the lock file ... because --locked was passed`. Measured on PR #300 (argon2
0.5.3 -> 0.6.0): four jobs red, two of them for this reason alone and nothing to do with argon2.

This is not a ceiling refusal - the gate is right to fail, the pull request really is unmergeable -
and it is not something `@dependabot recreate` can fix either. **It is the one shape of dependency
update in this repository that CANNOT be merged unattended**, which is what makes it worth a row.

**The remedy, named rather than done:** make `frontend/` a single cargo workspace with ONE
`Cargo.lock` covering `mls-core`, `mls-wasm` and `src-tauri`. One lock means one resolution, so
Dependabot's pull request is complete again and the class of failure disappears. It was not done in
the same pass as the argon2 bump because `src-tauri` is the crate whose build this workstation can
only COMPILE - never run on iOS or macOS - and restructuring a Tauri build is not a change to make
where the only available gate is `cargo check`. Until then, a bump of any crate `mls-core` names is
done by hand in one commit that refreshes all three locks, and the Dependabot pull request is
superseded rather than merged.

### P1 - the three refusals the auto-merge ceiling makes, and the test that retires each

**`dependabot-auto-merge.yml` refuses only what this repository has no gate for**, and every refusal
names its missing test in a comment on the pull request. The standing directive is that a refusal is
never a routing decision to a human queue (user, 2026-08-31), so THIS TABLE IS THE WORK: each row
closed is a whole class of update that starts merging on its own.

Measured three times on 2026-08-31 by running the SHIPPED script against every open pull request:
**5 merge / 28 refuse in the morning; 26 merge / 6 refuse once the first gate was written; and
7 merge / 5 refuse / 19 held by a real CI failure once the second landed.** The third reading is
the one that changed the subject: **the ceiling is no longer what holds the queue** - nineteen
pull requests are red, and they are red because the gates written that day work. #263 bumps
`@nestjs/common` to 12 in ONE service and dies on `Boot the real AppModule`; #298 dies on a
deprecated `from_slice`. Both are the suite being evidence, which is the whole design.

**All three readings PREDATE the `typeorm` row closing**, so the refuse count is now lower than any
of them and no number here should be quoted as current. The measurement that IS current is the
hourly sweep's own log - it prints what it merged, what it refused and what it held, every pass.

| Refused | Why the suite cannot see it | The test that retires it | State |
| --- | --- | --- | --- |
| ~~`@nestjs/*` MAJORS (22 PRs)~~ | ~~no test ever constructed the real application module~~ | `src/app-module.boot-spec.ts` + the `boot-nest-apps` job | **CLOSED 2026-08-31.** Green on all four services against a real Postgres, Redis and S3; the case is deleted from the ceiling |
| ~~bare `typeorm` MAJOR, or an unclassified bump of it~~ | **CLOSED 2026-08-31.** The boot proved the schema BUILDS and nothing more - `forRootAsync` resolves, every entity's metadata is constructed, `synchronize` runs - while every unit suite mocks its repositories, so no test had ever watched this ORM return a row and a major changing how a query is BUILT would have passed all 1105 of them | `app-module.boot-spec.ts` now issues a real `find({ take: 1 })` through EVERY entity the app registered, by metadata rather than by a named list | **GREEN on core, social and chat-delivery in CD run `33403833044`**, and the clause is out of `dependabot-auto-merge.sh`. media-service carries no query test and asserts WHY: it declares no `typeorm`, and that assertion fails the day someone gives it a database |
| ~~`chacha20poly1305`, `argon2`, `ciborium`~~ | ~~nothing opened a keystore written by the PREVIOUS version~~ | `tests/cross_version_state.rs` + the four frozen artefacts under `tests/fixtures/` | **CLOSED 2026-08-31.** An at-rest envelope is read by the device that SEALED it, so the backward direction is the whole question - measured by enumerating every `encrypt_blob` call site, all of them state persistence. Falsified by corrupting each fixture: all four tests go red |
| `openmls*`, `tls_codec*`, `hpke-rs*`, `libcrux*` (4 PRs) | a WIRE format is read by OTHER devices on OTHER versions, so the forward direction exists and no frozen fixture can see it | an old binary run against a frame minted by the new one. The backward half is already covered | open, **and the obvious shape of it does not work**: measured 2026-08-31 by checking out `v0.14.14` into a worktree, which carries NO `tests/fixtures/` and no `cross_version_state.rs` at all - the release tag predates both. So the old side cannot be 'run its own test with our bytes'; it needs a driver written TODAY and compiled against the OLD `mls-core` as a path dependency, using only the public API that existed then. That is the design decision this row is actually waiting on, not the CI plumbing. **And the compiler spoke first on this one**: openmls 0.9.0 adds `OwnPendingCommit` and `OwnPrivateMessage` to `ProcessedMessageContent`, so the four PRs need a code decision, not just a gate. Applied together they compile down to that ONE error; apart, none of them builds at all |
| ~~`aes-gcm` (0 PRs open)~~ | ~~it opens a channel push sealed by ANOTHER member's device (`decrypt_channel_message`), and src-tauri freezes nothing~~ | `src-tauri/src/mobile/cross_version_push.rs` + two frozen artefacts under `src-tauri/tests/fixtures/` | **CLOSED 2026-08-31.** Two fixtures rather than one, so a failure names its cause: a FIXED key accuses the AEAD, a Graine-DERIVED key accuses the HKDF. Falsified by flipping one ciphertext bit - the channel test goes red while the Graine one stays green. **Both directions are covered**, which is what let the arm be deleted rather than narrowed: an AEAD is deterministic, so re-sealing the frozen plaintext under the frozen key and nonce must reproduce the frozen bytes, and equal bytes are equal in both directions. A protocol that may ADD fields is not, which is why `openmls` stays refused. First test in src-tauri, in the crate rather than under `tests/` because `mod mobile` exists only under `cfg(test)` |
| `webrtc` and the ICE crates (1 PR) | the SFU has ten tests and not one touches the ICE stack | one relay-path call - campaign rung 15 CALL, which has no runner | not started, and the SFU is already SIX majors unplaced (see its own P1 above) |
| `stripe` (1 PR) | **half of it the compiler already sees, and that half is safe.** The SDK types `apiVersion` as the literal its release was cut against and this service pins that value in one constant, so a bump that still COMPILES cannot change which API the app talks to and merges like anything else. A bump that crosses an API version stops the tree compiling in four files at once. What no gate can answer is whether the app still READS what the new API sends - payload shapes and object fields are what an API version decides | fixtures per API version for this service's Stripe surface: the events `webhook.controller.ts` handles and the fields `stripe-payment-provider.ts` and `users.service.ts` read, so a crossing is proved rather than read in a changelog | open. **#304 (22.3.2 -> 22.6.0) is the live case**: it wants `2026-08-26.dahlia` where the constant says `2026-06-24.dahlia`, and CI is red on exactly those four files. Crossing it is a decision about PAYMENTS and therefore the USER's - see `apps/core-service/src/payment/stripe-api-version.ts`, which says so in its own docblock |

**ONE FLAKE IS RECORDED HERE BECAUSE AN UNATTENDED MERGE IS EXACTLY WHAT A FLAKE BREAKS.**
chat-delivery-service's suite failed 1 test in the first of five consecutive local runs on
2026-08-31 and passed 308/308 in the other four; the failing run was concurrent with a CD build on
the same machine, and its output was not captured. Not reproduced, not identified. If it recurs,
capture the suite name before anything else - a green-gated auto-merge that retries into a green run
will merge on the second try and tell nobody.

**Do not widen this list to feel safe.** Every entry costs the queue it blocks, and the honest test
of a new one is: name the failure, then name the test that would have caught it. If you cannot name
the test, the entry is a guess.

### P3 - social-service has no root health route, and the other three do

core-service, media-service and chat-delivery-service each expose `GET /api/health` from a
`HealthController` with an empty `@Controller()`. social-service exposes none: its nearest liveness
route is `GET /api/channels/health`, which belongs to `ChannelsController` and answers about the
channel service specifically. Found while writing the boot test, which has to ask a different URL of
that one service.

It is P3 because nothing is broken today - but a probe, a load balancer or a future readiness gate
that assumes the shape the other three share will silently point at nothing here, and an asymmetry
nobody chose is the kind that gets discovered during an incident.

### P3 - `submissions.formId` names a form nothing keeps, and 28 rows point at deleted ones

**Measured on prod 2026-08-31.** There is no foreign key at all:

```sql
SELECT conname FROM pg_constraint WHERE conrelid = 'submissions'::regclass AND contype = 'f';
-- (0 rows)
```

Twelve `formId` values in `submissions` match no row in `forms`. Of the 28 orphaned submissions,
**5 are `paid`** (36,00 EUR in total), 6 `pending` (101,00 EUR never charged), 16 `free` and 1
`cancelled`. Only one form of the thirteen referenced still exists. The amounts date from May and
June 2026 and read as forms from the development period, so this is P3 on the money and P3 on the
count - but not on the shape.

**What it costs today**: five people have a paid line whose title nobody can render, and
`markPaid`'s own `grantCotisationIfConfigured` would have had nothing to read either. Deleting a form
also strands whatever `user_tags` its `grantsCotisation` had issued, which no longer names anything.

**The decision this needs is not "add a foreign key"** - a cascade would DELETE paid submissions,
which is worse than the orphan. The shapes worth weighing are a tombstoned form (soft delete, the
title survives, the join keeps working) or a denormalised `formTitle` on the submission at write
time. The first keeps one truth; the second survives a hard delete. Neither is obviously right,
which is why this is written down rather than done.

### P2 - NestJS 12 is HALF DONE, and the other half is one upstream package

**Taken 2026-08-31.** `media-service` and `core-service` run `@nestjs/common`, `@nestjs/core` and
`@nestjs/platform-express` at **12**. `chat-delivery-service` and `social-service` are held at 11.
The whole state, the ESM consequences and the mechanism that ends the hold are on
[nestjs-framework](services/nestjs-framework.md), which is the only copy - do not re-derive it here.

**WHAT IS OPEN IS NOT WORK IN THIS REPOSITORY.** `@nestjs/throttler` has published no release
declaring NestJS 12; its latest, `6.5.0`, stops at `^11.0.0`. The two held services both rate-limit
a route with it. With 12 installed, 307 of chat-delivery's 308 tests passed and the only failure was
`framework-boot.spec.ts` reading throttler's own manifest.

**It needs nothing done to it, and that is the point.** There is no `dependabot.yml` ignore and no
ceiling entry: the pull requests raising the framework on those two services stay open and red, and
the hourly sweep updates their branches once throttler moves, at which point the assertion goes
green and they merge unattended. A hold expressed as an assertion about the resolved tree expires
when its reason does; a hold expressed as an ignore outlives it.

**Four satellites moved anyway** - `@nestjs/config` 4 -> 12, `@nestjs/schedule` 6 -> 12,
`@nestjs/axios` 4 -> 12, `@nestjs/typeorm` 11 -> 12. The renumbering onto the framework's major is a
LABEL: every one of them declares `^11.0.0 || ^12.0.0` or wider, so reading the peer range rather
than the version number is what let them merge with the framework major still blocked.

**Nothing else from the original table is owed.** `ioredis` is on **6** in both services and
`@types/uuid` is DELETED rather than bumped - `uuid` 14 ships its own types, so the package had been
dead for as long as it had been declared. `@nestjs/microservices` is gone the same way: an orphan on
disk and in the lockfile, declared by nothing, removed by a clean install along with `kafkajs`.

**Why `protocol: 2` was NOT set when taking ioredis 6,** since its one breaking change is "RESP3 by
default": ioredis 6 also ships `replyMapping`, which defaults to `"legacy"` - map replies arrive as
flat `[key, value, ...]` arrays and doubles as strings, so **the JavaScript values are identical
across both protocols**. That is read from the library's own `RedisOptions.d.ts`, not inferred. The
wire half is answered by the box: production runs **Redis 8.8.0**, and RESP3 has existed since 6.0.
Neither service subscribes - both are command-and-publish clients - so RESP3's subscriber-mode
change does not reach them either. Setting `protocol: 2` would have been a dressing on a wound
nobody has.

**What made this a P2 and still governs any attempt here:** these four services hold the whole
server side of the product, and the suites that would catch a regression run under **node, never
bun** - `admin-storage.controller.mls.spec.ts` fails under the bun runtime and is the reason
`ci.yml` installs with bun and tests with node. Any attempt re-runs all four suites under node
(14 + 202 + 308 + 588 = 1112 tests) and is proven on prod, not on a green build.

### P2 - NOTHING DECLARES THE REDIS VERSION, AND THE TWO PLACES THAT NAME IT DISAGREED

**Found 2026-08-31 while taking `ioredis` 6.** `infrastructure/docker-compose.prod.yml`,
`docker-compose.dev.yml` and `infrastructure/local/docker-compose.yml` all say `image: redis:alpine`
- a floating tag. `ci.yml` said `redis:7-alpine`. The box was measured and runs **8.8.0**, so the
gate that proves a service can talk to Redis was proving it against a different major from the one
it meets in production. **The CI half is fixed** (`redis:8-alpine`, with the reason in the file).

**The production half is NOT, and it is deliberately the user's call.** This Redis is persisted and
`history:{groupId}` is the ONLY shared copy of a conversation's messages - the per-device queue is
deleted on ACK. Changing the image tag makes `docker compose up -d` recreate the container, so it is
a restart of a store holding user data, which is a one-off action and not something to slip into a
dependency commit.

**What makes it worth doing anyway:** a floating tag on a persisted store means ANY deploy can pull
a new Redis major under it, with nobody deciding and nothing recording that it happened. An RDB/AOF
file is forward-compatible and not backward, so the jump is silent and the way back is not. Pinning
to `redis:8-alpine` changes nothing about what is running today - it only removes the ability of a
future `docker compose pull` to change it by itself.

### P3 - 108 navigations bypass `resolve()`, and an inherited disable is the only reason nobody sees them

**FOUND 2026-08-27, while measuring whether `oxvelte.config.json` could be deleted.** It cannot, on
this repository or on MiGallery, and the reason it cannot IS the finding.

The file disables exactly one rule, `svelte/no-navigation-without-resolve`, and it was copied across
from the ESLint config the Oxc migration replaced - which had disabled it for reasons nobody wrote
down. The rule is in oxvelte's recommended set. With the file moved aside:

| Repository | With the config | Without | Of which that rule |
| --- | --- | --- | --- |
| Canari (`frontend/src`) | 0 | 92 | **92 - every one** |
| MiGallery (`src`) | 70 | 86 | 16 |
| le-cercle (`src`) | 0 | 0 | 0 - so its config was deleted |

**What the rule wants** is `resolve()` from `$app/paths` around a route string handed to `goto()` or
to an `href`, which is how SvelteKit 2.26+ resolves a route id against the configured base path. The
92 call sites here are correct today because this app is served at the root and `base` is empty. That
is the whole of their correctness: it is a property of the deployment, not of the code, and the day
anything is served under a prefix - the second environment in this same file, a preview build, an
embed - all 92 break together and silently.

**The work is 92 call sites plus 16 on MiGallery, then deleting both config files.** It is mechanical
and it is large, and it must not be folded into a tooling commit: a diff that touches every
navigation in the app is a diff that wants to be read on its own. Nothing is broken while it waits,
so it waits.

**Do not re-measure it by dropping the `--config` flag.** oxvelte finds the file in the working
directory either way; that comparison is a thing against itself and it read as 0/0 here for exactly
as long as it took to run the real gate. Move the file.


## Infrastructure

### P3 - no docker prune runs on `canari` or `mitv`, and 141 dangling volumes say so

**FOUND 2026-08-27, by checking whether le-cercle's `ENOSPC` could happen here.** It cannot happen
the same way, and that difference is the point of this entry.

le-cercle fills up because its pipeline tags every build `le-cercle:<sha>` and a tag is never
dangling, so the `docker image prune -f` in its deploy reclaimed 0 B for months
([durable-rules](durable-rules.md#shared-gotchas---development-cicd)). **Our hosts have the opposite shape:** CD pushes
to ghcr and the compose files pull `:latest`, so the image a deploy replaces loses its tag and
becomes dangling - reclaimable by the plainest possible prune. What they have in common is that
**no prune runs at all.**

| Host | Root | Free | Dangling images | Dangling volumes | Exited containers |
| --- | --- | --- | --- | --- | --- |
| `canari` | 125 G | 73 G (61%) | 57 | 64 | 0 |
| `mitv` | 438 G | 378 G (90%) | 6 | 77 | 3 |

`docker system df` puts the reclaimable at 3.02 GB of images plus 964 MB of volumes on `canari`,
and 2.43 GB plus 4.65 GB on `mitv` - where local volumes are **82% reclaimable**, the largest single
figure on either box. Neither host is anywhere near its edge, which is exactly why this is a P3 and
not an incident: it is a slope, measured, with years of headroom.

**Volumes are the half that needs care, not a prune flag.** A dangling volume on `mitv` may be an
orphan of a removed container or may be data whose container is simply not running; `docker volume
prune` cannot tell those apart and neither can a name. **Enumerate before deleting** - the standing
rule about destructive controls needing an allowlist applies here in full, and there is no urgency
buying the shortcut. The images half is safe and could be a scheduled `docker image prune -f` today.

### P3 - the DEV box ran out of disk twice, and the real consumer is still not measured

**2026-08-28.** A Tauri Android build died with `rustc-LLVM ERROR: IO failure on output stream: no
space on device` at **10 MB** free; a second attempt hit the same wall at 4 GB after a host
`cargo test` built its own target directory. **Both were paid in pure build cache and nothing
else** - the two `incremental` directories, `~/.bun/install/cache`, `mls-wasm/target`, and
`src-tauri/target/debug` at **14 GB alone**, which the Android build does not even use (a different
target triple). 17 GB free afterwards.

**What is NOT done is the measurement.** A full scan of the volume fights the build for I/O, so
nothing here names the actual top consumer, and every figure above is of a directory that was
already suspected. Until that scan runs, this is a slope rather than a diagnosis - which is why it
sits at P3 beside the two prod hosts above rather than being called fixed. **Ask the user before
deleting anything that is not a build cache.**

## Post-campaign projects - decided, not scheduled

### Separating ICM and ISMIN - two schools on one deployment (user, 2026-09-05)

**A direction, decided and not scheduled.** Verbatim: *"Dans la perspective d'avoir des ismin,
separer associations et listes ICM/ISMIN (notamment la possibilite de faire apparaitre ou non une
association sur la cartographie des associations, et pouvoir n'afficher que les associations ICM sur
le portail ICM). Meme plus largement, tout doit pouvoir etre separe, comme si on avait deux instances
de Canari. Seule la partie admin et la messagerie/communautes doivent etre en commun."*

**THE SHAPE, IN THE USER'S OWN TERMS**: two instances that share exactly two things - administration,
and messaging/communities. Everything else - associations, the association cartography, the lists -
is per-school and must be able to be shown to one school and not the other.

**IT IS TWO PIECES OF WORK WITH DIFFERENT MATURITY, AND CONFLATING THEM IS HOW THE NARROW ONE NEVER
SHIPS.**

- **The narrow half is already actionable and is a feature**: a per-association flag deciding whether
  it appears on the cartography, and a school attribute the portal filters on. It is additive,
  reversible, and does not commit the second half to any shape.
- **The broad half - "as if we had two instances" - is a PARTITIONING DECISION and must be designed
  before anything is built.** The question it has to answer first is not which tables gain a column;
  it is what a shared object means when the two halves disagree. Messaging and communities are
  explicitly COMMON, so a community can hold members of both schools while an association may be
  visible to only one - which means the boundary does not fall between two databases, it falls
  through the middle of the object graph. A migration that assumed otherwise would be very hard to
  reverse.

**WHAT MUST BE SETTLED BEFORE ANY SCHEMA CHANGES**, none of which the code can answer: whether a
person belongs to exactly one school or can hold both; whether an administrator is global or
per-school (the user says admin is COMMON, which suggests global, and that has to be confirmed
because it decides every permission check); and whether a member of one school may see the other's
associations at all, or merely does not by default. **These are the user's decisions, and the first
task here is to obtain them - not to write code against a guess.**

Not scheduled. It belongs after the campaign for the reason everything in this section does: it is
large, it is not a defect, and it changes a schema the campaign is currently measuring.

### The MLS + Graine explanation, written FOR THE USER - audience settled 2026-08-20

**Asked for earlier, deferred on one question: who reads it.** Three audiences were offered and the
user chose the first outright.

**Who it is for: the user.** What is guaranteed, against whom, and - as loudly - what is NOT.
Prose and diagrams. **No file names, no function names, no code**, because those are what a
maintainer needs and this is not for a maintainer. Readable end to end in one sitting, which is a
length constraint and therefore a selection constraint: everything that does not change what the
reader can conclude is cut.

**What it must contain, since the whole point is the boundary.** What the server sees (ciphertext,
sizes, timings, who talks to whom) and what it cannot see. What a community's shared key means: every
member of a community holds the key to every PUBLIC salon in it, by design, and until 2026-08-20 to
every private one too. What a private salon's own group changed, and what it did not - an admin now
JOINS and is visible in the member list; forward secrecy was decided AGAINST, deliberately, and the
document says so rather than omitting it. What leaving, being removed, and being re-invited actually
do to the keys. What a stolen device gets, and what the PIN does and does not protect.

**The two audiences declined, recorded so the choice is not re-litigated.** A maintainer's page (file
names, invariants, where each is held) would be a wiki page more, long, needing to stay synchronised
- the wiki already carries that, split across
[mls-protocol](protocols/mls-protocol.md) and [graine](protocols/channel-encryption.md). A security
assessor's document (explicit threat model, what an excluded member can do) is the most demanding of
the three and nobody has asked for one.

**Written AFTER the campaign**, because the campaign is what turns the design into something
measured, and a document that says "this is guaranteed" before anything has run is a claim about a
file rather than about a system.

### One MLS client in a SharedWorker - decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half of
them measure.

### `dev.canari-emse.fr` becomes a real second environment - decided 2026-08-17

Today it is a proxied CNAME onto the same tunnel as production - one environment wearing two names.
The user wants trials to stop happening on prod, which is the right instinct: every reproduction is
authorised on prod only because there is nowhere else, and each one leaves debris on a shared server
that real members use.

**SCOPED WITH THE USER 2026-09-01 - the decisions below are TAKEN and are not to be re-litigated by a
later session.** Where a decision went against the recommendation, the reason is recorded with it, so
that reason is what a future session must argue with rather than the choice.

> **This item holds the DECISIONS. How the environment is actually put together - the isolation, the
> two host ports, the copy and its three strips, the declared version gap, the two variables that
> identify a dev deployment - is on
> [dev-environment](infrastructure/dev-environment.md), the only copy.** **ALL EIGHT STEPS HAVE
> SHIPPED** (2026-09-01), the CD wiring included. **ALL FOURTEEN required secrets exist, the
> `canari-dev` OIDC client is created on Authentik (`pk=10`), and `DEV_ENVIRONMENT_ENABLED` is
> `true`** - all done 2026-09-02, the Authentik write only after the user said
> *"Je valide tes requetes manuellement, vas-y"*, an unattended agent having been refused it first
> and correctly. **ONE THING IS LEFT AND IT IS THE LAST STEP BY DESIGN: the tunnel INGRESS rule for
> `dev.canari-emse.fr`, still pointing at `http://localhost:8080`** - production's frontend. Moved
> before dev answers on `127.0.0.1:3080` it turns a name that serves production into a 502.
> **A warning about the secrets themselves:** twelve were written with `gh secret set --body -`,
> which stores a literal dash rather than reading stdin, and all twelve had to be rewritten - the
> rule is in [durable-rules](durable-rules.md). That page's closing section is the map.

**CLOSED 2026-09-03, and by neither of the two shapes that had been proposed.** It was raised by
the user on 2026-09-02 (*"on peut toujours push sur dev non ?"*) as: there is no way to deploy dev
WITHOUT deploying production, because one trigger - a push to `main` - ran both estates in sequence.
The workflow migration answered it from the other end. **A run deploys exactly one estate, and which
one is decided by the RELEASE**: a `X.X.X-alpha.N` pre-release deploys dev and nothing else, a
stable deploys production and nothing else, and a push deploys neither. Both shapes weighed here are
gone rather than chosen - the `dev` branch existed for one day and was deleted, and `deploy.yml` has no
`workflow_dispatch` at all, a dispatch being a second door onto the one machine. **Kept because the
distinction it was written to preserve still holds**: the capability was absent because nobody had
asked for it, not because it had been considered and rejected, and it arrived the day somebody
asked.

**Shape.** Same machine as production (70 GB and 15 GiB free, measured), own compose project
`canari-dev`, resource limits so a dev container cannot starve prod, running permanently. Own
Postgres, own Redis **with** a `redis_data` volume, own Garage instance with its own keys, own RPC and
admin secrets, and a bucket named `canari-media-dev`. ~~Secrets carried by a GitHub environment named
`dev`, not by prefixed repo secrets.~~

> **THIS ONE DECISION WAS REVERSED WHILE BUILDING IT, 2026-09-01, and the reversal is recorded here
> rather than made quietly - it is the only scoped decision this chantier went against.** GitHub
> resolves `secrets.FOO` inside a job declaring `environment: dev` in this order: the environment's
> own secret, then the REPOSITORY secret. So an environment where somebody forgot one secret does not
> fail - it silently inherits production's value for it. That is a fail-OPEN mechanism, and it is
> precisely the defect the deleted `cd-dev.yml` shipped: it read the bare names and would have run a
> second estate on production's own `JWT_SECRET`, making a token minted by either valid in the other.
>
> Dev therefore reads `DEV_<NAME>` and **never** the bare name, so a missing dev secret is EMPTY and a
> `required` row refuses the deploy before a container is touched - fail-CLOSED. The GitHub environment
> still exists and `deploy-dev` still declares `environment: development`, for its deployment URL and
> any protection rules; the two mechanisms do not conflict, because the job no longer depends on
> environment scoping for isolation. The intent behind the original decision - dev secrets kept apart
> from production's - is fully served; only the mechanism changed, for a reason that would otherwise
> have re-created the exact hazard this environment exists to remove.

**Data: a FULL copy of production, unscrubbed - the user's choice, against the recommendation.** The
reason is usability: *"le plus proche de la prod est mieux quand-meme, sinon complique de se connecter
et d'interagir dans de bonnes conditions"*. Two facts were put to the user first and did not change
it: the server holds only ciphertext, so a copied conversation is **unreadable** on a fresh dev
client - the MLS keys live on the device and the media CEK is client-generated - and login ease comes
from the Authentik directory, not from the database. The copy therefore buys realistic users,
communities, posts, forms, calendar and shop, and buys nothing at all for chat, the most-tested
surface. **Three consequences are load-bearing and must be built into the copy procedure:** it
TRUNCATES the push-token table (copied tokens belong to prod's FCM sender, so a dev sender rejects
every one - safe, but it would log a failure per token, and noise is never acceptable), it CLEARS
`stripe_customer_id` (live-mode ids are unknown to test-mode keys and fail with a misleading message),
and it has a guard that categorically refuses the reverse direction. There is no mail transport
anywhere in this repo, so copied addresses cannot be written to.

**The copy runs as a workflow triggered by each minor release** - `bump-version.yml` fires it - which
is also what "reset" means here: dev is re-copied from prod, not emptied. That gives the named
starting point the user asked for in queue item 8, and makes a procedure that touches the production
database a rehearsed one rather than a rare gesture.

**Login: the same Authentik instance with a dedicated OIDC client, open to the whole directory** -
also the user's choice over a testers group, for the same usability reason. Redirect URIs limited to
`dev.canari-emse.fr`. JWT signing secrets are distinct from prod's, so a token minted by one
environment is refused by the other, and that non-interchangeability is a test.

**Exposure.** Web AND API behind Cloudflare Access on the existing admin group, because the earlier
answer left a full production copy reachable by any directory account - the API is where the data is,
so protecting only the web protected nothing. **The harness crosses Access with a service token**
injected as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, the user having required that
*"lors de nos tests automatises, il faut que les instances des navigateurs puissent y acceder
librement"*: an interactive SSO page cannot be crossed by an automated run, an egress-IP bypass
breaks silently when the address changes, and a per-profile SSO session would add a non-scriptable
step to the from-zero sequence beside SETUP-4's 2FA. No adminer in dev.

**CORRECTION, 2026-09-01, on the MECHANISM and on when it may be built.** The line above said "by
the Playwright context". **There is no Playwright in this repository at all** - measured:
`newContext`, `launchPersistentContext`, `extraHTTPHeaders`, `connectOverCDP`, `chromium.launch` and
`puppeteer` return nothing across `tools/cross-client-harness/*.mjs`. The harness drives real Chrome
over raw CDP (`cdp.mjs`, 887 lines, a websocket per target), so the mechanism is
`Network.setExtraHTTPHeaders` on each attached target after `Network.enable`, not a browser-context
option.

**And it is deliberately NOT built yet, which is a disposition rather than an omission.** There is no
Access application, no dev environment and no service token, so the crossing cannot be exercised -
and an arming path nobody can exercise is an untested code path inside the ONE instrument the whole
campaign depends on, in a file whose profiles cost a re-enrolment and SETUP-4's 2FA to lose. The
honest split is to build it in the session that can prove it crosses. What that session owes: read
the pair from the environment, return no headers at all when unset (so today's behaviour is
untouched), one `Network.setExtraHTTPHeaders` call at target attach, and one assertion in an existing
`*-selftest.mjs` that an unset pair injects nothing.

**Trigger: deployed from `main` on every push, with no `dev` branch at all.** One trigger, no possible
divergence, and `WORK ON main` stays intact. **(SUPERSEDED 2026-09-03: nothing deploys on a push any
more, and this estate is reached by publishing a `X.X.X-alpha.N` pre-release. The paragraph stays as
the record of what was decided on 2026-08-17, and the sentence below about a failed dev migration
blocking the prod deploy no longer describes anything - a run deploys one estate.)** Dev deploys BEFORE prod and **a failed dev migration
blocks the prod deploy** - the most valuable gate this whole item buys, and it is free: dev runs the
migration against a copy of prod's data, so a migration that breaks there would have broken prod.
Accepted cost: dev never pre-validates a commit, it is where things are tried afterwards.

**CD shape: ONE `deploy.yml` parameterised by environment**, not a second file - `cd-dev.yml` drifted to
734 unusable lines in four months precisely because it was separate. Dev builds its own images
(the images embed the frontend and therefore the domain), roughly doubling build time, accepted.

**Version.** `bump-version.yml` stays the only writer. **DONE 2026-09-01, with one correction: the
suffix is a SEPARATE FIELD, not part of `version`.** `/api/version` now returns `build`, fed by
`DEPLOY_BUILD`; putting `+dev.<sha7>` inside `version` as first described would have broken the update
path, because the frontend turns that field into a release tag and a GitHub download URL
(`releaseTag`, `getReleaseApkDownloadUrl`), so a dev client would have been offered an update from
`v0.14.15+dev.abc1234` - a 404. The permanent, non-dismissible **"test environment" banner** is built
(`EnvironmentBanner.svelte`, driven by the build-time `VITE_DEPLOY_ENVIRONMENT`, unset meaning
production so a missing variable never brands prod) - non-negotiable given the copy is
indistinguishable from prod on screen. **Both variables are written by the pipeline as of 2026-09-01**:
`build-frontend-dev` writes `VITE_DEPLOY_ENVIRONMENT=development` into the dev bundle, and
`render-env.sh --build dev.<sha7>` writes `DEPLOY_BUILD` into dev's `.env` only - the manifest marks
that row `skip` for production, so a tagged release keeps `build: null`. `minClientVersion` is per-environment by virtue of the separate
database. A GitHub release does not build dev.

**Dev is deliberately ONE MAJOR AHEAD, and a PROVEN gap lifts a ceiling.** ~~Postgres 18 starting in
dev, on a data directory written by prod's 15, and serving `/api/version`, is exactly the test that the
ceiling table demands.~~ **CORRECTED 2026-09-01 WHILE BUILDING IT, and this is the most important
correction in this item: a green dev deploy is NOT that test.** The copy is `pg_dump` replayed into a
cluster the new major initialised itself, from empty - a LOGICAL copy, which never touches a data
directory written by the old major and therefore cannot fail the way production failed. It would have
gone green on 18 while saying nothing about `pg_upgrade` or the 18+ move of the mount point from
`/var/lib/postgresql/data` to `/var/lib/postgresql`, and the next `postgres` major would have
auto-merged on it - the outage of 2026-09-01 re-armed behind a gate that reads as proof. So
`infrastructure/dev/version-gap.yml` makes each row declare WHICH of four questions its gap answers
(`none`, `fresh_cluster`, `logical_restore`, `in_place_upgrade`) and `lib/ceiling.sh` accepts only
`in_place_upgrade`, with a non-empty `proof`, releasing exactly the major it was proven for. All three
rows read `none` today, which is the honest state. What the dev environment buys on its own is a
`logical_restore` - real, worth having, and lifting nothing. The
[ceiling table](#p1---the-three-refusals-the-auto-merge-ceiling-makes-and-the-test-that-retires-each)
is therefore retired by a rehearsal on a BINARY copy of prod's `PGDATA`, which is a separate piece of
work and is not what deploying dev does. **The user's choice of a full copy is what makes this credible** - a synthetic seeder would
have proved nothing about a real data directory - so the tension recorded earlier between "safe empty
dev" and "dev that can lift a ceiling" is resolved in favour of the copy. The major gap between dev
and prod is therefore EXPECTED and must be DECLARED in a file, with a test asserting the declared gap
rather than asserting equality.

**Mobile is phase 2, after the web environment actually serves something other than prod.** Then:
`applicationId` `fr.emse.canari.dev`, `productName` `Canari Dev`, differentiated icon, side-by-side
installation with prod, a **separate keystore** (a prod keystore leaked through a dev build is
unrecoverable - Play refuses any key change), four `ANDROID_DEV_*` secrets, and the APK distributed as
a GitHub artefact with **no Play listing** - a second listing would mean redoing content, data-safety
and privacy-policy questionnaires for no gain. Three Android details are build-breaking or
resolution-breaking if missed: `google-services.json` comes from a secret and the Gradle plugin
validates the package name, so a prod file fails a dev build; the custom scheme `fr.emse.canari`
(five hosts) must become `fr.emse.canari.dev` or two installed apps claim the same scheme; and the
App Link on `https://canari-emse.fr` must be replaced by one on `dev.canari-emse.fr`, with prod's
`assetlinks.json` never listing the dev fingerprint. **Dev gets its own Firebase project** - the user
is creating it, since the Play service account holds only the `androidpublisher` scope and no
`serviceusage.services.enable`, so it can neither create a project nor enable an API. iOS and desktop
are out of scope.

**Also decided:** the April clone at `/home/canari/canari-dev` is read for what `DEV_BRANCH_SETUP.md`
still holds, that is folded into the dev wiki page, and the clone is then DELETED - blocking, before
anything deploys there. `auth_db` is renamed during the PostgreSQL 18 window, rehearsed in dev first.
Dev is excluded from `backup.sh` by a positive list. No TURN in dev while `CALLS_ENABLED = false`.
`MIGALLERY_API_URL`, which the dev compose still defaults to the production `https://gallery.mitv.fr`,
is cut. Cookie attributes are prod's - **DONE 2026-09-01, and it was worse than the plan assumed:**
`isDev` was not merely domain-derived, it was decided per request from `Origin`/`Referer`, so outside
production any caller claiming localhost got its own refresh credential without `Secure`. Now read
once from `ALLOW_INSECURE_COOKIES`, no default, with `true` + `NODE_ENV=production` a startup error;
and the rewritten dev compose had left `NODE_ENV` off all four NestJS services, which is exactly how
a live HTTPS environment would have reached that branch - a derived test now forbids it
([sessions](sessions.md#the-cookies-own-attributes-are-a-deployment-fact-not-a-per-request-one)). The
refresh cookie stays host-only with no `domain:` attribute, which is what already keeps prod and dev
from sharing it ([auth.controller.ts](../../apps/core-service/src/auth/auth.controller.ts)). The tunnel token readable
in `ps aux` is a separate P2, deliberately not folded in here.

**FOLDED IN FROM THE APRIL CLONE, which was then deleted 2026-09-01.** Its `DEV_BRANCH_SETUP.md`
described a stack that no longer exists - MongoDB, Kafka and MinIO, none of which this repo runs - and
a branch workflow (feature -> PR -> `dev` -> PR -> `main`) that the decisions above replace outright.
Its "push" section recommended disabling the Husky hooks and cited a git setting that does not exist
(`core.sharen`), which is reason enough not to archive it: it is a document that teaches the opposite
of FACE THE BLOCKAGE. Both it and `DISPLAY_LOCATIONS.md` remain in `main`'s history (the clone sat at
`5ce5ddc`, an ancestor of `main`), so deleting 24 MB of stale worktree lost nothing. **Four things
survived and are inputs to phase 1:**

- **The dev frontend's host port is `3080`**, which the current `docker-compose.dev.yml` port set does
  not make obvious next to the service ports (5433, 6380, 3100, 3110-3114). It is what the tunnel must
  route `dev.canari-emse.fr` to.
- **The two-directory layout on one machine** - `/home/canari/canari` and `/home/canari/canari-dev` -
  is what the April attempt already assumed, and it matches the decision taken above.
- **Its nginx claim is WRONG and the correction matters.** It asserted that nginx needs vhost entries
  for both `dev.canari-emse.fr` and `canari-emse.fr`. It does not: dev runs its OWN frontend container
  and therefore its own nginx, so there are TWO instances and the tunnel picks between them by port
  (prod `8888`, dev `3080`). Nothing about prod's nginx changes, which is the whole point of the
  single-public-entry-point rule - a second environment must not edit the first one's entry point.
- **It tagged dev images `dev`, a MUTABLE tag, and that now collides with a durable rule.** Since
  2026-08-30 the containers production runs are identified by DIGEST, not by a tag. Whether dev may use
  a mutable tag is a decision that has to be made deliberately rather than inherited from this
  document: a mutable tag means a dev redeploy cannot be reproduced, which sits badly with the standing
  demand that everything be deterministic and reproducible.

**WHAT IS ACTUALLY BLOCKED, narrowed by measurement 2026-09-01 - it is ONE credential, not four.**

- **CORRECTED 2026-09-01 BY MEASUREMENT: the blocker was never DNS.** There is **no DNS record to
  create** - `dev.canari-emse.fr` already exists as a proxied CNAME onto the same tunnel as every other
  hostname in the zone, and the tunnel's INGRESS is what maps a hostname to a local port. That ingress
  routes `dev.canari-emse.fr` to `http://localhost:8080`, **the identical service production is on**,
  which is the whole reason the dev name serves prod. **The single change the environment needs is that
  one rule repointed to `http://localhost:3080`**, the dev frontend's host port. The operative
  permission is therefore `Account -> Cloudflare Tunnel`, NOT `Zone -> DNS`; the pre-existing token
  READS the tunnel configuration while the DNS-scoped token added for this work is refused with `1001`.
  Whether that token holds `Edit` or only `Read` is deliberately UNMEASURED: the only way to test it is
  to write to a live ingress object that `canari-emse.fr` rides, so a malformed PUT would take
  production off the internet. The edit is made once dev exists, by GET, single-rule change, PUT, with
  the original saved first. **The hostname-to-service map itself stays out of this PUBLIC repo** - it
  names the admin hosts, and that exclusion was already a deliberate decision; it is in agent memory.
- **The DNS permission, described here as it was believed before the measurement above, and still
  worth having:** The stored token reads
  zones (`/zones?name=` returns the id) but is refused on `/zones/{id}/dns_records` with `10000`, so it
  holds `Zone:Zone:Read` and not `Zone:DNS`. **The permission needed appears only on a policy whose
  RESOURCE is a zone**; a policy scoped to "entire account" offers `Account DNS Settings`, `DNS
  Firewall`, `DNS View` and the Registrar groups, **none of which grant any right over DNS records** -
  that mismatch is what made the first attempt look granted when it was not. Phase 1 needs
  `Zone -> DNS -> Edit` on `canari-emse.fr`, plus, account-scoped, `Access: Apps and Policies -> Edit`
  and `Access: Service Tokens -> Edit` for the Access application and the harness token. **Beware one
  false negative:** `/user/tokens/verify` answers `Invalid API Token` for an ACCOUNT-owned token even
  when it works, so that endpoint must never be used to judge one.
- **Authentik is NOT blocked - the box can be driven from here** (user, 2026-09-01). The alias is
  `ssh miconnect`, not `rootz-emse`, which is in no SSH config; Authentik 2026.8.0 runs as
  `miconnect-server-1`, and `docker exec miconnect-server-1 ak shell -c '...'` executes against the
  live models, verified by listing the five existing providers. **The `Canari` provider's settings were
  read so the dev one is a faithful clone rather than a guess:** `client_type` confidential,
  `sub_mode` `hashed_user_id`, `issuer_mode` **`per_provider`** - which is why a dev token cannot be
  mistaken for a prod one - claims in the id token, validity 1 min / 5 min / 30 days, and **four custom
  property mappings that must be carried over or dev logins lose fields prod has**: `Promotion`,
  `Formation`, `First + Last Names`, `Personnel de l'ecole`, alongside the two default OpenID mappings.
  Its six redirect URIs (`canari-emse.fr`, both `tauri.localhost` schemes, ports 1420/1421, and
  `fr.emse.canari://callback`) are the template; the dev provider's are the same list rewritten onto
  `dev.canari-emse.fr` and `fr.emse.canari.dev://callback`.
- **Stripe is DROPPED from dev entirely** (user, 2026-09-01: *"oublie. Stripe ne sera pas accessible en
  dev pour le moment, tant pis"*). No keys, no webhook endpoint, and the payment path is inert there.
  The copy still CLEARS `stripe_customer_id`, for the same reason as before and now more strongly: with
  no keys at all, a copied live-mode id could only ever produce a misleading failure.

**THE COPY IS BUILT AND ITS GUARDS ARE TESTED (2026-09-01):**
`infrastructure/dev/copy-prod-to-dev.sh`, with
`.github/scripts/tests/dev-copy-guards.test.sh` holding it to its two properties. Three things came
out of building it that the plan had wrong:

- **It is SEVEN payment columns across four tables, not the one the plan named.** Measured on prod:
  `users."stripeCustomerId"`, `associations."stripeAccountId"`, `associations."stripeOnboardingComplete"`,
  `associations."lydiaAccountId"`, `associations."lydiaOnboardingComplete"`,
  `purchase_records."stripePaymentIntentId"`, `submissions."stripeSessionId"`. Five associations hold a
  real `stripeAccountId`; both Lydia columns are still empty, which is precisely why they are stripped
  now rather than after WP-LYDIA-1 fills them. The two `*OnboardingComplete` columns are NOT NULL
  booleans and are set `false`, not nulled. **The test DERIVES this list from the entity declarations**,
  so a column added later fails the build until the copy strips it - proved by injecting a
  `stripeInvoiceId` and watching 8 columns derive and the new one fail.
- **The direction is enforced by Docker's own labels, not by a path.** The two compose projects are
  `readonly` literals, containers are found by `com.docker.compose.project`, and the database user is
  read from the container's own environment - so the script needs no compose file, no `.env` and no
  path to be right. Every write goes through one function that RE-READS the target's label per call.
  Verified on the box: the discovery finds `infrastructure-postgres-1` and reads `POSTGRES_USER=canari`,
  and a `--dry-run` with no dev environment present refuses with
  `no running 'postgres' container in project 'canari-dev'` before touching anything.
- **`push_token` holds 70 rows on prod and no foreign key references it**, so the truncate is safe.

**AND ONE GAP IT EXPOSED, small but real: the platform cannot declare payments DISABLED.**
`platform_config.payment_provider` is typed `'stripe' | 'lydia'` with no third value, so the copy
leaves it alone - writing anything else would contradict what the code asserts about the column. The
consequence is that dev presents Stripe as the live provider and fails on use, with no keys behind it.
A `'none'` value, refused by the DTO's `@IsIn` today, would let an environment say the truth. Worth
one line of enum and one migration, and it is not urgent.

**Phase 2 alone remains owed to the user:** the Firebase project (the Play service account holds only
`androidpublisher` and no `serviceusage.services.enable`, so it can neither create a project nor turn
an API on) and the dev keystore, plus a decision on where that keystore is backed up.

**MEASURED 2026-09-01, before any of it is scoped - four facts, three of them worse than the note
above assumed.**

- **`dev.canari-emse.fr` is not merely an alias, it is a PUBLIC one.** It answers `200` and
  `/api/version` returns `{"version":"0.14.15","minClientVersion":"0.14.0"}` - byte for byte what
  `canari-emse.fr` returns, because it is the same containers. Anyone told "use the dev site" today
  is typing into production, and the name is doing the opposite of its job.
- **`/home/canari/canari-dev/` already exists, and it is a trap.** It is a clone stranded on a
  `master` branch at `5ce5ddc` (2026-04-24), four months and one whole toolchain behind: it still
  carries `.prettierrc`, `.prettierignore` and `.pre-commit-config.yaml`, none of which this repo has
  used since the move to oxfmt. It also holds a `DEV_BRANCH_SETUP.md` that exists in NO commit of
  this repository - a design document that lives only on the box, which is exactly the failure
  `CLAUDE.md` forbids. Read it and fold what survives into this page, then delete the clone. The
  hazard that used to accompany this - `cd-dev.yml` deploying into that directory on top of it - is
  gone with the workflow, so what is left is purely to recover the document before the clone goes.
- **`cd-dev.yml` was dormant, not missing - and is now DELETED (2026-09-01, `a8ac1828` is the last
  commit holding it).** 734 lines, `on: push: branches: [dev]`, last run 2026-05-09, and the `dev`
  branch does not exist on origin, so its trigger could never fire - but `workflow_dispatch` could,
  and **it read the SAME secrets as production**, Garage keys and `FIREBASE_SERVICE_ACCOUNT_JSON`
  included, with `docker-compose.dev.yml` then defaulting `GARAGE_BUCKET` to the same `canari-media`.
  Its host ports were offset (5433, 6380, 3100, 3104, 3110-3114) so nothing collided, and its volumes
  were separate by compose project - but `redis_data` was absent from its `volumes:` block entirely,
  so a dev Redis would have kept the shared message log in a container filesystem. Waking it up as it
  stood was how a test notification reaches a real phone, which is why the deletion was pulled forward
  ahead of the CD unification rather than bundled with it. It was no loss as a reference: the dev arm
  will be written from `deploy.yml`, which works, not from a file that never did.
- **The box has room, so capacity is not a reason to host dev elsewhere:** 70 GB free of 125 GB, and
  15 GiB of 16 GiB RAM available with the whole production estate running at ~800 MiB.

**One thing found while measuring, unrelated to dev and owed a decision:** the tunnel runs as
`cloudflared --no-autoupdate tunnel run --token <token>` under root, which means its ingress lives in
the Cloudflare dashboard rather than in a file on the box - and **the token is visible in `ps aux` to
every user on the machine.** A token-based tunnel also means a second environment's hostname is a
dashboard change, not a repo change, so nothing in this repository would record it.

### A SECOND campaign, for everything that is not chat - asked for 2026-08-16

**It is a second campaign, not more sections on this one** - the user's framing, and it settles a
structural question. The expected size is dozens of checks per surface, where the current dashboard
already carries 18 sections in one file whose entire job is to be a LIVE summary someone can read.
Pouring a second campaign into it destroys that property. So: its own dashboard, its own manifest, its
own phase files - and `checks.mjs`'s phase list is the seam to look at first, since a second campaign
must be runnable without re-running this one.

The 18 sections were written around one class of failure: a message crossing between two transports
and two platforms, and the silent loss that class produces. That leaves whole surfaces with **no check
at all** - posts, forms, communities as a management surface, profiles, media browsing, calendar,
payments - and a surface with no check is not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. It does **not** share the chat path - no MLS, no per-device fan-out, no outbox -
so none of the verdicts already taken transfer to it, and its delivery is server-decided, which is a
different failure mode (an audience computed wrong notifies the wrong people, and nothing on the
client can detect that).

Three things must be settled BEFORE writing checks:

- **The venue.** Every existing check sends into the two-test-account DM or `Canari Test Venue`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - an assertion about absence, over a
  population, needing its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).

**The eleven emoji rows belong to this campaign** - they are listed in the bundled-emoji-font
entry above, which is their only copy.
