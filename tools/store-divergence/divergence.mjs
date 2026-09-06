#!/usr/bin/env node
/**
 * DID THE LAST STABLE RELEASE ACTUALLY REACH BOTH STORES?
 *
 * WHAT THIS EXISTS FOR, AND IT COST THREE DAYS. A release publishes the web, Google Play and the
 * App Store from one run. Nothing ever asked afterwards whether the stores got it. On 2026-09-04
 * the App Store submission stopped on an occupied version slot, the iOS job went red, and
 * `production` - a success dependency on that job - was skipped. It happened again on v0.16.3 and
 * again on v0.16.4. **Production sat on v0.16.1 for three days while two releases reported
 * themselves shipped**, and it was found by a human noticing that a fix was not live.
 *
 * THE SUBMISSION IS NO LONGER ALLOWED TO FAIL FOR THAT REASON (`EXIT_SLOT_HELD` in
 * `../app-store/submit.mjs`), which fixes the web being held hostage - and creates the gap this
 * file closes. A deferral is now GREEN, so the release ends with the version uploaded to TestFlight
 * and never submitted, and nothing would say so. Making a failure quiet without adding a report is
 * how a three-day silence becomes a permanent one.
 *
 * WHAT IT REFUSES TO CONFLATE. A store not carrying the version has four causes and a human acts on
 * each differently:
 *
 *   live           the store serves it. Nothing to do.
 *   pending        it is WITH the store - Apple reviews in days. Nothing to do, and saying
 *                  otherwise every morning is how a report teaches its reader to skip it.
 *   not-submitted  it was uploaded and never sent. THIS IS THE DEFERRAL: re-run the job.
 *   rejected       the store said NO. Somebody must read what they said and fix it.
 *   unknown        THE REPORT COULD NOT LOOK. Never silently a pass: a credential that expired
 *                  would otherwise turn this whole file into a green light.
 *
 * Usage: bun tools/store-divergence/divergence.mjs
 *   env  GH_TOKEN                             to read the latest stable release
 *        ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8, APP_BUNDLE_ID   the App Store half
 *        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON     the Play half (see ../play-vitals/lib.mjs)
 *
 * Exit 0 - every store is `live` or `pending`.
 * Exit 1 - at least one store needs a human, and the line above it says which and why.
 */

import { VERSION_DONE, VERSION_IN_REVIEW, VERSION_REJECTED, mintToken } from '../app-store/submit.mjs';

/** The four outcomes that mean somebody has to do something. `pending` and `live` do not. */
export const NEEDS_A_HUMAN = new Set(['not-submitted', 'rejected', 'unknown']);

/**
 * Does this Play release name describe the version we are looking for?
 *
 * MEASURED ON THE REAL TRACKS (2026-09-07), because the field has two formats and guessing either
 * one alone produces a false verdict:
 *
 *     production  name="0.16.5"             <- what our pipeline writes
 *     beta        name="10012 (0.10.12)"    <- Play's own default naming, on older releases
 *
 * An exact match alone would report the beta track absent; a substring match alone would match
 * `0.16.5` inside `0.16.50`. So: equal, or the parenthesised form exactly.
 *
 * @param {string | undefined} name
 * @param {string} version
 */
export function matchesVersion(name, version) {
  if (!name || !version) return false;
  return name === version || name.endsWith(`(${version})`);
}

/**
 * What the App Store holds for this version, from the whole version list.
 *
 * @param {{wanted: string, versions: unknown}} input
 * @returns {{state: string, why: string}}
 */
export function classifyAppStore({ wanted, versions }) {
  if (!Array.isArray(versions))
    return { state: 'unknown', why: 'App Store Connect returned no version list, so nothing here is known' };

  const mine = versions.find((v) => v?.attributes?.versionString === wanted);
  if (!mine)
    return {
      state: 'not-submitted',
      why: `the App Store has no version ${wanted} at all - the release uploaded a build to TestFlight and no version was ever created for it`,
    };

  const st = mine.attributes?.appStoreState;
  if (!st) return { state: 'unknown', why: `version ${wanted} exists but carries no appStoreState` };
  if (VERSION_DONE.has(st)) return { state: 'live', why: `${wanted} is ${st}` };
  if (VERSION_IN_REVIEW.has(st)) return { state: 'pending', why: `${wanted} is ${st} - with Apple, nothing to do` };
  if (VERSION_REJECTED.has(st))
    return { state: 'rejected', why: `${wanted} is ${st} - somebody has to read what Apple said and act on it` };

  // PREPARE_FOR_SUBMISSION and READY_FOR_REVIEW: created, never sent. This is the deferral.
  return {
    state: 'not-submitted',
    why: `${wanted} exists and is ${st} - it was prepared and never submitted, which is what an occupied slot leaves behind. Re-run the iOS job once the slot is free`,
  };
}

/**
 * What Google Play's `production` track holds.
 *
 * ONLY `production`, deliberately: this file asks about STABLE releases, and a stable goes to that
 * track alone. A version sitting on `internal` is a pre-release doing exactly what it should.
 *
 * @param {{wanted: string, tracks: unknown}} input
 * @returns {{state: string, why: string}}
 */
