import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { join } from 'node:path'
import { doctorCommand } from './doctor.js'

// #215 — the `cached` row reports THIS copy's channel, and never the other copy's number.
//
// THE BUG, as observed on 2026-09-13. A machine with two copies of Ralph: an nvm/npm one at
// 0.25.4 and a Homebrew one at 0.26.0. `ralph doctor` from the Homebrew copy printed
//
//   ╭─ ralph 0.26.0 ───────────────────────────────────────────╮
//   │ cached  0.23.0 — up to date                              │
//   │ channel Homebrew (`Cellar/ralph`)                         │
//   ╰──────────────────────────────────────────────────────────╯
//
// and 0.23.0 is a number the Homebrew channel cannot produce. It is the last version npm
// accepted before the 403 of #196, and npm's `latest` ever since, while six tags shipped past
// it — so the row was reporting the npm copy's answer under a Homebrew heading, in the one
// command whose whole value is that a reader can trust the facts in it. #27's cache is one
// global file with one un-keyed `latest_version` field, and whichever copy last ran the weekly
// check owned it.
//
// The two rows in that box come from two facts, and the row that was RIGHT is what makes the
// other one so expensive: #201's `channel` row correctly named Homebrew, which is exactly what
// invites a reader to attribute `cached 0.23.0` to the tap.
//
// WHAT THIS FILE OWNS is doctor's half — that the verdict is read for the channel doctor's own
// install path names, and that an unattributable number reads as "nobody has checked" rather
// than as this channel's answer. The file's shape is lib/version-cache.channel.test.js; the
// write side and the join between the two derivations of a channel id are
// lib/update-check.cache-channel.test.js.
//
// THE ROW'S COST IS UNCHANGED, and that is a constraint rather than a note: doctor is the
// command people run when the machine is already broken and possibly offline. Deriving the
// channel is the same path matching #201's `channel` row already does, out of the same pure
// module (lib/install-markers.js — doctor may not import lib/install-target.js at all), so this
// slice adds no spawn, no socket and no cache write.
//
// Hermetic (#41): memfs cache, injected link probes, path literals, no real RALPH_HOME.

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
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.26.0/libexec/lib/node_modules/@lucasfe/ralph'
const NPX_RALPH = '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph'
const CHECKOUT = '/Users/me/repos/ralph'

const NPM = 'npm'
const BREW = 'brew'
const HOMEBREW_ROW = 'Homebrew (`Cellar/ralph`)'
const NOTHING_CACHED = 'unknown (no update check cached yet)'

/** The cache as a two-copy machine has it: one file, one number, one channel that produced it. */
const cacheOf = (fields) => Volume.fromJSON({ [CACHE_PATH]: JSON.stringify(fields) }, '/')
const stamped = (version, channel) =>
  cacheOf({
    last_check_at: '2026-09-09T17:13:35.685Z',
    last_prompted_at: null,
    latest_version: version,
    latest_version_channel: channel,
  })
/** The file exactly as #215 found it: a bare version, written before any channel was recorded. */
const legacyFile = () =>
  cacheOf({
    last_check_at: '2026-09-09T17:13:35.685Z',
    last_prompted_at: null,
    latest_version: '0.23.0',
  })

/** The two link probes, answering "a plain directory" unless a test says otherwise. */
const plainDirectory = () => ({
  existsSync: () => false,
  lstatSync: () => ({ isSymbolicLink: () => false }),
})
const withGitEntry = (root) => ({
  existsSync: (p) => String(p) === join(root, '.git'),
  lstatSync: () => ({ isSymbolicLink: () => false }),
})

async function runDoctor({ cacheFs = new Volume(), currentVersion = '0.26.0', extra = {} } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  await doctorCommand({
    stdout,
    stderr,
    hasCommand: allPresent,
    platform: 'mac',
    env: {},
    currentVersion,
    cacheFs,
    home: HOME,
    cwd: CWD,
    color: false,
    exists: () => false,
    readFile: () => '',
    installFs: plainDirectory(),
    ...extra,
  })
  return stdout.output()
}

