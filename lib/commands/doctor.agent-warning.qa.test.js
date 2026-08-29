import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { doctorCommand, assertCriticalDeps } from './doctor.js'

// #108 QA — the agent-fallback warning as `ralph doctor` actually emits it.
//
// doctor.identity-box.qa.test.js closes the reported hole (a newline in RALPH_AGENT) and sweeps
// the terminal-instruction class (ESC, CR, NUL, C1 CSI, BEL). This file takes the same command
// and attacks what neither that sweep nor lib/one-line.test.js can see, because all three of
// these questions are about the JOURNEY of the value rather than about one function:
//
//   1. WHAT REACHES THE WIRE, in bytes. Every existing assertion is made on the STRING doctor
//      handed the stream. A terminal does not receive a JavaScript string, it receives UTF-8 —
//      and a string can be perfectly single-line and still be unencodable, in which case Node
//      substitutes bytes NOBODY put in the value. A report that invents a character is a report
//      that misstates what was set, which is the same defect class #108 was filed about seen
//      one layer down.
//   2. WHAT A CALLER CAN PUT IN THE BAG. `doctorCommand({ env })` takes env as an injected seam
//      (#41), so `env.RALPH_AGENT` is not necessarily a string here even though `process.env`
//      would have made it one. The command that must work on a broken machine should not be the
//      one that throws on a bag.
//   3. WHAT IS DELIBERATELY LEFT ALONE. The denylist keeps the bidi and zero-width characters,
//      for lib/banner-rows.js's stated reason, and the existing sweep contains none of them.
//      Kept behaviour needs a test as much as scrubbed behaviour does, or the next reader cannot
//      tell an argued omission from a forgotten one.
//
// Plus the structural half of criterion 4: the import graph now runs through lib/one-line.js,
// and no existing anti-vacuity assertion names it — so a walk that silently stopped short would
// keep reporting "exactly four bare specifiers" for a graph it never finished.
//
// Every run injects the cache fs, the home, the cwd, the config seams, the colour capability and
// the columns, so nothing here touches the real machine. Control characters are built from their
// code points (#107).

const ESC = String.fromCharCode(0x1b)
const LF = String.fromCharCode(0x0a)
const NUL = String.fromCharCode(0x00)
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(SGR, '')
const CURSOR = new RegExp(`${ESC}\\[(?:\\?25[lh]|[0-9;]*[ABCDEFGHJKSTfnsu])|${ESC}[78MD]`)
const PLACEHOLDER = String.fromCharCode(0xfffd)

const HOME = '/home/me'
const CWD = '/repo'
const VERSION = '0.17.0'
const GUTTER = 8

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

const allPresent = () => true
const missing = (...names) => (name) => !names.includes(name)

async function runDoctor({
  env = {},
  hasCommand = allPresent,
  columns,
  cacheFs = new Volume(),
  cwd = CWD,
} = {}) {
  const stdout = makeStream(columns)
  const stderr = makeStream()
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand,
    platform: 'mac',
    env,
    currentVersion: VERSION,
    cacheFs,
    home: HOME,
    cwd,
    color: false,
    exists: () => false,
    readFile: () => '',
  })
  return {
    result,
    out: stdout.output(),
    raw: stdout.raw(),
    err: stderr.output(),
    chunks: stdout.chunks,
  }
}

const labelsOf = (out) =>
  out
    .split(LF)
    .filter((l) => l.startsWith('│ '))
    .map((l) => l.slice(2, 2 + GUTTER))
    .filter((gutter) => /^[a-z]+ +$/.test(gutter))
    .map((gutter) => gutter.trim())
const boxLines = (out) => out.split(LF).filter((l) => /^[╭│╰]/.test(l))
const prefixFor = (label) => `│ ${label.padEnd(GUTTER)}`
const rowValue = (out, label) => {
  const prefix = prefixFor(label)
  const line = out.split(LF).find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}
const DEP_LINE = /^ {2}[✓✗!] [\w.@/-]+( \((?:required|optional)\))?$/
const firstDepIndex = (out) => out.split(LF).findIndex((l) => DEP_LINE.test(l))
const reportFrom = (out) => out.split(LF).slice(firstDepIndex(out)).join(LF)
const warningLineOf = (out) => out.split(LF).find((l) => l.includes('unrecognized'))
/** What a terminal actually receives: the string, encoded to UTF-8 and read back. */
const overTheWire = (raw) => Buffer.from(raw, 'utf8').toString('utf8')
const countOf = (text, char) => [...text].filter((c) => c === char).length
/** One write, one line — the invariant the whole issue is about, checked per chunk. */
const expectOneLinePerWrite = (chunks, label) => {
  for (const chunk of chunks) {
    expect((chunk.match(/\n/g) ?? []).length, `${label}: ${JSON.stringify(chunk)}`).toBe(1)
  }
}

