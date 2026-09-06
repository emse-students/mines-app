#!/usr/bin/env node
/**
 * DEL-2..10 - deleting a conversation while something else is still happening to it.
 *
 * THE PHASE'S WHOLE SUBJECT IS THE OVERLAP. Deleting a group on a quiet client is DEL-1's business
 * and it has its own runner; every row here arranges for a second operation to be UNFINISHED at the
 * instant the deletion lands, and then asks what became of it. That is why almost every check below
 * opens its window with a cut or a throttle rather than a delay: an overlap a check HOPES for is an
 * overlap that stops happening the day the network gets faster, and the verdict then reads as a pass
 * for a race nobody ran.
 *
 * WHAT THE APP ACTUALLY PROMISES, read off `outbox.ts`, `groupActions.ts` and
 * `useConversations.svelte.ts` rather than guessed:
 *
 *   DELETE is not an MLS operation. `deleteGroupAndBroadcast` deletes the group SERVER-SIDE and the
 *     peers learn of it through `groupMeta.deletedAt` - no commit, no epoch move. So a peer that
 *     cannot reach the server never learns, which is exactly what DEL-5 exploits.
 *   THE OUTBOX HAS THREE DEATHS: `group-deleted` (the group went away under a queued entry) and
 *     `evicted`/`evicted-late` (this device was removed). All three end in `failPermanently`, which
 *     logs, patches the message to `error`, marks the conversation deleted for non-`control` kinds
 *     and DELETES THE ROW. The row leaving the store is the half a log line cannot state, which is
 *     why DEL-2 reads the store as well as the console.
 *   RETIRED IS NOT PURGED. A deletion by the peer leaves the row at `lifecycle: 'removed'` on
 *     purpose, so the UI can explain the absence; "Supprimer localement" is what purges it. Both are
 *     legitimate states and a check that cannot tell them apart is measuring nothing - `idb.mjs`
 *     says so at greater length, and every teardown here dismisses the retired row rather than
 *     leaving it, because that residue is what `dismiss.mjs` exists to sweep.
 *
 * DEL-7 IS HERE AS OF 2026-08-24, and it needs the phone: it kills A1 through `adb` and wakes it.
 * It carries its own SKIP when A1 is not the owner's second device on this cable, and that skip
 * states its reason - `sameAccountAs` answers the question rather than the check assuming it. DEL-1
 * is the one row not here: `del1.mjs` owns it, and both are registered under DEL in `checks.mjs`.
 *
 *   bun del.mjs --only 4
 */
import {
  attachFiles,
  awaitMessage,
  awaitRequest,
  client,
  countMessage,
  ensureChat,
  evaluate,
  openConversation,
  PANE_HAS_CONVERSATION,
  parkConversation,
  PANE_STATE,
  realClick,
  requestSettled,
  sameAccountAs,
  send,
  until,
} from '../chat.mjs';
import { addMember, openGroupSettings } from './addmember.mjs';
import { closeOverlays, createGroup, deleteGroup, dismissLocally, openGroup } from '../groupnav.mjs';
import { armCut, cut, cutHard, throttleUpload } from './net.mjs';
import { errorDetail, mark, record, recordObserved } from '../results.mjs';
import {
  COLD_START_NARRATION,
  consoleLines,
  DELIVERY_CROSSING_NARRATION,
  GROUP_CREATION_NARRATION,
  ignoringExpectedLog,
  ignoringExpectedRefusal,
  ignoringOfflineCut,
  PEER_DELETED_NARRATION,
  report,
  watch,
} from '../watch.mjs';
import { awaitOutboxDrained, conversationRows, groupIdByName, outboxRows } from './idb.mjs';
import { PEER_NAME, PORTS } from '../names.mjs';
import { psql } from '../estate.mjs';
import * as phone from '../phone.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireScript } from '../scriptpath.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { W1, W2 } = PORTS;

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

/** How long an absence is watched before it is called an absence. */
const NEGATIVE_WINDOW_MS = 30_000;

/**
 * W1'S WINDOW WITH THE CREATION OF THIS ROW'S OWN GROUP FORGIVEN - and every row here creates one.
 *
 * `withSharedGroup` opens EVERY check in this file by creating a group on W1 and adding the peer to
 * it, so W1 always emits the two lines `GROUP_CREATION_NARRATION` names: the block-status question
 * every creation path asks before opening a conversation nobody wanted, and the list of devices that
 * got into the staged commit. `grp.mjs` has forgiven them since the phase that provoked them first
 * existed; this file never did, and on 2026-09-05 all TWELVE DEL rows came back `PASS-DIRTY` on that
 * same pair - a whole rung reporting dirt for the setup it performs on itself.
 *
 * IT IS W1 ONLY, AND NOT A WIDER CLASSIFIER. W2 never creates a group here; if the peer's window
 * carries these lines, something created a conversation nobody asked for, and that is a finding.
 *
 * @param {object} o an OBSERVER - a site that already built its own report folds the narration into
 *   its own needle list instead, so no report is ever forgiven twice and no `unmatched` is lost.
 * @param {Array<RegExp|string>} [extra] anything else that particular row provoked on W1
 */
const asCreator = async (o, extra = []) =>
  ignoringExpectedLog(await report(o), [...GROUP_CREATION_NARRATION, ...extra]);

/**
 * The line the outbox emits when a queued entry dies because its group was deleted.
 *
 * FORGIVEN AT THE CALL SITES THAT CAUSE IT, NEVER IN `BENIGN`. `watch.mjs` has no rule for a `text`
 * entry dying on `group-deleted`, on purpose: that is a message the user wrote and will never see
 * sent, and a run that produces one owes an explanation rather than a rule. Two checks here owe
 * exactly that explanation and forgive it by name; every other phase keeps the line accusing.
 */
const OUTBOX_GROUP_DELETED =
  /^\[OUTBOX\] [0-9a-f]{8}… (text|reply|media) entry in [0-9a-f]{8}…, group-deleted - permanent failure$/;

/**
 * THE OWNER'S OTHER DEVICE LEARNING THAT THE OWNER DISMISSED THE GROUP - which is not a peer
 * deletion, and is the very mechanism DEL-7 exists to watch.
 *
 * `exitGroupAndCleanup` records a per-user dismiss on the server precisely so the user's OTHER
 * devices PURGE the conversation instead of showing the "deleted by someone" banner (rules 3 & 5).
 * A1 is a second device of W1's account, so when W1 deletes, A1's discovery finds the dismissal and
 * says this. The row's decider - `lifecycle: purged` rather than `removed` - is that sentence's
 * consequence, so a check that read it as dirt would be calling its own pass condition a defect.
 *
 * Kept a needle and not a `watch.mjs` rule for `PEER_DELETED_NARRATION`'s reason exactly: outside a
 * phase that deletes on purpose, a conversation vanishing because another device of the same account
 * dismissed it is something a reader must be shown.
 *
 * The group NAME is not in the pattern. It is generated per run (`DEL7-...`), so anchoring on it
 * would tie the forgiveness to one fixture, and the shape is what makes the line expected.
 */
const OWN_DEVICE_DISMISS_NARRATION = /\[DISCOVERY\] UI group ".+" dismissed by user - removing/;

/**
 * THE SOLICITATIONS A CLIENT MADE ABOUT `gid` IN `lines` - one entry per ATTEMPT, never per line.
 *
 * DEL-7 AND DEL-8 BOTH ASK "did the client spend the window asking about a group nobody will ever
 * answer for", and both used to answer it by counting every line that mentioned the group and
 * carried `[READD]`, `welcome_request` or `[DISCOVERY]`. That counts NARRATION. One correct,
 * terminating recovery emits three such lines - `attempt starting`, `getGroupMeta -> ok`,
 * `deleted server-side - marking removed` - so a threshold reasoned as "one solicitation is the seam
 * doing its job, only its repetition is the defect" could not be written as a number of lines at
 * all. DEL-7 FAILED twice on 2026-08-27 with `3`, on the BEST behaviour the seam has: `requestReAdd`
 * step 5, terminating on the tombstone in one attempt, in 200ms, never asking again.
 *
 * So the boundary is the ATTEMPT, and two lines mark one each: `attempt starting` is emitted once per
 * `requestReAdd` that got past its own throttle, and `welcome_request sent` once per broadcast.
 * Everything else `[READD]` prints is that attempt's progress. `[DISCOVERY]` is dropped outright -
 * `MLS state kept for X` is the client narrating what it holds, which solicits nobody.
 *
 * Returns the LINES, not a count. A row that fails on a number owes its reader the evidence that
 * number came from, and DEL-7 owed exactly that: `solicitationsInWindow: 3` could not separate one
 * attempt logged three ways from three attempts, and the run was `clean`, so no log survived to
 * settle it by hand.
 */
