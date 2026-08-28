// #75 QA — adversarial specs for the identity box in `ralph doctor`.
//
// doctor.identity-box.test.js proves the intended slice: the box is first, the five facts are
// in it, the two old lines are gone, `RALPH_BANNER=off` silences it and the exit codes did not
// move. This file attacks the parts of that slice that are DOCTOR'S rather than the box's, and
// it is organised around the four things #75 actually changed about this command:
//
//   1. A NEW READ. Doctor used to touch the filesystem for one thing only — #27's update-check
//      cache — and now it also reads ralph.config.sh. That is a new failure surface on the one
//      command whose whole job is to work when the machine is broken: `exists` can throw
//      EACCES, `readFile` can throw EISDIR, a config can be a megabyte of binary junk, and
//      `cwd` arrives from a caller's bag where `resolve` would throw on anything but a string.
//      NONE of it may throw out of `doctorCommand` and none of it may move the exit code.
//   2. A NEW KNOB ON A COMMAND THAT PARSES ONE. RALPH_BANNER now has to answer the same in
//      doctor as in `ralph start` — same precedence, same spellings, same grammar in the file
//      — so the knob is driven here through both sources at once, in both directions, in the
//      case that matters most (a missing critical dep) as well as the easy one.
//   3. A NEW IMPORT GRAPH. Four modules joined this command's graph, and the property that
//      makes doctor safe to paste is that none of them can reach a socket, a shell or a pixel.
//      Asserted structurally — the walker is checked against the NEW modules too, so it cannot
//      pass vacuously, and the comment-stripping is proven load-bearing rather than assumed.
//   4. NOTHING ELSE. The exit code is what every wrapper and CI step gates on, so it is driven
//      as a cross product of {dep outcome} × {banner mode} × {cache state} rather than as three
//      happy paths, and the dependency report is asserted BYTE-IDENTICAL across all of it.
//
// Every run injects the cache fs, the home, the cwd, the config seams, the colour capability
// and the column count, so nothing here reads the real ~/.config/ralph, the real
// ralph.config.sh, or the terminal the suite happens to be running in (#41).

import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import pc from 'picocolors'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { doctorCommand } from './doctor.js'

const ESC = '\u001B'
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(SGR, '')

// Everything an ANSI-aware terminal reads as an INSTRUCTION rather than as text: show/hide the
// cursor, move it, erase, scroll, save/restore. A diagnostic people pipe into a bug report may
// emit colour (an SGR sequence, terminated by `m`, deliberately absent from this class) and
// must emit nothing else.
const CURSOR = new RegExp(`${ESC}\\[(?:\\?25[lh]|[0-9;]*[ABCDEFGHJKSTfnsu])|${ESC}[78MD]`)

function makeStream(columns) {
  const chunks = []
  return {
    columns,
    write: (s) => {
      chunks.push(s)
      return true
    },
    chunks,
    output: () => stripAnsi(chunks.join('')),
    raw: () => chunks.join(''),
  }
}

const HOME = '/home/me'
const CWD = '/repo'
const CONFIG_PATH = join(CWD, 'ralph.config.sh')
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')
const VERSION = '0.17.0'

const allPresent = () => true
const missing = (...names) => (name) => !names.includes(name)

const warmCache = (latest) =>
  Volume.fromJSON({ [CACHE_PATH]: JSON.stringify({ latest_version: latest }) }, '/')

/**
 * ralph.config.sh as a pair of recorded seams — absent unless a test supplies text.
 *
 * `calls` is the whole point: "the config file is read at most once per invocation" is an
 * invariant about this command's behaviour, not a detail, so the seams count themselves.
 */
function configSeams(text, options = {}) {
  const calls = []
  // Presence of the KEY, not truthiness of the value: half of what these seams are for is
  // `throw null` and `return undefined`, and a truthiness check would quietly turn both of
  // those cases into the happy path and pass for the wrong reason.
  const throwsOnExists = 'existsThrows' in options
  const throwsOnRead = 'readThrows' in options
  const overridesRead = 'readReturns' in options
  return {
    calls,
    exists: (p) => {
      calls.push({ op: 'exists', path: String(p) })
      if (throwsOnExists) throw options.existsThrows
      return text !== undefined
    },
    readFile: (p) => {
      calls.push({ op: 'read', path: String(p) })
      if (throwsOnRead) throw options.readThrows
      if (overridesRead) return options.readReturns
      return text ?? ''
    },
  }
}

async function runDoctor({
  env = {},
  config,
  cwd = CWD,
  currentVersion = VERSION,
  hasCommand = allPresent,
  cacheFs = new Volume(),
  home = HOME,
  columns,
  color = false,
  seamOptions,
  extra = {},
} = {}) {
  const stdout = makeStream(columns)
  const stderr = makeStream()
  const seams = configSeams(config, seamOptions)
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand,
    platform: 'mac',
    env,
    currentVersion,
    cacheFs,
    home,
    cwd,
    color,
    exists: seams.exists,
    readFile: seams.readFile,
    ...extra,
  })
  return {
    result,
    out: stdout.output(),
    raw: stdout.raw(),
    err: stderr.output(),
    chunks: stdout.chunks,
    seams,
  }
}

