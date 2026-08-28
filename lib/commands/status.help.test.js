import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { buildProgress, renderProgress } from '../progress.js'
import { renderStatus } from './status.js'

// #64 — `ralph status --help` has to describe the command it actually documents.
// The summary was written for #55, when the live view printed three counted facts
// (run, task in flight, queue); #57 added the three DERIVED lines — pace, ETA and
// spend — and the summary was never widened to name them, so the one surface a
// reader consults before running the command under-sold it.
//
// What is pinned here is that AGREEMENT, in both directions, and never one exact
// sentence:
//
//   1. EVERY LINE THE VIEW PRINTS IS NAMED. The expectations are computed from
//      `renderStatus` itself — the only thing that decides which lines the view has —
//      so a fourth line added there turns this file red until the summary names it,
//      which is exactly the drift #64 is about.
//   2. NOTHING IS NAMED THAT THE VIEW DOES NOT PRINT. Accuracy runs both ways: the
//      enumeration is read back out of the real help text and each item checked
//      against the view, which is what would catch a number documented before it
//      ships.
//   3. THE DERIVATION ITSELF CANNOT GO VACUOUS. A computed expectation list is only
//      as strong as its own shape, so the label extraction is pinned against the
//      renderer directly and the list it currently answers is stated once, as a
//      canary.
//
// bin/ralph.js parses argv on import and bin/ is outside vitest's include globs, so
// the help TEXT is read from real invocations — the way status.json.test.js and
// update.test.js assert their own CLI registration. Everything about the VIEW goes
// through the pure pair (`buildProgress` → `renderStatus`) with an injected clock and
// a literal metrics text, so it needs no fs, no clock and no subprocess.

const BIN = fileURLToPath(new URL('../../bin/ralph.js', import.meta.url))

// One spawn per distinct argv, memoized as the PROMISE so the `it`s share a single
// process rather than racing to start their own. Two spawns is the floor rather than
// one: `ralph --help` and `ralph status --help` are two different screens.
const spawns = new Map()
function cli(...argv) {
  const key = argv.join(' ')
  if (!spawns.has(key)) spawns.set(key, execa('node', [BIN, ...argv], { reject: false }))
  return spawns.get(key)
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

// The command's own description, not the whole help screen: commander prints it
// between the usage line and the options block. Scoping there is what keeps these
// assertions honest — a word that appeared only in `--json`'s option help would
// otherwise satisfy a test about the one-line summary standing above it. Normalized,
// because commander wraps the description at 80 columns when stdout is not a TTY: the
// line breaks in it are the terminal width, not the prose.
function descriptionOf(stdout) {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => line.startsWith('Usage:')) + 1
  const end = lines.findIndex((line) => line.startsWith('Options:'))
  return normalize(lines.slice(start, end === -1 ? undefined : end).join(' '))
}

const statusDescription = async () => descriptionOf((await cli('status', '--help')).stdout)

// The derived block's labels. `split(/\s+/)[0]` is a shortcut for the label column,
// and the guard in the last block below is what keeps it equal to the real thing.
const derivedLabels = () => renderProgress({}).map((line) => line.trim().split(/\s+/)[0])

// The label column of a rendered line: everything before the first run of two or more
// spaces, which is what separates a label from its value in `row()`. Unlike the
// first-word shortcut this keeps a multi-word label whole. #56 retired the last one the
// view had (`in flight`, now a segment of the progress line), so the two agree
// everywhere today — which is what the canary in the final block asserts, and why a
// future `per task` label would be caught rather than silently read as `per`.
const labelColumnOf = (line) => line.trim().split(/\s{2,}/)[0]

// A live run with real numbers behind it, so the assertions read the lines a reader
// actually sees rather than three labels saying `unknown`. Local Date constructors
// because the rendered clock is local time, and an injected `now` throughout.
const RUN_ID = 'run-live'
const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

const record = () => ({
  schema: 1,
  run_id: RUN_ID,
  session: 'ralph-repo-live',
  source: 'github',
  status: 'running',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
})

// Three timed, costed tasks of this run — enough for the in-run pace basis, so every
// derived line has a number to print.
const METRICS = [
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","number":11,"duration_ms":2520000,"total_cost_usd":3.2}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","number":12,"duration_ms":3000000,"total_cost_usd":4}`,
  `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","number":13,"duration_ms":2760000,"total_cost_usd":2.8}`,
  '',
].join('\n')

