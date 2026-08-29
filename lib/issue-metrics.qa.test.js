// #117 QA — the two things a rename can get wrong, and the contract it promised not to touch.
//
// The issue is explicitly mechanical: one identifier, no behaviour change. That makes the
// interesting failure modes COMPLETENESS and EQUIVALENCE rather than logic, and the suite next
// door (issue-metrics.test.js) already covers the happy shape of both. What it cannot see:
//
//   * EQUIVALENCE AT THE EDGES. `readFile(path, 'utf8')?.toString() || ''` is nullish-coalescing
//     on the way IN and falsy-coalescing on the way OUT, and the `try` wraps the COERCION as well
//     as the read. So the answers at the edges are not the ones a reader guesses: a Symbol comes
//     back as prose rather than throwing, a `toString` that returns a number comes back AS a
//     number, and a `toString` that throws is swallowed exactly like a missing file. None of that
//     is written down anywhere, which means "no behaviour change" is unfalsifiable — the tidy that
//     would change it (`String(value ?? '')`) passes every existing test and throws on a Symbol.
//     Each edge below is pinned as the BOUNDARY it is, not as a wish: where the answer is merely
//     what JavaScript happens to do, the comment says so and names who absorbs it.
//
//   * COMPLETENESS, over the whole authored tree rather than over `.js` under lib/, bin/ and
//     test/. Those three roots are this repo's established scope for an IMPORT-EDGE guard (#116's
//     `sourceFiles()` walks exactly them, correctly, because an import edge can only live in a
//     `.js`). #117's claim is wider: a comment still naming the old reader is the same wrong
//     signpost the rename came down to remove, so PROSE is in scope — and prose lives in 38
//     tracked files those roots do not contain. README.md, CONTRIBUTING.md (which names lib
//     internals today: `resolveBannerRepo`, `resolveAgent`), docs/, every prompt template, and
//     six `scripts/*.js` of which `scripts/lib/sprite-build.js` imports out of lib/ for real
//     while two more are CLI entrypoints no suite statically imports. So the sweep here is over
//     what git TRACKS, at every extension, and it is the ONLY sweep for this property: a second
//     one over a narrower scope would be a duplicate guard whose failures say less.
//
//   * THE TWIN. `safeReadHistory` in commands/status.js is now this function's body a second
//     time, deliberately left alone. Deliberate duplication is only safe while it stays
//     duplication (#116's argument for `bagOf`/`trimmedOr`), so the byte-identity is asserted
//     rather than asserted-in-a-comment, and a fix applied to one copy is a red test here.
//
// Nothing in this file reads a clock, an environment or a network. It does read this
// repository's own source and shell out to `git ls-files`, which is what a structural guard is —
// same method as test/source-control-bytes.test.js and #116's extraction spec.
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as issueMetrics from './issue-metrics.js'
import { aggregateCycleCounts, safeReadText } from './issue-metrics.js'
// The tag, borrowed rather than re-spelled — which is the point of #121, and which also keeps
// this file out of the drift sweep next door by not adding a fifth copy of the literal.
import { ISSUE_EVENT_TAG } from './issue-event-lines.js'
import { RALPH_HOME } from './paths.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import { trackedFiles } from '../test/helpers/source-control-bytes.js'

const METRICS_MODULE = join(RALPH_HOME, 'lib', 'issue-metrics.js')
const STATUS_MODULE = join(RALPH_HOME, 'lib', 'commands', 'status.js')
const START_MODULE = join(RALPH_HOME, 'lib', 'commands', 'start.js')

// A path, because nothing in the function looks at one. Deliberately not a metrics path: the
// whole of #117 is that the subject is the caller's business.
const ANY_PATH = '/anywhere/at/all'

