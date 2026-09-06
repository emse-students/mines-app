#!/usr/bin/env bun
/**
 * Assert that the four GitHub repositories of this ecosystem have the SAME CI/CD SHAPE, and that
 * nothing in any of them is dead.
 *
 * WHY THIS EXISTS. The four repositories were converged onto one delivery model on 2026-09-04 - four
 * visible workflows, two libraries, one arming mechanism, one audit classifier, one release gate -
 * and every part of that is a claim somebody can quietly break in one repository without breaking a
 * single test. Nothing else in this estate can see across repositories: each one's CI only ever
 * looks at its own tree. This script is the only thing that reads all four at once, so it is the
 * only place the word "homogeneous" can be checked rather than asserted in prose.
 *
 * WHAT IT IS NOT. It is not a gate and is deliberately not wired into any pipeline: it needs the
 * four repositories checked out side by side, which no runner has. Run it by hand after touching
 * anything under `.github/` in any of them.
 *
 *   bun tools/ecosystem-shape/shape.mjs
 *   CANARI_ECOSYSTEM_ROOT=/path/to/parent bun tools/ecosystem-shape/shape.mjs
 *
 * Exit 0 = the four agree. Exit 1 = at least one claim below is false, and it says which.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The parent directory holding all four checkouts. Two levels up from this file by default. */
const ROOT = process.env.CANARI_ECOSYSTEM_ROOT
  ? resolve(process.env.CANARI_ECOSYSTEM_ROOT)
  : resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');

/** Label -> directory name under ROOT. The label is what a failure line names. */
const REPOS = [
  ['Canari', 'Canari'],
  ['Sky', 'Sky'],
  ['MiGallery', 'MiGallery'],
  ['Portail-etu', 'refonte-portail-etu'],
];

/** The four workflows that have a row of their own in the Actions list, in every repository. */
const VISIBLE = ['ci.yml', 'release.yml', 'arm-auto-merge.yml', 'scheduled.yml'];
/** Called workflows every repository has: no trigger of their own, no row of their own. */
const LIBRARIES = ['code-analysis.yml'];

/**
 * THE DEPLOY LIBRARY IS NOT ONE FILE EVERYWHERE, AND THE DIVERGENCE WAS MEASURED (2026-09-07).
 *
 * Sky, MiGallery and Portail-etu each deploy ONE estate: `deploy.yml` is ~170 lines there, holds one
 * or two jobs, declares no `phase` input at all, and `release.yml` calls it ONCE. They have nothing
 * to split.
 *
 * Canari deploys TWO estates and gates production on both app stores, so its file was called TWICE
 * with a `phase: build | production` switch. GitHub materialises EVERY job of a called workflow as a
 * row in the run graph, including the jobs whose `if:` cannot hold on that call - so each call drew
 * the other call's jobs as skipped rows that were INCAPABLE of running. Measured on `v0.16.4` (run
 * 34057019347): 22 rows, 5 skipped, 4 of those 5 structurally impossible. It is three files there
 * now, one per thing done: build the images, serve dev, serve production.
 *
 * SO THIS IS A REAL DIFFERENCE AND NOT DRIFT, and the homogeneity that was asked for is untouched:
 * the FOUR VISIBLE workflows are identical everywhere, which is the property above, and a repository
 * that grows a second estate should split the same way rather than be held to one file.
 */
const DEPLOY_LIBRARIES = { Canari: ['build.yml', 'serve-dev.yml', 'serve-prod.yml'] };
const DEFAULT_DEPLOY_LIBRARIES = ['deploy.yml'];
/** Canari ships to two app stores, which nothing else here does. */
const CANARI_EXTRA_LIBRARIES = ['android.yml', 'ios.yml'];

/**
 * Triggers that mean "somebody pushed code", as opposed to "somebody published a release". No job
 * reachable from one of these may deploy: that is the whole point of the 2026-09-04 model.
 */
const PUSH_LIKE = new Set(['push', 'workflow_run', 'pull_request', 'pull_request_target', 'schedule']);

const failures = [];

/** Record a broken claim and print it against the repository it belongs to. */
function fail(label, message) {
  failures.push(`${label}: ${message}`);
  console.log(`   FAIL  ${message}`);
}

/** Print a claim that held. */
function ok(message) {
  console.log(`   ok    ${message}`);
}

/** The trigger names a workflow declares, whichever of YAML's three shapes `on:` was written in. */
function triggersOf(doc) {
  const on = doc?.on ?? doc?.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

/** Every `*.sh` under a directory, recursively. Returns absolute paths. */
function shellScriptsIn(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...shellScriptsIn(full));
    else if (entry.endsWith('.sh')) out.push(full);
  }
  return out;
}

