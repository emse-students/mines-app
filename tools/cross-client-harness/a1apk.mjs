/**
 * BUILD THE A1 APK AGAINST THE LOCAL ESTATE, INSTALL IT, AND PROVE THE PHONE IS RUNNING IT.
 *
 *   bun a1apk.mjs               # reverse + build + install + prove
 *   bun a1apk.mjs --no-build    # reverse + install the APK already on disk + prove
 *   bun a1apk.mjs --reverse     # only the reverse, which is what a replug costs
 *
 * WHY THIS IS AN ATOM AND NOT A PARAGRAPH IN THE README. The invocation was documented and nothing
 * executed it, so every session retyped it - and the copy went stale in the one place a copy always
 * does: the README names NDK `26.1.10909125`, and this workstation has `29.0.13846066` and nothing
 * else. A path spelt in prose is a path nobody re-measures. Everything below is DISCOVERED and then
 * ASSERTED, which is the rule the rest of this rig already follows.
 *
 * ## The four facts this gesture rests on, each verified here rather than assumed
 *
 * 1. **The phone reaches the estate over `adb reverse`, per device, and it does not survive a
 *    replug.** `SITE` is `http://localhost:<port>` for the workstation; `adb reverse tcp:<port>
 *    tcp:<port>` makes the SAME string true on the phone, which is why nothing here rewrites a URL.
 * 2. **A debug build is what makes that legal.** `build.gradle.kts` sets
 *    `usesCleartextTraffic=true` for the debug type only, and `network_security_config.xml` permits
 *    cleartext to `localhost` - so a release APK cannot talk to the local estate at all.
 * 3. **`BUILD_WEB` must be UNSET.** The APK embeds its frontend (`frontendDist: "../build"`) and
 *    Tauri needs the adapter-STATIC shape. Inheriting `BUILD_WEB=1` from a shell that had just
 *    deployed the local estate would package an adapter-node build - a `build/` with no
 *    `index.html` at its root - so it is deleted from the child environment explicitly.
 * 4. **The seven origins travel as environment variables, not as an edit to `frontend/.env`.** That
 *    file is generated and shared with `bun run dev`, which must stay same-origin; writing the
 *    absolute URLs into it would break the dev server for the rest of the session. Vite reads
 *    `VITE_*` from the process environment, and this asserts that it did by grepping the artefact.
 *
 * ## What it refuses to do
 *
 * **It never uninstalls.** `adb install -r` keeps the app data, which is the enrolment and the MLS
 * store; an uninstall costs a new DEVICE with no history, and a HEAL row reasons about exactly that
 * history. If the signature ever mismatches, the fix is to build debug - not to uninstall.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SITE, STATE_DIR } from './names.mjs';
import { PKG, adb, serial, useDevice } from './phone.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const FRONTEND = join(REPO, 'frontend');

/** `http://localhost:8081` -> `8081`. The port is what `adb reverse` maps; the URL is unchanged. */
function sitePort() {
  const port = new URL(SITE).port;
  if (!port) {
    throw new Error(
      `SITE has no explicit port (${SITE}) - the phone reaches the estate by reverse-forwarding one, ` +
        `so a default-port SITE cannot be served this way`
    );
  }
  return port;
}

/**
 * The Android SDK, and the NDK inside it, DISCOVERED.
 *
 * The NDK is picked as the highest version present rather than named: a hardcoded version is the
 * thing that rotted in the README, and there is nothing about this build that wants an older one.
 * Both are asserted, because `tauri android build` fails deep inside gradle with an error that does
 * not say "no NDK" when they are missing.
 */
function toolchain() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.env.HOME ? join(process.env.HOME, 'Android', 'Sdk') : null,
  ].filter(Boolean);
  const sdk = candidates.find((p) => existsSync(join(p, 'platform-tools')));
  if (!sdk) {
    throw new Error(
      `no Android SDK found - looked for platform-tools under:\n  ${candidates.join('\n  ')}`
    );
  }
  const ndkRoot = join(sdk, 'ndk');
  if (!existsSync(ndkRoot)) throw new Error(`SDK at ${sdk} has no ndk/ directory`);
  const versions = readdirSync(ndkRoot)
    .filter((d) => statSync(join(ndkRoot, d)).isDirectory())
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) < 0 ? 1 : -1
    );
  if (!versions.length) throw new Error(`no NDK installed under ${ndkRoot}`);
  return { sdk, ndk: join(ndkRoot, versions[0]), ndkVersion: versions[0] };
}

/** The two Authentik values, read from the generated `frontend/.env` - local authenticates against
 *  the PRODUCTION identity provider (workflow-migration decision 8), so they are not derived. */
