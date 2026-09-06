#!/usr/bin/env bash
# =================================================================================================
# THE SHAPE OF THE RELEASE CHAIN
#
# WHY A SHAPE TEST AND NOT A UNIT TEST. Nothing here can be executed off GitHub: the only way to
# find out what a workflow does is to publish a release, and the cost of getting it wrong is a
# deployment that goes to the wrong estate or does not happen at all. What CAN be asserted, cheaply
# and every time, is that the chain still has the shape the three human gestures require - because
# every defect this chain has actually had was a SHAPE defect:
#
#   * four workflows chained by `workflow_run`, each re-deriving the same three facts;
#   * each arm resolving `main` for itself, so a merge mid-release could hand a store a different
#     tree from production with no artefact carrying the commit to say so;
#   * and no gate on the tests at all - the chain required the BUMP to succeed, which is a different
#     statement, and `v0.15.0` shipped on a RED run.
#
# None of those needed a bug in a script. They were all "the pieces are wired the wrong way", which
# is exactly what a file can be read for.
#
# GREP AND NOT A YAML PARSER, deliberately: this suite runs from `make test-ci-scripts` alongside
# nine other shell tests, and adding a parser dependency to say "this line is present" would be a
# new thing that can break for reasons unrelated to the chain. `bump-staging.test.sh` reads
# `release.yml` the same way, for the same reason.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WF="$(cd "$HERE/../../workflows" && pwd)"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

for f in release.yml build.yml serve-dev.yml serve-prod.yml android.yml ios.yml; do
  [ -r "$WF/$f" ] || { printf 'cannot read %s\n' "$WF/$f"; exit 1; }
done

printf '\none entry point, and it is the release event\n'
# =================================================================================================
# A second workflow listening for `release: published` would deploy in parallel with this one, and
# the two would race on the bump's push.
ENTRIES="$(grep -l -E '^  release:' "$WF"/*.yml 2>/dev/null | xargs -r -n1 basename | sort | tr '\n' ' ')"
if [ "$ENTRIES" = 'release.yml ' ]; then
  pass 'release.yml is the only workflow triggered by a published release'
else
  fail "workflows triggered by a release: ${ENTRIES:-none} - expected release.yml alone"
fi

if grep -qE '^  workflow_dispatch:' "$WF/release.yml"; then
  pass 'it keeps a hand-dispatched path for re-running a release after an infrastructure fault'
else
  fail 'the hand-dispatched path is gone - a release whose chain failed could only be re-run by deleting it'
fi

printf '\nthe old fan-out is gone\n'
# =================================================================================================
# `bump-version.yml` was the workflow the three arms listened for. Its disappearance is the whole
# point: if it comes back, so does every defect above.
if [ -e "$WF/bump-version.yml" ]; then
  fail 'bump-version.yml is back - the bump belongs to release.yml, or the arms have two masters'
else
  pass 'bump-version.yml is gone; the bump is a job of release.yml'
fi

for f in build.yml serve-dev.yml serve-prod.yml android.yml ios.yml; do
  # A trigger, not a mention: the comments in these files explain what `workflow_run` used to do.
  if grep -qE '^  workflow_run:' "$WF/$f"; then
    fail "$f still triggers on workflow_run - it must be called, not woken"
  else
    pass "$f has no workflow_run trigger"
  fi
done

printf '\nthe five arms are called workflows, and each takes exactly the facts it acts on\n'
# =================================================================================================
# WHAT CHANGED ON 2026-09-07, AND WHY THIS ASSERTION IS NARROWER NOW. Every arm used to be handed
# `sha`, `version` AND `prerelease`, and each re-derived the same fork from that bit - one fact
# tested in eight places down the tree. The fork is resolved ONCE in `release.yml` now and handed
# down as a NAME, so what an arm declares follows what it actually decides:
#
#   build.yml        sha, version, estate      - the name picks the frontend secrets and the tag
#   serve-dev.yml    sha, version, ...         - knows nothing of release kinds; it IS the dev estate
#   serve-prod.yml   sha, version, ...         - likewise
#   android.yml      sha, version, prerelease  - a store track IS a per-kind decision
#   ios.yml          sha, version, prerelease  - likewise
#
# `sha` and `version` are what all five need, so those stay asserted for all five.
for f in build.yml serve-dev.yml serve-prod.yml android.yml ios.yml; do
  if grep -qE '^  workflow_call:' "$WF/$f"; then
    pass "$f is callable"
  else
    fail "$f is not callable, so release.yml cannot use it"
  fi

  missing=''
  for i in sha version; do
    grep -qE "^      $i:" "$WF/$f" || missing="$missing $i"
  done
  if [ -z "$missing" ]; then
    pass "$f declares sha and version"
  else
    fail "$f is missing input(s):$missing - an arm that guesses one of these can ship to the wrong place"
  fi
done

# THE ESTATE WORKFLOWS MUST NOT KNOW WHAT A PRE-RELEASE IS, and that is the whole of the change. If
# either starts reading the release kind again, the fork has moved back down the tree and the
# structurally impossible rows come back with it.
for f in serve-dev.yml serve-prod.yml; do
  # CODE ONLY: the headers of those files QUOTE the six-line boolean they replaced, so grepping
  # the whole file would match the explanation of the very thing being asserted absent.
  CODE="$(grep -vE '^[[:space:]]*#' "$WF/$f" || true)"
  if grep -qE 'inputs\.(prerelease|phase)' <<<"$CODE"; then
    fail "$f reads the release kind - the fork belongs in release.yml, ONCE, as an estate name"
  else
    pass "$f never asks what kind of release this is"
  fi
done
printf '\nnothing on the release path resolves main for itself\n'
# =================================================================================================
# THE DEFECT THIS CLOSES. `main` is a MOVING reference and the bump's own push raises a `push`
# event, so CI runs on `main` while the release is still going; a pull request merged in those
# minutes lands inside the run. Every arm must build the SHA it was handed.
for f in build.yml serve-dev.yml serve-prod.yml android.yml ios.yml; do
  if grep -qE '^ +ref: main$' "$WF/$f"; then
    fail "$f checks out 'ref: main' - it would build whatever landed while the release was running"
  else
    pass "$f never checks out main by name"
  fi
done

