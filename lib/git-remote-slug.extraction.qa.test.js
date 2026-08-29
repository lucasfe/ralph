// #116 QA — the seams of the extraction itself, which no behavioural spec can see.
//
// The move's own claim is that NOTHING CHANGED: the same grammar, the same export name, the
// same answers, in a file of its own. Both suites next door assert the answers, and they would
// go on passing every one of the four ways a split like this actually goes wrong:
//
//   * A HALF LEFT BEHIND. A pattern or a helper the delete missed is dead code in
//     banner-model.js that reads like live grammar, and the module it belongs to now has its
//     own copy. Nothing fails; the next reader edits the wrong one.
//   * A RE-EXPORT SHIM. `export { resolveBannerRepo } from './git-remote-slug.js'` left in
//     banner-model.js would make every existing test pass and the split cosmetic — two modules
//     coupled by an import, which is the coupling #116 was opened to remove.
//   * A CALLER STILL POINTED AT THE OLD DOOR. A static
//     `import { resolveBannerRepo } from './banner-model.js'` is a link error and loud — but
//     only in a module something actually loads, and `lib/` holds plenty whose only consumer is
//     a command no suite imports directly. So the sweep below reads SOURCE rather than loaded
//     modules, and the export set is checked as a set beside it, which is what closes the door
//     on a dynamic reach too. (That clause is quoted on ONE line deliberately, and it must stay
//     that way: it is precisely the phantom edge this file's own sweep would invent about itself
//     if `namedImports` ever went back to reading raw source, so it stands as the witness for
//     the comment-stripping there — as does the second copy of it inside `namedImports`. Rewrap
//     either and the witness stops witnessing, which is why the one-line shape is ASSERTED and
//     not merely asked for: 'sweeps a haystack with the prose taken out' regexes this file raw
//     and stripped and counts both quotes, so a reflow is a red test rather than a guard that
//     quietly went hollow.)
//   * THE TWINS DRIFTING. `bagOf` and `trimmedOr` are duplicated between the two files on
//     purpose (the argument is in git-remote-slug.js's footer). Deliberate duplication is only
//     safe while it stays duplication: a fix applied to one copy and not the other is a
//     divergence in the never-throws contract of two modules that both claim it, and the
//     grammar suite would keep passing on whichever copy it happens to exercise.
//
// So this file reads the two modules as TEXT and drives their two public functions with the
// same bags, and it is deliberately not about urls at all. It is also the only place the
// never-throws claim's one hole is written down — a bag whose ACCESSOR throws — which is
// pinned rather than fixed, with the caller that covers it named.
//
// Nothing here reads a clock, an environment or a network. It does read this repository's own
// source, which is what a structural guard is: the same method as the purity specs next door
// and test/sprite-placeholder-source.qa.test.js's import-closure sweep.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeWithoutComments } from '../test/helpers/source-code.js'
import * as bannerModel from './banner-model.js'
import * as gitRemoteSlug from './git-remote-slug.js'

const LIB = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(LIB, '..')
const MODEL_MODULE = join(LIB, 'banner-model.js')
const SLUG_MODULE = join(LIB, 'git-remote-slug.js')
// This spec's own source, because it is one of the files its sweep reads and the only one whose
// PROSE the sweep could mistake for an edge. See the guard on the haystack below.
const THIS_FILE = fileURLToPath(import.meta.url)

// `import { a, b as c } from './x.js'` — the one import shape either sweep below is about.
//
// HOISTED so that the two readers of it are literally the same matcher. The guard on the haystack
// claims that this pattern finds the quoted clauses upstairs in raw source and finds none of them
// once comments are stripped; a guard running its own private copy of the regex would prove that
// about some other matcher and leave this one unwatched. Sharing a `g` regex is safe here because
// `matchAll` clones the matcher rather than advancing this one's `lastIndex` — the sweep would
// otherwise start each file where the previous one stopped, which is the sort of bug a structural
// guard is supposed to be too boring to have.
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

