import { describe, it, expect } from 'vitest'
import { statusCommand } from './status.js'

// QA augmentation for #56's SHELL half. lib/progress.table.qa.test.js attacks the
// pure renderers; this file attacks the one piece of I/O the issue added — the
// second `gh` call that looks issue titles up — and the placement of the table in
// the four-mode view around it.
//
// The claim under test is the one the module makes in prose: titles are "a courtesy
// rather than a fact", so EVERY way `gh` can answer badly must leave `ralph status`
// exiting 0 with a table of numbers, exactly as folder mode already renders. That
// makes three families of test:
//
//   1. WHAT gh CAN ANSWER. `readIssueTitles` runs `JSON.parse` on a subprocess's
//      stdout and then iterates the result. Both halves have failure modes that are
//      not "invalid JSON": valid JSON that is not an array is not iterable, an array
//      of nulls has no `.number`, a number too large for a double is not finite, and
//      execa's `stdout` is a Buffer when the caller does not ask for a string. Each
//      case below is a real answer from a real `gh` (or a real absence of one).
//   2. WHO PAYS FOR IT. The lookup is deliberately skipped under `--json`, in folder
//      mode, and in the two modes that spend nothing — and deliberately NOT skipped
//      in `interrupted`, which still draws a table. Those are four assertions about
//      call counts, and they are what keeps the document byte-identical and folder
//      mode gh-free.
//   3. WHAT REACHES stdout. A title is text somebody else wrote, arriving over a
//      pipe into a terminal: no escape sequence, no bidi override and no extra line
//      may come out of it, in any of these cases.
//
// Failure shapes are execa's, matching the #55 QA file: with `{ reject: false }` a
// missing binary comes back as `{ failed: true, exitCode: undefined }` and a timeout
// as `{ timedOut: true }`, so the doubles return those rather than throwing.
//
// Hermetic: local Date constructors (the rendered clock is local time), an injected
// `now`, an injected `processEnv`.

const REPO = '/repo'
const SESSION = 'ralph-repo-live'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

const MIN = 60000
const RUN = 'run-live'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return false // a real stdout can answer false, and the command must not care
    },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').slice(0, -1),
  }
}

const running = (overrides = {}) => ({
  schema: 1,
  run_id: RUN,
  session: SESSION,
  source: 'github',
  status: 'running',
  started_at: RUN_STARTED.toISOString(),
  queue_at_start: 8,
  current: { number: 31, started_at: TASK_STARTED.toISOString(), iteration: 3 },
  finished_at: null,
  ok: null,
  failed: null,
})

// Two closed tasks for this run, so there is a real table to lose.
const METRICS =
  [
    { issue_number: 29, run_id: RUN, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.45, verdict: 'pass' },
    { issue_number: 30, run_id: RUN, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.4, verdict: 'pass' },
  ]
    .map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e))
    .join('\n') + '\n'

const RESOLVES_UNDEFINED = Symbol('resolves undefined')

// The titles call is the `gh issue list --state all` one; the queue count is the
// `--search` one. A double that answered both the same way could not tell a broken
// title lookup from a broken queue count, which is the whole point here.
const isTitlesCall = (call) => call.cmd === 'gh' && call.args.includes('--state')
const isQueueCall = (call) => call.cmd === 'gh' && call.args.includes('--search')

function makeExec({
  tmuxResult = { exitCode: 0 },
  queueResult = { exitCode: 0, stdout: '6' },
  titlesResult = { exitCode: 0, stdout: '[]' },
} = {}) {
  const calls = []
  const unwrap = (r) => (r === RESOLVES_UNDEFINED ? undefined : r)
  const exec = async (cmd, args = [], options = {}) => {
    const call = { cmd, args, options }
    calls.push(call)
    if (cmd === 'tmux') return unwrap(tmuxResult)
    if (isTitlesCall(call)) return unwrap(titlesResult)
    if (isQueueCall(call)) return unwrap(queueResult)
    return { exitCode: 0, stdout: '' }
  }
  exec.calls = calls
  exec.titles = () => calls.filter(isTitlesCall)
  exec.queue = () => calls.filter(isQueueCall)
  return exec
}