# `serve-dev.yml` IS CHECKED DIFFERENTLY ON PURPOSE: it has no `ref:` because it does not use
# `actions/checkout` for the estate - it drives its own long-lived checkout to the commit with git.
# The question is the same one either way: does the file act on the commit it was handed?
for f in build.yml serve-dev.yml serve-prod.yml; do
  if grep -q 'inputs\.sha' "$WF/$f"; then
    pass "$f acts on the commit it was given"
  else
    fail "$f never references inputs.sha - it would act on whatever HEAD it found"
  fi
done
printf '\nthe gates run BEFORE the bump, and the bump before every arm\n'
# =================================================================================================
# THE ORDER IS THE FAIL-SAFE. Every arm needs the bump and the bump needs the preflight, so a
# refusal in the preflight refuses the deployment, both store uploads and the version bump itself.
if grep -qE '^    needs: preflight$' "$WF/release.yml"; then
  pass 'the bump needs the preflight'
else
  fail 'the bump does not need the preflight - the gates would run beside the release, not before it'
fi

# NAMED, NOT COUNTED, since 2026-09-03. This used to ask whether EXACTLY THREE jobs declare
# `needs: [preflight, bump]`, which answered the right question only while the file held exactly
# three such jobs: adding the release-notes job - which legitimately needs both, and which nothing
# depends on - broke an assertion about the store arms by changing the POPULATION rather than the
# property. *A predicate that named the last incident is not the predicate that names the next one.*
#
# AND DERIVED RATHER THAN LISTED, since 2026-09-07. It then named the three facts every arm is
# handed - version, prerelease, sha - which held only while every arm was handed the same three. The
# fork moved up to `release.yml` and the arms stopped being symmetric: `build` takes an estate NAME,
# the two estate workflows take neither a kind nor an estate, and only the store arms still need the
# release kind. A test listing what an arm receives would have to be edited every time an arm's
# inputs change, which is how a test gets weakened rather than read.
#
# SO THE PROPERTY IS DERIVED FROM THE FILE. A job may only READ `needs.<job>` for a job it DECLARES,
# and the failure mode is what makes this worth a test: reading an undeclared job yields an EMPTY
# STRING, not an error. That was live for the length of one commit - the arms declared `needs: bump`
# and read `needs.preflight.outputs.prerelease`, so every arm would have received `prerelease: ''`.
# For a stable that is accidentally right; for an ALPHA it is catastrophic and silent, because
# `ios.yml` and `android.yml` would have taken the `else` branch, baked the PRODUCTION origin into a
# tester build, and passed their own "is this pointing at the right estate" assertion while doing
# it. Green run, tester build against production.
#
# Each arm's block is cut from its own key to the next job key at the same indentation, which is why
# the anchoring matters: `needs.preflight.outputs.version` appears inside the bump job's steps too,
# where it is legitimate.
for arm in build serve-dev serve-prod android ios; do
  BLOCK="$(sed -n "/^  $arm:\$/,/^  [a-z][a-z-]*:\$/p" "$WF/release.yml")"
  DECLARED="$(grep -oE '^    needs: .*$' <<<"$BLOCK" | sed 's/^    needs: //' | tr -d '[]' | tr ',' ' ')"

  # Every arm reads the preflight's answers and the bump's sha, so every arm must declare both.
  for want in preflight bump; do
    case " $DECLARED " in
      *" $want "*) pass "the $arm arm needs the $want" ;;
      *) fail "the $arm arm does not declare '$want' among its needs - it reads its outputs and would receive an EMPTY STRING" ;;
    esac
  done

  READS="$(grep -oE 'needs\.[a-z-]+\.outputs' <<<"$BLOCK" | sed 's/needs\.//; s/\.outputs//' | sort -u | tr '\n' ' ')"
  undeclared=''
  for j in $READS; do
    case " $DECLARED " in
      *" $j "*) ;;
      *) undeclared="$undeclared $j" ;;
    esac
  done
  if [ -z "${undeclared// /}" ]; then
    pass "the $arm arm reads only jobs it declares (${READS% })"
  else
    fail "the $arm arm reads needs.$undeclared without declaring it - that is an EMPTY STRING, not an error, and it is silent"
  fi
done

printf '\nthe web never serves a version a store refused\n'
# =================================================================================================
# THE DEFECT THIS CLOSES (user, 2026-09-03: *"j'aimerais que toutes les versions soient toujours
# alignees"*). Until 2026-09-04 the three arms were siblings: production deployed whatever the bump
# produced, and a mobile arm that failed - a refused `.aab`, an App Store submission answered with a
# 500 on `v0.16.1` - left the web a version ahead of every phone, with nothing saying so.
#
# THE TWO ESTATES ARE TWO SEPARATE CALLS, and that is what makes the gate expressible at all: a
# called workflow cannot depend on a job of its caller, so gating one shared call would have held
# the dev estate back too.
#
# CAPTURED, THEN MATCHED WITH A HERESTRING - AND `| grep -q` HERE IS A REAL DEFECT, NOT A STYLE.
# `set -o pipefail` is on (line 25), and `grep -q` EXITS THE INSTANT IT MATCHES: the `sed` upstream
# is then killed by SIGPIPE and exits 141, so the PIPELINE reports failure precisely when the match
# SUCCEEDED. It bites only when the left-hand side is bigger than the pipe buffer or slower than
# grep, which is why the same idiom passes elsewhere in this suite on smaller blocks. It was
# measured: green on this workstation (MSYS bash does not deliver SIGPIPE the same way) and RED on
# Ubuntu in CI, on two assertions whose condition was in fact satisfied.
PROD_BLOCK="$(sed -n '/^  serve-prod:$/,/^  [a-z][a-z-]*:$/p' "$WF/release.yml")"
DEV_BLOCK="$(sed -n '/^  serve-dev:$/,/^  [a-z][a-z-]*:$/p' "$WF/release.yml")"

if grep -qE '^    needs: \[preflight, bump, build, android, ios\]$' <<<"$PROD_BLOCK"; then
  pass 'the production estate waits for the build AND for both stores'
else
  fail 'release.yml has no serve-prod arm needing [preflight, bump, build, android, ios] - the web can go ahead of the stores again'
fi

# `always()` HERE WOULD BE THE WHOLE DEFECT BACK. A success dependency is what makes a failed store
# arm stop production; `always()` plus a result test is how a gate becomes a formality, and it is a
# shape used LEGITIMATELY inside build.yml, so it would read as idiomatic here.
if grep -q 'always()' <<<"$PROD_BLOCK"; then
  fail 'the production arm uses always() - a failed store arm would no longer stop the web deploy'
