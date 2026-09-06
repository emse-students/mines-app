#!/usr/bin/env bash
#
# Self-tests for infrastructure/deploy/render-env.sh and its manifest.
#
# THE ASSERTION THIS FILE EXISTS FOR is the first group: the expected key set is DERIVED from
# `serve-prod.yml`, which is the thing that has always written production's .env. A key added there and
# forgotten in the manifest would otherwise be written by nobody, and the service would read the
# template default in silence - the exact shape of defect this repository keeps paying for. The
# failure mode of a guard list is an ABSENCE, so the list may not be hand-written.
#
# The second group is the isolation property, and it is the reason the dev environment is allowed to
# exist at all: with EVERY production secret present in the environment and no dev secret, the dev
# render must refuse and write nothing. `cd-dev.yml` failed exactly this - it read the bare secret
# names, so dev silently inherited production's JWT_SECRET, and a shared signing secret makes a
# token minted by either environment valid in the other.
#
# `set -e` is deliberately NOT used: every assertion below reports and continues, so one failure
# does not hide the other twenty.

set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 1

RENDER="infrastructure/deploy/render-env.sh"
MANIFEST="infrastructure/deploy/env-manifest.tsv"
# THE ESTATE WORKFLOWS ARE TWO FILES SINCE 2026-09-07. `deploy.yml` held the build jobs AND both
# estates behind a `phase` switch and was called twice, which drew every job of the other call as
# a structurally impossible skipped row; it is `build.yml` + `serve-dev.yml` + `serve-prod.yml`
# now. Production's `.env` is rendered in serve-prod; the DEV_ secrets are passed in serve-dev.
CD_PROD="./.github/workflows/serve-prod.yml"
CD_DEV="./.github/workflows/serve-dev.yml"

PASS=0
FAIL=0
pass() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/deploy-env-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# The full set of dev secrets, so a test can render dev successfully and then remove ONE.
dev_env() {
  printf '%s\n' \
    DEV_JWT_SECRET=devjwt \
    DEV_AUTHENTIK_URL=https://auth.dev \
    DEV_AUTHENTIK_CLIENT_ID=devcid \
    DEV_AUTHENTIK_CLIENT_SECRET=devcsec \
    DEV_BASE_URL=https://dev.canari-emse.fr \
    DEV_POSTGRES_USER=canari \
    DEV_POSTGRES_PASSWORD=devpw \
    DEV_GARAGE_RPC_SECRET=d1 \
    DEV_GARAGE_ADMIN_TOKEN=d2 \
    DEV_GARAGE_ACCESS_KEY_ID=d3 \
    DEV_GARAGE_SECRET_ACCESS_KEY=d4 \
    DEV_CHANNELS_ENCRYPTION_SECRET=d5 \
    DEV_INTERNAL_SHARED_SECRET=d6 \
    DEV_CALL_ROOM_SECRET=d7
}

prod_env() {
  printf '%s\n' \
    JWT_SECRET=prodjwt \
    AUTHENTIK_URL=https://auth.prod \
    AUTHENTIK_CLIENT_ID=prodcid \
    AUTHENTIK_CLIENT_SECRET=prodcsec \
    BASE_URL=https://canari-emse.fr \
    POSTGRES_USER=canari \
    POSTGRES_PASSWORD=prodpw \
    GARAGE_RPC_SECRET=p1 \
    GARAGE_ADMIN_TOKEN=p2 \
    GARAGE_ACCESS_KEY_ID=p3 \
    GARAGE_SECRET_ACCESS_KEY=p4 \
    CHANNELS_ENCRYPTION_SECRET=p5 \
    INTERNAL_SHARED_SECRET=p6 \
    CALL_ROOM_SECRET=p7
}

# Run the renderer with an explicit environment built from the lines on stdin.
render() {
  local environment="$1" out="$2"
  shift 2
  env -i \
    PATH="$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    "$@" \
    bash "$RENDER" --environment "$environment" --domain canari-emse.fr --out "$out" 2>&1
}

