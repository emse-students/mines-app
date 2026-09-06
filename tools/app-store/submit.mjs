#!/usr/bin/env node
/**
 * CREATE THE APP STORE VERSION, PUT THE BUILD IN IT, AND SUBMIT IT FOR REVIEW.
 *
 * WHAT WAS MISSING. `ios.yml` ended at `xcrun altool --upload-app`, which hands the binary to App
 * Store Connect and leaves it in TestFlight. Nothing created an App Store version, nothing attached
 * a build to one, and nothing submitted anything - the workflow said so itself: "submission is
 * still a manual act in App Store Connect". So a stable release put Android on the Play `production`
 * track by itself and left iOS waiting on a human gesture that nothing asked for and nothing
 * reminded anybody about. That was the only asymmetry between two paths meant to be equivalent.
 *
 * WHY A NODE SCRIPT AND NOT MORE SHELL. The App Store Connect API is authenticated with an ES256
 * JWT, and signing one in bash means openssl plus a DER-to-raw signature conversion by hand. Node
 * does it in six lines and is already how this repository writes its tooling (`tools/play-vitals/`).
 * The whole job is one file with one entry point, which is the opposite of the sprawl this replaces.
 *
 * EVERY STEP IS IDEMPOTENT, because a re-run is an ordinary event: a release can be re-published,
 * and the workflow has a hand-dispatched path for re-running a chain that died on an infrastructure
 * fault. So each step asks what already exists before creating anything, and a version that is
 * already submitted is reported as done rather than submitted twice.
 *
 * WHAT IT REFUSES TO GUESS. Apple REQUIRES release notes and refuses a submission without them.
 * Learning that by being refused at the END of a release - after the bump, the production deploy,
 * the Play publish and a twenty-minute macOS build, with the other store already shipped - is
 * exactly the shape this project spends its gates avoiding. So the notes come from a file in the
 * repository, that file NAMES THE VERSION it was written for, and `release-preflight.sh` runs the
 * same check through `--check-notes` before anything moves at all.
 *
 * Usage: bun tools/app-store/submit.mjs
 *        bun tools/app-store/submit.mjs --check-notes   # the notes rule alone, no credentials
 *   env  ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8 (base64 of the .p8)
 *        APP_BUNDLE_ID     the app to act on
 *        MARKETING_VERSION the versionString, e.g. 0.15.0 - numeric, no pre-release suffix
 *        BUILD_NUMBER      the CFBundleVersion the bump wrote, e.g. 1500099
 *        WHATS_NEW_FILE    optional path; defaults to store/whats-new.txt
 *        DRY_RUN           set to 1 to read everything and change nothing
 */

import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com';
const PLATFORM = 'IOS';

/**
 * THE SUBMISSION DID NOT HAPPEN, AND THAT IS NOT A FAILURE. Apple gives an app ONE non-terminal
 * version slot. A release published while the previous one is still WAITING_FOR_REVIEW, IN_REVIEW
 * or PENDING_DEVELOPER_RELEASE finds that slot held, and cancelling a review is a human decision a
 * release script must never take - so it stops, and stopping is the CORRECT outcome.
 *
 * WHY THIS IS A TYPE AND NOT A MESSAGE. `chooseVersionSlot` has always separated `blocked` from
 * `fail`; the caller collapsed both into `throw new Error(slot.why)`, so both left through exit 1
 * and a workflow could only tell them apart by reading English prose - a distinction exactly one
 * call site would ever make. Three iOS jobs went red that way (v0.16.2, v0.16.3, v0.16.4) for the
 * one outcome that is GUARANTEED whenever we release faster than Apple reviews. A red run whose
 * cause is "working as designed" is noise, and this noise hid a store arm genuinely failing for
 * three days: production sat on v0.16.1 while two releases reported themselves shipped.
 */
export class SlotHeldError extends Error {
  /** @param {string} why */
  constructor(why) {
    super(why);
    this.name = 'SlotHeldError';
  }
}

/**
 * "Nothing was submitted, and nothing is wrong." 75 is sysexits' EX_TEMPFAIL - *the user is invited
 * to retry* - which is exactly this case. Everything the caller must ACT on still leaves through 1.
 */
export const EXIT_SLOT_HELD = 75;