export function classifyPlay({ wanted, tracks }) {
  if (!Array.isArray(tracks))
    return { state: 'unknown', why: 'Google Play returned no track list, so nothing here is known' };

  const prod = tracks.find((t) => t?.track === 'production');
  if (!prod) return { state: 'unknown', why: 'Play has no `production` track in its answer' };

  const releases = Array.isArray(prod.releases) ? prod.releases : [];
  const mine = releases.find((r) => matchesVersion(r?.name, wanted));
  if (!mine) {
    const holds = releases.map((r) => `${r?.name} (${r?.status})`).join(', ') || 'nothing';
    return {
      state: 'not-submitted',
      why: `the Play production track does not carry ${wanted} - it holds ${holds}`,
    };
  }
  if (mine.status === 'completed') return { state: 'live', why: `${wanted} is completed on production` };
  return { state: 'pending', why: `${wanted} is on production with status ${mine.status}` };
}

/**
 * The run's verdict, and the exit code that carries it.
 *
 * @param {Record<string, {state: string, why: string}>} stores
 * @returns {{ok: boolean, acting: string[]}}
 */
export function verdict(stores) {
  const acting = Object.entries(stores)
    .filter(([, v]) => NEEDS_A_HUMAN.has(v.state))
    .map(([name]) => name);
  return { ok: acting.length === 0, acting };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE I/O, WHICH IS DELIBERATELY THIN
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Every fetch below can fail, and each failure becomes `unknown` rather than an exception: a report
// that dies on its first request tells you less than one that says which half it could not read.

/** The newest published, non-draft, non-prerelease release - the only kind that owes both stores. */
async function latestStable(repo, ghToken) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for the release list`);
  const rows = await r.json();
  const stable = (Array.isArray(rows) ? rows : []).find((x) => !x.draft && !x.prerelease);
  if (!stable) throw new Error('no published stable release found in the last 30');
  return { tag: stable.tag_name, version: String(stable.tag_name).replace(/^v/, ''), at: stable.published_at };
}

async function appStoreVersions() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const p8 = process.env.ASC_API_KEY_P8;
  const bundleId = process.env.APP_BUNDLE_ID;
  if (!keyId || !issuerId || !p8 || !bundleId) throw new Error('App Store credentials are not set');

  const jwt = mintToken({ keyId, issuerId, privateKey: Buffer.from(p8, 'base64').toString('utf8') });
  const get = async (path) => {
    const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) throw new Error(`App Store Connect answered ${r.status} for ${path}`);
    return r.json();
  };
  const apps = await get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  const app = apps?.data?.[0];
  if (!app) throw new Error(`no app with bundle id ${bundleId}`);
  const all = await get(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=50`);
  return all?.data ?? null;
}

/** Imported HERE and not at the top: `../play-vitals/lib.mjs` reaches for a credential on use. */
async function playTracks() {
  const { tracks } = await import('../play-vitals/lib.mjs');
  const t = await tracks();
  if (!Array.isArray(t) || t.length === 0) throw new Error('Play returned no tracks');
  return t;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'emse-students/canari';
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!ghToken) {
    process.stderr.write('::error::GH_TOKEN is not set, so the release to check cannot be read\n');
    process.exit(1);
  }

  const rel = await latestStable(repo, ghToken);
  process.stdout.write(`the last stable release is ${rel.tag}, published ${rel.at}\n`);

  const safe = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const asc = await safe(appStoreVersions);
  const play = await safe(playTracks);

  const stores = {
    'App Store': asc?.error
      ? { state: 'unknown', why: `could not read App Store Connect: ${asc.error}` }
      : classifyAppStore({ wanted: rel.version, versions: asc }),
    'Google Play': play?.error
      ? { state: 'unknown', why: `could not read Google Play: ${play.error}` }
      : classifyPlay({ wanted: rel.version, tracks: play }),
  };

  const lines = Object.entries(stores).map(([name, v]) => `  ${name.padEnd(12)} ${v.state.padEnd(14)} ${v.why}`);
  process.stdout.write(`${lines.join('\n')}\n`);

  const { ok, acting } = verdict(stores);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(stores).map(([n, v]) => `| ${n} | \`${v.state}\` | ${v.why} |`).join('\n');
    await Bun.write(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### ${rel.tag} across the stores`,
        '',
        '| store | state | evidence |',
        '| --- | --- | --- |',
        rows,
        '',
        ok
          ? 'Both stores have it, or are still working on it. Nothing to do.'
          : `**${acting.join(' and ')} need a human.** The evidence column says which errand: a version that was never submitted is a re-run of the store job; a refusal has to be read and fixed.`,
        '',
      ].join('\n')
    );
  }

  if (ok) {
    process.stdout.write(`\n${rel.tag} is with both stores.\n`);
    return;
  }
  process.stderr.write(
    `::error::${rel.tag} has not reached ${acting.join(' and ')}. ` +
      Object.entries(stores)
        .filter(([n]) => acting.includes(n))
        .map(([n, v]) => `${n}: ${v.why}`)
        .join('; ') +
      '\n'
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('divergence.mjs')) {
  main().catch((e) => {
    process.stderr.write(`::error::the store divergence report could not run - ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
