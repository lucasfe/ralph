import { describe, it, expect } from 'vitest'
import { statusCommand } from './status.js'

// #56's SHELL half. lib/progress.table.test.js owns the rows and the two renderers;
// this file owns the three things only the shell can be wrong about:
//
//   1. WHERE THE TABLE SITS. The progress line REPLACES #55's `in flight` line, and
//      the table stands between it and `queue` with one blank line either side. A
//      table that renders in the wrong place, or a stray blank left behind by a table
//      that was not drawn, is a bug no pure test can see.
//   2. WHO PAYS FOR THE TITLES. No metrics event records an issue title
//      (lib/issue-event.js) and neither does the run record, so the shell looks them
//      up — one extra `gh` call, behind a gate TIGHTER than the read plan's
//      `measured`: only for a live run, only for the human view, only when GitHub is
//      the task source. Those are call-count assertions, and they are what keeps the
//      `--json` document byte-identical and folder mode gh-free.
//   3. WHAT HAPPENS WHEN THE LOOKUP FAILS. A title is a COURTESY. Every way `gh` can
//      answer badly — missing binary, unauthenticated, valid JSON of the wrong shape,
//      a Buffer — must leave `ralph status` exiting 0 with a table of numbers, which
//      is exactly what folder mode renders on purpose.
//
// Failure shapes are execa's, matching the sibling suites: with `{ reject: false }` a
// missing binary comes back as `{ failed: true, exitCode: undefined }` and a timeout
// as `{ timedOut: true }`, so the doubles return those rather than throwing.
//
// Hermetic throughout: local Date constructors (the rendered clock is local time), an
// injected `now`, an injected `processEnv`, and no filesystem — `readFile` answers by
// path. Control bytes are spelled with `String.fromCharCode` for the reason the pure
// suite gives: a test about invisible characters must not depend on one surviving a
// copy or a tool argument.

const REPO = '/repo'
const SESSION = 'ralph-repo-live'
const MIN = 60000
const RUN = 'run-live'

const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

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
  ...overrides,
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
  exec.gh = () => calls.filter((c) => c.cmd === 'gh')
  return exec
}

// Answers by PATH: the metrics file has history, the digest log has none — otherwise
// the metrics text would be read as a narration and a digest section would appear
// between the table and the advice, which is a different issue's line.
const readByPath = (metricsText = METRICS) => (path) =>
  String(path).endsWith('issues.jsonl') ? metricsText : ''

const deps = (overrides = {}) => ({
  cwd: REPO,
  stdout: makeStream(),
  exec: makeExec(),
  exists: () => false, // no ralph.config.sh -> github, the default
  readFile: readByPath(),
  readRunState: () => running(),
  peekLock: () => null,
  folderQueueCount: async () => 6,
  now: () => NOW,
  // RALPH_BANNER=off, exactly as status.test.js turns it off and for the same reason
  // (#76): every expectation here is a statement about the REPORT, and the identity box
  // that otherwise prints above it would put three lines of frame in front of every
  // `lines[0]` below for a picture this file asserts nothing about.
  processEnv: { RALPH_BANNER: 'off' },
  ...overrides,
})

const run = async (overrides = {}) => {
  const d = deps(overrides)
  const result = await statusCommand(d)
  return { result, stdout: d.stdout, exec: d.exec, lines: d.stdout.lines() }
}

const titlesOf = (stdout) => ({ exitCode: 0, stdout })
const WORKED_TITLES = titlesOf(
  JSON.stringify([
    { number: 29, title: 'sidebar' },
    { number: 30, title: 'persist' },
    { number: 31, title: 'row comp' },
  ]),
)

const headerIndex = (lines) => lines.findIndex((line) => /^\s+task\s+verdict\s+cost\s+time$/.test(line))

