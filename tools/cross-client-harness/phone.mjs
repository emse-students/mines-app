/**
 * The phone, as seen from a check: adb, app lifecycle, notifications, and the WebView.
 *
 * The serial is RESOLVED, never hard-coded: this device's IP has already changed subnet between
 * sessions, and its USB link drops on its own. USB is preferred here (the opposite of `watch.mjs`)
 * because the LIFE phase cuts the radios, and a wireless transport dies with the wifi it rides on.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { A1_WIFI, ACCOUNT_OF, PORTS } from './names.mjs';
// A NAMESPACE IMPORT, DELIBERATELY. `SERIAL_OF` is newer than the out-of-tree `names.mjs` on any
// machine that has not added it yet, and a NAMED import of an absent export is a LINK error - the
// module cannot be imported at all, so every phone-less browser phase dies with it too. Read off the
// namespace instead and the omission surfaces where it can be explained: `useDevice` says which map
// to add the serial to. This is the trap `estate.mjs` records paying for once already.
import * as NAMES from './names.mjs';
import { classifyNativePaths } from './native-residue.mjs';

/**
 * WHICH PHONE, RE-EXPORTED FROM THE ONE RESOLVER. `a1apk.mjs` and `archive/fwd345.mjs` import
 * `serial` from here, and this module is still the right place to ASK from - it is the phone's
 * module. What moved to `serial.mjs` is the implementation, because `watch.mjs` needs the same
 * answer and cannot import this file: `names.mjs` is gitignored and `watch.mjs` is reachable from
 * two gated self-tests. The duplicate it used to keep silently drove the wrong phone; see
 * `serial.mjs` for the measurement.
 */
import { attached, serial } from './serial.mjs';
import { requireScript } from './scriptpath.mjs';

export { attached, serial };

/**
 * Binds THIS PROCESS to one named phone, and returns the serial it bound.
 *
 * It sets `ANDROID_SERIAL` rather than only this module's own variable, which is the point: the rig
 * shells out to `adb` from several places and spawns other atoms, and a binding only this module
 * honoured would leave those talking to whichever phone adb listed first. One name, one transport,
 * for every process below this one.
 *
 * @param name a device as `names.mjs` spells it - `A1`, `A2`.
 */
export function useDevice(name) {
  const want = NAMES.SERIAL_OF?.[name];
  if (!want) {
    throw new Error(
      `no serial known for device ${name} - add it to SERIAL_OF in the out-of-tree names.mjs ` +
        `(the template is names.example.mjs). A serial is a device id and this repo is public.`,
    );
  }
  const ids = attached();
  if (!ids.includes(want)) {
    throw new Error(`device ${name} is not attached - adb lists: ${ids.join(' ') || '(nothing)'}`);
  }
  process.env.ANDROID_SERIAL = want;
  SERIAL = want;
  return want;
}

// Exported so that the NATIVE driver (`a1.py`, uiautomator2) is pointed at the SAME transport this
// module is using. When both a USB and a wireless entry are attached - which is the normal state of
// this phone during a long run - `u2.connect()` with no serial raises rather than choosing, and it
// aborted a NOTIF-7 run at the tap with the notification already found and sitting in the shade.
//
// RESOLVED SAFELY AT IMPORT, because this used to throw here. A module that throws while being
// imported cannot be caught by the caller's logic - so with the phone unplugged, merely importing
// this file took down the whole runner, and every browser-only phase with it. The phone being absent
// must cost the phone's phases and nothing else. `run()` re-resolves (and throws properly) the first
// time anything actually needs the device.
export let SERIAL = (() => {
  try {
    return serial();
  } catch {
    return null;
  }
})();
export const PKG = 'fr.emse.canari';

// `dumpsys notification --noredact` on this phone is over a megabyte, which is exactly Node's
// default `maxBuffer` - so the call THROWS ENOBUFS and the check dies with a stack trace instead of
// a verdict. A dump that cannot be read is not "no notification".
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * One adb invocation, RE-RESOLVING the serial once if the transport it was using has gone.
 *
 * The serial is resolved at import, and this phone's USB link drops on its own mid-run - after which
 * every `adb -s <dead serial>` fails with `device '...' not found`. That is not a device that has
 * gone away, it is a device now reachable under a DIFFERENT name (the wireless entry), so a check
 * dying there is a harness fault: it happened, and it hung `notif7.mjs` and a probe after it. One
 * re-resolve, one retry; if the second attempt fails too the device really is gone and the error
 * must reach the caller.
 */