describe('QA #108 — what reaches the wire, in bytes rather than in characters', () => {
  it('puts no character on stdout that the value did not contain', async () => {
    // THE DEFECT THIS CLOSED. `oneLineEcho` used to cap its echo with `text.slice(0, 199)`, which
    // slices UTF-16 CODE UNITS — and an emoji is two of them. A 200-emoji RALPH_AGENT is 400
    // units long, so the cut landed between the halves of the hundredth pair and the warning
    // ended with a LONE HIGH SURROGATE. That string has no UTF-8 encoding, so Node substituted
    // U+FFFD on the way out: the report showed a replacement character that the user's value
    // never contained, in the one place the report is quoting the user back at themselves.
    // `cap` now counts and slices code points (`[...text]`), so a pair cannot be halved.
    //
    // The assertion is deliberately made on the ENCODED stream rather than on the string,
    // because that is where the substitution happens and every existing assertion in this repo
    // stops one layer above it. It is also the honest statement of the contract: the number of
    // "there is a character here you cannot see" marks a reader sees must be the number the
    // sanitiser decided to put there.
    //
    // lib/banner-compose.js had already solved this exact problem in this exact repo — `clip` and
    // `visibleWidth` both count with `[...s]`, with a comment saying why — so the fix was the one
    // that module already made. Pinned end-to-end as well as in lib/one-line.qa.test.js, because
    // "no lone surrogate leaves cap()" is a unit claim and "the report says only true things" is
    // this command's claim.
    const emoji = String.fromCodePoint(0x1f600)
    const { out, raw, chunks, result } = await runDoctor({
      env: { RALPH_AGENT: emoji.repeat(200) },
    })

    expect(raw.isWellFormed()).toBe(true)
    expect(countOf(overTheWire(raw), PLACEHOLDER)).toBe(countOf(raw, PLACEHOLDER))

    // The rest of the guarantee is intact, and saying so is what makes this a report about ONE
    // defect: still one line per write, still four rows, still exit 0.
    expectOneLinePerWrite(chunks, 'astral value')
    expect(labelsOf(out)).toEqual(['os', 'agent', 'cached', 'cwd'])
    expect(result.exitCode).toBe(0)
  })

  it('bounds the warning line, and the bound is on the whole line', async () => {
    // The cap exists so a pathological value cannot fill a terminal — and the number that
    // matters to a reader is the LINE's, not the echo's. 276 is the ceiling: `  ! ` from doctor,
    // 13 characters of `RALPH_AGENT='`, the 200-character echo, and 63 characters of wording.
    const { out, chunks } = await runDoctor({ env: { RALPH_AGENT: 'x'.repeat(100_000) } })
    const warning = warningLineOf(out)
    expect(warning).toHaveLength(4 + 276)
    expect(warning.endsWith(`. Valid: claude, codex.`)).toBe(true)
    expectOneLinePerWrite(chunks, 'very long value')
  })

  it('is still one WRITE and one newline on a narrow terminal, soft wrap notwithstanding', async () => {
    // The residual, on the record. Criterion 1 is about lines EMITTED, and it holds at any
    // width: one `out()` call, one trailing newline. What the cap bounds rather than eliminates
    // is the SOFT wrap — 280 characters in a 40-column terminal occupies seven visual rows, and
    // the last of them begins at column zero underneath the frame, which is the same optical
    // effect #108 was reported about with none of the same cause. Nothing this command can do
    // about it without knowing the width of the reader's terminal, which a piped run does not
    // have; pinned so the distinction between "emits one line" and "occupies one row" is a
    // documented limit rather than a gap someone rediscovers.
    const { out, chunks, result } = await runDoctor({
      env: { RALPH_AGENT: 'x'.repeat(5000) },
      columns: 40,
    })
    expectOneLinePerWrite(chunks, 'narrow terminal')
    expect(out.split(LF).filter((l) => l.includes('unrecognized'))).toHaveLength(1)
    expect(result.exitCode).toBe(0)
  })
})