function liveView(mode) {
  const rec = record()
  const progress = buildProgress({ metricsText: METRICS, record: rec, queue: 6, now: NOW })
  return renderStatus({
    mode,
    record: rec,
    session: rec.session,
    queue: 6,
    attachable: mode === 'running',
    now: NOW,
    progress,
  })
}

// The FACTS the summary enumerates, which is the block above the LAST blank separator.
// What follows that blank is advice — `attach`, `kill`, `restart`, `logs` — and a
// one-line summary of what the command SHOWS has no business listing it.
//
// `lastIndexOf` rather than `indexOf` since #56: the task table is fenced by blanks of
// its own, so the first blank now sits in the middle of the facts and would cut the
// sweep down to the progress line alone — which is exactly the under-reading #64
// exists to catch, and it would have passed silently.
//
// The table's ROWS are then dropped again, because a row is not a labeled fact: its
// left column is an issue number, and `#029` in a summary of what the command shows
// would be a lie about a specific issue rather than a promise about a line. Its HEADER
// stays, so the `task` column still has to be named. Rows are the lines whose first
// visible character is `#` — including the degraded `#?` a record with no number gets.
const factLinesOf = (lines) => {
  const advice = lines.lastIndexOf('')
  return (advice === -1 ? lines : lines.slice(0, advice)).filter(
    (line) => line.startsWith('  ') && !line.trim().startsWith('#'),
  )
}