function solicitationsAbout(gid, lines) {
  const needle = gid.slice(0, 8);
  return lines.filter(
    (l) =>
      l.includes(needle) &&
      (/\[READD\] .+ attempt starting/.test(l) || /\[READD\] welcome_request sent/.test(l))
  );
}

/**
 * One solicitation is the recovery seam doing its job once; only its REPETITION is the defect.
 * Counted in attempts by {@link solicitationsAbout}, so this is a number of ATTEMPTS.
 */
const MAX_SOLICITATIONS = 1;

/** A client and the observer watching it - `grp.mjs`'s twin, and for its reason. */
async function observed(port, label) {
  const cx = await client(port);
  return [cx, await watch(cx, label)];
}

/**
 * Whether a SIDEBAR ROW names this conversation - a visible CONTROL, never `body.innerText`.
 *
 * Copied from `grp.mjs` with its reason intact, because this phase needs it MORE: a deleted group
 * leaves a retired row whose pane still describes it in prose ("cette conversation a ete
 * supprimee"), so the name is in the body on exactly the clients where the answer must be "no".
 */
const lists = (cx, name) =>
  evaluate(
    cx,
    `[].slice.call(document.querySelectorAll('button, [role=button], a, li')).some(function (e) {
      return (e.innerText || '').indexOf(${JSON.stringify(name)}) !== -1 && e.getBoundingClientRect().width > 0;
    })`
  );

/**
 * The list panel's own state, which is NOT the same question as "does a row name this".
 *
 * `hiddenPanel` is the one this file kept answering wrong. On a 411px phone the conversation gets the
 * whole screen and the list is set `display: none` WITH ITS TEN ROWS STILL IN THE DOM, so every row
 * measures zero and `width > 0` reads "no such conversation" on a device that holds it. Read
 * separately from the search because they send their reader to opposite places: one is a layout this
 * file must undo, the other is a group that never arrived.
 */
const LIST_STATE = `JSON.stringify((function () {
  var p = document.querySelector('.sidebar-panel');
  if (!p) return { panel: false, hiddenPanel: false, rowsInDom: 0 };
  var kids = p.querySelectorAll('button, [role=button], a, li');
  var r = p.getBoundingClientRect();
  return {
    panel: true,
    hiddenPanel: kids.length > 0 && r.width === 0,
    rowsInDom: kids.length,
  };
})())`;

/**
 * Waits for `name` to be listed, reporting how long it took - or null if it never was.
 *
 * IT PARKS FIRST, AND THAT IS THE FIX FOR ITS THIRD SIGHTING OF ONE FAULT. A phone left inside a
 * conversation renders no list, so this asked its question of a surface that was not on screen and
 * reported the absence as an answer. `parkConversation`'s own comment already records READ-9 dying
 * that way on 2026-08-21 and `openDM`'s records MUT-18 on 2026-08-22; DEL-7 made it three on
 * 2026-08-27, recording INVALID and blaming the group for never reaching a phone whose sidebar held
 * ten rows the whole time. Each of the two earlier fixes was made at ONE call site, which is why
 * there was a third - so the precondition now lives in the function that CANNOT answer without it.
 *
 * Parking is a no-op outside a conversation and returns a reason rather than throwing on a layout
 * with no back control, so this costs W1/W2 one evaluate and changes nothing about them.
 *
 * `null` STILL MEANS "never listed", and the caller's test is unchanged. What the caller could not
 * do before is say WHY, so the panel's state is logged here at the moment it is known - a bare
 * `null` cannot separate a group that did not arrive from a list that was not rendered, and the
 * campaign has now spent three runs on that exact ambiguity.
 */
async function awaitListed(cx, name, timeoutMs = 45000) {
  await parkConversation(cx).catch(() => null);
  const t0 = Date.now();
  try {
    await until(
      cx,
      `[].slice.call(document.querySelectorAll('button, [role=button], a, li')).some(function (e) {
        return (e.innerText || '').indexOf(${JSON.stringify(name)}) !== -1 && e.getBoundingClientRect().width > 0;
      })`,
      timeoutMs
    );
    return Date.now() - t0;
  } catch {
    const state = await evaluate(cx, LIST_STATE).catch((e) => `unreadable: ${e.message}`);
    console.log(`[del] ${name} never listed on port ${cx.port} in ${timeoutMs}ms - list ${state}`);
    return null;
  }
}

/** Adds the peer to the open group from whatever overlay state the caller is in - `grp.mjs`'s. */
async function addPeer(cx) {
  if (!(await evaluate(cx, `/Quitter le groupe/.test(document.body.innerText)`))) {
    await openGroupSettings(cx);
  }
  return addMember(cx, PEER_NAME, { openSettings: false });
}

/**
 * The row this conversation has in the store on `cx`, as `{ lifecycle }` - or null when PURGED.
 *
 * The three states are this phase's whole vocabulary and two of them render identically: absent from
 * the sidebar can mean retired-and-hidden or purged outright. Only the store separates them.
 */
async function rowOf(cx, name) {
  const { rows } = await conversationRows(cx, { name });
  return rows.length ? rows[0] : null;
}

/**
 * A group shared by W1 and W2 for one check, torn down on BOTH sides whatever happens.
 *
 * THE TEARDOWN IS TWO ESTATES, NOT ONE. `deleteGroup` on the owner clears the server's copy; the
 * PEER keeps a retired row of its own that no server action can reach, and a phase that deletes nine
 * groups without dismissing them leaves the peer nine dead rows only `dismiss.mjs` can sweep - the
 * accumulation filed as P3 on 2026-08-24. Both sides are swept here, and neither may throw: a
 * teardown that fails must not turn a recorded verdict into an ERROR.
 *
 * The group reaching W2 is a PRECONDITION and it throws, deliberately. Every row below measures
 * something crossed between two clients; if the peer never received the group there is no crossing
 * to arrange, and a check that carried on would report a pass for a race it never set up.
 */
async function withSharedGroup(n, w1, w2, fn) {
  const name = mark(`DEL${n}`);
  await closeOverlays(w1);
  await createGroup(w1, name, { label: `del${n}` });
  await openGroup(w1, name, { navigate: false, label: `del${n}` });
  await addPeer(w1);
  await closeOverlays(w1);
  const reachedPeerMs = await awaitListed(w2, name, 60000);
  if (reachedPeerMs === null) {
    throw new Error(`DEL-${n}: the group never reached W2, so there is nothing crossed to measure`);
  }
  try {
    return await fn(name, reachedPeerMs);
  } finally {
    for (const [cx, who] of [
      [w1, 'W1'],
      [w2, 'W2'],
    ]) {
      await closeOverlays(cx).catch(() => {});
      // The owner's delete first; it answers 'not listed' when the check already performed it.
      await deleteGroup(cx, name).catch(() => {});
      // Then the retired row, if this side still shows one. `dismissLocally` needs it OPEN.
      try {
        if (await lists(cx, name)) {
          await openGroup(cx, name, { navigate: false, label: `del${n}-sweep` });
          await dismissLocally(cx, name);
        }
      } catch (e) {
        console.log(`[del] teardown ${who}: ${e.message}`);
      }
    }
  }
}

