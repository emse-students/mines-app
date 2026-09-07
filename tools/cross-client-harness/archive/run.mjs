#!/usr/bin/env node
/**
 * THE ONE WAY TO RUN THE CAMPAIGN.
 *
 *   bun run.mjs                      what exists, what is covered, what is not
 *   bun run.mjs MSG                  every script of one phase
 *   bun run.mjs MSG TYPE READ        several phases, in order
 *   bun run.mjs --file msg3.mjs      one script, still with the preflight
 *   bun run.mjs --all                every phase that has a script
 *   bun run.mjs --preflight [W1 A1]  the rig check ALONE, no script, no verdict (default: all three)
 *   bun run.mjs MSG --no-preflight   only when you have just checked the clients yourself
 *   bun run.mjs COMM --without A1  the rows of a phase that do not need a device you cannot use
 *
 * WHY THIS EXISTS. Three things were rediscovered by hand every session, and each of them produced
 * a wrong answer at least once:
 *
 * 1. WHICH SCRIPT COVERS WHAT. The mapping lived in nobody's head twice the same way. It is now in
 *    `checks.mjs`, next to the prerequisites the dashboard states but the scripts never checked.
 *
 * 2. WHETHER THE CLIENTS WERE READY. Almost every "the check does not work" turned out to be a
 *    locked PIN, a client that had dropped off adb, or a phone whose app was in the background - and
 *    none of those FAIL honestly. A locked client answers, renders, and reports on an empty store;
 *    a backgrounded WebView keeps its devtools socket listed and its forward succeeds, while CDP
 *    never answers. So the preflight runs FIRST and refuses to start rather than producing a
 *    verdict nobody should believe.
 *
 * 3. WHAT THE RUN ACTUALLY SAID. Verdicts were read off stdout, which is wrong: several scripts
 *    print a raw observation dump after their verdict, so "the last lines" is not the answer, and a
 *    run of twelve scripts scrolled past. `results.ndjson` is the record; this reads back only the
 *    rows appended after the run started and prints them as one table.
 *
 * Exit code is 1 if anything FAILed or was INVALID, so it can gate something later.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PHASES, devicesFor } from '../checks.mjs';
import { awaitQuiet } from '../deploy.mjs';
import { groupTombstones, sweepDismissed } from './dismiss.mjs';
import { srvLines } from '../estate.mjs';
import { srvReport, srvSummary } from '../srvlog.mjs';
import { client } from '../chat.mjs';
import * as phone from '../phone.mjs';
import { closeExtraAppTabs } from './tabs.mjs';
import { PORTS, VENUE } from '../names.mjs';
import { channelIdOf, communityMemberIds, workspaceIdOf } from '../grainedb.mjs';
import { all, clientBuild } from '../results.mjs';
import { deployedBundleId, isOnTheDeployment, reloadOntoBundle } from '../bundle.mjs';
import { stateOf } from './ready-probe.mjs';
import { bringToReady } from './ready-repair.mjs';
import { requireScript } from '../scriptpath.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);

/**
 * Flags that CONSUME the argument after them, which a bare "not a `--`" filter cannot know about.
 *
 * `bun run.mjs MSG --repeat 3` read `3` as a phase name and refused the whole run - the parser
 * treating a flag's value as a positional. Anything added here must be listed, or it repeats.
 */
const VALUED = ['repeat', 'file', 'without'];

/**
 * Phase names, and NOTHING PAST `--file`, because everything past it belongs to the script.
 *
 * `--file read.mjs --only 10` would otherwise read `10` as a phase name - the same class of fault
 * `VALUED` exists for, one level out. The `--file` branch happens not to consult `named` today, so
 * this changes no behaviour; it is here because the next reader who consults it would be right to,
 * and would be wrong.
 */
const fileAt = argv.indexOf('--file');
const positional = fileAt === -1 ? argv : argv.slice(0, fileAt);
const named = positional.filter(
  (a, i) => !a.startsWith('--') && !VALUED.includes(String(positional[i - 1]).replace(/^--/, ''))
);

/**
 * Where this run's full per-check output goes. ONE DIRECTORY PER RUN, stamped - so re-running a
 * phase to reproduce something never overwrites the capture of the run that raised it, which is the
 * exact loss the whole-output write below exists to prevent.
 *
 * Not the scratchpad: that is scoped to one session, so the next session would find it gone. This
 * lives beside the harness, which is also why it must never be committed - the captures carry real
 * display names.
 */
