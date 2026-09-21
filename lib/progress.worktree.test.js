import { describe, it, expect } from 'vitest'
import { buildProgress, renderWorktreeRow, toJsonSnapshot } from './progress.js'

// #222 — WHERE IS RALPH WORKING? Since #218 every task runs in its own git worktree, so
// "what is Ralph on?" now has a second half: which DIRECTORY that task is being done in.
// `lib/run-state.js` records the path the loop measured; this module renders it, on both
// surfaces, off the one snapshot — which is what this file is about.
//
// Three properties, and the file is those three:
//
//   1. THE SAME GATE AS THE TASK. A worktree is a fact about the task IN FLIGHT, so it is
//      carried under exactly the condition that names one (`runAlive && record.current`) —
//      never re-derived from the record by either renderer. A dead run is not working in a
//      directory, and an idle one has no task whose directory it could be.
//   2. NO ROW RATHER THAN AN EMPTY ONE. A run recorded before #222, and an iteration that
//      failed before its worktree existed, both have no path — and the row is then ABSENT,
//      the bargain `renderTaskTable` already strikes with its header. `  worktree   –` would
//      be furniture in a view whose every other label answers a question.
//   3. TWO SURFACES, TWO TREATMENTS OF THE SAME STRING. The terminal gets it SCRUBBED
//      (a path is text that arrived over a pipe and lands on a terminal that obeys some of
//      what it is sent) and the document gets it VERBATIM (a truncated or scrubbed path
//      names no directory, and a machine is not a terminal) — the asymmetry `taskKeyOf` and
//      the document's own transcription already make for the Jira key.
//
// Hermetic like the rest of the progress suite: the module is pure, every input is injected,
// and control bytes are spelled with `String.fromCharCode` so a test about invisible
// characters cannot depend on one surviving a copy, a tool argument or a source sweep.

const MIN = 60000
const RUN = 'ralph-ralph-b36ff7b1'

const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 40min into #031

const WORKTREE = '/repo/.ralph/worktrees/issue-31'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const NUL = String.fromCharCode(0)
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const BS = String.fromCharCode(8)
const VT = String.fromCharCode(11)
const FF = String.fromCharCode(12)
const DEL = String.fromCharCode(127)
const cp = (n) => String.fromCodePoint(n)

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

// The record a live iteration leaves since #222: the task, and the directory it is being
// done in. `current` is spread from one place so a test that changes the worktree changes
// nothing else.
const inFlightRecord = (current = {}) => ({
  run_id: RUN,
  status: 'running',
  queue_at_start: 8,
  current:
    current === null
      ? null
      : { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3, worktree: WORKTREE, ...current },
})

const live = ({ record = inFlightRecord(), ...overrides } = {}) =>
  buildProgress({ metricsText: WORKED_EXAMPLE, record, queue: 6, now: NOW, ...overrides })

// The one snapshot, projected — the same two calls statusCommand makes, with the same
// record handed to both.
const project = ({ record = inFlightRecord(), mode = 'running', ...overrides } = {}) =>
  toJsonSnapshot(live({ record, ...overrides }), { mode, record })

describe('buildProgress — the worktree the in-flight task is being done in (#222)', () => {
  it('carries the recorded path, terminal-ready, beside the rows it belongs to', () => {
    expect(live().worktree).toBe(WORKTREE)
  })

  it('carries null when the record names no worktree', () => {
    // Every absence, and none of them may become a derived path: a record written before
    // #222 has no field, an iteration that failed before its worktree existed recorded
    // `null`, and a hand-edited file can hold anything at all. `<root>/.ralph/worktrees/
    // issue-31` is guessable from the number and is deliberately NOT guessed — it is wrong
    // for a folder task (`task-31`) and wrong for a task that never got a directory.
    for (const worktree of [undefined, null, '', '   ', 31, {}, [], true]) {
      expect(live({ record: inFlightRecord({ worktree }) }).worktree, String(worktree)).toBe(null)
    }
  })

  it('carries null when nothing is in flight', () => {
    // A run between tasks has no task, so it has no task's directory. The same field the
    // progress line reads as `nothing in flight`.
    expect(live({ record: inFlightRecord(null) }).worktree).toBe(null)
    expect(live({ record: null }).worktree).toBe(null)
    expect(live({ record: { run_id: RUN } }).worktree).toBe(null)
  })

  it('carries null for a run that is OVER, off the same gate the in-flight row uses', () => {
    // run-state's `endRun` keeps `current` on a terminal record deliberately (it is the last
    // task the run worked on), and a hard kill leaves it too — so reading the field directly
    // would have the view name a directory an already-dead run was "working in". The gate is
    // `runAlive && record.current`, stated once in buildProgress; this is the assertion that
    // the worktree hangs off it rather than off a second reading of the record.
    expect(live().worktree).toBe(WORKTREE)
    expect(live({ runAlive: false }).worktree).toBe(null)
    expect(live({ runAlive: false }).inFlight).toBe(0)
  })
})

