#!/usr/bin/env node
/**
 * THE REVOKED DEVICE THAT COMES BACK AFTER THE WORLD MOVED - one runner, one row per invocation.
 *
 *   bun healrevoke.mjs --row 1                  is the local store actually gone after a revocation?
 *   bun healrevoke.mjs --row 2                  it reconnects - is it like-new, holding nothing?
 *   bun healrevoke.mjs --row 3                  ... and does it end where a FRESH device ends?
 *   bun healrevoke.mjs --row 5                  revoked, the world changes a lot, then it returns
 *   bun healrevoke.mjs --row 7 --order first    it returns BEFORE the other devices are online
 *   bun healrevoke.mjs --row 7 --order last     it returns AFTER they are
 *   bun healrevoke.mjs --row 8                  a group DELETED while it was away
 *   bun healrevoke.mjs --row 9                  revoked while it was OFFLINE - a deferred wipe
 *
 * ROW 1 STOPS AT THE WIPE, AND STOPPING THERE IS THE POINT RATHER THAN AN ECONOMY. Its question is
 * the user's own report - a revoked device that kept everything - and that is a claim about ONE
 * instant: the disk, after the device has been told it is gone. Everything past that instant makes
 * the claim HARDER to read, not easier, because a re-enrolment writes state back: the login that
 * follows a wipe mints a device immediately, so `CanariDB_<userId>` exists again under the same name
 * within seconds and no later sample can tell a store that survived from one that was rebuilt. Rows
 * 2, 3 and the return equality are about what a returning device ENDS with; this row is about
 * whether anything was left for it to find, and it is the only row that can be.
 *
 * IT COSTS ONE ENROLMENT AND NO 2FA, WHICH IS WHY IT IS FIRST ON THE RUNG. The reference device the
 * equality rows mint is what makes them expensive; this row needs no reference, because "empty" is
 * not a quantity to compare against anything. It creates the doomed group all the same, and deletes
 * it before it exits: a wipe measured on a device that held nothing proves nothing, so the victim is
 * made to hold real MLS state first, and the group is not left behind for a sweep to find.
 *
 * ROW 2 STOPS AT THE RETURN, AND ITS ASSERTIONS ARE CHOSEN TO BE ONES THE SERVER CANNOT SATISFY.
 * That is the whole reason it is a row of its own: a revoked id is BLACKLISTED, so the client is
 * forced to mint a new one whatever its disk holds - and "it came back as a new device" is therefore
 * true of a device that kept every byte. The row leans on the one thing only a local store can
 * produce: a group DELETED while the device was away. The server will never serve it; a device
 * remembering it shows it anyway. So `theDeletedGroupDidNotComeBack` is the blacklist-proof half,
 * `theNewGroupArrived` is its mirror - a group created while away can only come from enumeration -
 * and the residue read at the wipe is asserted again here because row 2's claim rests on it.
 *
 * IT DOES NOT MINT A REFERENCE, which is what makes it cheaper than row 3. "Holding nothing from
 * before" is a claim about ABSENCE and needs nothing to compare against; "it ended where a fresh
 * device ends" is a claim about a QUANTITY and cannot be made without one.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: that the first readout after the return shows zero ready
 * rows. It would be the sharpest evidence there is - a surviving store renders ready immediately,
 * an enumerated one starts amber - and it is unreadable on this topology. The seeded device of
 * HEAL-REVOKE-1 settled 7 of 7 rows in TWO MILLISECONDS, and HEAL-NEW-15 already records that the
 * amber window opens before the login has finished and closes before any reader placed after it can
 * exist. An assertion that can only be true by luck is not one.
 *
 * ROW 3 IS ROW 2 PLUS THE REFERENCE, PLUS ONE ASSERTION NO OTHER ROW MAKES. The equality against a
 * freshly minted device is rows 5, 7 and 8's mechanism and it answers "did it resynchronise as a new
 * device would". What row 3 adds is the user's actual injury: *a restore that stops halfway looks
 * complete*, which is how their PC lost conversations without anyone knowing to retry. So a
 * SHORTFALL MUST BE VISIBLE - if the returned device holds less than the reference, the app must
 * still be SAYING so, with rows amber. It is a conditional assertion by construction: it can only
 * fail on a run that has a shortfall, and on a run that has none it claims nothing, which is honest
 * rather than weak. The alternative - asserting amber rows unconditionally - would fail every clean
 * run and pass nothing.
 *
 * ROW 9 IS ITS OWN QUESTION AND STOPS EARLIER THAN THE OTHERS. `isDeviceRevoked` answers `false`
 * when it cannot reach the server, because a transport failure is not an answer - so a device
 * revoked while unreachable is SUPPOSED to keep everything until it can ask, and the wipe is
 * supposed to land the first time somebody SIGNS IN on it. Not the first time it has a network:
 * `sessionAuth.ts` holds exactly three triggers and every one needs a credential or a live socket,
 * so a reload that authenticates nobody confirms nothing and must erase nothing. All three halves
 * are assertions - a device that wiped itself while unreachable would mean something read a failure
 * as a revocation, which is how every offline user gets logged out; a device that wiped itself on a
 * bare reload would mean a destructive control fired on an unconfirmed state. It therefore does not
 * move the world or mint a reference device - the return equality is rows 5, 7 and 8's subject, and
 * this row is about the DEFERRAL and what ends it.
 *
 * THE ASSERTION IS AN EQUALITY, NOT A REPAIR COUNT (user, 2026-08-27). Revocation orders the device
 * to delete everything, so a revoked device coming back IS a new device - and if that is true, its
 * final state must equal a fresh device's in the same world. Ending with MORE than the fresh device
 * means the wipe kept something; ending with LESS is worse, because a device missing a group it is
 * still a member of looks healthy and is not.
 *
 * THE REFERENCE IS MEASURED, NEVER LOOKED UP. The fresh device it is compared against is minted HERE,
 * on the same profile, in the same world, minutes later - not read out of a HEAL-NEW row taken at
 * another hour against another set of groups. Two fingerprints from the same afternoon are a
 * comparison; one fingerprint and a remembered number is a hope. It costs a second enrolment, which
 * is affordable exactly because the PIN is account-level and the CAS session survives the wipe.
 *
 * WHY THE MISSED CHANGES CANNOT BE A QUEUE DRAIN. A message the device missed is a ciphertext someone
 * can hand it again. A MEMBERSHIP change is an epoch move: the group's ratchet advanced without this
 * device, and no replay puts it back - the only way in is a fresh Welcome or an external join. So the
 * world this row moves is deliberately made of both kinds: a group created, a group deleted, and
 * messages sent. A runner that only sent messages would pass while the mechanism that matters was
 * never exercised.
 *
 * IT REVOKES THROUGH THE PRODUCT'S OWN PATH. `purge-devices.mjs` drives the device panel, so the
 * DELETE that runs is the one a person triggers, with `purgeDeviceFootprint` behind it. A row that
 * deleted a row from the database would be measuring a state the product never produces, and the
 * question here is what the product does.
 *
 * ORDER IS AN AXIS HERE TOO, for the same reason it is for HEAL-NEW: the returning device may find
 * the account's other clients already listening, or arrive alone and be found later. Those are two
 * mechanisms, and row 7 asserts the FINAL STATE is the same across both while recording the time
 * separately, because a difference in time is dirt carrying a number and a difference in state is a
 * failure.
 *
 * NO NAMES. Groups this runner mints are named on `debris.mjs`'s existing `HGRP` pattern so the
 * sweeps can already reach them; nothing else about a conversation is ever printed, and ids are cut
 * to eight characters.
 */
import { spawnSync } from "node:child_process";
import { client, ensureChat, evaluate } from "../chat.mjs";
import {
  census,
  enrolledDeviceCount,
  installTag,
  isRegistered,
  MAX_DEVICES_PER_USER,
  revokedAt,
} from "../devices.mjs";
import { deviceResidue } from "./footprint.mjs";
import { createGroup, deleteGroup } from "../groupnav.mjs";
import { isUp, killBrowser, startBrowser } from "../launch.mjs";
import { armCut, awaitReachable, awaitSevered, cutHard, link } from "./net.mjs";
import { ORIGIN, PORTS, SITE } from "../names.mjs";
import { becomeANewDeviceAndConfirm } from "../newdevice.mjs";
import { onlineDevicesOf } from "./presence.mjs";
import { stateOf } from "./ready-probe.mjs";
import { bringToReady } from "./ready-repair.mjs";
import { finishObserved, record, unmet } from "../results.mjs";
import { subsetArrivedAndSettled } from "./servable.mjs";
import { HARNESS_ROOT, requireScript } from "../scriptpath.mjs";
import {
  activeGroupIds,
  navigationCost,
  readAll,
  sidebar,
  watch as watchRows,
  whoAmI,
} from "./syncrows.mjs";
import {
  AUTH_TEARDOWN_NARRATION,
  BLOCK_LIST_READ_NARRATION,
  consoleLines,
  DEVICE_PANEL_NARRATION,
  FRESH_CLIENT_NARRATION,
  ignoringExpectedLog,
  IDP_CONSOLE_NARRATION,
  NO_LOCAL_STATE_NARRATION,
  REVOKED_RETURN_NARRATION,
  ignoringExpectedRefusal,
  ignoringOfflineCut,
  MINT_REFUSALS,
  OIDC_LOGIN_NARRATION,
  report,
  watch,
} from "../watch.mjs";


/**
 * THE NOISE THESE ROWS PROVOKE, NAMED PER OBSERVER RATHER THAN ONCE FOR THE RUN.
 *
 * A row here mints TWICE and revokes once, so it produces the whole of `healnew.mjs`'s signature and
 * then some: two OIDC logins, two abandoned-id purges, one panel-driven revocation, and a device
 * narrating its own erasure. Left in, every cell on this rung is a `PASS-DIRTY` on the instrument -
 * and dirt that is always there is dirt nobody reads.
 *
 * THREE OBSERVERS, THREE LISTS, BECAUSE THEY DO NOT DO THE SAME THINGS. The actor never wipes a
 * cookie, so it is not handed the refresh `401`; the returning device is logged in by `login.mjs`
 * and purges nothing, so it is not handed the panel's trail; only a device that was actually revoked
 * is handed the wipe's. A single list applied to all three would forgive each client the lines the
 * OTHER two produce, which is how a per-row disposition quietly becomes a classifier.
 *
 * `ignoringExpectedLog` NAMES THE NEEDLES THAT MATCHED NOTHING, and that is the check on this
 * narrowness: a dry needle here says an observer took a path it usually does not, and the report
 * carries it rather than guessing what it meant.
 *
 * NOTHING BELOW FORGIVES A FAILURE SPELLING. `[RESET] could not clear`, `[RESET] ... SURVIVED the
 * wipe` and the panel's five error and warning lines are named in no list, so the one thing this
 * rung exists to catch - a wipe that kept something - still breaks `clean`.
 *
 * THE ORDER IS LOAD-BEARING, for the reason DEL-2 records and `healnew.mjs` repeats: each helper
 * recomputes `clean` over the buckets AS IT FINDS THEM, so a refusal has to be forgiven before the
 * log pass or the run stays dirty on a request that was already explained.
 */
const forgiving = (rep, narration) =>
  ignoringExpectedLog(ignoringExpectedRefusal(rep, MINT_REFUSALS), narration);