else
  pass 'the production arm has no always() - a failed store arm leaves it skipped'
fi

# AND THE DEV ESTATE IS NOT BEHIND THE STORES. It never was, and the reason survives the rewrite:
# dev is where somebody looks first, an alpha has no production estate to get ahead of, and holding
# it a quarter of an hour behind two store queues would buy nothing.
if grep -qE '^    needs: .*(android|ios)' <<<"$DEV_BLOCK"; then
  fail 'serve-dev waits for a store - an alpha would sit behind queues it does not use'
else
  pass 'the dev estate does not wait for a store'
fi

# =================================================================================================
# THE FORK HAPPENS ONCE, AND HIGH (user, 2026-09-07: *"faire la dichotomie plus tot dans
# l'arborescence"*)
# =================================================================================================
# The release kind was resolved in `preflight` and then carried down as `prerelease` and re-tested
# in eight places, each callee re-deriving the same fork. It becomes an estate NAME once, here.
n="$(grep -cE '^      estate: ' "$WF/release.yml")"
if [ "$n" -eq 1 ]; then
  pass 'the release kind becomes an estate name in exactly one place'
else
  fail "release.yml resolves an estate in $n place(s), not 1 - the dichotomy has spread back down the tree"
fi

# NO LIBRARY IS CALLED TWICE, WHICH IS WHAT MANUFACTURED THE IMPOSSIBLE ROWS. GitHub materialises
# EVERY job of a called workflow as a row in the run graph, including jobs whose `if:` cannot hold
# on that call. `deploy.yml` was one file with a `phase: build | production` switch called twice, so
# each call drew the other call's jobs as skipped rows that were not "not taken this time" but
# INCAPABLE of running. Measured on v0.16.4 (run 34057019347), the last stable to reach the end: 22
# rows, 5 skipped, 4 of those 5 structurally impossible.
DUPES="$(grep -oE 'uses: \./\.github/workflows/[a-z-]+\.yml' "$WF/release.yml" | sort | uniq -d | tr '\n' ' ')"
if [ -z "${DUPES// /}" ]; then
  pass 'no workflow is called twice - every row a release draws is a row that can run'
else
  fail "release.yml calls the same workflow more than once ($DUPES) - the jobs the other call gates off will be drawn as structurally impossible skipped rows"
fi

if grep -qE 'bash \.github/scripts/release-preflight\.sh' "$WF/release.yml"; then
  pass 'the preflight script is actually invoked, not merely present in the tree'
else
  fail 'release.yml does not run release-preflight.sh - the four gates would be dead code'
fi

printf '\nand the preflight still asks the question that makes the lag impossible\n'
# =================================================================================================
# A gate can be deleted by deleting one `case` arm, and the release would go on being green. This
# names the arm.
PF="$HERE/../release-preflight.sh"
if grep -q 'dev-deployed' "$PF" && grep -q 'classify_dev_coverage' "$PF"; then
  pass 'it reads the dev-deployed marker and classifies coverage'
else
  fail 'the dev-coverage gate is gone from release-preflight.sh - production could go ahead of dev again'
fi

if grep -q 'PRODUCTION CANNOT BE AHEAD OF DEV' "$PF"; then
  pass 'and it says what to do about it, which is the half a refusal is useless without'
else
  fail 'the refusal no longer tells the reader to publish a pre-release first'
fi


printf '\nONE arming mechanism, covering every pull request, with the credential releases depend on\n'
# =================================================================================================
# THE TRAP THIS NAMES. Auto-merge merges as whoever armed it, and a merge made by `GITHUB_TOKEN`
# raises NO `push` event - so the CI workflow would never run on `main`, the merge commit would
# carry no `CI passed` check, and the preflight's third gate would then refuse EVERY release on a
# commit that had in fact been tested. Someone "simplifying" this file to the default token would
# break the release chain from a file that has nothing to do with releasing.
AM="$WF/arm-auto-merge.yml"

# TWO ARMING POINTS WAS THE OLD SHAPE, and it is the thing this section now refuses to let back.
# Arming lived in the CI workflow (`pull-request.yml`, renamed `ci.yml` on 2026-09-04) for humans
# and in a 448-line hourly sweep for Dependabot,
# because a `pull_request` run from Dependabot has no secrets. `pull_request_target` has them, for
# every pull request, so one file covers the whole population.
for gone in dependabot-auto-merge.yml auto-merge.yml; do
  if [ -e "$WF/$gone" ]; then
    fail "$gone is back - two arming mechanisms is what this repository already paid for once, in an hourly cron nobody could read and a mail every hour it failed"
  else
    pass "$gone is gone"
  fi
done

if grep -qE '^  arm-auto-merge:$' "$WF/ci.yml"; then
  fail 'ci.yml arms again - that job can only ever cover HUMAN pull requests, because a Dependabot run there has no secrets, and covering the other half is what created the second mechanism'
else
  pass 'ci.yml no longer arms - one file does, for everybody'
fi

