# Authentik (OIDC provider)

**Stack**: Authentik (Docker Compose, project name `miconnect`)  
**Source**: `infrastructure/authentik/compose.yml`

Canari uses Authentik as its OpenID Connect identity provider. Authentik is deployed as a separate Docker Compose stack alongside the main application stack.

## The box, and the log that settles an OIDC question

Authentik does NOT run on `canari`. It is its own host, reached as **`ssh miconnect`** (via
ProxyJump through `canari`, so PowerShell and not Bash - see
[databases](databases.md#reaching-it-from-a-workstation)). Its containers are `miconnect-server-1`,
`miconnect-worker-1` and `miconnect-postgresql-1`.

**`docker logs miconnect-server-1` is an ACCESS LOG**, and it is the instrument for any question
about a login that failed on a client you cannot attach a debugger to. Every
`/application/o/authorize/` appears with its status, its `redirect_uri` and the client's
`user_agent` - which is what proved the iPad defect
([mobile](../frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)):
one `status 400` carrying `tauri://localhost/auth/callback` from a user agent calling itself
`Macintosh`. Read it before theorising about a client-side branch.

## Deployment

The CD pipeline ([`cicd.md`](../cicd.md), job `deploy-to-server`):

1. Creates `/home/canari/miconnect/{data,certs,custom-templates}` if absent
2. Copies `infrastructure/authentik/compose.yml` to `/home/canari/miconnect/compose.yml` (versioned source of truth)
3. Generates `/home/canari/miconnect/.env` from GitHub Secrets
4. Runs `docker compose up -d` from the miconnect directory

`up -d` is idempotent: without config changes, Authentik is not recreated.

## OIDC flow

Authentik acts as the OIDC **Provider**; Canari's [`core-service`](../services/core-service.md) acts as the **Relying Party**:

```
Browser → Authentik /authorize (PKCE + state)
  → User authenticates (login/password, SSO)
  → Redirect to /auth/callback?code=...&state=...
  → Browser POSTs code to core-service
  → core-service exchanges code for tokens (server-side)
  → core-service upserts user in PostgreSQL (sub = userId)
  → Returns { access_token (JWT HS256, 15 min), refresh (HttpOnly cookie, 7d) }
```

The user's `sub` claim from Authentik becomes the canonical `userId` across all Canari services (`findOrCreateFromOidc` uses `userinfo.sub` as the primary key).

## Nginx auth_request integration

Every protected request goes through `auth_request /internal/auth/verify`:

1. Nginx calls `core-service:3012/api/auth/verify` (internal only, never public)
2. `core-service` validates the JWT from the `Authorization: Bearer` header
3. On success: Nginx injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` headers
4. Upstream services trust these headers (Nginx strips client-supplied ones on all public locations)

## Configuration

### GitHub Secrets

| Secret | Role |
|---|---|
| `AUTHENTIK_CLIENT_ID` | OIDC client ID (Canari application in Authentik) |
| `AUTHENTIK_CLIENT_SECRET` | OIDC client secret |
| `AUTHENTIK_URL` / `AUTHENTIK_ISSUER` | Authentik issuer URL |
| `MICONNECT_PG_PASS` | Authentik PostgreSQL password |
| `MICONNECT_AUTHENTIK_SECRET_KEY` | Authentik secret key |

### Authentik-side setup

The following must be configured in the Authentik admin UI (not automated via CD):

- **Application**: Canari (OIDC provider, authorization code flow with PKCE)
- **Scopes**: `openid`, `profile`, `email`
- **Redirect URIs**: `https://<domain>/auth/callback`
- **Users**: managed in Authentik; synced to Canari's `users` table on first login

### The three Canari providers, and what each one lets a client come back to

Read this table before touching a redirect URI anywhere: the defect below was a single row of it
being different from the other two, and nothing outside Authentik's own database could see that.

| Provider | `client_id` | Which client uses it | Authorized redirect URIs (all STRICT) |
|---|---|---|---|
| `Canari` (pk 1) | `KyTy6F1C...` | production - web and both stores' STABLE builds | `https://canari-emse.fr/auth/callback`, `https://tauri.localhost/auth/callback`, `http://tauri.localhost/auth/callback`, `http://localhost:1420/auth/callback`, `http://localhost:1421/auth/callback`, `fr.emse.canari://callback` |
| `Canari Dev` (pk 10) | `6cNHJotT...` | `dev.canari-emse.fr` - and every PRE-RELEASE build, TestFlight and the Play tester tracks | `https://dev.canari-emse.fr/auth/callback`, `https://tauri.localhost/auth/callback`, `http://tauri.localhost/auth/callback`, `http://localhost:1420/auth/callback`, `http://localhost:1421/auth/callback`, `fr.emse.canari://callback` |
| `Canari Local` (pk 11) | `qqzuUBQp...` | the LOCAL estate on a workstation, and the harness APK | `http://localhost:1420/auth/callback`, `http://127.0.0.1:1420/auth/callback`, `http://localhost:1421/auth/callback`, `http://localhost:8081/auth/callback`, `fr.emse.canari://callback` |

**The three differ in exactly one dimension - the web origin - and must not differ in any other.**
`fr.emse.canari://callback` is on all three because the SAME packaged app talks to all three: a
build selects its estate with `VITE_AUTHENTIK_CLIENT_ID` and an API URL, never with an identifier.

**That rule covers `grant_types` too, and the two sections below are what happens when it does not.**
On 2026-09-07 `Canari Dev` differed from its siblings in BOTH fields at once, and the first fault
hid the second. When comparing providers, compare every field, not the one the symptom names.

### The one redirect URI a mobile client needs, added by hand - `Canari Local` 2026-09-04, `Canari Dev` 2026-09-07

Both providers carry `fr.emse.canari://callback` as an **authorization** redirect URI with
**strict** matching, alongside their web entry. Both were added by hand, in the admin shell, and
this paragraph is the only record of either:

```sh
ssh miconnect
docker exec -i miconnect-server-1 ak shell    # then set the RedirectURI on the provider, and re-read it
```

`redirect_uris` is a **list of `RedirectURI` objects** (`authentik.providers.oauth2.models`), each
carrying a `matching_mode` and a `url` - not a newline-separated text field, which is what the admin
UI shows and what a first attempt at this will assume.

**Why it was needed.** A packaged mobile client does not come back to a URL, it comes back to its
own custom scheme - `fr.emse.canari://callback`, the deep link declared in
[`tauri.conf.json`](../../../frontend/src-tauri/tauri.conf.json). A phone whose provider does not
list that scheme reaches the IdP, authenticates, and is refused at the last hop with Authentik's own
**"Redirect URI Error"** - a message that names the provider's configuration and not the client,
which is why it reads like an app fault and is worth recognising on sight.

**`Canari Dev` cost a real tester a login, and the shape of the mistake is worth keeping.** Until
2026-09-07 it listed `fr.emse.canari.dev://callback` instead: a scheme NOTHING in this repository
declares. `tauri.conf.json` has identifier `fr.emse.canari` and the deep-link plugin registers that
one scheme only, so the dev provider was waiting for a callback no build could ever send. A
TestFlight tester on the pre-release build 1600401 was refused three times on 2026-09-06 - visible
in `docker logs miconnect-server-1` as `400` on `/application/o/authorize/` with
`client_id=6cNHJ...` and `redirect_uri=fr.emse.canari://callback`. The dead `.dev` entry was
DELETED in the same gesture that added the real one: left in place it tells the next reader that a
`.dev` scheme exists.

**And the fix belonged here, not in the app.** Making the dev build answer to `.dev://` would need a
separate bundle identifier (`fr.emse.canari.dev`), hence its own provisioning profile, its own App
Store record and its own scheme declaration. That is not the shape of this ecosystem, where the dev
and prod builds share the identifier and differ only by `client_id` and API URL. Sharing the
identifier also means the two apps cannot coexist on one phone, so reusing the scheme creates no OS
routing ambiguity.

**Why none of this weakens the separation `infrastructure/.env` exists to enforce.** The danger that
split is aimed at is a page served from one estate obtaining tokens for another. Every provider here
is **confidential**: an authorization code handed to the custom scheme is worthless without the
client secret, which only that estate's backend holds. So the addition widens what may RECEIVE a
code on one client, never what may exchange one, and it grants nothing on any other client.

**It is a hand mutation on a production box, so it is owed to the restore path.** It lives in
Authentik's Postgres and nowhere else, exactly like the login CSS below: a restore from a backup
taken before **2026-09-04** (`Canari Local`) or **2026-09-07** (`Canari Dev`) brings it back
missing, and the symptom is the "Redirect URI Error" above rather than anything that names a
redirect URI. Re-add it on BOTH providers after any restore that predates those dates.

**What guards the app half, and what guards nothing.**
[`frontend/src/lib/mobile/oidcRedirectScheme.test.ts`](../../../frontend/src/lib/mobile/oidcRedirectScheme.test.ts)
asserts that the scheme `oidcRedirectUri()` builds is one `tauri.conf.json` actually declares. It
would have failed the day somebody wrote `fr.emse.canari.dev` expecting the app to follow. It
cannot see Authentik's database, which does not live in this repository - this page is the only
thing that protects that half.


### `Canari Dev` permitted NO grant type, so dev login was refused for everybody - fixed 2026-09-07

**Measured, not suspected.** `OAuth2Provider.objects.get(pk=10).grant_types` was `[]`. `Canari`
(pk 1) and `Canari Local` (pk 11) both carry the full list authentik creates a provider with:

```
['authorization_code', 'hybrid', 'implicit', 'client_credentials', 'password',
 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
```

`check_grant` in `authentik/providers/oauth2/views/authorize.py` raises
`AuthorizeError(error="invalid_request")` when `self.grant_type not in self.provider.grant_types`,
and an empty list matches nothing. So EVERY authorization against `Canari Dev` is refused, on every
redirect URI - **the web one included**:

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' \
  "https://auth.canari-emse.fr/application/o/authorize/?client_id=6cNHJ...&redirect_uri=https%3A%2F%2Fdev.canari-emse.fr%2Fauth%2Fcallback&response_type=code&scope=openid+profile&state=probe"
# 302 https://dev.canari-emse.fr/auth/callback?error=invalid_request&error_description=The%20request%20is%20otherwise%20malformed
```

**It was hidden behind the redirect URI defect above.** A request that fails
`check_redirect_uri` never reaches `check_grant`, so while the mobile URI was missing, this second
fault could not be seen from a phone - and fixing only the first moves a tester from "Redirect URI
Error" to "invalid_request" with no login either way. Two faults on one provider, stacked, and the
outer one masked the inner one: that is why the fix was verified by PROBE rather than by re-reading
the field that had just been written.

**A custom scheme also changes what an error LOOKS like, which is worth knowing before diagnosing
one.** Authentik reports an `AuthorizeError` by redirecting it to the client's `redirect_uri`, and
Django's `HttpResponseRedirect` allows `http`, `https` and `ftp` only. So on `fr.emse.canari://`
the redirect raises `DisallowedRedirect` and the client sees a bare **400** with no `error=`
parameter at all, while the same fault on the web URI arrives as a readable
`302 ...?error=invalid_request`. **To read the real error behind a mobile 400, replay the request
against the provider's https redirect URI.** The line to look for on the box is
`django.security.DisallowedRedirect` - "Unsafe redirect to URL with protocol 'fr.emse.canari'".

**The remedy** was to give pk 10 the same list as its two siblings, copied from pk 1 rather than
retyped, with an assertion that pk 1 and pk 11 agreed before copying either. It is a hand mutation
on a production box and is owed to the restore path exactly like the URIs above: **a restore from a
backup predating 2026-09-07 brings `Canari Dev` back with an empty `grant_types` and no dev login at
all, web or mobile.**

**What proves it, and what does not.** Re-reading the field after writing it proves only that the
write landed - it says nothing about the second fault waiting behind the first. The check that
settles it is the probe, on BOTH redirect URIs, and the answer to look for is a **302 to
`/if/flow/miconnect-auth/`** rather than any 2xx or 4xx:

```sh
CID=<the Canari Dev client_id>
for uri in "https://dev.canari-emse.fr/auth/callback" "fr.emse.canari://callback"; do
  enc=$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$uri")
  curl -s -o /dev/null -w "$uri -> %{http_code} %{redirect_url}\n" \
    "https://auth.canari-emse.fr/application/o/authorize/?client_id=$CID&redirect_uri=$enc&response_type=code&scope=openid+profile&state=probe"
done
```

Run it against any provider on this box after touching it. It needs no account, no secret and no
device, and it distinguishes all three failure shapes: a `400` with `DisallowedRedirect` in the log
(mobile scheme, some other fault), a `302 ...?error=<code>` (the fault, readable) and a `302
/if/flow/...` (the provider is willing, and what is left is the user's own credentials).

## Login page branding

`infrastructure/authentik/custom-login.css` is the versioned source of truth for the login flow's
custom CSS. Authentik has no mechanism to load this from a file or a repo path - it must be pasted
manually into the admin UI (System -> Brands -> the Canari brand -> "Custom CSS") after any edit,
and the field itself lives only in Authentik's Postgres DB, so a change made only there and never
copied back here is one lost/stale backup away from disappearing silently.

Two failure modes worth knowing before touching it again: a `z-index: -1` decorative element needs
its parent to actually establish a stacking context (`isolation: isolate`, not just
`position: relative`) or it paints behind the whole page instead of just behind its own sibling;
and an external `@import` (e.g. Google Fonts) can silently no-op under Authentik's default CSP,
which blocks it - self-hosting is the fix if an exact custom font is needed.

## Database and backup

The PostgreSQL database (volume `miconnect_database`) contains all Authentik configuration: providers, applications, users, OIDC settings. It is backed up daily by [`infrastructure/backup/backup.sh`](../../../infrastructure/backup/backup.sh) as `authentik_db.sql.gz`.

Restore: `./infrastructure/backup/restore.sh --latest-from-mitv --yes` (restores `authentik_db` alongside Canari data).

**THE USER COUNT IS A LIVE POPULATION AND IS NEVER EVIDENCE OF ANYTHING.** Two readings taken hours
apart on 2026-09-02 gave 465 and then 511, which was chased as a discrepancy after two test accounts
were created; a third gave 517. There is **no LDAP source** (`LDAPSource.objects.all()` is empty) -
real people are enrolling continuously, several in the hour that was measured. So a count is a
snapshot of something moving: compare identities, never totals, and if a total must be quoted, quote
the instant with it. Every account is `type=internal` (`external` and `service_account` are both
zero, with one `internal_service_account`), which is why the campaign's dedicated accounts had to be
`internal` too - see [cross-client-campaign-resume](../cross-client-campaign-resume.md).

## See also

- [`services/core-service.md`](../services/core-service.md) — OIDC callback, JWT issuance, auth verification
- [`architecture.md`](../architecture.md) — Auth flow diagram, per-request auth
- [`infrastructure/nginx.md`](nginx.md) — `auth_request` configuration
- [`infrastructure/backup.md`](backup.md) — Backup and restore procedures
- [`infrastructure/MIGRATION.md`](../../../infrastructure/MIGRATION.md) — Server bootstrap and migration
