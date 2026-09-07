/**
 * LIFE-1..8 - the phone in every state an OS can put it in, one check per run.
 *
 * The shape is always the same, and the two assertions are deliberately different in kind:
 *
 *   1. the NOTIFICATION carries the real text, which proves the background decrypt worked;
 *   2. after the app is restored the message is in the conversation EXACTLY ONCE, which proves the
 *      foreground path did not re-add what the notification path already stored.
 *
 * A check that only looked at the conversation would pass on a phone that notified nothing, and a
 * check that only looked at the shade would pass on a phone that then showed the message twice.
 *
 * Usage: bun life.mjs 1|2|3|4|5|6|7|8
 */
import { APP_TAB, awaitMessage, client, countMessage, ensureChat, openConversation, send } from '../chat.mjs';
import { logcatReport, logcatSince, watch } from '../watch.mjs';
import { finishObserved, mark } from '../results.mjs';
import * as phone from '../phone.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = String(process.argv[2] || '2');

/** Unlocks the PIN if the modal is up; returns what happened, never throws on "no modal". */
/** The PIN modal, if it is up - shared, see `phone.unlockPin`. */
const unlock = phone.unlockPin;

/** Brings the app back, re-points devtools at the new pid, unlocks, and opens the DM. */
async function restore() {
  phone.wake();
  phone.launch();
  await sleep(6_000);
  phone.forwardDevtools(PORTS.A1);
  await sleep(2_000);
  const pinResult = unlock();
  await sleep(3_000);
  const a1 = await client(PORTS.A1, 'tauri.localhost');
  await ensureChat(a1).catch(() => null);
  await openConversation(a1, peerNameFor('A1')).catch(() => null);
  return { a1, pinResult };
}

const STATES = {
  1: {
    // THE CONTROL EVERY OTHER ROW IS READ AGAINST, and the only one that enters no state at all: the
    // setup below already launches the app to the foreground and opens the conversation, which IS
    // this check's precondition. `enter` is empty on purpose rather than absent, so the machine below
    // stays uniform and nothing has to ask whether this row is special.
    name: 'LIFE-1 foreground baseline',
    enter: () => {},
    processDies: false,
    // RECORDED, NOT ASSERTED, and the board says why: this row is marked `+A1`, alone among the
    // eight, while LIFE-2..8 are `+push`. Push is not in its scope. Whether an app holding the
    // conversation ON SCREEN should also raise a shade entry is a product question no decision in
    // this repository has settled, and asserting either answer here would be inventing one - so the
    // shade is reported and NOTIF, which owns the notification surface, is where it is asserted.
    expectNotification: 'record',
  },
  2: { name: 'LIFE-2 backgrounded (HOME)', enter: () => phone.home(), processDies: false },
  3: {
    name: 'LIFE-3 killed (force-stop)',
    enter: () => phone.forceStop(),
    // A force-stopped package sits in Android's STOPPED state and the framework cancels every FCM
    // broadcast to it until a MANUAL launch - measured in logcat 2026-08-06. So the empty shade is
    // the documented answer, not a Canari fault, and asserting a notification here would be
    // asserting against the OS. What this check is really for is the other half: the app must come
    // back and hold the message exactly once. "The user killed it" is LIFE-8 (`am kill`), which
    // does not set the flag; force-stop is what the app-info screen does.
    expectNotification: false,
    processDies: true,
  },
  4: {
    name: 'LIFE-4 doze (force-idle)',
    // Doze needs the screen off and the device unplugged as far as the framework is concerned;
    // `unplug` is what lets `force-idle` take, and it is undone at the end of the run.
    enter: () => {
      phone.home();
      phone.sh('dumpsys battery unplug');
      phone.sh('input keyevent KEYCODE_SLEEP');
      phone.sh('dumpsys deviceidle force-idle');
    },
    leave: () => {
      phone.sh('dumpsys deviceidle unforce');
      phone.sh('dumpsys battery reset');
      phone.wake();
    },
    processDies: false,
  },
  5: {
    name: 'LIFE-5 rebooted, app never opened',
    // The point is `CanariBootReceiver`: after a reboot the app has not been launched, so whatever
    // re-registers the push transport has to do it from the boot broadcast alone. Launching the app
    // here - even to "check it came back" - destroys the very state under test.
    enter: async () => {
      phone.adb(['reboot']);
      await sleep(5_000);
      phone.adb(['wait-for-device'], 180_000);
      // `wait-for-device` returns as soon as adbd answers, which is long before the framework is up.
      for (let i = 0; i < 120; i++) {
        try {
          if (phone.sh('getprop sys.boot_completed').trim() === '1') break;
        } catch {
          /* adbd is still coming back */
        }
        await sleep(2_000);
      }
      // FCM re-registers on its own schedule after a boot; a send that beats it measures Google's
      // reconnect, not Canari's.
      await sleep(30_000);
      phone.wake();
    },
    processDies: true,
  },
  6: {
    // MUST run over USB: the wireless transport rides the wifi this check switches off, so a
    // wireless serial disconnects at `enter()` and the run dies before it measures anything.
    name: 'LIFE-6 offline (radios off)',
    enter: () => {
      phone.home();
      phone.sh('svc wifi disable');
      phone.sh('svc data disable');
    },
    leave: () => {
      phone.sh('svc wifi enable');
      phone.sh('svc data enable');
    },
    // Nothing can arrive while the radios are down - that is the premise, not the finding. What the
    // check is really for is what happens AFTER: exactly one copy, once the network returns.
    expectNotification: false,
    processDies: false,
  },
  7: {
    name: 'LIFE-7 notifications permission revoked',
    enter: () => {
      phone.home();
      phone.sh(`pm revoke ${phone.PKG} android.permission.POST_NOTIFICATIONS`);
    },
    leave: () => phone.sh(`pm grant ${phone.PKG} android.permission.POST_NOTIFICATIONS`),
    // The shade must stay EMPTY here - that is the check, not a failure.
    expectNotification: false,
    processDies: false,
  },
  8: {
    name: 'LIFE-8 process reclaimed (am kill)',
    // `am kill` only reclaims a process the framework considers safe to kill, so an app that is
    // merely out of the foreground survives it silently. The first run of this check killed nothing,
    // measured the ordinary foreground path, and reported FAIL - one more instance of the rule that
    // an action which cannot prove it took effect still yields a verdict. HOME and a sleep were the
    // first attempt at that precondition and were NOT enough: HOME leaves the app in the "previous"
    // slot, one rung above cached. `phone.kill` now establishes it and reports what it killed from.
    enter: async () => {
      const stateAtKill = await phone.kill();
      await requireDead(`am kill (state at kill: ${stateAtKill})`);
    },
    processDies: true,
  },
};