describe('QA #108 — the env bag is a seam, and a seam takes what it is given', () => {
  // `doctorCommand({ env })` is an injected default (#41), and lib/commands/cycle.js and
  // lib/commands/init.js both prove that callers in this package assemble bags by hand. A bag
  // holds whatever the caller put in it; `process.env` would have stringified it.
  const COERCIBLE = {
    'a number': 7,
    'a boolean': true,
    'an array': ['codx', 'claude'],
    'a plain object': {},
    'a custom toString': { toString: () => `codx${LF}│ cwd     /elsewhere` },
    'a Symbol': Symbol('codx'),
    'a bigint': 7n,
  }

  for (const [label, value] of Object.entries(COERCIBLE)) {
    it(`reports ${label} on one line and exits 0`, async () => {
      const { out, raw, chunks, result } = await runDoctor({ env: { RALPH_AGENT: value } })
      expectOneLinePerWrite(chunks, label)
      expect(labelsOf(out), label).toEqual(['os', 'agent', 'cached', 'cwd'])
      expect(rowValue(out, 'agent'), label).toBe('claude')
      expect(out, label).toContain('unrecognized')
      expect(stripAnsi(raw), label).not.toContain(ESC)
      expect(raw, label).not.toMatch(CURSOR)
      expect(raw, label).not.toContain(NUL)
      expect(result.exitCode, label).toBe(0)
    })
  }

  it('documents the gap: a bag whose value cannot be coerced throws out of doctorCommand', async () => {
    // NOT a #108 regression — the throw is on resolveAgent's emptiness guard,
    // `String(raw).trim() === ''`, which runs BEFORE the sanitiser and would throw identically
    // on the pre-#108 code. Pinned here rather than nowhere because of what this command IS: a
    // diagnostic whose every other impure act is wrapped (`readConfigText` never throws,
    // `cachedLatestVersion` catches a TypeError out of a path join, `configPathFor` refuses a
    // non-string cwd) precisely so `ralph doctor` cannot die on the machine it was run to
    // diagnose. The env bag is the one seam with no such guard, and it is the seam a caller is
    // most likely to assemble.
    await expect(
      runDoctor({ env: { RALPH_AGENT: { toString: () => { throw new Error('nope') } } } }),
    ).rejects.toThrow('nope')
    await expect(runDoctor({ env: { RALPH_AGENT: Object.create(null) } })).rejects.toThrow(TypeError)
  })
})

