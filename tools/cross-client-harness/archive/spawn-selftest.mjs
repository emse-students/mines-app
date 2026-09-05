/**
 * A SPAWN GIVEN A NAME IT CANNOT RESOLVE FAILS SILENTLY, AND THIS RIG HAS PAID FOR IT NINE TIMES.
 *
 * The runners used to sit at the harness root and moved into `archive/`. Every site that spawns one
 * by BARE NAME with `cwd` set to its own directory broke the same day - and broke QUIETLY, because
 * the child exits with `Module not found` on stderr and the parent typically records stdout, which
 * is empty. `scriptpath.mjs` was written for this, and its own docstring lists the first four:
 * `type.mjs`, `rows.mjs`, `ready-repair.mjs`, `healrevoke.mjs`. It ends with the sentence that
 * explains why a fifth was inevitable - *"Each was fixed where it was found, which is how a defect
 * gets found a fourth time."*
 *
 * It was then found four more times, on 2026-09-05: `tab236.mjs` (proven live - TAB-2 recorded
 * `pin.mjs failed: ... Module not found "pin.mjs"`, and TAB-3 CANNOT WORK without it, because
 * relaunching the browser raises the PIN gate), `notif7.mjs`, `burn.mjs`, and `heal-w2.mjs` twice
 * over (`newgroup.mjs` and `invite.mjs`, with no `cwd` at all, so they resolved against whatever
 * directory the campaign happened to be started from).
 *
 * A module that exists and is not reached fixes nothing. So this is the gate, and it is what makes
 * the rule checkable instead of remembered: **no `process.execPath` spawn may name its script as a
 * bare string literal.** `requireScript()` resolves it against both directories and THROWS naming
 * them, which turns a silent no-op into one sentence; `join(HARNESS_ROOT, name)` (what `atoms.mjs`
 * does) is equally absolute and equally fine.
 *
 * AND IT WAS FOUND A NINTH TIME ON 2026-09-05, BY A ROW, WITH THIS GATE ALREADY GREEN.
 * `newdevice.mjs` spawned `[script, ...args]` out of a two-line helper whose callers pass
 * `"login.mjs"`, so every mint driven from `archive/` - which is every HEAL-REVOKE row - exited 1
 * with `Module not found` on a stderr the helper discarded, and HEAL-REVOKE-1 recorded `INVALID`
 * blaming the product. The rule below used to be "no BARE STRING LITERAL in argv", and one line of
 * indirection is all it takes to satisfy that while breaking the thing it stands for. **It is now
 * an allowlist of RESOLVED FORMS**, which is the claim the rule was always making: the path handed
 * to the runtime must be absolute, and `requireScript(...)`, `join(...)` and a runtime flag are the
 * three ways to write that here. A variable head is rejected whatever it holds, because nothing can
 * be shown absolute by reading it.
 *
 * WHY A STYLE RULE AND NOT A RESOLUTION CHECK. Resolving each site the way the process would means
 * statically evaluating its `cwd:` expression, and those are written five different ways here - a
 * gate that has to guess is worse than one that forbids the guessable. The forbidden shape has an
 * exact, mechanical repair, and every current site already passes.
 *
 *   bun archive/spawn-selftest.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIRS = [ROOT, join(ROOT, 'archive')];

/**
 * Where a `process.execPath` spawn's argv array opens.
 *
 * Anchored on `process.execPath` rather than on the function name: `execFileSync('adb', ...)` and
 * `spawnSync('git', ...)` are everywhere here and none of them is spawning one of our scripts.
 */
