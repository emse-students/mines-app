# Resuming the cross-client campaign

The campaign was paused on 2026-08-30 for want of a phone. **It does not resume - it RESTARTS, from
zero, on a rig that does not exist yet.** That is the honest description of what 2026-09-03 did to
it, and this page is the only copy of what that costs and in what order it is paid.

**This page is the DELTA and the ordered restart, and nothing else.** Where the campaign stands is
the [board](cross-client-testing.md); what the old board said is
[the archive](cross-client-testing-archive.md); what each rung is for is the
[campaign page](cross-client-campaign.md); why a result may be believed is
[testing-methodology](testing-methodology.md); how to drive the rig is
[the harness README](../../tools/cross-client-harness/README.md). None of that is restated here.

---

## 1. Four things changed at once, and each alone would have invalidated the board

| What changed | When | What it does to a run |
|---|---|---|
| **The rig is GONE** | 2026-09-02 | This machine was reconstituted from a handoff bundle collected without `-WithRig`: no `chrome-w1` / `chrome-w2` profiles, no `results.ndjson`, no `apk/`, no `a1-baseline/`. The profiles ARE the devices, so every device is new; the ledger is what made a verdict readable, so every old verdict is a claim with nothing behind it. |
| **The target is LOCAL** | 2026-09-03 | **`http://localhost:8081` - nginx, the BUILT estate**, not `https://canari-emse.fr` and not the vite dev server on 1420 (see the correction in section 5). Different origin, different cookie policy, a database that is a SNAPSHOT of production rather than production, and an object store that is EMPTY. |
| **Nothing deploys at a push** | 2026-09-03 | The mutual-exclusion rule is retired outright - see section 3. |
| **The accounts are new again** | 2026-09-03 | The rig restarts on fresh dedicated accounts, and the fixtures they own have to be built by hand once. |

**The board was reset to zero on 2026-09-03** and the old one archived. Read
[the archive](cross-client-testing-archive.md) when a re-run disagrees with itself - it says which
mechanisms held once, on which build - and never as a gate.

### The one correction this page owes, because it was the stated reason the rig could not move

It used to read: *"89 files name `canari-emse.fr` as a literal, with no central constant to
change"*, and concluded that pointing the rig elsewhere was out of reach. **The count was right and
the conclusion was not.** Measured 2026-09-02:

| | count | what it means |
|---|---|---|
| `https://canari-emse.fr` navigation literals | **0** | every navigation goes through `SITE` |
| bare `'canari-emse.fr'` occurrences | 120 | they are CDP **tab matchers**, matched by SUBSTRING |
| anchored comparisons (`startsWith`, `===`, `^`) | **0** | nothing requires the host to BE production |

**A count of occurrences is not a measurement of coupling**, and this page asserted the second from
the first. Pointing the rig is one line - `SITE` in the machine-local `names.mjs` - and that is what
made 2026-09-03 possible at all.

---

## 2. What LOCAL buys, and what it costs

**Buys.** A destructive row - HEAL, DEL, the revoke ladder - stops being able to damage anything a
real member depends on. Debris is cleared by restoring the dump again rather than by a `DELETE`
somebody has to be trusted with. A run cannot be voided by a deploy. And the estate can be broken
deliberately, which is what rung 18 CORRUPT has always wanted and never had.

**Costs, and each is stated on the row rather than assumed away.**

- **Local is production's DATA, not production's POPULATION.** It is a snapshot; `copy-prod-to-dev`
  truncates `push_token`; the MLS trees are whatever the local clients built. So the four population
  rows written into rung 12 MULTI measure the snapshot, and a `PASS` there answers "does the
  mechanism work", never "is production's estate sound".
- **The refresh cookie is not the same.** `ALLOW_INSECURE_COOKIES=true` flips
  `Secure; SameSite=None` to `SameSite=Lax` without `Secure` - decision 11 of the
  [workflow migration](workflow-migration.md), a documented reservation and not a defect, plain HTTP
  having no `Secure` cookie to send. A differing PORT is still same-site, so local is sound for what
  it measures; **a row whose question is about CROSS-SITE behaviour is measuring something else, and
  says so in its own cell.**
