import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { runUpdateGate } from './update-gate.js'
import { updateCommand } from './commands/update.js'
import { classifyInstall } from './install-target.js'
import { readVersionCache, versionCachePath } from './version-cache.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'

// #199/#200 QA — the CROSS-CONSUMER half of "ask the channel this copy came from",
// which no single-module test can see: one transcript, one install, and the two
// consumers that used to disagree about which channel it belongs to.
//
// #199 changed `ralph update` and deliberately left the weekly check in
// `resolveUpdateDecision` on the npm default, because `ralph start` held no
// classification and probing for one would have added a spawn to a path whose whole
// point is to cost nothing. This file used to pin that tradeoff and the three
// user-visible shapes it produced. #200 closed it — the gate now classifies without
// an exec, so the probe is filesystem-only — and every one of those shapes changed:
//
//   - a Homebrew transcript no longer contains the word npm ANYWHERE. Before, the
//     notice named `npm i -g @lucasfe/ralph` while an accepted prompt ran
//     `brew upgrade ralph`, so one run told the user two different things.
//   - a tap ahead of the registry is now noticed. That is #196's whole reason for
//     existing: a release the tap has and npm does not must still reach users.
//   - a registry ahead of the tap is now silent on a brew install, which is the
//     replacement tradeoff and is named as such below — it is the strictly better
//     half of the pair, since the nag it removes was one the user could not act on.
//   - the global version cache — which `ralph doctor` reads and never re-queries —
//     now holds the version THIS install's channel offers.
//
// Not re-tested here: the per-layout notice command and the spawn counts
// (lib/update-gate.notice-command.test.js), the descriptor each layout carries
// (lib/install-target.channel.test.js, lib/install-target.notice.test.js), the
// `latestSource` seam (lib/update-check.decision-channel.test.js), and the gate's own
// contract — verdict shape, TTY gate, stamp ordering, never-throws
// (lib/update-gate.test.js, lib/update-gate.qa.test.js).
//
// Hermeticity (#41): `exec` is injected, the cache is memfs under a fake `home`,
// `isTTY` is passed explicitly (it is undefined on a vitest worker, so a defaulted
// gate never prompts and every prompt assertion would be vacuous), and each run
// injects its install layout as a path plus a memfs volume — the real RALPH_HOME is
// this checkout, whose own layout is `linked`.

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '')

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'
const NPM_RALPH = '/usr/local/lib/node_modules/@lucasfe/ralph'

const VIEW_KEY = 'npm view @lucasfe/ralph version'
const ROOT_KEY = 'npm root -g'
const NPM_INSTALL_KEY = 'npm install -g @lucasfe/ralph@latest'
const BREW_INFO_KEY = 'brew info --json=v2 ralph'
const BREW_UPGRADE_KEY = 'brew upgrade ralph'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').filter(Boolean),
  }
}

function makeExec(handlers = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ key, cmd, args, options })
    if (Object.prototype.hasOwnProperty.call(handlers, key)) return handlers[key]
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.keys = () => calls.map((c) => c.key)
  return exec
}

const semver = (v) => ({ exitCode: 0, stdout: `${v}\n`, stderr: '', timedOut: false })
const brewInfo = (stable) => ({
  exitCode: 0,
  stdout: JSON.stringify({
    formulae: [{ name: 'ralph', revision: 0, versions: { stable, head: 'HEAD', bottle: true } }],
    casks: [],
  }),
  stderr: '',
})

// The gate's own classification, with the ONE thing production supplies that a test
// cannot: the install directory. The gate hands `classify` its bag and nothing else
// (`{exec: null}` — pinned in lib/update-gate.notice-command.test.js), so spreading
// that bag first is what keeps the injection honest: whatever the gate withholds stays
// withheld here too.
const layoutAt =
  (ralphHome, vol = Volume.fromJSON({})) =>
  (opts) =>
    classifyInstall({ ...opts, ralphHome, fs: vol })