function run(args, timeout) {
  if (!SERIAL) SERIAL = serial(); // throws 'no adb device' with the real reason, at use rather than at import
  try {
    return execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER });
  } catch (e) {
    const gone = /not found|device offline|no devices/i.test(String(e.stderr || e.message));
    if (!gone) throw e;
    const next = serial(); // throws if there is genuinely nothing attached
    if (next === SERIAL) throw e;
    process.stderr.write(`[phone] transport ${SERIAL} is gone; retrying on ${next}\n`);
    SERIAL = next;
    return execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER });
  }
}

/** One adb shell command, returning stdout. */
export function sh(cmd, timeout = 30_000) {
  return run(['shell', cmd], timeout);
}

export const adb = (args, timeout = 60_000) => run(args, timeout);

/**
 * What the app still holds on DISK, which is the half no CDP connection can see.
 *
 * `footprint.mjs` measures the WebView's stores; on a phone those are only part of the answer,
 * because `wipeDeviceToFactory` also calls the native `delete_mls_state` and `clear_app_data`, and
 * both write to the Tauri app data directory rather than to any web origin. A row that asks whether
 * a revoked PHONE was really erased and reads only localStorage has measured the smaller half.
 *
 * COUNTS AND BYTES, NEVER PATHS: a file here is named after a user and a group, and this output is
 * read into a PUBLIC repository.
 *
 * @returns `{ files, bytes }`, or `{ error }` when the app's own data cannot be listed - which
 *   happens on a RELEASE build, where `run-as` is refused. That is a limit of the instrument and is
 *   reported as one, never as an empty device.
 */
/**
 * WHAT of the account is still on the native side, rather than how much.
 *
 * `nativeFootprint` answers a byte total, and a running WebView's own cache moves that by
 * megabytes in either direction: on 2026-08-28 it read 19 MB on a device whose account state was
 * gone and 31 MB on the same device once the account was back, so a difference in it proves
 * nothing either way. A revocation is judged by this instead - an empty list, or the names that
 * survived it.
 */
export function nativeResidue() {
  try {
    const root = '/data/data/' + PKG + '/';
    const out = sh('run-as ' + PKG + ' find /data/data/' + PKG + ' -maxdepth 2');
    const relative = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(root))
      .map((l) => l.slice(root.length));
    return classifyNativePaths(relative);
  } catch (e) {
    return { error: String(e.stderr || e.message).split(/\r?\n/)[0] };
  }
}

export function nativeFootprint() {
  try {
    // `run-as` is the only way in without root, and it needs a debuggable build.
    const out = sh(`run-as ${PKG} find /data/data/${PKG} -type f -printf '%s\n' 2>/dev/null`);
    const sizes = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
      .map(Number);
    return { files: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) };
  } catch (e) {
    return { error: String(e.stderr || e.message).split(/\r?\n/)[0] };
  }
}

/**
 * The app's pid, or null when it is not running.
 *
 * `pidof` EXITS 1 when nothing matches, so the un-caught form threw exactly in the case the LIFE
 * phase exists to create - the check died on the kill instead of measuring it.
 */
export const pid = () => {
  try {
    return sh(`pidof ${PKG}`).trim() || null;
  } catch {
    return null;
  }
};

