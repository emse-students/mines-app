#!/usr/bin/env node
/**
 * MENTION-1..6 - the @mention composer, the cleartext `mentionedUserIds` routing hint it produces
 * on channels, and the per-channel notification level it is meant to serve.
 *
 * WHAT THE APP ACTUALLY PROMISES (read off the source, not guessed):
 *
 *   TOKEN FORMAT (`mentions.ts`): a mention is stored as `@[id]`, `id` = 64 lowercase hex chars
 *     (`MENTION_USER_ID_PATTERN`, the OIDC sub, no dashes). `extractMentionUserIds` is a PURE regex
 *     over the text - it does not check the id is a real account or a channel member.
 *   COMPOSER (`useMentionAutocomplete.svelte.ts` + `mentionEditor.ts`): typing `@<partial>` debounces
 *     250ms then hits `/api/users/search?q=`; picking a suggestion (`select()`) replaces the query
 *     with `formatMentionToken(id) + ' '` and the contenteditable re-renders it as a
 *     `<span data-mention-id class="mention-editor-chip">` (`createMentionChip`,
 *     `MENTION_CHIP_SELECTOR = '[data-mention-id].mention-editor-chip'`). Suggestions are scoped by
 *     `allowedUserIds` (`MainChatPage.svelte` `composerAllowedUserIds`): channel members only for a
 *     channel, `undefined` (unrestricted) for a DM unless it is also a group. The scoping is
 *     CLIENT-SIDE ONLY - `extractMentionUserIds` runs on whatever text is in the box regardless, so
 *     a raw `@[id] ` token for a non-member still parses and sends (MENTION-5).
 *   CLEARTEXT LEAK, CHANNELS ONLY (`messaging.ts:101`, inside `isChannelConversationId(...)`):
 *     `extractMentionUserIds(text)` is computed and attached as `mentionedUserIds` on
 *     `SendChannelMessageDto` (`ChannelService.ts`) - "so the server can route the `mentions`
 *     notification level without decrypting. Exposes WHO is mentioned (never the content)." This is
 *     the ONE documented gap; MENTION-6 exists to confirm it is EXACTLY that gap and nothing wider.
 *     The DM/group send path (`messaging.ts`, the branch above line 101) never calls
 *     `extractMentionUserIds` at all - MENTION-4 is the negative space of MENTION-6.
 *   NOTIFICATION LEVEL (`ChannelSettingsModal.svelte`, `ChannelService.ts`
 *     `ChannelNotificationLevel = 'all' | 'mentions' | 'none'`): a PER-USER, PER-CHANNEL setting
 *     persisted server-side (`GET/PATCH .../notification-level`). It gates what the SERVER pushes,
 *     never what the CLIENT sends - `mentionedUserIds` is attached unconditionally by the sender's
 *     own client, independent of the RECEIVER's chosen level. MENTION-2/3 assert BOTH halves - the
 *     DTO the sender issues AND the push that does or does not reach the receiver - which is
 *     possible here only because A1 is a second device of the OWNER's account: the owner sets their
 *     own level on W1 and W2 mentions them, so the routing decision lands on a device this harness
 *     holds. See the block above `armOwnerPhone`.
 *
 * MISSING HOOKS FOUND WHILE WRITING THIS (see the final report - each is a candidate fix):
 *   - `MentionDropdown.svelte`'s suggestions (`<li><button>@{name}</button></li>`) carry no
 *     `role="listbox"/"option"` and no `data-user-id` - contrast `UserAutocomplete.svelte`, a
 *     DIFFERENT picker used elsewhere in the app, which has the full ARIA 1.2 combobox pattern. The
 *     mention dropdown has none of it: no announcement when it opens, no relation between the input
 *     and the list, and this harness can only ever click "the top suggestion" (`.mention-composer ul
 *     button`, first match by DOM order) rather than a specific person by id.
 *   - The RENDERED chip after send (`MessageMentionChip.svelte`) is a bare
 *     `<button onclick>@{name}</button>` with no `data-mention-id` of its own - unlike the COMPOSER's
 *     chip, which does carry one. The composer chip is therefore used as ground truth throughout;
 *     the rendered one can only be located by scoping to the message bubble that carries a marker
 *     (the same convention `clickBubbleAction` in chat.mjs already uses for hover-toolbar actions).
 *   - `ChannelSettingsModal.svelte`'s three notification-level buttons (Tous/Mentions/Aucune) had no
 *     `aria-pressed` and no `data-*` marking which one is active - only a Tailwind class
 *     (`border-amber-500`) distinguished the selected one, found here by reading the component, not
 *     by a hook meant for this, and a screen reader got no "selected" announcement either. FIXED
 *     2026-08-21: they are a `role="radiogroup"` of three `role="radio"` with `aria-checked`, and
 *     `comm.mjs`'s `channelNotifLevel` / `setChannelNotifLevel` read the control's own answer
 *     instead of a styling class. This file used to carry its own copy of that gesture.
 *
 *   bun mention.mjs                 # all six
 *   bun mention.mjs --only 6        # one
 */
