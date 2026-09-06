# CI/CD pipeline

Canari uses GitHub Actions for continuous integration and deployment. The pipeline lives in `.github/workflows/`.

## Workflows

### Package 1: opening a pull request (`ci.yml`)

**THE PIPELINE IS TWO PACKAGES, ONE PER HUMAN GESTURE** (user, 2026-09-03: *"Je veux une suite
d'evenements et d'etapes"*). This file is everything that happens when a pull request is opened;
`release.yml` is everything that happens when a release is published. There is no third file,
because a merge deploys nothing.

**It was `ci.yml` and `auto-merge.yml` until 2026-09-03** - two files listening for the SAME
`pull_request` event and never referring to each other, so the sequence a human wants to read was
split in half. The order, which the file's own header states:

| # | job | what |
|---|---|---|
| 1 | `changes` | reads the modified paths and decides which of the jobs below run at all |
| 2 | the test jobs | Rust, the four NestJS apps' real AppModule, TS, frontend, the two self-test suites - in parallel, each behind its own path filter |
| 2b | `dependency-ceiling` | ONLY on a Dependabot pull request: does a gate HERE exist that would see this update fail? A human's pull request carries no `updated-dependencies` block to decide on, so it skips |
| 3 | `ci-passed` | aggregates them. `success` AND `skipped` both pass. The ONE check the ruleset requires |
| 4 | `arm-auto-merge` | in **parallel** with 1-3, not after |

**`arm-auto-merge` HAS NO `needs:`, AND THAT IS DELIBERATE.** `--auto` hands the decision to
GitHub, which merges the instant the required check passes and never before, so arming is a
declaration of intent rather than a verdict. A job that waited for the suite would hold a runner
for its whole length and would still have to re-read the checks at the end - and a job that merges
on its OWN reading of "green" is a second opinion about which jobs matter. Measured: #332 sat armed
for the ten minutes its suite took, and merged the moment `CI passed` concluded.

**THE CEILING IS A CHECK SINCE 2026-09-03, AND THAT IS ONE HALF OF ONE MECHANISM FOR EVERY PULL
REQUEST** (user: *"le auto-merge et les CI doivent considerer toutes les PR, les miennes ou
dependabot"*). It was asked only inside `dependabot-auto-merge.yml` - a SECOND merge mechanism
beside GitHub's own auto-merge, so a Dependabot pull request and a human's took different routes to
`main`. **#309 is the case**: `postgres 15-alpine -> 18-alpine`, fully GREEN, correctly refused,
open for days.

**AND IT CORRECTS WHAT THIS PAGE FIRST SAID.** The refusal was NOT "recorded nowhere on the pull
request" - the sweep posts a `github-actions` comment naming the exact missing test, and it is a
good comment. What a CHECK adds is narrower and still worth the change: **a comment is ADVISORY.**
It is absent from the checks list, which is where a reader looks for what blocks a pull request; the
merge machinery cannot read it, so anything that armed GitHub's auto-merge would merge straight past
it; and it sat outside `ci-passed`, the one check the branch ruleset requires. Feeding `ci-passed`
is what makes the refusal BINDING - an update with no gate cannot merge by any route, armed or not.
**Measured on the rebased #309: `Dependency ceiling -> FAILURE`, then `CI passed -> FAILURE`.**

**STAGE TWO LANDED THE SAME DAY, AFTER THE BINDING HALF WAS OBSERVED and not before.** The order
was not a preference: arming a pull request whose ceiling refusal was not yet a required check
merges `postgres 18` on a green suite, which is exactly the 33 minutes of 2026-09-01. The
observation that unlocked it was `@dependabot rebase` on #309 - the only way a new job can reach an
existing pull request, since it is gated on `pull_request` - giving `Dependency ceiling -> FAILURE`
and then `CI passed -> FAILURE`.

**SO THE SWEEP ARMS AND NO LONGER MERGES**, and three things went with the merge:

| Gone | Why it existed | Why it is gone |
|---|---|---|
| ~200 lines counting check-runs | to decide "is it green" | a SECOND OPINION about which jobs matter. `CI passed` is the ruleset's answer and is now the only one |
| `gh workflow run ci.yml` | a `GITHUB_TOKEN` merge raises no `push`, so the merged combination was never tested | the App-token arming makes the merge raise it, exactly as for a human's pull request |
| the ceiling, and its comment | to refuse what CI cannot judge | it is a binding CHECK now, and the annotation carries the same text the comment did |

**THE IDENTITY IS THE ONLY SILENT-WHEN-WRONG PART.** Auto-merge merges as whoever ARMED it, so a
`GITHUB_TOKEN` arming would raise no `push`, leave `main` without a `CI passed` check, and make
`release-preflight.sh`'s third gate refuse EVERY release - from a file that has nothing to do with
releasing. Four assertions hold it, two of them mutation-proved against exactly that swap.

**WHY THERE ARE TWO ARMING POINTS RATHER THAN ONE**, which is the one thing the "single mechanism"
goal does not get: **a `pull_request` run from Dependabot has no access to secrets** - GitHub runs
it as if it came from a fork - so the App token cannot be minted in `ci.yml` for those.
The sweep runs on `workflow_run` and a schedule, in the default-branch context where secrets exist.
One merge mechanism, two arming points, and the split is forced by where secrets live.

**AND THE SWEEP STILL HOLDS TWO PROPERTIES NOTHING ELSE DOES**, which is why deleting the file was
never the plan: CONVERGENCE (it enumerates every open Dependabot pull request, so the correct state
is reached from any starting state - seven mergeable green pull requests sat untouched on
2026-08-31 because an event-only automation acts on what it happened to catch) and STALENESS
(`lib/gate-moves.sh`, and asking Dependabot to rebuild a branch whose gates moved - the one thing
GitHub's auto-merge does not do, since it re-evaluates when the PULL REQUEST changes and never when
the BASE does).

**AND THEN STEP 6, WHICH IS WHY A RELEASE IS POSSIBLE AT ALL.** GitHub squash-merges, deletes the
branch (`delete_branch_on_merge`, set true on 2026-09-03; `--delete-branch` was passed until then
and did nothing, `gh` performing the deletion after a merge IT made and `--auto` making none, so
the flag is gone and the setting is inventoried in `infrastructure/MIGRATION.md` section 3bis with
`allow_auto_merge`, without which nothing arms at all), and
the merge raises a `push`, so this same file runs again on the merged `main`. That run is what puts
the `CI passed` check ON the commit of `main`, and `release-preflight.sh`'s third gate reads exactly
that check. An App token raises that event; `GITHUB_TOKEN` does not - so arming with the default
token would refuse every later release, from a file that has nothing to do with releasing.

Runs on every pull request to `main`, and again on every push to `main`:

| Job | What it checks |
|---|---|
| **Rust tests** | `cargo test` across all crates (`chat-gateway`, `call-service`, `mls-core`) |
| **TypeScript tests** | NestJS tests in `chat-delivery-service` |
| **Frontend tests** | `vitest` in `frontend/` |
| **Frontend lint** | `oxlint` + `oxvelte` + `oxfmt --check` + `svelte-check` (0 errors required) |
| **Build** | the generated sources first - [`.github/actions/build-mls-wasm`](../../.github/actions/build-mls-wasm/action.yml) then `bun run proto:gen` - then `bun run build` |

**The generated sources are not in git** (`frontend/src/lib/wasm/`, `src/lib/proto/canari.{js,d.ts}`),
so EVERY pipeline that ships a client builds them: `build.yml`, the three release workflows, and
`ci.yml` because the gates import them. One composite action, one pinned
`wasm-pack`, one cache key over `mls-wasm/**` + `mls-core/**` + `rust-toolchain.toml` - the
committed binary went a crypto fix stale precisely because only some pipelines rebuilt it
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)).

**The second trigger is what makes a merge on `main` mean something.** A pull request is tested
against its own head, so two pull requests that each pass can still break `main` between them; the
push run is the one that says whether the merged result is green. It also covers what a required
check cannot - an admin bypassing the ruleset for an emergency hotfix still gets told, on `main`,
what the bypass skipped. **Nothing here deploys**, so a red run on `main` is a statement about the
repository and never about production, which is still serving the last release.

### Build and deploy an estate (`build.yml`, `serve-dev.yml`, `serve-prod.yml`)