manifest_rows() {
  awk -F'\t' '!/^#/ && NF==5 { print }' "$MANIFEST"
}

manifest_field() {
  # $1 = key, $2 = column number
  manifest_rows | awk -F'\t' -v k="$1" -v c="$2" '$1 == k { print $c; exit }'
}

# ═════════════════════════════════════════════════════════════════════════════
printf '\nthe manifest covers what serve-prod.yml writes - DERIVED, so an omission cannot pass\n'
# ═════════════════════════════════════════════════════════════════════════════

if [ ! -f "$CD_PROD" ]; then
  fail "serve-prod.yml not found at $CD - the derivation below has no source"
else
  cd_keys="$(grep -oE 'upsert_env_var "[A-Z_0-9]+"' "$CD_PROD" | sed 's/upsert_env_var "//; s/"//' | sort -u)"
  if [ -z "$cd_keys" ]; then
    fail "no upsert_env_var calls found in serve-prod.yml - if the deploy job was converted to render-env.sh, point this derivation at its manifest instead"
  else
    pass "serve-prod.yml names $(printf '%s\n' "$cd_keys" | wc -l | tr -d ' ') keys to derive from"
    missing=""
    while read -r key; do
      [ -z "$key" ] && continue
      if [ -z "$(manifest_field "$key" 1)" ]; then
        missing="$missing $key"
      fi
    done <<<"$cd_keys"
    if [ -n "$missing" ]; then
      fail "serve-prod.yml writes these keys and the manifest does not carry them:$missing"
    else
      pass "every key serve-prod.yml writes has a manifest row"
    fi
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\nserve-dev.yml passes every dev secret the manifest asks for - also DERIVED\n'
# ═════════════════════════════════════════════════════════════════════════════

# The other direction of the same problem. `render-env.sh` reads `DEV_<NAME>` from its environment,
# and GitHub only puts a secret there if the workflow names it - so a manifest row whose secret
# `serve-dev.yml` never passes resolves to EMPTY. For a `required` row that fails the deploy loudly, which
# is the correct direction; for a `warn` row it degrades silently, which is not. Either way the fix
# is one line in `serve-dev.yml`, and this is what says so at CI time rather than at deploy time.
if [ -f "$CD_DEV" ]; then
  want_dev="$(manifest_rows | awk -F'\t' '$3 != "skip" && $4 ~ /^secret:/ { sub(/^secret:/, "", $4); print "DEV_" $4 }' | sort -u)"
  absent=""
  while read -r name; do
    [ -z "$name" ] && continue
    grep -q "secrets\.${name} }}" "$CD_DEV" || absent="$absent $name"
  done <<<"$want_dev"
  if [ -n "$absent" ]; then
    fail "serve-dev.yml never passes these dev secrets, so render-env.sh resolves them to empty:$absent"
  else
    pass "serve-dev.yml passes all $(printf '%s\n' "$want_dev" | wc -l | tr -d ' ') dev secrets the manifest names"
  fi

  # And the reverse, which is the one that would leak: a bare production secret name inside the dev
  # deploy job. The whole isolation rests on dev's job seeing DEV_ names ONLY.
  dev_job="$(awk '/^  deploy-dev:/{f=1} f && /^  [a-z-]+:$/ && !/^  deploy-dev:/{f=0} f' "$CD_DEV")"
  if [ -z "$dev_job" ]; then
    fail "could not locate the deploy-dev job in serve-dev.yml to audit its secret references"
  else
    bare="$(printf '%s' "$dev_job" | grep -oE 'secrets\.[A-Z_0-9]+' | sed 's/secrets\.//' |
      grep -vE '^(DEV_|GITHUB_TOKEN$)' | sort -u | tr '\n' ' ')"
    if [ -n "$bare" ]; then
      fail "the deploy-dev job references production secrets by their bare name: $bare"
    else
      pass "the deploy-dev job references DEV_ secrets only"
    fi
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\nthe two estates never publish the same host port\n'
# ═════════════════════════════════════════════════════════════════════════════

