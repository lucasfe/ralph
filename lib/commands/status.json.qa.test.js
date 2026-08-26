import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { statusCommand } from './status.js'
import { buildProgress, toJsonSnapshot } from '../progress.js'
import { metricsPath } from '../issue-metrics.js'

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

const TOP_KEYS = ['mode', 'run_id', 'progress', 'tasks', 'pace', 'eta', 'spend']
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
    // idle/never-run read no metrics and count no queue, so the document is the
    // all-unknown reading those modes deserve — in ONE shape, not a second one.
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
      expect(d.reads, `${label} must read nothing`).toEqual([])
      expect(d.exec.of('gh').length, label).toBe(0)
      expect(d.folderCalls, label).toEqual([])
    }
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
    // shell prompt pays for one gh call either way.
    const jsonDeps = deps({ json: true })
    await statusCommand(jsonDeps)
    const humanDeps = deps()
    await statusCommand(humanDeps)

    expect(jsonDeps.reads).toEqual(humanDeps.reads)
    expect(jsonDeps.reads.filter(isMetrics).length).toBe(1)
    expect(jsonDeps.reads).toContain(metricsPath(REPO))
    // Same subprocesses, in the same order, MINUS the one the flag has no use for:
    // #56 gave the terminal view a task table whose titles come from a second
    // `gh issue list` (`--state all`), and the document publishes no titles at all.
    // So `--json` may cost LESS than the human view — it must never cost more, and it
    // must never repeat a call.
    const jsonKeys = jsonDeps.exec.calls.map((c) => c.key)
    expect(jsonKeys).toEqual(
      humanDeps.exec.calls.map((c) => c.key).filter((key) => !key.includes('--state')),
    )
    expect(new Set(jsonKeys).size).toBe(jsonKeys.length)
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
    const body = bodyOf('statusCommand')
    expect(body.match(/\bnow\(\)/g), 'one clock reading').toHaveLength(1)
    expect(body.match(/buildProgress\(/g), 'one snapshot').toHaveLength(1)
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