/** Polls until the app's process is gone; throws rather than let a no-op kill become a verdict. */
async function requireDead(what, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (phone.pid() === null) return Date.now() - t0;
    await sleep(1_000);
  }
  throw new Error(`${what} did not kill the app - pid ${phone.pid()} is still alive after ${timeoutMs}ms`);
}

const state = STATES[which];
if (!state) throw new Error(`unknown LIFE check ${which}`);

// ── setup: the phone in the conversation, W2 in the DM ───────────────────────
phone.wake();
// Start from the FOREGROUND whatever the previous run left behind: entering a state from an app
// that was already backgrounded measures the wrong transition, and a notification raised before the
// state was entered would be counted as the state's own.
phone.launch();
await sleep(4_000);
phone.forwardDevtools(PORTS.A1);
const a1Setup = await client(PORTS.A1, 'tauri.localhost');
await ensureChat(a1Setup).catch(() => null);
await openConversation(a1Setup, peerNameFor('A1')).catch(() => null);
const w2 = await client(PORTS.W2, APP_TAB);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));
await sleep(1_000);

phone.clearLogcat();
// The instant the phone's own window opens, so the native half can be classified rather than
// grepped - see the note at the verdict.
const phoneWindowFrom = Date.now();
const oW = await watch(w2, `life${which}-w2`);
const pidBefore = phone.pid();

// ── the state ────────────────────────────────────────────────────────────────
// Awaited: LIFE-5 reboots the device, so `enter` is not always instantaneous, and a check that
// sent its message while the phone was still booting would measure the boot, not the app.
await state.enter();
await sleep(4_000);
const pidDuring = phone.pid();