/**
 * How a failed run leaves: the code the shell sees, and the one line it prints.
 *
 * Pure, exported and tested, because the alternative is asserting an exit code by spawning a script
 * that talks to Apple. The workflow step reads the CODE, never the text.
 *
 * @param {unknown} e
 * @returns {{code: number, line: string}}
 */
export function exitFor(e) {
  if (e instanceof SlotHeldError)
    return { code: EXIT_SLOT_HELD, line: `::notice::App Store submission deferred - ${e.message}` };
  return {
    code: 1,
    line: `::error::App Store submission failed - ${e instanceof Error ? e.message : String(e)}`,
  };
}

/** Apple's own limit on the release-notes field. Longer text is refused by the API, not truncated. */
// THE TIGHTEST OF THE THREE DESTINATIONS, WHICH IS PLAY'S - not Apple's 4000, even though this
// file is the App Store tool. The notes went to one store when this constant was written; since
// 2026-09-03 the same text reaches Play and the GitHub release, so the gate that reads it in
// seconds has to refuse anything ANY destination will refuse. Otherwise the fifth preflight gate
// passes and the Android arm dies at the store step after a twenty-minute build - learning by
// failing what a fact could have told us.
//
// MEASURED TWICE, AND THE FIRST MEASUREMENT WAS MISLEADING. Play's API reference states no limit,
// and `PATCH` on a track accepted 400, 500, 501, 1000 and 5000 characters - which is why "no Play
// ceiling is encoded" was written here first. `PATCH` only stores the draft. `POST edits:validate`
// runs the same validation as a commit and changes nothing:
//
//     532 (the real 0.16.1 notes)  ->  403  "notes in language fr-FR with length 532,
//                                            which is too long (max: 500)"
//     499                          ->  200  valid
//     501                          ->  403  same message
//
// So the widely repeated Console figure of 500 IS the API's, enforced at validate/commit time and
// not at write time. Apple's 4000 is kept beside it only to say which one binds.
const APPLE_WHATS_NEW_MAX = 4000;
const PLAY_WHATS_NEW_MAX = 500;
const WHATS_NEW_MAX = Math.min(APPLE_WHATS_NEW_MAX, PLAY_WHATS_NEW_MAX);

/**
 * A build Apple has finished processing. `PROCESSING` is the state a fresh upload sits in for
 * several minutes; `INVALID` and `FAILED` are terminal and must never be waited on.
 */
const BUILD_READY = 'VALID';
const BUILD_TERMINAL_BAD = new Set(['INVALID', 'FAILED']);

/**
 * The version states an automated run may write into. Anything else is a version a human is
 * already working on, or one the store has published, and both are answers rather than obstacles.
 */
const VERSION_EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  // `READY_FOR_REVIEW` IS NOT A VERSION APPLE HAS. It is a version that has been ATTACHED to a
  // review submission nobody has sent - the state the App Store Connect UI leaves behind when a
  // human prepares a release and stops before "Submit to App Review". Apple's own progression puts
  // `WAITING_FOR_REVIEW` after it, and that is where `VERSION_IN_REVIEW` below correctly begins.
  //
  // IT WAS IN NONE OF THE THREE SETS, so `classifyVersionState` answered `unknown version state`
  // and `chooseVersionSlot` refused - naming a human decision that did not exist to make. That cost
  // the `0.16.2` stable on 2026-09-04: Play took the version, the IPA reached TestFlight, and the
  // submission stopped on a prepared-and-forgotten `0.16.1`, which left the production estate on
  // the previous release because it is gated on both stores. An occupied slot nobody can free
  // without a click blocks EVERY later stable, which is the queue this project does not keep.
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);
const VERSION_IN_REVIEW = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE']);
const VERSION_DONE = new Set([
  'READY_FOR_SALE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
]);

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PATCH', 'PUT', 'DELETE']);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export const API_ATTEMPTS = 4;
const API_RETRY_BASE_MS = 4000;