// ---------------------------------------------------------------------------------------------
// The contract at its edges.
// ---------------------------------------------------------------------------------------------
describe('safeReadText — the edges of the never-throws contract (#117 QA)', () => {
  it("answers '' when the VALUE's coercion throws, not only when the read does", () => {
    // The `try` spans `?.toString()` too, which is the half no existing test distinguishes: a
    // read that SUCCEEDS and then hands back something that cannot be stringified is caught by
    // the same `catch` as ENOENT. Worth pinning because a "tidy" that hoisted the coercion out
    // of the try — `const raw = readFile(...); try { return raw?.toString() ... }` — would keep
    // every other test in this file green and start throwing out of a banner row.
    const cases = [
      ['toString() throws', () => ({ toString: () => { throw new Error('boom') } })],
      ['toString is a getter that throws', () => {
        const value = {}
        Object.defineProperty(value, 'toString', { get() { throw new Error('getter boom') } })
        return value
      }],
      ['toString is not callable', () => ({ toString: 'not a function' })],
      ['a null-prototype object has no toString at all', () => Object.create(null)],
      ['a revoked Proxy throws on every trap', () => {
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()
        return proxy
      }],
    ]
    for (const [label, readFile] of cases) {
      expect(safeReadText(readFile, ANY_PATH), label).toBe('')
    }
  })

  it('is total in its READER argument too — a non-callable readFile costs no throw', () => {
    // The call sites all pass a function, but the reader is an injected seam and the function's
    // one promise is that it never throws. `readFile(...)` on a non-function is a TypeError
    // raised INSIDE the try, so the promise holds for a missing or misspelled injection too.
    for (const notAReader of [undefined, null, 'readFileSync', 42, {}, []]) {
      expect(safeReadText(notAReader, ANY_PATH), String(notAReader)).toBe('')
    }
  })

  it('returns a Symbol as prose — an EXPLICIT `.toString()` is not implicit coercion', () => {
    // A witness for "no behaviour change" against the second-most-likely tidy. A Symbol is the
    // one value where calling `toString` and letting the engine coerce disagree: `sym.toString()`
    // and `String(sym)` both answer 'Symbol(…)', while a template literal or `'' + sym` throws a
    // TypeError. So rewriting this line as `` `${readFile(path, 'utf8') ?? ''}` `` — which looks
    // like the same thing and is shorter — moves a Symbol from an answer into the `catch`, and
    // no other test in the tree would notice. (`String(x ?? '')`, the other obvious rewrite, is
    // equivalent HERE and caught instead by the two clauses below: it turns 0 into '0' and a
    // non-string `toString` result into text.)
    expect(safeReadText(() => Symbol('a symbol'), ANY_PATH)).toBe('Symbol(a symbol)')
  })

  it('stringifies via the value, so a non-string toString passes straight THROUGH', () => {
    // BOUNDARY, NOT A WISH. `value.toString()` is a plain method call — there is no ToString
    // coercion behind it — so a `toString` that returns a number returns a NUMBER from a
    // function whose name and contract both say text. No real reader does this (`readFileSync`
    // gives a string, an encoding-less one gives a Buffer, and both stringify properly), and
    // every downstream consumer is already hardened against a non-string: progress.qa.test.js
    // and progress.launch.qa.test.js both drive `metricsText` with `{}`, `42` and `[]` and
    // demand no throw. So this is recorded as the shape of the seam rather than reported as a
    // defect — but it is recorded, because "answer '' or the text" is what the module comment
    // claims and this is the one input for which that sentence is false.
    expect(safeReadText(() => ({ toString: () => 123 }), ANY_PATH)).toBe(123)
    expect(safeReadText(() => ({ toString: () => ({ nested: true }) }), ANY_PATH)).toEqual({
      nested: true,
    })
  })

  it("collapses every FALSY coercion result to '', string or not", () => {
    // The out-side half of the surprising clause. `|| ''` is falsy-coalescing, so 0, NaN, null
    // and '' all leave as '' even though only one of them is text — which is what makes the
    // reader's fallback uniform, and what a `?? ''` rewrite would break for 0.
    const falsy = [0, -0, NaN, null, undefined, false, '']
    for (const result of falsy) {
      expect(safeReadText(() => ({ toString: () => result }), ANY_PATH), String(result)).toBe('')
    }
    // ...and the truthy non-strings that DO survive, so the boundary has two sides. `0n` is the
    // pair that matters: BigInt zero is truthy and stringifies to '0', where number zero is
    // falsy and stringifies to ''.
    expect(safeReadText(() => 0n, ANY_PATH)).toBe('0')
    expect(safeReadText(() => NaN, ANY_PATH)).toBe('NaN')
  })

  it("hands back '[object Promise]' for an ASYNC reader — the contract is synchronous", () => {
    // A HAZARD, pinned so it is a known one. All three shipped call sites inject
    // `readFileSync`, so this is unreachable today; swap one for `fs.promises.readFile` and the
    // function neither throws nor answers '' — it answers a fifteen-character lie that flows
    // into `aggregateCycleCounts` (zero events, silently) or `resolveBannerRepo` (no row). This
    // assertion is what turns that swap from a silent wrong number into a red test.
    expect(safeReadText(async () => 'the real text', ANY_PATH)).toBe('[object Promise]')
  })

  it('calls the reader exactly once, with the path verbatim and no third argument', () => {
    // Three claims the rename must not have disturbed: no retry (a second read of an
    // append-only file mid-write would be two different answers), the path is passed through
    // untouched rather than resolved or normalized, and 'utf8' is the whole of the options — a
    // third argument would be a behaviour change for any injected fs that inspects arity.
    for (const path of [ANY_PATH, 42, new URL('file:///x/y'), Symbol('p'), null]) {
      const calls = []
      const readFile = (...args) => {
        calls.push(args)
        return 'text'
      }
      expect(safeReadText(readFile, path), String(path)).toBe('text')
      expect(calls.length, String(path)).toBe(1)
      expect(calls[0].length, String(path)).toBe(2)
      expect(calls[0][0], String(path)).toBe(path)
      expect(calls[0][1], String(path)).toBe('utf8')
    }
  })

})

