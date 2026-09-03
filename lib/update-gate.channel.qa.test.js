import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { runUpdateGate } from './update-gate.js'
import { updateCommand } from './commands/update.js'
import { classifyInstall } from './install-target.js'
import { readVersionCache, versionCachePath } from './version-cache.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'

// #199 QA augmentation — the CROSS-CONSUMER half of "ask the channel this copy came
// from". #199 changed `ralph update`; the weekly background check in
// `resolveUpdateDecision` was deliberately left on the npm default, and
// lib/update-gate.js is where that decision meets a real install.
//
// So this file is about the SEAM BETWEEN THE TWO CHANNELS, which no single-module
// test can see:
//
//   - the gate's notice must stay on npm. Not because npm is right for a Homebrew
//     user, but because the alternative — classifying inside `ralph start` — adds a
//     spawn to a path whose whole point is to cost nothing. A later change that
//     silently made `ralph start` spawn `brew` would be a regression against a
//     documented tradeoff, so it gets a test rather than a comment.
//   - the notice and the install can therefore name DIFFERENT channels in one
//     transcript: npm decides whether to nag, the tap decides what happens when the
//     user says yes. All three outcomes of that pair (agree, npm ahead, tap ahead)
//     are pinned below, because each one is a user-visible consequence of the
//     tradeoff rather than a bug in either module.
//
// Not re-tested here: the gate's own contract (verdict shape, TTY gate, stamp
// ordering, never-throws, and the exact bags it forwards) is owned by
// lib/update-gate.test.js and lib/update-gate.qa.test.js.
//
// Hermeticity (#41): `exec` is injected, the cache is memfs under a fake `home`,
// `isTTY` is passed explicitly (it is undefined on a vitest worker, so a defaulted
// gate never prompts and every prompt assertion would be vacuous), and the one place
// that needs an install layout injects a memfs volume through its own classify.

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '')

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const CURRENT = '0.15.6'
const LATEST = '0.16.0'
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

const VIEW_KEY = 'npm view @lucasfe/ralph version'
const ROOT_KEY = 'npm root -g'
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

// `runUpdate` stands in for the ONE thing production supplies that a test cannot:
// the real install directory. The gate calls `updateCommand({currentVersion, exec,
// stdout, stderr})` and forwards no install path at all (pinned in
// lib/update-gate.test.js), so `classifyInstall` falls back to its own RALPH_HOME
// default — which is exactly what makes an accepted prompt update through the
// channel the running copy came from. This wrapper supplies that path, plus the fs
// the real one would read, and is otherwise the production seam.
const realUpdateFrom = (ralphHome, vol = Volume.fromJSON({})) => (bag) =>
  updateCommand({
    ...bag,
    ralphHome,
    classify: (opts) => classifyInstall({ ...opts, fs: vol }),
  })

// A gate whose decision, stamp, prompt-window and version query are all the real
// ones — the injected seams are the terminal, the clock, the cache and `exec`.
function gate({ handlers = {}, ...overrides } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    stdout,
    stderr,
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: true,
    exec: makeExec(handlers),
    ask: async () => true,
    now: () => Date.parse('2026-09-03T12:00:00.000Z'),
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
  }
}

describe('runUpdateGate — the weekly notice stays on npm (#199 QA)', () => {
  it('spawns the npm query and nothing else, with the same bounded options as before', async () => {
    // The regression guard the tradeoff needs: `ralph start`'s background check
    // classifies nothing, so it must never grow a `brew` (or `npm root -g`) spawn.
    const g = gate({ handlers: { [VIEW_KEY]: semver(LATEST) }, ask: async () => false })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST, installed: false })
    expect(g.exec.keys()).toEqual([VIEW_KEY])
    expect(g.exec.calls[0].options).toEqual({ timeout: 5000, reject: false })
  })

  it('ignores an install path even when a caller invents one', async () => {
    // There is no `ralphHome` seam on the gate, deliberately. Passing one must not
    // start a classification through a back door.
    const g = gate({
      handlers: { [VIEW_KEY]: semver(LATEST) },
      ralphHome: BREW_RALPH,
      ask: async () => false,
    })
    await runUpdateGate(g)
    expect(g.exec.keys()).toEqual([VIEW_KEY])
  })

  it('keeps the check on npm on a throttled run too — by making no query at all', async () => {
    const g = gate({
      handlers: { [VIEW_KEY]: semver(LATEST) },
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
      ask: async () => false,
    })
    const verdict = await runUpdateGate(g)
    // The notice still prints from the cached version; no channel is asked anything.
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST, prompted: false })
    expect(g.exec.keys()).toEqual([])
  })

  it('does not know how to reach for a channel at all', () => {
    // Source-level, the same idiom test/homebrew-formula.test.js uses for the
    // renderer's purity: the gate holds no classification and no channel of its own,
    // so a future "fix" has to be a deliberate edit here rather than a drift.
    const code = codeWithoutComments(new URL('./update-gate.js', import.meta.url))
    expect(code).not.toMatch(/install-target/)
    expect(code).not.toMatch(/classifyInstall/)
    expect(code).not.toMatch(/brew/i)
    expect(code).not.toMatch(/fetchLatestVersion/)
    expect(code).not.toMatch(/ralphHome/)
  })
})