/**
 * WHETHER A REFUSAL IS APPLE ANSWERING, OR APPLE FAILING TO ANSWER.
 *
 * *A status code is an ANSWER, a transport failure is not.* A 409 is Apple telling us the app
 * already has a non-terminal version - a fact, and retrying it a hundred times changes nothing. A
 * `500 An unexpected error occurred on the server side. If this issue continues, contact us` is
 * Apple saying it did not get as far as having an opinion.
 *
 * THE CASE, AND ITS SECOND HALF IS THE INTERESTING ONE. `v0.16.1` died on the LAST request of the
 * submission chain - `PATCH /v1/reviewSubmissions/{id} {submitted: true} -> 500` - with the version
 * created, the build attached and the notes written. **The write had LANDED**: App Store Connect
 * showed the version added for review, observed by the user minutes later. So the 500 was a lost
 * RESPONSE, not a refused effect, and the run was RED while the release had in fact shipped - which
 * is its own defect, a job whose colour contradicts what it did. Retrying is what closes it: the
 * second `PATCH` would have found the submission already submitted and returned an ANSWER, and the
 * job would have been honest.
 *
 * ONLY IDEMPOTENT METHODS, and this is the whole subtlety. `PATCH /reviewSubmissions/{id}
 * {submitted: true}` may be repeated: the second call either does the same thing or is refused for
 * a reason that IS an answer. `POST /v1/reviewSubmissions` may NOT: a 500 leaves us unable to say
 * whether the submission was created, and a retry would quietly make a second one. Those POSTs are
 * already protected differently - the code asks what exists before creating anything - so the two
 * halves cover each other.
 *
 * NOT A FALLBACK PATH. Nothing different happens on a retry; the same request is made again,
 * because the first one never reached a decision.
 *
 * @param {string} method
 * @param {number} status HTTP status, or 0 for a request that never got a response at all.
 * @returns {boolean}
 */
export function shouldRetry(method, status) {
  if (!IDEMPOTENT_METHODS.has(method.toUpperCase())) return false;
  // A throw from `fetch` - DNS, a reset connection, a TLS failure - carries no status at all.
  if (status === 0) return true;
  return RETRYABLE_STATUS.has(status);
}

// -------------------------------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------------------------------

/**
 * A 20-minute App Store Connect token.
 *
 * `ieee-p1363` IS NOT OPTIONAL. Node signs ECDSA as DER by default and a JWT requires the raw
 * r||s pair; a DER signature is accepted by no verifier and comes back as a flat 401 that says
 * nothing about why. Apple also caps the lifetime at 20 minutes and rejects anything longer.
 *
 * @param {{keyId: string, issuerId: string, privateKey: string}} creds
 * @returns {string}
 */
