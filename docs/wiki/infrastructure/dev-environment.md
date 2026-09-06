# The dev environment (`dev.canari-emse.fr`)

A second, complete Canari estate, running on the SAME machine as production, reachable at
`dev.canari-emse.fr`. Its purpose is to be the place where a change can be observed before members
see it - and, specifically, to be the only honest rehearsal ground for the class of failure that took
production down on 2026-09-01, when an auto-merged `postgres 15-alpine -> 18-alpine` refused
production's data directory.

This page is the only copy of how the environment is put together. The decisions behind it - taken
with the user on 2026-09-01 and marked not to be re-litigated - are in
[backlog](../backlog.md); the merge-ceiling half is on [cicd](../cicd.md); the cookie half is on
[sessions](../sessions.md).

**THE ESTATE IS LIVE.** Since 2026-09-02, `https://dev.canari-emse.fr` serves the dev estate and
nothing else. Four statements were taken together, and each answers a different question:

| Measurement | What it settles |
| --- | --- |
| `https://dev.canari-emse.fr/api/version` -> `build: "dev.6c94f20"` | the name reaches DEV, and the request went through the database |
| `https://canari-emse.fr/api/version` -> `build: null` | production is untouched and still reports no build, by decision |
| 11 of 11 containers up in project `canari-dev` | nothing is crash-looping behind the name |
| the permanent "Environnement de test" banner renders on dev and NOT on production | a human cannot mistake one for the other, which matters because dev holds a real copy |

`vars.DEV_ENVIRONMENT_ENABLED` is `true`, so every dev job runs and **a failed dev deploy blocks
production's** - that is the ordering's whole point, and `gh variable set DEV_ENVIRONMENT_ENABLED
--body false` is the escape. Every default in this file is still chosen so that ABSENCE reads as
production.

---

## 1. What keeps it apart from production

Two independent mechanisms, and the distinction matters because only one of them is enforced by
Docker.

**By compose project - structural.** The estate is deployed as the compose project `canari-dev`
against [`infrastructure/docker-compose.dev.yml`](../../../infrastructure/docker-compose.dev.yml);
production is the project `infrastructure`. A compose project gets its own network and its own named
volumes, so a dev container cannot resolve a production service by name and cannot mount a
production volume. This is not configuration a value can get wrong.

**AND UNTIL 2026-09-01 THE SENTENCE ABOVE WAS FALSE, WHICH IS THE WORST DEFECT THIS FILE HAS HELD.**
A compose project with no top-level `name:` is named after the DIRECTORY its file sits in - and both
deployed compose files sit in `infrastructure/`. Neither declared one. So the dev file, run the
obvious way with `-f` and no `-p`, would have joined production's project: dev's `postgres_data`
resolves to `infrastructure_postgres_data`, which is production's live database (measured on the
server: `infrastructure_postgres_data`, `infrastructure_redis_data`, `infrastructure_garage_data`),
and dev's network to production's network. The isolation was one forgotten flag away from being
nothing at all, and "pass the right flag" is not a property of a system - it is a thing somebody
remembers. Both files now carry their own `name:`, production's pinned to the value it already has
so that moving the checkout can never rename the project and orphan every volume.
`compose-wiring.test.sh` asserts that each deployed file declares one and that no two agree.

**By value - conventional.** Every `${...}` in the dev compose file is filled from the dev
environment's own secrets: its own `JWT_SECRET` (so a token minted by one environment is refused by
the other), its own Garage keys and bucket, its own Authentik client. Beyond those, the file is
deliberately identical to production, so that a difference in observed behaviour is never explained
away by a difference in configuration.

### The isolation is per PROJECT, not per HOST - one daemon carries both estates

Neither mechanism above separates the two estates from anything the *host* does to Docker. **They
share one daemon, and 23 containers across two projects go down together when it restarts.**
Measured 2026-09-02: an `apt-get upgrade` on the box pulled 12 `docker`/`containerd` packages, which
restarted the daemon, which restarted every container in both projects at once - all 23 came back
`Up 27 seconds`, and the public site returned `502` for about thirty seconds in between.