# THIS SECTION USED TO ASSERT THE WRONG THING, AND THE BUG IT MISSED SHIPPED. It read the four files
# that NAME the dev frontend port and confirmed they all said 3080. They did. The value that actually
# reached dev's .env came from a fifth file none of them was compared against -
# `infrastructure/.env.example`, which declares production's 8080 - because the override in serve-dev.yml
# was written `grep -q '^KEY=' .env || echo KEY=3080`, and the key is never absent from a file
# rendered FROM that template. Four declarations agreeing is not the port the estate gets.
#
# So this asks the RENDERED .env instead. Both estates live on one machine and a published port is
# machine-wide, so the property is not "dev says 3080" - it is "these two never collide", which is
# true or false about the outcome and cannot be satisfied by a comment.
# shellcheck disable=SC2046 # word splitting is the point: each line is one VAR=value assignment
render prod "$TMP/ports-prod.env" $(prod_env) >"$TMP/ports-prod.log" 2>&1 || true
# shellcheck disable=SC2046
render dev "$TMP/ports-dev.env" $(dev_env) $(prod_env) >"$TMP/ports-dev.log" 2>&1 || true

port_of() {
  # $1 = rendered file, $2 = key
  grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

for key in FRONTEND_HOST_PORT GARAGE_API_HOST_PORT GARAGE_ADMIN_HOST_PORT; do
  pp="$(port_of "$TMP/ports-prod.env" "$key")"
  dp="$(port_of "$TMP/ports-dev.env" "$key")"
  if [ -z "$pp" ] || [ -z "$dp" ]; then
    fail "$key is missing from a rendered .env (prod='$pp' dev='$dp') - nothing decides it per environment"
  elif [ "$pp" = "$dp" ]; then
    fail "$key renders to $pp for BOTH estates - they share one machine, so one of them cannot bind it"
  else
    pass "$key differs between the estates (prod $pp, dev $dp)"
  fi
done

# THE TEMPLATE MUST NOT BE WHAT DECIDES, which is the defect above stated as a property: dev's
# rendered value has to differ from what `.env.example` says, because the template carries
# production's numbers and dev's file is built from it.
tmpl_front="$(grep -E '^FRONTEND_HOST_PORT=' infrastructure/.env.example | tail -1 | cut -d= -f2- || true)"
dev_front="$(port_of "$TMP/ports-dev.env" FRONTEND_HOST_PORT)"
if [ -n "$tmpl_front" ] && [ "$tmpl_front" = "$dev_front" ]; then
  fail "dev rendered FRONTEND_HOST_PORT=$dev_front, exactly what .env.example says - the template is deciding, so nothing overrode it for dev"
else
  pass "the template's FRONTEND_HOST_PORT ($tmpl_front) does not decide dev's ($dev_front)"
fi

# AND EVERY DECLARATION IS HELD AGAINST THE RENDERED VALUE, not against the other declarations. The
# compose default and the refresh probe are what break if dev's port moves, and comparing them to the
# OUTCOME is precisely what the old version of this section failed to do. Nothing here can tell
# whether the cloudflared tunnel agrees - that lives in Cloudflare's configuration.
declared=""
add_declared() {
  if [ -z "$2" ]; then fail "could not read the dev host port from $1"; else declared="$declared $1=$2"; fi
}
add_declared "docker-compose.dev.yml" \
  "$(grep -oE '\$\{FRONTEND_HOST_PORT:-[0-9]+\}' infrastructure/docker-compose.dev.yml | head -1 |
    grep -oE '[0-9]+' || true)"
add_declared "deploy-environment.sh" \
  "$(grep -A4 '^dev)' infrastructure/deploy/deploy-environment.sh |
    grep -oE 'DEFAULT_FRONTEND_PORT=[0-9]+' | grep -oE '[0-9]+' || true)"
add_declared "scheduled.yml" \
  "$(grep -oE '127\.0\.0\.1:[0-9]+/api/version' .github/workflows/scheduled.yml | head -1 |
    grep -oE ':[0-9]+' | tr -d ':' || true)"

