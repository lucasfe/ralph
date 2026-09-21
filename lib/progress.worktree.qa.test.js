import { describe, it, expect } from 'vitest'
import {
  buildProgress,
  renderProgress,
  renderProgressLine,
  renderTaskTable,
  renderWorktreeRow,
  toJsonSnapshot,
} from './progress.js'

// #222's ADVERSARIAL SWEEP over the pure half. lib/progress.worktree.test.js owns the
// feature's contract — the gate, the absent row, the scrub, the verbatim leaf — and this
// file only asks what that suite does not. Every question here is about a promise the
// module makes about itself in prose, where the prose has an edge nobody measured:
//
//   1. THE 4 KB BOUND HAS AN EDGE, AND THE CUT IS SILENT. `RAW_PATH_LIMIT` bounds the
//      scrub's work before it starts, and the comment beside it argues that no path a run
//      can `cd` into comes near it: `PATH_MAX` caps the pathname a syscall will accept
//      (`getconf PATH_MAX /` reports 1024 on this machine), so git could not have printed a
//      4 KB worktree path for the loop to record. THE FILESYSTEM IS NOT SO BOUNDED, which is
//      the part worth writing down: walking down a deep tree with relative `mkdir` calls
//      produced a directory whose absolute path is 4417 characters — `getcwd` returned the
//      whole thing, while `stat` on that absolute path failed with "file name too long". That
//      was measured BY HAND on this machine while this file was being written, and nothing
//      below re-runs it: a test that nested 4 KB of directories would be a test about the
//      checkout's filesystem, not about this module. All it establishes is that the bound is
//      defence against a value hand-written into `.ralph/run-state.json` rather than against
//      a real run. Out of reach is not out of test, though, and the part that IS about the
//      module is measured below: a path AT the limit survives whole, and one past it comes
//      out CUT WITH NO ELLIPSIS — the one difference from `cleanTitle`, which pays for its
//      `…` inside its budget precisely so a reader can see that a value was shortened.
//   2. A PATH IS NOT PROSE, AND WHITESPACE IS PART OF IT. `scrubForTerminal` collapses
//      every run of whitespace to one space and trims the ends, because a TAB in the row
//      would walk the reader's cursor out of the label column. A directory may legally be
//      called `my  dir`, so the cost of that rule is a row naming a directory that does
//      not exist — which is exactly the failure `worktreeOf` refuses to accept from
//      truncation. Both halves are measured: what the ROW says, and that `--json` is the
//      surface that still holds the bytes.
//   3. THE ROW OVERFLOWS ONLY ITS OWN LINE. The reason this is a label-column row rather
//      than a fifth table column is that the table derives its widths from its cells. That
//      argument is only worth anything if it is true, so the table, the progress line and
//      the three counted rows are compared BYTE FOR BYTE between a snapshot with no
//      worktree and one carrying a 3000-character path.
//   4. A VIEW WRITES NOTHING. The record is `.ralph/run-state.json` parsed, handed to
//      three functions in one command; none of them may leave a scrubbed path, or anything
//      else, on the caller's object.
//   5. `current` ITSELF CAN BE THE WRONG SHAPE. The sibling suite drives every wrong type
//      of `current.worktree`; the record is a file a human can edit, so `current` can be
//      an array or a number just as easily, and `readRunState` hands back what it found.
//
// Control bytes are spelled with `String.fromCharCode` throughout, never as literals: a
// suite about invisible characters must not depend on one surviving a copy, a paste or a
// tool argument (#107).

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

const WORKTREE = '/repo/.ralph/worktrees/issue-31'

// The module's own bound, spelled again here rather than exported: a test that imported the
// constant would agree with the implementation by construction, including where the
// implementation is wrong. 4096 is the usual Linux `PATH_MAX` and four times the 1024 this
// machine reports, so no path a syscall will resolve comes near it — which is why the
// assertions below are about the SHAPE of the cut rather than about a path anybody will have.
const RAW_PATH_LIMIT = 4096
const ELLIPSIS = String.fromCodePoint(0x2026)
const TAB = String.fromCharCode(9)
const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)

// A path of EXACTLY n characters, still looking like one: the prefix is what an assertion
// about the surviving text can hold on to.
const pathOfLength = (n) => '/repo/' + 'w'.repeat(n - '/repo/'.length)

