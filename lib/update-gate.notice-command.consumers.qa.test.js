import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { startCommand } from './commands/start.js'
import { cycleCommand } from './commands/cycle.js'
import { classifyInstall } from './install-target.js'
import { versionCachePath } from './version-cache.js'
import { codeWithoutComments } from '../test/helpers/source-code.js'

// #200 QA augmentation — that `ralph start` and `ralph cycle` actually FORWARD the
// classification, asserted where the gate's own default cannot answer for them.
//
// The gap this file exists for: both commands take `classify` with no default, so an
// omitted forward is invisible. `runUpdateGate` defaults it to the real
// `classifyInstall`, which in a vitest worker classifies this checkout as `linked` —
// so a suite that injects a layout but asserts only the `New version available` PREFIX
// passes either way. start.update-prompt.qa.test.js and start.prompt-window.qa.test.js
// are that shape. Start's forward is not wholly unpinned, though: MEASURED —
// start.update-check.qa.test.js:210 asserts `toContain('npm i -g @lucasfe/ralph')`, the
// command bytes and not the prefix, and `linked` carries `noticeLabel: null`, so
// deleting `classify,` from start.js's runUpdateGate bag turns that one assertion red.
// What is missing is a suite that says so on purpose: one incidental assertion, in a
// file about something else, is the whole of the coverage, and it pins only the npm
// label — which the default could also produce on an npm machine. `ralph cycle`'s side
// is covered the same accidental way, by notice suites comparing a full NOTICE_LINE.
//
// So the classification injected here is one NO classifier can return: an invented
// manager, with an invented notice command and an invented channel. Both of its answers
// are asserted — the command in the notice and the argv in the spawn list — which makes
// a dropped forward a red test on both counts, on any machine, in a checkout or in an
// installed copy.
//
// The three claims below, in order:
//   1. each command forwards the classification it was handed, and hands the gate no
//      spawner of its own with it (`{ exec: null }` is the only bag `classify` ever sees,
//      which is what keeps a background notice free of a subprocess);
//   2. the two commands produce the notice byte-identically, run side by side rather
//      than compared to a constant — #50's shared-gate property, now with the layout
//      inside it;
//   3. an OMITTED forward reaches the gate's own default, asserted as agreement with
//      `classifyInstall({ exec: null })` rather than as a layout, so it holds wherever
//      the suite runs.
//
// What is NOT re-tested here: the notice's own text and edges, the memo, the channel
// per layout (lib/update-gate.notice-command.test.js, .qa.test.js and
// lib/update-gate.channel.qa.test.js), the placement of the gate inside each command,
// the prompt window and everything else in the two commands' update slices.

const REPO = '/repo'
const REPO_SLUG = 'lucasfe/ralph'
const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const T0 = Date.parse('2026-08-22T12:00:00.000Z')

const CURRENT = '0.1.0'
const LATEST = '0.2.0'
const NPM_VIEW = 'npm view @lucasfe/ralph version'

// The invented layout. Nothing in lib/install-target.js can produce `global-frob`, so
// every assertion about it is an assertion about the FORWARD and not about the machine.
const FROB_LABEL = 'frob up --self'
const FROB_ARGV = ['frob', 'latest', 'ralph']
const FROB_KEY = FROB_ARGV.join(' ')
const FROB_NOTICE = `New version available: ${LATEST} (run ${FROB_LABEL} to update)`

function frobLayout() {
  const classify = async (bag) => {
    classify.calls.push(bag)
    return {
      kind: 'global-frob',
      argv: ['frob', 'up', '--self'],
      label: FROB_LABEL,
      noticeLabel: FROB_LABEL,
      reason: 'an invented manager, so only a forwarded classification can produce it',
      advice: null,
      latest: { argv: FROB_ARGV, format: 'semver-line', unreachable: 'frob unreachable?' },
    }
  }
  classify.calls = []
  return classify
}

const strip = (s) => String(s).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')

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

