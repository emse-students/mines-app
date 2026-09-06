/**
 * NOTIF-6c - the notification QUICK REPLY from a merely BACKGROUNDED app (WP-NOTIF-1).
 *
 * ## IT RECORDS `NOTIF-6c`, AND IT IS NOT CHECK K - THE FILE NAME IS HISTORY
 *
 * Check K's step 1 in [device-verification](../../docs/wiki/device-verification.md) is *"Kill the
 * app"*, and the board names that NOTIF-6. What this file does is the opposite on purpose - HOME,
 * process alive - because the 403 below appears ONLY there, and a killed app hides it completely.
 * So the measurement is NOTIF-6c and always was; recording it as `K` gave one measurement two names
 * and `rows.mjs` reported it, correctly, as an id the board does not name.
 *
 * The one `K` row already in the ledger is left alone - the ledger is append-only and destroying
 * evidence to tidy a name would be worse than the name. It is a FAIL from a run nobody answered,
 * taken before `theShadeWasAnswered` existed; the board carries a retired `K` line saying so.
 *
 * THIS IS THE RE-MEASUREMENT THE FIX HAS BEEN OWED SINCE 2026-08-30, and the runner
 * `device-verification.md` names for it (`scratch/k-run.mjs`) does not exist, which is why it was
 * never taken. A procedure that lives only in prose is a procedure that goes stale: this is an atom
 * now, and the page points at it.
 *
 * ## What broke, and why only the BACKGROUNDED case shows it
 *
 * `POST /mls/push/register` mints a fresh push secret on every call and invalidates the previous one
 * server-side. The WebView writes that secret to `pending_push_secret.txt`; the only thing that ever
 * moves it into the Keystore is `CanariApplication.processPendingPushSecret`, which runs once per
 * process at `onCreate` - strictly BEFORE the registration that wrote the file. So a reader that
 * consults the Keystore first holds the PREVIOUS process's secret for the whole life of a process,
 * and the server answers 403 to every background send.
 *
 * A KILLED app hides it completely: FCM starts a fresh process, `onCreate` migrates the file, and
 * the Keystore is fresh again. That asymmetry is the whole defect, and it is why the 2026-08-30 PASS
 * - taken on a killed app - proved less than it looked. Measured the same day, same build:
 *
 *     07:55:57  sendQueuedMessagePush: HTTP 201   <- app KILLED, fresh process
 *     07:59:30  sendQueuedMessagePush: HTTP 403   <- app BACKGROUNDED, same process
 *
 * ## The precondition is NOT ambient, and this asserts it rather than assuming it
 *
 * `pending_push_secret.txt` must EXIST at the moment of the background send. It is written by the
 * unlock and consumed by the first reader, so a run made after anything else has read it exercises
 * the Keystore path - the path that never broke - and returns a PASS about nothing. That is the
 * worst outcome available here, so `thePreconditionWasArmed` is a clause like any other and the run
 * says which side it measured.
 *
 * ## What this runner does NOT do, and why that is deliberate
 *
 * It does not type the reply. `RemoteInput` is answered from the system shade, which is the OS's
 * surface rather than the app's, and `device-verification.md` asks for a human gesture there on
 * purpose - the 2026-08-30 measurement records that the reply was typed by a person and treats that
 * as what makes the row believable. What this owns is everything that decides whether the gesture
 * MEANS anything: a fresh process, an armed file, a backgrounded-and-alive premise asserted at the
 * send, and the four verdict lines afterwards. It prints when to answer and waits.
 *
 * Usage: bun archive/k.mjs   (records NOTIF-6c)
 */
import { APP_TAB, client, ensureChat, openConversation, send } from '../chat.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import * as phone from '../phone.mjs';
import { PORTS, peerNameFor } from '../names.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);
/** Rejects rather than hang: an unbounded await here freezes the whole run with no diagnostic. */
const withDeadline = (p, ms, what) =>
  Promise.race([
    p,
    sleep(ms).then(() => Promise.reject(new Error(`${what} did not settle in ${ms}ms`))),
  ]);

/**
 * The size of the armed handoff file, or null when it is not there.
 *
 * SIZE RATHER THAN EXISTENCE, because the Kotlin distinguishes them: an EMPTY file is a half-written
 * handoff that `retrievePushSecret` deliberately leaves alone and falls through to the Keystore for.
 * A check that only asked "does it exist" would arm on the one shape that behaves like no file.
 */
function pendingSecretBytes() {
  const out = phone.sh(`run-as ${phone.PKG} stat -c '%s' pending_push_secret.txt`).trim();
  return /^\d+$/.test(out) ? Number(out) : null;
}

const out = { check: 'NOTIF-6c' };

// ── 1. A fresh process, so the Keystore cannot already hold this session's secret ────────────────
stage('HOME, then am kill - never force-stop, which cancels every FCM broadcast to the package');
phone.home();
out.killedInMs = (await phone.killAndProveDead()).deadInMs;

// ── 2. The unlock is what calls /mls/push/register and writes the file ───────────────────────────
stage('foreground + unlock - the unlock is what mints a new secret and writes the handoff');
await phone.ensure({ port: PORTS.A1 });
out.unlock = phone.unlockPin();
stage(`unlock -> ${out.unlock}`);
const a1 = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 60_000, 'A1 attach');
await withDeadline(ensureChat(a1), 60_000, 'A1 ensureChat').catch(() => null);
await withDeadline(openConversation(a1, peerNameFor('A1')), 90_000, 'A1 openConversation').catch(
  () => null
);