if [ -r "$AM" ]; then
  # THE CODE, WITHOUT THE PROSE, AND MATCHED WITH A HERESTRING RATHER THAN THROUGH A PIPE - the
  # second half is not style. `set -o pipefail` is on and `grep -q` exits the instant it matches,
  # so a producer upstream is killed by SIGPIPE and the PIPELINE reports failure exactly when the
  # match SUCCEEDED. Measured elsewhere in this file: green here, red on Ubuntu, nothing naming why.
  #
  # THE CODE, WITHOUT THE PROSE. Every assertion below reads this rather than the file: the
  # comments here spell out the very conditions being asserted, so a file-wide grep answers "is
  # this idea written down" instead of "is it done" - and passes on the explanation of a
  # condition somebody deleted. Measured, twice, while writing this section.
  AM_CODE="$(grep -vE '^ *#' "$AM")"

  if grep -qE '^  pull_request_target:$' <<<"$AM_CODE"; then
    pass 'it runs on pull_request_target, which is the only context where Dependabot pull requests can reach a secret'
  else
    fail 'arm-auto-merge.yml does not run on pull_request_target - Dependabot pull requests would be armed by nobody'
  fi

  # `pull_request_target` IS SAFE HERE FOR EXACTLY ONE REASON, AND THIS IS THAT REASON ASSERTED.
  # The trigger runs with the base repository's secrets; checking out the pull request would then
  # execute untrusted code with them. This job calls `gh pr merge` and nothing else.
  if grep -qE '^ *- uses: actions/checkout' <<<"$AM_CODE"; then
    fail 'arm-auto-merge.yml checks something out - under pull_request_target that runs untrusted code WITH the repository secrets, which is the one thing that trigger must never do'
  else
    pass 'it checks nothing out, which is what makes pull_request_target safe here'
  fi

  if grep -q 'create-github-app-token' <<<"$AM_CODE"; then
    pass 'it mints the App token, whose merge raises a push event'
  else
    fail 'arm-auto-merge.yml no longer mints an App token - a GITHUB_TOKEN merge raises no push, so main gets no CI run and every release is then refused'
  fi

  if grep -qE 'GH_TOKEN: \$\{\{ (secrets\.)?GITHUB_TOKEN \}\}|GH_TOKEN: \$\{\{ github\.token \}\}' <<<"$AM_CODE"; then
    fail 'it arms with GITHUB_TOKEN - see above, this silently refuses every later release'
  else
    pass 'it does not arm with GITHUB_TOKEN'
  fi

  # DEPENDABOT IS NOW INCLUDED, AND THE ASSERTION FLIPPED WITH THE MECHANISM. It was excluded while
  # native auto-merge would have walked past the ceiling; since 2026-09-03 `dependency-ceiling` is a
  # job feeding `ci-passed`, so an update with no gate cannot merge BY ANY ROUTE and arming it is
  # safe. That check being binding is asserted in the next section, and the two must move together.
  if grep -q "github.event.pull_request.user.login == 'dependabot\[bot\]'" <<<"$AM_CODE"; then
    pass 'Dependabot is armed by name, which is the population this file exists for'
  else
    fail 'arm-auto-merge.yml does not name Dependabot - its pull requests would be armed by nobody, and the hourly sweep would come back'
  fi

  # THE TRUST BOUNDARY. A branch inside this repository required push access to create; a fork's
  # did not. Arming a fork's pull request would hand a stranger the merge the moment CI is green.
  if grep -q 'head.repo.full_name == github.repository' <<<"$AM_CODE"; then
    pass 'only a branch living in this repository is armed - a fork is merged by a human'
  else
    fail 'arm-auto-merge.yml arms pull requests from forks - CI green would then merge code from anybody'
  fi

  # THE ARMING MUST NOT DEPEND ON THE TESTS. `--auto` hands the decision to GitHub; waiting for the
  # suite would hold a runner for its whole length and would still have to re-read the checks, and
  # a job that merges on its own reading of green is a second opinion about which jobs matter.
  if grep -qE '^    needs:' <<<"$AM_CODE"; then
    fail 'the arming declares needs: - it must run in PARALLEL with the suite, because it declares intent rather than reading a verdict'
  else
    pass 'the arming runs in parallel with the suite, which is what --auto is for'
  fi

  if grep -qE 'pr merge [^|]*--auto' <<<"$AM_CODE"; then
    pass 'it arms and holds no opinion about green - GitHub reads CI passed, the one check the ruleset requires'
  else
    fail 'the arming does not use --auto - it would be merging on its own reading of green, a second opinion beside the required check'
  fi

  if grep -q -- '--delete-branch' <<<"$AM_CODE"; then
    fail 'the arming passes --delete-branch, which does NOTHING with --auto: gh deletes only after a merge IT made, and #329 and #330 both left their branches behind while the flag sat there looking like it worked'
  else
    pass 'no --delete-branch, which does nothing with --auto - the repository setting deletes the branch'
  fi
else
  fail 'arm-auto-merge.yml is gone - a green pull request would wait for a human who decides nothing'
fi

# NOBODY IS ASSIGNED TO A PULL REQUEST HERE (user, 2026-09-04: *"je ne veux plus etre assigne aux
# PR etc, je ne veux plus recevoir les mails"*). CODEOWNERS requested a review from two humans on
# every pull request, in a repository whose written model is that no approval is required - a
# mention per pull request, per push, for a queue nobody was ever meant to drain.
if [ -e "$HERE/../../CODEOWNERS" ]; then
  fail 'CODEOWNERS is back - it requests a review from a human on every pull request, and this repository requires no approval, so every one of those is a notification about a decision nobody makes'
else
  pass 'no CODEOWNERS - nobody is assigned to a pull request that merges itself'
fi

printf '\nthe release package tells a pre-release from a stable by the EVENT, and refuses a mismatch\n'
# =================================================================================================
# THE TRAP THIS CLOSES. The version string and the "Set as a pre-release" checkbox are two
# independent statements a human makes on one form, and until 2026-09-03 only the version was read -
# `published` fires for both kinds, so the checkbox was invisible. Ticking it on a `v0.17.0`
# silently deployed PRODUCTION; forgetting it on a `v0.17.0-alpha.1` silently pushed a tester build
# to the production channels. Neither is visible in a green run, and the French guide could only
# warn about it in prose.
#
# `prereleased` and `released` fire for exactly one kind each, so both statements now arrive and can
# be compared.
RY="$WF/release.yml"
if grep -qE '^    types: \[prereleased, released\]$' "$RY"; then
  pass 'release.yml listens for the two event types GitHub tells apart'
else
  fail 'release.yml no longer listens for [prereleased, released] - with the published event the checkbox is invisible again and only the version speaks'
fi

if grep -q 'github.event.action' "$RY"; then
  pass 'it reads the event action, which is the checkbox as GitHub read it'
else
  fail 'release.yml does not read github.event.action - it cannot know what the checkbox said'
fi

for phrase in 'flagged PRE-RELEASE but its version' 'NOT flagged as a pre-release but its version'; do
  if grep -qF "$phrase" "$RY"; then
    pass "a mismatch is refused and names both sides ($phrase...)"
  else
    fail "release.yml no longer refuses the mismatch '$phrase' - the estate would be chosen by whichever statement it happens to read"
  fi
done

# A CORRECT CHECK THAT PRINTS NOTHING CANNOT BE TOLD FROM ONE THAT NEVER RAN. Measured on the
# `v0.16.0-alpha.2` run: the preflight log carried an `ok` line for each of the five gates and
# NOTHING for this cross-check, which refuses loudly and passed in silence - so a reader of a green
# run had no way to tell the two statements had been compared rather than skipped by a fall-through.
if grep -qE '^ +AGREEMENT=' "$RY" && grep -qE '^ +echo "  ok +.AGREEMENT"' "$RY"; then
  pass 'the cross-check REPORTS its verdict, so a green run shows that it ran'