**IT HAS NO TRIGGER AT ALL: it is `workflow_call` only, and `release.yml` is its one caller**
(user, 2026-09-02: *"Le deploiement (production, android, ios...) se fait au bump. Pas au push sur
main."*). A push to `main` deploys nothing, and there is no `workflow_dispatch` either - a dispatch
would simply be a second door. Retrying a half-failed deploy is "Re-run failed jobs" on the release
run that already exists.

**IT IS THEREFORE A JOB OF THE RELEASE RUN, WHICH HAS ONE CONSEQUENCE WORTH KNOWING:**
`gh run list --workflow build.yml` returns NOTHING. A called workflow's jobs belong to the caller's
run, so the run to read is the `Release` one, and the harness's `deploy.mjs` names `release.yml` for
that reason.

**WHICH ESTATE IS DECIDED BY THE RELEASE, NOT BY A BRANCH, AND NOT BY THIS FILE EITHER.** It is
told, as three inputs - `sha`, `version`, `prerelease` - resolved ONCE by the caller's `preflight`
job. Until 2026-09-03 it read `frontend/package.json` back off a checkout and decided for itself,
which is how three chains came to each re-derive the same fact:

| The release | What is deployed | Image tag it moves |
| --- | --- | --- |
| `v0.15.0-alpha.1` (pre-release) | `dev.canari-emse.fr`, plus the Play *internal* track and TestFlight | `:dev` |
| `v0.15.0` (stable) | production | `:latest` |

1. `detect-changed-services` diffs against the previous release **of the same kind**
2. Builds the frontend against that estate's `VITE_*` set, then only the changed images → GHCR
3. Self-hosted runner: sync `.env`, `docker compose pull` + `up -d`
4. Database migrations, then health checks

**THE CALLER DECIDES, ONCE, AND A HYPHEN IS STILL THE DEFINITION.** The reason this used to be
read out of the manifest here is worth keeping, because it explains what NOT to go back to:
`github.event.release.prerelease` does not exist in a `workflow_run` context - the event was the
bump run's completion, not the release - and `workflow_run.head_branch` carried the tag for a
release-triggered bump but said `main` when the bump was dispatched by hand, which would silently
have sent an alpha to production. So the manifest was the only honest source available *to a
workflow woken by another workflow*. Now that all three arms are CALLED, the honest source is the
caller: `release_kind()` in `.github/scripts/lib/release-preconditions.sh` answers stable-or-
prerelease once, off the version being released, and the same answer reaches the estate, the Play
track and the App Store channel. A hyphen in a semver version IS the definition, and there is now
exactly one implementation of that sentence.

`GITHUB_TOKEN` pushes from the version-bump workflow do **not** trigger `on: push`. CD is chained via `workflow_run` instead (no `branches:` filter — GitHub would silently drop release-triggered parents).

#### The baseline is the previous release OF THE SAME KIND, and that is forced by the image tags

Production deploys `:latest`, which only a stable release moves; dev deploys `:dev`, which only a
pre-release moves. A service a release does not rebuild keeps whatever that estate's tag already
points at - so the honest question is "what changed since the last release THAT ESTATE received".
Taking the previous release of *either* kind for dev would skip rebuilding a service changed since
the last alpha but not since the intervening stable, and dev would run a months-old image under a
tag claiming otherwise. With no previous release of that kind, everything is built: over-building
is slow, under-building ships an estate referencing an image that does not exist.

**The order comes from the GitHub API, not from `git tag --sort=v:refname`**: git's version sort
places `v1.0.0-alpha` AFTER `v1.0.0` unless `versionsort.suffix` is configured, which is the wrong
way round for every pre-release. `gh api .../releases` returns them newest-first by creation, which
is the order they deployed in.

**`prod-deployed` is gone, and its replacement answers a different question.** That tag was the
change detector's INPUT; the detector reads releases now, so the tag survives only as `prod-released`
- the record of which commit production is serving, written by the deploy that made it true. The
user took that deletion knowing its cost: **after an emergency push straight to `main`, nothing says
which commit production is running** until the next release.


#### Every job checks out the SHA `release-kind` resolved, because `main` is a moving reference (2026-09-03)

All five jobs used to check out `ref: main`, and the comment above `CHECKOUT_REF` explained why it
is `main` and not the event's SHA — correctly, and only half the question. **`main` moves.** Five
jobs resolving it independently can resolve five different commits, and the window is not
theoretical: the bump's own push raises a `push` event (see the App-token side effect above), so
`ci.yml` is running on `main` while this workflow starts, and any pull request merged in those
minutes lands inside it.

**What made it a correctness bug rather than a race nobody would notice** is that
`release-kind.outputs.sha` is what tags the images and writes the `prod-released` / `dev-deployed`
markers. A second commit arriving mid-run would have been BUILT while the first one was RECORDED —
so the marker naming what production runs would have been wrong, with nothing anywhere disagreeing.
A recorded provenance that can be false is worse than none, because it stops the next person looking.

The commit is now resolved in the release's `bump` job and handed to every arm as `inputs.sha`.
One release, one commit, and the marker is a measurement instead of an assumption.

**AND THE CROSS-CHAIN HALF IS CLOSED TOO, since 2026-09-03.** `android.yml` and `ios.yml` used to
check out `main` by name, which was a smaller version of the same defect: a merge landing between
the two runs would ship a store bundle built from a different tree than production, and because
those workflows recorded no marker there was nothing anywhere to contradict. The fix was the one the
backlog said it needed - *deciding where the release's SHA is resolved ONCE for all three chains* -
and the answer is `bump.outputs.sha`. `release-chain.test.sh` asserts that no arm checks out
`ref: main` and that all three receive that output, because this is a wiring property and wiring is
what a file can be read for.

#### The dev estate is the PRE-RELEASE target, and the promotion is gone

| The release | Jobs that run |
| --- | --- |
| pre-release | `release-kind`, `detect-changed-services`, `build-frontend`, `build-docker-images`, `deploy-dev` |
| stable | the same four, then `deploy-to-server` |

**`build-frontend-dev`, `build-frontend-images-dev` and `promote-dev-to-main` were deleted on
2026-09-03.** The first two were a near-identical copy of the frontend build, kept only because one
push used to deploy both estates at once - a run deploys exactly one now, so the single job picks
the estate's `VITE_*` set and tags the right images. **The frontend cannot be re-tagged from one
estate to the other**: SvelteKit inlines `import.meta.env.*` at build time, so the API origins, the
Authentik client id and the "test environment" banner are baked into the bundle.

`promote-dev-to-main` fast-forwarded `main` onto `dev` once the dev estate had ANSWERED
`/api/version` as that commit. It existed because `dev` was a branch nothing else would advance, and
a branch nobody promotes is a parking lot. With one branch there is no promotion left to perform.

**WHAT WAS LOST WITH IT, stated because it was real:** an automatic proof, on production-shaped
data, that a commit serves before production is given it. A pre-release provides that only when
somebody publishes one. That is the trade the user chose, and it is written here so a later session
does not "restore" the promotion by accident.

All of the dev arm is gated on the repository variable `vars.DEV_ENVIRONMENT_ENABLED`, **`true` since
2026-09-02**. It is a `vars` and not a `secrets` entry so its value shows in the run log — a silent
gate is one nobody can debug. Setting it to anything but `true` makes a pre-release deploy nothing.

**A skip is not a success, and `deploy-dev` learned that the hard way.** Its `if:` accepted
`result == 'skipped'` for the jobs it listed — correct in itself, since a skip legitimately means
"this service did not change" — but the frontend BUILD was not in its `needs:` at all, so a FAILED
frontend build let the deploy run and point the stack at `frontend-ssr:dev`, an image never pushed.
GitHub reports a job whose dependency failed as **skipped**, not failed, so the two states are
indistinguishable from the status alone; what makes the disjunction honest is the `needs:` edge,
because without it there is no result to read and the condition is vacuously true. `build-frontend` is
in `needs:` and its result is checked, alongside the image job's.

**The deploy body is two scripts, not inlined YAML.** `infrastructure/deploy/render-env.sh` resolves
every `.env` key from `infrastructure/deploy/env-manifest.tsv` and refuses to write a partial file;
`infrastructure/deploy/deploy-environment.sh` then takes the environment as an argument. Dev reads
`DEV_<NAME>` for every secret and never the bare name, so a missing dev secret is EMPTY rather than
production's value. **Production's own deploy job is deliberately NOT on these scripts yet** — it
moves once dev has exercised them. Everything about the estate itself is on
[dev-environment](infrastructure/dev-environment.md), the only copy.

`scheduled.yml`'s `dev-refresh` job copies production's data into dev weekly (Mondays 04:00 UTC) and on demand, behind
the same gate.

### The store arms (`ios.yml`, `android.yml`)

Called by `release.yml` with the sha, the version and the release kind, so the Play track
and the App Store channel cannot disagree about what is being released:

| Workflow | Output | Stable | Pre-release |
|---|---|---|---|
| `android.yml` | `.aab` for Google Play | `production` track | `internal` track |
| `ios.yml` | `.ipa` via `altool`, then the App Store version created, the build attached and the whole thing **submitted for review** | App Store review | TestFlight |

**iOS USED TO STOP AT TESTFLIGHT, AND THAT WAS THE LAST ASYMMETRY BETWEEN THE TWO STORES.**
`altool --upload-app` hands Apple the binary and returns - exactly right for a pre-release, and one
manual gesture short of shipped for a stable: somebody had to open App Store Connect, create the
version, attach the build and press Submit. Nothing asked for that gesture and nothing reported its
absence, while the same release put Android on the Play `production` track by itself. So a stable
release was **half-shipped by construction**. `tools/app-store/submit.mjs` closes it; everything
about how, including the release-notes file a human owes each stable and why its first line names
its own version, is in [its README](../../tools/app-store/README.md), the only copy.

**BOTH ARMS ARE ALSO HAND-DISPATCHABLE, AND THAT IS A CAPABILITY RATHER THAN A SECOND DOOR.** It is
the only way to compile Swift, ObjC or Kotlin from the Windows workstation this project is developed
on. What makes it safe is `publish`, an INPUT: `release.yml` takes the callable default `true`, a
hand dispatch defaults to `false`, and every step that reaches a store or a release reads it. The
version that reasoned about `github.event_name` instead is the defect described two sections down -
in a called workflow that field is the CALLER's event, so the reasoning is not merely wrong, it is
unanswerable.

#### The Linux desktop build is SUSPENDED, not lost (2026-09-03)

`appimage-release.yml` was deleted on the owner's decision - *"il n'y a actuellement aucune
perspective de ce cote la"*. It worked: it built and attached a `.AppImage` to every release, and it
carried the same baked-origin assertion the store bundles do. Nothing was broken about it; there is
simply no audience for a Linux desktop client right now, and a release workflow nobody wants costs
about ninety seconds and ninety megabytes on every tag.

**What actually went, and what deliberately stayed.** The workflow file went, the README stopped
advertising a Linux desktop client, and the tables here and in
[the French guide](../user-guide/workflow-developpement.md) lost their row. **The incident records
kept the word on purpose**, because each one explains a guard that is still live: the
`@tauri-apps/plugin-log` parity check exists because a version mismatch killed Android, AppImage and
iOS on one tag, and the `rustflags` warning in `.github/actions/build-mls-wasm/action.yml` exists
because the AppImage release of v0.14.1 died of a leaked `-D warnings`. Deleting those sentences
would delete the reasoning behind checks that still run.

**Bringing it back is one file and no decisions.** The last version is in this repository's history
(`git log -- .github/workflows/appimage-release.yml`), Tauri's `bundle.targets` is still `all`, and
nothing else was adjusted to make its absence work - so restoring the file restores the behaviour.
`v0.15.0-alpha.1` is the last release carrying an AppImage asset; the asset was left attached rather
than deleted, because a published release is a record.

**One runtime fact survives the removal and must not be tidied away with it.** On
`tauri://localhost` - iOS, macOS *and* a Linux desktop build - WKWebView drops the refresh cookie,
which is why the client carries it in `X-Canari-Refresh` instead. That is a property of the engine,
not of a workflow, and it stays true for anyone who builds the desktop target locally
([sessions](sessions.md#the-credential-a-client-carries-itself)).

**THERE IS NO TESTFLIGHT GROUP TO SELECT, and that surprised the checklist.** `altool --upload-app`
hands the build to App Store Connect, and every INTERNAL tester sees every processed build
automatically - internal groups are not opt-in per build, unlike external ones. That is exactly why
decision 9 chose internal channels: no Beta App Review in the loop. On iOS the alpha/stable
difference is the backend the bundle is built against, and nothing else.

**PLAY ACCEPTS TWO TRACKS NOW BECAUSE EACH ALPHA CARRIES ITS OWN `versionCode`.** One upload per job
is still the rule - Google rejects re-uploading the same `versionCode` to a second track in one job,
confirmed on v0.9.21 (*"Version code 9021 has already been used"*) - and what changed is that
`bump-app-version.sh` bands the pre-release counter into the code, so an alpha and its stable are
different numbers. See the version-bump section for the band.

**AN ALPHA POINTS AT `dev.canari-emse.fr` AND A STABLE AT PRODUCTION, ASSERTED IN ALL THREE.** This
is the one place in the migration where a mistake ships to phones: a store build bakes its backend
origin in and cannot be re-pointed afterwards, so an alpha built against production would let the
tester programme write to real data, and a stable built against dev would point every user at a box
wiped every Monday. Neither is visible in a green pipeline, so each workflow resolves the URL and
FAILS on a mismatch. There is no fallback from the `DEV_*` secrets to the production ones - falling
back is precisely how an alpha ends up talking to production.

### Package 2: publishing a release (`release.yml`) - the one entry point

**THREE HUMAN GESTURES, AND NOTHING ELSE MOVES** (user, 2026-09-03): open a pull request, which
`auto-merge.yml` squash-merges onto `main` once `CI passed` is green and which deploys NOTHING;
publish a pre-release `vX.Y.Z-alpha.N`, which deploys `dev.canari-emse.fr` and feeds the store
tester programmes; publish a stable `vX.Y.Z`, which deploys production and both store production
channels.

`release.yml` is the only workflow either publication triggers, and it has five jobs:
`preflight` -> `bump` -> `deploy` + `android` + `ios`.

**IT CARRIES BOTH PUBLICATION PATHS RATHER THAN BEING TWO FILES, and the reason is worth keeping.**
The two publications are one machine differing by one boolean. A second entry point would either
duplicate the chain - the exact "a decision taken more than once" defect this rebuild removed - or
add a THIRD level of reusable-workflow permission plumbing, which is what killed this chain's first
run. So the paths are told apart by the EVENT TYPE:

| event | estate | Play | App Store |
|---|---|---|---|
| `prereleased` | `dev.canari-emse.fr` | `internal` | TestFlight |
| `released` | `canari-emse.fr` | `production` | submitted for **review** |

**AND THAT CLOSED A DEFECT NOTHING COULD SEE.** `published`, the old trigger, fires for BOTH kinds,
so the "Set as a pre-release" checkbox was invisible and the version string was the only statement
read - ticking the box on a `v0.17.0` silently deployed production, and forgetting it on a
`v0.17.0-alpha.1` silently pushed a tester build to both production channels. Neither shows in a
green run. `prereleased` and `released` fire for exactly one kind each, so both statements now
arrive and the preflight compares them: the event says one, `release_kind()` says the other, and a
mismatch is a refusal naming BOTH sides, because whichever is wrong the reader has to know which to
change. The dispatch path keeps the old behaviour, deliberately: a dispatch carries no checkbox, so
the version is the only statement made. The three arms are `uses:` calls, not
`workflow_run` listeners, so they are jobs of ONE run: one page to read, real `needs:` ordering,
and the same inputs to all three.

**AND INSIDE EACH ARM, THE STORE COMES BEFORE THE GITHUB RELEASE ASSET** - which is not cosmetic
ordering, it is what `v0.16.0` cost. Both arms attached their bundle to the GitHub release BEFORE
publishing to the store. On the stable that attachment was refused (`Resource not accessible by
integration`, pointing at *update-a-release*, with `Contents: write` granted and PRINTED by the
runner), and `Upload to TestFlight` plus the App Store submission were both `skipped` behind it:
production and Google Play received 0.16.0 and **Apple received nothing**, the run complaining only
about the convenience. The Android arm had the identical ordering and merely happened to succeed.
**A store is the deliverable; a release asset is a copy for humans** - so the store is served first
and a refusal on the asset still fails the job, having already shipped. The assertion is on the
ORDER and on the ABSENCE of `continue-on-error`, because swallowing the refusal would trade a
visible skip for an invisible one. **The refusal itself is unexplained** and open in
[backlog](backlog.md), with six causes ruled out by measurement.

**WHY IT IS ONE FILE NOW.** Until 2026-09-03 the two publications drove FOUR workflows chained by
`workflow_run`, and three things were measured wrong on the first day the chain ran for real:
nothing was gated on the TESTS (the chain required the BUMP to succeed, which is a different
statement, and `v0.15.0` shipped on a RED run); production went AHEAD of dev, the two gestures
landing on two unrelated commits with nothing comparing them; and each chain resolved `main` for
itself. All three are the same defect - a decision taken more than once, and a precondition
asserted nowhere.

#### The five gates, and the one that makes a lag impossible

`.github/scripts/release-preflight.sh` runs before the bump, so a refusal refuses the deployment,
both store uploads and the version bump itself:

| # | Question | Why a refusal rather than a report |
|---|---|---|
| 1 | Is the version a version? | a typo must not reach a store band computation |
| 2 | Is the released commit on `main`? | everything downstream reads the trunk |
| 3 | Did `CI passed` conclude **success** on THAT commit? | "if the tests are green" was written nowhere at all, and an ABSENT check is not a passing one |
| 4 | Has the dev estate already served it? (stable only) | **production cannot be ahead of dev** |
| 5 | Do the App Store release notes name THIS version? | Apple refuses a submission without them, and refusing at the END of a release costs the whole release |

**Gate 4 is why this file exists** (user, 2026-09-03: *"Je ne veux pas un detecteur de retard, je ne
veux pas que ca soit possible"*). It compares the released commit against the `dev-deployed` marker
the dev deploy writes: `identical` or dev `ahead` both mean the code went through dev, and dev
`behind` is a refusal naming how many commits are missing and telling the reader to publish a
pre-release at that commit first. A detector was written first and deleted unshipped - the same
measurement, as a refusal instead of a report.

**THERE IS NO BYPASS INPUT, deliberately.** A skip flag is a fallback path, and reaching one means
the primary path failed - so the fix belongs there. The emergency path is unchanged and is not in
software: a human with admin rights acting by other means, written into `CHANGELOG.md` when taken.
Gate 4 costs one extra pre-release in a real emergency, which deploys dev in minutes.

#### The bump job

It stages `git add -u`, so whatever the bump script writes is what gets committed — see
[Version bump](#version-bump) below for why that replaced a path list.

#### The push this workflow makes is the ONE push to `main` that is not a pull request, and the ruleset refused it (measured 2026-09-03)

**The first real release found this, and nothing before it could have.** `main` carries ruleset
`22152902`: no direct push, `CI passed` required. The bump ends in `git push origin HEAD:main`, and
with `GITHUB_TOKEN` that push is made by `github-actions[bot]`, which is not a bypass actor. So the
push was refused, the run went red, and **nothing downstream started** — every arm needed the bump.
Fail-safe, and a chain that does not run. **That accident is now the design**: the preflight sits in
front of the bump precisely because everything already depended on the bump succeeding.

**The Actions app cannot be exempted.** Adding it to `bypass_actors` returns
`422 Actor GitHub Actions integration must be part of the ruleset source or owner organization`
for a repository-level ruleset. That was measured, and the ruleset read back unchanged afterwards.

**What works is the App that is already installed.** `canari-auto-merge` (app id `4791068`) is an
organisation installation, so GitHub accepts it as a bypass actor — and
`dependabot-auto-merge.yml` already mints installation tokens for it. The bump job now does the
same and checks out with that token, because a later `git push` uses whatever credential the
checkout persisted. **`auto-merge.yml` mints the same identity for the same asymmetry read the
other way round** - see below. The token is minted per run and expires in an hour, which is why an App beats a
long-lived PAT here: there is no secret to rotate before it silently expires.

**One side effect, and why it is harmless HERE.** A push made with an App token *does* raise a
`push` event, where a `GITHUB_TOKEN` push does not — `dependabot-auto-merge.yml` documents that
asymmetry and depends on it. The consequence is that `ci.yml` runs once on the bump commit, which is
useful rather than costly. **It does not double a deploy, only because the three deploy libraries have no trigger at all** - it is
`workflow_call` only. Anyone giving a deploy workflow a `push` trigger has to read this paragraph
first.

**AND THE SAME ASYMMETRY IS LOAD-BEARING IN THE OTHER DIRECTION, WHICH IS WHY `auto-merge.yml` USES
AN APP TOO.** Auto-merge merges as whoever armed it. Armed with `GITHUB_TOKEN`, the merge would
raise no `push` event, `ci.yml` would never run on `main`, the merge commit would carry no
`CI passed` check - and gate 3 above would then refuse EVERY release, on commits that had in fact
been tested. Someone "simplifying" `auto-merge.yml` to the default token would break releasing from
a file that has nothing to do with releasing, so `release-chain.test.sh` asserts it does not.

**The first release, `v0.15.0-alpha.1`, sidestepped this rather than fixing it**: the bump was landed
through an ordinary pull request BEFORE the tag, so the workflow re-ran the same script, found no
diff, printed `No version changes` and exited 0 without ever reaching the push. That worked and
proved the rest of the chain, but it made publishing a release a two-step manual dance. The App
token is the fix; bump-before-tag stays available as the emergency path if the App is ever
uninstalled.


#### The bump promotes the release notes, and that is the one modification nothing was making (2026-09-03)

Every version-bearing manifest is rewritten by the script; `CHANGELOG.md` was not touched at all.
So `## [Unreleased]` stayed `[Unreleased]` through every release, and the next cycle wrote its
entries into the same section. **That is not cosmetic drift: it is why 4098 lines sat under one
heading covering fifteen shipped versions, with no way left to say which release a user got a given
fix in.** Nothing failed, which is exactly why it survived fifteen releases.

`promote_changelog` in `scripts/bump-app-version.sh` now rewrites `## [Unreleased]` into a fresh
empty `## [Unreleased]` followed by `## [X.Y.Z] - <date>`. Three properties matter, and each is a
test in `.github/scripts/tests/bump-staging.test.sh`:

- **STABLE ONLY**, which is the whole reason `RANK` is passed in. An `-alpha.N` is a tester build,
  not the release of those notes: promoting on it would close the section and leave the stable that
  follows days later publishing an empty one — the same drift, inverted.
- **IDEMPOTENT**, because a re-run is ordinary — the workflow is hand-dispatchable and a release can
  be re-published. A heading for that version already present means the work is done.
- **IT REFUSES TO PROMOTE AN EMPTY SECTION, and emits a `::warning::` rather than a log line.** A
  version heading with nothing under it reads as a fact ("this release documented nothing") instead
  of as the gap it is. **This arm is reached in the ORDINARY course of things** - every release
  leaves `[Unreleased]` empty behind it, so the next one finds it empty unless somebody wrote an
  entry, and a line on stderr in a runner log is not a report. It must not FAIL the release either
  (a release is what ships a fix; blocking one over a documentation gap is the wrong trade), so
  under GitHub Actions it annotates the run summary where the person who published the release will
  see it. Its own test found this: `v0.15.0` left `[Unreleased]` empty, three assertions written
  against the repository's changelog started failing, and the mechanism was behaving exactly as
  designed - which is why the suite now writes its own fixture and asserts BOTH arms.

**It lives in the SCRIPT and not in the workflow**, so `git add -u` picks it up with everything else
and the notes land in the bump's own commit. A workflow step doing it after the commit would need a
second commit and a second push, and the push is the part the ruleset scrutinises.

`v0.15.0` is the first release promoted this way, and its section therefore spans everything since
`0.14.0` rather than only its own changes — the fourteen releases in between were published while
the drift was live. That is stated inside the section rather than corrected, because re-attributing
4098 lines to fifteen tags after the fact would be a guess.

**ONE ARGUMENT BECOMES THREE DIFFERENT STRINGS**, and conflating any two of them breaks a store
upload rather than a build. `scripts/bump-app-version.sh` is the only place that decides:

| Value | Example | Where it goes | Why |
|---|---|---|---|
| the full version | `0.15.0-alpha.1` | every `package.json`, `Cargo.toml`, `Cargo.lock` | all accept a semver pre-release, and `frontend/package.json` is what the client identifies itself by (`VITE_APP_VERSION`, so `minClientVersion` compares against it) |
| the numeric core | `0.15.0` | `tauri.conf.json`, `CFBundleShortVersionString`, `MARKETING_VERSION` | Apple requires the short version to be numeric; a suffix there is an App Store validation failure |
| the band | `1500001` | `bundle.android.versionCode`, `CFBundleVersion`, `CURRENT_PROJECT_VERSION` | one integer identifies a build on both stores, and every alpha needs its own |

**THE BAND IS `(major*1e6 + minor*1e3 + patch) * 100 + rank`, `rank` = N for `-alpha.N` and 99 for a
stable.** 99 and not 0: rank 0 would put `0.15.0` BELOW every alpha of `0.15.0`, and a store refuses
a code it has already accepted. The order reads `0.15.0-alpha.1` 1500001 < `-alpha.98` 1500098 <
`0.15.0` 1500099 < `0.15.1-alpha.1` 1500101. Today's `0.14.15` shipped as 14015 under Tauri's own
derivation (`major*1e6 + minor*1e3 + patch`, which cannot see a suffix), so the band steps up by a
factor of 100 exactly once and stays monotonic; the ceiling `0.999.999` → 99999999 is well inside
Play's 2100000000. `alpha.N` is capped at 98 for the same reason.

**AND THE ONE THING THAT WAS NOT SETTLED NOW IS (measured on `v0.15.0-alpha.1`, 2026-09-03).** The
open question was whether `tauri ios build` re-syncs both version keys from `tauri.conf.json` during
the build and so overwrites the committed `CFBundleVersion` — which would make the second alpha of a
version a duplicate build TestFlight refuses. **The shipped `.ipa` carries
`CFBundleShortVersionString 0.15.0` and `CFBundleVersion 1500001`, which is the band.** Whether
Tauri rewrote the plist or left it alone is therefore moot: the script writes the same numbers into
`tauri.conf.json` and into the plist, so a re-sync is idempotent, and Tauri 2.11.4 exposing no iOS
build-number override costs nothing. `ios.yml` still patches that plist with `PlistBuddy`
for the export-compliance key; nothing needs to re-assert the build number there.

`.github/scripts/tests/bump-version.test.sh` runs the script in a sandbox, reads every file back and
asserts the ordering directly (31 assertions).

## GitHub Secrets

See [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) (section 3) for the full secrets inventory.


**A credential is real in THREE places, not two.** The CD regenerates `infrastructure/.env` from the
repo secrets, so a value set over SSH lasts until the next deploy. It must therefore be a GitHub
secret AND named in `serve-prod.yml` - and the third, just as mandatory and the easiest to forget, is the
service's own `environment:` block in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for
parity), spelt explicitly as `FOO: ${FOO:-}`. `.env` holding the value proves nothing about whether
Compose passes it INTO the container: `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `serve-prod.yml`
and `.env.example` and was still absent from the running container (WP-SAFELINK-1), where the
endpoint answered 200 with a silently fail-open verdict rather than an error.
`docker exec <container> env | grep FOO` is the only way to catch it.

## Rotating `JWT_SECRET`

One HS256 secret signs every token of all six services, so a leak in the smallest of them mints
admin tokens for all. Rotating it is already a supported operation — nothing in the workflows needs
changing — but nothing schedules it either, which is why it is written down here.

**The procedure is two steps**, and the second is not optional:

1. Change the `JWT_SECRET` repository secret (`openssl rand -hex 32`).
2. Re-run the CD workflow.

`serve-prod.yml` makes this safe by refusing every failure mode it can see:

| Step | What it does |
|---|---|
| l.498 | Fails the deploy outright when `JWT_SECRET` is absent — no accidental default |
| l.538 | Upserts it into `infrastructure/.env` on the server |
| l.863-869 | Re-reads the value **from inside the running core-service container** and compares its sha256 against the GitHub secret |

That last check is what makes a rotation believable: a deploy where the new secret did not actually
reach the running process **fails**, instead of reporting success over a service still signing with
the old key.

**Rotation is a hard cut, on purpose.** There is no `JWT_OLD_SECRET` grace window in Canari and
none should be added: the grace period is paid for with a second step that is invisible and
therefore never taken (Le Cercle's production is the standing proof — its old secret still signed
sessions months after the rotation "happened"), and it is exactly backwards for the case you
actually rotate in, a leak, where the old key must die *now*. Canari signs in through Authentik, so
the cost of the hard cut is one mostly transparent SSO redirect.

**A rotation is not the everyday revocation lever.** Signing one device out, or ending one stolen
session, is a row in `auth_sessions` — see [`services/core-service.md`](services/core-service.md).
Reach for the secret only when the secret itself is suspect.

## Container registry

All service images are published to GitHub Container Registry:

```
ghcr.io/emse-students/canari/<service>:<tag>
```

| Tag | Meaning | Moved by |
|---|---|---|
| `latest` | what production is deploying | a STABLE release |
| `dev` | what the dev estate is deploying | a PRE-RELEASE |
| `<sha>` | the immutable one - this exact commit | every release that builds the image |
| `v0.15.0-alpha.1` | the release that produced it | every release that builds the image |

**The two moving tags never cross**, and that is what lets one registry feed two estates from two
different commits. Neither decides what actually runs: both compose files are deployed with an
explicit tag, and a service a release did not rebuild keeps whatever its estate's tag already points
at - which is what a selective rebuild means.

## Self-hosted runner

The `deploy-to-server` job runs on a self-hosted GitHub Actions runner (label `self-hosted`) on the production server (`canari`). This runner:

- Has direct access to the Docker socket (no SSH needed for container management)
- Has SSH access to `mitv` (offsite backup server)
- Runs as the `canari` system user

### There is one runner, so a workflow that asks for it must say what it may not overlap with

All three deploy libraries declare `concurrency: { group: cd-deploy, cancel-in-progress: false }`. Until 2026-09-02 it
declared nothing, and three deploy runs were in flight against `/home/canari/canari` at once - each
able to `git reset --hard` and `docker compose up` while another was mid-flight. Production came out
of it answering normally, which is why the gap had gone unnamed: the race heals cleanly almost every
time.

Three details decide the shape, and only the first is obvious.

- **One group covers BOTH estates.** They are two checkouts on one machine and one run deploys both,
  so a per-environment group would let a dev deploy and a prod deploy overlap on the same Docker
  daemon.
- **`cancel-in-progress: false`.** A killed deploy leaves containers half-recreated and the checkout
  on a commit whose images were never pulled - a state nothing downstream is written to recognise.
  Queueing behind a running deploy is the only safe answer.
- **What makes the runs GitHub drops harmless is a property of the DETECTOR, not of this block.**
  At most one run waits per group; the rest are cancelled while pending. That would lose work if
  `detect-changed-services` measured against the previous RUN - it measures against the previous
  RELEASE of the same kind, which no cancelled run can move, so the survivor rebuilds everything the
  dropped ones would have. **The baseline was the `prod-deployed` tag until 2026-09-03**, and that
  tag was itself the second reason to serialise: two overlapping runs could have one write it while
  the other was still deploying, making the baseline claim a deploy that had not finished. A release
  is published by a human before any of this starts, so that particular race went with the tag. What
  is left to serialise is the Docker daemon and the checkout, which is reason enough.

`deploy-env.test.sh` asserts this, DERIVED from `runs-on: self-hosted` rather than from a list of
workflow names - there is exactly one such runner, and a typed list would pass on the day somebody
adds the third workflow. `scheduled.yml`'s `dev-refresh` job carries its own `dev-refresh` group and satisfies the same
rule.

**Still open, and not covered by either group:** a dev refresh and a dev deploy can overlap, the
refresh stopping dev's containers to restore while `deploy-dev` brings them up on new images. A
workflow may declare only one group, so joining them would put a Monday-04:00 database restore in
front of a production hotfix - a cost paid on the production path for a dev-only race. It is named
here rather than fixed silently.

## Release workflow

```
gh release create vX.Y.Z --target $(git rev-parse HEAD)      <- the human gesture, and the last one
  |
  '- Release (release.yml), ONE run
       |
       |- preflight   five gates; a refusal ends it here, having moved nothing
       |- bump        writes the version into 18 files, commits, pushes to main, outputs the SHA
       |
       |- THE FORK, and there is only one: prerelease -> estate = dev | production
       |
       |- three arms, in parallel, each building THAT SHA
       |    |- build.yml    the frontend and every docker image, built FOR that estate
       |    |- android.yml  .aab -> Play `production` (stable) or `internal` (pre-release)
       |    '- ios.yml      .ipa -> App Store Connect, then for a stable: version created,
       |                    build attached, release notes written, SUBMITTED FOR REVIEW
       |
       |- serve-dev.yml   PRE-RELEASE ONLY, needs [build]
       |    '- dev.canari-emse.fr - never held behind a store queue an alpha does not use
       |
       '- serve-prod.yml  STABLE ONLY, needs [build, android, ios]
            '- canari-emse.fr - and only once BOTH stores accepted this version
```

A pre-release stops at TestFlight and the Play `internal` track, which is what a tester programme
is. A stable goes all the way on both stores. **Nothing here is reached by a push to `main`.**

### The web goes last, and only if both stores took the same version

Since 2026-09-04 (user: *"j'aimerais que toutes les versions soient toujours alignees [...] on
pourrait faire en sorte que le deploiement sur les stores et sur le web soit coordonne ?"*).

**What "aligned" can and cannot mean.** Store AVAILABILITY is never simultaneous - Apple reviews in
days, Play rolls out over hours - so no gate can make three destinations live at the same instant,
and one claiming to would be lying. What IS enforceable is the useful half: **the web never serves
a version a store refused.** A build that fails to sign, an `.aab` Play rejects, an App Store
submission answered with a 500 - each now leaves `production` *skipped* and production serving the
previous release, instead of a web estate a version ahead of every phone.

**Why the two estates are separate calls.** A called workflow cannot depend on a job of its caller,
so `needs: [android, ios]` is only expressible out in `release.yml`. Until 2026-09-07 that was done
by calling ONE file, `deploy.yml`, TWICE with a `phase: build | production` input - and that is the
shape that had to go. GitHub materialises EVERY job of a called workflow as a row in the run graph,
including the jobs whose `if:` cannot possibly hold on that call, so each call drew the other call's
jobs as skipped rows that were not "not taken this time" but INCAPABLE of running. Measured on
`v0.16.4` (run 34057019347), the last stable to reach the end: **22 rows, 5 skipped, and 4 of those
5 structurally impossible.** A parameter that selects half a file produces the other half as dead
rows, on every call, for ever.

So the split is by what a file DOES: `build.yml` builds, `serve-dev.yml` and `serve-prod.yml` each
deploy one estate, and `release.yml` calls exactly the ones a release kind needs. Every row a run
draws is a row that can run; `release-chain.test.sh` fails if any workflow is ever called twice
again. The permissions became exact as a side effect - the single `deploy` job had to grant the
UNION of what both halves needed, so the build jobs ran with a token that could move release
markers and the estate jobs with one that could push images.

**And the release kind is asked ONCE** (user, 2026-09-07: *"faire la dichotomie plus tot dans
l'arborescence"*). `preflight` resolved it, and it was then carried DOWN as `prerelease` and
re-tested in eight places, each callee re-deriving the same fork for itself. It becomes an estate
NAME at the fork - `dev` or `production` - and below that point nothing asks again: neither estate
workflow mentions a pre-release at all, and `build.yml` is simply told which estate it is building
for. Two things genuinely differ by estate and both read that name directly: the secret set that
goes into the frontend `.env`, and the floating docker tag. The rename also collapsed the URL
cross-check from two branches into one comparison - `URL_ENVIRONMENT != ESTATE` - because both
sides finally speak the same vocabulary.

**`needs:` is a SUCCESS dependency and there is no `always()` there.** That is what makes the gate
real rather than a formality: a failed or cancelled mobile arm leaves `production` skipped, and the
recovery is "Re-run failed jobs" on the run that already exists. `release-chain.test.sh` fails if
`always()` ever appears in that job, because inside `build.yml` the `always() && <result test>`
shape is used legitimately and would read as idiomatic here.

**The measured cost is ~14 minutes, paid by production alone**, from `v0.16.1-alpha.1`: the two
mobile arms are the wall, and everything else already finished inside their shadow.

## A manual workflow run is the only native compiler available off macOS

`android.yml` and `ios.yml` both accept `workflow_dispatch`, and **every** publish step (GitHub
Release, Google Play, TestFlight, the App Store submission) is gated on the `publish` input, which a
hand dispatch defaults to **false**. A manual run is therefore a pure compile check that ships
nothing — and it is the only way to compile Swift, ObjC or Kotlin from a Windows machine. Dispatch
both before believing any native change.

**THE GATE USED TO BE `github.event_name == 'workflow_run'`, AND THAT BROKE THE DAY THE CHAIN
COLLAPSED INTO ONE RUN.** In a `workflow_call` workflow `github.event_name` is the CALLER's event -
`release` or `workflow_dispatch` - so the condition went permanently FALSE, and four steps died at
once: both "Upload to Release" steps, the TestFlight upload and the Play publish. The build would
have succeeded, the run would have been green, and **no store would have received anything**. It was
caught by reading the files rather than by any gate, and the assertions that would have caught it
are now in `release-chain.test.sh`. The rule it left: **a condition that cannot be true is the same
class of defect as a required check that is always skipped** - invisible, green, and load-bearing.
What replaced it carries the distinction as DATA, from the one place that knows it.

This is not a formality. A Swift `guard` body that falls through, a Kotlin nested type declared in
a companion object, a plugin command missing from its ACL: none of these are visible to
`cargo clippy`, `bun run check` or any gate that runs locally. On Android specifically, the release
build (`:app:compileUniversalReleaseKotlin`) is the first real Kotlin compile — a debug build does
not exercise it.

### A green run is not proof that *your* file compiled

The iOS `project.pbxproj` is hand-maintained (there is no xcodegen here), so a source file that is
in the repository but absent from the target's build phase is **skipped, not failed**. The run is
green and the change was never compiled. Grep the log for the file by name:

```
SwiftCompile ... <YourFile>.swift
CompileC     ... <YourFile>.o
```

**That grep is iOS-only, and looking for a Kotlin equivalent wastes an afternoon.** Tauri drives
Gradle quietly - no `> Task :` lines, no `BUILD SUCCESSFUL` - so hunting a task line finds nothing
and proves nothing either way. It is also unnecessary: Gradle compiles by **source set**, so a file
sitting in `src/main/kotlin` cannot be silently skipped, and the produced APK is itself the proof.

**A disappeared compiler warning can be the verdict.** When a deprecation warning was the only
thing that ever revealed a piece of dead code, its absence from the next run is what confirms the
removal - there is nothing else to assert against.

### A raw `cargo build` for the static lib must ask for `custom-protocol` itself

`ios.yml`'s "Prebuild Rust static lib (libapp.a)" step calls `cargo build --lib --release
--target aarch64-apple-ios` directly rather than `tauri ios build`, because that CLI's export step
cannot express the two-target (app + NSE) manual-signing profile map this project needs. But
`tauri ios build` is also the thing that normally enables the `tauri` crate's `custom-protocol`
Cargo feature - and `tauri-build`'s `build.rs` derives its `dev` cfg from exactly that feature
(`dev = !has_feature("custom-protocol")`, `tauri-2.11.1/build.rs`). Skip the feature and the release
profile compiles as a **dev build anyway**: the webview loads from the Vite dev server
(`WebviewUrl::App` resolving against `devUrl`, `127.0.0.1:1420`) instead of the bundled
`frontendDist` assets, which is unreachable from a real device. The symptom is a black screen on
launch with Tauri's own hardcoded string, `Failed to request https://127.0.0.1:1420/: ... did you
grant local network permissions?` (`tauri-2.11.1/src/protocol/tauri.rs`) - this shipped once, to
TestFlight, before the step was corrected to pass `--features tauri/custom-protocol` explicitly.
Android does not carry this risk: `android.yml` builds through `bun tauri android build`,
the real CLI, which sets the feature itself.

**Enabling the feature has a second consequence: `generate_context!()` now actually validates
`frontendDist`.** With `custom-protocol` on, the macro embeds `../build` into the binary at compile
time and panics if that directory is missing - it only skips the check in dev mode
(`dev && dev_url.is_some()`, `tauri-codegen`'s `context.rs`). "Prebuild Rust static lib" runs
**before** "Build iOS archive" - the step that actually runs `bun run build` to produce `../build` -
an order that only worked while the build was silently compiling as dev and never looked at the
directory. The Vite build now has its own step, "Build frontend", placed before the Rust compile.

## Signing

Two **named** provisioning profiles must exist and match `PROVISIONING_PROFILE_SPECIFIER` exactly:
one for the `Canari` app, one for the `CanariNotifications` notification-service extension. Team is
"Les Rootz" (`4CLNB8SR6L`); the profiles expire **2027-07-11**.

`ios.yml` also patches `ITSEncryptionExportComplianceCode` into `Info.plist` at build time
from the `APP_STORE_CONNECT_EXPORT_COMPLIANCE_CODE` secret (App Store Connect's own compliance
documentation code for this app - distinct from `ITSAppUsesNonExemptEncryption`, which is committed
since it's not account-specific). Kept as a secret rather than committed: this is a public repo, and
every other Apple-account value here is already handled that way. The step skips, not fails, when
the secret is unset - `Info.plist` stays as committed, and the TestFlight upload step fails with a
409 explaining exactly why.

## Version bump

`scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION` alongside the app's — an NSE left behind on an older version is rejected
at upload.

**`bump-version.yml` used to stage an explicit `git add` list, and that was a standing hazard this
page carried as a warning: any new file the script learned to patch had to be added there too, or
the bump silently left it uncommitted.** A warning is not a mechanism. Since 2026-09-03 the step
stages **`git add -u`**, which asks git what changed instead of asking a human to remember — the
list was a second, silent statement of which files carry a version, and nothing compared the two
statements. `-u` and not `-A`, deliberately: it stages modifications to TRACKED files only, so an
untracked artefact cannot ride along. `frontend/mls-core/Cargo.lock` is the live example — the
script rewrites it, `.gitignore`'s `*.lock` means git does not track it, and it must stay out of the
commit. `.github/scripts/tests/bump-staging.test.sh` asserts the whole shape in a detached
worktree: 17 tracked files modified and all covered, no untracked file created, no manifest left on
the previous version, and both store numbers carrying the band.

A `Cargo.lock` pins the version of every LOCAL crate as well, and it does **not** live next to the
crate it pins: `mls-core` is pinned in `frontend/src-tauri/Cargo.lock` **and** in
`frontend/mls-wasm/Cargo.lock`. So the script
collects the `[package] name` of every manifest it bumps and rewrites every matching `[[package]]`
block in every lock — a per-crate patch, not a per-directory one.

Until 2026-08-06 it patched no lock at all, and the symptom was not a broken build (nothing runs
`cargo --locked`) but a **misattributed diff**: the entry stayed a release behind until some
unrelated commit happened to run cargo and the pre-commit sweep carried the regenerated lock in.
`0.12.0 → 0.13.0` shipped inside a docs commit (`0e86b34c`) that way.

Which locks are committed is a separate decision, kept in `.gitignore`: a lock is committed when the
package it locks is itself built into a **shipped artefact** (`frontend/src-tauri`, `frontend/mls-wasm`,
`apps/*`), and ignored when the crate is only ever consumed as a dependency (`mls-core`) —
those resolve inside their consumer's lock. The negations must sit **after** the
generic `*.lock` line: last matching pattern wins, and for two releases a `*.lock` added lower in the
file silently overrode the `!apps/*/Cargo.lock` written above it. `frontend/src-tauri/Cargo.lock`
survived only because a tracked file ignores `.gitignore` entirely.


**A generated file the repo COMMITS needs both halves or neither** - the bump must patch it, and
`.gitignore` must really keep it. Worse than either half is a generated file **the formatter also
owns**: the Tauri plugin ACL outputs (`plugins/*/permissions/{autogenerated,schemas}/`) were written
expanded by `build.rs` and folded back by the pre-commit formatter, so every Android build dirtied
the tree and every commit undid it. They are gitignored now, like `gen/schemas/` already was; the
SOURCE (`default.toml`, and the `COMMANDS` list in `build.rs`) stays tracked. **Before ignoring any
generated file, delete it and rebuild** - that is the only proof the generator really owns it.

**A generated file in git is a COPY of the truth, and a copy goes stale in silence.** The question is
never "is it up to date", it is **which pipelines rebuild it and which ship the committed one**.
`frontend/src/lib/wasm/` was committed and rebuilt by `deploy.yml` alone, so the web ran the current
`mls-core` while the Android, iOS and AppImage releases shipped the binary from the last commit that
thought to regenerate it - **two different cryptos in one fleet, with nothing comparing them**.
Rebuilding the untouched sources produced a different binary, which is how it was proven rather than
argued. The fix is not a habit: **every pipeline shipping a client builds the artefact itself**, from
one composite action with one pinned toolchain
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)). A build step duplicated per pipeline is
the same defect wearing a different hat - two toolchains put two cryptos back in the fleet.

## Dependency updates, and the auto-merge that ships them

Dependabot opens the pull requests (`.github/dependabot.yml`); **from there they are the same as
anybody's**. `arm-auto-merge.yml` arms GitHub's own auto-merge on every pull request in the
repository, and GitHub squash-merges each one the moment `CI passed` goes green. The one thing a
dependency update is asked that a human's pull request is not is the `dependency-ceiling` job, and
that is a CHECK feeding `ci-passed`, so an update with no gate here cannot merge by any route.

**There is no sweep any more (deleted 2026-09-04).** `dependabot-auto-merge.yml` was 448 lines on an
hourly cron, plus a 179-line decision script and a 250-line staleness library, and it existed for one
reason: a `pull_request` run from Dependabot gets no secrets, so the arming job inside
`ci.yml` could not mint an App token on its pull requests. `pull_request_target` runs in
the base repository's context, with its secrets, for every pull request - so one file now covers the
whole population. What went with the sweep, and what did not:

| The sweep did | Now |
| --- | --- |
| Armed Dependabot's pull requests | `arm-auto-merge.yml`, for everybody, on `pull_request_target` |
| Refused updates this repository has no gate for | `dependency-ceiling`, a job of `ci.yml` feeding `ci-passed` |
| Asked Dependabot to rebase a branch whose gates had moved | **Nothing, and nothing did before** - see below |
| Failed hourly while any branch was stuck, mailing the owner every time | Gone with the cron |

**The rebuild half never worked, which is why deleting it loses nothing that ran.**
`@dependabot recreate` and `@dependabot rebase` authorise by PUSH ACCESS, and an App *installation*
is not an account with push access: `Contents: write` is not the same permission. Measured refused
ten times out of ten, on eight pull requests, with two identities (`github-actions[bot]` and the
`canari-auto-merge` App). The underlying question - can a pull request that was green against an
older set of gates still merge - is answered where it matters instead: `ci.yml` also runs
on `push: main`, so a merge that breaks the trunk turns `CI passed` RED on `main`, and
`release-preflight.sh` gate 3 then refuses every release cut from that commit. The protection sits at
the release, which is the only place it changes anything.

**Nobody is assigned to any of it.** `.github/CODEOWNERS` requested a review from two humans on every
pull request in a repository whose written model is that no approval is required (user, 2026-08-31:
*"Je prefere blinder de test et faire les choses automatiquement qu'avoir une review humaine qui
n'arrive jamais"*). It was deleted on 2026-09-04 with the sweep, for the same reason: a notification
about a decision nobody makes.

### Every update merges onto `main`, and what protects production is that a merge does not deploy

For one day (2026-09-02) all six blocks of `dependabot.yml` carried `target-branch: "dev"`, asked by
the user (*"Est-ce qu'on pourrait dire a Dependabot de push sur la branche dev au lieu de la prod
?"*). The user cancelled the two-branch model the following day; the lines are gone and updates
merge onto `main` again.

**The danger they answered has MOVED, not gone.** Every gate in this repository answers a question
about the SOURCE - does it compile, do the tests pass, is the lockfile coherent. None runs anything
against real data, and that is the class the outage of 2026-09-01 came from: `postgres
15-alpine -> 18-alpine` passed every gate, merged, and PG 18 then refused production's data
directory. 33 minutes down.

**What stands between that update and production now is that nothing deploys at a merge.** An update
sits on `main` until somebody publishes a release, and a `X.X.X-alpha.N` pre-release deploys the dev
estate - which still carries a copy of production - before any stable does. The honest difference is
WHO DECIDES: the old mechanism ran with nobody at the keyboard, this one runs when a human publishes
an alpha. The ceiling in `dependabot-auto-merge.yml` is what still refuses the update classes this
repository cannot see the failure mode of; it is not a substitute for a rehearsal, and
[backlog](backlog.md) says so.

**Two cables into CD were cut on 2026-09-03, and one was replaced rather than removed:**

- The **convergent trigger** was `CD - Deploy to Production`'s completion, because CD ran on every
  push to `main` and was therefore the closest thing to "somebody did something". CD runs once per
  release now, so hanging the sweep off it would drain the queue once a release. **`CI` took that
  job**, being what runs on every push to `main`.
- The **deploy dispatched after a merge** is gone. It existed because a `GITHUB_TOKEN` squash merge
  raises no `push` event - github's anti-recursion rule - so CD never saw a single merge and `main`
  drifted from production silently. There is no deploy to dispatch any more. **The dispatch itself
  survives, pointed at `ci.yml`**: the same anti-recursion rule means CI would not run on `main`
  either, and CI is what says whether the merged COMBINATION is green and what wakes the next sweep.

The **staleness comparison** still reads the pull request's own `baseRefName` rather than a `main`
literal. It is `main` for everything now, but that line is what would have to change the next time a
second branch exists, and hardcoding it is what made the previous switch a hazard rather than a
setting.

### Security updates are a SECOND switch, and neither `dependabot.yml` nor this page showed it

Dependabot has two independent halves, and only one of them lives in a file anybody reads.
`repos/{owner}/{repo}/vulnerability-alerts` decides whether an advisory is REPORTED; a separate
`repos/{owner}/{repo}/automated-security-fixes` decides whether one is ever FIXED by a pull request.
Until 2026-09-02 the first was on and the second was `{"enabled":false}`, so a push printing
`GitHub found 1 vulnerability on the default branch` was announcing an advisory with no actor at all.
Both are read with one call each:

```sh
gh api repos/emse-students/canari/vulnerability-alerts    # 204 = on, 404 = off
gh api repos/emse-students/canari/automated-security-fixes
```

**And the two halves interact in the direction nobody expects.** A security pull request ignores the
`update-types` restrictions in `dependabot.yml` - but only while the feature that opens it is
enabled. With it disabled, a conservative version-update rule silently BECOMES the security policy:
`cargo`'s `production-dependencies` group is capped at `update-types: ["patch"]`, so the minor bump
that carried GHSA-7gcf-g7xr-8hxj (`serde_with` 3.19.0 -> 3.21.0, in `frontend/src-tauri/Cargo.lock`)
was unreachable by every route at once. Check both switches, per ecosystem, and do not hand-patch the
lock instead - `cargo update -p serde_with --precise 3.21.0` also added `bs58` and dropped three
`windows-*` crates, a resolver-wide change on the one target this repository can only verify by
compiling. The rule is in [durable-rules](durable-rules.md).

### And a manifest can make a whole directory invisible to Dependabot

Enabling the switch above did not ship the fix, because a THIRD refusal was waiting under it, and
this is the one worth carrying. Dependabot tried within the minute and its update job failed on
`cargo`'s own parse:

```
error: failed to get `tauri-plugin-customtabs` as a dependency of package `canari v0.14.15`
Caused by: package specifies that it links to `tauri-plugin-customtabs`
           but does not have a custom build script
```

`build.rs` is committed and present in the working tree. **Dependabot materialises a temp checkout
of manifests and lockfiles only**, so a `links` key with no build script beside it is a manifest
cargo refuses to read - and the key arrived with the plugin on 2026-08-08 (`7cf394f3`). Every cargo
update in `frontend/src-tauri` has been impossible since, security ones included, and nothing said
so: the graph simply stopped producing pull requests. **The population is the proof, not the log** -
that directory has produced exactly ONE Dependabot pull request ever, #195 on 2026-07-24, while
`/frontend/mls-core`, in the same ecosystem entry of `dependabot.yml`, produced three on 2026-08-31.
The three ways out, and the detection that would have named it on day one rather than 25 days later,
are in [backlog](backlog.md).

### What it refuses, and why it is not a semver rule

**A ceiling on an automatic merge is a statement about your tests, never about the version number.**
The first ceiling written here refused every major and every `0.x` minor, and the measurement that
condemned it is that 33 pull requests were open and it refused 28 - a queue nobody drains is worse
than the merge it prevented (user, 2026-08-31: *"Je prefere blinder de test et faire les choses
automatiquement qu'avoir une review humaine qui n'arrive jamais"*).

`base64` 0.22 -> 0.23 and `axum` 0.7 -> 0.8 break by **not compiling**, which is exactly what the
suite sees. What a suite cannot see has no relation to semver: a dependency that **writes a format
something else must still read** changes behaviour while compiling perfectly. So the ceiling is a
list of dependencies whose failure mode is unobservable here, and **every entry names the test that
retires it**:

| Family | Why the suite is blind to it | The test that retires it |
|---|---|---|
| `openmls*`, `tls_codec*`, `hpke-rs*`, `libcrux*` | a WIRE format is read by other devices on other VERSIONS; `cross_version_state.rs` covers only today opening what v0.14.14 wrote | the FORWARD half - an old binary reading a frame minted by the new one |
| `aes-gcm` | it opens a channel push sealed by ANOTHER member's device, so both directions are cross-version, and `src-tauri` freezes neither | a channel-push fixture |
| `webrtc*`, `str0m`, `sdp`, `ice`, `turn`, `stun` | the SFU's ten tests never touch the ICE stack | one relay-path call (campaign rung 15 CALL) |
| `stripe` | the SDK's literal `apiVersion` type stops a silent API crossing at COMPILE time, but nothing here proves the app still reads what a new API SENDS | fixtures per API version, over the webhook events and object fields the service actually reads |
| `postgres`, `redis`, `garage` - **a major crossing only** | a datastore major is refused by the data ALREADY ON DISK, and every gate here creates its cluster from an EMPTY volume - the one case that always works | starting the new major against a data directory written by the old one, and proving the documented upgrade path carries it |

**Four families have already LEFT this table, which is what a refusal is for** - it names a missing
gate, and it goes the day the gate arrives. `@nestjs/*` left because `boot-nest-apps` constructs the
real `AppModule` on all four services, which alone moved the ceiling from 5 merge / 28 refuse to 26
merge / 6 refuse. `chacha20poly1305`, `argon2` and `ciborium` left because `cross_version_state.rs`
opens artefacts they sealed in v0.14.14, and for an AT-REST envelope - read only by the device that
wrote it - that backward direction is the whole question. Bare `typeorm` left because
`app-module.boot-spec.ts` now issues a real query through every entity the app registered. The live
list is in
[backlog](backlog.md#p1---the-three-refusals-the-auto-merge-ceiling-makes-and-the-test-that-retires-each).

A refusal is **never** routed to a human queue. It is posted as a comment on the pull request naming
the missing test, once, behind the marker `<!-- canari-auto-merge-ceiling -->`.

#### The table is DERIVED, because its failure mode is an absence (2026-09-01)

**The last two rows of that table cost a production outage, and the entry that would have prevented
it was not wrong - it was missing.** `postgres 15-alpine -> 18-alpine` merged at 10:33 on a fully
green suite, the dispatched deploy recreated the container, PostgreSQL 18 exited on startup against
the existing `postgres_data`, and eight services lost `auth_db` - the only database - for 33 minutes.
The CD run went red one step later, on `Run database migrations`, after thirty `pg_isready` attempts.
**The frontend kept answering 200 throughout**, which is why nothing looked wrong from outside.

Three things had to be true at once, and each is worth keeping:

- **A datastore major is the one failure mode this repository structurally cannot see.** `make
  run-ci`, `boot-nest-apps` and every compose stack initialise an EMPTY volume. Green means "18 can
  create a fresh cluster" and carries no information about the cluster production has.
- **Two comments asserted the ceiling "refuses any major".** It never has. `update-type` is parsed
  and used for nothing but a log line, deliberately - see the top of this section - and a comment
  claiming a rule is not the rule.
- **The obvious correction would not have worked either.** Replaying the real trailer parses to
  `postgres||18-alpine`: `update-type` is **empty**, because `15-alpine -> 18-alpine` is not a semver
  comparison Dependabot can make. A "refuse every major" rule would have called it unclassified and
  merged it exactly as the name table did. For a Docker tag the NAME is the only discriminator there
  is.

So the repair is not the missing row. The table moved to `.github/scripts/lib/ceiling.sh`, and
`.github/scripts/tests/ceiling.test.sh` **reads `docker-compose.prod.yml`** and demands an arm for
every third-party image that mounts a named volume - the same reasoning
`app-module.boot-spec.ts` uses to walk every registered entity rather than a named few. The next
stateful service is covered by whoever declares it. The test asserts the other direction too, so the
table cannot quietly widen into the blanket refusal this section exists to argue against, and the
sweep runs it **before** it may merge anything (`infrastructure/docker-compose.prod.yml` is in the
job's `sparse-checkout` for exactly that reason - the two move together).

**And the arm is no wider than the hazard, which took a second draft to get right.** Refusing the
whole NAME was the obvious reaction to the outage, and it is the opposite mistake: an on-disk format
is stable *within* a major, so `redis 8.8-alpine -> 8.10-alpine` cannot meet the failure mode, and
two open pull requests (#306, #308) would have been frozen by it - turning "silently moving" into
"silently ageing", which is precisely what these digest pins were given a Dependabot ecosystem to
prevent. So the discriminator is the major **production runs**, read out of the compose file rather
than assumed, and three properties follow:

- **It fails closed.** An absent or unparseable `dependency-version`, or an image the compose file
  does not name, is refused. A false refusal costs one comment; the false pass cost 33 minutes.
- **A stateless image is allowed even across a major.** `adminer` mounts no volume, so there is no
  old data for a new version to refuse - and that line is what keeps the arm about STATE rather than
  about being a container.
- **Replayed against the live queue** the day it was written: #309 (`postgres 18-alpine`) refused,
  #306 and #308 (`redis 8.10-alpine`) allowed, #307 (`adminer`, digest only) allowed.

One operational consequence, learned twice on the day: **a fix applied to the box is erased by the
next deploy.** `serve-prod.yml` runs `git reset --hard origin/main`, so pinning the image back over SSH
restores service in seconds and survives exactly until the next dispatch - which is what happened at
13:29, when a deploy from an origin still carrying 18 took production down a second time. The manual
repair buys time to write the real one; it is never the repair.

Postgres is pinned at 15 until the upgrade procedure exists; that is a deliberate deferral, with the
two reasons 18 refuses the directory, in
[backlog](backlog.md#p2---postgresql-is-held-at-15-because-18-needs-a-migration-nobody-has-performed-after-the-outage-of-2026-09-01).

#### A refusal is retired by a DECLARED gap in dev, and exactly one kind of evidence counts

The datastore arm names the test that would lift it, and the dev environment is where that test can
be run: dev is deliberately allowed to run a stateful image one major ahead of production, on a copy
of production's data. `infrastructure/dev/version-gap.yml` is where the result is declared, one row
per stateful image, and `lib/ceiling.sh` consults it - a row whose gap is declared **and proven**
releases exactly the major it was proven for, and nothing else.

**The reason it is a declaration and not a comparison** is that the obvious gate - assert dev and
prod pin the same major - would fire on the very difference the environment exists to carry, and
would be deleted the first time it did. So the difference is stated, and what is asserted is that the
statement matches both compose files. `tests/dev-gap.test.sh` derives the row set from the images
production mounts a named volume for, so a stateful service added later is covered by whoever
declares it rather than by whoever remembers this file.

**AND THE PART THAT MATTERS MOST WAS FOUND WHILE BUILDING IT: A GREEN DEV DEPLOY IS NOT THE EVIDENCE
THE CEILING ASKS FOR.** The plan for the dev environment said that PostgreSQL 18 starting in dev on a
copy of production's data and serving `/api/version` would be the test that retires the `postgres`
refusal. It would not have been, and believing it would have re-armed the 2026-09-01 outage behind a
gate that reads as proof. `infrastructure/dev/copy-prod-to-dev.sh` is a **logical** copy - `pg_dump`
replayed into a cluster the new major initialised itself, from empty - so it never touches a data
directory written by the old major, and cannot fail the way production failed. It would have gone
green on 18 while saying nothing about `pg_upgrade` or the 18+ move of the mount point from
`/var/lib/postgresql/data` to `/var/lib/postgresql`. The next `postgres` major would then have
auto-merged on that green.

So each row states WHICH question its gap answers, and only one of the four answers lifts anything:

| `evidence` | What it demonstrates | Lifts |
| --- | --- | --- |
| `none` | There is no gap; dev runs production's major. | nothing |
| `fresh_cluster` | The new major serves a cluster it created from empty. This is what every gate here already proves, and it is the one case that always works. | nothing |
| `logical_restore` | The new major serves this application's schema and data after a dump and restore. Worth having - it catches a schema or query the new major rejects - but the cluster is still one the new major built. **This is what the dev environment produces on its own.** | nothing |
| `in_place_upgrade` | The new major serves production's OWN data directory, carried across by the documented upgrade path, with the mount layout the new image expects. | the refusal named in `lifts` |

It fails closed on every other input, proved against fixtures: the wrong evidence value, an
`in_place_upgrade` with an empty `proof`, a missing gap file, a different major, and a sibling image
in the same arm are all still refused.

### What the sweep taught, kept because the lessons outlive it

Three findings from the year the sweep ran, none of which depend on it existing:

- **A convergent trigger names an EVENT; a workflow is only ever its current proxy, and nothing
  announces the day one stops being the other.** The sweep hung off "CD completed" because CD ran on
  every push to `main`. When deployment moved to the version bump, that same trigger silently became
  "once per release" - weeks apart - and nothing said so.
- **Scheduled delivery on a public repository is best-effort, and GitHub DROPS the slots an hourly
  cron misses rather than queueing them.** `code-analysis.yml` asks for `0 2 * * *` and ran at 03:01,
  03:09, 08:05, 08:24, 08:47, 12:37 and 14:10 UTC on seven consecutive days. A clock is a floor under
  the worst case, never the thing a verdict waits on.
- **Counting deliveries is the wrong question; read one log.** Two of the four repositories had a
  sweep that was delivered, ran, went GREEN and had never executed anything - the script landed
  without its executable bit, `Permission denied` on every pull request, `merged 0`, six consecutive
  green passes in Sky. The step swallowed a non-zero status by design so one unmergeable branch could
  not stop the sweep, and it swallowed "the script could not run" with it. No count would ever have
  found that.

**And one about check runs, which is why `push: main` matters.** A check-run's conclusion is evidence
about the workflow that PRODUCED it, not the ones `main` carries today. PR #272 was `CLEAN` with
every check green and no `Boot the real AppModule` run at all, because that job was written after its
CI last ran: **an absent check and an inapplicable one look identical**, so "nothing failed" is not a
merge condition. The sweep tried to answer this per pull request and got the predicate wrong twice -
too wide, then measured unsound when narrowed. It is answered on `main` now, after the fact and
before any release.

### One changelog, three destinations, and the one that had never received it

`store/whats-new.txt` is the one text a stable release owes a human (user, 2026-09-03: the changelog
can be the same on every platform, and in the GitHub console at the version bump). Until that day it
reached exactly ONE of the three:

| Destination | Before | Now |
| --- | --- | --- |
| App Store | `whatsNew` on every version localization, then the version is submitted for review | unchanged |
| Google Play | **nothing at all** | `whatsnew-fr-FR` and `whatsnew-en-US`, via `whatsNewDirectory` |
| GitHub release | whatever a human typed, or nothing | the same notes, in a marker-delimited block |

**PLAY'S SILENCE IS THE FINDING, AND IT IS THE ASYMMETRY THAT HID IT.** A *wrong* what's-new is
refused by the API; a *missing* one is not - the field simply keeps whatever it held. So every
release told iOS users what had changed and left Android users with the previous text, and no gate,
log line or review would ever have said so. It was found by asking what read `store/whats-new.txt`:
`submit.mjs`, and nothing else.

**ONE IMPLEMENTATION OF THE NOTES RULE, THREE CALLERS.** `submit.mjs --check-notes` is the fifth
preflight gate; `--print-notes` is what the Play arm and the notes job read the text through. The
alternative was `tail -n +2` in two workflows, which is three opinions about the version marker, the
trim and the length ceiling - drifting the day the format changes. `release-chain.test.sh` asserts
that nothing else reads the file in code, and the predicate drops COMMENT lines, because the first
draft accused three files that merely name it while explaining where the notes come from.

**THE GITHUB RELEASE JOB RUNS BESIDE THE THREE ARMS AND NOTHING DEPENDS ON IT**, which is not
tidiness: on `v0.16.0` a refused release update `skipped` TestFlight and the App Store submission
behind it, so production and Play shipped and Apple got nothing. A release body is a convenience;
the stores are the deliverable. A refusal here fails the run loudly and can skip none of them - and
it would be a second instance of that unexplained 403 on a different endpoint, which is evidence
the open P1 does not have yet.

Its composition is `.github/scripts/release-notes-body.sh`, a pure function of two files, kept out
of the YAML for the usual reason: its interesting inputs are ones a live release never produces - a
body carrying a STALE block, a body with the markers and nothing between them, a body of pure
whitespace. **Idempotence is the property that is silent when wrong**: a composer that appends
rather than replaces grows the body by one copy of the notes per re-run, and a release is re-run
exactly when something else already went wrong, so the damage reads as the other failure's
consequence. Eleven assertions, and the mutation that makes the block-strip a no-op fails three.

**TWO THINGS WERE MEASURED RATHER THAN ASSUMED, and both were about to become constants:**

- **The Play listing's locales are `fr-FR` and `en-US`** - read through the Publishing API on
  2026-09-03, in an edit that was deleted and never committed. A `whatsnew-<LOCALE>` file for a
  locale the listing lacks is refused, and a missing one is silent, so guessing here fails in the
  invisible direction.
- **Play's release notes are capped at 500 characters, and the FIRST measurement of this said the
  opposite.** The API reference states no limit, and `PATCH` on a track accepted 400, 500, 501, 1000
  and 5000 characters - so "no Play ceiling is encoded" was written here, with a caveat that the
  edit had never been COMMITTED and commit-time validation was therefore unexercised. **That caveat
  is what turned out to matter.** `POST edits:validate` runs a commit's validation and changes
  nothing:

  ```
  532 (the first 0.16.1 notes)  ->  403  "notes in language fr-FR with length 532,
                                          which is too long (max: 500)"
  499                           ->  200  valid
  501                           ->  403  same message
  ```

  `PATCH` only stores the draft. So the Console's 500 IS the API's, enforced at validate/commit
  time, and **the gate now carries the TIGHTEST of the three destinations** -
  `min(Apple 4000, Play 500)` in `submit.mjs`, with a message naming which one binds. Without it the
  fifth gate passes in seconds and the Android arm dies at the store step after a twenty-minute
  build, which is learning by failing what a fact could have told us. `0.16.1`'s notes were 532
  characters when this was found.

### Never write to somebody else's pull request, and the day that cost seven of them

Kept because the mechanism is gone and the lesson is not. The sweep rebuilt stale branches with
`PUT /repos/{owner}/{repo}/pulls/{n}/update-branch` - the obvious API - which pushes a merge commit
authored by `github-actions[bot]`. On 2026-08-31 that cost three things at once, across seven pull
requests:

1. **The re-triggered `pull_request` run is created as `action_required`**, parked until a human
   clicks Approve. A push authored by Dependabot is not. Twenty runs were sitting there.
2. **Dependabot then refuses the branch permanently**: *"Looks like this PR has been edited by
   someone other than Dependabot. That means Dependabot can't rebase it - sorry!"*
3. The branch was no longer *stale* either - `update-branch` had made its base current `main` - so it
   passed straight through to a merge decision reading checks that would never complete.

**The step written to drain the queue was the one filling it.** Nothing in this repository writes to
a pull request's branch any more.

### Two traps in reading Dependabot's own commit trailers

- **Dependabot YAML-quotes a dependency name starting with `@`**, so the commit trailer reads
  `"@nestjs/common"` with the quotes. A `case` on `@nestjs/*` matches nothing - which is how a first
  draft merged the exact major it was written to refuse. `dependency-ceiling.sh` strips the quotes.
- **A "update the requirement to permit the latest version" pull request carries no `update-type`
  trailer at all** (PR #297, openmls 0.9.0), so any logic keyed on the update type reads an empty
  string. Treat unknown as major.

The `updated-dependencies` trailers are parsed **as blocks**, never as three independent `sed`
lists: a grouped pull request carries several, and an update Dependabot could not classify has no
`update-type`, so three lists pasted side by side would pair the wrong name with the wrong version.

### Verifying a change to the CI scripts

The decisions live in `.github/scripts/lib/` precisely so they can be exercised on inputs GitHub
will not produce on demand, and `make test-ci-scripts` runs every suite in seconds. Change a
decision, change its assertion, and prove the assertion by breaking the thing it guards - a test
that passes on a mutation is a test that asserts nothing.

**And lint before pushing, because this workstation has no `shellcheck` and CI does.** A change to
these scripts went red on 2026-09-01 for two findings a local run would have named in one second
(`SC1091` - `# shellcheck source-path=SCRIPTDIR` is **per-command, not per-file**, so a second
`source` needs its own copy - and `SC2016` on a `'${'` case pattern that meant the brace literally).
Fetch the pinned version into a scratch directory and use the invocation `ci.yml` uses:

```sh
curl -sSL -o sc.zip https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.zip
# unzip, then, from the repo root:
./shellcheck.exe -x .github/scripts/*.sh .github/scripts/lib/*.sh .github/scripts/tests/*.sh
```

### The npm advisory endpoint's silence is not a verdict, and telling them apart is one script

`bun audit` exits **1** for `POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503`
exactly as it exits 1 for a real advisory. On 2026-09-03 that turned a five-minute npm outage into a
red `Check Dependencies Vulnerabilities`, a red `CI passed`, and a repository in which nothing could
merge - over a tree in which nothing was wrong. It bit on that day and not before because the
security pass had just become part of `CI passed`; the same 503 a week earlier produced a red tick
nobody was waiting on.

`.github/scripts/audit-dependencies.sh` is the only place that runs `bun audit`, and it answers with
three exit codes rather than two:

| Exit | What it means | Who decides what it costs |
| --- | --- | --- |
| `0` | the registry answered and the tree is clean | - |
| `1` | the registry answered and named an advisory | always a failure |
| `2` | the registry never answered, after three attempts | **the caller** |

**A `2` is not a verdict about the tree**, so what it costs is passed in as
`registry_outage_is_failure`, an input on `code-analysis.yml`:

- **a pull request tolerates it.** A refusal whose only remedy is unavailable is a stop, not a gate,
  and nobody in this repository can restore npm.
- **the nightly `scheduled.yml` pass FAILS on it.** Nothing is queued behind that run, so the
  failure costs no merge and IS the report: this tree has now gone a day unaudited. Without that
  half, a tolerated outage quietly becomes a tree nobody has audited in a week, with only warnings
  in closed logs to show for it.

### And the audit is not the whole question, because GitHub knows things it does not

`bun audit` and `cargo audit` each read ONE advisory database and each need a manifest they can
parse. GitHub reads its own, needs neither, and raises alerts against the default branch that
nothing here used to look at. On 2026-09-04 that gap was measured rather than supposed:
GHSA-7gcf-g7xr-8hxj (serde_with, in `frontend/src-tauri/Cargo.lock`) was invisible to all three of
the mechanisms meant to catch it - Dependabot could not open the pull request, `cargo audit` exited
0 because the advisory is GHSA-only, and no gate read the alert list.

`.github/scripts/dependabot-alerts-report.sh` is that third reader, in the nightly pass on the same
02:00 cron. **It is not on the pull-request path and must not go there**: the alert list is a
property of the DEFAULT BRANCH, so a pull request can neither be blamed for an open alert nor
sensibly blocked by one, and putting it there would wall every merge on a fact about `main`.

**It answers the four causes of an empty list separately**, which is the whole of its design: a 200
with no alerts is health; a 403 means the token may not read alerts and NOTHING looked; a 404 means
the feature is disabled or the slug is wrong; no response is a transport failure. The last three
fail by name. The same rule as the `2` above, in a different place: *a refusal is not a clean
report.*

**The unknown case fails CLOSED, and that stopped being hypothetical within the hour.** Only a
narrow list of recognised transport failures is classified as silence; anything else is a finding.
**The wording differs by bun version** - the same npm 503, the same evening, in two repositories:

| bun | the line |
| --- | --- |
| 1.4.0 | `error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503` |
| 1.3.8 | `error: audit request failed (status 503)` |

The portal met the second with a classifier that knew only the first, and it did exactly what it
should: reported a finding, went red, and was fixed. Both shapes are now asserted, so a repository's
bun version stops being able to decide the verdict. *A classifier that fails open on its own blind
spot stops auditing and reports success for ever.* `audit-dependencies.test.sh` asserts that direction explicitly, alongside
both sides of the distinction, the policy flip, and the fact that the `--ignore=` flags the one
suppressed advisory rests on still reach the tool.

**AND THE RATE IS MEASURED, because the rule says a fallback's name is not believed until it is -
AND THE FIRST MEASUREMENT WAS WRONG, in the way this repository's rules name explicitly.** It
counted `grep -c` over a log fetched per run and reported *six 503s in fifty requests, no exhausted
budget*. Two of those runs had returned **no log at all**, and a count over an empty string is
zero: an absence of data read as a verdict. The re-measurement checks every log's size and its step
marker first, and reports `UNREADABLE` rather than clean - the guard is the finding, not the
numbers.

Twelve readable `ci.yml` runs on 2026-09-04, five trees each, sixty tree-audits:

| run | 503s | exhausted | which tree |
| --- | --- | --- | --- |
| 33857687014 | 2 | 0 | `chat-delivery-service`, `media-service` |
| 33854391020 | 6 | 0 | `core-service`, `media-service`, `frontend` |
| 33851910609 | 3 | 0 | `media-service`, `social-service`, `frontend` |
| 33850722894 | 4 | **2** | `chat-delivery-service`, `media-service` |
| 33849668875 | 4 | **2** | `core-service`, `social-service` |
| 33847721971 | 5 | **1** | `media-service`, `social-service` |
| 33836519287 | 0 | 0 | - |
| 33835252690 | 1 | 0 | `core-service` |
| 33833975381 | 1 | 0 | `core-service` |
| 33832780239 | 0 | 0 | - |
| 33831909478 | 0 | 0 | - |
| 33831223145 | 0 | 0 | - |

**Twenty-six 503s in sixty requests - 43% - and FIVE exhausted attempt budgets, which is five trees
that went unaudited and were tolerated.** Two further runs were unreadable and are excluded rather
than scored.

**THE RATE IS NOT STATIONARY, and that is the part a single number hides.** Read the table
bottom-up: the older six runs score 0, 0, 0, 0, 1, 1 and the newer six score 2, 6, 3, 4, 4, 5. The
endpoint degraded across one day. *A predicate that named the last incident is not the predicate
that names the next one* applies to rates as much as to queries: any threshold set on the bottom
half of this table is already false at the top.

**WHAT THE DISTRIBUTION RULES OUT.** Not this pipeline's own request rate - the 503 lands on the
first, third and fourth tree indifferently, and a retry twenty seconds later often succeeds; a rate
limit would spare the first and punish the last. Not the size of the POST body - `frontend`, by a
wide margin the largest tree, is not over-represented. It is npm's advisory endpoint, and 43% is not
flakiness to tolerate: it is a dependency that fails two times in five.

**WHAT IT COST, IN BOTH CURRENCIES.** Each 503 is a full five-minute timeout, so twenty-six of them
is over two hours of runner time in one day - and `bun audit` takes about five minutes per tree even
when it SUCCEEDS, which is why one sequential job ran 14 to 39 minutes against two minutes for
CodeQL. **That is what made this the critical path of every pull request, and the audit is now a
five-way matrix that is no longer part of `CI passed`** - see the block above `dependency-audit` in
`ci.yml`, which carries the reasoning and names what is lost.

**THE BACKOFF IS WHAT MAKES AN EXHAUSTED BUDGET MEAN SOMETHING.** `BACKOFF_BASE_S=20` sleeps 20s
then 40s, so three attempts span a minute plus `bun audit`'s own timeout. Three consecutive 503s are
therefore not three independent draws; they are one npm blip lasting minutes. That is what the
`0.16.2-alpha.1` bump commit met - three attempts, three 503s, exit 2, correct. The pass went red
anyway, because the CALLER could not read the answer, and that defect is above. *The classifier's
rate says the design is right; only its reader was wrong.*

## Notable CI gotchas

- **A Tauri plugin's JS package and its Rust crate must agree on major.minor, and only a RELEASE used to discover when they did not.** The CLI refuses to build (`tauri-plugin-log (v2.8.0) : @tauri-apps/plugin-log (v2.9.0)`), but nothing else in this pipeline compiles the Tauri app, so an ordinary `bun install` that re-resolves the JS half lands green and kills the next tag - it took out Android Release and AppImage Release on v0.14.6, while iOS Release passed because its path never runs the check. `frontend/scripts/check-tauri-plugin-versions.mjs` (step `Guard the Tauri JS/Rust version parity` in `code-analysis.yml`) now compares the two committed files on every run. Fix the Rust side with `cd frontend/src-tauri && cargo update -p <crate>`.
- iOS `altool` can exit 0 while output says `UPLOAD FAILED` — the workflow greps for failure markers in the transcript.
- Android Play API rejects `changesNotSentForReview` post-launch — never include this flag.
- `workflow_run` triggered off a release-triggered workflow must NOT have a `branches` filter (GitHub silently drops them).
- Pre-commit hooks sweep the whole frontend and re-stage — isolate unrelated dirty files before committing (`git stash` them).
- Never assert a wall clock in a test. An unseeded generator with rejection sampling once drew 31s against a 15s budget on a runner and took CD down: seed the input, and let the `it` timeout guard non-termination.
- **`gh run rerun` replays the workflow FILE as it existed at that run's ORIGINAL trigger, never the current one on `main`.** Fixing a workflow bug and re-running the failed run will silently re-run the old, broken definition - confirmed on the v0.14.5 iOS recovery, where the rerun's step list was missing a step added by the fix. Only a fresh trigger (`workflow_dispatch`, or a new event) resolves the current file.
- **`softprops/action-gh-release` is no longer used in this repository, and this is why.** It can 403 with `Resource not accessible by integration` pointing at `update-a-release`, on its OWN second, `github.ref`-shaped lookup - after it has already found the release by `tag_name`. First seen for `refs/heads/main` under `workflow_dispatch` (where `github.ref` is the branch, not the tag). **The tag variant then cost Apple a whole release**: on the stable `v0.16.0` the iOS arm was refused with `Contents: write` granted and printed by the runner, on `refs/tags/v0.16.0` under a `release` event, and the re-run reproduced it - while the Android arm's identical step succeeded on the same release 24 minutes earlier, and on every stable since. The cause of that refusal is unexplained and now unanswerable, which does not matter: **attaching a file to a release needs no release UPDATE**, so both arms use `gh release upload "$TAG" ... --clobber`, one call, creating nothing when the release is absent. `release-chain.test.sh` refuses an `uses:` in either step.

## See also

- [`development.md`](development.md) — Local dev workflow, Makefile targets
- [`infrastructure/docker.md`](infrastructure/docker.md) — Docker Compose setup
- [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) — Server bootstrap and migration guide