const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOG_DIR = `${HERE}logs/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
mkdirSync(LOG_DIR, { recursive: true });

/**
 * THE SERVER WINDOW IS A CURSOR OVER THE WHOLE RUN, NOT A WINDOW PER PASS.
 *
 * Each pass used to ask the server about its OWN interval, which leaves the time BETWEEN two passes
 * observed by nobody - and the classifier's one rule for "the fleet was redeployed under this run"
 * (`Listening on http` / `Nest application successfully started`) can only fire on a line that falls
 * inside a window it is given.
 *
 * That gap cost a whole verification on 2026-08-14. A push landed at 16:21, its CD restarted the
 * frontend, the SSR, social, media and chat-delivery at ~16:44 - between pass 2 and pass 3 - and pass
 * 3 opened at 16:45:12 and reported `server clean`. The phone was still recovering from the socket
 * cut, flushed the four sends the outage had queued, and MSG-5/MSG-6 came back dirty against a fleet
 * that had just been replaced under them. Every part of that was visible in the logs; none of it was
 * in any window.
 *
 * So the cursor starts at process start - before the first preflight, which is also work whose noise
 * belongs to somebody - and each pass advances it to where its own report ended. The windows are
 * contiguous by construction, and nothing that happens during the run can fall between two of them.
 */
let serverWindowFrom = new Date().toISOString();

// ---------------------------------------------------------------------------- preflight

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Clears the dead conversation rows this pass left on every client it drove, and NAMES what it
 * cleared - the same contract as `dismissOverlay`, in the same place, for the same reason.
 *
 * WHY IT CANNOT BELONG TO THE PHASE THAT MADE THE MESS, which is the obvious place for it. `grp.mjs`
 * knows exactly which groups it minted and does delete them server-side - and it still left 189 dead
 * rows in the member's store by 2026-08-24. Because the runs that need a teardown are the ones that
 * DIED, and a script that throws never reaches its own last line; `finish` compounds it by exiting on
 * the verdict, so anything after it is unreachable by construction. So the phase DECLARES - and it
 * does: `debris.mjs` is that declaration, enumerated from the runners themselves - while this
 * process, which no script can crash, EXECUTES.
 *
 * WHY IT IS UNCONDITIONAL RATHER THAN OPTED INTO PER PHASE. A per-phase flag is one more thing to
 * keep in sync, and it would be wrong the first time a phase nobody thought about creates a group:
 * DEL, HEAL and MULTI all do. With nothing to clear it costs one store read per client and makes no
 * request at all, so asking first buys nothing.
 *
 * WHY IT RUNS BEFORE THE SERVER REPORT AND CANNOT DIRTY IT: a local dismissal is a purge of this
 * client's own IndexedDB with no request behind it. The SERVER-side half stays a deliberate manual
 * gesture (`cleanup.mjs`) - it DELETES live groups and generates real traffic, which is a decision
 * about the estate rather than a tidy-up of one pass. A row this sweep must spare because its group
 * is still alive server-side is reported by name, so the gesture that is owed is never inferred.
 *
 * A FAILED SWEEP IS REPORTED AND NEVER FATAL. It is housekeeping, not a verdict: debris left behind
 * is debris the next pass's sweep names again, whereas a throw here would take a pass that had
 * already answered its question.
 */
async function sweepDebris() {
  let tombstoned;
  try {
    tombstoned = groupTombstones();
  } catch (e) {
    console.log(`       debris NOT swept - the tombstone query failed: ${String(e.message || e).slice(0, 120)}`);
    return;
  }
  for (const d of devices) {
    let cx = null;
    try {
      cx = await client(PORTS[d], null, { focus: false });
      const r = await sweepDismissed(cx, { tombstoned });
      if (r.dismissed) console.log(`       ${d} dismissed ${r.dismissed} dead conversation row(s)`);
      for (const n of r.failed) console.log(`       ${d} STUCK ${n} - still in the store after the click`);
      for (const row of r.live)
        console.log(`       ${d} LIVE ${row.name} - server-side delete owed, run cleanup.mjs`);
      if (r.remaining) console.log(`       ${d} ${r.remaining} dead row(s) STILL THERE after the sweep`);
    } catch (e) {
      console.log(`       ${d} debris NOT swept: ${String(e.message || e).slice(0, 120)}`);
    } finally {
      cx?.close();
    }
  }
}

/**
 * The campaign's own user ids, filled by the preflight and read by the server observer.
 *
 * Empty until a preflight has run, and `srvReport` treats an empty set as "do not partition" - so a
 * run started with `--no-preflight` judges every line exactly as it did before, rather than
 * forgiving a stranger's traffic on the strength of a list nobody filled.
 */
const SUBJECTS = new Set();

/**
 * Wakes the phone, foregrounds the app and re-derives the devtools forward - and says what it did.
 *
 * IT NEVER THROWS. A phone that is genuinely absent must be reported by the readiness check that
 * follows, with its own hint, and not by this dying first: "adb has no device" and "the app is
 * backgrounded" want completely different fixes and only the second is repairable from here.
 *
 * @returns a sentence for the preflight to print, or '' when there was nothing to do
 */
async function reviveThePhone() {
  const notes = [];
  try {
    phone.sh('svc power stayon usb');
    phone.wake();
    if (!phone.pid()) {
      phone.launch();
      notes.push('the app was not running - launched');
    } else if (!phone.foregrounded()) {
      // A BACKGROUNDED WEBVIEW IS THE FAILURE THIS EXISTS FOR, and `am start` on a running app is a
      // no-op that brings it forward rather than a restart - so nothing is lost by it.
      phone.launch();
      notes.push('the app was in the background - foregrounded');
    }
    const up = await phone.ensure({ port: PORTS.A1, timeoutMs: 20_000 });
    if (!up.ok) notes.push(`devtools still not answering: ${JSON.stringify(up)}`);
    else if (up.reason && notes.length) notes.push(up.reason);
  } catch (e) {
    notes.push(`could not be revived: ${e instanceof Error ? e.message : String(e)}`);
  }
  return notes.join('; ');
}

/**
 * Whether the campaign's SHARED venue is still on production, with its channel and this run's people
 * in it - and it is a PREFLIGHT question because it was not one, and that cost six rows.
 *
 * The shared venue `VENUE` names is a FIXTURE. Twenty-odd runners build their salon inside it rather
 * than minting a community of their own, so it is not one row's setup but the ground every one of
 * them stands on. On 2026-08-25 it was gone from production - cleanly, through the product, by a
 * gesture no log window still covers - and rung 9 discovered it one row at a time: COMM-5, COMM-8,
 * COMM-9/10 and COMM-14 each spent a full cycle to report "the community was never listed", a
 * sentence that reads as a sidebar defect and was a missing fixture. Six rows, forty minutes, and
 * one `SELECT` would have said it before the first click.
 *
 * IT ASKS THE DATABASE, NOT THE SIDEBAR, and the distinction is the whole point. The screen is what
 * the four rows already read, and what it says - an absent row - has three causes it cannot tell
 * apart: the community is gone, this account is not in it, or the list did not load. The table
 * separates the first two outright, and a venue the table confirms while no client can see it is a
 * product defect worth a verdict rather than a rig fault worth refusing over.
 *
 * MEMBERSHIP IS CHECKED AGAINST WHOEVER THIS RUN IS ABOUT, from `SUBJECTS` - which the presence
 * probe above has just filled with the ids the gateway named. An empty set is the `--no-preflight`
 * shape and asserts existence only: a membership claim resting on a list nobody filled would pass
 * for exactly the wrong reason.
 *
 * @returns `{ ok, said }` - `said` is one line for the preflight to print either way, and it names
 *   ids by their first eight characters only, as everything else on this rig does.
 */
function sharedVenue() {
  let workspaceId;
  try {
    workspaceId = workspaceIdOf(VENUE.community);
  } catch (e) {
    // A QUERY THAT DID NOT RUN IS NOT A VENUE THAT IS GONE. Reported as a problem all the same - a
    // preflight that cannot reach the database cannot clear a phase whose rows all read it.
    return { ok: false, said: `the shared venue could not be looked up: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!workspaceId) {
    return {
      ok: false,
      said:
        `the shared venue "${VENUE.community}" IS NOT ON PRODUCTION - every runner that builds its ` +
        'salon inside it will report an unlisted community. Recreate it with its ' +
        `"${VENUE.channel}" channel and both accounts in it before running anything`,
    };
  }
  const channelId = channelIdOf(workspaceId, VENUE.channel);
  if (!channelId) {
    return {
      ok: false,
      said:
        `the shared venue ${workspaceId.slice(0, 8)} exists but has no "${VENUE.channel}" channel - ` +
        'the community survived and its channel did not, which is what a sweep over its salons looks like',
    };
  }
  const roster = communityMemberIds(workspaceId);
  const absent = [...SUBJECTS].filter((id) => !roster.some((member) => member.startsWith(id)));
  if (absent.length > 0) {
    return {
      ok: false,
      said:
        `the shared venue ${workspaceId.slice(0, 8)} has ${roster.length} member(s) and ` +
        `${absent.length} of this run's account(s) are not among them (${absent.join(', ')}) - ` +
        'they must be invited back before any row can open it',
    };
  }
  return {
    ok: true,
    said:
      `${VENUE.community}/${VENUE.channel} is there (${workspaceId.slice(0, 8)}/${channelId.slice(0, 8)}), ` +
      `${roster.length} member(s)`,
  };
}

