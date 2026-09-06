# The 2026-09-02 workflow migration - decisions, order, and state

**This page is the ONLY copy of this chantier.** It carries the user's mandate, the twelve decisions
taken with them, the measurements already made (so that nobody re-derives them), and the ordered
checklist. **Tick a box here the moment the work lands, and delete a whole section once its durable
part has moved** - the branch model and the release conventions belong in [cicd](cicd.md), the local
estate in [development](development.md), the rules in [durable-rules](durable-rules.md), and the
stories in `CHANGELOG.md`. When every box is ticked and every durable part has moved, **delete this
page**, its row in `CLAUDE.md`'s WHERE THINGS LIVE, its queue item, and its line in
[index](index.md).

> **`deploy.yml` NO LONGER EXISTS, AND EVERY MENTION OF IT BELOW IS HISTORY (2026-09-07).** The file
> this migration built was split into `build.yml`, `serve-dev.yml` and `serve-prod.yml`, because one
> file behind a `phase: build | production` switch had to be CALLED TWICE - and GitHub draws every
> job of a called workflow as a row in the run graph, including the ones that call's `if:` can never
> satisfy. Measured on `v0.16.4`: 22 rows, 5 skipped, 4 of them structurally impossible. The release
> kind moved with it, from eight tests spread down the tree to ONE fork in `release.yml` that
> resolves an estate NAME. **Nothing below is edited for it**: a checked box records what was true
> when it was ticked, and rewriting that would falsify the record. The current model is
> [cicd](cicd.md#release-workflow), which is the only copy.

The migration REPLACES the two-branch model that landed on 2026-09-02, hours before this. Nothing
about that model is defended below: the user cancelled it the same day, and the parts of
[dev-environment](infrastructure/dev-environment.md) that describe a `dev` BRANCH are wrong from the
moment WP-2 lands. The dev ESTATE survives, with a new job.

---

## 1. The mandate, verbatim (user, 2026-09-02)

> 1) Plus de branche dev. La branche du projet c'est main.
> 2) Le deploiement (production, android, ios...) se fait au bump. Pas au push sur main.
> 3) On va fonctionner par pull request et arreter de se servir de canari-emse.fr ou
>    dev.canari-emse.fr pour le developpement local, le mieux pour la campagne de test notamment est
>    de tout faire localement. Cela evite les hooks tres longs. On peut dump la DB de prod pour
>    nourrir le local.
> 4) On aimerait utiliser les pre-release pour faire des deploiements iOS et Android test (programme
>    de testeurs), avec des numeros comme X.X.X-alpha. Je te laisse prendre les meilleures
>    conventions et te renseigner.
> 5) Dependabot continue de merge sur main si tout va bien.

And, on the campaign rig of the previous machine: *"Lithium est accessible mais pas utile. Reprends
de 0."*

## 2. The twelve decisions - DECIDED, NOT TO BE RELITIGATED

Each was put to the user on 2026-09-02 and answered. A later session that "improves" one of these is
undoing a decision, not finishing the work.

| # | Question | Decision |
| --- | --- | --- |
| 1 | The `dev` branch | **Gone.** `main` is the only branch. |
| 2 | What deploys production | **Only the completion of `Bump version on release`.** Not a push. |
| 3 | The dev ESTATE (`dev.canari-emse.fr`) | **Kept, with a new job: it is the PRE-RELEASE target.** `scheduled.yml`'s `dev-refresh` job keeps feeding it a copy of production every Monday. |
| 4 | How a release starts | **A GitHub Release published on a tag** - the mechanism that already exists, with the push-triggered deploy removed. |
| 5 | Local database | **A full production dump**, PII included, the way `dev-refresh` already copies it to the dev estate. |
| 6 | Hooks | **`pre-commit` minimal (format only), `pre-push` DELETED**, replaced by a CI that also runs at merge on `main`. |
| 7 | `main` protection | **PR required + required checks, with admin bypass** for the emergency path. |
| 8 | Local authentication | **A dedicated `canari-local` OIDC client on the PRODUCTION Authentik**, redirect URIs on `localhost`. No local IdP. |
| 9 | Tester programmes | **alpha -> internal channels only**: Play *internal testing* and a TestFlight INTERNAL group. No Beta App Review in the loop. |
| 10 | Dependabot | **The in-house `dependabot-auto-merge.yml` stays**, ceiling and sweep included. No native auto-merge. |
| 11 | Local TLS | **Plain HTTP with `ALLOW_INSECURE_COOKIES=true`.** The cookie divergence this creates is a documented reservation, not a defect - see section 4. |
| 12 | The campaign board | **Reset to zero, old verdicts archived** as "rig LITHIUM, ledger lost". The rig restarts from nothing. |

Also decided: the phone and the emulator DO target the local stack, over `adb reverse`; an `-alpha`
build points at **`dev.canari-emse.fr`**, and only a stable tag points at production.

## 3. The single emergency path (user asked for exactly one, and for it to be explained)

Production has ONE deploy trigger: the completion of `Bump version on release`. The emergency does
not add a door - it makes the same door faster.

- **The code is wrong.** Hotfix pull request, merged at once through the admin bypass without waiting
  for a review, then publish the patch Release (`0.14.16`). The deploy leaves by the normal path.
  Cost: one CI.
- **The code is right and the estate is broken** (containers lost, box rebooted). That is not a
  deploy, it is an operation: `ssh canari` then `make update-services-prod`. No version moves,
  because nothing changed.

**Consequence, and it is deliberate: `deploy.yml` loses its `workflow_dispatch` as well as its `on:
push`.** A manual dispatch would be the second door. Retrying a half-failed deploy is "Re-run failed
jobs" on the run that already exists, not a new trigger.

## 4. What is already MEASURED - do not re-derive any of this

All measured on 2026-09-02 on the current machine (`OXYGEN`) and against the remote.

- **`origin/dev` is identical to `main`**: zero commits ahead, zero files of diff. There is nothing
  to merge; the branch is a pure delete.
- **`main` has no protection and no ruleset** (`gh api .../branches/main/protection` -> 404,
  `.../rulesets` -> `[]`). WP-2 creates the first one.
- **The 20 open Dependabot pull requests all target `main`.** `target-branch` only applies to pull
  requests Dependabot creates AFTER the setting lands, so dropping it retargets nothing.
- **`scripts/bump-app-version.sh` refuses a prerelease**: `normalize_version` asserts
  `^[0-9]+\.[0-9]+\.[0-9]+$`.
- **A prerelease would COLLIDE on Android**: `gen/android/app/build.gradle.kts:25` reads
  `versionCode` from `tauri.android.versionCode`, which Tauri derives from the version and which
  ignores the prerelease suffix - so `0.15.0-alpha.1` and `-alpha.2` would ask Play to accept the
  same `versionCode` twice, and Play refuses. The suffix has to reach an explicit `versionCode`.
- **iOS cannot carry the suffix in its short version**: `gen/apple/canari_iOS/Info.plist` sets
  `CFBundleShortVersionString` and `CFBundleVersion` to the same `0.14.15`, and Apple requires the
  short version to be numeric. The alpha counter belongs in `CFBundleVersion`.
- **`android.yml` publishes straight to the `production` track**, and its own comment records
  that a second track needs its own `versionCode`.
- **`dependabot-auto-merge.yml` is wired to CD in two places** that both die with the
  push-triggered deploy: it triggers on `workflow_run` of `CD - Deploy to Production`, and it CALLS
  `workflow_dispatch` on CD after a merge. Both have to become the new CI-on-`main`.
