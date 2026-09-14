import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { INSTALL_MARKERS, VERSION_CHANNEL, versionChannelFor } from './install-markers.js'
import { classifyInstall } from './install-target.js'
import { codeWithoutComments, functionBody } from '../test/helpers/source-code.js'

// QA #215 — `versionChannelFor`, the READER's half of the channel rule.
//
// One function decides which channel `ralph doctor` and `ralph start`'s banner may read a
// cached version as, from the install path alone. It is the only input to that decision, it
// touches no filesystem, and it always answers a channel — so every way it can answer WRONG is
// a way a user is shown (or denied) a version:
//
//   * answering `brew` for a path that is not a Homebrew install of THIS formula would put the
//     tap's number in front of an npm user, which is the issue;
//   * answering `npm` for a real Cellar install would put the registry's number in front of a
//     Homebrew user, which is the issue's mirror;
//   * and answering something DIFFERENT from what the same path's classification files its
//     answer under would make a copy write under one id and read under another — a copy that
//     can never see its own cached version, forever.
//
// The dev's lib/update-check.cache-channel.test.js pins the two happy paths plus a hostile
// `ralphHome` table. This file takes the PATH MATCHING apart: prefix independence, case, the
// formula-name half of the marker pair, adjacency, `..` traversal, separator confusion,
// ambiguity — and then joins the reader's answer to the writer's over the same paths, which is
// the invariant no single-sided test can state.
//
// Pure and hermetic by construction: this function reads no fs, so the only case that needs
// one is the join, where `classifyInstall`'s link probes get memfs.

const FORMULA_PATH = (prefix) =>
  `${prefix}/Cellar/ralph/0.26.0/libexec/lib/node_modules/@lucasfe/ralph`

const NPM = VERSION_CHANNEL.NPM
const BREW = VERSION_CHANNEL.BREW

// Every row is a path plus the channel a copy installed there may READ. Written as one table
// because the risk in a marker matcher is a WIDENING — a case-insensitive compare, a bare
// `Cellar`, a `includes` where a segment match was meant — and a widening moves one row.
const PATHS = [
  // The three brew prefixes, none of them named by the marker: Apple silicon, Intel, and
  // Linuxbrew. A marker that named a prefix would answer npm for two real Homebrew installs.
  ['Apple silicon Cellar', FORMULA_PATH('/opt/homebrew'), BREW],
  ['Intel Cellar', FORMULA_PATH('/usr/local'), BREW],
  ['Linuxbrew Cellar', FORMULA_PATH('/home/linuxbrew/.linuxbrew'), BREW],
  // A legacy Cellar outside its own prefix, which brew.sh's HOMEBREW_CELLAR derivation allows.
  ['a Cellar outside the prefix', FORMULA_PATH('/opt/homebrew-repo'), BREW],
  // CASE. `Cellar` is Homebrew's spelling; a lowercase directory of that name is somebody
  // else's, and reading it as brew would compare an npm install against the tap.
  ['a lowercase cellar', '/opt/homebrew/cellar/ralph/0.26.0/libexec', NPM],
  ['an upper CELLAR', '/opt/homebrew/CELLAR/ralph/0.26.0/libexec', NPM],
  // WHOLE SEGMENTS, not substrings.
  ['CellarX', '/opt/homebrew/CellarX/ralph/0.26.0/libexec', NPM],
  ['MyCellar', '/opt/MyCellar/ralph/0.26.0/libexec', NPM],
  // THE FORMULA NAME IS HALF THE MARKER. Another formula's tree that happens to contain a
  // copy of Ralph is not a `ralph` formula install, and its versions are not ours.
  ['another formula’s Cellar', '/opt/homebrew/Cellar/jq/1.8.2/libexec/ralph', NPM],
  ['a similarly named formula', '/opt/homebrew/Cellar/ralph-dev/0.1.0/libexec', NPM],
  ['a formula prefixed with ours', '/opt/homebrew/Cellar/ralphx/0.1.0/libexec', NPM],
  // ADJACENCY. The pair must be adjacent segments; `Cellar/opt/ralph` is neither.
  ['a non-adjacent pair', '/opt/homebrew/Cellar/opt/ralph/0.1.0', NPM],
  ['the pair reversed', '/opt/homebrew/ralph/Cellar/0.1.0', NPM],
  // TRAVERSAL, both ways — the path is resolved before it is matched, so `..` can leave a
  // Cellar (npm) or arrive in one (brew). Either answer is defensible; what matters is that it
  // describes where the path RESOLVES rather than what it spells.
  ['`..` leaving a Cellar', '/opt/homebrew/Cellar/ralph/../../elsewhere', NPM],
  ['`..` arriving in a Cellar', '/opt/x/../homebrew/Cellar/ralph/0.1.0/libexec', BREW],
  // SEPARATORS. A Windows-style path has no POSIX segments to match on this platform, so it
  // reads as npm rather than as a Cellar — pinned so nobody "fixes" it into a split on both.
  ['a Windows-separator path', 'C:\\brew\\Cellar\\ralph\\0.26.0\\libexec', NPM],
  // NOISE that must not change the answer: trailing separators, padding, a doubled slash.
  ['trailing separators', `${FORMULA_PATH('/opt/homebrew')}///`, BREW],
  ['surrounding whitespace', `   ${FORMULA_PATH('/opt/homebrew')}   `, BREW],
  ['a doubled separator', '/opt/homebrew//Cellar//ralph//0.26.0', BREW],
  // The layouts that are not brew at all.
  ['an npm global root', '/usr/local/lib/node_modules/@lucasfe/ralph', NPM],
  ['a pnpm global store', '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph', NPM],
  ['an npx cache', '/Users/me/.npm/_npx/1a2b/node_modules/@lucasfe/ralph', NPM],
  ['a dev checkout', '/Users/me/repos/ralph', NPM],
  ['the filesystem root', '/', NPM],
  ['a blank path', '', NPM],
]

