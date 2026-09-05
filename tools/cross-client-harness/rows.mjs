#!/usr/bin/env node
/**
 * THE BOARD AND THE EVIDENCE, RECONCILED - which rows nothing has ever answered, and which answers
 * no row asked for.
 *
 *   bun rows.mjs             the gaps, and a per-phase count
 *   bun rows.mjs --build X   also flag rows whose newest verdict was not taken on build X
 *   bun rows.mjs --strict    exit non-zero if anything is owed
 *
 * WHY THIS EXISTS. `cross-client-testing.md` is the board and its row ids are the campaign's only
 * vocabulary: a verdict is a row id plus a verdict word. Nothing checked that the two vocabularies
 * were the same one, and they were not, twice over:
 *
 *   - **DEL-1 had a runner nobody could reach.** `del1.mjs` existed, worked, recorded a real board
 *     id, and was registered in no phase - so `run.mjs` could not run it and the row read `pending`
 *     for days while the code sat there.
 *   - **`grp-traffic.mjs` is registered in GRP and answers no row.** It records `GRP-TRAFFIC`, an id
 *     the board never names, while all nine GRP rows say `pending`. From `run.mjs` the phase looks
 *     covered; from the board it is empty. The same fault as DEL-1, from the other end.
 *
 * Both are invisible by construction: one side is a markdown table, the other a directory of scripts
 * and a ledger of verdicts, and nothing read both. So "everything must end green" becomes a COUNT
 * rather than a memory.
 *
 * **IT READS `results.ndjson`, NOT THE RUNNERS' SOURCE, and that is the whole design.** The first
 * draft parsed literal ids out of `record(...)` calls and was useless: sixteen runners build their
 * id from an expression - `MUT-${n}/${kind}`, `READ-${n}` - so it reported 149 rows with no runner
 * on the same afternoon MSG, TYPE and READ had all just run green. A static read cannot answer "what
 * has been measured"; the ledger of verdicts is the only thing that can, and it is evidence rather
 * than inference.
 *
 * **AN ARM IS NOT AN ORPHAN.** `mut.mjs` records `MUT-11/dm` and `MUT-11/channel` for one board row,
 * and `comm910.mjs` records `COMM-9/10` for two. A recorded id is matched to the board by its own
 * name first, then by the part before a `/`, then - for a joint id - by each `/`-separated tail
 * pasted back onto the prefix. Anything still unmatched is a real divergence and is named as one.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES } from './checks.mjs';
import { instrumentShaOf } from './instrument.mjs';
import { findScript } from './scriptpath.mjs';
import { STATE_DIR } from './names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = resolve(HERE, '..', '..', 'docs', 'wiki', 'cross-client-testing.md');
const LEDGER = join(STATE_DIR, 'results.ndjson');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const sinceBuild = argv.includes('--build') ? argv[argv.indexOf('--build') + 1] : null;

/**
 * Every row id the board names, in board order, WITH THE WORD THE BOARD ITSELF CLAIMS FOR IT.
 *
 * THE STATE COLUMN IS A THIRD VOCABULARY, and ignoring it made this tool lie in the useful
 * direction. SETUP is nine rows the board calls `passed` (six of them, dated), `skipped` (one,
 * deliberately) and `pending` (two, owed before CORRUPT) - and the first draft printed "9 NEVER RUN",
 * because none of them was ever recorded through `record`: they predate the ledger, and three of them
 * are session steps a preflight performs rather than checks a runner can run. A count that calls a
 * dated hand-verified row "never run" buries the two that really are owed among seven that are not.
 *
 * So the three sources are kept apart and named apart. The ledger says what a RUNNER measured; the
 * board says what a HUMAN claims; a row with neither is the campaign's actual remaining work. The
 * interesting cell is the disagreement, and it now has a name - see `claimedOnly` and `contradicted`.
 */
/**
 * The board's word -> the ledger's word. `pending` is not a verdict and does not become one: it is
 * the ABSENCE of a claim, which is why it maps to itself and is never compared against a verdict.
 */