export function mintToken({ keyId, issuerId, privateKey }) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' };

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;

  const signer = createSign('SHA256');
  signer.update(signingInput);
  const sig = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${signingInput}.${sig}`;
}

// -------------------------------------------------------------------------------------------------
// Decisions worth testing on their own
// -------------------------------------------------------------------------------------------------

/**
 * What to do about a build's processing state.
 *
 * Kept separate because the interesting arms are the ones a live run reaches once and never again:
 * a build Apple rejected during processing, and a state Apple adds later that this script has
 * never seen. Waiting for ever on either is the failure mode.
 *
 * @param {string | undefined} state
 * @returns {{action: 'use'} | {action: 'wait'} | {action: 'fail', why: string}}
 */
export function classifyBuildState(state) {
  if (state === BUILD_READY) return { action: 'use' };
  if (state === 'PROCESSING') return { action: 'wait' };
  if (state === undefined || state === null || state === '')
    return { action: 'fail', why: 'the build carries no processing state' };
  if (BUILD_TERMINAL_BAD.has(state))
    return { action: 'fail', why: `Apple rejected the build during processing (${state})` };
  // An unknown state is NOT a reason to keep polling: a new Apple state that happens to be terminal
  // would hold the runner until the job timed out, and the log would say nothing.
  return { action: 'fail', why: `unknown build processing state ${state}` };
}

/**
 * What to do about an existing App Store version that already carries this version string.
 *
 * @param {string | undefined} state
 * @returns {{action: 'edit'} | {action: 'done', why: string} | {action: 'fail', why: string}}
 */
export function classifyVersionState(state) {
  if (state && VERSION_EDITABLE.has(state)) return { action: 'edit' };
  if (state && VERSION_IN_REVIEW.has(state))
    return { action: 'done', why: `it is already with Apple (${state})` };
  if (state && VERSION_DONE.has(state))
    return { action: 'done', why: `it is already released or releasing (${state})` };
  if (!state) return { action: 'fail', why: 'the version carries no state' };
  return { action: 'fail', why: `unknown version state ${state}` };
}

/**
 * Is this version ALREADY an item of a review submission?
 *
 * WHY THIS IS NOT A QUESTION FOR THE API, AND ASKING IT COST A RELEASE. `POST
 * /v1/reviewSubmissionItems` answers 409 `appStoreVersion with id ... was already added to this
 * reviewSubmission` when the version is in one, so the call has to be SKIPPED rather than retried.
 * The first version of this asked Apple for the submission's items and compared
 * `relationships.appStoreVersion.data.id` - a linkage a JSON:API collection does not carry unless
 * the request asks for it. Every item therefore read `undefined`, the comparison was false for all
 * of them, and the POST went out anyway. `0.16.3` died there on 2026-09-04, ONE CALL FROM DONE: the
 * slot had been renamed, the build attached and the notes written, and the production estate stayed
 * on the previous release because it is gated on both stores.
 *
 * THE DISCRIMINATOR WAS ALREADY IN HAND. `READY_FOR_REVIEW` *means* the version sits in a review
 * submission - that is the state's whole definition, it is what `chooseVersionSlot` had just read
 * one screen earlier, and renaming a version does not detach it. *Never learn by failing what a
 * fact could have told you: carry the discriminator to where the decision is made, from where it is
 * already KNOWN.* The items list is still consulted, with the linkage the query was missing,
 * because a state is a summary and the list is the direct question - either one saying yes is
 * enough, since the failure being avoided is a duplicate POST.
 *
 * @param {{state?: string, versionId?: string,
 *          items?: Array<{relationships?: {appStoreVersion?: {data?: {id?: string}}}}>}} input
 * @returns {{already: boolean, how: string}}
 */
export function versionIsAlreadySubmissionItem({ state, items, versionId }) {
  if (state === 'READY_FOR_REVIEW')
    return {
      already: true,
      how: 'its state is READY_FOR_REVIEW, which is what sitting in one means',
    };
  const listed = (items ?? []).some(
    (i) => i?.relationships?.appStoreVersion?.data?.id === versionId
  );
  if (listed) return { already: true, how: 'the submission lists it among its items' };
  return { already: false, how: '' };
}

/**
 * Which App Store version slot should this release use, given EVERY version the app has?
 *
 * WHY THIS EXISTS, AND IT COST A RELEASE. The first version of this script asked Apple *"is there
 * a version called 0.16.0?"* - `filter[versionString]=0.16.0` - and created one when the answer
 * was no. Apple refused with a 409 that says exactly what the real rule is:
 *
 *     POST /v1/appStoreVersions -> 409 The provided entity includes a relationship with an
 *     invalid value: You cannot create a new version of the App in the current state.
 *
 * **An app has ONE non-terminal version slot.** Whether a version named `0.16.0` exists is not the
 * question that decides the POST; whether the slot is OCCUPIED is - and it can be occupied by a
 * version with any other name. The narrow predicate happened to be true and the weaker answer was
 * useless, which is the same defect shape as a gate asking `contains` where the work needs `is`.
 *
 * SO THE DECISION IS MADE FROM THE WHOLE LIST, and the arms are not symmetric:
 *
 *   - the slot holds THIS version, editable        -> use it
 *   - the slot holds THIS version, already gone    -> nothing to do; this is an answer, not an error
 *   - the slot holds ANOTHER version, editable     -> rename it. This is what the App Store Connect
 *                                                    UI does to a prepared-but-unsubmitted version,
 *                                                    and the alternative is a slot nothing can ever
 *                                                    free without a human
 *   - the slot holds ANOTHER version, with Apple   -> REFUSE, naming it and its state. Cancelling a
 *                                                    review is a human decision and must never be
 *                                                    taken by a release script
 *   - the slot is empty                            -> create
 *
 * @param {{versions: Array<{id: string, attributes?: {versionString?: string, appStoreState?: string}}>, versionString: string}} input
 * @returns {{action: 'use', id: string, state: string}
 *          | {action: 'done', why: string}
 *          | {action: 'rename', id: string, from: string, state: string}
 *          | {action: 'blocked', why: string}
 *          | {action: 'create'}
 *          | {action: 'fail', why: string}}
 */
export function chooseVersionSlot({ versions, versionString }) {
  if (!versionString) return { action: 'fail', why: 'no version string was given' };
  if (!Array.isArray(versions))
    return {
      action: 'fail',
      why: 'the app returned no version list, so the slot state is unknown',
    };

  // A TERMINAL VERSION DOES NOT HOLD THE SLOT. Every past release is `READY_FOR_SALE` and there are
  // as many of those as the app has ever shipped, so they have to be filtered out BEFORE looking
  // for an occupant - counting them as occupants would refuse every release for ever.
  const occupants = versions.filter((v) => {
    const st = v?.attributes?.appStoreState;
    return st && !VERSION_DONE.has(st);
  });

  if (occupants.length === 0) return { action: 'create' };

  // MORE THAN ONE OCCUPANT CONTRADICTS APPLE'S OWN RULE, so it is refused rather than picked from:
  // choosing between them would be a guess about which one a human is working on.
  if (occupants.length > 1) {
    const named = occupants
      .map((v) => `${v?.attributes?.versionString} (${v?.attributes?.appStoreState})`)
      .join(', ');
    return {
      action: 'fail',
      why: `the app has ${occupants.length} non-terminal versions, which Apple is not supposed to allow: ${named}. Refusing to guess which one this release belongs in.`,
    };
  }

  const slot = occupants[0];
  const state = slot?.attributes?.appStoreState;
  const name = slot?.attributes?.versionString;
  const verdict = classifyVersionState(state);

  if (name === versionString) {
    if (verdict.action === 'edit') return { action: 'use', id: slot.id, state };
    if (verdict.action === 'done') return { action: 'done', why: verdict.why };
    return { action: 'fail', why: verdict.why };
  }

  if (verdict.action === 'edit') return { action: 'rename', id: slot.id, from: name, state };

  return {
    action: 'blocked',
    why: `version ${name} occupies the app's only version slot and is ${state}. A release script must not cancel a review or a pending release - decide what happens to ${name} in App Store Connect, then re-run this.`,
  };
}