// One exec for both commands, matched on cmd/args rather than on key strings: the two
// preflights spawn different things, and the only calls these tests assert on are the
// version queries. Unknown keys exit 0, so the tmux launch and the queue count need no
// handler of their own.
function makeExec({ frob = LATEST, npm = LATEST } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push(`${cmd} ${args.join(' ')}`)
    if (cmd === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: `${REPO}\n`, stderr: '' }
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'repo') return { exitCode: 0, stdout: `${REPO_SLUG}\n`, stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue') return { exitCode: 0, stdout: '1', stderr: '' }
    if (cmd === 'frob') return { exitCode: 0, stdout: `${frob}\n`, stderr: '', timedOut: false }
    if (cmd === 'npm' && args[0] === 'view') {
      return { exitCode: 0, stdout: `${npm}\n`, stderr: '', timedOut: false }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.versionQueries = () => calls.filter((c) => c === FROB_KEY || c === NPM_VIEW)
  return exec
}

// A non-interactive run of each command that reaches the gate and stops at the notice:
// `stdin` has no TTY, so #25's question is off and nothing here can construct a
// readline. Every seam is injected and the cache is memfs (#41).
function startDeps(overrides = {}, execOptions = {}) {
  const stdout = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr: makeStream(),
    stdin: { isTTY: false },
    isTTY: false,
    exec: makeExec(execOptions),
    exists: () => false,
    loadEnv: () => ({}),
    readFile: () => '',
    hasCommand: () => true,
    ask: async () => false,
    peekLock: () => null,
    sendWa: async () => ({ ok: true }),
    now: () => T0,
    currentVersion: CURRENT,
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    classify: frobLayout(),
    ...overrides,
  }
}

function cycleDeps(overrides = {}, execOptions = {}) {
  const stdout = makeStream()
  return {
    cwd: REPO,
    stdout,
    stderr: makeStream(),
    stdin: { isTTY: false },
    isTTY: false,
    exec: makeExec(execOptions),
    exists: () => true,
    readFile: () => '',
    loadEnv: () => ({ CALLMEBOT_KEY: 'k', WHATSAPP_PHONE: '+1' }),
    acquireLock: () => ({
      acquired: true,
      holder: { pid: 1, startedAt: new Date(T0).toISOString(), repoPath: REPO },
    }),
    releaseLock: () => {},
    findOrphans: async () => [],
    cleanupOrphans: async () => [],
    sendWa: async () => ({ ok: true }),
    pingSuccess: async () => ({ ok: true }),
    pingFail: async () => ({ ok: true }),
    runQueueOnce: async () => ({ successes: [], failures: [] }),
    now: () => T0,
    currentVersion: CURRENT,
    home: HOME,
    processEnv: {},
    cacheFs: new Volume(),
    classify: frobLayout(),
    ...overrides,
  }
}

const COMMANDS = [
  ['ralph start', startDeps, startCommand],
  ['ralph cycle', cycleDeps, cycleCommand],
]

const noticeOf = (d) => d.stdout.lines().find((l) => l.includes('New version available'))