const CLAIM = {
  passed: 'PASS',
  PASS: 'PASS',
  'PASS-DIRTY': 'PASS-DIRTY',
  failed: 'FAIL',
  FAIL: 'FAIL',
  skipped: 'SKIPPED',
  SKIPPED: 'SKIPPED',
  partial: 'PARTIAL',
  PARTIAL: 'PARTIAL',
  VACUOUS: 'VACUOUS',
  // A VERDICT THE RECORDER WRITES AND THIS READER COULD NOT READ. `results.mjs` names
  // `INCONCLUSIVE` in the same breath as `PASS-DIRTY`, `VACUOUS` and `INVALID` - it is what a row
  // records when its question could not be ASKED, which is a third answer and never spelt "fine".
  // It was missing here, so PIN-11 - the first row to record one - read as `unstated` and was
  // reported as work the board had not written down, which it had. A word the ledger can produce
  // and the reconciler cannot recognise makes the reconciler wrong about the board, which is the
  // one thing it exists to be right about.
  INCONCLUSIVE: 'INCONCLUSIVE',
  INVALID: 'INVALID',
  ERROR: 'ERROR',
  UNOBSERVED: 'UNOBSERVED',
  pending: 'pending',
};

const rows = [];
const boardState = new Map();
/** Board rows carrying more cells than the table has columns - see the note at the split below. */
const strayPipes = [];
for (const line of readFileSync(BOARD, 'utf8').split('\n')) {
  const m = /^\|\s*([A-Z][A-Z0-9]*-[0-9A-Za-z-]+)\s*\|(.*)$/.exec(line);
  if (!m) continue;
  rows.push(m[1]);
  // The LAST cell of the row is the state. A table row ends with a pipe, so the raw split has a
  // trailing empty piece and `.at(-1)` on it would be that empty string rather than the cell.
  const cells = m[2]
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const cell = cells.length ? cells[cells.length - 1] : '';
  // THE BOARD SPEAKS TWO VOCABULARIES AND BOTH ARE CURRENT. Rows written before the ledger existed
  // say `passed` / `pending` / `skipped`; every row a runner has answered since says `PASS` /
  // `SKIPPED` / `FAIL` - the same words `results.mjs` records, deliberately, so a row and its
  // verdict read alike. Knowing only the older set reported sixty-seven disagreements on the day
  // MSG, TYPE, READ, MUT and FWD were all green, which is the shape of an instrument fault: a
  // finding that large about a state just measured is about the instrument.
  // AND THE BOARD BOLDS SOME OF THEM. A cell may open `**`PASS`**` rather than `` `PASS` ``, which an
  // anchor on the backtick alone cannot see: on 2026-08-25 that read seventeen answered rows - all of
  // GRP and most of DEL - as `unstated`, and reported them as work the ledger had answered and the
  // board had not. Same instrument-fault shape as the two vocabularies above, and found the same way:
  // a gap that large about phases already known green is a gap in the reader.
  // AND SOME CARRY THEIR COUNT INSIDE THE BACKTICKS - `` `PASS 1/1` `` - so the word is not the whole
  // of the code span either. Both are read the same way: the FIRST word of the first code span,
  // whatever follows it in there.
  const w = /^\*{0,2}`([A-Za-z-]+)[^`]*`/.exec(cell);
  boardState.set(m[1], w ? CLAIM[w[1]] || 'unstated' : 'unstated');
  // A `|` INSIDE A CELL SPLITS THE ROW, AND NOTHING ELSE HERE CAN SAY SO. Markdown has no way to
  // carry a bare pipe in a table, so one written into a verdict - quoting a notification shade, say -
  // silently adds a column: the table renders wrong for a person, and the reader above takes the
  // fragment after the last pipe as the state. LIFE-2 read `unstated` against a ledger holding
  // `PASS` for exactly that reason on 2026-09-05, and the message it produced named the wrong
  // problem - "the board has not recorded it" about a cell that recorded it in full.
  //
  // THREE CELLS FOLLOW THE ID EVERYWHERE ON THIS BOARD - what, needs, state - and that is measured
  // rather than assumed: all 246 rows split to exactly three. A row with more has a stray pipe, and
  // that is a different fault from an unstated verdict, so it gets its own line.
  if (cells.length > 3) strayPipes.push(`${m[1]} (${cells.length} cells, expected 3)`);
}
const known = new Set(rows);

/**
 * The board rows a recorded id answers - normally one, two for a joint id like `COMM-9/10`.
 *
 * An empty array is the divergence worth reading: either the board is missing the row, or the runner
 * is answering under a name nobody asked about.
 */
function boardRowsFor(id) {
  if (known.has(id)) return [id];
  const slash = id.indexOf('/');
  if (slash === -1) return [];
  const base = id.slice(0, slash);

  // A JOINT ID: `COMM-9/10` is one script answering two rows. The prefix is everything up to the
  // last `-`, and every `/`-separated tail is pasted back onto it. All of them must land, or this is
  // not the shape.
  //
  // TRIED BEFORE THE SUFFIX READING, WHICH IS THE WHOLE FIX. Both shapes are `X/Y` with `X` a board
  // row - `MUT-1/dm` is MUT-1 run in the venue, `COMM-9/10` is two rows - so an early
  // `if (known.has(base)) return [base]` matched the joint form first and credited COMM-9 alone.
  // COMM-10 then sat on the board as `PASS` that "the ledger cannot corroborate" FOR EVER: the
  // report's most valuable line, printed about a row that had in fact been measured, in a file whose
  // own docstring names `COMM-9/10` as the case it handles. The discriminator is data, not order -
  // `prefix + tail` is a board row for the joint form (`COMM-10`) and is not for the suffixed one
  // (`MUT-dm`) - so asking that question first costs nothing and cannot mistake one for the other.
  const dash = base.lastIndexOf('-');
  if (dash !== -1) {
    const prefix = base.slice(0, dash + 1);
    const parts = [base.slice(dash + 1), ...id.slice(slash + 1).split('/')];
    const hits = parts.map((t) => prefix + t).filter((r) => known.has(r));
    if (hits.length === parts.length && hits.length > 1) return hits;
  }

  // A VENUE SUFFIX: `MUT-1/dm` is MUT-1, measured in a DM. The tail names where, not what.
  if (known.has(base)) return [base];
  return [];
}

/**
 * Ids that are DIAGNOSTICS, not checks - a one-off probe written to answer one question during an
 * investigation, recorded through `record` because that is where the evidence belongs.
 *
 * They are named here rather than filtered by shape, because "an id the board does not name" is the
 * report's most valuable line - it is how DEL-1 and `HEAL-WEB` were found - and a heuristic that
 * swallowed a real runner would take that value away. Six ids, listed, so the day a seventh appears
 * it appears in the report and someone decides what it is.
 */
const DIAGNOSTIC = new Set(['PROBE', 'LOSSHUNT', 'A1-NAMES', 'CHECK-M', 'FREEZE-repro', 'PREFIX-1']);

if (!existsSync(LEDGER)) {
  console.log('[rows] no ledger at ' + LEDGER + ' - nothing has been recorded on this machine');
  process.exit(strict ? 1 : 0);
}

// THE NEWEST VERDICT PER ROW. Newest rather than best: a row that passed yesterday and failed today
// is failing, and a tool reporting the pass would be the reason nobody looked.
const latest = new Map();
// THE NEWEST VERDICT PER ORDER, for the rows that HAVE orders. A row whose claim is a COMPARISON -
// HEAL-REVOKE-7 is "does the ORDER of the return change where the device ends up" - cannot be
// answered by one run, and its two runs land in the ledger as two records under one id. Taking the
// newest of them names whichever half ran last, so a pair whose halves DISAGREE reads as whatever
// was measured most recently: the board said `FAIL` and the ledger said `PASS-DIRTY` about the same
// row, on 2026-09-05, and both were right about their own half. Rows with a single order are
// untouched by this - the map has one entry and the worst of one is itself.
const perOrder = new Map();
const divergent = new Map();
const diagnostics = new Map();

/** Worst first: a pair is only as good as its weakest half, and that is what the row claims. */
const VERDICT_RANK = ['INVALID', 'FAIL', 'PARTIAL', 'VACUOUS', 'SKIPPED', 'PASS-DIRTY', 'PASS'];
const worseOf = (a, b) => {
  const ia = VERDICT_RANK.indexOf(a);
  const ib = VERDICT_RANK.indexOf(b);
  // An unknown verdict sorts worst, deliberately: a name this tool does not know is not a pass.
  return (ia < 0 ? -1 : ia) <= (ib < 0 ? -1 : ib) ? a : b;
};
for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    // A TRUNCATED LAST LINE IS THE ONE THING THIS FILE DOES BADLY - every runner appends to it - so
    // a bad line is skipped and SAID, never silently.
    console.log('[rows] skipped an unparseable ledger line: ' + line.slice(0, 80));
    continue;
  }
  if (!r || !r.id) continue;
  const hits = boardRowsFor(r.id);
  if (hits.length === 0) {
    if (DIAGNOSTIC.has(r.id)) {
      diagnostics.set(r.id, (diagnostics.get(r.id) || 0) + 1);
      continue;
    }
    const e = divergent.get(r.id) || { check: r.check || '?', count: 0 };
    e.count++;
    divergent.set(r.id, e);
    continue;
  }
  for (const row of hits) {
    const prev = latest.get(row);
    if (!prev || String(r.at) > String(prev.at)) {
      latest.set(row, {
        verdict: r.verdict,
        build: r.build,
        at: r.at,
        recordedAs: r.id,
        check: r.check,
        checkSha: r.checkSha,
        // KEPT EXPLICITLY, like every field above, and forgetting it made the new column read as
        // absent on rows that carried it - the report said "predates instrumentSha" about verdicts
        // recorded minutes earlier. A projection that names its fields is right; one that names all
        // but the newest is a silent zero.
        instrumentSha: r.instrumentSha,
      });
    }
    if (r.order) {
      if (!perOrder.has(row)) perOrder.set(row, new Map());
      const byOrder = perOrder.get(row);
      const seen = byOrder.get(r.order);
      if (!seen || String(r.at) > String(seen.at)) {
        byOrder.set(r.order, { verdict: r.verdict, at: r.at, build: r.build });
      }
    }
  }
}

// THE PAIRS, ADJUDICATED. Only rows that actually ran under more than one order: everything else has
// one half and is already its own answer.
const pairs = [];
for (const [row, byOrder] of perOrder) {
  if (byOrder.size < 2) continue;
  const halves = [...byOrder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const verdict = halves.map(([, h]) => h.verdict).reduce(worseOf);
  const held = latest.get(row);
  pairs.push({ row, halves, verdict, was: held?.verdict });
  if (held) held.verdict = verdict;
}

if (pairs.length) {
  console.log(
    '\n[rows] ' +
      pairs.length +
      ' row(s) are a COMPARISON and are adjudicated on ALL their halves, not the newest:'
  );
  for (const p of pairs) {
    console.log(
      '  ' +
        p.row.padEnd(14) +
        p.halves.map(([o, h]) => o + ': ' + h.verdict).join('  ') +
        '  -> ' +
        p.verdict +
        (p.was && p.was !== p.verdict ? '  (newest alone said ' + p.was + ')' : '')
    );
  }
}

const never = rows.filter((r) => !latest.has(r));
console.log('[rows] the board names ' + rows.length + ' rows; ' + latest.size + ' have a verdict in the ledger');

// PRINTED FIRST, BECAUSE IT EXPLAINS EVERY OTHER LINE ABOUT THE ROWS IT NAMES. A row split by a
// stray pipe reads `unstated` however completely it was written, so a reader who sees only the
// "board has not recorded it" section below goes looking for a missing verdict that is already
// in the cell, in full. LIFE-2 did exactly that on 2026-09-05.
if (strayPipes.length) {
  console.log(
    '\n[rows] ' +
      strayPipes.length +
      ' board row(s) carry a `|` INSIDE a cell, so the table has extra columns and the state ' +
      'read below is a fragment - fix the CELL, not the verdict:'
  );
  console.log('  ' + strayPipes.join('\n  '));
}

console.log('\n[rows] per phase - answered / named, then the newest verdicts held');
for (const phase of new Set(rows.map((r) => r.split('-')[0]))) {
  const mine = rows.filter((r) => r.split('-')[0] === phase);
  const done = mine.filter((r) => latest.has(r));
  const tally = {};
  for (const r of done) tally[latest.get(r).verdict] = (tally[latest.get(r).verdict] || 0) + 1;
  // A ROW THE BOARD CLAIMS IS NOT A HOLE, and printing it as one is what buried SETUP's two real
  // ones among seven that were settled by hand and dated. `claimed` is counted and named separately.
  const holes = mine.filter((r) => !latest.has(r) && !['PASS', 'SKIPPED'].includes(boardState.get(r)));
  const claimed = mine.length - done.length - holes.length;
  const gap = holes.length;
  const words = Object.entries(tally)
    .map(([v, n]) => n + ' ' + v)
    .join(', ');
  console.log(
    '  ' +
      phase.padEnd(9) +
      String(done.length).padStart(3) +
      ' / ' +
      String(mine.length).padEnd(4) +
      words +
      (gap ? (words ? ' | ' : '') + gap + ' NEVER RUN' : '') +
      (claimed ? ' | ' + claimed + ' by hand' : '')
  );
}

// NO VERDICT, SPLIT BY WHAT THE BOARD CLAIMS - because "never measured" and "never measured but
// asserted by hand, with a date" are owed different things. The first is work; the second is a
// belief, and a belief the ledger cannot corroborate is exactly what `checkSha` was added to stop
// being invisible. Merging them into one count is what made SETUP read as nine open items.
const claimedOnly = never.filter((r) => ['PASS', 'SKIPPED'].includes(boardState.get(r)));
const reallyNever = never.filter((r) => !claimedOnly.includes(r));
if (reallyNever.length) {
  console.log(
    '\n[rows] ' + reallyNever.length + " row(s) with no verdict and no claim - the campaign's remaining work:"
  );
  console.log('  ' + reallyNever.join(' '));
}
if (claimedOnly.length) {
  console.log(
    '\n[rows] ' + claimedOnly.length + ' row(s) the BOARD claims and the ledger cannot corroborate:'
  );
  for (const r of claimedOnly) console.log('  ' + r.padEnd(14) + boardState.get(r) + ' by hand, never recorded');
}

// TWO WAYS THE BOARD CAN BE WRONG, AND THEY ARE NOT THE SAME FAULT.
//
// A row the ledger has answered and the board still calls `pending` is a board that was not updated
// - the verdict exists, nobody wrote it down, and the campaign's own record of itself is behind. A
// row where both name a verdict and the words differ is worse: two records of the same measurement
// disagree, and which one is stale cannot be decided from here. COMM-14 was the first kind on
// 2026-08-21, reading `pending` while the ledger had held a FAIL for hours.
const stale = rows.filter((r) => latest.has(r) && ['pending', 'unstated'].includes(boardState.get(r)));
const contradicted = rows.filter(
  (r) => latest.has(r) && !['pending', 'unstated'].includes(boardState.get(r)) && boardState.get(r) !== latest.get(r).verdict
);
if (stale.length) {
  console.log('\n[rows] ' + stale.length + ' row(s) the ledger has answered and the BOARD has not recorded:');
  for (const r of stale) {
    console.log('  ' + r.padEnd(14) + ('board: ' + boardState.get(r)).padEnd(18) + 'ledger: ' + latest.get(r).verdict);
  }
}
if (contradicted.length) {
  console.log('\n[rows] ' + contradicted.length + ' row(s) where the BOARD and the LEDGER name DIFFERENT verdicts:');
  for (const r of contradicted) {
    console.log('  ' + r.padEnd(14) + ('board: ' + boardState.get(r)).padEnd(18) + 'ledger: ' + latest.get(r).verdict);
  }
}

// NOT GREEN, WHATEVER THE REASON, because a campaign that must end green owes a line for every row
// whose newest word is not PASS. They are listed rather than summed: SKIPPED, VACUOUS and FAIL are
// owed three different things, and a total would hide which.
const notGreen = rows.filter((r) => latest.has(r) && latest.get(r).verdict !== 'PASS');
if (notGreen.length) {
  console.log('\n[rows] ' + notGreen.length + ' row(s) whose NEWEST verdict is not PASS:');
  for (const r of notGreen) {
    const e = latest.get(r);
    console.log('  ' + r.padEnd(14) + String(e.verdict).padEnd(12) + String(e.build).slice(0, 8) + '  ' + e.at);
  }
}

// A VERDICT FROM A RUNNER THAT NO LONGER EXISTS IS NOT A VERDICT, and this is the trap that cost the
// most time in the campaign. HEAL-W2's newest word was `FAIL`, from 2026-08-11 - and `heal-w2.mjs`
// was REWRITTEN that same day, because the old verdict required a branch four runs proved
// unreachable. The row was reporting a failure of a script that had already been replaced, so the
// only honest reading of it is "never run". `results.mjs` records `checkSha` for exactly this and
// nothing consumed it.
//
// A row with no `checkSha` at all predates the field, which is the same answer for the same reason.
// WHERE A RUNNER LIVES, AND WHY THIS IS A SEARCH RATHER THAN A JOIN.
//
// `results.mjs` records `check` as a BARE FILENAME (`msg1.mjs`), which was the whole path while
// every runner sat at the harness root. They now live in `archive/`, so joining the name onto
// `HERE` named a file that does not exist and EVERY archived row reported `its runner no longer
// exists` - all seven MSG verdicts on 2026-09-04, each of them taken minutes earlier by a runner
// sitting right there. A warning that fires on every row is not a warning: it hides the one case it
// was written for, which is HEAL-W2's `FAIL` surviving the rewrite that made it unreachable.
//
// The directories are searched in order and the FIRST hit wins, which is safe because a name is
// unique across them - two runners with one name would be a fault of its own, and `inventory.mjs`
// is what would catch it.
// `findScript` rather than a fourth copy of this search: the same "a script moved to archive/" bug
// has now been fixed in four places, so the directories live in `scriptpath.mjs` and nowhere else.
// `null` is the right answer HERE - a runner that no longer exists is a fact about the ledger.
const runnerPath = findScript;

