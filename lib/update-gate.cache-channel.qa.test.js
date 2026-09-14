import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { runUpdateGate } from './update-gate.js'
import { classifyInstall } from './install-target.js'
import { readVersionCache, versionCachePath } from './version-cache.js'

// QA #215 — the harmful direction, end to end, asserted on the BYTES A USER READS.
//
// The issue was reported as a printed line, so the fix has to be checked as one. Every case
// here drives the real `runUpdateGate` with the real `resolveUpdateDecision`, the real
// `readVersionCache`, the real `classifyInstall` and the real notice write, over one memfs
// cache file that two "copies" of Ralph share — which is the machine from the report: nvm/npm
// at 0.25.4 beside a Homebrew install, both writing `~/.config/ralph/update-check.json`.
//
// The decision object is not the deliverable. `lib/update-check.cache-channel.qa.test.js`
// covers that; what this file asserts is that no run prints a version its own channel cannot
// install, and — the direction the issue calls harmful — that no run prints npm's number
// beside `npm i -g @lucasfe/ralph`, a command that would then install something older.
//
// It also pins the two costs of the change that moved channel resolution above the throttle
// branch: the throttled run must still SPAWN NOTHING and classify AT MOST ONCE, and a
// classification that never answers must not take the run with it.
//
// Hermetic: injected terminal, clock, cache fs and layout path. No spawner is ever handed to
// `classify`, which is production's shape (lib/update-gate.js:128 passes `exec: null`).

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '')

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const T0 = Date.parse('2026-09-14T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const CURRENT = '0.25.4'

// The two layouts on the reported machine, as install PATHS — so the classification under
// test is the real one rather than a stub's idea of it.
const LAYOUT_PATHS = {
  npm: '/usr/local/lib/node_modules/@lucasfe/ralph',
  brew: '/opt/homebrew/Cellar/ralph/0.26.0/libexec/lib/node_modules/@lucasfe/ralph',
}

const NPM_NOTICE = 'npm i -g @lucasfe/ralph'
const BREW_NOTICE = 'brew upgrade ralph'

// A cache file inside the weekly window — the throttled path, which is where a cached number
// is SERVED and 51 runs out of 52 land.
const throttledCache = (over = {}) =>
  JSON.stringify({
    last_check_at: new Date(T0 - DAY).toISOString(),
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
    output: () => strip(chunks.join('')),
    lines: () => strip(chunks.join('')).split('\n').filter(Boolean),
  }
}

// The real classification for a layout, with the bag the gate handed over recorded so
// "classified once, with no spawner" is a count rather than a claim. `bag.exec` is forwarded
// unchanged — production passes null, and forwarding it is what makes an npm install classify
// the way it really does on a background run (`unknown`, npm's notice, npm's query).
function makeClassify(layout, { result } = {}) {
  const calls = []
  const classify = async (bag) => {
    calls.push(bag)
    if (result !== undefined) return typeof result === 'function' ? result() : result
    return classifyInstall({
      ralphHome: LAYOUT_PATHS[layout] ?? layout,
      exec: bag?.exec,
      fs: Volume.fromJSON({}),
    })
  }
  classify.calls = calls
  return classify
}

function makeExec() {
  const calls = []
  const exec = async (cmd, args = []) => {
    calls.push(`${cmd} ${args.join(' ')}`)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

// One run of the gate as one of the two copies. `ask` declines and `isTTY` is false, so
// nothing here installs anything; the notice is the whole subject.
function run({ layout = 'npm', cache = throttledCache(), classifyOptions, ...over } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  const exec = makeExec()
  const cacheFs = Volume.fromJSON(cache === null ? {} : { [CACHE_PATH]: cache }, '/')
  const classify = over.classify ?? makeClassify(layout, classifyOptions)
  const args = {
    currentVersion: CURRENT,
    stdout,
    stderr,
    stdin: { isTTY: false },
    isTTY: false,
    exec,
    classify,
    ask: async () => false,
    runUpdate: async () => ({ exitCode: 0, updated: false }),
    now: () => T0,
    home: HOME,
    processEnv: {},
    cacheFs,
    ...over,
  }
  return {
    stdout,
    stderr,
    exec,
    classify,
    cacheFs,
    verdict: runUpdateGate(args),
    fileNow: () => readVersionCache({ fs: cacheFs, home: HOME, processEnv: {} }),
  }
}

const noticeOf = (stdout) => stdout.lines().find((l) => l.startsWith('New version available'))

describe('QA #215 the harmful direction, as printed output', () => {
  it('says NOTHING on an npm copy whose cache holds the tap’s number', async () => {
    // THE ISSUE'S HARMFUL DIRECTION, whole. The brew copy resolved 0.27.0 from the tap and
    // wrote it to the shared file; the npm copy is at 0.25.4 and reads the same file inside
    // its weekly window. Before the stamp it printed `New version available: 0.27.0 (run npm
    // i -g @lucasfe/ralph to update)` — a nag naming a channel that serves 0.23.0.
    //
    // Asserted as SILENCE and then as the absence of each half of that line separately, so a
    // regression that keeps the number but drops the command (or the reverse) still fails.
    const r = run({
      layout: 'npm',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
    })
    const verdict = await r.verdict
    expect(r.stdout.output()).toBe('')
    expect(r.stdout.output()).not.toContain('0.27.0')
    expect(r.stdout.output()).not.toContain(NPM_NOTICE)
    expect(verdict).toEqual({
      isNewer: false,
      latestVersion: null,
      prompted: false,
      accepted: false,
      installed: false,
      installedVersion: null,
    })
  })

  it('prints the tap’s number to the BREW copy, with brew’s command', async () => {
    // The mirror, and the reason the fix cannot just be "never serve a cached version": the
    // copy the number belongs to must still be told. Same file, same window, same clock.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
    })
    const verdict = await r.verdict
    expect(noticeOf(r.stdout)).toBe(`New version available: 0.27.0 (run ${BREW_NOTICE} to update)`)
    expect(r.stdout.output()).not.toContain('npm')
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.27.0' })
  })

  it('prints npm’s number to the NPM copy, with npm’s command', async () => {
    // The control in the other direction — #24's line, unchanged for the layout it describes.
    const r = run({
      layout: 'npm',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'npm' }),
    })
    await r.verdict
    expect(noticeOf(r.stdout)).toBe(`New version available: 0.27.0 (run ${NPM_NOTICE} to update)`)
    expect(r.stdout.output()).not.toContain('brew')
  })

  it('says nothing on a BREW copy whose cache holds npm’s number — criterion 3’s direction', async () => {
    // The originally observed direction: `ralph doctor` on a brew copy printing `cached
    // 0.23.0`, a number only npm's channel could produce. The notice is the same read, so
    // the same rule has to hold here.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.30.0', latest_version_channel: 'npm' }),
    })
    expect((await r.verdict).isNewer).toBe(false)
    expect(r.stdout.output()).toBe('')
  })

  it('says nothing to either copy for a THIRD channel’s number', async () => {
    // A future publisher, or a renamed id, from an older copy's point of view. Neither copy
    // may read it, and neither may treat an unknown id as a wildcard.
    for (const layout of ['npm', 'brew']) {
      const r = run({
        layout,
        cache: throttledCache({ latest_version: '0.30.0', latest_version_channel: 'cellar' }),
      })
      await r.verdict
      expect(r.stdout.output(), layout).toBe('')
    }
  })

  it('says nothing to either copy for a LEGACY unstamped number', async () => {
    // Criterion 2, as output. The observed file had npm's number in a bare field, but a
    // 0.26.0 brew copy wrote the TAP's number into the same field, so whichever copy adopts
    // it is the copy that gets the harmful nag. Neither does.
    const legacy = JSON.stringify({
      last_check_at: new Date(T0 - DAY).toISOString(),
      last_prompted_at: null,
      latest_version: '0.30.0',
    })
    for (const layout of ['npm', 'brew']) {
      const r = run({ layout, cache: legacy })
      const verdict = await r.verdict
      expect(r.stdout.output(), layout).toBe('')
      expect(verdict.latestVersion, layout).toBeNull()
    }
  })

  it('leaves the cache untouched on every throttled run, whoever read it', async () => {
    // A read must not become a write. If a throttled run re-wrote the file it could re-stamp
    // the pair under the reader's own channel, which is the bug with an extra step.
    const cache = throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' })
    for (const layout of ['npm', 'brew']) {
      const r = run({ layout, cache })
      await r.verdict
      expect(r.cacheFs.readFileSync(CACHE_PATH, 'utf8').toString(), layout).toBe(cache)
    }
  })
})