/**
 * The victim after it came back: `login.mjs` drove the IdP, and nothing here purged a device.
 *
 * IT BOOTS WITH NO MLS STATE, which is the row's whole premise - the wipe took it. So it says
 * everything `FRESH_CLIENT_NARRATION` names, and a row that did not forgive that would be reporting
 * its own subject as dirt.
 */
const asAReturningDevice = (rep) =>
  forgiving(rep, [
    ...IDP_CONSOLE_NARRATION,
    ...NO_LOCAL_STATE_NARRATION,
    ...REVOKED_RETURN_NARRATION,
    ...OIDC_LOGIN_NARRATION,
    ...FRESH_CLIENT_NARRATION,
    ...BLOCK_LIST_READ_NARRATION,
  ]);

/** The reference: a full mint, so the callback's trail, the abandoned id's purge, and a cold client. */
const asAFreshlyMintedDevice = (rep) =>
  forgiving(rep, [
    ...IDP_CONSOLE_NARRATION,
    ...NO_LOCAL_STATE_NARRATION,
    ...OIDC_LOGIN_NARRATION,
    ...DEVICE_PANEL_NARRATION,
    ...FRESH_CLIENT_NARRATION,
    ...BLOCK_LIST_READ_NARRATION,
  ]);

/**
 * The window in which the device was revoked: its mint, and then its own account of erasing itself.
 *
 * THIS WINDOW WAS UNGATED UNTIL 2026-08-29, which is two thirds of a gate on the one observer that
 * covers the row's subject. `classifyWipe` read `wipeRan` and `wipeFinished` off it and nothing ever
 * asked whether anything ELSE was said while the wipe ran - so a store rebuilding itself behind the
 * reset, the exact defect HEAL-REVOKE-1 recorded, would have spoken into a capture no verdict read.
 *
 * IT FORGIVES THE MINT AND NOT THE WIPE, and the second half is a measurement rather than an
 * oversight: `NOTABLE` already claims all three of the wipe's sentences, so they never reached
 * `unexplained` and a list for them would forgive nothing while reporting three dry needles on every
 * row of this rung. The failure spellings still break `clean`, which is the whole point of looking.
 */
const asTheWipedVictim = (rep) =>
  forgiving(rep, [
    ...IDP_CONSOLE_NARRATION,
    ...NO_LOCAL_STATE_NARRATION,
    ...REVOKED_RETURN_NARRATION,
    ...OIDC_LOGIN_NARRATION,
    ...DEVICE_PANEL_NARRATION,
    ...FRESH_CLIENT_NARRATION,
    // THE ONLY OBSERVER HANDED THE TEARDOWN, because it is the only device that was revoked. A
    // session clearing itself and a socket dropping is this window's subject and everyone else's
    // finding.
    ...AUTH_TEARDOWN_NARRATION,
    ...BLOCK_LIST_READ_NARRATION,
  ]);

/**
 * The actor: it drove the device panel, and it wiped no cookie of its own.
 *
 * NO REFUSAL IS FORGIVEN HERE, deliberately. A `401` on `/api/auth/refresh` is the wipe working on a
 * client that just deleted its cookies; on the actor, which did no such thing, it is the campaign's
 * own owner session dying - and that is a finding, not this row's noise.
 */
const asTheActor = (rep) =>
  ignoringExpectedLog(rep, [...DEVICE_PANEL_NARRATION, ...BLOCK_LIST_READ_NARRATION]);

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/** The device this row revokes. It must be the scratch profile: revoking W1 ends the campaign. */
const VICTIM = "W3";
/** The device that does the revoking, and that moves the world while the victim is away. */
const ACTOR = "W1";

const ROWS = {
  1: {
    id: "HEAL-REVOKE-1",
    what: "revoked through the device panel - is the local store actually gone?",
    stopsAtTheWipe: true,
  },
  2: {
    id: "HEAL-REVOKE-2",
    what: "the revoked device reconnects - is it like-new, holding nothing from before?",
    stopsAtTheReturn: true,
  },
  3: {
    id: "HEAL-REVOKE-3",
    what: "the first reconnection resynchronises as a new device would, and a shortfall is REPORTED",
  },
  5: { id: "HEAL-REVOKE-5", what: "revoked, the world changes a lot, then it returns" },
  7: { id: "HEAL-REVOKE-7", what: "the ORDER of the return", orders: ["first", "last"] },
  8: { id: "HEAL-REVOKE-8", what: "a group deleted while the device was revoked" },
  9: {
    id: "HEAL-REVOKE-9",
    what: "revoked while the device was OFFLINE - the wipe is deferred, not lost",
    offline: true,
  },
};

const row = ROWS[opt("row", "")];
if (!row) {
  console.error(`healrevoke: --row must be one of ${Object.keys(ROWS).join(", ")}`);
  process.exit(2);
}
const order = opt("order", row.orders ? null : "last");
if (row.orders && !row.orders.includes(order)) {
  console.error(`healrevoke: ${row.id} needs --order ${row.orders.join("|")}`);
  process.exit(2);
}

/** How long the returning device may take to settle before the stall IS the measurement. */
const SETTLE_MS = Number(opt("settle", "600")) * 1000;

const T0 = Date.now();
const mark = (what) => ({ what, at: Date.now() - T0, wall: new Date().toISOString() });
const timeline = [mark("start")];
const note = (what) => {
  const m = mark(what);
  timeline.push(m);
  console.log(`[healrevoke:${row.id}] +${(m.at / 1000).toFixed(1)}s ${what}`);
  return m;
};