describe('the update notice names the layout its CALLER named (#200 QA)', () => {
  for (const [name, deps, command] of COMMANDS) {
    it(`${name} forwards the classification into the notice`, async () => {
      const d = deps()
      await command(d)
      expect(noticeOf(d)).toBe(FROB_NOTICE)
    })

    it(`${name} forwards it into the channel the weekly check asks`, async () => {
      // The other half of the same forward, and the half no existing suite could see:
      // the npm registry is what a dropped `classify` falls back to on this machine, so
      // "the query went to frob" is what proves the layout arrived.
      const d = deps()
      await command(d)
      expect(d.exec.versionQueries()).toEqual([FROB_KEY])
      expect(d.exec.calls).not.toContain(NPM_VIEW)
    })

    it(`${name} classifies once, and hands it no way to spawn anything`, async () => {
      // `{ exec: null }` is the gate's contract with the classifier, and a command that
      // "helpfully" passed its own `exec` through would restore the `npm root -g` probe
      // on every run — the cost #200 was designed around.
      const d = deps()
      await command(d)
      expect(d.classify.calls).toEqual([{ exec: null }])
    })

    it(`${name} caches the version the named channel answered`, async () => {
      // What `ralph doctor` and the next six days of runs will read. It has to be the
      // frob answer, not the registry's — the two are different here on purpose.
      const d = deps({}, { frob: LATEST, npm: '9.9.9' })
      await command(d)
      const cache = JSON.parse(d.cacheFs.readFileSync(CACHE_PATH, 'utf8').toString())
      expect(cache).toMatchObject({
        latest_version: LATEST,
        last_check_at: new Date(T0).toISOString(),
      })
    })
  }

  it('prints the byte-identical notice from both commands', async () => {
    // Run side by side rather than against a constant, the same idiom
    // cycle.update-notice.test.js uses for the pre-#200 line: #50's shared gate means
    // the two cannot drift, and #200 put the layout inside that shared policy — so the
    // one thing that must not appear is a command-specific notice.
    const s = startDeps()
    const c = cycleDeps()
    await startCommand(s)
    await cycleCommand(c)
    const startNotices = s.stdout.lines().filter((l) => l.includes('New version available'))
    expect(startNotices).toHaveLength(1)
    expect(c.stdout.lines().filter((l) => l.includes('New version available'))).toEqual(startNotices)
  })
})

describe('an omitted classification reaches the gate’s own default (#200 QA)', () => {
  for (const [name, deps, command] of COMMANDS) {
    it(`${name} leaves the default to runUpdateGate, not to a default of its own`, async () => {
      // Asserted as AGREEMENT with `classifyInstall({ exec: null })` — the gate's
      // documented default, driven the way the gate drives it — rather than as a
      // particular layout: this checkout classifies `linked` (a `.git`, so no command at
      // all), an installed copy would name one, and the claim has to hold for both.
      //
      // This is the one test in the file that lets the real classifier read the real
      // filesystem, because that is precisely what is being pinned. It spawns nothing:
      // the probe `classifyInstall` would fall back to is `npm root -g`, and the gate
      // withholds the spawner it needs.
      const target = await classifyInstall({ exec: null })
      const expected = target?.noticeLabel
        ? `New version available: ${LATEST} (run ${target.noticeLabel} to update)`
        : `New version available: ${LATEST}`
      const expectedQuery = (target?.latest?.argv ?? []).join(' ') || NPM_VIEW

      const d = deps()
      delete d.classify
      await command(d)
      expect(noticeOf(d)).toBe(expected)
      expect(d.exec.versionQueries()).toEqual([expectedQuery])
      expect(d.exec.calls).not.toContain('npm root -g')
    })
  }
})

describe('neither command spells a classifier or a coordinate of its own (#200 QA)', () => {
  const FILES = {
    'start.js': new URL('./commands/start.js', import.meta.url),
    'cycle.js': new URL('./commands/cycle.js', import.meta.url),
  }

  for (const [name, url] of Object.entries(FILES)) {
    it(`${name} names no classifier, so the gate's default stays the only one`, () => {
      // The comment in each file says "no default here so an undefined value reaches
      // runUpdateGate's OWN default (classifyInstall)". Measured: neither module imports
      // install-target.js and neither one spells the function, so there is nowhere for a
      // second default to hide. Comments are stripped first — both files DISCUSS
      // `classifyInstall` in prose, which is the point of the sweep helper.
      const code = codeWithoutComments(url)
      expect(code).toMatch(/classify,/)
      expect(code).not.toMatch(/classifyInstall/)
      expect(code).not.toMatch(/install-target/)
    })

    it(`${name} names no update command of its own`, () => {
      // #200's coordinate lives in lib/install-target.js. A command that spelled
      // `npm i -g` or `brew upgrade` here would be a second answer to the question the
      // classification now answers — and the notice it printed would be right for
      // whichever layout the author happened to be on.
      const code = codeWithoutComments(url)
      expect(code).not.toMatch(/npm i -g/)
      expect(code).not.toMatch(/brew upgrade/)
    })
  }
})
