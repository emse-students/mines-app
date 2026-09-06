import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guards on the ORDER inside `handleSessionExpired`, which is the whole defect.
 *
 * WHAT BROKE, MEASURED ON W1 ON 2026-08-28. `_sessionExpiredHandled` exists to deduplicate the
 * LOGOUT between the several observers that reach the same verdict at once. It was also gating the
 * lines that release whoever is waiting on the PIN modal right now - and those two questions have
 * different lifetimes. "Has a logout already run for this expiry" is true once; "does this submit
 * need its modal closed" is true again every time. Using the first for the second silenced the
 * trigger: a PIN submit on a client whose refresh cookie was already proven dead threw
 * `SessionExpiredError`, reached this function, and returned at the guard without touching the
 * modal. `handlePinSubmit` clears its watchdog on `onMlsReady` and `onLoginFailed` only, so ten
 * seconds later the spinner unblocked with `auth_pin_timeout` - "please try again" - for a latch
 * that is permanent by design. The user could retry for ever.
 *
 * WHY A SOURCE GUARD AND NOT A RENDER TEST. The behaviour spans a Svelte component's private state,
 * a module-level auth latch and SvelteKit's `goto`; a harness faking all three would assert its own
 * mocks. What actually broke is an ORDER between two statements in one function, which is precisely
 * what a source guard pins well - and what a later edit could reverse with every other test green.
 * Same technique and same reasoning as `session/offlineUnlock.test.ts`.
 */
// FROM `process.cwd()`, NOT FROM `import.meta.url`, WHICH IS WHAT THE SIBLING SOURCE GUARDS USE.
// Under this directory Vite hands the module a non-`file:` `import.meta.url` - the svelte plugin
// processes it - and `fileURLToPath` then throws "The URL must be of scheme file". Vitest runs with
// the frontend root as its working directory, so the path is stated from there.
const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

/** The body of `handleSessionExpired`, from its signature to the next function declaration. */
const handlerBody = (() => {
  const start = source.indexOf('async function handleSessionExpired()');
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?function /);
  return rest.slice(0, end === -1 ? undefined : end);
})();

describe('a session loss releases every waiting caller, not only the first', () => {
  it('closes the PIN modal before it consults the one-shot logout guard', () => {
    const release = handlerBody.indexOf('dismissAuthPrompts()');
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    expect(release).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // THE ASSERTION IS THE ORDER. Reversed, this is the defect exactly: the second and every later
    // expiry returns with the modal still up and its watchdog still armed.
    expect(release).toBeLessThan(guard);
  });

  it('clears the spinner and the in-progress flags on that same unconditional path', () => {
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    const before = handlerBody.slice(0, guard);
    // `pinLoading` is cleared inside `dismissAuthPrompts`; these are the flags that would otherwise
    // make `loginImpl` bail silently on the NEXT attempt.
    expect(before).toMatch(/pinError = '';/);
    expect(before).toMatch(/_loginInProgress = false;/);
    expect(before).toMatch(/globalSession\.isLoginInProgress = false;/);
  });

  it('still performs the logout exactly once', () => {
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    const after = handlerBody.slice(guard);
    // Only a logout may be deduplicated, and it must stay deduplicated: `clearAuth` revokes the
    // refresh cookie server-side, and a second `goto` mid-navigation is a wasted round trip.
    expect(after).toMatch(/_sessionExpiredHandled = true;/);
    expect(after).toMatch(/await clearAuth\(\)/);
    expect(after).toMatch(/goto\('\/login'/);
    expect(handlerBody.slice(0, guard)).not.toMatch(/clearAuth/);
  });

  it('says so when it takes the deduplicated path, rather than returning silently', () => {
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    const branch = handlerBody.slice(guard, handlerBody.indexOf('return;', guard));
    // EVERY SWALLOWED BRANCH LOGS. This is the branch that used to swallow the whole event, and a
    // line here is the only trace a repeat expiry can leave.
    expect(branch).toMatch(/appendLog\(/);
  });
});

/**
 * THE PIN MODAL IS RELEASED BY A PROOF, NEVER BY A CLOCK - and it used to be by a clock.
 *
 * A ten-second watchdog called itself a safety net for "an unexpected early return or a hung
 * network call" and, on expiry, set `auth_pin_timeout` - "unlocking is taking longer than expected,
 * please try again" - which is a claim about a login it had no way to inspect. Measured on a Mi 9T
 * on 2026-09-06, three cold starts out of three: it fired at 18:47:58 and the login succeeded at
 * 18:48:10, having spent those twelve seconds inside one native call that decrypts a 19.9 MB
 * `mls.bin` and logs nothing while it runs. So the clock could not tell "hung" from "working", and
 * the retry it advised lands on `loginImpl`'s "a login already owns the flow" guard, which returns
 * silently - the watchdog manufacturing the exact condition it exists to catch.
 *
 * What replaces it is the fact the clock was standing in for. `login()` always settles, so a caller
 * can only be stranded if it settles WITHOUT having answered; that is observable, and it is now
 * observed. These guards pin the three properties an edit could quietly lose: no timer decides the
 * outcome, every terminal path marks the login answered, and the settled-with-no-answer branch
 * exists and is guarded on `answered`.
 */
describe('the PIN modal is released by a proof, never by a clock', () => {
  const submitBody = (() => {
    const start = source.indexOf('function handlePinSubmit(');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const end = rest.search(/\n {2}(?:async )?function /);
    return rest.slice(0, end === -1 ? undefined : end);
  })();

  it('has no timer that can decide the outcome', () => {
    // ASSERTED ON THE STATEMENT, NOT ON A NAME. One `setTimeout` remains and is allowed:
    // `stepTimer` only changes the label under the spinner and says nothing about whether the login
    // worked. The property that matters is that no timer can write the verdict, so that is what is
    // read - a guard matching the word "watchdog" would be satisfied by a rename.
    const timerBodies = [...submitBody.matchAll(/setTimeout\(\(\) => \{([\s\S]*?)\n {4}\}/g)].map(
      (mm) => mm[1]
    );
    expect(timerBodies).toHaveLength(1);
    for (const body of timerBodies) {
      expect(body).not.toMatch(/pinError/);
      expect(body).not.toMatch(/pinLoading = false/);
    }
  });

  it('marks the login answered on every path that can end it', () => {
    expect(submitBody).toMatch(/onMlsReady: \(\) => \{\s*answered = true;/);
    expect(submitBody).toMatch(/onLoginFailed: \([\s\S]*?answered = true;/);
    expect(submitBody).toMatch(/\.catch\(\(e: unknown\) => \{[\s\S]*?answered = true;/);
  });

  it('releases the modal when login() settles without answering, and only then', () => {
    // The guard is what keeps a NORMAL success from clearing a modal it never opened, and what
    // keeps this branch from firing after `onLoginFailed` has already written the real message.
    expect(submitBody).toMatch(
      /\.then\(\(\) => \{[\s\S]*?if \(answered \|\| !pinLoading\) return;/
    );
    expect(submitBody).toMatch(/\.then\(\(\) => \{[\s\S]*?auth_pin_no_result/);
  });
});
