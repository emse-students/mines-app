# Device verification runbook

Everything native in Canari is verified by **compiling**, which proves nothing about running. A
manual `workflow_dispatch` of either release workflow is the only way to compile Swift/ObjC/Kotlin
from a Windows machine, so that is what the mobile work has been gated on - and it is why several
Work Packages sit open with correct-looking code that has never executed on hardware.

This file is the single ordered pass that closes them.

**Its sibling is [cross-client-testing](cross-client-testing.md).** This page asks "does this native
path work on hardware at all?" - one device, one check. That one asks "does the system stay correct
when several clients, several lifecycles and a damaged store meet?" - two browsers and a phone at
once. Checks H, K, L and M below are re-exercised there, in context, rather than in isolation.

**It is the only place they are tracked.** On 2026-08-04 every Work Package whose sole remaining
debt was "run this on a device" was deleted from `CLAUDE.md` and folded in here - a check owed is
not a work package, it is a line in this table. The WP ids are kept in the table because commits and
`CHANGELOG.md` name them. **A check that FAILS earns a new WP; a check that passes earns a PASS
here and nothing else.**

## Where the pass stands

**Android is done except H, K, L, M and R.** The full ladder was run on **v0.11.7** on 2026-07-31 (log
archived on the user's desktop) after partial runs on v0.11.5 and v0.11.6. Two defects came out of
it, both tracked as WP-NOTIF-1 and both re-checked by **check K**. **Check H was recorded PASS and
was not one**: the user reported on 2026-08-01 that a tapped notification still does not open the
conversation. That is the lesson this file exists for - a check whose verdict is "it looked right"
is not a check, so H now names the log lines that decide it.

**iOS WAS UNRUNNABLE UNTIL 2026-08-27** - there was no iPhone, and every iOS cell was BLOCKED rather
than pending (the user, 2026-08-18). An iPhone (iOS 18.7) has run against production since, so iOS
cells are now OWED and schedulable; check S is the only one that has actually run. **There is still
no iPad, and on 2026-08-30 that stopped being an academic gap**: App Review ran one, and the login
defect it found had been in every build the store ever had - check T, and the paragraph there saying
why an iPhone settles that particular check for both.

Two consequences to carry deliberately rather than rediscover:

- **The iOS half of the app ships on compilation alone**, and compilation proves nothing about
  running. Every iOS-specific claim in this wiki is a claim about source, not behaviour.
- **v0.14.0's App Store publication was never verified, and `minClientVersion` is 0.14.0** - so any
  iOS user the store has not reached is locked out, with nothing here able to detect it. The user
  decided on 2026-08-18 to leave it as is. It is recorded because the state is real, not because
  something is owed.

Before 2026-08-27 not one check had ever run on iOS hardware, and only check S has since. The iOS half of WP-SEC-1 and WP-IOS-1 has only ever been
compiled, and a green CI run is not
proof a given file compiled - the pbxproj is hand-maintained, so grep the log for
`SwiftCompile ...<file>.swift` / `CompileC ...<file>.o` before believing any of it. That caveat is
iOS-only: Tauri runs Gradle quietly, so there is no Kotlin task line to look for, and Gradle
compiles by source set, so no Kotlin file can be silently skipped.

**The build to test both platforms on** is the 2026-08-01 compile run of `2b5ba1b0` (v0.11.8), both
workflows green - iOS [`30704254549`](https://github.com/emse-students/canari/actions/runs/30704254549),
Android [`30704255667`](https://github.com/emse-students/canari/actions/runs/30704255667). A
`workflow_dispatch` publishes nothing (Release, TestFlight and Play upload are each gated on
`workflow_run`), so take the **artifact**: the Android APK carries WP-DEEPLINK-1, WP-NOTIF-1 and the
WP-XP-7 removal at once, which means H, I, K and the dev-panel check all ride a single install.

| Check | Closes | Android | iOS |
|---|---|---|---|
| B | WP-VERIF-0 (background decrypt), WP-VERIF-2 | PASS v0.11.7 | owed |
| D, E | WP-VERIF-0 (PIN change, fresh install) | PASS v0.11.7 | owed |
| F | WP-VERIF-1 | PASS v0.11.7 | owed |
| G | WP-VERIF-3 | PASS v0.11.6 | owed |
| H | WP-DEEPLINK-1 residual | **RE-OPENED** (the v0.11.7 pass missed the DM half) | owed |
| I | WP-UI-1 residual | PASS v0.11.7 | owed |
| J | WP-VERIF-4 | PASS v0.11.7 | owed |
| K | WP-NOTIF-1 | **steps 1-4 PASS on A1 0.14.12, 2026-08-30** (every line named below, observed end to end). Step 5 (self avatar) not observed; **K2 still owed** | owed |
| L | WP-DEV-PANEL-1 | owed | owed |
| M | WP-POST-DOC-2 | **PASS** on A1 0.13.0, 2026-08-06 (chat half) | `docs/wiki/cross-client-testing.md` |
| N | Offline unlock + promotion | owed | owed |
| O | WP-STORE-1 (install source + version gate) | owed | n/a |
| P | Cookie durability across a kill (the iOS half of WP-ANDROID-SESS-1) | n/a (fixed + verified) | owed |
| R | The shrunk release APK still having what it needs | owed | n/a |
| S | An iPhone obtaining a push token AT ALL (the P1 of 2026-08-27) | n/a (49 rows, healthy) | **RUN 2026-08-28 on 0.14.8: report PASSES, token FAILS.** Cause found and fixed the same day - **RE-RUN OWED on the build carrying it** |

For the iOS pass, install the `ios-release` artifact of the run above rather than waiting for
TestFlight: a dispatch does not upload there, so TestFlight is still on the previous build and check
K would be meaningless on it.

## Before you start

- **KNOW WHAT THE DEVICE IS RUNNING, before anything else.** Not `versionName` - that is a constant
  edited at release time and it read `0.13.1` for both a current build and a stale one on 2026-08-11.
  Two readings that cannot be faked:

  ```
  adb shell dumpsys package fr.emse.canari | grep -E "pkgFlags|signatures|lastUpdateTime"
  ```

  `pkgFlags=[ DEBUGGABLE ]` means a debug APK, which is **~10x slower than release on the same
  fixture** (WP-ANR-1's own measurement) - every behavioural check still holds, every timing verdict
  is void. And a debug-keystore install cannot be replaced by a release-signed APK
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): crossing that line needs an **uninstall, which wipes
  `mls.bin`** and re-enrols the device, so it is a decision to take before the setup, never at the
  install step. Then date the CODE from a string the running app logs - `git log -S "<that line>"` -
  because a log string is version-stamped evidence the process hands you for free. See rule 17 in
  [testing-methodology](testing-methodology.md).
- **A second account.** Every push check needs a peer to send from. A second phone, or the web app
  in another browser profile, both work.
- **A log capture.** iOS: Console.app or the Xcode device console, filtered on the app and on
  `fr.emse.canari.push` for the notification extension. Android (check K only):
  **[`tools/android/verify-on-device.py`](../../tools/android/verify-on-device.py)** - a tkinter GUI
  that builds, installs, and tails per-device logcat with this runbook's tags already whitelisted.
- **Screen genuinely locked, app genuinely killed** for B. A backgrounded app is a different code
  path and passing it proves nothing about the one under test.

---

## B. Decrypted push, app killed, screen locked

**Proves** the whole background chain: FCM wakes the extension, the keychain hands back the device
key, the MLS state loads read-only, and the ciphertext decrypts. On iOS this is the first ever
proof that background decrypt works at all.

1. Kill the app. Lock the screen.
2. From the peer account, send a DM with recognisable text.
3. Read the notification on the lock screen **without unlocking**.

**Pass** = the notification shows the actual message text. A generic "Nouveau message" is a FAIL -
it is the fallback for a decrypt that did not happen.

**Where to look:** Console.app, filtered on the `fr.emse.canari.push` extension process. The Rust
`[MLS]` lines are the same code as Android's, so `[MLS] Keystore key failed to decrypt blob - key
deleted.` means the same thing here. iOS keychain service is `fr.emse.canari`, accounts
`mls_key_<alias>` and `mls_bg_key_<alias>`. The Android equivalents, for comparison, are tags
`CanariFCM` and `MlsDeviceKeyStore`, ending in `decryptProto: success type=... -> "..."`.

**Known limit, not a bug:** background decrypt is read-only and applies no commits, so a message
sent in a *newer epoch* than the persisted state cannot be decrypted and correctly falls back to
the generic text. `decryptProtoWithCommits: success after catch-up` is the in-memory catch-up path
succeeding. If a check fails, confirm which of the two you are looking at before filing anything.

## D. PIN change, then repeat B

**Proves** that rewriting the device key under the same alias leaves the background reader working -
this is where a writer/reader format mismatch shows up.

1. Change the PIN in the app.
2. Repeat B.

**Verdict:** `[MLS][Tauri] Device key changed - state re-encrypted and persisted.` in the app log,
then a full pass of B. A pass on B *before* the change and a fail after is the signature of the
alias being written in a format its reader does not accept.

## E. Fresh install + login, then repeat B

**Proves** the same chain on a device with no migration history - the path every new user takes,
and the only install path still tested (the upgrade path was retired on 2026-07-31: staging it now
means deliberately downgrading to a pre-WP-SEC-1 build, and every install worth testing has long
since migrated).

1. Uninstall completely. Install from TestFlight. Log in.
2. Repeat B.

## F. Login end to end: init, save, KeyPackage

**Proves** WP-VERIF-1. On the login of check E, confirm in the app log:

- `[DB] Using SQLite storage (Tauri)` - and **never** the IndexedDB fallback. That fallback is a last
  resort, not a mode; seeing it means `SqliteStorage.init()` threw.
- `KeyPackage published.` - without this, no peer can invite this device.
- A relaunch restores the conversation list, which is the only proof the state was actually saved.

## G. Biometrics: enable, relaunch, disable, and the PIN modal

**Proves** WP-VERIF-3.

1. **Enable** biometric unlock from the profile screen. The prompt must show **two** app-supplied
   lines on iOS, not four: a title naming the action and a generic confirmation line. (Android
   stacks title+subtitle+description and adds its own hint - four fields, four lines. Same strings,
   different shape.) No string anywhere may name a sensor - there is no Face ID on Android and no
   fingerprint on a Face-ID-only iPhone.
2. **Relaunch** and unlock with the face/finger. The login must complete, *not* fall back to the PIN
   modal after a successful biometric.
   - `[BIOMETRIC] Biometric login attempt`
   - `[BIOMETRIC] Authenticating for userId=... via device keystore...`
   - `[BIOMETRIC] Skipping PIN verification - using device keystore...` &larr; the decisive one. Its
     absence with the two lines above present is exactly the v0.11.4 failure.
3. **No swallowed first tap.** `[LOGIN] Call ignored, a login already owns the flow` must appear
   **nowhere**: `isLoginInProgress` is one flag with two owners, and an entry point that does not
   release it before `loginImpl` makes every cold launch refuse its own automatic attempt -
   deterministic, not a race.
4. **The biometric session must persist its messages.** A biometric session used to run with an
   empty device key in the WebView, so nothing it received was written to SQLite and nothing already
   stored could be read. Expect zero `Failed to decrypt SQLite row`, one biometric prompt per login,
   and `MLS state loaded from mls.bin (native).` naming the right backend. The decisive line is
   `[HISTORY_BUNDLE] Full history sent: N message(s)` where N has **grown** by the messages received
   under biometrics: the bundle is built by reading the local store back with the device key, so a
   grown N proves the session both wrote and read. `[FCM_CACHE] Injection done: 1/1` confirms the
   same for the push cache.
5. **The PIN modal keeps its "use biometrics" button** when biometrics are enrolled. It derives that
   button from the same flag as the sheet, so if the sheet stops opening the button vanishes too.
6. **Disable** biometric unlock, relaunch, confirm the PIN is required and the keychain entry is
   really gone (the biometric sheet must not appear at all).

## H. Deep link from an OS notification tap - RE-OPENED on Android

**Proves** the WP-DEEPLINK-1 residual. The fix is verified on the web for the two link paths; the
notification tap could not be driven from a headless browser. It publishes to `notifNav` exactly like
the two verified paths.

**RUN IT TWICE - backgrounded, then from a KILLED app.** They are not the same code path and they
have never both worked: a running app receives the URL over the `onOpenUrl` *event*, a cold start has
to *ask* for it with `getCurrent()`, and only the second is gated by the Tauri capability file. The
grant was missing outright, so the cold start failed on every launch while the backgrounded case was
perfect — see
[`mobile.md`](frontend/mobile.md#how-a-deep-link-actually-reaches-the-app--two-paths-only-one-of-them-gated).
This is what the user reported on 2026-08-01 and what NOTIF-7 finally measured on 2026-08-07;
fixed in `916ed696`. **A pass on the backgrounded case alone proves nothing about the one users hit**,
which is a tap on a notification that woke them up.

1. Kill the app. Have the peer send a DM, then a channel message.
2. Tap each notification. Each must land in the right conversation, **not** merely the right tab.
3. Repeat with the app merely backgrounded (HOME, not killed).

**Read the log, not just the screen.** This check was recorded PASS on v0.11.7 and the DM half was
broken the whole time: the tap does reach the right tab, and "right tab" is what a pass looks like
from across the room. Three lines, in order, and each one names the hop that failed if it is the
last one you see:

- `[notifNav] deep link received: fr.emse.canari://chat/<id> -> target <id>` - everything native
  worked (PendingIntent, `onNewIntent`, the deep-link plugin, `hooks.client.ts`). Absent: the
  failure is upstream of the product code, and none of the JS below ever ran. Split it further with
  `[hooks] Deep-link listener registered` (the WebView booted) and
  `[hooks] deep-link getCurrent() failed` (the cold-start path was refused - a capability gap, not a
  native one).
- `[notifNav] routing to /chat|/communities for pending conversation <id>` - only printed when a
  route change was actually needed.
- The thread on screen, with its history. A DM that lands and then empties is the landing being
  ended by its own selection - the group-id-vs-map-key bug fixed on 2026-08-01.

Remember `/c/<groupId>` and `/chat/<groupId>` are not routes: a conversation opens by publishing to
`notifNav`, and a channel target can only be opened on `/communities`.

## I. The enrolment sheet under a light theme

**Proves** the WP-UI-1 residual. The enrolment sheet reported DARK under a LIGHT theme. The `dark:`
variant is correct on web (verified by computed style in both themes), so the suspect is the native
runtime.

Set the phone to light mode, open the biometric enrolment sheet, and see whether it renders light.

## J. Outbox retry worker (short version)

**Proves** WP-VERIF-4 partially: that the worker wakes and drains. The three-failure branch (a
persistent flag plus a nudge notification) is deliberately **not** covered here - it needs the network
down long enough to exhaust the backoff.

1. Airplane mode on. Send a message. Close the app.
2. Airplane mode off. Wait ~1 minute.
3. The message must arrive without reopening the app.

**Verdict:** iOS schedules the work as `fr.emse.canari.outboxRetry` via `BGTaskScheduler`, which the
OS runs on its own schedule - so an **iOS failure here is inconclusive rather than a defect**. The
Android equivalent (tag `CanariOutboxRetry`) already passed and is not owed.

## K. The notification quick reply - owed on BOTH platforms

**Proves** WP-NOTIF-1 (a) and (b); K2 below proves (c). The reply always did send; what it left behind was nothing. It is
built natively and never becomes an outbox entry, and `reconcileOutboxSent` only ever DELETES, so
the sender's own conversation showed the reply nowhere. Both platforms now write the delivered reply
into `fcm_message_cache.ndjson` under OUR user id.

1. Kill the app. Have the peer send a DM.
2. Answer from the notification itself, **without opening the app**.
3. Confirm the peer receives it (`sendQueuedMessagePush: HTTP 201`, `1 sent, 0 remaining`).
4. **Reopen the app.** The reply must be in your own conversation - that is the half that was
   missing.
5. **Android only:** in the notification thread, your own avatar must be drawn, not a blank
   placeholder. (iOS has no self `Person`, so this half does not apply.)

**K2 - the UNDELIVERED reply, WP-NOTIF-1 (c).** This used to be listed here as out of scope; it is
fixed now, and it is the half most likely to still be wrong, because unlike (a) and (b) it has no
compile check worth the name - it is pure TS + Rust, so it built the moment it was written.

An undelivered reply lives only in `outbox_pending.ndjson`, and `store_outbox_mirror` rewrites that
file wholesale from the TS queue, which has never heard of it. `adoptOrphanedMirrorEntries` now runs
at login, before conversations load, and turns every unknown mirror line back into a real outbox
entry plus its local message.

1. Put the device in airplane mode, then have the peer send a DM (send it *before* going offline, or
   there is no notification to answer).
2. Answer from the notification. The drain must FAIL - the point is a reply that never left.
3. Reopen the app, still offline. The reply must be in your conversation, marked pending.
4. Restore the network. It must send on its own, without retyping it.

**Verdict lines:** `[OUTBOX_MIRROR]` adoption at login, then the ordinary `[OUTBOX]` flush. A silent
proto stays `control` and is sent verbatim with no push - that is intended, not a miss.

### Steps 1-4 MEASURED on A1 0.14.12, 2026-08-30 - the reported defect does NOT reproduce

**The report that the quick reply "does not work" is not true of this build.** The whole chain was
observed, and each of the three causes the [backlog](backlog.md) entry left open is eliminated by a
line rather than by an argument:

```
07:20:17  Start proc 17650:fr.emse.canari for broadcast {FirebaseInstanceIdReceiver}
07:25:46  CanariNotifAction: handleReply: queued id=45ae4d3c group=642f389a
07:25:46  CanariFCM: drainOutboxBackground: 1 message(s) queued, taking 1
07:25:50  CanariFCM: sendQueuedMessagePush: HTTP 201 group=642f389a msg=45ae4d3c
07:25:50  CanariFCM: drainOutboxBackground: 1 sent, 0 remaining
07:27:22  [OUTBOX_MIRROR] 1 entry/entries written
07:27:24  [OUTBOX_MIRROR] 1 background send(s) to reconcile
```

- **The app really was down.** The kill was `phone.killAndProveDead` (`deadInMs: 82`), and the only
  thing that restarted the process was the FCM broadcast itself - no `MainActivity`, no WebView, no
  WebSocket. That last part is what makes the rest mean anything.
- **The push decrypted in the background**: the shade carried the peer's display name and the
  message text, not one of `GENERIC_BODIES`, and `fcm_message_cache.ndjson` held the plaintext.
- **Step 4, the half that was missing, HOLDS.** Read on all three clients at once and without
  navigating any of them: the peer has the reply, and so does the phone's own conversation.
- **The native residue is clean afterwards**: `fcm_message_cache.ndjson` empty and no
  `outbox_pending.ndjson` at all, so the entry was adopted rather than stranded.

**PROVENANCE, BECAUSE IT DECIDES WHAT THIS IS WORTH.** The reply at 07:25:46 was typed by a PERSON on
the device, not by the harness - which is what this file's checks ask for, and why the row can be
taken at all. But it also means the run had no gate, no dirt classifier and no recorded ledger row:
**it is a MEASUREMENT, not a campaign verdict**, and NOTIF-6 on the board is not answered by it. Step
5 (the self avatar in the thread) was never looked at, and **K2 - the airplane-mode reply that must
NOT be delivered - is untouched and is still the half most likely to be wrong.**

### The BACKGROUNDED run that failed, and the defect it found

**A KILLED RUN IS THE BRANCH THAT HEALS THIS DEFECT, SO THE PASS ABOVE PROVED LESS THAN IT LOOKED.**
Re-run on 2026-08-30 with the app merely backgrounded - `am kill` never issued, process alive at
`proc=LAST`, `foregroundedAtSend: false` - the same reply on the same build, device and conversation
was refused:

```
07:55:57  CanariFCM: sendQueuedMessagePush: HTTP 201   <- app KILLED, fresh process
07:57     MainActivity resumed and unlocked -> /register mints a NEW secret,
          pending_push_secret.txt written (32 bytes, mtime 07:57)
07:59:30  CanariFCM: sendQueuedMessagePush: HTTP 403   <- app BACKGROUNDED, same process
```

The file was still sitting there unconsumed at 08:06, which per the code can only happen when the
Keystore answered first - with the previous process's secret, which `/register` had already
invalidated. Cause, fix and rules: [backlog](backlog.md), `CHANGELOG.md`,
[mobile](frontend/mobile.md), [durable-rules](durable-rules.md). Two further defects fell out of the
same branch: the `RemoteInput` spinner never ended (screenshot evidence: the action row was gone and
the reply text sat under a spinner eight minutes on), and no retry was ever scheduled.

**THE RE-MEASUREMENT IS OWED AND IS THE ONLY THING LEFT.** The fix is written, `assembleUniversalDebug`
is green and the APK is installed on A1 (`install -r`, data kept, 2026-08-30 08:16). It has never
been run. To re-arm the precondition - it is NOT ambient, and a run made without it proves nothing:

1. `adb shell input keyevent KEYCODE_HOME`, then `am kill fr.emse.canari`, and assert `pidof` is
   empty. **Never `force-stop`**, which puts the app in the STOPPED state and cancels every FCM
   broadcast.
2. `bun run.mjs --preflight A1` - it foregrounds, sends the app to `/chat` and unlocks the PIN.
   That unlock is what calls `/register` and writes the file.
3. **Assert the precondition is armed**: `run-as fr.emse.canari ls -l /data/data/fr.emse.canari/pending_push_secret.txt`
   must show 32 bytes. If the file is ABSENT the window is closed (a resume already migrated it) and
   the run measures nothing - go back to step 1. Use the PowerShell tool for this, never Bash, which
   rewrites the absolute device path.
4. `bun tools/cross-client-harness/archive/k.mjs`, then answer from the shade when it says to.
   **It is an atom now** - the `scratch/k-run.mjs` this line used to name never existed in the tree,
   which is the whole reason this re-measurement sat unmade for a week. It performs steps 1-3 itself
   and asserts each, so the only human part is the reply.

   **AND THE BACKGROUNDED CASE CANNOT BE ANSWERED YET, for a reason found on 2026-09-06**: the JS
   layer posts the notification when the app is alive, and it attaches NO quick actions - only
   `CanariFirebaseMessagingService` does, and that runs when the app is dead. So the shade offers no
   `Repondre` in the state this check is about. Filed as a P2 in [backlog](backlog.md); `k.mjs`
   records `SKIPPED` rather than `FAIL` when no reply is made, so a run cannot be mistaken for a
   product verdict.
5. **Verdict lines:** `retrievePushSecret: newer secret adopted from pending_push_secret.txt -> Keystore`,
   then `sendQueuedMessagePush: HTTP 201`, then `1 sent, 0 remaining`. A `403` means the fix is
   wrong, not that the rig is.

One rig note, met twice: the adb daemon died mid-session and the preflight reported the PHONE
unreachable. `adb kill-server && adb start-server` fixes it, and it kills any background `logcat`
capture with it.

## L. A revoked device coming back - the dev panel

**Proves** WP-DEV-PANEL-1. The cause is known and fixed; only the recovery has never been seen run.
`registerDevice` never consulted the denylist, and `resolveDeviceId` restores the same id across
reinstalls on purpose - so a device deleted from the panel came back under its old id, got a 200,
and was then filtered out of `getUserDevices` and resolved to a null KeyPackage: enrolled, invisible,
never invitable, silent, forever. Registration now answers `403 DEVICE_REVOKED` and the client
re-enrols under a fresh identity.

1. On a second device, delete this device from the dev panel (or use one whose id was deleted
   earlier).
2. Relaunch the app on the deleted device and log in.

**Verdict:** `[MLS] Device <old> was revoked - re-enrolled as <new>`, then the panel lists the new
id and the device receives again. **It costs that device's local history, by design** - a new id IS
a new device, so do not run this on a device whose messages you want.

## M. A PDF preview, on Android

**Proves** WP-POST-DOC-2. Android is the platform that decides it: its WebView has no PDF engine,
which is the whole reason pdf.js was chosen over an `<iframe>`, and nothing in the compile or the
tests can tell you the canvas path works there.

The prod half of this is already fixed and **verified live on 2026-08-04**: nginx has no `.mjs` type,
so the worker was served as `application/octet-stream` and the module loader refused it. A `HEAD` on
`/_app/immutable/assets/pdf.worker.min.*.mjs` now answers `application/javascript`.

1. Open a post carrying a PDF: the first page must render full-width under the file row.
2. Open a chat message carrying a PDF: the same page must render in the 44 px icon square.

`ConversationMediaPanel` and `AssociationDocumentManager` show no preview on purpose - they list
files without fetching them - and a password-protected vault document cannot be decrypted without
its password at all. Neither is a failure.

**Step 2 PASSED on A1 0.13.0, 2026-08-06** (prod, PDF sent from W1). The rendered first page is an
`<img alt="Aperçu de la première page du document">` fed from a `blob:`, `naturalWidth` 116x116 in
a 44 px box - two of them, one per PDF sent. Logcat clean over the whole run.

Two traps this cost, both about ASSERTING the right thing rather than about the app. The preview is
an `<img>`, **not** a `<canvas>`: a check looking for a canvas reports FAIL on a surface that plainly
works, which only a screenshot caught. And a mounted `<img>` proves nothing on its own - a broken
picture keeps its `src` - so the assertion has to be `naturalWidth > 0`. Step 1 (a PDF in a POST) is
still owed.

---

## N. Offline unlock and the promotion back - owed on BOTH platforms

**Proves** the offline-unlock work. Nothing in a compile or a unit test can answer it: the whole
feature is about what a real cold start does when `POST /api/auth/refresh` cannot leave the device,
and both the keystore read and the SQLite store behave differently on hardware than under jsdom.

Requires biometrics enrolled, or "rester connecté" on. **A PIN-only account is expected to FAIL to
unlock offline** - that is the designed behaviour, not a defect.

1. Sign in normally, exchange a few messages, then force-quit the app.
2. Enable flight mode. Launch the app.
3. The biometric prompt appears and the conversation list opens on the local history. Verdict line:
   `[LOGIN] Offline unlock (no token) - local session, will promote on reconnect.`
   The offline banner is visible. It must appear **fast** - the version gate is short-circuited
   offline, so if the launch hangs ~26 s before the prompt, that short-circuit is not working.
4. Send a message. It stays `pending`, and the log must NOT show flush attempts:
   `[OUTBOX] Flush skipped - offline; the queue is kept intact for the next reconnect.`
   Repeated `transient failure (attempt N)` lines here are a failure - the queue is burning its
   backoff against an absent network.
5. Disable flight mode. Expect, in order:
   `[PROMOTE] Access token acquired`, `[WS] Connected to Chat Gateway`, then the outbox draining.
   The message turns `sent`, the banner clears, and anything the peer sent meanwhile arrives.
6. **The session-death half**, which is the one worth being careful about: unlock offline as above,
   revoke that session from Réglages > Connexions actives on another device, then restore the
   network. Expect `[PROMOTE] Session expired while offline - signing out.` and a redirect to
   `/login` - then sign back in and confirm **the full local history is still there**. Losing it
   would mean the logout wiped the encrypted store, which it must not.

## O. The update target, and the blocking version gate - owed on Android

**Proves** WP-STORE-1. The optional nag modal is gone (the version now sits passively in
`/settings` > A propos), so `minClientVersion` is the only thing that can interrupt a user, and the
destination it offers is resolved at **run time** from `installer_package.txt` - a Kotlin writer,
then `get_installer_package`, then `appVersion.ts`. `buildUpdateTarget` and the cross-process
contract are unit-tested; three things are not, and cannot be.

1. **The Kotlin actually compiles.** A `workflow_dispatch` run of `android.yml` is the only
   real compile of `recordInstallerPackage`. Nothing local exercises it.
2. **The target follows the install source.** On a **Play-installed** build the blocking gate must
   offer the Play Store; on a **sideloaded CI APK** it must offer the APK. Capture the verdict line
   with `tools/android/verify-on-device.py`:
   `[appVersion] install source: ...`
   Both sides have to be seen - the two paths differ only in that one string.
3. **The gate itself.** In `/admin/platform`, raise `minClientVersion` above the running version,
   confirm the app blocks with a button leading to the right destination, and **reset it
   afterwards**.

**Do not raise `minClientVersion` on prod until a build is actually live on Play.** Raising it
before the rollout has reached devices locks everyone out behind a button that leads to the version
they already have.

## P. The refresh cookie surviving a kill - owed on iOS

**Proves** that the iOS half of WP-ANDROID-SESS-1 does not exist. On Android the WebView cookie jar
is written lazily, so a kill with no lifecycle callback restored a refresh token one rotation behind
the one already spent; presenting it is a replay, and the server correctly revoked the session. The
fix forces `CookieManager.flush()` at the moment of rotation.

**iOS has no equivalent, and that is not the same as not needing one.** `WKHTTPCookieStore` exposes
no flush API at all, so `flush_webview_cookies` is a no-op there — a fact about the API, not
evidence about the behaviour. A suspended app swiped out of the switcher is terminated without
`applicationWillTerminate`, which is precisely the shape that broke Android.

1. Sign in. Use the app long enough for at least one refresh (5 min at the current cadence), so the
   stored cookie is *not* the one issued at login.
2. Send the app to the background, wait for it to be suspended, then swipe it out of the switcher.
3. Relaunch. It must come back **signed in**, first try.
4. Repeat immediately: a session revoked by a replay looks fine for exactly one launch.

A failure here looks like the login screen, or the app appearing signed in with nothing in it — and
it is confirmed server-side by a `revokedReason` of replay on the session row. If it fails, the
remedy is not a flush call (there is none): it is to stop depending on the jar's durability, e.g.
mirroring the rotation into the keychain the way the device key already is.

## Q. The conversation list scrolls clear of the bottom nav - CLEARED 2026-08-26 (Pixel 6a)

Ran on a freshly built and installed universal debug APK (bundle `2a4297cb`, built 15:04:49Z), which
matters because a CSS reservation is exactly the kind of change a stale bundle hides. Kept because
**two of its four criteria did not follow from the mechanism and one of the four turned out to be a
dead instrument** - all three discovered by running it, and each would have returned a false verdict.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | `scrollHeight > clientHeight` on the list | **796 > 744**, where it read `744 === 744` before |
| 2 | `paddingBottom` carries `4rem` + safe-area | **88px** = 64 + 24, so the reservation reached the bundle |
| 3 | Scrolled to the end, the last tile clears the nav | bottom **878 -> 826**, exactly the nav top; `elementFromPoint` returns the TILE |
| 4 | A real swipe moves the accessibility tree | **VOID - see below** |

Geometry checks out to the pixel: 698 px of tiles + 10 px top padding + 88 px reservation = 796.
`clientHeight` stayed 744, and the nav still sits topmost at the list's bottom edge - both as
predicted once the box model is read correctly, and both the reason the original criteria 1 and 3
were wrong (they asked for a shorter box and for the nav to stop being hit there; neither can happen).

**Criterion 4 is void, and this is the important finding.** A `Swipe-Tool` gesture demonstrably drives
the scroll - CDP read `scrollTop` 0 -> 52 -> 0 across a swipe up and a swipe back, the full range -
and the user confirmed it by hand. The accessibility tree reported **identical tile coordinates before
and after**, to the pixel. So the tree does not reflect an inner scroll container's offset in this
WebView, and the criterion cannot distinguish a working scroll from a broken one: it has now been
observed identical in BOTH states. **This retroactively voids the 2026-08-26 baseline inference that
"a device swipe moved the accessibility tree by zero pixels, confirming the defect"** - that was an
insensitive instrument, not evidence. The defect's real evidence was the geometry
(`scrollHeight === clientHeight`), which was sound. The witness to use instead is CDP-read
`scrollTop` across a real `Swipe-Tool` gesture, in both directions.

**The spinner half is half-established.** With the list at the top, a full pull-down raised **no
indicator at all** (a `MutationObserver` armed before the gesture saw zero insertions, so this does
not rest on CDP round-trip timing), which is what a live socket should produce. What was NOT
independently confirmed is that the socket was in fact up at that moment: the preflight had reported
A1 `OFFLINE` ten minutes earlier, right after the fresh install, and the UI showed no offline banner
by the time of the gesture. **A declined gesture is correct while connected and a DEFECT while
offline, so "no spinner" only means what the socket state says it means.** The offline direction -
spinner present, and persisting for the reconnect rather than a fixed 600 ms - is unrun. Worth one
pass with `net.mjs` the next time the phone is on the bench; it is not what the P1 was about.

## R. The shrunk release APK actually runs - owed on Android

**Proves** that enabling `isShrinkResources` and excluding `com.google.android.material` did not
remove something the app needs at run time. **Every Android gate in this repository misses both.**
The debug build type sets `isMinifyEnabled = false`, so a debug APK never runs R8 or the resource
shrinker at all; a green `assembleUniversalRelease` proves the shrinker did not crash, never that
what survived is enough; and `androidPlayRecommendations.test.ts` reads the two settings as text and
can say nothing about either outcome. Reasoning and the evidence behind each change are on
[mobile](frontend/mobile.md#the-release-builds-shape-and-what-google-plays-analysis-asked-of-it).

Test the **release** artifact from `android.yml`, not a local build: a locally re-signed
release cannot be installed over the existing app without an uninstall, and an uninstall costs a
re-enrolment and SETUP-4's 2FA. **TWO signed artifacts now exist and the RELEASE one is the target:**
v0.14.5 of 2026-08-26 carries both Android fixes and went to Google Play production, so its attached
`app-universal-release.apk` (36 MB, beside the 15 MB `.aab`) is the build users actually got - test
THAT, and note a release asset does not expire. The `workflow_dispatch` of 2026-08-27 (run
`33024610295`, signal given, green in 12m37s) is a second, LATER build off `main` with the bun
backend migration in it, and it is kept ONLY as the run artifact `android-release` (29 MB),
**which expires 2026-11-24** - so it is not a thing to plan a device pass around.

That run also PROVED the gating rather than asserting it: `Upload to Release` and `Publish to Google
Play (production)` both **skipped**, because each is `if: github.event_name == 'workflow_run'`. A
dispatch therefore attaches nothing to any release, cannot overwrite v0.14.5's assets, and ships
nothing to users. Use one only to re-check a fix made after the release was cut.

1. **The app starts on its own background, not grey.** `windowBackground` is now
   `@color/app_background`, so the gap before SvelteKit hydrates is `#070B12` dark / `#F9FBFF` light
   - the colour the page settles on, where it used to be the parent theme's `colorBackground`.
2. **A notification with a face still shows the face.** This is the only path that decodes an image,
   so a stripped class or resource surfaces here as the initials disc. Require both: a face in the
   shade, and `decodeSampled: <W>x<H> -> inSampleSize=<n>, target=<t>` in logcat - the log line is
   what separates "the avatar arrived" from "the fallback looked fine".
3. **The notification channels are still named in French.** Strings are the resources most exposed
   to shrinking, and a stripped `values/strings.xml` entry is invisible until someone opens the
   app's notification settings.
4. **The two system bars still have their gap.** The theme parent changed, so re-read
   `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` through CDP and require non-zero,
   as measured on 2026-08-07.
5. **A file picker, a dialog, AND THE BIOMETRIC PROMPT still open.** The claim under test is that
   nothing referenced the excluded library. **This step said "the only native UI this app has" and
   named two of three** - and the one it left out is the one that broke: `app.tauri.biometric`'s
   `auth_activity.xml` inflates an `androidx.coordinatorlayout` root that only
   `com.google.android.material` was carrying, so every biometric call died in the inflater. An
   enumeration of native UI is a claim about the whole app and must be derived from the LAYOUTS the
   dependencies ship, never from the Kotlin this repo wrote - a layout is a reference no source grep
   sees. Google Play reported the same crash from the field on versionCode 14005 on 2026-08-27,
   which is what [the vitals watch](../../tools/play-vitals/README.md) now reads.
6. **The installed package refuses a device transfer.** `adb shell dumpsys package fr.emse.canari`
   must show `dataExtractionRules` resolved, not just `allowBackup=false` - the attribute that does
   NOT cover device-to-device transfer on Android 12+. Asserting the merged manifest is what the
   build already proves; this asserts the artifact Play will actually ship.

**A debug pass covers none of this**, which is why this check is separate from Q - cleared on a
debug APK on 2026-08-26, on a build that by definition never ran R8.

## S. An iPhone obtaining a push token at all - RUN 2026-08-28, split verdict

**Proves** that the ordering fix of 2026-08-28 works, and it is the only thing that can: the call it
replaced compiled perfectly and could never succeed, so a green iOS build says nothing here.
Measured 2026-08-27, `push_token` held 49 `android` rows and had **never** held one `ios` row - no
alert, no mention and no CallKit ring had ever reached an iPhone. Mechanism on
[mobile](frontend/mobile.md#the-fcm-token-an-iphone-could-never-obtain-and-the-silence-that-hid-it-for-the-platforms-life).

**Steps.** Install the TestFlight build of 0.14.8 or later on the iPhone, sign in, and put the app in
the foreground once - `didBecomeActive` is the trigger, so a launch is enough. Then, from this
machine:

```
ssh canari 'docker exec infrastructure-postgres-1 psql -U canari -d auth_db -c "SELECT platform, count(*) FROM push_token GROUP BY platform"'
ssh canari 'docker logs --since 30m infrastructure-chat-delivery-service-1 2>&1 | grep PUSH_UNAVAILABLE'
```

**PASS** = an `ios` row exists. Then send the iPhone a message from another device with the app
killed, and confirm the alert arrives: the row proves registration, not delivery.

**A `[PUSH_UNAVAILABLE] ... platform=ios reason=no-token` line is NOT a pass, but it is not a
regression either** - it is the first time the platform has reported anything, and it says the
ordering was not the only broken link. The candidates left, and the device log that separates them,
are in [backlog](backlog.md) under the P1; `[CanariPush] APNs token not here yet` versus
`[CanariPush] FCM token synchronise` names the branch, and reading it needs `idevicesyslog` or a Mac.

**Neither answer arriving means the build did not reach the phone.** Check the version the device
runs before reading anything into the silence - TestFlight is the beta channel and an ordinary
install is not automatic.

### The run of 2026-08-28, 01:23 Paris - what it settled and what it did not

**Conditions, which matter because the first attempt was worthless.** Arthur DORADOUX uninstalled and
reinstalled 0.14.8 from TestFlight (`REGISTER_DEVICE ... isNew=true` at 01:14:45, a device id never
seen before), in a window with no CD deploy running. An earlier attempt the same night was void:
five CD deploys landed between 00:40 and 00:52 and each restarts every container, so the logs that
would have carried a report were destroyed as they were written. **A hardware check and a push to
`main` are mutually exclusive, exactly as a campaign run is.**

**The half that PASSES.** At 01:23:39 the server printed, for the first time in the platform's life:

```
[PUSH_UNAVAILABLE] user=0acc3ab9... device=tauri-0acc3ab9...-mtc545la-ebnu platform=ios reason=no-token
```

The client classified its own failure, the server printed it unrewritten, and one `GROUP BY` now
answers a question that previously took a CORS incident to stumble into. The instrumentation is
verified on hardware, which is the only way it could be.

**The half that FAILS.** `reason=no-token` means `getFcmToken()` read nothing for four minutes:
the OS never handed this app an FCM token. **The ordering fix was necessary and is not sufficient** -
`push_token` still holds `android | 49` and no `ios` row.

**One inference made during the run and RETRACTED, recorded so it is not made again.** The device
reconnected its WebSocket 12 times in 15 minutes, each reconnection paired with a `REGISTER_DEVICE`,
and that was read as a full client re-initialisation which would reset the module-level
`pushAttempted` and prevent the four-minute ladder from ever completing. **It did complete**: the
ladder that reported started around 01:19:39 and ran straight through the events at 01:20:10,
01:21:36 and 01:22:36. So those events are socket and device-registration churn, not a teardown of
the JS context, and the module state survives them. Android shows the same churn (7 in 10 minutes).
Whether the churn itself is a defect is a separate question and is not evidence about push.

**What the next run must separate, and why it needed a build.** `reason=no-token` cannot say
WHETHER AN APNs TOKEN EVER ARRIVED, which is the fork the two candidates hung on. That fact is known
on the device and was written only to a console this machine cannot open.

#### The cause was then found without another run, and the re-run is what closes this

**Read the order, 2026-08-28.** `FIRMessaging.APNSToken` is set only by
`application:didRegisterForRemoteNotificationsWithDeviceToken:`, this app does not own its
`UIApplicationDelegate` (wry installs one inside `ffi::start_app()`), and Firebase's App Delegate
Proxy - the declared bridge - samples `sharedApplication.delegate` exactly once, at
`[FIRApp configure]`, which runs from `main()` before the application exists. It found nil and never
retried, so the APNs token had nowhere to land on every launch the platform has ever had. Full
account on
[mobile](frontend/mobile.md#the-apns-token-had-nowhere-to-land-because-the-proxy-meant-to-catch-it-installed-nothing).

**The re-run is therefore the proof, and it is worth stating what each outcome means** - everything
native here is verified by compiling, which proves nothing about running.

- An `ios` row in `push_token` closes the P1 outright.
- Another `[PUSH_UNAVAILABLE]` is no longer ambiguous: the reason now names which branch failed -
  `no-apns-token` (APNs still never answered, so look at entitlements, provisioning and the
  notification permission), `fcm-token-fetch-failed` (APNs answered and FCM refused),
  `apns-registration-refused` (the OS refused registration, a branch that previously had no observer
  at all) or `app-delegate-absent`. **None of the four is the cause just fixed**, so a repeat of
  `no-token` itself would mean the hook did not install and the log line
  `[CanariPush] APNs token hook installed on ...` is the thing to ask for.
- Run it in a QUIET WINDOW. The first attempt of 2026-08-28 was voided by five CD deploys in twelve
  minutes: a push to `main` restarts every container and destroys its logs, so a hardware check and a
  push are mutually exclusive, exactly as a campaign run is.

## T. The redirect URI an iOS build asks Authentik for - owed on iOS

**Proves** the fix for App Review's rejection of 2026-08-30 under guideline 2.1(a). **Precondition:**
a build carrying `tauri-plugin-os`; on anything older the check measures the defect, not the fix.

1. Fresh launch, then tap **Sign in**.
2. **The verdict is one log line**: `login returnTo=/chat uri=fr.emse.canari://callback`. Any `uri=`
   containing `tauri://localhost` is a FAIL and is exactly what App Review saw.
3. The login page must arrive in an `ASWebAuthenticationSession` sheet - it carries a Done button and
   names the `auth.canari-emse.fr` host above the page. The app's own view navigating to Authentik is
   the same FAIL wearing different clothes: it is the other half of the branch step 2 measures.
4. Finish the login. `/auth/callback` runs and the conversation list appears.

**Server-side, for a verdict that does not depend on reading the client's log:**
`ssh miconnect 'docker logs miconnect-server-1 --since 10m 2>&1 | grep -a authorize | tail -3'`
prints the request Authentik actually received - its `redirect_uri`, its `status` and the client's
`user_agent`.

**An iPhone settles this check for the iPad**, which is the one place in this file where hardware we
do not own is not owed a run of its own: `platform()` is a constant compiled into the iOS target, and
the iPad's only difference - its user agent - is no longer read by anything
([mobile](frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)).
It settles NOTHING about iPad layout, which nothing here has ever measured.

## Traps that outlived the work that found them

Kept because each one costs a full device pass to rediscover.

- **Adding `.setKeySize(256)` to `generateBiometricProtectedKeyForAlias` only affects NEW aliases.**
  It therefore splits behaviour between fresh and upgraded installs. It was held back while the
  upgrade path was still unvalidated; now that that check is retired, do it once B-E pass.
- **An empty `deviceKeyB64` is not "no context".** Both platforms separate the two; a check that
  conflates them reads a missing key as a missing login.
- **The key sits in the keystore as RAW 32 bytes and crosses the FFI as base64.** Writers decode
  before storing, readers encode after loading, on both platforms and in both migrations. Treating
  the stored bytes as text yields no key, silently.
- **An app extension has its OWN data container.** `app_data_dir` inside the NSE is not the app's,
  so a path that is right in the app process is silently wrong in the extension. The App Group is
  the only shared storage. And the NSE runs on a locked device: write with
  `...UntilFirstUserAuthentication` or not at all.
- **Android's `MlsDeviceKeyStore` uses two Base64 flavours on purpose:** `DEFAULT` for the IV/CT
  (KeystorePlugin's at-rest format) and `NO_WRAP` for the key it RETURNS, because `DEFAULT` appends
  a newline and the Rust `decode_base64_to_32_bytes` does not trim. Do not "unify" them.

## Recording the results

Record them **here**, in the table and next to the check: what passed, on which build, and **the log
lines you actually saw**. Only a FAILURE goes to `CLAUDE.md`, as a new Work Package carrying its
captured log - a failure with no log is worth almost nothing, which is exactly why WP-FWD-1 is still
open with nothing to act on.

## The revocation wipe, read off both devices by hand

Moved off [the board](cross-client-testing.md) on 2026-08-28. Four defects, none of which any row on that board asks about, plus the reading that answers the user's question. The product stories are in `CHANGELOG.md`; what is here is the MEASUREMENT.

**AND HEAL-REVOKE NOW READS THE DISK, NOT THE LOG, 2026-08-28.** The rows asserted
`[RESET] done` and `no step failed`, which is a claim about the steps that RAN. Measured on prod the
same morning, the two disagreed: a revoked device printed `nothing of this device remains` and kept
ten `mls_not_ready_since` keys, its per-user MLS database and 8.2 MB, because the SYNC_WATCHDOG - a
5 s interval the revocation path never stopped - rebuilt them 1.25 s later. **Twenty HEAL rows
asserted the log line and not one asked the disk**, so the wipe was believed for exactly as long as
it was broken. `healrevoke.mjs` now samples `localStorage.length`, the count of `CanariDB*` databases
and `navigator.storage.estimate()` seconds after the wipe, and `theWipeLeftNoDatabase` is a FAIL
condition. The localStorage count is deliberately not asserted at zero - the page writes
`PARAGLIDE_LOCALE` back as soon as it renders - while a database is, because nothing re-creates one
without an MLS client. The product defect itself is fixed and shipped in `v0.14.10`; story in
`CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it). **The four
HEAL-REVOKE rows must run on a build carrying that fix - which for A1 means a new APK, since the
Tauri app embeds the frontend and a CD deploy never reaches it.**

**AND ASKING THE PHONE THE SAME QUESTION FOUND A SECOND DEFECT BEFORE ANY ROW RAN, 2026-08-28.**
`bun footprint.mjs --device A1` answered `canariDatabases: 1`, `bytesInUse: 5939115` on a device
whose message store is SQLite - so the WebView held 5.9 MB that nothing on that platform writes and,
until that morning, nothing on that platform deleted: `wipeDeviceToFactory` had the native stores and
the WebView's as the two ARMS of one branch. The database existed because the posts mini panel named
its backend by hand instead of asking `getStorage`. Both are fixed, with a guard test on the cause;
story in `CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

**RUNNING THAT MEASUREMENT BY HAND, ON A BUILD CARRYING THE FIX, FOUND A THIRD DEFECT - AND NO ROW ON
THIS BOARD ASKS THE QUESTION IT ANSWERED, 2026-08-28 14:12.** A1 on a local debug `0.14.11` was
revoked from W1's own panel and STILL kept `canariDatabases: 1` / 5 939 015 bytes, while its native
half fell 42 216 492 -> 29 249 922. **The wipe crashed the app 55 ms in**: `[RESET] wiping...` at
14:12:22.218, the biometric plugin's activity at .223, `FATAL EXCEPTION: main /
ClassNotFoundException: androidx.coordinatorlayout.widget.CoordinatorLayout` at .273, `SIG: 9`. Every
step after the biometric one never ran. Fixed with five tests; story in `CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

**AND THE THIRD READING OF THE SAME DEVICE FOUND A FOURTH DEFECT, ON THE HALF NO ROW HAS EVER
LOOKED AT, 2026-08-28.** With the crash fixed, A1 was revoked again and its WebView came back
genuinely empty - `canariDatabases: 0`, 261 localStorage keys down to 0, which is the previous fix
working. Reading the native side with `adb` instead of the log found **twenty-eight paths of account
state still on disk**: `mls.bin`, `canari_<userId>.db` and its WAL, `graine_seeds.json` and
`channel_keys.json` (the material the background push service decrypts notifications with),
`push_context.json`, `pending_push_secret.txt`, `fcm_token.txt`, `session-meta.json`, the
`keystore_aliases` index, five `canari_*.xml` preference files and **six cached avatars of real
people**. `clear_app_data` deleted an entry only when its extension was exactly `db`, and every file
in that list was added after that filter was written. Fixed with four Rust tests; story in
`CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it), two rules in
[durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).

**AND THE MEASUREMENT ANSWERS YES, ON BOTH HALVES AND ON BOTH DEVICES, 2026-08-28 16:08.** Taken by
hand on a debug **0.14.12** carrying every fix, A1 in the FOREGROUND, both devices deleted from W1's
own panel by allowlist (`deleted 2/2`, `deletableAfter 0`).

| | A1 BEFORE | A1 AFTER |
| --- | --- | --- |
| native `residue` | **28 paths** | **0** |
| native `rewritten` | `logs/Canari.log` | none |
| `identityKeys` | 3 | 0 |
| localStorage / sessionStorage / caches | 36 / 4 / 2 | 0 / 0 / 0 |
| native bytes | 27 893 083 | 19 171 657 |
| verdict | `STATE PRESENT` | **`nothing of the account remains`** |

The logcat is the mechanism, end to end in **55 ms with no crash**: `[WS RCV] device_revoked` at
16:08:10.774, `[SECURITY] This device was revoked by its owner` at .158, `[RESET] wiping` at .604,
eight `[RESET] leaving <dir> to its owner` lines, **`[RESET] native wipe removed 26 entries, 0
failed`** at .628, `[Flags] no native_flags.json - biometricConfigured is already absent` at .653 -
the flag fix declining to recreate what the sweep had deleted - and `[RESET] done` at .659.

**AND THE USER'S SECOND QUESTION IS ANSWERED BY W3, WHICH WAS OFFLINE WHEN IT WAS REVOKED.** It never
received the frame: it sat on `/chat` reading `Hors-ligne / Connexion en cours` with
`CanariDBMls_<userId>` and 8 343 362 bytes intact, which is exactly what the design says -
`isDeviceRevoked` answers `false` when it cannot reach the server, and a transport failure is not an
answer. **One reload with a network and the deferred wipe landed**: `/login`, `canariDatabases 1 -> 0`,
`identityKeys 0`, verdict `nothing of the account remains`. No run had ever shown this, and it cost
nothing to measure because a revocation had already put a device in that state.

**What this does NOT close: neither reading came from a RUNNER, so neither is in the ledger and
`rows.mjs` will not see them.** They are hand-taken, like the six SETUP rows. The HEAL-REVOKE cell is
still owed as a script, and its predicate is now written for it: `bun footprint.mjs --device <d>`
must read `residue: 0` on a phone and `identityKeys: 0` everywhere, with the offline variant driven by
a reload rather than a frame.