// `runUpdate` stands in for the same missing path on the ACCEPT side. The gate calls
// `updateCommand({currentVersion, exec, stdout, stderr})` and forwards no install path
// at all (pinned in lib/update-gate.test.js), so in production `classifyInstall` falls
// back to its own RALPH_HOME default — which is what makes an accepted prompt update
// through the channel the running copy came from. This wrapper supplies that path plus
// the fs the real one would read, and is otherwise the production seam.
const realUpdateFrom = (ralphHome, vol = Volume.fromJSON({})) => (bag) =>
  updateCommand({ ...bag, ralphHome, classify: (opts) => classifyInstall({ ...opts, fs: vol }) })

// A gate whose decision, stamp, prompt-window, classification and version query are
// all the real ones — the injected seams are the terminal, the clock, the cache,
// `exec` and the install path.
function gate({ handlers = {}, ralphHome = NPM_RALPH, vol, ...overrides } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    stdout,
    stderr,
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: true,
    exec: makeExec(handlers),
    classify: layoutAt(ralphHome, vol),
    ask: async () => true,
    now: () => Date.parse('2026-09-03T12:00:00.000Z'),
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
  }
}

describe('runUpdateGate — one install, one channel, one transcript (#200 QA)', () => {
  it('says nothing about npm anywhere in a Homebrew run', async () => {
    // The headline reversal. Every subprocess, every line of output: brew only.
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: {
        [VIEW_KEY]: semver('9.9.9'),
        [BREW_INFO_KEY]: brewInfo(LATEST),
        [BREW_UPGRADE_KEY]: { exitCode: 0, stdout: '', stderr: '' },
      },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({
      isNewer: true,
      latestVersion: LATEST,
      prompted: true,
      accepted: true,
      installed: true,
      installedVersion: LATEST,
    })
    expect(g.exec.keys()).toEqual([BREW_INFO_KEY, BREW_INFO_KEY, BREW_UPGRADE_KEY])
    expect(g.stdout.output()).not.toMatch(/npm/i)
    expect(g.stderr.output()).not.toMatch(/npm/i)
  })

  it('never probes for the layout, however it is asked', async () => {
    // The tradeoff #199 protected, now protected differently: the classification is
    // filesystem-only, so `ralph start` still spawns nothing but the one query.
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: { [BREW_INFO_KEY]: brewInfo(LATEST) },
      ask: async () => false,
    })
    await runUpdateGate(g)
    expect(g.exec.keys()).toEqual([BREW_INFO_KEY])
    expect(g.exec.calls[0].options).toEqual({ timeout: 5000, reject: false })
  })

  it('notices a release the tap has and the registry does not', async () => {
    // #196's reason for existing, end to end: a refused `npm publish` no longer hides
    // a release from the users who can install it. Before #200 this run printed
    // nothing and asked nothing.
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: {
        [VIEW_KEY]: semver(CURRENT),
        [BREW_INFO_KEY]: brewInfo(LATEST),
        [BREW_UPGRADE_KEY]: { exitCode: 0, stdout: '', stderr: '' },
      },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST, installed: true })
    expect(g.stdout.output()).toContain(
      `New version available: ${LATEST} (run brew upgrade ralph to update)`,
    )
    expect(g.exec.keys()).not.toContain(VIEW_KEY)
  })

  it('DOCUMENTED: a registry ahead of the tap is silent on a Homebrew install', async () => {
    // The replacement tradeoff, and the direction worth having: npm has 0.16.0, the
    // tap has only what is installed, so this run says nothing. The version is real
    // and it is genuinely newer — it is simply not installable HERE yet, and the old
    // behaviour (nag, then have `ralph update` correctly refuse) spent the user's
    // attention on a release they could not have. Nothing is lost permanently: the
    // weekly window reopens, and the notice appears the run after the tap catches up.
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: { [VIEW_KEY]: semver(LATEST), [BREW_INFO_KEY]: brewInfo(CURRENT) },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toEqual({
      isNewer: false,
      latestVersion: CURRENT,
      prompted: false,
      accepted: false,
      installed: false,
      installedVersion: null,
    })
    expect(g.exec.keys()).toEqual([BREW_INFO_KEY])
    expect(g.stdout.output()).toBe('')
  })

  it('is unchanged for an npm install: same queries, same order, same notice', async () => {
    // The control row, byte for byte what it was before #200. A global npm install is
    // the layout the gate's exec-less classification cannot NAME — `npm root -g` is
    // what decides it — so the gate treats it as unknown, and unknown asks npm and
    // suggests npm. The accepted update then runs the probe and gets it right.
    const g = gate({
      ralphHome: NPM_RALPH,
      handlers: {
        [VIEW_KEY]: semver(LATEST),
        [ROOT_KEY]: { exitCode: 0, stdout: '/usr/local/lib/node_modules\n', stderr: '' },
        [NPM_INSTALL_KEY]: { exitCode: 0, stdout: '', stderr: '' },
      },
      runUpdate: realUpdateFrom(NPM_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ installed: true, installedVersion: LATEST })
    expect(g.stdout.output()).toContain(
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    )
    expect(g.exec.keys()).toEqual([VIEW_KEY, ROOT_KEY, VIEW_KEY, NPM_INSTALL_KEY])
  })

  it('survives a channel that cannot be read, and says nothing it cannot support', async () => {
    // A tap that is not tapped: the query fails, so there is no version to compare and
    // no notice at all. The diagnosis the user needs — which channel failed and why —
    // belongs to the run they asked for, `ralph update`, not to a background check
    // that is only advice.
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: { [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: 'Error: No formula' } },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: false, latestVersion: null, prompted: false })
    expect(g.stdout.output()).toBe('')
    expect(g.stderr.output()).toBe('')
    expect(g.exec.keys()).toEqual([BREW_INFO_KEY])
  })

  it('offers a linked checkout no command, still asks, and still refuses', async () => {
    // The refusal outranks the notice on both sides: a dev checkout is told a version
    // exists (from npm, which is what `linked` carries), offered no command it would
    // decline to run, and an accepted prompt installs nothing.
    const vol = Volume.fromJSON({ '/repos/ralph/.git/HEAD': 'ref: refs/heads/main\n' })
    const g = gate({
      ralphHome: '/repos/ralph',
      vol,
      handlers: { [VIEW_KEY]: semver(LATEST) },
      runUpdate: realUpdateFrom('/repos/ralph', vol),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ accepted: true, installed: false, installedVersion: null })
    expect(g.stdout.output()).toContain(`New version available: ${LATEST}`)
    expect(g.stdout.output()).not.toMatch(/\(run /)
    expect(g.stdout.output()).toContain('git pull')
    expect(g.exec.keys()).toEqual([VIEW_KEY, VIEW_KEY])
  })
})

