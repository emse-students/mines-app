import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY TAURI NOTIFICATION MUST CARRY `largeBody`, AND A BUILD CANNOT SAY WHETHER IT DOES.
 *
 * `tauri-plugin-notification` 2.3.3 declares `inbox_lines: Vec<String>` with `#[serde(default)]`
 * and no `skip_serializing_if`, so its Rust side sends `"inboxLines": []` on every notification.
 * Its Android side reads that as `List<String>? = null` and branches on `!= null` - and an empty
 * array is not null - so every notification is given an `InboxStyle` with ZERO lines. `InboxStyle`
 * renders `textLines` and never `contentText`, so the body is in the notification record and on no
 * screen.
 *
 * Measured on a Mi 9T on 2026-09-06, on a real incoming message:
 *
 *     android.title     = "Canari Test Beta"
 *     android.text      = "K-mtq268w3ndf quick reply from the shade"   <- decrypted, present
 *     android.template  = "android.app.Notification$InboxStyle"
 *     android.textLines = CharSequence[] (0)                            <- empty
 *
 * The shade showed the sender's name and nothing under it. That is the user's report of a banner
 * that says who wrote but not what.
 *
 * IT ONLY SHOWS WHEN THE NOTIFICATION IS ALONE, which is why it survived so long: inside a group
 * the child row falls back to `contentText` and the body reappears. Four Canari notifications
 * stacked in one shade all rendered their bodies, including the very one that had shown none when
 * it was by itself thirty seconds earlier.
 *
 * WHY A SOURCE GUARD. The failure is invisible to every layer this repository can execute - the
 * plugin's TypeScript accepts the call, the Rust accepts it, the APK builds, and the defect appears
 * only in a system-drawn view on a device. There is nothing to render and assert. What CAN be
 * pinned is that no call site posts a notification without the field, which is the whole of the
 * fix, and that the helper carrying it does not quietly lose it. Same technique and reasoning as
 * `layout/sessionExpiredRelease.test.ts`.
 */
const source = readFileSync(
  join(process.cwd(), 'src/lib/composables/useNotifications.svelte.ts'),
  'utf8'
);

describe('every Tauri notification carries a body Android will actually draw', () => {
  /** Each `sendNotification({...})` call in the file, options object included. */
  const calls = [...source.matchAll(/sendNotification\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);

  it('posts through the plugin in more than one place - which is why the helper exists', () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('gives every one of them the largeBody the BigTextStyle branch is chosen by', () => {
    for (const options of calls) {
      // Either spread from the helper, or spelled out - what must never happen is `body` alone,
      // which is the shape that renders a title and nothing else.
      expect(options).toMatch(/androidReadableBody\(|largeBody/);
    }
  });

  it('keeps the helper honest: largeBody must carry the body, not a label or a truncation', () => {
    const helper = /function androidReadableBody\([\s\S]*?\n {2}\}/.exec(source)?.[0] ?? '';
    expect(helper).toBeTruthy();
    expect(helper).toMatch(/return \{ body, largeBody: body \};/);
  });

  it('never posts a bare `body,` shorthand, the exact shape that lost the message', () => {
    for (const options of calls) {
      // `body,` on its own line is the pre-fix call. `...androidReadableBody(body),` does not match.
      expect(options).not.toMatch(/(^|[\s{])body,\s*$/m);
    }
  });
});