describe('QA #215 what the moved resolution must NOT cost a throttled run', () => {
  it('spawns nothing at all, and classifies exactly once with no spawner', async () => {
    // #200's guarantee, which #215 put at risk by resolving the channel on a path that used
    // to skip it: the common run costs a path match and nothing else. Both halves measured —
    // zero `exec` calls through the gate, and one classification whose bag withholds `exec`,
    // so `classifyInstall` cannot reach `npm root -g` either.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
    })
    await r.verdict
    expect(r.exec.calls).toEqual([])
    expect(r.classify.calls).toHaveLength(1)
    expect(r.classify.calls[0]).toEqual({ exec: null })
  })

  it('classifies once even though two consumers ask — the memo, not a second path match', async () => {
    // The notice command and the version query are two independent reads of one
    // classification (lib/update-gate.js:164 and :187). A notice run exercises BOTH, so this
    // is where a memo that only counted calls rather than sharing the promise would show up.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
    })
    await r.verdict
    expect(noticeOf(r.stdout)).toContain(BREW_NOTICE)
    expect(r.classify.calls).toHaveLength(1)
  })

  it('classifies once on a run with nothing to report, and prints nothing', async () => {
    // The cheapest possible run: throttled, foreign number, no notice. Still at most one
    // classification — a second one would be a second path match per `ralph start`.
    const r = run({
      layout: 'npm',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
    })
    await r.verdict
    expect(r.classify.calls).toHaveLength(1)
    expect(r.stdout.output()).toBe('')
  })

  it('classifies NOT AT ALL on an opted-out run', async () => {
    // RALPH_NO_UPDATE_CHECK returns before the channel is resolved, so the opt-out still
    // costs nothing whatsoever — no classification, no cache read, no output.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
      processEnv: { RALPH_NO_UPDATE_CHECK: '1' },
    })
    await r.verdict
    expect(r.classify.calls).toEqual([])
    expect(r.stdout.output()).toBe('')
  })

  it('does not lose the run when the classification never answers — CHARACTERIZATION', async () => {
    // A NEW LIVENESS EXPOSURE, measured rather than judged: before #215 the throttled path
    // never awaited the classification thunk, so a `classify` that hangs could only delay a
    // run that was going to query the network anyway. Now every run awaits it, so a hung
    // classification hangs `ralph start` itself — there is no timeout anywhere between the
    // gate and the classification.
    //
    // Deterministic despite the timer: the gate CANNOT resolve before `release()` is called,
    // because the throttled path awaits this promise. The 150 ms only bounds how long the
    // test waits before recording "still pending". The hang is released at the end so no
    // dangling promise outlives the test.
    let release
    const hang = new Promise((r) => {
      release = r
    })
    const classify = async () => {
      await hang
      return null
    }
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
      classify,
    })
    let timer
    const pending = await Promise.race([
      r.verdict.then(() => 'resolved'),
      new Promise((res) => {
        timer = setTimeout(() => res('pending'), 150)
      }),
    ])
    clearTimeout(timer)
    expect(pending).toBe('pending')
    release()
    // And once it does answer, the run completes with a verdict rather than a throw.
    await expect(r.verdict).resolves.toMatchObject({ isNewer: false })
  })
})

