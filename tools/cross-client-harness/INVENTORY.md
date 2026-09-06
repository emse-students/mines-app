# The harness, script by script

**GENERATED - do not edit.** `bun inventory.mjs` rewrites this file from the leading docblock of
every script; `bun inventory.mjs --check` fails `make test-harness` when it is out of date, so it
cannot drift from the tree. To change a line here, change the docblock of the script it names.

**Read this before writing a new script.** The rig is large and the reason it grew duplicates is
that gestures were not findable - three `createGroup`s, and a session that re-coded what already
existed. Search this file first.

**A script is filed by what it DOES, not by which directory it sits in.** A row writes a verdict
to `results.ndjson`; everything else is a gesture, a library or a runner, wherever it lives. That
distinction is recomputed on every run, so a heading here cannot go stale - and it matters,
because 39 gestures under `archive/` used to be announced as questions, which is a good way to
make a gesture as unfindable as leaving it out entirely.

## Atoms and libraries - the harness root

One GESTURE each, or the vocabulary a gesture is built from. An atom ends on a fact rather than a clock, reads before it acts so a second call is a read, and addresses the product structurally rather than by pixel or wording. See [`atoms.mjs`](atoms.mjs) for the contract and the grouped inventory.

52 scripts.

| script | what it is |
|---|---|
| `a1apk.mjs` | BUILD THE A1 APK AGAINST THE LOCAL ESTATE, INSTALL IT, AND PROVE THE PHONE IS RUNNING IT. |
| `accounts.mjs` | The ONE reader of `test-accounts.json`. |
| `arm.mjs` | The one module in this harness that WRITES to production, and the distinction it turns on. |
| `atoms.mjs` | THE ATOMS - every gesture this rig can make, in one place, each with its contract. |
| `bundle.mjs` | WHICH BUNDLE A WEB CLIENT IS RUNNING, and the repair when it is not the deployed one. |
| `cdp.mjs` | Dependency-free Chrome DevTools Protocol driver for the cross-client test campaign |
| `chat.mjs` | Chat primitives shared by every check in the campaign. |
| `checks.mjs` | THE MANIFEST: which script covers which phase, and what each phase needs to be meaningful. |
| `cleanup.mjs` | Deletes the communities, the salons AND the throwaway GROUPS a CRASHED check left on THE ESTATE |
| `comm.mjs` | The vocabulary the COMM phase is written in: communities, channels, invitations, roles. |
| `debris.mjs` | THE ONE ALLOWLIST OF THROWAWAY GROUP NAMES, shared by every sweep that may delete one. |
| `deploy.mjs` | WAS PRODUCTION REDEPLOYED WHILE THE CHECK WAS RUNNING? - the one cause of transport failure that |
| `deployed-wasm-check.mjs` | Asks a DEPLOYED estate whether the `mls-core` WebAssembly it serves can panic on the target it |
| `device-census.mjs` | THE PURE HALF OF THE DEVICE CENSUS - the SQL text, and every function that turns one of its rows |
| `device.mjs` | WHICH CLIENT AN ATOM IS ABOUT, resolved once, in one place. |
| `devices.mjs` | THE DEVICE CENSUS - every device the platform knows, with its runtime, OS, app version, owner, |
| `estate-origins.mjs` | WHICH ESTATE A RUNNING CLIENT IS ACTUALLY TALKING TO, as a pure function of what it fetched. |
| `estate.mjs` | WHICH ESTATE A QUERY IS ABOUT, DERIVED FROM THE ONE CONSTANT THAT DECIDES WHERE THE CAMPAIGN RUNS. |
| `fixtures.mjs` | WHERE A STAGED INPUT FILE LIVES - resolved from the HARNESS ROOT, never from the caller. |
| `gate-probe.mjs` | The ONE expression that answers "is the encryption PIN gate on screen". |
| `grainedb.mjs` | The three questions the COMM phase cannot ask a SCREEN, asked of production's database instead. |
| `groupnav.mjs` | Opening a GROUP conversation by name, and proving the right one opened. |
| `instrument.mjs` | THE HASH OF WHAT A CHECK MEASURES WITH, as opposed to the hash of the check itself. |
| `inventory.mjs` | THE INDEX OF EVERY SCRIPT IN THIS RIG, GENERATED FROM THE SCRIPTS THEMSELVES. |
| `invite.mjs` | Invites a user into the open group conversation - i.e. produces an MLS Add commit. |
| `launch.mjs` | Launching and killing the two test browsers. |
| `login.mjs` | Drives the login for one of the campaign accounts, over CDP. |
| `logs.mjs` | READS THE LOGS OF ONE SUBJECT - a web client, the phone, or the estate - and classifies them. |
| `marker.mjs` | THE MARKER VOCABULARY: minting one, recognising one in rendered text, and decoding when it was |
| `names.example.mjs` | TEMPLATE for the ONE machine-local file this rig needs. Setting it up is two steps, because the |
| `native-residue.mjs` | WHAT of a phone's account state is still on disk, as a classification of paths. |
| `newgroup.mjs` | Creates a group conversation, and reports the surface that adds a member to it. |
| `overlay-probe.mjs` | THE ONE EXPRESSION THAT ANSWERS "what is covering the screen right now" - page source, kept PURE. |
| `phone.mjs` | The phone, as seen from a check: adb, app lifecycle, notifications, and the WebView. |
| `pin.mjs` | Enters the encryption PIN in the web unlock modal, over CDP. |
| `purge-devices.mjs` | Deletes NAMED devices of an account, through the real UI. |
| `recv.mjs` | Waits for one message to ARRIVE on one client, and ends on the bubble rather than on a clock. |
| `reload.mjs` | Reloads the web clients onto the CURRENTLY DEPLOYED bundle, and proves it took. |
| `results.mjs` | Append-only result log for the campaign. |
| `rows.mjs` | THE BOARD AND THE EVIDENCE, RECONCILED - which rows nothing has ever answered, and which answers |
| `scriptpath.mjs` | WHERE ONE OF THIS RIG'S SCRIPTS ACTUALLY LIVES, resolved once instead of guessed four times. |
| `send.mjs` | Sends one message from one client, and ends when that client's own pane shows it. |
| `serial.mjs` | WHICH PHONE adb SHOULD TALK TO - one resolver, and it REFUSES TO GUESS between two of them. |
| `shot.mjs` | Saves a PNG of a client, so a layout claim is LOOKED AT rather than inferred. |
| `srcscan.mjs` | READING A SCRIPT AS CODE RATHER THAN AS TEXT. |
| `srvlog.mjs` | THE THIRD OBSERVER: production's own logs, classified the way the browser's are. |
| `ssh.mjs` | THE ONE WAY THIS HARNESS REACHES PRODUCTION. |
| `state.mjs` | One-line health read of every web client - the thing to run when a check behaves oddly. |
| `stranded.mjs` | WHAT THE VENUE CHANNEL'S HISTORY PERMANENTLY CONTAINS, AND THE ONLY 404s IT MAY PRODUCE. |
| `unlock.mjs` | Unlocks every client that needs it, resolving WHICH ACCOUNT owns each port by itself. |
| `venue.mjs` | Builds the campaign's SHARED venue if it is not there, and states what it found if it is. |
| `watch.mjs` | Continuous observation of a client while a check runs: console, page errors, HTTP, WebSocket. |