const GUTTER = 8
const prefixFor = (label) => `│ ${label.padEnd(GUTTER)}`
const rowValue = (out, label) => {
  const prefix = prefixFor(label)
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}
const boxLines = (out) => out.split('\n').filter((l) => /^[╭│╰]/.test(l))
/**
 * The box as RAW bytes — the block #75 added, and the only block whose colour this suite
 * controls.
 *
 * Scoped deliberately, because the dependency report under it is not doctor's answer to the
 * injected `color` seam: its ✓/✗/! markers have been `pc.green`/`pc.red`/`pc.yellow` since long
 * before this slice, and picocolors decides colour ONCE AT IMPORT out of the real environment,
 * which no injected bag can reach. So `CI=true` (how CI runs this suite) and FORCE_COLOR paint
 * those markers while a bare local run does not — and an escape-byte claim about the whole
 * stream would be a claim about the shell the suite was started from rather than about this
 * command. The frame's only colour source IS the seam, so that is where the claim belongs.
 */
const rawBox = (raw) =>
  raw
    .split('\n')
    .filter((l) => /^[╭│╰]/.test(stripAnsi(l)))
    .join('\n')
/** Every label the box drew, in order — the row SET, as data. */
const labelsOf = (out) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('│ '))
    .map((l) => l.slice(2, 2 + GUTTER))
    .filter((gutter) => /^[a-z]+ +$/.test(gutter))
    .map((gutter) => gutter.trim())
/**
 * Index of the first dependency line — 0 means nothing at all was printed above the report.
 *
 * Narrower than "a line starting with a marker" on purpose: the agent-fallback warning is
 * `  ! RALPH_AGENT=…`, which shares its first four columns with an optional dep's line. A
 * dependency line is a marker, one bare name, and at most a `(required)`/`(optional)` note.
 */
const DEP_LINE = /^ {2}[✓✗!] [\w.@/-]+( \((?:required|optional)\))?$/
const firstDepIndex = (out) => out.split('\n').findIndex((l) => DEP_LINE.test(l))
/** The dependency report and everything under it: what a box must never change. */
const reportFrom = (out) => out.split('\n').slice(firstDepIndex(out)).join('\n')