describe('QA #215 a copy that could not identify itself must not be nagged', () => {
  it('prints nothing when the classification THROWS', async () => {
    // The gate memoizes null for a `classify` that threw (lib/update-gate.js:126-134) and
    // documents that as "no layout to speak of ... no command in the notice and npm for the
    // query". Npm-for-the-QUERY is #200's rule and is fine — a query has to go somewhere.
    // The first cut of #215 made the same fallback decide WHOSE CACHED NUMBER MAY BE READ,
    // where it is a guess about the reader rather than a record of a query: this copy is a
    // Homebrew install whose classification failed, and the number it was handed was npm's.
    // `cachedVersionFor`'s rule 3 refuses exactly that read one call later
    // (lib/version-cache.js:180-185: "A caller that cannot say which channel it came from
    // has not earned another channel's number. Deliberately not 'npm by default'"), so the
    // two halves of the fix disagreed about the same input.
    //
    // Fixed by splitting the one function in two (lib/update-check.js:443-449): the query
    // still falls back to npm, the READ fails closed. This is the fence — a `classify` that
    // throws must cost the run its notice, not lend it another channel's number.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.30.0', latest_version_channel: 'npm' }),
      classify: async () => {
        throw new Error('classification blew up')
      },
    })
    await r.verdict
    expect(r.stdout.output()).toBe('')
  })

  it('does not advertise npm’s number with brew’s command', async () => {
    // THE SHARPEST SHAPE, and the reason the case above is not merely cosmetic. A
    // classification that names its notice command but carries no usable query — `latest`
    // absent, or a `latest` with no runnable argv — puts the gate's two reads on different
    // channels: the NOTICE COMMAND comes from the classification (brew's), while the VERSION
    // came, before the fix, from the npm fallback (npm's cached number). The line printed was
    // `New version available: 0.30.0 (run brew upgrade ralph to update)` — npm's number
    // advertised with brew's command, criterion 1 violated in the most misleading way
    // available, since `brew upgrade ralph` cannot fetch a version only npm has.
    //
    // Reachability, measured rather than assumed: today's `classifyInstall` attaches `latest`
    // to every return (`runnable`, `refusal` and `unknown` all set it), so this shape does
    // not arrive from the shipped classifier — it arrives through the `classify` SEAM, which
    // lib/update-gate.js declares precisely because a classification is a value it did not
    // build, and from any future row or kind that omits the query. Nothing in the GATE keeps
    // the two reads on one channel even now; what closes it is the decision refusing to serve
    // a number to a source it could not resolve, so this test is that refusal's fence at the
    // one place a user would have seen it.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.30.0', latest_version_channel: 'npm' }),
      classifyOptions: {
        result: {
          kind: 'global-brew',
          argv: ['brew', 'upgrade', 'ralph'],
          label: BREW_NOTICE,
          reason: 'a Cellar path',
          advice: null,
          noticeLabel: BREW_NOTICE,
        },
      },
    })
    const verdict = await r.verdict
    expect(r.stdout.output()).not.toContain('0.30.0')
    expect(verdict.isNewer).toBe(false)
  })

  it('DOES still ask npm, and report npm’s answer, on an OPEN window — characterized', async () => {
    // THE LIMIT OF THE FAIL-CLOSED RULE, measured so it is on the record rather than assumed
    // closed. `readingChannelOf` governs CACHE reads. The network path is #200's rule and is
    // untouched: a run whose source could not be resolved still spawns `npm view`
    // (`fetchLatestVersion` substitutes NPM_VERSION_QUERY), and `fetched` is reported as-is
    // (lib/update-check.js:369-376). So a Homebrew copy whose classification THREW, inside an
    // open window, prints a number the npm registry produced.
    //
    // Not filed as a defect, on three measured grounds: the run really did ask npm, so the
    // number is current rather than a guess about a past run; the notice carries NO command,
    // because the same failed classification that lost the channel lost the label too, so the
    // user is never told to run something that cannot fetch it; and `ralph doctor`, which
    // criterion 3 names, cannot reach this path at all — it reads the cache through
    // `versionChannelFor` and never queries. What WOULD be a defect is this number surviving
    // into the file as npm's and then being read back by the brew copy, and it does not: the
    // stamp says npm, and the brew copy's next throttled run reads nothing.
    const exec = async (cmd, args = []) => ({
      exitCode: 0,
      stdout: args.includes('view') ? '0.30.0' : '',
      stderr: '',
    })
    const r = run({
      layout: 'brew',
      cache: throttledCache({ last_check_at: null }),
      exec,
      classify: async () => {
        throw new Error('classification blew up')
      },
    })
    const verdict = await r.verdict
    expect(noticeOf(r.stdout)).toBe('New version available: 0.30.0')
    expect(r.stdout.output()).not.toContain('run ')
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: '0.30.0' })
    // Filed under npm, and therefore unreadable by the copy that could not name itself...
    expect(r.fileNow()).toMatchObject({ latest_version: '0.30.0', latest_version_channel: 'npm' })
    // ...which the next run, now inside the window, shows as silence.
    const next = run({
      layout: 'brew',
      cache: JSON.stringify({ ...r.fileNow(), last_check_at: new Date(T0 - DAY).toISOString() }),
      classify: async () => {
        throw new Error('classification blew up')
      },
    })
    await next.verdict
    expect(next.stdout.output()).toBe('')
  })

  it('DOES stay silent when the classification names a channel it cannot spell — the contrast', async () => {
    // A classification whose `latest` is runnable but carries no channel id fails CLOSED, so
    // the gate is not uniformly fail-open: the two cases above are specific to a source that
    // could not be resolved at all, which is strictly less information than this one.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.30.0', latest_version_channel: 'npm' }),
      classifyOptions: {
        result: {
          kind: 'global-brew',
          argv: ['brew', 'upgrade', 'ralph'],
          label: BREW_NOTICE,
          reason: 'a Cellar path',
          advice: null,
          noticeLabel: BREW_NOTICE,
          latest: { argv: ['brew', 'info', '--json=v2', 'ralph'], format: 'brew-json-v2' },
        },
      },
    })
    await r.verdict
    expect(r.stdout.output()).toBe('')
  })
})

