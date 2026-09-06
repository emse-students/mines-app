/**
 * NOTIF-1b / NOTIF-4 / NOTIF-4b / NOTIF-9 / NOTIF-10 / NOTIF-11 - the notification surface, one
 * check per run.
 *
 * These five are ones the LIFE phase did NOT already answer. NOTIF-1 and NOTIF-8 were measured by
 * LIFE-8 (`am kill`, decrypted text in 4.7 s) and LIFE-4 (doze, decrypted text in 4.6 s), so
 * re-running them here would only re-measure the same transition under another name.
 *
 * The app must be OUT of the foreground for any of this to mean anything, and `am force-stop` is
 * not available to us: a force-stopped package sits in Android's STOPPED state and the framework
 * cancels every FCM broadcast to it. So the kill is always `am kill` from HOME, asserted.
 *
 * Usage: bun notif.mjs 1b|4|4b|9|10|11
 */
import { APP_TAB, awaitMessage, client, COMPOSER, countMessage, ensureChat, evaluate, openConversation, send } from '../chat.mjs';
import { gate, logcatReport, logcatSince, report, watch } from '../watch.mjs';
import { mark, record, exitOnRecorded } from '../results.mjs';
import * as phone from '../phone.mjs';
import { PORTS, peerNameFor } from '../names.mjs';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = String(process.argv[2] || '4');