describe('QA #215 which channel an install PATH may read', () => {
  for (const [label, ralphHome, expected] of PATHS) {
    it(`reads ${label} as ${expected}`, () => {
      expect(versionChannelFor({ ralphHome })).toBe(expected)
    })
  }

  it('fails closed to npm when a path matches two managers at once', () => {
    // An ambiguous layout has no single channel, and npm is the fallback every non-brew
    // layout already has. It also agrees with `classifyInstall`, which refuses to guess at a
    // command for the same path — so the version reported and the command offered stay on one
    // channel even here.
    const ambiguous =
      '/opt/homebrew/Cellar/ralph/0.26.0/libexec/pnpm/global/5/node_modules/@lucasfe/ralph'
    expect(versionChannelFor({ ralphHome: ambiguous })).toBe(NPM)
  })

  it('answers npm for every non-string ralphHome rather than throwing', () => {
    // The value arrives from a caller (bin/ralph.js passes RALPH_HOME; `ralph start` defaults
    // it), and both call sites spell `versionChannelFor({ ralphHome })` in an ARGUMENT
    // position — outside the try/catch that guards the cache read itself. A throw here would
    // therefore cost the run rather than the row, which is why "always answers" matters as
    // much as "answers correctly".
    for (const ralphHome of [undefined, null, 42, {}, [], () => {}, Symbol('brew'), true, 0]) {
      expect(versionChannelFor({ ralphHome }), String(ralphHome?.toString?.() ?? ralphHome))
        .toBe(NPM)
    }
    expect(versionChannelFor({})).toBe(NPM)
    expect(versionChannelFor()).toBe(NPM)
  })

  it('needs a BAG, and that boundary is the caller’s to keep', () => {
    // Pinned rather than papered over: the destructure has a default for an ABSENT bag, not
    // for a null one. No shipped call site can produce it — both spell an object literal —
    // and a future caller that forwards `undefined ?? null` would find this line.
    expect(() => versionChannelFor(null)).toThrow(TypeError)
  })

  it('answers only ids the cache is allowed to hold', () => {
    // A third answer would be a channel no writer stamps, so the reader would see nothing
    // forever. Swept over the whole table plus the hostile values above.
    const answers = new Set(
      [...PATHS.map(([, p]) => p), '', '/', 42, null, undefined].map((ralphHome) =>
        versionChannelFor({ ralphHome }),
      ),
    )
    expect([...answers].sort()).toEqual([BREW, NPM].sort())
  })
})