/**
 * Every `.js` file under lib/, bin/ and test/ — every module that could import either half.
 *
 * test/ IS A ROOT even though nothing under it spells either name today. The bullet above calls
 * the failure "a caller still pointed at the old door", and test/ is full of callers: its suites
 * and helpers import out of lib/ freely (`../lib/paths.js`, `../lib/heartbeat.js`, and so on). A
 * root left out of the sweep is a root where a stale import stays invisible until something
 * loads the file — which is the whole condition this guard exists to remove, so leaving the
 * third one out would have made it a guard over two thirds of the tree. Recursive because all
 * three roots have subdirectories (lib/commands/, test/setup/, test/utils/).
 */
function sourceFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.js')) found.push(path)
    }
  }
  for (const dir of ['lib', 'bin', 'test']) walk(join(ROOT, dir))
  return found
}

/** `[{ from, specifier, target, names }]` — every static named import in the tree. */
function namedImports() {
  // READ WITHOUT PROSE, because the sweep covers the spec files and therefore covers THIS ONE.
  // The bullet list at the top quotes an `import { resolveBannerRepo } from './banner-model.js'`
  // clause in order to name the failure it guards against, and start.splash.qa.test.js quotes a
  // whole import block for the same didactic reason. Read raw, those are phantom edges — and the
  // first of them is an edge accusing THIS FILE of the exact stale import it was written to
  // catch, which is a red test whose message is a lie about its own source. Stripping is
  // therefore not a tidiness: it is what lets the prose above describe a broken import without
  // becoming one. Comments come out with the same helper the purity reads next door use, for the
  // same reason — a structural claim must be neither answerable nor breakable by a sentence.
  //
  // BOTH of those quoted clauses — the third bullet's and this paragraph's own, one line up —
  // are left on ONE line on purpose, so that the stripping is load-bearing rather than
  // theoretical: revert to `readFileSync` and the third bullet immediately fails the assertion
  // below, naming itself. That one-line shape is no longer a convention either. It is asserted,
  // by 'sweeps a haystack with the prose taken out' further down, which reads this file both ways
  // and counts what this pattern finds — because a witness that stops witnessing when somebody
  // reflows a paragraph is a guard with a silent off switch.
  const edges = []
  for (const path of sourceFiles()) {
    for (const { specifier, names } of importClauses(codeWithoutComments(path))) {
      edges.push({
        from: relative(ROOT, path),
        specifier,
        target: specifier.startsWith('.') ? resolve(dirname(path), specifier) : null,
        names,
      })
    }
  }
  return edges
}