// Progress on stderr. A check that stalls silently is indistinguishable from a slow one, and this
// harness has already produced verdicts for actions that never happened - so every step announces
// itself and every step that can block carries its own deadline.
const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);
/** Rejects rather than hang: an unbounded await here freezes the whole run with no diagnostic. */
const withDeadline = (p, ms, what) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} did not settle in ${ms}ms`)))]);

/** HOME, then `am kill`, then prove it died - the shared gesture, see `phone.killAndProveDead`. */
const killPhone = async () => (await phone.killAndProveDead()).deadInMs;

/** How many of the phone's current notifications mention `needle`. */
const shadeHits = (needle) => phone.notifications().filter((n) => n.full.includes(needle)).length;

/** The shade's undecrypted notifications - shared, see `phone.undecryptedInShade`. */
const undecryptedInShade = phone.undecryptedInShade;

/** Waits for a notification carrying `needle` to DISAPPEAR; returns elapsed ms or null on timeout. */
async function awaitDismissal(needle, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (shadeHits(needle) === 0) return Date.now() - t0;
    await sleep(2_000);
  }
  return null;
}

/** The PIN modal, if it is up - shared, see `phone.unlockPin`. */
const unlock = phone.unlockPin;

// ── the three clients ────────────────────────────────────────────────────────
stage('waking and launching the phone');
phone.wake();
phone.launch();
await sleep(4_000);
phone.forwardDevtools(PORTS.A1);
const a1Setup = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 60_000, 'A1 attach');
stage(`A1 attached; unlock -> ${unlock()}`);
stage('A1 attached; opening the DM');
await withDeadline(ensureChat(a1Setup), 60_000, 'A1 ensureChat').catch(() => null);
await withDeadline(openConversation(a1Setup, peerNameFor('A1')), 90_000, 'A1 openConversation').catch(() => null);

stage('attaching W2');
const w2 = await withDeadline(client(PORTS.W2, APP_TAB), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');
await withDeadline(openConversation(w2, peerNameFor('W2')), 90_000, 'W2 openConversation');

// W1 is the OWNER's other device. It must sit on the chat list, NOT inside the DM: a browser already
// looking at the conversation reads it as it lands, which would dismiss the phone's notification
// before the check ever asserted it was there. NOTIF-4 then needs it to open that DM on cue, so
// the conversation is opened ONCE here to prove the row is reachable, then left.
stage('attaching W1');
const w1 = await withDeadline(client(PORTS.W1, APP_TAB), 60_000, 'W1 attach');
await withDeadline(ensureChat(w1), 60_000, 'W1 ensureChat');
await withDeadline(openConversation(w1, peerNameFor('W1')), 90_000, 'W1 openConversation (pre-flight)');
// NOTIF-4b IS THE ONE ROW THAT WANTS W1 LEFT IN THE CONVERSATION. Every other check parks it so the
// phone's notification survives long enough to be asserted; 4b asks what happens when the other
// device was ALREADY reading, which is the state parking exists to avoid. So the gesture is
// conditional and says which row it is for, rather than being commented out by whoever runs that row.
if (which === '4b') {
  stage('W1 stays IN the DM - that is NOTIF-4b s premise');
} else {
  stage('W1 can reach the DM; parking it on the chat list');
  await evaluate(w1, `history.pushState({}, '', '/chat'); dispatchEvent(new PopStateEvent('popstate'))`).catch(() => null);
  await sleep(2_500);
}

phone.clearLogcat();
// The instant the phone's window opens, so `logcatSince` can be asked for exactly this check's
// traffic rather than for a line count. `clearLogcat` alone is not a window: a check that reads "the
// last 3000 lines" gets whatever the device wrote, which on this hardware is dominated by other
// applications and can bury an entire run.
const phoneWindowFrom = Date.now();
const oW2 = await watch(w2, `notif${which}-w2`);
const oW1 = await watch(w1, `notif${which}-w1`);
const out = { check: `NOTIF-${which}` };

/**
 * NOTIF-1b - THE CASE THE P1 WAS ABOUT, AND THE ONE THIS BOARD NEVER HAD A ROW FOR.
 *
 * Twenty-three NOTIF rows, and none of them asks what happens when the app is merely BACKGROUNDED
 * and alive. NOTIF-1 kills it, NOTIF-7 taps a banner that is assumed to exist, LIFE-8 kills it too.
 * The phone in a pocket - the commonest state a phone is ever in - was the one nobody asserted, and
 * it is exactly where the defect lived: a backgrounded Android keeps its WebSocket, receives the
 * frame and ACKs it, so the server correctly sends NO push, and the JS layer opened with
 * `if (isMobileTauriRuntime()) return;` on the premise that the push handler would speak. It never
 * ran. Nobody notified at all, while the app held the message the whole time.
 *
 * THE PREMISE IS ASSERTED, NOT ARRANGED. `pid` non-empty and `foregrounded()` false AT THE SEND is
 * what separates this row from NOTIF-1; a process that died between HOME and the send would make
 * the deferred push fire and this row pass while measuring the killed path.
 *
 * AND THE ANTI-FAKE CLAUSE IS A CLOCK, WHICH IS UNUSUAL HERE AND IS THE POINT. `scheduleDeferredPush`
 * fires only for a message still unACKed after TEN SECONDS. So a notification that arrives INSIDE
 * that window cannot have come from a push - it can only have come from the JS layer, which is the
 * thing being measured. Without it, a phone whose ACK merely failed would notify through the push
 * handler and this row would go green over a fix that does nothing. The number is not a timeout to
 * be tuned: it is the server's own constant, and the row reads it as a discriminator rather than as
 * a budget.
 */
if (which === '1b') {
  const alive = () => ({ pid: phone.pid(), foregrounded: phone.foregrounded() });
  stage('backgrounding the phone with HOME - the app must stay ALIVE');
  phone.home();
  await sleep(3_000);
  out.atBackground = { ...alive(), procState: phone.procState() };

  const m = mark('NOTIF1B');
  out.marker = m;
  out.atSend = alive();
  stage(`sending ${m} (pid=${out.atSend.pid || 'DEAD'}, foregrounded=${out.atSend.foregrounded})`);
  await send(w2, `${m} backgrounded and alive`);

  stage('waiting for a notification - inside the 10 s the deferred push cannot beat');
  out.notifiedInMs = await phone.awaitNotification(m, 60_000);
  // COUNTS AND PATTERNS, NEVER THE LINES. `phone.notifications()` says so in its own docblock:
  // titles and bodies are real conversation content, and this ledger is read from a transcript. The
  // marker is synthetic, so matching ON it is safe; carrying what it matched is not.
  out.shadeHits = shadeHits(m);
  out.undecrypted = undecryptedInShade();

  // THE PREVIEW IS HALF THE ROW. The reported symptom was a banner reading `Nouveau message de
  // <name>` with nothing under it - a notification that arrived and said nothing - so a clause that
  // only counted banners would have gone green on the defect exactly as the user reported it.
  const carriesTheText = out.shadeHits > 0;

  // The app had it all along, which is what made the silence a defect rather than a loss.
  out.heldOnA1 = await withDeadline(countMessage(a1Setup, m), 45_000, 'A1 countMessage').catch(() => null);

  const unmet = [];
  if (!out.atSend.pid) unmet.push('theAppWasStillAlive');
  if (out.atSend.foregrounded) unmet.push('theAppWasHidden');
  if (out.notifiedInMs === null) unmet.push('aNotificationArrived');
  if (!carriesTheText) unmet.push('itCarriedTheMessageAndNotJustASenderName');
  if (out.notifiedInMs !== null && out.notifiedInMs >= 10_000) unmet.push('itBeatTheDeferredPushWindow');
  if (!out.heldOnA1) unmet.push('theAppActuallyHeldTheMessage');
  out.unmet = unmet;
  out.verdict = unmet.length === 0 ? 'PASS' : 'FAIL';
  stage(`NOTIF-1b -> ${out.verdict} (notified in ${out.notifiedInMs}ms, unmet ${JSON.stringify(unmet)})`);
} else if (which === '4') {
  // Cross-device dismissal: the phone notifies, the OTHER device of the same user reads, the
  // phone's notification must go. The two halves are asserted separately - a check that only
  // watched the shade empty out would pass on a phone that never notified at all.
  stage('killing the phone');
  out.killedInMs = await killPhone();
  const m = mark('NOTIF4');
  stage(`sending ${m}`);
  await send(w2, `${m} cross-device dismissal`);
  stage('waiting for the notification');
  out.notifiedInMs = await phone.awaitNotification(m, 60_000);
  out.shadeBefore = shadeHits(m);
  out.undecrypted = undecryptedInShade();
  stage(`notified after ${out.notifiedInMs}ms; W1 now reads it`);

  // W1 reads it. Opening the conversation is what emits the read receipt - but ONLY if the window
  // reports focused and visible (MainChatPage.svelte:435). That gate is what made this check fail
  // twice before focus emulation existed, so it is asserted rather than assumed: a run where W1 is
  // not focused measures nothing about the product.
  await withDeadline(openConversation(w1, peerNameFor('W1')), 90_000, 'W1 openConversation');
  out.w1Focus = await evaluate(w1, `JSON.stringify({ hasFocus: document.hasFocus(), vis: document.visibilityState })`);
  stage(`W1 focus gate: ${out.w1Focus}`);
  if (!JSON.parse(out.w1Focus).hasFocus) throw new Error('W1 is not focused - it can never emit a read receipt');
  await awaitMessage(w1, m, 30_000).catch(() => null);
  // The receipt is debounced 2 s and then rides the outbox, so give it room before concluding.
  await sleep(6_000);
  out.readOnW1 = await countMessage(w1, m);
  stage(`W1 holds ${out.readOnW1} copy; waiting for the shade to clear`);

  out.dismissedInMs = await awaitDismissal(m, 90_000);
  stage(`dismissal: ${out.dismissedInMs}`);
  out.shadeAfter = shadeHits(m);
  out.verdict =
    out.notifiedInMs !== null && out.readOnW1 === 1 && out.dismissedInMs !== null && out.undecrypted.length === 0
      ? 'PASS'
      : 'FAIL';
  out.marker = m;
} else if (which === '4b') {
  // NOTIF-4 WITH NOTHING FOR AN UNREAD COUNTER TO SEE. There, W1 was on the chat list and opening the
  // DM took its unread from one to zero, so a dismissal driven by that transition would pass. Here W1
  // is already inside the conversation when the message lands: it is read on arrival, the counter
  // never leaves zero, and a phone whose shade is cleared by watching that counter will keep a
  // notification for a message the account has demonstrably already read.
  stage('killing the phone (W1 is already in the DM)');
  out.killedInMs = await killPhone();
  out.w1Focus = await evaluate(w1, `JSON.stringify({ hasFocus: document.hasFocus(), vis: document.visibilityState })`);
  stage(`W1 focus gate: ${out.w1Focus}`);
  // The read receipt is gated on a focused, visible window (MainChatPage.svelte:435), exactly as in
  // NOTIF-4. Unfocused, W1 reads nothing, and this row would be measuring a device that is not
  // looking - which is NOTIF-4's setup, not this one.
  if (!JSON.parse(out.w1Focus).hasFocus) throw new Error('W1 is not focused - it can never emit a read receipt');
  const m = mark('NOTIF4B');
  stage(`sending ${m} into a conversation W1 already has open`);
  await send(w2, `${m} read on arrival by the other device`);

  // W1 first: the message must actually land there, or "it was already read" is an assumption.
  await awaitMessage(w1, m, 60_000).catch(() => null);
  await sleep(6_000); // the receipt is debounced 2 s and then rides the outbox
  out.readOnW1 = await countMessage(w1, m);
  stage(`W1 holds ${out.readOnW1} copy`);

  // THEN the shade, and BOTH acceptable outcomes are named. A phone that never notified because the
  // read receipt beat the push is CORRECT, and so is one that notified and then cleared. Only a
  // notification still sitting there for a message the account has read is a defect - so the
  // assertion is on what REMAINS, and `notifiedInMs` is recorded to say which of the two paths ran.
  // Asserting `notifiedInMs !== null` here would fail a phone for being fast.
  out.notifiedInMs = await phone.awaitNotification(m, 45_000);
  out.dismissedInMs = await awaitDismissal(m, 90_000);
  out.shadeAfter = shadeHits(m);
  out.undecrypted = undecryptedInShade();
  out.path = out.notifiedInMs === null ? 'never notified (read beat the push)' : 'notified, then cleared';
  stage(`${out.path}; shade holds ${out.shadeAfter}`);
  out.verdict =
    out.shadeAfter === 0 && out.readOnW1 === 1 && out.undecrypted.length === 0 ? 'PASS' : 'FAIL';
  out.marker = m;
} else if (which === '11') {
  // THREE MESSAGES, ONE NOTIFICATION. Android stacks a conversation's messages into a single record;
  // three records for three messages is the failure, and so is one record that carries only the last
  // line - a shade that says "1 new message" when three arrived is a lie about how much is waiting.
  stage('killing the phone');
  out.killedInMs = await killPhone();
  const markers = [];
  for (let i = 0; i < 3; i++) {
    const m = mark(`NOTIF11-${i}`);
    markers.push(m);
    stage(`sending ${i + 1}/3`);
    await send(w2, `${m} stacked (${i + 1}/3)`);
    // Spaced so they are three deliveries rather than one batch, and so the second and third arrive
    // while the first is already in the shade - which is the state the stacking is done in.
    await sleep(6_000);
  }
  out.markers = markers;
  stage('waiting for the last of the three to reach the shade');
  out.notifiedInMs = await phone.awaitNotification(markers[2], 90_000);
  // Settle on the same principle as NOTIF-9: the extra records this is looking for arrive AFTER the
  // one that was awaited, and the failure is the moment to stop rather than to keep waiting.
  out.settleWindowMs = Math.max(8_000, (out.notifiedInMs ?? 4_000) * 2);
  const settleDeadline = Date.now() + out.settleWindowMs;
  const recordsFor = () =>
    phone.notifications().filter((n) => markers.some((m) => n.full.includes(m)));
  while (Date.now() < settleDeadline) {
    if (recordsFor().length > 1) break;
    await sleep(1_000);
  }
  const records = recordsFor();
  out.recordCount = records.length;
  // WHICH markers the single record carries, not how many - a record holding the first and third but
  // not the second is a different defect from one holding only the last, and the count cannot say so.
  out.markersInRecord = records.length === 1 ? markers.map((m) => records[0].full.includes(m)) : null;
  out.shade = phone.notifications().map((n) => `${n.title} | ${n.body}`.slice(0, 120));
  out.undecrypted = undecryptedInShade();
  stage(`${out.recordCount} record(s), markers present: ${JSON.stringify(out.markersInRecord)}`);

  // AND ALL THREE MUST EXIST, which is what stops this row passing on a lost message: two messages
  // dropped on the floor also produce exactly one notification record. W1 is the account's other
  // device and is enough to prove three distinct messages were delivered; the shade above is the
  // part that is this row's actual subject.
  stage('opening the DM on W1 to prove all three were really delivered');
  await withDeadline(openConversation(w1, peerNameFor('W1')), 60_000, 'openConversation(W1)');
  for (const m of markers) await awaitMessage(w1, m, 60_000).catch(() => null);
  await sleep(2_000);
  out.onW1 = [];
  for (const m of markers) out.onW1.push(await countMessage(w1, m));
  stage(`W1 holds ${JSON.stringify(out.onW1)}`);
  out.verdict =
    out.notifiedInMs !== null &&
    out.recordCount === 1 &&
    out.markersInRecord !== null &&
    out.markersInRecord.every(Boolean) &&
    out.onW1.every((c) => c === 1) &&
    out.undecrypted.length === 0
      ? 'PASS'
      : 'FAIL';
} else if (which === '9') {
  // Two devices of one user, one message: the phone must raise exactly ONE notification for it,
  // and the browser must hold exactly one copy. The failure this is looking for is a second
  // notification for the same message - one per delivery path rather than one per message.
  // EVERY step here gets a stage. The first run of this branch stalled with the last line printed
  // being the shared setup's, which made a stall indistinguishable from a slow notification - the
  // exact failure mode the header of this file warns about, reproduced by omitting stages here.
  stage('killing the phone');
  out.killedInMs = await killPhone();
  const m = mark('NOTIF9');
  stage(`sending ${m}`);
  await send(w2, `${m} one message, two devices`);
  stage('waiting for the notification');
  out.notifiedInMs = await phone.awaitNotification(m, 60_000);
  // Settle: a duplicate raised by a second path arrives AFTER the first, so counting immediately
  // would report 1 for a phone that shows 2 a moment later.
  //
  // THE WINDOW IS DERIVED FROM THE MEASUREMENT, NOT GUESSED, AND IT ENDS ON THE EVENT. It was a flat
  // `sleep(20_000)`: unjustifiable in both directions - a second path slower than 20 s would have
  // passed as "no duplicate", and every run that behaves correctly pays the full twenty seconds to
  // observe nothing. The first path's own latency is the only honest scale for the second, and the
  // duplicate is the FAILURE, so seeing one is the moment to stop rather than to keep waiting.
  out.settleWindowMs = Math.max(8_000, (out.notifiedInMs ?? 4_000) * 2);
  stage(`notified after ${out.notifiedInMs}ms; watching the shade for up to ${out.settleWindowMs}ms`);
  const settleDeadline = Date.now() + out.settleWindowMs;
  while (Date.now() < settleDeadline) {
    if (shadeHits(m) > 1) break; // the duplicate this exists to catch, seen as it happens
    await sleep(1_000);
  }
  out.shadeCount = shadeHits(m);
  out.shade = phone.notifications().map((n) => `${n.title} | ${n.body}`.slice(0, 120));
  out.undecrypted = undecryptedInShade();

  stage(`shade holds ${out.shadeCount}; opening the DM on W1`);
  await withDeadline(openConversation(w1, peerNameFor('W1')), 60_000, 'openConversation(W1)');
  stage('W1 in the DM; waiting for the message');
  await awaitMessage(w1, m, 30_000).catch(() => null);
  await sleep(2_000);
  out.onW1 = await countMessage(w1, m);
  stage(`W1 holds ${out.onW1}`);
  out.verdict =
    out.notifiedInMs !== null && out.shadeCount === 1 && out.onW1 === 1 && out.undecrypted.length === 0
      ? 'PASS'
      : 'FAIL';
  out.marker = m;
} else if (which === '10') {
  // Five messages across a ten-minute outage. The question is not whether they arrive - LIFE-6
  // answered that for one message - but whether FCM's collapsing loses four of them, and whether
  // the shade then lies about how many there are.
  const OFFLINE_MS = Number(process.env.NOTIF10_OFFLINE_MS || 10 * 60_000);
  phone.home();
  await sleep(2_000);
  stage(`cutting the radios for ${Math.round(OFFLINE_MS/1000)}s`);
  phone.sh('svc wifi disable');
  phone.sh('svc data disable');
  out.offlineForMs = OFFLINE_MS;

  const markers = [];
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const m = mark(`NOTIF10-${i}`);
    markers.push(m);
    stage(`sending ${i + 1}/5 while the phone is dark`);
    await send(w2, `${m} sent while offline (${i + 1}/5)`);
    await sleep(20_000);
  }
  // Stay dark for the rest of the window; the collapse this is looking for happens at Google's
  // end while the device is unreachable, so the wait is the experiment.
  const remaining = OFFLINE_MS - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);

  stage('restoring the radios');
  phone.sh('svc wifi enable');
  phone.sh('svc data enable');
  phone.wake();
  const backAt = Date.now();

  // The shade first, while the app is still not in the foreground - opening it would clear them.
  out.notifiedInMs = await phone.awaitNotification(markers[markers.length - 1], 120_000);
  out.shadeHits = markers.map((m) => shadeHits(m));
  out.shade = phone.notifications().map((n) => `${n.title} | ${n.body}`.slice(0, 120));
  out.undecrypted = undecryptedInShade();
  out.reconnectToShadeMs = out.notifiedInMs === null ? null : Date.now() - backAt;

  stage('relaunching the app and re-pointing devtools at the NEW pid');
  phone.launch();
  await sleep(6_000);
  phone.forwardDevtools(PORTS.A1);
  await sleep(2_000);
  const a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
  // A ten-minute blackout restarts the app when the radios come back, and a restarted app re-locks
  // the encryption PIN - so the chat is behind the modal and nothing below it can be navigated to.
  out.unlock = unlock();
  stage(`unlock -> ${out.unlock}`);
  await ensureChat(a1).catch(() => null);
  await openConversation(a1, peerNameFor('A1')).catch((e) => stage(`openConversation: ${e.message}`));

  // POST-CONDITION, and the reason the first run of this check was worthless: both navigation calls
  // swallowed their failure, so when the app came back on `/posts` (a restarted process opens on its
  // default route, not where it was) the count ran against the FEED and reported 0/5 - which reads
  // as five lost messages and measures nothing at all. A marker cannot appear on a screen that does
  // not show messages. Assert the conversation is on screen, or refuse to produce a verdict.
  const screen = JSON.parse(
    await evaluate(a1, `JSON.stringify({ url: location.href, composer: !!document.querySelector('${COMPOSER}') })`)
  );
  out.a1Screen = screen;
  stage(`A1 screen: ${JSON.stringify(screen)}`);
  if (!screen.composer) throw new Error(`A1 is not in a conversation (${screen.url}) - the count would be fiction`);

  for (const m of markers) await awaitMessage(a1, m, 90_000).catch(() => null);
  await sleep(3_000);
  out.counts = [];
  for (const m of markers) out.counts.push(await countMessage(a1, m));
  out.verdict = out.counts.every((c) => c === 1) && out.undecrypted.length === 0 ? 'PASS' : 'FAIL';
  out.markers = markers;
} else {
  throw new Error(`unknown NOTIF check ${which}`);
}