describe('renderWorktreeRow — one label-column row, or none at all (#222)', () => {
  it('renders the path in the view’s label column', () => {
    // The same two-column row as `queue`, `pace` and `attach`: two spaces, an 11-column
    // label, then the value at column 14. A fifth TABLE column was the alternative and it
    // is the wrong shape — the table's task column is derived from the widest cell on show,
    // so one absolute path would push every other row off the screen.
    expect(renderWorktreeRow(live())).toEqual([`  worktree   ${WORKTREE}`])
  })

  it('renders NOTHING — not an empty row, not a dash — when there is no worktree', () => {
    // `renderTaskTable`'s bargain, applied to one line: a label with `–` beside it is
    // furniture in a view where every other label answers a question. An ARRAY so the
    // shell spreads it, which is what makes "no row" a shape rather than a filtered `''`.
    for (const record of [inFlightRecord({ worktree: null }), inFlightRecord(null), null]) {
      expect(renderWorktreeRow(live({ record })), JSON.stringify(record)).toEqual([])
    }
    expect(renderWorktreeRow(live({ runAlive: false }))).toEqual([])
  })

  it('renders nothing for a snapshot it did not build', () => {
    // Public, like both the other renderers, so it is handed whatever a caller has — and a
    // read-only view must not be the thing that throws, nor the thing that prints
    // `[object Object]` where a directory belongs.
    for (const snapshot of [undefined, null, 42, 'a path', {}, { worktree: 31 }, { worktree: {} }, { worktree: '' }]) {
      expect(renderWorktreeRow(snapshot), JSON.stringify(snapshot)).toEqual([])
    }
  })
})

describe('renderWorktreeRow — a path is a string that reached a terminal (#222)', () => {
  // It came from `lib/worktree.js`'s stdout, through bash, into a JSON file this view merely
  // reads — and `.ralph/run-state.json` is a file somebody can hand-edit (lib/run-state.qa.
  // test.js measures an ESC byte and a NUL surviving a write). So the same trust boundary the
  // issue title and the Jira key cross: the sequences taken WHOLE, every removed byte
  // becoming a space, the run collapsed, and a forged second row folded back into one cell.
  const hostile = {
    'a CSI colour sequence': ESC + '[31m/repo/.ralph/worktrees/issue-31' + ESC + '[0m',
    'an OSC that would retitle the window': ESC + ']0;pwned' + BEL + '/repo',
    'an unterminated CSI sequence': '/repo' + ESC + '[38;5;213',
    'a newline that would forge a queue row': '/repo' + LF + '  queue      99 waiting',
    'a carriage return that would overwrite the line': '/repo' + CR + 'ERASED',
    'a NUL byte': '/re' + NUL + 'po',
    'a backspace': '/re' + BS + 'po',
    'a DEL': '/re' + DEL + 'po',
    'a vertical tab': '/re' + VT + 'po',
    'a form feed that would clear the screen': '/re' + FF + 'po',
    'a bidi override that would reorder the line': '/repo' + cp(0x202e) + 'oper/' + cp(0x202c),
    'a line separator': '/re' + cp(0x2028) + 'po',
    'a paragraph separator': '/re' + cp(0x2029) + 'po',
    'a zero-width space': '/re' + cp(0x200b) + 'po',
    'a lone surrogate': '/re' + String.fromCharCode(0xd800) + 'po',
    'nothing but escapes': (ESC + '[0m').repeat(3),
  }

  for (const [label, worktree] of Object.entries(hostile)) {
    it(`prints no escape, no control character and no extra line for ${label}`, () => {
      const lines = renderWorktreeRow(live({ record: inFlightRecord({ worktree }) }))
      // At most one line, ever: a path that scrubs away to nothing is no path (the last
      // case), and one that survives is one row.
      expect(lines.length, label).toBeLessThanOrEqual(1)
      for (const line of lines) {
        expect(line, label).not.toMatch(/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Cf}]/u)
        expect(line, label).toMatch(/^ {2}worktree {3}\S/)
      }
    })
  }

  it('does NOT cut the path to the table’s title width — a truncated path names no directory', () => {
    // The one place this deliberately parts company with `cleanTitle`, which caps at 24
    // columns. A title is context and survives being shortened; a directory is an identity
    // and does not — `/Users/me/repos/ralph/.ralph/…` is a path a reader cannot cd into.
    // `row` truncates no value anyway: the `attach` row already interpolates a session name
    // of whatever length the repo's path produced.
    const deep = '/Users/someone/repos/a-rather-long-repository-name/.ralph/worktrees/issue-31'
    expect(deep.length).toBeGreaterThan(24)
    expect(renderWorktreeRow(live({ record: inFlightRecord({ worktree: deep }) }))).toEqual([
      `  worktree   ${deep}`,
    ])
  })

  it('bounds an absurd path before scrubbing it, without shortening a real one', () => {
    // The scrub is a handful of passes over a string whose length somebody else chose, so
    // the work is bounded first — the same reason `cleanTitle` bounds its input, and not a
    // column budget. The bound is far above any path a run can produce, because `PATH_MAX`
    // caps the pathname a syscall will accept (1024 on macOS here) and git could not have
    // printed a directory it cannot address; what it catches is a megabyte of text
    // hand-written into the record, which must not be walked five times and then drawn.
    const absurd = '/repo/' + 'x'.repeat(1_000_000)
    const [line] = renderWorktreeRow(live({ record: inFlightRecord({ worktree: absurd }) }))
    expect(line.length).toBeLessThan(5000)
    expect(line.startsWith('  worktree   /repo/xxx')).toBe(true)
  })
})

