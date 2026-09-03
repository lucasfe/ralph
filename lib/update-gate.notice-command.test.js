import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { runUpdateGate } from './update-gate.js'
import { classifyInstall } from './install-target.js'
import { readVersionCache, versionCachePath } from './version-cache.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'

// #200: the weekly notice tells each user the command that applies to THEIR install.
//
// Before this, lib/update-gate.js printed one literal — `run npm i -g @lucasfe/ralph
// to update` — to every layout there is. On a Homebrew copy that is an instruction to
// plant a second install competing on PATH, and it is the most-seen wrong string
// Ralph has, since the notice prints on every `ralph start` and every `ralph cycle`
// that finds something newer.
//
// So the gate now classifies, and this file owns what that buys and what it costs:
//
//   - the notice's command comes from the classification (`noticeLabel`), so this
//     module spells no package coordinate of its own — asserted on the source, below;
//   - the weekly check queries the channel the same classification names, so a brew
//     user's notice is driven by the tap rather than by the registry;
//   - a layout with nothing to run (an npx run, a linked checkout) is offered no
//     command at all, because the accept path would refuse to run it;
//   - and none of it may cost a SPAWN. The classification is path-only (`exec: null`),
//     so the throttled run — the common case, 51 weeks out of 52 — still spawns
//     nothing whatsoever.
//
// The adversarial half (a hostile classification, the cross-channel transcripts, the
// cache the answer leaves behind) is in ./update-gate.channel.qa.test.js. The gate's
// own contract — verdict shape, TTY gate, stamp ordering, never-throws — stays in
// ./update-gate.test.js.
//
// Hermeticity (#41): `exec` is injected, the cache is memfs under a fake `home`,
// `isTTY` is explicit, and every run injects its layout through `classify` — the real
// `classifyInstall` would read RALPH_HOME, which in a vitest worker is this checkout
// (a `.git`, so: `linked`).

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '')

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const CURRENT = '0.15.6'
const LATEST = '0.16.0'

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const BREW_INFO = 'brew info --json=v2 ralph'
const NPM_ROOT = 'npm root -g'

const GLOBAL_ROOT = '/usr/local/lib/node_modules'
const LAYOUT_PATHS = {
  npm: `${GLOBAL_ROOT}/@lucasfe/ralph`,
  brew: '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph',
  pnpm: '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph',
  yarn: '/Users/me/.config/yarn/global/node_modules/@lucasfe/ralph',
  bun: '/Users/me/.bun/install/global/node_modules/@lucasfe/ralph',
  npx: '/Users/me/.npm/_npx/1a2b3c4d5e/node_modules/@lucasfe/ralph',
  linked: '/Users/me/repos/ralph',
  unknown: '/opt/hand-built/ralph',
}

// A REAL classification per layout, recorded so "classified once" and "classified
// never" are counts. `npm root -g` is answered from this closure rather than through
// the gate's `exec`, which is the production shape: the gate hands `classify` no exec
// at all, so a global npm install is the one layout it cannot name — and the layout
// whose notice and channel are npm's either way.
function makeClassify(layout, { fs = Volume.fromJSON({}), result } = {}) {
  const calls = []
  const classify = async (bag) => {
    calls.push(bag)
    if (result !== undefined) return typeof result === 'function' ? result() : result
    return classifyInstall({
      ralphHome: LAYOUT_PATHS[layout],
      exec: async () => ({ exitCode: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: '' }),
      fs,
    })
  }
  classify.calls = calls
  return classify
}

const linkedFs = () =>
  Volume.fromJSON({ '/Users/me/repos/ralph/.git/HEAD': 'ref: refs/heads/main\n' })

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
    formulae: [{ name: 'ralph', versions: { stable, head: 'HEAD', bottle: true } }],
    casks: [],
  }),
  stderr: '',
})

const bothChannels = { [NPM_VIEW]: semver(LATEST), [BREW_INFO]: brewInfo(LATEST) }

// The real decision, the real stamp and the real version query; the terminal, the
// clock, the cache, `exec` and the layout are injected. `ask` declines by default, so
// nothing here reaches `runUpdate` unless a test says so.
function gate({ handlers = bothChannels, layout = 'npm', classifyOptions, ...overrides } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    stdout,
    stderr,
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: false,
    exec: makeExec(handlers),
    classify: makeClassify(layout, classifyOptions),
    ask: async () => false,
    runUpdate: async () => ({ exitCode: 0, updated: false }),
    now: () => Date.parse('2026-09-03T12:00:00.000Z'),
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    ...overrides,
  }
}

