import { describe, it, expect } from 'vitest'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { statusCommand } from './status.js'
import { composeBanner } from '../banner-compose.js'

// #76 — the identity box at the head of `ralph status`.
//
// `ralph status` is the command whose output gets SCREENSHOTTED. A progress table with a
// pace, an ETA and a spend on it says everything about a run except which run it was, so
// the box goes above the report for exactly the reason it went above `ralph doctor`'s
// dependency list in #75: one picture, and the reader knows which Ralph produced it and
// where. The box's shape, its width ladder and its colours are lib/banner-compose.js's and
// are asserted there; what this file asserts is everything that is `ralph status`'s:
//
//   1. THE BOX IS FIRST, above the live view and above the report card, with exactly one
//      blank line between the two — and the report below it is byte-identical to the
//      report the same run prints with the box off. The box is additive OUTPUT, never a
//      re-baselining of the view (status.test.js and status.qa.test.js pin that view line
//      by line, and they pin it with the box silenced for exactly this reason).
//   2. THE LADDER IS THE MODULE'S, not a second implementation. Asserted as an IDENTITY
//      against `composeBanner` called directly with the same facts at the same width, at
//      every rung of #72's ladder — which is a stronger statement than "it degrades",
//      because it is the statement that there is nothing here to degrade differently.
//   3. NO SPRITE, NO ANIMATION, at any setting. `ralph status` is piped into prompts,
//      status lines and screenshots; it draws no pixels and moves no cursor, and it cannot
//      even reach the code that would (asserted on the source, not just on the output).
//   4. `--json` IS UNTOUCHED, to the byte. The document is #58's published contract and a
//      consumer reading it through `jq` must not have to know a banner exists.
//   5. never-run PRINTS NO BOX AND STILL READS NOTHING. The box identifies a RUN, and that
//      mode has none — it stays the one-line pointer that costs nothing at all.
//   6. NOTHING ELSE MOVED: exit 0 in all four modes, in every banner mode, and the same
//      returned shape a programmatic caller reads.
//
// Every run injects the cwd, the exec double, the config seams, the clock and the
// environment, so no test here reads the developer's checkout, shell or terminal (#41).

const REPO = '/repo'
const NESTED = '/repo/sub/deeper'
const SESSION = 'ralph-ralph-b36ff7b1'
const VERSION = '0.17.0'

// Local Date constructors, for the reason status.test.js states: the rendered `16:20` is a
// wall-clock reading, so a UTC ISO fixture would make the expectation timezone-dependent.
const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()
const RUN_FINISHED = new Date(2026, 7, 25, 14, 2, 0)

// Strip ANSI so assertions on the frame hold whether or not colour was permitted — and
// built out of `fromCharCode` rather than a literal ESC, for the reason the sprite patterns
// below spell out.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI_RE, '')