- **The refresh cookie is not the same locally**: `apps/core-service/src/auth/auth.controller.ts:150`
  emits `Secure; SameSite=None` in production but flips to `SameSite=Lax` without `Secure` as soon as
  `ALLOW_INSECURE_COOKIES=true`. Decision 11 accepts this: on a stack where the frontend is
  `localhost:5173` and core is `localhost:3012`, `SameSite=Lax` is enough because a differing PORT is
  still same-site - but **any campaign row that reasons about cross-SITE cookie behaviour measures
  something else locally**, and the board says so per row.
- **The local compose is complete and has NO nginx**: coturn, redis, `postgres:15-alpine` (the same
  major as production, so a dump restores), chat-gateway, call-service, chat-delivery, garage, media,
  core, social - each on its own port, the frontend served by `bun run dev`. Production reaches all of
  them through one nginx, so the single-entry-point behaviour is the one thing local cannot exercise.
  **SUPERSEDED BY WP-1 ON 2026-09-03, AND THIS IS THE ONE ITEM IN THIS SECTION A READER COULD TAKE
  AS STILL TRUE.** The local compose HAS nginx now, on host port 8081, and it is the sole
  authenticator exactly as in production: `auth_request`, then `X-User-Id`, which the services read
  and nothing else. That is what made a full OIDC login and an MLS message between two clients work
  locally, and it means the single-entry-point behaviour is no longer the thing local cannot
  exercise - it is the thing local exercises FIRST. The current port table is on
  [development](development.md#local-services-docker-compose); the frontend is on **1420**
  (`strictPort`, the OIDC redirect URIs being registered on 1420/1421), not 5173 as the cookie item
  above says.
- **The handoff bundle's `.env` is a 2026-06-07 snapshot, taken BEFORE the Garage migration.** 27
  variables of today are missing from it (`GARAGE_*` x9, `APNS_VOIP_*` x5, `SKY_/CERCLE_/MIGALLERY_/
  EXTERNAL_API_KEY`, `LYDIA_*`, `GOOGLE_SAFE_BROWSING_API_KEY`, `SERVICE_ACCOUNT_USER_ID`) and 12
  dead `MINIO_*` variables are still in it. **The only usable source is the box.**
- **The bundle was collected without `-WithRig`** (131 KB): no `chrome-w1/w2/w3` profiles, no
  `results.ndjson`, no `apk/`, no `a1-baseline/`. Every campaign verdict on the board has lost the
  ledger that justified it, which is what decision 12 answers.

Measured during WP-0, and each one changes something downstream:

- **A PHONE IS ATTACHED TO THIS MACHINE**, so `CLAUDE.md`'s "campaign PAUSED for want of a phone" and
  its whole BLOCKED-ON-HARDWARE queue item are **false here**. It is a **Xiaomi Mi 9T** (`fa71073b`,
  `davinci`, Android 16, SDK 36), not LITHIUM's Pixel 6a - so a device verdict taken on the Pixel does
  not transfer, and neither does the SDK-37 defect that needed the `android-mcp` patch. WP-5 and the
  device table in [backlog](backlog.md) both have to be re-read against this.
- **The Play tester tracks ALREADY EXIST**: `internal`, `alpha` and `beta` are all serving `0.10.12`
  (code `10012`) while production serves `0.14.15` (code `14015`). Decision 9's Play half needs no
  console work, only a build pointed at the right track.
- **The `versionCode` scheme in use is `major*1000000 + minor*1000 + patch`** (`0.14.15` -> `14015`),
  which is what makes a prerelease impossible to number: `0.15.0` is `15000`, and any alpha of it
  must sort ABOVE production's `14015` and BELOW its own stable release, in a space one unit wide.
  **The scheme has to gain a digit band.** `(major*1000000 + minor*1000 + patch) * 100 + rank`, with
  `rank` 1..32 for `alpha.N`, 34..64 for `beta.N`, 66..97 for `rc.N` and **99 for a stable release**,
  keeps store order identical to semver order and keeps every future value above the `14015` already
  shipped (`0.14.15` stable would be `1401599`). Play's ceiling is 2100000000, so the band costs
  nothing. This is WP-3's numbering, and it wants a unit test rather than a comment.
- **WSL2 and Docker: the container runtime is ALREADY Linux.** `wsl -l -v` lists `Debian` and
  `docker-desktop`, so Docker Desktop runs on the WSL2 backend and moving the CLIENT into WSL would
  change nothing about the services. It was considered and refused as a development environment
  (user asked, 2026-09-02): the repo would have to leave `D:` to gain anything - `/mnt/d` goes
  through 9p and is SLOWER than native NTFS for `node_modules` and `target/` - and everything the
  campaign runs on is Windows-side (Chrome profiles that ARE MLS devices, `adb` over USB, the two MCP
  servers, the Tauri Windows and Android builds, `gh`/`glab` in the Windows keyring, cloudflared from
  winget). The one narrow job Debian keeps is running the shell suites the way `ubuntu-latest` does -
  `make test-ci-scripts` and the deploy-script tests are shell-only and tiny, so 9p costs nothing
  there, and it is a truer mirror of CI than Git Bash. **The complaint about Git Bash is real but
  narrow**, and this repo has already paid it: `jq` writes CRLF under Windows, which is why
  `bump-app-version.sh` carries `strip_cr` and why `lineEndings.test.ts` exists.
- **The Docker daemon was not running** when this started; WP-1 needs it up.

## 5. The checklist, in order

WP-0 and WP-1 come first because nothing can be verified without them. **WP-4 comes before WP-2**: a
lightened hook whose gates are not yet in CI is an open hole for the length of the chantier.

### WHERE IT ENDED, 2026-09-03

**Every work package is closed, and the four boxes still open are open because no session on this
machine can close them.** They are not deferred work and they are not a backlog - each names a
person or a piece of hardware:

| Open box | Who or what it needs | Why nothing here can do it |
|---|---|---|
| The first pre-release, `0.15.0-alpha.1` | the USER | Publishing a release is the trigger this whole chantier built. It is also the first real passage of the chain end to end. |
| The campaign's fresh test ACCOUNTS (WP-5) | the USER | Local authenticates against the PRODUCTION Authentik by decision 8, so creating them is a write to the identity provider. The attempt of 2026-09-02 was refused for exactly that reason, and the refusal was correct. The rig root and the Chrome profiles wait on this and on nothing else. |
| The iOS BUILD number | a macOS run | Whether `tauri ios build` clobbers the `CFBundleVersion` the bump wrote cannot be measured from Windows. If it does, TestFlight refuses the second alpha of a version. |
| The handoff zip destroyed | the USER | It is the only copy of things this repository must never hold, and deleting it blind is how the one thing nobody remembered goes with it. |

**One thing to carry, because it decides how the rest of the checklist reads.** The chantier
committed directly on `main` until WP-2 existed - the flow it creates cannot govern its own creation
- and it has committed through pull requests ever since, starting with the very commit that replaced
"WORK ON `main`, commit directly" in `CLAUDE.md`. Nothing here is exempt any more.

### WP-0 - this machine (DONE, both rotations included; only the handoff zip is left)

- [x] `~/.ssh/config`: `Host miconnect` added. **The `cercle` block needed no repair** - it was
      already complete here, and the diff that suggested otherwise was a re-ordering. What was
      genuinely missing was `10.0.0.7`'s entry in `known_hosts`, imported FROM THE BUNDLE rather
      than accepted blind
- [x] all four routes verified from the PowerShell tool: `canari`, `cercle`, `miconnect`
      (hostname `rootz-emse`), and `mitv` shares `canari`'s working `ProxyCommand`
- [x] the out-of-repo state root is **`d:\Documents\Programmation\EMSE\canari-harness\`**, NOT the
      `canari-secrets\` this checklist first named: that path is the SIBLING of the repo, which is
      exactly where `tools/play-vitals/lib.mjs` already looks, so **no `PLAY_SA_KEY` is needed** and
      the variable stays what it is meant to be - the override. `play-console-sa.json`,
      `google-services.json` and the harness test accounts live there; `google-services.json` is
      also placed at the gitignored `frontend/src-tauri/gen/android/app/` for a local Android build.
      **SPLIT ON 2026-09-03 by WP-5, and the split is the point**: the campaign RIG root moved one
      level further out, to `D:\Documents\Programmation\canari-harness\`, so a campaign starting
      from zero cannot half-inherit the LITHIUM one. `play-console-sa.json` and
      `google-services.json` did NOT move - they are store and build credentials rather than rig
      state, `lib.mjs` still resolves the first at the path above, and the sentence about
      `PLAY_SA_KEY` above stays true because of that
- [x] verified END TO END, not by the file existing: `bun tools/play-vitals/vitals.mjs` reads the
      key, authenticates, and reports production on `0.14.15` / code `14015`
- [x] the handoff memory installed - **11 files, not 12**: the `bunx` shim note was dropped as false
      here (see below)
- [x] **15 stale memory files deleted, and two of them were moved into the repo FIRST.** The Svelte 5
      teardown race and the `svelte:boundary` strategy existed nowhere but that directory, which
      `CLAUDE.md` calls a bug - they are now in
      [frontend/architecture](frontend/architecture.md#a-prop-expression-is-re-evaluated-during-teardown-so-an-if-does-not-protect-it)
      and [durable-rules](durable-rules.md). The other thirteen were already in the repo, or false:
      one still named `prettier` as the formatter
- [x] `chrome-devtools-mcp` (chrome_devtools **1.8.0**, 29 tools) installed and declared by absolute
      path. **Verified over stdio**: it launched Chrome on `https://canari-emse.fr/` and followed the
      redirect to `Connexion - Canari`, so the probe doubles as a production liveness check
- [x] `android-mcp` (Android-MCP **4.0.1**, package 0.2.0, **14 tools**) installed as a
      `uv tool` - the system Python is 3.12 and the package needs >= 3.13, and `uvx` was rejected
      because it re-materialises the package per launch, which would erase exactly the kind of local
      patch LITHIUM depended on. **Verified over stdio against the phone**: `ConnectDevice` then
      `Snapshot` returned the live launcher tree
- [x] **LITHIUM's `service.py` patch is NOT applied, and that is a measurement.** `device.info` -
      the discarded probe that killed the server on a Pixel 6a at SDK 37 - returns a full dict on the
      phone attached here. The patch is device-conditional; applying it blindly would have added an
      unexplainable local modification
- [x] `bunx`: **not needed.** `bun 1.4.0` here comes from the official installer at `~/.bun/bin` and
      ships `bunx.exe`. LITHIUM's shim was a winget artefact
- [x] `glab` 1.115.0 is **already on the PATH and already authenticated** to `gitlab.emse.fr` as
      `jolan.boudin` through the keyring - the memory note claiming otherwise was LITHIUM's.
      `D:\Documents\Programmation\gitlab-pat.txt` deleted. **Deleting the file did not revoke that
      PAT**, so it is a third rotation owed
- [x] **`CF_DNS_TOKEN` rotation - done by the user 2026-09-02**, who issued replacements after the
      original leaked into a transcript on 2026-09-01. The workstation could not have done it: the
      leaked token was `active` with no expiry, and `PUT /user/tokens/{id}/value` on itself answers
      **403** - a Zone-scoped token cannot roll itself - while the broad `CF_API_TOKEN` the handoff
      memory carried answers **401** and is dead. **A NEW TOKEN IS NOT A REVOKED OLD ONE**, so what
      closes this is DELETING the leaked one, not superseding it
- [x] **cloudflared tunnel RUN token rotation - DONE 2026-09-02, and it was NOT the user's click.**
      The line above said it was, which stopped being true the moment they supplied an
      account-scoped token that can read `/cfd_tunnel/{id}/token`. Rotated by `PATCH`ing the
      tunnel secret and rewriting the unit; the token in the unit fingerprinted identically to the
      one the API served, so the leaked value is confirmed dead rather than assumed to be.
      **Three things this taught, all of which outlive the rotation:**
      - **The ORDER is not free.** `PATCH` kills the old secret instantly, so the box must be able
        to receive the new token BEFORE the call is made. Verifying that the credential can *read*
        `/token` came first, precisely because a `PATCH` followed by a refusal would have left a
        healthy-looking tunnel that dies at its next restart - which is exactly what happened for
        one minute when a guard of mine refused a valid token
      - **A guard calibrated on one sample rejects the next one.** The plausibility floor was a
        digit-shaped glob (`1[0-9][0-9]`) derived from the 248-char token then in the unit, and the
        API returned 180. It refused to write, which was right, but for a wrong reason. **A run
        token's length follows the SECRET's length** (32 bytes -> ~180, 64 -> ~250), so the floor is
        now a numeric comparison that says what it means
      - **The leak CLASS is closed, not just the instance.** The unit was `644 root:root`, which is
        why `systemctl cat` as the `canari` user printed the token into a transcript at all. It is
        now `600`, and systemd is root so nothing needed it readable
- [x] **the dead broad token is its own finding**: nothing on this workstation held Cloudflare
      Access, Zero Trust or tunnel-ingress rights between its death and 2026-09-02. Re-issuing was
      the user's call and they did it
- [x] **cloudflared upgraded 2026.6.0 -> 2026.8.3** on the same visit (the user's ask). Checked
      first, because the trap is real: had the package OWNED
      `/etc/systemd/system/cloudflared.service`, or declared it a `conffile`, the upgrade could have
      replaced the file carrying the run token and killed the only door into the box. `dpkg -S`
      finds no owner and the package declares no conffile for it - measured before the upgrade ran,
      and the token fingerprint is compared across it so a silent replacement would be CAUGHT
- [x] **NO IDENTIFIER BELONGS ON THIS PAGE.** An earlier revision of it carried the leaked token's
      id and the tunnel's uuid. Neither authenticates anything, but this repository is PUBLIC and its
      own convention keeps that inventory out of public docs - the admin-hostname map is in the local
      memory for exactly this reason. They were removed the same day, and **they remain in one pushed
      commit**: an edit does not rewrite history. Ids live in
      `~/.claude/projects/<project>/memory/`, and nowhere in `docs/`
- [ ] the handoff zip destroyed - **NOT YET, AND NOT BLINDLY.** The bundle is the only copy in the
      world of `claude-account-manager`; it has been preserved to
      `d:\Documents\Programmation\claude-account-manager\` (with LITHIUM's DPAPI vault beside it, for
      the record - it will not decrypt here). Destroy the zip only after WP-1 has taken what it needs
      from the box

### WP-1 - the local estate (DONE 2026-09-03)

**Everything but the last box landed 2026-09-02.** The shape differs from what this list planned,
in one way worth keeping: the plan named ONE script, `infrastructure/dev/dump-prod-to-local.sh`. It
became FOUR, because fetching, classifying and restoring fail differently and a single script would
have had one exit code for three unrelated causes.

- [x] `/home/canari/canari/infrastructure/.env` pulled from the box as the source. **Not
      "(PowerShell)" as this line said** - either tool reaches prod since the `ProxyCommand` was
      respelled with forward slashes, and the constraint that DOES bite is the opposite one: a
      binary pipe (`pg_dump | gzip`) must NOT go through PowerShell, which text-encodes stdout and
      corrupts it. So `pull-prod-dump.sh` dumps on the box and `scp`s the file, and never pipes
- [x] `infrastructure/.env` (local) built from it by `infrastructure/local/env-from-prod.sh`:
      third-party secrets KEPT as production's (Stripe, Klipy, FCM/APNs, Authentik, Cloudflare
      TURN, avatar), **and `CHANNELS_ENCRYPTION_SECRET` kept too** - without it the dumped data does
      not decrypt. **All 61 variables are CLASSIFIED and an unclassified one is a hard error**, so a
      variable added to production later cannot be silently carried or silently dropped
- [x] `JWT_SECRET`, `INTERNAL_SECRET`, `INTERNAL_SHARED_SECRET`, `CALL_ROOM_SECRET` REGENERATED for
      local: sharing them would make a token minted on a laptop valid in production, and they carry
      no data at rest. **But regenerating them on EVERY run was a defect**: the second run
      desynchronised the containers already holding the first run's values, and every session died.
      They are now read back from `infrastructure/.env.bak` when it exists, and only minted when
      absent - which is what made that backup file exist, and is why the near-miss below happened
- [x] `ALLOW_INSECURE_COOKIES=true`, `NODE_ENV=development`, `ENABLE_DEV_ROUTES=true`, localhost
      topology (ports, `ALLOW_ORIGIN`, `FRONTEND_URL`)
- [x] `frontend/.env` (local) on the localhost ports
- [x] **four scripts, not one**, plus `make local-env` / `make dump-prod`:
      `local/pull-prod-dump.sh` (read-only, refuses to write inside the work tree, `gunzip -t`
      against truncation, and a `.meta` sidecar recording what prod held AT DUMP TIME),
      `local/env-from-prod.sh`, `local/restore-into-local.sh`, and `lib/copy-strips.sh` -
      **factored out of `dev/copy-prod-to-dev.sh` rather than copied**, so the strip list is one
      list. The caller passes its OWN guarded sql function by name, which keeps the destructive
      allowlist with whoever owns the target
- [x] **362 users restored and VERIFIED against the sidecar**, with `push_token` truncated and 7
      payment-identifier columns cleared. Two things the run taught: the restore printed
      `13 x ERROR: role "canari" does not exist` and still reported success, so it now derives roles
      from the dump, creates them `NOLOGIN`, and FAILS on any `^ERROR:` in psql's stderr; and
      `name: canari-local` in the compose file is load-bearing, a foreign project called `local`
      already existing on this machine
- [x] a `Canari Local` OIDC client on the production Authentik. **Its redirect URIs are on `1420`
      and `1421`, not the `5173` this line used to name** - `vite.config.js` pins
      `port: 1420, strictPort: true` and `frontend/.env` agrees, so the number written here from
      memory would have failed the login it was meant to enable. **It returned `invalid_request` until three fields were copied from the production
      provider** - `grant_types` was EMPTY, `authentication_flow` None, `refresh_token_threshold` 0.
      A field diff against the working provider found it; reading the error text would not have
- [x] **verified by a real login and a message sent, DONE 2026-09-03** - two clients, two browser
      contexts, `canari-test-alpha` and `canari-test-beta`, both through the production Authentik:
      OIDC callback 200, first-connection PIN accepted, `register-device` 201 and `prekeys` 201,
      `Canal E2E etabli.`, a message typed and sent, and **the peer's client received it and
      DECRYPTED it** - the plaintext appears in beta's conversation list with an unread count of 1.
      Console at the end: nothing but the avatar 404 that means "this user has no photo", which is
      the documented answer. **PERFORMING IT FOUND THREE DEFECTS NO FILE COULD HAVE SHOWN, and all
      three are now fixed** (2026-09-02/03):
      - **The local estate had NO NGINX, and nginx is where a bearer token becomes an identity.**
        It runs `auth_request` against core-service and copies four headers onto the upstream
        request; a service reads `X-User-Id` and never validates a JWT itself. So Authentik
        authenticated, `/api/auth/oidc/callback` answered **200**, and then every authenticated
        route answered **401 `Missing X-User-Id header - ensure the request passes through nginx
        auth`**. A login that succeeds and an application that can do nothing. `vite.config.js`
        now sends every `/api/*` to a local nginx built from production's own image, and **two of
        the old per-service proxies were FORGING part of that work** - `/api/mls/` and
        `/api/calls/` set `x-user-logged-in: true` unconditionally, which made an unauthenticated
        caller look logged in on exactly the routes the MLS work is measured on. That table also
        omitted NINE route families nginx serves, so they were simply broken locally
      - **17 environment keys production forwards, this estate did not** - three of them the
        `AUTHENTIK_*` trio, which is why no login could complete, with all three sitting correctly
        in `infrastructure/.env` the whole time. **`.env` holding a value proves nothing: the
        compose file has to forward it.** Now a GATE rather than an audit -
        `compose-wiring.test.sh` derives every key production passes and fails on any the local
        file does not (52 assertions; proved to fail by deleting one). **`ci.yml`'s own trigger
        missed the new input for one commit** - the local compose file was not in the paths that run
        the script self-tests, which is the exact shape the comment there warns about; `local/`
        joined the pattern
      - **`optimizeDeps.include` in `frontend/vite.config.js` listed HALF the dependencies, and half
        a list buys nothing.** On a cold cache the optimizer discovered 36 more packages in four
        waves and forced THREE full page reloads - and **a reload destroyed the OIDC login in
        flight, because an authorization code is single-use.** The estate looked broken when only
        the dev server was; the same reload would void a campaign measurement mid-run. The
        mechanism was already there with the right comment on it, so this was a stale list rather
        than a missing idea, and the list is now everything OBSERVED being discovered
- [x] **four latent defects fell out of merely RUNNING the stack**, none of which any gate here
      catches, and they are the argument for the local estate on their own: `.dockerignore` was
      missing `**/*.tsbuildinfo`, so three NestJS services shipped a partial `dist` and died with
      `Cannot find module` while the build stayed green; `make run-services` printed a tick over
      dead containers, and now calls `check-services`, which lists what is not running and dumps its
      logs; social-service got no `REDIS_URL` locally though prod gives it one; and its Redis error
      handler logged an empty message, so it now names the target host:port with userinfo stripped
- [x] **a near-miss worth more than the work: `git add -A` staged `infrastructure/.env.bak`** -
      7930 bytes of PRODUCTION credentials - into a commit for a PUBLIC repository. Caught in the
      commit, not on the remote. The root `.gitignore` had `.env` alone while `frontend/.gitignore`
      already had the right rule; it now carries `.env.*` with `!.env.example`. The rule this left
      is in [durable-rules](durable-rules.md)

### WP-4 - hooks (before WP-2)

**Done 2026-09-02, and in that order: the gates were closed BEFORE the hook that was standing in
for them was deleted.** Two of the four were genuinely missing, so deleting `pre-push` first would
have opened a hole for as long as it took to notice.

- [x] each of the four things `pre-push` alone covered confirmed present in `ci.yml` -
      `make test-harness`, the real `wasm32` build, clippy, the frontend suite - **and the two that
      were missing added THERE FIRST**: `src-tauri` was built but never `cargo fmt`-checked (the
      matrix entries now carry `fmt: true` and the step fires on `check` OR `fmt`), and the four
      NestJS apps all declare `format:check` and nothing ran it (the TS job now derives a
      `has_format` output and runs it)
- [x] `.husky/pre-commit` reduced to fixers only - `lint:fix` + `format` across the five bun
      packages, `cargo fmt` across the five crates, with the existing re-staging allowlist. **It
      asserts nothing now**: a hook that fails is a hook that gets bypassed, and CI is where a
      verdict belongs
- [x] `.husky/pre-push` deleted
- [x] optional, and the ONLY job WSL keeps here: run `make test-ci-scripts` and the deploy-script
      tests from the `Debian` distro, which is what `ubuntu-latest` actually is. They are shell-only
      and tiny, so `/mnt/d` costs nothing, and Git Bash has already let a Windows-shell difference
      through (`jq` and CRLF). **CLOSED 2026-09-03 AS RETIRED BY WP-2, NOT AS DONE - and the two
      are worth telling apart.** The distro is there and answers (Debian 13 trixie, bash 5.2.37,
      `/mnt/d` readable), but it is a bare install: `jq`, `node`, `make`, `shellcheck` and `python3`
      are all absent, and `sudo` wants a password this session does not have. **What actually
      retires the box is that the thing it was a substitute FOR now runs on every pull request.**
      `ci.yml`'s `test-ci-scripts` job executes `make test-ci-scripts` on `ubuntu-latest`, and since
      2026-09-03 `main` refuses a direct push - so no change reaches the trunk without those tests
      having run on the real runner image, which is strictly better evidence than a local
      approximation of it. A WSL run would only have made the same verdict arrive sooner, and it
      would have cost an apt install and a password to get a WEAKER version of a gate that already
      exists. **If it is ever wanted anyway**, the reason is earliness alone and the price is
      `sudo apt install jq make nodejs shellcheck` inside the distro

### WP-2 AND WP-3 ARE ONE WORK PACKAGE, not two - found 2026-09-02, before either was written

The checklist below lists them separately and they cannot be committed separately. The coupling is
mechanical, not stylistic:

- production deploying "at the bump" needs no new trigger - `deploy.yml` already has
  `workflow_run: ['Bump version on release']`, and deleting `on: push` leaves exactly that. Fine.
- **`deploy-dev` is triggered by a PUSH to a branch today.** Deleting `on: push` leaves it with no
  trigger at all.
- re-wiring it to a PRERELEASE tag requires telling a prerelease release from a stable one, and
  **the `workflow_run` context does not carry that flag**. It has to be passed down by
  `bump-version.yml` - which is a WP-3 item ("carries the prerelease flag downstream").

So committing WP-2 alone leaves the dev estate unreachable by any deploy until WP-3 lands, and
`one coherent commit per work package` is what forbids that. **DECIDED BY THE USER 2026-09-02: one
package, one commit.**

**AND THE FLAG DOES NOT NEED PLUMBING AFTER ALL** - found while reading the four consumers, and it
makes the merged package smaller. After the bump, `frontend/package.json` CARRIES the suffix
(`0.15.0-alpha.1`), a hyphen in a version IS the semver definition of a pre-release, and all four
release workflows already read that file at the checked-out commit. So each one can decide for
itself, from the manifest, with nothing passed between workflows and nothing added to
`bump-version.yml`. Deriving it from `workflow_run.head_branch` (the tag) would also work for a
release-triggered run but NOT for the `workflow_dispatch` path, where the head branch is `main`;
the manifest is right in both.

> **SUPERSEDED ON 2026-09-03, AND THIS IS THE ONE DECISION ON THIS PAGE THAT WAS.** The reasoning
> above is correct *for a workflow woken by another workflow*, which is what they all were: the
> manifest was the only honest source available. The chain then collapsed into ONE run, and a
> CALLED workflow has a caller that knows - so the flag IS passed down now, as `inputs.prerelease`,
> answered once by `release_kind()` in `.github/scripts/lib/release-preconditions.sh`. Four
> workflows each re-deriving the same fact is what let production go ahead of dev without anything
> noticing. **Do not "restore" per-workflow reading of the manifest**; the hyphen is still the
> definition, but there is exactly one implementation of that sentence. See
> [the collapse](#the-chain-collapsed-into-one-run-on-2026-09-03-and-what-that-changed-about-this-page).

**The real blocker is one function.** `scripts/bump-app-version.sh` line 14, `normalize_version()`,
matches `^[0-9]+\.[0-9]+\.[0-9]+$` and EXITS on anything else - so a release tagged
`v0.15.0-alpha.1` fails on the first step, before any of this matters. That is where the merged
package starts.

### WP-2 - the branch, and deploy-at-bump (DONE 2026-09-03)

- [x] `deploy.yml`: `on: push` and `workflow_dispatch` removed (section 3 explains why the dispatch goes)
- [x] `deploy.yml`: `build-frontend-dev`, `build-frontend-images-dev`, `promote-dev-to-main` deleted -
      and `run-ci` / `run-code-analysis` went with them, both being `if: event != workflow_run`,
      which is now never true. CI runs on the pull request and at merge on `main` instead
- [x] `deploy.yml`: `deploy-dev` kept, re-wired to fire on a PRERELEASE - read from the MANIFEST, by
      a new `release-kind` job, because `github.event.release.prerelease` does not exist in a
      `workflow_run` context and `head_branch` says `main` on the hand-dispatched path
- [x] a CI that runs at merge on `main` (the user's ask), and which becomes the convergent trigger.
      `workflow_dispatch` added to `ci.yml` too: the auto-merge's `GITHUB_TOKEN` merges raise no
      push event, so without it the merged COMBINATION would never be tested
      the auto-merge needs
- [x] `dependabot-auto-merge.yml`: its `workflow_run` on CD and its `workflow_dispatch` CALL to CD
      both re-pointed at that CI
- [x] `.github/dependabot.yml`: the 6 `target-branch: "dev"` removed
- [x] a ruleset on `main`: pull request required, required checks, admin bypass - **created
      2026-09-03, id `22152902`, `enforcement: active`, condition `~DEFAULT_BRANCH`.** Four rules:
      `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks`. Three of its
      parameters were decisions rather than defaults. **`required_approving_review_count: 0`** -
      this is a solo repository, and the user's standing directive (*"Je prefere blinder de test et
      faire les choses automatiquement qu'avoir une review humaine qui n'arrive jamais"*) forbids a
      queue nobody drains; the pull request is here to make the change VISIBLE and to make CI run on
      the merged combination, not to wait for a human. **One required context, `CI passed`, and it
      could not have been any other** - every real job in `ci.yml` is behind a `changes` path
      filter, and a required check that is SKIPPED either blocks the merge for ever or passes
      vacuously depending on how GitHub resolves it, so the aggregate job with `if: always()` (added
      the same day) is the only thing safe to require. **`require_extra_approval_for_unattributed_changes: false`**,
      set by a follow-up `PUT` because the API defaults it to `true`: it would have demanded a human
      approval on exactly the merges that must never need one - Dependabot's - and would have jammed
      the auto-merge the moment the ruleset went active. The bypass is `RepositoryRole 5` (admin,
      `bypass_mode: always`), which is the emergency path of section 6 and the only reason a broken
      `CI passed` cannot lock the repository out of its own `main`
- [x] `origin/dev` deleted - **2026-09-03, after measuring rather than assuming.** It was 13 commits
      BEHIND `main` and 0 ahead, so nothing was lost, and all 19 open pull requests already targeted
      `main`, so nothing was orphaned. Both facts were checked before the delete and neither is
      recoverable afterwards, which is why the order matters
- [x] `scheduled.yml`'s `dev-refresh` job left running (the estate survives)
- [x] **the `prod-deployed` tag RETIRED AS AN INPUT, and `detect-changed-services` re-pointed
      at the last RELEASE first.** What it was re-pointed at is narrower than "the last release tag", and the
      reason is the moving image tag: production deploys `:latest`, which only a STABLE moves, and
      dev deploys `:dev`, which only a PRE-RELEASE moves - so the baseline has to be the previous
      release **of the same kind**, or a service changed since the last alpha but not since the
      intervening stable would never be rebuilt for dev. The order comes from `gh api .../releases`
      (newest-first by creation) and NOT from `git tag --sort=v:refname`, which places
      `v1.0.0-alpha` AFTER `v1.0.0` without `versionsort.suffix`. The user asked for the tag to be deleted outright
      (2026-09-02, against my recommendation to keep it - their call, not to be re-litigated),
      because with deploy-at-bump it would always equal the release. **It was RENAMED instead, to
      `prod-released` at `6068fca0`**, and that is a deliberate departure worth one sentence: the
      commit production is actually serving is not always the release, precisely because of the
      emergency path - a push straight to `main` deploys nothing now, but a hand-run deploy still
      can, and after one, nothing else in the repository would say which commit prod received. So
      the tag stays as a RECORD and is no longer an INPUT, which is the half of the user's ask that
      carried the reasoning. `6068fca0` is the last commit production actually deployed, read from
      the successful `Deploy to Production Server` job in run 33691394757 rather than from the old
      tag's own position. The re-point is not optional and comes FIRST: the change
      detector measures against that tag rather than the previous push, and that is the only reason
      a cancelled pending run is harmless (GitHub keeps one waiting run per group and cancels the
      rest; the survivor rebuilds what the dropped ones would have). Twelve references in `deploy.yml`
      and four wiki pages move with it

### WP-3 - pre-releases

**THE FIRST STEP FAILS TODAY, AND IT IS ONE FUNCTION.** `scripts/bump-app-version.sh` line 14,
`normalize_version()`, matches `^[0-9]+\.[0-9]+\.[0-9]+$` and EXITS on anything else - so a release
tagged `v0.15.0-alpha.1` dies before any store number is computed. Fix that before the rest of this
package is even testable. The `versionCode` band is `(major*1e6 + minor*1e3 + patch)*100 + rank`,
**`rank` = N for `-alpha.N` and 99 for a stable** - not 0, which was the first shape written here and
is wrong: it would put `0.15.0` BELOW every alpha of `0.15.0`, and Play refuses a code it has already
seen. With 99 the order is `alpha.1` 1500001 < `alpha.98` 1500098 < stable 1500099 <
`0.15.1-alpha.1` 1500101. Today's `0.14.15` is 14015, so the whole band steps up once and stays
monotonic, and the ceiling (`0.999.999` -> 99999999) is well inside Play's 2100000000. Note this
multiplies EVERY future code by 100: a one-way step, taken deliberately, because Tauri's own
derivation (`major*1e6 + minor*1e3 + patch`, which produced 14015) leaves no room for a rank.

- [x] `scripts/bump-app-version.sh` accepts `X.Y.Z-alpha.N` and writes THREE different strings,
      which is the part that is easy to get wrong (measured 2026-09-03):
      - the FULL `0.15.0-alpha.1` into `frontend/package.json`, the four `apps/*/package.json`, the
        `libs/*` ones and every `Cargo.toml` + `Cargo.lock` - all of which accept a semver
        pre-release, and `frontend/package.json` is the one the client identifies itself by
        (`vite.config.js` defines `VITE_APP_VERSION` from it, so `minClientVersion` compares against
        it)
      - the NUMERIC CORE `0.15.0` into `tauri.conf.json`, because Tauri writes that value into
        `CFBundleShortVersionString` and **Apple requires the short version to be numeric**. A
        prerelease suffix there is an App Store validation failure, not a cosmetic difference
      - the BAND `1500001` into an explicit `bundle.android.versionCode`. Left alone Tauri derives
        `major*1e6 + minor*1e3 + patch` (that is where today's `14004` comes from), which IGNORES the
        suffix, so `-alpha.1` and `-alpha.2` would both ask Play to accept the same code
- [ ] **the iOS BUILD number is the one thing not settled from this machine, and it must not be
      guessed.** `CFBundleVersion` has to differ between two TestFlight uploads of the same short
      version, the band (`1500001`) is the natural value since Android already uses it, and the
      committed `Info.plist` can carry it - but `tauri ios build` RE-SYNCS both version keys from
      `tauri.conf.json` during the build (that re-sync is why `bump_ios_app_infoplist` exists at
      all), which would put `0.15.0` back into both. Tauri 2.11.4 exposes no iOS version override.
      `ios.yml` already patches the plist with `PlistBuddy` for the export-compliance code,
      so the patch has a home; **what is unknown is whether that home is early enough**, and only a
      macOS run answers it. Do not write the fix against the guess
- [x] **NOTHING carries a prerelease flag downstream, and that box is DELETED** (measured
      2026-09-02, before a line was written). After the bump, `frontend/package.json` itself reads
      `0.15.0-alpha.1`, all four release workflows already read that file at the checked-out commit,
      and **a hyphen in a version IS the semver definition of a pre-release** - so each workflow
      decides for itself with nothing passed between them and nothing added to `bump-version.yml`.
      The alternative, `workflow_run.head_branch`, is right for a release-triggered run and WRONG
      for the `workflow_dispatch` path, where the head branch is `main`. **`github.event.release.prerelease`
      is invisible from a `workflow_run` context**, which is what made a flag look necessary.
      **SUPERSEDED 2026-09-03: the flag IS passed down now, because the arms are CALLED and the
      caller knows** - see the note above and the closing section
- [x] `android.yml`: track `internal` when prerelease, `production` otherwise. **Two
      tracks became reachable only because each alpha now carries its own `versionCode`** - the
      old comment there said internal testing "needs its own build cadence", and the band is it
- [x] `ios.yml`: **there is no group to select, and that is the finding.**
      `altool --upload-app` hands the build to App Store Connect and every INTERNAL tester sees
      every processed build automatically - internal groups are not opt-in per build, unlike
      external ones, which is exactly why decision 9 chose them. On iOS the alpha/stable difference
      is the backend the bundle is built against, and nothing else
- [x] an alpha build carries the DEV `VITE_*` set, a stable build production's, and **the job FAILS
      when the tag's nature and the backend URL disagree** - this is the one place in the chantier
      where a mistake ships to phones, so it is an assertion and never a convention. Written into
      FOUR workflows, not two: `deploy.yml`, `android.yml`, `ios.yml` and
      `appimage-release.yml`, the last of which bakes an origin in exactly like the store bundles.
      **`appimage-release.yml` was deleted 2026-09-03** (no audience for a Linux desktop client), so
      the assertion lives in THREE workflows now - the box stays ticked because it records what was
      done, and restoring that file restores its copy of the assertion with it.
      There is no fallback from the `DEV_*` secrets to the production ones anywhere - falling back
      is precisely how an alpha ends up talking to production
- [x] a prerelease deploys the dev estate; a stable deploys production
- [ ] the first pre-release is `0.15.0-alpha.1` (`0.14.15` stays the stable in the stores) -
      **the one box of WP-3 nothing here can tick: it is a release somebody publishes**

### WP-5 - the campaign, from zero

**WHAT THE HARDWARE ANSWERED 2026-09-02, so nobody re-measures it.** Both phones are visible to
ADB at once, and they are NOT interchangeable: the Mi 9T carries **0.5.0** and the Pixel 6a
**0.14.15**, a gap of nine releases, so **the Mi 9T is a LEGACY client and reads as one** - it is the
right device for a `minClientVersion` row and the wrong one for anything measuring current
behaviour. Both had `screen_off_timeout` raised to 1800000 (30 min), because a screen that sleeps
mid-run ends the run. A debug build pointed at `dev.canari-emse.fr` has to be BUILT and INSTALLED;
neither phone can reach the local stack without `adb reverse`, which is per-device and does not
survive a replug.

- [ ] a new rig root at `D:\Documents\Programmation\canari-harness\`, fresh Chrome profiles, fresh
      test accounts, target LOCAL - **THE REPOSITORY HALF IS DONE 2026-09-03; THE REST IS BLOCKED ON
      THE USER AND IT IS THE RIGHT KIND OF BLOCKED.** `names.example.mjs` now points at
      `../../../../canari-harness`, one level further out - a root the old path cannot reach cannot
      be half-inherited - and its `SITE` is `http://localhost:1420`. **Two files were deliberately
      LEFT in the old directory**, `play-console-sa.json` and `google-services.json`: they are STORE
      and BUILD credentials rather than rig state, `tools/play-vitals/lib.mjs` resolves the first by
      that exact path, and its README now says so in the imperative so nobody tidies it. **What
      cannot be done here is the ACCOUNTS.** Local authenticates against the PRODUCTION Authentik
      (decision 8 - no local IdP), so "fresh test accounts" means creating users on
      `auth.canari-emse.fr`, which is a write to the identity provider; the attempt of 2026-09-02
      was refused for exactly that reason and the refusal was correct. **And the rig root is not
      created with a placeholder `names.mjs`** - a display name that looks real and matches nothing
      is the precise failure that file exists to prevent, since a check clicking a name nobody
      renders opens NOTHING and then reports on whatever conversation was on screen. Absent beats
      plausible. The Chrome profiles follow the accounts, being enrolments of them
- [x] the board reset, old verdicts archived in a dated "rig LITHIUM, ledger lost" section -
      **DONE 2026-09-03, as a separate PAGE rather than a section.**
      [cross-client-testing-archive](cross-client-testing-archive.md) holds the old board verbatim;
      the live board keeps the ladder and the rows and returns 142 cells to `pending`. A section
      inside the board would have doubled a page whose first line is "STATE ONLY, AND IN AS FEW
      WORDS AS THE STATE ALLOWS", which is the same reason `docs/changelog-archive.md` exists.
      **Three judgement calls worth recording.** The per-section RUN SUMMARIES ("`0c31be5d`,
      2026-08-27: 25 rows, 19 `PASS`...") were stripped, but each of them had a design fact or a
      finding welded to it, and those stayed: GRP's third-device discovery, COMM's
      `Workspace`-is-not-MLS-membership, DEL's pairing rule. **A finding outlives its ledger** - it
      is a statement about the system, not a verdict about a run. **`skipped` was not carried over
      either**, two of the deliberate skips having been justified by the 2FA a re-enrolment used to
      cost and by the production target, both gone. And **a `pending` cell that carried an
      EXPECTATION kept it** ("`pending` - the AEAD tag must fail"), because that is the row's
      question and not its answer. The `VACUOUS` definition changed with the target: on local the
      thing that redeploys under a run is a `bun run dev` reload, more frequent and less visible
      than a CD run, so `bundle.mjs` matters MORE here than it did against production
- [x] the campaign pages rewritten: the target is local, the phone enters by `adb reverse`, and the
      cookie reservation of section 4 is stated per row - **DONE 2026-09-03.**
      `cross-client-campaign-resume.md` was rewritten WHOLE, because it is the page whose entire
      subject is "the delta since the pause" and the delta is now four simultaneous changes, any one
      of which would have invalidated the board on its own. `cross-client-campaign.md` took targeted
      edits: the target section, the state directory, the debris section (clearing it got CHEAPER,
      not optional - restoring the dump instead of a `DELETE` somebody has to be trusted with), and
      a new standing rule for the cookie. **The cookie reservation is written as a rule about
      EVIDENCE rather than as a caveat**: `SameSite=Lax` without `Secure` is sound for what local
      measures, a differing PORT still being same-site, so the affected rows are neither `SKIPPED`
      nor silently believed - they carry the reservation in their own cell, which is this
      repository's existing rule that a column is only evidence for the question it was written to
      answer. **One correction is repeated on both pages because it was the stated reason the rig
      could not move**: "89 files carry `canari-emse.fr` as a literal with no central constant" was
      false - zero navigation literals, 120 CDP tab matchers matched by substring, zero anchored
      comparisons - and a count of occurrences is not a measurement of coupling
- [x] **two standing rules DELETED, and that is a gain** - **DONE 2026-09-03, in two passes by
      design.** WP-6 corrected "a campaign run and a push to `main` are mutually exclusive" to name
      a RELEASE, because the trigger had changed and the danger had not; this pass RETIRES it, both
      halves now being gone - a push deploys nothing, and a local run is not on the path of any
      deploy at all. "The rig targets PRODUCTION" is false with it. Six places carried them and all
      six moved: `cross-client-campaign.md`, `cross-client-campaign-resume.md`,
      `testing-methodology.md`, `CLAUDE.md`, and the comments in `healnew.mjs` and `watch.mjs`.
      **What replaced the rule is the part worth carrying**, and it is worse in the way that
      matters: a `bun run dev` reload swaps the bundle under the clients exactly as a deploy did, it
      happens on a SAVE, it needs no pipeline, and there is nothing to watch the way `gh run list`
      was watched. `bundle.mjs` still catches it, and did not have to change - because it was
      derived from what a client is EXECUTING rather than from what happened upstream. **A check
      written against STATE survived the replacement of its own cause**, which is the argument this
      repository keeps making, arriving here as evidence rather than as advice

### WP-6 - documentation (DONE 2026-09-03)

- [x] `CLAUDE.md` first: "WORK ON `main`, commit directly" is replaced by the PR flow, the
      deploy-at-bump rule, and the release conventions - **2026-09-03, and it is the first change in
      this chantier to arrive by pull request**, which is the only honest way to land the sentence
      that requires them. Three edits, not one: the directive itself (the loop, the ruleset id, why
      no approval is required, and that the admin bypass is the emergency path and gets written down
      when taken); a NEW directive beside it saying nothing deploys on a push, because "commit
      directly" was never only about the branch - it was also how work reached production, and
      deleting it without replacing that half would leave a session believing a merge ships; and the
      WORKFLOW CYCLE line, which named a commit and no longer had anything carrying it. A fourth
      edit went with them: **"a campaign run and a push to `main` are mutually exclusive" is now "a
      campaign run and a RELEASE"** - the trigger changed, the danger did not, and a safety rule
      naming an event that can no longer happen reads as retired rather than as moved
- [x] `durable-rules.md`, `cicd.md`, `infrastructure/dev-environment.md`, `backlog.md`, `index.md`,
      `README.md`, `infrastructure/MIGRATION.md` - **DONE 2026-09-03.** The head sections of
      `cicd.md` and `dev-environment.md` had already been rewritten in the WP-2+WP-3 commit, because
      a wiki contradicting the workflows is worse than none; this pass took the rest. **The three
      `durable-rules` entries are the ones worth reading**, because a rule is not a description and
      the temptation was to delete two of them. The staging-branch rule keeps its whole argument and
      gains one sentence saying the instance lived a day - the SHAPE recurs, and what replaced the
      promotion is a human publishing an alpha, which is the same gate with a person in it. The
      concurrency rule's baseline moved from the `prod-deployed` tag to the previous release of the
      same kind, and one of its two reasons to serialise went with the tag. And the CLOCK rule
      caught its own instance: it says to bind a convergent pass to "the workflow that runs on a
      push to `main`", which was CD and is now CI - a convergent trigger names an EVENT, a workflow
      is only its current proxy, and nothing announces the day one stops being the other.
      **`backlog.md` closed an item rather than editing it**: "there is no way to deploy dev without
      deploying production", raised by the user on 2026-09-02, is answered - a run deploys exactly
      one estate - and by neither of the two shapes that had been weighed
- [x] `sessions.md`, `infrastructure/databases.md`, `infrastructure/docker.md`,
      `services/chat-gateway.md` - **DONE 2026-09-03, and three of the four needed nothing.** They
      were on this list because they mention deploys, and a grep for the branch model found every
      such mention to be about what a deploy DOES rather than what starts one. The single real edit
      is `docker.md`, which said `:latest` was "built by CI on push to main" and `:dev` was the
      "latest dev build" - both tags now mean something narrower and load-bearing: `:latest` is
      moved by a STABLE release and nothing else, `:dev` by a PRE-RELEASE and nothing else, and the
      separation is forced rather than chosen, a deploy resolving a tag for every service in the
      compose file including the ones it did not rebuild
- [x] the three campaign pages, `.github/scripts/tests/deploy-env.test.sh`,
      `.github/scripts/tests/deploy-migrations.test.sh`, `infrastructure/deploy/env-manifest.tsv`,
      `tools/cross-client-harness/srvlog.mjs` - **DONE 2026-09-03, for the branch model only.** The
      four non-wiki files carry no claim about what triggers a deploy; what they will need is the
      move to a LOCAL target, which is WP-5's work and not a documentation edit. On the three
      campaign pages the change is one fact repeated: **the mutual exclusion names a RELEASE now,
      not a push.** That is the correction that mattered most in the whole sweep, because it cuts
      both ways - the accident that voided COMM-12, COMM-22 and DEL-9 on 2026-08-27 (a
      DOCUMENTATION commit redeploying the frontend mid-run) is now impossible, and what replaced
      it is rarer, deliberate, and therefore easier to forget. `cross-client-campaign-resume.md`
      also loses a hazard outright: the dependency sweep used to dispatch `deploy.yml` itself, so
      production could be redeployed mid-run by a merge nobody performed, and there is no deploy
      left to dispatch. The `testing-methodology.md` HEADING is deliberately left naming the push,
      because that is what actually happened on 2026-08-27 and a rule reads as retired the moment
      its incident is rewritten out of it
- [x] `development.md` extended with the local estate (NOT a new page - this one already owns local
      setup, the Makefile, compose and the hooks) - **DONE 2026-09-03.** WP-1 had already put the
      port table, the nginx section, the environment section and the `optimizeDeps` finding here, so
      what this pass added is the SENTENCE that makes them load-bearing: local is where development
      happens and there is no alternative to it, because nothing deploys at a push any more - there
      is no longer any way to see a change running by pushing it. With the two consequences worth
      stating once: bypassing nginx tests nothing the application does, since it is the sole
      authenticator, and `dev.canari-emse.fr` is no longer where a change is first tried. The
      "Working in this repo" list gained the pull-request loop
- [x] `docs/user-guide/workflow-developpement.md` - French, the user's own page, and the most
      rewritten of all - **REWRITTEN WHOLE, 2026-09-03.** Not edited: the old page's section 1 was
      three things the user still had to do to turn the dev estate on, which have been done since
      2026-09-02, and its sections 2 and 2.1 explained at length why one could NOT push to dev
      without deploying production - a question the migration answers by making a run deploy exactly
      one estate. Editing around that would have left the shape of a page written for a model that
      no longer exists. The new one is eight sections: the three rules and the table of what each
      kind of release deploys; local development as the only place development happens; the pull
      request; publishing a release, with the store version-code band and the one mistake in the
      chain that reaches a phone; the two estates; dependency updates; what to do when it breaks;
      and what is still owed to the user. It carries a dated banner saying it was rewritten, so a
      contradicting sentence found elsewhere is known to be the stale one
- [x] `CHANGELOG.md` under `[Unreleased]` - **DONE 2026-09-03.** Three entries were already
      written with the work (the local estate and its nginx, deploy-at-bump, the pre-release bump);
      this pass added the ruleset and the deletion of `origin/dev`, and did one thing that needed
      deciding. **The entry describing `target-branch: "dev"` and `promote-dev-to-main` was
      superseded before it ever shipped**, and the obvious move was to delete it - `[Unreleased]`
      is not history. It is kept, marked superseded, because it carries the MOTIVE: the outage of
      2026-09-01, why every gate here asks a question about the SOURCE, and why a branch nobody
      promotes is a queue nobody drains. Delete it and the next session proposing `target-branch`
      starts from nothing

## 6. Traps this chantier must not leave behind

- **Pull request #309 (`postgres 15-alpine -> 18-alpine`) must stay refused** until the PG migration
  is performed, and the refusal must NAME the test that would lift it. It is the update that took
  production down for 33 minutes on 2026-09-01. With deploy-at-bump it would merge in silence and
  break the first release instead - later, and further from its cause.
- **Deleting `pre-push` before its gates exist in CI** is the hole four of its own comments were
  written to close. WP-4 is ordered before WP-2 for that reason alone.
- **An alpha build pointed at production** is the one mistake here that reaches a phone. WP-3 makes
  it a failing assertion, not a convention.
- **`dev-environment.md` keeps its estate and loses its branch.** Half of that page is right and half
  is void from WP-2; a reader who trusts the wrong half will look for a branch that no longer exists.

## The chain collapsed into ONE run on 2026-09-03, and what that changed about this page

**THIS MIGRATION IS STILL CLOSED AND ITS MANDATE STILL HOLDS.** One branch, nothing deploying on a
push, work arriving by pull request, a stable deploying production and a pre-release deploying dev -
every one of those survived unchanged. What changed is the SHAPE of the thing that carries them out,
and it changed because publishing the first two releases for real measured three defects no gate
here could have found.

**WHAT WAS MEASURED, on 2026-09-03:**

| What happened | Why nothing here could have caught it |
|---|---|
| `v0.15.0` deployed production with a **RED** `CI passed` on the commit it released | the chain required the **BUMP** to succeed, which is a different statement. "If the tests are green" was written in no file |
| production went **three merged pull requests ahead of dev** | the two gestures landed on two unrelated commits and nothing compared them. There was no mechanism to be wrong - there was no mechanism |
| each of the three arms resolved `main` for **itself** | so a merge landing mid-release could hand a store a different tree from production, with no artefact carrying a commit to disagree |

All three are one defect: **a decision taken more than once, and a precondition asserted nowhere.**

**WHAT REPLACED IT.** `release.yml` is the only entry point, with five jobs: `preflight` -> `bump`
-> `deploy` + `android` + `ios`. The three arms became `workflow_call` workflows invoked with
`uses:`, so they are jobs of one run rather than four runs chained by `workflow_run` - one page to
read, real `needs:` ordering, and the same inputs to all three. `bump-version.yml` is gone; the bump
is a job. `cd.yml`, `android-release.yml` and `ios-release.yml` were renamed `deploy.yml`,
`android.yml` and `ios.yml`, because a file that is called by name should read as what it does.

**THE GATE THAT MATTERS MOST IS THE FOURTH** (user: *"Je ne veux pas un detecteur de retard, je ne
veux pas que ca soit possible"*). A stable is refused unless the `dev-deployed` marker names that
commit or a descendant of it. A lag DETECTOR was written first and deleted unshipped - the same
measurement, turned into a refusal.

**TWO TRAPS FOUND WHILE DOING IT, both silent and both green:**

- **`github.event_name` in a called workflow is the CALLER's event.** Four steps gated on
  `github.event_name == 'workflow_run'` went permanently false in one stroke - both release-asset
  uploads, the TestFlight upload and the Play publish. Green run, no store receiving anything. The
  fix carries the distinction as an INPUT (`publish`), from the one place that knows it.
- **A job may only read `needs.<job>` for a job it declares, and the failure is an empty string.**
  The three arms declared `needs: bump` and read `needs.preflight.outputs.prerelease`, so every arm
  would have received `prerelease: ''` - accidentally right for a stable, and for an ALPHA a tester
  build with the PRODUCTION origin baked in, passing its own estate assertion while doing it.

Both are asserted in `.github/scripts/tests/release-chain.test.sh` now, and both belong to the same
class: **a condition that cannot be true is as invisible as a required check that is always
skipped.** Everything about the resulting pipeline is on [cicd](cicd.md), the only copy.