describe('statusCommand — where the table sits in the live view (#56)', () => {
  it('renders the issue’s worked example, in order, once', async () => {
    const { result, lines } = await run({ exec: makeExec({ titlesResult: WORKED_TITLES }) })
    expect(result.exitCode).toBe(0)
    expect(lines).toEqual([
      `▸ ralph — running · run ${RUN} (started 16:20, 3h12m ago)`,
      '  progress   2/9 done · #031 in flight (40min)  [██──────] 22%',
      '',
      '  task           verdict     cost      time',
      '  #029 sidebar   ✅ pass     $34.45    97min',
      '  #030 persist   ✅ pass     $28.40    71min',
      '  #031 row comp  🔄 live     –         ~40min',
      '',
      // #57's three lines, unchanged and still in their own block — the table went in
      // ABOVE the queue count, so the counted facts still read top to bottom before
      // anything extrapolated from them.
      '  queue      6 waiting',
      '  pace       ~84 min/task · $31.4/task',
      '  eta        ~9h08m left → ~04:40  (±1h30m)',
      '  spend      $62.85 so far · ~$250 projected',
      '',
      `  attach     tmux attach -t ${SESSION}`,
      '  kill       ralph stop',
    ])
  })

  it('replaces #55’s `in flight` line rather than adding a second one', async () => {
    const { lines } = await run({ exec: makeExec({ titlesResult: WORKED_TITLES }) })
    expect(lines.filter((line) => line.includes('in flight'))).toHaveLength(1)
    expect(lines.some((line) => line.startsWith('  in flight'))).toBe(false)
  })

  it('stands the table off from the lines either side with exactly one blank each', async () => {
    const { lines } = await run({ exec: makeExec({ titlesResult: WORKED_TITLES }) })
    const header = headerIndex(lines)
    expect(header).toBeGreaterThan(0)
    expect(lines[header - 1]).toBe('')
    expect(lines[header - 2]).toContain('2/9 done')
    expect(lines[header + 4]).toBe('')
    expect(lines[header + 5]).toContain('queue      6 waiting')
  })

  it('draws the header and the live row alone for a run that has closed nothing yet', async () => {
    const { result, lines } = await run({ readFile: readByPath('') })
    expect(result.exitCode).toBe(0)
    const header = headerIndex(lines)
    expect(header).toBeGreaterThan(0)
    expect(lines[header + 1]).toContain('#031')
    expect(lines[header + 1]).not.toContain('$0.00')
    expect(lines[header + 2]).toBe('')
    expect(lines.some((line) => line.includes('0/7 done'))).toBe(true)
  })

  it('draws no table at all — not even a stray blank — for a run between tasks', async () => {
    const { lines } = await run({
      readFile: readByPath(''),
      readRunState: () => running({ current: null }),
    })
    expect(headerIndex(lines)).toBe(-1)
    expect(lines[1]).toContain('nothing in flight')
    expect(lines[2]).toContain('queue      6 waiting')
  })

  it('draws no table for the three modes that render the report card or the greeting', async () => {
    const plans = {
      'never-run': () => null,
      idle: () => running({ status: 'completed', finished_at: RUN_STARTED.toISOString() }),
    }
    for (const [mode, readRunState] of Object.entries(plans)) {
      const { result, lines } = await run({ readRunState })
      expect(result.mode).toBe(mode)
      expect(headerIndex(lines), mode).toBe(-1)
    }
    // ...and `interrupted`, which reaches the report card by the same door (#59): the
    // run is over, and the card reports what it managed rather than a table with a
    // `🔄 live` row in it.
    const { result, lines } = await run({ exec: makeExec({ tmuxResult: { exitCode: 1 } }) })
    expect(result.mode).toBe('interrupted')
    expect(headerIndex(lines)).toBe(-1)
    expect(lines.join('\n')).not.toContain('🔄')
  })

  it('renders the table even when the queue count failed', async () => {
    // The two gh calls are independent, and a table is worth drawing without a
    // denominator: the rows are counted facts either way.
    const { result, lines } = await run({
      exec: makeExec({ queueResult: { exitCode: 1, stdout: '' }, titlesResult: WORKED_TITLES }),
    })
    expect(result.exitCode).toBe(0)
    expect(lines.some((line) => line.includes('queue      unknown'))).toBe(true)
    expect(lines.some((line) => line.includes('#029 sidebar'))).toBe(true)
    expect(lines.some((line) => line.includes('2/unknown done'))).toBe(true)
    // An unknown queue is not an empty queue, and it is not a full bar either.
    expect(lines.join('\n')).not.toContain('0 waiting')
    expect(lines.join('\n')).not.toContain('100%')
  })
})