/**
 * Forwards the devtools socket of the BROWSER holding the identity-provider page, discovered rather
 * than assumed, and says which app it belongs to.
 *
 * THE ASSUMPTION THIS REPLACES WAS "CHROME", AND IT COST A SILENT FAILURE. `login.mjs` computes a
 * Custom Tab port as `PORTS.A1 + 1` and then lists targets on it - but nothing ever created that
 * forward, and on this phone the browser handling the OIDC hop is not Chrome at all: it is
 * `org.lineageos.jelly`, this being a LineageOS device. So `casTab()` listed an unforwarded port,
 * found nothing, and the login clicked the launcher and then timed out on `Input.dispatchTouchEvent`
 * against a WebView that had already handed the page away. Nothing was ever typed into the IdP form,
 * and the only visible symptom was a phone sitting on "Redirection..." - measured 2026-09-04, and
 * spotted by the user watching the screen rather than by any check.
 *
 * HOW IT FINDS IT. `/proc/net/unix` lists every `webview_devtools_remote_<pid>` socket on the
 * device; the owner of each pid comes from `/proc/<pid>/cmdline`. This app's own pid is EXCLUDED,
 * and so is anything that is not plausibly a browser - a Google app keeps a WebView socket open at
 * all times and would otherwise be forwarded in its place. When several remain, the highest pid
 * wins: the browser that was launched most recently is the one holding the hop.
 *
 * @returns `{ ok, port, pkg, pid }`, or `{ ok: false, reason }` - never throws for "no browser is
 *   open", because that is the ordinary state of a phone that is already signed in.
 */
export function forwardIdpBrowser(port) {
  if (!port) throw new Error('forwardIdpBrowser needs a port - login.mjs calls it PORTS.A1 + 1');
  const mine = pid();
  const sockets = [
    ...sh('cat /proc/net/unix').matchAll(/webview_devtools_remote_(\d+)/g),
  ].map((m) => m[1]);
  const seen = [...new Set(sockets)].filter((p) => p !== mine);

  const owners = seen.map((p) => {
    let owner = '';
    try {
      owner = sh(`cat /proc/${p}/cmdline`).replace(/\0/g, ' ').trim();
    } catch {
      /* the process died between the two reads - it is not the one we want */
    }
    return { pid: p, owner };
  });

  // AN ALLOWLIST OF WHAT MAY BE FORWARDED, not a denylist of what may not. A denylist forwards the
  // next unknown WebView-bearing app to appear on the device and reports it as the browser.
  const BROWSERS = /(browser|chrome|jelly|firefox|fennec|webview|bromite|vanadium)/i;
  const found = owners
    .filter((o) => o.owner && BROWSERS.test(o.owner))
    .sort((a, b) => Number(b.pid) - Number(a.pid))[0];

  if (!found) {
    return {
      ok: false,
      reason: `no browser devtools socket on the device - saw: ${
        owners.map((o) => `${o.pid}=${o.owner || '?'}`).join(', ') || 'nothing'
      }`,
    };
  }
  adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${found.pid}`]);
  return { ok: true, port, pkg: found.owner.split(':')[0], pid: found.pid };
}

/**
 * (Re)points the devtools forward at the CURRENT process.
 *
 * The abstract socket carries the pid, so every process death - a force-stop, an `am kill`, a
 * reboot - leaves the old forward pointing at nothing. A check that forgets this does not fail: it
 * talks to a dead socket and reports the app as unresponsive.
 */
export function forwardDevtools(port) {
  // NO DEFAULT, deliberately. It used to be 9222 - the port A1 has not used since the two browser
  // profiles took 9223/9224 - so a caller that forgot the argument did not fail: it forwarded to a
  // port nothing reads and reported the app as unresponsive. A missing argument must be an error,
  // never a guess at which device was meant.
  if (!port) throw new Error('forwardDevtools needs a port - pass PORTS.A1');
  const p = pid();
  if (!p) throw new Error('app is not running - nothing to forward to');
  adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${p}`]);
  return p;
}

/**
 * Brings the phone to a state a check can actually measure, or explains why it cannot - and NEVER
 * throws for "the phone is not here".
 *
 * The ladder is USB, then wireless, then give up, in that order and for a reason: the LIFE phase
 * cuts the radios, so a wireless transport would die inside the very check that needs it. Wireless
 * is a way to finish a run whose cable has dropped, not a way to run.
 *
 * Every step below is one that has silently produced a wrong verdict:
 *
 *   - the device listed but the APP not running - the forward points at a dead socket and the app
 *     reads as unresponsive;
 *   - the app running but in the BACKGROUND - its WebView keeps the devtools socket listed and the
 *     `adb forward` succeeds, and CDP never answers, which reads as "not debuggable";
 *   - the forward left over from a previous pid, pointing at nothing or at another app's socket.
 *
 * So this does not report success until something has actually answered on the port.
 *
 * @returns `{ ok, how, pid, reason }` - `how` is 'usb' | 'wifi', `reason` is set only when `ok`.
 */