function authentikEnv() {
  const file = join(FRONTEND, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(VITE_AUTHENTIK_URL|VITE_AUTHENTIK_CLIENT_ID)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * The gesture, as a function, so importing this file does NOT build an APK.
 *
 * IT DID, and that is why the guard is here: the first `await import('./a1apk.mjs')` written to
 * check that the file parses started a forty-minute Android build. An atom other checks are meant
 * to reuse cannot have its work at module scope - the rule the four other dual-purpose files in
 * this directory already follow with the same `pathToFileURL` guard.
 */
export async function armA1({ build = true, reverseOnly = false, device = 'A1' } = {}) {
  // BINDS THE NAMED PHONE ITSELF, defaulting to the one this atom is named for.
  //
  // With two phones attached, `serial()` refuses rather than choosing - correctly, and it says so:
  // "pass --device to an atom so it can call useDevice()". This file was that atom and did not,
  // so `bun a1apk.mjs` on a two-phone bench aborted before the reverse, on an ambiguity the file
  // itself could resolve. Making the CALLER export ANDROID_SERIAL is how the wrong phone gets an
  // A1 build: the shell is where the two names are easiest to confuse.
  //
  // `useDevice` sets `ANDROID_SERIAL` in this process, so it also reaches the `adb` and `tauri`
  // children spawned below - the binding is the whole subtree's, not this module's.
  //
  // `--device` exists because the APK is not A1's: it is the LOCAL-ESTATE build, and any phone on
  // the bench may need it. The file keeps its name because eight places reference it and a rename
  // buys nothing; `[A1]` in the log below is the DEVICE, so a line always says which phone it is
  // about. Arming a second phone is `bun a1apk.mjs --no-build --device A2` - the build is shared,
  // and rebuilding it per phone would only risk two of them differing.
  useDevice(device);
  const TAG = device;

  // ── the reverse, which is the whole of what a replug costs ──────────────────────────────────────
  function reverse(port) {
    const dev = serial();
    adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
    // ASSERTED, because `adb reverse` answers 0 for a forward that is not there afterwards when the
    // device has gone between the two calls - and a check that believes it then measures a phone
    // talking to nothing, which reads exactly like a server fault.
    const listed = adb(['reverse', '--list']);
    const ok = listed.includes(`tcp:${port}`);
    console.log(`[${TAG}] reverse tcp:${port} on ${dev}: ${ok ? 'up' : 'NOT LISTED'}`);
    if (!ok) throw new Error(`adb reverse --list does not show tcp:${port}:\n${listed}`);
    return dev;
  }

  const PORT = sitePort();

  // A RETURN, NOT AN EXIT. `process.exit` in a library kills the caller's run too, and this atom
  // exists to be called by the phases that arm the phone.
  if (reverseOnly) return { reversed: true, dev: reverse(PORT) };

  const dev = reverse(PORT);
  const { sdk, ndk, ndkVersion } = toolchain();
  console.log(`[${TAG}] SDK ${sdk}`);
  console.log(`[${TAG}] NDK ${ndkVersion} (discovered, not named)`);
  console.log(`[${TAG}] target origin ${SITE} - the same string on both sides of the reverse`);

  const APK = join(
    FRONTEND,
    'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'
  );

  // Relative to FRONTEND, which is this build's cwd - `--config` resolves against the cwd.
  const LOCAL_CONF = 'src-tauri/tauri.local.conf.json';

  if (build) {
    if (!existsSync(join(FRONTEND, LOCAL_CONF))) {
      throw new Error(
        `${LOCAL_CONF} is absent - without it the APK compiles capability \`default\` alone and every ` +
          `call to the local estate is refused by scope. It is not optional.`
      );
    }

    const tauri = join(FRONTEND, 'node_modules/.bin/tauri.exe');
    if (!existsSync(tauri)) {
      throw new Error(
        `${tauri} is missing - and \`npx tauri\` / \`bun tauri\` do not resolve on this box, so the ` +
          `binary is the only way in. Run \`bun install\` in frontend/.`
      );
    }

    const env = { ...process.env };
    // (3) above: the APK wants adapter-static, and this shell may have just built the web shape.
    delete env.BUILD_WEB;
    env.ANDROID_HOME = sdk;
    env.ANDROID_SDK_ROOT = sdk;
    env.NDK_HOME = ndk;
    for (const k of [
      'VITE_FRONTEND_URL',
      'VITE_GATEWAY_URL',
      'VITE_DELIVERY_URL',
      'VITE_MEDIA_URL',
      'VITE_CALL_URL',
      'VITE_SOCIAL_URL',
      'VITE_CORE_URL',
    ]) {
      env[k] = SITE;
    }
    Object.assign(env, authentikEnv());

    const logDir = join(STATE_DIR, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `a1apk-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    console.log(`[${TAG}] building (debug) - output to ${logFile}`);
    console.log(`[${TAG}]   NOT piped: this build buffers until exit, so a pipe loses all progress.`);

    // `stdio: inherit` for the same reason the README gives: piping it hides every line until the
    // process ends, and a stalled build then looks identical to a slow one.
    // (5) THE LOCAL ESTATE IS OPT-IN, AND THIS FLAG IS THE ONLY THING THAT OPTS IN.
    // `tauri.conf.json` names capability `default` alone, whose fetch scope is `https://**` - so a
    // build without this overlay produces an APK that REFUSES the estate it was pointed at, with the
    // product's own red "url not allowed on the configured scope". The overlay adds `local-estate`,
    // and nothing else does, which is what keeps a release build from ever compiling it.
    const built = spawnSync(tauri, ['android', 'build', '--debug', '--config', LOCAL_CONF], {
      cwd: FRONTEND,
      env,
      stdio: 'inherit',
      timeout: 45 * 60_000,
    });
    if (built.status !== 0) {
      throw new Error(`tauri android build --debug --config ${LOCAL_CONF} exited ${built.status}`);
    }

    if (!existsSync(APK)) {
      throw new Error(
        `build reported success but ${APK} is absent - note it is universal/, never arm64/, which is stale`
      );
    }

    // (4) above, MEASURED: did Vite actually take the origins from the environment? The packaged
    // bundle is the only place that can answer, and an APK pointing at production would otherwise be
    // found by a row that fails for a reason nobody can see.
    const chunks = join(FRONTEND, 'build/_app/immutable/chunks');
    const hits = existsSync(chunks)
      ? readdirSync(chunks).filter((f) => f.endsWith('.js') && readFileSync(join(chunks, f), 'utf8').includes(SITE))
      : [];
    console.log(`[${TAG}] ${SITE} appears in ${hits.length} packaged chunk(s)`);
    if (!hits.length) {
      throw new Error(
        `the built bundle does not mention ${SITE} - Vite did not take the VITE_*_URL from the ` +
          `environment, so this APK would talk to whatever frontend/.env says (production)`
      );
    }
  }

  // ── install, and NEVER uninstall ────────────────────────────────────────────────────────────────
  console.log(`[${TAG}] installing ${APK}`);
  const before = adb(['shell', 'dumpsys', 'package', PKG]);
  const verOf = (dump) => /versionName=(\S+)/.exec(dump)?.[1] ?? '(none)';
  const codeOf = (dump) => /versionCode=(\d+)/.exec(dump)?.[1] ?? '(none)';
  console.log(`[${TAG}] installed before: ${verOf(before)} (code ${codeOf(before)})`);

  const install = spawnSync('adb', ['-s', dev, 'install', '-r', APK], {
    encoding: 'utf8',
    timeout: 10 * 60_000,
  });
  const said = `${install.stdout ?? ''}${install.stderr ?? ''}`.trim();
  console.log(`[${TAG}] ${said.split('\n').slice(-3).join(' | ')}`);
  if (install.status !== 0 || /Failure|INSTALL_FAILED/i.test(said)) {
    throw new Error(
      `install -r failed. A signature mismatch means the APK is a RELEASE build; build debug rather ` +
        `than uninstalling - an uninstall destroys the enrolment and the MLS store this device is for.`
    );
  }

  const after = adb(['shell', 'dumpsys', 'package', PKG]);
  console.log(`[${TAG}] installed after : ${verOf(after)} (code ${codeOf(after)})`);

  // The reverse survives an install but not a replug, so it is re-asserted here rather than assumed:
  // this is the last moment at which a caller can be told the phone cannot reach the estate.
  reverse(PORT);
  console.log(`[${TAG}] done - the app still has to be launched and unlocked (pin.mjs --device ${TAG})`);
  if (build) {
    // THE ESTATE'S SOURCE ARTEFACT IS NOW THE WRONG SHAPE, and nothing downstream would say so.
    // `beforeBuildCommand` is `bun run build`, which writes the SAME `frontend/build` the local
    // estate is packaged from - so a `docker compose up --build frontend-ssr` after this ships a
    // container that dies on `Cannot find module '/app/index.js'`. The README already forbids two
    // builds racing over that directory; this is the other half, which is that the loser is left
    // behind on disk looking perfectly fine.
    console.log(
      `[${TAG}] NOTE: frontend/build now holds the TAURI (adapter-static) shape. Run \`make ` +
        `local-frontend\` before rebuilding the estate's frontend images.`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--device');
  const device = at >= 0 ? argv[at + 1] : 'A1';
  if (at >= 0 && !device) throw new Error('--device needs a name, as names.mjs spells it (A1, A2)');
  armA1({
    build: !argv.includes('--no-build'),
    reverseOnly: argv.includes('--reverse'),
    device,
  }).catch(
    (e) => {
      console.error(`[${device}] ${String(e.message || e)}`);
      process.exit(1);
    }
  );
}

export { toolchain, sitePort };
