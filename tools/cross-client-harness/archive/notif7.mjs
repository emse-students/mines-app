/**
 * NOTIF-7 - tapping a notification deep-links into the RIGHT conversation. Run TWICE.
 *
 *   bun notif7.mjs bg      the app is backgrounded (alive, HOME pressed)
 *   bun notif7.mjs killed  the app is dead (`am kill` from HOME, asserted)
 *
 * This is `check H` of docs/wiki/device-verification.md, which has only ever been verified by
 * COMPILING. The product has no `/c/<id>` route: a notification tap publishes to `notifNav`, so the
 * only way to test it is to tap the real notification and read where the app lands.
 *
 * THE DISCRIMINATOR, and why the app is parked on the FEED first. If A1 were already sitting in the
 * DM, "the DM is on screen after the tap" would be true whether the deep link worked or did nothing
 * at all. So the app is moved to `/posts` before it is backgrounded or killed: after the tap the
 * conversation must be on screen AND must contain this run's marker, which no default route can
 * produce.
 *
 * The tap itself goes through the notification shade via `a1.py` (uiautomator2), because the tap is
 * the thing under test - `am start` with a deep link would bypass the PendingIntent entirely and
 * measure nothing.
 */
import { APP_TAB, client, COMPOSER, countMessage, ensureChat, evaluate, goto, openConversation, send } from '../chat.mjs';
import { logcatReport, logcatSince, watch } from '../watch.mjs';
import { finishObserved, mark } from '../results.mjs';
import * as phone from '../phone.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { ACCOUNT_OF, PEER_NAME, PORTS, peerNameFor } from '../names.mjs';
import { requireScript } from '../scriptpath.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const mode = String(process.argv[2] || 'bg');
if (!['bg', 'killed'].includes(mode)) throw new Error(`usage: bun notif7.mjs bg|killed`);

const T0 = Date.now();
const stage = (m) => process.stderr.write(`[${((Date.now() - T0) / 1000).toFixed(3)}s] ${m}\n`);

const py = (...args) => {
  try {
    return execFileSync('python', ['a1.py', ...args], {
      cwd: HERE,
      encoding: 'utf8',
      timeout: 120_000,
      // The SAME transport `phone.mjs` drives - see the comment on `phone.SERIAL`.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ANDROID_SERIAL: phone.SERIAL },
    });
  } catch (e) {
    return `[a1.py failed] ${String(e.stdout || e.message).slice(0, 400)}`;
  }
};

/**
 * Taps the notification carrying `needle`, by COORDINATES read out of the shade dump.
 *
 * uiautomator2's own `.click()` cannot be used here: its on-device agent dies with
 * `RemoteDisconnected` as soon as the shade is expanded, twice out of two, after the dump has
 * already succeeded. So the dump - which works - supplies the centre, and the tap goes through plain
 * `input tap`, which involves no agent at all.
 *
 * It taps the TEXT node rather than hunting for its clickable ancestor: a tap at those coordinates
 * is dispatched to whatever is on top there, which is the notification row. Returns the coordinates
 * it used, or null - a tap that cannot prove it had a target must not produce a verdict.
 */
function tapNotification(needle) {
  const dump = py('notif');
  const row = dump.split('\n').find((l) => l.includes(needle) && /@\d+,\d+\s*$/.test(l.trim()));
  if (!row) return { ok: false, dump: dump.split('\n').slice(0, 25), why: `no shade row contains ${needle}` };
  const [, x, y] = row.trim().match(/@(\d+),(\d+)\s*$/);
  phone.sh(`input tap ${x} ${y}`);
  return { ok: true, x: Number(x), y: Number(y), row: row.trim() };
}