async function preflight(devices, { quiet = false } = {}) {
  const problems = [];

  // PRODUCTION MUST BE STILL BEFORE A CHECK TOUCHES IT. Prod IS the test server, and a push to
  // `main` restarts every container under whatever is running: on 2026-08-21 a commit touching only
  // `tools/` took out COMM-22's last two cycles, which reported `the salon never appeared in the
  // sidebar` - a sentence about the product, caused by us. `gate()` catches an overlap AFTERWARDS
  // and makes the run VACUOUS, but a run that was never going to count is cheapest not to start.
  //
  // IT WAITS RATHER THAN REFUSING, because the ladder runs unattended: aborting a phase because a
  // deploy was ninety seconds from finishing would cost the whole run for nothing. An answer it
  // cannot get is printed and not treated as quiet - see `deploy.mjs`.
  const quietProd = await awaitQuiet({ log: (l) => console.log(l) }).catch((e) => ({ unknown: e.message }));
  if (quietProd.unknown) console.log(`  ??   production deploy state unknown - ${quietProd.unknown}`);
  else if (quietProd.waitedFor.length)
    console.log(`  ok   production is quiet again after ${Math.round(quietProd.waitedMs / 1000)} s`);

  // WHICH BUNDLE THE WEB CLIENTS ARE RUNNING, asked ONCE and repaired per device below.
  //
  // THE PREFLIGHT READS A1's BUILD AND USED TO ASSUME THE WEB ONES. The block at the end of this
  // function goes to real trouble for the phone, and says why: "the alternative is a whole phase of
  // rows that quietly stop naming the build they ran on". That harm is identical for W1 and W2 - a
  // browser left open across a deploy keeps executing the old bundle - and nothing watched it. On
  // 2026-08-24 it cost a run: two minutes into `GRP --repeat 5`, GRP-3 came back `PASS-DIRTY` on an
  // `[OUTBOX] … evicted from …` line whose spelling had been REPLACED four commits earlier and
  // appears nowhere in the served bundle. The correction looked broken; the client was old.
  //
  // `bundle-id.mjs` HAD DETECTED THIS SINCE THE DAY IT WAS WRITTEN, and its only caller in the whole
  // rig was a sentence in a comment in `reload.mjs`. A detector nothing calls is rule 22 exactly:
  // the file existed, the rule "W1 and W2 must be on the deployed bundle before any measurement" had
  // been stated for days, and the one gate every phase passes through never asked.
  //
  // IT REPAIRS RATHER THAN REFUSING, like every other repair here, and for the same reason: the
  // ladder runs unattended, and a phase abandoned because a browser needed a reload costs the run
  // for nothing. What it will not do is measure - a client that would not move is a `problem`.
  let deployedBundle = null;
  if ([...devices].some(isOnTheDeployment)) {
    try {
      deployedBundle = await deployedBundleId();
    } catch (e) {
      // NOT A SHRUG, for the same reason A1's build is not. Losing the comparison means every
      // browser reads as current for ever, which is worse than having never had the check.
      problems.push(`the deployed bundle id could not be read, so no web client can be told from a stale one: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const d of devices) {
    // ONE APP TAB, AND BEFORE ANY PROBE. Every read below resolves a client by its position among
    // the browser's tabs, so an extra tab is not noise - it is a second device wearing this one's
    // name, and the preflight would report on whichever one happened to be in front. A1 has one page
    // by construction. Rule 5 of `docs/wiki/testing-methodology.md` carries the run this cost.
    if (d !== 'A1') {
      const extra = await closeExtraAppTabs(PORTS[d]).catch(() => 0);
      if (extra) console.log(`  fix  ${d.padEnd(3)} ${extra} extra tab(s) closed - a second app tab is a second MLS client`);
    }

    // THE PHONE IS BROUGHT BACK BEFORE IT IS ASKED ANYTHING, because the state it is usually found
    // in is not a failure - it is asleep. A screen that has gone off is enough to lose A1: Android
    // throttles a WebView whose window is not visible, the abstract devtools socket stays LISTED so
    // `/json/list` answers, and CDP never does - which is precisely the hint below, printed as
    // "unreachable" three times in one session on 2026-08-21 and repaired by hand each time.
    //
    // `svc power stayon usb` IS A DEVICE SETTING, NOT A TIMER. While the cable is in, the screen
    // does not sleep, so the class cannot come back in the middle of a phase - which a `wake()` at
    // the start of each job could not promise. Everything here is idempotent, so a healthy phone
    // pays a few hundred milliseconds and prints nothing.
    if (d === 'A1') {
      const revived = await reviveThePhone();
      if (revived) console.log(`  fix  A1  ${revived}`);

      // ASKED AFTER THE REVIVE, AND NAMED AS A CAUSE. `reviveThePhone` ends in `wake()`, which
      // dismisses a swipe-only keyguard; a keyguard still up after it wants a credential, and no
      // credential is in this repo. So this is the one rig fault the ladder cannot repair, and the
      // only thing worth doing with it is SAYING it - see `phone.deviceLocked` for what a lock does
      // to a WebView, and why every probe downstream of here reports something else.
      const locked = phone.deviceLocked();
      if (locked) problems.push('A1 is behind the DEVICE lock screen - every fetch inside the WebView hangs and the gateway drops it, whatever the probes below say. A human must unlock the phone; `wm dismiss-keyguard` will not.');
      else if (locked === null) console.log('  ??   A1  dumpsys trust would not say whether the device is locked - treating that as unknown, not as unlocked');
    }

    // ONTO THE DEPLOYED BUNDLE BEFORE ANYTHING IS READ, and before the repair loop below - a reload
    // re-mounts the app, so the PIN gate comes back, and that loop is what puts it away again. Doing
    // it after would leave the gate up and read the client as broken.
    //
    // A CLIENT ALREADY CURRENT PAYS ONE CDP CONNECT AND ONE `evaluate`, which is why this can run
    // before every job in a phase rather than once per phase - and it has to, because staleness is a
    // PER-CHECK property: SvelteKit reloads on the next navigation when `version.json` changed, so a
    // client left open across a deploy is stale for an unpredictable PREFIX of a run and correct
    // afterwards. One stamp over two builds is a row that cannot say which check got which.
    if (deployedBundle && isOnTheDeployment(d)) {
      let r = null;
      try {
        const cx = await client(PORTS[d], null, { focus: false });
        try {
          r = await reloadOntoBundle(cx, deployedBundle);
        } finally {
          cx.close();
        }
      } catch (e) {
        // LOGGED, NOT SWALLOWED, AND NOT TRANSLATED. `client()` refuses a browser that is closed and
        // one holding several pages, and `readiness(d)` just below distinguishes those two properly
        // and pushes the authoritative problem - so this says what it could not do and defers.
        console.log(`  ??   ${d.padEnd(3)} could not be asked which bundle it runs: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r?.tookMs === 0) {
        if (!quiet) console.log(`  ok   ${d.padEnd(3)} runs the deployed bundle ${deployedBundle}`);
      } else if (r?.ok) {
        console.log(`  fix  ${d.padEnd(3)} was on ${r.before}, reloaded onto ${deployedBundle} in ${Math.round(r.tookMs / 1000)} s - the PIN gate is back up`);
      } else if (r) {
        problems.push(
          `${d}: stuck on ${r.before} while the deployment serves ${deployedBundle} - it would measure code that is not deployed`
        );
      }
    }

    // ONE CALL, AND THE PROBE AND ITS REPAIRS LIVE IN `ready-probe.mjs` / `ready-repair.mjs` - because a
    // predicate whose only home is a CLI is omitted by every other caller, and `healnew.mjs` proved it
    // by driving a signed-out W1 through an entire row. What stays HERE is what only a run can decide:
    // whether an unready client refuses the phase.
    const r = await bringToReady(d);
    if (r.unreachable) {
      // NOT EVERY FAILURE HERE IS AN ABSENCE. `client()` also refuses a browser holding more than one
      // page, and that wants the opposite fix from "the browser is closed" - so the refusal is passed
      // through verbatim rather than translated into a hint about a cable (rule 6).
      if (/so no tab can be chosen/.test(r.unreachable)) {
        problems.push(`${d}: ${r.unreachable}`);
        continue;
      }
      // A1's own message ("fetch failed") sends the reader to the network rather than to the phone,
      // which is where every one of these has actually been.
      const hint =
        d === 'A1'
          ? ' - phone off adb, app not running, or app in the BACKGROUND (a backgrounded WebView keeps its devtools socket listed and its forward succeeds, and still never answers CDP)'
          : ' - browser closed? `bun launch.mjs start ' + d.toLowerCase() + '`';
      problems.push(`${d}: unreachable on ${PORTS[d]}${hint}`);
      continue;
    }

    const s = r.state;
    if (!r.ok)
      problems.push(
        `${d}: still ${stateOf(s)} on ${s.path} after ${r.trail.length - 1} repair(s) - ${r.trail.join(' -> ')}`
      );
    else if (!s.sidebar) problems.push(`${d}: on ${s.path} with an EMPTY sidebar - nothing has loaded`);
    else if (!quiet) console.log(`  ok   ${d.padEnd(3)} ${s.path} unlocked, ${s.sidebar} sidebar rows`);
  }

  // UNLOCKED IS NOT CONNECTED, and no readiness probe above can tell the difference. MSG-2 spent a
  // run on that gap: a phone that was unlocked, rendering, and holding no socket, whose message
  // arrived on its next reconnect 28 s after the check gave up - a delivery check measuring the
  // transport's absence, and unattributable because nothing had asked. `presence.mjs` asks the
  // GATEWAY, which is the only place that answers for all three clients: a Tauri socket lives in
  // Rust, so the WebView can never be watched for frames.
  const ports = [...devices].map((d) => PORTS[d]).filter(Boolean);
  if (ports.length) {
    // AND IT IS ASKED TO A DEADLINE, because the repairs above are what disconnected the client.
    //
    // Every repair in the loop above ends in a full document navigation, which tears the socket down
    // with the document; a presence read taken immediately after therefore measures OUR OWN repair
    // and not the client. It is a DEADLINE and not a delay, exactly like `settle`: a client that is
    // already connected answers on the first sample and pays nothing.
    //
    // 25 s from the measurement, not from taste: A1 parked on `/communities` (where the PIN gate does
    // not mount, so the repair always fires) was still OFFLINE at 4.9 s and 7.8 s, and back at
    // 10.8 s WITHOUT leaving the page - the route was never the problem, the reconnect cost was. One
    // sample at ~5 s blocked MSG-6/7 on five passes out of five, on a phone that was working.
    const cwd = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const deadline = Date.now() + 25000;
    let r;
    for (;;) {
      r = spawnSync(process.execPath, [requireScript('presence.mjs'), '--ports', ports.join(',')], {
        cwd,
        encoding: 'utf8',
      });
      if (r.status === 0 || Date.now() >= deadline) break;
      await sleep(2000);
    }
    // The LAST attempt only: printing every sample would report a client as absent and present in
    // the same preflight, and the reader has no way to tell which line the verdict rests on.
    for (const line of String(r.stdout || '').trim().split('\n').filter(Boolean)) {
      // A FLEET LINE IS NOT A CLIENT LINE. It names devices of the subject accounts that this run
      // does NOT drive, carries no `ONLINE`, and would otherwise print as `STOP` - reading as a
      // dead client when it is a note about a live stranger. Never quiet: it is the line that makes
      // an `unexplained` `[KICK]` attributable in one read instead of one session.
      if (line.startsWith('FLEET ')) {
        console.log(`  note ${line}`);
        continue;
      }
      const online = /ONLINE/.test(line);
      if (!online || !quiet) console.log(`  ${online ? 'ok  ' : 'STOP'} ${line}`);
      // WHO THIS RUN IS ABOUT, taken from the one place that already knows. The gateway answers with
      // the real user id behind each client, and the server observer needs it to tell our traffic
      // from a stranger's on a SHARED PRODUCTION server. Derived here rather than configured
      // anywhere: a subject list that can go stale is worse than no list, because a stale one
      // forgives the wrong lines.
      const who = /user=([0-9a-f]{6,})/.exec(line);
      if (who) SUBJECTS.add(who[1]);
    }
    if (r.status !== 0) problems.push('at least one client is not connected to the gateway - see the lines above');
  }

  // THE FIXTURE EVERY PHASE STANDS ON, asked once here rather than discovered row by row. See
  // `sharedVenue` for the six rows that paid for this line.
  const venue = sharedVenue();
  if (!venue.ok || !quiet) console.log(`  ${venue.ok ? 'ok  ' : 'STOP'} ${venue.said}`);
  if (!venue.ok) problems.push(venue.said);

  // WHICH BUILD THE PHONE IS RUNNING, read ONCE here and handed to every script this run spawns.
  //
  // The phone is not on the deployment and never will be, so a phase that reads it produces verdicts
  // about a DIFFERENT build from the web ones beside them - and until this existed, only four of the
  // thirty runners said so. See `A1_BUILD` in `results.mjs` for why it lives there and not in each
  // check. Read AFTER the presence deadline on purpose: the repairs above end in a navigation, and a
  // fetch issued into a document being torn down measures the repair.
  //
  // A FAILURE HERE IS A PROBLEM, NOT A SHRUG. The phone answered every readiness probe above, so a
  // static asset it cannot serve means the WebView is not what the preflight just said it was - and
  // the alternative is a whole phase of rows that quietly stop naming the build they ran on.
  // `[...devices]`, NOT `.has`: this function is called with an ARRAY by `--preflight` and with a
  // `Set` by a phase run, and the loops above work on both because they only ever iterate.
  if ([...devices].includes('A1')) {
    try {
      const cx = await client(PORTS.A1, null, { focus: false });
      try {
        const b = await clientBuild(cx);
        process.env.CANARI_A1_BUILD = JSON.stringify(b);
        if (!quiet) console.log(`  ok   A1 runs ${b.commit.slice(0, 8)} built ${b.builtAt}`);
      } finally {
        cx.close();
      }
    } catch (e) {
      problems.push(`A1 would not say which build it is running: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    // A PHASE WITH NO PHONE CARRIES NO STAMP, rather than a stale one from a previous phase in the
    // same process. `--preflight` can be called twice with different device sets.
    delete process.env.CANARI_A1_BUILD;
  }

  return problems;
}

// ---------------------------------------------------------------------------- rig check alone

/**
 * ASKING WHETHER THE RIG IS SANE MUST NOT COST A VERDICT.
 *
 * Until this flag existed, the only way to learn that a client was locked, backgrounded or sitting
 * under a leftover modal was to START a run - which then wrote rows to `results.ndjson` about an
 * instrument that was never in a fit state to measure. That is the wrong order: the answer to "can I
 * measure now" belongs BEFORE the measurement, not inside its record.
 *
 * It repairs what it can, exactly as the in-run preflight does - same function, so the two can never
 * drift into disagreeing about what "ready" means - and exits non-zero on what it cannot.
 */
if (flag('preflight')) {
  const want = named.length ? named : ['W1', 'W2', 'A1'];
  for (const d of want) if (!PORTS[d]) throw new Error(`unknown device ${d} - known: ${Object.keys(PORTS).join(' ')}`);
  console.log(`\nPREFLIGHT (${want.join(' ')})\n`);
  const problems = await preflight(want);
  if (problems.length) {
    console.log('\nNOT FIT TO MEASURE:\n');
    for (const p of problems) console.log(`  ${p}`);
  }
  console.log(`\n  ${problems.length ? 'DO NOT RUN' : 'the rig is ready'}\n`);
  process.exit(problems.length ? 2 : 0);
}

// ---------------------------------------------------------------------------- listing

if (!named.length && !flag('all') && !flag('file')) {
  console.log('\nPHASES\n');
  let covered = 0;
  let bare = 0;
  for (const [name, p] of Object.entries(PHASES)) {
    const n = p.scripts.length;
    if (n) covered++;
    else bare++;
    console.log(
      `  ${name.padEnd(8)} ${String(n).padStart(2)} script(s)  needs ${p.needs.join(' ')}  - ${p.title}` +
        (n ? '' : '   << NO COVERAGE')
    );
  }
  console.log(`\n  ${covered} phase(s) with a script, ${bare} with none.`);
  console.log('\n  bun run.mjs MSG          run a phase');
  console.log('  bun run.mjs --all        run every phase that has a script');
  console.log('  bun run.mjs --file x.mjs run one script');
  console.log('  bun run.mjs --file read.mjs --only 10 --destructive   ... with its own arguments');
  console.log('  bun run.mjs COMM --without A1        the rows that do not need that device');
  console.log('        (run.mjs\'s own flags go BEFORE --file; everything after the script is the script\'s)\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------- selection

let jobs = [];
let devices = new Set();

/**
 * Devices this run must do WITHOUT - `--without A1`, repeatable - and the rows that costs.
 *
 * THE ALTERNATIVE WAS A PHASE THAT COULD NOT RUN AT ALL. A phase's `needs` is the union over its
 * scripts, so one unavailable device refuses all twenty-five COMM rows to protect four. On
 * 2026-08-27 the phone sat behind a device lock screen only its owner can open, with a fix waiting
 * to be measured on the twenty-one rows that never touch it; the honest answer is to run those and
 * say what is still owed, not to run nothing and say nothing.
 *
 * IT IS NOT `--no-preflight` WEARING ANOTHER NAME, and the difference is the whole point. That flag
 * disarms the gate and measures anyway; this one narrows the SELECTION and leaves the gate armed
 * over exactly the devices the remaining rows use. Nothing here is measured on a client the
 * preflight has not cleared.
 *
 * THE SKIPPED ROWS ARE PRINTED, twice - once before the run and once under the results table - and
 * they are NOT written to `results.ndjson`. A phase that quietly ran 21 of 25 would read on the
 * board as a swept rung, which is the failure this whole rig exists to prevent; a row nobody
 * measured has no verdict, not a lenient one.
 */
const WITHOUT = argv.flatMap((a, i) => (a === '--without' ? [String(argv[i + 1] || '').toUpperCase()] : []));
/** @type {{phase: string, script: string, need: string}[]} */
const owed = [];

if (flag('file')) {
  const at = argv.indexOf('--file');
  const f = argv[at + 1];
  if (!f) throw new Error('--file needs a script name');
  // EVERYTHING AFTER THE SCRIPT NAME IS THE SCRIPT'S, and until this existed it was thrown away.
  //
  // A phase entry is a whole command line - `read.mjs --only 10`, `tab236.mjs 2` - and `job.script`
  // is split on spaces where it is spawned, so a phase can pass arguments and `--file` could not.
  // That made every opt-in check UNREACHABLE through the one entry point that preflights: READ-10
  // exists, works, and only runs under `--destructive`, so the only way to reach it was to bypass
  // `run.mjs` - which is how a check came to be run three minutes into a deploy on 2026-08-21 and
  // cost a verdict. An opt-in nobody can opt into through the front door is the DEL-1 fault sitting
  // inside the launcher.
  //
  // `run.mjs`'s own flags must therefore come BEFORE `--file`, and the usage line says so. This is
  // not a parser talking itself into ambiguity: `--only` and `--destructive` belong to the script,
  // `--no-preflight` belongs here, and nothing can tell them apart by shape alone.
  const forwarded = argv.slice(at + 2);
  jobs.push({ phase: '(file)', script: [f, ...forwarded].join(' ') });
  // THE DEVICES COME FROM THE SCRIPT'S OWN PHASE, NEVER FROM A DEFAULT, and the reading of that is
  // `devicesFor` in `checks.mjs` - beside the declaration it reads, and the only copy. `--file` used
  // to preflight W1 and W2 whatever it was about to run, so `--file comm25.mjs` - the one COMM check
  // whose whole subject is a SECOND DEVICE - started against a phone nobody had looked at.
  //
  // A SCRIPT NAME WITH A SPACE IN IT IS A QUOTED ARGUMENT, AND IT USED TO COST THE PREFLIGHT ITS
  // TEETH IN SILENCE. `--file "mut.mjs --only 18"` makes `f` the whole string, which matches no
  // phase, so it fell through to the `['W1','W2']` default - the exact outcome `devicesFor` exists to
  // prevent. It happened on 2026-08-22 and MUT-18 ran with A1 unarmed and unstamped. The guard stays
  // HERE because it is about this parser's own input, not about what a phase declares.
  if (f.includes(' ')) {
    throw new Error(
      `--file takes ONE script name; "${f}" is a quoted argument list. ` +
        `Write it unquoted - the words after the name are forwarded to the script: ` +
        `--file ${f.split(' ')[0]} ${f.split(' ').slice(1).join(' ')}`
    );
  }
  const chosen = devicesFor(f, forwarded);
  // A NAME BELONGING TO NO PHASE SAYS SO. Falling back to the pair is the honest answer, but a silent
  // fallback is indistinguishable from a phase that really does need only two browsers - which is why
  // `devicesFor` returns the phase it resolved rather than only the devices.
  if (chosen.phase === null) {
    console.log(`  note ${f} belongs to no phase in checks.mjs - preflighting W1 W2 by default`);
  }
  for (const d of chosen.devices) devices.add(d);
} else {
  const wanted = flag('all') ? Object.keys(PHASES).filter((p) => PHASES[p].scripts.length) : named;
  for (const name of wanted) {
    const p = PHASES[name];
    if (!p) throw new Error(`unknown phase ${name} - known: ${Object.keys(PHASES).join(' ')}`);
    if (!p.scripts.length) {
      console.log(`  skip ${name}: no script exists for this phase yet`);
      continue;
    }
    for (const s of p.scripts) {
      const [file, ...rest] = s.split(' ');
      const need = devicesFor(file, rest).devices;
      if (WITHOUT.some((d) => need.includes(d))) {
        owed.push({ phase: name, script: s, need: need.filter((d) => WITHOUT.includes(d)).join(' ') });
        continue;
      }
      for (const d of need) devices.add(d);
      jobs.push({ phase: name, script: s });
    }
  }
}
if (WITHOUT.length && flag('file')) {
  throw new Error('--without narrows a PHASE selection; with --file there is one script and it either needs the device or does not');
}
/**
 * The owed rows again, at the END - because the banner above scrolls past a phase of twenty jobs.
 *
 * A reader who sees only the final table must not be able to mistake it for the phase. Printed
 * before BOTH exits, on the same reasoning the blocked and silent lists are.
 */
function remindWhatIsOwed() {
  if (!owed.length) return;
  console.log(`  ${owed.length} row(s) were NOT RUN - this run was without ${[...new Set(owed.map((o) => o.need))].join(' ')}:`);
  for (const o of owed) console.log(`      ${o.phase} ${o.script}`);
  console.log('');
}

if (owed.length) {
  const missing = [...new Set(owed.map((o) => o.need))].join(' ');
  console.log(`\nNOT RUN - ${owed.length} row(s) need ${missing}, which this run is without:\n`);
  for (const o of owed) console.log(`  owed ${o.phase} ${o.script}`);
}
if (!jobs.length) {
  console.log('nothing to run');
  process.exit(0);
}

// ---------------------------------------------------------------------------- go

if (!flag('no-preflight')) {
  console.log(`\nPREFLIGHT (${[...devices].join(' ')})\n`);
  const problems = await preflight([...devices]);
  if (problems.length) {
    console.log('\nREFUSING TO RUN - a check against a client in this state does not fail, it lies:\n');
    for (const p of problems) console.log(`  ${p}`);
    console.log('');
    process.exit(2);
  }
}

/**
 * REPRODUCIBILITY IS A PROPERTY OF A SEQUENCE OF RUNS, AND NOTHING HERE COULD EXPRESS ONE.
 *
 * One green run says the phase passed once. It cannot distinguish "this is stable" from "this check
 * is dirty one time in four", and that difference is the entire question when a fix is being
 * accepted - MSG-1b was clean on its own and dirty after `msg1 --cold`, which no single run of
 * either could have shown.
 *
 * `--repeat N` runs the whole selection N times and prints one row per CHECK with its outcome per
 * pass, so an intermittent one is a row that changes rather than a difference between two scrollbacks
 * nobody diffs. Each pass re-runs the preflight for every script exactly as a lone run does; nothing
 * is skipped to make the repeat cheaper, because a cheaper repeat would measure a different thing.
 */
const repeat = Math.max(1, Number(argv[argv.indexOf('--repeat') + 1]) || 1);
const passes = [];

/**
 * IS THIS PASS PERFECT? Deliberately the SAME notion the cross-pass table below calls `settled`, so
 * a run can never stop on a pass that the table would then print as fine.
 *
 * `bad` could not be reused even though it exists two hundred lines down and looks like the answer:
 * it counts `verdict !== 'PASS'`, and READ-5 and READ-10 are `SKIPPED` BY CONSTRUCTION - one needs a
 * fourth reader, the other `--destructive`. Reusing it would abort every `READ --repeat` at pass 1
 * with forty of forty checks passing above the stop, which is exactly the red a reader learns to
 * skip.
 */
const passClean = (p) =>
  !p.aborted &&
  !p.blocked?.length &&
  !p.crashed &&
  !p.silent?.length &&
  p.server?.clean === true &&
  p.rows.length > 0 &&
  p.rows.every((r) => r.verdict === 'PASS' || r.verdict === 'SKIPPED');

/** The pass that ended the run early, or 0 - the difference between a stop and a full disagreement. */
let stoppedAt = 0;

/**
 * WHICH PASS IS SPEAKING, so its capture is not overwritten by the pass after it.
 *
 * `LOG_DIR` is one directory per RUN, which protects a run from the NEXT run and does nothing at all
 * inside a `--repeat`: every pass wrote `<PHASE>-<script>.log`, so pass 5 destroyed pass 2's output.
 * The passes that need reading are exactly the ones that fail, and a failing pass is always followed
 * by another. Measured 2026-08-22 on FWD x5: `fwd345.mjs` recorded no verdict in passes 2 and 3, and
 * by the time the cross-pass table said so both captures had been replaced by pass 4's and pass 5's.
 * The phase had to be re-run to read what it had already printed once - the exact loss the
 * whole-output write exists to prevent.
 */
let passLabel = '';

/**
 * A LOG FILENAME THAT NAMES THE JOB, not just the script it happens to run.
 *
 * `pass<N>-` fixed one dimension of this and left the other one whole. Ten jobs of a phase that
 * selects its check with `--only N` all resolved to the same `<PHASE>-<script>.log`, so the file on
 * disk was whichever job finished LAST - measured 2026-08-23 on GRP's first run, where six checks
 * errored and one 567-byte file survived for all ten. It is not new and it is not GRP's: every
 * phase driven by `only()` has been doing it since the manifest was written - MUT's twenty-one
 * jobs, READ's ten, MENTION's six, SEARCH's six, TYPE's five.
 *
 * The rule this broke is the one about a predicate that named the LAST incident: the pass prefix
 * was derived from the failure in front of it rather than from what actually distinguishes two
 * captures, which is the whole invocation.
 */
const logSlug = (script) =>
  script
    .replace(/\.mjs\b/g, '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** One character per verdict, and the legend below the table is generated from this same map. */
const CELL = {
  PASS: '.',
  'PASS-DIRTY': 'D',
  SLOW: 'W',
  FAIL: 'F',
  INCONCLUSIVE: 'I',
  CAPTURED: 'C',
  // A DELIBERATE SKIP IS A VERDICT, NOT AN UNKNOWN ONE. READ-5 and READ-10 are skipped by
  // construction - one needs a fourth reader, the other `--destructive` - so they printed `?` on
  // every pass and every READ run ended `NOT REPRODUCIBLE`, exit 1, with 40 of 40 checks passing
  // above it. A red that fires on every run is a red its reader learns to skip, which is the one
  // thing an exit code must never become.
  SKIPPED: 'x',
  // A KNOWN VERDICT MEANING "COULD NOT ARM", which is not the same as `?`. `?` says the legend has
  // no letter for what the check wrote - a fault in this table. `v` says the check ran, found its
  // precondition unmet, and reported that honestly. It is deliberately NOT settled: unlike a skip,
  // nobody decided in advance that it would not run, so a row that is `v` on every pass is a
  // precondition that has silently stopped being satisfiable and must stay visible.
  VACUOUS: 'v',
};

for (let pass = 1; pass <= repeat; pass++) {
  passLabel = repeat > 1 ? `pass${pass}-` : '';
  if (repeat > 1) console.log(`\n${'='.repeat(60)}\nPASS ${pass}/${repeat}\n${'='.repeat(60)}`);
  try {
    passes.push(await runOnce(jobs.map((j) => ({ ...j }))));
  } catch (e) {
    // A PASS THAT CANNOT BE SET UP IS A RESULT OF THAT PASS, NOT THE END OF THE RUN. Everything
    // inside `runOnce` is already isolated - a script that exits non-zero is recorded and the next
    // one starts - but the SETUP around it was not, so anything thrown by the preflight escaped to
    // the top level and killed the process. Measured 2026-08-15: one `timeout on Runtime.enable`
    // between two scripts took passes 3, 4 and 5 of FWD with it, and with them the cross-pass table
    // that is the only thing able to answer "is it reproducible" - the question the repeat exists
    // for. Two clean passes were thrown away to report a fault that belonged to one.
    //
    // Recorded as BLOCKED, which is the word this file already uses for it and means precisely
    // this: the instrument could not be brought to a state where the question is askable. It is not
    // a failure of the application and must never be counted as one.
    const reason = `pass setup threw: ${e?.message || e}`;
    console.log(`\n  PASS ${pass} BLOCKED - ${reason}`);
    passes.push({
      rows: [],
      bad: 1,
      crashed: 0,
      blocked: jobs.map((j) => ({ ...j, blocked: reason })),
      server: null,
      aborted: true,
    });
  }

  /**
   * FAIL-FAST: THE FIRST IMPERFECT PASS ENDS THE RUN (user, 2026-08-25 - "il faut arreter ce run des
   * qu'il y a une erreur, le but c'est de valider parfaitement").
   *
   * A repeat exists to answer "is this reproducible", and one imperfect pass has ALREADY answered the
   * only question the ladder asks of this build: the phase does not pass, so it will be fixed and
   * re-run from pass 1 whatever the remaining passes say. What those passes buy is negative. A check
   * that threw mid-scenario leaves whatever state it was holding - `GRP --repeat 5` on 2026-08-25 ran
   * pass 3 after GRP-8 threw between an add and its cleanup, so pass 3 measured an estate with a
   * leftover group in it and its verdicts describe a fleet nobody configured. The minutes are the
   * smaller half of the cost; the debris is charged to whatever runs next.
   *
   * The table still prints, over the passes that DID run, with `-` for the ones that never did. A
   * stop must name the pass that caused it and must never read as a clean `N/N`.
   */
  if (!passClean(passes.at(-1))) {
    stoppedAt = pass;
    if (pass < repeat) {
      console.log('');
      console.log(
        `  STOPPING AT PASS ${pass}/${repeat} - it was not clean, and the remaining ${repeat - pass} pass(es) would measure a fleet this one left in an unknown state.`
      );
    }
    break;
  }
}

if (repeat > 1) {
  // The per-check view, which is the only one that answers "is it reproducible".
  const ids = [...new Set(passes.flatMap((p) => p.rows.map((r) => r.id)))];
  console.log(`\n${'='.repeat(60)}\nACROSS ${repeat} PASSES\n`);
  let allClean = true;
  for (const id of ids) {
    const cells = passes.map((p) => {
      const row = p.rows.find((r) => r.id === id);
      // MAPPED EXPLICITLY, because `verdict[0]` printed `P` for PASS-DIRTY against a legend that
      // announced `D` - a character in the table that appeared nowhere in the key under it. A
      // reader who trusts the legend reads a dirty pass as an unknown state, and one who trusts the
      // first letter reads it as a pass. Anything unrecognised prints `?` rather than a letter that
      // happens to be first.
      return row ? (CELL[row.verdict] ?? '?') : '-';
    });
    // TWO DIFFERENT COMPLAINTS, KEPT APART. A row whose cells DIFFER is the thing `--repeat` exists
    // to find: an intermittent check. A row that is the same verdict every time is perfectly
    // reproducible and may still be bad - and calling that "not reproducible" sent the reader
    // looking for a flake that was never there.
    const varies = cells.some((c) => c !== cells[0]);
    const settled = !varies && (cells[0] === CELL.PASS || cells[0] === CELL.SKIPPED);
    allClean &&= settled;
    console.log(
      `  ${id.padEnd(20)} ${cells.join(' ')}${
        varies ? '   <-- not reproducible' : settled ? '' : '   <-- every pass, not a flake'
      }`
    );
  }
  // THE SERVER GETS ITS OWN ROW, because it is the one observer no per-check verdict can carry: the
  // containers serve every client at once, so its window belongs to the pass rather than to a check.
  // `-` where the pass never ran: it has no server window at all, and printing `S` there would
  // report a dirty platform on the strength of a measurement nobody took.
  const srvCells = passes.map((p) => (p.aborted ? '-' : p.server?.clean ? '.' : 'S'));
  const srvClean = srvCells.every((c) => c === '.');
  allClean &&= srvClean;
  console.log(`  ${'(server window)'.padEnd(20)} ${srvCells.join(' ')}${srvClean ? '' : '   <-- not clean'}`);
  // `-` is a check that recorded NOTHING on that pass, which is not a pass and must not read as one.
  // Generated from CELL, so the key can never drift from what the cells actually print.
  console.log(
    `\n  ${Object.entries(CELL)
      .map(([v, c]) => `${c} = ${v}`)
      .join('   ')}   S = server not clean   ? = unknown verdict   - = no verdict recorded`
  );
  console.log(`\n  ${allClean
        ? `CLEAN ${repeat}/${repeat}`
        : stoppedAt && stoppedAt < repeat
          ? `STOPPED AT PASS ${stoppedAt}/${repeat} - see the row(s) above`
          : 'NOT REPRODUCIBLE - see the rows above'}\n`);
  remindWhatIsOwed();
  process.exit(allClean ? 0 : 1);
}

remindWhatIsOwed();
const last = passes[0];
process.exit(last.bad || last.crashed || last.blocked.length ? 1 : 0);

async function runOnce(jobs) {
const startedAt = new Date().toISOString();
console.log(`\nRUNNING ${jobs.length} script(s)\n`);

/**
 * THE PREFLIGHT IS A PRECONDITION OF EVERY SCRIPT, NOT AN OPENING CEREMONY.
 *
 * It used to run once, before the first job, and the eleven scripts after that one started from
 * whatever the previous script happened to leave behind. That is not a phase that can be re-run to
 * show a system is healthy - its result depends on the ORDER and on the leftovers, so a green run
 * proves nothing about the next one, which is the whole property being asked for here.
 *
 * It cost a real diagnosis on 2026-08-14: MSG-5 left a dialog open, and MSG-1b, MSG-6/7, MSG-9 and
 * MSG-10 all died inside `ensureChat` pointing at an application that was working perfectly. Four
 * checks accusing the wrong component is worse than four checks not running.
 *
 * So a job whose clients cannot be brought to a known state is BLOCKED and says so, rather than
 * running and producing a verdict about the previous script's mess.
 */
for (const job of jobs) {
  const [file, ...args] = job.script.split(' ');
  if (!flag('no-preflight')) {
    const problems = await preflight([...devices], { quiet: true });
    if (problems.length) {
      job.exit = null;
      job.blocked = problems.join('; ');
      console.log(`  ${job.phase.padEnd(8)} ${job.script.padEnd(22)} BLOCKED - ${job.blocked}`);
      continue;
    }
  }
  process.stdout.write(`  ${job.phase.padEnd(8)} ${job.script.padEnd(22)} `);
  // A SCRIPT THAT RECORDS NOTHING IS INDISTINGUISHABLE FROM ONE THAT PASSED, and only the runner can
  // tell the two apart: `results.mjs` sees the rows a process wrote, never the rows it owed. Counted
  // per job, because the run-wide total below cannot attribute a missing row to the script that
  // failed to write it. Measured 2026-08-16: NINE of the manifest's scripts - `notif.mjs`,
  // `notif7.mjs`, `fwd5.mjs`, `life.mjs`, `tab236.mjs`, `heal.mjs`, `heal-a1.mjs`, `heal-web.mjs`,
  // `grp-traffic.mjs` - computed a verdict, printed it as JSON, and recorded nothing at all. Every
  // one of them exited 0 and every one of them printed `done` here.
  const rowsBefore = all().length;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    // Kept, not discarded: a script that dies says why on stderr, and that sentence is the whole
    // difference between "the app is broken" and "this script points at a port nothing listens on".
    //
    // AND WATCHED WHILE IT RUNS, which is the half that was missing. Every phase script announces
    // its stages on stderr precisely so that a stall is distinguishable from slowness - `notif.mjs`
    // says so in its own header - and this runner then buffered the whole stream to disk and showed
    // nothing until the process closed. So a script that never closes shows NOTHING, ever: on
    // 2026-08-16 two `notif.mjs` runs sat here for FOUR HOURS driving the same browsers as
    // everything else, and were found by listing processes, not by the runner that owned them.
    // A buffer that is only flushed on exit cannot report the one failure that never exits.
    let lastOutputAt = Date.now();
    let lastLine = '';
    const note = (b) => {
      tail += b;
      lastOutputAt = Date.now();
      const lines = String(b).split('\n').filter((l) => l.trim());
      if (lines.length) lastLine = lines[lines.length - 1].slice(0, 120);
    };
    child.stdout.on('data', note);
    child.stderr.on('data', note);

    // THE WATCHDOG BOUNDS SILENCE, NOT WORK. It does not decide anything about the app and never
    // shortens a legitimate wait: NOTIF-10's radio outage is 600 s of deliberate quiet, so the
    // window is set well beyond it, and reaching it means no stage line has been printed for a
    // quarter of an hour - which no check in this rig does on purpose. It ACCUSES rather than
    // retrying: the script is killed and the job is marked, because a runner that quietly restarts
    // a hung script would hide exactly what it exists to surface.
    const STALL_MS = 15 * 60 * 1000;
    const HEARTBEAT_MS = 60 * 1000;
    const heartbeat = setInterval(() => {
      const quietMs = Date.now() - lastOutputAt;
      if (quietMs >= STALL_MS) {
        job.stalled = Math.round(quietMs / 1000);
        console.log(`\n      STALLED - no output for ${job.stalled}s, killing. Last line: ${lastLine || '(none)'}`);
        child.kill('SIGKILL');
        return;
      }
      console.log(`\n      ...${Math.round((Date.now() - lastOutputAt) / 1000)}s quiet | ${lastLine || '(no output yet)'}`);
    }, HEARTBEAT_MS);

    child.on('close', (c) => {
      clearInterval(heartbeat);
      /**
       * THE WHOLE OUTPUT IS KEPT ON DISK, and only the console summary is four lines.
       *
       * It used to be `slice(-4)` and nothing else, so everything a check printed above its last
       * four lines was destroyed at the moment it was read. That is not a small loss: every script
       * dumps its full observation - `stateChanges`, `unexplained`, the console of both clients -
       * AFTER its verdict line, and those buckets are where a temporary trace lands. Measured
       * 2026-08-14: a `LOST frame` reproduced inside a phase run and the instrumentation that
       * existed to explain it had been thrown away by the runner, so the phase had to be re-run
       * one script at a time to read what it had already captured once.
       *
       * `results.ndjson` does not cover this - it records the VERDICT and its condensed dirt, which
       * is a different question from what the clients actually said.
       */
      job.log = `${LOG_DIR}/${passLabel}${String(job.phase)}-${logSlug(job.script)}.log`;
      try {
        writeFileSync(job.log, tail);
      } catch (e) {
        console.log(`\n      (could not write ${job.log}: ${e.message})`);
      }
      job.tail = tail.split('\n').filter((l) => l.trim()).slice(-4).join('\n      ');
      resolve(c);
    });
  });
  job.exit = code;
  job.rows = all().length - rowsBefore;
  // STALLED IS NOT "EXIT null". A killed child reports whatever signal ended it, which reads as an
  // ordinary crash and sends the next reader looking for a bug in the script's last statement. The
  // distinction is the finding: this one never got there.
  //
  // NOR IS "done" THE SAME AS "recorded". A job that exits 0 having written no verdict is reported
  // as what it is, in the column a reader is already looking at, rather than left to be inferred
  // from a verdict table that is short by one line.
  console.log(
    job.stalled
      ? `STALLED after ${job.stalled}s of silence`
      : code !== 0
        ? `EXIT ${code}${job.rows ? '' : ' (and recorded nothing)'}`
        : job.rows
          ? 'done'
          : 'NO VERDICT - exited 0 and recorded nothing'
  );
  if (code !== 0) {
    console.log(`      ${job.tail}`);
    // AND WHERE THE REST OF IT IS. Four lines is a summary, and a crash is exactly the case where
    // the last four are not the informative ones: on 2026-08-20 a libuv abort printed two lines
    // after the real error, so the console showed an assertion in `async.c` and the cause - a 502
    // from the edge - sat in the log file nobody had been told existed.
    console.log(`      full output: ${job.log}`);
  }
}

// ---------------------------------------------------------------------------- teardown

await sweepDebris();

// ---------------------------------------------------------------------------- report

const rows = all().filter((r) => r.at >= startedAt);
console.log(`\nVERDICTS (${rows.length} recorded this run)\n`);

const tally = {};
for (const r of rows) {
  tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const detail =
    r.latencyMs != null ? `${r.latencyMs} ms` : r.elapsedMs != null ? `${r.elapsedMs} ms` : '';
  console.log(`  ${String(r.verdict).padEnd(16)} ${String(r.id).padEnd(20)} ${detail}`);
}
console.log('');
for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${n} ${v}`);

// ANYTHING THAT IS NOT A CLEAN `PASS` IS WORK STILL OWED. This used to match `FAIL|INVALID` only,
// so a phase whose every row was `PASS-DIRTY` or `INCONCLUSIVE` exited 0 and read as finished - and
// the campaign's own rule is that a check counts as passed when the assertions hold AND the run is
// clean. A dirty pass is a defect nobody has looked at yet; an inconclusive one is a check that did
// not run. Neither may let the ladder move up a rung.
const bad = rows.filter((r) => r.verdict !== 'PASS').length;
// A BLOCKED JOB IS NOT A CRASHED ONE AND MUST NOT BE COUNTED AS EITHER PASSING OR FAILING. It never
// ran, so it has no verdict at all, and reporting it separately is the difference between "the app
// misbehaved" and "the instrument could not be brought to a state where the question is askable".
const blocked = jobs.filter((j) => j.blocked);
const crashed = jobs.filter((j) => !j.blocked && j.exit !== 0).length;
if (crashed) console.log(`\n  ${crashed} script(s) exited non-zero - see the tails above.`);
// A JOB THAT RAN, SUCCEEDED, AND RECORDED NOTHING IS THE ONE FAILURE THIS TABLE CANNOT SHOW, because
// its evidence is an ABSENT row and the table is made of rows. It counts against the pass: the phase
// claimed coverage the record cannot support, which is the same debt as a dirty window.
const silent = jobs.filter((j) => !j.blocked && j.exit === 0 && !j.rows);
if (silent.length) {
  console.log(`\n  ${silent.length} script(s) exited 0 without recording a verdict - the record cannot show they ran:`);
  for (const j of silent) console.log(`      ${j.script}`);
}
if (blocked.length) {
  console.log(`\n  ${blocked.length} script(s) never ran - the clients were not in a known state:`);
  for (const j of blocked) console.log(`      ${j.script} - ${j.blocked}`);
}
/**
 * THE THIRD OBSERVER, INSIDE THE LOOP - over THIS pass's window, not a window somebody chose.
 *
 * The bar is that every line is expected "y compris dans les logs web, mobile, et serveur", and two
 * of those three were enforced by the checks themselves while the server was enforced by remembering
 * to run `srvlog.mjs` afterwards with the right `--since`. A bar enforced by memory is not enforced,
 * and it showed: WP-PREFIX-1 had been 404ing on every channel message for as long as the code
 * existed, and no browser or phone could ever have seen it.
 *
 * Each pass gets its OWN answer rather than one widening window in which pass 1's noise never leaves
 * - but the windows are CONTIGUOUS, not one-per-pass: `serverWindowFrom` ends where the previous
 * pass's report ended, so a redeploy landing between two passes is inside one of them. See the
 * comment on `serverWindowFrom` for the run that was lost to that gap.
 */
let server = null;
const windowFrom = serverWindowFrom;
serverWindowFrom = new Date().toISOString();
try {
  // The reader is passed in rather than reached for: `srvlog.mjs` is pure so a CI self-test can take
  // its rule lists, and WHICH ESTATE to read is a fact only `estate.mjs` holds (it follows `SITE`).
  server = srvReport(srvLines, windowFrom, { subjects: [...SUBJECTS] });
  console.log(`SERVER (since ${windowFrom})\n`);
  for (const line of srvSummary(server)) console.log(line);
  console.log(`\n  ${server.clean ? 'server clean' : 'SERVER NOT CLEAN - run srvlog.mjs --since ' + windowFrom + ' for the lines'}`);
} catch (e) {
  // UNREACHABLE IS NOT QUIET. A pass whose server half could not be read has not met the bar, and
  // saying so is the difference between an unmeasured window and a clean one.
  server = { clean: false, unreachable: String(e.message || e).slice(0, 200) };
  console.log(`SERVER UNREADABLE - ${server.unreachable}`);
}

console.log('');
// A dirty SERVER window is a dirty run. It cannot be attributed to one check - the containers serve
// every client at once - so it counts once, against the pass, which is exactly what it is evidence
// about.
return { rows, bad: bad + (server.clean ? 0 : 1) + silent.length, crashed, blocked, silent, server };
}