describe('QA #215 the reader is PURE — no probe, no clock, no environment', () => {
  it('ignores an fs handed to it, however hostile', () => {
    // Doctor passes an fs to its neighbours in the same module, so the temptation to accept
    // one here is real — and a channel that depended on a probe could answer differently for
    // the same install on two runs, which is the one thing a cache key may not do.
    const hostileFs = {
      existsSync: () => {
        throw new Error('probed')
      },
      lstatSync: () => {
        throw new Error('probed')
      },
    }
    expect(versionChannelFor({ ralphHome: FORMULA_PATH('/opt/homebrew'), fs: hostileFs })).toBe(BREW)
    expect(versionChannelFor({ ralphHome: '/repo', fs: hostileFs })).toBe(NPM)
  })

  it('names no filesystem, clock or environment in its own body', () => {
    // The source-level half of the same claim, because an fs read added later would pass the
    // test above by using the real one rather than the argument.
    const body = functionBody(codeWithoutComments(new URL('./install-markers.js', import.meta.url)), 'versionChannelFor')
    for (const forbidden of ['readFileSync', 'existsSync', 'lstatSync', 'process', 'Date', 'Math.random', 'node:fs']) {
      expect(body, forbidden).not.toContain(forbidden)
    }
  })

  it('answers identically on repeated calls and mutates nothing', () => {
    const home = FORMULA_PATH('/opt/homebrew')
    const answers = Array.from({ length: 5 }, () => versionChannelFor({ ralphHome: home }))
    expect(new Set(answers).size).toBe(1)
    // The table it matches against is frozen, so a matcher that sorted or spliced in place
    // would throw rather than quietly reorder the rows every other consumer reads.
    expect(Object.isFrozen(INSTALL_MARKERS)).toBe(true)
    expect(Object.isFrozen(VERSION_CHANNEL)).toBe(true)
    expect(INSTALL_MARKERS.map((row) => row.store)).toEqual(['pnpm', 'yarn', 'bun', 'brew'])
  })

  it('stays fast on an absurdly deep path', () => {
    // A path match runs on every `ralph start` and every `ralph doctor`, and a matcher that
    // was quadratic in segments would be a visible pause on a deep node_modules tree.
    const deep = `/opt/homebrew/Cellar/ralph/${'a/'.repeat(5000)}x`
    const started = Date.now()
    expect(versionChannelFor({ ralphHome: deep })).toBe(BREW)
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('carries exactly one versionChannel in the marker table — brew’s', () => {
    // The npm fallback is a property of the FUNCTION, not of three rows repeating an id. If a
    // second row ever spells one, this is the test that makes whoever wrote it look at the
    // fallback and at `install-target.js`'s identity-shared NPM_VERSION_QUERY together.
    const stamped = INSTALL_MARKERS.filter((row) => row.versionChannel)
    expect(stamped.map((row) => [row.store, row.versionChannel])).toEqual([['brew', BREW]])
  })
})

describe('QA #215 the reader and the writer must name the same channel', () => {
  // THE INVARIANT NEITHER SIDE CAN STATE ALONE. The gate WRITES a resolved version under the
  // channel on `classifyInstall(...).latest.channel`; doctor and the banner READ it under
  // `versionChannelFor(...)`. If those two disagree for one install path, that copy writes
  // under one id and reads under another and can never see its own cached number again — a
  // permanently missing notice, which is quieter than the bug #215 fixed and would show up in
  // no test on either side.
  const readAndWrite = async (ralphHome, seed = {}) => {
    const classification = await classifyInstall({
      ralphHome,
      exec: null,
      fs: Volume.fromJSON(seed),
    })
    return {
      reader: versionChannelFor({ ralphHome }),
      writer: classification.latest?.channel,
      kind: classification.kind,
    }
  }

  for (const [label, ralphHome] of PATHS.filter(([, p]) => p !== '')) {
    it(`agrees with the classification for ${label}`, async () => {
      const { reader, writer } = await readAndWrite(ralphHome)
      expect(writer, 'the classification must name a channel at all').toBeTruthy()
      expect(reader).toBe(writer)
    })
  }

  it('agrees for a blank path too, where the classification refuses to guess', async () => {
    const { reader, writer, kind } = await readAndWrite('')
    expect(kind).toBe('unknown')
    expect(reader).toBe(writer)
  })

  it('DIVERGES for a Cellar the fs probes reject, and fails closed — CHARACTERIZATION', async () => {
    // The two shapes where the two sides cannot agree, because the writer probes the
    // filesystem and the reader is pure by design:
    //
    //   * a `.git` inside a Cellar tree — `classifyInstall` calls it a linked dev checkout and
    //     files its answer under npm, while the path still says brew;
    //   * an `_npx` segment inside a Cellar tree — the npx refusal, same thing.
    //
    // Neither is a real Homebrew install (the formula runs `npm install` under `libexec`: no
    // `.git`, no symlink, nowhere near an npx cache), so both are hand-made. Recorded rather
    // than filed as a bug because the DIRECTION is safe: the reader asks for brew's number
    // and the writer stamped npm's, so the reader is served nothing at all — a missing row,
    // never another channel's version. The opposite direction (reader npm, writer brew) is
    // the harmful one, and no path produces it.
    const cellar = FORMULA_PATH('/opt/homebrew')
    const linked = await readAndWrite(cellar, { [`${cellar}/.git/HEAD`]: 'ref: refs/heads/main\n' })
    expect(linked).toMatchObject({ kind: 'linked', reader: BREW, writer: NPM })
    const npxInCellar = `/opt/homebrew/Cellar/ralph/0.26.0/.npm/_npx/1a2b/node_modules/@lucasfe/ralph`
    const npx = await readAndWrite(npxInCellar)
    expect(npx).toMatchObject({ kind: 'npx', reader: BREW, writer: NPM })
    // The safe direction, stated as the property: no path may leave the READER on npm while
    // the WRITER stamps brew, since that is the combination that serves a tap number to a
    // registry install.
    for (const [, ralphHome] of PATHS) {
      const { reader, writer } = await readAndWrite(ralphHome)
      expect([reader, writer], ralphHome).not.toEqual([NPM, BREW])
    }
  })
})
