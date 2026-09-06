# Mobile architecture (Tauri)

**Stack**: Tauri 2 / Rust / SvelteKit  
**Source**: `frontend/src-tauri/`

Canari runs as a native mobile app on Android and iOS via Tauri 2, using the same SvelteKit frontend rendered in a WebView. This page documents mobile-specific architecture that extends the [frontend architecture](../architecture.md).

## Key differences from Web

| Aspect | Web (browser) | Tauri (mobile) |
|---|---|---|
| MLS | WASM (`WebMlsService`) | Native Rust (`TauriMlsService` via `invoke()`) |
| State storage | IndexedDB | Filesystem (`~/.canari/`) |
| HTTP | `fetch()` with cookies | `@tauri-apps/plugin-http` (bypasses CORS) |
| WebSocket auth | `canari_ws_token` cookie | `?token=` query param (cookie not sent on cross-origin WS) |
| MLS snapshot | Argon2 in worker thread → IndexedDB | Direct filesystem write under `mls_bin_write_lock` |
| Prekeys | 50 OTKPs | 200 OTKPs (more frequent offline periods) |
| Push notifications | — | FCM (Android), APNs via FCM (iOS) |

## Native MLS

`TauriMlsService` calls Rust functions via `invoke()` instead of WASM:

```typescript
// TauriMlsService.ts
async sendMessage(groupId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  return invoke('mls_send_message', { groupId, plaintext });
}
```

The Rust side is in `frontend/src-tauri/src/` (Tauri commands) and `frontend/mls-core/` (shared MLS logic, same crate used by WASM). `BaseMlsService` provides the shared `runCommitTransaction` / `stageAddMembers` / `mergePendingCommit` primitives that both `WebMlsService` and `TauriMlsService` extend.

> **The command name is an untyped string on both sides.** Nothing checks that the literal passed
> to `invoke()` matches a `#[tauri::command]` listed in `generate_handler!` in `lib.rs`; a stale or
> renamed name compiles, lints and type-checks, then fails only at runtime with "command not
> found". v0.11.0 shipped `initialiser_mls_avec_clef`, `sauvegarder_mls_et_persister_avec_clef` and
> `generer_key_packages_et_persister_avec_clef` against Rust commands that had kept their original
> names - every native MLS init, save and KeyPackage publication failed for as long as it was live.
> When renaming a command, grep both sides.
>
> The same hazard applies to **plugin** commands, with two extra ways to get it wrong: the prefix
> is the Tauri plugin name (`plugin:keystore|…`), not the Android class id, and the command must
> also appear in the plugin's `build.rs` ACL array. See
> [auth - calling the keystore plugin from JS](modules/auth.md).

### Device key on the biometric path

In biometric mode the at-rest key never reaches JS: `ctx.getDeviceKey()` stays `''` for the whole
session, so every `invoke` carries an empty `deviceKeyB64`. `initialiser_mls` resolves the key once
(`MlsManager::resolve_at_rest_key`, keystore Path A) and caches it in `AppState.device_key`; the
save and KeyPackage commands fall back to that cache. Resolving per call would instead fire one
`retrieve_device_key` BiometricPrompt per save.

### Tauri-specific MLS

- **Epoch caching**: `_epochByGroupId` + `refreshEpochCache()` — Tauri cannot read the WASM group directly, so epoch is cached and refreshed after each queue item, Welcome, and commit.
- **Queue priority**: `group_reset` control → Welcome queue → application queue.
- **Filesystem state**: MLS state persisted under `mls_bin_write_lock` (no IndexedDB).

### Local message store

Conversations, messages and the outbox live in `canari_<userId>.db`, opened by `SqliteStorage`
through `@tauri-apps/plugin-sql`. It is **frontend-only**: the native side owns a different
database, `mls_pending.db` (queued push payloads), so the two never contend for the same file.

`getStorage()` falls back to `IndexedDbStorage` when `SqliteStorage.init()` throws. That fallback
is a last resort, not a supported mode - it is a `console.warn` in a WebView, so a permanent
degradation looks exactly like a healthy start. Check for `[DB] Using SQLite storage (Tauri)` in
the logs to confirm the real backend.

**A migration outlives the schema it was written against.** Branches are keyed on
`PRAGMA user_version`, and a brand-new database starts at 0, so every historical branch runs on it.
The v1 -> v2 purge named a `salt` column that the deviceKeyB64 refactor had removed from
`CREATE TABLE messages`, and every fresh install threw `no such column: salt` and silently ran on
IndexedDB. Two rules follow, both enforced in `db/sqliteMigrations.ts` and its tests:

- A database created by the `CREATE TABLE IF NOT EXISTS` statements has nothing to migrate: stamp
  it at `SCHEMA_VERSION` and skip every branch. `user_version` alone cannot detect this - a
  pre-migration-system database also reports 0 - so the check reads `sqlite_master` **before** the
  creation statements run.
- A migration that inspects columns must build its statement from
  `PRAGMA table_info(...)`, so dropping a column can never break the migration that mentions it.

### Local storage usage (WP-DEVICESTORAGE-1)

Settings shows a breakdown of what Canari is using on the device, distinct from
[storage-forecast](../infrastructure/storage-forecast.md), which is the SERVER's disk. Two
measurement paths, because there is no single API that answers this on every platform:

- The media and association-logo Cache Storage buckets (`mediaBlobCache.ts`,
  `associationLogoCache.ts` - each exports its cache name for this reason) are measured and cleared
  identically everywhere: Cache Storage works inside the Tauri WebView too, and everything in them
  is re-fetchable, so this is the only thing "clear cache" ever touches. **Both are keyed by a
  CONTENT** - an encrypted media id, and an immutable `/api/media/public/<mediaId>?v=<updatedAt>`
  logo - which is what makes keeping them indefinitely correct.