else
  fail 'the cross-check produces no output when it passes - indistinguishable from a check that was skipped, which is what the report rule exists to forbid'
fi

# AND EVERY PASSING ARM MUST SET IT. The report reads the variable under `set -u`, so an arm that
# forgets it turns a perfectly good release into an unbound-variable failure on the step's last
# line - after the version has been resolved and before anything has been built.
AGREEMENT_ARMS="$(grep -cE '^ +AGREEMENT=' "$RY")"
if [ "$AGREEMENT_ARMS" -eq 3 ]; then
  pass 'all three passing arms set it - dispatch, prereleased, released'
else
  fail "$AGREEMENT_ARMS arm(s) set AGREEMENT, expected 3 - an arm that does not set it fails the step under set -u instead of releasing"
fi

printf '\nno step in an arm is gated on an event that can never happen there\n'
# =================================================================================================
# THE DEFECT THIS EXISTS FOR, AND IT WAS MINE. Collapsing the chain into one run made four steps
# permanently unreachable in a single stroke: `if: github.event_name == 'workflow_run'` guarded both
# "Upload to Release" steps, the TestFlight upload and the Play publish - and in a `workflow_call`
# workflow `github.event_name` is the CALLER's event, which is `release` or `workflow_dispatch` and
# never `workflow_run`. The build would have succeeded, the run would have been green, and NO STORE
# WOULD HAVE RECEIVED ANYTHING.
#
# The shape test as first written did not catch it, because it asked about triggers and inputs and
# not about the conditions on steps. A condition that cannot be true is the same class of defect as
# a required check that is always skipped: invisible, green, and load-bearing.
for f in build.yml serve-dev.yml serve-prod.yml android.yml ios.yml; do
  if grep -qE "^\s+if:.*github\.event_name\s*==\s*'workflow_run'" "$WF/$f"; then
    fail "$f gates a step on github.event_name == 'workflow_run', which is NEVER true in a called workflow - the step is dead and its run stays green"
  else
    pass "$f has no step gated on a workflow_run event"
  fi

  if grep -qE "^\s+if:.*github\.event\.workflow_run\." "$WF/$f"; then
    fail "$f reads github.event.workflow_run.*, which does not exist on the caller's event"
  else
    pass "$f reads no workflow_run event payload"
  fi
done

# And what replaced that reasoning is DATA. `publish` is passed by the caller instead of inferred
# from an event the called workflow cannot see: `release.yml` takes the callable default `true`, and
# a hand dispatch of an arm defaults it to `false`.
#
# WHY AN ARM IS HAND-DISPATCHABLE AT ALL, since one entry point is the whole point of this file: it
# is the ONLY way to compile Swift, ObjC or Kotlin from the Windows workstation this project is
# developed on. A Swift `guard` body that falls through, a Kotlin nested type in a companion object,
# a plugin command missing from its ACL - none is visible to `cargo clippy`, `bun run check` or any
# gate that runs locally. Collapsing the chain removed that trigger for a commit, which would have
# taken the capability away silently; `publish: false` is what makes it a compile check rather than
# a second door to the stores.
for f in android.yml ios.yml; do
  if grep -qE "^  workflow_dispatch:$" "$WF/$f"; then
    pass "$f can be dispatched by hand, which is the only native compiler available off macOS"
  else
    fail "$f cannot be dispatched - there is then no way to compile Swift or Kotlin without publishing a release"
  fi

  # THE DISPATCH MUST DEFAULT TO SHIPPING NOTHING. A compile check that reached a store would be
  # worse than no compile check, and the default is the whole guard: nobody types `publish: false`.
  if grep -A3 -E "^      publish:" "$WF/$f" | grep -qE "^        default: false$"; then
    pass "$f's dispatch defaults publish to false, so a compile check ships nothing"
  else
    fail "$f's hand dispatch does not default publish to false - a compile check would reach a real store"
  fi

  # Every step that reaches outward reads that input. An ungated one turns the compile check into a
  # release, and the run would be green either way.
  OUTWARD="$(grep -cE "^\s+if: inputs\.publish" "$WF/$f")"
  if [ "$OUTWARD" -ge 2 ]; then
    pass "$f gates its outward steps on inputs.publish ($OUTWARD of them)"
  else
    fail "$f has $OUTWARD step(s) gated on inputs.publish - a hand-dispatched compile check would publish"
  fi

  # And attaching an artefact to a release that does not exist would CREATE one, which would publish
  # a release, which would start the whole chain again. So that one step needs BOTH conditions.
  if grep -qE "^\s+if: inputs\.publish && github\.event_name == 'release'$" "$WF/$f"; then
    pass "$f attaches its artefact only on a real published release"
  else
    fail "$f no longer guards its release upload - a hand-dispatched run would CREATE a release and restart the chain"
  fi
done
printf '\nthe store is served BEFORE the release asset, in both arms\n'
# =================================================================================================
# WHAT THIS COST, MEASURED ON `v0.16.0`. `Upload to Release` sat before the store steps in both
# arms. On the stable it was refused a release update - `Resource not accessible by integration`,
# with `Contents: write` granted and printed by the runner - and `Upload to TestFlight` and the App
# Store submission were both `skipped` behind it. Production and Google Play received 0.16.0; Apple
# received nothing. The Android arm had the identical ordering and merely happened to succeed,
# which is a race that heals cleanly and is still a defect.
#
# A GITHUB RELEASE ASSET IS A CONVENIENCE; THE STORE IS THE DELIVERABLE. The assertion is on the
# ORDER and not on a `continue-on-error`, because swallowing the failure would hide it - a refusal
# there must still fail the job, and now it fails one having already shipped.
#
# `grep -n` and not a parser: the line NUMBER is the ordering, and that is the whole property.
order_ok() {
  local file="$1" store_step="$2" asset_step="$3" label="$4" store asset
  store="$(grep -nF "      - name: $store_step" "$file" | head -1 | cut -d: -f1)"
  asset="$(grep -nF "      - name: $asset_step" "$file" | head -1 | cut -d: -f1)"
  if [ -z "$store" ] || [ -z "$asset" ]; then
    fail "$label - one of the two steps is gone (store=${store:-missing} asset=${asset:-missing})"
  elif [ "$store" -lt "$asset" ]; then
    pass "$label (store at line $store, release asset at $asset)"
  else
    fail "$label - the release asset is at line $asset, BEFORE the store step at $store: a refusal there skips the store, which is how 0.16.0 reached production and Google Play but not Apple"
  fi
}