// ---------------------------------------------------------------------------------------------
// The twin.
// ---------------------------------------------------------------------------------------------

/**
 * The `{ … }` of a named function declaration, from its source TEXT.
 *
 * Braces are matched rather than the body regexed out, so the extraction says nothing about
 * formatting and a comparison of two of these is a comparison of code. Throws when the name is
 * gone, because a silent '' from either side would make the identity assertion below pass by
 * finding nothing — which is the failure mode a duplication guard exists to not have.
 */
function bodyOf(path, name) {
  const source = readFileSync(path, 'utf8')
  const declaration = source.indexOf(`function ${name}(`)
  if (declaration === -1) {
    throw new Error(
      `No \`function ${name}\` in ${relative(RALPH_HOME, path)}. If it was renamed or removed, ` +
        'this guard is about the DELIBERATE duplication #117 left in place — update both sides ' +
        'together or delete the guard with the duplication.',
    )
  }
  const open = source.indexOf('{', declaration)
  let depth = 0
  let index = open
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0) break
  }
  return source.slice(open, index + 1)
}

describe('safeReadText and status.js’s safeReadHistory are one function twice (#117 QA)', () => {
  it('has a body byte-identical to safeReadHistory — the duplication is pinned AS duplication', () => {
    // #117 renamed the shared reader and deliberately did NOT fold status.js's private copy
    // into it. That is a defensible call — the two have different callers and different issue
    // numbers behind them — but it is only defensible while they stay the same function: a fix
    // to the never-throws contract applied to one copy is a divergence between two modules that
    // both claim it, and the suites next door would keep passing on whichever copy they happen
    // to drive. Byte-identity is the cheapest possible statement of "these are one thing", and
    // it fails on a one-space edit, which is the point.
    expect(bodyOf(STATUS_MODULE, 'safeReadHistory')).toBe(bodyOf(METRICS_MODULE, 'safeReadText'))
  })

  it('is the same single expression in both, so neither copy drifted before the rename', () => {
    // The identity above would also hold if BOTH copies were rewritten identically. This says
    // what the shared body actually is, which is the line #117 promised not to touch.
    const expression = "return readFile(path, 'utf8')?.toString() || ''"
    expect(bodyOf(METRICS_MODULE, 'safeReadText')).toContain(expression)
    expect(bodyOf(STATUS_MODULE, 'safeReadHistory')).toContain(expression)
  })

  it('leaves status.js importing the renamed reader AND keeping its own copy', () => {
    // The reviewer's decision, made visible: status.js is the one module that does both. If a
    // later change dedupes them, `bodyOf` above throws with the reason attached rather than
    // this assertion failing obscurely.
    const code = codeWithoutComments(STATUS_MODULE)
    expect(code).toMatch(/import \{[^}]*\bsafeReadText\b[^}]*\} from '\.\.\/issue-metrics\.js'/)
    expect(code).toMatch(/function safeReadHistory\(readFile, path\)/)
  })
})