disagree=""
# shellcheck disable=SC2086 # deliberate word splitting over the accumulated label=value pairs
for pair in $declared; do
  case "$pair" in *"=$dev_front") ;; *) disagree="$disagree $pair" ;; esac
done
if [ -n "$disagree" ]; then
  fail "these name a dev port other than the $dev_front the render produces:$disagree"
else
  pass "every declaration agrees with the RENDERED dev port ($dev_front):$declared"
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\nthe manifest is well formed\n'
# ═════════════════════════════════════════════════════════════════════════════

bad_cols="$(awk -F'\t' '!/^#/ && NF>0 && NF!=5 { print NR }' "$MANIFEST" | tr '\n' ' ')"
if [ -n "$bad_cols" ]; then
  fail "lines with a column count other than 5 (a space instead of a tab?): $bad_cols"
else
  pass "every row has exactly 5 tab-separated columns"
fi

bad=""
while IFS=$'\t' read -r key prod dev source _note; do
  case "$prod" in required | warn | silent | skip | literal | computed) ;; *) bad="$bad $key(prod=$prod)" ;; esac
  case "$dev" in required | warn | silent | skip | literal | computed) ;; *) bad="$bad $key(dev=$dev)" ;; esac
  case "$source" in secret:* | literal:* | computed) ;; *) bad="$bad $key(source=$source)" ;; esac
done < <(manifest_rows)
if [ -n "$bad" ]; then
  fail "rows with an unknown disposition or source:$bad"
else
  pass "every disposition and source is one render-env.sh knows"
fi

dupes="$(manifest_rows | cut -f1 | sort | uniq -d | tr '\n' ' ')"
if [ -n "$dupes" ]; then
  fail "duplicate keys, so which row wins depends on file order: $dupes"
else
  pass "no key appears twice"
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\nproduction renders exactly what serve-prod.yml rendered\n'
# ═════════════════════════════════════════════════════════════════════════════

out="$TMP/prod.env"
# shellcheck disable=SC2046 # word splitting is the point: each line is one VAR=value assignment
render prod "$out" $(prod_env) >"$TMP/prod.log"
if [ ! -f "$out" ]; then
  fail "a complete production environment did not render at all"
  cat "$TMP/prod.log"
else
  pass "a complete production environment renders"

  got="$(grep '^ALLOW_ORIGIN=' "$out" | head -1)"
  # The value serve-prod.yml computed, with its one interpolation resolved the way env.DOMAIN resolves.
  want_raw="$(grep -oE 'upsert_env_var "ALLOW_ORIGIN" "[^"]*"' "$CD_PROD" | sed 's/.*"ALLOW_ORIGIN" "//; s/"$//')"
  if [ -z "$want_raw" ]; then
    fail "could not read serve-prod.yml's ALLOW_ORIGIN to compare against"
  else
    want="ALLOW_ORIGIN=$(printf '%s' "$want_raw" |
      sed 's|\${{ env.DOMAIN }}|canari-emse.fr|g; s|\$FRONTEND_URL|https://canari-emse.fr|g')"
    if [ "$got" = "$want" ]; then
      pass "ALLOW_ORIGIN is byte-identical to the value serve-prod.yml built"
    else
      fail "ALLOW_ORIGIN changed"
      printf '       serve-prod.yml: %s\n       render: %s\n' "$want" "$got"
    fi
  fi

  if grep -q '^CALL_E2E_ENCRYPTION=false$' "$out"; then
    pass "CALL_E2E_ENCRYPTION is the literal false, as production has always had"
  else
    fail "CALL_E2E_ENCRYPTION is not false"
  fi

  # DEPLOY_BUILD must never be written in production: /api/version reports `build`, and production's
  # version already names its content because it is built from a tag.
  if grep -qE '^DEPLOY_BUILD=.+' "$out"; then
    fail "production wrote a DEPLOY_BUILD, so /api/version would report a build for a tagged release"
  else
    pass "production writes no DEPLOY_BUILD"
  fi
fi