// AND THE SAME QUESTION ABOUT WHAT THE RUNNER MEASURES **WITH**, WHICH IS A DIFFERENT QUESTION.
// `checkSha` answers "did this runner change". It said nothing on 2026-09-04 when `openConversation`
// in `chat.mjs` turned out to be opening the WRONG CONVERSATION - MSG-1 asked for a DM, was handed a
// group, and recorded a verdict naming a conversation it never touched. `msg1.mjs` was untouched, so
// its hash still matched and this listed nothing. `instrumentSha` hashes the runner's own transitive
// in-tree import graph (`instrument.mjs`), so a shared gesture changing under a row is visible.
//
// REPORTED SEPARATELY, DELIBERATELY. "Your runner changed" and "the gesture twenty rows share
// changed" send the reader to different work, and merging them would make one edit to `chat.mjs`
// read as a rewrite of twenty runners.
const superseded = [];
const instrumentMoved = [];
const preInstrument = [];
const shaOf = new Map();
const instrumentOf = new Map();
for (const r of rows) {
  const e = latest.get(r);
  if (!e || !e.check) continue;
  const file = runnerPath(e.check);
  if (!file) {
    superseded.push([r, e, 'its runner no longer exists']);
    continue;
  }
  if (!shaOf.has(e.check)) {
    shaOf.set(e.check, createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12));
    instrumentOf.set(e.check, instrumentShaOf(file));
  }
  if (!e.checkSha) superseded.push([r, e, 'recorded before checkSha existed']);
  else if (e.checkSha !== shaOf.get(e.check)) superseded.push([r, e, `runner is now ${shaOf.get(e.check)}`]);
  // A verdict older than the field is NOT listed as a change: a warning that fires on every row is
  // not a warning, which this file already learnt the hard way about `runnerPath`. It gets its own
  // quiet line, and the population decays to nothing as rows are re-run.
  else if (!e.instrumentSha) preInstrument.push([r, e]);
  else if (e.instrumentSha !== instrumentOf.get(e.check)) {
    instrumentMoved.push([r, e, `instrument is now ${instrumentOf.get(e.check)}`]);
  }
}
const noSha = rows.filter((r) => latest.has(r) && !latest.get(r).check);
if (superseded.length || noSha.length) {
  const n = superseded.length + noSha.length;
  console.log(`\n[rows] ${n} verdict(s) taken by a runner that has since CHANGED - re-run before believing:`);
  for (const [r, e, why] of superseded) {
    console.log('  ' + r.padEnd(14) + String(e.verdict).padEnd(12) + String(e.check).padEnd(16) + why);
  }
  for (const r of noSha) {
    const e = latest.get(r);
    console.log('  ' + r.padEnd(14) + String(e.verdict).padEnd(12) + '(no check recorded)  predates the field entirely');
  }
}