// ---------------------------------------------------------------------------------------------
// Completeness across the tracked tree.
// ---------------------------------------------------------------------------------------------

// The retired spelling, ASSEMBLED. Spelled in full it would be its own first hit and this file
// would need a hole cut for it, and a hole is where the next stale mention hides. It also keeps a
// human's `grep` for the old name honest: the answer has to be "nowhere", not "one test file".
const RETIRED = 'safeRead' + 'Metrics'

// The whole authored tree, at every extension. `trackedFiles()` is #107's primitive and it FAILS
// CLOSED — no git, not a repository, or an empty list all throw rather than reporting a clean
// sweep over nothing — which is exactly the vacuity a rename guard has to avoid.
const TRACKED = trackedFiles().map((path) => relative(RALPH_HOME, path))

// CHANGELOG.md IS OUT OF SCOPE, and it is the only thing that is.
//
// It is release-please's output: a list of the commit subjects that shipped. #117's own subject
// names the old symbol — that is what a rename commit is FOR — so the next release writes the
// retired spelling into that file permanently and correctly. A sweep that forbade it there would
// be a guard that goes red, months later, at a sentence about history that nobody should edit.
// Every other tracked file is present tense and in scope.
const HISTORY_ONLY = ['CHANGELOG.md']

/**
 * The paths under `base` whose TEXT mentions the retired spelling.
 *
 * `base` is a parameter and not a constant for one reason: the witness at the bottom of this
 * block has to prove the detector FIRES, and it cannot do that against a tree the same block
 * asserts is clean. Pointing the identical function at a planted temp file is the only way the
 * proof covers the reading as well as the matching.
 */
const mentionsIn = (paths, base = RALPH_HOME) =>
  paths.filter((path) => readFileSync(join(base, path), 'utf8').includes(RETIRED))

// The witness's planted tree, created once and REMOVED, the pattern every other temp-using spec in
// this suite follows (test/source-control-bytes.qa.test.js). A `mkdtempSync` with no `afterAll` is
// a directory per run left in $TMPDIR forever — invisible, because it is outside the repo and no
// assertion is looking at it.
let TMP_ROOT = ''

beforeAll(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'ralph-qa117-'))
})