// The splash player's two cursor sequences (lib/sprite-player.js), as PATTERNS rather than
// as bytes — `\u001B` and not a literal ESC, because a control byte committed into a source
// file makes `file` call it `data` and takes the whole test out of grep, rg and git grep. A
// suite nobody can search is a suite nobody maintains.
const HIDE_OR_SHOW_CURSOR = /\u001B\[\?25[lh]/
const MOVE_CURSOR_UP = /\u001B\[\d*[AF]/
// Any escape at all. The box status draws has no painted row — it passes neither
// `latestVersion` nor `cachedLatest`, the only two facts composeBanner colours — so the
// honest expectation is not "no colour we did not ask for" but NOT ONE ESCAPE BYTE.
const ANY_ESCAPE = /\u001B/

function makeStream({ columns } = {}) {
  const chunks = []
  const stream = {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
    raw: () => chunks.join(''),
    lines: () => stripAnsi(chunks.join('')).split('\n').slice(0, -1),
  }
  // Only when a test says so: an absent `columns` is what a pipe reports, and that is the
  // width every launchd log and CI transcript is measured at.
  if (columns !== undefined) stream.columns = columns
  return stream
}

const runningRecord = (overrides = {}) => ({
  schema: 1,
  run_id: SESSION,
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

const terminalRecord = (overrides = {}) => ({
  ...runningRecord(),
  status: 'partial',
  finished_at: RUN_FINISHED.toISOString(),
  ok: 2,
  failed: 1,
  ...overrides,
})

// git rev-parse answers the repo root, tmux has-session decides liveness, gh issue list
// answers the queue count — the same double status.test.js uses, so the box is asserted
// against the view the rest of the suite pins.
function makeExec({ sessionAlive = true, ghQueue = '6', ghExitCode = 0, gitRoot = '' } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: gitRoot === null ? 1 : 0, stdout: gitRoot ?? '', stderr: '' }
    }
    if (cmd === 'tmux' && args[0] === 'has-session') {
      return { exitCode: sessionAlive ? 0 : 1, stdout: '', stderr: '' }
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { exitCode: ghExitCode, stdout: ghQueue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.of = (cmd) => calls.filter((c) => c.cmd === cmd)
  return exec
}

// ralph.config.sh as a text seam, absent by default: no test depends on the file the
// developer happens to have in their checkout, and every read of it is recorded — the box
// must not add a SECOND read of a file this command already opens once for two other
// questions (#63).
function configSeams(text) {
  const reads = []
  return {
    reads,
    exists: (p) => {
      reads.push({ op: 'exists', path: String(p) })
      return String(p).endsWith('ralph.config.sh') && text !== undefined
    },
    readFile: (p) => {
      const path = String(p)
      // Only the config is answered here; issues.jsonl and digest.log read as absent, so
      // the view under the box is the documented no-metrics one.
      if (!path.endsWith('ralph.config.sh')) return ''
      reads.push({ op: 'read', path })
      return text ?? ''
    },
  }
}

function statusDeps({
  cwd = REPO,
  record = runningRecord(),
  exec = makeExec(),
  config,
  processEnv = {},
  columns,
  extra = {},
} = {}) {
  const stdout = makeStream({ columns })
  const seams = configSeams(config)
  const deps = {
    cwd,
    stdout,
    exec,
    exists: seams.exists,
    readFile: seams.readFile,
    readRunState: () => record,
    folderQueueCount: async () => 6,
    peekLock: () => null,
    now: () => NOW,
    processEnv,
    currentVersion: VERSION,
    // The banner emits no escape byte for the two facts `ralph status` passes, so this is
    // `false` in production too — see status.js. Pinned explicitly here all the same, and
    // exercised as `true` further down, so "unaffected by colour" is measured rather than
    // inherited from a default.
    color: false,
    ...extra,
  }
  deps.seams = seams
  return deps
}

const run = async (opts) => {
  const deps = statusDeps(opts)
  const result = await statusCommand(deps)
  return { result, deps, out: deps.stdout.output(), lines: deps.stdout.lines() }
}

/** The box's rows are `label value` pairs in an eight-column gutter. */
const GUTTER = 8
const prefixFor = (label) => `│ ${label.padEnd(GUTTER)}`
const rowValue = (out, label) => {
  const prefix = prefixFor(label)
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}
const rowLabels = (out) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('│ '))
    .map((l) => l.slice(2, 2 + GUTTER).trimEnd())
const titleVersion = (out) => {
  const line = out.split('\n').find((l) => l.startsWith('╭'))
  const match = line === undefined ? null : /^╭─ ralph (.*?) ─+╮$/.exec(line)
  return match ? match[1] : undefined
}
const boxLines = (out) => out.split('\n').filter((l) => /^[╭│╰]/.test(l))
/** Where the view starts: its heading is the one line in this command that begins `▸`. */
const viewIndex = (lines) => lines.findIndex((l) => l.startsWith('▸ ralph — '))

describe('status identity box (#76) — above the report, so a screenshot names its run', () => {
  it('prints the box first, then ONE blank line, then the live view', async () => {
    const { lines } = await run()
    expect(lines[0].startsWith(`╭─ ralph ${VERSION} `)).toBe(true)
    expect(lines[1].startsWith('│ cwd     ')).toBe(true)
    expect(lines[2]).toMatch(/^╰─+╯$/)
    // The separator, and the only blank between the identity block and the report.
    expect(lines[3]).toBe('')
    expect(viewIndex(lines)).toBe(4)
    expect(lines[4]).toContain(`▸ ralph — running · run ${SESSION}`)
  })

  it('prints the box above the report card too, for idle and for interrupted', async () => {
    // #59's morning-after card is the surface most likely to be pasted into a message —
    // "here is what last night did" — so it is the one that most needs to say which run.
    const cases = {
      idle: { record: terminalRecord() },
      interrupted: { exec: makeExec({ sessionAlive: false }) },
    }
    for (const [mode, opts] of Object.entries(cases)) {
      const { result, lines } = await run(opts)
      expect(result.mode, mode).toBe(mode)
      expect(lines[0].startsWith(`╭─ ralph ${VERSION} `), mode).toBe(true)
      expect(lines[3], mode).toBe('')
      expect(viewIndex(lines), mode).toBe(4)
      expect(lines[4], mode).toContain(`▸ ralph — ${mode} ·`)
    }
  })

  it('carries the injected version in the title and the RUN’s root in the cwd row', async () => {
    // The anchor that identifies the run, and it is the git toplevel rather than the cwd —
    // the record, the cycle lock, issues.jsonl and .ralph/digest.log are all keyed on it,
    // so it is the one path a reader can take back to the run. Asserted from a NESTED
    // directory whose `git rev-parse` answers a different toplevel, so the row cannot be
    // the cwd by accident.
    const { out } = await run({ cwd: NESTED, exec: makeExec({ gitRoot: `${REPO}\n` }) })
    expect(titleVersion(out)).toBe(VERSION)
    expect(rowValue(out, 'cwd')).toBe(REPO)
    expect(out).not.toContain(NESTED)
  })

  it('names the version it was given, and `unknown` when a caller cannot say', async () => {
    // The same fallback every other command uses for a package.json it could not read: a
    // title that claims nothing rather than a fabricated number.
    const { out } = await run({ extra: { currentVersion: undefined } })
    expect(titleVersion(out)).toBe('unknown')
  })

  it('carries the run’s ANCHOR and nothing else — no update hint, no cache verdict', async () => {
    // A DELIBERATE non-decision, and the reason there is no `cacheFs` seam in this file's
    // deps bag at all: `ralph status` is a read-only view people drive off a prompt timer,
    // and the "a newer Ralph is waiting" advice belongs to `ralph start` and `ralph
    // doctor`, which are the two commands a reader is in a position to act on. One row.
    const { out } = await run()
    expect(rowLabels(out)).toEqual(['cwd'])
    expect(out).not.toContain('update')
    expect(out).not.toContain('cached')
    expect(out).not.toContain('up to date')
  })

  it('reads no update-check cache — asserted on the source, not on a happy path', () => {
    const code = codeWithoutComments(new URL('./status.js', import.meta.url))
    expect(code).not.toMatch(/version-cache|readVersionCache|latest_version/)
  })

  it('leaves the report below it byte-identical to the same run with the box off', async () => {
    // THE PROPERTY THE REST OF THE STATUS SUITE RESTS ON. status.test.js and
    // status.qa.test.js pin the view line by line with `RALPH_BANNER=off`; this is what
    // makes those files still a test of what a default run prints.
    const boxed = await run()
    const bare = await run({ processEnv: { RALPH_BANNER: 'off' } })
    expect(boxed.out).toBe(boxLines(boxed.out).join('\n') + '\n' + '\n' + bare.out)
  })
})

describe('status identity box (#76) — the composition module’s ladder, not a second one', () => {
  // #72's ladder, asserted as an IDENTITY rather than as a description: whatever
  // composeBanner does at a width, this command does, because it is the same call.
  const rungs = [
    ['a pipe, which reports no columns at all', undefined],
    ['a very wide terminal, capped at the box’s 60', 200],
    ['exactly the box’s design width', 60],
    ['the narrowest terminal that still gets a frame', 44],
    ['one column below it, where the frame is dropped', 43],
    ['a 30-column terminal', 30],
    ['a terminal too narrow even for the sprite', 12],
  ]

  for (const [label, columns] of rungs) {
    it(`draws exactly what composeBanner draws at ${label}`, async () => {
      const { lines } = await run({ columns })
      const head = lines.slice(0, viewIndex(lines) - 1)
      expect(head).toEqual(
        composeBanner({
          facts: { version: VERSION, cwd: REPO },
          width: columns,
          capabilities: { color: false },
        }),
      )
      // ...and the guarantee that ladder exists for: no line wider than the terminal.
      const limit = columns === undefined ? 60 : Math.min(columns, 60)
      for (const line of head) expect([...line].length, `${label}: ${line}`).toBeLessThanOrEqual(limit)
    })
  }

  it('frames a wide terminal at 60 columns rather than at the terminal’s width', async () => {
    const { lines } = await run({ columns: 200 })
    expect([...lines[0]].length).toBe(60)
    expect(lines[0].startsWith('╭')).toBe(true)
    expect(lines[2]).toMatch(/^╰─+╯$/)
  })

  it('prints bare rows with no frame at all on a narrow terminal', async () => {
    const { lines, out } = await run({ columns: 30 })
    expect(out).not.toContain('│')
    expect(out).not.toContain('╭')
    expect(out).not.toContain('╰')
    expect(lines.slice(0, 2)).toEqual([`ralph ${VERSION}`, `cwd     ${REPO}`])
    // Still one blank line, and still the whole view under it.
    expect(lines[2]).toBe('')
    expect(viewIndex(lines)).toBe(3)
  })

  it('measures the STREAM it writes to, not the process’s terminal', async () => {
    // A piped or captured run must be measured on the stream it is actually writing to —
    // the same seam doctor takes, and the reason `columns` is an option rather than a read
    // of `process.stdout` inside the command.
    const narrow = await run({ columns: 30 })
    const wide = await run({ columns: 200 })
    expect(narrow.out).not.toBe(wide.out)
    expect(narrow.out).not.toContain('╭')
    expect(wide.out).toContain('╭')
  })
})

describe('status identity box (#76) — no sprite, no animation, at any setting', () => {
  for (const banner of [undefined, 'full', 'static', 'off', 'FULL', 'nonsense']) {
    it(`draws no pixels and moves no cursor with RALPH_BANNER=${String(banner)}`, async () => {
      const processEnv = banner === undefined ? {} : { RALPH_BANNER: banner }
      const { deps } = await run({ processEnv, config: banner })
      const raw = deps.stdout.raw()
      // The sprite's two glyphs (lib/sprite-render.js) and the player's cursor control.
      expect(raw).not.toContain('▀')
      expect(raw).not.toContain('▄')
      expect(raw).not.toMatch(HIDE_OR_SHOW_CURSOR)
      expect(raw).not.toMatch(MOVE_CURSOR_UP)
      expect(raw).not.toMatch(ANY_ESCAPE)
    })
  }

  it('emits not one escape byte even when colour is explicitly permitted', async () => {
    // The box status draws has no painted row, so `color` changes nothing — which is worth
    // pinning rather than assuming, because a command whose output is piped into prompts
    // and `--json` consumers has no business emitting an escape it was not asked for.
    const deps = statusDeps({ extra: { color: true } })
    await statusCommand(deps)
    expect(deps.stdout.raw()).not.toMatch(ANY_ESCAPE)
    expect(deps.stdout.raw()).toContain(`╭─ ralph ${VERSION} `)
  })

  it('cannot reach a sprite at all — asserted on the source, not the output', () => {
    // The ABSENCE of an animation cannot be shown by exercising happy paths: this command
    // must not be able to acquire one by accident. It is the absence of an IMPORT — the
    // pixels live in lib/sprite-banner.js and the splash player beside it, and this file
    // reaches neither, not even for the `colorEnabled` helper `ralph start` uses.
    // Read WITHOUT comments, because the comments are where the argument for all of this
    // is written down and they name the modules they are arguing against.
    const code = codeWithoutComments(new URL('./status.js', import.meta.url))
    expect(code).not.toMatch(/sprite/i)
    expect(code).not.toMatch(/playSplash|renderSplashFrames|colorEnabled/)
  })
})

describe('status identity box (#76) — RALPH_BANNER, one knob for every command', () => {
  it('prints nothing at all — no box, no blank line — for an explicit off', async () => {
    const { result, lines, out } = await run({ processEnv: { RALPH_BANNER: 'off' } })
    expect(result.exitCode).toBe(0)
    expect(boxLines(out)).toEqual([])
    expect(out).not.toContain(VERSION)
    // Not one byte between the command line and the first line of the report — no orphan
    // blank where the box used to be, exactly as `off` means in `ralph start`.
    expect(viewIndex(lines)).toBe(0)
  })

  it('honours RALPH_BANNER=off out of ralph.config.sh, not just the environment', async () => {
    const { out, deps } = await run({ config: 'RALPH_BANNER="off"\nTASK_SOURCE=github\n' })
    expect(boxLines(out)).toEqual([])
    // ONE read of ralph.config.sh, for the THREE questions this command asks of it: the
    // task source, the digest interval and now the banner. A second read would let a
    // config rewritten in between answer them differently.
    expect(deps.seams.reads.filter((r) => r.op === 'read')).toEqual([
      { op: 'read', path: `${REPO}/ralph.config.sh` },
    ])
  })

  it('lets the environment win over the config, like `ralph start` does', async () => {
    const { out } = await run({
      config: 'RALPH_BANNER=off\n',
      processEnv: { RALPH_BANNER: 'full' },
    })
    expect(titleVersion(out)).toBe(VERSION)
  })

  it('keeps the box for a value it does not recognize, and says nothing about it', async () => {
    // A typo'd knob costs a picture at worst. There is no warning here for the reason
    // doctor prints none: this command has no diagnostic channel at all — that absence is
    // what keeps `--json` pipeable — so a mistyped value gets the default box, silently,
    // and `ralph start` is where the user is told.
    const { out } = await run({ processEnv: { RALPH_BANNER: 'sprite-only-please' } })
    expect(titleVersion(out)).toBe(VERSION)
    expect(out).not.toContain('RALPH_BANNER')
    expect(out).not.toContain('unrecognized')
  })

  it('draws the box when there is no config file and nothing in the environment', async () => {
    const { out, deps } = await run()
    expect(titleVersion(out)).toBe(VERSION)
    // A missing file is probed once and never opened.
    expect(deps.seams.reads.filter((r) => r.op === 'read')).toEqual([])
  })
})

describe('status identity box (#76) — `--json` is untouched, to the byte', () => {
  const settings = [
    {},
    { RALPH_BANNER: 'full' },
    { RALPH_BANNER: 'static' },
    { RALPH_BANNER: 'off' },
    { RALPH_BANNER: 'junk' },
  ]

  for (const processEnv of settings) {
    it(`prints exactly one line — the document — with ${JSON.stringify(processEnv)}`, async () => {
      const deps = statusDeps({ processEnv, config: processEnv.RALPH_BANNER })
      const result = await statusCommand({ ...deps, json: true })
      expect(result.exitCode).toBe(0)
      const lines = deps.stdout.lines()
      expect(lines).toHaveLength(1)
      expect(lines[0][0]).toBe('{')
      expect(() => JSON.parse(lines[0])).not.toThrow()
      expect(deps.stdout.raw()).not.toMatch(ANY_ESCAPE)
    })
  }

  it('publishes the identical document whatever the banner says', async () => {
    const documents = []
    for (const processEnv of settings) {
      const deps = statusDeps({ processEnv })
      await statusCommand({ ...deps, json: true })
      documents.push(deps.stdout.output())
    }
    expect(new Set(documents).size).toBe(1)
  })

  it('resolves no banner and reads no config under the flag, in any mode', async () => {
    // `--json` returns before the box, so it must not have paid for one: the read plan
    // under the flag (#59) is unchanged, down to the probe.
    const cases = {
      running: {},
      interrupted: { exec: makeExec({ sessionAlive: false }) },
      idle: { record: terminalRecord() },
      'never-run': { record: null },
    }
    for (const [mode, opts] of Object.entries(cases)) {
      const deps = statusDeps({ ...opts, processEnv: { RALPH_BANNER: 'full' } })
      const result = await statusCommand({ ...deps, json: true })
      expect(result.exitCode, mode).toBe(0)
      expect(result.mode, mode).toBe(mode)
      expect(deps.stdout.lines().length, mode).toBe(1)
    }
  })
})

describe('status identity box (#76) — never-run stays the free one-line pointer', () => {
  it('prints no box, and still reads nothing at all', async () => {
    // The box identifies a RUN, and this mode has none. It is also the mode that must cost
    // nothing: no gh call, no folder scan, no metrics read, and NOT the config read that
    // would decide whether to draw a box — a repo with no record has nothing any of them
    // could say anything about.
    const { result, lines, deps } = await run({ record: null, config: 'RALPH_BANNER=full\n' })
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    expect(lines).toEqual([
      '▸ ralph — never-run · no run recorded yet (start one with `ralph start`)',
    ])
    expect(deps.seams.reads).toEqual([])
    expect(deps.exec.of('gh')).toEqual([])
  })

  it('prints no box outside a git work tree either', async () => {
    const { result, lines } = await run({
      cwd: '/tmp/not-a-repo',
      record: null,
      exec: makeExec({ gitRoot: null }),
    })
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('never-run')
    expect(lines).toHaveLength(1)
  })
})

describe('status identity box (#76) — nothing else moved', () => {
  it('exits 0 in all four modes, in every banner mode', async () => {
    const modes = {
      running: {},
      interrupted: { exec: makeExec({ sessionAlive: false }) },
      idle: { record: terminalRecord() },
      'never-run': { record: null },
    }
    for (const [mode, opts] of Object.entries(modes)) {
      for (const processEnv of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'static' }, { RALPH_BANNER: 'nope' }]) {
        for (const json of [false, true]) {
          const deps = statusDeps({ ...opts, processEnv })
          const result = await statusCommand({ ...deps, json })
          expect(result.exitCode, `${mode} / ${JSON.stringify(processEnv)} / json=${json}`).toBe(0)
          expect(result.mode, mode).toBe(mode)
        }
      }
    }
  })

  it('keeps the returned shape unchanged', async () => {
    const { result } = await run()
    expect(Object.keys(result).sort()).toEqual(['exitCode', 'mode', 'queue', 'record'])
  })

  // Everything the box added is reached with a value a caller has no business passing.
  // Scoped to exactly that: `cwd` and `processEnv` are NOT in this list because they were
  // already load-bearing for the queue count and the root before this slice, and widening
  // a hostile-input list is how a slice grows a refactor it did not ask for.
  const hostile = [
    ['a currentVersion that is not a string', { extra: { currentVersion: { toString: () => 'boom' } } }],
    ['a columns that is not a number', { columns: 'eighty' }],
    ['a zero-width terminal, the shape some CI runners report', { columns: 0 }],
    ['a readFile() that throws', { config: '', extra: { readFile: () => { throw new Error('boom') } } }],
    ['an exists() that throws', { extra: { exists: () => { throw new Error('boom') } } }],
  ]

  for (const [label, opts] of hostile) {
    it(`never lets the box cost the view — ${label}`, async () => {
      const { result, out } = await run(opts)
      expect(result.exitCode).toBe(0)
      expect(out).toContain('▸ ralph — running ·')
      expect(out).not.toContain('NaN')
      expect(out).not.toContain('undefined')
    })
  }

  it('is still read-only: every subprocess a read, and one state read', async () => {
    let reads = 0
    const deps = statusDeps({ extra: { readRunState: () => { reads += 1; return runningRecord() } } })
    await statusCommand(deps)
    expect(reads).toBe(1)
    for (const call of deps.exec.calls) {
      expect(call.key).toMatch(/^(git rev-parse|tmux has-session|gh issue list)/)
    }
  })

  it('writes the box through the command’s ONE stream call site', async () => {
    // status.js writes to exactly one stream through exactly one call — a property
    // status.json.qa.test.js asserts on the source because it is what keeps `--json`'s
    // stdout a document. The box must be printed through that same `out`, not through a
    // second `stdout.write`.
    const code = codeWithoutComments(new URL('./status.js', import.meta.url))
    expect(code.match(/\.write\(/g)).toHaveLength(1)
  })
})