describe('toJsonSnapshot — the document names the same directory (#222)', () => {
  it('publishes `worktree` as the LAST key of tasks.current', () => {
    // Appended, like `task_key` before it (#132) and `digest` before that: a document grows
    // at the END, so a consumer reading it positionally sees the three fields it already
    // read, in the three places it read them, and then the new one.
    const doc = project()
    expect(Object.keys(doc.tasks.current)).toEqual(['number', 'started_at', 'task_key', 'worktree'])
    expect(doc.tasks.current.worktree).toBe(WORKTREE)
  })

  it('publishes the path the RECORD holds, verbatim — not the spelling the row renders', () => {
    // A machine surface, so the identity is neither scrubbed nor bounded: `JSON.stringify`
    // escapes everything a one-line document has to escape, and the only consumer of this
    // leaf is a script about to `cd` into the value. Exactly the asymmetry `run_id` and
    // `task_key` already carry — the terminal-safety pass belongs to the renderer, which is
    // where the sweep above measures it.
    const hostile = `/repo/.ralph/worktrees/issue-1${ESC}[31m` + LF + 'not-a-document'
    const doc = project({ record: inFlightRecord({ worktree: hostile }) })
    expect(doc.tasks.current.worktree).toBe(hostile)
    expect(JSON.stringify(doc)).not.toContain(LF)
    expect(JSON.stringify(doc).trimEnd().split('\n')).toHaveLength(1)
  })

  it('says null for a task with no worktree, and never drops the key', () => {
    // Present-and-null, this document's rule everywhere: `JSON.stringify` silently drops an
    // `undefined` leaf, so a key that comes and goes is a `jq` filter that works on one
    // repo and fails on another.
    for (const worktree of [undefined, null, '', '   ', 31, {}]) {
      const doc = project({ record: inFlightRecord({ worktree }) })
      expect(doc.tasks.current.worktree, String(worktree)).toBe(null)
      expect(JSON.stringify(doc), String(worktree)).toContain('"worktree":null')
    }
  })

  it('carries no tasks.current at all when nothing is in flight', () => {
    // The gate is the snapshot's own in-flight count, so a document saying `in_flight: 0`
    // can never name a directory beside it.
    const idle = toJsonSnapshot(live({ record: inFlightRecord(null) }), { mode: 'idle' })
    expect(idle.progress.in_flight).toBe(0)
    expect(idle.tasks.current).toBe(null)
  })
})