export async function ensure({ port, wifi, timeoutMs = 20_000, keepIntent = false } = {}) {
  const target = port ?? PORTS.A1;
  const address = wifi ?? A1_WIFI;

  let how = 'usb';
  try {
    SERIAL = serial();
    if (SERIAL.includes(':')) how = 'wifi';
  } catch {
    try {
      execFileSync('adb', ['connect', address], { encoding: 'utf8', timeout: 15_000 });
      SERIAL = serial();
      how = 'wifi';
    } catch {
      return { ok: false, how: null, reason: `no adb device on USB, and ${address} did not answer` };
    }
  }

  try {
    wake();
    // `keepIntent` says the caller has JUST started the app with an intent of its own, so starting it
    // again here would either be redundant or would replace that intent - see below.
    if (!pid() && !keepIntent) launch();
    const until = Date.now() + timeoutMs;
    while (!pid() && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    if (!pid()) return { ok: false, how, reason: 'app would not start' };

    // Foreground it unconditionally rather than testing first: raising an app already in front costs
    // nothing here, and `foregrounded()` reads a dumpsys line whose format has changed under us
    // before.
    //
    // `keepIntent` IS THE ONE CASE WHERE THAT IS WRONG, AND IT IS NOT A NO-OP. `launch()` is
    // `am start -n <pkg>/.MainActivity`: a plain MAIN intent with no data. `MainActivity` is
    // `launchMode="singleTask"`, so on a running app that intent arrives at `onNewIntent`, which
    // calls `setIntent(it)` - and the deep-link plugin reads `activity.intent` in its `load(webView)`
    // to find the URL the app was STARTED with. Fire this 1.5 s after an `am start -d <link>` and the
    // WebView is still booting: the plugin loads, reads the plain intent, and the launch URL is gone.
    //
    // That is how COMM-18 failed for a whole session on 2026-09-05. The row cold-starts the app with
    // a VIEW intent and then calls `ensure` to re-derive the devtools forward - and `ensure` deleted
    // the intent the row exists to measure. Every symptom pointed at the product: the listener
    // registered, `getCurrent()` returned nothing, the app sat on `/posts`. Driven by hand, with no
    // `ensure` in between, the same build read the URL on attempt 1 in 38 ms, every time.
    if (!keepIntent) {
      launch();
      await new Promise((r) => setTimeout(r, 1500));
    }

    const p = forwardDevtools(target);

    // THE PROOF. Everything above can succeed against a phone that will never answer.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${target}/json/version`);
        if (r.ok) return { ok: true, how, pid: p };
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, how, reason: `forward is up but CDP never answered on ${target}` };
  } catch (e) {
    return { ok: false, how, reason: String(e.message || e).slice(0, 160) };
  }
}

export const wake = () => {
  sh('input keyevent KEYCODE_WAKEUP');
  sh('wm dismiss-keyguard');
};

export const home = () => sh('input keyevent KEYCODE_HOME');
export const forceStop = () => sh(`am force-stop ${PKG}`);
export const launch = () => sh(`am start -n ${PKG}/.MainActivity`);