const noticeOf = (g) => g.stdout.lines().find((l) => l.startsWith('New version available'))

describe('runUpdateGate — the notice names the layout’s own command (#200)', () => {
  it('tells a Homebrew install to run `brew upgrade`, and says nothing about npm', async () => {
    const g = gate({ layout: 'brew' })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
    // The user-visible harm, asserted directly rather than through the layout: a brew
    // user who follows this line must not end up with a second install on PATH.
    expect(g.stdout.output()).not.toMatch(/npm/)
  })

  it('is byte-identical to the pre-#200 line on an npm global install', async () => {
    const g = gate({ layout: 'npm' })
    await runUpdateGate(g)
    expect(g.stdout.lines()).toEqual([
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    ])
  })

  for (const [layout, command] of [
    ['pnpm', 'pnpm add -g @lucasfe/ralph@latest'],
    ['yarn', 'yarn global add @lucasfe/ralph@latest'],
    ['bun', 'bun add -g @lucasfe/ralph@latest'],
  ]) {
    it(`tells a ${layout} global install to run its own global add`, async () => {
      const g = gate({ layout })
      await runUpdateGate(g)
      expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run ${command} to update)`)
      expect(noticeOf(g)).not.toMatch(/npm i|npm install/)
    })
  }

  it('offers an unrecognized layout the command `ralph update` names by hand', async () => {
    const g = gate({ layout: 'unknown' })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    )
  })

  for (const [layout, options] of [
    ['npx', undefined],
    ['linked', { fs: linkedFs() }],
  ]) {
    it(`offers a ${layout} layout no command at all`, async () => {
      // Criterion: the notice must not name a command the accept path would then
      // refuse to run. Both refusals carry `advice` instead — which `ralph update`
      // prints, on the run the user asked for.
      const g = gate({ layout, classifyOptions: options })
      await runUpdateGate(g)
      expect(noticeOf(g)).toBe(`New version available: ${LATEST}`)
      expect(g.stdout.output()).not.toMatch(/\(run /)
      expect(g.stdout.output()).not.toMatch(/npm|brew|git pull/)
    })
  }

  it('still prints the version — the notice is the point, the command is the help', async () => {
    const g = gate({ layout: 'npx' })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
    expect(g.stdout.lines()).toHaveLength(1)
  })
})

describe('runUpdateGate — the weekly check asks the channel the layout names (#200)', () => {
  it('asks the TAP on a Homebrew install, and nothing else', async () => {
    const g = gate({ layout: 'brew', handlers: { [BREW_INFO]: brewInfo(LATEST) } })
    const verdict = await runUpdateGate(g)
    expect(g.exec.keys()).toEqual([BREW_INFO])
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
  })

  it('asks the REGISTRY on an npm install, exactly as it always did', async () => {
    const g = gate({ layout: 'npm', handlers: { [NPM_VIEW]: semver(LATEST) } })
    const verdict = await runUpdateGate(g)
    expect(g.exec.keys()).toEqual([NPM_VIEW])
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
  })

  it('drives a brew notice from the tap’s version, not the registry’s', async () => {
    // The two channels disagree: the tap has 0.16.0, npm has 9.9.9. A Homebrew user
    // must be told what brew can actually install.
    const g = gate({
      layout: 'brew',
      handlers: { [BREW_INFO]: brewInfo(LATEST), [NPM_VIEW]: semver('9.9.9') },
    })
    await runUpdateGate(g)
    expect(noticeOf(g)).toContain(LATEST)
    expect(g.stdout.output()).not.toContain('9.9.9')
    expect(g.exec.keys()).toEqual([BREW_INFO])
  })

  it('notices a release the tap has and the registry does not', async () => {
    // #196's tap exists so a refused `npm publish` cannot stop a release from being
    // installable. Before #200 this run printed nothing at all.
    const g = gate({
      layout: 'brew',
      handlers: { [BREW_INFO]: brewInfo(LATEST), [NPM_VIEW]: semver(CURRENT) },
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })

  it('caches the tap’s answer, so `ralph doctor` reads the same channel', async () => {
    const g = gate({ layout: 'brew', handlers: { [BREW_INFO]: brewInfo(LATEST) } })
    await runUpdateGate(g)
    const cache = readVersionCache({ fs: g.cacheFs, home: HOME, processEnv: {} })
    expect(cache.latest_version).toBe(LATEST)
  })
})

describe('runUpdateGate — classifying costs no subprocess (#200)', () => {
  it('hands `classify` no exec, so it cannot spawn `npm root -g`', async () => {
    const g = gate({ layout: 'npm' })
    await runUpdateGate(g)
    expect(g.classify.calls).toHaveLength(1)
    expect(Object.keys(g.classify.calls[0])).toEqual(['exec'])
    expect(g.classify.calls[0].exec).toBeNull()
    expect(g.exec.keys()).not.toContain(NPM_ROOT)
  })

  it('classifies once per run, however many answers it needs', async () => {
    // The channel and the notice come from the SAME classification: two consumers,
    // one probe of the filesystem.
    const g = gate({ layout: 'brew', handlers: { [BREW_INFO]: brewInfo(LATEST) } })
    await runUpdateGate(g)
    expect(g.classify.calls).toHaveLength(1)
    expect(noticeOf(g)).toContain('brew upgrade ralph')
  })

  it('spawns NOTHING on a throttled run, and still names the layout’s command', async () => {
    // Criterion 7, the sharp one: the cached path is the common case, and it must stay
    // exactly as cheap as it was before #200.
    const g = gate({
      layout: 'brew',
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
    expect(g.exec.calls).toEqual([])
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST, prompted: false })
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })

  it('classifies nothing at all when a throttled run has nothing to say', async () => {
    const g = gate({
      layout: 'brew',
      currentVersion: LATEST,
      cacheFs: Volume.fromJSON(
        {
          [CACHE_PATH]: JSON.stringify({
            last_check_at: '2026-09-01T12:00:00.000Z',
            latest_version: LATEST,
            last_prompted_at: null,
          }),
        },
        '/',
      ),
    })
    await runUpdateGate(g)
    expect(g.classify.calls).toHaveLength(0)
    expect(g.exec.calls).toEqual([])
    expect(g.stdout.output()).toBe('')
  })

  it('classifies nothing on the RALPH_NO_UPDATE_CHECK opt-out', async () => {
    const g = gate({ layout: 'brew', processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const verdict = await runUpdateGate(g)
    expect(g.classify.calls).toHaveLength(0)
    expect(g.exec.calls).toEqual([])
    expect(verdict.isNewer).toBe(false)
    expect(g.stdout.output()).toBe('')
  })

  it('adds no spawn to the run that installs, either', async () => {
    // An accepted prompt classifies AGAIN inside `updateCommand` — which is where the
    // probe belongs, since that is the run a user asked for and the one that needs the
    // runnable argv. The gate's own classification adds nothing to it.
    const g = gate({
      layout: 'brew',
      handlers: { [BREW_INFO]: brewInfo(LATEST) },
      isTTY: true,
      ask: async () => true,
      runUpdate: async () => ({ exitCode: 0, updated: true, to: LATEST }),
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ accepted: true, installed: true, installedVersion: LATEST })
    expect(g.exec.keys()).toEqual([BREW_INFO])
    expect(g.classify.calls).toHaveLength(1)
  })
})

describe('runUpdateGate — the coordinate lives where the layout does (#200)', () => {
  it('spells no package name, no manager and no channel of its own', async () => {
    // The reversal of #199's source-purity pin: the gate used to be asserted to hold
    // NO classification, because the tradeoff was that it stayed on npm. What must be
    // true now is the opposite — it reaches for a classification and holds no
    // coordinate — so a future edit that hardcodes a command again fails here.
    const code = codeWithoutComments(new URL('./update-gate.js', import.meta.url))
    expect(code).toMatch(/classifyInstall/)
    expect(code).not.toMatch(/@lucasfe/)
    expect(code).not.toMatch(/npm/i)
    expect(code).not.toMatch(/brew/i)
  })

  it('takes the notice command from the classification, not from a table of its own', async () => {
    // An invented layout with an invented command: the notice follows it, so nothing
    // in the gate is matching on `kind` or holding a per-manager literal.
    const g = gate({
      layout: 'npm',
      classifyOptions: {
        result: { kind: 'global-frobnicator', argv: ['frob', 'up'], label: 'frob up', noticeLabel: 'frob up', reason: 'frobbed', advice: null, latest: undefined },
      },
      handlers: { [NPM_VIEW]: semver(LATEST) },
    })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run frob up to update)`)
  })
})