order_ok "$WF/ios.yml" 'Upload to TestFlight / App Store Connect' 'Upload to Release' \
  'iOS reaches TestFlight before it touches the GitHub release'
order_ok "$WF/ios.yml" 'Create the App Store version, attach the build, and submit for review' 'Upload to Release' \
  'and it submits for review before it touches the GitHub release'
order_ok "$WF/android.yml" 'Publish to Google Play' 'Upload to Release' \
  'Android reaches Google Play before it touches the GitHub release'

# AND NEITHER MAY BE MADE NON-FATAL INSTEAD. `continue-on-error` on the asset upload would pass the
# ordering assertion above while re-introducing exactly the invisibility the ordering removes.
for f in ios android; do
  if sed -n '/^      - name: Upload to Release$/,/^      - name:/p' "$WF/$f.yml" | grep -qE '^ +continue-on-error:'; then
    fail "$f.yml makes the release asset upload non-fatal - a swallowed refusal is worse than the skipped store it replaced"
  else
    pass "$f.yml still fails loudly if the release asset cannot be attached"
  fi
done

# AND NEITHER MAY ASK TO *UPDATE* THE RELEASE, WHICH IS THE ONLY CALL EITHER WAS EVER REFUSED.
# `softprops/action-gh-release` finds the release and then PATCHES it, and the 403 that cost Apple
# 0.16.0 named that PATCH - `update-a-release` - with `Contents: write` granted and printed by the
# runner. Attaching a file needs no release update, so the capability that was refused is one
# neither step ever wanted. Re-introducing the action would restore the dependency whether or not
# the refusal's cause is ever explained, and the two are separate: the cause is still unmeasured.
for f in ios android; do
  block="$(sed -n '/^      - name: Upload to Release$/,/^      - name:/p' "$WF/$f.yml")"
  if printf '%s' "$block" | grep -qE '^ +uses:'; then
    fail "$f.yml attaches the release asset through an ACTION again - if it updates the release, it re-adds the capability that was refused on 0.16.0"
  else
    pass "$f.yml attaches the asset with no action, so it asks for no release update"
  fi
  if printf '%s' "$block" | grep -q 'gh release upload'; then
    pass "$f.yml uses the one call the job actually needs"
  else
    fail "$f.yml no longer attaches the asset with 'gh release upload' - name what replaced it and why it needs no PATCH"
  fi
done

printf '\nevery arm is granted what it asks for, because a caller CAPS a called workflow\n'
# =================================================================================================
# THE DEFECT THIS EXISTS FOR, and it killed the first real release. A called workflow cannot be
# granted more than its caller grants it, and exceeding that is a STARTUP FAILURE: no job runs, no
# log is produced, and the API returns neither an annotation nor an error message. `release.yml`
# declares `permissions: contents: read` at the workflow level - right for `preflight` and for
# `bump`, which pushes with an App token rather than `GITHUB_TOKEN` - and that silently capped all
# three arms. `v0.16.0-alpha.1` was published and the run died before its first job.
#
# IT IS CREATED BY THE COLLAPSE. As four independently triggered workflows there was no caller to
# cap anything and each simply got what it declared; turning them into called workflows introduced a
# ceiling that had never existed, and nothing in the tree said so.
#
# SO THIS IS DERIVED FROM BOTH SIDES rather than typed: it reads every `<scope>: write` each callee
# asks for and demands the same line inside the caller's job for it. Adding a scope to an arm fails
# this test until the caller grants it, which is the only ordering that cannot ship broken.
for pair in 'build build.yml' 'serve-dev serve-dev.yml' 'serve-prod serve-prod.yml' 'android android.yml' 'ios ios.yml'; do
  job="${pair%% *}"
  wf="${pair##* }"

  # The scopes the callee asks for, anywhere in it: `permissions:` blocks are per job there.
  WANTED="$(grep -oE '^ +[a-z-]+: write$' "$WF/$wf" | tr -d ' ' | sort -u)"
  # The caller's block for this job: from its key to the next job key at the same indentation.
  GRANTED="$(sed -n "/^  $job:\$/,/^  [a-z][a-z-]*:\$/p" "$WF/release.yml" \
    | grep -oE '^ +[a-z-]+: write$' | tr -d ' ' | sort -u)"

  if [ -z "$WANTED" ]; then
    fail "$wf asks for no write scope at all - it cannot attach an artefact or move a marker"
    continue
  fi

  missing="$(comm -23 <(echo "$WANTED") <(echo "$GRANTED") | tr '\n' ' ')"
  if [ -z "${missing// /}" ]; then
    pass "release.yml grants $job everything $wf asks for ($(echo "$WANTED" | tr '\n' ' '))"
  else
    fail "$wf asks for $missing and release.yml's '$job' job does not grant it - THE RUN WILL FAIL AT STARTUP, with no log and no annotation"
  fi
done

printf '\nboth stores are reached all the way, and iOS no longer stops at TestFlight\n'
# =================================================================================================
# THE ASYMMETRY THIS CLOSES. `altool --upload-app` hands Apple the binary and stops; the binary
# lands in TestFlight. For a stable that left the release one MANUAL gesture short of shipped -
# create the version, attach the build, press Submit - while the same release put Android on the
# Play `production` track by itself. Nothing asked for that gesture and nothing reported its
# absence, so a stable release was half-shipped by construction.
# THE CLAIM IS "IT SUBMITS", NOT "IT SUBMITS WITH NODE". The runtime was baked into this pattern
# incidentally and made the assertion fail the day the call moved to bun - a test that breaks on a
# change it is not about is a test that gets weakened rather than read.
if grep -qE '(node|bun) tools/app-store/submit\.mjs' "$WF/ios.yml"; then
  pass 'ios.yml submits the version for review after the upload'
else
  fail 'ios.yml no longer submits - a stable release would stop at TestFlight and wait for a human nothing reminds'
fi

# ONLY FOR A STABLE, and not as a policy: `versionString` is a marketing version and Apple refuses
# `0.15.0-alpha.1` outright. A pre-release's destination IS TestFlight.
if grep -qE "^\s+if: inputs\.publish && inputs\.prerelease == 'false' && steps\.testflight\.outputs\.uploaded == 'true'$" "$WF/ios.yml"; then
  pass 'and only for a publishing run, on a stable, whose upload actually happened'