describe('QA #108 — what the denylist keeps, and what that looks like in the report', () => {
  // None of these is in `CONTROL`, and lib/banner-rows.js argues the omission: they REORDER
  // or JOIN text a terminal is otherwise printing normally, and replacing them would mangle a
  // legitimate value carrying a ZWJ emoji sequence. The existing sweep in
  // doctor.identity-box.qa.test.js contains not one of them, so "kept" has never been asserted
  // at the level where it matters — the command whose output goes into a bug report.
  const KEPT = {
    'a right-to-left override': String.fromCharCode(0x202e),
    'an unterminated isolate': String.fromCharCode(0x2067),
    'a zero-width space': String.fromCharCode(0x200b),
    'a zero-width joiner': String.fromCharCode(0x200d),
    'a soft hyphen': String.fromCharCode(0x00ad),
    'a word joiner': String.fromCharCode(0x2060),
    'a byte-order mark': String.fromCharCode(0xfeff),
    'a combining accent': String.fromCharCode(0x0300),
    'a variation selector': String.fromCodePoint(0xe0100),
    'a tag character': String.fromCodePoint(0xe0041),
  }

  for (const [label, char] of Object.entries(KEPT)) {
    it(`keeps ${label} as text without forging a line`, async () => {
      // DOCUMENTED BEHAVIOUR. The claim being pinned is not that the character is scrubbed — it
      // is not — but that keeping it cannot do the thing #108 is about: one write, one line, the
      // frame intact, four rows, exit 0. A bidi override CAN visually reorder the remainder of
      // the sentence in a terminal that honours it, which is a legibility residual rather than a
      // forged line, and the difference is exactly why the class is drawn where it is.
      const value = `co${char}dx`
      const { out, raw, chunks, result } = await runDoctor({ env: { RALPH_AGENT: value } })
      expectOneLinePerWrite(chunks, label)
      expect(warningLineOf(out), label).toContain(`RALPH_AGENT='${value}'`)
      expect(labelsOf(out), label).toEqual(['os', 'agent', 'cached', 'cwd'])
      expect(boxLines(out).filter((l) => l.startsWith('╰')), label).toHaveLength(1)
      expect(raw, label).not.toMatch(CURSOR)
      expect(raw.isWellFormed(), label).toBe(true)
      expect(result.exitCode, label).toBe(0)
    })
  }

  it('prints no warning at all when the value trims to a real agent', async () => {
    // The path the sanitiser is NOT on, and the likeliest way a newline gets into this variable
    // in the first place: `RALPH_AGENT=$'codex\n'` out of a heredoc or a `$(...)`. resolveAgent
    // trims before it looks up, so this is a clean resolution — the box says codex, there is no
    // warning line and no blank line separating one, and the report starts where it does with
    // the variable unset. Pinned so a future "sanitise everything at the door" refactor cannot
    // start warning about values that are not typos.
    const { out, chunks, result } = await runDoctor({ env: { RALPH_AGENT: `${LF}codex${LF}` } })
    expect(out).not.toContain('unrecognized')
    expect(rowValue(out, 'agent')).toBe('codex')
    expectOneLinePerWrite(chunks, 'trims to codex')
    expect(result.exitCode).toBe(0)
  })

  it('leaks the value into no row of the box and no second place in the report', async () => {
    // The forgery #75 made possible was a line that READ as a row. The complement of that is
    // worth pinning too: the hostile text appears exactly ONCE in the whole output, in the
    // warning, and never inside the frame — the `agent` row names what was RESOLVED, because
    // that is the fact doctor is reporting and the typo is the annotation on it.
    const { out } = await runDoctor({ env: { RALPH_AGENT: `co${NUL}dx` } })
    const echoed = `co${PLACEHOLDER}dx`
    expect(out.split(echoed)).toHaveLength(2)
    expect(boxLines(out).join(LF)).not.toContain(echoed)
    expect(rowValue(out, 'agent')).toBe('claude')
  })
})

describe('QA #108 — the exit code and the report do not move for any value', () => {
  const HOSTILE = {
    'a newline': `x${LF}│ cwd     /elsewhere`,
    'a NUL': `co${NUL}dx`,
    'an escape': `${ESC}[2J`,
    'a very long value': 'x'.repeat(5000),
    'an astral run': String.fromCodePoint(0x1f600).repeat(200),
    'a bidi override': `co${String.fromCharCode(0x202e)}dx`,
    'a non-string': 7,
  }

  it('still exits 1 on a missing critical dep, and reports it on stderr unchanged', async () => {
    // The cross product #75's suite drives for the banner knob, driven for the AGENT value: a
    // warning is additive output, and the thing every wrapper and CI step gates on is the exit
    // code. A sanitiser that swallowed a value, or a warning that changed which deps were
    // checked, would show up here rather than in the field.
    const clean = await runDoctor({ hasCommand: missing('gh') })
    expect(clean.result.exitCode).toBe(1)
    for (const [label, value] of Object.entries(HOSTILE)) {
      const run = await runDoctor({ env: { RALPH_AGENT: value }, hasCommand: missing('gh') })
      expect(run.result.exitCode, label).toBe(1)
      expect(run.result.missingCritical.map((r) => r.name), label).toEqual(['gh'])
      // Byte-identical from the first dependency line down — the report is not the warning's
      // business, and the stderr summary is what a wrapper greps.
      expect(reportFrom(run.out), label).toBe(reportFrom(clean.out))
      expect(run.err, label).toBe(clean.err)
      expectOneLinePerWrite(run.chunks, label)
    }
  })

  it('exits 0 with the report unchanged when everything is present', async () => {
    const clean = await runDoctor()
    expect(clean.result.exitCode).toBe(0)
    for (const [label, value] of Object.entries(HOSTILE)) {
      const run = await runDoctor({ env: { RALPH_AGENT: value } })
      expect(run.result.exitCode, label).toBe(0)
      expect(reportFrom(run.out), label).toBe(reportFrom(clean.out))
      expect(run.err, label).toBe('')
    }
  })

  it('echoes nothing at all from assertCriticalDeps, which resolves the same agent', async () => {
    // The OTHER resolveAgent caller in this file, and the one nobody checked: it destructures
    // `{ agent }` only, so the warning is dropped and its message is composed from dependency
    // names. That is what makes the sanitiser's placement sufficient rather than merely
    // convenient — a caller that never echoes needs no guarantee. Pinned so a future edit that
    // "helpfully" surfaced the warning here does so with a line-count test attached.
    for (const [label, value] of Object.entries(HOSTILE)) {
      const result = assertCriticalDeps({
        hasCommand: missing('gh'),
        platform: 'mac',
        env: { RALPH_AGENT: value },
      })
      expect(result.ok, label).toBe(false)
      expect(result.message, label).toBe(
        "❌ 'gh' not found in PATH (install: brew install gh)",
      )
      expect(result.message, label).not.toContain('RALPH_AGENT')
      // ...and the agent it validated is the fallback, so the dep set is claude's.
      expect(result.missingCritical.map((r) => r.name), label).toEqual(['gh'])
    }
  })
})

