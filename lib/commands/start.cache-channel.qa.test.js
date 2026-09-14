import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { startCommand } from './start.js'
import { versionCachePath } from '../version-cache.js'

// QA #215 — `ralph start`'s identity box on a HOMEBREW copy.
//
// The banner's update row is the second place a cached version is shown to a user (doctor's
// `cached` row is the first), and #215 gave it a channel: `versionChannelFor({ ralphHome })`
// decides whose number the box may report. The dev's suites cover the row thoroughly — but
// every run in lib/commands/start.banner.qa.test.js pins `ralphHome: REPO`, a path no install
// marker claims, so the channel under test there is always npm. Nothing pinned the row for a
// copy installed from the tap, which is exactly the copy the issue was reported from.
//
// So this file drives the same command with a CELLAR `ralphHome` and asserts both directions
// over one cache file: the brew copy sees the tap's number and refuses npm's, and the npm copy
// in the same repo refuses the tap's. The last case drives the DEFAULT wiring — no `readCache`
// seam, a real `readVersionCache` over memfs — so the row cannot be satisfied by a stub.
//
// Hermetic: memfs for the cache, injected exec/clock/terminal, no splash (piped stdout).

const REPO = '/repo'
const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })

// The two layouts on the reported machine. The Cellar path is what a `brew install ralph`
// libexec install really looks like; REPO is a path no marker claims, which reads as npm.
const CELLAR = '/opt/homebrew/Cellar/ralph/0.26.0/libexec/lib/node_modules/@lucasfe/ralph'

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '')

const NO_UPDATE = {
  latestVersion: null,
  isNewer: false,
  shouldPrompt: false,
  source: 'disabled',
  updatedCache: null,
}

const stampedCache = (over) => ({
  last_check_at: null,
  last_prompted_at: null,
  latest_version: null,
  latest_version_channel: null,
  ...over,
})

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    lines: () => strip(chunks.join('')).split('\n').slice(0, -1),
  }
}

// The same shape lib/commands/start.banner.qa.test.js's `deps` builds, cut down to what the
// identity box needs: a folder-source config, a preflight that passes, a declining prompt and
// an update check that reports nothing (the box's row comes from the CACHE, not from the
// check). `ralphHome` is the one input under test, so it is never defaulted here.
function deps({ ralphHome, ...over } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr,
    exec: async (cmd, args = []) => {
      if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
      if (cmd === 'jq') return { exitCode: 0, stdout: 'ctx, gh\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    exists: (p) => String(p).endsWith('ralph.config.sh'),
    readFile: (p) => (String(p).endsWith('ralph.config.sh') ? 'TASK_SOURCE=folder\n' : ''),
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => false,
    currentVersion: '1.2.3',
    update: async () => NO_UPDATE,
    recordPrompt: () => {},
    readChangelog: () => [],
    sleep: async () => {},
    signals: null,
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => 3,
    now: () => 1_700_000_000_000,
    home: HOME,
    processEnv: {},
    ralphBinary: '/usr/local/bin/ralph',
    ralphHome,
    ...over,
  }
}

const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}
const rowOf = (d, label) => boxOf(d).find((line) => line.includes(`│ ${label}`))

describe('QA #215 the identity box asks the channel this copy was installed from', () => {
  it('shows the TAP’s number to a Cellar copy', async () => {
    // The row exists at all for a brew copy — the direction a fix that hard-coded npm, or one
    // that forgot to pass `ralphHome`, would silently break: the Homebrew user would then
    // never see a hint again, which is a quieter failure than the bug #215 fixed and would
    // pass every npm-shaped test in the suite.
    const d = deps({
      ralphHome: CELLAR,
      readCache: () => stampedCache({ latest_version: '9.9.9', latest_version_channel: 'brew' }),
    })
    await startCommand(d)
    expect(rowOf(d, 'update')).toContain('9.9.9')
  })

  it('refuses npm’s number on a Cellar copy — the row simply is not drawn', async () => {
    // The reported symptom, in the banner rather than in doctor: a Homebrew copy showing a
    // number only npm's channel could produce. There is no "unknown" state to render, so the
    // correct output is the box WITHOUT an update row.
    const d = deps({
      ralphHome: CELLAR,
      readCache: () => stampedCache({ latest_version: '9.9.9', latest_version_channel: 'npm' }),
    })
    await startCommand(d)
    expect(rowOf(d, 'update')).toBeUndefined()
    expect(boxOf(d).join('\n')).not.toContain('9.9.9')
  })

  it('refuses the tap’s number on an npm-shaped copy — the harmful direction', async () => {
    // The mirror, and the harmful one: this row is what would send an npm user to
    // `ralph update` for a release the registry does not have.
    const d = deps({
      ralphHome: REPO,
      readCache: () => stampedCache({ latest_version: '9.9.9', latest_version_channel: 'brew' }),
    })
    await startCommand(d)
    expect(rowOf(d, 'update')).toBeUndefined()
  })

  it('refuses a LEGACY unstamped number on a Cellar copy', async () => {
    // Criterion 2 at this call site. A 0.26.0 brew copy wrote the tap's number into the bare
    // field, so an unstamped number is as likely to be brew's as npm's — and a box that
    // adopted it would be right by luck rather than by rule.
    const d = deps({
      ralphHome: CELLAR,
      readCache: () => ({ latest_version: '9.9.9' }),
    })
    await startCommand(d)
    expect(rowOf(d, 'update')).toBeUndefined()
  })

  it('reads a real cache file through the DEFAULT wiring, on a Cellar copy', async () => {
    // No `readCache` seam: the command's own `readVersionCache` over memfs, so the channel
    // argument is joined to the real reader rather than to a stub that could ignore it. Both
    // stamps are driven over the same path to keep the two answers comparable.
    for (const [channel, expected] of [
      ['brew', true],
      ['npm', false],
    ]) {
      const cacheFs = Volume.fromJSON(
        { [CACHE_PATH]: JSON.stringify(stampedCache({ latest_version: '9.9.9', latest_version_channel: channel })) },
        '/',
      )
      const d = deps({ ralphHome: CELLAR, cacheFs })
      await startCommand(d)
      expect(Boolean(rowOf(d, 'update')), channel).toBe(expected)
    }
  })

  it('is not thrown off by a hostile ralphHome — no row, no crash', async () => {
    // `ralphHome` is injectable, and `versionChannelFor` answers npm for anything it cannot
    // read as a path. What must not happen is the run dying over a decoration, so each of
    // these is driven with a cache only BREW may read: the row is absent because the fallback
    // channel is npm, and the run completes either way.
    for (const ralphHome of [null, 42, {}, [], '', '   ', '/']) {
      const d = deps({
        ralphHome,
        readCache: () => stampedCache({ latest_version: '9.9.9', latest_version_channel: 'brew' }),
      })
      await expect(startCommand(d)).resolves.toBeDefined()
      expect(rowOf(d, 'update'), JSON.stringify(ralphHome)).toBeUndefined()
    }
  })

  it('still costs the run nothing when the cache read throws on a Cellar copy', async () => {
    const d = deps({
      ralphHome: CELLAR,
      readCache: () => {
        throw new Error('EIO')
      },
    })
    await expect(startCommand(d)).resolves.toBeDefined()
    expect(rowOf(d, 'update')).toBeUndefined()
  })
})