const deps = (overrides = {}) => {
  const stdout = makeStream()
  const base = {
    cwd: REPO,
    stdout,
    exec: makeExec(),
    exists: () => false, // no ralph.config.sh -> github, the default
    readFile: () => METRICS,
    readRunState: () => running(),
    peekLock: () => null,
    folderQueueCount: async () => 6,
    now: () => NOW,
    processEnv: {},
    ...overrides,
  }
  return base
}

const run = async (overrides = {}) => {
  const d = deps(overrides)
  const result = await statusCommand(d)
  return { result, stdout: d.stdout, exec: d.exec, lines: d.stdout.lines() }
}

const titlesOf = (stdout) => ({ exitCode: 0, stdout })

// ===========================================================================
// 1. WHAT gh CAN ANSWER.
// ===========================================================================

describe('statusCommand — every way `gh` can answer the title lookup badly still draws the table (#56 QA)', () => {
  const answers = {
    // --- the transport failed, in each of the four shapes it can fail in ---
    'gh is not installed': { failed: true, exitCode: undefined },
    'gh timed out': { timedOut: true },
    'gh is not authenticated': { exitCode: 4, stdout: '', stderr: 'gh: not logged in' },
    'gh exited nonzero with JSON on stdout anyway': { exitCode: 1, stdout: '[{"number":29,"title":"x"}]' },
    'the call resolves with nothing at all': RESOLVES_UNDEFINED,

    // --- the transport worked and the PAYLOAD is wrong ---
    'an empty array, from a repo with no issues': titlesOf('[]'),
    'an empty stdout': titlesOf(''),
    'a stdout of only whitespace': titlesOf('   \n  '),
    'an undefined stdout': titlesOf(undefined),
    'a null stdout': titlesOf(null),
    'a Buffer stdout, which execa gives a caller that asked for no encoding': titlesOf(
      Buffer.from('[{"number":29,"title":"sidebar"}]'),
    ),
    'a stdout that is a number': titlesOf(42),
    'a stdout that is an object': titlesOf({ number: 29 }),
    'a JSON object where an array belongs': titlesOf('{"29":"sidebar"}'),
    'a JSON scalar': titlesOf('42'),
    'a JSON null': titlesOf('null'),
    'a JSON string': titlesOf('"sidebar"'),
    'a JSON true': titlesOf('true'),
    'JSON truncated mid-write': titlesOf('[{"number":29,"title":"sid'),
    'not JSON at all': titlesOf('gh: could not resolve to a Repository'),
    'an HTML error page from a proxy': titlesOf('<html><body>502</body></html>'),

    // --- the payload is an array and the ELEMENTS are wrong ---
    'an array of nulls': titlesOf('[null,null]'),
    'an array of scalars': titlesOf('[1,"two",true]'),
    'an array of arrays': titlesOf('[[29,"sidebar"]]'),
    'objects with no number': titlesOf('[{"title":"sidebar"}]'),
    'objects with no title': titlesOf('[{"number":29}]'),
    'a number sent as a string': titlesOf('[{"number":"29","title":"sidebar"}]'),
    'a number too large for a double to hold': titlesOf('[{"number":1e400,"title":"sidebar"}]'),
    'a fractional number': titlesOf('[{"number":29.5,"title":"sidebar"}]'),
    'a negative number': titlesOf('[{"number":-29,"title":"sidebar"}]'),
    'a null title': titlesOf('[{"number":29,"title":null}]'),
    'a numeric title': titlesOf('[{"number":29,"title":42}]'),
    'an object title': titlesOf('[{"number":29,"title":{"text":"sidebar"}}]'),
    'the same number twice': titlesOf(
      '[{"number":29,"title":"first"},{"number":29,"title":"second"}]',
    ),
    'a __proto__ key beside the number': titlesOf(
      '[{"__proto__":{"pwned":1},"number":29,"title":"sidebar"}]',
    ),
    'a title that is a prototype key': titlesOf(
      '[{"number":29,"title":"constructor"},{"number":30,"title":"__proto__"}]',
    ),
    'a hundred issues, none of them this run’s': titlesOf(
      JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: 500 + i, title: `t${i}` }))),
    ),
    'a 5 MB payload': titlesOf(
      JSON.stringify([{ number: 29, title: 'x'.repeat(5 * 1024 * 1024) }]),
    ),
  }

  for (const [label, titlesResult] of Object.entries(answers)) {
    it(`exits 0 and still rows every task for ${label}`, async () => {
      const { result, lines } = await run({ exec: makeExec({ titlesResult }) })
      expect(result.exitCode, label).toBe(0)
      // The table is still there, and still has a row per task: the numbers are
      // the fact, the titles were only ever the context.
      const header = lines.findIndex((line) => /^\s+task\s+verdict\s+cost\s+time\s*$/.test(line))
      expect(header, `${label}\n${lines.join('\n')}`).toBeGreaterThan(0)
      for (const number of ['#029', '#030', '#031']) {
        expect(lines.some((line) => line.includes(number)), `${label} → ${number}`).toBe(true)
      }
      // ...and the lines either side of it are intact.
      expect(lines.some((line) => line.includes('6 waiting')), label).toBe(true)
      expect(lines[0], label).toContain('▸ ralph — running')
      expect(lines.some((line) => line.includes('2/9 done')), label).toBe(true)
      // Nothing anywhere claims a cost or a number it does not have.
      const text = lines.join('\n')
      expect(text, label).not.toMatch(/NaN|Infinity|\$0\.00|undefined/)
      expect({}.pwned, label).toBeUndefined()
    })
  }

  it('writes nothing to stderr — there is no stderr in the deps bag to write to', async () => {
    // Load-bearing under `--json`: a diagnostic about a failed courtesy would have
    // to go somewhere, and the design decision is that it goes nowhere.
    const { result } = await run({
      exec: makeExec({ titlesResult: { failed: true, exitCode: undefined } }),
    })
    expect(result.exitCode).toBe(0)
    expect('stderr' in deps()).toBe(false)
  })
})