describe('runUpdateGate — a classification it cannot use (#200 QA)', () => {
  // The gate reaches into a value it did not build, on a path that must never abort
  // `ralph start`. Every row here ends the same way: the version still prints, the
  // command is simply absent, and the channel falls back to npm — which is where every
  // layout but Homebrew installs from, so it is the right guess when there is no
  // layout to speak of.
  const hostile = () => {
    const target = {}
    Object.defineProperty(target, 'noticeLabel', {
      get() {
        throw new Error('hostile classification')
      },
    })
    return target
  }

  for (const [label, classify] of [
    ['throws', () => {
      throw new Error('classify exploded')
    }],
    ['rejects', async () => Promise.reject(new Error('classify exploded'))],
    ['answers null', async () => null],
    ['answers undefined', async () => undefined],
    ['answers a string', async () => 'global-brew'],
    ['answers a number', async () => 7],
    ['answers an empty object', async () => ({})],
    ['answers a label that is not a string', async () => ({ noticeLabel: 42, latest: null })],
    ['answers an empty label', async () => ({ noticeLabel: '', latest: null })],
    ['answers a hostile getter', async () => hostile()],
  ]) {
    it(`prints the version with no command when classify ${label}`, async () => {
      const g = gate({ handlers: { [VIEW_KEY]: semver(LATEST) }, classify, ask: async () => false })
      const verdict = await runUpdateGate(g)
      expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
      expect(g.stdout.lines()).toEqual([`New version available: ${LATEST}`])
      expect(g.exec.keys()).toEqual([VIEW_KEY])
    })
  }

  it('runs the loop anyway when the classification is unusable', async () => {
    // The gate's contract (#50) is that it is advice: a broken classification may cost
    // the user a command in a notice, never the run they actually started.
    const g = gate({
      handlers: { [VIEW_KEY]: semver(LATEST) },
      classify: () => {
        throw new Error('classify exploded')
      },
    })
    const verdict = await runUpdateGate(g)
    expect(Object.keys(verdict).sort()).toEqual([
      'accepted',
      'installed',
      'installedVersion',
      'isNewer',
      'latestVersion',
      'prompted',
    ])
  })
})

