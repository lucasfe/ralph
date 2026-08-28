import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { statusCommand } from './status.js'
import { buildProgress, toJsonSnapshot } from '../progress.js'
import { metricsPath } from '../issue-metrics.js'
import { formatHistoryEntry } from '../digest.js'

// QA augmentation for #58. The dev's status.json.test.js pins the four modes, the
// projection-equals-the-document identity and the CLI registration. What is
// attacked here is the promise the pipe depends on, driven END TO END through
// `statusCommand({ json: true })` rather than through the pure projection:
//
//   1. STDOUT IS THE DOCUMENT, AS BYTES. `ralph status --json | jq` is the whole
//      point, so stdout is asserted as a byte stream and not as "a line that
//      parses": exactly ONE write call, the first byte is `{`, exactly one `\n`
//      and it is the last byte, no ANSI anywhere (picocolors is a dependency of
//      this repo and four sibling commands import it), and JSON.parse over the
//      WHOLE buffer. Simulated TTY + FORCE_COLOR included, because that is when a
//      colour helper would start emitting escapes.
//   2. NOTHING GOES TO STDERR EITHER, and nothing goes to `console`. The command
//      has no `stderr` in its deps bag, which makes the absence of a diagnostic
//      load-bearing rather than incidental — so it is pinned twice: by patching
//      `process.stderr.write`/`console.*` around a real run, and by a
//      source-purity grep in the house style.
//   3. EXIT 0 WITH A PARSEABLE DOCUMENT WHILE THE WORLD IS BROKEN. gh absent, tmux
//      missing, `git rev-parse` failing outside a work tree, the metrics read
//      throwing, `peekLock` throwing, the folder count throwing, a record that is
//      an array or a bare string, an issues.jsonl truncated mid-append. A consumer
//      in a shell prompt cannot branch on a stack trace.
//   4. THE TWO SURFACES CANNOT DRIFT. One clock reading, one snapshot, one read of
//      each input — asserted by counting the calls with a clock that ADVANCES an
//      hour every time it is asked, so a second reading anywhere would change the
//      numbers and be caught rather than being invisible behind a frozen `now`.
//
// Hermetic like status.test.js: local Date constructors (the human line's `16:20`
// is a wall clock, so a UTC literal would make the suite timezone-dependent), an
// injected `now`, injected fs/exec/lock doubles, and an explicit `processEnv`.

const REPO = '/repo'
const SESSION = 'ralph-repo-live'
const RUN_ID = 'run-live'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime() // 3h12m in, 40min into #031
const RUN_FINISHED = new Date(2026, 7, 25, 14, 2, 0)

const MIN = 60000
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(ESC)

// UPDATED by the dev for #63, which adds the document's eighth section: the latest
// digest for the run in flight. It is APPENDED, so every `jq` filter written against
// the #58 document still resolves, and it is always present — `null` when there is no
// narration to report, per the unknown discipline. No fixture in this file supplies a
// `.ralph/digest.log`, so the section is null throughout and the pin here is about the
// KEY existing in the published shape rather than about any narration's content.
const TOP_KEYS = ['mode', 'run_id', 'progress', 'tasks', 'pace', 'eta', 'spend', 'digest']
const JQ_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const tagged = (row) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(row)
// The issue's worked example, scoped to the run the record names.
const METRICS = [
  tagged({ issue_number: 29, run_id: RUN_ID, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.1 }),
  tagged({ issue_number: 30, run_id: RUN_ID, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.75 }),
].join('\n')

const isMetrics = (p) => String(p).endsWith('issues.jsonl')

// A stream that records each write SEPARATELY, so "one JSON document" can be
// asserted as one write rather than as one line of a concatenated buffer.
function makeStream({ isTTY = false } = {}) {
  const writes = []
  return {
    isTTY,
    write: (s) => {
      writes.push(s)
      // A real stdout can answer false under backpressure and the command must
      // not care (it never waits for 'drain').
      return false
    },
    writes,
    output: () => writes.join(''),
    lines: () => writes.join('').split('\n').slice(0, -1),
  }
}

const runningRecord = (overrides = {}) => ({
  schema: 1,
  run_id: RUN_ID,
  session: SESSION,
  source: 'github',
  status: 'running',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
  ...overrides,
})

// endRun deliberately KEEPS `current` on a terminal record — it is the last task
// the run worked on. That is the contradiction the `record: live ? record : null`
// seam exists to prevent, so the idle fixture carries it.
const terminalRecord = (overrides = {}) => ({
  ...runningRecord(),
  status: 'partial',
  finished_at: RUN_FINISHED.toISOString(),
  ok: 2,
  failed: 1,
  ...overrides,
})

// An explicit sentinel for "the call resolves with nothing": a literal `undefined`
// would be swallowed by the destructuring defaults below.
const RESOLVES_UNDEFINED = Symbol('resolves undefined')