if (instrumentMoved.length) {
  console.log(
    `
[rows] ${instrumentMoved.length} verdict(s) whose RUNNER is unchanged but whose shared instrument moved:`
  );
  for (const [r, e, why] of instrumentMoved) {
    console.log('  ' + r.padEnd(14) + String(e.verdict).padEnd(12) + String(e.check).padEnd(16) + why);
  }
  console.log('  (`bun instrument.mjs <runner>` lists the files behind that hash)');
}

if (preInstrument.length) {
  console.log(
    `
[rows] ${preInstrument.length} verdict(s) predate instrumentSha - their runner is unchanged, ` +
      `and nothing can say whether what they measure WITH is:`
  );
  console.log('  ' + preInstrument.map(([r]) => r).join(' '));
}

if (sinceBuild) {
  const stale = rows.filter((r) => latest.has(r) && !String(latest.get(r).build).startsWith(sinceBuild));
  console.log('\n[rows] ' + stale.length + ' row(s) whose newest verdict was NOT taken on ' + sinceBuild);
  if (stale.length) console.log('  ' + stale.join(' '));
}

if (diagnostics.size) {
  console.log(
    '\n[rows] ' + diagnostics.size + ' diagnostic id(s) in the ledger, answering no row by design:'
  );
  console.log('  ' + [...diagnostics].map(([id, n]) => id + ' (' + n + ')').join('  '));
}
if (divergent.size) {
  console.log('\n[rows] ' + divergent.size + ' recorded id(s) the board does NOT name:');
  for (const [id, e] of divergent) console.log('  ' + id.padEnd(16) + e.check + ' (' + e.count + ' row(s))');
  console.log('  Either the board is missing the row, or the runner answers under the wrong name.');
}