describe('statusCommand — the title lookup is priced exactly where #56 says it is (#56)', () => {
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
    // `--state all`: the table's closed rows are issues this run has just CLOSED, so
    // an open-only query would title the queue and leave every row above it blank.
    expect(call.args).not.toContain('--search')
    // At the root, like every other gh call — gh reads the repo off its cwd's remote —
    // and never rejecting, because a failed courtesy must not become an exception.
    expect(call.options).toMatchObject({ cwd: REPO, reject: false })
  })

  it('counts the queue FIRST, so the number the view needs is never behind the prose', async () => {
    const { exec } = await run()
    expect(exec.gh().map((c) => (isQueueCall(c) ? 'queue' : 'titles'))).toEqual(['queue', 'titles'])
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
      readFile: (p) =>
        String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE="folder"\n' : readByPath()(p),
    })
    expect(result.exitCode).toBe(0)
    expect(exec.gh()).toHaveLength(0)
  })

  it('skips it in folder mode selected by the environment rather than the config', async () => {
    const { exec } = await run({ processEnv: { RALPH_BANNER: 'off', TASK_SOURCE: 'folder' } })
    expect(exec.gh()).toHaveLength(0)
  })

  it('skips it in every mode that does not draw a table', async () => {
    for (const [mode, readRunState] of Object.entries({
      'never-run': () => null,
      idle: () => running({ status: 'completed', finished_at: RUN_STARTED.toISOString() }),
    })) {
      const { exec } = await run({ readRunState })
      expect(exec.titles(), mode).toHaveLength(0)
    }
    // `interrupted` reads the queue and the metrics (#59's plan) but draws no table,
    // so it buys no titles either.
    const { exec } = await run({ exec: makeExec({ tmuxResult: { exitCode: 1 } }) })
    expect(exec.titles()).toHaveLength(0)
    expect(exec.queue()).toHaveLength(1)
  })
})

describe('statusCommand — a title is a courtesy, and every way gh can fail proves it (#56)', () => {
  const answers = {
    // --- the transport failed, in each of the shapes it can fail in ---
    'gh is not installed': { failed: true, exitCode: undefined },
    'gh timed out': { timedOut: true },
    'gh is not authenticated': { exitCode: 4, stdout: '', stderr: 'gh: not logged in' },
    'gh exited nonzero with JSON on stdout anyway': {
      exitCode: 1,
      stdout: '[{"number":29,"title":"x"}]',
    },
    'the call resolves with nothing at all': RESOLVES_UNDEFINED,

    // --- the transport worked and the PAYLOAD is wrong ---
    'an empty array, from a repo with no issues': titlesOf('[]'),
    'an empty stdout': titlesOf(''),
    'a stdout of only whitespace': titlesOf('   ' + LF + '  '),
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
    'a negative number': titlesOf('[{"number":-29,"title":"sidebar"}]'),
    'a null title': titlesOf('[{"number":29,"title":null}]'),
    'a numeric title': titlesOf('[{"number":29,"title":42}]'),
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
    'a 5 MB payload': titlesOf(JSON.stringify([{ number: 29, title: 'x'.repeat(5 * 1024 * 1024) }])),
  }

  for (const [label, titlesResult] of Object.entries(answers)) {
    it(`exits 0 and still rows every task for ${label}`, async () => {
      const { result, lines } = await run({ exec: makeExec({ titlesResult }) })
      expect(result.exitCode, label).toBe(0)
      // The table is still there, with a row per task: the numbers are the fact, the
      // titles were only ever the context.
      const header = headerIndex(lines)
      expect(header, `${label}\n${lines.join('\n')}`).toBeGreaterThan(0)
      for (const number of ['#029', '#030', '#031']) {
        expect(
          lines.some((line) => line.includes(number)),
          `${label} → ${number}`,
        ).toBe(true)
      }
      // ...and the lines either side of it are intact.
      expect(lines[0], label).toContain('▸ ralph — running')
      expect(
        lines.some((line) => line.includes('2/9 done')),
        label,
      ).toBe(true)
      expect(
        lines.some((line) => line.includes('6 waiting')),
        label,
      ).toBe(true)
      // Nothing anywhere claims a cost or a number it does not have.
      expect(lines.join('\n'), label).not.toMatch(/NaN|Infinity|\$0\.00|undefined/)
      expect({}.pwned, label).toBeUndefined()
    })
  }

  it('writes nothing to stderr — there is no stderr in the deps bag to write to', async () => {
    // Load-bearing under `--json`: a diagnostic about a failed courtesy would have to
    // go somewhere, and the design decision is that it goes nowhere.
    const { result } = await run({
      exec: makeExec({ titlesResult: { failed: true, exitCode: undefined } }),
    })
    expect(result.exitCode).toBe(0)
    expect('stderr' in deps()).toBe(false)
  })
})