const event = ({ number = 1, minutes = null, cost = null, ts = 1 } = {}) => ({
  issue_number: number,
  run_id: RUN,
  ts,
  duration_ms: minutes == null ? null : minutes * MIN,
  total_cost_usd: cost,
  verdict: 'pass',
})

const jsonl = (...events) =>
  events.map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e)).join('\n') + '\n'

const WORKED_EXAMPLE = jsonl(
  event({ number: 29, minutes: 97, cost: 34.1, ts: 1 }),
  event({ number: 30, minutes: 71, cost: 28.75, ts: 2 }),
)

const inFlightRecord = (current = {}) => ({
  run_id: RUN,
  status: 'running',
  queue_at_start: 8,
  current:
    current === null || typeof current !== 'object' || Array.isArray(current)
      ? current
      : {
          number: 31,
          started_at: TASK_STARTED.toISOString(),
          iteration: 3,
          worktree: WORKTREE,
          ...current,
        },
})

const live = ({ record = inFlightRecord(), ...overrides } = {}) =>
  buildProgress({ metricsText: WORKED_EXAMPLE, record, queue: 6, now: NOW, ...overrides })

const rowFor = (worktree) => renderWorktreeRow(live({ record: inFlightRecord({ worktree }) }))
const docFor = (worktree) => {
  const record = inFlightRecord({ worktree })
  return toJsonSnapshot(live({ record }), { mode: 'running', record })
}

describe('worktreeOf — the 4 KB bound’s two edges (#222 QA)', () => {
  it('keeps a path of exactly RAW_PATH_LIMIT characters whole', () => {
    // `raw.length > limit` is the test in the source, so the limit itself is INSIDE the
    // budget. Both sides of the comparison are pinned, because an off-by-one here does not
    // throw and does not look wrong — it silently drops the last character of a path, which
    // is the one kind of damage this field cannot survive.
    for (const length of [RAW_PATH_LIMIT - 1, RAW_PATH_LIMIT]) {
      const path = pathOfLength(length)
      expect(path.length).toBe(length)
      expect(live({ record: inFlightRecord({ worktree: path }) }).worktree, String(length)).toBe(path)
      expect(rowFor(path), String(length)).toEqual([`  worktree   ${path}`])
    }
  })

  it('cuts the character past the limit, and says nothing to the reader about it', () => {
    // The one place this parts company with `cleanTitle`, and it parts twice: a title is cut
    // to a COLUMN budget and pays for an `…` inside it, so a shortened title is visibly
    // shortened. A path is cut only at 4 KB and gets no marker, so a reader is handed
    // something that looks like a complete path and is not one. The only value that gets here
    // is one somebody hand-wrote into `.ralph/run-state.json`, since nothing a run can `cd`
    // into is this long (see the constant above) — so this records the shape of the edge, not
    // a case a run meets.
    const over = pathOfLength(RAW_PATH_LIMIT + 1)
    const [line] = rowFor(over)
    const shown = line.slice('  worktree   '.length)
    expect(shown).toHaveLength(RAW_PATH_LIMIT)
    expect(over.startsWith(shown)).toBe(true)
    expect(shown).not.toContain(ELLIPSIS)
    expect(line).not.toContain(ELLIPSIS)
  })

  it('bounds the work without bounding the DOCUMENT, so a script still gets the whole path', () => {
    // The asymmetry the two surfaces are built on, at the one length where it is visible:
    // the bound belongs to the terminal pass (a few regex walks over a string somebody else
    // sized), and the document transcribes the record. A machine that cannot `cd` into what
    // it was given has been handed a wrong answer, which is worse than a long line.
    for (const length of [RAW_PATH_LIMIT + 1, 10_000]) {
      const path = pathOfLength(length)
      expect(docFor(path).tasks.current.worktree, String(length)).toBe(path)
      expect(docFor(path).tasks.current.worktree.length, String(length)).toBe(length)
    }
  })

  it('still draws ONE line for an absurd path, and still draws none for absurd nonsense', () => {
    // A megabyte of path is one row (long, and only its own line), while a megabyte of
    // escapes is no row at all: the bound runs before the scrub, and an empty result is
    // still "no worktree" after it.
    const absurd = '/repo/' + 'x'.repeat(1_000_000)
    expect(rowFor(absurd)).toHaveLength(1)
    expect(rowFor(absurd)[0].length).toBeLessThan(RAW_PATH_LIMIT + 100)
    expect(rowFor((ESC + '[0m').repeat(500_000))).toEqual([])
  })
})