/** The box's rows are `label value` pairs in an eight-column gutter. */
const GUTTER = 8
const prefixFor = (label) => `│ ${label.padEnd(GUTTER)}`
const rowValue = (out, label) => {
  const prefix = prefixFor(label)
  const line = out.split('\n').find((l) => l.startsWith(prefix))
  return line === undefined ? undefined : line.slice(prefix.length, -2).trimEnd()
}

describe('doctor `cached` row — the regression #215 was filed for', () => {
  it('does not report npm’s 0.23.0 to the Homebrew copy that read the shared file', async () => {
    const out = await runDoctor({
      cacheFs: legacyFile(),
      extra: { ralphHome: BREW_RALPH },
    })
    expect(rowValue(out, 'cached')).toBe(NOTHING_CACHED)
    // The number is not in the paste AT ALL — not in the row, not in a hint, nowhere a reader
    // could pick it up. This is the assertion the issue is about.
    expect(out).not.toContain('0.23.0')
    // ...and the row that was always right is untouched: doctor still says how this copy was
    // installed, which is the fact a bug report needs first.
    expect(rowValue(out, 'channel')).toBe(HOMEBREW_ROW)
  })

  it('does not report it when the file says outright that npm produced it', async () => {
    // The same read one release later, once every copy stamps what it resolved. A brew copy
    // must not believe a number the file attributes to npm.
    const out = await runDoctor({
      cacheFs: stamped('0.23.0', NPM),
      extra: { ralphHome: BREW_RALPH },
    })
    expect(rowValue(out, 'cached')).toBe(NOTHING_CACHED)
    expect(out).not.toContain('0.23.0')
    expect(rowValue(out, 'channel')).toBe(HOMEBREW_ROW)
  })

  it('reports the tap’s number to the Homebrew copy, which is whose answer it is', async () => {
    const out = await runDoctor({
      cacheFs: stamped('0.27.0', BREW),
      extra: { ralphHome: BREW_RALPH },
    })
    expect(rowValue(out, 'cached')).toBe('0.27.0 available — run `ralph update`')
    expect(rowValue(out, 'channel')).toBe(HOMEBREW_ROW)
  })

  it('keeps #27’s up-to-date verdict for the channel that owns the number', async () => {
    // Nothing about the reading changes when the answer is "you are current": the point of the
    // key is WHOSE number it is, not which verdict it produces.
    const out = await runDoctor({
      cacheFs: stamped('0.26.0', BREW),
      currentVersion: '0.26.0',
      extra: { ralphHome: BREW_RALPH },
    })
    expect(rowValue(out, 'cached')).toBe('0.26.0 — up to date')
  })

  it('reports npm’s number to an npm-shaped copy, in the other direction', async () => {
    // The harmful direction of the same shared field, from the reading side: the npm copy at
    // 0.25.4 reads npm's 0.23.0 (a downgrade, so no nag) and must NOT be able to read the tap's
    // 0.27.0 — the nag that would have sent a user to `npm i -g @lucasfe/ralph@latest` for a
    // version npm cannot serve.
    const mine = await runDoctor({
      cacheFs: stamped('0.23.0', NPM),
      currentVersion: '0.25.4',
      extra: { ralphHome: GLOBAL_RALPH },
    })
    expect(rowValue(mine, 'cached')).toBe('0.23.0 — up to date')

    const theirs = await runDoctor({
      cacheFs: stamped('0.27.0', BREW),
      currentVersion: '0.25.4',
      extra: { ralphHome: GLOBAL_RALPH },
    })
    expect(rowValue(theirs, 'cached')).toBe(NOTHING_CACHED)
    expect(theirs).not.toContain('0.27.0')
  })

  it('serves the tap’s number to no npm-installed layout, whichever one it is', async () => {
    // Every layout but the Cellar installs FROM npm — an npx cache and a dev checkout included,
    // which is why the read side partitions by CHANNEL and not by the store that installed it.
    for (const [ralphHome, installFs] of [
      [GLOBAL_RALPH, plainDirectory()],
      [NPX_RALPH, plainDirectory()],
      [CHECKOUT, withGitEntry(CHECKOUT)],
    ]) {
      const out = await runDoctor({
        cacheFs: stamped('0.27.0', BREW),
        extra: { ralphHome, installFs },
      })
      expect(rowValue(out, 'cached'), ralphHome).toBe(NOTHING_CACHED)
    }
  })
})