describe('statusCommand — an issue title is text somebody else wrote, arriving over a pipe (#56)', () => {
  const hostile = {
    'a raw CSI colour sequence': ESC + '[31mred' + ESC + '[0m',
    'an OSC that would retitle the terminal window': ESC + ']0;pwned' + BEL,
    'an unterminated CSI sequence': ESC + '[38;5;213',
    'a bidi override that would reorder the line': 'safe' + cp(0x202e) + 'gnorw' + cp(0x202c),
    'a newline that would forge a row': 'a' + LF + '  #999 forged   ✅ pass     $0.01     1min',
    'a carriage return that would overwrite the line': 'a' + CR + 'ERASED',
    'a vertical tab': 'a' + VT + 'b',
    'a form feed that would clear the screen': 'a' + FF + 'b',
    'a NUL byte': 'a' + NUL + 'b',
    'a backspace': 'a' + BS + 'b',
    'a DEL': 'a' + DEL + 'b',
    'a line separator': 'a' + cp(0x2028) + 'b',
    'a paragraph separator': 'a' + cp(0x2029) + 'b',
    'a zero-width space': 'a' + cp(0x200b) + 'b',
    'a lone surrogate': 'a' + String.fromCharCode(0xd800) + 'b',
    'a title of four thousand characters': 'x'.repeat(4000),
    'a title that is nothing but escapes': (ESC + '[0m').repeat(3),
    'a CJK title, which is two columns per character': '日本語のタイトル',
    'an emoji title, which is two columns per code point': cp(0x1f680).repeat(12),
  }

  for (const [label, title] of Object.entries(hostile)) {
    it(`prints no escape, no control character and no extra line for ${label}`, async () => {
      const { result, lines, stdout } = await run({
        exec: makeExec({
          titlesResult: titlesOf(
            JSON.stringify([
              { number: 29, title },
              { number: 30, title: 'persist' },
            ]),
          ),
        }),
      })
      expect(result.exitCode, label).toBe(0)
      for (const line of lines) {
        // Cc/Cs/Co/Zl/Zp AND Cf: the format characters are the nastier half, since one
        // override reorders the rest of the LINE and could rewrite the verdict beside it.
        expect(line, label).not.toMatch(/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Cf}]/u)
      }
      // The write is whole lines, each ending in one newline — no partial line.
      expect(stdout.output().endsWith('\n'), label).toBe(true)
      // And the row count is untouched: header plus exactly three tasks, each still
      // opening with the number the file recorded, then the blank that stands the table
      // off from `queue`. Forged text is allowed to survive inside the cell it was
      // written in — that is what a title IS — but it cannot become a line of its own.
      const header = headerIndex(lines)
      expect(header, label).toBeGreaterThan(0)
      expect(
        lines.slice(header + 1, header + 4).map((line) => line.trim().slice(0, 4)),
        label,
      ).toEqual(['#029', '#030', '#031'])
      expect(lines[header + 4], label).toBe('')
      expect(lines[header + 5], label).toContain('queue')
    })
  }
})

