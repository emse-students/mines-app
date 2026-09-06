# **Canari - Rules & Session State**

> **The hard-won rules are in [docs/wiki/durable-rules.md](docs/wiki/durable-rules.md)** - constraints
> each written after something broke, indexed by area and linked to the page carrying the reasoning.
> **Open the section matching what you are about to touch, before you write anything.** This file
> keeps only what applies to EVERY task, plus the live session state.
>
> **THIS REPOSITORY IS THE ONLY REFERENCE, AND THIS FILE IS ITS INDEX.** Anyone holding the repo and
> the secrets must be able to pick the work up with nothing else.
>
> **An agent's local memory is SECONDARY AND DELETABLE.** It may hold machine-local wiring (an MCP
> server's absolute path, a shell shim) and secrets that must never enter a public repo - nothing
> else. If it ever holds a project fact, that is a bug in this file: move the fact here and delete
> the memory. Never let a decision, a measurement or an open item exist only in a chat history, a
> scratch directory or a memory file.

## **WHERE THINGS LIVE**

| Question | File |
| --- | --- |
| What is open, and what rule holds everywhere | this file |
| The constraint for the area I am about to touch | [docs/wiki/durable-rules.md](docs/wiki/durable-rules.md) |
| How something works, in depth | `docs/wiki/` - **search it before reading source** ([index](docs/wiki/index.md)) |
| The substance behind a queue item | [docs/wiki/backlog.md](docs/wiki/backlog.md) |
| A question the code cannot answer, parked deliberately | [docs/wiki/open-questions.md](docs/wiki/open-questions.md) |
| The story of a defect that shipped | `CHANGELOG.md` |
| Campaign board: every check, its verdict, its build | [docs/wiki/cross-client-testing.md](docs/wiki/cross-client-testing.md) |
| Campaign design: the ladder, the scope, the preflight | [docs/wiki/cross-client-campaign.md](docs/wiki/cross-client-campaign.md) |
| Picking the campaign back up: the delta since the pause, and the restart order | [cross-client-campaign-resume.md](docs/wiki/cross-client-campaign-resume.md) |
| What a prompt handing ONE row to another session must carry | [cross-client-campaign.md](docs/wiki/cross-client-campaign.md#a-row-handed-to-another-session---the-delegation-contract) |
| Why a result may be believed | [docs/wiki/testing-methodology.md](docs/wiki/testing-methodology.md) |
| What the app has that NOTHING watches | [docs/wiki/mechanism-audit.md](docs/wiki/mechanism-audit.md) |
| How to operate the test rig | [tools/cross-client-harness/README.md](tools/cross-client-harness/README.md) |
| What Google Play sees that no gate here does | [tools/play-vitals/README.md](tools/play-vitals/README.md) |
| What is owed on real hardware | [docs/wiki/device-verification.md](docs/wiki/device-verification.md) |
| Secrets, services, bootstrap steps | `infrastructure/MIGRATION.md` |
| The second estate: isolation, the prod copy, the declared version gap | [dev-environment.md](docs/wiki/infrastructure/dev-environment.md) |
| Whether the BOXES take their security updates, and what reports it | [host-updates.md](docs/wiki/infrastructure/host-updates.md) |
| What the USER must do by hand, and the long-term dev/release workflow (French) | [workflow-developpement.md](docs/user-guide/workflow-developpement.md) |
| A shim kept alive for old clients, and its removal date | [docs/wiki/legacy-compatibility.md](docs/wiki/legacy-compatibility.md) |
| What a report is, and what a block does and does not close | [docs/wiki/moderation-and-blocking.md](docs/wiki/moderation-and-blocking.md) |
| Whether the four repos STILL have ONE CI shape, asserted rather than described | [ecosystem-shape](tools/ecosystem-shape/README.md) |
| The cross-repo convergence plan, repo by repo | [ecosystem-convergence.md](docs/wiki/ecosystem-convergence.md#11-the-cross-repo-convergence-plan-repo-by-repo) |
| The 2026-09-02 workflow migration: its decisions, its order, its state | [workflow-migration.md](docs/wiki/workflow-migration.md) |

## **AGENT DIRECTIVES**

- NO BLIND GREP: never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: state assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: touch ONLY requested code. Map changes 1:1 to the prompt.
- **FOUR WORKFLOWS ARE VISIBLE IN THE ACTIONS LIST, AND THAT IS DELIBERATE** (user, 2026-09-04:
  *"le moins de workflows differents possibles, ca inonde la console github"*). `ci.yml`
  (tests + the `CI passed` aggregate + the security pass + the dependency ceiling), `release.yml`
  (the one deployment entry point), `arm-auto-merge.yml` (one job, `pull_request_target`, arms every
  pull request including Dependabot's), `scheduled.yml` (everything on a clock, one job per cron).
  Four more are `workflow_call` LIBRARIES with no triggers of their own and no row of their own:
  `deploy.yml`, `android.yml`, `ios.yml`, `code-analysis.yml`. **Adding a fifth visible workflow
  needs a reason that is not "it is a different topic".**
- **WORK GOES THROUGH A PULL REQUEST, AND IT MERGES ITSELF; NOTHING DEPLOYS ON A PUSH.** Both are the same fact and the commands are in THE DEVELOPMENT CYCLE below. Two consequences no task escapes: **a merged fix is not a shipped fix**, and a hyphen in the version IS the definition of a pre-release - read that way by `release_kind()` in `.github/scripts/lib/release-preconditions.sh`, the ONE implementation, and by `scripts/bump-app-version.sh`'s store band. Model on [workflow-migration](docs/wiki/workflow-migration.md) and [cicd](docs/wiki/cicd.md), the only copies. **Admin bypass exists and is the EMERGENCY path only**: taking it means production is broken right now, and it is written into `CHANGELOG.md` when taken.
- NO FALLBACKS: never add a fallback path. Diagnose why the primary path failed and fix it there.
- FIX, NEVER DEFER: a warning or failure you meet is yours, whether or not you caused it. "Pre-existing" is not a disposition.
- FACE THE BLOCKAGE: fix the cause of a failing hook (`bun run format`), never stash or bypass it.
- STATE PRUNING: when updating SESSION STATE, DELETE completed work outright. Its rule goes to `durable-rules`, its story to `CHANGELOG.md`, its mechanism to the wiki page that entry points at. **Do not reconstruct shipped work here.**
- CLAUDE.md HYGIENE: **INDEX FIRST** - a rule needing a paragraph belongs in `durable-rules`, a story in `CHANGELOG.md`, a measurement on the topical wiki page. If this file grows, something belongs somewhere else. **The cap is ~350 lines and it moved from ~250 on 2026-09-04**, deliberately and once: the user asked for the development cycle to live here so it can be USED (*"tu consigneras le cycle de developpement dans le claude.md de Canari pour pouvoir l'utiliser en pratique"*), and that section is COMMANDS, which is the one thing a pointer cannot replace. It was paid for, not granted: two sections that restated the five gates and the deploy model were cut to pointers in the same commit. A cap the file itself breaks is worse than no cap.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> commit -> pull request -> merge -> update SESSION STATE -> STOP. **The commands are in THE DEVELOPMENT CYCLE below.**
- COMMIT **AND PUSH** IN THE BACKGROUND, ALWAYS - both are minutes long and neither is worth a blocked session. The pre-commit hook sweeps the WHOLE frontend (2-3 min) and re-stages it; a push to this remote routinely exceeds a 5-min foreground timeout. Isolate unrelated dirty files first. `rm -rf apps/*/dist` before `git push`.
- DOCUMENTATION: technical docs in `docs/wiki/` (English, LLM-oriented, **search it before reading source**). User guides in `docs/user-guide/` (French). UML in `docs/diagrams/`. Root: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- WIKI IS PREFERRED: update the relevant wiki page alongside code changes - stale wiki is worse than none. Keep `apps/*/README.md` synced with its wiki counterpart. Cross-link freely.
- CHANGELOG: features, fixes and breaking changes get an entry under `[Unreleased]` (Keep a Changelog format).
- ONE-OFF ACTIONS GO TO THE USER (2026-08-25): *"Pour les choses qui ne se font qu'une fois, tu peux me demander de les faire hein."* Building a tool for a single click is that waste.
- DELEGATION: broad file-gathering goes to a search subagent; a big, risky or native Work Package goes to a background agent through a precise brief in `AGENTS.md`.
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` and `ssh miconnect` (the last two via ProxyJump canari). **Either tool works since 2026-09-02, and the old "PowerShell only" rule named the wrong culprit.** It was never Bash: MSYS `ssh` execs the cloudflared `ProxyCommand` through `/bin/bash`, which ate its backslashes. `~/.ssh/config` now spells that path with FORWARD SLASHES, which `bash` and `cmd` both exec - measured on both. A bash script may therefore reach prod directly, which matters because **PowerShell text-encodes stdout and corrupts a binary pipe** (a `pg_dump | gzip` through it is lost). Postgres, the fact that `auth_db` is the ONLY database and the SQL quoting are in [databases](docs/wiki/infrastructure/databases.md#reaching-it-from-a-workstation); `miconnect` is the Authentik box, and its access log is what settles an OIDC question ([authentik](docs/wiki/infrastructure/authentik.md#the-box-and-the-log-that-settles-an-oidc-question)).

## **THE DEVELOPMENT CYCLE - THE COMMANDS, IN ORDER**

Two human gestures and nothing else: **open a pull request**, and **publish a release**. Everything
between them is mechanical. The same shape is in all four GitHub repositories since 2026-09-04 -
`ci` + `release` + `arm-auto-merge` + `scheduled` visible, `code-analysis` + `deploy` as libraries -
so this cycle reads the same in Sky, MiGallery and Portail-etu, minus the bump and the two stores.

```
                    ONE                                        TWO
            open a pull request                        publish a release
                     |                                          |
   git switch -c fix/what-it-does                gh release create v0.16.2 \
   ...commit...                                       --generate-notes
   gh pr create                                             |
        |                                          release.yml, ONE run
        +--> CI ------------------+                         |
        |     tests + security    |                  5 gates (no bypass)
        |     -> `CI passed`      |                         |
        +--> arm-auto-merge ------+                    bump + push
              (IN PARALLEL)       |                         |
                                  v                +--------+--------+------+
                        GitHub squash-merges       |        |        |      |
                        + deletes the branch    deploy   android    ios   notes
                                  |             (build)   (Play)  (Store)
                                  v                +--------+--------+
                       push on main = CI ONLY               |
                       NOTHING DEPLOYS                production estate
                                                  (stable only, and only once
                                                   BOTH stores took the version)
```

**GESTURE ONE, and the whole of it.** `git switch -c`, commit, `gh pr create` - then **nothing**.
No approval is required, the merge and the branch deletion are automatic, and `main` carries ruleset
`22152902`: no direct push, no force-push, one required check, `CI passed`. **A merged fix is not a
shipped fix.**

**GESTURE TWO, and what it owes.** A STABLE `vX.Y.Z` deploys production and ships both stores; a
PRE-RELEASE `vX.Y.Z-alpha.N` deploys `dev.canari-emse.fr` and the store TESTER programmes. The
hyphen IS the definition. **A stable owes exactly one thing written by a human**:
`store/whats-new.txt`, first line `version: X.Y.Z` - one text reaching the App Store, Play and the
GitHub release body through ONE implementation. Check it before tagging:

```sh
MARKETING_VERSION=0.16.2 bun tools/app-store/submit.mjs --check-notes
```

**A STABLE IS REFUSED unless a pre-release served dev at that commit first**, so the ordinary
sequence is two releases:

```sh
gh release create v0.16.2-alpha.1 --prerelease --generate-notes   # -> dev + testers, moves the marker
# wait for it to be green, and do not merge anything in between - gate 2 checks main still points here
gh release create v0.16.2 --generate-notes                        # -> production + both stores
```

**The five gates, and there is no bypass input** (`.github/scripts/release-preflight.sh`): the
version parses; the commit is on `main` AND `main` still points at it; `CI passed` is green ON that
commit; dev has already served it (stables); the notes name it (stables). *A skip flag is a fallback
path, and reaching one means the primary path failed - so the fix belongs there.* The emergency path
is a human with admin rights, written into `CHANGELOG.md` when taken.

**Before every commit**: `bun run check` (0 errors), `bun run lint`, `bun run format` - the hook runs
them anyway and re-stages, so run them first rather than reading a commit you have not seen. Commit
AND push in the background: the hook sweeps the whole frontend (2-3 min) and a push here routinely
exceeds a 5-minute foreground timeout.

**Afterwards**: delete the local branch (`git branch -D`, squash merges are invisible to
`--merged`), update SESSION STATE, and STOP.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (front) | Rust WASM openmls | NestJS + Rust Axum (back).
- Nginx: single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS (RFC 9420): all encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: `frontend/src/lib/wasm/` and `src/lib/proto/canari.{js,d.ts}` are GENERATED and NOT in git.
  `cd frontend && bun run generate` after a structural change; every pipeline builds them itself
  ([mls-wasm](docs/wiki/frontend/mls-wasm.md#why-it-is-not-committed)).
- Auth: access tokens in memory ONLY (never localStorage). Refresh token in an HttpOnly cookie **everywhere the engine keeps one** - on `tauri://localhost` (iOS, macOS, Linux) WKWebView drops it and the client carries it in `X-Canari-Refresh` instead, one fact deciding both sides ([sessions](docs/wiki/sessions.md#the-credential-a-client-carries-itself)). WS auth via `canari_ws_token`.
- Media: the client generates the CEK (AES-256-GCM) before upload. The backend sees opaque blobs.
- Infra truth: keep `infrastructure/MIGRATION.md` synced with new secrets, services or bootstrap steps; add a new service to `docs/wiki/infrastructure/` and the `README.md` diagram.

## **CODING STANDARDS**

- Logs: mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions and error branches.
- Docs: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, never restate types.
- Factorization: extract and export reusable logic. Zero duplication.
- Language: code, comments, docs and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline literals, ALWAYS, even in a plain `.ts` util, and even when a nearby call site already has raw strings.
- Punctuation: ASCII (`'`, `"`, `-`) everywhere; escape quotes in code. Keep French accents ONLY in localized strings and French comments.
- Tests: changing logic requires changing the associated test.
- UI: single source of truth is `src/app.css` (tokens, `--radius-*`). `.btn-glass` with modifiers. Dark-first glassmorphism. No raw hex/px. `@lucide/svelte` only (NOT `lucide-svelte`, the old package name - both resolve).

## **KEY COMMANDS**

- **BUN RUNS THE SCRIPTS TOO, NEVER `node`** (user, 2026-09-04: *"Jamais node, toujours bun"*). Every `.mjs` in `tools/` is invoked `bun x.mjs`, the Makefile's harness gate included; a script that spawns another uses `process.execPath` so it inherits the runtime rather than naming one. `archive/gate-selftest.mjs` parses the `test-harness` recipe and would match nothing if the two ever disagreed - it accepts both spellings and FAILS on an empty gate, which is how a silent mismatch surfaces.
- Package manager: bun everywhere - frontend and the four NestJS apps each commit a `bun.lock`, CI installs `--frozen-lockfile`, the Makefile calls bun. **`.bun-version` is the ONE place this repo names a bun version.** No `packageManager` field, no `engines.bun`, no npm.
- Setup/dev: `make install`, `make run-services`, `cd frontend && bun run dev`.
- Tests: `make test`, `make test-frontend`, `cargo test`.
- Frontend gates before every commit: `bun run check` (0 errors), `bun run lint`, `bun run format`. Rust >= 1.97. `cargo clippy` for Rust crates. `make run-ci` for the full local pipeline.
- **NOTHING IN THIS REPO IS FORMATTED BY PRETTIER.** Everything is `oxfmt` (`oxfmt.json`) + `oxlint`. A bare `npx prettier --write` finds NO config, silently applies its own defaults (double quotes, 80 cols) and rewrites whole files - it did, and shipped. Use the package's own `format` / `lint` script, always. `bun run lint` shells out to `sh` (the oxvelte shim), so run it through the Bash tool.

## **THE RULES THAT APPLY TO EVERY TASK**

Everything area-specific is in [durable-rules](docs/wiki/durable-rules.md). These are the ones no task
escapes.

- **A status code is an ANSWER, a transport failure is not.** Only a 401/403 may log a user out, and `navigator.onLine` never proves reachability (a captive portal reports `true`).
- **Never branch on an error MESSAGE.** A distinction carried in prose is a distinction exactly ONE call site will make - classify at the THROW, as a type. When auditing such a seam, enumerate its consumers, never just the ones that mention it.
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** Ask of every timer what it would mean if it were wrong; if the answer is "more traffic", it is load-bearing and should not be. But durable state answers only THE QUESTION IT WAS WRITTEN FOR: "is this broken" and "have I already asked" differ only in lifetime, and using one for the other silences the trigger.
- **A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER.** A liveness clock must be written by the thing whose liveness it measures.
- **A PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE.** Re-measure it against the population it will actually run on - one `GROUP BY` settles it in seconds.
- **A CORRECT MECHANISM WITH NO REPORT IS FOUND BY HAND, A DAY LATE**, and the report must carry the evidence separating the causes it cannot itself distinguish.
- **A CLAIM THAT SOMETHING IS STALE MUST NAME THE MECHANISM THAT WOULD HONOUR IT AND SHOW THAT MECHANISM GONE.**
- **Every swallowed branch logs** - in a best-effort path that is all a loss leaves. A batch of jobs catches and logs PER JOB; isolation is a `try` per subscriber or it does not exist.
- **A DESTRUCTIVE CONTROL NEEDS AN ALLOWLIST OF WHAT IT MAY TOUCH, NOT A DENYLIST** - and a destructive repair must be gated on knowing the state is really broken.
- **WHEN SOMETHING KEEPS REFILLING, DELETING IT IS NOT THE FIX** - revoke whatever keeps naming it as a destination. And before deleting a container to reclaim what one member costs, enumerate the other members.
- **Default to Paraglide for ANY new user-visible string, on the first draft.** Nothing types a string as user-visible, so no compiler enforces it.
- **Never assert a wall clock in a test.** Two isolated browser contexts = two devices.
- **A green gate is not a working system.** Everything native is verified by COMPILING, which proves nothing about running; a green deploy proves the containers started, never that the site answers.
- **A FALLBACK IS A SIGNAL, NEVER A PATH.** Reaching one means the primary path failed and the fix belongs THERE. So it is logged at a level that ACCUSES, and its rate is measured against the population before its name is believed.
- **A RACE THAT HEALS CLEANLY IS STILL A DEFECT.** If the mechanism needs a heal in THEORY it is wrong, whatever it does in practice. Name what makes the two paths overlap and delete the overlap - a ledger that reconciles them afterwards is a witness, never a fix.
- **NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU.** Handing an operation to a layer certain to refuse it, in order to classify the refusal, is work the design owes: carry the discriminator to where the decision is made, from where it is already KNOWN.
- **NOISE IS NEVER ACCEPTABLE - web, mobile or server.** A line is either expected AND necessary, or it is the visible end of something upstream. Explain it or fix it, and never demote it - the cost is real, and a line its reader learns to skip is the one that hides the next defect.

---

## **SESSION STATE (Active Memory)**

**Five repos**, all on `main`. **Canari** (this monorepo, `emse-students/canari`, **PUBLIC**) is the
only active one; **Sky** (`../Sky`), **MiGallery** (`../MiGallery`), **Portail-etu**
(`../refonte-portail-etu`, **PUBLIC**) and **Le Cercle** (`../le-cercle`) are COMPLETE. How each is
REACHED and what its box refuses - Portail-etu having no SSH at all - is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md#how-each-repository-is-reached-and-what-its-box-refuses).

Work is tracked as Work Packages by severity: **P1** (security, or a broken user-facing path), **P2**
(correctness), **P3** (hygiene). Nothing is parked since 2026-08-18: anything new goes into the queue
below, its substance into [backlog](docs/wiki/backlog.md), and BOTH copies are deleted the day it
ships. **What only the USER can do is ONE table** -
[backlog](docs/wiki/backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks), pointers
only; never re-enumerate it here.

### CANARI - THE DELIVERY PIPELINE

**Commands: THE DEVELOPMENT CYCLE above. Model: [cicd](docs/wiki/cicd.md) +
[workflow-migration](docs/wiki/workflow-migration.md), the ONLY copies - read before touching any
workflow.**

### CANARI - THE QUEUE, IN ORDER

**0. THE HARNESS TIDY IS IN FLIGHT AND ITS WORK LIST IS [harness-tidy](docs/wiki/harness-tidy.md)** -
delete the file and this line together when it is empty. The bar it carries: **every row must be
`PASS`, never `PASS-DIRTY`**, a P1 found on the way is fixed in the same session, and P2/P3 go to
[backlog](docs/wiki/backlog.md) rather than inline.

**A HEADLINE AND A LINK EACH, AND THAT IS ALL THIS SECTION IS FOR.** It was 152 lines for 11 items
on 2026-09-03 - restating the substance the linked pages carry, in violation of both this file's
line cap and its own "not restated" rule, and TWO of the items had gone FALSE without anyone
noticing. Order = priority. Detail lives where the link says. Defect stories are in `CHANGELOG.md`,
rules in [durable-rules](docs/wiki/durable-rules.md), verdicts on
[cross-client-testing](docs/wiki/cross-client-testing.md).

1. **THE BOARD IS [cross-client-testing](docs/wiki/cross-client-testing.md) AND `bun rows.mjs`
   SETTLES IT** - what is answered, what is not `PASS`, and a COMPARISON row adjudicated on ALL its
   halves. **No count is written here**: the two that were went stale within a day. PIN's four
   remaining rows CHANGE a PIN or restart a browser, which is why they are last. **The HEAL-NEW rung
   now refuses rather than passes**: a fresh device reaches every group with NOTHING online, so the
   rows that watch a responder heal one have no window left and need a group the device cannot
   self-serve ([backlog](docs/wiki/backlog.md)).
2. **P1 - a PLACEHOLDER held a member's seat**; whether a LEAF is left in the MLS tree only a
   member's CLIENT can say. [backlog](docs/wiki/backlog.md#p1---the-placeholder-is-gone-from-prod-what-it-may-have-left-in-the-mls-tree-is-not-answered).
3. **FIXED, NOT SHIPPED - SIX defects that each cost a rejoining device its history, and one of
   them was the instrument's.** **The whole HEAL-REVOKE rung was re-run on 2026-09-06 and every row
   reads `unmet: []`** - -4 and -3 `PASS` clean, -5/-8/-2/-9 `PASS-DIRTY` on ONE line each, the same
   line, filed and deliberately not forgiven ([backlog](docs/wiki/backlog.md)). The `arrived twice`
   line is gone from all of them, which is the field evidence for the ack barrier. The two fixes
   that closed -4: an ORDERING (a device REACHABLE for a group five seconds before it could ROUTE
   for it) and a log line that named no group, which made one clause unsatisfiable on every run that
   row has ever had ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md),
   `CHANGELOG.md`).
4. **FIXED, NOT SHIPPED - the PIN gate could be dismissed and offered no way out** (user,
   2026-09-05, seen on real people). Merged as #383 with the back-gesture hole `dismissible` was
   missing, and asserted by PIN-11 plus two component test files. **It goes from this list the day a
   release carries it** ([backlog](docs/wiki/backlog.md)).
5. **THE DEPENDENCY CHAIN** (user: *"un projet qui peut 'vivre tout seul'"*) - **ONE merge mechanism
   and ONE arming point since 2026-09-04**, the same four workflows in all four GitHub repos, and
   `bun tools/ecosystem-shape/shape.mjs` is the only thing that asserts it
   ([rebuild](docs/wiki/ecosystem-convergence.md#12-the-cicd-rebuild-2026-09-04---the-same-four-workflows-in-every-repository),
   [cicd](docs/wiki/cicd.md#dependency-updates-and-the-auto-merge-that-ships-them), the only
   copies). Open: **[the suppression CONTROL CASE the NestJS batch destroyed](docs/wiki/backlog.md#p2---the-nine-nestjs-pull-requests-were-closed-in-one-batch-so-the-suppression-question-was-never-measured-on-one-first-and-monday-2026-09-07-is-the-only-thing-that-can-answer-it-now-updated-2026-09-03)**
   (Monday 2026-09-07 answers it), **nothing tells anybody prod is down**, and
   [host-updates](docs/wiki/infrastructure/host-updates.md).
6. **NO CAMPAIGN ROW ASKS A QUESTION WHOSE ANSWER IS A POPULATION** - four rows written into rung
   12 MULTI, needing only `W1 W2` ([campaign](docs/wiki/cross-client-campaign.md)).
7. **BLOCKED ON HARDWARE** ([table](docs/wiki/backlog.md#owed-a-verification-and-nothing-else),
   [procedures](docs/wiki/device-verification.md)). **A precondition is NOT ambient.**
8. **SIX UX/RENDERING ITEMS + TWO DEV-LOG LINES**, substance in [backlog](docs/wiki/backlog.md) only; four want ONE
   pass over `app.css`.
9. **CALLING IS HELD OFF - `CALLS_ENABLED = false`** (user, 2026-09-01); FIVE switches move in ONE
   commit at revival ([calls](docs/wiki/frontend/modules/calls.md)). Prod HAS TURN, never used.
10. **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** (user, 2026-08-25). Contract
   and audit in [backlog](docs/wiki/backlog.md).
11. **P1 - A DEVICE ASKS FOR A WELCOME FOR EVER AND THE MEMBER ANSWERING RESETS THE HEALING ROW** -
    five halves fixed 2026-09-04, **ONE PROD MEASUREMENT OWED**; read with its sibling P2
    ([backlog](docs/wiki/backlog.md)).
12. **TWELVE MESSAGES DROPPED, PERMANENT COMMIT-LOG HOLE AT EPOCH 121** - the four defects shipped
    in `v0.15.0`'s ancestors; the RESIDUE and the 13:10 arm are open ([backlog](docs/wiki/backlog.md)).
13. **`dev.canari-emse.fr` IS THE PRE-RELEASE TARGET**
    ([dev-environment](docs/wiki/infrastructure/dev-environment.md), the only copy). Two open: a dev
    deploy cannot tell a broken CHANGE from an unreachable REGISTRY, and prod's deploy job is still
    inlined shell where `deploy-dev` exercises the script ([backlog](docs/wiki/backlog.md)).
14. **THREE MORE FROM THE USER, 2026-09-05** - a P2 (a COMMUNITY message is not decrypted in a
    background notification, and the KILLED case is unmeasured for both kinds), a QUESTION (does a
    community invitation notify somebody with no prior conversation?), and one post-campaign direction
    (ICM/ISMIN: two schools, sharing only admin and messaging). All three in
    [backlog](docs/wiki/backlog.md); the first two need the phone.

### CANARI - THE ECOSYSTEM CHANTIER (migration CLOSED in all five repos 2026-08-27)

The user's standing mandate, verbatim: *"Je veux de l'homogeneite et les meilleurs standards de
partout. Partout. oxlint/oxfmt ect partout, TS7 partout ou c'est possible..., Lucide derniere version
avec tous les composants stale corriges PARTOUT, bun a la place de npm PARTOUT etc."*

**Every decision, measurement, guardrail and per-repo state is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md), the ONLY copy - add to its tables rather
than re-deriving anything here, which is what made this section wrong twice** (section 8 is the
package manager, 9 is TS 7, 10 is bun 1.4 and the lockfile-v1 invariant, 11 is the repo-by-repo state
and the second sweep's eleven gaps). Its "NOT TO BE RELITIGATED" paragraphs exist so a later session
cannot "finish" the work by undoing a measurement.

**What is left is JUDGEMENT, not migration** - MiGallery's lint warnings, the `resolve()` question
three repos park differently, Tailwind class sorting on Portail-etu. **NestJS 12 is HALF DONE and
needs nothing done to it**, the hold being an ASSERTION on the resolved tree rather than an ignore,
so it ends unattended: [nestjs-framework](docs/wiki/services/nestjs-framework.md), the only copy.

**FIVE THINGS CANNOT BE PULLED FORWARD**, each carrying its blocking condition in
[backlog](docs/wiki/backlog.md), the only copy: the MLS + Graine explanation owed to the USER, not to
the code (prose and diagrams, no code, user 2026-08-20); the iOS avatar-cache question; WP-LYDIA-1,
waiting on credentials Lydia owes; one MLS client in a SharedWorker; and the SECOND campaign.

### CANARI - release, store submission, iOS

**NEVER INFER A STORE, A VERSION OR A CI STATE FROM A LINE HERE - this paragraph has now been stale
THREE times**, so it names no version at all. `gh release list` is the shipped version, Play is a
MEASUREMENT (`bun tools/play-vitals/vitals.mjs`, [README](tools/play-vitals/README.md)), CI is
`gh run list`, and the App Store half is read on
[mobile](docs/wiki/frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on).
Its one known cause is fixed rather than suspected - the script asked whether a version was NAMED
`X.Y.Z` when Apple's rule is ONE non-terminal slot - and the key's role is SETTLED (a 409 means the
JWT was accepted). **No HEAL-REVOKE verdict about a clean device may be taken on a build older than
0.14.12.** **An APK is not reached by a deploy** - `frontendDist: "../build"` means the app EMBEDS
the frontend, so `minClientVersion` and check S reason about a NAME unless a version identifies its
content.

**2.1(a) IS PASSED** and the two guidelines replacing it are answered in 0.14.15; per-half state on
[mobile](docs/wiki/frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on).
Only **check R** is left of the 2026-08-26 mails; **WP-RESTORE-1** (April 2027) is ACCEPTED, after
the campaign.

**iOS: two things are PROVEN and must not be re-verified** - the session HOLDS on the iPhone, and a
full parity audit read everything else as symmetric. Four items open in
[backlog](docs/wiki/backlog.md), one **diagnosable with no phone at all**. **THREE OF THREE iOS
DEFECTS WERE INVISIBLE TO EVERY GATE HERE**, so those classes close by HARDWARE, one lettered check
at a time - **never by a fix written against a suspected lifecycle bug nobody has seen.**

### CANARI - the test campaign

Four files, four jobs, all listed in WHERE THINGS LIVE: board = state, campaign page = design,
methodology = how a result earns belief, README = operating manual. **Read them rather than
re-deriving anything here, and keep no second copy.**

**Five facts that are NOT on those pages, or that a session gets wrong by skipping them.**
`bun rows.mjs` SETTLES whether the board matches the ledger - run it before believing a cell, it
has caught the board wrong three times. **The rig targets the LOCAL estate since 2026-09-03**, so a
push deploys nothing and the mutual-exclusion rule died with that move
([methodology](docs/wiki/testing-methodology.md)); what replaces it is a rebuild or a `bun run dev`
SAVE, which `bundle.mjs` measures. **The board is reset to zero**, archived at
[archive](docs/wiki/cross-client-testing-archive.md). **A killed run can destroy a measurement
seconds from being recorded, and losing a `chrome-w1`/`chrome-w2` profile costs a DEVICE.** **THE
USER ASKED FOR THE LOGS TO BE READ ON EVERY PASS, the reconciliations especially** (2026-08-28) - a
heal that works is not a heal that was observed, and reading them has since found one P1 no row asks
about and turned a `FAIL` into another. Two instrument facts: the disposition for expected noise is
`ignoringExpectedLog` **per row**, never a wider classifier - and a list the runner never NAMES is
the same as no list, which cost a whole rung on 2026-09-06 - and the device cap is **re-measured
around every run** rather than quoted.

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout
soit deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

**AND ON DEPENDENCIES, 2026-08-31, WHICH DECIDES THE SHAPE OF EVERY GATE:** *"Je prefere blinder de
test et faire les choses automatiquement qu'avoir une review humaine qui n'arrive jamais"*, and
*"pour avoir un projet qui peut 'vivre tout seul'"*. **So a refusal is NEVER a routing decision to a
human queue - it is a statement that a gate is MISSING, and it must NAME the test that would lift
it.** A queue nobody drains is worse than the merge it prevented.