describe('QA #215 the gate never lets the decision fall back to its npm default', () => {
  // The fix for the fail-open moved "nobody asked" out of `source === undefined` and into
  // `resolveUpdateDecision`'s parameter default (`latestSource = NPM_VERSION_QUERY`,
  // lib/update-check.js:251), which is what kept 54 pre-#215 specs green. That default names
  // npm — the same answer the defect turned on — so the whole safety of the split rests on
  // production never reaching it, and this gate is production's only caller.
  //
  // lib/update-check.cache-channel.qa.test.js sweeps the package for that statically. Here it
  // is measured: an `update` spy over every path the gate can take, asserting the argument was
  // PRESENT, was a function, and resolved to something the decision can attribute.
  const spyUpdate = () => {
    const bags = []
    const update = async (bag) => {
      bags.push(bag)
      return { latestVersion: null, isNewer: false, shouldPrompt: false, source: 'cache' }
    }
    update.bags = bags
    return update
  }

  const PATHS = {
    'a throttled run': {},
    'a run with the window open': { cache: throttledCache({ last_check_at: null }) },
    'a run with no cache file at all': { cache: null },
    'an opted-out run': { processEnv: { RALPH_NO_UPDATE_CHECK: '1' } },
    'a run whose classification throws': {
      classify: async () => {
        throw new Error('boom')
      },
    },
    'a run whose classification answers null': { classifyOptions: { result: null } },
    'a run with a hostile home': { home: 42 },
  }

  it('passes a `latestSource` on every path it can take', async () => {
    for (const [label, over] of Object.entries(PATHS)) {
      const update = spyUpdate()
      const r = run({ layout: 'brew', update, ...over })
      await r.verdict
      // Exactly one decision per run, and `latestSource` present on it. `in` rather than a
      // truthiness check because the trap is OMISSION: an absent key and an explicit
      // `undefined` both take the default, and only the KEY's presence rules the first out.
      expect(update.bags.length, label).toBe(1)
      expect('latestSource' in update.bags[0], label).toBe(true)
      expect(typeof update.bags[0].latestSource, label).toBe('function')
    }
  })

  it('passes a thunk that resolves to a channel-bearing descriptor for a real layout', async () => {
    // And the value is not merely present but usable: on a Homebrew layout the thunk resolves
    // to the tap's query WITH its channel id, which is what makes the read attributable rather
    // than merely un-defaulted. Resolved here the way the decision resolves it.
    const update = spyUpdate()
    const r = run({ layout: 'brew', update })
    await r.verdict
    await expect(update.bags[0].latestSource()).resolves.toMatchObject({
      channel: 'brew',
      argv: ['brew', 'info', '--json=v2', 'ralph'],
    })
    const npm = spyUpdate()
    const r2 = run({ layout: 'npm', update: npm })
    await r2.verdict
    await expect(npm.bags[0].latestSource()).resolves.toMatchObject({ channel: 'npm' })
  })

  it('resolves that thunk to undefined — never to npm’s query — when the layout is unknown', async () => {
    // The other half: when the classification fails the thunk answers `undefined`, which is
    // the input the split now fails closed on. Pinned HERE so the two ends of the contract are
    // measured against each other — the gate promises to send `undefined` rather than a guess,
    // and lib/update-check.js promises to read nothing when it arrives.
    const update = spyUpdate()
    const r = run({
      layout: 'brew',
      update,
      classify: async () => {
        throw new Error('boom')
      },
    })
    await r.verdict
    await expect(update.bags[0].latestSource()).resolves.toBeUndefined()
  })
})