// A SCRIPT NO PHASE CLAIMS CANNOT BE RUN BY `run.mjs`, whatever it records - DEL-1's fault exactly.
// Read from the SOURCE here, because it is the only thing that can answer it: the ledger says what
// HAS run, and this asks what CAN be.
const claimed = new Set(
  Object.values(PHASES).flatMap((p) => (p.scripts || []).map((s) => s.split(' ')[0]))
);
const unreachable = [];
for (const file of readdirSync(HERE).filter((f) => f.endsWith('.mjs'))) {
  // This file and `results.mjs` both quote `record('X-1', ...)` in prose; neither is a check.
  if (claimed.has(file) || file === 'rows.mjs' || file === 'results.mjs') continue;
  const src = readFileSync(join(HERE, file), 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/\b(?:record|finishObserved|finish)\(\s*['"`]([^'"`${}]+)['"`]\s*,/g)) {
    if (boardRowsFor(m[1]).length) ids.add(m[1]);
  }
  if (ids.size) unreachable.push(file + ' -> ' + [...ids].join(' '));
}
if (unreachable.length) {
  console.log('\n[rows] ' + unreachable.length + ' runner(s) answer a board row and NO phase claims them:');
  for (const u of unreachable) console.log('  ' + u);
}

if (strict) {
  const bad =
    reallyNever.length +
    claimedOnly.length +
    contradicted.length +
    stale.length +
    notGreen.length +
    divergent.size +
    unreachable.length +
    superseded.length +
    noSha.length;
  console.log('\n[rows] --strict: ' + bad + ' owed');
  process.exit(bad > 0 ? 1 : 0);
}