/**
 * Every `DELETE` this client sent whose URL matches `pattern`, dated from the wire.
 *
 * `requestsSince` CANNOT ANSWER THIS: its predicate receives the URL alone, so a `DELETE` and a
 * `GET` on one path are indistinguishable to it - and DEL-3's premise is precisely that two DELETEs
 * crossed. `wallTime` is seconds, hence the x1000; it is the only clock here belonging to the wire
 * rather than to the harness, which is what makes the interval evidence rather than an impression.
 *
 * MUST BE CALLED BEFORE `report`, which clears `cx.events`.
 */
function deletesSince(cx, pattern, sinceIndex = 0) {
  return cx.events
    .slice(sinceIndex)
    .filter(
      (e) =>
        e.method === 'Network.requestWillBeSent' &&
        e.params?.request?.method === 'DELETE' &&
        pattern.test(e.params.request.url || '')
    )
    .map((e) => ({ url: e.params.request.url, atMs: Math.round(e.params.wallTime * 1000) }));
}

/**
 * DEL-2 - the peer deletes while a message of ours is still in the outbox.
 *
 * "RESOLVES OR FAILS LOUDLY, NEVER A SILENT PERMANENT PENDING" is the board's wording and it names
 * three outcomes rather than two. The one that must not happen is the quiet one: an entry the queue
 * retries for ever at full backoff, invisible because nothing about it is an error. So the assertion
 * is in three parts and the STORE owns the decisive one - the row must be gone. A log line saying
 * "permanent failure" beside a surviving row is the silent pending wearing a loud line's clothes,
 * which is why `idb.mjs` refuses to let a log match stand in for a store read.
 */