else
  fail 'the submission is no longer gated on a stable with a completed upload - it would submit an alpha, which Apple refuses, or a build it never sent'
fi

# THE BUILD NUMBER MUST COME OFF THE ARCHIVE. Recomputing the store band here would be a second
# implementation of `scripts/bump-app-version.sh`'s formula, and the two would disagree silently:
# the submission would poll for a build number nobody uploaded until it gave up 45 minutes later.
if grep -q 'ApplicationProperties:CFBundleVersion' "$WF/ios.yml"; then
  pass 'the build number is read off the archive that was signed, not recomputed'
else
  fail 'ios.yml no longer reads CFBundleVersion from the archive - a recomputed band can name a build that does not exist'
fi

# And the notes gate must stay in the PREFLIGHT, where a refusal costs seconds rather than a
# production deploy, a Play publish and a twenty-minute macOS build.
if grep -q 'submit\.mjs --check-notes' "$PF"; then
  pass 'the release notes are checked before anything moves, by the same code that submits them'
else
  fail 'the preflight no longer checks the release notes - Apple would refuse the submission at the END of a release, after the other store had already shipped'
fi

printf '\na failed release arm can be re-run, which is the recovery every comment points at\n'
# =================================================================================================
# THE CASE, 2026-09-03. `v0.16.1` failed on the LAST request of the App Store chain - the build
# uploaded, the version created, the notes written, and the submission in fact SUBMITTED, Apple
# having lost the response rather than refused the write. A red job over a shipped release; and the
# documented recovery, "Re-run failed jobs", could not even be attempted: the build number is
# derived from the version, so the re-run would upload the same CFBundleVersion and die on Apple's
# `ITMS-4238 Redundant Binary Upload` several steps before the one that needed retrying. A recovery
# door every comment in this chain points at, and nobody had opened.
if grep -qE 'ITMS-4238\|Redundant Binary Upload' "$WF/ios.yml"; then
  pass 'a build Apple already holds is this step postcondition, not its failure'
else
  fail 'ios.yml treats a redundant upload as a failure - "Re-run failed jobs" cannot reach the submission step'
fi

# AND THE NARROWNESS IS THE POINT. Every other altool failure must still fail the step; a check
# that swallowed any error mentioning the build would launder a validation rejection into green.
if grep -qE 'UPLOAD FAILED\|Error Domain=\|VALIDATION_ERROR' "$WF/ios.yml"; then
  pass 'and every other altool failure still fails the step'
else
  fail 'ios.yml no longer reads altool own failure markers - a rejected upload would report success'
fi

# THE OTHER HALF OF THE SAME INCIDENT: the 500 itself. `submit.mjs` retries what Apple never
# answered, and NEVER retries a POST - a 500 there leaves it unknown whether the review submission
# was created, and a retry would quietly make a second one.
SUBMIT="$HERE/../../../tools/app-store/submit.mjs"
if grep -q 'export function shouldRetry' "$SUBMIT"; then
  pass 'submit.mjs classifies a refusal as an answer or as a failure to answer'
else
  fail 'submit.mjs has no retry policy - a 500 from Apple loses the whole submission again'
fi

if grep -qE "IDEMPOTENT_METHODS = new Set\(\['GET', 'HEAD', 'PATCH', 'PUT', 'DELETE'\]\)" "$SUBMIT"; then
  pass 'and POST is not in the idempotent set, so a 500 there is never retried'
else
  fail 'submit.mjs would retry a POST - a 500 on POST /reviewSubmissions could create a second submission'
fi

printf '\nthe dependency ceiling is a CHECK, and it is binding\n'
# =================================================================================================
# WHAT THIS REPLACES, AND WHY IT HAD TO BECOME A CHECK. Until 2026-09-03 the ceiling was asked only
# inside `dependabot-auto-merge.yml`, a SECOND merge mechanism beside GitHub's own auto-merge - so a
# Dependabot pull request and a human's took different routes to `main`, and only one was visible
# where a human looks (user: *"le auto-merge et les CI doivent considerer toutes les PR, les
# miennes ou dependabot"*). #309 is the case: `postgres 15-alpine -> 18-alpine`, fully GREEN and
# correctly refused, open for days.
#
# AND IT CORRECTS THE FIRST VERSION OF THIS COMMENT, which said the refusal was recorded nowhere on
# the pull request. It was - as a `github-actions` comment naming the missing test. What a CHECK
# adds is that the refusal becomes BINDING: a comment is absent from the checks list, unreadable by
# the merge machinery, and outside `ci-passed`, the one check the ruleset requires.
PR_WF="$WF/ci.yml"

if grep -qE '^  dependency-ceiling:$' "$PR_WF"; then
  pass 'the ceiling is a job of the pull-request package'
else
  fail 'there is no dependency-ceiling job - the ceiling is invisible on the pull request again'
fi

# BINDING MEANS `ci-passed` READS IT. `ci-passed` is the one check the branch ruleset requires, so a
# ceiling job outside its `needs` is a red tick nothing enforces - strictly worse than the sweep it
# replaced, because it LOOKS enforced.
if sed -n '/^  ci-passed:$/,/^  [a-z][a-z-]*:$/p' "$PR_WF" | grep -q 'dependency-ceiling'; then
  pass 'and ci-passed reads it, so an update with no gate cannot merge by ANY route'
else
  fail 'ci-passed does not read dependency-ceiling - the refusal would be advisory, and a red tick nothing enforces is worse than none because it looks enforced'
fi

# THE SWEEP IS GONE, AND WITH IT EVERY ASSERTION ABOUT IT (2026-09-04). Four blocks lived here:
# which of two stages the sweep was in, that it armed with the App token rather than merging on its
# own reading of green, that it no longer dispatched CI by hand, and that a REFUSED rebuild request
# was told apart from a pending one. All four described `dependabot-auto-merge.yml`, which no longer
# exists - `arm-auto-merge.yml` covers the whole population from one file, asserted above.
#
# WHAT WENT WITH IT, SO A LATER SESSION DOES NOT "RESTORE" IT. The sweep's one unique function was
# asking Dependabot to rebase a branch whose gates had moved, and that function DID NOT WORK: the
# ask was refused ten times out of ten, on eight pull requests and with two different identities,
# because `@dependabot rebase` authorises by PUSH ACCESS and an App installation is not an account
# with push access. So deleting it loses nothing that ran. The underlying question - can a pull
# request green on an older gate set still merge - is answered where it matters instead: this
# workflow also runs on `push: main`, so a merge that breaks the trunk turns `CI passed` red ON
# `main`, and `release-preflight.sh` gate 3 then refuses every release from that commit.