// ===========================================================================
// 2. WHO PAYS FOR IT.
// ===========================================================================

describe('statusCommand — the title lookup is priced exactly where #56 says it is (#56 QA)', () => {
  it('makes the lookup once, at the repo root, over issues in every state', async () => {
    const { exec } = await run()
    expect(exec.titles()).toHaveLength(1)
    const [call] = exec.titles()
    expect(call.args).toEqual([
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title',
    ])
    // `--state all`: the table's closed rows are issues the run has just CLOSED, so
    // an open-only query would title the queue and leave every row above it blank.
    expect(call.args).not.toContain('--search')
    // At the root, like every other gh call — gh reads the repo off its cwd's remote.
    expect(call.options).toMatchObject({ cwd: REPO, reject: false })
  })

  it('makes it for an interrupted run too, which still draws a table', async () => {
    // The mode where the table matters most — the reader is trying to work out what
    // the dead run got through — so it is the one skip that would be a regression.
    const { result, exec, lines } = await run({
      exec: makeExec({ tmuxResult: { exitCode: 1 } }),
    })
    expect(result.mode).toBe('interrupted')
    expect(exec.titles()).toHaveLength(1)
    expect(lines.some((line) => /^\s+task\s+verdict/.test(line))).toBe(true)
  })

  it('skips it under --json, so the document costs no round trip for prose', async () => {
    const { result, exec, stdout } = await run({ json: true })
    expect(result.exitCode).toBe(0)
    expect(exec.titles()).toHaveLength(0)
    // The queue count is still paid for — it is a number the document publishes.
    expect(exec.queue()).toHaveLength(1)
    expect(stdout.output()).not.toContain('sidebar')
  })

  it('skips it in folder mode, where gh is not the source of truth at all', async () => {
    const { result, exec } = await run({
      exists: (p) => String(p).endsWith('ralph.config.sh'),
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="folder"\n' : METRICS),
    })
    expect(result.exitCode).toBe(0)
    expect(exec.calls.filter((c) => c.cmd === 'gh')).toHaveLength(0)
  })

  it('skips it in folder mode selected by the environment rather than the config', async () => {
    const { exec } = await run({ processEnv: { TASK_SOURCE: 'folder' } })
    expect(exec.calls.filter((c) => c.cmd === 'gh')).toHaveLength(0)
  })

  it('skips it in the two modes that spend nothing', async () => {
    for (const readRunState of [
      () => null, // never-run
      () => ({ ...running(), status: 'completed', finished_at: RUN_STARTED.toISOString() }), // idle
    ]) {
      const { result, exec } = await run({ readRunState })
      expect(['never-run', 'idle']).toContain(result.mode)
      expect(exec.calls.filter((c) => c.cmd === 'gh'), result.mode).toHaveLength(0)
    }
  })

  it('renders the table even when the queue count failed and the titles arrived', async () => {
    // The two gh calls are independent, and a table is worth drawing without a
    // denominator: `unknown` waiting, but the rows are still counted facts.
    const { result, lines } = await run({
      exec: makeExec({
        queueResult: { exitCode: 1, stdout: '' },
        titlesResult: titlesOf('[{"number":29,"title":"sidebar"}]'),
      }),
    })
    expect(result.exitCode).toBe(0)
    expect(lines.some((line) => line.includes('queue      unknown'))).toBe(true)
    expect(lines.some((line) => line.includes('#029 sidebar'))).toBe(true)
    // An unknown queue is not an empty queue.
    expect(lines.join('\n')).not.toContain('0 waiting')
  })
})

