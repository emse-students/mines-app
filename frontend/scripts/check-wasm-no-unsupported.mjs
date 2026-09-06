#!/usr/bin/env bun
/**
 * Refuses a `mls_wasm_bg.wasm` that carries a panic from `std`'s unsupported-platform shims.
 *
 * WHY A STRING IN THE ARTEFACT AND NOT A LINT ON THE SOURCE. `mls-core` compiles for the host AND
 * for `wasm32-unknown-unknown`. A `std` API missing on wasm still COMPILES there - `cargo check
 * --target wasm32-unknown-unknown` is green - and fails at runtime, in the browser, on a code path
 * nothing in this repository exercises. That is exactly how v0.16.4 shipped a
 * `std::time::SystemTime::now()` inside `load_or_create`: every web login unwound, and the login
 * path reported the panic as `auth_pin_mismatch`, so every user was told their correct PIN was
 * wrong. See the CHANGELOG entry for v0.16.5.
 *
 * `std` reaches those shims through its per-platform `unsupported.rs`, whose panics all carry
 * the same sentence. Finding it in the binary means a call that cannot work on this target is
 * reachable from the exported surface - which is the whole question, and one a type system does not
 * answer. It costs one read of a 1.6 MB file.
 *
 * The check is deliberately about REACHABILITY rather than about any particular API: it catches the
 * next one too, whatever it is, without anybody having to predict it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The sentence every `std` unsupported-platform panic ends with. */
const MARKER = 'not implemented on this platform';

const target = resolve(process.argv[2] ?? 'src/lib/wasm/mls_wasm_bg.wasm');

let bytes;
try {
  bytes = readFileSync(target);
} catch (e) {
  console.error(`[wasm-gate] cannot read ${target}: ${e.message}`);
  console.error(
    '[wasm-gate] build it first (bun run wasm:build) - a missing artefact is not a pass.'
  );
  process.exit(1);
}

// The panic text is a plain literal in the data section; latin1 keeps every byte addressable.
const text = bytes.toString('latin1');
const at = text.indexOf(MARKER);

if (at === -1) {
  console.log(
    `[wasm-gate] ok - no unsupported-platform panic reachable in ${target} (${bytes.length} bytes)`
  );
  process.exit(0);
}

// Show what precedes the marker: `std` prefixes it with the API's own name ("time", "random", ...),
// which is the one thing that turns this refusal into a lead.
const from = Math.max(0, at - 60);
const context = text
  .slice(from, at + MARKER.length)
  .replace(/[^\x20-\x7e]+/g, ' ')
  .trim();

console.error(`[wasm-gate] REFUSED: ${target} can panic on this target.`);
console.error(`[wasm-gate]   found: ...${context}`);
console.error('[wasm-gate]');
console.error('[wasm-gate] A `std` API that does not exist on wasm32 still COMPILES for it and');
console.error('[wasm-gate] panics at runtime - in the browser, on a path no test here covers.');
console.error('[wasm-gate] Gate the call behind #[cfg(not(target_arch = "wasm32"))], or take the');
console.error('[wasm-gate] value it needs (a clock, an entropy source) as a PARAMETER from the');
console.error('[wasm-gate] caller, which has one on every target.');
process.exit(1);