// ── observation, WHICH IS NOW PART OF THE VERDICT ────────────────────────────
//
// This block used to compute exactly what it computes now and then do NOTHING with it: three full
// reports were printed UNDER `out.verdict`, where a reader could see them and no verdict could ever
// be contradicted by them. `NOTIF-10: PASS` therefore meant "the five messages arrived", full stop -
// not "and the run was clean" - and it was not even a row in `results.ndjson`, because this file
// never called `record` at all. Both halves of the campaign's rule were missing from the phase that
// exercises the phone hardest.
//
// The phone's own half was a keyword `grep` over `phone.console_()`, which reads only the WebView's
// TypeScript console out of logcat - so the Rust core, the FCM service and the workers, the entire
// reason a phone check exists, were never looked at. `logcatReport` classifies them.
const phoneReport = logcatReport(await logcatSince(phoneWindowFrom), 'A1');
out.phone = {
  clean: phoneReport.clean,
  severe: phoneReport.severe,
  errors: phoneReport.errors,
  unexplained: phoneReport.unexplained,
  notable: phoneReport.notable,
  foreign: phoneReport.foreign,
  explainedBy: phoneReport.explainedBy,
  pids: phoneReport.pids,
};
const trim = (r) => ({
  clean: r.clean,
  errors: r.errors,
  exceptions: r.exceptions,
  badHttp: r.badHttp,
  wsEvents: r.wsEvents,
  notable: r.notable,
  unexplained: r.unexplained,
});
const rW2 = await report(oW2);
const rW1 = await report(oW1);
out.w2 = trim(rW2);
out.w1 = trim(rW1);