describe('statusCommand --json — #56 changed the terminal, and the document did not notice (#56)', () => {
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
    expect(out).not.toContain('progress   ')
  })

  it('is byte-identical however the title lookup would have answered', async () => {
    // It never runs under `--json`, and this is the assertion that keeps it that way:
    // a consumer diffing two documents must never see prose appear in one of them.
    const base = await docFor({})
    for (const titlesResult of [
      WORKED_TITLES,
      titlesOf('not json'),
      { failed: true, exitCode: undefined },
      RESOLVES_UNDEFINED,
    ]) {
      expect(await docFor({ exec: makeExec({ titlesResult }) })).toBe(base)
    }
  })

  it('publishes no rows, no titles and no table furniture', async () => {
    const out = await docFor({})
    expect(out).not.toContain('title')
    expect(out).not.toContain('verdict')
    expect(out).not.toContain('sidebar')
    expect(Object.keys(JSON.parse(out))).toEqual([
      'mode',
      'run_id',
      'progress',
      'tasks',
      'pace',
      'eta',
      'spend',
      'digest',
    ])
  })
})

// ---------------------------------------------------------------------------
// #132 — WHO PAYS FOR A TICKET'S SUMMARY. Point 2 at the top of this file says the title
// lookup runs "only when GitHub is the task source", and until this slice that was the
// intent rather than the code: the gate was `source !== 'folder'`, so a jira run paid for a
// `gh issue list` whose numeric map could title nothing (lib/progress.js looks a keyed row
// up by its KEY). #132 narrows the gate to the source it belongs to and gives jira its own
// resolver, and the four questions are the ones only the shell can be wrong about:
//
//   github  → `readIssueTitles`, byte for byte what #56 shipped. Nothing above this line
//             changes, which is what every assertion earlier in this file already pins.
//   jira    → an injected seam backed by lib/jira-queue.js's `titlesFor`, asked ONCE for the
//             keys the table is about to draw. Injected for the reason `jiraQueueCount` is:
//             no test in this suite may reach a real `acli`.
//   folder  → neither, still. That mode is deliberately gh-free AND board-free.
//   --json  → neither, still. The document publishes no summary, and skipping the call is
//             what keeps `--json` the cheap surface a prompt can poll.
// ---------------------------------------------------------------------------

const JIRA_JQL = 'project = RALPH AND statusCategory != Done'
const CONFIG = (source) => `TASK_SOURCE="${source}"${LF}JIRA_JQL="${JIRA_JQL}"${LF}`

// Two closed jira iterations, shaped as lib/capture-issue-event.js appends them (#131): the
// key, and the number derived from it.
const JIRA_METRICS =
  [
    { issue_number: 41, task_key: 'FOO-41', run_id: RUN, ts: 1, duration_ms: 97 * MIN, total_cost_usd: 34.45, verdict: 'pass' },
    { issue_number: 42, task_key: 'FOO-42', run_id: RUN, ts: 2, duration_ms: 71 * MIN, total_cost_usd: 28.4, verdict: 'pass' },
  ]
    .map((e) => 'RALPH_ISSUE_EVENT ' + JSON.stringify(e))
    .join('\n') + '\n'

const SUMMARIES = {
  'FOO-41': 'the sidebar ticket',
  'FOO-42': 'the persistence ticket',
  'FOO-43': 'the row component',
}

// A recording title resolver in the shape `titlesFor` has — `{keys, exec}` in, a key→summary
// map out. `answer` may be a map, or a function of the keys, or a thrown error.
const makeJiraTitles = (answer = SUMMARIES) => {
  const calls = []
  const resolver = async ({ keys, exec }) => {
    calls.push({ keys, exec })
    if (typeof answer === 'function') return answer(keys)
    if (answer instanceof Error) throw answer
    return answer
  }
  resolver.calls = calls
  return resolver
}

