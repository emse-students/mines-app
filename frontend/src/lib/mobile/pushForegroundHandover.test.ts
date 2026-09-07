import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE BACKGROUND MLS ENGINE MUST RE-ASK WHETHER THE FOREGROUND HAS TAKEN OVER, UNDER THE LOCK.
 *
 * ## What this is for
 *
 * Two MLS engines share one `mls.bin`: the Tauri/WebView one the app runs in the foreground, and
 * the JNI one the FCM service and the WorkManager job run in the background. They have no common
 * lock - `MlsStateLock` covers FCM against Worker and nothing else - so the only thing keeping them
 * apart is `CanariFirebaseMessagingService`'s guard: if `MainActivity.isInForeground`, the push
 * returns and lets the WebSocket handle it. Its own comment lists the price of getting that wrong:
 * lost KeyPackages (`n_secrets` drops back to 1), epoch gaps, `UseAfterEviction`.
 *
 * **That guard is evaluated once, at receipt, and the work it protects runs for minutes.** Five
 * pushes land in the same second when the radios come back; they are processed one at a time behind
 * the lock, each costing an Argon2 round trip - about thirty seconds each on a Mi 9T. If the user
 * opens the app anywhere inside that queue, the foreground engine reconnects and drains the same
 * frames, and every remaining push decrypts against a ratchet it has already advanced.
 *
 * MEASURED, on NOTIF-10, 2026-09-07: all five pushes arrive at 02:09:28; at 02:10:07 the service
 * logs `showNotification: app in foreground -> notification suppressed`, so the foreground had
 * arrived; the next push still entered the JNI and returned `SecretReuseError` at 02:10:13. The
 * guard had answered forty seconds earlier and nothing asked again.
 *
 * ## Why the assertion is on the SOURCE
 *
 * `frontend/src-tauri/gen/android/app/src/test/java/fr/emse/canari/PushDecryptLadderTest.kt` exists
 * and **nothing runs it** - no workflow, no Makefile target invokes Gradle's unit tests. A test no
 * gate executes is not a gate. The convention that does run here is this directory: vitest holding
 * the native sources to a rule, the way `nativeStrings` and `androidFcmManifest` already do.
 *
 * ## What it cannot see
 *
 * It reads text, so it proves the call is written, not that it is reached - a `foregroundTookOver`
 * inside a branch that never runs would satisfy it. What it does catch is the change that actually
 * happens: somebody tidying away a check that looks redundant next to the one in
 * `onMessageReceived`, which is precisely the one that is not redundant.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);

const source = () => readFileSync(SERVICE, 'utf8');

/**
 * The body of a Kotlin function, from its signature to the next top-level `private fun` /
 * `internal fun` / `fun` at the same indentation. Crude, and sufficient: the file indents every
 * member by four spaces, so a four-space `fun` is the next sibling.
 */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`private fun ${name}(`);
  expect(start, `${name}() was renamed or removed - this test anchors on it`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {4}(private |internal )?fun /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the background push engine yields to a foreground that arrived while it waited', () => {
  it('has a single named predicate, and it reads the foreground flag', () => {
    const src = source();
    expect(src).toContain('private fun foregroundTookOver(');
    // One implementation: the two decrypt paths must not each grow their own idea of "taken over".
    expect(src.split('private fun foregroundTookOver(').length - 1).toBe(1);
    expect(bodyOf(src, 'foregroundTookOver')).toContain('MainActivity.isInForeground');
  });

  it.each(['tryDecrypt', 'tryDecryptWithCommitCatchup'])(
    '%s re-asks before touching the MLS state',
    (fn) => {
      expect(
        bodyOf(source(), fn),
        `${fn}() reads and rewrites mls.bin. Without a foregroundTookOver() check inside it, the ` +
          `decision is the one onMessageReceived made when the push arrived - which can be minutes ` +
          `earlier and several Argon2 round trips ago. See NOTIF-10, 2026-09-07.`
      ).toContain('foregroundTookOver(');
    }
  );

  it('still guards at receipt too - the late check replaces nothing', () => {
    // The early return is what spares the whole pipeline when the app is already open. The late
    // check is for the window it cannot cover. Losing either one costs a different defect.
    expect(source()).toContain('MainActivity.isInForeground && !showsWhileForeground');
  });

  it('the check sits INSIDE the locked region, not before it', () => {
    // Outside the lock it answers a question that can still change while this thread waits up to
    // five seconds to acquire it - which is the same fault one scope smaller.
    const body = bodyOf(source(), 'tryDecrypt');
    const lock = body.indexOf('MlsStateLock.LOCK.tryLock');
    const check = body.indexOf('foregroundTookOver(');
    expect(lock).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(lock);
  });
});