describe('doctor `cached` row — a copy that cannot place itself (#215)', () => {
  it('reads npm’s number when the caller named no install directory at all', async () => {
    // THE DELIBERATE ASYMMETRY WITH THE `channel` ROW ABOVE, and the argument for it.
    //
    // #201 gave `ralphHome` no default, so a caller that passes none draws NO channel row: for
    // a fact whose whole value is trustworthiness, silence beats a guess. The `cached` row has
    // no silence available — doctor always draws it, because "nobody has checked yet" is itself
    // a diagnostic finding #27 shipped on purpose — so the read has to name SOME channel, and
    // npm is the only honest one to name: every layout but the Cellar installs from npm, it is
    // the fallback `classifyInstall` returns for a path no marker claimed, and it is the same
    // guess #201's own row hedges as `npm or other (not probed)`.
    //
    // It costs nothing in production, which is what makes it safe rather than merely defensible:
    // bin/ralph.js passes `ralphHome: RALPH_HOME` on every real `ralph doctor`, so a Homebrew
    // copy is placed by its own Cellar path and never lands here. What lands here is a caller
    // that never asked — and reading npm's own number for it is not the #215 bug, which was
    // reading ANOTHER channel's number under this channel's name.
    const out = await runDoctor({ cacheFs: stamped('0.23.0', NPM), currentVersion: '0.25.4' })
    expect(rowValue(out, 'cached')).toBe('0.23.0 — up to date')
    expect(rowValue(out, 'channel')).toBeUndefined()
  })

  it('still refuses the tap’s number to a caller that named no install directory', async () => {
    // The half of the paragraph above that is load-bearing: "npm when nobody said" is a guess
    // about which npm-shaped layout this is, never a licence to read the tap's answer.
    const out = await runDoctor({ cacheFs: stamped('0.27.0', BREW) })
    expect(rowValue(out, 'cached')).toBe(NOTHING_CACHED)
    expect(out).not.toContain('0.27.0')
  })

  it('draws the row rather than crashing for an install path it cannot use', async () => {
    // Doctor's standing promise: every seam a caller can get wrong costs a row's worth of
    // detail, never the report or the exit code. A non-string path is a caller that never
    // asked (see `installChannel`'s note in doctor.js on why the coercion is refused), and a
    // probe seam that throws is the same "not a link" answer a plain directory gets.
    //
    // The bag whose `toString` throws is here because it is not hypothetical: #201's own suite
    // pins that value, and the first cut of this slice derived the version channel through
    // `normalizePath`'s `String()` and took the whole report down with it.
    for (const extra of [
      { ralphHome: 42 },
      { ralphHome: {} },
      { ralphHome: null },
      { ralphHome: 0 },
      { ralphHome: { toString() { throw new Error('hostile ralphHome') } } },
      { ralphHome: new Proxy({}, { get() { throw new Error('hostile') } }) },
      { ralphHome: BREW_RALPH, installFs: undefined },
      { ralphHome: BREW_RALPH, installFs: { existsSync: () => { throw new Error('nope') } } },
    ]) {
      const out = await runDoctor({ cacheFs: stamped('0.27.0', BREW), extra })
      expect(rowValue(out, 'cached'), Object.keys(extra).join('+')).toBeDefined()
    }
  })

  it('reads the Cellar path for the channel with no probe of its own', async () => {
    // A Cellar is decided by path segments alone — the version channel takes no filesystem probe
    // at all (lib/install-markers.js argues why, and lib/update-check.cache-channel.test.js pins
    // it against a seam that throws on every access). So a probe seam doctor's `channel` ROW
    // cannot use is still unable to demote a brew copy to the npm fallback and hand it npm's
    // number, which is the direction that would resurrect #215.
    const out = await runDoctor({
      cacheFs: stamped('0.23.0', NPM),
      extra: { ralphHome: BREW_RALPH, installFs: { lstatSync: () => 'not a stat' } },
    })
    expect(rowValue(out, 'cached')).toBe(NOTHING_CACHED)
    expect(out).not.toContain('0.23.0')
  })
})