// ── 3. THE PRECONDITION, ASSERTED ────────────────────────────────────────────────────────────────
out.pendingSecretBytes = pendingSecretBytes();
stage(
  `pending_push_secret.txt -> ${out.pendingSecretBytes === null ? 'ABSENT' : `${out.pendingSecretBytes} bytes`}`
);

stage('attaching W2');
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');
await withDeadline(openConversation(w2, peerNameFor('W2')), 90_000, 'W2 openConversation');

phone.clearLogcat();
const phoneWindowFrom = Date.now();
const oW2 = await watch(w2, 'k-w2');

// ── 4. BACKGROUNDED, NOT KILLED - the whole point of this row ────────────────────────────────────
stage('backgrounding the phone with HOME - the process must SURVIVE');
phone.home();
await sleep(3_000);
out.atSend = { pid: phone.pid(), foregrounded: phone.foregrounded(), procState: phone.procState() };

const m = mark('NOTIF-6c');
out.marker = m;
stage(`sending ${m} (pid=${out.atSend.pid || 'DEAD'}, foregrounded=${out.atSend.foregrounded})`);
await send(w2, `${m} quick reply from the shade`);

stage('waiting for the notification');
out.notifiedInMs = await phone.awaitNotification(m, 60_000);
out.undecrypted = phone.undecryptedInShade();

// ── 5. THE HUMAN GESTURE ─────────────────────────────────────────────────────────────────────────
console.error('');
console.error('  ============================================================');
console.error('  ANSWER THE NOTIFICATION ON THE PHONE NOW.');
console.error('  Pull the shade down, tap "Repondre", type anything, send it.');
console.error('  This runner waits up to 180 s for the send to be attempted.');
console.error('  ============================================================');
console.error('');

/**
 * The four lines the fix must produce. Each is a separate clause so a partial chain names WHERE it
 * stopped - "the reply was queued but the server refused it" and "nothing was ever queued" are
 * different findings, and a single boolean would have said the same thing about both.
 */
const WANTED = [
  [
    'theNewerSecretWasAdopted',
    /retrievePushSecret: newer secret adopted from pending_push_secret\.txt/,
  ],
  ['theReplyWasQueued', /CanariNotifAction: handleReply: queued/],
  ['theServerAcceptedIt', /sendQueuedMessagePush: HTTP 201/],
  ['theOutboxDrained', /drainOutboxBackground: \d+ sent, 0 remaining/],
];

// Polls for the SEND ATTEMPT rather than for a fixed duration: the gesture is a human's and its
// timing is not the rig's to assume. Any HTTP verdict ends the wait, including the 403 this exists
// to refuse - which is what keeps a failing run as short as a passing one.
const deadline = Date.now() + 180_000;
let log = '';
while (Date.now() < deadline) {
  log = phone.console_(8_000);
  if (/sendQueuedMessagePush: HTTP \d+/.test(log)) break;
  await sleep(5_000);
}
out.sawAnyHttpVerdict = /sendQueuedMessagePush: HTTP \d+/.test(log);
out.refused403 = /sendQueuedMessagePush: HTTP 403/.test(log);
// THE GESTURE EITHER HAPPENED OR IT DID NOT, AND THAT IS NOT A VERDICT ABOUT THE PRODUCT.
// `CanariNotificationActionReceiver.onReceive` logs before it can decide anything, so its absence
// means the broadcast never fired - nobody answered the notification. The first run of this file
// recorded FAIL for exactly that, with all four product clauses unmet and `sawAnyHttpVerdict`
// false, which is the instrument accusing the app of a silence that was the room's. A zero that
// could mean "refused" or "never asked" is a defect in the instrument, not a finding.
out.theShadeWasAnswered = /CanariNotifAction:/.test(log);

const unmet = [];
if (!out.atSend.pid) unmet.push('theAppWasStillAlive');
if (out.atSend.foregrounded) unmet.push('theAppWasHidden');
// NOT a product clause: with no armed file the run exercises the Keystore path, which never broke.
if (out.pendingSecretBytes !== 32) unmet.push('thePreconditionWasArmed');
if (out.notifiedInMs === null) unmet.push('aNotificationArrived');
for (const [name, re] of WANTED) if (!re.test(log)) unmet.push(name);
out.unmet = unmet;

if (!out.theShadeWasAnswered) {
  // SKIPPED, not FAIL: the row asks what the app does with a reply, and no reply was made. The
  // clauses are still recorded, so a reader can see how far the run got before the gesture was owed.
  out.verdict = 'SKIPPED';
  out.why = 'the notification was never answered - no CanariNotifAction broadcast in the window';
  stage(`NOTIF-6c -> SKIPPED (${out.why})`);
} else {
  out.verdict = unmet.length === 0 ? 'PASS' : 'FAIL';
  stage(`NOTIF-6c -> ${out.verdict} (403 seen: ${out.refused403}, unmet ${JSON.stringify(unmet)})`);
}

const phoneReport = logcatReport(await logcatSince(phoneWindowFrom), 'A1');
const rW2 = await report(oW2);
const gated = gate(out.verdict, { W2: rW2, A1: phoneReport });
out.verdict = gated.verdict;
record('NOTIF-6c', gated.verdict, {
  ...gated.detail,
  unmet,
  theShadeWasAnswered: out.theShadeWasAnswered,
  pendingSecretBytes: out.pendingSecretBytes,
  refused403: out.refused403,
  notifiedInMs: out.notifiedInMs ?? null,
  markers: [m],
});
console.log(JSON.stringify(out, null, 2));

// This script holds CDP sockets that nothing closes, so `beforeExit` never fires and the exit code
// would never be derived - see `notif.mjs`. Never `process.exit(0)`, which reports a pass over a
// FAIL already on disk.
exitOnRecorded();
