import { describe, it, expect } from 'vitest'
import { resolveSource, VALID_SOURCES, DEFAULT_SOURCE } from './task-source.js'

// QA augmentation for #565. The dev's task-source.test.js locks the core
// normalization. These tests attack the "a typo must never abort a run" contract
// with the adversarial inputs a hand-edited ralph.config.sh / stray env var can
// actually produce. The invariant: resolveSource ALWAYS returns a member of
// VALID_SOURCES, defaulting to 'github', and never throws.

describe('resolveSource — adversarial values always resolve safely (#565 QA)', () => {
  it('mixed-case and padded folder values normalize to folder', () => {
    expect(resolveSource({ TASK_SOURCE: 'Folder' })).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: 'FoLdEr' })).toBe('folder')
    expect(resolveSource({ TASK_SOURCE: '\tfolder\n' })).toBe('folder')
  })

  it('near-miss / typo values fall back to github (never abort)', () => {
    for (const v of ['git', 'gitlab', 'folders', 'fold', 'local', 'gh', 'file']) {
      expect(resolveSource({ TASK_SOURCE: v })).toBe('github')
    }
  })

  it('non-string TASK_SOURCE values fall back to github without throwing', () => {
    expect(resolveSource({ TASK_SOURCE: 123 })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: true })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: null })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: {} })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: [] })).toBe('github')
  })

  it('a nullish env object resolves to github', () => {
    expect(resolveSource(null)).toBe('github')
    expect(resolveSource(undefined)).toBe('github')
  })

  it('the result is ALWAYS a valid source for arbitrary garbage', () => {
    const garbage = ['', '   ', 'GITHUB', 'GitHub', 'x'.repeat(500), '\0', '../folder']
    for (const g of garbage) {
      expect(['github', 'folder']).toContain(resolveSource({ TASK_SOURCE: g }))
    }
  })
})

// ---------------------------------------------------------------------------
// QA augmentation for #125 — `jira` as the THIRD namable source.
//
// The whole slice hangs off this function: `TASK_SOURCE=jira` has to stop being a
// typo before lib/deps.js can gate `acli` on it and before `ralph doctor` can be
// asked what a Jira run needs. The dev's task-source.test.js locks the four
// well-formed spellings ('jira', 'JIRA', '  Jira  ', tab/newline padded); these
// attack the boundary a HAND-EDITED ralph.config.sh or a stray `export` can
// actually produce, and restate #565's two invariants where the new name could
// have broken them:
//
//   1. The answer is ALWAYS a member of VALID_SOURCES, and a near-miss is ALWAYS
//      github — adding a name must not make its neighbours resolvable.
//   2. Nothing about the new name moved DEFAULT_SOURCE or the fallback.
//
// Whitespace and invisible bytes are built from their code points, never typed
// (#107) — a literal NBSP in a source file is a byte the next reader cannot see.
// ---------------------------------------------------------------------------

const NBSP = String.fromCharCode(0x00a0)
const BOM = String.fromCharCode(0xfeff)
const ZWSP = String.fromCharCode(0x200b)
const VT = String.fromCharCode(0x000b)
const FF = String.fromCharCode(0x000c)
const CR = String.fromCharCode(0x000d)
const NUL = String.fromCharCode(0x0000)