describe('QA #75 — RALPH_BANNER, driven from both sources at once', () => {
  // Spellings that MUST silence the box. The knob is normalised by trim + lowercase, and a
  // user who exports it from a shell script gets whatever their editor left on the line.
  const OFF_SPELLINGS = ['off', 'OFF', 'Off', 'oFF', ' off', 'off ', '  off  ', '\toff', 'off\n', '\r\noff\r\n']
  // ...and spellings that must NOT. Every one of them is a value nobody registered, and the
  // recovery is the DEFAULT — a box — because a typo in a picture knob may not cost a person
  // the diagnostic they ran the command for.
  const NOT_OFF_SPELLINGS = [
    'full',
    'FULL',
    'static',
    'Static',
    '',
    ' ',
    '\t\n',
    'offx',
    'of',
    'o f f',
    'off off',
    'off;full',
    '0',
    'false',
    'no',
    'none',
    'disabled',
    'true',
    'nonsense',
    'off()',
    '"off"',
    "'off'",
  ]

  for (const value of OFF_SPELLINGS) {
    it(`silences the box for RALPH_BANNER=${JSON.stringify(value)} in the environment`, async () => {
      const { out, raw, result } = await runDoctor({ env: { RALPH_BANNER: value } })
      // Not "no box" — NO BYTES. An orphan blank line where the box used to be would be a
      // knob that half worked, and the report has to start at the first line of output.
      expect(firstDepIndex(out)).toBe(0)
      expect(boxLines(out)).toEqual([])
      expect(raw.startsWith('  ')).toBe(true)
      expect(result.exitCode).toBe(0)
    })

    it(`silences the box for RALPH_BANNER=${JSON.stringify(value)} in ralph.config.sh`, async () => {
      const line = `RALPH_BANNER=${value}`
      const { out, result } = await runDoctor({ config: `${line}\n` })
      // The file grammar is LINE-BASED, so a spelling whose newline lands before the word
      // legitimately reads as an empty assignment and keeps the box. Asserted as whichever it
      // is — computed from the grammar's own rule, not hardcoded — so the difference between
      // the two readers stays visible rather than being skipped.
      const firstLine = line.split('\n')[0].slice('RALPH_BANNER='.length)
      const silenced = firstLine.trim().toLowerCase() === 'off'
      expect(boxLines(out).length === 0, JSON.stringify(firstLine)).toBe(silenced)
      expect(result.exitCode).toBe(0)
    })
  }

  for (const value of NOT_OFF_SPELLINGS) {
    it(`keeps the box for RALPH_BANNER=${JSON.stringify(value)}, silently`, async () => {
      const { out, err, result } = await runDoctor({ env: { RALPH_BANNER: value } })
      const isOff = value.trim().toLowerCase() === 'off'
      expect(boxLines(out).length > 0).toBe(!isOff)
      // And a typo costs the user NOTHING here: doctor deliberately drops the resolver's
      // warning rather than importing `oneLine` (and with it execa) to word it safely.
      expect(out).not.toMatch(/RALPH_BANNER/)
      expect(err).toBe('')
      expect(result.exitCode).toBe(0)
    })
  }

  it('lets the environment win over the config, in both directions', async () => {
    const envOffConfigFull = await runDoctor({
      env: { RALPH_BANNER: 'off' },
      config: 'RALPH_BANNER=full\n',
    })
    expect(boxLines(envOffConfigFull.out)).toEqual([])
    expect(firstDepIndex(envOffConfigFull.out)).toBe(0)

    const envFullConfigOff = await runDoctor({
      env: { RALPH_BANNER: 'full' },
      config: 'RALPH_BANNER=off\n',
    })
    expect(boxLines(envFullConfigOff.out).length).toBeGreaterThan(0)

    // A knob whose precedence differed between `ralph start` and `ralph doctor` would be two
    // knobs sharing a name, so the same two cases are asserted as one claim: whichever source
    // states something, the environment's answer is the one that lands.
    expect(envOffConfigFull.result.exitCode).toBe(0)
    expect(envFullConfigOff.result.exitCode).toBe(0)
  })

  it('defers to the config when the environment states nothing at all', async () => {
    // `RALPH_BANNER= ralph doctor` reaches us as the empty string, and reading THAT as a mode
    // would make the most easily-typed spelling of "no opinion" mean something.
    for (const override of [undefined, '', ' ', '\t', '\n']) {
      const { out } = await runDoctor({ env: { RALPH_BANNER: override }, config: 'RALPH_BANNER=off\n' })
      expect(boxLines(out), JSON.stringify(override)).toEqual([])
    }
  })

  it('documents the gap: an unusable env value outranks a config that says off', async () => {
    // `process.env` holds only strings, so this can only arrive from a caller assembling a bag
    // — but the behaviour is worth pinning rather than discovering. A non-string override is
    // STATED and unusable, which resolves to the default and never consults the config. So a
    // repo that committed `RALPH_BANNER=off` still gets a box under a bag like this one.
    for (const override of [42, true, {}, [], () => 'off', Symbol('off')]) {
      const { out, result } = await runDoctor({
        env: { RALPH_BANNER: override },
        config: 'RALPH_BANNER=off\n',
      })
      expect(boxLines(out).length, String(override)).toBeGreaterThan(0)
      expect(result.exitCode, String(override)).toBe(0)
    }
    // `null` and `undefined` are NOT statements, so those two do defer to the config.
    for (const override of [null, undefined]) {
      const { out } = await runDoctor({
        env: { RALPH_BANNER: override },
        config: 'RALPH_BANNER=off\n',
      })
      expect(boxLines(out), String(override)).toEqual([])
    }
  })

  // The assignment grammar, exercised through doctor rather than through the parser, because
  // "the same file means the same thing to both commands" is the property #75 promises and a
  // parser test cannot see the wiring.
  const CONFIG_GRAMMAR = [
    ['a bare assignment', 'RALPH_BANNER=off', true],
    ['an export prefix', 'export RALPH_BANNER=off', true],
    ['leading whitespace', '   RALPH_BANNER=off', true],
    ['a tab before the name', '\tRALPH_BANNER=off', true],
    ['spaces around the equals', 'RALPH_BANNER = off', true],
    ['double quotes', 'RALPH_BANNER="off"', true],
    ['single quotes', "RALPH_BANNER='off'", true],
    ['a trailing comment', 'RALPH_BANNER=off # quiet in CI', true],
    ['a quoted value and a comment', 'RALPH_BANNER="off" # quiet', true],
    ['CRLF line endings', 'RALPH_BANNER=off\r\nTASK_SOURCE=github\r\n', true],
    ['upper case in the file', 'RALPH_BANNER=OFF', true],
    ['a commented-out line', '# RALPH_BANNER=off', false],
    ['a commented-out line, no space', '#RALPH_BANNER=off', false],
    ['an indented comment', '   # RALPH_BANNER=off', false],
    ['a value that is only a comment', 'RALPH_BANNER=#off', false],
    ['a name that merely ends in ours', 'MY_RALPH_BANNER=off', false],
    ['a name that merely starts with ours', 'RALPH_BANNERX=off', false],
    ['a lowercase name', 'ralph_banner=off', false],
    ['the last assignment winning (off then full)', 'RALPH_BANNER=off\nRALPH_BANNER=full', false],
    ['the last assignment winning (full then off)', 'RALPH_BANNER=full\nRALPH_BANNER=off', true],
    ['a commented override after a real one', 'RALPH_BANNER=off\n# RALPH_BANNER=full', true],
    ['the setting buried in a real config', 'TASK_SOURCE=folder\n\n# banner\nRALPH_BANNER=off\nX=1', true],
  ]

  for (const [label, text, silenced] of CONFIG_GRAMMAR) {
    it(`reads ${label} the way ralph start does`, async () => {
      const { out, result } = await runDoctor({ config: `${text}\n` })
      expect(boxLines(out).length === 0, label).toBe(silenced)
      expect(result.exitCode, label).toBe(0)
    })
  }

  it('silences the box on the missing-critical path too, and still exits 1', async () => {
    // The case the knob is most likely to be set for (a CI job) crossed with the case doctor
    // exists for (a broken machine). Zero bytes before the report, and the exit code is the
    // dependency's — never the banner's.
    for (const source of [{ env: { RALPH_BANNER: 'off' } }, { config: 'RALPH_BANNER=off\n' }]) {
      const { out, err, result } = await runDoctor({ ...source, hasCommand: missing('git', 'tmux') })
      expect(firstDepIndex(out)).toBe(0)
      expect(boxLines(out)).toEqual([])
      expect(result.exitCode).toBe(1)
      expect(err).toContain('Missing 2 required dep(s): git, tmux')
    }
  })
})