function unlock(port = PORTS.A1) {
  try {
    return execFileSync(
      process.execPath,
      [requireScript('pin.mjs'), '--port', String(port), '--account', ACCOUNT_OF.A1, '--match', 'tauri.localhost'],
      { cwd: HERE, encoding: 'utf8', timeout: 120_000 }
    )
      .trim()
      .split('\n')
      .pop();
  } catch (e) {
    if (e.status === 2) return 'no modal';
    return `pin.mjs failed: ${String(e.stdout || e.message).slice(0, 200)}`;
  }
}

// Match on `full`, never on the parsed title/body: those come out of a regex over a truncated dump,
// and matching the truncated form is what made LIFE-2 report "no notification" for one that was
// plainly there. `phone.awaitNotification` already does the right thing.
//
// AND WAIT FOR THE CONVERSATION, NOT FOR THE MARKER. This check is about the TAP; whether the body
// carries the decrypted text is a different question, and on a backgrounded app the answer is often
// no ("Nouveau message de <peer>", the fallback). Waiting on the marker made the check
// report "no notification ever reached the shade" while a perfectly tappable notification for the
// right conversation was sitting in it. So: wait on the sender's name, then RECORD whether the
// marker is in it.
const PEER = PEER_NAME;
const awaitShade = (timeoutMs) => phone.awaitNotification(PEER, timeoutMs);

const out = { check: `NOTIF-7 (${mode})`, mode };

// ── phone: unlock, park on the FEED ──────────────────────────────────────────
stage('waking and launching the phone');
phone.wake();
phone.launch();
await sleep(4_000);
phone.forwardDevtools(PORTS.A1);
let a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
stage(`unlock -> ${unlock()}`);
await ensureChat(a1).catch(() => null);
await sleep(3_000);

stage('parking A1 on the FEED, so a default route cannot fake the verdict');
// The reload is DECLARED (see `goto`): parking the phone off `/chat` is the precondition this check
// is built on, and it happens before the notification window opens, so the PIN re-lock is handled by
// the unlock above and no command is in flight to lose its `runCallback`.
await goto(a1, '/posts', { relaunch: 'the phone must be parked off /chat before the window opens' });
await sleep(4_000);
out.beforeUrl = await evaluate(a1, 'location.href');
stage(`A1 before: ${out.beforeUrl}`);

// ── W2, THE PEER, is the sender, and that is not interchangeable with W1 ───────
//
// A1 is one of the OWNER's devices, so a message sent from W1 - the owner's other device - is the
// user's OWN message. The native layer classifies it exactly that way and suppresses the
// notification on purpose, which is correct behaviour and not what this check is about:
//
//   CanariFCM: thread: ... senderName=<owner> silent=true inlineProto=true
//   CanariFCM: FCM silent from self -> cancelling notification for group=<group id>
//
// The first run of this check used W1 and reported "no notification ever reached the shade" - a FAIL
// against a build that was behaving correctly. The sender must be the PEER.
stage('attaching W2, the peer, as the sender');
const w2 = await client(PORTS.W2, APP_TAB);
await ensureChat(w2);
await openConversation(w2, peerNameFor('W2'));
const w = await watch(w2, 'W2');
// The phone's window opens with the peer's, and it is the one that matters here: everything under
// test from this line on happens with no WebView attached - the app is about to be backgrounded or
// killed - so `CanariFCM`, the Rust core and the keystores are the only witnesses there are.
phone.clearLogcat();
const phoneWindowFrom = Date.now();

// W1 must be OFF the conversation. It is the owner's other device: if it sits in the DM it marks the
// message read the moment it lands, which pushes a cross-device DISMISSAL to the phone - the exact
// mechanism NOTIF-4 verifies - and the notification under test is cancelled by design. Seen in the
// previous run's log, arriving BEFORE the message push it was meant to dismiss.
stage('parking W1 off the conversation, so it cannot dismiss the notification by reading it');
const w1 = await client(PORTS.W1, APP_TAB);
await goto(w1, '/posts');
await sleep(3_000);
out.w1Url = await evaluate(w1, 'location.href');
if (/\/chat/.test(out.w1Url)) throw new Error(`W1 is still on the chat (${out.w1Url})`);