describe('resolveSource — jira, and the shapes a config file can hand it (#125 QA)', () => {
  it('trims every character String.prototype.trim calls whitespace, NBSP and BOM included', () => {
    // `export TASK_SOURCE="jira "` out of a shell, and a value pasted out of a
    // wiki page that carried a non-breaking space or a BOM with it. All of these
    // are in trim()'s WhiteSpace production, so all of them are still jira.
    for (const raw of [
      `jira${NBSP}`,
      `${NBSP}jira`,
      `${NBSP}${NBSP}JIRA${NBSP}`,
      `jira${BOM}`,
      `${BOM}Jira`,
      `${VT}${FF}jira${CR}`,
      `${CR}\n\tjIrA \n`,
    ]) {
      expect(resolveSource({ TASK_SOURCE: raw })).toBe('jira')
    }
  })

  it('does NOT trim a zero-width space or a NUL — those fall back to github', () => {
    // The other half of the same rule, and the one worth pinning: ZWSP and NUL are
    // not whitespace to trim(), so a value carrying either is a value nobody can
    // see and the resolver must not guess at. github, never a crash.
    expect(resolveSource({ TASK_SOURCE: `jira${ZWSP}` })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: `jira${NUL}` })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: `${NUL}jira` })).toBe('github')
  })

  it('a jira value with anything ATTACHED to it is a typo, not a source', () => {
    // Two-value and path-flavoured guesses a user might make about a config knob
    // that takes one word. Every one of them is github — the resolver matches a
    // whole normalized string, never a prefix or a member of a list.
    for (const raw of [
      'jira/',
      '/jira',
      'jira,folder',
      'jira folder',
      'jira:PROJ',
      'jira-cloud',
      'jira_server',
      'jira=1',
      '"jira"',
      "'jira'",
      'jira#comment',
    ]) {
      expect(resolveSource({ TASK_SOURCE: raw }), raw).toBe('github')
    }
  })

  it('near-misses on the new name, and the tool it implies, all fall back to github', () => {
    for (const raw of ['jiras', 'jra', 'jirra', 'jia', 'jjira', 'atlassian', 'acli', 'issue']) {
      expect(resolveSource({ TASK_SOURCE: raw }), raw).toBe('github')
    }
  })

  it('normalization is ASCII toLowerCase, not a Unicode case fold', () => {
    // Pinned so nobody later assumes locale folding: a Turkish dotted capital I
    // and the fullwidth forms do NOT become 'jira'. They are typos, and a typo
    // resolves to github rather than aborting a run.
    expect(resolveSource({ TASK_SOURCE: 'jİra' })).toBe('github')
    expect(resolveSource({ TASK_SOURCE: 'ＪＩＲＡ' })).toBe('github')
  })

  it('property names off Object.prototype are not sources', () => {
    // `VALID_SOURCES.includes(x)` is an array search rather than a property
    // lookup, so none of these can match — but a future refactor to a lookup
    // object or a Set-of-keys would silently make them match, and 'constructor'
    // resolving to a source is the kind of thing nobody notices until it is a
    // shell variable somewhere. Cheap to pin, so pinned.
    for (const raw of [
      'constructor',
      'toString',
      'valueOf',
      '__proto__',
      'hasOwnProperty',
      'prototype',
      'length',
      '0',
      '2',
    ]) {
      expect(resolveSource({ TASK_SOURCE: raw }), raw).toBe('github')
    }
  })

  it('never throws for any non-string value, Symbols and functions included', () => {
    // The env bag is an injected seam everywhere in this package (#41), so
    // TASK_SOURCE is not guaranteed to be a string the way `process.env` would
    // make it. A Symbol is the interesting one: `String(sym)` is legal where a
    // template literal would throw, which is exactly what this resolver does.
    const hostile = [
      123,
      0,
      -1,
      NaN,
      Infinity,
      true,
      false,
      null,
      undefined,
      {},
      [],
      () => 'jira',
      Symbol('jira'),
      Symbol.iterator,
      new Date(),
      /jira/,
      123n,
    ]
    for (const TASK_SOURCE of hostile) {
      let got
      expect(() => {
        got = resolveSource({ TASK_SOURCE })
      }, String(typeof TASK_SOURCE)).not.toThrow()
      expect(VALID_SOURCES).toContain(got)
    }
  })

  it('documents the coercion quirk: anything whose STRING form is a source resolves', () => {
    // Pre-existing #565 behaviour, restated for the new name so nobody reads it as
    // jira-specific. `String(raw)` is what normalizes, so a one-element array, a
    // boxed String and a toString() shim all spell 'jira'. Harmless — every one of
    // them lands on a member of VALID_SOURCES — but it is the answer, so it is
    // written down rather than left for someone to discover.
    expect(resolveSource({ TASK_SOURCE: ['jira'] })).toBe('jira')
    // eslint-disable-next-line no-new-wrappers
    expect(resolveSource({ TASK_SOURCE: new String('JIRA') })).toBe('jira')
    expect(resolveSource({ TASK_SOURCE: { toString: () => ' jira ' } })).toBe('jira')
    // ...and a two-element array is a comma-joined string, i.e. a typo.
    expect(resolveSource({ TASK_SOURCE: ['jira', 'folder'] })).toBe('github')
  })

  it('documents the pre-existing gap: a value that THROWS on read is not caught here', () => {
    // Recorded rather than fixed, and NOT introduced by #125 — resolveSource has
    // read the bag unguarded since #565, and doctor.version-line.qa.test.js pins
    // the same hole one layer up ("fails in the agent resolver, not in the #27
    // cache read"). A future hardening pass should know the third source did not
    // make this worse: the coercion is the same coercion for all three names.
    expect(() =>
      resolveSource({
        TASK_SOURCE: {
          toString() {
            throw new Error('hostile toString')
          },
        },
      }),
    ).toThrow('hostile toString')
    expect(() =>
      resolveSource({
        get TASK_SOURCE() {
          throw new Error('hostile getter')
        },
      }),
    ).toThrow('hostile getter')
  })
})