printf '\ngh api --slurp and --jq cannot be combined, and the error is easy to swallow\n'
# =================================================================================================
# MEASURED, NOT GUESSED: `the --slurp option is not supported with --jq or --template`. It is worth
# a gate because the two read as complementary and the failure is a usage message on stderr plus an
# EMPTY stdout - which a `|| echo '[]'` or a `2>/dev/null` turns into a plausible-looking answer.
# `--paginate` without `--slurp` and WITH `--jq` is a different trap in the same family: each page
# becomes its own document, so a thread past the first page is silently judged on page one.
SLURP_OFFENDERS=""
for f in "$WF"/*.yml "$HERE"/../*.sh "$HERE"/../lib/*.sh; do
  [ -r "$f" ] || continue
  # One physical line at a time: this pair is only wrong when it reaches the same invocation, and
  # a continued `gh api` line is what carries them there.
  if grep -nE 'gh api[^|]*--slurp[^|]*--jq|gh api[^|]*--jq[^|]*--slurp' "$f" >/dev/null 2>&1; then
    SLURP_OFFENDERS="$SLURP_OFFENDERS $(basename "$f")"
  fi
done
if [ -z "$SLURP_OFFENDERS" ]; then
  pass 'no gh api call combines --slurp with --jq'
else
  fail "these files combine gh api --slurp with --jq, which gh refuses with a usage message and an empty stdout:$SLURP_OFFENDERS"
fi

printf '\none changelog, three destinations, and ONE implementation of what valid notes are\n'
# =================================================================================================
# `store/whats-new.txt` is the one text a stable owes a human (user, 2026-09-03: the changelog can
# be the same on every platform, and in the GitHub console at the version bump). Until that day it
# reached ONE of the three: the App Store. **Google Play received no release notes at all** - the
# field simply kept whatever it held, and nothing anywhere said so, because a MISSING what's-new is
# silent where a wrong one is refused.
#
# WHAT THESE ASSERTIONS PROTECT IS NOT "the notes are sent" - it is that all three read the same
# file through the same implementation. Three readers of one file is three opinions about the
# version marker, the trim and the length ceiling, and they drift on the day the format changes.
NOTES_SRC='store/whats-new.txt'

# THE RULE HAS ONE IMPLEMENTATION AND IT IS `submit.mjs`. A second reader in shell is the defect
# this asserts against, so what is checked is that nothing else opens the file by name.
# A MENTION IS NOT A READ. The first draft of this grepped for the path and accused three files
# that merely NAME it in a comment saying where the notes come from - the opposite of the defect.
# So comment lines are dropped first: `#` for shell and YAML, `//` and a leading `*` for the JS.
# What survives is the path appearing in CODE, which is what a second reader looks like.
OTHER_READERS=""
for f in "$WF"/*.yml "$HERE"/../*.sh "$HERE"/../lib/*.sh; do
  [ -r "$f" ] || continue
  case "$(basename "$f")" in submit.mjs) continue ;; esac
  if grep -n "$NOTES_SRC" "$f" 2>/dev/null | grep -vE '^[0-9]+: *(#|//|\*)' | grep -q .; then
    OTHER_READERS="$OTHER_READERS $(basename "$f")"
  fi
done
if [ -z "$OTHER_READERS" ]; then
  pass 'nothing but submit.mjs reads the notes file in code'
else
  fail "these read the notes file directly instead of calling submit.mjs, which is a second opinion about what valid notes are:$OTHER_READERS"
fi

# DESTINATION 2 - GOOGLE PLAY. The action takes a DIRECTORY of `whatsnew-<LOCALE>` files; without
# that input it uploads a build and says nothing about what changed.
AND_WF="$WF/android.yml"
if [ -r "$AND_WF" ]; then
  if grep -q 'whatsNewDirectory:' "$AND_WF"; then
    pass 'the Play upload is given a whats-new directory'
  else
    fail 'the Play upload has no whatsNewDirectory - Android users are told nothing about what changed, and a MISSING whats-new file is silent where a wrong one is refused'
  fi
  if grep -q 'submit.mjs --print-notes' "$AND_WF"; then
    pass 'and it fills that directory through submit.mjs, not by re-parsing the file'
  else
    fail 'the Play arm does not call submit.mjs --print-notes, so the notes rule has a second implementation'
  fi
  # STABLE ONLY, and this is a property of the FILE: it opens with `version: X.Y.Z` naming the
  # stable, so an alpha cannot be described by it and `--print-notes` refuses one by construction.
  if grep -qE "prerelease == 'false'" "$AND_WF"; then
    pass 'and only on a stable, which is the only version the file can name'
  else
    fail 'the Play notes step is not gated on a stable - the notes file names the stable version, so an alpha would refuse it and fail the arm'
  fi
fi

# DESTINATION 3 - THE GITHUB RELEASE. And the ordering rule that cost a platform applies here too.
if grep -qE '^  notes:' "$WF/release.yml"; then
  pass 'the release notes reach the GitHub release too'

  # NOTHING MAY DEPEND ON IT. On v0.16.0 a refused release update `skipped` TestFlight and the App
  # Store submission behind it: production and Play shipped, Apple got nothing. A body is a
  # convenience; the stores are the deliverable. So this job runs BESIDE the three arms, and a
  # refusal - including a second instance of that unexplained 403 - can skip none of them.
  if grep -qE 'needs: .*notes' "$WF/release.yml"; then
    fail 'something NEEDS the release-notes job, so a refused release update can skip a store arm again - that is exactly what cost Apple v0.16.0'
  else
    pass 'and nothing depends on it, so a refusal can skip no store arm'
  fi

  if grep -q 'release-notes-body.sh' "$WF/release.yml"; then
    pass 'and the body is composed by the tested script, not by inline shell'
  else
    fail 'the release body is composed inline - its interesting inputs (a stale block, hollow markers) are ones a live release never produces, so they would never be exercised'
  fi
else
  fail 'no job puts the release notes on the GitHub release'
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