describe('worktreeOf — whitespace is part of a directory’s name (#222 QA)', () => {
  // Each row is a path a filesystem will happily give you, and what the TERMINAL row makes
  // of it. The rule doing this is `\s+ → ' '` plus `trim()`, inherited from the title scrub
  // and needed for the same reason: a TAB or a newline in the row would move the reader's
  // cursor out of the label column, or forge a second row. A run of plain SPACES costs
  // nothing on a terminal and is collapsed anyway, so `my  dir` is drawn as `my dir` — a
  // path that names no directory, which is the same damage `worktreeOf` refuses to accept
  // from truncation. `--json` is the surface that keeps the bytes (measured below).
  const legal = {
    'one space, which survives': ['/repo/my dir/issue-1', '/repo/my dir/issue-1'],
    'two spaces, collapsed to one': ['/repo/my  dir/issue-1', '/repo/my dir/issue-1'],
    'a tab, which a terminal obeys': ['/repo/my' + TAB + 'dir', '/repo/my dir'],
    'a trailing space, trimmed away': ['/repo/dir ', '/repo/dir'],
    'a leading space, trimmed away': [' /repo/dir', '/repo/dir'],
    'a name that is only spaces': ['/repo/   /issue-1', '/repo/ /issue-1'],
  }

  for (const [label, [path, drawn]] of Object.entries(legal)) {
    it(`draws ${label}`, () => {
      expect(rowFor(path), label).toEqual([`  worktree   ${drawn}`])
      // Whatever the row had to do to the text, the document did not: one of these two
      // surfaces is a `cd` target for a machine, and it is byte-exact.
      expect(docFor(path).tasks.current.worktree, label).toBe(path)
    })
  }

  it('normalizes no unicode, so a composed and a decomposed path stay different paths', () => {
    // macOS hands back NFD where Linux hands back NFC, and the two spellings of `café` are
    // different byte strings naming (on a case-sensitive, non-normalizing filesystem)
    // different directories. The scrub is a regex pass and a trim, so neither spelling is
    // converted into the other — asserted in both directions, because "unchanged" is the
    // only answer that keeps the row and the record talking about one directory.
    const nfc = '/repo/caf' + String.fromCodePoint(0xe9) + '/issue-1'
    const nfd = '/repo/cafe' + String.fromCodePoint(0x301) + '/issue-1'
    expect(nfc).not.toBe(nfd)
    expect(rowFor(nfc)).toEqual([`  worktree   ${nfc}`])
    expect(rowFor(nfd)).toEqual([`  worktree   ${nfd}`])
  })

  it('keeps the wide and the astral characters a real path can hold', () => {
    // A path is whatever the user named their directory. These are not hazards — they are
    // ordinary characters that happen to be two columns wide or outside the BMP, and the
    // one thing that must not happen to them is a re-encoding or a code-point-counted cut.
    for (const path of [
      '/repo/プロジェクト/.ralph/worktrees/issue-31',
      '/repo/' + String.fromCodePoint(0x1f600) + '/issue-1',
      '/repo/Ünïcødé/issue-1',
    ]) {
      expect(rowFor(path), path).toEqual([`  worktree   ${path}`])
      expect(docFor(path).tasks.current.worktree, path).toBe(path)
    }
  })
})

