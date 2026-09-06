/**
 * THE DECISIONS THE SUBMISSION TAKES, TESTED WITHOUT APPLE.
 *
 * WHAT IS WORTH TESTING HERE, AND WHAT IS NOT. The HTTP calls cannot be exercised off App Store
 * Connect and mocking them would only assert that this file's own fake matches this file's own
 * expectations. What CAN be got wrong, silently and expensively, is the classification: a build
 * state that makes the script poll for 45 minutes and then give up, a version state that makes it
 * write into a version a human is mid-way through, and release notes that describe the release
 * before last. Every one of those is green until somebody reads a store listing.
 *
 * THE ARM THAT MATTERS MOST IS THE UNKNOWN ONE. Apple adds states; a classifier that treats
 * anything it does not recognise as "keep waiting" holds a macOS runner until the job times out and
 * says nothing about why. So an unknown state is a refusal in both classifiers, and that is
 * asserted rather than assumed.
 *
 * Run: bun tools/app-store/submit.test.mjs
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseVersionSlot,
  classifyBuildState,
  classifyVersionState,
  versionIsAlreadySubmissionItem,
  readWhatsNew,
  mintToken,
  shouldRetry,
  exitFor,
  SlotHeldError,
  EXIT_SLOT_HELD,
} from './submit.mjs';

let pass = 0;
let fail = 0;
const ok = (what) => {
  pass += 1;
  process.stdout.write(`  ok    ${what}\n`);
};
const no = (what, got) => {
  fail += 1;
  process.stdout.write(
    `  FAIL  ${what}${got === undefined ? '' : ` - got ${JSON.stringify(got)}`}\n`
  );
};
const eq = (what, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(what) : no(what, actual);

const dir = mkdtempSync(join(tmpdir(), 'asc-notes-'));
const notes = (body) => {
  const f = join(dir, 'whats-new.txt');
  writeFileSync(f, body, 'utf8');
  return f;
};

try {
  process.stdout.write(
    '\na build is used, waited for, or refused - never waited for indefinitely\n'
  );
  eq('VALID is used', classifyBuildState('VALID').action, 'use');
  eq('PROCESSING is waited for', classifyBuildState('PROCESSING').action, 'wait');
  eq('INVALID is refused', classifyBuildState('INVALID').action, 'fail');
  eq('FAILED is refused', classifyBuildState('FAILED').action, 'fail');
  // THE POINT OF THE WHOLE FUNCTION. Anything unrecognised must stop the run, because the
  // alternative is polling a terminal state until the runner times out.
  eq('an unknown state is refused, not polled', classifyBuildState('SOMETHING_NEW').action, 'fail');
  eq('an absent state is refused', classifyBuildState(undefined).action, 'fail');
  eq('an empty state is refused', classifyBuildState('').action, 'fail');
  if (classifyBuildState('INVALID').why.includes('INVALID')) {
    ok('the refusal names the state it saw');
  } else {
    no('the refusal names the state it saw', classifyBuildState('INVALID').why);
  }

  process.stdout.write('\na version is edited, already done, or refused\n');
  eq(
    'PREPARE_FOR_SUBMISSION is editable',
    classifyVersionState('PREPARE_FOR_SUBMISSION').action,
    'edit'
  );
  eq(
    'DEVELOPER_REJECTED is editable again',
    classifyVersionState('DEVELOPER_REJECTED').action,
    'edit'
  );
  eq('REJECTED is editable again', classifyVersionState('REJECTED').action, 'edit');
  // THE STATE THAT COST THE 0.16.2 STABLE. `READY_FOR_REVIEW` means the version sits in a review
  // submission nobody sent, so Apple does not have it and it is ours to write into. It was in none
  // of the three sets, which made it an UNKNOWN state - and an unknown state refuses.
  eq(
    'READY_FOR_REVIEW is editable, because nobody has submitted it',
    classifyVersionState('READY_FOR_REVIEW').action,
    'edit'
  );
  // A RE-RUN IS AN ORDINARY EVENT - a release can be re-published, and the workflow has a
  // hand-dispatched path. A version already with Apple must be reported as done, never resubmitted.
  eq('WAITING_FOR_REVIEW is done', classifyVersionState('WAITING_FOR_REVIEW').action, 'done');
  eq('IN_REVIEW is done', classifyVersionState('IN_REVIEW').action, 'done');
  eq('READY_FOR_SALE is done', classifyVersionState('READY_FOR_SALE').action, 'done');
  eq('an unknown state is refused', classifyVersionState('SOMETHING_NEW').action, 'fail');
  eq('an absent state is refused', classifyVersionState(undefined).action, 'fail');

  process.stdout.write(
    '\nthe release notes are the ones for THIS version, or there is no release\n'
  );
  eq(
    'notes naming this version are accepted',
    readWhatsNew({ file: notes('version: 0.16.0\nDes corrections.\n'), version: '0.16.0' }),
    { ok: true, text: 'Des corrections.' }
  );

  // THE DEFECT THIS FILE EXISTS FOR. A plain "is it non-empty" check passes for ever on a notes
  // file nobody updated, and the store then carries the previous release's notes - staleness no
  // mechanism could detect, because a file cannot be asked when it was last meant.
  const stale = readWhatsNew({
    file: notes('version: 0.15.0\nDes corrections.\n'),
    version: '0.16.0',
  });
  if (stale.ok === false && stale.why.includes('0.15.0') && stale.why.includes('0.16.0')) {
    ok('notes naming an EARLIER version are refused, and the refusal names both versions');
  } else {
    no('notes naming an earlier version are refused', stale);
  }

  const unmarked = readWhatsNew({ file: notes('Des corrections.\n'), version: '0.16.0' });
  eq('notes with no version marker are refused', unmarked.ok, false);

  const empty = readWhatsNew({ file: notes('version: 0.16.0\n\n   \n'), version: '0.16.0' });
  eq('a marker with nothing under it is refused', empty.ok, false);

  const missing = readWhatsNew({ file: join(dir, 'nope.txt'), version: '0.16.0' });
  eq('an absent file is refused', missing.ok, false);

  // Written on Windows, read on a Linux runner. A carriage return on the marker line would compare
  // "0.16.0\r" against "0.16.0" and refuse the release with a message showing two identical strings.
  eq(
    'CRLF notes are accepted, because the workstation writes them',
    readWhatsNew({ file: notes('version: 0.16.0\r\nDes corrections.\r\n'), version: '0.16.0' }).ok,
    true
  );

  // THE CEILING IS PLAY'S 500, NOT APPLE'S 4000, and the boundary is asserted on both sides because
  // the whole point of this gate is refusing in seconds what a store refuses after a full build.
  //
  // MEASURED THROUGH `POST edits:validate`, which runs a commit's validation and changes nothing:
  // 499 -> 200, 501 -> 403 "notes in language fr-FR with length 501, which is too long (max: 500)".
  // A `PATCH` accepted 5000, which is why the first version of this file encoded no Play ceiling at
  // all - `PATCH` only stores the draft. This test exists so that measurement cannot be undone by
  // somebody reading "Apple's limit is 4000" in the tool's own name.
  const at500 = readWhatsNew({
    file: notes(`version: 0.16.0\n${'x'.repeat(500)}\n`),
    version: '0.16.0',
  });
  eq('notes of exactly 500 characters are accepted - the boundary is inclusive', at500.ok, true);

  const over500 = readWhatsNew({
    file: notes(`version: 0.16.0\n${'x'.repeat(501)}\n`),
    version: '0.16.0',
  });
  eq('501 characters are refused, because Google Play refuses them at validate time', over500.ok, false);
  // `eq` AND NOT `ok`: `ok` takes ONE argument and prints it as the label, so a two-argument call
  // asserts nothing and goes green - a trap this suite has already sprung once in one session.
  eq(
    'and the refusal names which destination binds, so the fix is obvious',
    over500.why.includes('Google Play') && over500.why.includes('500'),
    true
  );

  const long = readWhatsNew({
    file: notes(`version: 0.16.0\n${'x'.repeat(4001)}\n`),
    version: '0.16.0',
  });
  eq('notes past every limit are refused', long.ok, false);

  process.stdout.write('\nthe token is the shape App Store Connect accepts\n');
  // A GENERATED KEY, so the test carries no credential. The assertion is on the SIGNATURE LENGTH:
  // `dsaEncoding: 'ieee-p1363'` yields the 64-byte r||s pair a JWT requires, and Node's default DER
  // encoding yields a variable-length 70-72 bytes that every verifier rejects with a bare 401.
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const jwt = mintToken({ keyId: 'ABC123', issuerId: 'issuer-uuid', privateKey });
  const [h, p, s] = jwt.split('.');
  eq('it has three segments', jwt.split('.').length, 3);
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  eq('the header is ES256 and carries the key id', [header.alg, header.kid], ['ES256', 'ABC123']);
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  eq('the audience is appstoreconnect-v1', claims.aud, 'appstoreconnect-v1');
  eq('the issuer is the issuer id', claims.iss, 'issuer-uuid');
  // Apple refuses anything longer than 20 minutes outright.
  eq('the lifetime is 20 minutes', claims.exp - claims.iat, 1200);
  eq('the signature is the raw 64-byte r||s pair, not DER', Buffer.from(s, 'base64url').length, 64);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------------------------------------------
// WHICH VERSION SLOT, AND THIS IS THE ONE THAT COST A RELEASE
// -------------------------------------------------------------------------------------------------
// `v0.16.0` reached production and Google Play, uploaded to TestFlight, and then died here:
//
//     POST /v1/appStoreVersions -> 409 The provided entity includes a relationship with an
//     invalid value: You cannot create a new version of the App in the current state.
//
// The script had asked Apple *"is there a version called 0.16.0?"* and created one when the answer
// was no. **An app has ONE non-terminal version slot**, and whether it is OCCUPIED - by a version
// with any name at all - is the question the POST actually answers to. The narrow predicate
// happened to be true and its answer was useless.
//
// THE ARM THAT WOULD BREAK EVERY FUTURE RELEASE IS THE FIRST ONE BELOW: every past release sits in
// `READY_FOR_SALE` for ever, so counting terminal versions as occupants would refuse every release
// from now on, and the refusal would look exactly like a correct one.
process.stdout.write('\nis the version already an item of a review submission?\n');
{
  const item = (id) => ({ relationships: { appStoreVersion: { data: { id } } } });

  // THE ONE THAT COST 0.16.3, AND IT IS THE STATE THAT ANSWERS IT. A version in READY_FOR_REVIEW is
  // by definition in a submission, and that is known before any list is fetched - which is the
  // point: the list WAS fetched, could not be read, and the duplicate POST went out anyway.
  eq(
    'READY_FOR_REVIEW alone proves it is an item, with no list at all',
    versionIsAlreadySubmissionItem({ state: 'READY_FOR_REVIEW', items: [], versionId: 'v' })
      .already,
    true
  );
  eq(
    'and the reason is reported, because the log is what a human reads next',
    versionIsAlreadySubmissionItem({ state: 'READY_FOR_REVIEW', versionId: 'v' }).how.includes(
      'READY_FOR_REVIEW'
    ),
    true
  );

  // THE DIRECT QUESTION STILL COUNTS, for a state that does not imply membership.
  eq(
    'a listed item proves it too',
    versionIsAlreadySubmissionItem({
      state: 'PREPARE_FOR_SUBMISSION',
      items: [item('other'), item('v')],
      versionId: 'v',
    }).already,
    true
  );
  eq(
    'a submission holding only OTHER versions is not this one',
    versionIsAlreadySubmissionItem({
      state: 'PREPARE_FOR_SUBMISSION',
      items: [item('other')],
      versionId: 'v',
    }).already,
    false
  );

  // THE EXACT SHAPE OF THE DEFECT: the linkage a JSON:API collection omits unless the query asks
  // for it. Every item reads `undefined`, so the list can prove nothing - and the state must.
  const blind = [{ relationships: { appStoreVersion: {} } }, { relationships: {} }, {}];
  eq(
    'items whose relationship carries no data cannot prove membership',
    versionIsAlreadySubmissionItem({
      state: 'PREPARE_FOR_SUBMISSION',
      items: blind,
      versionId: 'v',
    }).already,
    false
  );
  eq(
    'but the same blind list with a READY_FOR_REVIEW state still answers correctly',
    versionIsAlreadySubmissionItem({ state: 'READY_FOR_REVIEW', items: blind, versionId: 'v' })
      .already,
    true
  );

  // A version this run CREATED carries no state and can be in no submission.
  eq(
    'a freshly created version is in no submission',
    versionIsAlreadySubmissionItem({ state: undefined, items: [], versionId: 'v' }).already,
    false
  );
  eq(
    'and a missing item list is not permission to assume membership',
    versionIsAlreadySubmissionItem({ state: 'PREPARE_FOR_SUBMISSION', versionId: 'v' }).already,
    false
  );

  // THE REQUEST IS ASSERTED TOO, because the fix is half a decision and half a query: a check that
  // reads a linkage the request never asked for is the defect, not the comparison.
  const src = readFileSync(new URL('./submit.mjs', import.meta.url), 'utf8');
  eq(
    "the submission's items are fetched WITH the appStoreVersion linkage included",
    src.includes('/items?include=appStoreVersion'),
    true
  );
}

process.stdout.write('\nwhich version slot does this release belong in?\n');
{
  const V = (versionString, appStoreState, id) => ({
    id,
    attributes: { versionString, appStoreState },
  });
  const slot = (versions) => chooseVersionSlot({ versions, versionString: '0.16.0' });

  eq('no versions at all -> create', slot([]).action, 'create');
  eq(
    'only PUBLISHED versions -> create, because a terminal version does not hold the slot',
    slot([V('0.15.0', 'READY_FOR_SALE', 'a'), V('0.14.15', 'READY_FOR_SALE', 'b')]).action,
    'create'
  );
  eq(
    'the slot already holds THIS version, editable -> use it',
    slot([V('0.16.0', 'PREPARE_FOR_SUBMISSION', 'c')]).action,
    'use'
  );
  eq(
    'the slot holds THIS version and it is already with Apple -> done, which is an answer not an error',
    slot([V('0.16.0', 'WAITING_FOR_REVIEW', 'd')]).action,
    'done'
  );
  eq(
    'the slot holds ANOTHER version, editable -> rename it, which is what the UI does',
    slot([V('0.14.15', 'PREPARE_FOR_SUBMISSION', 'e')]).action,
    'rename'
  );
  // THE EXACT SHAPE THAT BLOCKED 0.16.2, asserted from the slot side as well as the state side: a
  // prepared-and-forgotten version under a different name must be renamed, not refused. Refusing it
  // stops every later stable until a human clicks, and no click was ever going to come.
  eq(
    'the slot holds ANOTHER version prepared but never submitted -> rename it too',
    slot([V('0.16.1', 'READY_FOR_REVIEW', 'r')]).action,
    'rename'
  );
  eq(
    'and the same version READY_FOR_REVIEW under THIS name is used, not refused',
    slot([V('0.16.0', 'READY_FOR_REVIEW', 's')]).action,
    'use'
  );

  // A RELEASE SCRIPT MUST NEVER CANCEL A REVIEW. That is a human decision with a cost - a cancelled
  // review goes back to the end of Apple's queue - so the only correct move is to refuse and name
  // what is in the way.
  const blocked = slot([V('0.14.15', 'WAITING_FOR_REVIEW', 'f')]);
  eq('the slot holds ANOTHER version that is with Apple -> blocked', blocked.action, 'blocked');
  // `eq(..., true)` and not `ok(...)`: `ok` records an unconditional pass, so a two-argument call
  // would assert precisely nothing while printing a green line.
  eq(
    'and the refusal names the version AND its state, because both decide what a human does next',
    blocked.why.includes('0.14.15') && blocked.why.includes('WAITING_FOR_REVIEW'),
    true
  );

  // Apple is not supposed to allow two, so seeing two means an assumption is wrong - and picking
  // between them would be a guess about which one a human is working in.
  eq(
    'two non-terminal versions -> fail rather than pick',
    slot([V('0.14.15', 'PREPARE_FOR_SUBMISSION', 'g'), V('0.15.5', 'IN_REVIEW', 'h')]).action,
    'fail'
  );

  eq(
    'an unknown state is a refusal here too, not a guess',
    slot([V('0.16.0', 'SOMETHING_APPLE_ADDED_LATER', 'i')]).action,
    'fail'
  );
  eq(
    'an unreadable version list is a refusal, never permission',
    chooseVersionSlot({ versions: null, versionString: '0.16.0' }).action,
    'fail'
  );
}

// -------------------------------------------------------------------------------------------------
{
  process.stdout.write('\nwhat is Apple answering, and what is Apple failing to answer\n');

  // THE CASE. `v0.16.1` died on the LAST request of the submission chain - version created, build
  // attached, notes written - with `PATCH /v1/reviewSubmissions/{id} -> 500 An unexpected error
  // occurred on the server side`. That is not a decision about our request; it is Apple saying it
  // never reached one.
  eq('a 500 on a PATCH is Apple failing to answer, so it is retried', shouldRetry('PATCH', 500), true);
  eq('so is a 502, a 503 and a 504', [502, 503, 504].every((s) => shouldRetry('GET', s)), true);
  eq('and a 429, which is Apple asking for less, not answering', shouldRetry('PATCH', 429), true);
  eq('a request that got no response at all is retried too', shouldRetry('PATCH', 0), true);

  // A STATUS CODE IS AN ANSWER. Retrying one changes nothing and hides what it said.
  eq('a 409 is an ANSWER - the app already has a non-terminal version', shouldRetry('PATCH', 409), false);
  eq('a 401 is an ANSWER - the key or the JWT is wrong', shouldRetry('PATCH', 401), false);
  eq('a 422 is an ANSWER', shouldRetry('PATCH', 422), false);

  // THE HALF THAT MATTERS MOST. A 500 on a POST leaves us unable to say whether the thing was
  // created; retrying would quietly make a SECOND review submission. Those calls are protected
  // instead by asking what exists before creating anything.
  eq('a POST is NEVER retried, whatever the status', shouldRetry('POST', 500), false);
  eq('nor when it got no response at all', shouldRetry('POST', 0), false);

  eq('the method is read case-insensitively', shouldRetry('patch', 503), true);
}

{
  process.stdout.write('\na held version slot leaves by a different door than a failure\n');

  // THE DISTINCTION EXISTED IN THE TYPE AND DIED AT THE EXIT. `chooseVersionSlot` has always
  // separated `blocked` - Apple is still reviewing the previous version, which is expected and
  // means there is nothing to do - from `fail`, which means something is wrong. The caller threw
  // both as a bare `Error`, so both left through exit 1 and the workflow could only tell them
  // apart by reading the message. Three iOS jobs went red that way for the one outcome that is
  // GUARANTEED whenever we release faster than Apple reviews.
  const held = exitFor(new SlotHeldError("version 0.16.4 occupies the app's only version slot"));
  eq('a held slot leaves by its own exit code, not 1', held.code, EXIT_SLOT_HELD);
  eq('and says so as a notice, so the job does not go red', held.line.startsWith('::notice::'), true);
  eq('while still naming what holds the slot', held.line.includes('0.16.4'), true);

  const broken = exitFor(new Error('the key or the JWT is wrong'));
  eq('anything else still exits 1', broken.code, 1);
  eq('and is an error, because somebody has to act on it', broken.line.startsWith('::error::'), true);

  // A REJECTION IS NOT ALWAYS AN `Error`. Whatever reaches the handler has to leave through a code
  // the shell can read, rather than throwing inside the handler itself.
  eq('a non-Error rejection is a failure, not a deferral', exitFor('boom').code, 1);
  eq('and its text survives into the line', exitFor('boom').line.includes('boom'), true);

  // THE ONE THING A LATER EDIT COULD UNDO WITHOUT ANY OTHER ASSERTION NOTICING.
  eq('the two doors are different doors', EXIT_SLOT_HELD !== 1, true);
}


process.stdout.write('\n');
if (fail !== 0) {
  process.stdout.write(`${fail} of ${pass + fail} assertions FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${pass} assertions passed\n`);