/**
 * The release notes for exactly this version.
 *
 * APPLE REQUIRES THEM and refuses the submission without them, so their absence has to be a
 * refusal somewhere. Being refused by Apple at the END of a release - after the bump, the deploy,
 * the Play publish and a twenty-minute macOS build - is the shape this project spends its gates
 * avoiding, which is why `release-preflight.sh` calls this same function through `--check-notes`
 * before anything moves.
 *
 * THE FILE NAMES ITS OWN VERSION, and that is the whole point of the first line. A notes file
 * without one would pass an "is it non-empty" check for ever while describing the release before
 * last, and the store would carry notes for the wrong version - a staleness nothing could detect,
 * because a file cannot be asked when it was last meant. Naming the version makes it impossible
 * instead of reported: the notes either say 0.16.0 or the release does not start.
 *
 * @param {{file: string, version: string}} arg
 * @returns {{ok: true, text: string} | {ok: false, why: string}}
 */
export function readWhatsNew({ file, version }) {
  if (!existsSync(file))
    return {
      ok: false,
      why:
        `${file} does not exist. Apple requires release notes on every version and refuses the ` +
        `submission without them. Write them, first line "version: ${version}".`,
    };

  const raw = readFileSync(file, 'utf8');
  // CRLF-TOLERANT SPLIT, because this file is edited on the workstation, which is Windows: a stray
  // carriage return left on the marker line would otherwise read as a version mismatch against the
  // very version it names, and the message would then compare two strings that look identical.
  const lines = raw.split(/\r?\n/);
  const marker = /^version:\s*(\S+)\s*$/.exec(lines[0] ?? '');
  if (!marker)
    return {
      ok: false,
      why:
        `${file} must open with "version: ${version}" so it cannot silently describe an earlier ` +
        `release; its first line is ${JSON.stringify(lines[0] ?? '')}`,
    };
  if (marker[1] !== version)
    return {
      ok: false,
      why:
        `${file} carries notes for ${marker[1]}, and this release is ${version}. Rewrite them for ` +
        `${version} - the store would otherwise publish the previous version's notes.`,
    };

  const text = lines.slice(1).join('\n').trim();
  if (!text) return { ok: false, why: `${file} names ${version} but carries no notes under it` };
  if (text.length > WHATS_NEW_MAX)
    return {
      ok: false,
      why:
        `${file} holds ${text.length} characters of notes, and the limit is ${WHATS_NEW_MAX} - ` +
        `Google Play's, which is the tightest of the three destinations and is enforced when the ` +
        `edit is validated rather than when it is written (Apple's own limit is ` +
        `${APPLE_WHATS_NEW_MAX}). Shorten them, or the Android arm fails at the store step after a ` +
        `full build.`,
    };
  return { ok: true, text };
}