// ── put the app out of the foreground ────────────────────────────────────────
phone.home();
await sleep(2_000);
if (mode === 'killed') {
  // `am kill` reclaims a CACHED process and nothing else, so `phone.kill` drops it there first and
  // reports the state it killed from - and the death is ASSERTED, because a kill that killed nothing
  // has already produced a fictional verdict on this page.
  out.stateAtKill = await phone.kill();
  await sleep(2_000);
  out.pidAfterKill = phone.pid();
  stage(`pid after kill: ${out.pidAfterKill} (state at kill: ${out.stateAtKill})`);
  if (out.pidAfterKill !== null) {
    throw new Error(
      `the app is still alive after am kill from state ${out.stateAtKill} - the check would measure a warm start`
    );
  }
} else {
  out.pidBackgrounded = phone.pid();
  stage(`pid backgrounded: ${out.pidBackgrounded}`);
  if (out.pidBackgrounded === null) throw new Error('the app died - this is the "killed" case, not "bg"');
}
out.foregroundedBefore = phone.foregrounded();
if (out.foregroundedBefore) throw new Error('the app is still in the foreground; the notification would never be posted');

// ── send, and wait for the shade ─────────────────────────────────────────────
const marker = mark('NOTIF7');
stage(`sending ${marker}`);
await send(w2, `${marker} deep link (${mode})`);
out.shadeInMs = await awaitShade(120_000);
const ours = phone.notifications().filter((n) => n.full.includes(PEER));
out.shade = ours.map((n) => `${n.title} | ${n.body}`.slice(0, 160));
// The SECOND observation, recorded next to the verdict rather than gating it: did the background
// path decrypt, or did it post the generic fallback? NOTIF-1's expectation is real content.
out.decrypted = ours.some((n) => n.full.includes(marker));
stage(`shade in ${out.shadeInMs} ms, decrypted=${out.decrypted}; ${JSON.stringify(out.shade)}`);
if (out.shadeInMs === null) {
  out.verdict = 'FAIL';
  out.why = 'no notification for this conversation ever reached the shade - nothing to tap';
  const phoneReport = logcatReport(await logcatSince(phoneWindowFrom), 'A1');
  writeFileSync(new URL(`./notif7-${mode}.log`, import.meta.url), JSON.stringify({ ...out, a1: phoneReport }, null, 2));
  // THE FAILING PATH RECORDS TOO, and this is the one where the phone's log is the whole diagnosis:
  // "nothing reached the shade" has several causes - no push delivered, a decrypt that threw, a
  // notification posted and cancelled - and they are indistinguishable from the shade's silence.
  await finishObserved(`NOTIF-7-${mode}`, 'FAIL', out, { W2: w, A1: phoneReport });
}

// ── the tap ──────────────────────────────────────────────────────────────────
stage('expanding the shade and tapping the notification');
out.tap = tapNotification(out.decrypted ? marker : PEER);
stage(`tap -> ${JSON.stringify(out.tap)}`);
const tappedAt = Date.now();
if (!out.tap.ok) throw new Error(`the tap had no target: ${out.tap.why}`);

// ── where did it land? ───────────────────────────────────────────────────────
await sleep(6_000);
phone.forwardDevtools(PORTS.A1); // a killed app came back under a NEW pid, so the old forward is dead
await sleep(2_000);
a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
out.foregroundedAfter = phone.foregrounded();