const SPAWN = /(?:execFileSync|spawnSync)\(\s*process\.execPath\s*,\s*\[/g;

/**
 * THE FIRST ARGV ELEMENT, WHATEVER SHAPE IT IS - and the rule is about that element, not about a
 * string literal.
 *
 * THE GATE USED TO MATCH A QUOTED `*.mjs` NAME AND NOTHING ELSE, AND THAT LET THE NINTH SIGHTING
 * THROUGH. `newdevice.mjs` spawned `[script, ...args]` from a two-line helper called
 * `run("login.mjs", ...)`: a literal at the CALL SITE, a variable at the spawn. One line of
 * indirection, and a rule written about argv sees nothing at all. It cost HEAL-REVOKE-1 an `INVALID`
 * on 2026-09-05 whose sentence blamed the product - "the victim could not be brought to an enrolled
 * starting point" - for a child that had exited with `Module not found "login.mjs"` on a stderr the
 * helper discarded.
 *
 * SO THE RULE IS AN ALLOWLIST OF RESOLVED FORMS, WHICH IS THE CLAIM ANYWAY. What must be true is
 * that the path handed to the runtime is ABSOLUTE, and there are exactly three ways to write that
 * here: `requireScript(...)` / `findScript(...)` (which resolve against both script directories and
 * throw naming them), `join(...)` onto a root the file computed (what `atoms.mjs` does), and a
 * runtime FLAG like `-e`, which spawns no script at all. Anything else - a bare name, a variable, a
 * template string - is rejected, because none of them can be shown absolute by reading.
 *
 * A denylist of the one shape that had burnt us was never the claim; it was the last incident's
 * spelling. An allowlist is what a destructive-or-silent mechanism gets ([durable-rules](
 * ../../../docs/wiki/durable-rules.md)), and every current site already satisfies it.
 */
const RESOLVED = /^(?:requireScript|findScript|join)\s*\(/;
const A_RUNTIME_FLAG = /^(['"])-{1,2}[A-Za-z]/;
const isResolved = (head) => RESOLVED.test(head) || A_RUNTIME_FLAG.test(head);

/**
 * The source text of the first element of the array opening at `from`, or `null` at end of file.
 *
 * A SCANNER AND NOT A REGEX, because the element can carry commas of its own: `join(HERE, script)`
 * is the shape the rule most wants to ACCEPT, and a regex stopping at the first comma reads it as
 * `join(HERE`. Depth over `(`, `[` and `{`, with quotes and template literals skipped whole.
 */
function firstElement(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === '}') depth -= 1;
    else if (c === ']') {
      if (depth === 0) return src.slice(from, i).trim();
      depth -= 1;
    } else if (c === ',' && depth === 0) return src.slice(from, i).trim();
  }
  return null;
}

let failures = 0;
let scanned = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

const offenders = [];
for (const dir of DIRS) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const path = join(dir, file);
    if (path === fileURLToPath(import.meta.url)) continue; // this file quotes the shape it forbids
    const src = readFileSync(path, 'utf8');
    scanned++;
    let m;
    SPAWN.lastIndex = 0;
    while ((m = SPAWN.exec(src))) {
      const head = firstElement(src, m.index + m[0].length);
      if (head === null || isResolved(head)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      // NAMED BY WHAT IT IS, because the two shapes are repaired the same way but found differently:
      // a bare literal is visible at the spawn, a variable is only visible at the call site.
      const how = /^(['"]).*\.mjs\1$/.test(head)
        ? `spawns ${head} by bare name`
        : `hands the runtime an UNRESOLVED first argument: ${head}`;
      offenders.push(`${file}:${line} ${how}`);
    }
  }
}

ok(`every spawn hands the runtime a RESOLVED path (${scanned} file(s) scanned)`, offenders.length === 0);
for (const o of offenders) console.log(`         ${o}`);

// VACUITY, because a regex that matches nothing passes every file. The gate has to be shown capable
// of failing, on the exact text it exists to reject - otherwise a later edit to the pattern turns it
// into a green light nobody notices, which is the failure mode `rawcheck.mjs` had for six days.
const judge = (text) => {
  const re = new RegExp(SPAWN.source, 'g');
  const m = re.exec(text);
  if (!m) return 'not a spawn of ours';
  const head = firstElement(text, m.index + m[0].length);
  return head === null || isResolved(head) ? 'accepted' : 'REJECTED';
};

const SPECIMEN = `const r = spawnSync(process.execPath, ['pin.mjs', '--device', DEVICE], { cwd: HERE });`;
ok('and the rule can FAIL - it rejects a bare name', judge(SPECIMEN) === 'REJECTED');

// THE SHAPE THE OLD RULE COULD NOT SEE, kept as a specimen so it can never stop being seen. This is
// `newdevice.mjs` before 2026-09-05: the name is a literal one line up, at `run("login.mjs", ...)`.
const INDIRECT = `const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });`;
ok('and it rejects a NAME THAT ARRIVED IN A VARIABLE', judge(INDIRECT) === 'REJECTED');

// AND IT MUST NOT FIRE ON THE REPAIR, or the only way to satisfy it would be to delete the spawn.
const REPAIRED = `const r = spawnSync(process.execPath, [requireScript('pin.mjs'), '--device', DEVICE]);`;
const RESOLVED_VAR = `const r = spawnSync(process.execPath, [requireScript(script), ...args], { cwd: HARNESS_ROOT });`;
const JOINED = `const r = spawnSync(process.execPath, [join(HARNESS_ROOT, script), ...args]);`;
const EVAL = `spawnSync(process.execPath, ["-e", "setTimeout(function () {}, 500)"]);`;
ok('and it does not fire on requireScript()', judge(REPAIRED) === 'accepted');
ok('and it does not fire on requireScript(<variable>)', judge(RESOLVED_VAR) === 'accepted');
ok('and it does not fire on join(HARNESS_ROOT, ...)', judge(JOINED) === 'accepted');
// `join(HERE, script)` carries a comma INSIDE the element, which is the case a regex stopping at the
// first comma gets wrong - and getting it wrong here means rejecting the repair.
ok('and it reads past a comma inside the element', judge(JOINED) === 'accepted');
ok('and it does not fire on a runtime flag, which spawns no script', judge(EVAL) === 'accepted');

// A spawn of something that is NOT one of our scripts is not this gate's business.
const FOREIGN = `execFileSync('adb', ['shell', 'am', 'kill', PKG]);`;
ok('and it does not fire on a spawn of a foreign binary', judge(FOREIGN) === 'not a spawn of ours');

console.log(
  failures
    ? `[spawn] ${failures} FAILURE(S) - a spawn that cannot resolve its script does nothing, quietly`
    : '[spawn] clean - every spawned script is resolved through scriptpath.mjs, not guessed',
);
process.exit(failures ? 1 : 0);