describe('ralph status --help — the screen the summary is read from (#64)', () => {
  it('exits 0, puts the help on stdout and writes nothing to stderr', async () => {
    const result = await cli('status', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: ralph status')
    // A reader piping `ralph status --help` into a pager must not have half of it
    // arrive out of band.
    expect(result.stderr).toBe('')
  })

  it('does not run the command it documents', async () => {
    // Commander has to exit before the action, which resolves a git toplevel, probes
    // tmux and counts the queue with `gh`. `--help` inside a repo with a live run is a
    // question about the CLI, not a reason to go looking at the run — and a status
    // view accidentally printed under `--help` would also feed the description slice
    // lines that are not help text.
    const result = await cli('status', '--help')
    expect(result.stdout).not.toContain('▸ ralph')
    expect(result.stdout).not.toContain('"mode"')
  })

  it('recovers a description block that is prose and not option help', async () => {
    // The slice runs from `Usage:` to `Options:`, and with no `Options:` line it would
    // widen to the whole screen and start reading option help as though it were the
    // summary. An empty slice would satisfy a `not.toMatch` and a length cap without
    // asserting anything either, so both shapes are stated rather than assumed.
    const description = await statusDescription()
    expect(description, 'the description block came back empty').not.toBe('')
    expect(description).not.toContain('--json')
    expect(description).not.toContain('-h,')
  })

  it('closes every parenthesis it opens', async () => {
    // The summary's new content is a parenthetical, so truncation — commander's, a
    // future width cap's, or a hand-applied one — reads as a sentence that opens a
    // list and never closes it. Cheap to state, and it is exactly the shape "reads
    // well standing alone" fails in. The top-level screen needs no check of its own:
    // the test below asserts it contains this description WHOLE.
    const description = await statusDescription()
    const opened = (description.match(/\(/g) ?? []).length
    const closed = (description.match(/\)/g) ?? []).length
    expect(closed, `a parenthesis is left open: ${description}`).toBe(opened)
  })

  it('lists status at the top level with the same summary, whole', async () => {
    // Two surfaces, one sentence. The top-level block is where a reader meets the
    // command first, and it is the surface that gets least attention when a
    // description changes: commander re-wraps it into a narrower column there, and it
    // prints `cmd.summary() || cmd.description()` — so a `.summary()` added to
    // `status` later would leave the two screens describing the command differently.
    // Asserted as a `toContain` over the whitespace-normalized screen rather than by
    // recovering the summary out of commander's help column, which would go red on a
    // commander upgrade where Ralph changed nothing.
    const out = (await cli('--help')).stdout
    expect(out, '`ralph --help` no longer lists a status command').toMatch(/^\s+status\b/m)
    expect(normalize(out)).toContain(await statusDescription())
  })
})

describe('ralph status --help — the summary and the live view agree (#64)', () => {
  it('names every labeled fact line of the live view', async () => {
    // The core of #64, in the direction the defect ran: every line the view prints is
    // named in the summary. The labels come from `renderStatus` rather than from a
    // typed list, so a fourth line — counted, derived, or #56's table — turns this red
    // until the summary is widened. Whole label, not its first word, so a multi-word
    // label would have to be named in full rather than by its opening word.
    //
    // Word by word and case-insensitively, because commander wraps the description at
    // 80 columns off a TTY: matching a contiguous phrase would pin the terminal width
    // rather than the prose, and `eta` is a label in the rendered column but an
    // acronym in a sentence.
    const facts = factLinesOf(liveView('running'))
    expect(facts.length, 'the live view stopped printing labeled facts').toBeGreaterThan(0)
    const description = await statusDescription()
    for (const label of facts.map(labelColumnOf)) {
      for (const word of label.split(/\s+/)) {
        expect(description, `the summary never mentions "${label}"`).toMatch(
          new RegExp(`\\b${word}\\b`, 'i'),
        )
      }
    }
  })

  it('names the run itself, which the labeled sweep cannot see', async () => {
    // The heading line names the RUN — its id, when it started, how long ago — and it
    // carries no label column, so the sweep above never reaches it. The summary has
    // named it since #55, and the derived lines are an addition rather than a licence
    // to drop it.
    expect(await statusDescription(), 'the summary stopped naming the run').toMatch(/\brun\b/i)
  })

  it('promises nothing the live view does not print', async () => {
    // ACCURACY IN THE OTHER DIRECTION, which nothing else covers: the enumeration is
    // read back out of the real help text and each item checked against the view. An
    // item for a line that does not exist — `tokens`, `cost`, a fourth number
    // documented before it shipped — fails here, which is the over-promise half of
    // #64's "accurate".
    //
    // "At least one word of the item" rather than all of them, because the prose
    // legitimately names a line more fully than its label does: the summary says `task
    // table` for a column headed `task`. That is the honest weakening — an item mixing a
    // real line with an invented one could still pass — and it still catches an item
    // with no line behind it at all.
    //
    // The parsing here (a parenthesised, comma-separated enumeration) is the ONE thing
    // in this file that constrains the summary's shape. If a future rewrite makes it
    // go red, the intent is to reconsider whether this test still expresses the
    // property — not to teach the parser a new sentence form.
    const description = await statusDescription()
    const enumerated = description.match(/\(([^)]*)\)/)
    expect(enumerated, `the summary stopped enumerating what it shows: ${description}`).not.toBe(
      null,
    )

    const lines = liveView('running')
    const vocabulary = new Set([
      // The heading is a fact line too — it is where the run itself is named — and it
      // carries no label column, so its words are taken whole.
      ...lines[0]
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter(Boolean),
      ...factLinesOf(lines).flatMap((line) => labelColumnOf(line).toLowerCase().split(/\s+/)),
    ])
    for (const item of enumerated[1].split(',')) {
      const words = item.trim().toLowerCase().split(/\s+/).filter(Boolean)
      expect(words.length, `the summary enumerates an empty item: ${description}`).toBeGreaterThan(0)
      expect(
        words.some((word) => vocabulary.has(word)),
        `the summary promises "${item.trim()}", which the live view never prints`,
      ).toBe(true)
    }
  })

  it('reads as one self-contained summary of the command', async () => {
    const description = await statusDescription()
    // Standalone means standalone: a reader who has typed `ralph status --help` and
    // nothing else has to learn what the command shows from this text alone. So it
    // names its subject rather than leaning on the surrounding help screen ("shows the
    // above"), and it stays a summary rather than growing into the prose the README
    // owns.
    expect(description).toMatch(/\bralph\b/i)
    expect(description).not.toMatch(/\b(above|below|see the readme)\b/i)
    expect(description.length, 'the summary grew into documentation').toBeLessThan(160)
  })
})

describe('ralph status --help — the derivation the assertions rest on (#64)', () => {
  it('keeps each derived label inside its first word, so the shortcut asserts all of it', () => {
    // `derivedLabels`'s `split(/\s+/)[0]` recovers a one-word label and only the FIRST
    // word of a longer one. The live view carried a two-word label (`in flight`) until
    // #56 folded it into the progress line, so this is not hypothetical: were a derived
    // line ever labelled `per task`, the canary below would compare `per` against the
    // real name and never notice.
    for (const line of renderProgress({})) {
      expect(line.trim().split(/\s+/)[0], `the label column of "${line.trim()}" is multi-word`).toBe(
        labelColumnOf(line),
      )
    }
  })

  it('names the three lines #57 added, and only those', () => {
    // The canary for the computed expectations above, in one place and with the whole
    // list visible: a rename, a reorder or a fourth derived line reads here as a list
    // mismatch, rather than only as a puzzling regex failure against a sentence in
    // bin/ralph.js.
    expect(derivedLabels()).toEqual(['pace', 'eta', 'spend'])
  })
})