// ── the message ──────────────────────────────────────────────────────────────
const m = mark(`LIFE${which}`);
const sentAt = await send(w2, `${m} sent while ${state.name}`);
const wantNotification = state.expectNotification === undefined || state.expectNotification === true;
// A row that does not expect a notification still LOOKS for one - an unexpected shade entry is a
// finding - but it does not pay a minute for the answer it already predicts.
const notifiedInMs = await phone.awaitNotification(m, wantNotification ? 60_000 : 20_000);
const shade = phone.notifications().map((n) => `${n.title} | ${n.body}`.slice(0, 120));

// ── back to life ─────────────────────────────────────────────────────────────
if (state.leave) await state.leave();
const { a1, pinResult } = await restore();
// TWO numbers, because they answer different questions: time since the send includes however long
// this check spent waiting on the shade and unlocking, which is a property of the harness; time
// since the app came back is the app's own catch-up.
const restoredAt = Date.now();
const arrivedInMs = await awaitMessage(a1, m, 90_000).then(() => Date.now() - sentAt, () => null);
const afterRestoreMs = arrivedInMs === null ? null : arrivedInMs - (restoredAt - sentAt);
await sleep(3_000);
const count = await countMessage(a1, m);

const phoneConsole = phone.console_();
const notable = phoneConsole.filter((l) =>
  /\[KP\]|SecretReuse|out of bounds|LOST frame|silent ACK|Duplicate|error|failed|epoch/i.test(l)
);

/**
 * THE PHONE'S NATIVE HALF, CLASSIFIED - and it is the half this phase is entirely about.
 *
 * LIFE is the only phase where the app is BACKGROUNDED or KILLED for the duration, which means the
 * work under test runs in Kotlin and Rust with no WebView attached: `CanariFCM` receiving the push,
 * the Rust core decrypting it, the keystores, the workers. `phone.console_()` above cannot see any
 * of it - it is the WebView's console, and during LIFE-4/7/8 there is no WebView. So every previous
 * run of this check observed the one surface that was switched off.
 */
const phoneReport = logcatReport(await logcatSince(phoneWindowFrom), 'A1');

// THREE ANSWERS, NOT TWO. `true`/absent demands a notification, `false` demands an empty shade, and
// `'record'` demands nothing because the row's scope excludes push - see LIFE-1 above. Collapsing
// `'record'` into either of the other two would make this phase state a product rule that no
// decision in this repository has taken.
const notificationHolds =
  state.expectNotification === 'record'
    ? true
    : wantNotification
      ? notifiedInMs !== null
      : notifiedInMs === null;
// The lifecycle transition is an ASSERTION, not a note printed beside the verdict: a check whose
// state was never entered can still satisfy every other condition, and then reads as a real result
// about a state the phone was never in.
const diedAsExpected = state.processDies === (pidDuring === null);
const asserted =
  count === 1 &&
  arrivedInMs !== null &&
  diedAsExpected &&
  notificationHolds
    ? 'PASS'
    : 'FAIL';

// RECORDED, GATED, AND EXITED ON - none of which this script did. Seven checks (LIFE-2, 3, 4, 6, 7,
// 8 and the human LIFE-5) printed a `verdict` field to stdout and exited on it; not one of them has
// ever appeared in `results.ndjson`, so the phase's whole history is a terminal buffer.
//
// The notification assertion is stronger here than it looks and is worth naming: `awaitNotification`
// waits for the MARKER in the shade, and the generic fallback body carries no marker - so
// `notifiedInMs !== null` already proves the background decrypt produced real text. That is the
// property NOTIF had to be taught explicitly; LIFE had it by construction.
await finishObserved(`LIFE-${which}`, asserted, {
  // NOT `check`: the ledger writes its OWN `check` - the runner file and its sha - and `record`
  // spreads the detail over it, so this line would have replaced LIFE's provenance with a state
  // name on every row it ever wrote. It wrote none until today, which is the only reason the
  // corruption never surfaced. TAB and FWD still do it; `RESERVED` in `results.mjs` says why it
  // cannot yet throw on them.
  phoneState: state.name,
  marker: m,
  pid: { before: pidBefore, during: pidDuring, after: phone.pid(), diedAsExpected },
  notification: {
    expected: state.expectNotification === 'record' ? 'recorded, not asserted' : wantNotification,
    afterMs: notifiedInMs,
    shade,
  },
  conversation: { arrivedInMs, afterRestoreMs, count },
  pin: pinResult,
  phoneWebviewNotable: notable.slice(-12),
}, { W2: oW, A1: phoneReport });
