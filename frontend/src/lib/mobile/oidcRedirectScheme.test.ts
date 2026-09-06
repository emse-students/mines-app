import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE CUSTOM SCHEME THE LOGIN COMES BACK ON MUST BE ONE THE APP ACTUALLY REGISTERS.
 *
 * WHAT THIS COST. On 2026-09-06 a TestFlight tester on the pre-release build could not log in at
 * all: Authentik answered `400` on `/application/o/authorize/` and the app showed "Redirect URI
 * Error". The `Canari Dev` OIDC provider had been configured with `fr.emse.canari.dev://callback` -
 * a scheme NOTHING in this repository declares. `tauri.conf.json` has identifier `fr.emse.canari`
 * and the deep-link plugin registers that one scheme, so the provider was waiting for a callback no
 * build could ever send. Somebody wrote a `.dev` scheme into the IdP expecting the app to follow it,
 * and nothing anywhere disagreed.
 *
 * WHAT IT ASSERTS. `oidcRedirectUri()` in `$lib/stores/auth.ts` hard-codes the mobile return URI.
 * Every `scheme://host` literal in that function must appear in `plugins.deep-link.mobile` of
 * `tauri.conf.json`, with that exact host. A scheme the OS never routes is a login that dead-ends
 * on the device, and the runtime symptom names the IdP rather than the app - which is why it reads
 * as a server fault and gets diagnosed on the wrong box.
 *
 * IT IS READ FROM THE SOURCE, deliberately: the branch is behind `isMobileTauriRuntime()`, so
 * calling the function under vitest takes the web path and proves nothing about the mobile one.
 *
 * ## THE HALF THIS TEST DOES NOT COVER, AND CANNOT
 *
 * **It cannot see Authentik's database.** The provider's authorized redirect URIs live in
 * Authentik's Postgres on the `miconnect` box, outside this repository and outside every gate in
 * it. This test proves the app asks for a scheme it registers; it says NOTHING about whether the
 * IdP will accept that scheme. That half is protected only by
 * `docs/wiki/infrastructure/authentik.md` - "The three Canari providers" and the hand-mutation
 * section under it - and a restore from an older backup silently undoes it. If this test is green
 * and a tester still sees "Redirect URI Error", the provider is what to read.
 */
const here = dirname(fileURLToPath(import.meta.url));
const AUTH_STORE = resolve(here, '../stores/auth.ts');
const TAURI_CONF = resolve(here, '../../../src-tauri/tauri.conf.json');

/** `{ scheme, host }` pairs the deep-link plugin registers for mobile, custom schemes only. */
function declaredMobileLinks(): { scheme: string; host: string }[] {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as {
    plugins?: { 'deep-link'?: { mobile?: { scheme?: string[]; host?: string }[] } };
  };
  const mobile = conf.plugins?.['deep-link']?.mobile ?? [];
  const out: { scheme: string; host: string }[] = [];
  for (const entry of mobile) {
    if (!entry.host) continue;
    for (const scheme of entry.scheme ?? []) {
      // `https` entries are App Links / Universal Links, matched on a real domain - not a scheme a
      // redirect URI can name here.
      if (scheme === 'https' || scheme === 'http') continue;
      out.push({ scheme, host: entry.host });
    }
  }
  return out;
}

/**
 * The `scheme://host` literals `oidcRedirectUri()` can return.
 *
 * Anchored on the function body rather than the whole file: `auth.ts` mentions the deep link in
 * prose elsewhere, and a comment is not a return value.
 */
function redirectLiteralsInOidcRedirectUri(): string[] {
  const src = readFileSync(AUTH_STORE, 'utf8');
  const start = src.indexOf('function oidcRedirectUri()');
  expect(
    start,
    'oidcRedirectUri() was renamed or removed - this test anchors on it'
  ).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end, 'could not find the end of oidcRedirectUri()').toBeGreaterThan(start);
  const body = src.slice(start, end);

  const found = new Set<string>();
  // A custom scheme, never `http(s)`: those are the web branch, built from window.location.
  for (const m of body.matchAll(/'([a-z][a-z0-9.+-]*):\/\/([a-z0-9-]+)'/gi)) {
    if (m[1] === 'http' || m[1] === 'https') continue;
    found.add(`${m[1]}://${m[2]}`);
  }
  return [...found];
}

describe('the OIDC redirect scheme is one the app registers', () => {
  it('finds at least one custom-scheme literal in oidcRedirectUri()', () => {
    // A zero here would make every assertion below vacuously true, which is how this test would
    // stop catching anything the day the literal moves into a constant.
    expect(redirectLiteralsInOidcRedirectUri().length).toBeGreaterThan(0);
  });

  it('declares every scheme:host it returns in tauri.conf.json deep-link mobile', () => {
    const declared = declaredMobileLinks();
    const declaredKeys = new Set(declared.map((d) => `${d.scheme}://${d.host}`));
    for (const literal of redirectLiteralsInOidcRedirectUri()) {
      expect(
        declaredKeys.has(literal),
        `oidcRedirectUri() returns ${literal}, which tauri.conf.json does not register. ` +
          `Declared: ${[...declaredKeys].join(', ')}. The OS will never route this back to the ` +
          `app, and the IdP reports it as "Redirect URI Error" - see ` +
          `docs/wiki/infrastructure/authentik.md.`
      ).toBe(true);
    }
  });

  it('returns a callback host, not some other deep link', () => {
    for (const literal of redirectLiteralsInOidcRedirectUri()) {
      expect(literal.endsWith('://callback'), `${literal} is not a callback deep link`).toBe(true);
    }
  });

  it('uses the app identifier as its scheme, so dev and prod builds share it', () => {
    // The dev and prod builds differ by client_id and API URL, NEVER by identifier: a separate
    // `.dev` scheme would need its own bundle id, provisioning profile and store record. This
    // pins that decision, which is the one the 2026-09-06 outage was made of.
    const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { identifier?: string };
    for (const literal of redirectLiteralsInOidcRedirectUri()) {
      expect(literal.split('://')[0]).toBe(conf.identifier);
    }
  });
});
