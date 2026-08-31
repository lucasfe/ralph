// #76 QA — adversarial specs for the identity box at the head of `ralph status`.
//
// status.identity-box.test.js proves the intended slice: the box is first, one blank line
// separates it from the report, the ladder is composeBanner's, `--json` is untouched and
// never-run still reads nothing. This file attacks the parts of that slice that belong to
// `ralph status` rather than to the box, and it is organised around what #76 actually did to
// this command — which is less than it looks, and the shape of the change decides what is
// worth attacking:
//
//   1. IT ADDED NO READ. `configText` was already computed by `collectStatus` before #76
//      (the same `readConfigText(resolve(root, 'ralph.config.sh'))` on the same `measured`
//      gate, for TASK_SOURCE and the digest interval); the diff only asks it a THIRD question
//      and returns the answer as `bannerSetting`. So the
//      interesting claim is not "the new read is safe" but "there is no new read" — pinned
//      here as exact per-mode op sequences on both surfaces, and as `exists`/`read` counts
//      of exactly one apiece for the config, so a future refactor that resolves the knob
//      with a second read of its own fails here rather than in a bug report about a file
//      that changed between two reads in one invocation.
//   2. IT PUT HOSTILE STRINGS IN A FRAME. `currentVersion` arrives from a parsed
//      package.json and `root` from `git rev-parse`'s stdout — a byte stream. A newline in
//      either would forge a row, an ESC would move a cursor, 200 characters would blow the
//      frame open. All three are composeBanner's job, so they are asserted here as an
//      IDENTITY against composeBanner under the hostile facts themselves: the claim is that
//      this command sanitises nothing of its own, and therefore cannot sanitise it wrongly.
//   3. IT MADE A READ-ONLY VIEW DEPEND ON A KNOB. RALPH_BANNER has to answer the same in
//      `ralph status` as in `ralph start` and `ralph doctor` — same precedence, same
//      spellings, same grammar in the file — so both sources are driven at once, in both
//      directions, and the one config read is proven to still answer TASK_SOURCE too.
//   4. IT MUST NOT HAVE TOUCHED `--json` OR THE EXIT CODE. Both are contracts other
//      programs gate on, so they are driven as a cross product of surface × mode × banner
//      setting × width rather than as happy paths, and the human report below the box is
//      asserted byte-identical across all of it.
//   5. IT MUST NOT HAVE MADE THE COMMAND FRAGILE. Every seam that can throw is made to
//      throw, in every mode, on both surfaces; the config is made 5 MiB of junk; the stream
//      reports backpressure; the gatherer is replaced with an older one that does not
//      return `bannerSetting` at all. None of it may change the exit code and none of it may
//      throw out of `statusCommand`.
//
// Every run injects the cwd, the exec double, the config seams, the clock, the environment,
// the column count, the colour capability and the version, so nothing here reads the
// developer's checkout, shell, terminal or package.json (#41).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { statusCommand, collectStatus } from './status.js'
import { composeBanner } from '../banner-compose.js'
import { runDigest } from '../digest.js'

const REPO = '/repo'
const NESTED = '/repo/sub/deeper'
const SESSION = 'ralph-ralph-b36ff7b1'
const VERSION = '0.17.0'
const FOLDER_QUEUE = 4
const BANNER_WIDTH = 60

// Local Date constructors, for the reason status.test.js states: the rendered `16:20` is a
// wall-clock reading, so a UTC ISO fixture would make the expectation timezone-dependent.
const RUN_STARTED = new Date(2026, 7, 25, 16, 20, 0)
const TASK_STARTED = new Date(2026, 7, 25, 18, 52, 0)
const RUN_FINISHED = new Date(2026, 7, 25, 14, 2, 0)
const NOW = new Date(2026, 7, 25, 19, 32, 0).getTime()

// Control bytes are BUILT, never typed: `String.fromCharCode`, the convention the dev's
// suite states in full, because a real ESC or NUL committed into a source file makes `file`
// call it `data` and takes the whole suite out of grep, rg and git grep — and a suite nobody
// can search is a suite nobody maintains. It also keeps them visible in review, which matters
// here: several fixtures below differ from the happy path by one invisible byte.
const ESC = String.fromCharCode(27)
const NUL = String.fromCharCode(0)
const BEL = String.fromCharCode(7)
const CR = String.fromCharCode(13)
const C1_CSI = String.fromCharCode(155)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(SGR, '')
const REPLACEMENT = '�'

// Everything an ANSI-aware terminal reads as an INSTRUCTION rather than as text: show/hide
// the cursor, move it, erase, scroll, save/restore. `ralph status` is refreshed on a timer
// and pasted into messages; it may not steer a cursor even by accident.
const CURSOR = new RegExp(`${ESC}\\[(?:\\?25[lh]|[0-9;]*[ABCDEFGHJKSTfnsu])|${ESC}[78MD]`)
// The half-block glyphs #72's sprite is drawn out of. Nothing on this command's graph can
// produce them, and that is asserted structurally further down; this is the output-side half.
const SPRITE_GLYPH = /[▀▄]/u