for (const [label, dir] of REPOS) {
  console.log(`\n===== ${label}`);
  const root = join(ROOT, dir);
  const wdir = join(root, '.github/workflows');
  if (!existsSync(wdir)) {
    fail(label, `no .github/workflows at ${wdir} - is the checkout there?`);
    continue;
  }

  const names = readdirSync(wdir).filter((n) => n.endsWith('.yml'));
  const text = Object.fromEntries(names.map((n) => [n, readFileSync(join(wdir, n), 'utf8')]));
  const docs = Object.fromEntries(names.map((n) => [n, Bun.YAML.parse(text[n])]));

  // -- 1. THE SAME SHAPE ------------------------------------------------------------------------
  // Both directions matter. A MISSING file is a capability one repository lost; an EXTRA one is
  // the thing the user asked to stop ("ca inonde la console github"), and it arrives one
  // well-meant afternoon at a time.
  const deployLibs = DEPLOY_LIBRARIES[label] ?? DEFAULT_DEPLOY_LIBRARIES;
  const expected = new Set([
    ...VISIBLE,
    ...LIBRARIES,
    ...deployLibs,
    ...(label === 'Canari' ? CANARI_EXTRA_LIBRARIES : []),
  ]);
  const missing = [...expected].filter((n) => !names.includes(n)).sort();
  const extra = names.filter((n) => !expected.has(n)).sort();
  if (missing.length) fail(label, `missing workflow(s): ${missing.join(', ')}`);
  if (extra.length) fail(label, `workflow(s) nobody expected: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) ok(`exactly the expected ${expected.size} workflow files`);

  // -- 2. NOTHING DEPLOYS ON A PUSH -------------------------------------------------------------
  // The user's rule, 2026-09-04: *"le push sur main ne doit rien deployer, c'est la release qui le
  // fait"*. Two things betray a deploy: a self-hosted runner (this estate's boxes) and a call to
  // `deploy.yml`. `scheduled.yml` is exempt on the first: it takes reports ON the production box,
  // which is a fact only reachable there, and it ships nothing.
  let before = failures.length;
  for (const n of names) {
    const trig = new Set(triggersOf(docs[n]));
    if (![...trig].some((t) => PUSH_LIKE.has(t))) continue;
    for (const [jobName, job] of Object.entries(docs[n]?.jobs ?? {})) {
      if (typeof job !== 'object' || job === null) continue;
      if (job['runs-on'] === 'self-hosted' && n !== 'scheduled.yml') {
        fail(label, `${n} (${jobName}) reaches a self-hosted runner from ${[...trig].sort().join(', ')}`);
      }
      // Every deploy library of THIS repository, not one hard-coded name: Canari has three.
      const lib = typeof job.uses === 'string' ? deployLibs.find((d) => job.uses.includes(d)) : undefined;
      if (lib) {
        fail(label, `${n} (${jobName}) calls ${lib} from ${[...trig].sort().join(', ')}`);
      }
    }
  }
  if (failures.length === before) ok('no deploy is reachable from a push, a workflow_run or a pull request');

  // -- 3 + 4. NO DEAD TRIGGER, NO DEAD FILE -----------------------------------------------------
  // A `workflow_call` nobody calls is a claim the file makes about itself that is not true, and
  // three of them were found on 2026-09-04 - each written for a mechanism that had been deleted.
  before = failures.length;
  const called = new Set();
  for (const n of names) {
    for (const job of Object.values(docs[n]?.jobs ?? {})) {
      if (typeof job?.uses === 'string') called.add(basename(job.uses));
    }
  }
  for (const n of names) {
    const trig = triggersOf(docs[n]);
    const own = trig.filter((t) => t !== 'workflow_call');
    if (trig.includes('workflow_call') && !called.has(n)) {
      fail(label, `${n} declares workflow_call and nothing calls it`);
    }
    if (!own.length && !called.has(n)) {
      fail(label, `${n} has no trigger of its own and no caller - it can never run`);
    }
  }
  if (failures.length === before) ok('every workflow_call has a caller, and every file can run');

  // -- 5. NO DEAD SCRIPT ------------------------------------------------------------------------
  // A script is alive if a workflow, another script or the Makefile names it. Deliberately a
  // substring search over all three: a script reached only through a variable still counts, and a
  // false positive here is far cheaper than deleting something that runs.
  before = failures.length;
  const scripts = shellScriptsIn(join(root, '.github/scripts'));
  if (scripts.length) {
    let haystack = Object.values(text).join('\n');
    for (const f of scripts) haystack += readFileSync(f, 'utf8');
    const mk = join(root, 'Makefile');
    if (existsSync(mk)) haystack += readFileSync(mk, 'utf8');
    for (const f of scripts) {
      if (!haystack.includes(basename(f))) fail(label, `nothing runs .github/scripts/${basename(f)}`);
    }
    if (failures.length === before) {
      ok(`all ${scripts.length} CI scripts are referenced by something that runs them`);
    }
  }

  const visible = names.filter((n) => triggersOf(docs[n]).some((t) => t !== 'workflow_call')).sort();
  const libs = names.filter((n) => !triggersOf(docs[n]).some((t) => t !== 'workflow_call')).sort();
  console.log(`   shape: ${visible.join(' ')}`);
  console.log(`   libs:  ${libs.join(' ')}`);
}

// -- 6. THE FILES THAT MUST NOT FORK ---------------------------------------------------------------
//
// Compared RAW, comments included, wherever that is honest. A mechanism can be identical while the
// prose around it explains it two different ways, and the prose is what the next person reads before
// deciding whether a difference is deliberate. `arm-auto-merge.yml` carried exactly that: Canari
// named `client-id`, the three others `app-id`, nothing said why, and either direction looked like
// the convergence.
const SHARED_EVERYWHERE = [
  '.github/scripts/audit-dependencies.sh',
  '.github/scripts/tests/audit-dependencies.test.sh',
];

// TWO FILES ARE COMPARED ACROSS THE THREE SIBLINGS ONLY, and Canari is excluded BY NAME rather than
// by being quietly absent: its `release-preflight.sh` asks FIVE questions where theirs ask three.
// The two extra ones are things only Canari has - `dev.canari-emse.fr` must already have served the
// commit, and `store/whats-new.txt` must name the version, because a stable there reaches the App
// Store and Play. Making five identical to three would delete a gate; three identical to five would
// invent one.
const SHARED_BY_SIBLINGS = [
  ['.github/scripts/release-preflight.sh', 'Canari asks five questions, not three'],
  ['.github/scripts/tests/release-preflight.test.sh', 'it tests the five-question version'],
];

/** Strip full-line comments and blank lines: what is left is what runs. */
function codeOnly(raw) {
  return raw
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join('\n');
}

/** Hash one file the same way in every repository, so CRLF cannot make two copies look different. */
function digest(path, transform) {
  const raw = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  return createHash('md5').update(transform ? transform(raw) : raw).digest('hex').slice(0, 8);
}

/** Assert that one path is identical across a set of repositories, and say so either way. */
function compare(shared, repos, note = '', transform = undefined) {
  const digests = new Map();
  for (const [label, dir] of repos) {
    const p = join(ROOT, dir, shared);
    if (existsSync(p)) digests.set(label, digest(p, transform));
  }
  const name = basename(shared).padEnd(46);
  const absent = repos.filter(([label]) => !digests.has(label)).map(([label]) => label);
  if (absent.length) {
    failures.push(`${shared} is missing from ${absent.join(', ')}`);
    console.log(`   FAIL  ${name} missing from ${absent.join(', ')}`);
    return;
  }
  const unique = new Set(digests.values());
  if (unique.size === 1) {
    console.log(`   ok    ${name} ${digests.size} copies, identical (${[...unique][0]})${note}`);
  } else {
    const where = [...digests].map(([k, v]) => `${k}=${v}`).join(', ');
    failures.push(`${shared} differs: ${where}`);
    console.log(`   FAIL  ${name} ${where}`);
  }
}

console.log('\n===== the files that must not fork');
for (const shared of SHARED_EVERYWHERE) compare(shared, REPOS);

const SIBLINGS = REPOS.filter(([label]) => label !== 'Canari');

// `arm-auto-merge.yml` IS COMPARED TWICE, AND THE TWO ANSWERS MEAN DIFFERENT THINGS. Its YAML is
// identical in all four - same trigger, same guard, same `client-id`, same single call - and that is
// the property that must never fork. Its PROSE is identical in the three siblings and longer in
// Canari, whose copy cites the two pull requests the behaviour was measured on THERE (#329, #330).
// Copying a measurement into three repositories that never made it would be an invention.
const ARM = '.github/workflows/arm-auto-merge.yml';
compare(ARM, REPOS, '  [YAML only - the mechanism]', codeOnly);
compare(ARM, SIBLINGS, '  [prose too; Canari cites measurements made only there]');

for (const [shared, why] of SHARED_BY_SIBLINGS) compare(shared, SIBLINGS, `  [Canari excluded: ${why}]`);

console.log(`\n${'='.repeat(72)}`);
if (failures.length) {
  console.log(`${failures.length} PROBLEM(S):`);
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('The four repositories have the same shape, and nothing in them is dead.');
