import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { codeWithoutComments } from '../../test/helpers/source-code.js'
import { doctorCommand } from './doctor.js'

// #201 — the `channel` row: which channel THIS copy of Ralph was installed from.
//
// npm and the Homebrew tap hold different versions on purpose (#196 added the tap so a refused
// `npm publish` could not stop a release from being installable), which makes "how did you
// install it?" the first question on every bug report about a version. Doctor is the command
// people paste into that bug report, so the answer belongs in the identity box — asked and
// answered before anybody has to ask it.
//
// THE ROW COSTS NO SPAWNER, and that constraint is the whole design. Doctor may not import
// lib/install-target.js: it imports a process runner at module scope, and
// doctor.version-line.qa.test.js walks doctor's transitive import graph and pins the complete
// set of bare specifiers it may reach. So #201 extracted the marker-matching core into
// lib/install-markers.js — `node:path` and nothing else — and this row is that module plus two
// `lstat`-shaped probes on the package root. The graph spec is the acceptance criterion for
// that split and it is deliberately NOT repeated here; what this file owns is everything the
// row itself decides:
//
//   1. A HOMEBREW PATH IS NAMED, positively. That is the layout the row exists for.
//   2. A GLOBAL NPM PATH IS HEDGED. `npm root -g` is the only thing that identifies it and
//      doctor is forbidden to spawn that, so the row says `not probed` out loud rather than
//      asserting npm. A reader has to be able to tell a determination from a default.
//   3. NO PATH, NO ROW. `ralphHome` is undefaulted for the same reason `exec` is (see
//      doctor.js): the default would be an import this file may not make. A caller that
//      passes nothing gets silence, never an invented channel.
//   4. NOTHING ELSE MOVED. Every box that did not ask for a channel is the box it always was,
//      which is what keeps `ralph start`'s and `ralph status`'s output byte-identical.
//
// Hermetic (#41): the cache is memfs, the config is a text seam, the install path is a literal
// and the link probes are injected — no run here reads the real RALPH_HOME, which in a vitest
// worker is this checkout (a `.git`, so: linked).

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const stripAnsi = (s) => s.replace(ANSI_RE, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => stripAnsi(chunks.join('')),
  }
}

const allPresent = () => true
const HOME = '/home/me'
const CWD = '/repo'
const CACHE_PATH = join(HOME, '.config', 'ralph', 'update-check.json')

const GLOBAL_RALPH = '/usr/local/lib/node_modules/@lucasfe/ralph'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const NPX_RALPH = '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph'
const CHECKOUT = '/Users/me/repos/ralph'

const warmCache = (latestVersion) =>
  Volume.fromJSON({ [CACHE_PATH]: JSON.stringify({ latest_version: latestVersion }) }, '/')

/** The two link probes, answering "a plain directory" unless a test says otherwise. */
const plainDirectory = () => ({
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => false }),
})

const withGitEntry = (root) => ({
  existsSync: (p) => String(p) === join(root, '.git'),
  lstatSync: () => ({ isSymbolicLink: () => false }),
})

const asSymlink = () => ({
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => true }),
})