import {
  clickAtPoint,
  client,
  ensureChat,
  evaluate,
  openDM,
  openChannel,
  realClick,
  until,
  awaitMessage,
  fireComposer,
  goto,
  COMPOSER,
  SEND_ENABLED,
  mentionInComposer,
} from '../chat.mjs';
import { inPanel, openChannelSettings, setChannelNotifLevel } from '../comm.mjs';
import { errorDetail, mark, record, recordObserved } from '../results.mjs';
import { BLOCK_LIST_READ_NARRATION, ignoringExpectedLog, report, watch } from '../watch.mjs';
import { ABSENT_MENTION_ID, ignoringStrandedMentions } from '../stranded.mjs';
import { srvLines } from '../estate.mjs';
import * as phone from '../phone.mjs';
import { whoIs } from './presence.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, VENUE } from '../names.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');


/**
 * A CLIENT AND THE OBSERVER THAT WATCHES IT - see the twin in `search.mjs` for why they are one call.
 *
 * MENTION recorded six verdicts having attached no observer at all. It is the phase least able to
 * afford that: a mention is a chip whose whole content is a UUID, and every failure mode here -
 * an unresolved user, a chip that renders as raw `@[...]`, a navigation to a profile that 404s -
 * announces itself in the console long before it changes anything this check can see on screen.
 */
async function observed(port, label) {
  const cx = await client(port);
  return [cx, await watch(cx, label)];
}

const { A1, W1, W2 } = PORTS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

// --- selectors, all taken from the source read above, not guessed --------------------------------
/**
 * Picks a notification level and CONFIRMS the control now states it, closing the modal after.
 *
 * A thin wrapper over the shared gesture, kept because what this phase needs from it is a boolean:
 * a check that could not even prove the level took must not treat what follows as valid. The read
 * and the click both live in `comm.mjs` now - this file used to carry a copy that recognised the
 * selected button by a Tailwind class, which the `aria-checked` added on 2026-08-21 replaces.
 */
async function pickNotifLevel(cx, level) {
  try {
    await inPanel(cx, openChannelSettings, () => setChannelNotifLevel(cx, level));
    return true;
  } catch {
    return false;
  }
}

/**
 * The rendered chip inside the bubble carrying `marker`, as a point PROVEN to hit it.
 *
 * THE FIRST VERSION MEASURED A POINT THE SCROLL HAD NOT FINISHED MOVING. It called
 * `btn.scrollIntoView({ block: 'center' })` and read `getBoundingClientRect()` on the next line, so
 * when the pane actually had to scroll - which it does for a message just sent, sitting at the
 * bottom - the rect described where the chip WAS. The click then landed on whatever had taken that
 * place. It passed whenever the chip happened to already be near the centre and needed no scroll,
 * which is exactly the shape of an intermittent: MENTION-1 came back `FAIL` on the x5 of 2026-08-22
 * with `bubbleChipFound: true`, `bubbleChipText: "@<peer>"` and `navigatedPath: null` - the chip was
 * found, its text was right, and the click reached something else.
 *
 * So the point is SETTLED and then CHECKED, rather than taken on the first read:
 *
 *   - settled: the same rect twice in a row, which a scroll still in flight cannot produce;
 *   - on target: `document.elementFromPoint` at that point resolves to the button itself, which is
 *     the only thing that distinguishes "the chip is here" from "something is here".
 *
 * Rule 27 - a gesture that is not asserted is a gesture that did not happen. The caller records both
 * flags, so a run that could not establish the gesture says so instead of blaming the product.
 */
async function chipButtonIn(cx, marker, timeoutMs = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const raw = await evaluate(
      cx,
      `JSON.stringify((function () {
        var pane = document.querySelector('${COMPOSER}').closest('section');
        var hits = [].filter.call(pane.querySelectorAll('p'), function (e) {
          return (e.textContent || '').indexOf(${JSON.stringify(marker)}) !== -1;
        });
        if (!hits.length) return null;
        var p = hits[hits.length - 1];
        var btn = p.querySelector('button');
        if (!btn) return null;
        btn.scrollIntoView({ block: 'center' });
        var r = btn.getBoundingClientRect();
        var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        var at = document.elementFromPoint(x, y);
        return {
          x: x,
          y: y,
          text: (btn.textContent || '').trim(),
          onTarget: at === btn || btn.contains(at),
        };
      })())`
    );
    const now = raw && raw !== 'null' ? JSON.parse(raw) : null;
    if (now && now.onTarget && last && last.x === now.x && last.y === now.y) {
      return { ...now, settled: true };
    }
    last = now;
    await sleep(200);
  }
  return last ? { ...last, settled: false } : null;
}