/** An error's first line only: a stack in a ledger detail is noise nobody reads. */
const firstLine = (e) =>
  String(e?.message ?? e)
    .split(/\r?\n/)[0]
    .slice(0, 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one rig script and reports its exit and the ONE line that says what happened.
 *
 * THE LAST LINE OF A CRASH IS THE LEAST INFORMATIVE LINE OF IT. A thrown error ends with the node
 * version banner, so a child that died with a precise complaint was reported here as
 * `tail: "Node.js v24.16.0"` - which named neither the script, nor the state, nor the failure. It
 * cost a diagnosis on 2026-08-29: HEAL-REVOKE-5 recorded a login that had refused, and the refusal
 * itself was three lines above the one that got written down.
 *
 * So the throw is preferred when there is one, and the last line only otherwise. A script that
 * exits cleanly still reports what it did on its final line, exactly as before.
 */
function runScript(file, args) {
  // RESOLVED, not a bare name against this directory: `login.mjs`, `pin.mjs` and
  // `purge-devices.mjs` live at the harness root and this file lives in `archive/`, so every one of
  // them failed with `Module not found`. This one at least CAPTURED the failure, unlike
  // `ready-repair.mjs`, which is the only reason it was found by reading rather than by a run.
  const r = spawnSync(process.execPath, [requireScript(file), ...args], {
    encoding: "utf8",
    cwd: HARNESS_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const threw = out.find((l) => /^(?:[A-Za-z]*Error|Uncaught)\b/.test(l));
  return { ok: r.status === 0, status: r.status, tail: threw ?? out.at(-1) ?? "" };
}

/**
 * A group name on `debris.mjs`'s EXISTING pattern, so a group this row abandons is already sweepable.
 *
 * A new pattern would mean a group nobody can delete until someone remembers to add it - which is
 * how twenty-two renamed groups sat invisible to both sweeps for days. `HGRP` plus five base-36
 * characters is `heal-w2.mjs`'s spelling and `isGroupDebris` already matches it.
 */
const debrisName = () => `HGRP${Math.random().toString(36).slice(2, 7)}`;

/**
 * Puts the two peer browsers where this row needs them, and says what it actually did.
 *
 * "PRESENT" MEANS READY, NOT RUNNING, AND THE DIFFERENCE COST THIS RUNG FOUR ROWS ON 2026-08-28.
 * The version this replaces started a browser that was down and then ran `pin.mjs` on it - which is
 * a repair for exactly one state, the PIN gate. A browser already up satisfied `isUp` and was
 * reported "already up" whatever page it was on, and W1 was on `/login`: no session, no device
 * panel, no group creation. The row then blamed the product for an actor that was never there.
 *
 * `bringToReady` IS THE ONLY DEFINITION OF "ready" IN THIS RIG, and this is the sixth caller to be
 * put on it. It restores a session, answers a gate, navigates off a page the proof cannot judge and
 * dismisses a modal left up by whatever ran before - in a loop, because each repair can produce the
 * state another one fixes. Reporting `${which}Ready` as a BOOLEAN is what lets the caller refuse to
 * measure rather than measure something else: a topology that failed must be unmet, never assumed.
 */
async function setTopology(present) {
  const acted = {};
  for (const which of ["w1", "w2"]) {
    const wanted = present.includes(which);
    const up = await isUp(which);
    if (!wanted) {
      acted[which] = up ? `killed in ${await killBrowser(which)}ms` : "already down";
      continue;
    }
    if (!up) {
      await startBrowser(which, `${SITE}/chat`);
      acted[which] = "started";
    } else {
      acted[which] = "already up";
    }
    const r = await bringToReady(which.toUpperCase(), { log: (line) => note(`ready ${line.trim()}`) });
    if (r.unreachable) acted[which] += `, UNREACHABLE: ${r.unreachable}`;
    else acted[which] += `, ${r.ok ? "ready" : `NOT READY (${stateOf(r.state)})`} (${r.trail.join(" -> ")})`;
    acted[`${which}Ready`] = r.ok === true;
  }
  return acted;
}

/**
 * PUTS BACK THE FLEET THIS ROW TOOK DOWN - on every exit path, including the ones that fail.
 *
 * A ROW'S TEARDOWN IS THE NEXT ROW'S INHERITED STATE. `setTopology([ACTOR])` kills W2 in the row's
 * first act, because the world must not move while the victim is away, and until 2026-08-29 nothing
 * ever put it back. The cost is not hypothetical: the run after the first HEAL-REVOKE-5 verdict was
 * refused by `run.mjs`'s preflight - `W2: unreachable on 9223` - and so was the one after the
 * second. Twice, for a device the row itself had killed. `devicesFor` demands W1, W2 and W3 of this
 * rung, so every remaining row would have paid the same toll.
 *
 * IT IS `setTopology` AND NOT A SECOND SPELLING OF IT. `bringToReady` already answers a client that
 * came back signed out - a killed browser keeps its profile but not its in-memory token - by driving
 * `login.mjs` and then `pin.mjs`, so restoring is the same primitive with the full fleet named. A
 * restore path that reimplemented any of that would be a second definition of "ready", and this file
 * has already recorded what those cost.
 *
 * W3 IS NOT IN IT, DELIBERATELY. The victim is the row's SUBJECT, and its final state is the
 * measurement: bringing it to ready here would erase the thing the next reader has to look at, and
 * `run.mjs`'s preflight is what re-establishes it before a row that needs it.
 *
 * IT APPEARS AT FIVE EXITS AND NOT ONE, which is a debt this file's shape owes rather than a choice.
 * A top-level-await script has no `finally` around it without being restructured, so the call is
 * placed at each exit that can end the row after the topology has been set. The three `INVALID`
 * paths need it MOST - they are the ones that end early, and an early end is exactly when a fleet is
 * left broken.
 *
 * IT ALWAYS RUNS AFTER THE ROW IS DURABLE, NEVER BEFORE. Restoring costs a browser start, a login
 * and a PIN, and a run killed inside that minute would lose a verdict that was already computed -
 * three cells of this campaign have died that way. `record` is synchronous, so on the `INVALID`
 * paths the row is on disk by the time this is called; on the two that finish, `finishObserved`
 * takes it as its `afterRecording` hook and runs it between the write and the exit.
 */
async function restoreTheFleet() {
  const back = await setTopology(["w1", "w2"]);
  note(`fleet restored ${JSON.stringify(back)}`);
  return back;
}

/** A connection to the victim's browser, whatever state its page is in. */
const victimCx = () => client(PORTS[VICTIM], new URL(ORIGIN[VICTIM]).hostname);

/**
 * Whether the sidebar holds a row with this exact name, and whether that row is ready.
 *
 * ONE NAME IN, A BOOLEAN OUT. The rig may not dump row text - the sidebar is a real person's
 * conversation list - but asking after a group this runner minted itself leaks nothing: the name was
 * generated here, and the answer is two bits.
 */
async function rowNamed(cx, name) {
  const raw = await evaluate(
    cx,
    `(function () {
       var want = ${JSON.stringify(name)};
       var tiles = [].slice.call(document.querySelectorAll('.sidebar-panel [data-conversation-tile]'));
       var hit = tiles.filter(function (t) { return t.innerText.indexOf(want) !== -1; });
       return JSON.stringify({
         present: hit.length > 0,
         count: hit.length,
         ready: hit.some(function (t) { return t.getAttribute('data-ready') === 'true'; }),
         syncing: hit.some(function (t) { return t.getAttribute('data-ready') === 'false'; }),
       });
     })()`,
  );
  return JSON.parse(raw);
}

/**
 * Revokes the victim through the device panel, and proves the server agrees it is gone.
 *
 * TWO FACTS, READ SEPARATELY, BECAUSE THEY ANSWER TWO QUESTIONS. `revoked_device` is the row the
 * DELETE endpoint writes to record the DECISION, so it is the proof the revocation landed at all;
 * the device leaving the census is the proof no member can address it any more, which is what makes
 * everything below worth measuring. Reading only the second cannot tell a revocation that landed
 * from a device that had nothing to purge, and reading only the first cannot tell a decision from
 * its effect. The panel's own animation proves neither: `purge-devices.mjs` reports what it clicked,
 * and a click that opened a confirm nobody answered reports exactly the same thing.
 *
 * WAITED FOR, NOT READ ONCE. The mirror of the same fault on the minting side, which cost HEAL-NEW-2
 * its verdict on 2026-08-28: a KeyPackage's PUBLICATION is asynchronous, so its DELETION is not
 * something to assume synchronous with a click returning either. A single read here would report a
 * revocation still in flight as a revocation that failed - and this is the gate all four rows stand
 * on, so it would kill every one of them with one number. The wait is bounded and both elapsed times
 * are returned, so a slow revocation is a finding carrying a number rather than a silent tick.
 */
async function revoke(deviceId) {
  const today = new Date().toISOString().slice(0, 10);
  const addressable = () => census(today).some((r) => r.deviceId === deviceId);
  const before = { addressable: addressable(), registered: isRegistered(deviceId) };
  const revokedBefore = revokedAt(deviceId);
  const r = runScript("purge-devices.mjs", ["--only", deviceId, "--port", String(PORTS[ACTOR])]);

  const askedAt = Date.now();
  let stillAddressable = true;
  let decidedInMs = null;
  let goneInMs = null;
  for (;;) {
    // The decision first: it is written inside the request, so if it is not there after the whole
    // window the click never reached the endpoint and the effect below is not worth waiting for.
    if (decidedInMs === null) {
      const now = revokedAt(deviceId);
      if (now && now !== revokedBefore) decidedInMs = Date.now() - askedAt;
    }
    stillAddressable = addressable();
    if (!stillAddressable) {
      goneInMs = Date.now() - askedAt;
      if (decidedInMs !== null) break;
    }
    if (Date.now() - askedAt >= 45_000) break;
    await sleep(3000);
  }
  return {
    wasAddressable: before.addressable,
    wasRegistered: before.registered,
    revoked: decidedInMs !== null,
    decidedInMs,
    stillAddressable,
    goneInMs,
    script: r,
  };
}

/**
 * WHAT THE VICTIM'S OWN CONSOLE SAID ABOUT BEING REVOKED - the whole chain, not just its tail.
 *
 * IT TAKES THE CLIENT, NOT A REPORT, AND THAT IS THE WHOLE FIX. It went wrong twice, in the two
 * ways this seam can go wrong, and the second was the interesting one:
 *
 *   - It read `rep.lines`, which `report()` does not return - the exact mistake `consoleLines`'
 *     own doc comment was written about in 2026-08-11. Every call classified an empty array, and
 *     HEAL-REVOKE-5 spent 25 minutes on `166169a4` recording `theDeviceWipedItself: false` about an
 *     instrument that had never looked.
 *   - Reading `rep.timeline` fixed the field and kept the defect, because **`report()` DRAINS**.
 *     The wipe is waited for in a poll, and each poll consumed the window the previous one had
 *     filled: what the run kept was the LAST four seconds of a two-minute wait, and the run of
 *     16:07 recorded `linesRead: 0` for a device whose log the archive held in full. A classifier
 *     that consumes its own evidence answers about a window nobody chose.
 *
 * `consoleLines(cx)` is the archive `report` fills as it drains - cumulative, non-destructive, and
 * safe to call in a loop. It also leaves the window intact for the gated `wipeWindow` observer,
 * which the polling version was quietly emptying. `linesRead` is returned so a zero can never again
 * pass for a silent device.
 *
 * FIVE SENTENCES, FIVE QUESTIONS, BECAUSE A WIPE THAT DID NOT HAPPEN HAS FOUR DIFFERENT CAUSES and
 * only the client can tell them apart. The frame is routed by the gateway, decoded, dispatched by
 * `WebMlsService`, confirmed against the server by `sessionAuth`, and only then does the wipe run:
 *
 *   `frameArrived`        `[WS RCV] device_revoked` - the socket got it and the client parsed it.
 *   `theCheckWasRefused`  the confirmation answered a status, or could not be reached, and
 *                         `isDeviceRevoked` returned `false` for a reason that is not an answer.
 *   `theServerDisagreed`  it WAS asked, and said no - a frame addressed to a device the denylist
 *                         does not hold, which is a different defect from every other line here.
 *   `theServerConfirmed`  the destructive action was gated on a server fact and passed the gate.
 *   `revocationSeen`      `resetDeviceAsFreshImpl` reached its own last line.
 *
 * A row that FAILS can now say WHERE the chain broke instead of only that it did. Which discovery
 * path fired is still not asserted - a live session should take the frame, and a wipe found a second
 * later at the PIN gate is just as correct - but they are now DISTINGUISHABLE, which is the half
 * that was missing.
 */
function classifyWipe(cx) {
  const lines = consoleLines(cx);
  const said = (re) => lines.some((l) => re.test(l));
  return {
    linesRead: lines.length,
    frameArrived: said(/\[WS RCV\] device_revoked - this device was deleted by its owner/),
    theCheckWasRefused: said(
      /\[MLS\] revocation check (answered \d+|unreachable) - treated as NOT revoked/,
    ),
    theServerDisagreed: said(
      /\[SECURITY\] device_revoked frame received but the server disagrees - ignored/,
    ),
    theServerConfirmed: said(
      /\[SECURITY\] This device was revoked by its owner - signing out and resetting/,
    ),
    revocationSeen: said(/\[SECURITY\] Revoked device detected/),
    wipeRan: said(/\[RESET\] wiping this device/),
    wipeFinished: said(/\[RESET\] done/),
    wipeIncomplete: said(/\[RESET\] finished with \d+ step\(s\) unfinished/),
    storesSurvived: said(/\[RESET\] \d+ store\(s\) SURVIVED the wipe/),
    stepsFailed: lines.filter((l) => /\[RESET\] could not clear/.test(l)).length,
  };
}


/**
 * WHAT ANY CLIENT CURRENTLY ONLINE COULD ACTUALLY SERVE - the proof this rung waits on.
 *
 * IT WAS THE WHOLE SIDEBAR, AND THAT PROOF CANNOT BE REACHED ON THIS ACCOUNT. Two rows of twelve
 * stay amber for the full 600 s on EVERY device measured - the seed, the reference, and the actor's
 * own sidebar - so `syncing === 0` burnt three deadlines a run, thirty of a run's thirty-five
 * minutes, and then reported a stall nothing online could have prevented. That is the exact failure
 * `servable.mjs` was written for on the HEAL-NEW rung, and this is its second caller.
 *
 * IT IS NOT THE SAME SUBSET AS HEAL-NEW'S, AND THE DIFFERENCE IS THE POINT. There the responder is
 * the PEER, a different account, and the fresh device already HOLDS every row it will ever hold, so
 * membership alone is the whole subset. Here the subject's rows have to ARRIVE, so the subset is the
 * intersection of two facts, and neither one alone is it: a device can only answer a re-admission
 * request for a group whose MLS state it HOLDS - a ready row in its sidebar - and the subject can
 * only ever receive a group the SERVER says it is a member of. Serving without membership is the
 * peer's rows, which the subject will never see; membership without serving is a row nothing online
 * could hand over. The subset is what satisfies both, and it is the claim the product must meet.
 *
 * AN EMPTY WORLD NEVER SETTLES. `subsetArrivedAndSettled` refuses a vacuous subset by construction,
 * so a row that returns with nobody online - HEAL-REVOKE-7 `--order first`, which exists to do
 * exactly that - reports a device that could not heal instead of the fastest PASS on the board.
 * The caller's guard knows which rows meant it: `theSettlePredicateKnewWhatToWaitFor` demands a
 * non-empty world only where the row's own `returnTopology` put someone there.
 *
 * READING A RESPONDER IS ALMOST FREE, AND THE EXCEPTION IS NAMED. `sidebar()` is one
 * `document.querySelector` in the page - no request, no console line. `activeGroupIds` is NOT free:
 * it issues a refresh and a groups fetch from the actor's own page. They are raw `fetch` calls in
 * the evaluate context rather than calls through the app's client, so nothing routes them into the
 * app's logger and the actor's observer sees no line - but the requests are real, and a claim that
 * reading a responder costs nothing at all would be false and would hide the next surprise.
 */
async function whatTheWorldCanServe(label) {
  const served = new Set();
  const from = {};
  let owed = null;
  let owedWhy = "the actor is down, so nobody of the subject's account could be asked";
  for (const which of ["W1", "W2"]) {
    if (!(await isUp(which.toLowerCase()))) {
      from[which] = "down";
      continue;
    }
    try {
      const rcx = await client(PORTS[which], new URL(ORIGIN[which]).hostname);
      const seen = await sidebar(rcx);
      if (which === ACTOR) {
        // MEMBERSHIP IS PER USER AND IS ASKED OF THAT USER'S OWN CLIENT. Every device this rung
        // measures - the seed, the returning victim, the reference - belongs to the OWNER, and the
        // actor is the owner's other device, so its answer IS the subject's owed set. Reading it
        // here costs no second connection and no second login.
        const who = await whoAmI(rcx);
        const mine = await activeGroupIds(rcx, who.userId ?? "");
        owed = mine.ids ? new Set(mine.ids) : null;
        owedWhy = mine.why;
      }
      rcx.close();
      const ready = (seen.tiles ?? []).filter((t) => t.id && t.ready && !t.removed);
      for (const t of ready) served.add(t.id);
      from[which] = `${ready.length} ready of ${seen.rows ?? 0}`;
    } catch (e) {
      // A RESPONDER THAT CANNOT BE READ IS NOT A RESPONDER THAT SERVES NOTHING, and the difference
      // has to survive into the record: it shrinks the subset silently, which is the one direction
      // that turns a stall into a PASS. It is reported per client and the caller's guard sees it.
      from[which] = `UNREADABLE: ${firstLine(e)}`;
    }
  }
  // THE PEER'S READY ROWS ARE NOT THE SUBJECT'S OWED ROWS, and the arrival proof cannot tell a row
  // that never came from a row that was never owed. W2 is a DIFFERENT ACCOUNT: at the seed watch it
  // is still up, and its groups would be demanded of a device that will never be a member of them -
  // a 600 s stall reported as a defect. So what the world can serve is narrowed to what the subject
  // is actually owed, and a set that could not be narrowed stays EMPTY and is refused downstream
  // rather than silently widening back to the loose rule.
  const ids = owed ? new Set([...served].filter((id) => owed.has(id))) : new Set();
  from.SUBJECT = owed ? `${owed.size} group(s)` : `UNREADABLE: ${owedWhy}`;
  note(
    `${label}: the world serves ${served.size}, the subject is owed ${owed?.size ?? "?"}, ` +
      `so ${ids.size} group(s) must arrive ${JSON.stringify(from)}`,
  );
  return { ids, from, settledWhen: subsetArrivedAndSettled(ids) };
}

/**
 * Brings the victim back: log in, enter the PIN, wait for the list to appear, watch it settle.
 *
 * It does NOT wipe anything - the point of the row is that REVOCATION did the wiping. If a store
 * survived, this is where it shows, and clearing the origin first would delete the evidence.
 *
 * `beforeTheWatch` RUNS AFTER THE DEVICE IS LOGGED IN AND BEFORE THE WORLD IS READ, and exists for
 * exactly one row. HEAL-REVOKE-7 `--order first` returns with nobody online, which is a PHASE of
 * that row and not the world it is judged in: a device whose account has no other client online can
 * never be served a Welcome, so a watch opened there waits for something nothing could send. The
 * hook is where the isolated phase is observed and then ENDED, so the settle watch that follows
 * runs against a world that can actually answer - and the equality the row asserts is between two
 * devices in the same populated world, which is the only comparison that means anything.
 */
async function comeBack(label, { beforeTheWatch } = {}) {
  // THE OBSERVER GOES UP BEFORE THE LOGIN, BECAUSE THE LOGIN IS THE STEP THAT CAN FAIL. It used
  // to be attached after it, and on 2026-08-29 that left the only interesting console of the run
  // unrecorded: the return reported login ok and landed on /chat, and three milliseconds later the
  // app logged itself out. The row could say the sidebar never came and could not say why, because
  // the sentence that said why was spoken before anyone was listening.
  const cx = await victimCx();
  const observer = await watch(cx, VICTIM);
  note(`${label}: logging the revoked device back in`);
  const login = runScript("login.mjs", ["--device", VICTIM]);
  note(`${label}: login ${JSON.stringify(login)}`);
  const pin = runScript("pin.mjs", ["--device", VICTIM]);
  note(`${label}: pin ${JSON.stringify(pin)}`);
  await ensureChat(cx).catch(() => null);
  const who = await whoAmI(cx);
  note(`${label}: it is now device ${who.deviceId?.slice(0, 8)} of ${who.userId?.slice(0, 8)}`);
  const alone = beforeTheWatch ? await beforeTheWatch(cx) : null;
  const target = await whatTheWorldCanServe(label);
  const w = await watchRows(cx, {
    timeoutMs: SETTLE_MS,
    settledWhen: target.settledWhen,
    log: (m) => console.log(m),
  });
  // THREE OUTCOMES, NOT TWO. A watch that ended on a logout is not a watch that ran out of time,
  // and reporting both as "still syncing" is what made a ten-minute stall read like a slow heal.
  const how = w.settled
    ? `settled in ${w.elapsedMs}ms`
    : w.abandoned
      ? `ABANDONED after ${w.elapsedMs}ms - the client is on ${w.abandoned}, so no sidebar was coming`
      : `still syncing after ${w.elapsedMs}ms`;
  note(`${label}: ${how}`);
  const last = await readAll(cx);
  return { cx, observer, login, pin, who, watch: w, target, last, alone };
}


/**
 * THE ROWS THAT ARE STILL AMBER, BY ID - recorded, never asserted on.
 *
 * The fingerprint carries `syncing` as a COUNT, which answers "did it finish" and nothing else. Two
 * runs of this row in a row ended with exactly two amber rows on every device measured - the seed,
 * the reference, and W1's own sidebar - and the count alone cannot say whether they were the SAME
 * two, which is the difference between a device that is behind and a pair of groups nothing online
 * can serve. Ids are cut to 8 like every other id this rig writes down.
 *
 * It is deliberately OUTSIDE `fingerprint`: the equality gap compares fingerprints field by field,
 * and adding a list to it would change what the row asserts rather than what it records.
 */
const stillAmber = (readout) =>
  (readout.rows?.tiles ?? []).filter((t) => !t.ready).map((t) => t.id);

/**
 * The fingerprint two states are compared on: counts and the server's own view, never names.
 *
 * `serverActive` is in it deliberately. Two sidebars of nine rows are not equal if the server thinks
 * one device is a member of nine groups and the other of eleven - the screens would agree while the
 * devices did not, and it is the second number that says which one is wrong.
 */
const fingerprint = (readout) => ({
  rows: readout.rows.rows,
  ready: readout.rows.ready,
  syncing: readout.rows.syncing,
  removed: readout.rows.removed,
  unhooked: readout.rows.unhooked,
  serverActive: readout.server.active ?? null,
  serverDismissedStillMember: readout.server.dismissedStillMember ?? null,
});

/** The named differences between two fingerprints, so a FAIL says WHICH number moved. */
const differences = (a, b) =>
  Object.keys(a)
    .filter((k) => a[k] !== b[k])
    .map((k) => `${k}: ${a[k]} vs ${b[k]}`);

// ---------------------------------------------------------------------------------------------
// ONE NAMED STARTING POINT (user, 2026-08-25). The victim must be an ENROLLED device holding real
// state before it can be revoked, and "whatever it was doing" is not a starting point. So it is
// minted fresh here: after this, the victim is a device the server has just accepted, with the
// account's groups healed into it - which is the only state from which "it was revoked and came
// back" means anything.
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// THE ACTOR IS A PRECONDITION OF THE ROW, NOT A PARTICIPANT IN IT (user, 2026-08-25: the same
// starting point, whatever happened before). Every step below is performed BY the actor: it creates
// the doomed group, it opens the device panel and revokes the victim, it moves the world while the
// victim is away. A revocation this rig could not perform is not a statement about the wipe, and on
// 2026-08-28 that is precisely what four HEAL-REVOKE rows recorded - W1 was sitting signed out on
// `/login`, `setTopology` called it "already up", and the row failed on the product's behalf.
//
// SO IT IS ASKED BEFORE THE VICTIM IS EVEN MINTED, and refused as INVALID rather than FAIL. Minting
// the victim first would spend a full enrolment and a PIN on a row that cannot be run, and would
// leave a fresh device enrolled with nothing to revoke it.
// ---------------------------------------------------------------------------------------------
note(`bringing the actor ${ACTOR} to ready - it performs every step of this row`);
const actorTopology = await setTopology([ACTOR.toLowerCase()]);
note(`actor topology ${JSON.stringify(actorTopology)}`);
if (actorTopology[`${ACTOR.toLowerCase()}Ready`] !== true) {
  record(row.id, "INVALID", {
    unobservable: `the actor ${ACTOR} could not be brought to ready, so nothing here could revoke the victim or move the world: ${actorTopology[ACTOR.toLowerCase()]}`,
    what: row.what,
    actorTopology,
    timeline,
  });
  // The row is on disk by now - `record` is synchronous - so a kill during the restore
  // costs the fleet and never the measurement.
  await restoreTheFleet();
  process.exit(1);
}

note(`starting point: minting an enrolled ${VICTIM} for the revocation to take away`);
const seeded = await becomeANewDeviceAndConfirm({ report: (s) => note(`newdevice: ${s}`) });
note(
  `seed ${JSON.stringify({
    freshId: seeded.aFreshIdWasMinted,
    enrolled: seeded.enrolled,
    pinOk: seeded.pinOk,
  })}`,
);
if (!seeded.enrolled || !seeded.pinOk) {
  record(row.id, "INVALID", {
    unobservable:
      "the victim could not be brought to an enrolled starting point, so there is nothing to revoke",
    seed: { enrolled: seeded.enrolled, pinOk: seeded.pinOk, login: seeded.landedWithoutAHumanStep },
    what: row.what,
    timeline,
  });
  seeded.cx.close();
  // The row is on disk by now - `record` is synchronous - so a kill during the restore
  // costs the fleet and never the measurement.
  await restoreTheFleet();
  process.exit(1);
}

// The victim's own console, from before the revocation, so the wipe's lines are inside the window.
const seedObserver = seeded.observer;
const seedTarget = await whatTheWorldCanServe("the seeded device");
const seedSettle = await watchRows(seeded.cx, {
  timeoutMs: SETTLE_MS,
  settledWhen: seedTarget.settledWhen,
  log: (m) => console.log(m),
});
note(
  `the seeded device ${seedSettle.settled ? "settled" : "did NOT settle"} in ${seedSettle.elapsedMs}ms`,
);
const seedReadout = await readAll(seeded.cx);
const seedState = fingerprint(seedReadout);
const seedAmber = stillAmber(seedReadout);
note(`seeded state ${JSON.stringify(seedState)} amber=${JSON.stringify(seedAmber)}`);

// A group the victim HOLDS before it is revoked, and that will be deleted while it is away. Row 8's
// whole subject; created for every row because "did a doomed group come back" is worth knowing in all
// of them, and one group costs nothing.
const actorCx = await client(PORTS[ACTOR], new URL(ORIGIN[ACTOR]).hostname);
const actorObserver = await watch(actorCx, ACTOR);
await ensureChat(actorCx);
const doomed = debrisName();
note(`${ACTOR} creates ${doomed} - the group that will be deleted while the victim is away`);
await createGroup(actorCx, doomed, { label: "healrevoke" });

// The victim must actually HOLD it, or "it did not come back" proves nothing.
let heldTheDoomedGroup = false;
for (let i = 0; i < 40 && !heldTheDoomedGroup; i += 1) {
  heldTheDoomedGroup = (await rowNamed(seeded.cx, doomed)).ready;
  if (!heldTheDoomedGroup) await sleep(3000);
}
note(`the victim holds ${doomed}: ${heldTheDoomedGroup}`);

const victimBefore = await whoAmI(seeded.cx);
note(`the victim is device ${victimBefore.deviceId?.slice(0, 8)}`);
/**
 * WHAT THE ROW SPENDS AGAINST THE ACCOUNT'S CAP, READ BEFORE AND AFTER.
 *
 * Every row here revokes a device and enrols another, so each one both frees and spends a slot and
 * the account should come out level. It is read rather than assumed because the cost of being
 * wrong is not a failure but a MISREADING: `register-device` answers a full account with a 400 the
 * client only ever reports as "welcome_request deferred", and five HEAL-NEW rows once blamed the
 * product for a cap the campaign's own debris had filled. Two numbers, one subtraction, no
 * diagnosis needed later.
 */
const slotsBefore = victimBefore.userId ? enrolledDeviceCount(victimBefore.userId) : null;
note(`the account spends ${slotsBefore}/${MAX_DEVICES_PER_USER} device slot(s) before this row`);

// Row 9 only: the victim is taken REALLY offline first - no new request AND no surviving socket, or
// the server could still reach it and the deferral would never be exercised.
let severance = null;
/**
 * THE CUT IS THIS ROW'S ONLY DESTRUCTIVE EFFECT ON THE RIG, AND IT OUTLIVES THE PROCESS.
 *
 * `cutHard` sets `Network.emulateNetworkConditions` on the victim's TARGET, not on this CDP client,
 * so closing the connection does not lift it: a runner that dies between the cut and the restore
 * leaves W3 offline for every check that comes after, and the next row would measure a browser this
 * one broke. So the restore is a NAMED, IDEMPOTENT step, not one statement in the happy path; it
 * runs in a `finally` covering every throw in the window where the link is down, and its
 * outcome is ASSERTED - a teardown nobody checked is a teardown that silently did not happen.
 */
const theLink = { cut: false, lift: null, restoredInMs: null, reachable: null, opinion: null };
const restoreTheLink = async () => {
  if (!theLink.cut) return;
  const at = Date.now();
  await theLink.lift();
  theLink.cut = false;
  /**
   * PROVED BY A REQUEST THAT ARRIVES, NEVER BY `navigator.onLine`.
   *
   * This assertion read the client's own opinion of its connectivity for exactly one run
   * (2026-08-30) - and a captive portal reports `true`, which is why this row refuses that reading
   * everywhere else. `awaitReachable` is `awaitSevered`'s mirror: a same-origin fetch that actually
   * lands. The opinion is still RECORDED beside it, because the two disagreeing would itself be the
   * finding, but it is never what decides.
   */
  theLink.reachable = await awaitReachable(seeded.cx);
  theLink.opinion = await link(seeded.cx).catch((e) => ({ error: firstLine(e) }));
  theLink.restoredInMs = Date.now() - at;
  note(`link restored ${JSON.stringify(theLink)}`);
};

if (row.offline) {
  note("taking the victim really offline, before anything revokes it");
  const armed = await armCut(seeded.cx);
  const theCut = await cutHard(seeded.cx);
  theLink.lift = theCut.restore;
  theLink.cut = true;
  const severed = await awaitSevered(seeded.cx).catch((e) => ({ severed: false, why: firstLine(e) }));
  severance = {
    gatewayBackAfterMs: armed.gatewayBackAfterMs,
    socketsClosed: theCut.socketsClosed,
    severed,
    link: await link(seeded.cx),
  };
  note(`severance ${JSON.stringify(severance)}`);
}

// EVERYTHING FROM HERE TO THE RESTORE RUNS WITH THE VICTIM'S LINK DOWN. For every other row nothing
// was cut and the `finally` is a no-op; `process.exit` in `finishObserved` skips it, which costs
// nothing because the offline branch has already lifted the link by then - idempotently.
/** Hoisted: the non-offline path below the `finally` reads it too. */
let revocation;
try {

  // ---------------------------------------------------------------------------------------------
  // THE REVOCATION
  // ---------------------------------------------------------------------------------------------
  note("revoking the victim from the device panel, through the product path");
  revocation = await revoke(victimBefore.deviceId);
  note(`revocation ${JSON.stringify(revocation)}`);

  // -------------------------------------------------------------------------------------------
  // ROW 9 ENDS HERE, on two samples of the same disk: one while the device cannot be reached, one
  // after a reload with a network. Nothing below applies - the world does not move and no reference
  // device is minted, because what is being measured is the DEFERRAL and not the return.
  // -------------------------------------------------------------------------------------------
  if (row.offline) {
    const offlineWipe = classifyWipe(seeded.cx);
    const whileUnreachable = await deviceResidue(VICTIM, seeded.cx).catch((e) => ({
      error: firstLine(e),
      readable: false,
      empty: false,
    }));
    note(`while unreachable ${JSON.stringify({ wipe: offlineWipe, residue: whileUnreachable })}`);

    /**
     * THE TRIGGER IS A LOGIN, AND THIS ROW ASKED FOR A RELOAD UNTIL 2026-08-30.
     *
     * It failed on `theWipeLandedAfterOneReload`, and the failure was the ROW'S, not the product's.
     * `sessionAuth.ts` has exactly three triggers and every one of them needs a credential or a
     * live socket: the PIN path's `resetRequired`, `isDeviceRevoked` on the vault and biometric
     * login paths, and a `device_revoked` frame re-confirmed against the server before anything is
     * erased. A page load that finds a dead cookie and stops at the gate hits none of them BY
     * DESIGN - wiping there would fire a destructive control with no confirmed server fact behind
     * it, which is the one shape that file exists to refuse.
     *
     * SETTLED BY MEASURING, NOT BY ARGUING. After the reload the victim still held `identityKeys:
     * 1` and two databases fourteen minutes on; one `login.mjs` took it to `identityKeys: 0`. The
     * owner's own definition names the trigger, verbatim (2026-08-23): *"il doit devenir un
     * appareil comme neuf s'il essaie de se reconnecter"* - reconnecting, not reopening. Confirmed
     * by the owner 2026-08-30: the product is the reference and the ROW was re-aimed.
     *
     * BOTH SAMPLES ARE KEPT AND BOTH ARE ASSERTED. Dropping the reload would lose the fact that a
     * reload alone changes nothing, and that fact IS the shape of the deferral.
     */
    note("restoring the network and reloading - this alone must NOT be enough");
    await restoreTheLink();
    await seeded.cx.send("Page.reload");
    // Waited for a STATE the page reaches, not for a duration.
    let whereAfterTheReload = null;
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      whereAfterTheReload = await evaluate(seeded.cx, "location.pathname").catch(() => null);
      if (whereAfterTheReload === "/login") break;
    }
    const afterTheReload = await deviceResidue(VICTIM, seeded.cx).catch((e) => ({
      error: firstLine(e),
      readable: false,
      empty: false,
    }));
    const reloadWipe = classifyWipe(seeded.cx);
    note(
      `after the reload ${JSON.stringify({ where: whereAfterTheReload, residue: afterTheReload, wipe: reloadWipe })}`,
    );

    note("signing the victim back in - THIS is the trigger the product defines");
    const loginExit = runScript("login.mjs", ["--device", VICTIM]);
    const loggedInAt = Date.now();
    let landed = afterTheReload;
    let landedInMs = null;
    let afterWipe = reloadWipe;
    for (let i = 0; i < 20; i += 1) {
      await sleep(3000);
      afterWipe = classifyWipe(seeded.cx);
      landed = await deviceResidue(VICTIM, seeded.cx).catch((e) => ({
        error: firstLine(e),
        readable: false,
        empty: false,
      }));
      if (afterWipe.wipeFinished || afterWipe.wipeIncomplete) {
        landedInMs = Date.now() - loggedInAt;
        break;
      }
    }
    /**
     * THE DURABLE MARKER OF THE OLD INSTALL IS ITS DEVICE ID, NOT AN EMPTY DISK.
     *
     * The wipe and the re-enrolment are ONE act here - the login that erases the device immediately
     * builds a new one - so `residue.empty` is not satisfiable at any moment after it, and
     * asserting it would be asserting a race. `CanariDB_<userId>` cannot discriminate either: same
     * user, same name. What survives the re-enrolment and still separates "wiped" from "kept
     * everything" is the ID - a device that kept its store comes back as ITSELF, and one returned
     * to a fresh install cannot. Measured on W3 2026-08-30 before this was written.
     */
    /**
     * THE RETURN IS A LOGIN *AND* A PIN, BECAUSE THAT IS WHAT THE PRODUCT'S OWN REFUSAL ASKS FOR.
     *
     * The first sign-in wipes the device and then REFUSES it - `LoginFailure('device_revoked')` -
     * with a message that says, in the user's own language, to sign in with the PIN to register as
     * a new device. So a row that stops at the CAS callback has not performed the return the
     * product defines; it has performed half of it and would report the other half missing.
     * Measured on W3 2026-08-30: after one `login.mjs` the profile held no identity at all, and the
     * PIN gate alone took it to an enrolled device with a new id.
     *
     * This asserts no less than before - the new device is still demanded, and the wipe still has
     * to have FINISHED. It only stops asking the product to skip a step it documents.
     */
    const returned = await bringToReady(VICTIM);
    note(`the victim came back ${JSON.stringify(returned)}`);
    const backCx = await victimCx();
    const victimAfter = await whoAmI(backCx).catch(() => ({}));
    const where = await evaluate(backCx, "location.pathname").catch(() => null);
    backCx.close();
    note(
      `after the login ${JSON.stringify({ loginExit, landedInMs, residue: landed, wipe: afterWipe, where, device: victimAfter.deviceId?.slice(0, 8) })}`,
    );

    const slotsAfter = victimBefore.userId ? enrolledDeviceCount(victimBefore.userId) : null;
    note(`the account spends ${slotsAfter}/${MAX_DEVICES_PER_USER} device slot(s) after this row`);

    const offlineExpectations = {
      theVictimHeldTheWorldFirst: seedSettle.settled === true && heldTheDoomedGroup === true,
      /** The cut was real: the far end agrees it cannot reach this client. */
      itWasReallyUnreachable: severance?.severed?.severed === true,
      theServerRecordedTheRevocation: revocation.revoked === true,
      theServerForgotTheDevice:
        revocation.wasAddressable === true && revocation.stillAddressable === false,
      /**
       * THE DEFERRAL, WHICH IS THE ROW. A device that cannot ask must not conclude: wiping here would
       * mean a transport failure had been read as an answer, and every offline user would lose their
       * device. So the state is asserted PRESENT while unreachable, not merely tolerated.
       */
      theWipeWasDeferredWhileUnreachable: whileUnreachable.readable === true &&
        whileUnreachable.empty === false,
      itDidNotClaimToHaveWipedWhileUnreachable: offlineWipe.wipeRan === false,
      /**
       * A RELOAD IS NOT THE TRIGGER, AND THIS ASSERTS THAT RATHER THAN TOLERATING IT.
       *
       * The device comes back, finds a dead session, stops at the gate - and still holds everything,
       * because none of the three triggers in `sessionAuth.ts` fired: each needs a credential or a
       * live socket, so a page load that authenticates nobody confirms nothing. Erasing there would
       * be a destructive control acting on an unconfirmed state, and the row asserts the product
       * REFUSES that. Measured on W3 2026-08-30: fourteen minutes past the reload, `identityKeys: 1`.
       */
      theReloadWasNotEnoughOnItsOwn: afterTheReload.readable === true &&
        afterTheReload.empty === false && reloadWipe.wipeRan === false,
      itStoppedAtTheGateAfterTheReload: whereAfterTheReload === "/login",
      /** And it is not lost either: the first attempt to SIGN IN spends the deferral. */
      theVictimCouldReachTheLoginPath: loginExit.ok === true,
      theWipeRanOnTheLogin: afterWipe.wipeRan === true && afterWipe.wipeFinished === true,
      noWipeStepFailed: afterWipe.wipeIncomplete !== true && afterWipe.stepsFailed === 0,
      /**
       * NAMED SEPARATELY BECAUSE IT IS THE PRODUCT'S OWN ACCUSATION, AND IT WAS BURIED IN A
       * COMPOUND. `wipeFinished` is false whenever a store survives, so the first FAIL said only
       * "the wipe did not finish" about a wipe that had logged, in as many words, `1 store(s)
       * SURVIVED the wipe: CanariDB_...`. A verdict must name what it found - the P1 fixed on
       * 2026-08-30 was two `getStorage()` connections nothing closed, and `deleteDatabase` BLOCKS.
       */
      noStoreSurvivedTheWipe: afterWipe.storesSurvived === false,
      /** The return the product documents is a login AND a PIN; both halves have to land. */
      theVictimCameBackToTheApp: returned.ok === true,
      /**
       * WHAT SURVIVES THE RE-ENROLMENT IS THE ID, WHICH IS WHY THE ROW ASSERTS ON IT.
       *
       * The wipe and the re-enrolment are one act - `login.mjs` builds a fresh device the moment the
       * old one is erased - so an empty disk exists for no observable interval and asserting it
       * would be asserting a race. `CanariDB_<userId>` cannot separate the two installs either:
       * same user, same name. A device that kept its store comes back as ITSELF; one that was
       * really wiped cannot.
       */
      itCameBackAsANewDevice: !!victimAfter.deviceId &&
        victimAfter.deviceId !== victimBefore.deviceId,
      itCameBackAsTheSamePerson: victimAfter.userId === victimBefore.userId,
      bothDiskSamplesWereReallyRead: whileUnreachable.readable === true &&
        afterTheReload.readable === true,
      /**
       * THE RIG IS PUT BACK, AND SAYS SO. This is the only row of the rung that breaks the victim's
       * link, so it is the only one that can hand the next row a browser that reaches nothing.
       * Asserted from a REQUEST THAT ARRIVED, never from `navigator.onLine`: lifting the emulation
       * is the driver acknowledging an order, and the client's opinion of its own connectivity is
       * the one reading this row exists to refuse. The opinion is recorded beside it, not asserted.
       */
      theLinkWasRestored: theLink.cut === false && theLink.reachable?.reachable === true,
      /** Same two guards as the live rows: see the block below. A console nobody read says nothing. */
      theWipeWindowWasActuallyRead: offlineWipe.linesRead > 0 && afterWipe.linesRead > 0,
      theSettlePredicateKnewWhatToWaitFor: seedTarget.ids.size > 0,
      timelineIsStamped: timeline.every((m) => typeof m.at === "number" && typeof m.wall === "string"),
    };
    const offlineMissing = unmet(offlineExpectations);
    const offlineVerdict = offlineMissing.length === 0 ? "PASS" : "FAIL";
    // THE CUT IS FORGIVEN FIRST, AND ONLY HERE. This row severs the victim's link on purpose, so the
    // disconnected fetches and the dead socket that follow are the cut working - and `report` cannot
    // tell a deliberate cut from a real one, so it has to be told. No other row of this rung cuts
    // anything, which is why the forgiveness is at this call site and not around the shared helper.
    const offlineObservers = {
      victim: asTheWipedVictim(ignoringOfflineCut(await report(seedObserver))),
      actor: asTheActor(await report(actorObserver)),
    };
    const offlineDetail = {
      what: row.what,
      seed: {
        deviceId: victimBefore.deviceId,
        settledInMs: seedSettle.settled ? seedSettle.elapsedMs : null,
        waitedFor: seedTarget.ids.size,
      servableFrom: seedTarget.from,
        state: seedState,
        heldTheDoomedGroup,
      },
      slots: { before: slotsBefore, after: slotsAfter, cap: MAX_DEVICES_PER_USER },
      severance,
      link: theLink,
      revocation,
      whileUnreachable: { residue: whileUnreachable, wipe: offlineWipe },
      afterTheReload: { residue: afterTheReload, wipe: reloadWipe, where: whereAfterTheReload },
      afterTheLogin: {
        login: loginExit,
        residue: landed,
        wipe: afterWipe,
        wipedInMs: landedInMs,
        cameBack: returned,
        where,
        deviceId: victimAfter.deviceId,
      },
      timeline,
      unmet: offlineMissing,
      observers: offlineObservers,
    };
    seeded.cx.close();
    actorCx.close();
    await finishObserved(
      row.id,
      offlineVerdict,
      offlineDetail,
      offlineObservers,
      restoreTheFleet,
    );
  }
} finally {
  // THE ONLY EXIT PATH THAT MATTERS HERE IS THE ONE NOBODY PLANNED. The happy path lifted the link
  // above, before the reload it needs; this catches a revocation that threw, a residue read that
  // could not be classified, anything at all - and leaves the rig where the next row expects it.
  await restoreTheLink().catch((e) =>
    console.error(
      `healrevoke: THE LINK COULD NOT BE RESTORED - W3 may still be offline: ${firstLine(e)}`,
    ),
  );
}

// The victim is live, so it should learn this from a frame rather than at a login gate. Either is
// accepted; what is waited for is the wipe.
let wipe = { revocationSeen: false, wipeRan: false, wipeFinished: false };
for (let i = 0; i < 30; i += 1) {
  wipe = classifyWipe(seeded.cx);
  if (wipe.wipeFinished || wipe.wipeIncomplete) break;
  await sleep(4000);
}
note(`the victim's own account of the wipe ${JSON.stringify(wipe)}`);

// THE DISK, NOT THE LOG. Taken here rather than immediately after the wipe on purpose: the loop
// above polls every 4 s, so this sample sits SECONDS past `[RESET] done` - long enough for anything
// still running to have put state back, which is exactly the failure the log cannot report.
const leftBehind = await deviceResidue(VICTIM, seeded.cx).catch((e) => ({
  error: firstLine(e),
  readable: false,
  empty: false,
}));
note(`what the wipe left on the victim ${JSON.stringify(leftBehind)}`);
// THE WIPE'S OWN WINDOW, read before the connection that carries it is closed. It is the only
// observer covering the instant this rung is about, and until 2026-08-29 no verdict looked at it.
const wipeReport = asTheWipedVictim(await report(seedObserver));
seeded.cx.close();

// ---------------------------------------------------------------------------------------------
// ROW 1 ENDS HERE - the disk has been read at the one instant that can answer its question.
// ---------------------------------------------------------------------------------------------
if (row.stopsAtTheWipe) {
  // The doomed group existed only to give the wipe something real to take. Deleting it here keeps
  // the row from leaving debris a sweep has to find later, and its outcome is recorded rather than
  // assumed - a delete that threw is worth one line, and it is not this row's subject.
  const tidied = await deleteGroup(actorCx, doomed).then(
    () => true,
    (e) => {
      note(`tidying ${doomed} threw: ${firstLine(e)}`);
      return false;
    },
  );
  note(`${doomed} tidied away: ${tidied}`);

  const slotsAtTheWipe = victimBefore.userId ? enrolledDeviceCount(victimBefore.userId) : null;
  note(`the account spends ${slotsAtTheWipe}/${MAX_DEVICES_PER_USER} device slot(s) after this row`);

  const wipeExpectations = {
    /** There was something to lose. A wipe measured on an empty device is a vacuous PASS. */
    theVictimHeldTheWorldFirst: seedSettle.settled === true && heldTheDoomedGroup === true,
    /** The order was given, and it landed: the decision is durable AND the effect is visible. */
    theServerRecordedTheRevocation: revocation.revoked === true,
    theServerForgotTheDevice:
      revocation.wasAddressable === true && revocation.stillAddressable === false,
    /** The device obeyed, said so, and finished saying so. */
    theDeviceWipedItself: wipe.wipeRan === true && wipe.wipeFinished === true,
    noWipeStepFailed: wipe.wipeIncomplete !== true && wipe.stepsFailed === 0,
    /**
     * THE PRODUCT'S OWN ACCUSATION, ASSERTED SEPARATELY FROM THE DISK. `[RESET] N store(s) SURVIVED
     * the wipe` is the app naming this row's defect in as many words, and it is not the same claim
     * as an empty disk: the app can say it survived and be right, or say nothing and still have
     * left something a `deleteDatabase` never reached. Two independent witnesses, two lines.
     */
    noStoreSurvivedTheWipe: wipe.storesSurvived === false,
    /**
     * AND THE DISK AGREES - THE ROW ITSELF. One database left is the P1 the user found, not dirt.
     * `localStorage` is NOT asserted at zero: the page writes `PARAGLIDE_LOCALE` back the instant it
     * renders, and a locale is not an identity. A DATABASE is, because nothing re-creates one
     * without an MLS client.
     */
    theWipeLeftNothingOfTheAccount: leftBehind.empty === true,
    theDiskWasActuallyRead: leftBehind.readable === true,
    /** The instrument looked. A zero from a console nobody read is evidence for nothing. */
    theWipeWindowWasActuallyRead: wipe.linesRead > 0,
    theSettlePredicateKnewWhatToWaitFor: seedTarget.ids.size > 0,
    timelineIsStamped: timeline.every((m) => typeof m.at === "number" && typeof m.wall === "string"),
  };
  const wipeMissing = unmet(wipeExpectations);
  const wipeVerdict = wipeMissing.length === 0 ? "PASS" : "FAIL";
  const wipeObservers = {
    victim: wipeReport,
    actor: asTheActor(await report(actorObserver)),
  };
  const wipeDetail = {
    what: row.what,
    slots: { before: slotsBefore, after: slotsAtTheWipe, cap: MAX_DEVICES_PER_USER },
    seed: {
      deviceId: victimBefore.deviceId,
      settledInMs: seedSettle.settled ? seedSettle.elapsedMs : null,
      waitedFor: seedTarget.ids.size,
      servableFrom: seedTarget.from,
      state: seedState,
      stillAmber: seedAmber,
      heldTheDoomedGroup,
    },
    revocation,
    wipe,
    leftBehind,
    world: { held: doomed, tidiedAway: tidied },
    timeline,
    unmet: wipeMissing,
    observers: wipeObservers,
  };
  actorCx.close();
  await finishObserved(row.id, wipeVerdict, wipeDetail, wipeObservers, restoreTheFleet);
}

// ---------------------------------------------------------------------------------------------
// THE WORLD MOVES. Both KINDS of change, because they are repaired by different mechanisms: a
// deletion and a creation are epoch moves no replay can deliver, a message is a ciphertext that can
// be handed over again.
// ---------------------------------------------------------------------------------------------
const born = debrisName();
note(`${ACTOR} creates ${born} while the victim is revoked`);
await createGroup(actorCx, born, { label: "healrevoke" });
note(`${ACTOR} deletes ${doomed} while the victim is revoked`);
const deleted = await deleteGroup(actorCx, doomed).then(
  () => true,
  (e) => {
    note(`deleting ${doomed} threw: ${firstLine(e)}`);
    return false;
  },
);
note(`${doomed} deleted: ${deleted}`);

// ---------------------------------------------------------------------------------------------
// THE RETURN, in the order the row asks for.
// ---------------------------------------------------------------------------------------------
const returnTopology = row.id === "HEAL-REVOKE-7" && order === "first" ? [] : [ACTOR.toLowerCase()];
note(`the return happens with ${returnTopology.join(",") || "nothing"} online`);
const topology = await setTopology(returnTopology);
note(`topology ${JSON.stringify(topology)}`);
// A TOPOLOGY THE RIG FAILED TO ESTABLISH IS NOT A RESULT, AND MUST NOT BECOME ONE. Where this row
// asks for the actor online, it is the only member that can serve a Welcome for the account's
// groups - so a returning device that stalls because nobody was there fails `bothSettled` and
// `theNewGroupArrived`, and the ledger would read that as the product losing a group. The evidence
// already collected is carried into the INVALID rather than thrown away: the revocation and the
// wipe were measured before the return, and both halves stay readable.
if (returnTopology.includes(ACTOR.toLowerCase()) && topology[`${ACTOR.toLowerCase()}Ready`] !== true) {
  record(row.id, "INVALID", {
    unobservable: `the return needs ${ACTOR} online to answer for the account's groups and it could not be brought to ready: ${topology[ACTOR.toLowerCase()]}`,
    what: row.what,
    order,
    revocation,
    wipe,
    leftBehind,
    world: { created: born, deleted: doomed, deletionSucceeded: deleted },
    topology,
    timeline,
  });
  // The row is on disk by now - `record` is synchronous - so a kill during the restore
  // costs the fleet and never the measurement.
  await restoreTheFleet();
  process.exit(1);
}

/**
 * THE ISOLATED PHASE OF `--order first`, AND WHY IT ENDS.
 *
 * The row asks whether the ORDER of the return changes where the device ENDS UP - not whether a
 * device alone in the world can heal, which has one answer and it is no. A Welcome can only be
 * served by another client of the same account, so with none online the sidebar stays amber for as
 * long as it is left there. Judging the pair on that state would compare a healed device against a
 * device nothing was allowed to heal, and report the difference as a product defect: the run of
 * 2026-08-30 did exactly that, stalling at `25 rows, 0 ready, 25 syncing` until the deadline, with
 * three expectations that could not be met by any behaviour of the app.
 *
 * SO THE PHASE IS OBSERVED, ASSERTED ON, AND THEN LIFTED. What the isolation buys is a claim worth
 * making and previously unmade - that a device with no responder heals NOTHING, rather than
 * inventing rows from a store that was supposed to be wiped - and the settle watch then runs in the
 * same populated world the reference is minted into.
 *
 * THE WINDOW IS MEASURED AGAINST THIS WORLD, NOT PICKED. The seed device settled in
 * `seedSettle.elapsedMs` under a world that COULD serve it, minutes earlier and on the same account,
 * so three times that is an interval in which healing would have been seen had anything been able to
 * happen. It scales with the size of the account rather than assuming one, which is what a fixed
 * constant would do. If it were wrong it is wrong LENIENTLY - too short leaves the negative
 * observation trivially true and asserts less, never more - so nothing here can manufacture a
 * failure, and the row's real claim stays the final-state equality.
 */
const aloneFor = Math.max(20_000, 3 * (seedSettle.elapsedMs ?? 0));
const back = await comeBack("return", {
  beforeTheWatch: returnTopology.length > 0
    ? null
    : async (cx) => {
        note(`the return is alone: observing ${aloneFor}ms with nobody able to serve a Welcome`);
        const readout = await watchRows(cx, {
          timeoutMs: aloneFor,
          settledWhen: () => false,
          log: (m) => console.log(m),
        });
        const state = fingerprint(await readAll(cx));
        // A PHASE THAT ENDED ON A LOGOUT IS NOT A PHASE THAT WAS OBSERVED. `ready === 0` is true of
        // a device that healed nothing AND of a device that left /chat two seconds in, and the
        // assertion below cannot tell them apart - so the reason the window ended is recorded, and
        // the trivial pass is visible in the row rather than hidden behind a zero.
        note(`alone after ${readout.elapsedMs}ms${readout.abandoned ? ` (ABANDONED on ${readout.abandoned})` : ""}: ${JSON.stringify(state)}`);
        const lift = [ACTOR.toLowerCase()];
        note(`the isolated phase is over - bringing ${lift.join(",")} online for the settle watch`);
        const lifted = await setTopology(lift);
        note(`topology after the lift ${JSON.stringify(lifted)}`);
        // A LIFT THE RIG FAILED TO PERFORM IS NOT A RESULT EITHER, and it is the same argument as
        // the guard above: without the actor, nothing of this account can answer, and the stall
        // that follows would be written down as the product losing every group.
        if (lifted[`${ACTOR.toLowerCase()}Ready`] !== true) {
          record(row.id, "INVALID", {
            unobservable: `the isolated phase could not be lifted - ${ACTOR} did not come to ready: ${lifted[ACTOR.toLowerCase()]}`,
            what: row.what,
            order,
            revocation,
            wipe,
            leftBehind,
            world: { created: born, deleted: doomed, deletionSucceeded: deleted },
            topology: { atTheReturn: topology, afterTheLift: lifted },
            alone: { forMs: readout.elapsedMs, state },
            timeline,
          });
          await restoreTheFleet();
          process.exit(1);
        }
        return { forMs: readout.elapsedMs, state, lifted, abandonedOn: readout.abandoned ?? null };
      },
});
const returnedState = fingerprint(back.last);
const returnedAmber = stillAmber(back.last);
note(`returned state ${JSON.stringify(returnedState)} amber=${JSON.stringify(returnedAmber)}`);
const doomedAfterReturn = await rowNamed(back.cx, doomed);
const bornAfterReturn = await rowNamed(back.cx, born);
note(
  `after the return: ${doomed} ${JSON.stringify(doomedAfterReturn)}, ${born} ${JSON.stringify(bornAfterReturn)}`,
);
const usability = await navigationCost(back.cx);
note(`usability ${JSON.stringify(usability)}`);
const backReport = asAReturningDevice(await report(back.observer));
back.cx.close();

// ---------------------------------------------------------------------------------------------
// ROW 2 ENDS HERE - "holding nothing from before" is an ABSENCE, and needs nothing to compare with.
// ---------------------------------------------------------------------------------------------
if (row.stopsAtTheReturn) {
  const slotsAtTheReturn = victimBefore.userId ? enrolledDeviceCount(victimBefore.userId) : null;
  note(`the account spends ${slotsAtTheReturn}/${MAX_DEVICES_PER_USER} device slot(s) after this row`);

  const returnExpectations = {
    /** There was something to lose, and something to forget. */
    theVictimHeldTheWorldFirst: seedSettle.settled === true && heldTheDoomedGroup === true,
    theServerRecordedTheRevocation: revocation.revoked === true,
    theServerForgotTheDevice:
      revocation.wasAddressable === true && revocation.stillAddressable === false,
    /** Row 1's claim, re-asserted because everything below rests on it having been true. */
    theWipeLeftNothingOfTheAccount: leftBehind.empty === true,
    theDiskWasActuallyRead: leftBehind.readable === true,
    theDeviceWipedItself: wipe.wipeRan === true && wipe.wipeFinished === true,
    noStoreSurvivedTheWipe: wipe.storesSurvived === false,
    /**
     * TRUE OF A DEVICE THAT KEPT EVERYTHING, AND ASSERTED ANYWAY. A revoked id is blacklisted, so
     * the client cannot reuse it whatever its disk holds - which is exactly why this pair is
     * necessary and not sufficient, and why the two below carry the row.
     */
    itReturnedAsANewDevice: !!back.who.deviceId && back.who.deviceId !== victimBefore.deviceId,
    itReturnedAsTheSamePerson: back.who.userId === victimBefore.userId,
    /**
     * THE BLACKLIST-PROOF HALF. `doomed` was deleted while the device was away, so the server will
     * never serve it and enumeration cannot produce it. A row for it can come from exactly one
     * place: a local store that survived. Its absence is the claim "holding nothing from before",
     * made in the one form the server cannot fake.
     */
    theDeletedGroupDidNotComeBack: doomedAfterReturn.present === false,
    /**
     * AND ITS MIRROR, so the absence above is not simply a device that arrived holding nothing at
     * all. `born` was created while the device was away: it can ONLY have come from enumeration, so
     * a ready row for it says the rebuild really happened rather than merely that the disk was
     * empty. Together they separate "it forgot" from "it never arrived".
     */
    theNewGroupArrived: bornAfterReturn.ready === true,
    /** It finished. An absence measured on a device still arriving is not an absence. */
    itSettled: back.watch.settled === true,
    theSettlePredicateKnewWhatToWaitFor: seedTarget.ids.size > 0 && back.target.ids.size > 0,
    /** The app was navigable while it healed. */
    navigableWhileHealing: usability?.openedInMs != null,
    theWipeWindowWasActuallyRead: wipe.linesRead > 0,
    timelineIsStamped: timeline.every((m) => typeof m.at === "number" && typeof m.wall === "string"),
  };
  const returnMissing = unmet(returnExpectations);
  const returnVerdict = returnMissing.length === 0 ? "PASS" : "FAIL";
  const returnObservers = {
    victim: backReport,
    actor: asTheActor(await report(actorObserver)),
    wipeWindow: wipeReport,
  };
  const returnDetail = {
    what: row.what,
    slots: { before: slotsBefore, after: slotsAtTheReturn, cap: MAX_DEVICES_PER_USER },
    seed: {
      deviceId: victimBefore.deviceId,
      settledInMs: seedSettle.settled ? seedSettle.elapsedMs : null,
      state: seedState,
      heldTheDoomedGroup,
    },
    revocation,
    wipe,
    leftBehind,
    world: { created: born, deleted: doomed, deletionSucceeded: deleted },
    returned: {
      deviceId: back.who.deviceId,
      settledInMs: back.watch.settled ? back.watch.elapsedMs : null,
      stalledForMs: back.watch.settled ? null : back.watch.elapsedMs,
      abandonedOn: back.watch.abandoned,
      waitedFor: back.target.ids.size,
      servableFrom: back.target.from,
      state: returnedState,
      stillAmber: returnedAmber,
      samples: back.watch.samples,
      doomedGroup: doomedAfterReturn,
      newGroup: bornAfterReturn,
    },
    usability,
    topology,
    timeline,
    unmet: returnMissing,
    observers: returnObservers,
  };
  actorCx.close();
  await finishObserved(row.id, returnVerdict, returnDetail, returnObservers, restoreTheFleet);
}

// ---------------------------------------------------------------------------------------------
// THE REFERENCE: a genuinely fresh device, same profile, same world, minutes later. Measured rather
// than looked up, because the number this is compared against has to describe THIS world.
// ---------------------------------------------------------------------------------------------
note("minting a fresh device as the reference the returned device must equal");
const fresh = await becomeANewDeviceAndConfirm({ report: (s) => note(`reference: ${s}`) });
const freshTarget = await whatTheWorldCanServe("the reference");
const freshSettle = await watchRows(fresh.cx, {
  timeoutMs: SETTLE_MS,
  settledWhen: freshTarget.settledWhen,
  log: (m) => console.log(m),
});
note(
  `the reference ${freshSettle.settled ? "settled" : "did NOT settle"} in ${freshSettle.elapsedMs}ms`,
);
const freshReadout = await readAll(fresh.cx);
const freshState = fingerprint(freshReadout);
const freshAmber = stillAmber(freshReadout);
note(`reference state ${JSON.stringify(freshState)} amber=${JSON.stringify(freshAmber)}`);
const doomedOnFresh = await rowNamed(fresh.cx, doomed);
const bornOnFresh = await rowNamed(fresh.cx, born);
note(
  `on the reference: ${doomed} ${JSON.stringify(doomedOnFresh)}, ${born} ${JSON.stringify(bornOnFresh)}`,
);
const freshReport = asAFreshlyMintedDevice(await report(fresh.observer));
fresh.cx.close();

const gap = differences(returnedState, freshState);

// ---------------------------------------------------------------------------------------------
const expectations = {
  /** The starting point was real: an enrolled device that had actually healed. */
  theVictimHeldTheWorldFirst: seedSettle.settled === true && heldTheDoomedGroup === true,
  /**
   * Revocation reached the server, which is TWO claims: the decision is durable (`revoked_device`
   * holds a fresh row) and its effect landed (no member can address the id any more). A row that
   * asserted only the effect would pass on a device that had nothing to purge.
   */
  theServerRecordedTheRevocation: revocation.revoked === true,
  theServerForgotTheDevice: revocation.wasAddressable === true && revocation.stillAddressable === false,
  /** The device obeyed: it said so, and it finished. */
  theDeviceWipedItself: wipe.wipeRan === true && wipe.wipeFinished === true,
  noWipeStepFailed: wipe.wipeIncomplete !== true && wipe.stepsFailed === 0,
  /**
   * AND THE DISK AGREES. One database left is a FAILURE here, not dirt: a device that kept its MLS
   * store has not become a new device, whatever its own log said. The localStorage count is NOT
   * asserted at zero - the page writes `PARAGLIDE_LOCALE` back as soon as it renders - while the
   * databases are, because nothing re-creates one without an MLS client, which was the defect.
   */
  theWipeLeftNothingOfTheAccount: leftBehind.empty === true,
  theDiskWasActuallyRead: leftBehind.readable === true,
  /** It came back as a device the server had never seen - a revoked id must not be reusable. */
  itReturnedAsANewDevice: !!back.who.deviceId && back.who.deviceId !== victimBefore.deviceId,
  itReturnedAsTheSamePerson: back.who.userId === victimBefore.userId,
  /** THE ROW'S POINT: it ended where a fresh device ends. */
  itEndedWhereAFreshDeviceEnds: gap.length === 0,
  /** Both actually finished. An equality between two stalls is not the equality being claimed. */
  bothSettled: back.watch.settled === true && freshSettle.settled === true,
  /** The group deleted while it was away is gone from BOTH, and gone the same way. */
  theDeletedGroupDidNotComeBack: doomedAfterReturn.present === false,
  theDeletedGroupIsAbsentFromTheReferenceToo: doomedOnFresh.present === false,
  /** The group created while it was away arrived on both. */
  theNewGroupArrived: bornAfterReturn.ready === true,
  theNewGroupArrivedOnTheReferenceToo: bornOnFresh.ready === true,
  /** The app was navigable while it healed - the second half of the user's question. */
  navigableWhileHealing: usability?.openedInMs != null,
  /**
   * THE INSTRUMENT LOOKED, AND KNEW WHAT IT WAS LOOKING FOR. Two guards, both written after the run
   * of 2026-08-29 in which neither held and the row reported product defects it had invented:
   * `classifyWipe` was reading a field `report()` does not return - and then, once that was fixed,
   * reading a report that DRAINS from inside a poll, so the run kept the last four seconds of a
   * two-minute wait and said the device had stayed silent; and the settle predicate accepted a
   * device holding three of eleven groups, so the equality gap was measured against a device that
   * had not finished arriving - and the guard added then covered only the VACUOUS half of that
   * second one, an empty subset, leaving the partial-arrival half open until
   * `subsetArrivedAndSettled` closed it. NEITHER FAILURE WAS DISTINGUISHABLE FROM THE PRODUCT
   * FAILING, which is the whole reason they are expectations and not notes: a zero that could mean
   * "silent" or "unread" is evidence for nothing, and a rig that cannot tell the two apart must
   * FAIL rather than pick one. `theWipeWindowWasActuallyRead` is what caught the second one, on its
   * first run.
   */
  theWipeWindowWasActuallyRead: wipe.linesRead > 0,
  // NO EXEMPTION ANY MORE, AND THAT IS THE POINT OF THE FIX. This used to excuse an empty world
  // wherever `returnTopology` was empty, which was `--order first` - and an excused empty world is
  // a watch with nothing to wait for, so the row could only ever end in a stall. The isolated phase
  // is now lifted before the watch opens, so every order reaches this line with a world that can
  // serve, and a subset that is still empty here is a rig fault in any order.
  theSettlePredicateKnewWhatToWaitFor: seedTarget.ids.size > 0 &&
    freshTarget.ids.size > 0 &&
    back.target.ids.size > 0,
  /** Every sample carries both clocks, which is what makes a stall diagnosable off-machine. */
  timelineIsStamped: timeline.every((m) => typeof m.at === "number" && typeof m.wall === "string"),
};

// ROW 3 IS THE ONE THAT ASKS WHETHER A SHORTFALL IS VISIBLE, and it is conditional by construction.
// The user's injury was not a device that ended short - it was a device that ended short and LOOKED
// COMPLETE, so nobody knew to retry. The claim is therefore an implication and not a state: if the
// returned device holds less than the reference, the app must still be saying so, with rows amber.
// On a run with no shortfall it asserts nothing, which is the honest shape - asserting amber rows
// unconditionally would fail every clean run and catch nothing.
if (row.id === "HEAL-REVOKE-3") {
  expectations.aShortfallWasREPORTEDAndNotHidden = gap.length === 0 || returnedAmber.length > 0;
}

// Row 8 is the deletion row, so its own subject must have been set up: a deletion that never
// happened cannot be shown not to come back, and a PASS there would be vacuous.
if (row.id === "HEAL-REVOKE-8") expectations.theDeletionActuallyHappened = deleted === true;

// THE ISOLATED PHASE IS RECORDED AND NOT ASSERTED ON, AND THE REASON IS A PREMISE THAT TURNED OUT
// TO BE FALSE. This carried `nothingHealedWithNobodyOnline` for exactly one run, on the argument
// that a row going ready with no client of ITS ACCOUNT online must have come from a store the wipe
// should have taken - HEAL-REVOKE-1's P1 by a second door. On 2026-08-30 the window ended with ONE
// row of 26 ready, and the assertion failed on it.
//
// THE ROW CANNOT TELL THE TWO CAUSES APART, WHICH IS WHY IT NOW ASSERTS NEITHER. A device can reach
// a group with nobody serving it at all - `externalJoin` on the community's key-distribution group
// is a documented, legitimate self-service path, and the 2/12 ORDER PAIR recorded exactly that
// shape. And a Welcome is owed by A MEMBER, not by another device of yours - the app says so in the
// line it logs, `sendWelcomeRequest… (invited, Welcome owed by a member)` - so any other member of a
// shared conversation can serve one, and killing the account's own clients does not isolate the
// device from them. One ready row is consistent with a legitimate self-join, with a peer member
// answering, and with the defect the assertion was written for. A rig that cannot separate them
// must not pick one, and an assertion resting on a premise this row never established is not a
// weaker test for being removed - it was never a valid one.
//
// What the phase still buys is the MEASUREMENT, which nothing else here takes: how far a returning
// device gets before any of its own devices is back - 1 of 26 in 20 s, against 25 of 26 within
// sixteen seconds of the lift. It goes in the detail with the reason the window ended, and no
// expectation reads it. Naming the self-servable rows is what would make a claim possible here, and
// that is a piece of work, not a line.
void back.alone;

const slotsAfter = victimBefore.userId ? enrolledDeviceCount(victimBefore.userId) : null;
note(`the account spends ${slotsAfter}/${MAX_DEVICES_PER_USER} device slot(s) after this row`);

const missing = unmet(expectations);
const verdict = missing.length === 0 ? "PASS" : "FAIL";

const observers = {
  victim: backReport,
  reference: freshReport,
  actor: asTheActor(await report(actorObserver)),
  wipeWindow: wipeReport,
};
const detail = {
  what: row.what,
  order,
  slots: { before: slotsBefore, after: slotsAfter, cap: MAX_DEVICES_PER_USER },
  seed: {
    deviceId: victimBefore.deviceId,
    settledInMs: seedSettle.settled ? seedSettle.elapsedMs : null,
    waitedFor: seedTarget.ids.size,
    servableFrom: seedTarget.from,
    state: seedState,
    stillAmber: seedAmber,
    heldTheDoomedGroup,
  },
  revocation,
  wipe,
  leftBehind,
  world: { created: born, deleted: doomed, deletionSucceeded: deleted },
  returned: {
    deviceId: back.who.deviceId,
    settledInMs: back.watch.settled ? back.watch.elapsedMs : null,
    stalledForMs: back.watch.settled ? null : back.watch.elapsedMs,
    // WHY IT DID NOT SETTLE, WHEN THE ANSWER IS KNOWN. A stall and a logout are both a null
    // settledInMs, and only one of them is about the sidebar at all.
    abandonedOn: back.watch.abandoned,
    waitedFor: back.target.ids.size,
    servableFrom: back.target.from,
    state: returnedState,
    stillAmber: returnedAmber,
    samples: back.watch.samples,
    doomedGroup: doomedAfterReturn,
    newGroup: bornAfterReturn,
    // Null for every row that never isolated, so a reader can tell "did not apply" from "was zero".
    alone: back.alone
      ? { forMs: back.alone.forMs, state: back.alone.state, abandonedOn: back.alone.abandonedOn }
      : null,
  },
  reference: {
    deviceId: fresh.now?.deviceId ?? null,
    settledInMs: freshSettle.settled ? freshSettle.elapsedMs : null,
    waitedFor: freshTarget.ids.size,
    servableFrom: freshTarget.from,
    state: freshState,
    stillAmber: freshAmber,
    samples: freshSettle.samples,
    doomedGroup: doomedOnFresh,
    newGroup: bornOnFresh,
  },
  // The whole verdict of the row, in one field: which number differs between a returned device and a
  // fresh one. Empty is the PASS.
  equalityGap: gap,
  usability,
  topology: back.alone ? { atTheReturn: topology, afterTheLift: back.alone.lifted } : topology,
  fleetAtTheEnd: (() => {
    try {
      return onlineDevicesOf(victimBefore.userId).map(installTag);
    } catch (e) {
      return [`unreadable: ${firstLine(e)}`];
    }
  })(),
  timeline,
  unmet: missing,
  observers,
};
actorCx.close();
// GATED, NOT MERELY REPORTED - see the note at the foot of `healnew.mjs`. `clean` used to be an AND
// of two booleans computed here, which said nothing about the ACTOR and nothing at all about a
// deploy landing mid-run; `gate()` reads all three observers and outranks the assertion with a
// VACUOUS when the server was replaced underneath it.
await finishObserved(row.id, verdict, detail, observers, restoreTheFleet);