/**
 * THE PHONE AWAKE, THE APP IN FRONT, AND THE DEVTOOLS FORWARD DERIVED FROM THE PID THAT IS THERE NOW.
 *
 * ## The two failures this exists to stop, which look nothing alike
 *
 * **A BACKGROUNDED WEBVIEW NEVER ANSWERS.** Android throttles timers and network in a WebView that
 * is not on screen, so `clientBuild()` - a `fetch` of the app's own `/_app/version.json` - never
 * settles and the CDP call times out. Every `+A1` row leaves the app in the background: COMM-14
 * deliberately (a foreground app posts no tray notification), COMM-18 by force-stopping it. So the
 * NEXT row arms against that state, and on 2026-09-05 COMM-14, COMM-17 and COMM-18 each recorded a
 * timed-out build read for exactly this reason - one of them as `armed: false`, a row that measured
 * nothing and said so only in its failures list.
 *
 * **AND BRINGING IT FORWARD CAN INVALIDATE THE FORWARD.** The devtools socket is named after the
 * PID (`webview_devtools_remote_<pid>`), so if `launch()` starts a process rather than raising an
 * existing one, every later `client(PORTS.A1)` connects to a socket belonging to a process that no
 * longer exists - `The socket connection was closed unexpectedly`. Waking WITHOUT re-deriving the
 * forward therefore trades one failure for another, which is what the first version of this fix did.
 *
 * The two halves have to happen together and in this order, which is why this is one function and
 * not two calls a caller is trusted to remember.
 *
 * @param {number} port the devtools port for this device, from `PORTS`
 * @param {number} [timeoutMs] how long to wait for devtools to answer
 * @returns {Promise<object>} `ensure`'s result - `{ok, how, pid}`
 */
export async function foreground({ port, timeoutMs = 45_000 } = {}) {
  wake();
  launch();
  const up = await ensure({ port, timeoutMs });
  if (!up.ok) throw new Error(`the phone is not measurable after being brought forward: ${up.reason}`);
  return up;
}

/**
 * The app's current OOM state as Android names it (`CAC*` cached, `LAST` previous, `FGS`, ...), or
 * null when the process is gone or the dump cannot be read.
 *
 * The dump lists the WebView's sandboxed renderer under this package's uid as well, so the process
 * is matched on `<pid>:fr.emse.canari/` specifically - the renderer's own state answers a different
 * question and is usually one rung apart.
 */