out="$TMP/prod-nojwt.env"
# shellcheck disable=SC2046
render prod "$out" $(prod_env | grep -v '^JWT_SECRET=') >"$TMP/prod-nojwt.log"
if [ -f "$out" ]; then
  fail "production rendered a .env with no JWT_SECRET"
elif grep -q 'JWT_SECRET is not set' "$TMP/prod-nojwt.log"; then
  pass "a missing JWT_SECRET fails production and writes nothing"
else
  fail "production refused without naming JWT_SECRET"
  cat "$TMP/prod-nojwt.log"
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\nTHE ISOLATION PROPERTY: dev cannot reach production'"'"'s secrets\n'
# ═════════════════════════════════════════════════════════════════════════════

out="$TMP/dev-prodonly.env"
# shellcheck disable=SC2046
render dev "$out" $(prod_env) >"$TMP/dev-prodonly.log"
if [ -f "$out" ]; then
  fail "dev rendered a .env while only production secrets were present"
  grep -E '^(JWT_SECRET|POSTGRES_PASSWORD)=' "$out"
else
  pass "dev refuses when only production secrets are present"
fi
if grep -q 'JWT_SECRET is not set for the dev environment' "$TMP/dev-prodonly.log"; then
  pass "and it says so about JWT_SECRET by name"
else
  fail "dev refused without naming JWT_SECRET"
fi

out="$TMP/dev.env"
# shellcheck disable=SC2046
render dev "$out" $(dev_env) $(prod_env) >"$TMP/dev.log"
if [ ! -f "$out" ]; then
  fail "dev did not render even with a complete set of dev secrets"
  cat "$TMP/dev.log"
else
  pass "dev renders from its own secrets"

  leaked=""
  for value in prodjwt prodpw prodcid prodcsec p1 p2 p3 p4 p5 p6 p7; do
    if grep -q "=${value}\$" "$out"; then leaked="$leaked $value"; fi
  done
  if [ -n "$leaked" ]; then
    fail "production secret VALUES appear in dev's .env:$leaked"
  else
    pass "no production secret value appears in dev's .env, with all of them in the environment"
  fi

  if grep -q '^JWT_SECRET=devjwt$'  "$out"; then
    pass "dev's JWT_SECRET is dev's own, so a token from either environment is refused by the other"
  else
    fail "dev's JWT_SECRET is not devjwt"
  fi

  got="$(grep '^ALLOW_ORIGIN=' "$out" | head -1)"
  case "$got" in
  *"https://canari-emse.fr"*) fail "dev's CORS list carries production's origin: $got" ;;
  *"https://dev.canari-emse.fr"*) pass "dev's CORS list carries dev's origin and not production's" ;;
  *) fail "dev's CORS list carries neither origin: $got" ;;
  esac
fi

out="$TMP/dev-nogarage.env"
# shellcheck disable=SC2046
render dev "$out" $(dev_env | grep -v '^DEV_GARAGE_RPC_SECRET=') >"$TMP/dev-nogarage.log"
if [ -f "$out" ]; then
  fail "dev rendered with one required secret missing"
elif grep -q 'GARAGE_RPC_SECRET is not set for the dev environment' "$TMP/dev-nogarage.log"; then
  pass "one missing required dev secret fails the render and writes nothing"
else
  fail "dev refused without naming the missing secret"
fi

out="$TMP/dev-build.env"
# shellcheck disable=SC2046
render dev "$out" $(dev_env) >/dev/null
if [ -f "$out" ] && ! grep -qE '^DEPLOY_BUILD=.+' "$out"; then
  pass "dev writes no DEPLOY_BUILD when the deploy did not pass one"
else
  fail "dev wrote a DEPLOY_BUILD without being given one"
fi
# shellcheck disable=SC2046
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" $(dev_env) \
  bash "$RENDER" --environment dev --domain canari-emse.fr --build dev.abc1234 --out "$TMP/dev-build2.env" >/dev/null 2>&1
if grep -q '^DEPLOY_BUILD=dev.abc1234$' "$TMP/dev-build2.env" 2>/dev/null; then
  pass "dev writes the build identity it was given"