describe('the task-source registry itself (#125 QA)', () => {
  it('lists exactly three sources, in order, github first', () => {
    // The ORDER is user-visible: `ralph init` renders this array into the
    // rejection sentence ("Valid sources: github, folder, jira."), so a reshuffle
    // is a change to a string users read.
    expect(VALID_SOURCES).toEqual(['github', 'folder', 'jira'])
    expect(VALID_SOURCES.join(', ')).toBe('github, folder, jira')
  })

  it('DEFAULT_SOURCE is github and is itself a member', () => {
    expect(DEFAULT_SOURCE).toBe('github')
    expect(VALID_SOURCES).toContain(DEFAULT_SOURCE)
  })

  it('every member round-trips through resolveSource, in any case and with padding', () => {
    // The registry and the resolver cannot drift: a name in the list that the
    // resolver refuses would be a name `ralph init` accepts and the runtime
    // ignores, which is the worst of both.
    for (const source of VALID_SOURCES) {
      expect(resolveSource({ TASK_SOURCE: source })).toBe(source)
      expect(resolveSource({ TASK_SOURCE: source.toUpperCase() })).toBe(source)
      expect(resolveSource({ TASK_SOURCE: `  ${source}\n` })).toBe(source)
    }
  })

  it('the exported list is MUTABLE shared state — pre-existing, and it decides the answer', () => {
    // Not a #125 defect: VALID_SOURCES has been an unfrozen exported array since
    // #565, and resolveSource reads THAT array rather than a copy, so any importer
    // can push a fourth name and change what every later call accepts
    // process-wide. Pinned as the observation it is (with the mutation undone in a
    // finally, so this test cannot leak into a neighbour) because #125 is the
    // slice that made "how do you add a source" a question people will ask.
    expect(Object.isFrozen(VALID_SOURCES)).toBe(false)
    expect(resolveSource({ TASK_SOURCE: 'gitlab' })).toBe('github')
    try {
      VALID_SOURCES.push('gitlab')
      expect(resolveSource({ TASK_SOURCE: 'GitLab' })).toBe('gitlab')
    } finally {
      VALID_SOURCES.pop()
    }
    expect(VALID_SOURCES).toEqual(['github', 'folder', 'jira'])
    expect(resolveSource({ TASK_SOURCE: 'gitlab' })).toBe('github')
  })
})