afterAll(() => {
  if (TMP_ROOT) rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('the rename reached every tracked file, at every extension (#117 QA)', () => {
  it('leaves the retired spelling in no tracked file outside the release history', () => {
    // The exemption is pinned to a path git REALLY tracks before it is used to narrow anything:
    // a typo in it would quietly exempt nothing while looking like it exempts something, and the
    // sweep below would pass over a tree it never narrowed for a reason nobody could see.
    for (const path of HISTORY_ONLY) expect(TRACKED).toContain(path)
    expect(mentionsIn(TRACKED.filter((path) => !HISTORY_ONLY.includes(path)))).toEqual([])
  })

  it('fires on a planted mention — a clean sweep is not a broken matcher', () => {
    // THE WITNESS. Every assertion above is of the shape "the offender list is empty", which is
    // also exactly what a detector that never matches returns — a mis-assembled needle, a read
    // that silently returned '', a filter with an inverted test. So the same function is aimed
    // at a tree with two planted files and required to name the right one.
    //
    // The offender is a `.md`, deliberately: prose in a non-`.js` file is the surface a walk of
    // the code roots would not reach, so the witness demonstrates the sweep's REACH as well as
    // its matcher. The clean file spells the NEW name, which is the near-miss a
    // `startsWith`-shaped bug would wrongly report.
    writeFileSync(join(TMP_ROOT, 'clean.js'), "import { safeReadText } from './issue-metrics.js'\n")
    writeFileSync(join(TMP_ROOT, 'stale.md'), `The metrics reader is called \`${RETIRED}\`.\n`)
    expect(mentionsIn(['clean.js', 'stale.md'], TMP_ROOT)).toEqual(['stale.md'])

    // And the assembly produced the retired spelling rather than some other string, stated
    // without writing it out: same prefix as the new name, three characters longer.
    expect(RETIRED.startsWith('safeRead')).toBe(true)
    expect(RETIRED).toHaveLength('safeReadText'.length + 3)
    expect(RETIRED).not.toBe('safeReadText')
  })
})

// ---------------------------------------------------------------------------------------------
// Call sites: nobody left pointing at a door that no longer opens.
// ---------------------------------------------------------------------------------------------

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g

/** `[{ specifier, names }]` — every static named-import clause in a chunk of source TEXT. */
function importClauses(source) {
  return [...source.matchAll(IMPORT)].map(([, clause, specifier]) => ({
    specifier,
    names: clause
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0])
      .filter(Boolean),
  }))
}

// SHIPPED code: every tracked `.js` that is not itself a spec. This is the set where a stale
// named import is a link error that nothing necessarily loads — `lib/` is full of modules whose
// only consumer is a command, and `scripts/` holds two entrypoints no suite imports at all — so
// it is read as TEXT rather than imported. Wider than lib/ and bin/ on purpose: scripts/ and
// vitest.config.js are in it, and `scripts/lib/sprite-build.js` really does import out of lib/.
const SHIPPED = TRACKED.filter(
  (path) => path.endsWith('.js') && !path.endsWith('.test.js') && !/^test[/\\]/.test(path),
)

