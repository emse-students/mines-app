#!/usr/bin/env bun
/**
 * Asks a DEPLOYED estate whether the `mls-core` WebAssembly it serves can panic on the target it
 * is being served to.
 *
 * WHY THIS EXISTS. On 2026-09-06 `v0.16.4` deployed green, both estates answered `HTTP 200`, and
 * every browser login was refused with "PIN incorrect" - `std::time::SystemTime::now()` had reached
 * a crate that compiles to wasm32, where it is not implemented and PANICS. Nothing between the merge
 * and the outage could have seen it: it compiles, the deploy is green, and the site answers. The
 * only place the defect is visible without a login is the artefact itself.
 *
 * WHAT IT DOES. Walks the JS chunk graph from the landing page, finds the `mls_wasm_bg.<hash>.wasm`
 * the app would load, downloads it, and refuses if it carries `std`'s unsupported-platform panic
 * text. Same predicate as `frontend/scripts/check-wasm-no-unsupported.mjs`, which guards the BUILD;
 * this one guards what a given host is actually serving, which is a different question - a build can
 * be fixed and the estate still be serving the old image.
 *
 * WHAT IT IS NOT. It is not a login. It cannot see a defect that needs a session, and the honest
 * post-deploy check is a real sign-in on the deployed build. This is the part that needs no
 * credentials, runs in seconds, and would have caught THIS one.
 *
 *   bun deployed-wasm-check.mjs https://dev.canari-emse.fr
 */

/** The sentence every `std` unsupported-platform panic ends with. */
const MARKER = 'not implemented on this platform';

/** How many levels of JS chunk to follow before giving up on finding the wasm reference. */
const MAX_DEPTH = 3;

const base = (process.argv[2] ?? 'https://dev.canari-emse.fr').replace(/\/+$/, '');

/** Fetches `url` as text, or `null` when it cannot be read - a chunk that 404s is not fatal. */
async function text(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Finds the wasm asset path by breadth-first walk over the chunk graph. The landing page names two
 * chunks; the wasm is referenced several hops in, so a single-level scan finds nothing - which is
 * how the first attempt at this check reported a false all-clear.
 */
async function findWasmPath() {
  const seen = new Set();
  let frontier = [`${base}/`];

  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const next = [];
    for (const url of frontier) {
      if (seen.has(url)) continue;
      seen.add(url);

      const body = await text(url);
      if (body === null) continue;

      const wasm = body.match(/[A-Za-z0-9/_.-]*mls_wasm_bg\.[A-Za-z0-9_-]+\.wasm/)?.[0];
      if (wasm) return new URL(wasm, url).pathname;

      // CHUNK REFERENCES ARE RELATIVE (`../chunks/B2MR6YP5.js`), not absolute. An absolute-only
      // pattern matches the two entry scripts in the HTML and NOTHING after them, so the walk ends
      // one hop in and reports "could not find" - which is what the first version of this did.
      for (const p of body.match(/(?:\.\.?\/|\/_app\/)[A-Za-z0-9/_.-]+\.js/g) ?? []) {
        const abs = new URL(p, url).href;
        if (abs.startsWith(base) && !seen.has(abs)) next.push(abs);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return null;
}

const path = await findWasmPath();
if (!path) {
  console.error(`[deployed-wasm] could not find the wasm reference under ${base} within ${MAX_DEPTH} hops.`);
  console.error('[deployed-wasm] NOT a pass: the check could not run, which is a different thing from clean.');
  process.exit(2);
}

const url = `${base}${path}`;
let bytes;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  bytes = Buffer.from(await res.arrayBuffer());
} catch (e) {
  console.error(`[deployed-wasm] cannot download ${url}: ${e.message}`);
  process.exit(2);
}

const body = bytes.toString('latin1');
const at = body.indexOf(MARKER);

if (at === -1) {
  console.log(`[deployed-wasm] ok - ${base} serves ${path} (${bytes.length} bytes), no unsupported-platform panic in it`);
  process.exit(0);
}

const context = body.slice(Math.max(0, at - 60), at + MARKER.length).replace(/[^\x20-\x7e]+/g, ' ').trim();
console.error(`[deployed-wasm] REFUSED: ${base} is serving a wasm that can panic.`);
console.error(`[deployed-wasm]   asset: ${path}`);
console.error(`[deployed-wasm]   found: ...${context}`);
console.error('[deployed-wasm] Every login on this estate will fail in MLS init, and the app will');
console.error('[deployed-wasm] report it as a wrong PIN. Do not promote this build.');
process.exit(1);