// Failure shapes are execa's, not invented ones: with `{ reject: false }` a missing
// binary comes back as `{ failed: true, exitCode: undefined }` and a timeout as
// `{ timedOut: true }`.
function makeExec({
  git = { exitCode: 0, stdout: REPO },
  tmux = { exitCode: 0 },
  gh = { exitCode: 0, stdout: '6' },
} = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git') return unwrap(git)
    if (cmd === 'tmux') return unwrap(tmux)
    if (cmd === 'gh') return unwrap(gh)
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

const deps = (overrides = {}) => {
  const stdout = overrides.stdout ?? makeStream()
  const reads = []
  const nowCalls = []
  const stateReads = []
  const folderCalls = []
  const base = {
    cwd: REPO,
    stdout,
    exec: makeExec(),
    exists: () => false, // no ralph.config.sh -> github, the default
    readFile: (p) => {
      reads.push(String(p))
      return isMetrics(p) ? METRICS : ''
    },
    readRunState: () => {
      stateReads.push(1)
      return runningRecord()
    },
    folderQueueCount: async (args) => {
      folderCalls.push(args)
      return 6
    },
    peekLock: () => null,
    now: () => {
      nowCalls.push(1)
      return NOW
    },
    processEnv: {},
    json: false,
    ...overrides,
  }
  base.reads = reads
  base.nowCalls = nowCalls
  base.stateReads = stateReads
  base.folderCalls = folderCalls
  return base
}

// The four modes as deps bags, so every sweep below can run all of them. `extra` is
// a FACTORY rather than an object: a shared stdout double would accumulate the four
// documents into one buffer and quietly defeat the one-write assertions below.
const modeCases = (extra = () => ({})) => [
  ['running', deps({ json: true, ...extra() })],
  ['interrupted', deps({ json: true, exec: makeExec({ tmux: { exitCode: 1 } }), ...extra() })],
  ['idle', deps({ json: true, readRunState: () => terminalRecord(), ...extra() })],
  ['never-run', deps({ json: true, readRunState: () => null, ...extra() })],
]

// stdout, held to the byte contract, and then parsed. This is the helper that makes
// `| jq` a tested property rather than an aspiration.
function documentOf(d, label = '') {
  const out = d.stdout.output()
  const where = label ? `${label}: ` : ''
  expect(d.stdout.writes.length, `${where}exactly one write reaches stdout`).toBe(1)
  expect(out.length, `${where}stdout is not empty`).toBeGreaterThan(0)
  expect(out[0], `${where}the document starts at byte 0`).toBe('{')
  expect(out.endsWith('\n'), `${where}the document is newline-terminated`).toBe(true)
  expect(out.slice(0, -1).includes('\n'), `${where}the document is ONE line`).toBe(false)
  expect(out, `${where}an ANSI escape would break every consumer`).not.toMatch(ANSI)
  let doc
  expect(() => {
    doc = JSON.parse(out)
  }, `${where}the whole buffer must parse: ${JSON.stringify(out.slice(0, 200))}`).not.toThrow()
  expect(Object.keys(doc), `${where}top-level keys`).toEqual(TOP_KEYS)
  return doc
}

// The unknown discipline, checked on the PARSED document a consumer actually sees.
function expectNoInventedNumbers(doc, label) {
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`))
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k))
    }
    expect(value, `${label}: ${path} is undefined`).not.toBe(undefined)
    if (typeof value === 'number') {
      expect(Number.isFinite(value), `${label}: ${path} = ${value}`).toBe(true)
    }
  }
  walk(doc, '')
}

describe('ralph status --json — stdout is one JSON document, as bytes (#58 QA)', () => {
  it('is a single write, a single line, `{`-first and newline-last, in all four modes', async () => {
    for (const [mode, d] of modeCases()) {
      const result = await statusCommand(d)
      expect(result.exitCode, mode).toBe(0)
      const doc = documentOf(d, mode)
      expect(doc.mode, mode).toBe(mode)
    }
  })

  it('emits no ANSI even with a TTY and FORCE_COLOR, where a colour helper would', async () => {
    // Four sibling commands import picocolors; this one must not, because a single
    // wrapped label would make the document unparseable for every consumer.
    for (const [mode, d] of modeCases(() => ({
      stdout: makeStream({ isTTY: true }),
      processEnv: { FORCE_COLOR: '3', TERM: 'xterm-256color', CI: 'true' },
    }))) {
      await statusCommand(d)
      const out = d.stdout.output()
      expect(out, `${mode} leaked an escape`).not.toMatch(ANSI)
      expect(out, `${mode} leaked a CSI sequence`).not.toContain('[3')
      documentOf(d, mode)
    }
  })

  it('writes nothing to stderr and never reaches for console, in any mode', async () => {
    // There is no `stderr` in the deps bag, so a diagnostic would have to escape
    // through the ambient process — which is exactly what a `| jq` consumer with
    // `2>&1` would then choke on. Patched around a real run, not just grepped.
    const realStderrWrite = process.stderr.write
    const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info }
    const stderrChunks = []
    const consoleCalls = []
    try {
      process.stderr.write = (chunk) => {
        stderrChunks.push(String(chunk))
        return true
      }
      for (const key of Object.keys(realConsole)) {
        console[key] = (...args) => consoleCalls.push([key, ...args])
      }
      for (const [, d] of modeCases()) await statusCommand(d)
      // ...and once more with every dependency in the world failing at the same
      // time, which is when a command is most tempted to explain itself.
      await statusCommand(
        deps({
          json: true,
          exec: makeExec({ git: { exitCode: 1 }, tmux: { failed: true }, gh: { failed: true } }),
          readFile: () => {
            throw new Error('EACCES: permission denied, open issues.jsonl')
          },
          peekLock: () => {
            throw new Error('EACCES: permission denied, open lock')
          },
        }),
      )
    } finally {
      process.stderr.write = realStderrWrite
      Object.assign(console, realConsole)
    }
    expect(stderrChunks).toEqual([])
    expect(consoleCalls).toEqual([])
  })

  it('keeps a hostile run id from breaking the one-line contract', async () => {
    // run-state.json is JSON somebody else wrote, and the run id is copied into the
    // document verbatim. A raw newline would split the document in two and a raw
    // ESC would colour the consumer's terminal; JSON string escaping must handle
    // both without the command sanitizing the name away.
    const hostile = `run-${ESC}[31mred${ESC}[0m\nnot-a-document\t"quoted"\\`
    const d = deps({ json: true, readRunState: () => runningRecord({ run_id: hostile }) })
    await statusCommand(d)
    const doc = documentOf(d, 'hostile run id')
    expect(doc.run_id).toBe(hostile)
  })

  it('parses under `jq`-style whole-buffer reads for a 2 MiB issues.jsonl', async () => {
    // The loop is appending to this file while the command reads it, so the read
    // can return megabytes of untagged agent output with the rows at the end.
    const junk = 'npm WARN deprecated foo@1.0.0\n'.repeat(70000)
    const d = deps({ json: true, readFile: (p) => (isMetrics(p) ? junk + METRICS + '\n' : '') })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    const doc = documentOf(d, '2 MiB file')
    expect(doc.pace.per_task_min).toBe(84)
  })
})

describe('ralph status --json — a hostile issues.jsonl, end to end (#58 QA)', () => {
  // The pure module's guards are attacked in lib/progress.json.qa.test.js; what is
  // pinned here is that the SHELL cannot smuggle a bad value past them — the read,
  // the run scoping and the queue count are its job, and every one of them is
  // reachable from untrusted append-only text.
  const files = {
    'a blank file': '',
    'blank lines only': '\n\n\n',
    'untagged agent output': 'npm WARN deprecated foo@1.0.0\n==> Iteration for issue #29\n',
    'a last line truncated mid-append': `${METRICS}\nRALPH_ISSUE_EVENT {"issue_number":31,"run_id":"${RUN_ID}"`,
    'a JSON array payload': 'RALPH_ISSUE_EVENT [{"duration_ms":999999999}]\n' + METRICS,
    'a JSON string payload': 'RALPH_ISSUE_EVENT "x"\n' + METRICS,
    'a JSON null payload': 'RALPH_ISSUE_EVENT null\n' + METRICS,
    'a bare NaN literal JSON rejects': `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","duration_ms":NaN}\n` + METRICS,
    'duration_ms as a string of digits': `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":"5820000"}`,
    'a negative duration_ms': `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":-5820000}`,
    'duration_ms as -0': `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":-0}`,
    'two durations at 1e308': [
      `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":1e308}`,
      `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":2,"duration_ms":1e308}`,
    ].join('\n'),
    'total_cost_usd as a string': `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":5040000,"total_cost_usd":"34.10"}`,
    'total_cost_usd as an object': `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":5040000,"total_cost_usd":{}}`,
    'two costs that overflow their own sum': [
      `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":5040000,"total_cost_usd":1e308}`,
      `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":2,"duration_ms":5040000,"total_cost_usd":1e308}`,
    ].join('\n'),
    'rows belonging entirely to another run': [
      tagged({ issue_number: 90, run_id: 'run-old', ts: 1, duration_ms: 40 * MIN, total_cost_usd: 500 }),
      tagged({ issue_number: 91, run_id: 'run-old', ts: 2, duration_ms: 80 * MIN, total_cost_usd: 500 }),
    ].join('\n'),
    'a __proto__ payload': `RALPH_ISSUE_EVENT {"__proto__":{"duration_ms":999999999,"run_id":"${RUN_ID}"}}\n` + METRICS,
    'CRLF line endings': METRICS.split('\n').join('\r\n') + '\r\n',
    'no trailing newline': METRICS,
  }

  for (const [label, text] of Object.entries(files)) {
    it(`emits a parseable document with no invented number for ${label}`, async () => {
      const d = deps({ json: true, readFile: (p) => (isMetrics(p) ? text : '') })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      const doc = documentOf(d, label)
      expectNoInventedNumbers(doc, label)
      expect(doc.mode, label).toBe('running')
      // A cost that was not a measurement must never surface as a free run.
      if (doc.spend.usd === 0) expect.fail(`${label}: spend.usd is 0, which reads as a free run`)
    })
  }

  it('never lets another run’s spend become this run’s, in the document', async () => {
    const otherRun = [
      tagged({ issue_number: 90, run_id: 'run-old', ts: 1, duration_ms: 40 * MIN, total_cost_usd: 500 }),
      tagged({ issue_number: 91, run_id: 'run-old', ts: 2, duration_ms: 80 * MIN, total_cost_usd: 500 }),
    ].join('\n')
    const d = deps({ json: true, readFile: (p) => (isMetrics(p) ? otherRun : '') })
    await statusCommand(d)
    const doc = documentOf(d)
    expect(doc.progress.completed).toBe(0)
    expect(doc.spend).toEqual({ usd: null, per_task_usd: null, projected_usd: null })
    // ...but those rows are still history, so the all-time pace stands.
    expect(doc.pace).toEqual({
      basis: 'all-time',
      per_task_min: 60,
      fastest_min: 40,
      slowest_min: 80,
      samples: 2,
    })
  })

  it('says null, not Infinity, when a five-figure queue meets an absurd pace', async () => {
    // Both magnitudes pass their own finite check; the PRODUCT is what overflows,
    // and `"remaining_min": null` is how a document says it will not guess.
    const d = deps({
      json: true,
      exec: makeExec({ gh: { exitCode: 0, stdout: '99999' } }),
      readFile: (p) =>
        isMetrics(p)
          ? [
              `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":1e308}`,
              `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":2,"duration_ms":1e308}`,
            ].join('\n')
          : '',
    })
    await statusCommand(d)
    const doc = documentOf(d)
    expect(doc.progress.remaining).toBe(99999)
    expect(doc.eta).toEqual({
      remaining_min: null,
      finish_at: null,
      range_min: null,
      basis: 'unknown',
    })
  })

  const queues = {
    'gh printed a rate-limit message': { exitCode: 0, stdout: 'API rate limit exceeded' },
    'gh printed nothing': { exitCode: 0, stdout: '' },
    'gh printed whitespace': { exitCode: 0, stdout: '   \n ' },
    'gh printed a quoted number': { exitCode: 0, stdout: '"6"' },
    'gh printed a number too large for a double': { exitCode: 0, stdout: '1e400' },
    'gh printed a negative count': { exitCode: 0, stdout: '-5' },
    'gh exited non-zero': { exitCode: 1, stdout: '', stderr: 'gh: not authenticated' },
    'gh is not installed': { failed: true },
    'gh timed out': { timedOut: true, failed: true },
    'gh answered with nothing at all': RESOLVES_UNDEFINED,
  }

  for (const [label, gh] of Object.entries(queues)) {
    it(`degrades the denominator to null — never 0 — when ${label}`, async () => {
      const d = deps({ json: true, exec: makeExec({ gh }) })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      const doc = documentOf(d, label)
      expectNoInventedNumbers(doc, label)
      if (label === 'gh printed a negative count') {
        // A negative depth is nonsense a corrupt count can produce; it clamps to an
        // empty queue rather than shortening the ETA below the in-flight remainder.
        expect(doc.progress.remaining).toBe(0)
      } else {
        expect(doc.progress.remaining, label).toBe(null)
        expect(doc.progress.total, label).toBe(null)
        expect(doc.eta.remaining_min, label).toBe(null)
        expect(doc.spend.projected_usd, label).toBe(null)
      }
      // The measured facts survive a failed count either way.
      expect(doc.pace.per_task_min, label).toBe(84)
      expect(doc.spend.usd, label).toBeCloseTo(62.85, 5)
    })
  }
})

describe('ralph status --json — a corrupt run-state record, end to end (#58 QA)', () => {
  // run-state.json is written by the bash loop and can be edited, truncated or
  // written by an older/newer version. `readRunState` already refuses to throw, so
  // whatever it hands back has to produce a document rather than a stack trace.
  const records = {
    'an empty object': {},
    'only a status': { status: 'running' },
    'an array': [],
    'an array of records': [{ status: 'running' }],
    'a bare string': 'running',
    'a number': 42,
    'current with no number': { status: 'running', run_id: RUN_ID, current: { started_at: TASK_STARTED.toISOString() } },
    'a task number that is a string': {
      status: 'running',
      run_id: RUN_ID,
      current: { number: '31', started_at: TASK_STARTED.toISOString() },
    },
    'a task number that is an object': {
      status: 'running',
      run_id: RUN_ID,
      current: { number: { n: 31 }, started_at: TASK_STARTED.toISOString() },
    },
    'current as a string': { status: 'running', run_id: RUN_ID, current: 'issue 31' },
    'current as an array': { status: 'running', run_id: RUN_ID, current: [31] },
    'current as an empty object': { status: 'running', run_id: RUN_ID, current: {} },
    'an unparseable started_at on the task': {
      status: 'running',
      run_id: RUN_ID,
      current: { number: 31, started_at: 'yesterday' },
    },
    'a started_at in the future on the task': {
      status: 'running',
      run_id: RUN_ID,
      current: { number: 31, started_at: new Date(NOW + 600 * MIN).toISOString() },
    },
    'a numeric started_at on the task': {
      status: 'running',
      run_id: RUN_ID,
      current: { number: 31, started_at: TASK_STARTED.getTime() },
    },
    'a run id that is a number': { status: 'running', run_id: 20260826, current: null },
    'a run id that is the empty string': { status: 'running', run_id: '', current: null },
    'a run id that is null': { status: 'running', run_id: null, current: null },
    'a run id that is an object': { status: 'running', run_id: {}, current: null },
    'a run id that is an array': { status: 'running', run_id: [RUN_ID], current: null },
    'a status nobody defined': { status: 'weird-new-status', run_id: RUN_ID, current: { number: 31 } },
    'a schema from the future': { schema: 99, status: 'running', run_id: RUN_ID, current: null },
    'an unparseable run started_at': { status: 'running', run_id: RUN_ID, started_at: 'yesterday' },
  }

  for (const [label, record] of Object.entries(records)) {
    it(`emits a parseable document and exits 0 for ${label}`, async () => {
      const d = deps({ json: true, readRunState: () => record })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      const doc = documentOf(d, label)
      expectNoInventedNumbers(doc, label)
      expect(['running', 'interrupted', 'idle', 'never-run'], label).toContain(doc.mode)
      // A run id is a NAME: a string or null, never a number in some records and a
      // string in others, so a consumer keyed on it never compares two types.
      expect(doc.run_id === null || typeof doc.run_id === 'string', `${label}: run_id`).toBe(true)
      // And the in-flight count can never contradict the task it names.
      expect(doc.tasks.current !== null, `${label}: in_flight=${doc.progress.in_flight}`).toBe(
        doc.progress.in_flight === 1,
      )
    })
  }

  it('types a numeric run id as a string, so a consumer never sees two types', async () => {
    const d = deps({ json: true, readRunState: () => runningRecord({ run_id: 20260826 }) })
    await statusCommand(d)
    expect(documentOf(d).run_id).toBe('20260826')
  })
})

describe('ralph status --json — the `record: live ? record : null` seam (#58 QA)', () => {
  it('never names a task in flight for a run that has ended', async () => {
    // endRun KEEPS `current` on a terminal record, so this is the contradiction the
    // seam exists to prevent — and it is the one a status line would render as "still
    // working on #031" hours after the run stopped. Swept over every terminal status.
    for (const status of ['success', 'partial', 'failed', 'aborted', 'weird-new-status']) {
      const d = deps({ json: true, readRunState: () => terminalRecord({ status }) })
      await statusCommand(d)
      const doc = documentOf(d, status)
      expect(doc.mode, status).toBe('idle')
      expect(doc.progress.in_flight, status).toBe(0)
      expect(doc.tasks.current, status).toBe(null)
      // ...and the ended run's history is not counted as this reading's progress.
      expect(doc.progress.completed, status).toBe(0)
      // The run is still NAMED, though: a consumer keyed on run identity needs it.
      expect(doc.run_id, status).toBe(RUN_ID)
    }
  })

  it('holds "in_flight 0 implies no named task" in every mode at once', async () => {
    for (const [mode, d] of modeCases()) {
      await statusCommand(d)
      const doc = documentOf(d, mode)
      if (doc.progress.in_flight === 0) expect(doc.tasks.current, mode).toBe(null)
      if (doc.tasks.current !== null) expect(doc.progress.in_flight, mode).toBe(1)
    }
  })

  it('measures nothing at all for an idle run, rather than an ended run’s totals', async () => {
    // The seam withholds the record AND the measurements from the snapshot for these
    // two modes, so the document is the all-unknown reading they deserve — in ONE
    // shape, not a second one. #59 changed what the HUMAN view does with an idle repo
    // (it now reads the metrics and counts the queue to print a report card) and
    // deliberately left this document exactly as #58 published it: a key in a released
    // document is the one thing that cannot be taken back, so publishing an ended run's
    // outcome is its own change with its own keys. The I/O half of this property now
    // belongs to never-run alone, and is asserted below.
    for (const [label, readRunState] of [
      ['idle', () => terminalRecord()],
      ['never-run', () => null],
    ]) {
      const d = deps({ json: true, readRunState })
      await statusCommand(d)
      const doc = documentOf(d, label)
      expect(doc.progress, label).toEqual({ completed: 0, in_flight: 0, remaining: null, total: null })
      expect(doc.pace, label).toEqual({
        basis: 'unknown',
        per_task_min: null,
        fastest_min: null,
        slowest_min: null,
        samples: 0,
      })
      expect(doc.eta, label).toEqual({
        remaining_min: null,
        finish_at: null,
        range_min: null,
        basis: 'unknown',
      })
      expect(doc.spend, label).toEqual({ usd: null, per_task_usd: null, projected_usd: null })
    }
  })

  it('spends nothing measuring a never-run repo, under the flag as without it', async () => {
    // The mode with no record: no metrics read, no queue count, no config read to
    // choose between the two counters. Its document is all-unknown because there is
    // nothing to know, not because a seam withheld it.
    const d = deps({ json: true, readRunState: () => null })
    await statusCommand(d)
    expect(documentOf(d).mode).toBe('never-run')
    expect(d.reads).toEqual([])
    expect(d.exec.of('gh').length).toBe(0)
    expect(d.folderCalls).toEqual([])
  })
})

describe('ralph status --json — exit 0 while the world is broken (#58 QA)', () => {
  const worlds = {
    'git rev-parse fails (cwd outside a work tree)': { exec: makeExec({ git: { exitCode: 1 } }) },
    'git rev-parse is not installed': { exec: makeExec({ git: { failed: true } }) },
    'git rev-parse answers with nothing': { exec: makeExec({ git: RESOLVES_UNDEFINED }) },
    'tmux is not installed': { exec: makeExec({ tmux: { failed: true } }) },
    'tmux answers with nothing': { exec: makeExec({ tmux: RESOLVES_UNDEFINED }) },
    'the metrics read throws': {
      readFile: () => {
        throw new Error('EACCES: permission denied, open issues.jsonl')
      },
    },
    'the metrics read throws a string': {
      readFile: () => {
        throw 'EISDIR'
      },
    },
    'the metrics read answers with an object whose toString throws': {
      readFile: (p) =>
        isMetrics(p)
          ? {
              toString: () => {
                throw new Error('no')
              },
            }
          : '',
    },
    'the config read throws': {
      exists: () => {
        throw new Error('EACCES: permission denied, stat')
      },
    },
    'peekLock throws': {
      peekLock: () => {
        throw new Error('EACCES: permission denied, open .ralph/cycle.lock')
      },
      exec: makeExec({ tmux: { exitCode: 1 } }),
    },
    'peekLock reports a live cycle run with no tmux session': {
      peekLock: () => ({ alive: true, pid: 4242 }),
      exec: makeExec({ tmux: { exitCode: 1 } }),
    },
    'the folder queue count throws': {
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="folder"\n' : METRICS),
      folderQueueCount: async () => {
        throw new Error('EACCES: permission denied, scandir')
      },
    },
    'the folder queue count answers with a string': {
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="folder"\n' : METRICS),
      folderQueueCount: async () => '4',
    },
    'every dependency fails at once': {
      exec: makeExec({ git: { failed: true }, tmux: { failed: true }, gh: { failed: true } }),
      exists: () => {
        throw new Error('EACCES')
      },
      readFile: () => {
        throw new Error('EISDIR: illegal operation on a directory')
      },
      folderQueueCount: async () => {
        throw new Error('EACCES')
      },
      peekLock: () => {
        throw new Error('EACCES')
      },
    },
  }

  for (const [label, overrides] of Object.entries(worlds)) {
    it(`still prints one parseable document and exits 0 when ${label}`, async () => {
      const d = deps({ json: true, ...overrides })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      const doc = documentOf(d, label)
      expectNoInventedNumbers(doc, label)
      expect(['running', 'interrupted', 'idle', 'never-run'], label).toContain(doc.mode)
      // A stack trace, an errno or a prose warning on stdout is what a `| jq`
      // consumer cannot recover from — and there is no stderr to divert it to.
      const out = d.stdout.output()
      for (const leak of ['EACCES', 'EISDIR', 'Error', ' at ', 'permission denied']) {
        expect(out, `${label} leaked "${leak}"`).not.toContain(leak)
      }
    })
  }

  it('exits 0 for every mode in the broken world, with the discriminator intact', async () => {
    const wrecked = {
      exec: makeExec({ git: { failed: true }, tmux: { failed: true }, gh: { failed: true } }),
      readFile: () => {
        throw new Error('EACCES')
      },
      peekLock: () => {
        throw new Error('EACCES')
      },
    }
    const cases = [
      ['interrupted', deps({ json: true, ...wrecked })],
      ['idle', deps({ json: true, ...wrecked, readRunState: () => terminalRecord() })],
      ['never-run', deps({ json: true, ...wrecked, readRunState: () => null })],
      [
        'running',
        deps({
          json: true,
          ...wrecked,
          exec: makeExec({ git: { failed: true }, tmux: { exitCode: 0 }, gh: { failed: true } }),
        }),
      ],
    ]
    for (const [mode, d] of cases) {
      const result = await statusCommand(d)
      expect(result.exitCode, mode).toBe(0)
      expect(result.mode, mode).toBe(mode)
      expect(documentOf(d, mode).mode, mode).toBe(mode)
    }
  })
})

describe('ralph status --json — one clock, one snapshot, no drift (#58 QA)', () => {
  it('reads the clock exactly once, flag or no flag', async () => {
    // Two readings would let the human view and the document disagree, and would
    // make the ETA and the finish time describe different instants.
    for (const json of [true, false]) {
      const d = deps({ json })
      await statusCommand(d)
      expect(d.nowCalls.length, `json=${json}`).toBe(1)
    }
  })

  it('uses the FIRST reading even when the clock advances an hour per call', async () => {
    // A frozen `now` cannot catch a second reading. This one moves, so a document
    // built from a later reading would carry a different finish time and be caught.
    let call = 0
    const advancing = () => NOW + call++ * 3600000
    const d = deps({ json: true, now: advancing })
    await statusCommand(d)
    const doc = documentOf(d)
    const record = runningRecord()
    expect(doc).toEqual(
      toJsonSnapshot(buildProgress({ metricsText: METRICS, record, queue: 6, now: NOW }), {
        mode: 'running',
        record,
      }),
    )
    expect(Date.parse(doc.eta.finish_at)).toBe(NOW + 548 * MIN)
  })

  it('reports the same numbers the human view prints, from the same inputs', async () => {
    // The no-drift property stated as a comparison: the JSON and the human run see
    // identical deps, so every number that appears in both must agree.
    const jsonDeps = deps({ json: true })
    await statusCommand(jsonDeps)
    const doc = documentOf(jsonDeps)

    const humanDeps = deps()
    await statusCommand(humanDeps)
    const human = humanDeps.stdout.output()
    expect(human).toContain(`~${doc.pace.per_task_min} min/task`)
    expect(human).toContain(`${doc.progress.remaining} waiting`)
    expect(human).toContain(`$${doc.spend.usd.toFixed(2)} so far`)
    expect(human).toContain(`#0${doc.tasks.current.number} `)
    // The document's UTC instant and the human line's local clock are the SAME
    // instant, read off one snapshot.
    const finish = new Date(Date.parse(doc.eta.finish_at))
    const clock = `${String(finish.getHours()).padStart(2, '0')}:${String(finish.getMinutes()).padStart(2, '0')}`
    expect(human).toContain(`→ ~${clock}`)
  })

  it('does not double-count a single read, a single probe or a single count', async () => {
    // `--json` is an extra RENDERER, not an extra pass: a user running this in a
    // shell prompt pays for one gh count either way.
    //
    // #56 made the two exec sequences differ, in the direction that costs the DOCUMENT
    // nothing: the human table labels its rows with issue titles, which is a second
    // `gh issue list`, and `--json` never makes it because the `tasks` array publishes
    // numbers and no title at all (#58's keys, unchanged). So the sequences are compared
    // as the human's minus exactly that call — not by a looser rule, which would also
    // pass if `--json` had quietly gained a second count of its own.
    const isTitleCall = (c) => c.args.includes('--state')
    const keys = (calls) => calls.map((c) => c.key)

    const jsonDeps = deps({ json: true })
    await statusCommand(jsonDeps)
    const humanDeps = deps()
    await statusCommand(humanDeps)

    expect(jsonDeps.reads).toEqual(humanDeps.reads)
    expect(jsonDeps.reads.filter(isMetrics).length).toBe(1)
    expect(jsonDeps.reads).toContain(metricsPath(REPO))
    expect(keys(jsonDeps.exec.calls)).toEqual(keys(humanDeps.exec.calls.filter((c) => !isTitleCall(c))))
    expect(jsonDeps.exec.calls.filter(isTitleCall)).toEqual([])
    expect(humanDeps.exec.calls.filter(isTitleCall).length).toBe(1)
    expect(jsonDeps.exec.of('gh').length).toBe(1)
    expect(jsonDeps.exec.of('tmux').length).toBe(1)
    expect(jsonDeps.stateReads.length).toBe(1)
    expect(humanDeps.stateReads.length).toBe(1)
  })

  it('never writes anything: every subprocess it runs is a read', async () => {
    const d = deps({ json: true })
    await statusCommand(d)
    for (const call of d.exec.calls) {
      expect(call.key).toMatch(/^(git rev-parse|tmux has-session|gh issue list)/)
      expect(call.options.shell, call.key).toBe(undefined)
    }
  })

  it('emits a jq-parseable finish_at from a corrupt duration_ms, end to end', async () => {
    // The overflow guard turns 1e308 into a null, but a `duration_ms` of 1e14 is a
    // finite positive number that passes every sample guard — and six waiting tasks
    // at that pace put the finish time outside the four-digit-year calendar, where
    // `toISOString` switches to the ISO-8601 expanded form. `jq`'s `fromdate`
    // errors on that shape, so a status line driven off this document breaks on a
    // single corrupt line of untrusted append-only text.
    const absurd = [
      `RALPH_ISSUE_EVENT {"issue_number":29,"run_id":"${RUN_ID}","ts":1,"duration_ms":1e14}`,
      `RALPH_ISSUE_EVENT {"issue_number":30,"run_id":"${RUN_ID}","ts":2,"duration_ms":1e14}`,
    ].join('\n')
    const d = deps({ json: true, readFile: (p) => (isMetrics(p) ? absurd : '') })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    const doc = documentOf(d)
    expect(doc.eta.remaining_min).not.toBe(null)
    expect(doc.eta.finish_at, `finish_at = ${doc.eta.finish_at}`).toMatch(JQ_INSTANT)
  })

  it('emits a jq-parseable instant in every mode that has one at all', async () => {
    for (const [mode, d] of modeCases()) {
      await statusCommand(d)
      const doc = documentOf(d, mode)
      for (const [path, value] of [
        ['eta.finish_at', doc.eta.finish_at],
        ['tasks.current.started_at', doc.tasks.current?.started_at ?? null],
      ]) {
        if (value == null) continue
        expect(value, `${mode}: ${path}`).toMatch(JQ_INSTANT)
      }
    }
  })
})

describe('ralph status --json — the flag surface itself (#58 QA)', () => {
  it('leaves the human view byte-identical for every falsy spelling of the flag', async () => {
    // `--json` is an addition. Omitted, undefined, false, 0 and '' must all be the
    // view every #55/#57 test pins — byte for byte, not merely "similar".
    const baseline = deps()
    delete baseline.json
    await statusCommand(baseline)
    const expected = baseline.stdout.output()
    expect(expected).toContain('▸ ralph — running')
    expect(expected).not.toContain('{')

    for (const json of [undefined, false, 0, '', null, NaN]) {
      const d = deps({ json })
      await statusCommand(d)
      expect(d.stdout.output(), `json=${String(json)}`).toBe(expected)
    }
  })

  it('prints the document instead of the view for a truthy flag, never both', async () => {
    for (const json of [true, 1, 'yes', {}]) {
      const d = deps({ json })
      const result = await statusCommand(d)
      expect(result.exitCode, String(json)).toBe(0)
      const doc = documentOf(d, `json=${String(json)}`)
      expect(doc.mode, String(json)).toBe('running')
      const out = d.stdout.output()
      for (const human of ['▸', 'in flight', 'min/task', 'waiting', 'tmux attach', 'ralph stop']) {
        expect(out, `json=${String(json)} leaked "${human}"`).not.toContain(human)
      }
    }
  })

  it('returns the same result object with and without the flag', async () => {
    // bin/ralph.js exits on `result.exitCode`, and the mode/queue are what a
    // programmatic caller reads. The renderer must not change any of them.
    const jsonDeps = deps({ json: true })
    const withJson = await statusCommand(jsonDeps)
    const withoutJson = await statusCommand(deps())
    expect(withJson.exitCode).toBe(withoutJson.exitCode)
    expect(withJson.mode).toBe(withoutJson.mode)
    expect(withJson.queue).toBe(withoutJson.queue)
    expect(withJson.record).toEqual(withoutJson.record)
  })
})

describe('status.js — no diagnostic channel exists to leak into stdout (#58 QA)', () => {
  // Source-purity in the house style: the reason nothing lands on stdout beside the
  // document is not care at the call site, it is that this file has no way to write
  // anywhere else. Comments are stripped first, because the module's own prose
  // names `stderr` and `console` in order to promise it does not use them.
  const SOURCE = readFileSync(new URL('./status.js', import.meta.url), 'utf8')
  const CODE = SOURCE.split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n')

  const bodyOf = (name) => {
    const start = CODE.indexOf(`export async function ${name}(`)
    expect(start, `${name} must be exported`).toBeGreaterThan(-1)
    const end = CODE.indexOf('\n}\n', start)
    return CODE.slice(start, end)
  }

  it('has no console, no stderr and no colour helper anywhere', () => {
    for (const forbidden of [/console\./, /process\.stderr/, /\bstderr\b/, /picocolors/, /\bpc\./]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('writes to exactly one stream, through exactly one call site', () => {
    expect(CODE.match(/\.write\(/g)).toHaveLength(1)
  })

  it('builds one snapshot from one clock reading and serializes it once', () => {
    // The clock and the snapshot live in the GATHERER since #61, which is what
    // makes them shared with `ralph digest` rather than merely shared between this
    // file's two renderers — but the property is unchanged and still counted: one
    // reading, one snapshot, and one projection/serialization in the renderer that
    // prints it.
    const gather = bodyOf('collectStatus')
    expect(gather.match(/\bnow\(\)/g), 'one clock reading').toHaveLength(1)
    expect(gather.match(/buildProgress\(/g), 'one snapshot').toHaveLength(1)
    const body = bodyOf('statusCommand')
    expect(body.match(/\bnow\(\)/g), 'the renderer reads no clock of its own').toBe(null)
    expect(body.match(/buildProgress\(/g), 'the renderer builds no snapshot').toBe(null)
    expect(body.match(/toJsonSnapshot\(/g), 'one projection').toHaveLength(1)
    expect(body.match(/JSON\.stringify\(/g), 'one serialization').toHaveLength(1)
  })

  it('has no second serializer: the document comes from the projection alone', () => {
    // A hand-rolled object literal, a second parse of issues.jsonl or a `toFixed`
    // in the shell would be a second policy free to drift from the terminal view.
    const body = bodyOf('statusCommand')
    for (const forbidden of [/RALPH_ISSUE_EVENT/, /parseIssueEvents/, /toFixed/, /renderProgress\(/]) {
      expect(body, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('returns immediately after the document, before the human renderer runs', () => {
    const body = bodyOf('statusCommand')
    expect(body.indexOf('toJsonSnapshot(')).toBeLessThan(body.indexOf('renderStatus({'))
  })
})

// ---------------------------------------------------------------------------
// Round 2. The expanded-year leak reported above was fixed by clamping the DERIVED
// instant into the four-digit-year calendar (a transcribed one range-checks and reads
// null instead — see the last test in this block). The clamp's edges are attacked in
// lib/progress.json.qa.test.js; what is checked HERE is the invariant the fix claims
// for a consumer, which is a statement about the whole command and not about a pure
// function: `eta.finish_at` is null only when there is no ETA at all, and is
// otherwise ALWAYS an instant `jq fromdate` accepts. That biconditional cannot be
// tested in the pure module, because `buildProgress` also nulls the finish when the
// CLOCK is unusable — and only the shell can promise the clock is `Date.now()`.
// ---------------------------------------------------------------------------

const CEIL_INSTANT = '9999-12-31T23:59:59Z'

describe('ralph status --json — finish_at is null only when there is no ETA (#58 QA round 2)', () => {
  // The one biconditional a status line can be written against. Both halves matter:
  // a null finish beside a known `remaining_min` would make the field untrustworthy
  // (a consumer would have to fall back to the minutes and reformat them itself), and
  // a non-null finish beside an unknown ETA would be a fabricated instant.
  const expectEtaAgreement = (doc, label) => {
    expect(
      doc.eta.finish_at === null,
      `${label}: remaining_min = ${doc.eta.remaining_min} but finish_at = ${JSON.stringify(doc.eta.finish_at)}`,
    ).toBe(doc.eta.remaining_min === null)
    if (doc.eta.finish_at !== null) {
      expect(doc.eta.finish_at, `${label}: not a jq instant`).toMatch(JQ_INSTANT)
    }
  }

  it('holds in all four modes', async () => {
    for (const [mode, d] of modeCases()) {
      await statusCommand(d)
      expectEtaAgreement(documentOf(d, mode), mode)
    }
  })

  const worlds = {
    'a metrics read that throws': {
      readFile: () => {
        throw new Error('EACCES: permission denied, open issues.jsonl')
      },
    },
    'gh missing, so the queue is unknown': { exec: makeExec({ gh: { failed: true } }) },
    'gh answering with something unparseable': { exec: makeExec({ gh: { exitCode: 0, stdout: 'six' } }) },
    'an empty history': { readFile: () => '' },
    'a queue of zero': { exec: makeExec({ gh: { exitCode: 0, stdout: '0' } }) },
    'a five-figure queue': { exec: makeExec({ gh: { exitCode: 0, stdout: '99999' } }) },
    'a pace that overflows the queue product': {
      readFile: (p) =>
        isMetrics(p)
          ? [
              `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":1e308}`,
              `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":2,"duration_ms":1e308}`,
            ].join('\n')
          : '',
    },
    'a pace far past the end of the calendar': {
      readFile: (p) =>
        isMetrics(p)
          ? [
              `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":1e14}`,
              `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":2,"duration_ms":1e14}`,
            ].join('\n')
          : '',
    },
    'a negative pace': {
      readFile: (p) => (isMetrics(p) ? `RALPH_ISSUE_EVENT {"run_id":"${RUN_ID}","ts":1,"duration_ms":-1e14}` : ''),
    },
    'a truncated last line': {
      readFile: (p) => (isMetrics(p) ? `${METRICS}\nRALPH_ISSUE_EVENT {"run_id":"${RUN_ID}"` : ''),
    },
    'a record that is an array': { readRunState: () => [] },
    'a record with no run id': { readRunState: () => runningRecord({ run_id: undefined }) },
  }

  for (const [label, overrides] of Object.entries(worlds)) {
    it(`holds with ${label}`, async () => {
      const d = deps({ json: true, ...overrides })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      const doc = documentOf(d, label)
      expectEtaAgreement(doc, label)
      expectNoInventedNumbers(doc, label)
    })
  }

  it('keeps the magnitude when the instant saturates, across five orders of pace', async () => {
    // The trade the fix makes: the instant saturates at the edge of the format, and
    // `remaining_min` beside it keeps the honest magnitude. So the minutes must keep
    // GROWING after the instant has stopped, and the instant must never go backwards
    // — a consumer sorting two documents relies on later never reading as earlier.
    const seen = []
    for (const durationMs of [1e12, 1e13, 1e14, 1e15, 1e16, 1e17]) {
      const text = [
        `RALPH_ISSUE_EVENT {"issue_number":29,"run_id":"${RUN_ID}","ts":1,"duration_ms":${durationMs}}`,
        `RALPH_ISSUE_EVENT {"issue_number":30,"run_id":"${RUN_ID}","ts":2,"duration_ms":${durationMs}}`,
      ].join('\n')
      const d = deps({ json: true, readFile: (p) => (isMetrics(p) ? text : '') })
      expect((await statusCommand(d)).exitCode, `duration_ms = ${durationMs}`).toBe(0)
      const doc = documentOf(d, `duration_ms = ${durationMs}`)
      expect(doc.eta.finish_at, `duration_ms = ${durationMs}`).toMatch(JQ_INSTANT)
      expect(doc.eta.remaining_min, `duration_ms = ${durationMs}`).toBeGreaterThan(0)
      seen.push([durationMs, doc.eta.remaining_min, Date.parse(doc.eta.finish_at)])
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][1], `minutes stopped growing at duration_ms = ${seen[i][0]}`).toBeGreaterThan(
        seen[i - 1][1],
      )
      expect(seen[i][2], `the instant went backwards at duration_ms = ${seen[i][0]}`).toBeGreaterThanOrEqual(
        seen[i - 1][2],
      )
    }
    // The first pace still lands inside the calendar; the biggest is saturated. If
    // BOTH ends clamped, the sweep would prove nothing about the honest path.
    expect(seen[0][2], 'a year-2160 finish must not be clamped').toBeLessThan(Date.parse(CEIL_INSTANT))
    expect(seen.at(-1)[2], 'an absurd pace must saturate').toBe(Date.parse(CEIL_INSTANT))
  })

  it('types a hostile started_at out of run-state.json into a jq instant or nothing', async () => {
    // run-state.json is JSON somebody else wrote, so the expanded-year form reaches
    // `tasks.current.started_at` directly rather than through arithmetic. The largest
    // instant a Date can hold round-trips through Date.parse, so it is the strongest
    // input this field can be handed. Unlike `eta.finish_at` it does not saturate —
    // see lib/progress.json.qa.test.js: a clamped START has no adjacent magnitude
    // field to compensate it, so out of the calendar the field reports null.
    const cases = [
      ['+275760-09-13T00:00:00.000Z', null],
      ['+024208-10-07T18:18:40.000Z', null],
      ['-001199-02-15T14:13:20.000Z', null],
      ['9999-12-31T23:59:59.999Z', CEIL_INSTANT],
      ['yesterday', null],
      ['', null],
      [null, null],
    ]
    for (const [started_at, expected] of cases) {
      const d = deps({
        json: true,
        readRunState: () => runningRecord({ current: { number: 31, started_at, iteration: 3 } }),
      })
      expect((await statusCommand(d)).exitCode, String(started_at)).toBe(0)
      const doc = documentOf(d, String(started_at))
      // The task is still in flight either way: an unreadable start must not delete
      // the task, and a clamped one must not invent a number beside it.
      expect(doc.tasks.current, String(started_at)).toEqual({ number: 31, started_at: expected })
      if (expected !== null) expect(doc.tasks.current.started_at).toMatch(JQ_INSTANT)
    }
  })
})

// ---------------------------------------------------------------------------
// #59 QA. The issue rebuilt the HUMAN view for idle and interrupted and left this
// document alone on purpose — "a key in a released document is the one thing that
// cannot be taken back". So the questions here are the two a published contract
// raises when the surface beside it changes:
//
//   A. IS IT REALLY UNCHANGED? Asserted structurally (every key path and its type,
//      in all four modes) and then as byte-exact literals for the two modes whose
//      document contains no local-time rendering and is therefore timezone-free.
//   B. DID THE NEW READS LEAK INTO IT? #59 made idle and interrupted count the
//      queue and read issues.jsonl. Under `--json` the idle document discards both
//      results, so the cost is paid for nothing — and `--json` is documented as the
//      surface a status line on a timer is driven off, which is the one caller that
//      cannot afford a discarded network round-trip.
//
// And the invariant that spans both surfaces: WHERE THEY OVERLAP THEY MUST AGREE.
// #59 is the first release where a `ralph status` reader is told the run is over
// while `ralph status --json` is still describing it as in flight.
// ---------------------------------------------------------------------------

// The #58 document, as a set of typed key paths. Arrays are enumerated by index, so
// `eta.range_min` is pinned as a two-element numeric tuple rather than as "an object".
const pathsOf = (doc) => {
  const paths = []
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`))
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k))
    }
    paths.push(`${path}: ${value === null ? 'null' : typeof value}`)
  }
  walk(doc, '')
  return paths
}

// Transcribed from the document #58 published, not generated from today's code — the
// point of a non-regression fixture is that it cannot move with the implementation.
const IDLE_DOCUMENT_58 =
  '{"mode":"idle","run_id":"run-live","progress":{"completed":0,"in_flight":0,"remaining":null,' +
  '"total":null},"tasks":{"current":null},"pace":{"basis":"unknown","per_task_min":null,' +
  '"fastest_min":null,"slowest_min":null,"samples":0},"eta":{"remaining_min":null,"finish_at":null,' +
  '"range_min":null,"basis":"unknown"},"spend":{"usd":null,"per_task_usd":null,"projected_usd":null},' +
  // #63's section, appended: an idle run has no digest to show and never reads for one.
  '"digest":null}\n'

const NEVER_RUN_DOCUMENT_58 = IDLE_DOCUMENT_58.replace(
  '"mode":"idle","run_id":"run-live"',
  '"mode":"never-run","run_id":null',
)

describe('ralph status --json — #58’s document, unchanged by #59 (#59 QA)', () => {
  it('publishes the same key paths, with the same types, in all four modes', () => {
    // A published contract is a set of KEYS, so this is asserted over the paths rather
    // than over the values: a key that appeared, vanished or changed type is what
    // breaks a `jq` filter somebody already wrote, and a value that moved is not.
    const expected = {
      running: [
        'mode: string',
        'run_id: string',
        'progress.completed: number',
        'progress.in_flight: number',
        'progress.remaining: number',
        'progress.total: number',
        'tasks.current.number: number',
        'tasks.current.started_at: string',
        'pace.basis: string',
        'pace.per_task_min: number',
        'pace.fastest_min: number',
        'pace.slowest_min: number',
        'pace.samples: number',
        'eta.remaining_min: number',
        'eta.finish_at: string',
        'eta.range_min[0]: number',
        'eta.range_min[1]: number',
        'eta.basis: string',
        'spend.usd: number',
        'spend.per_task_usd: number',
        'spend.projected_usd: number',
        // #63. Null here because no fixture in this file writes a `.ralph/digest.log`;
        // the point of the path is that the key is published in every mode.
        'digest: null',
      ],
      idle: [
        'mode: string',
        'run_id: string',
        'progress.completed: number',
        'progress.in_flight: number',
        'progress.remaining: null',
        'progress.total: null',
        'tasks.current: null',
        'pace.basis: string',
        'pace.per_task_min: null',
        'pace.fastest_min: null',
        'pace.slowest_min: null',
        'pace.samples: number',
        'eta.remaining_min: null',
        'eta.finish_at: null',
        'eta.range_min: null',
        'eta.basis: string',
        'spend.usd: null',
        'spend.per_task_usd: null',
        'spend.projected_usd: null',
        'digest: null',
      ],
    }
    // interrupted takes the running shape with every PREDICTION nulled, and never-run
    // the idle one apart from the run id.
    //
    // UPDATED by the dev for the two failing tests below, which are the specification:
    // the document for an interrupted run reports the measurements it really made (the
    // counts, the pace, the spend) and no predictions, because the card beside it has
    // already called that run over. Same KEYS in all four modes — that is what this
    // test defends and it still holds; what moved is six values, from invented to
    // `null`. Written as the delta from the running shape rather than as a third list,
    // so a key added to one is added to both.
    const nulledForADeadRun = {
      // A dead run has no task in flight, so the two leaves under `tasks.current`
      // collapse into the one null key that replaces them.
      'tasks.current.number: number': 'tasks.current: null',
      'tasks.current.started_at: string': null,
      'eta.remaining_min: number': 'eta.remaining_min: null',
      'eta.finish_at: string': 'eta.finish_at: null',
      // ...and likewise the two ends of the range.
      'eta.range_min[0]: number': 'eta.range_min: null',
      'eta.range_min[1]: number': null,
      'spend.projected_usd: number': 'spend.projected_usd: null',
    }
    expected.interrupted = expected.running
      .map((p) => (p in nulledForADeadRun ? nulledForADeadRun[p] : p))
      .filter((p) => p !== null)
    expected['never-run'] = expected.idle.map((p) => (p === 'run_id: string' ? 'run_id: null' : p))

    return (async () => {
      for (const [mode, d] of modeCases()) {
        await statusCommand(d)
        expect(pathsOf(documentOf(d, mode)), mode).toEqual(expected[mode])
      }
    })()
  })

  it('is byte-identical to #58 for idle and never-run, to the last comma', async () => {
    // These two documents contain no instant and no local-time rendering, so a byte
    // literal is timezone-free and can be transcribed rather than computed. #59 gave
    // the idle HUMAN view an outcome, a spend and a wall clock; none of it reached
    // here, which is what "the document is unchanged" has to mean.
    for (const [label, expected, readRunState] of [
      ['idle', IDLE_DOCUMENT_58, () => terminalRecord()],
      ['never-run', NEVER_RUN_DOCUMENT_58, () => null],
    ]) {
      const d = deps({ json: true, readRunState })
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      expect(d.stdout.output(), label).toBe(expected)
    }
  })

  it('publishes the same idle document whatever the card behind it would have said', async () => {
    // The strongest form of "unchanged": vary every input #59 newly reads — the queue
    // count, the metrics text, the record's own counts and stamps — and the document
    // must not move a byte. It is also the evidence for the discarded-work finding
    // below: a document invariant under an input is a document that did not use it.
    const variants = {
      'a drained queue': { exec: makeExec({ gh: { exitCode: 0, stdout: '0' } }) },
      'a five-figure queue': { exec: makeExec({ gh: { exitCode: 0, stdout: '99999' } }) },
      'no gh at all': { exec: makeExec({ gh: { failed: true } }) },
      'an empty issues.jsonl': { readFile: () => '' },
      'a metrics read that throws': {
        readFile: () => {
          throw new Error('EACCES')
        },
      },
      'a night that cost $268.10': {
        readFile: (p) =>
          isMetrics(p)
            ? [29, 30, 31].map((n) => tagged({ issue_number: n, run_id: RUN_ID, ts: n, duration_ms: 60 * MIN, total_cost_usd: 89.37, verdict: 'pass' })).join('\n')
            : '',
      },
      'a record with nine failures': { readRunState: () => terminalRecord({ ok: 0, failed: 9 }) },
      'a record with no finish': { readRunState: () => terminalRecord({ finished_at: null, status: 'failed' }) },
    }
    for (const [label, overrides] of Object.entries(variants)) {
      const d = deps({ json: true, readRunState: () => terminalRecord(), ...overrides })
      await statusCommand(d)
      expect(d.stdout.output(), label).toBe(IDLE_DOCUMENT_58)
    }
  })

  it('reports the ended run’s spend on the card while the document reports null', async () => {
    // CHARACTERISATION of the asymmetry status.js documents as deliberate and defers:
    // one command, one clock, one read of issues.jsonl, and two answers to "what did
    // last night cost?". Whichever way it is resolved — the document gains the keys, or
    // the card loses the line — this is the test that says which readings change.
    const jsonDeps = deps({ json: true, readRunState: () => terminalRecord() })
    await statusCommand(jsonDeps)
    const doc = documentOf(jsonDeps, 'idle')
    const humanDeps = deps({ readRunState: () => terminalRecord() })
    await statusCommand(humanDeps)
    const human = humanDeps.stdout.output()

    expect(human).toContain('  spend      $62.85 total · $31.4/task avg')
    expect(doc.spend).toEqual({ usd: null, per_task_usd: null, projected_usd: null })
    expect(human).toContain('  queue      6 waiting')
    expect(doc.progress.remaining).toBe(null)
    expect(human).toContain('  outcome    2 ok · 1 failed')
    // There is no key in the document for an outcome at all, which is why the card's
    // counts are unreachable to a consumer rather than merely disagreeing with one.
    expect(Object.keys(doc)).not.toContain('outcome')
  })

  it('spends nothing at all on a never-run repo — no read, no probe, no config stat', async () => {
    // The dev pins the metrics read, the gh call and the folder scan; the CONFIG stat
    // is the one input left, and it is the read that decides which of the two queue
    // counters to use. With no run there is no queue worth counting either way, so a
    // repo that has never run must cost exactly one state read and one tmux-less probe.
    const stats = []
    let stateReads = 0
    const d = deps({
      json: true,
      readRunState: () => {
        stateReads += 1
        return null
      },
      exists: (p) => {
        stats.push(String(p))
        return false
      },
    })
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(documentOf(d, 'never-run').mode).toBe('never-run')
    expect(d.reads, 'no file was read').toEqual([])
    expect(stats, 'no path was stat-ed').toEqual([])
    expect(d.exec.of('gh').length, 'no gh call').toBe(0)
    expect(d.folderCalls, 'no directory scan').toEqual([])
    expect(stateReads, 'the record is read once and only once').toBe(1)
    // ...and identically so without the flag, which is the half the dev's test covers
    // for the human path only.
    const human = deps({ readRunState: () => null, exists: () => false })
    await statusCommand(human)
    expect(human.reads).toEqual([])
    expect(human.exec.of('gh').length).toBe(0)
  })

  it('makes no gh call for an idle repo under --json, whose document discards the count', async () => {
    // FAILING ON PURPOSE. `ralph status --json` on an idle repo now shells out to
    // `gh issue list --search ... | length` — a network round-trip against the GitHub
    // API — and reads issues.jsonl, and then publishes `progress.remaining: null` and
    // `spend.usd: null`. The test above proves the results are discarded: the document
    // is byte-identical whether gh answers 0, 99999 or nothing at all.
    //
    // Before #59 this mode made zero gh calls and zero reads, and #58's own QA suite
    // asserted exactly that for idle — the assertion was deleted rather than moved when
    // the human card acquired a queue line. `--json` is the surface documented for a
    // status line on a timer, and a prompt that runs this every few seconds now burns a
    // rate-limited API call per invocation to compute a number it throws away.
    //
    // The read plan is the shell's `hasRun = mode !== 'never-run'`, decided before the
    // renderer is chosen; a plan that also knew about `json` would skip both for idle,
    // since the only idle consumer of either result is the card.
    const d = deps({ json: true, readRunState: () => terminalRecord() })
    await statusCommand(d)
    expect(documentOf(d, 'idle').mode).toBe('idle')
    expect(d.exec.of('gh').length, 'a network call whose result the document discards').toBe(0)
    expect(d.reads.filter(isMetrics), 'a file read whose result the document discards').toEqual([])
  })

  it('builds exactly one post-mortem snapshot, from the one clock reading', () => {
    // The house source-purity assertion, extended to #59's snapshot. Two calls would be
    // two chances for the card and any later consumer to read different inputs; and the
    // gatherer must build it rather than let `renderStatus`'s default do it, which would
    // build a card with no metrics behind it.
    //
    // Inspects `collectStatus`, not `statusCommand`: #61 split the command into a
    // gathering half and a rendering half, and BOTH invariants this test exists for — one
    // snapshot, one clock reading — belong to the half that does the reading. The
    // rendering half is asserted below to build neither.
    const SOURCE = readFileSync(new URL('./status.js', import.meta.url), 'utf8')
    const CODE = SOURCE.split('\n')
      .map((line) => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
      .join('\n')
    const bodyOf = (signature) => {
      const start = CODE.indexOf(signature)
      expect(start, `${signature} not found`).toBeGreaterThan(-1)
      return CODE.slice(start, CODE.indexOf('\n}\n', start))
    }
    const gather = bodyOf('export async function collectStatus(')
    expect(gather.match(/buildPostMortem\(/g), 'one post-mortem snapshot').toHaveLength(1)
    expect(gather.match(/\bnow\(\)/g), 'one clock reading').toHaveLength(1)
    // Rendering is the module's job, not the shell's: a `renderPostMortem(` in either
    // half would be a second card assembled beside the one `renderStatus` returns. And
    // the rendering half must not build a snapshot OR read the clock for itself, which is
    // what "it gathers nothing itself" means.
    const render = bodyOf('export async function statusCommand(')
    expect(render).not.toMatch(/renderPostMortem\(/)
    expect(render).not.toMatch(/buildPostMortem\(/)
    expect(render).not.toMatch(/\bnow\(\)/)
    expect(gather).not.toMatch(/renderPostMortem\(/)
  })
})

describe('ralph status --json — the two surfaces must not disagree (#59 QA)', () => {
  // Same deps, same clock, same repo state, read seconds apart by a human and by a
  // script. Wherever both surfaces speak about the same fact, they have to say the same
  // thing — that is the whole reason the shell builds ONE snapshot of each kind.
  const bothSurfaces = async (overrides) => {
    const jsonDeps = deps({ json: true, ...overrides })
    await statusCommand(jsonDeps)
    const humanDeps = deps({ ...overrides })
    await statusCommand(humanDeps)
    return { doc: documentOf(jsonDeps), human: humanDeps.stdout.output() }
  }

  it('agrees about the mode word in every mode', async () => {
    for (const [mode, overrides] of Object.entries({
      running: {},
      interrupted: { exec: makeExec({ tmux: { exitCode: 1 } }) },
      idle: { readRunState: () => terminalRecord() },
      'never-run': { readRunState: () => null },
    })) {
      const { doc, human } = await bothSurfaces(overrides)
      expect(doc.mode, mode).toBe(mode)
      expect(human, mode).toContain(`▸ ralph — ${mode} `)
    }
  })

  it('never publishes a task in flight for a run the card says is over', async () => {
    // FAILING ON PURPOSE. For one repo state — a record that says `running` with no
    // tmux session, i.e. a hard-killed overnight run — the two surfaces contradict
    // each other outright:
    //
    //   ralph status         ▸ ralph — interrupted · run run-live (finished unknown)
    //                          ran for    unknown
    //                          restart    ralph start
    //   ralph status --json  "progress":{"in_flight":1,...}
    //                        "tasks":{"current":{"number":31,...}}
    //                        "eta":{"remaining_min":548,"finish_at":"2026-08-26T07:40:00Z"}
    //                        "spend":{"projected_usd":251.4}
    //
    // The human view declares the run over and tells the reader to restart it. The
    // document says task #031 is in flight, projects 548 more minutes of work, names a
    // finish time in the FUTURE for a process that no longer exists, and projects
    // another $188 of spend it will never incur. `reconcileMode` exists precisely to
    // stop a dead run reading as eternally in flight, and status.js's own comment calls
    // a projection for a run that will never take another task "an invented number".
    //
    // The behaviour predates #59 — `live = mode === 'running' || mode === 'interrupted'`
    // is what gates `buildProgress`, and #58 shipped it — but #59 is what makes it a
    // self-contradiction rather than an omission, because until now BOTH surfaces
    // rendered an interrupted run through the live view and were wrong together.
    const { doc, human } = await bothSurfaces({ exec: makeExec({ tmux: { exitCode: 1 } }) })
    expect(doc.mode).toBe('interrupted')
    expect(human).toContain('(finished unknown)')
    expect(human).toContain('  restart    ralph start')
    // The card names no task in flight, so the document must not either.
    expect(human).not.toContain('in flight')
    expect(doc.progress.in_flight, 'a dead run cannot have a task in flight').toBe(0)
    expect(doc.tasks.current, 'a dead run cannot name a current task').toBe(null)
  })

  it('never projects a future for a run the card says is over', async () => {
    // FAILING ON PURPOSE, the other half of the same contradiction and the one a
    // consumer acts on: a status line that renders `eta.finish_at` shows a countdown to
    // an instant a dead run will never reach, and it will keep showing it until somebody
    // notices. `projected_usd` is the same fabrication in dollars.
    const { doc, human } = await bothSurfaces({ exec: makeExec({ tmux: { exitCode: 1 } }) })
    expect(doc.mode).toBe('interrupted')
    // The card offers no pace, no ETA and no projection, because the run is over.
    for (const absent of ['pace', 'eta', 'min/task', 'projected']) {
      expect(human, `the card printed "${absent}"`).not.toContain(absent)
    }
    expect(doc.eta.finish_at, `finish_at = ${doc.eta.finish_at}`).toBe(null)
    expect(doc.eta.remaining_min, 'minutes remaining on a run that is not running').toBe(null)
    expect(doc.spend.projected_usd, 'money a dead run will never spend').toBe(null)
  })

  it('agrees about the run’s identity and the queue wherever both surfaces print them', async () => {
    // The overlaps that DO hold, so the two failures above cannot be dismissed as
    // "these surfaces were never meant to agree".
    for (const [mode, overrides] of Object.entries({
      running: {},
      interrupted: { exec: makeExec({ tmux: { exitCode: 1 } }) },
      idle: { readRunState: () => terminalRecord() },
    })) {
      const { doc, human } = await bothSurfaces(overrides)
      expect(human, mode).toContain(`run ${doc.run_id}`)
      // The queue is counted once for the card and once for the document, from the same
      // single gh call — so where both print it, it is the same number.
      if (doc.progress.remaining !== null) expect(human, mode).toContain(`${doc.progress.remaining} waiting`)
    }
  })
})

// QA augmentation for #63 — the digest on the wire. The dev's status.json.test.js pins the
// happy document (`at`, `age_min`, `model`, `task`, `stale`, `text`), the key in every mode
// and one EACCES case. What is attacked here is the document's own contract with a
// narrative nobody vetted in it:
//
//   1. THE PIPE SURVIVES THE PROSE. `.ralph/digest.log` is the first UNTRUSTED TEXT the
//      document has ever carried. A narrative holding a quote, a backslash, a newline, a
//      NUL, an ANSI escape or U+2028 has to come out as one line that `JSON.parse` accepts
//      and `jq` can read — which means the escaping is `JSON.stringify`'s job and must be
//      seen to be done, not assumed.
//   2. THE TRANSCRIBED INSTANT. `digest.at` is `Date.parse` of somebody else's string, so
//      it is the same hazard `tasks.current.started_at` documents at length: an entry
//      stamped `+275760-09-13` must publish `null`, never an expanded-year form no
//      `fromdate` can read.
//   3. THE UNKNOWN DISCIPLINE, LEAF BY LEAF. `model` is `null` for a pre-#63 entry and
//      never the string `unknown`; `stale` follows the clock it is an opinion about, so it
//      is a boolean wherever `age_min` is a number and `null` in the one case `age_min` is
//      (an unparseable stamp) — a staleness verdict with no age behind it would be a guess
//      published as a fact, and every shape below carries a readable stamp, so every one of
//      them pins the boolean; `text` is a non-empty string or `null`. And `digest` itself is
//      `null`, never absent — `JSON.stringify` drops `undefined`, so an absent key is a live
//      failure mode.
const DIGEST_AT = new Date(NOW - 12 * MIN)
const DIGEST_NARRATIVE = '#031 is in the TDD red phase.\n\nSuite went 1454 → 1598 passing.'

const historyText = (overrides = {}) =>
  formatHistoryEntry({
    at: DIGEST_AT.toISOString(),
    runId: RUN_ID,
    task: '#031',
    model: 'claude-haiku-4-5',
    narrative: DIGEST_NARRATIVE,
    ...overrides,
  })

// A deps bag that answers the metrics AND a history file, so the digest sits in a document
// with every other section populated.
const withHistory = (text = historyText(), overrides = {}) =>
  deps({
    json: true,
    readFile: (p) => {
      if (String(p).endsWith('digest.log')) return text
      return isMetrics(p) ? METRICS : ''
    },
    ...overrides,
  })

const RAW_CONTROL = new RegExp(`[\\u0000-\\u001f]`)

describe('ralph status --json — an untrusted narrative on the wire (#63 QA)', () => {
  const hostile = {
    'a double quote and a backslash': 'she said "cd C:\\\\repo" and it worked',
    'a newline and a tab': 'first\n\tsecond',
    'a CR': 'first\rsecond',
    'a NUL': `before${String.fromCharCode(0)}after`,
    'an ANSI clear-screen sequence': `${ESC}[2J${ESC}[Hgone`,
    'a unicode line separator': `a${String.fromCharCode(0x2028)}b`,
    'a lone surrogate': `broken ${String.fromCharCode(0xd800)} pair`,
    'a forged JSON object': '{"mode":"idle","digest":null}',
    'a closing brace and a newline': '}\n{"pwned":true}',
    'ten thousand characters': 'x'.repeat(10000),
    'two hundred lines': Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
    'emoji and CJK': `${String.fromCharCode(0x65e5, 0x672c, 0x8a9e)} 👩‍👩‍👧‍👦`,
  }

  for (const [label, narrative] of Object.entries(hostile)) {
    it(`stays one parseable line given ${label}`, async () => {
      const d = withHistory(historyText({ narrative }))
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      // documentOf is the byte contract: one write, first byte `{`, one trailing newline,
      // no ANSI, whole buffer parses, top-level keys unchanged.
      const doc = documentOf(d, label)
      // The escaping is real: no raw control byte reaches the wire, however many the
      // narrative held. This is the property the human view does NOT have (see
      // lib/commands/status.qa.test.js).
      // (minus the document's own trailing newline, which is the only one allowed)
      expect(d.stdout.output().slice(0, -1), `${label}: a raw control byte on the wire`).not.toMatch(
        RAW_CONTROL,
      )
      // ...and the text survives the round trip unwrapped and unindented.
      expect(doc.digest, label).not.toBe(null)
      expect(doc.digest.text, label).toBe(String(narrative).trim())
    })
  }

  it('publishes the raw narrative, not the terminal’s 64-column rendering', async () => {
    const d = withHistory()
    await statusCommand(d)
    const doc = documentOf(d)
    expect(doc.digest.text).toBe(DIGEST_NARRATIVE)
    expect(doc.digest.text).toContain('\n\n') // the paragraph break the block drops
    expect(doc.digest.text).not.toContain('  ') // and no entry indent
  })
})

describe('ralph status --json — the digest’s leaves obey the document’s rules (#63 QA)', () => {
  it('publishes null, never an expanded year, for a stamp outside the calendar', async () => {
    // The same window isoUtcSecondsOrNull holds every transcribed instant to. `age_min`
    // may still carry the magnitude — that is the documented leaf-by-leaf degradation —
    // but the TEXT must be one `jq`'s fromdate can read, or nothing.
    for (const [label, at] of Object.entries({
      'the maximum time value': '+275760-09-13T00:00:00Z',
      'the year 10000': '+010000-01-01T00:00:00Z',
      'the year zero': '0000-01-01T00:00:00Z',
      'a negative year': '-000001-12-31T00:00:00Z',
    })) {
      const d = withHistory(historyText({ at }))
      await statusCommand(d)
      const doc = documentOf(d, label)
      if (doc.digest === null) continue
      if (doc.digest.at !== null) expect(doc.digest.at, label).toMatch(JQ_INSTANT)
      expect(String(doc.digest.at), `${label}: an expanded year reached the wire`).not.toMatch(/^[+-]/)
    }
  })

  it('types every leaf the same way in every shape of entry', async () => {
    const shapes = {
      'a full four-field entry': historyText(),
      'a pre-#63 three-field entry': `\n── ${DIGEST_AT.toISOString()} · run ${RUN_ID} · #031 ${'─'.repeat(20)}\n  older ralph\n\n`,
      'an entry whose model the writer could not name': historyText({ model: null }),
      'an entry whose task the writer could not name': historyText({ task: null }),
      'an entry stamped in the future': historyText({ at: new Date(NOW + 5 * MIN).toISOString() }),
    }
    for (const [label, text] of Object.entries(shapes)) {
      const d = withHistory(text)
      await statusCommand(d)
      const { digest } = documentOf(d, label)
      expect(Object.keys(digest), label).toEqual(['at', 'age_min', 'model', 'task', 'stale', 'text'])
      // A value or null, never `undefined` (which JSON.stringify would have dropped, and
      // never the writer's word for absence leaking through as data.
      expect(digest.at === null || typeof digest.at === 'string', label).toBe(true)
      expect(digest.age_min === null || Number.isInteger(digest.age_min), label).toBe(true)
      expect(digest.age_min === null || digest.age_min >= 0, `${label}: negative age`).toBe(true)
      expect(digest.model === null || typeof digest.model === 'string', label).toBe(true)
      expect(digest.model, `${label}: our uncertainty published as a model name`).not.toBe('unknown')
      expect(digest.task, `${label}: our uncertainty published as a task`).not.toBe('none')
      expect(typeof digest.stale, `${label}: a readable stamp must yield a boolean verdict`).toBe('boolean')
      expect(typeof digest.text, label).toBe('string')
      expect(digest.text, label).not.toBe('')
    }
  })

  it('keeps the key present and null in every mode, and for every unreadable history', async () => {
    // `digest` is a KEY, not an optional section: a `jq '.digest.age_min'` in a prompt must
    // resolve rather than error, in the three modes that never have one and in the running
    // mode when the file is unreadable.
    for (const [mode, d] of modeCases()) {
      await statusCommand(d)
      const doc = documentOf(d, mode)
      expect('digest' in doc, `${mode}: the key vanished`).toBe(true)
      expect(doc.digest, mode).toBe(null)
    }
    const unreadable = {
      'a read that throws': withHistory('', {
        readFile: (p) => {
          if (String(p).endsWith('digest.log')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
          return isMetrics(p) ? METRICS : ''
        },
      }),
      'an empty file': withHistory(''),
      'junk with no heading': withHistory('a human pasted notes here\n'),
      'the previous run': withHistory(historyText({ runId: 'ralph-ralph-0000dead' })),
      'a torn heading': withHistory(historyText().split('\n').slice(0, 2).join('\n')),
      'a CRLF rewrite': withHistory(historyText().replace(/\n/g, '\r\n')),
    }
    for (const [label, d] of Object.entries(unreadable)) {
      const result = await statusCommand(d)
      expect(result.exitCode, label).toBe(0)
      expect(documentOf(d, label).digest, label).toBe(null)
    }
  })

  it('CHARACTERISATION: the age_min leaf rounds while the human view floors', async () => {
    // Twelve and a half minutes: the terminal says `12min ago`, the document says 13. Both
    // come from the SAME subtraction, so this is a formatting split rather than two clock
    // readings — and it is the split lib/progress.js already ships for `eta` (`~Xmin left`
    // is floored, `eta.remaining_min` is rounded). Pinned here rather than filed as a bug
    // because the precedent is deliberate, but it is worth knowing that the dev's own
    // cross-surface test passes only because its fixture is an exact number of minutes.
    const at = new Date(NOW - 12.5 * MIN).toISOString()
    const jsonDeps = withHistory(historyText({ at }))
    await statusCommand(jsonDeps)
    const doc = documentOf(jsonDeps)
    const humanDeps = withHistory(historyText({ at }), { json: false })
    await statusCommand(humanDeps)
    expect(doc.digest.age_min).toBe(13)
    expect(humanDeps.stdout.output()).toContain('digest (12min ago')
    expect(humanDeps.stdout.output()).not.toContain(`${doc.digest.age_min}min ago`)
  })

  it('agrees with the human view about the model, the staleness and the text', async () => {
    // The overlaps that DO hold, so the divergence above cannot be dismissed as "these
    // surfaces were never meant to agree".
    const text = historyText({ at: new Date(NOW - 90 * MIN).toISOString(), narrative: 'one short line' })
    const jsonDeps = withHistory(text)
    await statusCommand(jsonDeps)
    const doc = documentOf(jsonDeps)
    const humanDeps = withHistory(text, { json: false })
    await statusCommand(humanDeps)
    const human = humanDeps.stdout.output()
    expect(doc.digest.stale).toBe(true)
    expect(human).toContain(`· ${doc.digest.model} · stale)`)
    expect(human).toContain(`  ${doc.digest.text}`)
  })
})