else
  fail "dev did not write the build identity"
fi

# A RENDERED VALUE NOTHING CONSUMES DOES NOT EXIST, and the four assertions above could not see it.
# `DEPLOY_BUILD` was computed by the renderer, declared in the manifest, parsed by `deploy-build.ts`
# and covered by `version.service.spec.ts` - and passed into no container by either compose file, so
# `/api/version` answered `build: null` on BOTH estates. It was about to be used as the proof that
# the tunnel had been moved onto dev, which it could never have given. `core-service` is the service
# that serves `/api/version`, so it is the one that must receive it.
core_service_env() {
  awk '
    /^  core-service:/ { inside = 1; next }
    inside && /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ { inside = 0 }
    inside { print }
  ' "$1"
}
# A HERE-STRING, NOT A PIPE, and the first draft was a pipe: `grep -q` exits at its first match, the
# writer upstream takes SIGPIPE, and `set -o pipefail` reports the pipeline as failed. Whether it
# fires depends on how much output is still unwritten when grep leaves - so the same assertion passed
# for the dev file, whose match is near the end of the block, and failed intermittently for the
# production file, whose match sits 14 lines from it.
for compose in infrastructure/docker-compose.dev.yml infrastructure/docker-compose.prod.yml; do
  if [ ! -f "$compose" ]; then
    fail "$compose is missing"
  elif grep -qE '^[[:space:]]*DEPLOY_BUILD:' <<<"$(core_service_env "$compose")"; then
    pass "$(basename "$compose") passes DEPLOY_BUILD to core-service, which is what serves /api/version"
  else
    fail "$(basename "$compose") renders DEPLOY_BUILD into .env and never passes it to core-service - /api/version will report build: null whatever the deploy computed"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
printf '\nthe decisions the user took are locked, not merely documented\n'
# ═════════════════════════════════════════════════════════════════════════════

# "oublie. Stripe ne sera pas accessible en dev pour le moment, tant pis" (user, 2026-09-01).
# `skip` rather than `warn`: the absence is the decision, so a warning every deploy would be noise.
for key in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET LYDIA_PROVIDER_TOKEN LYDIA_PROVIDER_PRIVATE_TOKEN; do
  if [ "$(manifest_field "$key" 3)" = "skip" ]; then
    pass "$key is skipped in dev, which is the user's decision"
  else
    fail "$key is not skipped in dev - dev has no payment credentials, so the value could only mislead"
  fi
done

# Le Cercle reads production's endpoint before letting a member drink. A dev estate answering with
# production's key would let the bar's checks pass against a copy of the database.
if [ "$(manifest_field CERCLE_API_KEY 3)" = "skip" ]; then
  pass "CERCLE_API_KEY is skipped in dev, so Le Cercle can never be answered by the copy"
else
  fail "CERCLE_API_KEY is not skipped in dev"
fi

# PUSH IS DELIBERATELY AVAILABLE ON DEV, AND THE GUARD IS ELSEWHERE. Until 2026-09-02 the three APNs
# rows were `skip` while `FIREBASE_SERVICE_ACCOUNT_JSON` beside them was `warn` - Android push
# provided for, iOS not, on the same threat model. That was an oversight, not a policy. What actually
# stops a test notification reaching a real member is the copy's `TRUNCATE TABLE push_token`, asserted
# by `dev-copy-guards.test.sh`: a dev estate holds no token of any real device, so the only phone it
# can reach is one that has itself signed into dev. This asserts the two halves stay CONSISTENT, which
# is the property that was broken - not which value they hold.
fcm="$(manifest_field FIREBASE_SERVICE_ACCOUNT_JSON 3)"
apns="$(manifest_field APNS_VOIP_KEY_P8 3)"
if [ "$fcm" = "$apns" ]; then
  pass "iOS and Android push have the same dev disposition ($fcm), so one platform cannot be testable while the other is not"