describe('the worktree row overflows its own line and nothing else (#222 QA)', () => {
  it('leaves the table, the progress line and the counted rows byte-identical', () => {
    // The whole argument for a label-column row rather than a fifth column: `renderTaskTable`
    // derives its task column from the widest cell on show, so a path in a cell would push
    // `verdict`, `cost` and `time` off a standard terminal for every row. Two snapshots that
    // differ in NOTHING but the worktree, compared on every other line the view draws — which
    // is the assertion that the path really is outside the grid, rather than merely short in
    // the fixture the sibling suite uses.
    const deep = '/Users/someone/' + 'a-rather-deeply-nested-directory/'.repeat(100) + 'issue-31'
    expect(deep.length).toBeGreaterThan(3000)
    const bare = live({ record: inFlightRecord({ worktree: null }) })
    const loaded = live({ record: inFlightRecord({ worktree: deep }) })

    expect(renderTaskTable(loaded)).toEqual(renderTaskTable(bare))
    expect(renderProgressLine(loaded)).toEqual(renderProgressLine(bare))
    expect(renderProgress(loaded)).toEqual(renderProgress(bare))
    // ...and the row itself is the one line that grew, whole and unpadded.
    expect(renderWorktreeRow(bare)).toEqual([])
    expect(renderWorktreeRow(loaded)).toEqual([`  worktree   ${deep}`])
  })

  it('changes no other leaf of the --json document either', () => {
    // The same comparison on the machine surface, where the risk is different in kind: a
    // projection that recomputed anything from the record would have the path reach a number.
    const deep = '/repo/' + 'nested/'.repeat(400) + 'issue-31'
    const { worktree: withPath, ...restWith } = docFor(deep).tasks.current
    const { worktree: withNull, ...restWithout } = docFor(null).tasks.current
    expect(withPath).toBe(deep)
    expect(withNull).toBe(null)
    expect(restWith).toEqual(restWithout)
    const { tasks: _a, ...envelopeWith } = docFor(deep)
    const { tasks: _b, ...envelopeWithout } = docFor(null)
    expect(envelopeWith).toEqual(envelopeWithout)
  })
})

describe('reading the record leaves it exactly as it was found (#222 QA)', () => {
  it('writes the scrubbed path back onto nothing', () => {
    // `.ralph/run-state.json` is parsed once and handed to `buildProgress`, `renderWorktreeRow`
    // and `toJsonSnapshot` in one command (`statusCommand` does exactly that). A scrubbed
    // value cached onto `record.current` would make the DOCUMENT's verbatim leaf depend on
    // whether the human view happened to render first — the two surfaces agreeing by accident
    // of order, which is the one way "one snapshot, two surfaces" can quietly stop being true.
    const hostile = '/repo' + ESC + '[31m/worktrees' + LF + '  queue      99 waiting'
    const record = inFlightRecord({ worktree: hostile })
    const pristine = structuredClone(record)
    const snapshot = buildProgress({ metricsText: WORKED_EXAMPLE, record, queue: 6, now: NOW })
    renderWorktreeRow(snapshot)
    toJsonSnapshot(snapshot, { mode: 'running', record })
    expect(record).toEqual(pristine)
    expect(record.current.worktree).toBe(hostile)
  })

  it('does not mutate the snapshot it renders from', () => {
    const snapshot = live()
    const pristine = structuredClone(snapshot)
    expect(renderWorktreeRow(snapshot)).toEqual([`  worktree   ${WORKTREE}`])
    expect(renderWorktreeRow(snapshot)).toEqual([`  worktree   ${WORKTREE}`])
    expect(snapshot).toEqual(pristine)
  })
})

describe('a `current` that is not an object at all (#222 QA)', () => {
  it('answers no worktree, and no row, for every shape a hand-edited record can hold', () => {
    // The sibling suite drives every wrong type of `current.worktree`; this is the level
    // above it. `.ralph/run-state.json` is a file a human can edit and `readRunState` hands
    // back any JSON OBJECT verbatim, so `current` can be an array, a number or a string —
    // all of them truthy enough to open the in-flight gate, none of them carrying a path.
    for (const current of [[], ['/repo'], 42, true, '/repo/.ralph/worktrees/issue-31']) {
      const record = inFlightRecord(current)
      const snapshot = live({ record })
      expect(snapshot.worktree, JSON.stringify(current)).toBe(null)
      expect(renderWorktreeRow(snapshot), JSON.stringify(current)).toEqual([])
      expect(
        toJsonSnapshot(snapshot, { mode: 'running', record }).tasks.current?.worktree ?? null,
        JSON.stringify(current),
      ).toBe(null)
    }
  })

  it('throws for none of them, which is the only contract a read-only view has', () => {
    for (const record of [
      { current: { worktree: Object.create(null) } },
      { current: Object.create(null) },
      { current: new Map([['worktree', WORKTREE]]) },
      { current: { worktree: [WORKTREE] } },
    ]) {
      expect(() => renderWorktreeRow(live({ record })), JSON.stringify(record)).not.toThrow()
      expect(renderWorktreeRow(live({ record }))).toEqual([])
    }
  })
})