- **User avatars are deliberately NOT among them** since 2026-08-17, and the bucket they used to
  live in is deleted at start-up. Their URL names a PERSON, not a content, so a store with no
  expiry froze the first photo each device ever drew ([core-service](../services/core-service.md#the-avatar-proxy)).
- The local database above and `mls.bin` have no cross-platform size API. Native reads real file
  sizes via `get_local_storage_usage` (`src-tauri/src/commands/storage.rs`), bucketing
  `{app_data_dir}` by filename; on the web build there is no such command, so `deviceStorage.ts`
  falls back to `navigator.storage.estimate()`'s origin-wide total minus the (precisely measured)
  cache size, which folds the MLS IndexedDB store into "messages" there instead of reporting it
  separately.

`mls.bin` is reported for DISPLAY only and is never reachable from the clear action -
`get_local_storage_usage` is read-only and `clearMediaCache()` only ever calls `caches.delete()`
on the three named buckets by name, never lists the app data directory. Same shape of risk as
[WP-DIRECTBOOT-1's `getOrCreateKey`](#the-process-exists-before-the-first-unlock-and-nothing-in-it-may-assume-otherwise-wp-directboot-1)
below: a destructive control reachable from a Settings page needs an allowlist of what it may
touch, not a denylist of what to avoid.

#### There is NO multi-statement transaction here, because the connection is not yours (WP-SQLTXN-1)

`tauri-plugin-sql` opens the database with sqlx's `Pool::connect`, i.e. `PoolOptions::default()` and
`max_connections = 10`. Each `db.execute(...)` is therefore its own **acquisition**: it takes a
connection from the pool, runs one statement and gives it back. So

```
execute('BEGIN');  execute('INSERT …');  execute('COMMIT');
```

is three acquisitions that may land on three different connections. The transaction stays open on
whichever connection began it - released back into the pool, still in a transaction - while the
COMMIT reaches a connection that never began one.

**Measured on device, 2026-08-11:** two `BEGIN`s issued concurrently on the same handle BOTH
succeeded, and one of the two following `ROLLBACK`s answered `cannot rollback - no transaction is
active`. That is the discriminator - on a single connection the second `BEGIN` would have failed
with `cannot start a transaction within a transaction`.

The damage is not theoretical. Under a multi-group MLS drain the app logged all three of

| line | what it means |
| --- | --- |
| `cannot start a transaction within a transaction` | the acquired connection already carried a leaked transaction |
| `cannot rollback - no transaction is active` | the recovery path landed somewhere clean |
| `database is locked` | a leaked transaction held the write lock; **the next writer simply fails** |

and the writers that failed were `[OUTBOX] Persist sent … failed` and `[OUTBOX] Enqueue failed` -
i.e. a message the sender does not keep and an outbox entry that was never queued. A leaked
transaction is also permanent: nothing closes it, so every later writer that draws that connection
fails until the process restarts.

**The rule: a statement is the largest unit of atomicity available.** One `execute` is one
acquisition, and SQLite wraps a lone statement in its own implicit transaction, so a batch insert is
built as a single multi-row `INSERT` (`db/sqliteBatch.ts`) rather than a loop inside `BEGIN`. A batch
past the bound-parameter ceiling becomes several statements and is no longer atomic as a whole -
acceptable **only** because every row is `INSERT OR REPLACE` under a key the caller already holds, so
re-running converges. A torn `BEGIN`/`COMMIT` across two connections has no such property.

Serialising in JavaScript does not help and was the original mistake: `runExclusive` ordered our own
transactional sections but could not bind them to a connection, and any concurrent `select` could
still be handed the one holding the open transaction.

**Verified on hardware, 2026-08-11.** A build carrying `db/sqliteBatch.ts` on A1, then a run driving
25 inbound bulk-ingest drains against the test DM with 11 sends interleaved into them: **zero**
occurrences of any of the three strings above in a continuous logcat capture of the whole run, and
every send still present after a reload. Before the fix the same shape of load produced them within
minutes. The assertion is now part of every phone check rather than a one-off - `sqlTransactionErrors`
in the harness reads the capture any check already keeps, so a write failing under load cannot pass
unnoticed again.

### Opening the app with no network

A cold start with biometrics enrolled, or a device-key vault from "stay signed in", unlocks with no
server at all: the history reads from the local store above and new messages queue in the outbox.
The gate that used to prevent it was `getToken()`, not the PIN. A PIN-only user still needs a
network, because the key derives from a server-issued salt that is deliberately never cached.

The rule to carry: **the two paths that can unlock offline are exactly the two that already skip
the server PIN check when online**, so nothing is verified less. Full reasoning, and the promotion
sequence that runs when connectivity returns, in
[`modules/auth.md`](modules/auth.md#offline-unlock).

## `fetch` is not `fetch` inside the WebView

On mobile `hooks.client.ts` REPLACES `window.fetch` with the Tauri HTTP plugin's, because the
WebView's own client cannot reach a third-party origin from under the app's custom protocol. Two
consequences that nothing type-checks:

- **The plugin is a NETWORK client** in a Rust thread. It implements `http:` and `https:` and
  answers everything else with `scheme <x> not supported` - a bare rejected promise, which reads
  exactly like the network being down.
- **The routing rule must name what the plugin CAN do, never the exceptions.** It was written as an
  exception list (relative paths, the dev server, cookie-bearing calls), so `blob:` - which nobody
  had listed - went to the network client. Saving a decrypted attachment reads its object URL back,
  so **every download on both platforms failed**, showing "le telechargement a echoue" while the
  ACLs, the save dialog and `fs.writeFile` were all perfectly correct. The predicate is now
  `shouldUseNativeFetch` in `utils/fetchRouting.ts`, pure and tested.

Also verified on hardware while chasing it: `XMLHttpRequest` is NOT patched and reads a `blob:` URL
fine, so a passing XHR next to a failing `fetch` is the fingerprint of this class of bug.

### A relative `/api/` path is dead on mobile, and it fails as a SUCCESS

The WebView's origin is `tauri.localhost`, so Tauri resolves a relative path as an ASSET, misses,
and falls back to `index.html` - **HTTP 200 with an HTML body**. `res.ok` is therefore `true` and
only `res.json()` throws, inside whatever `catch` happens to be nearby. Seen on A1 on 2026-08-11 in
the app's own log: `[tauri::manager] Asset api/mls/security/pin-status/... not found; fallback to
index.html`.

Three call sites had it and **the third was destructive**: `handlePinReset` read that `res.ok` as
"the server cleared the verifier" and went on to wipe the device's MLS state, losing the history
while the verifier stayed registered. That is the WP-DIRECTBOOT-1 shape again - a "cannot read"
taken for a "not there", with a destructive branch behind it.

Always take a base from `utils/apiUrl.ts` (`coreUrl` / `socialUrl` / `gatewayUrl` / `deliveryUrl`)
or `historyBaseUrl`. `apiUrl.absolute.test.ts` is the guard.

## Rules that hold across both platforms

**Push is all-FCM.** One transport for Android and iOS alike: the backend sends every `PushToken`
through `getMessaging().send()`, and FCM relays to APNs using the `.p8` key configured in the
Firebase console. There is no direct-APNs path for messages (VoIP calls are the exception, see
below), which is why `FirebaseAppDelegateProxyEnabled` must stay enabled. Architecture:
[`services/chat-delivery.md`](../services/chat-delivery.md).

**Firebase 12 moved the iOS data path.** `messaging:didReceiveMessage:` no longer exists. FCM data
now arrives through the `UIApplicationDelegate` swizzle (`CanariInstallRemoteNotificationHook`) and
the `UNUserNotificationCenter` callbacks, both funnelling into `CanariHandleFcmData()`. Hook new
iOS push work there.

**Branch on the runtime helpers, not on ad-hoc checks:** `isIosTauriRuntime()` and
`isMobileTauriRuntime()` in `appVersion.ts`. Several behaviours shipped Android-only and had to be
widened to all-mobile afterwards (heartbeat, notification suppression, `reloadStateFromDisk`) —
when adding one, decide deliberately which of the two it belongs to.

**A WebView has no download manager, so `<a download>` is a silent no-op on both platforms.**
Saving a file on the web is an instruction to the *shell*, not to the page: Chrome and Safari own a
download manager, Android's WebView forwards the request to a `DownloadListener` the host app must
install, iOS needs a `WKDownloadDelegate`. Tauri installs neither. The anchor click still dispatches
and still "succeeds", so there is no exception to catch and nothing in any log — which is how eleven
download buttons shipped dead on mobile without a single report until someone tried one. Everything
that saves a file goes through `utils/fileDownload.ts`, which keeps the anchor on the web and writes
through the native save dialog on Tauri (`ACTION_CREATE_DOCUMENT` on Android, the document picker on
iOS, the OS save panel on desktop). Two rules come with it:

- **Never ask for a directory.** Android's storage access framework offers a *document* picker;
  `dialog.open({ directory: true })` has no equivalent there. `save()` is the portable shape.
- **`fs:default` is READ-ONLY.** It grants reading the app-specific directories and creating them,
  nothing more — so `fs` appearing in `capabilities/default.json` says nothing about whether a write
  is allowed. `fs:allow-write-file` is what makes this work, and like every ACL gap it builds, ships
  and installs before rejecting on a user's device. `tauriCapabilities.test.ts` pins it by command
  name. The destination itself needs no broad grant: the dialog plugin adds whatever the user picked
  to the `fs` scope.

**Kotlin nested types go on the outer class body, never inside a companion object** — declared
there they are unreachable by class name, and the failure only appears in the release build, which
is the [first real Kotlin compile](../cicd.md).

## What the app claims over `canari-emse.fr`

Tapping an `https://canari-emse.fr/…` link on a phone with the app installed opens the **app**, not
the browser, for every path the app claims. The claim is one decision carried in three files that no
compiler compares:

| File | Platform | Says |
|---|---|---|
| `lib/mobile/appSiteAssociation.ts` → `MOBILE_UNIVERSAL_LINK_PATHS` | iOS | The served `apple-app-site-association`. **Canonical.** |
| `src-tauri/tauri.conf.json` → `plugins.deep-link.mobile` | Android | Source of the generated intent-filter |
| `gen/android/…/AndroidManifest.xml` | Android | What is actually compiled into the APK |

**A path restriction written for iOS has no effect on Android.** The two platforms express the claim
in different places, and `assetlinks.json` — Android's half of the verification — has no notion of a
path at all: on Android the filtering can only live in the intent-filter. That is not a detail of
this codebase, it is how the two systems differ, and it is why the lists must be generated rather
than maintained side by side. `androidAppLinkPaths()` does the translation (`/x/*` → `pathPrefix`,
anything else → exact `path`; Android has no negation, so what is not listed is simply not claimed)
and `appSiteAssociation.test.ts` fails when any of the three drifts.

**A host with no path attribute claims the entire host.** Android shipped exactly that, so the app
captured `/auth/callback?code=…&state=…` — the OIDC redirect belonging to whichever browser had
started the login. The browser never completed its round trip and returned to the login page, on
every retry; only phones with the app installed were affected, and only in browsers that honour App
Links, which is why it read as "some people, some browsers". Never widen this claim to a bare host,
and never add a path here without asking whether a *browser* is waiting for it.

**Verify the claim, do not assume it.** `adb shell pm get-app-links fr.emse.canari` reports the
verification state on a device, and Google's Digital Asset Links API answers for the served file:

```
https://digitalassetlinks.googleapis.com/v1/statements:list
  ?source.web.site=https://canari-emse.fr&relation=delegate_permission/common.handle_all_urls
```

Both association files are prerendered by SvelteKit (`routes/.well-known/`) and served by nginx from
`build/.well-known/`, so they follow the ordinary deploy — see [`seo.md`](seo.md) for that pipeline.

### How a deep link actually reaches the app — two paths, only one of them gated

Every deep link (`fr.emse.canari://chat/<groupId>`, the OIDC callback, a Stripe return, an App Link)
enters through `hooks.client.ts`, but **by one of two mechanisms depending on whether the app was
already running**, and they do not have the same failure modes:

| The app was… | Mechanism | Needs a capability grant |
|---|---|---|
| running (foreground or backgrounded) | `onOpenUrl` — an event channel the Rust side registers | **no** |
| closed | `getCurrent()` — a plugin **command** | **yes** (`deep-link:default`) |

`deep-link` was absent from `capabilities/default.json` entirely, so `getCurrent()` rejected with
`deep-link.get_current not allowed` on every launch and every cold-start deep link was lost:
tapping a message notification with the app closed opened Canari on the default route and left it
there (WP-DEEPLINK-1, fixed `916ed696`). **A plugin declared in `Cargo.toml` and configured in
`tauri.conf.json` is still granted nothing** — see
[`development.md`](../development.md#contracts-the-compiler-does-not-check), and
`tauriCapabilities.test.ts`, which now fails on the gap.

Two consequences worth carrying:

- **The warm path passing says nothing about the cold one.** Anyone checking a deep link has just
  used the app, so they check the ungated path. `check H` in
  [`device-verification.md`](../device-verification.md) must be run **twice** — backgrounded and from
  a killed process — and that is why NOTIF-7 does.
- **This is not platform-specific.** One capability file, one `hooks.client.ts`: iOS was equally
  affected and has never been checked on hardware.

The diagnosis is cheap when a cold start misbehaves, because each hop logs separately: the OS prints
`START ... act=android.intent.action.VIEW dat=fr.emse.canari://chat/...`, the WebView prints
`[hooks] Deep-link listener registered`, the handoff prints `[hooks] Processing URL`, and the product
prints `[notifNav] deep link received`. The first absent line names the broken hop.

#### A reload used to replay the launch link, and the guard's LIFETIME is the fix (WP-RELOAD-DL-1)

`getCurrent()` answers "the last deep link this PROCESS was handed", not "the app was just started by
one" - the Rust plugin holds it for the life of the process - so the four cold-start re-reads
(immediately, then 250/750/2000 ms) must be deduplicated. The guard was a module variable, which a
WebView reload wipes, so a reload replayed a launch url fifteen minutes old and yanked the user into
whatever it pointed at. `$lib/mobile/deepLinkClaims.ts` moved it to `sessionStorage`, whose lifetime
is exactly the WebView's: **"module variable" is a LIFETIME, not a detail, and it must be chosen
against the event the state has to survive.**

**Verified on hardware 2026-08-11**, with the reproduction kept because it is what makes the pass
mean anything:

| step | result |
| --- | --- |
| cold start through `fr.emse.canari://post/<id>` (positive control) | route `/posts/<id>`, claim set - the link WAS consumed |
| park on `/posts`, full load, then `location.reload()` | still `/posts`, claim intact - **PASS** |
| delete the claim key, reload again (negative control) | back on `/posts/<id>` - **the defect, on demand** |

The negative control is the point: "the app stayed put" is also what a build with deep links entirely
dead would produce, and the third row proves the claim is the thing holding the line. The target is
an all-zero UUID matching no post - `/posts/<unknown>` stays on its route and renders "Publication
introuvable", so the assertion is about ROUTING and touches nobody's data.

## Where an update comes from

Canari ships from three places at once: Google Play (`fr.emse.canari`), the App Store
(`id6793060521`) and `app-universal-release.apk` on GitHub Releases. Only one of them is ever the
right answer for a given install, and **the app has to work it out at runtime**.

> **The Play build and the GitHub APK cannot install over each other.** The release workflow uploads
> an `.aab`, so the binary users get from Play is re-signed by **Google Play App Signing**, while the
> APK attached to the same GitHub release is signed with our upload key. Different signatures means
> Android refuses the install outright (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), and switching sides
> requires uninstalling first — which wipes `mls.bin`, the keystore entry and the whole local message
> history. So sending a sideloaded user to the Play Store is not a slightly wrong link, it is a dead
> end that ends in data loss if they follow it far enough. The update target is a **runtime fact**,
> never a build-time constant, and that is why the store URLs are plain constants in `appVersion.ts`
> with no env plumbing behind them: the thing that varies is the *install*, not the build.

`android.yml` must therefore keep attaching the APK to every GitHub release — it is the only
update path sideload users have.

### The install-source probe

| Step | Where |
|---|---|
| Read the installing package at startup, write it to `installer_package.txt` | `CanariApplication.recordInstallerPackage` (Kotlin) |
| Read that file back on demand | `get_installer_package` in `src-tauri/src/commands/storage.rs` |
| Map it to `'play' \| 'sideload'` and pick a target | `probeAndroidInstallSource` / `buildUpdateTarget` in `appVersion.ts` |

Kotlin uses `packageManager.getInstallSourceInfo(packageName).installingPackageName` on API ≥ 30
(`Build.VERSION_CODES.R`) and the deprecated `getInstallerPackageName` below it — `minSdk` is under
30, so the version guard is required, not defensive. `com.android.vending` is Google Play; anything
else (or nothing at all, which is what `adb install` leaves) is a sideload. No `<queries>` manifest
entry is needed: reading the installer *name* is not subject to package-visibility filtering.

The file hop is the same cross-process pattern as `push_context.json` and `get_native_flags` —
Kotlin writes into `MlsContextLoader.tauriDataDir(context)`, Rust reads the same directory through
`app.path().app_data_dir()`. It is deliberately **not** a Tauri plugin: a new local plugin forces
`gen/android/tauri.settings.gradle` and `app/tauri.build.gradle.kts` to be regenerated, which risks
clobbering the hand-maintained `AndroidManifest.xml`, and this needs no ACL, no `build.rs` and no
capability entry. Nothing type-checks either end of that path, so
`src/lib/mobile/installerPackageContract.test.ts` pins the filename, the directory helper, the
command registration in `generate_handler!` and the `com.android.vending` literal — the same role
`fcmCacheFields.test.ts` plays for the FCM cache.

A failed or empty probe resolves to `'play'` **and logs a warning**: every build carrying this code
writes the file at startup, so a miss is a real fault rather than an expected state, and Play is the
correct default for every install made from now on. `buildUpdateTarget` is kept pure (platform +
install source in, `{ kind, url }` out) so the decision is unit-testable with no Tauri runtime;
`resolveUpdateTarget` is the thin async wrapper that runs the probe, and it skips the round trip
entirely off Android, where there is only ever one possible target.

### What actually prompts

Only `minClientVersion` does. There is no optional update prompt — the store handles ordinary
updates, and `/settings` shows the installed version passively. See
[admin](modules/admin.md#platform-configuration-adminplatform) for the rollout-timing trap that
comes with raising the minimum.

## A 500 from Apple is not a refusal, and the iOS arm has to be re-runnable

**Measured on `v0.16.1`, 2026-09-03.** The submission chain ran to its last request -
`PATCH /v1/reviewSubmissions/{id} {submitted: true}` - and Apple answered `500 An unexpected error
occurred on the server side`. The version, the attached build and the release notes were all in
place, **and the write had landed**: App Store Connect showed the version added for review minutes
later. The 500 was a lost response, not a refused effect. The run was red over a release that had
shipped.

`tools/app-store/submit.mjs` now classifies a refusal instead of treating every non-2xx alike, in
one exported function (`shouldRetry`, asserted by `submit.test.mjs`):

| | retried | why |
| --- | --- | --- |
| 429, 500, 502, 503, 504 | yes, on an idempotent method | Apple never reached a decision |
| no response at all | yes, on an idempotent method | the request did not arrive |
| 409, 401, 422, any other 4xx | **no** | Apple is answering; retrying hides what it said |
| anything on a **POST** | **no** | a 500 leaves it unknown whether the thing was created |

The POST rule is the one that matters. `POST /v1/reviewSubmissions` retried after a 500 would make a
SECOND review submission; those calls are protected differently, by asking what already exists
before creating anything.

`ios.yml`'s TestFlight upload now reads `ITMS-4238 / Redundant Binary Upload` as success. The build
number is derived from the version, so a re-run uploads the same `CFBundleVersion`; without this,
"Re-run failed jobs" - the recovery every comment in the release chain points at - died on the
upload, several steps before the request that had actually failed. Narrow on purpose: every other
altool failure, a validation rejection included, still fails the step.

## iOS specifics

### Notification Service Extension (NSE)

`canari_NSE/NotificationService.swift` is a separate target that runs when a push notification arrives while the app is killed:

- Decrypts MLS ciphertext via Rust FFI (`canari_native_decrypt_message`)
- Decrypts media thumbnails via Rust FFI (`canari_native_decrypt_media`)
- Builds visible notification content (title, body, attachment, category, badge)
- Writes decrypted messages to `fcm_message_cache.ndjson` in the App Group container, which the app drains into its own `app_data_dir` and pre-injects at boot (see "FCM message cache")
- Runs the same background MLS decrypt ladder as Android (direct decrypt → catch-up-first for local groups → Welcome-race retry for genuinely absent ones → nothing at all when the locality is `UNKNOWN`)
- Budget: ~30 seconds; 2 MB media cap

The NSE shares data with the main app via App Group `group.fr.emse.canari`:
- `push_context.json` — device ID, user ID, backend base URL, push token. No key material: the
  device key comes from the shared keychain item `mls_bg_key_<alias>` (see
  [auth](modules/auth.md) "Where the key lives")
- `mls.bin` — read-only mirror of the persisted MLS state; the NSE never writes it
- `channel_keys.json` — read-only mirror for community/channel message decryption
- `push_secret.txt` — read-only mirror of the PushSecret for backend fetch paths

The NSE does **not** write `mls.bin`, process Welcome pushes, or drain the outbox. Those remain app-process responsibilities.

**It also never sees a silent frame, so it can never cancel anything.** The extension runs on
`mutable-content: 1` ALERT pushes only; a `content-available: 1` background push goes to the app
(`canari_push.mm` `CanariHandleFcmData`). So `channel_read` — the frame that clears a salon's
notification after it was read on another device — is the app's to handle, and listing it in the
extension's switch (as it was until 2026-08-16) is a branch that cannot execute. The removal itself
must key on `threadIdentifier`, since the identifier differs between the two posters — see
[social-service](../services/social-service.md) "Cross-device read dismissal".

### CallKit (VoIP pushes)

When the app is killed, incoming calls use CallKit via direct APNs VoIP pushes:

1. Caller's client → `POST /api/calls/ring`
2. Backend sends APNs VoIP push (ES256 JWT, topic `<bundle>.voip`)
3. `PKPushRegistry` delivers → `CanariReportIncomingCall`
4. User answers → `pending_call_accept.json` written → accept deep link fired
5. App unlocks → TS store drains pending accept → `CallService` auto-accepts

VoIP push tokens are persisted to `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field).

### Force-quit constraint

Once the user swipes the app away on iOS:
- **No** silent `content-available` data pushes are delivered
- **No** `BGTask` runs until manual relaunch
- Visible (`mutable-content`) alert pushes still arrive and wake the NSE
- Background state-sync only resumes on next app open

Android has no equivalent restriction.

### iOS project

`canari.xcodeproj/project.pbxproj` is **hand-maintained** (not xcodegen). Key details:
- Two targets: `Canari` (app) + `CanariNotifications` (NSE)
- Custom URL scheme, `NS*UsageDescription` keys
- `FirebaseAppDelegateProxyEnabled` — must stay enabled
- Localized `InfoPlist.strings` (fr/en `PBXVariantGroup`)
- `aps-environment: production` for TestFlight/App Store
- Provisioning profiles: two named profiles matching `PROVISIONING_PROFILE_SPECIFIER`, team "Les Rootz" `4CLNB8SR6L`

## Android specifics

### The process exists before the first unlock, and nothing in it may assume otherwise (WP-DIRECTBOOT-1)

**Our process is created before the user's first unlock after a reboot, and we never asked for
that.** `tauri-plugin-notification` merges
`app.tauri.notification.LocalNotificationRestoreReceiver` into the manifest with
`android:directBootAware="true"` and an intent filter on `LOCKED_BOOT_COMPLETED`. One
direct-boot-aware component is enough to start the process, so `CanariApplication.onCreate` runs
whether or not anything of ours is direct-boot aware - and nothing of ours is. Check the **merged**
manifest, never the source one: this declaration is invisible in
`app/src/main/AndroidManifest.xml`.

In that window, credential-encrypted storage is not open, and **the failure mode is silence, not an
error**:

| Storage | What it does while locked | Why that is dangerous |
| --- | --- | --- |
| a file under `context.dataDir` | `exists()` answers **false**; a read fails with `errno 126 (Required key not available)` | every `if (!file.exists()) return` reads as "nothing to do" when it means "cannot tell" |
| `SharedPreferences` | loads **empty**, and the instance is cached for the life of the process | a later unlock repairs nothing - the fix is to never open it, not to re-read it |
| an AndroidKeyStore alias | may be **present and unreadable** | indistinguishable from missing, from `getKey` alone |

The defect this produced is the third row taken for the second. `PushSecretKeystore.getOrCreateKey`
treated an unreadable key as a corrupt one - the recovery it was written for is a TEE wipe - and so
it **deleted the alias and generated a new one**. That is a permanent loss caused by a temporary
condition: the ciphertext in `canari_push_prefs` was encrypted under the old key and is orphaned for
good, and the process then serves push with a credential the server rejects. The user-visible tip
was a missing avatar in a notification after a reboot; the same `verifyPushSecretAuth` guards the
encrypted-media proxy and `fetchProtoFromBackend`, the fallback that pulls a message's ciphertext
when the FCM payload does not carry it - so the same 403 costs a MESSAGE, not a picture.

The rules that follow, and they apply to anything added to this startup path:

- **Ask `DirectBoot.storageReadable()` before touching CE storage**, and treat `false` as "come back
  later", never as "the data is gone". `CanariApplication.onCreate` now defers every
  storage-backed initialiser and re-runs them on `ACTION_USER_UNLOCKED` (a runtime receiver - that
  action cannot be declared in a manifest).
- **A destructive repair must be gated on knowing the state is really broken.** `containsAlias`
  separates "absent" (a fresh install, generate) from "present but unreadable" (refuse, and say so).
- **Only notification CHANNELS can be created pre-unlock**, because they live in the system rather
  than in our storage.
- **A 401/403 on a push-authenticated fetch is an auth failure and must be logged as one.** It sat
  at debug level among the ordinary avatar misses, which is exactly why it went unseen.

#### Verified on hardware, 2026-08-11 - and the open question was DISSOLVED, not answered

A real reboot on A1, with the pid carried across both halves because a clean run on a process that
was never born locked measures nothing:

| What the WP claimed | What the fixed build did |
| --- | --- |
| the process is created pre-unlock | still true, and expected: `FirebaseApp: Device in Direct Boot Mode: postponing initialization`, pid 3562 |
| `onCreate` runs blind against locked storage | it now **detects** it: `CanariApp: onCreate: storage locked (pre-unlock process) - deferring init to ACTION_USER_UNLOCKED` |
| `recordInstallerPackage` fails with `errno 126` | 0 occurrences - the initialiser is deferred, so it never touches CE storage while locked |
| `getOrCreateKey` deletes an intact alias | 0 occurrences of the destructive branch; the Keystore is not read at all in that window |
| the process serves push degraded for its whole life | **same pid 3562** after `USER_UNLOCKED`: `MlsDeviceKeyStore: retrieve: success`, then a PushSecret-authenticated HTTP fetch that SUCCEEDS |
| some read yields a secret production rejects | 0 `push secret REJECTED` over the whole session |

The last row is the point, and it is worth stating precisely: the WP left open *which* read produced
the rejected secret, and shipped a distinct log line per branch to settle it. **No branch ever
produced one.** The question is dissolved rather than answered - the temporary-condition-as-permanent-loss
was the whole mechanism, and once the destructive recreate cannot run there is no orphaned ciphertext
to present.

**The positive proof needed a trick, because absence of a rejection is not evidence of success.** The
process had cached both avatars long before, so nothing PushSecret-authenticated was being exercised
and the run was correctly VOID. The build is DEBUGGABLE, so `adb shell run-as fr.emse.canari rm
files/avatar_*.jpg` emptied the cache under the born-locked process, and the next push produced
`fetchAvatar: avatar cached for ...` twice from pid 3562 - which is the log emitted **after** an HTTP
fetch succeeds and is written, distinct from `fetchAvatar: from cache for ...`. Two success logs one
word apart is a trap worth knowing before reading any of this: only one of them proves the network
path ran.

### The window layout: the keyboard, and the orientation lock

Both live in `MainActivity.onCreate`, both are in `gen/android` which `tauri android init` regenerates
from a template, and neither is caught by a compile. `frontend/src/lib/mobile/androidWindowLayout.test.ts`
reads the Kotlin and the resources as text for exactly that reason - it is the only gate either has.

#### iOS shrinks the WebView, and that is the same decision taken twice

**WKWebView is never resized for the keyboard.** It keeps its full height and only the VISUAL viewport
shrinks. `keyboardViewport.svelte.ts` notices and pins the app shell to the visible height - correctly,
given what it can see - but the DOCUMENT is still full height, so a keyboard-tall empty band opens
below the shell, and WebKit, auto-scrolling to reveal the focused field, scrolls the page straight onto
it. One cause, two faces again: a composer pushed out of reach, and a large empty zone appearing on
scroll.

`CanariApplyKeyboardLayout` (`canari_ios.mm`, on `UIKeyboardWillChangeFrame`) shrinks the WebView's
frame by the keyboard's overlap with its superview. That moves the LAYOUT viewport itself, so
`window.innerHeight` and the shell height agree again and the band cannot exist. **No web change was
needed**: `computeSnapshot` already reported `layoutInsetBottom: 0` for a natively-resized window - that
branch had been written for a native resize iOS never performed. The margin was never the fix on either
platform.

It settles the safe area for free, which on Android needed a second mechanism: a WebView whose bottom
edge no longer reaches the home indicator is given `safeAreaInsets.bottom == 0` by UIKit, so
`env(safe-area-inset-bottom)` stops reserving a strip that is now behind the keyboard.

Stateless on purpose - the target is recomputed from the superview's bounds on every event, so there is
no remembered frame to restore and nothing that can drift. `UIKeyboardWillChangeFrame` alone covers
appearing, disappearing, height changes and interactive dismissal: on the way out the end frame is
off-screen, the intersection is empty, and the overlap is zero. One path, both directions.

#### `android:windowSoftInputMode="adjustResize"` IS INERT, and the manifest still carries it

Since Android 15 an edge-to-edge window is never resized for the IME. The attribute is not an error
and not a warning; `dumpsys window` states the outcome plainly, printing `EDGE_TO_EDGE_ENFORCED`
right next to the `adjust=resize` that was asked for. It is kept in the manifest because it still
works below 15, and the listener below is a no-op there (the IME inset reads 0 once the window has
already been resized).

ONE cause wore two faces, which is why they were one item: the composer sat under the keyboard, and
the page could be scrolled onto a white band. Nothing resized, so the WebView's own scroll-the-focused-
field-into-view ran the document past the end of its content onto the Activity background - visible
because `onWebViewCreate` makes the WebView transparent on purpose (that is the startup-flash fix).

`applyKeyboardInsets()` sets an `OnApplyWindowInsetsListener` on `android.R.id.content` and pads it by
the IME inset. **It also withdraws the navigation-bar inset while the keyboard is up, and that half is
not cosmetic**: the web layer reserves a strip through `env(safe-area-inset-bottom)`, which is right
when the bar is at the bottom of the app and wrong the moment the keyboard is - the bar is then behind
the keyboard and the strip is an empty band the page can be scrolled by, revealing the reserved footer
while hiding part of the header. "The keyboard is up" is known here and nowhere else, so the inset is
zeroed on the way down rather than left for CSS to guess at. The status bar is deliberately untouched:
it is still on screen. The early `if (ime == 0) return ... insets` is what gives the strip back.

Verified on hardware 2026-08-17 (v0.14.0 debug build, Android 15): `IME inset: 988 -> content padding`
in logcat with the composer focused, and the user confirmed the band is gone.

#### The bottom nav reserves nothing

`BottomNav` is `fixed inset-x-0 bottom-0 z-30 md:hidden`, so it is out of flow and occupies no space
in any layout: everything that scrolls beneath it has to reserve its height (`4rem` plus
`env(safe-area-inset-bottom)`) or lose whatever ends up underneath.

`routes/+layout.svelte`'s `.page-scroll-wrap` does exactly that, for every ordinary page. **The chat
shell does not go through it**: `.page-scroll-wrap:has(.app-layout)` in `app.css` sets
`padding-bottom: 0` and `overflow: hidden` so the shell can be exactly one viewport tall and own its
own scrolling. That is right about the scroll and, until 2026-08-26, silently wrong about the
reservation - the padding was the only thing reserving the bar's height, and it went with the scroll.

What that cost, measured on the Pixel 6a through CDP:

| | |
| --- | --- |
| viewport | `innerHeight: 914` |
| conversation list box | `top: 170`, `bottom: 914`, `clientHeight: 744` |
| its nine tiles | span `698` px |
| so | `scrollHeight === clientHeight === 744`, `canScroll: false` |
| `elementFromPoint` at the list's bottom edge | `NAV.fixed inset-x-0 bottom-0 z-30` |

The last tile sat at `800..878`, under a bar starting near `848`. The browser was RIGHT that there
was nothing to scroll - the content fitted - and the hidden row was therefore unreachable by any
gesture. A swipe changed the accessibility tree by not one pixel, which is what "scrolling is
impossible" means from the outside. With a longer list the scroll works and the final row is still
parked under the bar at maximum scroll; the short list only makes the same defect total.

The remedy is `.mobile-nav-inset` in `app.css`, carried by the chat shell's own bottom-reaching
scrollers (both of `Sidebar.svelte`'s). It mirrors the nav's mount conditions - `md`, plus the
`keyboard-open` and `mobile-convo-open` classes `+layout.svelte` puts on the document element -
because reserved space the bar does not occupy is a dead zone at the end of the list. Content still
scrolls *under* the translucent bar, as intended; it can now be brought out from under it.

The same gesture carried a second defect. The list's pull-to-refresh called a handler that slept
600 ms and returned, trusting the visibility watchdog to reconnect - a timeout standing in for work,
and a spinner that promised something no user could check. The list is push-fed over the WebSocket,
so it has nothing to fetch while the socket is up: `pullToRefresh` now takes an `enabled` gate asked
**once per gesture** (whether there is work is a property of the moment, not of the binding), and
`MainChatPage` declines the pull while connected. While disconnected the pull calls
`session.attemptReconnect` - the backoff ladder is armed but may be 30 s from its next rung, and the
gesture is the user asking for that rung now. `attemptReconnect` clears the armed timer rather than
orphaning it and no-ops for a follower tab or an in-flight attempt, so it is safe to call directly,
and it awaits the post-connect sync, so the spinner lasts exactly as long as the work.

Pinned by `pullToRefresh.test.ts` (7 tests), including the negative control that an upward drag is
still handed to the scroller untouched - the half of the original report this code was not
responsible for.

#### Portrait is locked by a resource qualifier, not by the manifest

`android:screenOrientation` takes ONE literal value, which cannot serve a phone and a tablet - so the
decision is `R.bool.canari_lock_portrait`, `true` in `res/values/` and `false` in `res/values-sw600dp/`.
`sw600dp` is the SHORTEST edge, measured once for the device, so the qualifier does not flip when the
device is turned - which is the property that makes it usable for this at all. `orientation|screenSize`
stay in the activity's `configChanges`: losing them would tear the WebView down on a tablet rotation,
reloading MLS state and interrupting an in-flight send for a movement of the wrist.

Negative control, run 2026-08-17: under a forced `user_rotation 1`, Settings reported `cur=2400x1080`
while Canari stayed `cur=1080x2400`.

### Push notification handling

`CanariFirebaseMessagingService.kt` — the single FCM handler:

- `onMessageReceived` — processes data pushes (MLS messages, calls, channel events)
- Decrypts messages via JNI (`nativeDecryptMessage`)
- Decrypts media thumbnails via JNI (`nativeDecryptMedia`)
- Shows notifications: MessagingStyle for messages, CallStyle for calls
- Quick actions: Reply (text input) and Mark as Read (broadcast to `CanariNotificationActionReceiver`)

MessagingStyle takes two `Person`s and **both** need an icon. The sender's comes from `fetchAvatar(senderId)`; ours comes from `fetchAvatar(loadUserId())` - Android attributes the inline reply to the self `Person` while the reply is in flight, so an iconless self is a blank face on the only message in that thread the user actually wrote. `MlsContextLoader.loadUserId` reads just the `userId` field of `push_context.json`, deliberately not `loadPushContext`, whose expensive half is a Keystore round trip this caller has no use for. iOS shows a single attachment image rather than a thread, so it has no self `Person` and nothing to fix there.

#### The language a notification speaks

**Not the phone's.** The Français/English toggle in Canari's settings and the device language are
two different settings, and only one of them is the user telling THIS app what to speak. The choice
is mirrored into `push_context.json` by the WebView while the app is open - a background process
cannot ask the WebView, which is precisely why it is written down - and every native surface reads
it from there:

| Platform | Table | Resolver |
| --- | --- | --- |
| Android | `res/values/strings.xml` (French, default) + `res/values-en/strings.xml` | `appLocaleContext(context)` in `AppLocale.kt` |
| iOS app | `canari_iOS/{fr,en}.lproj/Localizable.strings` | `CanariLocalized()` in `canari_push.mm` |
| iOS NSE | `canari_NSE/{fr,en}.lproj/Localizable.strings` | `NotificationService.localized()` |

The appex has its OWN copy because an app extension is a separate bundle and `Bundle.main` there is
the appex - that duplication is the platform's, not a choice, and it is what Android does not have
to do with `res/values`.

`appLocaleContext` returns a `Context` whose resources resolve in the app's language, so the rule on
Android is mechanical: **the receiver decides the language, not the call.** `res.getString(...)`
where `res` came from `appLocaleContext`; a bare `getString(...)` is the Service, which is the OS
locale, and is wrong for exactly the users whose two settings disagree - invisibly, for everyone
else. It reads `push_context.json` once per call, so it is resolved once per notification and passed
down. `R.string.app_name` is exempt: the brand is the same word in every language and lives only in
the default resources.

**Since 2026-08-19 the SERVER writes no sentence at all.** `social-service` used to compose the
body for a comment, a reply, a mention, a reaction and the two form reminders - the first four in
French for everyone, the last two in English for everyone, in the same service. It is the one layer
that cannot know the reader's language: no header carries it and no column stores it, so this was
never a translation that had been forgotten. A push now carries a `contentKey` from a closed set
plus the two pieces nothing translates - who acted, and one fragment whose meaning is fixed per key
(the text somebody typed, or the emoji) - and each native surface writes the sentence from the
tables above. The message-reaction push always did this; it is now the rule rather than the one
exception. A `locale` column server-side would have been the wrong repair: it makes the server
authoritative about a preference that lives in the app.

The keys are `PushContentKey` in
[`apps/social-service/src/push/push-content.ts`](../../../apps/social-service/src/push/push-content.ts);
the composers are `composeServerNotification` (Kotlin), `applyServerContent` (NSE) and
`CanariComposeServerNotification` (`canari_push.mm`). Clients built before that date read `title`
and `body`, which are still sent in their old wording until 2027-02-19 - dropping them does not
degrade an old client, it BLANKS it
([legacy-compatibility](../legacy-compatibility.md)).

**Nothing in either build connects those two sides**, which is the hazard while the shim lives: a
key with no resource silently falls back to the server's wording and looks deliberate.
`nativeStrings.test.ts` reads the union type out of the service's source and holds it against all
six tables and all three composers - and was mutation-checked by deleting one string.

**A notification channel's name and description are written ONCE, at creation.** Android keeps the
strings the channel was given, and re-creating an existing channel changes nothing - so a user who
switches language afterwards keeps the wording of the day they installed. Deleting and re-creating
the channel would fix the wording and discard the sound and importance THEY chose, which is the
larger harm. `ensureChannels(context, manager)` therefore takes a `Context` and does its best at
creation time; there is no repair after it.

**iOS's quick-action titles are the one native string that CAN follow a language change**, and they
do. `setNotificationCategories` REPLACES the whole category set, where an Android channel is written
once and never again, so `CanariRefreshNotificationCategories` re-registers Reply / Send / Mark as
read whenever the mirrored locale has moved - and returns immediately when it has not.

**Its trigger is a proof, not a poll.** It is called from `UIApplicationWillResignActive`
(`canari_ios.mm`), because a quick-action title is only ever READ on a notification the user can
see, and seeing one requires the app not to be frontmost. That transition therefore cannot be
skipped between the settings toggle that changes the language and the first banner that shows the
titles. No timer, no observer on the JSON file, and the locale guard makes every other call free.

Both halves are pinned by `frontend/src/lib/mobile/nativeStrings.test.ts`, because nothing else can
see across a `.kt` and an `.xml`: every `R.string.x` is declared, `values/` and `values-en/` carry
the same keys (bar the brand), the format arguments match, no key is dead, no accented literal
survives in Kotlin, and every `getString` goes through the app locale. The iOS half of that file
holds the four `.lproj` files to the same shape - a key present in one language and not the other
ships the KEY ITSELF as the notification body, since both resolvers pass `value: key`.

**And a third block holds both platforms to something neither of the first two can see: NO NATIVE
SOURCE MAY CARRY A LITERAL A TABLE ALREADY TRANSLATES.** Holding resource files against each other
is blind to a sentence that never entered a table, which is how six French literals survived in the
Swift and ObjC sources for two days after the tables were written. Three properties make that check
need no wordlist and no exemption list:

- **The corpus is the FRENCH side of every table only.** Every identifier these sources carry is
  English by rule, so the push `"channel"` type and the `"reply"` action id fold straight onto an
  English translation - four false positives, measured, before the corpus was narrowed. French is
  the one language in which a literal cannot be an identifier.
- **Comparison is folded**: lowercase, diacritics stripped, Swift `\u{...}` decoded. The defect was
  spelled `Repondre` for `Répondre` and `Appel vid\u{00e9}o entrant` for `Appel vidéo entrant`, so
  exact equality would have found neither.
- **Decoration is stripped at both ends**, because the two call literals were an emoji the table
  does not carry followed by a sentence it does.

What it still cannot see, and the test says so in its own header: a French literal whose wording
exists in no table at all. On Android the accent heuristic catches most of those; on iOS nothing
does.

#### The face on a notification, and what happens when there is none

Every notification that names a person tries to show that person. **When it cannot, a coloured disc
with their first letter is drawn instead** - Android has done this since the beginning, and both iOS
paths used to show nothing at all, so the same failed avatar request produced a letter on one phone
and a blank square on the other.

There are three implementations and there cannot be fewer - `generateInitialsBitmap` (Kotlin),
`CanariInitialsImagePath` (ObjC, the app) and `initialsImageUrl` (Swift, the appex, which shares no
code with the app). What must be identical is the colour (`#6366f1`) and the 0.4 letter ratio; what
legitimately differs is the size - 96 px on Android, where it is a small icon beside the text, and
192 px on iOS, where an attachment is rendered at banner size. `initialsFallback.test.ts` holds the
three together, including the size difference as a deliberate one.

**The avatar branch decodes through the image HEADER first, and the reason is that its resolution is
not ours.** The bytes come from MiGallery, through core-service, through `/api/mls/push/avatar`, and
no hop in that chain carries a size parameter - so what arrives is whatever its owner uploaded.
`fetchAvatar` used to hand those bytes straight to `BitmapFactory`, and `circleCrop` then allocated a
SECOND `ARGB_8888` bitmap at the source's own shortest edge, so a 3000x3000 photo cost about 36 MB
twice over, in the FCM service process, for an icon the framework draws at
`notification_large_icon_width`. Running out of memory there does not soften the icon: it loses the
notification. `decodeSampled` reads the header with `inJustDecodeBounds` (no pixels allocated), picks
the largest `inSampleSize` still at or above that platform dimension - powers of two only, which is
all the decoder honours - and `circleCrop` takes the remaining factor of under two by scaling its
draw. Both call sites route through it, which is why neither carries a copy. **The initials disc
keeps its own 96 px**: that number is a three-platform contract, pinned by `initialsFallback.test.ts`
against the two Apple copies, and it is not the avatar branch's business.

Two decisions inside it are easy to get wrong:

- **the disc is the LAST resort, below the media thumbnail.** iOS renders only the first attachment,
  so a letter replacing the picture a message is about would be a regression wearing a fallback's
  name. Order is media, then avatar, then initials.
- **a salon draws the SALON's letter, not the speaker's.** The title there is
  `<Communaute> - #<salon>`, so anything deriving the letter from the title would draw the community
  - or a bare `#` when the community could not be named. Both platforms pass the salon name
  explicitly, and on iOS that is why the name is a PARAMETER of the shared notification function:
  only the call site knows what the letter should stand for.

**Reaction notifications are at parity across the two platforms, and this is the list - do not
re-derive it.** Both take the MESSAGE path rather than the social one, both use the stable
per-conversation id and thread so a reaction replaces itself instead of stacking, both suppress
themselves in the foreground, both drop reply and mark-as-read (neither means anything against a
reaction), and both compose the sentence in the app's own Français/English rather than the OS one.
`pushContextFields.test.ts` pins the `locale` field across the Rust writer and all three native
readers. The push carries an id, an emoji and who reacted - never the message text, since the
recipient is its author and already holds it.

#### Background MLS decrypt ladder

Both Android and the iOS NSE run the same ladder when an encrypted MLS message push arrives:

1. Try a direct decrypt (`tryDecrypt` / `decryptProto`).
2. If that fails, ask where the group stands: `groupLocality` / `GroupLocality` returns `LOCAL`, `ABSENT` or `UNKNOWN`.
3. `UNKNOWN` — the state could not be reached at all (lock not acquired, `mls.bin` unreadable, device key missing, JNI absent). **Neither recovery runs**, because neither is an answer to it. The push falls through to the fallback below.
4. `LOCAL` (epoch ≥ 0) — run in-memory commit catch-up (`tryDecryptWithCommitCatchup` / `decryptWithCommitCatchup`) immediately.
5. `ABSENT` — retry a few times to give a concurrent Welcome push time to join the group (`WELCOME_RACE_RETRIES × WELCOME_RACE_RETRY_DELAY_MS` = 3 × 1.8 s on Android, mirrored by `welcomeRaceRetries × welcomeRaceRetryDelayMs` in the NSE). If the group becomes `LOCAL` during that race, try commit catch-up as a last resort before falling back.
6. If everything fails, Android enqueues `MlsBackgroundWorker` and shows the generic fallback notification (unless the push is silent, in which case it returns quietly). The iOS NSE cannot enqueue work from the extension, so it shows the fallback directly.

This order matters because a silent commit push advances the epoch but cannot persist state while the app is closed; the next message push therefore looks like an epoch gap on a group that is already joined. Running catch-up first for local groups avoids the old ~9.6 s retry loop.

**`UNKNOWN` is step 3 and not a value of "is it local" because the two were the same value until WP-PUSHHERD-1.** Every failure to reach the state answered "not local", so a message in a months-old DM went down the Welcome-race branch, whose retries re-entered the very lock that had just timed out. Twenty such verdicts came from ten epoch queries in one measured run. See [cross-client-testing](../cross-client-testing.md).

#### One lane for everything that touches `mls.bin`

Android runs the ladder — and the two Welcome paths — on a **single process-wide executor**
(`MLS_PUSH_LANE`, entered via `runSerializedWithWakeLock`). Work that does not touch the MLS state
(token refresh, channel notifications) keeps a thread of its own via `runWithWakeLock`.

This is not a throttle and costs no latency: `MlsStateLock` had already made the work serial. A
thread per push only added the contention around it — 5 s per timeout, a full 1.6 MB state read per
winner, and a retry per loser — which behind a backlog reached 97 timeouts and 20+ threads and
ended with `ActivityManager` killing the process for `excessive cpu`. The lane must live in the
companion object: the FCM service object is recreated per delivery, so an instance field would be a
new lane per push wearing a queue as a disguise.

The iOS NSE needs no equivalent — the extension is invoked serially by the system — but it carried
the same `UNKNOWN`/`ABSENT` conflation and got the same tri-state.

### FCM message cache

Both platforms write decrypted message previews to `fcm_message_cache.ndjson` after a successful decrypt:

- Android: `CanariFirebaseMessagingService.writeFcmCache` → `{app_data_dir}` directly. The FCM service runs in the app's own process, so it shares that directory.
- iOS NSE: `NotificationService.writeFcmCache` → the **App Group container**, then `CanariDrainAppGroupFcmCache` (called from `canari_ios_bootstrap` and on `didBecomeActive`) moves the entries into `{app_data_dir}`.

That extra hop is not optional: an app extension has its own data container, so `app_data_dir` resolved inside the NSE is a directory the app can never read. The App Group is the only storage the two processes share — the same reason `mls.bin` is mirrored there. The NSE also writes with `completeFileProtectionUntilFirstUserAuthentication`, because it runs on a locked device where the default protection class cannot be written.

The file is bounded to 50 entries and read at boot by `read_and_clear_fcm_cache` (Rust) so the app can pre-inject messages into the local store before the full MLS sync finishes. Both writers must produce the same JSON fields (`groupId`, `messageId`, `senderId`, `senderName`, `content`, `timestamp`, `type`, plus optional `replyTo` and `mediaKind`). `fcmCacheFields.test.ts` pins the fields **and** both halves of the iOS path - off macOS it is the only gate on either.

**The cache also carries OUTGOING messages, not only received ones.** A notification quick reply is built and delivered entirely natively (`writeSentMessageToCache` on Android, `CanariWriteSentMessageToCache` on iOS), so it never becomes a TypeScript outbox entry - and `reconcileOutboxSent` only *deletes* entries. Without an entry here, a reply the peers received would leave no trace whatsoever on the device that sent it, which from the app is indistinguishable from a reply that was never sent. The entry carries OUR user id as `senderId`, which is all the injection path needs: `mapStoredMessagesToChatMessages` derives `isOwn` from it, so the row renders as our own message and raises no phantom unread. It is written only once the drain reports the reply delivered - an undelivered reply must not appear as sent.

An undelivered quick reply is kept in `outbox_pending.ndjson` only, and `store_outbox_mirror` **rewrites** that file from the TypeScript queue — which has never heard of an entry the native side appended. That used to erase it on the next foreground outbox mutation. `adoptOrphanedMirrorEntries` closes it: see [Outbox mirror](#outbox-mirror) below. The notification is still left up as the immediate retry affordance, since adoption only happens at the next login.

### Background execution

- **WorkManager** (`OutboxRetryWorker`): exponential backoff retry for unsent outbox messages
- **BootReceiver** (`CanariBootReceiver`): re-registers FCM token + drains outbox on boot
- **Foreground guard**: retry is deferred when the TS outbox flusher is active

**A RESIDUE AFTER A DRAIN WAITS FOR THE NEXT TRIGGER, AND MAY WAIT A LONG TIME.** Observed on A1,
2026-08-11: a 110-message backlog drained to **3** and then stopped, with the app foregrounded,
unlocked, connected and polling `/api/presence` successfully throughout - and **zero log lines**
about those three for roughly ten minutes. One ordinary send into the same conversation cleared them
within 45 s (mirror 3 → 4 → 0), so the three were never stuck: the drain had simply run out of
triggers. Two consequences for anyone reading a residual count:

- **A non-zero mirror with no log is "nothing has happened since", not "delivery failed."** It is the
  same trap as reading the mirror at all while the FOREGROUND path is the one draining - the mirror
  is rewritten wholesale by the TS queue, so it lags. The server-side `queued_message` count for the
  group is the instrument that answers "did it leave"; during that run it climbed 55 → 162 while the
  mirror still read 110.
- The exponential backoff above did not visibly fire inside that window. Deliberately not opened as a
  Work Package: nothing was lost, and the trigger set (a send, a reconnect, a foreground, a boot) is
  what a real user generates constantly. Worth re-measuring only if a residue is ever seen to survive
  one of those events.

### Outbox mirror

Both platforms maintain an `outbox_pending.ndjson` mirror for background sends:

- TS writes to the mirror on every outbox append (`syncOutboxMirror` → `store_outbox_mirror`, a full rewrite, never an append)
- Background path reads + drains the mirror
- Preserves `silent` flag per entry
- Shared drain path: encrypt via JNI/FFI → POST `/api/mls/push/send`

The mirror is not one-way, and that is the part worth remembering. The native quick reply **appends** to it, so an entry can exist there that the TypeScript outbox has never heard of — and since `store_outbox_mirror` rewrites the file wholesale from the TS queue, the next foreground mutation would delete it. Two passes keep the two sides in step, and they are twins:

| Direction | Pass | What it does |
|---|---|---|
| native → TS, delivered | `reconcileOutboxSent` (`read_and_clear_outbox_sent`) | drains `outbox_sent.ndjson` and **deletes** the matching outbox entries |
| native → TS, undelivered | `adoptOrphanedMirrorEntries` (`read_outbox_mirror`) | **creates** an outbox entry, plus the local message, for every mirror line the TS queue does not know |

Notes on the adoption pass:

- It runs **before** `loadAndRestoreConversations`, so the adopted message is picked up by the ordinary history load and marked `pending` by `applyOutboxPendingStatuses` — there is no separate in-memory merge path to keep correct.
- `read_outbox_mirror` deliberately does **not** clear the file: the mirror stays authoritative for the background service until the next rewrite.
- The proto is decoded, not replayed opaquely, so an adopted entry becomes a first-class `text`/`reply` that the flusher re-encodes identically (same `messageId`, same `sentAt`). A `silent` entry stays `control` — sent verbatim and without a push, which is what silent means. Anything else logs and is left alone.
- A delivered send is removed from the mirror by the native drain, so an entry still present was not delivered. Should one race through, `reconcileOutboxSent` deletes it moments later; adoption is idempotent on the stable `messageId` either way.

#### The drain is a BATCH, and every part of its shape is load-bearing (WP-ANR-1, 2026-08-11)

The drain used to call the single-message native entry point once per queued message. Each call
re-read `mls.bin`, CBOR-decoded the entire OpenMLS keystore, encrypted one message, re-serialised
the whole keystore and wrote it back — `O(N x |mls.bin|)` on a 2.7 MB file, inside the **60 s the OS
allows a `goAsync()` BroadcastReceiver**. With the per-byte decode below multiplying it, that is
what ANRed the app from `CanariBootReceiver`, which fires after every Play Store update.

`send_messages_background_with_key` (`src-tauri/src/mobile/background.rs`) is now the one entry
point on both platforms — `nativeSendMessagesBackground` on Android,
`canari_native_send_messages_background` on iOS — and the platform loops only POST. Four properties,
each of which a plausible-looking implementation gets wrong:

| Property | Why it is not optional |
|---|---|
| **One load, one save** | The whole point: `O(\|mls.bin\| + N)` instead of `O(N x \|mls.bin\|)`. |
| **The save precedes any returned ciphertext** | A frame handed to the caller **is** a frame the caller POSTs. Returning one whose ratchet advance is not yet durable is exactly WP-LOSS-1: the sender rewinds and the peer can never decrypt what follows. A save failure therefore discards the entire batch. `one_load_and_one_save_cover_every_advance_in_the_batch` proves it by sending a further message from the *reloaded* file and having the peer decrypt it — a save that persisted only the first advance fails there and nowhere else. |
| **The batch is capped (`DRAIN_MAX_BATCH` / `kCanariDrainMaxBatch`, 100)** | The cap is on the ENCRYPT, not on the POST. Encrypting consumes a generation whether or not the frame is ever sent, so encrypting a backlog the drain has no time to deliver runs this sender ahead of the peer — eventually past OpenMLS's maximum forward distance, which is `GenerationTooFarAhead` and **no retry repairs it**. The surplus is not touched at all. |
| **Per-entry failures are isolated** | One group not yet joined on this device (`GroupNotFound`) must not strand the rest of the backlog. Each entry gets its own result; the id is echoed so a caller cannot mis-zip its own list. |

Two bounds sit on top of the POST loop, and they are different in kind. `DRAIN_POST_BUDGET_MS`
(35 s) is the safety net for a slow network: it leaves already-encrypted frames unsent, so it is the
abnormal exit, not the normal one — the cap above is what makes the normal case fit. And the mirror
is rewritten every `DRAIN_CHECKPOINT_EVERY` (25) deliveries rather than only at the end, because the
mirror is the *only* record of what is still owed: between two rewrites, a hard kill re-sends
everything already delivered. That bounds the duplicate window instead of letting it be the whole
backlog.

The shared logic is host-testable: `mod mobile` is gated on `any(android, ios, test)`, so
`cargo test` in `src-tauri` runs the batch tests (and the `proto_fields` tests, which were
device-only before) without a device build.

##### Measured on hardware, 2026-08-11

`adb install -r` over a device with a 110-line outbox mirror **is** the reproduction — nothing else
triggers `MY_PACKAGE_REPLACED`, and there is no gesture for it. The run went offline first (radios
disabled with `svc wifi/data disable`), which costs nothing: `drainOutboxBackground` calls
`encryptQueuedMessages` for the whole batch *before* the first POST and without consulting
connectivity, so the expensive half runs identically and only the POSTs then fail — the messages
stay queued, which is the outbox behaving as designed.

| Measurement | Before | This run |
|---|---|---|
| Receiver window, `onReceive` → `drainPendingOutbox: done` | **58.6 s** against a 60 s deadline | **2 331 ms** |
| The encrypt phase alone, 100 messages | — | **216 ms** (15:35:42.278 → .494) |
| MLS keystore loads for 100 encrypts | 100 | **1** (2 `MlsDeviceKeyStore.retrieve` for the whole process) |
| ANR lines | the user seeing "Canari ne repond pas" | **0** |

**The wall clock alone would not have earned the verdict.** A drain that gave up before encrypting —
offline, that is a plausible implementation — would also finish in 2 s, and the check as first
written could not tell the two apart. What settles it is the mechanism in the log: 100
`PrivateMessage::try_from_authenticated_content` and 100 *distinct* ratchet generations, against a
single keystore load. That is the `O(|mls.bin| + N)` shape, observed rather than assumed.

**The verdict is asymmetric, and saying so is the point.** This installed a DEBUG build over a debug
build, and debug measured ~10x release on the same fixture. A PASS here is therefore *stronger* than
a release pass — if the slow build clears the deadline, the fast one does a fortiori. A FAIL would
have been INCONCLUSIVE, and interpreting it would have needed a release build, which costs an
uninstall and therefore that phone's identity and history.

### Keyboard media (Android)

`KeyboardMediaBridge.kt` intercepts `InputConnection.commitContent` to handle GIF/sticker commits from the soft keyboard. Dispatches `canari-keyboard-media` DOM events picked up by `MainChatPage` → routed through the normal media pipeline.

### OIDC login opens a dedicated in-app browser session (WP-OIDC-TAB-1, Android shipped and verified 2026-08-08; iOS verified on hardware 2026-08-27)

`startOidcLogin()` (`auth.ts`) used to open the Authentik login with `openUrl` from `tauri-plugin-opener` on every mobile platform - a plain `ACTION_VIEW` launch. On Android this left the browser tab behind after login: `openUrl` opens in a task with no relationship to the app's own, so once the `fr.emse.canari://callback` deep link brought the app back to the foreground, nothing on either side could close the tab it left sitting on Authentik's last page.

The fix is `tauri-plugin-customtabs` (`frontend/src-tauri/plugins/tauri-plugin-customtabs/`), a mobile plugin (one command, `open_custom_tab`) that opens the URL via `androidx.browser.customtabs.CustomTabsIntent` on Android. A Custom Tab shares the **launching app's own task**, which is what lets the OS close it automatically the instant that task's activity resumes - confirmed live via `adb shell dumpsys activity activities`: the tab's `ActivityRecord` shared the app's task id right after `startOidcLogin()`, and was gone from that task's history entirely the moment the deep link returned. `auth.ts` now branches on `isMobileTauriRuntime()` for both platforms - iOS no longer keeps the plain `openUrl` launch.

**iOS side (built, not yet run on a device or simulator - this repo has never done that for any iOS build, see the device-verification ladder in CLAUDE.md).** `ios/Sources/CustomTabsPlugin.swift` presents the same URL in an `ASWebAuthenticationSession` instead, following `patches/tauri-plugin-keystore`'s `ios/` structure exactly (`Package.swift`, `Sources/`, `@_cdecl("init_plugin_customtabs")`). The one thing that is NOT a straight mirror of Android and needs checking first on hardware: `ASWebAuthenticationSession` intercepts its `callbackURLScheme` redirect itself, bypassing the app's normal URL-opening delegate entirely - so it would never reach `tauri-plugin-deep-link`'s `onOpenUrl` listener the way Android's intent-filter callback does. The plugin works around this by re-opening the callback URL via `UIApplication.shared.open(_:)`: since `fr.emse.canari://` is this app's own registered scheme, that call is expected to route straight back into the same app-delegate path the Android deep link already uses, keeping `hooks.client.ts` and everything downstream of it (the `/auth/callback` exchange) unchanged and shared between platforms. **VERIFIED ON HARDWARE 2026-08-27** (iPhone, iOS 18.7, against production): the `ASWebAuthenticationSession` presented, the redirect was intercepted, the self-reinvocation routed back into the app, and `/auth/callback` ran - the login failed one step later, in a server's CORS allowlist, which is a different defect entirely ([below](#the-ios-login-that-died-in-a-cors-allowlist)). Nothing in this plugin needed changing.

**Why this needed a real plugin and not a few lines of Rust JNI.** This app already has a working Rust → Kotlin JNI call (`flush_webview_cookies` in `commands/cookies.rs`, calling `CookieManager.getInstance()`/`.flush()`), and its own comment explains exactly why that pattern does not generalise: a JNI-attached native thread has no Java frames on its stack, so `FindClass` only reaches boot-classpath **framework** classes. `android.webkit.CookieManager` is one; `androidx.browser.customtabs.CustomTabsIntent` (bundled into the APK's own dex, like `MainActivity` itself) is not, and would fail to resolve the same way calling into `MainActivity` directly would. Tauri's own plugin-invocation mechanism (`@TauriPlugin`, `Plugin(activity)`) runs Kotlin code with the correct classloader context for exactly this reason, which is why the fix is a full (if minimal) mobile plugin, following `patches/tauri-plugin-keystore`'s structure - `Cargo.toml`/`build.rs`/`src/mobile.rs` on the Rust side, `CustomTabsPlugin.kt` + a Gradle module on the Android side - rather than extending the raw-JNI pattern.

`keyboardViewport.svelte.ts` pins the shell to the visual viewport while the keyboard is up:

```
--app-viewport-height: <visualViewport.height>px
```

**That height is the whole visual viewport, and the shell does not start at its top.** An ancestor
carries the status-bar inset, so on A1 (Pixel-class, 411x914 CSS, `devicePixelRatio` 2.625) the
shell begins at y=51 and is then made 571.81 px tall - bottom at 623, i.e. **51 px underneath the
keyboard**. Everything anchored to the shell's bottom goes with it, and the composer footer
(`position: absolute; bottom: 0`, height 78) is the one the user notices: they are typing into a
box the keyboard covers.

Measured on device 2026-08-06, keyboard open:

| | value |
|---|---|
| `window.innerHeight` | 914 (the layout viewport does **not** shrink here) |
| `visualViewport.height` | 571.81 |
| `--app-viewport-height` | 571.81px |
| `--keyboard-inset-bottom` | 342.19px |
| `--keyboard-layout-inset-bottom` | **0px** |
| `.app-layout` rect | top 51, bottom 623, height 571.81 |
| composer footer rect | top 545, bottom 623 |

The invariant to restore is `shell bottom <= visual viewport bottom`: the pinned height is the space
below the shell's own top, not the viewport's full height.

**First attempt (same day) was wrong and was reverted.** It fixed `computeSnapshot` to subtract a
new `shellTop` measurement (`.app-layout`'s own `getBoundingClientRect().top`) from
`--app-viewport-height`, on the reasoning that the var should already be "the space below the
shell's own top" at the source, rather than patching every CSS consumer with its own
`- env(safe-area-inset-top)` the way the desktop `AppSidebar` already does. That reasoning was
right for `.app-layout` **considered alone** and wrong for the system as a whole: `.app-layout`'s
own ancestor chain - `routes/+layout.svelte`'s `h-(--app-viewport-height,100dvh)` wrapper,
whose `padding-top: env(safe-area-inset-top)` **already** reduces its content box by the same
inset, unconditionally, whether or not the keyboard is open - was *already* correctly shrunk by
that same variable. Subtracting the inset a second time, inside the variable itself, meant
`.app-layout` (still separately pinned to `height: var(--app-viewport-height)` via
`html.keyboard-open .app-layout {...}`) ended up **shorter than its own already-shrunk immediate
parent** by exactly the inset amount - a gap of that size opened between the shell's real bottom
and the keyboard, revealing the page background behind it (a visibly different color, which is
what caught this on re-test: the user's screenshot showed a lavender strip above the keyboard that
had no business being there).

Measured live over CDP (`tools/cross-client-harness/cdp.mjs`, `adb forward tcp:9222
localabstract:webview_devtools_remote_<pid>`) on a Xiaomi/HyperOS phone, keyboard open, WITH the
first (wrong) fix applied:

| element | rect | note |
|---|---|---|
| `.app-layout` | top 0, bottom 495, height 495 | `--app-viewport-height` = 495px (534 vvHeight - 39 shellTop) |
| its immediate parent (`page-scroll-wrap`) | top 39, bottom 495, height 456 | sized from the OUTER ancestor's content box: 495 (outer height, same var) - 39 (outer's own padding-top) |
| visible viewport bottom | 534 (`offsetTop 0 + vvHeight 534`) | |

`.app-layout` (495 tall) was **taller** than the box it sits inside (456 tall) by exactly 39 -
the double-subtracted inset - and the browser scrolled the (nominally `overflow:hidden`,
`page-scroll-wrap:has(.app-layout)`-gated) container to its far scroll position to keep the
focused composer in view, revealing the 39px sliver of empty space above `.app-layout`'s
now-too-tall box instead of clipping it.

**The real fix (2026-08-07) deletes the redundant CSS rule instead**:

```diff
- html.keyboard-open .app-layout {
-   height: var(--app-viewport-height, 100dvh);
- }
```

`.app-layout` was never supposed to re-consume `--app-viewport-height` independently of its
parent chain - every intermediate layer between the outer ancestor and `.app-layout` (`flex-1`,
`absolute inset-0`, `height: 100%`) is a pure proportional fill, so once the OUTER ancestor shrinks
(which it already did, unconditionally, before any of today's changes), the shrink cascades down
correctly on its own with the inset subtracted exactly ONCE, at the top. `computeSnapshot` is back
to its original, simpler `viewportHeight: m.vvHeight` - the `shellTop` field, `readShellTop()`, and
the tests pinning them were all removed along with it. Re-measured live after the fix, same device,
keyboard open: `.app-layout` rect = `{top: 39, bottom: 534, height: 495}` - bottom lands exactly on
the visible viewport's bottom (534), matching the composer footer's own rect. Confirmed visually by
the user afterward.

**A second, independent bug found in the same investigation: the phone's system nav bar had NO
reserved gap at all when the keyboard was closed.** `MainActivity.kt` never called
`enableEdgeToEdge()`. Targeting `compileSdk`/`targetSdk` 36 means Android 15+ *enforces*
edge-to-edge regardless of app code, but that enforcement is OS-version-gated and, on this
Xiaomi/HyperOS device (Android 16), the WebView still reported `env(safe-area-inset-bottom)` as
`0px` with the keyboard closed - measured directly via CDP, not inferred. Since this app's CSS
assumes edge-to-edge pervasively already (`env(safe-area-inset-top)` padding on the root layout,
`env(safe-area-inset-bottom)` on the composer footer, on `LoginForm`, `Sidebar`, `CallOverlay`,
`MediaLightbox`, `PdfViewerModal`, and more), the fix is to stop depending on OS-enforced defaults
and just call `enableEdgeToEdge()` explicitly in `onCreate` (before `super.onCreate`, same
ordering constraint as `installSplashScreen()`). Re-measured after the fix: `env(safe-area-inset-
bottom)` = `16px` with the keyboard closed on the same device - a real, non-zero gap above the nav
bar for the first time.

A third, smaller bug rode along in `app.css`: the composer footer's own bottom-padding floor was
`max(0.75rem, env(safe-area-inset-bottom))` with the keyboard closed but `max(0.5rem, ...)` with it
open - two different `git blame`d origins, no comment or rationale anywhere, the keyboard-open one
introduced by a commit literally titled "fix a lot of things". Combined with `env(safe-area-inset-
bottom)` collapsing to `0px` whenever the keyboard is open (confirmed live: the gesture-bar inset
doesn't exist once the keyboard covers that area), the composer's reserved space genuinely differed
between the two states - 12px vs 8px - which read as "the space below the input keeps changing."
Unified to `0.75rem` in both states (`.chat-composer-footer`, `.keyboard-open .chat-composer-footer`,
and their `.mobile-convo-open` mirrors) so the reserved space does not visibly shrink just because
the keyboard opened.

The same investigation also found a fourth, independent bug in `app.css`'s `.chat-messages-scroll`
padding: `--chat-composer-height` (the composer footer's real `offsetHeight`, via `ResizeObserver`
in `ChatComposer.svelte`) already includes the footer's own `env(safe-area-inset-bottom)` padding,
but the base rule and the `.keyboard-open` rule both added it a second time on top - only the
`.mobile-convo-open` rule had it right, and it lost to `.keyboard-open` by CSS source order
whenever both classes were active (mobile chat + keyboard open) - exactly the state a phone is in
while typing. Fixed by dropping the redundant addition from both rules; the guessed fallback
constants used only while the var is unset keep their own `env()` addition, since a fallback never
included it in the first place.

Two other things the measurement settles, both worth keeping:

- **`layoutInsetBottom` is dead on this path.** `computeSnapshot` sets it only when
  `isOpen && !layoutShrunk`, and `layoutShrunk` is true as soon as `winH - vvHeight > threshold*0.35`
  - which is precisely what "the keyboard opened without resizing the window" looks like. So
  `--keyboard-layout-inset-bottom` reads 0 exactly when it is needed. Whether that is the same
  defect or a second one is not established; do not assume.
- **How to reach it:** tap the composer (renders correctly), press HOME, return to the app. The
  keyboard comes back and the shell is never re-laid-out for it. A pure `focus()` from script
  reaches a different broken state - a large gap between the content and the keyboard - so the
  variable is mis-set in both directions and the repro that matters is the ordinary gesture.

### The release build's shape, and what Google Play's analysis asked of it

Play's pre-launch analysis listed four recommendations on 2026-08-26. Two were already answered, one
was a real defect (the avatar decode above), one was a missing line. **The value of writing this down
is knowing which parts of that list will never clear**, so nobody spends a session on them again.

**Answered already: edge-to-edge.** `enableEdgeToEdge()`, `viewport-fit=cover` and 46
`env(safe-area-inset-*)` declarations, all above. Play's advisory goes to every `targetSdk >= 35`
app; its static analysis cannot see CSS. `androidWindowLayout.test.ts` now asserts the call, which
nothing did before - and it lives in `gen/android`, which a Tauri upgrade regenerates from a
template.

**Will never clear: the deprecated window APIs.** Play names three call sites for
`setStatusBarColor` / `setNavigationBarColor` / `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` and not
one of them is ours.

- `androidx.activity`'s `EdgeToEdgeApi23/26/29` and `EdgeToEdgeApi28`, reached **by
  `enableEdgeToEdge()` itself** - the call Play's own first recommendation asks for. Checked against
  the 1.13.0 sources rather than assumed: unchanged, `@Suppress("DEPRECATION")`-ed, and even the new
  `EdgeToEdgeApi35` sets `statusBarColor = TRANSPARENT`. **No upgrade silences it**, and `minSdk` 28
  means those branches genuinely run on Android 9-14.
- `com.google.android.gms.common.images`, from play-services-base by way of Firebase.
- `MaterialDatePicker`, which WAS ours to remove.

**`com.google.android.material` is out of the APK, and dropping our own line would not have done
it.** Eight modules declared it - six Tauri plugins from the cargo registry, the two local patched
ones, and this app - and NOT ONE Kotlin file in any of them names a class from it; it is
plugin-template boilerplate. Its only real use here was the `Theme.MaterialComponents.DayNight.NoActionBar`
parent, now `Theme.AppCompat.DayNight.NoActionBar` (`WryActivity` extends `AppCompatActivity`, which
asks for nothing more). Removing the `implementation` line alone would have resolved the plugins'
1.7.0 instead and kept the library, `MaterialDatePicker` included, so `app/build.gradle.kts` also
excludes the module from every configuration. **The exclusion is an assertion that it is unused, not
a workaround for a conflict** - and the thing that makes it safe to state is the grep above, not the
build, since the plugin modules compile against their own declaration either way.

**Resource shrinking was off, and the flag that tunes it had been on the whole time.**
`android.r8.optimizedResourceShrinking=true` sat in `gradle.properties` doing nothing, because
`isShrinkResources` was never set - so R8 kept every resource, and therefore every class reachable
from one, which is how an unused UI library stayed in the DEX. Now set on the release build type.
Safe mode is the default, so a resource named through `Resources.getIdentifier` would still be kept;
there is no such lookup anywhere in this app, and no `R.layout` reference either, which is why
`activity_main.xml` - a `<merge>` whose own comment says it is not rendered - goes with it.

**`windowBackground` had never been set.** `onWebViewCreate` makes the WebView transparent on
purpose so the Activity background shows through while SvelteKit hydrates - that is the
startup-flash fix - but the theme declared no background, so what showed through was the parent
theme's grey `colorBackground`, while `app_background` sat defined in `values` and `values-night` and
referenced by nothing. It is now the theme's `android:windowBackground`, which is also what the
Android 12+ system splash paints behind the icon. `values-night/themes.xml` is deleted rather than
updated: `@color/app_background` already resolves per configuration, so the second copy of the style
said nothing.

`androidPlayRecommendations.test.ts` holds the actionable half - the two Gradle facts, the theme
parent, the icon size and every `BitmapFactory` call having options. **What it cannot hold is whether
the shrunk APK still works**, since the debug build type never minifies: that is
[device-verification check R](../device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android).

### Play's Q3-2026 quality requirements, measured against this app

A second Google Play mail, the same day as the pre-launch analysis, announced two requirements with
their own enforcement dates. Three of the four thresholds are measured by Play from field data, not
by anything here, so what follows is where this app STANDS, and the one place it did not stand at all.

| Requirement | Threshold | Enforced | Where this app is |
| --- | --- | --- | --- |
| Dynamic memory | anon RSS + swap, 28-day P90, 2 GB foreground on a 4 GB device | Feb 2027 | **readable, still empty**: `anonRssAndSwapMemoryUsageMetricSet` carries P50-P99 with an `appState` dimension, and [the vitals watch](../../../tools/play-vitals/README.md) queries it. No rows yet - too few installs for Play to report a distribution |
| Bitmap memory | > 200 MB backgrounded, > 400 MB cached | Feb 2027 | **bounded by construction**, see below - and now also *observable*, via `bitmapMemoryUsageMetricSet` in [the vitals watch](../../../tools/play-vitals/README.md) |
| Code optimization | >= 25% across obfuscation, optimization and shrinking, for apps over 10 MB of DEX | Feb 2027 | **out of scope by size**: the release DEX is 2.83 MB. Minified and shrunk anyway |
| Zero-Tap Sign-In restoration | Restore Credentials API, apps with any sign-in | Apr 2027 | **NOT IMPLEMENTED** - a work package, see [backlog](../backlog.md) |

**The bitmap threshold is answered by the shape of the code, not by a measurement.** Every
`Bitmap` in the Android app is allocated in `CanariFirebaseMessagingService`, and there are exactly
three producers: `decodeSampled`, which every `BitmapFactory` call now routes through;
`circleCrop`, which allocates one `target x target` ARGB_8888 where `target` is
`notification_large_icon_width`; and `generateInitialsBitmap` at a fixed 96 px. The peak is one
sampled source plus one target-sized copy - hundreds of kilobytes, three orders of magnitude under
the backgrounded threshold, and it is the FCM service process that would have paid for it.

**The migration requirement found a hole that had always been open.** The app has always meant to
refuse both extraction channels, and `res/xml/data_extraction_rules.xml` says so in full - `exclude
domain="root"` under both `<cloud-backup>` and `<device-transfer>`. It was referenced by nothing.
Its own header comment claimed the manifest referenced it; the manifest's header, in as many words,
listed `dataExtractionRules` among the attributes never to restore, on the grounds of a merge
conflict. So the file described a policy, the manifest forbade wiring it up, and each read as if the
other had it covered.

That gap is not equivalent to `allowBackup="false"`. That attribute is deprecated from Android 12,
and Google's own documentation says that on some manufacturers it disables cloud backup **without**
disabling device-to-device transfer; and where no `<device-transfer>` section is declared, that mode
is *fully enabled* for everything outside `cache` and `no-backup`. With minSdk 28 and targetSdk 36,
almost every install is on the side where the attribute does not reach. So both are kept: the
attribute covers API 28-30, the rules file covers 31 and up, and `tools:replace` names both - which
is all the merge conflict ever needed.

**What a transfer would have carried is worse than a leak, it is a broken install.** Keystore
material is non-exportable by construction, so a migrated app would arrive holding this device's MLS
state without the key that seals it. The product already has the right answer for a new phone: enrol
as a new MLS client and be re-invited, which is what `frontend/src/lib/backup.ts` implements and
what a restore onto a different device already reports as `lifecycle: 'pending'`.

**The instrument that found it was the resource shrinker turned on an hour earlier.** It reported
`xml:data_extraction_rules is not reachable` and dropped the file from the APK. It now reports
`reachable from AndroidManifest.xml`, and the file ships. That is worth keeping in mind for its own
sake: a shrinker's reachability report is a list of everything the app declares and never consults.


## Shared native code

Rust FFI functions shared across both platforms via `frontend/src-tauri/src/mobile/`:

| Module | Purpose |
|---|---|
| `background.rs` | Background message decrypt, media decrypt, outbox drain |
| `proto_fields.rs` | Minimal protobuf encoder (no TS runtime in background) |
| `*_ffi.rs` | Platform-specific FFI exports (JNI for Android, C-ABI for iOS) |

Key FFI functions:
- `nativeDecryptMessage` / `canari_native_decrypt_message` — MLS decrypt in background
- `nativeDecryptMedia` / `canari_native_decrypt_media` — Media blob decrypt
- `nativeBuildTextMessageProto` / `canari_native_build_text_message_proto` — Reply proto encoder
- `nativeBuildReadWatermarkProto` / `canari_native_build_read_watermark_proto` — Read-watermark proto encoder

## Acknowledging a conversation from the notification shade

**"Marquer comme lu" and a quick REPLY are the same acknowledgement** - a user who answered a
conversation has read it (product decision, 2026-08-31). Both call one function on each platform
(`sendReadWatermark` in `CanariNotificationActionReceiver.kt`, `CanariSendReadWatermark` in
`canari_push.mm`), so neither can drift into its own idea of what reading means.

### The instant is carried, never looked up

The frame is `AppMessage{ system: SystemMsg{ event: "read_watermark", data: {"at"} } }`, built by
`build_read_watermark_app_message` (`proto_fields.rs`) and reached through
`nativeBuildReadWatermarkProto` / `canari_native_build_read_watermark_proto`. `at` comes from the
notification's own intent - `EXTRA_SENT_AT` on Android, `userInfo["sentAt"]` on iOS - stamped when
the notification was posted, from the decrypted message's `sentAt`.

That is the whole correction. Until 2026-08-31 the action built a `read_receipt` naming message
**ids**, and got them from `fcm_message_cache.ndjson` - a file `consumeFcmCache()` CLEARS at every
app boot. Once the app had been opened after a notification arrived, the list was empty and the
action sent **nothing**, silently, because an empty list is indistinguishable from a conversation
with nothing to acknowledge. A fact the notification already holds must not be re-derived from a
cache written for another purpose and outliving nothing.

`at` is also never this device's clock. Watermarks merge by `max` across devices, so a phone running
fast would mark future messages read permanently and unfixably - the rule `watermarkAfterReading`
(`readState.ts`) states for the foreground path, holding identically here. `at <= 0` means "this
notification predates the extra": the action says nothing rather than inventing something. Since
`extract_full_message_info` always emits a `sentAt` key (0 when the proto carries none), the
`sentAt`-defaults-to-now branches in both platforms' decrypt-result parsers are unreachable from
here.

### Two destinations, because the frame only reaches the other side

| Destination | Carrier | What it fixes |
| --- | --- | --- |
| peers, and our own other devices | the outbox entry (`silent`, `durable`), drained in the background | their badge, their read ticks |
| **this** device's own database | `read_watermarks.ndjson`, merged at the next login | the badge on the phone the user is holding |

The second half is easy to lose and was: the control frame goes out to the group, and MLS does not
echo it back to its sender, so nothing told this device's conversation row. The user acknowledged a
conversation from the shade, opened the app, and found it unread - which reads exactly like the
action having done nothing at all.

`read_watermarks.ndjson` is one line per conversation (`{"groupId", "at"}`), collapsed on write
keeping the larger `at`, which bounds it by the number of conversations rather than by a cap that
could drop the very entry it was written for. `read_and_clear_read_watermarks` (`push.rs`) reads and
DELETES it; `consumeNativeReadWatermarks` (`readWatermarkCache.ts`) merges it at login, after
`consumeFcmCache` so the messages it covers are already in memory, and recomputes `unreadCount`
FROM the merged watermark rather than writing a count beside it.

The receiving side still accepts the legacy `read_receipt` and converts it through
`watermarkAfterReading` - that shim is for clients older than this change, and is dated in
[legacy-compatibility](../legacy-compatibility.md). Nothing in this repo sends one any more.

## The push secret has two homes, and the file is always the newer one

`POST /mls/push/register` mints a fresh `rawSecret` on **every** call and overwrites the stored hash,
so the previous secret is dead the instant it answers. That secret reaches the background sender by
two hops, and the second one is slower than the first:

| Store | Written by | When |
|---|---|---|
| `pending_push_secret.txt` (app data dir) | the WebView, via `store_push_secret` (`push.rs`) | at every `/register`, i.e. at each login/unlock that re-registers |
| Android Keystore / iOS Keychain | `CanariApplication.processPendingPushSecret` (also run from `MainActivity.onResume`) / `CanariRetrievePushSecret` | at process start and at each resume - always BEFORE the registration that writes the file |

So the file, whenever it exists, is **newer by construction**, and the Keystore is one registration
behind for the whole window between an unlock and the next resume. `retrievePushSecret` reads the
file FIRST for exactly that reason, migrates it into the Keystore, zeroes it over its own byte length
and deletes it - the same consumption the startup hook does, so the two paths converge on one
representation and the file's presence never means anything but "newer than the Keystore". An empty
file is a half-written handoff, not an answer: it is left in place and the Keystore is used.

**Reading the Keystore first is what "the notification quick reply is broken" was.** Every background
send made from a merely backgrounded app authenticated with an invalidated secret and got `403`,
while a KILLED app worked perfectly - FCM starts a fresh process, `onCreate` migrates the file, and
the Keystore is valid again. That asymmetry is why the defect survived a passing measurement; see
[check K](../device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found).

**A failed background send owns the notification it came from.** Android consumes the `RemoteInput`
when the action fires and draws a spinner it never resolves, so `handleReply`'s failure branch
re-posts the notification (`repostReplyPending`) rather than leaving it: same id, spinner ended, both
actions restored, the typed text shown as a pending message attributed to our own `Person`. It also
calls `OutboxRetryWorker.enqueueIfHealthy`, which the FCM drain's failure path had had all along.
Neither cancels the send - the entry stays in `outbox_pending.ndjson` and is still adopted at the
next login by `adoptOrphanedMirrorEntries`.

## Android / iOS parity, and where it is actually guaranteed

**Code parity was audited file by file at v0.12.0 (2026-08-03) and holds.** The residual
asymmetries are imposed by the operating systems and are not defects: no boot broadcast on iOS,
CallKit against a full-screen intent, no self `Person` on iOS, and a quick-reply action that
relaunches a killed process on iOS where Android uses a broadcast receiver.

**That audit read SOURCE files, so it structurally could not see a divergence expressed in
CONFIGURATION** — and every parity defect found since has been exactly that. A second pass on
2026-08-07 covered the configuration surface; what it found and what now guards each one:

| Surface | Expressed in | State |
|---|---|---|
| Plugin ACL (`deep-link`, and every other plugin) | `capabilities/*.json` — **shared** | Was missing for `deep-link`, breaking **both** platforms' cold-start deep links. Fixed; `tauriCapabilities.test.ts` guards it |
| App Link **hosts** | `appSiteAssociation.ts`, `AndroidManifest.xml`, `canari_iOS.entitlements` | iOS claimed `applinks:www.canari-emse.fr` alone, which can never validate (`www` 301s, and Apple does not follow redirects). Removed; `appSiteAssociation.test.ts` now asserts all three agree |
| App Link **paths** | the same three files | Generated from one list, already guarded |
| Custom URL scheme | `AndroidManifest.xml` (per host), `Info.plist` `CFBundleURLTypes` (per scheme) | Equivalent by construction: iOS claims the scheme, so all five hosts follow |
| `push_context.json` fields | Rust writer, three native readers | `pushContextFields.test.ts` |
| FCM manifest entries | `AndroidManifest.xml` | `androidFcmManifest.test.ts` (Android-only by nature) |
| Cookie-jar durability | `commands/cookies.rs` | Android-only **by API**, not by decision — iOS has no flush to call and has never been observed. `check P` |
| Server CORS allowlist | `apps/*-service/src/cors-origins.ts`, `ALLOW_ORIGIN` in `serve-prod.yml` | Named the Android origins ONLY. Broke iOS login outright - see below. One module per service now, with a test naming each platform's origin individually |
| Third-party cookie acceptance | `MainActivity.kt` (Android), nothing on iOS | MEASURED 2026-08-27: Android opts in and survives `am force-stop` (1 refresh, 200); iOS presented `cookies=[]` on 120. WKWebView has no equivalent API, so on `tauri://localhost` the credential is carried in a header instead - [`sessions.md`](../sessions.md#the-credential-a-client-carries-itself) |
| Push token acquisition | `canari_push.mm` (iOS), `MainActivity.kt` + FCM SDK (Android) | MEASURED 2026-08-27: `push_token` held 49 `android` rows and had NEVER held one `ios` row. The iOS launch-time FCM fetch was written as Android's mirror, but iOS has a precondition Android does not - see [below](#the-fcm-token-an-iphone-could-never-obtain-and-the-silence-that-hid-it-for-the-platforms-life). Fixed 2026-08-28; a device now REPORTS the absence, so one `GROUP BY` settles it |
| Device CLASS inside one platform | `navigator.userAgent`, until 2026-08-30 | An iPad reports itself as `Macintosh` (desktop-class browsing is WKWebView's default), so every iOS branch took its WEB side on an iPad - which is what App Review rejected, see [below](#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish). The platform is read from `tauri-plugin-os` now, and `appVersion.test.ts` / `mlsPlatform.test.ts` assert it against that exact user agent |

Two rules come out of that table, and they are the ones to apply before adding anything native:

- **Parity of code is not parity of the manifests, entitlements and served association files.** Those
  are a separate surface with its own tests — and it is the surface every divergence has been on.
- **A no-op on one platform must say WHY.** "Nothing to do here" and "there is no API for this and
  nobody has looked" are different statements, and only the first is evidence of parity. Where the
  answer needs hardware, it becomes a lettered check in
  [`device-verification.md`](../device-verification.md) rather than a comment implying safety.

**iOS ran on real hardware for the first time on 2026-08-27** (an iPhone on iOS 18.7, against
production), and the first thing it found was the CORS defect below. Everything the native project
owns worked on that run: the deep link, the `ASWebAuthenticationSession`, the self-reinvocation
through `UIApplication.shared.open(_:)`, and the `/auth/callback` route the two platforms share. What
did not work was owned by a server. Beyond that single flow nothing below the test line is verified on
iOS, so parity is still maintained by construction - one shared file wherever the platforms can share
one, and a test reading both trees wherever they cannot.

### The iOS login that died in a CORS allowlist

**Measured, prod, 2026-08-27 20:10:46 UTC.** The user signed in on an iPhone, Authentik accepted the
credentials, the deep link brought the app back, and the app showed "Échec de la connexion / Load
failed". nginx's access log named the whole defect in one line:

```
"OPTIONS /api/auth/oidc/callback HTTP/1.1" 404 89 "-" "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 ...)"
```

The four NestJS services each carried their own inline CORS allowlist, and each named
`http://tauri.localhost` - the ANDROID WebView origin - and nothing else from the native side. iOS
sends `Origin: tauri://localhost`, which matched nothing, so the delegate answered
`callback(null, false)`. The Rust chat-gateway's `ALLOW_ORIGIN` had no Tauri origin at all.

Three things compound into a defect that looks like a broken deep link:

- **A denied preflight is a 404, not a 403.** `callback(null, false)` only omits the CORS headers; it
  does not answer the request. The `OPTIONS` then falls through to a router with no `OPTIONS` handler,
  which 404s. Nothing anywhere reports "origin refused".
- **WebKit tells JavaScript nothing.** Any CORS refusal surfaces as a bare `TypeError: Load failed` -
  no status, no origin, no reason. That string was the entire diagnostic the app had, and it is why the
  report arrived as "the deep link does not work".
- **The allowlist did not read as mobile code.** It sat in four `main.ts` bootstraps, so a parity audit
  reading the native tree could not see it, twice: the surface is configuration, and it is not even in
  the frontend.

**The fix, and what now prevents the next platform from being forgotten.** `cors-origins.ts` (one
copy per service, deliberately duplicated - there is no shared TS package) owns the list, the
predicate and the delegate. `TAURI_WEBVIEW_ORIGINS` holds all three platform origins with the platform
written beside each, and `cors-origins.spec.ts` asserts each one BY NAME plus the list's length,
because a test that loops over the list under test passes just as happily when a platform is deleted
from it. A refusal now logs the origin once, budget-capped, at a level that accuses. A denial stays
`callback(null, false)` and is never `callback(new Error(...))`: that turns a refused preflight into a
500 on the request itself, which is a separate incident this repo already had (prod 2026-08-19, on
`GET /api/media/public/:id`).

Rules, in [`durable-rules.md`](../durable-rules.md#mobile-and-native---frontendmobile): a server's origin allowlist is a
fact about its CLIENTS, and a Tauri client has one origin per platform; and platform parity is not a
property of the native project.

### The FCM token an iPhone could never obtain, and the silence that hid it for the platform's life

**Measured on prod, 2026-08-27.** `SELECT platform, count(*) FROM push_token GROUP BY platform`
answered `android | 49` and nothing else. Not one row had ever carried `platform = 'ios'`, and
`voipToken` was null on all 49, so no PushKit token existed either: an iPhone had never been able to
receive a message alert, a mention or a CallKit ring, and had not since the platform shipped. The
question was only asked because the CORS defect above had put an iPhone in front of a log for the
first time.

**Everything in the chain was present**, which is why this needed a measurement rather than a build:
the v0.14.6 iOS build resolves and links `firebase-ios-sdk @ 12.11.0` with an explicit
`FirebaseMessaging` dependency (read out of the run log), `canari_iOS.entitlements` carries
`aps-environment: production`, `Info.plist` declares `remote-notification` and
`FirebaseAppDelegateProxyEnabled: true`, and `canari_push.mm` installs a `FIRMessagingDelegate`, a
`PKPushRegistry` and the NSE.

**The defect was an ORDER, and the order was inherited from the platform that has no such
constraint.** `canari_push.mm`'s `CanariPushSetup` called `[[FIRMessaging messaging]
tokenWithCompletion:]` at the bottom of `canari_ios_bootstrap()` - written as the declared mirror of
Android's `FirebaseMessaging.getInstance().token`, which at launch has NO precondition. On iOS it
has one: **FIRMessaging cannot mint an FCM token before an APNs token exists**, and an APNs token
only arrives after `registerForRemoteNotifications`, which the same bootstrap registers an observer
for on `DidFinishLaunching` - i.e. strictly later. That call could therefore only ever fail with *No
APNS token specified before fetching FCM Token*, log one line, and return without writing.

**The fix carries the fetch to where the precondition is known to hold.**
`CanariSyncFcmTokenIfApnsReady()` (declared in `canari_push.h`) checks
`[FIRMessaging messaging].APNSToken` first and returns with a line if it is nil, rather than handing
the work to a layer certain to refuse it; `CanariOnDidBecomeActive` calls it. `didBecomeActive` fires
after launch completes and again on every foreground, so the first activation with an APNs token in
hand mints and persists the FCM token, and no timer is involved.

**THE DEFECT UNDERNEATH IS THE SILENCE, and it is the one that cost a platform's whole life.** A
client that cannot obtain a token used to `console.warn('[Push] No FCM token available')` and stop.
That line reaches a WebView console nobody can open on iOS from a Windows machine, the server was
never told, and **the absence of a row is indistinguishable from a device nobody opened** - so 49
healthy Android rows stood in for both platforms. `PushNotificationService` now returns a typed
`PushRegistrationOutcome` instead of a boolean, and when the retry ladder is exhausted it POSTs
`/api/mls/push/unavailable` with the platform and the reason. The server writes no row and only logs
`[PUSH_UNAVAILABLE] user=… device=… platform=… reason=…` - see
[chat-delivery](../services/chat-delivery.md#a-device-that-cannot-get-a-push-token-at-all).

**MEASURED ON HARDWARE 2026-08-28, and the verdict was split.** On a fresh 0.14.8 install the
server printed `[PUSH_UNAVAILABLE] ... platform=ios reason=no-token` at 01:23:39 - the first thing
this platform had ever said about its push chain, so the reporting half is proven. But `push_token`
still held no `ios` row: **the ordering fix was necessary and was not sufficient.**

#### The APNs token had nowhere to land, because the proxy meant to catch it installed nothing

**FOUND 2026-08-28 by reading the order, not by another build.** `FIRMessaging` cannot mint an FCM
token before `FIRMessaging.APNSToken` is set, and the only thing that sets it is
`application:didRegisterForRemoteNotificationsWithDeviceToken:`. That method belongs to the
`UIApplicationDelegate` - **and on iOS this app does not own its delegate.** wry creates and installs
one inside `ffi::start_app()`; `main.mm` deliberately declares none, because a second one would never
be registered. Firebase's answer to exactly that situation is the App Delegate Proxy, which `Info.plist`
enables explicitly and `main.mm` names as the bridge.

The proxy installs itself ONCE. It reads `[UIApplication sharedApplication].delegate` at the moment
Firebase is configured, under a `dispatch_once`, and never looks again. `[FIRApp configure]` runs from
`canari_ios_bootstrap()` - that is from `main()`, **before** `ffi::start_app()` - when there is no
application object at all and therefore no delegate. It found nil, gave up, and never retried. So on
every launch for the platform's entire life: the OS obtained an APNs token, handed it to a delegate
with no such method, and the token was dropped; `APNSToken` stayed nil; every FCM fetch failed on its
precondition; the device reported `no-token`.

**The evidence was already in the file.** `CanariInstallRemoteNotificationHook` swizzles wry's delegate
BY HAND for remote notifications, and `CanariPushProcessRemoteNotificationUserInfo` calls
`[[FIRMessaging messaging] appDidReceiveMessage:]` by hand too - both are work the proxy performs when
it is installed. The codebase had already recorded that the proxy was absent; nobody had connected
that to the token.

The fix stops depending on it. `CanariInstallApnsTokenHook`, installed on
`UIApplicationDidFinishLaunching` - the first moment the delegate exists, which is precisely what
Firebase's proxy could not wait for - puts the two APNs callbacks on wry's delegate class with
`class_replaceMethod`, sets `APNSToken` itself, and asks FCM for a token on the spot. It ADDS the
method today and would CHAIN to a real one tomorrow, so a wry that starts implementing it is extended
rather than silently overridden.

**AND THE REPORT NOW CARRIES THE CAUSE INSTEAD OF THE SYMPTOM.** `no-token` covers faults whose fixes
are opposite, so the native layer - which branches on the distinction already - writes the branch it
took to `push_diagnostic.txt`, the Rust command `get_push_diagnostic` reads it and
`PushNotificationService` sends it verbatim: `no-apns-token` (APNs never answered),
`fcm-token-fetch-failed` (APNs answered, FCM refused), `apns-registration-refused` (the OS refused
registration outright - the branch that had no observer at all), `app-delegate-absent`. The file is
deleted the moment a token arrives, so a reason cannot outlive its cause. See
[check S](../device-verification.md) for the run this must be measured against.

### The iPad that called itself a Macintosh, and the login App Review could not finish

**Measured, prod, 2026-08-30 11:28:36 UTC**, in Authentik's own access log - one line, the only one
of its kind in five days:

```json
{"event": "/application/o/authorize/?client_id=...&redirect_uri=tauri%3A%2F%2Flocalhost%2Fauth%2Fcallback&...",
 "status": 400, "remote": "146.70.98.237",
 "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"}
```

That is App Review, on an iPad Air 11-inch (M3) running iPadOS 26.6, tapping Sign in and being shown
Authentik's "Redirect URI Error" page. The submission was rejected under guideline 2.1(a).

**The user agent is the whole defect.** WKWebView's default content mode is
`preferredContentMode: .recommended`, and on an iPad wider than 375 px "recommended" means
DESKTOP-CLASS BROWSING: the WebView reports `Macintosh; Intel Mac OS X 10_15_7` and names no Apple
device at all. Note also what the string does NOT contain - no `Version/`, no `Safari/`, no
`Mobile/15E148` - which is how an in-app WebView differs from Safari, and why nothing about the
device class survives into it.

`isIosTauriRuntime()` tested that string against `/iphone|ipad|ipod/`. On every iPad the answer was
false, so the app took the WEB side of each iOS decision in the same binary an iPhone runs
correctly:

| Reader | What an iPad got instead |
|---|---|
| `oidcRedirectUri()` | `${location.origin}/auth/callback` = `tauri://localhost/auth/callback`, which Authentik refuses - the rejection |
| `startOidcLogin()` | the main WebView navigated to Authentik, instead of the `ASWebAuthenticationSession` whose callback returns through `fr.emse.canari://callback` |
| `detectRuntimeDeviceOs()` | a device row filed under `deviceOs: macos` |
| `useMessaging` | the browser notification path beside the native one - a duplicate per message |
| `buildUpdateTarget()` | an APK, or a reload, in place of the App Store |
| `CallOverlay`, `ChatBackgroundService` | the desktop RTC and heartbeat branches |

**Fixed at the fact, not at its six readers.** `tauri-plugin-os` publishes the COMPILE-TIME target
OS into the WebView (`window.__TAURI_OS_PLUGIN_INTERNALS__`), and `platform()` - synchronous, so it
drops straight into functions that were regex tests - is what the detectors answer from. Where the
plugin is absent inside a Tauri runtime it THROWS, deliberately: a platform this app cannot name
must be loud rather than silently "not mobile". Only the web build still reads the user agent,
because there is no native side to ask; it is lied to identically, so an iPad browser is told apart
from the Mac it claims to be by `navigator.maxTouchPoints`.

**Why an iPhone run proves this one for the iPad.** `platform()` is a constant compiled into the
iOS target - it cannot differ between two devices running the same binary - and the iPad's only
difference, its user agent, is no longer read by anything. So a login on the iPhone that logs
`uri=fr.emse.canari://callback` establishes the mechanism for both, which is the one case in this
file where hardware we do not have is not owed a check of its own. What an iPhone would NOT prove is
anything about iPad LAYOUT, which nothing here has ever measured.

### Where the submission stands, and what each half is waiting on

**2.1(a) IS PASSED, and the evidence is what App Review did NOT say.** Build 0.14.14 carries the
platform fix above (`875d2fb0` is an ancestor of the 0.14.14 bump), it was reviewed on 2026-08-31 on
the same iPad Air (M3), and the letter that came back opens with *"upon further review, we
identified additional issues"* and never mentions the login again. A reviewer who could not sign in
could not have reached the age-rating and VoIP questions it does raise. That is inference from
silence, so it is written as such - but it is the only reading consistent with the two guidelines
they did cite. **The iPhone login that would have proven it directly was never run, and is no longer
owed.**

**What the 2026-08-31 letter asks, on a build where both causes were already known:**

| Guideline | What they found | Why they were right, and what answers it |
|---|---|---|
| 2.3.6 Accurate Metadata | Age Rating declared In-App Controls; no Parental Controls or Age Assurance in the app | The questionnaire's step 1 had *"Social networking features disabled for users under 13"* set to YES, which by Apple's own definition asserts the Declared Age Range API. The app has no age notion at all. Corrected to NO in App Store Connect on 2026-09-01; nothing in this repository changed. |
| 2.5.4 Software Requirements | `voip` in `UIBackgroundModes`, no VoIP service located | Literally true of the build they ran: on any iPad `startPushService` returned `desktop - no FCM` before `get_voip_token` was ever called (`48d31eaa`, NOT in 0.14.14), so no `voipToken` was registered and no CallKit ring was deliverable. Answered by holding the whole calling surface off in 0.14.15 - `CALLS_ENABLED`, see [calls module](modules/calls.md) - and removing the declaration with it. |

**0.14.15 also carries `48d31eaa` itself**, which is owed regardless of calls: it is why an iPad
could not obtain an FCM token either, and therefore received no message notification of any kind.

### Where the three channels actually are, 2026-09-04, and the ONE call that is missing

**READ THIS BEFORE PLANNING A RELEASE.** Two stables were published on 2026-09-04 and NEITHER
reached production, because the production estate is gated on both stores taking the version. The
state is not guessable from any version number:

| | version | how it got there |
| --- | --- | --- |
| production web | `0.16.1` | the `production` job was `skipped` in both runs - it needs `android` AND `ios` green |
| Google Play `production` | `0.16.2` | committed by the `0.16.2` run; `0.16.3`'s Play job was also green |
| App Store | **nothing published** | version `0.16.3` exists, holds build `1600399` and its notes, and sits UN-SUBMITTED in review submission `575c5bbb` |

**The only request never made is `PATCH /v1/reviewSubmissions/575c5bbb {submitted: true}`.**
Everything before it succeeded on the `0.16.3` run: the prepared-and-forgotten `0.16.1` slot was
renamed, the build attached, the notes written. The item POST then answered 409, for the reason in
the entry under `[Unreleased]` in `CHANGELOG.md` - a check that compared a JSON:API linkage its own
request had not asked for, and so read `undefined` for every item.

**WHY A RE-RUN OF THE `v0.16.3` iOS JOB DOES NOT FINISH IT, and why the reason people reach for is
the wrong one.** The duplicate TestFlight upload is NOT the obstacle: `ios.yml` reads
`ITMS-4238 / Redundant Binary Upload` as success precisely so that *Re-run failed jobs* works, which
is what the section above this one is about. The obstacle is that **the tag carries the code**: a
re-run checks out `v0.16.3`, which predates the fix, and replays the same 409. So the next stable is
what completes this - the corrected script finds the `0.16.3` slot under a different name, renames
it, and this time does not re-add the item.

**Two version numbers were spent on two defects that no gate here could have caught**, and each was
invisible for one reason: the App Store submission is the only part of the release that talks to
a system whose state a human edits. `0.16.2` died on a version prepared and never submitted;
`0.16.3` died on the check for whether that version was already in a submission. Both are fixed and
both are asserted, but *the assertions are about decisions, not about Apple* - the next release is
still the first real test of either.

## Reading live state out of a running WebView, over adb

`android:dev`'s own HMR occasionally stops picking up file changes (observed twice in one session,
no root cause chased down - a full CDP-forced reload worked around it every time, see below), and a
screenshot cannot tell you why a JS condition evaluated the way it did. Both are solved by talking to
the WebView's own debugger directly, which needs no more than `adb` and a Chrome DevTools Protocol
(CDP) client:

```bash
# 1. Find the debuggable WebView's abstract socket (present on any debug build; the app
#    does not need to be built with anything special beyond the default dev/debug profile).
adb shell cat /proc/net/unix | grep webview_devtools_remote

# 2. Forward it to a local TCP port.
adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>

# 3. List debuggable pages/targets - each has an "id" and a "webSocketDebuggerUrl".
curl -s http://127.0.0.1:9333/json
```

From there, any CDP client can drive the page. `wscat` cannot send-and-wait for a single response,
so a short Python script using the `websockets` package is the path of least resistance:

```python
import asyncio, websockets, json
async def main():
    async with websockets.connect("ws://127.0.0.1:9333/devtools/page/<id>", max_size=10_000_000) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
            "params": {"expression": "location.href", "returnByValue": True}}))
        print(json.loads(await ws.recv()))
asyncio.run(main())
```

`Runtime.evaluate` runs arbitrary JS in the page - read `getBoundingClientRect()` on any element,
dispatch synthetic `scroll`/`click` events, or read a component's exposed state. `Page.reload` with
`{"ignoreCache": true}` forces a full asset re-fetch when HMR has silently stopped applying edits
(costs a much larger download over the dev-server's LAN connection, so expect a genuinely stuck-
looking splash screen for several seconds - that is normal, not a second hang). This is what caught
the sub-pixel scroll-threshold bug in [durable-rules](../durable-rules.md) - a screenshot only ever
showed "not sticky," never why, and the actual gap (0.05px) was only visible by reading
`getBoundingClientRect()` live against the exact values the running code was comparing.

## CI/CD

| Workflow | Output |
|---|---|
| `release.yml` | the ONE entry point: five gates, then the version bump, then the three arms below as jobs of the same run |
| `ios.yml` | `.ipa` to App Store Connect (`altool`), then for a STABLE the App Store version created, the build attached and the whole thing submitted for review |
| `android.yml` | `.aab` to Google Play - `internal` track for a pre-release, `production` for a stable |

Both store arms also accept `workflow_dispatch` as a pure compile check: `publish` defaults to
false there, and it is the only way to compile Swift, ObjC or Kotlin off macOS.

See [`cicd.md`](../cicd.md) for the full pipeline.

## See also

- [`frontend/architecture.md`](../architecture.md) — SvelteKit architecture, stores, routing
- [`frontend/mls-wasm.md`](mls-wasm.md) — WASM MLS client (Web counterpart)
- [`frontend/modules/calls.md`](modules/calls.md) — CallKit and call signaling
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Push notification backend (FCM, APNs VoIP)
- [`cicd.md`](../cicd.md) — Mobile build workflows