## Primitives that carry their own row

A gesture other rows REST ON, measured by a row of its own so a failure in it is attributed to it rather than to everything built on top. It writes a verdict, so it is not an atom by the strict reading - and that is deliberate, not an accident of filing.

1 script.

| script | what it is |
|---|---|
| `newdevice.mjs` | TURNS A BROWSER PROFILE INTO A DEVICE THE SERVER HAS NEVER SEEN, and measures that it did. |

## Rows - `archive/`

One QUESTION each, composed of gestures, ending in a verdict in `results.ndjson`. See [`archive/README.md`](archive/README.md).

64 scripts.

| script | what it is |
|---|---|
| `archive/comm1.mjs` | COMM-1: a community, a channel, a message - and both peers converge on it. |
| `archive/comm11.mjs` | COMM-11: kicked from a community, and taken out of every private salon inside it. |
| `archive/comm12.mjs` | COMM-12: re-invited after a removal - what comes next arrives, what was missed does not come back. |
| `archive/comm13.mjs` | COMM-13: an administrator JOINS a private salon, and the salon records nothing about it. |
| `archive/comm14.mjs` | COMM-14: the three channel notification levels, decided by the SERVER, observed on a real phone. |
| `archive/comm15.mjs` | COMM-15: a poll is created, voted on and closed - and the server never learns what it asked. |
| `archive/comm16.mjs` | COMM-16: deleting a channel, then the whole community, and what must be left behind - nothing. |
| `archive/comm17.mjs` | COMM-17: the community rail is reordered by DRAGGING, and the new order is the account's, not the |
| `archive/comm18.mjs` | COMM-18: the app is not running, a link names a salon, and the person lands IN that salon. |
| `archive/comm19.mjs` | COMM-19: the last administrator cannot leave, and the last MEMBER takes the community with them. |
| `archive/comm2.mjs` | COMM-2: an invite link, from minting it to being a member because of it. |
| `archive/comm20.mjs` | COMM-20: two administrators change the same role at the same moment. |
| `archive/comm21.mjs` | COMM-21: someone is removed from a private salon with a half-written message still on screen. |
| `archive/comm22.mjs` | COMM-22: a salon carrying MANY Graine sessions - what it costs to read, and what repairs a gap. |
| `archive/comm2324.mjs` | COMM-23 and COMM-24: a salon's visibility switch, in both directions, read from the database. |
| `archive/comm25.mjs` | COMM-25: one account's SECOND device is carried into a private salon by the first one's join. |
| `archive/comm3.mjs` | COMM-3: the four ways an invite link stops working, and the one control proving they are refusals. |
| `archive/comm4.mjs` | COMM-4: a DIRECT invitation, and the one card it is allowed to leave on each side. |
| `archive/comm5.mjs` | COMM-5: a promotion, twice, and the capability that is supposed to arrive with it. |
| `archive/comm6.mjs` | COMM-6: the permission grid offers the SIX permissions something enforces, and no seventh. |
| `archive/comm7.mjs` | COMM-7: a salon only administrators may write in - and the refusal has to be the SERVER's. |
| `archive/comm8.mjs` | COMM-8: a private salon is invisible to a non-member, unfetchable by them, and NEVER SENT ITS SEED. |
| `archive/comm910.mjs` | COMM-9 and COMM-10: what losing access to a private salon takes away, and what it deliberately does not. |
| `archive/del.mjs` | DEL-2..10 - deleting a conversation while something else is still happening to it. |
| `archive/del1.mjs` | DEL-1 - the peer deletes a group while the other side is awaiting its history. |
| `archive/fwd.mjs` | FWD-1 / FWD-2 - the WP-FWD-1 reproduction attempt, channel -> DM. |
| `archive/fwd345.mjs` | FWD-3, FWD-4, FWD-5 - the three forward shapes WP-FWD-1 has not been tried against. |
| `archive/fwd5.mjs` | FWD-5, isolated and repeated - the shape that just lost a forward. |
| `archive/grp.mjs` | GRP-1..10 - group membership: the roster, the TWO different departures, the invitation link, and |
| `archive/heal-a1.mjs` | HEAL on the PHONE - the ANDROID half of WP-LOSS-1, which is what is still owed. |
| `archive/heal-w2.mjs` | HEAL-W2 - the UNKNOWN-GROUP path on the browser. |
| `archive/heal-web.mjs` | HEAL on the BROWSER: a group broken by a deliberate ratchet rewind - does it repair itself, and |
| `archive/heal.mjs` | After the generation-gap escalation: does the conversation HEAL, i.e. does the NEXT message |
| `archive/healnew.mjs` | THE NEW-DEVICE HEAL ROWS - one runner, one row per invocation. |
| `archive/healrevoke.mjs` | THE REVOKED DEVICE THAT COMES BACK AFTER THE WORLD MOVED - one runner, one row per invocation. |
| `archive/k.mjs` | NOTIF-6c - the notification QUICK REPLY from a merely BACKGROUNDED app (WP-NOTIF-1). |
| `archive/life.mjs` | LIFE-1..8 - the phone in every state an OS can put it in, one check per run. |
| `archive/mention.mjs` | MENTION-1..6 - the @mention composer, the cleartext `mentionedUserIds` routing hint it produces |
| `archive/msg1.mjs` | MSG-1: W1 -> W2, both foreground, DM, plain text. One copy, correct author, and it STAYS. |
| `archive/msg10.mjs` | MSG-10 - the SENDER is offline. |
| `archive/msg1b.mjs` | MSG-1b: a message that arrives DURING a history load must survive it. |
| `archive/msg2.mjs` | MSG-2: W2 -> A1, phone app in the FOREGROUND. DM. Expect in-app delivery, exactly one copy. |
| `archive/msg3.mjs` | MSG-3: W1 -> W2, reply to a message. Expect the quoted parent to render on BOTH sides. |
| `archive/msg4.mjs` | MSG-4 - media: W1 sends an image, then a PDF, to W2's DM. |
| `archive/msg5.mjs` | MSG-5: W1 -> the campaign channel, with W2 and A1 as members. |
| `archive/msg67.mjs` | MSG-6 (link preview through the proxy) and MSG-7 (30 rapid sends). |
| `archive/msg8.mjs` | MSG-8 - A1 sends while W2's tab is BACKGROUNDED. |
| `archive/msg8b.mjs` | MSG-8b - the unread SIGNAL, which MSG-8a could not see. |
| `archive/msg9.mjs` | MSG-9 - the RECEIVER is offline when the message is sent. |
| `archive/multi.mjs` | MULTI - one user, two devices. Rung 12 of the ladder. |
| `archive/mut.mjs` | MUT-1..21 - message mutation (edit, delete, react, pin) on both transports. |
| `archive/notif.mjs` | NOTIF-1b / NOTIF-4 / NOTIF-4b / NOTIF-9 / NOTIF-10 / NOTIF-11 - the notification surface, one |
| `archive/notif7.mjs` | NOTIF-7 - tapping a notification deep-links into the RIGHT conversation. Run TWICE. |
| `archive/pinrows.mjs` | PIN - the encryption gate, one row per invocation. |
| `archive/read.mjs` | READ-1..10 - MLS read receipts: the sidebar unread badge, and the sender's own |
| `archive/roster.mjs` | THE MEMBERSHIP TABLE ITSELF - the four rows nothing on this board could have caught. |
| `archive/search.mjs` | SEARCH-1..6 - the two searches this app has (in-conversation full-history, and the sidebar |
| `archive/tab1.mjs` | TAB-1 - the OS notification for a message, and the silence that must precede it. |
| `archive/tab236.mjs` | TAB-2, TAB-3 and TAB-6 - the three ways a client goes away and comes back. |
| `archive/tab3b.mjs` | TAB-3b - five cold starts, and what each one spent its time on. |
| `archive/tab4.mjs` | TAB-4 - two tabs of the SAME account, open at once. |
| `archive/tab5.mjs` | TAB-5 - reload fired within ~100 ms of submitting a message. |
| `archive/tab7.mjs` | TAB-7 - offline, then act, then online, with the tab NEVER reloaded. |
| `archive/type.mjs` | TYPE-1..5 - the typing indicator, on both transports. |

## Self-tests - `archive/`

These test the HARNESS, not the product, and record nothing: they are the gated suite `make test-harness` runs. A failure here means an instrument is lying, which is worse than a failing row.

20 scripts.

| script | what it is |
|---|---|
| `archive/checks-selftest.mjs` | Asserts that every phase DECLARES the devices its scripts actually drive. |
| `archive/classify-selftest.mjs` | THE CLASSIFIER, RUN OVER LINES WHOSE RIGHT BUCKET IS KNOWN. |
| `archive/debris-selftest.mjs` | Asserts that the allowlist deciding what may be DESTROYED matches every name a runner mints, and |
| `archive/devices-selftest.mjs` | SELFTEST FOR THE DEVICE CENSUS - pins the classification against rows measured on production. |
| `archive/estate-selftest.mjs` | WHICH ESTATE A CLIENT IS ON IS A GATE, AND A GATE THAT ONLY EVER ACCEPTS IS NOT ONE. |
| `archive/exit-selftest.mjs` | A CHECK MAY NOT REPORT SUCCESS AND END IN THE SAME BREATH. |
| `archive/gate-probe-selftest.mjs` | `pin.mjs`'s gate probe, exercised on the pages it has to tell apart. |
| `archive/gate-selftest.mjs` | EVERY SELF-TEST IN THE CI GATE MUST BE IMPORTABLE ON A MACHINE THAT HAS NO RIG. |
| `archive/instrument-selftest.mjs` | THE HASH THAT SAYS WHAT A CHECK MEASURES WITH IS ONLY WORTH ANYTHING IF IT SEES EVERY FILE. |
| `archive/logcatclassify-selftest.mjs` | EVERY RULE OF THE PHONE CLASSIFIER, PINNED AGAINST A LINE WHOSE BUCKET IS KNOWN. |
| `archive/lucide-selftest.mjs` | EVERY `.lucide-*` CLASS THIS RIG AIMS AT MUST BE ONE THE APPLICATION ACTUALLY RENDERS. |
| `archive/origin-selftest.mjs` | NO CHECK MAY SPELL THE APPLICATION'S ORIGIN. `SITE` IS WHERE THE ESTATE IS NAMED. |
| `archive/ports-selftest.mjs` | A RUNNER MUST SAY WHICH DEVICE IT IS ABOUT. `names.mjs` IS WHERE A DEVICE IS NAMED. |
| `archive/ready-selftest.mjs` | The preflight's readiness probe, exercised on the pages it has to tell apart. |
| `archive/residue-selftest.mjs` | Pins the border between what a native wipe must leave nothing of and what it may leave. |
| `archive/servable-selftest.mjs` | The subset rule that decides HEAL-NEW-2 and -12, exercised on the sidebars it has to tell apart. |
| `archive/spawn-selftest.mjs` | A SPAWN GIVEN A NAME IT CANNOT RESOLVE FAILS SILENTLY, AND THIS RIG HAS PAID FOR IT NINE TIMES. |
| `archive/srvclassify-selftest.mjs` | THE SERVER CLASSIFIER AND ITS NORMALISER, RUN OVER LINES WHOSE RIGHT BUCKET IS KNOWN. |
| `archive/tabguard-selftest.mjs` | DOES THE REFUSAL FIRE? A guard that has never been seen to trigger is a guard nobody has tested. |
| `archive/usability-selftest.mjs` | WHAT COUNTS AS THE APP ANSWERING A CLICK - the two predicates and the two targets that decide |

## Gestures, libraries and runners in `archive/`

They live under `archive/` but they are NOT questions - they take no verdict. Runners that drive other rows, probes, and vocabulary that never moved to the root. **Search here before writing a gesture**: this is the half that used to be filed as rows, where nobody looking for a gesture would ever have found it.

40 scripts.

| script | what it is |
|---|---|
| `archive/addmember.mjs` | ADDING A MEMBER TO A GROUP - one gesture, because three call sites each learnt a different third |
| `archive/bundle-id.mjs` | Reports which build each web client is running, and refuses the run when one is stale. |
| `archive/burn.mjs` | DOES A RELOAD INSIDE THE CHECKPOINT WINDOW STILL COST A MESSAGE? |
| `archive/check-feed-retry.mjs` | Verifies that the feed's "Reessayer" actually brings the posts back. |
| `archive/check-pdf-anchor.mjs` | Verifies that pinching a PDF zooms ABOUT THE PINCHED POINT - the thing the previous check missed. |
| `archive/check-pdf-render.mjs` | Verifies the two things the user reported about the PDF reader's zoom: |
| `archive/circuit.mjs` | WP-RECONNECT-1 - is this client's reconnect circuit OPEN, and can anything still close it? |
| `archive/ckpt.mjs` | Reads the checkpoint cost per PLATFORM out of a run's captures. |
| `archive/deadrows.mjs` | DEAD CONVERSATION ROWS ON A DEVICE - list them, and dismiss the ones you name. |
| `archive/dismiss.mjs` | Clears the CLIENT-SIDE half of a deleted throwaway group: the conversation a member's device |
| `archive/footprint.mjs` | What is LEFT on a device, read off the device instead of out of its own log. |
| `archive/gateway.mjs` | Proves that each client's GATEWAY SOCKET is up - the pre-flight gate the campaign was missing. |
| `archive/grainestore.mjs` | The Graine seed store as the CLIENT holds it, read from the browser's own IndexedDB. |
| `archive/idb.mjs` | Reading the app's OWN IndexedDB from outside it - one implementation of the awkward part. |
| `archive/idcheck.mjs` | Does anything STAGED carry a real identity? Run it before every commit that touches this rig. |
| `archive/identity.mjs` | Fingerprints each client's IDENTITY - the pre-flight gate that says the two Chrome profiles are |
| `archive/ladder.mjs` | WP-RECONNECT-1's owed PROSPECTIVE proof: the reconnect ladder no longer terminates on a count. |
| `archive/mlsdb.mjs` | Snapshot / restore of the browser's MLS state, which is what makes the HEAL phase possible at all. |
| `archive/nav.mjs` | Client-side navigation to a route, for clients that may be sitting anywhere. |
| `archive/navclose.mjs` | Does a navigation produce EXACTLY one socket close, and is the document replacement observable? |
| `archive/net.mjs` | Cutting a client off the network, and proving it was really cut. |
| `archive/onetab.mjs` | ONE APP TAB PER BROWSER. Reports what is open, and closes every extra. |
| `archive/pingate.mjs` | The PIN gate as a library: enter the PIN, then PROVE the client came out the other side. |
| `archive/presence.mjs` | Asks the GATEWAY whether each client's socket is really up - the pre-flight gate MSG-2 was |
| `archive/rawcheck.mjs` | A BACKSLASH IN A PAGE-SIDE TEMPLATE BELONGS TO NODE, NEVER TO THE PAGE. |
| `archive/ready-probe.mjs` | THE ONE ANSWER TO "can this client be asked a question yet", and the repair that gets it there. |
| `archive/ready-repair.mjs` | BRINGING ONE DEVICE TO A NAMED STARTING POINT - the half of the readiness probe that acts. |
| `archive/recon.mjs` | Reconciles what two clients hold for the conversations they SHARE, message id by message id. |
| `archive/run.mjs` | THE ONE WAY TO RUN THE CAMPAIGN. |
| `archive/servable.mjs` | WHICH ROWS A GIVEN RESPONDER COULD ACTUALLY HAVE SERVED - the predicate, with nothing attached. |
| `archive/synboot.mjs` | WP-BANNER-1's positive check: does the synchronisation banner rise AT STARTUP? |
| `archive/syncrows.mjs` | WHAT A DEVICE IS STILL WAITING FOR, AND HOW LONG IT HAS BEEN WAITING - the reader every HEAL row |
| `archive/synopen.mjs` | One-shot: banner transitions DURING the openChannel sequence, beside the console. |
| `archive/synwatch.mjs` | One-shot: does the "Synchronisation des messages..." banner appear when NOTHING is happening? |
| `archive/tab1probe.mjs` | WHY DID A HIDDEN TAB RAISE NO NOTIFICATION - a probe, not a row. |
| `archive/tabs.mjs` | Backgrounding a page, the ONLY way that works here. |
| `archive/usability.mjs` | WHAT COUNTS AS THE APP ANSWERING A CLICK ON A CONVERSATION TILE. |
| `archive/ws1.mjs` | WHAT closes W1's WebSocket in the middle of READ-1, and what does the page say while it happens? |
| `archive/wsclose.mjs` | SUPERSEDED 2026-08-15 - ITS ANSWER WAS TRUE AND THE CONCLUSION DRAWN FROM IT WAS WRONG. |
| `archive/wsidle.mjs` | How often does an IDLE client's chat socket die, and does it die the same way on both browsers? |

---

177 scripts in total.
