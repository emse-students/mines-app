# store-divergence - did the last stable actually reach both stores?

A release publishes the web, Google Play and the App Store from one run. **Nothing used to ask
afterwards whether the stores got it.**

## The three days this exists to prevent

On 2026-09-04 the App Store submission stopped on an occupied version slot. Apple gives an app ONE
non-terminal version slot, so releasing faster than Apple reviews finds it held - the expected
outcome, and not a failure of anything. `submit.mjs` refused correctly (cancelling a review is a
human decision no script may take) but left through `exit 1`, exactly as it does for a real refusal.
`production` is a SUCCESS dependency on the iOS arm, so the web deploy was **skipped**.

It happened again on v0.16.3 and again on v0.16.4. Production sat on **v0.16.1 for three days** while
two releases reported themselves shipped, and it was found by a human noticing that a fix was not
live. The third of those was the WASM outage: its fix reached the web only because somebody deployed
it by hand.

The submission is no longer allowed to fail for that reason - `EXIT_SLOT_HELD` in
[`../app-store/submit.mjs`](../app-store/submit.mjs) - which fixes the web being held hostage **and
creates the gap this tool closes.** A deferral is green now, so a release can end with the build in
TestFlight, never submitted, and nothing would say so. *Making a failure quiet without adding a
report is how a three-day silence becomes a permanent one.*

## What it will not conflate

A store not carrying the version has four causes, and a human acts on each differently.

| verdict | meaning | the errand |
| --- | --- | --- |
| `live` | the store serves it | none |
| `pending` | it is WITH the store - Apple reviews in days | **none**, and saying otherwise daily is how a report teaches its reader to skip it |
| `not-submitted` | uploaded and never sent - the deferral | re-run the store job once the slot is free |
| `rejected` | the store said NO | read what they said, and fix it |
| `unknown` | the report could not look | fix the credential; **this is never a pass** |

`unknown` failing is deliberate. A credential that expires would otherwise turn the whole check into
a green light, which is the failure mode a report exists to prevent.

The App Store's rejection states are a set of their own in `submit.mjs` (`VERSION_REJECTED`) rather
than a second list here: they also belong to `VERSION_EDITABLE`, which is correct for the question
*that* asks - *may this release write into the slot?* - where a rejected version and an unsubmitted
one are equally writable. One list, spread into both readers, so they cannot drift.

## Running it

```sh
GH_TOKEN=$(gh auth token) bun tools/store-divergence/divergence.mjs
```

| variable | for |
| --- | --- |
| `GH_TOKEN` | reading the latest stable release |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_P8`, `APP_BUNDLE_ID` | the App Store half |
| `PLAY_SA_KEY` (a path) or the CI secret written to one | the Play half, via [`../play-vitals/lib.mjs`](../play-vitals/lib.mjs) |

Exit `0` when every store is `live` or `pending`; exit `1` otherwise, with a line naming which store
and why.

**In CI** it is the `stores` job of `scheduled.yml`, daily at 09:00 UTC, and by hand through that
workflow's dispatch menu. A red run is the report: nothing pages anybody in this estate, and
`gh run list` is what actually gets read.

## The one thing that was measured rather than assumed

Play's release `name` has **two** formats, seen on the real tracks on 2026-09-07:

```
production  name="0.16.5"             <- what our pipeline writes
beta        name="10012 (0.10.12)"    <- Play's own default naming, on older releases
```

An exact match alone reports the second absent; a substring match alone matches `0.16.5` inside
`0.16.50`. `matchesVersion` accepts the bare version or the parenthesised form, and
`divergence.test.mjs` asserts both plus the `0.16.50` trap.

## Tests

```sh
bun tools/store-divergence/divergence.test.mjs
```

34 assertions over the classification, which is the half that can be wrong silently. The HTTP calls
are not mocked: a fake that matches its own expectations asserts nothing.