// A repo whose ralph.config.sh names a source, with a jira run recorded in it.
const sourced = (source, overrides = {}) => ({
  exists: (p) => String(p).endsWith('ralph.config.sh'),
  readFile: (p) =>
    String(p).endsWith('ralph.config.sh')
      ? CONFIG(source)
      : String(p).endsWith('issues.jsonl')
        ? JIRA_METRICS
        : '',
  readRunState: () =>
    running({
      source,
      current: { number: 43, task_key: 'FOO-43', started_at: TASK_STARTED.toISOString(), iteration: 3 },
    }),
  jiraQueueCount: async () => 6,
  ...overrides,
})

describe('statusCommand — a jira table is titled from the BOARD, not from GitHub (#132)', () => {
  it('renders key and summary on every row, and asks acli exactly once for all of them', async () => {
    const jiraTitles = makeJiraTitles()
    const { result, lines, exec } = await run(sourced('jira', { jiraTitles }))
    expect(result.exitCode).toBe(0)
    const header = headerIndex(lines)
    expect(lines.slice(header, header + 4)).toEqual([
      '  task                           verdict     cost      time',
      '  FOO-41 the sidebar ticket      ✅ pass     $34.45    97min',
      '  FOO-42 the persistence ticket  ✅ pass     $28.40    71min',
      '  FOO-43 the row component       🔄 live     –         ~40min',
    ])
    // ONE call, for the three keys the table draws, in row order with the in-flight one last.
    expect(jiraTitles.calls).toHaveLength(1)
    expect(jiraTitles.calls[0].keys).toEqual(['FOO-41', 'FOO-42', 'FOO-43'])
    // ...and NOT one `gh issue list` — the gate is `=== 'github'` now.
    expect(exec.gh()).toHaveLength(0)
  })

  it('hands the resolver the spawner this command already injected', async () => {
    // The seam's own seam: `titlesFor` needs a spawner and has no default, so a resolver
    // handed no `exec` would reach for nothing and every summary would go missing.
    const jiraTitles = makeJiraTitles()
    const d = deps(sourced('jira', { jiraTitles }))
    await statusCommand(d)
    expect(jiraTitles.calls[0].exec).toBe(d.exec)
  })

  it('shows the keys with no summaries for every way the board can fail to answer', async () => {
    // A COURTESY, never a fact — the posture `readIssueTitles` already has, asserted for the
    // second resolver: exit 0, a table of keys, and no word on stderr (there is none).
    const answers = {
      'an empty map': {},
      'a resolver that throws': new Error('acli is not installed'),
      'a resolver that answers nothing': () => undefined,
      'a resolver that answers a string': () => 'FOO-41',
      'a resolver that answers a number': () => 42,
      'a resolver that answers null': () => null,
    }
    for (const [what, answer] of Object.entries(answers)) {
      const { result, lines } = await run(sourced('jira', { jiraTitles: makeJiraTitles(answer) }))
      expect(result.exitCode, what).toBe(0)
      const header = headerIndex(lines)
      expect(lines[header + 1], what).toContain('FOO-41')
      expect(lines[header + 3], what).toContain('🔄 live')
      expect(lines.join('\n'), what).not.toContain('the sidebar ticket')
    }
  })

  it('asks about nothing, and does not call the resolver, when no row has a key', async () => {
    // A jira repo whose recorded run predates #131 (or whose keys were unreadable) has no key
    // to ask about, and an `acli` process for an empty list is a process for nothing.
    const jiraTitles = makeJiraTitles()
    const { result, lines, exec } = await run(
      sourced('jira', {
        jiraTitles,
        readFile: (p) =>
          String(p).endsWith('ralph.config.sh') ? CONFIG('jira') : String(p).endsWith('issues.jsonl') ? METRICS : '',
        readRunState: () => running({ source: 'jira' }),
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(jiraTitles.calls).toEqual([])
    expect(exec.gh()).toHaveLength(0)
    expect(lines[headerIndex(lines) + 1]).toContain('#029')
  })

  it('leaves github mode on `readIssueTitles` and never on the jira resolver', async () => {
    const jiraTitles = makeJiraTitles()
    const { lines, exec } = await run({ exec: makeExec({ titlesResult: WORKED_TITLES }), jiraTitles })
    expect(exec.titles()).toHaveLength(1)
    expect(jiraTitles.calls).toEqual([])
    expect(lines[headerIndex(lines) + 1]).toContain('#029 sidebar')
  })

  it('leaves folder mode paying for neither lookup', async () => {
    const jiraTitles = makeJiraTitles()
    const { result, exec } = await run(
      sourced('folder', { jiraTitles, folderQueueCount: async () => 6 }),
    )
    expect(result.exitCode).toBe(0)
    expect(exec.gh()).toHaveLength(0)
    expect(jiraTitles.calls).toEqual([])
  })

  it('makes NO title call of either kind under --json, and still names the ticket', async () => {
    // The document publishes the key (#132) and no summary, so the call it does not make is
    // the whole saving: `--json` stays the cheap surface.
    const jiraTitles = makeJiraTitles()
    const d = deps(sourced('jira', { jiraTitles, json: true }))
    const result = await statusCommand(d)
    expect(result.exitCode).toBe(0)
    expect(jiraTitles.calls).toEqual([])
    expect(d.exec.gh()).toHaveLength(0)
    const doc = JSON.parse(d.stdout.output())
    expect(doc.tasks.current.task_key).toBe('FOO-43')
    expect(Object.keys(doc.tasks.current)).toEqual(['number', 'started_at', 'task_key'])
    // Still no prose of any kind in the document.
    expect(d.stdout.output()).not.toContain('the sidebar ticket')
    expect(d.stdout.output()).not.toContain('title')
  })

  it('cannot be made to draw a forged row through a summary the board printed', async () => {
    // acli printed this text and bash passed it along, so it is untrusted exactly as a GitHub
    // issue title is. The scrubbing lives in the pure module; this is the assertion that the
    // shell really does route a jira summary through it.
    const forged = `sum${ESC}[31mmary${BEL}${CR}${LF}  #999  ✅ pass     $0.00     1min`
    const { result, lines } = await run(
      sourced('jira', { jiraTitles: makeJiraTitles({ 'FOO-41': forged }) }),
    )
    expect(result.exitCode).toBe(0)
    const joined = lines.join('\n')
    for (const byte of [ESC, BEL, CR, NUL, VT, FF, BS, DEL]) expect(joined.includes(byte)).toBe(false)
    // The forged row's text survives as TEXT, in the one cell it was printed into — a whole
    // scrubbed line collapsed into `FOO-41`'s title — and never as a fourth row: header plus
    // three, then the blank line that ends the block.
    const forgedRows = lines.filter((line) => line.includes('#999'))
    expect(forgedRows).toHaveLength(1)
    expect(forgedRows[0]).toContain('FOO-41')
    expect(headerIndex(lines) + 4).toBe(lines.indexOf('', headerIndex(lines)))
  })

  it('costs one acli count and one acli title lookup, and no gh at all', async () => {
    // The whole spawn budget of a jira `ralph status`, stated where it can regress: the count
    // through `jiraQueueCount`, the summaries through the resolver, and nothing else. Before
    // #132 there was a third process — a `gh issue list` whose answer titled no row.
    const jiraTitles = makeJiraTitles()
    const counts = []
    const { exec } = await run(
      sourced('jira', {
        jiraTitles,
        jiraQueueCount: async (args) => {
          counts.push(args)
          return 6
        },
      }),
    )
    expect(counts).toHaveLength(1)
    expect(jiraTitles.calls).toHaveLength(1)
    // Nothing else is spawned. `git rev-parse` anchors the read at the run's root and `tmux
    // has-session` is the liveness probe — the two every mode pays for; there is no third.
    expect(exec.calls.map((c) => c.cmd).sort()).toEqual(['git', 'tmux'])
  })
})