describe('runUpdateGate — what the answer leaves behind (#200 QA)', () => {
  // The chain past the gate: the weekly check WRITES its answer to the global version
  // cache, and `ralph doctor` reads that cache and never a channel of its own
  // (lib/commands/doctor.js imports nothing but `isValidSemver` from update-check.js).
  // So the cached "latest" is now whatever THIS install's channel reported, and every
  // later consumer of the cache inherits that. Before #200 it was always npm's.
  const cached = (g) =>
    readVersionCache({ fs: g.cacheFs, home: HOME, processEnv: {} }).latest_version

  it('caches the tap’s version on a Homebrew install, so `doctor` agrees with `update`', async () => {
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: { [VIEW_KEY]: semver('9.9.9'), [BREW_INFO_KEY]: brewInfo(LATEST) },
      ask: async () => false,
    })
    await runUpdateGate(g)
    expect(cached(g)).toBe(LATEST)
  })

  it('caches the registry’s version on an npm install, as it always did', async () => {
    const g = gate({
      ralphHome: NPM_RALPH,
      handlers: { [VIEW_KEY]: semver(LATEST), [BREW_INFO_KEY]: brewInfo('9.9.9') },
      ask: async () => false,
    })
    await runUpdateGate(g)
    expect(cached(g)).toBe(LATEST)
  })

  it('never reads a channel from `ralph doctor`’s side of the cache', () => {
    const doctor = codeWithoutComments(new URL('./commands/doctor.js', import.meta.url))
    expect(doctor).not.toMatch(/fetchLatestVersion/)
    expect(doctor).not.toMatch(/classifyInstall/)
    expect(doctor).not.toMatch(/npm['"`\s]*,?\s*\[?['"`]view/)
    expect(doctor).not.toMatch(/brew/i)
  })
})

describe('runUpdateGate — where the coordinate is spelled (#200 QA)', () => {
  it('MEASURED: `npm i -g` now ships in exactly one module', () => {
    // #199 measured this same set and found the notice was the last shipped line that
    // named npm to every install. Re-measured after #200: the string survives only in
    // lib/install-target.js, as the npm layout's own notice label, where a layout that
    // is not npm cannot reach it.
    //
    // Comments are stripped first: lib/banner-rows.js discusses `npm i -g` at length
    // in prose while its version row deliberately says `ralph update` (a 48-column box
    // — out of #200's scope), and a raw grep would read that discussion as a second
    // offender.
    const shipped = [
      './update-gate.js',
      './banner-rows.js',
      './commands/update.js',
      './install-target.js',
    ]
    const names = shipped.filter((rel) =>
      /npm i -g/.test(codeWithoutComments(new URL(rel, import.meta.url))),
    )
    expect(names).toEqual(['./install-target.js'])
    const banner = codeWithoutComments(new URL('./banner-rows.js', import.meta.url))
    expect(banner).toMatch(/ralph update/)
  })

  it('keeps the throttled run free of both the query and the classification’s cost', async () => {
    const g = gate({
      ralphHome: BREW_RALPH,
      handlers: { [BREW_INFO_KEY]: brewInfo(LATEST) },
      ask: async () => false,
      cacheFs: Volume.fromJSON(
        {
          [CACHE_PATH]: JSON.stringify({
            last_check_at: '2026-09-01T12:00:00.000Z',
            latest_version: LATEST,
            last_prompted_at: '2026-09-01T12:00:00.000Z',
          }),
        },
        '/',
      ),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST, prompted: false })
    expect(g.exec.keys()).toEqual([])
    expect(g.stdout.lines()).toEqual([
      `New version available: ${LATEST} (run brew upgrade ralph to update)`,
    ])
  })
})