describe('QA #75 — the config read is a new failure surface on the one command that must not fail', () => {
  const THROWN = [
    ['an Error', new Error('boom')],
    ['an EACCES', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
    ['an EISDIR', Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' })],
    ['an ELOOP', Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' })],
    ['a string', 'not an error'],
    ['null', null],
    ['a number', 7],
  ]

  for (const [label, thrown] of THROWN) {
    it(`survives an exists() that throws ${label}`, async () => {
      const { out, result, err } = await runDoctor({ seamOptions: { existsThrows: thrown } })
      // A config nobody can stat costs a PICTURE at worst — and not even that, because the
      // default when the knob cannot be read is the box.
      expect(boxLines(out).length).toBeGreaterThan(0)
      expect(rowValue(out, 'os')).toBe('mac')
      expect(result.exitCode).toBe(0)
      expect(err).toBe('')
    })

    it(`survives a readFile() that throws ${label}`, async () => {
      const { out, result } = await runDoctor({ config: 'RALPH_BANNER=off\n', seamOptions: { readThrows: thrown } })
      // Note which way this fails: the file EXISTS and says `off`, but it cannot be read, so
      // the knob is unreadable and the box prints. Failing towards the diagnostic is the
      // right direction for this command.
      expect(boxLines(out).length).toBeGreaterThan(0)
      expect(result.exitCode).toBe(0)
    })
  }

  // What the reader does with a non-string is `?.toString() || ''`, so a seam handing back a
  // Buffer (which is what `readFileSync` returns without an encoding) or an array of lines is
  // read as its text, and everything else is read as junk that matches no assignment. The
  // third column is whether the knob was therefore honoured.
  const READ_RETURNS = [
    ['a number', 42, false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['false', false, false],
    ['an object', {}, false],
    ['a Buffer of the real text', Buffer.from('RALPH_BANNER=off\n'), true],
    ['an array of lines', ['RALPH_BANNER=off'], true],
    ['a hostile toString', { toString: () => 'RALPH_BANNER=off' }, true],
    ['a toString that throws', { toString: () => { throw new Error('nope') } }, false],
  ]

  for (const [label, value, honoured] of READ_RETURNS) {
    it(`survives a readFile() returning ${label}`, async () => {
      const { out, result, err } = await runDoctor({
        config: 'RALPH_BANNER=full\n',
        seamOptions: { readReturns: value },
      })
      // Never a throw, never a moved exit code, and never a byte on stderr — whatever the fs
      // seam decides to hand back.
      expect(result.exitCode).toBe(0)
      expect(err).toBe('')
      expect(boxLines(out).length === 0, label).toBe(honoured)
    })
  }

  it('survives a config that is binary junk, and one that is a megabyte', async () => {
    const junk = `\u0000\u0001\u0002RALPH_BANNER\u0000=\u0000off\u0007${ESC}[31m\u009B0m\n`
    const junkRun = await runDoctor({ config: junk })
    expect(junkRun.result.exitCode).toBe(0)
    // Nothing out of that file reaches the screen: the box's facts come from arguments, and
    // the only question asked of this text is a mode name.
    expect(junkRun.raw).not.toContain('\u0000')
    expect(junkRun.raw).not.toMatch(CURSOR)
    expect(boxLines(junkRun.out).length).toBeGreaterThan(0)

    const huge = `${'# padding padding padding padding\n'.repeat(30_000)}RALPH_BANNER=off\n`
    const hugeRun = await runDoctor({ config: huge })
    expect(hugeRun.result.exitCode).toBe(0)
    // A megabyte of comments does not stop the LAST assignment from winning.
    expect(boxLines(hugeRun.out)).toEqual([])
  })

  it('resolves the config path from the injected cwd, absolutely, and asks for it once', async () => {
    const { seams } = await runDoctor({ cwd: '/somewhere/else', config: '' })
    expect(seams.calls.map((c) => c.op)).toEqual(['exists', 'read'])
    for (const call of seams.calls) {
      expect(call.path).toBe(join('/somewhere/else', 'ralph.config.sh'))
    }
  })

  it('resolves a relative cwd rather than handing a relative path to the fs', async () => {
    // `resolve` is what makes this absolute, and an fs seam receiving `sub/ralph.config.sh`
    // would be reading a path relative to whatever directory the process happens to be in.
    for (const cwd of ['sub', './sub', 'a/../sub', '/repo/', '/repo/.']) {
      const { seams, result } = await runDoctor({ cwd, config: '' })
      expect(seams.calls[0].path, cwd).toBe(resolvePath(cwd, 'ralph.config.sh'))
      expect(seams.calls[0].path.startsWith('/'), cwd).toBe(true)
      expect(result.exitCode, cwd).toBe(0)
    }
  })

  // `resolve` THROWS a TypeError on anything that is not a string, and `cwd` reaches doctor
  // from a caller's bag. A path join is not allowed to be the thing that breaks the command
  // people run when everything else already has.
  const HOSTILE_CWD = [
    ['a number', 42],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['an object', {}],
    ['an array', []],
    ['an array of paths', ['/repo']],
    ['a Symbol', Symbol('/repo')],
    ['a function', () => '/repo'],
    // eslint-disable-next-line no-new-wrappers
    ['a boxed String', new String('/repo')],
    ['the empty string', ''],
    ['a Buffer', Buffer.from('/repo')],
  ]

  for (const [label, cwd] of HOSTILE_CWD) {
    it(`never throws and never stats a path for a cwd that is ${label}`, async () => {
      const { out, result, seams, err } = await runDoctor({ cwd, config: 'RALPH_BANNER=off\n' })
      expect(result.exitCode).toBe(0)
      expect(err).toBe('')
      // No usable cwd means NO PATH, and no path means the fs is never touched — rather than
      // `resolve` being handed a non-string or a bare filename being stat'd relative to
      // wherever the process happens to be.
      expect(seams.calls).toEqual([])
      // ...so the knob in that unreachable file cannot be honoured, and the box prints. The
      // `cwd` row is structural rather than conditional (`ralph start` has drawn it since
      // #68), so it states `unknown` — the box says it does not know where it ran, which is
      // the honest answer, rather than dropping the row and reading as though it did.
      expect(boxLines(out).length).toBeGreaterThan(0)
      expect(rowValue(out, 'cwd')).toBe('unknown')
      expect(labelsOf(out)).toEqual(['os', 'agent', 'cached', 'cwd'])
    })
  }

  it('draws a hostile cwd as text and never as a row of its own', async () => {
    // The `cwd` row is the one fact in the box that is a path from outside, and a path is
    // exactly the kind of string a shell can put a newline in.
    const hostile = `/repo\n│ agent   forged\r${ESC}[31m\u0000`
    const { out, raw, chunks, result } = await runDoctor({ cwd: hostile })
    expect(result.exitCode).toBe(0)
    // The forged text SURVIVES — as text, inside one framed row, which is the correct answer:
    // the box reports the cwd it was given. What it must not do is let that text become
    // STRUCTURE, so the claim is about rows and lines rather than about words.
    expect(out.split('\n').filter((l) => l.startsWith(prefixFor('agent')))).toHaveLength(1)
    expect(rowValue(out, 'agent')).toBe('claude')
    expect(labelsOf(out)).toEqual(['os', 'agent', 'cached', 'cwd'])
    expect(rowValue(out, 'cwd').startsWith('/repo�')).toBe(true)
    // Every break, escape and NUL came out as one replacement character each, so no terminal
    // instruction and no second line survived.
    expect(raw).not.toMatch(CURSOR)
    expect(raw).not.toContain('\r')
    expect(raw).not.toContain('\u0000')
    expect(stripAnsi(raw)).not.toContain(ESC)
    // One line per write — a forged row would have arrived as a chunk with two.
    for (const chunk of chunks) {
      expect((chunk.match(/\n/g) ?? []).length, JSON.stringify(chunk)).toBe(1)
    }
    // ...and the frame still closes exactly once, at the full width.
    expect(boxLines(out).filter((l) => l.startsWith('╰'))).toHaveLength(1)
    for (const line of boxLines(out)) expect([...line].length).toBe(60)
  })
})

describe('QA #75 — still inert, structurally', () => {
  const DOCTOR = fileURLToPath(new URL('./doctor.js', import.meta.url))

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

  const graph = importGraph(DOCTOR)
  const rel = (f) => f.slice(f.indexOf('/lib/') + 1)
  const names = [...graph.files.keys()].map(rel)

  it('the walker reached the four modules #75 added (guards against a vacuous pass)', () => {
    // The companion suite pins this graph against #27's modules. If the walker stopped
    // following imports — a regex that stopped matching, a specifier form it does not know —
    // every forbidden-import assertion below would pass on an empty graph. So the NEW edges
    // are named too: these four are exactly what #75 put on this command's graph.
    for (const module of [
      'lib/banner-compose.js',
      'lib/banner-mode.js',
      'lib/read-config-source.js',
      'lib/parse-config-var.js',
    ]) {
      expect(names).toContain(module)
    }
    expect(names).toContain('lib/commands/doctor.js')
  })

  it('added not one third-party package and not one new builtin', () => {
    // The whole set, re-asserted from this file so that the gate survives the deletion of any
    // one suite: four modules joined the graph and the answer did not move.
    expect([...graph.bare].sort()).toEqual(['node:fs', 'node:os', 'node:path', 'picocolors'])
  })

  it('reaches nothing that can shell out, open a socket or draw a pixel', () => {
    const forbidden = [
      'execa',
      'node:child_process',
      'child_process',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'node:worker_threads',
      'node-fetch',
      'undici',
      'ws',
      // #75's own promise, as a specifier rather than as a word: the sprite, the renderer and
      // the animation player are four modules this command may not reach.
      '../sprite-banner.js',
      '../sprite-player.js',
      '../sprite-render.js',
      '../sprite-data.js',
      '../digest.js',
    ]
    for (const spec of forbidden) expect([...graph.bare]).not.toContain(spec)
    for (const [file, src] of graph.files) {
      for (const spec of specifiersOf(src)) {
        expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(
          /sprite|splash|execa|child_process|http|net|tls|dns|fetch/,
        )
      }
    }
  })

  it('names no animation in its code, and the comment-stripping is what makes that checkable', () => {
    // An inverted assertion, and it earns its place: doctor.js ARGUES at length about why it
    // does not import the sprite modules or `oneLine`, and that argument cannot be made
    // without naming them. A raw-text grep would therefore fail on the paragraph explaining
    // the very property it checks — so this test proves the prose contains those words AND
    // that the code does not, which is what keeps the guard from being weakened to nothing.
    const raw = readFileSync(DOCTOR, 'utf8')
    const code = codeWithoutComments(DOCTOR)
    for (const word of ['sprite', 'execa', 'animation']) {
      expect(raw, `prose should still discuss ${word}`).toMatch(new RegExp(word, 'i'))
      expect(code, `code must not mention ${word}`).not.toMatch(new RegExp(word, 'i'))
    }
  })

  it('emits no cursor control, no C1 introducer and no carriage return, in any mode', async () => {
    // Colour is fine in a paste; anything that MOVES a cursor is not. Driven with colour on,
    // because that is the only configuration in which this command emits escapes at all.
    for (const env of [{}, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'static' }, { RALPH_BANNER: 'off' }]) {
      for (const cacheFs of [warmCache('9.9.9'), warmCache(VERSION)]) {
        const { raw } = await runDoctor({ env, cacheFs, color: true, columns: 80 })
        // The positive control, so the negatives below cannot pass on an output that happens
        // to have no escapes in it at all: a box with a verdict in it was asked for in colour,
        // and colour arrived. (`off` prints no box, so there is nothing to paint.)
        const painted = env.RALPH_BANNER !== 'off'
        expect(SGR.test(rawBox(raw)), JSON.stringify(env)).toBe(painted)
        SGR.lastIndex = 0
        expect(raw, JSON.stringify(env)).not.toMatch(CURSOR)
        expect(raw, JSON.stringify(env)).not.toContain('\u009B')
        expect(raw, JSON.stringify(env)).not.toContain('\r')
        expect(raw, JSON.stringify(env)).not.toContain('\u0007')
      }
    }
  })

  it('emits not one escape byte in the box when colour is off, at every width', async () => {
    // Scoped to the BOX, not the stream, and the scope is the honest part: the dependency
    // report below the box paints its ✓/✗ markers with `pc.*` (lib/commands/doctor.js), which
    // reads the real environment at import time and cannot see this injected `color: false`.
    // A whole-stream claim here would therefore be a claim about the shell that launched
    // vitest — green on a bare terminal, red under CI=true — rather than about doctor. The
    // stream-wide version of this claim lives in the next test, where it is true by construction.
    for (const columns of [undefined, 200, 80, 60, 44, 43, 26, 25, 10, 0]) {
      const { raw } = await runDoctor({ color: false, columns, cacheFs: warmCache('9.9.9') })
      expect(rawBox(raw), String(columns)).not.toContain(ESC)
    }
  })

  // Run ONLY where picocolors is off, and split out rather than guarded inline: an `if` inside
  // the body would report a false green under CI=true, where it asserts nothing at all. Same
  // convention, same reason, as the skipIf at doctor.version-line.qa.test.js.
  it.runIf(!pc.isColorSupported)(
    'emits not one escape byte on the whole stream when colour is off, at every width',
    async () => {
      // The strongest form of the claim above, available only in this environment: with
      // picocolors dark, EVERY writer into this stream is colourless — doctor's injected seam
      // and the dependency report's `pc.*` markers alike — so a single escape anywhere in the
      // output would mean something emitted a hard-coded one.
      for (const columns of [undefined, 200, 80, 60, 44, 43, 26, 25, 10, 0]) {
        const { raw } = await runDoctor({ color: false, columns, cacheFs: warmCache('9.9.9') })
        expect(raw, String(columns)).not.toContain(ESC)
      }
    },
  )

  it('reads ralph.config.sh at most once, in every banner mode and every dep outcome', async () => {
    // Two readers of one file in one invocation could answer the same question differently if
    // the file changed in between — and it is also the cheapest possible proof that the knob
    // is resolved in one place rather than re-derived per row.
    for (const env of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'full' }, { RALPH_BANNER: 'typo' }]) {
      for (const hasCommand of [allPresent, missing('git'), missing('jq', 'curl')]) {
        for (const config of [undefined, 'RALPH_BANNER=off\n', 'RALPH_BANNER=full\n']) {
          const { seams } = await runDoctor({ env, hasCommand, config })
          const context = `${JSON.stringify(env)} / ${config}`
          expect(seams.calls.filter((c) => c.op === 'read').length, context).toBeLessThanOrEqual(1)
          expect(seams.calls.filter((c) => c.op === 'exists').length, context).toBe(1)
        }
      }
    }
  })

  it('reads the update-check cache once and writes nothing, in every banner mode', async () => {
    for (const env of [{}, { RALPH_BANNER: 'off' }, { RALPH_BANNER: 'static' }]) {
      const cacheFs = warmCache('9.9.9')
      const ops = []
      const spied = new Proxy(cacheFs, {
        get(target, prop) {
          const value = target[prop]
          if (typeof value !== 'function') return value
          return (...args) => {
            ops.push(String(prop))
            return value.apply(target, args)
          }
        },
      })
      const { result } = await runDoctor({ env, cacheFs: spied })
      expect(result.exitCode).toBe(0)
      for (const op of ops) {
        expect(op, `${JSON.stringify(env)}: ${op}`).not.toMatch(/write|append|mkdir|unlink|rm|rename|chmod|truncate/i)
      }
      // `off` still reads the cache, because the read is where the FACT comes from and the
      // knob only decides whether the fact is drawn. Pinned so a future "skip the read when
      // the box is off" optimisation is a deliberate change rather than a silent one.
      expect(ops.filter((op) => /read/i.test(op)).length).toBeLessThanOrEqual(2)
    }
  })

  it('writes one whole line per write, so the output is safe to pipe line by line', async () => {
    for (const columns of [undefined, 80, 44, 30]) {
      for (const hasCommand of [allPresent, missing('git'), missing('jq')]) {
        const { chunks } = await runDoctor({ columns, hasCommand, cacheFs: warmCache('9.9.9') })
        for (const chunk of chunks) {
          expect((chunk.match(/\n/g) ?? []).length, JSON.stringify(chunk)).toBe(1)
          expect(chunk.endsWith('\n'), JSON.stringify(chunk)).toBe(true)
        }
      }
    }
  })
})

describe('QA #75 — the exit code, as a cross product', () => {
  const DEP_OUTCOMES = [
    ['every dep present', allPresent, 0],
    ['a missing critical dep', missing('git'), 1],
    ['every critical dep missing', missing('git', 'gh', 'tmux', 'claude', 'node', 'npm'), 1],
    ['only optional deps missing', missing('jq', 'curl'), 0],
  ]
  const BANNER_SOURCES = [
    ['nothing set', {}, undefined],
    ['off in the environment', { RALPH_BANNER: 'off' }, undefined],
    ['off in the config', {}, 'RALPH_BANNER=off\n'],
    ['full in the environment over off in the config', { RALPH_BANNER: 'full' }, 'RALPH_BANNER=off\n'],
    ['an unrecognised value', { RALPH_BANNER: 'nonsense' }, undefined],
  ]
  const CACHE_STATES = [
    ['an empty cache', { cacheFs: new Volume() }],
    ['a cache with a newer version', { cacheFs: warmCache('99.0.0') }],
    ['a cache with the installed version', { cacheFs: warmCache(VERSION) }],
    ['a cache with junk in it', { cacheFs: Volume.fromJSON({ [CACHE_PATH]: 'not json' }, '/') }],
    ['a reader that throws', { extra: { readCache: () => { throw new Error('cache exploded') } } }],
    ['a reader that returns nonsense', { extra: { readCache: () => 42 } }],
  ]

  for (const [depLabel, hasCommand, expected] of DEP_OUTCOMES) {
    for (const [bannerLabel, env, config] of BANNER_SOURCES) {
      for (const [cacheLabel, cacheState] of CACHE_STATES) {
        it(`exits ${expected} with ${depLabel}, ${bannerLabel}, ${cacheLabel}`, async () => {
          const { result } = await runDoctor({ hasCommand, env, config, ...cacheState })
          expect(result.exitCode).toBe(expected)
          // The returned shape is part of the contract too — a wrapper reading
          // `missingCritical` must not start seeing a banner field.
          expect(Object.keys(result).sort()).toEqual([
            'exitCode',
            'missingCritical',
            'missingNonCritical',
            'platform',
          ])
          expect(result.platform).toBe('mac')
        })
      }
    }
  }

  it('leaves the dependency report byte-identical across every banner mode and cache state', async () => {
    // The report is what the command is FOR, and a box is additive output. Asserted as bytes
    // rather than as a shape, because "additive" is exactly the kind of claim that decays.
    for (const [, hasCommand] of DEP_OUTCOMES) {
      const runs = []
      for (const [, env, config] of BANNER_SOURCES) {
        for (const [, cacheState] of CACHE_STATES) {
          const { out, err } = await runDoctor({ hasCommand, env, config, ...cacheState })
          runs.push({ report: reportFrom(out), err })
        }
      }
      for (const run of runs) {
        expect(run.report).toBe(runs[0].report)
        expect(run.err).toBe(runs[0].err)
      }
    }
  })
})

describe('QA #75 — the box is first, even on the path that returns early', () => {
  it('prints the whole box above the first dependency line when a critical dep is missing', async () => {
    const broken = await runDoctor({ hasCommand: missing('git', 'tmux'), cacheFs: warmCache('99.0.0') })
    const healthy = await runDoctor({ hasCommand: allPresent, cacheFs: warmCache('99.0.0') })

    // Identical identity blocks: which Ralph, which platform, which agent, how stale, where —
    // the facts do not depend on whether the machine is broken, and a broken machine is
    // exactly the run whose paste needs them.
    expect(boxLines(broken.out)).toEqual(boxLines(healthy.out))
    expect(broken.out.split('\n\n')[0]).toBe(healthy.out.split('\n\n')[0])

    // ...and it is ABOVE the report, frame closed, in the right order.
    const lines = broken.out.split('\n')
    const closeIndex = lines.findIndex((l) => l.startsWith('╰'))
    expect(lines[0].startsWith('╭')).toBe(true)
    expect(closeIndex).toBeGreaterThan(0)
    expect(closeIndex).toBeLessThan(firstDepIndex(broken.out))
    expect(broken.result.exitCode).toBe(1)
    expect(broken.err).toContain('git, tmux')
  })

  it('carries the version and the agent even when the agent’s own CLI is the missing dep', async () => {
    // The failure mode this ordering exists to prevent: `claude` is not installed, doctor
    // returns 1, and the paste that lands in the bug report says nothing about which agent
    // or which version was being asked for.
    const { out, result } = await runDoctor({
      hasCommand: missing('claude'),
      env: { RALPH_AGENT: 'claude' },
      currentVersion: '1.2.3',
    })
    expect(out.split('\n')[0]).toMatch(/^╭─ ralph 1\.2\.3 ─+╮$/)
    expect(rowValue(out, 'agent')).toBe('claude')
    expect(rowValue(out, 'os')).toBe('mac')
    expect(result.exitCode).toBe(1)
  })

  it('draws exactly the four rows doctor has facts for, and no others', async () => {
    // The row SET, as a claim. `ralph start`'s box grew `new` and `more` rows (#70) and an
    // `update` row's worth of advice (#27) — none of which doctor passes facts for, and any of
    // which appearing here would mean a fact leaked in from another caller's bag.
    const { out } = await runDoctor({ cacheFs: warmCache('99.0.0') })
    expect(labelsOf(out)).toEqual(['os', 'agent', 'cached', 'cwd'])
    for (const absent of ['new', 'more', 'update', 'model', 'source', 'version', 'interval']) {
      expect(rowValue(out, absent), absent).toBeUndefined()
    }
  })

  it('folded the two old lines in rather than printing the facts twice', async () => {
    const { out } = await runDoctor({ cacheFs: warmCache('99.0.0'), currentVersion: '1.2.3' })
    // The old header and the old version line, by their exact shapes.
    expect(out).not.toMatch(/Ralph doctor/)
    expect(out).not.toMatch(/^\s*version:/m)
    expect(out).not.toMatch(/^\s*platform:/m)
    expect(out).not.toMatch(/cached latest:/)
    // And each fact appears exactly ONCE in the whole output.
    expect(out.split('1.2.3')).toHaveLength(2)
    expect(out.split('99.0.0')).toHaveLength(2)
  })

  it('documents the gap: a hostile RALPH_AGENT forges a line under the box', async () => {
    // NOT introduced by #75 and NOT fixable here — `resolveAgent` interpolates the raw
    // RALPH_AGENT into its warning (#559) and doctor prints that warning verbatim, so a value
    // containing a newline has always produced an extra stdout line. What #75 changed is what
    // that line can be mistaken FOR: there are frame glyphs in doctor's output now, so a
    // forged line reading `│ cwd     /elsewhere` sits directly under a real `╰────╯` and
    // reads as part of the box in a pasted report.
    //
    // Pinned as the CURRENT behaviour rather than left red, because the fix belongs in
    // resolveAgent's wording (`ralph start` already routes the same class through `oneLine`),
    // and a QA suite that fails on an unrelated module's pre-existing defect gets weakened
    // rather than heeded. The claims that DO hold are asserted underneath.
    const hostile = `x\n│ cwd     /elsewhere`
    const { out, raw, chunks, result } = await runDoctor({ env: { RALPH_AGENT: hostile } })

    // The gap, in three shapes: one `out()` call produced two terminal lines, the second of
    // them is shaped exactly like a row, and a reader counting rows therefore sees FIVE — the
    // trailing `cwd` in this list is the forgery, not a fact.
    const forged = chunks.filter((c) => (c.match(/\n/g) ?? []).length > 1)
    expect(forged).toHaveLength(1)
    expect(out).toContain('│ cwd     /elsewhere')
    expect(labelsOf(out)).toEqual(['os', 'agent', 'cached', 'cwd', 'cwd'])

    // The BOX itself is not poisoned, and that is the part #75 owns: the row it drew names the
    // agent that was RESOLVED, the real rows are unchanged, and the forged line is outside the
    // frame — below the `╰` rather than inside it.
    expect(rowValue(out, 'agent')).toBe('claude')
    expect(rowValue(out, 'cwd')).toBe(CWD)
    expect(boxLines(out).filter((l) => l.startsWith('╰'))).toHaveLength(1)
    const lines = out.split('\n')
    const forgedIndex = lines.findIndex((l) => l.startsWith('│ cwd     /elsewhere'))
    expect(forgedIndex).toBeGreaterThan(lines.findIndex((l) => l.startsWith('╰')))
    // It is also not the box's width and it has no right border, which is all a reader of the
    // paste has to go on — the rest of the warning's sentence trails off the end of it.
    expect([...lines[forgedIndex]].length).not.toBe(60)
    expect(lines[forgedIndex].endsWith(' │')).toBe(false)
    expect(lines[forgedIndex]).toContain('unrecognized')
    // No escape byte and no cursor movement can be smuggled in with it, and the exit code is
    // still the dependency check's.
    expect(raw).not.toMatch(CURSOR)
    expect(stripAnsi(raw)).not.toContain(ESC)
    expect(result.exitCode).toBe(0)
  })

  it('keeps the agent warning even when the box is off — the knob silences a picture', async () => {
    // Deliberate, and worth pinning against a future reading of "off means no bytes": a
    // warning about the agent doctor is validating is a DIAGNOSTIC, and this command's
    // contract is that it reports what it found.
    const { out, result } = await runDoctor({ env: { RALPH_AGENT: 'gpt5', RALPH_BANNER: 'off' } })
    expect(boxLines(out)).toEqual([])
    expect(out).toMatch(/! RALPH_AGENT='gpt5' unrecognized/)
    expect(firstDepIndex(out)).toBe(2)
    expect(result.exitCode).toBe(0)
  })

  it('forwards the stream’s own width, so a captured run is measured on what it writes to', async () => {
    // #72's ladder is doctor's only say over the box's shape, and reading `process.stdout`
    // instead of the injected stream would make every piped run 60 columns wide by accident.
    // Under 44 columns the frame comes off (#72) and the facts stay — a narrow terminal costs
    // ink, never a diagnostic. Asserted on the bare form's own shape, since there are no `│`
    // glyphs left to read the rows off.
    const bareLabels = (out) =>
      out
        .split('\n')
        .map((l) => l.slice(0, GUTTER))
        .filter((gutter) => /^[a-z]+ +$/.test(gutter))
        .map((gutter) => gutter.trim())

    for (const columns of [43, 30, 26, 25, 12]) {
      const narrow = await runDoctor({ columns, cacheFs: warmCache('99.0.0') })
      expect(boxLines(narrow.out), String(columns)).toEqual([])
      expect(narrow.out.split('\n')[0], String(columns)).toMatch(/^ralph /)
      expect(bareLabels(narrow.out), String(columns)).toEqual(['os', 'agent', 'cached', 'cwd'])
      // Only the identity block is width-managed — the dependency report is not, and never was.
      const head = narrow.out.split('\n\n')[0]
      for (const line of head.split('\n')) {
        expect([...line].length, `${columns}: ${line}`).toBeLessThanOrEqual(columns)
      }
      expect(narrow.result.exitCode, String(columns)).toBe(0)
    }

    const wide = await runDoctor({ columns: 200 })
    for (const line of boxLines(wide.out)) expect([...line].length).toBe(60)

    // A stream with no columns at all is a pipe, and a pipe gets the full 60-column box: this
    // command's output IS the paste, so the facts do not depend on there being a terminal.
    const piped = await runDoctor({ columns: undefined })
    for (const line of boxLines(piped.out)) expect([...line].length).toBe(60)
    expect(labelsOf(piped.out)).toEqual(['os', 'agent', 'cached', 'cwd'])
  })
})