describe('QA #116 the extraction — one grammar per module, and no trace of the other', () => {
  it('exports the model half from banner-model.js and the slug half from nowhere else', () => {
    // The namespace rather than a named import, because a named import that has gone missing
    // is a LINK error: the spec would fail to load rather than fail, and a suite that cannot
    // report which claim broke is a suite that gets deleted. Read as a set, so a re-export
    // shim is as visible as a leftover definition.
    expect(Object.keys(bannerModel).sort()).toEqual(['MODEL_PROVENANCE', 'resolveBannerModel'])
    expect(Object.keys(gitRemoteSlug).sort()).toEqual(['resolveBannerRepo'])
    expect('resolveBannerRepo' in bannerModel).toBe(false)
  })

  it('left no half of the grammar behind, and took no half of the model with it', () => {
    // Comment-stripped on purpose: both headers TALK about the other module by name, and a
    // guard a paragraph can answer is a guard that goes red on a prose edit. Same reason
    // test/helpers/source-code.js exists.
    const model = codeWithoutComments(MODEL_MODULE)
    const slug = codeWithoutComments(SLUG_MODULE)
    const named = (code, name) => new RegExp(`\\b${name}\\b`).test(code)

    // Every identifier the move took out of banner-model.js. One of them still there is dead
    // code that reads like the live grammar it is a stale copy of.
    for (const name of [
      'resolveBannerRepo',
      'configuredSlug',
      'HOST_AND_SLUG',
      'originUrl',
      'SECTION_LINE',
      'KEY_LINE',
      'remoteSlug',
      'SCHEME_URL',
      'SCP_URL',
      'REMOTE_SCHEMES',
      'pathSlug',
      'TRAILING_SLASHES',
      'DOT_GIT',
      'SLUG_SEGMENT',
      'ghRepo',
      'gitConfigText',
    ]) {
      expect(named(model, name), name).toBe(false)
      expect(named(slug, name), name).toBe(true)
    }

    // ...and the same sweep the other way. The slug module must not have acquired a share of
    // the model's evidence-weighing on the way out — that is the coupling being removed, and
    // its `import`-free purity spec would not notice a copied constant.
    for (const name of [
      'resolveBannerModel',
      'MODEL_PROVENANCE',
      'resolveContextWindow',
      'positiveNumberOr',
      'newestIssueEvent',
      'metricsText',
    ]) {
      expect(named(slug, name), name).toBe(false)
      expect(named(model, name), name).toBe(true)
    }

    // TWO OF THOSE NAMES HAVE SINCE MOVED ON, and this row is why they are still swept. #116
    // took the slug grammar out of banner-model.js; #121 then took the metrics log's line
    // grammar out of it too — `ISSUE_EVENT_TAG` and the reverse walk that was `newestEvent` are
    // lib/issue-event-lines.js's now, shared with the cycle aggregator and the status view that
    // used to keep their own copies. So the assertion about the slug module is UNCHANGED (it
    // must know nothing about the log's lines either), while the positive half moves to the
    // module that owns them — which is what keeps this sweep a statement about where code lives
    // rather than a list of names that once passed.
    const lines = codeWithoutComments(join(LIB, 'issue-event-lines.js'))
    expect(named(slug, 'ISSUE_EVENT_TAG')).toBe(false)
    expect(named(model, 'ISSUE_EVENT_TAG')).toBe(false)
    expect(named(lines, 'ISSUE_EVENT_TAG')).toBe(true)
    // `newestEvent` was the local walk's name and the move renamed it, so that exact identifier
    // surviving in ANY of the three is the "half left behind" this whole describe is about.
    for (const [label, code] of [
      ['banner-model.js', model],
      ['git-remote-slug.js', slug],
      ['issue-event-lines.js', lines],
    ]) {
      expect(named(code, 'newestEvent'), label).toBe(false)
    }
  })

  it('points every caller at the module the answer now lives in', () => {
    // THE SWEEP IS OVER SOURCE, NOT OVER LOADED MODULES, which is the whole point: a stale
    // named import breaks loudly only in a file some suite imports, and `lib/` holds modules
    // whose every consumer is a command nobody unit-tests directly.
    const edges = namedImports()
    const modelImports = edges.filter((edge) => edge.target === MODEL_MODULE)
    const slugImports = edges.filter((edge) => edge.target === SLUG_MODULE)

    // Non-vacuity first. An enumeration that found nothing would pass every assertion below.
    expect(sourceFiles().length).toBeGreaterThan(40)
    expect(modelImports.length).toBeGreaterThanOrEqual(3)
    expect(slugImports.length).toBeGreaterThanOrEqual(3)

    // Nobody asks banner-model.js for a name it does not have — the slug half above all.
    for (const edge of modelImports) {
      for (const name of edge.names) {
        expect(Object.keys(bannerModel), `${edge.from} → ${name}`).toContain(name)
      }
    }
    for (const edge of slugImports) {
      for (const name of edge.names) {
        expect(Object.keys(gitRemoteSlug), `${edge.from} → ${name}`).toContain(name)
      }
    }

    // The production edge that makes the sweep worth running: `ralph start` is the one command
    // that draws this row, and it reaches the grammar directly rather than through the module
    // it used to live in. (What the row RENDERS is asserted end to end in
    // lib/commands/start.identity-facts.test.js; this is only that the wire goes there.)
    expect(
      slugImports.some(
        (edge) => edge.from === 'lib/commands/start.js' && edge.names.includes('resolveBannerRepo'),
      ),
    ).toBe(true)

    // And the two modules do not know about each other, in either direction. A shim or a
    // constant borrowed later would show up as an edge here. banner-model.js's imports are
    // both borrowed from the TELEMETRY side rather than from the grammar — `resolveContextWindow`
    // out of lib/issue-event.js (the same function that resolves a window when an event is
    // written) and, since #121, the log's line walk out of lib/issue-event-lines.js (the same
    // walk the cycle aggregator and the status view read those lines with). Neither is a shared
    // "utils" file standing between the two grammars, which is the coupling #116 removed and the
    // thing this row is watching for; both are the one-owner rule applied. The grammar keeps its
    // zero (asserted as zero by the purity spec in git-remote-slug.test.js, which is the
    // stronger claim of the two).
    const outOf = (file) => edges.filter((edge) => edge.from === file).map((edge) => edge.specifier)
    expect(outOf('lib/banner-model.js').sort()).toEqual([
      './issue-event-lines.js',
      './issue-event.js',
    ])
    expect(outOf('lib/git-remote-slug.js')).toEqual([])
  })

  it('sweeps a haystack with the prose taken out, and fails loudly when it stops', () => {
    // THE WITNESS, ASSERTED RATHER THAN CONVENED. Twice in this file a comment quotes a stale
    // `resolveBannerRepo` edge into banner-model.js — once in the third bullet of the header,
    // once in the paragraph inside `namedImports` — because naming the failure is how the prose
    // explains what the sweep is for. Read raw, each quote is a phantom edge accusing THIS FILE
    // of exactly the stale import it was written to catch, so the sweep's honesty rests on two
    // things at once: `codeWithoutComments`, and both quotes staying on ONE line, since a reflow
    // puts a `//` in the middle of the pattern and the quote stops matching.
    //
    // The second of those was the silent half. A witness that has quietly stopped witnessing
    // looks exactly like a witness — the sweep goes on passing either way — so the cost of a
    // reflow was deferred to whoever next swapped the stripping for a raw read and had to read a
    // red test whose message was a lie about its own source. This row converts that silence into
    // noise: it counts what the sweep's own matcher finds in this file both ways, so a reflow
    // fails HERE, by name, with the fix in the message. The clauses are quoted rather than
    // hoisted into a `const` on purpose — `codeWithoutComments` strips comments, not string
    // literals, so a promoted clause would be a permanent REAL phantom edge and would break the
    // sweep it is meant to protect.
    const stale = (source) =>
      importClauses(source).filter(
        (clause) =>
          clause.specifier === './banner-model.js' && clause.names.includes('resolveBannerRepo'),
      ).length

    expect(
      stale(readFileSync(THIS_FILE, 'utf8')),
      'both quoted stale-import clauses in this file — the third header bullet, and the ' +
        'paragraph inside namedImports — must stay on ONE line each. A rewrapped quote no ' +
        'longer matches the sweep pattern, so it no longer witnesses that the sweep strips ' +
        'comments: put it back on one line, or move the witness and update this count.',
    ).toBe(2)
    expect(
      stale(codeWithoutComments(THIS_FILE)),
      'the sweep must see NEITHER quoted clause once comments are stripped. Anything but zero ' +
        'here means namedImports is one prose edit away from reporting a stale import that ' +
        'exists only in a sentence — check that the clause was quoted in a comment and not ' +
        'promoted to a string literal, which stripping does not touch.',
    ).toBe(0)
  })
})