async function runDoctor({ cacheFs = new Volume(), env = {}, extra = {} } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  const result = await doctorCommand({
    stdout,
    stderr,
    hasCommand: allPresent,
    platform: 'mac',
    env,
    currentVersion: '0.17.0',
    cacheFs,
    home: HOME,
    cwd: CWD,
    color: false,
    exists: () => false,
    readFile: () => '',
    ...extra,
  })
  return { result, out: stdout.output() }
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
const boxLines = (out) => out.split('\n').filter((l) => /^[╭│╰]/.test(l))

describe('doctor `channel` row — which channel this copy came from (#201)', () => {
  it('names Homebrew for a Cellar install', async () => {
    const { out } = await runDoctor({
      extra: { ralphHome: BREW_RALPH, installFs: plainDirectory() },
    })
    expect(rowValue(out, 'channel')).toBe('Homebrew (`Cellar/ralph`)')
  })

  it('names each npm-shaped global store by the manager whose directory it is', async () => {
    for (const [ralphHome, channel] of [
      ['/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph', 'pnpm (global store)'],
      ['/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph', 'yarn (global store)'],
      ['/Users/me/.bun/install/global/node_modules/@lucasfe/ralph', 'bun (global store)'],
    ]) {
      const { out } = await runDoctor({ extra: { ralphHome, installFs: plainDirectory() } })
      expect(rowValue(out, 'channel'), ralphHome).toBe(channel)
    }
  })

  it('HEDGES on a global npm path rather than claiming npm', async () => {
    // The criterion, at the surface a user reads: a global npm install is identified by
    // `npm root -g` and by nothing else, and doctor cannot run it. So the row reports what is
    // actually known — npm is where all but one layout installs from, and nobody checked.
    const { out } = await runDoctor({
      extra: { ralphHome: GLOBAL_RALPH, installFs: plainDirectory() },
    })
    const value = rowValue(out, 'channel')
    expect(value).toBe('npm or other (not probed)')
    expect(value).not.toBe('npm')
    // A reader of the paste can tell this row apart from the one above it, which IS a
    // determination. That distinction is the row's whole value on a bug report.
    expect(value).toMatch(/not probed/)
  })

  it('reports an npx run and a linked install as such', async () => {
    const npx = await runDoctor({ extra: { ralphHome: NPX_RALPH, installFs: plainDirectory() } })
    expect(rowValue(npx.out, 'channel')).toBe('npx (`_npx` cache)')

    const checkout = await runDoctor({
      extra: { ralphHome: CHECKOUT, installFs: withGitEntry(CHECKOUT) },
    })
    expect(rowValue(checkout.out, 'channel')).toBe('linked (dev checkout)')

    const linked = await runDoctor({ extra: { ralphHome: GLOBAL_RALPH, installFs: asSymlink() } })
    expect(rowValue(linked.out, 'channel')).toBe('linked (symlinked install)')
  })

  it('sits directly under the `cached` row', async () => {
    // Both rows are about the same thing — which release this is and which release the channel
    // it came from has — and `channel` is what makes `cached` interpretable: the two channels
    // hold different versions, so "up to date" means nothing until a reader knows which one
    // answered. The row is the last of the release facts and stays above `cwd`.
    const { out } = await runDoctor({
      cacheFs: warmCache('0.18.0'),
      extra: { ralphHome: BREW_RALPH, installFs: plainDirectory() },
    })
    expect(rowLabels(out)).toEqual(['os', 'agent', 'cached', 'channel', 'cwd'])
  })

  it('fits inside the frame, at the design width', async () => {
    const { out } = await runDoctor({
      extra: { ralphHome: BREW_RALPH, installFs: plainDirectory() },
    })
    for (const line of boxLines(out)) expect([...line].length, line).toBe(60)
  })
})

describe('doctor `channel` row — no install path, no row (#201)', () => {
  it('draws nothing at all when the caller passed no install directory', async () => {
    // `ralphHome` is UNDEFAULTED, on doctor's own precedent for `exec`: the default would be an
    // import of lib/paths.js, which reaches `node:url` and would break the bare-specifier set
    // that doctor.version-line.qa.test.js pins. A caller that cannot say gets a row that is
    // absent — never a fabricated channel.
    const { out } = await runDoctor({ cacheFs: warmCache('0.18.0') })
    expect(rowValue(out, 'channel')).toBeUndefined()
    expect(out).not.toContain('not probed')
    // The box every other doctor suite asserts, unmoved: title, os, agent, cached, cwd, close.
    expect(boxLines(out)).toHaveLength(6)
  })

  it('draws nothing for a blank or unusable install path either', async () => {
    // Gated on the path being a NON-BLANK STRING, the same shape `configPathFor` uses one
    // function UP for `cwd` — `configPathFor` is at doctor.js:479 and `installChannel` at :498,
    // which is the direction that function's own note gives at :485. A number, or a NON-EMPTY
    // array, would coerce to a relative path and then resolve against the process's cwd — which
    // is how a diagnostic ends up describing some directory the install has nothing to do with.
    // The EMPTY array in the list below is not one of those: `String([])` is `''`, so it arrives
    // blank and the pure module answers null, which draws no row for a second reason (pinned at
    // lib/install-markers.qa.test.js:706-712, next to a one-element array, which DOES resolve).
    for (const ralphHome of ['', '   ', null, undefined, [], 0, false, {}]) {
      const { out } = await runDoctor({ extra: { ralphHome, installFs: plainDirectory() } })
      expect(rowLabels(out), JSON.stringify(ralphHome)).not.toContain('channel')
    }
  })

  it('keeps its answer out of the exit code, whatever the layout', async () => {
    // The row is additive OUTPUT. Every wrapper and CI step that gates on `ralph doctor` must
    // keep working on the day someone installs it through a different channel.
    for (const ralphHome of [BREW_RALPH, GLOBAL_RALPH, NPX_RALPH, CHECKOUT, undefined]) {
      const { result } = await runDoctor({ extra: { ralphHome, installFs: plainDirectory() } })
      expect(result.exitCode, String(ralphHome)).toBe(0)
    }
  })

  it('survives a filesystem seam it cannot use, and still answers', async () => {
    // Total for every value of the seam, on the argument doctor.js already makes for
    // `readCache` and for `probeJiraAuth`: these are a CALLER's values and a diagnostic that
    // crashed over its own arguments would fail in the one situation it exists for.
    for (const installFs of [null, 42, 'fs', {}, { lstatSync: () => { throw new Error('x') } }]) {
      const { out, result } = await runDoctor({
        extra: { ralphHome: BREW_RALPH, installFs },
      })
      expect(result.exitCode, JSON.stringify(installFs)).toBe(0)
      expect(rowValue(out, 'channel'), JSON.stringify(installFs)).toBe('Homebrew (`Cellar/ralph`)')
    }
  })

  it('never coerces a hostile install path, and never names a channel for one', async () => {
    // The `typeof` gate is what makes this safe rather than a `try`: a bag whose `toString`
    // throws is never asked for one, so there is no failure to swallow and no guard here that
    // a reader has to take on trust.
    const hostile = {
      toString() {
        throw new Error('hostile ralphHome')
      },
    }
    const { out, result } = await runDoctor({
      extra: { ralphHome: hostile, installFs: plainDirectory() },
    })
    expect(result.exitCode).toBe(0)
    expect(rowLabels(out)).not.toContain('channel')
  })
})

describe('doctor `channel` row — the row costs path matching only (#201)', () => {
  it('answers with no `exec` at all, and consults the one it is given for nothing', async () => {
    // Doctor's `exec` seam exists for #125's Jira auth row and for nothing else. A channel row
    // that reached for it would be `npm root -g` on every `ralph doctor` — the spawn the whole
    // extraction was built to avoid.
    const calls = []
    const exec = async (...args) => {
      calls.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const { out } = await runDoctor({
      extra: { ralphHome: GLOBAL_RALPH, installFs: plainDirectory(), exec },
    })
    expect(rowValue(out, 'channel')).toBe('npm or other (not probed)')
    expect(calls).toEqual([])
  })

  it('probes the install path at most twice, and probes nothing else', async () => {
    const paths = []
    const installFs = {
      existsSync: (p) => {
        paths.push(String(p))
        return false
      },
      lstatSync: (p) => {
        paths.push(String(p))
        return { isSymbolicLink: () => false }
      },
    }
    await runDoctor({ extra: { ralphHome: BREW_RALPH, installFs } })
    expect(paths).toEqual([join(BREW_RALPH, '.git'), BREW_RALPH])
  })

  it('takes the channel from the pure module, and holds no layout knowledge of its own', () => {
    // Source-level, in the idiom the other doctor suites use for this class of claim.
    // lib/update-gate.channel.qa.test.js already forbids `classifyInstall` and the word brew in
    // this file; what #201 adds is where the answer DOES come from, so an edit that reimplements
    // marker matching inside the command fails here.
    const code = codeWithoutComments(new URL('./doctor.js', import.meta.url))
    expect(code).toMatch(/from '\.\.\/install-markers\.js'/)
    expect(code).toMatch(/describeInstallChannel/)
    expect(code).not.toMatch(/install-target/)
    expect(code).not.toMatch(/_npx|Cellar/)
    // ...and `ralphHome` is a bare option rather than a defaulted one. A default would be
    // `RALPH_HOME` out of lib/paths.js, which imports `node:url` — a specifier doctor's
    // import-graph spec does not allow.
    expect(code).toMatch(/^\s*ralphHome,\s*$/m)
    // An ASSIGNMENT, which in a destructured bag is a default — and the lookahead is what
    // keeps the assertion about that rather than about any `=` near the name: the gate below
    // compares `typeof ralphHome === 'string'`, and a pattern that read `===` as a default
    // would forbid the one line that makes the option safe to pass anything.
    expect(code).not.toMatch(/ralphHome\s*=(?!=)/)
  })

  it('is handed the real install directory by the entry point', () => {
    // The other half of an undefaulted option: it is worth nothing unless bin/ralph.js fills
    // it in, and a user running `ralph doctor` must get a real answer. Same shape as #125's
    // `exec`, which reaches the command from exactly the same line.
    const bin = codeWithoutComments(new URL('../../bin/ralph.js', import.meta.url))
    expect(bin).toMatch(/ralphHome:\s*RALPH_HOME/)
    expect(bin).toMatch(/from '\.\.\/lib\/paths\.js'/)
  })
})