describe('every consumer of the renamed reader points at a door that opens (#117 QA)', () => {
  it('imports only names issue-metrics.js exports, from every shipped module that imports it', () => {
    // The real ESM failure mode, checked without loading anything: a named import of a symbol
    // the module no longer exports is a SyntaxError at link time, and it stays invisible until
    // something imports that file. Reading source finds it in a module no suite ever loads.
    const exported = new Set(Object.keys(issueMetrics))
    const stale = []
    for (const path of SHIPPED) {
      for (const { specifier, names } of importClauses(codeWithoutComments(join(RALPH_HOME, path)))) {
        if (!specifier.endsWith('issue-metrics.js')) continue
        for (const name of names) if (!exported.has(name)) stale.push(`${path} imports ${name}`)
      }
    }
    expect(stale).toEqual([])
  })

  it('pins the shipped call sites — three consumers, four calls, and one declaration', () => {
    // The issue counted four call sites plus the `.git/config` one; this is that count, kept.
    // A fifth is not forbidden, it is a DECISION — add the line here and the reader of this
    // spec learns that the shared reader grew a consumer, which is the fact #117 was opened
    // about in the first place (a second subject is what made the old name wrong).
    const declaration = /export function safeReadText\(readFile, path\)/
    const counts = {}
    for (const path of SHIPPED) {
      const code = codeWithoutComments(join(RALPH_HOME, path)).replace(declaration, '')
      const calls = [...code.matchAll(/\bsafeReadText\s*\(/g)].length
      if (calls) counts[path] = calls
    }
    expect(counts).toEqual({
      'lib/commands/cycle.js': 1,
      'lib/commands/start.js': 2,
      'lib/commands/status.js': 1,
    })
    // ...and the declaration is in exactly one place, which is why removing it above is safe.
    expect(SHIPPED.filter((path) => declaration.test(readFileSync(join(RALPH_HOME, path), 'utf8')))).toEqual([
      'lib/issue-metrics.js',
    ])
  })

  it('has no module that calls the reader without importing it, nor imports it unused', () => {
    // Both halves of a half-finished rename. A call with no import is a ReferenceError at run
    // time (the seam is a bare identifier, so nothing catches it); an import with no call is
    // the leftover of a call site that moved, and it is the line that keeps a dead name alive.
    for (const path of SHIPPED) {
      const code = codeWithoutComments(join(RALPH_HOME, path))
      if (path === 'lib/issue-metrics.js') continue
      const imports = importClauses(code).some(
        ({ specifier, names }) =>
          specifier.endsWith('issue-metrics.js') && names.includes('safeReadText'),
      )
      const calls = /\bsafeReadText\s*\(/.test(code)
      expect(calls, `${path}: calls safeReadText without importing it`).toBe(imports && calls)
      expect(imports, `${path}: imports safeReadText without calling it`).toBe(imports && calls)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The tightened static pin in start.identity-facts.test.js.
// ---------------------------------------------------------------------------------------------
describe('the tightened source pin on start.js still proves its claim (#117 QA)', () => {
  // #117 narrowed the pin from the retired bare name to
  // `/safeReadText\(readFile, metricsPath\(/`, because a bare name no longer says WHICH file is
  // read. Correct — but a source pin that quotes an argument list is only as stable as the line
  // it quotes, so the stability is checked here rather than assumed. (The old spelling is not
  // written out above for the reason `RETIRED` exists: the sweep upstairs reads raw source, and a
  // comment quoting the old name is a hit it would be right to report.)
  const PIN = /safeReadText\(readFile, metricsPath\(/

  it('matches exactly one line of start.js, and that line is the metrics read', () => {
    const lines = codeWithoutComments(START_MODULE).split('\n').filter((line) => PIN.test(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('const metricsText =')
  })

  it('keeps the pinned call short enough that no reflow would wrap it', () => {
    // A regex spanning `name(arg, arg(` cannot match across a line break, so the pin's safety
    // rests on the call staying one line. It is 62 columns at an indentation of two, well inside
    // the widest line this file already carries, and the column budget is what says so. (That the
    // pin matches ONE line at all is the assertion above; this is only that the line has room.)
    const [line] = codeWithoutComments(START_MODULE).split('\n').filter((l) => PIN.test(l))
    expect(line.length).toBeLessThan(100)
  })

  it('leaves the second read of #69 pinned too, not just the metrics one', () => {
    // What the tightening COST: the old bare-name match covered both reads start.js makes
    // through this function. The new one names the metrics log only, so the `.git/config` read
    // that motivated the whole rename is no longer mentioned by any source pin. It is covered
    // behaviourally (start.identity-facts.test.js drives that read throwing, returning a number
    // and returning a Buffer), and this keeps it covered structurally as well — the claim being
    // that start.js reads TWO paths through the shared reader and that is deliberate.
    const code = codeWithoutComments(START_MODULE)
    expect(code).toMatch(/safeReadText\(readFile, resolve\(cwd, '\.git', 'config'\)\)/)
    expect([...code.matchAll(/\bsafeReadText\s*\(/g)]).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------
// #121 QA — the two behavioural deltas the extraction admits to, inside this module.
//
// `aggregateCycleCounts` stopped deciding what a line is (`issueEvents` decides now) and lost the
// `if (!jsonlText) return {…zeros}` guard that used to sit above its loop. Both are argued in the
// module's comments to be unobservable, and both are worth an assertion rather than a paragraph,
// because "unobservable" is the claim a refactor is most often wrong about:
//
//   * THE SHAPE. `ralph cycle` destructures this return and prints from it, so the empty answer
//     has to be the SAME OBJECT SHAPE the loop's zeros produce — five keys, with two arrays
//     present and empty rather than absent. The deleted guard returned that shape as a literal;
//     nothing now asserts the replacement does, and `okIssues.length` on an `undefined` is how
//     that would surface: a crash in the summary at the end of a successful run.
//
//   * THE HOLE IT CLOSED. A truthy non-string used to reach `.split` and throw, against this
//     function's own docblock. That is the delta that is not merely equivalent but better, so it
//     is pinned as a promise the module now keeps rather than left as a side effect of the walk.
// ---------------------------------------------------------------------------------------------
describe('aggregateCycleCounts — the deleted early return and the widened door (#121 QA)', () => {
  const line = (fields) => ISSUE_EVENT_TAG + JSON.stringify(fields)
  const ZEROS = { ok: 0, failed: 0, processed: 0, okIssues: [], failedIssues: [] }

  it('answers every spelling of "no log" with the full five-key shape, arrays included', () => {
    // What the deleted guard used to return as a literal, now demanded of the loop for each
    // input that used to reach that guard — plus the two the guard never caught. `toEqual` on
    // the whole object is deliberate: it fails if a key goes missing, which is exactly the
    // regression a `return {ok, failed, processed}` tidy would introduce.
    for (const nothing of ['', undefined, null, 0, false, NaN, '   ', '\n\n', 'no tag here']) {
      expect(aggregateCycleCounts(nothing, 0), String(nothing)).toEqual(ZEROS)
      expect(aggregateCycleCounts(nothing, Date.now()), String(nothing)).toEqual(ZEROS)
    }
  })

  it('hands each caller its OWN empty arrays, never a shared constant', () => {
    // The hazard a literal-returning early exit could have had and the loop cannot: `ralph
    // cycle` holds these arrays across a run, and two callers sharing one array would make the
    // first one's pushes visible to the second. Asserted by identity, since `toEqual` cannot
    // see it.
    const first = aggregateCycleCounts('', 0)
    const second = aggregateCycleCounts('', 0)
    expect(first.okIssues).not.toBe(second.okIssues)
    expect(first.failedIssues).not.toBe(second.failedIssues)
    first.okIssues.push(999)
    expect(second.okIssues).toEqual([])
  })

  it('answers zeros instead of THROWING for a truthy non-string log', () => {
    // THE HOLE THE DELETED GUARD LEFT. Each of these is truthy, so the old body skipped the
    // early return and called `.split` on it — a TypeError out of a function whose docblock says
    // it never throws, and out of `ralph cycle`'s end-of-run summary. Unreachable through
    // `safeReadText`, which is why it went unnoticed, and reachable from any other caller.
    // Labelled by hand rather than with `String(value)`, because one of the rows below is a bag
    // whose `toString` throws and a describing label would be the thing that raised — which is
    // the same trap the module under test is being held to.
    const notText = {
      'a number': 42,
      'a boolean': true,
      'a bag': {},
      'an array': [],
      'a Buffer': Buffer.from('x'),
      'a function': () => '',
      'a Symbol': Symbol('log'),
      'a bag whose toString throws': {
        toString() {
          throw new Error('a log must never be coerced')
        },
      },
      'a bag whose toString and valueOf are not callable': { toString: 'x', valueOf: 'y' },
    }
    for (const [label, value] of Object.entries(notText)) {
      expect(() => aggregateCycleCounts(value, 0), label).not.toThrow()
      expect(aggregateCycleCounts(value, 0), label).toEqual(ZEROS)
    }
  })

  it('reads a Buffer as NO log, which is the seam #121 left unmatched on purpose', () => {
    // BOUNDARY, NOT A WISH. `parseIssueEvents` in lib/progress.js coerces at its own door and so
    // reads a Buffer as a log; this function refuses one, because the parser it now shares with
    // lib/banner-model.js must never run a `toString` (see the row above for why). So the same
    // bytes are three events to `ralph status` and zero here. No shipped caller can hit it —
    // `lib/commands/cycle.js` reads through `safeReadText`, whose `?.toString()` exists for
    // precisely this — and the keeper is named here so a caller added without it fails a test
    // rather than reporting a clean run as an empty one.
    const log = [line({ ts: 1, verdict: 'pass', issue_number: 29 }), ''].join('\n')
    expect(aggregateCycleCounts(log, 0).processed).toBe(1)
    expect(aggregateCycleCounts(Buffer.from(log), 0)).toEqual(ZEROS)
    const throughTheKeeper = safeReadText(() => Buffer.from(log), ANY_PATH)
    expect(aggregateCycleCounts(throughTheKeeper, 0).processed).toBe(1)
  })

  it('cannot be made to tally a JSON ARRAY, by a sibling line or by its own contents', () => {
    // THE FIRST DELTA, falsified rather than accepted. The new gate rejects arrays where the old
    // one (`!event || typeof event !== 'object'`) admitted them, and the argument that this is
    // unobservable is that an array cannot carry a numeric `ts`. The only writer that could
    // change that is the log itself, and it cannot: `JSON.parse` puts `__proto__` on the value
    // as an own property and never assigns through a prototype, so `Array.prototype` is
    // untouched by anything a line can say. Both gates therefore agree on every row below.
    const attack = [
      line({ __proto__: { ts: 5, verdict: 'pass', issue_number: 9 } }),
      ISSUE_EVENT_TAG + '["ts",5,"verdict","pass"]',
      ISSUE_EVENT_TAG + '[{"ts":5,"verdict":"pass","issue_number":9}]',
      ISSUE_EVENT_TAG + '[]',
      ISSUE_EVENT_TAG + 'null',
      ISSUE_EVENT_TAG + '5',
      ISSUE_EVENT_TAG + '"a string"',
    ].join('\n')
    expect(aggregateCycleCounts(attack, 0)).toEqual(ZEROS)
    expect(Array.prototype.ts).toBe(undefined)
    expect(Object.prototype.ts).toBe(undefined)
    // ...and a real event on the line AFTER all of that is still counted, so the rejections cost
    // the walk nothing.
    const survivor = `${attack}\n${line({ ts: 5, verdict: 'pass', issue_number: 121 })}`
    expect(aggregateCycleCounts(survivor, 0)).toEqual({
      ok: 1,
      failed: 0,
      processed: 1,
      okIssues: [121],
      failedIssues: [],
    })
  })

  it('keeps the conservative verdict rule and the `since` floor across the extraction', () => {
    // The two rules that are this function's own, re-asserted at the seam because the walk now
    // decides what reaches them: anything that is not the string `pass` is a failure (the bash
    // loop's accounting, where an indeterminate issue counts against the run), and an event
    // older than `since` is not this run's. A `verdict` that is a truthy non-string, or missing
    // entirely, is the shape a half-written event has once JSON.parse accepts it.
    const log = [
      line({ ts: 10, verdict: 'pass', issue_number: 1 }),
      line({ ts: 11, verdict: 'fail', issue_number: 2 }),
      line({ ts: 12, verdict: 'unknown', issue_number: 3 }),
      line({ ts: 13, issue_number: 4 }), // no verdict at all
      line({ ts: 14, verdict: true, issue_number: 5 }), // not the string
      line({ ts: 9, verdict: 'pass', issue_number: 6 }), // before `since`
      line({ verdict: 'pass', issue_number: 7 }), // no ts
      line({ ts: 'later', verdict: 'pass', issue_number: 8 }), // ts as text
      line({ ts: 15, verdict: 'pass' }), // no issue number: counted, unnamed
    ].join('\n')
    expect(aggregateCycleCounts(log, 10)).toEqual({
      ok: 2,
      failed: 4,
      processed: 6,
      okIssues: [1],
      failedIssues: [2, 3, 4, 5],
    })
  })
})