describe('QA #116 the duplicated helpers — twins, or a silent divergence', () => {
  const HELPERS = ['bagOf', 'trimmedOr']

  /** The two helpers' CODE, one entry each, prose and formatting normalized away. */
  const helpersOf = (path) => {
    const code = codeWithoutComments(path)
    const found = {}
    for (const name of HELPERS) {
      const copies = [...code.matchAll(new RegExp(`^function ${name}\\([\\s\\S]*?^}$`, 'gm'))]
      // Exactly one copy per file, or the comparison below is comparing whichever came first.
      expect(copies, `${path} ${name}`).toHaveLength(1)
      found[name] = copies[0][0].replace(/\s+/g, ' ').trim()
    }
    return found
  }

  it('keeps the two copies identical as code, whatever their comments say', () => {
    const model = helpersOf(MODEL_MODULE)
    const slug = helpersOf(SLUG_MODULE)
    // Anchored before it is compared: two empty strings are also identical, and the regex
    // above is the kind of thing that stops matching after a formatting change.
    for (const name of HELPERS) {
      expect(model[name], name).toContain('typeof')
      expect(model[name].length, name).toBeGreaterThan(40)
    }
    expect(slug).toEqual(model)
    // The PROSE above each copy is deliberately different — one explains a trimmed
    // RALPH_CODEX_MODEL, the other a GH_REPO with a newline on it — so a guard over the raw
    // text would be a guard nobody could keep. That difference is asserted rather than
    // assumed, so this test cannot quietly become a whole-file comparison.
    const trimmedOrProse = (path) =>
      readFileSync(path, 'utf8').split('function trimmedOr')[0].split('\n').slice(-6).join('\n')
    expect(trimmedOrProse(MODEL_MODULE)).not.toBe(trimmedOrProse(SLUG_MODULE))
  })

  // The same helpers driven through both public surfaces, on the bags the two modules share.
  // This is the half a text comparison cannot give: two copies could stay byte-identical while
  // a CALLER of one of them started coercing, and both files claim the same contract.
  const NOTHING = {
    agent: null,
    model: null,
    contextWindow: null,
    provenance: bannerModel.MODEL_PROVENANCE.UNKNOWN,
  }

  it('reads a bag that is not a bag the same way on both sides', () => {
    // Labelled by hand rather than with `String(bag)`: one of these bags has no prototype and
    // therefore no `toString`, so labelling it would throw the very error the row is here to
    // prove neither module can be made to throw.
    const BAGS = [
      ['no argument at all', undefined],
      ['null', null],
      ['a number', 42],
      ['a string', 'text'],
      ['a boolean', true],
      ['an empty array', []],
      ['a null-prototype object', Object.create(null)],
      ['a Date', new Date()],
    ]
    for (const [label, bag] of BAGS) {
      expect(gitRemoteSlug.resolveBannerRepo(bag), label).toBe(null)
      expect(bannerModel.resolveBannerModel(bag), label).toEqual(NOTHING)
    }
  })

  it('trims, refuses blanks and refuses non-strings the same way on both sides', () => {
    // TRIMMED: a value that came out of a shell file with a trailing space, or out of a `read`
    // that forgot to chomp its newline, is the value without them. Both headers promise this
    // and each promises it about its own variable.
    expect(gitRemoteSlug.resolveBannerRepo({ ghRepo: ` o/n \n` })).toBe('o/n')
    expect(
      bannerModel.resolveBannerModel({ agent: 'codex', configuredModel: ` gpt-5-codex \n` }).model,
    ).toBe('gpt-5-codex')

    // BLANK IS NOT SET, which is how an exported-but-empty variable reads to the tools that
    // consume it — so the fallback wins rather than an empty row being drawn.
    for (const blank of ['', '   ', '\t\n']) {
      expect(gitRemoteSlug.resolveBannerRepo({ ghRepo: blank }), JSON.stringify(blank)).toBe(null)
      const answer = bannerModel.resolveBannerModel({ agent: 'codex', configuredModel: blank })
      expect(answer.model, JSON.stringify(blank)).toBe(null)
      expect(answer.provenance, JSON.stringify(blank)).toBe(
        bannerModel.MODEL_PROVENANCE.UNKNOWN,
      )
    }

    // REFUSED, NOT COERCED, on both sides and for the same stated reason: `String(value)` on a
    // bag out of an ambient environment runs code somebody else wrote. The object below throws
    // from its `toString`, so a coercion added to either copy is a red test here.
    const hostile = {
      toString() {
        throw new Error('a fact must never be coerced')
      },
    }
    for (const value of [42, true, hostile, ['o/n']]) {
      expect(gitRemoteSlug.resolveBannerRepo({ ghRepo: value }), String(value === hostile)).toBe(
        null,
      )
      expect(bannerModel.resolveBannerModel({ agent: 'codex', configuredModel: value }).model).toBe(
        null,
      )
    }
  })

  it('agrees on the one input neither module defends against: a bag with an accessor', () => {
    // THE HOLE IN "NEVER THROWS", PINNED RATHER THAN BLESSED. `bagOf` type-checks the bag and
    // then plain destructuring reads the fields, so every VALUE is refused rather than
    // coerced — but a field that is a GETTER runs before either module sees anything, and its
    // throw is nobody's to catch here. Both copies behave identically, which is the property
    // this file is about; neither is safer than the other, and a fix must land in both.
    //
    // WHY IT IS NOT A LAUNCH RISK, and why it is not this module's to fix: no caller in this
    // repo builds a bag with an accessor in it. `ralph start` reads `processEnv?.GH_REPO` and
    // the metrics text into a literal object inside `bannerRepoSlug`'s own `try` — the test
    // for that is in lib/commands/start.identity-facts.qa.test.js, and it is the reason the
    // row degrades to nothing even here.
    const exploding = (field) => ({
      get [field]() {
        throw new Error('the accessor ran')
      },
    })
    for (const field of ['ghRepo', 'gitConfigText']) {
      expect(() => gitRemoteSlug.resolveBannerRepo(exploding(field)), field).toThrow(
        'the accessor ran',
      )
    }
    for (const field of ['agent', 'metricsText', 'configuredModel', 'configuredWindow']) {
      expect(() => bannerModel.resolveBannerModel(exploding(field)), field).toThrow(
        'the accessor ran',
      )
    }
  })

  it('reads an inherited fact on both sides, and none at all from a null prototype', () => {
    // Plain destructuring cannot tell an own property from an inherited one, so a polluted
    // `Object.prototype` supplies both facts — in both copies, identically. Pinned for the
    // same reason as the accessor above: it is the behaviour of the SHARED code, so a
    // `Object.hasOwn` hardening that landed in one file and not the other would be a
    // divergence in a contract two modules both advertise. A polluted prototype is a
    // process-wide defect rather than a banner one, and `Object.create(null)` — the shape a
    // caller that parsed a document hands over — inherits nothing either way.
    //
    // Non-enumerable, so nothing else running in this worker sees a new key in a `for...in`,
    // and removed in a `finally` so a failed assertion cannot leak it into the next test.
    const planted = { ghRepo: 'evil/repo', agent: 'codex', configuredModel: 'evil-model' }
    try {
      for (const [key, value] of Object.entries(planted)) {
        Object.defineProperty(Object.prototype, key, { value, configurable: true })
      }
      expect(gitRemoteSlug.resolveBannerRepo({})).toBe('evil/repo')
      expect(bannerModel.resolveBannerModel({}).model).toBe('evil-model')
      expect(gitRemoteSlug.resolveBannerRepo(Object.create(null))).toBe(null)
      expect(bannerModel.resolveBannerModel(Object.create(null))).toEqual(NOTHING)
    } finally {
      for (const key of Object.keys(planted)) delete Object.prototype[key]
    }
  })
})