describe('QA #215 the prompt path carries the attribution through', () => {
  it('stamps the prompt window without re-attributing the pair', async () => {
    // A TTY run on the copy the number belongs to: the question is asked, the window is
    // stamped by the real `recordPromptShown`, and the version/channel pair on disk is the
    // one that was there. A stamp that laundered attribution would hand the OTHER copy a
    // number it may not read, on a run that only showed a prompt.
    const r = run({
      layout: 'brew',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
      isTTY: true,
      stdin: { isTTY: true },
      ask: async () => false,
    })
    const verdict = await r.verdict
    expect(verdict).toMatchObject({ isNewer: true, prompted: true, accepted: false })
    expect(r.fileNow()).toEqual({
      last_check_at: new Date(T0 - DAY).toISOString(),
      last_prompted_at: new Date(T0).toISOString(),
      latest_version: '0.27.0',
      latest_version_channel: 'brew',
    })
    // And the copy that may not read it still may not, after the stamp.
    const other = run({ layout: 'npm', cache: r.cacheFs.readFileSync(CACHE_PATH, 'utf8').toString() })
    await other.verdict
    expect(other.stdout.output()).toBe('')
  })

  it('never asks the copy that may not read the number', async () => {
    // The prompt window is global and the question is a scarce resource: a copy with nothing
    // to offer must not spend the machine's one weekly question on a version it cannot
    // install. Measured through `ask` being uncalled AND the stamp not landing.
    let asked = 0
    const r = run({
      layout: 'npm',
      cache: throttledCache({ latest_version: '0.27.0', latest_version_channel: 'brew' }),
      isTTY: true,
      stdin: { isTTY: true },
      ask: async () => {
        asked += 1
        return true
      },
    })
    const verdict = await r.verdict
    expect(asked).toBe(0)
    expect(verdict.prompted).toBe(false)
    expect(r.fileNow().last_prompted_at).toBeNull()
  })
})