// A COLD START RE-LOCKS, AND EVERY ASSERTION BELOW READS THE SCREEN BEHIND THE MODAL.
// `unlock()` at setup is spent the instant the app is killed, so the `killed` case comes back to the
// PIN gate - and `landed.composer`/`landed.marker`/`count` are all false there, for a reason that
// has nothing to do with the deep link. That is harness fault #22: the first WP-DEEPLINK-1
// verification polled for 69 s behind a locked screen and reported the deep link lost. It WAS lost
// that time (proven independently in logcat), but the measurement could not have said so - it would
// have returned the identical verdict against a fixed build.
//
// Waiting for the modal rather than calling `unlock()` blind matters just as much: the app is still
// booting, so an immediate call returns "no modal", the gate appears a second later, and the check
// measures behind it exactly as before. Poll for whichever settles first - the modal or the composer
// (a warm `bg` run never locks at all, and must not pay 40 s for that).
const PIN_GATE = `(!!document.querySelector('#encryption-pin') || document.body.innerText.indexOf('PIN de chiffrement') !== -1)`;
out.pinGateMs = null;
for (let i = 0; i < 40; i++) {
  const seen = JSON.parse(
    await evaluate(a1, `JSON.stringify({ gate: ${PIN_GATE}, composer: !!document.querySelector('${COMPOSER}') })`)
  );
  if (seen.gate) {
    out.pinGateMs = i * 1_000;
    break;
  }
  if (seen.composer) break;
  await sleep(1_000);
}
const unlockStartedAt = Date.now();
out.unlockAfterTap = out.pinGateMs === null ? 'no gate' : unlock(PORTS.A1);
out.unlockMs = Date.now() - unlockStartedAt;
stage(`pin gate after ${out.pinGateMs} ms -> ${out.unlockAfterTap} (${out.unlockMs} ms)`);

// The app may still be booting; give the deep link a real window before deciding.
const measuringFrom = Date.now();
let landed = null;
for (let i = 0; i < 20; i++) {
  landed = JSON.parse(
    await evaluate(
      a1,
      `JSON.stringify({ url: location.href, composer: !!document.querySelector('${COMPOSER}'), marker: (document.body.innerText||'').indexOf('${marker}') !== -1 })`
    )
  ).valueOf();
  if (landed.composer && landed.marker) break;
  await sleep(3_000);
}
out.landed = landed;
// Two clocks, because they answer two questions. `deepLinkMs` is what the USER waits from the tap,
// PIN entry included - honest, but it says nothing about the deep link once a gate is in the way.
// `landedAfterUnlockMs` is the navigation itself, and it is the one to compare between `bg` (no
// gate) and `killed` (gate).
out.deepLinkMs = Date.now() - tappedAt;
out.landedAfterUnlockMs = Date.now() - measuringFrom;
stage(`landed: ${JSON.stringify(landed)} after ${out.deepLinkMs} ms (${out.landedAfterUnlockMs} ms post-unlock)`);

out.count = await countMessage(a1, marker);
out.verdict = out.foregroundedAfter && landed.composer && landed.marker && out.count === 1 ? 'PASS' : 'FAIL';

/**
 * `out.phoneNotable = []` was the whole native observation - a literal empty array, assigned and
 * written to the log file as if something had filled it.
 *
 * It also settles `out.decrypted`, which this file explicitly recorded "next to the verdict rather
 * than gating it". That stays true and is now enough: a generic fallback body means the app logged
 * `Fallback notification:` at `W` on `CanariFCM`, which the classifier files as an ERROR, so the
 * fallback breaks `clean` without NOTIF-7 having to assert anything outside its own subject. The
 * deep link remains what this check FAILS on; the failed decrypt beside it can no longer pass
 * unremarked.
 */
const phoneReport = logcatReport(await logcatSince(phoneWindowFrom), 'A1');

writeFileSync(new URL(`./notif7-${mode}.log`, import.meta.url), JSON.stringify({ ...out, a1: phoneReport }, null, 2));
// One id per MODE: `bg` and `killed` are two checks on the dashboard, and a shared id would let the
// second overwrite the first's row in every reading of the ledger.
await finishObserved(`NOTIF-7-${mode}`, out.verdict, out, { W2: w, A1: phoneReport });
