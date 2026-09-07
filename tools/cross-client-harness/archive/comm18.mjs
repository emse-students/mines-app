/**
 * COMM-18: the app is not running, a link names a salon, and the person lands IN that salon.
 *
 *   bun comm18.mjs
 *
 * A COLD START IS THE HARD HALF, AND IT IS THE ONLY ONE WORTH CHECKING. A deep link into a running
 * app is a `goto`; a deep link into a process that does not exist has to survive the whole chain -
 * the intent reaching `MainActivity`, `plugin-deep-link` holding it until the webview exists,
 * `hooks.client.ts` reading it before the router has decided anything, the encryption PIN being
 * asked and answered, and only then a channel being selected that the sidebar has not finished
 * loading. Every hop can fail silently and four of them fail the same way: the app opens on its
 * default route and looks perfectly healthy.
 *
 * THE LINK IS THE ONE A NOTIFICATION CARRIES, and that is a deliberate choice over the public
 * `https://canari-emse.fr/communities` App Link. The public link is registered
 * (`AndroidManifest.xml`, `autoVerify`) and it works, but `/communities` has NO dynamic segment -
 * the route is a single page and the target conversation travels in a store, not in the path. So a
 * public link can only say "open the communities page", which is not this row. `fr.emse.canari://
 * chat/channel_<uuid>` is what `PendingIntent` puts on a channel notification, which makes this the
 * cold-start half of the path COMM-14 measures the delivery half of.
 *
 * THE PRODUCT'S OWN LINE IS THE FIRST ASSERTION, and it exists for exactly this reason:
 * `[notifNav] deep link received: <url> -> target <groupId>`, written by `hooks.client.ts`. Without
 * it the native half of the chain fails indistinguishably at four hops. It is asserted BESIDE the
 * screen, not instead of it: the line says the handler ran, the transcript says the person arrived,
 * and a run with the line and no transcript is a different defect from a run with neither.
 *
 * AND IT IS READ FROM LOGCAT. The line is written while the client initialises, so it is already
 * gone by the time a cold-started process has a devtools socket to attach to: read from the
 * attached console, this row reported the handler as never having run WHILE the salon was open -
 * not a defect, an instrument arriving after its event. `attachConsole` mirrors the console into
 * logcat, and that buffer existed before the launch.
 *
 * THE MARKER IS POSTED BEFORE THE APP IS EVEN STOPPED. A cold start that has to receive a live
 * message as well would be measuring two things and blaming this one; what this row asks is whether
 * the LANDING is right, so the salon already holds its message when the link is followed.
 *
 * AND IT OWNS WHAT THE KILL MAKES THE APP SAY. A cold start narrates itself - an FCM token
 * re-registered, the cached frames pre-injected - and those sentences are dirt in every phase that
 * did NOT kill the app, which is why `COLD_START_NARRATION` is a needle list handed over by the
 * check that did rather than a rule in the classifier.
 *
 * `am force-stop` IS THE RIGHT KILL HERE AND IS WRONG ELSEWHERE. It puts the app in Android's
 * STOPPED state, which cancels FCM broadcasts - fatal for a push check (see
 * `docs/wiki/testing-methodology.md`), harmless for this one, because an explicit VIEW intent
 * starts a stopped app just the same. This is a link being followed, not a push being delivered.
 *
 * IT BUILDS ITS OWN VENUE and deletes it.
 */
import { awaitMessage, client, countMessage, evaluate, send } from '../chat.mjs';
import {
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  openCommunity,
  selectedChannel,
} from '../comm.mjs';
import { channelIdOf, messageCount, salonDistribution, workspaceIdOf } from '../grainedb.mjs';
import { seedsForChannel } from './grainestore.mjs';
import { ACCOUNT_OF, PORTS } from '../names.mjs';
import * as phone from '../phone.mjs';
import { unlockClient } from './pingate.mjs';
import { clientBuild, mark, record } from '../results.mjs';
import {
  COLD_START_NARRATION,
  consoleLines,
  gate,
  ignoringExpectedLog,
  ignoringExpectedRefusal,
  report,
  watch,
} from '../watch.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w1 = await client(PORTS.W1);
const wa = await watch(w1, 'W1');