// ===========================================================================
// 3. WHAT REACHES stdout.
// ===========================================================================

describe('statusCommand — an issue title is text somebody else wrote, arriving over a pipe (#56 QA)', () => {
  const hostile = {
    'a raw CSI colour sequence': '[31mred[0m',
    'an OSC that would retitle the terminal window': ']0;pwned',
    'an unterminated CSI sequence': '[38;5;213',
    'a bidi override that would reorder the line': 'safe‮gnorw‬',
    'a newline that would forge a row': 'a\n  #999 forged   ✅ pass     $0.01     1min',
    'a carriage return that would overwrite the line': 'a\rERASED',
    'a vertical tab': 'ab',
    'a form feed that would clear the screen': 'ab',
    'a NUL byte': 'a b',
    'a backspace': 'a\bb',
    'a DEL': 'ab',
    'a line separator': 'a b',
    'a paragraph separator': 'a b',
    'a zero-width space': 'a​b',
    'a lone surrogate': 'a\ud800b',
    'a title of four thousand characters': 'x'.repeat(4000),
    'a title that is nothing but escapes': '[0m[1m[2m',
  }

  for (const [label, title] of Object.entries(hostile)) {
    it(`prints no escape, no control character and no extra line for ${label}`, async () => {
      const { result, lines, stdout } = await run({
        exec: makeExec({
          titlesResult: titlesOf(JSON.stringify([{ number: 29, title }, { number: 30, title: 'persist' }])),
        }),
      })
      expect(result.exitCode, label).toBe(0)
      for (const line of lines) {
        expect(line, label).not.toMatch(/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u)
        expect(line, label).not.toMatch(/[​-‏‪-‮⁦-⁩­]/u)
        expect(line, label).not.toContain('')
      }
      // The write is one string ending in one newline per line — no partial line.
      expect(stdout.output().endsWith('\n'), label).toBe(true)
      // And the row count is untouched: header plus exactly three tasks.
      const header = lines.findIndex((line) => /^\s+task\s+verdict/.test(line))
      const table = lines.slice(header, header + 4)
      expect(table.filter((line) => /#\d{3}/.test(line)), label).toHaveLength(3)
      // The next line after the table is the blank that stands it off from `queue`.
      expect(lines[header + 4], label).toBe('')
      expect(lines[header + 5], label).toContain('queue')
    })
  }

  it('stands the table off from the lines either side with exactly one blank each', async () => {
    const { lines } = await run({
      exec: makeExec({
        titlesResult: titlesOf(
          JSON.stringify([
            { number: 29, title: 'sidebar' },
            { number: 30, title: 'persist' },
            { number: 31, title: 'row comp' },
          ]),
        ),
      }),
    })
    const header = lines.findIndex((line) => /^\s+task\s+verdict/.test(line))
    expect(lines[header - 1]).toBe('')
    expect(lines[header - 2]).toContain('2/9 done')
    expect(lines[header + 4]).toBe('')
    expect(lines[header + 5]).toContain('queue      6 waiting')
    // #55's separate `in flight` line is GONE, not doubled up beside the new one.
    expect(lines.filter((line) => line.includes('in flight'))).toHaveLength(1)
  })

  it('draws the header and the live row alone for a run that has closed nothing yet', async () => {
    const { result, lines } = await run({ readFile: () => '' })
    expect(result.exitCode).toBe(0)
    const header = lines.findIndex((line) => /^\s+task\s+verdict/.test(line))
    expect(header).toBeGreaterThan(0)
    expect(lines[header + 1]).toContain('#031')
    expect(lines[header + 2]).toBe('')
    expect(lines[header + 1]).not.toContain('$0.00')
    expect(lines.some((line) => line.includes('0/7 done'))).toBe(true)
  })

  it('draws no table at all — not even a stray blank line — for a run between tasks', async () => {
    const { lines } = await run({
      readFile: () => '',
      readRunState: () => ({ ...running(), current: null }),
    })
    expect(lines.some((line) => /^\s+task\s+verdict/.test(line))).toBe(false)
    // The heading is immediately followed by the progress line and then the queue —
    // no blank pair left behind by a table that was not drawn.
    expect(lines[1]).toContain('nothing in flight')
    expect(lines[2]).toContain('queue      6 waiting')
  })
})

describe('statusCommand --json — #56 changed the terminal, and the document must not have noticed (#56 QA)', () => {
  const docFor = async (overrides) => {
    const { stdout } = await run({ json: true, ...overrides })
    return stdout.output()
  }

  it('prints one compact newline-terminated line and nothing else', async () => {
    const out = await docFor({})
    expect(out.endsWith('\n')).toBe(true)
    expect(out.trimEnd().split('\n')).toHaveLength(1)
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out).not.toContain('▸')
    expect(out).not.toContain('task ')
  })

  it('is byte-identical however the title lookup would have answered', async () => {
    // It never runs under `--json`, and this is the assertion that keeps it that
    // way: a consumer diffing two documents must never see prose appear in one.
    const base = await docFor({})
    for (const titlesResult of [
      titlesOf('[{"number":29,"title":"sidebar"},{"number":31,"title":"row comp"}]'),
      titlesOf('not json'),
      { failed: true, exitCode: undefined },
      RESOLVES_UNDEFINED,
    ]) {
      expect(await docFor({ exec: makeExec({ titlesResult }) })).toBe(base)
    }
  })

  it('publishes no taskRows, no titles and no table furniture', async () => {
    const out = await docFor({})
    expect(out).not.toContain('taskRows')
    expect(out).not.toContain('title')
    expect(out).not.toContain('verdict')
    expect(Object.keys(JSON.parse(out))).toEqual([
      'mode',
      'run_id',
      'progress',
      'tasks',
      'pace',
      'eta',
      'spend',
    ])
  })
})