/**
 * The same chip, read once its NAME has landed rather than once its BOX has.
 *
 * `chipButtonIn` settles on GEOMETRY - it returns as soon as the button has stopped moving, which
 * is what a click needs and is not what a LABEL needs. The chip paints its `@` immediately and
 * fills the name in from an async lookup, so a read taken at that moment records `"@"` whatever
 * the name turns out to be. MENTION-5 recorded exactly that three runs running, including on a
 * build where the resolver had been fixed to answer "Utilisateur inconnu" for an absent account -
 * the row could not have seen its own subject.
 *
 * IT REPORTS WHAT IT SETTLED TO, and never fails: a chip that stays `@` is a legitimate outcome
 * (that WAS the defect until 2026-09-05), and the caller records the value rather than being told
 * it timed out. Bounded well under the campaign's ten seconds - the lookup is one request.
 */
async function namedChipIn(cx, marker, budgetMs = 5000) {
  const t0 = Date.now();
  let chip = await chipButtonIn(cx, marker);
  while (chip && chip.text === '@' && Date.now() - t0 < budgetMs) {
    await sleep(250);
    chip = await chipButtonIn(cx, marker);
  }
  return chip;
}

/** Clicks at a page point directly - the same raw dispatch `clickBubbleAction` uses once the target
 * is already known, for exactly the same reason: no selector distinguishes this button from others. */
async function clickPoint(cx, { x, y }) {
  await clickAtPoint(cx, x, y);
}

// --- network capture: cx.events is a Node-side array (cdp.mjs `connect`), so it is read from Node,
// never through evaluate()/until() which run IN THE PAGE and cannot see it. -----------------------

const CHANNEL_MESSAGES_POST = /\/api\/channels\/[^/]+\/messages(\?|$)/;

/** `Network.requestWillBeSent` events queued since `sinceIdx`. */
const networkRequestsSince = (cx, sinceIdx) =>
  cx.events.slice(sinceIdx).filter((e) => e.method === 'Network.requestWillBeSent');

/** A request's body, fetching it explicitly when Chrome did not inline it on the event. */
async function requestBody(cx, evt) {
  const { request, requestId } = evt.params;
  if (typeof request.postData === 'string') return request.postData;
  if (!request.hasPostData) return null;
  const r = await cx.send('Network.getRequestPostData', { requestId }).catch(() => null);
  return r ? r.postData : null;
}