async function del2() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withSharedGroup(2, w1, w2, async (name) => {
      const gid = await groupIdByName(w1, name);
      if (!gid) throw new Error('DEL-2: W1 holds no row for the group it just created');

      const marker = mark('DEL2M');
      const severed = await cut(w1);
      await openGroup(w1, name, { navigate: false, label: 'del2-w1' });
      await send(w1, marker);

      // THE PREMISE, ASSERTED RATHER THAN ASSUMED. If the send did not queue, the deletion below
      // races nothing and a PASS would mean the check never ran.
      //
      // AND IT IS WAITED FOR, BECAUSE THE COMPOSER EMPTIES BEFORE THE ROW EXISTS. `send`'s
      // post-condition is an empty box, and `MainChatPage.handleSendChat` clears it SYNCHRONOUSLY
      // while `sendChatMessage` runs on, detached - so the write this reads is still in flight when
      // `send` returns. A single read measured that race and called it a missing feature: DEL-2
      // recorded INVALID on 2026-09-05 with `cutSevered: true` and the outbox database found and
      // EMPTY, on a run where DEL-6 queued four frames offline minutes later. Ten seconds, the
      // campaign's ceiling: an enqueue that needs longer than that is the finding.
      let queued = await outboxRows(w1, gid);
      const queuedBy = Date.now() + 10_000;
      while (queued.rows.length === 0 && Date.now() < queuedBy) {
        await sleep(250);
        queued = await outboxRows(w1, gid);
      }
      if (queued.rows.length === 0) {
        await severed.restore();
        await recordObserved(
          'DEL-2',
          'INVALID',
          {
            group: name,
            why: 'the offline send left no outbox row within 10s, so no queued entry was in flight to delete under',
            cutSevered: severed.severed,
            outboxDatabases: queued.dbs,
          },
          { W1: await asCreator(o1), W2: o2 }
        );
        return false;
      }

      // The peer deletes it while we are still offline, holding that entry.
      await deleteGroup(w2, name);
      await severed.restore();

      const drain = await awaitOutboxDrained(w1, gid);
      const row = await rowOf(w1, name);
      const loud = consoleLines(w1).filter(
        (l) => l.includes('[OUTBOX]') && l.includes('group-deleted - permanent failure')
      );

      const ok = drain.drained && loud.length > 0 && row?.lifecycle === 'removed';
      // TWO FORGIVENESSES, AND THE ORDER IS LOAD-BEARING. `ignoringExpectedLog` recomputes `clean`
      // over `badHttp` and `wsEvents` AS IT FINDS THEM, so the cut must already be forgiven or every
      // disconnected fetch this check performed still counts against the row. The cut goes first.
      const rep = ignoringExpectedLog(ignoringOfflineCut(await report(o1)), [
        ...GROUP_CREATION_NARRATION,
        OUTBOX_GROUP_DELETED,
        PEER_DELETED_NARRATION,
      ]);
      await recordObserved(
        'DEL-2',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          queuedWhileOffline: queued.rows.length,
          outboxDrained: drain.drained, // THE DECIDER: the row LEFT the store, it was not parked
          outboxTookMs: drain.tookMs,
          outboxAttemptsGrew: drain.attemptsGrew, // a still-retrying entry says so here
          outboxRowsLeft: drain.last,
          permanentFailureLogged: loud.length, // LOUD: the other half of "never silent"
          lifecycleOnSender: row ? row.lifecycle : 'purged',
          cutSevered: severed.severed,
        },
        { W1: rep, W2: o2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * DEL-3 - both peers delete the same conversation within a second of each other.
 *
 * THE CROSSING IS THE PREMISE AND IT IS MEASURED, not arranged and trusted. Two `deleteGroup`
 * gestures started together do not produce two crossing DELETEs: each opens a panel and clicks
 * twice first, and either side can stall on a render. So both requests are dated from the WIRE and
 * the interval is the check's own evidence - a gap too wide to be a crossing makes the row INVALID
 * rather than a pass, because a sequential pair of deletions is DEL-1 run twice.
 *
 * BOTH MEMBERS MAY DELETE, and that was checked rather than assumed: `ChatGroupPanel.svelte` gates
 * the control on nothing but the handler being provided - no creator test, no admin test. Had it
 * been creator-only this row would be unplayable as written, and saying so would have been the
 * finding.
 *
 * THE SECOND DELETE IS EXPECTED TO FIND NOTHING and that is the point: `groupActions.ts` logs
 * `not found on server (already deleted?)` and treats it as success, which is the only way a
 * concurrent pair can both end cleanly. That line is forgiven by name, on both sides.
 */
async function del3() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withSharedGroup(3, w1, w2, async (name) => {
      const gid = await groupIdByName(w1, name);
      await openGroup(w2, name, { navigate: false, label: 'del3-w2' });
      const from1 = w1.events.length;
      const from2 = w2.events.length;

      // Both gestures at once. `deleteGroup` waits for the name to leave its own DOM, so a rejection
      // is one side failing to complete - recorded as itself, never thrown away.
      const outcomes = await Promise.allSettled([deleteGroup(w1, name), deleteGroup(w2, name)]);

      const d1 = deletesSince(w1, /\/api\/mls\/groups\//, from1);
      const d2 = deletesSince(w2, /\/api\/mls\/groups\//, from2);
      const msBetweenDeletes = d1.length && d2.length ? Math.abs(d1[0].atMs - d2[0].atMs) : null;

      await sleep(NEGATIVE_WINDOW_MS);
      const stillOn1 = await lists(w1, name);
      const stillOn2 = await lists(w2, name);

      // BOTH SIDES NARRATE THE OTHER'S DELETION HERE, and that is the crossing itself being
      // reported - the one line that proves each client learnt of a deletion it did not perform.
      // Forgiven for exactly the reason `PEER_DELETED_NARRATION` states, on both handles.
      const forgive = [
        /^\[DELETE\] Group [0-9a-f]{8}\.\.\. not found on server \(already deleted\?\)$/,
        PEER_DELETED_NARRATION,
      ];
      // W1 also created the group, which W2 did not - so the creation narration goes on this
      // handle alone and never into `forgive`, which both sides share.
      const rep1 = ignoringExpectedLog(await report(o1), [...forgive, ...GROUP_CREATION_NARRATION]);
      const rep2 = ignoringExpectedLog(await report(o2), forgive);

      // A CROSSING, OR NOTHING WAS TESTED. Both sides must really have asked the server, close
      // enough together that the second could still meet the first's effect.
      const crossed = msBetweenDeletes !== null && msBetweenDeletes <= 5000;
      const bothSettled = outcomes.every((o) => o.status === 'fulfilled');
      const ok = crossed && bothSettled && stillOn1 === false && stillOn2 === false;

      await recordObserved(
        'DEL-3',
        crossed ? (ok ? 'PASS' : 'FAIL') : 'INVALID',
        {
          group: name,
          groupId: gid ? gid.slice(0, 8) : null,
          msBetweenDeletes, // THE PREMISE: null or wide means the pair never crossed
          deletesFromW1: d1.length,
          deletesFromW2: d2.length,
          gestureOutcomes: outcomes.map((o) =>
            o.status === 'fulfilled' ? o.value : `rejected: ${o.reason?.message}`
          ),
          resurfacedOnW1: stillOn1,
          resurfacedOnW2: stillOn2,
          negativeWindowMs: NEGATIVE_WINDOW_MS,
          ...(crossed
            ? {}
            : { why: 'the two deletions did not cross, so this was DEL-1 performed twice' }),
        },
        { W1: rep1, W2: rep2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * DEL-4 - delete a conversation while its media is still uploading.
 *
 * THE WINDOW IS ARITHMETIC, NOT A HOPE. On a real link the fixtures this rig ships (398 B, 7 kB) are
 * uploaded before the next gesture lands, so the overlap would be pure luck - and `msg4.mjs`, which
 * performs the same gesture, deliberately WAITS for the staging tray to clear. This check must not:
 * that wait is the window. So a file is generated at a known size and the upload capped at a known
 * rate, which makes the time the request stays open a number the check can state before it runs.
 *
 * "NO ORPHAN BLOB LEFT ADDRESSABLE" has two honest endings and they are not the same finding. If the
 * request never completed, nothing was minted and there is nothing to orphan. If it DID complete, an
 * id exists on the server for a conversation that no longer does, and the question becomes whether
 * that id still answers - so the id is read back and asked for. When it cannot be captured the row is
 * INVALID: "we could not look" is not "there was nothing there".
 */
async function del4() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  const dir = mkdtempSync(join(tmpdir(), 'del4-'));
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withSharedGroup(4, w1, w2, async (name) => {
      // A PNG the composer accepts (`image/*`), big enough that the cap below holds it open.
      const BYTES = 1024 * 1024;
      const RATE = 48 * 1024;
      const file = join(dir, 'del4-large.png');
      writeFileSync(
        file,
        Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(BYTES - 8, 0x7a)])
      );

      const capped = await throttleUpload(w1, RATE);
      await openGroup(w1, name, { navigate: false, label: 'del4-w1' });
      const from = w1.events.length;
      await attachFiles(w1, [file]);
      await until(w1, `document.body.innerText.indexOf('EN ATTENTE') !== -1`, 20000);

      await realClick(w1, '.chat-composer-editor');
      await evaluate(w1, `document.querySelector('.chat-composer-editor').focus()`);
      await w1.send('Input.insertText', { text: mark('DEL4M') });
      // Fire and DO NOT wait for the tray to clear - the whole check lives inside that wait.
      await realClick(w1, 'text=Envoyer le message');

      const req = await awaitRequest(w1, /\/api\/media\/upload/, from, 30000);
      const deletedWhileInFlight = req !== null && !requestSettled(w1, req);

      await deleteGroup(w1, name);
      await capped.restore();

      // Did the upload finish anyway? If it did, the id it minted must no longer answer.
      let mediaId = null;
      let readBackStatus = null;
      const finished = req !== null && requestSettled(w1, req);
      if (finished) {
        const body = await w1
          .send('Network.getResponseBody', { requestId: req })
          .then((r) => r?.body ?? null)
          .catch(() => null);
        try {
          mediaId = body ? (JSON.parse(body).mediaId ?? null) : null;
        } catch {
          mediaId = null;
        }
        if (mediaId) {
          readBackStatus = Number(
            await evaluate(
              w1,
              `fetch('/api/media/' + ${JSON.stringify(mediaId)}, { cache: 'no-store' })
                 .then(function (r) { return r.status; }, function () { return 0; })`
            )
          );
        }
      }

      // The endings, kept apart. Nothing minted is a pass; a minted id still answering 2xx is the
      // orphan the row forbids; a minted id we could not read back is not an answer at all.
      const verdict = !deletedWhileInFlight
        ? 'INVALID'
        : !finished
          ? 'PASS'
          : mediaId === null
            ? 'INVALID'
            : readBackStatus !== null && readBackStatus >= 400
              ? 'PASS'
              : 'FAIL';

      // THE PEER LEARNT OF A DELETION THIS CHECK PERFORMED ON PURPOSE - see `PEER_DELETED_NARRATION`.
      const peerRep = ignoringExpectedLog(await report(o2), [PEER_DELETED_NARRATION]);
      await recordObserved(
        'DEL-4',
        verdict,
        {
          group: name,
          bytes: BYTES,
          uploadCapBytesPerSecond: RATE,
          expectedWindowMs: Math.round((BYTES / RATE) * 1000), // the arithmetic, stated
          uploadRequestSeen: req !== null,
          deletedWhileUploadInFlight: deletedWhileInFlight, // THE PREMISE
          uploadCompletedAnyway: finished,
          mediaIdMinted: mediaId ? mediaId.slice(0, 8) : null,
          orphanReadBackStatus: readBackStatus, // >= 400 is the answer the row wants
          ...(deletedWhileInFlight
            ? {}
            : {
                why:
                  req === null
                    ? 'no upload request was ever observed, so there was nothing in flight to delete under'
                    : 'the upload had already settled when the deletion landed - no overlap existed',
              }),
          ...(finished && mediaId === null
            ? {
                whyInvalid:
                  'the upload completed but its mediaId could not be read, so addressability was never tested',
              }
            : {}),
        },
        { W1: await asCreator(o1), W2: peerRep }
      );
      return verdict === 'PASS';
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * DEL-5 - we delete; the peer, who never learnt of it, sends into the group anyway.
 *
 * THE PEER MUST NOT LEARN, and that is arranged rather than hoped for. A deletion is server-side, so
 * a client that cannot reach the server keeps believing the group is live. `armCut` FIRST - it
 * reloads, so it belongs at the top of the check - then `cutHard`, because a deletion notice arrives
 * down a socket that `emulateNetworkConditions` leaves open; `net.mjs` records the measurement that
 * settled that, a client "taken offline" still refreshing its presence a minute later.
 *
 * "DROPPED WITHOUT A DECRYPT-FAILURE MARKER" is the assertion, and the marker half is the one worth
 * having. A frame for a group we deleted is a frame we hold no state for, so the wrong way to handle
 * it is to try anyway and log a crypto failure - noise a reader learns to skip, behind which the
 * next real decryption defect hides.
 */
async function del5() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    await armCut(w2);
    await ensureChat(w2);
    return await withSharedGroup(5, w1, w2, async (name) => {
      await openGroup(w2, name, { navigate: false, label: 'del5-w2' });
      const severed = await cutHard(w2);

      // W1 deletes while W2 cannot possibly hear about it.
      await deleteGroup(w1, name);

      const marker = mark('DEL5M');
      await send(w2, marker);
      await severed.restore();
      await sleep(NEGATIVE_WINDOW_MS);

      const arrivedOnW1 = Number(await countMessage(w1, marker)) > 0;
      const listedOnW1 = await lists(w1, name);
      const decryptFailures = consoleLines(w1).filter((l) =>
        /decryption failed|generation out of bounds|Crypto\/OpenMLS/i.test(l)
      );

      const ok = !arrivedOnW1 && listedOnW1 === false && decryptFailures.length === 0;
      // The peer's own queued entry dies once it is back: it wrote into a group that is gone. That is
      // the CORRECT outcome of this check, so it is forgiven on W2 and reported in the detail.
      // AND THE PEER ASKED ABOUT A GROUP IT COULD NOT YET KNOW WAS GONE, which is the one shape in
      // this phase that is neither a defect nor forgivable anywhere else. W2 is CUT while W1
      // deletes, so it comes back holding a live row for a group the server has soft-deleted and
      // asks the two questions any reopened conversation asks - its roster and its history - and is
      // refused both. `loadGroupMembers` and `loadHistoryForConversation` each guard on
      // `lifecycle: 'removed'`, and neither guard can fire on a device that has not been told yet:
      // the discriminator genuinely is not local here, which is exactly what separates this from
      // DEL-2 and DEL-3, where the deleter asked about its OWN deletion eleven seconds later.
      //
      // Scoped to the two paths and to 403 alone, on the PEER's handle only. A 403 on the deleter
      // is still a finding, and so is any other status here.
      const rep2 = ignoringExpectedRefusal(
        ignoringExpectedLog(ignoringOfflineCut(await report(o2)), [
          OUTBOX_GROUP_DELETED,
          PEER_DELETED_NARRATION,
        ]),
        [
          {
            path: /^\/api\/mls\/(?:groups\/[0-9a-f-]{36}\/members|history\/[0-9a-f-]{36})$/,
            status: [403],
          },
        ]
      );
      await recordObserved(
        'DEL-5',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          socketsClosedOnPeer: severed.socketsClosed, // the peer was deaf, not merely flagged
          messageResurfacedOnDeleter: arrivedOnW1,
          groupResurfacedOnDeleter: listedOnW1,
          decryptFailuresOnDeleter: decryptFailures.slice(-6), // the marker half of the assertion
          peerOutboxDeathsForgiven: rep2.ignoredAsExpectedLog.unexplained,
          negativeWindowMs: NEGATIVE_WINDOW_MS,
        },
        { W1: await asCreator(o1), W2: rep2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * DEL-6 - delete while a drain is in flight for that group.
 *
 * THE LINES ARE REAL AND THAT WAS CHECKED BEFORE THE CHECK WAS WRITTEN. `[QUEUE] Drain start` and
 * `[QUEUE] Drain complete` are emitted by `mlsPerGroupScheduler.ts`; other files mention them only
 * in comments, and a check asserting a string it found in a comment asserts nothing. Both are BENIGN
 * to the classifier, so they are read from `consoleLines` rather than from a bucket.
 *
 * A MISSING `Drain complete` IS THE DEFECT THIS LOOKS FOR. A scheduler that abandons a drain
 * half-way when its group disappears leaves the queue believing a drain is still running, and the
 * next frame for ANY group waits behind one that will never finish. One start is the premise: a
 * window with no drain in it proves nothing at all, and says so as INVALID.
 */
async function del6() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    await armCut(w2);
    await ensureChat(w2);
    return await withSharedGroup(6, w1, w2, async (name) => {
      await openGroup(w2, name, { navigate: false, label: 'del6-w2' });
      const severed = await cutHard(w2);

      // Frames the peer cannot take yet, so its reconnect has a real drain to do.
      await openGroup(w1, name, { navigate: false, label: 'del6-w1' });
      const markers = [];
      for (let i = 0; i < 4; i++) {
        const m = mark(`DEL6M${i}`);
        markers.push(m);
        await send(w1, m);
        await sleep(700);
      }

      // Back online: the drain starts. Delete underneath it, as soon as it has begun.
      const from = consoleLines(w2).length;
      await severed.restore();
      const t0 = Date.now();
      let drainBegan = false;
      while (Date.now() - t0 < 45_000) {
        if (consoleLines(w2).slice(from).some((l) => l.includes('[QUEUE] Drain start'))) {
          drainBegan = true;
          break;
        }
        await sleep(250);
      }
      await deleteGroup(w1, name);
      await sleep(NEGATIVE_WINDOW_MS);

      const lines = consoleLines(w2).slice(from);
      const starts = lines.filter((l) => l.includes('[QUEUE] Drain start')).length;
      const completes = lines.filter((l) => l.includes('[QUEUE] Drain complete')).length;

      const ok = starts >= 1 && completes >= starts;
      // The peer was cut on purpose and its queued frames die in a group that no longer exists -
      // both are this check working. `consoleLines` was read ABOVE, before `report` clears the
      // buffer, so the drain counts the verdict rests on are already in hand.
      const rep2 = ignoringExpectedLog(ignoringOfflineCut(await report(o2)), [
        OUTBOX_GROUP_DELETED,
        PEER_DELETED_NARRATION,
        // THE CROSSING THIS ROW BUILDS ON PURPOSE. It queues frames while the peer is deaf and
        // then lets the whole batch drain at once, which is the exact shape that hands a device a
        // row the live socket and the pending pull both offer - the app says so once per session
        // and counts the rest. Measured here 2026-09-05.
        ...DELIVERY_CROSSING_NARRATION,
      ]);
      await recordObserved(
        'DEL-6',
        drainBegan ? (ok ? 'PASS' : 'FAIL') : 'INVALID',
        {
          group: name,
          framesQueuedWhileOffline: markers.length,
          drainBeganBeforeDeletion: drainBegan, // THE PREMISE
          msToFirstDrain: drainBegan ? Date.now() - t0 : null,
          drainStarts: starts,
          drainCompletes: completes, // a shortfall IS the abandoned drain
          socketsClosedOnPeer: severed.socketsClosed,
          ...(drainBegan
            ? {}
            : { why: 'no drain ever started on the peer, so the deletion landed on an idle queue' }),
          peerOutboxDeathsForgiven: rep2.ignoredAsExpectedLog.unexplained,
        },
        { W1: await asCreator(o1), W2: rep2 }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * DEL-7 - the group is deleted while the owner's PHONE is dead, holding a frame it never drained.
 *
 * THE ONE ROW OF THIS PHASE THAT NEEDS THE PHONE, and the platform is not the reason: A1 is the only
 * client this fleet can take away ENTIRELY. A tab cut by `net.mjs` keeps running - it holds its
 * stores, its timers and its socket state, and it learns of everything the instant the link returns,
 * which is DEL-5's question. A killed app holds nothing but its IndexedDB, and what it does with a
 * frame it drains on a COLD START is a different path through the same code. So this row asks DEL-5's
 * question of a device that was not merely unreachable but ABSENT.
 *
 * WHAT MAY NOT HAPPEN, in the board's words: no row re-created from a queued frame. A1 is a SECOND
 * DEVICE OF THE OWNER's account, so the group W1 creates reaches it as an MLS client of its own, and
 * a message W2 sends while it is dead is a frame the server holds FOR THAT CLIENT. On waking it
 * drains that frame and it fetches its conversations, and nothing orders those two: if the drain
 * wins, an application message arrives for a group the fetch has not yet said is gone. Building a
 * live conversation out of it is the defect this row exists for; converging on the deletion is the
 * promise.
 *
 * WHICH ASSERTION DECIDES, AND WHY IT IS NOT THE SIDEBAR. A conversation deleted by someone else
 * stays LISTED as a retired row on purpose - that is how the product explains the absence, and how
 * this file's own teardown finds it to sweep. "Not in the sidebar" is therefore the wrong question;
 * the question is whether the STORE row is live, and only `conversationRows` separates the three
 * states it can be in.
 *
 * TRANSIENTLY LIVE IS NOT THE DEFECT EITHER. The two paths above race by construction, so the row
 * may exist for as long as the conversation fetch takes; what is asserted is that it CONVERGES. The
 * lifecycle is polled until it leaves `live` - the convergence IS the finish line, so there is no
 * interval to guess at - and the negative window is then held to prove it stays there, and that the
 * phone does not spend that window asking the server about a group nobody will ever answer for.
 *
 * `am kill`, NEVER `force-stop`: `phone.mjs` carries the reason at length, and a check that put the
 * package into Android's STOPPED state would be measuring Android rather than the app.
 */
async function del7() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  // ASSERTED, NEVER ASSUMED: A1 must be the OWNER's second device. Off adb, or logged into the
  // peer's account, there is no second client of this group to take away - and a check that carried
  // on would delete a group on one device and call the absence a convergence.
  const probe = await sameAccountAs(w1, PORTS.A1, 'tauri.localhost');
  if (!probe.ok) {
    record('DEL-7', 'SKIPPED', { reason: probe.why, checked: true });
    w1.close();
    w2.close();
    return true;
  }
  let a1 = probe.cx;
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    await ensureChat(a1);
    return await withSharedGroup(7, w1, w2, async (name) => {
      try {
        const gid = await groupIdByName(w1, name);
        if (!gid) throw new Error('DEL-7: W1 holds no row for the group it just created');

        // PREMISE ONE: the phone really holds the group. Nothing below can resurrect a row that was
        // never created, so a phone the group never reached makes this INVALID rather than FAIL.
        const reachedA1Ms = await awaitListed(a1, name, 90_000);
        if (reachedA1Ms === null) {
          await recordObserved(
            'DEL-7',
            'INVALID',
            {
              group: name,
              groupId: gid.slice(0, 8),
              why: 'the group never reached A1, so there was no row on the phone for a queued frame to resurrect',
            },
            { W1: await asCreator(o1), W2: o2 }
          );
          return false;
        }

        // The devtools socket dies with the process, so it is closed here rather than left to fail on
        // its next use. Logcat is cleared in the same breath: every phone line read below is then
        // this check's own, which is what makes a tail read evidence instead of index arithmetic.
        phone.clearLogcat();
        a1.close();
        a1 = null;
        const death = await phone.killAndProveDead();

        // PREMISE TWO: a frame really is waiting for the dead device. `awaitMessage` on the SENDER is
        // what proves it left; whether W1 renders it is DEL-9's subject, not this row's.
        const marker = mark('DEL7M');
        await openGroup(w2, name, { navigate: false, label: 'del7-w2' });
        await send(w2, marker);
        await awaitMessage(w2, marker, 45_000);

        // ONLY NOW THE DELETION, and the order is the check. A group deleted before the frame reached
        // the server would have refused the send outright, leaving nothing queued for the phone and
        // nothing for it to converge about - a PASS for a race that was never set up.
        await deleteGroup(w1, name);

        // COLD START. `unlockPin` speaks to the app over the forward, so the order is launch,
        // forward, attach, unlock - and a restarted app opens on its DEFAULT route, never where it
        // was, which is why `ensureChat` follows rather than being assumed.
        phone.launch();
        await sleep(6000);
        phone.forwardDevtools(PORTS.A1);
        await sleep(2000);
        a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
        const oA1 = await watch(a1, 'DEL-A1');
        const unlock = phone.unlockPin(PORTS.A1);
        await ensureChat(a1);

        const lifecycleOnWake = (await rowOf(a1, name))?.lifecycle ?? 'purged';
        const CONVERGENCE_DEADLINE_MS = 60_000;
        const t0 = Date.now();
        let lifecycle = lifecycleOnWake;
        while (lifecycle === 'live' && Date.now() - t0 < CONVERGENCE_DEADLINE_MS) {
          await sleep(1000);
          lifecycle = (await rowOf(a1, name))?.lifecycle ?? 'purged';
        }
        const convergedInMs = lifecycle === 'live' ? null : Date.now() - t0;

        // WHAT THE COLD START SAID ABOUT THIS GROUP, AS A COUNT. The lines are on the device and they
        // can name a person; a phone's console is not something a public repository may quote from.
        // The count separates "it drained something" from "it never saw the frame", which is the only
        // distinction a verdict here needs from them.
        const wakeMentions = phone.console_().filter((l) => l.includes(gid.slice(0, 8))).length;

        // THE NEGATIVE WINDOW, over a buffer cleared for it so the read needs no offset: the row must
        // STAY converged, and the phone must not spend the window soliciting for a group nobody will
        // ever answer for. `solicitationsAbout` defines what counts as one and states the reason;
        // DEL-8 asks the same question of W1 through the same helper.
        phone.clearLogcat();
        await sleep(NEGATIVE_WINDOW_MS);
        const lifecycleAfterWindow = (await rowOf(a1, name))?.lifecycle ?? 'purged';
        const soliciting = solicitationsAbout(gid, phone.console_());

        const ok =
          lifecycle !== 'live' &&
          lifecycleAfterWindow !== 'live' &&
          soliciting.length <= MAX_SOLICITATIONS;
        // THE PEER LEARNT OF A DELETION THIS CHECK PERFORMED ON PURPOSE - see
        // `PEER_DELETED_NARRATION`. A1 hears the same sentence about a deletion the OWNER's other
        // device performed, so the needle is owed on both handles.
        const peerRep = ignoringExpectedLog(await report(o2), [PEER_DELETED_NARRATION]);
        // A1 IS FORGIVEN THREE THINGS AND OWES THE REST. It hears the deletion sentence like any
        // other member; it hears the OWNER's dismissal because it is the owner's second device, and
        // that sentence is this row's pass condition rather than dirt; and it narrates the cold
        // start this check performed - the token it re-registers and the frame it pre-injects, which
        // IS the queued frame `del7` arranged for it. Everything else a resurrected phone might say
        // is still dirt, which is the point of listing three needles instead of trusting the phase.
        const a1Rep = ignoringExpectedLog(await report(oA1), [
          PEER_DELETED_NARRATION,
          OWN_DEVICE_DISMISS_NARRATION,
          ...COLD_START_NARRATION,
        ]);
        await recordObserved(
          'DEL-7',
          ok ? 'PASS' : 'FAIL',
          {
            group: name,
            groupId: gid.slice(0, 8),
            reachedA1Ms, // THE PREMISE: the phone held the group before it was taken away
            deadInMs: death.deadInMs,
            stateAtKill: death.stateAtKill, // a kill that missed is a check that measured nothing
            marker,
            pinOnWake: unlock, // a restarted app re-locks, and nothing below the modal is readable
            lifecycleOnWake, // `live` here is legitimate - the fetch had not landed yet
            convergedInMs, // null means it never left `live` within the deadline
            lifecycleAfterConvergence: lifecycle, // THE DECIDER
            lifecycleAfterWindow, // and it must STAY there
            wakeMentionsOfTheGroup: wakeMentions,
            solicitationsInWindow: soliciting.length,
            // THE LINES THE NUMBER ABOVE CAME FROM - DEL-8's shape, and DEL-7 owed it. A `clean` run
            // dumps no console, so a row that fails on a count and records only the count leaves its
            // reader nothing: the two FAILs of 2026-08-27 could not say whether `3` was three
            // attempts or one narrated three times, and the answer took a hand-attached logcat.
            solicitations: soliciting.slice(-8),
            negativeWindowMs: NEGATIVE_WINDOW_MS,
            convergenceDeadlineMs: CONVERGENCE_DEADLINE_MS,
          },
          { W1: await asCreator(o1), W2: peerRep, A1: a1Rep }
        );
        return ok;
      } finally {
        // THE THIRD ESTATE. `withSharedGroup` sweeps W1 and W2; the phone keeps a retired row of its
        // own that no server action can reach, and this phase is not entitled to leave one behind on
        // a device whose profile the rig cannot rebuild. It may not throw: a teardown that did would
        // turn a recorded verdict into an ERROR.
        try {
          if (a1 && (await lists(a1, name))) {
            await openConversation(a1, name);
            await dismissLocally(a1, name);
          }
        } catch (e) {
          console.log(`[del] teardown A1: ${e.message}`);
        }
      }
    });
  } finally {
    w1.close();
    w2.close();
    if (a1) a1.close();
  }
}

/**
 * DEL-8 - delete a group, then restore an MLS snapshot from BEFORE the deletion.
 *
 * THIS ONE COSTS SOMETHING AND RUNS LAST FOR THAT REASON. A restore is a ratchet REWIND over W1's
 * real MLS state, not a scratch fixture: everything that reached W1 between the snapshot and the
 * restore is rolled back out of its store. So the window is kept as short as the check allows,
 * nothing else is arranged inside it, and this is the last row of the phase.
 *
 * WHAT IT IS ACTUALLY FOR: the restored state believes it is a member of a group the server has
 * deleted - the exact shape that can solicit for ever, a client asking about a group nobody will
 * ever answer for. "Purged as an orphan, never left soliciting" is therefore two assertions, and the
 * second needs a WINDOW rather than an instant: one solicitation is the recovery seam doing its job
 * once, and only its repetition is the defect.
 *
 * `mlsdb.mjs` is invoked as a subprocess exactly as `heal-web.mjs` and `heal-w2.mjs` do - it is a
 * CLI, it exports nothing, and it is a rig capability with nothing to do with the phone.
 */
async function del8() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  const mlsdb = (...args) =>
    execFileSync(process.execPath, [requireScript('mlsdb.mjs'), '--port', String(W1), ...args], { encoding: 'utf8' });
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withSharedGroup(8, w1, w2, async (name) => {
      const gid = await groupIdByName(w1, name);
      if (!gid) throw new Error('DEL-8: W1 holds no row for the group it just created');

      const digestBefore = mlsdb('digest').trim();
      mlsdb('snapshot');

      await deleteGroup(w1, name);
      const afterDelete = await rowOf(w1, name);

      // Rewind to a state that still believes in the group.
      mlsdb('restore');
      await ensureChat(w1);
      const from = consoleLines(w1).length;
      await sleep(NEGATIVE_WINDOW_MS);

      const listedAfterRestore = await lists(w1, name);
      const rowAfterRestore = await rowOf(w1, name);
      const soliciting = solicitationsAbout(gid, consoleLines(w1).slice(from));

      // Purged, or at worst retired. What it may NOT be is live and asking about itself for ever.
      const ok = listedAfterRestore === false && soliciting.length <= MAX_SOLICITATIONS;
      // THE PEER LEARNT OF A DELETION THIS CHECK PERFORMED ON PURPOSE - see `PEER_DELETED_NARRATION`.
      const peerRep = ignoringExpectedLog(await report(o2), [PEER_DELETED_NARRATION]);
      await recordObserved(
        'DEL-8',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          groupId: gid.slice(0, 8),
          lifecycleAfterDeletion: afterDelete ? afterDelete.lifecycle : 'purged',
          listedAfterRestore,
          lifecycleAfterRestore: rowAfterRestore ? rowAfterRestore.lifecycle : 'purged',
          solicitationsAfterRestore: soliciting.slice(-8), // repetition is the defect, not presence
          mlsDigestBeforeSnapshot: digestBefore.slice(0, 120),
          negativeWindowMs: NEGATIVE_WINDOW_MS,
        },
        { W1: await asCreator(o1), W2: peerRep }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * DEL-9 - delete the conversation currently OPEN on screen.
 *
 * THE ROW THE 403 FIX IS PINNED BY. Deleting the open conversation is the one gesture where the
 * pane, the sidebar and the selection must all let go of the same group at once, and it is the
 * gesture that used to leave the row reading as live while the membership behind it was already
 * revoked - `$effect`s over the conversations map fired inside that window and asked a members-only
 * endpoint about a group we had just given up. `useConversations.exitGroup.svelte.test.ts` pins the
 * window itself; this row pins the same fix through the UI, which is the half a unit test cannot see.
 *
 * `PANE_STATE` is how "the view left cleanly" is read without believing prose: `composer`, `removed`
 * or `nothing`, and only the last is a pane holding no conversation at all.
 */
async function del9() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    return await withSharedGroup(9, w1, w2, async (name) => {
      await openGroup(w1, name, { navigate: false, label: 'del9-w1' });
      const paneBefore = await evaluate(w1, PANE_STATE);
      const openedIt = await evaluate(w1, PANE_HAS_CONVERSATION);

      await deleteGroup(w1, name);
      await sleep(3000);

      const paneAfter = await evaluate(w1, PANE_STATE);
      const holdsAfter = await evaluate(w1, PANE_HAS_CONVERSATION);
      const listedAfter = await lists(w1, name);
      const rowAfter = await rowOf(w1, name);
      const rep = ignoringExpectedLog(await report(o1), GROUP_CREATION_NARRATION);

      // CLEANLINESS IS NOT THIS ROW'S ASSERTION TO MAKE, and making it was the only row in DEL that
      // did. `recordObserved` gates every verdict through `gate`, which turns PASS + dirt into
      // PASS-DIRTY - but `gate` only ever DOWNGRADES, so folding `rep.clean` in here produced a raw
      // FAIL that no gate could rescue. DEL-9 was therefore structurally incapable of the
      // PASS-DIRTY the campaign runs on, and it spent 2026-08-27 reporting FAIL over one
      // `[HISTORY_COVERAGE]` line from a phone that had simply joined the fleet - with all four of
      // its own assertions recorded as holding. The dirt is not lost: it is in the row, under
      // `clean` and `dirt_*`, put there by the one place that can know it.
      const ok =
        openedIt === true &&
        holdsAfter === false &&
        paneAfter === 'nothing' &&
        listedAfter === false;
      // THE PEER LEARNT OF A DELETION THIS CHECK PERFORMED ON PURPOSE - see `PEER_DELETED_NARRATION`.
      const peerRep = ignoringExpectedLog(await report(o2), [PEER_DELETED_NARRATION]);
      await recordObserved(
        'DEL-9',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          paneBeforeDeletion: paneBefore, // THE PREMISE: it really was the open conversation
          paneAfterDeletion: paneAfter,
          paneStillHoldsAConversation: holdsAfter,
          listedAfterDeletion: listedAfter,
          lifecycleAfterDeletion: rowAfter ? rowAfter.lifecycle : 'purged',
        },
        { W1: rep, W2: peerRep }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

/**
 * Every `DELETE` matching `pattern` that the SERVER ANSWERED, correlated by `requestId`.
 *
 * `deletesSince` counts what LEFT the client, and with the radios cut that is not the same fact: the
 * page fires the request, the transport drops it, and a count of `requestWillBeSent` reports it as
 * an arrival. DEL-10's whole subject is a call that was made and never answered, so the row cannot
 * rest on the half of the wire that does not know. `Network.responseReceived` carries the status, so
 * a request with no matching response is exactly what "never answered" looks like from here.
 */
function answeredDeletesSince(cx, pattern, sinceIndex = 0) {
  const slice = cx.events.slice(sinceIndex);
  const sent = new Map();
  for (const e of slice) {
    if (
      e.method === 'Network.requestWillBeSent' &&
      e.params?.request?.method === 'DELETE' &&
      pattern.test(e.params.request.url || '')
    ) {
      sent.set(e.params.requestId, e.params.request.url);
    }
  }
  const answered = [];
  for (const e of slice) {
    if (e.method !== 'Network.responseReceived') continue;
    const url = sent.get(e.params?.requestId);
    if (url === undefined) continue;
    answered.push({ url, status: e.params?.response?.status ?? null });
  }
  return answered;
}

/**
 * Whether production still holds the group, and whether it is soft-deleted - read from the DATABASE.
 *
 * THE DEFECT DEL-10 NAMES IS SERVER-SIDE, so this is the only place it can be settled. Every
 * client-side signal is compatible with the bug: the sidebar is empty because the local purge is
 * unconditional, and the request counts say what was attempted. `dm_groups.deletedAt` says what the
 * server DID. `psql` is read-only here by convention and by content.
 */
async function serverGroupState(groupId) {
  const out = psql(
    `SELECT COALESCE("deletedAt"::text, 'live') FROM dm_groups WHERE id = '${groupId}'`
  ).trim();
  if (out === '') return 'absent';
  return out === 'live' ? 'live' : 'soft-deleted';
}

/**
 * WHAT THE DELETER SAID WHILE THE LINK CAME BACK - the evidence DEL-10 lacked.
 *
 * A reconnect that replays nothing has two causes and the verdict cannot tell them apart: the
 * trigger never fired, or it fired and found no row. The run of 2026-08-26 recorded
 * `sentOnFirstReconnect: 0` and stopped there, so the entry it produced named both causes and
 * settled neither - a report that cannot separate the causes it reports is a day of hand-work.
 *
 * Both causes DO speak, in the page's own console, and this reads them rather than inferring:
 *
 *  - `reconnectAnnounced` - `ConnectivityStore` logs before it emits, so this line IS the trigger
 *    firing. Absent, the listener never ran and the fault is in the connectivity seam.
 *  - `drainStarted` - the drain announces a non-empty replay. Present with `sentOnFirstReconnect`
 *    at zero means the calls were made and lost; absent, with the trigger announced, means the
 *    durable row was not there to replay, which is the OTHER defect entirely.
 *  - `exitLines` - kept whole and unfiltered, because a verdict must never be computed over a
 *    projection of its own evidence (harness fault #31).
 */
function drainTrace(lines) {
  return {
    reconnectAnnounced: lines.some(
      (l) => l.includes('[CONNECTIVITY] browser reports online') || l.includes('[CONNECTIVITY] server reachable again')
    ),
    drainStarted: lines.some((l) => l.includes('[EXIT] replaying')),
    exitLines: lines.filter((l) => l.includes('[EXIT]')),
  };
}

/**
 * DEL-10 - delete while offline, then reconnect.
 *
 * "REACHES THE SERVER ONCE, NO RE-BROADCAST ON LATER RECONNECTS" is two claims and the FIRST is the
 * one at risk. `deleteGroupOnServer` has one live caller and no retry queue, so an offline deletion
 * has nowhere to be remembered: the server call throws, the local purge runs anyway, and the group
 * is gone here while the server still holds it - and a group the server still holds is a group
 * `discoverMissingGroups` can hand back, the resurrection `conversations.dedup.test.ts` warns of.
 *
 * SO A FAILURE HERE IS EXPECTED TO BE HONEST RATHER THAN SURPRISING, and the counts are what make it
 * legible. Zero DELETEs after the reconnect says the deletion never left the device; the second
 * cut-and-restore separates "sent once" from "sent on every reconnect for ever". A check that asked
 * only "is it still in the sidebar" would have passed on both defects.
 */
async function del10() {
  const [w1, o1] = await observed(W1, 'DEL-W1');
  const [w2, o2] = await observed(W2, 'DEL-W2');
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    await armCut(w1);
    await ensureChat(w1);
    return await withSharedGroup(10, w1, w2, async (name) => {
      const gid = await groupIdByName(w1, name);
      if (!gid) throw new Error('DEL-10: W1 holds no row for the group it just created');
      const onGroup = new RegExp(`/api/mls/groups/${gid}`);

      await openGroup(w1, name, { navigate: false, label: 'del10-w1' });
      const severed = await cutHard(w1);
      const fromOffline = w1.events.length;

      // The gesture, offline. It may not complete - `deleteGroup` waits for the name to leave the
      // DOM, which a local purge satisfies on its own. Either way the outcome is recorded.
      const gesture = await deleteGroup(w1, name).then(
        (v) => v,
        (e) => `rejected: ${e.message}`
      );
      // BOTH HALVES OF THE WIRE, and the gap between them is the finding: with the radios cut the
      // request is SENT and never ANSWERED, so a row resting on the first number would read an
      // attempt as an arrival.
      const sentWhileOffline = deletesSince(w1, onGroup, fromOffline).length;
      const answeredWhileOffline = answeredDeletesSince(w1, onGroup, fromOffline).length;

      const fromFirst = w1.events.length;
      // The console is snapshotted BY LENGTH rather than by time: `consoleLines` concatenates what
      // `report` has already consumed with what is still buffered, and that concatenation only ever
      // grows during a check, so an index into it is stable where a timestamp comparison is not.
      const saidBeforeFirst = consoleLines(w1).length;
      await severed.restore();
      await sleep(20_000);
      const sentOnFirstReconnect = deletesSince(w1, onGroup, fromFirst).length;
      const answeredOnFirstReconnect = answeredDeletesSince(w1, onGroup, fromFirst);
      const firstReconnectSaid = drainTrace(consoleLines(w1).slice(saidBeforeFirst));

      // A SECOND round trip, to tell "once" from "every time".
      const severedAgain = await cutHard(w1);
      const fromSecond = w1.events.length;
      const saidBeforeSecond = consoleLines(w1).length;
      await severedAgain.restore();
      await sleep(20_000);
      const sentOnSecondReconnect = deletesSince(w1, onGroup, fromSecond).length;
      // THE SILENCE OF THE SECOND RECONNECT MUST BE THE RIGHT SILENCE. Zero re-broadcasts is the
      // claim, but zero because the row was answered and cleared is a PASS while zero because the
      // trigger never fires is the defect wearing a PASS - and only this tells them apart.
      const secondReconnectSaid = drainTrace(consoleLines(w1).slice(saidBeforeSecond));

      const listedOnW1 = await lists(w1, name);
      // THE DECISIVE ONE, and it is not a client fact at all: the group must be gone from the server
      // that kept it. `absent` is a hard delete, `soft-deleted` the 90-day tombstone - both are the
      // deletion honoured; `live` is the defect, whatever the sidebar shows.
      const onServerAfter = await serverGroupState(gid);
      const answeredOnce = answeredWhileOffline + answeredOnFirstReconnect.length >= 1;
      const ok =
        answeredOnce &&
        onServerAfter !== 'live' &&
        answeredWhileOffline === 0 &&
        sentOnSecondReconnect === 0 &&
        listedOnW1 === false;

      // The deleter was taken offline twice by this check; the request counts above were taken from
      // `cx.events` before `report` cleared it, so only the noise of the cuts is being forgiven.
      // AND THE REPLAY IS THIS ROW'S POST-CONDITION, NOT ITS NOISE. `[EXIT] replaying N exit(s)`
      // and `[EXIT] <id> delete replayed` are the mechanism DEL-10 exists to watch: the row asserts
      // on them through `firstReconnectSaid.exitLines` two statements below, and then used to report
      // the same two lines as unexplained dirt. A check may not call its own evidence noise.
      const rep = ignoringExpectedLog(ignoringOfflineCut(await report(o1)), [
        ...GROUP_CREATION_NARRATION,
        /^\[EXIT\] replaying \d+ exit\(s\) the server never answered$/,
        /^\[EXIT\] [0-9a-f]{8}\.\.\. delete replayed - server (deleted it|had already deleted it)$/,
      ]);
      // THE PEER LEARNT OF A DELETION THIS CHECK PERFORMED ON PURPOSE - see `PEER_DELETED_NARRATION`.
      const peerRep = ignoringExpectedLog(await report(o2), [PEER_DELETED_NARRATION]);
      await recordObserved(
        'DEL-10',
        ok ? 'PASS' : 'FAIL',
        {
          group: name,
          groupId: gid.slice(0, 8),
          gestureWhileOffline: gesture,
          sentWhileOffline, // the attempt: >0 here is the client trying, not succeeding
          answeredWhileOffline, // must be 0 - there is no network to answer it
          sentOnFirstReconnect,
          // THE CLAIM: the deletion must be ANSWERED here, with the statuses that answered it.
          answeredOnFirstReconnect: answeredOnFirstReconnect.map((a) => a.status),
          // WHY, when the numbers above are zero - see `drainTrace`.
          firstReconnectSaid,
          sentOnSecondReconnect, // must be 0 - no re-broadcast for ever
          secondReconnectSaid,
          answeredOnce,
          onServerAfter, // 'absent' | 'soft-deleted' = honoured. 'live' = the defect itself.
          listedOnDeleter: listedOnW1,
          socketsClosedOnDeleter: severed.socketsClosed,
        },
        { W1: rep, W2: peerRep }
      );
      return ok;
    });
  } finally {
    w1.close();
    w2.close();
  }
}

// DEL-1 IS `del1.mjs`, AND ITS ABSENCE IS STATED RATHER THAN LEFT TO BE NOTICED. A dispatcher that
// silently skips a row is how a ten-row rung reports 8/8 and reads green.
const CHECKS = {
  2: del2,
  3: del3,
  4: del4,
  5: del5,
  6: del6,
  7: del7,
  8: del8,
  9: del9,
  10: del10,
};

if (only === 1) {
  record('DEL-1', 'SKIPPED', { why: 'DEL-1 has its own runner, del1.mjs' });
}

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`DEL-${n}`, 'ERROR', { ...errorDetail(e) });
    results.push([n, false]);
  }
}
console.log(`\nDEL: ${results.filter(([, ok]) => ok).length}/${results.length} assertions held`);
// NO EXIT CODE DERIVED FROM THESE BOOLEANS - `results.mjs` derives it from the recorded verdicts,
// which are the GATED ones. `grp.mjs` and `search.mjs` carry the same note for the same reason.