// -------------------------------------------------------------------------------------------------
// The API
// -------------------------------------------------------------------------------------------------

/** @type {(token: string) => (method: string, path: string, body?: unknown) => Promise<any>} */
const client = (token) => async (method, path, body) => {
  for (let attempt = 1; ; attempt++) {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // No response at all. `status: 0` is how the policy above spells that.
      if (attempt < API_ATTEMPTS && shouldRetry(method, 0)) {
        const wait = API_RETRY_BASE_MS * attempt;
        log(`  ${method} ${path} did not reach Apple (${e}) - retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw new Error(`${method} ${path} -> no response after ${attempt} attempt(s): ${e}`);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Apple answers HTML for some gateway errors; the status and the body are what a reader needs.
    }
    if (res.ok) return json;

    // THE ERROR DETAIL IS THE WHOLE VALUE OF THIS BRANCH. Apple's errors say exactly what is wrong
    // ("You must provide a value for 'whatsNew'"), and a bare status turns that into a guess.
    const detail =
      json?.errors?.map((e) => `${e.title}: ${e.detail ?? ''}`).join(' | ') ?? text.slice(0, 400);

    if (attempt < API_ATTEMPTS && shouldRetry(method, res.status)) {
      const wait = API_RETRY_BASE_MS * attempt;
      log(
        `  ${method} ${path} -> ${res.status} (Apple did not answer) - attempt ${attempt} of ` +
          `${API_ATTEMPTS}, retrying in ${wait / 1000}s: ${detail}`
      );
      await sleep(wait);
      continue;
    }

    // The attempt count is part of the message: "500 once" and "500 four times, a minute apart"
    // are different findings, and only one of them is worth reporting to Apple.
    const tried = attempt > 1 ? ` after ${attempt} attempts` : '';
    throw new Error(`${method} ${path} -> ${res.status}${tried} ${detail}`);
  }
};

const log = (msg) => process.stdout.write(`${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const need = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };

  // ONE IMPLEMENTATION OF THE NOTES RULE, called from two places. `release-preflight.sh` runs this
  // mode before the bump, on the cheap ubuntu runner, so a missing or stale notes file refuses the
  // release in seconds instead of at the end of a twenty-minute macOS build. Re-stating the rule in
  // bash would be a second opinion about what valid notes are, and the two would drift.
  if (process.argv.includes('--check-notes')) {
    const version = need('MARKETING_VERSION');
    const file = process.env.WHATS_NEW_FILE || 'store/whats-new.txt';
    const verdict = readWhatsNew({ file, version });
    if (!verdict.ok) {
      // PLAINLY, and not through the catch below: that one prefixes "App Store submission failed",
      // which is not what happened - nothing has been submitted, and the preflight reprints this
      // line verbatim as its own refusal.
      process.stderr.write(`${verdict.why}\n`);
      process.exit(1);
    }
    log(`${file} carries ${verdict.text.length} characters of notes for ${version}`);
    return;
  }

  // THE SAME NOTES, FOR THE OTHER TWO DESTINATIONS. Google Play and the GitHub release need the
  // TEXT, and the alternative was each of them re-parsing `store/whats-new.txt` in bash - three
  // opinions about what the notes are, drifting the day the format changes. This mode prints the
  // body on stdout and NOTHING else, so a shell can capture it, and it refuses on exactly the same
  // verdict as `--check-notes`: a caller cannot get text this rejects.
  if (process.argv.includes('--print-notes')) {
    const version = need('MARKETING_VERSION');
    const file = process.env.WHATS_NEW_FILE || 'store/whats-new.txt';
    const verdict = readWhatsNew({ file, version });
    if (!verdict.ok) {
      process.stderr.write(`${verdict.why}\n`);
      process.exit(1);
    }
    process.stdout.write(verdict.text);
    return;
  }

  const keyId = need('ASC_KEY_ID');
  const issuerId = need('ASC_ISSUER_ID');
  const bundleId = need('APP_BUNDLE_ID');
  const versionString = need('MARKETING_VERSION');
  const buildNumber = need('BUILD_NUMBER');
  const whatsNewFile = process.env.WHATS_NEW_FILE || 'store/whats-new.txt';
  const dryRun = process.env.DRY_RUN === '1';

  const privateKey = Buffer.from(need('ASC_API_KEY_P8'), 'base64').toString('utf8');
  const api = client(mintToken({ keyId, issuerId, privateKey }));

  log(
    `App Store submission - ${bundleId} ${versionString} (build ${buildNumber})${dryRun ? ' [DRY RUN]' : ''}`
  );

  // -- the app ------------------------------------------------------------------------------------
  const apps = await api(
    'GET',
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`
  );
  const app = apps?.data?.[0];
  if (!app) throw new Error(`no app with bundle id ${bundleId} is visible to this API key`);
  log(`  app ${app.id} - ${app.attributes?.name ?? '(unnamed)'}`);

  const notes = readWhatsNew({ file: whatsNewFile, version: versionString });
  if (!notes.ok) throw new Error(notes.why);
  log(`  release notes: ${notes.text.length} characters from ${whatsNewFile}`);

  // -- the build ----------------------------------------------------------------------------------
  // A FRESH UPLOAD IS NOT USABLE IMMEDIATELY. Apple processes it for minutes, and the build does
  // not even APPEAR in the list for the first few of them - so an absent build is a reason to wait,
  // exactly like `PROCESSING`, and only a state Apple has published is a reason to stop.
  const deadline = Date.now() + 45 * 60 * 1000;
  let build = null;
  for (let attempt = 1; ; attempt++) {
    const builds = await api(
      'GET',
      `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`
    );
    const found = builds?.data?.[0];
    const verdict = found
      ? classifyBuildState(found.attributes?.processingState)
      : { action: 'wait' };

    if (verdict.action === 'use') {
      build = found;
      log(`  build ${found.id} is ${BUILD_READY}`);
      break;
    }
    if (verdict.action === 'fail') throw new Error(verdict.why);
    if (Date.now() > deadline)
      throw new Error(
        `build ${buildNumber} was still not ${BUILD_READY} after 45 minutes` +
          `${found ? ` (${found.attributes?.processingState})` : ' (it never appeared)'}`
      );
    log(`  waiting for build ${buildNumber} to finish processing (attempt ${attempt})`);
    await sleep(60_000);
  }

  // -- the version --------------------------------------------------------------------------------
  // EVERY VERSION, NOT THE ONE THIS RELEASE IS CALLED. An app has a single non-terminal version
  // slot; asking `filter[versionString]=0.16.0` answers a narrower question than the POST needs and
  // is how `v0.16.0` earned a 409 saying so. `chooseVersionSlot` carries the whole list.
  const all = await api(
    'GET',
    `/v1/apps/${app.id}/appStoreVersions?filter[platform]=${PLATFORM}&limit=50`
  );
  const slot = chooseVersionSlot({ versions: all?.data ?? [], versionString });

  for (const v of all?.data ?? []) {
    const st = v?.attributes?.appStoreState;
    if (st && !VERSION_DONE.has(st)) log(`  version slot: ${v?.attributes?.versionString} (${st})`);
  }

  if (slot.action === 'done') {
    log(`  version ${versionString} needs nothing: ${slot.why}`);
    log('done.');
    return;
  }
  if (slot.action === 'fail') throw new Error(slot.why);
  // NOT AN ERROR, AND NOT AN exit 1: the slot is held by a version that is with Apple, which is the
  // expected outcome of releasing faster than Apple reviews. See `SlotHeldError`.
  if (slot.action === 'blocked') throw new SlotHeldError(slot.why);

  let version = null;

  // THE STATE THE SLOT WAS FOUND IN IS CARRIED FORWARD, because it answers a question asked much
  // further down: whether this version is already an item of a review submission. It stays
  // `undefined` for a version this run creates, which cannot be in one.
  let slotState;

  if (slot.action === 'use') {
    version = { id: slot.id };
    slotState = slot.state;
    log(`  version ${versionString} exists and is editable (${slot.state})`);
  } else if (slot.action === 'rename') {
    if (dryRun) {
      log(`  [dry run] would rename version ${slot.from} to ${versionString}`);
      return;
    }
    // THE PREPARED-BUT-UNSUBMITTED SLOT IS THE ONE THIS RELEASE WANTS. Renaming it is what the App
    // Store Connect UI does, and it is the only way to reach a slot a previous attempt left behind
    // without asking a human to clear it by hand every time.
    await api('PATCH', `/v1/appStoreVersions/${slot.id}`, {
      data: { type: 'appStoreVersions', id: slot.id, attributes: { versionString } },
    });
    version = { id: slot.id };
    // A RENAME DOES NOT DETACH A VERSION FROM ITS SUBMISSION, so the state it was found in still
    // describes it. Losing this is precisely what sent a duplicate item POST on 2026-09-04.
    slotState = slot.state;
    log(`  renamed the editable version ${slot.from} (${slot.state}) to ${versionString}`);
  } else {
    if (dryRun) {
      log(`  [dry run] would create version ${versionString}`);
      return;
    }
    const created = await api('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: PLATFORM, versionString },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    });
    version = created.data;
    log(`  created version ${versionString} (${version.id})`);
  }

  if (dryRun) {
    log('  [dry run] would attach the build, write the release notes and submit for review');
    return;
  }

  // -- attach the build ---------------------------------------------------------------------------
  await api('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, {
    data: { type: 'builds', id: build.id },
  });
  log(`  attached build ${buildNumber} to version ${versionString}`);

  // -- the release notes, in every locale the version has -----------------------------------------
  // WRITTEN TO EVERY LOCALIZATION, not just one. Apple requires the field per locale, and a version
  // whose second language is empty is refused with an error naming that locale and nothing else.
  {
    const locs = await api(
      'GET',
      `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`
    );
    for (const loc of locs?.data ?? []) {
      await api('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
        data: {
          type: 'appStoreVersionLocalizations',
          id: loc.id,
          attributes: { whatsNew: notes.text },
        },
      });
      log(`  release notes written for ${loc.attributes?.locale}`);
    }
  }

  // -- submit -------------------------------------------------------------------------------------
  // THE MODERN FLOW, AND THE OLD ONE IS A TRAP. `POST /v1/appStoreVersionSubmissions` still exists
  // and still half-works, but Apple's review submissions replaced it: a submission is a container
  // that carries ITEMS, so one submission can hold the version, an in-app purchase and a price
  // change together. Using the old endpoint submits the version alone and leaves anything else the
  // release needed sitting unsubmitted, with no error.
  const open = await api(
    'GET',
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=1`
  );
  let submission = open?.data?.[0];
  if (submission) {
    log(`  reusing the open review submission ${submission.id} (${submission.attributes?.state})`);
  } else {
    const created = await api('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    });
    submission = created.data;
    log(`  created review submission ${submission.id}`);
  }

  // Adding an item that is already in the submission is an error, not a no-op, so ask first - and
  // `include=appStoreVersion` is what makes the answer readable. Without it the collection carries
  // no `data` linkage for that relationship, every comparison reads `undefined`, and the check
  // answers "no" for a version that is plainly there.
  const items = await api(
    'GET',
    `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=50`
  );
  const seen = versionIsAlreadySubmissionItem({
    state: slotState,
    items: items?.data,
    versionId: version.id,
  });
  if (seen.already) {
    log(`  the version is already an item of this submission - ${seen.how}`);
  } else {
    await api('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
    log('  added the version to the submission');
  }

  await api('PATCH', `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  log(`  submitted ${versionString} for review`);
  log('done.');
}

// Only when run, so the decisions above can be imported by the test without reaching Apple.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('submit.mjs')) {
  main().catch((e) => {
    const { code, line } = exitFor(e);
    process.stderr.write(`${line}\n`);
    process.exit(code);
  });
}