/** Host-side poll (NOT `until()` - that evaluates page-side, and this is watching Node state). */
async function pollHost(predicate, timeoutMs = 8000, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

/** Waits for and parses the body of the channel-send POST issued since `sinceIdx`. */
async function awaitChannelSendBody(cx, sinceIdx) {
  const evt = await pollHost(() => {
    const hit = networkRequestsSince(cx, sinceIdx).find(
      (e) => e.params.request.method === 'POST' && CHANNEL_MESSAGES_POST.test(e.params.request.url)
    );
    return hit || null;
  });
  if (!evt) return null;
  const raw = await requestBody(cx, evt);
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------------------------------------
// MENTION-1 - autocomplete inserts a `@[uuid]` chip; the chip renders after send and clicking it
// navigates to the mentioned user's profile.
// ---------------------------------------------------------------------------------------------
async function mention1() {
  const [cx, obs] = await observed(W1, 'MENTION-1');
  await openDM(cx, PEER_NAME);

  const term = mark('MENTION1');
  const query = PEER_NAME.split(' ')[0];
  // NAMED, NOT TOP-OF-LIST. `@Canari` filters to BOTH campaign accounts - the dropdown does not
  // exclude the signed-in user - and which of the two is first is the server's order, not a fact
  // about who was meant. The row is picked by its whole display name.
  const mentionId = await mentionInComposer(cx, query, { expectName: PEER_NAME });
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const bubbleChip = await chipButtonIn(cx, term);
  // THE GESTURE HAS TO BE ESTABLISHED BEFORE THE CLAIM CAN BE MADE. A point that never settled on
  // the chip means the check never armed, which is VACUOUS - not a product that failed to navigate.
  const armed = !!bubbleChip?.settled && !!bubbleChip?.onTarget;
  let navigatedPath = null;
  if (armed) {
    await clickPoint(cx, bubbleChip);
    navigatedPath = await until(cx, `location.pathname.indexOf('/profile/') === 0`, 5000)
      .then(() => evaluate(cx, 'location.pathname'))
      .catch(() => null);
  }
  const navigatedId = navigatedPath ? navigatedPath.replace('/profile/', '') : null;

  const ok = !!mentionId && armed && navigatedId === mentionId;
  await recordObserved('MENTION-1', armed ? (ok ? 'PASS' : 'FAIL') : 'VACUOUS', {
    query,
    composerChipMentionId: mentionId, // the one hooked surface - ground truth for the rest
    bubbleChipFound: !!bubbleChip,
    bubbleChipText: bubbleChip?.text ?? null,
    chipPointSettled: bubbleChip?.settled ?? null,
    chipPointOnTarget: bubbleChip?.onTarget ?? null,
    navigatedPath,
    idsMatch: navigatedId === mentionId,
  }, {
    // CLICKING THE CHIP GOES TO A PROFILE, AND A PROFILE READS THE BLOCK LIST. `Log.d` at function
    // entry is this project's own standard, so the bare `[blocks.listBlockedUsers]` tag is a line
    // the code is required to print - which is why the campaign forgives that ONE spelling, per
    // row, and why anything the same module logs WITH a payload is not forgiven here.
    W1: ignoringExpectedLog(await report(obs), BLOCK_LIST_READ_NARRATION),
  });
  if (navigatedPath) await goto(cx, '/chat'); // leave W1 on the conversation list, not a profile page
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// THE PHONE IS THE OWNER'S SECOND DEVICE, WHICH IS WHAT MAKES A PUSH CLAIM POSSIBLE AT ALL.
//
// MENTION-2 and MENTION-3 used to set the OWNER's notification level on W1 and then mention the
// PEER - two halves that never met. The level that gates a push is the RECEIVER's
// (`channel.service.ts`: `member.notifLevels?.[channel.id] ?? 'all'`, then `if (level === 'none')
// continue` and `if (level === 'mentions' && !mentioned.has(...)) continue`), so setting the
// sender's own level contributed nothing to either claim, and both checks could only assert the DTO
// the sender put on the wire. MENTION-2 recorded `PARTIAL` explaining that a push "is not
// observable from a browser tab" - true of a browser tab, and not true of this fleet.
//
// A1 is enrolled as a SECOND DEVICE OF THE OWNER's account, so the check inverts: the owner sets
// THEIR OWN level on W1, W2 mentions the OWNER, and the routing decision lands on the owner's
// phone - the receiver whose level was actually set. NOTIF-4 proved the capability on 2026-08-22
// (a real notification, matched by marker, 11.3 s after the send), which is what a capability has
// to be before a check may rest on it (rule 29).
// ---------------------------------------------------------------------------------------------

/**
 * The owner's phone, WARM on the venue channel and then DEAD - the state a push claim needs.
 *
 * WARM because `awaitNotification` matches the MARKER, and the marker only reaches the shade in a
 * notification the device could DECRYPT. A phone with no Graine state for this channel renders the
 * generic body instead (`phone.GENERIC_BODIES`), which reads as "no notification arrived" and is a
 * completely different finding from the one the check is making.
 *
 * DEAD because a foregrounded app handles the frame over the WebSocket and shows nothing at all
 * (`App in foreground -> MLS handled by the foreground (WS), skip`). `am kill`, never `force-stop`:
 * a force-stopped package sits in Android's STOPPED state and the framework cancels every FCM
 * broadcast to it, so the check would be measuring Android's own suppression.
 */
async function armOwnerPhone() {
  await phone.ensure({ port: A1 });
  const pin = phone.unlockPin(A1);
  const cx = await client(A1, 'tauri.localhost');
  try {
    await ensureChat(cx);
    await openChannel(cx, VENUE.community, VENUE.channel);
  } finally {
    cx.close();
  }
  phone.clearLogcat();
  return { pin, ...(await phone.killAndProveDead()) };
}

/**
 * A channel message from W2 that mentions the OWNER, carrying a marker only this send has.
 *
 * Returns what the SENDER put on the wire beside the ciphertext - the `mentionedUserIds` routing
 * hint - because that is what separates "the server suppressed it" from "the sender never asked for
 * it", and a check whose subject is the routing decision must not confuse the two.
 *
 * **`ownerId` IS REQUIRED AND THE ASSERTION USED TO BE CIRCULAR.** `mentionsOwner` compared the body
 * against `mentionId` - the id of whatever chip the click happened to produce - so it was true by
 * construction whoever was mentioned. On 2026-09-05 the dropdown for the owner's first word offered
 * BOTH campaign accounts (they are `Canari Test <letter>`), the top row was W2 ITSELF, and the send
 * mentioned the sender. The server then correctly pushed to nobody, because the sender is always
 * skipped - and MENTION-2 recorded `FAIL` about a notification level that was working, with
 * MENTION-3 `VACUOUS` behind it because its control is this same send. The pick is now addressed by
 * id and the claim is checked against the OWNER, not against itself.
 */
async function w2MentionsOwner(w2, label, ownerId) {
  if (!ownerId) throw new Error('w2MentionsOwner needs the owner user id - see this function');
  await w2.send('Network.enable');
  const sinceIdx = w2.events.length;
  const term = mark(label);
  const mentionId = await mentionInComposer(w2, OWNER_NAME.split(' ')[0], { expectId: ownerId });
  await w2.send('Input.insertText', { text: term });
  await until(w2, SEND_ENABLED, 5000, 50);
  await fireComposer(w2);
  await awaitMessage(w2, term);
  const body = await awaitChannelSendBody(w2, sinceIdx);
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  return {
    term,
    mentionId,
    mentionedUserIds,
    mentionsOwner: Array.isArray(mentionedUserIds) && mentionedUserIds.includes(ownerId),
    sentAt: Date.now(),
  };
}

/**
 * HOW MANY RECIPIENTS THE SERVER CHOSE, from its own log, scoped to this check's own window.
 *
 * EVIDENCE, NEVER THE ASSERTION. The phone is what the user experiences and it is what the verdict
 * turns on; this is the line that separates the two causes a silent phone cannot distinguish - the
 * server selected nobody, or it selected somebody and the device showed nothing. `recipients=N`
 * only, never the line: it carries a channel and a message uuid and this repository is public.
 *
 * PROD IS SHARED, so the window can catch somebody else's salon. That is exactly why this is not an
 * assertion: an extra number here is another community's traffic, not a defect in this check.
 *
 * A ZERO ARRIVES WITH ITS REASONS since 2026-09-05. `notifyChannelRecipients` returned in silence
 * when it selected nobody, so this read `[]` for that and for a fan-out that never started - and
 * those are exactly the two things this function exists to tell apart.
 */
function serverRecipientCounts(sinceMs) {
  const secs = Math.ceil(sinceMs / 1000) + 5;
  return srvLines('social-service', `${secs}s`)
    .map((l) => /\[CHANNEL_PUSH\] channel=\S+ message=\S+ recipients=(\d+)(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => {
      const count = Number(m[1]);
      if (count > 0) return count;
      // A ZERO NOW SAYS WHY. The server used to return before printing anything when it chose
      // nobody, so an empty array here meant "the fan-out never ran" and "it ran and selected
      // nobody" alike - the two halves of every "I was not notified" report, and this check's whole
      // subject. The tail carries counts only, never an id, so it is safe in a public record.
      const why = /sender=\d+ outsideAudience=\d+ levelNone=\d+ notMentioned=\d+ mentioned=\d+/.exec(m[2]);
      return why ? `0 (${why[0]})` : 0;
    });
}

/**
 * WHAT THE DEVICE ITSELF SAW, since `armOwnerPhone` cleared its log.
 *
 * A silent phone has four causes and the shade cannot tell them apart: the server routed nobody, the
 * frame never reached the device, the device received it and showed nothing, or it showed one and
 * something cancelled it. Each of those is a different bug in a different place, and MENTION-3 came
 * back `VACUOUS` on 2026-08-22 with no way to say which - the control was not heard, the mention was
 * attached, the level was confirmed, and the row stopped there.
 *
 * `type=channel ` with the trailing space on purpose: `type=channel_read` is the cross-device read
 * sync, a different frame answering a different question, and counting it here would report a
 * message the device never got.
 */
function deviceChannelFrames() {
  const lines = phone.adb(['logcat', '-d', '-t', '4000'], 60_000).split(/\r?\n/);
  const count = (re) => lines.filter((l) => re.test(l)).length;
  return {
    received: count(/CanariFCM: onMessageReceived: type=channel /),
    shown: count(/handleChannelMessage: showNotification/),
    cancelled: count(/cancelConversationNotification: notif removed/),
    reads: count(/CanariFCM: onMessageReceived: type=channel_read/),
  };
}

/**
 * W1 sets the OWNER's level for the venue channel, then LEAVES the channel.
 *
 * Leaving is part of the arrangement, not tidiness: the owner's other device sitting IN the channel
 * reads the message as it lands, and a read from another device of the same account is exactly what
 * makes the phone cancel its own notification (`FCM silent from self -> cancelling notification`,
 * the mechanism NOTIF-4 asserts). A check that left W1 in the channel would be racing that cancel.
 */
async function setOwnerLevelAndLeave(cx, level) {
  await openChannel(cx, VENUE.community, VENUE.channel);
  const ok = await pickNotifLevel(cx, level);
  await goto(cx, '/chat');
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MENTION-2 - channel at level "Mentions": a mention REACHES the receiver. The owner sets their own
// level, W2 mentions them, and the owner's phone must raise a notification carrying the marker.
// ---------------------------------------------------------------------------------------------
async function mention2() {
  const [cx, obs] = await observed(W1, 'MENTION-2');
  // WHO THE OWNER IS, read from the owner's own client rather than inferred from a display name -
  // see `w2MentionsOwner` for the run this cost.
  const ownerId = (await whoIs(cx))?.user;
  const levelSet = await setOwnerLevelAndLeave(cx, 'mentions');
  const killed = await armOwnerPhone();

  const [w2cx, w2obs] = await observed(W2, 'MENTION-2/W2');
  await openChannel(w2cx, VENUE.community, VENUE.channel);
  const sent = await w2MentionsOwner(w2cx, 'MENTION2', ownerId);

  const notifiedInMs = await phone.awaitNotification(sent.term, 90_000);
  const device = deviceChannelFrames();
  const serverRecipients = serverRecipientCounts(Date.now() - sent.sentAt);
  // Read whether or not the marker arrived: if it did NOT, a generic body in the shade says the
  // push landed and the device could not decrypt it - a different defect from silence, and one no
  // later reading of this row could recover.
  const undecrypted = phone.undecryptedInShade();

  await openChannel(cx, VENUE.community, VENUE.channel);
  await pickNotifLevel(cx, 'all'); // restore the default - never leave the account on "mentions"

  const ok = levelSet && sent.mentionsOwner && notifiedInMs !== null;
  await recordObserved(
    'MENTION-2',
    ok ? 'PASS' : 'FAIL',
    {
      notifLevelSet: 'mentions',
      notifLevelUiConfirmed: levelSet,
      pinOnPhone: killed.pin,
      stateAtKill: killed.stateAtKill,
      killedInMs: killed.deadInMs,
      mentionId: sent.mentionId,
      mentionedUserIdsSent: sent.mentionedUserIds,
      containsMentionedOwner: sent.mentionsOwner,
      notifiedInMs,
      serverRecipients,
      device,
      undecryptedInShade: undecrypted,
      verdictMeaning:
        'PASS is a REAL PUSH: the owner set their own channel level to "mentions", the peer sent a ' +
        'channel message mentioning them, and the owner phone - killed, out of the foreground - ' +
        'raised a notification whose body carried this send marker, so the frame was routed AND ' +
        'decrypted on the device.',
    },
    { W1: ignoringStrandedMentions(await report(obs)), W2: ignoringStrandedMentions(await report(w2obs)) }
  );
  cx.close();
  w2cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MENTION-3 - channel at level "Aucune": a mention reaches NOTHING. A negative claim, so it carries
// its own positive control - the identical send at level "mentions", in the same run, on the same
// fleet - and the silence window is derived from what that control MEASURED rather than chosen.
// ---------------------------------------------------------------------------------------------
async function mention3() {
  const [cx, obs] = await observed(W1, 'MENTION-3');
  const ownerId = (await whoIs(cx))?.user;
  const [w2cx, w2obs] = await observed(W2, 'MENTION-3/W2');
  await openChannel(w2cx, VENUE.community, VENUE.channel);

  // -- the control: same shape, level "mentions", and it must be HEARD --
  const controlLevelSet = await setOwnerLevelAndLeave(cx, 'mentions');
  await armOwnerPhone();
  const control = await w2MentionsOwner(w2cx, 'MENTION3C', ownerId);
  const controlMs = await phone.awaitNotification(control.term, 90_000);
  // THE CONTROL CARRIES ITS OWN EVIDENCE, because a control that is not heard is the one case this
  // check cannot explain from the shade alone - and it is the case that actually happened.
  const controlDevice = deviceChannelFrames();
  const controlRecipients = serverRecipientCounts(Date.now() - control.sentAt);
  const controlUndecrypted = phone.undecryptedInShade();

  // -- the claim: level "none", and it must be SILENT --
  const levelSet = await setOwnerLevelAndLeave(cx, 'none');
  const killed = await armOwnerPhone();
  const sent = await w2MentionsOwner(w2cx, 'MENTION3', ownerId);
  // FOUR TIMES WHAT THE CONTROL TOOK, floored at 45 s. Derived, not chosen: the window has to be
  // long enough that a notification which was going to arrive already has, and the only honest
  // measure of that on this fleet, this hardware and this network is the one just taken. A literal
  // would be a timeout nobody could defend; this one states what would have to be true for it to be
  // wrong - a push four times slower than the control, on the same pair of devices, minutes later.
  const silenceWindowMs = Math.max(4 * (controlMs ?? 0), 45_000);
  const notifiedInMs = await phone.awaitNotification(sent.term, silenceWindowMs);
  const device = deviceChannelFrames();
  const serverRecipients = serverRecipientCounts(Date.now() - sent.sentAt);
  const foregrounded = phone.foregrounded();

  await openChannel(cx, VENUE.community, VENUE.channel);
  await pickNotifLevel(cx, 'all'); // restore the default

  // A SILENCE IS ONLY EVIDENCE IF THE SAME PIPELINE WAS JUST HEARD. Without the control this check
  // passes on a dead phone, a lost adb link, a peer that never sent, or a channel nobody is in -
  // every one of which is silent, and none of which is the suppression being claimed.
  const verdict =
    controlMs === null
      ? 'VACUOUS'
      : controlLevelSet && levelSet && control.mentionsOwner && sent.mentionsOwner && notifiedInMs === null
        ? 'PASS'
        : 'FAIL';

  await recordObserved(
    'MENTION-3',
    verdict,
    {
      controlLevel: 'mentions',
      controlLevelUiConfirmed: controlLevelSet,
      controlNotifiedInMs: controlMs,
      controlMentionsOwner: control.mentionsOwner,
      controlServerRecipients: controlRecipients,
      controlDevice,
      controlUndecryptedInShade: controlUndecrypted,
      notifLevelSet: 'none',
      notifLevelUiConfirmed: levelSet,
      stateAtKill: killed.stateAtKill,
      mentionId: sent.mentionId,
      mentionedUserIdsSent: sent.mentionedUserIds,
      containsMentionedOwner: sent.mentionsOwner,
      silenceWindowMs,
      notifiedInMs,
      phoneForegroundedAtEnd: foregrounded,
      serverRecipients,
      device,
      verdictMeaning:
        'PASS is a REAL SUPPRESSION: the identical send at level "mentions" reached the phone in ' +
        'controlNotifiedInMs, and the same send at level "none" raised nothing over a window four ' +
        'times that long - while the sender still attached mentionedUserIds both times, so the ' +
        'suppression is the SERVER routing decision and not the client declining to ask. VACUOUS ' +
        'means the control was not heard, so the silence proves nothing.',
    },
    { W1: ignoringStrandedMentions(await report(obs)), W2: ignoringStrandedMentions(await report(w2obs)) }
  );
  cx.close();
  w2cx.close();
  return verdict === 'PASS';
}

// ---------------------------------------------------------------------------------------------
// MENTION-4 - DM/group: a mention triggers NOTHING extra. messaging.ts:101 calls
// extractMentionUserIds ONLY inside the channel branch, so the DM/group send path never computes
// it - this check watches every request the send fires, not just the channel endpoint, because the
// claim is "nothing extra rides along" and a narrower filter would beg the question.
// ---------------------------------------------------------------------------------------------
async function mention4() {
  const [cx, obs] = await observed(W1, 'MENTION-4');
  await openDM(cx, PEER_NAME);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const term = mark('MENTION4');
  const query = PEER_NAME.split(' ')[0];
  // NAMED, NOT TOP-OF-LIST. `@Canari` filters to BOTH campaign accounts - the dropdown does not
  // exclude the signed-in user - and which of the two is first is the server's order, not a fact
  // about who was meant. The row is picked by its whole display name.
  const mentionId = await mentionInComposer(cx, query, { expectName: PEER_NAME });
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  // DMs go over the gateway WebSocket, not HTTP, so no request is expected at all - this settle is
  // what gives any stray HTTP the send path might fire time to actually land before it is inspected.
  await new Promise((r) => setTimeout(r, 1500));
  const since = networkRequestsSince(cx, sinceIdx);
  const bodies = await Promise.all(
    since.map((e) =>
      requestBody(cx, e).then((b) => ({ url: e.params.request.url, method: e.params.request.method, body: b }))
    )
  );
  const channelEndpointHit = since.some((e) => CHANNEL_MESSAGES_POST.test(e.params.request.url));
  const leaked = bodies.filter((b) => typeof b.body === 'string' && b.body.includes('mentionedUserIds'));

  const ok = !channelEndpointHit && leaked.length === 0;
  await recordObserved('MENTION-4', ok ? 'PASS' : 'FAIL', {
    mentionId,
    channelEndpointHit,
    requestsObserved: since.length,
    leakedMentionedUserIds: leaked.map((b) => ({ url: b.url, method: b.method })),
    source:
      'messaging.ts:101 - extractMentionUserIds runs ONLY inside the isChannelConversationId branch; ' +
      'the DM/group path above it never calls it.',
  }, { W1: obs });
  cx.close();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MENTION-5 - mentioning a user who is NOT a channel member. The autocomplete only ever OFFERS
// members (composerAllowedUserIds), so this bypasses it entirely: a fabricated, well-formed
// `@[64-hex]` token typed straight into the composer, which extractMentionUserIds accepts with no
// membership check. Recorded as a finding of what happens, not graded against an expected outcome.
// ---------------------------------------------------------------------------------------------
async function mention5() {
  const [cx, obs] = await observed(W1, 'MENTION-5');
  await openChannel(cx, VENUE.community, VENUE.channel);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const fakeId = ABSENT_MENTION_ID; // matches MENTION_USER_ID_PATTERN, no real account, FIXED
  const term = mark('MENTION5');

  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text: `@[${fakeId}] ${term}` });
  await until(cx, `!!document.querySelector('[data-mention-id="${fakeId}"]')`, 5000);
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const body = await awaitChannelSendBody(cx, sinceIdx);
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  const sentDespiteNonMembership = Array.isArray(mentionedUserIds) && mentionedUserIds.includes(fakeId);
  const bubbleChip = await namedChipIn(cx, term);

  // THE 404 THIS CHECK GOES AND CAUSES. Mentioning a user id that belongs to nobody is the whole
  // point of the row, and the client then asks `/api/users/<id>` to render a name for it - so the
  // check cannot be clean and be doing its job at the same time. The allowlist and the reason it is
  // an allowlist are on `ABSENT_MENTION_404`; what matters here is that the id is a CONSTANT, so
  // this message is the same message on every run and the estate does not accumulate them.
  const narrowed = ignoringStrandedMentions(await report(obs));

  await recordObserved('MENTION-5', sentDespiteNonMembership ? 'PASS' : 'FAIL', {
    fakeUserId: fakeId,
    mentionedUserIdsSent: mentionedUserIds,
    sentDespiteNonMembership,
    // WHAT AN UNRESOLVABLE MENTION LOOKS LIKE TO A READER, read once the lookup has landed. It was
    // a bare `@` until 2026-09-05 - the resolver answered `null` both for "not known yet" and for
    // "the server says there is nobody", so the chip could not tell them apart and rendered the
    // empty string for each. A 404 is an answer now, and this is where that shows.
    renderedFallbackLabel: bubbleChip?.text ?? null,
    note:
      'PASS here means the client neither blocks the send nor validates membership, matching the ' +
      'source read above - it is a finding about the CLIENT, not a verdict on the server: whether the ' +
      'server routes a push for a mention outside the channel is unobserved by this check.',
  }, { W1: narrowed });
  cx.close();
  return sentDespiteNonMembership;
}

// ---------------------------------------------------------------------------------------------
// MENTION-6 - SECURITY: mentionedUserIds rides in cleartext on the channel send (documented,
// known), and this confirms it is EXACTLY that leak - the key-set matches SendChannelMessageDto and
// nothing wider. ciphertext/nonce values and all request HEADERS are deliberately excluded from the
// record: logging them would put a second secret into the file this check exists to keep clean of one.
// ---------------------------------------------------------------------------------------------
async function mention6() {
  const [cx, obs] = await observed(W1, 'MENTION-6');
  await openChannel(cx, VENUE.community, VENUE.channel);

  await cx.send('Network.enable');
  const sinceIdx = cx.events.length;

  const term = mark('MENTION6');
  const query = PEER_NAME.split(' ')[0];
  // NAMED, NOT TOP-OF-LIST. `@Canari` filters to BOTH campaign accounts - the dropdown does not
  // exclude the signed-in user - and which of the two is first is the server's order, not a fact
  // about who was meant. The row is picked by its whole display name.
  const mentionId = await mentionInComposer(cx, query, { expectName: PEER_NAME });
  await cx.send('Input.insertText', { text: term });
  await until(cx, SEND_ENABLED, 5000, 50);
  await fireComposer(cx);
  await awaitMessage(cx, term);

  const body = await awaitChannelSendBody(cx, sinceIdx);

  // THE SET IS THE SOURCE'S, re-derived from `sendEncryptedChannelMessage` on 2026-08-22 rather than
  // carried forward from when this check was written. It had `keyVersion`, which Graine removed, and
  // lacked `senderSessionId` and `messageIndex`, which Graine added - so the check failed on two
  // legitimate fields and would have passed a body that had quietly dropped `keyVersion`'s successor.
  // The two new ones are now in the "what stays in the clear" table of
  // `docs/wiki/protocols/channel-encryption.md`; they were not, and this check is what found that.
  // `silent` is in the set because a reaction is a channel message too and takes the same path.
  const KNOWN_KEYS = new Set([
    'ciphertext',
    'nonce',
    'senderSessionId',
    'messageIndex',
    'messageId',
    'poll',
    'mentionedUserIds',
    'silent',
  ]);
  const bodyKeys = body ? Object.keys(body) : [];
  const unexpectedKeys = bodyKeys.filter((k) => !KNOWN_KEYS.has(k));
  const mentionedUserIds = body?.mentionedUserIds ?? null;
  const carriesPeerId = Array.isArray(mentionedUserIds) && mentionedUserIds.includes(mentionId);
  const onlyPeerId = Array.isArray(mentionedUserIds) && mentionedUserIds.length === 1;

  // REDACTED ON PURPOSE - lengths only, never the values, never a header.
  const ciphertextPresent = typeof body?.ciphertext === 'string' && body.ciphertext.length > 0;
  const noncePresent = typeof body?.nonce === 'string' && body.nonce.length > 0;

  const ok = bodyKeys.length > 0 && unexpectedKeys.length === 0 && carriesPeerId && onlyPeerId;
  await recordObserved('MENTION-6', ok ? 'PASS' : 'FAIL', {
    bodyKeysObserved: bodyKeys,
    unexpectedKeys, // must be empty - anything here is a wider leak than the documented one
    mentionedUserIdsCount: mentionedUserIds?.length ?? null,
    carriesMentionedPeerId: carriesPeerId,
    ciphertextPresent,
    ciphertextLength: body?.ciphertext?.length ?? null, // length only, never the value
    noncePresent,
    nonceLength: body?.nonce?.length ?? null, // length only, never the value
    redactionNote: 'ciphertext/nonce values and all request headers are excluded from this record on purpose.',
  }, { W1: ignoringStrandedMentions(await report(obs)) });
  cx.close();
  return ok;
}

const CHECKS = { 1: mention1, 2: mention2, 3: mention3, 4: mention4, 5: mention5, 6: mention6 };

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`MENTION-${n}`, 'ERROR', { ...errorDetail(e) });
    results.push([n, false]);
  }
}
console.log(`\nMENTION: ${results.filter(([, ok]) => ok).length}/${results.length} assertions held`);
// NO EXIT CODE HERE - see the twin note at the foot of `search.mjs`. These booleans are the assertion
// half only; `results.mjs` derives the code from the recorded verdicts, which are the gated ones.
// MENTION-2 USED TO MAKE THE POINT SHARPLY: it returned `clientPreconditionOk` while recording
// PARTIAL, so this loop counted a run that was explicitly NOT a pass as one, and exited 0 on it.
//
// THAT DEBT IS PAID - MENTION-2 and MENTION-3 assert a real push on the owner's phone now, so the
// phase no longer carries a standing non-zero it had taught its operator to expect. The note stays
// because the SHAPE recurs: a boolean returned by a check is not its verdict, and only the recorded
// verdict may decide an exit code. MENTION-3 is the live example - it returns `verdict === 'PASS'`,
// so its VACUOUS (control not heard) is a failure here and not a quiet zero.