describe('runUpdateGate — the notice and the install can name different channels (#199 QA)', () => {
  it('installs through the tap when both channels agree', async () => {
    // The ordinary Homebrew case end to end: npm decides there is something to say,
    // the tap decides what actually runs. `installedVersion` comes from the TAP's
    // answer, because it is `updateCommand`'s `to`.
    const g = gate({
      handlers: {
        [VIEW_KEY]: semver(LATEST),
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
    expect(g.exec.keys()).toEqual([VIEW_KEY, BREW_INFO_KEY, BREW_UPGRADE_KEY])
    expect(g.exec.keys()).not.toContain(ROOT_KEY)
  })

  it('DOCUMENTED: npm ahead of the tap nags, then correctly does nothing', async () => {
    // The accepted tradeoff's user-visible shape. The notice comes from npm, which
    // has 0.16.0; the tap has only what is installed, so the accepted update reports
    // "already up to date" and the verdict says nothing landed. The caller then keeps
    // running the version it started with — which is right, since there is nothing to
    // install — and the cost is one nag the user cannot act on until the tap catches
    // up. Closing it means threading a classification into the gate (named in
    // lib/update-check.js's own comment), not changing anything here.
    const g = gate({
      handlers: { [VIEW_KEY]: semver(LATEST), [BREW_INFO_KEY]: brewInfo(CURRENT) },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({
      isNewer: true,
      latestVersion: LATEST,
      accepted: true,
      installed: false,
      installedVersion: null,
    })
    expect(g.exec.keys()).toEqual([VIEW_KEY, BREW_INFO_KEY])
    expect(g.stdout.output()).toContain(`New version available: ${LATEST}`)
    expect(g.stdout.output()).toMatch(/already up to date/i)
  })

  it('DOCUMENTED: a tap ahead of npm is never noticed by `ralph start` at all', async () => {
    // The residual #199 gap, stated where it lives. #196's tap is meant to make a
    // release installable even when `npm publish` is refused — and for as long as the
    // registry sits behind, this check compares against the registry, prints nothing,
    // and never asks the tap. A Homebrew user in that state finds the new version by
    // running `ralph update`, which does ask the tap.
    const g = gate({
      handlers: { [VIEW_KEY]: semver(CURRENT), [BREW_INFO_KEY]: brewInfo(LATEST) },
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
    expect(g.exec.keys()).toEqual([VIEW_KEY])
    expect(g.stdout.output()).toBe('')
  })

  it('survives a tap that cannot be read after an npm-driven notice', async () => {
    // Two channels, one transcript: the notice names npm, the failure names the tap.
    // Both are accurate about the channel they came from, and the run is not lost.
    const g = gate({
      handlers: {
        [VIEW_KEY]: semver(LATEST),
        [BREW_INFO_KEY]: { exitCode: 1, stdout: '', stderr: 'Error: No available formula' },
      },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ accepted: true, installed: false, installedVersion: null })
    expect(g.stderr.output()).toContain(
      '❌ Could not read the latest published version (the Homebrew tap could not be read?).',
    )
    expect(g.stdout.output()).toContain(`New version available: ${LATEST}`)
    expect(g.stdout.output()).toContain('update by hand: brew upgrade ralph')
    expect(g.exec.keys()).toEqual([VIEW_KEY, BREW_INFO_KEY])
  })

  it('is unchanged for an npm install: one channel, one query, one install', async () => {
    // The control row. A global npm install pays `npm root -g` for the
    // classification and asks the registry twice — once for the notice, once inside
    // the update — which is what it did before #199 as well.
    const g = gate({
      handlers: {
        [VIEW_KEY]: semver(LATEST),
        [ROOT_KEY]: { exitCode: 0, stdout: '/usr/local/lib/node_modules\n', stderr: '' },
        'npm install -g @lucasfe/ralph@latest': { exitCode: 0, stdout: '', stderr: '' },
      },
      runUpdate: realUpdateFrom('/usr/local/lib/node_modules/@lucasfe/ralph'),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ installed: true, installedVersion: LATEST })
    expect(g.exec.keys()).toEqual([
      VIEW_KEY,
      ROOT_KEY,
      VIEW_KEY,
      'npm install -g @lucasfe/ralph@latest',
    ])
  })

  it('refuses to install over a linked checkout, whatever channel noticed', async () => {
    // The refusal outranks the notice: an accepted prompt on a dev checkout still
    // installs nothing, and the verdict says so.
    const vol = Volume.fromJSON({ '/repos/ralph/.git/HEAD': 'ref: refs/heads/main\n' })
    const g = gate({
      handlers: { [VIEW_KEY]: semver(LATEST) },
      runUpdate: realUpdateFrom('/repos/ralph', vol),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ accepted: true, installed: false, installedVersion: null })
    expect(g.stdout.output()).toContain('git pull')
    expect(g.exec.keys()).toEqual([VIEW_KEY, VIEW_KEY])
  })
})

describe('runUpdateGate — what the npm answer leaves behind (#199 QA)', () => {
  // The chain past the gate: the weekly check WRITES its answer to the global
  // version cache, and `ralph doctor` reads that cache (never a channel of its own —
  // lib/commands/doctor.js imports nothing but `isValidSemver` from update-check.js).
  // So on a Homebrew install the cached "latest" is the registry's version, and every
  // later consumer of the cache inherits the npm channel. That is the tradeoff's
  // reach, and it is worth having written down where a change would break it.
  const cached = (g) =>
    readVersionCache({ fs: g.cacheFs, home: HOME, processEnv: {} }).latest_version

  it('caches npm’s version, not the tap’s, when npm is ahead', async () => {
    const g = gate({
      handlers: { [VIEW_KEY]: semver(LATEST), [BREW_INFO_KEY]: brewInfo(CURRENT) },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    await runUpdateGate(g)
    expect(cached(g)).toBe(LATEST)
  })

  it('caches npm’s version, not the tap’s, when the tap is ahead', async () => {
    // The consequence worth naming: the tap's 0.16.0 is never written anywhere, so a
    // `ralph doctor` run right after this reports 0.15.6 as the latest known version
    // on a machine where `ralph update` would install 0.16.0.
    const g = gate({
      handlers: { [VIEW_KEY]: semver(CURRENT), [BREW_INFO_KEY]: brewInfo(LATEST) },
      runUpdate: realUpdateFrom(BREW_RALPH),
    })
    await runUpdateGate(g)
    expect(cached(g)).toBe(CURRENT)
  })

  it('never reads a channel from `ralph doctor`’s side of the cache', () => {
    const doctor = codeWithoutComments(new URL('./commands/doctor.js', import.meta.url))
    expect(doctor).not.toMatch(/fetchLatestVersion/)
    expect(doctor).not.toMatch(/classifyInstall/)
    expect(doctor).not.toMatch(/npm['"`\s]*,?\s*\[?['"`]view/)
    expect(doctor).not.toMatch(/brew/i)
  })
})

describe('runUpdateGate — the by-hand command in the notice (#199 QA)', () => {
  it('prints the #24 notice byte for byte', async () => {
    const g = gate({ handlers: { [VIEW_KEY]: semver(LATEST) }, ask: async () => false })
    await runUpdateGate(g)
    expect(g.stdout.lines()).toEqual([
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    ])
  })

  it('MEASURED: the notice is the last shipped line that names npm to every install', () => {
    // #199 made `ralph update`'s by-hand hint follow the channel; this notice still
    // names `npm i -g` unconditionally, so a Homebrew user is told to run npm here
    // and `brew upgrade ralph` there. Out of #199's scope by the same reasoning that
    // keeps the query on npm — the gate has no classification — and recorded as a
    // measurement rather than a claim, so a follow-up has something to point at.
    //
    // Comments are stripped first: lib/banner-rows.js discusses `npm i -g` at length
    // in prose while its version row deliberately says `ralph update`, and a raw grep
    // would read that discussion as a second offender.
    const shipped = ['./update-gate.js', './banner-rows.js', './commands/update.js']
    const names = shipped.filter((rel) =>
      /npm i -g/.test(codeWithoutComments(new URL(rel, import.meta.url))),
    )
    expect(names).toEqual(['./update-gate.js'])
    const banner = codeWithoutComments(new URL('./banner-rows.js', import.meta.url))
    expect(banner).toMatch(/ralph update/)
  })
})