// NOT `ignoringOfflineCut`, deliberately, even though NOTIF-10 cuts the radios. That helper forgives
// a CLIENT's reaction to a cut this check performed, and here the client that was cut is the PHONE -
// whose report comes from logcat, which the helper does not model. Applying it to W1/W2 would forgive
// them for an outage they never had. If NOTIF-10's phone window turns out to carry the app's honest
// reconnect chatter, that is a rule to add to `logcatReport` with its reason, not a blanket pardon.
const gated = gate(out.verdict, { W1: rW1, W2: rW2, A1: phoneReport });
out.verdict = gated.verdict;
record(`NOTIF-${which}`, gated.verdict, {
  ...gated.detail,
  undecryptedInShade: out.undecrypted,
  notifiedInMs: out.notifiedInMs ?? null,
  markers: out.markers ?? (out.marker ? [out.marker] : []),
});
console.log(JSON.stringify(out, null, 2));

// THIS SCRIPT CANNOT REACH `beforeExit`: it holds CDP sockets and nothing closes them, so the loop
// never idles and the hook that derives the exit code never fires. It ran off its end instead and
// sat there with its verdict already on disk, blocking whatever was queued behind it.
// `exitOnRecorded` is that same derivation called rather than waited for - never `process.exit(0)`,
// which would report a pass over the FAIL just recorded.
exitOnRecorded();