This is not an argument against the upgrade, and nothing here needs changing. It is a limit on what
the two mechanisms above claim: **dev cannot corrupt production's data, and dev cannot take
production down - but the host can take both down in one gesture, and no compose-level property
prevents that.** Anything that reasons "the dev estate is isolated, so operating on it is safe"
must exclude host-level operations from that sentence. The consequence for scheduling unattended
host upgrades is in [backlog](../backlog.md#p2---mostly-closed-2026-09-03-the-hosts-take-their-security-updates-and-a-daily-run-reports-it-what-is-left-is-three-hosts-nobody-reports-on-and-a-library-nothing-restarts).

### The two host ports that differ, and why only two

Production publishes **no** host port for any internal service - it uses `expose:`, which is
container-side only. So there is nothing for a second project to collide with, and the offsets the
first version of this file carried were unnecessary. Exactly two bindings differ:

| | production | dev | why it is published at all |
|---|---|---|---|
| `frontend` | `8080`, on all interfaces | `3080`, loopback only | the cloudflared tunnel reaches Nginx through the host |
| `garage` API / admin | `19010` / `19011`, loopback only | `19100` / `19101`, loopback only | tooling (`garage` CLI) attaches from the host |

Two details the compose files do not say plainly. Production's frontend port is `8080` on the BOX but
`${FRONTEND_HOST_PORT:-80}` in `docker-compose.prod.yml` - the value comes from the generated `.env`,
so reading the file alone gives `80`. And production binds it on every interface while dev binds it
to `127.0.0.1`; dev is the stricter of the two, deliberately, since nothing but the tunnel has any
business reaching it.

**ALL THREE ARE `computed` MANIFEST ROWS, AND THAT IS THE ONLY DISPOSITION THAT WORKS HERE.** The
first bootstrap could not bind any of them, because `deploy.yml` had set them in dev's `.env` with an
"add if missing" default - `grep -q '^FRONTEND_HOST_PORT=' .env || echo FRONTEND_HOST_PORT=3080` -
which can never fire: `render-env.sh` COPIES `infrastructure/.env.example` and then upserts the
manifest rows over it, and the template declares all three keys with production's values. Dev
therefore asked for `8080`, `19010` and `19011`, the ports production's own containers hold on the
machine both estates share. A `computed` row runs inside the render, before the template can decide,
so it is the only place a per-estate port can be set. The test that covers it renders BOTH
environments and asserts the RENDERED value - the previous one compared the four DECLARATIONS to
each other and they agreed, unanimously and wrongly, the deciding value living in a fifth file none
of them was compared against.

**A CONTAINER-SIDE ADDRESS IS NEVER OFFSET.** The version of the dev compose file replaced on
2026-09-01 had never worked, for exactly this reason: it applied the host offsets to the container
addresses too - `redis://redis:6380`, `postgres://...@postgres:5433/auth_db`,
`http://core-service:3112`, `DB_PORT: "5433"`. Inside a compose network a service answers on the
port it LISTENS on; the number left of the colon in `ports:` exists only on the host and is
invisible to peers. Every one of those URLs pointed at a closed port.
[`compose-wiring.test.sh`](../../../.github/scripts/tests/compose-wiring.test.sh) now derives the
service list from the compose file itself and fails if any internal URL names a port the target does
not listen on.

### Resource ceilings, not reservations

`x-dev-limits` caps every dev container at 1 CPU and 768 MB. Dev shares a host with production, and
the point of the cap is that a dev container which misbehaves cannot starve the estate real members
use. It is a ceiling deliberately, not a reservation: dev must never hold capacity production is
short of.

---

## 2. Dev runs in production mode, and that is the whole point

Six services in the dev compose file set `NODE_ENV: production` - the four NestJS ones plus
`frontend` and `frontend-ssr` - and each is PINNED there rather than inherited from `.env` the way
production allows. Dev is a live HTTPS environment behind the same tunnel and the same Nginx as
production; running it in development mode would make it a different program, which defeats the
reason it exists.

That has one consequence worth stating, because it was a defect before it was a rule. The refresh
cookie's `Secure` and `SameSite` attributes used to be chosen per request, by sniffing the `Origin`
header - so an environment that forgot to declare itself would have issued the refresh cookie
without `Secure` over HTTPS. The attributes are now a deployment fact, read once at construction
from `ALLOW_INSECURE_COOKIES`, which has **no default**: with `NODE_ENV=production` the value `true`
is a startup ERROR, and with any other `NODE_ENV` an unset value is also a startup error. The only
place `true` belongs is [`infrastructure/local/docker-compose.yml`](../../../infrastructure/local/docker-compose.yml),
the plain-HTTP local stack. The reasoning is on
[sessions](../sessions.md#the-cookies-own-attributes-are-a-deployment-fact-not-a-per-request-one).

---

## 3. The data: a full copy of production, the two things it strips, and the one it will not

[`infrastructure/dev/copy-prod-to-dev.sh`](../../../infrastructure/dev/copy-prod-to-dev.sh) dumps
production's `auth_db`, restores it over dev's, strips what must not travel, and then VERIFIES rather
than asserting.

**Why a full copy.** Decided with the user against the recommendation, for usability: an empty dev
environment is one nobody can log into or interact with meaningfully. Two facts were put to the user
first and did not change the decision - the server holds only ciphertext, so copied conversations are
UNREADABLE on a fresh dev client (the MLS keys live on the device, the media CEK is
client-generated), and login ease comes from the Authentik directory rather than from this database.
So the copy buys realistic users, communities, posts, forms, calendar and shop, and nothing at all
for chat.

**What it does NOT buy is the ceiling's evidence, and an earlier version of this paragraph said it
did.** The claim was that the copy leaves "a dev Postgres holding a data directory really written by
production's 15". It does not: `pg_dump` reads rows and the restore writes a NEW cluster, initialised
by whatever major is running in dev. The one thing a major upgrade must survive - production's own
`PGDATA` on disk - is precisely what a logical copy never produces. See section 4.

**The direction cannot invert, and that is enforced rather than documented.** Every destructive
statement goes through `dev_sql()`, which re-reads the target container's
`com.docker.compose.project` label and refuses unless it is exactly `canari-dev`. The two project
names are hardcoded constants, not parameters, so there is no argument a caller can pass to point the
script at production - an ALLOWLIST of what may be written to, which is what a destructive control
needs. Containers are found by compose LABEL and the database user is read from the container's own
environment, so the script needs no compose file, no `.env` and no path to be correct.

**The strips**, each reporting what it changed, because the failure mode of this block is an absence:

| | what | why |
|---|---|---|
| (a) | `TRUNCATE push_token` | the rows belong to production's FCM sender and to real devices. A shared sender would deliver a test notification to a member's phone; a dev sender rejects every row, which is 70-odd logged failures per send |
| (b) | 7 payment columns across 4 tables | there is no Stripe and no Lydia in dev at all, so each is a live identifier with no credential behind it. It is seven, not the five the plan first named, because `associations` carries a Lydia pair beside the Stripe pair |
| (c) | `platform_config.payment_provider` left ALONE | its type is `'stripe' \| 'lydia'` with no third value, so nothing can say "payments are off". Writing anything else would contradict what the code asserts about the column |

(c) is a recorded gap, not an oversight: dev presents Stripe as the live provider and fails on use.
That the platform cannot declare payments disabled is in [backlog](../backlog.md).

[`dev-copy-guards.test.sh`](../../../.github/scripts/tests/dev-copy-guards.test.sh) DERIVES the
column list in (b) from the entity declarations and fails if a payment column is added without being
stripped, so a schema change cannot disarm the step silently.

---

## 4. The version gap, and the one kind of evidence that lifts a ceiling

Dev is the environment where a major version is allowed to run ahead of production, and
[`infrastructure/dev/version-gap.yml`](../../../infrastructure/dev/version-gap.yml) is where that
gap is DECLARED. The auto-merge ceiling reads it: a stateful image whose major bump is refused for
production has that refusal retired only by a row here recording the rehearsal.

**A green dev deploy is NOT that evidence**, and this is the correction that matters most on this
page. The copy above is a `pg_dump`/restore, so a new major initialises its own cluster from empty
and structurally CANNOT fail the way production failed on 2026-09-01. Accepting a green dev deploy as
proof would have re-armed that 33-minute outage behind a gate that reads as a proof. Hence four
`evidence` values, of which only `in_place_upgrade` - the new major started on a BINARY copy of
production's `PGDATA` - lifts anything. The table is on
[cicd](../cicd.md#a-refusal-is-retired-by-a-declared-gap-in-dev-and-exactly-one-kind-of-evidence-counts),
the only copy.

All three rows read `evidence: none` today. [`dev-gap.test.sh`](../../../.github/scripts/tests/dev-gap.test.sh)
derives the row set from production's compose file, holds each declared major against both compose
files, and asserts the ceiling's verdict agrees with the row.

---

## 5. How a dev deployment identifies itself

Two variables, and the split between them is deliberate.

**`VITE_DEPLOY_ENVIRONMENT`** - build-time, frontend. `development` or `dev` renders a permanent,
non-dismissible "test environment" banner
([`EnvironmentBanner.svelte`](../../../frontend/src/lib/components/shared/EnvironmentBanner.svelte)).
It is build-time so the banner is up before the first request and stays up when the API is
unreachable; it is not derived from the hostname because a hostname rule needs editing for every name
added and cannot answer at all for the mobile app, whose origin is `tauri://localhost` in every
environment. **Unset means production, and so does any value nobody planned for** - the failure mode
of a missing or misspelt variable is then a MISSING banner on a test box, which whoever is looking at
it can see, rather than a banner shown to every member of production. An unrecognised label is never
rendered raw, because the text is localised.

The banner cannot be dismissed, and that is the point: dev carries a full copy of production, so it
is indistinguishable from production on screen. A banner that could be closed would be closed in the
first session and never seen again.

**`DEPLOY_BUILD`** - runtime, backend. Reported by `/api/version` as its own field, `build`, beside
`version`. **It must never be folded into `version`.** Clients DECIDE on that field: `compareSemver`
parses it, `releaseTag` turns it into `vX.Y.Z`, and `getReleaseApkDownloadUrl` builds a GitHub
download URL from it - so a `version` of `0.14.15+dev.abc1234`, which is how the plan first described
this, would have offered every dev client an update from a tag that does not exist, i.e. a 404 behind
the update button. A build identity is REPORTING; a version is DECIDED on.
[`version.service.spec.ts`](../../../apps/core-service/src/version/version.service.spec.ts) asserts
`version` stays a bare semver while `build` carries the suffix.

Both variables are now written by the pipeline: `serve-dev.yml` passes `--build dev.<sha7>` to
`render-env.sh`, which writes `DEPLOY_BUILD` for dev and, by decision, nothing for production. **So a
non-null `build` IS dev**, and that is the cheapest statement anyone can make about which estate a
name is serving.

**IT WAS NOT, UNTIL 2026-09-02, AND FOUR TESTS COULD NOT SEE WHY.** The renderer computed it, the
manifest declared it, [`deploy-build.ts`](../../../apps/core-service/src/platform/deploy-build.ts)
parsed it, `version.service.spec.ts` covered it - and **neither compose file passed it into any
container**, so `/api/version` answered `build: null` on dev exactly as it does on production. The
whole chain was tested end to end except its last link, and the value was about to be used as the
proof that the tunnel had been moved onto dev - a proof it could never have given. `core-service` is
what serves `/api/version`, so it is the service that must receive the variable; `deploy-env.test.sh`
now reads the `core-service` block out of BOTH compose files and demands it. The general form is in
[durable-rules](../durable-rules.md): a rendered value nothing consumes does not exist, and agreement
among the producers says nothing about the consumer.

---

## 6. What is deliberately absent

| | state | why |
|---|---|---|
| Stripe / Lydia | no credentials, identifiers stripped | user, 2026-09-01: dev will not reach Stripe for now |
| Push notifications | PERMITTED, no dev credentials yet | not a decision, just an absence: both halves are `warn`, so dev sends nothing until a credential is given. Nothing has to be CREATED for it - see below |
| Mobile builds | phase 2 | a dev keystore and a dev bundle identifier are prerequisites, and they are the real blocker - not the push credentials |
| A `dev` branch | none - it existed for one day and was deleted 2026-09-03 | there is one branch. What reaches this estate is a `X.X.X-alpha.N` PRE-RELEASE published from it, and a run deploys exactly one estate - see the section on the pre-release target below |

**Push is the one row that changed its mind, and the reason is worth keeping.** The three APNs values
were first written `skip` alongside Stripe and Lydia, on the reading that a dev estate holding a copy
of production could ring a real member's phone. It cannot, and the guard is not the missing
credential: `copy-prod-to-dev.sh` does `TRUNCATE TABLE push_token` before the restore, asserted by
`dev-copy-guards.test.sh`, so dev holds no real device's token to send to. The manifest made the
inconsistency visible by putting the two halves of push on adjacent lines - Android `warn`, iOS
`skip`, one threat model, opposite dispositions - and `deploy-env.test.sh` now locks them EQUAL
rather than locking either value, so the next person to move one has to move both.

`skip` means something narrower than "absent from dev": a credential whose USE reaches a third party
that believes it is talking to production. Stripe charges a card, Lydia moves money, `CERCLE_API_KEY`
makes another estate answer as though production asked. Push reaches devices this estate does not
know about, which is a different sentence.

**AND NOTHING HAS TO BE CREATED AT FIREBASE FOR DEV** (asked by the user, 2026-09-02). There is no
web push in this app: the only file under `frontend/src` that mentions Firebase is
`androidFcmManifest.test.ts`, a manifest assertion - no VAPID key, no FCM `getToken()`, no push
handler in a service worker. Push exists exclusively in the native Tauri builds, and mobile is
phase 2, so on the web-only dev estate a Firebase project would be dead weight;
`FIREBASE_SERVICE_ACCOUNT_JSON` is `warn` for both estates and is not among the 14 `required`, which
is why the first dev deploy came up without it. **If push is ever wanted on dev, the blocker is not
Firebase but the IDENTIFIER**: the app has exactly one bundle id, `fr.emse.canari`, in
`tauri.conf.json`, the Android `applicationId`/`namespace` and both iOS targets, so a dev build
would REPLACE production's app on a device rather than sit beside it - that, not a project
registration, is the expensive part. Production's own credential could then be handed to dev as
`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` without risk, for the same reason the APNs rows are `warn`: the
copy truncates `push_token`, so dev has no production device to reach. An APNs auth key is issued
per Apple TEAM rather than per app, so it needs no new key either.

---

## 7. The tests that hold this together

Run by `make test-ci-scripts`, which is a CI job:

| suite | what it derives, so omission cannot pass |
|---|---|
| [`compose-wiring.test.sh`](../../../.github/scripts/tests/compose-wiring.test.sh) | the service list and its listening ports from the compose files; the NestJS app list from `apps/*/package.json` declaring `@nestjs/core`, each of which must set `NODE_ENV` |
| [`dev-copy-guards.test.sh`](../../../.github/scripts/tests/dev-copy-guards.test.sh) | the payment columns from the entity declarations |
| [`dev-gap.test.sh`](../../../.github/scripts/tests/dev-gap.test.sh) | the row set from production's compose file's named stateful images |
| [`ceiling.test.sh`](../../../.github/scripts/tests/ceiling.test.sh) | the stateful image names from `docker-compose.prod.yml` |
| [`deploy-env.test.sh`](../../../.github/scripts/tests/deploy-env.test.sh) | the expected `.env` key set from `deploy.yml`'s own `upsert_env_var` calls, and the dev secret list from the manifest - it also asserts that `deploy-dev` references no production secret by its bare name |

Every one of them reads its subject from a source of truth rather than a hand-written list, for the
same reason: the failure mode of a guard list is an ABSENCE, and an absence in a hand-written list
passes silently.

---

## 8. How it is deployed

One workflow, `serve-dev.yml` - its own file since 2026-09-07 - and a second that refreshes the data.
Both are gated on `vars.DEV_ENVIRONMENT_ENABLED == 'true'`, a repository VARIABLE rather than a
secret so its value is visible in the run log - whether a second estate is being deployed is not a
secret, and a silent gate is one nobody can debug.

| job | where | what it does |
|---|---|---|
| `build-frontend` | GitHub runner | builds the frontend from the `DEV_*` secrets when the release is a PRE-RELEASE, with `VITE_DEPLOY_ENVIRONMENT=development` |
| `build-docker-images` | GitHub runner | pushes every changed image, moving `:dev` rather than `:latest` |
| `deploy-dev` | the server | renders `.env`, then runs [`deploy-environment.sh`](../../../infrastructure/deploy/deploy-environment.sh) |
| `refresh` in [`scheduled.yml`](../../../.github/workflows/scheduled.yml) | the server | weekly, copies production's data into dev |

**`build-frontend-dev` and `build-frontend-images-dev` were DELETED.** They were a near-identical
copy of the production frontend build, and they existed only because one push used to deploy both
estates at once. A CD run deploys exactly one estate now - a pre-release goes to dev, a stable to
production - so the single build picks the estate's secrets and the single image job moves the
estate's tag. The duplication was never harmless: the two had drifted, and the
`VITE_DEPLOY_ENVIRONMENT` banner lived in the dev copy with nothing saying so.

### Two images are dev's own, and every other one is shared

A backend image reads its whole configuration from `.env` at runtime, so dev runs production's
`latest` backend binaries. That is a feature and not a shortcut: it means a difference in behaviour
between the two estates can never be explained by a different build, which is the only thing that
makes a test environment worth having.

The frontend is the exception, because SvelteKit inlines `import.meta.env.*` at BUILD time - the API
origins, the Authentik client id and the `VITE_DEPLOY_ENVIRONMENT` that raises the banner are all
baked into the bundle. A shared frontend image would point dev's browser at production and show no
banner. So the dev compose file reads `${FRONTEND_TAG:-dev}` for its two frontends and `${TAG}` for
everything else.

**BOTH ARE `dev` SINCE 2026-09-03, AND THE BACKEND IMAGES STOPPED BEING SHARED BY TAG.** Sharing
production's `:latest` was right while one push deployed both estates from ONE commit; a pre-release
and a stable are different commits now, so `latest` belongs to whichever stable shipped last and dev
would have been reading a build it never asked for. The images are still built from the same
Dockerfiles and still configured entirely from `.env` - what changed is only which tag each estate
follows.

`dev` is a mutable tag, like production's `latest`, which is why the deploy PULLS before it brings
the estate up: `up -d` alone sees no reason to recreate a container whose tag has not changed. It is
also why a service a release does not rebuild keeps the image it has - that is what a selective
rebuild means, and it is why the change detector's baseline must be the previous PRE-RELEASE and not
the previous release of any kind ([cicd](../cicd.md#build-and-deploy-an-estate-buildyml-serve-devyml-serve-prodyml)).

### The deploy is two scripts, and the order is load-bearing

[`render-env.sh`](../../../infrastructure/deploy/render-env.sh) runs FIRST and resolves every key
before writing anything. A missing required secret fails there, with the previous dev deployment
still up, rather than starting a half-configured estate. Only then does
[`deploy-environment.sh`](../../../infrastructure/deploy/deploy-environment.sh) touch a container.

**The isolation is an indirection, not a document.** A manifest row says `secret:JWT_SECRET`;
production reads `JWT_SECRET`, dev reads `DEV_JWT_SECRET` and never the bare name. So a dev secret
nobody created is EMPTY rather than production's value, and a `required` row then refuses the deploy.
GitHub environment-scoped secrets would have failed OPEN here - a forgotten dev secret resolving
silently to the repo-level production value - which is exactly what the deleted `cd-dev.yml` did.

**The required-service gate is inverted relative to production's.** `deploy-environment.sh` derives
the list from the compose file and exempts only what is named in `NON_CRITICAL` (`adminer`). The
workflow it replaces named ten services by hand, and that shape is the defect: on 2026-09-01 it named
seven application services and none of the three datastores, and `frontend-ssr` was in NEITHER
version - so an estate whose server-side renderer never came up would still have deployed green.

**And it health-checks `/api/version`, which production's deploy does not.** Every other check passes
with the database on the floor: nginx answers `/`, and the two liveness routes are deliberately
anonymous. `/api/version` reads the database, so it is the cheapest end-to-end statement that the
estate is really serving - the exact statement missing during the 33-minute outage of 2026-09-01,
throughout which the frontend answered 200.

**THE FIRST BOOTSTRAP CREATED AN EMPTY DATABASE, AND THE MIGRATION STEP REPORTED SUCCESS.** Measured
2026-09-02. `apply_migrations` walks `apps/*/src/migrations/*.sql` from a here-string and asks the
`schema_migrations` ledger about each file before applying it - and `psql` in this script is
`docker compose exec -T postgres psql`, which ATTACHES AND DRAINS STDIN whatever arguments follow.
The first iteration read one filename, the ledger query swallowed the other seventy-nine, and `read`
met EOF: `migrations: 1 applied, 0 already recorded` against 80 files on disk. What surfaced was not
a failed migration but a SCHEMA-LESS DATABASE - `core-service` and `chat-delivery-service`
crash-looping on `relation "platform_config" does not exist` and `relation "key_package" does not
exist`, with postgres, redis, garage and both frontends healthy beside them. The loop reads on fd 3
now, and `deploy-migrations.test.sh` asserts the OUTCOME against a stdin-draining `psql` stub rather
than the shape of the loop.

**This is the second half of why production is still on its inlined shell.** The split was written as
"one implementation, proven before it is imposed", and the estate that met the defect was the one
that could afford it. It also says something about the order of the steps: `up -d` starts the
services BEFORE the migrations run, so a virgin database always produces a burst of crash-looping
application containers, and the readiness gate that follows is what distinguishes "still catching
up" from "will never come up".

**AND FIXING IT EXPOSED THE LAYER UNDERNEATH: THE MIGRATION SET IS NOT A SCHEMA.** With all 80 files
attempted, the same deploy died on the second one - `002_drop_group_member_left_at.sql` ->
`relation "dm_group_members" does not exist`. **No file in this repository creates that table.**
TypeORM does, through `synchronize: process.env.NODE_ENV !== 'production'`, which every service
therefore disables on BOTH estates. Only 14 of the 80 files contain a `CREATE TABLE`, and a
derivation over the set names 21 tables it `ALTER`s and never creates (`users`, `platform_config`,
`posts` among them). So the schema arrives from somewhere else on each estate: production's from an
ORM boot long ago, **dev's from the copy**. It is not an ordering problem - no permutation of deltas
builds a table no delta creates.

### A virgin dev estate is SEEDED, not migrated - and this is the order

1. **Deploy.** `render-env.sh`, then `up -d`. Postgres, redis and garage come up healthy; the
   application services crash-loop on the empty database, which is expected.
2. **`apply_migrations` REFUSES, and names the remedy.** `require_orm_schema` asks
   `to_regclass('public.dm_group_members')` once, before touching any file, and on dev prints
   `seed it first: run the "Refresh dev.canari-emse.fr from production" workflow`. On production the
   same absence prints that the schema is GONE and not to deploy. This is the
   "never learn by failing what a fact could have told you" rule applied to a deploy: the
   discriminator is known before the loop, so it belongs before the loop.
3. **Run [`scheduled.yml`](../../../.github/workflows/scheduled.yml).** It restores production's
   full `pg_dump` (`--clean --if-exists`), so schema, data AND `schema_migrations` arrive together -
   every delta is already recorded and the next deploy applies only what is genuinely new. It then
   brings the containers back and proves `/api/version` itself.
4. **Deploy again.** The migration step now finds a schema and applies whatever prod has not seen.

Measured on the first real bootstrap, 2026-09-02: 355 users copied, dump 20 MB, restore 2 s, push
tokens truncated and Stripe identifiers cleared, `copy verified`, and dev answered
`/api/version` on `127.0.0.1:3080` with **11 of 11 containers up** where two had been crash-looping.

**The sentinel is pinned by DERIVATION, not by hand.** `deploy-migrations.test.sh` computes the set
of tables the migration files reference and never create, and fails if `dm_group_members` ever leaves
it - so a future migration that creates the table forces a new sentinel instead of quietly leaving a
guard that passes on an empty database.

**One correction to the refresh workflow came out of the same session.** Its closing gate proves the
estate answers `/api/version`, which is right for a restore and meaningless for `--dry-run`: the
first dry run passed every guard, printed `[dry-run] nothing was changed`, then failed on twenty
502s from the schemaless database it had deliberately not touched. A step that measures an outcome
belongs behind the condition that produced it.

### Dev is the PRE-RELEASE target, and the `dev` branch it used to deploy from is gone

For one day (2026-09-02) there was a `dev` branch: it deployed this estate, and `promote-dev-to-main`
fast-forwarded `main` onto it once the estate had ANSWERED `/api/version` as that commit. The user
cancelled that model the following day - `main` is the only branch, work goes through pull requests,
and **nothing deploys until a release is published**.

**The shape now.** One branch, two kinds of release:

| The release | What it deploys | What else it feeds |
| --- | --- | --- |
| `v0.15.0-alpha.1` (pre-release) | `dev.canari-emse.fr` only | Play *internal* track, TestFlight |
| `v0.15.0` (stable) | production only | Play `production` track |

`scheduled.yml`'s `dev-refresh` job still copies production's data in every Monday, so an alpha meets
production-shaped data. What dev is FOR changed with the model: it was a rehearsal stage every
change passed through, and it is now where a tester build points.

**WHAT WAS LOST, stated because it was real and because a later session must not "restore" it by
accident.** The promotion was an automatic proof, on a copy of production's data, that a commit
serves before production is given it - it probed `/api/version` on the loopback and required `build`
to be `dev.<sha7>` of the commit in question, so PG 18 refusing a data directory, a migration that
would not apply or a container that restart-looped all failed it and production was never told the
commit existed. A pre-release provides that only when somebody publishes one. **The trade the user
chose is a human deciding when the rehearsal happens**, in exchange for one branch and no queue.

The two defects that model was answering are worth keeping, because they say what NOT to rebuild:

- **Dev was given nothing to protect.** A dependency update was merged onto `main` and `main` was
  already what production deployed; dev running first only narrowed the window. The measurement is
  the outage of 2026-09-01 - `postgres 15-alpine -> 18-alpine` auto-merged green, PG 18 refused
  production's data directory, 33 minutes down. **That specific hazard is now held off by the fact
  that a merge deploys nothing at all**, not by an ordering.
- **Dev could hold production hostage for reasons of its own.** A registry that timed out pulling
  `frontend:dev` failed `deploy-dev`, and `deploy-to-server` needed it (run `33633156004`). The two
  arms deploy different commits now and neither waits on the other, so this cannot recur.

### Its own checkout, and its own deployed tag

The dev estate is deployed from `/home/canari/canari-dev`, a separate clone, because two estates
sharing one working tree would race: a `git reset --hard` for one rewrites the compose file the other
is being deployed from. `deploy-dev` creates that clone if it is absent, so the starting point is
reproducible rather than a directory somebody once made differently.

It records `dev-deployed`, and that tag answers a question the estate itself cannot: which commit
is running here. It is no longer the change detector's input - the detector reads the previous
release now - and its production counterpart was renamed `prod-released` for the same reason, so
that nobody reads a stale meaning into either.

---

## The three blocking steps the user took, and the three capabilities dev still does without

The tracked items live in [backlog](../backlog.md); this is the map. **Nothing here blocks the
estate any more** - the three steps that did are numbered below, each recording HOW, because the
how is what a rebuild would need. What remains is three capabilities dev deliberately does
without.

**Still owed, and NOT blocking the estate** - each buys one capability dev does without:

- the Cloudflare Access service token for the harness (needs `Account -> Cloudflare Tunnel` plus the
  two account-scoped Access permissions); without it the campaign rig cannot drive dev - which costs
  nothing today, the rig naming `canari-emse.fr` as a literal in 89 files and so targeting
  production regardless
- a dev APNs key, for push. **FIREBASE OWES NOTHING** (settled with the user 2026-09-02): dev reuses
  the existing `fr.emse.canari` Firebase app, so `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` is not a new
  project. Both push rows are disposition `warn` in the manifest, so their absence has never blocked
  a deploy - dev simply sends no notifications
- a dev Android keystore, and where it is backed up; mobile is phase 2

**The CD wiring is DONE** (2026-09-01), and it is section 8. `cd-dev.yml` is gone, deleted ahead of
the unification rather than with it: its `push: branches: [dev]` trigger could never fire, but its
`workflow_dispatch` could, and it read PRODUCTION's secrets - the same `JWT_SECRET`, the same Garage
keys, the same `canari-media` bucket - which is precisely the isolation this environment exists to
have. It was never a useful reference for the dev arm either, having never worked; recover it from git
if ever needed (`git show a8ac1828:.github/workflows/cd-dev.yml`).

**ALL THREE ARE DONE. The list is kept because each one records HOW, and the how is what a rebuild
would need.**

1. **The tunnel INGRESS rule: DONE 2026-09-02**, `dev.canari-emse.fr` -> `http://localhost:3080`
   (it had pointed at production's `8080`, which is why the name served production until that
   moment). Performed through the API, and the shape is the reusable part: GET
   `/accounts/{acct}/cfd_tunnel/{tunnel}/configurations`, **save the whole config to a file first**,
   mutate the ONE rule whose `hostname` matches, refuse if it matches zero or several, PUT the whole
   config back, then GET again and read every rule to prove the other six are byte-identical.
   **It was moved LAST, and that order is not a preference**: the same name is a proxied CNAME onto
   production's tunnel, so moving it before a dev deploy had been proved on `127.0.0.1:3080` would
   have turned a name serving production into a 502. The proof that unlocked it was a green
   **deploy** (the refresh alone proves only the port), read as `build: dev.<sha7>`.
2. **The `DEV_*` repository secrets. 12 of the 14 required ones were created on 2026-09-02** - the
   three derived ones (`DEV_AUTHENTIK_URL`, `DEV_BASE_URL`, `DEV_POSTGRES_USER`) and nine generated
   with `openssl rand`, none copied from production, plus `DEV_INTERNAL_SECRET` and
   `DEV_EXTERNAL_API_KEY`. The generated values exist in GitHub Secrets and, once dev has deployed
   once, in `/home/canari/canari-dev/.env` on the box; they are written nowhere else on purpose.
   **`DEV_AUTHENTIK_CLIENT_ID` and `DEV_AUTHENTIK_CLIENT_SECRET` were the last two and are DONE**
   (2026-09-02), against the `canari-dev` client created on the same Authentik instance. Of the
   optional rows, 9 are
   named in a deploy warning and 3 are silent because a default answers for them. The list, with
   what each absence costs, is
   [`infrastructure/deploy/env-manifest.tsv`](../../../infrastructure/deploy/env-manifest.tsv) -
   every row whose DEV column is not `skip`, prefixed `DEV_`.
3. **`DEV_ENVIRONMENT_ENABLED`: DONE, `true` since 2026-09-02.** It is
   `gh variable set DEV_ENVIRONMENT_ENABLED --body true`, and the same command with `false` is the
   escape: turning it on makes a FAILED dev deploy block the production deploy, which is the point
   of the ordering. It was flipped BEFORE the ingress rule and that is the right order - a dev
   estate has to be deploying before it is worth pointing a public name at, and the block it
   introduces is visible immediately (it did in fact hold production's deploys for the four hours
   the migration defects took to find, which is the mechanism working rather than failing).

**What is left is not owed by the user at all**: whether a dev-only `workflow_dispatch` should exist,
so that one push need not occupy both estates, is a design decision recorded in
[backlog](../backlog.md#devcanari-emsefr-becomes-a-real-second-environment---decided-2026-08-17).

**The dev OIDC client, and why it is not created here.** Authentik has one Canari application
(provider `pk=1`, `default-provider-authorization-implicit-consent`, `sub_mode=hashed_user_id`, six
redirect URIs); dev needs a sibling with `https://dev.canari-emse.fr/auth/callback` and its own
`client_id`/`client_secret`. It is creatable from a workstation with
`ssh miconnect 'docker exec -i miconnect-server-1 ak shell'` fed a script that copies provider 1's
flow, signing key and property mappings - **but writing to the identity provider's database is
exactly the class of action an agent should not perform unattended**, and the attempt on 2026-09-02
was refused for that reason. Do it in the admin UI, or approve the command explicitly.

**Owed by production, LATER and deliberately not yet.** `deploy-to-server` still carries its own
~780 lines of inlined shell. It moves onto `deploy-environment.sh` once the dev estate has actually
exercised that script - rewriting production's deploy path with no way to test it, on the day of two
outages, is how a third one happens. One implementation, proven before it is imposed.

**One thing that cannot be verified until Access exists.** The campaign harness must reach dev
freely (user, 2026-09-01), and it drives real Chrome over CDP rather than Playwright - so the
mechanism is `Network.setExtraHTTPHeaders` carrying the `CF-Access-Client-Id` /
`CF-Access-Client-Secret` pair, per attached target, not a browser-context option. It is deliberately
NOT built yet: an arming path nobody can exercise is an untested code path in the one instrument the
campaign depends on, and the crossing can only be proved once the Access application and its service
token exist.