- **THE OBJECT STORE IS EMPTY, and `make dump-prod` does not fill it.** The dump copies the
  DATABASE; Garage starts with **zero objects**. So every avatar, every attachment and every post
  image that predates this estate answers 404 while its row in Postgres says it exists. Measured
  2026-09-04 on `/posts`, where it reads exactly like a broken media path. **It is not a defect and
  no row may report it as one** - a row whose question is about media uploads what it then reads,
  in the same pass.
- **FCM reaches no real device**, so every `+push` row needs the local estate given its own push
  credentials before it means anything.
- **The phone needs `adb reverse`, per device, and it does not survive a replug.** Neither phone can
  reach the workstation's `localhost` otherwise.

---

## 3. The mutual-exclusion rule is RETIRED, and what replaced it is closer to hand

It said a campaign run and a push to `main` could not overlap, because a push redeployed the server
under the run - three measurements died that way on 2026-08-27, two of them to DOCUMENTATION
commits. **Neither half survives**: a push deploys nothing since 2026-09-03, and a local run is not
on the path of any deploy at all. `gh run list` is no longer a precondition for a row, and the
dependency sweep no longer has to be disabled around a session - it dispatches CI, and there is no
deploy left for it to dispatch.

**What does the same damage now belongs to the workstation.** A `bun run dev` reload swaps the
bundle under the clients exactly as a deploy did; it happens on a SAVE, it takes no pipeline, and
there is nothing to watch the way `gh run list` was watched. **Do not edit the frontend during a
run.** `bundle.mjs` is the only thing that still catches it, and it does so because it was derived
from what a client is EXECUTING rather than from what happened upstream - a check written against
state kept working when its cause was replaced by a different one.

A `make run-services` or a container restart does the same to the backend, which `watch.mjs`
classifies as an ABSENT run rather than a failing one.

---

## 4. Bringing the rig up, from nothing

**The rig root moved to `../../canari-harness` on 2026-09-03** - one level further out than before,
so that nothing of the LITHIUM rig can be inherited by accident. Everything machine-local lives
there, and that split is structural rather than a policy: a credential outside the work tree cannot
be committed to a public repository at all.

| What | Why it cannot simply be recreated |
|---|---|
| `test-accounts.json` | the only copy of the logins and PINs - by design, they exist nowhere else |
| `names.mjs` | the display names, `SITE`, the CDP ports, `ACCOUNT_OF`, `VENUE` |
| `chrome-w1/`, `chrome-w2/`, `chrome-w3/` | **THESE ARE THE DEVICES.** A profile holds the session, the MLS identity (`mls_device_id_<userId>`, the IndexedDB state) and the enrolment. A fresh profile is a NEW device, which changes what a row measures |
| `results.ndjson` | the verdict ledger `rows.mjs` checks the board against |
| `apk/`, `a1-baseline/` | the debug APK under test and the phone's baseline |

**Two files stayed in the OLD directory on purpose**, `play-console-sa.json` and
`google-services.json`: they are store and build credentials rather than rig state, and other
tooling records their paths. Do not "tidy" them into the new root.

Inside the repo, `tools/cross-client-harness/names.mjs` must be the **two-line pointer**, not a copy
of the values - the shape is in `names.example.mjs`. Nothing else needs to know the split exists:
`STATE_DIR` has exactly three consumers.

Also needed: node 24+, `adb` on `PATH` for the A1 rows, and Chrome. **Verify before trusting
anything**, from `tools/cross-client-harness/`:

```bash
node -e "import('./names.mjs').then(n=>console.log(n.SITE, n.OWNER_NAME))"
bun rows.mjs     # fails loudly if the ledger and the board disagree
```

### The accounts, and the fixtures they do not have