/**
 * THE SECOND ESTATE COPIED THE DATABASE AND NOT THE OBJECT STORE, and the social feed is where that
 * shows.
 *
 * `dev-environment.md` describes the local estate as a copy of production, and the POST ROWS really
 * are - the feed on this phone renders real associations and real posts. Their media is not:
 * measured 2026-09-05, `canari-media` in the local Garage holds NINE objects totalling 2 kB, so
 * every image a copied post references answers 404 and `[PostMedia]` says the download failed. Both
 * are the correct behaviour for a blob that is genuinely absent.
 *
 * IT IS FORGIVEN HERE AND NOWHERE WIDER, because this is the only row that puts the FEED on screen:
 * a cold start lands on `/posts` before the deep link moves it, so this check renders a page no
 * other check does. The path is pinned to `/api/media/public/`, which is the public post-media proxy
 * and not the encrypted chat media a MUT or FWD row would fetch - a 404 there is still dirt.
 */
const LOCAL_ESTATE_MEDIA_GAP = [{ path: /^\/api\/media\/public\//, status: [404] }];
/** The client's own sentence about the same absence, which carries no url and so cannot be a path rule. */
const LOCAL_ESTATE_MEDIA_NARRATION = [
  /^\[PostMedia\] media download failed .*Media download failed: 404/,
];

/**
 * THE DEEP-LINK CHAIN NARRATING ITSELF, which is this row's entire subject.
 *
 * Every one of these lines is the product saying it did the thing being measured - `onOpenUrl`
 * fired, the URL parsed, the target resolved - and `[notifNav] deep link received` is literally the
 * first assertion of the check. A row cannot both require a sentence and count it as dirt.
 *
 * THE REPLAY LINE IS HERE ON PURPOSE and is not a defect. `getCurrent()` keeps returning the launch
 * URL for the life of the process, and the ladder in `hooks.client.ts` asks four times; the second
 * and later reads are refused by the `sessionStorage` claim and SAY SO, which is the only thing that
 * separates "the app ignored my link" from "the app already acted on it".
 */
const DEEP_LINK_NARRATION = [
  /^\[hooks\] onOpenUrl called with \d+ URL\(s\)$/,
  /^\[hooks\] Processing URL: /,
  /^\[hooks\] Parsed URL protocol: /,
  /^\[hooks\] launch URL read on attempt \d+, \d+ms after the bundle ran$/,
  /^\[hooks\] launch URL already acted on by this start, ignoring the replay: /,
  /\[notifNav\] deep link received: /,
];

/**
 * THE SESSION THIS PROCESS NO LONGER HAS. `PUT /auth/sessions/current/device` binds the device id to
 * the session once per app start, after unlock - and its own contract says a 404 means the session
 * behind the cookie is gone, which the client reports and does not retry. This row FORCE-STOPS the
 * app, so that is the state it creates: a stored refresh credential that still works and a session
 * row that does not. The 404 is the documented answer, not a failed request.
 */
const STOPPED_APP_SESSION_REFUSAL = [
  { path: /^\/api\/auth\/sessions\/current\/device$/, status: [404] },
];

const run = mark('COMM18');
const community = `C18 ${run}`;
const salon = `c18-${run.toLowerCase()}`;
const marker = `${run}-landed`;

/**
 * Steps that THREW. Not the row's failures - see `failures` below, which is what the record carries.
 *
 * On 2026-08-25 this row recorded `FAIL` with `failures: []` beside four expectations, three of them
 * false. Both fields were accurate and the pair was unreadable: an empty `failures` is read as
 * "nothing failed", and the reader who believes it goes looking for the defect somewhere else. A
 * name that means "the steps that threw" must say so.
 */
const stepErrors = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    stepErrors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

// -- The venue, and a message already in it ----------------------------------------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

await step('create the salon and post into it', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon);
  await send(w1, marker);
  await awaitMessage(w1, marker, 30_000);
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// THE CONVERSATION ID, NOT THE CHANNEL ID. `channel_<uuid>` is the form every chat surface uses for
// a community salon, and it is what `chatDeepLinkRoute` reads to decide the route - a bare uuid would
// be taken for a DM group and routed to `/chat`, where this salon does not exist.
// WHO THE SALON WOULD DELIVER TO, READ BEFORE THE PHONE EVER OPENS IT. A salon's seed travels its
// distribution group, and a device puts its own leaf in that group when it LOADS the salon - so a
// roster read after the landing has already been changed by the landing, and cannot answer whether
// the phone was routed when the message was SENT. Read here it can: this is the last moment before
// the kill, and the phone has never seen this salon.
//
// It exists because of what this row reported on 2026-08-25 - the message on the server, the salon
// open on screen, and `seeds: {held: 0, received: 0}` on the phone, with the client saying the
// session had "no reachable holder". That sentence is the repair path speaking, and the repair path
// asks the OTHER members: here the sender is the phone's own user and the salon has no other member,
// so there was nobody to ask and the seed had to have arrived at send time. Whether it could have is
// exactly this roster.
const distAtSend = channelId
  ? await step('read the salon delivery roster before the phone sees it', () =>
      salonDistribution(channelId)
    )
  : null;

const target = channelId ? `channel_${channelId}` : null;
const link = target ? `fr.emse.canari://chat/${target}` : null;

// The phone has to be there at all, and its BUILD is part of the answer: A1's APK is deliberately
// older than the deployment, and a deep link the running code does not handle is not a defect in the
// code that ships.
const a1Before = await step('read the build the phone is running', async () => {
  // FOREGROUNDED FIRST. `clientBuild` reads the app's own `/_app/version.json` with a `fetch` inside
  // the page, and Android throttles a backgrounded WebView's network - the promise never settles and
  // the CDP call times out. Every `+A1` row before this one leaves the app in the background (this
  // one force-stops it, COMM-14 backgrounds it deliberately to get a tray notification), so arming
  // against whatever the previous row left is exactly what happens in a full pass. It recorded
  // `armed: false` on 2026-09-05 for that reason alone.
  await phone.foreground({ port: PORTS.A1 });
  const cx = await client(PORTS.A1);
  try {
    return await clientBuild(cx);
  } finally {
    cx.close();
  }
});

const armed = !!workspaceId && !!channelId && !!a1Before && (await countMessage(w1, marker)) > 0;

// -- The gesture: kill the app, then follow the link -------------------------------------------
const landing = armed
  ? await step('follow the link into a stopped app', async () => {
      phone.forceStop();
      await sleep(2000);
      const stopped = phone.pid();
      // A KILL THAT MISSED WOULD MAKE THIS A WARM START, which is a different question with the same
      // screen at the end of it. Asserted, not assumed.
      if (stopped) throw new Error(`the app is still running after force-stop (pid ${stopped}) - this would be a warm start`);

      phone.wake();
      // CLEARED HERE, NOT EARLIER: what follows is the only cold start in this run, so the buffer
      // below holds this launch and nothing that came before it - including the previous run's.
      phone.clearLogcat();
      const said = phone.sh(
        `am start -a android.intent.action.VIEW -d ${JSON.stringify(link)} ${phone.PKG}`
      );
      // `am` reports a refusal on STDOUT with exit 0, so the only way to see it is to read what it said.
      if (/Error|Warning: Activity not started/i.test(said)) {
        throw new Error(`am start refused the link: ${said.trim().split('\n').join(' | ')}`);
      }

      // The process is new, so the devtools socket is new: `ensure` re-derives the forward from the
      // CURRENT pid. Without it every read below talks to a dead socket and reports the app as
      // unresponsive - which is indistinguishable from the deep link never arriving.
      // `keepIntent` OR THIS ROW MEASURES NOTHING. `ensure` foregrounds the app with
      // `am start -n <pkg>/.MainActivity` - a plain MAIN intent - and `MainActivity` is
      // `singleTask`, so that intent lands on `onNewIntent`, which calls `setIntent(it)`. The
      // deep-link plugin reads `activity.intent` in `load(webView)` to find the launch URL, and the
      // WebView is still booting 1.5 s after the `am start` above: the plain intent wins, the URL is
      // gone, and every symptom points at the product. See `phone.ensure` for the measurement.
      const up = await phone.ensure({ port: PORTS.A1, timeoutMs: 45_000, keepIntent: true });
      if (!up.ok) throw new Error(`the phone never came back on devtools: ${JSON.stringify(up)}`);

      const a1 = await client(PORTS.A1);
      const wb = await watch(a1, 'A1');
      try {
        // A RESTARTED APP RE-LOCKS THE PIN, and everything behind the modal is unreachable - a
        // landing measured through a closed gate reads as "the deep link did nothing".
        const gateA1 = await unlockClient(a1, PORTS.A1, ACCOUNT_OF.A1, { match: 'tauri.localhost' });
        if (gateA1.verdict !== 'unlocked') return { gate: gateA1.verdict, said: gateA1.said };

        // The landing is not instant: the handler navigates, the sidebar loads, and the selection is
        // applied when the salon appears in it. Polled for the SALON being open, which is the
        // product's own statement about where the person is.
        const deadline = Date.now() + 90_000;
        let open = null;
        for (;;) {
          open = await selectedChannel(a1).catch(() => null);
          if (open === salon) break;
          if (Date.now() > deadline) break;
          await sleep(2000);
        }
        const url = await evaluate(a1, 'location.pathname').catch(() => null);
        // THE TRANSCRIPT IS NOT ON SCREEN THE MOMENT THE SALON IS. Read as though it were, this
        // reported `markerSeen: 0` on 2026-08-25 in a salon the same run had just proved open, and
        // called a landing that worked a failure. A cold-started process reaches the right PLACE
        // first and rebuilds its store from disk after: the landing is a navigation, the messages
        // are a decryption, and nothing makes them simultaneous. An absence read the instant the
        // selection lands is an instrument that never waited for what it was looking for.
        //
        // WAITED FOR HERE RATHER THAN BY WIDENING THE SELECTION POLL ABOVE, because the two are
        // different claims: `theSalonIsOpen` has to stay answerable on its own for the case where
        // the person arrives and the transcript is the half that fails.
        const t0 = Date.now();
        const missed = await awaitMessage(a1, marker, 60_000).then(
          () => null,
          (e) => (e instanceof Error ? e.message : String(e))
        );
        const seen = await countMessage(a1, marker).catch(() => 0);

        // WHY THE TRANSCRIPT IS ABSENT, CAPTURED WHILE THE SALON STILL EXISTS. This row deletes its
        // own venue a few lines below, so a missed marker investigated afterwards has nothing left
        // to look at: on 2026-08-25 it reported `hasPane: true, renderedParagraphs: 0` in a salon it
        // had just proved open, and there was no way to tell an undelivered message from an
        // undecryptable one from a rendering that never ran. Three readings separate them, and only
        // the first is free of the phone: the SERVER's row count says whether there was anything to
        // read at all, the SEEDS say whether this device could open it, and the lines say whether
        // the client knew it could not. Taken only on a miss - a passing row pays nothing for it.
        const why = missed
          ? {
              onServer: channelId ? messageCount(channelId) : null,
              seeds: await seedsForChannel(a1, channelId).catch((e) => ({
                error: e instanceof Error ? e.message : String(e),
              })),
              // Read AGAIN here, so the pair says whether the landing itself enrolled the phone: a
              // roster that gained its leaf between the two reads means the load did its half and
              // the seed was simply already gone.
              roster: channelId ? salonDistribution(channelId) : null,
              said: phone
                .console_(4000)
                .filter((l) => /\[GRAINE\]|unreadable|no seed for session/.test(l))
                .slice(0, 20),
            }
          : null;
        // FROM LOGCAT, NOT FROM THE ATTACHED CONSOLE, and that is the whole reason this row read
        // `theDeepLinkReachedTheHandler: false` beside `theSalonIsOpen: true` - a contradiction
        // that accused the native chain of failing while the person was demonstrably standing in
        // the salon. `hooks.client.ts` writes the line during client init, which is BEFORE the
        // process has a devtools socket to forward, so `watch()` here cannot attach until after
        // the event it was asked to witness. `attachConsole` mirrors the app's console into
        // logcat, whose buffer predates the launch, so the line was never missing - the
        // instrument was late, and an instrument that cannot see an event must not report it
        // absent.
        const shell = phone.console_(4000);
        const lines = consoleLines(wb.cx);
        return {
          gate: gateA1.verdict,
          open,
          url,
          seen,
          // HOW LONG THE TRANSCRIPT TOOK, and what the pane looked like if it never came. A cold
          // start that lands correctly and shows its messages a minute later is not this row's
          // PASS/FAIL, but it is the number the next person will want, so it is never dropped.
          markerMs: missed ? null : Date.now() - t0,
          markerMissed: missed,
          why,
          // The one line that says the native half worked, and the ones around it if it did not.
          handlerSaid: shell.filter((l) => /\[notifNav\] deep link received/.test(l)),
          hooksSaid: shell.filter((l) => /\[hooks\]/.test(l)).slice(0, 12),
          // Kept beside them: a line in logcat and none here is this row's NORMAL shape, because
          // the app started before the attachment. The reverse would mean logcat was cleared
          // under us, and the two sources disagreeing is itself worth reading.
          attachedConsoleLines: lines.length,
          // THIS CHECK PERFORMED THE COLD START, so it owns its narration and nothing else: the
          // token the app re-registers and the frames it pre-injects from the FCM cache are this
          // row's own gesture talking. Four needles, not a phase-wide amnesty - anything else a
          // resurrected app says is still dirt, and `COLD_START_NARRATION` keeps the injection
          // counts inside the shape so forgiving the line cannot forgive a wrong count.
          report: [
            (r) => ignoringExpectedLog(r, COLD_START_NARRATION),
            (r) => ignoringExpectedLog(r, DEEP_LINK_NARRATION),
            (r) => ignoringExpectedLog(r, LOCAL_ESTATE_MEDIA_NARRATION),
            (r) => ignoringExpectedRefusal(r, LOCAL_ESTATE_MEDIA_GAP),
            (r) => ignoringExpectedRefusal(r, STOPPED_APP_SESSION_REFUSAL),
          ].reduce((r, f) => f(r), await report(wb)),
        };
      } finally {
        a1.close();
      }
    })
  : null;

// -- Its own debris goes -------------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  // The handler ran at all, and it read the target out of the url.
  theDeepLinkReachedTheHandler: (landing?.handlerSaid?.length ?? 0) > 0,
  // The route the target belongs to. A channel that landed on `/chat` is `chatDeepLinkRoute` wrong.
  theAppLandedOnTheCommunitiesRoute: landing?.url === '/communities',
  // Where the person actually is, in the product's own words.
  theSalonIsOpen: landing?.open === salon,
  // And it is really that salon, not an empty pane wearing its name.
  theMessageIsOnScreen: (landing?.seen ?? 0) > 0,
};

const verdict =
  !armed || landing?.gate !== 'unlocked'
    ? 'VACUOUS'
    : stepErrors.length > 0 || Object.values(expectations).some((v) => v !== true)
      ? 'FAIL'
      : 'PASS';

// THE ANSWERER'S OWN ACCOUNT, read before the gate drains nothing and recorded either way. W1 is
// the device that holds the seed A1 is missing, and until 2026-08-25 its reply left as
// `DELIVERY.transport` - which the server drops for a recipient presence reports offline, so a
// cold-started phone with HTTP but no socket yet lost the answer to a question it had just asked.
// The line now names the class it used, and this is where a run puts that on the record.
//
// CONTEXT, NEVER AN ASSERTION. This row's question is the landing, and a run where the phone joined
// the group in time needs no repair at all - asserting the repair fired would fail a row for
// succeeding by an easier route. What it buys is that a PASS says WHY it passed, and a FAIL says
// whether the answer was even sent.
const answeredAs = consoleLines(wa.cx).filter((l) => /\[GRAINE\] answered /.test(l));

const gated = gate(verdict, { W1: await report(wa), A1: landing?.report ?? null });

record('COMM-18', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  link,
  armed,
  // Context, never an assertion: this row's question is the landing, and a roster is how a miss
  // gets attributed rather than guessed at.
  distAtSend,
  answeredAs,
  // A1's build is named beside its answer: its APK is deliberately not the deployment.
  a1Build: a1Before?.commit ?? null,
  a1BuiltAt: a1Before?.builtAt ?? null,
  a1Gate: landing?.gate ?? null,
  // WHAT THE UNLOCK ITSELF SAID, and it is recorded because a verdict of `LOCKED` has at least three
  // causes that read alike: the PIN was refused, the modal never mounted, or the tool never reached
  // the phone at all. `unlockClient` has always returned this sentence and this row dropped it, so
  // two runs on 2026-09-05 recorded `a1Gate: LOCKED` with nothing to say which of the three it was.
  a1GateSaid: landing?.said ?? null,
  openedChannel: landing?.open ?? null,
  landedOn: landing?.url ?? null,
  markerSeen: landing?.seen ?? null,
  markerMs: landing?.markerMs ?? null,
  markerMissed: landing?.markerMissed ?? null,
  // Null on a pass, and the whole account of the failure otherwise.
  why: landing?.why ?? null,
  handlerSaid: landing?.handlerSaid ?? null,
  // Recorded whether or not the handler line came: when it did not, these are the only account of
  // how far the chain got.
  hooksSaid: landing?.hooksSaid ?? null,
  ...expectations,
  // EVERYTHING THAT WENT WRONG, IN ONE LIST, so `failures: []` means exactly what it reads as. A
  // step that threw and an expectation that came back false are the same news to whoever reads the
  // row back, and keeping them in two fields let one of them be empty while the row said FAIL.
  failures: [
    ...stepErrors,
    ...Object.entries(expectations)
      .filter(([, v]) => v !== true)
      .map(([k]) => `expectation not met: ${k}`),
  ],
});

w1.close();