describe('QA #108 — the import graph, with the new module named', () => {
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
        if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec))
        else bare.add(spec)
      }
    }
    return { files, bare }
  }

  const graph = importGraph(DOCTOR)
  const rel = (f) => f.slice(f.indexOf('/lib/') + 1)
  const names = [...graph.files.keys()].map(rel)

  it('actually reached the module #108 added (guards against a vacuous pass)', () => {
    // THE ASSERTION THAT WAS MISSING. doctor.version-line.qa.test.js pins the bare-specifier set
    // to four and guards against vacuity by naming the modules #27 added — which predate this
    // slice entirely. #108 lengthened the chain by two hops (doctor -> agent-registry ->
    // one-line), and if the walker ever stopped short of them it would keep asserting "exactly
    // four" about a graph it never finished, i.e. it would pass BECAUSE of the bug. A vacuous
    // pass is worse than a failure, so the new hops are named.
    expect(names).toContain('lib/one-line.js')
    expect(names).toContain('lib/agent-registry.js')
    expect(names).toContain('lib/commands/doctor.js')
  })

  it('still pulls in exactly four bare specifiers with that module on the graph', () => {
    // Criterion 4, restated where the new edge is: extracting the sanitiser bought doctor a
    // guarantee only if the extraction did not itself import anything. This is the same
    // assertion doctor.version-line.qa.test.js makes; it is duplicated here on purpose, because
    // the two files would fail for different reasons and a reader chasing #108 should find the
    // constraint in the file about #108.
    expect([...graph.bare].sort()).toEqual(['node:fs', 'node:os', 'node:path', 'picocolors'])
  })

  it('reaches lib/one-line.js WITHOUT reaching lib/digest.js', () => {
    // The whole reason the extraction happened. The lazy fix would have been to import `oneLine`
    // from lib/digest.js, where its body used to live — and lib/digest.js imports execa, which
    // would have put a subprocess dependency on the offline diagnostic. That shortcut is not
    // merely discouraged now, it is UNSPELLABLE: the same change deleted lib/digest.js's
    // `oneLine` re-export and repointed every caller at lib/one-line.js, so the only import path
    // to the flattener is the dependency-free one. This spec is what keeps it that way if the
    // re-export is ever restored. Asserted as the absence of a FILE on the graph, which is
    // stronger than the absence of the `execa` specifier: a module that imports execa
    // transitively would still fail this.
    expect(names).not.toContain('lib/digest.js')
    expect(names).not.toContain('lib/digest-history.js')
    expect(names.some((n) => n.includes('digest'))).toBe(false)
    for (const [file, src] of graph.files) {
      expect(/\bexeca\b/.test(src), `${rel(file)} must not reference execa`).toBe(false)
    }
  })

  it('finds a real module on that graph reachable ONLY through the new edge', () => {
    // Second anti-vacuity check, and a different kind: the test above proves the walk touched
    // lib/one-line.js, and this one proves the walk is following EDGES rather than globbing a
    // directory. lib/one-line.js is reachable from doctor.js by exactly one path — through
    // lib/agent-registry.js — so cutting that edge must remove it from the graph.
    const registry = join(dirname(DOCTOR), '..', 'agent-registry.js')
    expect(names).toContain('lib/agent-registry.js')
    expect(codeWithoutComments(registry)).toContain("'./one-line.js'")
    // Nothing else doctor imports mentions it, which is what makes the path unique.
    const mentions = [...graph.files.entries()]
      .filter(([, src]) => src.includes('one-line.js'))
      .map(([file]) => rel(file))
    expect(mentions).toEqual(['lib/agent-registry.js'])
  })
})