Two ordinary Authentik users on `miconnect`, one `owner` (W1, W3, A1) and one `peer` (W2). **They
sign in through the SERVICE-ACCOUNT link** production's login page already has - the small
"Connexion externe (service-account)" button under the main OIDC button. It is
`PASSWORD_LOGIN_FLOW_SLUG = 'password-login'` in `frontend/src/lib/stores/auth.ts`, which sends the
browser to `/if/flow/password-login/?next=<authorize>`: identification + password + login, and
**no `AuthenticatorValidateStage`**.

- **There is no 2FA in the campaign.** The EMSE 2FA was never Authentik's - the `miconnect-auth`
  flow has `user_fields: []`, `password_stage: None` and `cas-emse` as its only source, so the main
  button federates to the school and the school asks. The service-account flow does not go there.
- **So losing a Chrome profile is cheap in TIME and expensive in MEANING**: a re-login is a username
  and a password, but a fresh profile is a new device with no history, so every HEAL row's
  precondition has to be rebuilt and any row whose verdict depends on an existing device must be
  re-run rather than trusted.
- Nothing is changed in Authentik's FLOWS and **production's main login page is untouched**. Two
  things beyond the users have changed on the identity provider, both on the `Canari Local` provider
  and neither touching production's client: the users themselves, and - on **2026-09-04** - the
  redirect URI `fr.emse.canari://callback`, without which a PHONE pointed at the local estate
  authenticates and is then refused at the last hop with Authentik's own "Redirect URI Error". It was
  added by hand in the admin shell and lives only in Authentik's Postgres, so **a restore from a
  backup predating 2026-09-04 brings it back missing**. What it is, why it does not weaken the
  local/production split, and how to re-add it are in
  [`infrastructure/authentik.md`](infrastructure/authentik.md#the-one-redirect-uri-a-mobile-client-needs-added-by-hand-on-two-providers),
  the only copy.

- **THE PHONE'S APK MUST CARRY THE `local-estate` CAPABILITY, and `bun a1apk.mjs` is what puts it
  there.** A debug build made any other way compiles capability `default` alone, whose fetch scope is
  `https://**`, and the phone then shows the product's own red
  `url not allowed on the configured scope: http://localhost:8081/...` under the PIN field - after a
  login that worked. It is a PRECONDITION of every A1 row on the local estate, not a symptom to
  diagnose.

**The accounts own NOTHING to begin with**: no DM, no `Canari Test Venue` community, no group under
test, no enrolled device. None of it needs a privilege - `POST channels/workspaces` is guarded by
`NginxAuthGuard` alone, so an ordinary member builds the venue. In order: log both in through the
service-account link, set each PIN from `test-accounts.json`, let W1 open a DM to the peer, create
the `Canari Test Venue` community with a `general` channel, then the group the DEL and HEAL rungs
use. **A row run before the fixtures exist opens nothing and then reports on whatever conversation
happened to be on screen** - which is the failure `names.mjs` exists to prevent, and the reason this
is a numbered step rather than an assumption.

---

## 5. The restart sequence

Everything below is in order, and nothing else goes first.

1. **Bring the local estate up and prove it ANSWERS**, because containers starting proves nothing:
   `make run-services`, then `curl -s http://localhost:8081/api/version`. That version is what every
   verdict from this session is stamped with.

   **THE ESTATE IS THE BUILT ONE ON `:8081`, NOT `bun run dev` ON 1420 (corrected 2026-09-04, after
   the campaign was pointed at the dev server first).** Three reasons, each measured that day:
   the dev server serves no `_app/version.json`, so `bundle.mjs` cannot read what a client is
   EXECUTING and the preflight has nothing to gate on - the one protection against a stale client;
   `SITE` has to be an origin the identity provider will redirect to, and each port is a separate
   redirect URI on the **`Canari Local`** Authentik provider, which is not the production `Canari`
   one; and a SAVE reloads every client, which section 3 already names as what replaced the deploy.
   Rebuild with `BUILD_WEB=1 npx vite build` in `frontend/`, then
   `docker compose ... build nginx && up -d nginx`, and reload the clients.

   **`frontend-ssr` must be RUNNING, and it was missing from the local compose file until
   2026-09-04.** Without it every navigation 502s into `@app_shell`, and the shell used to load no
   module at all on any route deeper than one segment - `/auth/callback` included, which is the login
   landing, so the campaign could not even log in. Both halves are fixed; if a client renders a blank
   page after a login, `docker compose ps` is the first thing to read.

   **`make run-services` passes `--env-file infrastructure/.env`, and a bare `docker compose up`
   does not.** Running compose without it recreates `garage` with no `GARAGE_RPC_SECRET`, which
   exits(1) on the spot and takes `nginx`, `media-service` and `social-service` with it. Use the
   Makefile target, or carry the flag.
2. **Seed the database from a production dump** (decision 5 - a full copy, PII included). A campaign
   against an empty schema measures an empty schema.
3. **Create the rig root and its `names.mjs`**, `SITE = "http://localhost:8081"`, and the two-line
   pointer inside the repo. **89 literals naming the production host were swept out of the rig on
   2026-09-04** so that this really is one line: `APP_TAB` / `APP_HOST` in `chat.mjs` derive the tab
   matcher and the cookie domain from `SITE`, and `psql` / `redis` in `ssh.mjs` pick a local `docker
   exec` or production's tunnel from it too - which is why a fresh device once read as `registered=false`
   while the rig was asking PRODUCTION about a device that only existed locally. The local Postgres
   superuser is `admin`, not `canari`; that follows `SITE` as well, and no flag selects it. Verify with the `node -e` line in section 4 before anything else.
4. **Create the accounts, log both in, set the PINs, build the fixtures** (section 4).
5. **`bun state.mjs`** - the clients, what they are logged into, and what they are running.
6. **`bun rows.mjs`** - the board against the ledger. Both are empty now, which is the one time
   that agreement means nothing; run it anyway, because the first disagreement is the one worth
   catching early.
7. **If the phone is in play**: `adb reverse` first, per device, and again after any replug. The
   from-zero sequence is scripted end to end in
   [the harness README](../../tools/cross-client-harness/README.md#operating-it). The APK EMBEDS its
   frontend, so a row whose question is not skew needs it rebuilt and installed.
8. **Re-measure the device cap around the run.** It is re-measured, never quoted.

---

## 6. What none of this changed about a verdict

- **The logs are read on every pass, the reconciliations especially** (user, 2026-08-28). A heal
  that works is not a heal that was observed; reading them has since found one P1 no row asks about
  and turned one `FAIL` into another.
- **Expected noise is dispositioned per row** with `ignoringExpectedLog`, never with a wider
  classifier.
- **No HEAL-REVOKE verdict about a clean device may be taken on a build older than 0.14.12.**
- **A precondition is not ambient**: the quick-reply window must be ARMED, and an unarmed run proves
  nothing at all.

---

## 7. What is still blocked, and what is not

**Blocked on hardware** - the whole list, each row with what would arm it, is
[the verification table at the top of backlog](backlog.md#owed-a-verification-and-nothing-else).

**Takeable with no device**, and worth doing while the rig is being built:

- the four population rows written into rung 12 MULTI (7-10), which need only `W1 W2` - **though on
  local they now measure a snapshot, and the row says so**
- the second iPhone that acquires no push token and reports nothing, diagnosable with no phone
- **the P1 livelock of 2026-09-01 - its half (A) is FIXED, 2026-09-04, and what is left is a row.**
  `pending` no longer decides on its own: the endpoint answers with `welcomeQueued` and `addInFlight`
  per row, and a device owed nothing joins itself. It was reproduced on this estate and measured
  twice green with no phone at all. **What no row yet asks** is the `[KICK]` arm - a device the
  repair is actively kicking is still reset to `pending` before the Add is known to land, so it can
  now escape between turns but the write order is unchanged. That row needs `W1 W2 W3` and nothing
  else.

---