export function procState() {
  let out;
  try {
    out = sh(`dumpsys activity processes ${PKG}`);
  } catch {
    return null;
  }
  const lines = out.split('\n');
  const own = new RegExp(`\\d+:${PKG.replace(/\./g, '\\.')}/`);
  for (let i = 0; i < lines.length; i++) {
    if (!own.test(lines[i])) continue;
    // The state sits on its own line just under the `Proc #` line it belongs to.
    for (let j = i; j < Math.min(i + 4, lines.length); j++) {
      const m = lines[j].match(/state:\s*cur=(\S+)/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Drops the app to CACHED, which is the precondition `am kill` has and HOME does not establish.
 *
 * `am kill` RECLAIMS A CACHED PROCESS AND NOTHING ELSE. After HOME the app holds Android's
 * "previous" slot - `state: cur=LAST` - whose adj sits below the threshold the command uses, so the
 * kill succeeds, prints nothing, and the process lives. That reads exactly like a kill the framework
 * ignored, and it cost NOTIF-4 its first run on 2026-08-16: `am kill did not kill the app`, with the
 * process measured at `LAST` two seconds after HOME, which is precisely how long the sleep was.
 *
 * Opening any OTHER app displaces it from that slot and it falls to cached. That is a STATE, so it
 * is polled for rather than slept on - the delay depends on what else the phone is doing, and a
 * fixed wait here is the same guess that failed above.
 *
 * `am force-stop` is not the alternative and must never become one: a force-stopped package sits in
 * Android's STOPPED state, where the framework cancels every FCM broadcast to it - destroying the
 * one thing every push check exists to measure.
 */
export async function evictToCache(timeoutMs = 20_000) {
  home();
  try {
    // Settings is the neutral displacer: present on every Android, and it starts without network,
    // account or notification state of its own that a later assertion could trip over.
    sh('am start -a android.settings.SETTINGS');
  } catch {
    // A device without it still reaches cached on its own eventually; the poll below decides.
  }
  const t0 = Date.now();
  let state = procState();
  while (Date.now() - t0 < timeoutMs) {
    state = procState();
    // ONLY THE CACHED FAMILY, and `LAST` was tried and reverted on 2026-08-22. MENTION-2 recorded
    // `stateAtKill: LAST` with `killedInMs: 77`, which read as "LAST is killable" - but that state
    // was read AFTER this poll had already spent its full 20 s, and the settling time was doing the
    // work, not the state's name. Breaking early on LAST killed a process Android had only just
    // demoted, and `am kill` was refused: "did not kill the app - pid 26586 is still alive".
    // The 20 s is the price of a kill that always lands. Rule: a predicate that named the last
    // observation is not the predicate that names the next one.
    if (state === null || state.startsWith('CAC')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  home();
  return state;
}

/**
 * The OS reclaiming the process, which keeps WorkManager state - not the user swiping it away.
 *
 * Establishes its own precondition (see {@link evictToCache}) rather than trusting the caller to
 * have slept long enough, because every caller had written the same two lines and all three were
 * wrong in the same way.
 *
 * @returns the state the process was in when the kill was issued - evidence for a kill that misses.
 */
export async function kill() {
  const state = await evictToCache();
  sh(`am kill ${PKG}`);
  return state;
}

/**
 * {@link kill}, and then PROOF the process is gone.
 *
 * A KILL THAT MISSED IS INDISTINGUISHABLE FROM A KILL THAT WORKED, right up until the check reads a
 * notification the running app was never going to show - or fails to, and reports it as the product
 * being silent. So the death is polled for rather than slept on, and a miss throws carrying the
 * state the process was in when the kill was issued, which is the only thing that separates "the
 * kill was refused" from "the process came straight back".
 *
 * Lives here rather than in a runner because both `notif.mjs` and `mention.mjs` need exactly this,
 * and the two copies would drift on the first fix.
 *
 * @returns {Promise<{deadInMs: number, stateAtKill: string|null}>}
 */
/** This directory - `pin.mjs` is SPAWNED from here, never imported. */
const HERE = new URL('.', import.meta.url).pathname.replace(/^\//, '');

/**
 * Unlocks the encryption PIN if the modal is up; returns what happened, never throws on "no modal".
 *
 * SPAWNED RATHER THAN IMPORTED, deliberately: the PIN is read by `pin.mjs` from `test-accounts.json`
 * and must never become an argument that a check could log, print or record.
 *
 * NOTIF-10 needed this and did not have it: cutting the radios for ten minutes restarts the app when
 * they come back, and a restarted app re-locks the PIN. The whole chat then sits behind the modal,
 * so `openConversation` cannot find anything and the check refused a verdict. EVERY PHASE THAT
 * RELAUNCHES THE APP MUST UNLOCK BEFORE IT NAVIGATES - which is why this is here and not in the
 * three runners that each carried their own copy of it.
 *
 * A FAILURE CARRIES THE REASON IT FAILED FOR, and this used to carry the 200 first characters of
 * STDOUT - the one stream that says nothing about why. `pin.mjs` has three distinct failures and
 * writes all three to stderr: exit 1 = the product REFUSED the PIN (and names which refusal), a
 * throw out of `assertLocalEstate` = the app is pointing at an estate that is not the local one,
 * and anything else = the CDP context died mid-answer. DEL-7 recorded
 * `pin.mjs failed: ...[pin] after:` on 2026-09-05 - a truncation ending on an EMPTY `after:`, which
 * is the most interesting line in the run and the one thing the record could not explain. Exit code
 * and stderr are what separate the three, so both are reported and the stdout TAIL keeps its place
 * as context rather than as the message.
 */
export function unlockPin(port = PORTS.A1) {
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
    const why = String(e.stderr || e.message)
      .trim()
      .replace(/\s+/g, ' ');
    const lastOut = String(e.stdout || '')
      .trim()
      .split('\n')
      .pop();
    return `pin.mjs failed (exit ${e.status ?? 'none'}): ${why.slice(0, 300)} [last stdout: ${lastOut}]`;
  }
}

export async function killAndProveDead(timeoutMs = 20_000) {
  const stateAtKill = await kill();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pid() === null) return { deadInMs: Date.now() - t0, stateAtKill };
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `am kill (state at kill: ${stateAtKill}) did not kill the app - pid ${pid()} is still alive`
  );
}

export const foregrounded = () => /fr\.emse\.canari/.test(sh('dumpsys window | grep mCurrentFocus'));

/**
 * Whether the DEVICE's own lock screen is up - which is not a question about this app, and is the
 * one that has to be asked first.
 *
 * A SECURE KEYGUARD IS INDISTINGUISHABLE FROM A BROKEN APP FROM INSIDE CDP. Behind it the WebView's
 * window is not visible, so Android freezes the renderer's network stack: a synchronous
 * `Runtime.evaluate` still answers off the main context - `location.href` comes back, and so does a
 * resolved promise - while every `fetch()` hangs for ever, including one for a static asset the APK
 * carries itself. The gateway then reports the device OFFLINE because its socket is gone too. So the
 * preflight saw "unlocked, 2 sidebar rows" from the store, and named the symptom it happened to time
 * out on: "A1 would not say which build it is running". Measured 2026-08-27, with the phone plugged
 * in, charging, on validated wifi and showing a fingerprint prompt.
 *
 * `wm dismiss-keyguard` CANNOT REPAIR THIS, which is why nothing here tries. It dismisses a
 * swipe-only keyguard; against a credential it merely raises the prompt, and no credential is in
 * this repo or belongs in it. The only fix is a human touching the sensor, so the value of this
 * function is entirely in SAYING SO instead of letting three probes fail in a row.
 *
 * @returns true when the keyguard is up, false when it is not, and null when the dump cannot be read
 *   - null being "do not know", which must never read as "unlocked".
 */
export function deviceLocked() {
  let dump;
  try {
    dump = sh('dumpsys trust');
  } catch {
    return null;
  }
  const m = /deviceLocked=(\d)/.exec(dump);
  if (!m) return null;
  return m[1] === '1';
}

/**
 * Every notification this app currently shows, as flat text.
 *
 * `--noredact` matters: without it the OS hides the text of notifications it considers sensitive,
 * and the check then reports "no content" for a notification that was perfectly decrypted.
 */
export function notifications() {
  const out = adb(['shell', 'dumpsys', 'notification', '--noredact'], 45_000);
  const blocks = out.split(/NotificationRecord\(/).slice(1);
  return blocks
    .filter((b) => b.includes(PKG))
    .map((b) => ({
      // `full` is what checks MATCH on; `text` is only what they PRINT. Matching on the truncated
      // form made LIFE-2 report "no notification" for a notification whose title and body were
      // right there in the same dump - the marker simply sat past the 900th character.
      full: b.replace(/\s+/g, ' '),
      text: b.replace(/\s+/g, ' ').slice(0, 900),
      title: (b.match(/android\.title=(?:String \()?([^\n)]*)/) || [])[1]?.trim() ?? '',
      body: (b.match(/android\.text=(?:String \()?([^\n)]*)/) || [])[1]?.trim() ?? '',
      // The two fields that decide whether that body reaches a SCREEN - see `bodyIsDrawn`.
      template: (b.match(/android\.template=(?:String \()?([^\n)]*)/) || [])[1]?.trim() ?? '',
      inboxLines: Number((b.match(/android\.textLines=CharSequence\[\] \((\d+)\)/) || [])[1] ?? -1),
    }));
}

/**
 * Whether this notification's body will actually be DRAWN, as opposed to merely carried.
 *
 * A DUMP IS NOT A SCREEN, AND THIS HARNESS SPENT A DAY BELIEVING IT WAS. Every notification check
 * here matches on `full`, the whole `NotificationRecord` block - so `android.text` holding the right
 * string satisfied all of them. On 2026-09-06 a Mi 9T drew a Canari notification as a sender's name
 * with nothing under it while that same record carried the decrypted message, and NOTIF-1b had just
 * passed its `itCarriedTheMessageAndNotJustASenderName` clause on exactly that. `GENERIC_BODIES`
 * could not help: the body was not generic, it was invisible.
 *
 * The cause is mechanical, so the test is too. `tauri-plugin-notification` sends `"inboxLines": []`
 * on every notification (a plain `Vec` with `#[serde(default)]` and no `skip_serializing_if`), its
 * Android half branches on `!= null`, and an empty array is not null - so the notification is built
 * with an `InboxStyle` holding ZERO lines. `InboxStyle` renders `textLines` and never `contentText`.
 * Any other template, or an `InboxStyle` with lines in it, draws.
 *
 * Read out of the same dump every other check already reads, so it costs nothing per row.
 */
export const bodyIsDrawn = (n) => !(/InboxStyle/.test(n.template) && n.inboxLines === 0);

/**
 * The exact bodies `CanariFirebaseMessagingService` renders when it could NOT decrypt.
 *
 * A NOTIFICATION THAT ARRIVED IS NOT A NOTIFICATION THAT WORKED, and no check here could tell the
 * two apart: NOTIF-4/9/10 all asked `full.includes(marker)`, so a shade full of "Nouveau message de
 * X" simply made the marker absent, which reads as "the notification has not arrived yet" and then
 * as a timeout - a completely different diagnosis from "background MLS decryption failed". The user
 * saw the generic form on the phone during a run this file called `PASS`.
 *
 * Kept as literals rather than a loose pattern because they are literals in the Kotlin
 * (`buildFallbackText`, `buildChannelFallbackText`) and in `push-payload.ts` for the APNs side. A
 * pattern would drift from them silently; a literal that stops matching is a rename, which is a
 * change to go and look at.
 */
export const GENERIC_BODIES = [/^Nouveau message de /, /^Nouveau message dans #/, /^Vous avez re.u un message chiffr/, /^Nouveau message$/];

/**
 * Every notification currently in the shade that this app raised WITHOUT decrypting the message.
 *
 * Titles and bodies are real conversation content, so only the matched PATTERN is returned - never
 * the line. The count is the finding; the text is on the device for whoever is holding it.
 */
export const undecryptedInShade = () =>
  notifications()
    .map((n) => GENERIC_BODIES.findIndex((re) => re.test(n.body)))
    .filter((i) => i >= 0)
    .map((i) => String(GENERIC_BODIES[i]));

/** Waits until some notification's text contains `needle`; returns the elapsed ms or null. */
export async function awaitNotification(needle, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (notifications().some((n) => n.full.includes(needle))) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

/** The app's own console, from logcat - the only way to read it while the WebView is unreachable. */
export function console_(sinceLines = 3000) {
  return adb(['logcat', '-d', '-t', String(sinceLines)], 60_000)
    .split('\n')
    .filter((l) => l.includes('Tauri/Console'))
    .map((l) => l.replace(/^.*Msg: /, ''));
}

export const clearLogcat = () => adb(['logcat', '-c']);

// Run directly => bring the phone to a measurable state and print what it took. This is the ONLY
// entry point for the forward: `a1forward.mjs` used to be a second one, and it declared its own bare
// `adb` with no `-s`, so with both a USB and a wireless transport attached - the normal state of this
// phone during a long run - it died on `more than one device/emulator` while `run()` right here was
// selecting the transport correctly. A duplicated primitive does not drift slowly; it is simply
// missing whatever the original learnt.
//
// `pathToFileURL` rather than a hand-built `file://`: on Windows the hand-built form is
// `file://C:/...` where `import.meta.url` is `file:///C:/...`, so the guard never matched and the
// script printed nothing, which looks exactly like a run that succeeded.
// `process.argv[1]` is UNDEFINED under `node -e` / `node --eval`, and `pathToFileURL(undefined)`
// throws - at IMPORT time, in a module every browser-only runner imports. That is the same fault the
// SERIAL resolution above was written to avoid, arriving through a different door.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // THE PORT IS POSITIONAL, AND A FLAG IN ITS PLACE USED TO BECOME NaN IN SILENCE. `bun phone.mjs
  // --ensure --port 9333` read `--ensure` as the port, `Number` gave NaN, and `forwardDevtools`
  // reported "needs a port - pass PORTS.A1" - an error about the API, raised by a mistake in the
  // command line, which cost a cycle on 2026-08-22. There are no flags here and there is no reason
  // for any; the only argument is a port, so an argument that is not one says so.
  const raw = process.argv[2];
  if (raw !== undefined && !/^\d+$/.test(raw)) {
    console.error(`phone.mjs takes ONE optional argument, a port number - got "${raw}".`);
    console.error(`Usage: bun phone.mjs [port]   (default ${PORTS.A1})`);
    process.exit(2);
  }
  const port = Number(raw || PORTS.A1);
  const state = await ensure({ port });
  console.log(JSON.stringify({ port, serial: SERIAL, ...state }, null, 1));
  if (!state.ok) process.exit(1);
}