else
  fail "dev treats Android push as '$fcm' and iOS push as '$apns' - same threat model, so a difference here is an oversight, not a decision"
fi
if [ "$apns" = "skip" ]; then
  fail "push is skipped on dev, which makes the estate unable to test the notification path at all - if that is really wanted, the guard to point at is the push_token truncation, not the absent key"
else
  pass "dev can be given its own push credentials, so the notification path is testable there"
fi

printf '\nnothing that touches the one machine may run twice at once\n'
# ═════════════════════════════════════════════════════════════════════════════
#
# DERIVED FROM THE RUNNER, NOT FROM A LIST. `runs-on: self-hosted` IS the statement "this job reaches
# the box that serves production and dev" - there is exactly one such runner - so every workflow that
# asks for it must also say what it may not overlap with. A hand-written list of workflows to check
# would pass on the day somebody adds the third one, which is the failure mode this whole suite is
# built against.
#
# It proved able to fail: on 2026-09-02 `deploy.yml` had no `concurrency:` at all and three deploy runs
# were in flight against `/home/canari/canari` simultaneously.
# ASKED PER JOB, NOT PER FILE, SINCE 2026-09-04. It read the WORKFLOW for a top-level
# `concurrency:`, which was right while one workflow meant one estate job - and wrong the moment
# `scheduled.yml` collected four unrelated jobs, two of them on the runner. A file-level group there
# would have PASSED this check while queueing a read-only host report behind a dev refresh; and a
# file with one guarded job and one unguarded one would have passed just the same. The property is
# about the JOB that reaches the machine.
for wf in .github/workflows/*.yml; do
  grep -q 'runs-on: self-hosted' "$wf" || continue
  name="$(basename "$wf")"

  # A workflow-level group covers every job in the file, which is the right shape for the three
  # deploy libraries: they share one group, so no two of them overlap either.
  if grep -q '^concurrency:' "$wf"; then
    group="$(grep -A2 '^concurrency:' "$wf" | sed -n 's/^ *group: *//p' | head -1)"
    pass "$name serialises the whole file (group: $group)"
    continue
  fi

  # Otherwise every self-hosted job in it must serialise itself. `awk` splits on the job keys, which
  # sit at exactly two spaces; anything deeper belongs to the job above.
  UNGUARDED="$(awk '
    function flush() { if (job != "" && sh && !conc) print job }
    /^  [a-z][a-z0-9_-]*:$/ {
      flush(); job = $0; sub(/^  /, "", job); sub(/:$/, "", job); sh = 0; conc = 0; next
    }
    /^    runs-on: self-hosted$/ { sh = 1 }
    /^    concurrency:$/ { conc = 1 }
    END { flush() }
  ' "$wf" | sort -u | tr '\n' ' ')"

  if [ -z "${UNGUARDED// /}" ]; then
    pass "$name serialises every job that reaches the machine, at the job level"
  else
    fail "$name has self-hosted job(s) with no 'concurrency:' of their own:$UNGUARDED - two runs can reset the same checkout and recreate the same containers at once"
  fi
done

# CANCELLING A DEPLOY MIDWAY IS WORSE THAN QUEUEING BEHIND ONE, and the difference is one word.
# A killed run leaves containers half-recreated and the checkout on a commit whose images were never
# pulled - a state no later run is written to recognise. Asserted separately from the group's
# presence because `cancel-in-progress: true` would satisfy the check above while doing the harm.
# THREE FILES SINCE 2026-09-07, AND ALL THREE MUST SAY IT. They share one `cd-deploy` group so
# that splitting the file changed nothing about what may overlap; a file that forgot the word
# would silently leave that group killable, which is the harm this asserts against.
for wf in build serve-dev serve-prod; do
  if grep -A2 '^concurrency:' ".github/workflows/$wf.yml" | grep -q 'cancel-in-progress: false'; then
    pass "$wf.yml queues behind a running deploy instead of killing it"
  else
    fail "$wf.yml does not declare 'cancel-in-progress: false' - a cancelled deploy leaves the estate in whatever state the kill found"
  fi
done

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