function makeStream({ columns } = {}) {
  const chunks = []
  const stream = {
    // `false` deliberately, the way status.qa.test.js's stream answers: a real stdout under
    // backpressure returns false from `write`, and a writer that treats that as a failure
    // would truncate the very output a screenshot is taken of.
    write: (s) => {
      chunks.push(s)
      return false
    },
    chunks,
    raw: () => chunks.join(''),
    output: () => stripAnsi(chunks.join('')),
    lines: () => stripAnsi(chunks.join('')).split('\n').slice(0, -1),
  }
  // Only when a test says so: an absent `columns` is what a pipe reports, and that is the
  // width every launchd log, CI transcript and `| pbcopy` is measured at.
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

function makeExec({ sessionAlive = true, ghQueue = '6', ghExitCode = 0, gitRoot = '', gitExitCode = 0 } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { exitCode: gitExitCode, stdout: gitRoot, stderr: '' }
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

/**
 * The filesystem as recorded seams — EVERY op, with its path, in order.
 *
 * The dev's suite records the config reads; this one records the metrics and digest reads
 * too, because the claim being made here is about the whole read plan and not just about
 * the file the knob lives in. "The box added no read" is only checkable against a full
 * sequence.
 */
function configSeams(text, options = {}) {
  const ops = []
  // Presence of the KEY, not truthiness of the value: half of what these seams exist for is
  // `throw null` and `return undefined`, and a truthiness test would quietly turn both of
  // those into the happy path and pass for the wrong reason.
  const throwsOnExists = 'existsThrows' in options
  const throwsOnRead = 'readThrows' in options
  const overridesRead = 'readReturns' in options
  const name = (p) => String(p).split('/').pop()
  return {
    ops,
    of: (file) => ops.filter((o) => o.file === file),
    exists: (p) => {
      ops.push({ op: 'exists', file: name(p), path: String(p) })
      if (throwsOnExists) throw options.existsThrows
      return name(p) === 'ralph.config.sh' && text !== undefined
    },
    readFile: (p) => {
      ops.push({ op: 'read', file: name(p), path: String(p) })
      if (throwsOnRead) throw options.readThrows
      if (overridesRead) return options.readReturns
      // issues.jsonl and digest.log read as absent-but-empty, so the view under the box is
      // the documented no-metrics one and the report stays comparable across every case.
      return name(p) === 'ralph.config.sh' ? (text ?? '') : ''
    },
  }
}

function makeDeps({
  cwd = REPO,
  record = runningRecord(),
  exec = makeExec(),
  config,
  seamOptions,
  processEnv = {},
  columns = 80,
  color = false,
  currentVersion = VERSION,
  json = false,
  stdout,
  extra = {},
} = {}) {
  const stream = stdout ?? makeStream({ columns })
  const seams = configSeams(config, seamOptions)
  const deps = {
    cwd,
    stdout: stream,
    exec,
    json,
    color,
    currentVersion,
    processEnv,
    exists: seams.exists,
    readFile: seams.readFile,
    readRunState: () => record,
    folderQueueCount: async () => FOLDER_QUEUE,
    peekLock: () => null,
    now: () => NOW,
    ...extra,
  }
  return { deps, stream, seams }
}

const run = async (opts = {}) => {
  const { deps, stream, seams } = makeDeps(opts)
  const result = await statusCommand(deps)
  return {
    result,
    seams,
    exec: deps.exec,
    stream,
    chunks: stream.chunks,
    raw: stream.raw(),
    out: stream.output(),
    lines: stream.lines(),
  }
}

// The four modes as FACTORIES, not as a literal table: every one of them owns an exec double
// that counts its own calls, and a shared one would accumulate across a loop and turn "one
// `gh` call per invocation" into an arithmetic accident.
const MODES = {
  running: () => ({}),
  interrupted: () => ({ exec: makeExec({ sessionAlive: false }) }),
  idle: () => ({ record: terminalRecord() }),
  'never-run': () => ({ record: null }),
}
const BOX_MODES = ['running', 'interrupted', 'idle']

/** Where the report starts: its heading is the one line in this command that begins `▸`. */
const reportIndex = (lines) => lines.findIndex((l) => l.startsWith('▸ ralph — '))
/** The identity block: everything above the blank separator, or nothing when there is no box. */
const identityLines = (lines) => {
  const at = reportIndex(lines)
  return at <= 0 ? [] : lines.slice(0, at - 1)
}
const separatorCount = (lines) => {
  const at = reportIndex(lines)
  return at <= 0 ? 0 : lines.slice(0, at).filter((l) => l === '').length
}
const reportLines = (lines) => {
  const at = reportIndex(lines)
  return at < 0 ? lines : lines.slice(at)
}
const GUTTER = 8
const rowValue = (out, label) => {
  const prefix = `│ ${label.padEnd(GUTTER)}`
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}
const titleVersion = (out) => {
  const line = out.split('\n').find((l) => l.startsWith('╭'))
  const match = line === undefined ? null : /^╭─ ralph (.*?) ─+╮$/.exec(line)
  return match ? match[1] : undefined
}
const hasBox = (lines) => identityLines(lines).length > 0
/** #72's ladder, as the width the box is allowed to occupy — mirrors `usableWidth` × the 60 cap. */
const expectedCap = (columns) => {
  if (typeof columns !== 'number' || !Number.isFinite(columns)) return BANNER_WIDTH
  const floored = Math.floor(columns)
  return floored >= 1 ? Math.min(floored, BANNER_WIDTH) : BANNER_WIDTH
}

describe('QA #76 — hostile facts reach the frame, and the frame is composeBanner’s', () => {
  // A package.json is JSON, so `version` can be any JSON value; `root` is the trimmed stdout
  // of a subprocess, so it is a byte string. Neither is validated by this command — on
  // purpose — so what is asserted is that composeBanner's refusal is what the user sees.
  const HOSTILE_VERSION = [
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a lone newline', '\n'],
    ['a tab', '\t'],
    ['a number', 42],
    ['null', null],
    ['a boolean', true],
    ['an array', ['9.9.9']],
    ['an object with a throwing toString', { toString() { throw new Error('boom') } }],
    ['a Symbol', Symbol('0.0.0')],
  ]

  it.each(HOSTILE_VERSION)('reads %s as `unknown` rather than fabricating a title', async (_label, currentVersion) => {
    const { result, lines, out } = await run({ currentVersion })
    // `unknown` and not a coerced `42`/`true`/`[object Object]`: composeBanner refuses
    // non-strings rather than calling `String()` on them, which is also why the throwing
    // `toString` above cannot reach a stack trace from here.
    expect(titleVersion(out)).toBe('unknown')
    expect(identityLines(lines)).toHaveLength(3)
    expect(result.exitCode).toBe(0)
  })

  const HOSTILE_TEXT = [
    ['a newline', '1.2\n3', `1.2${REPLACEMENT}3`],
    ['a carriage return in the middle', `1.0${CR}0`, `1.0${REPLACEMENT}0`],
    ['an SGR sequence', `${ESC}[31m9.9.9`, `${REPLACEMENT}[31m9.9.9`],
    ['a NUL', `1.0${NUL}0`, `1.0${REPLACEMENT}0`],
    ['a C1 control introducer', `1.0.0${C1_CSI}`, `1.0.0${REPLACEMENT}`],
    ['a BEL', `1.0.0${BEL}`, `1.0.0${REPLACEMENT}`],
  ]

  it.each(HOSTILE_TEXT)(
    'replaces %s in the version with one U+FFFD and forges no second row',
    async (_label, currentVersion, expected) => {
      const { lines, raw, out, chunks } = await run({ currentVersion })
      expect(titleVersion(out)).toBe(expected)
      // The frame is intact and closes exactly once: a surviving newline would have split a
      // row in two and left an unbalanced box.
      expect(identityLines(lines)).toHaveLength(3)
      for (const line of identityLines(lines)) expect([...line].length).toBe(BANNER_WIDTH)
      // ...and no terminal instruction, no bare CR and no NUL made it to the stream.
      expect(raw).not.toMatch(CURSOR)
      expect(raw).not.toContain('\r')
      expect(raw).not.toContain(NUL)
      expect(stripAnsi(raw)).not.toContain(ESC)
      // One line per write. A forged row would have arrived inside a chunk with two.
      for (const chunk of chunks) {
        expect((chunk.match(/\n/g) ?? []).length, JSON.stringify(chunk)).toBe(1)
      }
    },
  )

  it('clips a 200-character version and keeps the frame exactly 60 wide', async () => {
    const { lines, out } = await run({ currentVersion: `0.0.0-${'x'.repeat(200)}` })
    const title = out.split('\n')[0]
    expect([...title].length).toBe(BANNER_WIDTH)
    expect(title).toContain('…')
    expect(identityLines(lines)).toHaveLength(3)
  })

  const HOSTILE_ROOT = [
    ['a newline in the middle', '/re\npo\n', `/re${REPLACEMENT}po`],
    ['an erase-screen sequence', `/repo${ESC}[2J\n`, `/repo${REPLACEMENT}[2J`],
    ['a NUL', `/re${NUL}po\n`, `/re${REPLACEMENT}po`],
  ]

  it.each(HOSTILE_ROOT)(
    'sanitises %s in `git rev-parse`’s answer without breaking the cwd row',
    async (_label, gitRoot, expected) => {
      const { result, lines, raw, out } = await run({ exec: makeExec({ gitRoot }) })
      expect(rowValue(out, 'cwd')).toBe(expected)
      expect(identityLines(lines)).toHaveLength(3)
      expect(raw).not.toMatch(CURSOR)
      expect(raw).not.toContain(NUL)
      expect(stripAnsi(raw)).not.toContain(ESC)
      expect(result.exitCode).toBe(0)
    },
  )

  it('clips a 200-character root instead of blowing the frame open', async () => {
    const deep = `/${'d'.repeat(200)}`
    const { lines, out } = await run({ exec: makeExec({ gitRoot: `${deep}\n` }) })
    expect(rowValue(out, 'cwd').endsWith('…')).toBe(true)
    for (const line of identityLines(lines)) expect([...line].length).toBe(BANNER_WIDTH)
  })

  it('is byte-identical to composeBanner called with the same hostile facts', async () => {
    // The point of the whole group, stated as an identity: this command does not sanitise,
    // clip or pad anything of its own, so it cannot get any of it wrong. Driven with the
    // hostile facts rather than the clean ones — the dev's suite pins the identity at the
    // clean rungs of the ladder, and a hand-rolled `.slice(0, 48)` somewhere in this command
    // would survive that and die here.
    const cases = [
      { currentVersion: `${ESC}[31m9.9.9`, gitRoot: '/re\npo\n' },
      { currentVersion: 42, gitRoot: `/${'d'.repeat(200)}\n` },
      { currentVersion: `0.0.0-${'x'.repeat(200)}`, gitRoot: `/repo${NUL}\n` },
    ]
    for (const { currentVersion, gitRoot } of cases) {
      for (const columns of [undefined, 80, 44, 43, 26, 1]) {
        const { lines } = await run({ currentVersion, exec: makeExec({ gitRoot }), columns })
        const expected = composeBanner({
          facts: { version: currentVersion, cwd: gitRoot.trim() },
          width: columns,
          capabilities: { color: false },
        })
        expect(identityLines(lines), `${String(currentVersion).slice(0, 12)} @ ${columns}`).toEqual(expected)
      }
    }
  })

  it('shows the cwd, unsanitised of its own accord, when the run has no git root', async () => {
    // `resolveRoot` degrades to the cwd outside a work tree, and the box carries whatever it
    // answered — so the row says which directory the reader is looking at even when git
    // could not name a repo. The nested cwd also proves the box is NOT re-deriving a root of
    // its own: it reports the anchor the record was read from.
    const { out, result } = await run({ cwd: NESTED, exec: makeExec({ gitExitCode: 1 }) })
    expect(rowValue(out, 'cwd')).toBe(NESTED)
    expect(result.exitCode).toBe(0)
  })
})

describe('QA #76 — the knob answers the same here as everywhere else', () => {
  // The spellings that MUST silence the box. `resolveBannerMode` trims and lowercases, so a
  // config edited by hand and an env var exported with a stray tab both land on `off`.
  const OFF_SPELLINGS = [
    ['off', 'off'],
    ['OFF', 'OFF'],
    ['Off', 'Off'],
    ['padded with spaces', ' off '],
    ['a leading tab', '\toff'],
    ['a trailing newline', 'off\n'],
    ['CRLF on both sides', '\r\noff\r\n'],
  ]

  it.each(OFF_SPELLINGS)('silences the box for %s in the environment', async (_label, value) => {
    const { lines, result } = await run({ processEnv: { RALPH_BANNER: value } })
    expect(hasBox(lines)).toBe(false)
    expect(lines[0].startsWith('▸ ralph — ')).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  // ...and the spellings that must NOT. Every one of these is a plausible guess at "off"
  // that the knob does not register, and the decision they pin is that an unrecognised value
  // KEEPS the box: there is no diagnostic channel on this command (no stderr in its deps
  // bag), so silently obeying a guess would hide a typo behind exactly the missing picture
  // the user was trying to explain. `ralph start` is where a mistyped knob is reported.
  const NOT_OFF_SPELLINGS = [
    ['0', '0'],
    ['false', 'false'],
    ['none', 'none'],
    ['no', 'no'],
    ['disabled', 'disabled'],
    ['an empty string', ''],
    ['spaces only', '  '],
    ['quoted, the way a shell would not unquote it', '"off"'],
    ['off with a NUL stuck to it', `off${NUL}`],
    ['full', 'full'],
    ['static', 'static'],
    ['a typo', 'offf'],
  ]

  it.each(NOT_OFF_SPELLINGS)('keeps the box for %s, silently', async (_label, value) => {
    const { lines, raw, result } = await run({ processEnv: { RALPH_BANNER: value } })
    expect(hasBox(lines)).toBe(true)
    expect(identityLines(lines)).toHaveLength(3)
    // Silently: nothing about the knob is printed, and there is nowhere to print it to.
    expect(raw).not.toMatch(/RALPH_BANNER|banner/i)
    expect(result.exitCode).toBe(0)
  })

  // Non-string overrides, and the assertion documents a GAP rather than a decision: a
  // non-string RALPH_BANNER is "stated but unusable" to `statedValue`, which returns
  // `{ raw, text: null }` — stated, so it OUTRANKS the config, and unusable, so it resolves
  // to the default. A caller that reaches statusCommand programmatically with
  // `processEnv: { RALPH_BANNER: 42 }` therefore overrides a config `off` with a box. It
  // cannot happen through a shell (process.env values are strings) and it is the same
  // behaviour `ralph doctor` has, which is the argument for pinning it rather than filing
  // it: if it is ever fixed, it must be fixed in banner-mode.js for every command at once.
  const NON_STRING_OVERRIDES = [
    ['a number', 42],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
    ['a function that returns off', () => 'off'],
    ['a Symbol', Symbol('off')],
  ]

  it.each(NON_STRING_OVERRIDES)('lets %s in the environment outrank a config `off` (documented gap)', async (_label, value) => {
    const { lines } = await run({ processEnv: { RALPH_BANNER: value }, config: 'RALPH_BANNER=off\n' })
    expect(hasBox(lines)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('treats %s in the environment as absent and defers to the config', async (_label, value) => {
    const { lines } = await run({ processEnv: { RALPH_BANNER: value }, config: 'RALPH_BANNER=off\n' })
    expect(hasBox(lines)).toBe(false)
  })

  // Every shape parse-config-var.js must handle, and the answer it must give. Same table as
  // doctor.identity-box.qa.test.js's, deliberately: one grammar, asserted per command, so a
  // change to the parser cannot silently mean two different things in two views.
  const CONFIG_GRAMMAR = [
    ['a bare assignment', 'RALPH_BANNER=off', true],
    ['an exported assignment', 'export RALPH_BANNER=off', true],
    ['leading spaces', '   RALPH_BANNER=off', true],
    ['a leading tab', '\tRALPH_BANNER=off', true],
    // Not an assignment to bash and, since #147, not one here either: the shared grammar
    // requires the name to end at the `=`, so this line silences nothing and the box is drawn.
    // Same flip as doctor.identity-box.qa.test.js's row, in the same slice, which is what "one
    // grammar, asserted per command" is for.
    ['spaces around the equals', 'RALPH_BANNER = off', false],
    ['double quotes', 'RALPH_BANNER="off"', true],
    ['single quotes', "RALPH_BANNER='off'", true],
    ['quoted with padding inside', 'RALPH_BANNER=" off "', true],
    ['a trailing comment', 'RALPH_BANNER=off # quiet', true],
    ['a quoted value with a trailing comment', 'RALPH_BANNER="off" # quiet', true],
    ['two spaces before the comment', 'RALPH_BANNER=off  #note', true],
    ['CRLF line endings', 'RALPH_BANNER=off\r\nTASK_SOURCE=github\r\n', true],
    ['upper case', 'RALPH_BANNER=OFF', true],
    ['the last assignment winning', 'RALPH_BANNER=full\nRALPH_BANNER=off', true],
    ['a later commented-out line', 'RALPH_BANNER=off\n# RALPH_BANNER=full', true],
    ['company among other settings', 'TASK_SOURCE=folder\n\n# banner\nRALPH_BANNER=off\nX=1', true],
    ['a commented-out assignment', '# RALPH_BANNER=off', false],
    ['a commented-out assignment, no space', '#RALPH_BANNER=off', false],
    ['an indented comment', '   # RALPH_BANNER=off', false],
    ['a value that is only a comment', 'RALPH_BANNER=#off', false],
    ['a name with a prefix', 'MY_RALPH_BANNER=off', false],
    ['a name with a suffix', 'RALPH_BANNERX=off', false],
    ['the wrong case in the name', 'ralph_banner=off', false],
    ['an earlier assignment losing', 'RALPH_BANNER=off\nRALPH_BANNER=full', false],
    ['a trailing semicolon', 'RALPH_BANNER=off;', false],
    ['a comment with no space before it', 'RALPH_BANNER=off#note', false],
    ['an empty file', '', false],
  ]

  it.each(CONFIG_GRAMMAR)('reads %s in ralph.config.sh the way the parser does', async (label, text, silenced) => {
    const { lines, result } = await run({ config: `${text}\n` })
    expect(hasBox(lines), `${label}: ${JSON.stringify(text)} should ${silenced ? '' : 'not '}silence the box`).toBe(
      !silenced,
    )
    expect(result.exitCode).toBe(0)
  })

  it('lets the environment win over the config, in both directions', async () => {
    const on = await run({ config: 'RALPH_BANNER=off\n', processEnv: { RALPH_BANNER: 'full' } })
    expect(hasBox(on.lines)).toBe(true)
    const off = await run({ config: 'RALPH_BANNER=full\n', processEnv: { RALPH_BANNER: 'off' } })
    expect(hasBox(off.lines)).toBe(false)
  })

  it('answers TASK_SOURCE and RALPH_BANNER out of the SAME one read', async () => {
    // The load-bearing test of the whole read-plan argument. One file, two settings, one
    // read: the box is silenced AND the queue comes from the folder rather than from `gh`.
    // A second reader added for the banner would show up here as a second recorded read.
    const { lines, seams, exec, result } = await run({
      config: 'TASK_SOURCE=folder\nRALPH_BANNER=off\n',
    })
    expect(hasBox(lines)).toBe(false)
    expect(exec.of('gh')).toHaveLength(0)
    expect(result.queue).toBe(FOLDER_QUEUE)
    expect(seams.of('ralph.config.sh').filter((o) => o.op === 'read')).toHaveLength(1)
    expect(seams.of('ralph.config.sh').filter((o) => o.op === 'exists')).toHaveLength(1)
  })

  it('opens ralph.config.sh at most once, in every mode and at every setting', async () => {
    for (const [mode, factory] of Object.entries(MODES)) {
      for (const processEnv of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'typo' }]) {
        for (const config of [undefined, 'RALPH_BANNER=off\n', 'RALPH_BANNER=full\n']) {
          for (const json of [false, true]) {
            const { seams } = await run({ ...factory(), processEnv, config, json })
            const label = `${mode} / ${JSON.stringify(processEnv)} / ${config} / json=${json}`
            expect(seams.of('ralph.config.sh').filter((o) => o.op === 'read').length, label).toBeLessThanOrEqual(1)
            expect(seams.of('ralph.config.sh').filter((o) => o.op === 'exists').length, label).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })
})

describe('QA #76 — widths come from the stream this command was handed', () => {
  const WIDTHS = [undefined, 0, 1, -5, 2.7, 25, 26, 43, 44, 59, 60, 61, 200, NaN, Infinity, -Infinity, '80', null, {}]

  // Labels that distinguish the string `'80'` from the number 80 and `{}` from `null`, since
  // the whole point of those two rows is that they are NOT the number they look like.
  const widthLabel = (w) =>
    typeof w === 'string' ? `the string "${w}"` : w !== null && typeof w === 'object' ? 'an object' : String(w)

  it.each(WIDTHS.map((w) => [widthLabel(w), w]))('keeps every identity line inside the cap at columns=%s', async (_label, columns) => {
    const { lines, result } = await run({ columns })
    const cap = expectedCap(columns)
    const box = identityLines(lines)
    // A positive control first: something WAS printed, so the width claim below is not being
    // made about an empty list.
    expect(box.length).toBeGreaterThan(0)
    for (const line of box) expect([...line].length, JSON.stringify(line)).toBeLessThanOrEqual(cap)
    expect(result.exitCode).toBe(0)
  })

  it('lands on the documented rungs of #72’s ladder', async () => {
    // 44 is BOX_MIN_WIDTH: a frame at exactly 44, and two bare lines at 43. Asserted as
    // shapes rather than as an identity so that a change to the ladder has to be a
    // deliberate edit here as well as in banner-compose.js.
    const framed = await run({ columns: 44 })
    expect(identityLines(framed.lines)).toHaveLength(3)
    for (const line of identityLines(framed.lines)) expect([...line].length).toBe(44)

    for (const columns of [43, 26, 25, 10]) {
      const { lines } = await run({ columns })
      const box = identityLines(lines)
      expect(box, String(columns)).toHaveLength(2)
      expect(box[0].startsWith('╭'), String(columns)).toBe(false)
      expect(box[0], String(columns)).toContain('ralph')
    }

    // A one-column terminal still gets a shape rather than a crash: two lines, one column.
    const sliver = await run({ columns: 1 })
    expect(identityLines(sliver.lines)).toHaveLength(2)
    for (const line of identityLines(sliver.lines)) expect([...line].length).toBe(1)
  })

  it('caps at 60 however wide the terminal is', async () => {
    for (const columns of [61, 120, 200, 10000]) {
      const { lines } = await run({ columns })
      for (const line of identityLines(lines)) expect([...line].length, String(columns)).toBe(BANNER_WIDTH)
    }
  })

  it('asks the INJECTED stream for its width, exactly once, and never process.stdout', async () => {
    // A getter rather than a value, because the claim is about WHO was asked. `columns`
    // defaults to `stdout?.columns` in the signature, so a command that reached for
    // `process.stdout.columns` instead would leave this counter at zero and would be
    // measured against the terminal the suite happens to be running in.
    const stream = makeStream()
    let asked = 0
    Object.defineProperty(stream, 'columns', {
      get() {
        asked += 1
        return 44
      },
    })
    const { deps } = makeDeps({ stdout: stream })
    await statusCommand(deps)
    expect(asked).toBe(1)
    for (const line of identityLines(stream.lines())) expect([...line].length).toBe(44)
  })

  it('does not width-manage the report below the box (characterisation, and out of #76’s scope)', async () => {
    // Stated as a fact rather than asserted as a promise, and the honesty is the point: only
    // the identity block is width-aware. The view's heading is 71 columns wide whatever the
    // terminal says, exactly as it was before #76 — status.test.js pins it byte for byte at
    // no width at all. A width invariant over the WHOLE stream would therefore be a new
    // requirement smuggled in as a regression test; if it is ever wanted, it is renderStatus's
    // to implement and status.test.js's fixtures that change.
    const { lines } = await run({ columns: 20 })
    for (const line of identityLines(lines)) expect([...line].length).toBeLessThanOrEqual(20)
    const heading = reportLines(lines)[0]
    expect([...heading].length).toBeGreaterThan(20)
  })
})

describe('QA #76 — `--json` is a document, and stayed one', () => {
  const JSON_KNOBS = []
  for (const processEnv of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'static' }, { RALPH_BANNER: 'junk' }]) {
    for (const columns of [undefined, 1, 43, 80, 200]) {
      for (const color of [false, true]) {
        JSON_KNOBS.push({ processEnv, columns, color })
      }
    }
  }

  it('prints exactly one line, one write, no escape byte — at every banner setting, width and colour', async () => {
    for (const knobs of JSON_KNOBS) {
      const { chunks, raw, result } = await run({ ...knobs, json: true, config: 'RALPH_BANNER=full\n' })
      const label = JSON.stringify(knobs)
      expect(chunks, label).toHaveLength(1)
      expect(raw.endsWith('\n'), label).toBe(true)
      expect((raw.match(/\n/g) ?? []).length, label).toBe(1)
      expect(raw, label).not.toContain(ESC)
      expect(raw, label).not.toMatch(SPRITE_GLYPH)
      expect(() => JSON.parse(raw)).not.toThrow()
      expect(result.exitCode, label).toBe(0)
    }
  })

  it('prints the SAME document however the banner is configured, and however wide the terminal is', async () => {
    // The box's inputs are the version, the width and the colour capability. None of them may
    // reach the document — so all three are varied at once and the answer must be a set of one.
    const documents = new Set()
    for (const knobs of JSON_KNOBS) {
      for (const currentVersion of [VERSION, 'unknown', undefined, 42]) {
        const { raw } = await run({ ...knobs, currentVersion, json: true, config: 'RALPH_BANNER=full\n' })
        documents.add(raw)
      }
    }
    expect(documents.size).toBe(1)
  })

  it('prints one line in all four modes, with no box and no separator anywhere', async () => {
    for (const [mode, factory] of Object.entries(MODES)) {
      for (const processEnv of [{}, { RALPH_BANNER: 'full' }]) {
        const { chunks, raw, result } = await run({ ...factory(), processEnv, json: true })
        expect(chunks, mode).toHaveLength(1)
        expect(raw, mode).not.toContain('╭')
        expect(raw, mode).not.toContain('▸ ralph — ')
        expect(result.exitCode, mode).toBe(0)
      }
    }
  })
})

describe('QA #76 — the read plan, op by op', () => {
  // The exact sequences, so "the box added no read" is a checkable statement rather than a
  // claim about intent. Every one of these was the plan before #76 as well: the config text
  // the knob is parsed out of is read on the `measured` gate the queue count and the digest
  // interval already needed.
  const PLANS = {
    running: ['exists:ralph.config.sh', 'read:ralph.config.sh', 'read:issues.jsonl', 'read:digest.log'],
    interrupted: ['exists:ralph.config.sh', 'read:ralph.config.sh', 'read:issues.jsonl'],
    idle: ['exists:ralph.config.sh', 'read:ralph.config.sh', 'read:issues.jsonl'],
    'never-run': [],
  }

  it.each(Object.keys(PLANS))('touches exactly the documented files in %s, box on', async (mode) => {
    const { seams } = await run({ ...MODES[mode](), config: 'RALPH_BANNER=full\n' })
    expect(seams.ops.map((o) => `${o.op}:${o.file}`)).toEqual(PLANS[mode])
  })

  it.each(Object.keys(PLANS))('touches the same files in %s with the box OFF', async (mode) => {
    // The other half of the same claim: silencing the banner does not make the command
    // cheaper, because the banner never made it more expensive. Same config file present, so
    // the comparison is of the PLAN and not of whether a file existed.
    const { seams, lines } = await run({
      ...MODES[mode](),
      config: 'RALPH_BANNER=full\n',
      processEnv: { RALPH_BANNER: 'off' },
    })
    expect(seams.ops.map((o) => `${o.op}:${o.file}`)).toEqual(PLANS[mode])
    expect(hasBox(lines)).toBe(false)
  })

  it('reads NOTHING in never-run, on either surface, at every banner setting', async () => {
    // The five existing canaries say never-run reads nothing. This is the sixth, and it is
    // the one that matters for #76: the box's resolver sits BEHIND the `mode !== 'never-run'`
    // short-circuit, so a config it would have consulted is never opened.
    for (const json of [false, true]) {
      for (const processEnv of [{}, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'off' }]) {
        const { seams, exec, lines, result } = await run({ record: null, json, processEnv })
        const label = `json=${json} ${JSON.stringify(processEnv)}`
        expect(seams.ops, label).toEqual([])
        expect(exec.of('gh'), label).toHaveLength(0)
        expect(exec.calls.map((c) => c.cmd), label).toEqual(['git', 'tmux'])
        if (!json) expect(hasBox(lines), label).toBe(false)
        expect(result.exitCode, label).toBe(0)
      }
    }
  })

  it('spends no read on an idle `--json` run, where no box can print anyway', async () => {
    const { seams, exec } = await run({ record: terminalRecord(), json: true, config: 'RALPH_BANNER=full\n' })
    expect(seams.ops).toEqual([])
    expect(exec.of('gh')).toHaveLength(0)
  })

  it('issues one queue probe per invocation, box on or off', async () => {
    for (const processEnv of [{}, { RALPH_BANNER: 'off' }]) {
      const { exec } = await run({ processEnv })
      const label = JSON.stringify(processEnv)
      // Counted per QUESTION, not per binary: #56 gave the live view a second `gh issue
      // list` for the issue titles its task table labels rows with, so a bare `of('gh')`
      // count no longer says which call it caught. What this test is about is unchanged —
      // the box is a picture drawn from facts already gathered, and it must not add a
      // probe of its own — and naming both calls keeps it measuring that.
      expect(exec.of('gh').filter((c) => c.args.includes('--search')), label).toHaveLength(1)
      expect(exec.of('gh').filter((c) => c.args.includes('--state')), label).toHaveLength(1)
      expect(exec.of('gh'), label).toHaveLength(2)
      expect(exec.of('git'), label).toHaveLength(1)
      expect(exec.of('tmux'), label).toHaveLength(1)
    }
  })

  it('hands the gatherer the seams and the environment — and no rendering knob', async () => {
    // #76 moved `processEnv` out of the rest bag and re-forwarded it by hand, which is
    // exactly the edit that silently stops forwarding a key. Asserted two ways: the bag's
    // key set, and the OBJECT IDENTITY of the environment, because `{ ...processEnv }` would
    // satisfy a key-set check and still break a caller that mutates its own env.
    const bags = []
    const processEnv = { TASK_SOURCE: 'folder', RALPH_BANNER: 'off' }
    const { result } = await run({
      processEnv,
      extra: {
        collect: async (bag) => {
          bags.push(bag)
          return collectStatus(bag)
        },
      },
    })
    expect(bags).toHaveLength(1)
    expect(Object.keys(bags[0]).sort()).toEqual([
      'cwd',
      'exec',
      'exists',
      'folderQueueCount',
      'json',
      'now',
      'peekLock',
      'processEnv',
      'readFile',
      'readRunState',
    ])
    expect(bags[0].processEnv).toBe(processEnv)
    // TASK_SOURCE still arrives, which is the regression this test exists for.
    expect(result.queue).toBe(FOLDER_QUEUE)
    // ...and no stream, width, colour or version leaked into the read plan: a gatherer that
    // can see the terminal is a gatherer that can read differently for a human.
    for (const key of ['stdout', 'columns', 'color', 'currentVersion']) {
      expect(bags[0], key).not.toHaveProperty(key)
    }
  })
})

describe('QA #76 — nothing about it can fail the command', () => {
  // Every shape a seam can fail with, including the ones that are not Errors. `readConfigText`
  // catches all of them and answers '' — the box then draws itself from the default, which is
  // the right degradation for a view whose job is to work when the machine is broken.
  const THROWN = [
    ['an Error', new Error('nope')],
    ['EACCES', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
    ['EISDIR', Object.assign(new Error('is a directory'), { code: 'EISDIR' })],
    ['ELOOP', Object.assign(new Error('too many symlinks'), { code: 'ELOOP' })],
    ['a string', 'plain string'],
    ['null', null],
    ['a number', 42],
  ]

  it.each(THROWN)('survives an `exists` that throws %s, in every mode and on both surfaces', async (_label, thrown) => {
    for (const [mode, factory] of Object.entries(MODES)) {
      for (const json of [false, true]) {
        const { result, lines, chunks } = await run({
          ...factory(),
          config: 'RALPH_BANNER=off\n',
          seamOptions: { existsThrows: thrown },
          json,
        })
        const label = `${mode} json=${json}`
        expect(result.exitCode, label).toBe(0)
        if (json) expect(chunks, label).toHaveLength(1)
        // The config never arrived, so the `off` in it cannot have been read — and the box
        // prints from the default. A silenced box here would mean the failure was being
        // interpreted as a setting.
        if (!json && mode !== 'never-run') expect(hasBox(lines), label).toBe(true)
      }
    }
  })

  it.each(THROWN)('survives a `readFile` that throws %s, in every mode and on both surfaces', async (_label, thrown) => {
    for (const [mode, factory] of Object.entries(MODES)) {
      for (const json of [false, true]) {
        const { result, chunks } = await run({
          ...factory(),
          config: 'RALPH_BANNER=off\n',
          seamOptions: { readThrows: thrown },
          json,
        })
        const label = `${mode} json=${json}`
        expect(result.exitCode, label).toBe(0)
        if (json) expect(chunks, label).toHaveLength(1)
      }
    }
  })

  const READ_RETURNS = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['a Buffer-like with a toString', { toString: () => 'RALPH_BANNER=off' }],
  ]

  it.each(READ_RETURNS)('survives a `readFile` that returns %s', async (_label, value) => {
    const { result } = await run({ config: '', seamOptions: { readReturns: value } })
    expect(result.exitCode).toBe(0)
  })

  it('survives a config that is 5 MiB of junk, and still finds an `off` a megabyte in', async () => {
    // Not a performance test — a robustness one. The parser is a regex over lines, so the
    // question is only whether a pathological file can make it throw or hang.
    const junk = await run({ config: 'x'.repeat(5 * 1024 * 1024) })
    expect(junk.result.exitCode).toBe(0)
    expect(hasBox(junk.lines)).toBe(true)

    const buried = await run({ config: `${'# padding\n'.repeat(100000)}RALPH_BANNER=off\n` })
    expect(hasBox(buried.lines)).toBe(false)
    expect(buried.result.exitCode).toBe(0)
  })

  it('prints the whole box even when the stream reports backpressure on every write', async () => {
    // `makeStream` returns false from `write` throughout this file, so this asserts what the
    // rest of the suite has been relying on: nothing here treats a false return as a failure
    // and stops half way through a frame.
    const { lines, chunks, result } = await run()
    expect(identityLines(lines)).toHaveLength(3)
    expect(chunks.every((c) => c.endsWith('\n'))).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  const HOSTILE_RECORD = [
    ['a session with a newline in it', runningRecord({ session: `${SESSION}\nforged`, run_id: `${SESSION}\nforged` })],
    ['a session with an escape in it', runningRecord({ session: `${ESC}[2J${SESSION}` })],
    ['numbers where strings belong', runningRecord({ started_at: 42, source: 7 })],
    ['a string where the task object belongs', runningRecord({ current: 'nope' })],
    ['an empty object', {}],
    ['nonsense counters', terminalRecord({ ok: Number.MAX_SAFE_INTEGER, failed: -1, queue_at_start: NaN })],
  ]

  it.each(HOSTILE_RECORD)('draws the same box over %s', async (_label, record) => {
    // The box's facts do not come from the record, so a hostile record must not be able to
    // change it. Everything below the box is the report's problem and is not asserted here —
    // what is asserted is that the box is intact and the command still exits 0.
    const { lines, out, result } = await run({ record })
    const box = identityLines(lines)
    expect(box).toHaveLength(3)
    expect(titleVersion(out)).toBe(VERSION)
    expect(rowValue(out, 'cwd')).toBe(REPO)
    expect(result.exitCode).toBe(0)
  })

  it.each([
    ['frozen', Object.freeze({ RALPH_BANNER: 'off' })],
    ['null-prototype', Object.assign(Object.create(null), { RALPH_BANNER: 'off' })],
  ])('reads a %s environment without writing to it', async (_label, processEnv) => {
    const { lines, result } = await run({ processEnv })
    expect(hasBox(lines)).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  it('survives an environment with no prototype and no keys', async () => {
    // `processEnv?.RALPH_BANNER` on an `Object.create(null)` is a plain miss, not a
    // `hasOwnProperty` call that would not exist on it.
    const { lines, result } = await run({ processEnv: Object.create(null) })
    expect(hasBox(lines)).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('survives an older gatherer that returns no `bannerSetting` at all', async () => {
    // A third-party or pre-#76 `collect` is a supported shape — it is an injected seam with a
    // default, and #76 added a key to its RESULT. An absent key must read as "nothing
    // configured" rather than throw, so the box falls back to the default: `undefined` is
    // what `resolveBannerMode` already treats as unconfigured, the same answer the gatherer
    // gives for a config file with no such assignment in it.
    const olderGatherer = async (bag) => {
      const { bannerSetting, ...rest } = await collectStatus(bag)
      return rest
    }
    const { lines, result } = await run({ extra: { collect: olderGatherer } })
    expect(hasBox(lines)).toBe(true)
    expect(identityLines(lines)).toHaveLength(3)
    expect(result.exitCode).toBe(0)
  })

  it('survives a gatherer that returns an empty object', async () => {
    // The degenerate end of the same argument: no root, no mode, no record. `mode` is not
    // 'never-run', so a box is drawn — with `cwd` as the word for not knowing, which is
    // composeBanner's answer for an absent fact rather than a crash in `resolve()`.
    const { lines, out, result } = await run({ extra: { collect: async () => ({}) } })
    expect(hasBox(lines)).toBe(true)
    expect(rowValue(out, 'cwd')).toBe('unknown')
    expect(result).toEqual({ exitCode: 0, mode: undefined, record: undefined, queue: undefined })
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', {}],
  ])('survives a gatherer whose root is %s', async (_label, root) => {
    const { out, result } = await run({
      extra: {
        collect: async (bag) => ({ ...(await collectStatus(bag)), root }),
      },
    })
    expect(rowValue(out, 'cwd')).toBe('unknown')
    expect(result.exitCode).toBe(0)
  })
})

describe('QA #76 — printed once, above a report that did not move', () => {
  it.each(BOX_MODES)('prints one box, one separator and one report in %s', async (mode) => {
    const { lines, raw, out } = await run(MODES[mode]())
    expect((out.match(/╭─ ralph /g) ?? []).length, mode).toBe(1)
    expect(out.split('\n').filter((l) => l.startsWith('╰')), mode).toHaveLength(1)
    expect(separatorCount(lines), mode).toBe(1)
    // Three framed lines, then the separator, then the report — so index 4, and asserting the
    // NUMBER rather than "somewhere below the box" is what pins the blank to exactly one line.
    expect(reportIndex(lines), mode).toBe(4)
    expect(identityLines(lines), mode).toHaveLength(3)
    expect((out.match(/▸ ralph — /g) ?? []).length, mode).toBe(1)
    expect(raw, mode).not.toMatch(SPRITE_GLYPH)
  })

  it.each(BOX_MODES)('prints no separator at all in %s when the box is off', async (mode) => {
    // The separator belongs to the box, not to the report: silencing the banner must not leave
    // a leading blank line behind, which is what a `out('')` moved one line out of the `if`
    // would produce. Asserted on the FIRST CHUNK as well as on the line index, because
    // `separatorCount` is defined relative to the report and would answer 0 either way.
    const { lines, chunks } = await run({ ...MODES[mode](), processEnv: { RALPH_BANNER: 'off' } })
    expect(reportIndex(lines), mode).toBe(0)
    expect(lines[0].startsWith('▸ ralph — '), mode).toBe(true)
    expect(chunks[0], mode).toBe(`${lines[0]}\n`)
  })

  it.each(BOX_MODES)('leaves the %s report byte-identical across every setting and width', async (mode) => {
    // The strongest form of "additive": the report is compared against the run with the box
    // SILENCED, across four settings and seven widths, in every mode that draws a box. If the
    // box ever consumed a line, re-flowed the view or shifted a blank, this collapses.
    const silenced = await run({ ...MODES[mode](), processEnv: { RALPH_BANNER: 'off' } })
    const baseline = silenced.lines.join('\n')
    const seen = new Set()
    for (const processEnv of [{}, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'static' }, { RALPH_BANNER: 'junk' }]) {
      for (const columns of [undefined, 200, 60, 44, 43, 30, 1]) {
        const { lines } = await run({ ...MODES[mode](), processEnv, columns })
        seen.add(reportLines(lines).join('\n'))
      }
    }
    expect(seen.size, mode).toBe(1)
    expect([...seen][0], mode).toBe(baseline)
    // ...and the line counts differ by exactly the box plus its separator.
    const withBox = await run(MODES[mode]())
    expect(withBox.lines.length - silenced.lines.length).toBe(identityLines(withBox.lines).length + 1)
  })

  it('leaves the report identical whether or not colour is permitted', async () => {
    // `color: true` is the only configuration in which composeBanner would paint anything,
    // and this command passes neither fact it paints — so the whole stream, box included, is
    // byte-identical. Which is what makes the `--json` guarantee structural rather than
    // careful: there is no colour source in this module to leak one.
    const dark = await run({ color: false })
    const lit = await run({ color: true })
    expect(lit.raw).toBe(dark.raw)
    expect(lit.raw).not.toContain(ESC)
  })

  it('emits not one escape byte, at every width and every setting, box on or off', async () => {
    // Unconditional, with no `runIf` on picocolors — unlike `ralph doctor`, whose report
    // paints its own ✓/✗ markers. `picocolors` is not on this command's import graph at all
    // (asserted below), so no writer into this stream has a colour source.
    for (const columns of [undefined, 200, 80, 60, 44, 43, 26, 25, 10, 1, 0]) {
      for (const processEnv of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'static' }]) {
        const { raw } = await run({ columns, processEnv, color: true })
        const label = `${columns} / ${JSON.stringify(processEnv)}`
        expect(raw, label).not.toContain(ESC)
        expect(raw, label).not.toMatch(CURSOR)
        expect(raw, label).not.toContain('\r')
        expect(raw, label).not.toContain(BEL)
        expect(raw, label).not.toContain(NUL)
        expect(raw, label).not.toContain(C1_CSI)
      }
    }
  })
})

describe('QA #76 — no sprite, structurally rather than by discipline', () => {
  const STATUS = fileURLToPath(new URL('./status.js', import.meta.url))
  const RAW = readFileSync(STATUS, 'utf8')
  const CODE = codeWithoutComments(STATUS)

  function specifiersOf(src) {
    const out = []
    const patterns = [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /^\s*import\s+['"]([^'"]+)['"]/gm,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const re of patterns) {
      let m
      while ((m = re.exec(src)) !== null) out.push(m[1])
    }
    return out
  }

  function importGraph(entry) {
    const files = new Map()
    const bare = new Set()
    const stack = [entry]
    while (stack.length > 0) {
      const file = stack.pop()
      if (files.has(file)) continue
      const src = codeWithoutComments(file)
      files.set(file, src)
      for (const spec of specifiersOf(src)) {
        if (spec.startsWith('.')) stack.push(resolvePath(dirname(file), spec))
        else bare.add(spec)
      }
    }
    return { files, bare }
  }

  const graph = importGraph(STATUS)
  const rel = (f) => f.slice(f.indexOf('/lib/') + 1)
  const names = [...graph.files.keys()].map(rel)

  it('reached the three modules #76 added (guards against a vacuous pass)', () => {
    // Every forbidden-import assertion below would pass on an empty graph, so the walker is
    // proven to have followed the NEW edges first. These three are exactly what #76 put on
    // this command's graph — banner-compose.js pulls banner-rows.js, and update-check.js and
    // the version cache behind that, which is why `node:os` appears in the bare set below.
    for (const module of ['lib/banner-compose.js', 'lib/banner-mode.js', 'lib/parse-config-var.js']) {
      expect(names).toContain(module)
    }
    expect(names).toContain('lib/commands/status.js')
    expect(names).toContain('lib/version-cache.js')
  })

  it('added no third-party package, and one builtin whose reader is lazy', () => {
    // `execa` was already here — this command shells out to git, tmux and gh by design, which
    // is why the sharper claim is made about the BOX'S subgraph in the next test rather than
    // about this one. `node:os` is the only addition, and it arrives via the version cache's
    // homedir lookup on a path `ralph status` never calls.
    expect([...graph.bare].sort()).toEqual(['execa', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:url'])
    for (const spec of ['picocolors', 'node:http', 'node:https', 'node:net', 'node:tls', 'node-fetch', 'undici', 'ws']) {
      expect([...graph.bare], spec).not.toContain(spec)
    }
  })

  it('cannot reach a shell, a socket or a pixel through the box’s own subgraph', () => {
    // The claim `ralph doctor` makes about its whole graph, scoped here to the part #76
    // added: whatever the rest of this command may do, drawing the identity box reaches
    // nothing but three filesystem builtins.
    const SUBGRAPHS = [
      // The renderer, and the version cache it pulls in behind it: three filesystem builtins.
      ['../banner-compose.js', ['node:fs', 'node:os', 'node:path']],
      ['../banner-mode.js', ['node:fs', 'node:os', 'node:path']],
      // The parser imports NOTHING, which is the whole reason the knob is cheap to read.
      ['../parse-config-var.js', []],
    ]
    for (const [entry, expected] of SUBGRAPHS) {
      const sub = importGraph(resolvePath(dirname(STATUS), entry))
      // Anti-vacuity: the walker found the file itself before making a claim about its edges.
      expect(sub.files.size, entry).toBeGreaterThan(0)
      expect([...sub.bare].sort(), entry).toEqual(expected)
    }
  })

  it('imports no sprite, splash or animation module anywhere on the graph', () => {
    for (const [file, src] of graph.files) {
      for (const spec of specifiersOf(src)) {
        expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(/sprite|splash|animat/i)
      }
    }
  })

  it('names no sprite and no TTY in its code, and the comment-stripping is what makes that checkable', () => {
    // An inverted assertion that earns its place: status.js ARGUES at length about why it
    // passes no `isTTY` and imports no sprite module, and that argument cannot be made
    // without naming them. A raw grep would therefore fail on the paragraph explaining the
    // very property it checks — so this proves the prose still contains those words AND that
    // the code does not, which is what stops the guard being weakened to nothing.
    for (const word of ['sprite', 'isTTY', 'animation']) {
      expect(RAW, `prose should still discuss ${word}`).toMatch(new RegExp(word, 'i'))
      expect(CODE, `code must not mention ${word}`).not.toMatch(new RegExp(word, 'i'))
    }
  })

  it('has no timer, no sleep and no literal escape in its code', () => {
    // An animation needs a clock and a cursor. This command has neither, so there is nothing
    // to disable and no flag that could re-enable one.
    // The positive control for every negative below: `codeWithoutComments` returned this
    // command's actual code and not an empty string.
    expect(CODE).toContain('resolveBannerMode(')
    for (const pattern of [/setTimeout/, /setInterval/, /\bsleep\b/i, /requestAnimationFrame/]) {
      expect(CODE, String(pattern)).not.toMatch(pattern)
    }
    expect(CODE).not.toMatch(SPRITE_GLYPH)
    expect(CODE).not.toContain(ESC)
    expect(CODE).not.toMatch(/\\u001B|\\x1B|\\e\[/i)
  })

  it('writes through one call site, and measures the stream it writes to', () => {
    // One `.write(` is status.json.qa.test.js's invariant and the reason `--json`'s
    // one-line guarantee is structural: there is exactly one place in this module that can
    // put a byte on stdout. The width, correspondingly, comes off that same stream.
    expect((CODE.match(/\.write\(/g) ?? []).length).toBe(1)
    expect(CODE).toContain('columns = stdout?.columns')
    expect(CODE).not.toMatch(/process\.stdout\.columns/)
  })
})

describe('QA #76 — the exit code did not move', () => {
  it('exits 0 across mode × surface × banner setting × width', async () => {
    for (const [mode, factory] of Object.entries(MODES)) {
      for (const json of [false, true]) {
        for (const processEnv of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'nonsense' }]) {
          for (const columns of [undefined, 80, 43, 0]) {
            const { result } = await run({ ...factory(), json, processEnv, columns })
            const label = `${mode} json=${json} ${JSON.stringify(processEnv)} @ ${columns}`
            expect(result.exitCode, label).toBe(0)
            expect(result.mode, label).toBe(mode)
          }
        }
      }
    }
  })

  it('exits 0 when the config read fails and the queue probe fails together', async () => {
    // The realistic bad day: an unreadable config and a `gh` that is not logged in. Neither
    // is fatal, and the box still names the run.
    const { result, lines } = await run({
      exec: makeExec({ ghExitCode: 1, ghQueue: '' }),
      seamOptions: { readThrows: Object.assign(new Error('denied'), { code: 'EACCES' }) },
      config: 'RALPH_BANNER=off\n',
    })
    expect(result.exitCode).toBe(0)
    expect(hasBox(lines)).toBe(true)
  })
})

describe('QA #76 — `ralph digest` borrows the same gatherer', () => {
  const DIGEST = fileURLToPath(new URL('../digest.js', import.meta.url))

  // `runDigest` calls `collect({ cwd, exec, readFile, now, processEnv })` — note the absent
  // `exists`, which is why the real `collectStatus` is wrapped here rather than injected
  // bare: without it the config probe would fall through to the real `existsSync` and this
  // test would depend on the developer's checkout. That gap predates #76 (`configText` was
  // computed on the same gate before the diff, for TASK_SOURCE and the digest interval), so
  // it is noted rather than asserted as a regression.
  const gatherWith = (config) => async (bag) =>
    collectStatus({
      ...bag,
      exists: (p) => String(p).endsWith('ralph.config.sh') && config !== undefined,
      readFile: (p) => (String(p).endsWith('ralph.config.sh') ? (config ?? '') : ''),
      readRunState: () => runningRecord(),
      peekLock: () => null,
      folderQueueCount: async () => FOLDER_QUEUE,
    })

  const runDigestWith = async (config) => {
    const prompts = []
    const appended = []
    const exec = async (cmd, args = [], options = {}) => {
      if (options?.input) prompts.push(String(options.input))
      if (cmd === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: REPO, stderr: '' }
      if (cmd === 'git' && args[0] === 'status') return { exitCode: 0, stdout: '## main', stderr: '' }
      if (cmd === 'git' && args[0] === 'log') return { exitCode: 0, stdout: 'abc1234 feat: a thing', stderr: '' }
      if (cmd === 'tmux') return { exitCode: 0, stdout: '', stderr: '' }
      if (cmd === 'gh') return { exitCode: 0, stdout: '6', stderr: '' }
      return { exitCode: 0, stdout: 'the loop is healthy', stderr: '' }
    }
    const result = await runDigest({
      cwd: REPO,
      env: {},
      exec,
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      // The real placeholders (lib/digest.js's `assembleDigestContext`), because the point of
      // the test below is what the interpolated context CONTAINS — a template with a made-up
      // variable in it would come back with the placeholder intact and every negative
      // assertion about the prompt would then pass on a prompt with no context in it at all.
      readTemplate: () => 'NARRATE THIS RUN\n{{MODE}}\n{{RUN_STATE}}\n{{PROGRESS}}\n{{GIT_STATUS}}\n',
      appendFile: (_p, data) => appended.push(String(data)),
      mkdir: () => {},
      now: () => NOW,
      stderr: makeStream(),
      collect: gatherWith(config),
    })
    return { result, prompts, appended }
  }

  it('narrates the same run whether or not ralph.config.sh exists', async () => {
    // `collectStatus` grew a key. `runDigest` reads `root`, `record`, `mode`, `now` and the
    // progress snapshot out of it and nothing else — so the new key must be inert, and the
    // proof is that the whole narration is identical with the file present and absent.
    const without = await runDigestWith(undefined)
    const with_ = await runDigestWith('RALPH_BANNER=off\nTASK_SOURCE=github\n')
    expect(without.result.status).toBe('ok')
    expect(with_.result.status).toBe('ok')
    expect(with_.result.narrative).toBe(without.result.narrative)
    expect(with_.appended).toEqual(without.appended)
    expect(with_.result.mode).toBe(without.result.mode)
    expect(with_.result.root).toBe(without.result.root)
  })

  it('never puts the config file’s text into the model’s prompt', async () => {
    // The consequence that would matter if the config file's TEXT ever rode on the shared
    // snapshot: ralph.config.sh is where people keep API keys, and `runDigest` interpolates
    // what it is handed into a model prompt. #76 review makes this STRUCTURAL rather than
    // pinned — `collectStatus` parses RALPH_BANNER on its own side and returns the value, so
    // there is no key on the snapshot for a future author to interpolate by accident. Kept as
    // an end-to-end assertion anyway: it is the only test that drives the real gatherer into
    // the real prompt builder with a secret in the file, and structural arguments are worth
    // exactly as much as the last refactor that respected them.
    const { prompts } = await runDigestWith('RALPH_BANNER=off\nANTHROPIC_API_KEY=sk-do-not-leak-me\n')
    // The anti-vacuity control: a prompt WAS built and sent, so the negatives below are
    // statements about its contents rather than about an empty list.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('NARRATE THIS RUN')
    expect(prompts[0]).toContain(SESSION)
    expect(prompts[0]).not.toContain('sk-do-not-leak-me')
    expect(prompts[0]).not.toContain('RALPH_BANNER')
    expect(prompts[0]).not.toContain('ANTHROPIC_API_KEY')
  })

  it('hands every borrower a snapshot with no raw config text on it at all', async () => {
    // The structural half, re-pointed by the #76 review: the guarantee is no longer "the
    // digest does not read the key" — which held only for today's digest.js — but "the key is
    // not there to read", which holds for every present and future borrower of this gatherer.
    // Driven with a secret in the config so the assertion is about the bytes rather than
    // about a key name someone could rename.
    const snapshot = await gatherWith('RALPH_BANNER=off\nANTHROPIC_API_KEY=sk-do-not-leak-me\n')({
      cwd: REPO,
      exec: makeExec({ gitRoot: REPO }),
      now: () => NOW,
      processEnv: {},
    })
    // The anti-vacuity control: the file WAS read and the knob DID come through — as a value.
    expect(snapshot.bannerSetting).toBe('off')
    const serialised = JSON.stringify(snapshot)
    expect(serialised).not.toContain('sk-do-not-leak-me')
    expect(serialised).not.toContain('ANTHROPIC_API_KEY')
    // ...and no key carries a whole file under another name: nothing on the snapshot is a
    // multi-line string, which every plausible smuggling of ralph.config.sh would be.
    const multiline = Object.entries(snapshot).filter(
      ([, v]) => typeof v === 'string' && v.includes('\n'),
    )
    expect(multiline).toEqual([])
    // The digest still calls the shared gatherer — so the test above is not passing on a
    // command that stopped borrowing it — and names neither the parsed knob nor the text it
    // came from.
    expect(codeWithoutComments(DIGEST)).toContain('collect({')
    expect(codeWithoutComments(DIGEST)).not.toMatch(/configText|bannerSetting/)
  })
})
